# Error Handling

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono のエラーハンドリングは、`HTTPException` クラスを中心に、ミドルウェアチェーン内での `throw` によるエラー伝播と、`compose` 関数および `app.onError()` によるグローバルキャッチの二層構造で設計されている。特筆すべきは、デフォルトエラーハンドラが `instanceof` ではなくダックタイピング（`'getResponse' in err`）で HTTPException を判定する点と、`HTTPException` が `Response` オブジェクトをそのまま運搬できる設計にある。これにより、認証ミドルウェアが WWW-Authenticate ヘッダー付きレスポンスをエラーに添付して throw するパターンが統一的に実現されている。

## 設計思想

- **throw-based フロー制御**: エラー発生時に `return` ではなく `throw` を使うことで、ミドルウェアチェーンの残りを確実にスキップする。Hono のミドルウェアは koa-compose ベースの `await next()` パターンであるため、throw により下流のミドルウェアと上流の後処理（`await next()` の後のコード）の両方を一度に中断できる。`compose.ts:52-59` で `try/catch` がこれを実現している。

- **Response 運搬パターン — エラーとレスポンスの統合**: `HTTPException` は単なるステータスコード+メッセージではなく、完全な `Response` オブジェクトを `res` オプションで保持できる。これにより、エラーの「意味」（401 Unauthorized）と「表現」（WWW-Authenticate ヘッダー付きレスポンス）を一体で運搬する。認証系ミドルウェアが一様にこのパターンを採用している（`src/middleware/bearer-auth/index.ts:150`, `src/middleware/basic-auth/index.ts:126`）。

- **ダックタイピングによる疎結合**: デフォルトエラーハンドラ（`src/hono-base.ts:36`）は `err instanceof HTTPException` ではなく `'getResponse' in err` で判定する。これによりサードパーティが独自のエラークラスを定義しても、`getResponse()` メソッドさえ実装すれば Hono のエラーハンドリングパイプラインに乗せられる。`HTTPResponseError` インターフェース（`src/types.ts:114-116`）がこの契約を型で表現している。

- **階層的エラーハンドリング — sub-app のエラー分離**: `app.route()` でサブアプリを統合する際、サブアプリが独自の `onError` を持っていれば、そのエラーハンドラが優先される（`src/hono-base.ts:220-227`）。デフォルトのエラーハンドラのままであればハンドラを直接使い、カスタムエラーハンドラがあれば `compose([], app.errorHandler)` でラップする。これによりマイクロサービス的なエラー分離が可能になる。

## 設計・実装の詳細

### HTTPException クラスの構造

`HTTPException` は `Error` を継承し、3つの情報を保持する:

1. **status** (`ContentfulStatusCode`): HTTP ステータスコード。`ContentlessStatusCode`（101, 204, 205, 304）を型レベルで排除しており、エラーレスポンスには必ずボディがあることを保証する
2. **message** (`string`): `Error.message` として継承。`getResponse()` でボディが生成される際のフォールバックテキスト
3. **res** (`Response`): 事前構築されたレスポンス。設定されていれば `getResponse()` はこれをベースに新しい `Response` を生成する

`getResponse()` は `res` が存在する場合、元のレスポンスのボディとヘッダーを引き継ぎつつ、ステータスコードだけは `HTTPException` のものを優先する。テスト（`src/http-exception.test.ts:35-44`）でこの優先順位が検証されている。

### エラー伝播パス

エラーの伝播は以下の経路をたどる:

1. **ハンドラ/ミドルウェアで throw** → `compose` 内の `try/catch`（`src/compose.ts:50-59`）
2. **compose 内の catch** → `onError` が設定されていれば呼び出し、レスポンスを `context.res` に設定（`isError = true`）
3. **compose の外側** → `#dispatch` の `try/catch`（`src/hono-base.ts:446-459`）→ `#handleError`（`src/hono-base.ts:393-398`）
4. **#handleError** → `err instanceof Error` なら `this.errorHandler` を呼び出し。Error でなければ再 throw

単一ハンドラの最適化パス（`src/hono-base.ts:424-442`）でも同じ `#handleError` を使い、同期エラーは `catch` ブロック、非同期エラーは `.catch()` で捕捉する。

### compose のエラーハンドリング

```typescript
// src/compose.ts:49-59
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

重要な点:
- `err instanceof Error` でない場合（文字列や数値を throw した場合）は再 throw され、最終的に `#handleError` で再度チェックされ、Error でなければ未処理例外となる
- `context.error = err` によりエラーオブジェクトがコンテキストに保存され、上流のミドルウェアが `c.error` で参照できる
- `isError = true` により、エラーハンドラが返したレスポンスが既存のレスポンスを上書きできる（`compose.ts:67`）

### デフォルトエラーハンドラ

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

`'getResponse' in err` のダックタイピングにより、`HTTPException` だけでなく、テスト（`src/hono.test.ts` の "Handle HTTPException like object"）で確認される `CustomError` のような任意のエラークラスも処理できる。

### ミドルウェアにおける HTTPException の利用パターン

認証系ミドルウェアは一貫して以下のパターンを採用している:

```typescript
// src/middleware/basic-auth/index.ts:107-127
const status = 401
const headers = {
  'WWW-Authenticate': 'Basic realm="' + options.realm?.replace(/"/g, '\\"') + '"',
}
const res =
  typeof responseMessage === 'string'
    ? new Response(responseMessage, { status, headers })
    : new Response(JSON.stringify(responseMessage), {
        status,
        headers: {
          ...headers,
          'content-type': 'application/json',
        },
      })
throw new HTTPException(status, { res })
```

このパターンの本質は、レスポンスの構築と例外の発行を分離すること:
1. まず目的のレスポンスを完全に構築する（ヘッダー、ボディ、Content-Type を含む）
2. そのレスポンスを `HTTPException` に包んで throw する
3. デフォルトエラーハンドラが `getResponse()` 経由でレスポンスを取り出す

### JWT/JWK ミドルウェアの cause チェーン

```typescript
// src/middleware/jwt/jwt.ts:131-152
let payload
let cause
try {
  payload = await Jwt.verify(token, options.secret, { alg: options.alg, ...verifyOpts })
} catch (e) {
  cause = e
}
if (!payload) {
  throw new HTTPException(401, {
    message: 'Unauthorized',
    res: unauthorizedResponse({ ... }),
    cause,
  })
}
```

検証エラーの原因（`cause`）を `HTTPException` に渡すことで、`Error.cause` の標準チェーンが維持される。カスタム `onError` ハンドラが `err.cause` を参照してデバッグ情報を得られる。

### timeout ミドルウェアのエラー設計

```typescript
// src/middleware/timeout/index.ts:38-58
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
      if (timer !== undefined) { clearTimeout(timer) }
    }
  }
}
```

`Promise.race` でタイムアウトを実装し、`HTTPException` を reject することでミドルウェアチェーンのエラーパスに乗せる。`exception` パラメータが関数を受け付けるのは、タイムアウト時のコンテキスト情報（リクエストパスなど）をエラーメッセージに含めるため。

## パターンカタログ

- **Chain of Responsibility** (振る舞い)
  - 解決する問題: 複数のミドルウェアが順序付きでリクエストを処理し、いずれかがエラーを発生させた時点でチェーンを中断する
  - 適用条件: ミドルウェアパイプラインを持つ Web フレームワーク
  - コード例: `src/compose.ts:32-71`
  - 注意点: `next()` の多重呼び出し防止（`index` 変数による検出、`compose.ts:33-35`）が必要

- **Null Object → Default Handler** (振る舞い)
  - 解決する問題: エラーハンドラが未設定でもフレームワークが安全にレスポンスを返す
  - 適用条件: ユーザーがカスタムハンドラを設定しない場合のフォールバック
  - コード例: `src/hono-base.ts:35-42`（デフォルト errorHandler）, `src/hono-base.ts:31-33`（デフォルト notFoundHandler）
  - 注意点: デフォルトハンドラが `console.error` する設計は本番環境のログ設計と衝突する可能性がある

## Good Patterns

- **Response 同梱 throw パターン**: `HTTPException` にレスポンスオブジェクトを添付して throw することで、エラーの意味（ステータスコード）と表現（ヘッダー・ボディ）を一体で運搬する。これにより、エラーハンドラがエラーの種類ごとにレスポンスを組み立てる責務から解放される。

```typescript
// src/middleware/csrf/index.ts:145-147
const res = new Response('Forbidden', { status: 403 })
throw new HTTPException(403, { res })
```

- **ダックタイピングによるエラー判定**: `instanceof` の代わりに `'getResponse' in err` を使い、プロトタイプチェーンに依存しない柔軟なエラー判定を実現する。異なるパッケージバージョン間での `instanceof` 問題を回避し、サードパーティの拡張を容易にする。

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

- **cause チェーンの維持**: JWT ミドルウェアが検証エラーの原因を `HTTPException` の `cause` に渡すことで、Error.cause の標準チェーンを維持し、デバッグ時に根本原因をたどれるようにしている。

```typescript
// src/middleware/jwt/jwt.ts:138-152
try {
  payload = await Jwt.verify(token, options.secret, { alg: options.alg, ...verifyOpts })
} catch (e) {
  cause = e
}
if (!payload) {
  throw new HTTPException(401, { message: 'Unauthorized', res: unauthorizedResponse({ ... }), cause })
}
```

- **型レベルでの ContentlessStatusCode 排除**: `HTTPException` のステータスコードに `ContentfulStatusCode` 型を使い、204 や 304 といったボディなしステータスを型レベルで除外している。エラーレスポンスには必ずボディがあるべきという不変条件をコンパイル時に保証する。

```typescript
// src/http-exception.ts:46-59
export class HTTPException extends Error {
  readonly res?: Response
  readonly status: ContentfulStatusCode
  constructor(status: ContentfulStatusCode = 500, options?: HTTPExceptionOptions) { ... }
}
```

## Anti-Patterns / 注意点

- **非 Error オブジェクトの throw**: Hono は `err instanceof Error` でない場合を明示的に再 throw する（`compose.ts:57-59`, `hono-base.ts:394-397`）。文字列や数値を throw するとエラーハンドラを完全にバイパスし、未処理例外としてランタイムに到達する。

```typescript
// Bad: エラーハンドラに到達しない
app.get('/bad', () => {
  throw 'something went wrong'  // string を throw
})

// Better: Error を継承したクラスを使う
app.get('/better', () => {
  throw new HTTPException(400, { message: 'something went wrong' })
})
```

- **getResponse() のステータスコード不一致**: `HTTPException` に渡す `res` のステータスコードと `status` 引数が異なる場合、`getResponse()` は `status` 引数を優先する。意図しない場合はバグの原因になる（テスト `src/http-exception.test.ts:35-44` でこの挙動が検証されている）。

```typescript
// Bad: 200 レスポンスを渡しているが、400 として返される
throw new HTTPException(400, {
  res: new Response('OK', { status: 200 })  // status: 200 は無視される
})

// Better: ステータスコードを一致させる
throw new HTTPException(400, {
  res: new Response('Bad Request', { status: 400 })
})
```

- **カスタム onError 内での HTTPException 未処理**: カスタム `onError` を設定すると、デフォルトの `getResponse()` 呼び出しがバイパスされる。HTTPException の `res` に含まれるカスタムヘッダー（WWW-Authenticate 等）を意図せず失う危険がある。

```typescript
// Bad: HTTPException の res を無視してしまう
app.onError((err, c) => {
  return c.text(err.message, 500)  // WWW-Authenticate ヘッダーが失われる
})

// Better: HTTPException を明示的にハンドルする
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse()
  }
  return c.text('Internal Server Error', 500)
})
```

## 導出ルール

> このセクションは必須。synthesis-writer が rules.md 生成時に参照する。

- `[MUST]` カスタムエラークラスは標準の `Error` を継承し、`throw` で利用する。非 Error オブジェクトの throw はフレームワークのエラーハンドリングパイプラインをバイパスする
  - 根拠: `compose.ts:53` で `err instanceof Error` チェックがあり、Error でなければ `onError` が呼ばれず再 throw される

- `[MUST]` HTTP エラーレスポンスにカスタムヘッダーやボディが必要な場合、レスポンスオブジェクトをエラーに同梱して throw する。エラーハンドラ内でのレスポンス再構築を避ける
  - 根拠: bearer-auth, basic-auth, csrf, jwt, jwk の全認証ミドルウェアが `new HTTPException(status, { res })` パターンを統一的に採用している

- `[MUST]` カスタム `onError` ハンドラを設定する場合、`HTTPException`（または `getResponse()` を持つエラー）を明示的に処理する分岐を含める。デフォルトハンドラの挙動が上書きされるため
  - 根拠: `hono-base.ts:35-42` のデフォルトハンドラが `'getResponse' in err` で分岐しており、カスタムハンドラはこの処理を自前で行う必要がある

- `[SHOULD]` エラーの原因チェーンを `cause` オプションで維持する。低レベルのエラー（JWT 検証失敗など）を握りつぶさず、`Error.cause` の標準メカニズムで伝播させる
  - 根拠: `jwt.ts:138-152` と `jwk.ts:144-161` が catch したエラーを `cause` として HTTPException に渡し、デバッグ時のトレーサビリティを確保している

- `[SHOULD]` エラーのプロトコル判定にはダックタイピング（`'method' in obj`）を使い、`instanceof` への依存を避ける。異なるパッケージバージョンやバンドラー環境での互換性が向上する
  - 根拠: `hono-base.ts:36` が `'getResponse' in err` で判定し、`HTTPResponseError` インターフェース（`types.ts:114-116`）がこの契約を型で表現している

- `[SHOULD]` エラーレスポンスのステータスコード型にボディなしステータス（204, 304 等）を除外する型制約を設ける。エラーレスポンスには説明ボディが必ず存在すべきだから
  - 根拠: `HTTPException` が `ContentfulStatusCode`（`ContentlessStatusCode` を `Exclude` した型）を使い、コンパイル時に不正なステータスコードを防いでいる

- `[AVOID]` グローバルエラーハンドラ内での `console.error` をデフォルト動作とすること。本番環境では構造化ログや外部サービスへの送信が必要であり、`console.error` は開発時のフォールバックに留める
  - 根拠: `hono-base.ts:40` のデフォルトハンドラが `console.error(err)` を行うが、カスタムハンドラの設定が推奨されている

## 適用チェックリスト

- [ ] カスタムエラークラスが `Error` を継承しており、文字列や数値を throw していないか確認する
- [ ] HTTP エラーに対してカスタムヘッダー（WWW-Authenticate 等）が必要な場合、レスポンスオブジェクトをエラーに同梱する設計になっているか
- [ ] カスタム `onError`/エラーハンドラを設定している場合、フレームワーク固有のエラー型（`getResponse()` を持つエラー等）を明示的に処理する分岐があるか
- [ ] エラーの原因チェーン（`Error.cause`）が途切れずに維持されているか。特に外部ライブラリのエラーを catch して再 throw する箇所
- [ ] エラークラスの判定に `instanceof` を使っている箇所がある場合、異なるパッケージバージョンやモノレポ環境で問題が起きないか検討したか
- [ ] デフォルトのエラーハンドラ（`console.error` + `500 Internal Server Error`）を本番環境向けにカスタマイズしているか
- [ ] エラーレスポンスのステータスコードに 204 や 304 といったボディなしステータスを使っていないか
