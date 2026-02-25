# Practice: Streaming Leak Prevention

> 出典: [repos/trpc/trpc](../repos/trpc/trpc/), [repos/honojs/hono](../repos/honojs/hono/), [repos/openclaw/openclaw](../repos/openclaw/openclaw/)
> カテゴリ: practice

## 概要

長寿命 Promise に対する `Promise.race()` のループ呼び出しは、`.then()` ハンドラの蓄積によるメモリリークを引き起こす。tRPC の `Unpromise` が実装する subscribe/unsubscribe ペア、SSE ジェネレータでの明示的 null 解放、hono の WeakMap によるコンテキスト保持、openclaw の `.bind()` によるクロージャ回避という 4 つの手法を横断的に整理し、ストリーミング処理のメモリ安全性を構造的に保証するプラクティスを体系化する。

## 背景・文脈

SSE や WebSocket のようなストリーミング接続では、「次のデータを待つ Promise」と「タイムアウト Promise」を `Promise.race()` でレースさせるループが頻出する。しかしネイティブの `Promise.race()` は、元の Promise に `.then()` ハンドラを登録するだけで、レース終了後もハンドラを解除しない。長寿命の Promise（次のデータが数分後に届く `iterator.next()` など）に対してこのパターンを繰り返すと、`.then()` ハンドラが際限なく蓄積し、GC されないメモリリークが発生する。

この問題は tRPC の SSE/WebSocket ストリーミング、hono のストリームコンテキスト管理、openclaw の AbortController リレーなど、複数のプロダクションコードベースで独立に認識され、それぞれ異なるアプローチで解決されている。

## 実装パターン

### 手法 1: subscribe/unsubscribe ペア (tRPC Unpromise)

tRPC の `Unpromise` クラスは、ネイティブ `Promise.race()` のメモリリーク問題を構造的に解決する。各 Promise を `subscribe()` で監視し、レース終了後に `unsubscribe()` で参照チェーンを切断する。キャッシュには `WeakMap` を使い、元 Promise が GC 対象になればキャッシュも自然に回収される。

```typescript
// packages/server/src/vendor/unpromise/unpromise.ts:60
// WeakMap で ProxyPromise をキャッシュし、subscribe/unsubscribe で参照を管理
const subscribableCache = new WeakMap<
  PromiseLike<unknown>,
  ProxyPromise<unknown>
>();
```

`Unpromise.race()` は `try/finally` で確実に `unsubscribe()` を呼び、参照チェーンを切断する。

```typescript
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

このパターンは tRPC のストリーミング基盤全体で一貫して使われている。`withPing` のタイムアウトループ (`withPing.ts:28`)、SSE consumer のストリーム読み取り (`sse.ts:268`)、WebSocket のメッセージ待機 (`ws.ts:345`) のすべてが `Unpromise.race` を使用する。

### 手法 2: 明示的 null 解放 (tRPC)

`for await` ループ内で処理済みの値を次の `await` 前に明示的に `null` に代入し、前の値への参照が残らないようにする。次のデータが数分後に届く場合、null 解放しなければ前の値がその間ずっとメモリに残る。

```typescript
// packages/server/src/unstable-core-do-not-import/stream/sse.ts:129-149
let value: null | TIteratorValue;
let chunk: null | SSEvent;
for await (value of iterable) {
  // ... process value ...
  yield chunk;
  // free up references for garbage collection
  value = null;
  chunk = null;
}
```

同じパターンが `withPing.ts`、`ws.ts`、`asyncIterable.ts` の 4 箇所に適用されている。変数はループ外で宣言し、yield/await 後に `null` を代入する。

```typescript
// packages/server/src/unstable-core-do-not-import/stream/utils/withPing.ts:17-46
// declaration outside the loop for garbage collection reasons
let result: null | IteratorResult<TValue> | typeof disposablePromiseTimerResult;

while (true) {
  result = await Unpromise.race([nextPromise, pingPromise.start()]);
  // ... yield result ...
  // free up reference for garbage collection
  result = null;
}
```

### 手法 3: WeakMap によるコンテキスト保持 (hono)

hono のストリーミングヘルパーでは、レスポンス返却後もコールバック内で `Context` オブジェクトを使う必要がある。Bun ランタイムではレスポンスを返した時点で `Context` が GC される問題があるため、`WeakMap<ReadableStream, Context>` でストリームの生存期間中だけコンテキストを保持する。

```typescript
// src/helper/streaming/stream.ts:5,25
const contextStash: WeakMap<ReadableStream, Context> = new WeakMap();
// ...
contextStash.set(stream.responseReadable, c);
```

`WeakMap` のキーは弱参照であるため、ストリームが GC されればコンテキストも自然に回収される。強参照で保持するとストリーム終了後もコンテキストが残り、メモリリークの原因になる。

### 手法 4: .bind() によるクロージャ回避 (openclaw)

AbortController のキャンセルリレーでアロー関数クロージャを使うと、クロージャがスコープ全体をキャプチャしてメモリリークを引き起こす。openclaw は `.bind()` を使ってスコープキャプチャを回避する。

```typescript
// src/utils/fetch-timeout.ts:5-12
function relayAbort(this: AbortController) {
  this.abort();
}

export function bindAbortRelay(controller: AbortController): () => void {
  return relayAbort.bind(controller);
}
```

`bind()` が返す関数は `this` の参照だけを保持し、アロー関数のようにスコープ全体をキャプチャしない。長時間実行プロセスでのイベントリスナー登録で効果的である。

## Good Example

### subscribe/unsubscribe で Promise.race のリークを防ぐ

```typescript
// Good: Unpromise.race で subscribe/unsubscribe を自動管理
// packages/server/src/unstable-core-do-not-import/stream/utils/withPing.ts:11-47
export async function* withPing<TValue>(
  iterable: AsyncIterable<TValue>,
  pingIntervalMs: number,
): AsyncGenerator<TValue | typeof PING_SYM> {
  await using iterator = iteratorResource(iterable);
  let result: null | IteratorResult<TValue> | typeof disposablePromiseTimerResult;
  let nextPromise = iterator.next();
  while (true) {
    using pingPromise = timerResource(pingIntervalMs);
    // Unpromise.race は内部で subscribe → 結果取得 → unsubscribe を行う
    result = await Unpromise.race([nextPromise, pingPromise.start()]);
    if (result === disposablePromiseTimerResult) {
      yield PING_SYM;
      continue;
    }
    if (result.done) {
      return result.value;
    }
    nextPromise = iterator.next();
    yield result.value;
    result = null; // 明示的に参照を解放
  }
}
```

3 つの手法が組み合わさっている点に注目:

1. `Unpromise.race` で Promise の参照チェーン切断
2. `result = null` で処理済みデータの明示的解放
3. `await using` / `using` でイテレータとタイマーの自動クリーンアップ

### WeakMap でストリーム付随リソースを安全に保持する

```typescript
// Good: WeakMap でストリームのライフサイクルに連動
// src/helper/streaming/stream.ts:5,25
const contextStash: WeakMap<ReadableStream, Context> = new WeakMap();

export const stream = (c: Context, cb: StreamCallback, onError?: ErrorHandler) => {
  const { readable, writable } = new TransformStream();
  const stream = new StreamingApi(writable, readable);
  contextStash.set(stream.responseReadable, c); // ストリーム GC で自動回収
  // ...
};
```

### .bind() でイベントリスナーのクロージャリークを防ぐ

```typescript
// Good: .bind() でスコープキャプチャを回避
// src/agents/pi-tools.abort.ts:35-43
const controller = new AbortController();
const onAbort = bindAbortRelay(controller); // bind() で最小限の参照のみ保持
parentSignal?.addEventListener("abort", onAbort, { once: true });
childSignal?.addEventListener("abort", onAbort, { once: true });
```

## Bad Example

### Promise.race のループ呼び出しによるメモリリーク

```typescript
// Bad: ネイティブ Promise.race をループ内で使用
// longLivedPromise に .then() ハンドラが毎回追加され、GC されない
const longLivedPromise = iterator.next(); // 数分間 pending のまま
while (true) {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 30000));
  const result = await Promise.race([longLivedPromise, timeout]);
  // longLivedPromise に .then() ハンドラが蓄積し続ける
  // → 1 時間で数千個のハンドラが蓄積 → メモリ使用量が単調増加
}

// Good: subscribe/unsubscribe でハンドラを解除
while (true) {
  const result = await Unpromise.race([longLivedPromise, timeout]);
  // Unpromise が内部で unsubscribe → 参照チェーンが切断される
}
```

### ループ変数の参照が次の await まで残る

```typescript
// Bad: ループ内の let 宣言 — 次の await まで前の値が GC されない
while (true) {
  let result = await iterator.next();
  yield result.value;
  // result は次のイテレーションの await iterator.next() が解決するまで保持される
  // 大きなオブジェクトの場合、メモリ圧迫の原因になる
}

// Good: ループ外宣言 + 明示的 null 解放
let result: IteratorResult<T> | null;
while (true) {
  result = await iterator.next();
  yield result.value;
  result = null; // 次の await 前に明示的に参照を解放
}
```

### アロー関数クロージャによるスコープキャプチャ

```typescript
// Bad: アロー関数がスコープ全体をキャプチャ
function setupTimeout(controller: AbortController, signal: AbortSignal) {
  const largeBuffer = new ArrayBuffer(1024 * 1024); // 1MB
  // アロー関数がクロージャとしてスコープ全体 (largeBuffer 含む) をキャプチャ
  signal.addEventListener("abort", () => controller.abort());
  return largeBuffer;
}

// Good: .bind() で最小限の参照のみ保持
function relayAbort(this: AbortController) {
  this.abort();
}
signal.addEventListener("abort", relayAbort.bind(controller), { once: true });
```

## 適用ガイド

### どのような状況で使うべきか

- **SSE / WebSocket のストリーミングループ**: `Promise.race` で次のデータとタイムアウトをレースさせる場合。接続が長時間続くほどリークの影響が大きくなる
- **非同期ジェネレータの yield ループ**: `for await` や `while(true)` で大きなオブジェクトを逐次処理し、次の値が届くまで長時間 await する場合
- **レスポンス返却後のバックグラウンド処理**: ストリーミングレスポンスを返した後、コールバック内でコンテキストやリソースを参照する場合
- **AbortController のキャンセル伝播チェーン**: 長時間実行プロセスで AbortSignal のリレーを設定する場合

### 導入時の注意点

- **Unpromise パターンのテスト**: tRPC は `WeakRef` を用いた GC 検証テスト (`httpSubscriptionLink.memory.test.ts`) でメモリリークの回帰を防いでいる。同様の GC テストを導入することで、リファクタリング時のリーク再発を検知できる
- **null 解放の一貫性**: チーム内で「yield/await 後に null 代入する」ルールを明文化しないと、新規コードで漏れが生じる。リンタールールやコメントで強調する
- **WeakMap のキー制約**: WeakMap のキーはオブジェクトでなければならない。プリミティブ値をキーにする必要がある場合は `Map` + 明示的 delete で代替する

### カスタマイズポイント

- **Unpromise の自作**: tRPC の `Unpromise` は `WeakMap` + `subscribe`/`unsubscribe` の約 300 行。プロジェクトの要件に合わせて簡略版を実装できる。最小限には `Promise.race` の前後で `subscribe`/`unsubscribe` する wrapper 関数で十分
- **Explicit Resource Management との併用**: tRPC は `using`/`await using` と `Unpromise` を組み合わせてリソース解放を自動化している。TC39 Explicit Resource Management が使える環境では積極的に併用すべき
- **WeakRef による GC テスト**: メモリリーク防止のテストには `WeakRef` + `gc()` (V8 の `--expose-gc` フラグ) で対象オブジェクトの GC を検証するパターンが有効

## 導出ルール

- `[MUST]` 長寿命 Promise に対して `Promise.race()` をループ内で繰り返し呼ぶ場合、各イテレーションで subscribe を解放する仕組み（Unpromise パターン等）を導入する
  - 根拠: tRPC の `Unpromise` クラスが WeakMap + subscribe/unsubscribe パターンでこの問題を構造的に解決しており、`httpSubscriptionLink.memory.test.ts` で WeakRef による GC テストを実施している

- `[MUST]` ストリーミングに付随するリソース（コンテキスト、バッファ等）を外部に保持する場合、強参照ではなく WeakMap や WeakRef で保持し、ストリーム終了時に自然に GC されるようにする
  - 根拠: hono が `WeakMap<ReadableStream, Context>` で Bun の早期 GC 問題を解決しつつ、ストリーム終了後のメモリリークを防止している (`src/helper/streaming/stream.ts:5,25`)

- `[MUST]` メモリリーク防止パターンには WeakRef を用いた GC テストを追加し、回帰を機械的に検知する
  - 根拠: tRPC の `httpSubscriptionLink.memory.test.ts` が WeakRef + `gc()` でストリーミングのメモリリーク回帰を防止している

- `[SHOULD]` 非同期ジェネレータの `for await` / `while` ループ内で、処理済みの値への参照を次の `await` 前に明示的に `null` に代入してメモリを解放する
  - 根拠: tRPC の SSE producer、withPing、WebSocket アダプタ、takeWithGrace の 4 箇所すべてで `result = null` による明示的 GC ヒントを実装している

- `[SHOULD]` AbortController のキャンセルリレーにはアロー関数クロージャではなく `.bind()` を使い、長時間プロセスでのメモリリークを防ぐ
  - 根拠: openclaw の `bindAbortRelay` パターンで実証されており、回帰テスト (`src/infra/abort-pattern.test.ts`) で検証されている

- `[AVOID]` ネイティブの `Promise.race()` / `Promise.any()` を長寿命 Promise に対してループ内で直接使用すること
  - 根拠: `.then()` ハンドラが元の Promise に蓄積し続け、GC されないメモリリークを引き起こす。tRPC はこの問題を認識し、すべてのストリーミングコードで `Unpromise.race` に置き換えている

## 参考

- [repos/trpc/trpc/streaming-patterns.md](../repos/trpc/trpc/streaming-patterns.md) -- Unpromise、null 解放、SSE producer/consumer の分析
- [repos/trpc/trpc/performance-techniques.md](../repos/trpc/trpc/performance-techniques.md) -- Promise.race メモリリーク防止、非同期ループの参照解放
- [repos/honojs/hono/streaming-patterns.md](../repos/honojs/hono/streaming-patterns.md) -- WeakMap コンテキスト保持、TransformStream ベースのストリーム設計
- [repos/openclaw/openclaw/concurrency-patterns.md](../repos/openclaw/openclaw/concurrency-patterns.md) -- bindAbortRelay によるクロージャリーク防止、AbortController 合成
