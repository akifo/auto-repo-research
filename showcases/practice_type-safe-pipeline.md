# Practice: Type-Safe Pipeline

> 出典: [repos/honojs/hono](../repos/honojs/hono/)
> カテゴリ: practice

## 概要

ミドルウェアチェーンやプラグインパイプラインの型合成で `any` が混入してもチェーン全体の型が崩壊しない防御的型設計。`IntersectNonAnyTypes` が `any` を `{}` にフィルタしてからインターセクションを取ることで、型パラメータ未指定のジェネリック関数が混在しても型安全性を構造的に保証する。型合成パイプラインを持つあらゆるライブラリに転用可能な防御パターンである。

## 背景・文脈

Hono はミドルウェアチェーンで環境型 `Env` を累積的にインターセクション合成する。例えば `bearerAuth()` が `{ Variables: { token: string } }` を、`validator()` が `{ Variables: { body: UserInput } }` を追加すると、チェーン末尾のハンドラは `{ Variables: { token: string; body: UserInput } }` にアクセスできる。

しかし、型パラメータを指定しないミドルウェア（`logger()`, `poweredBy()` 等）は `Env = any` をデフォルトで持つ。通常の TypeScript では `SomeType & any` は常に `any` になり、チェーン全体の型情報が消失する。Hono はこの問題を `IntersectNonAnyTypes` で構造的に解決している。

## 実装パターン

### any 検出ユーティリティ

```typescript
// src/utils/types.ts:21
// 0 extends 1 & T は T が any のときのみ true になるトリック
export type IfAnyThenEmptyObject<T> = 0 extends 1 & T ? {} : T

// src/utils/types.ts:110
// boolean extends (T extends never ? true : false) は any のとき true
export type IsAny<T> = boolean extends (T extends never ? true : false) ? true : false
```

### any フィルター付き型合成

```typescript
// src/types.ts:2473-2476
// ProcessHead: any と基底 Env をフィルタし、具体的な型のみをインターセクションに含める
type ProcessHead<T> = IfAnyThenEmptyObject<T extends Env ? (Env extends T ? {} : T) : T>

export type IntersectNonAnyTypes<T extends any[]> = T extends [infer Head, ...infer Rest]
  ? ProcessHead<Head> & IntersectNonAnyTypes<Rest>
  : {}
```

### ミドルウェアチェーンでの型累積

```typescript
// src/types.ts:128-148 (HandlerInterface の一部)
// 2つのミドルウェアの場合:
// E2 = bearerAuth の Env, E3 = validator の Env
// → IntersectNonAnyTypes<[E, E2, E3]> でフィルタ済みインターセクション
<M extends string, P extends string, Mw1, Mw2, Mw3>(...args: [
  path: P,
  mw1: MiddlewareHandler<E & IntersectNonAnyTypes<[E2]>, ...>,
  mw2: MiddlewareHandler<E & IntersectNonAnyTypes<[E2, E3]>, ...>,
  handler: Handler<E & IntersectNonAnyTypes<[E2, E3, E4]>, ...>,
]): HonoBase<IntersectNonAnyTypes<[E, E2, E3, E4]>, ...>
```

### ファントム型によるレスポンス追跡

```typescript
// src/types.ts:2346-2358
// _data, _status, _format はランタイムに存在しない型運搬専用プロパティ
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

### Template Literal Types によるパス→パラメータ型推論

```typescript
// src/types.ts:2409-2423
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
// '/users/:id/posts/:postId' → 'id' | 'postId'
```

## Good Example

```typescript
// any フィルターを導入したプラグインチェーン型合成
type IfAnyThenEmpty<T> = 0 extends 1 & T ? {} : T

type MergePluginTypes<T extends unknown[]> = T extends [infer Head, ...infer Rest]
  ? IfAnyThenEmpty<Head> & MergePluginTypes<Rest>
  : {}

// 使用例: 型パラメータ未指定のプラグインが混在しても安全
type Result = MergePluginTypes<[
  { db: Database },     // DB プラグイン
  any,                  // 型パラメータ未指定のプラグイン (logger 等)
  { auth: AuthContext }, // 認証プラグイン
]>
// Result = { db: Database } & { auth: AuthContext }
// any がフィルタされ、db と auth の型が保持される


// ファントム型でコンパイル時にステータスを追跡
type ApiResponse<TData, TStatus extends number = 200> = Response & {
  _data: TData
  _status: TStatus
}

function json<T>(data: T): ApiResponse<T, 200> {
  return new Response(JSON.stringify(data)) as ApiResponse<T, 200>
}

function notFound(): ApiResponse<{ error: string }, 404> {
  return new Response(JSON.stringify({ error: 'Not Found' })) as ApiResponse<{ error: string }, 404>
}
```

## Bad Example

```typescript
// Bad: any をフィルタせずにインターセクション -- 全体が any に崩壊
type NaiveMerge<T extends unknown[]> = T extends [infer Head, ...infer Rest]
  ? Head & NaiveMerge<Rest>
  : {}

type Result = NaiveMerge<[
  { db: Database },
  any,                  // any & { db: Database } = any
  { auth: AuthContext },
]>
// Result = any -- db も auth も消失


// Bad: ファントム型プロパティにランタイムでアクセス
const data = response._data  // undefined at runtime, typed as T

// Better: 専用のアクセサ経由でランタイム安全にアクセス
const data = await response.json()  // runtime-safe


// Bad: Union → Intersection を手動で書く
type Combined = PluginA['env'] & PluginB['env'] & PluginC['env']
// プラグインが増えるたびに手動で追加が必要

// Better: ヘルパー型で自動合成
type Combined = MergePluginTypes<RegisteredPlugins>
```

## 適用ガイド

### どのような状況で使うべきか

- **プラグイン/ミドルウェアシステム**: 複数のプラグインが共有コンテキストに型を追加するアーキテクチャ
- **型合成パイプライン**: ジェネリック関数のチェーンで型パラメータが累積される場面
- **RPC / End-to-End 型安全**: サーバーの定義からクライアントの型を自動導出するシステム
- **バリデーションチェーン**: 入力バリデーションの結果型を累積して最終的なハンドラに渡す場面

### 導入時の注意点

- **`0 extends 1 & T` トリック**: TypeScript の内部的な挙動に依存しており、将来のバージョンで変更される可能性がある（ただし広く使われているため安定性は高い）
- **コンパイル時間とのトレードオフ**: 深い再帰型や多数のオーバーロードはコンパイル時間を増大させる。Hono の `HandlerInterface` は約20オーバーロードが保守コストの現実解として存在している
- **型テストの導入**: `expectTypeOf()` 等で型推論の正確性をテストし、型の回帰を CI で検知する（Hono は16ファイル・640箇所以上で実施）

### カスタマイズポイント

- `Declaration Merging`（`declare module` + 空インターフェース）でグローバル型拡張を提供し、ジェネリクスでインスタンス単位の型安全を提供する二重拡張メカニズム
- `JSONParsed<T>` のようにシリアライズ変換を型レベルで再現し、API 境界での型変換を自動化する
- `ValidationTargetByMethod<M>` のように HTTP メソッドに応じた制約を型レベルで強制する

## 参考

- [repos/honojs/hono/type-system-patterns.md](../repos/honojs/hono/type-system-patterns.md) — Template Literal Types、ファントム型、Declaration Merging の包括的分析
- [repos/honojs/hono/metaprogramming-techniques.md](../repos/honojs/hono/metaprogramming-techniques.md) — 型レベルパス合成、Proxy RPC クライアント生成
- [repos/honojs/hono/composition-patterns.md](../repos/honojs/hono/composition-patterns.md) — 統一シグネチャによる合成の代数的閉包性
