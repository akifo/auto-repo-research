# Adapter Pattern

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono は Web Standards（Request/Response）をコアインターフェースとし、9 種のランタイムアダプターで各プラットフォーム固有の形式との変換を担う。`app.fetch()` という単一のエントリーポイントを中心に据え、アダプターが「ランタイム固有イベント → 標準 Request」「標準 Response → ランタイム固有レスポンス」の双方向変換を行う設計は、マルチランタイム対応フレームワークの模範的なアーキテクチャである。さらに serve-static や conninfo といったランタイム依存機能も、共通インターフェース + アダプター実装というパターンで統一的に抽象化している。

## 設計・実装の詳細

### コアのエントリーポイント: `app.fetch()`

Hono のコアは `fetch(request: Request, Env?, ExecutionContext?) => Response | Promise<Response>` というシグネチャを持つ。これは Web Standards の `fetch` API と同じ形式であり、Cloudflare Workers や Deno など Web Standards ネイティブなランタイムではアダプターなしでそのまま動作する。

```typescript
// src/hono-base.ts:473-479
fetch: (
  request: Request,
  Env?: E['Bindings'] | {},
  executionCtx?: ExecutionContext
) => Response | Promise<Response> = (request, ...rest) => {
  return this.#dispatch(request, rest[1], rest[0], request.method)
}
```

`#dispatch` メソッドは Request からパスを抽出し、ルーターでマッチングし、ミドルウェアチェーンを実行して Response を返す。アダプターの存在を一切意識しない純粋なリクエスト処理ロジックである。

### アダプターの責務: `handle()` 関数

各アダプターは `handle(app)` 関数をエクスポートし、ランタイム固有のハンドラを返す。この関数の責務は以下の 3 点に集約される:

1. **ランタイム固有イベント → 標準 Request への変換**
2. **`app.fetch()` の呼び出し**（環境変数の受け渡しを含む）
3. **標準 Response → ランタイム固有レスポンスへの変換**（必要な場合）

アダプターの複雑さはランタイムによって大きく異なる。

**最もシンプル: Vercel アダプター（9行）**

```typescript
// src/adapter/vercel/handler.ts:4-8
export const handle =
  (app: Hono<any, any, any>) =>
  (req: Request): Response | Promise<Response> => {
    return app.fetch(req)
  }
```

Vercel はリクエストが既に標準 Request であるため、変換が不要。`app.fetch()` をそのまま呼ぶだけのパススルーとなる。

**中程度: Cloudflare Pages アダプター**

```typescript
// src/adapter/cloudflare-pages/handler.ts:32-46
export const handle =
  <E extends Env = Env, S extends Schema = BlankSchema, BasePath extends string = '/'>(
    app: Hono<E, S, BasePath>
  ): PagesFunction<E['Bindings']> =>
  (eventContext) => {
    return app.fetch(
      eventContext.request,
      { ...eventContext.env, eventContext },
      {
        waitUntil: eventContext.waitUntil,
        passThroughOnException: eventContext.passThroughOnException,
        props: {},
      }
    )
  }
```

Pages の `EventContext` から Request を取り出し、環境変数と ExecutionContext 相当のオブジェクトを渡す。レスポンス変換は不要。

**最も複雑: AWS Lambda アダプター（680行）**

AWS Lambda は API Gateway v1/v2、ALB、VPC Lattice の 4 種類のイベント形式をサポートする必要があり、各形式ごとに Request 構築とレスポンス変換のロジックが異なる。

### Template Method パターンによるイベント処理の抽象化

AWS Lambda アダプターでは、`EventProcessor` 抽象クラスを用いた Template Method パターンでイベント形式の差異を吸収している。

```typescript
// src/adapter/aws-lambda/handler.ts:268-328
export abstract class EventProcessor<E extends LambdaEvent> {
  protected abstract getPath(event: E): string
  protected abstract getMethod(event: E): string
  protected abstract getQueryString(event: E): string
  protected abstract getHeaders(event: E): Headers
  protected abstract getCookies(event: E, headers: Headers): void
  protected abstract setCookiesToResult(result: APIGatewayProxyResult, cookies: string[]): void

  createRequest(event: E): Request {
    const queryString = this.getQueryString(event)
    const domainName = this.getDomainName(event)
    const path = this.getPath(event)
    const urlPath = `https://${domainName}${path}`
    const url = queryString ? `${urlPath}?${queryString}` : urlPath
    const headers = this.getHeaders(event)
    const method = this.getMethod(event)
    const requestInit: RequestInit = { headers, method }
    if (event.body) {
      requestInit.body = event.isBase64Encoded ? decodeBase64(event.body) : event.body
    }
    return new Request(url, requestInit)
  }

  async createResult(event: E, res: Response, options: ...): Promise<APIGatewayProxyResult> {
    // Response → Lambda 固有形式への変換
  }
}
```

4 つの具象クラス（`EventV1Processor`, `EventV2Processor`, `ALBProcessor`, `LatticeV2Processor`）が `getPath`, `getMethod` 等をオーバーライドし、`getProcessor()` ファクトリ関数がイベントの形状からプロセッサを自動選択する:

```typescript
// src/adapter/aws-lambda/handler.ts:631-643
export const getProcessor = (event: LambdaEvent): EventProcessor<LambdaEvent> => {
  if (isProxyEventALB(event)) {
    return albProcessor
  }
  if (isProxyEventV2(event)) {
    return v2Processor
  }
  if (isLatticeEventV2(event)) {
    return latticeV2Processor
  }
  return v1Processor
}
```

### Strategy パターンによる serve-static の抽象化

serve-static ミドルウェアは、ファイルシステムアクセスというランタイム固有の操作を `getContent` コールバックで抽象化している。

**コア（ランタイム非依存）:**

```typescript
// src/middleware/serve-static/index.ts:34-47
export const serveStatic = <E extends Env = Env>(
  options: ServeStaticOptions<E> & {
    getContent: (path: string, c: Context<E>) => Promise<Data | Response | null>
    join?: (...paths: string[]) => string
    isDir?: (path: string) => boolean | undefined | Promise<boolean | undefined>
  }
): MiddlewareHandler => {
```

コアは `getContent`, `join`, `isDir` を受け取り、ファイル探索・MIME 判定・圧縮ファイル検出などの共通ロジックを実装する。

**Bun アダプター:**

```typescript
// src/adapter/bun/serve-static.ts:8-32
export const serveStatic = <E extends Env = Env>(
  options: ServeStaticOptions<E>
): MiddlewareHandler => {
  return async function serveStatic(c, next) {
    const getContent = async (path: string) => {
      const file = Bun.file(path)
      return (await file.exists()) ? file : null
    }
    const isDir = async (path: string) => { /* node:fs/promises の stat を使用 */ }
    return baseServeStatic({ ...options, getContent, join, isDir })(c, next)
  }
}
```

**Deno アダプター:**

```typescript
// src/adapter/deno/serve-static.ts:8-42
export const serveStatic = <E extends Env = Env>(
  options: ServeStaticOptions<E>
): MiddlewareHandler => {
  return async function serveStatic(c, next) {
    const getContent = async (path: string) => {
      const file = await Deno.open(path)
      return file.readable
    }
    const isDir = (path: string) => { /* Deno.lstatSync を使用 */ }
    return baseServeStatic({ ...options, getContent, join, isDir })(c, next)
  }
}
```

**Cloudflare Workers アダプター:**

```typescript
// src/adapter/cloudflare-workers/serve-static.ts:21-42
export const serveStatic = <E extends Env = Env>(
  options: ServeStaticOptions<E>
): MiddlewareHandler => {
  return async function serveStatic(c, next) {
    const getContent = async (path: string) => {
      return getContentFromKVAsset(path, {
        manifest: options.manifest,
        namespace: options.namespace ?? c.env?.__STATIC_CONTENT,
      })
    }
    return baseServeStatic({ ...options, getContent })(c, next)
  }
}
```

Workers はファイルシステムがないため、KV ストアからアセットを取得する。`join` や `isDir` は不要で `getContent` のみを実装する。Cloudflare Pages はさらにシンプルで、`env.ASSETS.fetch()` を直接呼ぶだけである（`src/adapter/cloudflare-pages/handler.ts:114-123`）。

### 共通インターフェースによる conninfo の統一

接続情報取得も `GetConnInfo` 型で統一し、アダプターごとに実装を変えている:

```typescript
// src/helper/conninfo/types.ts:45
export type GetConnInfo = (c: Context) => ConnInfo
```

| アダプター | IP 取得元 | ファイル |
|---|---|---|
| Bun | `server.requestIP(req)` | `src/adapter/bun/conninfo.ts` |
| Cloudflare Workers | `cf-connecting-ip` ヘッダー | `src/adapter/cloudflare-workers/conninfo.ts` |
| Deno | `c.env.remoteAddr` | `src/adapter/deno/conninfo.ts` |
| Lambda@Edge | `event.Records[0].cf.request.clientIp` | `src/adapter/lambda-edge/conninfo.ts` |
| Vercel | `x-real-ip` ヘッダー | `src/adapter/vercel/conninfo.ts` |

全アダプターが同じ `ConnInfo` 型を返すため、アプリケーションコードはランタイムを意識せず接続情報を参照できる。

### ランタイム検出ユーティリティ

`helper/adapter` モジュールは `getRuntimeKey()` 関数でランタイムを自動検出する:

```typescript
// src/helper/adapter/index.ts:50-84
export const getRuntimeKey = (): Runtime => {
  const global = globalThis as any
  const userAgentSupported =
    typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
  if (userAgentSupported) {
    for (const [runtimeKey, userAgent] of Object.entries(knownUserAgents)) {
      if (checkUserAgentEquals(userAgent)) {
        return runtimeKey as Runtime
      }
    }
  }
  if (typeof global?.EdgeRuntime === 'string') { return 'edge-light' }
  if (global?.fastly !== undefined) { return 'fastly' }
  if (global?.process?.release?.name === 'node') { return 'node' }
  return 'other'
}
```

`navigator.userAgent` を優先的にチェックし、フォールバックでグローバルオブジェクトの存在確認を行う。これにより `env()` ヘルパーがランタイムに応じた環境変数取得を自動切替する。

## コード例

### Service Worker アダプターの fire パターン

Service Worker 環境ではグローバルな `fetch` イベントリスナーを登録する必要がある。`fire()` がこれをラップする:

```typescript
// src/adapter/service-worker/index.ts:28-36
const fire = <E extends Env, S extends Schema, BasePath extends string>(
  app: Hono<E, S, BasePath>,
  options: HandleOptions = { fetch: undefined }
): void => {
  addEventListener('fetch', handle(app, options))
}
```

`handle()` は `FetchEvent` から Request を取り出し、404 時に元の `fetch` にフォールバックするオプションも提供する:

```typescript
// src/adapter/service-worker/handler.ts:18-37
export const handle = <E extends Env, S extends Schema, BasePath extends string>(
  app: Hono<E, S, BasePath>,
  opts: HandleOptions = { fetch: globalThis.fetch.bind(globalThis) }
): Handler => {
  return (evt) => {
    evt.respondWith(
      (async () => {
        const res = await app.fetch(evt.request, {}, evt)
        if (opts.fetch && res.status === 404) {
          return await opts.fetch(evt.request)
        }
        return res
      })()
    )
  }
}
```

### AWS Lambda ストリーミングレスポンス

Lambda の Response Streaming API への対応として `streamHandle` が提供される:

```typescript
// src/adapter/aws-lambda/handler.ts:138-193
export const streamHandle = <E extends Env = Env, ...>(
  app: Hono<E, S, BasePath>
): Handler => {
  return awslambda.streamifyResponse(
    async (event, responseStream, context) => {
      const processor = getProcessor(event)
      const req = processor.createRequest(event)
      const res = await app.fetch(req, { event, requestContext, context })
      // ... ヘッダー抽出 ...
      responseStream = awslambda.HttpResponseStream.from(responseStream, httpResponseMetadata)
      if (res.body) {
        await streamToNodeStream(res.body.getReader(), responseStream)
      }
    }
  )
}
```

通常の `handle` と同じ Request 変換ロジックを共有しつつ、レスポンスのみストリーミング対応の別パスを通す設計。

## Good Patterns

- **Web Standards を境界面とする設計**: `app.fetch()` の引数と戻り値が標準 Request/Response であるため、アダプターは「外部形式 ↔ Web Standards」の変換だけに集中できる。コアロジックとアダプターの関心が完全に分離されており、新しいランタイムの追加が容易。Vercel アダプターが 9 行で済むのはこの設計の証左。

```typescript
// src/adapter/vercel/handler.ts:4-8 — 理想的なアダプターの姿
export const handle =
  (app: Hono<any, any, any>) =>
  (req: Request): Response | Promise<Response> => {
    return app.fetch(req)
  }
```

- **Template Method による同一ドメイン内の変種吸収**: AWS Lambda の `EventProcessor` 抽象クラスは、API Gateway v1/v2/ALB/Lattice という 4 つの入力形式を、`getPath`, `getMethod` 等の抽象メソッドで差分のみ定義させることで、`createRequest` / `createResult` の共通ロジックの重複を排除している。

```typescript
// src/adapter/aws-lambda/handler.ts:268-279 — 共通フローを固定し、差分だけを抽象化
export abstract class EventProcessor<E extends LambdaEvent> {
  protected abstract getPath(event: E): string
  protected abstract getMethod(event: E): string
  protected abstract getQueryString(event: E): string
  protected abstract getHeaders(event: E): Headers
  // createRequest() は共通実装
}
```

- **コールバック注入による serve-static の抽象化**: ファイルシステムという最もランタイム依存度が高い機能を、`getContent` / `isDir` / `join` の 3 つのコールバックで抽象化し、共通のファイル探索・圧縮・MIME 判定ロジックをコアに集約。各アダプターは自ランタイムのファイルアクセス API をコールバックに渡すだけでよい。

- **型レベルのインターフェース統一**: `GetConnInfo = (c: Context) => ConnInfo` という関数型を全アダプターが実装することで、アプリケーションコードはランタイムを意識せず接続情報を取得できる。import パスを変えるだけでランタイムが切り替わる。

## Anti-Patterns / 注意点

- **イベント形状による動的ディスパッチの脆弱性**: `getProcessor()` はイベントオブジェクトのプロパティ存在チェック（`hasOwn(event.requestContext, 'elb')`, `hasOwn(event, 'rawPath')`）でプロセッサを決定する。このランタイム型判別は、AWS 側のイベント形式変更やプロパティ追加で誤判定するリスクがある。

```typescript
// Bad: プロパティの存在だけで型を判別
const isProxyEventV2 = (event: LambdaEvent): event is APIGatewayProxyEventV2 => {
  return Object.hasOwn(event, 'rawPath')
}

// Better: version フィールドなど明示的な判別子を使う
const isProxyEventV2 = (event: LambdaEvent): event is APIGatewayProxyEventV2 => {
  return 'version' in event && event.version === '2.0'
}
```

- **conninfo の一貫性のなさ**: 同じ `GetConnInfo` 型を返すが、取得できる情報量がアダプターによって大きく異なる。Bun は `address`, `addressType`, `port` を返すのに対し、Cloudflare Workers や Vercel はヘッダー由来の `address` のみ。利用者はランタイムごとの差異を認識する必要がある。ドキュメントやランタイム型でこの差異を明示すべき。

```typescript
// Bun: 豊富な情報
{ remote: { address: '127.0.0.1', addressType: 'IPv4', port: 54321 } }

// Vercel: address のみ（ヘッダー由来で信頼性も異なる）
{ remote: { address: '203.0.113.1' } }
```

- **アダプター間でのエラーハンドリングの非統一**: Service Worker アダプターは 404 時のフォールバック `fetch` を提供するが、他のアダプターにはこの仕組みがない。Lambda の `streamHandle` は catch ブロックで `'Internal Server Error'` 文字列を返すが、通常の `handle` にはそのようなフォールバックがない。アダプター横断での一貫したエラー戦略が欠けている。

## 自分のプロジェクトへの適用

- [ ] マルチランタイム対応フレームワークを設計する場合、コアインターフェースを Web Standards（Request/Response）に固定し、ランタイム固有の変換をアダプター層に分離する
- [ ] 同一ドメイン内に複数の入力形式が存在する場合（例: API Gateway v1/v2）、Template Method パターンで差分のみを定義する抽象クラスを検討する
- [ ] ランタイム依存のファイルシステムアクセスは、コールバック注入（Strategy パターン）で抽象化し、共通ロジックをコアに集約する
- [ ] 型レベルの共通インターフェース（`GetConnInfo` のような関数型）を定義して、アダプター実装者に統一的な API を強制する
- [ ] アダプターの複雑さがランタイム仕様に比例することを受け入れ、シンプルなアダプターを理想形として、複雑なアダプターには内部パターン（Template Method 等）を適用する
