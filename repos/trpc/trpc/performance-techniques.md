# performance-techniques

> リポジトリ: trpc/trpc
> 分析日: 2026-02-24

## 概要

tRPC は TypeScript の型安全な RPC フレームワークとして、クライアント-サーバー間の通信をエンドツーエンドで型付けする。パフォーマンス最適化は「ネットワーク往復の削減」「メモリリーク防止」「ランタイムオブジェクト生成コストの最小化」の 3 軸に集中している。特に Proxy メモ化、DataLoader パターンによるバッチ処理、`Unpromise` による Promise メモリリーク防止は、RPC フレームワークに限らず汎用的に適用できる技法として注目に値する。

## 背景にある原則

- **ホットパスのアロケーション最小化**: Proxy アクセスやオブジェクト生成はユーザーコードから頻繁に呼ばれるホットパスであり、キャッシュや `Object.create(null)` で生成コストを抑える。tRPC では `createInnerProxy` で `memo[cacheKey]` にキャッシュし、同一パスへの再アクセスで Proxy を再生成しない (`packages/server/src/unstable-core-do-not-import/createProxy.ts:24-26`)。

- **ネットワーク境界のコスト意識**: HTTP リクエストはアプリケーション内関数呼び出しの数万倍のコストがかかる。個別リクエストをまとめてバッチ化し、さらにストリーミングで応答を逐次返すことで、レイテンシとスループットの両方を改善する。

- **長寿命オブジェクトのリーク防止**: WebSocket 接続や SSE ストリームのように長時間生存するリソースでは、通常の `Promise.race` が内部的に `.then()` ハンドラを蓄積しメモリリークを起こす。これを構造的に防ぐ仕組みを導入している (`packages/server/src/vendor/unpromise/`)。

- **遅延ロードによる初期コスト分散**: ルーター定義を `lazy()` + `once()` で遅延ロードし、初回アクセスまでモジュール評価を遅延させる。大規模 API で起動時間と初期メモリ使用量を抑制する手法。

## 実例と分析

### Proxy メモ化によるオブジェクト再利用

tRPC のクライアント API は `trpc.user.list.query()` のようにドットチェーンでプロシージャを呼び出す。この API は再帰 Proxy で実現されており、同一パスの Proxy を毎回 `new Proxy` で生成するとコストがかかるため、メモ化テーブルで使い回す。

```ts
// packages/server/src/unstable-core-do-not-import/createProxy.ts:19-57
function createInnerProxy(
  callback: ProxyCallback,
  path: readonly string[],
  memo: Record<string, unknown>,
) {
  const cacheKey = path.join(".");

  memo[cacheKey] ??= new Proxy(noop, {
    get(_obj, key) {
      if (typeof key !== "string" || key === "then") {
        return undefined;
      }
      return createInnerProxy(callback, [...path, key], memo);
    },
    apply(_1, _2, args) {
      const lastOfPath = path[path.length - 1];
      let opts = { args, path };
      // ... call/apply handling ...
      freezeIfAvailable(opts.args);
      freezeIfAvailable(opts.path);
      return callback(opts);
    },
  });

  return memo[cacheKey];
}
```

メモテーブル自体は `emptyObject()` (`Object.create(null)`) で生成される。`??=` (Nullish Coalescing Assignment) を使い、初回のみ Proxy を作成して以後はキャッシュから返す。

`args` と `path` は `Object.freeze` で凍結され、下流でうっかり変更されるのを防ぐ。テストでもこの不変性が検証されている (`createProxy.test.ts:23-43`)。

### Object.create(null) によるプロトタイプフリーオブジェクト

`emptyObject()` ユーティリティはコードベース全体で 13 箇所以上使われている。

```ts
// packages/server/src/unstable-core-do-not-import/utils.ts:44-46
export function emptyObject<TObj extends Record<string, unknown>>(): TObj {
  return Object.create(null);
}
```

使用箇所: ルーター構築時の `procedures` / `lazy` / `aggregate` テーブル、JSON Lines ストリームの head オブジェクト、FormData パース結果、Proxy メモテーブルなど。すべて「キーの存在チェック (`key in obj`) が頻繁に行われるディクショナリ」に適用されている。`Object.create(null)` は `hasOwnProperty` や `toString` など `Object.prototype` のプロパティを持たないため、プロトタイプチェーン走査が不要になり、辞書的用途で高速かつ安全。

### DataLoader パターンによるバッチリクエスト

GraphQL の DataLoader に着想を得たバッチ処理機構を持つ。

```ts
// packages/client/src/internals/dataLoader.ts:135-155
function load(key: TKey): Promise<TValue> {
  const item: BatchItem<TKey, TValue> = {
    aborted: false,
    key,
    batch: null,
    resolve: throwFatalError,
    reject: throwFatalError,
  };

  const promise = new Promise<TValue>((resolve, reject) => {
    item.reject = reject;
    item.resolve = resolve;
    pendingItems ??= [];
    pendingItems.push(item);
  });

  dispatchTimer ??= setTimeout(dispatch);

  return promise;
}
```

核心は `setTimeout(dispatch)` で遅延 0ms のタイマーを設定し、同一イベントループティック内の全呼び出しを 1 バッチに集約する点。`validate` 関数で URL 長制限 (`maxURLLength`) やアイテム数制限 (`maxItems`) を超えた場合にバッチを分割する仕組みも備わっている (`httpBatchLink.ts:33-53`)。

さらに `httpBatchStreamLink` では、1 つの HTTP リクエストでバッチ送信しつつ、JSON Lines 形式で個別レスポンスをストリーミング返却する。バッチの「全完了待ち」によるレイテンシ増加を解消する進化形。

### Unpromise: Promise.race メモリリーク防止

WebSocket や SSE のように長寿命の接続では `Promise.race([iterator.next(), abortPromise])` を繰り返す。通常の `Promise.race` は元 Promise の `.then()` にハンドラを蓄積し続け、GC できないメモリリークを引き起こす。

```ts
// packages/server/src/vendor/unpromise/unpromise.ts:60 (Unpromise class)
// WeakMap で ProxyPromise をキャッシュし、subscribe/unsubscribe で参照を管理
const subscribableCache = new WeakMap<
  PromiseLike<unknown>,
  ProxyPromise<unknown>
>();
```

```ts
// packages/server/src/unstable-core-do-not-import/stream/utils/withPing.ts:28
result = await Unpromise.race([nextPromise, pingPromise.start()]);
```

`Unpromise.race` は各 Promise を `subscribe()` で監視し、レース終了後に `unsubscribe()` で参照チェーンを切断する。WeakMap でキャッシュすることで、元 Promise が GC 対象になればキャッシュも回収される。

### 非同期ループにおける明示的参照解放

ストリーム処理の `while(true)` ループで、イテレーション結果を次ループまで保持しないよう、明示的に `null` 代入している。

```ts
// packages/server/src/unstable-core-do-not-import/stream/utils/withPing.ts:17-45
// declaration outside the loop for garbage collection reasons
let result: null | IteratorResult<TValue> | typeof disposablePromiseTimerResult;

while (true) {
  result = await Unpromise.race([nextPromise, pingPromise.start()]);
  // ... yield result ...
  // free up reference for garbage collection
  result = null;
}
```

同じパターンが `ws.ts:334-397`、`sse.ts:127-148`、`asyncIterable.ts:36-60` にも適用されている。変数をループ外で宣言し、yield 後に `null` を代入する。ループ内で `let` 宣言した場合、次の `await` で値が来るまで前回の値が GC されないため、この最適化が意味を持つ。

### lazy() + once() による遅延ルーターロード

```ts
// packages/server/src/unstable-core-do-not-import/router.ts:90-98
function once<T>(fn: () => T): () => T {
  const uncalled = Symbol();
  let result: T | typeof uncalled = uncalled;
  return (): T => {
    if (result === uncalled) {
      result = fn();
    }
    return result;
  };
}
```

`once()` は初回呼び出し結果をクロージャ内にキャッシュし、2 回目以降はキャッシュを返す。`Symbol()` をセンチネル値に使うことで、`undefined` や `null` が正当な戻り値でも正しく動作する。

`lazy()` はルーター定義を動的 `import()` でラップし、`once()` と組み合わせてロード済みのルーターを再ロードしない。

```ts
// examples/lazy-load/src/server/routers/_app.ts:1-8
import { lazy } from "@trpc/server";
import { router } from "../trpc.js";

export const appRouter = router({
  user: lazy(() => import("./user.js")),
  slow: lazy(() => import("./slow.js")),
});
```

`getProcedureAtPath` がプロシージャ解決時に lazy ルーターを検出すると `lazyRouter.load()` を呼び、初回アクセスでのみモジュールをロードする (`router.ts:373-396`)。

### バッチ AbortSignal の合成

複数のリクエストを 1 バッチにまとめる際、個別リクエストの AbortSignal を合成する 2 つの戦略がある。

```ts
// packages/client/src/internals/signals.ts:8-32
// allAbortSignals: 全シグナルが abort されたら abort (AND 合成)
export function allAbortSignals(...signals: Maybe<AbortSignal>[]): AbortSignal {
  const ac = new AbortController();
  let abortedCount = 0;
  const onAbort = () => {
    if (++abortedCount === count) {
      ac.abort();
    }
  };
  // ...
}

// raceAbortSignals: いずれかのシグナルが abort されたら abort (OR 合成)
```

バッチリクエストでは `allAbortSignals` を使い、全個別リクエストがキャンセルされない限りバッチ自体はキャンセルしない。ストリーミングでは `raceAbortSignals` と組み合わせ、バッチ全体の中断と個別の中断を適切にハンドリングする。

### Tree-shaking 対応

`@trpc/server` の `package.json` に `"sideEffects": false` を宣言し、バンドラが未使用エクスポートを安全に削除できるようにしている (`packages/server/package.json:4`)。

## パターンカタログ

- **Proxy パターン** (分類: 構造)
  - 解決する問題: 型安全なドットチェーン API を動的に提供する
  - 適用条件: API パスが静的に定義できず、動的解決が必要な場合
  - コード例: `packages/server/src/unstable-core-do-not-import/createProxy.ts:19-57`
  - 注意点: メモ化なしでは同一パスに対して毎回 Proxy を生成するコストがかかる

- **DataLoader パターン** (分類: 振る舞い)
  - 解決する問題: N+1 問題 — 個別リクエストが大量に発生するケース
  - 適用条件: 同一ティック内に複数の独立したリクエストが発行される場面
  - コード例: `packages/client/src/internals/dataLoader.ts:32-160`
  - 注意点: バッチサイズの上限管理（URL 長制限、ペイロードサイズ制限）が必要

- **Memoization / once パターン** (分類: 振る舞い)
  - 解決する問題: 高コストな計算やリソースロードの重複実行
  - 適用条件: 冪等な関数で、結果が呼び出し間で変わらない場合
  - コード例: `packages/server/src/unstable-core-do-not-import/router.ts:90-98`
  - 注意点: 例外発生時にキャッシュするかどうかの戦略が必要（tRPC の `once` は例外もキャッシュする）

## Good Patterns

- **Proxy メモ化テーブル + Object.create(null)**: `memo[cacheKey] ??= new Proxy(...)` で同一パスの Proxy を再利用する。メモテーブルを `Object.create(null)` で作ることで、`'toString' in memo` のような意図しないヒットを回避する。

```ts
// packages/server/src/unstable-core-do-not-import/createProxy.ts:24-26
const cacheKey = path.join(".");
memo[cacheKey] ??= new Proxy(noop, {/* ... */});
return memo[cacheKey];
```

- **setTimeout(fn, 0) によるマイクロバッチング**: 同一イベントループ内の呼び出しを `setTimeout` で次ティックまで集約し、1 回のネットワークリクエストにまとめる。`??=` で重複タイマーを防ぎ、1 ティックに 1 度だけディスパッチする。

```ts
// packages/client/src/internals/dataLoader.ts:152
dispatchTimer ??= setTimeout(dispatch);
```

- **subscribe/unsubscribe による Promise 参照管理**: `Unpromise.race` で長寿命 Promise をレースさせた後、確実に `unsubscribe()` して参照チェーンを切断する。`try/finally` で確実に実行する。

```ts
// packages/server/src/vendor/unpromise/unpromise.ts:294-302
static async race<T>(values: Iterable<T | PromiseLike<T>>): Promise<Awaited<T>> {
  const subscribedPromises = valuesArray.map(Unpromise.resolve);
  try {
    return await Promise.race(subscribedPromises);
  } finally {
    subscribedPromises.forEach(({ unsubscribe }) => { unsubscribe(); });
  }
}
```

- **Symbol センチネル値による未初期化検出**: `once()` で `Symbol()` をセンチネルに使い、`undefined` や `null` が正当な戻り値のケースでも正しく「未呼び出し」を判定する。

```ts
// packages/server/src/unstable-core-do-not-import/router.ts:91-92
const uncalled = Symbol();
let result: T | typeof uncalled = uncalled;
```

## Anti-Patterns / 注意点

- **長寿命 Promise への .then() 蓄積**: `Promise.race` を繰り返すと、元 Promise に `.then()` ハンドラが無限に蓄積し GC されない。tRPC はこれを Unpromise で回避している。

Bad:

```ts
// ストリームループで毎回 Promise.race を呼ぶ
while (true) {
  const result = await Promise.race([longLivedPromise, timerPromise]);
  // longLivedPromise に .then() ハンドラが蓄積し続ける
}
```

Better:

```ts
// Unpromise.race で subscribe/unsubscribe を管理
while (true) {
  const result = await Unpromise.race([longLivedPromise, timerPromise]);
  // レース終了時に unsubscribe で参照を切断
}
```

- **ループ内変数宣言による GC 遅延**: `for await` や `while` ループ内で `let` 宣言すると、次のイテレーションで `await` が解決するまで前の値が GC されない。

Bad:

```ts
while (true) {
  let result = await iterator.next(); // 次の await まで前の result が残る
  yield result.value;
}
```

Better:

```ts
let result: IteratorResult<T> | null; // ループ外で宣言
while (true) {
  result = await iterator.next();
  yield result.value;
  result = null; // 明示的に参照を解放
}
```

## 導出ルール

- `[SHOULD]` ホットパスで辞書的に使うオブジェクトは `Object.create(null)` で生成する（プロトタイプチェーン走査の回避と `in` 演算子の安全性確保）
  - 根拠: tRPC では Proxy メモテーブル、ルーター手続きマップなど 13 箇所以上で `emptyObject()` を使用し、`key in obj` の安全性を担保している (`utils.ts:44-46`)

- `[SHOULD]` 同一イベントループ内の複数非同期呼び出しは `setTimeout(fn, 0)` + キューで 1 バッチにまとめる（DataLoader パターン）
  - 根拠: tRPC の `dataLoader` は `setTimeout(dispatch)` で同一ティック内の全 `load()` 呼び出しを 1 HTTP リクエストに集約し、ネットワーク往復を削減している (`dataLoader.ts:152`)

- `[MUST]` 長寿命 Promise に対する `Promise.race` / `Promise.any` の繰り返し呼び出しでは、参照チェーンを明示的に切断する仕組みを導入する
  - 根拠: tRPC は Unpromise ライブラリを vendor し、WebSocket・SSE・ping ストリームすべてで `Unpromise.race` を使用してメモリリークを防止している (`ws.ts:345`, `sse.ts:268`, `withPing.ts:28`)

- `[SHOULD]` 再帰 Proxy のようなホットパスのオブジェクト生成では、パスキーによるメモ化テーブルで既存インスタンスを再利用する
  - 根拠: `createInnerProxy` は `memo[cacheKey] ??= new Proxy(...)` で同一パスの Proxy を再利用し、毎回の `new Proxy` コストを回避している (`createProxy.ts:24-26`)

- `[SHOULD]` 非同期ジェネレータのループでは、yield 後に前イテレーションの参照を `null` で明示的に解放する
  - 根拠: tRPC の WS アダプタ、SSE ストリーム、withPing、takeWithGrace の 4 箇所すべてで `result = null` による明示的 GC ヒントを実装している

- `[SHOULD]` 冪等な初期化関数は `once()` でメモ化し、センチネル値には `Symbol()` を使って `undefined`/`null` と未呼び出しを区別する
  - 根拠: `once()` のセンチネルに `Symbol()` を使うことで、関数が `undefined` を返すケースでも正しく動作する (`router.ts:91-92`)

- `[AVOID]` ライブラリの `package.json` で `sideEffects` フィールドを省略してバンドラの tree-shaking を妨げること
  - 根拠: `@trpc/server` は `"sideEffects": false` を明示し、未使用コードの除去を可能にしている (`packages/server/package.json:4`)

## 適用チェックリスト

- [ ] 辞書的に使うオブジェクト (`Record<string, T>`) で `in` 演算子や `key in obj` を使う箇所を洗い出し、`Object.create(null)` に置き換えられるか検討する
- [ ] クライアントから同一ティック内に複数 API 呼び出しが発生する箇所を特定し、DataLoader パターンによるバッチ化を検討する
- [ ] WebSocket・SSE など長寿命接続で `Promise.race` を繰り返すコードがないか確認し、メモリリークの可能性を評価する
- [ ] 非同期ジェネレータのループ内で大きなオブジェクトを保持し続けていないか確認し、yield 後の `null` 代入を検討する
- [ ] ライブラリを公開している場合、`package.json` に `"sideEffects": false` を設定して tree-shaking を有効化する
- [ ] 初期化コストの高いモジュール（大量のルート定義、重い依存など）に `lazy()` + `once()` パターンを適用し、初回アクセスまでの遅延ロードを検討する
- [ ] Proxy ベースの API を提供している場合、同一パスへのアクセスでメモ化が効いているか計測する
