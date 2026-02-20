# code-organization

> リポジトリ: langchain-ai/langchainjs
> 分析日: 2026-02-20

## 概要

langchainjs は pnpm ワークスペース + Turborepo で管理される大規模 TypeScript モノレポであり、コアパッケージ (`@langchain/core`)、オーケストレーション (`langchain`)、30+ のプロバイダー統合パッケージ (`@langchain/openai` 等) から構成される。モジュール分割はドメイン概念単位で行われ、package.json `exports` フィールドによる細粒度サブパスエクスポートを徹底することで、ツリーシェイキングと API 表面の制御を両立させている。ファイル命名は一貫して snake_case を採用し、default export を完全排除して named export のみで統一している。

## 背景にある原則

- **ドメイン概念によるモジュール境界**: 技術レイヤー (controller/service/repo) ではなく、ドメイン概念 (messages, runnables, tools, callbacks) ごとにディレクトリとエクスポートを切る。1 つのドメイン概念が 1 つのサブパスエクスポートに対応し、利用者は必要な概念だけをインポートできる。`@langchain/core/messages`, `@langchain/core/runnables` 等の粒度がこの原則を体現している (`libs/langchain-core/package.json` exports フィールド)。

- **循環依存の構造的排除**: 全パッケージで `dpdm` による循環依存チェックを CI の lint ステップに組み込んでいる (`lint:dpdm` スクリプト)。型定義を `types.ts` に分離し、実装ファイル (`index.ts`) が型ファイルを参照する一方向の依存を保つことで、大規模コードベースでも循環参照を防止している。

- **コアと統合の疎結合**: コアパッケージ (`@langchain/core`) は抽象基底クラスとインターフェースのみを提供し、各プロバイダーパッケージは `peerDependencies` でコアに依存する。新しいプロバイダーはスタンドアロンパッケージとして作成でき (`create-langchain-integration` テンプレート)、コアを変更せずにエコシステムを拡張できる。

- **Dual Format (CJS/ESM) の一元管理**: `@langchain/build` パッケージが `tsdown` の設定を標準化し、全パッケージで統一された CJS/ESM デュアル出力を生成する。各パッケージの `tsdown.config.ts` は最小限の設定 (エントリポイントの列挙) に留まり、ビルド設定の重複を排除している。

## 実例と分析

### サブパスエクスポートによる API 表面制御

`@langchain/core` は 50 以上のサブパスエクスポートを `package.json` の `exports` フィールドで定義している。各エクスポートは `input` (ソース), `require` (CJS), `import` (ESM) の 3 形式を持つ。

コアの `index.ts` は `export {}` のみを含み、ルートからの全量インポートを意図的に不可能にしている。利用者は必ず `@langchain/core/messages` や `@langchain/core/runnables` のようなサブパス経由でインポートする必要がある。

一方、プロバイダーパッケージ (`@langchain/openai`, `@langchain/anthropic`) は単一の `./src/index.ts` をエントリポイントとし、全エクスポートをバレルファイルで集約している。パッケージ規模が小さいため、細粒度サブパスの必要性がない。

### ディレクトリ内部のファイル分割パターン

コアの各ドメインディレクトリは一貫した内部構造を持つ:

- `index.ts` — バレルファイル (再エクスポートのみ)
- `base.ts` — 抽象基底クラス
- `types.ts` — 型定義 (interface, type alias)
- `utils.ts` — ユーティリティ関数
- `tests/` — テストファイル

例えば `tools/` ディレクトリは `index.ts` (バレル + 実装), `types.ts` (型定義), `utils.ts` (ヘルパー関数) の 3 ファイルで構成される。`runnables/` はより細かく `base.ts`, `config.ts`, `branch.ts`, `passthrough.ts`, `router.ts`, `history.ts` 等に機能単位で分割されている。

### index.ts の 2 つの使い方

コードベース横断で `index.ts` に 2 つの役割が見られる:

1. **純粋バレル型**: `export * from "./xxx.js"` のみで構成 (例: `messages/index.ts`, `prompts/index.ts`, `documents/index.ts`)
2. **選択的再エクスポート型**: `export { A, B } from "./xxx.js"` で公開 API を明示的に選別 (例: `runnables/index.ts`, `tools/index.ts`)

`runnables/index.ts` は `export { ... } from "./base.js"` で個別シンボルを列挙しており、内部ユーティリティ (`_RootEventFilter`, `_coerceToRunnable` の `_` プレフィックス付き) は一部のみ再エクスポートしている。

### プロバイダーパッケージの統一構成

`create-langchain-integration` テンプレートが標準構成を定義している:

```
src/
  index.ts          # バレルファイル
  chat_models.ts    # BaseChatModel を継承
  llms.ts           # BaseLLM を継承
  embeddings.ts     # Embeddings を継承
  vectorstores.ts   # VectorStore を継承
  tests/
```

実際のプロバイダーパッケージもこのパターンに従っている。例えば `@langchain/anthropic` は `chat_models.ts`, `types.ts`, `tools/`, `utils/` を持ち、`@langchain/openai` はさらに `chat_models/` ディレクトリで completions/responses の API 差異を吸収している。

## コード例

```typescript
// libs/langchain-core/src/index.ts:1
export {};
```

ルートエクスポートを空にし、サブパスインポートを強制する。

```typescript
// libs/langchain-core/src/runnables/index.ts:1-20
export {
  _coerceToRunnable,
  Runnable,
  RunnableAssign,
  RunnableBinding,
  type RunnableBindingArgs,
  RunnableEach,
  type RunnableFunc,
  RunnableLambda,
  type RunnableLike,
  RunnableMap,
  RunnableParallel,
  RunnablePick,
  RunnableRetry,
  type RunnableRetryFailedAttemptHandler,
  RunnableSequence,
  RunnableToolLike,
  type RunnableToolLikeArgs,
  RunnableWithFallbacks,
} from "./base.js";
```

選択的再エクスポートで公開 API を明示的に制御している。

```typescript
// libs/langchain-core/src/tools/types.ts:1-28 (一部)
import type { z as z3 } from "zod/v3";
import { CallbackManagerForToolRun } from "../callbacks/manager.js";
import type { BaseLangChainParams, ToolDefinition } from "../language_models/base.js";
// ...
export type ResponseFormat = "content" | "content_and_artifact" | string;
export type ToolOutputType = any;
```

型定義を `types.ts` に分離し、`index.ts` が `export type { ... } from "./types.js"` で再エクスポートする。

```typescript
// libs/langchain-core/package.json (lint:dpdm)
"lint:dpdm": "dpdm --skip-dynamic-imports circular --exit-code circular:1 --no-warning --no-tree src/*.ts src/**/*.ts --exclude \"(node_modules|src/utils/zod-to-json-schema)\" --transform",
```

循環依存を CI で検出するスクリプト。

```typescript
// libs/providers/langchain-anthropic/src/chat_models.ts:5-21 (imports)
import { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import { getEnvironmentVariable } from "@langchain/core/utils/env";
```

プロバイダーからコアへの import は必ずサブパス (`@langchain/core/messages`) 経由で行う。

## パターンカタログ

- **Facade パターン** (構造)
  - 解決する問題: 大量の内部モジュールを利用者に直接公開すると API が複雑になる
  - 適用条件: サブパスエクスポートごとに `index.ts` が facade として機能し、内部ファイルの構成変更から利用者を保護する
  - コード例: `libs/langchain-core/src/runnables/index.ts`
  - 注意点: 全再エクスポート (`export *`) を使うと facade の制御が効かなくなるため、大きなモジュールでは選択的エクスポートが推奨される

- **Template Method パターン** (振る舞い)
  - 解決する問題: プロバイダーごとに異なる API 呼び出しを統一的なインターフェースで扱いたい
  - 適用条件: `BaseChatModel` が `invoke`, `stream`, `batch` のパブリック API を提供し、サブクラスは `_generate`, `_streamResponseChunks` のみを実装する
  - コード例: `libs/langchain-core/src/language_models/chat_models.ts:207-280`
  - 注意点: `_` プレフィックス付きメソッドが内部 API であることを命名で表現している

- **Strategy パターン** (振る舞い)
  - 解決する問題: OpenAI の Completions API と Responses API を動的に切り替えたい
  - 適用条件: `ChatOpenAI` クラスが `ChatOpenAICompletions` と `ChatOpenAIResponses` を内部に持ち、`_useResponsesApi()` の判定で委譲先を切り替える
  - コード例: `libs/providers/langchain-openai/src/chat_models/index.ts:592-706`

## Good Patterns

- **空ルートエクスポートによるサブパス強制**: `@langchain/core` のルート `index.ts` を `export {}` にすることで、利用者に必ずサブパスインポートを使わせる。これによりバンドルサイズを最小化し、API の発見性も向上させている。

```typescript
// libs/langchain-core/src/index.ts
export {};
```

利用者は `import { Runnable } from "@langchain/core/runnables"` のように具体的なサブパスを指定する。

- **型定義の types.ts 分離**: 実装ファイルと型定義ファイルを分離し、`index.ts` で型を再エクスポートする。これにより型定義が循環依存の原因になることを防ぎ、型のみが必要な場面 (`import type`) でも安全にインポートできる。

```typescript
// libs/langchain-core/src/tools/index.ts:63-86
export type {
  BaseDynamicToolInput,
  ContentAndArtifact,
  DynamicToolInput,
  // ...
} from "./types.js";

export {
  isLangChainTool,
  isRunnableToolLike,
  isStructuredTool,
  isStructuredToolParams,
  type ToolRuntime,
} from "./types.js";
```

- **ビルド設定の集約 (`@langchain/build`)**: 30+ パッケージのビルド設定を単一の内部パッケージに集約。各パッケージの `tsdown.config.ts` はエントリポイントの列挙だけで、CJS/ESM デュアル出力、型生成、バリデーションは自動的に適用される。

```typescript
// libs/providers/langchain-anthropic/tsdown.config.ts
import { cjsCompatPlugin, getBuildConfig } from "@langchain/build";

export default getBuildConfig({
  entry: ["./src/index.ts"],
  plugins: [
    cjsCompatPlugin({
      files: ["dist/", "CHANGELOG.md", "README.md", "LICENSE"],
    }),
  ],
});
```

## Anti-Patterns / 注意点

- **`export *` の過剰使用**: `messages/index.ts` は 14 個の `export * from "..."` で構成されており、内部ファイルの追加エクスポートが意図せず公開 API に漏れるリスクがある。同リポ内でも `runnables/index.ts` は選択的エクスポートを使っており、方針が混在している。

```typescript
// Bad: messages/index.ts — 内部シンボルが漏れるリスク
export * from "./ai.js";
export * from "./base.js";
export * from "./chat.js";
// ... 14 ファイル分の全量再エクスポート

// Better: runnables/index.ts — 公開 API を明示的に列挙
export {
  Runnable,
  type RunnableFunc,
  RunnableLambda,
  RunnableSequence,
  // ...
} from "./base.js";
```

- **lc_namespace の命名ゆれ**: シリアライズに使われる `lc_namespace` の値が `"langchain"` と `"langchain_core"` で統一されていない。`prompts` は `["langchain_core", "prompts", ...]` だが、`chat_models` は `["langchain", "chat_models", ...]` となっている。新規プロジェクトでは名前空間文字列を定数化すべき。

```typescript
// Bad: 名前空間の表記がファイルによって異なる
lc_namespace = ["langchain_core", "prompts", "chat"]; // prompts/chat.ts
lc_namespace = ["langchain", "chat_models", this._llmType()]; // language_models/chat_models.ts

// Better: 名前空間プレフィックスを定数化する
const LC_NAMESPACE_CORE = "langchain_core";
lc_namespace = [LC_NAMESPACE_CORE, "prompts", "chat"];
```

## 導出ルール

- `[MUST]` パッケージのルート `index.ts` で公開 API を明示的に制御し、内部実装の詳細が外部に漏れないようにする
  - 根拠: langchainjs は `runnables/index.ts` で選択的再エクスポートを行い、`_` プレフィックス付きの内部関数を意図的に隠蔽している。`messages/index.ts` の `export *` は方針違反であり、API 表面の意図しない拡大リスクを持つ

- `[MUST]` モノレポ内の共通ビルド設定は専用の内部パッケージに集約し、各パッケージの設定ファイルにはパッケージ固有の差分のみを記述する
  - 根拠: `@langchain/build` が 30+ パッケージの CJS/ESM デュアル出力・型生成・バリデーション設定を一元管理しており、設定のドリフトを防止している

- `[SHOULD]` 大規模パッケージではルートエクスポートを空にし、サブパスエクスポートを強制することでバンドルサイズを制御する
  - 根拠: `@langchain/core` の `index.ts` は `export {}` のみで、50+ のサブパスエクスポートにより利用者は必要な機能だけをインポートする

- `[SHOULD]` 型定義 (`interface`, `type`) を `types.ts` に分離し、実装ファイルから型ファイルへの一方向依存を維持して循環依存を構造的に防ぐ
  - 根拠: `tools/types.ts` と `tools/index.ts` の分離パターンがコアパッケージ全体で適用され、`dpdm` による循環依存チェック (CI lint) と組み合わせて運用されている

- `[SHOULD]` プロバイダー統合パッケージは標準的なディレクトリ構成テンプレートに従い、コアパッケージには `peerDependencies` で依存する
  - 根拠: `create-langchain-integration` テンプレートが `chat_models.ts`, `llms.ts`, `embeddings.ts` の標準構成を定義し、30+ のプロバイダーパッケージがこの構成に従っている

- `[AVOID]` `export *` をバレルファイルで多用し、内部シンボルが公開 API に漏れる状態を作ること
  - 根拠: `messages/index.ts` の 14 個の `export *` は、個々のファイルに新しいエクスポートを追加するだけで公開 API が暗黙的に拡大するリスクを持つ。`runnables/index.ts` のような選択的エクスポートの方が安全

- `[AVOID]` 循環依存チェックを手動レビューのみに頼ること。`dpdm` や `madge` 等のツールを lint ステップに組み込み、CI で自動検出すべき
  - 根拠: langchainjs は全パッケージの `lint` スクリプトに `dpdm` を統合しており、循環依存が発生した時点で CI が失敗する仕組みを持つ

## 適用チェックリスト

- [ ] パッケージの `exports` フィールドを定義し、公開するサブパスを明示的に列挙しているか
- [ ] バレルファイル (`index.ts`) で `export *` を使っている場合、内部シンボルの漏洩リスクを評価したか
- [ ] 型定義 (`interface`, `type`) を専用ファイル (`types.ts`) に分離し、実装ファイルとの間に循環依存がないか
- [ ] 循環依存チェックツール (`dpdm`, `madge` 等) を CI の lint ステップに組み込んでいるか
- [ ] モノレポの場合、ビルド設定の共通部分を内部パッケージに集約し、パッケージごとの設定差分を最小化しているか
- [ ] プラグイン/プロバイダーパッケージの標準構成をテンプレートとして定義し、新規パッケージの足場を自動生成できるか
- [ ] ルートエクスポートの粒度がパッケージの規模に適しているか (大規模ならサブパス分割、小規模ならバレル集約)
