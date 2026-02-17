# Practice: Structural Sharing

> 出典: repos/TanStack/query からの分析
> カテゴリ: practice

## 概要

TanStack Query は「構造的共有」「Proxy プロパティ追跡」「バッチ通知」の3層最適化をコアに組み込み、利用者が意識せずとも不要な再レンダリングを最小限に抑える設計を実現している。これらはすべてデフォルトで有効であり、オプトアウト方式で無効化できる。外部ストアとフレームワークの間に存在する「参照が変わるだけで再レンダリングが走る」問題を、ライブラリ内部で体系的に解決するアプローチとして、状態管理ライブラリ全般に応用可能な知見である。

## 背景・文脈

React の `useSyncExternalStore` や仮想 DOM 差分検出は参照比較 (`===`) に依存している。API レスポンスが返るたびに新しい JavaScript オブジェクトが生成されるため、データの中身が同一でも参照が異なれば再レンダリングが発生する。TanStack Query はフレームワーク非依存のコアパッケージ (`query-core`) にパフォーマンス最適化の大半を集約し、React / Vue / Solid 等のアダプター層は薄いグルーコードに留めている。この設計により、以下の3層最適化がどのフレームワークでも一貫して機能する。

## 実装パターン

### 第1層: replaceEqualDeep による構造的共有

前回のデータと新しいデータを再帰的に比較し、変更のないサブツリーは前回の参照をそのまま返す。これにより `===` 比較だけで変化検知が可能になる。

```typescript
// packages/query-core/src/utils.ts:267-314
export function replaceEqualDeep(a: any, b: any, depth = 0): any {
  if (a === b) {
    return a
  }

  if (depth > 500) return b

  const array = isPlainArray(a) && isPlainArray(b)

  if (!array && !(isPlainObject(a) && isPlainObject(b))) return b

  const aItems = array ? a : Object.keys(a)
  const aSize = aItems.length
  const bItems = array ? b : Object.keys(b)
  const bSize = bItems.length
  const copy: any = array ? new Array(bSize) : {}

  let equalItems = 0

  for (let i = 0; i < bSize; i++) {
    const key: any = array ? i : bItems[i]
    const aItem = a[key]
    const bItem = b[key]

    if (aItem === bItem) {
      copy[key] = aItem
      if (array ? i < aSize : hasOwn.call(a, key)) equalItems++
      continue
    }
    // null やプリミティブは再帰せず即座に新しい値を採用
    if (
      aItem === null || bItem === null ||
      typeof aItem !== 'object' || typeof bItem !== 'object'
    ) {
      copy[key] = bItem
      continue
    }

    const v = replaceEqualDeep(aItem, bItem, depth + 1)
    copy[key] = v
    if (v === aItem) equalItems++
  }

  return aSize === bSize && equalItems === aSize ? a : copy
}
```

この関数は `replaceData` 経由で全 Query データに適用される。`structuralSharing` オプションによりカスタム関数への差し替えや無効化も可能。

```typescript
// packages/query-core/src/utils.ts:382-405
export function replaceData<TData, TOptions extends QueryOptions<any, any, any, any>>(
  prevData: TData | undefined, data: TData, options: TOptions,
): TData {
  if (typeof options.structuralSharing === 'function') {
    return options.structuralSharing(prevData, data) as TData
  } else if (options.structuralSharing !== false) {
    return replaceEqualDeep(prevData, data)
  }
  return data
}
```

### 第2層: Proxy による使用プロパティ追跡

`trackResult` は結果オブジェクトを Proxy でラップし、コンポーネントが実際にアクセスしたプロパティを `#trackedProps` に記録する。再レンダリング判定では、追跡されたプロパティのみを比較する。

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
      return Reflect.get(target, key)
    },
  })
}
```

React 統合層では `notifyOnChangeProps` が未指定のとき自動的に `trackResult` を適用する。

```typescript
// packages/react-query/src/useBaseQuery.ts:167-169
return !defaultedOptions.notifyOnChangeProps
  ? observer.trackResult(result)
  : result
```

通知判定では、`#trackedProps` に含まれるプロパティだけを比較し、使用されていないプロパティの変更は無視する。

```typescript
// packages/query-core/src/queryObserver.ts:662-694
const shouldNotifyListeners = (): boolean => {
  if (!prevResult) { return true }
  const { notifyOnChangeProps } = this.options
  // ...
  const includedProps = new Set(
    notifyOnChangePropsValue ?? this.#trackedProps,
  )
  return Object.keys(this.#currentResult).some((key) => {
    const typedKey = key as keyof QueryObserverResult
    const changed = this.#currentResult[typedKey] !== prevResult[typedKey]
    return changed && includedProps.has(typedKey)
  })
}
```

### 第3層: NotifyManager.batch によるバッチ通知

複数の Query が同時に更新されたとき、各更新ごとにフレームワークへ通知すると無駄な再レンダリングが増える。`batch` はトランザクションカウンタで通知をキューに溜め、一括で flush する。

```typescript
// packages/query-core/src/notifyManager.ts:17-64
export function createNotifyManager() {
  let queue: Array<NotifyCallback> = []
  let transactions = 0
  // ...
  return {
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
    // ...
  }
}
```

状態更新後のオブザーバー通知で実際に使用されている箇所:

```typescript
// packages/query-core/src/query.ts:680-686
notifyManager.batch(() => {
  this.observers.forEach((observer) => {
    observer.onQueryUpdate()
  })
  this.#cache.notify({ query: this, type: 'updated', action })
})
```

## Good Example

3層の最適化がデフォルトで協調動作し、利用者は何も設定せずに恩恵を受ける。

```typescript
// Good: デフォルトのまま使う = 全最適化が有効
const { data, isLoading } = useQuery({
  queryKey: ['todos'],
  queryFn: fetchTodos,
})
// 1. replaceEqualDeep: レスポンスの変更されていない部分は前回の参照を再利用
// 2. trackResult: data と isLoading のみ追跡。error や fetchStatus の変更では再レンダリングしない
// 3. batch: 同時に複数の Query が更新されても 1 回の再レンダリングにまとめられる

// Good: select 関数を安定した参照で渡し、メモ化を活かす
const selectDone = useCallback(
  (data: Todo[]) => data.filter((t) => t.done),
  [],
)
const { data } = useQuery({
  queryKey: ['todos'],
  queryFn: fetchTodos,
  select: selectDone,
})
// select の結果にもさらに replaceEqualDeep が適用され、二重の参照安定化が機能する

// Good: Map や Date を含むデータでは structuralSharing を無効化
const { data } = useQuery({
  queryKey: ['events'],
  queryFn: fetchEvents,
  structuralSharing: false,
})
```

## Bad Example

最適化を無効化する設定や、最適化の前提を壊すコード。

```typescript
// Bad: 全プロパティの変更で再レンダリング
const { data } = useQuery({
  queryKey: ['todos'],
  queryFn: fetchTodos,
  notifyOnChangeProps: 'all', // Proxy 追跡を無効化し、isFetching の変更でも再レンダリングが走る
})

// Bad: select に毎レンダリングで新しい関数参照を渡す
const { data } = useQuery({
  queryKey: ['todos'],
  queryFn: fetchTodos,
  select: (data) => data.filter((t) => t.done), // 毎回新しい参照 → メモ化が無効
})

// Bad: Observer への通知をバッチ化せず個別に行う（自作ストアの場合）
observers.forEach((observer) => observer.onUpdate()) // N 回の再レンダリング
cache.notify({ type: 'updated' })                    // さらにもう 1 回
```

## 適用ガイド

- **どのような状況で使うべきか**
  - 外部ストア（API キャッシュ、WebSocket 等）からフレームワークへ状態を伝播するライブラリを設計するとき
  - `===` 比較に依存する UI フレームワーク（React, Solid 等）と組み合わせるデータ管理層を構築するとき
  - 複数の独立した状態変更が短期間に発生し、再レンダリングが性能ボトルネックになるとき

- **導入時の注意点**
  - 構造的共有は JSON シリアライズ可能なプレーンオブジェクトに限定される。`Map`, `Set`, `Date` 等の非 JSON データを扱う場合は `structuralSharing: false` にするか、カスタム関数を渡す
  - `replaceEqualDeep` には深度制限（500）があり、極端に深いネスト構造では新しい参照がそのまま返される
  - Proxy ベースの追跡には微小なオーバーヘッドがある。プロパティが確定している場合は `notifyOnChangeProps` を明示的に指定して Proxy を回避できる
  - バッチ通知はフレームワーク側の更新 API と連携する設計にする。TanStack Query は `setBatchNotifyFunction` で React 等の batch API を注入可能にしている

- **カスタマイズポイント**
  - `structuralSharing` にカスタム関数を渡すことで、独自の参照安定化ロジックを適用できる
  - `notifyOnChangeProps` で監視対象プロパティを明示的に制御できる
  - `setBatchNotifyFunction` / `setScheduler` で通知のスケジューリング戦略をフレームワークごとに差し替えられる

## 参考

- [repos/TanStack/query/performance-techniques.md](../repos/TanStack/query/performance-techniques.md) -- パフォーマンス最適化手法の包括的分析
- [repos/TanStack/query/observer-pattern-techniques.md](../repos/TanStack/query/observer-pattern-techniques.md) -- Observer パターンの実装と通知最適化
- [repos/TanStack/query/design-philosophy.md](../repos/TanStack/query/design-philosophy.md) -- フレームワーク非依存コアの設計思想
