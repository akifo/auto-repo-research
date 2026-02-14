# Architecture

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono のアーキテクチャは「Web Standards を基盤とした多層構造のフレームワーク」として設計されている。コアとなる HonoBase クラスが fetch ハンドラ・ルーティング・ミドルウェア合成を統合し、ルーター層を Strategy パターンで差し替え可能にしている点が最大の特徴である。ルーター・ミドルウェア・アダプターの各層が明確に分離されており、エッジランタイムから Node.js まで単一コードベースで動作するマルチランタイム対応を実現している。

## 設計・実装の詳細

### 全体のレイヤー構成

Hono のアーキテクチャは以下の5層で構成される。

```
[Adapter 層]     aws-lambda, cloudflare-workers, bun, deno, vercel ...
      |
[Helper 層]      factory, cookie, streaming, testing, ssg ...
      |
[Middleware 層]   cors, jwt, logger, cache, compress ...
      |
[Router 層]      RegExpRouter, TrieRouter, LinearRouter, PatternRouter, SmartRouter
      |
[Core 層]        HonoBase, Context, HonoRequest, compose
```

各層は上位層が下位層のみに依存する一方向の依存関係を持ち、下位層は上位層を参照しない。この設計により、ルーターだけを差し替える、ミドルウェアを個別に追加する、特定ランタイム向けのアダプターを選択する、といった柔軟な組み合わせが可能になっている。

### Core 層: HonoBase と薄い Hono ラッパー

Core 層の中心は `hono-base.ts` の `HonoBase` クラスである。このクラスは「抽象クラスのように振る舞い、router は持たない」とコメントされており、ルーターの注入はサブクラスの責務として分離されている。

```typescript
// src/hono-base.ts:114-118
class Hono<
  E extends Env = Env,
  S extends Schema = {},
  BasePath extends string = '/',
  CurrentPath extends string = BasePath,
> {
  /*
    This class is like an abstract class and does not have a router.
    To use it, inherit the class and implement router in the constructor.
  */
  router!: Router<[H, RouterRoute]>
```

エントリポイントの `hono.ts` はこの HonoBase を継承し、デフォルトの SmartRouter（RegExpRouter + TrieRouter）を注入するだけの薄いクラスである。

```typescript
// src/hono.ts:16-34
export class Hono<
  E extends Env = BlankEnv,
  S extends Schema = BlankSchema,
  BasePath extends string = '/',
> extends HonoBase<E, S, BasePath> {
  constructor(options: HonoOptions<E> = {}) {
    super(options)
    this.router =
      options.router ??
      new SmartRouter({
        routers: [new RegExpRouter(), new TrieRouter()],
      })
  }
}
```

このパターンにより、`preset/tiny.ts` は PatternRouter のみ、`preset/quick.ts` は LinearRouter + TrieRouter の組み合わせ、といったバリエーションを最小コードで実現している。

### Router 層: Strategy パターンと SmartRouter の自動選択

全てのルーターは共通の `Router<T>` インターフェースを実装する。

```typescript
// src/router.ts:29-52
export interface Router<T> {
  name: string
  add(method: string, path: string, handler: T): void
  match(method: string, path: string): Result<T>
}
```

`add` と `match` の2メソッドだけという極めてシンプルなインターフェースが、5種類のルーター実装を統一的に扱うことを可能にしている。

**SmartRouter** は特筆すべき設計で、複数のルーターを受け取り、最初の `match` 呼び出し時に最適なルーターを自動選択する遅延評価戦略を採用している。

```typescript
// src/router/smart-router/router.ts:21-60
match(method: string, path: string): Result<T> {
  const routers = this.#routers
  const routes = this.#routes

  const len = routers.length
  let i = 0
  let res
  for (; i < len; i++) {
    const router = routers[i]
    try {
      for (let i = 0, len = routes.length; i < len; i++) {
        router.add(...routes[i])
      }
      res = router.match(method, path)
    } catch (e) {
      if (e instanceof UnsupportedPathError) {
        continue
      }
      throw e
    }

    this.match = router.match.bind(router)  // メソッドを置き換え
    this.#routers = [router]
    this.#routes = undefined  // ルート定義を解放
    break
  }
  // ...
}
```

注目すべきは `this.match = router.match.bind(router)` の行で、初回マッチ後に SmartRouter 自体の `match` メソッドを選択されたルーターの `match` に置き換えている。これにより2回目以降の呼び出しでは SmartRouter のオーバーヘッドが完全に消滅する。

**RegExpRouter** も同様のメソッド置き換えパターンを使う。初回 `match` 時にルート定義からトライ木を構築し、それを単一の正規表現にコンパイルした後、`match` メソッドを最適化されたバージョンに差し替える。

```typescript
// src/router/reg-exp-router/matcher.ts:10-33
export function match<R extends Router<T>, T>(this: R, method: string, path: string): Result<T> {
  const matchers: MatcherMap<T> = (this as any).buildAllMatchers()

  const match = ((method, path) => {
    const matcher = (matchers[method] || matchers[METHOD_NAME_ALL]) as Matcher<T>

    const staticMatch = matcher[2][path]
    if (staticMatch) {
      return staticMatch  // 静的パスは O(1) ルックアップ
    }

    const match = path.match(matcher[0])
    if (!match) {
      return [[], emptyParam]
    }

    const index = match.indexOf('', 1)
    return [matcher[1][index], match]
  }) as Router<T>['match']

  this.match = match  // 最適化版に置き換え
  return match(method, path)
}
```

静的パス（パラメータなし）は `StaticMap` による O(1) ルックアップで処理され、動的パスのみ正規表現マッチングが実行される。

### ミドルウェア合成: koa-compose インスパイアの dispatch chain

ミドルウェアの合成は `compose.ts` で行われ、koa-compose にインスパイアされた再帰的 dispatch パターンを採用している。

```typescript
// src/compose.ts:15-73
export const compose = <E extends Env = Env>(
  middleware: [[Function, unknown], unknown][] | [[Function]][],
  onError?: ErrorHandler<E>,
  onNotFound?: NotFoundHandler<E>
): ((context: Context, next?: Next) => Promise<Context>) => {
  return (context, next) => {
    let index = -1

    return dispatch(0)

    async function dispatch(i: number): Promise<Context> {
      if (i <= index) {
        throw new Error('next() called multiple times')
      }
      index = i

      let handler
      if (middleware[i]) {
        handler = middleware[i][0][0]
      } else {
        handler = (i === middleware.length && next) || undefined
      }

      if (handler) {
        try {
          res = await handler(context, () => dispatch(i + 1))
        } catch (err) {
          if (err instanceof Error && onError) {
            context.error = err
            res = await onError(err, context)
            isError = true
          } else {
            throw err
          }
        }
      } else {
        if (context.finalized === false && onNotFound) {
          res = await onNotFound(context)
        }
      }
      // ...
    }
  }
}
```

`i <= index` のチェックにより `next()` の二重呼び出しを検出する点、エラーハンドリングが合成の一部として組み込まれている点が特徴的である。

また、`#dispatch` メソッドにはハンドラが1つだけの場合に `compose` を迂回する最適化が含まれている。

```typescript
// src/hono-base.ts:423-442
// Do not `compose` if it has only one handler
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

ミドルウェアなしの単純なルートハンドラでは、async dispatch chain の生成コストを完全にスキップできる。

### Context: リクエスト/レスポンスの統合アクセスポイント

`Context` クラスはリクエスト/レスポンスのライフサイクルを管理する中心オブジェクトである。遅延初期化パターンが徹底されている。

```typescript
// src/context.ts:356-359
get req(): HonoRequest<P, I['out']> {
  this.#req ??= new HonoRequest(this.#rawRequest, this.#path, this.#matchResult)
  return this.#req
}
```

`HonoRequest` は `c.req` に初めてアクセスしたときにのみ生成される。同様に `HonoRequest` 内部でもボディの解析結果がキャッシュされる。

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

一度 `json()` で消費したボディを `text()` で再取得する場合も、キャッシュから再構築する仕組みが組み込まれている。

### Env 型システム: ランタイム環境の型安全な抽象化

`Env` 型はランタイム固有のバインディングと変数を型安全に扱う仕組みである。

```typescript
// src/types.ts:27-34
export type Bindings = object
export type Variables = object

export type BlankEnv = {}
export type Env = {
  Bindings?: Bindings
  Variables?: Variables
}
```

`Bindings` はランタイム環境が提供するもの（Cloudflare Workers の KV、D1 等）、`Variables` はミドルウェアが設定する中間データを表す。この型パラメータがコンストラクタから `Context`、さらにハンドラまで伝播する。

### Adapter 層: ランタイム固有機能の統一的な提供

各アダプターはランタイム固有の機能（静的ファイル配信、WebSocket、接続情報取得等）を提供する。コア自体はランタイムに依存しないため、アダプターは「追加機能の提供者」に徹している。

```typescript
// src/adapter/bun/index.ts:1-12
export { serveStatic } from './serve-static'
export { bunFileSystemModule, toSSG } from './ssg'
export { createBunWebSocket, upgradeWebSocket, websocket } from './websocket'
export type { BunWebSocketData, BunWebSocketHandler } from './websocket'
export { getConnInfo } from './conninfo'
export { getBunServer } from './server'
```

AWS Lambda アダプターは特に興味深く、`handle` と `streamHandle` の2つのエントリポイントを持つ。`streamHandle` は Lambda の Response Streaming API を使い、`app.fetch` の結果を Node.js の WritableStream に変換する。

```typescript
// src/adapter/aws-lambda/handler.ts:138-193
export const streamHandle = <E extends Env = Env, S extends Schema = {}, BasePath extends string = '/'>(
  app: Hono<E, S, BasePath>
): Handler => {
  return awslambda.streamifyResponse(
    async (event: LambdaEvent, responseStream: NodeJS.WritableStream, context: LambdaContext) => {
      const req = processor.createRequest(event)
      const res = await app.fetch(req, { event, requestContext, context })
      // Response -> Node.js WritableStream への変換
      if (res.body) {
        await streamToNodeStream(res.body.getReader(), responseStream)
      }
    }
  )
}
```

### RPC クライアント: Proxy による型安全な API 呼び出し

`hc` (Hono Client) は JavaScript の `Proxy` を使ってルート定義の型情報からクライアントを動的に生成する。

```typescript
// src/client/client.ts:15-31
const createProxy = (callback: Callback, path: string[]) => {
  const proxy: unknown = new Proxy(() => {}, {
    get(_obj, key) {
      if (typeof key !== 'string' || key === 'then') {
        return undefined
      }
      return createProxy(callback, [...path, key])
    },
    apply(_1, _2, args) {
      return callback({
        path,
        args,
      })
    },
  })
  return proxy
}
```

プロパティアクセスをパス構築に、関数呼び出しをリクエスト発行に変換する。`$get`, `$post` 等の `$` プレフィックスでメソッドを指定する規約を持ち、`$url` で URL オブジェクトの取得、`$ws` で WebSocket 接続が可能。

## コード例

### route() によるサブアプリケーション合成

```typescript
// src/hono-base.ts:208-232
route<SubPath extends string, SubEnv extends Env, SubSchema extends Schema, SubBasePath extends string, SubCurrentPath extends string>(
  path: SubPath,
  app: Hono<SubEnv, SubSchema, SubBasePath, SubCurrentPath>
): Hono<E, MergeSchemaPath<SubSchema, MergePath<BasePath, SubPath>> | S, BasePath, CurrentPath> {
  const subApp = this.basePath(path)
  app.routes.map((r) => {
    let handler
    if (app.errorHandler === errorHandler) {
      handler = r.handler
    } else {
      handler = async (c: Context, next: Next) =>
        (await compose([], app.errorHandler)(c, () => r.handler(c, next))).res
      ;(handler as any)[COMPOSED_HANDLER] = r.handler
    }
    subApp.#addRoute(r.method, r.path, handler)
  })
  return this
}
```

サブアプリケーションがカスタムの `errorHandler` を持つ場合のみ、compose でラップしてエラー境界を保持する。デフォルトの errorHandler の場合はラップなしでハンドラを直接登録するため、オーバーヘッドが最小化される。

### HTTPException によるエラーレスポンスの統合

```typescript
// src/hono-base.ts:35-42
const errorHandler: ErrorHandler = (err, c) => {
  if ('getResponse' in err) {
    const res = err.getResponse()
    return c.newResponse(res.body, res)
  }
  console.error(err)
  return c.text('Internal Server Error', 500)
}
```

`getResponse` メソッドの存在チェック（ダックタイピング）により、`HTTPException` を特別扱いしつつも、`HTTPException` 以外のエラーオブジェクトが `getResponse` を持つ場合にも対応している。

## Good Patterns

- **Method Swapping による遅延最適化**: SmartRouter と RegExpRouter が初回呼び出し時に `this.match` を最適化版に差し替える。起動時のコストをゼロにしつつ、2回目以降は最高速度のパスを通る。このパターンはルーター初期化のコストを実行時に分散させ、かつ初期化後のオーバーヘッドを排除する。

```typescript
// src/router/smart-router/router.ts:46
this.match = router.match.bind(router)
```

- **最小インターフェースによる Strategy パターン**: `Router<T>` は `add` と `match` の2メソッドだけという極限まで削ぎ落とされたインターフェース。5種類のルーター実装（RegExpRouter, TrieRouter, LinearRouter, PatternRouter, SmartRouter）がすべてこの同じ契約に従うことで、組み合わせの自由度と入れ替えの容易さを実現している。

```typescript
// src/router.ts:29-52
export interface Router<T> {
  name: string
  add(method: string, path: string, handler: T): void
  match(method: string, path: string): Result<T>
}
```

- **薄いサブクラスによるプリセットパターン**: エントリポイントクラスはコンストラクタでルーターを注入するだけの数行のコードで構成される。ロジックはすべて HonoBase に集約されており、プリセットの追加が最小コストで行える。

```typescript
// src/preset/tiny.ts:13-24
export class Hono<...> extends HonoBase<E, S, BasePath> {
  constructor(options: HonoOptions<E> = {}) {
    super(options)
    this.router = new PatternRouter()
  }
}
```

- **Single-handler 最適化**: `#dispatch` 内でマッチしたハンドラが1つだけの場合、compose を迂回して直接ハンドラを実行する。ミドルウェアを使わないシンプルなルートが大半を占めるアプリケーションで顕著なパフォーマンス向上をもたらす。

```typescript
// src/hono-base.ts:424
if (matchResult[0].length === 1) {
  // compose を使わず直接実行
  res = matchResult[0][0][0][0](c, async () => { ... })
}
```

- **遅延初期化の徹底**: Context は HonoRequest を、HonoRequest はボディキャッシュを、それぞれ最初のアクセス時にのみ生成する。不要なオブジェクト生成を徹底的に排除している。

```typescript
// src/context.ts:357
this.#req ??= new HonoRequest(this.#rawRequest, this.#path, this.#matchResult)
```

## Anti-Patterns / 注意点

- **next() の二重呼び出し**: compose の dispatch chain は `next()` が二重呼び出しされると例外を投げる。ミドルウェア内で条件分岐して `next()` を呼ぶ場合、すべてのパスで一度だけ呼ばれることを保証する必要がある。

```typescript
// Bad: next() が複数回呼ばれる可能性
const bad: MiddlewareHandler = async (c, next) => {
  await next()
  if (c.res.status === 404) {
    await next() // Error: next() called multiple times
  }
}

// Better: 条件分岐は next() の前に行う、または Response を差し替える
const better: MiddlewareHandler = async (c, next) => {
  await next()
  if (c.res.status === 404) {
    c.res = c.text('Custom 404', 404)
  }
}
```

- **Context の finalized チェック漏れ**: ハンドラが Response を返さず、かつ `await next()` もしない場合、Context は finalized されず例外が発生する。compose 後の `context.finalized` チェック（`hono-base.ts:449-453`）がこれを検出する。

```typescript
// Bad: Response も返さず next() も呼ばない
app.get('/broken', (c) => {
  // 何も返さない -> "Context is not finalized" エラー
})

// Better: 必ず Response を返すか next() を呼ぶ
app.get('/ok', (c) => {
  return c.text('OK')
})
```

- **ルーター追加後のルート変更**: `MESSAGE_MATCHER_IS_ALREADY_BUILT` エラーが示すように、一度マッチャーがビルドされた（最初の `match` 呼び出し後の）ルーターにはルートを追加できない。RegExpRouter は `buildAllMatchers` 後にルート定義を `undefined` に設定してメモリを解放するため、サーバー起動後の動的ルート追加はできない設計である。

```typescript
// src/router/reg-exp-router/router.ts:218
this.#middleware = this.#routes = undefined
```

## 自分のプロジェクトへの適用

- [ ] Strategy パターンで差し替え可能なコンポーネント（DB ドライバ、キャッシュバックエンド等）を設計する際に、add/match のような2-3メソッドの最小インターフェースを定義する
- [ ] 初期化コストが高い処理に Method Swapping パターン（初回呼び出し時にメソッドを最適化版に差し替え）を適用する
- [ ] Web Standards（Request/Response）を基盤にすることで、テストの容易性とランタイム移植性を両立させる設計を検討する
- [ ] ミドルウェア合成パターン（koa-compose 型の dispatch chain）を、バリデーション・認証・ログなどの横断的関心事の処理に採用する
- [ ] 遅延初期化（nullish coalescing assignment `??=`）を活用してオブジェクト生成コストを最小化する
- [ ] 薄いサブクラス + コンストラクタ注入のパターンで、同一コアに対する複数のプリセット構成を提供する
