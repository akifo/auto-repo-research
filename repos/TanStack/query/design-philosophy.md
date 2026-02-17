# design-philosophy

> リポジトリ: TanStack/query
> 分析日: 2026-02-17

## 概要

TanStack Query の設計思想を分析する。48k+ スターを持つこのライブラリは「非同期状態管理」という問題領域において、フレームワーク非依存コア + アダプター分離、Observer パターンによるリアクティビティ、構造的共有によるレンダリング最適化という設計判断を積み重ねている。React/Vue/Solid/Svelte/Angular の 6 フレームワークをサポートしつつ、`query-core` パッケージの外部依存が **ゼロ** であることは、この設計思想の結実と言える。なぜこれらの選択がなされたのか、別の方法がありえたにもかかわらずなぜこの方法を選んだのかを掘り下げる。

## 背景にある原則

- **原則 1: ビジネスロジックはフレームワークの外に置くべき。なぜなら UI フレームワークの寿命はドメインロジックより短い**: `query-core` は外部依存ゼロ・フレームワーク参照ゼロで全ロジックを実装し、各フレームワークアダプターは薄いグルーコードのみ。React アダプター (`useBaseQuery.ts`) は 170 行、Vue アダプター (`useBaseQuery.ts`) は 228 行に過ぎず、コアの `queryObserver.ts` (828 行) や `query.ts` (756 行) と対照的。これにより v4→v5 のメジャーバージョンアップ時も、コアロジックの変更をフレームワーク間で一貫して適用できた (`query-core/package.json` の description: "The framework agnostic core that powers TanStack Query")。

- **原則 2: 状態遷移は Reducer パターンで一元管理すべき。なぜなら予測可能性がデバッグ容易性と正確性を保証する**: `Query#dispatch` と `Mutation#dispatch` は内部に純粋な reducer 関数を持ち、全状態変更をアクション型 (`fetch` / `success` / `error` / `invalidate` / `pause` / `continue` / `failed` / `setState`) で管理する (`query.ts:607-676`)。Redux 的な状態管理を OOP クラス内に埋め込む非典型的な設計だが、これにより DevTools がアクション履歴をトレースでき、状態の「ありえない組み合わせ」を構造的に排除できる。

- **原則 3: フレームワーク統合点では「購読モデル」を共通言語にすべき。なぜなら push 型の通知は React (useSyncExternalStore) / Vue (watch) / Solid (createSignal) の全てで自然に消費できる**: `Subscribable` 基底クラス (30 行) が全 Observer・Manager・Cache に一貫した `subscribe(() => unsubscribe)` インターフェースを提供する (`subscribable.ts:1-30`)。React は `useSyncExternalStore` で消費し (`useBaseQuery.ts:103-120`)、Vue は `watch` + `reactive` で消費する (`vue-query/useBaseQuery.ts:110-140`)。

- **原則 4: デフォルト値は「一般的なユースケースで最良」を選び、エスケープハッチを必ず用意すべき**: リトライ回数はクライアント側で 3、サーバー側で 0 (`retryer.ts:169`)、GC 時間はクライアント 5 分、サーバー Infinity (`removable.ts:24-28`)。全てのデフォルトは `QueryClient.defaultQueryOptions` で上書き可能で、さらに `queryKey` 単位の `setQueryDefaults` で部分的に変更できる (`queryClient.ts:486-509`)。

## 実例と分析

### フレームワーク非依存コアの実現方法

TanStack Query は「Headless UI」の思想をデータ取得ライブラリに適用した。コアが提供するのは `QueryClient` / `QueryCache` / `QueryObserver` / `Mutation` / `Retryer` などの純粋な JavaScript クラスであり、DOM にも React にも Vue にも一切依存しない。

各フレームワークアダプターの責務は以下の 3 点に限定される:
1. **Observer のライフサイクル管理**: コンポーネントのマウント/アンマウントに Observer の subscribe/destroy を同期させる
2. **リアクティビティの橋渡し**: Observer の通知をフレームワーク固有のリアクティブ機構に変換する
3. **フレームワーク固有の最適化**: React の Suspense 統合、Vue の `Ref` 変換など

```typescript
// packages/react-query/src/useQuery.ts:50-52
export function useQuery(options: UseQueryOptions, queryClient?: QueryClient) {
  return useBaseQuery(options, QueryObserver, queryClient)
}
```

React の `useQuery` は 1 行で Observer クラスを注入しているだけ。InfiniteQuery も同じ `useBaseQuery` に `InfiniteQueryObserver` を渡すだけで実現される。

### Reducer-in-Class パターン: Redux の思想を OOP に埋め込む

状態管理に Redux パターンか OOP パターンかという選択で、TanStack Query は「両方」を選んだ。`Query` クラスは `#dispatch` メソッド内に関数型の reducer を持ち、アクション型で状態遷移を定義する。

```typescript
// packages/query-core/src/query.ts:607-676
#dispatch(action: Action<TData, TError>): void {
  const reducer = (
    state: QueryState<TData, TError>,
  ): QueryState<TData, TError> => {
    switch (action.type) {
      case 'failed':
        return { ...state, fetchFailureCount: action.failureCount, ... }
      case 'fetch':
        return { ...state, ...fetchState(state.data, this.options), ... }
      case 'success':
        // ...
      case 'error':
        // ...
    }
  }
  this.state = reducer(this.state)
  notifyManager.batch(() => {
    this.observers.forEach((observer) => { observer.onQueryUpdate() })
    this.#cache.notify({ query: this, type: 'updated', action })
  })
}
```

別の方法として「各メソッドが直接 `this.state` を変更する」選択肢があったが、reducer パターンを採用することで、(1) 状態遷移の網羅性を switch 文で保証でき、(2) 通知のタイミングを `dispatch` 後に一元化でき、(3) DevTools がアクション履歴を記録できる。

### 構造的共有 (Structural Sharing) による参照安定性

`replaceEqualDeep` は前回のデータと新しいデータを深く比較し、変更されていないサブツリーの参照をそのまま再利用する。

```typescript
// packages/query-core/src/utils.ts:267-314
export function replaceEqualDeep(a: any, b: any, depth = 0): any {
  if (a === b) { return a }
  if (depth > 500) return b
  const array = isPlainArray(a) && isPlainArray(b)
  // ... 各プロパティを再帰的に比較 ...
  return aSize === bSize && equalItems === aSize ? a : copy
}
```

この設計により、サーバーから同じデータが返された場合にオブジェクト参照が変わらず、React の `useMemo` / `useCallback` の依存配列が不要な再レンダリングを引き起こさない。Immutable.js のような不変データ構造ライブラリを使う選択肢もあったが、JSON シリアライズ可能なプレーンオブジェクトのみを対象とすることで外部依存を排除し、ユーザーのデータモデルに制約を課さない。

### NotifyManager によるバッチ通知

通知を即座に発行するのではなく、`notifyManager.batch()` でトランザクション的にまとめる。

```typescript
// packages/query-core/src/notifyManager.ts:17-64
export function createNotifyManager() {
  let queue: Array<NotifyCallback> = []
  let transactions = 0
  // ...
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
    // ...
  }
}
```

React では `setBatchNotifyFunction` に `ReactDOM.unstable_batchedUpdates` (v18 以前) を渡すことで、複数クエリの同時更新を 1 回の再レンダリングにまとめられる。このプロバイダーパターンにより、コアがフレームワーク固有の最適化 API を知らなくても最適化を適用できる。

### Register インターフェースによるモジュール拡張

TypeScript の Module Augmentation を使い、ユーザーがグローバルなデフォルト型を上書きできる。

```typescript
// packages/query-core/src/types.ts:39-45
export interface Register {
  // defaultError: Error
  // queryMeta: Record<string, unknown>
}

export type DefaultError = Register extends { defaultError: infer TError }
  ? TError : Error
```

ユーザーは `declare module '@tanstack/react-query' { interface Register { defaultError: AxiosError } }` と書くだけで全クエリのエラー型を変更できる。ジェネリクスを毎回指定する方式もあったが、「1 回の宣言で全体に適用」という DX を優先した。

### AbortSignal のレイジー検出

`Query.fetch` では AbortSignal を `Object.defineProperty` の getter で遅延提供し、ユーザーが実際に `signal` を読んだかどうかを追跡する。

```typescript
// packages/query-core/src/query.ts:435-443
const addSignalProperty = (object: unknown) => {
  Object.defineProperty(object, 'signal', {
    enumerable: true,
    get: () => {
      this.#abortSignalConsumed = true
      return abortController.signal
    },
  })
}
```

Observer がなくなった時、`signal` が消費されていれば fetch をキャンセルし、消費されていなければキャッシュのために fetch を続行する (`query.ts:360-366`)。これは「ユーザーがキャンセルを気にしていないなら結果をキャッシュに残す」という実用的な判断。

## パターンカタログ

- **Observer パターン** (分類: 振る舞い)
  - 解決する問題: 1 つの Query (Subject) に対して複数のコンポーネント (Observer) が購読し、データ変更時に全 Observer に通知する
  - 適用条件: 1 対多のデータ共有が必要で、Observer の数が動的に変化する場面
  - コード例: `subscribable.ts:1-30`, `queryObserver.ts:40-46`, `query.ts:343-373`
  - 注意点: `Subscribable` は基底クラスとして提供され、`onSubscribe` / `onUnsubscribe` のフック により購読数に応じた副作用 (GC タイマーの開始/停止) を実装できる

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 通常のクエリとインフィニットクエリで fetch のアルゴリズムを切り替える
  - 適用条件: 同じインターフェースで異なるアルゴリズムを差し替えたい場面
  - コード例: `query.ts:78-88` の `QueryBehavior` インターフェース, `infiniteQueryBehavior.ts:16-130`
  - 注意点: `InfiniteQueryObserver` は `QueryObserver` を継承しつつ、`behavior` オプションで fetch ロジックを注入する

- **Mediator パターン** (分類: 振る舞い)
  - 解決する問題: `QueryClient` が `QueryCache`, `MutationCache`, `FocusManager`, `OnlineManager` 間の連携を仲介する
  - 適用条件: 複数のコンポーネント間の相互通信が複雑になる場面
  - コード例: `queryClient.ts:80-96` (mount 時に FocusManager/OnlineManager を購読し、Cache に伝達)

## Good Patterns

- **ゼロ依存コアパッケージ**: `query-core` の `package.json` には `dependencies` フィールドがなく、`devDependencies` のみ。フレームワーク固有のコードを一切含まないことで、新しいフレームワーク (Preact, Angular) への対応も薄いアダプター層の追加だけで完了する。これは `react-query` v1-v3 が React に密結合していた時代からの意図的な進化。

- **Private フィールドによるカプセル化**: 全コアクラスが ES2022 の `#` private フィールドを使用。`QueryObserver` の `#client`, `#currentQuery`, `#currentResult` など。TypeScript の `private` キーワードではなくランタイムの `#` を採用することで、トランスパイル後もカプセル化が保証される。

```typescript
// packages/query-core/src/queryObserver.ts:47-69
export class QueryObserver<...> extends Subscribable<...> {
  #client: QueryClient
  #currentQuery: Query<...> = undefined!
  #currentResult: QueryObserverResult<...> = undefined!
  // ...
}
```

- **Tracked Properties による選択的再通知**: `trackResult` が Proxy を使い、コンポーネントが実際にアクセスしたプロパティのみを追跡。変更があっても使われていないプロパティの変更では再レンダリングしない。

```typescript
// packages/query-core/src/queryObserver.ts:263-287
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

## Anti-Patterns / 注意点

- **TimeoutProvider の遅延設定リスク**: `TimeoutManager` はタイマーを使った後にプロバイダーを変更すると、以前のタイマーの `clearTimeout` が正しく動作しない。開発モードでは警告が出るが、本番では静かに問題が発生する。

```typescript
// Bad: タイマー使用後にプロバイダー変更
queryClient.mount()
timeoutManager.setTimeoutProvider(customProvider) // 既存タイマーが壊れる

// Better: QueryClient.mount() より前にプロバイダーを設定
timeoutManager.setTimeoutProvider(customProvider)
const queryClient = new QueryClient()
queryClient.mount()
```

- **GC 時間の暗黙のサーバー/クライアント分岐**: `Removable.updateGcTime` はクライアントで 5 分、サーバーで Infinity をデフォルトにする。SSR 環境での意図しないメモリリークにつながりうるが、これは意図的なトレードオフで、SSR 時のプリフェッチデータが GC されないことを保証するため。

```typescript
// packages/query-core/src/removable.ts:23-28
protected updateGcTime(newGcTime: number | undefined): void {
  this.gcTime = Math.max(
    this.gcTime || 0,
    newGcTime ?? (isServer ? Infinity : 5 * 60 * 1000),
  )
}
```

## 導出ルール

- `[MUST]` マルチフレームワーク対応ライブラリでは、ビジネスロジック・状態管理・キャッシュをフレームワーク非依存コアに分離し、フレームワーク固有コードは購読/通知のグルーレイヤーに限定する
  - 根拠: TanStack Query は `query-core`(外部依存ゼロ) に全ロジックを集約し、6 つのフレームワークアダプターを各 100-230 行の薄いラッパーで実現している

- `[MUST]` 複雑な状態遷移を持つクラスでは、状態変更をアクション型で表現する Reducer パターンで一元管理し、dispatch 後に一括通知する
  - 根拠: `Query#dispatch` と `Mutation#dispatch` は 7-8 種類のアクション型を switch 文で網羅的に処理し、DevTools によるアクション履歴の追跡と状態の予測可能性を両立している (`query.ts:607-687`)

- `[SHOULD]` 購読ベースのライブラリでは、通知をバッチ処理するメカニズムを提供し、フレームワーク側のバッチ更新 API を注入できるようにする
  - 根拠: `NotifyManager` はトランザクションカウンタでバッチ化し、`setBatchNotifyFunction` で React の `unstable_batchedUpdates` 等を注入可能にして、複数クエリの同時更新を 1 回の再レンダリングにまとめる (`notifyManager.ts:17-96`)

- `[SHOULD]` キャッシュされたデータの更新時には、変更されていないサブツリーの参照を維持する構造的共有を行い、不要な再レンダリングを回避する
  - 根拠: `replaceEqualDeep` が前回と同一のデータに対して同一の参照を返すことで、React の参照等価比較による不要な再レンダリングを防止する (`utils.ts:267-314`)

- `[SHOULD]` ライブラリのグローバルなデフォルト型をユーザーが拡張できるように、TypeScript の Module Augmentation 用の空インターフェース (`Register`) を提供する
  - 根拠: `Register` インターフェースにより、ユーザーは `defaultError` / `queryMeta` 等のグローバル型を 1 箇所で宣言するだけで全クエリに適用でき、個別のジェネリクス指定を不要にしている (`types.ts:39-61`)

- `[SHOULD]` キャンセル可能な非同期処理では、キャンセルシグナルの消費有無を追跡し、未消費の場合は結果をキャッシュに残す
  - 根拠: `Query.fetch` は `Object.defineProperty` で `signal` の getter を定義し、読み取り有無で unmount 時の挙動を分岐する。signal 未消費なら fetch を続行してキャッシュに残す (`query.ts:435-443, 360-366`)

- `[AVOID]` 環境判定 (サーバー/クライアント) による暗黙の挙動分岐をデフォルト値に埋め込む場合、分岐の存在をドキュメントで明示しないと SSR 環境で予期しないメモリリークや動作差異を招く
  - 根拠: `Removable.updateGcTime` はサーバーで `Infinity`、クライアントで 5 分をデフォルトにしており、SSR/SSG 環境でのメモリ影響を意識する必要がある (`removable.ts:24-28`)

## 適用チェックリスト

- [ ] ライブラリ設計時: ビジネスロジックがフレームワーク固有の API (React hooks, Vue Composition API 等) に直接依存していないか確認する
- [ ] 状態管理: 3 つ以上の状態遷移がある場合、Reducer パターン (アクション型 + switch 文) で管理しているか
- [ ] 購読モデル: `subscribe(() => unsubscribe)` の返り値パターンで、リスナーの登録解除漏れを構造的に防いでいるか
- [ ] レンダリング最適化: キャッシュデータ更新時に構造的共有 (structural sharing) や参照安定化の仕組みがあるか
- [ ] TypeScript DX: ユーザーがグローバルなデフォルト型を拡張できる `Register` パターンを検討したか
- [ ] デフォルト値: サーバー/クライアント間で異なるデフォルト値がある場合、その分岐をドキュメントに明示しているか
- [ ] バッチ通知: 複数の状態更新が短期間に発生する場面で、通知をバッチ化するメカニズムがあるか
