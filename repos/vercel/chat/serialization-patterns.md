# serialization-patterns

> リポジトリ: vercel/chat
> 分析日: 2026-02-25

## 概要

vercel/chat は Chat SDK のドメインオブジェクト（Thread, Message, Channel）をワークフローエンジンに安全に渡すためのシリアライゼーション基盤を持つ。注目すべきは、Symbol ベースの外部 serde プロトコル統合、型タグによる判別可能シリアライゼーション、そしてデシリアライズ時に依存関係をシングルトンから遅延解決する設計の 3 層構造である。非シリアライズ可能な値（Buffer, 関数, Date）を境界で適切に変換し、復元時にドメインオブジェクトの能力を完全に回復させるプラクティスが体系的に適用されている。

## 背景にある原則

- **ドメインオブジェクトはシリアライゼーション境界を跨げるべき**: ワークフローエンジンのようにプロセスを跨ぐシステムでは、ドメインオブジェクトを JSON に変換して渡し、受け取り側で完全なオブジェクトに復元する必要がある。vercel/chat は `toJSON()`/`fromJSON()` の対称ペアでこれを実現している（`packages/chat/src/thread.ts:548-607`, `packages/chat/src/message.ts:156-213`）。

- **シリアライズ形式はフレームワーク非依存にし、復元はフレームワークに委譲する**: シリアライズ結果はプレーンな JSON オブジェクトだが、復元時に必要な実行時依存（Adapter, StateAdapter）はシングルトンから遅延解決する。これにより、シリアライズ形式がフレームワーク結合を持たず、異なるランタイム間で受け渡し可能になる（`packages/chat/src/thread.ts:62-79`, `packages/chat/src/chat-singleton.ts:1-51`）。

- **非シリアライズ可能値は境界で明示的に除外・変換する**: Date は ISO 文字列に、Buffer/関数は除外し、復元時に型を戻す。暗黙の変換に頼らない設計（`packages/chat/src/message.ts:156-187` で Date を ISO 文字列に変換、attachments から `data`/`fetchData` を除外）。

- **外部プロトコルへの適合は委譲パターンで実装する**: `@workflow/serde` の Symbol ベースプロトコルへの適合を、既存の `toJSON()`/`fromJSON()` に委譲する形で実装している。プロトコル適合コードが薄く、既存ロジックとの重複がない（`packages/chat/src/thread.ts:596-607`）。

## 実例と分析

### 3 層のシリアライゼーション戦略

vercel/chat のシリアライゼーションは 3 つの層で構成されている。

**第 1 層: toJSON/fromJSON ペア** — ドメインオブジェクト自身が持つ基本的なシリアライズ能力。Thread, Message, Channel の各クラスが対称的に実装している。

**第 2 層: @workflow/serde プロトコル統合** — `WORKFLOW_SERIALIZE` / `WORKFLOW_DESERIALIZE` という Symbol キーの静的メソッドで、ワークフローエンジンが自動的にシリアライズ/デシリアライズできる。実装は第 1 層に完全委譲する。

**第 3 層: JSON.parse reviver** — `chat.reviver()` が返す reviver 関数で、型タグ `_type` に基づいて JSON.parse 時にドメインオブジェクトを自動復元する。ネストされたペイロードにも再帰的に適用される。

### 型タグによる判別可能シリアライゼーション

全てのシリアライズ形式に `_type` フィールドを持たせ、復元時のディスパッチに使う。

- `"chat:Thread"` — `SerializedThread`
- `"chat:Message"` — `SerializedMessage`
- `"chat:Channel"` — `SerializedChannel`

名前空間付きの文字列リテラル型（`"chat:Thread"` のように `パッケージ:型名`）を使うことで、他のライブラリの型タグとの衝突を防いでいる。reviver 関数では `"chat:"` プレフィックスを持たない `_type` はスキップする設計（`packages/chat/src/chat.ts:644-656`）。

### 遅延シングルトン解決パターン

デシリアライズ時の最大の課題は、Thread が Adapter と StateAdapter への参照を必要とすることである。シリアライズ形式にはアダプタ名（文字列）のみ保存し、復元時に Chat シングルトンから実際のアダプタインスタンスを遅延解決する。

この設計の核心は、`fromJSON()` の時点ではシングルトンにアクセスしない点にある。アダプタへの最初のアクセス（`get adapter()`）が発生するまで解決を遅延させる。これにより:

1. デシリアライズ自体は副作用を持たない
2. シングルトン登録前でもオブジェクト構築は可能
3. エラーは実際に使おうとした時点で発生する（早すぎる失敗を避ける）

### モーダルコンテキストの永続化

`StoredModalContext` は Thread/Message/Channel のシリアライズ形式をサーバーサイドストレージに保存し、モーダル送信ハンドラで復元する実例である。ワークフロー以外のユースケースでもシリアライゼーション基盤が再利用されている（`packages/chat/src/chat.ts:55-59`, `970-1049`）。

## コード例

### toJSON/fromJSON の対称ペア（Message）

```typescript
// packages/chat/src/message.ts:156-213
toJSON(): SerializedMessage {
  return {
    _type: "chat:Message",
    id: this.id,
    threadId: this.threadId,
    text: this.text,
    formatted: this.formatted,
    raw: this.raw,
    author: {
      userId: this.author.userId,
      userName: this.author.userName,
      fullName: this.author.fullName,
      isBot: this.author.isBot,
      isMe: this.author.isMe,
    },
    metadata: {
      dateSent: this.metadata.dateSent.toISOString(),
      edited: this.metadata.edited,
      editedAt: this.metadata.editedAt?.toISOString(),
    },
    attachments: this.attachments.map((att) => ({
      type: att.type,
      url: att.url,
      name: att.name,
      mimeType: att.mimeType,
      size: att.size,
      width: att.width,
      height: att.height,
    })),
    isMention: this.isMention,
  };
}

static fromJSON<TRawMessage = unknown>(
  json: SerializedMessage
): Message<TRawMessage> {
  return new Message<TRawMessage>({
    id: json.id,
    threadId: json.threadId,
    text: json.text,
    formatted: json.formatted,
    raw: json.raw as TRawMessage,
    author: json.author,
    metadata: {
      dateSent: new Date(json.metadata.dateSent),
      edited: json.metadata.edited,
      editedAt: json.metadata.editedAt
        ? new Date(json.metadata.editedAt)
        : undefined,
    },
    attachments: json.attachments,
    isMention: json.isMention,
  });
}
```

### Symbol ベースのプロトコル適合（Thread）

```typescript
// packages/chat/src/thread.ts:596-607
static [WORKFLOW_SERIALIZE](instance: ThreadImpl): SerializedThread {
  return instance.toJSON();
}

static [WORKFLOW_DESERIALIZE](data: SerializedThread): ThreadImpl {
  return ThreadImpl.fromJSON(data);
}
```

### 遅延解決付きの構成分岐（Thread コンストラクタ）

```typescript
// packages/chat/src/thread.ts:62-79, 115-135
interface ThreadImplConfigLazy {
  adapterName: string;
  channelId: string;
  currentMessage?: Message;
  id: string;
  // adapter / stateAdapter は含まない
}

constructor(config: ThreadImplConfig) {
  // ...
  if (isLazyConfig(config)) {
    this._adapterName = config.adapterName;
  } else {
    this._adapter = config.adapter;
    this._stateAdapterInstance = config.stateAdapter;
  }
}
```

### getter による遅延解決とキャッシュ

```typescript
// packages/chat/src/thread.ts:141-162
get adapter(): Adapter {
  if (this._adapter) {
    return this._adapter;
  }
  if (!this._adapterName) {
    throw new Error("Thread has no adapter configured");
  }
  const chat = getChatSingleton();
  const adapter = chat.getAdapter(this._adapterName);
  if (!adapter) {
    throw new Error(
      `Adapter "${this._adapterName}" not found in Chat singleton`
    );
  }
  this._adapter = adapter;
  return adapter;
}
```

### reviver による自動復元

```typescript
// packages/chat/src/chat.ts:640-658
reviver(): (key: string, value: unknown) => unknown {
  this.registerSingleton();
  return function reviver(_key: string, value: unknown): unknown {
    if (value && typeof value === "object" && "_type" in value) {
      const typed = value as { _type: string };
      if (typed._type === "chat:Thread") {
        return ThreadImpl.fromJSON(value as SerializedThread);
      }
      if (typed._type === "chat:Channel") {
        return ChannelImpl.fromJSON(value as SerializedChannel);
      }
      if (typed._type === "chat:Message") {
        return Message.fromJSON(value as SerializedMessage);
      }
    }
    return value;
  };
}
```

### Chat シングルトンの分離モジュール

```typescript
// packages/chat/src/chat-singleton.ts:1-51
export interface ChatSingleton {
  getAdapter(name: string): Adapter | undefined;
  getState(): StateAdapter;
}

let _singleton: ChatSingleton | null = null;

export function setChatSingleton(chat: ChatSingleton): void {
  _singleton = chat;
}

export function getChatSingleton(): ChatSingleton {
  if (!_singleton) {
    throw new Error(
      "No Chat singleton registered. Call chat.registerSingleton() first.",
    );
  }
  return _singleton;
}
```

## パターンカタログ

- **Memento パターン** (分類: 振る舞い)
  - 解決する問題: オブジェクトの内部状態をカプセル化を壊さずに外部に保存・復元する
  - 適用条件: プロセス境界を跨いでドメインオブジェクトを受け渡す必要がある場合
  - コード例: `packages/chat/src/thread.ts:548-607`（toJSON が memento を生成、fromJSON が復元）
  - 注意点: 非シリアライズ可能な依存（Adapter）は memento に含めず、復元時に外部から注入する変形

- **Service Locator パターン** (分類: 生成)
  - 解決する問題: デシリアライズ時にオブジェクトの依存関係を解決する
  - 適用条件: シリアライズ形式に依存関係のインスタンスを含められない場合
  - コード例: `packages/chat/src/chat-singleton.ts:29-36`（getChatSingleton）, `packages/chat/src/thread.ts:150-161`（遅延解決）
  - 注意点: 循環依存回避のため、シングルトンホルダーを別モジュールに分離している

- **Discriminated Union / Tagged Type パターン** (分類: 構造)
  - 解決する問題: 複数のシリアライズ型を判別して適切なデシリアライザにディスパッチする
  - 適用条件: 一つの JSON ペイロードに異なる型のオブジェクトが混在する場合
  - コード例: `packages/chat/src/chat.ts:644-655`（`_type` フィールドでディスパッチ）
  - 注意点: 名前空間プレフィックス（`"chat:"`）で外部ライブラリとの衝突を回避

## Good Patterns

- **toJSON/fromJSON の対称性を型で保証する**: `SerializedThread`, `SerializedMessage`, `SerializedChannel` のそれぞれにインターフェースを定義し、`toJSON()` の戻り値型と `fromJSON()` の引数型を一致させている。これにより、シリアライズ形式の変更がコンパイル時に検出される。

```typescript
// packages/chat/src/thread.ts:34-41
export interface SerializedThread {
  _type: "chat:Thread";
  adapterName: string;
  channelId: string;
  currentMessage?: SerializedMessage;
  id: string;
  isDM: boolean;
}

// toJSON(): SerializedThread — 戻り値型で制約
// static fromJSON(json: SerializedThread) — 引数型で制約
```

- **外部プロトコルへの適合を既存メソッドへの委譲で実装する**: `WORKFLOW_SERIALIZE` / `WORKFLOW_DESERIALIZE` の実装は各 2 行で、既存の `toJSON()`/`fromJSON()` に完全委譲している。外部プロトコルのためにロジックを複製しない。

```typescript
// packages/chat/src/message.ts:219-229
static [WORKFLOW_SERIALIZE](instance: Message): SerializedMessage {
  return instance.toJSON();
}
static [WORKFLOW_DESERIALIZE](data: SerializedMessage): Message {
  return Message.fromJSON(data);
}
```

- **シングルトンホルダーを別モジュールに分離して循環依存を回避する**: `chat-singleton.ts` は最小限のインターフェース（`ChatSingleton`）のみに依存し、`Chat` クラス本体をインポートしない。thread.ts と chat.ts の相互依存を断ち切っている。

```typescript
// packages/chat/src/chat-singleton.ts:10-13
export interface ChatSingleton {
  getAdapter(name: string): Adapter | undefined;
  getState(): StateAdapter;
}
```

- **非シリアライズ可能フィールドの明示的除外**: Message の attachments は `data`（Buffer）と `fetchData`（関数）をシリアライズ時に意図的に除外し、URL 等のシリアライズ可能なメタデータのみ残す。テストでこの除外を明示的に検証している。

```typescript
// packages/chat/src/serialization.test.ts:280-311
attachments: [{
  type: "image",
  url: "https://example.com/image.png",
  data: Buffer.from("test"), // 除外される
  fetchData: () => Promise.resolve(Buffer.from("test")), // 除外される
}];
// ...
expect("data" in json.attachments[0]).toBe(false);
expect("fetchData" in json.attachments[0]).toBe(false);
```

## Anti-Patterns / 注意点

- **シングルトン登録なしのデシリアライズ**: `ThreadImpl.fromJSON()` は構築時にはエラーを出さないが、`adapter` にアクセスした時点で `"No Chat singleton registered"` がスローされる。ドキュメントやテストで明記されているものの、エラーの発生タイミングが遅延するため、原因追跡が困難になり得る。

```typescript
// Bad: シングルトン未登録でデシリアライズし、後でクラッシュ
const thread = ThreadImpl.fromJSON(data);
// ... 50 行後 ...
await thread.post("Hello"); // ここで "No Chat singleton registered" エラー

// Better: 前提条件をドキュメント化し、早期に検証
chat.registerSingleton();
const thread = ThreadImpl.fromJSON(data);
await thread.post("Hello");
```

- **暗黙の Date 変換への依存**: `new Date(json.metadata.dateSent)` は入力が ISO 文字列でない場合にも `Invalid Date` を返す（例外にならない）。バリデーションなしの変換はサイレントバグの温床になる。

```typescript
// Bad: バリデーションなしで Date に変換
metadata: {
  dateSent: new Date(json.metadata.dateSent),  // 不正値でも例外にならない
}

// Better: 変換結果を検証する
const dateSent = new Date(json.metadata.dateSent);
if (isNaN(dateSent.getTime())) {
  throw new Error(`Invalid dateSent: ${json.metadata.dateSent}`);
}
```

## 導出ルール

- `[MUST]` シリアライズ形式に名前空間付き型タグ（`_type: "package:TypeName"`）を含め、復元時のディスパッチに使う
  - 根拠: `SerializedThread._type: "chat:Thread"` 等のタグが reviver での安全なディスパッチを可能にしている（`packages/chat/src/chat.ts:644-655`）

- `[MUST]` toJSON と fromJSON は対称的に実装し、中間形式の型を共有する（`toJSON(): Serialized`, `fromJSON(json: Serialized)`）
  - 根拠: `SerializedMessage` 型が toJSON の戻り値と fromJSON の引数で共有されており、フォーマット不一致がコンパイル時に検出される（`packages/chat/src/message.ts:43-72, 156-213`）

- `[MUST]` Date, Buffer, 関数など非 JSON-safe な値はシリアライズ境界で明示的に変換・除外し、復元時に型を戻す
  - 根拠: Message.toJSON() は Date を ISO 文字列に変換し、attachments から Buffer/関数を除外している。テストでも除外を検証している（`packages/chat/src/serialization.test.ts:280-311`）

- `[SHOULD]` 外部 serde プロトコルへの適合は、既存の toJSON/fromJSON に委譲する薄いアダプタとして実装する
  - 根拠: `WORKFLOW_SERIALIZE`/`WORKFLOW_DESERIALIZE` は各 2 行で toJSON/fromJSON に委譲しており、ロジックの重複がない（`packages/chat/src/thread.ts:596-607`）

- `[SHOULD]` デシリアライズ時に実行時依存が必要な場合、名前（文字列）をシリアライズし、getter で遅延解決してキャッシュする
  - 根拠: ThreadImpl は `adapterName` のみ保存し、`get adapter()` で初回アクセス時にシングルトンから解決・キャッシュする（`packages/chat/src/thread.ts:141-162`）

- `[SHOULD]` シングルトンホルダーは最小インターフェースのみに依存する別モジュールに分離し、循環依存を回避する
  - 根拠: `chat-singleton.ts` は `ChatSingleton` インターフェース（2 メソッド）のみを公開し、Chat クラス本体への依存を持たない（`packages/chat/src/chat-singleton.ts:10-13`）

- `[AVOID]` シリアライズ形式に実行時インスタンス（関数、クラスインスタンス、環境依存オブジェクト）を含める
  - 根拠: SerializedThread は adapter インスタンスではなく `adapterName: string` のみを保存し、プロセス間で安全に受け渡し可能にしている（`packages/chat/src/thread.ts:34-41`）

## 適用チェックリスト

- [ ] ドメインオブジェクトがプロセス境界を跨ぐ場合、`toJSON()`/`fromJSON()` の対称ペアを実装しているか
- [ ] シリアライズ中間形式に名前空間付き型タグ（`_type`）を含めているか
- [ ] Date, Buffer, 関数などの非 JSON-safe 値を境界で明示的に変換・除外しているか
- [ ] シリアライズ形式の型を interface で定義し、toJSON の戻り値と fromJSON の引数で共有しているか
- [ ] デシリアライズ時の実行時依存は名前文字列で保存し、遅延解決しているか
- [ ] 外部 serde プロトコルへの適合は既存メソッドへの委譲で実装しているか
- [ ] シングルトンの依存解決モジュールは循環参照を避けるために分離されているか
- [ ] round-trip テスト（serialize → deserialize → 元と一致）を書いているか
- [ ] 非シリアライズ可能フィールドの除外をテストで検証しているか
