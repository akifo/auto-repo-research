# performance-techniques

> リポジトリ: TanStack/query
> 分析日: 2026-02-17

## 概要

TanStack Query のパフォーマンス最適化手法を分析する。このライブラリは「不要な再レンダリングを起こさない」「不要なネットワークリクエストを発生させない」「メモリを適切に解放する」という3つの課題に対して、コアレベルで精緻な仕組みを構築している。特筆すべきは、フレームワーク非依存のコア (`query-core`) にパフォーマンス最適化の大半が集約されており、React / Vue / Solid 等の統合層は薄いアダプタに留まっている点である。キャッシュのライフサイクル管理、構造的共有による参照安定性、バッチ通知による更新集約、Proxy ベースのプロパティ追跡など、複数の技法が協調して動作する設計は、状態管理ライブラリ全般に応用可能な知見を多数含んでいる。

## 背景にある原則

- **参照安定性がレンダリングコストを決定する**: React の `useSyncExternalStore` や仮想 DOM 差分検出は参照比較に依存する。データの中身が同一でも参照が変わると再レンダリングが走るため、深い比較で参照を維持する `replaceEqualDeep` (構造的共有) をデフォルトで有効にしている。根拠: `utils.ts:267-314` で前回データと新データを再帰比較し、等価なサブツリーは旧参照を再利用する。
- **通知は最小限の粒度で行うべき**: 状態変更のたびに全リスナーに通知すると O(n) の無駄なレンダリングが発生する。TanStack Query は「どのプロパティを実際に読んだか」を Proxy で追跡し、変更されたプロパティを使用していないコンポーネントには通知しない。根拠: `queryObserver.ts:263-291` の `trackResult` / `#trackedProps`。
- **GC は使用状況に基づいて遅延実行すべき**: キャッシュエントリの即座の削除はユーザー体験を損なう（戻る操作でデータが消える）。一方、無期限保持はメモリリークを招く。Observer 数をカウントし、ゼロになった時点で `gcTime` 後に削除をスケジュールする設計が両方を解決する。根拠: `removable.ts:13-21` と `query.ts:343-373`。
- **バッチ処理で同一フレーム内の複数更新を一つにまとめる**: 複数の Query が同時に更新されたとき、各更新ごとに React に通知すると無駄なレンダリングが増える。NotifyManager が更新をキューに溜め、一括で flush することで React の `unstable_batchedUpdates` 相当の最適化を実現する。根拠: `notifyManager.ts:17-96`。

## 実例と分析

### 1. 構造的共有 (Structural Sharing) による参照安定性

`replaceEqualDeep` は TanStack Query の最も重要なパフォーマンス最適化である。API レスポンスが返るたびに新しいオブジェクトが生成されるが、前回レスポンスと深い比較を行い、変更のないサブツリーは前回の参照をそのまま返す。

```typescript
// packages/query-core/src/utils.ts:267-314
export function replaceEqualDeep(a: any, b: any, depth = 0): any {
  if (a === b) {
    return a;
  }

  if (depth > 500) return b;

  const array = isPlainArray(a) && isPlainArray(b);

  if (!array && !(isPlainObject(a) && isPlainObject(b))) return b;

  const aItems = array ? a : Object.keys(a);
  const aSize = aItems.length;
  const bItems = array ? b : Object.keys(b);
  const bSize = bItems.length;
  const copy: any = array ? new Array(bSize) : {};

  let equalItems = 0;

  for (let i = 0; i < bSize; i++) {
    const key: any = array ? i : bItems[i];
    if (aItem === bItem) {
      copy[key] = aItem;
      if (array ? i < aSize : hasOwn.call(a, key)) equalItems++;
      continue;
    }
    // ... 再帰比較
    const v = replaceEqualDeep(aItem, bItem, depth + 1);
    copy[key] = v;
    if (v === aItem) equalItems++;
  }

  return aSize === bSize && equalItems === aSize ? a : copy;
}
```

この関数は `replaceData` 経由で `select` の結果にも適用される。さらに `QueriesObserver` の `#combineResult` でも使われ、`useQueries` の `combine` 関数の戻り値も参照安定化される（`queriesObserver.ts:241`）。深度制限 `depth > 500` は無限再帰を防ぐ安全弁として機能している。

### 2. Proxy ベースのプロパティ追跡 (Tracked Queries)

`useQuery` のデフォルト動作では、コンポーネントが実際にアクセスしたプロパティのみを追跡し、それらが変更された場合にのみ再レンダリングを発生させる。

```typescript
// packages/query-core/src/queryObserver.ts:263-291
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

React 統合層 (`useBaseQuery.ts:167-169`) では `notifyOnChangeProps` が未指定のとき自動的に `trackResult` を適用する。

```typescript
// packages/react-query/src/useBaseQuery.ts:167-169
return !defaultedOptions.notifyOnChangeProps
  ? observer.trackResult(result)
  : result;
```

追跡された props は `updateResult` 内で `shouldNotifyListeners` の判定に使われ、未使用プロパティの変更は通知をスキップする（`queryObserver.ts:662-696`）。

### 3. NotifyManager によるバッチ通知

複数の Query 更新を一つのマイクロタスク内にまとめる仕組みである。

```typescript
// packages/query-core/src/notifyManager.ts:17-49
export function createNotifyManager() {
  let queue: Array<NotifyCallback> = [];
  let transactions = 0;
  // ...
  return {
    batch: <T>(callback: () => T): T => {
      let result;
      transactions++;
      try {
        result = callback();
      } finally {
        transactions--;
        if (!transactions) {
          flush();
        }
      }
      return result;
    },
    // ...
  };
}
```

`batch` のネスト対応（`transactions` カウンタ）により、内部で `batch` を呼ぶコードが更に `batch` で包まれても安全に動作する。React 側では `setBatchNotifyFunction` に `ReactDOM.flushSync` 等を注入できる設計になっている（`notifyManager.ts:89-91`）。

この仕組みはコードベース全体で活用されている: `query.ts:680`（状態更新後のオブザーバー通知）、`queryCache.ts:159`（キャッシュクリア）、`queryCache.ts:201`（キャッシュイベント通知）、`queriesObserver.ts:106`（複数クエリのオプション更新）。

### 4. Removable 基底クラスによる GC 管理

```typescript
// packages/query-core/src/removable.ts:5-39
export abstract class Removable {
  gcTime!: number;
  #gcTimeout?: ManagedTimerId;

  protected scheduleGc(): void {
    this.clearGcTimeout();
    if (isValidTimeout(this.gcTime)) {
      this.#gcTimeout = timeoutManager.setTimeout(() => {
        this.optionalRemove();
      }, this.gcTime);
    }
  }

  protected updateGcTime(newGcTime: number | undefined): void {
    this.gcTime = Math.max(
      this.gcTime || 0,
      newGcTime ?? (isServer ? Infinity : 5 * 60 * 1000),
    );
  }
}
```

`updateGcTime` は `Math.max` で常に最長の GC 時間を採用する。これは複数の Observer が異なる `gcTime` を持つ場合、最も長い値が勝つことを保証する。サーバー側では `Infinity` がデフォルトで、メモリリークではなく「リクエストスコープで管理される」ことを前提としている。

`Query.optionalRemove`（`query.ts:221-225`）は Observer が残っている場合やフェッチ中の場合にキャッシュ削除をスキップする。

### 5. 遅延 AbortSignal 生成 (Lazy Signal Pattern)

AbortSignal の生成と消費を分離し、消費された場合のみキャンセル処理を有効にする。

```typescript
// packages/query-core/src/utils.ts:471-499
export function addConsumeAwareSignal<T>(
  object: T,
  getSignal: () => AbortSignal,
  onCancelled: VoidFunction,
): T & { signal: AbortSignal; } {
  let consumed = false;
  let signal: AbortSignal | undefined;

  Object.defineProperty(object, "signal", {
    enumerable: true,
    get: () => {
      signal ??= getSignal();
      if (consumed) {
        return signal;
      }
      consumed = true;
      if (signal.aborted) {
        onCancelled();
      } else {
        signal.addEventListener("abort", onCancelled, { once: true });
      }
      return signal;
    },
  });

  return object as T & { signal: AbortSignal; };
}
```

`query.ts:354-373` では、Observer が全て削除された際に `#abortSignalConsumed` が `true` の場合のみリクエストをキャンセルし、そうでなければ結果をキャッシュに残す。これにより、signal を使わない queryFn のレスポンスが無駄にならない。

### 6. select 関数のメモ化

`createResult` 内で `select` 関数と入力データの両方が前回と同一であればキャッシュされた結果を返す。

```typescript
// packages/query-core/src/queryObserver.ts:525-543
if (options.select && data !== undefined && !skipSelect) {
  if (
    prevResult
    && data === prevResultState?.data
    && options.select === this.#selectFn
  ) {
    data = this.#selectResult;
  } else {
    this.#selectFn = options.select;
    data = options.select(data as any);
    data = replaceData(prevResult?.data, data, options);
    this.#selectResult = data;
    this.#selectError = null;
  }
}
```

`select` の結果にもさらに `replaceData`（= `replaceEqualDeep`）が適用されるため、二重の参照安定化が行われる。

### 7. TimeoutManager による抽象化

大量の Query が staleTime / gcTime のタイマーを持つとイベントループに負荷がかかる。TimeoutManager はタイマーの実装を差し替え可能にし、タイマー統合 (coalescing) 等のカスタム最適化を可能にする。

```typescript
// packages/query-core/src/timeoutManager.ts:54-61
// @tanstack/query-core makes liberal use of timeouts to implement `staleTime`
// and `gcTime`. The default TimeoutManager provider uses the platform's global
// `setTimeout` implementation, which is known to have scalability issues with
// thousands of timeouts on the event loop.
//
// If you hit this limitation, consider providing a custom TimeoutProvider that
// coalesces timeouts.
```

### 8. size-limit によるバンドルサイズ監視

```json
// .size-limit.json
[
  {
    "name": "react full",
    "path": "packages/react-query/build/modern/index.js",
    "limit": "13.00 kB",
    "ignore": ["react", "react-dom"]
  },
  {
    "name": "react minimal",
    "path": "packages/react-query/build/modern/index.js",
    "limit": "9.99 kB",
    "import": "{ useQuery, QueryClient, QueryClientProvider }",
    "ignore": ["react", "react-dom"]
  }
]
```

最小構成と全体構成の両方にバンドルサイズ上限を設定し、CI で自動監視している。

## パターンカタログ

- **Observer パターン** (分類: 振る舞い)
  - 解決する問題: キャッシュの状態変更を複数のコンポーネントに効率的に伝播する
  - 適用条件: 一つのデータソースを複数の消費者が監視する場面
  - コード例: `subscribable.ts:1-30`、`queryObserver.ts:40-46`
  - 注意点: Observer 追加/削除時に GC スケジューリングと連動させる必要がある（`query.ts:343-373`）

- **Proxy パターン** (分類: 構造)
  - 解決する問題: オブジェクトのどのプロパティが実際に使用されたかを透過的に追跡する
  - 適用条件: 不要な再計算・再レンダリングを抑制したい場面
  - コード例: `queryObserver.ts:263-287`
  - 注意点: Proxy は微小なオーバーヘッドがあるため、`notifyOnChangeProps` を明示的に設定すれば Proxy を回避できる

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 通知方法・スケジューリング方法をフレームワークごとに差し替える
  - 適用条件: コアロジックとフレームワーク固有の最適化を分離したい場面
  - コード例: `notifyManager.ts:82-94`（setBatchNotifyFunction / setScheduler）、`timeoutManager.ts:72-98`（setTimeoutProvider）

## Good Patterns

- **構造的共有のデフォルト有効化**: `structuralSharing` はデフォルトで `true` であり、利用者が意識せずとも参照安定性が得られる。非 JSON データ（Map, Set, Date 等）を使う場合のみ `false` にするか、カスタム関数を渡す。パフォーマンス最適化は「オプトアウト」設計であるべき。

```typescript
// packages/query-core/src/utils.ts:382-405
export function replaceData<TData, TOptions extends QueryOptions<any, any, any, any>>(
  prevData: TData | undefined,
  data: TData,
  options: TOptions,
): TData {
  if (typeof options.structuralSharing === "function") {
    return options.structuralSharing(prevData, data) as TData;
  } else if (options.structuralSharing !== false) {
    return replaceEqualDeep(prevData, data);
  }
  return data;
}
```

- **shallow equal による更新スキップ**: `updateResult` は新旧の結果を `shallowEqualObjects` で比較し、差分がなければリスナー通知自体を行わない。Proxy 追跡はその後のフィルタリングであり、二段階の無駄排除が機能する。

```typescript
// packages/query-core/src/queryObserver.ts:656-658
if (shallowEqualObjects(nextResult, prevResult)) {
  return;
}
```

- **リクエスト重複排除**: 同一クエリの fetch が進行中の場合、新たな Observer のマウントは既存の Retryer の promise を再利用する。ネットワークリクエストが重複しない。

```typescript
// packages/query-core/src/query.ts:400-404
} else if (this.#retryer) {
  this.#retryer.continueRetry()
  return this.#retryer.promise
}
```

## Anti-Patterns / 注意点

- **全プロパティ監視による不要な再レンダリング**: `notifyOnChangeProps: 'all'` を安易に設定すると、`isFetching` の変更だけでもコンポーネントが再レンダリングされる。デフォルトの Proxy 追跡を使うか、必要なプロパティだけを明示的に指定する。

```typescript
// Bad: 全プロパティの変更で再レンダリング
const { data } = useQuery({
  queryKey: ["todos"],
  queryFn: fetchTodos,
  notifyOnChangeProps: "all",
});

// Better: デフォルトの追跡に任せるか、明示的に指定
const { data } = useQuery({
  queryKey: ["todos"],
  queryFn: fetchTodos,
  // notifyOnChangeProps を省略すると自動追跡
});
```

- **select 関数のインライン定義による不要再計算**: `select` に毎レンダリングで新しい関数参照を渡すと、メモ化が無効化される（`options.select === this.#selectFn` の比較が常に false になる）。`useCallback` で安定化するか、コンポーネント外に定義する。

```typescript
// Bad: 毎回新しい関数参照が生成される
const { data } = useQuery({
  queryKey: ["todos"],
  queryFn: fetchTodos,
  select: (data) => data.filter(t => t.done),
});

// Better: 関数参照を安定化
const selectDone = useCallback((data: Todo[]) => data.filter(t => t.done), []);
const { data } = useQuery({
  queryKey: ["todos"],
  queryFn: fetchTodos,
  select: selectDone,
});
```

- **gcTime: 0 によるキャッシュ無効化**: GC 時間を 0 にすると画面遷移のたびにデータが破棄され、戻る操作でローディング状態が表示される。キャッシュはユーザー体験の一部であり、安易に無効化すべきでない。

## 導出ルール

- `[MUST]` 外部ストアから UI への通知は、変更の有無を事前判定し、差分がない場合は通知自体をスキップする
  - 根拠: TanStack Query は `shallowEqualObjects` で結果全体を比較し、さらに Proxy で使用プロパティを追跡する二段階フィルタを実装している（`queryObserver.ts:656-696`）
- `[MUST]` バンドルサイズに上限値を設定し、CI で自動的に検証する
  - 根拠: `.size-limit.json` で最小構成 9.99 kB / フル構成 13.00 kB の制限を設け、PR ごとに自動チェックしている
- `[SHOULD]` 状態変更の通知はバッチ処理でまとめ、同一フレーム内の複数更新が個別にレンダリングを引き起こさないようにする
  - 根拠: `notifyManager.ts` の `batch` がネスト対応のトランザクションカウンタでキューイングし、`flush` で一括通知する
- `[SHOULD]` キャッシュデータの更新時は深い比較で旧参照を最大限再利用し、参照同一性に依存するフレームワーク（React 等）の無駄な再レンダリングを防ぐ
  - 根拠: `replaceEqualDeep` がデフォルトで全 Query データに適用され、変更のないサブツリーは旧オブジェクト参照をそのまま返す（`utils.ts:267-314`）
- `[SHOULD]` メモリ解放は利用者数に基づいて遅延スケジュールし、最後の消費者がいなくなってから一定時間後に実行する
  - 根拠: `Removable` 基底クラスが Observer 数ゼロ検出後に `gcTime` タイマーをスケジュールし、再度 Observer が付いたらタイマーをクリアする（`removable.ts:13-21`、`query.ts:343-373`）
- `[SHOULD]` プラットフォーム依存の API（setTimeout, イベントリスナー等）は抽象層を介して呼び出し、テスト時やスケーラビリティ改善時に差し替え可能にする
  - 根拠: `TimeoutManager` がタイマー実装を Provider パターンで差し替え可能にし、大量タイマー時の coalescing を許容する設計（`timeoutManager.ts:54-124`）
- `[AVOID]` リソース（AbortSignal 等）を消費側が使うかどうか不明な段階で即座に副作用を登録すること。遅延評価で実際にアクセスされた時点で初めて副作用を有効にする
  - 根拠: `addConsumeAwareSignal` が `Object.defineProperty` の getter で signal のアクセスを検知し、未消費なら abort イベントを登録しない（`utils.ts:471-499`）

## 適用チェックリスト

- [ ] 外部ストアからの通知に shallow equal 比較を挟み、変更がない場合は通知をスキップしているか
- [ ] 複数の状態更新が同一フレーム内で発生する箇所でバッチ処理を行っているか
- [ ] API レスポンスの参照安定性を確保する仕組み（構造的共有、メモ化）があるか
- [ ] キャッシュの GC 戦略が明示的に設計されているか（即座の削除ではなく遅延削除）
- [ ] select / transform 関数が毎レンダリングで新しい参照を生成していないか
- [ ] バンドルサイズの上限値が CI で監視されているか
- [ ] タイマーやイベントリスナーなどのプラットフォーム API が抽象化されテスト可能になっているか
- [ ] AbortSignal 等のリソースが遅延評価で必要時のみ初期化されているか
