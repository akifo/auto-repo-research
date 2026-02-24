# design-philosophy

> リポジトリ: modelcontextprotocol/typescript-sdk
> 分析日: 2026-02-24

## 概要

MCP TypeScript SDK の設計判断を横断的に分析し、Web Standards 準拠・最小限の依存・双方向プロトコルという3つの設計軸がどのように具体的なコードに表れているかを明らかにする。この SDK は「あらゆるランタイムで動く双方向プロトコル実装」という野心的なゴールを掲げており、そのために下した設計判断には、プラットフォーム抽象化やプロトコル設計における普遍的な教訓が多数含まれている。

## 背景にある原則

- **Web Standards First（標準 API への依存を最大化し、ランタイム固有 API への依存を最小化する）**: サーバーサイドの核となる `WebStandardStreamableHTTPServerTransport` は `Request`/`Response`/`ReadableStream` のみで構成され、Node.js 固有の `IncomingMessage`/`ServerResponse` は middleware パッケージに隔離されている。これにより Node.js、Cloudflare Workers、Deno、Bun のすべてで同一コアが動作する。根拠: `packages/server/src/server/streamableHttp.ts:1-8` のモジュールコメント、および `packages/middleware/README.md` の "thin integration layers" 宣言。

- **依存逆転による Platform Shim（ランタイム差異はビルド時の条件付きエクスポートで吸収する）**: `package.json` の `exports` 条件（`workerd` / `browser` / `default`）で `shimsNode.ts` と `shimsWorkerd.ts` を切り替え、同一 import パス `@modelcontextprotocol/server/_shims` からランタイムに適した実装を提供する。Ajv は `eval` / `new Function` を使うため Cloudflare Workers では動作せず、代わりに `@cfworker/json-schema` ベースのバリデーターが自動選択される。根拠: `packages/server/src/shimsNode.ts`, `packages/server/src/shimsWorkerd.ts`。

- **Capability Negotiation（利用可能な機能を実行時に交渉し、互換性を段階的に拡張する）**: 初期化時にクライアントとサーバーが互いの capabilities を交換し、サポートされていない機能の呼び出しを `assertCapabilityForMethod` で事前に遮断する。これにより、新機能を追加しても古いクライアント/サーバーとの後方互換性が保たれ、プロトコルの漸進的進化が可能になる。根拠: `packages/server/src/server/server.ts:246-278`, `packages/core/src/shared/protocol.ts:1002-1030`。

- **Thin Adapter Pattern（フレームワーク統合は薄いラッパーに徹し、ビジネスロジックを混入させない）**: Express / Hono / Node.js HTTP 用の middleware パッケージは「MCP 機能を追加しない」ことを明文化しており、リクエスト/レスポンスの型変換と安全なデフォルト設定のみを担当する。根拠: `packages/middleware/README.md` の "They intentionally do not add new MCP features or business logic."。

## 実例と分析

### Web Standards Transport の層構造

サーバーサイド Transport は2層で構成される。核となる `WebStandardStreamableHTTPServerTransport` は Web Standard API のみに依存し、`handleRequest(req: Request): Promise<Response>` という署名で任意のランタイムから呼び出せる。Node.js 向けの `NodeStreamableHTTPServerTransport` はこれを内部に保持し、`@hono/node-server` の `getRequestListener` を介して `IncomingMessage`/`ServerResponse` を Web Standard に変換する。

```typescript
// packages/server/src/server/streamableHttp.ts:224
export class WebStandardStreamableHTTPServerTransport implements Transport {
  // Web Standard Request/Response のみで動作
  async handleRequest(req: Request, options?: HandleRequestOptions): Promise<Response> {
    switch (req.method) {
      case "POST":
        return this.handlePostRequest(req, options);
      case "GET":
        return this.handleGetRequest(req);
      case "DELETE":
        return this.handleDeleteRequest(req);
      default:
        return this.handleUnsupportedRequest();
    }
  }
}
```

```typescript
// packages/middleware/node/src/streamableHttp.ts:67-91
export class NodeStreamableHTTPServerTransport implements Transport {
    private _webStandardTransport: WebStandardStreamableHTTPServerTransport;
    private _requestListener: ReturnType<typeof getRequestListener>;

    constructor(options: StreamableHTTPServerTransportOptions = {}) {
        this._webStandardTransport = new WebStandardStreamableHTTPServerTransport(options);
        // Node.js HTTP -> Web Standard 変換を @hono/node-server に委譲
        this._requestListener = getRequestListener(
            async (webRequest: Request) => {
                return this._webStandardTransport.handleRequest(webRequest, ...);
            },
            { overrideGlobalObjects: false }
        );
    }
}
```

### Platform Shim による条件付きエクスポート

`package.json` の `exports` フィールドでランタイムを判別し、異なる shim ファイルをロードする。

```jsonc
// packages/server/package.json (抜粋)
"./_shims": {
    "workerd": { "import": "./dist/shimsWorkerd.mjs" },
    "browser": { "import": "./dist/shimsWorkerd.mjs" },
    "default": { "import": "./dist/shimsNode.mjs" }
}
```

```typescript
// packages/server/src/shimsNode.ts:6-7
export { AjvJsonSchemaValidator as DefaultJsonSchemaValidator } from "@modelcontextprotocol/core";
export { default as process } from "node:process";
```

```typescript
// packages/server/src/shimsWorkerd.ts:6-23
export { CfWorkerJsonSchemaValidator as DefaultJsonSchemaValidator } from "@modelcontextprotocol/core";
// stdin/stdout は Workers で非サポート - 明確なエラーで通知
export const process = {
  get stdin(): never {
    return notSupported();
  },
  get stdout(): never {
    return notSupported();
  },
};
```

### Pluggable Validation の Strategy パターン

JSON Schema バリデーションは `jsonSchemaValidator` インターフェースで抽象化され、2つの実装が提供される。Ajv はコード生成を使うため高速だが `eval` 制約のある環境では動かない。`@cfworker/json-schema` はインタプリタ方式で Edge Runtime 互換。

```typescript
// packages/core/src/validation/types.ts:51-59
export interface jsonSchemaValidator {
  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T>;
}
```

### 双方向プロトコルの対称設計

`Protocol` 抽象クラスが Client と Server の両方の基底となり、リクエスト送信・受信の仕組みを共有する。Client から Server へのリクエストだけでなく、Server から Client への sampling/elicitation リクエストも同一の `request()` / `setRequestHandler()` メカニズムで処理される。

```typescript
// packages/core/src/shared/protocol.ts:392
export abstract class Protocol<ContextT extends BaseContext> {
    // 送信側: 共通の request() メソッド
    request<T extends AnySchema>(request: Request, resultSchema: T, options?: RequestOptions): Promise<SchemaOutput<T>> { ... }

    // 受信側: 共通の handler 登録
    setRequestHandler<M extends RequestMethod>(method: M, handler: ...): void { ... }

    // サブクラスが実装する capability チェック
    protected abstract assertCapabilityForMethod(method: RequestMethod): void;
    protected abstract assertRequestHandlerCapability(method: string): void;
}
```

### Experimental ディレクトリによる段階的機能導入

実験的機能は `experimental/` ディレクトリに隔離され、`client.experimental.tasks` のようなプロパティアクセスで利用する。安定化まで API が変更される可能性があることを構造的に表現している。

```typescript
// packages/client/src/client/client.ts:267-274
get experimental(): { tasks: ExperimentalClientTasks } {
    if (!this._experimental) {
        this._experimental = {
            tasks: new ExperimentalClientTasks(this)
        };
    }
    return this._experimental;
}
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: ランタイムごとに異なる JSON Schema バリデーション実装の切り替え
  - 適用条件: 同一インターフェースで複数の実装を差し替える必要がある場合
  - コード例: `packages/core/src/validation/types.ts:51-59`, `packages/core/src/validation/ajvProvider.ts:38`, `packages/core/src/validation/cfWorkerProvider.ts:35`
  - 注意点: 条件付きエクスポートと組み合わせることで、利用者が明示的に選択する必要をなくしている

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: Client/Server 共通のプロトコル処理フレームワークに、個別の capability チェックロジックを埋め込む
  - 適用条件: 処理の骨格は共通だが、一部のステップがサブクラスで異なる場合
  - コード例: `packages/core/src/shared/protocol.ts:392` (Protocol 抽象クラス), `packages/server/src/server/server.ts:246` (assertCapabilityForMethod の実装)
  - 注意点: 抽象メソッドが多すぎると理解コストが上がる。この SDK では5つの abstract メソッドに抑えている

- **Adapter パターン** (分類: 構造)
  - 解決する問題: Node.js HTTP API (`IncomingMessage`/`ServerResponse`) と Web Standard API (`Request`/`Response`) の橋渡し
  - 適用条件: 既存の API を別のインターフェースに変換する必要がある場合
  - コード例: `packages/middleware/node/src/streamableHttp.ts:67-91`
  - 注意点: Adapter はビジネスロジックを一切持たず、型変換のみに徹する

## Good Patterns

- **Web Standard を核にし、ランタイム固有 API を Adapter で包む**: `WebStandardStreamableHTTPServerTransport` が核であり、Node.js 固有の transport はその薄いラッパーに過ぎない。これにより新しいランタイム（Bun、Deno）のサポートが既存コードの変更なしに実現できる。

```typescript
// packages/server/src/server/streamableHttp.ts:1-8
/**
 * Web Standards Streamable HTTP Server Transport
 * This is the core transport implementation using Web Standard APIs
 * (Request, Response, ReadableStream).
 * It can run on any runtime that supports Web Standards:
 * Node.js 18+, Cloudflare Workers, Deno, Bun, etc.
 */
```

- **Fetch の差し替え可能設計**: クライアントは `FetchLike` 型で fetch 関数を受け取り、テストやカスタム実装の注入を容易にしている。`createFetchWithInit` でベース設定のマージも提供。

```typescript
// packages/core/src/shared/transport.ts:3
export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

// packages/client/src/client/streamableHttp.ts:109
fetch?: FetchLike;
```

- **SdkError と ProtocolError の分離**: ローカルで発生する SDK エラー（タイムアウト、未接続）と、ワイヤー上を流れる JSON-RPC プロトコルエラーを型レベルで分離し、文字列 enum でエラーコードを識別可能にしている。

```typescript
// packages/core/src/errors/sdkErrors.ts:9-37
export enum SdkErrorCode {
  NotConnected = "NOT_CONNECTED",
  RequestTimeout = "REQUEST_TIMEOUT",
  CapabilityNotSupported = "CAPABILITY_NOT_SUPPORTED",
  // ...
}
```

## Anti-Patterns / 注意点

- **Transport インターフェースのコールバックプロパティ**: `Transport` インターフェースは `onclose` / `onerror` / `onmessage` をオプショナルプロパティとして定義しており、`Protocol.connect()` でこれらを上書きする。EventTarget や EventEmitter パターンと比較して、複数リスナーの登録ができず、上書き前の既存コールバックの保存ロジックが必要になっている。

```typescript
// Bad: コールバックの上書き連鎖
// packages/core/src/shared/protocol.ts:688-713
async connect(transport: Transport): Promise<void> {
    this._transport = transport;
    const _onclose = this.transport?.onclose;  // 既存を退避
    this._transport.onclose = () => {
        _onclose?.();  // 退避したものを呼んでから
        this._onclose();  // 自分の処理
    };
}

// Better: EventTarget ベースなら複数リスナーが自然に共存
// transport.addEventListener('close', () => { ... });
```

ただし、この設計はパフォーマンスとシンプルさを優先した意図的な判断である可能性が高い。Transport は常に Protocol が排他的に所有するため、複数リスナーの必要性は低い。

- **Capability の遅延チェック（デフォルト off）**: `enforceStrictCapabilities` がデフォルトで `false` になっており、サーバーが capability を宣言していなくても呼び出しが通ってしまう。後方互換性のためだが、新規プロジェクトでは意図しない動作の原因になりうる。

```typescript
// packages/core/src/shared/protocol.ts:88-89
// Currently this defaults to `false`, for backwards compatibility
// with SDK versions that did not advertise capabilities correctly.
// In future, this will default to `true`.
enforceStrictCapabilities?: boolean;
```

## 導出ルール

- `[MUST]` プロトコル SDK の Transport 層は Web Standard API（`Request`/`Response`/`ReadableStream`/`fetch`）を核に設計し、ランタイム固有 API は別パッケージの Adapter に隔離する
  - 根拠: MCP SDK は `WebStandardStreamableHTTPServerTransport` を核にすることで、Node.js/Workers/Deno/Bun すべてで同一コアを再利用し、ランタイム固有のコードを `packages/middleware/` に閉じ込めている（`packages/server/src/server/streamableHttp.ts:1-8`）

- `[MUST]` 双方向プロトコルでは、リクエスト送信とリクエスト受信の仕組みを共通の基底クラスに統合し、Client/Server の差異は capability チェックの abstract メソッドで表現する
  - 根拠: `Protocol` 抽象クラスが `request()` と `setRequestHandler()` を共通実装として提供し、Client と Server は `assertCapabilityForMethod` のみを各自で実装している（`packages/core/src/shared/protocol.ts:392`）

- `[SHOULD]` ランタイムごとの実装差異は、条件付きエクスポート（`package.json` の `exports` conditions）と Platform Shim パターンで吸収し、利用者が明示的な分岐を書かずに済むようにする
  - 根拠: `_shims` サブパスで `workerd` / `default` 条件を使い分け、Node.js では Ajv、Workers では `@cfworker/json-schema` が自動選択される（`packages/server/package.json`, `packages/server/src/shimsNode.ts`, `packages/server/src/shimsWorkerd.ts`）

- `[SHOULD]` クライアント/サーバー間の Capability Negotiation を初期化時に行い、サポート外の機能呼び出しを早期に遮断する仕組みを設ける
  - 根拠: `initialize` ハンドラで capabilities を交換し、`assertCapabilityForMethod` で呼び出し前にチェックすることで、未サポート機能の呼び出しを明確なエラーとして報告している（`packages/server/src/server/server.ts:423-439`, `packages/server/src/server/server.ts:246-278`）

- `[SHOULD]` 実験的 API は `experimental/` ディレクトリとプロパティアクセス（`client.experimental.tasks`）で隔離し、安定 API と明確に分離する
  - 根拠: Tasks 機能は `packages/*/src/experimental/` に配置され、`@experimental` JSDoc タグで警告を表示し、安定 API の破壊なしに削除・変更できるようになっている（`packages/client/src/client/client.ts:267-274`）

- `[SHOULD]` フレームワーク統合用のパッケージ（middleware）は「MCP 機能を追加しない」制約を明文化し、型変換と安全なデフォルト設定のみを担当させる
  - 根拠: `packages/middleware/README.md` で "intentionally do not add new MCP features or business logic" と明記し、Express/Hono パッケージは DNS rebinding protection とリクエスト変換のみを提供している

- `[AVOID]` fetch / Headers / AbortController 等の Web Standard API を自前で再実装すること。代わりに `FetchLike` 型のように標準の型シグネチャを受け入れ、テスト時の差し替えを DI で解決する
  - 根拠: クライアント Transport は `FetchLike` 型で fetch 関数を受け取る設計とし、グローバル `fetch` への暗黙的依存を避けている（`packages/core/src/shared/transport.ts:3`, `packages/client/src/client/streamableHttp.ts:109`）

## 適用チェックリスト

- [ ] SDK/ライブラリの Transport 層が Web Standard API（`Request`/`Response`/`ReadableStream`/`fetch`）で記述されているか。Node.js 固有 API に直接依存していないか
- [ ] ランタイム固有の差異（Node.js vs Edge Runtime）を条件付きエクスポートまたは Platform Shim で吸収しているか。利用者側に `if (isNode)` 分岐を強いていないか
- [ ] プロトコルの Client/Server 間で共通の処理（メッセージルーティング、タイムアウト管理等）が基底クラスに統合されているか。差異は抽象メソッドで表現されているか
- [ ] 初期化時に Capability Negotiation を行い、サポート外の機能呼び出しを事前に遮断する仕組みがあるか
- [ ] 実験的 API が安定 API から構造的に分離されているか（ディレクトリ、プロパティアクセス、JSDoc タグ等）
- [ ] フレームワーク統合パッケージが「薄い Adapter」に徹しているか。ビジネスロジックが混入していないか
- [ ] 外部の fetch / validator 等を DI で差し替え可能にしているか。テスタビリティは確保されているか
