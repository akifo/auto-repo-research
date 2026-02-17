# type-system-patterns

> リポジトリ: TanStack/query
> 分析日: 2026-02-17

## 概要

TanStack Query は TypeScript の型システムを高度に活用し、queryFn の返り値型がフック結果まで自動伝播する end-to-end 型安全を実現している。queryOptions ビルダーによる型タグ付き QueryKey（DataTag）、NoInfer による推論方向制御、`[T] extends [never]` による条件分岐、再帰的タプルマッピングによる動的配列の型推論など、ライブラリ設計における型推論最適化の実践例が体系的に集積されている。複数の TypeScript バージョン（5.0-5.7）でのテストにより型レベルの後方互換性も担保されている点が注目に値する。

## 背景にある原則

- **型情報は生成地点で付与し、消費地点まで減衰させない**: queryOptions で queryKey に DataTag として型情報を埋め込み、getQueryData / setQueryData で自動推論させる設計。型を「通す」ためにユーザーが手動で注釈を書く場面を最小化すべき、という原則に基づく（`queryOptions.ts:52-87`, `queryClient.ts:129-138`）

- **推論方向を制御し、意図しない型の広がりを防ぐ**: NoInfer で出力位置の型が入力位置の推論に逆流することを防止し、NonFunctionGuard / NonUndefinedGuard で値と関数の曖昧な推論を防ぐ。型推論エンジンの挙動を理解し、意図的に推論の方向を制約すべき（`types.ts:37`, `types.ts:169`, `useQuery.ts:28,38`）

- **状態の判別を型レベルで保証する**: QueryObserverResult を status ごとの discriminated union として定義し、`status === 'success'` の判定後に `data: TData`（undefined なし）にナローイングされる。ランタイムの状態チェックと型の絞り込みを一致させるべき（`types.ts:800-908`）

- **ユーザー拡張は宣言マージで安全に提供する**: Register インターフェースによる declaration merging で、DefaultError / QueryMeta / MutationMeta をグローバルにカスタマイズ可能にする。ジェネリクスの手動注釈を強制するのではなく、一度の宣言で全体に反映させるべき（`types.ts:39-51`）

## 実例と分析

### DataTag: QueryKey への型情報の埋め込み

queryOptions ヘルパーが返す queryKey には `DataTag<TQueryKey, TQueryFnData, TError>` が intersection で付与される。DataTag は Symbol プロパティを持つ phantom type であり、ランタイムの値を変えずに型情報を運搬する。

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

queryClient.getQueryData は `InferDataFromTag` で DataTag から型を自動抽出する。

```typescript
// packages/query-core/src/types.ts:84-87
export type InferDataFromTag<TQueryFnData, TTaggedQueryKey extends QueryKey> =
  TTaggedQueryKey extends DataTag<unknown, infer TaggedValue, unknown>
    ? TaggedValue
    : TQueryFnData
```

```typescript
// packages/query-core/src/queryClient.ts:129-133
getQueryData<
  TQueryFnData = unknown,
  TTaggedQueryKey extends QueryKey = QueryKey,
  TInferredQueryFnData = InferDataFromTag<TQueryFnData, TTaggedQueryKey>,
>(queryKey: TTaggedQueryKey): TInferredQueryFnData | undefined
```

これにより、queryOptions で定義した queryKey を getQueryData に渡すだけで、戻り値の型が自動推論される。

### NoInfer による推論方向の制御

useQuery の戻り値型に `NoInfer<TData>` を適用し、戻り値の型が引数の推論に影響することを防いでいる。

```typescript
// packages/react-query/src/useQuery.ts:20-28
export function useQuery<
  TQueryFnData = unknown,
  TError = DefaultError,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(
  options: DefinedInitialDataOptions<TQueryFnData, TError, TData, TQueryKey>,
  queryClient?: QueryClient,
): DefinedUseQueryResult<NoInfer<TData>, TError>
```

NoInfer の実装は `[T][T extends any ? 0 : never]` というイディオムで、TypeScript が推論位置として認識しないようにラップする。

```typescript
// packages/query-core/src/types.ts:37
export type NoInfer<T> = [T][T extends any ? 0 : never]
```

setQueryData でも同様に `NoInfer<TInferredQueryFnData>` で updater パラメータの型が queryKey の推論を汚染することを防いでいる（`queryClient.ts:183-187`）。

### `[T] extends [never]` による条件付き型の安全な分岐

通常のクエリと InfiniteQuery で QueryFunctionContext の形状を変える際に、`[TPageParam] extends [never]` パターンを使用する。

```typescript
// packages/query-core/src/types.ts:138-165
export type QueryFunctionContext<
  TQueryKey extends QueryKey = QueryKey,
  TPageParam = never,
> = [TPageParam] extends [never]
  ? {
      client: QueryClient
      queryKey: TQueryKey
      signal: AbortSignal
      meta: QueryMeta | undefined
      pageParam?: unknown
    }
  : {
      client: QueryClient
      queryKey: TQueryKey
      signal: AbortSignal
      pageParam: TPageParam
      direction: FetchDirection
      meta: QueryMeta | undefined
    }
```

`T extends never` ではなく `[T] extends [never]` を使う理由は、distributive conditional type を回避するため。naked type parameter に対する `extends never` は union 分配で意図しない挙動を起こす。

### 再帰的タプルマッピングによる useQueries の型推論

useQueries は可変長の配列引数から各要素のオプション型と結果型を個別に推論する必要がある。これを再帰的な条件型で実現している。

```typescript
// packages/react-query/src/useQueries.ts:147-184
export type QueriesOptions<
  T extends Array<any>,
  TResults extends Array<any> = [],
  TDepth extends ReadonlyArray<number> = [],
> = TDepth['length'] extends MAXIMUM_DEPTH
  ? Array<UseQueryOptionsForUseQueries>
  : T extends []
    ? []
    : T extends [infer Head]
      ? [...TResults, GetUseQueryOptionsForUseQueries<Head>]
      : T extends [infer Head, ...infer Tails]
        ? QueriesOptions<
            [...Tails],
            [...TResults, GetUseQueryOptionsForUseQueries<Head>],
            [...TDepth, 1]
          >
        : ReadonlyArray<unknown> extends T
          ? T
          : T extends Array<UseQueryOptionsForUseQueries<
                infer TQueryFnData, infer TError, infer TData, infer TQueryKey
              >>
            ? Array<UseQueryOptionsForUseQueries<TQueryFnData, TError, TData, TQueryKey>>
            : Array<UseQueryOptionsForUseQueries>
```

`TDepth['length'] extends MAXIMUM_DEPTH` はタプルの長さカウンタとして機能し、深さ20で再帰を打ち切る安全弁となっている。

### Register パターンによるグローバル型カスタマイズ

空の Register インターフェースを公開し、ユーザーが declaration merging で拡張する設計。

```typescript
// packages/query-core/src/types.ts:39-51
export interface Register {
  // defaultError: Error
  // queryMeta: Record<string, unknown>
}

export type DefaultError = Register extends {
  defaultError: infer TError
}
  ? TError
  : Error
```

ユーザーは以下のように一度だけ宣言すれば、全てのクエリ/ミューテーションのエラー型が変わる。

```typescript
declare module '@tanstack/query-core' {
  interface Register {
    defaultError: AxiosError
  }
}
```

### 関数オーバーロードによる initialData の有無での戻り値型分岐

useQuery は3つのオーバーロードを持ち、initialData の有無で戻り値型を切り替える。

```typescript
// packages/react-query/src/useQuery.ts:20-48
// オーバーロード1: initialData あり -> DefinedUseQueryResult (data: TData, undefined なし)
export function useQuery<...>(
  options: DefinedInitialDataOptions<...>,
): DefinedUseQueryResult<NoInfer<TData>, TError>

// オーバーロード2: initialData なし -> UseQueryResult (data: TData | undefined)
export function useQuery<...>(
  options: UndefinedInitialDataOptions<...>,
): UseQueryResult<NoInfer<TData>, TError>

// オーバーロード3: フォールバック
export function useQuery<...>(
  options: UseQueryOptions<...>,
): UseQueryResult<NoInfer<TData>, TError>
```

### TuplePrefixes: QueryKey フィルタリングの型安全

QueryFilters で queryKey のプレフィックスマッチを型レベルで保証する。

```typescript
// packages/query-core/src/utils.ts:19-28
type DropLast<T extends ReadonlyArray<unknown>> = T extends readonly [
  ...infer R,
  unknown,
]
  ? readonly [...R]
  : never

type TuplePrefixes<T extends ReadonlyArray<unknown>> = T extends readonly []
  ? readonly []
  : TuplePrefixes<DropLast<T>> | T
```

`['users', number, 'posts']` に対し、`['users']` や `['users', number]` がフィルタとして型安全に受け入れられる。

## パターンカタログ

- **Phantom Type** (構造)
  - 解決する問題: ランタイム値を変えずに型レベルの情報を付加する
  - 適用条件: 識別子（key, ID）に関連する型情報を伝播させたい場合
  - コード例: `packages/query-core/src/types.ts:63-82` (DataTag)
  - 注意点: Symbol を使うことで通常のプロパティアクセスとの衝突を回避

- **Discriminated Union** (振る舞い)
  - 解決する問題: ステータスに応じた data/error の null 安全性をコンパイル時に保証する
  - 適用条件: 状態マシン的なオブジェクトの型定義
  - コード例: `packages/query-core/src/types.ts:800-908` (QueryObserverResult)
  - 注意点: 全状態に対して boolean リテラル型を明示する必要がある

- **Builder Pattern (型レベル)** (生成)
  - 解決する問題: 複数の関連ジェネリクスをユーザーに手動指定させず、推論で伝播させる
  - 適用条件: 複数のジェネリクスを持つオプションオブジェクトを安全に構築したい場合
  - コード例: `packages/react-query/src/queryOptions.ts:52-87`
  - 注意点: identity 関数（引数をそのまま返す）であっても型推論のために必要

## Good Patterns

- **identity 関数による型推論の起点作成**: queryOptions / infiniteQueryOptions / mutationOptions は全てランタイムでは引数をそのまま返す identity 関数だが、TypeScript の型推論を起動させるために不可欠。これにより queryFn の返り値型が queryKey の DataTag に埋め込まれ、getQueryData 等で自動推論される。

```typescript
// packages/react-query/src/queryOptions.ts:85-87
export function queryOptions(options: unknown) {
  return options
}
```

- **OmitKeyof による型安全な Omit**: 標準の `Omit<T, K>` は K に存在しないキーを指定してもエラーにならない。OmitKeyof は 'strictly' モード（デフォルト）で存在しないキーの指定を型エラーにし、'safely' モードでオートコンプリート付きの柔軟な使用を可能にする。

```typescript
// packages/query-core/src/types.ts:19-29
export type OmitKeyof<
  TObject,
  TKey extends TStrictly extends 'safely'
    ?
        | keyof TObject
        | (string & Record<never, never>)
        | (number & Record<never, never>)
        | (symbol & Record<never, never>)
    : keyof TObject,
  TStrictly extends 'strictly' | 'safely' = 'strictly',
> = Omit<TObject, TKey>
```

- **DistributiveOmit で union 型への Omit を安全に適用**: 標準の `Omit` は union 型に適用すると分配されず意図しない結果になる。`TObject extends any ? Omit<TObject, TKey> : never` で分配を強制する。

```typescript
// packages/query-core/src/types.ts:14-17
export type DistributiveOmit<
  TObject,
  TKey extends keyof TObject,
> = TObject extends any ? Omit<TObject, TKey> : never
```

- **ReplaceReturnType によるサブクラスの型オーバーライド**: InfiniteQueryObserver は QueryObserver を継承し、メソッドの戻り値型だけを変更する必要がある。`!` 宣言と ReplaceReturnType ユーティリティで型だけを上書きする。

```typescript
// packages/query-core/src/infiniteQueryObserver.ts:39-54
// Type override
subscribe!: Subscribable<InfiniteQueryObserverListener<TData, TError>>['subscribe']
getCurrentResult!: ReplaceReturnType<
  QueryObserver<...>['getCurrentResult'],
  InfiniteQueryObserverResult<TData, TError>
>

// packages/query-core/src/infiniteQueryObserver.ts:187-190
type ReplaceReturnType<
  TFunction extends (...args: Array<any>) => unknown,
  TReturn,
> = (...args: Parameters<TFunction>) => TReturn
```

## Anti-Patterns / 注意点

- **naked type parameter での `extends never` チェック**: distributive conditional type により `T extends never` は T が union のとき予期しない結果になる。

```typescript
// Bad: distributive で意図しない挙動
type Check<T> = T extends never ? 'yes' : 'no'
type Result = Check<never> // never（'yes' ではない）

// Better: tuple でラップして分配を防止
type Check<T> = [T] extends [never] ? 'yes' : 'no'
type Result = Check<never> // 'yes'
```

TanStack Query では `QueryPersister` と `QueryFunctionContext` でこのパターンを一貫して使用している（`types.ts:126,141`）。

- **再帰型の深さ制限を設けない**: TypeScript コンパイラの再帰制限に到達すると、型エラーメッセージが極めて不明瞭になる。

```typescript
// Bad: 深さ制限なしの再帰型
type MapAll<T extends Array<any>> = T extends [infer H, ...infer Tail]
  ? [Transform<H>, ...MapAll<Tail>]
  : []

// Better: TanStack Query のように深さカウンタを導入する
type MAXIMUM_DEPTH = 20
type MapAll<
  T extends Array<any>,
  TDepth extends ReadonlyArray<number> = [],
> = TDepth['length'] extends MAXIMUM_DEPTH
  ? Array<FallbackType>
  : T extends [infer H, ...infer Tail]
    ? [Transform<H>, ...MapAll<Tail, [...TDepth, 1]>]
    : []
```

TanStack Query の useQueries / useSuspenseQueries で深さ20に制限している（`useQueries.ts:55,151`）。

## 導出ルール

- `[MUST]` 複雑なオプションオブジェクトの型推論には identity 関数（ビルダー関数）を提供する。ユーザーに手動の型引数指定を強制しない
  - 根拠: TanStack Query の queryOptions / mutationOptions は全てランタイムでは no-op だが、型推論の起点として不可欠であり、これにより queryKey から getQueryData まで型が自動伝播する（`queryOptions.ts:85-87`）

- `[MUST]` discriminated union で状態を表現する際、各バリアントの判別プロパティにリテラル型を使い、関連プロパティの undefined/null を排除する
  - 根拠: TanStack Query は QueryObserverResult を status リテラル + boolean リテラルで6種に分け、success 時に `data: TData`（undefined なし）を保証している（`types.ts:864-878`）

- `[SHOULD]` ライブラリのデフォルト型をユーザーがグローバルにカスタマイズできるよう、空の Register インターフェース + declaration merging パターンを採用する
  - 根拠: TanStack Query は Register インターフェースで DefaultError / QueryMeta 等を一度の宣言で全体に反映させ、全てのフックに手動で型引数を渡す手間を排除している（`types.ts:39-51`）

- `[SHOULD]` 型推論が出力位置から入力位置に逆流するのを防ぐため、出力位置に NoInfer を適用する
  - 根拠: useQuery の戻り値型に `NoInfer<TData>` を適用し、戻り値の型消費が select / queryFn の推論を汚染することを防いでいる（`useQuery.ts:28,38`）

- `[SHOULD]` 再帰的な条件型にはタプル長カウンタによる深さ制限を設け、フォールバック型を定義する
  - 根拠: useQueries の QueriesOptions / QueriesResults は深さ20で再帰を打ち切り、Array<UseQueryOptionsForUseQueries> にフォールバックしてコンパイラの深さ制限エラーを回避している（`useQueries.ts:55,151`）

- `[SHOULD]` `never` チェックには `[T] extends [never]` を使い、distributive conditional type を回避する
  - 根拠: QueryFunctionContext / QueryPersister で `[TPageParam] extends [never]` パターンを使い、通常クエリと InfiniteQuery で型の形状を安全に切り替えている（`types.ts:126,141`）

- `[AVOID]` 標準の `Omit<T, K>` を union 型やライブラリ API の公開型で使用する。存在しないキーを静かに受け入れ、union 型で分配されない問題がある
  - 根拠: TanStack Query は OmitKeyof（存在しないキーの検出）と DistributiveOmit（union 分配対応）を独自に定義し、標準 Omit の問題を回避している（`types.ts:14-29`）

## 適用チェックリスト

- [ ] 複数のジェネリクスを持つオプションオブジェクトに identity ビルダー関数を提供しているか
- [ ] 状態を表す型が discriminated union になっており、状態チェック後に関連プロパティが適切にナローイングされるか
- [ ] ライブラリ公開時、デフォルトのエラー型やメタデータ型を Register パターンでカスタマイズ可能にしているか
- [ ] フック/関数の戻り値型が入力の型推論に逆流していないか（NoInfer の適用を検討）
- [ ] 再帰的な条件型に深さ制限とフォールバック型が設定されているか
- [ ] `extends never` チェックが tuple ラップされているか
- [ ] Omit を union 型に適用していないか（DistributiveOmit の使用を検討）
- [ ] phantom type で key/ID に型情報を埋め込み、利用側で自動推論できるようにしているか
- [ ] 型テスト（.test-d.ts）で型推論の正確性を検証しているか
