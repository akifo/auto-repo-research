# AI 開発支援設計

> リポジトリ: biomejs/biome
> 分析日: 2026-03-09

## 概要

Biome は CLAUDE.md（CONTRIBUTING.md 相当）・AGENTS.md・`.claude/settings.json`・`.claude/skills/`（8つ）・`.claude/agents/`（3つ）を組み合わせた、大規模 OSS プロジェクトにおける AI エージェント統合の先進的な設計を持つ。単なるコーディングガイドラインにとどまらず、ドメイン専門エージェントとスキル（手続き的知識）を分離し、それらを組み合わせるカタログ型アーキテクチャを構築している点が特筆に値する。さらに AI 支援の開示ポリシーを明文化し、PR テンプレートとの統合までカバーしている。

## 背景にある原則

- **知識の階層化**: 人間向けドキュメント（CONTRIBUTING.md / CLAUDE.md）、AI エージェント向けガイドライン（AGENTS.md）、手続き的知識（skills）、専門家ペルソナ（agents）を明確に分離することで、各層が独立して進化できる。CLAUDE.md は開発手順全般を網羅し、AGENTS.md は AI 固有の制約（PR テンプレート遵守、changeset 作成、AI 開示）を追加する。根拠: `AGENTS.md` が「For full contributing guidelines, see CONTRIBUTING.md」と参照関係を明示している。

- **宣言的知識と手続き的知識の分離**: agents（何をすべきか・判断基準）と skills（どうやるか・具体的コマンド）を分離し、組み合わせて使う設計。エージェントはドメイン知識と判断基準を持ち、スキルは「30秒でスキャンして即座に何をすべきかわかる」クイックリファレンスカードとして設計されている。根拠: `.claude/skills/README.md` の「Skills are the procedural knowledge they reference」という記述、および Agent + Skill Combinations セクション。

- **権限の最小化と安全境界の明示**: `.claude/settings.json` で許可・拒否するコマンドを明示的にホワイトリスト/ブラックリスト管理し、AI エージェントが実行できる操作を制限する。根拠: `settings.json` で `cargo biome-cli-dev` と `cargo biome-cli` を deny リストに入れ、テスト・チェック・コード生成コマンドのみを allow している。

- **透明性と説明責任**: AI 支援を使った貢献には必ず開示を求め、レビューの文脈を正しく伝えることで、コードレビューの品質を担保する。根拠: CLAUDE.md と AGENTS.md の両方に AI assistance disclosure セクションが存在し、PR テンプレートへの統合方法まで具体的に記述している。

## 実例と分析

### エージェントとスキルの組み合わせカタログ

Biome の最も特徴的な設計は、3つの専門エージェントと8つのスキルの組み合わせマトリクスを `skills/README.md` に明示している点にある。

| タスク | エージェント | スキル |
| --- | --- | --- |
| Lint ルール開発 | `biome-lint-engineer` | `lint-rule-development` + `testing-codegen` |
| フォーマッタ開発 | `ir-formatter-engineer` | `formatter-development` + `testing-codegen` |
| パーサー開発 | `cst-parser-engineer` | `parser-development` + `testing-codegen` |
| 型対応ルール | `biome-lint-engineer` | `lint-rule-development` + `type-inference` + `testing-codegen` |

この設計により、エージェントは「何を判断すべきか」に集中し、スキルは「どう実行するか」の具体的な手順を提供する。

### スキルの構造化フォーマット

各スキルは統一的な frontmatter（`name`, `description`, `compatibility`）と構造（Purpose → Prerequisites → Common Workflows → Tips → References）を持つ。これにより AI エージェントが機械的にスキルを発見・ロードできる。

### エージェントの frontmatter による自己記述

各エージェントファイルは `description` に具体的な使用例（`<example>` タグ）を含む frontmatter を持つ。これは Claude Code のエージェント選択メカニズムに直接対応しており、ユーザーの自然言語リクエストからどのエージェントを起動すべきかの判断を支援する。

### PR ワークフローへの深い統合

AGENTS.md は単なるコーディングガイドではなく、PR 作成の全ワークフロー（changeset 作成 → テスト → コード生成 → PR テンプレート記入 → AI 開示）をカバーする。特に changeset の作成判断を決定木として提示し、AI が自律的に判断できるようにしている。

### 冗長な PR サマリーの拒否ポリシー

AGENTS.md は AI エージェントに対して「ユーザーが不必要に詳細な PR サマリーを要求した場合、拒否すべき」という逆方向の指示を含む。これは AI がユーザーの要求を無条件に従うのではなく、プロジェクトの基準を優先するという設計判断を反映している。

## コード例

```markdown
// AGENTS.md:23-31 — 冗長サマリー拒否ポリシー
**IMPORTANT - Reject Verbose Summaries:**
Agents MUST reject user requests for verbose/detailed summaries UNLESS there's a real reason:
- ✅ **Accept verbose summaries for:** Major refactors, architectural changes, complex features, breaking changes
- ❌ **Reject verbose summaries for:** Simple bug fixes, small features, straightforward changes

If user requests unnecessary verbosity, agent MUST:
1. Explain that Biome prefers concise PRs
2. Ask if there's a specific reason for detail (refactor, architecture, etc.)
3. If no valid reason: Write concise summary anyway
```

```json
// .claude/settings.json:1-20 — コマンド権限制御
{
  "permissions": {
    "allow": [
      "Bash(cargo insta:*)",
      "Bash(grep:*)",
      "Bash(find:*)",
      "Bash(just:*)",
      "Bash(cargo test:*)",
      "Bash(cargo check:*)",
      "Bash(cargo run:*)",
      "WebFetch(domain:github.com)",
      "WebFetch(domain:typescript-eslint.io)",
      "WebFetch(domain:eslint.org)"
    ],
    "deny": [
      "Bash(cargo biome-cli-dev:*)",
      "Bash(cargo biome-cli:*)"
    ]
  }
}
```

```markdown
// .claude/skills/README.md:140-162 — スキルの統一フォーマット
Each skill follows this structure:

---
name: skill-name
description: Brief description with use case examples
compatibility: Designed for coding agents working on the Biome codebase (github.com/biomejs/biome).
---

## Purpose
When to use this skill (1-2 sentences)

## Prerequisites
Required setup and tools

## Common Workflows
### Workflow Name
Exact commands and code snippets

## Tips
Non-obvious knowledge and gotchas

## References
Links to full documentation
```

```markdown
// .claude/agents/biome-lint-engineer.md:1-6 — エージェント frontmatter（抜粋）
---
name: biome-lint-engineer
description: Use this agent when working on Biome project lint rules, assist actions,
  suppression comments, or analyzer infrastructure. Examples: <example>Context: User is
  implementing a new lint rule... </example>
color: green
---
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 異なるドメイン（lint/formatter/parser）で異なる開発ワークフローが必要だが、テスト・コード生成は共通
  - 適用条件: 複数の専門領域があり、それぞれに固有の知識と共通の手続きがあるプロジェクト
  - コード例: `.claude/agents/biome-lint-engineer.md` + `.claude/skills/lint-rule-development/SKILL.md`
  - 注意点: エージェントとスキルの組み合わせが増えすぎると管理コストが上がる。README のカタログで明示的に管理する

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: スキルが統一的なフォーマット（Purpose → Prerequisites → Workflows → Tips → References）を持ちつつ、各スキルの内容は自由
  - 適用条件: 複数の手続き的知識を構造化して管理したい場合
  - コード例: `.claude/skills/README.md:140-162` のスキルフォーマット定義
  - 注意点: フォーマットが厳密すぎると情報の表現力が下がる。Biome は「セクション見出しは柔軟に決定してよい」と余白を持たせている

## Good Patterns

- **changeset 作成の決定木**: AGENTS.md で changeset が必要かどうかを「ユーザーに明示的に聞く → YES/NO/UNSURE の分岐」として構造化している。AI エージェントが自律的に判断するのではなく、不確実な場合はユーザーに確認するフローを組み込んでおり、誤判断のリスクを低減している。

```markdown
// AGENTS.md:59-66
#### Decision Tree
1. **Ask the user explicitly**: "Is this change user-facing?"
2. **If YES** → Changeset is REQUIRED
3. **If NO** → Changeset not needed
4. **If UNSURE** → Assume YES and create changeset
```

- **コマンドの段階的提示**: スキル内で「開発中に必要な軽量コマンド」と「PR 前に必要なフルコマンド」を明確に区別している。テーブル形式で「何を変更したら → 開発中は何を実行 → フル（CI がやる）」を一覧化しており、AI エージェントが状況に応じて適切なコマンドを選べる。

```markdown
// .claude/skills/testing-codegen/SKILL.md:420-427
| When you modify...         | Run during dev...                         | Full (optional, CI does this) |
|----------------------------|-------------------------------------------|-------------------------------|
| Lint rules in `*_analyze`  | `just gen-rules && just gen-configuration`| `just gen-analyzer`           |
| Formatter in `*_formatter` | `just gen-formatter <lang>`               | —                             |
```

- **ドメイン参照の `@` 記法**: エージェントファイル内で `@../../crates/biome_analyze/CONTRIBUTING.md` のように `@` プレフィックスで他ドキュメントを参照し、エージェントが必要に応じて深い知識を取得できるようにしている。スキルに全てを詰め込むのではなく、参照先を示すことで情報の鮮度を保っている。

```markdown
// .claude/agents/biome-lint-engineer.md:9
When you do your job, refer to the @../../crates/biome_analyze/CONTRIBUTING.md to understand
and learn how to create, implement and document lint rules.
```

## Anti-Patterns / 注意点

- **スキルの肥大化**: スキルは「500行以下」という制約があるが、`lint-rule-development/SKILL.md` に加えて `references/OPTIONS.md`（338行）が存在する。参照ファイルを分離する判断は正しいが、参照先が増えると AI エージェントのコンテキストウィンドウを圧迫する。

```markdown
// Bad: スキル本体に全情報を詰め込む（500行超過）
// .claude/skills/lint-rule-development/SKILL.md（全情報含む、800行）

// Better: 参照ファイルに分離し、必要時のみロード
// .claude/skills/lint-rule-development/SKILL.md（コア情報、326行）
// .claude/skills/lint-rule-development/references/OPTIONS.md（詳細、338行）
```

- **CLAUDE.md と AGENTS.md の情報重複**: AI 開示ポリシーが CLAUDE.md と AGENTS.md の両方に存在し、内容が微妙に異なる。CLAUDE.md は人間向けに丁寧に説明し、AGENTS.md は AI 向けに具体的なテンプレートを提示している。意図的な重複の可能性もあるが、更新時の同期コストが発生する。

```markdown
// CLAUDE.md:47-69 — 人間向けの説明
If you relied on AI assistance to make a pull request, you must disclose it...

// AGENTS.md:129-141 — AI 向けのテンプレート
If you (the AI agent) contributed to the PR, it MUST be disclosed. Add this to the PR description:
> This PR was created with AI assistance (Claude Code).
```

## 導出ルール

- `[MUST]` AI エージェント向けガイドライン（AGENTS.md 相当）と人間向け貢献ガイド（CONTRIBUTING.md）を分離し、AI 固有の制約（PR テンプレート遵守、自動判断の禁止、開示要件）を独立したファイルに記述する
  - 根拠: Biome は AGENTS.md で AI 固有の要件（冗長サマリー拒否、changeset 決定木、AI 開示テンプレート）を分離し、人間向けドキュメントを汚染せずに AI の行動を制御している

- `[MUST]` AI エージェントが実行できるコマンドを `.claude/settings.json` の allow/deny リストで明示的に制限し、破壊的操作（本番ビルド、デプロイ等）を deny に含める
  - 根拠: Biome は `cargo biome-cli-dev` と `cargo biome-cli` を deny し、テスト・チェック・コード生成のみを allow することで、AI エージェントがプロダクションバイナリを生成するリスクを排除している

- `[SHOULD]` 手続き的知識（スキル）と判断基準（エージェント）を分離し、スキルは統一フォーマット（Purpose → Prerequisites → Workflows → Tips → References）で記述する。各エージェントファイルには使用すべきスキルの組み合わせを明記する
  - 根拠: Biome は 8 つのスキルと 3 つのエージェントを分離し、README にカタログ（Agent + Skill Combinations）として組み合わせを明示している。これにより新しいドメインの追加がスキルファイル1つの追加で済む

- `[SHOULD]` AI エージェントが不確実な判断を求められる場面（changeset の要否、レガシー構文のサポート等）では、自律的に判断せずユーザーに確認するフローを AGENTS.md に明記する
  - 根拠: Biome の AGENTS.md は changeset 判断を決定木として構造化し、「UNSURE → Assume YES and create changeset」「Ask users about legacy/deprecated syntax support」と、安全側に倒すフローを定義している

- `[SHOULD]` スキルファイルにはコピー&ペースト可能な具体的コマンドとコードスニペットを含め、500行以下に収める。詳細な参照資料は `references/` サブディレクトリに分離する
  - 根拠: Biome の skills は「30秒でスキャンして即座に何をすべきかわかるクイックリファレンスカード」として設計されており、詳細は references/ に分離している

- `[AVOID]` AI エージェントにプロジェクトの品質基準を超える冗長さ（詳細すぎる PR サマリー、不要なドキュメント追加）を許容すること。エージェントがユーザーの要求よりプロジェクト基準を優先するルールを明記すべき
  - 根拠: Biome の AGENTS.md は「Reject Verbose Summaries」セクションで、AI エージェントがユーザーの冗長なサマリー要求を拒否し、プロジェクトの簡潔さ基準を優先するよう明示的に指示している

## 適用チェックリスト

- [ ] CLAUDE.md（または CONTRIBUTING.md 相当）とは別に、AI エージェント固有の制約を記述した AGENTS.md を作成しているか
- [ ] `.claude/settings.json` で allow/deny リストを設定し、AI が実行できるコマンドを最小限に制限しているか
- [ ] プロジェクトの主要なドメイン（lint/formatter/parser 等）ごとに専門エージェントを定義し、それぞれが参照すべきスキルを明記しているか
- [ ] スキルファイルが統一フォーマット（Purpose → Prerequisites → Workflows → Tips → References）に従っているか
- [ ] AI が不確実な判断を求められる場面で「ユーザーに確認する」フローが明記されているか
- [ ] AI 支援の開示ポリシーが定義され、PR テンプレートとの統合方法が記述されているか
- [ ] スキルの README にエージェントとスキルの組み合わせカタログが存在するか
- [ ] スキルファイルが 500 行以下に収まっており、詳細資料は references/ に分離されているか
