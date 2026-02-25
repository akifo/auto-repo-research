# エラーハンドリングイディオム

> リポジトリ: vercel/chat
> 分析日: 2026-02-25

## 概要

vercel/chat は Slack・Discord・Teams・Google Chat・GitHub・Linear という6つのプラットフォームを統一的に扱うチャット SDK であり、エラーハンドリングには「コア層とアダプター層で独立したエラー階層を持ち、境界変換で接続する」という戦略が採られている。分散ロック・Webhook 署名検証・ストリーミングフォールバックなど、マルチプラットフォーム SDK に特有のエラー伝播パターンが体系的に実装されており、汎用性の高いプラクティスが多数抽出できる。

## 背景にある原則

- **エラーは発生元の文脈を保持して伝播すべき**: `ChatError.code` や `AdapterError.adapter` のように、エラーが発生した層・プラットフォームを特定できる情報を構造化フィールドとして保持する。メッセージ文字列の解析に依存するとリファクタリングに弱くなるため、プログラムで判別可能なフィールドを付与する（`packages/chat/src/errors.ts:6` の `code` フィールド、`packages/adapter-shared/src/errors.ts:14` の `adapter` フィールド）。

- **レイヤー境界でエラーを変換し、上位層のエラー語彙で再スローすべき**: アダプターが受け取るプラットフォーム固有のエラー（Slack の `ratelimited` 文字列、HTTP 429 ステータスコードなど）は、`handleSlackError` / `handleTeamsError` / `handleGoogleChatError` といった変換関数で SDK 共通の `AdapterRateLimitError` 等に正規化される。上位層が全プラットフォームのエラー形式を知る必要がなくなる。

- **回復不能なエラーは即座に throw し、回復可能なエラーは代替経路（フォールバック）で処理すべき**: ロック取得失敗は `LockError` を throw して即座に伝播するが、エフェメラルメッセージの送信失敗は DM フォールバック、ストリーミング非対応は post+edit フォールバックという代替経路で回復する。エラーの性質に応じて伝播か吸収かを使い分けている。

- **セキュリティ関連のエラーは情報を漏洩せず、安全な既定値に倒すべき**: Webhook 署名検証の `timingSafeEqual` 呼び出しは try-catch で囲み、例外時には `false` を返す。検証失敗の理由をクライアントに公開しない。

## 実例と分析

### 二層エラー階層とレイヤー境界変換

コア SDK（`packages/chat/src/errors.ts`）とアダプター共通層（`packages/adapter-shared/src/errors.ts`）で、独立したエラー階層を定義している。

コア層の階層:

```
Error
└── ChatError (code: string, cause?: unknown)
    ├── RateLimitError (retryAfterMs?: number)
    ├── LockError
    └── NotImplementedError (feature?: string)
```

アダプター層の階層:

```
Error
└── AdapterError (adapter: string, code?: string)
    ├── AdapterRateLimitError (retryAfter?: number)
    ├── AuthenticationError
    ├── ResourceNotFoundError (resourceType, resourceId)
    ├── PermissionError (action, requiredScope)
    ├── ValidationError
    └── NetworkError (originalError?: Error)
```

この二層構造の要点は、コア層がアダプター層のエラー型に依存しないこと。各アダプターは自身の `handle*Error` メソッドでプラットフォーム固有エラーを `AdapterError` サブクラスに変換する。

### プラットフォーム固有エラーの正規化パターン

各アダプターは `handle*Error(error, context): never` という共通シグネチャの変換メソッドを持ち、プラットフォーム固有のエラー形式を判別して適切な `AdapterError` サブクラスに変換する。

Teams アダプターの変換は最も網羅的で、HTTP ステータスコードに基づく分岐を行い、401/403 を `AuthenticationError`、404 を `NetworkError`、429 を `AdapterRateLimitError` に変換する。マッチしないエラーは `NetworkError` にフォールバックする。

Slack アダプターは最も簡素で、`ratelimited` エラーコードのみを `AdapterRateLimitError` に変換し、それ以外はそのまま再 throw する。GChat アダプターは HTTP 429 のみを `AdapterRateLimitError` に変換し、それ以外はそのまま再 throw する。

### 分散ロックとエラー伝播

`handleIncomingMessage` はメッセージ処理の前にスレッド単位でロックを取得し、処理完了後に `finally` で解放する。ロック取得失敗時は `LockError` を throw し、この例外は `processMessage` の `.catch()` で捕捉されてログに記録される。

ロックの実装は `StateAdapter` インターフェースで抽象化され、メモリ版（開発用）と Redis 版（本番用）がある。Redis 版は `SET NX PX` でアトミックな取得、Lua スクリプトで token 検証付きのアトミックな解放と延長を行う。

### fire-and-forget 型の非同期エラー処理

`processMessage` / `processReaction` / `processAction` などの `process*` メソッド群は、内部で async タスクを開始し、`.catch()` でエラーをログに記録する。これは Webhook レスポンスを即座に返す（200 OK を返した後にバックグラウンドで処理する）serverless 環境向けの設計。`waitUntil` が提供されていればタスクの完了を保証する。

### Webhook 署名検証のセキュリティパターン

4つのアダプター（Slack, GitHub, Linear, Discord）がそれぞれ独自の署名検証を実装しているが、共通のセキュリティパターンに従う:

1. Slack / GitHub / Linear: HMAC-SHA256 + `timingSafeEqual` でタイミング攻撃を防止
2. Discord: Ed25519 + `discord-interactions` ライブラリの `verifyKey`
3. 全アダプター共通: 検証失敗時は `return false`（例外をクライアントに漏洩しない）
4. Slack 固有: タイムスタンプの鮮度チェック（5分以内）でリプレイ攻撃を防止

### 段階的フォールバック戦略

SDK は複数のフォールバック戦略を持つ:

1. **ストリーミング**: アダプターが `stream` メソッドを実装していれば利用 → なければ `fallbackStream`（post + throttled edit）
2. **エフェメラルメッセージ**: アダプターが `postEphemeral` を実装していれば利用 → なければ `openDM` で DM フォールバック → それもなければ `null` を返す
3. **フォールバック結果の通知**: `EphemeralMessage` の `usedFallback: boolean` フィールドで、呼び出し元がフォールバックの発生を検知できる

## コード例

### コア層エラー定義（構造化フィールドで文脈を保持）

```typescript
// packages/chat/src/errors.ts:5-14
export class ChatError extends Error {
  readonly code: string;
  override readonly cause?: unknown;

  constructor(message: string, code: string, cause?: unknown) {
    super(message);
    this.name = "ChatError";
    this.code = code;
    this.cause = cause;
  }
}
```

### アダプター層エラー変換（Teams の網羅的パターン）

```typescript
// packages/adapter-teams/src/index.ts:2310-2368
private handleTeamsError(error: unknown, operation: string): never {
  if (error && typeof error === "object") {
    const err = error as Record<string, unknown>;
    const statusCode =
      (err.statusCode as number) ||
      (err.status as number) ||
      (err.code as number);

    if (statusCode === 401 || statusCode === 403) {
      throw new AuthenticationError(
        "teams",
        `Authentication failed for ${operation}: ${err.message || "unauthorized"}`
      );
    }
    if (statusCode === 429) {
      const retryAfter =
        typeof err.retryAfter === "number" ? err.retryAfter : undefined;
      throw new AdapterRateLimitError("teams", retryAfter);
    }
    // ... 他の分岐
  }
  // フォールバック: 未知のエラーは NetworkError に変換
  throw new NetworkError(
    "teams",
    `Teams API error during ${operation}: ${String(error)}`,
    error instanceof Error ? error : undefined
  );
}
```

### ロックの取得-処理-解放パターン（try-finally）

```typescript
// packages/chat/src/chat.ts:1476-1564
const lock = await this._stateAdapter.acquireLock(
  threadId,
  DEFAULT_LOCK_TTL_MS,
);
if (!lock) {
  throw new LockError(
    `Could not acquire lock on thread ${threadId}. Another instance may be processing.`,
  );
}

try {
  // ... メッセージ処理
} finally {
  await this._stateAdapter.releaseLock(lock);
}
```

### 署名検証の安全な失敗（Slack）

```typescript
// packages/adapter-slack/src/index.ts:1072-1104
private verifySignature(
  body: string,
  timestamp: string | null,
  signature: string | null
): boolean {
  if (!(timestamp && signature)) {
    return false;
  }
  // リプレイ攻撃防止
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number.parseInt(timestamp, 10)) > 300) {
    return false;
  }
  const sigBasestring = `v0:${timestamp}:${body}`;
  const expectedSignature = "v0=" +
    createHmac("sha256", this.signingSecret)
      .update(sigBasestring)
      .digest("hex");
  try {
    return timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch {
    // バッファ長不一致などの例外を安全に処理
    return false;
  }
}
```

### 段階的フォールバック（エフェメラルメッセージ）

```typescript
// packages/chat/src/thread.ts:353-398
async postEphemeral(
  user: string | Author,
  message: AdapterPostableMessage | CardJSXElement,
  options: PostEphemeralOptions
): Promise<EphemeralMessage | null> {
  const { fallbackToDM } = options;
  const userId = typeof user === "string" ? user : user.userId;

  // Step 1: ネイティブ機能があれば使う
  if (this.adapter.postEphemeral) {
    return this.adapter.postEphemeral(this.id, userId, postable);
  }

  // Step 2: フォールバックが許可されていなければ null
  if (!fallbackToDM) {
    return null;
  }

  // Step 3: DM フォールバック
  if (this.adapter.openDM) {
    const dmThreadId = await this.adapter.openDM(userId);
    const result = await this.adapter.postMessage(dmThreadId, postable);
    return {
      id: result.id, threadId: dmThreadId,
      usedFallback: true,  // 呼び出し元にフォールバック発生を通知
      raw: result.raw,
    };
  }

  return null;
}
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: プラットフォームごとに異なるエラー形式を統一的に処理する
  - 適用条件: 外部 API との統合で、エラー形式がプロバイダーごとに異なる場合
  - コード例: `packages/adapter-slack/src/index.ts:2829` (`handleSlackError`), `packages/adapter-teams/src/index.ts:2310` (`handleTeamsError`), `packages/adapter-gchat/src/index.ts:2468` (`handleGoogleChatError`)
  - 注意点: 変換関数の戻り値型を `never` にすることで、コンパイラが未処理パスを検出できる

- **Chain of Responsibility パターン** (分類: 振る舞い)
  - 解決する問題: ある機能が利用不可の場合に、段階的に代替手段を試行する
  - 適用条件: プラットフォームのケイパビリティが異なる SDK でのフォールバック
  - コード例: `packages/chat/src/thread.ts:353-398` (ephemeral → DM fallback), `packages/chat/src/thread.ts:404-443` (native stream → post+edit fallback)
  - 注意点: フォールバックの発生を呼び出し元に通知する仕組み（`usedFallback` フラグ）が必要

## Good Patterns

- **エラー変換関数の戻り値型 `never`**: `handleSlackError(error: unknown): never` のように変換関数の戻り値を `never` にすることで、呼び出し元の `catch` ブロック内で return 文が不要になり、コンパイラが到達不能コードを検出できる。

```typescript
// packages/adapter-slack/src/index.ts:2829
private handleSlackError(error: unknown): never {
  const slackError = error as { data?: { error?: string }; code?: string };
  if (
    slackError.code === "slack_webapi_platform_error" &&
    slackError.data?.error === "ratelimited"
  ) {
    throw new AdapterRateLimitError("slack");
  }
  throw error;
}
```

- **Redis ロックの Lua アトミック操作**: `releaseLock` と `extendLock` で Lua スクリプトを使い、「token を検証してから操作する」を1回の往復で実行する。ネットワーク遅延による TOCTOU（Time-of-Check to Time-of-Use）問題を回避している。

```typescript
// packages/state-ioredis/src/index.ts:152-161
const script = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;
await this.client.eval(script, 1, lockKey, lock.token);
```

- **fire-and-forget + waitUntil パターン**: async タスクに `.catch()` を付けてエラーを握りつぶすが、`waitUntil` でランタイムに完了を保証させる。Webhook レスポンスを即座に返しつつ、バックグラウンド処理のエラーを見失わない。

```typescript
// packages/chat/src/chat.ts:667-686
processMessage(adapter, threadId, messageOrFactory, options): void {
  const task = (async () => {
    const message = typeof messageOrFactory === "function"
      ? await messageOrFactory() : messageOrFactory;
    await this.handleIncomingMessage(adapter, threadId, message);
  })().catch((err) => {
    this.logger.error("Message processing error", { error: err, threadId });
  });
  if (options?.waitUntil) {
    options.waitUntil(task);
  }
}
```

## Anti-Patterns / 注意点

- **エラー変換の粒度格差**: Slack の `handleSlackError` は rate limit のみ変換して残りは生 throw するが、Teams の `handleTeamsError` は網羅的に分岐する。アダプター間で変換粒度が異なると、上位層での `instanceof` チェックの信頼性が揺らぐ。

```typescript
// Bad: Slack - rate limit 以外は生エラーが漏れる
private handleSlackError(error: unknown): never {
  if (slackError.data?.error === "ratelimited") {
    throw new AdapterRateLimitError("slack");
  }
  throw error; // Slack 固有のエラーオブジェクトがそのまま上位に到達
}

// Better: 全アダプターで最低限の正規化を行う
private handleSlackError(error: unknown): never {
  if (slackError.data?.error === "ratelimited") {
    throw new AdapterRateLimitError("slack");
  }
  if (slackError.data?.error === "not_authed" || slackError.data?.error === "invalid_auth") {
    throw new AuthenticationError("slack");
  }
  throw new NetworkError("slack", String(error), error instanceof Error ? error : undefined);
}
```

- **`catch {}` による無条件エラー抑制**: ストリーミングフォールバックの `doEditAndReschedule` 内で `catch {}` が使われ、edit エラーが完全に無視される。ログ出力すらないため、問題の検出が困難になる。

```typescript
// Bad: packages/chat/src/thread.ts:480-485
try {
  await this.adapter.editMessage(threadIdForEdits, msg.id, content);
  lastEditContent = content;
} catch {
  // Ignore errors, continue
}

// Better: エラーをログに記録しつつ継続
try {
  await this.adapter.editMessage(threadIdForEdits, msg.id, content);
  lastEditContent = content;
} catch (err) {
  this.logger.warn("Streaming edit failed, will retry on next interval", { error: err });
}
```

## 導出ルール

- `[MUST]` エラーに構造化フィールド（コード、発生元）を持たせ、メッセージ文字列の解析でエラー種別を判別しない
  - 根拠: `ChatError.code` と `AdapterError.adapter` により、`instanceof` チェックとプロパティ参照だけでエラーの種別と発生元を特定できる設計になっている（`packages/chat/src/errors.ts:6`, `packages/adapter-shared/src/errors.ts:14`）

- `[MUST]` 外部 API エラーはレイヤー境界で自ドメインのエラー型に変換し、プラットフォーム固有のエラーオブジェクトを上位層に漏洩させない
  - 根拠: `handleTeamsError` / `handleGoogleChatError` が HTTP ステータスコードベースのエラーを `AdapterError` サブクラスに変換し、上位層が全プラットフォームのエラー形式を知る必要をなくしている（`packages/adapter-teams/src/index.ts:2310`）

- `[MUST]` 分散ロックの解放は `finally` ブロックで行い、ロック token の検証はアトミック操作（Redis なら Lua スクリプト）で実行する
  - 根拠: `handleIncomingMessage` の try-finally パターン（`packages/chat/src/chat.ts:1490-1564`）と Redis の Lua アトミック操作（`packages/state-ioredis/src/index.ts:152-161`）により、ロックリークと TOCTOU 競合を同時に防止している

- `[SHOULD]` エラー変換関数の戻り値型を `never` にして、コンパイラに到達不能パスを検出させる
  - 根拠: `handleSlackError(error: unknown): never`（`packages/adapter-slack/src/index.ts:2829`）により、catch ブロック内の変換漏れをコンパイル時に検出できる

- `[SHOULD]` 機能の段階的フォールバックでは、フォールバック発生を呼び出し元に通知するフラグを返り値に含める
  - 根拠: `EphemeralMessage.usedFallback: boolean` により、DM フォールバックの発生を呼び出し元が検知してユーザー体験を調整できる（`packages/chat/src/thread.ts:391`）

- `[SHOULD]` Webhook 署名検証は timingSafeEqual を使い、例外時は `false` を返してエラー詳細をクライアントに漏洩しない
  - 根拠: 全4アダプター（Slack, GitHub, Linear, Discord）が `try { return timingSafeEqual(...) } catch { return false }` パターンを統一的に採用している

- `[SHOULD]` Webhook ハンドラでは async 処理を fire-and-forget で開始し、`waitUntil` でランタイムに完了を保証させ、即座にレスポンスを返す
  - 根拠: `processMessage` 等の `process*` メソッド群が `.catch()` でエラーをログ記録しつつ、`waitUntil` でタスク完了を保証する（`packages/chat/src/chat.ts:667-686`）

- `[AVOID]` `catch {}` での無条件エラー抑制。最低限ログに記録して問題の検出経路を確保する
  - 根拠: `fallbackStream` 内の edit エラーが `catch {}` で完全に無視されており、ストリーミングの部分的失敗が検出不能になっている（`packages/chat/src/thread.ts:483-485`）

## 適用チェックリスト

- [ ] 自プロジェクトのカスタムエラークラスに `code` や `source` などの構造化フィールドがあるか。メッセージ文字列の解析に依存していないか
- [ ] 外部 API（REST、SDK）のエラーをレイヤー境界で自ドメインのエラー型に変換しているか。プラットフォーム固有のエラーが上位層に漏れていないか
- [ ] 分散ロック（Redis, DB）の解放が `finally` ブロックにあるか。token 検証と解放がアトミックか
- [ ] エラー変換関数の戻り値型が `never` か。catch ブロック内の変換漏れがコンパイル時に検出されるか
- [ ] フォールバック処理の結果を呼び出し元が検知できるか（フラグ、異なる戻り値型など）
- [ ] Webhook 署名検証で `timingSafeEqual` を使っているか。例外時に安全な既定値（false）を返しているか
- [ ] `catch {}` で握りつぶしているエラーがないか。少なくとも warn レベルでログ出力しているか
- [ ] 非同期タスクのエラーが fire-and-forget で消失していないか。`waitUntil` や類似の仕組みで完了保証しているか
