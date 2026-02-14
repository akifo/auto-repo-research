# Client RPC

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono の `hc()` は、サーバー側のルート定義から型安全な RPC クライアントを自動生成する仕組みである。`typeof app` をジェネリクスに渡すだけで、パス・メソッド・リクエストボディ・レスポンス型がすべて推論される。Proxy ベースの軽量実装でありながら、TypeScript の型システムを限界まで活用した設計が注目に値する。

## 設計・実装の詳細

### Proxy によるパスチェーン構築

クライアントの核心は `createProxy` 関数にある。JavaScript の `Proxy` を再帰的に生成し、プロパティアクセスをパスセグメントとして蓄積する。最終的にメソッド呼び出し（`$get()`, `$post()` 等）が行われた時点で、蓄積されたパスからURLを構築してfetchを実行する。

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

`key === 'then'` のチェックは、Proxy が Promise として解決されることを防ぐためのガードである。これにより `await client` のようなコードが副作用なく動作する。

### $メソッドプレフィックスによるメソッド識別

クライアント側の HTTP メソッドは `$get`, `$post`, `$put` のように `$` プレフィックスが付く。callback 内で `$` を検出・除去してメソッド名を抽出する。

```typescript
// src/client/client.ts:158-164
let method = ''
if (/^\$/.test(lastParts[0] as string)) {
  const last = parts.pop()
  if (last) {
    method = last.replace(/^\$/, '')
  }
}
```

`$url` と `$ws` は特別なメソッドとして分岐処理される。`$url` はリクエストを発行せず URL オブジェクトを返し、`$ws` は WebSocket 接続を確立する。

### 型レベルでのスキーマ変換パイプライン

サーバー側のルート定義は以下のパイプラインで型情報に変換される:

1. **`ToSchema`**: 各ルートハンドラの登録時に `Method + Path + Input + Output` を `Schema` 型に変換
2. **`MergeSchemaPath`**: `app.route('/api', subApp)` 時にサブアプリのスキーマのパスにプレフィックスを付与
3. **`PathToChain`**: スラッシュ区切りのパスをネストされたオブジェクト型に変換（`/api/posts` → `{ api: { posts: ... } }`）
4. **`ClientRequest`**: 各エンドポイントに対応するメソッド（`$get`, `$post` 等）と引数型・戻り値型を生成

```typescript
// src/types.ts:2242-2246
export type Schema = {
  [Path: string]: {
    [Method: `$${Lowercase<string>}`]: Endpoint
  }
}
```

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

### ClientRequest の引数オプショナリティ制御

`HasRequiredKeys` を使い、入力パラメータの有無に応じて引数をオプショナルにするか必須にするかを型レベルで制御している。

```typescript
// src/client/types.ts:67-79
export type ClientRequest<Prefix extends string, Path extends string, S extends Schema> = {
  [M in keyof ExpandAllMethod<S>]: ExpandAllMethod<S>[M] extends Endpoint & { input: infer R }
    ? R extends object
      ? HasRequiredKeys<R> extends true
        ? (
            args: R,
            options?: ClientRequestOptions
          ) => Promise<ClientResponseOfEndpoint<ExpandAllMethod<S>[M]>>
        : (
            args?: R,
            options?: ClientRequestOptions
          ) => Promise<ClientResponseOfEndpoint<ExpandAllMethod<S>[M]>>
      : never
    : never
}
```

バリデータで必須パラメータを定義したルートでは引数が必須に、パラメータなしのルートでは引数がオプショナルになる。

### ステータスコード別のレスポンス型絞り込み

`ClientResponse` は `status` プロパティのリテラル型と `ok` プロパティの条件型を持ち、`if (res.status === 200)` や `if (res.ok)` で TypeScript の制御フロー分析によりレスポンス型が絞り込まれる。

```typescript
// src/client/types.ts:113-137
export interface ClientResponse<
  T,
  U extends number = StatusCode,
  F extends ResponseFormat = ResponseFormat,
> extends globalThis.Response {
  ok: U extends SuccessStatusCode
    ? true
    : U extends Exclude<StatusCode, SuccessStatusCode>
      ? false
      : boolean
  status: U
  json(): F extends 'text' ? Promise<never> : F extends 'json' ? Promise<T> : Promise<unknown>
  text(): F extends 'text' ? (T extends string ? Promise<T> : Promise<never>) : Promise<string>
}
```

### ExpandAllMethod による app.all() サポート

`app.all()` で登録されたルートは内部的に `$all` メソッドとしてスキーマに記録される。`ExpandAllMethod` 型がこれを全 HTTP メソッドに展開する。

```typescript
// src/client/types.ts:24-26
type ExpandAllMethod<S> = MethodNameAll extends keyof S
  ? { [M in StandardMethods]: S[MethodNameAll] } & Omit<S, MethodNameAll>
  : S
```

### parseResponse による簡易レスポンス処理

`parseResponse` は fetch レスポンスを自動的にパースし、エラー時には `DetailedError` を throw する。Content-Type ヘッダーから `json` か `text` を判定し、適切なメソッドで消費する。型レベルではエラーステータスコードのレスポンスを除外した型を返す。

```typescript
// src/client/utils.ts:89-114
// @example const result = await parseResponse(client.posts.$get())
export async function parseResponse<T extends ClientResponse<any>>(
  fetchRes: T | Promise<T>
): Promise<
  FilterClientResponseByStatusCode<
    T,
    Exclude<ContentfulStatusCode, ClientErrorStatusCode | ServerErrorStatusCode>
  > extends never
    ? undefined
    : FilterClientResponseByStatusCode<...> extends ClientResponse<infer RT, infer _, infer RF>
      ? RF extends 'json' ? RT : RT extends string ? RT : string
      : undefined
>
```

## コード例

### 基本的な使い方: サーバー定義からクライアント生成

```typescript
// src/client/client.test.ts:26-67
const route = app
  .post(
    '/posts',
    validator('cookie', () => {
      return {} as { debug: string }
    }),
    validator('header', () => {
      return {} as { 'x-message': string }
    }),
    validator('json', () => {
      return {} as { id: number; title: string }
    }),
    (c) => {
      return c.json({
        success: true,
        message: 'dummy',
        // ...
      })
    }
  )

type AppType = typeof route
const client = hc<AppType>('http://localhost', { headers: { 'x-hono': 'hono' } })

// 型安全な呼び出し — json, header, cookie すべてが型チェックされる
const res = await client.posts.$post({
  json: { id: 123, title: 'Hello! Hono!' },
  header: { 'x-message': 'foobar' },
  cookie: { debug: 'true' },
})
```

### app.route() によるスキーママージ

```typescript
// src/client/client.test.ts:593-600
const api = new Hono<Env>().get('/search', (c) => c.json({ ok: true }))
const app = new Hono<Env>().route('/api', api)
type AppType = typeof app
const client = hc<AppType>('http://localhost')
const res = await client.api.search.$get()
const data = await res.json()
// data.ok は true 型として推論される
```

### ステータスコードによる型の絞り込み

```typescript
// src/client/client.test.ts:994-1014
const req = await client.posts.$post({ json: { title: 'hello' } })
// req.status は 200 | 400 | 401 のユニオン型

if (req.status === 200) {
  const data = await req.json()
  // data は { title: string } 型
} else if (req.status === 400) {
  const data = await req.json()
  // data は { error: 'Bad request' } 型
} else if (req.status === 401) {
  const data = await req.json()
  // data は { error: 'Unauthorized' } 型
}
```

### InferResponseType / InferRequestType によるユーティリティ型推論

```typescript
// src/client/client.test.ts:479-498
const client = hc<AppType>('/')
const req = client.index.$get

type ResponseData = InferResponseType<typeof req>
// { id: number; title: string }

type ResponseData200 = InferResponseType<typeof req, 200>
// ステータスコード 200 のレスポンスのみに絞り込み

type RequestData = InferRequestType<typeof req>
// { query: { name: string; age: string }; header: { 'x-request-id': string }; cookie: { name: string } }
```

### app.request をカスタム fetch として使用（テスト向け）

```typescript
// src/client/client.test.ts:774-780
const app = new Hono().get('/search', (c) => c.json({ ok: true }))
type AppType = typeof app
const client = hc<AppType>('', { fetch: app.request })
const res = await client.search.$get()
// 実際の HTTP リクエストなしでテスト可能
```

## Good Patterns

- **Proxy による宣言的パスチェーン**: ランタイムコードを最小限に抑えつつ、型情報はコンパイル時に完全に解決される。Proxy の `get` トラップでパスを蓄積し、`apply` トラップでリクエストを発行するシンプルな二段構成。ランタイムのオーバーヘッドがほぼゼロである。

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
      return callback({ path, args })
    },
  })
  return proxy
}
```

- **型レベルの条件分岐による引数オプショナリティ**: `HasRequiredKeys` を使い、バリデータが必須パラメータを定義している場合のみ引数を必須にする。開発者が不要なときに空オブジェクトを渡す必要がなくなる。

- **ステータスコードリテラル型によるナローイング**: `ClientResponse` の `status` と `ok` プロパティにリテラル型を持たせることで、標準的な `if` 文による型の絞り込みが自然に機能する。エラーハンドリングの型安全性を追加コードなしで実現している。

- **`$` プレフィックスによる名前空間の分離**: HTTP メソッド呼び出しに `$get`, `$post` のように `$` を付けることで、パスセグメント（`client.api.posts`）とメソッド呼び出し（`.$get()`）の名前空間が衝突しない。

- **カスタム fetch による差し替え可能性**: `hc()` のオプションで `fetch` 関数を差し替えられる。`app.request` を渡すことで E2E テストなしにクライアント呼び出しをテストでき、MSW 等のモックとの併用も容易。

## Anti-Patterns / 注意点

- **ルート定義の型エクスポート忘れ**: `hc<T>` はサーバー側の `typeof app` (正確にはルートチェーンの戻り値) を型パラメータとして受け取る。ルート定義をチェーンせずに別々の変数に分割すると、型情報が失われる。

```typescript
// Bad: 型情報が分断される
const app = new Hono()
app.get('/users', (c) => c.json({ users: [] }))
app.post('/users', (c) => c.json({ created: true }))
type AppType = typeof app // Schema が空になる

// Better: メソッドチェーンで型を蓄積する
const app = new Hono()
const route = app
  .get('/users', (c) => c.json({ users: [] }))
  .post('/users', (c) => c.json({ created: true }))
type AppType = typeof route // 全ルートの型が保持される
```

- **Date オブジェクトの JSON シリアライゼーション**: `c.json()` で Date オブジェクトを返すと、クライアント側では `string` 型として推論される。これは JSON のシリアライズ仕様に正しく従った挙動だが、サーバー側で Date を使っていると混乱しやすい。

```typescript
// src/client/client.test.ts:689-697
const route = app.get('/api/foo', (c) => c.json({ datetime: new Date() }))
const client = hc<AppType>('http://localhost')
const res = await client.api.foo.$get()
const { datetime } = await res.json()
// datetime は string 型（Date ではない）
```

- **BigInt の非対応**: BigInt は `JSON.stringify` でシリアライズできないため、`c.json()` に直接渡すとランタイムエラーになる。型レベルでは `never` として推論される。`toJSON()` メソッドを持つラッパーを使う必要がある。

## 自分のプロジェクトへの適用

- [ ] Hono サーバーのルート定義をメソッドチェーンで構築し、`typeof route` を `hc<T>` に渡す RPC パターンを導入する
- [ ] `InferResponseType<typeof req, StatusCode>` を活用し、ステータスコード別のエラーハンドリングを型安全に実装する
- [ ] テスト時に `hc('', { fetch: app.request })` を使い、HTTP レイヤーをスキップした高速なインテグレーションテストを構築する
- [ ] `parseResponse` を利用してレスポンスの自動パース＋エラー時の構造化例外スローを統一的に行う
- [ ] Proxy + 型推論パターンを参考に、自プロジェクトの API クライアントラッパーに応用する（パスの型安全性、引数のオプショナリティ制御）
