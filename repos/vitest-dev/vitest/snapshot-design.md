# snapshot-design

> リポジトリ: vitest-dev/vitest
> 分析日: 2026-03-06

## 概要

Vitest のスナップショット機構は、外部ファイルスナップショット・インラインスナップショット・ファイルスナップショットの3形態を統一的に扱う設計になっている。シリアライズはプラグイン拡張可能な pretty-format に委譲し、インラインスナップショットの書き戻しにはソースマップ解析 + MagicString による非破壊テキスト書き換えを用いる。スナップショットの読み書きを `SnapshotEnvironment` インターフェースで抽象化し、Node.js 以外のランタイムでも動作可能にしている点が特に注目に値する。

## 背景にある原則

- **環境非依存のためのインターフェース分離**: スナップショットの永続化操作（読み・書き・削除・パス解決）を `SnapshotEnvironment` インターフェースに集約し、`packages/snapshot` パッケージ本体はファイルシステムに直接依存しない。Node.js 実装は `env/node.ts` で提供するが、ブラウザやエッジ環境では別実装に差し替え可能（`packages/snapshot/src/types/environment.ts:3-12`）。
- **シリアライズのプラグイン拡張**: 値の文字列化を `pretty-format` のプラグインチェーンに委譲し、React コンポーネント・DOM・Immutable.js・モック関数など型ごとの表現を独立して追加・差し替えできる。コア側はプラグインの `test()` → `serialize()` 呼び出しだけを知っていればよい（`packages/pretty-format/src/index.ts:360-373`）。
- **ソースコード書き換えの安全性確保**: インラインスナップショットの書き戻しでは、MagicString を使い元ソースの他の部分を破壊せずピンポイントで置換する。書き換え前後でコード全体の差分がなければ書き込みをスキップする冪等性も備える（`packages/snapshot/src/port/inlineSnapshot.ts:38-43`）。
- **ステートマシンによるライフサイクル管理**: 各テストファイルに対して `SnapshotState` を `setup` → `match` (N回) → `pack` のライフサイクルで管理し、未使用スナップショットの検出・削除をカウンターベースで実現している（`packages/snapshot/src/port/state.ts:57-101`）。

## 実例と分析

### スナップショットの3形態と統一 match ロジック

`SnapshotState.match()` メソッドが3種類のスナップショット（外部ファイル・インライン・raw ファイル）の比較を単一のコードパスで処理している。分岐は `isInline` フラグと `rawSnapshot` の有無で制御され、保存先だけが異なる:

```typescript
// packages/snapshot/src/port/state.ts:316-321
const expected = isInline
  ? inlineSnapshot
  : rawSnapshot
    ? rawSnapshot.content
    : this._snapshotData[key]
```

保存も同様に `_addSnapshot` メソッドで3方向に分岐する:

```typescript
// packages/snapshot/src/port/state.ts:188-209
private _addSnapshot(
  key: string,
  receivedSerialized: string,
  options: { rawSnapshot?: RawSnapshotInfo; stack?: ParsedStack; testId: string },
): void {
  this._dirty = true
  if (options.stack) {
    this._inlineSnapshots.push({ ... })
  } else if (options.rawSnapshot) {
    this._rawSnapshots.push({ ... })
  } else {
    this._snapshotData[key] = receivedSerialized
  }
}
```

### スナップショットファイルの JavaScript シリアライズ

外部スナップショットファイル（`.snap`）は JavaScript として実行可能な形式で保存される。`new Function('exports', content)` でパースし、`exports[key] = value` 形式でデータを復元する:

```typescript
// packages/snapshot/src/port/utils.ts:38-49
const data = Object.create(null)
if (content != null) {
  try {
    const populate = new Function('exports', snapshotContents)
    populate(data)
  }
  catch {}
}
```

保存時はキーを自然順ソートしてバッククォート文字列で出力する:

```typescript
// packages/snapshot/src/port/utils.ts:143-148
const snapshots = Object.keys(snapshotData)
  .sort(naturalCompare)
  .map(
    key =>
      `exports[${printBacktickString(key)}] = ${printBacktickString(
        normalizeNewlines(snapshotData[key]),
      )};`,
  )
```

`Object.create(null)` でプロトタイプなしオブジェクトを使い、`__proto__` などのキー汚染を防止している。

### インラインスナップショットの AST 書き換え

インラインスナップショットの書き戻しは以下のステップで行われる:

1. **呼び出し位置の特定**: `Error` オブジェクトのスタックトレースを `parseErrorStacktrace` でパースし、`__INLINE_SNAPSHOT__` または `__INLINE_SNAPSHOT_OFFSET_<n>__` マーカーを探してコール位置を推定する（`state.ts:162-186`）
2. **ソースマップ補正**: `column--` で1列ずらす。Vite の sourcemap が JS/TS で異なるオフセットを返す問題への対応（`state.ts:357-358`）
3. **正規表現によるトークン解析**: `toMatchInlineSnapshot` の呼び出しパターンを正規表現で検出し、引数のクォート文字を特定する（`inlineSnapshot.ts:149-150`）
4. **MagicString による書き換え**: `s.overwrite()` で既存の引数部分を置換、または `s.appendRight()` で新しい引数を挿入する（`inlineSnapshot.ts:173-184`）

```typescript
// packages/snapshot/src/port/inlineSnapshot.ts:32-44
const s = new MagicString(code)

for (const snap of snaps) {
  const index = positionToOffset(code, snap.line, snap.column)
  replaceInlineSnap(code, s, index, snap.snapshot)
}

const transformed = s.toString()
if (transformed !== code) {
  await environment.saveSnapshotFile(file, transformed)
}
```

### プラグインチェーンによるシリアライズ

`pretty-format` はプラグインの配列を先頭から走査し、最初に `test()` が `true` を返したプラグインの `serialize()` を使う。カスタムシリアライザは `addSerializer` で配列の先頭に挿入されるため、ビルトインより優先される:

```typescript
// packages/snapshot/src/port/plugins.ts:35-37
export function addSerializer(plugin: PrettyFormatPlugin): void {
  PLUGINS = [plugin].concat(PLUGINS)
}
```

ビルトインのプラグイン順序は ReactTestComponent → ReactElement → DOMElement → DOMCollection → Immutable → AsymmetricMatcher → MockSerializer の7つで、より具体的な型が先に評価される。

### 未使用スナップショットの検出と削除

`SnapshotState` は初期化時に全キーを `_uncheckedKeys` に入れ、`match()` が呼ばれるたびに該当キーを削除する。テスト完了後に残ったキーが未使用スナップショットとなる:

```typescript
// packages/snapshot/src/port/state.ts:101
this._uncheckedKeys = new Set(Object.keys(this._snapshotData))

// state.ts:293
this._uncheckedKeys.delete(key)
```

`--update` 時には `removeUncheckedKeys()` で不要キーを一括削除する（`state.ts:262-268`）。

### テストリトライへの対応

`clearTest(testId)` メソッドがリトライ時のスナップショット状態リセットを担う。インラインスナップショット・ファイルスナップショット・統計カウンタをすべてテスト ID 単位でロールバックする:

```typescript
// packages/snapshot/src/port/state.ts:137-160
clearTest(testId: string): void {
  this._inlineSnapshots = this._inlineSnapshots.filter(s => s.testId !== testId)
  for (const key of this._testIdToKeys.get(testId)) {
    this._snapshotData[key] = this._initialData[key]
    this._counters.set(name, count - 1)
  }
}
```

### インデント自動調整

`prepareSnapString()` はコールサイトの行のインデントを基準にスナップショット文字列を整形する。タブ・スペース混在にも対応する:

```typescript
// packages/snapshot/src/port/inlineSnapshot.ts:101-122
function prepareSnapString(snap: string, source: string, index: number) {
  const lineNumber = offsetToLineNumber(source, index)
  const line = source.split(lineSplitRE)[lineNumber - 1]
  const indent = line.match(/^\s*/)![0] || ''
  const indentNext = indent.includes('\t') ? `${indent}\t` : `${indent}  `
  // ...
}
```

## コード例

```typescript
// packages/snapshot/src/port/utils.ts:38
const data = Object.create(null)
```

プロトタイプなしオブジェクトを使うことで、スナップショットキーに `toString` や `constructor` が含まれてもプロトタイプ汚染が起きない。

```typescript
// packages/snapshot/src/port/utils.ts:153-158
const oldContent = await environment.readSnapshotFile(snapshotPath)
const skipWriting = oldContent != null && oldContent === content

if (skipWriting) {
  return
}
```

書き込み前に既存内容と比較し、変更がなければ I/O をスキップする冪等性パターン。

```typescript
// packages/vitest/src/integrations/snapshot/chai.ts:134
function __INLINE_SNAPSHOT_OFFSET_3__(this, properties?, inlineSnapshot?, message?) { ... }
```

関数名にオフセット値を埋め込み、スタックトレースからの位置逆算でラッパー層の深さを動的に吸収する。

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: スナップショットの永続化方法がランタイム環境によって異なる
  - 適用条件: ファイルシステム操作がランタイムに依存する場合
  - コード例: `packages/snapshot/src/types/environment.ts:3-12` (`SnapshotEnvironment`)、`packages/snapshot/src/env/node.ts:5-48` (`NodeSnapshotEnvironment`)
  - 注意点: async メソッドで統一することで、ブラウザ環境の非同期 API にも対応可能にしている

- **Chain of Responsibility パターン** (分類: 振る舞い)
  - 解決する問題: 多様な型の値を適切にシリアライズする必要がある
  - 適用条件: 拡張可能なシリアライズが必要で、型ごとに異なるフォーマットが求められる場合
  - コード例: `packages/pretty-format/src/index.ts:360-373` (`findPlugin`)
  - 注意点: プラグインの登録順序が評価優先度を決定する。カスタムプラグインは先頭挿入で最優先にする

- **Memento パターン** (分類: 振る舞い)
  - 解決する問題: テストリトライ時にスナップショット状態を以前の状態に戻す必要がある
  - 適用条件: 状態のロールバックが必要な場面
  - コード例: `packages/snapshot/src/port/state.ts:95-96` (`_initialData` の保持)、`state.ts:137-160` (`clearTest`)
  - 注意点: 初期状態のコピーをコンストラクタ時点で保持する。shallow copy で十分なのは値が文字列（イミュータブル）であるため

## Good Patterns

- **マーカー関数名によるスタック位置推定**: インラインスナップショットの呼び出し位置を特定するために、関数名に `__INLINE_SNAPSHOT__` や `__INLINE_SNAPSHOT_OFFSET_<n>__` というマーカーを埋め込む。スタックトレースを正規表現で走査し、マーカーからの相対オフセットで正確な位置を特定する。

```typescript
// packages/vitest/src/integrations/snapshot/chai.ts:134
function __INLINE_SNAPSHOT_OFFSET_3__(this, properties?, inlineSnapshot?, message?) { ... }

// packages/snapshot/src/port/state.ts:173-177
const match = stacks[i].method.match(/__INLINE_SNAPSHOT_OFFSET_(\d+)__/)
if (match) {
  return stacks[i + Number(match[1])] ?? null
}
```

- **MagicString による非破壊ソース変換**: 同一ファイル内の複数スナップショットを一括更新する際、MagicString のオフセット管理により各書き換えが互いに干渉しない。正規表現パーサーとの組み合わせで、AST パーサーに依存しない軽量なコード操作を実現している。

```typescript
// packages/snapshot/src/port/inlineSnapshot.ts:32-37
const s = new MagicString(code)
for (const snap of snaps) {
  const index = positionToOffset(code, snap.line, snap.column)
  replaceInlineSnap(code, s, index, snap.snapshot)
}
```

- **書き込みスキップによる冪等性**: `saveSnapshotFile` は新旧コンテンツを文字列比較し、変化がなければ I/O を省略する。CI 環境でのファイルタイムスタンプ変化を防ぎ、不要な git diff も回避する。

```typescript
// packages/snapshot/src/port/utils.ts:153-158
const oldContent = await environment.readSnapshotFile(snapshotPath)
const skipWriting = oldContent != null && oldContent === content
```

- **CounterMap による後方互換性**: `jest-image-snapshot` との互換性のために、`CounterMap` は `valueOf()` と setter を実装し、`snapshotState.added = snapshotState.added + 1` のような外部ライブラリのコードが動作し続けるようにしている。

```typescript
// packages/snapshot/src/port/utils.ts:255-287
export class CounterMap<K> extends DefaultMap<K, number> {
  _total: number | undefined
  valueOf(): number {
    return this._total = this.total()
  }
  increment(key: K): void {
    if (typeof this._total !== 'undefined') { this._total++ }
    this.set(key, this.get(key) + 1)
  }
}
```

## Anti-Patterns / 注意点

- **`new Function` によるスナップショット実行**: 外部スナップショットファイルを `new Function('exports', content)` で動的に評価している。これは信頼できるテスト環境内でのみ許容される手法であり、ユーザー入力を含む文字列に対して同様のアプローチを取るとコードインジェクションの危険がある。

```typescript
// Bad: 外部入力をそのまま Function コンストラクタに渡す
const fn = new Function('exports', userProvidedContent)
fn(data)

// Better: 信頼できるソースからのみ読み込み、パース失敗を catch で吸収する
try {
  const populate = new Function('exports', trustedSnapshotContent)
  populate(data)
} catch {} // パースエラーは空データとして扱う
```

- **正規表現ベースのコード解析の限界**: インラインスナップショットの書き換えは正規表現でトークンを検出しているため、コメント内の `toMatchInlineSnapshot` やネストしたテンプレートリテラル内の同名メソッドを誤検出する可能性がある。完全な AST パーサーではなく正規表現を選んだのはパフォーマンスと言語非依存性とのトレードオフだが、エッジケースに注意が必要。

```typescript
// Bad: 正規表現だけに頼ったコード構造判定
const startRegex = /toMatchInlineSnapshot\s*\(/

// Better: スタックトレースで絞り込んだオフセット位置を起点に正規表現を適用（現行実装）
const { code: codeStartingAtIndex, index } = getCodeStartingAtIndex(code, currentIndex)
const startMatch = startRegex.exec(codeStartingAtIndex)
```

## 導出ルール

- `[MUST]` キーに任意の文字列を使うデータストアには `Object.create(null)` を使い、プロトタイプチェーン汚染を防止する
  - 根拠: `getSnapshotData()` がプロトタイプなしオブジェクトでスナップショットデータを格納し、テスト名に `toString` 等が含まれてもキー衝突しない設計にしている（`packages/snapshot/src/port/utils.ts:38`）

- `[MUST]` ファイル書き込み前に旧コンテンツとの同一性を検証し、不要な I/O を省略する
  - 根拠: CI 環境でのタイムスタンプ変化、git diff の誤検出、ウォッチモードでの無限ループを防止する（`packages/snapshot/src/port/utils.ts:153-158`）

- `[SHOULD]` シリアライズをプラグインチェーン（`test()` → `serialize()` の二段階評価）で拡張可能にし、コア側は型固有のロジックを持たない設計にする
  - 根拠: `@vitest/pretty-format` のプラグインシステムが React/DOM/Immutable/MockFunction 等をプラグインで処理し、`addSerializer()` でユーザー拡張を先頭挿入で受け付ける（`packages/snapshot/src/port/plugins.ts:35-37`）

- `[SHOULD]` ソースコードの部分書き換えには MagicString などのオフセット追跡ライブラリを使い、複数箇所の同時変更でもインデックスがずれない仕組みを確保する
  - 根拠: 素の文字列置換では前方の変更が後方のオフセットを狂わせるが、MagicString は内部で差分を管理する（`packages/snapshot/src/port/inlineSnapshot.ts:32-37`）

- `[SHOULD]` テスト/トランザクションのリトライ機構では、初期状態のスナップショット（Memento）を保持し、テスト ID 単位でロールバックできるようにする
  - 根拠: リトライ時に前回の途中状態が残ると、カウンタのずれや重複スナップショットが発生する（`packages/snapshot/src/port/state.ts:95-96, 137-160`）

- `[AVOID]` スタックトレース解析でハードコードされたフレームオフセットに依存する。代わりにマーカー関数名をアンカーとし、環境差異を吸収する
  - 根拠: Vitest は `__INLINE_SNAPSHOT_OFFSET_<n>__` で可変オフセットを実現し、resolves/rejects ラッパーや異なる JS エンジンにも対応している（`packages/snapshot/src/port/state.ts:162-186`）

- `[AVOID]` 環境固有の I/O 操作をコアロジックに直接記述する。インターフェースで抽象化し、環境ごとの実装を差し替え可能にする
  - 根拠: `SnapshotEnvironment` によりブラウザ・エッジ・Node.js の I/O 差異を吸収し、スナップショットロジックの可搬性を確保している（`packages/snapshot/src/types/environment.ts:3-12`）

## 適用チェックリスト

- [ ] シリアライズ対象が多様な型を含む場合、プラグインチェーン方式で拡張可能にしているか
- [ ] テスト/トランザクションのリトライが必要な場面で、状態の初期スナップショットを保持しロールバック可能にしているか
- [ ] ソースコードや設定ファイルの部分書き換えに MagicString 等のオフセット管理ツールを使い、複数箇所の同時変更に対応しているか
- [ ] ファイルシステム操作をインターフェースで抽象化し、テスト時のモックや異なるランタイムへの移植を容易にしているか
- [ ] 書き込み前の同一性チェックで不要な I/O を省略し、冪等性を確保しているか
- [ ] 動的に生成されるキーを格納するオブジェクトに `Object.create(null)` を使い、プロトタイプ汚染を防止しているか
- [ ] スタックトレースやコール位置の特定にマーカー関数名を利用し、フレームオフセットのハードコードを避けているか
