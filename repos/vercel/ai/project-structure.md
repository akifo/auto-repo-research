# project-structure

> リポジトリ: vercel/ai
> 分析日: 2026-02-20

## 概要

53 パッケージを擁する pnpm + Turborepo モノレポの分割戦略を分析した。このリポジトリは「インターフェース仕様」「共有ユーティリティ」「プロバイダー実装」「コア SDK」「フレームワークバインディング」という明確な依存層を持ち、30 以上の AI プロバイダーパッケージを同一構造で管理している。注目に値するのは、4 層アーキテクチャの厳格な依存方向制約、OpenAI Compatible という中間抽象層の導入、そしてビルド・テスト・リリース設定を `tools/` ディレクトリで共有設定パッケージとして一元管理する手法である。

## 背景にある原則

- **依存方向の一方通行制約**: 下位層（`@ai-sdk/provider`）は上位層を一切参照しない。すべてのプロバイダーは `@ai-sdk/provider` と `@ai-sdk/provider-utils` のみに依存し、コアパッケージ `ai` や他のプロバイダーに依存しない。これにより、任意のプロバイダーを単体でインストールでき、不要な依存の連鎖を断てる。`tsconfig.json` の `references` が依存グラフを正確に反映しており（`packages/provider/tsconfig.json:references` は空配列）、TypeScript の型チェックでも方向制約が保証される。

- **同一カテゴリのパッケージは同一構造にする**: 30 以上のプロバイダーパッケージが完全に同一の package.json 構造（scripts, exports, dependencies, devDependencies のパターン）を持つ。新規プロバイダー追加時のコストを最小化し、レビュー負荷を下げるため。

- **公開 API と内部 API の明示的分離**: パッケージの `exports` フィールドで `.`（公開）, `./internal`（パッケージ間共有）, `./test`（テスト用）を分離する。これにより、セマンティックバージョニングの対象を公開 API のみに限定でき、内部リファクタリングの自由度を確保する。

- **共有設定はワークスペース内パッケージとして配布する**: `tools/tsconfig`, `tools/eslint-config` を `private: true` のワークスペースパッケージとして管理し、各パッケージから `workspace:*` で参照する。npm で公開せずにモノレポ内で設定を一元管理できる。

## 実例と分析

### 4 層の依存グラフ

依存の流れは厳密に一方向である:

```
Layer 1: @ai-sdk/provider           （インターフェース仕様のみ、外部依存は json-schema のみ）
    ↑
Layer 2: @ai-sdk/provider-utils     （共有ユーティリティ、provider に依存）
    ↑
Layer 3: @ai-sdk/openai, @ai-sdk/anthropic, ...  （各プロバイダー、provider + provider-utils に依存）
    ↑
Layer 4: ai                          （コア SDK、provider + provider-utils + gateway に依存）
    ↑
Layer 5: @ai-sdk/react, @ai-sdk/vue, @ai-sdk/svelte  （フレームワーク、ai + provider-utils に依存）
```

`@ai-sdk/provider` パッケージの `tsconfig.json` の references は空配列であり、最下層であることが型レベルでも保証されている（`packages/provider/tsconfig.json:15`）。

### OpenAI Compatible 中間抽象層

OpenAI 互換 API を持つプロバイダー（xAI, Fireworks, DeepInfra, Cerebras 等 10 パッケージ）は `@ai-sdk/openai-compatible` を中間層として利用する。Fireworks の実装を見ると、`OpenAICompatibleChatLanguageModel` 等のクラスを直接インポートして使っている:

```typescript
// packages/fireworks/src/fireworks-provider.ts:1-6
import {
  OpenAICompatibleChatLanguageModel,
  OpenAICompatibleCompletionLanguageModel,
  OpenAICompatibleEmbeddingModel,
  ProviderErrorStructure,
} from "@ai-sdk/openai-compatible";
```

一方、OpenAI 自体や Anthropic のような独自 API を持つプロバイダーは `@ai-sdk/provider` + `@ai-sdk/provider-utils` のみに依存し、自前でモデルクラスを実装する。これにより「互換プロバイダーの追加は薄いラッパーで済む」一方で「独自 API プロバイダーの柔軟性は損なわない」二段構え構造になっている。

### 共有設定パッケージ `tools/`

`tools/` ディレクトリには公開しない内部専用パッケージが 4 つある:

| パッケージ                | 目的                                                                          |
| ------------------------- | ----------------------------------------------------------------------------- |
| `@vercel/ai-tsconfig`     | TypeScript 設定の基盤（`base.json`, `ts-library.json`, `react-library.json`） |
| `eslint-config-vercel-ai` | ESLint 共有設定                                                               |
| `analyze-downloads`       | ダウンロード分析スクリプト                                                    |
| `generate-llms-txt`       | LLM 向けテキスト生成                                                          |

各パッケージの `tsconfig.json` は `@vercel/ai-tsconfig` を extends する:

```json
// packages/openai/tsconfig.json:2
{
  "extends": "./node_modules/@vercel/ai-tsconfig/ts-library.json"
}
```

tsconfig の 3 種類の分類（`base.json` → `ts-library.json` / `react-library.json`）はパッケージの性質に応じたプリセットとして機能する。

### tsconfig.build.json パターン

すべてのパッケージで `tsconfig.json`（開発用、`composite: true`）と `tsconfig.build.json`（ビルド用、`composite: false`）を分離している:

```json
// packages/openai/tsconfig.build.json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "composite": false
  }
}
```

`composite: true` は TypeScript のプロジェクト参照（`tsc --build`）に必要だが、tsup によるバンドルビルドでは不要。tsup の `--tsconfig tsconfig.build.json` 指定でこれを使い分ける。

### テストユーティリティの `./test` サブパスエクスポート

`ai` と `@ai-sdk/provider-utils` の 2 パッケージだけが `./test` サブパスをエクスポートする:

```typescript
// packages/ai/test/index.ts:1-14
export {
  convertArrayToAsyncIterable,
  convertArrayToReadableStream,
  // ...
} from "@ai-sdk/provider-utils/test";
export { MockLanguageModelV3 } from "../src/test/mock-language-model-v3";
export { MockProviderV3 } from "../src/test/mock-provider-v3";
```

テストユーティリティを本体の公開 API から分離しつつ、`ai/test` として利用可能にする。`test.d.ts` ファイル（`export * from './dist/test'`）がトップレベルのエイリアスとして機能する。

### バージョン注入パターン

各パッケージは `version.ts` ファイルでビルド時に注入されたバージョン文字列をエクスポートする:

```typescript
// packages/openai/src/version.ts
declare const __PACKAGE_VERSION__: string | undefined;
export const VERSION: string = typeof __PACKAGE_VERSION__ !== "undefined"
  ? __PACKAGE_VERSION__
  : "0.0.0-test";
```

tsup の `define` オプションで `__PACKAGE_VERSION__` を `package.json` のバージョンに置換する（`packages/ai/tsup.config.ts:14-17`）。これにより、ランタイムで `package.json` を読み込むことなく User-Agent ヘッダーにバージョンを含められる。

### prepack/postpack によるドキュメント同梱

プロバイダーパッケージは `prepack` で `content/` ディレクトリからドキュメントをコピーし、`postpack` で削除する:

```json
// packages/openai/package.json:29-30
"prepack": "mkdir -p docs && cp ../../content/providers/01-ai-sdk-providers/03-openai.mdx ./docs/",
"postpack": "del-cli docs"
```

ドキュメントのソースオブトゥルースを `content/` ディレクトリに一元管理しながら、npm パッケージにも同梱する戦略。

### examples/ の Changesets 除外

examples は pnpm ワークスペースに含まれるが、Changesets によるバージョン管理からは除外する専用スクリプトがある（`.github/scripts/cleanup-examples-changesets.mjs`）。`changeset version` 実行後に例アプリの version を `0.0.0` にリセットし、CHANGELOG を削除する。

## パターンカタログ

- **Layered Architecture** (分類: アーキテクチャ)
  - 解決する問題: 50 以上のパッケージ間の依存関係の複雑化
  - 適用条件: パッケージ間に明確な抽象度の差がある場合
  - コード例: `packages/provider/tsconfig.json:15` (references: [])、`packages/openai/package.json:46-48` (provider + provider-utils のみ依存)
  - 注意点: 層を跨ぐ依存が入ると全体が崩壊するため、CI での依存方向チェックが望ましい

- **Adapter** (分類: 構造)
  - 解決する問題: OpenAI 互換 API を持つ多数のプロバイダーのコード重複
  - 適用条件: 同じインターフェースの異なる実装が複数あり、共通部分が大きい場合
  - コード例: `packages/fireworks/src/fireworks-provider.ts:1-6` (OpenAICompatible 利用)
  - 注意点: 中間抽象層が肥大化すると独自拡張が困難になる

- **Abstract Factory** (分類: 生成)
  - 解決する問題: プロバイダーごとに異なるモデル群の統一的な生成
  - 適用条件: 関連するオブジェクト群を一貫したインターフェースで生成する必要がある場合
  - コード例: `packages/xai/src/xai-provider.ts:101-174` (createXai 関数)
  - 注意点: ProviderV3 インターフェースが全プロバイダーの共通形状を規定

## Good Patterns

- **ワークスペースパッケージとしての共有設定**: `tools/tsconfig` を `@vercel/ai-tsconfig` として各パッケージから `workspace:*` で参照する。設定ファイルのコピペではなく、パッケージマネージャの依存解決で一元管理する。

```json
// packages/openai/tsconfig.json
{
  "extends": "./node_modules/@vercel/ai-tsconfig/ts-library.json"
}
// packages/react/tsconfig.json では react-library.json を extends する
```

- **サブパスエクスポートによる API 境界の制御**: `exports` フィールドで `.`, `./internal`, `./test` を分離し、テストユーティリティや内部 API の公開範囲を制御する。

```json
// packages/ai/package.json:43-61
"exports": {
  ".": { "types": "./dist/index.d.ts", "import": "./dist/index.mjs" },
  "./internal": { "types": "./dist/internal/index.d.ts", "import": "./dist/internal/index.mjs" },
  "./test": { "types": "./dist/test/index.d.ts", "import": "./dist/test/index.mjs" }
}
```

- **ビルド時バージョン注入**: `version.ts` + tsup の `define` で、ランタイムに package.json を読まずにバージョン文字列を取得する。テスト環境ではフォールバック値 `'0.0.0-test'` が使われる。

```typescript
// packages/provider-utils/src/version.ts:1-6
declare const __PACKAGE_VERSION__: string | undefined;
export const VERSION: string = typeof __PACKAGE_VERSION__ !== "undefined"
  ? __PACKAGE_VERSION__
  : "0.0.0-test";
```

## Anti-Patterns / 注意点

- **中間抽象層への暗黙的な結合**: `@ai-sdk/openai-compatible` を使うプロバイダーは、OpenAI API の仕様変更に間接的に影響を受ける。中間層のインターフェースを安定させないと、一つの変更が 10 パッケージに波及する。

```typescript
// Bad: 中間層の内部実装に直接依存する
import { OpenAICompatibleChatLanguageModel } from "@ai-sdk/openai-compatible";
// この具象クラスの constructor シグネチャが変わると全プロバイダーが壊れる

// Better: 中間層は安定したインターフェース（ProviderV3）のみを contract とし、
// 実装クラスの変更が利用側に波及しないようにする
```

- **pnpm-workspace.yaml での過剰なパス指定**: `packages/rsc/tests/e2e/next-server` のようにテスト用の Next.js アプリが個別にワークスペースメンバーに追加されている。ワークスペースのフラットな `packages/*` パターンが崩れ、見通しが悪くなる。

```yaml
# pnpm-workspace.yaml
packages:
  - 'packages/*'
  - 'tools/*'
  - 'examples/*'
  - 'packages/rsc/tests/e2e/next-server'  # 例外的追加
```

## 導出ルール

- `[MUST]` モノレポのパッケージ間依存は DAG（有向非巡回グラフ）とし、tsconfig の references や package.json の dependencies で方向制約を表現する
  - 根拠: vercel/ai では `@ai-sdk/provider` の tsconfig references が空配列、プロバイダー群は provider + provider-utils のみに依存し、循環を型レベルで防止している

- `[MUST]` 同一カテゴリのパッケージ（プロバイダー等）は scripts, exports, dependencies のパターンを統一する
  - 根拠: 30 以上のプロバイダーが同一の package.json 構造（build, test, clean, lint スクリプト）を持ち、新規追加のテンプレート化とレビュー効率化を実現している

- `[SHOULD]` モノレポ内の共有設定（tsconfig, eslint）は private ワークスペースパッケージとして配布し、各パッケージから `workspace:*` で参照する
  - 根拠: `tools/tsconfig` の `@vercel/ai-tsconfig` が 3 つのプリセット（base, ts-library, react-library）を提供し、50 以上のパッケージが extends で参照している

- `[SHOULD]` パッケージの公開 API、内部 API、テストユーティリティは `exports` フィールドのサブパス（`.`, `./internal`, `./test`）で分離する
  - 根拠: `ai` パッケージが 3 つのエクスポートパスを持ち、セマンティックバージョニングの対象を公開 API に限定しつつ、パッケージ間の内部共有を可能にしている

- `[SHOULD]` パッケージバージョンはビルド時に `define` で注入し、ランタイムで package.json を読み込まない
  - 根拠: 全プロバイダーの `version.ts` が `__PACKAGE_VERSION__` を宣言し、tsup の define オプションで置換される。User-Agent ヘッダー生成等で使用

- `[SHOULD]` 共通パターンを持つ実装群（OpenAI 互換プロバイダー等）には中間抽象パッケージを設け、薄いラッパーで新規実装を追加できるようにする
  - 根拠: `@ai-sdk/openai-compatible` を使う 10 プロバイダーは、モデルクラスを自前実装する必要がなく、設定とエラー定義のみで済む

- `[AVOID]` ワークスペースの glob パターン（`packages/*`）に個別パスの例外を追加すること — ディレクトリ構成の見通しが悪化する
  - 根拠: `pnpm-workspace.yaml` で `packages/rsc/tests/e2e/next-server` が例外的に追加されており、ワークスペース構成の一貫性が崩れている

## 適用チェックリスト

- [ ] モノレポ内のパッケージ間依存が DAG になっているか（循環依存がないか）を確認する
- [ ] 同一カテゴリのパッケージ群が同一の package.json テンプレートに従っているか確認する
- [ ] 共有設定（tsconfig, eslint, prettier）が private ワークスペースパッケージとして管理されているか確認する
- [ ] 各パッケージの `exports` フィールドで公開 API と内部 API が分離されているか確認する
- [ ] tsconfig の `references` がパッケージの実際の依存グラフと一致しているか確認する
- [ ] tsconfig.json（開発用、composite: true）と tsconfig.build.json（ビルド用、composite: false）が分離されているか確認する
- [ ] パッケージバージョンがランタイムで必要な場合、ビルド時注入パターンを使っているか確認する
- [ ] 共通パターンを持つ実装群に中間抽象パッケージの導入余地がないか検討する
