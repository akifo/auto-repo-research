# error-handling-idioms

> リポジトリ: TanStack/query
> 分析日: 2026-02-17

## 概要

TanStack Query のエラーハンドリング戦略を分析する。このライブラリは非同期状態管理において「エラーをどこで・どう扱うか」を開発者が選択できる多層設計を採っている。コアの Retryer による指数バックオフリトライ、ステートマシンによるエラー状態の宣言的管理、React Error Boundary との統合、そしてコールバックチェーンにおけるエラー隔離パターンが注目に値する。6 つのフレームワークアダプターに対して単一のエラーモデルを提供しつつ、各フレームワーク固有のエラー伝播メカニズム（React の throw、Vue の watch、Solid の createResource）にアダプタ層で接続している点は、フレームワーク非依存ライブラリの設計として参考になる。

## 背景にある原則

- **エラーは値として表現し、伝播方法は消費者が選ぶべき**: Query/Mutation の状態に `error`, `failureCount`, `failureReason` を値として保持し、throw するかどうかは `throwOnError` オプションで消費者が決める。エラーを例外として一律に throw せず、状態として管理することで宣言的 UI との親和性を確保している（`types.ts:300-310` の `ThrowOnError` 型定義）。
- **リトライは一時的障害を前提とし、上限と遅延を制御可能にすべき**: サーバー側ではリトライ 0、クライアント側ではデフォルト 3 回、指数バックオフ（上限 30 秒）を適用する。リトライ条件を `boolean | number | function` の 3 形式で受け付けることで、エラー種別に応じた柔軟な制御を可能にしている（`retryer.ts:169`）。
- **エラーコールバックの失敗が本体の処理を壊してはならない**: Mutation の `onError`/`onSettled` コールバックは各々 try-catch で囲み、例外が発生しても `void Promise.reject(e)` でグローバルに伝播しつつ、後続コールバックの実行を保証している（`mutation.ts:274-322`）。
- **Error Boundary との連携にはリセットプロトコルが必要**: Error Boundary でキャッチした後のリカバリには「リトライ抑制 → ユーザーリセット → 再フェッチ」というプロトコルが必要であり、`QueryErrorResetBoundary` がこの状態遷移を管理している（`QueryErrorResetBoundary.tsx:15-28`）。

## 実例と分析

### Retryer: 指数バックオフとネットワーク感知リトライ

`createRetryer` はリトライの全ライフサイクルを管理するファクトリ関数である。特筆すべきは、リトライループがネットワーク状態とドキュメント可視性を考慮する点である。

```typescript
// packages/query-core/src/retryer.ts:48-49
function defaultRetryDelay(failureCount: number) {
  return Math.min(1000 * 2 ** failureCount, 30000)
}
```

指数バックオフに 30 秒の上限を設けている。上限がない場合、5 回目のリトライで 32 秒、6 回目で 64 秒と指数的に増大し、ユーザー体験が破綻する。

リトライループ内部では、`sleep` 後に `canContinue()` でフォーカス状態とオンライン状態を確認し、条件を満たさなければ `pause()` で待機する（`retryer.ts:191-203`）。これにより、タブが非アクティブの間やオフライン時に無意味なリトライを抑制する。

サーバー環境とクライアント環境でデフォルトリトライ回数を切り替えている点も重要:

```typescript
// packages/query-core/src/retryer.ts:169
const retry = config.retry ?? (isServer ? 0 : 3)
```

SSR ではリトライしてもネットワーク状態が変わる見込みがなく、レスポンスが遅延するだけであるため 0 に設定している。

### エラー状態のステートマシン管理

Query は Redux スタイルの dispatch/reducer パターンで状態遷移を管理する。エラー関連のアクションは `failed`（リトライ中の途中経過）と `error`（最終的な失敗）の 2 種類に分離されている。

```typescript
// packages/query-core/src/query.ts:612-616
case 'failed':
  return {
    ...state,
    fetchFailureCount: action.failureCount,
    fetchFailureReason: action.error,
  }
```

```typescript
// packages/query-core/src/query.ts:650-664
case 'error':
  const error = action.error
  return {
    ...state,
    error,
    errorUpdateCount: state.errorUpdateCount + 1,
    errorUpdatedAt: Date.now(),
    fetchFailureCount: state.fetchFailureCount + 1,
    fetchFailureReason: error,
    fetchStatus: 'idle',
    status: 'error',
    isInvalidated: true,
  }
```

`failed` はリトライ中の「途中経過」であり `status` を変更しない。`error` は最終確定であり `status: 'error'` に遷移する。この分離により、UI はリトライ中のプログレス（`failureCount`）と最終的な失敗を区別して表示できる。

### Mutation のエラーコールバック隔離

Mutation のエラーパスでは、各コールバックが独立した try-catch で囲まれている:

```typescript
// packages/query-core/src/mutation.ts:274-296
} catch (error) {
  try {
    await this.#mutationCache.config.onError?.(
      error as any, variables, this.state.context,
      this as Mutation<unknown, unknown, unknown, unknown>, mutationFnContext,
    )
  } catch (e) {
    void Promise.reject(e)
  }

  try {
    await this.options.onError?.(
      error as TError, variables, this.state.context, mutationFnContext,
    )
  } catch (e) {
    void Promise.reject(e)
  }
  // ... onSettled も同様
```

`void Promise.reject(e)` は意図的なパターンである。コールバック内の例外を握り潰さず（グローバルの `unhandledrejection` イベントで検知可能）、かつ後続コールバックの実行を保証する。`catch(noop)` で黙殺するのではなく、開発者に通知しつつフローを壊さない絶妙なバランスである。

### throwOnError: 宣言的エラーと命令的エラーの橋渡し

`throwOnError` オプションは `boolean | function` を受け付け、エラーを Error Boundary に伝播するかどうかをエラー単位で制御できる:

```typescript
// packages/query-core/src/utils.ts:459-469
export function shouldThrowError<T extends (...args: Array<any>) => boolean>(
  throwOnError: boolean | T | undefined,
  params: Parameters<T>,
): boolean {
  if (typeof throwOnError === 'function') {
    return throwOnError(...params)
  }
  return !!throwOnError
}
```

React アダプタでは `useBaseQuery` の末尾で `getHasError` を評価し、条件を満たせば `throw result.error` する（`useBaseQuery.ts:132-142`）。Suspense クエリでは `defaultThrowOnError` が自動適用され、「データがない場合のみ throw」というポリシーが強制される:

```typescript
// packages/react-query/src/suspense.ts:11-19
export const defaultThrowOnError = <...>(
  _error: TError,
  query: Query<TQueryFnData, TError, TData, TQueryKey>,
) => query.state.data === undefined
```

バックグラウンドリフェッチで失敗した場合、既存データがあればエラーを throw しない。これにより、キャッシュデータを表示しつつエラー状態を `isError` フラグで通知できる。

### QueryErrorResetBoundary: Error Boundary リカバリプロトコル

Error Boundary でキャッチされたエラーからの復帰には、リトライ抑制メカニズムが必要である。Error Boundary がリセットされる前にクエリが再フェッチを試みると、同じエラーで再度 boundary がトリガーされ無限ループに陥る。

```typescript
// packages/react-query/src/errorBoundaryUtils.ts:30-44
export const ensurePreventErrorBoundaryRetry = <...>(...) => {
  const throwOnError = ...
  if (options.suspense || options.experimental_prefetchInRender || throwOnError) {
    if (!errorResetBoundary.isReset()) {
      options.retryOnMount = false
    }
  }
}
```

`isReset` フラグが `false`（ユーザーがまだリセット操作をしていない）の間は `retryOnMount = false` を設定し、コンポーネント再マウント時の自動リフェッチを抑制する。ユーザーが「リトライ」ボタンを押すと `reset()` が呼ばれ、`isReset` が `true` になり、次のマウントで再フェッチが許可される。

### CancelledError: キャンセルの意図を型で表現する

`CancelledError` は `revert` と `silent` の 2 つのフラグを持ち、キャンセルの種別を表現する:

```typescript
// packages/query-core/src/retryer.ts:58-66
export class CancelledError extends Error {
  revert?: boolean
  silent?: boolean
  constructor(options?: CancelOptions) {
    super('CancelledError')
    this.revert = options?.revert
    this.silent = options?.silent
  }
}
```

Query の fetch メソッドでは `instanceof CancelledError` でキャンセルを検出し、フラグに応じて異なるリカバリを行う（`query.ts:569-583`）。`silent` の場合は新しい fetch の Promise に委譲し、`revert` の場合は以前の状態にロールバックする。

### フレームワーク横断のエラー伝播戦略

同じ `shouldThrowError` ロジックが、各フレームワークの固有メカニズムに接続されている:

- **React**: レンダリング中に `throw` して Error Boundary にキャッチさせる（`useBaseQuery.ts:141`）
- **Vue**: `watch(() => state.error, ...)` で監視し、条件を満たせば `throw` する（`vue-query/useBaseQuery.ts:196-210`）
- **Solid**: `createResource` の reject に接続する（`solid-query/useBaseQuery.ts:251-262`）

コアの `shouldThrowError` 関数がフレームワーク非依存な判定ロジックを提供し、アダプタ層がフレームワーク固有の伝播手段に変換している。

## パターンカタログ

- **Retry with Exponential Backoff** (分類: 振る舞い / 復元パターン)
  - 解決する問題: 一時的なネットワーク障害やサーバー過負荷からの自動復帰
  - 適用条件: 一時的なエラーが予想される非同期操作。SSR では無効化すべき
  - コード例: `packages/query-core/src/retryer.ts:48-49`, `169-178`
  - 注意点: 上限なしの指数バックオフは遅延が発散する。30 秒の上限が妥当

- **State Machine** (分類: 振る舞い / 状態パターン)
  - 解決する問題: エラー状態の不整合（データとエラーの同時存在等）
  - 適用条件: 複数の状態遷移を持つ非同期処理
  - コード例: `packages/query-core/src/query.ts:607-676`（dispatch/reducer）
  - 注意点: `failed` と `error` の分離が重要。リトライ中の途中経過と最終結果を混同しない

- **Error Boundary Integration Protocol** (分類: 振る舞い / オブザーバーの変形)
  - 解決する問題: 宣言的 UI フレームワークでのエラー復帰フロー制御
  - 適用条件: Error Boundary + 自動リフェッチの組み合わせ
  - コード例: `packages/react-query/src/QueryErrorResetBoundary.tsx:15-28`, `errorBoundaryUtils.ts:30-44`
  - 注意点: リセットフラグなしにリフェッチを許可すると無限ループになる

## Good Patterns

- **エラー種別に応じたリトライ制御関数**: `retry` オプションに関数を渡すことで、4xx エラーはリトライしない、5xx のみリトライするといったエラー種別に応じた制御ができる。`boolean | number | function` のユニオン型により、シンプルなケースと複雑なケースの両方をカバーしている。

```typescript
// RetryValue の型定義: packages/query-core/src/retryer.ts:34-39
export type RetryValue<TError> = boolean | number | ShouldRetryFunction<TError>
type ShouldRetryFunction<TError = DefaultError> = (
  failureCount: number,
  error: TError,
) => boolean

// 利用例: 4xx はリトライしない
retry: (failureCount, error) => {
  if (error.status >= 400 && error.status < 500) return false
  return failureCount < 3
}
```

- **コールバックエラーの隔離と通知**: Mutation のエラーパスで各コールバックを独立した try-catch で囲み、`void Promise.reject(e)` でグローバルに通知する。後続コールバックの実行を保証しつつ、例外を黙殺しない。

```typescript
// packages/query-core/src/mutation.ts:274-285
try {
  await this.#mutationCache.config.onError?.(error as any, variables, ...)
} catch (e) {
  void Promise.reject(e)  // グローバル通知 + フロー継続
}
try {
  await this.options.onError?.(error as TError, variables, ...)
} catch (e) {
  void Promise.reject(e)
}
```

- **Suspense 用の条件付き throwOnError**: `defaultThrowOnError` は「データがない場合のみ throw」というポリシーを実装する。バックグラウンドリフェッチの失敗ではキャッシュデータを維持し、初回ロード失敗のみ Error Boundary に伝播する。

```typescript
// packages/react-query/src/suspense.ts:11-19
export const defaultThrowOnError = <...>(
  _error: TError,
  query: Query<TQueryFnData, TError, TData, TQueryKey>,
) => query.state.data === undefined
```

## Anti-Patterns / 注意点

- **リトライ中のエラーと最終エラーの混同**: `fetchFailureCount` / `fetchFailureReason`（リトライ途中）と `error` / `status: 'error'`（最終結果）を区別しないと、リトライ中に UI がエラー表示に切り替わる問題が発生する。

```typescript
// Bad: status で最終エラーかリトライ中かを区別しない
if (query.state.fetchFailureCount > 0) {
  showErrorUI()  // リトライ中にエラー表示されてしまう
}

// Better: status と fetchStatus の組み合わせで判断
if (query.state.status === 'error') {
  showErrorUI()  // リトライ完了後のみ
} else if (query.state.fetchFailureCount > 0) {
  showRetryingIndicator()  // リトライ中のインジケーター
}
```

- **Error Boundary リセットなしの自動リフェッチ**: Error Boundary でキャッチした後、リセットプロトコルなしにリフェッチを許可すると、同じエラーで再度 throw → catch → throw の無限ループに陥る。

```typescript
// Bad: Error Boundary 内で無条件にリフェッチ
<ErrorBoundary fallback={<button onClick={() => refetch()}>Retry</button>}>

// Better: QueryErrorResetBoundary でリセット状態を管理
<QueryErrorResetBoundary>
  {({ reset }) => (
    <ErrorBoundary onReset={reset} fallback={...}>
      <MyComponent />
    </ErrorBoundary>
  )}
</QueryErrorResetBoundary>
```

- **コールバック内例外の無視**: `catch(noop)` でコールバックの例外を完全に黙殺すると、デバッグが困難になる。TanStack Query は `void Promise.reject(e)` を使い、`unhandledrejection` イベントで検知可能にしている。

```typescript
// Bad: 例外を完全に黙殺
try { await onError?.(error) } catch { /* 無視 */ }

// Better: グローバルに通知しつつフロー継続
try { await onError?.(error) } catch (e) { void Promise.reject(e) }
```

## 導出ルール

- `[MUST]` リトライの指数バックオフには上限時間を設ける（例: 30 秒）
  - 根拠: `retryer.ts:49` で `Math.min(1000 * 2 ** failureCount, 30000)` としており、上限なしでは遅延が指数的に発散しユーザー体験が破綻する
- `[MUST]` Error Boundary と自動リフェッチを組み合わせる場合、リセットプロトコルを実装する
  - 根拠: `errorBoundaryUtils.ts:41-43` で `isReset()` チェックなしにリフェッチを許可すると throw → catch → throw の無限ループが発生する
- `[SHOULD]` リトライ中の途中経過（failureCount）と最終的なエラー状態を別フィールドで管理する
  - 根拠: `query.ts:612-616`（failed アクション）と `query.ts:650-664`（error アクション）を分離することで、リトライ中にエラー UI が表示される問題を防止している
- `[SHOULD]` エラーコールバックチェーンでは各コールバックを独立した try-catch で囲み、例外をグローバルに通知しつつ後続の実行を保証する
  - 根拠: `mutation.ts:274-322` で `void Promise.reject(e)` パターンを使い、コールバック例外がフロー全体を壊さないようにしている
- `[SHOULD]` サーバー環境とクライアント環境でリトライポリシーを切り替える（SSR ではリトライ 0）
  - 根拠: `retryer.ts:169` の `isServer ? 0 : 3` — SSR ではネットワーク状態変化が見込めず、リトライは応答遅延を増大させるだけである
- `[SHOULD]` エラーの伝播方法（throw vs 状態として保持）は消費者が選択できるようにする
  - 根拠: `types.ts:300-310` の `ThrowOnError` 型と `utils.ts:459-469` の `shouldThrowError` — `boolean | function` のユニオンでエラー単位の制御を実現している
- `[AVOID]` コールバック内の例外を `catch {}` や `catch(noop)` で完全に黙殺する
  - 根拠: TanStack Query は `void Promise.reject(e)` を使い `unhandledrejection` イベントで検知可能にしている。完全黙殺はデバッグ困難の原因になる

## 適用チェックリスト

- [ ] 非同期データフェッチにリトライ機構を導入しているか。導入している場合、指数バックオフに上限（30 秒程度）を設けているか
- [ ] SSR 環境ではリトライを無効化（または最小化）しているか
- [ ] リトライ条件を boolean だけでなく関数でも受け付けるようにし、エラー種別（4xx vs 5xx 等）に応じた制御が可能か
- [ ] エラー状態をステートマシンで管理し、「リトライ中」と「最終失敗」を区別できるか
- [ ] Error Boundary と自動リフェッチを併用する場合、リセットプロトコル（QueryErrorResetBoundary 相当）を実装しているか
- [ ] エラーの伝播方法（throw vs 状態値）を `throwOnError` のようなオプションで消費者が選択できるか
- [ ] Mutation のエラーコールバックチェーンで、各コールバックの例外が後続を壊さないように隔離されているか
- [ ] キャンセルとエラーを区別する仕組み（CancelledError 相当）があるか
