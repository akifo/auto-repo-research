# Architecture

> リポジトリ: TanStack/query
> 分析日: 2026-02-17

## 概要

TanStack Query はフレームワーク非依存のコアライブラリ `query-core` を中心に、React / Vue / Solid / Svelte / Angular の 5 つのフレームワークアダプターを持つモノレポである。この構成は「コアにビジネスロジックとステートマシンを閉じ込め、フレームワーク固有のリアクティビティ機構だけをアダプター層に委譲する」という徹底した関心分離を実現している。24 パッケージ・895 ソースファイルという規模でありながら、コア層のインターフェースが安定しているため、6 つの UI フレームワーク向けアダプターを同時にメンテナンスできている点が注目に値する。

## 背景にある原則

- **フレームワークは変わるがドメインロジックは変わらない**: キャッシュ管理・再試行・GC・状態遷移といったデータ同期の本質的ロジックを `query-core` に閉じ込めることで、フレームワークの API 変更や新フレームワーク追加の影響をアダプター層だけに限定している。コアの `QueryClient`, `QueryObserver`, `QueryCache` はフレームワーク固有の import を一切持たない (`query-core/src/queryClient.ts:1-14`)。
- **Observer パターンで購読境界を明確にする**: コアの状態変更はすべて Observer を介してアダプターに伝播する。アダプターはフレームワーク固有の購読メカニズム（React の `useSyncExternalStore`, Vue の `watch`, Solid の `createResource`）で Observer を接続するだけでよい。これにより、コアは「何を通知するか」だけを知り、「どう再レンダリングするか」は知らない。
- **抽象クラスでライフサイクルの骨格を強制する**: `Subscribable` と `Removable` という 2 つの小さな基底クラスが、購読管理と GC タイマーの共通パターンを提供する。具体クラス（`QueryObserver`, `Query`, `Mutation`）はこの骨格に従うことで、一貫したライフサイクル管理が保証される。
- **環境依存を注入可能なシングルトンに隔離する**: `focusManager`, `onlineManager`, `notifyManager`, `timeoutManager` はシングルトンだが、すべて `setEventListener` / `setBatchNotifyFunction` / `setTimeoutProvider` で挙動を差し替えられる。テスト容易性とプラットフォーム適応性を両立している。

## 実例と分析

### コア層のクラス階層と責務分離

`query-core` のクラス群は明確な責務分離を持つ。

| クラス             | 責務                                    | 基底クラス     |
| ------------------ | --------------------------------------- | -------------- |
| `Subscribable<T>`  | リスナー管理（add/remove/notify）       | -              |
| `Removable`        | GC タイマー管理                         | -              |
| `Query`            | 個別クエリの状態マシン + フェッチ実行   | `Removable`    |
| `Mutation`         | 個別ミューテーションの状態マシン        | `Removable`    |
| `QueryCache`       | Query インスタンスのコレクション管理    | `Subscribable` |
| `MutationCache`    | Mutation インスタンスのコレクション管理 | `Subscribable` |
| `QueryObserver`    | Query の状態を購読し、変更通知を発行    | `Subscribable` |
| `MutationObserver` | Mutation の状態を購読し、変更通知を発行 | `Subscribable` |
| `QueryClient`      | ファサード（全体の統合 API）            | -              |

`Query` と `Mutation` は `Removable` を継承して GC を管理し、`QueryObserver` と `MutationObserver` は `Subscribable` を継承して購読を管理する。この 2 つの関心が基底クラスレベルで分離されている。

### アダプター層の共通パターン

各フレームワークアダプターは驚くほど類似した構造を持つ。いずれも以下の 3 ステップで実装される:

1. **QueryClient の取得**: フレームワーク固有の DI 機構を使う
2. **Observer の生成と購読**: コアの `QueryObserver` をフレームワークのリアクティビティに接続
3. **結果の変換**: フレームワーク固有の形式に変換して返却

```typescript
// React: packages/react-query/src/useBaseQuery.ts:91-119
const [observer] = React.useState(
  () => new Observer<...>(client, defaultedOptions),
)
const result = observer.getOptimisticResult(defaultedOptions)
React.useSyncExternalStore(
  React.useCallback(
    (onStoreChange) => {
      const unsubscribe = shouldSubscribe
        ? observer.subscribe(notifyManager.batchCalls(onStoreChange))
        : noop
      observer.updateResult()
      return unsubscribe
    },
    [observer, shouldSubscribe],
  ),
  () => observer.getCurrentResult(),
  () => observer.getCurrentResult(),
)
```

```typescript
// Vue: packages/vue-query/src/useBaseQuery.ts:110-143
const observer = new Observer(client, defaultedOptions.value);
const state = reactive(observer.getCurrentResult());
// watch で購読を管理
watch(defaultedOptions, updater);
onScopeDispose(() => {
  unsubscribe();
});
```

```typescript
// Angular: packages/angular-query-experimental/src/create-base-query.ts:66-78
const observerSignal = (() => {
  let instance = null;
  return computed(() => {
    return (instance ||= new Observer(queryClient, defaultedOptionsSignal()));
  });
})();
```

各アダプターのコア差分は「フレームワーク固有のリアクティビティへの橋渡し」だけであり、状態管理ロジック・キャッシュ制御・再試行ロジック等は一切重複していない。

### Behavior パターンによるフェッチ戦略の差し替え

`Query.fetch()` は直接フェッチロジックを持たず、`QueryBehavior` インターフェースを通じてフェッチ戦略を差し替えられる:

```typescript
// packages/query-core/src/query.ts:78-88
export interface QueryBehavior<...> {
  onFetch: (
    context: FetchContext<TQueryFnData, TError, TData, TQueryKey>,
    query: Query,
  ) => void
}
```

`infiniteQueryBehavior` はこのインターフェースを実装し、ページネーションロジックを `Query` の外側に定義している (`packages/query-core/src/infiniteQueryBehavior.ts:16-130`)。`Query` クラス自身は infinite query の概念を知らず、`context.fetchFn` を差し替えるだけで動作が変わる。これは Strategy パターンの適用である。

### 環境抽象化レイヤー

コアはブラウザ API に直接依存せず、差し替え可能なマネージャー群を介して環境にアクセスする:

```typescript
// packages/query-core/src/focusManager.ts:48-57
setEventListener(setup: SetupFn): void {
  this.#setup = setup
  this.#cleanup?.()
  this.#cleanup = setup((focused) => {
    if (typeof focused === 'boolean') {
      this.setFocused(focused)
    } else {
      this.onFocus()
    }
  })
}
```

```typescript
// packages/query-core/src/timeoutManager.ts:62-124
export class TimeoutManager implements Omit<TimeoutProvider, 'name'> {
  #provider: TimeoutProvider<any> = defaultTimeoutProvider

  setTimeoutProvider<TTimerId extends ManagedTimerId>(
    provider: TimeoutProvider<TTimerId>,
  ): void { ... }
}
```

`FocusManager` と `OnlineManager` はデフォルトで `window.addEventListener` を使うが、`setEventListener` で React Native やテスト環境向けに差し替えられる。`TimeoutManager` は `setTimeout`/`setInterval` のプロバイダーを差し替え可能にし、大量タイマーの最適化を外部に委譲できる。

### NotifyManager によるバッチ通知

状態変更の通知は `notifyManager.batch()` で集約される。これにより、複数の状態変更が 1 回の再レンダリングにまとめられる:

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

さらに `setBatchNotifyFunction` で React の `unstable_batchedUpdates` 等を注入できるため、フレームワーク固有のバッチ最適化をコアの変更なしに適用できる。

## パターンカタログ

- **Observer パターン** (分類: 振る舞い)
  - 解決する問題: コアの状態変更を、コアが知らない複数のフレームワークに通知する
  - 適用条件: 1 つの状態ソースを複数の消費者が購読する必要があるとき
  - コード例: `packages/query-core/src/subscribable.ts:1-30`, `packages/query-core/src/queryObserver.ts:40-46`
  - 注意点: `Subscribable` が購読解除関数を返す設計により、リスナーのメモリリークを防いでいる

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 通常クエリと infinite クエリでフェッチ戦略が異なる
  - 適用条件: 同じコンテキストで異なるアルゴリズムを差し替えたいとき
  - コード例: `packages/query-core/src/query.ts:78-88` (QueryBehavior), `packages/query-core/src/infiniteQueryBehavior.ts:16-130`
  - 注意点: `Query.fetch()` 内で `context.fetchFn` を差し替えるため、Query クラスの変更なしに新しいフェッチ戦略を追加できる

- **Facade パターン** (分類: 構造)
  - 解決する問題: `QueryCache`, `MutationCache`, `FocusManager` 等の複雑なサブシステムへの統一アクセス
  - 適用条件: 複数のサブシステムをまとめて扱う公開 API が必要なとき
  - コード例: `packages/query-core/src/queryClient.ts:61-648`
  - 注意点: `QueryClient` は `#queryCache`, `#mutationCache` を private フィールドで保持し、直接操作を防いでいる

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: 購読管理と GC 管理のライフサイクルを統一しつつ、具体的な振る舞いをサブクラスに委譲する
  - 適用条件: アルゴリズムの骨格は共通だが、一部ステップがサブクラスごとに異なるとき
  - コード例: `packages/query-core/src/subscribable.ts:23-29` (`onSubscribe`/`onUnsubscribe`), `packages/query-core/src/removable.ts:38` (`optionalRemove`)

## Good Patterns

- **Subscribable 基底クラスの subscribe が unsubscribe 関数を返す設計**: 購読と購読解除を 1 つの呼び出しに結合することで、リスナーの参照が呼び出し側に閉じ込められ、解除忘れを防ぐ。React の `useEffect` クリーンアップや Vue の `onScopeDispose` と自然に統合できる。

```typescript
// packages/query-core/src/subscribable.ts:8-17
subscribe(listener: TListener): () => void {
  this.listeners.add(listener)
  this.onSubscribe()
  return () => {
    this.listeners.delete(listener)
    this.onUnsubscribe()
  }
}
```

- **Private フィールド (#) によるカプセル化**: `QueryClient`, `Query`, `QueryObserver` 等のクラスは ES2022 の `#` private フィールドを活用し、内部状態への外部アクセスを完全に遮断している。TypeScript の `private` 修飾子ではなくランタイムレベルの private を使う点が重要。

```typescript
// packages/query-core/src/queryClient.ts:62-68
export class QueryClient {
  #queryCache: QueryCache
  #mutationCache: MutationCache
  #defaultOptions: DefaultOptions
  #queryDefaults: Map<string, QueryDefaults>
  #mutationDefaults: Map<string, MutationDefaults>
  #mountCount: number
```

- **Reducer パターンによる状態遷移の集中管理**: `Query` と `Mutation` の状態遷移は `#dispatch` メソッド内の reducer 関数で管理される。Action の型が discriminated union で定義されており、すべての状態遷移が網羅的に処理される。

```typescript
// packages/query-core/src/query.ts:143-151
export type Action<TData, TError> =
  | ContinueAction
  | ErrorAction<TError>
  | FailedAction<TError>
  | FetchAction
  | InvalidateAction
  | PauseAction
  | SetStateAction<TData, TError>
  | SuccessAction<TData>;
```

- **アダプター層は Observer のコンストラクタを引数で受け取る**: `useBaseQuery` は `Observer: typeof QueryObserver` を引数に取る。これにより `QueryObserver` と `InfiniteQueryObserver` を同じ `useBaseQuery` で扱える。

```typescript
// packages/react-query/src/useBaseQuery.ts:27-43
export function useBaseQuery<...>(
  options: UseBaseQueryOptions<...>,
  Observer: typeof QueryObserver,  // コンストラクタ注入
  queryClient?: QueryClient,
): QueryObserverResult<TData, TError> {
```

## Anti-Patterns / 注意点

- **コアに環境固有コードを直接埋め込む**: コアがブラウザ API を直接参照すると、SSR やテスト環境で動作しなくなる。TanStack Query では `isServer` ガードと差し替え可能なマネージャーで回避しているが、デフォルトの `FocusManager` が `window.addEventListener` を直接参照する箇所があり、これは `isServer` チェックで保護されている。

```typescript
// Bad: コアで直接 window を参照
class FocusManager {
  constructor() {
    window.addEventListener("visibilitychange", this.onFocus);
  }
}

// Better: セットアップ関数を注入可能にする（実際の実装）
// packages/query-core/src/focusManager.ts:18-32
this.#setup = (onFocus) => {
  if (!isServer && window.addEventListener) {
    const listener = () => onFocus();
    window.addEventListener("visibilitychange", listener, false);
    return () => {
      window.removeEventListener("visibilitychange", listener);
    };
  }
  return;
};
```

- **アダプター層にコアロジックを漏洩させる**: アダプター層でキャッシュ操作やフェッチ判定を再実装すると、フレームワーク間で不整合が発生する。TanStack Query では `shouldFetchOnMount` 等の判定ロジックもコア側に置き、アダプターからは呼び出すだけにしている。

```typescript
// Bad: アダプター側で独自に stale 判定を実装
function useQuery(options) {
  if (Date.now() - cache.updatedAt > options.staleTime) {
    refetch()
  }
}

// Better: コアの Observer に判定を委譲（実際の実装）
// packages/query-core/src/queryObserver.ts:99-106
protected onSubscribe(): void {
  if (this.listeners.size === 1) {
    this.#currentQuery.addObserver(this)
    if (shouldFetchOnMount(this.#currentQuery, this.options)) {
      this.#executeFetch()
    }
  }
}
```

## 導出ルール

- `[MUST]` フレームワーク非依存のコアパッケージにはフレームワーク固有の import を一切含めない
  - 根拠: `query-core` は React / Vue / Solid / Svelte / Angular いずれの import も持たず、6 つのフレームワークアダプターが同一コアを共有できている (`query-core/src/` 全ファイル)

- `[MUST]` コアの状態遷移は discriminated union の Action 型と reducer 関数で管理し、状態変更の入口を単一にする
  - 根拠: `Query.#dispatch` と `Mutation.#dispatch` が全状態遷移を集中管理しており、状態の不整合を防いでいる (`query-core/src/query.ts:607-687`, `query-core/src/mutation.ts:331-398`)

- `[SHOULD]` 購読ベースの API では subscribe 関数が unsubscribe 関数を返す設計にする
  - 根拠: `Subscribable.subscribe()` が返す unsubscribe 関数により、React の useEffect クリーンアップ・Vue の onScopeDispose・Angular の onCleanup と自然に統合できる (`query-core/src/subscribable.ts:8-17`)

- `[SHOULD]` 環境依存（タイマー・ネットワーク検知・フォーカス検知）はシングルトンマネージャーに隔離し、セットアップ関数で差し替え可能にする
  - 根拠: `FocusManager.setEventListener`, `OnlineManager.setEventListener`, `TimeoutManager.setTimeoutProvider` により、ブラウザ・React Native・テスト環境を同一コアで扱える (`query-core/src/focusManager.ts:48-57`, `query-core/src/timeoutManager.ts:72-99`)

- `[SHOULD]` アダプター層は「コアの Observer を生成し、フレームワーク固有のリアクティビティに接続する」という最小責務に留める
  - 根拠: 5 つのフレームワークアダプターの `useBaseQuery` / `createBaseQuery` はいずれも Observer の生成・購読・結果変換の 3 ステップで構成され、キャッシュ操作やフェッチ判定のロジックを一切含まない (`react-query/src/useBaseQuery.ts`, `vue-query/src/useBaseQuery.ts`, `angular-query-experimental/src/create-base-query.ts`)

- `[SHOULD]` 通知のバッチ処理をコアレベルで提供し、フレームワーク固有のバッチ関数を注入可能にする
  - 根拠: `notifyManager.batch()` がトランザクションカウンターで通知を集約し、`setBatchNotifyFunction` で React の `unstable_batchedUpdates` 等を注入できる (`query-core/src/notifyManager.ts:17-96`)

- `[AVOID]` アダプター層でコアのキャッシュ操作・状態判定ロジックを再実装する
  - 根拠: `shouldFetchOnMount`, `shouldFetchOptionally`, `isStale` 等の判定はすべてコア側に定義されており、アダプター間で一貫した動作を保証している (`query-core/src/queryObserver.ts:744-805`)

## 適用チェックリスト

- [ ] ライブラリのビジネスロジック（状態管理・キャッシュ・リトライ等）がフレームワーク固有の import なしに動作するか
- [ ] フレームワーク固有のコードが「コアの Observer を購読する薄いアダプター」に収まっているか
- [ ] 状態遷移が Action + reducer の単一入口で管理されているか（散在する `setState` 呼び出しになっていないか）
- [ ] subscribe が unsubscribe 関数を返す設計になっているか（各フレームワークのクリーンアップ機構と統合可能か）
- [ ] 環境依存（タイマー・ネットワーク・DOM イベント）が差し替え可能な抽象化レイヤーに隔離されているか
- [ ] 通知のバッチ処理がコアレベルで提供され、フレームワーク固有の最適化を注入できるか
- [ ] 基底クラス（Subscribable / Removable 相当）で共通ライフサイクルが統一されているか
