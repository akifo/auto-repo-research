# エラー処理のイディオム

> リポジトリ: openclaw/openclaw
> 分析日: 2026-02-14

## 概要

マルチチャネル AI アシスタント基盤のエラー処理戦略を横断的に分析した。外部サービス統合が多く（Telegram, Discord, AI プロバイダー等）、ネットワーク障害・レート制限・認証エラーなど多様なエラーに対処する必要がある。特に注目に値するのは、ドメイン固有のカスタムエラー型と `instanceof` による分岐、エラーチェーンを再帰的に走査するリカバリ判定、そして Result パターンと例外の使い分けである。

## 背景にある原則

- **エラーは構造化データであるべき**: エラーメッセージ文字列ではなく、`code`・`reason`・`status` などの型付きフィールドでエラーの性質を表現する。これにより catch 側が文字列解析なしにエラーを分類・処理できる。（根拠: `FailoverError` の `reason: FailoverReason` フィールド、`MediaFetchError` の `code: MediaFetchErrorCode`、`RequestBodyLimitError` の `code: RequestBodyLimitErrorCode`）

- **リカバリ可能性はエラーの型で判断する**: `instanceof` チェックで catch ブロック内の分岐を行い、リカバリ可能なエラーだけを処理し、それ以外は即座に再 throw する。エラーメッセージの文字列マッチはフォールバック手段に留める。（根拠: `isRecoverableTelegramNetworkError` はまずエラーコード・エラー名を検査し、メッセージマッチはコンテキストに応じて制限する）

- **一時的障害はプロセスを落とさない**: ネットワークエラーやレート制限など一過性の障害はリトライまたは警告ログで吸収し、致命的エラー（OOM, 設定エラー）のみプロセスを終了する。長時間稼働するゲートウェイプロセスの可用性を確保するための判断。（根拠: `installUnhandledRejectionHandler` がエラーコード別に `process.exit(1)` と `console.warn` を使い分ける）

- **エラー変換は境界で行う**: 外部ライブラリのエラーや未知のエラーオブジェクトを、自ドメインのエラー型に変換するレイヤーを設ける。これにより内部ロジックは統一されたエラー型だけを扱える。（根拠: `coerceToFailoverError` が任意の `unknown` をステータスコード・エラーコード・メッセージから `FailoverError` に変換する）

## 実例と分析

### ドメイン固有エラー型の設計

コードベース全体で 20 以上のカスタムエラークラスが定義されている。共通する設計パターンがある。

1. **Error を直接継承**: すべてのカスタムエラーが `Error` を直接継承する（多段継承は `CircularIncludeError extends ConfigIncludeError` の1例のみ）
2. **`name` プロパティの明示設定**: `this.name = "XxxError"` をコンストラクタで設定する
3. **構造化フィールドを `readonly` で公開**: エラーの分類に使うフィールドは `readonly` で型付きにする
4. **エラーコードを文字列リテラル union 型で定義**: `type MediaFetchErrorCode = "max_bytes" | "http_error" | "fetch_failed"`

```typescript
// src/media/fetch.ts:12-22
export type MediaFetchErrorCode = "max_bytes" | "http_error" | "fetch_failed";

export class MediaFetchError extends Error {
  readonly code: MediaFetchErrorCode;

  constructor(code: MediaFetchErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "MediaFetchError";
  }
}
```

```typescript
// src/infra/http-body.ts:6-44
export type RequestBodyLimitErrorCode =
  | "PAYLOAD_TOO_LARGE"
  | "REQUEST_BODY_TIMEOUT"
  | "CONNECTION_CLOSED";

export class RequestBodyLimitError extends Error {
  readonly code: RequestBodyLimitErrorCode;
  readonly statusCode: number;

  constructor(init: RequestBodyLimitErrorInit) {
    super(init.message ?? DEFAULT_ERROR_MESSAGE[init.code]);
    this.name = "RequestBodyLimitError";
    this.code = init.code;
    this.statusCode = DEFAULT_ERROR_STATUS_CODE[init.code];
  }
}
```

### 型ガード関数によるエラー識別

多くのカスタムエラーに対し、`isXxxError` 型ガード関数がペアで提供されている。

```typescript
// src/agents/failover-error.ts:37-39
export function isFailoverError(err: unknown): err is FailoverError {
  return err instanceof FailoverError;
}

// src/media-understanding/errors.ts:13-15
export function isMediaUnderstandingSkipError(err: unknown): err is MediaUnderstandingSkipError {
  return err instanceof MediaUnderstandingSkipError;
}
```

より複雑なケースでは、`instanceof` に加えて `name` プロパティでのフォールバック判定も行う。

```typescript
// src/gateway/tools-invoke-http.ts:115-125
function isToolInputError(err: unknown): boolean {
  if (err instanceof ToolInputError) {
    return true;
  }
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: unknown }).name === "ToolInputError"
  );
}
```

### エラーチェーン走査による分類

Telegram のネットワークエラー判定では、`cause`・`reason`・`errors`（AggregateError）・`error`（Grammy HttpError）を BFS で再帰的に走査し、チェーン内のどこかにリカバリ可能なエラーがあるかを判定する。

```typescript
// src/telegram/network-errors.ts:72-114
function collectErrorCandidates(err: unknown): unknown[] {
  const queue = [err];
  const seen = new Set<unknown>();
  const candidates: unknown[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current == null || seen.has(current)) {
      continue;
    }
    seen.add(current);
    candidates.push(current);

    if (typeof current === "object") {
      const cause = (current as { cause?: unknown }).cause;
      if (cause && !seen.has(cause)) { queue.push(cause); }
      const reason = (current as { reason?: unknown }).reason;
      if (reason && !seen.has(reason)) { queue.push(reason); }
      const errors = (current as { errors?: unknown }).errors;
      if (Array.isArray(errors)) {
        for (const nested of errors) {
          if (nested && !seen.has(nested)) { queue.push(nested); }
        }
      }
      // Grammy の HttpError は .error にラップする（.cause ではない）
      if (getErrorName(current) === "HttpError") {
        const wrappedError = (current as { error?: unknown }).error;
        if (wrappedError && !seen.has(wrappedError)) { queue.push(wrappedError); }
      }
    }
  }
  return candidates;
}
```

### エラー変換（Coercion）パターン

任意の `unknown` エラーからドメインエラーへの変換ファクトリを提供する。

```typescript
// src/agents/failover-error.ts:205-234
export function coerceToFailoverError(
  err: unknown,
  context?: { provider?: string; model?: string; profileId?: string },
): FailoverError | null {
  if (isFailoverError(err)) { return err; }
  const reason = resolveFailoverReasonFromError(err);
  if (!reason) { return null; }
  const message = getErrorMessage(err) || String(err);
  const status = getStatusCode(err) ?? resolveFailoverStatus(reason);
  const code = getErrorCode(err);
  return new FailoverError(message, {
    reason, provider: context?.provider, model: context?.model,
    profileId: context?.profileId, status, code,
    cause: err instanceof Error ? err : undefined,
  });
}
```

### Result パターンと例外の併用

I/O 境界（HTTP ボディ読み取り、設定パース等）では `{ ok: true; value } | { ok: false; error }` の Result 型を返す。内部ロジックでは例外を使い、境界で Result に変換する。

```typescript
// src/infra/http-body.ts:182-221
export type ReadJsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string; code: RequestBodyLimitErrorCode | "INVALID_JSON" };

export async function readJsonBodyWithLimit(
  req: IncomingMessage,
  options: ReadJsonBodyOptions,
): Promise<ReadJsonBodyResult> {
  try {
    const raw = await readRequestBodyWithLimit(req, options);
    // ... JSON.parse ...
    return { ok: true, value: JSON.parse(trimmed) as unknown };
  } catch (error) {
    if (isRequestBodyLimitError(error)) {
      return { ok: false, code: error.code, error: requestBodyErrorToText(error.code) };
    }
    return { ok: false, code: "INVALID_JSON", error: error instanceof Error ? error.message : String(error) };
  }
}
```

### リトライ戦略

汎用リトライ関数 `retryAsync` を提供し、各チャネル（Discord, Telegram）向けに `shouldRetry` と `retryAfterMs` をカスタマイズする。

```typescript
// src/discord/api.ts:126-135
return retryAsync(
  async () => { /* fetch logic */ },
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

### 未処理 rejection のグローバルハンドリング

エラーを致命度で3段階に分類し、段階的に処理する。

```typescript
// src/infra/unhandled-rejections.ts:143-178
process.on("unhandledRejection", (reason, _promise) => {
  if (isUnhandledRejectionHandled(reason)) { return; }
  if (isAbortError(reason)) {
    console.warn("[openclaw] Suppressed AbortError:", formatUncaughtError(reason));
    return;
  }
  if (isFatalError(reason)) {
    console.error("[openclaw] FATAL:", formatUncaughtError(reason));
    process.exit(1);
    return;
  }
  if (isConfigError(reason)) {
    console.error("[openclaw] CONFIGURATION ERROR:", formatUncaughtError(reason));
    process.exit(1);
    return;
  }
  if (isTransientNetworkError(reason)) {
    console.warn("[openclaw] Non-fatal (continuing):", formatUncaughtError(reason));
    return;
  }
  console.error("[openclaw] Unhandled rejection:", formatUncaughtError(reason));
  process.exit(1);
});
```

## パターンカタログ

- **Chain of Responsibility** (分類: 振る舞い)
  - 解決する問題: 未知のエラーオブジェクトを段階的に分類する
  - 適用条件: 外部ライブラリのエラーが多様で、単一の `instanceof` では判定できない場合
  - コード例: `src/agents/failover-error.ts:145-180` — ステータスコード → エラーコード → タイムアウト判定 → メッセージ解析の順で `FailoverReason` を解決する
  - 注意点: 判定順序がロジックに影響するため、より具体的な条件を先に配置する

- **Adapter** (分類: 構造)
  - 解決する問題: 外部ライブラリのエラー形式を内部ドメインに統一する
  - 適用条件: 複数の外部 API を統合し、各 API が異なるエラー形式を返す場合
  - コード例: `src/agents/failover-error.ts:205-234` — `coerceToFailoverError` が任意のエラーを `FailoverError` に変換する
  - 注意点: 変換不能な場合は `null` を返し、呼び出し側に再 throw を委ねる

## Good Patterns

- **エラーコードを文字列リテラル union 型で定義する**: エラーの種類をコンパイル時に制約し、switch 文の網羅性チェックが有効になる。`type MediaFetchErrorCode = "max_bytes" | "http_error" | "fetch_failed"` のように定義し、エラークラスの `code` フィールドに適用する。

```typescript
// src/media/fetch.ts:12
export type MediaFetchErrorCode = "max_bytes" | "http_error" | "fetch_failed";
```

- **`catch` ブロックでの型絞り込みと即座の再 throw**: `instanceof` で扱えるエラーだけを処理し、それ以外は `throw err` で素通りさせる。「握りつぶし」を防ぎ、エラーの可視性を維持する。

```typescript
// src/media-understanding/attachments.ts:298-312
} catch (err) {
  if (err instanceof MediaFetchError && err.code === "max_bytes") {
    throw new MediaUnderstandingSkipError("maxBytes", `Attachment exceeds maxBytes`);
  }
  if (isAbortError(err)) {
    throw new MediaUnderstandingSkipError("timeout", `Attachment timed out`);
  }
  throw err;
}
```

- **リトライに `shouldRetry` コールバックを渡す**: 汎用リトライ関数に「何をリトライすべきか」の判断を注入する。レート制限（429）だけリトライし、認証エラー（401）はリトライしないといった制御が宣言的に表現できる。

```typescript
// src/discord/api.ts:129
shouldRetry: (err) => err instanceof DiscordApiError && err.status === 429,
```

## Anti-Patterns / 注意点

- **エラーメッセージの文字列マッチによる分類**: 外部ライブラリが構造化されたエラーを返さない場合にフォールバックとして使われるが、メッセージが変更されると判定が壊れる。このコードベースでも `RECOVERABLE_MESSAGE_SNIPPETS` としてメッセージ部分一致を使っているが、`context: "send"` ではメッセージマッチを無効にする安全弁を設けている。

```typescript
// Bad: メッセージ文字列に依存するリカバリ判定
if (err.message.includes("fetch failed")) {
  return true; // 外部ライブラリのメッセージ変更で壊れる
}

// Better: エラーコード・型名を優先し、メッセージマッチはフォールバック＋コンテキスト制御付きで使う
const code = extractErrorCode(err);
if (code && RECOVERABLE_ERROR_CODES.has(code)) { return true; }
if (allowMessageMatch) { /* フォールバック */ }
```

- **`catch {}` での無言の握りつぶし**: クリーンアップ処理（`reader.releaseLock()`、`handle.close()`）では正当な使い方だが、ビジネスロジック内での使用はエラーの可視性を失う。コードベースでは多用されているが、すべてリソース解放のコンテキストに限定されている。

```typescript
// OK: リソースクリーンアップ（エラーを無視して安全）
try { reader.releaseLock(); } catch {}
try { await handle.close(); } catch {}

// Bad: ビジネスロジックでの握りつぶし
try { await processOrder(); } catch {} // 障害が見えなくなる
```

## 導出ルール

- `[MUST]` カスタムエラークラスには構造化されたコード/理由フィールドを文字列リテラル union 型で持たせる
  - 根拠: `MediaFetchError.code`、`RequestBodyLimitError.code`、`FailoverError.reason` がすべてリテラル union 型で、catch 側が文字列解析なしにエラーを判別できている

- `[MUST]` catch ブロックでは `instanceof` で処理対象のエラーだけを扱い、それ以外は即座に再 throw する
  - 根拠: `src/media-understanding/attachments.ts:298-312`、`src/infra/fs-safe.ts:95-103` など、コードベース全体で「処理できないエラーは素通り」が徹底されている

- `[SHOULD]` 外部サービスのエラーはアプリケーション境界で自ドメインのエラー型に変換（coerce）する
  - 根拠: `coerceToFailoverError` が任意の API エラーを統一的な `FailoverError` に変換し、内部ロジックは `FailoverReason` union だけで分岐できる

- `[SHOULD]` リトライ関数は `shouldRetry` コールバックでリトライ対象を制御し、`retryAfterMs` でバックオフを外部から注入する
  - 根拠: `retryAsync` が汎用リトライロジックを提供し、Discord・Telegram がそれぞれ `shouldRetry`/`retryAfterMs` をカスタマイズしている

- `[SHOULD]` 未処理 rejection のグローバルハンドラでは、エラーを致命度で分類し、一時的障害ではプロセスを落とさない
  - 根拠: `installUnhandledRejectionHandler` が致命的/設定/一時的ネットワーク/その他に分類し、一時的ネットワークエラーは `console.warn` で継続する

- `[SHOULD]` エラーの cause チェーンを走査して分類する際は、`cause`・`reason`・`errors`（AggregateError）を再帰的にたどり、循環参照を `Set` で防止する
  - 根拠: `collectErrorCandidates` が BFS で cause チェーンを走査し `seen` Set で循環を防止している

- `[AVOID]` エラーメッセージの文字列マッチだけでリカバリ判定を行うこと。エラーコード・型名を優先し、メッセージマッチはフォールバック＋コンテキスト制御付きに限定する
  - 根拠: `isRecoverableTelegramNetworkError` は `context: "send"` ではメッセージマッチを無効にし、偽陽性を防いでいる

- `[AVOID]` ビジネスロジック内で `catch {}` によるエラーの無言握りつぶしを行うこと。クリーンアップ処理のみ許容する
  - 根拠: コードベースの `catch {}` はすべて `reader.releaseLock()`、`handle.close()`、`req.destroy()` 等のリソース解放に限定されている

## 適用チェックリスト

- [ ] カスタムエラークラスに `code` または `reason` を文字列リテラル union 型で持たせているか
- [ ] catch ブロックで処理対象外のエラーを再 throw しているか（握りつぶしていないか）
- [ ] 外部 API のエラーを自ドメインのエラー型に変換する coerce 関数があるか
- [ ] リトライロジックに `shouldRetry` で対象エラーの制限があるか（全エラーをリトライしていないか）
- [ ] 長時間稼働プロセスの未処理 rejection ハンドラで、一時的障害と致命的エラーを区別しているか
- [ ] エラーチェーン（cause）を考慮した判定を行っているか（ラップされた内部エラーを見逃していないか）
- [ ] `catch {}` の使用箇所がリソースクリーンアップに限定されているか
