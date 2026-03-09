# coverage-provider-patterns

> リポジトリ: vitest-dev/vitest
> 分析日: 2026-03-06

## 概要

Vitest のカバレッジシステムは、V8 と Istanbul という根本的に異なる計測エンジンを統一的に扱うプロバイダ抽象化層を持つ。V8 はランタイムプロファイラから生のカバレッジを取得し AST ベースで Istanbul 形式へ変換するのに対し、Istanbul はコード変換時にカウンターを埋め込む。この2つのアプローチを同一インターフェースで扱いつつ、ソースマップ統合・レポート生成・閾値チェックを共通基盤に押し込んだ設計は、プラグイン型アーキテクチャの実践例として注目に値する。

## 背景にある原則

- **計測メカニズムと報告メカニズムの分離**: カバレッジデータの「収集方法」と「報告方法」を明確に分離し、収集側のみをプロバイダに委譲する。報告・閾値チェック・ファイル管理は `BaseCoverageProvider` に集約されている（`packages/vitest/src/node/coverage.ts`）。これにより新しい計測エンジンを追加しても報告パイプラインを再実装する必要がない。

- **ランタイム境界を意識した二層インターフェース**: ワーカースレッド内で動作する軽量な `RuntimeCoverageProviderModule`（start/take/stop）と、メインスレッドで動作する完全な `CoverageProvider` インターフェースを分離している（`packages/vitest/src/utils/coverage.ts:9-29`, `packages/vitest/src/node/types/coverage.ts:16-68`）。プロセス間通信のコストを最小化するため、ランタイム側は生データ収集のみに絞り、重い変換処理はメインスレッドで実行する。

- **共通フォーマットへの正規化による統一パイプライン**: V8 の `Profiler.ScriptCoverage` も Istanbul のカウンターベースデータも、最終的に `istanbul-lib-coverage` の `CoverageMap` に正規化される。共通フォーマットの存在が、報告・閾値・マージ等の下流処理を一度だけ実装すればよい構造を支えている。

- **早期フィルタリングによるデータ量制御**: V8 ブラウザ/Node.js 両方のモジュールで、`filterResult` 関数が node_modules や vitest 内部ファイルを早期に除外している（`packages/coverage-v8/src/index.ts:63-81`, `packages/coverage-v8/src/browser.ts:54-84`）。RPC 経由のデータ転送量を削減するプラクティス。

## 実例と分析

### 二層インターフェースによるプロセス境界の管理

ワーカー側の `RuntimeCoverageProviderModule` は 3 メソッドのみの最小インターフェース:

```typescript
// packages/vitest/src/utils/coverage.ts:9-29
export interface RuntimeCoverageProviderModule {
  getProvider: () => any
  startCoverage?: (runtimeOptions: { isolate: boolean }) => unknown | Promise<unknown>
  takeCoverage?: (runtimeOptions?: { moduleExecutionInfo?: Map<string, { startOffset: number }> }) => unknown | Promise<unknown>
  stopCoverage?: (runtimeOptions: { isolate: boolean }) => unknown | Promise<unknown>
}
```

メインスレッド側の `CoverageProvider` は 12 メソッドを持つ完全なインターフェース（`packages/vitest/src/node/types/coverage.ts:16-68`）。ワーカー側で型安全性を緩めている（`getProvider` の戻り値が `any`）のは、ワーカーがプロバイダインスタンスを使わないため。

### Template Method パターンによる基底クラス設計

`BaseCoverageProvider` は、共通ロジックを実装しつつ、プロバイダ固有の処理を抽象メソッドとして子クラスに委譲する:

```typescript
// packages/vitest/src/node/coverage.ts:219-229
createCoverageMap(): CoverageMap {
  throw new Error('BaseReporter\'s createCoverageMap was not overwritten')
}

async generateReports(_: CoverageMap, __: boolean | undefined): Promise<void> {
  throw new Error('BaseReporter\'s generateReports was not overwritten')
}

async parseConfigModule(_: string): Promise<{ generate: () => { code: string } }> {
  throw new Error('BaseReporter\'s parseConfigModule was not overwritten')
}
```

TypeScript の `abstract` を使わずランタイムエラーで未実装を検出する手法を採用している。子クラスが `implements CoverageProvider` を宣言しているため、型レベルでの安全性は `CoverageProvider` インターフェースが担保している。

### コールバック駆動のファイル読み取りパイプライン

`readCoverageFiles` メソッドは、プロバイダごとに異なるデータ型を型パラメータで受け取りつつ、読み取り・パース・マージ処理をコールバックで柔軟に構成する:

```typescript
// packages/vitest/src/node/coverage.ts:284-320
async readCoverageFiles<CoverageType>({ onFileRead, onFinished, onDebug }: {
  onFileRead: (data: CoverageType) => void
  onFinished: (project: Vitest['projects'][number], environment: string) => Promise<void>
  onDebug: ((...logs: any[]) => void) & { enabled: boolean }
}): Promise<void> {
```

V8 では `onFileRead` で `mergeProcessCovs` による逐次マージを行い、Istanbul では `coverageMap.merge` でマップ結合する。同じ読み取りフレームワーク上で完全に異なるマージ戦略を実現している。

### V8 と Istanbul のソースマップ統合の違い

V8 プロバイダは AST ベースの変換（`ast-v8-to-istanbul`）でソースマップを統合し、ビルドツール由来のコードを `ignoreNode` コールバックで除外する:

```typescript
// packages/coverage-v8/src/provider.ts:217-327
ignoreNode: (node, type) => {
  // SSR transformed imports
  if (type === 'statement' && node.type === 'VariableDeclarator'
      && node.id.type === 'Identifier'
      && node.id.name.startsWith('__vite_ssr_import_')) {
    return true
  }
  // ... CJS imports, in-source tests, SWC decorators 等
}
```

Istanbul プロバイダは同等の処理をコード変換時のコメント挿入で実現する:

```typescript
// packages/coverage-istanbul/src/provider.ts:80-85
sourceCode = sourceCode
  .replaceAll('_ts_decorate', '/* istanbul ignore next */_ts_decorate')
  .replaceAll(/(if +\(import\.meta\.vitest\))/g, '/* istanbul ignore next */ $1')
```

同じ「ビルドツール由来のコードをカバレッジから除外する」という要求に対し、計測エンジンの特性に応じた最適な実装を選択している。V8 は実行後の AST 走査で除外し、Istanbul は実行前のコード変換で除外する。

### 動的プロバイダ解決とバンドル回避

プロバイダモジュールの動的 import で意図的にバンドラーの静的解析を回避している:

```typescript
// packages/coverage-v8/src/load-provider.ts:4-9
const name = './provider.js'
export async function loadProvider(): Promise<V8CoverageProvider> {
  const { V8CoverageProvider } = (await import(/* @vite-ignore */ name)) as typeof import('./provider')
  return new V8CoverageProvider()
}
```

Istanbul 側も同様の手法を採用（`packages/coverage-istanbul/src/index.ts:41-47`）。重い依存関係（istanbul-lib-instrument, ast-v8-to-istanbul 等）をメインスレッドでのみロードし、ワーカー側のバンドルサイズを削減する。

### プロバイダ横断テストの設計

テストスイート全体を環境変数で V8/Istanbul/custom に切り替えて実行する構造になっている。テストユーティリティが `process.env.COVERAGE_PROVIDER` を参照してプロバイダを動的に選択:

```typescript
// test/coverage-test/utils.ts:29-46
export async function runVitest(config: TestUserConfig, ...) {
  const provider = process.env.COVERAGE_PROVIDER as any
  const result = await testUtils.runVitest({
    coverage: { enabled: true, ...config.coverage, provider },
  })
}
```

`isV8Provider()` 等のヘルパーでプロバイダ固有の分岐を行い、大部分のテストは共通コードで記述する。70 以上のテストファイルが両プロバイダで共有されている。

### 並行処理の制御とステートフル API の制約

大量ファイル処理で `processingConcurrency` オプションによるチャンク分割を使用するが、Istanbul のカバー外ファイル処理ではこの並行化を適用できない:

```typescript
// packages/coverage-istanbul/src/provider.ts:218-219
// Note that these cannot be run parallel as synchronous instrumenter.lastFileCoverage
// returns the coverage of the last transformed file
```

`instrumenter.lastFileCoverage()` がステートフルな API であるため順次処理が必須。V8 プロバイダでは同等処理を `Promise.all` で並行実行できている。外部ライブラリのステートフル API がアーキテクチャ上の制約になる実例。

## コード例

```typescript
// packages/vitest/src/node/types/coverage.ts:16-68
// プロバイダインターフェース -- ライフサイクルフックの完全な定義
export interface CoverageProvider {
  name: string
  initialize: (ctx: Vitest) => Promise<void> | void
  resolveOptions: () => ResolvedCoverageOptions
  clean: (clean?: boolean) => void | Promise<void>
  onAfterSuiteRun: (meta: AfterSuiteRunMeta) => void | Promise<void>
  generateCoverage: (reportContext: ReportContext) => CoverageResults | Promise<CoverageResults>
  reportCoverage: (coverage: CoverageResults, reportContext: ReportContext) => void | Promise<void>
  // Optional hooks
  onTestRunStart?: () => void | Promise<void>
  onTestFailure?: () => void | Promise<void>
  mergeReports?: (coverages: CoverageResults[]) => void | Promise<void>
  onFileTransform?: (sourceCode: string, id: string, pluginCtx: any) => TransformResult | Promise<TransformResult>
}
```

```typescript
// packages/vitest/src/utils/coverage.ts:31-34
// プロバイダ名から npm パッケージへの静的マッピング
export const CoverageProviderMap: Record<string, string> = {
  v8: '@vitest/coverage-v8',
  istanbul: '@vitest/coverage-istanbul',
}
```

```typescript
// packages/vitest/src/node/coverage.ts:91-128
// BaseCoverageProvider._initialize -- バージョン不一致検出と設定の正規化
_initialize(ctx: Vitest): void {
  this.ctx = ctx
  if (ctx.version !== this.version) {
    ctx.logger.warn(
      c.yellow(
        `Loaded vitest@${ctx.version} and @vitest/coverage-${this.name}@${this.version}.`
        + '\nRunning mixed versions is not supported and may lead into bugs',
      ),
    )
  }
  this.options = {
    ...coverageConfigDefaults,
    ...config,
    provider: this.name,
    reportsDirectory: resolve(ctx.config.root, config.reportsDirectory || coverageConfigDefaults.reportsDirectory),
    reporter: resolveCoverageReporters(config.reporter || coverageConfigDefaults.reporter),
  }
}
```

## パターンカタログ

- **Template Method** (分類: 振る舞い)
  - 解決する問題: 共通のカバレッジパイプライン（ファイル読み取り -> マージ -> 報告 -> 閾値チェック）を維持しつつ、計測エンジン固有の処理を差し替える
  - 適用条件: 処理の骨格は共通だが、特定のステップが実装ごとに異なる場合
  - コード例: `packages/vitest/src/node/coverage.ts:219-229`（`createCoverageMap`, `generateReports` の委譲）
  - 注意点: TypeScript の `abstract` ではなくランタイムエラーで未実装を検出。インターフェース実装（`implements CoverageProvider`）が型安全性を補完

- **Strategy** (分類: 振る舞い)
  - 解決する問題: V8（ランタイムプロファイラ）と Istanbul（コード変換時埋め込み）という根本的に異なる計測戦略を交換可能にする
  - 適用条件: 同じ目的を達成する複数のアルゴリズムが存在し、ユーザーが選択できるようにしたい場合
  - コード例: `packages/vitest/src/utils/coverage.ts:36-83`（`resolveCoverageProviderModule` による動的プロバイダ解決）
  - 注意点: `custom` プロバイダもサポートしており、組み込み以外の Strategy も受け入れる拡張ポイントを持つ

- **Factory Method** (分類: 生成)
  - 解決する問題: プロバイダのインスタンス生成をモジュール境界の外に配置し、動的 import によるバンドル最適化を可能にする
  - 適用条件: 重い依存関係を持つオブジェクトの生成を遅延させたい場合
  - コード例: `packages/coverage-v8/src/load-provider.ts:6-9`, `packages/coverage-istanbul/src/index.ts:39-47`

## Good Patterns

- **共通フォーマットへの正規化で下流処理を統一**: V8 の `Profiler.ScriptCoverage` を `ast-v8-to-istanbul` で Istanbul の `CoverageMap` に変換し、報告・閾値・マージを共通実装で処理する。プロバイダが増えても下流は一切変更不要。

```typescript
// packages/coverage-v8/src/provider.ts:43-101
async generateCoverage({ allTestsRun }: ReportContext): Promise<CoverageMap> {
  const coverageMap = this.createCoverageMap()
  let merged: RawCoverage = { result: [] }
  await this.readCoverageFiles<RawCoverage>({
    onFileRead(coverage) {
      merged = mergeProcessCovs([merged, coverage])
    },
    onFinished: async (project, environment) => {
      const converted = await this.convertCoverage(merged, project, environment)
      coverageMap.merge(converted)
      merged = { result: [] }
    },
    onDebug: debug,
  })
  return coverageMap
}
```

- **ライフサイクルフックの必須/任意の明確な区分**: `CoverageProvider` インターフェースで、`initialize`/`clean`/`generateCoverage`/`reportCoverage` は必須、`onTestRunStart`/`onTestFailure`/`mergeReports`/`onFileTransform` は `?` でオプショナルと宣言。プロバイダの最小実装を明確にしつつ拡張ポイントを提供。

```typescript
// packages/vitest/src/node/types/coverage.ts:16-68
export interface CoverageProvider {
  name: string
  initialize: (ctx: Vitest) => Promise<void> | void        // 必須
  onTestRunStart?: () => void | Promise<void>               // 任意
  onFileTransform?: (...) => TransformResult | Promise<TransformResult>  // 任意
}
```

- **名前ベースマッピング + カスタムプロバイダフォールバック**: 組み込みプロバイダは `CoverageProviderMap` で文字列名から解決し、カスタムプロバイダは任意のモジュールパスで対応。95% のユーザーは `provider: 'v8'` で済み、パワーユーザーは `provider: 'custom'` + `customProviderModule` で拡張可能。

```typescript
// packages/vitest/src/utils/coverage.ts:31-34, 46-62
if (provider === 'v8' || provider === 'istanbul') {
  let builtInModule = CoverageProviderMap[provider]
  if (provider === 'v8' && loader.isBrowser) {
    builtInModule += '/browser'
  }
  const { default: coverageModule } = await loader.import(builtInModule)
  return coverageModule
}
// custom provider: dynamic import from customProviderModule
```

- **閾値の正負による二重解釈**: 正の値は「最低カバレッジ率（%）」、負の値は「許容される未カバー数」として解釈する。一つの設定フィールドで 2 つの制約モデルを表現する巧みな設計。

```typescript
// packages/vitest/src/node/coverage.ts:493-535
if (threshold >= 0) {
  const coverage = summary.data[thresholdKey].pct
  // "Coverage for statements (33.33%) does not meet threshold (85%)"
} else {
  const uncovered = summary.data[thresholdKey].total - summary.data[thresholdKey].covered
  const absoluteThreshold = threshold * -1
  // "Uncovered statements (33) exceed threshold (30)"
}
```

## Anti-Patterns / 注意点

- **ステートフル API による並行処理の制約**: Istanbul の `instrumenter.lastFileCoverage()` はグローバル状態を持つため、カバー外ファイル処理を並行化できない。V8 プロバイダでは同等の処理を `Promise.all` で並行実行できているため、パフォーマンス差が生じる。

```typescript
// Bad: ステートフルな API に依存（Istanbul）
// packages/coverage-istanbul/src/provider.ts:218-234
// Note that these cannot be run parallel as synchronous instrumenter.lastFileCoverage
// returns the coverage of the last transformed file
for (const [index, filename] of uncoveredFiles.entries()) {
  await transform(`${filename}?cache=${cacheKey}&vitest-uncovered-coverage=true`)
  const lastCoverage = this.instrumenter.lastFileCoverage()
  coverageMap.addFileCoverage(lastCoverage)
}

// Better: ステートレスな変換（V8）-- 並行処理可能
// packages/coverage-v8/src/provider.ts:156-193
for (const chunk of this.toSlices(uncoveredFiles, this.options.processingConcurrency)) {
  await Promise.all(chunk.map(async (filename) => {
    const sources = await this.getSources(url, transform)
    coverageMap.merge(await this.remapCoverage(url, 0, sources, []))
  }))
}
```

- **URL 形式の不統一によるアドホックな正規化**: ファイルパスの `file://` プロトコル付与・除去処理が複数箇所に散在しており、ブラウザ/Node.js/Windows の差異を個別に吸収している。

```typescript
// packages/coverage-v8/src/provider.ts:172
const url = `file://${filename[0] === '/' ? '' : '/'}${filename}`

// packages/coverage-v8/src/provider.ts:341-343
const filepath = url.match(/^file:\/\/\/\w:\//)
  ? url.slice(8)
  : removeStartsWith(url, FILE_PROTOCOL)
```

ファイルパスの正規化関数を一箇所に集約すると保守性が向上する。

- **`CoverageResults` の `unknown` 型**: `generateCoverage` の戻り値が `type CoverageResults = unknown` と定義されており、プロバイダ間でデータ形式の契約が型レベルで存在しない。

```typescript
// Bad: 型安全性がない
type CoverageResults = unknown
generateCoverage: (reportContext: ReportContext) => CoverageResults | Promise<CoverageResults>

// Better: ジェネリクスでプロバイダごとの型を指定
interface CoverageProvider<TResults = unknown> {
  generateCoverage: (ctx: ReportContext) => TResults | Promise<TResults>
  reportCoverage: (coverage: TResults, ctx: ReportContext) => void | Promise<void>
}
```

ただし `unknown` は `any` より安全であり、同一プロバイダ内で `generateCoverage` -> `reportCoverage` のデータフローが閉じている設計意図は理解できる。

## 導出ルール

- `[MUST]` プラグイン型プロバイダを設計する際は、インターフェースのメソッドを「必須」と「オプショナル」に明確に分類する。必須メソッドが最小実装を定義し、オプショナルメソッドが拡張ポイントを提供する
  - 根拠: `CoverageProvider` は 5 つの必須メソッドと 6 つのオプショナルメソッドに分かれており、カスタムプロバイダの実装ハードルを下げつつ既存機能との互換性を保っている（`packages/vitest/src/node/types/coverage.ts:16-68`）

- `[MUST]` 異なる実装を統一パイプラインで処理する場合は、共通の中間フォーマット（正規化レイヤー）を定義し、各実装がそのフォーマットへの変換のみを担当するようにする
  - 根拠: V8 と Istanbul は計測メカニズムが根本的に異なるが、`CoverageMap` への正規化により報告・閾値チェック・マージ処理を `BaseCoverageProvider` に一元化している（`packages/vitest/src/node/coverage.ts:355-367, 620-628`）

- `[SHOULD]` プロセス境界を跨ぐプラグインインターフェースは、ランタイム側（データ収集）とホスト側（データ処理・報告）で別のインターフェースに分離する。ランタイム側は最小限のデータ収集 API に絞り、重い処理はホスト側に配置する
  - 根拠: `RuntimeCoverageProviderModule`（3 メソッド）と `CoverageProvider`（12 メソッド）の分離により、ワーカースレッドに重い依存関係を持ち込まず、RPC のデータ量も最小化している（`packages/vitest/src/utils/coverage.ts`, `packages/vitest/src/node/types/coverage.ts`）

- `[SHOULD]` 大量ファイル処理パイプラインでは、並行度を設定可能なチャンク分割で制御する。外部ライブラリがステートフルな API を提供している場合は順次処理にフォールバックし、その制約をコメントで明示する
  - 根拠: V8 プロバイダは `processingConcurrency` でチャンク並行処理を行うが、Istanbul は `lastFileCoverage()` のステートフル性により順次処理を余儀なくされており、コメントで理由が明記されている（`packages/coverage-istanbul/src/provider.ts:218-219`）

- `[SHOULD]` プロバイダの動的 import では、変数に格納したパス文字列と `/* @vite-ignore */` を使ってバンドラーの静的解析を意図的に回避し、重い依存関係のツリーシェイキングを可能にする
  - 根拠: V8/Istanbul 両プロバイダで `const name = './provider.js'` + `import(/* @vite-ignore */ name)` パターンが使われ、ワーカー側バンドルからプロバイダ実装を除外している（`packages/coverage-v8/src/load-provider.ts:4-9`）

- `[SHOULD]` プラグインパッケージと本体のバージョン整合性をランタイムで検証し、不一致時にパッケージ名とバージョンを含む具体的な警告を出す
  - 根拠: `BaseCoverageProvider._initialize` でバージョンを比較し、不整合時にユーザーがすぐ対処できる情報を含む警告メッセージを表示している（`packages/vitest/src/node/coverage.ts:94-101`）

- `[AVOID]` ファイルパスの形式変換（URL <-> ファイルパス）を各処理箇所でアドホックに実装する。正規化ユーティリティを一箇所に集約し、OS・ブラウザ環境の差異を単一モジュールで吸収すべき
  - 根拠: V8 プロバイダ内で `file://` プレフィックスの付与・除去・Windows パス対応が複数箇所に散在しており、手法が統一されていない（`packages/coverage-v8/src/provider.ts:172, 341-343, 399-408`）

## 適用チェックリスト

- [ ] プロバイダインターフェースで必須メソッドとオプショナルメソッドが明確に分かれているか
- [ ] 異なるプロバイダからの出力が共通の中間フォーマットに正規化されているか
- [ ] プロセス境界を跨ぐ場合、ランタイム側とホスト側のインターフェースが分離されているか
- [ ] 重い依存関係を持つプロバイダのインスタンス生成が遅延ロード（動的 import）で実装されているか
- [ ] 大量ファイル処理で並行度制御（チャンク分割）が設定可能になっているか
- [ ] 外部ライブラリのステートフル API による並行処理の制約がコメントで明示されているか
- [ ] ファイルパス正規化（URL <-> ファイルパス）が一箇所に集約されているか
- [ ] プラグインと本体のバージョン不整合を検出し、ユーザーに分かりやすく警告しているか
- [ ] プロバイダ横断テストが環境変数やパラメータで切り替え実行可能になっているか
