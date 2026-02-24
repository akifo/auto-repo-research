# Claude: Hierarchical AGENTS.md

> 出典: [repos/promptfoo/promptfoo](../repos/promptfoo/promptfoo/)、[repos/openclaw/openclaw](../repos/openclaw/openclaw/)、[repos/ryoppippi/ccusage](../repos/ryoppippi/ccusage/)
> カテゴリ: claude

## 概要

ルートの CLAUDE.md から AGENTS.md への委任、ディレクトリごとのローカル AGENTS.md、docs/agents/ の横断的ガイド、PostToolUse フックによる自動品質保証を組み合わせた AI エージェント運用設計。コンテキストの局所性を提供することで、AI エージェントが大規模コードベースでも「今必要な情報だけ」を取得できる構造を実現する。

## 背景・文脈

AI エージェントが大規模コードベース（2,000+ ファイル）で作業する際、2 つの問題が衝突する:

1. **コンテキスト不足**: プロジェクト固有の規約・パターン・禁止事項を知らずにコードを生成し、レビューで差し戻される
2. **コンテキスト過多**: 全ルールを 1 ファイルに詰め込むと、トークンウィンドウを浪費し、重要なルールが埋没する

promptfoo/promptfoo は 13 個の AGENTS.md + 6 個の docs/agents/ ガイドによる 3 層構造でこの問題を解決した。ルートがハブ、各サブディレクトリがスポークとして機能し、エージェントは作業ディレクトリに応じて必要なコンテキストだけをロードする。vercel/ai も同様にルート AGENTS.md + packages/ai/AGENTS.md のパッケージ別構造を採用しており、大規模 TypeScript プロジェクトにおけるデファクトパターンになりつつある。

## 実装パターン

### 1. CLAUDE.md → AGENTS.md 委任パターン

CLAUDE.md をエントリポイントとし、実質的なガイダンスは AGENTS.md に集約する。

```markdown
<!-- promptfoo/promptfoo CLAUDE.md:1 -->

@AGENTS.md
```

promptfoo ではルートを含む 12 箇所すべてで CLAUDE.md が `@AGENTS.md` の一行のみ。メンテナンス対象は AGENTS.md だけに集約される。この設計により Claude Code 以外のエージェント（Codex、Cursor 等）も同じ AGENTS.md を参照できるツール非依存性を獲得する。

### 2. ルート AGENTS.md のハブ構造

ルートにプロジェクト構造テーブルを設置し、各ディレクトリのローカルドキュメントへのリンクを明示する。

```markdown
<!-- promptfoo/promptfoo AGENTS.md:9-24 -->

## Project Structure

| Directory        | Purpose                       | Local Docs                |
| ---------------- | ----------------------------- | ------------------------- |
| `src/app/`       | Web UI (React 19/Vite/MUI v7) | `src/app/AGENTS.md`       |
| `src/commands/`  | CLI commands                  | `src/commands/AGENTS.md`  |
| `src/providers/` | LLM providers                 | `src/providers/AGENTS.md` |
| `src/redteam/`   | Security testing              | `src/redteam/AGENTS.md`   |
| `test/`          | Tests (Vitest)                | `test/AGENTS.md`          |

**Read the relevant AGENTS.md when working in that directory.**
```

最後の一文「Read the relevant AGENTS.md when working in that directory.」がエージェントに自律的なコンテキスト探索を促す。

### 3. サブディレクトリ AGENTS.md のドメイン固有コンテキスト

各サブディレクトリの AGENTS.md は独立して読める構成で、ドメイン固有のパターン・アンチパターン・参照ファイルを含む。

```markdown
<!-- promptfoo/promptfoo src/commands/AGENTS.md:91-95 -->

## Do / Don't

**Do:** Use logger, track telemetry, validate with Zod, set exitCode on errors
**Don't:** Use console, throw in action handlers, skip telemetry, use `process.exit()`
```

```markdown
<!-- promptfoo/promptfoo src/providers/AGENTS.md:88-98 -->

**All seven items are required** before a provider is complete:

1. Implement `ApiProvider` interface
2. Add env vars to `src/types/env.ts`
3. Add env vars to `src/envars.ts`
4. Add tests in `test/providers/`
5. Add docs in `site/docs/providers/<provider>.md`
6. Add entry to `site/docs/providers/index.md` table
7. Add example in `examples/<provider>/`
```

チェックリスト形式はエージェントが「何を忘れやすいか」を網羅的にカバーし、完了条件を明確にする。

### 4. docs/agents/ による横断的関心事の分離

ディレクトリに紐づかない横断的トピックを独立ドキュメントとして管理し、ルートから条件付きで参照する。

```markdown
<!-- promptfoo/promptfoo AGENTS.md:268-284 -->

## Additional Documentation

Read these when relevant to your task:

| Document                               | When to Read             |
| -------------------------------------- | ------------------------ |
| `docs/agents/pr-conventions.md`        | Creating pull requests   |
| `docs/agents/git-workflow.md`          | Git operations           |
| `docs/agents/dependency-management.md` | Updating packages        |
| `docs/agents/logging.md`               | Adding logging to code   |
| `docs/agents/python.md`                | Python providers/scripts |
| `docs/agents/database-security.md`     | Writing database queries |
```

「When to Read」列により、エージェントは現在のタスクに関連するドキュメントだけを選択的に読み込める。

### 5. 参照ファイルパターン

AGENTS.md 内でパターンを説明する際、必ず実際のコードファイルを参照先として指定する。

```markdown
<!-- promptfoo/promptfoo test/AGENTS.md:35-38 -->

**Reference files:**

- **Vitest (frontend)**: `src/app/src/hooks/usePageMeta.test.ts` - explicit imports
- **Vitest (backend)**: `test/assertions/contains.test.ts` - explicit imports
```

```markdown
<!-- promptfoo/promptfoo src/providers/AGENTS.md:24-28 -->

**Reference implementations:**

- `openai.ts` - Most comprehensive
- `anthropic/index.ts` - Complex provider with subdirectory
- `http.ts` - Generic HTTP pattern
```

AGENTS.md の説明文が古くなっても、参照先のコードが最新のパターンを示し続ける。コードが真実の情報源（Source of Truth）として機能する設計。

### 6. PostToolUse フックによる自動品質保証

エージェントが「lint を忘れる」問題をドキュメントの指示ではなくシステムレベルで解決する。

```json
// promptfoo/promptfoo .claude/settings.json:1-15
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "npm run l && npm run f"
          }
        ]
      }
    ]
  }
}
```

Edit/Write 操作後に自動的に lint + format が実行される。エージェントの指示遵守に依存せず、品質を構造的に保証する。

## Good Example

**3 層構造で責務を分離:**

```
project-root/
├── CLAUDE.md                    # @AGENTS.md（委任のみ）
├── AGENTS.md                    # Layer 0: プロジェクト全体のマップ + コマンド + Git 規約
│   ├── Project Structure テーブル（→ 各 AGENTS.md へのリンク）
│   ├── Build Commands
│   ├── Git Workflow (CRITICAL)
│   └── Additional Documentation テーブル（→ docs/agents/ へのリンク）
│
├── src/commands/AGENTS.md       # Layer 1: CLI コマンド固有パターン + Do/Don't
├── src/providers/AGENTS.md      # Layer 1: プロバイダ実装チェックリスト
├── test/AGENTS.md               # Layer 1: テスト戦略 + Zustand パターン + アンチパターン
│
├── docs/agents/
│   ├── git-workflow.md          # Layer 2: Git 操作の詳細手順
│   ├── pr-conventions.md        # Layer 2: PR タイトル規約 + THE REDTEAM RULE
│   └── logging.md               # Layer 2: ログサニタイズ仕様
│
└── .claude/settings.json        # PostToolUse フックで自動 lint/format
```

**禁止事項の具体的な記述（docs/agents/git-workflow.md）:**

```markdown
<!-- promptfoo/promptfoo docs/agents/git-workflow.md:1-16 -->

## Critical Rules

1. **NEVER** commit directly to main
2. **NEVER** merge branches into main directly
3. **NEVER** push to main - EVER
4. **NEVER** use `--force` without explicit approval
5. **ALWAYS** create new commits - never amend or rebase unless explicitly asked

**Forbidden commands:**

- `git push origin main`
- `git merge feature-branch` while on main
- Any direct commits to main
```

禁止キーワード（NEVER/ALWAYS/Forbidden）と具体的なコマンド名の組み合わせにより、LLM が曖昧な表現を無視する傾向に対抗する。

## Bad Example

**全ルールを 1 ファイルに集約:**

```markdown
<!-- Bad: AGENTS.md が 800 行超で全情報を内包 -->

# AGENTS.md

## Project Structure... (50行)

## Build Commands... (30行)

## Coding Style... (80行)

## Testing Guidelines... (100行)

## Provider Development... (120行)

## Git Workflow... (80行)

## PR Conventions... (200行)

## Logging... (50行)

## Database Security... (40行)

## Python... (50行)

<!-- AI がファイルの前半を読み終えた頃には、後半の重要なルールの重みが下がる -->
<!-- 全ディレクトリのルールが混在し、現在のタスクに無関係な情報がノイズになる -->
```

```markdown
<!-- Better: ルートはマップとリンクに限定し、詳細は分離 -->

# AGENTS.md (root, ~280行)

## Project Structure

| Directory | Local Docs |

<!-- 各ディレクトリの AGENTS.md にリンク -->

## Additional Documentation

| Document | When to Read |

<!-- docs/agents/ に条件付きリンク -->
```

**AGENTS.md とスキルの情報重複:**

```markdown
<!-- Bad: 同じタグ参照表が 2 箇所に存在 -->
<!-- promptfoo/promptfoo src/redteam/plugins/AGENTS.md -->

## Quick Tag Reference

| Correct | Incorrect |
| `<UserQuery>` | `<UserPrompt>`, `<UserInput>`, `<prompt>` |

<!-- .claude/skills/redteam-plugin-development/skill.md にも同じテーブル -->
<!-- -> メンテナンス時に片方だけ更新されるリスク -->
```

```markdown
<!-- Better: AGENTS.md は概要のみ、詳細はスキルに一本化 -->
<!-- src/redteam/plugins/AGENTS.md -->

See `.claude/skills/redteam-plugin-development/skill.md` for full standards.

<!-- タグ参照表はスキルファイルにのみ記載 -->
```

## 適用ガイド

### どのような状況で使うべきか

- **ディレクトリごとに異なるドメイン知識が必要な中〜大規模プロジェクト** -- src/app/ は React、src/providers/ は API 統合、test/ はテスト戦略と、領域ごとに必要な知識が異なる場合に効果的
- **複数の AI ツールが同一コードベースで動作する環境** -- CLAUDE.md → AGENTS.md 委任により、Claude Code 以外のエージェントも同じドキュメントを参照できる
- **AI エージェントが同じミスを繰り返す場合** -- ミスが発生するディレクトリの AGENTS.md に Do/Don't やアンチパターンのコード例を追加する

### 導入の段階

1. **最小構成**: ルート AGENTS.md + CLAUDE.md（`@AGENTS.md`）+ `.claude/settings.json`（PostToolUse フック）
2. **ディレクトリ分離**: AI がよく作業するディレクトリにローカル AGENTS.md を追加。テストディレクトリが最初の候補
3. **横断的関心事の分離**: Git ワークフロー、PR 規約、ロギング等を docs/agents/ に分離し、ルートから条件付き参照テーブルでリンク
4. **タスク特化**: 繰り返し実行する複雑なタスクがあればスキルファイルとしてパッケージ化

### 注意点

- **ルート AGENTS.md は 300 行以下を目安とする** -- 超えたら横断的関心事を docs/agents/ に分離するシグナル
- **各 AGENTS.md は独立して読めるようにする** -- ルートを読まなくても、そのディレクトリでの作業に必要十分な情報を含める
- **参照ファイルの存在を維持する** -- Reference file のリンク切れはエージェントの学習品質を低下させる。ファイル移動時に AGENTS.md も更新する
- **情報の正式な情報源を 1 箇所に集約する** -- 同じ情報を複数の AGENTS.md に書かない。重要度最高のルールのみ例外的に繰り返す

## 参考

- [repos/promptfoo/promptfoo/ai-settings.md](../repos/promptfoo/promptfoo/ai-settings.md) -- 13 個の AGENTS.md と 3 層ドキュメント体系の分析
- [repos/promptfoo/promptfoo/dev-conventions.md](../repos/promptfoo/promptfoo/dev-conventions.md) -- Biome/Prettier 規約と PostToolUse フックの分析
- [showcases/claude_progressive-context-loading.md](claude_progressive-context-loading.md) -- 4 層コンテキストローディング戦略（openclaw, ccusage 出典）
- [showcases/claude_agent-command-guardrails.md](claude_agent-command-guardrails.md) -- 禁止コマンド列挙とガードレール設計
