# Pattern: Transport Auto-Fallback

> 出典: [repos/cloudflare/agents/mcp-protocol-integration.md](../repos/cloudflare/agents/mcp-protocol-integration.md)
> カテゴリ: pattern

## 概要

クライアント側の `auto` モードで streamable-http を先に試行し、404/405 なら SSE にフォールバックする自動トランスポートネゴシエーションパターン。`isTransportNotImplemented()` でステータスコードベースの判定を行い、プロトコル進化に伴う後方互換性を透過的に維持する。

新旧のプロトコルが混在する環境で、クライアントが接続先のサポート状況を事前に知らなくても最適なトランスポートを選択できるようにするための設計。HTTP ステータスコードという標準化されたシグナルを使うことで、文字列ベースのエラーマッチよりも堅牢なフォールバック判定を実現している。

## 背景・文脈

cloudflare/agents は MCP (Model Context Protocol) のクライアント・サーバー実装を提供しており、3 種類のトランスポート（SSE、Streamable HTTP、RPC）をサポートしている。MCP プロトコルは進化の途上にあり、古いサーバーは SSE のみ、新しいサーバーは Streamable HTTP をサポートするという過渡期にある。

クライアントが接続先サーバーの対応トランスポートを事前に知ることは一般に困難であるため、「新しいプロトコルから順に試行し、非対応なら古いプロトコルにフォールバックする」という段階的ネゴシエーションが必要になる。このパターンは HTTP のコンテンツネゴシエーションや TLS のバージョンネゴシエーションと同じ発想に基づく。

## 実装パターン

このパターンは 3 つのコンポーネントで構成される:

1. **トランスポート候補リストの構築** -- `auto` 指定時に優先順位付きのリストを生成する
2. **順次試行とフォールバック判定** -- 各トランスポートで接続を試み、特定のエラーコードでフォールバックを決定する
3. **エラー分類関数** -- HTTP ステータスコードに基づいてフォールバック可能かを判定する

### 1. フォールバック判定関数

フォールバックの根幹をなすのが `isTransportNotImplemented()` 関数。HTTP 404/405 のステータスコードを第一判定基準とし、ステータスコードが取得できない場合のみ文字列マッチをフォールバックとして使う:

```typescript
// packages/agents/src/mcp/errors.ts:28-39
export function isTransportNotImplemented(error: Error): boolean {
  if ("code" in error && typeof (error as McpError).code === "number") {
    const code = (error as McpError).code;
    return code === 404 || code === 405;
  }

  // Fallback to message-based detection for non-standard errors
  return (
    error.message.includes("404")
    || error.message.includes("405")
    || error.message.includes("Not Found")
    || error.message.includes("Method Not Allowed")
  );
}
```

同様に、認証エラーを判別する `isUnauthorized()` も HTTP ステータスコードベースで実装されており、フォールバックとは異なる制御フロー（認証フローへの遷移）に分岐させる:

```typescript
// packages/agents/src/mcp/errors.ts:7-18
export function isUnauthorized(error: Error): boolean {
  if ("code" in error && typeof (error as McpError).code === "number") {
    const code = (error as McpError).code;
    return code === 401 || code === 403;
  }

  return (
    error.message.includes("Unauthorized")
    || error.message.includes("401")
    || error.message.includes("403")
  );
}
```

### 2. トランスポート生成の分岐

`getTransport()` が各トランスポート種別に対応するインスタンスを生成する。`auto` モードでは呼び出し側が候補リストを渡して順次呼び出す:

```typescript
// packages/agents/src/mcp/client-connection.ts:618-637
private getTransport(
  transportType: BaseTransportType
): SSEClientTransport | StreamableHTTPClientTransport {
  switch (transportType) {
    case "sse":
      return new SSEClientTransport(
        new URL(this.config.url),
        this.transportOptions
      );
    case "streamable-http":
      return new StreamableHTTPClientTransport(
        new URL(this.config.url),
        this.transportOptions
      );
    default:
      throw new Error(`Unsupported transport type: ${transportType}`);
  }
}
```

### 3. 順次試行ループ

`tryConnect()` がパターンの中核。`auto` 指定時に `["streamable-http", "sse"]` の順で接続を試み、`isTransportNotImplemented()` が `true` なら次の候補に進む:

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

## Good Example

```typescript
// Good: ステータスコードベースのフォールバック判定
// 構造化されたエラー情報を優先し、文字列マッチは最終手段として使う

function isTransportNotImplemented(error: Error): boolean {
  // 第1判定: 構造化されたステータスコード
  if ("code" in error && typeof (error as McpError).code === "number") {
    const code = (error as McpError).code;
    return code === 404 || code === 405;
  }
  // 第2判定: 文字列マッチ（非標準エラー向けフォールバック）
  return (
    error.message.includes("404")
    || error.message.includes("Not Found")
  );
}

// Good: フォールバック可否を明示的にチェックし、
// 認証エラーとトランスポート非対応エラーを区別する
async function tryConnect(transportType: TransportType) {
  const transports = transportType === "auto" ? ["streamable-http", "sse"] : [transportType];

  for (const current of transports) {
    const isLast = current === transports[transports.length - 1];
    const hasFallback = transportType === "auto" && !isLast;

    try {
      await client.connect(getTransport(current));
      return { state: "connected", transport: current };
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));

      // 認証エラーはフォールバックせず専用フローへ
      if (isUnauthorized(error)) {
        return { state: "authenticating" };
      }
      // トランスポート非対応なら次の候補へ
      if (isTransportNotImplemented(error) && hasFallback) {
        continue;
      }
      return { state: "failed", error };
    }
  }
  return { state: "failed", error: new Error("No transports available") };
}
```

## Bad Example

```typescript
// Bad: エラーメッセージの文字列マッチだけに依存するフォールバック
// サーバーのエラーメッセージが変わると破綻する
async function tryConnect(url: string) {
  try {
    await connectStreamableHttp(url);
  } catch (e) {
    // Bad: メッセージ文字列への依存 -- サーバー実装やロケールで変わりうる
    if (e.message.includes("not supported")) {
      return connectSSE(url);
    }
    throw e;
  }
}

// Bad: 全てのエラーでフォールバックしてしまう
// ネットワークエラーや認証エラーでもフォールバックが発生し、
// 本来のエラーが隠蔽される
async function tryConnect(url: string) {
  try {
    return await connectStreamableHttp(url);
  } catch {
    // Bad: エラー種別を区別せず一律フォールバック
    return await connectSSE(url);
  }
}

// Bad: フォールバック候補がハードコードされて拡張不可
async function tryConnect(url: string) {
  // Bad: 条件分岐でトランスポートを切り替え -- 新しいトランスポート追加時に改修が必要
  if (serverSupportsStreamableHttp(url)) {
    return connectStreamableHttp(url);
  } else {
    return connectSSE(url);
  }
}
```

## 適用ガイド

### どのような状況で使うべきか

- **プロトコルの過渡期**: サーバー群が新旧の通信方式を混在してサポートしている環境。例えば MCP の SSE から Streamable HTTP への移行期
- **サーバーの能力が事前に不明な場合**: クライアントが接続先のサポート状況を事前に知れない場合。API のバージョンディスカバリが提供されていない場合に特に有効
- **後方互換性が必要なクライアントライブラリ**: 古いサーバーと新しいサーバーの両方を単一のクライアントでサポートする必要がある場合

### 導入時の注意点

- **フォールバック順序は「新しい方から」**: 新しいプロトコルの方が通常は機能が豊富であるため、先に試行する。cloudflare/agents では `streamable-http` → `sse` の順
- **認証エラーはフォールバックしない**: `isUnauthorized()` で検出した 401/403 は別のフロー（認証フロー）に遷移させる。全てのエラーをフォールバックに回すと、認証問題が隠蔽されてデバッグが困難になる
- **接続先が既知ならフォールバックを無効にする**: `auto` モードは便利だが、接続先のプロトコルが確定している場合は明示的に指定する方が無駄な接続試行を避けられる
- **フォールバック判定は構造化エラーを優先する**: HTTP ステータスコードのような標準化されたシグナルを第一判定基準とし、文字列マッチはフォールバックとしてのみ使う

### カスタマイズポイント

- **候補リストの拡張**: `transports` 配列に新しいトランスポートを追加するだけで候補を増やせる。例えば将来 WebTransport が追加される場合、`["webtransport", "streamable-http", "sse"]` とするだけでよい
- **フォールバック判定条件のカスタマイズ**: `isTransportNotImplemented()` の判定ロジックを差し替えることで、HTTP ステータスコード以外の判定基準（カスタムヘッダー、レスポンスボディのフィールド等）にも対応可能
- **戻り値の状態列挙**: `MCPConnectionState` のような列挙型で接続結果を表現しているため、フォールバック以外の結果（認証要求、レート制限等）も統一的に扱える
- **リトライとの組み合わせ**: フォールバックはトランスポート種別の切り替えに特化しており、同一トランスポートでのリトライ（ネットワーク一時障害対応）とは独立して設計できる

## 参考

- [repos/cloudflare/agents/mcp-protocol-integration.md](../repos/cloudflare/agents/mcp-protocol-integration.md) -- 元の分析
