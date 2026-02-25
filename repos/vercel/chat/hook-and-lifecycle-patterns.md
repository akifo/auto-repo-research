# Hook and Lifecycle Patterns

> リポジトリ: vercel/chat
> 分析日: 2026-02-25

## 概要

vercel/chat のイベントハンドラ登録・実行順序・スレッドライフサイクル管理・subscribe/unsubscribe パターンを分析した。このリポジトリは chat SDK として複数プラットフォーム（Slack, Discord, Teams, Google Chat 等）を統合しつつ、イベントハンドラの「登録は宣言的、実行は優先順位付き」という明確な設計原則を持つ。特に、subscribe/unsubscribe による状態遷移がハンドラのディスパッチフローを分岐させる仕組みと、分散ロック・重複排除・遅延初期化を組み合わせたライフサイクル管理は、webhook 駆動型アプリケーションの設計プラクティスとして汎用性が高い。

## 背景にある原則

- **State-Driven Dispatch**: メッセージハンドラの選択をスレッドの状態（subscribed / unsubscribed）に基づいて行う。これにより、同一スレッドでもライフサイクルの段階に応じて異なるハンドラが呼ばれる。`handleIncomingMessage` 内で `isSubscribed` チェックが最初に行われ、subscribed なら他のハンドラをスキップする（`packages/chat/src/chat.ts:1496-1518`）

- **Registration-Time Simplicity, Dispatch-Time Complexity**: ハンドラ登録は `chat.onNewMention(handler)` のように1行で完結するが、ディスパッチ時には重複排除→ロック取得→状態チェック→ハンドラ選択→ロック解放の多段パイプラインを経る。この分離により、利用者は複雑な内部処理を意識せずに振る舞いを定義できる

- **Idempotent Processing**: 同一メッセージが複数経路で到着する可能性（Slack の `message` + `app_mention` イベント、GChat の直接 webhook + Pub/Sub）に対して、TTL 付きの重複排除キーで冪等性を担保する（`packages/chat/src/chat.ts:1463-1474`）

- **Lazy Initialization with Singleton Resolution**: Thread や Channel がシリアライズ後にデシリアライズされる際、Adapter への参照は Singleton 経由で遅延解決される。これにより、外部システム（ワークフローエンジン等）を跨いだオブジェクト再構築が可能になる（`packages/chat/src/thread.ts:123-131`）

## 実例と分析

### ハンドラ登録: 宣言的 API の統一パターン

Chat クラスは 10 種類のイベントハンドラ登録メソッドを提供する。これらは共通のパターンに従う。

**パターン1: 単純 push 型**（フィルタなし）

```
onNewMention, onSubscribedMessage, onAssistantThreadStarted, onAssistantContextChanged, onAppHomeOpened
```

ハンドラを配列に push するだけ。フィルタリングは実行時に Chat クラスが担う。

**パターン2: オーバーロード型**（フィルタあり）

```
onReaction, onAction, onModalSubmit, onModalClose, onSlashCommand
```

フィルタ（emoji、actionId、callbackId、command）をオプションで受け取るオーバーロードを持つ。フィルタなしで呼ぶと catch-all として動作する。

**パターン3: パターンマッチ型**

```
onNewMessage(pattern: RegExp, handler)
```

正規表現でメッセージテキストをフィルタする。複数パターンが同一メッセージにマッチ可能。

### メッセージディスパッチの実行順序

`handleIncomingMessage` は以下の優先順位でハンドラを選択する。

1. **Self-skip**: `message.author.isMe` なら即座に return
2. **Deduplication**: `dedupe:{adapter}:{messageId}` キーで重複チェック
3. **Lock acquisition**: スレッド単位の分散ロック（30秒 TTL）
4. **Subscription check**: `isSubscribed(threadId)` → true なら `subscribedMessageHandlers` を実行して **return**（以降のチェックをスキップ）
5. **Mention check**: `message.isMention` → true なら `mentionHandlers` を実行して **return**
6. **Pattern matching**: `messagePatterns` を全走査し、マッチした全ハンドラを実行
7. **Lock release**: `finally` ブロックで必ずロック解放

重要な点は、subscribed チェックが mention チェックより先にあること。subscribed スレッドでの @mention は `onNewMention` ではなく `onSubscribedMessage` で処理され、`message.isMention` フラグで判別する。

### Thread ライフサイクル: subscribe / unsubscribe

Thread の subscribe/unsubscribe はスレッドの「会話追跡」状態を制御する。

```
[unsubscribed] --subscribe()--> [subscribed] --unsubscribe()--> [unsubscribed]
```

- **unsubscribed 状態**: `onNewMention` または `onNewMessage` ハンドラが発火
- **subscribed 状態**: `onSubscribedMessage` ハンドラが発火（mention/pattern を含むすべてのメッセージ）

subscribe 時にはアダプタの `onThreadSubscribe` フックも呼ばれ、プラットフォーム固有の購読処理（Google Chat の Workspace Events 等）を差し込める。

### 初期化ライフサイクル: 遅延 + 排他

Chat クラスの初期化は最初の webhook 処理時に自動実行される（`ensureInitialized`）。

```
[未初期化] --handleWebhook()--> ensureInitialized() --doInitialize()--> [初期化済]
```

- `initPromise` フィールドで並行初期化を防止（1つの Promise を共有）
- `stateAdapter.connect()` → 各アダプタの `initialize()` を `Promise.all` で並行実行
- `shutdown()` で明示的にクリーンアップ可能

### waitUntil パターン: 非同期処理のライフサイクル分離

webhook レスポンスを即座に返しつつ、メッセージ処理をバックグラウンドで実行するための `waitUntil` パターンが全イベント処理に適用されている。

`processMessage`, `processReaction`, `processAction`, `processSlashCommand` などの `process*` メソッドは、即座に Promise を生成し `options.waitUntil` に登録する。エラーハンドリングは Promise チェーン内で行い、呼び出し元には伝播しない。

### Singleton パターンによるデシリアライゼーション

Thread/Channel/Message は `toJSON()` でシリアライズ可能。デシリアライズ時の Adapter 解決には 2 つの経路がある。

1. **明示的 Adapter 渡し**: `ThreadImpl.fromJSON(json, adapter)`
2. **Singleton 遅延解決**: `ThreadImpl.fromJSON(json)` → アクセス時に `getChatSingleton()` から解決

`@workflow/serde` の `WORKFLOW_SERIALIZE` / `WORKFLOW_DESERIALIZE` シンボルを使い、ワークフローエンジンとの統合で自動的にシリアライズ/デシリアライズが行われる。

### フィルタ付きハンドラのディスパッチ: catch-all と specific の共存

`onReaction`, `onAction`, `onSlashCommand` 等はフィルタなし（catch-all）とフィルタ付き（specific）の両方のハンドラを同時に登録できる。ディスパッチ時は全ハンドラを走査し、フィルタがマッチするもの **すべて** を実行する（最初のマッチで止まらない）。

## コード例

```typescript
// packages/chat/src/chat.ts:1437-1565
// メッセージディスパッチの全体フロー
async handleIncomingMessage(
  adapter: Adapter,
  threadId: string,
  message: Message
): Promise<void> {
  // 1. Self-skip
  if (message.author.isMe) {
    return;
  }

  // 2. Deduplication (TTL 付き)
  const dedupeKey = `dedupe:${adapter.name}:${message.id}`;
  const alreadyProcessed = await this._stateAdapter.get<boolean>(dedupeKey);
  if (alreadyProcessed) {
    return;
  }
  await this._stateAdapter.set(dedupeKey, true, this._dedupeTtlMs);

  // 3. Lock acquisition
  const lock = await this._stateAdapter.acquireLock(threadId, DEFAULT_LOCK_TTL_MS);
  if (!lock) {
    throw new LockError(`Could not acquire lock on thread ${threadId}`);
  }

  try {
    message.isMention = message.isMention || this.detectMention(adapter, message);

    // 4. State-driven dispatch: subscribed takes precedence
    const isSubscribed = await this._stateAdapter.isSubscribed(threadId);
    const thread = await this.createThread(adapter, threadId, message, isSubscribed);

    if (isSubscribed) {
      await this.runHandlers(this.subscribedMessageHandlers, thread, message);
      return;
    }

    // 5. Mention check
    if (message.isMention) {
      await this.runHandlers(this.mentionHandlers, thread, message);
      return;
    }

    // 6. Pattern matching (all matching patterns fire)
    for (const { pattern, handler } of this.messagePatterns) {
      if (pattern.test(message.text)) {
        await handler(thread, message);
      }
    }
  } finally {
    // 7. Always release lock
    await this._stateAdapter.releaseLock(lock);
  }
}
```

```typescript
// packages/chat/src/thread.ts:309-319
// subscribe/unsubscribe とアダプタフックの連携
async subscribe(): Promise<void> {
  await this._stateAdapter.subscribe(this.id);
  // Allow adapters to set up platform-specific subscriptions
  if (this.adapter.onThreadSubscribe) {
    await this.adapter.onThreadSubscribe(this.id);
  }
}

async unsubscribe(): Promise<void> {
  await this._stateAdapter.unsubscribe(this.id);
}
```

```typescript
// packages/chat/src/chat.ts:660-686
// waitUntil パターンによるバックグラウンド処理
processMessage(
  adapter: Adapter,
  threadId: string,
  messageOrFactory: Message | (() => Promise<Message>),
  options?: WebhookOptions
): void {
  const task = (async () => {
    const message =
      typeof messageOrFactory === "function"
        ? await messageOrFactory()
        : messageOrFactory;
    await this.handleIncomingMessage(adapter, threadId, message);
  })().catch((err) => {
    this.logger.error("Message processing error", { error: err, threadId });
  });

  if (options?.waitUntil) {
    options.waitUntil(task);
  }
}
```

```typescript
// packages/chat/src/chat.ts:419-436
// オーバーロードによるフィルタ付きハンドラ登録
onReaction(handler: ReactionHandler): void;
onReaction(emoji: EmojiFilter[], handler: ReactionHandler): void;
onReaction(
  emojiOrHandler: EmojiFilter[] | ReactionHandler,
  handler?: ReactionHandler
): void {
  if (typeof emojiOrHandler === "function") {
    // No emoji filter - handle all reactions
    this.reactionHandlers.push({ emoji: [], handler: emojiOrHandler });
  } else if (handler) {
    // Specific emoji filter
    this.reactionHandlers.push({ emoji: emojiOrHandler, handler });
  }
}
```

```typescript
// packages/chat/src/thread.ts:115-135, 141-162
// Lazy resolution パターン: Adapter の遅延解決
constructor(config: ThreadImplConfig) {
  if (isLazyConfig(config)) {
    // Lazy resolution mode - store adapter name for later lookup
    this._adapterName = config.adapterName;
  } else {
    // Direct mode - store adapter and state instances
    this._adapter = config.adapter;
    this._stateAdapterInstance = config.stateAdapter;
  }
}

get adapter(): Adapter {
  if (this._adapter) {
    return this._adapter;
  }
  // Lazy resolution from singleton
  const chat = getChatSingleton();
  const adapter = chat.getAdapter(this._adapterName);
  // Cache for subsequent accesses
  this._adapter = adapter;
  return adapter;
}
```

```typescript
// packages/chat/src/chat.ts:264-296
// 遅延初期化 + 排他制御
private async ensureInitialized(): Promise<void> {
  if (this.initialized) {
    return;
  }
  // Avoid concurrent initialization
  if (!this.initPromise) {
    this.initPromise = this.doInitialize();
  }
  await this.initPromise;
}

private async doInitialize(): Promise<void> {
  await this._stateAdapter.connect();
  const initPromises = Array.from(this.adapters.values()).map(
    async (adapter) => {
      await adapter.initialize(this);
    }
  );
  await Promise.all(initPromises);
  this.initialized = true;
}
```

## パターンカタログ

- **Observer パターン** (分類: 振る舞い)
  - 解決する問題: イベント発生元（Adapter/Webhook）とハンドラ（ビジネスロジック）の疎結合
  - 適用条件: 1つのイベントに対して複数のハンドラが独立して反応する必要がある場合
  - コード例: `packages/chat/src/chat.ts:185-198`（ハンドラ配列）、`packages/chat/src/chat.ts:1638-1648`（`runHandlers`）
  - 注意点: 全ハンドラが順次実行されるため、1つのハンドラのエラーが後続を止める

- **Chain of Responsibility パターン** (分類: 振る舞い)
  - 解決する問題: メッセージの種類（subscribed / mention / pattern）に応じた処理の分岐
  - 適用条件: 優先順位の異なる複数のハンドラ群があり、最初にマッチした群で処理を終了したい場合
  - コード例: `packages/chat/src/chat.ts:1496-1560`（subscribed → mention → pattern の優先順位チェーン）
  - 注意点: `return` で早期終了するため、subscribed ハンドラ内で mention の特別処理が必要なら `message.isMention` を自分でチェックする

- **Singleton パターン** (分類: 生成)
  - 解決する問題: プロセス境界を跨ぐデシリアライズ時に Chat インスタンスへの参照を解決する
  - 適用条件: シリアライズされたオブジェクトがグローバルコンテキスト（Adapter 等）を必要とする場合
  - コード例: `packages/chat/src/chat-singleton.ts:21-36`、`packages/chat/src/thread.ts:141-162`
  - 注意点: テスト時に `clearChatSingleton()` でクリーンアップが必要

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: 共通のメッセージ処理パイプライン（dedup → lock → dispatch → release）の一部をアダプタ固有の処理で差し替える
  - 適用条件: 処理の骨格は共通で、一部ステップがプラットフォームごとに異なる場合
  - コード例: `packages/chat/src/thread.ts:309-314`（subscribe 時の `onThreadSubscribe` フック）
  - 注意点: フック未実装時のデフォルト動作（no-op）を保証する

## Good Patterns

- **State-Driven Handler Selection**: subscribed/unsubscribed の状態でハンドラの発火ルートが分岐する設計。ハンドラ側は自分がどの状態で呼ばれるか気にする必要がなく、SDK 側が責任を持つ。`message.isMention` フラグの付与により、subscribed ハンドラ内でも mention の判別が可能。

```typescript
// packages/chat/src/chat.ts:1512-1518
if (isSubscribed) {
  await this.runHandlers(this.subscribedMessageHandlers, thread, message);
  return; // mention handlers are NOT called
}
```

- **Deduplication-Before-Lock**: 重複排除をロック取得の **前** に行うことで、重複メッセージによる無駄なロック待ちを防止。ロックは高コストな操作（分散ロック）であるため、安価な KV チェックで先にフィルタする。

```typescript
// packages/chat/src/chat.ts:1463-1480
const dedupeKey = `dedupe:${adapter.name}:${message.id}`;
const alreadyProcessed = await this._stateAdapter.get<boolean>(dedupeKey);
if (alreadyProcessed) return; // Lock not acquired
await this._stateAdapter.set(dedupeKey, true, this._dedupeTtlMs);
const lock = await this._stateAdapter.acquireLock(threadId, DEFAULT_LOCK_TTL_MS);
```

- **Overloaded Registration with Catch-All**: `onReaction(handler)` で全イベント、`onReaction([emoji.thumbs_up], handler)` でフィルタ付き、という API 設計。実行時は全ハンドラを走査し、catch-all と specific の両方が発火する。これにより、ロギング用 catch-all と業務処理用 specific を並行して登録できる。

```typescript
// packages/chat/src/chat.ts:419-436
onReaction(handler: ReactionHandler): void;
onReaction(emoji: EmojiFilter[], handler: ReactionHandler): void;
```

- **finally ブロックでのロック解放**: `handleIncomingMessage` のロック解放は `finally` ブロックに配置され、ハンドラ内で例外が発生しても確実に解放される。デッドロック防止の基本だが、TTL との二重保護になっている。

```typescript
// packages/chat/src/chat.ts:1561-1564
} finally {
  await this._stateAdapter.releaseLock(lock);
}
```

- **Message Factory による遅延パース**: `processMessage` は `Message | (() => Promise<Message>)` を受け取り、重複排除で棄却される可能性があるメッセージのパースを遅延させる。

```typescript
// packages/chat/src/chat.ts:673-678
const message = typeof messageOrFactory === "function"
  ? await messageOrFactory()
  : messageOrFactory;
```

## Anti-Patterns / 注意点

- **Handler Order Dependency**: `runHandlers` は配列を順次実行するため、登録順がそのまま実行順になる。ハンドラ間に暗黙の依存が生まれると、登録順の変更で挙動が変わるリスクがある。

```typescript
// Bad: ハンドラ A が thread.subscribe() し、ハンドラ B がその前提で動く
chat.onNewMention(handlerA); // subscribe() を呼ぶ
chat.onNewMention(handlerB); // handlerA の subscribe に依存
// handlerA/B の順序が変わると壊れる

// Better: 1つのハンドラ内で完結させる
chat.onNewMention(async (thread, message) => {
  await thread.subscribe();
  // 後続処理もここで行う
});
```

- **Lock TTL のハードコード**: `DEFAULT_LOCK_TTL_MS = 30_000` がハードコードされており、AI 応答のような長時間処理ではロックが期限切れになる可能性がある。`extendLock` が StateAdapter に存在するが、Chat クラスが自動的には呼ばない。

```typescript
// Bad: 30秒を超える処理でロック切れ
chat.onNewMention(async (thread, message) => {
  const result = await longRunningAICall(); // 60秒かかる
  await thread.post(result); // ロック切れ後に他のインスタンスが同時処理する可能性
});

// Better: ロック延長を明示的に管理するか、処理をバックグラウンドに分離
chat.onNewMention(async (thread, message) => {
  await thread.post("Processing...");
  // ロック解放後にバックグラウンド処理（ワークフロー等）に委譲
});
```

- **Singleton 依存のテスト困難さ**: `ThreadImpl.fromJSON()` が Singleton に依存するため、テスト時に `clearChatSingleton()` を忘れるとテスト間で状態がリークする。

```typescript
// Bad: テスト後にクリーンアップを忘れる
test("deserialize thread", () => {
  chat.registerSingleton();
  const thread = ThreadImpl.fromJSON(serialized);
  // clearChatSingleton() を忘れると次のテストに影響
});

// Better: beforeEach/afterEach でクリーンアップ
afterEach(() => {
  clearChatSingleton();
});
```

## 導出ルール

- `[MUST]` イベントハンドラのディスパッチでは、状態チェック（subscription 等）をパターンマッチングや mention チェックより先に行い、状態に応じて早期 return すること
  - 根拠: vercel/chat では subscribed チェックが最優先で、subscribed スレッドのメッセージは mention/pattern ハンドラをバイパスする。これにより、subscribed ハンドラは「このスレッドの全メッセージ」を確実に受け取れる（`chat.ts:1496-1518`）

- `[MUST]` 分散ロックを使う場合、ロック解放は `finally` ブロックに配置し、かつ TTL によるフェイルセーフを併用すること
  - 根拠: ハンドラ内の例外やプロセスクラッシュでロック解放が呼ばれない場合のデッドロックを防止する。vercel/chat は `finally` + 30秒 TTL の二重保護を採用している（`chat.ts:1477-1564`）

- `[MUST]` webhook 駆動のイベント処理では、重複排除をロック取得より先に行うこと
  - 根拠: ロックは分散システムで高コストな操作。安価な KV チェックで重複を先にフィルタすることで、不要なロック取得/解放を回避する（`chat.ts:1463-1480`）

- `[SHOULD]` フィルタ付きハンドラ登録 API はオーバーロードで「フィルタなし = catch-all」と「フィルタ付き = specific」を同一メソッドで提供し、ディスパッチ時に両方を発火させること
  - 根拠: ロギングや監査用の catch-all と業務処理用の specific を並行して登録できるようになる。vercel/chat の `onReaction`, `onAction`, `onSlashCommand` がこのパターンを統一的に実装している（`chat.ts:419-597`）

- `[SHOULD]` ハンドラの処理結果（subscribe 等の状態変更）に依存する後続処理は、別のハンドラではなく同一ハンドラ内に書くこと
  - 根拠: ハンドラは登録順に順次実行されるため、ハンドラ間の暗黙の依存は登録順の変更で壊れる。vercel/chat の設計では `onNewMention` 内で subscribe + 初期応答を1つのハンドラで完結させるのが推奨パターン

- `[SHOULD]` シリアライズ可能なオブジェクトがランタイムコンテキスト（Adapter 等）を必要とする場合、Singleton 遅延解決と明示的な依存注入の両方をサポートすること
  - 根拠: ワークフローエンジン等の外部システム経由では依存注入が困難なため Singleton が必要だが、テストでは明示的注入が望ましい。vercel/chat は `ThreadImpl.fromJSON(json)` と `ThreadImpl.fromJSON(json, adapter)` の両方を提供している（`thread.ts:573-590`）

- `[SHOULD]` webhook レスポンスの即時返却が求められる環境では、`waitUntil` パターンで処理を非同期に分離し、エラーハンドリングは Promise チェーン内で自己完結させること
  - 根拠: Vercel Functions や Cloudflare Workers のようなサーバーレス環境では、レスポンス返却後も処理を継続するために `waitUntil` が必要。エラーを呼び出し元に伝播させると webhook の 200 応答が崩れる（`chat.ts:660-686`）

- `[AVOID]` 複数ハンドラの登録順に依存した暗黙的なデータフローを作ること
  - 根拠: ハンドラは配列に push され順次実行されるが、登録順は利用者のコード構造に依存する。ハンドラ間の状態共有が必要なら、thread.state や明示的なコンテキストオブジェクトを使うべき

- `[AVOID]` ロック TTL をハードコードし、処理時間の増大に対する防御策を持たないこと
  - 根拠: AI 応答のような可変長の処理では 30秒のロック TTL が不足する場合がある。`extendLock` API は存在するが Chat クラスが自動的に呼ばないため、長時間処理には別途対策が必要（`chat.ts:47, types.ts:467`）

## 適用チェックリスト

- [ ] イベントハンドラのディスパッチに優先順位（状態チェック → 具体マッチ → catch-all）を設けているか
- [ ] 分散ロックを使う場合、`finally` + TTL の二重保護を実装しているか
- [ ] webhook 由来のメッセージに対して、TTL 付きの重複排除をロック取得 **前** に行っているか
- [ ] subscribe/unsubscribe のような状態遷移がハンドラのディスパッチフローを正しく分岐させているか
- [ ] ハンドラ登録 API が catch-all と specific フィルタの共存をサポートしているか
- [ ] シリアライズ対象オブジェクトのデシリアライズ時に、Singleton と明示的注入の両方の経路を提供しているか
- [ ] サーバーレス環境での非同期処理に `waitUntil` パターンを使い、エラーが webhook レスポンスに影響しないようにしているか
- [ ] 1つのハンドラ内で状態変更と後続処理を完結させ、ハンドラ間の暗黙的依存を排除しているか
- [ ] テストで Singleton 状態のクリーンアップ（`clearChatSingleton` 相当）を行っているか
