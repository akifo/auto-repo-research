# Middleware System

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono のミドルウェアシステムは koa-compose にインスパイアされた非同期 dispatch chain をコアに持ち、`(c: Context, next: Next) => Promise<Response | void>` という統一的なシグネチャで全ミドルウェアを定義する。25種の組み込みミドルウェアを備えながら、コア部分はわずか73行の `compose.ts` に収められている。単一ハンドラ時の compose 省略最適化、`COMPOSED_HANDLER` によるサブアプリの事前合成、`combine` モジュールによる論理的なミドルウェア合成（some/every/except）など、シンプルさとパフォーマンスの両立が注目に値する。

## 設計・実装の詳細

### コアとなる compose 関数

ミドルウェアチェーンの心臓部は `src/compose.ts` の `compose` 関数である。koa-compose のアルゴリズムをベースに、再帰的な `dispatch` 関数でチェーンを構築する。

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
      let res
      let isError = false
      let handler

      if (middleware[i]) {
        handler = middleware[i][0][0]
        context.req.routeIndex = i
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

      if (res && (context.finalized === false || isError)) {
        context.res = res
      }
      return context
    }
  }
}
```

設計上の要点:
- `index` 変数で `next()` の多重呼び出しを検出する
- `onError` と `onNotFound` をチェーン末尾のフォールバックとして組み込む
- `context.finalized` フラグでレスポンス確定済みかどうかを判断し、不要なレスポンス上書きを防ぐ
- ミドルウェア配列が空になったとき、外部から渡された `next` を呼ぶことでサブアプリのネストを実現する

### ミドルウェアの型システム

`MiddlewareHandler` と `Handler` は明確に分離されている。

```typescript
// src/types.ts:36
export type Next = () => Promise<void>

// src/types.ts:77-82
export type Handler<
  E extends Env = any, P extends string = any,
  I extends Input = BlankInput, R extends HandlerResponse<any> = any,
> = (c: Context<E, P, I>, next: Next) => R

// src/types.ts:84-89
export type MiddlewareHandler<
  E extends Env = any, P extends string = string,
  I extends Input = {}, R extends HandlerResponse<any> = Response,
> = (c: Context<E, P, I>, next: Next) => Promise<R | void>

// src/types.ts:91-96
export type H<...> = Handler<...> | MiddlewareHandler<...>
```

`Handler` はレスポンスを返す終端ハンドラ、`MiddlewareHandler` は `await next()` で次のハンドラに制御を渡すものという意味的な区別がある。ただし型レベルでは `H` で統合され、ルーティング登録時にはどちらも受け入れられる。

### app.use() によるミドルウェア登録

```typescript
// src/hono-base.ts:157-168
this.use = (arg1: string | MiddlewareHandler<any>, ...handlers: MiddlewareHandler<any>[]) => {
  if (typeof arg1 === 'string') {
    this.#path = arg1
  } else {
    this.#path = '*'
    handlers.unshift(arg1)
  }
  handlers.forEach((handler) => {
    this.#addRoute(METHOD_NAME_ALL, this.#path, handler)
  })
  return this as any
}
```

パス指定なしの場合は `*`（全パス一致）が暗黙的に設定される。`METHOD_NAME_ALL` で全 HTTP メソッドに対して登録される。

### 単一ハンドラ時の compose 省略最適化

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

マッチしたハンドラが1つだけの場合、`compose` を経由せず直接ハンドラを呼び出す。これにより、ミドルウェアなしのルートで不要な Promise チェーンのオーバーヘッドを排除している。

### COMPOSED_HANDLER によるサブアプリ合成の最適化

```typescript
// src/hono-base.ts:220-226
if (app.errorHandler === errorHandler) {
  handler = r.handler
} else {
  handler = async (c: Context, next: Next) =>
    (await compose([], app.errorHandler)(c, () => r.handler(c, next))).res
  ;(handler as any)[COMPOSED_HANDLER] = r.handler
}
```

`route()` でサブアプリを合成する際、カスタム errorHandler を持つ場合はラッパーハンドラを生成する。`COMPOSED_HANDLER` プロパティに元のハンドラを保持することで、`findTargetHandler` を通じてネストされた合成を解決できる。

```typescript
// src/utils/handler.ts:8-15
export const isMiddleware = (handler: Function) => handler.length > 1
export const findTargetHandler = (handler: Function): Function => {
  return (handler as any)[COMPOSED_HANDLER]
    ? findTargetHandler((handler as any)[COMPOSED_HANDLER])
    : handler
}
```

`isMiddleware` は引数の数（`c` のみ = ハンドラ、`c, next` = ミドルウェア）で判別するシンプルなヒューリスティクスである。

### combine モジュールによる論理的なミドルウェア合成

`src/middleware/combine/index.ts` は `some`、`every`、`except` の3つの合成ユーティリティを提供する。

**some**: OR 条件。最初に成功したミドルウェアの結果を採用する。

```typescript
// src/middleware/combine/index.ts:38-68
export const some = (...middleware: (MiddlewareHandler | Condition)[]): MiddlewareHandler => {
  return async function some(c, next) {
    let isNextCalled = false
    const wrappedNext = () => {
      isNextCalled = true
      return next()
    }
    let lastError: unknown
    for (const handler of middleware) {
      try {
        const result = await handler(c, wrappedNext)
        if (result === true && !c.finalized) {
          await wrappedNext()
        } else if (result === false) {
          lastError = new Error('No successful middleware found')
          continue
        }
        lastError = undefined
        break
      } catch (error) {
        lastError = error
        if (isNextCalled) { break }
      }
    }
    if (lastError) { throw lastError }
  }
}
```

**every**: AND 条件。全ミドルウェアを `compose` で直列実行する。

```typescript
// src/middleware/combine/index.ts:99-117
export const every = (...middleware: (MiddlewareHandler | Condition)[]): MiddlewareHandler => {
  return async function every(c, next) {
    const currentRouteIndex = c.req.routeIndex
    await compose(
      middleware.map((m) => [[
        async (c: Context, next: Next) => {
          c.req.routeIndex = currentRouteIndex
          const res = await m(c, next)
          if (res === false) { throw new Error('Unmet condition') }
          return res
        },
      ]])
    )(c, next)
  }
}
```

**except**: 条件に一致しない場合のみミドルウェアを適用する。パス文字列や関数で条件を指定できる。

```typescript
// src/middleware/combine/index.ts:141-165
export const except = (
  condition: string | Condition | (string | Condition)[],
  ...middleware: MiddlewareHandler[]
): MiddlewareHandler => {
  // 文字列条件は TrieRouter でパスマッチングに変換
  // some(条件判定, every(...middleware)) で実装
  const handler = some(
    (c: Context) => conditions.some((cond) => cond(c)),
    every(...middleware)
  )
  return async function except(c, next) { await handler(c, next) }
}
```

### Context を通じたミドルウェア間のデータ共有

ミドルウェア間のデータ受け渡しは `c.set()` / `c.get()` / `c.var` で行う。

```typescript
// src/context.ts:536-546
set: Set<...> = (key: string, value: unknown) => {
  this.#var ??= new Map()
  this.#var.set(key, value)
}

// src/context.ts:583-592
get var(): Readonly<ContextVariableMap & ...> {
  if (!this.#var) { return {} as any }
  return Object.fromEntries(this.#var)
}
```

型安全性のために、ミドルウェアは `ContextVariableMap` の declaration merging を利用する。

```typescript
// src/middleware/request-id/index.ts:5-7
declare module '../..' {
  interface ContextVariableMap extends RequestIdVariables {}
}
```

これにより、`import 'hono/request-id'` するだけで `c.var.requestId` が型補完される。

### context-storage による非同期コンテキスト共有

`AsyncLocalStorage` を使い、ミドルウェアチェーン外のヘルパー関数からも Context にアクセス可能にする。

```typescript
// src/middleware/context-storage/index.ts:43-47
export const contextStorage = (): MiddlewareHandler => {
  return async function contextStorage(c, next) {
    await asyncLocalStorage.run(c, next)
  }
}
```

### ミドルウェアの「前処理/後処理」パターン

`await next()` の前後でロジックを分割するのが Hono ミドルウェアの基本パターンである。

```typescript
// src/middleware/logger/index.ts:82-95 (前処理 + 後処理)
export const logger = (fn: PrintFunc = console.log): MiddlewareHandler => {
  return async function logger(c, next) {
    const { method, url } = c.req
    const path = url.slice(url.indexOf('/', 8))
    await log(fn, LogPrefix.Incoming, method, path)     // 前処理: リクエストログ
    const start = Date.now()
    await next()                                         // 次のハンドラに委譲
    await log(fn, LogPrefix.Outgoing, method, path,      // 後処理: レスポンスログ
      c.res.status, time(start))
  }
}
```

## コード例

### ファクトリ関数による型安全なミドルウェア作成

```typescript
// src/helper/factory/index.ts:368-375
export const createMiddleware = <
  E extends Env = any, P extends string = string,
  I extends Input = {}, R extends HandlerResponse<any> | void = void,
>(
  middleware: MiddlewareHandler<E, P, I, R extends void ? Response : R>
): MiddlewareHandler<E, P, I, R extends void ? Response : R> => middleware
```

`createMiddleware` は実質的にアイデンティティ関数だが、TypeScript の型推論を支援する。ミドルウェアの `Env` 型を明示することで、`c.env` や `c.var` の型が正しく推論される。

### HTTPException によるミドルウェアからのエラー応答

```typescript
// src/middleware/bearer-auth/index.ts:153-206
return async function bearerAuth(c, next) {
  const headerToken = c.req.header(options.headerName || HEADER)
  if (!headerToken) {
    await throwHTTPException(c, 401, /* ... */)
  } else {
    const match = regexp.exec(headerToken)
    if (!match) {
      await throwHTTPException(c, 400, /* ... */)
    } else {
      // トークン検証
      if (!equal) {
        await throwHTTPException(c, 401, /* ... */)
      }
    }
  }
  await next()
}
```

`HTTPException` は `getResponse()` メソッドを持ち、`hono-base.ts` の `errorHandler` がこれを検出してカスタムレスポンスを返す。

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

## Good Patterns

- **ファクトリパターンによるミドルウェア生成**: 全ての組み込みミドルウェアはオプションを受け取り `MiddlewareHandler` を返すファクトリ関数で実装されている。設定をクロージャに閉じ込めることで、ミドルウェアインスタンスごとに独立した設定を持てる。`cors()`, `bearerAuth({ token })`, `timeout(5000)` のように呼び出し時の意図が明確になる。

```typescript
// src/middleware/cors/index.ts:63-70
export const cors = (options?: CORSOptions): MiddlewareHandler => {
  const defaults: CORSOptions = { origin: '*', allowMethods: ['GET', 'HEAD', 'PUT', 'POST', 'DELETE', 'PATCH'], ... }
  const opts = { ...defaults, ...options }
  // findAllowOrigin をクロージャで事前計算
  const findAllowOrigin = ((optsOrigin) => { /* ... */ })(opts.origin)
  return async function cors(c, next) { /* opts を参照 */ }
}
```

- **名前付き関数式によるデバッグ支援**: 全ての組み込みミドルウェアが `return async function cors(c, next)` のように名前付き関数式を使用している。スタックトレースやデバッガでミドルウェア名が表示されるため、問題の特定が容易になる。

```typescript
// src/middleware/powered-by/index.ts:30-35
export const poweredBy = (options?: PoweredByOptions): MiddlewareHandler => {
  return async function poweredBy(c, next) {  // 名前付き関数式
    await next()
    c.res.headers.set('X-Powered-By', options?.serverName ?? 'Hono')
  }
}
```

- **Declaration Merging による型安全なコンテキスト変数**: ミドルウェアが `ContextVariableMap` を拡張することで、import するだけで `c.var` に型が付く。ミドルウェア利用者が明示的に `Variables` 型を指定する必要がない。

```typescript
// src/middleware/timing/index.ts:6-8
declare module '../..' {
  interface ContextVariableMap extends TimingVariables {}
}
```

- **単一ハンドラ最適化**: マッチ結果が1つのハンドラだけの場合、`compose` を完全にスキップして直接呼び出す。多くのルートはミドルウェアなしで1つのハンドラだけを持つため、これが大幅なパフォーマンス改善になる。

## Anti-Patterns / 注意点

- **`next()` の呼び忘れ**: ミドルウェアで `await next()` を呼び忘れると、後続のハンドラが実行されず、`Context is not finalized` エラーになる。compose.ts の `context.finalized === false` チェックがこれを検出する。

```typescript
// Bad: next() を呼ばずレスポンスも返さない
const bad: MiddlewareHandler = async (c, next) => {
  c.set('key', 'value')
  // await next() を忘れた
}

// Better: 必ず next() を呼ぶか、レスポンスを返す
const better: MiddlewareHandler = async (c, next) => {
  c.set('key', 'value')
  await next()
}
```

- **`next()` の多重呼び出し**: compose.ts の `i <= index` チェックが `next() called multiple times` エラーを投げる。条件分岐で next() を複数回呼ぶコードは壊れる。

```typescript
// Bad: 条件分岐の両方で next() を呼ぶ可能性
const bad: MiddlewareHandler = async (c, next) => {
  await next()
  if (c.res.status === 404) {
    await next()  // Error: next() called multiple times
  }
}

// Better: next() は一度だけ。後処理で条件分岐する
const better: MiddlewareHandler = async (c, next) => {
  await next()
  if (c.res.status === 404) {
    c.res = c.text('Custom 404', 404)
  }
}
```

- **後処理での headers 操作と finalized の関係**: `c.finalized` が true になった後に `c.header()` を呼ぶと、内部で Response オブジェクトが複製される（`src/context.ts:506-508`）。パフォーマンスに影響するため、可能な限りレスポンス確定前にヘッダを設定する。

```typescript
// src/context.ts:506-508
header: SetHeaders = (name, value, options): void => {
  if (this.finalized) {
    this.#res = new Response((this.#res as Response).body, this.#res)  // 複製が発生
  }
  // ...
}
```

## 自分のプロジェクトへの適用

- [ ] ミドルウェアをファクトリ関数パターンで設計する（オプション → クロージャ → ハンドラ関数を返す）
- [ ] 名前付き関数式 `return async function myMiddleware(c, next)` を使い、スタックトレースの可読性を確保する
- [ ] ミドルウェア間のデータ共有は Context のような共有オブジェクトを介し、グローバル状態を避ける
- [ ] `some`/`every`/`except` のような論理的なミドルウェア合成ユーティリティを用意し、認証/認可の条件分岐を宣言的に記述する
- [ ] koa-compose 型の dispatch chain を採用する場合、`next()` の多重呼び出し防止ガードを必ず実装する
- [ ] `ContextVariableMap` の declaration merging パターンを参考に、ミドルウェアが利用者の型定義を自動拡張する仕組みを検討する
- [ ] 単一ハンドラ最適化のように、ホットパスで不要な抽象化層をバイパスするパフォーマンス戦略を検討する
