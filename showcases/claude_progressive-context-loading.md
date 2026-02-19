# Claude: Progressive Context Loading

> 出典: [repos/openclaw/openclaw](../repos/openclaw/openclaw/), [repos/ryoppippi/ccusage](../repos/ryoppippi/ccusage/)
> カテゴリ: claude

## 概要

CLAUDE.md / AGENTS.md / .claude/ ディレクトリ / サブディレクトリ AGENTS.md / skills を階層的に設計し、AI エージェントに段階的にコンテキストをロードさせる手法。コンテキストウィンドウを「公共財」として扱い、必要な時に必要な分だけ情報を提供することで、トークン消費の最適化と指示の遵守率向上を両立する。

## 背景・文脈

AI エージェント（Claude Code, OpenAI Codex 等）がコードベースを操作する際、プロジェクトの規約・アーキテクチャ・禁止事項・ワークフローといった大量のコンテキストが必要になる。しかし、これらを 1 ファイルに詰め込むと以下の問題が生じる:

1. **トークン浪費**: 現在のタスクに無関係な情報もロードされる
2. **指示の埋没**: 重要なルールが大量のテキストに埋もれ、AI が見落とす
3. **保守コストの増大**: 1 ファイルが肥大化し、更新時の影響範囲が把握しづらい

openclaw/openclaw（193K+ Stars の大規模 TypeScript プロジェクト）と ryoppippi/ccusage（TypeScript モノレポの CLI ツール群）は、それぞれ異なるアプローチで階層的コンテキスト設計を実践しており、両者を組み合わせることで Progressive Context Loading の全体像が見えてくる。

## 実装パターン

### 1. コンテキスト階層の全体設計

AI エージェントが読み込むコンテキストを 4 層に分離する。上位ほど常時ロードされ、下位ほど必要時のみ参照される。

```
Layer 0: 常時ロード (~100 words)
  └── CLAUDE.md / AGENTS.md (ルート)
      ├── ビルドコマンド、最重要ルール、パッケージ構成の概要

Layer 1: 作業ディレクトリ連動 (100-300 行)
  └── サブディレクトリの CLAUDE.md / AGENTS.md
      ├── パッケージ固有のアーキテクチャ、データフロー、ドメイン知識

Layer 2: トリガー時ロード (<5k words)
  └── .claude/skills/*/SKILL.md
      ├── 特定タスク用の詳細手順、ライブラリドキュメント参照

Layer 3: 必要時のみ参照
  └── bundled resources, node_modules 内ドキュメント, MCP サーバー
      ├── 外部ライブラリの API リファレンス、大規模ドキュメント
```

### 2. ルート CLAUDE.md / AGENTS.md の設計

ルートのコンテキストファイルは「常時ロード」される前提で、簡潔さと網羅性のバランスが重要になる。

**openclaw のアプローチ: AGENTS.md をカノニカルファイル名とする**

```
# openclaw/openclaw のファイル構成
$ ls -la CLAUDE.md
lrwxr-xr-x CLAUDE.md -> AGENTS.md
```

```markdown
<!-- AGENTS.md:130 -->

When adding a new AGENTS.md anywhere in the repo,
also add a CLAUDE.md symlink pointing to it.
```

AGENTS.md を正とし、CLAUDE.md はシンボリックリンクにすることで、AI ツールベンダーに依存しない中立的なファイル名を維持する。新しい AI ツールが別のファイル名を期待しても、リンクの追加だけで対応できる。

**ccusage のアプローチ: CLAUDE.md を正とし AGENTS.md をシンボリックリンクにする**

```
# ryoppippi/ccusage のファイル構成
apps/ccusage/AGENTS.md -> CLAUDE.md
apps/codex/AGENTS.md -> CLAUDE.md
apps/mcp/AGENTS.md -> CLAUDE.md
apps/opencode/AGENTS.md -> CLAUDE.md
```

どちらを正とするかはプロジェクトの方針次第だが、「単一ソースからの複数ツール対応」という原則は共通している。

### 3. サブディレクトリによるスコープドコンテキスト

**openclaw: モジュール固有の注意事項をスコープドファイルに分離**

```
# サブディレクトリの AGENTS.md 配置例
src/gateway/server-methods/AGENTS.md   # Pi セッションの transcript 操作
docs/ja-JP/AGENTS.md                   # 日本語翻訳パイプラインの作業指示
docs/reference/templates/AGENTS.md     # エージェントワークスペースのブートストラップ
```

AI エージェントが `src/gateway/server-methods/` 内で作業する場合、ルートの AGENTS.md に加えてこのスコープド AGENTS.md が自動的にロードされる。モジュール固有の注意事項（データ形式の制約、API の呼び出し規約等）をルートに混ぜず分離できる。

**ccusage: パッケージ別 CLAUDE.md の二極化スタイル**

```markdown
<!-- 構造化スタイル (apps/ccusage/CLAUDE.md) -->
<!-- パッケージ固有の構造・コマンド・アーキテクチャを定型セクションで記述 -->

## Package Overview

## Development Commands

## Architecture

## Testing

## Dependencies
```

```markdown
<!-- ドメイン知識スタイル (apps/codex/CLAUDE.md) -->
<!-- 外部データソースの形式・計算ロジック等のドメイン辞書を記述 -->

## Token Fields

- `input_tokens`: total input tokens sent to the model.
- `cached_input_tokens`: cached portion of the input.
- `output_tokens`: normal output tokens.
```

汎用パッケージには構造テンプレートを、外部データソース統合パッケージにはドメイン辞書を提供するという使い分けにより、AI が実装時に必要とする情報の種類に合わせてコンテキストを最適化している。

### 4. Skills による詳細コンテキストのオンデマンドロード

skills は「トリガーされた時だけ」詳細なコンテキストをロードする仕組みで、Progressive Context Loading の中核をなす。

**openclaw の 3 層ローディング設計:**

```
metadata（常時ロード ~100 words）
  → SKILL.md body（トリガー時 <5k words）
    → bundled resources（必要時のみ）
```

```markdown
<!-- skills/skill-creator/SKILL.md:117-119 -->
<!-- metadata は常時ロードされるが、body はスキル呼び出し時のみ -->
<!-- bundled resources は body 内のリンクから必要時に参照 -->
```

**ccusage の node_modules 参照パターン:**

```yaml
# .claude/skills/byethrow/SKILL.md:1-5
---
name: byethrow
description: Reference the byethrow documentation to understand and use
  the Result type library for error handling in JavaScript/TypeScript.
allowed-tools: Read, Grep, Glob
---
```

```markdown
<!-- .claude/skills/byethrow/SKILL.md:12 -->

For detailed API references and usage examples, refer to the documentation
in `node_modules/@praha/byethrow-docs/docs/**/*.md`.
```

ライブラリドキュメントを npm パッケージ化し、skills から `node_modules` 内のドキュメントを参照させる。バージョン管理はパッケージマネージャに委譲される。

### 5. ガードレールの配置戦略

禁止事項やガードレールの「どの階層に置くか」は、Progressive Context Loading の設計で最も重要な判断の一つである。

**openclaw: 具体的コマンドレベルの禁止リスト（ルート AGENTS.md）**

```markdown
<!-- AGENTS.md:152-157 -->

- **Multi-agent safety:** do **not** create/apply/drop `git stash` entries
  unless explicitly requested
- **Multi-agent safety:** when the user says "push", you may
  `git pull --rebase` to integrate latest changes
  (never discard other agents' work).
- **Multi-agent safety:** do **not** create/remove/modify `git worktree`
  checkouts unless explicitly requested.
- **Multi-agent safety:** do **not** switch branches / check out a different
  branch unless explicitly requested.
```

**ccusage: CRITICAL/NEVER/ALWAYS マーカーによる強調（ルート CLAUDE.md 末尾）**

```markdown
<!-- CLAUDE.md:296-310 -->

# Tips for Claude Code

- Context7 MCP server available for library documentation lookup
- use-gunshi-cli skill available for gunshi CLI framework documentation
- do not use console.log. use logger.ts instead
- **CRITICAL VITEST REMINDER**: Vitest globals are enabled - use `describe`,
  `it`, `expect` directly WITHOUT imports. NEVER use `await import()`
  dynamic imports anywhere, especially in test blocks.

# important-instruction-reminders

Do what has been asked; nothing more, nothing less.
NEVER create files unless they're absolutely necessary for achieving your goal.
ALWAYS prefer editing an existing file to creating a new one.
NEVER proactively create documentation files (*.md) or README files.
```

ccusage ではこれらを CLAUDE.md の末尾に配置している。AI が最後に読むコンテキストとして recency bias を活用し、行動指針としての影響力を高める設計である。

### 6. .mcp.json と pnpm catalog による外部コンテキスト統合

Layer 3 の「必要時のみ参照」を実現する仕組みとして、MCP サーバーとドキュメントパッケージがある。

```json
// .mcp.json (ryoppippi/ccusage)
{
  "mcpServers": {
    "context7": { "type": "http", "url": "https://mcp.context7.com/mcp" },
    "grep": { "type": "http", "url": "https://mcp.grep.app" }
  }
}
```

```yaml
# pnpm-workspace.yaml (ryoppippi/ccusage)
catalogs:
  llm-docs:
    '@gunshi/docs': ^0.27.5
    '@praha/byethrow-docs': ^0.9.0
```

LLM 向けドキュメント依存を `llm-docs` カテゴリとして独立管理し、ランタイム依存やビルド依存と明確に分離する。AI エージェントは skills 経由でこれらのドキュメントを必要時にのみ参照する。

## Good Example

**階層的に分離されたコンテキスト設計:**

```
project-root/
├── CLAUDE.md                          # Layer 0: 横断的ルール + 概要
│   ├── Quick Reference (ビルドコマンド)
│   ├── Code Style Notes (全体規約)
│   ├── Git Commit Conventions
│   └── Tips for Claude Code (AI 専用チートシート)
│
├── AGENTS.md -> CLAUDE.md             # マルチツール対応シンボリックリンク
│
├── apps/
│   ├── web/
│   │   ├── CLAUDE.md                  # Layer 1: パッケージ固有情報
│   │   └── AGENTS.md -> CLAUDE.md
│   └── api/
│       ├── CLAUDE.md                  # Layer 1: ドメイン知識型
│       └── AGENTS.md -> CLAUDE.md
│
├── .claude/
│   ├── skills/
│   │   ├── byethrow/SKILL.md          # Layer 2: オンデマンドロード
│   │   └── use-gunshi-cli/SKILL.md    # Layer 2: ライブラリガイド
│   └── commands/
│       └── reduce-similarities.md     # カスタムコマンド
│
├── .mcp.json                          # Layer 3: 外部ツール統合
└── pnpm-workspace.yaml                # llm-docs カテゴリ
```

各レイヤーの責務が明確に分離されている:

- Layer 0 は全タスクで参照される最小限の情報
- Layer 1 は作業ディレクトリに応じて自動ロード
- Layer 2 は特定タスクでのみトリガー
- Layer 3 は AI が自発的に必要と判断した時のみ呼び出し

**禁止事項の具体的な記述:**

```markdown
<!-- Good: 具体的なコマンド名で禁止 -->

- Do **not** run `git add -A` or `git add .`. Stage only specific files.
- Do **not** create/apply/drop `git stash` entries unless explicitly requested.
- Do **not** switch branches unless explicitly requested.
- NEVER use `await import()` dynamic imports anywhere.
- NEVER create files unless absolutely necessary for achieving your goal.
```

## Bad Example

**1 ファイルに全ルールを詰め込む:**

```markdown
<!-- Bad: ルートの CLAUDE.md が 500 行超で全情報を含む -->

# CLAUDE.md

## Project Structure... (50行)

## Build & Test Commands... (30行)

## Coding Style... (80行)

## Testing Guidelines... (60行)

## Security... (40行)

## Git Conventions... (30行)

## Multi-agent Safety... (50行)

## Package-specific Notes... (100行)

## API Domain Knowledge... (80行)

<!-- -> AI がファイルの前半を読み終えた頃には
      後半の重要なルールが注意から外れている -->
```

```markdown
<!-- Good: ルートは概要とリンクに限定し、詳細は分離 -->

# CLAUDE.md (root, ~100行)

## Quick Reference

- Build: `pnpm build`
- Test: `pnpm test`

## Code Style (横断的ルールのみ)

## Critical Rules

- NEVER use `await import()` dynamic imports
- NEVER run `git add .`

## Package-specific Context

→ See each package's CLAUDE.md for details
```

**曖昧な禁止表現:**

```markdown
<!-- Bad: 何を禁止しているか具体的でない -->

- 安全にリポジトリを操作してください
- 注意深くコミットしてください
- 他のエージェントの邪魔にならないようにしてください
```

```markdown
<!-- Good: 具体的なコマンド・操作を列挙 -->

- Do **not** create/apply/drop `git stash` entries
- Do **not** create/remove/modify `git worktree` checkouts
- Do **not** switch branches / check out a different branch
- When committing, scope to your changes only
```

**全パッケージに同一ガードレールを重複記載:**

```markdown
<!-- Bad: 6 ファイルに同一ルールを微妙に異なる文言で記載 -->

<!-- CLAUDE.md:279 -->

- **IMPORTANT**: DO NOT use `await import()` dynamic imports anywhere

<!-- apps/ccusage/CLAUDE.md:71 -->

- **CRITICAL**: NEVER use `await import()` dynamic imports anywhere,
  especially in test blocks

<!-- apps/amp/CLAUDE.md:56 -->

- **CRITICAL**: NEVER use `await import()` dynamic imports anywhere,
  especially in test blocks.

<!-- -> 文言の微差が保守コストを増やし、修正漏れの原因になる -->
```

```markdown
<!-- Good: ルートに集約し、子は参照のみ。本当に重要なものだけ繰り返す -->

<!-- Root CLAUDE.md -->

- **CRITICAL**: NEVER use `await import()` dynamic imports anywhere

<!-- Package CLAUDE.md -->

## Code Style

Follow the code style guidelines defined in the root `CLAUDE.md`
(## Code Style Notes section).
```

## 適用ガイド

### どのような状況で使うべきか

- **モノレポでパッケージごとに異なるドメイン知識がある**: Layer 1 のサブディレクトリ CLAUDE.md でパッケージ固有情報を分離する
- **複数の AI ツール（Claude Code, Codex, Cursor）を併用している**: AGENTS.md <-> CLAUDE.md のシンボリックリンクで単一ソースを共有する
- **AI が同じミスを繰り返す**: CRITICAL/NEVER/ALWAYS マーカー付きでルートの CLAUDE.md 末尾にガードレールを追加する
- **AI に特定ライブラリの使い方を教えたい**: skills + node_modules ドキュメント参照で Layer 2 のオンデマンドロードを構築する
- **マルチエージェント環境（複数の AI が同一リポジトリを操作）**: 禁止コマンドリストを Layer 0 に具体的に列挙する

### 導入時の注意点

- **Layer 0 は簡潔に保つ**: ルートの CLAUDE.md が 200 行を超えたら分割を検討する。openclaw の 185 行でも肥大化の兆候が指摘されている
- **ルールの重複は最小限に**: 重要度が最高のルールのみ子パッケージでも繰り返す。それ以外はルートへの参照で済ませる
- **recency bias を活用する**: AI エージェント専用のガードレール（Tips / important-instruction-reminders）は CLAUDE.md の末尾に配置する
- **シンボリックリンクの一貫性**: 「AGENTS.md を正とする」か「CLAUDE.md を正とする」かをプロジェクトで統一し、新しいサブディレクトリでも同じパターンを適用する

### カスタマイズポイント

- **Layer 数の調整**: 小規模プロジェクトなら Layer 0 + Layer 2（skills）の 2 層で十分。大規模モノレポなら 4 層すべてを活用する
- **ドメイン知識型 vs 構造化型**: パッケージの性質に応じて CLAUDE.md のスタイルを使い分ける。外部 API 連携パッケージにはドメイン辞書、汎用ユーティリティには構造テンプレートが適する
- **MCP サーバーの選択**: Context7（汎用ライブラリドキュメント）、grep.app（コード検索）、自社ドキュメントサーバーなど、プロジェクトに必要な外部ツールを `.mcp.json` で宣言する
- **pnpm catalog の llm-docs カテゴリ**: AI 向けドキュメントパッケージが npm で利用可能なら、専用カテゴリで依存管理することでバージョン統制が効く

## 参考

- [repos/openclaw/openclaw/ai-settings.md](../repos/openclaw/openclaw/ai-settings.md) -- AI 設定体系とマルチエージェント安全性の分析
- [repos/openclaw/openclaw/dev-conventions.md](../repos/openclaw/openclaw/dev-conventions.md) -- 開発規約とスコープドコミットツールの分析
- [repos/ryoppippi/ccusage/ai-settings.md](../repos/ryoppippi/ccusage/ai-settings.md) -- 階層的 CLAUDE.md 設計とドキュメント配布の分析
- [repos/ryoppippi/ccusage/dev-conventions.md](../repos/ryoppippi/ccusage/dev-conventions.md) -- 開発規約とモノレポ運用の分析
