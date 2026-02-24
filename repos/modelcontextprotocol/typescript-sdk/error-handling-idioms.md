# エラーハンドリングイディオム

> リポジトリ: modelcontextprotocol/typescript-sdk
> 分析日: 2026-02-24

## 概要

MCP TypeScript SDK は、JSON-RPC 2.0 プロトコル上で動作するクライアント・サーバー間通信を実現するため、エラーを「ワイヤーを越えるもの（Protocol エラー）」と「ローカルに留まるもの（SDK エラー）」に明確に二分する設計を採用している。この分離は単なるコード整理ではなく、エラーの伝播経路・シリアライズ可否・処理責任を型レベルで強制する仕組みとして機能する。加えて、OAuth 認証エラー・トランスポート固有エラーを含む多層的なエラー階層が、プロトコルの各層に応じて設計されている点が注目に値する。

## 背景にある原則

- **ワイヤー境界でのエラー分類**: エラーがネットワークを越えて相手側に伝播するかどうかでクラスを分けるべき。なぜなら、シリアライズ可能なエラーとローカル専用のエラーでは、エラーコードの型（数値 vs 文字列）、含められるデータ、復旧戦略がすべて異なるため。`ProtocolError`（数値コード、JSON-RPC 準拠）と `SdkError`（文字列コード、ローカル専用）の二分設計がこれを実現している（`packages/core/src/errors/sdkErrors.ts:1-8`）。

- **標準仕様への準拠を基盤とし、拡張は明示的に分離する**: JSON-RPC 2.0 標準のエラーコード（-32700〜-32603）と MCP 固有の拡張コード（-32042 など）を同一 enum 内でコメントにより区別する。標準に準拠することでクライアント実装の互換性を確保し、拡張は明示的に分離して後方互換を維持する（`packages/core/src/types/types.ts:222-232`）。

- **エラーの文脈に応じた粒度制御**: 開発者向けのローカルエラーには記述的な文字列コード（`NOT_CONNECTED`, `REQUEST_TIMEOUT`）を使い、プロトコルエラーには仕様準拠の数値コードを使う。エラーの消費者（開発者 vs リモートシステム）に最適なインターフェースを提供することで、デバッグ体験とプロトコル互換性を両立する。

- **キャンセレーションの協調的設計**: AbortSignal/AbortController を通じてリクエストのキャンセルを協調的に処理し、キャンセル済みリクエストに対するエラーレスポンスを抑制する。これによりリソースリークやゴーストレスポンスを防止する（`packages/core/src/shared/protocol.ts:847,872`）。

## 実例と分析

### エラークラス階層の二分設計

SDK は以下の独立したエラー階層を持つ:

1. **ProtocolError**: JSON-RPC エラーレスポンスとして相手側に送信されるエラー。数値コードを使用し、`data` フィールドで追加情報を伝達する。
2. **SdkError**: SDK 内部でのみ発生・消費されるエラー。文字列コードを使用し、ネットワークを越えない。
3. **OAuthError**: OAuth フローに特化したエラー。RFC 6749 準拠のエラーコード体系を持ち、`toResponseObject()` / `fromResponse()` でワイヤーフォーマットと相互変換可能。
4. **ドメイン固有エラー**: `UnauthorizedError`（認証失敗）、`SseError`（SSE 接続エラー）など、特定のトランスポートやフローに特化したエラー。

この設計の特筆すべき点は、`ProtocolError` と `SdkError` がどちらも `Error` を直接継承し、相互に継承関係を持たないことである。これにより、`instanceof` による型の取り違えが発生しない。

### ProtocolError のファクトリメソッドによるサブタイプ復元

受信したエラーレスポンスから適切なサブクラスを復元するために、`ProtocolError.fromError()` 静的ファクトリメソッドが使われている。特定のエラーコードに対してサブクラス（`UrlElicitationRequiredError`）を返し、それ以外は汎用 `ProtocolError` にフォールバックする。

### エラーコードの意図的な型分離

`ProtocolErrorCode` は数値 enum（JSON-RPC 仕様準拠）、`SdkErrorCode` は文字列 enum、`OAuthErrorCode` は snake_case 文字列 enum（RFC 6749 準拠）として定義されている。各コード体系が準拠する仕様のフォーマットに合わせることで、仕様ドキュメントとコードの対応関係を直感的にする。

### ハンドラ内エラーからワイヤーフォーマットへの自動変換

`Protocol._onrequest()` のエラーハンドリング（`packages/core/src/shared/protocol.ts:871-885`）は、ハンドラが throw したエラーを自動的に JSON-RPC エラーレスポンスに変換する。`error.code` が安全な整数であればそのまま使用し、そうでなければ `InternalError` にフォールバックする。この設計により、ハンドラ側は `ProtocolError` を throw するだけでよく、ワイヤーフォーマットへの変換を意識する必要がない。

### ツール実行のエラー境界

`McpServer` の `tools/call` ハンドラ（`packages/server/src/server/mcp.ts:168-221`）は、ツール実行時のエラーを2つのカテゴリに分岐させる:

1. `UrlElicitationRequired` エラー: そのまま re-throw し、JSON-RPC エラーレスポンスとして送信
2. その他のエラー: `CallToolResult` の `isError: true` 形式に変換し、ツール実行結果として返却

この区別は、「プロトコルレベルのエラー」と「アプリケーションレベルのエラー」を適切に分離している。

### 接続クローズ時の一括エラー伝播

`Protocol._onclose()`（`packages/core/src/shared/protocol.ts:721-736`）は、接続クローズ時に保留中の全レスポンスハンドラに `SdkError(ConnectionClosed)` を配信する。ハンドラマップを新しい空マップに置換してからイテレーションすることで、コールバック内での再入を安全に処理している。

## コード例

```typescript
// packages/core/src/errors/sdkErrors.ts:9-37
export enum SdkErrorCode {
  // State errors
  NotConnected = "NOT_CONNECTED",
  AlreadyConnected = "ALREADY_CONNECTED",
  NotInitialized = "NOT_INITIALIZED",

  // Capability errors
  CapabilityNotSupported = "CAPABILITY_NOT_SUPPORTED",

  // Transport errors
  RequestTimeout = "REQUEST_TIMEOUT",
  ConnectionClosed = "CONNECTION_CLOSED",
  SendFailed = "SEND_FAILED",

  // Transport errors
  ClientHttpNotImplemented = "CLIENT_HTTP_NOT_IMPLEMENTED",
  ClientHttpAuthentication = "CLIENT_HTTP_AUTHENTICATION",
  ClientHttpForbidden = "CLIENT_HTTP_FORBIDDEN",
  ClientHttpUnexpectedContent = "CLIENT_HTTP_UNEXPECTED_CONTENT",
  ClientHttpFailedToOpenStream = "CLIENT_HTTP_FAILED_TO_OPEN_STREAM",
  ClientHttpFailedToTerminateSession = "CLIENT_HTTP_FAILED_TO_TERMINATE_SESSION",
}
```

```typescript
// packages/core/src/types/types.ts:222-232
export enum ProtocolErrorCode {
  // Standard JSON-RPC error codes
  ParseError = -32_700,
  InvalidRequest = -32_600,
  MethodNotFound = -32_601,
  InvalidParams = -32_602,
  InternalError = -32_603,

  // MCP-specific error codes
  UrlElicitationRequired = -32_042,
}
```

```typescript
// packages/core/src/shared/protocol.ts:871-885
// ハンドラ例外からJSON-RPCエラーレスポンスへの自動変換
async error => {
    if (abortController.signal.aborted) {
        return;
    }
    const errorResponse: JSONRPCErrorResponse = {
        jsonrpc: '2.0',
        id: request.id,
        error: {
            code: Number.isSafeInteger(error['code']) ? error['code'] : ProtocolErrorCode.InternalError,
            message: error.message ?? 'Internal error',
            ...(error['data'] !== undefined && { data: error['data'] })
        }
    };
```

```typescript
// packages/core/src/types/types.ts:2318-2330
// ファクトリメソッドによるエラーサブタイプの復元
static fromError(code: number, message: string, data?: unknown): ProtocolError {
    if (code === ProtocolErrorCode.UrlElicitationRequired && data) {
        const errorData = data as { elicitations?: unknown[] };
        if (errorData.elicitations) {
            return new UrlElicitationRequiredError(errorData.elicitations as ElicitRequestURLParams[], message);
        }
    }
    return new ProtocolError(code, message, data);
}
```

```typescript
// packages/server/src/server/mcp.ts:215-219
// ツール実行エラーの分岐：プロトコルエラー vs アプリケーションエラー
} catch (error) {
    if (error instanceof ProtocolError && error.code === ProtocolErrorCode.UrlElicitationRequired) {
        throw error; // Return the error to the caller without wrapping in CallToolResult
    }
    return this.createToolError(error instanceof Error ? error.message : String(error));
}
```

## パターンカタログ

- **Factory Method** (分類: 生成)
  - 解決する問題: 受信した JSON-RPC エラーレスポンスから適切なエラーサブクラスを復元する
  - 適用条件: シリアライズされたエラーデータからドメイン固有のエラー型を再構築する必要がある場合
  - コード例: `packages/core/src/types/types.ts:2319-2330`
  - 注意点: 拡張時はファクトリメソッド内の分岐を追加する必要がある。コードとサブクラスの対応は集約される

- **Error Boundary** (分類: 振る舞い)
  - 解決する問題: ハンドラ内の任意の例外をプロトコル準拠のエラーレスポンスに変換する
  - 適用条件: 外部からのリクエストを処理し、レスポンスフォーマットが固定されている場合
  - コード例: `packages/core/src/shared/protocol.ts:871-885`、`packages/server/src/server/mcp.ts:168-221`
  - 注意点: フォールバックコード（`InternalError`）を設定し、未知のエラーが仕様違反のレスポンスを生まないようにする

- **Result Type（型による成功/失敗の区別）** (分類: 振る舞い)
  - 解決する問題: ツール実行のエラーを例外ではなく結果値（`isError: true`）として返す
  - 適用条件: エラーが「処理の失敗」ではなく「処理の結果の一つ」として扱われるべき場合
  - コード例: `packages/server/src/server/mcp.ts:232-242`
  - 注意点: プロトコルエラー（`UrlElicitationRequired`）は結果値化せず例外のまま re-throw するという使い分けが重要

## Good Patterns

- **ワイヤー境界によるエラー型の分離**: `ProtocolError`（ネットワーク越し）と `SdkError`（ローカル専用）を独立した型として分離し、混同を型レベルで防止する。各エラーコードの型（数値 vs 文字列）もその境界に合わせて設計されている。

```typescript
// packages/core/src/errors/sdkErrors.ts:57-66
export class SdkError extends Error {
  constructor(
    public readonly code: SdkErrorCode,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "SdkError";
  }
}
```

```typescript
// packages/core/src/types/types.ts:2306-2314
export class ProtocolError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(`MCP error ${code}: ${message}`);
    this.name = "ProtocolError";
  }
}
```

- **安全なフォールバックを持つエラーコード変換**: ハンドラが throw したエラーをワイヤーフォーマットに変換する際、`Number.isSafeInteger(error['code'])` でコードの妥当性を検証し、不正な場合は `InternalError` にフォールバックする。これにより、ハンドラが任意のエラーを throw しても仕様違反のレスポンスが生成されない。

```typescript
// packages/core/src/shared/protocol.ts:881
code: Number.isSafeInteger(error['code']) ? error['code'] : ProtocolErrorCode.InternalError,
```

- **OAuth エラーの双方向変換メソッド**: `OAuthError` クラスに `toResponseObject()` と `fromResponse()` を持たせ、内部表現とワイヤーフォーマットの変換を一箇所に集約する。

```typescript
// packages/core/src/auth/errors.ts:113-131
toResponseObject(): OAuthErrorResponse {
    const response: OAuthErrorResponse = {
        error: this.code,
        error_description: this.message
    };
    if (this.errorUri) {
        response.error_uri = this.errorUri;
    }
    return response;
}

static fromResponse(response: OAuthErrorResponse): OAuthError {
    return new OAuthError(response.error as OAuthErrorCode, response.error_description ?? response.error, response.error_uri);
}
```

- **キャンセル済みリクエストへのレスポンス抑制**: リクエストがキャンセルされた場合、成功・エラーの両方でレスポンス送信をスキップする。ゴーストレスポンスによる状態不整合を防止する。

```typescript
// packages/core/src/shared/protocol.ts:847-849,872-874
if (abortController.signal.aborted) {
  // Request was cancelled
  return;
}
```

## Anti-Patterns / 注意点

- **エラーコードなし例外の throw**: `ProtocolError` の代わりに `new Error()` を throw すると、ワイヤー上では `InternalError (-32603)` にフォールバックされ、クライアント側でエラーの種類を判別できなくなる。

```typescript
// Bad: エラーの種類を伝達できない
throw new Error("Tool not found");

// Better: 適切なエラーコードを含める
throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Tool not found");
```

- **SdkError をリモート側に送信しようとする**: `SdkError` は文字列コードを持つためシリアライズすると JSON-RPC 仕様に違反する。`Number.isSafeInteger()` チェックにより `InternalError` にフォールバックされるが、意図したエラー情報が失われる。

```typescript
// Bad: ローカルエラーをハンドラ内でthrowするとワイヤー上で意味を失う
throw new SdkError(SdkErrorCode.NotConnected, "Transport is not connected");

// Better: ワイヤーに送信される文脈では ProtocolError を使う
throw new ProtocolError(ProtocolErrorCode.InternalError, "Transport is not connected");
```

- **catch での型ガードなし re-throw**: `ProtocolError` を特別扱いする必要がある場合に、型ガードなしで一律処理すると、本来 re-throw すべきプロトコルエラーがアプリケーションエラーとして処理される。

```typescript
// Bad: ProtocolError を一律キャッチしてアプリケーションエラーに変換
} catch (error) {
    return { content: [{ type: 'text', text: String(error) }], isError: true };
}

// Better: ProtocolError を識別して re-throw
} catch (error) {
    if (error instanceof ProtocolError) {
        throw error;
    }
    return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
}
```

## 導出ルール

- `[MUST]` ネットワーク境界を越えるエラーとローカル専用エラーは別のクラス・別のコード体系で定義する
  - 根拠: MCP SDK は `ProtocolError`（数値コード、JSON-RPC 準拠）と `SdkError`（文字列コード、ローカル専用）を完全に分離し、シリアライズ可否を型で強制している（`sdkErrors.ts:1-8`）
- `[MUST]` ハンドラから throw された任意のエラーを安全にワイヤーフォーマットに変換するフォールバック機構を設ける
  - 根拠: `protocol.ts:881` で `Number.isSafeInteger(error['code'])` をチェックし、不正なコードは `InternalError` にフォールバックすることで、仕様違反のレスポンスを防止している
- `[MUST]` キャンセル済みリクエストに対するレスポンス（成功・エラー両方）を抑制する
  - 根拠: `protocol.ts:847,872` でキャンセル後のレスポンス送信をスキップし、ゴーストレスポンスによる状態不整合を防止している
- `[SHOULD]` エラーコードは準拠する仕様のフォーマットに合わせる（JSON-RPC には数値、OAuth には snake_case 文字列など）
  - 根拠: `ProtocolErrorCode`（数値 enum）、`OAuthErrorCode`（snake_case 文字列 enum）、`SdkErrorCode`（UPPER_SNAKE 文字列 enum）がそれぞれ異なる仕様のフォーマットに準拠している
- `[SHOULD]` シリアライズされたエラーから適切なサブクラスを復元するファクトリメソッドを提供する
  - 根拠: `ProtocolError.fromError()` がエラーコードに基づいて `UrlElicitationRequiredError` などのサブクラスを復元し、受信側での型安全な分岐を可能にしている（`types.ts:2319-2330`）
- `[SHOULD]` プロトコルエラー（処理の異常）とアプリケーションエラー（処理の結果）は異なる伝達チャネルを使う
  - 根拠: ツール実行で `ProtocolError` は JSON-RPC エラーレスポンスとして送信し、それ以外は `CallToolResult { isError: true }` として結果値に変換する二段構えが採用されている（`mcp.ts:215-219`）
- `[AVOID]` ローカル専用エラー（SDK エラー）をリモートハンドラ内で throw する
  - 根拠: `SdkError` の文字列コードは `Number.isSafeInteger()` チェックを通過せず、`InternalError` にフォールバックされてエラー情報が失われる

## 適用チェックリスト

- [ ] エラーがネットワーク境界を越えるか否かでクラスを分離しているか
- [ ] プロトコルエラーのコード体系は準拠する仕様（JSON-RPC, OAuth 等）のフォーマットに合っているか
- [ ] ハンドラが任意のエラーを throw した場合のフォールバック（デフォルトコード、安全なメッセージ）が設定されているか
- [ ] キャンセル済みリクエストに対するレスポンスが抑制されているか
- [ ] シリアライズされたエラーからドメイン固有のエラー型を復元する仕組みがあるか
- [ ] ツール/プラグイン実行のエラーが「プロトコルエラー」と「アプリケーションエラー」に適切に分離されているか
- [ ] エラーの `data` フィールドを使って構造化された追加情報（ステータスコード、タイムアウト値など）を伝達しているか
- [ ] 接続クローズ時に保留中のリクエストに対してエラーが配信される仕組みがあるか
