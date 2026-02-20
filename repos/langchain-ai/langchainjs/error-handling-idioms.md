# error-handling-idioms

> リポジトリ: langchain-ai/langchainjs
> 分析日: 2026-02-20

## 概要

langchainjs のエラーハンドリングは、LLM プロバイダの多様性・非同期処理・ユーザー中断・自動リトライといった複合的な要件に対処するため、階層的エラー型・Symbol ブランディングによる型安全な判別・宣言的リカバリーパイプラインという三つの柱で構成されている。特に注目すべきは、`instanceof` の cross-realm 問題を根本的に解消する namespace ブランディングパターンと、エラーを「例外として投げる」か「メッセージとして会話に注入する」かを呼び出し側が選択できる二重チャネル設計である。

## 背景にある原則

- **エラーは型付けされた値として分類すべき、なぜならプログラム的な復旧判断に文字列マッチは脆弱だから**: HTTP ステータスコードやプロバイダ固有のエラー文字列を `LangChainErrorCodes` の列挙型に正規化し、`wrapAnthropicClientError` / `wrapOpenAIClientError` がプロバイダ境界でエラーを統一コードに変換している（`libs/providers/langchain-anthropic/src/utils/errors.ts:28-48`）。
- **制御フローとしてのエラーは通常エラーと分離すべき、なぜならラップや変換で制御信号が消失するから**: `MiddlewareError.wrap()` は `GraphBubbleUp`（`GraphInterrupt` 等）を検出して素通りさせ、通常のエラーだけをラップする（`libs/langchain/src/agents/errors.ts:102-109`）。
- **復旧戦略はエラー発生点ではなく呼び出し側が決定すべき、なぜなら同じエラーでも文脈によって最適な対処が異なるから**: `modelRetryMiddleware` や `toolRetryMiddleware` の `onFailure` は `"error"` / `"continue"` / カスタム関数を受け取り、リトライ消尽後の振る舞いを呼び出し側に委ねている（`libs/langchain/src/agents/middleware/modelRetry.ts:26-31`）。
- **`instanceof` はパッケージ境界を越えると壊れるため、Symbol ベースの判別を使うべき**: `createNamespace` が `Symbol.for()` でグローバルに一意なシンボルをプロトタイプに埋め込み、`isInstance` 静的メソッドで cross-realm 安全な型判別を実現している（`libs/langchain-core/src/utils/namespace.ts:114-160`）。

## 実例と分析

### 1. 階層的エラー型と namespace ブランディング

langchainjs は `createNamespace` ユーティリティを使って、エラークラスを階層的にブランディングしている。

```typescript
// libs/langchain-core/src/errors/index.ts:28-57
export const ns = baseNs.sub("error");

export class LangChainError extends ns.brand(Error) {
  readonly name: string = "LangChainError";
  constructor(message?: string) {
    super(message);
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

export class ModelAbortError extends ns.brand(LangChainError, "model-abort") {
  readonly name = "ModelAbortError";
  readonly partialOutput?: AIMessageChunk;
}
```

各プロバイダは独自の sub-namespace でエラーを拡張している。

```typescript
// libs/providers/langchain-google/src/utils/errors.ts:6-48
const ns = baseNs.sub("google");

export class GoogleError extends ns.brand(LangChainError) {
  readonly name: string = "GoogleError";
}

export class ConfigurationError extends ns.brand(GoogleError, "configuration") {
  readonly name = "ConfigurationError";
}
```

これにより `LangChainError.isInstance(err)` がプロバイダの深い子孫クラスにも正しく `true` を返し、`ConfigError.isInstance(err)` は兄弟クラスの `AuthError` には `false` を返す。

### 2. プロバイダ境界でのエラー正規化

各プロバイダは HTTP レスポンスのステータスコードとメッセージ文字列を検査し、統一的なエラーコードに変換する。

```typescript
// libs/providers/langchain-openai/src/utils/client.ts:21-61
export function wrapOpenAIClientError(e: unknown) {
  if (!e || typeof e !== "object") {
    return e;
  }
  let error;
  if (e.constructor.name === APIConnectionTimeoutError.name && ...) {
    error = new Error(e.message);
    error.name = "TimeoutError";
  } else if (_isOpenAIContextOverflowError(e)) {
    error = ContextOverflowError.fromError(e as Error);
  } else if ("status" in e && e.status === 401) {
    error = addLangChainErrorFields(e, "MODEL_AUTHENTICATION");
  } else if ("status" in e && e.status === 429) {
    error = addLangChainErrorFields(e, "MODEL_RATE_LIMIT");
  } else {
    error = e;
  }
  return error;
}
```

OpenRouter プロバイダではファクトリメソッドパターンでより構造化されている。

```typescript
// libs/providers/langchain-openrouter/src/utils/errors.ts:47-77
static async fromResponse(response: Response): Promise<OpenRouterError> {
  // ... JSON パース ...
  if (response.status === 401 || response.status === 403) {
    return new OpenRouterAuthError(message, code, error?.metadata);
  }
  if (response.status === 429) {
    return new OpenRouterRateLimitError(message, code, error?.metadata);
  }
  return new OpenRouterError(message, code, error?.metadata);
}
```

### 3. 二重チャネル: 例外 vs メッセージ注入

ミドルウェアシステムではエラー発生時に「例外として throw する」か「AIMessage/ToolMessage として会話に注入する」かを選択できる。

```typescript
// libs/langchain/src/agents/middleware/modelRetry.ts:173-188
const handleFailure = (error: Error, attemptsMade: number): AIMessage => {
  if (onFailure === "error") {
    throw error; // チャネル1: 例外として伝播
  }
  let content: string;
  if (typeof onFailure === "function") {
    content = onFailure(error);
  } else {
    content = formatFailureMessage(error, attemptsMade);
  }
  return new AIMessage({ content }); // チャネル2: メッセージとして注入
};
```

`toolCallLimitMiddleware` も同様に `continue` / `error` / `end` の三つの exit behavior を持つ（`libs/langchain/src/agents/middleware/toolCallLimit.ts:26-27`）。

### 4. 制御フローエラーの透過的伝播

`MiddlewareError.wrap()` は「通常エラーはラップする」が「制御フローエラー（GraphInterrupt 等）はそのまま通す」という選別を行う。

```typescript
// libs/langchain/src/agents/errors.ts:102-109
static wrap(error: unknown, middlewareName: string): Error {
  if (isGraphBubbleUp(error)) {
    return error;  // 制御フローはラップしない
  }
  return new MiddlewareError(error, middlewareName);
}
```

### 5. 自己修復型エラー: OutputParserException

`OutputParserException` は `sendToLLM` フラグと `observation` フィールドを持ち、パース失敗時にエラー情報を LLM にフィードバックして修正を促すことができる。

```typescript
// libs/langchain-core/src/output_parsers/base.ts:170-197
export class OutputParserException extends Error {
  llmOutput?: string;
  observation?: string;
  sendToLLM: boolean;
  // sendToLLM=true の場合、observation と llmOutput が必須
}
```

### 6. リトライ不可エラーの分類

`AsyncCaller` はステータスコードベースで「リトライしてはいけないエラー」を明示的にリスト化している。

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

一方、Google プロバイダの `RequestError` は逆に `isRetryable()` メソッドでリトライ可能なステータスを判定する（`libs/providers/langchain-google/src/utils/errors.ts:472-475`）。

## パターンカタログ

- **Factory Method** (分類: 生成)
  - 解決する問題: HTTP レスポンスからエラー型を自動選択する
  - 適用条件: エラーの種別がレスポンスの内容に依存する場合
  - コード例: `libs/providers/langchain-openrouter/src/utils/errors.ts:47` (`OpenRouterError.fromResponse`)、`libs/providers/langchain-google/src/utils/errors.ts:500` (`RequestError.fromResponse`)
  - 注意点: レスポンス JSON のパースが失敗するケースに対するフォールバックが必要

- **Chain of Responsibility** (分類: 振る舞い)
  - 解決する問題: 複数の Runnable を順番に試行し、最初の成功を返す
  - 適用条件: 同一インターフェースの代替実装が複数存在する場合
  - コード例: `libs/langchain-core/src/runnables/base.ts:2899-2916` (`RunnableWithFallbacks.invoke`)
  - 注意点: ストリーミング中のエラーはフォールバックされない（開始時のみ）

- **Decorator** (分類: 構造)
  - 解決する問題: 既存の Runnable にリトライ機能を透過的に追加する
  - 適用条件: リトライロジックを本体の実装から分離したい場合
  - コード例: `libs/langchain-core/src/runnables/base.ts:1649-1707` (`RunnableRetry._invoke`)

## Good Patterns

- **Symbol ブランディングによる cross-realm 安全な型判別**: `createNamespace` を使い、`Symbol.for()` でグローバルに一意なブランドをプロトタイプに埋め込む。`isInstance` 静的メソッドで `instanceof` を使わずに型を判別でき、パッケージの重複インストールや異なる realm でも正しく動作する。

```typescript
// libs/langchain-core/src/utils/namespace.ts:118-138
brand<TBase extends Constructor>(Base: TBase, marker?: string) {
  const brandSymbol = marker ? Symbol.for(`${path}.${marker}`) : symbol;
  class _Branded extends (Base as any) {
    readonly [brandSymbol] = true as const;
    static isInstance(obj: unknown): boolean {
      return typeof obj === "object" && obj !== null
        && brandSymbol in obj
        && (obj as Record<symbol, unknown>)[brandSymbol] === true;
    }
  }
  return _Branded;
}
```

- **エラーコードによるトラブルシューティング URL の自動生成**: エラーメッセージに `lc_error_code` に基づく URL を自動付与し、開発者を正しいドキュメントに誘導する。

```typescript
// libs/langchain-core/src/errors/index.ts:22-23
(error as any).lc_error_code = lc_error_code;
error.message = `${error.message}\n\nTroubleshooting URL: https://docs.langchain.com/.../errors/${lc_error_code}/\n`;
```

- **`fromError` / `fromResponse` 静的ファクトリで原因チェーンを保持**: `ContextOverflowError.fromError()` は元のエラーを `cause` に設定し、エラーの根本原因を失わない。

```typescript
// libs/langchain-core/src/errors/index.ts:178-182
static fromError(obj: Error): ContextOverflowError {
  const error = new ContextOverflowError(obj.message);
  error.cause = obj;
  return error;
}
```

## Anti-Patterns / 注意点

- **`instanceof` でエラー型を判別する**: npm のバージョン重複や ESM/CJS 混在で `instanceof` は壊れる。langchainjs では `no-instanceof/no-instanceof` ESLint ルールで禁止し、`isInstance` パターンを強制している。

```typescript
// Bad: cross-realm で壊れる
if (error instanceof LangChainError) { ... }

// Better: Symbol ブランディングで安全
if (LangChainError.isInstance(error)) { ... }
```

- **制御フローエラーを無差別にラップする**: `GraphInterrupt` 等の制御フロー信号を `MiddlewareError` でラップすると、上位の中断処理が機能しなくなる。

```typescript
// Bad: 制御フローも含めてすべてラップ
try { ... } catch (e) { throw new MiddlewareError(e, name); }

// Better: 制御フロー信号を透過させる
static wrap(error: unknown, middlewareName: string): Error {
  if (isGraphBubbleUp(error)) return error;
  return new MiddlewareError(error, middlewareName);
}
```

- **リトライ可否をエラー型と切り離して管理する**: ステータスコードのリストを別の場所で管理すると、エラー型とリトライ判定が分散する。Google プロバイダの `RequestError.isRetryable()` のように、エラー型自身にリトライ可否の判定を持たせるほうが凝集度が高い。

```typescript
// Bad: リトライ判定がエラーの外にある
const STATUS_NO_RETRY = [400, 401, 403, 404];
if (STATUS_NO_RETRY.includes(error.status)) throw error;

// Better: エラー型にリトライ判定を内包する
class RequestError extends GoogleError {
  isRetryable(): boolean {
    return RETRYABLE_STATUS_CODES.includes(this.statusCode);
  }
}
```

## 導出ルール

- `[MUST]` エラー階層には `instanceof` ではなく Symbol ブランディング + 静的 `isInstance` メソッドを使う
  - 根拠: `createNamespace` が `Symbol.for()` でパッケージ重複・cross-realm 問題を回避している（`libs/langchain-core/src/utils/namespace.ts:114-160`）

- `[MUST]` 制御フロー用のエラー（中断・キャンセル等）は通常エラーのラップ処理から除外する
  - 根拠: `MiddlewareError.wrap()` が `isGraphBubbleUp` で制御フロー信号を透過させている（`libs/langchain/src/agents/errors.ts:102-109`）

- `[SHOULD]` リトライ可否の判定ロジックはエラー型自身に `isRetryable()` メソッドとして内包する
  - 根拠: Google プロバイダの `RequestError.isRetryable()` がステータスコード判定を型に凝集させている（`libs/providers/langchain-google/src/utils/errors.ts:472-475`）

- `[SHOULD]` 外部 API エラーはプロバイダ境界で正規化し、内部で統一的なエラーコードに変換する
  - 根拠: `wrapOpenAIClientError` / `wrapAnthropicClientError` が HTTP ステータスを `LangChainErrorCodes` に正規化している（`libs/providers/langchain-openai/src/utils/client.ts:21-61`）

- `[SHOULD]` リカバリー戦略（throw / メッセージ注入 / カスタム関数）は呼び出し側が選択できるように設計する
  - 根拠: `modelRetryMiddleware` の `onFailure` パラメータが `"error"` / `"continue"` / 関数を受け取る（`libs/langchain/src/agents/middleware/modelRetry.ts:26-31`）

- `[SHOULD]` エラーメッセージにトラブルシューティング URL やエラーコードを付与し、デバッグを支援する
  - 根拠: `addLangChainErrorFields` が全エラーにドキュメント URL を自動付与している（`libs/langchain-core/src/errors/index.ts:22-23`）

- `[AVOID]` `instanceof` によるエラー型判別（ESM/CJS 混在やパッケージ重複で壊れる）
  - 根拠: ESLint ルール `no-instanceof/no-instanceof` がコードベース全体で適用されている

## 適用チェックリスト

- [ ] プロジェクトのエラークラスに `isInstance` 静的メソッド（Symbol ブランディングまたはブランドフィールド）を実装しているか
- [ ] 外部 API（LLM プロバイダ、HTTP クライアント等）のエラーをプロバイダ境界で正規化しているか
- [ ] リトライ可否の判定がエラー型に内包されているか、それとも外部のステータスコードリストに分散していないか
- [ ] 制御フローとしてのエラー（中断シグナル、キャンセル等）が通常のエラーラップ処理から除外されているか
- [ ] エラー発生後のリカバリー戦略（throw / graceful degradation / retry）が呼び出し側で選択可能になっているか
- [ ] エラーメッセージに、開発者がデバッグに使える十分なコンテキスト（エラーコード、URL、元のエラー cause）が含まれているか
