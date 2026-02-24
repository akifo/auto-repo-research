# error-handling-idioms

> リポジトリ: promptfoo/promptfoo
> 分析日: 2026-02-21

## 概要

100 以上の LLM プロバイダを統合する promptfoo は、プロバイダエラー・レートリミット・タイムアウト・一時的障害といった多様な障害モードに対して一貫したエラーハンドリング戦略を採用している。特に注目すべきは、(1) プロバイダが例外を throw せず `{ error: string }` で返す Return-based Error パターン、(2) レスポンスヘッダを解析して動的に並行数を調整するアダプティブスケジューラ、(3) 一時的エラーと永続的エラーを厳密に分類するリトライポリシーの 3 層構造である。大量の API コールを並行実行する評価ツールという性質上、1 つのプロバイダの障害が全体を巻き込まないグレースフルデグレデーションの設計が随所に見られる。

## 背景にある原則

- **Fail-open / 部分的成功を許容する**: LLM プロバイダのエラーは他のテストケースの実行を止めるべきではない。エラーは結果オブジェクトの一部として伝播させ、呼び出し側が集約・判断する。100+ プロバイダの統合では「一部失敗しても全体は進む」が大前提となる（`src/redteam/commands/generate.ts:99-105` の `--strict` フラグによるオプトイン厳密モード）。

- **レートリミットはエラーではなく状態である**: 429 レスポンスは「失敗」ではなく「まだ処理できない」という一時的状態として扱う。レスポンスヘッダから残数・リセット時刻を学習し、プロアクティブにスロットリングする仕組みが構築されている（`src/scheduler/` 全体）。

- **一時的エラーと永続的エラーを分離する**: TLS 設定ミスや認証エラーでリトライしても無駄である。一方、ソケットリセットや Bad Gateway は再試行すれば成功する可能性が高い。この分類を明示的に行い、リトライ対象を制限することで無駄な待機を排除する（`src/util/fetch/errors.ts:16-47`）。

- **構造化エラーで境界を越える**: モジュール間のエラー伝播には `code` + `statusCode` + `details` を持つ型付きエラークラスを使い、catch 側が `instanceof` で分岐できるようにする。ただしプロバイダ境界では throw ではなく戻り値ベースのエラー表現を使い分ける。

## 実例と分析

### 1. Return-based Error: プロバイダは throw しない

promptfoo の全プロバイダは `callApi()` で例外を throw する代わりに `{ error: string }` を返す。この設計により、evaluator は try-catch なしで全プロバイダの結果を統一的に処理でき、1 つのプロバイダ障害が他のテストケースに波及しない。

```typescript
// src/providers/anthropic/completion.ts:78-84
try {
  response = await this.anthropic.completions.create(params);
} catch (err) {
  return {
    error: `API call error: ${String(err)}`,
  };
}
```

この `{ error: string }` パターンは OpenAI, Google, Bedrock, HuggingFace 等、全プロバイダで一貫している。`ProviderResponse.error` は `string | undefined` 型であり、エラーがなければ `output` フィールドに結果が入る二択の設計（`src/types/providers.ts:145-148`）。

### 2. 階層的エラー型: MCP 境界の構造化

MCP サーバーでは `McpError` 抽象基底クラスから派生した階層的エラー型を定義し、HTTP ステータスコード・エラーコード・詳細情報を構造化している。

```typescript
// src/commands/mcp/lib/errors.ts:4-23
export abstract class McpError extends Error {
  abstract readonly code: string;
  abstract readonly statusCode: number;
  public readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}
```

派生クラスとして `ValidationError` (400), `NotFoundError` (404), `RateLimitError` (429), `TimeoutError` (408), `AuthenticationError` (401) 等を定義。`toMcpError()` コンバータが未知のエラーをメッセージパターンマッチで適切な型に変換する（`src/commands/mcp/lib/errors.ts:152-192`）。

### 3. 3 層リトライアーキテクチャ

リトライロジックは 3 層に分離されている:

**Layer 1: HTTP トランスポート層** (`src/util/fetch/index.ts:200-224`) -- 502/503/504/524 の一時的エラーを statusText と照合してリトライ。exponential backoff (1s, 2s, 4s)。

```typescript
// src/util/fetch/index.ts:309-326
export function isTransientError(response: Response): boolean {
  if (!response?.statusText) {
    return false;
  }
  const statusText = response.statusText.toLowerCase();
  switch (response.status) {
    case 502:
      return statusText.includes("bad gateway");
    case 503:
      return statusText.includes("service unavailable");
    case 504:
      return statusText.includes("gateway timeout");
    case 524: // Cloudflare-specific timeout error
      return statusText.includes("timeout");
    default:
      return false;
  }
}
```

**Layer 2: レートリミット対応リトライ** (`src/util/fetch/index.ts:333-399`) -- `fetchWithRetries` が 429 検出時にレスポンスヘッダから待機時間を計算。OpenAI 固有ヘッダ (`x-ratelimit-reset-requests`, `x-ratelimit-reset-tokens`) も対応。

**Layer 3: スケジューラ層** (`src/scheduler/providerRateLimitState.ts:127-253`) -- プロバイダ単位のスロット管理・適応的並行数制御・キュー管理を行う。Layer 1/2 と重複リトライしないよう `disableTransientRetries: true` を渡す設計。

### 4. 一時的エラー vs 永続的エラーの厳密な分類

```typescript
// src/util/fetch/errors.ts:16-47
export function isTransientConnectionError(error: Error | undefined): boolean {
  if (!error) {
    return false;
  }
  const code = (error as SystemError).code;
  if (code === "ECONNRESET" || code === "EPIPE") {
    return true;
  }
  const message = (error.message ?? "").toLowerCase();
  // EPROTO can wrap permanent TLS misconfigs. Exclude when paired with
  // known permanent error phrases to avoid futile retries.
  if (
    message.includes("eproto")
    && (message.includes("wrong version number")
      || message.includes("self signed")
      || message.includes("unable to verify")
      || message.includes("unknown ca")
      || message.includes("cert"))
  ) {
    return false;
  }
  return (
    message.includes("bad record mac")
    || message.includes("eproto")
    || message.includes("econnreset")
    || message.includes("socket hang up")
  );
}
```

`EPROTO` を一律リトライ対象にせず、TLS 設定ミス（`self signed`, `wrong version number` 等）を除外している点が重要。これにより永続的な設定ミスで無限リトライすることを防ぐ。

### 5. アダプティブ並行数制御

レートリミットに対して固定のバックオフではなく、残りクォータに応じてリアルタイムに並行数を調整する。

```typescript
// src/scheduler/adaptiveConcurrency.ts:75-87
recordRateLimit(): ConcurrencyChangeResult {
  this.consecutiveSuccesses = 0;
  const previous = this.current;
  this.current = Math.max(this.min, Math.floor(this.current * BACKOFF_FACTOR));
  // ...
}
```

- 429 ヒット時: 並行数を即座に半減（`BACKOFF_FACTOR = 0.5`）
- 残クォータ 10% 未満: プロアクティブに並行数を削減（`WARNING_THRESHOLD = 0.1`）
- 5 回連続成功後: 並行数を 50% 増加（`RECOVERY_FACTOR = 1.5`）、初期値上限まで回復

### 6. マルチプロバイダ対応のヘッダパーサ

OpenAI・Anthropic・RFC 6585 標準の 3 系統のレートリミットヘッダを統一的に解析する。

```typescript
// src/scheduler/headerParser.ts:47-115
export function parseRateLimitHeaders(
  headers: Record<string, string>,
): ParsedRateLimitHeaders {
  const result: ParsedRateLimitHeaders = {};
  const h = lowercaseKeys(headers);
  // OpenAI, Anthropic, Standard の順で探索
  result.remainingRequests = parseFirstMatch(h, [
    OPENAI_HEADERS.remainingRequests,
    ANTHROPIC_HEADERS.remainingRequests,
    STANDARD_HEADERS.remainingAlt,
    STANDARD_HEADERS.remaining,
  ]);
  // ...
}
```

リセット時間のパースでは、数値の桁数で相対秒・Unix秒・Unixミリ秒を自動判別し、`"1m30s"` のようなduration文字列やHTTP-date形式もサポートしている（`src/scheduler/headerParser.ts:155-185`）。

### 7. 認証エラーのショートサーキット

認証エラーはリトライしても回復しないため、即座に throw して上位に伝播させる。

```typescript
// src/providers/elevenlabs/client.ts:97-99
// Don't retry on authentication errors
if (error instanceof ElevenLabsAuthError) {
  throw error;
}
```

この「認証エラーはリトライしない」パターンは `shouldRetry()` 関数でも一貫しており、rate limit と transient error のみがリトライ対象として列挙されている（`src/scheduler/retryPolicy.ts:45-79`）。

## パターンカタログ

- **Circuit Breaker 変形** (振る舞い)
  - 解決する問題: レートリミットヒット時に全リクエストが 429 を浴びて待機時間が膨張する
  - 適用条件: 複数のリクエストが同一プロバイダに並行で送られる場面
  - コード例: `src/scheduler/slotQueue.ts:199-225` の `isQuotaExhausted()` + `markRateLimited()`
  - 注意点: 古典的な Circuit Breaker と異なり、open/half-open/closed の 3 状態ではなく、残クォータとリセット時刻による連続的な制御

- **Sentinel Error** (振る舞い)
  - 解決する問題: リトライループ内で「リトライ上限に達した rate limit」を通常エラーと区別する
  - 適用条件: catch ブロックでスロットの二重解放や二重カウントを防ぐ必要がある場面
  - コード例: `src/scheduler/providerRateLimitState.ts:16-21` の `RateLimitExhaustedError`
  - 注意点: 内部制御用であり、外部に公開すべきではない

## Good Patterns

- **Return-based Error at Provider Boundary**: プロバイダの `callApi()` は例外を throw せず `{ error: string }` を返す。これにより evaluator は `Promise.all` 等で並行実行しても 1 つの失敗が他を巻き込まない。`ProviderResponse` 型の `error` フィールドが契約として機能する。

```typescript
// src/providers/openai/chat.ts:525-538
} catch (err) {
  logger.error(`API call error: ${String(err)}`);
  return {
    error: `API call error: ${String(err)}`,
    metadata: {
      http: {
        status: 0,
        statusText: 'Error',
        headers: responseHeaders ?? {},
      },
    },
  };
}
```

- **Header-driven Proactive Throttling**: 429 を受けてから対処するのではなく、`remaining` ヘッダの残量を監視して閾値以下になったらプロアクティブに並行数を下げる。レートリミットを「踏む前に避ける」戦略。

```typescript
// src/scheduler/providerRateLimitState.ts:289-301
const ratios = this.slotQueue.getRemainingRatio();
const minRatio = Math.min(ratios.requests ?? 1, ratios.tokens ?? 1);
if (minRatio < WARNING_THRESHOLD) {
  this.emit('ratelimit:warning', { ... });
  this.applyConcurrencyChange(
    this.adaptiveConcurrency.recordApproachingLimit(minRatio)
  );
}
```

- **Jitter in Retry Delay**: リトライ遅延に必ずランダムジッタを加えて Thundering Herd を防止。

```typescript
// src/scheduler/retryPolicy.ts:37-39
const exponentialDelay = policy.baseDelayMs * Math.pow(2, attempt);
const jitter = exponentialDelay * policy.jitterFactor * Math.random();
return Math.min(exponentialDelay + jitter, policy.maxDelayMs);
```

## Anti-Patterns / 注意点

- **statusCode だけでリトライ判定する**: 一部の API は 502 を認証エラーに使うことがある。promptfoo は `status` と `statusText` の両方を検査して誤リトライを防いでいる。

```typescript
// Bad: status だけで判定
if (response.status === 502) retry();

// Better: statusText と組み合わせる (promptfoo の実装)
case 502:
  return statusText.includes('bad gateway');
```

- **EPROTO を一律リトライ対象にする**: `EPROTO` エラーには一時的な TLS セッション破損と永続的な TLS 設定ミスが含まれる。区別せずリトライすると、自己署名証明書エラー等で無限に待つ。

```typescript
// Bad: EPROTO を常にリトライ
if (message.includes("eproto")) return true;

// Better: 永続的な TLS エラーを除外 (promptfoo の実装)
if (
  message.includes("eproto")
  && (message.includes("wrong version number")
    || message.includes("self signed"))
) {
  return false;
}
```

- **リトライ層の重複**: `fetchWithProxy` のトランスポート層リトライと `fetchWithRetries` のアプリケーション層リトライが同時に発動すると、意図しない 9 回リトライ (3 x 3) になりうる。promptfoo は内側の呼び出しで `disableTransientRetries: true` を明示して制御している（`src/util/fetch/index.ts:348-352`）。

## 導出ルール

- `[MUST]` プロバイダ境界（外部 API 呼び出し）では例外を throw せず、エラー情報を戻り値の `error` フィールドで返す
  - 根拠: promptfoo の全 50+ プロバイダが `{ error: string }` パターンで統一されており、evaluator が try-catch なしで並行処理できる（`src/types/providers.ts:148`）

- `[MUST]` リトライ対象を一時的エラーに厳密に限定し、認証エラー・設定ミス等の永続的エラーはリトライしない
  - 根拠: `isTransientConnectionError()` が TLS 設定ミスを明示的に除外し、`shouldRetry()` が rate limit と transient error のみを対象としている（`src/util/fetch/errors.ts:30-39`）

- `[MUST]` 複数のリトライ層が存在する場合、内側の層でリトライを無効化して二重リトライを防止する
  - 根拠: `fetchWithRetries` が `fetchWithTimeout` を `disableTransientRetries: true` で呼び出し、トランスポート層のリトライと重複しない設計（`src/util/fetch/index.ts:348-352`）

- `[SHOULD]` リトライ遅延には exponential backoff + ランダムジッタを組み合わせ、サーバ指定の Retry-After を優先する
  - 根拠: `getRetryDelay()` がサーバ指定値を優先しつつジッタを加え、指定がない場合は exponential backoff にフォールバック（`src/scheduler/retryPolicy.ts:21-39`）

- `[SHOULD]` レートリミットのレスポンスヘッダを解析し、残クォータに基づいてプロアクティブに並行数を調整する
  - 根拠: `AdaptiveConcurrency` が残量 10% 未満で並行数を削減し、429 を踏む前に自律的にスロットリングする（`src/scheduler/adaptiveConcurrency.ts:100-129`）

- `[SHOULD]` エラー階層には `code` (機械可読) + `statusCode` (HTTP 互換) + `details` (構造化メタデータ) を持たせ、`toJSON()` でシリアライズ可能にする
  - 根拠: `McpError` 基底クラスが `toJSON()` を実装し、`toMcpError()` コンバータが未知のエラーを適切な派生型に変換する（`src/commands/mcp/lib/errors.ts:4-23, 152-192`）

- `[AVOID]` HTTP ステータスコードだけで一時的エラーとリトライ対象を判定する。ステータスコードに加えて statusText やエラーメッセージの内容を検証する
  - 根拠: `isTransientError()` は status と statusText の両方を検査し、一部 API が 502 を永続的エラーに使うケースを除外する（`src/util/fetch/index.ts:309-326`）

## 適用チェックリスト

- [ ] 外部 API プロバイダの `callApi()` 相当メソッドが、例外を throw せず `{ error: string }` 形式で返すようになっているか
- [ ] リトライロジックが一時的エラー（ECONNRESET, 502 Bad Gateway 等）と永続的エラー（401, 自己署名証明書等）を区別しているか
- [ ] 複数のリトライ層がある場合、内側の層でリトライを無効化する仕組みがあるか
- [ ] リトライ遅延に exponential backoff とランダムジッタが適用されているか
- [ ] サーバが `Retry-After` ヘッダを返した場合にそれを尊重しているか
- [ ] レートリミットヘッダ（`x-ratelimit-remaining-*` 等）を解析してプロアクティブにスロットリングしているか
- [ ] 認証エラーが即座に上位に伝播され、リトライされないか
- [ ] エラーログに API キーやトークンが含まれないよう、sanitizer が適用されているか
- [ ] 部分的失敗を許容するモード（non-strict）と、厳密に全成功を要求するモード（strict）の切り替えが可能か
