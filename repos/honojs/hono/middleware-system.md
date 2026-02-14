# middleware-system

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono のミドルウェアシステムは、Koa の `koa-compose` に由来する onion 型（タマネギ型）の合成モデルを採用している。`compose` 関数はわずか 73 行で、再帰的な `dispatch` 関数を使い、ミドルウェアチェーン全体を単一の非同期関数に合成する。`next()` の呼び出しが制御の分岐点となり、リクエストの前処理と後処理を一つの関数内で記述できる点が最大の特徴である。この設計は 25 の組み込みミドルウェアすべてに一貫して適用されており、ミドルウェアの合成可能性（composability）を最優先に設計されたアーキテクチャとして注目に値する。

## 設計思想

- **合成可能性の最大化**: `compose` の戻り値自体がミドルウェアと同じシグネチャ `(context, next?) => Promise<Context>` を満たすため、合成結果を再び合成に入力できる。テストでも `compose w/ other compositions` として検証されている（`src/compose.test.ts:626-649`）。この再帰的合成可能性により、`every`/`some`/`except` のような高階ミドルウェアが `compose` を内部で再利用して構築されている。

- **単一 Context による状態共有**: ミドルウェアチェーン全体で同一の `Context` オブジェクトを共有し、追加のイベントバスやメッセージングを必要としない。`context.set()` / `context.get()` による型安全な変数の受け渡しと、`context.res` への Response 設定という 2 つの通信チャネルのみに限定することで、暗黙的な結合を防いでいる。

- **最小限の抽象 -- ゼロオーバーヘッド志向**: 単一ハンドラの場合は `compose` を呼ばずに直接実行する最適化が `hono-base.ts:424-442` に実装されている。また `compose` 自体も配列のコピーやイテレータを使わず、インデックスベースの再帰で実装されており、ランタイムのアロケーションを最小化している。

- **フェイル・ファスト + グレースフル・デグラデーション**: `next()` の二重呼び出しは即座に例外を投げる（`compose.ts:33-35`）一方、ハンドラのエラーは `onError` コールバックで回復可能としている。未到達のハンドラ（`next()` を呼ばないミドルウェアの後続）は `onNotFound` に委譲される。この 3 段階の制御により、開発者のミスは早期検出しつつ、ランタイムエラーはユーザーに適切なレスポンスを返す。

## 設計・実装の詳細

### compose 関数の実行モデル

`compose` は、ミドルウェア配列を受け取り、クロージャで `index` 変数をキャプチャした `dispatch` 関数を返す。`dispatch(0)` から開始し、各ミドルウェアが `next()` を呼ぶと `dispatch(i + 1)` が実行される。

```
dispatch(0) → middleware[0](ctx, () => dispatch(1))
                  ↓ await next()
              dispatch(1) → middleware[1](ctx, () => dispatch(2))
                                ↓ await next()
                            dispatch(2) → middleware[2](ctx, () => dispatch(3))
                                              ↓ (no more middleware)
                                          onNotFound or return
                            ← post-processing of middleware[2]
              ← post-processing of middleware[1]
          ← post-processing of middleware[0]
```

この再帰構造が onion 型を実現する。`await next()` より前がリクエストの下り（inbound）処理、後がレスポンスの上り（outbound）処理となる。

### next() の二重呼び出し防止

`index` 変数が「これまでに到達した最大の dispatch インデックス」を記録する。`dispatch(i)` の先頭で `i <= index` なら、同じまたは前のステップに戻ろうとしていることを意味し、即座にエラーを投げる。

### レスポンスの確定メカニズム（finalized フラグ）

`Context.res` への setter が呼ばれると `finalized = true` が設定される（`src/context.ts:404-424`）。`compose` 内では、レスポンスが返された場合かつ `context.finalized === false` の場合のみ `context.res` を更新する（`compose.ts:67-69`）。これにより、先に Response を確定したミドルウェアの結果が、後のミドルウェアによって意図せず上書きされることを防ぐ。ただし `isError` 時はエラーハンドラの結果で上書きを許可する。

### 単一ハンドラ最適化

`hono-base.ts:424` で `matchResult[0].length === 1` の場合、`compose` を呼ばず直接ハンドラを実行する。同期ハンドラの場合は Promise を生成せず、非同期の場合のみ `.then().catch()` チェーンを使う。これにより、ミドルウェアなしの単純なルートでは不要なオーバーヘッドを完全に排除する。

### combine: ミドルウェアの論理合成

`src/middleware/combine/index.ts` は `compose` を基盤として、ミドルウェアの論理結合を提供する:

- **`every(...middlewares)`**: 全ミドルウェアを `compose` で直列実行。一つでもエラーを投げれば全体がエラーになる（AND 結合）
- **`some(...middlewares)`**: 先頭から順に試行し、最初に成功したミドルウェアを採用する（OR 結合）
- **`except(condition, ...middlewares)`**: 条件に一致する場合はスキップ、それ以外は `every` で実行。`some` と `every` の組み合わせで実装

`every` は内部で `compose` を直接呼び出し、`routeIndex` を保存・復元することでパラメータ解決が壊れないようにしている。

## コード例

### compose 関数の全体（73 行の核心）

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

### onion 型の実行順序を証明するテスト

```typescript
// src/compose.test.ts:363-401
it('should get executed order one by one', async () => {
  const arr: number[] = []
  stack.push(
    buildMiddlewareTuple(async (_context: Context, next: Next) => {
      arr.push(1)
      await next()
      arr.push(6)
    })
  )
  stack.push(
    buildMiddlewareTuple(async (_context: Context, next: Next) => {
      arr.push(2)
      await next()
      arr.push(5)
    })
  )
  stack.push(
    buildMiddlewareTuple(async (_context: Context, next: Next) => {
      arr.push(3)
      await next()
      arr.push(4)
    })
  )
  await compose(stack)(new Context(new Request('http://localhost/')))
  expect(arr).toEqual([1, 2, 3, 4, 5, 6])
})
```

### logger ミドルウェア -- onion 型の典型パターン

```typescript
// src/middleware/logger/index.ts:81-95
export const logger = (fn: PrintFunc = console.log): MiddlewareHandler => {
  return async function logger(c, next) {
    const { method, url } = c.req
    const path = url.slice(url.indexOf('/', 8))
    await log(fn, LogPrefix.Incoming, method, path)
    const start = Date.now()
    await next()
    await log(fn, LogPrefix.Outgoing, method, path, c.res.status, time(start))
  }
}
```

### 単一ハンドラ最適化

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
    ? res
        .then(
          (resolved: Response | undefined) =>
            resolved || (c.finalized ? c.res : this.#notFoundHandler(c))
        )
        .catch((err: Error) => this.#handleError(err, c))
    : (res ?? this.#notFoundHandler(c))
}
```

## パターンカタログ

- **Chain of Responsibility** (分類: 振る舞い)
  - 解決する問題: リクエスト処理を複数のハンドラに分離し、各ハンドラが処理を続行するか中断するかを決定する
  - 適用条件: 複数の横断的関心事（認証、ロギング、エラー処理等）を順序付けて適用する必要がある場合
  - コード例: `src/compose.ts:49-51` -- `await handler(context, () => dispatch(i + 1))` で次のハンドラへの委譲を明示的に制御
  - 注意点: 古典的な Chain of Responsibility は「処理できるハンドラが見つかったら終了」だが、Hono の onion 型は `next()` により後続への委譲と復帰後の処理の両方を可能にする拡張版

- **Decorator** (分類: 構造)
  - 解決する問題: ハンドラの前後に振る舞いを追加する
  - 適用条件: レスポンスヘッダの追加（powered-by, CORS）、レスポンスの変換（ETag, compress）等
  - コード例: `src/middleware/etag/index.ts:84-123` -- `await next()` の後にレスポンスを検査し ETag ヘッダを追加・304 に変換
  - 注意点: ミドルウェアがデコレータとして機能するには、`await next()` を必ず呼ぶ必要がある

- **Composite** (分類: 構造)
  - 解決する問題: 複数のミドルウェアを一つのミドルウェアとして扱う
  - 適用条件: 条件付きミドルウェア適用、ミドルウェアのグルーピング
  - コード例: `src/middleware/combine/index.ts:99-117` -- `every` が `compose` を使ってミドルウェア配列を単一ミドルウェアに合成
  - 注意点: `routeIndex` の保存・復元が必要（パラメータ解決のコンテキストが狂うため）

## Good Patterns

- **Factory 関数パターンによるミドルウェア生成**: 全 25 の組み込みミドルウェアが、オプションを受け取って `MiddlewareHandler` を返す factory 関数として実装されている。これにより設定のクロージャキャプチャ、遅延初期化、型安全なオプション検証が統一的に行える。

```typescript
// src/middleware/cors/index.ts:63-73
export const cors = (options?: CORSOptions): MiddlewareHandler => {
  const defaults: CORSOptions = {
    origin: '*',
    allowMethods: ['GET', 'HEAD', 'PUT', 'POST', 'DELETE', 'PATCH'],
    allowHeaders: [],
    exposeHeaders: [],
  }
  const opts = { ...defaults, ...options }
  // findAllowOrigin を一度だけ構築（クロージャキャプチャ）
  const findAllowOrigin = ((optsOrigin) => { /* ... */ })(opts.origin)
  return async function cors(c, next) { /* ... */ }
}
```

- **名前付き関数式によるデバッグ容易性**: ミドルウェアは `return async function logger(c, next) { ... }` のように名前付き関数式で返される。スタックトレースにミドルウェア名が表示されるため、デバッグが容易になる。

```typescript
// src/middleware/body-limit/index.ts:68
return async function bodyLimit(c, next) { /* ... */ }
// src/middleware/bearer-auth/index.ts:153
return async function bearerAuth(c, next) { /* ... */ }
```

- **HTTPException による早期中断**: 認証ミドルウェアは検証失敗時に `HTTPException` を throw し、`next()` を呼ばずにチェーンを中断する。`HTTPException` は `getResponse()` メソッドを持ち、エラーハンドラが Response に変換できる。

```typescript
// src/middleware/bearer-auth/index.ts:150
throw new HTTPException(status, { res })
// src/hono-base.ts:36-41 -- エラーハンドラで getResponse を利用
if ('getResponse' in err) {
  const res = err.getResponse()
  return c.newResponse(res.body, res)
}
```

- **contextStorage による AsyncLocalStorage 活用**: `await asyncLocalStorage.run(c, next)` の一行で、ミドルウェアチェーン内の任意の深さから `getContext()` でコンテキストにアクセスできる。onion 型の `next()` が AsyncLocalStorage のスコープと自然に整合する好例。

```typescript
// src/middleware/context-storage/index.ts:43-47
export const contextStorage = (): MiddlewareHandler => {
  return async function contextStorage(c, next) {
    await asyncLocalStorage.run(c, next)
  }
}
```

## Anti-Patterns / 注意点

- **next() の await 忘れ**: `next()` は `Promise<void>` を返す。`await` なしで呼ぶと、後続ミドルウェアの完了を待たずに後処理が実行され、onion 型の実行順序が崩れる。

```typescript
// Bad: レスポンスが確定する前に後処理が走る
const bad: MiddlewareHandler = async (c, next) => {
  next() // await なし
  c.res.headers.set('X-After', 'value') // next() の完了前に実行される
}

// Better: await で順序を保証する
const good: MiddlewareHandler = async (c, next) => {
  await next()
  c.res.headers.set('X-After', 'value') // 後続の処理がすべて完了してから実行
}
```

- **next() の呼び忘れによるチェーン中断**: ミドルウェアが `next()` を呼ばないと後続のミドルウェアやハンドラが実行されない。意図的な中断（認証失敗等）以外では必ず `await next()` を呼ぶ必要がある。`compose.test.ts:403-438` のテストで、`next()` を呼ばないミドルウェアの後の処理がスキップされることが検証されている。

```typescript
// Bad: 意図せず後続を遮断
const bad: MiddlewareHandler = async (c, next) => {
  c.set('data', 'value')
  // next() を呼び忘れ -- 後続ハンドラが実行されない
}

// Better: 前処理後に next() で委譲
const good: MiddlewareHandler = async (c, next) => {
  c.set('data', 'value')
  await next()
}
```

- **finalized 後のレスポンス上書き**: `context.res` への代入で `finalized = true` が設定された後、別のミドルウェアが再度 `context.res` に代入すると、先のレスポンスが失われる。`compose` は `finalized === false` のときのみ自動設定するが、明示的な代入は保護されない。

```typescript
// Bad: 後処理で無条件にレスポンスを上書き
const bad: MiddlewareHandler = async (c, next) => {
  await next()
  c.res = new Response('overwritten') // 先行ミドルウェアの結果を破壊
}

// Better: finalized を確認してから操作
const good: MiddlewareHandler = async (c, next) => {
  await next()
  // レスポンスヘッダの追加は安全（bodyは変更しない）
  c.res.headers.set('X-Custom', 'value')
}
```

## 導出ルール

> このセクションは必須。最低 3 個のルールを記載すること。synthesis-writer が rules.md 生成時に参照する。

- `[MUST]` onion 型ミドルウェアでは `next()` の戻り値を必ず `await` すること
  - 根拠: `await` なしでは後続ミドルウェアの完了を待たず後処理が実行され、レスポンスの変更やエラーハンドリングが正しく動作しない（`compose.test.ts:363-401` で実行順序 `[1,2,3,4,5,6]` が保証される前提）

- `[MUST]` ミドルウェア合成関数（compose）は `next()` の二重呼び出しを検出して例外を投げること
  - 根拠: Hono の `compose.ts:33-35` は `index` の単調増加をチェックし、二重呼び出しで即座にエラーを投げる。これがないと同じミドルウェアの再実行やレスポンスの二重送信が発生する

- `[SHOULD]` ミドルウェアファクトリは設定をクロージャにキャプチャし、リクエストごとの再計算を避けること
  - 根拠: Hono の全組み込みミドルウェア（cors, bearer-auth 等）がこのパターンを採用し、正規表現のコンパイルやオプションのマージを初期化時に一度だけ行っている（`src/middleware/bearer-auth/index.ts:114-117`）

- `[SHOULD]` 単一ハンドラのケースでは合成をバイパスし、直接実行する最適化を実装すること
  - 根拠: `hono-base.ts:424-442` で `matchResult[0].length === 1` の場合に `compose` をスキップし、同期ハンドラでは Promise 生成すら回避している

- `[SHOULD]` ミドルウェアの返却関数には名前付き関数式を使い、スタックトレースでの識別を容易にすること
  - 根拠: Hono の全ミドルウェアが `return async function middlewareName(c, next) { ... }` パターンを採用（`logger/index.ts:82`, `bearerAuth/index.ts:153` 等）

- `[AVOID]` ミドルウェア内で `context.res` を無条件に上書きすること。ヘッダ追加は安全だが、body やステータスの変更は `finalized` 状態を確認すべき
  - 根拠: `context.ts:404-424` で `set res` が `finalized = true` を設定するため、先行ミドルウェアの結果を意図せず破壊するリスクがある

- `[AVOID]` ミドルウェアチェーンの中断を暗黙的に行うこと。中断する場合は `HTTPException` を throw するか、Response を return して意図を明示すべき
  - 根拠: `next()` を呼ばないだけの暗黙的中断は、後続ハンドラの未実行が検出しづらい。Hono の認証ミドルウェアは全て `HTTPException` による明示的中断を採用している（`bearer-auth/index.ts:150`）

## 適用チェックリスト

- [ ] ミドルウェアの `next()` が全箇所で `await` されているか確認する
- [ ] compose 関数に `next()` の二重呼び出し検出（インデックスの単調増加チェック）を実装しているか
- [ ] ミドルウェアファクトリがリクエスト時ではなく初期化時にオプションを処理しているか
- [ ] 単一ハンドラ最適化（compose バイパス）を実装し、ベンチマークで効果を確認したか
- [ ] エラー中断に `HTTPException` 相当のメカニズム（ステータスコードとレスポンスを持つ例外）を用意しているか
- [ ] ミドルウェアの返却関数に名前を付けてスタックトレースの可読性を確保しているか
- [ ] レスポンスの確定状態（finalized 相当のフラグ）を管理し、意図しない上書きを防いでいるか
- [ ] ミドルウェアの論理合成（every/some/except 相当）が必要な箇所を洗い出したか
