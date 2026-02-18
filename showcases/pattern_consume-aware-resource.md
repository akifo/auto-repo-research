# Pattern: Consume-Aware Resource

> 出典: repos/TanStack/query からの知見
> カテゴリ: pattern

## 概要

リソース（AbortSignal 等）を消費者が実際に使ったかどうかを `Object.defineProperty` の getter で実行時に検出し、消費の有無に応じてキャンセル挙動を適応的に切り替えるパターン。消費者にキャンセル対応の事前宣言を求めず、「使ったら有効、使わなければ無効」というプラグマティックな設計により、API の後方互換性を保ちながら最適な振る舞いを実現する。

## 背景・文脈

TanStack Query では、`queryFn` に `signal` プロパティを持つコンテキストオブジェクトが渡される。しかし、全ての `queryFn` が `signal` を使うわけではない。GraphQL クライアントやレガシーな HTTP ライブラリなど、AbortSignal を受け付けないトランスポートは多い。

従来のアプローチでは「キャンセル対応かどうか」をオプションで事前宣言させるか、一律にキャンセルするかの二択だった。前者はユーザーに設定の負担を課し、後者はキャンセル非対応のトランスポートでせっかく完了したレスポンスを捨ててしまう。TanStack Query は第三の道として、getter による消費検出を採用した。

## 実装パターン

### 1. Query クラスでの signal 消費検出（query.ts）

`Query#fetch` 内で、`queryFnContext` に `signal` プロパティを getter として定義する。getter がアクセスされた時点で `#abortSignalConsumed` フラグを `true` にセットする。

```typescript
// packages/query-core/src/query.ts:430-443
const abortController = new AbortController();

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

フェッチ開始時にフラグをリセットし、`queryFn` が `signal` にアクセスしたかどうかを新たに検出する。

```typescript
// packages/query-core/src/query.ts:463-465
const queryFnContext = createQueryFnContext();
this.#abortSignalConsumed = false;
```

### 2. 消費状態に基づくキャンセル分岐（query.ts）

最後の Observer がアンマウントされたとき、`#abortSignalConsumed` の値でキャンセル戦略を分岐する。

```typescript
// packages/query-core/src/query.ts:354-373
removeObserver(observer: QueryObserver<any, any, any, any, any>): void {
  if (this.observers.includes(observer)) {
    this.observers = this.observers.filter((x) => x !== observer)

    if (!this.observers.length) {
      // If the transport layer does not support cancellation
      // we'll let the query continue so the result can be cached
      if (this.#retryer) {
        if (this.#abortSignalConsumed) {
          // signal が消費されている → キャンセル対応 → リクエスト中断
          this.#retryer.cancel({ revert: true })
        } else {
          // signal 未消費 → キャンセル非対応 → リトライだけ止めて結果はキャッシュ
          this.#retryer.cancelRetry()
        }
      }

      this.scheduleGc()
    }

    this.#cache.notify({ type: 'observerRemoved', query: this, observer })
  }
}
```

### 3. 汎用ユーティリティ版（utils.ts）

`addConsumeAwareSignal` は同じパターンをストリーミングクエリや Infinite Query でも再利用できるように汎用化したものである。signal の遅延生成（`signal ??= getSignal()`）と、abort イベントリスナーの条件付き登録を組み合わせている。

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

ポイントは2つ。初回アクセス時のみ `abort` イベントリスナーを登録し、2回目以降のアクセスでは重複登録しない。また、`signal ??= getSignal()` により signal 自体の生成も遅延される。

### 4. Infinite Query での利用例（infiniteQueryBehavior.ts）

Infinite Query はページごとに `queryFn` を呼び出すため、各ページフェッチのコンテキストにも consume-aware signal を適用している。

```typescript
// packages/query-core/src/infiniteQueryBehavior.ts:28-36
const fetchFn = async () => {
  let cancelled = false;
  const addSignalProperty = (object: unknown) => {
    addConsumeAwareSignal(
      object,
      () => context.signal,
      () => (cancelled = true),
    );
  };
  // ...
};
```

signal が消費されると `cancelled` フラグが立ち、以降のページフェッチをスキップする。signal が消費されなければ、全ページの結果がキャッシュに残る。

## Good Example

```typescript
// signal を fetch に伝播 → 消費検出が正しく機能し、アンマウント時にリクエストが中断される
const { data } = useQuery({
  queryKey: ["users"],
  queryFn: async ({ signal }) => {
    const res = await fetch("/api/users", { signal });
    return res.json();
  },
});

// signal を使わない → 消費フラグが立たず、結果がキャッシュに残る
// レガシー API クライアントなど、AbortSignal 非対応の場合に有効
const { data } = useQuery({
  queryKey: ["users"],
  queryFn: async () => {
    const res = await legacyHttpClient.get("/api/users");
    return res.data;
  },
});
```

どちらのケースも `queryFn` のシグネチャを変更する必要がなく、ライブラリ側が実行時に最適な挙動を選択する。

## Bad Example

```typescript
// Bad: signal にアクセスするが fetch に渡さない
// → 消費フラグが立つのでキャンセルが発動するが、実際のリクエストは中断されない
queryFn: (async ({ signal }) => {
  console.log(signal.aborted); // signal consumed → #abortSignalConsumed = true
  const res = await fetch("/api/data"); // signal 未伝播 → リクエストは続行
  return res.json();
});

// Bad: キャンセル対応をオプションで事前宣言させる設計
// → ユーザーに不要な設定負担を課し、設定ミスで挙動が壊れる
useQuery({
  queryKey: ["users"],
  queryFn: fetchUsers,
  supportsCancellation: true, // ← このようなオプションは不要
});
```

前者の問題は、分割代入 `({ signal })` でアクセスが発生してフラグが立つが、実際の `fetch` 呼び出しに `signal` を渡していないため、キャンセルが発動してもリクエストは中断されない矛盾が生じること。後者は、ユーザーに判断と設定を強制する設計であり、consume-aware パターンが解決しようとしている問題そのもの。

## 適用ガイド

### どのような状況で使うべきか

- **消費者がリソースを使うかどうか実行時まで不明な場合**: プラグインやコールバックにリソースを渡すが、全てのプラグインがそのリソースを使うとは限らないケース
- **リソースの利用有無で後続の副作用を切り替えたい場合**: キャンセル、クリーンアップ、ロギングなどの副作用を、リソースが実際に消費された場合のみ有効にしたいケース
- **API の後方互換性を保ちつつ新機能を追加する場合**: 既存の消費者のコードを変更せずに、新しいプロパティへの対応を任意にしたいケース

### 導入時の注意点

- **getter の副作用を文書化する**: `signal` プロパティへのアクセスが副作用を持つことを明示的に文書化する。分割代入 `({ signal })` だけでフラグが立つことを消費者が認識できるようにする
- **重複登録の防止**: `addConsumeAwareSignal` のように、初回アクセスと2回目以降のアクセスを区別し、イベントリスナーの重複登録を防ぐ
- **遅延生成との組み合わせ**: signal 自体の生成コストが無視できない場合は、`signal ??= getSignal()` のように遅延生成と組み合わせる

### カスタマイズポイント

- **検出対象のプロパティ**: `signal` 以外にも、任意のプロパティに同じパターンを適用できる。例えばログコンテキスト、トレーシングスパン、メトリクスコレクターなど
- **消費時のアクション**: TanStack Query ではフラグのセットとイベントリスナー登録だが、消費時に初期化処理を実行する、利用統計を記録するなど、用途に応じたアクションに差し替えられる
- **複数プロパティの追跡**: 複数の consume-aware プロパティを持たせて、それぞれ独立に消費状態を追跡することも可能

## 参考

- [repos/TanStack/query/concurrency-patterns.md](../repos/TanStack/query/concurrency-patterns.md) -- AbortController とシグナル消費検出の分析
- [repos/TanStack/query/performance-techniques.md](../repos/TanStack/query/performance-techniques.md) -- 遅延 AbortSignal 生成 (Lazy Signal Pattern) の分析
