# state-management-patterns

> リポジトリ: vercel/chat
> 分析日: 2026-02-25

## 概要

vercel/chat の状態管理層を分析した。このリポジトリでは `StateAdapter` インターフェースを通じて、サブスクリプション管理・分散ロック・汎用キャッシュ・メッセージ重複排除を統一的に扱う。注目すべきは、すべての状態操作が単一のインターフェースに集約されている点と、TTL ベースの自律的クリーンアップ設計により、明示的なガベージコレクションを不要にしている点である。3 つの実装（Redis / ioredis / Memory）が Strategy パターンで差し替え可能であり、開発/本番環境の切り替えがコード変更なしで実現されている。

## 背景にある原則

- **TTL-first の状態設計**: すべての状態エントリ（ロック・重複排除・スレッド状態・モーダルコンテキスト）に TTL が設定されており、明示的な削除操作に依存しない。ロックは 30 秒、重複排除は 5 分、モーダルコンテキストは 24 時間、スレッド状態は 30 日。これにより障害時のリソースリークを防いでいる（`packages/chat/src/chat.ts:47-52`、`packages/chat/src/types.ts:635`）

- **インターフェース分離よりインターフェース集約**: サブスクリプション・ロック・キャッシュを 3 つのインターフェースに分けず、1 つの `StateAdapter` に統合している。これはデプロイ時の設定を最小化し、すべての状態が同一バックエンドに存在することを保証する設計判断（`packages/chat/src/types.ts:454-486`）

- **Token-based 所有権検証**: 分散ロックの解放・延長時にトークンの一致を検証し、他のインスタンスのロックを誤解放しない。Redis 実装では Lua スクリプトによるアトミックな check-and-delete を採用（`packages/state-redis/src/index.ts:113-124`）

- **接続の遅延初期化と重複排除**: 全アダプタが `connectPromise` パターンで接続を遅延初期化し、複数箇所からの同時 `connect()` 呼び出しが 1 回の接続処理に集約される（`packages/state-redis/src/index.ts:52-58`、`packages/chat/src/chat.ts:264-275`）

## 実例と分析

### StateAdapter インターフェースの 3 層構造

StateAdapter は見た目上フラットだが、論理的に 3 つの機能層を持つ。

1. **サブスクリプション層** (`subscribe` / `unsubscribe` / `isSubscribed`): スレッドへの永続的な購読状態を管理。Redis 実装では Set データ構造 (`SADD` / `SREM` / `SISMEMBER`) を使用。
2. **ロック層** (`acquireLock` / `releaseLock` / `extendLock`): 分散排他制御。Redis の `SET NX PX` によるアトミックな取得と Lua スクリプトによるアトミックな解放。
3. **汎用キャッシュ層** (`get` / `set` / `delete`): ジェネリック型パラメータ付きの KV ストア。重複排除・スレッド状態・モーダルコンテキストなど異なる用途に同一 API で対応。

特筆すべきは、重複排除やモーダルコンテキストといった関心事が StateAdapter の「利用者」側で実現されている点である。StateAdapter 自体はドメイン知識を持たず、純粋なプリミティブ（Set 操作・ロック・KV）を提供する。

### acquireLock → handler → releaseLock の try-finally パターン

`Chat.handleIncomingMessage` メソッドは、メッセージ処理全体をロックで保護する。ロック取得に失敗すると `LockError` をスローし、try-finally で確実にロックを解放する。

```typescript
// packages/chat/src/chat.ts:1477-1563
const lock = await this._stateAdapter.acquireLock(
  threadId,
  DEFAULT_LOCK_TTL_MS, // 30 seconds
);
if (!lock) {
  throw new LockError(
    `Could not acquire lock on thread ${threadId}. Another instance may be processing.`,
  );
}

try {
  // ... message processing logic ...
} finally {
  await this._stateAdapter.releaseLock(lock);
}
```

この設計により、同一スレッドへの並行メッセージ処理を防止し、状態の一貫性を保証している。ロックは TTL 付きのため、プロセスクラッシュ時も 30 秒後に自動解放される。

### 重複排除 (Deduplication)

Webhook ベースのチャットシステムでは同一メッセージが複数パスで到着しうる（Slack の `message` イベントと `app_mention` イベント、Google Chat のダイレクト Webhook と Pub/Sub など）。ロック取得前に StateAdapter の KV 層で重複チェックを行う。

```typescript
// packages/chat/src/chat.ts:1465-1474
const dedupeKey = `dedupe:${adapter.name}:${message.id}`;
const alreadyProcessed = await this._stateAdapter.get<boolean>(dedupeKey);
if (alreadyProcessed) {
  return; // skip
}
await this._stateAdapter.set(dedupeKey, true, this._dedupeTtlMs);
```

TTL は `DEDUPE_TTL_MS = 5 * 60 * 1000`（5 分）だが、`ChatConfig.dedupeTtlMs` で上書き可能。JSDoc で「webhook cold starts cause platform retries that arrive after the default TTL expires」と言及し、TTL の設計根拠と変更タイミングを明示している。

### スレッド状態のマージセマンティクス

`Thread.setState` はデフォルトで既存状態とのシャローマージを行う。`{ replace: true }` を渡すと完全上書きになる。これにより部分更新が簡潔に書ける。

```typescript
// packages/chat/src/thread.ts:201-216
async setState(
  newState: Partial<TState>,
  options?: { replace?: boolean }
): Promise<void> {
  const key = `${THREAD_STATE_KEY_PREFIX}${this.id}`;

  if (options?.replace) {
    await this._stateAdapter.set(key, newState, THREAD_STATE_TTL_MS);
  } else {
    const existing = await this._stateAdapter.get<TState>(key);
    const merged = { ...existing, ...newState };
    await this._stateAdapter.set(key, merged, THREAD_STATE_TTL_MS);
  }
}
```

`THREAD_STATE_TTL_MS` は 30 日。スレッド状態が永久に残らないよう、暗黙の有効期限が設定されている。

### 接続 Promise の共有 (Connection Coalescing)

3 つの StateAdapter 実装すべてが同一のパターンで接続を管理する。

```typescript
// packages/state-redis/src/index.ts:46-58
async connect(): Promise<void> {
  if (this.connected) {
    return;
  }
  if (!this.connectPromise) {
    this.connectPromise = this.client.connect().then(() => {
      this.connected = true;
    });
  }
  await this.connectPromise;
}
```

`connected` フラグで接続済み判定、`connectPromise` で進行中の接続試行を共有。これにより、複数箇所から同時に `connect()` が呼ばれても実際の接続は 1 回で済む。

### ownsClient パターン（リソース所有権の明示化）

IoRedisStateAdapter は外部から既存クライアントを注入する場合と内部で作成する場合を区別し、`disconnect()` 時にリソースを適切に管理する。

```typescript
// packages/state-ioredis/src/index.ts:46-53
constructor(options: IoRedisStateAdapterOptions | IoRedisStateClientOptions) {
  if ("client" in options) {
    this.client = options.client;
    this.ownsClient = false;  // 外部所有 → disconnect しない
  } else {
    this.client = new Redis(options.url);
    this.ownsClient = true;   // 自己所有 → disconnect する
  }
}
```

```typescript
// packages/state-ioredis/src/index.ts:100-106
async disconnect(): Promise<void> {
  if (this.connected && this.ownsClient) {
    await this.client.quit();
    this.connected = false;
    this.connectPromise = null;
  }
}
```

## コード例

```typescript
// packages/chat/src/types.ts:454-486 — StateAdapter インターフェース全体
export interface StateAdapter {
  acquireLock(threadId: string, ttlMs: number): Promise<Lock | null>;
  connect(): Promise<void>;
  delete(key: string): Promise<void>;
  disconnect(): Promise<void>;
  extendLock(lock: Lock, ttlMs: number): Promise<boolean>;
  get<T = unknown>(key: string): Promise<T | null>;
  isSubscribed(threadId: string): Promise<boolean>;
  releaseLock(lock: Lock): Promise<void>;
  set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void>;
  subscribe(threadId: string): Promise<void>;
  unsubscribe(threadId: string): Promise<void>;
}
```

```typescript
// packages/state-redis/src/index.ts:84-105 — Redis SET NX PX による分散ロック取得
async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
  this.ensureConnected();
  const token = generateToken();
  const lockKey = this.key("lock", threadId);
  const acquired = await this.client.set(lockKey, token, {
    NX: true,
    PX: ttlMs,
  });
  if (acquired) {
    return { threadId, token, expiresAt: Date.now() + ttlMs };
  }
  return null;
}
```

```typescript
// packages/state-redis/src/index.ts:107-125 — Lua スクリプトによるアトミックなロック解放
async releaseLock(lock: Lock): Promise<void> {
  this.ensureConnected();
  const lockKey = this.key("lock", lock.threadId);
  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;
  await this.client.eval(script, {
    keys: [lockKey],
    arguments: [lock.token],
  });
}
```

```typescript
// packages/chat/src/chat.ts:970-993 — モーダルコンテキストの TTL 付き保存
private storeModalContext(
  adapterName: string,
  contextId: string,
  thread?: ThreadImpl<TState>,
  message?: Message,
  channel?: ChannelImpl<TState>
): void {
  const key = `modal-context:${adapterName}:${contextId}`;
  const context: StoredModalContext = {
    thread: thread?.toJSON(),
    message: message?.toJSON(),
    channel: channel?.toJSON(),
  };
  this._stateAdapter.set(key, context, MODAL_CONTEXT_TTL_MS).catch((err) => {
    this.logger.error("Failed to store modal context", { contextId, error: err });
  });
}
```

```typescript
// packages/state-memory/src/index.ts:70-88 — Memory アダプタのロック取得（期限切れ自動クリーン付き）
async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
  this.ensureConnected();
  this.cleanExpiredLocks();
  const existingLock = this.locks.get(threadId);
  if (existingLock && existingLock.expiresAt > Date.now()) {
    return null;
  }
  const lock: MemoryLock = {
    threadId,
    token: generateToken(),
    expiresAt: Date.now() + ttlMs,
  };
  this.locks.set(threadId, lock);
  return lock;
}
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 状態管理バックエンドを環境（開発/本番）やインフラ（Redis / ioredis / Memory）に応じて切り替える
  - 適用条件: 複数のバックエンド実装が必要で、利用側コードを変更せずに切り替えたい場合
  - コード例: `StateAdapter` インターフェース (`types.ts:454-486`) と 3 実装 (`state-redis/`, `state-ioredis/`, `state-memory/`)
  - 注意点: インターフェースのメソッドは全実装で意味のあるセマンティクスを持つ必要がある。Memory 実装の `connect()` が形式的な no-op になっているが、プロダクション警告を出すことで意味を持たせている

- **Token-based Lock パターン** (分類: 並行制御)
  - 解決する問題: 分散環境でリソースの排他的アクセスを保証しつつ、障害時にロックが永続しない
  - 適用条件: 複数プロセス/インスタンスが同一リソースを操作する可能性がある場合
  - コード例: `RedisStateAdapter.acquireLock` (`state-redis/src/index.ts:84-105`) と Lua スクリプトによる解放 (`state-redis/src/index.ts:107-125`)
  - 注意点: トークンにタイムスタンプとランダム文字列を含めて一意性を保証。`SET NX PX` はアトミックだが、解放は Lua スクリプトが必要（GET + DEL を分離すると TOCTOU が生じる）

- **Connection Coalescing パターン** (分類: リソース管理)
  - 解決する問題: 複数箇所からの同時接続要求を 1 回の実際の接続に集約する
  - 適用条件: 接続確立がコストの高い外部リソース（DB、Redis、API サーバー）を使う場合
  - コード例: 全 StateAdapter 実装の `connect()` メソッド。`connected` フラグ + `connectPromise` 保持
  - 注意点: `disconnect()` 時に `connectPromise = null` をリセットしないと再接続不可能になる

## Good Patterns

- **キー名にプレフィックスと型識別子を含めたキー設計**: Redis のキーは `${keyPrefix}:${type}:${id}` 形式で構造化されている（例: `chat-sdk:lock:slack:C123:1234.5678`）。型識別子（`sub` / `lock` / `cache`）により名前衝突を回避し、keyPrefix により同一 Redis インスタンスを複数アプリで共有可能。

```typescript
// packages/state-redis/src/index.ts:38-44
private key(type: "sub" | "lock" | "cache", id: string): string {
  return `${this.keyPrefix}:${type}:${id}`;
}
private subscriptionsSetKey(): string {
  return `${this.keyPrefix}:subscriptions`;
}
```

- **ensureConnected ガード**: 全 StateAdapter 実装が、各操作の冒頭で `ensureConnected()` を呼び、未接続状態での操作を即座にエラーにする。接続漏れによるサイレントな失敗を防止する。

```typescript
// packages/state-redis/src/index.ts:187-193
private ensureConnected(): void {
  if (!this.connected) {
    throw new Error(
      "RedisStateAdapter is not connected. Call connect() first."
    );
  }
}
```

- **ファクトリ関数による初期化の簡略化**: `createRedisState()` / `createIoRedisState()` / `createMemoryState()` ファクトリ関数がコンストラクタのボイラープレートを隠蔽し、環境変数のフォールバックやデフォルトロガーの設定を内部で行う。

```typescript
// packages/state-redis/src/index.ts:207-222
export function createRedisState(
  options?: Partial<RedisStateAdapterOptions>,
): RedisStateAdapter {
  const url = options?.url ?? process.env.REDIS_URL;
  if (!url) {
    throw new Error("Redis url is required. Set REDIS_URL or provide it in options.");
  }
  const resolved: RedisStateAdapterOptions = {
    url,
    keyPrefix: options?.keyPrefix,
    logger: options?.logger ?? new ConsoleLogger("info").child("redis"),
  };
  return new RedisStateAdapter(resolved);
}
```

- **サブスクリプションコンテキストによるルックアップ回避**: `ThreadImpl` は `isSubscribedContext` フラグを持ち、サブスクリプション済みスレッドのハンドラ内では `isSubscribed()` がステートアダプタを呼ばずに即座に `true` を返す。不要なネットワークラウンドトリップを回避する最適化。

```typescript
// packages/chat/src/thread.ts:301-307
async isSubscribed(): Promise<boolean> {
  if (this._isSubscribedContext) {
    return true;
  }
  return this._stateAdapter.isSubscribed(this.id);
}
```

## Anti-Patterns / 注意点

- **マージセマンティクスの非アトミック性**: `setState` のマージ操作は read-modify-write パターンであり、並行呼び出し時に一方の変更が失われる可能性がある。ロックで保護された `handleIncomingMessage` 内で使う限り問題ないが、ロック外での使用は安全でない。

```typescript
// Bad: ロック外で並行して setState を呼ぶ
// Thread A: get → {a: 1}        → merge {b: 2}  → set {a: 1, b: 2}
// Thread B: get → {a: 1}        → merge {c: 3}  → set {a: 1, c: 3}
// 結果: {a: 1, c: 3} — Thread A の変更が消失

// Better: ロック内で setState を使う、またはアトミックな更新を提供する
const lock = await state.acquireLock(threadId, 30000);
if (lock) {
  try {
    await thread.setState({ b: 2 });
  } finally {
    await state.releaseLock(lock);
  }
}
```

- **重複排除とロック取得の順序に注意**: 現在の実装では重複排除チェック → ロック取得の順で実行される。重複排除の `set` とロック取得が別操作のため、極端なタイミングで重複排除マーカーが書かれたがロック取得に失敗し、同一メッセージが永久にスキップされるケースが理論上存在する。実際にはメッセージの再送機構で緩和されるが、クリティカルな処理では追加のリカバリ機構を検討すべき。

```typescript
// Bad: 重複排除マーカーだけ書いてロック取得失敗
await this._stateAdapter.set(dedupeKey, true, this._dedupeTtlMs); // ← 書き込み完了
const lock = await this._stateAdapter.acquireLock(threadId, ...);  // ← null が返る
// → メッセージは重複排除され、かつ処理されていない

// Better: ロック取得後に重複排除マーカーを書く、
// またはロック取得失敗時に重複排除マーカーを消す
```

- **Memory アダプタのプロダクション使用**: `MemoryStateAdapter` はプロセス再起動で全状態が失われ、マルチインスタンス間で状態を共有できない。`NODE_ENV === "production"` で警告を出しているが、起動を妨げない設計のため、うっかり本番デプロイされるリスクがある。

```typescript
// packages/state-memory/src/index.ts:35-39
if (process.env.NODE_ENV === "production") {
  console.warn(
    "[chat] MemoryStateAdapter is not recommended for production. "
      + "Consider using @chat-adapter/state-redis instead.",
  );
}
```

## 導出ルール

- `[MUST]` 分散ロックには必ず TTL を設定し、プロセスクラッシュ時の自動解放を保証する。try-finally でロック解放を行い、TTL はフォールバックとして機能させる
  - 根拠: `DEFAULT_LOCK_TTL_MS = 30_000` と try-finally パターン（`chat.ts:1477-1563`）が障害時のデッドロック防止を担保している

- `[MUST]` 分散ロックの解放時はトークンの一致を検証し、自分が取得したロックのみ解放する。Redis では Lua スクリプトで GET + DEL をアトミックに実行する
  - 根拠: 全 StateAdapter 実装がトークンベースの所有権検証を行い、Lua スクリプトで TOCTOU 問題を回避している（`state-redis/src/index.ts:107-125`）

- `[MUST]` 状態アダプタの各操作前に接続状態を検証する。未接続での操作はサイレントに失敗させず即座にエラーをスローする
  - 根拠: 全実装の `ensureConnected()` ガードが接続漏れによるデバッグ困難な障害を防止（`state-redis/src/index.ts:187-193`）

- `[SHOULD]` 複数のバックエンド実装を持つ外部リソースアダプタでは、接続 Promise を保持して同時接続要求を 1 回に集約する（Connection Coalescing パターン）
  - 根拠: 3 実装すべてが `connectPromise` を共有して重複接続を防止。サーバーレス環境での cold start 時に特に重要

- `[SHOULD]` 外部から注入されたクライアントと内部で作成したクライアントを区別し、リソース解放の責任を明確にする（ownsClient パターン）
  - 根拠: IoRedisStateAdapter が `ownsClient` フラグで外部クライアントの意図しない切断を防止（`state-ioredis/src/index.ts:44-53, 100-106`）

- `[SHOULD]` KV ストアのキーは `{prefix}:{type}:{id}` 形式で構造化し、名前空間衝突を防止する。プレフィックスは設定可能にして同一インスタンスの共有を許容する
  - 根拠: `key()` メソッドの `${this.keyPrefix}:${type}:${id}` 設計（`state-redis/src/index.ts:38-40`）

- `[SHOULD]` Webhook 駆動のシステムではメッセージ重複排除を TTL 付き KV で行い、TTL はコールドスタートによるリトライ到着を考慮して設計する。TTL はユーザーが設定変更できるようにする
  - 根拠: `DEDUPE_TTL_MS` が `ChatConfig.dedupeTtlMs` で上書き可能な設計（`chat.ts:216`, `types.ts:39-43`）

- `[AVOID]` ロックで保護されていないコンテキストで read-modify-write パターンの状態更新を行うこと。シャローマージはアトミックでないため、並行書き込みでデータが消失する
  - 根拠: `Thread.setState` のマージ操作は `handleIncomingMessage` のロック内で使う前提で設計されている（`thread.ts:201-216`）

## 適用チェックリスト

- [ ] 外部リソース（DB / Redis / API）のアダプタに接続前ガード（`ensureConnected`）を実装しているか
- [ ] 分散ロックに TTL を設定し、try-finally で解放しているか
- [ ] ロック解放時にトークンベースの所有権検証を行っているか（Redis なら Lua スクリプト）
- [ ] 複数箇所から同時に呼ばれる `connect()` が Connection Coalescing されているか
- [ ] 状態エントリに適切な TTL を設定し、明示的な削除に依存しない設計になっているか
- [ ] KV ストアのキーが構造化されており（prefix:type:id）、名前空間衝突を防止しているか
- [ ] 外部注入リソースと内部作成リソースの所有権が明確か（disconnect 時の責任分担）
- [ ] Webhook 重複排除の TTL がコールドスタート・リトライ間隔を考慮した値か
- [ ] 状態管理バックエンドの切り替えがコード変更なし（設定変更のみ）で可能か
- [ ] 開発用アダプタ（Memory）が本番環境で使用されないよう警告またはガードがあるか
