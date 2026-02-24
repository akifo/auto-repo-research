# concurrency-patterns

> リポジトリ: promptfoo/promptfoo
> 分析日: 2026-02-21

## 概要

promptfoo は LLM 評価を大量に並列実行するツールであり、外部 API のレートリミットと内部リソースの並列度制御を両立させる必要がある。本分析では、スロットベースのキュー制御、応答ヘッダからレートリミットを学習する適応的並列度調整、Decorator/Wrapper パターンによる透過的なレートリミット適用、そしてプロセスプール・ブラウザプールによるリソース管理を横断的に調査した。特に、ゼロコンフィグでレートリミットに適応するスケジューラ設計が注目に値する。

## 背景にある原則

- **同期的スロット割当による競合状態の排除**: 並列度制御の要である SlotQueue の `processQueue()` は同期関数として設計されている。容量チェックとスロット確保の間に `await` を挟まないことで、複数の非同期タスクが同時にスロットを確保してしまう競合状態を構造的に防いでいる。(`src/scheduler/slotQueue.ts:251-259`)

- **応答ヘッダからの学習による設定不要化**: ユーザにレートリミット値を手動設定させず、API 応答ヘッダ（OpenAI/Anthropic/標準形式）からリミット情報を自動で抽出・学習する。これにより、プロバイダの変更やリミット改定時にも設定変更が不要になる。(`src/scheduler/headerParser.ts:47-115`)

- **多層的な防御戦略**: レートリミット対策を「プロアクティブ削減（残量 10% 以下で発動）」「リアクティブバックオフ（429 応答で即座に半減）」「段階的回復（5 連続成功で 1.5 倍）」の 3 段階に分離し、単一障害点を作らない。(`src/scheduler/adaptiveConcurrency.ts:46-129`)

- **透過的ラッピングによる関心の分離**: レートリミット制御はプロバイダの呼び出し側（evaluator）やプロバイダ実装自体に侵入せず、Wrapper パターンで透過的に適用される。二重ラッピング防止に `Symbol.for` を使い、モジュールリロード時も安全に動作する。(`src/scheduler/providerWrapper.ts:27-39`)

## 実例と分析

### SlotQueue: Promise ベースの同期的スロット管理

SlotQueue はセマフォに相当するが、単なるカウンタではなく FIFO キューとクォータ管理を統合している。全リクエストは必ずキューを経由し、`processQueue()` が同期的にスロット割当を行う。

注目すべき点は、クォータ枯渇時のスケジュール機能である。`resetAt` を監視し、リセット時刻にタイマーでキュー処理を再開する。これにより、ポーリングなしで正確なタイミングでリクエストを再開できる。

```typescript
// src/scheduler/slotQueue.ts:251-265
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

### AdaptiveConcurrency: AIMD 風の適応的並列度調整

TCP 輻輳制御の AIMD（Additive Increase / Multiplicative Decrease）に類似した戦略を採用している。ただし増加側は乗算的（1.5 倍）であり、閾値の存在によりプロアクティブ削減も行う点が異なる。

回復パス（初期値 10、最小値 1 の場合）:
1 → 2 → 3 → 5 → 8 → 10（各段階で 5 連続成功が必要、合計 25 リクエストで完全回復）

```typescript
// src/scheduler/adaptiveConcurrency.ts:75-87
recordRateLimit(): ConcurrencyChangeResult {
  this.consecutiveSuccesses = 0;
  const previous = this.current;
  this.current = Math.max(this.min, Math.floor(this.current * BACKOFF_FACTOR));
  return { changed: previous !== this.current, previous, current: this.current, reason: 'ratelimit' };
}
```

プロアクティブ削減の線形スケーリング公式:

- 残量 10% → 60% に削減
- 残量 5% → 40% に削減
- 残量 1% → 24% に削減

### RateLimitRegistry: プロバイダごとの独立状態管理

Registry は評価コンテキストごとに生成され（シングルトンではない）、プロバイダキーごとに独立した `ProviderRateLimitState` を管理する。プロバイダキーは `providerId + apiKeyTail + baseUrl + region + organization` のハッシュで生成され、同一プロバイダでも API キーやリージョンが異なればレートリミット状態が分離される。

```typescript
// src/scheduler/rateLimitKey.ts:9-42
export function getRateLimitKey(provider: ApiProvider): string {
  const providerId = provider.id();
  const config = provider.config || {};
  const relevantConfig: Record<string, string> = {};
  if (config.apiKey && config.apiKey.length > 4) {
    relevantConfig.apiKeyTail = config.apiKey.slice(-4);
  }
  // ...region, organization, apiBaseUrl
  if (configParts) {
    return `${providerId}[${hashString(configParts)}]`;
  }
  return providerId;
}
```

### 二重ラッピング防止と統合ポイント

プロバイダは evaluator 内と redteam 内の 2 箇所でレートリミットを適用される可能性がある。`Symbol.for('promptfoo.rateLimitWrapped')` による冪等性保証と、`RedteamProviderManager` へのレジストリ共有により、コードパスが異なっても同一のレートリミット状態を共有する。

```typescript
// src/scheduler/providerWrapper.ts:27,97-100
const WRAPPED_SYMBOL = Symbol.for("promptfoo.rateLimitWrapped");

export function wrapProviderWithRateLimiting(provider, registry) {
  if (isRateLimitWrapped(provider)) {
    return provider; // 冪等
  }
  // ...
}
```

### シリアル/並列のハイブリッド実行

evaluator は `runSerially` フラグでテストケースをシリアルとコンカレントに分離する。シリアル実行は `crossSessionLeak` のように順序依存性があるテストに使われ、コンカレント実行は `async.forEachOfLimit` で制御される。

```typescript
// src/evaluator.ts:1778-1824
for (const evalOption of runEvalOptions) {
  if (evalOption.test.options?.runSerially) {
    serialRunEvalOptions.push(evalOption);
  } else {
    concurrentRunEvalOptions.push(evalOption);
  }
}
// シリアル実行を先に完了してからコンカレント実行
await async.forEachOfLimit(concurrentRunEvalOptions, concurrency, async (evalStep) => {
  // ...
});
```

### リソースプール: ブラウザプールと Python ワーカープール

`ChatKitBrowserPool` はシングルトンブラウザプロセスの上に複数のブラウザコンテキストをプールする。テンプレートキーによるページの分離、アイドルタイマーによる自動シャットダウン、壊れたページの自動再生成を実装している。

`PythonWorkerPool` は固定数のワーカープロセスにリクエストを FIFO で分配する。各ワーカーの完了時にキューを自動ドレインする自己駆動型の設計。

```typescript
// src/python/workerPool.ts:95-116
private processQueue(): void {
  while (this.queue.length > 0) {
    const worker = this.getAvailableWorker();
    if (!worker) return;
    const request = this.queue.shift();
    worker.call(request.functionName, request.args)
      .then(request.resolve)
      .catch(request.reject)
      .finally(() => this.processQueue());  // 自己駆動
  }
}
```

### HTTP 接続プールとレートリミット制御の連動

`undici.Agent` の `connections` パラメータを eval の `maxConcurrency` と連動させ、TCP 接続数がアプリケーション並列度と一致するよう制御する。エージェントはキャッシュされ、並列度変更時に再生成される。

```typescript
// src/util/fetch/index.ts:20-22
// Cached agents to avoid recreating on every request.
// Without caching, concurrent requests race on setGlobalDispatcher(),
// corrupting TLS session state and producing "bad record mac" errors.
```

## パターンカタログ

- **Semaphore / Counting Semaphore** (分類: 振る舞い)
  - 解決する問題: 共有リソースへの同時アクセス数制限
  - 適用条件: 外部 API 呼び出しの並列度を制御する場合
  - コード例: `src/scheduler/slotQueue.ts:28-304`
  - 注意点: SlotQueue は単純なセマフォにクォータ管理とタイマーによるリセットを追加した拡張版

- **Decorator / Wrapper** (分類: 構造)
  - 解決する問題: 既存オブジェクトに透過的に機能を追加
  - 適用条件: プロバイダにレートリミット機能を非侵入的に追加する場合
  - コード例: `src/scheduler/providerWrapper.ts:93-125`
  - 注意点: `Symbol.for` で冪等性を保証し、二重ラッピングを防止

- **Observer / Event Emitter** (分類: 振る舞い)
  - 解決する問題: 状態変化の通知とロギングの分離
  - 適用条件: レートリミット状態の変化をモニタリング・ロギングする場合
  - コード例: `src/scheduler/events.ts:1-103`, `src/scheduler/rateLimitRegistry.ts:103-109`
  - 注意点: イベントの転送チェーン（State → Registry → Evaluator）で dispose 時のリスナー解除が必須

- **Object Pool** (分類: 生成)
  - 解決する問題: 重いリソース（ブラウザ、Python プロセス）の再利用
  - 適用条件: 初期化コストが高く、並列実行数が制限されたリソースの管理
  - コード例: `src/providers/openai/chatkit-pool.ts:46-579`, `src/python/workerPool.ts:11-144`
  - 注意点: 壊れたリソースの検出と自動再生成、アイドル時の自動シャットダウンが重要

## Good Patterns

- **同期 processQueue による競合排除**: `processQueue()` を完全に同期にし、`await` を含まないことで、複数の非同期コールバックが同時にスロットを取得する競合を構造的に排除している。Promise の `resolve()` 呼び出しはマイクロタスクをキューするだけで、実行は現在の同期ブロック完了後になるため安全。

```typescript
// src/scheduler/slotQueue.ts:251-259
// SYNCHRONOUS - no awaits, prevents race conditions.
private processQueue(): void {
  while (
    this.waiting.length > 0 &&
    this.activeCount < this.maxConcurrency &&
    !this.isQuotaExhausted()
  ) {
    const request = this.waiting.shift()!;
    request.resolve();
  }
}
```

- **Sentinel Error による二重カウント防止**: `RateLimitExhaustedError` をセンチネルとして使い、catch ブロックでの二重リリース・二重カウントを防止。通常のエラーハンドリングフローとレートリミット固有のフローを明確に分離している。

```typescript
// src/scheduler/providerRateLimitState.ts:16-21,209-211
class RateLimitExhaustedError extends Error { /* ... */ }
// ...
catch (error) {
  if (error instanceof RateLimitExhaustedError) {
    throw error;  // 二重カウント防止
  }
  // 通常のエラー処理
}
```

- **CircularBuffer による O(1) レイテンシ記録**: 直近 100 件のレイテンシを固定サイズのリングバッファで管理。`Array.shift()` の O(n) を回避し、メトリクス収集のオーバーヘッドを最小化。

```typescript
// src/scheduler/providerRateLimitState.ts:50-79
class CircularBuffer {
  private buffer: number[];
  private head = 0;
  private count = 0;
  constructor(private capacity: number) {
    this.buffer = new Array(capacity);
  }
  push(value: number): void {
    this.buffer[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }
}
```

- **自己駆動型キュー処理**: PythonWorkerPool のキュー処理は、ワーカー完了の `.finally()` から再帰的に `processQueue()` を呼ぶことで、外部からのポーリングやタイマーなしにキューを自動ドレインする。

```typescript
// src/python/workerPool.ts:111-115
worker.call(request.functionName, request.args)
  .then(request.resolve)
  .catch(request.reject)
  .finally(() => this.processQueue()); // 完了時に次を処理
```

## Anti-Patterns / 注意点

- **HTTP エージェントの非キャッシュ**: 並列リクエスト時にエージェントを毎回生成すると、`setGlobalDispatcher()` の競合で TLS セッション状態が壊れ、"bad record mac" エラーが発生する。promptfoo はこの問題を経験しキャッシュで解決した。

```typescript
// Bad: エージェントを毎回作成
async function fetchData(url: string) {
  const agent = new Agent({ connections: 10 });
  return fetch(url, { dispatcher: agent });
}

// Better: エージェントをキャッシュして再利用
let cachedAgent: Agent | null = null;
function getOrCreateAgent(): Agent {
  if (!cachedAgent) {
    cachedAgent = new Agent({ connections: 10 });
  }
  return cachedAgent;
}
```

- **非同期処理を含むスロット割当**: スロットの容量チェックと確保の間に `await` を挟むと、他の非同期タスクが割り込んでオーバーコミットが発生する。

```typescript
// Bad: await を含むスロット割当
async processQueue() {
  if (this.active < this.max) {
    await someCheck();  // この間に別タスクも通過する
    this.active++;
  }
}

// Better: 同期的に割当（SlotQueue の実装）
processQueue(): void {  // async なし
  while (this.waiting.length > 0 && this.active < this.max) {
    this.waiting.shift()!.resolve();
  }
}
```

- **リスナー未解除による EventEmitter メモリリーク**: ProviderRateLimitState はイベントを Registry に転送するが、dispose 時に `removeAllListeners()` を呼ばないとリスナーが累積する。promptfoo は dispose パターンで対処。

## 導出ルール

- `[MUST]` 並列度制御のスロット割当（容量チェック → カウンタ更新）は同期的に行い、間に await を挟まない
  - 根拠: SlotQueue.processQueue() は「SYNCHRONOUS - no awaits, prevents race conditions」とコメントされ、while ループ内に非同期処理を含まない設計 (`src/scheduler/slotQueue.ts:248-259`)

- `[MUST]` EventEmitter ベースの並列制御コンポーネントは dispose メソッドで全リスナーを解除し、タイマーをクリアする
  - 根拠: RateLimitRegistry.dispose() と SlotQueue.dispose() の両方で removeAllListeners/clearTimeout を実行し、キューの残存 Promise も reject している (`src/scheduler/rateLimitRegistry.ts:131-137`, `src/scheduler/slotQueue.ts:292-303`)

- `[SHOULD]` HTTP クライアントの接続プールサイズはアプリケーション並列度と連動させる
  - 根拠: undici Agent の connections パラメータを maxConcurrency と一致させ、接続不足によるスロットリングと過剰接続によるリソース浪費を防止 (`src/util/fetch/index.ts:37-46,77-84`)

- `[SHOULD]` レートリミット対策は「プロアクティブ削減 → リアクティブバックオフ → 段階的回復」の多層構造にする
  - 根拠: AdaptiveConcurrency は残量比率による先制削減、429 応答による即時半減、連続成功による回復の 3 層で構成され、単一戦略より安定したスループットを実現 (`src/scheduler/adaptiveConcurrency.ts:46-129`)

- `[SHOULD]` 外部 API の並列度制御を Wrapper/Decorator パターンで適用し、呼び出し元コードに侵入させない
  - 根拠: providerWrapper.ts が Symbol.for による冪等な Decorator を実装し、evaluator や redteam コードはレートリミットの詳細を意識せず透過的に恩恵を受ける (`src/scheduler/providerWrapper.ts:93-125`)

- `[SHOULD]` リトライ遅延にジッターを加え、サーバ指定の Retry-After を優先する
  - 根拠: retryPolicy.ts は Retry-After ヘッダがあればそれを優先し、ない場合は指数バックオフ + ジッター（係数 0.2）でサンダリングハードを防止 (`src/scheduler/retryPolicy.ts:21-39`)

- `[AVOID]` 並列度制御の状態をシングルトンで共有する（評価コンテキストごとにインスタンスを分離すべき）
  - 根拠: RateLimitRegistry は「NOT a singleton - create one per evaluation context」と明記され、評価間の状態漏れを防止 (`src/scheduler/rateLimitRegistry.ts:18`)

## 適用チェックリスト

- [ ] 外部 API を並列呼び出しする箇所に、スロットベースの並列度制御が実装されているか
- [ ] スロット割当のクリティカルセクション（容量チェック → 確保）が同期的に実行されているか（間に await がないか）
- [ ] レートリミット応答（429/Retry-After）を検出してバックオフするロジックがあるか
- [ ] リトライ遅延にジッターを追加し、サンダリングハードを防止しているか
- [ ] HTTP 接続プールサイズがアプリケーション並列度と連動しているか
- [ ] EventEmitter やタイマーを使う並列制御コンポーネントに dispose/cleanup メソッドがあるか
- [ ] 順序依存性のある処理（セッションリーク検出等）をシリアル実行に分離する仕組みがあるか
- [ ] 重いリソース（ブラウザ、外部プロセス）にオブジェクトプールを適用しているか
- [ ] 並列度制御が呼び出し元に侵入せず、Wrapper/Decorator で透過的に適用されているか
