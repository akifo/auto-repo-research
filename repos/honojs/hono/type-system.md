# type-system

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono の型システムは、ルート定義からクライアントコードまでをエンドツーエンドで型安全に繋ぐ仕組みである。ルートハンドラで定義したパス・入力・出力の型情報がスキーマ型として蓄積され、それを RPC クライアント（`hc`）が自動的に導出する。TypeScript の Template Literal Types、Conditional Types、メソッドオーバーロードを駆使しており、フレームワークレベルの型安全 API 設計の参考になる。

## 設計・実装の詳細

### 1. 型の全体アーキテクチャ

Hono の型システムは以下の層で構成される:

1. **基盤型**（`Env`, `Input`, `Schema`, `Endpoint`）-- アプリケーション全体の型コンテキスト
2. **パス型**（`MergePath`, `ParamKeys`, `ParamKeyToRecord`）-- URL パスからのパラメータ抽出
3. **ハンドラインターフェース**（`HandlerInterface`, `MiddlewareHandlerInterface`）-- メソッドオーバーロードによる型推論
4. **スキーマ変換型**（`ToSchema`, `MergeSchemaPath`, `ExtractSchema`）-- ルート定義からスキーマ型への変換
5. **レスポンス型**（`TypedResponse`, `JSONParsed`）-- レスポンス形式の型安全な表現
6. **クライアント型**（`Client`, `PathToChain`, `ClientRequest`）-- スキーマからクライアント API への自動導出

### 2. Env 型によるコンテキスト伝搬

`Env` 型はアプリケーション全体の型コンテキストを定義する。`Bindings`（環境変数等）と `Variables`（リクエストスコープの変数）を持ち、Context オブジェクト経由で型安全にアクセスできる。

```typescript
// src/types.ts:31-34
export type Env = {
  Bindings?: Bindings
  Variables?: Variables
}
```

ミドルウェアチェーンでは `IntersectNonAnyTypes` を使って複数の `Env` 型を合成する。これにより、ミドルウェアが追加した変数をハンドラ側で型安全に参照できる。

```typescript
// src/types.ts:2473-2476
type ProcessHead<T> = IfAnyThenEmptyObject<T extends Env ? (Env extends T ? {} : T) : T>
export type IntersectNonAnyTypes<T extends any[]> = T extends [infer Head, ...infer Rest]
  ? ProcessHead<Head> & IntersectNonAnyTypes<Rest>
  : {}
```

`ProcessHead` は `any` 型のフィルタリングを行う。`Env extends T` のチェックによって、`T` が `Env` そのもの（デフォルト値、つまり未指定）の場合は空オブジェクトに変換し、余計な型合成を防ぐ。

### 3. メソッドオーバーロードによるハンドラ型推論

`HandlerInterface` はハンドラの個数（1〜10個）と path 引数の有無で約 20 種類のオーバーロードを定義している。これにより、TypeScript はハンドラチェーンの各段階で正確な型推論を行う。

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

各オーバーロードの戻り値は `HonoBase` にスキーマ型 `S` を蓄積して返す。これにより、メソッドチェーンでルートを追加するたびにスキーマが成長する。

### 4. パス型のテンプレートリテラル操作

`MergePath` は2つのパス文字列を結合する再帰的条件型で、先頭/末尾のスラッシュの重複や空文字列を正しく処理する。

```typescript
// src/types.ts:2321-2335
export type MergePath<A extends string, B extends string> = B extends ''
  ? MergePath<A, '/'>
  : A extends ''
    ? B
    : A extends '/'
      ? B
      : A extends `${infer P}/`
        ? B extends `/${infer Q}`
          ? `${P}/${Q}`
          : `${P}/${B}`
        : B extends `/${infer Q}`
          ? Q extends ''
            ? A
            : `${A}/${Q}`
          : `${A}/${B}`
```

`ParamKeys` はパス文字列からパラメータキーを再帰的に抽出する。`:id{[0-9]+}?` のようなパターン付き・オプショナルパラメータにも対応している。

```typescript
// src/types.ts:2409-2419
type ParamKey<Component> = Component extends `:${infer NameWithPattern}`
  ? NameWithPattern extends `${infer Name}{${infer Rest}`
    ? Rest extends `${infer _Pattern}?`
      ? `${Name}?`
      : Name
    : NameWithPattern
  : never

export type ParamKeys<Path> = Path extends `${infer Component}/${infer Rest}`
  ? ParamKey<Component> | ParamKeys<Rest>
  : ParamKey<Path>
```

### 5. TypedResponse とスキーマ蓄積

`TypedResponse` はファントム型（`_data`, `_status`, `_format`）を使ってレスポンスの型情報をコンパイル時に保持する。実行時には通常の `Response` オブジェクトだが、型レベルではデータ型・ステータスコード・フォーマットを追跡する。

```typescript
// src/types.ts:2346-2358
export type TypedResponse<
  T = unknown,
  U extends StatusCode = StatusCode,
  F extends ResponseFormat = T extends string
    ? 'text'
    : T extends JSONValue
      ? 'json'
      : ResponseFormat,
> = {
  _data: T
  _status: U
  _format: F
}
```

`c.json()` の戻り値は `Response & TypedResponse<JSONParsed<T>, U, 'json'>` となり、`JSONParsed` によって `Date` は `string` に、`undefined` プロパティは除外される等、`JSON.stringify` の実際の挙動を型レベルで模倣する。

```typescript
// src/context.ts:200-203
type JSONRespondReturn<
  T extends JSONValue | {} | InvalidJSONValue,
  U extends ContentfulStatusCode,
> = Response & TypedResponse<JSONParsed<T>, U, 'json'>
```

### 6. ToSchema によるルート定義の型変換

`ToSchema` はハンドラの情報（HTTPメソッド、パス、入力、出力）をスキーマ型に変換する。各ルートの `app.get('/path', handler)` 呼び出しごとに `S & ToSchema<...>` で型が蓄積される。

```typescript
// src/types.ts:2211-2240
export type ToSchema<
  M extends string,
  P extends string,
  I extends Input | Input['in'],
  RorO,
> =
  IsAny<RorO> extends true
    ? { [K in P]: { [K2 in M as AddDollar<K2>]: { ... } } }
    : [RorO] extends [never]
      ? {}
      : [RorO] extends [Promise<void>]
        ? {}
        : { [K in P]: { [K2 in M as AddDollar<K2>]: Simplify<{ input: ... } & ToSchemaOutput<RorO, I>> } }
```

`[RorO] extends [never]` のようにタプルでラップしてチェックしているのは、TypeScript の distributive conditional types を回避するためである。

### 7. RPC クライアントの型導出

`hc<typeof app>(baseUrl)` で呼び出されるクライアントは、`Client<T, Prefix>` 型によってサーバーのスキーマから自動導出される。

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

`PathToChain` はパス文字列をオブジェクトのネスト構造に変換する。`/api/users/:id` は `client.api.users[':id']` のようなチェーン呼び出しに対応する。

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

クライアントの実装は `Proxy` で動的にパスを構築し、最終的に `$get()`, `$post()` 等のメソッド呼び出しで fetch を実行する。型は `ClientResponse<O, S, F>` として返り、`.json()` の戻り値型もサーバーのレスポンス型と一致する。

### 8. バリデーターの型統合

`validator()` 関数はバリデーション対象（`json`, `form`, `query`, `param`, `header`, `cookie`）と検証関数を受け取り、検証結果の型を `Input` の `in` / `out` に自動的にマッピングする。

```typescript
// src/validator/validator.ts:46-88
export const validator = <
  InputType,
  P extends string,
  M extends string,
  U extends ValidationTargetByMethod<M>,
  ...
  V extends {
    in: { [K in U]: K extends 'json' ? ... : InferInput<ExtractValidatorOutput<VF>, K, FormValue> }
    out: { [K in U]: ExtractValidatorOutput<VF> }
  } = ...,
>(
  target: U,
  validationFunc: VF
): MiddlewareHandler<E, P, V, ExtractValidationResponse<VF>>
```

`ValidationTargetByMethod` は HTTP メソッドに応じて利用可能なバリデーション対象を制限する。GET/HEAD リクエストではボディ系（`form`, `json`）のバリデーションが型レベルで禁止される。

```typescript
// src/validator/validator.ts:10-12
type ValidationTargetByMethod<M> = M extends 'get' | 'head'
  ? Exclude<keyof ValidationTargets, ValidationTargetKeysWithBody>
  : keyof ValidationTargets
```

### 9. 型パフォーマンスの CI 計測

`perf-measures/type-check/` に 200 ルートを自動生成するスクリプトがあり、PR ごとに `tsc --diagnostics` の結果を CI で計測している。`tsc` と `typescript-go` の両方で計測し、octocov でメインブランチとの比較を自動化している。

```typescript
// perf-measures/type-check/scripts/generate-app.ts:6-17
const generateRoutes = (count: number) => {
  let routes = `import { Hono } from '../../../src'
export const app = new Hono()`
  for (let i = 1; i <= count; i++) {
    routes += `
  .get('/route${i}/:id', (c) => {
    return c.json({
      ok: true
    })
  })`
  }
  return routes
}
```

## コード例

### ルート定義からクライアントまでの型フロー

```typescript
// サーバー側: ルート定義
const app = new Hono()
  .get('/users/:id', (c) => {
    const id = c.req.param('id')  // 型: string
    return c.json({ id, name: 'Alice' })
  })

// クライアント側: 型が自動導出される
const client = hc<typeof app>('http://localhost')
const res = await client.users[':id'].$get({ param: { id: '1' } })
const data = await res.json()  // 型: { id: string; name: string }
```

### ミドルウェアによる Env 拡張

```typescript
// src/types.test.ts:29-48
type E = {
  Variables: { foo: string }
  Bindings: { FLAG: boolean }
}
const app = new Hono<E>()
app.get('/', (c) => {
  const foo = c.get('foo')     // 型: string
  const FLAG = c.env.FLAG      // 型: boolean
  return c.text('foo')
})
```

### バリデーターとの連携

```typescript
// src/types.test.ts:58-89
const middleware: MiddlewareHandler<
  Env,
  '/',
  { in: { json: Payload }; out: { json: Payload } }
> = async (_c, next) => { await next() }

app.get(middleware, (c) => {
  const data = c.req.valid('json')  // 型: Payload
  return c.json({ message: 'Hello!' })
})
```

## Good Patterns

- **ファントム型による型情報の伝搬**: `TypedResponse` は `_data`, `_status`, `_format` というファントムフィールドで型情報を保持する。実行時コストゼロでコンパイル時の型安全性を実現している。フレームワークが返す `Response` オブジェクトの中身を型レベルで追跡する手法として汎用性が高い。

```typescript
// src/types.ts:2346-2358
export type TypedResponse<T = unknown, U extends StatusCode = StatusCode, F extends ResponseFormat = ...> = {
  _data: T
  _status: U
  _format: F
}
```

- **any のフィルタリング（`IsAny` / `IfAnyThenEmptyObject`）**: TypeScript の型システムでは `any` が伝搬しやすい。Hono は `IsAny` で `any` を検出し、`IfAnyThenEmptyObject` で無害化する。ミドルウェアチェーンの `IntersectNonAnyTypes` で `any` な Env を空オブジェクトに変換することで、型情報の汚染を防いでいる。

```typescript
// src/utils/types.ts:21
export type IfAnyThenEmptyObject<T> = 0 extends 1 & T ? {} : T

// src/utils/types.ts:110
export type IsAny<T> = boolean extends (T extends never ? true : false) ? true : false
```

- **JSON 直列化の型模倣（`JSONParsed`）**: `JSON.stringify` の挙動（`Date` -> `string`, `undefined` プロパティ除外, `symbol` キー除外, `Set`/`Map` -> `{}`）を型レベルで正確に再現している。`toJSON()` メソッドの戻り値型の解決もサポートしている。

```typescript
// src/utils/types.ts:53-83
export type JSONParsed<T, TError = bigint | ReadonlyArray<bigint>> = T extends {
  toJSON(): infer J
}
  ? (() => J) extends () => JSONPrimitive ? J
    : (() => J) extends () => { toJSON(): unknown } ? {}
      : JSONParsed<J, TError>
  : T extends JSONPrimitive ? T
    : T extends InvalidJSONValue ? never
      : T extends ReadonlyArray<unknown>
        ? { [K in keyof T]: JSONParsed<InvalidToNull<T[K]>, TError> }
        : ...
```

- **distributive conditional types の回避**: `[RorO] extends [never]` のようにタプルでラップしてチェックすることで、union 型が分配されるのを防いでいる。型ユーティリティで `never` チェックする際の定石。

```typescript
// src/types.ts:2228-2231
: [RorO] extends [never]
  ? {}
  : [RorO] extends [Promise<void>]
    ? {}
```

- **型パフォーマンスの定量計測**: PR ごとに 200 ルートのアプリを自動生成し、`tsc --diagnostics` で型チェック時間を計測する CI パイプラインを持つ。型の複雑化によるコンパイル時間の劣化を早期に検出できる。

## Anti-Patterns / 注意点

- **オーバーロード爆発**: `HandlerInterface` はハンドラ1個〜10個 x path有無 = 約20オーバーロード、`MiddlewareHandlerInterface` も同様に約20オーバーロード、`OnHandlerInterface` も同等の規模がある。`src/types.ts` は 2490 行に達しており、メンテナンスコストが高い。TypeScript 5.0+ の variadic tuple types や recursive conditional types でオーバーロード数を削減できる可能性があるが、型推論の精度とパフォーマンスのトレードオフがある。

```typescript
// Bad: 10段階のオーバーロードを手動で列挙
// app.get(handler x1), app.get(handler x2), ..., app.get(handler x10)
// app.get(path, handler x1), ..., app.get(path, handler x10)
// src/types.ts には合計 1000 行以上のオーバーロード定義がある
```

```typescript
// Better（理論上）: variadic tuple で統一的に定義
// ただし、TypeScript の型推論精度が落ちる可能性がある
type HandlerChain<E, P, Handlers extends H[]> = ...
```

Hono チームはこのトレードオフを理解した上で、型推論の精度を優先してオーバーロード方式を選択していると考えられる。CI での型パフォーマンス計測がこの戦略を支えている。

- **`any` の戦略的使用**: `types.ts` の先頭で `eslint-disable @typescript-eslint/no-explicit-any` を宣言し、ハンドラ型のデフォルトジェネリクスに `any` を使用している。これはフレームワーク内部の型推論を成立させるための妥協であり、ユーザーコードでは `any` が露出しないよう設計されている。自分のプロジェクトでこのパターンを模倣する場合、`any` の使用範囲を型定義ファイルに限定し、公開 API には `unknown` を使うルールが必要。

## 自分のプロジェクトへの適用

- [ ] **ファントム型で API レスポンスの型情報を保持する**: `TypedResponse` のパターンを参考に、API クライアントやフレームワークのレスポンス型にファントムフィールドを導入し、ステータスコードやフォーマットの型安全性を確保する
- [ ] **`JSONParsed` 型を導入して JSON 直列化のギャップを埋める**: `Date` が `string` に変換される等の問題を型レベルで検出できるようにする。Hono の `JSONParsed` をそのまま流用するか、プロジェクト固有のバリアントを作成する
- [ ] **`IsAny` / `IfAnyThenEmptyObject` パターンで型汚染を防止する**: ジェネリクスのデフォルト値に `any` を使う場面で、`any` が伝搬しないようフィルタリング型を設けることで、型安全性を維持する
- [ ] **型パフォーマンス計測を CI に組み込む**: 型が複雑なプロジェクトでは `tsc --diagnostics` の結果をベースラインと比較するステップを CI に追加し、型チェック時間の劣化を検出する仕組みを構築する
- [ ] **オーバーロードの活用と限界を理解する**: 可変長ハンドラチェーンの型推論が必要な場面では、variadic tuple よりもオーバーロードの方が推論精度が高い場合がある。上限（Hono では10個）を設定し、フォールバック用の汎用オーバーロードを最後に配置する
