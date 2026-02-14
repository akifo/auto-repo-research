# error-handling

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono のエラーハンドリングは、`HTTPException` クラスを中心とした throw/catch パターンと、koa-compose ベースのミドルウェア合成による `onError` コールバックの 2 層構造で設計されている。HTTP セマンティクスに忠実なエラー表現（ステータスコード + レスポンスボディの同梱）と、ミドルウェアからのエラー伝播を一元的に処理する仕組みが注目に値する。フレームワーク全体で約 80 行の実装に収まっており、シンプルさと拡張性を両立している。

## 設計・実装の詳細

### エラーの分類と型設計

Hono はエラーを 3 つの層に分類している。

1. **HTTPException** -- HTTP レスポンスに直結するアプリケーションエラー（401, 403, 413 など）
2. **カスタムエラークラス** -- ドメイン固有のエラー（`UnsupportedPathError`, `BodyLimitError` など）
3. **一般的な Error** -- 予期しないランタイムエラー

`ErrorHandler` 型は `Error | HTTPResponseError` のユニオンを受け取る設計になっている。`HTTPResponseError` は `getResponse()` メソッドを持つインターフェースとして定義されており、`HTTPException` に限らず `getResponse()` を実装した任意のエラーオブジェクトを処理できる。

```typescript
// src/types.ts:114-120
export interface HTTPResponseError extends Error {
  getResponse: () => Response
}
export type ErrorHandler<E extends Env = any> = (
  err: Error | HTTPResponseError,
  c: Context<E>
) => Response | Promise<Response>
```

### HTTPException -- レスポンス同梱型の例外

`HTTPException` は HTTP ステータスコードとオプションの `Response` オブジェクトを保持する。`getResponse()` メソッドは、事前構築された `Response` があればそのボディとヘッダーを引き継ぎつつステータスコードを上書きし、なければ `message` からプレーンテキストのレスポンスを生成する。

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
    return new Response(this.message, {
      status: this.status,
    })
  }
}
```

重要な設計判断として、`getResponse()` は常に新しい `Response` を生成する。`this.res` がある場合でも `new Response()` で包み直し、`this.status` で上書きする。これにより、`res` オプションに渡された Response のステータスコードと `HTTPException` のステータスコードが異なる場合、後者が優先される。

### デフォルト errorHandler -- duck typing による分岐

`hono-base.ts` のデフォルト `errorHandler` は `instanceof` ではなく `'getResponse' in err` で判定している。これにより `HTTPException` 以外のエラーオブジェクトでも `getResponse()` を持っていれば同じフローで処理される。

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

### compose 関数 -- ミドルウェアチェーンでのエラー伝播

`compose` は koa-compose をベースとした再帰的なミドルウェアディスパッチャーで、エラーハンドリングの中核を担う。

```typescript
// src/compose.ts:50-60
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
}
```

注目すべきポイント:

- **`err instanceof Error` チェック**: Error でないもの（文字列や数値の throw）は `onError` で処理せず再 throw する
- **`context.error` への代入**: エラー発生後、上流ミドルウェアが `c.error` でエラー内容を参照できる
- **`isError` フラグ**: エラーハンドラが返した Response で `context.res` を上書きするための制御

### #dispatch -- 単一ハンドラ最適化とエラー処理

`hono-base.ts` の `#dispatch` メソッドでは、マッチしたハンドラが 1 つだけの場合に `compose` を経由せず直接実行する最適化が入っている。この場合もエラー処理は `#handleError` メソッドで一貫して行われる。

```typescript
// src/hono-base.ts:393-398
#handleError(err: unknown, c: Context<E>): Response | Promise<Response> {
  if (err instanceof Error) {
    return this.errorHandler(err, c)
  }
  throw err
}
```

複数ハンドラの場合は `compose` を実行した後、`context.finalized` をチェックし、レスポンスが設定されていなければ開発者向けのわかりやすいエラーメッセージを throw する。

```typescript
// src/hono-base.ts:446-459
const composed = compose(matchResult[0], this.errorHandler, this.#notFoundHandler)
return (async () => {
  try {
    const context = await composed(c)
    if (!context.finalized) {
      throw new Error(
        'Context is not finalized. Did you forget to return a Response object or `await next()`?'
      )
    }
    return context.res
  } catch (err) {
    return this.#handleError(err, c)
  }
})()
```

### サブアプリの errorHandler 伝播

`route()` メソッドでサブアプリを結合する際、サブアプリがカスタム `errorHandler` を持つ場合のみ `compose` でラップして伝播させる。デフォルトのままなら余分なラッピングを省略する。

```typescript
// src/hono-base.ts:219-232
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
```

### ミドルウェアでの HTTPException 活用パターン

組み込みミドルウェアは一貫して `HTTPException` を throw するパターンを採用している。特に認証系ミドルウェアでは、`res` オプションに適切な HTTP ヘッダー（`WWW-Authenticate` など）を含む Response を事前構築して渡す。

```typescript
// src/middleware/jwt/jwt.ts:85-95
const parts = credentials.split(/\s+/)
if (parts.length !== 2) {
  const errDescription = 'invalid credentials structure'
  throw new HTTPException(401, {
    message: errDescription,
    res: unauthorizedResponse({
      ctx,
      error: 'invalid_request',
      errDescription,
    }),
  })
}
```

```typescript
// src/middleware/csrf/index.ts:144-147
if (/* CSRF validation fails */) {
  const res = new Response('Forbidden', { status: 403 })
  throw new HTTPException(403, { res })
}
```

## コード例

### Context.error を利用したエラー後処理

ミドルウェアで `await next()` の後に `c.error` を参照することで、下流で発生したエラーに基づくロジックを実行できる。

```typescript
// src/context.ts:308-323
/**
 * `.error` can get the error object from the middleware if the Handler throws an error.
 */
// 使用例:
app.use('*', async (c, next) => {
  await next()
  if (c.error) {
    // do something...
  }
})
```

### body-limit ミドルウェアのカスタムエラークラス + HTTPException

`BodyLimitError` というドメイン固有のエラーを内部で使い、ストリーム読み取り中のサイズ超過を検出する。最終的な HTTP レスポンスへの変換は `HTTPException` 経由で行う。

```typescript
// src/middleware/body-limit/index.ts:18-23
class BodyLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BodyLimitError'
  }
}

// src/middleware/body-limit/index.ts:57-65
const onError: OnError =
  options.onError ||
  (() => {
    const res = new Response(ERROR_MESSAGE, {
      status: 413,
    })
    throw new HTTPException(413, { res })
  })
```

### timeout ミドルウェアの Promise.race パターン

タイムアウト検知に `Promise.race` を使い、タイムアウト時に `HTTPException` を reject する。

```typescript
// src/middleware/timeout/index.ts:42-57
export const timeout = (
  duration: number,
  exception: HTTPExceptionFunction | HTTPException = defaultTimeoutException
): MiddlewareHandler => {
  return async function timeout(context, next) {
    let timer: number | undefined
    const timeoutPromise = new Promise<void>((_, reject) => {
      timer = setTimeout(() => {
        reject(typeof exception === 'function' ? exception(context) : exception)
      }, duration) as unknown as number
    })
    try {
      await Promise.race([next(), timeoutPromise])
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
    }
  }
}
```

## Good Patterns

- **Response 同梱型 HTTPException**: `HTTPException` に `res` オプションとして完全な Response オブジェクト（カスタムヘッダー、JSON ボディ等）を渡せる設計。エラーの種類に応じた HTTP ヘッダー（`WWW-Authenticate` 等）をミドルウェア側で完全に制御でき、エラーハンドラに知識を集約する必要がない。

```typescript
// src/middleware/basic-auth/index.ts:108-126
const status = 401
const headers = {
  'WWW-Authenticate': 'Basic realm="' + options.realm?.replace(/"/g, '\\"') + '"',
}
const res = new Response(responseMessage, { status, headers })
throw new HTTPException(status, { res })
```

- **HTTPResponseError インターフェースによる duck typing**: デフォルト errorHandler が `instanceof HTTPException` ではなく `'getResponse' in err` でチェックすることで、サードパーティのエラークラスでも `getResponse()` を実装するだけで同じフローに乗れる。開放/閉鎖原則に従った拡張性の高い設計。

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

- **compose での一元的エラーキャッチ**: すべてのミドルウェア/ハンドラのエラーが `compose` 内の単一の try/catch で捕捉され、`onError` に委譲される。個々のミドルウェアがエラーレスポンスを直接返す必要がなく、throw するだけでよい。

```typescript
// src/compose.ts:50-60
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
```

- **開発者向けの明確なエラーメッセージ**: `'Context is not finalized. Did you forget to return a Response object or \`await next()\`?'` のように、よくあるミスの原因と修正方法を直接メッセージに含める。また `next() called multiple times` もデバッグしやすい表現になっている。

## Anti-Patterns / 注意点

- **Error 以外の throw が無視される**: `compose` は `err instanceof Error` でフィルタリングするため、文字列や数値を throw するとエラーハンドラを迂回して再 throw される。ミドルウェア内で Error 以外を throw しないよう注意が必要。

```typescript
// Bad: Error 以外を throw
app.get('/bad', () => {
  throw 'something went wrong'  // onError に届かない
})

// Better: 必ず Error を throw
app.get('/good', () => {
  throw new Error('something went wrong')
})

// Best: HTTP セマンティクスがある場合は HTTPException
app.get('/best', () => {
  throw new HTTPException(400, { message: 'Invalid request' })
})
```

- **HTTPException の res と status の不整合**: `HTTPException` のコンストラクタで `res` に渡した Response のステータスコードは無視され、第 1 引数の `status` が優先される。意図せず異なるステータスコードを設定すると混乱の原因になる。

```typescript
// Bad: res のステータスと HTTPException のステータスが不一致
throw new HTTPException(400, {
  res: new Response('Not Found', { status: 404 }),  // 404 は無視され 400 になる
})

// Better: 一致させる、または res のステータスを省略
throw new HTTPException(400, {
  res: new Response('Bad Request', { status: 400 }),
})
```

- **onError 内で throw するとアプリ全体がクラッシュする**: カスタム `onError` 内で例外が発生すると、それを捕捉する上位のハンドラがないため、未処理例外としてプロセスに影響する可能性がある。`onError` は最後の防衛線であり、内部で try/catch するべき。

```typescript
// Bad: onError 内で例外が発生しうる
app.onError((err, c) => {
  const data = JSON.parse(err.message)  // パースに失敗する可能性
  return c.json(data, 500)
})

// Better: onError 内で安全に処理
app.onError((err, c) => {
  try {
    const data = JSON.parse(err.message)
    return c.json(data, 500)
  } catch {
    return c.text('Internal Server Error', 500)
  }
})
```

## 自分のプロジェクトへの適用

- [ ] `HTTPException` パターンを参考に、HTTP レスポンスを同梱できるカスタム例外クラスを設計する。ステータスコード + レスポンスヘッダー + ボディを一体管理することで、エラーハンドラの責務を軽減できる
- [ ] デフォルトの errorHandler で duck typing（`'getResponse' in err`）を採用し、サードパーティライブラリのエラーも統一的に処理できるようにする
- [ ] ミドルウェアチェーンのエラー処理を一元化する compose パターンを導入し、各ミドルウェアは throw するだけのシンプルな実装にする
- [ ] `Context is not finalized` のように、よくある開発ミスに対して原因と修正方法を含む具体的なエラーメッセージを設計する
- [ ] 認証ミドルウェアでは `HTTPException` に `WWW-Authenticate` ヘッダーを含む Response を同梱するパターンを採用し、RFC 準拠のエラーレスポンスを返す
