# state-management-patterns

> リポジトリ: TanStack/query
> 分析日: 2026-02-17

## 概要

TanStack Query の非同期状態管理アーキテクチャを、状態遷移モデル・キャッシュ戦略・通知最適化の観点から横断的に分析した。このリポジトリは「サーバー状態」という非同期・共有・外部所有のデータを、フレームワーク非依存のコアで一元管理している点が注目に値する。Query と Mutation の双方で Action-Reducer パターンによる予測可能な状態遷移を実装し、Observer パターンで UI レイヤーとの疎結合を実現している。GC・stale 判定・リトライ・バッチ通知といった横断的関心事が、それぞれ独立した抽象として分離されている設計は、非同期キャッシュレイヤーを構築する際の参考となる。

## 背景にある原則

- **状態遷移は Reducer で閉じ込めるべき、なぜなら非同期操作の中間状態は予測不能になりやすい**: Query と Mutation の両方で `#dispatch` メソッド内に Reducer を定義し、Action の型に応じて次の状態を純粋関数で計算している。これにより fetch/pause/continue/error/success といった複雑な遷移パスが一箇所で管理され、不整合な中間状態が生まれない（`packages/query-core/src/query.ts:607-676`, `packages/query-core/src/mutation.ts:331-386`）。

- **キャッシュの鮮度と存在を分離すべき、なぜなら「古いが存在するデータ」は多くの場面で有用**: TanStack Query は `status`（pending/success/error）と `fetchStatus`（idle/fetching/paused）を直交する2軸で管理している。これにより「成功データがあるが stale なのでバックグラウンドで再取得中」という状態を自然に表現でき、ユーザーには古いデータを即座に表示しつつ裏側で最新化できる。

- **購読ベースの GC が不要な中間管理を排除すべき、なぜなら非同期キャッシュはライフサイクルが予測しにくい**: Observer の有無で GC タイマーを制御し、Observer がゼロになった時点で GC をスケジュールする。Observer が再追加されれば GC はキャンセルされる。これにより「使われなくなったデータは自動的に回収されるが、一時的なアンマウントでは保持される」という柔軟なライフサイクル管理を実現している（`packages/query-core/src/query.ts:343-373`）。

- **通知のバッチ処理でレンダリングコストを制御すべき、なぜなら複数のキャッシュ更新が同時に発生しうる**: `NotifyManager` がトランザクションカウンターでコールバックをキューイングし、フラッシュ時に一括通知する。これにより `invalidateQueries` で複数クエリを同時に無効化しても、UI の再レンダリングは1回に集約される（`packages/query-core/src/notifyManager.ts:17-96`）。

## 実例と分析

### Action-Reducer による状態マシン

Query と Mutation の状態遷移は、Redux 風の Action-Reducer パターンで実装されている。ただし Redux のようにグローバルストアではなく、各 Query/Mutation インスタンスが自身の Reducer を持つ。Action の型は union type で網羅され、switch 文で各遷移を処理する。

Query の Action 型は 8 種類（`fetch`, `success`, `error`, `invalidate`, `pause`, `continue`, `failed`, `setState`）あり、Mutation は 6 種類（`pending`, `success`, `error`, `pause`, `continue`, `failed`）ある。特に `pause`/`continue` はオフライン対応のためのアクションで、ネットワーク切断時にフェッチを一時停止し、復帰時に再開する仕組みを状態遷移として明示的にモデル化している。

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

### status と fetchStatus の直交設計

Query の状態は `status`（`pending` / `success` / `error`）と `fetchStatus`（`idle` / `fetching` / `paused`）の2軸で表現される。これは「データの有無」と「通信の状態」を独立に扱う設計で、従来の `isLoading` だけでは表現できない状態を自然にモデル化する。

```typescript
// packages/query-core/src/query.ts:48-61
export interface QueryState<TData = unknown, TError = DefaultError> {
  data: TData | undefined;
  dataUpdateCount: number;
  dataUpdatedAt: number;
  error: TError | null;
  errorUpdateCount: number;
  errorUpdatedAt: number;
  fetchFailureCount: number;
  fetchFailureReason: TError | null;
  fetchMeta: FetchMeta | null;
  isInvalidated: boolean;
  status: QueryStatus;
  fetchStatus: FetchStatus;
}
```

`isLoading` は `isPending && isFetching` として導出され、`isRefetching` は `isFetching && !isPending` として導出される。こうした boolean フラグは状態そのものではなく、2軸の状態から計算される派生値として `QueryObserver.createResult` 内で算出される（`packages/query-core/src/queryObserver.ts:553-589`）。

### Observer パターンによる UI レイヤーとの疎結合

キャッシュレイヤー（QueryCache/Query）と UI レイヤーの間に Observer（QueryObserver）を挟むことで、フレームワーク非依存のコアを実現している。

- `Query` は Observer の配列を保持し、状態変化時に全 Observer に通知する
- `QueryObserver` は `Subscribable` を継承し、UI レイヤーからのリスナー登録を受け付ける
- React 統合では `useSyncExternalStore` で Observer を購読する

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

### GC とライフサイクル管理

`Removable` 基底クラスが GC の仕組みを提供する。デフォルトの `gcTime` はクライアントで5分、サーバーで Infinity。

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

  protected abstract optionalRemove(): void;
}
```

Query の `optionalRemove` は「Observer がゼロかつ fetchStatus が idle の場合のみ」キャッシュから自身を削除する。Mutation の `optionalRemove` は「Observer がゼロで pending でない場合」に削除する。つまり、進行中の非同期処理があればメモリ上に残す。

```typescript
// packages/query-core/src/query.ts:221-225
protected optionalRemove() {
  if (!this.observers.length && this.state.fetchStatus === 'idle') {
    this.#cache.remove(this)
  }
}
```

Observer が追加されると GC タイマーはクリアされ、Observer がすべて削除されると GC が再スケジュールされる（`packages/query-core/src/query.ts:343-373`）。

### stale 判定と自動再取得

stale 判定は `staleTime` と `dataUpdatedAt` のタイムスタンプ比較で行われる。`staleTime` は関数でも指定可能で、Query の状態に応じて動的に変更できる。`'static'` を指定すると永久に stale にならない。

```typescript
// packages/query-core/src/query.ts:308-323
isStaleByTime(staleTime: StaleTime = 0): boolean {
  if (this.state.data === undefined) { return true }
  if (staleTime === 'static') { return false }
  if (this.state.isInvalidated) { return true }
  return !timeUntilStale(this.state.dataUpdatedAt, staleTime)
}
```

自動再取得は3つのトリガーで発動する:

1. **マウント時** (`refetchOnMount`): `shouldFetchOnMount` で判定
2. **ウィンドウフォーカス時** (`refetchOnWindowFocus`): `FocusManager` 経由
3. **ネットワーク復帰時** (`refetchOnReconnect`): `OnlineManager` 経由

いずれも stale 判定を通過した場合のみ実行される。`FocusManager` と `OnlineManager` は `Subscribable` を継承し、ブラウザイベントのリスナー登録/解除を自動で管理する。

### Retryer によるリトライ抽象

Retryer はリトライロジックを Query/Mutation から分離した専用モジュール。指数バックオフ（`Math.min(1000 * 2 ** failureCount, 30000)`）をデフォルトとし、オフライン時は自動で pause する。

```typescript
// packages/query-core/src/retryer.ts:48-50
function defaultRetryDelay(failureCount: number) {
  return Math.min(1000 * 2 ** failureCount, 30000);
}
```

サーバーサイドではデフォルトのリトライ回数が 0、クライアントでは 3 と環境に応じたデフォルト値を持つ（`packages/query-core/src/retryer.ts:169`）。

### 構造的共有（Structural Sharing）

`replaceEqualDeep` は、新旧データを深く比較し、変更のない部分の参照を維持する。これにより React の `useMemo` や `shouldComponentUpdate` の参照比較が効率的に機能する。

```typescript
// packages/query-core/src/utils.ts:267-314
export function replaceEqualDeep(a: any, b: any, depth = 0): any {
  if (a === b) return a;
  if (depth > 500) return b;
  // ...配列・オブジェクトを再帰的に比較し、変更のないサブツリーは旧参照を維持
  return aSize === bSize && equalItems === aSize ? a : copy;
}
```

### MutationCache のスコープと直列実行

`MutationCache` は `scope.id` による Mutation のグループ化と直列実行制御を提供する。同じスコープ内の Mutation は先行する Mutation が完了するまで後続は待機する。

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
    return true
  }
}
```

### AbortSignal の遅延消費による最適化

Query の `fetch` メソッドでは、AbortSignal を `Object.defineProperty` の getter で遅延評価する。Signal が実際に読まれた場合のみ `#abortSignalConsumed` フラグが立ち、Observer 削除時のキャンセル動作が変わる。Signal を消費していないクエリは、アンマウント後もフェッチを続行してキャッシュに結果を保持する。

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

## パターンカタログ

- **Observer パターン** (分類: 振る舞い)
  - 解決する問題: キャッシュレイヤーと UI レイヤーの結合度を下げ、フレームワーク非依存のコアを実現する
  - 適用条件: 同じデータを複数のコンシューマが参照し、変更通知が必要な場合
  - コード例: `packages/query-core/src/subscribable.ts:1-30`, `packages/query-core/src/queryObserver.ts:40-46`
  - 注意点: Observer のライフサイクル管理（登録解除忘れ）に注意。TanStack Query では `onUnsubscribe` で自動 destroy している

- **Mediator パターン** (分類: 振る舞い)
  - 解決する問題: 複数の通知を一括管理し、通知の順序・バッチングを制御する
  - 適用条件: 状態変更が連鎖的に発生し、通知の重複や順序が問題になる場合
  - コード例: `packages/query-core/src/notifyManager.ts:17-96`
  - 注意点: バッチ処理はトランザクションカウンターで管理されるため、ネストしたバッチも正しく動作する

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: GC のスケジューリングロジックを共通化しつつ、削除条件を派生クラスに委譲する
  - 適用条件: 共通のライフサイクル管理にエンティティ固有の条件分岐がある場合
  - コード例: `packages/query-core/src/removable.ts:5-39`（`scheduleGc` が共通、`optionalRemove` が抽象メソッド）

## Good Patterns

- **直交する状態軸で非同期状態をモデル化する**: `status` と `fetchStatus` を独立させることで、「データあり + 再取得中」「データなし + 停止中」といった組み合わせを自然に表現できる。boolean フラグの組み合わせ爆発を避け、派生値として算出する設計。

- **GC タイマーを Observer ライフサイクルに連動させる**: Observer 追加で GC キャンセル、Observer 全削除で GC スケジュールという仕組みにより、「使われている間は保持、使われなくなったら一定時間後に回収」を自動化する。手動でのキャッシュ管理が不要になる。

```typescript
// packages/query-core/src/query.ts:343-352
addObserver(observer: QueryObserver<any, any, any, any, any>): void {
  if (!this.observers.includes(observer)) {
    this.observers.push(observer)
    this.clearGcTimeout()  // GC 停止
    this.#cache.notify({ type: 'observerAdded', query: this, observer })
  }
}
```

- **AbortSignal の遅延消費でキャンセル粒度を制御する**: Signal の getter を利用して「queryFn が実際に signal を使ったか」を検知する。使っていなければアンマウント後もフェッチを完了させてキャッシュに保持する。トランスポート層のキャンセル対応状況に応じて動作が適応する。

- **通知のバッチ処理でレンダリング回数を最小化する**: `notifyManager.batch` でトランザクション中の通知をキューに溜め、トランザクション終了時に一括フラッシュする。`invalidateQueries` のような一括操作でも UI 更新は1回。

## Anti-Patterns / 注意点

- **単一の boolean フラグで非同期状態を表現する**: `isLoading` だけで管理すると、「初回ロード中」と「再取得中（既存データあり）」を区別できない。ユーザーは再取得のたびにスピナーを見ることになる。

```typescript
// Bad: 単一フラグ
const [isLoading, setIsLoading] = useState(false);
// 再取得時にもスピナーが表示される

// Better: 直交する2軸
interface AsyncState<T> {
  status: "pending" | "success" | "error";
  fetchStatus: "idle" | "fetching";
  data: T | undefined;
}
// isRefetching = status === 'success' && fetchStatus === 'fetching'
```

- **タイマー ID を直接 setTimeout で管理する**: グローバルな setTimeout を直接参照すると、テストでのモック差し替えやカスタムタイマー実装が困難になる。TanStack Query は `TimeoutManager` で間接化し、プロバイダーを差し替え可能にしている。

```typescript
// Bad: 直接参照
const id = setTimeout(callback, delay);

// Better: 間接化してプロバイダー差し替え可能にする
const timeoutManager = new TimeoutManager();
timeoutManager.setTimeout(callback, delay);
// テスト時: timeoutManager.setTimeoutProvider(fakeProvider)
```

- **Observer の解除忘れによるメモリリーク**: 購読型の状態管理では、リスナーの解除忘れがメモリリークの原因になる。TanStack Query では `Subscribable.subscribe` が unsubscribe 関数を返し、`onUnsubscribe` フックで Observer 自体の destroy を自動化している。

## 導出ルール

- `[MUST]` 非同期データの状態は「データの有無」と「通信の進行状態」を直交する2軸で管理する
  - 根拠: TanStack Query の `status`/`fetchStatus` 設計が、「stale-while-revalidate」パターンを自然に表現し、単一 `isLoading` フラグでは表現できない8状態を2変数で管理している（`query.ts:48-61`）

- `[MUST]` 非同期状態の遷移は Reducer パターン（Action + 純粋関数）で実装し、状態変更の経路を一箇所に集約する
  - 根拠: Query/Mutation とも `#dispatch` 内の Reducer で全遷移を管理し、fetch/pause/continue/error/success のような複雑な遷移パスでも不整合な中間状態を防いでいる（`query.ts:607-676`）

- `[SHOULD]` キャッシュのライフサイクルは購読者（Observer）の有無に連動させ、購読者ゼロで GC をスケジュール・購読者追加で GC をキャンセルする
  - 根拠: `Removable` + `addObserver`/`removeObserver` の設計により、手動のキャッシュ無効化なしに「使われている間は保持、未使用なら自動回収」を実現している（`removable.ts:13-20`, `query.ts:343-373`）

- `[SHOULD]` 複数の状態変更が同時発生する操作では、通知をバッチ処理して UI 更新回数を最小化する
  - 根拠: `notifyManager.batch` のトランザクションカウンター方式で、`invalidateQueries` 等の一括操作時も Observer への通知が1回にまとまる（`notifyManager.ts:52-64`）

- `[SHOULD]` リトライロジックは状態管理本体から分離し、環境ごとのデフォルト値を持たせる（サーバー: 0回、クライアント: 3回等）
  - 根拠: `createRetryer` が指数バックオフ・pause/continue・キャンセルを一箇所に集約し、Query/Mutation の双方から再利用されている（`retryer.ts:75-228`）

- `[SHOULD]` 構造的共有（Structural Sharing）で、変更のないデータの参照を維持し、不要な再レンダリングを防ぐ
  - 根拠: `replaceEqualDeep` が新旧データを深く比較し、変更のないサブツリーの参照を保持することで React の参照比較が効率的に機能する（`utils.ts:267-314`）

- `[AVOID]` 非同期キャッシュレイヤーを特定の UI フレームワークに結合する設計。Observer パターンで間接化し、フレームワーク統合は薄いアダプター層に限定する
  - 根拠: `query-core` はフレームワーク非依存で、React/Vue/Solid/Svelte/Angular の統合は各パッケージの薄いアダプター層（`useBaseQuery.ts` 等、170行程度）で実現している

## 適用チェックリスト

- [ ] 非同期データの状態を `status`（データの有無・成否）と `fetchStatus`（通信状態）の2軸で設計しているか
- [ ] boolean の派生フラグ（`isLoading`, `isRefetching` 等）を状態そのものではなく、2軸からの計算値として実装しているか
- [ ] 状態遷移を Action-Reducer で一箇所に集約し、不整合な中間状態が生まれないようにしているか
- [ ] キャッシュの GC を購読者ライフサイクルに連動させているか（購読者ゼロ = GC スケジュール）
- [ ] 一括操作（invalidate 等）で複数の状態変更が発生する際、通知をバッチ処理しているか
- [ ] リトライロジックを状態管理から分離し、指数バックオフ・ネットワーク状態連動を実装しているか
- [ ] 構造的共有で変更のないデータの参照を維持し、不要な再レンダリングを防いでいるか
- [ ] UI フレームワークとの結合を薄いアダプター層に限定し、コアのテスタビリティを確保しているか
