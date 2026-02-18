# Extensibility Mechanisms

> リポジトリ: TanStack/query
> 分析日: 2026-02-17

## 概要

TanStack Query の拡張性設計を、プラグインシステム・永続化層・DevTools 統合・環境抽象の4軸で分析した。
このコードベースは明示的なプラグイン API を持たないにもかかわらず、Observer パターン・Strategy パターン・依存性注入を組み合わせた「契約ベースの拡張性」を実現している。
フレームワーク非依存のコア（`query-core`）に全ロジックを集約し、各フレームワークアダプターは薄いラッパーに徹する設計は、マルチフレームワーク対応ライブラリの模範例として注目に値する。

## 背景にある原則

- **Contract-First Extensibility（契約先行の拡張性）**: プラグインレジストリのような「登録」機構を設けず、`Persister` / `QueryBehavior` / `AsyncStorage` などの小さなインターフェースを契約として定義し、利用者が実装を注入する。拡張ポイントが型で明示されるため、IDE 補完が効き、ランタイムエラーが減る。根拠: `Persister` インターフェース（`query-persist-client-core/src/persist.ts:12-16`）はわずか3メソッドで永続化層全体を抽象化している。

- **Core-Adapter Separation（コアとアダプターの分離）**: ステート管理・キャッシュ・リトライ・GC などのドメインロジックを `query-core` に閉じ込め、React/Vue/Svelte/Angular のアダプターはフレームワーク固有のライフサイクル統合だけを担う。これにより、コアのテストがフレームワーク非依存になり、新フレームワーク対応のコストが劇的に下がる。根拠: `react-query/src/useQuery.ts` は実質1行（`useBaseQuery(options, QueryObserver, queryClient)`）でコアに委譲している。

- **Observable Cache as Integration Backbone（Observable なキャッシュを統合の背骨にする）**: `QueryCache` と `MutationCache` が `Subscribable` を継承し、型付きイベント（`added` / `removed` / `updated` 等）を発火する。DevTools・永続化・タブ間同期といった全ての拡張機能がこの単一の購読メカニズムに依存する。根拠: `broadcastQueryClient`（`query-broadcast-client-experimental/src/index.ts:30`）はキャッシュの `subscribe` だけでタブ間同期を実現している。

- **Replaceable Singletons（差し替え可能なシングルトン）**: `focusManager` / `onlineManager` / `notifyManager` / `timeoutManager` をシングルトンとしてエクスポートしつつ、`setEventListener` / `setBatchNotifyFunction` / `setTimeoutProvider` で振る舞いを差し替え可能にする。テスト時やReact Native等の非ブラウザ環境で環境依存部分だけを交換できる。

## 実例と分析

### 1. 永続化層の Strategy パターン

永続化は2つのレベルで設計されている。

**クライアント全体の永続化**（`persistQueryClient`）: `dehydrate/hydrate` でクライアント全体をシリアライズし、`Persister` インターフェースを通じてストレージに保存する。

```typescript
// query-persist-client-core/src/persist.ts:12-16
export interface Persister {
  persistClient: (persistClient: PersistedClient) => Promisable<void>;
  restoreClient: () => Promisable<PersistedClient | undefined>;
  removeClient: () => Promisable<void>;
}
```

**クエリ単位の永続化**（`experimental_createQueryPersister`）: `queryFn` をラップする `persisterFn` を返すファクトリ。クエリごとに個別のストレージキーで保存し、復元時にバックグラウンドで再フェッチを制御できる。

```typescript
// query-persist-client-core/src/createPersister.ts:25-29
export interface AsyncStorage<TStorageValue = string> {
  getItem: (key: string) => MaybePromise<TStorageValue | undefined | null>;
  setItem: (key: string, value: TStorageValue) => MaybePromise<unknown>;
  removeItem: (key: string) => MaybePromise<void>;
  entries?: () => MaybePromise<Array<[key: string, value: TStorageValue]>>;
}
```

`serialize` / `deserialize` をオプションで注入できるため、superjson のようなカスタムシリアライザーにも対応可能。

### 2. DevTools の UI 非依存設計

DevTools は3層構造になっている。

1. **`@tanstack/query-devtools`**: SolidJS で実装された UI コンポーネント。`QueryClient` と `onlineManager` を受け取る `TanstackQueryDevtools` クラスを公開。
2. **`@tanstack/react-query-devtools`**: React ラッパー。`TanstackQueryDevtools` クラスを DOM ref にマウントする薄い接続層。
3. **本番ビルド除外**: `index.ts` で `process.env.NODE_ENV !== 'development'` 分岐により、本番では null を返す関数に差し替え。

```typescript
// react-query-devtools/src/index.ts:6-11
export const ReactQueryDevtools: (typeof Devtools)["ReactQueryDevtools"] = process.env.NODE_ENV !== "development"
  ? function() {
    return null;
  }
  : Devtools.ReactQueryDevtools;
```

DevTools が `QueryCache.subscribe` 経由でデータを取得するため、コアに DevTools 固有のコードが一切存在しない。

### 3. Subscribable 基盤クラス

全てのオブザーバブルな型（`QueryCache` / `MutationCache` / `QueryObserver` / `FocusManager` / `OnlineManager`）が共有する基盤。

```typescript
// query-core/src/subscribable.ts:1-30
export class Subscribable<TListener extends Function> {
  protected listeners = new Set<TListener>();
  subscribe(listener: TListener): () => void {
    this.listeners.add(listener);
    this.onSubscribe();
    return () => {
      this.listeners.delete(listener);
      this.onUnsubscribe();
    };
  }
  protected onSubscribe(): void {/* hook */}
  protected onUnsubscribe(): void {/* hook */}
}
```

`onSubscribe` / `onUnsubscribe` をテンプレートメソッドとして公開し、サブクラスでリスナー数に応じたセットアップ/クリーンアップを実装できる。例えば `FocusManager` は最初のリスナー追加時にのみ `visibilitychange` イベントを登録する（`focusManager.ts:36-38`）。

### 4. QueryBehavior による fetch 戦略の差し替え

`QueryBehavior` インターフェースは `onFetch` フックを通じて fetch 処理全体を差し替える仕組み。通常のクエリは `query.ts` 内のデフォルト fetch を使い、InfiniteQuery は `infiniteQueryBehavior` が `context.fetchFn` を書き換えることでページネーション処理を注入する。

```typescript
// query-core/src/query.ts:78-88
export interface QueryBehavior<...> {
  onFetch: (
    context: FetchContext<TQueryFnData, TError, TData, TQueryKey>,
    query: Query,
  ) => void
}
```

`query.ts:502` で `this.options.behavior?.onFetch(context, this)` が呼ばれ、`context.fetchFn` を書き換えることで fetch ロジックを完全に置換できる。

### 5. Register インターフェースによるモジュール拡張

TypeScript のモジュール拡張（declaration merging）を利用し、グローバルな型のカスタマイズを可能にしている。

```typescript
// query-core/src/types.ts:39-45
export interface Register {
  // defaultError: Error
  // queryMeta: Record<string, unknown>
  // mutationMeta: Record<string, unknown>
}
```

ユーザーがこのインターフェースを拡張すると、`DefaultError` / `QueryMeta` / `MutationMeta` の型がプロジェクト全体で変更される。ランタイムコードは一切不要で、型レベルだけで拡張を実現している。

### 6. TimeoutProvider による環境抽象

```typescript
// query-core/src/timeoutManager.ts:22-29
export type TimeoutProvider<TTimerId extends ManagedTimerId = ManagedTimerId> = {
  readonly setTimeout: (callback: TimeoutCallback, delay: number) => TTimerId;
  readonly clearTimeout: (timeoutId: TTimerId | undefined) => void;
  readonly setInterval: (callback: TimeoutCallback, delay: number) => TTimerId;
  readonly clearInterval: (intervalId: TTimerId | undefined) => void;
};
```

数千のクエリを扱う場合に `setTimeout` がボトルネックになるケースに対応し、タイマーコアレッシングなどカスタム実装を注入できる。`setTimeoutProvider` のガード（`timeoutManager.ts:76-92`）はプロバイダー切り替え時の危険性を開発モードで警告する。

## パターンカタログ

- **Observer パターン** (分類: 振る舞い)
  - 解決する問題: キャッシュ状態の変更を複数のコンシューマに通知する
  - 適用条件: 1対多の状態通知が必要な場合
  - コード例: `query-core/src/subscribable.ts:1-30`, `queryCache.ts:200-206`
  - 注意点: リスナーが Set で管理されるため順序保証がない。コールバック内で副作用の順序に依存しないこと

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: fetch / persist / serialize の処理を実行時に差し替える
  - 適用条件: 同一インターフェースの複数実装が存在し、実行時に選択する場合
  - コード例: `Persister` インターフェース（`persist.ts:12-16`）、`QueryBehavior`（`query.ts:78-88`）
  - 注意点: Strategy インターフェースは最小に保つ。3メソッド以下が目安

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: 基底クラスの処理フローは固定しつつ、特定ステップだけサブクラスで拡張する
  - 適用条件: 共通フローを持つ複数のサブクラスが存在する場合
  - コード例: `Subscribable.onSubscribe()` / `onUnsubscribe()`（`subscribable.ts:23-29`）、`Removable.optionalRemove()`（`removable.ts:6`）

- **Facade パターン** (分類: 構造)
  - 解決する問題: 複雑な内部サブシステム（Cache, Observer, Manager群）への単一アクセスポイント
  - 適用条件: 多数の内部コンポーネントを持つライブラリの公開 API
  - コード例: `QueryClient`（`queryClient.ts:61`）が `QueryCache`, `MutationCache`, `FocusManager`, `OnlineManager` を統括

## Good Patterns

- **Minimal Contract Interface（最小契約インターフェース）**: `Persister` は `persistClient` / `restoreClient` / `removeClient` の3メソッドだけで永続化層全体を抽象化する。`AsyncStorage` も `getItem` / `setItem` / `removeItem` の3メソッド（+ オプショナルな `entries`）。契約が小さいほど実装側の負担が軽く、多様なバックエンドに対応しやすい。

```typescript
// query-persist-client-core/src/persist.ts:12-16
export interface Persister {
  persistClient: (persistClient: PersistedClient) => Promisable<void>;
  restoreClient: () => Promisable<PersistedClient | undefined>;
  removeClient: () => Promisable<void>;
}
```

- **Transaction Guard for Cross-Tab Sync（タブ間同期のトランザクションガード）**: `broadcastQueryClient` は受信メッセージの処理中にキャッシュイベントが再配信されるのを `transaction` フラグで防ぐ。イベントループの無限再帰を1つのブーリアンフラグで防御する簡潔な手法。

```typescript
// query-broadcast-client-experimental/src/index.ts:17-21
let transaction = false;
const tx = (cb: () => void) => {
  transaction = true;
  cb();
  transaction = false;
};
```

- **Dead Code Elimination via Conditional Export（条件付きエクスポートによるデッドコード除去）**: DevTools の `index.ts` で `process.env.NODE_ENV` 分岐を使い、本番ビルドではツリーシェイクによって DevTools コード全体を除去可能にする。import の時点で分岐するため、利用者側のコード変更が不要。

- **Typed Discriminated Union Events（型安全な判別共用体イベント）**: `QueryCacheNotifyEvent` は7種類のイベント型の union で、`type` フィールドでナローイングできる。リスナー側で `event.type` を switch すれば各イベント固有のプロパティに型安全にアクセスできる。

```typescript
// query-core/src/queryCache.ts:71-78
export type QueryCacheNotifyEvent =
  | NotifyEventQueryAdded
  | NotifyEventQueryRemoved
  | NotifyEventQueryUpdated
  | NotifyEventQueryObserverAdded
  | ...
```

## Anti-Patterns / 注意点

- **Singleton State Leakage（シングルトン状態の漏洩）**: `focusManager` / `onlineManager` / `notifyManager` / `timeoutManager` はモジュールスコープのシングルトン。テスト並列実行時やマルチテナント環境ではグローバル状態が干渉する可能性がある。

```typescript
// Bad: テスト間でシングルトン状態が残る
test("test A", () => {
  onlineManager.setOnline(false);
  // ... test A ...
});
test("test B", () => {
  // onlineManager はまだ offline のまま
});

// Better: テストごとに状態をリセットする
afterEach(() => {
  onlineManager.setOnline(true);
});
```

- **Provider Switch After Use（使用後のプロバイダー切り替え）**: `TimeoutManager` は使用後にプロバイダーを切り替えると、既存タイマーの `clearTimeout` が正しく動作しない。開発モードの警告はあるが、本番では静かに壊れる。

```typescript
// Bad: タイマー使用後にプロバイダーを切り替え
const id = timeoutManager.setTimeout(cb, 1000);
timeoutManager.setTimeoutProvider(customProvider);
timeoutManager.clearTimeout(id); // 元のプロバイダーのタイマーを解除できない

// Better: アプリケーション初期化時に一度だけ設定する
timeoutManager.setTimeoutProvider(customProvider);
// 以降のタイマー操作は全て customProvider で処理される
```

## 導出ルール

- `[MUST]` 拡張ポイントを設計する際は、プラグインレジストリではなく最小のインターフェース（3-5メソッド以下）を契約として定義する
  - 根拠: TanStack Query の `Persister`（3メソッド）と `AsyncStorage`（3+1メソッド）は、localStorage / AsyncStorage / IndexedDB / カスタムストレージ全てに対応しつつ、実装負担を最小化している

- `[MUST]` マルチフレームワーク対応ライブラリでは、ドメインロジックをフレームワーク非依存のコアパッケージに閉じ込め、各フレームワークアダプターはライフサイクル統合のみを担う薄いラッパーにする
  - 根拠: `react-query/src/useQuery.ts` は1行でコアに委譲し、React 固有のコードは `useSyncExternalStore` 連携等の最小限に留まっている

- `[SHOULD]` ライブラリ内部の状態変更を外部に通知する仕組みは、型付き判別共用体イベントを持つ単一の subscribe メカニズムに統一する
  - 根拠: `QueryCache.subscribe` は DevTools・永続化・タブ間同期・SSR ストリーミングの全てが依存する唯一の統合ポイントであり、新機能追加時もコアへの変更が不要

- `[SHOULD]` 環境依存の処理（タイマー・フォーカス検出・ネットワーク状態）はシングルトンマネージャーとして抽出し、`setEventListener` / `setProvider` で差し替え可能にする
  - 根拠: `FocusManager.setEventListener` により、React Native では `AppState` イベント、テストではモック、ブラウザでは `visibilitychange` と環境ごとに差し替えている

- `[SHOULD]` TypeScript のモジュール拡張（`Register` パターン）を使い、ランタイムコードなしでグローバル型のカスタマイズを可能にする
  - 根拠: `Register` インターフェースにより `DefaultError` / `QueryMeta` / `MutationMeta` をプロジェクト全体で型安全に変更でき、ランタイムオーバーヘッドがゼロ

- `[AVOID]` シングルトンマネージャーの状態を使用開始後に切り替えること。初期化フェーズで一度だけ設定するか、切り替え時に既存リソースの明示的なクリーンアップを保証する
  - 根拠: `TimeoutManager` はプロバイダー切り替え後に既存タイマーの `clearTimeout` が機能しなくなるリスクがあり、開発モードでのみ警告される（`timeoutManager.ts:76-92`）

## 適用チェックリスト

- [ ] ライブラリの拡張ポイントを洗い出し、それぞれに最小のインターフェース（3-5メソッド）を定義しているか
- [ ] フレームワーク非依存のコアと、フレームワーク固有のアダプター層が明確に分離されているか
- [ ] 内部状態の変更通知が型付き判別共用体イベントで統一されており、外部から subscribe 可能か
- [ ] 環境依存の処理（タイマー、ネットワーク検出、ストレージ）が差し替え可能な抽象として切り出されているか
- [ ] DevTools や開発者ツールのコードが本番ビルドでツリーシェイク可能な構造になっているか
- [ ] TypeScript の `Register` パターンを活用し、ライブラリ利用者が型レベルでカスタマイズできるか検討したか
- [ ] シングルトンの状態管理が初期化フェーズに限定されており、使用中の差し替えによる不整合が防止されているか
