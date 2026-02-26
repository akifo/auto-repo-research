# Pattern: AST Canonical Normalization

> 出典: [repos/vercel/chat](../repos/vercel/chat/) の cross-platform-normalization, design-philosophy, architecture 視点
> カテゴリ: pattern

## 概要

複数のプラットフォーム間でテキストフォーマットを変換する際、プラットフォーム固有形式同士の直接変換（N x N）ではなく、AST（Abstract Syntax Tree）を正規フォーマットとして中間に据え、各プラットフォームは「自形式 <-> AST」の双方向変換だけを実装する。これにより変換パスが N + N に削減され、新プラットフォーム追加時も既存コードの変更が不要になる。vercel/chat は mdast（Markdown AST）を正規フォーマットとし、`FormatConverter` インターフェースと `BaseFormatConverter` の Template Method で6プラットフォームの変換を実現している。

## 背景・文脈

vercel/chat は Slack、Teams、Google Chat、Discord、GitHub、Linear の6つのメッセージングプラットフォームを単一の SDK で統合するチャットボットフレームワークである。各プラットフォームは独自のテキストフォーマットを持つ:

- **Slack**: mrkdwn 記法（`*bold*`、`~strike~`、`<url|text>`）
- **Teams**: HTML ベース（`<b>bold</b>`、`<s>strike</s>`、`<a href="url">text</a>`）
- **GitHub / Linear**: 標準 GFM Markdown（`**bold**`、`~~strike~~`、`[text](url)`）
- **Google Chat**: Slack 類似の独自記法

6プラットフォーム間で直接変換すると 6 x 5 = 30 の変換関数が必要になるが、mdast AST を正規フォーマットとすることで `toAst` x 6 + `fromAst` x 6 = 12 の変換関数で済む。

## 実装パターン

### 1. FormatConverter インターフェース -- 双方向変換契約

```typescript
// packages/chat/src/markdown.ts:291-308
// AST (mdast Root) を正規表現とする双方向変換インターフェース
export interface FormatConverter {
  extractPlainText(platformText: string): string;
  fromAst(ast: Root): string; // AST -> プラットフォームフォーマット
  toAst(platformText: string): Root; // プラットフォームフォーマット -> AST
}
```

`toAst` と `fromAst` の対称ペアだけを要求する。プラットフォーム間の直接変換メソッドは存在しない。

### 2. BaseFormatConverter -- Template Method で共通走査を提供

```typescript
// packages/chat/src/markdown.ts:323-345
export abstract class BaseFormatConverter implements FormatConverter {
  abstract fromAst(ast: Root): string;
  abstract toAst(platformText: string): Root;

  // Template Method: AST の子ノードを走査し、nodeConverter で各ノードを変換
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

`fromAstWithNodeConverter` が AST 走査の骨格を提供し、各アダプターは `nodeConverter` 関数だけを差し替える。`extractPlainText` は `toAst` を内部で呼び出すことでデフォルト実装を提供する。

### 3. プラットフォームごとの変換実装

**Slack**: mrkdwn と標準 Markdown の記法差異を正規表現で吸収してからパーサーに渡す。

```typescript
// packages/adapter-slack/src/markdown.ts:65-100
export class SlackFormatConverter extends BaseFormatConverter {
  fromAst(ast: Root): string {
    return this.fromAstWithNodeConverter(ast, (node) => this.nodeToMrkdwn(node));
  }

  toAst(mrkdwn: string): Root {
    let markdown = mrkdwn;
    // User mentions: <@U123|name> -> @name
    markdown = markdown.replace(/<@([^|>]+)\|([^>]+)>/g, "@$2");
    // Links: <url|text> -> [text](url)
    markdown = markdown.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "[$2]($1)");
    // Bold: *text* -> **text**
    markdown = markdown.replace(/(?<![_*\\])\*([^*\n]+)\*(?![_*])/g, "**$1**");
    // Strikethrough: ~text~ -> ~~text~~
    markdown = markdown.replace(/(?<!~)~([^~\n]+)~(?!~)/g, "~~$1~~");
    return parseMarkdown(markdown);
  }
}
```

**Teams**: HTML タグを標準 Markdown に変換してからパーサーに渡す。

```typescript
// packages/adapter-teams/src/markdown.ts:75-122
export class TeamsFormatConverter extends BaseFormatConverter {
  toAst(teamsText: string): Root {
    let markdown = teamsText;
    // <at>Name</at> -> @Name
    markdown = markdown.replace(/<at>([^<]+)<\/at>/gi, "@$1");
    // <b>text</b> -> **text**
    markdown = markdown.replace(/<(b|strong)>([^<]+)<\/(b|strong)>/gi, "**$2**");
    // <a href="url">text</a> -> [text](url)
    markdown = markdown.replace(/<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi, "[$2]($1)");
    // HTML entities
    markdown = markdown.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    return parseMarkdown(markdown);
  }
}
```

**GitHub**: GFM は mdast と直接対応するため、パススルー。

```typescript
// packages/adapter-github/src/markdown.ts:19-36
export class GitHubFormatConverter extends BaseFormatConverter {
  fromAst(ast: Root): string {
    return stringifyMarkdown(ast).trim();
  }
  toAst(markdown: string): Root {
    return parseMarkdown(markdown);
  }
}
```

GitHub アダプターが事実上パススルーになる点は、mdast を正規フォーマットに選んだ妥当性を裏付けている。

### 4. 型安全な AST ノード走査ユーティリティ

```typescript
// packages/chat/src/markdown.ts:56-58, 139-155
export function isTextNode(node: Content): node is Text {
  return node.type === "text";
}
export function isStrongNode(node: Content): node is Strong {
  return node.type === "strong";
}

export function getNodeChildren(node: Content): Content[] {
  if ("children" in node && Array.isArray(node.children)) {
    return node.children as Content[];
  }
  return [];
}
export function getNodeValue(node: Content): string {
  if ("value" in node && typeof node.value === "string") {
    return node.value;
  }
  return "";
}
```

型ガード関数群と安全なアクセサを共通パッケージで提供し、6つのアダプターが `as` キャストなしに AST を走査できる。

## Good Example

AST を正規フォーマットとした N + N 変換:

```
Slack mrkdwn  ──toAst──┐
Teams HTML    ──toAst──┤
GChat 記法    ──toAst──┼── mdast AST ──fromAst──┬── Slack mrkdwn
Discord MD    ──toAst──┤               fromAst──┼── Teams HTML
GitHub GFM    ──toAst──┤               fromAst──┼── Discord MD
Linear MD     ──toAst──┘               fromAst──┴── ...
```

各アダプターは `FormatConverter` の `toAst`/`fromAst` だけを実装する。コアのビジネスロジックは正規化された `Root`（mdast AST）のみを扱い、プラットフォーム固有の記法を知らない。

```typescript
// コアの Message クラスは mdast AST を canonical representation として保持
// packages/chat/src/message.ts:95-108
export class Message<TRawMessage = unknown> {
  text: string; // プレーンテキスト（検索・ログ用）
  formatted: FormattedContent; // mdast Root（正規表現 -- ビジネスロジック用）
  raw: TRawMessage; // プラットフォーム固有ペイロード（エスケープハッチ）
}
```

## Bad Example

AST を介さず、プラットフォーム間で直接変換する N x N アプローチ:

```typescript
// Bad: 直接変換関数が N x N に爆発する
function slackToTeams(mrkdwn: string): string {
  // *bold* -> <b>bold</b>
  // ~strike~ -> <s>strike</s>
  // <url|text> -> <a href="url">text</a>
  // ...Slack 固有 + Teams 固有の知識が両方必要
}

function slackToDiscord(mrkdwn: string): string {/* ... */}
function teamsToSlack(html: string): string {/* ... */}
function teamsToDiscord(html: string): string {/* ... */}
// 6 プラットフォーム -> 30 関数が必要
// 7 番目のプラットフォーム追加で +12 関数
```

この方式では:

- 変換関数が O(N^2) で増加する
- 各関数がソース・ターゲット両方のフォーマット知識を持つ（責務の混在）
- エッジケースの修正が全組み合わせに波及する
- 新プラットフォーム追加時に既存の全プラットフォームとの変換を実装する必要がある

## 適用ガイド

### どのような状況で使うべきか

- 3つ以上のプラットフォーム/フォーマット間でテキストやデータを変換する必要がある場合
- プラットフォームの追加が将来見込まれる場合（2つでも先行投資の価値がある）
- 各プラットフォームのフォーマットが「同じ概念の異なる表現」である場合（太字、リンク、引用など意味的に同等）

### 正規フォーマットの選び方

1. **既存のエコシステムがある形式を選ぶ**: vercel/chat が mdast を選んだのは unified/remark エコシステム（パーサー、シリアライザー、プラグイン）が成熟しているため
2. **対象フォーマット群の「最大公約数」に近い形式を選ぶ**: GitHub GFM が mdast とほぼ一致する事実は、mdast がチャットフォーマットの正規表現として適切であることを示している
3. **構造化された表現を選ぶ**: 文字列ではなく AST/IR を正規フォーマットにすることで、意味（太字、リンクなど）を曖昧さなく保持できる

### 導入時の注意点

- **正規表現ベースの前処理は脆弱**: Slack アダプターの `toAst` は `*text*` -> `**text**` の正規表現変換を行うが、ネストしたフォーマットやエスケープで誤変換のリスクがある。可能なら専用パーサーを検討する
- **変換コストの非対称性を許容する**: `toAst`（入力）と `fromAst`（出力）の実装コストはプラットフォームごとに大きく異なる（GitHub はパススルー、Slack は複雑な前処理が必要）。これは設計上の問題ではなく、各プラットフォームの記法差異を反映した自然な結果
- **継承は1段階に留める**: `BaseFormatConverter` -> `SlackFormatConverter` の1段階で十分。これ以上深い継承は避ける

### カスタマイズポイント

- `fromAstWithNodeConverter` の `nodeConverter` 関数: AST ノード型ごとの変換ロジックを差し替え可能
- `renderPostable` メソッド: メッセージバリアント（string / raw / markdown / ast）の振り分けロジックをオーバーライド可能
- 型ガード関数群: 新しい AST ノード型に対応する場合、コアパッケージに型ガードを追加すれば全アダプターで利用可能

## 参考

- [repos/vercel/chat/cross-platform-normalization.md](../repos/vercel/chat/cross-platform-normalization.md) -- クロスプラットフォーム正規化の詳細分析
- [repos/vercel/chat/design-philosophy.md](../repos/vercel/chat/design-philosophy.md) -- mdast を正規フォーマットに選んだ技術選定の根拠
- [repos/vercel/chat/architecture.md](../repos/vercel/chat/architecture.md) -- レイヤードアーキテクチャと依存逆転の全体像
