# Architecture

> リポジトリ: vercel/chat
> 分析日: 2026-02-25

## 概要

vercel/chat は 6 つのチャットプラットフォーム（Slack, Teams, Discord, Google Chat, GitHub, Linear）を単一の API で統合する SDK であり、Adapter パターンを中心としたレイヤードアーキテクチャが全体を貫いている。注目すべきは、コアパッケージ（`chat`）がプラットフォーム固有のコードを一切含まず、インターフェースのみで抽象化境界を定義し、型レベルで依存方向を強制している点である。mdast AST を正規化表現として採用したメッセージ変換パイプラインと、StateAdapter による状態管理の分離も特筆に値する。

## 背景にある原則

- **依存性逆転の徹底**: コアパッケージ `chat` はインターフェース（`Adapter`, `StateAdapter`, `FormatConverter`）を定義するだけで、具体的な実装を知らない。アダプター・状態管理パッケージが `chat` を参照する方向でのみ依存が流れる。これにより、新しいプラットフォームの追加がコアの変更なしに可能になる（根拠: 全アダプターの `package.json` が `"chat"` を `dependencies` に持ち、逆方向の依存は存在しない）。

- **正規化された中間表現による変換の分離**: プラットフォーム固有のメッセージフォーマットを直接変換するのではなく、mdast AST を正規表現として経由させることで `O(n)` の変換器で `n` プラットフォームをカバーする。`FormatConverter` インターフェースが `toAst` / `fromAst` の 2 メソッドを要求し、各アダプターはこの契約のみを満たせばよい（根拠: `packages/chat/src/markdown.ts:291-308` の `FormatConverter` インターフェース定義）。

- **オプショナルケイパビリティによる段階的適合**: `Adapter` インターフェースは必須メソッド（`postMessage`, `fetchMessages` 等）と任意メソッド（`stream?`, `openModal?`, `postEphemeral?` 等）を明確に分離している。コア側は `if (adapter.stream)` のようなケイパビリティチェックでフォールバック戦略を自動選択する。これにより、プラットフォームごとの機能差を無理なく吸収できる（根拠: `packages/chat/src/thread.ts:419-443` のストリーミングフォールバック）。

- **共有ユーティリティによるアダプター間の DRY**: `@chat-adapter/shared` パッケージがカード変換、バッファ操作、エラー型など横断的関心事をまとめ、各アダプターの実装重複を排除する。ただしプラットフォーム固有ロジック（webhook 検証、API 呼び出し）はアダプターに残す（根拠: `packages/adapter-shared/src/index.ts` の export 一覧）。

## 実例と分析

### レイヤー構成と依存方向

全パッケージの依存関係を整理すると、明確な 4 層構造が浮かび上がる。

```
┌──────────────────────────────────────────┐
│  Layer 4: Applications / Examples        │
│  examples/nextjs-chat                    │
├──────────────────────────────────────────┤
│  Layer 3: Platform Adapters              │
│  adapter-slack, adapter-teams,           │
│  adapter-discord, adapter-gchat,         │
│  adapter-github, adapter-linear          │
├──────────────────────────────────────────┤
│  Layer 2: Shared Utilities + State       │
│  adapter-shared, state-redis,            │
│  state-ioredis, state-memory             │
├──────────────────────────────────────────┤
│  Layer 1: Core SDK                       │
│  packages/chat (interfaces + core logic) │
└──────────────────────────────────────────┘
```

依存方向は常に上から下へ流れる。Layer 3 のアダプターは Layer 1 のインターフェースに依存し、Layer 2 の shared ユーティリティを利用する。Layer 1 は外部クレートとして `mdast`, `unified`, `@workflow/serde` のみに依存する。

### インターフェースによる抽象化境界

3 つの主要インターフェースがレイヤー間の契約を形成する。

**Adapter インターフェース** — プラットフォームアダプターの契約。30 以上のメソッドを定義し、必須・任意を `?` で明示する。ジェネリクス `<TThreadId, TRawMessage>` でプラットフォーム固有の型を安全に扱う。

**StateAdapter インターフェース** — 状態管理の契約。`connect`, `subscribe`, `acquireLock`, `get/set` など 11 メソッドで KVS + 分散ロック + Pub/Sub 購読を抽象化する。Memory/Redis/ioRedis の 3 実装が同じインターフェースを満たす。

**FormatConverter インターフェース** — メッセージフォーマット変換の契約。`toAst` / `fromAst` の 2 メソッドで mdast AST との相互変換を抽象化する。

### メッセージフローにおけるアダプターの役割分担

メッセージの受信から処理までのフローで、各レイヤーの責務が明確に分離されている。

1. **Platform → Adapter**: Webhook リクエストを受信し、プラットフォーム固有の検証（署名検証等）を行う
2. **Adapter → Chat**: `chat.processMessage(adapter, threadId, message)` で正規化済みメッセージをコアに渡す
3. **Chat (Core)**: 重複排除、ロック取得、購読チェック、ハンドラーディスパッチを行う
4. **Chat → Thread → Adapter**: ハンドラーが `thread.post()` 等を呼ぶと、Thread が Adapter の `postMessage` を呼び出す

このフローにおいて、Adapter はコアのロジック（重複排除、ロック等）を知る必要がなく、コアは Adapter のプラットフォーム固有処理を知る必要がない。

### ファクトリ関数パターンによる構成

各アダプター・状態管理パッケージは `create*` ファクトリ関数をエクスポートし、コンストラクタの直接呼び出しを隠蔽する。

```typescript
// adapter-slack → createSlackAdapter()
// adapter-teams → createTeamsAdapter()
// state-redis → createRedisState()
// state-memory → createMemoryState()
```

`Chat` クラスのコンストラクタは `ChatConfig<TAdapters>` を受け取り、アダプターの型推論を自動化する。

### 循環依存の回避: chat-singleton パターン

`chat.ts` と `thread.ts` の間で循環依存が生じうる問題を、`chat-singleton.ts` モジュールが解決している。Thread はデシリアライズ時に Chat インスタンスのアダプター参照が必要だが、Chat クラスを直接 import するのではなく、最小インターフェース `ChatSingleton` を経由する。

## コード例

```typescript
// packages/chat/src/types.ts:90-314
// Adapter インターフェース: 必須メソッドと任意メソッドの混在
export interface Adapter<TThreadId = unknown, TRawMessage = unknown> {
  // 必須: すべてのアダプターが実装
  postMessage(threadId: string, message: AdapterPostableMessage): Promise<RawMessage<TRawMessage>>;
  fetchMessages(threadId: string, options?: FetchOptions): Promise<FetchResult<TRawMessage>>;
  parseMessage(raw: TRawMessage): Message<TRawMessage>;
  handleWebhook(request: Request, options?: WebhookOptions): Promise<Response>;
  // 任意: プラットフォームが対応する場合のみ
  stream?(
    threadId: string,
    textStream: AsyncIterable<string>,
    options?: StreamOptions,
  ): Promise<RawMessage<TRawMessage>>;
  openModal?(triggerId: string, modal: ModalElement, contextId?: string): Promise<{ viewId: string; }>;
  postEphemeral?(threadId: string, userId: string, message: AdapterPostableMessage): Promise<EphemeralMessage>;
  // ...
}
```

```typescript
// packages/chat/src/thread.ts:419-443
// ケイパビリティチェックによる戦略選択
private async handleStream(textStream: AsyncIterable<string>): Promise<SentMessage> {
  const options: StreamOptions = {};
  // ...context extraction...

  // Use native streaming if adapter supports it
  if (this.adapter.stream) {
    // ...wrap stream and delegate to adapter...
    const raw = await this.adapter.stream(this.id, wrappedStream, options);
    return this.createSentMessage(raw.id, accumulated, raw.threadId);
  }

  // Fallback: post + edit with throttling
  return this.fallbackStream(textStream, options);
}
```

```typescript
// packages/chat/src/markdown.ts:291-308
// FormatConverter: AST を正規表現とする変換契約
export interface FormatConverter {
  extractPlainText(platformText: string): string;
  fromAst(ast: Root): string; // AST → プラットフォームフォーマット
  toAst(platformText: string): Root; // プラットフォームフォーマット → AST
}
```

```typescript
// packages/chat/src/chat.ts:1437-1565
// handleIncomingMessage: コアが横断的関心事を集約
async handleIncomingMessage(adapter: Adapter, threadId: string, message: Message): Promise<void> {
  if (message.author.isMe) return;            // 自身のメッセージスキップ
  // 重複排除
  const dedupeKey = `dedupe:${adapter.name}:${message.id}`;
  const alreadyProcessed = await this._stateAdapter.get<boolean>(dedupeKey);
  if (alreadyProcessed) return;
  await this._stateAdapter.set(dedupeKey, true, this._dedupeTtlMs);
  // ロック取得
  const lock = await this._stateAdapter.acquireLock(threadId, DEFAULT_LOCK_TTL_MS);
  if (!lock) throw new LockError(/*...*/);
  try {
    message.isMention = message.isMention || this.detectMention(adapter, message);
    const isSubscribed = await this._stateAdapter.isSubscribed(threadId);
    const thread = await this.createThread(adapter, threadId, message, isSubscribed);
    if (isSubscribed) { await this.runHandlers(this.subscribedMessageHandlers, thread, message); return; }
    if (message.isMention) { await this.runHandlers(this.mentionHandlers, thread, message); return; }
    // パターンマッチ...
  } finally {
    await this._stateAdapter.releaseLock(lock);
  }
}
```

```typescript
// packages/chat/src/chat-singleton.ts:1-52
// 循環依存回避のための最小インターフェース
export interface ChatSingleton {
  getAdapter(name: string): Adapter | undefined;
  getState(): StateAdapter;
}
let _singleton: ChatSingleton | null = null;
export function setChatSingleton(chat: ChatSingleton): void {
  _singleton = chat;
}
export function getChatSingleton(): ChatSingleton {
  if (!_singleton) throw new Error("No Chat singleton registered.");
  return _singleton;
}
```

## パターンカタログ

- **Adapter パターン** (分類: 構造)
  - 解決する問題: 6 つの異なるチャットプラットフォーム API を統一インターフェースで扱う
  - 適用条件: 同じ操作（メッセージ送受信等）を異なる外部サービスに対して行う必要がある場合
  - コード例: `packages/chat/src/types.ts:90` の `Adapter` インターフェース、各 `adapter-*` パッケージの実装
  - 注意点: 任意メソッドの導入により、典型的な Adapter パターンを拡張してケイパビリティの差を吸収している

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: プラットフォームごとのストリーミング対応有無に応じて処理戦略を切り替える
  - 適用条件: 同じ目的（ストリーミング表示）を異なるアルゴリズム（ネイティブ API / post+edit フォールバック）で達成する場合
  - コード例: `packages/chat/src/thread.ts:404-443` の `handleStream` メソッド
  - 注意点: 明示的な Strategy クラスではなく、ケイパビリティチェック (`if (adapter.stream)`) でインラインに切り替えている

- **Singleton パターン** (分類: 生成)
  - 解決する問題: Thread/Channel のデシリアライズ時に Chat インスタンスへの参照を解決する
  - 適用条件: 直列化/非直列化をまたいでオブジェクトグラフを再構築する必要がある場合
  - コード例: `packages/chat/src/chat-singleton.ts`
  - 注意点: グローバル状態のリスクを最小化するため、最小インターフェース `ChatSingleton` に絞っている

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: フォーマット変換のアルゴリズム骨格を共有しつつ、プラットフォーム固有の変換ロジックをオーバーライドさせる
  - 適用条件: 変換処理の前後処理（AST の走査、結合）は共通で、個別ノードの変換だけが異なる場合
  - コード例: `packages/chat/src/markdown.ts:323-346` の `BaseFormatConverter.fromAstWithNodeConverter`
  - 注意点: 抽象クラスだが `renderPostable` のデフォルト実装を持ち、必要な場合のみオーバーライド可能

## Good Patterns

- **インターフェース内の必須/任意メソッド分離**: `Adapter` インターフェースの必須メソッド（`postMessage`, `fetchMessages`）と任意メソッド（`stream?`, `openModal?`）の混在は、プラットフォーム間の機能差を型レベルで表現する優れたアプローチ。利用側は `if (adapter.stream)` で安全にケイパビリティをチェックでき、未対応プラットフォームに対して自動的にフォールバックが走る。

```typescript
// packages/chat/src/thread.ts:353-397
// postEphemeral のフォールバックチェーン
async postEphemeral(user, message, options): Promise<EphemeralMessage | null> {
  if (this.adapter.postEphemeral) {
    return this.adapter.postEphemeral(this.id, userId, postable);  // ネイティブ
  }
  if (!fallbackToDM) return null;
  if (this.adapter.openDM) {
    const dmThreadId = await this.adapter.openDM(userId);
    const result = await this.adapter.postMessage(dmThreadId, postable);
    return { id: result.id, threadId: dmThreadId, usedFallback: true, raw: result.raw };
  }
  return null;  // どちらも非対応
}
```

- **2 層エラー階層**: コアの `ChatError` 系（`LockError`, `RateLimitError`, `NotImplementedError`）とアダプター共有の `AdapterError` 系（`AdapterRateLimitError`, `NetworkError`, `ValidationError`, `AuthenticationError`）を分離し、それぞれのレイヤーに適したエラーハンドリングを可能にしている。

```typescript
// packages/chat/src/errors.ts:5-42
export class ChatError extends Error {
  readonly code: string; /* ... */
}
export class RateLimitError extends ChatError {
  readonly retryAfterMs?: number; /* ... */
}

// packages/adapter-shared/src/errors.ts:13-28
export class AdapterError extends Error {
  readonly adapter: string;
  readonly code?: string; /* ... */
}
export class AdapterRateLimitError extends AdapterError {
  readonly retryAfter?: number; /* ... */
}
```

- **遅延初期化と接続プロミス再利用**: 複数の箇所で見られるパターンとして、`connectPromise` フィールドを使って同時接続リクエストをひとつのプロミスに合流させている。State adapter、Chat インスタンスの初期化で一貫して適用されている。

```typescript
// packages/state-redis/src/index.ts:46-59
async connect(): Promise<void> {
  if (this.connected) return;
  if (!this.connectPromise) {
    this.connectPromise = this.client.connect().then(() => { this.connected = true; });
  }
  await this.connectPromise;
}
```

## Anti-Patterns / 注意点

- **Singleton 依存によるテスタビリティのリスク**: `chat-singleton.ts` のグローバル変数は循環依存を解消するが、テスト間で状態がリークする可能性がある。`clearChatSingleton` が `@internal` として用意されているが、テスト以外でリセットが呼ばれるとランタイムエラーになる。

```typescript
// Bad: テスト間で singleton がリークする
test("test A", () => {
  chat.registerSingleton(); /* ... */
});
test("test B", () => {
  ThreadImpl.fromJSON(data); /* test A の singleton を参照してしまう */
});

// Better: テストごとに明示的にリセットする
afterEach(() => {
  clearChatSingleton();
});
```

- **extractMessageContent の型分岐の冗長化**: `thread.ts` と `channel.ts` で同一の `extractMessageContent` 関数が重複定義されている。`PostableMessage` の判定が `"raw" in message`, `"markdown" in message`, `"ast" in message`, `"card" in message` と文字列ベースの分岐に頼っており、Discriminated Union の `type` フィールドを持つ型設計であればより安全になる。

```typescript
// Bad: 文字列ベースのプロパティ存在チェック
if ("raw" in message) { /* ... */ }
if ("markdown" in message) { /* ... */ }
if ("card" in message) { /* ... */ }

// Better: Discriminated Union
type PostableMessage =
  | { kind: "raw"; raw: string; }
  | { kind: "markdown"; markdown: string; }
  | { kind: "card"; card: CardElement; };
```

## 導出ルール

- `[MUST]` マルチプラットフォーム統合では、コアパッケージがインターフェースのみを定義し、プラットフォーム固有の実装パッケージがコアに依存する方向で依存関係を構成する
  - 根拠: vercel/chat では全アダプターが `"chat"` に依存し、逆方向の依存は存在しない。これにより新プラットフォーム追加時にコアの変更が不要になっている

- `[MUST]` 外部サービスとの接続を抽象化する際、接続の遅延初期化で同時接続リクエストを単一のプロミスに合流させる（`connectPromise` パターン）
  - 根拠: `state-redis`, `state-ioredis`, `state-memory`, `Chat.ensureInitialized` の全箇所で一貫して適用されており、レースコンディションを防止している

- `[SHOULD]` 複数の外部サービスの機能差を吸収する場合、インターフェースのメソッドを必須と任意（`?`）に分離し、利用側でケイパビリティチェック + フォールバックで対応する
  - 根拠: `Adapter` インターフェースの `stream?`, `openModal?`, `postEphemeral?` 等が任意メソッドとして定義され、`thread.ts` で `if (adapter.stream)` によるフォールバック戦略が実装されている

- `[SHOULD]` 異なるフォーマット間の変換が N 対 N になる場合、正規化された中間表現（AST 等）を導入して変換器を O(N) に抑える
  - 根拠: mdast AST を `FormatConverter` の `toAst` / `fromAst` で経由させることで、Slack mrkdwn, Discord Markdown, Teams HTML 等の相互変換を各アダプター 1 クラスのみで実現している

- `[SHOULD]` コアとアダプターで異なるエラー階層を設計し、レイヤーをまたいだエラー伝搬時に適切な抽象レベルのエラーに変換する
  - 根拠: `ChatError` 系（コア）と `AdapterError` 系（アダプター共有）の 2 層構造により、アダプター固有のエラー情報（`adapter` フィールド）をコアに漏洩させずに扱えている

- `[AVOID]` 循環依存を解消するために導入した Singleton モジュールのスコープを広げすぎる。最小インターフェースに限定し、`@internal` のリセット関数を用意する
  - 根拠: `chat-singleton.ts` は `getAdapter` と `getState` の 2 メソッドのみの `ChatSingleton` インターフェースに絞り、Chat クラスの全メソッドを露出させていない

## 適用チェックリスト

- [ ] コアパッケージがプラットフォーム固有のコードを含んでいないか確認する。依存方向が「実装 → インターフェース」の一方向になっているか
- [ ] 外部サービスとの接続抽象に `connectPromise` パターン（遅延初期化 + プロミス再利用）を適用しているか
- [ ] 複数のバックエンド/プラットフォームを統合する場合、インターフェースの必須/任意メソッドを明示的に分離し、フォールバック戦略をコア側に実装しているか
- [ ] 異なるフォーマット間の変換で正規化された中間表現を導入し、変換器の数を O(N) に抑えているか
- [ ] コア用とアダプター用のエラー階層が分離されているか。アダプター固有の情報がコアのエラーインターフェースに漏洩していないか
- [ ] 循環依存を解消するために導入した Singleton や Service Locator のスコープが最小インターフェースに限定されているか
- [ ] 横断的関心事（重複排除、ロック、ログ）がコアに集約されており、各アダプターが個別に実装していないか
