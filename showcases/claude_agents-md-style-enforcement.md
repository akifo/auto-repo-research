# AGENTS.md によるスタイル強制

> 出典: repos/anomalyco/opencode, repos/cloudflare/agents, repos/vercel/chat, repos/cloudflare/partykit
> カテゴリ: claude

## 概要

AGENTS.md（または CLAUDE.md）に AI エージェント向けのコーディング規約を明文化し、AI が生成するコードの品質を構造的に制御する手法。単なるスタイルガイドではなく、「AI の出力傾向を矯正する」目的で設計された規約ドキュメントであり、命名・制御フロー・エラーハンドリング・ツール権限まで網羅する。4つのリポジトリの異なるアプローチを横断的に比較し、プロジェクト規模に応じた最適な構成パターンを示す。

## 背景・文脈

AI コーディングエージェント（Claude Code, OpenCode, Cursor 等）は強力だが、放置すると冗長な変数名、過剰な防御コード、不要なコメント、プロジェクト固有のイディオムを無視したコードを生成する傾向がある。4つの大規模 OSS プロジェクトがそれぞれ異なるアプローチでこの課題に対処している:

| リポジトリ          | 規模           | ファイル構成                   | 特徴                                       |
| ------------------- | -------------- | ------------------------------ | ------------------------------------------ |
| anomalyco/opencode  | 1273ファイル   | 7つの AGENTS.md + `.opencode/` | AI 命名矯正、ツール権限制御、多重防御      |
| cloudflare/agents   | 中規模モノレポ | 6階層 AGENTS.md + design/ RFC  | Always/Ask first/Never 境界、Diataxis 統合 |
| vercel/chat         | 中規模         | 単一 CLAUDE.md (339行)         | Ultracite コード規約埋め込み、ツール適用   |
| cloudflare/partykit | 10パッケージ   | 単一 AGENTS.md (196行)         | コマンド中心、設定ファイルの「意図」補完   |

## 実装パターン

### パターン1: AI 出力矯正型（opencode）

AI が生成するコードの品質劣化パターンを直接抑制する規約。

```markdown
<!-- anomalyco/opencode AGENTS.md:25-33 -->

### Naming Enforcement (Read This)

THIS RULE IS MANDATORY FOR AGENT WRITTEN CODE.

- Use single word names by default for new locals, params, and helper functions.
- Multi-word names are allowed only when a single word would be unclear or ambiguous.
- Do not introduce new camelCase compounds when a short single-word alternative is clear.
- Before finishing edits, review touched lines and shorten newly introduced identifiers where possible.
- Good short names to prefer: `pid`, `cfg`, `err`, `opts`, `dir`, `root`, `child`, `state`, `timeout`.
```

### パターン2: 行動境界型（cloudflare/agents）

AI の自律性を3段階で制御し、影響範囲の広い操作にブレーキをかける。

```markdown
<!-- cloudflare/agents AGENTS.md:156-179 -->

Always:

- Run `npm run check` before considering work done
- Use `import type` for type-only imports
- Keep examples simple and self-contained

Ask first:

- Adding new dependencies to `packages/`
- Changing compatibility dates across the repo
- Modifying CI workflows

Never:

- Hardcode secrets or API keys
- Add native/FFI dependencies
- Use `any`
- Force push to main
```

### パターン3: ツール権限ホワイトリスト型（opencode）

エージェントごとにツールアクセスを宣言的に制御する。

```markdown
<!-- anomalyco/opencode .opencode/agent/duplicate-pr.md:1-9 -->
---
mode: primary
hidden: true
model: opencode/claude-haiku-4-5
color: "#E67E22"
tools:
  "*": false
  "github-pr-search": true
---
```

### パターン4: 階層配置によるスコープ制御

ディレクトリ階層に沿って AGENTS.md を配置し、作業対象に応じたコンテキストだけを AI に注入する。

```markdown
<!-- cloudflare/agents AGENTS.md:40-50 -->

## Nested AGENTS.md files

| File                        | Scope                                                                     |
| --------------------------- | ------------------------------------------------------------------------- |
| `packages/agents/AGENTS.md` | Core SDK internals — exports, source layout, build, testing, architecture |
| `examples/AGENTS.md`        | Example conventions — required structure, consistency rules, known issues |
| `docs/AGENTS.md`            | Writing user-facing docs — Diátaxis framework, upstream sync, style       |
| `design/AGENTS.md`          | Design records and RFCs — format, workflow, relationship to docs          |
```

### パターン5: プロンプト+バリデーション多重防御（opencode）

AI への自然言語指示と、ツール内のプログラム的バリデーションを併用する。

```typescript
// anomalyco/opencode .opencode/tool/github-triage.ts:79-85
// プロンプトで「zen ラベルは zen が含まれる場合のみ」と指示しつつ、
// ツール実行時にも同じルールをハードコードで強制する
if (labels.includes("zen") && !zen) {
  throw new Error("Only add the zen label when issue title/body contains 'zen'");
}

if (web && !nix && !(TEAM.desktop as readonly string[]).includes(assignee)) {
  throw new Error("Web issues must be assigned to adamdotdevin, iamdavidhill, Brendonovich, or nexxeln");
}
```

## Good Example

**規模に応じたファイル構成の選択:**

```
# 小規模（~10パッケージ）: 単一ファイル（partykit 方式）
project/
  AGENTS.md          # 196行以内、全情報を1ファイルに凝縮

# 中規模（10-30パッケージ）: ルート + サブ1階層（opencode 方式）
project/
  AGENTS.md          # ルート: 全体スタイル + ナビゲーションテーブル
  packages/core/
    AGENTS.md        # パッケージ固有: DB スキーマ、マイグレーション規約
  packages/app/
    AGENTS.md        # パッケージ固有: UI フレームワーク規約
  packages/app/e2e/
    AGENTS.md        # テスト固有: セレクタ規約、フィクスチャ

# 大規模（30+パッケージ、ドキュメント重要）: 多階層 + design/（agents 方式）
project/
  AGENTS.md          # ルート: 概要 + ナビテーブル + Always/Ask/Never
  packages/sdk/
    AGENTS.md        # SDK 固有
  examples/
    AGENTS.md        # Example 規約
  docs/
    AGENTS.md        # Diataxis 分類
  design/
    AGENTS.md        # RFC ワークフロー
```

**AI 矯正ルールの構成:**

```markdown
# Good: AI の出力傾向を直接抑制する具体的なルール

## Naming Enforcement

- Use single word names by default
- Good: `pid`, `cfg`, `err`, `opts`
- Bad: `inputPID`, `existingClient`, `connectTimeout`

## Control Flow

- Avoid `else`. Use early returns.
- Avoid `try`/`catch`. Use `.catch(() => default)`.

## Destructuring

- Avoid. Use dot notation: `obj.a` not `const { a } = obj`
```

## Bad Example

```markdown
# Bad: 抽象的すぎてAIが具体的な行動に移せない

## Style Guide

- Write clean code
- Follow best practices
- Use meaningful variable names
- Handle errors properly
```

```markdown
# Bad: ツールで自動適用できる規約をAIコンテキストに大量埋め込み

## Code Standards (100+ lines of lint rules)

- indent: 2 spaces
- semi: false
- quotes: double
- trailing-comma: none
  ...

<!-- これらは Biome/ESLint の設定ファイルで強制すべき -->
```

```markdown
# Bad: 全パッケージの情報を1ファイルに詰め込む（200行超）

## Package A Rules

...50 lines...

## Package B Rules

...50 lines...

## Package C Rules

...50 lines...

<!-- スコープごとにファイルを分割すべき -->
```

## 適用ガイド

### いつ使うべきか

- AI コーディングエージェントをプロジェクトで常用している場合
- AI が生成するコードのスタイルが既存コードベースと乖離する場合
- 複数の AI ツール（Claude Code, OpenCode, Cursor）を横断して一貫した規約を適用したい場合

### 導入時の注意点

1. **ツールで強制できるルールは AI コンテキストに含めない**: フォーマット（Prettier/Biome）、リント（ESLint/oxlint）で自動適用できるルールは設定ファイルに任せ、AGENTS.md には「AI が判断に迷う箇所」のみを記載する
2. **1ファイル200行を目安とする**: コンテキストウィンドウの圧迫を防ぐ。超過する場合はサブディレクトリに分割する
3. **具体例（Good/Bad）を必ず含める**: AI は抽象的な原則より具体的なコード例から学習する
4. **プロンプト指示だけに頼らない**: 重要なルールはツール内バリデーションやリンターでも強制する（多重防御）
5. **定期的に AI 出力を監査し、規約を更新する**: AI の傾向は変わるため、`rmslop` のようなスロップ検出コマンドで品質を継続監視する

### カスタマイズポイント

| 要素         | 選択肢                                         | 判断基準                                  |
| ------------ | ---------------------------------------------- | ----------------------------------------- |
| ファイル構成 | 単一 / 2階層 / 多階層                          | パッケージ数とドメインの多様性            |
| 行動境界     | 2段階(Always/Never) / 3段階(+Ask first)        | AI の自律性レベルと操作のリスク度         |
| ツール権限   | デフォルト許可 / デフォルト禁止+ホワイトリスト | エージェントの目的の限定度                |
| 規約の粒度   | 原則レベル / コード例レベル                    | AI の規約遵守率（低ければ具体例を増やす） |
| 多重防御     | プロンプトのみ / +バリデーション / +リンター   | ルール違反時のリスクの大きさ              |

## 参考

- [repos/anomalyco/opencode/ai-settings.md](../repos/anomalyco/opencode/ai-settings.md) — opencode の AI 設定戦略
- [repos/anomalyco/opencode/design-philosophy.md](../repos/anomalyco/opencode/design-philosophy.md) — opencode の設計哲学
- [repos/cloudflare/agents/ai-settings.md](../repos/cloudflare/agents/ai-settings.md) — cloudflare/agents の6階層 AGENTS.md
- [repos/cloudflare/partykit/ai-settings.md](../repos/cloudflare/partykit/ai-settings.md) — partykit の単一ファイル戦略
- [repos/vercel/chat/ai-settings.md](../repos/vercel/chat/ai-settings.md) — vercel/chat の CLAUDE.md 設計
