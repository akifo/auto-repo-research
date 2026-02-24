# middleware-composition

> リポジトリ: modelcontextprotocol/typescript-sdk
> 分析日: 2026-02-24

## 概要

MCP TypeScript SDK には「ミドルウェア」という語に二つの異なる意味がある。一つはクライアントサイドの fetch リクエストパイプライン (`packages/client/src/client/middleware.ts`)、もう一つはサーバーサイドのフレームワークアダプター (`packages/middleware/`)。この二重構造を横断的に分析することで、関数合成によるリクエスト拡張パターン、薄いアダプター層の設計原則、そしてプラットフォーム横断でバリデーションロジックを共有するアーキテクチャが浮かび上がる。特に、fetch API のシグネチャをミドルウェアの合成単位として採用している点は、Web Standards 時代のミドルウェア設計として注目に値する。

## 背景にある原則

- **プラットフォーム標準 API を合成単位にすべき**: `FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>` という Web 標準の fetch シグネチャをミドルウェアの合成単位に採用している (`packages/core/src/shared/transport.ts:3`)。独自のコンテキストオブジェクトではなく、プラットフォーム標準の型を使うことで、任意の fetch 互換関数をそのまま組み込め、学習コストと結合度を下げられる。

- **アダプター層は MCP ロジックを持たず、変換のみに徹すべき**: `packages/middleware/README.md` に明記されているとおり、フレームワークアダプターは「thin integration layers」であり、MCP の機能やビジネスロジックを追加しない。型変換 (Node.js `IncomingMessage` → Web Standard `Request`)、ボディパース、セキュリティデフォルトだけを担う。これにより、フレームワーク依存部分を最小限に抑え、コアロジックの再利用性を最大化している。

- **セキュリティバリデーションはコアに実装し、アダプターはラッピングのみにすべき**: DNS リバインディング防御の検証ロジック `validateHostHeader()` は `@modelcontextprotocol/server` パッケージに一元化され (`packages/server/src/server/middleware/hostHeaderValidation.ts:17`)、Express アダプター・Hono アダプターはそれぞれのフレームワーク固有のレスポンス形式にラップするだけ。ロジックの重複なく、Express/Hono/Web Standard 全てで同一の検証を保証する。

- **合成順序は宣言的に制御すべき**: `applyMiddlewares(...middleware)` は引数の順序どおりにミドルウェアを合成する (`packages/client/src/client/middleware.ts:249-256`)。暗黙の優先順位や依存解決を持たず、利用者が明示的に順序を決定する設計で、挙動の予測可能性を高めている。

## 実例と分析

### クライアントサイド: fetch ミドルウェアパイプライン

MCP クライアントの fetch ミドルウェアは関数合成パターンで実装されている。型定義は極めてシンプルで、`Middleware = (next: FetchLike) => FetchLike` の1行だけ。

```typescript
// packages/client/src/client/middleware.ts:10
export type Middleware = (next: FetchLike) => FetchLike;
```

この定義により、ミドルウェアは「次のハンドラを受け取り、拡張されたハンドラを返す」高階関数となる。Express の `(req, res, next)` パターンとは異なり、リクエストとレスポンスの両方に介入でき、かつ `next` を呼ばないことでショートサーキットも自然に表現できる。

合成関数 `applyMiddlewares` は意図的に単純なループで実装されている:

```typescript
// packages/client/src/client/middleware.ts:249-257
export const applyMiddlewares = (...middleware: Middleware[]): Middleware => {
    return next => {
        let handler = next;
        for (const mw of middleware) {
            handler = mw(handler);
        }
        return handler;
    };
};
```

注目すべきは、ミドルウェアが空の場合に元の `next` をそのまま返す点。テストでも `applyMiddlewares()(mockFetch)` が `mockFetch` と同一であることが検証されている (`packages/client/test/client/middleware.test.ts:633`)。これはパイプラインのアイデンティティ (恒等射) を保証する設計判断で、合成の安全性を担保する。

### createMiddleware ヘルパー: ネストの深さを軽減する

素のミドルウェア型は高階関数のネストが深くなりがちだが、`createMiddleware` ヘルパーがフラットな引数展開を提供する:

```typescript
// packages/client/src/client/middleware.ts:317-318
export const createMiddleware = (
    handler: (next: FetchLike, input: string | URL, init?: RequestInit) => Promise<Response>
): Middleware => {
    return next => (input, init) => handler(next, input as string | URL, init);
};
```

`next => (input, init) => ...` の二重カリー化を `(next, input, init) => ...` のフラットなシグネチャに変換している。ミドルウェアの構造的型付けは維持しつつ、利用者の認知負荷を下げている。

### サーバーサイド: フレームワークアダプターのファクトリパターン

Express と Hono のアダプターは、ファクトリ関数 `createMcpExpressApp()` / `createMcpHonoApp()` として実装されている。両者の構造はほぼ同一で、安全なデフォルト設定を自動適用する:

```typescript
// packages/middleware/express/src/express.ts:53-79
export function createMcpExpressApp(options: CreateMcpExpressAppOptions = {}): Express {
    const { host = '127.0.0.1', allowedHosts } = options;
    const app = express();
    app.use(express.json());

    if (allowedHosts) {
        app.use(hostHeaderValidation(allowedHosts));
    } else {
        const localhostHosts = ['127.0.0.1', 'localhost', '::1'];
        if (localhostHosts.includes(host)) {
            app.use(localhostHostValidation());
        } else if (host === '0.0.0.0' || host === '::') {
            console.warn(
                `Warning: Server is binding to ${host} without DNS rebinding protection. ...`
            );
        }
    }
    return app;
}
```

localhost バインド時は DNS リバインディング防御を自動有効化し、ワイルドカードバインド時は明示的に警告を出す。「安全側にデフォルトを倒す」原則の実装例であり、利用者がセキュリティ設定を忘れても脆弱にならない。

### バリデーションロジックの三層分離

DNS リバインディング防御は三つの層に分離されている:

1. **コアロジック** (`packages/server/src/server/middleware/hostHeaderValidation.ts:17`): `validateHostHeader()` は純粋関数でフレームワーク非依存。`HostHeaderValidationResult` 型を返す
2. **Web Standard ヘルパー** (`hostHeaderValidationResponse()`): コアロジックの結果を Web Standard `Response` に変換
3. **フレームワークアダプター** (`packages/middleware/express/src/middleware/hostHeaderValidation.ts`, `packages/middleware/hono/src/middleware/hostHeaderValidation.ts`): Express の `(req, res, next)` や Hono の `(c, next)` にラップ

```typescript
// packages/server/src/server/middleware/hostHeaderValidation.ts:17-35
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

Express アダプターの `hostHeaderValidation()` はこれを呼び出して Express の応答形式に変換するだけ (`packages/middleware/express/src/middleware/hostHeaderValidation.ts:23-39`)。Hono 版も同様。バリデーションロジックのコピペが一切ない。

### Node.js アダプター: Delegation パターンによるプロトコル変換

`NodeStreamableHTTPServerTransport` は `WebStandardStreamableHTTPServerTransport` を内部に保持し、全メソッドを委譲する。`@hono/node-server` の `getRequestListener()` で Node.js HTTP を Web Standard に変換している:

```typescript
// packages/middleware/node/src/streamableHttp.ts:73-91
constructor(options: StreamableHTTPServerTransportOptions = {}) {
    this._webStandardTransport = new WebStandardStreamableHTTPServerTransport(options);
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
}
```

`overrideGlobalObjects: false` は Next.js との共存のために追加された設定 (`.changeset/brave-lions-glow.md`)。ライブラリが他のフレームワークのグローバルを汚染しないための防御的設定である。

### createFetchWithInit: 基底オプションのマージ

トランスポート層では `createFetchWithInit()` が fetch 呼び出しに基底の `RequestInit` をマージする:

```typescript
// packages/core/src/shared/transport.ts:31-46
export function createFetchWithInit(baseFetch: FetchLike = fetch, baseInit?: RequestInit): FetchLike {
    if (!baseInit) {
        return baseFetch;
    }
    return async (url: string | URL, init?: RequestInit): Promise<Response> => {
        const mergedInit: RequestInit = {
            ...baseInit,
            ...init,
            headers: init?.headers
                ? { ...normalizeHeaders(baseInit.headers), ...normalizeHeaders(init.headers) }
                : baseInit.headers
        };
        return baseFetch(url, mergedInit);
    };
}
```

ヘッダーだけは特別扱いでマージし、他のプロパティは呼び出し時の値で上書きする。`baseInit` が `undefined` の場合は元の fetch をそのまま返すことで、不要なラッパーの生成を避けている。

## パターンカタログ

- **Decorator パターン** (分類: 構造)
  - 解決する問題: 既存の fetch 関数に認証・ロギング等の横断的関心事を追加する
  - 適用条件: 既存のインターフェースを変更せず機能を追加したい場合
  - コード例: `packages/client/src/client/middleware.ts:38-97` (`withOAuth`)、`packages/client/src/client/middleware.ts:158-231` (`withLogging`)
  - 注意点: デコレータの積み重ねが深くなるとデバッグが困難になる。ロギングミドルウェアを最内側に配置すると、他のミドルウェアの変換が可視化される

- **Chain of Responsibility パターン** (分類: 振る舞い)
  - 解決する問題: 複数のミドルウェアを順序付きで実行し、途中でショートサーキット可能にする
  - 適用条件: リクエスト処理に複数段階の変換・検証が必要な場合
  - コード例: `packages/client/src/client/middleware.ts:249-257` (`applyMiddlewares`)
  - 注意点: 合成順序がそのまま実行順序になる。認証は最初、ロギングは最後が一般的

- **Adapter パターン** (分類: 構造)
  - 解決する問題: Node.js HTTP API と Web Standard API のインターフェース差異を吸収する
  - 適用条件: 異なるフレームワーク/ランタイムで同一コアロジックを利用する場合
  - コード例: `packages/middleware/node/src/streamableHttp.ts:67-91` (`NodeStreamableHTTPServerTransport`)
  - 注意点: アダプター層にロジックを入れると、フレームワーク数と同じ数だけロジックが重複する

## Good Patterns

- **fetch シグネチャをミドルウェアの合成単位にする**: `Middleware = (next: FetchLike) => FetchLike` という型定義により、ミドルウェアが Web 標準の fetch と完全互換になる。任意の fetch polyfill やテスト用 mock をそのまま注入でき、ミドルウェアのテストが容易になる。

```typescript
// packages/client/src/client/middleware.ts:10
export type Middleware = (next: FetchLike) => FetchLike;

// テストでは mock fetch を直接注入
// packages/client/test/client/middleware.test.ts:56-57
const enhancedFetch = withOAuth(mockProvider, 'https://api.example.com')(mockFetch);
await enhancedFetch('https://api.example.com/data');
```

- **空のパイプラインに対するアイデンティティ保証**: `applyMiddlewares()` にミドルウェアを渡さない場合、元のハンドラがそのまま返される。ラッパー関数が不要に生成されず、パフォーマンスペナルティがない。

```typescript
// packages/client/test/client/middleware.test.ts:626-633
it('should compose no middleware correctly', () => {
    const response = new Response('success', { status: 200 });
    mockFetch.mockResolvedValue(response);
    const composedFetch = applyMiddlewares()(mockFetch);
    expect(composedFetch).toBe(mockFetch); // 同一参照
});
```

- **セキュリティデフォルトの自動適用と明示的警告**: localhost バインド時は DNS リバインディング防御を自動有効化し、ワイルドカードバインド (`0.0.0.0`) 時は `console.warn` で明示的に警告する。安全性と柔軟性のバランスが取れている。

```typescript
// packages/middleware/express/src/express.ts:60-76
if (allowedHosts) {
    app.use(hostHeaderValidation(allowedHosts));
} else {
    const localhostHosts = ['127.0.0.1', 'localhost', '::1'];
    if (localhostHosts.includes(host)) {
        app.use(localhostHostValidation());
    } else if (host === '0.0.0.0' || host === '::') {
        console.warn(
            `Warning: Server is binding to ${host} without DNS rebinding protection. ...`
        );
    }
}
```

## Anti-Patterns / 注意点

- **アダプター層にドメインロジックを入れる**: フレームワークアダプター内にバリデーションロジックや変換ルールを直接書くと、フレームワーク数だけ同じロジックが重複する。MCP SDK ではこれを避けるため、`validateHostHeader()` をコアに一元化し、アダプターはラッピングのみにしている。

```typescript
// Bad: 各アダプターにバリデーションロジックを直接書く
function expressHostValidation(allowedHostnames: string[]) {
    return (req, res, next) => {
        const hostname = new URL(`http://${req.headers.host}`).hostname;
        if (!allowedHostnames.includes(hostname)) {
            res.status(403).json({ error: 'Invalid host' });
            return;
        }
        next();
    };
}

// Better: コアロジックを呼び出し、アダプター層は変換のみ
function expressHostValidation(allowedHostnames: string[]) {
    return (req, res, next) => {
        const result = validateHostHeader(req.headers.host, allowedHostnames);
        if (!result.ok) {
            res.status(403).json({ jsonrpc: '2.0', error: { code: -32_000, message: result.message }, id: null });
            return;
        }
        next();
    };
}
```

- **ミドルウェア型に独自コンテキストオブジェクトを導入する**: 独自の `MiddlewareContext` 型を定義すると、既存のエコシステム (fetch polyfill、テスト用 mock) と互換性がなくなる。MCP SDK は Web Standard の `FetchLike` をそのまま使い、この問題を回避している。

```typescript
// Bad: 独自コンテキスト型
type CustomMiddleware = (ctx: { req: CustomRequest; res: CustomResponse; next: () => void }) => void;

// Better: プラットフォーム標準型を合成単位にする
type Middleware = (next: FetchLike) => FetchLike;
```

## 導出ルール

- `[MUST]` ミドルウェアの合成単位はプラットフォーム標準のインターフェースにする (fetch シグネチャ、HTTP Request/Response 等)
  - 根拠: MCP SDK は `FetchLike` (Web Standard fetch 互換) をミドルウェア型に採用し、任意の fetch 実装やテスト mock との互換性を実現している (`packages/core/src/shared/transport.ts:3`, `packages/client/src/client/middleware.ts:10`)

- `[MUST]` フレームワークアダプター層にドメインロジックを入れない。アダプターは型変換とデフォルト設定のみを担う
  - 根拠: DNS リバインディング防御の検証ロジック `validateHostHeader()` はコアパッケージに一元化され、Express/Hono アダプターはフレームワーク固有のレスポンス形式にラップするだけである (`packages/server/src/server/middleware/hostHeaderValidation.ts:17`)

- `[SHOULD]` パイプライン合成関数には空のパイプラインに対するアイデンティティ (恒等射) を保証する
  - 根拠: `applyMiddlewares()` に引数がない場合、元のハンドラの参照がそのまま返される。テストで `expect(composedFetch).toBe(mockFetch)` と同一性が検証されている (`packages/client/test/client/middleware.test.ts:633`)

- `[SHOULD]` ライブラリがグローバルオブジェクトを汚染する可能性がある場合、明示的にオプトアウトする設定を入れる
  - 根拠: `@hono/node-server` の `getRequestListener` に `overrideGlobalObjects: false` を渡し、Next.js の `Response` クラスが上書きされることを防いでいる (`packages/middleware/node/src/streamableHttp.ts:89`)

- `[SHOULD]` セキュリティミドルウェアは安全側にデフォルトを倒し、危険な設定には明示的警告を出す
  - 根拠: localhost バインド時は DNS リバインディング防御が自動有効化され、`0.0.0.0` バインド時には `console.warn` で警告が出る (`packages/middleware/express/src/express.ts:67-75`)

- `[SHOULD]` 高階関数のネストが深いミドルウェア型には、フラット化ヘルパーを提供する
  - 根拠: `createMiddleware()` が `next => (input, init) => ...` の二重カリー化を `(next, input, init) => ...` にフラット化し、利用者の認知負荷を下げている (`packages/client/src/client/middleware.ts:317-318`)

- `[AVOID]` ミドルウェアの合成順序に暗黙の優先順位や自動ソートを導入する
  - 根拠: `applyMiddlewares` は引数の順序をそのまま合成順序とし、暗黙の依存解決を行わない。これにより挙動の予測可能性を確保している (`packages/client/src/client/middleware.ts:249-257`)

## 適用チェックリスト

- [ ] ミドルウェアの型定義がプラットフォーム標準のインターフェース (fetch, Request/Response 等) に基づいているか確認する
- [ ] フレームワークアダプター層にドメインロジックが混入していないか確認する。バリデーションや変換ルールがコアに一元化されているかレビューする
- [ ] ミドルウェアパイプラインの合成関数が空の入力に対して安全に動作するか (アイデンティティを返すか) テストする
- [ ] セキュリティ関連のミドルウェアがデフォルトで有効になっているか確認する。無効化する場合に明示的な操作が必要になっているか検証する
- [ ] サードパーティライブラリがグローバルオブジェクトを変更する箇所がないか調査し、必要に応じてオプトアウト設定を追加する
- [ ] 高階関数が深くネストしている場合、`createMiddleware` のようなフラット化ヘルパーの導入を検討する
