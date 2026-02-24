# streaming-patterns

> リポジトリ: trpc/trpc
> 分析日: 2026-02-24

## 概要

tRPC のストリーミング設計を分析する。SSE ベースの subscription（`httpSubscriptionLink`）、JSON Lines ベースのバッチストリーミング（`httpBatchStreamLink`）、`tracked()` による再接続時メッセージ重複排除、そして Observable から AsyncIterable への移行戦略を横断的に調査した。tRPC は「異なるストリーミングプロトコルを同じ AsyncIterable インターフェースに統一する」というアプローチを採り、プロトコル詳細を producer/consumer ペアに封じ込める設計が注目に値する。

## 背景にある原則

- **AsyncIterable をストリーミングの統一抽象とする**: subscription の戻り値型を `Observable` から `AsyncIterable` へ移行し（Observable は v12 で廃止予定）、`async function*` で直感的にストリームを定義できるようにした。Observable は push ベースで `subscribe/unsubscribe` のライフサイクル管理が必要だが、AsyncIterable は pull ベースで `for await...of` と `break` だけで制御でき、リソース解放が自然になる。根拠: `procedureBuilder.ts:425` の deprecated コメントと `procedureBuilder.ts:408` の AsyncIterable 型シグネチャ。

- **プロトコルの関心をproducer/consumer ペアに封じ込める**: SSE は `sseStreamProducer` / `sseStreamConsumer`、JSON Lines は `jsonlStreamProducer` / `jsonlStreamConsumer` というペアで実装し、上位レイヤー（link やルーター）はプロトコル詳細を知らない。この分離により、新しいストリーミングプロトコルの追加が容易になる。根拠: `sse.ts` と `jsonl.ts` がそれぞれ独立した producer/consumer を export している構造。

- **長寿命 Promise のメモリリークを構造的に防ぐ**: `Promise.race()` を長寿命 Promise に繰り返し適用すると、`.then()` / `.catch()` ハンドラが蓄積しメモリリークが発生する。`Unpromise` クラスは subscribe/unsubscribe パターンで参照チェーンを断ち切り、`withPing` や `takeWithGrace` などのタイムアウト付きイテレーション全体のメモリ安全性を保証する。根拠: `unpromise.ts` のクラスコメントおよび `httpSubscriptionLink.memory.test.ts` の WeakRef を用いた GC 検証テスト。

- **接続状態を型で表現し、アプリケーション層に公開する**: `TRPCConnectionState` 型（`idle` / `connecting` / `pending`）を定義し、`behaviorSubject` で状態変化をリアクティブに通知する。これにより UI 層が接続状態を宣言的に扱える。根拠: `httpSubscriptionLink.ts:114-120` の `connectionState` 初期化と状態遷移ロジック。

## 実例と分析

### SSE ストリーミング: producer/consumer の対称設計

サーバー側の `sseStreamProducer` は AsyncIterable を受け取り、SSE テキストフォーマット（`event:`, `data:`, `id:` フィールド）の `ReadableStream<Uint8Array>` に変換する。クライアント側の `sseStreamConsumer` は EventSource API を包み、`AsyncIterable<ConsumerStreamResult>` を返す。

producer は内部で `generatorWithErrorHandling` ジェネレータをラップし、エラーを `serialized-error` イベントとして送信する。正常完了時は `return` イベントを送る。これにより、ストリームの終了理由（正常/異常）がプロトコルレベルで区別可能になる。

consumer 側は `ConsumerStreamResult` を discriminated union で返し、呼び出し元が `chunk.type` で分岐するだけでよい設計になっている。

### JSON Lines バッチストリーミング: 非同期値の再帰的エンコーディング

`httpBatchStreamLink` は複数のリクエストを1つの HTTP リクエストにまとめ、レスポンスを JSON Lines で個別にストリームする。内部の `jsonlStreamProducer` は応答オブジェクトを再帰的に走査し、`Promise` や `AsyncIterable` を検出すると「チャンク定義」に置換する。各チャンクには数値型の `ChunkIndex` が割り当てられ、解決時にそのインデックスを持つ行が追加される。

この設計の重要な点は、`mergeAsyncIterables` で複数の非同期ソースを単一ストリームに合流させていることである。各 Promise/AsyncIterable は独立に解決され、解決順にストリーム上に現れる。

### tracked() による再接続復旧

`tracked(id, data)` 関数は `[id, data, Symbol]` のタプル（`TrackedEnvelope`）を返す。`sseStreamProducer` は `isTrackedEnvelope` で検出し、SSE の `id` フィールドにマッピングする。EventSource は自動的に `Last-Event-ID` ヘッダーを再接続時に送信するため、サーバー側は `lastEventId` から続きを配信できる。

`inputWithTrackedEventId` ヘルパーは、クライアント側で `lastEventId` を入力パラメータに自動注入する。`retryLink` もこの仕組みに対応しており、受信した `result.id` を追跡して再試行時に送信する。

### serverless 対応: emitAndEndImmediately

`sseStreamProducer` の `emitAndEndImmediately` オプションは、`takeWithGrace` を使って最初の1件だけを取得しストリームを即座に終了する。serverless 環境（Lambda 等）でストリーミングレスポンスが使えない場合に、1イベントごとにリクエスト/レスポンスを繰り返す polled-subscription パターンを実現する。EventSource の自動再接続と `tracked()` の組み合わせにより、クライアント側コードの変更なしに動作する。

### Observable から AsyncIterable への移行ブリッジ

`observableToAsyncIterable` は Observable を ReadableStream 経由で AsyncIterable に変換する。`resolveResponse.ts:473` で `isObservable(result.data)` の場合にこのブリッジを通し、以降は AsyncIterable として統一的に扱う。これにより、新旧の subscription 定義が同じ SSE producer パイプラインに流れる。

## コード例

```typescript
// packages/server/src/unstable-core-do-not-import/stream/tracked.ts:35-46
export function tracked<TData>(
  id: string,
  data: TData,
): TrackedEnvelope<TData> {
  if (id === '') {
    throw new Error(
      '`id` must not be an empty string as empty string is the same as not setting the id at all',
    );
  }
  return [id as TrackedId, data, trackedSymbol];
}
```

```typescript
// packages/server/src/unstable-core-do-not-import/stream/sse.ts:106-149
// SSE producer: AsyncIterable -> SSE テキストストリーム
async function* generator(): AsyncIterable<SSEvent, void> {
  yield {
    event: CONNECTED_EVENT,
    data: JSON.stringify(client),
  };
  // ...
  for await (value of iterable) {
    if (value === PING_SYM) {
      yield { event: PING_EVENT, data: '' };
      continue;
    }
    chunk = isTrackedEnvelope(value)
      ? { id: value[0], data: value[1] }
      : { data: value };
    chunk.data = JSON.stringify(serialize(chunk.data));
    yield chunk;
    // free up references for garbage collection
    value = null;
    chunk = null;
  }
}
```

```typescript
// packages/server/src/unstable-core-do-not-import/stream/utils/withPing.ts:11-47
// Ping 付き AsyncIterable: タイムアウトで PING_SYM を挿入
export async function* withPing<TValue>(
  iterable: AsyncIterable<TValue>,
  pingIntervalMs: number,
): AsyncGenerator<TValue | typeof PING_SYM> {
  await using iterator = iteratorResource(iterable);
  let result: null | IteratorResult<TValue> | typeof disposablePromiseTimerResult;
  let nextPromise = iterator.next();
  while (true) {
    using pingPromise = timerResource(pingIntervalMs);
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
    result = null;
  }
}
```

```typescript
// packages/server/src/unstable-core-do-not-import/stream/utils/disposable.ts:38-54
// Symbol.asyncDispose ポリフィルによる明示的リソース管理
export function makeAsyncResource<T>(
  thing: T,
  dispose: () => Promise<void>,
): T & AsyncDisposable {
  const it = thing as T & Partial<AsyncDisposable>;
  const existing = it[Symbol.asyncDispose];
  it[Symbol.asyncDispose] = async () => {
    await dispose();
    await existing?.();
  };
  return it as T & AsyncDisposable;
}
```

## パターンカタログ

- **Producer-Consumer パターン** (分類: 並行処理)
  - 解決する問題: ストリーミングプロトコルの encode/decode ロジックを上位レイヤーから分離する
  - 適用条件: サーバーとクライアントが非同期ストリームを異なるワイヤーフォーマットで交換する場面
  - コード例: `sse.ts:85` (sseStreamProducer) / `sse.ts:279` (sseStreamConsumer), `jsonl.ts:282` / `jsonl.ts:506`
  - 注意点: producer と consumer は対称に設計する必要がある（イベント名・チャンクフォーマットの不一致はデバッグ困難なバグの原因になる）

- **Adapter パターン** (分類: 構造)
  - 解決する問題: 旧 API (Observable) と新 API (AsyncIterable) の共存
  - 適用条件: 破壊的変更を避けながらインターフェースを移行したい場面
  - コード例: `observable.ts:168` (observableToAsyncIterable)
  - 注意点: アダプタ層は移行完了後に削除する計画を持つべき（`@deprecated` 注釈で明示）

- **Discriminated Union による状態マシン** (分類: 振る舞い)
  - 解決する問題: ストリームから届くイベントの種別を型安全に判別する
  - 適用条件: 1つのチャネルで複数種類のメッセージを扱う場面
  - コード例: `sse.ts:238-244` (ConsumerStreamResult), `subscriptions.ts:20-23` (TRPCConnectionState)
  - 注意点: union メンバーを追加する場合、consumer 側の switch 文の網羅性チェックが必要

## Good Patterns

- **Symbol による内部型のブランディング**: `tracked()` は戻り値のタプル末尾に非 export の `Symbol` を埋め込み、`isTrackedEnvelope` で判定する。これにより `[string, data]` のような偶然の一致を排除し、型の意図的な生成のみを許可する。

```typescript
// packages/server/src/unstable-core-do-not-import/stream/tracked.ts:1,26-30
const trackedSymbol = Symbol();
export function isTrackedEnvelope<TData>(
  value: unknown,
): value is TrackedEnvelope<TData> {
  return Array.isArray(value) && value[2] === trackedSymbol;
}
```

- **ループ変数の明示的 null 代入による GC 支援**: `sseStreamProducer` と `withPing` では、`for await` ループ内で処理済みの値を `null` に代入している。次の `await` で長時間ブロックされる場合、前の値への参照が残りメモリリークの原因になるため、明示的に解放する。

```typescript
// packages/server/src/unstable-core-do-not-import/stream/sse.ts:129-149
let value: null | TIteratorValue;
let chunk: null | SSEvent;
for await (value of iterable) {
  // ... process value ...
  yield chunk;
  value = null;
  chunk = null;
}
```

- **ping とクライアント側 reconnect timeout の整合性検証**: `sseStreamProducer` はコンストラクタ段階で `ping.intervalMs > client.reconnectAfterInactivityMs` を検出し即座にエラーを投げる。設定ミスによる不必要な再接続ループを防ぐ。

```typescript
// packages/server/src/unstable-core-do-not-import/stream/sse.ts:96-104
if (
  ping.enabled &&
  client.reconnectAfterInactivityMs &&
  ping.intervalMs > client.reconnectAfterInactivityMs
) {
  throw new Error(
    `Ping interval must be less than client reconnect interval...`,
  );
}
```

- **`using` / `await using` によるリソース自動解放**: `iteratorResource`, `timerResource`, `makeAsyncResource` を組み合わせ、iterator の `.return()` 呼び出しやタイマーの `clearTimeout` を TC39 Explicit Resource Management 提案 (`using` 宣言) で自動化している。

```typescript
// packages/server/src/unstable-core-do-not-import/stream/utils/asyncIterable.ts:34-35
export async function* takeWithGrace<T>(iterable: AsyncIterable<T>, opts) {
  await using iterator = iteratorResource(iterable);
  using timer = timerResource(opts.gracePeriodMs);
  // ...iterator と timer は関数終了時に自動クリーンアップ
}
```

## Anti-Patterns / 注意点

- **Promise.race の繰り返し呼び出しによるメモリリーク**: 長寿命の Promise（例: 次のデータを待つ `iterator.next()`）に対して `Promise.race` を繰り返し呼ぶと、`.then()` ハンドラが蓄積する。tRPC はこの問題を `Unpromise` で解決しているが、一般的にこのアンチパターンは見落とされやすい。

```typescript
// Bad: ネイティブ Promise.race をループ内で使用
while (true) {
  const result = await Promise.race([longLivedPromise, timeout]);
  // longLivedPromise に .then() ハンドラが毎回追加される
}

// Better: subscribe/unsubscribe で参照を解放
while (true) {
  const result = await Unpromise.race([longLivedPromise, timeout]);
  // Unpromise が自動的に unsubscribe する
}
```

- **tracked() の id に空文字を使う**: SSE 仕様では `id:` フィールドが空の場合、`lastEventId` がリセットされない。つまり空文字 id は「id なし」と同義であり、再接続時に予期しない動作を引き起こす。tRPC は実行時にエラーを投げて防止している (`tracked.ts:39-44`)。

```typescript
// Bad: 空文字 id
yield tracked('', data);  // Error: id must not be an empty string

// Better: 意味のある一意な id
yield tracked(String(cursor), data);
```

## 導出ルール

- `[MUST]` ストリーミングのタイムアウト/ping 間隔とクライアント側の再接続タイムアウトは、ping 間隔 < 再接続タイムアウトの不変条件を起動時に検証する
  - 根拠: `sse.ts:96-104` で ping 間隔が再接続間隔より長い場合にエラーを投げ、不要な再接続ループを防いでいる

- `[MUST]` 長寿命 Promise に対して `Promise.race()` をループ内で繰り返し呼ぶ場合、各イテレーションで subscribe を解放する仕組みを導入する
  - 根拠: `Unpromise` クラス (`unpromise.ts`) が WeakMap + subscribe/unsubscribe パターンでこの問題を構造的に解決しており、`httpSubscriptionLink.memory.test.ts` で WeakRef による GC テストを実施している

- `[MUST]` SSE の tracked id にはゼロ長文字列を使わない（SSE 仕様上「id なし」と同義になるため）
  - 根拠: `tracked.ts:39-44` で空文字 id を実行時にバリデーションしている

- `[SHOULD]` AsyncIterable の `for await` ループ内で、処理済みの値への参照を次の `await` 前に明示的に `null` に代入してメモリを解放する
  - 根拠: `sse.ts:129-149`, `withPing.ts:18-46` でループ変数を `null` クリアし、次の値が届くまで前の値が GC 対象になるようにしている

- `[SHOULD]` ストリーミングのエンコード/デコードは producer/consumer ペアとして対称に設計し、上位レイヤーからプロトコル詳細を隠蔽する
  - 根拠: `sseStreamProducer/sseStreamConsumer`, `jsonlStreamProducer/jsonlStreamConsumer` が独立したモジュールとして実装され、link レイヤーは AsyncIterable / ReadableStream のみを扱う

- `[SHOULD]` ストリームイベントの型は discriminated union で定義し、`type` フィールドで分岐する
  - 根拠: `ConsumerStreamResult` (`sse.ts:238-244`) が `data | serialized-error | connecting | timeout | ping | connected` の6種を網羅し、型安全な switch 分岐を可能にしている

- `[SHOULD]` AsyncIterator や Timer など解放が必要なリソースは `Symbol.dispose` / `Symbol.asyncDispose` を実装し、`using` / `await using` で自動解放する
  - 根拠: `disposable.ts` の `makeResource/makeAsyncResource` がすべてのストリームユーティリティで活用されている

- `[AVOID]` ストリーミング API を Observable のみで設計する（AsyncIterable を優先する）
  - 根拠: tRPC は Observable ベースの subscription を `@deprecated` とし AsyncIterable へ移行中。Observable は push ベースで購読管理が複雑だが、AsyncIterable は `for await...of` + `break` で直感的にリソース解放される

## 適用チェックリスト

- [ ] ストリーミング層のエンコード/デコードが producer/consumer ペアとして分離されているか
- [ ] 長寿命 Promise に対する `Promise.race` ループでメモリリーク対策（unsubscribe 等）が入っているか
- [ ] `for await` ループ内で、処理済みの大きなオブジェクトへの参照を次の `await` 前に解放しているか
- [ ] SSE を使う場合、ping 間隔がクライアントの再接続タイムアウトより短いことを検証しているか
- [ ] ストリームの正常終了/異常終了/再接続がプロトコルレベルで区別可能か（例: SSE の `return` / `serialized-error` イベント）
- [ ] 接続状態（connecting / connected / idle）を型付きの状態マシンとして公開しているか
- [ ] 再接続時のメッセージ重複排除の仕組み（tracked id / lastEventId）が実装されているか
- [ ] serverless 環境でストリーミングが使えない場合の fallback（polled-subscription）を考慮しているか
- [ ] AsyncIterator の `.return()` が確実に呼ばれるリソース解放パスが存在するか（`using` 宣言または `try/finally`）
