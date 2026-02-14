# Context Design

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono の `Context` クラスは、HTTP リクエスト/レスポンスの処理を単一オブジェクトに統合する中心的な設計要素である。Express の `req`/`res` 分離モデルとは異なり、1 つの `c` オブジェクトからリクエスト情報の取得・レスポンスの生成・リクエストスコープ変数の管理・ランタイム環境へのアクセスをすべて行える。TypeScript のジェネリクスを活用した 3 層の型パラメータ `<E, P, I>` により、環境バインディング・パスパラメータ・入力データすべてがコンパイル時に型安全に扱えるように設計されている。

## 設計・実装の詳細

### Context クラスの 3 層型パラメータ

Context クラスは 3 つのジェネリクス型パラメータで構成される。

```ts
// src/context.ts:283-289
export class Context<
  E extends Env = any,
  P extends string = any,
  I extends Input = {},
>
```

- **`E extends Env`**: 環境型。`Bindings`（Cloudflare Workers の KV、D1 等のランタイムバインディング）と `Variables`（リクエストスコープ変数）を定義する
- **`P extends string`**: パスパターン文字列。`'/users/:id'` のようなリテラル型からパスパラメータの型を自動推論する
- **`I extends Input`**: バリデーション入力。`in`（入力データ）と `out`（バリデーション済みデータ）を保持する

`Env` 型は以下のように定義され、ユーザーがアプリケーション固有の型を注入するインターフェースを提供する。

```ts
// src/types.ts:31-34
export type Env = {
  Bindings?: Bindings
  Variables?: Variables
}
```

### HonoRequest のラッパー設計と遅延初期化

Context は生の `Request` オブジェクトを保持し、`c.req` アクセス時に初めて `HonoRequest` を生成する遅延初期化パターンを採用している。

```ts
// src/context.ts:290-291
#rawRequest: Request
#req: HonoRequest<P, I['out']> | undefined

// src/context.ts:356-359
get req(): HonoRequest<P, I['out']> {
  this.#req ??= new HonoRequest(this.#rawRequest, this.#path, this.#matchResult)
  return this.#req
}
```

`HonoRequest` は `Request` のラッパーであり、`c.req.param()`, `c.req.query()`, `c.req.header()` など型安全なアクセサを提供する。特に `c.req.param()` はパス文字列のリテラル型からパラメータ名を推論する。

```ts
// src/request.ts:94-99
param<P2 extends ParamKeys<P> = ParamKeys<P>>(key: P2 extends `${infer _}?` ? never : P2): string
param<P2 extends RemoveQuestion<ParamKeys<P>> = RemoveQuestion<ParamKeys<P>>>(
  key: P2
): string | undefined
param(key: string): string | undefined
param<P2 extends string = P>(): Simplify<UnionToIntersection<ParamKeyToRecord<ParamKeys<P2>>>>
```

### リクエストボディのキャッシュ機構

`HonoRequest` はリクエストボディの読み取り結果をキャッシュし、同一リクエスト内で複数回ボディにアクセスしても問題が生じない設計になっている。

```ts
// src/request.ts:69
bodyCache: BodyCache = {}

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

異なるフォーマットでの読み取り（例: 先に `json()` → 後に `text()`）にも対応し、キャッシュ済みのデータから新しい `Response` オブジェクトを経由して変換する。

### レスポンス生成メソッドの設計

Context は Content-Type に応じた便利メソッド群を提供する。

| メソッド | Content-Type | 備考 |
|---|---|---|
| `c.text()` | `text/plain; charset=UTF-8` | ファストパス最適化あり |
| `c.json()` | `application/json` | `JSON.stringify` 内蔵 |
| `c.html()` | `text/html; charset=UTF-8` | `Promise<string>` 対応 |
| `c.body()` | 手動指定 | 低レベル API |
| `c.redirect()` | - | Location ヘッダ自動設定 |

`c.text()` には特筆すべきファストパス最適化が施されている。

```ts
// src/context.ts:672-684
text: TextRespond = (
  text: string,
  arg?: ContentfulStatusCode | ResponseOrInit,
  headers?: HeaderRecord
): ReturnType<TextRespond> => {
  return !this.#preparedHeaders && !this.#status && !arg && !headers && !this.finalized
    ? (new Response(text) as ReturnType<TextRespond>)
    : (this.#newResponse(
        text,
        arg,
        setDefaultContentType(TEXT_PLAIN, headers)
      ) as ReturnType<TextRespond>)
}
```

事前にヘッダやステータスが設定されていなければ、ヘッダマージを完全にスキップして `new Response(text)` を直接返す。これにより、単純なテキストレスポンスのオーバーヘッドを最小化している。

### リクエストスコープ変数（c.set / c.get / c.var）

ミドルウェア間のデータ受け渡しには、`c.set()` / `c.get()` / `c.var` の 3 つの API が用意されている。内部的には `Map` で管理される。

```ts
// src/context.ts:306
#var: Map<unknown, unknown> | undefined

// src/context.ts:536-546
set: Set<...> = (key: string, value: unknown) => {
  this.#var ??= new Map()
  this.#var.set(key, value)
}

// src/context.ts:582-592
get var(): Readonly<...> {
  if (!this.#var) {
    return {} as any
  }
  return Object.fromEntries(this.#var)
}
```

型安全性は `E['Variables']` ジェネリクス と `ContextVariableMap` インターフェースの 2 経路で確保される。

```ts
// src/context.ts:90-93
interface Get<E extends Env> {
  <Key extends keyof E['Variables']>(key: Key): E['Variables'][Key]
  <Key extends keyof ContextVariableMap>(key: Key): ContextVariableMap[Key]
}
```

### ContextVariableMap による declare module 拡張

ミドルウェアが独自の変数を型安全に登録するための仕組みとして、TypeScript の `declare module` による interface マージが活用されている。

```ts
// src/context.ts:52
export interface ContextVariableMap {}

// src/middleware/request-id/index.ts:5-7
declare module '../..' {
  interface ContextVariableMap extends RequestIdVariables {}
}

// src/middleware/jwt/index.ts:7-9
declare module '../..' {
  interface ContextVariableMap extends JwtVariables {}
}
```

これにより、`requestId()` ミドルウェアを使うと `c.get('requestId')` が `string` 型として自動補完される。ユーザーは `Env['Variables']` を明示的に定義しなくても、ミドルウェアの import だけで型情報が伝搬する。

### finalized フラグとミドルウェアチェーン

`c.finalized` はレスポンスが確定済みかを追跡するフラグで、`c.res = res` セッター呼び出し時に `true` になる。

```ts
// src/context.ts:404-424
set res(_res: Response | undefined) {
  if (this.#res && _res) {
    _res = new Response(_res.body, _res)
    for (const [k, v] of this.#res.headers.entries()) {
      if (k === 'content-type') {
        continue
      }
      // set-cookie の特殊処理
      // ...
    }
  }
  this.#res = _res
  this.finalized = true
}
```

`compose()` 関数内で、ハンドラの戻り値が Response であり `finalized === false` の場合にのみ `c.res` を設定する。これにより、先行ミドルウェアで既にレスポンスが確定済みなら上書きされないことが保証される。

```ts
// src/compose.ts:67-69
if (res && (context.finalized === false || isError)) {
  context.res = res
}
```

`#dispatch` メソッドでは、`finalized === false` のまま compose が完了するとエラーを投げる。

```ts
// src/hono-base.ts:449-452
if (!context.finalized) {
  throw new Error(
    'Context is not finalized. Did you forget to return a Response object or `await next()`?'
  )
}
```

### res セッターのヘッダマージ戦略

`c.res` のセッターは既存レスポンスのヘッダを新レスポンスにマージする。ただし以下のルールに従う。

1. `content-type` はマージしない（新レスポンスの Content-Type を優先）
2. `set-cookie` は `getSetCookie()` で個別に取得し、`append` で追加する（複数 Cookie の保持）
3. その他のヘッダは `set` でマージする

```ts
// src/context.ts:405-423
set res(_res: Response | undefined) {
  if (this.#res && _res) {
    _res = new Response(_res.body, _res)
    for (const [k, v] of this.#res.headers.entries()) {
      if (k === 'content-type') {
        continue
      }
      if (k === 'set-cookie') {
        const cookies = this.#res.headers.getSetCookie()
        _res.headers.delete('set-cookie')
        for (const cookie of cookies) {
          _res.headers.append('set-cookie', cookie)
        }
      } else {
        _res.headers.set(k, v)
      }
    }
  }
  this.#res = _res
  this.finalized = true
}
```

### context-storage: AsyncLocalStorage によるコンテキスト共有

`contextStorage()` ミドルウェアは Node.js の `AsyncLocalStorage` を使い、ハンドラ関数の引数 `c` を介さずに任意の場所からコンテキストにアクセス可能にする。

```ts
// src/middleware/context-storage/index.ts:10
const asyncLocalStorage = new AsyncLocalStorage<Context>()

// src/middleware/context-storage/index.ts:43-47
export const contextStorage = (): MiddlewareHandler => {
  return async function contextStorage(c, next) {
    await asyncLocalStorage.run(c, next)
  }
}

// src/middleware/context-storage/index.ts:53-58
export const getContext = <E extends Env = Env>(): Context<E> => {
  const context = tryGetContext<E>()
  if (!context) {
    throw new Error('Context is not available')
  }
  return context
}
```

これにより、ユーティリティ関数やサービス層で `c` を引数に渡さずにリクエストコンテキストを参照できる。

### バリデーション結果との統合

`c.req.valid(target)` メソッドは、`validator()` ミドルウェアでバリデーション済みのデータを型安全に取得する。バリデーションミドルウェアが `addValidatedData()` でデータを蓄積し、ハンドラ内で `valid()` で取り出す。

```ts
// src/validator/validator.ts:168
c.req.addValidatedData(target, res as never)

// src/request.ts:333-335
valid<T extends keyof I & keyof ValidationTargets>(target: T): InputToDataByTarget<I, T>
valid(target: keyof ValidationTargets) {
  return this.#validatedData[target] as unknown
}
```

型の推論は `Input` ジェネリクスの `out` フィールドを通じて、バリデーション関数の戻り値型からハンドラ内の `c.req.valid('json')` の型まで一貫して伝搬する。

### 環境バインディング（c.env）と ExecutionContext

`c.env` はランタイム固有の環境バインディング（Cloudflare Workers の KV, D1, R2 等）にアクセスするプロパティである。`E['Bindings']` 型で型安全に参照できる。

`c.executionCtx` は Cloudflare Workers の `ExecutionContext`（`waitUntil()`, `passThroughOnException()`）を提供する。存在しない環境でアクセスすると即座に Error を throw する設計で、フェイルファストを重視している。

```ts
// src/context.ts:381-387
get executionCtx(): ExecutionContext {
  if (this.#executionCtx) {
    return this.#executionCtx as ExecutionContext
  } else {
    throw Error('This context has no ExecutionContext')
  }
}
```

### 単一ハンドラの最適化

`#dispatch` メソッドでは、マッチ結果がハンドラ 1 つだけの場合に `compose()` を経由せず直接実行するファストパスが存在する。

```ts
// src/hono-base.ts:423-442
if (matchResult[0].length === 1) {
  let res: ReturnType<H>
  try {
    res = matchResult[0][0][0][0](c, async () => {
      c.res = await this.#notFoundHandler(c)
    })
  } catch (err) {
    return this.#handleError(err, c)
  }
  return res instanceof Promise
    ? res
        .then(
          (resolved: Response | undefined) =>
            resolved || (c.finalized ? c.res : this.#notFoundHandler(c))
        )
        .catch((err: Error) => this.#handleError(err, c))
    : (res ?? this.#notFoundHandler(c))
}
```

ミドルウェアのない単純なルートでは `compose()` のオーバーヘッドを回避し、同期的なレスポンス返却も可能にしている。

## コード例

### 型安全な環境定義とコンテキスト利用

```ts
// 使用例（テストコードから抽出）
// src/context.test.ts:308-317
const req = new Request('http://localhost/')
const key = 'a-secret-key'
const ctx = new Context(req, {
  env: {
    API_KEY: key,
  },
})
expect(ctx.env.API_KEY).toBe(key)
```

### ミドルウェアによる変数の設定と取得

```ts
// src/middleware/request-id/request-id.ts:41-59
export const requestId = ({
  limitLength = 255,
  headerName = 'X-Request-Id',
  generator = () => crypto.randomUUID(),
}: RequestIdOptions = {}): MiddlewareHandler => {
  return async function requestId(c, next) {
    let reqId = headerName ? c.req.header(headerName) : undefined
    if (!reqId || reqId.length > limitLength || /[^\w\-=]/.test(reqId)) {
      reqId = generator(c)
    }
    c.set('requestId', reqId)
    if (headerName) {
      c.header(headerName, reqId)
    }
    await next()
  }
}
```

### context-storage による関数外からのコンテキスト参照

```ts
// src/middleware/context-storage/index.test.ts:11-28
const app = new Hono<Env>()

app.use(contextStorage())
app.use(async (c, next) => {
  c.set('message', 'Hono is hot!!')
  await next()
})
app.get('/', (c) => {
  return c.text(getMessage())
})

const getMessage = () => {
  return getContext<Env>().var.message
}
```

## Good Patterns

- **統合コンテキストオブジェクト**: `req`/`res` を分離せず 1 つの `c` に統合することで、ハンドラの引数が 1 つで済み、ミドルウェア間のデータ共有も同一オブジェクト上で完結する。Express の `(req, res, next)` パターンと比較して、認知負荷が低くコード量が減る。

```ts
// Express パターン
app.get('/', (req, res) => {
  res.set('Content-Type', 'text/plain')
  res.status(200).send('Hello')
})

// Hono パターン
app.get('/', (c) => {
  return c.text('Hello')
})
```

- **Private fields による内部状態の保護**: `#rawRequest`, `#req`, `#var`, `#status`, `#res` 等すべて ECMAScript private fields で宣言されている。継承やモンキーパッチによる予期しないアクセスを防ぎ、API の安定性を保証している。

```ts
// src/context.ts:290-291, 306, 325-331
#rawRequest: Request
#req: HonoRequest<P, I['out']> | undefined
#var: Map<unknown, unknown> | undefined
#status: StatusCode | undefined
#res: Response | undefined
#preparedHeaders: Headers | undefined
```

- **declare module による型拡張パターン**: ミドルウェアが `ContextVariableMap` を拡張する `declare module` パターンにより、ライブラリ側のミドルウェアをインポートするだけで型が自動的に伝搬する。ユーザーが手動で `Variables` 型を維持する負担がない。

```ts
// src/middleware/timing/index.ts:6-8
declare module '../..' {
  interface ContextVariableMap extends TimingVariables {}
}
```

- **レスポンス生成のファストパス最適化**: `c.text()` でヘッダ・ステータスの事前設定がない場合に `new Response(text)` を直接返す最適化。エッジコンピューティング環境で重要なレイテンシ削減を実現している。

## Anti-Patterns / 注意点

- **c.var の毎回オブジェクト生成**: `c.var` ゲッターは呼び出すたびに `Object.fromEntries(this.#var)` で新しいオブジェクトを生成する。ループ内で頻繁にアクセスすると不要なオブジェクト生成コストが発生する。

```ts
// Bad: ループ内で c.var を繰り返し参照
for (const item of items) {
  doSomething(c.var.config) // 毎回 Object.fromEntries が実行される
}

// Better: 一度変数に取り出す
const config = c.get('config')
for (const item of items) {
  doSomething(config)
}
```

- **context-storage の環境依存性**: `contextStorage()` は `node:async_hooks` の `AsyncLocalStorage` に依存するため、Cloudflare Workers（nodejs_compat が必要）や Deno 以外のエッジランタイムでは利用できない可能性がある。使用前にランタイム対応を確認する必要がある。

```ts
// Bad: ランタイムを確認せずに context-storage を使用
import { contextStorage } from 'hono/context-storage' // 一部ランタイムで失敗

// Better: ランタイム対応を確認するか、c を引数で渡すフォールバックを検討
```

- **ExecutionContext 未設定時の throw**: `c.executionCtx` は環境が提供しない場合に即座に Error を throw する。テスト環境や非 Workers ランタイムで予期せずクラッシュする可能性がある。

```ts
// Bad: テスト環境で直接 c.executionCtx にアクセス
const ctx = new Context(req)
ctx.executionCtx.waitUntil(promise) // Error: This context has no ExecutionContext

// Better: テスト時は明示的に executionCtx をモックする
const ctx = new Context(req, {
  executionCtx: { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} },
  env: {},
})
```

## 自分のプロジェクトへの適用

- [ ] リクエスト/レスポンスを統合したコンテキストクラスを設計する際、Hono のように Private fields でカプセル化し、ゲッター経由の遅延初期化パターンを採用する
- [ ] ミドルウェアが型安全に変数を登録できるよう、`declare module` による interface マージパターン（`ContextVariableMap` 方式）を検討する
- [ ] レスポンス生成の高頻度パスでは、Hono の `c.text()` のように条件分岐でヘッダマージをスキップするファストパスを導入する
- [ ] バリデーション結果をコンテキストに蓄積し、ハンドラで型安全に取得する `addValidatedData` / `valid()` パターンを自前のフレームワークに組み込む
- [ ] `AsyncLocalStorage` を使ったコンテキスト共有は、サービス層やユーティリティ関数への `c` の引き回しを排除する有効な手段として、ランタイム要件を確認の上で導入を検討する
