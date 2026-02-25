# MCP Protocol Integration

> リポジトリ: cloudflare/agents
> 分析日: 2026-02-25

## 概要

cloudflare/agents は MCP (Model Context Protocol) のサーバーとクライアントの両面を単一フレームワークで実装しており、3 種類のトランスポート（SSE・Streamable HTTP・RPC）を Durable Objects 上で統一的に扱う設計を持つ。MCP SDK のトランスポートインターフェースを Cloudflare Workers/Durable Objects 環境に適合させるためのアダプタ層、セッション管理、OAuth フロー、ハイバネーション復元、さらに x402 決済プロトコルの統合といった複数の横断的プラクティスが注目に値する。

## 背景にある原則

- **プロトコルとインフラの分離**: MCP SDK の `Transport` インターフェースを満たすアダプタクラスを作成し、MCP プロトコルの実装ロジックと Cloudflare Workers/Durable Objects の接続管理（WebSocket、TransformStream）を完全に分離している。これにより SDK のアップデートに追従しやすく、インフラ固有のコードがプロトコル層に漏れない。（`packages/agents/src/mcp/transport.ts` 全体、`worker-transport.ts` 全体）

- **名前ベースのルーティングによるステート分離**: Durable Object の名前に `<transport>:<sessionId>` のエンコーディングを使い、1 セッション = 1 DO インスタンスを保証する。これにより状態管理の複雑さを DO の単一アクター保証に委ねることができる。（`packages/agents/src/mcp/index.ts:55-68`）

- **段階的フォールバックと自動ネゴシエーション**: クライアント側の `auto` トランスポートモードで streamable-http を先に試行し、404/405 なら SSE にフォールバックする。プロトコルの進化に追従しながら後方互換性を維持するパターン。（`packages/agents/src/mcp/client-connection.ts:639-688`）

- **Decorator パターンによるプロトコル拡張**: `withX402()` / `withX402Client()` が MCP の Server/Client をラップし、決済機能を追加する。元のオブジェクトの型を維持しつつ機能を付加するこのパターンは、プロトコル層のクロスカッティング・コンサーンに対する汎用的な解法。（`packages/agents/src/mcp/x402.ts:98-294`, `334-502`）

## 実例と分析

### サーバー側: 3 トランスポートの統一的な抽象化

McpAgent は `initTransport()` メソッドで Transport インターフェースの実装を切り替える。トランスポートの種別は DO の名前から決定される（`getTransportType()`）。

SSE トランスポート (`McpSSETransport`) は WebSocket 接続を介してメッセージを送受信する。Durable Object がハイバネーション可能な形で WebSocket を管理するため、transport 側は接続ライフサイクルを管理しない。

Streamable HTTP トランスポート (`StreamableHTTPServerTransport`) は POST リクエストのメッセージを処理し、レスポンスを SSE ストリームとして返す。connection の state に `requestIds` を保持し、全レスポンスが揃ったら SSE ストリームを閉じる。

RPC トランスポート (`RPCServerTransport` / `RPCClientTransport`) は Durable Object の RPC スタブを直接使い、HTTP/WebSocket を介さずに DO 間通信を行う。`handleMcpMessage` メソッドを直接呼び出し、Promise ベースの同期的な request-response を実現する。

### Worker モード: DO なしの軽量サーバー

`createMcpHandler()` は Durable Object を使わず、単一の Worker fetch ハンドラとして MCP サーバーを提供する。`WorkerTransport` が Streamable HTTP のフル仕様を実装し、`MCPStorageApi` を通じてセッション状態を外部ストレージに永続化できる。

重要な設計判断として、リクエストごとに新しい `McpServer` インスタンスを作成することを強制している。既に接続済みのサーバーに対して再接続しようとすると明示的にエラーを投げる：

```typescript
// packages/agents/src/mcp/handler.ts:89-93
if (isServerConnected) {
  throw new Error(
    "Server is already connected to a transport. Create a new McpServer instance per request for stateless handlers.",
  );
}
```

### クライアント側: MCPClientManager によるマルチサーバー管理

`MCPClientManager` は複数の MCP サーバー接続を集約し、ツール・リソース・プロンプトの統一ビューを提供する。SQL ストレージ（`cf_agents_mcp_servers` テーブル）にサーバー情報を永続化し、DO ハイバネーション後の復元を可能にしている。

接続状態は明確なステートマシンで管理される：

```
init → CONNECTING → CONNECTED → DISCOVERING → READY
     → AUTHENTICATING → (callback) → CONNECTING → ...
     → FAILED (any state からの遷移可能)
```

### WebSocket ブリッジパターン

Streamable HTTP トランスポートのハンドラ (`createStreamingHttpHandler`) は、外部クライアントへの SSE レスポンスと DO への WebSocket 接続をブリッジする。POST リクエストの本体を base64 エンコードしてカスタムヘッダー (`cf-mcp-message`) に載せ、WebSocket Upgrade リクエストとして DO に送信する。DO 内部のトランスポートが処理した結果は、専用メッセージタイプ (`CF_MCP_AGENT_EVENT`) で WebSocket 経由で返り、ハンドラがそれを SSE イベントに変換してクライアントに返す。

### AsyncLocalStorage による認証コンテキスト伝搬

`auth-context.ts` は Node.js の `AsyncLocalStorage` を使って、MCP リクエスト処理中に認証情報を暗黙的に伝搬する。これにより MCP ツールのコールバック内で明示的な引数なしに認証済みユーザー情報にアクセスできる。

### メッセージインターセプタパターン

`StreamableHTTPServerTransport` の `messageInterceptor` は、メッセージが `onmessage` に渡される前にインターセプトできるフックポイント。McpAgent はこれを elicitation レスポンスの横取りに使っている。インターセプタが `true` を返すと通常のメッセージ処理をスキップする。

## コード例

### Transport インターフェースのアダプタ実装

```typescript
// packages/agents/src/mcp/transport.ts:25-71
export class McpSSETransport implements Transport {
  sessionId: string;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

  private _getWebSocket: () => WebSocket | null;
  private _started = false;
  constructor() {
    const { agent } = getCurrentAgent<McpAgent>();
    if (!agent) {
      throw new Error("McpAgent was not found in Transport constructor");
    }

    this.sessionId = agent.getSessionId();
    this._getWebSocket = () => agent.getWebSocket();
  }

  async start() {
    if (this._started) {
      throw new Error("Transport already started");
    }
    this._started = true;
  }

  async send(message: JSONRPCMessage) {
    if (!this._started) {
      throw new Error("Transport not started");
    }
    const websocket = this._getWebSocket();
    if (!websocket) {
      throw new Error("WebSocket not connected");
    }
    try {
      websocket.send(JSON.stringify(message));
    } catch (error) {
      this.onerror?.(error as Error);
    }
  }

  async close() {
    this.onclose?.();
  }
}
```

### DO 名前ベースのトランスポート判別

```typescript
// packages/agents/src/mcp/index.ts:55-68
getTransportType(): BaseTransportType {
  const [t, ..._] = this.name.split(":");
  switch (t) {
    case "sse":
      return "sse";
    case "streamable-http":
      return "streamable-http";
    case "rpc":
      return "rpc";
    default:
      throw new Error(
        "Invalid transport type. McpAgent must be addressed with a valid protocol."
      );
  }
}
```

### auto トランスポートフォールバック

```typescript
// packages/agents/src/mcp/client-connection.ts:639-681
private async tryConnect(
  transportType: TransportType
): Promise<MCPClientConnectionResult> {
  const transports: BaseTransportType[] =
    transportType === "auto" ? ["streamable-http", "sse"] : [transportType];

  for (const currentTransportType of transports) {
    const isLastTransport =
      currentTransportType === transports[transports.length - 1];
    const hasFallback =
      transportType === "auto" &&
      currentTransportType === "streamable-http" &&
      !isLastTransport;

    const transport = this.getTransport(currentTransportType);

    try {
      await this.client.connect(transport);
      return {
        state: MCPConnectionState.CONNECTED,
        transport: currentTransportType
      };
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));

      if (isUnauthorized(error)) {
        return { state: MCPConnectionState.AUTHENTICATING };
      }

      if (isTransportNotImplemented(error) && hasFallback) {
        continue;
      }

      return { state: MCPConnectionState.FAILED, error };
    }
  }

  return {
    state: MCPConnectionState.FAILED,
    error: new Error("No transports available")
  };
}
```

### Decorator パターンによるプロトコル拡張

```typescript
// packages/agents/src/mcp/x402.ts:98-101
export function withX402<T extends McpServer>(
  server: T,
  cfg: X402Config,
): T & X402AugmentedServer {
  // ...
  Object.defineProperty(server, "paidTool", {
    value: paidTool,
    writable: false,
    enumerable: false,
    configurable: true,
  });
  return server as T & X402AugmentedServer;
}
```

### セッション状態の永続化と復元

```typescript
// packages/agents/src/mcp/worker-transport.ts:127-150
private async restoreState() {
  if (!this.storage || this.stateRestored) {
    return;
  }

  const state = await Promise.resolve(this.storage.get());

  if (state) {
    this.sessionId = state.sessionId;
    this.initialized = state.initialized;

    // Restore _clientCapabilities on the Server instance
    // by replaying the original initialize request
    if (state.initializeParams && this.onmessage) {
      this.onmessage({
        jsonrpc: "2.0",
        id: RESTORE_REQUEST_ID,
        method: "initialize",
        params: state.initializeParams
      });
    }
  }

  this.stateRestored = true;
}
```

## パターンカタログ

- **Adapter パターン** (構造)
  - 解決する問題: MCP SDK の Transport インターフェースと Cloudflare Workers/Durable Objects の接続モデルの不一致
  - 適用条件: 外部プロトコル SDK をプラットフォーム固有のインフラに統合する場合
  - コード例: `packages/agents/src/mcp/transport.ts:25-71` (McpSSETransport), `worker-transport.ts:89-938` (WorkerTransport)
  - 注意点: アダプタは薄く保ち、ビジネスロジックを入れない。SDK のメジャーアップデートで破綻しやすいため、SDK のインターフェース変更をモニタリングすること

- **Strategy パターン** (振る舞い)
  - 解決する問題: 複数のトランスポート方式を実行時に選択する必要がある
  - 適用条件: 同じプロトコルに対して複数の通信方式を提供する場合
  - コード例: `packages/agents/src/mcp/index.ts:112-128` (initTransport), `client-connection.ts:618-637` (getTransport)
  - 注意点: Strategy 切り替え時に DO 名前エンコーディングなど外部的な選択メカニズムを持つ設計が必要

- **Decorator パターン** (構造)
  - 解決する問題: 既存の MCP Server/Client に決済機能やその他のクロスカッティング・コンサーンを追加する
  - 適用条件: プロトコルの基本機能に横断的機能を付加する場合（認証、決済、ロギング等）
  - コード例: `packages/agents/src/mcp/x402.ts:98-294` (withX402), `334-502` (withX402Client)
  - 注意点: `Object.defineProperty` で immutable に追加し、元のメソッドを `bind` で保持することで呼び出し元コンテキストの喪失を防ぐ

- **State Machine パターン** (振る舞い)
  - 解決する問題: MCP クライアント接続のライフサイクル管理（認証、接続、ディスカバリ、準備完了）
  - 適用条件: 非同期の多段階プロセスを状態として管理する場合
  - コード例: `packages/agents/src/mcp/client-connection.ts:56-76` (MCPConnectionState)
  - 注意点: 各状態からの遷移可能先を明確にし、不正な遷移にはガード条件を設ける

- **Interceptor パターン** (振る舞い)
  - 解決する問題: メッセージ処理パイプラインの途中で特定メッセージを横取りする
  - 適用条件: プロトコルメッセージの流れに対して選択的な前処理が必要な場合
  - コード例: `packages/agents/src/mcp/transport.ts:107-115` (messageInterceptor)
  - 注意点: インターセプタは副作用を最小限にし、handled/unhandled の判定を boolean で返す設計にする

## Good Patterns

- **初期化リクエストの永続化と再生**: `McpAgent.setInitializeRequest()` で初期化リクエストを Durable Object ストレージに保存し、ハイバネーション復帰時に `reinitializeServer()` で再生する。これにより MCP SDK のサーバーが初期化状態を復元でき、ステートフルなセッションがインフラの休止を透過的に跨げる。WorkerTransport でも同様に `restoreState()` で initialize パラメータを保存・再生している。

```typescript
// packages/agents/src/mcp/index.ts:136-144
async reinitializeServer() {
  const initializeRequest = await this.getInitializeRequest();
  if (initializeRequest) {
    this._transport?.onmessage?.(initializeRequest);
  }
}
```

- **Capability-gated ディスカバリ**: サーバーが advertise した capabilities のみをディスカバリ対象にする。`Promise.all` で並列実行し、`_capabilityErrorHandler` でサーバーの不正な capability 宣言（advertise はしたが Method not found を返す）を graceful に処理する。

```typescript
// packages/agents/src/mcp/client-connection.ts:297-313
if (this.serverCapabilities.tools) {
  operations.push(this.registerTools());
  operationNames.push("tools");
}
if (this.serverCapabilities.resources) {
  operations.push(this.registerResources());
  operationNames.push("resources");
}
```

- **遅延初期化による起動コスト削減**: `MCPClientManager.ensureJsonSchema()` で AI SDK の `jsonSchema` を遅延ロードする。モジュールスコープでの import は Workers の起動時間を悪化させるため、実際にツール統合が必要になるまでロードを遅延する。

- **Elicitation のストレージポーリング実装**: `elicitInput()` では、リクエストを送信後、Durable Object ストレージを 100ms 間隔でポーリングしてレスポンスを待つ。WebSocket やコールバックに依存せず、DO のストレージ一貫性保証を活用したシンプルな実装。finally 句でのクリーンアップも適切。

```typescript
// packages/agents/src/mcp/index.ts:307-336
private async _waitForElicitationResponse(
  requestId: string
): Promise<ElicitResult> {
  const startTime = Date.now();
  const timeout = 60000;
  try {
    while (Date.now() - startTime < timeout) {
      const response = await this.ctx.storage.get<ElicitResult>(
        `elicitation:response:${requestId}`
      );
      if (response) {
        await this.ctx.storage.delete(`elicitation:${requestId}`);
        await this.ctx.storage.delete(`elicitation:response:${requestId}`);
        return response;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Elicitation request timed out");
  } finally {
    await this.ctx.storage.delete(`elicitation:${requestId}`);
    await this.ctx.storage.delete(`elicitation:response:${requestId}`);
  }
}
```

## Anti-Patterns / 注意点

- **ステートレスハンドラでのサーバー共有**: `createMcpHandler` はステートレス Worker 向けだが、グローバルな McpServer インスタンスを複数リクエストで共有しようとすると MCP SDK がエラーを投げる。Worker モードでは必ずリクエストごとに新しいサーバーインスタンスを作成する必要がある。

```typescript
// Bad: グローバルサーバーの共有
const server = new McpServer({ name: "My Server", version: "1.0.0" });
export default {
  fetch: createMcpHandler(server), // 2回目のリクエストでエラー
};

// Better: リクエストごとに新しいインスタンス
export default {
  fetch: (req, env, ctx) => {
    const server = new McpServer({ name: "My Server", version: "1.0.0" });
    // ツール登録...
    return createMcpHandler(server)(req, env, ctx);
  },
};
```

- **トランスポートタイプのハードコード**: クライアント接続で `type` を指定しないと暗黙的に `"auto"` が使われ、streamable-http を試行してからフォールバックする。接続先のプロトコルが既知の場合は明示的にトランスポートタイプを指定しないと、無駄な接続試行が発生する。

```typescript
// Bad: 暗黙の auto フォールバック
await this.addMcpServer("server", url);

// Better: 既知のプロトコルを明示
await this.addMcpServer("server", url, {
  transport: { type: "streamable-http" },
});
```

- **ディスカバリ結果のキャッシュ欠如**: `discoverAndRegister()` は毎回サーバーに問い合わせる。`listChanged` 通知ハンドラは登録されているが、通知に対応していないサーバーでは手動での再ディスカバリが必要。高頻度での再接続・再ディスカバリはサーバー負荷の原因になりうる。

## 導出ルール

- `[MUST]` MCP サーバーをステートレス Worker で実装する場合、リクエストごとに新しい McpServer インスタンスを作成すること。MCP SDK はサーバーが単一トランスポートにしか接続できない制約を持つ
  - 根拠: `handler.ts:89-93` でサーバーの二重接続を明示的に禁止しており、違反時にランタイムエラーが発生する

- `[MUST]` 複数トランスポートを提供するプロトコルサーバーでは、トランスポート選択ロジックをメッセージ処理から分離し、Strategy パターンで切り替えること。トランスポート固有のコードがプロトコル処理に混入すると、新トランスポート追加時の変更が全体に波及する
  - 根拠: `index.ts:112-128` の `initTransport()` がトランスポート選択を一箇所に集約し、各 Transport クラスが共通インターフェースを実装している

- `[MUST]` セッションベースのプロトコルサーバーで休止・再起動が発生する場合、初期化リクエスト（ハンドシェイク結果）を永続化し、復帰時に再生すること。サーバーの内部状態が失われるとセッション全体が無効になる
  - 根拠: `index.ts:136-144` の `reinitializeServer()` と `worker-transport.ts:127-150` の `restoreState()` で初期化パラメータの永続化・再生を行っている

- `[SHOULD]` 自動トランスポートネゴシエーションを実装する場合、新しいプロトコルから順に試行し、HTTP ステータスコード（404, 405）でフォールバック判定すること。エラーメッセージの文字列マッチではなく構造化されたエラーコードで判定する方が堅牢
  - 根拠: `errors.ts:28-39` の `isTransportNotImplemented()` がステータスコード優先でフォールバック判定を行い、文字列マッチはフォールバックとして使用している

- `[SHOULD]` プロトコルクライアントの接続ライフサイクルを明示的なステートマシンで管理し、各状態で許可される操作をガード条件で制御すること。非同期の多段階プロセスでは暗黙の状態管理がバグの温床になる
  - 根拠: `client-connection.ts:56-76` の `MCPConnectionState` が状態遷移を定義し、`discover()` が状態チェックを行ってから処理を開始する

- `[SHOULD]` プロトコルレベルのクロスカッティング・コンサーン（認証、決済、ロギング）は Decorator パターンで既存の Server/Client インスタンスに付加すること。サブクラス化は SDK アップデートとの互換性を損なう
  - 根拠: `x402.ts` が `withX402()` / `withX402Client()` で `Object.defineProperty` を使い、元の型を保持しながらメソッドを追加している

- `[AVOID]` WebSocket / SSE のストリーム接続管理ロジックを Transport アダプタの中に実装すること。接続ライフサイクル（接続確立・ハイバネーション・再接続）はインフラ層に委ね、Transport はメッセージの送受信のみに集中させる
  - 根拠: `McpSSETransport` は WebSocket の取得を `getCurrentAgent()` 経由のコールバックに委ね、`start()` / `close()` は実質 no-op としている。接続管理を Durable Object のライフサイクルに完全に委任

## 適用チェックリスト

- [ ] MCP サーバーを実装する場合、ステートフル（DO ベース）とステートレス（Worker ベース）のどちらが適切か判断したか
- [ ] Transport インターフェースのアダプタを実装する際、プラットフォーム固有の接続管理コードがアダプタ外に分離されているか
- [ ] セッション管理が必要な場合、初期化リクエストの永続化と復帰時の再生メカニズムが用意されているか
- [ ] 複数トランスポートをサポートする場合、Strategy パターンで選択ロジックが一箇所に集約されているか
- [ ] クライアント側で自動ネゴシエーションを実装する場合、フォールバック順序と判定条件（HTTP ステータスコード）が明確か
- [ ] 接続ライフサイクルがステートマシンとして定義され、不正な状態遷移にガード条件が設けられているか
- [ ] プロトコル拡張（認証・決済等）が Decorator パターンで実装され、元のオブジェクトの型と互換性が保たれているか
- [ ] Worker/DO のハイバネーションからの復帰時に、MCP 接続の再確立とサーバーディスカバリが自動実行されるか
- [ ] CORS ヘッダーの設定が、MCP 固有のヘッダー（`mcp-session-id`, `MCP-Protocol-Version`）を含んでいるか
