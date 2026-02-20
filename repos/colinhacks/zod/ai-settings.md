# AI Settings

> リポジトリ: colinhacks/zod
> 分析日: 2026-02-19

## 概要

Zod リポジトリにおける AI ツール向けのコンテキスト設計を分析する。CLAUDE.md/AGENTS.md によるローカル開発コンテキスト、Claude Code CI による自動 PR レビュー、llms.txt/llms-full.txt によるドキュメント公開、package.json の `llms`/`llmsFull`/`mcpServer` フィールドによるメタデータ宣言、Inkeep 連携による MCP サーバー提供という、多層的な AI 統合戦略を展開している。41,000 以上のスターを持つ OSS ライブラリが AI エコシステムとどう接続しているかの先進的な実例である。

## 背景にある原則

- **Single Source of Truth の原則**: `CLAUDE.md` は `AGENTS.md` へのシンボリックリンクであり、ファイルを複製せず単一ソースを維持している。複数の AI ツール（Claude Code は `CLAUDE.md`、Codex は `AGENTS.md`）が同一の指示を参照する設計。（`ls -la CLAUDE.md` → `AGENTS.md` へのシンボリックリンク）
- **段階的コンテキスト提供の原則**: llms.txt（385 行、目次 + リンク集）→ llms-full.txt（8,548 行、全ドキュメント結合）→ MCP サーバー（対話的クエリ）の 3 段階でコンテキストを提供する。AI ツールのコンテキストウィンドウや利用パターンに応じて最適なエンドポイントを選択できる。（`packages/docs/app/llms.txt/route.ts`, `packages/docs/app/llms-full.txt/route.ts`）
- **最小権限の原則**: CI の Claude Code ワークフローは `contents: read`, `pull-requests: read`, `issues: read` の読み取り権限のみ付与し、`--allowed-tools` で実行可能なコマンドを `gh` サブコマンドに限定している。AI がリポジトリに書き込むことを防ぐ設計。（`.github/workflows/claude-code-review.yml:22-26,56`）
- **行動規範の明示**: AGENTS.md で「テストなき機能は未完成」「ファイル生成前に確認を取れ」「`gh` CLI を使え」といった行動レベルの指示を列挙し、AI に明確な制約を与えている。（`AGENTS.md:29-37`）

## 実例と分析

### AGENTS.md の設計構造

AGENTS.md は 2 セクション構成で 38 行と非常に簡潔。

1. **Development Commands** — ビルド、テスト、リント、フォーマットなど日常のコマンド一覧。各コマンドに 1 行の説明を添える。
2. **Rules** — コーディングルールと行動規範。Node.js/pnpm のバージョン要件、テストポリシー、パフォーマンス方針、ツール使用方針を箇条書きで列挙。

特筆すべき設計判断:
- **プロジェクト固有のユーティリティの説明**: `util.defineLazy()` という内部ユーティリティの使用を指示し、その目的（循環依存の回避）まで記載。AI がコードベース固有のパターンを理解できるようにしている。
- **パフォーマンス方針の明示**: 「パフォーマンスは重要 — 最適化のためのパラメータ再代入は許可」という、通常のリンターの推奨に反するルールを明示。AI が lint ルールに従って不要なリファクタリングを行うことを防ぐ。
- **実験用ファイルの案内**: `play.ts` を実験用として位置づけ、「恒久的なテストケースには proper tests を使え」と指示。AI が使い捨てコードと本番コードを混同しないようにしている。

### Claude Code CI の 2 ワークフロー体制

Zod は 2 つの独立した Claude Code CI ワークフローを運用している。

**1. 自動 PR レビュー（claude-code-review.yml）**
- トリガー: `pull_request` の `opened` / `synchronize`
- すべての PR に対して自動でコードレビューを実行
- プロンプトでレビュー観点を明示: コード品質、バグ、パフォーマンス、セキュリティ、テストカバレッジ
- `--allowed-tools` で `gh` コマンドのみ許可（7 種: `gh issue view`, `gh search`, `gh issue list`, `gh pr comment`, `gh pr diff`, `gh pr view`, `gh pr list`）
- `contents: read` のみで書き込み権限なし

**2. @claude メンション対応（claude.yml）**
- トリガー: issue/PR コメントに `@claude` を含む場合、issue の新規作成/アサイン時
- ユーザーが明示的に Claude を呼び出した場合にのみ起動
- `additional_permissions: actions: read` で CI 結果の読み取りを追加許可
- `--allowed-tools` は未設定（コメントアウト状態）— メンション対応はより柔軟なツール使用を許容

### llms.txt の実装アーキテクチャ

Zod のドキュメントサイト（fumadocs ベース）は Next.js の Route Handler で llms.txt を動的生成している。

**llms.txt（目次版）**: `source.getPages()` で全ページを取得し、タイトル + URL + TOC アンカーリンクをプレーンテキストで出力。`revalidate = false` で永続キャッシュ。

**llms-full.txt（全文版）**: `meta.json` のページ順に従ってソートし、各ページの MDX ソースを `remark` パイプライン（remarkMdx → remarkInclude → remarkGfm → remarkStringify）で Markdown に変換して結合。fumadocs の `include` ディレクティブも展開される。

### package.json の AI メタデータフィールド

`packages/zod/package.json` に 3 つの AI 関連フィールドを宣言:

```json
{
  "llms": "https://zod.dev/llms.txt",
  "llmsFull": "https://zod.dev/llms-full.txt",
  "mcpServer": "https://mcp.inkeep.com/zod/mcp"
}
```

これらは npm パッケージレジストリ経由で機械的に発見可能なメタデータとして機能する。AI ツールやパッケージマネージャが `package.json` を読むだけで、そのライブラリの AI 向けドキュメントエンドポイントを取得できる。

### Inkeep MCP サーバー連携

Zod は独自の MCP サーバーを構築せず、Inkeep の SaaS MCP サーバー（`https://mcp.inkeep.com/zod/mcp`）を利用している。ドキュメントサイトの検索（`InkeepModalSearchAndChat`）とチャット（`InkeepChatButton`）にも同じ Inkeep を利用しており、ドキュメント検索基盤を統一している。

## コード例

CLAUDE.md → AGENTS.md のシンボリックリンク:
```
# シェル確認結果
$ ls -la CLAUDE.md
lrwxr-xr-x  CLAUDE.md -> AGENTS.md
```

AGENTS.md のプロジェクト固有ルール:
```markdown
<!-- AGENTS.md:35-37 -->
- Use `util.defineLazy()` for computed properties to avoid circular dependencies
- Performance is critical - parameter reassignment is allowed for optimization
- ALWAYS use the `gh` CLI to fetch GitHub information (issues, PRs, etc.) instead of relying on web search or assumptions
```

Claude Code Review CI の最小権限ツール設定:
```yaml
<!-- .github/workflows/claude-code-review.yml:56 -->
claude_args: '--allowed-tools "Bash(gh issue view:*),Bash(gh search:*),Bash(gh issue list:*),Bash(gh pr comment:*),Bash(gh pr diff:*),Bash(gh pr view:*),Bash(gh pr list:*)"'
```

llms.txt Route Handler の動的生成:
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

    if (page.data.toc && page.data.toc.length > 0) {
      const sections = page.data.toc.filter((item: any) => item.depth >= 2 && item.depth <= 4);
      if (sections.length > 0) {
        txt += "\n";
        for (const section of sections) {
          const sectionTitle = stringifyTitle(section.title);
          if (!sectionTitle) continue;
          const anchor = section.url.replace("#", "");
          const fullUrl = `https://zod.dev${page.url}?id=${anchor}`;
          txt += `- [${sectionTitle}](${fullUrl})\n`;
        }
      }
    }
    txt += "\n";
  }
  // ...
  return new Response(txt, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
```

llms-full.txt の MDX → Markdown 変換パイプライン:
```typescript
// packages/docs/loaders/get-llm-text.ts:12-43
const processor = remark().use(remarkMdx).use(remarkInclude).use(remarkGfm).use(remarkStringify);

export async function getLLMText(page: InferPageType<typeof source>): Promise<string> {
  const relativePath = page.file.path;
  const resolvedPath = path.join(process.cwd(), "content", relativePath);

  let filePath: string;
  let fileContent: Buffer;
  try {
    filePath = resolvedPath;
    fileContent = await fs.readFile(filePath);
  } catch {
    filePath = page.data._file.absolutePath;
    fileContent = await fs.readFile(filePath);
  }

  const { content } = matter(fileContent.toString());
  const processed = await processor.process({ path: filePath, value: content });

  return `# ${page.data.title}\n\n${processed}`;
}
```

package.json の AI メタデータフィールド:
```json
// packages/zod/package.json:9-11
{
  "llms": "https://zod.dev/llms.txt",
  "llmsFull": "https://zod.dev/llms-full.txt",
  "mcpServer": "https://mcp.inkeep.com/zod/mcp"
}
```

## パターンカタログ

- **Symlink による設定ファイル統合** (分類: 構造)
  - 解決する問題: 複数の AI ツールが異なるファイル名（CLAUDE.md, AGENTS.md）を参照する場合の設定の重複と不整合
  - 適用条件: 同一内容を複数のファイル名で公開する必要がある場合
  - コード例: `CLAUDE.md -> AGENTS.md`（シンボリックリンク）
  - 注意点: Windows 環境ではシンボリックリンクに管理者権限が必要な場合がある。Git が symlink を追跡するには `core.symlinks = true` が必要

- **段階的コンテキスト提供** (分類: 振る舞い / Strategy パターン)
  - 解決する問題: AI ツールのコンテキストウィンドウ制限と情報量のトレードオフ
  - 適用条件: ドキュメントが大規模で、利用シーンによって必要な粒度が異なる場合
  - コード例: `packages/docs/app/llms.txt/route.ts`（目次版）、`packages/docs/app/llms-full.txt/route.ts`（全文版）
  - 注意点: 目次版と全文版でドキュメントのソースが同一であることを保証する仕組みが必要（Zod では同じ `source.getPages()` を使用）

- **Sandbox パターン（最小権限 CI）** (分類: 振る舞い)
  - 解決する問題: CI 上の AI エージェントが意図しない変更やデータ漏洩を行うリスク
  - 適用条件: AI をCI で使用する場合全般
  - コード例: `.github/workflows/claude-code-review.yml:22-26,56`
  - 注意点: ツール制限が厳しすぎるとレビューの品質が下がる。読み取り専用のアクションに限定するのがバランス点

## Good Patterns

- **AGENTS.md の "行動指示" スタイル**: 「何をするか」だけでなく「何をするな」を具体的に指示している。`"Ask before generating new files"`、`"Don't skip tests due to type issues - fix the types instead"`、`"No log statements in tests or production code"` など、AI が陥りやすいアンチパターンを先回りして禁止している。

```markdown
<!-- AGENTS.md:33-34 -->
- Don't skip tests due to type issues - fix the types instead
- Ask before generating new files
```

- **実験用ファイルの公式サポート**: `play.ts` を git 管理下に置き、`pnpm dev:play` コマンドを用意している。AI エージェントが動作確認したいとき、テストファイルを汚さず安全に実験できる場所を提供している。

```json
// package.json:79
"dev:play": "pnpm dev play.ts"
```

- **レビュープロンプトの観点リスト化**: claude-code-review.yml のプロンプトで「コード品質、バグ、パフォーマンス、セキュリティ、テストカバレッジ」と 5 つの観点を明示し、レビューの網羅性を担保している。

```yaml
<!-- .github/workflows/claude-code-review.yml:43-49 -->
Please review this pull request and provide feedback on:
- Code quality and best practices
- Potential bugs or issues
- Performance considerations
- Security concerns
- Test coverage
```

- **llms.txt の `revalidate = false`（永続キャッシュ）**: ドキュメントの更新頻度を考慮し、ビルド時に 1 回だけ生成する設計。不要な再生成コストを避けている。

## Anti-Patterns / 注意点

- **play.ts が git 追跡されている**: `.gitignore` に `playground.ts` はあるが `play.ts` はない。AI が `play.ts` に実験コードを書いて放置すると、意図せずコミットされる可能性がある。

```
# Bad: play.ts が .gitignore に含まれていない
playground.ts  # これは無視される
# play.ts は追跡される

# Better: 実験用ファイルも .gitignore に追加
playground.ts
play.ts
```

- **claude.yml の `--allowed-tools` 未設定**: @claude メンション対応のワークフローはツール制限なしで動作する。自動レビューには厳格な制限があるのに、メンション対応は無制限という非対称性がある。意図的かもしれないが、セキュリティポリシーとしては一貫性に欠ける。

```yaml
# Bad: ツール制限なし（claude.yml）
# claude_args: '--allowed-tools Bash(gh pr:*)'  # コメントアウト

# Better: メンション対応にも最低限のツール制限を設定
claude_args: '--allowed-tools "Bash(gh:*)"'
```

- **llms-full.txt の JSX/MDX コンポーネント残留**: `get-llm-text.ts` の remark パイプラインで MDX をパースしているが、`import` 文や fumadocs 固有の JSX コンポーネント（`Tabs`, `Callout`, `Accordion`）がそのまま出力に残る可能性がある。

```
# llms-full.txt の冒頭部分に見られる残留
import { Tabs, Tab } from 'fumadocs-ui/components/tabs';
import { Callout } from "fumadocs-ui/components/callout"
```

## 導出ルール

- `[MUST]` CLAUDE.md / AGENTS.md には「開発コマンド一覧」と「行動ルール」の 2 セクションを最低限含め、AI が自律的にビルド・テスト・リントを実行できるようにする
  - 根拠: Zod の AGENTS.md は 38 行で 2 セクション構成。コマンド + ルールという最小構成で、AI エージェントが迷わず作業を開始できる設計になっている

- `[MUST]` CI で AI エージェントを使用する場合は `permissions` で読み取り専用にし、`--allowed-tools` で実行可能なコマンドを明示的にホワイトリストで制限する
  - 根拠: Zod の claude-code-review.yml は `contents: read` のみ + 7 種の `gh` サブコマンドに限定しており、AI が意図しない変更を行うリスクを排除している

- `[MUST]` 複数の AI ツールが異なるファイル名を参照する場合、内容を複製せずシンボリックリンクで統一する
  - 根拠: Zod は `CLAUDE.md -> AGENTS.md` のシンボリックリンクにより、Claude Code と Codex が同一ソースを参照することを保証している

- `[SHOULD]` ライブラリの package.json に `llms` / `llmsFull` / `mcpServer` フィールドを追加し、AI 向けドキュメントエンドポイントを機械発見可能にする
  - 根拠: Zod の `packages/zod/package.json` で 3 フィールドを宣言しており、npm レジストリ経由で AI ツールがドキュメントを自動発見できるメタデータとして機能している

- `[SHOULD]` ドキュメントサイトには llms.txt（目次 + リンク集）と llms-full.txt（全文結合版）の 2 段階のエンドポイントを用意し、AI のコンテキストウィンドウに応じた取得を可能にする
  - 根拠: Zod は 385 行の目次版と 8,548 行の全文版を動的生成しており、AI ツールの利用パターンに応じた柔軟な情報提供を実現している

- `[SHOULD]` AGENTS.md にはプロジェクト固有のユーティリティや通常のリンターの推奨に反するルールを明示し、AI が一般的なベストプラクティスに従って不適切な変更を行うことを防ぐ
  - 根拠: Zod は `defineLazy()` の使用指示やパフォーマンスのためのパラメータ再代入許可を明示しており、AI がリンターの警告に従って有害なリファクタリングを行うことを防いでいる

- `[SHOULD]` AI エージェントの実験用に `play.ts` のような使い捨てファイルと実行コマンドを公式に用意し、テストファイルの汚染を防ぐ
  - 根拠: Zod は `play.ts` + `pnpm dev:play` で AI エージェントの実験場所を公式に提供している

- `[AVOID]` AGENTS.md に抽象的・曖昧な指示（「コードをきれいに書け」等）を書くこと。AI は具体的で検証可能な指示に最もよく従う
  - 根拠: Zod の AGENTS.md はすべての指示が具体的（`"No log statements"`, `"Use gh CLI"`, `"Ask before generating new files"` 等）であり、曖昧な修飾語を一切含んでいない

- `[AVOID]` llms-full.txt を静的ファイルとして管理すること。ドキュメントソースから動的生成し、常に最新の内容を保証する
  - 根拠: Zod は Route Handler + remark パイプラインでドキュメントソースから llms-full.txt を動的生成しており、手動更新の漏れを構造的に防いでいる

## 適用チェックリスト

- [ ] プロジェクトルートに CLAUDE.md（または AGENTS.md）を作成し、「コマンド一覧」と「行動ルール」セクションを含める
- [ ] CLAUDE.md と AGENTS.md の両方が必要な場合、シンボリックリンクで統一する（`ln -s AGENTS.md CLAUDE.md`）
- [ ] AGENTS.md にプロジェクト固有のユーティリティやリンターの例外ルールを記載する
- [ ] AGENTS.md に「ファイル生成前に確認を取れ」「テストなし機能は未完成」等の行動制約を明示する
- [ ] Claude Code CI（自動 PR レビュー）を導入する場合、`permissions` を読み取り専用にし `--allowed-tools` でツールをホワイトリスト制限する
- [ ] @claude メンション対応の CI も導入する場合、適切なツール制限を設定する
- [ ] ドキュメントサイトがある場合、llms.txt（目次版）と llms-full.txt（全文版）のエンドポイントを作成する
- [ ] llms.txt / llms-full.txt はドキュメントソースから動的生成する仕組みにする
- [ ] npm パッケージの package.json に `llms` / `llmsFull` フィールドを追加する
- [ ] MCP サーバーを提供する場合、package.json に `mcpServer` フィールドを追加する
- [ ] 実験用ファイル（`play.ts` 等）を用意し、`.gitignore` に追加するか追跡方針を明確にする
