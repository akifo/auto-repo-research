# client-rpc

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono の `hc` クライアントは、サーバー側のルート定義から型安全な RPC クライアントを自動導出する仕組みである。`app.get('/api/posts', ...)` と定義すれば `client.api.posts.$get()` として型付きで呼び出せる。注目に値するのは、コード生成やスキーマ定義ファイルを一切必要とせず、TypeScript の型推論だけで サーバー → クライアントの型伝搬を実現している点である。ランタイムコードは Proxy ベースの約 220 行に過ぎず、型の重労働はすべてコンパイル時に行われる。

## 設計思想

- **型情報はサーバー定義から一方向に流す**: サーバー側ハンドラの戻り値型（`c.json(...)` の引数）とバリデータの入力型が `ToSchema` を通じて `Schema` 型パラメータに蓄積され、クライアント側は `Client<T>` でその型を参照するだけ。IDL（Interface Definition Language）や共有スキーマファイルは存在しない。根拠: `hc<T extends Hono<any, any, any>>` が Hono インスタンスの型を直接受け取る設計（`src/client/client.ts:130`）。

- **ランタイムとコンパイルタイムの責務を分離する**: ランタイムでは `Proxy` がパスセグメントを配列に蓄積し、`$get` 等のメソッド呼び出しで HTTP リクエストを発行するだけ。型安全性はすべてコンパイルタイムの型レベル計算（`PathToChain`, `ClientRequest`, `Client`）が担う。このため、ランタイムオーバーヘッドはほぼゼロである。根拠: `createProxy` 関数はパスの蓄積と `callback` の呼び出ししか行わない（`src/client/client.ts:15-31`）。

- **メソッドチェインで型を累積する**: `app.get(path, handler)` の戻り値型は `HonoBase<E, S & ToSchema<...>, BasePath>` であり、`S` に新しいスキーマが intersection (`&`) で追加される。チェイン呼び出しのたびに型が成長し、最終的な `typeof app` がすべてのルート情報を保持する。根拠: `HandlerInterface` の各オーバーロードの戻り値型（`src/types.ts:143-147`）。

- **パスリテラル型をオブジェクトのネスト構造に変換する**: `PathToChain` 型が `/api/posts/:id` のようなパス文字列を `{ api: { posts: { ':id': ClientRequest<...> } } }` に再帰的に変換する。これにより、ドットアクセスで URL パスを表現できる。根拠: `PathToChain` の再帰的定義（`src/client/types.ts:275-290`）。

## 設計・実装の詳細

### Schema 蓄積メカニズム

Hono のルート定義は、型レベルで `Schema` 型を累積的に構築する。核心は以下の流れ:

1. **ハンドラの戻り値からの型抽出**: `c.json({ ok: true })` は `Response & TypedResponse<{ ok: true }, 200, 'json'>` を返す。`TypedResponse` はブランド型で、実際のレスポンスオブジェクトに `_data`, `_status`, `_format` のファントムプロパティを付与する（ランタイムには存在しない）。

2. **`MergeTypedResponse` による正規化**: ハンドラの戻り値が `Promise<TypedResponse>` でも直接 `TypedResponse` でも、`MergeTypedResponse` が統一的に `TypedResponse` を抽出する。

3. **`ToSchema` による構造化**: メソッド名 `M`、パス `P`、入力型 `I`、レスポンス型 `RorO` を受け取り、`{ [Path]: { [$method]: Endpoint } }` 構造に変換する。メソッド名には `AddDollar` で `$` プレフィクスが付与される（`get` → `$get`）。

4. **intersection による累積**: チェイン呼び出しごとに `S & ToSchema<...>` で型が成長する。TypeScript の intersection 型は同一キーをマージするため、異なるパスのスキーマが1つの `Schema` 型に統合される。

### PathToChain 型 — パスからオブジェクト構造への変換

```typescript
// src/client/types.ts:275-290
type PathToChain<
  Prefix extends string,
  Path extends string,
  E extends Schema,
  Original extends string = Path,
> = Path extends `/${infer P}`
  ? PathToChain<Prefix, P, E, Path>
  : Path extends `${infer P}/${infer R}`
    ? { [K in P]: PathToChain<Prefix, R, E, Original> }
    : {
        [K in Path extends '' ? 'index' : Path]: ClientRequest<
          Prefix,
          Original,
          E extends Record<string, unknown> ? E[Original] : never
        >
      }
```

この再帰型は3段階で動作する:
1. 先頭スラッシュの除去（`/api/posts` → `api/posts`）
2. スラッシュで分割し、各セグメントをオブジェクトのキーにネスト化（`api/posts` → `{ api: { posts: ... } }`）
3. 末端セグメントに `ClientRequest` を配置。空パスは `'index'` に変換

### Client 型 — Hono インスタンスからクライアント型への変換

```typescript
// src/client/types.ts:292-299
export type Client<T, Prefix extends string> =
  T extends HonoBase<any, infer S, any>
    ? S extends Record<infer K, Schema>
      ? K extends string
        ? PathToChain<Prefix, K, S>
        : never
      : never
    : never
```

`Client<T>` は `HonoBase` から `S`（Schema）を抽出し、各パス `K` に対して `PathToChain` を適用する。複数パスが存在する場合、それぞれが union 型となるため、`hc` 関数の戻り値で `UnionToIntersection<Client<T, Prefix>>` として intersection に変換される（`src/client/client.ts:217`）。これにより、すべてのパスのプロパティが1つのオブジェクト型に統合される。

### Proxy によるランタイム実装

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

プロパティアクセス（`get` trap）のたびに新しい Proxy を生成し、パスセグメントを配列に蓄積する。関数呼び出し（`apply` trap）でコールバックが実行され、蓄積されたパスから URL を構築して fetch する。`key === 'then'` のチェックは、Promise の自動アンラップを防ぐために必要（await 時に `.then` が呼ばれるため）。

### `$` プレフィクス規約

クライアント側のメソッド名は `$get`, `$post`, `$url`, `$ws` のように `$` プレフィクスが付く。ランタイムでは正規表現 `/^\$/` でこのプレフィクスを検出し、HTTP メソッドとして処理する（`src/client/client.ts:159-164`）。型レベルでは `AddDollar<T> = \`$${Lowercase<T>}\`` で変換される。この規約はパスセグメント名との衝突を避ける設計判断である。

### HasRequiredKeys による引数の省略可能性制御

```typescript
// src/client/types.ts:67-80
export type ClientRequest<Prefix extends string, Path extends string, S extends Schema> = {
  [M in keyof ExpandAllMethod<S>]: ExpandAllMethod<S>[M] extends Endpoint & { input: infer R }
    ? R extends object
      ? HasRequiredKeys<R> extends true
        ? (args: R, options?: ClientRequestOptions) => Promise<ClientResponseOfEndpoint<...>>
        : (args?: R, options?: ClientRequestOptions) => Promise<ClientResponseOfEndpoint<...>>
      : never
    : never
}
```

入力型に必須キーがあるかどうかで、第一引数の必須/省略可能が切り替わる。バリデータで `query` を定義すればクライアント側で必須引数になり、定義しなければ省略可能になる。

### InferResponseType / InferRequestType — ユーティリティ型

```typescript
// src/client/types.ts:232-252
export type InferResponseType<T, U extends StatusCode = StatusCode> =
  InferResponseTypeFromEndpoint<InferEndpointType<T>, U>

export type InferRequestType<T> = T extends (
  args: infer R,
  options: any | undefined
) => Promise<ClientResponse<unknown>>
  ? NonNullable<R>
  : never
```

`InferResponseType` はステータスコードでフィルタリング可能であり、`InferResponseType<typeof req, 200>` で成功時のレスポンス型だけを抽出できる。これにより、SWR や TanStack Query と組み合わせて型安全なデータフェッチが実現できる。

### ExpandAllMethod — app.all() の展開

```typescript
// src/client/types.ts:24-26
type ExpandAllMethod<S> = MethodNameAll extends keyof S
  ? { [M in StandardMethods]: S[MethodNameAll] } & Omit<S, MethodNameAll>
  : S
```

`app.all()` で定義されたルートは `$all` キーでスキーマに格納されるが、クライアント側では `$all` を公開せず、すべての標準 HTTP メソッド（`$get`, `$post`, `$put`, `$delete`, `$options`, `$patch`）に展開する。

## コード例

### サーバー側: Schema の累積的構築

```typescript
// src/client/client.test.ts:593-601
const api = new Hono<Env>().get('/search', (c) => c.json({ ok: true }))
const app = new Hono<Env>().route('/api', api)
type AppType = typeof app
const client = hc<AppType>('http://localhost')
const res = await client.api.search.$get()
const data = await res.json()
// data.ok は boolean ではなく true (リテラル型) として推論される
```

### ステータスコード別レスポンス型の推論

```typescript
// src/client/client.test.ts:870-908
const app = new Hono().get('/', async (c) => {
  const ok = condition()
  if (ok) {
    return c.json({ data: 'foo' }, 200)
  }
  if (!ok) {
    return c.json({ message: 'error' }, 400)
  }
  return c.json(null)
})

type AppType = typeof app
const client = hc<AppType>('', { fetch: app.request })
// InferResponseType<typeof req> → { data: string } | { message: string } | null
// InferResponseType<typeof req, 200> → { data: string } | null
```

### ミドルウェアからのレスポンス型推論

```typescript
// src/client/client.test.ts:911-960
const app = new Hono()
  .post(
    '/posts',
    async (c, next) => {
      const auth = c.req.header('authorization')
      if (!auth || !auth.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' as const }, 401)
      }
      return next()
    },
    validator('json', (input, c) => {
      if (!input.title) {
        return c.json({ error: 'Bad request' as const }, 400)
      }
      return input as { title: string }
    }),
    (c) => {
      const data = c.req.valid('json')
      return c.json(data, 200)
    }
  )

// InferResponseType<typeof req, 200> → { title: string }
// InferResponseType<typeof req, 400> → { error: 'Bad request' }
// InferResponseType<typeof req, 401> → { error: 'Unauthorized' }
```

## パターンカタログ

- **Proxy パターン** (分類: 構造)
  - 解決する問題: URL パス構造をオブジェクトのプロパティアクセスとして表現する必要がある
  - 適用条件: アクセスされるプロパティが動的であり、事前にすべてのパスを列挙できない場合
  - コード例: `src/client/client.ts:15-31`
  - 注意点: `then` プロパティへのアクセスを `undefined` として処理しないと、`await` 時に無限ループになる

- **Phantom Type（ファントム型）** (分類: 型レベル)
  - 解決する問題: ランタイム値を変えずにコンパイルタイムの型情報を付与する必要がある
  - 適用条件: レスポンスの `output`, `status`, `format` を型レベルで追跡したいが、ランタイムの Response オブジェクトは標準のまま使いたい場合
  - コード例: `src/types.ts:2346-2358`（`TypedResponse` の `_data`, `_status`, `_format`）
  - 注意点: ファントムプロパティはランタイムに存在しないため、直接アクセスするとエラーになる

- **Builder パターンの型レベル応用** (分類: 生成)
  - 解決する問題: メソッドチェインの各ステップで型情報を蓄積し、最終的な型を構築する
  - 適用条件: 流暢な API（fluent API）を提供しつつ、各ステップの型情報を保持したい場合
  - コード例: `src/types.ts:128-148`（`HandlerInterface` の戻り値 `S & ToSchema<...>`）
  - 注意点: チェインが長くなると TypeScript コンパイラの負荷が増大する

## Good Patterns

- **Union → Intersection 変換によるパス統合**: 複数パスの `PathToChain` 結果は union 型になるが、`UnionToIntersection` で intersection に変換することで、すべてのパスが1つのオブジェクト型に統合される。これにより `client.api.posts.$get()` と `client.api.users.$get()` が同一オブジェクトからアクセスできる。

```typescript
// src/client/client.ts:217
) as UnionToIntersection<Client<T, Prefix>>
```

- **ステータスコードによるレスポンス型の絞り込み**: `InferResponseType<T, 200>` のように第2型引数でステータスコードを指定でき、成功/エラーレスポンスを型レベルで分離できる。これはフロントエンドの状態管理ライブラリとの統合に有用。

```typescript
// src/client/types.ts:232-244
export type InferResponseType<T, U extends StatusCode = StatusCode> =
  InferResponseTypeFromEndpoint<InferEndpointType<T>, U>
```

- **`HasRequiredKeys` による引数省略制御**: バリデータが定義されていないエンドポイントでは引数を省略可能にし、定義されていれば必須にする。DX と型安全性の両立。

```typescript
// src/client/types.ts:70-78
HasRequiredKeys<R> extends true
  ? (args: R, options?: ClientRequestOptions) => ...
  : (args?: R, options?: ClientRequestOptions) => ...
```

## Anti-Patterns / 注意点

- **`typeof app` を取らずに型を失う**: `hc` は型引数 `T` として Hono インスタンスの型を受け取るが、ルート定義の結果を変数に保持せずに `typeof app` を取ると、チェインで蓄積された `Schema` 型が失われる。

```typescript
// Bad: app の型にルート定義が含まれない
const app = new Hono()
app.get('/api', (c) => c.json({ ok: true }))
const client = hc<typeof app>('/')  // client は型情報なし

// Better: チェインの結果を保持する
const app = new Hono().get('/api', (c) => c.json({ ok: true }))
const client = hc<typeof app>('/')  // client.api.$get() が型付きで利用可能
```

- **ハンドラの戻り値型を `Response` にキャストする**: `c.json()` の戻り値を `as Response` でキャストすると `TypedResponse` のファントム型情報が消失し、クライアント側で型が推論できなくなる。

```typescript
// Bad: TypedResponse 情報が消失
app.get('/api', (c) => {
  return c.json({ ok: true }) as Response
})

// Better: キャストせず TypedResponse を維持
app.get('/api', (c) => {
  return c.json({ ok: true })
})
```

## 導出ルール

- `[MUST]` 型安全 RPC を実現する際、サーバー側の型情報は一方向に流し、共有スキーマファイルへの依存を避ける
  - 根拠: Hono は `typeof app` だけでクライアント型を導出しており、IDL やコード生成が不要なため保守コストが低い（`src/client/client.ts:130`）

- `[MUST]` メソッドチェインで型を累積する API では、チェインの戻り値型を `S & NewSchema` のように intersection で拡張し、途中結果の型情報を保持する
  - 根拠: `HandlerInterface` がすべてのオーバーロードで `S & ToSchema<...>` を返すことで、ルート定義の型情報が欠落しない（`src/types.ts:145`）

- `[SHOULD]` ランタイムの動的振る舞い（Proxy）とコンパイルタイムの型安全性を分離し、ランタイムコードを最小限に保つ
  - 根拠: `createProxy` は約 15 行で、型の複雑さはすべて `types.ts` に閉じ込められている（`src/client/client.ts:15-31`）

- `[SHOULD]` URL パスをオブジェクトのネスト構造に変換する際、テンプレートリテラル型の再帰的分割を使い、パスセグメントごとにプロパティ化する
  - 根拠: `PathToChain` がスラッシュ区切りでパスを再帰分割し、末端に `ClientRequest` を配置する設計（`src/client/types.ts:275-290`）

- `[SHOULD]` レスポンス型はステータスコードで絞り込み可能にし、エラーハンドリングの型安全性を確保する
  - 根拠: `InferResponseType<T, 200>` により成功時のレスポンス型のみを抽出可能（`src/client/types.ts:232-244`）

- `[AVOID]` メソッドチェインの結果を変数に保持せず、後から型を取得しようとすること（型情報が蓄積されない）
  - 根拠: `app.get(...)` の戻り値を捨てると `Schema` 型パラメータが更新されず、`typeof app` が空のスキーマになる

- `[AVOID]` Proxy ベースの動的クライアントで `then` プロパティを通常のパスセグメントとして処理すること
  - 根拠: `await` 演算子が `.then` を呼ぶため、`undefined` を返さないと無限ループになる（`src/client/client.ts:18-19`）

## 適用チェックリスト

- [ ] サーバー側のルート定義がメソッドチェインで型を累積する設計になっているか
- [ ] ハンドラの戻り値型がファントム型（TypedResponse 相当）で output / status / format を保持しているか
- [ ] クライアント型の導出に共有スキーマファイルやコード生成が不要な構造になっているか
- [ ] URL パスからオブジェクト構造への変換にテンプレートリテラル型の再帰分割を使っているか
- [ ] レスポンス型がステータスコードで絞り込み可能か（成功/エラーの型分離）
- [ ] Proxy の `get` trap で `then` プロパティを `undefined` として処理しているか
- [ ] `UnionToIntersection` で複数パスの型を1つのオブジェクトに統合しているか
- [ ] 入力の必須/省略可能が `HasRequiredKeys` 相当の仕組みで自動判定されているか
