# 並行パターン (Concurrency Patterns)

> リポジトリ: TanStack/query
> 分析日: 2026-02-17

## 概要

TanStack Query は非同期データの取得・キャッシュ・更新を管理するライブラリであり、その中核には洗練された並行制御メカニズムが存在する。同一クエリの重複リクエスト排除、mutation のスコープベース直列化、AbortController による協調的キャンセル、通知のバッチ処理など、複数の並行パターンが一貫した設計思想のもとで組み合わされている。これらのパターンは「不要なネットワークリクエストを排除しつつ、UI の一貫性を保つ」という課題に対する実践的な解法群として注目に値する。

## 背景にある原則

- **Promise 共有による重複排除**: 同一リソースへの並行リクエストが発生した場合、新しいリクエストを起動するのではなく既存の Promise を返す。これにより、複数のコンポーネントが同時にマウントしても単一のネットワークリクエストしか発生しない。根拠: `query.ts:400-404` の `return this.#retryer.promise` パスが、進行中のフェッチに対して既存の Promise を返す実装。
- **協調的キャンセルの段階制御**: キャンセルを一律に行わず、消費者がシグナルを実際に使用したかどうかで挙動を変える。シグナル未使用の場合は結果をキャッシュに残し、使用済みの場合のみ中断する。これにより、キャンセルをサポートしないトランスポートでもデータを無駄にしない。根拠: `query.ts:361-367` の `#abortSignalConsumed` フラグに基づく分岐。
- **スコープベースの直列化**: mutation は既定で並列実行だが、同一スコープに属する mutation は FIFO キューで直列化する。スコープ間は独立並列のまま維持される。この設計により、関連する副作用の順序を保証しつつ、無関係な操作のスループットを損なわない。根拠: `mutationCache.ts:160-175` の `canRun` メソッド。
- **バッチ通知によるレンダリング最適化**: 状態変更が連鎖的に発生しても、通知はトランザクション単位でまとめて1回だけフラッシュする。これにより、中間状態による不要な再レンダリングを排除する。根拠: `notifyManager.ts:52-64` の `batch` メソッドのトランザクションカウンタ機構。

## 実例と分析

### 1. クエリの重複排除メカニズム

`Query#fetch` メソッドは、呼び出し時に現在の `fetchStatus` と `Retryer` の状態を確認し、既に進行中のフェッチがあれば新しいフェッチを起動しない。この判断には3つの分岐がある。

```typescript
// packages/query-core/src/query.ts:386-405
async fetch(options, fetchOptions) {
  if (
    this.state.fetchStatus !== 'idle' &&
    this.#retryer?.status() !== 'rejected'
  ) {
    if (this.state.data !== undefined && fetchOptions?.cancelRefetch) {
      // ユーザーが明示的に cancelRefetch を要求 → サイレントキャンセル後に新フェッチ
      this.cancel({ silent: true })
    } else if (this.#retryer) {
      // 進行中 → リトライを再開させ、既存の Promise を返す
      this.#retryer.continueRetry()
      return this.#retryer.promise
    }
  }
  // ...新しいフェッチを開始
}
```

この設計が意味するのは、`QueryObserver` が複数マウントされても、同一 `queryHash` に対するネットワークリクエストは1つだけだということ。`QueryCache#build` がハッシュベースで既存の `Query` インスタンスを返す (`queryCache.ts:116-131`) ことで、全てのオブザーバーが同じ `Query` を共有する。

### 2. AbortController とシグナル消費検出

TanStack Query は `Object.defineProperty` で `signal` プロパティをゲッターとして定義し、アクセスされた時点で `#abortSignalConsumed` フラグを立てる。

```typescript
// packages/query-core/src/query.ts:435-443
const addSignalProperty = (object: unknown) => {
  Object.defineProperty(object, "signal", {
    enumerable: true,
    get: () => {
      this.#abortSignalConsumed = true;
      return abortController.signal;
    },
  });
};
```

この検出は、最後のオブザーバーがアンマウントされたときの挙動を決定する。

```typescript
// packages/query-core/src/query.ts:354-373
removeObserver(observer) {
  // ...
  if (!this.observers.length) {
    if (this.#retryer) {
      if (this.#abortSignalConsumed) {
        // シグナルが消費されている → 中断をサポートしている → キャンセル
        this.#retryer.cancel({ revert: true })
      } else {
        // シグナル未消費 → キャンセル非対応 → リトライだけ止めて結果はキャッシュ
        this.#retryer.cancelRetry()
      }
    }
    this.scheduleGc()
  }
}
```

### 3. Mutation のスコープベース直列化

`MutationCache` は `#scopes` マップでスコープごとの mutation キューを管理する。`canRun` メソッドが「このスコープに先行する pending mutation がないか」を判定し、`Retryer` の `canRun` コールバックとして渡される。

```typescript
// packages/query-core/src/mutationCache.ts:160-175
canRun(mutation: Mutation<any, any, any, any>): boolean {
  const scope = scopeFor(mutation)
  if (typeof scope === 'string') {
    const mutationsWithSameScope = this.#scopes.get(scope)
    const firstPendingMutation = mutationsWithSameScope?.find(
      (m) => m.state.status === 'pending',
    )
    return !firstPendingMutation || firstPendingMutation === mutation
  } else {
    return true  // スコープなし → 常に実行可能
  }
}
```

先行 mutation の完了後は `runNext` が次の mutation を起動する。

```typescript
// packages/query-core/src/mutationCache.ts:177-188
runNext(mutation: Mutation<any, any, any, any>): Promise<unknown> {
  const scope = scopeFor(mutation)
  if (typeof scope === 'string') {
    const foundMutation = this.#scopes
      .get(scope)
      ?.find((m) => m !== mutation && m.state.isPaused)
    return foundMutation?.continue() ?? Promise.resolve()
  } else {
    return Promise.resolve()
  }
}
```

これは `mutation.ts:327` の `finally` ブロックで呼び出される。成功・失敗に関わらず次の mutation を起動する設計。

### 4. Retryer: リトライ・一時停止・キャンセルの統合制御

`Retryer` は非同期操作の実行制御を一元化するステートマシンである。指数バックオフ付きリトライ、ネットワーク/フォーカス状態に応じた一時停止、明示的キャンセルを単一の抽象で提供する。

```typescript
// packages/query-core/src/retryer.ts:48-49
function defaultRetryDelay(failureCount: number) {
  return Math.min(1000 * 2 ** failureCount, 30000);
}
```

```typescript
// packages/query-core/src/retryer.ts:103-106
const canContinue = () =>
  focusManager.isFocused()
  && (config.networkMode === "always" || onlineManager.isOnline())
  && config.canRun();
```

`pause` 関数は Promise を作成し、`continueFn` としてリゾルバを保存する。ネットワーク復帰やフォーカス復帰時に `continue` が呼ばれると、保存されたリゾルバが実行されてループが再開する。

### 5. 通知のバッチ処理

`notifyManager` はトランザクションカウンタで通知をバッファリングする。`batch` 呼び出し中の通知はキューに蓄積され、最外の `batch` が完了した時点で一括フラッシュされる。

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

### 6. ストリーミングデータの並行処理

`streamedQuery` は AsyncIterable をクエリ関数として扱うヘルパーで、チャンクごとにキャッシュを更新する。リフェッチ時の競合を `refetchMode` で制御する。

```typescript
// packages/query-core/src/streamedQuery.ts:100-113
for await (const chunk of stream) {
  if (cancelled) {
    break;
  }
  if (isReplaceRefetch) {
    result = reducer(result, chunk); // ローカルに蓄積、完了後に一括書き込み
  } else {
    context.client.setQueryData<TData>( // チャンクごとにキャッシュ更新
      context.queryKey,
      (prev) => reducer(prev === undefined ? initialValue : prev, chunk),
    );
  }
}
```

`addConsumeAwareSignal` (`utils.ts:471-499`) により、シグナルの消費検出はストリーミングクエリでも一貫して動作する。

## パターンカタログ

- **Promise Deduplication** (分類: 振る舞い)
  - 解決する問題: 同一リソースへの重複リクエストによる帯域浪費と不整合
  - 適用条件: 同一キーに対する複数の同時リクエストが発生しうる場合
  - コード例: `query.ts:386-405`
  - 注意点: 進行中リクエストのキャンセルと新規リクエスト開始を区別する制御が必要

- **Scoped Serial Execution** (分類: 振る舞い)
  - 解決する問題: 関連する副作用操作の順序保証
  - 適用条件: 同一リソースに対する書き込み操作が並列に発生しうる場合
  - コード例: `mutationCache.ts:160-175`, `mutation.ts:327`
  - 注意点: スコープ間は独立並列であり、スコープ設計がパフォーマンスに直結する

- **Cooperative Cancellation with Signal Consumption Detection** (分類: 振る舞い)
  - 解決する問題: キャンセル非対応トランスポートでの結果ロス防止
  - 適用条件: 消費者がキャンセル対応かどうか実行時まで不明な場合
  - コード例: `query.ts:435-443`, `query.ts:354-373`
  - 注意点: プロパティゲッターによる副作用検出は、消費者が signal を引数で受け取るだけで使わないケースを誤検出しない

- **Transaction-based Batch Notification** (分類: 振る舞い)
  - 解決する問題: 連鎖的状態変更による中間レンダリング
  - 適用条件: 1つの論理操作が複数の状態変更を引き起こす場合
  - コード例: `notifyManager.ts:52-64`
  - 注意点: ネストした `batch` を正しく処理するためトランザクションカウンタが必要

## Good Patterns

- **ハッシュベースのインスタンス共有**: `QueryCache#build` は `queryHash` で既存の `Query` インスタンスを検索し、存在すればそれを返す。これにより、同じデータを参照する全てのオブザーバーが自動的に同一インスタンスを共有し、重複排除が構造的に保証される。

```typescript
// packages/query-core/src/queryCache.ts:112-131
build(client, options, state) {
  const queryKey = options.queryKey
  const queryHash = options.queryHash ?? hashQueryKeyByOptions(queryKey, options)
  let query = this.get(queryHash)
  if (!query) {
    query = new Query({ client, queryKey, queryHash, options, state, defaultOptions })
    this.add(query)
  }
  return query
}
```

- **CancelledError による状態復元**: キャンセル時に `revert` フラグを持つ `CancelledError` を使い、楽観的更新を安全にロールバックする。エラーオブジェクト自体がロールバック指示を運ぶため、呼び出し元に特別な分岐を強制しない。

```typescript
// packages/query-core/src/retryer.ts:58-66
export class CancelledError extends Error {
  revert?: boolean;
  silent?: boolean;
  constructor(options?: CancelOptions) {
    super("CancelledError");
    this.revert = options?.revert;
    this.silent = options?.silent;
  }
}
```

```typescript
// packages/query-core/src/query.ts:521-529
onCancel: (error) => {
  if (error instanceof CancelledError && error.revert) {
    this.setState({
      ...this.#revertState,
      fetchStatus: 'idle' as const,
    })
  }
  abortController.abort()
},
```

- **Reducer ベースの状態遷移**: `Query` と `Mutation` の `#dispatch` メソッドは、アクションを受け取り新しい状態を返す純粋な reducer 関数で状態遷移を表現する。これにより、並行する状態変更が予測可能な結果を生む。

```typescript
// packages/query-core/src/query.ts:607-678
#dispatch(action: Action<TData, TError>): void {
  const reducer = (state: QueryState<TData, TError>): QueryState<TData, TError> => {
    switch (action.type) {
      case 'fetch': return { ...state, ...fetchState(state.data, this.options), fetchMeta: action.meta ?? null }
      case 'success': return { ...state, ...successState(action.data, action.dataUpdatedAt), /* ... */ }
      case 'error': return { ...state, error, /* ... */ status: 'error' }
      // ...
    }
  }
  this.state = reducer(this.state)
  notifyManager.batch(() => { /* notify observers */ })
}
```

## Anti-Patterns / 注意点

- **シグナル未伝播によるリソースリーク**: `queryFn` に渡された `signal` を下位の fetch 呼び出しに渡さないと、クエリがキャンセルされてもネットワークリクエストは実行され続ける。TanStack Query はシグナル消費を検出するため、アクセスしただけで未伝播だとキャンセルが発動するが実際には中断されないという矛盾が生じる。

```typescript
// Bad: signal にアクセスするがfetchに渡さない
queryFn: (async ({ signal }) => {
  console.log(signal.aborted); // signal consumed → キャンセル発動するが...
  const res = await fetch("/api/data"); // signal 未伝播 → リクエストは続行
  return res.json();
});

// Better: signal を fetch に渡す
queryFn: (async ({ signal }) => {
  const res = await fetch("/api/data", { signal });
  return res.json();
});
```

- **スコープ粒度の設計ミス**: mutation スコープを広すぎる粒度で設定すると、無関係な mutation が直列化されてスループットが低下する。逆に狭すぎると、本来順序を保証すべき操作が並列実行されてデータ不整合が発生する。

```typescript
// Bad: 全 mutation を単一スコープに → グローバル直列化
useMutation({ scope: { id: "global" }, mutationFn: updateUser });
useMutation({ scope: { id: "global" }, mutationFn: updatePost });

// Better: リソース単位のスコープ
useMutation({ scope: { id: `user-${userId}` }, mutationFn: updateUser });
useMutation({ scope: { id: `post-${postId}` }, mutationFn: updatePost });
```

## 導出ルール

- `[MUST]` 同一リソースへの並行リクエストは Promise を共有して重複排除する -- 単にリクエストを間引くのではなく、進行中の Promise 自体を返すことで全ての呼び出し元に同じ結果を保証する
  - 根拠: `Query#fetch` は進行中のフェッチに対して `this.#retryer.promise` を返し、新しいリクエストを起動しない (`query.ts:400-404`)

- `[MUST]` キャンセル処理は AbortSignal を下位のネットワーク呼び出しまで伝播する -- signal にアクセスするだけでは実際の中断は起きない
  - 根拠: TanStack Query はシグナル消費を検出してキャンセル判断に使うが (`query.ts:435-443`)、実際のリクエスト中断は `fetch(url, { signal })` のように伝播して初めて機能する

- `[SHOULD]` 副作用を伴う並行操作にはスコープベースの直列化を導入し、スコープ間は並列に保つ -- リソース単位のスコープ設計がスループットと整合性のバランスを決定する
  - 根拠: `MutationCache#canRun` がスコープ内 FIFO を実現しつつ、スコープ外の mutation は即座に実行可能 (`mutationCache.ts:160-175`)

- `[SHOULD]` 状態変更の通知はバッチ処理し、トランザクション単位でフラッシュする -- 中間状態での不要なレンダリングを排除するため
  - 根拠: `notifyManager.batch` がトランザクションカウンタで通知をバッファリングし、最外の batch 完了時にフラッシュ (`notifyManager.ts:52-64`)

- `[SHOULD]` キャンセル可能な操作では、エラーオブジェクトにロールバック指示を含めて楽観的更新の復元を自動化する -- 呼び出し元に特別なキャンセル処理を強制しない設計
  - 根拠: `CancelledError` の `revert` フラグが `#revertState` への自動復元をトリガーする (`retryer.ts:58-66`, `query.ts:521-529`)

- `[SHOULD]` 非同期操作の再試行ロジックは指数バックオフ + 上限キャップで実装する -- 固定間隔リトライはサーバー過負荷を増幅する
  - 根拠: `defaultRetryDelay` が `Math.min(1000 * 2 ** failureCount, 30000)` で30秒上限の指数バックオフを実装 (`retryer.ts:48-49`)

- `[AVOID]` キャンセルのサポート有無を事前に判定する仕組みを作らない -- 実行時にシグナルの消費を検出する方が、消費者に負担をかけずに適応的に振る舞える
  - 根拠: TanStack Query はプロパティゲッターで signal アクセスを検出し、消費されていなければキャンセルを抑制する (`query.ts:362-366`)。事前宣言方式ではなく実行時検出方式を採用している

## 適用チェックリスト

- [ ] 同一リソースへの並行リクエストが発生する箇所を特定し、Promise 共有による重複排除を実装しているか
- [ ] AbortController/AbortSignal を使用している場合、signal を下位の fetch/XMLHttpRequest まで伝播しているか
- [ ] 同一リソースへの書き込み mutation が並列に発生する可能性がある場合、スコープベースの直列化を検討したか
- [ ] スコープの粒度はリソース単位（ユーザーID、ドキュメントID等）で設計されているか
- [ ] 複数の状態変更が連鎖する箇所でバッチ通知を導入し、中間状態でのレンダリングを防いでいるか
- [ ] 楽観的更新のロールバック機構があり、キャンセル時に自動的に前の状態に復元されるか
- [ ] リトライロジックが指数バックオフ + 上限キャップを使用しているか（固定間隔リトライになっていないか）
- [ ] ストリーミングデータの処理で、リフェッチ時の既存データとの競合を考慮しているか（reset/append/replace 等の戦略）
