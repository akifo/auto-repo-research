# Cross-Platform Normalization

> リポジトリ: vercel/chat
> 分析日: 2026-02-25

## 概要

vercel/chat は Slack、Teams、Google Chat、Discord、GitHub、Linear という6つの異なるメッセージングプラットフォームのテキストフォーマット、スレッド識別子、絵文字表現を単一の正規形式に統一している。mdast AST を正規フォーマットとする FormatConverter パターン、`{adapter}:{payload}` 形式の Thread ID エンコーディング、そして EmojiResolver による双方向変換テーブルを中核とする。この3層の正規化アーキテクチャにより、ビジネスロジック層がプラットフォーム固有の差異から完全に分離されている。

## 背景にある原則

- **AST as Canonical Representation（AST を正規表現とする）**: テキストフォーマットの正規表現として文字列ではなく構造化された AST（mdast Root）を採用する。文字列は曖昧さを持つ（`*text*` が bold か emphasis か）が、AST は意味を一意に表現する。これにより Platform A -> AST -> Platform B の変換が情報を失わずに行える。
  - 根拠: `packages/chat/src/types.ts:893` で `FormattedContent = Root` と定義し、`Message` クラスの `formatted` フィールドを `Root` 型としている（`packages/chat/src/message.ts:108`）

- **Encode/Decode Symmetry（エンコード/デコードの対称性）**: クロスプラットフォーム識別子は常に encode/decode のペアで実装し、双方向変換を保証する。Thread ID、絵文字名、メッセージフォーマットのすべてがこの原則に従う。
  - 根拠: `Adapter` インターフェースが `encodeThreadId` と `decodeThreadId` を必須メソッドとして定義（`packages/chat/src/types.ts:108,121`）。FormatConverter の `toAst`/`fromAst` も同様の対称ペア。

- **Platform-Specific Complexity は境界層に封じ込める**: プラットフォーム固有の複雑さ（Slack の mrkdwn、Teams の HTML、GChat の独自記法）はアダプター層の `toAst`/`fromAst` 実装内に完全に閉じる。コアのビジネスロジックは正規化済みの AST と Thread ID のみを扱う。
  - 根拠: すべてのアダプター markdown.ts が `BaseFormatConverter` を継承し、`toAst`/`fromAst` のみをオーバーライドする設計（例: `SlackFormatConverter`、`TeamsFormatConverter`）

- **Normalized Name as Join Key（正規化名を結合キーとする）**: 絵文字のようにプラットフォーム間で表現が異なるデータは、正規化された名前（`thumbs_up`）を中間キーとし、各プラットフォーム形式へのマッピングテーブルで双方向変換する。
  - 根拠: `EmojiResolver` が `slackToNormalized`/`gchatToNormalized` の逆引きマップを構築（`packages/chat/src/emoji.ts:189-206`）

## 実例と分析

### AST-Based Format Conversion

6つのアダプターがすべて同じ `FormatConverter` インターフェースを実装するが、変換の複雑さはプラットフォームごとに大きく異なる。

**Slack** は標準 Markdown との差異が大きい。bold が `*text*`（Markdown では `**text**`）、strikethrough が `~text~`（Markdown では `~~text~~`）、リンクが `<url|text>`（Markdown では `[text](url)`）と、ほぼすべての記法が異なる。`toAst` では正規表現で Slack mrkdwn を標準 Markdown に変換してから `parseMarkdown` に渡し、`fromAst` では AST ノードを再帰的に走査して mrkdwn 文字列を組み立てる。

**Teams** は HTML ベースのフォーマットを使う。`<b>`, `<strong>`, `<i>`, `<em>`, `<s>`, `<a href>` などの HTML タグを Markdown に変換し、さらに `<at>name</at>` というメンション記法を `@name` に正規化する。HTML エンティティのデコード（`&lt;`, `&gt;`, `&amp;`）も必要。

**GitHub** と **Linear** は標準 Markdown に近いため、`toAst`/`fromAst` がほぼパススルーとなる。`stringifyMarkdown(ast).trim()` のように remark-stringify をそのまま使う。

**Google Chat** は Slack に似た独自記法を持つが、リンクは自動検出されるため `fromAst` でのリンク処理が特殊（URL がテキストと一致すれば URL だけ出力、異なれば `text (url)` 形式に変換）。

この設計の重要な点は、コアパッケージの `parseMarkdown` と `stringifyMarkdown` が unified/remark を使った単一の実装であり、各アダプターは「自プラットフォームの記法 ↔ 標準 Markdown」の変換だけを担当する点にある。AST の parse/stringify はコアに委譲される。

### Thread ID Encoding Scheme

Thread ID は `{adapter}:{platform-specific-payload}` の形式で統一されている。各アダプターの encoding 戦略は以下の通り:

| Platform | Format                                                      | 例                                |
| -------- | ----------------------------------------------------------- | --------------------------------- |
| Slack    | `slack:{channel}:{threadTs}`                                | `slack:C123ABC:1234567890.123456` |
| Teams    | `teams:{base64url(conversationId)}:{base64url(serviceUrl)}` | `teams:MTk6eHh4...`               |
| GChat    | `gchat:{spaceName}:{base64url(threadName)}[:dm]`            | `gchat:spaces/ABC123:dGhyZWFk...` |
| Discord  | `discord:{guildId}:{channelId}[:{threadId}]`                | `discord:123:456:789`             |
| GitHub   | `github:{owner}/{repo}:{prNumber}[:rc:{commentId}]`         | `github:acme/app:123:rc:456`      |
| Linear   | `linear:{issueId}[:c:{commentId}]`                          | `linear:abc-123:c:def-456`        |

注目すべき設計判断:

1. **Base64url エンコーディングの選択的使用**: Teams の conversationId や serviceUrl には `:` や `/` などの特殊文字が含まれるため base64url でエンコードする。一方、Slack の channelId や threadTs は安全な文字列のためそのまま使う。エンコーディングの必要性はデータの性質で判断されている。

2. **Optional Suffix による状態エンコード**: GChat の `:dm` サフィックスや GitHub の `:rc:{commentId}` のように、オプショナルな接尾辞でスレッドの種類を表現する。decode 時にパターンマッチで判別する。

3. **channelIdFromThreadId の導出**: Thread ID からチャンネル ID を導出するメソッドが各アダプターに実装される。デフォルトは「最初の2つのコロン区切りパーツ」だが、GitHub のように `owner/repo` を含む場合は専用の実装が必要。

### Triple-Layer Message Normalization

メッセージは3つのレイヤで正規化される:

1. **text**: プレーンテキスト（すべてのフォーマットを除去）
2. **formatted**: mdast Root AST（正規表現）
3. **raw**: プラットフォーム固有のペイロード（エスケープハッチ）

`extractMessageContent` 関数（`packages/chat/src/thread.ts:737-802`）は `AdapterPostableMessage` の5つのバリアント（string、raw、markdown、ast、card）をすべてこの3層に正規化する。特に `PostableAst` を直接受け取れる設計により、プラットフォーム間のメッセージ転送で AST を中間表現として使い回せる。

### Emoji Normalization via Bidirectional Lookup

`EmojiResolver` は3つの要素で構成される:

1. **正規化名 → プラットフォーム形式マップ**（`DEFAULT_EMOJI_MAP`）: `thumbs_up -> { slack: ["+1", "thumbsup"], gchat: "👍" }`
2. **逆引きマップ**（`slackToNormalized`, `gchatToNormalized`）: constructor で `buildReverseMaps` により自動構築
3. **EmojiValue シングルトン**: `getEmoji("thumbs_up")` が常に同一の frozen オブジェクトを返し、`===` 比較を可能にする

多対一マッピングが重要な設計要素。Slack の `+1` と `thumbsup` はどちらも正規化名 `thumbs_up` にマッピングされる。`toString()` で <code v-pre>{{emoji:thumbs_up}}</code> というプレースホルダ文字列を返し、`convertEmojiPlaceholders` で送信先プラットフォームの形式に変換する遅延解決方式。

## コード例

```typescript
// packages/chat/src/markdown.ts:291-308
// FormatConverter インターフェース — AST を正規表現とする双方向変換契約
export interface FormatConverter {
  extractPlainText(platformText: string): string;
  fromAst(ast: Root): string;
  toAst(platformText: string): Root;
}
```

```typescript
// packages/chat/src/markdown.ts:323-344
// BaseFormatConverter — テンプレートメソッドパターンで fromAst の共通処理を提供
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

  extractPlainText(platformText: string): string {
    return toPlainText(this.toAst(platformText));
  }
}
```

```typescript
// packages/adapter-slack/src/markdown.ts:74-100
// Slack の toAst — mrkdwn 記法を標準 Markdown に変換してから共通パーサーに渡す
toAst(mrkdwn: string): Root {
  let markdown = mrkdwn;
  // User mentions: <@U123|name> -> @name or <@U123> -> @U123
  markdown = markdown.replace(/<@([^|>]+)\|([^>]+)>/g, "@$2");
  markdown = markdown.replace(/<@([^>]+)>/g, "@$1");
  // Links: <url|text> -> [text](url)
  markdown = markdown.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "[$2]($1)");
  // Bold: *text* -> **text**
  markdown = markdown.replace(/(?<![_*\\])\*([^*\n]+)\*(?![_*])/g, "**$1**");
  // Strikethrough: ~text~ -> ~~text~~
  markdown = markdown.replace(/(?<!~)~([^~\n]+)~(?!~)/g, "~~$1~~");
  return parseMarkdown(markdown);
}
```

```typescript
// packages/adapter-teams/src/index.ts:2225-2262
// Teams の Thread ID — base64url エンコーディングで特殊文字を安全に扱う
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
// packages/chat/src/emoji.ts:177-217
// EmojiResolver — 逆引きマップの自動構築と双方向変換
export class EmojiResolver {
  private readonly slackToNormalized: Map<string, string>;
  private readonly gchatToNormalized: Map<string, string>;

  private buildReverseMaps(): void {
    for (const [normalized, formats] of Object.entries(this.emojiMap)) {
      const slackFormats = Array.isArray(formats.slack)
        ? formats.slack
        : [formats.slack];
      for (const slack of slackFormats) {
        this.slackToNormalized.set(slack.toLowerCase(), normalized);
      }
      // ... gchat 側も同様
    }
  }

  fromSlack(slackEmoji: string): EmojiValue {
    const cleaned = slackEmoji.replace(/^:|:$/g, "").toLowerCase();
    const normalized = this.slackToNormalized.get(cleaned) ?? slackEmoji;
    return getEmoji(normalized);
  }
}
```

```typescript
// packages/chat/src/thread.ts:737-801
// extractMessageContent — 5つのメッセージバリアントを text/formatted/attachments に正規化
function extractMessageContent(message: AdapterPostableMessage): {
  plainText: string;
  formatted: Root;
  attachments: Attachment[];
} {
  if (typeof message === "string") {
    return {
      plainText: message,
      formatted: root([paragraph([textNode(message)])]),
      attachments: [],
    };
  }
  if ("markdown" in message) {
    const ast = parseMarkdown(message.markdown);
    return { plainText: toPlainText(ast), formatted: ast, attachments: message.attachments || [] };
  }
  if ("ast" in message) {
    return { plainText: toPlainText(message.ast), formatted: message.ast, attachments: message.attachments || [] };
  }
  // ... card バリアントも同様
}
```

## パターンカタログ

- **Adapter / Bridge パターン** (分類: 構造)
  - 解決する問題: 異なるプラットフォームの API を共通のインターフェースで統一する
  - 適用条件: 複数の外部システムと同じ操作セットでやり取りする必要がある場合
  - コード例: `packages/chat/src/types.ts:90-300` の `Adapter` インターフェースと6つのアダプター実装
  - 注意点: インターフェースが肥大化しやすい。`FormatConverter` のように責務ごとにサブインターフェースを切り出す

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: AST → プラットフォーム文字列の変換で、ノード走査ロジックの重複を排除する
  - 適用条件: アルゴリズムの骨格は共通だが、各ステップの詳細が異なる場合
  - コード例: `BaseFormatConverter.fromAstWithNodeConverter`（`packages/chat/src/markdown.ts:336-345`）が骨格を提供し、各アダプターが `nodeConverter` 関数を注入する
  - 注意点: 過度に深い継承階層を避ける。このリポジトリでは1段階の継承に留めている

- **Flyweight / Identity Object パターン** (分類: 構造)
  - 解決する問題: 絵文字オブジェクトの同値比較を `===` で行えるようにする
  - 適用条件: 同一の値を持つオブジェクトが多数生成され、同値比較が頻繁に必要な場合
  - コード例: `getEmoji` のレジストリ + `Object.freeze`（`packages/chat/src/emoji.ts:32-43`）
  - 注意点: レジストリが無制限に成長しないよう注意。このリポでは well-known emoji が有限なため問題にならない

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: プラットフォームごとの Thread ID エンコーディング戦略の差し替え
  - 適用条件: 同じ操作に対して複数のアルゴリズムが存在し、実行時に切り替える必要がある場合
  - コード例: 各アダプターの `encodeThreadId`/`decodeThreadId` 実装。Slack は plain text、Teams は base64url、GChat はハイブリッド
  - 注意点: `Adapter` インターフェースのジェネリクス `TThreadId` により、各アダプターの Thread ID データ型が型安全に定義されている

## Good Patterns

- **Type Guard ライブラリによる型安全な AST 走査**: `isTextNode`, `isParagraphNode`, `isStrongNode` などの型ガード関数群を共通パッケージで提供し、アダプター側で `as` キャストなしに AST ノードを型安全に処理する。`getNodeChildren`/`getNodeValue` ヘルパーにより、children/value プロパティの有無チェックも型安全。

```typescript
// packages/chat/src/markdown.ts:56-58
export function isTextNode(node: Content): node is Text {
  return node.type === "text";
}

// packages/chat/src/markdown.ts:139-144
export function getNodeChildren(node: Content): Content[] {
  if ("children" in node && Array.isArray(node.children)) {
    return node.children as Content[];
  }
  return [];
}
```

- **Discriminated Union による PostableMessage の安全な分岐**: `AdapterPostableMessage` が `string | PostableRaw | PostableMarkdown | PostableAst | PostableCard | CardElement` として定義され、`"raw" in message`, `"markdown" in message`, `"ast" in message` によるナローイングで各バリアントを型安全に処理する。switch/case ではなくプロパティ存在チェックを使うことで、新しいバリアント追加時にも壊れにくい。

```typescript
// packages/chat/src/markdown.ts:377-399
renderPostable(message: PostableMessageInput): string {
  if (typeof message === "string") { return message; }
  if ("raw" in message) { return message.raw; }
  if ("markdown" in message) { return this.fromMarkdown(message.markdown); }
  if ("ast" in message) { return this.fromAst(message.ast); }
  // ...
}
```

- **Optional Suffix による拡張可能な ID スキーマ**: Thread ID に `:rc:{id}` や `:c:{id}` のようなオプショナルセグメントを付加することで、基本フォーマットの後方互換性を保ちつつスレッド種別のバリエーションを表現する。正規表現パターンマッチによる decode で拡張に対して開放的。

- **逆引きマップの自動構築**: `EmojiResolver` の `buildReverseMaps` が正引きテーブルから逆引きテーブルを自動生成する。手動で両方を管理する必要がなく、不整合が構造的に防がれる。多対一マッピング（Slack の `+1` と `thumbsup` が共に `thumbs_up`）も自然に処理できる。

## Anti-Patterns / 注意点

- **正規表現ベースの toAst 変換の脆弱性**: Slack や GChat の `toAst` はプラットフォーム記法を正規表現で標準 Markdown に変換してから `parseMarkdown` に渡す。ネストされたフォーマット（bold 内の italic など）や edge case（`*` を含むコードブロック内のテキスト）で誤変換のリスクがある。

```typescript
// Bad: 単純な正規表現では nested/edge case を見落とす可能性
markdown = markdown.replace(/(?<![_*\\])\*([^*\n]+)\*(?![_*])/g, "**$1**");

// Better: 専用パーサー（例: Slack の mrkdwn 用 PEG パーサー）を使い、
// parse tree を直接 mdast に変換する
```

- **Thread ID のプレフィックス文字列ハードコーディング**: `threadId.startsWith("github:")` のようなプレフィックスチェックが decode 処理に散在する。アダプター追加時に新しいプレフィックスとの衝突リスクがある。`Adapter.name` プロパティとの一貫性も保証されない。

```typescript
// Bad: マジックストリングによるプレフィックスチェック
if (!threadId.startsWith("github:")) {
  throw new ValidationError("github", `Invalid GitHub thread ID: ${threadId}`);
}

// Better: プレフィックスを定数化し、Adapter.name と紐付ける
const THREAD_ID_PREFIX = "github" as const;
if (!threadId.startsWith(`${THREAD_ID_PREFIX}:`)) { ... }
```

- **renderPostable の各アダプターでの重複オーバーライド**: Slack、Teams、Discord の `renderPostable` オーバーライドがほぼ同一のパターン（string/raw でメンション変換、markdown で fromAst 呼び出し）を繰り返している。メンション変換のフック関数を `BaseFormatConverter` に追加すればオーバーライドが不要になる。

## 導出ルール

- `[MUST]` クロスプラットフォーム変換では構造化された中間表現（AST、IR）を正規形式とし、文字列を正規形式にしない。すべての変換は「プラットフォーム固有形式 ↔ 正規 AST」を経由する。
  - 根拠: 文字列ベースの直接変換（Platform A -> Platform B）は N x N のマッピングを生み、正規表現の脆弱性が各組み合わせに伝播する。AST を経由すれば N + N の変換で済む。vercel/chat の `FormatConverter` が `toAst`/`fromAst` を必須とする設計がこれを強制している。

- `[MUST]` プラットフォーム固有の識別子をシステム内で使う場合、`{adapter}:{encoded-payload}` 形式のプレフィックス付き複合 ID にエンコードし、encode/decode のペアを必ず提供する。
  - 根拠: プレフィックスにより ID の出自が自明になり、異なるプラットフォームの ID が衝突しない。encode/decode のペアにより双方向変換が保証され、Thread ID からプラットフォーム固有のパラメータ（channelId、serviceUrl 等）を安全に復元できる。

- `[MUST]` 双方向マッピング（例: 絵文字の正規化名 ↔ プラットフォーム形式）では、正引きテーブルのみを定義し、逆引きテーブルは正引きから自動構築する。
  - 根拠: 手動で両方を管理すると不整合が発生する。`EmojiResolver.buildReverseMaps` のように constructor で自動構築すれば、正引きテーブルの更新だけで逆引きも同期される。

- `[SHOULD]` メッセージ内容を複数のレイヤ（plain text、structured/formatted、raw）で保持し、用途に応じて適切なレイヤを参照する。ビジネスロジックは formatted（AST）を、表示は plain text を、デバッグは raw を使う。
  - 根拠: `Message` クラスが `text`/`formatted`/`raw` の3層を持つことで、テキスト検索には `text`、フォーマット保持した転送には `formatted`、プラットフォーム固有の処理には `raw` をそれぞれ適切に使い分けている。

- `[SHOULD]` AST ノードの型安全な走査には、ノードタイプごとの型ガード関数と、children/value への安全なアクセサを共通ライブラリとして提供する。
  - 根拠: 6つのアダプターが同じ型ガード群（`isTextNode`, `isStrongNode` 等）と安全アクセサ（`getNodeChildren`, `getNodeValue`）を使い回すことで、`as` キャストの散在を防ぎ、ノード型追加時の修正箇所を1か所に集約している。

- `[SHOULD]` 複合 ID にプラットフォーム固有データをエンコードする際、データに区切り文字（`:`）が含まれうる場合は base64url エンコーディングを適用し、含まれない場合はそのまま使う。
  - 根拠: Teams の conversationId（`19:xxx@thread.tacv2;messageid=123`）は `:` を含むため base64url が必須だが、Slack の channelId（`C123ABC`）は安全な文字のみのためエンコード不要。過剰なエンコードは可読性とデバッグ性を損なう。

- `[AVOID]` プラットフォーム形式間の直接変換関数（Slack mrkdwn -> Teams HTML のような N x N マッピング）を作ること。常に正規 AST を経由する。
  - 根拠: 直接変換は O(N^2) の実装量になり、エッジケースの見落としが組み合わせ数に比例して増加する。vercel/chat は6プラットフォーム対応だが、直接変換は1つも存在しない。

## 適用チェックリスト

- [ ] 複数の外部システムとテキストデータをやり取りする場合、中間表現として構造化された AST や IR を定義しているか
- [ ] 外部システム固有の識別子を扱う場合、`{source}:{payload}` 形式の複合 ID スキーマを定義し、encode/decode のペアを実装しているか
- [ ] 複合 ID のペイロードに区切り文字が含まれるケースを考慮し、必要に応じて base64url エンコーディングを適用しているか
- [ ] 双方向マッピングテーブルが必要な場合、正引きテーブルから逆引きテーブルを自動構築する仕組みになっているか（手動管理の二重管理を避けているか）
- [ ] メッセージやデータの正規化で、用途別の複数レイヤ（plain/structured/raw）を提供しているか
- [ ] AST やツリー構造の走査で、型ガード関数と安全なアクセサ関数を共通ユーティリティとして提供しているか
- [ ] プラットフォーム固有の変換ロジックがアダプター層に閉じ込められており、ビジネスロジック層に漏れ出していないか
- [ ] 新しいプラットフォームを追加する際、既存のコアロジックを変更せずにアダプターの追加だけで対応できる構造になっているか
