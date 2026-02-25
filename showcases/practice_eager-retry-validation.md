# Practice: Eager Retry Validation

> 出典: [repos/cloudflare/agents/error-handling-idioms](../repos/cloudflare/agents/error-handling-idioms.md)
> カテゴリ: practice

## 概要

リトライ設定を登録時（enqueue/schedule 時）に即座にバリデーションし、「数分後のアラーム実行時に初めて設定エラーが発覚する」事態を防ぐ Eager Validation パターン。`tryN` という単一リトライ基盤にすべてのサブシステムを集約し、バックオフ計算・バリデーション・`shouldRetry` 判定の一貫性を保つ。さらに `onError` フック呼び出しを二重 try-catch で囲むことで、エラーハンドリング自体の例外がシステム全体に波及することを封じ込める。

## 背景・文脈

Cloudflare Agents SDK（`cloudflare/agents`）は Workers ランタイム上の Durable Objects で動作する AI エージェント基盤である。キュー処理、スケジュール実行、MCP サーバー接続、ワークフロー操作など複数のサブシステムがリトライを必要とするが、以下の制約がある:

- **ハイバネーション**: Durable Objects はアイドル時にメモリを解放される。リトライ設定をインメモリに保持すると再起動時に失われる
- **遅延実行**: `schedule()` で登録したタスクは数分から数時間後にアラーム経由で実行される。設定ミスがその時点まで検出されないと、原因の特定が極めて困難になる
- **サブシステムの多様性**: キュー、スケジュール、MCP 接続、ワークフローの各サブシステムが独自にリトライループを実装すると、バックオフ戦略やエラー判定のばらつきが生まれる

これらの制約に対して、Cloudflare Agents SDK は「設定は即座に検証、実行はリトライ」「リトライ基盤の単一化」「onError の二重封じ込め」という 3 つの原則を組み合わせて解決している。

## 実装パターン

### パターン 1: Eager Validation（登録時の即座検証）

リトライ設定のバリデーションは `queue()` / `schedule()` / `this.retry()` の呼び出し時点で行う。デフォルト値と解決した後にクロスフィールド制約をチェックすることで、暗黙のデフォルトとの矛盾も検出する。

```typescript
// packages/agents/src/retries.ts:32-66
export function validateRetryOptions(
  options: RetryOptions,
  defaults: Required<RetryOptions>,
): void {
  const maxAttempts = options.maxAttempts ?? defaults.maxAttempts;
  const baseDelayMs = options.baseDelayMs ?? defaults.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? defaults.maxDelayMs;

  if (maxAttempts < 1) {
    throw new Error("maxAttempts must be >= 1");
  }
  if (baseDelayMs < 0) {
    throw new Error("baseDelayMs must be >= 0");
  }
  if (maxDelayMs < 0) {
    throw new Error("maxDelayMs must be >= 0");
  }
  if (baseDelayMs > maxDelayMs) {
    // { baseDelayMs: 5000 } がデフォルト maxDelayMs: 3000 と矛盾するケースを検出
    throw new Error(
      `baseDelayMs (${baseDelayMs}) must be <= maxDelayMs (${maxDelayMs})`,
    );
  }
}
```

呼び出し側では、タスク登録の API 内で即座にバリデーションを実行する:

```typescript
// packages/agents/src/index.ts:1813-1815
if (options?.retry) {
  validateRetryOptions(options.retry, this._resolvedOptions.retry);
}
```

### パターン 2: tryN 単一リトライ基盤

すべてのサブシステム（キュー、スケジュール、ワークフロー、MCP 接続、`this.retry()`）が独自のリトライループを持たず、`tryN` を共通で呼び出す。

```typescript
// packages/agents/src/retries.ts:96-140
export async function tryN<T>(
  n: number,
  fn: (attempt: number) => Promise<T>,
  options?: TryNOptions,
): Promise<T> {
  // ... validation ...
  let attempt = 1;
  while (true) {
    try {
      return await fn(attempt);
    } catch (err) {
      const nextAttempt = attempt + 1;
      if (
        nextAttempt > n
        || (options?.shouldRetry && !options.shouldRetry(err, nextAttempt))
      ) {
        throw err;
      }
      const delay = jitterBackoff(attempt, baseDelayMs, maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
      attempt = nextAttempt;
    }
  }
}
```

バックオフは Full Jitter 方式で、サンダリングハード問題（多数のクライアントが同時にリトライ）を緩和する:

```typescript
// packages/agents/src/retries.ts:78-85
export function jitterBackoff(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const exponential = baseDelayMs * Math.pow(2, attempt - 1);
  const capped = Math.min(exponential, maxDelayMs);
  return Math.random() * capped; // Full Jitter: [0, capped) の一様分布
}
```

### パターン 3: 二重 try-catch による onError 封じ込め

`onError` はユーザーがオーバーライド可能なフックであり、その実装が例外を投げる可能性がある。内部処理では `onError` 呼び出しを空の catch で囲み、フック自体の例外がシステムに波及することを防ぐ。

```typescript
// packages/agents/src/index.ts:1901-1910 (_flushQueue 内)
} catch (e) {
  console.error(
    `queue callback "${row.callback}" failed after ${maxAttempts} attempts`,
    e
  );
  try {
    await this.onError(e);
  } catch {
    // swallow onError errors
  }
} finally {
  await this.dequeue(row.id);
}
```

このパターンはコードベースの 3 箇所で一貫して適用されている:

- `_flushQueue`（キュー処理: `src/index.ts:1906-1909`）
- スケジュールアラームハンドラ（`src/index.ts:2432-2435`）
- state 変更フック（`src/index.ts:1267-1270`）

## Good Example

### リトライ設定の即座検証でデフォルト値との矛盾を検出する

```typescript
// Good: 登録時に即座にバリデーション
class TaskScheduler {
  private defaultRetry = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 3000 };

  async enqueue(task: Task, options?: { retry?: RetryOptions; }): Promise<void> {
    if (options?.retry) {
      // デフォルト値とマージした上でクロスフィールド制約をチェック
      validateRetryOptions(options.retry, this.defaultRetry);
    }
    // バリデーション通過後にのみ永続化
    await this.store.insert(task, options?.retry);
  }
}

// 呼び出し側: 設定ミスが即座に検出される
await scheduler.enqueue(task, { retry: { baseDelayMs: 5000 } });
// → Error: baseDelayMs (5000) must be <= maxDelayMs (3000)
// 数分後のアラーム実行時ではなく、この時点で判明する
```

### リトライの各試行にイベントを発火して観測可能にする

```typescript
// packages/agents/src/index.ts:1875-1891 (_flushQueue 内)
if (attempt > 1) {
  this.observability?.emit({
    type: "queue:retry",
    payload: { callback: row.callback, id: row.id, attempt, maxAttempts },
    // ...
  }, this.ctx);
}
```

初回試行（`attempt === 1`）はリトライではないためイベントを発火しない。リトライ回数・対象・試行番号が外部から監視可能になり、問題の早期発見につながる。

### エラー種別に応じたリトライ除外判定

```typescript
// packages/agents/src/retries.ts:148-159
function isErrorRetryable(err: unknown): boolean {
  if (
    typeof err === "object" && err !== null
    && "retryable" in err && (err as { retryable: boolean; }).retryable
    && "overloaded" in err && (err as { overloaded: boolean; }).overloaded
  ) {
    // Durable Object の overload エラーはリトライすると輻輳が悪化する
    return false;
  }
  return true; // デフォルトはリトライ可能
}
```

全エラーを一律リトライするのではなく、バックプレッシャー系エラー（overload、429 等）を除外することで輻輳の悪化を防ぐ。

## Bad Example

### リトライ設定を実行時まで検証しない

```typescript
// Bad: 設定をそのまま保存し、実行時に初めて検証する
async enqueue(task: Task, retryOptions?: RetryOptions): Promise<void> {
  // バリデーションなしで永続化
  await this.store.insert(task, retryOptions);
}

async executeFromQueue(row: QueueRow): Promise<void> {
  const opts = JSON.parse(row.retry_options);
  // 数分〜数時間後にここで初めてエラーが発覚
  if (opts.baseDelayMs > opts.maxDelayMs) {
    throw new Error("Invalid retry config"); // 原因特定が困難
  }
  await tryN(opts.maxAttempts, () => this[row.callback](), opts);
}
```

問題点: `schedule()` 呼び出しから実行までに数分から数時間の遅延がある場合、登録時のコールスタックが失われており、なぜ不正な設定が保存されたのか追跡できない。

### サブシステムごとに独自のリトライループを実装する

```typescript
// Bad: キュー処理とスケジュール実行で異なるリトライ実装
class Agent {
  async _flushQueue(row: QueueRow): Promise<void> {
    for (let i = 0; i < row.maxAttempts; i++) {
      try {
        await this[row.callback]();
        return;
      } catch {
        // 独自のバックオフ計算（jitter なし）
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
      }
    }
  }

  async _executeSchedule(row: ScheduleRow): Promise<void> {
    let attempts = 0;
    while (attempts < row.maxAttempts) {
      try {
        await this[row.callback]();
        return;
      } catch {
        attempts++;
        // また別のバックオフ計算（上限なし）
        await new Promise(r => setTimeout(r, 500 * attempts));
      }
    }
  }
}
```

問題点: バックオフ戦略の不一致（jitter の有無、上限値の違い）、`shouldRetry` 判定の欠如、バリデーションロジックの重複が発生する。一方のバグ修正がもう一方に反映されない。

### onError フック自体の例外を考慮しない

```typescript
// Bad: onError の例外がシステム全体に波及する
async _flushQueue(row: QueueRow): Promise<void> {
  try {
    await tryN(row.maxAttempts, () => this[row.callback]());
  } catch (e) {
    console.error(`queue callback failed`, e);
    await this.onError(e); // onError が throw すると dequeue されない!
    await this.dequeue(row.id);
  }
}
// ユーザーが onError 内で throw すると、dequeue() が実行されず
// 同じタスクが無限に再実行される
```

問題点: `onError` の例外で `finally` / `dequeue` がスキップされると、失敗タスクがキューに残り続け、次回のアラームで再実行されるループに陥る。

## 適用ガイド

### どのような状況で使うべきか

- **遅延実行システム**: キュー、スケジューラ、cron ジョブなど、タスク登録と実行の間にタイムラグがあるシステム。設定ミスの検出が遅れるほどデバッグコストが上がる
- **複数サブシステムがリトライを必要とする場合**: キュー処理、外部 API 呼び出し、DB 操作など、2 つ以上のサブシステムでリトライロジックが必要なら、単一基盤への集約を検討する
- **ユーザー拡張可能なエラーフック**: `onError` のようにユーザーがオーバーライドできるフックがある場合、フック自体の例外封じ込めが必要

### 導入時の注意点

1. **デフォルト値とのクロスフィールド検証**: `{ baseDelayMs: 5000 }` のようにユーザーが一部だけ指定した場合、デフォルト値（`maxDelayMs: 3000`）とマージした後にチェックしないと矛盾を見逃す。バリデーション関数にはデフォルト値のセットも渡す設計にする
2. **`tryN` vs `tryWhile` の選択**: cloudflare/agents の設計ドキュメント（`design/retries.md`）では、条件ベースの `tryWhile` を採用しなかった理由として「バグがあると無限リトライになる」点を挙げている。回数上限付きの `tryN` の方が安全側に倒れる
3. **`setTimeout` によるブロッキング**: `tryN` のリトライ待機は `setTimeout` でイベントループをブロックする。キュー処理内でリトライすると後続アイテムが head-of-line blocking を受ける。長いバックオフが必要な場合はキューレベルのリトライではなくコールバック内の `this.retry()` を使う
4. **overload エラーのリトライ除外**: バックプレッシャー系エラー（Durable Objects の `overloaded: true`、HTTP 429 等）をリトライすると輻輳が悪化する。`shouldRetry` プレディケートで明示的に除外する

### カスタマイズポイント

- **`shouldRetry` プレディケートの拡張**: エラーの種別（ネットワーク一時障害、認証失敗、レート制限等）ごとにリトライ可否を制御する。デフォルトは全リトライ、特定エラーのみ除外する方式が安全
- **バックオフ戦略の選択**: Full Jitter（`Math.random() * capped`）がサンダリングハード緩和に最も効果的だが、デバッグ時には Decorrelated Jitter や固定遅延に切り替えると再現性が上がる
- **リトライ設定の永続化**: サーバーレス環境ではリトライ設定をタスクと一緒にデータストア（SQLite, Redis 等）に保存する。cloudflare/agents では `retry_options TEXT` カラムに JSON として格納している
- **観測可能性イベント**: リトライの各試行で `queue:retry` / `schedule:retry` 等のイベントを発火し、外部モニタリングシステムからリトライ挙動を可視化できるようにする

## 参考

- [repos/cloudflare/agents/error-handling-idioms.md](../repos/cloudflare/agents/error-handling-idioms.md) -- エラーハンドリングイディオムの全体分析（リトライ基盤、MCP エラー分類、onError 階層）
