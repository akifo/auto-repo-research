# API Design Practices

> リポジトリ: modelcontextprotocol/typescript-sdk
> 分析日: 2026-02-24

## 概要

MCP TypeScript SDK の API 設計を分析する。このリポジトリは Protocol / Server / McpServer という3層の抽象化を持ち、低レベルの JSON-RPC ハンドリングから高レベルの宣言的 API までを一貫した設計思想で構築している。Capability negotiation による安全な機能拡張、Zod スキーマを介した型レベル API 設計、そして Facade パターンによる段階的開示（progressive disclosure）が注目に値する。

## 背景にある原則

- **Progressive Disclosure（段階的開示）**: 高レベル API（McpServer）で 80% のユースケースをカバーし、低レベル API（Server / Protocol）を `server` プロパティ経由でエスケープハッチとして提供する。初心者は `registerTool()` だけで始められ、上級者は `setRequestHandler()` で任意のプロトコルメソッドを処理できる。これにより学習曲線を緩やかにしつつ、表現力を犠牲にしない。
  - 根拠: `McpServer` は `Server` をラップし `public readonly server: Server` で公開（`mcp.ts:69-70`）

- **Contract-First（契約先行設計）**: Zod スキーマをプロトコルの型定義・バリデーション・JSON Schema 変換の Single Source of Truth として使う。入出力の両方をスキーマで記述し、登録時・呼び出し時の両方で検証する。これにより型安全性とランタイム安全性を同時に実現する。
  - 根拠: `schemaToJson()` で JSON Schema へ変換（`schema.ts:28-30`）、`parseSchemaAsync()` で入出力を検証（`mcp.ts:259`, `mcp.ts:296`）

- **Capability Negotiation（能力交渉）**: 機能の存在を前提とせず、初期化時に双方が能力を宣言し、各操作の前に能力チェックを行う。これにより前方互換性と後方互換性を同時に確保する。新しい機能を追加しても、対応しないクライアント/サーバーとの互換性が壊れない。
  - 根拠: `assertCapabilityForMethod()`（`server.ts:246-277`）, `assertRequestHandlerCapability()`（`server.ts:341-407`）, `assertNotificationCapability()`（`server.ts:279-339`）の3段階チェック

- **登録が宣言を駆動する（Registration-Driven Capabilities）**: 能力を事前に静的宣言するのではなく、ハンドラーの登録行為が能力の宣言を自動的にトリガーする。ユーザーが `registerTool()` を呼ぶだけで `tools` 能力が自動的に有効化される。宣言と実装の乖離を構造的に防ぐ。
  - 根拠: `setToolRequestHandlers()` 内で `registerCapabilities({ tools: { ... } })` を呼び出す（`mcp.ts:133-137`）

## 実例と分析

### 3層 API アーキテクチャ

SDK は Protocol > Server > McpServer の3層で構成される。各層が明確に異なる抽象度を提供し、ユーザーは必要な層だけを使えばよい。

**Protocol 層**（抽象クラス）: JSON-RPC メッセージルーティング、リクエスト/レスポンス相関、タイムアウト、進捗通知、キャンセルを管理する。トランスポートに依存しない。

```typescript
// packages/core/src/shared/protocol.ts:392
export abstract class Protocol<ContextT extends BaseContext> {
  private _requestHandlers: Map<string, (request: JSONRPCRequest, ctx: ContextT) => Promise<Result>> = new Map();
  // ...
  protected abstract assertCapabilityForMethod(method: RequestMethod): void;
  protected abstract assertNotificationCapability(method: NotificationMethod): void;
  protected abstract assertRequestHandlerCapability(method: string): void;
}
```

**Server 層**: Protocol を継承し、Capability negotiation、初期化ハンドシェイク、サーバー固有のコンテキスト構築を担当する。

```typescript
// packages/server/src/server/server.ts:89
export class Server extends Protocol<ServerContext> {
  protected assertCapabilityForMethod(method: RequestMethod): void {
    switch (method) {
      case "sampling/createMessage":
        if (!this._clientCapabilities?.sampling) {
          throw new SdkError(
            SdkErrorCode.CapabilityNotSupported,
            `Client does not support sampling (required for ${method})`,
          );
        }
        break;
        // ...
    }
  }
}
```

**McpServer 層**: Server をラップし、`registerTool()` / `registerResource()` / `registerPrompt()` のような宣言的 API を提供する。内部でハンドラー登録と能力宣言を自動化する。

### 遅延初期化によるハンドラー登録

McpServer は、ユーザーが最初のツールを登録するまで `tools/list` や `tools/call` のリクエストハンドラーを設置しない。これにより、不要な能力が宣言されることを防ぐ。

```typescript
// packages/server/src/server/mcp.ts:123-224
private _toolHandlersInitialized = false;

private setToolRequestHandlers() {
    if (this._toolHandlersInitialized) {
        return;
    }

    this.server.assertCanSetRequestHandler('tools/list');
    this.server.assertCanSetRequestHandler('tools/call');

    this.server.registerCapabilities({
        tools: {
            listChanged: this.server.getCapabilities().tools?.listChanged ?? true
        }
    });

    this.server.setRequestHandler('tools/list', (): ListToolsResult => ({ /* ... */ }));
    this.server.setRequestHandler('tools/call', async (request, ctx) => { /* ... */ });

    this._toolHandlersInitialized = true;
}
```

同じパターンが `_resourceHandlersInitialized`、`_promptHandlersInitialized`、`_completionHandlerInitialized` でも使われている。4つのフラグが同一パターンで実装されている。

### ハンドラー登録の衝突防止

`assertCanSetRequestHandler()` で既存ハンドラーの上書きを明示的に防止する。McpServer が自動登録するハンドラーとユーザーが手動登録するハンドラーの衝突を検出する。

```typescript
// packages/core/src/shared/protocol.ts:1477-1481
assertCanSetRequestHandler(method: RequestMethod): void {
    if (this._requestHandlers.has(method)) {
        throw new Error(`A request handler for ${method} already exists, which would be overridden`);
    }
}
```

### Capability Negotiation のフロー

初期化時にクライアントとサーバーが互いの能力を交換し、その後の全リクエストで能力チェックを行う。チェックは3つの異なるポイントで実施される:

1. **リクエスト送信時**（outbound）: `assertCapabilityForMethod()` で相手側の能力を確認
2. **ハンドラー登録時**（local）: `assertRequestHandlerCapability()` で自分側の能力を確認
3. **通知送信時**（outbound）: `assertNotificationCapability()` で自分側の能力を確認

```typescript
// packages/client/src/client/client.ts:471-523
override async connect(transport: Transport, options?: RequestOptions): Promise<void> {
    await super.connect(transport);
    // ...
    const result = await this.request({
        method: 'initialize',
        params: {
            protocolVersion: this._supportedProtocolVersions[0] ?? LATEST_PROTOCOL_VERSION,
            capabilities: this._capabilities,
            clientInfo: this._clientInfo
        }
    }, InitializeResultSchema, options);

    this._serverCapabilities = result.capabilities;
    // ...
    await this.notification({ method: 'notifications/initialized' });
}
```

### エラーの分離: ProtocolError vs SdkError

プロトコルレベルのエラー（JSON-RPC ワイヤ上を流れる）とSDKレベルのエラー（ローカルで発生する）を型レベルで明確に分離している。

```typescript
// packages/core/src/errors/sdkErrors.ts:9-37
export enum SdkErrorCode {
  NotConnected = "NOT_CONNECTED",
  AlreadyConnected = "ALREADY_CONNECTED",
  CapabilityNotSupported = "CAPABILITY_NOT_SUPPORTED",
  RequestTimeout = "REQUEST_TIMEOUT",
  // ...
}
```

`ProtocolError` は数値コード（JSON-RPC 仕様準拠）を持ち、ワイヤ上でシリアライズされる。`SdkError` は文字列コード（人間が読みやすい列挙型）を持ち、ローカルでのみ使用される。これにより、呼び出し側は `instanceof` チェックでエラーの種類を判別し、適切にハンドリングできる。

### 登録オブジェクトの動的更新パターン

`registerTool()` が返す `RegisteredTool` オブジェクトは `enable()`, `disable()`, `update()`, `remove()` メソッドを持ち、登録後の動的変更を可能にする。変更時には自動的にリスト変更通知が発行される。

```typescript
// packages/server/src/server/mcp.ts:1086-1112
export type RegisteredTool = {
  title?: string;
  description?: string;
  inputSchema?: AnySchema;
  outputSchema?: AnySchema;
  enabled: boolean;
  enable(): void;
  disable(): void;
  update(updates: {/* ... */}): void;
  remove(): void;
};
```

### バリデーション層の分離

Server クラスの `setRequestHandler` オーバーライドで、`tools/call` のリクエスト・レスポンスを Zod スキーマで自動検証する。ユーザーのハンドラーコードにバリデーションロジックを書かせない。

```typescript
// packages/server/src/server/server.ts:197-244
public override setRequestHandler<M extends RequestMethod>(
    method: M,
    handler: (request: RequestTypeMap[M], ctx: ServerContext) => ResultTypeMap[M] | Promise<ResultTypeMap[M]>
): void {
    if (method === 'tools/call') {
        const wrappedHandler = async (request: RequestTypeMap[M], ctx: ServerContext): Promise<ServerResult> => {
            const validatedRequest = parseSchema(CallToolRequestSchema, request);
            if (!validatedRequest.success) { /* throw */ }
            const result = await Promise.resolve(handler(request, ctx));
            const validationResult = parseSchema(CallToolResultSchema, result);
            if (!validationResult.success) { /* throw */ }
            return validationResult.data;
        };
        return super.setRequestHandler(method, wrappedHandler);
    }
    return super.setRequestHandler(method, handler);
}
```

Client 側でも同様のパターンが `sampling/createMessage` と `elicitation/create` で使われている（`client.ts:315-434`）。

## パターンカタログ

- **Facade パターン** (構造)
  - 解決する問題: 複雑なサブシステム（Protocol + Server + Transport + Zod スキーマ）を単純なインターフェースで隠蔽する
  - 適用条件: 多層の複雑なシステムを初心者が使いやすくしたい場合
  - コード例: `mcp.ts:66` の `McpServer` クラス（`Server` を内部で保持しつつ `registerTool()` 等の簡易 API を提供）
  - 注意点: Facade は低レベル API へのエスケープハッチ（`server` プロパティ）を常に公開すべき

- **Template Method パターン** (振る舞い)
  - 解決する問題: 共通のプロトコル処理フローを定義しつつ、Client/Server 固有のステップをサブクラスに委譲する
  - 適用条件: 同じ処理フローの異なるバリエーションが必要な場合
  - コード例: `protocol.ts:392` の `Protocol` 抽象クラス。`assertCapabilityForMethod()` 等の abstract メソッドを Client と Server がそれぞれ実装する
  - 注意点: abstract メソッドが増えすぎると、サブクラスの実装負荷が高くなる

- **Strategy パターン** (振る舞い)
  - 解決する問題: トランスポート層を交換可能にする
  - 適用条件: 通信手段（stdio, HTTP, WebSocket）をプロトコル処理と独立に選択したい場合
  - コード例: `transport.ts:74` の `Transport` インターフェース。`StdioServerTransport`, `StreamableHTTPServerTransport` 等が実装する
  - 注意点: Transport インターフェースはコールバックスタイル（`onmessage`, `onerror`, `onclose`）を採用し、Protocol が所有権を取る

- **Decorator パターン** (構造)
  - 解決する問題: fetch 関数にクロスカッティングな関心事（認証、ロギング）を透過的に追加する
  - 適用条件: HTTP クライアントに認証・ロギング等のミドルウェアを合成したい場合
  - コード例: `middleware.ts:10` の `Middleware` 型と `applyMiddlewares()` 関数
  - 注意点: ミドルウェアの順序が重要（認証→ロギングの順で適用しないとログに認証情報が含まれない）

## Good Patterns

- **Zod スキーマによる入出力の双方向バリデーション**: 入力（`inputSchema`）と出力（`outputSchema`）の両方をスキーマで定義し、登録時に JSON Schema 変換、呼び出し時にランタイムバリデーションを行う。型推論とランタイム検証の一致を保証する。

```typescript
// packages/server/src/server/mcp.ts:869-898
registerTool<OutputArgs extends AnySchema, InputArgs extends AnySchema | undefined = undefined>(
    name: string,
    config: {
        title?: string;
        description?: string;
        inputSchema?: InputArgs;
        outputSchema?: OutputArgs;
        annotations?: ToolAnnotations;
    },
    cb: ToolCallback<InputArgs>
): RegisteredTool {
    // ...
}
```

- **エスケープハッチ付き Facade**: 高レベル API で処理できないケースのために、低レベル API を `public readonly server` として公開する。ユーザーを高レベル API に閉じ込めない。

```typescript
// packages/server/src/server/mcp.ts:69-70
public readonly server: Server;
```

- **警告付き段階的バリデーション**: ツール名のバリデーションでは、仕様に違反する名前でもエラーではなく警告を出して登録を許可する。厳密すぎるバリデーションで既存コードを壊さない。

```typescript
// packages/core/src/shared/toolNameValidation.ts:109-116
export function validateAndWarnToolName(name: string): boolean {
  const result = validateToolName(name);
  issueToolNameWarning(name, result.warnings);
  return result.isValid;
}
```

- **Pluggable Validator**: JSON Schema バリデーターをインターフェースとして定義し、環境に応じた実装を注入できるようにする（Node.js 向け Ajv、Cloudflare Workers 向け cfworker）。

```typescript
// packages/core/src/validation/types.ts:51-59
export interface jsonSchemaValidator {
  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T>;
}
```

## Anti-Patterns / 注意点

- **能力宣言と実装の不整合**: `enforceStrictCapabilities` がデフォルト `false` であるため、サーバーが宣言していない能力へのリクエストが黙って送信される場合がある。後方互換性のための設計だが、デバッグを困難にする。

```typescript
// Bad: 能力チェックを無視してリクエスト送信
const client = new Client(info); // enforceStrictCapabilities defaults to false
await client.callTool({ name: "tool" }); // サーバーが tools 能力を宣言していなくても送信される

// Better: 厳密な能力チェックを有効化
const client = new Client(info, { enforceStrictCapabilities: true });
await client.callTool({ name: "tool" }); // サーバーが tools 能力を宣言していなければ即座にエラー
```

- **コールバックスタイルの Transport 所有権**: `Protocol.connect()` が Transport のコールバック（`onmessage`, `onclose`, `onerror`）を上書きする設計は、Transport の再利用を不可能にする。既存コールバックの連鎖は行うが、意図的に所有権を奪う設計のため注意が必要。

```typescript
// Bad: Transport を複数の Protocol で共有しようとする
const transport = new StdioServerTransport();
await server1.connect(transport); // コールバック上書き
await server2.connect(transport); // server1 のコールバックが壊れる

// Better: Transport は 1:1 で Protocol に所有させる
const transport1 = new StdioServerTransport();
await server1.connect(transport1);
```

## 導出ルール

- `[MUST]` プロトコル API は能力交渉を経てから機能を使用する。初期化ハンドシェイクで双方が能力を宣言し、操作前に能力の存在を assert する
  - 根拠: `Server.assertCapabilityForMethod()` と `Client.assertCapabilityForMethod()` が全リクエストメソッドに対して能力チェックを実施（`server.ts:246-277`, `client.ts:546-607`）

- `[MUST]` ワイヤ上のエラー（プロトコルエラー）とローカルエラー（SDK エラー）を別の型として定義する。シリアライズ可能なエラーとローカル専用エラーを混同しない
  - 根拠: `ProtocolError`（数値コード、JSON-RPC 準拠）と `SdkError`（文字列コード、ローカル専用）の分離（`sdkErrors.ts:9-66`）

- `[SHOULD]` 高レベル API（Facade）は低レベル API へのエスケープハッチを `public readonly` プロパティとして公開する。80% のユースケースを簡潔にカバーしつつ、残り 20% のために内部構造へのアクセスを保証する
  - 根拠: `McpServer.server`（`mcp.ts:69-70`）により、`setRequestHandler()` 等の低レベル操作が常に可能

- `[SHOULD]` ハンドラー登録を契機として能力を自動宣言する（Registration-Driven Capabilities）。能力の宣言と実装の乖離を構造的に防ぐ
  - 根拠: `_createRegisteredTool()` 内で `setToolRequestHandlers()` が呼ばれ、そこで `registerCapabilities()` が実行される（`mcp.ts:837`, `mcp.ts:133-137`）

- `[SHOULD]` 入出力バリデーションをハンドラーの外側（フレームワーク層）で自動実行する。ユーザーコードにバリデーションロジックを書かせない
  - 根拠: `Server.setRequestHandler` のオーバーライドで `tools/call` のリクエスト・レスポンスを自動検証（`server.ts:197-244`）

- `[SHOULD]` バリデーターやトランスポートなどの環境依存コンポーネントをインターフェースとして定義し、依存性注入で切り替え可能にする
  - 根拠: `jsonSchemaValidator` インターフェースにより Ajv と cfworker を環境別に注入（`types.ts:51-59`, `server.ts:79`）

- `[AVOID]` 能力チェックをデフォルトで無効にすること。後方互換性のためにオプトインで緩和するのは許容するが、デフォルトは厳密にすべき
  - 根拠: `enforceStrictCapabilities` が `false` デフォルトであることが CLAUDE.md 内で将来的に `true` に変更予定と言及されている（`protocol.ts:88-89`）

## 適用チェックリスト

- [ ] API が3層以上の抽象度を持つ場合、最も高レベルの層から低レベル層へのエスケープハッチが存在するか
- [ ] プロトコル設計において、初期化時に双方が能力を交換する Capability negotiation フローがあるか
- [ ] 入出力バリデーションがハンドラーの外側（フレームワーク/ミドルウェア層）で自動実行されているか
- [ ] ワイヤ上のエラーとローカルエラーが型レベルで分離されているか
- [ ] ハンドラーの登録行為が能力宣言を自動的にトリガーする設計になっているか（宣言と実装の乖離防止）
- [ ] 環境依存のコンポーネント（バリデーター、トランスポート等）がインターフェースで抽象化され、注入可能か
- [ ] 破壊的変更を伴わない段階的バリデーション（警告→エラーの段階的移行）が導入されているか
- [ ] 登録済みオブジェクトの動的な有効化/無効化/更新が可能か（リスト変更通知の自動発行付き）
