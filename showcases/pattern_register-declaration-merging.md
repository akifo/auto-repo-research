# Register Declaration Merging パターン

> 出典: [repos/TanStack/query](../repos/TanStack/query/)
> カテゴリ: pattern

## 概要

空の `Register` インターフェースを export し、TypeScript の declaration merging でユーザーがライブラリのデフォルト型をグローバルに上書きできるようにするパターン。ユーザーは1行の `declare module` 宣言を書くだけで、プロジェクト全体のデフォルトエラー型・メタデータ型などを変更でき、全てのフック・関数に個別のジェネリクス引数を渡す必要がなくなる。ランタイムコストはゼロで、end-to-end の型安全性を実現する。

## 背景・文脈

TanStack Query (48k+ stars) は React / Vue / Solid / Svelte / Angular をサポートするマルチフレームワーク対応の非同期状態管理ライブラリである。`useQuery` や `useMutation` などの多数のフックが共通のジェネリクス型パラメータ（エラー型 `TError`、メタデータ型 `QueryMeta` など）を持つが、これらを全ての呼び出し箇所で個別に指定させるのは DX として現実的でない。

例えば、プロジェクトで Axios を使っている場合、エラー型は全て `AxiosError` にしたい。しかし数十箇所の `useQuery<Data, AxiosError>()` にジェネリクスを書かせるのは冗長であり、書き漏れによる型不整合のリスクもある。Register パターンはこの問題を「1回の宣言で全体に適用」という形で解決する。

さらに TanStack Query では、この Register パターンを DataTag（QueryKey への型情報の埋め込み）と組み合わせ、`queryOptions` で定義した型情報が `queryClient.getQueryData` まで自動伝播する仕組みを構築している。

## 実装パターン

### 1. 空の Register インターフェースを定義する

ライブラリ側で空のインターフェースを export し、コメントで拡張可能なプロパティを示す。

```typescript
// packages/query-core/src/types.ts:39-45
export interface Register {
  // defaultError: Error
  // queryMeta: Record<string, unknown>
  // mutationMeta: Record<string, unknown>
  // queryKey: ReadonlyArray<unknown>
  // mutationKey: ReadonlyArray<unknown>
}
```

### 2. 条件型で Register からデフォルト型を導出する

`Register` にプロパティが存在すればそれを使い、なければフォールバック型を返す。

```typescript
// packages/query-core/src/types.ts:47-61
export type DefaultError = Register extends {
  defaultError: infer TError
}
  ? TError
  : Error

export type QueryKey = Register extends {
  queryKey: infer TQueryKey
}
  ? TQueryKey extends ReadonlyArray<unknown>
    ? TQueryKey
    : TQueryKey extends Array<unknown>
      ? TQueryKey
      : ReadonlyArray<unknown>
  : ReadonlyArray<unknown>
```

### 3. ユーザーが declaration merging で型を上書きする

```typescript
// ユーザーのプロジェクトで1回だけ宣言する
declare module '@tanstack/query-core' {
  interface Register {
    defaultError: AxiosError
  }
}
```

この宣言以降、全ての `useQuery` / `useMutation` / `queryClient.getQueryData` などでエラー型が `AxiosError` になる。

### 4. DataTag との連携で型を自動伝播させる

`queryOptions` ヘルパーが返す QueryKey には `DataTag` が intersection で付与され、`queryClient.getQueryData` で自動的にデータ型が推論される。

```typescript
// packages/query-core/src/types.ts:63-82
export const dataTagSymbol = Symbol('dataTagSymbol')
export type dataTagSymbol = typeof dataTagSymbol
export const dataTagErrorSymbol = Symbol('dataTagErrorSymbol')
export type dataTagErrorSymbol = typeof dataTagErrorSymbol

export type DataTag<
  TType,
  TValue,
  TError = UnsetMarker,
> = TType extends AnyDataTag
  ? TType
  : TType & {
      [dataTagSymbol]: TValue
      [dataTagErrorSymbol]: TError
    }
```

```typescript
// packages/query-core/src/types.ts:84-87
export type InferDataFromTag<TQueryFnData, TTaggedQueryKey extends QueryKey> =
  TTaggedQueryKey extends DataTag<unknown, infer TaggedValue, unknown>
    ? TaggedValue
    : TQueryFnData
```

`queryOptions` は identity 関数だが、オーバーロードシグネチャで `queryKey` に `DataTag` を付与する。

```typescript
// packages/react-query/src/queryOptions.ts:52-61
export function queryOptions<
  TQueryFnData = unknown,
  TError = DefaultError,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(
  options: DefinedInitialDataOptions<TQueryFnData, TError, TData, TQueryKey>,
): DefinedInitialDataOptions<TQueryFnData, TError, TData, TQueryKey> & {
  queryKey: DataTag<TQueryKey, TQueryFnData, TError>
}

// ... 他のオーバーロード省略 ...

// packages/react-query/src/queryOptions.ts:85-87
export function queryOptions(options: unknown) {
  return options
}
```

`queryClient.getQueryData` は `InferDataFromTag` で DataTag から型を自動抽出する。

```typescript
// packages/query-core/src/queryClient.ts:129-133
getQueryData<
  TQueryFnData = unknown,
  TTaggedQueryKey extends QueryKey = QueryKey,
  TInferredQueryFnData = InferDataFromTag<TQueryFnData, TTaggedQueryKey>,
>(queryKey: TTaggedQueryKey): TInferredQueryFnData | undefined
```

## Good Example

`queryOptions` で定義した型情報が、手動のジェネリクス指定なしに `getQueryData` / `setQueryData` まで伝播する。

```typescript
import { queryOptions, useQuery } from '@tanstack/react-query'
import type { AxiosError } from 'axios'

// 1. グローバルなデフォルトエラー型を1回だけ宣言
declare module '@tanstack/query-core' {
  interface Register {
    defaultError: AxiosError
  }
}

// 2. queryOptions でクエリを定義 — queryKey に DataTag が自動付与される
const todosOptions = queryOptions({
  queryKey: ['todos'] as const,
  queryFn: async () => {
    const res = await axios.get<Array<Todo>>('/api/todos')
    return res.data
  },
})

// 3. useQuery — TError は自動で AxiosError に推論される
const { data, error } = useQuery(todosOptions)
//     ^? Todo[] | undefined
//            ^? AxiosError | null

// 4. getQueryData — queryKey の DataTag からデータ型が自動推論される
const cached = queryClient.getQueryData(todosOptions.queryKey)
//    ^? Todo[] | undefined （ジェネリクス指定不要）

// 5. setQueryData — updater の型も自動推論される
queryClient.setQueryData(todosOptions.queryKey, (old) => {
  //                                              ^? Todo[] | undefined
  return old?.filter(todo => !todo.completed)
})
```

## Bad Example

Register パターンなしでは、全ての呼び出し箇所にジェネリクスを手動指定する必要がある。

```typescript
import { useQuery } from '@tanstack/react-query'
import type { AxiosError } from 'axios'

// Bad: 全ての useQuery に TError を手動で指定する必要がある
const { data, error } = useQuery<Todo[], AxiosError>({
  queryKey: ['todos'],
  queryFn: fetchTodos,
})

// Bad: getQueryData にも手動で型を渡す必要がある
const cached = queryClient.getQueryData<Todo[]>(['todos'])

// Bad: setQueryData も手動
queryClient.setQueryData<Todo[]>(['todos'], (old) => {
  return old?.filter(todo => !todo.completed)
})

// Bad: 数十箇所に同じジェネリクスを書く必要があり、
//      書き漏れた箇所では TError がデフォルトの Error になってしまう
const { error: err2 } = useQuery({
  queryKey: ['users'],
  queryFn: fetchUsers,
})
// err2 は Error 型 — AxiosError ではない（書き漏れ）
```

## 適用ガイド

### どのような状況で使うべきか

- **ライブラリを設計する際に、ジェネリクスのデフォルト型をユーザーがプロジェクト単位でカスタマイズしたい場合**: エラー型、メタデータ型、キー型など、プロジェクト全体で統一すべき型が候補になる
- **同じジェネリクス型パラメータが多数の API に繰り返し現れる場合**: 個別指定を強制すると DX が著しく低下する場面で特に有効
- **ランタイムに影響を与えずに型レベルのカスタマイズを提供したい場合**: declaration merging は純粋に型レベルの操作であり、バンドルサイズへの影響はゼロ

### 導入時の注意点

- **Register インターフェースのプロパティは条件型で参照する**: `Register extends { defaultError: infer TError } ? TError : Error` のパターンで、未拡張時のフォールバック型を必ず定義する
- **コメントで拡張可能なプロパティを明示する**: 空のインターフェースだけでは何が拡張可能か分からないため、コメントアウトされたプロパティ一覧を記載する（TanStack Query の `types.ts:40-44` を参照）
- **declaration merging の宣言場所に注意**: `declare module` はプロジェクトの型定義ファイル（例: `src/types.d.ts`）に1箇所だけ書く。複数箇所に書くと最後の宣言で上書きされるのではなく、全てがマージされる
- **DataTag パターンとの併用を検討する**: Register だけでなく、identity 関数（`queryOptions` のような型推論の起点）と DataTag（phantom type による型情報の運搬）を組み合わせることで、定義箇所から消費箇所まで型が途切れなく伝播する

### カスタマイズポイント

- **拡張可能なプロパティの粒度**: TanStack Query は `defaultError` / `queryMeta` / `mutationMeta` / `queryKey` / `mutationKey` の5つを提供。必要十分なカスタマイズ軸を選定する
- **フォールバック型の設計**: 未拡張時のデフォルトが適切であることを確認する。TanStack Query では `defaultError` のフォールバックが `Error` で、JavaScript の標準エラー型を採用している
- **モジュールパスの設計**: ユーザーが `declare module` で指定するモジュールパスが安定していること。パッケージの re-export 構造がある場合は、コアパッケージ（`@tanstack/query-core`）を指定先にする

## 参考

- [repos/TanStack/query/type-system-patterns.md](../repos/TanStack/query/type-system-patterns.md) -- Register パターン、DataTag、NoInfer の詳細分析
- [repos/TanStack/query/design-philosophy.md](../repos/TanStack/query/design-philosophy.md) -- 「1回の宣言で全体に適用」という DX 設計思想
- [repos/TanStack/query/api-design-practices.md](../repos/TanStack/query/api-design-practices.md) -- identity 関数、グローバル型カスタマイズの API 設計
