# エラーハンドリングイディオム

> リポジトリ: mastra-ai/mastra
> 分析日: 2026-02-14

## 概要

mastra は AI エージェント・ワークフロー・ツール・外部サービス統合を広範に扱う TypeScript フレームワークであり、エラーが発生する局面が非常に多い。コアのエラー型設計（ドメイン分類付き構造化エラー）、unknown からの安全なエラー変換ユーティリティ、ワークフローのリトライ戦略、ドメインごとのエラー階層設計、LLM 出力のバリデーション多段フォールバックなど、大規模 TypeScript プロジェクトにおけるエラーハンドリングの実践を体系的に観察できる。

## 背景にある原則

- **エラーは構造化データである**: エラーを単なる文字列メッセージではなく、ドメイン・カテゴリ・ID・詳細情報を持つ構造化オブジェクトとして扱うべき。オブザーバビリティ（ログ集約・アラートルーティング）やクライアント側の分岐判定に、機械可読なエラー情報が必要だからである。`MastraBaseError` が `ErrorDomain`（17 種）と `ErrorCategory`（4 種: USER / SYSTEM / THIRD_PARTY / UNKNOWN）の enum を持ち、`toJSON()` で API レスポンスにそのまま使える形式にシリアライズする設計がこの原則を体現している（`packages/core/src/error/index.ts:82-142`）。

- **unknown 型の安全な正規化は基盤が提供する**: JavaScript のランタイムでは `throw` されるものが `Error` とは限らない。外部ライブラリ、LLM プロバイダ、ネットワーク応答などあらゆるソースから非 Error オブジェクトが飛んでくるため、catch 直後に正規化する関数を基盤が提供すべき。`getErrorFromUnknown` がこの責務を担い、cause チェーンの再帰的シリアライズ（深さ制限付き）や `toJSON` の自動付与まで行う（`packages/core/src/error/utils.ts:45-122`）。

- **リトライは呼び出し元の関心であり、呼び出される側が制御すべきではない**: 外部サービス呼び出しのリトライポリシーは呼び出し元（ワークフローエンジン）が決定し、ステップ関数自体はリトライを意識しない。これにより同じステップを内部リトライ（Default エンジン）でも外部リトライ（Inngest エンジン）でも使い回せる（`packages/core/src/workflows/default.ts:380-471`）。

- **バリデーション失敗は再試行可能なエラーとして扱い、多段フォールバックで吸収する**: LLM の出力は仕様通りでないことが常態であるため、一度の検証失敗で即エラーにせず、正規化パイプラインを段階的に適用して救済する。`validateToolInput` の 5 段階パイプラインがこの原則の好例（`packages/core/src/tools/validation.ts:320-397`）。

## 実例と分析

### 1. 構造化エラー型の階層設計

Mastra は 2 つの異なるエラー階層戦略を使い分けている。

**戦略 A: 汎用構造化エラー（`MastraBaseError` → `MastraError`）**

ドメイン × カテゴリ × ID の組み合わせで任意のエラーを表現する。新しいエラードメインが増えても `ErrorDomain` enum に追加するだけでよく、クラスの増殖を防ぐ。ストレージアダプターやワークフローエンジンなど、エラーの種類が多岐にわたる場面で使われている。

```typescript
// packages/core/src/error/index.ts:82-142
export class MastraBaseError<DOMAIN, CATEGORY> extends Error {
  public readonly id: Uppercase<string>;
  public readonly domain: DOMAIN;
  public readonly category: CATEGORY;
  public readonly details?: Record<string, Json<Scalar>> = {};

  constructor(
    errorDefinition: IErrorDefinition<DOMAIN, CATEGORY>,
    originalError?: string | Error | MastraBaseError<DOMAIN, CATEGORY> | unknown,
  ) {
    const error = originalError
      ? getErrorFromUnknown(originalError, { serializeStack: false, fallbackMessage: 'Unknown error' })
      : undefined;
    const message = errorDefinition.text ?? error?.message ?? 'Unknown error';
    super(message, { cause: error });
    // ...
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
```

`Object.setPrototypeOf(this, new.target.prototype)` の呼び出しは、TypeScript で `Error` を拡張する際の `instanceof` 問題を解決するための定番パターンである。

**戦略 B: ドメイン固有エラー階層（`WorkspaceError` → `FileNotFoundError` 等）**

ファイルシステムのように明確な失敗モードが限定されている領域では、専用クラスを用いて `instanceof` での型判定を可能にしている。Workspace 系は `WorkspaceError`（code + workspaceId）と `FilesystemError`（code + path）の 2 系統を持ち、Sandbox 系は `SandboxError`（code + details）→ `SandboxExecutionError`（exitCode, stdout, stderr）→ `SandboxTimeoutError`（timeoutMs, operation）と 3 層の階層を構成する。

```typescript
// packages/core/src/workspace/errors.ts:78-96
export class FilesystemError extends Error {
  constructor(message: string, public readonly code: string, public readonly path: string) {
    super(message);
    this.name = 'FilesystemError';
  }
}
export class FileNotFoundError extends FilesystemError {
  constructor(path: string) {
    super(`File not found: ${path}`, 'ENOENT', path);
  }
}
```

### 2. unknown → Error 正規化ユーティリティ

`getErrorFromUnknown` はコードベース全体で 40 箇所以上使われる中核ユーティリティ。Error インスタンス、オブジェクト、文字列、null/undefined すべてを安全に Error に変換する。cause チェーンを再帰的にたどり、`maxDepth`（デフォルト 5）で無限再帰を防止する。

```typescript
// packages/core/src/error/utils.ts:45-122
export function getErrorFromUnknown<SERIALIZABLE extends boolean = true>(
  unknown: unknown,
  options: {
    fallbackMessage?: string;
    maxDepth?: number;
    supportSerialization?: SERIALIZABLE;
    serializeStack?: boolean;
  } = {},
): SERIALIZABLE extends true ? SerializableError : Error {
```

`toJSON` を `Object.defineProperty` で非列挙プロパティとして定義しているのは、`deepEqual` 等のオブジェクト比較を壊さないための配慮。カスタムプロパティ（`statusCode`, `responseHeaders` 等）もシリアライズ対象に含め、既存の `toJSON` がある場合はスキップして上書きしない（`packages/core/src/error/utils.ts:140-185`）。

### 3. ワークフローの Result 型によるリトライと失敗伝播

`DefaultExecutionEngine.executeStepWithRetry` は判別共用体 `{ ok: true, result }` | `{ ok: false, error }` を返す。リトライ回数は `step.retries` またはワークフローレベルの `retryConfig.attempts` から決定。TripWire（プロセッサが処理を中断するシグナル）の検出もこの層で行う。

```typescript
// packages/core/src/workflows/default.ts:388-471
async executeStepWithRetry<T>(
  stepId: string,
  runStep: () => Promise<T>,
  params: { retries: number; delay: number; stepSpan?: Span; workflowId: string; runId: string },
): Promise<{ ok: true; result: T } | { ok: false; error: { status: 'failed'; error: Error; ... } }> {
  for (let i = 0; i < params.retries + 1; i++) {
    if (i > 0 && params.delay) {
      await new Promise(resolve => setTimeout(resolve, params.delay));
    }
    try {
      const result = await this.wrapDurableOperation(stepId, runStep);
      return { ok: true, result };
    } catch (e) {
      if (i === params.retries) {
        const errorInstance = getErrorFromUnknown(e, { serializeStack: false });
        const mastraError = new MastraError({ id: 'WORKFLOW_STEP_INVOKE_FAILED', ... }, errorInstance);
        return { ok: false, error: { status: 'failed', error: errorInstance, ... } };
      }
    }
  }
}
```

リトライ戦略の分離が重要な設計ポイントである。Default エンジンは上記の内部ループでリトライするが、Inngest エンジンは `executeStepWithRetry` をオーバーライドして `RetryAfterError` を throw し、外部リトライサービスに委譲する。ステップ関数自体はどちらのエンジンでもそのまま動く。

### 4. HTTP リクエストのリトライ（exponential backoff + 4xx 即時中断）

`fetchWithRetry` は 4xx エラーではリトライせず即座に throw し、5xx エラーのみ exponential backoff（上限 10 秒）でリトライする。

```typescript
// packages/core/src/utils/fetchWithRetry.ts:20-35
if (response.status >= 400 && response.status < 500) {
  throw new Error(`Request failed with status: ${response.status} ${response.statusText}`);
}
// 5xx はリトライ
const delay = Math.min(1000 * Math.pow(2, retryCount), 10000);
await new Promise(resolve => setTimeout(resolve, delay));
```

### 5. バリデーション多段フォールバック

`validateToolInput` は LLM 出力のバリデーションを 5 段階で試みる。LLM ごとの出力の癖（Gemini は null を送る、GLM4.7 は配列を文字列化する、OpenAI compat は optional を nullable に変換する等）を吸収する。失敗時のエラーメッセージは最初の検証結果を使う（正規化前のエラーが最も情報量が多いため）。

```typescript
// packages/core/src/tools/validation.ts:330-397
// Step 1: normalizeNullishInput — null/undefined → {} or [] (schema 型に応じて)
// Step 2: convertUndefinedToNull — OpenAI compat 対応 (GitHub #11457)
// Step 3: 最初のバリデーション（null 保持 — .nullable() スキーマの正常パス）
// Step 4: coerceStringifiedJsonValues — 文字列化 JSON の復元 (GitHub #12757)
// Step 5: stripNullishValues — null → undefined 変換で再試行 (GitHub #12362)
```

### 6. Static Factory Methods と エラー ID 命名規約

**A2A プロトコルの静的ファクトリ**: JSON-RPC エラーコードとの対応を内部に隠蔽し、型安全にエラーを生成する。

```typescript
// packages/core/src/a2a/error.ts:46-79
static taskNotFound(taskId: string): MastraA2AError {
  return new MastraA2AError(ErrorCodeTaskNotFound, `Task not found: ${taskId}`, undefined, taskId);
}
```

**ストレージのエラー ID 自動生成**: `MASTRA_VECTOR_{STORE}_{OPERATION}_{STATUS}` の形式で camelCase / kebab-case を UPPER_SNAKE_CASE に正規化して ID を生成。ログ検索やアラート設定が容易になる。

```typescript
// packages/core/src/storage/utils.ts:212-213
export function createVectorErrorId(store: StoreName, operation: string, status: string): Uppercase<string> {
  return createStoreErrorId('vector', store, operation, status);
}
// 結果例: "MASTRA_VECTOR_PG_UPSERT_EMPTY_VECTORS"
```

### 7. センシティブ情報のリダクションとエラーメッセージの安全性

バリデーションエラーメッセージに含まれるデータから、API キー・パスワード等のセンシティブ情報を自動的に除去する。入力データのログ出力は `truncateForLogging` で長さ制限もかける。

```typescript
// packages/core/src/tools/validation.ts:10-37
const SENSITIVE_KEYS = new Set([
  MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY,
  'apiKey', 'api_key', 'token', 'secret', 'password', 'credential', 'authorization',
]);

function redactSensitiveKeys(data: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(data)) {
    if (SENSITIVE_KEYS.has(key) || key.toLowerCase().includes('secret') || ...) {
      result[key] = '[REDACTED]';
    }
  }
}
```

### 8. 非クリティカル操作のエラー隔離

ストリーミングイベントの publish 失敗やライフサイクルコールバックの例外がメイン処理を中断しないよう、try-catch で隔離して debug/error ログのみ出力する。

```typescript
// packages/core/src/workflows/evented/step-executor.ts:43-56
} catch (err) {
  // Non-critical: streaming events are observational
  // Errors here should not fail step execution
  this.logger.debug('Failed to publish workflow watch event', { runId, error: err });
}
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: リトライ戦略をエンジン実装ごとに切り替える（内部ループ vs 外部リトライサービス）
  - 適用条件: 同じインターフェースで異なるリトライメカニズムが必要な場合
  - コード例: `DefaultExecutionEngine.executeStepWithRetry` vs Inngest エンジンの override（`packages/core/src/workflows/default.ts:388`）
  - 注意点: 抽象メソッドの戻り値型を判別共用体にすることで、呼び出し元に明示的なエラーハンドリングを強制している

- **Factory Method パターン** (分類: 生成)
  - 解決する問題: エラーコード・メッセージの組み合わせミスを防止し、エラー生成を一箇所に集約する
  - 適用条件: 同じエラークラスの異なるバリエーションが多数ある場合（プロトコル仕様対応等）
  - コード例: `MastraA2AError.taskNotFound()`, `MastraA2AError.invalidRequest()`（`packages/core/src/a2a/error.ts:44-79`）
  - 注意点: ファクトリメソッドが増えすぎると管理コストが上がるため、エラーコード enum との併用が有効

- **Chain of Responsibility パターン** (分類: 振る舞い)
  - 解決する問題: 一つのバリデーション戦略で全 LLM の出力差異を吸収できない
  - 適用条件: 入力の正規化に複数の段階が必要で、早期に成功すればスキップしたい場合
  - コード例: `validateToolInput` の 5 段階パイプライン（`packages/core/src/tools/validation.ts:330-397`）
  - 注意点: 各段階の副作用が後段に影響しないよう、元の入力を保持して段階ごとに新しい入力を生成している

## Good Patterns

- **判別共用体による Result 型**: `executeStepWithRetry` は `{ ok: true, result: T }` | `{ ok: false, error: ... }` を返す。呼び出し元は `if (!result.ok)` で分岐を強制され、エラーの見落としが型レベルで防止される。

```typescript
// packages/core/src/workflows/default.ts:398-412
async executeStepWithRetry<T>(...): Promise<
  | { ok: true; result: T }
  | { ok: false; error: { status: 'failed'; error: Error; endedAt: number; tripwire?: StepTripwireInfo } }
>
```

- **エラーの catch-rethrow で文脈を付加しつつ二重ラップを防止**: ストレージアダプターでは `if (error instanceof MastraError) throw error;` のガードにより、既にラップ済みのエラーの二重ラップを防ぐ。

```typescript
// stores/upstash/src/vector/index.ts:364-379
} catch (error) {
  if (error instanceof MastraError) throw error;
  throw new MastraError({
    id: createVectorErrorId('UPSTASH', 'UPDATE_VECTOR', 'FAILED'),
    domain: ErrorDomain.STORAGE,
    category: ErrorCategory.THIRD_PARTY,
    details: { namespace, ... },
  }, error);
}
```

- **TripWire: エラーにリトライ可否のメタデータを持たせる**: `TripWire` クラスは `retry: boolean` と `metadata` を持ち、catch 側がリトライするかどうかをエラーオブジェクト自体から判断できる。

```typescript
// packages/core/src/agent/trip-wire.ts:34-44
export class TripWire<TMetadata = unknown> extends Error {
  public readonly options: TripWireOptions<TMetadata>;
  public readonly processorId?: string;
  constructor(reason: string, options: TripWireOptions<TMetadata> = {}, processorId?: string) {
    super(reason);
    this.options = options;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
```

## Anti-Patterns / 注意点

- **エラーメッセージへの文字列マッチングによる分岐**: `fetchWithRetry` で 4xx エラーの検出にエラーメッセージのパターン `'status: 4'` を使っている。メッセージ文言変更で動作が壊れるリスクがある。

```typescript
// Bad: packages/core/src/utils/fetchWithRetry.ts:44
if (lastError.message.includes('status: 4')) {
  throw lastError;
}

// Better: ステータスコードをエラーオブジェクトのプロパティとして保持
class HttpError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}
// catch 時: error instanceof HttpError && error.status >= 400 && error.status < 500
```

- **catch ブロックでの `as` キャスト**: サーバーのエラーハンドラで `error as ApiError` のように直接キャストしており、型安全性が失われている。

```typescript
// Bad: packages/server/src/server/handlers/error.ts:28
const apiError = error as ApiError;
const apiErrorStatus = apiError.status || apiError.details?.status || 500;

// Better: 型ガード関数で安全に判定
function isApiError(error: unknown): error is ApiError {
  return typeof error === 'object' && error !== null && 'status' in error;
}
```

## 導出ルール

- `[MUST]` `catch (e)` で受け取ったエラーを直接操作せず、中央の正規化関数（`getErrorFromUnknown` 相当）を通してから使用する
  - 根拠: `e` は `unknown` 型であり、`Error` インスタンスでない場合がある。Mastra は全コンポーネント共通の正規化を行い、cause チェーンの深度制限やシリアライズ対応まで一元化している（`packages/core/src/error/utils.ts`）

- `[MUST]` リトライ対象外のエラー（4xx クライアントエラー等）を早期にリトライループから除外する — 無駄なリトライは遅延を増大させ、外部サービスのレートリミットを浪費する
  - 根拠: `fetchWithRetry` が 4xx を即座に throw し、5xx のみ exponential backoff でリトライしている（`packages/core/src/utils/fetchWithRetry.ts:23-26`）

- `[MUST]` エラーメッセージやログ出力にセンシティブ情報（API キー等）を含めない — リダクション処理を必ず経由する
  - 根拠: `validateRequestContext` が `redactSensitiveKeys` で apiKey / token / secret 等を `[REDACTED]` に置換している（`packages/core/src/tools/validation.ts:27-37`）

- `[SHOULD]` 構造化エラーにはドメイン・カテゴリ・一意 ID を付与し、エラーメッセージの文字列マッチングに依存しない
  - 根拠: `MastraBaseError` が `ErrorDomain`（17 種）と `ErrorCategory`（4 種）でエラーを分類し、`id` フィールドで一意識別する（`packages/core/src/error/index.ts:7-34`）

- `[SHOULD]` Error オブジェクトに `toJSON()` を実装し、`JSON.stringify` で意味のある出力を得られるようにする — JavaScript の `Error` は `JSON.stringify` すると `{}` になる
  - 根拠: `addErrorToJSON` が全エラーに非列挙 `toJSON` を付与し、message / name / stack / cause / カスタムプロパティをシリアライズ可能にしている（`packages/core/src/error/utils.ts:132-185`）

- `[SHOULD]` 外部入力のバリデーションには多段フォールバックパイプラインを用意し、不整合を段階的に吸収する
  - 根拠: `validateToolInput` が 5 段階の正規化パイプラインで LLM 出力の癖（null 送信、文字列化 JSON 等）を吸収している（`packages/core/src/tools/validation.ts:330-397`）

- `[SHOULD]` 非クリティカルな副作用（イベント送信、メトリクス等）のエラーはメイン処理に伝播させず、ログに記録するだけに留める
  - 根拠: `StepExecutor.createOutputWriter` で publish 失敗を catch して debug ログのみ出力している（`packages/core/src/workflows/evented/step-executor.ts:43-56`）

- `[SHOULD]` エラーの catch-rethrow では、既にドメインエラーでラップ済みかどうかを `instanceof` でチェックしてから再ラップする
  - 根拠: 23 のストレージアダプターすべてで `if (error instanceof MastraError) throw error;` パターンが適用されている

- `[AVOID]` リトライ対象エラーの判定にエラーメッセージの文字列検索を使う — エラーコード（`error.code`）やエラー型（`instanceof`）による判定を優先する
  - 根拠: `fetchWithRetry` の `lastError.message.includes('status: 4')` はメッセージ変更で壊れるリスクがあり、LibSQL アダプターの `error.code === 'SQLITE_BUSY'` によるコードベース判定の方が堅牢

## 適用チェックリスト

- [ ] プロジェクトに `getErrorFromUnknown` 相当の正規化関数が存在するか。catch ブロックで `error: unknown` を安全に Error に変換しているか
- [ ] カスタムエラークラスに `Object.setPrototypeOf(this, new.target.prototype)` を入れて `instanceof` を正しく動作させているか
- [ ] Error オブジェクトに `toJSON()` メソッドがあるか（ログ・API レスポンスで情報が欠落しないように）
- [ ] エラーに構造化された識別子（code / domain / category 等）を付与しているか。エラーメッセージの文字列マッチングに依存していないか
- [ ] リトライロジックで、リトライ対象外のエラー（クライアントエラー等）を早期に除外しているか
- [ ] exponential backoff に上限（cap）を設けているか
- [ ] エラーメッセージやログ出力にセンシティブ情報が含まれていないか。リダクション処理を経由しているか
- [ ] 非クリティカルな副作用（イベント送信、メトリクス等）のエラーがメイン処理を中断しないようガードしているか
- [ ] エラーの catch-rethrow で二重ラップ防止のガード（`instanceof` チェック）があるか
- [ ] エラーの cause チェーンに深度制限を設けているか（再帰的シリアライズでの無限ループ防止）
- [ ] 外部入力のバリデーションに多段フォールバックが必要か検討したか（特に LLM 出力や外部 API レスポンス）
