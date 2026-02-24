# Adapter Implementation Patterns

> リポジトリ: modelcontextprotocol/typescript-sdk
> 分析日: 2026-02-24

## 概要

MCP TypeScript SDK では、Express / Hono / Node.js HTTP の 3 つのフレームワークアダプターが `packages/middleware/` 配下に独立パッケージとして実装されている。これらは「thin integration layers（薄い統合レイヤー）」として設計され、フレームワーク固有の API を Web Standard API ベースのコア実装に橋渡しする役割を担う。注目に値するのは、コア実装を Web Standard API（`Request`/`Response`/`ReadableStream`）で統一し、アダプターの責務を「API 変換」と「セキュリティデフォルトの提供」に限定している点である。この設計により、新しいランタイム（Cloudflare Workers, Deno, Bun）への対応がアダプター不要で実現されている。

## 背景にある原則

- **Web Standard First**: コアロジックは Web Standard API で実装し、ランタイム固有の API はアダプター層でのみ扱う。`WebStandardStreamableHTTPServerTransport` が全ビジネスロジックを持ち、`NodeStreamableHTTPServerTransport` はそれを薄くラップするだけという構造がこの原則を体現している（`packages/server/src/server/streamableHttp.ts:224`, `packages/middleware/node/src/streamableHttp.ts:67`）。

- **Security by Default, Opt-out by Configuration**: セキュリティ保護（DNS rebinding 対策）を localhost バインド時にデフォルトで有効化し、明示的な設定でのみ無効化する。全インターフェースバインド（`0.0.0.0`）時には警告を出すが、ブロックはしない。これはユーザーの意図を尊重しつつ安全な既定値を提供するバランスである（`packages/middleware/express/src/express.ts:60-76`, `packages/middleware/hono/src/hono.ts:70-87`）。

- **Adapter = Translation, Not Logic**: アダプターにビジネスロジックを持たせない。README で「They intentionally do not add new MCP features or 'business logic'」と明記されている（`packages/middleware/README.md:5`）。アダプターの責務は (1) リクエスト/レスポンスの型変換、(2) フレームワーク固有のミドルウェア配線、(3) 安全なデフォルト設定の 3 つに限定される。

- **Shared Validation, Framework-specific Presentation**: バリデーションロジック（`validateHostHeader`）はコアパッケージ（`@modelcontextprotocol/server`）に集約し、アダプターはそれをフレームワーク固有のミドルウェア形式にラップするだけという構造を取る。ロジックの重複を排除しつつ、各フレームワークの慣習に従ったインターフェースを提供している（`packages/server/src/server/middleware/hostHeaderValidation.ts:17`, `packages/middleware/express/src/middleware/hostHeaderValidation.ts:23`, `packages/middleware/hono/src/middleware/hostHeaderValidation.ts:8`）。

## 実例と分析

### コアとアダプターの責務分離

3 つのアダプターは異なる役割を持つ:

| パッケージ                      | 種別                     | 主な責務                                                                     |
| ------------------------------- | ------------------------ | ---------------------------------------------------------------------------- |
| `@modelcontextprotocol/express` | App Factory + Middleware | Express アプリの安全な初期化、Host ヘッダー検証ミドルウェア                  |
| `@modelcontextprotocol/hono`    | App Factory + Middleware | Hono アプリの安全な初期化、JSON ボディパース、Host ヘッダー検証              |
| `@modelcontextprotocol/node`    | Transport Wrapper        | Node.js HTTP (`IncomingMessage`/`ServerResponse`) を Web Standard API に変換 |

Express と Hono のアダプターは Transport を実装せず、「安全に設定されたアプリケーションインスタンス」を返すファクトリ関数を提供する。一方、Node.js アダプターは `Transport` インターフェースを実装し、`WebStandardStreamableHTTPServerTransport` への委譲パターンを使う。

### Delegation パターンによる Transport ラッピング

`NodeStreamableHTTPServerTransport` は `Transport` インターフェースの全メソッドを内部の `WebStandardStreamableHTTPServerTransport` に委譲する。プロパティアクセサ（getter/setter）で `onclose`、`onerror`、`onmessage` コールバックの透過的な委譲を実現している:

```
// packages/middleware/node/src/streamableHttp.ts:103-109
set onclose(handler: (() => void) | undefined) {
    this._webStandardTransport.onclose = handler;
}

get onclose(): (() => void) | undefined {
    return this._webStandardTransport.onclose;
}
```

この委譲パターンにより、利用者は `NodeStreamableHTTPServerTransport` を `Transport` インターフェースとして使いつつ、内部実装は Web Standard API に統一されている。

### @hono/node-server による API 変換ブリッジ

Node.js アダプターは `@hono/node-server` の `getRequestListener` を使って Node.js HTTP 型を Web Standard `Request`/`Response` に変換する。特筆すべきは `overrideGlobalObjects: false` オプションで、Hono がグローバルな `Response` オブジェクトを上書きすることを防いでいる。これは Next.js など、ネイティブ `Response` を拡張するフレームワークとの共存のために必要な対策である:

```
// packages/middleware/node/src/streamableHttp.ts:78-90
// overrideGlobalObjects: false prevents Hono from overwriting global Response, which would
// break frameworks like Next.js whose response classes extend the native Response
this._requestListener = getRequestListener(
    async (webRequest: Request) => {
        const context = this._requestContext.get(webRequest);
        return this._webStandardTransport.handleRequest(webRequest, {
            authInfo: context?.authInfo,
            parsedBody: context?.parsedBody
        });
    },
    { overrideGlobalObjects: false }
);
```

### ミドルウェアの同型設計

Express と Hono の Host ヘッダー検証ミドルウェアは、同じコアロジック（`validateHostHeader`）をフレームワーク固有の形式で提供する。Express 版は `(req, res, next)` シグネチャの `RequestHandler` を返し、Hono 版は `async (c, next)` シグネチャの `MiddlewareHandler` を返す。エラーレスポンスの形式（JSON-RPC エラー）は統一されている:

Express 版:

```
// packages/middleware/express/src/middleware/hostHeaderValidation.ts:23-39
export function hostHeaderValidation(allowedHostnames: string[]): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        const result = validateHostHeader(req.headers.host, allowedHostnames);
        if (!result.ok) {
            res.status(403).json({
                jsonrpc: '2.0',
                error: { code: -32_000, message: result.message },
                id: null
            });
            return;
        }
        next();
    };
}
```

Hono 版:

```
// packages/middleware/hono/src/middleware/hostHeaderValidation.ts:8-26
export function hostHeaderValidation(allowedHostnames: string[]): MiddlewareHandler {
    return async (c, next) => {
        const result = validateHostHeader(c.req.header('host'), allowedHostnames);
        if (!result.ok) {
            return c.json(
                { jsonrpc: '2.0', error: { code: -32_000, message: result.message }, id: null },
                403
            );
        }
        return await next();
    };
}
```

### フレームワーク固有の差異の吸収

Hono アダプターは Express にはない JSON ボディパース処理を含む。Express は `express.json()` が組み込みで提供されるが、Hono にはこれに相当する機能がないため、アダプターが `parsedBody` を `Context` に格納するミドルウェアを追加している。上流ミドルウェアが既に `parsedBody` を設定している場合はスキップする防御的な設計も特徴的:

```
// packages/middleware/hono/src/hono.ts:47-68
app.use('*', async (c: Context, next) => {
    // If an upstream middleware already set parsedBody, keep it.
    if (c.get('parsedBody') !== undefined) {
        return await next();
    }
    const ct = c.req.header('content-type') ?? '';
    if (!ct.includes('application/json')) {
        return await next();
    }
    try {
        const parsed = await c.req.raw.clone().json();
        c.set('parsedBody', parsed);
    } catch {
        return c.text('Invalid JSON', 400);
    }
    return await next();
});
```

### WeakMap によるリクエストコンテキストの受け渡し

Node.js アダプターは `WeakMap<Request, { authInfo?, parsedBody? }>` を使って、Node.js HTTP リクエストから Web Standard Request への変換時にコンテキスト情報を伝搬する。WeakMap を選択することで、リクエストのライフサイクル終了後に自動的にガベージコレクションされる:

```
// packages/middleware/node/src/streamableHttp.ts:71
private _requestContext: WeakMap<Request, { authInfo?: AuthInfo; parsedBody?: unknown }> = new WeakMap();
```

### peerDependencies によるフレームワーク依存の管理

Express と Hono のアダプターは `dependencies` を空にし、フレームワーク本体を `peerDependencies` で宣言する。これにより、利用者がバージョンを制御でき、バンドルサイズの重複を防ぐ。Node.js アダプターのみ `@hono/node-server` を `dependencies` に含むが、これは利用者が直接意識しないユーティリティであるため:

```
// packages/middleware/express/package.json:46-50
"dependencies": {},
"peerDependencies": {
    "@modelcontextprotocol/server": "workspace:^",
    "express": "catalog:runtimeServerOnly"
}
```

## コード例

```
// packages/server/src/server/middleware/hostHeaderValidation.ts:17-35
// コアバリデーションロジック -- フレームワーク非依存
export function validateHostHeader(
    hostHeader: string | null | undefined,
    allowedHostnames: string[]
): HostHeaderValidationResult {
    if (!hostHeader) {
        return { ok: false, errorCode: 'missing_host', message: 'Missing Host header' };
    }
    let hostname: string;
    try {
        hostname = new URL(`http://${hostHeader}`).hostname;
    } catch {
        return { ok: false, errorCode: 'invalid_host_header', message: `Invalid Host header: ${hostHeader}`, hostHeader };
    }
    if (!allowedHostnames.includes(hostname)) {
        return { ok: false, errorCode: 'invalid_host', message: `Invalid Host: ${hostname}`, hostHeader, hostname };
    }
    return { ok: true, hostname };
}
```

```
// packages/middleware/node/src/streamableHttp.ts:165-186
// Node.js HTTP -> Web Standard 変換 + コンテキスト伝搬
async handleRequest(
    req: IncomingMessage & { auth?: AuthInfo },
    res: ServerResponse,
    parsedBody?: unknown
): Promise<void> {
    const authInfo = req.auth;
    const handler = getRequestListener(
        async (webRequest: Request) => {
            return this._webStandardTransport.handleRequest(webRequest, {
                authInfo,
                parsedBody
            });
        },
        { overrideGlobalObjects: false }
    );
    await handler(req, res);
}
```

## パターンカタログ

- **Delegation / Wrapper (構造パターン)**
  - 解決する問題: フレームワーク固有の API とプラットフォーム非依存のコア実装を分離する
  - 適用条件: コアロジックが特定のランタイム API に依存せず、Web Standard API で記述できる場合
  - コード例: `packages/middleware/node/src/streamableHttp.ts:67-91`（`NodeStreamableHTTPServerTransport` が `WebStandardStreamableHTTPServerTransport` をラップ）
  - 注意点: プロパティアクセサ（getter/setter）で全コールバックを委譲する必要があり、インターフェースが大きいと手間が増える

- **Abstract Factory (生成パターン) の簡易版**
  - 解決する問題: フレームワークの初期化手順を標準化し、安全なデフォルト設定を提供する
  - 適用条件: フレームワークのセットアップに定型的なセキュリティ設定が必要な場合
  - コード例: `packages/middleware/express/src/express.ts:53`（`createMcpExpressApp`）、`packages/middleware/hono/src/hono.ts:41`（`createMcpHonoApp`）
  - 注意点: ファクトリが返すのはフレームワーク固有のアプリインスタンスであり、共通インターフェースではない（型が異なる）

- **Strategy (振る舞いパターン) -- ミドルウェアの同型実装**
  - 解決する問題: 同一のバリデーションロジックを複数のフレームワークのミドルウェア形式で提供する
  - 適用条件: バリデーション・認証・ロギングなどの横断的関心事を複数フレームワークで共有する場合
  - コード例: `packages/server/src/server/middleware/hostHeaderValidation.ts:17`（共有ロジック）+ 各アダプターの `hostHeaderValidation.ts`
  - 注意点: エラーレスポンスの形式をフレームワーク間で統一する必要がある

## Good Patterns

- **コアロジックの Web Standard API 統一**: `WebStandardStreamableHTTPServerTransport` に全ビジネスロジックを集約し、ランタイム固有のアダプターを薄いラッパーに留める設計。新しいランタイム（Cloudflare Workers, Deno, Bun）は Web Standard 準拠のため、アダプター不要でコアを直接利用できる。

```
// packages/server/src/server/streamableHttp.ts:1-8
// コメントが設計思想を明示している
/**
 * Web Standards Streamable HTTP Server Transport
 *
 * This is the core transport implementation using Web Standard APIs (`Request`, `Response`, `ReadableStream`).
 * It can run on any runtime that supports Web Standards: Node.js 18+, Cloudflare Workers, Deno, Bun, etc.
 *
 * For Node.js Express/HTTP compatibility, use NodeStreamableHTTPServerTransport which wraps this transport.
 */
```

- **既存ライブラリの活用によるアダプター薄型化**: Node.js アダプターは自前で HTTP 変換を実装せず、`@hono/node-server` の `getRequestListener` を利用して Node.js HTTP 型と Web Standard 型を変換している。車輪の再発明を避け、SSE ストリーミングなどの複雑な変換を信頼性の高い既存実装に委ねている。

```
// packages/middleware/node/src/streamableHttp.ts:12
import { getRequestListener } from '@hono/node-server';
```

- **上流ミドルウェアの尊重**: Hono アダプターの JSON パース処理は、`parsedBody` が既にセットされている場合をスキップする。これにより利用者が独自のボディパース戦略を使える柔軟性を確保している。

```
// packages/middleware/hono/src/hono.ts:49-51
if (c.get('parsedBody') !== undefined) {
    return await next();
}
```

- **Deprecated の段階的移行**: `WebStandardStreamableHTTPServerTransport` 内の `allowedHosts`/`allowedOrigins`/`enableDnsRebindingProtection` オプションは `@deprecated` タグ付きで残存し、外部ミドルウェアへの移行を促している。機能を一気に削除せず、移行パスを提供するアプローチ。

```
// packages/server/src/server/streamableHttp.ts:117-135
/**
 * @deprecated Use external middleware for host validation instead.
 */
allowedHosts?: string[];
```

## Anti-Patterns / 注意点

- **グローバルオブジェクトの汚染**: `@hono/node-server` はデフォルトでグローバルな `Response` を上書きする。これは Next.js など、ネイティブ `Response` を拡張するフレームワークを壊す。

Bad:

```
// overrideGlobalObjects のデフォルトは true
this._requestListener = getRequestListener(handler);
```

Better:

```
// packages/middleware/node/src/streamableHttp.ts:80-90
this._requestListener = getRequestListener(handler, { overrideGlobalObjects: false });
```

- **Transport インターフェースの手動委譲の冗長性**: `NodeStreamableHTTPServerTransport` は `Transport` インターフェースの全メンバーに対して getter/setter を手動で記述している。インターフェースが拡張されるたびに委譲コードも更新が必要で、保守負担が増える。Proxy パターンや mixin の活用で自動化できる可能性がある。

Bad:

```
// 7 つのプロパティ/メソッドを個別に委譲
set onclose(handler) { this._webStandardTransport.onclose = handler; }
get onclose() { return this._webStandardTransport.onclose; }
set onerror(handler) { this._webStandardTransport.onerror = handler; }
get onerror() { return this._webStandardTransport.onerror; }
// ... さらに続く
```

Better（概念例）:

```
// Proxy による自動委譲
return new Proxy(this, {
    get: (target, prop) => prop in target ? target[prop] : target._webStandardTransport[prop]
});
```

- **Request ごとの getRequestListener 再生成**: `handleRequest` メソッドが呼ばれるたびに `getRequestListener` で新しいハンドラーを生成している。これは `authInfo` と `parsedBody` をリクエストコンテキストとして渡すために必要な措置だが、パフォーマンスへの影響がある可能性がある。

```
// packages/middleware/node/src/streamableHttp.ts:173-181
// handleRequest が呼ばれるたびにリスナーを再生成
const handler = getRequestListener(
    async (webRequest: Request) => {
        return this._webStandardTransport.handleRequest(webRequest, {
            authInfo,
            parsedBody
        });
    },
    { overrideGlobalObjects: false }
);
```

## 導出ルール

- `[MUST]` マルチフレームワーク対応のライブラリでは、コアロジックをフレームワーク非依存の共通層（理想的には Web Standard API）に集約し、アダプターは型変換とデフォルト設定のみに責務を限定する
  - 根拠: MCP SDK では `WebStandardStreamableHTTPServerTransport` に全ロジックを集約し、3 つのアダプターを各 35-205 行に抑えている（`packages/server/src/server/streamableHttp.ts`, `packages/middleware/*/src/`）

- `[MUST]` アダプター層にビジネスロジックを追加しない -- フレームワーク固有の処理（ボディパース、ミドルウェア配線）のみ許容する
  - 根拠: `packages/middleware/README.md:5` で「They intentionally do not add new MCP features or 'business logic'」と明記され、全アダプターがこの原則に従っている

- `[SHOULD]` セキュリティ関連のデフォルトは「安全側」に倒し、利用者が明示的にオプトアウトする設計にする（ただし、意図的な設定変更はブロックせず警告に留める）
  - 根拠: Express/Hono アダプターは localhost バインド時に DNS rebinding 保護をデフォルト有効化し、`0.0.0.0` バインド時は `console.warn` で注意喚起するのみ（`packages/middleware/express/src/express.ts:60-76`）

- `[SHOULD]` 横断的関心事（バリデーション、認証、ロギング等）のロジックはフレームワーク非依存な純粋関数として実装し、各アダプターではフレームワークのミドルウェア形式にラップするだけにする
  - 根拠: `validateHostHeader` はプレーンな関数で、Express/Hono のミドルウェアはこれを呼ぶだけのアダプター（`packages/server/src/server/middleware/hostHeaderValidation.ts:17`）

- `[SHOULD]` フレームワーク依存パッケージは `peerDependencies` で宣言し、実行時依存に含めない -- 利用者がバージョンを制御できるようにする
  - 根拠: Express/Hono アダプターは `dependencies: {}` で、フレームワーク本体は `peerDependencies` に宣言（`packages/middleware/express/package.json:46-49`）

- `[SHOULD]` サードパーティの API 変換ライブラリを使用する際は、グローバルオブジェクトの上書きや副作用を明示的に無効化するオプションを確認・設定する
  - 根拠: `@hono/node-server` の `overrideGlobalObjects: false` 設定が Next.js との互換性問題を防いでいる（`packages/middleware/node/src/streamableHttp.ts:78-89`）

- `[AVOID]` コアの Transport 内にフレームワーク固有のバリデーションオプション（`allowedHosts` 等）を混入させる -- 横断的関心事は外部ミドルウェアとして分離する
  - 根拠: `WebStandardStreamableHTTPServerTransport` の `allowedHosts`/`allowedOrigins` は `@deprecated` として残存しており、外部ミドルウェアへの移行が推奨されている（`packages/server/src/server/streamableHttp.ts:117-135`）

## 適用チェックリスト

- [ ] コアのビジネスロジックは Web Standard API（`Request`/`Response`/`ReadableStream`）で記述されているか
- [ ] アダプター層は型変換・ミドルウェア配線・デフォルト設定のみに責務が限定されているか
- [ ] バリデーション・認証などの横断的関心事は、フレームワーク非依存な純粋関数として切り出されているか
- [ ] フレームワーク依存は `peerDependencies` で宣言し、利用者がバージョンを制御できるか
- [ ] localhost バインド時のセキュリティ保護がデフォルトで有効になっているか
- [ ] サードパーティライブラリのグローバル副作用（オブジェクト上書き等）を確認し、必要に応じて無効化しているか
- [ ] 上流ミドルウェアが設定した値を尊重する防御的コード（既存値チェック）があるか
- [ ] 既存の deprecated API に対して段階的な移行パス（警告 + 代替手段の案内）を提供しているか
