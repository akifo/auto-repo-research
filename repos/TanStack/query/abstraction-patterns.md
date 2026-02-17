# abstraction-patterns

> リポジトリ: TanStack/query
> 分析日: 2026-02-17

## 概要

TanStack Query のコア抽象とフレームワークアダプターの共通インターフェース設計を分析した。24パッケージのモノレポにおいて、`query-core` がフレームワーク非依存のビジネスロジックを担い、6つのフレームワークアダプター（React, Vue, Solid, Svelte, Angular, Preact）が各フレームワークのリアクティビティシステムに橋渡しする。この分離は「Observer パターンを軸にしたコアと薄いアダプター層」という設計で実現されており、マルチフレームワーク対応ライブラリの手本となる。

## 背景にある原則

- **ビジネスロジックをフレームワークから完全に分離すべき。なぜなら、リアクティビティの実装は各フレームワークで異なるが、状態管理のロジック自体は共通だから**: `query-core` には React/Vue/Solid 等への依存が一切なく、Observer パターンだけでリアクティビティとの接続点を提供する（`subscribable.ts:1-30`）。フレームワーク固有のコードはアダプター側の `useBaseQuery` / `createBaseQuery` に閉じ込められている。

- **subscribe/unsubscribe のライフサイクルフックで副作用を制御すべき。なぜなら、リソースの獲得・解放タイミングを抽象化することで、上位層がリソース管理を意識せずに済むから**: `Subscribable` の `onSubscribe`/`onUnsubscribe` テンプレートメソッドにより、QueryObserver は最初のリスナー追加時にクエリに自身を登録し、最後のリスナー解除時に自動的にクリーンアップする（`queryObserver.ts:95-113`）。FocusManager / OnlineManager も同じパターンで、リスナーがいる間だけイベントリスナーを登録する。

- **通知のバッチ処理をコア層で抽象化すべき。なぜなら、フレームワークごとの最適な更新バッチ方式（React.unstable_batchedUpdates 等）を差し替え可能にするため**: `notifyManager` はトランザクションカウンターでバッチ処理を実現し、`setBatchNotifyFunction` で外部からバッチ関数を差し替え可能にしている（`notifyManager.ts:17-96`）。

- **コアの拡張はクラス継承ではなく戦略オブジェクト（Strategy / Behavior）で行うべき。なぜなら、機能バリエーション（通常クエリ vs 無限スクロール）をコアの修正なしに追加できるから**: `QueryBehavior` インターフェース（`query.ts:78-88`）により、`infiniteQueryBehavior` が `onFetch` を差し替えてページネーションロジックを注入する。Query クラス自体の変更は不要。

## 実例と分析

### 1. Subscribable 基底クラス — Observer パターンの最小抽象

コア全体のリアクティビティ基盤は、わずか 30 行の `Subscribable` クラスに集約される。

```typescript
// packages/query-core/src/subscribable.ts:1-30
export class Subscribable<TListener extends Function> {
  protected listeners = new Set<TListener>()

  subscribe(listener: TListener): () => void {
    this.listeners.add(listener)
    this.onSubscribe()
    return () => {
      this.listeners.delete(listener)
      this.onUnsubscribe()
    }
  }

  protected onSubscribe(): void { /* Do nothing */ }
  protected onUnsubscribe(): void { /* Do nothing */ }
}
```

このクラスを継承するのは `QueryObserver`、`MutationObserver`、`QueriesObserver`、`QueryCache`、`MutationCache`、`FocusManager`、`OnlineManager` の 7 クラス。`subscribe` が返す unsubscribe 関数は、各フレームワークのクリーンアップ機構（React の `useEffect` return、Vue の `onScopeDispose`、Solid の `onCleanup`、Angular の `effect` の `onCleanup`）に直接渡せる設計。

### 2. Observer 階層 — 特化は継承、合成は委譲

Observer の階層構造が明確に設計されている。

```
Subscribable<TListener>
├── QueryObserver         (単一クエリの監視)
│   └── InfiniteQueryObserver  (ページネーション付きクエリの監視)
├── QueriesObserver       (複数 QueryObserver の合成)
├── MutationObserver      (ミューテーションの監視)
├── QueryCache            (全クエリの管理 + イベント通知)
├── MutationCache         (全ミューテーションの管理)
├── FocusManager          (ウィンドウフォーカス状態)
└── OnlineManager         (ネットワーク接続状態)
```

`InfiniteQueryObserver` は `QueryObserver` を継承し、`fetchNextPage`/`fetchPreviousPage` を追加する（`infiniteQueryObserver.ts:26-38`）。一方、`QueriesObserver` は複数の `QueryObserver` インスタンスを内部に持ち、結果を合成する委譲パターンを使う（`queriesObserver.ts:35-80`）。

### 3. Removable 基底クラス — GC ライフサイクルの抽象化

```typescript
// packages/query-core/src/removable.ts:5-39
export abstract class Removable {
  gcTime!: number
  #gcTimeout?: ManagedTimerId

  protected scheduleGc(): void {
    this.clearGcTimeout()
    if (isValidTimeout(this.gcTime)) {
      this.#gcTimeout = timeoutManager.setTimeout(() => {
        this.optionalRemove()
      }, this.gcTime)
    }
  }

  protected abstract optionalRemove(): void
}
```

`Query` と `Mutation` がこれを継承する。`Query.optionalRemove()` はオブザーバーがいない場合にのみキャッシュから自身を削除する（`query.ts:221-225`）。テンプレートメソッドパターンにより、「いつ GC するか」と「GC 条件を満たすか」の判断を分離している。

### 4. アダプター層の共通契約 — useBaseQuery パターン

全 6 アダプターが同一の構造を持つ。

| フレームワーク | ファイル | Observer の受け取り方 | subscribe の方法 |
|---|---|---|---|
| React | `useBaseQuery.ts` | 引数で Observer クラスを受取 | `useSyncExternalStore` |
| Vue | `useBaseQuery.ts` | 引数で Observer クラスを受取 | `watch` + `observer.subscribe` |
| Solid | `useBaseQuery.ts` | 引数で Observer クラスを受取 | `createResource` + `observer.subscribe` |
| Svelte | `createBaseQuery.svelte.ts` | 引数で Observer クラスを受取 | `$effect` + `observer.subscribe` |
| Angular | `create-base-query.ts` | 引数で Observer クラスを受取 | `effect` + `observer.subscribe` |
| Preact | `useBaseQuery.ts` | 引数で Observer クラスを受取 | `useSyncExternalStore` |

共通パターン:
1. QueryClient を取得（Context / DI / Provider から）
2. `client.defaultQueryOptions(options)` でデフォルト適用
3. `new Observer(client, defaultedOptions)` でコアのオブザーバーを生成
4. `observer.getOptimisticResult(options)` で初期値取得
5. `observer.subscribe(callback)` でフレームワークのリアクティブシステムに接続
6. オプション変更時に `observer.setOptions(newOptions)` を呼ぶ

```typescript
// packages/react-query/src/useQuery.ts:50-52
// useQuery は useBaseQuery に Observer クラスを渡すだけの薄いラッパー
export function useQuery(options: UseQueryOptions, queryClient?: QueryClient) {
  return useBaseQuery(options, QueryObserver, queryClient)
}
```

### 5. NotifyManager — フレームワーク横断のバッチング抽象

```typescript
// packages/query-core/src/notifyManager.ts:17-96
export function createNotifyManager() {
  let queue: Array<NotifyCallback> = []
  let transactions = 0

  return {
    batch: <T>(callback: () => T): T => {
      transactions++
      try { result = callback() }
      finally {
        transactions--
        if (!transactions) { flush() }
      }
      return result
    },
    setBatchNotifyFunction: (fn: BatchNotifyFunction) => {
      batchNotifyFn = fn
    },
  }
}
```

React アダプターは `setBatchNotifyFunction` に `React.unstable_batchedUpdates` を設定できる。Angular は `NgZone.run` 内で通知する。この設計により、コアコードはフレームワークのバッチ更新メカニズムを知らずに済む。

### 6. QueryBehavior — Strategy パターンによるフェッチ戦略の差し替え

```typescript
// packages/query-core/src/query.ts:78-88
export interface QueryBehavior<TQueryFnData, TError, TData, TQueryKey> {
  onFetch: (
    context: FetchContext<TQueryFnData, TError, TData, TQueryKey>,
    query: Query,
  ) => void
}

// packages/query-core/src/query.ts:502
// Query.fetch() 内で behavior を呼び出す
this.options.behavior?.onFetch(context, this as unknown as Query)
```

`infiniteQueryBehavior` はこの `onFetch` フックで `context.fetchFn` をページネーション対応版に差し替える（`infiniteQueryBehavior.ts:16-130`）。Query クラスを継承せずに振る舞いを変更できる。

### 7. イベントリスナーの差し替え可能性 — setEventListener パターン

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

`FocusManager` と `OnlineManager` はデフォルトで `window.addEventListener` を使うが、`setEventListener` でリスナーの設定方法を外部から差し替えできる。React Native や Electron 等、異なるプラットフォーム対応の拡張ポイント。

## パターンカタログ

- **Observer パターン** (分類: 振る舞い)
  - 解決する問題: フレームワーク非依存な状態変更通知
  - 適用条件: 複数の消費者が同一のデータソースを監視する場合
  - コード例: `packages/query-core/src/subscribable.ts:1-30`
  - 注意点: リスナーの解除忘れによるメモリリーク。TanStack Query は unsubscribe 関数を返す設計で防止

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: ライフサイクルフックの共通化と個別実装の分離
  - 適用条件: 基底クラスがアルゴリズムの骨格を定義し、サブクラスが特定ステップを実装する場合
  - コード例: `Subscribable.onSubscribe`/`onUnsubscribe`（`subscribable.ts:23-29`）、`Removable.optionalRemove`（`removable.ts:38`）
  - 注意点: デフォルト実装を空メソッドにすることで、サブクラスの実装を任意にしている

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: フェッチ戦略をコア実装の変更なしに差し替える
  - 適用条件: 同一インターフェースで複数の実装バリエーションがある場合
  - コード例: `QueryBehavior` インターフェース（`query.ts:78-88`）と `infiniteQueryBehavior`（`infiniteQueryBehavior.ts:16-130`）
  - 注意点: `onFetch` がコンテキストの `fetchFn` を直接書き換えるミュータブルな設計。純粋関数的ではないが、パフォーマンスと簡潔さを優先

- **Proxy パターン** (分類: 構造)
  - 解決する問題: プロパティアクセスの追跡による不要な再レンダリングの回避
  - 適用条件: 消費者が使用するプロパティだけを追跡して通知を最適化する場合
  - コード例: `QueryObserver.trackResult`（`queryObserver.ts:263-287`）、Angular の `signalProxy`（`signal-proxy.ts:14-46`）
  - 注意点: Proxy はデバッグを難しくするため、開発ツールでの考慮が必要

## Good Patterns

- **最小限の基底クラスによるインターフェース統一**: `Subscribable` はわずか 30 行で 7 つの派生クラスの共通契約を定義する。`subscribe` が返す unsubscribe 関数がフレームワーク側のクリーンアップ機構との接合点になる。過大な基底クラスを作らず、「購読と解除」という最小限の抽象だけを提供する点が重要。

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

- **Observer クラスを引数として渡す DI パターン**: `useBaseQuery(options, QueryObserver)` と `useBaseQuery(options, InfiniteQueryObserver)` で、同一の基盤関数を使いつつ異なる Observer を注入する。クラスベースの DI でありながら、フレームワーク固有の DI コンテナに依存しない。

```typescript
// packages/react-query/src/useQuery.ts:50-52
export function useQuery(options: UseQueryOptions, queryClient?: QueryClient) {
  return useBaseQuery(options, QueryObserver, queryClient)
}
// packages/react-query/src/useInfiniteQuery.ts (同じ useBaseQuery を使う)
export function useInfiniteQuery(options, queryClient) {
  return useBaseQuery(options, InfiniteQueryObserver, queryClient)
}
```

- **State Reducer パターンによる状態遷移の一元管理**: `Query.#dispatch` はアクション型による `switch` で全ての状態遷移を管理する。Redux 的だがクラス内に閉じ込めることで、外部への状態変更の漏れを防ぐ。

```typescript
// packages/query-core/src/query.ts:607-687
#dispatch(action: Action<TData, TError>): void {
  const reducer = (state: QueryState<TData, TError>) => {
    switch (action.type) {
      case 'fetch': return { ...state, ...fetchState(state.data, this.options) }
      case 'success': return { ...state, ...successState(action.data) }
      case 'error': return { ...state, error: action.error, status: 'error' }
      // ...
    }
  }
  this.state = reducer(this.state)
  notifyManager.batch(() => {
    this.observers.forEach((observer) => observer.onQueryUpdate())
    this.#cache.notify({ query: this, type: 'updated', action })
  })
}
```

## Anti-Patterns / 注意点

- **コア抽象にフレームワーク概念を混入させる**: フレームワーク固有の概念（React の Suspense、Vue の Ref 等）をコアに持ち込むと、他のアダプターが不要な概念を扱う羽目になる。TanStack Query はこれを徹底的に避け、コアの `_optimisticResults` フラグ等はフレームワーク中立な名前にしている。

```typescript
// Bad: コアに React 固有の概念を持ち込む
class QueryObserver {
  useSyncExternalStore() { /* React 専用コード */ }
}

// Better: コアは subscribe/getCurrentResult だけ公開し、フレームワーク側で接続
// packages/react-query/src/useBaseQuery.ts:103-120
React.useSyncExternalStore(
  React.useCallback((onStoreChange) => {
    const unsubscribe = observer.subscribe(notifyManager.batchCalls(onStoreChange))
    return unsubscribe
  }, [observer]),
  () => observer.getCurrentResult(),
  () => observer.getCurrentResult(),
)
```

- **通知バッチを各箇所で個別に実装する**: 通知の最適化を各 Observer やコンポーネントで個別に行うと、一貫性が失われ、バグの温床になる。

```typescript
// Bad: 各所で独自のバッチ処理
class MyObserver {
  notify() {
    queueMicrotask(() => { /* 各自でバッチ */ })
  }
}

// Better: 集中管理された NotifyManager を通す
// packages/query-core/src/notifyManager.ts:52-64
batch: <T>(callback: () => T): T => {
  transactions++
  try { result = callback() }
  finally { transactions--; if (!transactions) { flush() } }
  return result
},
```

## 導出ルール

- `[MUST]` マルチフレームワーク対応ライブラリでは、ビジネスロジックをフレームワーク非依存パッケージに分離し、フレームワーク固有コードは薄いアダプター層に限定する
  - 根拠: TanStack Query の `query-core` は React/Vue/Solid/Svelte/Angular/Preact いずれにも依存せず、Observer パターンだけで6つのアダプターに対応している（`subscribable.ts`, 各フレームワークの `useBaseQuery`）

- `[MUST]` subscribe メソッドは unsubscribe 関数を返す設計にする。これにより、あらゆるフレームワークのクリーンアップ機構に直接接続できる
  - 根拠: `Subscribable.subscribe` が返す `() => void` は、React の `useEffect` return、Vue の `onScopeDispose`、Solid の `onCleanup`、Angular の `effect` の `onCleanup` に直接渡されている

- `[SHOULD]` 基底クラスのライフサイクルフックは空のデフォルト実装（no-op）にし、サブクラスでの override を任意にする
  - 根拠: `Subscribable.onSubscribe`/`onUnsubscribe` は空実装で、`QueryObserver` や `FocusManager` が必要に応じてオーバーライドする（`subscribable.ts:23-29`, `queryObserver.ts:95-113`）

- `[SHOULD]` コアロジックの拡張が必要な場合、クラス継承ではなく Strategy/Behavior オブジェクトの注入を優先する
  - 根拠: `QueryBehavior` インターフェースにより、`infiniteQueryBehavior` が Query クラスを継承せずにフェッチ戦略を差し替えている（`query.ts:78-88`, `infiniteQueryBehavior.ts:16-130`）

- `[SHOULD]` 通知のバッチ処理は専用のマネージャーに集約し、各コンポーネントが個別にバッチングしない
  - 根拠: `notifyManager` がトランザクションカウンターで一元管理し、`setBatchNotifyFunction` でフレームワーク固有のバッチ関数を差し替え可能にしている（`notifyManager.ts:17-96`）

- `[SHOULD]` アダプター層では、コアの Observer クラスを引数として受け取る共通基盤関数を設け、各 API はその薄いラッパーとして実装する
  - 根拠: 全6アダプターが `useBaseQuery(options, Observer, queryClient)` の形で共通基盤を共有し、`useQuery` は `QueryObserver` を、`useInfiniteQuery` は `InfiniteQueryObserver` を渡すだけ（`react-query/src/useQuery.ts:50-52`）

- `[AVOID]` コアパッケージにフレームワーク固有の概念（React hooks, Vue Ref, Angular Signal 等）を混入させる
  - 根拠: TanStack Query のコアはフレームワーク概念を一切持たず、`subscribe`/`getCurrentResult`/`getOptimisticResult` という汎用 API だけを提供。フレームワーク統合は完全にアダプター層に委ねている

## 適用チェックリスト

- [ ] ライブラリが複数のフレームワークをサポートする（または将来的にサポートする可能性がある）場合、ビジネスロジックをフレームワーク非依存パッケージに分離しているか
- [ ] コアの状態管理は Observer パターンで実装され、`subscribe` が unsubscribe 関数を返す設計になっているか
- [ ] フレームワークアダプターは「コアの Observer を生成 -> subscribe でリアクティブシステムに接続 -> クリーンアップで unsubscribe」という統一的な構造を持っているか
- [ ] 通知のバッチ処理が集中管理されており、フレームワーク固有のバッチ関数を外部から差し替え可能か
- [ ] コアの拡張ポイントが Strategy/Behavior パターンで設計されており、新しいバリエーション追加時にコアの修正が不要か
- [ ] 基底クラスの抽象度が適切か（最小限のインターフェースで最大限の派生をカバーしているか）
- [ ] `setEventListener` のような環境適応ポイントが用意されており、プラットフォーム差異をコア外で吸収できるか
