# configuration-patterns

> リポジトリ: vitest-dev/vitest
> 分析日: 2026-03-05

## 概要

Vitest は Vite のプラグインシステムを活用した設定アーキテクチャを持つ。`vitest.config.*` は Vite config の拡張であり、`test` プロパティに Vitest 固有の設定を配置する。ワークスペース（マルチプロジェクト）設定、環境依存デフォルト値、段階的な設定マージ戦略、設定の直列化による境界越え（ワーカーへの受け渡し）など、大規模な設定管理の実践が体系的に適用されている。設定の「解決」フェーズで矛盾検出・早期失敗を徹底している点が特に注目に値する。

## 背景にある原則

- **ホスト設定の寄生的拡張**: 独自の設定形式を作らず、Vite の `UserConfig` を拡張して `test` プロパティを注入する。これにより Vite エコシステム（プラグイン、エイリアス、環境変数等）をそのまま利用でき、ユーザーの認知負荷を最小化する。根拠: `defineConfig` が Vite の型をそのまま返す（`public/config.ts:46-55`）。

- **設定レイヤの明示的な優先順位**: defaults < viteConfig.test < CLI options の順に deepMerge で積み重ねる。各レイヤの責務が明確で、どの値がどこで決まるかを追跡可能にする。根拠: `plugins/index.ts:54-59` で `deepMerge({}, configDefaults, viteConfig.test, options)` の順序が固定されている。

- **解決フェーズでの矛盾早期検出**: 設定の組み合わせが矛盾する場合、resolve 段階で即座に例外を投げ、実行時の不可解な挙動を防ぐ。根拠: `resolveConfig.ts` で `--shard` と `--watch` の同時使用、`--inspect` と並列実行の矛盾など 10 以上の検証を実施。

- **環境適応的デフォルト**: CI 環境かどうかで `watch`, `allowOnly`, `open` のデフォルトを切り替え、ユーザーが明示的に設定しなくても適切な挙動を提供する。根拠: `defaults.ts:94-96` で `isCI` に基づいてデフォルト値を分岐。

## 実例と分析

### 1. Vite config 寄生パターン — defineConfig の透過的拡張

Vitest は `defineConfig` を提供するが、その実体は受け取った値をそのまま返す identity 関数である。型レベルで `ViteUserConfig` を拡張し `test` プロパティを追加することで、Vite の設定ファイルとしてもそのまま動作する。

```typescript
// packages/vitest/src/public/config.ts:53-55
export function defineConfig(config: ViteUserConfigExport): ViteUserConfigExport {
  return config
}
```

同様に `defineProject` もワークスペースプロジェクト用の identity 関数として提供される（`config.ts:61-63`）。これにより、設定の「定義」と「検証」を分離し、定義時には型チェックのみ、検証は解決フェーズで一括して行う。

### 2. 設定ファイル探索 — 優先順位付きフォールバック

```typescript
// packages/vitest/src/constants.ts:8-14
export const CONFIG_NAMES: string[] = ['vitest.config', 'vite.config']
export const CONFIG_EXTENSIONS: string[] = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']
export const configFiles: string[] = CONFIG_NAMES.flatMap(name =>
  CONFIG_EXTENSIONS.map(ext => name + ext),
)
```

`vitest.config.*` が `vite.config.*` より先に探索される。これにより、Vitest 専用設定がある場合はそちらが優先され、ない場合は Vite 設定にフォールバックする。`empathic/find` の `find.any()` で最初にマッチしたファイルを使用する（`create.ts:32`）。

### 3. 段階的マージ戦略 — 3 フェーズ設定解決

設定は 3 つのフェーズで段階的に解決される:

**フェーズ 1: Vite config hook（予備マージ）**
```typescript
// packages/vitest/src/node/plugins/index.ts:54-59
const testConfig = deepMerge(
  {} as UserConfig,
  configDefaults,
  removeUndefinedValues(viteConfig.test ?? {}),
  options,
)
```

**フェーズ 2: configResolved hook（最終マージ）**
```typescript
// packages/vitest/src/node/plugins/index.ts:223
options = deepMerge({}, configDefaults, viteConfigTest, options)
```

**フェーズ 3: resolveConfig（検証・正規化）**
```typescript
// packages/vitest/src/node/config/resolveConfig.ts:164-169
const resolved = {
  ...configDefaults,
  ...options,
  root: viteConfig.root,
  mode,
} as any as ResolvedConfig
```

フェーズ 1 はサーバー起動に必要な最小限の設定を構築し、フェーズ 2 で他の Vite プラグインが変更した設定を反映し、フェーズ 3 で最終的な検証と正規化を行う。

### 4. ワークスペース設定 — extends パターンによる設定継承

```typescript
// packages/vitest/src/node/types/config.ts:1302-1309
export type TestProjectInlineConfiguration = (UserWorkspaceConfig & {
  extends?: string | true
})
```

`extends: true` でルート設定を継承し、`extends: '../vite.config.ts'` で任意の設定ファイルを継承できる。解決時に `configFile` として Vite のネイティブな設定読み込みに委譲する:

```typescript
// packages/vitest/src/node/projects/resolveProjects.ts:80-84
const configFile = typeof options.extends === 'string'
  ? resolve(configRoot, options.extends)
  : options.extends === true
    ? (vitest.vite.config.configFile || false)
    : false
```

### 5. CLI オーバーライドのホワイトリスト

ワークスペースプロジェクトに対する CLI オプションの伝播を、許可リストで制御する:

```typescript
// packages/vitest/src/node/projects/resolveProjects.ts:43-64
const overridesOptions = [
  'logHeapUsage', 'detectAsyncLeaks', 'allowOnly', 'sequence',
  'testTimeout', 'pool', 'update', 'globals', 'expandSnapshotDiff',
  'disableConsoleIntercept', 'retry', 'testNamePattern',
  'passWithNoTests', 'bail', 'isolate', 'printConsoleTrace',
  'inspect', 'inspectBrk', 'fileParallelism', 'tagsFilter',
] as const
```

全ての CLI オプションを無条件にプロジェクトへ伝播させず、安全なオプションのみを選択的に渡す。

### 6. 設定の直列化 — 境界越え転送

ワーカープロセスに設定を渡す際、関数やクラスインスタンスを含む設定を安全に直列化する:

```typescript
// packages/vitest/src/node/config/serializeConfig.ts:5-150
export function serializeConfig(project: TestProject): SerializedConfig {
  const { config, globalConfig } = project
  return {
    // 関数を除外し、プリミティブ値のみを選択的に抽出
    environmentOptions: config.environmentOptions,
    mode: config.mode,
    // ...各フィールドを明示的にマッピング
  }
}
```

`SerializedConfig` 型を `ResolvedConfig` とは別に定義し、直列化可能なフィールドのみを含める。

### 7. 矛盾検出の早期失敗パターン

```typescript
// packages/vitest/src/node/config/resolveConfig.ts:252-256
if (options.shard) {
  if (resolved.watch) {
    throw new Error('You cannot use --shard option with enabled watch')
  }
  // ...
}
```

`resolveConfig` 関数内で、互いに排他的なオプションの組み合わせを網羅的にチェックし、明確なエラーメッセージで即座に失敗する。同様のパターンが `--inspect` + 並列実行、`standalone` + `--watch` 無効、`mergeReports` + `--watch` 等にも適用されている。

### 8. Nullish Coalescing による段階的デフォルト充填

```typescript
// packages/vitest/src/node/config/resolveConfig.ts:474-488
resolved.deps ??= {}
resolved.deps.moduleDirectories ??= []
resolved.deps.optimizer ??= {}
resolved.deps.optimizer.ssr ??= {}
resolved.deps.optimizer.ssr.enabled ??= false
```

ネストされたオブジェクト構造のデフォルト値を `??=` で段階的に充填する。各レベルでオブジェクトの存在を保証してから子プロパティを設定するため、`undefined` アクセスエラーを防ぐ。

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 設定の組み合わせにより異なる振る舞いを選択する必要がある
  - 適用条件: ランタイム環境（CI/ローカル）やモード（test/benchmark）で挙動が変わる設定
  - コード例: `defaults.ts:94-96` で `isCI` に基づくデフォルト分岐、`resolveConfig.ts:602-638` で benchmark モードの設定上書き
  - 注意点: 条件分岐が増えすぎると設定の予測可能性が下がる

- **Builder パターン** (分類: 生成)
  - 解決する問題: 複雑な設定オブジェクトを段階的に構築する
  - 適用条件: 設定が複数のソース（デフォルト、ファイル、CLI、環境変数）から合成される
  - コード例: `resolveConfig.ts:164-169` のスプレッド + 後続の `??=` による段階的構築
  - 注意点: 変更の順序が重要になるため、各フェーズの責務を明確にする必要がある

## Good Patterns

- **Identity defineConfig**: `defineConfig` を identity 関数として実装し、型安全性のみを提供する。設定の検証はプラグインの `configResolved` や `resolveConfig` に委譲する。これによりユーザーは設定定義時に即座にフィードバックを得つつ、検証ロジックを一箇所に集約できる。

```typescript
// packages/vitest/src/public/config.ts:53-55
export function defineConfig(config: ViteUserConfigExport): ViteUserConfigExport {
  return config
}
```

- **ホワイトリスト式オーバーライド伝播**: CLI オプションをサブプロジェクトに伝播する際、全オプションではなく安全なオプションのみをホワイトリストで選択する。新しいオプションが追加された際に意図せず伝播されることを防ぐ。

```typescript
// packages/vitest/src/node/projects/resolveProjects.ts:43-71
const overridesOptions = ['logHeapUsage', 'allowOnly', ...] as const
const cliOverrides = overridesOptions.reduce((acc, name) => {
  if (name in cliOptions) {
    acc[name] = cliOptions[name] as any
  }
  return acc
}, {} as UserConfig)
```

- **Object.freeze によるデフォルト保護**: デフォルト設定オブジェクトを `Object.freeze` で不変にし、マージ処理中の意図しない変更を防ぐ。

```typescript
// packages/vitest/src/defaults.ts:93
export const configDefaults: Readonly<{...}> = Object.freeze({
  allowOnly: !isCI,
  // ...
})
```

## Anti-Patterns / 注意点

- **as any を介した型キャストチェーン**: `resolveConfig` 内で `as any as ResolvedConfig` のダブルキャストが使われている。スプレッド演算子による段階的構築中は型が不完全なため回避が難しいが、可能な限り Builder パターンで型安全に構築すべき。

```typescript
// Bad: packages/vitest/src/node/config/resolveConfig.ts:164-169
const resolved = {
  ...configDefaults,
  ...options,
  root: viteConfig.root,
  mode,
} as any as ResolvedConfig

// Better: 型安全な Builder を使う
class ConfigBuilder {
  private config: Partial<ResolvedConfig> = {}
  withDefaults(): this { /* ... */ return this }
  withOptions(opts: UserConfig): this { /* ... */ return this }
  build(): ResolvedConfig { /* validate and return */ }
}
```

- **設定解決関数の肥大化**: `resolveConfig` が 900 行超の単一関数になっている。検証ロジック、デフォルト充填、正規化が混在し、個別のテストが困難。関心ごとにサブ関数に分割すべき。

## 導出ルール

- `[MUST]` 設定オブジェクトのデフォルト値は `Object.freeze` で保護し、マージ処理で元のオブジェクトが変更されないことを保証する
  - 根拠: vitest の `configDefaults` は `Object.freeze` で保護されており（`defaults.ts:93`）、`deepMerge` の第1引数に空オブジェクトを渡すことで元の設定を汚染しない

- `[MUST]` 互いに排他的な設定オプションの組み合わせは、設定解決フェーズで早期に検出してエラーを投げる — 実行時の不可解な挙動より起動時の明確なエラーの方がデバッグコストが低い
  - 根拠: `resolveConfig.ts` で `--shard` + `--watch`、`--inspect` + 並列実行など 10 以上の矛盾を早期検出している

- `[SHOULD]` 設定の優先順位（defaults < config file < CLI）を明示的なマージ順序で表現し、各レイヤの責務を分離する
  - 根拠: `plugins/index.ts:54-59` で `deepMerge({}, configDefaults, viteConfig.test, options)` の順序が設定優先順位を直接表現している

- `[SHOULD]` 親プロセスからワーカーへの設定転送には、直列化可能なフィールドのみを含む別の型を定義する — 関数やクラスインスタンスを含む設定をそのまま送ると実行時エラーになる
  - 根拠: `SerializedConfig` 型で `ResolvedConfig` から直列化不可能なフィールドを除外している（`serializeConfig.ts`）

- `[SHOULD]` サブプロジェクトへの CLI オプション伝播はホワイトリスト方式で制御する — ブラックリスト方式だと新規オプション追加時に意図しない伝播が起きる
  - 根拠: `resolveProjects.ts:43-64` で `overridesOptions` のホワイトリストを定義し、安全なオプションのみを伝播

- `[SHOULD]` 環境依存のデフォルト値（CI/ローカル、TTY/非TTY）は設定ファイルではなくデフォルト値の定義箇所で条件分岐させ、ユーザーが明示的に設定しなくても適切に動作するようにする
  - 根拠: `defaults.ts:94-96` で `isCI` により `watch`, `allowOnly`, `open` のデフォルトを動的に切り替え

- `[AVOID]` 設定解決関数を単一の巨大関数にすること — 検証・デフォルト充填・正規化を関心ごとにサブ関数に分割し、個別にテスト可能にする
  - 根拠: `resolveConfig.ts` の `resolveConfig` 関数は 900 行超で、カバレッジ設定・ブラウザ設定・レポーター設定等が混在しており保守が困難

## 適用チェックリスト

- [ ] デフォルト設定オブジェクトを `Object.freeze` で保護しているか
- [ ] 設定の優先順位（defaults < file < CLI < env）が明示的なマージ順序で表現されているか
- [ ] 互いに排他的なオプションの組み合わせを設定解決時に検証しているか
- [ ] ワーカーやサブプロセスに渡す設定に直列化不可能な値（関数、クラスインスタンス）が含まれていないか
- [ ] 環境（CI/ローカル）に応じたデフォルト値がユーザーの明示設定なしで適切に動作するか
- [ ] サブプロジェクトへのオプション伝播がホワイトリスト方式で制御されているか
- [ ] 設定解決関数が肥大化していないか（200 行を超えたら分割を検討）
- [ ] `??=` による段階的デフォルト充填でネストされたオブジェクトの各レベルが安全に初期化されているか
