# API設計プラクティス

> リポジトリ: TanStack/query
> 分析日: 2026-02-17

## 概要

TanStack Query のパブリック API 設計を分析し、型安全なオプション設計、後方互換性を維持しながらの API 進化、フレームワーク非依存のコア/アダプター分離パターンを調査した。48k+ スターを持つマルチフレームワーク対応ライブラリが、TypeScript の型システムを最大限に活用しつつ、破壊的変更を最小化し、段階的マイグレーションを可能にする設計はコミュニティ規模のライブラリ設計のリファレンスとして注目に値する。

## 背景にある原則

- **オプションオブジェクト単一引数の原則**: API の引数を単一のオプションオブジェクトに統一することで、引数の順序問題を排除し、オプショナルプロパティの追加を非破壊的に行える。v5 で複数シグネチャ（オーバーロード）を廃止し、単一オブジェクト形式に統一した（`useBaseQuery.ts:44-49` のバリデーションで強制）。根拠: 引数追加がセマンティックバージョニング上の非破壊的変更になる。
- **型推論をユーザーに押し付けない原則**: `queryOptions()` / `infiniteQueryOptions()` というアイデンティティ関数を提供し、実行時コストゼロで型推論だけを提供する。ユーザーに手動でジェネリクスを書かせず、関数呼び出しだけで型が伝播する設計にすべき。根拠: `queryOptions.ts:85-87` で `return options` のみ — ランタイムロジックは皆無。
- **段階的 API 進化の原則**: 新機能は `experimental_` プレフィックス付きで公開し、安定したら正式 API に昇格する。非推奨 API は `@deprecated` JSDoc + 次メジャーバージョンでの削除予告を併記し、codemods で自動マイグレーションを提供する。根拠: `experimental_prefetchInRender`、`experimental_streamedQuery` のネーミング規則と `query-codemods` パッケージの存在。
- **コアとアダプターの分離原則**: フレームワーク非依存のロジックを `query-core` に集約し、各フレームワークアダプター（React, Vue, Solid, Svelte, Angular）はコアの薄いラッパーとして実装する。根拠: `react-query/src/index.ts:4` の `export * from '@tanstack/query-core'` で、コアの全エクスポートをそのまま再公開している。

## 実例と分析

### アイデンティティ関数による型安全なオプションビルダー

`queryOptions()` はランタイムでは何もせず、TypeScript の型推論のみを提供するアイデンティティ関数である。複数のオーバーロードシグネチャにより `initialData` の有無に応じて戻り値の型（`DefinedInitialDataOptions` / `UndefinedInitialDataOptions`）を切り替え、`DataTag` でクエリキーにデータ型・エラー型を「タグ付け」する。

```typescript
// packages/react-query/src/queryOptions.ts:52-87
export function queryOptions<
  TQueryFnData = unknown,
  TError = DefaultError,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(
  options: DefinedInitialDataOptions<TQueryFnData, TError, TData, TQueryKey>,
): DefinedInitialDataOptions<TQueryFnData, TError, TData, TQueryKey> & {
  queryKey: DataTag<TQueryKey, TQueryFnData, TError>;
};
// ... 他のオーバーロード省略 ...
export function queryOptions(options: unknown) {
  return options;
}
```

これにより `queryClient.getQueryData(options.queryKey)` で自動的にデータ型が推論される。同じパターンが `infiniteQueryOptions()`、`mutationOptions()` にも適用されている。Vue, Solid, Svelte, Angular の各アダプターでも同一の構造を持つ。

### DataTag による QueryKey への型情報埋め込み

`DataTag` は Symbol ベースの phantom type で、QueryKey にデータ型とエラー型を埋め込む。

```typescript
// packages/query-core/src/types.ts:63-82
export const dataTagSymbol = Symbol("dataTagSymbol");
export type dataTagSymbol = typeof dataTagSymbol;
export const dataTagErrorSymbol = Symbol("dataTagErrorSymbol");
export type dataTagErrorSymbol = typeof dataTagErrorSymbol;

export type DataTag<
  TType,
  TValue,
  TError = UnsetMarker,
> = TType extends AnyDataTag ? TType
  : TType & {
    [dataTagSymbol]: TValue;
    [dataTagErrorSymbol]: TError;
  };
```

`InferDataFromTag` / `InferErrorFromTag` で Tagged QueryKey からデータ型・エラー型を抽出できる。`queryClient.getQueryData()` や `queryClient.setQueryData()` が `TTaggedQueryKey` を受け取り、自動推論を実現する（`queryClient.ts:129-138`）。

### Register インターフェースによるグローバル型カスタマイズ

空の `Register` インターフェースを宣言し、ユーザーが declaration merging で拡張できるようにしている。

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

`DefaultError` や `QueryKey` の定義は条件型でこの `Register` を参照し、ユーザーがカスタマイズ可能にしている。

```typescript
// packages/query-core/src/types.ts:47-51
export type DefaultError = Register extends {
  defaultError: infer TError;
} ? TError
  : Error;
```

### オプションの多層デフォルトマージ

`QueryClient.defaultQueryOptions()` は 3 層のデフォルト値をマージする: (1) グローバルデフォルト → (2) クエリキーごとのデフォルト → (3) 個別オプション。`_defaulted` フラグで重複処理を防ぐ。

```typescript
// packages/query-core/src/queryClient.ts:589-594
const defaultedOptions = {
  ...this.#defaultOptions.queries,
  ...this.getQueryDefaults(options.queryKey),
  ...options,
  _defaulted: true,
};
```

さらに依存デフォルト（`refetchOnReconnect` は `networkMode` に依存、`throwOnError` は `suspense` に依存）も同メソッド内で処理する（`queryClient.ts:604-618`）。

### 値 | 関数 のユニオン型によるオプション設計

多くのオプションが「静的な値」と「動的に計算する関数」の両方を受け付ける設計になっている。

```typescript
// packages/query-core/src/types.ts:102-121
export type StaleTime = number | 'static'
export type StaleTimeFunction<...> =
  | StaleTime
  | ((query: Query<...>) => StaleTime)

export type Enabled<...> =
  | boolean
  | ((query: Query<...>) => boolean)
```

`resolveStaleTime()` / `resolveEnabled()` で一貫して解決する（`utils.ts:112-136`）。

### discriminated union による結果型の状態モデリング

`QueryObserverResult` は 5 つの状態（Pending, Loading, LoadingError, RefetchError, Success, Placeholder）を discriminated union で表現し、`status` フィールドで判別する。各状態で `data` / `error` の型が正確に narrowing される。

```typescript
// packages/query-core/src/types.ts:903-908
export type QueryObserverResult<TData = unknown, TError = DefaultError> =
  | DefinedQueryObserverResult<TData, TError>
  | QueryObserverLoadingErrorResult<TData, TError>
  | QueryObserverLoadingResult<TData, TError>
  | QueryObserverPendingResult<TData, TError>
  | QueryObserverPlaceholderResult<TData, TError>;
```

### experimental_ プレフィックスによる段階的 API 公開

不安定な機能は `experimental_` プレフィックスで名前空間を分離する。

```typescript
// packages/query-core/src/index.ts:42
export { streamedQuery as experimental_streamedQuery } from './streamedQuery'

// packages/query-core/src/types.ts:440
experimental_prefetchInRender?: boolean
```

これにより安定 API と実験的 API が明確に区別され、ユーザーが意識的にオプトインできる。

### Suspense 変種でのオプション制限型

`UseSuspenseQueryOptions` は `UseQueryOptions` から `enabled`、`throwOnError`、`placeholderData` を `OmitKeyof` で除外し、矛盾するオプションをコンパイル時に防ぐ。

```typescript
// packages/react-query/src/types.ts:81-94
export interface UseSuspenseQueryOptions<...>
  extends OmitKeyof<
    UseQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
    'queryFn' | 'enabled' | 'throwOnError' | 'placeholderData'
  > {
  queryFn?: Exclude<
    UseQueryOptions<...>['queryFn'],
    SkipToken
  >
}
```

ランタイムでも `useSuspenseQuery` で `enabled: true`、`suspense: true` を強制注入する（`useSuspenseQuery.ts:23-33`）。

### skipToken パターンによる条件付きクエリの型安全化

`queryFn` に `SkipToken` を渡すことで、クエリを無効化する。`typeof skipToken` でユニオン型から除外する `Exclude` を使い、Suspense 変種では `SkipToken` を禁止する。

```typescript
// packages/query-core/src/utils.ts:423-424
export const skipToken = Symbol();
export type SkipToken = typeof skipToken;
```

`defaultQueryOptions()` 内で `skipToken` を検出すると自動的に `enabled = false` に設定する（`queryClient.ts:616-618`）。

## パターンカタログ

- **Observer パターン** (分類: 振る舞い)
  - 解決する問題: 非同期データの変更をフレームワーク非依存で通知する
  - 適用条件: コアロジックを複数の UI フレームワークで共有する場合
  - コード例: `subscribable.ts:1-30`, `queryObserver.ts:40-46`
  - 注意点: `Subscribable` 基底クラスを継承し、`subscribe()` が unsubscribe 関数を返す。`onSubscribe()` / `onUnsubscribe()` フックで副作用（タイマー、イベントリスナー）を管理する

- **Identity Function パターン** (分類: 生成 — 型レベル)
  - 解決する問題: ランタイムコストゼロで TypeScript の型推論を起動する
  - 適用条件: 複雑なジェネリクスをユーザーに書かせたくない場合
  - コード例: `queryOptions.ts:85-87`, `mutationOptions.ts:39-41`
  - 注意点: 実装は `return options` だけ。オーバーロードシグネチャで戻り値の型を切り替えるのがポイント

- **Phantom Type パターン** (分類: 構造 — 型レベル)
  - 解決する問題: 値を変えずに型情報を付加する
  - 適用条件: ある値に関連する型情報を別の場所で利用したい場合
  - コード例: `types.ts:63-82` の `DataTag`
  - 注意点: Symbol で phantom property を定義し、ランタイムには影響しない

## Good Patterns

- **単一オブジェクト引数 + オーバーロードシグネチャ**: `useQuery()` は単一のオプションオブジェクトを引数に取りつつ、`DefinedInitialDataOptions` / `UndefinedInitialDataOptions` のオーバーロードで戻り値の型を切り替える。引数を増やしても破壊的変更にならず、型推論も維持される。
  ```typescript
  // packages/react-query/src/useQuery.ts:20-52
  export function useQuery<...>(
    options: DefinedInitialDataOptions<...>,
    queryClient?: QueryClient,
  ): DefinedUseQueryResult<NoInfer<TData>, TError>

  export function useQuery<...>(
    options: UndefinedInitialDataOptions<...>,
    queryClient?: QueryClient,
  ): UseQueryResult<NoInfer<TData>, TError>

  export function useQuery(options: UseQueryOptions, queryClient?: QueryClient) {
    return useBaseQuery(options, QueryObserver, queryClient)
  }
  ```

- **OmitKeyof を使った API 変種の制限**: Suspense 変種で不整合なオプション（`enabled`, `placeholderData`）を型レベルで除外する。ランタイムバリデーションに頼らず、コンパイル時に不正な使用を検出できる。
  ```typescript
  // packages/react-query/src/types.ts:86-88
  extends OmitKeyof<
    UseQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
    'queryFn' | 'enabled' | 'throwOnError' | 'placeholderData'
  >
  ```

- **notifyManager.batch() による通知の一括化**: 複数のクエリ操作を batch でラップし、UI 更新を最小限にする。フレームワーク側の `batchNotifyFn` を差し替え可能にして、React の `unstable_batchedUpdates` 等と統合できる。
  ```typescript
  // packages/query-core/src/notifyManager.ts:52-64
  batch: <T>(callback: () => T): T => {
    let result
    transactions++
    try {
      result = callback()
    } finally {
      transactions--
      if (!transactions) {
        flush()
      }
    }
    return result
  },
  ```

## Anti-Patterns / 注意点

- **複数引数のオーバーロード（v4 以前の方式）**: 位置引数で `queryKey`, `queryFn`, `options` を別々に受け取る API は、引数の順序でバグが生じやすく、新しいオプションの追加が困難。TanStack Query は v5 で廃止し、codemods で自動マイグレーションを提供した。
  ```typescript
  // Bad: v4 style
  useQuery(["todos"], fetchTodos, { staleTime: 5000 });

  // Better: v5 style — 単一オブジェクト
  useQuery({ queryKey: ["todos"], queryFn: fetchTodos, staleTime: 5000 });
  ```

- **boolean 引数による条件付きクエリ**: `enabled: !!userId` のように boolean でクエリを無効化すると `queryFn` の引数型が `undefined` を含んでしまう。`skipToken` を使えば `queryFn` 自体を型安全に除外できる。
  ```typescript
  // Bad: queryFn 内で userId が undefined の可能性を処理する必要がある
  useQuery({
    queryKey: ["user", userId],
    queryFn: () => fetchUser(userId!), // 非null アサーションが必要
    enabled: !!userId,
  });

  // Better: skipToken で queryFn ごと無効化
  useQuery({
    queryKey: ["user", userId],
    queryFn: userId ? () => fetchUser(userId) : skipToken,
  });
  ```

- **experimental 機能のプレフィックスなし公開**: 不安定な機能を正式 API と同じ名前空間で公開すると、ユーザーが安定性の保証を誤解する。`experimental_` プレフィックスで明示的にオプトインさせるべき。

## 導出ルール

- `[MUST]` パブリック API の引数は単一オプションオブジェクトにする（位置引数の列挙を避ける）
  - 根拠: TanStack Query v5 で位置引数オーバーロードを廃止し単一オブジェクト形式に統一した。オプション追加が非破壊的変更になる（`useBaseQuery.ts:44-49` でバリデーション）
- `[MUST]` 非同期操作の結果型は discriminated union で状態を表現し、各状態で `data` / `error` の型を narrowing する
  - 根拠: `QueryObserverResult` の 5 状態 union により、`status === 'success'` で `data: TData`（非 undefined）が保証される（`types.ts:864-908`）
- `[SHOULD]` 複雑なジェネリクスの手動指定をユーザーに要求せず、アイデンティティ関数（型推論だけを提供し `return options` で返す関数）を提供する
  - 根拠: `queryOptions()` は実行時コストゼロで型推論を提供し、QueryKey にデータ型をタグ付けする（`queryOptions.ts:85-87`）
- `[SHOULD]` オプションが「静的な値」と「動的な関数」の両方を受け付ける設計にし、解決関数（`resolveXxx`）で統一的に処理する
  - 根拠: `StaleTimeFunction`, `Enabled` 型が値 | 関数のユニオンで、`resolveStaleTime()` / `resolveEnabled()` で一元解決される（`utils.ts:112-136`）
- `[SHOULD]` 不安定な機能は `experimental_` プレフィックスで公開し、安定後にプレフィックスを除去して正式 API に昇格する
  - 根拠: `experimental_prefetchInRender`, `experimental_streamedQuery` が同パターンで段階的に公開されている（`types.ts:440`, `index.ts:42`）
- `[SHOULD]` メジャーバージョン間のマイグレーション用 codemods を提供し、ユーザーの移行コストを低減する
  - 根拠: `query-codemods` パッケージに v4→v5 の変換器（`remove-overloads`, `rename-properties`, `is-loading`, `keep-previous-data`）が用意されている
- `[SHOULD]` グローバルなデフォルト型のカスタマイズは、空インターフェースの declaration merging で提供する
  - 根拠: `Register` インターフェースにより `DefaultError`, `QueryMeta` 等をユーザーがプロジェクト単位で上書きできる（`types.ts:39-51`）
- `[SHOULD]` API の変種（Suspense 版等）では矛盾するオプションを `OmitKeyof` / `Exclude` で型レベルで除外する
  - 根拠: `UseSuspenseQueryOptions` が `enabled`, `throwOnError`, `placeholderData` を除外し、不整合をコンパイル時に検出する（`types.ts:81-94`）
- `[AVOID]` 非推奨 API を `@deprecated` JSDoc なしに削除する。代替手段の提示 + 少なくとも 1 メジャーバージョンの猶予期間を設ける
  - 根拠: `isInitialLoading` は `@deprecated` で `isLoading` への移行を案内しつつ、次メジャーバージョンまで残す方針（`types.ts:693-696`）

## 適用チェックリスト

- [ ] パブリック API の引数を単一オプションオブジェクトに統一しているか？位置引数が 3 つ以上あれば単一オブジェクトへの移行を検討する
- [ ] ユーザーに手動でジェネリクスを書かせている箇所がないか？アイデンティティ関数で型推論を自動化できないか検討する
- [ ] 非同期操作の結果型が discriminated union になっているか？`status` フィールドによる型 narrowing が可能か確認する
- [ ] `boolean` だけで条件分岐するオプションに `skipToken` のような型安全な無効化手段を提供しているか？
- [ ] 実験的機能に `experimental_` プレフィックスを付けているか？安定版 API と名前空間が混在していないか確認する
- [ ] 非推奨 API に `@deprecated` JSDoc を付与し、代替 API と削除予定バージョンを明記しているか？
- [ ] フレームワーク非依存のロジックがコアパッケージに分離されているか？UI フレームワーク固有のコードがコアに混入していないか確認する
- [ ] codemods またはマイグレーションガイドを破壊的変更と同時にリリースする準備があるか？
