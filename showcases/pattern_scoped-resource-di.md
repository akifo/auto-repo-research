# Pattern: scoped-resource-di

> 出典: [Effect-TS/effect](../repos/Effect-TS/effect/dependency-injection.md), [ryoppippi/ccusage](../repos/ryoppippi/ccusage/abstraction-patterns.md), [vitejs/vite](../repos/vitejs/vite/abstraction-patterns.md), [TanStack/query](../repos/TanStack/query/abstraction-patterns.md), [openclaw/openclaw](../repos/openclaw/openclaw/architecture.md)
> カテゴリ: pattern

## 概要

リソースのライフサイクル管理と DI の交差点を 5 リポジトリから分析し、「型レベル保証（Layer.scoped）→ 言語レベル（using/Disposable）→ GC ベース（WeakMap）→ Observer 連動 → 手動管理（AbortController）」の 5 段階スペクトラムとして体系化する。リソースの acquire/release を DI の仕組みに統合することで、リソースリークを構造的に防止するパターンを提供する。

## 背景・文脈

DI はサービスの「構築と利用の分離」を実現するが、リソース（DB 接続、ファイルハンドル、HTTP クライアント等）を持つサービスでは「構築・利用・解放」の 3 段階を管理する必要がある。解放漏れはリソースリークを引き起こし、重複構築はパフォーマンス劣化を招く。

| 段階 | アプローチ                    | 代表リポ  | 保証レベル                 |
| ---- | ----------------------------- | --------- | -------------------------- |
| 1    | Layer.scoped + acquireRelease | Effect-TS | 型レベル（コンパイル時）   |
| 2    | using + Disposable            | ccusage   | 言語レベル（ランタイム）   |
| 3    | WeakMap + ファクトリ関数      | vite      | GC ベース（自動）          |
| 4    | Observer 連動 GC              | TanStack  | 購読ベース（参照カウント） |
| 5    | AbortController + 手動管理    | openclaw  | 手動（シグナル伝搬）       |

## 実装パターン

### 1. Layer.scoped + acquireRelease（Effect-TS/effect）

Scope 終了時にファイナライザを LIFO 逆順で実行する。`acquireRelease` で取得と解放を不可分操作として宣言し、リソースリークを型レベルで防止する。

```typescript
// packages/effect/src/Scope.ts の概念
// Layer.scoped でリソースライフサイクルをスコープに紐づけ
const DbClientLive = Layer.scoped(
  DbClient,
  Effect.acquireRelease(
    createConnection(), // acquire
    (conn) => conn.close(), // release（Scope 終了時に自動実行）
  ),
);
```

MemoMap によるダイヤモンド依存でもサービスは 1 回だけ構築される:

```typescript
// packages/effect/test/Layer.test.ts:77-85
const layer = makeLayer1(ref);
const env = layer.pipe(Layer.merge(layer), Layer.build);
yield * Effect.scoped(env);
const result = yield * Ref.get(ref);
deepStrictEqual(Array.from(result), [acquire1, release1]); // 1回だけ
```

### 2. using + Disposable（ryoppippi/ccusage）

TC39 Explicit Resource Management により、スコープ終了時に `Symbol.dispose` / `Symbol.asyncDispose` が自動呼び出しされる。言語レベルの RAII パターン。

```typescript
// packages/internal/src/pricing.ts:89-107
export class LiteLLMPricingFetcher implements Disposable {
  [Symbol.dispose](): void {
    this.clearCache();
  }
}

// apps/amp/src/commands/daily.ts:59
using pricingSource = new AmpPricingSource({ offline: false });
// スコープを抜けると自動的にキャッシュクリア
```

テストでも同様に `await using` で自動クリーンアップ:

```typescript
// apps/ccusage/src/_utils.ts:34-46
it("returns modification time", async () => {
  await using fixture = await createFixture({
    "test.txt": "content",
  });
  // fixture はスコープ終了時に自動削除
});
```

### 3. WeakMap + ファクトリ関数（vitejs/vite）

`perEnvironmentState` で環境オブジェクトをキーとした WeakMap に状態を格納し、環境オブジェクトの GC 時に状態を自動解放する。

```typescript
// packages/vite/src/node/environment.ts:20-33
export function perEnvironmentState<State>(
  initial: (environment: Environment) => State,
): (context: PluginContext) => State {
  const stateMap = new WeakMap<Environment, State>();
  return function(context: PluginContext) {
    const { environment } = context;
    let state = stateMap.get(environment);
    if (!state) {
      state = initial(environment);
      stateMap.set(environment, state);
    }
    return state;
  };
}

// plugins/manifest.ts:60-70 での利用
const getState = perEnvironmentState(() => ({
  manifest: {} as Manifest,
  outputCount: 0,
  reset() {
    this.manifest = {};
    this.outputCount = 0;
  },
}));
```

### 4. Observer 連動 GC（TanStack/query）

Observer の購読数がゼロになったクエリを GC 候補としてマークし、`gcTime` 経過後にキャッシュから削除する。購読ベースの参照カウントでリソースの寿命を管理する。

```typescript
// packages/query-core/src/subscribable.ts:1-30
export class Subscribable<TListener extends Function> {
  protected listeners: Set<TListener>;

  subscribe(listener: TListener): () => void {
    this.listeners.add(listener);
    this.onSubscribe();
    return () => {
      this.listeners.delete(listener);
      this.onUnsubscribe();
    };
  }
}
```

`subscribe(listener): unsubscribe` の最小契約が 6 フレームワーク対応の基盤となり、unsubscribe 時にリソースのクリーンアップが連鎖する。

### 5. AbortController + 手動管理（openclaw/openclaw）

各チャネルアカウントに独立した AbortController を割り当て、停止シグナルを伝搬する。手動管理だが、シグナルの伝搬構造により確実なクリーンアップを実現する。

```typescript
// src/gateway/server-channels.ts:141-176
const abort = new AbortController();
store.aborts.set(id, abort);
const task = startAccount({
  cfg,
  accountId: id,
  account,
  runtime: channelRuntimeEnvs[channelId],
  abortSignal: abort.signal,
  // ...
});
```

## Good Example

### Effect: MemoMap によるダイヤモンド依存でのサービス 1 回構築

```typescript
// 同一 Layer 参照を 2 回 merge しても構築は 1 回
const layer = makeLayer1(ref);
const env = layer.pipe(Layer.merge(layer), Layer.build);
yield * Effect.scoped(env);
// acquire は 1 回だけ、release も 1 回だけ
```

DI コンテナのメモ化が型レベルで保証され、意図しないリソースの重複構築を防止する。

### vite: `close` の冪等性保証（Promise キャッシュ）

```typescript
// サーバーの close を複数回呼んでも 1 回だけ実行
let closePromise: Promise<void> | undefined;
function close() {
  if (closePromise) return closePromise;
  closePromise = doClose();
  return closePromise;
}
```

### TanStack Query: Observer 連動 GC

Observer の購読数がゼロになるとタイマーが発火し、`gcTime` 後にキャッシュを自動削除する。UI コンポーネントのアンマウントがリソース解放のトリガーになる。

## Bad Example

### Effect: `Layer.fresh` の乱用によるリソースリーク

```typescript
// Bad: fresh でメモ化を無効化 → DB 接続プールが 2 つ作られる
const app = myService.pipe(
  Layer.provide(Layer.fresh(dbLayer)),
  Layer.merge(otherService.pipe(Layer.provide(Layer.fresh(dbLayer)))),
);

// Better: デフォルトのメモ化を活用
const app = myService.pipe(
  Layer.provide(dbLayer),
  Layer.merge(otherService.pipe(Layer.provide(dbLayer))),
);
```

### `Promise.all` でのクリーンアップ（1 つの失敗で他が待たれない）

```typescript
// Bad: 1 つの close が reject すると他の close が待たれない
await Promise.all([
  db.close(),
  cache.close(),
  server.close(),
]);

// Better: allSettled で全リソースのクリーンアップを保証
const results = await Promise.allSettled([
  db.close(),
  cache.close(),
  server.close(),
]);
// 失敗したものをログに記録
```

### アロー関数クロージャによる AbortController メモリリーク

```typescript
// Bad: コールバックが AbortController を参照し続ける
const controller = new AbortController();
someEmitter.on("data", () => {
  if (controller.signal.aborted) return;
  // controller がイベントリスナーから参照され GC されない
});

// Better: abort 時にリスナーを明示的に解除
const controller = new AbortController();
const handler = () => {/* ... */};
someEmitter.on("data", handler);
controller.signal.addEventListener("abort", () => {
  someEmitter.off("data", handler);
});
```

## 適用ガイド

### どのアプローチを選ぶか

- **Layer.scoped（Effect 方式）**: リソースライフサイクルをコンパイル時に保証したい場合。Effect エコシステム採用が前提
- **using + Disposable**: ファイル/ネットワークリソースのスコープ管理が必要な場合。TypeScript 5.2+ かつ `using` のトランスパイルサポートが必要
- **WeakMap + ファクトリ**: 環境やテナントごとの状態管理が必要で、明示的な解放が不要な場合。プラグインシステム向き
- **Observer 連動**: UI コンポーネントのライフサイクルとリソースの寿命を連動させたい場合。フロントエンドフレームワーク向き
- **AbortController**: 長寿命プロセスの停止制御が必要な場合。サーバー、ゲートウェイ向き

### 注意点

- `Layer.fresh` はメモ化を無効化するため、リソース付きサービスには原則使わない
- `using` はまだエコシステムのサポートが限定的。ポリフィルやトランスパイルの確認が必要
- WeakMap ベースのアプローチは「いつ GC されるか」が非決定的。即座の解放が必要な場合は不向き
- AbortController は手動管理のため、シグナルの伝搬漏れに注意

### カスタマイズポイント

- Effect の `Context.Reference` でデフォルト値付きのオプショナルリソースを定義できる（`R` 型パラメータから除外される）
- vite の `perEnvironmentState` パターンは、テナント・リクエストスコープ・テスト環境など他のスコープ管理にも応用可能
- TanStack の `subscribe/unsubscribe` パターンは、任意のリソースに参照カウントベースの GC を導入する際の参考になる

## 参考

- [repos/Effect-TS/effect/dependency-injection.md](../repos/Effect-TS/effect/dependency-injection.md) — Layer.scoped、MemoMap、acquireRelease
- [repos/Effect-TS/effect/concurrency-patterns.md](../repos/Effect-TS/effect/concurrency-patterns.md) — Scope、RAII、構造化並行性
- [repos/ryoppippi/ccusage/abstraction-patterns.md](../repos/ryoppippi/ccusage/abstraction-patterns.md) — using + Disposable、LiteLLMPricingFetcher
- [repos/vitejs/vite/abstraction-patterns.md](../repos/vitejs/vite/abstraction-patterns.md) — perEnvironmentState、WeakMap
- [repos/TanStack/query/abstraction-patterns.md](../repos/TanStack/query/abstraction-patterns.md) — Subscribable、Observer 連動 GC
- [repos/openclaw/openclaw/architecture.md](../repos/openclaw/openclaw/architecture.md) — AbortController、グレースフルシャットダウン
