# API Design Practices

> リポジトリ: vercel/chat
> 分析日: 2026-02-25

## 概要

vercel/chat は Slack・Teams・Discord・Google Chat を統一的に扱うチャット SDK であり、その公開 API は「多プラットフォーム差異を吸収しつつ型安全な開発体験を提供する」という設計課題に対して、複数の洗練されたプラクティスを組み合わせている。特に `post()` の多態的シグネチャ設計、ファクトリ関数による環境変数フォールバック戦略、Interface + Impl 分離によるエクスポート制御、Discriminated Union を使ったメッセージ型設計が注目に値する。

## 背景にある原則

- **Progressive Disclosure（段階的開示）**: API の表面積を最小限に保ちつつ、高度なユースケースに対応する。最も一般的な操作（文字列の投稿）は最も簡潔に書け、複雑なケース（カード、ストリーミング）もまったく同じメソッドで扱える。`thread.post("hello")` も `thread.post(result.textStream)` も `thread.post(<Card>...</Card>)` も同一の `post()` で完結する設計がこれを体現する（`packages/chat/src/types.ts:530-531`）。

- **Interface による契約と Impl による隠蔽**: 公開型は `interface`（`Thread`, `Channel`, `Adapter`）で定義し、実装クラス（`ThreadImpl`, `ChannelImpl`）は直接インスタンス化させない。利用者はインターフェースだけに依存し、実装の詳細（遅延解決、キャッシュ、シリアライゼーション）を知る必要がない（`packages/chat/src/index.ts` のエクスポート戦略）。

- **Zero-Config with Escape Hatch**: ファクトリ関数（`createSlackAdapter()`, `createRedisState()` 等）は引数なしでも動作するよう環境変数フォールバックを備えつつ、明示的な設定によるオーバーライドを許容する。これにより「とりあえず動く」と「本番で完全制御する」を両立する（`packages/adapter-slack/src/index.ts:2966-3001`）。

- **Adapter Pattern による水平拡張**: プラットフォーム固有の機能はオプショナルメソッド（`stream?`, `openDM?`, `postEphemeral?`）として Adapter インターフェースに定義し、コアロジック側で存在チェックとフォールバックを担う。新プラットフォームの追加がコアの変更なしに可能な構造（`packages/chat/src/types.ts:90-314`）。

## 実例と分析

### 多態的 post() のシグネチャ設計

`Thread.post()` は 7 種類の入力を受け付ける:

```typescript
// packages/chat/src/types.ts:720-722
post(
  message: string | PostableMessage | CardJSXElement
): Promise<SentMessage<TRawMessage>>;
```

`PostableMessage` 自体が Discriminated Union:

```typescript
// packages/chat/src/types.ts:1003
export type PostableMessage = AdapterPostableMessage | AsyncIterable<string>;

// packages/chat/src/types.ts:984-990
export type AdapterPostableMessage =
  | string
  | PostableRaw // { raw: string }
  | PostableMarkdown // { markdown: string }
  | PostableAst // { ast: Root }
  | PostableCard // { card: CardElement }
  | CardElement; // 直接のカード要素
```

実装側では `in` 演算子による型判別を行い、各形式に応じた処理を分岐する:

```typescript
// packages/chat/src/thread.ts:321-351
async post(
  message: string | PostableMessage | CardJSXElement
): Promise<SentMessage> {
  // Handle AsyncIterable (streaming)
  if (isAsyncIterable(message)) {
    return this.handleStream(message);
  }
  // Auto-convert JSX elements to CardElement
  let postable: string | AdapterPostableMessage = message as
    | string
    | AdapterPostableMessage;
  if (isJSX(message)) {
    const card = toCardElement(message);
    if (!card) {
      throw new Error("Invalid JSX element: must be a Card element");
    }
    postable = card;
  }
  const rawMessage = await this.adapter.postMessage(this.id, postable);
  // ...
}
```

メッセージ内容の抽出も同じ Discriminated Union パターンで一貫:

```typescript
// packages/chat/src/thread.ts:737-801
function extractMessageContent(message: AdapterPostableMessage): {
  plainText: string;
  formatted: Root;
  attachments: Attachment[];
} {
  if (typeof message === "string") { /* ... */ }
  if ("raw" in message) { /* ... */ }
  if ("markdown" in message) { /* ... */ }
  if ("ast" in message) { /* ... */ }
  if ("card" in message) { /* ... */ }
  if ("type" in message && message.type === "card") { /* ... */ }
  throw new Error("Invalid PostableMessage format");
}
```

### ファクトリ関数の環境変数フォールバック戦略

各 Adapter パッケージは `create*Adapter()` ファクトリを公開し、統一されたパターンで設定解決を行う:

```typescript
// packages/adapter-slack/src/index.ts:2966-3001
export function createSlackAdapter(
  config?: Partial<SlackAdapterConfig>,
): SlackAdapter {
  const signingSecret = config?.signingSecret ?? process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    throw new ValidationError(
      "slack",
      "signingSecret is required. Set SLACK_SIGNING_SECRET or provide it in config.",
    );
  }
  // Auth fields: zero-config mode vs explicit config
  const zeroConfig = !config;
  const resolved: SlackAdapterConfig = {
    signingSecret,
    botToken: config?.botToken
      ?? (zeroConfig ? process.env.SLACK_BOT_TOKEN : undefined),
    // ...
  };
  return new SlackAdapter(resolved);
}
```

注目すべきは `zeroConfig` フラグ: `config` が `undefined`（完全未指定）のときだけ環境変数フォールバックが有効になる。部分的に config を渡した場合は、渡していないフィールドは `undefined` のままとなり、auth モードの混在を防ぐ。

同様のパターンが全アダプタで一貫:

```typescript
// packages/adapter-discord/src/index.ts:2076-2118
export function createDiscordAdapter(
  config?: Partial<DiscordAdapterConfig & { logger: Logger; userName?: string; }>,
): DiscordAdapter {/* ... */}

// packages/adapter-teams/src/index.ts:2371-2397
export function createTeamsAdapter(
  config?: Partial<TeamsAdapterConfig>,
): TeamsAdapter {/* ... */}

// packages/state-redis/src/index.ts:207-222
export function createRedisState(
  options?: Partial<RedisStateAdapterOptions>,
): RedisStateAdapter {/* ... */}
```

### イベントハンドラ登録の overload パターン

`Chat` クラスのイベントハンドラ登録メソッドは、フィルタ付き/フィルタなしの両方をオーバーロードで提供する:

```typescript
// packages/chat/src/chat.ts:419-436
onReaction(handler: ReactionHandler): void;
onReaction(emoji: EmojiFilter[], handler: ReactionHandler): void;
onReaction(
  emojiOrHandler: EmojiFilter[] | ReactionHandler,
  handler?: ReactionHandler
): void {
  if (typeof emojiOrHandler === "function") {
    this.reactionHandlers.push({ emoji: [], handler: emojiOrHandler });
  } else if (handler) {
    this.reactionHandlers.push({ emoji: emojiOrHandler, handler });
  }
}
```

`onAction`, `onSlashCommand`, `onModalSubmit` も同一パターンで統一されており、catch-all ハンドラと特定 ID フィルタの両方を自然な構文で登録できる:

```typescript
// catch-all
chat.onAction(async (event) => {/* ... */});
// 特定のアクション ID
chat.onAction("approve", async (event) => {/* ... */});
// 複数のアクション ID
chat.onAction(["approve", "reject"], async (event) => {/* ... */});
```

### SentMessage の Fluent API

`thread.post()` の戻り値 `SentMessage` はメッセージに対する操作メソッドを持ち、投稿後の編集・削除・リアクション追加をチェーンできる:

```typescript
// packages/chat/src/types.ts:928-940
export interface SentMessage<TRawMessage = unknown> extends Message<TRawMessage> {
  addReaction(emoji: EmojiValue | string): Promise<void>;
  delete(): Promise<void>;
  edit(
    newContent: string | PostableMessage | CardJSXElement,
  ): Promise<SentMessage<TRawMessage>>;
  removeReaction(emoji: EmojiValue | string): Promise<void>;
}
```

`edit()` は再び `SentMessage` を返すため、連鎖的な編集が可能:

```typescript
// examples/nextjs-chat/src/lib/bot.tsx:656-660
const response = await thread.post(`${emoji.thinking} Processing...`);
await delay(2000);
await response.edit(`${emoji.eyes} Just a little bit...`);
await delay(1000);
await response.edit(`${emoji.check} Thanks for your message!`);
```

### Postable 基底インターフェースによる共通 API の抽出

`Thread` と `Channel` の共通操作を `Postable` インターフェースに抽出し、差異だけをサブインターフェースで定義:

```typescript
// packages/chat/src/types.ts:505-559
export interface Postable<TState, TRawMessage> {
  readonly adapter: Adapter;
  readonly id: string;
  readonly isDM: boolean;
  mentionUser(userId: string): string;
  readonly messages: AsyncIterable<Message<TRawMessage>>;
  post(message: string | PostableMessage | CardJSXElement): Promise<SentMessage>;
  postEphemeral(...): Promise<EphemeralMessage | null>;
  setState(...): Promise<void>;
  startTyping(status?: string): Promise<void>;
  readonly state: Promise<TState | null>;
}

// Thread は Postable を拡張
export interface Thread<TState, TRawMessage>
  extends Postable<TState, TRawMessage> {
  allMessages: AsyncIterable<Message<TRawMessage>>;
  readonly channel: Channel<TState, TRawMessage>;
  subscribe(): Promise<void>;
  unsubscribe(): Promise<void>;
  // ...
}
```

### シリアライゼーション用の型タグ

`Thread`, `Channel`, `Message` の `toJSON()` は `_type` フィールドでシリアライズ形式を自己記述する:

```typescript
// packages/chat/src/thread.ts:548-557
toJSON(): SerializedThread {
  return {
    _type: "chat:Thread",
    id: this.id,
    channelId: this.channelId,
    // ...
  };
}
```

これにより `JSON.parse` の reviver で自動復元が可能:

```typescript
// packages/chat/src/chat.ts:640-658
reviver(): (key: string, value: unknown) => unknown {
  return function reviver(_key: string, value: unknown): unknown {
    if (value && typeof value === "object" && "_type" in value) {
      const typed = value as { _type: string };
      if (typed._type === "chat:Thread") {
        return ThreadImpl.fromJSON(value as SerializedThread);
      }
      // ...
    }
    return value;
  };
}
```

## コード例

```typescript
// packages/chat/src/types.ts:993-1003
// PostableMessage の Discriminated Union 設計
export type PostableMessage = AdapterPostableMessage | AsyncIterable<string>;
```

```typescript
// packages/chat/src/thread.ts:87-91
// 型ガード関数によるランタイム判別
function isAsyncIterable(value: unknown): value is AsyncIterable<string> {
  return (
    value !== null && typeof value === "object" && Symbol.asyncIterator in value
  );
}
```

```typescript
// packages/chat/src/chat.ts:466-484
// オーバーロードで catch-all と ID フィルタの両方を自然に提供
onAction(handler: ActionHandler): void;
onAction(actionIds: string[] | string, handler: ActionHandler): void;
onAction(
  actionIdOrHandler: string | string[] | ActionHandler,
  handler?: ActionHandler
): void {
  if (typeof actionIdOrHandler === "function") {
    this.actionHandlers.push({ actionIds: [], handler: actionIdOrHandler });
  } else if (handler) {
    const actionIds = Array.isArray(actionIdOrHandler)
      ? actionIdOrHandler
      : [actionIdOrHandler];
    this.actionHandlers.push({ actionIds, handler });
  }
}
```

```typescript
// packages/state-redis/src/index.ts:207-222
// ファクトリ関数の環境変数フォールバックパターン
export function createRedisState(
  options?: Partial<RedisStateAdapterOptions>,
): RedisStateAdapter {
  const url = options?.url ?? process.env.REDIS_URL;
  if (!url) {
    throw new Error(
      "Redis url is required. Set REDIS_URL or provide it in options.",
    );
  }
  const resolved: RedisStateAdapterOptions = {
    url,
    keyPrefix: options?.keyPrefix,
    logger: options?.logger ?? new ConsoleLogger("info").child("redis"),
  };
  return new RedisStateAdapter(resolved);
}
```

## パターンカタログ

- **Adapter パターン** (分類: 構造)
  - 解決する問題: プラットフォーム固有の API 差異を統一インターフェース下に隠蔽する
  - 適用条件: 同一の操作概念が複数の外部システムに存在し、それぞれ異なる API を持つ場合
  - コード例: `packages/chat/src/types.ts:90-314`（Adapter interface）、各 `packages/adapter-*/src/index.ts`
  - 注意点: オプショナルメソッド（`stream?`, `openDM?`）で能力差を表現し、コアがフォールバックを担う設計が鍵

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: フォーマット変換の共通骨格を定義し、プラットフォーム固有の変換ロジックだけを差し替える
  - 適用条件: 同一の処理フロー（AST → platform string）を複数のサブクラスが異なる実装で提供する場合
  - コード例: `packages/chat/src/markdown.ts:323-399`（`BaseFormatConverter`）、各 `*FormatConverter` 実装
  - 注意点: `fromAstWithNodeConverter()` でノード単位の変換をフックポイントとして提供

- **Builder パターン** (分類: 生成)
  - 解決する問題: 複雑な構造（カード UI）の構築を宣言的かつ型安全に行う
  - 適用条件: ネストした構造を持つオブジェクトを、利用者に組み立てさせる場合
  - コード例: `packages/chat/src/cards.ts:206-380`（`Card()`, `Button()`, `Actions()` 等）
  - 注意点: 関数呼び出し API と JSX API の両方を提供し、同じ要素型を生成する二重表現を実現

## Good Patterns

- **Discriminated Union + `in` 演算子による型安全な分岐**: `PostableMessage` の各バリアントは互いに排他的なキー（`raw`, `markdown`, `ast`, `card`）を持ち、`"raw" in message` のような `in` チェックで型が絞り込まれる。`instanceof` や `type` フィールドに依存しないため、プレーンオブジェクトリテラルがそのまま使える。

```typescript
// packages/chat/src/thread.ts:751-798
if ("raw" in message) {
  return { plainText: message.raw, formatted: root([...]), attachments: message.attachments || [] };
}
if ("markdown" in message) {
  const ast = parseMarkdown(message.markdown);
  return { plainText: toPlainText(ast), formatted: ast, attachments: message.attachments || [] };
}
```

- **ファクトリ関数で Partial config + env fallback**: コンストラクタを直接公開せず、`create*()` ファクトリで `Partial<Config>` を受け取り、未指定フィールドを環境変数で補完する。エラーメッセージに「環境変数名 or config キー名」の両方を記載する。

```typescript
// packages/adapter-discord/src/index.ts:2079-2084
const botToken = config?.botToken ?? process.env.DISCORD_BOT_TOKEN;
if (!botToken) {
  throw new ValidationError(
    "discord",
    "botToken is required. Set DISCORD_BOT_TOKEN or provide it in config.",
  );
}
```

- **AsyncIterable によるストリーミングの透過的統合**: `post()` が `AsyncIterable<string>` を受け付けることで、AI SDK の `textStream` をそのまま渡せる。アダプタにネイティブストリーミング API があれば使い、なければ post + edit のフォールバックに切り替える。利用者は差異を意識しない。

```typescript
// examples/nextjs-chat/src/lib/bot.tsx:80-81
const result = await agent.stream({ prompt: message.text });
await thread.post(result.textStream);
```

## Anti-Patterns / 注意点

- **re-export トリックによるバンドル問題の回避**: `packages/chat/src/index.ts` でカードビルダー関数を `import { Card as _Card } from "./cards"` → `export const Card = _Card` という再エクスポートで公開している。これは「values are properly exported」というコメントが示す通り、ESM の `export { Card } from "./cards"` だけでは値としてエクスポートされない問題への対処だが、エクスポート行が冗長になり保守性が下がる。

```typescript
// Bad: 冗長な再エクスポート（packages/chat/src/index.ts:30-50）
import { Card as _Card, Button as _Button, ... } from "./cards";
export const Card = _Card;
export const Button = _Button;

// Better: バンドラ設定で named re-export が値として解決されるよう調整する
// あるいは barrel export を避けて直接インポートパスを提供する
```

- **JSX 型判別における identity 比較の脆弱性**: JSX runtime の `resolveJSXElement()` では `type === Text`, `type === Button` のように関数の identity で分岐している。コメントに「function names get minified in production builds」とあり意図的だが、ツリーシェイキングや別バンドルからの利用でシングルトン性が崩れるとサイレントに失敗する。

```typescript
// packages/chat/src/jsx-runtime.ts:372-383
// 関数 identity に依存した分岐
if (type === Text) {
  const content = processedChildren.map(String).join("");
  return Text(content, { style: textProps.style });
}
// Symbol.for を使った $$typeof チェックのほうが安定性が高い
```

## 導出ルール

- `[MUST]` 公開 API のメソッドが複数の入力形式を受け付ける場合、Discriminated Union 型を定義し、各バリアントに排他的な判別キーを持たせる
  - 根拠: `PostableMessage` 型は `raw`/`markdown`/`ast`/`card` の排他キーにより `in` 演算子だけで型安全に分岐でき、利用者はプレーンオブジェクトを渡すだけでよい（`types.ts:984-1003`）

- `[MUST]` ファクトリ関数で外部サービスの接続情報を扱う場合、エラーメッセージに「環境変数名」と「config オプション名」の両方を明記する
  - 根拠: 全 Adapter ファクトリが `"Set SLACK_SIGNING_SECRET or provide it in config."` 形式のエラーメッセージを採用し、利用者がどちらの方法で設定できるかを即座に理解できる（`adapter-slack/src/index.ts:2974`）

- `[SHOULD]` イベントハンドラ登録 API は「フィルタなし（catch-all）」と「フィルタ付き」の両方をオーバーロードで提供する
  - 根拠: `onAction(handler)` と `onAction(ids, handler)` の overload パターンが全イベント種別で一貫しており、利用者は段階的にフィルタを追加できる（`chat.ts:466-484`）

- `[SHOULD]` 操作の戻り値に後続操作メソッドを持たせ、Fluent API として連鎖可能にする（特に `edit()` が自身の型を返す設計）
  - 根拠: `SentMessage.edit()` が `SentMessage` を返すことで、投稿→編集→再編集が自然に書ける（`types.ts:935-937`）

- `[SHOULD]` 複数の実装が共通のインターフェースを持つ場合、オプショナルな能力をメソッドの存在有無（`method?`）で表現し、コア側でフォールバックロジックを持つ
  - 根拠: `Adapter.stream?`, `Adapter.openDM?`, `Adapter.postEphemeral?` は未実装でも `Thread` 側が代替動作（post+edit、DM フォールバック等）を提供する（`thread.ts:404-444`, `thread.ts:374-397`）

- `[SHOULD]` シリアライズ可能なオブジェクトに `_type` タグフィールドを含め、JSON reviver で自動復元できるようにする
  - 根拠: `SerializedThread._type: "chat:Thread"` により `JSON.parse(payload, chat.reviver())` で型安全な復元が可能（`chat.ts:640-658`）

- `[AVOID]` 公開エントリポイントの barrel export で import → re-export の冗長パターンを多用する（保守コストが高い）
  - 根拠: `index.ts` の 50 行以上が `import { X as _X } → export const X = _X` で埋まっており、追加・削除時に 2 箇所の変更が必要（`index.ts:30-68`）

## 適用チェックリスト

- [ ] 公開 API で複数の入力形式を受け付けるメソッドがある場合、Discriminated Union 型を定義し、各バリアントに排他的なキーを持たせているか
- [ ] ファクトリ関数のバリデーションエラーメッセージに、環境変数名と config オプション名の両方を含めているか
- [ ] イベントハンドラ登録 API がフィルタなし/フィルタ付きの両方をオーバーロードで提供しているか
- [ ] 操作結果のオブジェクト（SentMessage 相当）に後続操作メソッドを持たせ、Fluent API として使えるか
- [ ] Adapter/Provider パターンでオプショナルな能力を `method?` で表現し、コア側にフォールバックロジックがあるか
- [ ] シリアライズ対象のオブジェクトに型タグ（`_type` 等）を含め、自動復元の仕組みを用意しているか
- [ ] barrel export ファイルが冗長になっていないか（re-export の二重管理を避けているか）
