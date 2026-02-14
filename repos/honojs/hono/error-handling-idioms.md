# エラーハンドリングイディオム

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono のエラーハンドリングは、単一の `HTTPException` クラスを中心に設計されたフラットな例外モデルを採用している。サブクラスによる型階層を作らず、HTTP ステータスコードとオプションの `Response` オブジェクトを組み合わせることで、ミドルウェアチェーン全体を貫通する一貫したエラー伝播を実現している。ゼロ依存・Web Standards 準拠という制約のもと、Error クラスのネイティブ `cause` プロパティと koa-compose 由来の try-catch 伝播を活用し、最小限のAPIで表現力の高いエラーハンドリングを提供する設計が注目に値する。

## 背景にある原則

- **フラット例外モデル**: サブクラスではなくコンストラクタ引数（ステータスコード + オプション）で例外を分類すべき。なぜなら、HTTP エラーの多様性はステータスコードで十分に表現でき、型階層はミドルウェアチェーンでの `instanceof` 判定を複雑にするため。Hono は `HTTPException` 一つだけを提供し、middleware 全体で統一的にハンドリングしている（`src/http-exception.ts:46-78`）。

- **Response 同梱の原則**: 例外が最終的にクライアントに返す Response を自身で持つべき。エラーハンドラが Response を組み立てるのではなく、例外の発生元が最も適切な Response を知っているため。`HTTPException` の `res` オプションにより、認証ミドルウェアが `WWW-Authenticate` ヘッダ付きの Response を例外に添付できる（`src/middleware/jwt/jwt.ts:85-92`）。

- **エラー伝播の透過性**: ミドルウェアチェーンのエラーは `compose` 関数の try-catch で捕捉され、`onError` ハンドラに委譲される。Error 以外のオブジェクトが throw された場合は再 throw して上位に伝播させ、予期しないエラーを隠蔽しない（`src/compose.ts:52-59`、`src/hono-base.ts:393-398`）。

- **設定時 vs リクエスト時のエラー分離**: ミドルウェアの設定不備（必須オプション未指定等）は通常の `Error` で即座に throw し、リクエスト処理中の失敗は `HTTPException` で throw する。前者はアプリ起動時に、後者はリクエストハンドリング時にそれぞれ適切なタイミングで検出される（`src/middleware/jwt/jwt.ts:64-74` vs `src/middleware/jwt/jwt.ts:85-92`）。

## 実例と分析

### HTTPException の設計とステータスコード駆動分類

`HTTPException` は `Error` を継承し、`status`（`ContentfulStatusCode` 型）と `res`（オプショナルな `Response`）を保持する。`getResponse()` メソッドは `res` が提供されていればそれを使い、なければ `message` からフォールバック Response を生成する。この二段構えにより、シンプルな用途（メッセージだけ）と高度な用途（カスタムヘッダ付き Response）の両方を 1 クラスでカバーしている。

ステータスコードは TypeScript の `ContentfulStatusCode` 型で制約されており、101/204/205/304 のようなボディを持てないステータスコードを除外している。これにより型レベルで不正なエラーレスポンスの生成を防いでいる。

### ミドルウェアでの throw パターン

コードベース全体で、ミドルウェアは異常系を `throw new HTTPException(status, options)` で表現している。return ではなく throw を使うことで、以降のミドルウェアチェーンを即座に中断し、`compose` の catch ブロックまたは `onError` ハンドラにフロー制御を委ねる。

認証系ミドルウェア（basic-auth, bearer-auth, jwt, jwk）は全て同じパターンを踏襲しており、Response を構築してから `HTTPException` に渡している。このパターンにより、認証プロトコル固有のレスポンスヘッダ（`WWW-Authenticate` 等）をエラーレスポンスに含めることができる。

### compose 関数でのエラー捕捉と伝播

`compose` 関数は koa-compose に基づくミドルウェア実行エンジンであり、各ハンドラの実行を try-catch で囲んでいる。捕捉されたエラーが `Error` のインスタンスかつ `onError` ハンドラが存在する場合のみハンドリングし、それ以外は再 throw する。これにより、文字列やオブジェクトの throw（非標準的な使い方）はデフォルトでは処理されず、開発者に修正を促す設計になっている。

### デフォルト errorHandler の duck typing

`hono-base.ts` のデフォルト `errorHandler` は `err instanceof HTTPException` ではなく `'getResponse' in err` で判定している。これにより、`HTTPException` を直接継承しなくても `getResponse()` メソッドを持つカスタムエラーオブジェクトがハンドリングされる。テストでも `CustomError` クラスで検証されている（`src/hono.test.ts:1464-1482`）。

### c.error によるポスト処理エラーハンドリング

`Context` オブジェクトの `error` プロパティは、`compose` 関数内でエラーが発生した際に設定される。上流のミドルウェアが `await next()` の後に `c.error` を検査することで、下流で発生したエラーに対するポスト処理（ログ記録、レスポンス書き換え等）が可能になる。`body-limit` ミドルウェアはこのパターンを使い、ストリーム読み取り中に発生した `BodyLimitError` をチェックしている。

### サブアプリのエラースコープ分離

`route()` メソッドでサブアプリを接続する際、サブアプリが独自の `errorHandler` を持つ場合、そのハンドラは `compose` でラップされてサブアプリ内のエラーに限定して適用される。親アプリの `errorHandler` は親アプリスコープのエラーのみをハンドリングする（`src/hono-base.ts:220-232`）。

## コード例

```typescript
// src/http-exception.ts:46-78
// フラット例外モデル: サブクラスなし、コンストラクタ引数で分類
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

```typescript
// src/compose.ts:49-59
// ミドルウェアチェーンでのエラー捕捉: Error インスタンスのみハンドリング
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

```typescript
// src/hono-base.ts:35-42
// デフォルト errorHandler: duck typing で getResponse を呼ぶ
const errorHandler: ErrorHandler = (err, c) => {
  if ('getResponse' in err) {
    const res = err.getResponse()
    return c.newResponse(res.body, res)
  }
  console.error(err)
  return c.text('Internal Server Error', 500)
}
```

```typescript
// src/middleware/jwt/jwt.ts:64-74 vs 85-92
// 設定時エラー（通常の Error）
if (!options || !options.secret) {
  throw new Error('JWT auth middleware requires options for "secret"')
}

// リクエスト時エラー（HTTPException + Response 同梱）
throw new HTTPException(401, {
  message: errDescription,
  res: unauthorizedResponse({
    ctx,
    error: 'invalid_request',
    errDescription,
  }),
})
```

```typescript
// src/middleware/body-limit/index.ts:18-23, 121-123
// ドメイン固有のエラークラスとポスト処理パターン
class BodyLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BodyLimitError'
  }
}

// await next() 後に c.error で判定
await next()
if (c.error instanceof BodyLimitError) {
  c.res = await onError(c)
}
```

```typescript
// src/middleware/timeout/index.ts:12-14, 38-57
// タイムアウトミドルウェア: HTTPException を Promise.race で reject に使う
const defaultTimeoutException = new HTTPException(504, {
  message: 'Gateway Timeout',
})

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

## パターンカタログ

- **Chain of Responsibility** (分類: 振る舞い)
  - 解決する問題: 複数のミドルウェアがエラーを順番に処理する必要がある
  - 適用条件: リクエスト→レスポンスのパイプラインで、エラーが発生した位置から上流に伝播させたい場合
  - コード例: `src/compose.ts:32-71` — `dispatch` 関数がミドルウェアチェーンを再帰的に呼び出し、エラーを上流に伝播
  - 注意点: `next()` 後の後処理でエラーを検査する場合は `c.error` を使う必要がある

- **Null Object** (分類: 振る舞い)
  - 解決する問題: デフォルトのエラーハンドラ・NotFound ハンドラが未設定でも動作する
  - 適用条件: ユーザーがカスタムハンドラを登録しなくても合理的なデフォルト動作を提供したい場合
  - コード例: `src/hono-base.ts:31-42` — `notFoundHandler` と `errorHandler` のデフォルト実装
  - 注意点: デフォルトの errorHandler は `console.error` で出力するため、本番環境では上書きを推奨

## Good Patterns

- **Response 同梱 HTTPException**: 認証ミドルウェアが `WWW-Authenticate` ヘッダ等を含むカスタム Response を HTTPException に渡すことで、エラーハンドラが Response の詳細を知らなくてもプロトコル準拠のレスポンスを返せる。

```typescript
// src/middleware/bearer-auth/index.ts:140-150
const res =
  typeof responseMessage === 'string'
    ? new Response(responseMessage, { status, headers })
    : new Response(JSON.stringify(responseMessage), {
        status,
        headers: { ...headers, 'content-type': 'application/json' },
      })
throw new HTTPException(status, { res })
```

- **cause チェーンによるエラートレーサビリティ**: `HTTPException` のコンストラクタが `Error` のネイティブ `cause` オプションを活用し、元のエラーを保持する。JWT 検証失敗時に検証ライブラリの元エラーを `cause` として渡すことで、デバッグ時にエラーの根本原因を辿れる。

```typescript
// src/middleware/jwt/jwt.ts:131-152
let cause
try {
  payload = await Jwt.verify(token, options.secret, { alg: options.alg, ...verifyOpts })
} catch (e) {
  cause = e
}
if (!payload) {
  throw new HTTPException(401, {
    message: 'Unauthorized',
    res: unauthorizedResponse({ ctx, error: 'invalid_token', ... }),
    cause,
  })
}
```

- **getResponse の duck typing**: デフォルト errorHandler が `instanceof` ではなく `'getResponse' in err` で判定することで、外部ライブラリが HTTPException を継承せずともハンドリング可能にしている。

```typescript
// src/hono-base.ts:35-39
const errorHandler: ErrorHandler = (err, c) => {
  if ('getResponse' in err) {
    const res = err.getResponse()
    return c.newResponse(res.body, res)
  }
  // ...
}
```

## Anti-Patterns / 注意点

- **非 Error オブジェクトの throw**: Hono の `compose` は `err instanceof Error` でガードしているため、文字列やオブジェクトを throw すると `onError` ハンドラに到達せず、未処理例外として再 throw される。テストでも明示的に検証されている（`src/hono.test.ts:1364-1378`）。

```typescript
// Bad: onError ハンドラに到達しない
app.get('/error-string', () => {
  throw 'This is Error'  // Error インスタンスではない
})

// Better: 必ず Error インスタンスを throw する
app.get('/error', () => {
  throw new Error('This is Error')
})
// または HTTP エラーなら HTTPException を使う
app.get('/error', () => {
  throw new HTTPException(400, { message: 'Bad Request' })
})
```

- **エラーハンドラ内での例外未処理**: `onError` ハンドラ内で例外が発生すると、それ自体が `#handleError` で処理されるが、さらにそこで `Error` インスタンスでなければ未処理になる。エラーハンドラは堅牢に書く必要がある。

```typescript
// Bad: エラーハンドラ内で例外を発生させうる
app.onError((err, c) => {
  const data = JSON.parse(err.message) // err.message が JSON でなければ例外
  return c.json(data, 500)
})

// Better: エラーハンドラ内でも防御的に書く
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse()
  }
  return c.text(err.message || 'Internal Server Error', 500)
})
```

## 導出ルール

- `[MUST]` HTTP レイヤーのエラーは専用の HTTP 例外クラスで throw し、ステータスコードを必ず含める
  - 根拠: Hono は全ミドルウェアで `HTTPException(status, options)` を使い、`compose` の catch ブロックで統一的にハンドリングしている（`src/compose.ts:52-59`）

- `[MUST]` ミドルウェアチェーン内で throw するオブジェクトは必ず `Error` のインスタンスにする
  - 根拠: `compose` は `err instanceof Error` で判定しており、非 Error オブジェクトは `onError` に到達せず再 throw される（`src/compose.ts:53`、`src/hono.test.ts:1377-1378`）

- `[SHOULD]` 例外オブジェクトにクライアント向けのレスポンスを同梱し、エラーハンドラが Response の詳細を知らなくても済むようにする
  - 根拠: 認証ミドルウェア群が `HTTPException` の `res` オプションに `WWW-Authenticate` ヘッダ付き Response を渡すことで、デフォルト errorHandler がプロトコル準拠のレスポンスを返せている（`src/middleware/jwt/jwt.ts:85-92`）

- `[SHOULD]` 例外の `cause` にオリジナルのエラーを保持し、エラーチェーンのトレーサビリティを確保する
  - 根拠: JWT/JWK ミドルウェアが検証ライブラリの例外を `cause` に渡し、HTTPException でラップしてもデバッグ時に根本原因を辿れるようにしている（`src/middleware/jwt/jwt.ts:138-152`）

- `[SHOULD]` 設定時エラー（必須オプション未指定等）とリクエスト時エラー（認証失敗等）を異なるエラー型で分離する
  - 根拠: JWT ミドルウェアは設定不備を通常の `Error` で即 throw し、リクエスト処理中の失敗を `HTTPException` で throw することで、起動時とランタイムのエラーを明確に分離している（`src/middleware/jwt/jwt.ts:64-74` vs `121-129`）

- `[SHOULD]` デフォルトの errorHandler を duck typing で実装し、特定の例外クラスへの依存を避ける
  - 根拠: `'getResponse' in err` による判定で、HTTPException を継承しないカスタムエラーも統一的にハンドリングでき、テストでも検証されている（`src/hono-base.ts:36`、`src/hono.test.ts:1464-1482`）

- `[AVOID]` エラー型の深い継承階層を作ること。HTTP エラーはステータスコード + オプションの組み合わせで十分に分類できる
  - 根拠: Hono は 21 ファイルで `HTTPException` を使用しているが、サブクラスは一つも存在しない。唯一の例外は `BodyLimitError` で、これは `HTTPException` ではなく `Error` の直接サブクラスであり、ミドルウェア内部のフロー制御専用である（`src/middleware/body-limit/index.ts:18-23`）

## 適用チェックリスト

- [ ] プロジェクトに HTTP 例外クラスが存在し、ステータスコードとオプショナルな Response を保持しているか
- [ ] ミドルウェアチェーンで throw されるオブジェクトが全て `Error` のインスタンスであることを保証しているか
- [ ] エラー型がフラットな構造か（深い継承階層になっていないか）
- [ ] 認証エラー等のプロトコル固有レスポンスが、エラーハンドラではなく例外の発生元で組み立てられているか
- [ ] 例外の `cause` プロパティを活用してオリジナルのエラーを保持しているか
- [ ] 設定時エラー（起動時に検出すべきもの）とリクエスト時エラー（ランタイムで発生するもの）が区別されているか
- [ ] デフォルトの errorHandler が合理的なフォールバックレスポンスを返すようになっているか
- [ ] サブアプリ・サブルーターのエラースコープが親アプリと分離されているか
