# Pattern: Object Augmentation

> 出典: [repos/cloudflare/agents/extensibility-mechanisms.md](../repos/cloudflare/agents/extensibility-mechanisms.md)
> カテゴリ: pattern

## 概要

`Object.defineProperty` と TypeScript 交差型を組み合わせ、既存オブジェクトにクラス継承なしで型安全に機能を注入するパターン。`withXxx(target, config)` の関数シグネチャで、元のインターフェースを破壊せずにメソッドやプロパティを追加する。cloudflare/agents の `withX402()` / `withX402Client()` がこのパターンの実例であり、MCP Server/Client に決済機能を付加している。

クラス継承やラッパークラスと異なり、元のオブジェクトのアイデンティティと既存メソッドをそのまま保持できるため、SDK やフレームワークが提供するオブジェクトを外部から拡張する場面で特に有効。

## 背景・文脈

cloudflare/agents は Cloudflare Workers 上にエージェントを構築するフレームワーク。x402 支払いプロトコルの統合にあたり、MCP SDK が提供する `McpServer` と `Client` オブジェクトに決済機能を追加する必要があった。

しかし、`McpServer` は外部ライブラリ (`@modelcontextprotocol/sdk`) が提供するクラスであり、直接継承して拡張すると以下の問題が生じる:

- MCP SDK のバージョンアップ時にクラス内部構造の変更で壊れやすい
- 利用者が MCP SDK から受け取ったインスタンスをそのまま渡せなくなる
- 他の拡張（認証、ログ等）と継承チェーンが競合する

Object Augmentation パターンは、これらの問題を回避しつつ型安全に機能を追加する手法として採用されている。

## 実装パターン

### 基本構造

Object Augmentation は3つの要素で構成される:

1. **増強インターフェースの定義** -- 追加するメソッド・プロパティの型
2. **`withXxx()` 関数** -- `Object.defineProperty` で実行時にメソッドを注入
3. **交差型の返却** -- `T & AugmentedInterface` で型推論を維持

```typescript
// packages/agents/src/mcp/x402.ts:77-88
// 1. 増強インターフェースの定義
interface X402AugmentedServer {
  paidTool(
    name: string,
    config: ToolConfig,
    annotations: ToolAnnotations & { x402: X402PaymentRequirement; },
    handler: ToolCallback,
  ): void;
}
```

```typescript
// packages/agents/src/mcp/x402.ts:98-101
// 2. withXxx() 関数のシグネチャ: ジェネリクスで元の型を保持
export function withX402<T extends McpServer>(
  server: T,
  cfg: X402Config
): T & X402AugmentedServer {
```

```typescript
// packages/agents/src/mcp/x402.ts:285-293
// 3. Object.defineProperty で安全に注入し、交差型として返却
Object.defineProperty(server, "paidTool", {
  value: paidTool,
  writable: false,
  enumerable: false,
  configurable: true,
});
return server as T & X402AugmentedServer;
```

### メソッドインターセプト

既存メソッドをラップして振る舞いを拡張する場合は、元のメソッドを保存してから `Object.defineProperty` で差し替える。`withX402Client` は `listTools` と `callTool` を支払いロジックでラップする。

```typescript
// withX402Client のパターン（概念コード）
// 元のメソッドを保存
const originalCallTool = client.callTool.bind(client);

// 支払いロジックでラップ
async function augmentedCallTool(params, resultSchema, options) {
  // 支払いヘッダーの付与やレスポンスの検証を挿入
  const result = await originalCallTool(params, resultSchema, options);
  return result;
}

Object.defineProperty(client, "callTool", {
  value: augmentedCallTool,
  writable: false,
  enumerable: false,
  configurable: true,
});
```

### Lazy Initialization

外部サービスへの接続を初回使用時まで遅延させ、失敗時にはリトライ可能にする。

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

## Good Example

```typescript
// Object Augmentation パターンの正しい実装

// 増強インターフェース
interface LoggingAugmented {
  logRequest(method: string, params: unknown): void;
}

// withXxx 関数
function withLogging<T extends { handle(req: Request): Response; }>(
  server: T,
  logger: Logger,
): T & LoggingAugmented {
  // 既存メソッドのインターセプト: 元のメソッドを保存
  const originalHandle = server.handle.bind(server);

  Object.defineProperty(server, "handle", {
    value: (req: Request) => {
      logger.info(`${req.method} ${req.url}`);
      return originalHandle(req);
    },
    writable: false, // 意図しない上書きを防止
    enumerable: false, // 列挙時に表示しない
    configurable: true, // テスト時のモック差し替えを許容
  });

  // 新メソッドの追加
  Object.defineProperty(server, "logRequest", {
    value: (method: string, params: unknown) => {
      logger.debug(`RPC: ${method}`, params);
    },
    writable: false,
    enumerable: false,
    configurable: true,
  });

  return server as T & LoggingAugmented;
}

// 利用側: 元の型 + 増強された型が推論される
const server = new McpServer({ name: "my-server", version: "1.0" });
const enhanced = withLogging(server, console);
enhanced.handle(request); // 元のメソッド（ログ付き）
enhanced.logRequest("ping", {}); // 追加されたメソッド
```

## Bad Example

```typescript
// Bad 1: クラス継承で外部 SDK オブジェクトを拡張する
// 問題: SDK のバージョンアップでクラス内部が変わると壊れる
//        利用者が既存インスタンスをそのまま渡せない
class PaidMcpServer extends McpServer {
  paidTool(name: string, config: ToolConfig, handler: ToolCallback) {
    // McpServer の内部実装に依存するコード
    this._tools.set(name, { config, handler }); // private フィールドにアクセス
  }
}

// Bad 2: writable を制御せずに直接代入で注入する
// 問題: 後から誰でも上書きできてしまう
function withPayment(server: McpServer) {
  (server as any).paidTool = function(...) { ... };
  return server;
  // 型安全性もない: any キャストが必要
}

// Bad 3: Object.defineProperty で writable: true にする
// 問題: 注入したメソッドが意図せず上書きされるリスクがある
Object.defineProperty(server, "paidTool", {
  value: paidTool,
  writable: true,  // 上書き可能 — augmentation の意図に反する
});
```

## 適用ガイド

### どのような状況で使うべきか

- **外部ライブラリのオブジェクトに機能を追加したい場合**: 継承できない、または継承すべきでないクラスのインスタンスを拡張する
- **複数の直交する拡張を合成したい場合**: `withLogging(withAuth(withPayment(server)))` のようにパイプライン的に適用できる
- **元のオブジェクトのアイデンティティを維持したい場合**: ラッパークラスと異なり、`===` 比較が保たれる

### 導入時の注意点

- **TypeScript の型安全性は交差型に依存する**: IDE のオートコンプリートは交差型を正しく扱うが、リファクタリングツールが `Object.defineProperty` で追加したメソッドを追跡できないケースがある
- **`writable: false` と `configurable: true` の組み合わせが推奨**: `writable: false` で実行時の安全性を確保しつつ、`configurable: true` でテスト時のモック差し替えを可能にする
- **プロパティ名の衝突リスク**: 複数の `withXxx` を適用する際、同名のプロパティを注入すると後勝ちになる。注入するプロパティ名にはプレフィックスを付けるか、衝突検出ロジックを入れるとよい
- **Lazy initialization と組み合わせる**: 外部サービス接続を伴う augmentation では、初回使用時まで接続を遅延させ、失敗時のリトライパスを確保する

### カスタマイズポイント

- **Property Descriptor のオプション**: `enumerable` を `true` にすると `Object.keys()` に含まれる。API として列挙される必要がある場合は `true` に変更する
- **メソッドインターセプトの深度**: 既存メソッドの前後にロジックを挿入する（AOP 的）か、完全に置き換えるかは要件に応じて選択する
- **型の厳密さ**: `T extends McpServer` のようにジェネリクスの制約を厳しくすると、適用可能な対象が限定される一方で、注入するロジックが依存する前提を明示できる

## 参考

- [repos/cloudflare/agents/extensibility-mechanisms.md](../repos/cloudflare/agents/extensibility-mechanisms.md) -- 元の分析
