# Subscribable Observer パターン: 30行で実現するフレームワーク非依存の購読基盤

> 出典: [repos/TanStack/query](../repos/TanStack/query/)
> カテゴリ: pattern

## 概要

TanStack Query の `Subscribable` 基底クラスは、わずか30行で React/Vue/Solid/Svelte/Angular 全てに対応する最小購読パターンを実現している。`subscribe` が unsubscribe 関数を返す設計により、あらゆるフレームワークのクリーンアップ機構にシームレスに接続できる。このパターンを軸に、購読数連動のリソース管理（GC タイマー・イベントリスナー制御）と `NotifyManager` によるバッチ通知を組み合わせることで、フレームワーク非依存のリアクティブシステムを構築できる。

## 背景・文脈

TanStack Query は24パッケージのモノレポで、`query-core` がフレームワーク非依存のビジネスロジックを担い、6つのアダプター（React, Vue, Solid, Svelte, Angular, Preact）が各フレームワークのリアクティビティシステムに橋渡しする。この「ビジネスロジック重複ゼロで N フレームワーク対応」を可能にしている核が `Subscribable` クラスである。

`Subscribable` を継承するクラスは7つある: `QueryObserver`、`MutationObserver`、`QueriesObserver`、`QueryCache`、`MutationCache`、`FocusManager`、`OnlineManager`。すべてが同一の購読契約に従い、各フレームワークのクリーンアップ機構（React の `useEffect` return、Vue の `onScopeDispose`、Solid の `onCleanup`、Svelte の `$effect`、Angular の `effect` の `onCleanup`）に直接渡せる unsubscribe 関数を返す。

## 実装パターン

### 1. Subscribable: 最小の購読基盤

```typescript
// packages/query-core/src/subscribable.ts:1-30
export class Subscribable<TListener extends Function> {
  protected listeners = new Set<TListener>()

  constructor() {
    this.subscribe = this.subscribe.bind(this)
  }

  subscribe(listener: TListener): () => void {
    this.listeners.add(listener)

    this.onSubscribe()

    return () => {
      this.listeners.delete(listener)
      this.onUnsubscribe()
    }
  }

  hasListeners(): boolean {
    return this.listeners.size > 0
  }

  protected onSubscribe(): void {
    // Do nothing
  }

  protected onUnsubscribe(): void {
    // Do nothing
  }
}
```

設計上の重要な判断が3つある:

1. **`subscribe` のコンストラクタ `bind`**: React の `useSyncExternalStore` に渡す際、メソッド参照が安定している必要がある
2. **`onSubscribe`/`onUnsubscribe` のテンプレートメソッド**: サブクラスが購読数の変化に応じた副作用を自由に実装できる
3. **`Set` によるリスナー管理**: 同一リスナーの重複登録を自然に防止する

### 2. QueryObserver: 購読数連動のライフサイクル管理

```typescript
// packages/query-core/src/queryObserver.ts:95-113
protected onSubscribe(): void {
  if (this.listeners.size === 1) {
    this.#currentQuery.addObserver(this)

    if (shouldFetchOnMount(this.#currentQuery, this.options)) {
      this.#executeFetch()
    } else {
      this.updateResult()
    }

    this.#updateTimers()
  }
}

protected onUnsubscribe(): void {
  if (!this.hasListeners()) {
    this.destroy()
  }
}
```

`listeners.size === 1` は「最初の購読者が付いた時だけ」Query への接続とフェッチを開始する。2人目以降はセットアップ済みのインフラを共有する。購読者がゼロになれば自動破棄する。

### 3. Query 側の GC 連動

```typescript
// packages/query-core/src/query.ts:343-374
addObserver(observer: QueryObserver<any, any, any, any, any>): void {
  if (!this.observers.includes(observer)) {
    this.observers.push(observer)
    this.clearGcTimeout()  // Observer がいる間は GC しない
    this.#cache.notify({ type: 'observerAdded', query: this, observer })
  }
}

removeObserver(observer: QueryObserver<any, any, any, any, any>): void {
  if (this.observers.includes(observer)) {
    this.observers = this.observers.filter((x) => x !== observer)
    if (!this.observers.length) {
      if (this.#retryer) {
        if (this.#abortSignalConsumed) {
          this.#retryer.cancel({ revert: true })
        } else {
          this.#retryer.cancelRetry()
        }
      }
      this.scheduleGc()  // 全 Observer 離脱で GC スケジュール開始
    }
    this.#cache.notify({ type: 'observerRemoved', query: this, observer })
  }
}
```

### 4. FocusManager: 遅延初期化パターン

```typescript
// packages/query-core/src/focusManager.ts:35-46
protected onSubscribe(): void {
  if (!this.#cleanup) {
    this.setEventListener(this.#setup)
  }
}

protected onUnsubscribe() {
  if (!this.hasListeners()) {
    this.#cleanup?.()
    this.#cleanup = undefined
  }
}
```

ブラウザイベントリスナーの登録を最初の購読者が付くまで遅延させ、購読者がゼロになった時点で解放する。

### 5. NotifyManager: トランザクションベースのバッチ通知

```typescript
// packages/query-core/src/notifyManager.ts:17-96
export function createNotifyManager() {
  let queue: Array<NotifyCallback> = []
  let transactions = 0
  let notifyFn: NotifyFunction = (callback) => { callback() }
  let batchNotifyFn: BatchNotifyFunction = (callback: () => void) => { callback() }
  let scheduleFn = defaultScheduler

  const schedule = (callback: NotifyCallback): void => {
    if (transactions) {
      queue.push(callback)
    } else {
      scheduleFn(() => { notifyFn(callback) })
    }
  }
  const flush = (): void => {
    const originalQueue = queue
    queue = []
    if (originalQueue.length) {
      scheduleFn(() => {
        batchNotifyFn(() => {
          originalQueue.forEach((callback) => { notifyFn(callback) })
        })
      })
    }
  }

  return {
    batch: <T>(callback: () => T): T => {
      let result
      transactions++
      try {
        result = callback()
      } finally {
        transactions--
        if (!transactions) { flush() }
      }
      return result
    },
    setBatchNotifyFunction: (fn: BatchNotifyFunction) => { batchNotifyFn = fn },
    setNotifyFunction: (fn: NotifyFunction) => { notifyFn = fn },
    setScheduler: (fn: ScheduleFunction) => { scheduleFn = fn },
  }
}
```

3つの差し替え可能な関数が連携する:

- `scheduleFn`: 通知のスケジューリング（デフォルトは `setTimeout(cb, 0)` で次ティック遅延）
- `notifyFn`: 個別通知のラッパー（テスト時に `React.act` で包む用途）
- `batchNotifyFn`: バッチ通知のラッパー（ReactDOM の `unstable_batchedUpdates` を差し込む用途）

## Good Example

**subscribe が返す unsubscribe 関数をフレームワークのクリーンアップに直接接続する**

```typescript
// packages/react-query/src/useBaseQuery.ts:103-120
// React: useSyncExternalStore との統合
React.useSyncExternalStore(
  React.useCallback(
    (onStoreChange) => {
      const unsubscribe = shouldSubscribe
        ? observer.subscribe(notifyManager.batchCalls(onStoreChange))
        : noop
      observer.updateResult()
      return unsubscribe  // クリーンアップで自動的に購読解除
    },
    [observer, shouldSubscribe],
  ),
  () => observer.getCurrentResult(),
  () => observer.getCurrentResult(),
)
```

```typescript
// packages/query-core/src/query.ts:680-686
// 複数 Observer への通知をバッチでまとめる
notifyManager.batch(() => {
  this.observers.forEach((observer) => {
    observer.onQueryUpdate()
  })
  this.#cache.notify({ query: this, type: 'updated', action })
})
```

```typescript
// packages/query-core/src/queryObserver.ts:109-113
// 購読数ゼロで自動破棄 — メモリリークを構造的に防止
protected onUnsubscribe(): void {
  if (!this.hasListeners()) {
    this.destroy()
  }
}
```

## Bad Example

```typescript
// Bad: 購読解除を手動管理に任せる
class Store {
  subscribe(listener: Function) {
    this.listeners.push(listener)
    // unsubscribe を返さない → 解除は呼び出し側が ID 管理する必要がある
  }
  unsubscribe(listener: Function) {
    this.listeners = this.listeners.filter(l => l !== listener)
  }
}

// 使用側: リスナーの参照を自分で管理しなければならない
const listener = () => { /* ... */ }
store.subscribe(listener)
// 忘れやすく、useEffect 等のクリーンアップに直接渡せない
useEffect(() => {
  store.subscribe(listener)
  return () => store.unsubscribe(listener)  // 面倒で漏れやすい
}, [])
```

```typescript
// Bad: バッチなしで個別に通知 → N 回の再レンダリングが走る
this.state = reducer(this.state)
this.observers.forEach(observer => observer.onQueryUpdate())
this.cache.notify({ type: 'updated' })
// 2つの通知が別々に発火し、フレームワーク側で複数回の更新サイクルが走る
```

```typescript
// Bad: 購読数に関係なくリソースを常時確保
class FocusManager {
  constructor() {
    // 購読者がいなくてもイベントリスナーを登録し続ける
    window.addEventListener('visibilitychange', this.onFocus)
  }
}
```

## 適用ガイド

### どのような状況で使うべきか

- **複数フレームワーク対応のライブラリ**を構築する場合。コアロジックをフレームワーク非依存に保ち、各フレームワークのクリーンアップ機構に直接接続できる
- **1つの状態ソースを複数の消費者が購読する**構造がある場合。キャッシュ、フォーム状態、WebSocket 接続など
- **リソースのライフサイクルを購読数に連動させたい**場合。イベントリスナー、タイマー、ネットワーク接続の遅延初期化と自動解放

### 導入時の注意点

- `subscribe` メソッドをコンストラクタで `bind` すること。React の `useSyncExternalStore` など、メソッド参照の安定性を求める API に渡す場合に必要
- `onSubscribe`/`onUnsubscribe` フックの呼び出し順序が暗黙の契約になる。リスナーの追加/削除の **後に** フックが呼ばれることを前提にサブクラスを設計する
- 複数 Observer への通知は必ずバッチングすること。バッチなしではフレームワーク側で N 回の再レンダリングが走る
- バッチ通知の `notifyFn`/`batchNotifyFn`/`scheduleFn` はフレームワーク側から差し替え可能にしておくこと。コアがフレームワーク固有 API に依存しない設計を維持する

### カスタマイズポイント

- **`onSubscribe`/`onUnsubscribe` のオーバーライド**: 購読数変化に応じた任意の副作用を実装できる（リソース確保/解放、タイマー制御、イベントリスナー管理）
- **`NotifyManager` の3関数**: `setScheduler` でスケジューリング戦略、`setBatchNotifyFunction` でフレームワーク固有のバッチ更新関数、`setNotifyFunction` でテスト用ラッパーを注入できる
- **`setEventListener` パターン**: FocusManager/OnlineManager のように、イベント検知ロジックを外部から差し替え可能にすることで、React Native や Electron 等のプラットフォーム差異を吸収できる

## 参考

- [repos/TanStack/query/observer-pattern-techniques.md](../repos/TanStack/query/observer-pattern-techniques.md) -- Observer パターンの実装・購読管理・通知最適化
- [repos/TanStack/query/abstraction-patterns.md](../repos/TanStack/query/abstraction-patterns.md) -- コア抽象とフレームワークアダプターの共通インターフェース設計
- [repos/TanStack/query/framework-adapter-patterns.md](../repos/TanStack/query/framework-adapter-patterns.md) -- 6つのフレームワークアダプターの比較分析
