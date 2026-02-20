# Claude: llms.txt + MCP Integration

> 出典: [repos/colinhacks/zod](../repos/colinhacks/zod) — ai-settings
> カテゴリ: claude

## 概要

ライブラリの AI 向けドキュメントを llms.txt（目次版）/ llms-full.txt（全文版）/ MCP サーバー（対話的クエリ）の3段階で提供し、package.json の `llms`/`llmsFull`/`mcpServer` フィールドで機械発見可能にするパターン。「ローカル開発コンテキスト」（CLAUDE.md）と「外部公開コンテキスト」（llms.txt）を分離し、ライブラリの消費者側 AI にも最適なコンテキストを提供する設計である。

## 背景・文脈

AI コーディングツールの普及により、ライブラリのドキュメントは人間だけでなく AI も主要な消費者になった。しかし従来のドキュメント提供方法には限界がある:

- **Web ページ**: HTML/CSS/JS のノイズが多く、AI が構造を正確にパースしにくい
- **README.md**: 概要レベルで、API の詳細が不足
- **ドキュメントサイト**: ページが分散しており、AI が全体像を把握するのにコンテキストウィンドウを浪費

Zod（41.9k Stars）は、ドキュメントソースから動的生成される llms.txt と MCP サーバーにより、AI ツールのコンテキストウィンドウに合わせた段階的なドキュメント提供を実現している。

## 実装パターン

### 1. 3段階のコンテキスト提供

```
┌─────────────────────────────────────────────────┐
│  llms.txt (385行)                                │
│  目次 + URL リンク集                              │
│  → 「何があるか」を素早く把握                      │
├─────────────────────────────────────────────────┤
│  llms-full.txt (8,548行 / ~259KB)                │
│  全ドキュメント結合版（MDX → Markdown 変換済）      │
│  → 全 API の詳細を一括取得                        │
├─────────────────────────────────────────────────┤
│  MCP サーバー                                     │
│  対話的クエリによるピンポイント検索                  │
│  → 必要な情報だけを取得                           │
└─────────────────────────────────────────────────┘
```

### 2. llms.txt の動的生成（Route Handler）

```typescript
// packages/docs/app/llms.txt/route.ts:40-98
export async function GET() {
  const pages = source.getPages();

  let txt = `# Zod\n\n> Zod is a TypeScript-first schema validation library...`;

  for (const page of pages) {
    const title = stringifyTitle(page.data.title);
    if (title.startsWith("---")) continue;

    txt += `## ${title || "Untitled"}\n\n`;
    const pageUrl = `https://zod.dev${page.url}`;
    const description = page.data.description || "Documentation page";
    txt += `- [${title || "Untitled"}](${pageUrl}): ${description}\n`;

    // TOC アンカーリンクも含めて AI がセクション単位で参照可能にする
    if (page.data.toc && page.data.toc.length > 0) {
      const sections = page.data.toc.filter((item: any) => item.depth >= 2 && item.depth <= 4);
      for (const section of sections) {
        const anchor = section.url.replace("#", "");
        txt += `- [${stringifyTitle(section.title)}](${pageUrl}?id=${anchor})\n`;
      }
    }
  }
  return new Response(txt, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

export const revalidate = false; // 永続キャッシュ（ビルド時1回生成）
```

### 3. llms-full.txt の MDX → Markdown 変換パイプライン

```typescript
// packages/docs/loaders/get-llm-text.ts:12-43
const processor = remark()
  .use(remarkMdx)       // MDX 構文をパース
  .use(remarkInclude)    // fumadocs の include ディレクティブを展開
  .use(remarkGfm)        // GFM テーブル等を処理
  .use(remarkStringify); // Markdown に変換

export async function getLLMText(page: InferPageType<typeof source>): Promise<string> {
  const filePath = path.join(process.cwd(), "content", page.file.path);
  const fileContent = await fs.readFile(filePath);
  const { content } = matter(fileContent.toString());
  const processed = await processor.process({ path: filePath, value: content });
  return `# ${page.data.title}\n\n${processed}`;
}
```

### 4. package.json による機械発見可能なメタデータ

```json
// packages/zod/package.json:9-11
{
  "llms": "https://zod.dev/llms.txt",
  "llmsFull": "https://zod.dev/llms-full.txt",
  "mcpServer": "https://mcp.inkeep.com/zod/mcp"
}
```

npm レジストリ経由で AI ツールやパッケージマネージャがドキュメントエンドポイントを自動発見できる。

## Good Example

```json
// Good: package.json に3段階のAIエンドポイントを宣言
{
  "name": "my-library",
  "llms": "https://my-library.dev/llms.txt",
  "llmsFull": "https://my-library.dev/llms-full.txt",
  "mcpServer": "https://mcp.inkeep.com/my-library/mcp"
}
```

```typescript
// Good: ドキュメントソースから動的生成（常に最新）
// app/llms.txt/route.ts
export async function GET() {
  const pages = source.getPages(); // ドキュメントソースから取得
  let txt = generateLlmsTxt(pages);
  return new Response(txt, { headers: { "Content-Type": "text/plain" } });
}
export const revalidate = false; // ビルド時に1回生成
```

## Bad Example

```markdown
<!-- Bad: llms.txt を手動で管理 -->
<!-- docs/llms.txt (静的ファイル) -->
# My Library
- [Getting Started](https://my-lib.dev/getting-started)
- [API Reference](https://my-lib.dev/api)
<!-- ドキュメント更新時に手動で同期が必要 → 乖離が頻発 -->
```

```json
// Bad: AIエンドポイントの宣言なし
{
  "name": "my-library",
  "homepage": "https://my-library.dev"
  // AI ツールはホームページの HTML をスクレイピングするしかない
}
```

## 適用ガイド

### いつ使うべきか

- **npm パッケージを公開しているライブラリ**: 消費者の AI ツールにドキュメントを効率よく提供したい場合
- **ドキュメントサイトが 10 ページ以上ある場合**: 分散したドキュメントを AI 向けに集約する価値がある
- **fumadocs / Nextra / Docusaurus 等の SSG を使っている場合**: コンテンツソースから動的生成しやすい

### いつ使わないべきか

- **README.md で完結する小規模ライブラリ**: llms.txt を別途用意するオーバーヘッドに見合わない
- **非公開ライブラリ**: ローカルの CLAUDE.md で十分

### 導入時の注意点

1. **MDX → Markdown 変換の不完全性**: JSX コンポーネント（`<Tabs>`, `<Callout>` 等）が残留する場合がある。remark プラグインでカスタムコンポーネントを除去するか、プレーンテキストに変換する処理が必要
2. **llms-full.txt のサイズ制限**: AI のコンテキストウィンドウ（128k-200k tokens）を超える大規模ドキュメントでは、全文版が使いきれない場合がある。セクション分割やフィルタリングを検討
3. **`revalidate` 設定**: 動的コンテンツがない場合は `revalidate = false` で永続キャッシュ。頻繁に更新される場合は ISR で適切な間隔を設定

### カスタマイズポイント

1. **llms.txt の粒度**: Zod は H2 見出し + TOC アンカーまで含める。API が少ないライブラリではページリストのみで十分
2. **MCP サーバーの選択**: Zod は Inkeep の SaaS を利用。自前で構築する場合は Context7 や独自実装も選択肢
3. **ドキュメントソース**: fumadocs の `source.getPages()` 以外にも、mdx ファイルの直接読み取り、CMS API からの取得なども可能

## 参考

- [repos/colinhacks/zod/ai-settings.md](../repos/colinhacks/zod/ai-settings.md) — CLAUDE.md/AGENTS.md 設計、Claude Code CI、llms.txt 実装の詳細分析
- [llms.txt 仕様](https://llmstxt.org/) — llms.txt の標準仕様
