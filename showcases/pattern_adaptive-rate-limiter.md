# Pattern: Adaptive Rate Limiter

> 出典: [repos/promptfoo/promptfoo](../repos/promptfoo/promptfoo/)
> カテゴリ: pattern

## 概要

AIMD（Additive Increase / Multiplicative Decrease）風の適応的並列度制御パターン。API レスポンスヘッダから残クォータを自動学習し、「残量 10% 未満でプロアクティブ削減 → 429 で即時半減 → 5 連続成功で 1.5 倍回復」の 3 層で並列度を自動調整する。ユーザにレートリミット値を手動設定させず、ゼロコンフィグで外部 API のレートリミットに適応できる点が最大の価値である。

## 背景・文脈

promptfoo は 100 以上の LLM プロバイダ（OpenAI, Anthropic, Google 等）に対して評価リクエストを大量に並列実行するツールである。プロバイダごとにレートリミットが異なり、同一プロバイダでも API キーやプランによって上限が変わる。固定の並列度設定では、低すぎればスループットが出ず、高すぎれば 429 エラーの嵐になる。この問題を、TCP 輻輳制御に着想を得た適応的並列度調整で解決している。

スケジューラは以下の 4 つのコンポーネントで構成される:

1. **AdaptiveConcurrency** -- 並列度の増減ロジック（AIMD 風アルゴリズム）
2. **SlotQueue** -- FIFO キュー付きセマフォ（クォータ管理統合）
3. **HeaderParser** -- マルチプロバイダ対応のレートリミットヘッダ解析
4. **ProviderRateLimitState** -- 上記 3 つを統合し、リトライとメトリクスを管理

## 実装パターン

### 1. AdaptiveConcurrency: 3 層の並列度調整

TCP 輻輳制御の AIMD に類似するが、増加側も乗算的（1.5 倍）であり、プロアクティブ削減を含む 3 層構造が特徴。

```typescript
// src/scheduler/adaptiveConcurrency.ts:1-142
const BACKOFF_FACTOR = 0.5; // 429 で半減
const RECOVERY_FACTOR = 1.5; // 回復時 1.5 倍
const RECOVERY_THRESHOLD = 5; // 回復に必要な連続成功数
const WARNING_THRESHOLD = 0.1; // 残量 10% で先制削減

export class AdaptiveConcurrency {
  private current: number;
  private readonly initial: number;
  private readonly min: number;
  private consecutiveSuccesses = 0;

  // Layer 1: プロアクティブ削減 -- 残量比率に応じた線形スケーリング
  // 残量 10% → 60% に削減、5% → 40%、1% → 24%
  recordApproachingLimit(ratio: number): ConcurrencyChangeResult {
    const clampedRatio = Math.max(0, Math.min(1, ratio));
    if (clampedRatio >= WARNING_THRESHOLD || this.current <= this.min) {
      return { changed: false, previous: this.current, current: this.current, reason: "proactive" };
    }
    const previous = this.current;
    const reductionFactor = 0.2 + (clampedRatio / WARNING_THRESHOLD) * 0.4;
    this.current = Math.max(this.min, Math.floor(this.current * reductionFactor));
    return { changed: previous !== this.current, previous, current: this.current, reason: "proactive" };
  }

  // Layer 2: リアクティブバックオフ -- 429 で即時半減
  recordRateLimit(): ConcurrencyChangeResult {
    this.consecutiveSuccesses = 0;
    const previous = this.current;
    this.current = Math.max(this.min, Math.floor(this.current * BACKOFF_FACTOR));
    return { changed: previous !== this.current, previous, current: this.current, reason: "ratelimit" };
  }

  // Layer 3: 段階的回復 -- 5 連続成功で 1.5 倍（初期値上限）
  // 回復パス: 1 → 2 → 3 → 5 → 8 → 10（合計 25 リクエストで完全回復）
  recordSuccess(): ConcurrencyChangeResult {
    this.consecutiveSuccesses++;
    if (this.consecutiveSuccesses >= RECOVERY_THRESHOLD && this.current < this.initial) {
      const previous = this.current;
      this.current = Math.min(this.initial, Math.ceil(this.current * RECOVERY_FACTOR));
      this.consecutiveSuccesses = 0;
      return { changed: previous !== this.current, previous, current: this.current, reason: "recovery" };
    }
    return { changed: false, previous: this.current, current: this.current, reason: "recovery" };
  }
}
```

### 2. ヘッダからの自動学習

OpenAI / Anthropic / RFC 6585 標準の 3 系統のヘッダを統一的に解析する。リセット時間は数値の桁数で相対秒・Unix 秒・Unix ミリ秒を自動判別する。

```typescript
// src/scheduler/headerParser.ts:47-115
export function parseRateLimitHeaders(headers: Record<string, string>): ParsedRateLimitHeaders {
  const result: ParsedRateLimitHeaders = {};
  const h = lowercaseKeys(headers);

  // OpenAI, Anthropic, Standard の順でフォールバック探索
  result.remainingRequests = parseFirstMatch(h, [
    "x-ratelimit-remaining-requests", // OpenAI
    "anthropic-ratelimit-requests-remaining", // Anthropic
    "x-ratelimit-remaining", // Standard alt
    "ratelimit-remaining", // Standard
  ]);
  // ... tokens, limits, reset time も同様
  return result;
}
```

### 3. 同期的スロット割当

SlotQueue の `processQueue()` は完全に同期で、`await` を一切含まない。容量チェックとスロット確保の間に他の非同期タスクが割り込む余地がなく、競合状態を構造的に排除している。

```typescript
// src/scheduler/slotQueue.ts:247-265
/**
 * Process queued requests up to available capacity.
 * SYNCHRONOUS - no awaits, prevents race conditions.
 */
private processQueue(): void {
  while (
    this.waiting.length > 0 &&
    this.activeCount < this.maxConcurrency &&
    !this.isQuotaExhausted()
  ) {
    const request = this.waiting.shift()!;
    request.resolve();
  }

  // If queue still has items and we're quota exhausted, ensure reset is scheduled
  if (this.waiting.length > 0 && this.isQuotaExhausted()) {
    this.scheduleResetProcessing();
  }
}
```

### 4. Wrapper パターンによる透過的適用

レートリミット制御はプロバイダ実装に侵入せず、Decorator/Wrapper で透過的に適用される。`Symbol.for` による冪等性保証で二重ラッピングを防止する。

```typescript
// src/scheduler/providerWrapper.ts:27,93-125
const WRAPPED_SYMBOL = Symbol.for("promptfoo.rateLimitWrapped");

export function wrapProviderWithRateLimiting(
  provider: ApiProvider,
  registry: RateLimitRegistry,
): ApiProvider {
  if (isRateLimitWrapped(provider)) {
    return provider; // 冪等
  }
  const originalCallApi = provider.callApi.bind(provider);
  const wrappedProvider: ApiProvider = {
    ...provider,
    id: () => provider.id(),
    callApi: async (prompt, context, options) => {
      return registry.execute(
        provider,
        () => originalCallApi(prompt, context, options),
        createProviderRateLimitOptions(),
      );
    },
  };
  (wrappedProvider as WrappedApiProvider)[WRAPPED_SYMBOL] = true;
  return wrappedProvider;
}
```

## Good Example

3 層防御による段階的な並列度制御。429 を踏む前にヘッダ情報で先制削減し、踏んでも即座に半減、回復は慎重に行う。

```typescript
// src/scheduler/providerRateLimitState.ts:262-301
// ヘッダ更新時にプロアクティブ削減を判定
private updateFromHeaders(headers: Record<string, string>, isRateLimited: boolean): void {
  const parsed = parseRateLimitHeaders(headers);
  this.slotQueue.updateRateLimitState(parsed);

  // プロアクティブ削減: 残量比率が 10% を下回ったら並列度を下げる
  const ratios = this.slotQueue.getRemainingRatio();
  const minRatio = Math.min(ratios.requests ?? 1, ratios.tokens ?? 1);
  if (minRatio < WARNING_THRESHOLD) {
    this.applyConcurrencyChange(
      this.adaptiveConcurrency.recordApproachingLimit(minRatio)
    );
  }
}

// 429 ヒット時の即時半減
private handleRateLimit(retryAfterMs?: number): void {
  this.rateLimitHits++;
  this.slotQueue.markRateLimited(retryAfterMs);
  const change = this.adaptiveConcurrency.recordRateLimit(); // 半減
  this.applyConcurrencyChange(change);
}

// 成功時の段階的回復
private handleSuccess(): void {
  this.applyConcurrencyChange(this.adaptiveConcurrency.recordSuccess());
}
```

リトライ遅延にはサーバ指定の Retry-After を優先し、ない場合は指数バックオフ + ジッターでサンダリングハードを防止する。

```typescript
// src/scheduler/retryPolicy.ts:21-39
export function getRetryDelay(
  attempt: number,
  policy: RetryPolicy,
  serverRetryAfterMs?: number,
): number {
  if (serverRetryAfterMs !== undefined && serverRetryAfterMs >= 0) {
    if (serverRetryAfterMs === 0) return 0;
    const jitter = serverRetryAfterMs * policy.jitterFactor * Math.random();
    return Math.min(serverRetryAfterMs + jitter, policy.maxDelayMs);
  }
  const exponentialDelay = policy.baseDelayMs * Math.pow(2, attempt);
  const jitter = exponentialDelay * policy.jitterFactor * Math.random();
  return Math.min(exponentialDelay + jitter, policy.maxDelayMs);
}
```

## Bad Example

固定並列度 + 単純リトライでは、レートリミットに適応できず 429 の嵐か低スループットに陥る。

```typescript
// Bad: 固定並列度 + 固定 sleep のリトライ
async function callApiWithRetry(prompts: string[], concurrency: number) {
  await async.forEachOfLimit(prompts, concurrency, async (prompt) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await callApi(prompt);
      } catch (err) {
        if (err.status === 429) {
          await sleep(5000); // 固定 5 秒待ち -- サーバの Retry-After を無視
        } else {
          throw err; // 認証エラーもリトライ不能エラーも区別なし
        }
      }
    }
  });
}
// 問題点:
// 1. concurrency が固定 -- プロバイダのリミットに適応しない
// 2. Retry-After ヘッダを無視 -- 待ちすぎ or 待たなさすぎ
// 3. 残クォータを見ていない -- 429 を踏むまで全速力で送り続ける
// 4. 全エラーを同じ扱い -- 認証エラーでも 3 回リトライしてしまう
// 5. ジッターなし -- 複数クライアントが同時にリトライ（サンダリングハード）
```

## 適用ガイド

### どのような状況で使うべきか

- 外部 API を並列で大量呼び出しする場面（LLM, SaaS API, データパイプライン等）
- プロバイダのレートリミットが動的に変わる or 事前に把握できない場面
- 複数のプロバイダ/API キーを同時に使い、それぞれに独立したレートリミットがある場面

### 導入時の注意点

- **スロット割当は同期的に行う**: `processQueue()` に `await` を入れると競合状態が発生する。容量チェックとカウンタ更新の間に非同期処理を挟まないこと
- **dispose を忘れない**: EventEmitter のリスナーとタイマーは明示的に解除する。`removeAllListeners()` + `clearTimeout()` + 待機中 Promise の reject が必要
- **リトライ層の重複に注意**: HTTP クライアントのトランスポート層リトライとアプリケーション層リトライが同時に発動すると、意図しない N x M 回のリトライになる。内側の層で `disableTransientRetries: true` のようなフラグを渡して制御する
- **並列度制御の状態をシングルトンにしない**: 評価コンテキスト（バッチジョブ等）ごとにインスタンスを分離し、状態の漏れを防ぐ

### カスタマイズポイント

| パラメータ           | デフォルト | 調整指針                                       |
| -------------------- | ---------- | ---------------------------------------------- |
| `BACKOFF_FACTOR`     | 0.5        | 429 時の削減率。厳しい API では 0.3 等に下げる |
| `RECOVERY_FACTOR`    | 1.5        | 回復時の増加率。保守的にするなら 1.2           |
| `RECOVERY_THRESHOLD` | 5          | 回復に必要な連続成功数。慎重にするなら 10      |
| `WARNING_THRESHOLD`  | 0.1        | プロアクティブ削減の閾値。余裕を持つなら 0.2   |
| `maxRetries`         | 3          | リトライ上限。長時間バッチなら 5 に増やす      |
| `jitterFactor`       | 0.2        | ジッター係数。クライアント数が多いなら 0.5     |

## 参考

- [repos/promptfoo/promptfoo/concurrency-patterns.md](../repos/promptfoo/promptfoo/concurrency-patterns.md) -- 並列度制御パターンの包括的分析
- [repos/promptfoo/promptfoo/error-handling-idioms.md](../repos/promptfoo/promptfoo/error-handling-idioms.md) -- リトライポリシーとエラー分類の分析
