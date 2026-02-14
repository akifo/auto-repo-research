# Composability Patterns

> リポジトリ: mastra-ai/mastra
> 分析日: 2026-02-14

## 概要

ツール合成・ワークフローステップ連結・エージェント構成のコンポーザビリティパターンを分析した。Mastra はツール・エージェント・ワークフロー・プロセッサーという4種類のプリミティブを定義し、それらを「統一インターフェースによる型安全な合成」で組み合わせる設計を徹底している。特筆すべきは、Workflow が Step インターフェースを実装することでワークフロー自体がステップとしてネストでき、同じ `createStep` 関数がパラメータ・Agent・Tool・Processor を受け入れるポリモーフィックなファクトリーとして機能する点である。この合成アプローチは AI フレームワークに限らず、異種コンポーネントの型安全な連結が求められるあらゆるオーケストレーション基盤に応用できる。

## 背景にある原則

- **統一インターフェースによる合成可能性**: 異種コンポーネント（Agent・Tool・Processor・StepParams）をすべて `Step` インターフェースに変換することで、ワークフロー内で自由に連結可能にしている。新しいコンポーネント種別を追加しても既存のワークフロー API を変更せずに済む。根拠: `packages/core/src/workflows/workflow.ts:286-308` の `createStep` 実装。

- **遅延解決による動的構成**: `DynamicArgument<T>` 型を使い、ツール・プロセッサー・ワークスペース等の設定を「静的な値」と「リクエスト時に解決される関数」の両方で受け付ける。これによりマルチテナントや権限ベースの動的ツール選択が、API 変更なしで実現される。根拠: `packages/core/src/types/dynamic-argument.ts:4-12`。

- **中央レジストリによるクロスカッティング注入**: `Mastra` クラスが全コンポーネントの登録と相互接続を担い、ロガー・オブザーバビリティ・ストレージなどの横断的関心事を `__registerMastra` / `__registerPrimitives` メソッドで注入する。各コンポーネントは自身の依存を知る必要がなく、登録時に自動的に注入される。根拠: `packages/core/src/mastra/index.ts:866-875`。

- **型伝播によるコンパイル時検証**: ワークフローチェインの各メソッドが前ステップの出力型を次ステップの入力型に伝播させることで、合成ミスを実行前に検出する。実行時のデータ変換ではなく型レベルの制約で安全性を保証する。根拠: `packages/core/src/workflows/workflow.ts:1412-1419` の `then` メソッドの型パラメータ。

## 実例と分析

### 1. ポリモーフィックファクトリー: createStep

`createStep` 関数は型ガードによるオーバーロード分岐で、4種類の入力を受け入れる単一のファクトリー関数として機能する。

```typescript
// packages/core/src/workflows/workflow.ts:286-308
export function createStep(params: any, agentOrToolOptions?: any): Step<any, any, any, any, any, any, any> {
  if (isAgent(params)) {
    return createStepFromAgent(params, agentOrToolOptions);
  }
  if (isToolStep(params)) {
    return createStepFromTool(params, agentOrToolOptions);
  }
  if (isStepParams(params)) {
    return createStepFromParams(params);
  }
  if (isProcessor(params)) {
    return createStepFromProcessor(params);
  }
  throw new Error("Invalid input: expected StepParams, Agent, ToolStep, or Processor");
}
```

公開 API はクリーンなオーバーロード群（5つの overload signature、`workflow.ts:156-280`）で型安全性を提供し、実装は型ガードで分岐する。消費者はどの型を渡しても正確な型推論を得られる。

Agent をステップに変換する際の処理は注目に値する。Agent の `stream` メソッドを内部で呼び出し、ストリームのチャンクを pubsub に流しつつ、最終テキストを `{ text: string }` として返す。Agent の非同期ストリーミング動作がワークフローの同期的なステップ結果に透過的に変換される（`workflow.ts:348-518`）。

### 2. ワークフロー合成チェイン: 型伝播する Fluent API

Workflow クラスは `.then()`, `.parallel()`, `.branch()`, `.dowhile()`, `.dountil()`, `.foreach()`, `.map()`, `.sleep()`, `.sleepUntil()` のメソッドチェインでステップを連結する。

```typescript
// packages/core/src/workflows/workflow.ts:1412-1449
then<TStepId extends string, TStepState, TStepInput, TSchemaOut>(
  step: Step<
    TStepId,
    unknown extends TStepState ? TStepState : SubsetOf<TStepState, TState>,
    TPrevSchema extends TStepInput ? TStepInput : TPrevSchema,
    TSchemaOut,
    any, any, TEngineType, any
  >,
) {
  this.stepFlow.push({ type: 'step', step: step as any });
  // ...
  return this as unknown as Workflow<
    TEngineType, TSteps, TWorkflowId, TState, TInput, TOutput,
    TSchemaOut,  // ← TPrevSchema を次ステップの出力型に更新
    TRequestContext
  >;
}
```

`parallel()` では複数ステップの出力をマッピング型 `{ [K in keyof StepsRecord]: InferZodLikeSchema<...> }` として合成し（`workflow.ts:1756-1758`）、`branch()` では各分岐の出力をオプショナル型として合成する（`workflow.ts:1812-1815`）。`foreach()` は前ステップが配列型を返す場合のみ利用可能で、`TPrevSchema extends any[] ? true : false` で型レベルの制約を実現している（`workflow.ts:1896`）。

### 3. Workflow implements Step: Composite パターンによる再帰的合成

```typescript
// packages/core/src/workflows/workflow.ts:1294-1295
export class Workflow<...>
  extends MastraBase
  implements Step<TWorkflowId, TState, TInput, TOutput | undefined, any, any, DefaultEngineType, TRequestContext>
```

Workflow 自体が `Step` インターフェースを実装しているため、ワークフローを別のワークフローのステップとして入れ子にできる。`execute` メソッドを持ち、`inputSchema` / `outputSchema` を公開する（`workflow.ts:1299-1301`）。ネストされたワークフロー実行時は、親ワークフローの `executionContext` と `tracingContext` が子に伝播し、オブザーバビリティのスパンが正しくネストされる。

### 4. Agent のツール合成: 多層マージによるフラット化

Agent の `convertTools` メソッドは7つの異なるソースからツールを収集し、フラットにマージする。

```typescript
// packages/core/src/agent/agent.ts:2810-2892
const assignedTools = await this.listAssignedTools({ ... });    // 直接割り当て
const memoryTools = await this.listMemoryTools({ ... });         // メモリ由来
const toolsetTools = await this.listToolsets({ ... });           // ツールセット
const clientSideTools = await this.listClientTools({ ... });     // クライアント
const agentTools = await this.listAgentTools({ ... });           // 子エージェント
const workflowTools = await this.listWorkflowTools({ ... });     // ワークフロー
const workspaceTools = await this.listWorkspaceTools({ ... });   // ワークスペース

return this.formatTools({
  ...assignedTools,
  ...memoryTools,
  ...toolsetTools,
  ...clientSideTools,
  ...agentTools,
  ...workflowTools,
  ...workspaceTools,
});
```

ツールのソースは多様だが、最終的にすべて `Record<string, CoreTool>` に統一され、Agent はソースの出自を意識しない。`formatTools` でツール名の正規化（命名規則のバリデーション）を行い、LLM が利用可能な形式に統一する。

### 5. エージェントネットワーク: LLM ルーターによる動的プリミティブ合成

```typescript
// packages/core/src/loop/network/index.ts:112-200
export async function getRoutingAgent({ requestContext, agent, routingConfig }) {
  const agentsToUse = await agent.listAgents({ requestContext });
  const workflowsToUse = await agent.listWorkflows({ requestContext });
  const toolsToUse = await agent.listTools({ requestContext });

  return new Agent({
    id: "routing-agent",
    name: "Routing Agent",
    instructions: `You are a router in a network of specialized AI agents.
      ## Available Agents in Network
      ${agentList}
      ## Available Workflows in Network
      ${workflowList}
      ## Available Tools in Network
      ${toolList}`,
    model: model,
  });
}
```

ネットワーク内のエージェント・ワークフロー・ツールの説明とスキーマをプロンプトに列挙し、LLM 自身にルーティングを判断させる。利用可能なプリミティブのカタログをメタデータから自動生成する点が動的合成を支えている。ルーティングステップは `createStep` + `createWorkflow` で構築されるワークフローとして実装されており（`network/index.ts:490`）、ネットワーク自体がワークフローの合成パターンを再利用している。

### 6. プロセッサーパイプライン: 横断的関心事の合成

```typescript
// packages/core/src/processors/runner.ts:113-143
export class ProcessorRunner {
  public readonly inputProcessors: ProcessorOrWorkflow[];
  public readonly outputProcessors: ProcessorOrWorkflow[];
}
```

プロセッサーは Agent のリクエスト/レスポンスパイプラインに挿入される横断的関心事で、`ModerationProcessor`, `PIIDetector`, `TokenLimiter`, `SkillsProcessor`, `ToolSearchProcessor` 等が提供される（`packages/core/src/processors/processors/index.ts`）。各プロセッサーは `Processor` インターフェースを実装し、入力側（`processInput`, `processInputStep`）と出力側（`processOutputStream`, `processOutputResult`）の異なるフェーズにフックする。

さらに注目すべきは、プロセッサー自体をワークフローとして構成できる点。プロセッサーワークフローは `.then()` `.branch()` を使ってプロセッサー間の連鎖を定義でき、「プロセッサーの合成にワークフローの合成パターンを再利用する」という自己相似的な設計になっている（`workflow.ts:764` のコメント参照）。

### 7. DynamicArgument: 静的/動的構成の透過的統一

```typescript
// packages/core/src/types/dynamic-argument.ts:4-12
export type DynamicArgument<T, TRequestContext extends Record<string, any> | unknown = unknown> =
  | T
  | (({ requestContext, mastra }: {
    requestContext: RequestContext<TRequestContext>;
    mastra?: Mastra;
  }) => Promise<T> | T);
```

Agent の `tools`, `instructions`, `memory`, `model`, `agents`, `workflows`, `workspace` 等の設定項目がこの型を使う。リクエストごとに異なるツールセットを返したり、ユーザーのロールに応じてインストラクションを変えたりする動的合成を、型レベルで自然に表現している。`resolveMaybePromise` ヘルパー（`agent.ts:101-107`）により、同期・非同期のどちらの値でも統一的に処理される。

### 8. ToolLoopAgent アダプター: 外部 SDK の透過的統合

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

AI SDK v6 の `ToolLoopAgent` を Mastra の `Agent` に変換するアダプター。`Mastra.addAgent` 内で `isToolLoopAgentLike` による型ガードを使い、外部 SDK のエージェントが渡された場合に自動変換する（`mastra/index.ts:852-854`）。消費者は SDK の違いを意識せずにエージェントを登録できる。

## パターンカタログ

- **Composite パターン** (分類: 構造)
  - 解決する問題: ワークフローとステップを再帰的に合成したい
  - 適用条件: 複合オブジェクトと個々のオブジェクトを同一視したい場合
  - コード例: `packages/core/src/workflows/workflow.ts:1295` — `Workflow implements Step`
  - 注意点: 深いネスティングはデバッグとエラートレースを複雑にする。`as unknown as` キャストが増える

- **Adapter パターン** (分類: 構造)
  - 解決する問題: 異なるインターフェースを持つ外部コンポーネントを統一的に利用したい
  - 適用条件: 外部ライブラリや異なる API バージョンとの互換性が必要な場合
  - コード例: `packages/core/src/tool-loop-agent/index.ts:36-47` — `toolLoopAgentToMastraAgent`、`createStep` の Agent/Tool/Processor 変換
  - 注意点: アダプター層が増えると抽象化の漏れが起きやすい

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: ワークフローの実行エンジンを差し替え可能にしたい
  - 適用条件: アルゴリズムのファミリーを定義し、実行時に選択したい場合
  - コード例: `packages/core/src/workflows/execution-engine.ts` — `ExecutionEngine` 抽象クラスと `DefaultExecutionEngine`
  - 注意点: 実装ごとの振る舞いの差異をテストで保証する必要がある

- **Chain of Responsibility パターン** (分類: 振る舞い)
  - 解決する問題: 入出力のフィルタリング・変換を複数段階で行いたい
  - 適用条件: リクエスト/レスポンスを複数のハンドラーで順番に処理する場合
  - コード例: `packages/core/src/processors/runner.ts:113` — `ProcessorRunner`
  - 注意点: パイプライン内のプロセッサー順序が結果に影響するため、順序の管理が重要

- **Registry / Mediator パターン** (分類: 構造/振る舞い)
  - 解決する問題: 多数のサブシステムの相互接続を一元管理したい
  - 適用条件: システム内のコンポーネントが相互に参照し合う場合
  - コード例: `packages/core/src/mastra/index.ts:292-306` — `Mastra` クラスの中央レジストリ
  - 注意点: 暗黙の依存が増えるとテスト時のセットアップが複雑になる

## Good Patterns

- **ポリモーフィックファクトリーによるステップ統一**: `createStep` が Agent・Tool・Processor・パラメータオブジェクトのいずれも受け入れ、すべてを `Step` に変換する。消費者は「何をステップにしたいか」だけを考えればよく、ワークフローは入力の出自を知らない。

```typescript
// packages/core/src/workflows/workflow.ts:286-308
if (isAgent(params)) return createStepFromAgent(params, agentOrToolOptions);
if (isToolStep(params)) return createStepFromTool(params, agentOrToolOptions);
if (isStepParams(params)) return createStepFromParams(params);
if (isProcessor(params)) return createStepFromProcessor(params);
```

- **DynamicArgument による設定のリフティング**: `T | ((ctx) => T | Promise<T>)` というユニオン型で、設定値を静的にも動的にも受け付ける。マルチテナント対応やリクエストスコープの設定変更を既存 API を壊さずに導入できる。

```typescript
// packages/core/src/types/dynamic-argument.ts:4-12
export type DynamicArgument<T, TRequestContext> =
  | T
  | (({ requestContext, mastra }) => Promise<T> | T);
```

- **型伝播する Fluent API**: `.then()` の戻り値型で `TPrevSchema` を次ステップの出力型に伝播させることで、チェーン全体で型安全性を維持する。`foreach()` の `TPrevSchema extends any[] ? true : false` のような条件型で、メソッド呼び出しの前提条件を型レベルで強制する。

```typescript
// packages/core/src/workflows/workflow.ts:1412-1449
// TPrevSchema extends TStepInput ? TStepInput : TPrevSchema
// → 型が合わなければコンパイルエラー
```

## Anti-Patterns / 注意点

- **ツール名衝突のサイレントオーバーライド**: 7つのソースからツールをスプレッドでマージするため、同名のツールが存在すると後勝ちでサイレントに上書きされる。大規模な構成で意図しないツールの消失が起きる可能性がある。

```typescript
// Bad: 同名ツールがあると後者が勝つ
return this.formatTools({
  ...assignedTools, // { search: ... }
  ...workspaceTools, // { search: ... } ← assignedTools の search を上書き
});

// Better: 衝突を検出して警告を出す、またはプレフィックス付きで名前空間を分離する
const merged = {};
for (const [source, tools] of sources) {
  for (const [name, tool] of Object.entries(tools)) {
    if (merged[name]) logger.warn(`Tool "${name}" from ${source} overrides existing tool`);
    merged[name] = tool;
  }
}
```

- **暗黙的な登録順序依存**: `Mastra` コンストラクタ内でコンポーネントの登録順序が重要（ツール → プロセッサー → MCP サーバー → エージェント）だが、この制約はコメントでのみ示されており、順序を間違えても静かに不完全な状態になる可能性がある。

```typescript
// Bad: 順序をコメントでのみ説明
// Now add primitives - order matters for auto-registration
if (config?.tools) { /* ... */ }
if (config?.agents) { /* ... */ }

// Better: 依存グラフに基づくトポロジカルソート、または登録時のバリデーション
```

## 導出ルール

- `[MUST]` 合成の基本単位となるプリミティブには共通インターフェースを定義し、ファクトリー関数で統一的に生成する
  - 根拠: `createStep` は Agent, Tool, Processor, パラメータオブジェクトを単一の Step に変換し、ワークフロー側の合成ロジックを1種類に保っている（`workflow.ts:286-308`）

- `[MUST]` 合成チェインの各メソッドは前段の出力型を次段の入力型に伝播し、型不一致をコンパイル時に検出する
  - 根拠: `.then()` は `TPrevSchema extends TStepInput ? TStepInput : TPrevSchema` で前段出力と次段入力の互換性を型レベルで強制している（`workflow.ts:1419`）

- `[MUST]` Composite パターンを適用する際は、葉ノード（単体コンポーネント）と複合ノード（合成コンポーネント）が同一インターフェースを実装し、再帰的ネスティングを可能にする
  - 根拠: `Workflow implements Step` により、ワークフローをステップとして入れ子にできる再帰的合成が実現されている（`workflow.ts:1295`）

- `[SHOULD]` 設定値を「値そのもの」と「コンテキストを受け取る関数」の両方で受け入れるユニオン型を定義し、静的構成と動的構成を同じ API で扱えるようにする
  - 根拠: `DynamicArgument<T>` により、tools, instructions, memory 等がリクエスト時の動的解決と静的宣言を透過的に切り替えられる（`dynamic-argument.ts:4-12`）

- `[SHOULD]` 中央レジストリでプリミティブを管理する場合、登録順序の依存関係をバリデーションまたは型制約で強制する
  - 根拠: Mastra のコンストラクタはツール→プロセッサー→MCP サーバー→エージェントの順で登録し、依存先が先に存在することを保証しているが、制約はコメントのみ（`mastra/index.ts:596-677`）

- `[SHOULD]` 多層のコンポーネントマージでは名前衝突を検出し、サイレントな上書きを防ぐ仕組みを設ける
  - 根拠: ツールマージは7つのソースをスプレッドで統合するが、同名ツールの衝突検出がなく、意図しない上書きが起きうる（`agent.ts:2884-2892`）

- `[AVOID]` プロセッサーパイプラインで順序依存の副作用を暗黙に持たせる — 各プロセッサーは独立して動作し、順序を変えても基本動作が壊れないようにする
  - 根拠: `TokenLimiter` と `PIIDetector` の順序でトークン計算が変わるなど、プロセッサーの順序が暗黙的に結果に影響するケースがある

## 適用チェックリスト

- [ ] 異なる型のコンポーネントを統一的に扱いたい箇所で、共通インターフェース + ポリモーフィックファクトリーを導入しているか
- [ ] ワークフローやパイプラインのチェインで前段の出力型が後段の入力型に伝播し、型不一致がコンパイル時に検出されるか
- [ ] 複合オブジェクト（ワークフロー等）が個々の要素と同じインターフェースを実装し、再帰的ネスティングが可能か
- [ ] 設定値に `DynamicArgument` 相当のユニオン型を使い、静的宣言と動的解決を同じ API で扱えるか
- [ ] 多層マージ（ツール、ミドルウェア等）で名前衝突の検出・警告を行っているか
- [ ] プロセッサー/ミドルウェアのパイプラインで各要素が独立しており、順序変更時の影響が明文化されているか
- [ ] 中央レジストリの登録順序に暗黙の依存がある場合、その制約がバリデーションまたは型で強制されているか
- [ ] 外部 SDK のコンポーネントをアダプターで透過的に統合し、消費者が SDK の違いを意識しない設計になっているか
