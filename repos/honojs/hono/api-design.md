# API Design

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono の API 設計は、Express ライクな親しみやすいインターフェースと、TypeScript の型システムを極限まで活用した型安全性を両立させている。Web Standards (Request/Response) の上に構築された薄い抽象層として、Context オブジェクトが全てのレスポンス生成を担い、ミドルウェアは koa-compose パターンで合成される。特筆すべきは、ルーティング定義から RPC クライアントの型が自動的に導出される仕組みと、Router を Strategy パターンで切り替え可能にしたプラガブル設計である。

## Context オブジェクト: 統一的なレスポンスインターフェース

Hono の API 設計の中核は `Context` クラスにある。ハンドラは `(c: Context, next: Next) => Response` というシグネチャを持ち、Context が全てのリクエスト/レスポンス操作の窓口となる。

Context は用途別のレスポンスメソッドを提供する:

```typescript
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

`c.text()` は最頻出パスでオブジェクト生成を最小化するファストパスを持つ。ヘッダもステータスも未設定なら、直接 `new Response(text)` を返す。`c.json()`, `c.html()`, `c.redirect()` も同様に Content-Type を自動設定する専用メソッドとして提供される。

Context はまた、ミドルウェア間でデータを共有するための型安全な変数ストアを持つ:

```typescript
// src/context.ts:536-546
set: Set<...> = (key: string, value: unknown) => {
  this.#var ??= new Map()
  this.#var.set(key, value)
}
```

`c.set()` / `c.get()` は `Env['Variables']` 型パラメータにより、キーと値の型が静的に検証される。

## HonoRequest: Web Standards のラッパー

`HonoRequest` は生の `Request` オブジェクトを薄くラップし、よく使う操作に簡潔なアクセスを提供する:

```typescript
// src/request.ts:36
export class HonoRequest<P extends string = '/', I extends Input['out'] = {}> {
  raw: Request  // 元のRequestにいつでもアクセス可能
```

パスパラメータの取得はジェネリクスで型推論される:

```typescript
// src/request.ts:94-102
param<P2 extends ParamKeys<P> = ParamKeys<P>>(key: P2 extends `${infer _}?` ? never : P2): string
param<P2 extends RemoveQuestion<ParamKeys<P>> = RemoveQuestion<ParamKeys<P>>>(
  key: P2
): string | undefined
param(key: string): string | undefined
param<P2 extends string = P>(): Simplify<UnionToIntersection<ParamKeyToRecord<ParamKeys<P2>>>>
param(key?: string): unknown {
  return key ? this.#getDecodedParam(key) : this.#getAllDecodedParams()
}
```

`/users/:id` というパスに対して `c.req.param('id')` は `string` 型を返し、`/users/:id?` に対しては `string | undefined` を返す。この型推論はパス文字列のテンプレートリテラル型から自動的に行われる。

ボディ解析にはキャッシュ機構が組み込まれている:

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

一度パースしたボディは別の形式 (json -> text 等) に変換して再利用できる。

## ルーティング: チェイナブル + 型累積

ルーティング API は Express と同じ `app.get(path, handler)` パターンだが、戻り値の型が累積的に更新される:

```typescript
// src/types.ts:168-183
// app.get(path, handler)
<
  P extends string,
  MergedPath extends MergePath<BasePath, P>,
  R extends HandlerResponse<any> = any,
  I extends Input = BlankInput,
  E2 extends Env = E,
>(
  path: P,
  handler: H<E2, MergedPath, I, R>
): HonoBase<
  E,
  AddSchemaIfHasResponse<MergeTypedResponse<R>, S, M, P, I, BasePath>,
  BasePath,
  MergePath<BasePath, P>
>
```

`app.get('/users', handler)` を呼ぶたびに、スキーマ型パラメータ `S` にそのルートの入出力型情報が追加される。これがチェイナブル API の型安全性を実現する鍵であり、最終的に RPC クライアントの型推論に使われる。

チェイナブル API の実装は constructor 内で行われる:

```typescript
// src/hono-base.ts:129-141
allMethods.forEach((method) => {
  this[method] = (args1: string | H, ...args: H[]) => {
    if (typeof args1 === 'string') {
      this.#path = args1
    } else {
      this.#addRoute(method, this.#path, args1)
    }
    args.forEach((handler) => {
      this.#addRoute(method, this.#path, handler)
    })
    return this as any
  }
})
```

最初の引数が文字列ならパスとして記録し、ハンドラならそのパスに対してルートを追加する。`return this` により連鎖呼び出しが可能になる。

## Router Strategy パターン

Hono は Router インターフェースを定義し、複数の実装を切り替えられる:

```typescript
// src/router.ts:29-52
export interface Router<T> {
  name: string
  add(method: string, path: string, handler: T): void
  match(method: string, path: string): Result<T>
}
```

5 つのルーター実装 (RegExpRouter, TrieRouter, SmartRouter, LinearRouter, PatternRouter) が提供され、SmartRouter がデフォルトで使用される。SmartRouter は最初のリクエスト時に最適なルーターを自動選択する:

```typescript
// src/router/smart-router/router.ts:32-49
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
  this.match = router.match.bind(router)  // 以降はこのルーターに直接委譲
  this.#routers = [router]
  this.#routes = undefined
  break
}
```

最初の `match()` 呼び出しで各ルーターを試し、成功したルーターの `match` メソッドで自身の `match` を上書きする。2 回目以降は直接そのルーターが使われるため、オーバーヘッドがゼロになる。

Preset パターンでルーター構成を変えたバリアントも提供される:

```typescript
// src/preset/tiny.ts:11-20
export class Hono<...> extends HonoBase<E, S, BasePath> {
  constructor(options: HonoOptions<E> = {}) {
    super(options)
    this.router = new PatternRouter()  // 最小サイズ
  }
}
```

`hono/tiny` は PatternRouter のみ、`hono/quick` は LinearRouter + TrieRouter の組み合わせで、用途に応じたバンドルサイズ最適化が可能。

## ミドルウェア合成: koa-compose パターン

ミドルウェアは `compose` 関数で合成される:

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
      // ...
    }
  }
}
```

`next()` の多重呼び出し検知、エラーハンドリング、Not Found ハンドリングが compose 内に統合されている。ただし、ハンドラが 1 つだけの場合は compose を呼ばず直接実行するファストパスがある:

```typescript
// src/hono-base.ts:424-442
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
    ? res.then(...)
    : (res ?? this.#notFoundHandler(c))
}
```

## Validator: ターゲット別バリデーション

`validator` はバリデーション対象 (json, form, query, param, header, cookie) を第一引数で指定する設計:

```typescript
// src/validator/validator.ts:93-160
switch (target) {
  case 'json':
    if (!contentType || !jsonRegex.test(contentType)) { break }
    value = await c.req.json()
    break
  case 'form':
    // FormData の解析
    break
  case 'query':
    value = Object.fromEntries(...)
    break
  case 'param':
    value = c.req.param() as Record<string, string>
    break
  case 'header':
    value = c.req.header()
    break
  case 'cookie':
    value = getCookie(c)
    break
}
const res = await validationFunc(value as never, c as never)
if (res instanceof Response) { return res }
c.req.addValidatedData(target, res as never)
```

バリデーション結果は `c.req.addValidatedData()` で格納され、後続ハンドラで `c.req.valid('json')` として型安全に取得できる。GET/HEAD メソッドではボディ系バリデーション (json, form) が型レベルで禁止される。

## HTTPException: 構造化されたエラーレスポンス

```typescript
// src/http-exception.ts:46-78
export class HTTPException extends Error {
  readonly res?: Response
  readonly status: ContentfulStatusCode

  constructor(status: ContentfulStatusCode = 500, options?: HTTPExceptionOptions) {
    super(options?.message, { cause: options?.cause })
    this.res = options?.res
    this.status = status
  }

  getResponse(): Response {
    if (this.res) {
      const newResponse = new Response(this.res.body, {
        status: this.status,
        headers: this.res.headers,
      })
      return newResponse
    }
    return new Response(this.message, { status: this.status })
  }
}
```

`HTTPException` はカスタム `Response` オブジェクトを持てるため、エラーレスポンスの形式を完全に制御できる。デフォルトの `errorHandler` は `getResponse()` を持つエラーを自動的に処理する:

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

## モジュール分割: 60+ エントリーポイント

package.json の `exports` フィールドにより、各機能が独立したエントリーポイントとして公開される:

```json
"hono" -> コア (Hono, Context)
"hono/tiny" -> PatternRouter のみ (最小バンドル)
"hono/quick" -> LinearRouter + TrieRouter
"hono/cors" -> CORS ミドルウェア
"hono/bearer-auth" -> Bearer Auth ミドルウェア
"hono/factory" -> createFactory, createMiddleware
"hono/testing" -> testClient
"hono/streaming" -> stream, streamSSE, streamText
"hono/validator" -> validator
"hono/combine" -> some, every, except
```

ユーザーは必要な機能だけをインポートし、ツリーシェイキングにより不要なコードがバンドルに含まれない。

## Good Patterns

- **Context 経由の統一レスポンス API**: `c.text()`, `c.json()`, `c.html()`, `c.redirect()` といった用途別メソッドにより、Content-Type の設定漏れを防ぎ、戻り値の型情報 (`TypedResponse<T, U, F>`) が自動的に伝搬する。レスポンス生成のボイラープレートが排除され、かつ型安全である。

```typescript
// src/context.ts:698-711
json: JSONRespond = <T extends JSONValue | {} | InvalidJSONValue, U extends ContentfulStatusCode>(
  object: T,
  arg?: U | ResponseOrInit<U>,
  headers?: HeaderRecord
): JSONRespondReturn<T, U> => {
  return this.#newResponse(
    JSON.stringify(object),
    arg,
    setDefaultContentType('application/json', headers)
  ) as any
}
```

- **Router Strategy パターンによるプラガブル設計**: Router インターフェースが `add` と `match` のみで構成されており、実装の差し替えが容易。SmartRouter の自動選択により、ユーザーはルーティングの実装詳細を意識する必要がない。

```typescript
// src/router.ts:29-52
export interface Router<T> {
  name: string
  add(method: string, path: string, handler: T): void
  match(method: string, path: string): Result<T>
}
```

- **ファストパスによるパフォーマンス最適化**: 単一ハンドラ時の compose スキップ、`c.text()` のヘッダ未設定時のショートカットなど、最頻出パスを最速化している。これはフレームワーク設計において「抽象化のコストをゼロに近づける」好例。

- **combine ミドルウェアによる論理合成**: `some`, `every`, `except` によりミドルウェアを論理演算のように組み合わせられる。条件分岐をハンドラ内に書く代わりに、宣言的にミドルウェアを構成できる。

```typescript
// src/middleware/combine/index.ts:38
export const some = (...middleware: (MiddlewareHandler | Condition)[]): MiddlewareHandler => {
  // いずれかが成功すれば通過
}
export const every = (...middleware: (MiddlewareHandler | Condition)[]): MiddlewareHandler => {
  // 全てが成功すれば通過
}
export const except = (condition, ...middleware): MiddlewareHandler => {
  // 条件にマッチしない場合のみミドルウェアを適用
}
```

- **Factory パターンによるミドルウェア型推論**: `createMiddleware` と `createFactory` により、ミドルウェアの型情報を明示的に記述しなくても正しい型が推論される。

```typescript
// src/helper/factory/index.ts:353-355
createMiddleware = <I extends Input = {}, R extends HandlerResponse<any> | void = void>(
  middleware: MiddlewareHandler<E, P, I, R extends void ? Response : R>
): MiddlewareHandler<E, P, I, R extends void ? Response : R> => middleware
```

## Anti-Patterns / 注意点

- **Context の `finalized` 状態の見落とし**: `c.res` を設定すると `finalized = true` になり、以降のヘッダ操作で新しい Response オブジェクトが生成される。ミドルウェアで `await next()` 後にヘッダを追加する場合、この挙動を理解していないと意図しない動作になる。

```typescript
// Bad: finalized 後の不必要な Response 再生成
app.use(async (c, next) => {
  await next()
  // c.res は既に finalized=true のため、header() 内で new Response() が呼ばれる
  c.header('X-Custom', 'value')
  c.header('X-Another', 'value')  // さらにもう一度 new Response()
})

// Better: newResponse で一度に設定
app.use(async (c, next) => {
  await next()
  c.res = new Response(c.res.body, {
    ...c.res,
    headers: new Headers([
      ...c.res.headers.entries(),
      ['X-Custom', 'value'],
      ['X-Another', 'value'],
    ]),
  })
})
```

- **next() の呼び忘れ / 多重呼び出し**: compose 内で `next()` の多重呼び出しはエラーになる。一方、`next()` を呼ばないとミドルウェアチェーンが中断される。レスポンスを返さずに `next()` も呼ばないと、`Context is not finalized` エラーが発生する。

```typescript
// Bad: next() の呼び忘れ
app.use(async (c, next) => {
  if (someCondition) {
    return c.text('Early return')  // OK: レスポンスを返している
  }
  // next() を呼ばず、レスポンスも返していない -> エラー
})

// Better: 全パスで next() またはレスポンスを保証
app.use(async (c, next) => {
  if (someCondition) {
    return c.text('Early return')
  }
  await next()
})
```

- **型の `any` エスケープハッチ多用への注意**: Hono のコードベース自体は型安全性のために多くの型パラメータを使うが、`HandlerInterface` 定義は最大 10 個のハンドラオーバーロードに制限されている。ユーザーコードでハンドラ数がこの上限を超えると型推論が失われる可能性がある。

## 自分のプロジェクトへの適用

- [ ] Context パターンの採用: リクエスト/レスポンス操作を Context オブジェクトに集約し、用途別メソッド (`text()`, `json()` 等) で Content-Type の自動設定と TypedResponse による型安全性を同時に実現する
- [ ] Router Strategy パターンの採用: コアのインターフェース (`add`, `match`) を最小に保ち、実装をプラガブルにすることで、パフォーマンス特性の異なるアルゴリズムを切り替え可能にする
- [ ] ミドルウェア合成の設計: koa-compose パターンを採用し、`some` / `every` / `except` のような論理合成を提供して、ミドルウェアの組み合わせを宣言的に記述できるようにする
- [ ] モジュール分割: package.json の `exports` フィールドで機能ごとにエントリーポイントを分離し、ツリーシェイキングによるバンドルサイズ最適化を可能にする
- [ ] ファストパスの設計: 最も頻出するユースケース (単一ハンドラ、シンプルなテキストレスポンス) でオブジェクト生成を最小化する最適化パスを設ける
- [ ] TypedResponse パターン: レスポンスの型情報 (`_data`, `_status`, `_format`) をブランド型として持たせ、スキーマ型の累積を通じて RPC クライアントの型を自動導出する仕組みを参考にする
