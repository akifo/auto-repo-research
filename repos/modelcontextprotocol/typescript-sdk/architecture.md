# architecture

> リポジトリ: modelcontextprotocol/typescript-sdk
> 分析日: 2026-02-24

## 概要

MCP TypeScript SDK の階層アーキテクチャを分析する。Protocol 抽象クラスを中核とした双方向メッセージルーティング、Transport インターフェースによる通信抽象化、Capability negotiation による機能制御の3つの設計軸が、プロトコル SDK として高い拡張性と安全性を両立している。特に「対称的な Client/Server 継承」と「3層抽象（Transport -> Protocol -> High-Level API）」の組み合わせは、双方向 RPC プロトコルの実装パターンとして汎用的に参考になる。

## 背景にある原則

- **対称性原則**: Client と Server は同一の Protocol 基底クラスを継承し、双方がリクエストの送信と受信の両方を行える。これにより、サーバーからクライアントへの逆方向リクエスト（sampling, elicitation）を自然に実現している。「リクエスト送信側とハンドラ側が常に同一プロセスに共存する」という前提を置くことで、1つの抽象で双方向通信を統一的に扱える（`packages/core/src/shared/protocol.ts:392`）。

- **Contract-First 層分離**: Transport（メッセージの送受信方法）、Protocol（メッセージルーティングと相関管理）、High-Level API（ドメインロジック）の3層を厳格に分離し、各層のインターフェースを最小に保っている。Transport は `start/send/close/onmessage` の4メソッドのみ、Protocol は抽象メソッド5個で拡張ポイントを制約している（`packages/core/src/shared/transport.ts:74-134`）。

- **Capability Gate**: すべてのリクエスト送信・ハンドラ登録・通知送信の前に、相手側が対応する能力を宣言しているかをチェックする。このガードにより、未対応機能の呼び出しがランタイムエラーではなく、早期に明確なエラーメッセージで検出される（`protocol.ts:1002-1030` の5つの abstract assert メソッド）。

- **Composition over Inheritance（高レベル API 層）**: McpServer は Server を継承せず、内部に `public readonly server: Server` として保持する。継承ではなく委譲を選ぶことで、Server の Protocol 継承ツリーを汚染せず、高レベル API を自由に設計できる（`packages/server/src/server/mcp.ts:66-81`）。

## 実例と分析

### 3層アーキテクチャの責務分離

SDK は Transport -> Protocol -> High-Level API の3層で構成され、各層が明確な責務を持つ。

**Transport 層**（通信の物理的な送受信）: `Transport` インターフェースは5つのメンバーのみで構成される。stdio, Streamable HTTP, SSE, WebSocket という異なる通信手段をすべて同一のインターフェースに収める。`onmessage` コールバック1つで全メッセージを Protocol 層に渡すため、Transport は JSON-RPC のリクエスト/レスポンスの区別を知る必要がない。

**Protocol 層**（メッセージルーティング・状態管理）: `onmessage` で受信したメッセージを型判別関数（`isJSONRPCRequest`, `isJSONRPCResultResponse`, `isJSONRPCErrorResponse`, `isJSONRPCNotification`）で分類し、対応する内部ハンドラに振り分ける。リクエスト/レスポンスの相関は `_requestMessageId` のインクリメンタル ID と `_responseHandlers` Map で管理される。

**High-Level API 層**（ドメインロジック）: Client は `listTools()`, `callTool()` などの型安全な便利メソッドを提供し、内部で `this.request()` を呼ぶだけ。McpServer は `registerTool()`, `registerPrompt()` でハンドラ登録を宣言的に行い、Server の `setRequestHandler` への変換を隠蔽する。

### Protocol 基底クラスの設計

Protocol クラスは5つの Map を中核データ構造として持ち、メッセージの双方向フローを制御する。

```
_requestHandlers:   method名 -> ハンドラ     (受信リクエストの処理)
_notificationHandlers: method名 -> ハンドラ  (受信通知の処理)
_responseHandlers:  messageId -> コールバック (送信リクエストへの応答待ち)
_progressHandlers:  messageId -> コールバック (進捗通知の受信)
_timeoutInfo:       messageId -> タイムアウト情報
```

この Map ベースのルーティングにより、メソッド名の追加だけで新しいリクエストタイプを拡張でき、ルーティングロジック自体の変更は不要になる。

### Template Method パターンによる拡張制御

Protocol は5つの `abstract` メソッドで子クラスの拡張ポイントを厳格に制御する。

```
assertCapabilityForMethod()      → 送信リクエストの能力チェック
assertNotificationCapability()   → 送信通知の能力チェック
assertRequestHandlerCapability() → ハンドラ登録の能力チェック
assertTaskCapability()           → タスク作成の能力チェック
assertTaskHandlerCapability()    → タスクハンドラの能力チェック
```

Client と Server はこれらを `switch` 文で実装し、自側/相手側のどちらの能力を検証すべきかを制御する。Client は `assertCapabilityForMethod` でサーバーの能力を、`assertRequestHandlerCapability` でクライアント自身の能力を検証する。Server はその逆。

### エラー体系の二重化

エラーを「ワイヤーを渡るもの」と「渡らないもの」に明確に分離している。

- `ProtocolError`: JSON-RPC エラーレスポンスとしてシリアライズされ、相手側に送信される。数値エラーコード（`ProtocolErrorCode` enum）を使用
- `SdkError`: ローカルでのみ throw される。文字列エラーコード（`SdkErrorCode` enum）で開発者体験を重視

この分離により、SDK 利用者は `catch` ブロックで `instanceof` チェックするだけで、エラーの性質（プロトコルレベルかローカルかか）を即座に判別できる。

### Transport の所有権移転

Protocol の `connect()` メソッドは Transport の `onmessage`, `onclose`, `onerror` コールバックを完全に上書きするが、既存のコールバックをチェーンする。

## コード例

```typescript
// packages/core/src/shared/protocol.ts:687-718
async connect(transport: Transport): Promise<void> {
    this._transport = transport;
    const _onclose = this.transport?.onclose;
    this._transport.onclose = () => {
        _onclose?.();
        this._onclose();
    };

    const _onerror = this.transport?.onerror;
    this._transport.onerror = (error: Error) => {
        _onerror?.(error);
        this._onerror(error);
    };

    const _onmessage = this._transport?.onmessage;
    this._transport.onmessage = (message, extra) => {
        _onmessage?.(message, extra);
        if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
            this._onresponse(message);
        } else if (isJSONRPCRequest(message)) {
            this._onrequest(message, extra);
        } else if (isJSONRPCNotification(message)) {
            this._onnotification(message);
        } else {
            this._onerror(new Error(`Unknown message type: ${JSON.stringify(message)}`));
        }
    };

    transport.setSupportedProtocolVersions?.(this._supportedProtocolVersions);
    await this._transport.start();
}
```

```typescript
// packages/core/src/shared/transport.ts:74-134
export interface Transport {
  start(): Promise<void>;
  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void>;
  close(): Promise<void>;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  sessionId?: string;
  setProtocolVersion?: (version: string) => void;
  setSupportedProtocolVersions?: (versions: string[]) => void;
}
```

```typescript
// packages/server/src/server/mcp.ts:66-82
export class McpServer {
  public readonly server: Server;
  private _registeredResources: { [uri: string]: RegisteredResource; } = {};
  private _registeredResourceTemplates: { [name: string]: RegisteredResourceTemplate; } = {};
  private _registeredTools: { [name: string]: RegisteredTool; } = {};
  private _registeredPrompts: { [name: string]: RegisteredPrompt; } = {};

  constructor(serverInfo: Implementation, options?: ServerOptions) {
    this.server = new Server(serverInfo, options);
  }
  // ...
  async connect(transport: Transport): Promise<void> {
    return await this.server.connect(transport);
  }
}
```

```typescript
// packages/client/src/client/client.ts:471-523 (初期化ハンドシェイク)
override async connect(transport: Transport, options?: RequestOptions): Promise<void> {
    await super.connect(transport);
    if (transport.sessionId !== undefined) {
        return; // 再接続時はスキップ
    }
    try {
        const result = await this.request(
            {
                method: 'initialize',
                params: {
                    protocolVersion: this._supportedProtocolVersions[0] ?? LATEST_PROTOCOL_VERSION,
                    capabilities: this._capabilities,
                    clientInfo: this._clientInfo
                }
            },
            InitializeResultSchema,
            options
        );
        // ... バージョン検証、能力保存
        this._serverCapabilities = result.capabilities;
        await this.notification({ method: 'notifications/initialized' });
    } catch (error) {
        void this.close();
        throw error;
    }
}
```

## パターンカタログ

- **Template Method** (分類: 振る舞い)
  - 解決する問題: 基底クラスのアルゴリズム骨格を固定しつつ、サブクラスで特定ステップ（能力チェック）を差し替える
  - 適用条件: リクエスト送信/ハンドラ登録のフローは共通だが、どの能力を検証するかが Client/Server で異なる
  - コード例: `packages/core/src/shared/protocol.ts:1002-1030` (5つの abstract assert メソッド)
  - 注意点: abstract メソッドの数が増えすぎると実装コストが上がる。現在5個で安定

- **Mediator** (分類: 振る舞い)
  - 解決する問題: 多数のメッセージタイプ間の通信を中央のオブジェクトが仲介し、各ハンドラ同士の直接依存を排除する
  - 適用条件: リクエスト/レスポンス/通知/進捗という異なるメッセージフローを単一クラスが制御する
  - コード例: `packages/core/src/shared/protocol.ts:392-438` (Protocol クラスの Map ベース振り分け)
  - 注意点: Protocol クラスが肥大化しやすい（現在 1700 行超）。Task 関連の責務をさらに分離する余地がある

- **Strategy** (分類: 振る舞い)
  - 解決する問題: 通信手段を差し替え可能にする
  - 適用条件: 同一プロトコルで stdio / HTTP / WebSocket を使い分ける
  - コード例: `packages/core/src/shared/transport.ts:74-134` (Transport インターフェース)
  - 注意点: インターフェースが薄すぎると Transport 間の差異を吸収しきれない。`sessionId`, `setProtocolVersion` 等の optional メンバーがその調整弁

- **Facade** (分類: 構造)
  - 解決する問題: Protocol + Server の低レベル API を隠蔽し、宣言的なツール/プロンプト登録 API を提供する
  - 適用条件: SDK 利用者が JSON-RPC の詳細を意識せずにサーバーを構築したい
  - コード例: `packages/server/src/server/mcp.ts:66` (McpServer クラス)
  - 注意点: `public readonly server` で低レベルアクセスも許容している（Escape Hatch パターン）

## Good Patterns

- **Capability Gate パターン**: リクエスト送信・ハンドラ登録・通知送信のすべてのパスで、事前に能力チェックを強制する。これにより「サーバーが対応していない機能を呼んでタイムアウトする」という難解な障害を、即座に明確なエラーメッセージに変換できる。

```typescript
// packages/client/src/client/client.ts:546-606
protected assertCapabilityForMethod(method: RequestMethod): void {
    switch (method as ClientRequest['method']) {
        case 'tools/call':
        case 'tools/list': {
            if (!this._serverCapabilities?.tools) {
                throw new SdkError(
                    SdkErrorCode.CapabilityNotSupported,
                    `Server does not support tools (required for ${method})`
                );
            }
            break;
        }
        // ... 他の method も同様
    }
}
```

- **コールバックチェーンによる所有権移転**: Transport の所有権を Protocol に移転する際、既存のコールバックを保持してチェーンする。これにより、Transport に事前設定されたコールバック（認証処理等）が失われない。

```typescript
// packages/core/src/shared/protocol.ts:689-693
const _onclose = this.transport?.onclose;
this._transport.onclose = () => {
  _onclose?.(); // 既存コールバックを先に呼ぶ
  this._onclose();
};
```

- **Microtask デバウンス**: `notifications/tools/list_changed` のようなバースト通知を `Promise.resolve().then()` で次のマイクロタスクに遅延し、同一イベントループ内の複数回の呼び出しを1回に集約する。`setTimeout(0)` ではなく microtask を使うことで、遅延を最小限に抑えつつ確実にバッチ化する。

```typescript
// packages/core/src/shared/protocol.ts:1386-1424
if (canDebounce) {
  if (this._pendingDebouncedNotifications.has(notification.method)) {
    return;
  }
  this._pendingDebouncedNotifications.add(notification.method);
  Promise.resolve().then(() => {
    this._pendingDebouncedNotifications.delete(notification.method);
    if (!this._transport) return;
    // ... send
  });
  return;
}
```

- **Escape Hatch パターン**: McpServer は高レベル API を提供しつつ、`public readonly server` で低レベル Server インスタンスを公開する。これにより、SDK が想定しないカスタマイズも可能にしている。

```typescript
// packages/server/src/server/mcp.ts:70
public readonly server: Server;
```

## Anti-Patterns / 注意点

- **God Class 傾向**: Protocol クラスが 1700 行を超え、メッセージルーティング・タイムアウト管理・タスクキュー管理・進捗通知管理・デバウンスの責務を一手に担っている。特に Task 関連コード（`_taskStore`, `_taskMessageQueue`, `_waitForTaskUpdate` 等）の追加が肥大化の主因。

```typescript
// Bad: Protocol クラスの private フィールド数（protocol.ts:393-411）
private _transport?: Transport;
private _requestMessageId = 0;
private _requestHandlers: Map<...>;
private _requestHandlerAbortControllers: Map<...>;
private _notificationHandlers: Map<...>;
private _responseHandlers: Map<...>;
private _progressHandlers: Map<...>;
private _timeoutInfo: Map<...>;
private _pendingDebouncedNotifications = new Set<string>();
private _taskProgressTokens: Map<...>;
private _taskStore?: TaskStore;
private _taskMessageQueue?: TaskMessageQueue;
private _requestResolvers: Map<...>;
```

```typescript
// Better: タスク管理を別クラスに分離
class TaskManager {
  private _taskStore: TaskStore;
  private _taskMessageQueue: TaskMessageQueue;
  private _taskProgressTokens: Map<string, number>;
  // タスク関連ロジックを集約
}
```

- **switch ベースの能力チェック**: `assertCapabilityForMethod` が method 名の switch 文で実装されており、新しい method 追加時に Client と Server の両方で switch を修正する必要がある。ただし、プロトコルの method 追加は仕様変更を伴うため、実際には許容範囲内。

```typescript
// Bad: 新しい method を追加するたびに switch case を追加
protected assertCapabilityForMethod(method: RequestMethod): void {
    switch (method) {
        case 'tools/call': // ...
        case 'prompts/get': // ...
        // 新しい method を追加するたびにここに case を追加
    }
}
```

```typescript
// Better: method -> capability のマッピングテーブル（ただしプロトコル SDK では switch の方が明示的で安全な場合も多い）
const METHOD_CAPABILITIES: Record<string, keyof ServerCapabilities> = {
  "tools/call": "tools",
  "prompts/get": "prompts",
};
```

## 導出ルール

- `[MUST]` 双方向 RPC プロトコルでは、共通基底クラスに送受信ロジックを統一し、Client/Server をその対称的なサブクラスとして実装する
  - 根拠: Protocol クラスがリクエスト送信 (`request()`) とハンドラ登録 (`setRequestHandler()`) を同一クラスに持つことで、Server->Client 逆方向リクエスト（sampling 等）を追加コストなしに実現している（`protocol.ts:392`, `client.ts:195`, `server.ts:89`）

- `[MUST]` プロトコル層と通信層を分離し、通信層のインターフェースは `start/send/close/onmessage` 程度の最小契約に留める
  - 根拠: Transport インターフェースが 5 メソッドに絞られているため、stdio/HTTP/WebSocket の4つの Transport 実装が同一の Protocol コードで動作する（`transport.ts:74-134`）

- `[MUST]` 能力未宣言の機能呼び出しはサイレントに失敗させず、即座に明確なエラーメッセージで拒否する
  - 根拠: `assertCapabilityForMethod` 等のガード関数により「サーバーが対応していない機能を呼んでタイムアウト」という難解な障害パターンを排除している（`client.ts:546-606`, `server.ts:246-277`）

- `[SHOULD]` 高レベル API は低レベル実装を継承ではなく委譲（composition）で包み、`escape hatch` として低レベルインスタンスを公開する
  - 根拠: McpServer は Server を `public readonly server` として保持し、通常は `registerTool()` 等の宣言的 API を使いつつ、必要時に `server.setRequestHandler()` で直接制御できる（`mcp.ts:66-82`）

- `[SHOULD]` ワイヤーを渡るエラー（プロトコルエラー）とローカルエラー（SDK エラー）を別クラスに分離し、異なるコード体系を使う
  - 根拠: `ProtocolError`（数値コード、JSON-RPC 準拠）と `SdkError`（文字列コード、開発者体験重視）の分離により、`catch` ブロックの `instanceof` チェックだけでエラーの性質を判別できる（`types.ts:2306`, `sdkErrors.ts:57`）

- `[SHOULD]` バースト通知は microtask デバウンスで集約し、同一イベントループ内の重複送信を防ぐ
  - 根拠: ツール登録が連続する場合の `notifications/tools/list_changed` が `Promise.resolve().then()` で次のマイクロタスクに遅延され、1回の通知に集約される（`protocol.ts:1386-1424`）

- `[AVOID]` 単一クラスに 10 個以上の Map/Set フィールドを持たせない。責務分離の指標として監視する
  - 根拠: Protocol クラスは 13 個の private Map/Set を持ち、1700 行を超えて God Class 化している。Task 関連の責務が後から追加されたことが主因（`protocol.ts:393-411`）

## 適用チェックリスト

- [ ] 双方向 RPC を実装する場合、送信側と受信側を別クラスに分けず、共通基底にまとめているか
- [ ] 通信手段（HTTP, WebSocket, stdio 等）が Transport インターフェースで抽象化されているか
- [ ] 機能の有効/無効が初期化時のハンドシェイクで合意され、未対応機能の呼び出しが早期にエラーになるか
- [ ] 高レベル API が低レベル実装を隠蔽しつつ、escape hatch を提供しているか
- [ ] ネットワーク越しのエラーとローカルエラーが別のエラー型で表現されているか
- [ ] 基底クラスの private フィールド数が過剰でないか（目安: Map/Set 合計 8 個以下）
- [ ] バースト的に発生する通知にデバウンスが適用されているか
