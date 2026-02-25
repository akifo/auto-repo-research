# Composition Patterns

> リポジトリ: cloudflare/agents
> 分析日: 2026-02-25

## 概要

cloudflare/agents は Agent クラスの継承、McpAgent/AiChatAgent による機能特化拡張、AgentWorkflow による非同期合成、mixin による横断的関心事の注入という 4 層の合成構造を持つ。注目に値するのは、Durable Object (DO) のライフサイクル制約（ハイバネーション、エビクション、単一スレッド）に適合しながら、プロトコルレベル（MCP）、AI 対話、ワークフロー制御という異なる関心事を、共通の Agent 基盤の上に独立して重ねている点である。マルチエージェント合成では `getAgentByName` による DO RPC を使い、プロセス間の型安全な協調を実現している。

## 背景にある原則

- **単一基盤、複数拡張面（Single Foundation, Multiple Extension Surfaces）**: 永続ストレージ・WebSocket 管理・スケジューリングなど共通インフラは Agent 基底クラスに集約し、MCP や AI Chat といった関心事は専用サブクラスとして独立に積み重ねる。同じ基盤を共有することで、状態管理やコネクション管理の重複を避ける。根拠: `McpAgent extends Agent` (`packages/agents/src/mcp/index.ts:32`)、`AIChatAgent extends Agent` (`packages/ai-chat/src/index.ts:190`) がそれぞれ独自テーブルを追加するが、`sql`・`setState`・`broadcast` などは共通。

- **ライフサイクルフックによる拡張（Extension via Lifecycle Hooks）**: 基底クラスにデフォルト実装を持つフック群（`onConnect`, `onMessage`, `onStateChanged`, `onWorkflowProgress` 等）を用意し、サブクラスがオーバーライドする。直接的なイベントエミッタではなくメソッドオーバーライドを採用するのは、DO の単一インスタンスモデル（1 つの DO に 1 つのクラスインスタンス）に合致するため。根拠: Agent クラスの `onStateChanged` (`src/index.ts:1515`)、`onWorkflowProgress` (`src/index.ts:3676`) はデフォルト空実装。

- **RPC スタブによるプロセス間合成（Inter-Process Composition via RPC Stubs）**: マルチエージェントは共有メモリではなく DO RPC で連携する。`getAgentByName` が返すスタブは型パラメータによって呼び出し側に型安全性を提供する。これにより、プロセス境界を越えた合成でもコンパイル時にメソッドシグネチャを検証できる。根拠: `SupervisorAgent` が `getAgentByName<Env, ChildAgent>` で型付きスタブを取得 (`examples/playground/src/demos/multi-agent/supervisor-agent.ts:19`)。

- **合成パターンの選択基準: 同期性と耐久性**: 同期的・短命な連携は DO RPC（マルチエージェント）、非同期的・耐久性が必要な連携は AgentWorkflow（Workflows API）、横断的関心事は mixin（withFibers）。この選択基準を明確に分けることで、各パターンの責務が明確になる。根拠: `AgentWorkflow` はエビクション耐性のある `step.do` で処理を包み (`packages/agents/src/workflows.ts:206`)、一方マルチエージェントは直接 RPC 呼び出し。

## 実例と分析

### 1. 継承階層: Agent → 特化サブクラス

Agent クラスは partyserver の `Server` を継承し、DO 基盤の上に状態管理、SQL、スケジューリング、MCP クライアント管理を追加する。この Agent を頂点に、2 つの方向で拡張している。

```
Server (partyserver)
  └─ Agent (agents core)
       ├─ McpAgent (MCP プロトコルサーバー)
       └─ AIChatAgent (AI チャット)
```

McpAgent は `abstract server` プロパティと `abstract init()` を要求し、MCP サーバーとしての振る舞いを強制する。AIChatAgent は `onChatMessage` をオーバーライドポイントとして提供する。いずれも Agent の `sql`、`setState`、`broadcast`、`schedule` をそのまま活用する。

### 2. マルチエージェント合成: getAgentByName による DO RPC

複数エージェント間の協調は `getAgentByName` でスタブを取得し、公開メソッドを直接呼び出す形で行う。コードベースには 3 つの典型パターンがある。

**Supervisor-Child パターン** (`supervisor-agent.ts`): 親が子の生成・状態取得・操作を一元管理する。

```typescript
// examples/playground/src/demos/multi-agent/supervisor-agent.ts:19-22
const child = await getAgentByName<Env, ChildAgent>(
  this.env.ChildAgent,
  childId,
);
const state = await child.initialize(this.name);
```

**Pipeline パターン** (`pipeline-agent.ts`): データを順次処理する直列連鎖。各ステージが独立した Agent として存在する。

```typescript
// examples/playground/src/demos/multi-agent/pipeline-agent.ts:28-59
const validator = await getAgentByName<Env, ValidatorStageAgent>(...);
const validateResult = await validator.process(input);
const transformer = await getAgentByName<Env, TransformStageAgent>(...);
const transformResult = await transformer.process(validatedOutput);
const enricher = await getAgentByName<Env, EnrichStageAgent>(...);
const enrichResult = await enricher.process(transformedOutput);
```

**Fan-out パターン** (`manager-agent.ts`): 入力を分割し、並列ワーカーに配布して `Promise.all` で集約する。

```typescript
// examples/playground/src/demos/multi-agent/manager-agent.ts:31-39
const results = await Promise.all(
  chunks.map(async (chunk, i) => {
    const worker = await getAgentByName<Env, FanoutWorkerAgent>(
      this.env.FanoutWorkerAgent,
      `worker-${this.name}-${i}`,
    );
    return worker.processChunk(`worker-${i}`, chunk);
  }),
);
```

### 3. Workflow 合成: Agent ↔ AgentWorkflow の双方向通信

AgentWorkflow は `WorkflowEntrypoint` を拡張し、実行中のワークフローから元の Agent へ RPC コールバックで状態を通知する。この合成は「耐久性のある非同期処理」が必要な場面で使われる。

```typescript
// packages/agents/src/workflows.ts:62-67
export class AgentWorkflow<
  AgentType extends Agent = Agent,
  Params = unknown,
  ProgressType = DefaultProgress,
  Env extends Cloudflare.Env = Cloudflare.Env
> extends WorkflowEntrypoint<Env, AgentWorkflowParams<Params>> {
```

AgentWorkflow のコンストラクタは、サブクラスの `run` メソッドをプロトタイプレベルでラップし、実行前に Agent スタブの初期化を自動化する（`wrappedPrototypes` WeakSet で二重ラップを防止）。

```typescript
// packages/agents/src/workflows.ts:100-148
if (Object.hasOwn(proto, "run") && !wrappedPrototypes.has(proto)) {
  const originalRun = proto.run;
  proto.run = async function (this, event, step) {
    if (!this.__agentInitCalled) {
      // Agent スタブ初期化 + パラメータクリーニング
      await this._initAgent(...);
      this.__agentInitCalled = true;
      return originalRun.call(this, cleanedEvent, wrappedStep);
    }
    return originalRun.call(this, event, step);
  };
  wrappedPrototypes.add(proto);
}
```

### 4. Mixin パターン: withFibers による横断的関心事の注入

`withFibers` は TypeScript mixin パターンで Agent に「永続的ファイバー」機能を横断的に追加する。継承チェーンを変えずに機能を合成できる。

```typescript
// packages/agents/src/experimental/forever.ts:118-124
export function withFibers<TBase extends AgentLike>(Base: TBase, options?) {
  class FiberAgent extends Base {
    // keepAlive, spawnFiber, stashFiber, cancelFiber ...
  }
  return FiberAgent;
}
```

使用側:

```typescript
// 使用例（experimental/forever.ts:19 のドキュメントコメントより）
class MyAgent extends withFibers(Agent)<Env, State> {
  async doWork(payload, fiberCtx) { ... }
}
```

### 5. フレームワーク統合: hono-agents による Middleware 合成

`hono-agents` は Agent ルーティングを Hono の middleware チェーンに組み込む。Agent 側のクラス階層には手を加えず、ルーティング層だけを合成する。

```typescript
// packages/hono-agents/src/index.ts:21-41
export function agentsMiddleware<E extends Env = Env>(ctx?) {
  return createMiddleware<E>(async (c, next) => {
    const handler = isWebSocketUpgrade(c)
      ? handleWebSocketUpgrade
      : handleHttpRequest;
    const response = await handler(c, ctx?.options);
    return response === null ? await next() : response;
  });
}
```

### 6. `@callable` デコレータとアクセス制御

`@callable` デコレータは WeakMap にメタデータを登録し、外部クライアントからの RPC 呼び出しを許可するメソッドを宣言的にマークする。一方、DO 間の RPC（`getAgentByName` 経由）では `@callable` は不要で、任意の public メソッドが呼び出せる。

```typescript
// packages/agents/src/index.ts:163-174
export function callable(metadata: CallableMetadata = {}) {
  return function callableDecorator<This, Args extends unknown[], Return>(
    target: (this: This, ...args: Args) => Return,
    _context: ClassMethodDecoratorContext,
  ) {
    if (!callableMetadata.has(target)) {
      callableMetadata.set(target, metadata);
    }
    return target;
  };
}
```

## パターンカタログ

- **Template Method** (分類: 振る舞い)
  - 解決する問題: 基底クラスの処理フローを固定しつつ、特定のステップをサブクラスに委譲する
  - 適用条件: ライフサイクルが決まっており、拡張ポイントが明確な場合
  - コード例: `Agent.onStateChanged` (`src/index.ts:1515`)、`AIChatAgent.onChatMessage` (`ai-chat/src/index.ts:909`)、`McpAgent.init` / `McpAgent.server` (`src/mcp/index.ts:37`)
  - 注意点: フック数が増えると「override 地獄」になるため、関連するフックをグループ化する

- **Mixin** (分類: 構造)
  - 解決する問題: 継承チェーンを汚染せずに横断的関心事を追加する
  - 適用条件: 複数の独立した機能を任意の組み合わせで合成したい場合
  - コード例: `withFibers` (`src/experimental/forever.ts:118`)
  - 注意点: TypeScript の mixin は型推論が複雑になりやすい。`AgentLike` のように必要最小限のインターフェースで制約する

- **Proxy / Stub** (分類: 構造)
  - 解決する問題: プロセス境界を透過的に越えてメソッド呼び出しを行う
  - 適用条件: 分散システムで型安全な RPC が必要な場合
  - コード例: `getAgentByName` が `DurableObjectStub<T>` を返す (`src/index.ts:4428`)
  - 注意点: ネットワーク越しの呼び出しであることを意識し、エラーハンドリングとタイムアウトを考慮する

- **Decorator** (分類: 構造)
  - 解決する問題: メソッドに宣言的にメタデータを付与する
  - 適用条件: アクセス制御やシリアライゼーション設定をメソッド定義と同じ場所で行いたい場合
  - コード例: `@callable` (`src/index.ts:163`)
  - 注意点: WeakMap ベースのメタデータ管理で、デコレータ非対応環境との互換性を考慮する

## Good Patterns

- **型パラメータによる DO RPC の型安全性**: `getAgentByName<Env, ChildAgent>(this.env.ChildAgent, childId)` のように型パラメータを明示することで、スタブ経由の呼び出しに型安全性を付与する。コンパイル時に存在しないメソッドの呼び出しを検出できる。

```typescript
// examples/playground/src/demos/multi-agent/supervisor-agent.ts:19-22
const child = await getAgentByName<Env, ChildAgent>(
  this.env.ChildAgent,
  childId,
);
const state = await child.initialize(this.name); // 型チェックされる
```

- **WeakSet によるプロトタイプラップの二重適用防止**: AgentWorkflow のコンストラクタで `run` メソッドをラップする際、`wrappedPrototypes` WeakSet でプロトタイプごとに 1 度だけラップされることを保証する。同一クラスの複数インスタンス生成でも安全。

```typescript
// packages/agents/src/workflows.ts:52,100
const wrappedPrototypes = new WeakSet<object>();
// ...
if (Object.hasOwn(proto, "run") && !wrappedPrototypes.has(proto)) {
  // wrap
  wrappedPrototypes.add(proto);
}
```

- **`@callable` と DO RPC の明確な分離**: 外部クライアント（WebSocket 経由）からの呼び出しは `@callable` が必須、DO 間 RPC は任意の public メソッドが呼べる。ChildAgent の `initialize` は `@callable` なしで Supervisor から呼ばれる一方、LobbyAgent の `createRoom` は `@callable` 付きでクライアントから呼ばれる。このアクセス制御の二層構造により、内部 API と外部 API を明示的に区別できる。

```typescript
// ChildAgent: DO RPC 用（@callable なし）
initialize(createdBy: string): ChildState { ... }

// LobbyAgent: クライアント用（@callable あり）
@callable({ description: "Create a new room" })
async createRoom(roomId: string): Promise<RoomInfo> { ... }
```

- **Playground ベースクラスによるデモ固有の横断的関心事の分離**: `PlaygroundAgent` が Agent を拡張してアイドルタイムアウトによる自動クリーンアップを追加し、すべてのデモエージェントがこれを継承する。プロダクションコードとデモ固有のライフサイクルを分離する中間層パターン。

```typescript
// examples/playground/src/shared/playground-agent.ts:21-46
export class PlaygroundAgent<E, State> extends Agent<E, State> {
  onConnect(_connection, _ctx) {
    // cancel idle timer
  }
  onClose(_connection) {
    // start idle timer if no connections
  }
  async onIdleTimeout() {
    await this.destroy();
  }
}
```

## Anti-Patterns / 注意点

- **Agent 内部メソッドの外部公開リスク**: `_workflow_handleCallback`, `_workflow_broadcast`, `_workflow_updateState` は `_` プレフィックスで内部用を示すが、DO RPC では TypeScript の private が効かないため、外部から呼び出せてしまう。命名規約だけではアクセス制御にならない。

```typescript
// Bad: 命名規約のみで保護
async _workflow_handleCallback(callback: WorkflowCallback): Promise<void> {
  await this.onWorkflowCallback(callback);
}

// Better: 呼び出し元を検証するか、明示的なゲートを設ける
async _workflow_handleCallback(callback: WorkflowCallback): Promise<void> {
  // 将来的に呼び出し元の検証を追加可能
  await this.onWorkflowCallback(callback);
}
```

- **Mixin での型キャストの多用**: `withFibers` 内で `(this as unknown as Agent<Cloudflare.Env>).sql` のようなキャストが頻出する。これは mixin の型制約 `AgentLike` が最小限のインターフェースしか公開しないためだが、型安全性を損なう。

```typescript
// Bad: mixin 内での多重キャスト
(this as unknown as Agent<Cloudflare.Env>).sql`...`;

// Better: AgentLike の型定義を拡張して sql を含める
type AgentLike = Constructor<
  Pick<Agent<Cloudflare.Env>, "sql" | "scheduleEvery" | "cancelSchedule">
>;
```

## 導出ルール

- `[MUST]` サブクラスのライフサイクルフック（`onConnect`, `onClose` 等）をオーバーライドする際は、基底クラスの振る舞いを保持するために `super.method()` の呼び出しを検討する
  - 根拠: `RoomAgent.onConnect` が `super.onConnect` を呼んでアイドルタイマー解除を維持している (`examples/playground/src/demos/multi-agent/room-agent.ts:41`)

- `[MUST]` プロセス間で共有する合成オブジェクト（Workflow パラメータ等）に内部メタデータを注入する場合は、ユーザー定義フィールドと衝突しない命名規則（`__` プレフィックス等）を使い、消費側で除去する
  - 根拠: `AgentWorkflow` が `__agentName`, `__agentBinding`, `__workflowName` を注入し、`run` ラッパー内で除去している (`packages/agents/src/workflows.ts:116-132`)

- `[SHOULD]` プロトタイプレベルのメソッドラップ（Monkey Patch）を行う場合は、WeakSet でラップ済みプロトタイプを追跡し、二重適用を防止する
  - 根拠: `wrappedPrototypes` WeakSet が同一プロトタイプの二重ラップを防止 (`packages/agents/src/workflows.ts:52,100`)

- `[SHOULD]` 外部クライアント向け API と内部プロセス間 API を同一クラスに定義する場合は、デコレータや命名規約で明示的にアクセスレベルを区別する
  - 根拠: `@callable` が WebSocket クライアント向けを明示し、DO RPC 向けはデコレータなしで定義される (`examples/playground/src/demos/multi-agent/child-agent.ts:17` vs `lobby-agent.ts:21`)

- `[SHOULD]` マルチプロセス合成で RPC スタブを使う場合は、型パラメータを明示して呼び出し側にコンパイル時の型安全性を保証する
  - 根拠: `getAgentByName<Env, ChildAgent>` の型パラメータにより、存在しないメソッド呼び出しがコンパイル時に検出される (`examples/playground/src/demos/multi-agent/supervisor-agent.ts:19`)

- `[SHOULD]` 横断的関心事（ロギング、ヘルスチェック、永続的実行等）は mixin パターンで合成し、メインの継承チェーンを単純に保つ
  - 根拠: `withFibers` mixin が Agent の継承チェーンに影響を与えずにファイバー機能を追加 (`packages/agents/src/experimental/forever.ts:118`)

- `[AVOID]` TypeScript の mixin 内でベースクラスの型を `as unknown as ConcreteType` でキャストすること。代わりに mixin の型制約（`AgentLike` 等）に必要なメソッドを含める
  - 根拠: `withFibers` 内で `(this as unknown as Agent<Cloudflare.Env>).sql` が多用され、型安全性が低下している (`packages/agents/src/experimental/forever.ts:136,211,239`)

## 適用チェックリスト

- [ ] 基底クラスに共通インフラ（ストレージ、通信、スケジューリング）を集約し、機能特化は継承またはmixin で行っているか
- [ ] ライフサイクルフックのデフォルト実装が空（no-op）で提供され、サブクラスが必要なものだけオーバーライドする設計か
- [ ] プロセス間の合成（マルチサービス連携）で型パラメータによる型安全性を確保しているか
- [ ] 外部クライアント向け API と内部サービス間 API のアクセスレベルが明示的に区別されているか
- [ ] プロトタイプレベルのメソッドラップに二重適用防止のガードがあるか
- [ ] 内部メタデータをユーザー定義データに注入する場合、衝突回避の命名規約と消費側での除去処理があるか
- [ ] 横断的関心事は継承チェーンを汚染しない合成手法（mixin、ミドルウェア等）で追加されているか
- [ ] 同期的 RPC と耐久的 Workflow の使い分け基準が明確か（短命 vs 長命、冪等性の要否）
