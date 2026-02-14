# Helper Utilities

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono の `src/helper/` ディレクトリには 14 個の独立したヘルパーモジュールが格納されている。これらはコアフレームワーク（Context, Router）から分離されたオプショナルな機能群であり、`hono/cookie` や `hono/streaming` のようにトップレベルパスで個別インポートできる設計になっている。注目すべきは、各ヘルパーが Web 標準 API を薄くラップする一貫した設計哲学を持ち、ランタイム非依存性を維持しながらも実用的な抽象化を提供している点である。

## 設計・実装の詳細

### モジュール分離とエクスポート戦略

14 個のヘルパーはすべて `package.json` の `exports` フィールドでトップレベルエントリポイントとして公開されている。`hono/helper/cookie` ではなく `hono/cookie` という短いパスでインポートできる。

```jsonc
// package.json:103-107
"./cookie": {
  "types": "./dist/types/helper/cookie/index.d.ts",
  "import": "./dist/helper/cookie/index.js",
  "require": "./dist/cjs/helper/cookie/index.js"
}
```

各ヘルパーの `index.ts` は薄い re-export 層として機能し、内部実装を隠蔽する。実装が 1 ファイルに収まるものは直接 export し、複雑なものは複数ファイルに分割する。

```typescript
// src/helper/accepts/index.ts:6
export { accepts } from './accepts'

// src/helper/streaming/index.ts:7-9 （複数モジュール）
export { stream } from './stream'
export { streamSSE, SSEStreamingApi } from './sse'
export { streamText } from './text'
```

### Context 依存パターン: 関数型 vs ミドルウェア型

ヘルパーの API は大きく 2 つのパターンに分かれる。

**関数型**: Context を第一引数に受け取り、値を返す。副作用なしで使いやすい。

```typescript
// src/helper/accepts/accepts.ts:40-49
export const accepts = (c: Context, options: acceptsOptions): string => {
  const acceptHeader = c.req.header(options.header)
  if (!acceptHeader) {
    return options.default
  }
  const accepts = parseAccept(acceptHeader)
  const match = options.match || defaultMatch
  return match(accepts, options)
}
```

**ミドルウェア型**: `MiddlewareHandler` を返す高階関数。ルーティングチェーンに組み込んで使う。

```typescript
// src/helper/ssg/middleware.ts:43-49
export const ssgParams: SSGParamsMiddleware = (params) => async (c, next) => {
  if (isDynamicRoute(c.req.path)) {
    ;(c.req.raw as AddedSSGDataRequest).ssgParams = Array.isArray(params) ? params : await params(c)
    return c.notFound()
  }
  await next()
}
```

### ランタイム検出と環境変数の統一アクセス

`adapter` ヘルパーは、マルチランタイム対応の核となる部分で、`navigator.userAgent` と各種グローバルオブジェクトを段階的に検査する戦略を取る。

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

  if (typeof global?.EdgeRuntime === 'string') {
    return 'edge-light'
  }
  if (global?.fastly !== undefined) {
    return 'fastly'
  }
  if (global?.process?.release?.name === 'node') {
    return 'node'
  }
  return 'other'
}
```

`env()` 関数はランタイムごとの環境変数取得方法の差異を吸収する。ハンドラマップによるディスパッチでランタイムごとの取得ロジックを分離している。

```typescript
// src/helper/adapter/index.ts:25-38
const runtimeEnvHandlers: Record<string, () => T> = {
  bun: () => globalEnv,
  node: () => globalEnv,
  'edge-light': () => globalEnv,
  deno: () => {
    // @ts-ignore
    return Deno.env.toObject() as T
  },
  workerd: () => c.env,
  fastly: () => ({}) as T,
  other: () => ({}) as T,
}
```

### ストリーミング抽象化の階層設計

streaming ヘルパーは 3 層に分かれている: `stream` (汎用) > `streamText` (テキスト) > `streamSSE` (Server-Sent Events)。上位の関数が下位を再利用する階層構造。

```typescript
// src/helper/streaming/text.ts:6-15
export const streamText = (
  c: Context,
  cb: (stream: StreamingApi) => Promise<void>,
  onError?: (e: Error, stream: StreamingApi) => Promise<void>
): Response => {
  c.header('Content-Type', TEXT_PLAIN)
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Transfer-Encoding', 'chunked')
  return stream(c, cb, onError)
}
```

SSE は独自の `SSEStreamingApi` クラスで `writeSSE()` メソッドを追加し、SSE プロトコルのフォーマットを自動処理する。

```typescript
// src/helper/streaming/sse.ts:18-38
async writeSSE(message: SSEMessage) {
  const data = await resolveCallback(message.data, HtmlEscapedCallbackPhase.Stringify, false, {})
  const dataLines = (data as string)
    .split(/\r\n|\r|\n/)
    .map((line) => { return `data: ${line}` })
    .join('\n')

  const sseData =
    [
      message.event && `event: ${message.event}`,
      dataLines,
      message.id && `id: ${message.id}`,
      message.retry && `retry: ${message.retry}`,
    ]
      .filter(Boolean)
      .join('\n') + '\n\n'

  await this.write(sseData)
}
```

Bun の古いバージョンへの互換対応として、`isOldBunVersion()` による分岐と `contextStash` による WeakMap によるメモリリーク防止が実装されている。

```typescript
// src/helper/streaming/utils.ts:1-11
export let isOldBunVersion = (): boolean => {
  const version: string = typeof Bun !== 'undefined' ? Bun.version : undefined
  if (version === undefined) {
    return false
  }
  const result = version.startsWith('1.1') || version.startsWith('1.0') || version.startsWith('0.')
  // Avoid running this check on every call
  isOldBunVersion = () => result
  return result
}
```

ここでは関数自身を結果で上書きする「自己メモ化」テクニックが使われている。初回呼び出しで判定結果を確定し、以降の呼び出しではチェックをスキップする。

### Proxy ヘルパーの RFC 準拠設計

proxy ヘルパーは RFC 2616 / RFC 9110 に基づいた hop-by-hop ヘッダの除去と、セキュリティを考慮した Connection ヘッダ処理を実装している。

```typescript
// src/helper/proxy/index.ts:10-18
const hopByHopHeaders = [
  'connection', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade',
]
```

`strictConnectionProcessing` オプションでトラステッド環境とアントラステッド環境の使い分けを可能にしている。デフォルトは `false`（安全側）で、Connection ヘッダによる Hop-by-Hop Header Injection 攻撃を防止する。

### Factory パターンによる型安全なミドルウェア作成

`createFactory` / `createMiddleware` は、TypeScript の型推論を最大限活用するためのヘルパーである。`createMiddleware` は実質的に identity 関数だが、型パラメータの伝播を可能にする。

```typescript
// src/helper/factory/index.ts:368-375
export const createMiddleware = <
  E extends Env = any,
  P extends string = string,
  I extends Input = {},
  R extends HandlerResponse<any> | void = void,
>(
  middleware: MiddlewareHandler<E, P, I, R extends void ? Response : R>
): MiddlewareHandler<E, P, I, R extends void ? Response : R> => middleware
```

`Factory` クラスは `initApp` コールバックで共通のミドルウェアセットアップを DRY に保つ。

```typescript
// src/helper/factory/index.ts:332-351
export class Factory<E extends Env = Env, P extends string = string> {
  private initApp?: InitApp<E>
  #defaultAppOptions?: HonoOptions<E>

  constructor(init?: { initApp?: InitApp<E>; defaultAppOptions?: HonoOptions<E> }) {
    this.initApp = init?.initApp
    this.#defaultAppOptions = init?.defaultAppOptions
  }

  createApp = (options?: HonoOptions<E>): Hono<E> => {
    const app = new Hono<E>(
      options && this.#defaultAppOptions
        ? { ...this.#defaultAppOptions, ...options }
        : (options ?? this.#defaultAppOptions)
    )
    if (this.initApp) { this.initApp(app) }
    return app
  }
}
```

### testClient による E2E テストの簡素化

testing ヘルパーは `hc` (Hono Client) をラップし、`app.request()` をフェッチ関数として注入することで、ネットワーク不要のテストを実現する。

```typescript
// src/helper/testing/index.ts:16-27
export const testClient = <T extends Hono<any, Schema, string>>(
  app: T,
  Env?: ExtractEnv<T>['Bindings'] | {},
  executionCtx?: ExecutionContext,
  options?: Omit<ClientRequestOptions, 'fetch'>
): UnionToIntersection<Client<T, 'http://localhost'>> => {
  const customFetch = (input: RequestInfo | URL, init?: RequestInit) => {
    return app.request(input, init, Env, executionCtx)
  }
  return hc<typeof app, 'http://localhost'>('http://localhost', { ...options, fetch: customFetch })
}
```

## コード例

```typescript
// src/helper/html/index.ts:11-57 — Tagged Template Literal による HTML 生成
// 自動エスケープ付きで XSS を防止。Promise も透過的に処理。
export const html = (
  strings: TemplateStringsArray,
  ...values: unknown[]
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const buffer: StringBufferWithCallbacks = [''] as StringBufferWithCallbacks
  for (let i = 0, len = strings.length - 1; i < len; i++) {
    buffer[0] += strings[i]
    const children = Array.isArray(values[i])
      ? (values[i] as Array<unknown>).flat(Infinity)
      : [values[i]]
    for (let i = 0, len = children.length; i < len; i++) {
      const child = children[i] as any
      if (typeof child === 'string') {
        escapeToBuffer(child, buffer)
      } else if (typeof child === 'number') {
        ;(buffer[0] as string) += child
      } else if (typeof child === 'boolean' || child === null || child === undefined) {
        continue
      }
      // ... Promise, HtmlEscaped の処理が続く
    }
  }
  buffer[0] += strings.at(-1) as string
  return buffer.length === 1 ? raw(buffer[0]) : stringBufferToString(buffer, buffer.callbacks)
}
```

```typescript
// src/helper/cookie/index.ts:78-97 — Cookie Prefix の自動処理
// __Secure- / __Host- プレフィックスのセキュリティ要件を自動適用
export const generateCookie = (name: string, value: string, opt?: CookieOptions): string => {
  let cookie
  if (opt?.prefix === 'secure') {
    cookie = serialize('__Secure-' + name, value, { path: '/', ...opt, secure: true })
  } else if (opt?.prefix === 'host') {
    cookie = serialize('__Host-' + name, value, {
      ...opt, path: '/', secure: true, domain: undefined,
    })
  } else {
    cookie = serialize(name, value, { path: '/', ...opt })
  }
  return cookie
}
```

## Good Patterns

- **Identity Function for Type Inference**: `createMiddleware` は `middleware => middleware` という identity 関数だが、ジェネリクスにより Env 型・Input 型を伝播させる。ランタイムコストゼロで型安全性を実現する優れたパターン。

```typescript
// src/helper/factory/index.ts:368-375
export const createMiddleware = <E extends Env = any, P extends string = string, I extends Input = {}>(
  middleware: MiddlewareHandler<E, P, I, ...>
): MiddlewareHandler<E, P, I, ...> => middleware
```

- **Self-Memoizing Function**: `isOldBunVersion()` は初回実行後に自分自身を結果の定数関数で上書きする。チェックロジックが 1 回だけ走り、以降はゼロコスト。`let` で宣言している点がポイント。

```typescript
// src/helper/streaming/utils.ts:1-11
export let isOldBunVersion = (): boolean => {
  // ... 判定ロジック
  isOldBunVersion = () => result  // 自己置換
  return result
}
```

- **Secure Defaults with Opt-in Strictness**: proxy ヘルパーの `strictConnectionProcessing` はデフォルト `false` で安全側に倒し、RFC 厳密準拠が必要な場合のみ `true` にする。セキュリティとコンプライアンスのバランスが取れている。

```typescript
// src/helper/proxy/index.ts:42-43
strictConnectionProcessing?: boolean  // @default false
```

- **WeakMap による Context-scoped State**: streaming ヘルパーと CSS ヘルパーで `WeakMap` を使って Context にスコープされた状態を管理。グローバル状態を汚染せず、GC で自動回収される。

```typescript
// src/helper/streaming/stream.ts:5
const contextStash: WeakMap<ReadableStream, Context> = new WeakMap()
// src/helper/css/index.ts:64
const contextMap: WeakMap<object, usedClassNameData> = new WeakMap()
```

- **Layered Streaming Abstraction**: `stream` > `streamText` > `streamSSE` の階層構造。上位は下位に適切なヘッダを追加してデリゲートするだけ。各レイヤーの責務が明確で、利用者は必要な抽象度を選べる。

```typescript
// src/helper/streaming/text.ts:6-15
export const streamText = (c, cb, onError) => {
  c.header('Content-Type', TEXT_PLAIN)
  c.header('Transfer-Encoding', 'chunked')
  return stream(c, cb, onError)  // 下位レイヤーにデリゲート
}
```

## Anti-Patterns / 注意点

- **ランタイムハンドラの網羅性不足**: `env()` 関数のランタイムハンドラマップは `Runtime` 型のすべてのキーを静的にカバーしているが、新しいランタイムが追加された場合にハンドラの追加漏れが起こりうる。

```typescript
// Bad: Record<string, () => T> では型チェックが効かない
const runtimeEnvHandlers: Record<string, () => T> = { ... }

// Better: Record<Runtime, () => T> で網羅性を保証
const runtimeEnvHandlers: Record<Runtime, () => T> = { ... } satisfies Record<Runtime, () => T>
```

- **SSG ヘルパーの過度な複雑さ**: `fetchRoutesContent` はネストされた Generator + Promise の組み合わせで、可読性が低い。`async generator` を使えばフラットに書ける可能性がある。

```typescript
// Bad: Generator<Promise<Generator<Promise<...>>>>
export const fetchRoutesContent = function* (app, ...) {
  for (const route of filterStaticGenerateRoutes(app)) {
    yield new Promise(async (resolveGetInfo) => {
      resolveGetInfo(
        (function* () {
          for (const param of ...) {
            yield new Promise(async (resolveReq) => { ... })
          }
        })()
      )
    })
  }
}

// Better: async generator でフラット化
async function* fetchRoutesContent(app, ...) {
  for (const route of ...) {
    for (const param of ...) {
      yield await fetchSingleRoute(route, param)
    }
  }
}
```

- **Cookie プレフィックス処理の重複**: `getCookie`, `getSignedCookie`, `generateCookie`, `generateSignedCookie` のすべてで `__Secure-` / `__Host-` プレフィックスの処理が重複している。プレフィックス解決を別関数に抽出すべき。

```typescript
// Bad: 4箇所で同じ分岐
if (prefix === 'secure') {
  finalKey = '__Secure-' + key
} else if (prefix === 'host') {
  finalKey = '__Host-' + key
}

// Better: ヘルパー関数で DRY に
const resolvePrefix = (key: string, prefix?: CookiePrefixOptions): string =>
  prefix === 'secure' ? `__Secure-${key}` : prefix === 'host' ? `__Host-${key}` : key
```

## 自分のプロジェクトへの適用

- [ ] **Identity Function パターン**: 型推論を活用するために、identity 関数をミドルウェアやハンドラのファクトリとして導入する。ランタイムコストゼロで型安全性を得る手法は汎用的に使える
- [ ] **Self-Memoizing Function**: 環境依存の判定（ランタイム検出、Feature Detection）で初回のみ実行するチェックには、関数自己置換パターンを適用する
- [ ] **階層的なストリーミング抽象**: API のレスポンス形式（JSON stream, text stream, SSE）に応じたストリーミングヘルパーを階層的に設計する。基盤レイヤーは `TransformStream` をラップし、上位レイヤーはヘッダ設定とプロトコル処理を追加する
- [ ] **WeakMap による Request-scoped State**: グローバル変数を避け、リクエストライフサイクルに紐づく状態管理に WeakMap を活用する。GC フレンドリーでメモリリークを防止できる
- [ ] **package.json exports でのモジュール公開**: ライブラリ開発時に tree-shaking 対応のため、`exports` フィールドでサブパスエクスポートを設定し、利用者が必要なモジュールだけをインポートできるようにする
- [ ] **Secure Defaults パターン**: セキュリティに関わるオプション（CORS, Proxy, Auth）はデフォルトを安全側に設定し、緩和はオプトインにする。proxy ヘルパーの `strictConnectionProcessing` の設計を参考にする
