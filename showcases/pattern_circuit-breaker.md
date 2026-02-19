# Pattern: Circuit Breaker

> 出典: [repos/openclaw/openclaw](../repos/openclaw/openclaw/)
> カテゴリ: pattern

## 概要

外部サービス呼び出しの連続失敗を検知し、一時的に呼び出しを遮断することで障害の伝播を防ぐ Circuit Breaker パターンの TypeScript 実装。OpenClaw のエンベディング処理では、バッチ API の失敗回数を追跡し、閾値を超えると自動的にフォールバックへ切り替え、成功時に回路を復旧する仕組みが実装されている。リトライ・フォールバック・エラー型設計と組み合わせることで、長時間稼働するサービスの可用性を確保できる。

## 背景・文脈

OpenClaw はマルチチャネル AI ゲートウェイであり、LLM プロバイダー・エンベディング API・メッセージング API など多数の外部サービスと統合している。これらのサービスは一時的な障害（ネットワークエラー、レート制限、タイムアウト）を起こしうるが、全機能の停止は許容できない。

エンベディング処理では、バッチ API が高速だが不安定な場合がある。バッチ API が連続して失敗するとき、毎回タイムアウトを待つのはリソースの浪費になる。そこで失敗回数が閾値（`BATCH_FAILURE_LIMIT = 2`）を超えるとバッチ API を動的に無効化し、即座に個別処理フォールバックへ切り替える。成功すれば失敗カウンタをリセットし、バッチ API を再有効化する。

この「Closed -> Open -> Half-Open」の状態遷移は、Martin Fowler の Circuit Breaker パターンの軽量な実装である。

## 実装パターン

### 1. 状態管理: 失敗カウントと有効フラグ

Circuit Breaker の状態は `enabled` フラグと失敗カウンタで表現する。閾値を超えると `enabled = false`（Open 状態）に遷移する。

```typescript
// src/memory/manager-embedding-ops.ts:600-633 (概略)
private batch = { enabled: true };

private async recordBatchFailure(provider: string): Promise<void> {
  const count = await this.incrementFailureCount(provider);
  if (count >= BATCH_FAILURE_LIMIT) {
    this.batch.enabled = false;
    // ログ出力: バッチ API を無効化した旨を記録
  }
}

private async resetBatchFailureCount(): Promise<void> {
  await this.setFailureCount(0);
  this.batch.enabled = true;
}
```

### 2. フォールバック付き実行ロジック

呼び出しのたびに `enabled` をチェックし、Open 状態ならバッチ API をスキップしてフォールバックを即座に実行する。成功時にカウンタをリセットすることで Half-Open -> Closed 遷移を実現する。

```typescript
// src/memory/manager-embedding-ops.ts:660-691
private async runBatchWithFallback<T>(params: {
  provider: string;
  run: () => Promise<T>;
  fallback: () => Promise<number[][]>;
}): Promise<T | number[][]> {
  // Open 状態: バッチを試行せずフォールバック
  if (!this.batch.enabled) {
    return await params.fallback();
  }
  try {
    // Closed 状態: バッチ API を試行
    const result = await this.runBatchWithTimeoutRetry({
      provider: params.provider,
      run: params.run,
    });
    // 成功 -> カウンタリセット (Closed 状態を維持)
    await this.resetBatchFailureCount();
    return result;
  } catch (err) {
    // 失敗 -> カウンタ加算 (閾値超過で Open に遷移)
    await this.recordBatchFailure(params.provider);
    return await params.fallback();
  }
}
```

### 3. リトライとの組み合わせ

Circuit Breaker はリトライの外側に配置する。リトライは一時的エラーへの対処であり、Circuit Breaker はリトライしても回復しない持続的障害への対処である。

```typescript
// src/infra/retry.ts (概略) + src/memory/manager-embedding-ops.ts
// リトライ -> タイムアウトリトライ -> Circuit Breaker -> フォールバック
private async runBatchWithTimeoutRetry(params: {
  provider: string;
  run: () => Promise<T>;
}): Promise<T> {
  return retryAsync(params.run, {
    shouldRetry: (err) => isTimeoutError(err),
    retryAfterMs: () => BATCH_TIMEOUT_RETRY_DELAY,
    maxRetries: 1,
  });
}
```

### 4. エラー型によるリトライ対象の選別

`shouldRetry` コールバックでリトライ対象のエラーを制限する。認証エラーや不正リクエストはリトライせず、レート制限やタイムアウトのみリトライする。

```typescript
// src/discord/api.ts:126-135
return retryAsync(
  async () => {/* fetch logic */},
  {
    ...retryConfig,
    label: options?.label ?? path,
    shouldRetry: (err) => err instanceof DiscordApiError && err.status === 429,
    retryAfterMs: (err) =>
      err instanceof DiscordApiError && typeof err.retryAfter === "number"
        ? err.retryAfter * 1000
        : undefined,
  },
);
```

### 5. エラーの構造化と分類

Circuit Breaker が正しく機能するには、エラーを構造化データとして分類できることが前提となる。文字列リテラル union 型のエラーコードにより、catch 側がエラーの性質を文字列解析なしに判別できる。

```typescript
// src/agents/failover-error.ts:37-39
export function isFailoverError(err: unknown): err is FailoverError {
  return err instanceof FailoverError;
}

// src/agents/failover-error.ts:205-234
export function coerceToFailoverError(
  err: unknown,
  context?: { provider?: string; model?: string; },
): FailoverError | null {
  if (isFailoverError(err)) return err;
  const reason = resolveFailoverReasonFromError(err);
  if (!reason) return null;
  // ... ドメインエラーへ変換
}
```

## Good Example

```typescript
// 汎用 Circuit Breaker の実装例（OpenClaw のパターンを抽出・汎化）

type CircuitState = "closed" | "open" | "half-open";

interface CircuitBreakerOptions {
  failureThreshold: number; // Open に遷移する失敗回数
  resetTimeoutMs: number; // Open -> Half-Open までの待機時間
  shouldTrip?: (err: unknown) => boolean; // 遮断対象のエラーを選別
}

class CircuitBreaker<T> {
  private state: CircuitState = "closed";
  private failureCount = 0;
  private lastFailureTime = 0;
  private readonly options: Required<CircuitBreakerOptions>;

  constructor(options: CircuitBreakerOptions) {
    this.options = {
      shouldTrip: () => true,
      ...options,
    };
  }

  async execute(
    primary: () => Promise<T>,
    fallback: () => Promise<T>,
  ): Promise<T> {
    // Open 状態: タイムアウト経過なら Half-Open に遷移
    if (this.state === "open") {
      if (Date.now() - this.lastFailureTime >= this.options.resetTimeoutMs) {
        this.state = "half-open";
      } else {
        return await fallback();
      }
    }

    try {
      const result = await primary();
      // 成功 -> Closed に復帰
      this.failureCount = 0;
      this.state = "closed";
      return result;
    } catch (err) {
      if (!this.options.shouldTrip(err)) {
        throw err; // 遮断対象外のエラーはそのまま伝播
      }
      this.failureCount += 1;
      this.lastFailureTime = Date.now();
      if (this.failureCount >= this.options.failureThreshold) {
        this.state = "open";
      }
      return await fallback();
    }
  }

  getState(): CircuitState {
    return this.state;
  }
}

// 使用例: エンベディング API のバッチ処理
const embeddingBreaker = new CircuitBreaker<number[][]>({
  failureThreshold: 2,
  resetTimeoutMs: 60_000,
  shouldTrip: (err) => isTimeoutError(err) || isRateLimitError(err),
});

const embeddings = await embeddingBreaker.execute(
  () => batchEmbedApi(texts), // 高速だが不安定
  () => individualEmbedApi(texts), // 低速だが安定
);
```

## Bad Example

```typescript
// Bad 1: フォールバックなしのリトライのみ -- 持続的障害で無限ループ
async function getEmbeddings(texts: string[]): Promise<number[][]> {
  for (let i = 0; i < 10; i++) {
    try {
      return await batchEmbedApi(texts);
    } catch {
      await sleep(1000 * i); // 障害が持続する場合、10回分のタイムアウトを浪費
    }
  }
  throw new Error("All retries failed");
}

// Bad 2: 状態管理なし -- 毎回失敗するAPIを呼び続ける
async function getEmbeddingsWithFallback(texts: string[]): Promise<number[][]> {
  try {
    return await batchEmbedApi(texts); // APIが落ちていても毎回タイムアウトまで待つ
  } catch {
    return await individualEmbedApi(texts);
  }
}

// Bad 3: 回復パスのない Circuit Breaker -- 一度開くと永久にフォールバック
let batchDisabled = false;
async function getEmbeddingsBroken(texts: string[]): Promise<number[][]> {
  if (batchDisabled) {
    return await individualEmbedApi(texts);
  }
  try {
    return await batchEmbedApi(texts);
  } catch {
    batchDisabled = true; // 二度と batchEmbedApi を試行しない
    return await individualEmbedApi(texts);
  }
}

// Bad 4: 全エラーで遮断 -- 認証エラーでも Circuit Breaker が開く
const breaker = new CircuitBreaker({
  failureThreshold: 3,
  resetTimeoutMs: 60_000,
  // shouldTrip を指定しない -> 認証エラーや不正リクエストでも遮断される
  // 結果: 設定ミスが Circuit Breaker で隠蔽される
});
```

## 適用ガイド

### どのような状況で使うべきか

- 外部 API（LLM、エンベディング、決済、メール送信等）への呼び出しが一時的に利用不能になりうる場合
- 高速パス（バッチ API）と低速パス（個別 API）など、品質の異なる代替手段がある場合
- 長時間稼働するサービス（ゲートウェイ、ワーカー）で、部分的な機能劣化を許容できる場合
- リトライだけでは対処できない持続的障害（数分〜数時間の API ダウン）が想定される場合

### 導入時の注意点

- **回復パスを必ず用意する**: OpenClaw では `resetBatchFailureCount` が成功時にカウンタをリセットする。回復パスがないと一度 Open になると永久にフォールバックのまま固定される
- **遮断対象のエラーを選別する**: `shouldTrip` で一時的障害（タイムアウト、レート制限）のみを対象にする。認証エラーや不正リクエストは Circuit Breaker ではなく、エラーとしてそのまま伝播すべき
- **リトライとの配置順序**: リトライは Circuit Breaker の内側に配置する。リトライで回復しない障害のみが Circuit Breaker に到達する設計にする
- **メトリクスを収集する**: 状態遷移（Closed -> Open, Open -> Half-Open -> Closed）をログに記録し、障害の頻度と影響を可視化する
- **閾値とタイムアウトはハードコードしない**: 設定から注入可能にし、外部サービスの特性に応じて調整できるようにする

### カスタマイズポイント

- **閾値（failureThreshold）**: 外部サービスの信頼性に応じて調整。不安定なサービスには低い値（2-3）、安定したサービスには高い値（5-10）
- **リセットタイムアウト（resetTimeoutMs）**: 外部サービスの復旧速度に応じて設定。短すぎると Half-Open での失敗が頻発し、長すぎると復旧後もフォールバックが続く
- **Half-Open 戦略**: OpenClaw の実装では次回の成功で即座に Closed に戻る。より慎重な実装では、Half-Open 中の成功回数が閾値に達するまで Closed に戻さない方法もある
- **失敗カウンタの永続化**: OpenClaw ではカウンタをメモリに保持するが、プロセス再起動をまたいで状態を維持する必要がある場合は SQLite や Redis に永続化する

## 参考

- [repos/openclaw/openclaw/performance-techniques.md](../repos/openclaw/openclaw/performance-techniques.md) -- Circuit Breaker、多層フォールバック、Worker Pool の分析
- [repos/openclaw/openclaw/error-handling-idioms.md](../repos/openclaw/openclaw/error-handling-idioms.md) -- エラー型設計、リトライ戦略、エラー変換パターンの分析
- [repos/openclaw/openclaw/concurrency-patterns.md](../repos/openclaw/openclaw/concurrency-patterns.md) -- リトライ、レーンベース並列化、グレースフルシャットダウンの分析
