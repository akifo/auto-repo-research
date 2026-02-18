# Observer パターンの実装・購読管理・通知最適化

> リポジトリ: TanStack/query
> 分析日: 2026-02-17

## 概要

TanStack Query は Observer パターンを中核アーキテクチャとして採用し、サーバー状態管理ライブラリをフレームワーク非依存で実現している。特筆すべきは、30行の `Subscribable` 基底クラスから QueryObserver、MutationObserver、QueriesObserver、FocusManager、OnlineManager、QueryCache、MutationCache の7つの購読可能エンティティを派生させている点と、`NotifyManager` による通知バッチング最適化、Proxy ベースのプロパティアクセス追跡による不要再レンダリング抑制の仕組みにある。

## 背景にある原則

- **レイヤー分離による購読の責務分離**: Observer はキャッシュと UI の間に挟まる中間層として機能する。Query（キャッシュエントリ）は状態を保持し、Observer は「どの Query を購読し、結果をどう加工して UI に届けるか」を担当する。この分離により、同一 Query を複数の Observer が異なる `select` 関数で購読できる。根拠: `queryObserver.ts` の `createResult()` が Query の state を受け取り Observer 固有の加工（select、placeholderData）を施す設計。

- **購読数ゼロを起点としたリソース管理**: 購読者が最後の1人になった時点でリソースを確保し、ゼロになった時点で解放する。これにより、不要なイベントリスナーやタイマーの残存を防ぐ。根拠: `focusManager.ts:35-46` で `onSubscribe` 時にイベントリスナーを設定し、`onUnsubscribe` で全リスナー解除後にクリーンアップする。`query.ts:343-374` で Observer 追加時に GC タイマーを停止し、全 Observer 離脱時にリトライキャンセル + GC スケジュールを行う。

- **通知のバッチングによるカスケード防止**: 状態変更が複数の Observer に波及する場合、各通知を即座に発火するとフレームワーク側で複数回の再レンダリングが走る。トランザクションカウンタベースのバッチングで通知をキューに溜め、一括実行する。根拠: `notifyManager.ts:52-64` の `batch()` 実装。

- **構造的共有による参照安定性**: データが意味的に同一なら前回の参照を再利用し、不要な再レンダリングを抑制する。根拠: `utils.ts:267-314` の `replaceEqualDeep` がオブジェクトを再帰的に比較し、等価なサブツリーの参照を保持する。

## 実例と分析

### Subscribable: 最小の購読基盤

`Subscribable` は TanStack Query の Observer パターンの全基盤を成す30行のクラスである。`Set` でリスナーを管理し、`subscribe` が返す関数で購読解除する。

```typescript
// packages/query-core/src/subscribable.ts:1-30
export class Subscribable<TListener extends Function> {
  protected listeners = new Set<TListener>();

  constructor() {
    this.subscribe = this.subscribe.bind(this);
  }

  subscribe(listener: TListener): () => void {
    this.listeners.add(listener);
    this.onSubscribe();
    return () => {
      this.listeners.delete(listener);
      this.onUnsubscribe();
    };
  }

  hasListeners(): boolean {
    return this.listeners.size > 0;
  }

  protected onSubscribe(): void {
    // Do nothing
  }

  protected onUnsubscribe(): void {
    // Do nothing
  }
}
```

設計上の重要な判断:

1. `subscribe` メソッドをコンストラクタで `bind` している。これは React の `useSyncExternalStore` に渡す際にメソッド参照が安定している必要があるため。
2. `onSubscribe`/`onUnsubscribe` はテンプレートメソッドパターンで、サブクラスが購読数の変化に応じた副作用を実装できる。
3. リスナーを `Set` で管理することで、同一リスナーの重複登録を自然に防止している。

### QueryObserver: 購読数に連動するライフサイクル管理

`QueryObserver` は `Subscribable` を継承し、最初の購読者がついた時点で Query への接続とフェッチを開始し、最後の購読者が離脱した時点で破棄する。

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

`listeners.size === 1` の条件は「最初の購読者が付いた時だけ」副作用を実行する意味で重要である。2人目以降の購読者は、既にセットアップ済みのインフラを共有する。

### NotifyManager: トランザクションベースのバッチ通知

`NotifyManager` はクロージャで状態を隔離した Singleton モジュールで、通知のバッチングを実現する。

```typescript
// packages/query-core/src/notifyManager.ts:17-63
export function createNotifyManager() {
  let queue: Array<NotifyCallback> = [];
  let transactions = 0;
  let notifyFn: NotifyFunction = (callback) => {
    callback();
  };
  let batchNotifyFn: BatchNotifyFunction = (callback: () => void) => {
    callback();
  };
  let scheduleFn = defaultScheduler;

  const schedule = (callback: NotifyCallback): void => {
    if (transactions) {
      queue.push(callback);
    } else {
      scheduleFn(() => {
        notifyFn(callback);
      });
    }
  };
  const flush = (): void => {
    const originalQueue = queue;
    queue = [];
    if (originalQueue.length) {
      scheduleFn(() => {
        batchNotifyFn(() => {
          originalQueue.forEach((callback) => {
            notifyFn(callback);
          });
        });
      });
    }
  };

  return {
    batch: <T>(callback: () => T): T => {
      let result;
      transactions++;
      try {
        result = callback();
      } finally {
        transactions--;
        if (!transactions) flush();
      }
      return result;
    },
    // ...
  };
}
```

3つの差し替え可能な関数が連携する:

- `scheduleFn`: 通知のスケジューリング（デフォルトは `setTimeout(cb, 0)` で次ティック遅延）
- `notifyFn`: 個別通知のラッパー（テスト時に `React.act` で包む用途）
- `batchNotifyFn`: バッチ通知のラッパー（ReactDOM の `unstable_batchedUpdates` を差し込む用途）

### Proxy ベースのプロパティアクセス追跡

React 統合では、`useBaseQuery` が `observer.trackResult(result)` を呼んで Proxy でラップした結果を返す。コンポーネントが `data` と `isLoading` しかアクセスしなければ、`error` が変化しても再レンダリングしない。

```typescript
// packages/query-core/src/queryObserver.ts:263-287
trackResult(
  result: QueryObserverResult<TData, TError>,
  onPropTracked?: (key: keyof QueryObserverResult) => void,
): QueryObserverResult<TData, TError> {
  return new Proxy(result, {
    get: (target, key) => {
      this.trackProp(key as keyof QueryObserverResult)
      onPropTracked?.(key as keyof QueryObserverResult)
      // ...
      return Reflect.get(target, key)
    },
  })
}
```

そして `updateResult()` では、追跡されたプロパティのみを比較して通知の要否を判定する:

```typescript
// packages/query-core/src/queryObserver.ts:662-696
const shouldNotifyListeners = (): boolean => {
  if (!prevResult) return true;

  const { notifyOnChangeProps } = this.options;
  // ...
  const includedProps = new Set(
    notifyOnChangePropsValue ?? this.#trackedProps,
  );

  return Object.keys(this.#currentResult).some((key) => {
    const typedKey = key as keyof QueryObserverResult;
    const changed = this.#currentResult[typedKey] !== prevResult[typedKey];
    return changed && includedProps.has(typedKey);
  });
};
```

### QueriesObserver: Observer の Observer（Composite パターン）

`QueriesObserver` は複数の `QueryObserver` をまとめて管理する Observer であり、内部 Observer の配列変更をバッチ処理で安全に行う。

```typescript
// packages/query-core/src/queriesObserver.ts:106-157
setQueries(queries: Array<QueryObserverOptions>, ...): void {
  // ...
  notifyManager.batch(() => {
    const prevObservers = this.#observers
    const newObserverMatches = this.#findMatchingObservers(this.#queries)

    // set options for the new observers to notify of changes
    newObserverMatches.forEach((match) =>
      match.observer.setOptions(match.defaultedQueryOptions),
    )

    // ...
    if (hasStructuralChange) {
      difference(prevObservers, newObservers).forEach((observer) => {
        observer.destroy()
      })
      difference(newObservers, prevObservers).forEach((observer) => {
        observer.subscribe((result) => { this.#onUpdate(observer, result) })
      })
    }

    this.#notify()
  })
}
```

`#findMatchingObservers` は既存の Observer を `queryHash` で再利用マッチングし、不要な破棄・再生成を回避する。

### Observer 追加/離脱とガベージコレクションの連動

Query と Mutation は `Removable` を継承し、Observer の追加時に GC タイマーを停止、全 Observer 離脱時に GC をスケジュールする。

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

### FocusManager/OnlineManager: 遅延初期化パターン

`FocusManager` と `OnlineManager` はブラウザイベントリスナーの登録を最初の購読者が付くまで遅延させる。

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

`setEventListener` は外部からイベント検知ロジックを差し替え可能にしており、React Native 等のプラットフォーム固有実装を注入できる。

## パターンカタログ

- **Observer パターン** (分類: 振る舞い / GoF)
  - 解決する問題: 状態変更を複数の依存先に通知する
  - 適用条件: 1つの状態ソースに対して複数の消費者が存在する
  - コード例: `subscribable.ts:1-30`, `queryObserver.ts:40-46`
  - 注意点: 通知ループの防止にバッチングが必要

- **Template Method パターン** (分類: 振る舞い / GoF)
  - 解決する問題: 基底クラスのアルゴリズム骨格を固定し、サブクラスが特定ステップを上書きする
  - 適用条件: subscribe/unsubscribe のタイミングで派生クラスごとに異なる副作用が必要
  - コード例: `subscribable.ts:23-29` の `onSubscribe`/`onUnsubscribe` フック
  - 注意点: フックメソッドの呼び出し順序が暗黙の契約になる

- **Composite パターン** (分類: 構造 / GoF)
  - 解決する問題: 個別の Observer と Observer 群を統一的に扱う
  - 適用条件: 複数クエリの結果を一括で購読・通知したい場合
  - コード例: `queriesObserver.ts:35-37` が `Subscribable` を継承しつつ内部に `QueryObserver[]` を持つ
  - 注意点: 内部 Observer の追加/削除とバッチ通知のタイミング整合が複雑化する

- **Mediator パターン** (分類: 振る舞い / GoF)
  - 解決する問題: Query と Observer の直接依存を避け、Cache を経由して通知を媒介する
  - 適用条件: Observer 追加/削除のイベントをキャッシュレベルで横断的に観測したい場合
  - コード例: `queryCache.ts:200-206` の `notify` が Cache リスナー全体にイベントを配信する
  - 注意点: イベント種別の型安全性を discriminated union で担保する必要がある

## Good Patterns

- **Unsubscribe 関数を返す購読 API**: `subscribe` が返す関数で購読解除する設計は、クリーンアップの責務を呼び出し側に自然に移譲する。React の `useEffect` や Svelte の `$effect` のクリーンアップ関数とシームレスに統合できる。

```typescript
// packages/react-query/src/useBaseQuery.ts:103-114
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

- **構造的共有（Structural Sharing）によるイミュータブル最適化**: `replaceEqualDeep` は新旧データを再帰比較し、等価な部分は前回の参照を保持する。これにより `===` 比較だけで変化検知でき、React の `useMemo` 依存配列やセレクタの最適化が自然に効く。

```typescript
// packages/query-core/src/utils.ts:267-313
export function replaceEqualDeep(a: any, b: any, depth = 0): any {
  if (a === b) return a;
  // ...再帰比較して等価なサブツリーの参照を保持
  return aSize === bSize && equalItems === aSize ? a : copy;
}
```

- **フレームワーク非依存コアと差し替え可能な通知戦略**: `notifyManager.setBatchNotifyFunction` で ReactDOM のバッチ更新関数を注入でき、`setScheduler` でスケジューリング戦略を差し替えられる。コア層がフレームワーク固有 API に依存しない。

```typescript
// packages/query-core/src/notifyManager.ts:82-94
setNotifyFunction: (fn: NotifyFunction) => { notifyFn = fn },
setBatchNotifyFunction: (fn: BatchNotifyFunction) => { batchNotifyFn = fn },
setScheduler: (fn: ScheduleFunction) => { scheduleFn = fn },
```

## Anti-Patterns / 注意点

- **通知なしの直接状態変更**: Observer パターンでは、状態変更は必ず通知チャネルを通すべきである。QueryObserver が `#currentResult` を更新した後に `shallowEqualObjects` で差分がなければ通知をスキップするが、これはあくまで「変更がないから通知しない」のであって「変更を通知せず飲み込む」のとは異なる。

```typescript
// Bad: 状態を変更したが通知しない
this.#currentResult = newResult;
// 通知忘れ

// Better: TanStack Query の実装のように、変更検知と通知を一体化する
// packages/query-core/src/queryObserver.ts:656-697
if (shallowEqualObjects(nextResult, prevResult)) {
  return; // 変更なし → 通知不要（意図的スキップ）
}
this.#currentResult = nextResult;
this.#notify({ listeners: shouldNotifyListeners() });
```

- **バッチなしでの複数通知**: Observer が多い場合、バッチングなしで個別に通知すると N 回のフレームワーク再レンダリングが走る。TanStack Query は `notifyManager.batch` で全通知を1ティックにまとめている。

```typescript
// Bad: 個別に通知
observers.forEach(observer => observer.onQueryUpdate());
cache.notify({ type: "updated" });

// Better: バッチでまとめる
// packages/query-core/src/query.ts:680-686
notifyManager.batch(() => {
  this.observers.forEach((observer) => {
    observer.onQueryUpdate();
  });
  this.#cache.notify({ query: this, type: "updated", action });
});
```

- **Observer の購読解除漏れによるメモリリーク**: Observer が Query から離脱しないと GC タイマーが起動せず、キャッシュエントリが永続する。TanStack Query は `onUnsubscribe` で自動 `destroy` し、`destroy` 内で `removeObserver` を呼ぶことで確実にクリーンアップする。

```typescript
// Bad: 購読解除を手動管理に任せる
const unsub = observer.subscribe(cb)
// unsub() を呼び忘れ → メモリリーク

// Better: 購読数ゼロで自動破棄
// packages/query-core/src/queryObserver.ts:109-113
protected onUnsubscribe(): void {
  if (!this.hasListeners()) {
    this.destroy()
  }
}
```

## 導出ルール

- `[MUST]` subscribe 関数は unsubscribe 関数を返り値として返し、購読解除の責務を呼び出し側に移譲する
  - 根拠: `subscribable.ts:8-16` で subscribe が `() => void` を返す設計が、React/Svelte/Angular 全てのフレームワーク統合でクリーンアップ関数として直接利用されている

- `[MUST]` 複数の Observer へ通知する際はバッチングで1回の更新サイクルにまとめる
  - 根拠: `query.ts:680-686` と `queryCache.ts:200-206` で全通知が `notifyManager.batch()` に包まれ、フレームワーク側の不要な再レンダリングを防止している

- `[SHOULD]` 購読数がゼロになったタイミングでリソース（イベントリスナー、タイマー、ネットワーク接続等）を解放する
  - 根拠: `focusManager.ts:41-45` で最後の購読者離脱時にイベントリスナーを解除し、`query.ts:358-369` で全 Observer 離脱時にリトライキャンセルと GC スケジュールを行う

- `[SHOULD]` Observer 層で結果のプロパティアクセスを追跡し、使用されたプロパティの変更時のみ通知する
  - 根拠: `queryObserver.ts:263-287` の Proxy ベース追跡と `updateResult()` 内の `#trackedProps` 比較により、`data` しか使わないコンポーネントが `fetchStatus` 変更で再レンダリングされない

- `[SHOULD]` 通知・スケジューリング・バッチ関数を外部から差し替え可能にし、コアライブラリをフレームワーク非依存に保つ
  - 根拠: `notifyManager.ts:82-94` の `setNotifyFunction`/`setBatchNotifyFunction`/`setScheduler` により、React/Svelte/Angular/Preact の各統合が独自の更新戦略を注入できる

- `[SHOULD]` イミュータブルデータの構造的共有（structural sharing）で前回と等価な部分の参照を保持し、不要な再計算を抑制する
  - 根拠: `utils.ts:267-314` の `replaceEqualDeep` がオブジェクトを再帰比較し、等価サブツリーの参照を維持することで `===` による高速な変化検知を可能にしている

- `[AVOID]` Observer 基底クラスに特定フレームワークの API を直接埋め込むこと。通知のフック関数として注入する方式を使う
  - 根拠: `notifyManager.ts` が `ReactDOM.unstable_batchedUpdates` を直接 import せず、`setBatchNotifyFunction` で注入する設計により、同一コアを React/Svelte/Angular/Solid で共有できている

## 適用チェックリスト

- [ ] 購読 API が unsubscribe 関数を返す設計になっているか
- [ ] 購読者数の変化に応じたリソース管理（遅延初期化・自動解放）を実装しているか
- [ ] 複数 Observer への通知がバッチングされ、フレームワーク側の更新が1回にまとまるか
- [ ] 通知の要否判定に shallow equality を使い、無変更時の通知をスキップしているか
- [ ] フレームワーク固有の更新 API（React.act、batchedUpdates 等）が差し替え可能な設計か
- [ ] 結果オブジェクトのプロパティアクセス追跡により、使用プロパティの変更時のみ再通知する仕組みがあるか
- [ ] 構造的共有やデータの参照安定性を保つ仕組みがあるか
- [ ] Observer の購読解除漏れがメモリリークに直結しない安全策（自動 destroy 等）があるか
