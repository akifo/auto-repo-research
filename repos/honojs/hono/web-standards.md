# Web Standards

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono は "Web framework built on Web Standards" を標語に掲げるフレームワークであり、Fetch API (Request/Response)、Web Crypto API、Streams API、Service Worker API など、WHATWG/W3C 標準の Web API のみを基盤として構築されている。Node.js 固有の `http` モジュールや `Buffer` に一切依存しないことで、Cloudflare Workers、Deno、Bun、Node.js、Service Worker など異なるランタイム間での完全なポータビリティを実現している。この設計は「ランタイム非依存の Web フレームワーク」という新しいカテゴリを切り拓いた点で注目に値する。

## 設計・実装の詳細

### Fetch API を基盤とするエントリーポイント

Hono の中核は `app.fetch(request, env, executionContext)` シグネチャにある。これは Cloudflare Workers の Module Worker 形式と同一であり、標準の `Request` を受け取り `Response` を返す。

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

テスト用の `.request()` メソッドも内部で `new Request()` を生成し `.fetch()` に委譲する設計で、URL API と Request API を活用している。

```typescript
// src/hono-base.ts:493-511
request = (
  input: RequestInfo | URL,
  requestInit?: RequestInit,
  Env?: E['Bindings'] | {},
  executionCtx?: ExecutionContext
): Response | Promise<Response> => {
  if (input instanceof Request) {
    return this.fetch(requestInit ? new Request(input, requestInit) : input, Env, executionCtx)
  }
  input = input.toString()
  return this.fetch(
    new Request(
      /^https?:\/\//.test(input) ? input : `http://localhost${mergePath('/', input)}`,
      requestInit
    ),
    Env,
    executionCtx
  )
}
```

### HonoRequest: Request ラッパーの設計

`HonoRequest` クラスは標準 `Request` をラップし、パスパラメータ・クエリパラメータ・ヘッダー・ボディの取得に便利なメソッドを提供する。重要なのは、`raw` プロパティで元の `Request` オブジェクトにいつでもアクセスできる点と、ボディの読み取り結果をキャッシュする仕組みである。

```typescript
// src/request.ts:36-51
export class HonoRequest<P extends string = '/', I extends Input['out'] = {}> {
  raw: Request
  // ...
  constructor(request: Request, path: string = '/', matchResult: Result<[unknown, RouterRoute]> = [[]]) {
    this.raw = request
    // ...
  }
```

ボディは `json()`, `text()`, `arrayBuffer()`, `blob()`, `formData()` の各メソッドで読み取れるが、これらはすべて標準 `Request` の同名メソッドに対応し、キャッシュ機構を介して2回目以降の呼び出しに対応する。

```typescript
// src/request.ts:218-237
#cachedBody = (key: keyof Body) => {
  const { bodyCache, raw } = this
  const cachedBody = bodyCache[key]
  if (cachedBody) {
    return cachedBody
  }
  const anyCachedKey = Object.keys(bodyCache)[0]
  if (anyCachedKey) {
    return (bodyCache[anyCachedKey as keyof Body] as Promise<BodyInit>).then((body) => {
      if (anyCachedKey === 'json') {
        body = JSON.stringify(body)
      }
      return new Response(body)[key]()
    })
  }
  return (bodyCache[key] = raw[key]())
}
```

キャッシュ済みのボディから別の形式に変換する際にも `new Response(body)[key]()` という標準 API のみで実現している。

### Context: Response ビルダーとしての設計

`Context` クラスは `c.json()`, `c.text()`, `c.html()`, `c.body()` 等のメソッドで、内部的にすべて `new Response()` を生成する。

```typescript
// src/context.ts:26
export type Data = string | ArrayBuffer | ReadableStream | Uint8Array<ArrayBuffer>
```

レスポンスデータの型定義自体が Web Standards の型（`ArrayBuffer`, `ReadableStream`, `Uint8Array`）で構成されており、`Headers` API を直接使用してヘッダーを操作する。

```typescript
// src/context.ts:505-517
header: SetHeaders = (name, value, options): void => {
  if (this.finalized) {
    this.#res = new Response((this.#res as Response).body, this.#res)
  }
  const headers = this.#res ? this.#res.headers : (this.#preparedHeaders ??= new Headers())
  if (value === undefined) {
    headers.delete(name)
  } else if (options?.append) {
    headers.append(name, value)
  } else {
    headers.set(name, value)
  }
}
```

### Web Crypto API の活用

暗号処理は `crypto.subtle` のみで実装されており、Node.js の `crypto` モジュールは使用していない。

**ハッシュ生成** (`src/utils/crypto.ts:33-58`):

```typescript
// src/utils/crypto.ts:33-57
export const createHash = async (data: Data, algorithm: Algorithm): Promise<string | null> => {
  let sourceBuffer: ArrayBufferView | ArrayBuffer
  if (ArrayBuffer.isView(data) || data instanceof ArrayBuffer) {
    sourceBuffer = data
  } else {
    if (typeof data === 'object') {
      data = JSON.stringify(data)
    }
    sourceBuffer = new TextEncoder().encode(String(data))
  }
  if (crypto && crypto.subtle) {
    const buffer = await crypto.subtle.digest({ name: algorithm.name }, sourceBuffer as ArrayBuffer)
    const hash = Array.prototype.map
      .call(new Uint8Array(buffer), (x) => ('00' + x.toString(16)).slice(-2))
      .join('')
    return hash
  }
  return null
}
```

**Cookie 署名・検証** (`src/utils/cookie.ts:39-66`): `crypto.subtle.importKey`, `crypto.subtle.sign`, `crypto.subtle.verify` を使用。

**JWT 署名・検証** (`src/utils/jwt/jws.ts:29-48`): `crypto.subtle.sign`, `crypto.subtle.verify`, `crypto.subtle.importKey` に加え、PKCS#8, SPKI, JWK 等の鍵フォーマットインポートを Web Crypto API のみで実現。

### Streams API の活用

ストリーミングレスポンスは `TransformStream`, `ReadableStream`, `WritableStream` を使って実装されている。

```typescript
// src/helper/streaming/stream.ts:7-13
export const stream = (
  c: Context,
  cb: (stream: StreamingApi) => Promise<void>,
  onError?: (e: Error, stream: StreamingApi) => Promise<void>
): Response => {
  const { readable, writable } = new TransformStream()
  const stream = new StreamingApi(writable, readable)
```

`StreamingApi` クラスは `WritableStream` のライターと `TextEncoder` を使ってデータを書き込む。

```typescript
// src/utils/stream.ts:6-56
export class StreamingApi {
  private writer: WritableStreamDefaultWriter<Uint8Array>
  private encoder: TextEncoder
  // ...
  async write(input: Uint8Array | string): Promise<StreamingApi> {
    try {
      if (typeof input === 'string') {
        input = this.encoder.encode(input)
      }
      await this.writer.write(input)
    } catch {
      // Do nothing
    }
    return this
  }
```

SSE (Server-Sent Events) も同じ Streams 基盤の上に構築され、`streamSSE` は適切なヘッダーを設定した上で `TransformStream` を使う。

JSX のストリーミングレンダリング (`src/jsx/streaming.ts:142-206`) でも `ReadableStream` を直接構築し、`TextEncoder` でエンコードしてコントローラーに enqueue する。

### Service Worker API との互換

`FetchEventLike` 抽象クラスで Service Worker の `FetchEvent` を抽象化している。

```typescript
// src/types.ts:2484-2488
export abstract class FetchEventLike {
  abstract readonly request: Request
  abstract respondWith(promise: Response | Promise<Response>): void
  abstract passThroughOnException(): void
  abstract waitUntil(promise: Promise<void>): void
}
```

Service Worker アダプターは `evt.respondWith()` と `app.fetch(evt.request)` の橋渡しのみで、50 行未満の薄い実装。

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

### URL パース最適化

`getPath()` (`src/utils/url.ts:106-134`) は `new URL()` を使わず、`request.url` 文字列をインデックス操作で直接パースする。これはパフォーマンス最適化のためで、`%` エンコーディングが含まれない一般的なケースを高速に処理しつつ、エンコーディングが含まれる場合のみ `decodeURI` にフォールバックする。

### クライアント（hc）での Web API 使用

RPC クライアント `hc` は `fetch()`, `new Headers()`, `new FormData()`, `new URLSearchParams()`, `new URL()` を使用して型安全な HTTP クライアントを実装している。

```typescript
// src/client/utils.ts:26-43
export const buildSearchParams = (query: Record<string, string | string[]>) => {
  const searchParams = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) { continue }
    if (Array.isArray(v)) {
      for (const v2 of v) { searchParams.append(k, v2) }
    } else {
      searchParams.set(k, v)
    }
  }
  return searchParams
}
```

## Good Patterns

- **Request ラッパーで raw アクセスを保持**: `HonoRequest` は便利メソッドを追加しつつ `raw` プロパティで標準 `Request` にアクセスできる。ランタイム固有の拡張（例: Cloudflare Workers の `request.cf`）にも対応可能。

```typescript
// src/request.ts:51
raw: Request

// 利用例: Cloudflare Workers の cf プロパティにアクセス
app.post('/', async (c) => {
  const metadata = c.req.raw.cf?.hostMetadata
})
```

- **ボディキャッシュによる再利用**: Request body は一度しか読めない制約があるが、キャッシュ機構と `new Response(body)[key]()` パターンで異なる形式への変換を実現。`cloneRawRequest` も consumed body をキャッシュから復元する。

```typescript
// src/request.ts:458-487
export const cloneRawRequest = async (req: HonoRequest): Promise<Request> => {
  if (!req.raw.bodyUsed) {
    return req.raw.clone()
  }
  const cacheKey = (Object.keys(req.bodyCache) as Array<keyof Body>)[0]
  if (!cacheKey) {
    throw new HTTPException(500, { message: '...' })
  }
  // キャッシュからボディを復元して新しい Request を生成
  return new Request(req.url, { body: await req[cacheKey](), /* ... */ })
}
```

- **crypto.subtle の存在チェック付きフォールバック**: `crypto.subtle` が利用できない環境（古い Node.js 等）を `null` 返却で安全に処理。

```typescript
// src/utils/crypto.ts:45-57
if (crypto && crypto.subtle) {
  const buffer = await crypto.subtle.digest({ name: algorithm.name }, sourceBuffer as ArrayBuffer)
  // ...
  return hash
}
return null
```

- **TransformStream による双方向ストリーム制御**: `stream()` ヘルパーは `TransformStream` の `readable` / `writable` 分離を活用し、書き込み側と読み取り側を独立に制御する。abort 時の ReadableStream cancel も Web Standards に準拠。

```typescript
// src/helper/streaming/stream.ts:12-13
const { readable, writable } = new TransformStream()
const stream = new StreamingApi(writable, readable)
```

- **FormData / Response を活用した型変換**: `bufferToFormData` は `new Response(arrayBuffer, { headers }).formData()` という標準 API だけでバイナリから FormData への変換を実現している。

```typescript
// src/utils/buffer.ts:55-65
export const bufferToFormData = (arrayBuffer: ArrayBuffer, contentType: string): Promise<FormData> => {
  const response = new Response(arrayBuffer, {
    headers: { 'Content-Type': contentType },
  })
  return response.formData()
}
```

## Anti-Patterns / 注意点

- **URL パースの独自実装**: `getPath()` はパフォーマンスのために `new URL()` を避けているが、エッジケース（不正な URL、特殊文字）のハンドリングが複雑になっている。パフォーマンスがクリティカルでない場合は `new URL()` を使うべき。

```typescript
// Bad: 文字コードベースの手動パース（保守性が低い）
const getPath = (request: Request): string => {
  const url = request.url
  const start = url.indexOf('/', url.indexOf(':') + 4)
  let i = start
  for (; i < url.length; i++) {
    const charCode = url.charCodeAt(i)
    if (charCode === 37) { /* ... */ }
    else if (charCode === 63 || charCode === 35) { break }
  }
  return url.slice(start, i)
}

// Better: 一般的なアプリケーションでは標準 URL API を使う
const getPath = (request: Request): string => {
  return new URL(request.url).pathname
}
```

- **`any` 型の散見**: Web Standards の型定義は堅牢だが、フレームワーク内部で `as any` が多用されている箇所がある（特に型推論の限界への対処）。自分のプロジェクトでは型ガードを使って回避すべき。

- **crypto.subtle 未対応時のサイレント失敗**: `createHash` が `null` を返す設計は安全だが、ETag ミドルウェアなど呼び出し側が `null` チェックを忘れるとセキュリティ上の問題になり得る。明示的なエラーを投げるか、ログを出す方が安全な場合がある。

## 自分のプロジェクトへの適用

- [ ] フレームワークのエントリーポイントを `(Request) => Response | Promise<Response>` のシグネチャで設計し、ランタイム非依存にする
- [ ] Request body のキャッシュ機構を実装し、バリデーションと後続処理で body を複数回読めるようにする
- [ ] 暗号処理を `crypto.subtle` ベースに統一し、Node.js の `crypto` モジュールへの依存を排除する
- [ ] ストリーミング処理に `TransformStream` を使い、書き込み側と読み取り側を分離する設計を採用する
- [ ] `new Response(body, { headers }).formData()` パターンのようにWeb API の組み合わせでユーティリティを実装し、外部ライブラリ依存を減らす
- [ ] テストでは `new Request()` / `Response` を直接使い、HTTP サーバーの起動なしでハンドラーをテストする（Hono の `.request()` パターン）
