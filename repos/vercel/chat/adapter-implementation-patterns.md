# adapter-implementation-patterns

> リポジトリ: vercel/chat
> 分析日: 2026-02-25

## 概要

6 つのプラットフォームアダプター（Slack, Teams, GChat, Discord, GitHub, Linear）が共通の `Adapter` インターフェースを実装し、プラットフォーム差異をどう吸収しているかを分析した。特に注目すべきは、mdast AST を中間表現にした双方向フォーマット変換、構造化 Thread ID による文字列エンコーディング戦略、webhook 署名検証の統一パターン、そして共有ユーティリティパッケージ (`adapter-shared`) による横断的な重複排除である。各アダプターが 1000 行超の実装でありながら高い構造的一貫性を保っているのは、インターフェース設計と共有基盤の成果である。

## 背景にある原則

- **AST を正規表現とする双方向変換**: プラットフォーム固有フォーマット同士を直接変換せず、mdast AST を中間表現として `Platform Format <-> AST <-> Markdown String` の変換パスを確立している。これにより N 個のプラットフォーム対応が O(N) の変換器で済む。`packages/chat/src/markdown.ts:291` の `FormatConverter` インターフェースがこの原則を体現している。
- **構造化文字列による Thread ID の可逆エンコーディング**: 各プラットフォームの複合的なスレッド識別子（チャネル + タイムスタンプ、owner + repo + PR 番号等）を `{adapter}:{...}` 形式の単一文字列にエンコードすることで、上位層がプラットフォーム差異を意識せず Thread ID を扱える。特殊文字を含む値は base64url エンコードで安全に格納する。
- **共通インターフェースに optional メンバーを持たせる段階的対応**: `Adapter` インターフェースは全アダプター必須のメソッド（`handleWebhook`, `postMessage`, `encodeThreadId` 等）と optional なメソッド（`openDM?`, `openModal?`, `stream?`, `listThreads?` 等）を明確に分離している。プラットフォームが機能をサポートしない場合は no-op 実装か `NotImplementedError` で明示する。
- **共有パッケージによるアダプター間のロジック統一**: `@chat-adapter/shared` パッケージが `extractCard`, `extractFiles`, エラークラス階層、バッファ変換ユーティリティを提供し、各アダプターの boilerplate を削減している。

## 実例と分析

### 1. Adapter インターフェースとジェネリクスによる型安全な拡張

`Adapter<TThreadId, TRawMessage>` の 2 つの型パラメータが、各アダプターのプラットフォーム固有型を型安全に結びつけている。

```typescript
// packages/chat/src/types.ts:90
export interface Adapter<TThreadId = unknown, TRawMessage = unknown> {
  encodeThreadId(platformData: TThreadId): string;
  decodeThreadId(threadId: string): TThreadId;
  parseMessage(raw: TRawMessage): Message<TRawMessage>;
  // ...
}
```

各アダプターは `implements Adapter<XxxThreadId, XxxRawMessage>` で具体型を束縛する:

```typescript
// packages/adapter-github/src/index.ts:96-97
export class GitHubAdapter
  implements Adapter<GitHubThreadId, GitHubRawMessage>

// packages/adapter-linear/src/index.ts:89-90
export class LinearAdapter
  implements Adapter<LinearThreadId, LinearRawMessage>
```

### 2. Thread ID のエンコーディング戦略

全アダプターが `{adapter}:{platform-specific-parts}` のプレフィックス付き文字列フォーマットを踏襲しつつ、内部構造は各プラットフォームの事情に合わせている:

| アダプター | Thread ID フォーマット                              | 特徴                               |
| ---------- | --------------------------------------------------- | ---------------------------------- |
| Slack      | `slack:{channel}:{threadTs}`                        | シンプルなコロン区切り             |
| Teams      | `teams:{base64url(convId)}:{base64url(serviceUrl)}` | 特殊文字対策で base64url           |
| GChat      | `gchat:{spaceName}:{base64url(threadName)}:{dm}`    | DM フラグをサフィックスで付加      |
| Discord    | `discord:{guildId}:{channelId}:{threadId?}`         | 可変長パーツ（スレッド任意）       |
| GitHub     | `github:{owner}/{repo}:{prNumber}[:rc:{commentId}]` | 階層的リソースを `/` と `:` で表現 |
| Linear     | `linear:{issueId}[:c:{commentId}]`                  | コメントスレッドの optional 表現   |

### 3. BaseFormatConverter テンプレートメソッドパターン

`BaseFormatConverter` 抽象クラスが `fromAst` と `toAst` を抽象メソッドとして定義し、`renderPostable`, `extractPlainText`, `fromMarkdown` 等の共通処理をテンプレートメソッドとして提供している:

```typescript
// packages/chat/src/markdown.ts:323-345
export abstract class BaseFormatConverter implements FormatConverter {
  abstract fromAst(ast: Root): string;
  abstract toAst(platformText: string): Root;

  protected fromAstWithNodeConverter(
    ast: Root,
    nodeConverter: (node: Content) => string,
  ): string {
    const parts: string[] = [];
    for (const node of ast.children) {
      parts.push(nodeConverter(node as Content));
    }
    return parts.join("\n\n");
  }

  renderPostable(message: PostableMessageInput): string {
    if (typeof message === "string") return message;
    if ("raw" in message) return message.raw;
    if ("markdown" in message) return this.fromMarkdown(message.markdown);
    if ("ast" in message) return this.fromAst(message.ast);
    // ...
  }
}
```

Slack, Discord の FormatConverter はこの `fromAstWithNodeConverter` ヘルパーを使って各ノード型の変換関数を注入している。GitHub はさらに単純で、標準 GFM をそのまま `stringifyMarkdown` で変換する。

### 4. Webhook 署名検証の統一構造

全アダプターが `handleWebhook` → `verifySignature` の 2 層構造を持つ。検証アルゴリズムはプラットフォームごとに異なるが、実装パターンは共通:

| アダプター | アルゴリズム                              | ヘッダー名                                        |
| ---------- | ----------------------------------------- | ------------------------------------------------- |
| Slack      | HMAC-SHA256 + タイムスタンプ検証 (5分)    | `x-slack-request-timestamp` + `x-slack-signature` |
| GitHub     | HMAC-SHA256                               | `x-hub-signature-256`                             |
| Linear     | HMAC-SHA256 + タイムスタンプ検証 (5分)    | `linear-signature` + body 内 `webhookTimestamp`   |
| Discord    | Ed25519 (discord-interactions ライブラリ) | `x-signature-ed25519` + `x-signature-timestamp`   |
| Teams      | Bot Framework SDK に委譲                  | `Authorization`                                   |

HMAC 系は全て `timingSafeEqual` を使用し、タイミング攻撃を防止している。

### 5. Factory 関数による環境変数フォールバック

全アダプターが `createXxxAdapter(config?)` ファクトリ関数をエクスポートし、config 引数のフォールバックとして環境変数を参照する。ただし認証モードの混在を防ぐために「明示的な auth config が1つでもあれば、他の auth フィールドは env fallback しない」というガードを設けている:

```typescript
// packages/adapter-github/src/index.ts:1252-1259
const hasAuthConfig = !!(config?.token || config?.appId || config?.privateKey);
const token = config?.token ?? (hasAuthConfig ? undefined : process.env.GITHUB_TOKEN);
```

### 6. 共有エラー階層

`@chat-adapter/shared` が `AdapterError` 基底クラスと 6 つの具象エラーを提供:

```
AdapterError (adapter, code)
├── AdapterRateLimitError (retryAfter)
├── AuthenticationError
├── ResourceNotFoundError (resourceType, resourceId)
├── PermissionError (action, requiredScope)
├── ValidationError
└── NetworkError (originalError)
```

各エラーが `adapter` フィールドを持ち、どのプラットフォームで発生したかを常に追跡できる。

## コード例

```typescript
// packages/chat/src/types.ts:90-121 — Adapter インターフェース（抜粋）
export interface Adapter<TThreadId = unknown, TRawMessage = unknown> {
  readonly name: string;
  readonly userName: string;
  readonly botUserId?: string;
  handleWebhook(request: Request, options?: WebhookOptions): Promise<Response>;
  initialize(chat: ChatInstance): Promise<void>;
  encodeThreadId(platformData: TThreadId): string;
  decodeThreadId(threadId: string): TThreadId;
  postMessage(threadId: string, message: AdapterPostableMessage): Promise<RawMessage<TRawMessage>>;
  parseMessage(raw: TRawMessage): Message<TRawMessage>;
  renderFormatted(content: FormattedContent): string;
  // Optional capabilities
  stream?(
    threadId: string,
    textStream: AsyncIterable<string>,
    options?: StreamOptions,
  ): Promise<RawMessage<TRawMessage>>;
  openDM?(userId: string): Promise<string>;
  openModal?(triggerId: string, modal: ModalElement, contextId?: string): Promise<{ viewId: string; }>;
}
```

```typescript
// packages/adapter-teams/src/index.ts:2225-2261 — Base64url エンコーディングによる Thread ID
encodeThreadId(platformData: TeamsThreadId): string {
  const encodedConversationId = Buffer.from(
    platformData.conversationId
  ).toString("base64url");
  const encodedServiceUrl = Buffer.from(platformData.serviceUrl).toString(
    "base64url"
  );
  return `teams:${encodedConversationId}:${encodedServiceUrl}`;
}

decodeThreadId(threadId: string): TeamsThreadId {
  const parts = threadId.split(":");
  if (parts.length !== 3 || parts[0] !== "teams") {
    throw new ValidationError("teams", `Invalid Teams thread ID: ${threadId}`);
  }
  const conversationId = Buffer.from(parts[1], "base64url").toString("utf-8");
  const serviceUrl = Buffer.from(parts[2], "base64url").toString("utf-8");
  return { conversationId, serviceUrl };
}
```

```typescript
// packages/adapter-shared/src/adapter-utils.ts:36-46 — 共有カード抽出ロジック
export function extractCard(
  message: AdapterPostableMessage,
): CardElement | null {
  if (isCardElement(message)) {
    return message;
  }
  if (typeof message === "object" && message !== null && "card" in message) {
    return message.card;
  }
  return null;
}
```

## パターンカタログ

- **Template Method** (分類: 振る舞い)
  - 解決する問題: 6 つのフォーマット変換器に共通する AST 走査ロジックの重複
  - 適用条件: 変換アルゴリズムの骨格は同じだが、各ノードの変換ルールだけが異なる場合
  - コード例: `packages/chat/src/markdown.ts:336` の `fromAstWithNodeConverter`
  - 注意点: GitHub のように標準 markdown をそのまま使えるケースでは、テンプレートメソッドを使わず直接 `stringifyMarkdown` を呼ぶ方がシンプル

- **Adapter** (分類: 構造)
  - 解決する問題: 6 つの異なるプラットフォーム API を単一の統合インターフェースで操作
  - 適用条件: 外部システムのインターフェースが異なるが、アプリケーション層は統一的に扱いたい場合
  - コード例: `packages/chat/src/types.ts:90` の `Adapter<TThreadId, TRawMessage>`
  - 注意点: ジェネリクスの 2 パラメータ化により、プラットフォーム固有型を犠牲にせず統一インターフェースを提供

- **Factory Method** (分類: 生成)
  - 解決する問題: アダプターの生成と認証モード選択を隠蔽しつつ、環境変数からのゼロコンフィグを実現
  - 適用条件: 生成するオブジェクトの初期化が複雑（複数の認証モード、環境変数フォールバック等）で、ユーザーにその複雑さを露出したくない場合
  - コード例: `packages/adapter-slack/src/index.ts:2966` の `createSlackAdapter`
  - 注意点: 認証モード混在を防ぐため `hasAuthConfig` ガードを設けている点が独特

## Good Patterns

- **構造化 Thread ID**: プラットフォーム固有の複合識別子を `{adapter}:{...}` 文字列にエンコードし、上位層が型安全に decode できる仕組み。特殊文字を含む値は base64url 化する。これにより Thread ID をデータベースのキーや URL パラメータにそのまま使える。

```typescript
// packages/adapter-slack/src/index.ts:2429-2430
encodeThreadId(platformData: SlackThreadId): string {
  return `slack:${platformData.channel}:${platformData.threadTs}`;
}

// packages/adapter-teams/src/index.ts:2225-2233 — 特殊文字対応
encodeThreadId(platformData: TeamsThreadId): string {
  const encodedConversationId = Buffer.from(platformData.conversationId).toString("base64url");
  const encodedServiceUrl = Buffer.from(platformData.serviceUrl).toString("base64url");
  return `teams:${encodedConversationId}:${encodedServiceUrl}`;
}
```

- **認証モード混在防止ガード**: ファクトリ関数が「ユーザーが1つでも認証フィールドを明示したら、他の認証フィールドは環境変数から拾わない」ルールを適用。PAT と App Key が混在する事故を防止する。

```typescript
// packages/adapter-github/src/index.ts:1252-1259
const hasAuthConfig = !!(config?.token || config?.appId || config?.privateKey);
const token = config?.token ?? (hasAuthConfig ? undefined : process.env.GITHUB_TOKEN);
```

- **共有エラー階層の adapter フィールド**: 全エラーに `adapter: string` を持たせ、ログやエラーハンドラが「どのプラットフォームで失敗したか」を即座に判別できる。

```typescript
// packages/adapter-shared/src/errors.ts:13-28
export class AdapterError extends Error {
  readonly adapter: string;
  readonly code?: string;
  constructor(message: string, adapter: string, code?: string) {
    super(message);
    this.name = "AdapterError";
    this.adapter = adapter;
    this.code = code;
  }
}
```

## Anti-Patterns / 注意点

- **カード fallback テキスト生成の重複**: `@chat-adapter/shared` の `cardToFallbackText` が共有実装として存在するが、Discord の `cards.ts` は独自の `childToFallbackText` を持っており、ロジックがほぼ同一にもかかわらず共有版を使っていない。Slack は共有版を呼び出しているが、Discord は呼び出していない。

```typescript
// Bad: packages/adapter-discord/src/cards.ts:263 — 独自実装
function childToFallbackText(child: CardChild): string | null {
  switch (child.type) {
    case "text":
      return convertEmoji(child.content);
    case "fields":
      return child.children.map(f => `**${convertEmoji(f.label)}**: ...`).join("\n");
      // ...
  }
}

// Better: packages/adapter-slack/src/cards.ts:365-371 — 共有実装を利用
export function cardToFallbackText(card: CardElement): string {
  return sharedCardToFallbackText(card, {
    boldFormat: "*",
    lineBreak: "\n",
    platform: "slack",
  });
}
```

- **AsyncLocalStorage の Slack 限定使用**: Slack アダプターのみが `AsyncLocalStorage` を使って workspace コンテキスト（team_id → botToken のマッピング）を webhook ハンドラ内で伝播している。他のマルチテナントアダプター（GitHub の multi-tenant mode）は `getOctokitForThread` のような明示的な引数渡しを使っている。どちらかに統一した方がコードベースの一貫性が高まる。

## 導出ルール

- `[MUST]` マルチプラットフォームアダプターの共通インターフェースを定義する際、プラットフォーム固有の型情報はジェネリクスパラメータで保持し、上位層のコードでは文字列型の統一 ID（Thread ID 等）を使う
  - 根拠: `Adapter<TThreadId, TRawMessage>` の設計で 6 アダプターが型安全性を維持しつつ統一インターフェースを実現している（`packages/chat/src/types.ts:90`）
- `[MUST]` 複合識別子（チャネル + スレッド等）を単一文字列にエンコードする場合、区切り文字と衝突しうる値は base64url 等でエスケープする
  - 根拠: Teams アダプターが conversationId と serviceUrl を base64url エンコードして URL 安全な Thread ID を実現している（`packages/adapter-teams/src/index.ts:2225`）
- `[MUST]` webhook 署名検証では常にタイミングセーフ比較を使い、HMAC 結果を通常の文字列比較しない
  - 根拠: 全 HMAC 系アダプター（Slack, GitHub, Linear）が `timingSafeEqual` を使用している
- `[SHOULD]` 複数プラットフォーム間のフォーマット変換では中間表現（AST 等）を介し、プラットフォーム間の直接変換を避ける
  - 根拠: mdast AST を中間表現として `BaseFormatConverter` がテンプレートメソッドを提供し、各 FormatConverter が `toAst`/`fromAst` のみ実装すればよい設計（`packages/chat/src/markdown.ts:323`）
- `[SHOULD]` アダプターのファクトリ関数で複数の認証モードをサポートする場合、ユーザーが明示した認証フィールドと環境変数フォールバックが混在しないようガードする
  - 根拠: `hasAuthConfig` パターンで認証モードの事故的混在を防止している（`packages/adapter-github/src/index.ts:1252`）
- `[SHOULD]` エラー階層にプラットフォーム識別子フィールド（`adapter` 等）を持たせ、マルチアダプター環境でエラーの発生源を即座に特定できるようにする
  - 根拠: `AdapterError` が `adapter: string` を必須フィールドとして持ち、全サブクラスが継承している（`packages/adapter-shared/src/errors.ts:13`）
- `[AVOID]` 共有ユーティリティが存在するにもかかわらず、アダプターごとに同等のロジックを独自実装する
  - 根拠: Discord の `cardToFallbackText` が `@chat-adapter/shared` の共有実装を使わず独自実装しており、微妙な挙動差が生じる可能性がある

## 適用チェックリスト

- [ ] 共通インターフェースにジェネリクスパラメータを持たせ、各実装がプラットフォーム固有型を失わずに統一 API を提供できるか
- [ ] 複合識別子の文字列エンコーディングにおいて、区切り文字と衝突する値のエスケープ戦略を定義したか
- [ ] Thread ID のプレフィックスにアダプター名を含め、どのプラットフォーム由来かを即座に判別できるか
- [ ] フォーマット変換を中間表現経由にし、N 個のプラットフォーム対応が O(N) の変換器で済む設計か
- [ ] 共有可能なロジック（エラー階層、カード抽出、バッファ変換等）を別パッケージに切り出し、アダプター間の重複を排除しているか
- [ ] ファクトリ関数の環境変数フォールバックで認証モードの混在防止ガードを設けているか
- [ ] optional なメソッド（DM, modal, streaming 等）を no-op 実装か `NotImplementedError` で明示し、上位層が capability を判定できるか
