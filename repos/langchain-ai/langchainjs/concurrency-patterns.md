# concurrency-patterns

> リポジトリ: langchain-ai/langchainjs
> 分析日: 2026-02-20

## 概要

langchainjs におけるバッチ処理・並列実行・レートリミットの制御パターンを分析した。このコードベースは外部 API（LLM・Embedding・VectorStore）への大量リクエストを安全かつ効率的に処理するために、複数レイヤーにわたる並行制御の仕組みを構築している。特に注目に値するのは、`AsyncCaller` による「キュー + リトライ」の一元管理、`Runnable.batch()` による統一バッチインターフェース、そして `Promise.race` を活用した協調的キャンセルの3つである。これらのパターンは LLM アプリケーションに限らず、外部サービスと連携するあらゆるシステムで応用できる。

## 背景にある原則

- **並行制御をインフラ層に集約すべき**: 個々の API 呼び出し側が並行数やリトライを意識すると、ロジックが散在し保守性が下がる。langchainjs は `AsyncCaller` というユーティリティに `p-queue`（並行数制御）と `p-retry`（リトライ）を組み合わせることで、呼び出し側は `caller.call(() => ...)` と書くだけで済むようにしている（`libs/langchain-core/src/utils/async_caller.ts`）。
- **バッチ処理はチャンク分割 + 並列 + 制限の3段階で設計すべき**: 大量データを扱う際、(1) API の上限に合わせたチャンク分割、(2) チャンク単位の並列実行、(3) 並行数の上限制御、という3段階を明示的に分離することで、各段階を独立にチューニングできる。OpenAI Embeddings (`libs/providers/langchain-openai/src/embeddings.ts:163-193`) がこの典型例である。
- **エラーハンドリングは「リトライすべきか否か」の判定を中央に持つべき**: HTTP ステータスコードやエラー種別によるリトライ判定ロジックを各 API クライアントに分散させるのではなく、`defaultFailedAttemptHandler` として一箇所に集約し、必要に応じてオーバーライドさせるのが堅牢である（`async_caller.ts:6-83`）。
- **キャンセルは協調的に伝播すべき**: `AbortSignal` を全レイヤーで受け渡し、`Promise.race` で競合させることで、上位のキャンセル要求が下位の非同期処理に即座に伝播する。`raceWithSignal` ユーティリティ（`libs/langchain-core/src/utils/signal.ts:9-36`）がこのパターンの中核である。

## 実例と分析

### AsyncCaller: 並行制御とリトライの統合ユーティリティ

`AsyncCaller` はコードベース全体で最も広く利用されている並行制御の基盤クラスである。`p-queue` で並行数を制御し、`p-retry` で指数バックオフ付きリトライを行う。Embeddings 基底クラス、VectorStore、Document Loader など約30以上のモジュールで使用されている。

```typescript
// libs/langchain-core/src/utils/async_caller.ts:124-172
export class AsyncCaller {
  constructor(params: AsyncCallerParams) {
    this.maxConcurrency = params.maxConcurrency ?? Infinity;
    this.maxRetries = params.maxRetries ?? 6;
    this.onFailedAttempt = params.onFailedAttempt ?? defaultFailedAttemptHandler;

    const PQueue = (
      "default" in PQueueMod ? PQueueMod.default : PQueueMod
    ) as typeof PQueueMod;
    this.queue = new PQueue({ concurrency: this.maxConcurrency });
  }

  async call<A extends any[], T extends (...args: A) => Promise<any>>(
    callable: T,
    ...args: Parameters<T>
  ): Promise<Awaited<ReturnType<T>>> {
    return this.queue.add(
      () =>
        pRetry(
          () =>
            callable(...args).catch((error) => {
              if (error instanceof Error) {
                throw error;
              } else {
                throw new Error(error);
              }
            }),
          {
            onFailedAttempt: ({ error }) => this.onFailedAttempt?.(error),
            retries: this.maxRetries,
            randomize: true,
          },
        ),
      { throwOnTimeout: true },
    );
  }
}
```

重要な設計判断として、デフォルトの `maxConcurrency` は `Infinity`（制限なし）であり、呼び出し側が必要に応じて制限を設定する「オプトイン」方式を採用している。一方で `maxRetries` のデフォルトは `6` と具体的な値が設定されており、リトライは「やらない方が問題」という判断を反映している。

### プロバイダーごとの maxConcurrency デフォルト値

各プロバイダーが独自のデフォルト値を設定しており、外部 API の特性に応じた使い分けがなされている:

| プロバイダー           | デフォルト並行数 | 根拠                                                              |
| ---------------------- | ---------------- | ----------------------------------------------------------------- |
| OpenAI Embeddings      | 2                | `libs/providers/langchain-openai/src/embeddings.ts:125`           |
| Ollama Embeddings      | 1                | `libs/providers/langchain-ollama/src/embeddings.ts:79`            |
| Cloudflare VectorStore | 6                | `libs/providers/langchain-cloudflare/src/vectorstores.ts:62`      |
| GitHub Loader          | 2                | `libs/langchain-community/src/document_loaders/web/github.ts:164` |
| Cassandra              | 25               | `libs/langchain-community/src/utils/cassandra.ts:535`             |

ローカルサーバー（Ollama）は 1、マネージド API（OpenAI）は 2、データベース（Cassandra）は 25 と、リソースの特性に応じたスケーリングが行われている。

### Runnable.batch(): チャンクではなくキュー方式のバッチ

`Runnable.batch()` はバッチ対象の各入力を `AsyncCaller` 経由で `invoke` を並列呼び出しする方式で実装されている。チャンク分割ではなく、キューの並行制限に委任する設計である。

```typescript
// libs/langchain-core/src/runnables/base.ts:261-289
async batch(
  inputs: RunInput[],
  options?: Partial<CallOptions> | Partial<CallOptions>[],
  batchOptions?: RunnableBatchOptions
): Promise<(RunOutput | Error)[]> {
  const configList = this._getOptionsList(options ?? {}, inputs.length);
  const maxConcurrency =
    configList[0]?.maxConcurrency ?? batchOptions?.maxConcurrency;
  const caller = new AsyncCaller({
    maxConcurrency,
    onFailedAttempt: (e) => {
      throw e;
    },
  });
  const batchCalls = inputs.map((input, i) =>
    caller.call(async () => {
      try {
        const result = await this.invoke(input, configList[i]);
        return result;
      } catch (e) {
        if (batchOptions?.returnExceptions) {
          return e as Error;
        }
        throw e;
      }
    })
  );
  return Promise.all(batchCalls);
}
```

注目すべき点は `onFailedAttempt: (e) => { throw e }` として、batch レベルではリトライを無効化していること。リトライは各 invoke 呼び出しの内部（各プロバイダーの `AsyncCaller` インスタンス）に委ねる設計である。

### returnExceptions パターン: 部分的失敗の許容

`batch()` の `returnExceptions: true` オプションは、`Promise.allSettled` の代替として機能する。一部の入力が失敗しても他の結果を返す。

```typescript
// examples/src/langchain-classic/guides/expression_language/interface_batch_with_options.ts:13-17
const result = await chain.batch(
  [{ topic: "bears" }, { topic: "cats" }],
  { maxConcurrency: 1 },
  { returnExceptions: true },
);
```

`RunnableRetry._batch()` ではこの仕組みをさらに発展させ、失敗した入力のみをリトライする「部分リトライ」を実装している（`base.ts:1726-1793`）。`resultsMap` に成功/失敗を記録し、リトライ時は `Error` が入った要素のみを再実行する。

### RunnableMap: 並列パイプラインの合流

`RunnableMap` は複数の Runnable を並列に実行し、結果をオブジェクトに合流させる。ストリーミング時には `Promise.race` を使ってチャンクが到着した順に yield する。

```typescript
// libs/langchain-core/src/runnables/base.ts:2285-2299
while (tasks.size) {
  const promise = Promise.race(tasks.values());
  const { key, result, gen } = await raceWithSignal(
    promise,
    options?.signal
  );
  tasks.delete(key);
  if (!result.done) {
    yield { [key]: result.value } as unknown as RunOutput;
    tasks.set(
      key,
      gen.next().then((result) => ({ key, gen, result }))
    );
  }
}
```

### チャンク分割 + AsyncCaller: VectorStore のバッチ処理

VectorStore の実装では、API の上限に合わせてデータをチャンク分割し、各チャンクを `AsyncCaller` 経由で並列処理する3段階パターンが一貫して使われている。

```typescript
// libs/providers/langchain-pinecone/src/vectorstores.ts:338-355
const chunkSize = 100;
const chunkedVectors = chunkArray(pineconeVectors, chunkSize);
const batchRequests = chunkedVectors.map((chunk) =>
  this.caller.call(async () => {
    try {
      await namespace.upsert(chunk);
    } catch (e: any) {
      console.error(`Failed to upsert chunk: ${e.message}`);
      throw e;
    }
  })
);
await Promise.all(batchRequests);
```

### コールバックキュー: 非同期副作用の逐次化

トレーシングなどの非同期副作用は `p-queue` で concurrency: 1 のキューに投入される。Fire-and-forget で処理されるが、テスト時やシャットダウン時に `awaitAllCallbacks()` で全完了を待てる。

```typescript
// libs/langchain-core/src/singletons/callbacks.ts:14-19
function createQueue() {
  const PQueue: any = "default" in PQueueMod ? PQueueMod.default : PQueueMod;
  return new PQueue({
    autoStart: true,
    concurrency: 1,
  });
}
```

### AbortSignal の合成と伝播

`timeout` 設定を `AbortSignal.timeout()` に変換し、既存の signal と `AbortSignal.any()` で合成する。これにより、タイムアウトとキャンセルを統一的な `signal` で扱える。

```typescript
// libs/langchain-core/src/runnables/config.ts:175-198
const timeoutSignal = AbortSignal.timeout(originalTimeoutMs);
if (empty.signal !== undefined) {
  if ("any" in AbortSignal) {
    empty.signal = (AbortSignal as any).any([empty.signal, timeoutSignal]);
  }
} else {
  empty.signal = timeoutSignal;
}
delete empty.timeout;
```

`timeout` は正規化後に削除される。これにより、`ensureConfig` が多段で呼ばれてもタイムアウトが重複適用されない冪等性が確保される。

## パターンカタログ

- **Queue-based Throttle** (振る舞い)
  - 解決する問題: 外部 API のレートリミット超過を防ぐ
  - 適用条件: 複数の非同期処理を並行数制限付きで実行したい場面
  - コード例: `libs/langchain-core/src/utils/async_caller.ts:133-143`
  - 注意点: デフォルト `Infinity` なので、明示的に設定しないと無制限並列になる

- **Retry with Exponential Backoff** (振る舞い)
  - 解決する問題: 一時的な障害（ネットワーク、レートリミット）からの自動復旧
  - 適用条件: 冪等な操作（読み取り、または冪等な書き込み）に限定すべき
  - コード例: `libs/langchain-core/src/utils/async_caller.ts:146-172`
  - 注意点: `randomize: true` でジッターを付加して thundering herd を回避

- **Partial Retry** (振る舞い)
  - 解決する問題: バッチ処理で一部だけ失敗した場合に全体を再実行するコスト
  - 適用条件: バッチ内の各要素が独立して成功/失敗する場面
  - コード例: `libs/langchain-core/src/runnables/base.ts:1726-1793`
  - 注意点: `resultsMap` で成功分を保持し、失敗分のみリトライする

- **Cooperative Cancellation via Promise.race** (振る舞い)
  - 解決する問題: 長時間実行の処理を外部からキャンセルする
  - 適用条件: AbortSignal 対応の API と組み合わせる場面
  - コード例: `libs/langchain-core/src/utils/signal.ts:9-36`
  - 注意点: AbortSignal のリスナーを `.finally()` で確実に解除すること

## Good Patterns

- **キュー+リトライの合成クラス**: `AsyncCaller` は並行制限とリトライを1つのクラスに合成し、呼び出し側のコード量を最小化している。VectorStore やEmbeddings で `this.caller.call(() => ...)` と書くだけで並行制御とリトライが適用される。これにより設定漏れが起きにくい。

```typescript
// libs/providers/langchain-ollama/src/embeddings.ts:78-79,162-173
// コンストラクタで maxConcurrency を設定
super({ maxConcurrency: 1, ...fields });

// 呼び出し側は caller.call だけ
private async embeddingWithRetry(texts: string[]): Promise<number[][]> {
  const res = await this.caller.call(() =>
    this.client.embed({ model: this.model, input: texts })
  );
  return res.embeddings;
}
```

- **HTTPステータスによるリトライ判定の一元化**: 4xx（クライアントエラー）はリトライしても無駄なので即座に throw し、5xx と 429（レートリミット）のみリトライする。この判定を `STATUS_NO_RETRY` リストとして中央に定義している。

```typescript
// libs/langchain-core/src/utils/async_caller.ts:6-16
const STATUS_NO_RETRY = [
  400,
  401,
  402,
  403,
  404,
  405,
  406,
  407,
  409,
];
```

- **チャンク分割ユーティリティの共通化**: `chunkArray` を汎用ユーティリティとして切り出し、Embeddings・VectorStore・Document Loader から横断的に使用している。

```typescript
// libs/langchain-core/src/utils/chunk_array.ts:1-7
export const chunkArray = <T>(arr: T[], chunkSize: number) =>
  arr.reduce((chunks, elem, index) => {
    const chunkIndex = Math.floor(index / chunkSize);
    const chunk = chunks[chunkIndex] || [];
    chunks[chunkIndex] = chunk.concat([elem]);
    return chunks;
  }, [] as T[][]);
```

## Anti-Patterns / 注意点

- **maxConcurrency デフォルト Infinity による暗黙の無制限並列**: `AsyncCaller` のデフォルトが `Infinity` であるため、明示的に設定しないとレートリミットに容易に到達する。プロバイダーの Embeddings クラスが独自にデフォルト値を設定している（OpenAI: 2, Ollama: 1）のは、基底クラスのデフォルトが安全でないことの裏返しでもある。

```typescript
// Bad: デフォルトのまま使うとレートリミットに到達しやすい
const caller = new AsyncCaller({});

// Better: 外部 API の特性に応じた適切な並行数を設定
const caller = new AsyncCaller({ maxConcurrency: 2, maxRetries: 6 });
```

- **Promise.all 使用時の部分失敗への無配慮**: `chunkArray` + `Promise.all` でバッチ処理する場合、1つのチャンクが失敗すると全チャンクの結果が失われる。Google GenAI Embeddings は `Promise.allSettled` を使って部分失敗を許容している。

```typescript
// Bad: 1チャンクの失敗で全体が reject
const results = await Promise.all(
  chunks.map((chunk) => this.caller.call(() => api.process(chunk))),
);

// Better: 失敗したチャンクにはフォールバック値を返す
const results = await Promise.allSettled(
  chunks.map((chunk) => api.process(chunk)),
);
const embeddings = results.flatMap((res, idx) => {
  if (res.status === "fulfilled") return res.value;
  return Array(chunks[idx].length).fill([]);
});
```

- **AbortSignal リスナーの解除忘れ**: `Promise.race` で signal を使う場合、`.finally()` でリスナーを確実に解除しないとメモリリークが発生する。`AsyncCaller.callWithOptions` がこの問題に対処する例を示している。

```typescript
// libs/langchain-core/src/utils/async_caller.ts:180-196
return Promise.race([
  this.call<A, T>(callable, ...args),
  new Promise<never>((_, reject) => {
    listener = () => {
      reject(getAbortSignalError(options.signal));
    };
    options.signal?.addEventListener("abort", listener, { once: true });
  }),
]).finally(() => {
  if (options.signal && listener) {
    options.signal.removeEventListener("abort", listener);
  }
});
```

## 導出ルール

- `[MUST]` 外部 API 呼び出しには並行数制限（maxConcurrency）とリトライ（maxRetries + 指数バックオフ）を必ず設定する
  - 根拠: langchainjs の全プロバイダー（Embeddings, VectorStore, Document Loader）が `AsyncCaller` を通じて統一的に設定しており、デフォルト値を持たないプロバイダーは存在しない（`async_caller.ts`, 各プロバイダーの constructor）
- `[MUST]` リトライ判定では 4xx クライアントエラーをリトライ対象から除外し、即座に throw する
  - 根拠: 400/401/403/404 等はリトライしても成功しないため、`STATUS_NO_RETRY` リスト（`async_caller.ts:6-16`）で明示的に除外し、無駄なリトライによるレートリミット消費を防いでいる
- `[SHOULD]` バッチ処理は「チャンク分割 → 各チャンクの並列実行 → 並行数制限」の3段階で構成する
  - 根拠: Pinecone VectorStore（chunkSize: 100）、OpenAI Embeddings（batchSize: 512）など、API の上限に合わせたチャンク分割と `AsyncCaller` による並行数制御を組み合わせるパターンがコードベース全体で一貫して使われている
- `[SHOULD]` 並行制御・リトライ・キャンセルのロジックはインフラ層のユーティリティに集約し、ビジネスロジック側は `caller.call(() => ...)` のように薄いラッパーで呼び出す
  - 根拠: `AsyncCaller` が p-queue と p-retry を内部に隠蔽し、30以上のモジュールから統一的に利用されている。呼び出し側はリトライロジックを一切書かない
- `[SHOULD]` タイムアウトと外部キャンセルは `AbortSignal` に統一し、`Promise.race` で協調的に伝播させる。リスナーは `.finally()` で必ず解除する
  - 根拠: `raceWithSignal`（`signal.ts:9-36`）および `ensureConfig` の timeout→signal 変換（`config.ts:175-198`）でタイムアウトとキャンセルが統一されている
- `[SHOULD]` バッチ処理で部分的な失敗を許容する場合、`returnExceptions` フラグまたは `Promise.allSettled` を使い分ける
  - 根拠: `Runnable.batch()` の `returnExceptions: true` と Google GenAI Embeddings の `Promise.allSettled` が同じ問題を異なるアプローチで解決している
- `[AVOID]` `Promise.all` でバッチ処理する際に、1要素の失敗で全体を失敗させる設計を安易に採用しない
  - 根拠: Google GenAI Embeddings（`langchain-google-genai/src/embeddings.ts:165-177`）が `Promise.allSettled` を使い、失敗チャンクにフォールバック値を返すことで部分失敗を許容している
- `[AVOID]` デフォルトの maxConcurrency を `Infinity` のまま外部 API に接続しない。API の特性に応じた具体的なデフォルト値を設定する
  - 根拠: OpenAI Embeddings（`maxConcurrency: 2`）、Ollama Embeddings（`maxConcurrency: 1`）など、全プロバイダーが基底クラスのデフォルトを上書きしている事実が、`Infinity` のまま使う危険性を示している

## 適用チェックリスト

- [ ] 外部 API を呼び出すモジュールに並行数制限（maxConcurrency）が設定されているか
- [ ] リトライロジックが各呼び出し箇所に散在していないか（ユーティリティに集約されているか）
- [ ] HTTP 4xx エラーがリトライ対象から除外されているか
- [ ] 大量データのバッチ処理で、API の上限に合わせたチャンク分割が行われているか
- [ ] `Promise.all` を使う場面で、部分的な失敗が全体を壊さないか確認したか
- [ ] キャンセル可能な操作に `AbortSignal` が伝播されているか
- [ ] `Promise.race` で `AbortSignal` リスナーを使う場合、`.finally()` で解除しているか
- [ ] fire-and-forget の非同期処理（トレーシング等）が、シャットダウン時に完了を待てるか
