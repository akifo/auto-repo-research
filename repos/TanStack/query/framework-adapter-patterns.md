# framework-adapter-patterns

> リポジトリ: TanStack/query
> 分析日: 2026-02-17

## 概要

TanStack Query は単一のフレームワーク非依存コア（`query-core`）を 6 つのフレームワーク（React, Vue, Solid, Svelte, Angular, Preact）に適合させるアダプターアーキテクチャを採用している。各アダプターはコアの Observer パターンをフレームワーク固有のリアクティブシステムに橋渡しする薄いレイヤーとして機能する。この設計は「ビジネスロジックの重複ゼロで N フレームワーク対応」を実現しており、マルチフレームワーク対応ライブラリの参照実装として注目に値する。

## 背景にある原則

- **ロジックの一点集約**: 状態管理・キャッシュ・リトライ・ポーリング等のビジネスロジックをすべてフレームワーク非依存のコアに集約し、アダプターには状態の購読と UI 更新のみを委ねるべき。なぜなら N フレームワーク対応でロジックを分散させると、修正が N 箇所に波及し不整合が発生するため。`query-core` がすべてのロジックを持ち、各アダプターの `useBaseQuery` は 50-170 行の薄いラッパーに留まっている（`packages/react-query/src/useBaseQuery.ts`, `packages/svelte-query/src/createBaseQuery.svelte.ts` 等）。

- **Observer による購読インターフェースの統一**: フレームワークが異なっても「購読して変更通知を受け取る」という契約は共通化できる。`Subscribable` 基底クラスが `subscribe(listener): unsubscribe` という最小インターフェースを提供し、すべてのフレームワークアダプターがこの契約を利用して自身のリアクティブシステムに接続している（`packages/query-core/src/subscribable.ts:1-30`）。

- **型はコアで定義し、アダプターで拡張する**: 基盤型（`QueryObserverResult`, `MutationObserverResult` 等）をコアで定義し、各アダプターはフレームワーク固有のラッパー型（Vue の `Ref<>`, Angular の `Signal<>` 等）を追加するだけにすべき。これによりコアの型変更がすべてのアダプターに自動伝播する。

- **API 表面はフレームワーク慣習に合わせる**: コアのインターフェースが同一でも、ユーザー向け API はフレームワークの命名規則・パターンに従うべき。React は `useQuery`、Vue は `useQuery`（ref ベース戻り値）、Solid は `useQuery`（signal ベース）、Svelte は `createQuery`、Angular は `injectQuery` と、各フレームワークのエコシステム慣習に合わせている。

## 実例と分析

### アダプター層の構造: 3 層分離パターン

全アダプターに共通する構造は以下の 3 層に分かれる:

1. **公開 API 関数**（`useQuery`, `createQuery`, `injectQuery`）: Observer クラスを注入して `useBaseQuery` を呼ぶだけの薄いファサード
2. **Base 関数**（`useBaseQuery`, `createBaseQuery`）: Observer を生成し、フレームワーク固有のリアクティブシステムへ接続するブリッジ
3. **コア Observer**（`QueryObserver`, `MutationObserver`）: フレームワーク非依存のビジネスロジック

React の `useQuery` は Observer クラスを Base 関数に渡すだけの 1 行実装:

```typescript
// packages/react-query/src/useQuery.ts:50-52
export function useQuery(options: UseQueryOptions, queryClient?: QueryClient) {
  return useBaseQuery(options, QueryObserver, queryClient);
}
```

Svelte の `createQuery` も同様:

```typescript
// packages/svelte-query/src/createQuery.ts:49-53
export function createQuery(
  options: Accessor<CreateQueryOptions>,
  queryClient?: Accessor<QueryClient>,
) {
  return createBaseQuery(options, QueryObserver, queryClient);
}
```

### リアクティブシステムへのブリッジ手法の比較

各アダプターが Observer の購読通知をフレームワークの更新機構に変換する方法は大きく異なる:

**React**: `useSyncExternalStore` を使用し、外部ストアとして Observer を購読。

```typescript
// packages/react-query/src/useBaseQuery.ts:103-120
React.useSyncExternalStore(
  React.useCallback(
    (onStoreChange) => {
      const unsubscribe = shouldSubscribe
        ? observer.subscribe(notifyManager.batchCalls(onStoreChange))
        : noop;
      observer.updateResult();
      return unsubscribe;
    },
    [observer, shouldSubscribe],
  ),
  () => observer.getCurrentResult(),
  () => observer.getCurrentResult(),
);
```

**Vue**: `reactive()` でラップした状態オブジェクトを作り、Observer の通知で `updateState` を呼んでプロパティを逐次更新。戻り値は `toRefs(readonly(state))` で個々の `Ref` に分解。

```typescript
// packages/vue-query/src/useBaseQuery.ts:112-114
const state = defaultedOptions.value.shallow
  ? shallowReactive(observer.getCurrentResult())
  : reactive(observer.getCurrentResult());
```

**Solid**: `createStore` + `createResource` を組み合わせ、SSR ストリーミングと Suspense に対応。`reconcile` で構造的共有を実現。

```typescript
// packages/solid-query/src/useBaseQuery.ts:148-149
const [state, setState] = createStore<QueryObserverResult<TData, TError>>(observerResult);
```

**Svelte**: Svelte 5 の `$state` と `$effect` を使用し、カスタム `createRawRef` で Proxy ベースのリアクティブ参照を構築。

```typescript
// packages/svelte-query/src/createBaseQuery.svelte.ts:43-48
let observer = $state(
  new Observer<TQueryFnData, TError, TData, TQueryData, TQueryKey>(
    client,
    resolvedOptions,
  ),
);
```

**Angular**: `signal()` + `computed()` + `effect()` を使用し、`signalProxy` でプロパティごとに遅延 `computed` を生成。NgZone の内外を明示的に制御。

```typescript
// packages/angular-query-experimental/src/create-base-query.ts:116-117
return observer.subscribe(
  notifyManager.batchCalls((state) => {
    ngZone.run(() => {
      resultFromSubscriberSignal.set(state);
    });
  }),
);
```

### Observer 注入による拡張性

`useBaseQuery` は具象 Observer クラスをパラメータとして受け取る（Strategy パターン）。これにより `useQuery` は `QueryObserver` を、`useInfiniteQuery` は `InfiniteQueryObserver` を注入でき、Base 関数を共有しつつ異なる Observer のバリエーションに対応する。

```typescript
// packages/react-query/src/useInfiniteQuery.ts（構造的に同一パターン）
export function useInfiniteQuery(options, queryClient) {
  return useBaseQuery(options, InfiniteQueryObserver, queryClient);
}
```

### QueryClient の提供パターンの多様性

QueryClient の DI メカニズムはフレームワークの標準的なパターンに従っている:

| フレームワーク | 提供方法                         | 取得方法              |
| -------------- | -------------------------------- | --------------------- |
| React          | `React.createContext` + Provider | `useContext`          |
| Vue            | `app.provide()` / Vue 2 mixin    | `inject()`            |
| Solid          | `createContext` + Provider       | `useContext`          |
| Svelte         | `setContext` / `getContext`      | `getContext`          |
| Angular        | DI Token (`QueryClient` class)   | `inject(QueryClient)` |

### 結果の Proxy ラッピングによる最適化

React と Svelte はプロパティアクセス追跡のために `Proxy` を使用する。Angular は `signalProxy` で各プロパティを遅延的に `computed` シグナルに変換する。

```typescript
// packages/angular-query-experimental/src/signal-proxy.ts:19-31
return new Proxy<MapToSignals<TInput>>(internalState, {
  get(target, prop) {
    const computedField = target[prop];
    if (computedField) return computedField;
    const targetField = untracked(inputSignal)[prop];
    if (typeof targetField === "function") return targetField;
    return (target[prop] = computed(() => inputSignal()[prop]));
  },
});
```

React では `observer.trackResult` が Proxy を使い、アクセスされたプロパティのみを追跡して不要な再レンダリングを防ぐ:

```typescript
// packages/query-core/src/queryObserver.ts:267-287
trackResult(result, onPropTracked) {
  return new Proxy(result, {
    get: (target, key) => {
      this.trackProp(key as keyof QueryObserverResult)
      onPropTracked?.(key as keyof QueryObserverResult)
      return Reflect.get(target, key)
    },
  })
}
```

### Vue 固有: Ref アンラッピングの深層処理

Vue アダプターは `MaybeRefDeep<T>` 型と `cloneDeepUnref` ユーティリティにより、ネストされた Ref を再帰的にアンラップする。これはフレームワーク固有の reactivity primitive をコアの plain object に変換する重要なブリッジ処理:

```typescript
// packages/vue-query/src/utils.ts:70-97
export function cloneDeepUnref<T>(obj: MaybeRefDeep<T>, unrefGetters = false): T {
  return cloneDeep(obj, (val, key, level) => {
    if (level === 1 && key === "queryKey") {
      return cloneDeepUnref(val, true);
    }
    if (unrefGetters && isFunction(val)) {
      return cloneDeepUnref((val as Function)(), unrefGetters);
    }
    if (isRef(val)) {
      return cloneDeepUnref(unref(val), unrefGetters);
    }
    return undefined;
  });
}
```

## パターンカタログ

- **Observer パターン** (分類: 振る舞い)
  - 解決する問題: フレームワーク非依存のコアが状態変更をアダプターに通知する必要がある
  - 適用条件: 購読者の数や種類が可変で、通知の仕組みを統一したい場合
  - コード例: `packages/query-core/src/subscribable.ts:1-30`, `packages/query-core/src/queryObserver.ts:40-46`
  - 注意点: `Subscribable` は `Set<TListener>` で管理し、同一リスナーの重複登録を自動防止

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: `useBaseQuery` が `QueryObserver` / `InfiniteQueryObserver` を切り替えて異なる振る舞いを実現
  - 適用条件: 共通のフロー（購読・結果取得・クリーンアップ）の中で一部の振る舞いを差し替えたい場合
  - コード例: `packages/react-query/src/useQuery.ts:50-52` vs `packages/react-query/src/useInfiniteQuery.ts`
  - 注意点: Observer はコンストラクタで注入されるため、実行時の切り替えには対応しない

- **Adapter パターン** (分類: 構造)
  - 解決する問題: コアの命令的な `subscribe/getCurrentResult` インターフェースをフレームワーク固有の宣言的 API に変換
  - 適用条件: 既存のインターフェースを別のインターフェースに適合させたい場合
  - コード例: 各 `useBaseQuery` / `createBaseQuery` 実装
  - 注意点: アダプターがコアのロジックを複製し始めたら設計の警告サイン

- **Proxy パターン** (分類: 構造)
  - 解決する問題: プロパティアクセスを透過的にインターセプトし、追跡・遅延評価・リアクティブ変換を実現
  - 適用条件: オブジェクトのプロパティアクセスに副作用（追跡、遅延初期化）を持たせたい場合
  - コード例: `packages/angular-query-experimental/src/signal-proxy.ts:14-46`, `packages/query-core/src/queryObserver.ts:263-287`

## Good Patterns

- **Identity function による型安全なオプション構築**: `queryOptions()` は実行時には引数をそのまま返す identity function だが、TypeScript の型推論を活用して `queryKey` に `DataTag` を付与する。これにより `queryClient.getQueryData(queryKey)` の戻り値型が自動推論される。

```typescript
// packages/react-query/src/queryOptions.ts:85-87
export function queryOptions(options: unknown) {
  return options;
}
```

- **notifyManager.batchCalls による更新の一括化**: Observer の通知をフレームワークのバッチ更新機構と統合する。React では `useSyncExternalStore` のコールバックを、Angular では `ngZone.run` の中で `batchCalls` にラップし、複数の状態更新を 1 回の再レンダリングにまとめる。

```typescript
// packages/react-query/src/useBaseQuery.ts:107
observer.subscribe(notifyManager.batchCalls(onStoreChange));
```

- **getOptimisticResult によるチラつき防止**: 購読前に楽観的な結果を取得し、初回レンダリングから正しい状態を表示する。これにより「ローディング → 即座にデータ表示」のチラつきを防ぐ。

```typescript
// packages/react-query/src/useBaseQuery.ts:100
const result = observer.getOptimisticResult(defaultedOptions);
```

- **フレームワーク慣習に準拠した命名の徹底**: 同一の内部処理でも API 名はフレームワーク慣習に厳密に従う。React/Vue は `use*`、Svelte は `create*`、Angular は `inject*`。これによりフレームワークユーザーに認知負荷を与えない。

## Anti-Patterns / 注意点

- **アダプターにビジネスロジックを漏出させる**: コアの Observer が担うべきロジック（キャッシュ管理、リトライ、ポーリング等）をアダプター側に実装すると、フレームワーク間で不整合が生じる。

```typescript
// Bad: アダプター内でキャッシュ無効化ロジックを実装
function useQuery(options) {
  const result = useBaseQuery(options, QueryObserver);
  // アダプターでキャッシュ制御 → フレームワーク間で不整合の原因
  if (result.isStale) queryClient.invalidateQueries(options.queryKey);
  return result;
}
```

```typescript
// Better: コアの Observer にロジックを集約
// queryObserver.ts 内の onSubscribe/setOptions でキャッシュ制御を行い、
// アダプターは購読と結果の変換のみに専念する
```

- **コアの型をアダプターで再定義する**: コアで定義済みの `QueryObserverResult` をアダプターで再定義すると、コアの型変更が伝播しない。

```typescript
// Bad: アダプターで独自の結果型を定義
interface MyQueryResult {
  data: any;
  isLoading: boolean;
  error: any;
}

// Better: コアの型をフレームワーク固有の型で拡張する
type UseQueryResult<TData, TError> = QueryObserverResult<TData, TError>;
// Vue の場合: 各プロパティを Ref に変換する型マッピング
type UseBaseQueryReturnType<TData, TError> = {
  [K in keyof TResult]: K extends "refetch" ? TResult[K] : Ref<Readonly<TResult>[K]>;
};
```

- **フレームワーク固有の更新機構を無視した直接的な状態変更**: Angular で `ngZone.runOutsideAngular` を使わずに頻繁な購読通知を処理すると、不要な変更検出サイクルが走る。

```typescript
// Bad: Angular で Zone 内で直接購読
observer.subscribe((state) => {
  resultSignal.set(state); // 毎回 Zone 内で変更検出が走る
});

// Better: Zone 外で購読し、必要時のみ Zone 内で更新
ngZone.runOutsideAngular(() => {
  observer.subscribe(notifyManager.batchCalls((state) => {
    ngZone.run(() => resultSignal.set(state));
  }));
});
```

## 導出ルール

- `[MUST]` フレームワーク非依存のビジネスロジックとフレームワーク固有の UI 結合コードを物理的に別パッケージ（または別モジュール）に分離する
  - 根拠: TanStack Query はコア（`query-core`）と 6 アダプターを分離し、コアにすべてのキャッシュ・リトライ・ポーリングロジックを集約。アダプターは 50-170 行の購読ブリッジに留まる（`packages/react-query/src/useBaseQuery.ts` 等）
- `[MUST]` アダプター層は「購読・結果変換・クリーンアップ」の 3 責務のみ担い、ビジネスロジックをコア側に集約する
  - 根拠: 全 6 アダプターが `observer.subscribe()` → 状態更新 → `onCleanup`/`useEffect` で購読解除という同一パターンに従い、判断ロジックはコアの `QueryObserver.createResult()` に集約されている
- `[SHOULD]` マルチフレームワーク対応の共通コアは `subscribe(listener): unsubscribe` 形式の Observable 契約を公開インターフェースとする
  - 根拠: `Subscribable` 基底クラスのこの契約により、React の `useSyncExternalStore`、Vue の `watch`、Solid の `createResource`、Svelte の `$effect`、Angular の `effect` すべてに対応可能（`packages/query-core/src/subscribable.ts:8-16`）
- `[SHOULD]` 公開 API はフレームワークの命名規則・パターンに厳密に従い、内部実装の命名と一致させる必要はない
  - 根拠: React/Vue は `useQuery`、Svelte は `createQuery`、Angular は `injectQuery` と、同一機能に対してフレームワーク慣習の接頭辞を使い分けている
- `[SHOULD]` フレームワーク固有のリアクティブ値（Ref, Signal, Store 等）をコアに渡す前に plain value に変換するブリッジユーティリティを用意する
  - 根拠: Vue アダプターは `cloneDeepUnref` で Ref を再帰的にアンラップしてからコアの `defaultQueryOptions` に渡す。コアがフレームワーク固有の reactivity primitive に依存しないことを保証する手法（`packages/vue-query/src/utils.ts:70-97`）
- `[SHOULD]` Observer バリエーション（Query/InfiniteQuery/Mutation）は Base 関数への Strategy 注入で対応し、Base 関数を複製しない
  - 根拠: 全アダプターで `useQuery` は `useBaseQuery(options, QueryObserver)`, `useInfiniteQuery` は `useBaseQuery(options, InfiniteQueryObserver)` と Observer クラスを注入するだけで、Base 関数のコードは共有されている
- `[AVOID]` コアの Observer が返す結果オブジェクトの型をアダプターで再定義する。コアの型を拡張（`extends`/`Override`/型マッピング）して使う
  - 根拠: React は `UseQueryResult = QueryObserverResult<TData, TError>` とコアの型を直接使い、Vue は `UseBaseQueryReturnType` で `Ref<>` マッピングを追加するだけに留めている（`packages/react-query/src/types.ts:155-158`, `packages/vue-query/src/useBaseQuery.ts:27-40`）

## 適用チェックリスト

- [ ] ライブラリのビジネスロジック（キャッシュ管理、リトライ、バリデーション等）がフレームワーク非依存のコアモジュールに分離されているか
- [ ] コアモジュールは `subscribe(listener): unsubscribe` 形式の購読インターフェースを提供しているか
- [ ] アダプター層の各ファイルが 200 行以下に収まっており、ビジネスロジックが漏出していないか
- [ ] フレームワーク固有のリアクティブ値（Ref, Signal 等）をコアに渡す前に plain value に変換するブリッジが存在するか
- [ ] 公開 API の命名がターゲットフレームワークの慣習（`use*`, `create*`, `inject*` 等）に従っているか
- [ ] コアの型定義を各アダプターが再定義せず、拡張または型マッピングで利用しているか
- [ ] Observer の購読解除（`unsubscribe`）がフレームワークのライフサイクル（`useEffect` cleanup, `onScopeDispose`, `onCleanup` 等）で確実に呼ばれているか
- [ ] 更新通知がフレームワークのバッチ更新機構（`useSyncExternalStore`, `notifyManager.batchCalls`, `ngZone.run` 等）と統合されているか
