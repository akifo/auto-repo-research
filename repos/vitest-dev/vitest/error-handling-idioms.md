# error-handling-idioms

> リポジトリ: vitest-dev/vitest
> 分析日: 2026-03-06

## 概要

テストランナーにおけるエラーフォーマット・スタックトレース加工・差分表示の設計イディオムを分析する。vitest はエラーの「発生 → シリアライズ → 差分生成 → スタックトレース加工 → 最終表示」を明確なパイプラインとして分離し、各段階に多重フォールバックを設けることで、どんな入力でもクラッシュせず有用な情報を出力する設計を実現している。特に、Worker プロセス間通信を前提としたエラーシリアライズ戦略と、多段フォールバックによる堅牢な pretty-print が注目に値する。

## 背景にある原則

- **段階的劣化（Graceful Degradation）**: エラー表示のあらゆる段階で「本来の方法が失敗しても、劣化した形で情報を出力する」設計を徹底している。`stringify` は `prettyFormat` が失敗すると `callToJSON: false` で再試行し、さらに出力が巨大なら `maxDepth` を半減して再帰する（`packages/utils/src/display.ts:73-96`）。`processError` の最外層でも `serializeValue` の失敗をキャッチし、元のメッセージを含む代替 Error を生成する（`packages/utils/src/error.ts:48-57`）。根拠: テストフレームワークはユーザーの任意のオブジェクトを扱うため、表示処理自体が例外を投げてはならない。

- **境界でのデータ正規化**: エラーオブジェクトをプロセス間（Worker → main）で転送する際、`serializeValue` で plain object に変換する。Error インスタンスは `MessagePort` の構造化複製で問題を起こすため、`Object.create(null)` で再構築し、プロトタイプチェーンを走査して全プロパティをコピーする（`packages/utils/src/serialize.ts:100-126`）。さらにエラーメッセージからビルドツール由来のノイズ（`__vite_ssr_import_\d+__` 等）を除去する。根拠: 構造化複製アルゴリズムの制約を回避しつつ、情報を最大限保持するため。

- **関心の分離による拡張性**: エラー処理を「加工（processError）」「シリアライズ（serializeValue）」「差分生成（diff）」「表示（printError）」に分離し、各レイヤーが独立してテスト・拡張可能。Reporter は `capturePrintError` を介して出力文字列を取得し、GitHub Actions 形式など独自フォーマットに変換できる（`packages/vitest/src/node/reporters/github-actions.ts:161`）。

- **ユーザー指向のエラーメッセージ**: 技術的なスタックトレースだけでなく、「何が起きて、どう直せばよいか」を示す。ESM/CJS 互換性エラーでは問題のパッケージ名を特定し、`vitest.config.js` の修正例をそのまま貼れる形で提示する（`packages/vitest/src/node/printError.ts:336-366`）。

## 実例と分析

### エラーシリアライズの多層防御

`serializeValue` は再帰的にオブジェクトを走査し、各プロパティの変換に `try/catch` を入れている。一つのプロパティが変換不能でも `<unserializable>` マーカーを入れて続行する:

```typescript
// packages/utils/src/serialize.ts:110-118
Object.getOwnPropertyNames(obj).forEach((key) => {
  if (key in clone) {
    return
  }
  try {
    clone[key] = serializeValue(val[key], seen)
  }
  catch (err) {
    // delete in case it has a setter from prototype that might throw
    delete clone[key]
    clone[key] = getUnserializableMessage(err)
  }
})
```

さらに `processError` の最外層でも `serializeValue` の失敗をキャッチし、元のエラーメッセージを含む新しい Error で代替する:

```typescript
// packages/utils/src/error.ts:48-57
try {
  return serializeValue(err)
}
catch (e: any) {
  return serializeValue(
    new Error(
      `Failed to fully serialize error: ${e?.message}\nInner error message: ${err?.message}`,
    ),
  )
}
```

循環参照への対応として `WeakMap` / `WeakSet` による visited 管理を徹底している。`serializeValue` は `WeakMap<WeakKey, any>` でクローン済みオブジェクトを追跡し、`processError` は `WeakSet<WeakKey>` で `error.cause` チェーンの循環を防止する。

### エラー正規化パイプライン

`printErrorInner` を中核に、以下の順序で処理する:

1. **プリミティブ救済**: 文字列や数値が throw された場合を `{ message, stack }` に正規化
2. **null/undefined 救済**: フォールバック Error を生成
3. **プロジェクト未解決チェック**: 設定がなくてもメッセージだけは出力
4. **スタックトレース解析**: 環境（Node.js / ブラウザ）に応じて異なるパーサーを適用
5. **最近傍フレーム特定**: Vite のモジュールグラフを参照し、ユーザーコードに最も近いフレームを特定
6. **コードフレーム生成**: 該当行の前後を構文ハイライト付きで表示
7. **差分表示**: `error.diff` がある場合はそのまま出力
8. **因果チェーン走査**: `error.cause` を再帰的に `printErrorInner` で処理
9. **ESM エラー検知**: 既知の ESM/CJS 問題を検出し、具体的な修正手順を提示

### 差分表示の段階的フォールバック

差分比較は複数段階のフォールバックを持つ。`processError` がアサーションエラーの `actual` / `expected` から差分文字列を事前計算し、表示時はその文字列を出力するだけという分離が鍵となる:

```typescript
// packages/utils/src/error.ts:19-29
if (
  err.showDiff
  || (err.showDiff === undefined
    && err.expected !== undefined
    && err.actual !== undefined)
) {
  err.diff = printDiffOrStringify(err.actual, err.expected, {
    ...diffOptions,
    ...err.diffOptions as DiffOptions,
  })
}
```

`compareObjects` 内では、(1) `toJSON` 有効 + 深い比較（`maxDepth: 20`）を試み、(2) 失敗または差分なしなら `toJSON` 無効 + 浅い比較（`callToJSON: false, maxDepth: 8`）にフォールバックする:

```typescript
// packages/utils/src/diff/index.ts:161-189
function compareObjects(a, b, options?) {
  let difference
  let hasThrown = false
  try {
    const formatOptions = getFormatOptions(FORMAT_OPTIONS, options)
    difference = getObjectsDifference(a, b, formatOptions, options)
  }
  catch {
    hasThrown = true
  }
  const noDiffMessage = getCommonMessage(NO_DIFF_MESSAGE, options)
  if (difference === undefined || difference === noDiffMessage) {
    const formatOptions = getFormatOptions(FALLBACK_FORMAT_OPTIONS, options)
    difference = getObjectsDifference(a, b, formatOptions, options)
    if (difference !== noDiffMessage && !hasThrown) {
      difference = `${getCommonMessage(SIMILAR_MESSAGE, options)}\n\n${difference}`
    }
  }
  return difference
}
```

文字列比較では、単一行は文字レベルの差分（変更部分を `inverse` 色で強調）、複数行は行レベルの unified diff を使い分ける。非対称マッチャー（`expect.objectContaining` 等）は差分計算前にマッチ済みプロパティを実値で置換し、不一致部分だけを差分に残す。

### スタックトレースのクロスブラウザ対応

`parseStacktrace` は V8（Chrome/Node.js）と Firefox/Safari のスタックトレース形式を自動判別する。正規表現 `CHROME_IE_STACK_REGEXP` でフォーマットを検出し、適切なパーサーを選択する:

```typescript
// packages/utils/src/source-map.ts:230-233
let stacks = !CHROME_IE_STACK_REGEXP.test(stack)
  ? parseFFOrSafariStackTrace(stack)
  : parseV8Stacktrace(stack)
```

パース後、ソースマップがあれば `originalPositionFor` で元の位置に変換し、vitest 内部フレームを `stackIgnorePatterns` でフィルタリングする。`__VITEST_HELPER__` という特殊メソッド名でアサーションヘルパーの内部フレームを検出し、その下のフレームのみ返すことでユーザーコードを最上位に押し上げる:

```typescript
// packages/utils/src/source-map.ts:236-239
const helperIndex = stacks.findLastIndex(
  s => s.method === '__VITEST_HELPER__' || s.method === 'async*__VITEST_HELPER__'
)
if (helperIndex >= 0) {
  stacks = stacks.slice(helperIndex + 1)
}
```

ブラウザテスト環境では別途 `project.browser.parseErrorStacktrace` が呼ばれ、URL パスのクリーンアップ（`/@fs/` プレフィックス除去、クエリパラメータ除去等）を行う。

### エラークラスの2つの設計パターン

vitest は用途に応じて2種類のエラークラス設計を使い分けている:

**code プロパティによる識別**（Node.js 慣習に沿ったスタイル。CLI レイヤーのユーザー向けエラー）:

```typescript
// packages/vitest/src/node/errors.ts:1-7
export class FilesNotFoundError extends Error {
  code = 'VITEST_FILES_NOT_FOUND'
  constructor(mode: 'test' | 'benchmark') {
    super(`No ${mode} files found`)
  }
}
```

**name プロパティによる識別**（テスト実行時の内部エラー。ランナーレイヤー）:

```typescript
// packages/runner/src/errors.ts:23-25
export class FixtureDependencyError extends Error {
  public name = 'FixtureDependencyError'
}
```

`code` スタイルは `VITEST_` プレフィックスで名前空間を確保し、シリアライズ境界を越えても判別可能。`name` スタイルはエラー出力に自動で反映される。

### 巨大入力への多段防御

エラー表示パイプラインの随所に入力サイズの上限が設けられている:

| 箇所 | 閾値 | 対応 |
|---|---|---|
| エラーメッセージの色付け | 5,000 文字 | 色付け範囲をエラー名のみに限定 |
| インライン文字列差分 | 20,000 文字 | 文字列比較をスキップしオブジェクト比較へ |
| prettyFormat 出力の截断 | 100,000 文字 | `...` で截断 |
| stringify の再帰圧縮 | 10,000 文字 | `maxDepth` を半減して再帰 |
| コードフレーム行長 | 200 文字 | ミニファイと判定しフレーム生成中止 |

```typescript
// packages/utils/src/display.ts:93-96
return result.length >= MAX_LENGTH && maxDepth > 1
  ? stringify(object, Math.floor(Math.min(maxDepth, Number.MAX_SAFE_INTEGER) / 2), { maxLength, filterNode, ...options })
  : result
```

### 出力キャプチャによるレポーター統合

`capturePrintError` は `Writable` ストリームで出力をキャプチャし、構造化データとして返す。これにより、コンソール出力のロジックを再利用しつつ、GitHub Actions などのフォーマットに変換可能にしている:

```typescript
// packages/vitest/src/node/printError.ts:40-62
export function capturePrintError(error, ctx, options) {
  let output = ''
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      output += String(chunk)
      callback()
    },
  })
  const console = new Console(writable)
  const logger = { error: console.error.bind(console), highlight: ctx.logger.highlight.bind(ctx.logger) }
  const result = printError(error, ctx, logger, { showCodeFrame: false, ...options })
  return { nearest: result?.nearest, output }
}
```

GitHub Actions レポーターはキャプチャした出力から `stripVTControlCharacters` で ANSI コードを除去し、`::error file=...,line=...,column=...::` 形式のワークフローコマンドに変換する。

## コード例

```typescript
// packages/utils/src/serialize.ts:121-125
// Error インスタンスの message を正規化（ビルドツール由来のノイズを除去）
if (val instanceof Error) {
  safe(() => clone.message = normalizeErrorMessage(val.message))
}
```

```typescript
// packages/vitest/src/node/printError.ts:244-251
// error.cause の再帰的表示（Chain of Responsibility 的アプローチ）
if (typeof e.cause === 'object' && e.cause && 'name' in e.cause) {
  (e.cause as any).name = `Caused by: ${(e.cause as any).name}`
  printErrorInner(e.cause, project, {
    showCodeFrame: false,
    logger: options.logger,
    parseErrorStacktrace: options.parseErrorStacktrace,
  })
}
```

```typescript
// packages/vitest/src/node/printError.ts:400-414
// スタックフレームの色分け表示（最近傍フレームをハイライト）
for (const frame of stack) {
  const color = frame === highlight ? c.cyan : c.gray
  const path = relative(project.config.root, frame.file)
  logger.error(
    color(
      ` ${c.dim(F_POINTER)} ${[
        frame.method,
        `${path}:${c.dim(`${frame.line}:${frame.column}`)}`,
      ].filter(Boolean).join(' ')}`,
    ),
  )
  onStack?.(frame)
}
```

```typescript
// packages/utils/src/diff/index.ts:247-283
// 非対称マッチャー対応の差分計算: マッチ済みプロパティは実値で置換
if (isAsymmetricMatcher(expectedValue)) {
  if (expectedValue.asymmetricMatch(actualValue)) {
    expected[key] = actualValue  // マッチ → 差分に出さない
  }
}
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: Node.js とブラウザでスタックトレースのパース方法が異なる
  - 適用条件: 同一インターフェースで複数の実装を切り替える必要がある場合
  - コード例: `printError.ts:79-106` — `parseErrorStacktrace` を関数として注入
  - 注意点: 関数注入による簡易 Strategy で十分な場合、クラスベースの Strategy は過剰設計

- **Decorator パターン** (分類: 構造)
  - 解決する問題: 既存の出力ロジックを変更せずに出力先を差し替えたい
  - 適用条件: 同じ処理を異なる出力先（ターミナル、文字列バッファ、ファイル等）に適用する場合
  - コード例: `printError.ts:40-62` — `capturePrintError` が Writable + Console で Logger を差し替え
  - 注意点: Node.js の `Console` コンストラクタを活用し、独自 Logger 実装を最小限に抑えている

- **Chain of Responsibility パターン** (分類: 振る舞い)
  - 解決する問題: `error.cause` チェーンの再帰的表示と、エラー出力の各セクション（メッセージ、差分、コードフレーム、スタック）の順序付き処理
  - 適用条件: エラーに因果関係がある場合、または出力の各部分が独立して存在する/しない場合
  - コード例: `printError.ts:244-251`
  - 注意点: 循環参照を `WeakSet` で防止する必要がある（`processError` で実装済み）

- **Plugin パターン** (分類: 構造)
  - 解決する問題: pretty-format における型ごとの表示ロジックの拡張
  - 適用条件: 新しいデータ型（Error、React コンポーネント、DOM 等）の表示をサポートする場合
  - コード例: `packages/pretty-format/src/index.ts:285-312` — ErrorPlugin が `test` + `serialize` で Error の構造化表示を定義
  - 注意点: `test` は全オブジェクトに対して呼ばれるため軽量に保つ。プラグインの登録順が優先度を決める

## Good Patterns

- **防御的正規化を入り口で一括実行**: エラー処理関数の冒頭で `isPrimitive` チェックと null チェックを行い、以降の全処理が `TestError` 型を前提にできる。型アサーション（`as any`）は正規化の入り口のみに限定し、後続処理では型安全を維持する

```typescript
// packages/vitest/src/node/printError.ts:118-131
if (isPrimitive(e)) {
  e = { message: String(error).split(/\n/g)[0], stack: String(error) } as any
}
if (!e) {
  const error = new Error('unknown error')
  e = { message: e ?? error.message, stack: error.stack } as any
}
```

- **Unserializable マーカーパターン**: シリアライズ不能なプロパティを `<unserializable>: ${message}` に置換して処理を続行する。個々のプロパティレベルで `try/catch` するため、一部が壊れても他の情報は保持される

```typescript
// packages/utils/src/serialize.ts:15-23
function getUnserializableMessage(err: unknown) {
  if (err instanceof Error) {
    return `<unserializable>: ${err.message}`
  }
  if (typeof err === 'string') {
    return `<unserializable>: ${err}`
  }
  return '<unserializable>'
}
```

- **Skip Properties Set パターン**: エラーオブジェクトの表示時、既知の内部プロパティとブラウザ固有プロパティを `Set` で管理し、二重表示を防止する。`Error.prototype` と `Object.prototype` のプロパティ名を動的に取得して除外リストに含めることで、ランタイム環境の差異にも対応する

```typescript
// packages/vitest/src/node/printError.ts:262-288
const skipErrorProperties = new Set([
  'cause', 'stacks', 'type', 'showDiff', 'ok', 'operator',
  'diff', 'codeFrame', 'actual', 'expected', 'diffOptions',
  // webkit props
  'sourceURL', 'column', 'line',
  // firefox props
  'fileName', 'lineNumber', 'columnNumber',
  ...Object.getOwnPropertyNames(Error.prototype),
  ...Object.getOwnPropertyNames(Object.prototype),
])
```

- **Actionable Error Message パターン**: ESM/CJS 互換性エラーを検出したら、問題パッケージを特定し、(1) 何が問題か、(2) 根本的解決策（パッケージ作者への Issue）、(3) 一時的ワークアラウンド（コピペ可能な設定コード付き）を提示する

```typescript
// packages/vitest/src/node/printError.ts:336-366
function printModuleWarningForPackage(logger, path, name) {
  logger.error(c.yellow(
    `Module ${path} seems to be an ES Module but shipped in a CommonJS package. `
    + `You might want to create an issue to the package ${c.bold(`"${name}"`)} ...`
    + '\n\nAs a temporary workaround you can try to inline the package ...'
    + c.green(`export default {\n  test: {\n    server: {\n      deps: {\n        inline: [
          ${c.yellow(c.bold(`"${name}"`))}...`)
  ))
}
```

## Anti-Patterns / 注意点

- **エラーの握りつぶし（Silent Swallow）**: `processError` 内で `err.cause` の再代入を `try/catch` で囲み空の `catch` を使っている（`error.ts:46`）。テスト表示系のようにクラッシュ回避が最優先のレイヤーでは許容されるが、ビジネスロジックでは原因不明のバグを生む

```typescript
// Bad: 任意の場所で catch を空にする
try { riskyOperation() } catch {}

// Better: 表示・シリアライズ系に限定し、フォールバック値を提供する
try { clone[key] = serializeValue(val[key], seen) }
catch (err) { clone[key] = getUnserializableMessage(err) }
```

- **カラーライブラリに巨大文字列を渡す**: ANSI エスケープシーケンスの生成でハングに近い遅延が発生しうる。vitest は 5000 文字の閾値で色付け範囲を制限している

```typescript
// Bad: 巨大メッセージ全体に色を適用
logger.error(c.red(`${c.bold(errorName)}: ${error.message}`))

// Better: 閾値を超えたら名前部分のみ色付け
if (error.message.length > 5000) {
  logger.error(`${c.red(c.bold(errorName))}: ${error.message}`)
}
```

- **error.cause を無視する**: JavaScript の Error Cause チェーン（ES2022）を走査しないと、根本原因がユーザーに伝わらない

```typescript
// Bad: cause を無視して直接のエラーだけ表示
printErrorMessage(e, logger)

// Better: cause チェーンを再帰走査
if (typeof e.cause === 'object' && e.cause && 'name' in e.cause) {
  (e.cause as any).name = `Caused by: ${(e.cause as any).name}`
  printErrorInner(e.cause, project, { ... })
}
```

## 導出ルール

- `[MUST]` エラー表示パイプラインでは各変換段階にフォールバックを設ける — シリアライズ失敗時のマーカー置換、pretty-print 失敗時の `callToJSON: false` リトライ、stringify の `maxDepth` 半減リトライなど、一段階の失敗が全体を止めないようにする
  - 根拠: vitest は `serializeValue` でプロパティ単位の `try/catch`、`stringify` で `maxDepth` 半減リトライ、`compareObjects` で `callToJSON` 無効化リトライを実装し、三重のフォールバックを持つ

- `[MUST]` エラー処理関数の入り口で非 Error オブジェクト（文字列、null、undefined）を統一フォーマットに正規化する — 正規化レイヤーの後は全処理が `{ message, stack }` を前提にできる
  - 根拠: `printErrorInner` は `isPrimitive` + null チェックで全入力を正規化し、後続処理の型安全を保証している（`printError.ts:118-131`）

- `[MUST]` プロセス間でエラーを転送する際は plain object にシリアライズする — Error インスタンスは構造化複製で問題を起こし、プロトタイプチェーンの情報が失われる
  - 根拠: `serializeValue` は Error を `Object.create(null)` で再構築し、プロトタイプチェーンを走査して全プロパティをコピーする（`serialize.ts:100-126`）

- `[SHOULD]` エラーメッセージからビルドツール固有のノイズ（変数名の難読化、内部パスなど）を除去してからユーザーに表示する
  - 根拠: `normalizeErrorMessage` は `__vite_ssr_import_\d+__` などの Vite 内部変数名をクリーンアップする（`serialize.ts:138-146`）

- `[SHOULD]` 差分表示・stringify に出力サイズ上限を設け、巨大オブジェクトがターミナルや RPC 通信をフリーズさせないようにする
  - 根拠: vitest は `MAX_DIFF_STRING_LENGTH`（20,000字）、prettyFormat 截断（100,000字）、stringify の再帰圧縮（10,000字）など多段の上限を設定している

- `[SHOULD]` エラーメッセージには「何が起きたか」「どう直すか」「一時的なワークアラウンド」の3層を含め、コピペ可能なコード例を添える
  - 根拠: ESM/CJS エラー検出時の `printModuleWarningForPackage` が設定コード付きの解決策を提示し、開発者のアクションまでの距離を最小化している（`printError.ts:336-365`）

- `[SHOULD]` スタックトレースは全フレーム表示ではなく、ユーザーコードに最も近いフレームをハイライトし、内部フレーム（node_modules、ランタイム内部、アサーションヘルパー）をフィルタリングする
  - 根拠: vitest は `defaultStackIgnorePatterns` + `__VITEST_HELPER__` 検出 + Vite モジュールグラフで最近傍フレームを特定している

- `[SHOULD]` コンソール出力をストリームキャプチャで構造化データに変換し、レポーターごとのフォーマット変換を可能にする
  - 根拠: `capturePrintError` は `Writable` で出力を文字列化し、GitHub Actions レポーターが `stripVTControlCharacters` + ワークフローコマンド形式に変換している

- `[AVOID]` エラー表示処理内で例外を投げること — 「エラーの表示に失敗してエラー」はユーザーにとって最悪の体験であり、元の問題の情報も失われる
  - 根拠: vitest はエラー表示パイプラインのあらゆる箇所で `try/catch` + フォールバックを入れ、`processError` の最外層でも失敗をキャッチして代替メッセージを生成する

- `[AVOID]` エラーの追加プロパティを表示する際に、ブラウザ固有プロパティや内部プロパティを無フィルタで表示すること — ノイズがシグナルを埋もれさせる
  - 根拠: `skipErrorProperties` が WebKit/Firefox 固有プロパティや Error.prototype のプロパティを動的に除外している（`printError.ts:262-288`）

## 適用チェックリスト

- [ ] エラー処理の入り口で非 Error オブジェクト（string, null, undefined, number）を統一フォーマットに正規化しているか
- [ ] エラーシリアライズ処理にフォールバックがあるか（各プロパティ単位の `try/catch` + マーカー置換）
- [ ] プロセス間・ネットワーク越しのエラー転送で plain object に変換しているか
- [ ] 差分表示・stringify に入力サイズ上限を設け、巨大入力でハングしないか
- [ ] エラーメッセージからフレームワーク内部のノイズ（変数名難読化など）を除去しているか
- [ ] スタックトレースのフィルタリングで内部フレームを除外し、ユーザーコードのフレームをハイライトしているか
- [ ] エラー表示処理自体が例外を投げる可能性がないか（多段フォールバックの確認）
- [ ] `error.cause` チェーンを走査して因果関係を表示しているか
- [ ] 既知のエラーパターンに対して具体的な修正方法をエラーメッセージ内に提示しているか
- [ ] カスタムエラーにプレフィックス付き `code` プロパティがあり、シリアライズ境界を越えても判別可能か
