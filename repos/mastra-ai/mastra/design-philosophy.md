# Design Philosophy

> リポジトリ: mastra-ai/mastra
> 分析日: 2026-02-14

## 概要

Mastra は AI エージェントフレームワークとして、「モジュラー構成」「プラガブルなバックエンド」「中央オーケストレーション」という設計哲学を持つ。Gatsby チーム出身の開発者が構築しており、大規模フレームワーク開発の経験が随所に反映されている。特に注目すべきは、AI SDK のバージョン差異を内部で吸収するベンダリング戦略、ストレージのドメイン分割による合成可能な永続化、そしてすべてのコンポーネントを静的にも動的にも構成可能にする `DynamicArgument` パターンである。

## 背景にある原則

- **コアを薄く保ち、統合は外部パッケージに委譲すべき**: Mastra の `packages/core` は抽象インターフェースとオーケストレーションロジックに徹し、具体的なストレージ実装（22 種類）、サーバーアダプタ（4 種類）、デプロイヤ（4 種類）は独立パッケージとして分離されている。これにより、コアの変更がエコシステム全体に波及するリスクを最小化し、利用者は必要なアダプタだけを依存に追加できる。根拠: `stores/`, `server-adapters/`, `deployers/` がすべて独立パッケージとして存在する構造 (`packages/core/src/storage/base.ts`, `packages/core/src/server/base.ts`)

- **オプショナルな機能は NoOp 実装をデフォルトにすべき**: コンポーネントが未設定の場合、例外を投げるのではなく NoOp（何もしない）実装を差し込む。これにより、利用者は必要な機能だけを段階的に追加でき、最小構成でも動作する。根拠: `NoOpObservability` クラス (`packages/core/src/observability/no-op.ts`), `noopLogger` (`packages/core/src/mastra/index.ts:543`)

- **外部依存の変動を内部で吸収し、ユーザー API を安定させるべき**: Mastra は AI SDK の v4/v5/v6 を `@internal/ai-sdk-v4`, `@internal/ai-sdk-v5`, `@internal/ai-v6` としてベンダリングし、コア内部でバージョン差異を吸収している。ユーザーは `"openai/gpt-5"` のような magic string でモデルを指定するだけでよく、裏のプロバイダ実装の違いを意識する必要がない。根拠: `packages/_vendored/` ディレクトリと `ModelRouterLanguageModel` (`packages/core/src/llm/model/router.ts`)

- **設定は静的値でも動的関数でも受け付けるべき**: `DynamicArgument<T>` 型によって、あらゆる設定項目を「値そのもの」または「リクエストコンテキストを受け取って値を返す関数」のどちらでも指定可能にしている。マルチテナント環境でリクエストごとにモデルやツールを切り替える場面を想定した設計判断。根拠: `packages/core/src/types/dynamic-argument.ts`

## 実例と分析

### 1. 中央 DI ハブとしての Mastra クラス

Mastra クラスは Service Locator パターンを採用し、すべてのコンポーネント（Agent, Workflow, Tool, Storage, Vector, Memory, MCP Server 等）を一元的に管理する。コンストラクタ内でコンポーネントの登録順序を制御し（Tools/Processors → Memory → Vectors → Scorers → Workflows → MCP Servers → Agents の順）、依存関係の循環を防いでいる。

各コンポーネントの登録時には `__registerMastra()` と `__registerPrimitives()` を呼び出し、ロガーやストレージなどの共有リソースを注入する。この「登録時の自動注入」パターンにより、コンポーネント自体は Mastra への直接依存を持たずに済む。

```typescript
// packages/core/src/mastra/index.ts:866-875
mastraAgent.__setLogger(this.#logger);
mastraAgent.__registerMastra(this);
mastraAgent.__registerPrimitives({
  logger: this.getLogger(),
  storage: this.getStorage(),
  agents: agents,
  tts: this.#tts,
  vectors: this.#vectors,
});
```

`setLogger()` メソッドが全登録コンポーネントに対してロガーを再配布する実装も特徴的で、ランタイムでの構成変更を可能にしている (`packages/core/src/mastra/index.ts:2337-2393`)。

### 2. ドメイン分割による合成可能なストレージ

ストレージは単一の抽象クラスではなく、「ドメイン」単位（memory, workflows, scores, observability, agents, datasets 等）に分割されている。`MastraCompositeStore` は複数のストレージバックエンドからドメインごとに異なる実装を合成できる。

```typescript
// packages/core/src/storage/base.ts:152-165
// Composition: mix domains from different stores
const storage = new MastraCompositeStore({
  id: "composite",
  default: pgStore,
  domains: {
    memory: libsqlStore.stores?.memory,
  },
});
```

さらに `augmentWithInit()` は Proxy を使って遅延初期化を実現し、初回アクセス時に自動的にテーブル作成やマイグレーションを実行する (`packages/core/src/storage/storageWithInit.ts`)。`disableInit` オプションにより CI/CD ではマイグレーションを明示的に制御可能。

### 3. ベンダリングによるバージョン吸収戦略

AI SDK の v4/v5/v6 を `packages/_vendored/` に格納し、`@internal/ai-sdk-v4` 等の workspace パッケージとして参照している。これにより、ユーザーの `node_modules` に複数バージョンの AI SDK が混在する問題を回避し、内部ではバージョン間の差異を `AISDKV5LanguageModel`, `AISDKV6LanguageModel` といったアダプタクラスで吸収している。

```typescript
// packages/core/src/llm/model/router.ts:17-22
function isLanguageModelV3(model: GatewayLanguageModel): model is LanguageModelV3 {
  return model.specificationVersion === "v3";
}
```

`ModelRouterLanguageModel` は `"openai/gpt-4o"` のような magic string からプロバイダとモデルを自動解決し、ゲートウェイ経由で適切な API エンドポイントに接続する。カスタムゲートウェイの追加もサポートしている。

### 4. Processor パイプラインによる拡張可能なメッセージ処理

Agent のメッセージ処理は、`Processor` インターフェースによる多段パイプラインとして設計されている。5 つのフック（`processInput`, `processInputStep`, `processOutputStream`, `processOutputStep`, `processOutputResult`）を持ち、入力の前処理からストリーム中の変換、出力後の検証まで、あらゆる段階に介入できる。

```typescript
// packages/core/src/processors/index.ts:239-254
export interface Processor<TId extends string = string, TTripwireMetadata = unknown> {
  readonly id: TId;
  processInput?(args: ProcessInputArgs<TTripwireMetadata>): Promise<ProcessInputResult> | ProcessInputResult;
  processOutputStream?(args: ProcessOutputStreamArgs<TTripwireMetadata>): Promise<ChunkType | null | undefined>;
  processOutputResult?(args: ProcessOutputResultArgs<TTripwireMetadata>): ProcessorMessageResult;
  processInputStep?(args: ProcessInputStepArgs<TTripwireMetadata>): /* ... */;
  processOutputStep?(args: ProcessOutputStepArgs<TTripwireMetadata>): ProcessorMessageResult;
}
```

Processor は Workflow としても実装可能（`ProcessorWorkflow` 型）で、複雑な処理ロジックをワークフローのステップとして定義できる。`TripWire` メカニズムにより、プロセッサがリトライ付きで処理を中断する機能も備える。

### 5. 外部フレームワークとの相互運用

AI SDK v6 の `ToolLoopAgent` を Mastra の `Agent` に変換する `toolLoopAgentToMastraAgent()` 関数は、異なるフレームワーク間のブリッジを提供する。変換時に `ToolLoopAgentProcessor` を input processor として注入し、AI SDK 固有の設定を Mastra のパイプラインに統合する。

```typescript
// packages/core/src/tool-loop-agent/index.ts:36-47
export function toolLoopAgentToMastraAgent(agent: ToolLoopAgentLike, options?: { fallbackName?: string; }) {
  const processor = new ToolLoopAgentProcessor(agent);
  const agentConfig = processor.getAgentConfig();
  const id = agentConfig.id || options?.fallbackName || `tool-loop-agent-${generateId()}`;
  return new Agent({
    ...agentConfig,
    id,
    name: agentConfig.name || id,
    inputProcessors: [processor],
  });
}
```

## パターンカタログ

- **Service Locator** (構造)
  - 解決する問題: 多数のコンポーネント間での依存関係の管理
  - 適用条件: フレームワークのエントリポイントで、プラグイン的にコンポーネントを登録・取得する場面
  - コード例: `packages/core/src/mastra/index.ts:292-349` — Mastra クラスが全コンポーネントを `#agents`, `#tools`, `#workflows` 等のプライベートフィールドで管理
  - 注意点: 過度に利用するとコンポーネント間の依存が暗黙的になる。Mastra では型パラメータ（`TAgents`, `TWorkflows` 等）で型安全性を担保

- **Composite Pattern** (構造)
  - 解決する問題: 異なるストレージバックエンドを統一的に扱いつつ、ドメインごとに異なるバックエンドを選択可能にする
  - 適用条件: 複数のインフラ基盤にまたがるデータ永続化
  - コード例: `packages/core/src/storage/base.ts:167-225` — `MastraCompositeStore`
  - 注意点: ドメイン間のトランザクション整合性は保証されない

- **Proxy Pattern** (構造)
  - 解決する問題: ストレージの遅延初期化と初回アクセス時の自動セットアップ
  - 適用条件: 非同期初期化が必要なリソースの透過的な利用
  - コード例: `packages/core/src/storage/storageWithInit.ts:34-63` — Proxy で全メソッドをラップし `ensureInit()` を挟む
  - 注意点: Vitest 環境で `instanceof Proxy` が機能しないため、Symbol によるガードが必要

- **Null Object Pattern** (振る舞い)
  - 解決する問題: オプショナルな機能が未設定の場合の安全な動作
  - 適用条件: 設定が任意であるクロスカッティング関心事（ロギング、オブザーバビリティ等）
  - コード例: `packages/core/src/observability/no-op.ts` — `NoOpObservability`
  - 注意点: NoOp を静かに使うと、設定ミスに気づきにくい場合がある

## Good Patterns

- **DynamicArgument による静的/動的の統一的設定**: `DynamicArgument<T>` 型は `T | ((ctx) => T | Promise<T>)` のユニオンで、設定項目を値でもコンテキスト依存の関数でも受け付ける。マルチテナント対応やリクエストスコープの構成変更に対応しつつ、シンプルなユースケースでは素の値を渡すだけでよい。

```typescript
// packages/core/src/types/dynamic-argument.ts:4-12
export type DynamicArgument<T, TRequestContext extends Record<string, any> | unknown = unknown> =
  | T
  | (({
    requestContext,
    mastra,
  }: {
    requestContext: RequestContext<TRequestContext>;
    mastra?: Mastra;
  }) => Promise<T> | T);
```

- **登録順序による循環依存の防止**: Mastra コンストラクタ内でコンポーネントの登録順序を明示的に制御し、依存関係の循環を防いでいる。Tools → Processors → Memory → Vectors → Scorers → Workflows → Gateways → MCP Servers → Agents の順に登録することで、後から登録されるコンポーネントは先に登録済みのコンポーネントを安全に参照できる。

```typescript
// packages/core/src/mastra/index.ts:596-677
// Now add primitives - order matters for auto-registration
// Tools and processors should be added before agents and MCP servers that might use them
if (config?.tools) { /* ... */ }
if (config?.processors) { /* ... */ }
if (config?.memory) { /* ... */ }
// ...
// Add MCP servers and agents last since they might reference other primitives
if (config?.mcpServers) { /* ... */ }
if (config?.agents) { /* ... */ }
```

- **構造化エラーによるドメイン別分類**: `MastraError` はエラーを `ErrorDomain`（TOOL, AGENT, STORAGE 等 14 種）と `ErrorCategory`（USER, SYSTEM, THIRD_PARTY, UNKNOWN）で分類する。エラー ID は大文字スネークケースの定数で、プログラム的な判別と観測の両方に対応する。

```typescript
// packages/core/src/error/index.ts:7-27
export enum ErrorDomain {
  TOOL = "TOOL",
  AGENT = "AGENT",
  MCP = "MCP",
  MASTRA_SERVER = "MASTRA_SERVER",
  STORAGE = "STORAGE",
  // ... 14 domains total
}
export enum ErrorCategory {
  UNKNOWN = "UNKNOWN",
  USER = "USER",
  SYSTEM = "SYSTEM",
  THIRD_PARTY = "THIRD_PARTY",
}
```

## Anti-Patterns / 注意点

- **Service Locator の暗黙的依存**: コンポーネントは `__registerMastra()` 経由で Mastra インスタンスへの参照を受け取り、そこから他のコンポーネントを取得する。依存関係がコンストラクタの引数ではなく実行時の登録によって解決されるため、コンパイル時に不足を検出できない。

```typescript
// Bad: 依存が暗黙的
agent.__registerMastra(this);  // 実行時に注入
const storage = this.#mastra?.getStorage();  // 実行時に解決

// Better: 依存をコンストラクタで明示（ただし Mastra のようなフレームワークでは
// プラグイン登録の柔軟性とのトレードオフがある）
constructor(config: { storage: Storage; logger: Logger }) { }
```

Mastra ではこのトレードオフを型パラメータ（`TAgents`, `TWorkflows` 等）で緩和し、登録済みコンポーネントの名前を型レベルで追跡している。

- **Proxy によるメソッドシグネチャの変質**: `augmentWithInit()` の Proxy は同期メソッドも `async` 関数でラップしてしまうため、ストレージの全メソッドが暗黙的に Promise を返す。型定義とランタイムの挙動が乖離するリスクがある。

```typescript
// Bad: 元の同期ゲッターも async でラップされる
return async (...args: unknown[]) => {
  await ensureInit();
  return Reflect.apply(value, target, args);
};

// Better: 非同期初期化が必要なメソッドを明示的にマーク
```

## 導出ルール

- `[MUST]` フレームワークのオプショナル機能には NoOp 実装を用意し、未設定時に例外ではなく安全な無動作を提供する
  - 根拠: Mastra は `NoOpObservability`, `noopLogger`, `DefaultVoice` を提供し、最小構成でもフレームワーク全体が動作する (`packages/core/src/observability/no-op.ts`)

- `[MUST]` 中央レジストリにコンポーネントを登録する際は、依存関係に基づく登録順序を明示的に制御する
  - 根拠: Mastra コンストラクタは Tools → Processors → Memory → MCP Servers → Agents の順で登録し、後から登録されるコンポーネントが先行コンポーネントを安全に参照できるようにしている (`packages/core/src/mastra/index.ts:596-677`)

- `[SHOULD]` 急速に変化する外部依存は内部にベンダリングし、ユーザー向け API の安定性を担保する
  - 根拠: Mastra は AI SDK の v4/v5/v6 を `packages/_vendored/` に格納し、内部アダプタでバージョン差異を吸収。ユーザーは magic string (`"openai/gpt-4o"`) だけで利用可能 (`packages/_vendored/`, `packages/core/src/llm/model/router.ts`)

- `[SHOULD]` 設定値を静的な値と動的なファクトリ関数の両方で受け付ける型（ユニオン型）を提供し、マルチテナント対応の拡張性を確保する
  - 根拠: `DynamicArgument<T>` パターンにより、instructions, model, tools 等のあらゆる設定がリクエストコンテキストに応じて動的に変更可能 (`packages/core/src/types/dynamic-argument.ts`)

- `[SHOULD]` ストレージを機能ドメイン単位で分割し、ドメインごとに異なるバックエンドを合成可能にする
  - 根拠: `MastraCompositeStore` はメモリを LibSQL、ワークフローを PostgreSQL のように、ドメインごとに異なるストレージバックエンドを組み合わせ可能 (`packages/core/src/storage/base.ts:167-225`)

- `[SHOULD]` エラーを機能ドメインと原因カテゴリ（ユーザー/システム/サードパーティ）の2軸で分類し、プログラム的判別と人間の理解の両方に対応する
  - 根拠: `MastraError` は `ErrorDomain` (14種) と `ErrorCategory` (4種) の組み合わせでエラーを構造化し、大文字 ID でプログラム的なハンドリングを可能にしている (`packages/core/src/error/index.ts`)

- `[AVOID]` Proxy による透過的な非同期ラッピングで型シグネチャを暗黙的に変える。遅延初期化が必要な場合は、初期化対象のメソッドを明示的にマークする
  - 根拠: `augmentWithInit()` の Proxy はすべてのメソッドを async でラップするため、型定義と実行時の挙動が乖離するリスクがある (`packages/core/src/storage/storageWithInit.ts:54-59`)

## 適用チェックリスト

- [ ] フレームワークのオプショナル機能（ロギング、観測、キャッシュ等）に NoOp 実装を用意しているか
- [ ] 中央レジストリへのコンポーネント登録順序が依存関係を反映しているか
- [ ] 急速に変化する外部依存（AI SDK, LLM プロバイダ等）をベンダリングまたはアダプタで吸収し、ユーザー API を安定させているか
- [ ] 設定値を静的値と動的ファクトリ関数の両方で受け付ける設計になっているか（マルチテナント想定）
- [ ] ストレージが機能ドメイン単位で分割されており、バックエンドの差し替えが可能か
- [ ] エラーにドメインとカテゴリの2軸分類を導入しているか
- [ ] Proxy やデコレータで型シグネチャを暗黙的に変質させていないか
