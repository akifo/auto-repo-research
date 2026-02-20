# streaming-patterns

> リポジトリ: langchain-ai/langchainjs
> 分析日: 2026-02-20

## 概要

langchainjs のストリーミングアーキテクチャを横断的に分析した。全コンポーネント（LLM、チェーン、ツール、エージェント）が統一的にストリーミングできる仕組みは、`Runnable` 基底クラスの `_streamIterator` / `transform` / `stream` という3層の AsyncGenerator プロトコルによって実現されている。プロバイダ固有の差異を `_streamResponseChunks` テンプレートメソッドで吸収し、上位レイヤーには型安全なチャンクの `concat` プロトコルで合成可能性を保証するという設計は、大規模プラグインアーキテクチャにおけるストリーミング統一パターンとして注目に値する。

## 背景にある原則

- **Additive Chunk Protocol（加算的チャンク合成）**: ストリーミングチャンクは `.concat()` メソッドで合成可能でなければならない。`GenerationChunk.concat()`, `AIMessageChunk.concat()`, `ChatGenerationChunk.concat()` がすべて同じ契約を満たす。これにより、途中結果の蓄積とストリーム完了後の最終出力構築が統一的に行える（`libs/langchain-core/src/outputs.ts:41-49`, `libs/langchain-core/src/messages/ai.ts:393-441`）。

- **AsyncGenerator を一級市民として扱う**: チェーン内の各ステップは `transform(generator)` メソッドで前段の AsyncGenerator を受け取り、自身の AsyncGenerator を返す。これにより、ストリーミングがパイプラインの端から端まで途切れずに流れる。バッファリングが必要な場合のみ `_streamIterator` のデフォルト実装（`invoke` して1チャンクを yield）にフォールバックする（`libs/langchain-core/src/runnables/base.ts:297-302, 655-671`）。

- **Opt-in Streaming with Graceful Fallback**: ストリーミング未対応のコンポーネントでもシステムが壊れない。`_streamResponseChunks` のデフォルト実装は例外を投げるが、`_streamIterator` がプロトタイプ比較（`this._streamResponseChunks === BaseChatModel.prototype._streamResponseChunks`）で未オーバーライドを検出し、`invoke` にフォールバックする（`libs/langchain-core/src/language_models/chat_models.ts:303-308`）。

- **Dual-purpose Execution（暗黙的ストリーミング昇格）**: `invoke()` が呼ばれた場合でも、`streamEvents` や `streamLog` のコールバックハンドラが登録されていれば、内部的にストリーミングモードへ自動昇格する。`callbackHandlerPrefersStreaming` フラグでこれを判定し、ユーザーが明示的に `stream()` を呼ばなくてもトレーシングの粒度を確保する（`libs/langchain-core/src/language_models/chat_models.ts:472-484`）。

## 実例と分析

### AsyncGenerator テンプレートメソッドパターン

プロバイダ統合の要は `_streamResponseChunks` という AsyncGenerator メソッドである。全プロバイダ（Anthropic, OpenAI, Google, AWS Bedrock, Ollama, Mistral, Groq, Cohere, Cloudflare 等）が同一シグネチャを実装する:

```typescript
async *_streamResponseChunks(
  messages: BaseMessage[],
  options: this["ParsedCallOptions"],
  runManager?: CallbackManagerForLLMRun
): AsyncGenerator<ChatGenerationChunk>
```

各プロバイダの実装パターンは共通している: (1) SDK のストリームを `for await...of` で消費、(2) プロバイダ固有のイベントを `ChatGenerationChunk` に変換、(3) `yield` でチャンクを返す、(4) `runManager?.handleLLMNewToken()` でコールバック通知。

### IterableReadableStream: Web Streams と AsyncIterator の統合

`IterableReadableStream` は `ReadableStream` を拡張し、`[Symbol.asyncIterator]()` と `[Symbol.asyncDispose]()` を実装するブリッジクラスである。Node.js の `for await...of` と Web Streams API の両方で消費できる。

特筆すべきは `fromAsyncGenerator` のバグ修正コメント:

```typescript
// Fix: `else if (value)` will hang the streaming when nullish value (e.g. empty string) is pulled
controller.enqueue(value);
```

空文字列のチャンクでもストリームがハングしないよう、falsy チェックを除去している（`libs/langchain-core/src/utils/stream.ts:114-116`）。

### RunnableSequence のストリーミングパイプライン

`RunnableSequence._streamIterator` は、各ステップの `transform()` を連鎖的に接続してストリーミングパイプラインを構築する:

```typescript
let finalGenerator = steps[0].transform(inputGenerator(), config);
for (let i = 1; i < steps.length; i += 1) {
  finalGenerator = await step.transform(finalGenerator, config);
}
```

各ステップが前段の AsyncGenerator を入力として受け取り、変換済みの AsyncGenerator を返す。最終的に1つのジェネレータチェーンになり、消費側が `next()` を呼ぶたびにパイプライン全体が1チャンク分だけ進む（`libs/langchain-core/src/runnables/base.ts:2032-2049`）。

### RunnableMap の並列ストリーミング

`RunnableMap._transform` は `atee()` で入力ジェネレータを複製し、各ブランチを並列実行して `Promise.race` で最初に利用可能になったチャンクから順に yield する:

```typescript
while (tasks.size) {
  const { key, result, gen } = await Promise.race(tasks.values());
  if (!result.done) {
    yield { [key]: result.value };
    tasks.set(key, gen.next().then(...));
  }
}
```

これにより、並列ブランチのうち最も速いものから順にチャンクが届く（`libs/langchain-core/src/runnables/base.ts:2285-2299`）。

### AsyncGeneratorWithSetup: 初期化とストリーミングの分離

`AsyncGeneratorWithSetup` は、ジェネレータの最初の `next()` 呼び出しをトリガーにセットアップ処理を実行する仕組み。パイプライン接続時の論理的な順序保証（前段の入力が利用可能になってから後段を初期化）を実現する:

```typescript
this.firstResult = params.generator.next();
if (params.startSetup) {
  this.firstResult.then(params.startSetup).then(resolve, reject);
}
```

`stream()` メソッドでは `wrappedGenerator.setup` を await することで、最初のチャンクが利用可能になるまで待機し、初期エラーを即座にキャッチする（`libs/langchain-core/src/utils/stream.ts:201-231`）。

## コード例

```typescript
// libs/langchain-core/src/runnables/base.ts:297-323
// Runnable 基底クラスのストリーミング3層構造

// レイヤー1: _streamIterator（サブクラスがオーバーライド）
async *_streamIterator(
  input: RunInput,
  options?: Partial<CallOptions>
): AsyncGenerator<RunOutput> {
  yield this.invoke(input, options);  // デフォルト: invoke にフォールバック
}

// レイヤー2: stream（_streamIterator を IterableReadableStream に変換）
async stream(
  input: RunInput,
  options?: Partial<CallOptions>
): Promise<IterableReadableStream<RunOutput>> {
  const config = ensureConfig(options);
  const wrappedGenerator = new AsyncGeneratorWithSetup({
    generator: this._streamIterator(input, config),
    config,
  });
  await wrappedGenerator.setup;
  return IterableReadableStream.fromAsyncGenerator(wrappedGenerator);
}
```

```typescript
// libs/langchain-core/src/utils/stream.ts:106-121
// AsyncGenerator から IterableReadableStream への変換

static fromAsyncGenerator<T>(generator: AsyncGenerator<T>) {
  return new IterableReadableStream<T>({
    async pull(controller) {
      const { value, done } = await generator.next();
      if (done) {
        controller.close();
      }
      // Fix: `else if (value)` will hang the streaming when nullish value
      controller.enqueue(value);
    },
    async cancel(reason) {
      await generator.return(reason);
    },
  });
}
```

```typescript
// libs/providers/langchain-anthropic/src/chat_models.ts:1252-1324
// プロバイダ実装の典型パターン（Anthropic）

async *_streamResponseChunks(
  messages: BaseMessage[],
  options: this["ParsedCallOptions"],
  runManager?: CallbackManagerForLLMRun
): AsyncGenerator<ChatGenerationChunk> {
  const params = this.invocationParams(options);
  // ... パラメータ構築 ...
  const stream = await this.createStreamWithRetry(payload, { /* ... */ });

  for await (const data of stream) {
    if (options.signal?.aborted) {
      stream.controller.abort();
      return;
    }
    const result = _makeMessageChunkFromAnthropicEvent(data, { /* ... */ });
    if (!result) continue;

    const generationChunk = new ChatGenerationChunk({ /* ... */ });
    yield generationChunk;

    await runManager?.handleLLMNewToken(token ?? "", /* ... */, { chunk: generationChunk });
  }
}
```

```typescript
// libs/langchain-core/src/utils/stream.ts:124-146
// atee: AsyncGenerator を N 個に複製するユーティリティ

export function atee<T>(
  iter: AsyncGenerator<T>,
  length = 2,
): AsyncGenerator<T>[] {
  const buffers = Array.from(
    { length },
    () => [] as Array<IteratorResult<T>>,
  );
  return buffers.map(async function* makeIter(buffer) {
    while (true) {
      if (buffer.length === 0) {
        const result = await iter.next();
        for (const buffer of buffers) {
          buffer.push(result);
        }
      } else if (buffer[0].done) {
        return;
      } else {
        yield buffer.shift()!.value;
      }
    }
  });
}
```

## パターンカタログ

- **Template Method** (分類: 振る舞い)
  - 解決する問題: 多数のプロバイダがストリーミングの共通フロー（コールバック管理、チャンク蓄積、エラーハンドリング）を重複実装する問題
  - 適用条件: 共通のストリーミングフロー（前処理→ストリーム消費→後処理）を持つが、プロバイダ固有のストリーム生成ロジックが異なる場合
  - コード例: `libs/langchain-core/src/language_models/chat_models.ts:298-406`（`_streamIterator` がテンプレート、`_streamResponseChunks` がフック）
  - 注意点: プロトタイプ比較（`this._streamResponseChunks === BaseChatModel.prototype._streamResponseChunks`）でオーバーライド有無を検出するため、動的 mixin では動作しない

- **Iterator / Generator Pipeline** (分類: 振る舞い)
  - 解決する問題: 複数の変換ステップをメモリ効率よく直列接続する
  - 適用条件: データが逐次的に流れ、各ステップが入力チャンクを出力チャンクに変換する場合
  - コード例: `libs/langchain-core/src/runnables/base.ts:2032-2049`（`RunnableSequence._streamIterator`）
  - 注意点: バッファリングなしのため、遅いステップがパイプライン全体を制約する（backpressure が暗黙的に効く）

- **Adapter** (分類: 構造)
  - 解決する問題: Web Streams API と AsyncIterator プロトコルの互換性
  - 適用条件: ブラウザ（ReadableStream）と Node.js（AsyncIterator）の両方をサポートする必要がある場合
  - コード例: `libs/langchain-core/src/utils/stream.ts:15-121`（`IterableReadableStream`）
  - 注意点: `getReader()` のロック管理が必要。エラー時・完了時に `releaseLock()` を確実に呼ぶこと

- **Observer / Callback Integration** (分類: 振る舞い)
  - 解決する問題: ストリーミングとイベント通知（トレーシング、ログ）の統合
  - 適用条件: ストリーミングチャンクの到着をフック可能にし、外部のオブザーバビリティシステムと統合する場合
  - コード例: `libs/langchain-core/src/tracers/event_stream.ts:246-323`（`tapOutputIterable`）
  - 注意点: 二重タップを防止するために `tappedPromises` Map で初回タップを排他制御している

## Good Patterns

- **チャンク型とメッセージ型の分離**: `ChatGenerationChunk`（ストリーミング用）と `ChatGeneration`（バッチ用）を型レベルで分離しつつ、`concat()` でチャンク型同士を合成して最終的に同等の結果を得られる設計。ストリーム消費側は型で安全にチャンクを扱える。

```typescript
// libs/langchain-core/src/outputs.ts:91-100
concat(chunk: ChatGenerationChunk) {
  return new ChatGenerationChunk({
    text: this.text + chunk.text,
    generationInfo: {
      ...this.generationInfo,
      ...chunk.generationInfo,
    },
    message: this.message.concat(chunk.message),
  });
}
```

- **AbortSignal の一貫したチェーン伝播**: ストリーミングループ内で `options.signal?.aborted` を毎チャンクごとにチェックし、プロバイダの内部ストリームも `stream.controller.abort()` で停止する。`raceWithSignal` ユーティリティで Promise ベースの処理にも AbortSignal を統合。

```typescript
// libs/providers/langchain-anthropic/src/chat_models.ts:1287-1289
for await (const data of stream) {
  if (options.signal?.aborted) {
    stream.controller.abort();
    return;
  }
  // ...
}
```

- **暗黙的ストリーミング昇格**: `invoke()` 経由でもストリーミングコールバックハンドラがあれば自動的にストリーミングモードに切り替える。`lc_prefer_streaming` フラグを持つコールバックハンドラが存在するかで判定する。これにより `streamEvents` API がトレーシング粒度を常に確保できる。

```typescript
// libs/langchain-core/src/language_models/chat_models.ts:475-484
const hasStreamingHandler = !!runManagers?.[0].handlers.find(
  callbackHandlerPrefersStreaming,
);
if (
  hasStreamingHandler && !this.disableStreaming && baseMessages.length === 1
  && this._streamResponseChunks !== BaseChatModel.prototype._streamResponseChunks
) {
  // invoke 内部でもストリーミングを使用
}
```

- **テスト用の FakeStreamingChatModel**: `chunks` 配列を指定すると、それをそのまま yield するストリーミングモック。テストで実プロバイダに依存せずにストリーミング動作を検証できる。

```typescript
// libs/langchain-core/src/utils/testing/chat_models.ts:225-246
if (this.chunks?.length) {
  for (const msgChunk of this.chunks) {
    const cg = new ChatGenerationChunk({ /* ... */ });
    if (options.signal?.aborted) break;
    yield cg;
    await runManager?.handleLLMNewToken(/* ... */);
  }
  return;
}
```

## Anti-Patterns / 注意点

- **ReadableStream の falsy チェックによるストリームハング**: `IterableReadableStream.fromAsyncGenerator` で、以前 `else if (value)` と書かれていたため空文字列やゼロなどの falsy なチャンクでストリームがハングする問題があった。

```typescript
// Bad: falsy チェックで空文字チャンクを飲み込む
async pull(controller) {
  const { value, done } = await generator.next();
  if (done) {
    controller.close();
  } else if (value) {  // 空文字列 "" は falsy
    controller.enqueue(value);
  }
  // 空チャンクが来ると pull が何もせずに戻り、次の pull を永遠に待つ
}

// Better: 無条件で enqueue する
async pull(controller) {
  const { value, done } = await generator.next();
  if (done) {
    controller.close();
  }
  controller.enqueue(value);  // done でない限り常に enqueue
}
```

- **runManager コールバック呼び忘れ**: `_streamResponseChunks` で `yield` した後に `runManager?.handleLLMNewToken()` を呼ばないと、`streamEvents` / `streamLog` がそのチャンクを捕捉できない。全プロバイダ実装で `yield` の直後に `handleLLMNewToken` を呼ぶ規約がある。

```typescript
// Bad: yield のみでコールバック通知なし
for await (const data of stream) {
  const chunk = convertToChunk(data);
  yield chunk;
  // runManager?.handleLLMNewToken() が欠落
}

// Better: yield の直後にコールバック通知
for await (const data of stream) {
  const chunk = convertToChunk(data);
  yield chunk;
  await runManager?.handleLLMNewToken(
    chunk.text ?? "",
    undefined, undefined, undefined, undefined,
    { chunk }
  );
}
```

- **AbortSignal チェックの欠落**: ストリーミングループ内で `signal.aborted` をチェックしないと、ユーザーがキャンセルしてもプロバイダ側のストリームを最後まで消費してしまう。ネットワークコストと応答性の両方に影響する。

```typescript
// Bad: abort チェックなし
for await (const data of stream) {
  yield convertToChunk(data);
}

// Better: 毎イテレーションで abort をチェック
for await (const data of stream) {
  if (options.signal?.aborted) {
    stream.controller.abort();
    return;
  }
  yield convertToChunk(data);
}
```

## 導出ルール

- `[MUST]` ストリーミングチャンク型には `.concat()` メソッドを実装し、任意の2チャンクを合成して最終出力と等価な結果を得られるようにする
  - 根拠: langchainjs では `GenerationChunk`, `AIMessageChunk`, `ChatGenerationChunk` がすべて `concat()` を持ち、`_streamIterator` / `_transformStreamWithConfig` 内で蓄積に使われる（`libs/langchain-core/src/outputs.ts:41-100`）

- `[MUST]` AsyncGenerator ベースのストリーミングループでは、各イテレーションで AbortSignal の状態をチェックし、中断時はリソース（ネットワークストリーム等）を明示的にクリーンアップする
  - 根拠: 全プロバイダ実装で `options.signal?.aborted` を毎チャンクチェックし、Anthropic では `stream.controller.abort()` を呼んでいる（`libs/providers/langchain-anthropic/src/chat_models.ts:1287-1289`）

- `[MUST]` AsyncGenerator を ReadableStream に変換する際、falsy な値（空文字列、0、null）でも `enqueue` する。truthy チェックはストリームのハングを引き起こす
  - 根拠: `IterableReadableStream.fromAsyncGenerator` のバグ修正コメントで明記されている（`libs/langchain-core/src/utils/stream.ts:114`）

- `[SHOULD]` ストリーミング未対応のコンポーネントは `invoke` 結果を単一チャンクとして yield するフォールバック `_streamIterator` を持たせ、ストリーミングパイプラインを壊さない
  - 根拠: `Runnable._streamIterator` のデフォルト実装が `yield this.invoke(input, options)` で 1 チャンクのみ yield する設計（`libs/langchain-core/src/runnables/base.ts:297-302`）

- `[SHOULD]` AsyncGenerator パイプラインでは各ステップの `transform(generator)` メソッドでジェネレータをチェーンし、バッファリングは最小限にする。これにより backpressure が自然に効き、メモリ使用量が抑制される
  - 根拠: `RunnableSequence._streamIterator` が `transform` チェーンでパイプラインを構成し、pull-based でチャンクが流れる（`libs/langchain-core/src/runnables/base.ts:2032-2049`）

- `[SHOULD]` `stream()` メソッドは最初のチャンクが利用可能になるまで待機してから返す。これにより初期化エラーを呼び出し元で即座にキャッチできる
  - 根拠: `AsyncGeneratorWithSetup` の `setup` Promise を `await` してから `IterableReadableStream` を返す設計（`libs/langchain-core/src/runnables/base.ts:310-323`）

- `[SHOULD]` `invoke()` 経由の呼び出しでも、ストリーミング対応のコールバックハンドラが登録されていれば内部的にストリーミングモードへ昇格する仕組みを設ける。トレーシングやオブザーバビリティの粒度を常に確保できる
  - 根拠: `_generateUncached` が `callbackHandlerPrefersStreaming` をチェックし、暗黙的にストリーミングに昇格する（`libs/langchain-core/src/language_models/chat_models.ts:472-484`）

- `[AVOID]` ストリーミングチャンクの `yield` 後にコールバック通知を忘れること。イベントストリーミング（`streamEvents`）やトレーシングがチャンクを捕捉できなくなる
  - 根拠: 全プロバイダで `yield generationChunk` の直後に `runManager?.handleLLMNewToken()` を呼ぶ規約が徹底されている

## 適用チェックリスト

- [ ] ストリーミングチャンク型に `.concat()` メソッドが実装されており、任意の2チャンクの合成結果が最終出力と等価であることを検証したか
- [ ] AsyncGenerator ベースのストリーミングで、各イテレーションで AbortSignal をチェックしているか
- [ ] ReadableStream 変換時に falsy なチャンク値（空文字列、0）を意図せず除外していないか
- [ ] ストリーミング未対応コンポーネントが `invoke` フォールバックで 1 チャンクを yield する仕組みを持っているか
- [ ] パイプラインの各ステップが `transform(generator)` パターンで接続され、不必要なバッファリングが発生していないか
- [ ] `stream()` の返却前に最初のチャンクの利用可能性を確認し、初期化エラーを早期に伝播しているか
- [ ] チャンクを yield した直後にオブザーバビリティ用のコールバック通知を発行しているか
- [ ] テストで `FakeStreamingChatModel` のようなモックを使い、実プロバイダに依存せずストリーミング動作を検証しているか
