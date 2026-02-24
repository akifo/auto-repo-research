# プロジェクト構造

> リポジトリ: promptfoo/promptfoo
> 分析日: 2026-02-21

## 概要

promptfoo はモノリポ内に CLI・Web UI・ドキュメントサイトの 3 つの成果物を持つ大規模 TypeScript プロジェクト（約 2,300 ソースファイル）である。npm workspaces で `src/app`（React Web UI）と `site`（Docusaurus ドキュメント）を分離しつつ、コアライブラリとこれらワークスペース間で型定義を共有するアーキテクチャが注目に値する。テストは unit / integration / smoke の 3 層に分離され、各層が独自の Vitest 設定を持つ。ビルドは tsdown で 4 つの出力構成（CLI ESM、サーバー ESM、ライブラリ ESM、ライブラリ CJS）を並列生成し、postbuild スクリプトで非 TS 資産をコピーする 2 フェーズ構成を採用している。

## 背景にある原則

- **責務境界をパッケージマネージャのメカニズムで強制する**: npm workspaces により `src/app` と `site` はルートとは独立した依存関係を持ち、フロントエンド固有の依存がコアライブラリに流入しない。tsconfig.json の `exclude` で `src/app/**/*` をコアビルドから除外し、逆方向の依存も防いでいる。これにより、大規模プロジェクトでも依存関係のスコープが明確に制御される。

- **ビルド出力の多形性を単一構成ファイルで管理する**: `tsdown.config.ts` で CLI / サーバー / ライブラリ ESM / ライブラリ CJS の 4 構成を配列として定義し、各構成の `entry`・`format`・`external` を明示的に指定している。「何がどこに出力されるか」が 1 ファイルで把握でき、ビルド構成の散逸を防いでいる。

- **テスト層ごとに実行環境を最適化する**: unit / integration / smoke の 3 層それぞれに専用の `vitest.*.config.ts` を用意し、タイムアウト・ワーカー数・シャッフル戦略を層の特性に合わせて設定している。これにより、高速な unit テストと堅牢な integration テストを同じフレームワークで両立させている。

- **コアとフロントエンドの型共有はパスエイリアスで実現する**: `src/app` から `@promptfoo/*` エイリアスを通じてコアの型定義を直接 import している。型レベルの依存は許容しつつ、ランタイム依存はブラウザ互換のモジュール置換（`vite.config.ts` の `browserModulesPlugin`）で制御するという、2 層の依存管理戦略を取っている。

## 実例と分析

### ワークスペース構成と依存の方向制御

ルートの `package.json` で `"workspaces": ["src/app", "site"]` を宣言し、npm workspaces を有効化している。`pnpm-workspace.yaml` も同じ構成を持ち、npm / pnpm 双方に対応している。

コアライブラリの tsconfig.json は `src/app/**/*` を明示的に除外し、逆に `src/app/vite.config.ts` は `@promptfoo` エイリアスでコアの型を参照する。この非対称な依存関係は意図的であり、コアがフロントエンドを知らず、フロントエンドがコアの型を知るという一方向の依存フローを実現している。

```typescript
// src/app/vite.config.ts:101-104
resolve: {
  alias: {
    '@app': path.resolve(__dirname, './src'),
    '@promptfoo': path.resolve(__dirname, '../'),
  },
},
```

`knip.json` でもワークスペースごとにエントリポイントとプロジェクト範囲を個別定義し、未使用コード検出を正確に行っている。

```json
// knip.json:7-15
"workspaces": {
  "src/app": {
    "entry": ["src/index.tsx"],
    "project": ["src/**/*.{js,ts,tsx}"],
    "paths": {
      "@app/*": ["./src/*"],
      "@promptfoo/*": ["../../*"]
    }
  },
```

### ビルドの 4 構成分離と postbuild フェーズ

`tsdown.config.ts` は 4 つの構成を配列で定義している。

| 構成           | entry                              | format | 用途                            |
| -------------- | ---------------------------------- | ------ | ------------------------------- |
| サーバー       | `src/server/index.ts`              | ESM    | Docker / スタンドアロンサーバー |
| CLI            | `src/entrypoint.ts`, `src/main.ts` | ESM    | CLI バイナリ                    |
| ライブラリ ESM | `src/index.ts`                     | ESM    | ライブラリ利用（ESM）           |
| ライブラリ CJS | `src/index.ts`                     | CJS    | ライブラリ利用（CJS 互換）      |

全構成で `clean: false` を指定し、競合を避けている。代わりに明示的な `npm run build:clean` コマンドを用意する設計。

```typescript
// tsdown.config.ts:29
// All configs use clean: false. Use `npm run build:clean` for explicit cleaning.
// This prevents race conditions when multiple configs share the same outDir.
```

`postbuild` スクリプト（`scripts/postbuild.ts`）は tsdown が処理しない資産（HTML テンプレート、Python/Ruby/Go ラッパースクリプト、Drizzle マイグレーション、proto ファイル）をコピーし、必須出力の検証も行う。

```typescript
// scripts/postbuild.ts:50-57
const REQUIRED_BUILD_OUTPUTS = [
  "dist/src/entrypoint.js", // CLI entry (Node version check wrapper)
  "dist/src/main.js", // CLI main module
  "dist/src/index.js", // ESM library entry
  "dist/src/index.cjs", // CJS library entry
  "dist/src/server/index.js", // Server entry
];
```

### テスト 3 層構造

テストは 3 つの Vitest 設定で層別管理される。

| 層          | 設定ファイル                   | include パターン                                   | タイムアウト | シャッフル |
| ----------- | ------------------------------ | -------------------------------------------------- | ------------ | ---------- |
| Unit        | `vitest.config.ts`             | `test/**/*.test.ts` (`*.integration.test.ts` 除外) | 30s          | Yes        |
| Integration | `vitest.integration.config.ts` | `**/*.integration.test.ts`                         | 60s          | Yes        |
| Smoke       | `vitest.smoke.config.ts`       | `test/smoke/**/*.test.ts`                          | 30s          | No         |

全層で `pool: 'forks'` を使用し、メモリ分離を確保している。理由は明示的にコメントされている。

```typescript
// vitest.config.ts:28-31
// Use forks (child processes) instead of threads for better memory isolation.
// When a fork dies or is recycled, the OS fully reclaims its memory.
// Worker threads share memory with the main process and can leak.
pool: 'forks',
```

`test/` のディレクトリ構造は `src/` をミラーし、`test/providers/`、`test/redteam/`、`test/server/` のように対応する。`test/factories/` と `test/__fixtures__/` でテストデータ生成とフィクスチャを集約している。

### src 直下のモジュール構成

`src/` は 30 以上のサブディレクトリを持つが、明確な階層がある。

**インフラ層**: `database/`、`storage/`、`cache.ts`、`migrate.ts`、`logger.ts`
**コア層**: `evaluator.ts`、`assertions/`、`providers/`、`prompts/`、`models/`
**ドメイン層**: `redteam/`（197 ファイル）、`codeScan/`
**インターフェース層**: `commands/`（CLI）、`server/`（HTTP API）、`ui/`（Ink CLI）
**ユーティリティ**: `util/`（50+ ファイル）、`types/`、`constants/`

`src/providers/` は 196 ファイルで最大のサブディレクトリだが、`registry.ts` でファクトリパターンによりプロバイダの登録・解決を一元化している。

### ブラウザ互換のモジュール置換

`src/app` はコアライブラリの型を `@promptfoo/*` エイリアスで参照するが、ランタイム依存は Vite プラグインで制御している。Node.js 固有モジュール（`logger.ts`、`createHash.ts`）をブラウザ互換版に置換する。

```typescript
// src/app/vite.config.ts:20-33
const replacements: Array<{ nodePath: string; browserPath: string; patterns: string[]; }> = [
  {
    nodePath: path.resolve(__dirname, "../logger.ts"),
    browserPath: path.resolve(__dirname, "../logger.browser.ts"),
    patterns: ["./logger", "../logger", "/logger"],
  },
  {
    nodePath: path.resolve(__dirname, "../util/createHash.ts"),
    browserPath: path.resolve(__dirname, "../util/createHash.browser.ts"),
    patterns: ["./createHash", "../createHash", "/createHash"],
  },
];
```

### エントリポイントの 2 段階分離

CLI のエントリポイントは `entrypoint.ts` -> `main.ts` の 2 段階に分離されている。`entrypoint.ts` は意図的に依存を最小化し、Node.js バージョンチェックのみを行う。

```typescript
// src/entrypoint.ts:1-10
/**
 * Entry point for the promptfoo CLI.
 *
 * This file intentionally has NO dependencies to ensure the Node.js version
 * check runs before any module loading that might fail on older versions.
 */
```

### AGENTS.md による階層的 AI コンテキスト管理

各主要ディレクトリに `AGENTS.md` を配置し、AI エージェントへのコンテキストを階層的に提供している。ルートの `CLAUDE.md` は `@AGENTS.md` で AGENTS.md を参照する 1 行だけで、`AGENTS.md` にディレクトリテーブルと「そのディレクトリに入ったら対応する AGENTS.md を読め」という指示を記載している。

```markdown
<!-- AGENTS.md:24 -->

**Read the relevant AGENTS.md when working in that directory.**
```

## パターンカタログ

- **Abstract Factory** (生成)
  - 解決する問題: 100+ の LLM プロバイダを統一的に生成・管理する
  - 適用条件: 文字列識別子からインスタンスを生成するが、生成ロジックがプロバイダごとに異なる
  - コード例: `src/providers/registry.ts:127-134` の `ProviderFactory` インターフェースと `providerMap` 配列
  - 注意点: 配列ベースのレジストリは順序依存（先にマッチしたファクトリが優先）

- **Template Method** (振る舞い)
  - 解決する問題: Red team プラグインに共通の生成フローを持たせつつ、プラグイン固有のロジックを差し替え可能にする
  - 適用条件: 共通ワークフロー（生成 -> 検証 -> 出力）の一部ステップだけが異なる場合
  - コード例: `src/redteam/plugins/base.ts:33` の `RedteamPluginBase` 抽象クラス
  - 注意点: 継承階層が深くなりすぎないよう、`canGenerateRemote` のようなフラグで振る舞いを制御

- **Strategy** (振る舞い)
  - 解決する問題: Red team の攻撃戦略（crescendo, hydra, iterative 等）を差し替え可能にする
  - 適用条件: アルゴリズムの選択が実行時に決まり、戦略が独立して追加される場合
  - コード例: `src/redteam/strategies/` ディレクトリ（30+ の戦略実装）

## Good Patterns

- **非 TS 資産の postbuild コピーと必須出力検証**: ビルドツール（tsdown）が処理しない資産（Python ラッパー、マイグレーション SQL、HTML テンプレート）を postbuild スクリプトで確実にコピーし、さらに必須出力ファイルの存在を検証する。ビルドの「暗黙の成功」を防ぐ。

```typescript
// scripts/postbuild.ts:170-181
function verifyBuildOutputs(): string[] {
  const missing: string[] = [];
  for (const outputPath of REQUIRED_BUILD_OUTPUTS) {
    const fullPath = path.join(ROOT, outputPath);
    if (!fs.existsSync(fullPath)) {
      missing.push(outputPath);
    }
  }
  return missing;
}
```

- **テスト環境の一括セットアップとメモリリーク防止**: `vitest.setup.ts` でダミー API キー・環境変数・afterEach クリーンアップを集約し、全テストファイルに適用する。テストごとの独立性を setup ファイルレベルで保証する。

```typescript
// vitest.setup.ts:33-45
afterEach(() => {
  vi.clearAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});
```

- **ビルド時定数注入による環境分岐**: `tsdown.config.ts` の `define` で `BUILD_FORMAT`・バージョン・PostHog キーをビルド時に注入し、ランタイムの環境判定を排除する。ESM / CJS の分岐がビルド時に確定するため、バンドルサイズの最適化にも寄与する。

```typescript
// tsdown.config.ts:23-27
const versionDefines = {
  __PROMPTFOO_VERSION__: JSON.stringify(packageJson.version),
  __PROMPTFOO_POSTHOG_KEY__: JSON.stringify(process.env.PROMPTFOO_POSTHOG_KEY || ""),
  __PROMPTFOO_MIN_NODE_VERSION__: String(minNodeVersion),
};
```

## Anti-Patterns / 注意点

- **巨大レジストリファイル**: `src/providers/registry.ts` は 1,708 行あり、全プロバイダのインポートとファクトリ定義が集中している。新しいプロバイダの追加時に必ずこのファイルを変更する必要があり、マージコンフリクトの温床になりうる。

```typescript
// Bad: 1ファイルに100+のimportとファクトリ定義が集中
import { AI21ChatCompletionProvider } from "./ai21";
import { AlibabaChatCompletionProvider } from "./alibaba";
// ... 100+ lines of imports
export const providerMap: ProviderFactory[] = [
  // ... 1500+ lines of factory definitions
];
```

```typescript
// Better: プロバイダごとにファクトリを自己登録する分散レジストリ
// src/providers/ai21.ts
export const factory: ProviderFactory = {
  test: (path) => path.startsWith("ai21:"),
  create: async (path, options) => new AI21ChatCompletionProvider(path, options),
};
registerProvider(factory);
```

- **test ディレクトリ内の命名不統一**: `test/utils/` と `test/util/` が共存し、`test/__fixtures__/` と `test/fixtures/` も共存している。tsconfig.json の `exclude` で一部ディレクトリが除外されているが、新規参入者にとって混乱を招く。

## 導出ルール

- `[MUST]` ワークスペース間の依存は一方向にする -- フロントエンドがコアの型を参照してよいが、コアがフロントエンド固有の依存を取り込んではならない
  - 根拠: promptfoo は tsconfig の `exclude` と Vite のパスエイリアスで一方向依存を強制しており、これがコアの可搬性を担保している（`tsconfig.json:32`, `src/app/vite.config.ts:101-104`）

- `[MUST]` 複数のビルド出力構成を持つプロジェクトでは、各構成のエントリポイント・出力形式・外部化ルールを 1 つの設定ファイルで明示的に定義する
  - 根拠: `tsdown.config.ts` が 4 構成を配列で一括管理しており、「何がどこに出力されるか」の全体像が 1 ファイルで把握できる

- `[SHOULD]` テスト層（unit / integration / smoke）ごとに専用の設定ファイルを用意し、タイムアウト・並列度・シャッフル設定を層の特性に合わせて最適化する
  - 根拠: promptfoo は 3 つの `vitest.*.config.ts` で層別に設定を分離し、unit テストはランダム順序で高速実行、smoke テストは逐次実行と使い分けている

- `[SHOULD]` ビルド成果物の検証ステップを postbuild に含め、必須出力ファイルの欠落を検出する
  - 根拠: `scripts/postbuild.ts:170-181` で `REQUIRED_BUILD_OUTPUTS` を検証し、tsdown の部分的失敗を検知している

- `[SHOULD]` CLI のエントリポイントは最小依存で Node.js バージョンチェックを行い、メインモジュールの読み込みを遅延させる
  - 根拠: `src/entrypoint.ts` は意図的に依存を排除し、古い Node.js でのモジュール構文エラーの前にユーザーフレンドリーなエラーメッセージを表示する

- `[SHOULD]` モノリポ内でコアとフロントエンドが型を共有する場合、Node.js 固有モジュールにはブラウザ互換の代替実装を用意し、ビルドツールのモジュール置換で切り替える
  - 根拠: `src/app/vite.config.ts` の `browserModulesPlugin` が `logger.ts` と `createHash.ts` のブラウザ版を提供し、Node polyfill のバンドルを回避している

- `[AVOID]` 1 つのレジストリファイルに 100 以上のファクトリ定義を集中させる -- プロバイダや戦略が増加すると、マージコンフリクトと認知負荷が線形に増大する
  - 根拠: `src/providers/registry.ts` は 1,708 行に達しており、全プロバイダ追加がこのファイルの変更を要求する

## 適用チェックリスト

- [ ] ワークスペース構成で依存の方向を制御しているか（tsconfig の `exclude`、ビルドツールのエイリアス設定）
- [ ] ビルド出力が複数形式（ESM/CJS）ある場合、構成が 1 つの設定ファイルで一覧できるか
- [ ] テストの層（unit / integration / e2e）ごとに設定ファイルが分離され、タイムアウトや並列度が最適化されているか
- [ ] ビルド後に必須出力ファイルの存在を検証するステップがあるか
- [ ] CLI のエントリポイントがランタイムバージョンチェックを最小依存で行っているか
- [ ] フロントエンドとバックエンドで型を共有する場合、Node.js 固有モジュールのブラウザ代替が用意されているか
- [ ] 大規模なレジストリ/ファクトリファイルが肥大化していないか（500 行を超えたら分割を検討）
- [ ] テストディレクトリの構造がソースディレクトリをミラーしており、命名が統一されているか
