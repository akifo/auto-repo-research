# extensibility-mechanisms

> リポジトリ: cloudflare/agents
> 分析日: 2026-02-25

## 概要

cloudflare/agents は Cloudflare Workers の Durable Objects 上にエージェントを構築するフレームワークであり、Hono 統合、OpenAI SDK 統合、x402 支払いプロトコル、MCP (Model Context Protocol)、Vercel AI SDK、Workflow 統合など多数の拡張ポイントを持つ。本視点では、これらの拡張ポイントがどのような設計パターンで実現されているかを横断的に分析し、「別フレームワークと統合可能な SDK を設計する」際に応用できるプラクティスを抽出する。

## 背景にある原則

- **Augmentation over Wrapping（ラッピングより増強）**: 既存オブジェクトに機能を注入する `withX402()` / `withX402Client()` のような増強パターンにより、元のインターフェースを壊さずにプロトコル横断の機能を追加する。`Object.defineProperty` で既存メソッドをインターセプトし、新メソッドを生やすことで、型安全性と後方互換性を両立している（`packages/agents/src/mcp/x402.ts:285-293`）。

- **Optional Peer Dependencies による段階的採用**: `ai`, `react`, `zod`, `@x402/core`, `@x402/evm`, `@cloudflare/ai-chat` 等はすべて optional peer dependency として宣言され、使わない機能のために依存を強制しない。これにより、最小構成からフル機能構成まで同一パッケージで対応する（`packages/agents/package.json:51-80`）。

- **Lifecycle Hooks による拡張ポイントの明示**: `Agent` クラスは `onRequest`, `onMessage`, `onConnect`, `onStart`, `onStateChanged`, `validateStateChange`, `shouldConnectionBeReadonly`, `shouldSendProtocolMessages`, `onError`, `onEmail`, `createMcpOAuthProvider` など多数のオーバーライド可能メソッドを定義し、サブクラスが必要な部分だけ拡張できるようにしている。

- **Adapter 型統合による Framework-Agnostic 設計**: Hono 統合は `agentsMiddleware` 関数として実装され、`routeAgentRequest` をラップする薄いアダプターに過ぎない。フレームワーク固有のコードを最小限の別パッケージ (`hono-agents`) に分離し、コアロジックの汚染を防いでいる（`packages/hono-agents/src/index.ts`）。

## 実例と分析

### 1. withX402 / withX402Client: Object Augmentation パターン

x402 支払いプロトコルの統合は、MCP の `McpServer` と `Client` オブジェクトに対してデコレーター的に機能を追加する。`withX402(server, cfg)` は既存サーバーに `paidTool` メソッドを追加し、`withX402Client(client, cfg)` は `listTools` と `callTool` メソッドを支払いロジックでラップする。

特徴的なのは、`Object.defineProperty` で `writable: false` に設定し、意図しないメソッド上書きを防止している点。また、lazy initialization パターンで初期化コストを遅延させ、初回使用時にのみ facilitator 接続を行う。

### 2. McpAgent: Abstract Template Method パターン

`McpAgent` は `Agent` を継承した抽象クラスで、`abstract server` プロパティと `abstract init()` メソッドを強制する。サブクラスは MCP サーバーの構築方法を自由に定義でき、トランスポート選択（SSE / Streamable HTTP / RPC）やセッション管理はフレームワーク側が処理する。

`McpAgent.serve(path, options)` は静的ファクトリメソッドで、Worker の `fetch` ハンドラを生成する。DurableObject バインディング名やトランスポートタイプをオプションとして受け取り、1行でデプロイ可能なハンドラを返す。

### 3. Hono 統合: Thin Middleware Adapter パターン

`packages/hono-agents/src/index.ts` はわずか 85 行のファイルで、Hono の `createMiddleware` を使って Agent ルーティングを Hono アプリに注入する。WebSocket アップグレードと通常 HTTP を分岐し、Agent が処理できないリクエストは `next()` で後続ミドルウェアに渡す。

### 4. OpenAI SDK 統合: Composition over Inheritance

`openai-sdk/basic/src/server.ts` では `@openai/agents` の `Agent` と `agents` パッケージの `Agent` を別名で共存させている。cloudflare/agents の `Agent` を継承した `MyAgent` の `onRequest` 内で OpenAI `Agent` を構築し `run()` する構成。フレームワーク間の依存を持たず、ユーザーコードレベルで合成する設計。

### 5. createMcpHandler: Standalone Worker 向け拡張

`McpAgent` (Durable Object ベース) とは別に、`createMcpHandler` は通常の Worker 内で MCP サーバーを動かすためのファクトリ関数。`WorkerTransport` を自動生成し、`McpAuthContext` による認証コンテキスト注入をサポートする。Durable Object に依存しない軽量パスを提供する。

### 6. withFibers: Mixin パターンによる実験的拡張

`experimental/forever.ts` は TypeScript の mixin パターンで `Agent` クラスに fiber（長時間実行ジョブ）機能を追加する。`withFibers(Agent)` と書くだけで `spawnFiber`, `keepAlive` 等のメソッドが追加される。SQLite テーブル作成もコンストラクタ内で自動的に行われ、既存 Agent のスキーマを拡張する。

### 7. Observability: 交換可能なイベントシステム

`Agent` クラスの `observability` プロパティは `Observability` インターフェースに準拠した任意の実装を受け取る。デフォルトは `genericObservability`（コンソール出力）だが、サブクラスで差し替え可能。イベント型は `BaseEvent<T, Payload>` のジェネリックで定義され、ドメイン別（Agent / MCP）に型安全に拡張されている。

### 8. @callable デコレーター: メタデータベースの RPC 公開

`@callable()` デコレーターは `WeakMap<Function, CallableMetadata>` にメタデータを登録し、WebSocket 経由の RPC で呼び出し可能なメソッドをマークする。`streaming: true` を指定すると `StreamingResponse` が第一引数に注入され、ストリーミング RPC が可能になる。デコレーターによるオプトイン設計で、意図しないメソッドの外部公開を防ぐ。

## コード例

```typescript
// packages/agents/src/mcp/x402.ts:98-101
// Object Augmentation: 既存の McpServer に paidTool メソッドを追加
export function withX402<T extends McpServer>(
  server: T,
  cfg: X402Config
): T & X402AugmentedServer {
```

```typescript
// packages/agents/src/mcp/x402.ts:285-293
// Object.defineProperty で writable: false にして安全に注入
Object.defineProperty(server, "paidTool", {
  value: paidTool,
  writable: false,
  enumerable: false,
  configurable: true,
});
return server as T & X402AugmentedServer;
```

```typescript
// packages/hono-agents/src/index.ts:21-41
// Thin Middleware Adapter: Hono ミドルウェアとして Agent ルーティングを統合
export function agentsMiddleware<E extends Env = Env>(
  ctx?: AgentMiddlewareContext<E>,
) {
  return createMiddleware<E>(async (c, next) => {
    try {
      const handler = isWebSocketUpgrade(c)
        ? handleWebSocketUpgrade
        : handleHttpRequest;
      const response = await handler(c, ctx?.options);
      return response === null ? await next() : response;
    } catch (error) {
      if (ctx?.onError) {
        ctx.onError(error as Error);
        return next();
      }
      throw error;
    }
  });
}
```

```typescript
// packages/agents/src/mcp/index.ts:28-37
// Abstract Template Method: サブクラスに server と init() の実装を強制
export abstract class McpAgent<
  Env extends Cloudflare.Env = Cloudflare.Env,
  State = unknown,
  Props extends Record<string, unknown> = Record<string, unknown>
> extends Agent<Env, State, Props> {
  private _transport?: Transport;
  props?: Props;
  abstract server: MaybePromise<McpServer | Server>;
  abstract init(): Promise<void>;
```

```typescript
// packages/agents/src/index.ts:163-174
// Decorator ベースのメソッド公開制御
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

```typescript
// packages/agents/src/experimental/forever.ts:118-124
// Mixin パターンによる機能追加
export function withFibers<TBase extends AgentLike>(
  Base: TBase,
  options?: { debugFibers?: boolean }
) {
  const debugEnabled = options?.debugFibers ?? false;
  class FiberAgent extends Base {
    // ...fiber 固有のメソッドとテーブル作成
```

```typescript
// packages/agents/src/index.ts:4123-4142
// Override 可能なファクトリメソッド: OAuth プロバイダーのカスタマイズ
// class MyAgent extends Agent {
//   createMcpOAuthProvider(callbackUrl: string): AgentMcpOAuthProvider {
//     return new MyCustomOAuthProvider(...)
//   }
// }
createMcpOAuthProvider(callbackUrl: string): AgentMcpOAuthProvider {
  return new DurableObjectOAuthClientProvider(
    this.ctx.storage,
    this.name,
    callbackUrl
  );
}
```

## パターンカタログ

- **Template Method** (分類: 振る舞い)
  - 解決する問題: 拡張フレームワークにおいて、共通の処理フローを固定しつつサブクラスに具体的な実装を委ねる
  - 適用条件: 基底クラスがトランスポート管理・接続ライフサイクルを制御し、サブクラスがビジネスロジックを定義する場合
  - コード例: `packages/agents/src/mcp/index.ts:28-37` — `McpAgent` の `abstract server` / `abstract init()`
  - 注意点: 抽象メンバーの数が増えすぎると「必須設定地獄」に陥る。cloudflare/agents は `server` と `init()` の2つに絞っている

- **Decorator** (分類: 構造)
  - 解決する問題: 既存オブジェクトのインターフェースを変更せずに機能を追加する
  - 適用条件: プロトコル（x402 支払い）のようなクロスカッティング関心事を既存 SDK オブジェクトに注入する場合
  - コード例: `packages/agents/src/mcp/x402.ts:98-293` — `withX402()` / `withX402Client()`
  - 注意点: `Object.defineProperty` でメソッドを注入するため、TypeScript の型安全性は関数のリターン型 `T & X402AugmentedServer` に依存する

- **Mixin** (分類: 構造)
  - 解決する問題: 単一継承の制約下で、複数の直交する機能セットをクラスに合成する
  - 適用条件: 実験的機能を既存クラス階層に追加する場合
  - コード例: `packages/agents/src/experimental/forever.ts:118-154` — `withFibers(Agent)`
  - 注意点: TypeScript の mixin は型推論が複雑になりやすい。`AgentLike` 型で最小限の構造的サブタイピングを要求するのが良い手法

- **Strategy** (分類: 振る舞い)
  - 解決する問題: アルゴリズムの切り替えをクライアントコードから分離する
  - 適用条件: Observability の実装切り替え、トランスポートタイプの選択
  - コード例: `packages/agents/src/observability/index.ts:12-18` — `Observability` インターフェース
  - 注意点: デフォルト実装を提供し、差し替えを任意にすることで導入障壁を下げる

## Good Patterns

- **writable: false による安全な Object Augmentation**: `withX402` は `Object.defineProperty` で `writable: false` を設定し、注入したメソッドが後から上書きされるのを防ぐ。`configurable: true` は維持しているため、テスト時にモックに差し替える柔軟性は残している。

```typescript
// packages/agents/src/mcp/x402.ts:285-290
Object.defineProperty(server, "paidTool", {
  value: paidTool,
  writable: false,
  enumerable: false,
  configurable: true,
});
```

- **Lazy Initialization with Retry Reset**: `withX402` の facilitator 接続は初回使用時まで遅延され、失敗時には `initPromise = null` でリセットしてリトライ可能にしている。

```typescript
// packages/agents/src/mcp/x402.ts:113-122
let initPromise: Promise<void> | null = null;
function ensureInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = resourceServer.initialize().catch((err) => {
      initPromise = null; // allow retry on failure
      throw err;
    });
  }
  return initPromise;
}
```

- **フレームワーク統合パッケージの分離**: Hono 統合は独立した `packages/hono-agents` パッケージにあり、85 行の薄いアダプター。コアパッケージが特定フレームワークに依存しないため、新しいフレームワーク統合を追加する際にコアの変更が不要。

- **@callable デコレーターによるオプトイン公開**: RPC で呼び出せるメソッドは明示的に `@callable()` でマークする必要があり、すべてのメソッドがデフォルトで外部公開されるリスクを排除している。`streaming: true` オプションでストリーミング対応も宣言的に指定できる。

## Anti-Patterns / 注意点

- **`Object.defineProperty` による暗黙的なインターフェース拡張**: `withX402` は実行時に `paidTool` メソッドを注入するため、TypeScript の型システムでは `T & X402AugmentedServer` という交差型でしか表現できない。IDE のオートコンプリートが効かない文脈や、リファクタリングツールが追跡できないケースがある。

```typescript
// Bad: 実行時注入のみに頼る
Object.defineProperty(server, "paidTool", { value: paidTool });
return server as T & X402AugmentedServer;

// Better: ラッパークラスで型安全にする（トレードオフとして元のインスタンスを返せなくなる）
class X402Server<T extends McpServer> {
  constructor(private inner: T, private cfg: X402Config) {}
  paidTool(...) { /* ... */ }
  // Proxy pattern で inner のメソッドを委譲
}
```

- **過度な lifecycle hook の増殖**: `Agent` クラスには 10 以上のオーバーライド可能メソッドがある。各フックの呼び出し順序と相互作用を理解するコストが高い。ドキュメントが不十分な場合、開発者はフックの優先順位を誤解しやすい。

```typescript
// Bad: フックの数を無制限に増やす
onBeforeStateChange() {}
onAfterStateChange() {}
onStateChangeRejected() {}
onStateChangeBroadcast() {}

// Better: 検証と通知の2段階に限定する（cloudflare/agents の実際の設計）
validateStateChange(nextState, source) {} // 同期、throw で拒否
onStateChanged(state, source) {}          // 非同期、通知のみ
```

- **deprecated API の長期維持コスト**: `unstable_callable`, `unstable_getSchedulePrompt`, `experimental_createMcpHandler` 等、旧名の関数が `console.warn` 付きで維持されている。これらは技術的負債だが、1回だけ警告を出す `didWarnAbout...` フラグパターンでユーザー体験への影響を抑制している。非推奨 API は次のメジャーバージョンで除去する方針を明示しているのは良い。

## 導出ルール

- `[MUST]` 外部 SDK オブジェクトを拡張する際は、元のインターフェースを破壊しない augmentation パターン（`Object.defineProperty` + 交差型）を使い、注入メソッドは `writable: false` で保護する
  - 根拠: `withX402` / `withX402Client` が McpServer / Client の既存メソッドを壊さず、かつ注入メソッドの意図しない上書きを防いでいる（`x402.ts:285-293`）

- `[MUST]` フレームワーク統合コードはコアパッケージから分離し、最小限のアダプターレイヤーとして実装する
  - 根拠: `hono-agents` パッケージは 85 行の薄いミドルウェアで、`routeAgentRequest` をラップするだけ。コアの `agents` パッケージは Hono に一切依存しない（`packages/hono-agents/src/index.ts`）

- `[MUST]` RPC やリモート呼び出しで公開するメソッドはオプトイン（明示的なマーキング）で制御し、デフォルト非公開にする
  - 根拠: `@callable()` デコレーターで明示的にマークされたメソッドのみ RPC 経由で呼び出し可能。`_isCallable` ガードが未マークメソッドの呼び出しを拒否する（`index.ts:163-174, 2517-2519`）

- `[SHOULD]` optional peer dependency で統合先を宣言し、使わない機能のインストールを強制しない
  - 根拠: `ai`, `react`, `zod`, `@x402/*` 等すべて optional。これにより最小構成（Agent + WebSocket のみ）からフル構成（AI Chat + MCP + Payments）まで同一パッケージで対応する（`package.json:51-80`）

- `[SHOULD]` ライフサイクルフックは「検証（同期・throw で拒否）」と「通知（非同期・エラーは onError 経由）」の2段階に分離する
  - 根拠: `validateStateChange` は同期で throw して状態変更を拒否でき、`onStateChanged` は非同期で通知のみ。エラーが発生しても状態永続化やブロードキャストには影響しない（`index.ts:1495-1552`）

- `[SHOULD]` 拡張性のための mixin は構造的サブタイピングで最小限のインターフェースを要求し、具象クラスへの依存を避ける
  - 根拠: `withFibers` の `AgentLike` 型は `sql`, `scheduleEvery`, `cancelSchedule`, `alarm` のみ要求し、`Agent` クラス全体には依存しない（`experimental/forever.ts:110-116`）

- `[SHOULD]` Lazy initialization で外部サービスへの接続を遅延させ、失敗時にはキャッシュをリセットしてリトライ可能にする
  - 根拠: `withX402` の facilitator 接続は `ensureInitialized()` で初回使用時まで遅延され、`catch` 内で `initPromise = null` にリセットする（`x402.ts:113-122`）

- `[AVOID]` 抽象クラスの必須メンバー（abstract property/method）を3つ以上にする。必須設定が多すぎると「ボイラープレート地獄」に陥る
  - 根拠: `McpAgent` は `server` と `init()` の2つだけを abstract にし、トランスポート選択やセッション管理は基底クラスが処理する。拡張者は本質的なロジックだけ実装すればよい（`mcp/index.ts:28-37`）

- `[AVOID]` deprecated API を警告なしで維持する。非推奨メソッドには1回限りの `console.warn` と除去予定バージョンを明記する
  - 根拠: `unstable_callable`, `experimental_createMcpHandler` 等すべてに `console.warn` + "will be removed in the next major version" が付いている（`index.ts:183-191`, `mcp/handler.ts:128-143`）

## 適用チェックリスト

- [ ] SDK を設計する際、外部オブジェクトへの機能追加は augmentation パターン（`withXxx` 関数 + 交差型）を検討しているか
- [ ] フレームワーク統合（Hono, Express, Next.js 等）はコアパッケージから分離した薄いアダプターとして実装しているか
- [ ] RPC / リモート呼び出し可能なメソッドはデコレーターやメタデータでオプトイン制御しているか
- [ ] 統合先ライブラリは optional peer dependency として宣言し、最小構成でも動作するか
- [ ] ライフサイクルフックは「検証」と「通知」の2段階に分離し、通知のエラーがコアフローを阻害しないか
- [ ] 外部サービスへの接続は lazy initialization で遅延し、失敗時のリトライパスを確保しているか
- [ ] 非推奨 API には1回限りの警告と除去予定バージョンが明記されているか
- [ ] Mixin で機能追加する場合、構造的サブタイピングで最小限のインターフェースのみ要求しているか
