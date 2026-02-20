# ストリーミングと非同期パターン

> リポジトリ: vercel/ai
> 分析日: 2026-02-20

## 概要

Vercel AI SDK は LLM のストリーミングレスポンスを Web 標準 API（ReadableStream / TransformStream）の上に構築し、サーバーからクライアントまで一貫したストリームパイプラインを実現している。特筆すべきは、ReadableStream と AsyncIterable のデュアルインターフェース、ストリーム合成（stitchable stream）によるマルチステップ実行、遅延 Promise によるストリーム消費とプロパティアクセスの統合、そして TransformStream チェーンによるストリーム変換の合成可能性である。これらのパターンは AI SDK 固有のものではなく、あらゆるストリーミングデータフローの設計に応用できる。

## 背景にある原則

- **Web 標準プリミティブへの統一**: ReadableStream / TransformStream / TextEncoderStream といった Web Streams API を全層で使用し、Node.js 固有のストリーム（`stream.Readable` 等）への依存を排除している。これにより Edge Runtime と Node.js の両方で動作し、ランタイム固有の分岐が不要になる。`packages/ai/src/util/async-iterable-stream.ts` で ReadableStream に AsyncIterable プロトコルを合成することで、`for await...of` と `.pipeThrough()` の両方が同一オブジェクトで使える。
  - 根拠: `packages/ai/src/util/async-iterable-stream.ts:5` の `AsyncIterableStream<T> = AsyncIterable<T> & ReadableStream<T>` 型定義

- **ストリームは生産側で完結、消費側は必要時に駆動**: ストリーム結果オブジェクト（`StreamTextResult`）のプロパティ（`text`, `usage` 等）は `PromiseLike` であり、アクセス時に自動的にストリームを消費する。この設計により、呼び出し側はストリーミング消費と最終結果取得のどちらのユースケースでも同一の API で対応でき、未消費ストリームが放置される問題を防ぐ。
  - 根拠: `packages/ai/src/generate-text/stream-text.ts:1933-1936` の `get steps()` で `this.consumeStream()` を呼び出し

- **TransformStream チェーンによる関心の分離**: ストリームの変換は小さな TransformStream を `.pipeThrough()` で直列に接続することで実現し、各変換が単一の責務を持つ。ストリームの分岐（`tee()`）も組み合わせることで、同じソースストリームから異なるビュー（textStream, fullStream, partialOutputStream 等）を生成する。
  - 根拠: `packages/ai/src/generate-text/stream-text.ts:1134` の `stream.pipeThrough(createOutputTransformStream(...)).pipeThrough(eventProcessor)` チェーン

- **ストリーム中断とリソース解放の一貫したハンドリング**: AbortSignal の統合、cleanup 関数による reader の cancel/releaseLock、TransformStream の `flush()` によるファイナライゼーションなど、非同期リソースの解放が体系的に組み込まれている。
  - 根拠: `packages/ai/src/util/async-iterable-stream.ts:35-48` の cleanup 関数と `packages/ai/src/util/merge-abort-signals.ts` の複数 AbortSignal 統合

## 実例と分析

### AsyncIterableStream: ReadableStream と AsyncIterable の統合

`createAsyncIterableStream` は ReadableStream に `Symbol.asyncIterator` を追加することで、一つのオブジェクトが `for await...of` と `.pipeThrough()` の両方のプロトコルを満たす。ポイントは、元のストリームを `pipeThrough(new TransformStream())` で一度通すことで新しいロックフリーなストリームを得ること、および `return()` / `throw()` で必ず reader の cancel と releaseLock を行うこと。

```typescript
// packages/ai/src/util/async-iterable-stream.ts:15-19
export function createAsyncIterableStream<T>(
  source: ReadableStream<T>,
): AsyncIterableStream<T> {
  const stream = source.pipeThrough(new TransformStream<T, T>());
```

これにより `StreamTextResult.textStream` は以下の両方の消費方法をサポートする:

```typescript
// for await...of でテキスト断片を逐次処理
for await (const delta of result.textStream) { ... }

// ReadableStream として Response に渡す
return new Response(result.textStream)
```

### Stitchable Stream: マルチステップストリームの結合

`createStitchableStream` は、複数の ReadableStream を逐次的に一つの ReadableStream に結合するパターンを実装する。LLM の tool-calling ループでは、各ステップが個別のストリームを生成するが、外部 API としては単一のストリームとして公開する必要がある。

```typescript
// packages/ai/src/util/create-stitchable-stream.ts:9-13
export function createStitchableStream<T>(): {
  stream: ReadableStream<T>;
  addStream: (innerStream: ReadableStream<T>) => void;
  close: () => void;
  terminate: () => void;
};
```

`addStream` で内部ストリームを追加し、前のストリームが完了したら次のストリームから読み始める。`close` は全内部ストリーム完了後にクローズし、`terminate` は即座に全キャンセル。内部では `createResolvablePromise` を使い、新しいストリームの追加を `pull()` 内で待機する。

```typescript
// packages/ai/src/util/create-stitchable-stream.ts:36-42
// Case 2: No inner streams available, but outer stream is open
if (innerStreamReaders.length === 0) {
  waitForNewStream = createResolvablePromise<void>();
  await waitForNewStream.promise;
  return processPull();
}
```

### DelayedPromise: ストリーム消費を Promise アクセスに統合

`DelayedPromise` は Promise の構築を `.promise` プロパティへの初回アクセスまで遅延する。ストリーム結果の `text` や `usage` のような最終値は、ストリーム消費が完了するまで確定しないため、DelayedPromise に格納しておき、ストリームの `flush()` で resolve する。Promise を生成しなければ `unhandled rejection` も発生しない。

```typescript
// packages/provider-utils/src/delayed-promise.ts:6-13
export class DelayedPromise<T> {
  private status:
    | { type: 'pending' }
    | { type: 'resolved'; value: T }
    | { type: 'rejected'; error: unknown } = { type: 'pending' };
  private _promise: Promise<T> | undefined;
```

ストリーム側では値が確定した時点で resolve:

```typescript
// packages/ai/src/generate-text/stream-text.ts:989-991
self._finishReason.resolve(finishReason);
self._rawFinishReason.resolve(recordedRawFinishReason);
self._totalUsage.resolve(totalUsage);
```

アクセス側ではストリームの自動消費をトリガー:

```typescript
// packages/ai/src/generate-text/stream-text.ts:1933-1938
get steps() {
  this.consumeStream();
  return this._steps.promise;
}
```

### TransformStream パイプラインによるストリーム変換

`streamText` では、プロバイダから返るストリームを複数の TransformStream でチェーンし、型変換・副作用の実行・ストリーム分岐を行う。

1. **Provider → 統一フォーマット変換**: `text-delta` の `delta` → `text` へのリネームなど
2. **Output 解析（createOutputTransformStream）**: テキストデルタを蓄積し、部分 JSON パースを試行して部分出力を生成
3. **イベント処理（eventProcessor）**: コンテンツの記録、ステップ完了の処理、コールバック呼び出し

```typescript
// packages/ai/src/generate-text/stream-text.ts:1134-1136
this.baseStream = stream
  .pipeThrough(createOutputTransformStream(output ?? text()))
  .pipeThrough(eventProcessor);
```

ストリームの分岐は `tee()` で実現し、各ビュー（textStream, fullStream 等）が独立した TransformStream で必要な部分だけをフィルタリングする:

```typescript
// packages/ai/src/generate-text/stream-text.ts:2045-2048
private teeStream() {
  const [stream1, stream2] = this.baseStream.tee();
  this.baseStream = stream2;
  return stream1;
}
```

### SSE レスポンスへの変換

ストリームを HTTP レスポンスとして返す際、`JsonToSseTransformStream` で JSON チャンクを SSE フォーマットに変換し、さらに `TextEncoderStream` で UTF-8 エンコードする。

```typescript
// packages/ai/src/ui-message-stream/json-to-sse-transform-stream.ts:6-17
export class JsonToSseTransformStream extends TransformStream<unknown, string> {
  constructor() {
    super({
      transform(part, controller) {
        controller.enqueue(`data: ${JSON.stringify(part)}\n\n`);
      },
      flush(controller) {
        controller.enqueue("data: [DONE]\n\n");
      },
    });
  }
}
```

### smoothStream: 出力の UX 最適化

`smoothStream` は、LLM から一度に大きなチャンクが来る場合にバッファリングと遅延を加え、ユーザーに自然なタイピング体験を提供する TransformStream を返す。チャンク分割戦略（word / line / RegExp / Intl.Segmenter / カスタム関数）を切り替え可能にしている。

```typescript
// packages/ai/src/generate-text/smooth-stream.ts:29-44
export function smoothStream<TOOLS extends ToolSet>({
  delayInMs = 10,
  chunking = 'word',
}: { ... }): (options: {
  tools: TOOLS;
}) => TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>>
```

### simulateStreamingMiddleware: 同期 → ストリーミング変換

ストリーミング非対応のモデルに対して、`doGenerate` の結果を ReadableStream として構築し、ストリーミング API と同じインターフェースで消費可能にする。

```typescript
// packages/ai/src/middleware/simulate-streaming-middleware.ts:10-11
wrapStream: async ({ doGenerate }) => {
  const result = await doGenerate();
```

## コード例

```typescript
// packages/ai/src/util/async-iterable-stream.ts:25-31
// ReadableStream に AsyncIterator プロトコルを付与
(stream as AsyncIterableStream<T>)[Symbol.asyncIterator] = function (
  this: ReadableStream<T>,
): AsyncIterator<T> {
  const reader = this.getReader();
  let finished = false;
```

```typescript
// packages/ai/src/util/create-stitchable-stream.ts:29-42
// pull 関数内で新しいストリームの追加を非同期に待機
const processPull = async () => {
  if (isClosed && innerStreamReaders.length === 0) {
    controller?.close();
    return;
  }
  if (innerStreamReaders.length === 0) {
    waitForNewStream = createResolvablePromise<void>();
    await waitForNewStream.promise;
    return processPull();
  }
```

```typescript
// packages/ai/src/generate-text/stream-text.ts:1516-1521
// stitchable stream にステップごとのストリームを追加
self.addStream(
  streamWithToolResults.pipeThrough(
    new TransformStream<
      SingleRequestTextStreamPart<TOOLS>,
      TextStreamPart<TOOLS>
    >({
```

```typescript
// packages/ai/src/ui-message-stream/create-ui-message-stream-response.ts:28-39
// JSON → SSE → TextEncoder の変換パイプライン
let sseStream = stream.pipeThrough(new JsonToSseTransformStream());
if (consumeSseStream) {
  const [stream1, stream2] = sseStream.tee();
  sseStream = stream1;
  consumeSseStream({ stream: stream2 });
}
return new Response(sseStream.pipeThrough(new TextEncoderStream()), {
  status,
  statusText,
  headers: prepareHeaders(headers, UI_MESSAGE_STREAM_HEADERS),
});
```

## パターンカタログ

- **Adapter パターン** (分類: 構造)
  - 解決する問題: ReadableStream と AsyncIterable は異なるプロトコルで、呼び出し側が消費方法を選べない
  - 適用条件: ストリームを `for await...of` と Web API（Response, pipeThrough 等）の両方で使いたい場合
  - コード例: `packages/ai/src/util/async-iterable-stream.ts:15-94`
  - 注意点: `pipeThrough(new TransformStream())` で新しいストリームを作らないとロック競合が発生する

- **Pipeline パターン** (分類: 振る舞い / データフロー)
  - 解決する問題: ストリームデータに対する複数の変換・副作用を分離して合成する
  - 適用条件: データストリームに段階的な変換（型変換・フィルタリング・解析・副作用）を適用する場合
  - コード例: `packages/ai/src/generate-text/stream-text.ts:1134-1136` の `.pipeThrough()` チェーン
  - 注意点: 各 TransformStream は独立した責務を持ち、前段の出力型と後段の入力型を合わせる

- **Composite Stream パターン** (分類: 構造)
  - 解決する問題: 時間差で生成される複数のストリームを単一のストリームとして消費者に提供する
  - 適用条件: マルチステップ処理（tool-calling ループ等）で各ステップがストリームを生成する場合
  - コード例: `packages/ai/src/util/create-stitchable-stream.ts:9-112`
  - 注意点: graceful close と immediate terminate を区別する必要がある

- **Lazy Promise パターン** (分類: 振る舞い)
  - 解決する問題: ストリームの最終結果を Promise で公開するが、未アクセス時に unhandled rejection を防ぎたい
  - 適用条件: ストリーム消費完了後に確定する値を、ストリーム消費とは独立にアクセスさせたい場合
  - コード例: `packages/provider-utils/src/delayed-promise.ts:6-61`
  - 注意点: resolve/reject の前に promise にアクセスされた場合のハンドリングが必要

## Good Patterns

- **デュアルインターフェース型によるストリーム消費の柔軟性**: `AsyncIterableStream<T> = AsyncIterable<T> & ReadableStream<T>` という型レベルの統合により、`for await...of` でもパイプラインでも消費可能。利用者が消費方法を選択できる。
  ```typescript
  // packages/ai/src/util/async-iterable-stream.ts:5
  export type AsyncIterableStream<T> = AsyncIterable<T> & ReadableStream<T>;
  ```

- **tee() による遅延ストリーム分岐**: `textStream`, `fullStream`, `partialOutputStream` 等の getter は呼ばれるたびに `tee()` で分岐し、それぞれが独立したフィルタリング TransformStream を持つ。不要なビューは生成されず、必要なビューだけを効率的に取得できる。
  ```typescript
  // packages/ai/src/generate-text/stream-text.ts:2045-2048
  private teeStream() {
    const [stream1, stream2] = this.baseStream.tee();
    this.baseStream = stream2;
    return stream1;
  }
  ```

- **safeEnqueue による閉じ済みストリームへの安全な書き込み**: `createUIMessageStream` では enqueue を try-catch でラップし、ストリームが閉じられた後のエラーを抑制する。非同期のマージストリームが完了するタイミングが不定の場合に有効。
  ```typescript
  // packages/ai/src/ui-message-stream/create-ui-message-stream.ts:66-72
  function safeEnqueue(data: InferUIMessageChunk<UI_MESSAGE>) {
    try {
      controller.enqueue(data);
    } catch (error) {
      // suppress errors when the stream has been closed
    }
  }
  ```

- **mergeAbortSignals による複数キャンセルソースの統合**: total timeout、step timeout、chunk timeout、ユーザー指定の AbortSignal を一つに統合し、どのソースからのキャンセルも一貫して処理する。
  ```typescript
  // packages/ai/src/util/merge-abort-signals.ts:10-12
  export function mergeAbortSignals(
    ...signals: (AbortSignal | null | undefined)[]
  ): AbortSignal | undefined {
  ```

## Anti-Patterns / 注意点

- **ストリームのロックを考慮しない再利用**: ReadableStream は一度 reader を取得するとロックされ、別の消費ができなくなる。`createAsyncIterableStream` が `pipeThrough(new TransformStream())` で新しいストリームを作るのはこの問題の回避策。

  Bad:
  ```typescript
  const stream = someSource.getReader(); // ロックされる
  stream.pipeTo(destination); // エラー: ストリームはロック済み
  ```

  Better:
  ```typescript
  // pipeThrough で新しいストリームを生成してからアダプタを付与
  const stream = source.pipeThrough(new TransformStream<T, T>());
  ```

- **flush() でのファイナライゼーション漏れ**: TransformStream の `flush()` はストリーム完了時に一度だけ呼ばれ、ここでリソース解放やコールバック実行を行う。`flush()` を実装しないと、`onFinish` コールバックが呼ばれない、Promise が resolve されないなどの問題が起きる。`handleUIMessageStreamFinish` では `flush()` と `cancel()` の両方で `callOnFinish()` を呼ぶことで、正常終了とキャンセルの両方をカバーしている。

  Bad:
  ```typescript
  new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
    },
    // flush() なし → onFinish が呼ばれない
  });
  ```

  Better:
  ```typescript
  new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
    },
    async flush() {
      await callOnFinish();
    },
    // @ts-expect-error cancel is still new and missing from types
    async cancel() {
      await callOnFinish();
    },
  });
  ```

- **ストリームを消費せずに放置**: ストリーム結果のプロパティにアクセスしない場合、バックプレッシャーによりストリームが停止する可能性がある。AI SDK は `consumeStream()` を自動的に呼ぶ仕組みを持つが、カスタム実装では忘れがち。

  Bad:
  ```typescript
  const result = streamText({ ... });
  // result.textStream も result.text も使わない → ストリームが停止
  ```

  Better:
  ```typescript
  const result = streamText({ ... });
  await result.consumeStream(); // 明示的にストリームを排水
  // または result.text でアクセスすれば自動消費される
  ```

## 導出ルール

- `[MUST]` ReadableStream に AsyncIterable を実装する際は `pipeThrough(new TransformStream())` で新しいストリームを生成してからイテレータを付与する -- 元のストリームに直接 reader を取得するとロック競合が発生する
  - 根拠: `packages/ai/src/util/async-iterable-stream.ts:19` で必ず pipeThrough を挟んでいる

- `[MUST]` ストリームの AsyncIterator 実装では `return()` と `throw()` で必ずリーダーの cancel と releaseLock を呼ぶ -- `for await...of` の break やエラーでリソースリークが発生する
  - 根拠: `packages/ai/src/util/async-iterable-stream.ts:35-48` の cleanup 関数

- `[MUST]` TransformStream の `flush()` でストリーム完了時のファイナライゼーション（Promise resolve、コールバック呼び出し）を実行する -- flush がないと最終状態の通知が漏れる
  - 根拠: `packages/ai/src/generate-text/stream-text.ts:967-1061` の flush 内で DelayedPromise の resolve と onFinish を呼び出し

- `[SHOULD]` ストリームの最終結果を Promise で公開する場合は Lazy Promise（アクセス時に構築）を使い、未アクセス時の unhandled rejection を防ぐ
  - 根拠: `packages/provider-utils/src/delayed-promise.ts` で Promise の生成を `.promise` アクセスまで遅延

- `[SHOULD]` 複数の AbortSignal を扱う場合は新しい AbortController に集約し、任意のソースからのキャンセルを統一的にハンドリングする
  - 根拠: `packages/ai/src/util/merge-abort-signals.ts:10-43` で複数シグナルを一つに統合

- `[SHOULD]` ストリームの変換は単一責務の TransformStream を `.pipeThrough()` で直列に接続し、各変換を独立にテスト・差し替え可能にする
  - 根拠: `stream-text.ts` の `stream.pipeThrough(outputTransform).pipeThrough(eventProcessor)` チェーン

- `[SHOULD]` 時間差で生成される複数のストリームを単一のストリームとして公開する場合は、外部ストリームの `pull()` 内で Resolvable Promise を使って次のストリーム追加を待機する
  - 根拠: `packages/ai/src/util/create-stitchable-stream.ts:38-42` の待機パターン

- `[AVOID]` ストリームを生成して消費しないまま放置する -- バックプレッシャーによりプロデューサー側が停止し、Promise が永久に resolve しない
  - 根拠: `packages/ai/src/generate-text/stream-text.ts:1936` で get アクセス時に `consumeStream()` を呼ぶ防御策を入れている

## 適用チェックリスト

- [ ] ストリーミング API の返り値型に `AsyncIterableStream<T>` パターン（ReadableStream + AsyncIterable の合成型）を採用しているか
- [ ] TransformStream チェーンで各変換が単一の責務を持ち、独立にテスト可能か
- [ ] ストリーム結果の最終値（usage, finishReason 等）を Promise で公開する場合、DelayedPromise を使って unhandled rejection を防いでいるか
- [ ] AsyncIterator の `return()` / `throw()` でリーダーの cancel と releaseLock を呼んでいるか
- [ ] 複数の AbortSignal（ユーザー指定、タイムアウト等）を AbortController に集約して統一的に扱っているか
- [ ] マルチステップのストリーム処理で、各ステップのストリームが安全に結合され、エラー時に全ストリームが適切にクリーンアップされるか
- [ ] TransformStream の `flush()` で Promise の resolve やコールバック呼び出しを確実に行っているか
- [ ] ストリームを生成したら、必ず消費されるパス（`consumeStream` やプロパティアクセスによる自動消費）が存在するか
