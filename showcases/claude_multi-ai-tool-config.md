# Claude: 複数 AI ツールの並行設定管理パターン

> 出典: [repos/mastra-ai/mastra/ai-settings.md](../repos/mastra-ai/mastra/ai-settings.md), [repos/mastra-ai/mastra/dev-conventions.md](../repos/mastra-ai/mastra/dev-conventions.md)
> カテゴリ: claude

## 概要

Claude Code / Cursor / GitHub Copilot の 3 つの AI ツールに対して同等のカスタムコマンド群を各ツールの設定形式に合わせて配置し、AI アシスタントの振る舞いをチーム全体で統一するパターン。段階的ワークフロー（分析 -> 再現 -> 修正のゲート付き）で AI の暴走を防ぎ、カスタム MCP ドキュメントサーバーで AI が自社フレームワークの最新 API を参照できる仕組みも含む。

## 背景・文脈

mastra-ai/mastra は 80 以上のパッケージを持つ大規模 TypeScript モノレポで、複数の AI コーディングツールを併用している。チームメンバーが Claude Code、Cursor、GitHub Copilot のいずれを使っても同じワークフロー（changeset 作成、コミット、PR 作成、issue デバッグ等）を AI に実行させたいという要求がある。また、自社フレームワークのドキュメントを AI が参照できるようにすることで、hallucination を低減し、API の正確な使用法をコード生成に反映させている。

## 実装パターン

### 1. 3 ツール並行コマンド配置

同一のワークフローを 3 つのディレクトリに並行配置する。各ツールの設定形式の差異はファイル名規則とフロントマターで吸収する。

```
# ディレクトリ構成 (mastra-ai/mastra)
.claude/commands/           # Claude Code 用
  changeset.md
  commit.md
  gh-debug-issue.md
  gh-pr-comments.md
  pr.md
  ...

.cursor/commands/           # Cursor 用
  changeset.md
  commit.md
  gh-debug-issue.md
  gh-pr-comments.md
  pr.md
  ...

.github/prompts/            # GitHub Copilot 用
  changeset.prompt.md       # 拡張子が .prompt.md
  commit.prompt.md
  gh-debug-issue.prompt.md
  gh-pr-comments.prompt.md
  pr.prompt.md
  ...
```

Claude Code と Cursor はファイル名・本文がほぼ同一。GitHub Copilot は YAML フロントマターと変数構文が異なる。

```markdown
<!-- .claude/commands/commit.md -->
# Commit

Commit the work you and the user have been doing. Make sure to use
conventional commits and write a concise but good commit message.
In the title, summarize the changes made. In the body, provide more
details about what was changed and why.

When you're done committing, push the changes up.
```

```markdown
<!-- .github/prompts/commit.prompt.md (GitHub Copilot 版) -->
---
agent: agent
description: Commit the work you and the user have been doing
---

# Commit

Commit the work you and the user have been doing. Make sure to use
conventional commits and write a concise but good commit message.
In the body, provide more details about what was changed and why.

When you're done committing, push the changes up.
```

### 2. 段階的ワークフローとゲート制御

`gh-debug-issue` コマンドは 3 ステージ構成で、各ステージにユーザー確認ゲートを設けて AI の先走りを防止する。

```markdown
<!-- .claude/commands/gh-debug-issue.md:13-44 -->
Debugging Github issues has 3 stages. Each stage must be fully
completed before moving on to the next.

## Stage 1 "Analyze"
1. The issue description and requirements
2. Any linked PRs or related issues
3. Comments and discussion threads
4. Labels and metadata

## Stage 2 "Reproduce"
Once you've analyzed the issue:
1. Create an ISSUE_SUMMARY${ISSUE_NUMBER}.md file in the project root
   and add a summary of what you've analyzed so far.
   Do not begin to fix the issue, that isn't our goal.
...
3. Ask the user for feedback on your issue summary document.
...
4. Now that the user agrees with your findings, write a test...
   The test MUST fail and clearly show the problem.
5. If the test is not running properly or is failing for unrelated
   reasons, your task is not finished.
6. Explain your failing test to the user. They must understand fully,
   and agree that the test really does reproduce the issue at hand.

## Stage 3 "Fix it!"
...
1. Commit the failing test to the current branch
2. Come up with a plan to fix the issue. Make sure the user agrees
   and is on the same page as you.
...
4. If you get stuck, ask the user for help!

You MUST first reproduce the issue in a test file, make sure the new
test is failing (IMPORTANT!) then finally add a code fix.
```

### 3. ツールごとの署名カスタマイズ

同一ワークフローでも、AI がコメントする際の署名をツールごとに変える。

```markdown
<!-- .claude/commands/gh-pr-comments.md:11 -->
Anytime you make a comment, be sure to start it with "Claude says: "
and sign off with your name at the end as well
```

```markdown
<!-- .github/prompts/gh-pr-comments.prompt.md:17 -->
Anytime you make a comment, be sure to start it with "Vscode says: "
and sign off with your name at the end as well
```

### 4. MCP ドキュメントサーバーによる AI のドキュメント参照

`.cursor/mcp.json` で自社製 MCP サーバーを設定し、AI がフレームワークのドキュメントをツールとして呼び出せるようにしている。

```json
// .cursor/mcp.json (開発者向け: ローカルソースを直接実行)
{
  "mcpServers": {
    "mastra": {
      "command": "pnpx",
      "args": ["tsx", "./packages/mcp-docs-server/src/stdio.ts"],
      "env": { "REBUILD_DOCS_ON_START": "true" }
    }
  }
}
```

```json
// templates/template-deep-research/.cursor/mcp.json (エンドユーザー向け: npm パッケージ経由)
{
  "mcpServers": {
    "mastra": {
      "command": "npx",
      "args": ["-y", "@mastra/mcp-docs-server"]
    }
  }
}
```

## Good Example

**段階的ワークフローで AI の暴走を防ぐ:**

```markdown
<!-- .claude/commands/gh-debug-issue.md の設計 -->
## Stage 2 "Reproduce"
4. Now that the user agrees with your findings, write a test...
   The test MUST fail and clearly show the problem.
5. If the test is not running properly or is failing for unrelated
   reasons, your task is not finished.
6. Explain your failing test to the user. They must understand fully.

## Stage 3 "Fix it!"
1. Commit the failing test to the current branch (don't commit the
   summary file)
2. Come up with a plan to fix the issue. Make sure the user agrees.
```

このコマンドが優れている点:

- ステージ 2 -> 3 の移行条件が「テストが失敗すること」と「ユーザーが合意すること」の 2 重ゲート
- 「テストが無関係な理由で失敗する場合はタスク未完了」と明示し、AI の早合点を防止
- 要約ファイルはコミットしない、失敗テストはコミットする、という成果物の区別が明確

**ツールに合わせた微調整を忘れない:**

```markdown
<!-- Claude Code 版: Claude says: -->
Anytime you make a comment, be sure to start it with "Claude says: "

<!-- GitHub Copilot 版: Vscode says: -->
Anytime you make a comment, be sure to start it with "Vscode says: "
```

PR コメントの発言者を明示することで、どの AI ツールが生成したコメントかをレビュアーが識別できる。

## Bad Example

**全コマンドを 1 つの AI ツールだけに設定する:**

```
# Bad: Claude Code のみにコマンドを配置
.claude/commands/
  changeset.md
  commit.md
  gh-debug-issue.md

# Cursor、Copilot を使うメンバーは手動で同じ手順を実行
# -> チーム内でワークフローの品質にばらつきが生まれる
```

```
# Good: 3 ツール並行配置
.claude/commands/changeset.md       # Claude Code
.cursor/commands/changeset.md       # Cursor
.github/prompts/changeset.prompt.md # GitHub Copilot
```

**ゲートなしで AI に全ステップを一気に実行させる:**

```markdown
<!-- Bad: ゲートなし -->
# Debug Issue
1. Issue を読む
2. コードを修正する
3. テストを書く
4. コミットする
<!-- -> AI が Issue を誤解したまま修正コードを書き、
      テストも修正に合わせて書くため問題が検出されない -->
```

```markdown
<!-- Good: ステージ制 + ゲート -->
## Stage 1 "Analyze"
  -> ユーザー確認ゲート
## Stage 2 "Reproduce"
  -> 失敗テスト確認ゲート + ユーザー確認ゲート
## Stage 3 "Fix"
  -> ユーザー確認ゲート
```

**手動コピーで同期を維持する（mastra 自身の課題でもある）:**

```
# Bad: 手動コピー（現状の mastra の方式）
.claude/commands/changeset.md  # 内容 A
.cursor/commands/changeset.md  # 内容 A（手動コピー）
.github/prompts/changeset.prompt.md  # 内容 A + フロントマター（手動変換）
# -> 片方を更新して他方を忘れるリスク
```

```
# Better: 共有ソースからの生成
shared/commands/changeset.md          # Single Source of Truth
.claude/commands/changeset.md         # 生成 or symlink
.cursor/commands/changeset.md         # 生成 or symlink
.github/prompts/changeset.prompt.md   # 生成（フロントマター自動付与）
```

## 適用ガイド

### どのような状況で使うべきか

- チーム内で Claude Code / Cursor / GitHub Copilot を混在利用している
- AI に定型ワークフロー（PR 作成、issue 対応、changeset 等）を任せたいが、品質を統一したい
- 自社フレームワークやライブラリがあり、AI にドキュメントを参照させたい

### 導入時の注意点

- **最小構成から始める**: まず 1-2 個のコマンド（commit, pr）から始め、効果を確認してから拡充する
- **ゲート設計が最重要**: 段階的ワークフローのゲート（ユーザー確認ポイント）が AI の暴走防止の要。ゲートなしのコマンドは単純な 1 ステップタスクに限定する
- **同期コストを見積もる**: 3 ツール並行管理は内容の同期が課題。CI で差分チェックするスクリプトを用意するか、Single Source of Truth からの生成パイプラインを構築することを検討する
- **GitHub Copilot のフロントマター**: `.github/prompts/` のファイルは YAML フロントマター（`agent:`, `description:`）と `.prompt.md` 拡張子が必要。変数構文も `$ISSUE` ではなく `${input:issue}` になる点に注意

### カスタマイズポイント

- **ステージ数の調整**: 単純なタスクは 2 ステージ、複雑なデバッグは 3 ステージ以上に分ける
- **ゲートの強度**: 「ユーザー確認必須」を基本とし、信頼できるタスクは「自動進行 + 結果報告」に緩和できる
- **MCP サーバーの対象**: 自社ドキュメントに限らず、社内 API 仕様書、デプロイ手順書、アーキテクチャ図の説明なども MCP ツール化の候補になる
- **署名のカスタマイズ**: PR コメントの署名（"Claude says:", "Vscode says:" 等）はチームの運用方針に合わせる

## 参考

- [repos/mastra-ai/mastra/ai-settings.md](../repos/mastra-ai/mastra/ai-settings.md) -- AI 設定の全体分析
- [repos/mastra-ai/mastra/dev-conventions.md](../repos/mastra-ai/mastra/dev-conventions.md) -- 開発規約とコマンド体系の分析
