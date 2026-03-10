# Claude: ドメイン専門エージェント+スキルカタログによる AI 開発支援設計

> 出典: [repos/biomejs/biome/ai-settings.md](../repos/biomejs/biome/ai-settings.md)
> カテゴリ: claude

## 概要

大規模コードベースで AI エージェントを活用する際、ドメイン専門の「エージェント」（判断基準・ペルソナ）と「スキル」（手続き的知識）を分離し、組み合わせカタログとして管理する手法。エージェントは「何を判断すべきか」に集中し、スキルは「どう実行するか」の具体的手順を提供することで、新しいドメインの追加がスキルファイル1つで済み、既存エージェントの知識汚染を防ぐ。

## 背景・文脈

Biome は JavaScript/TypeScript 向けの lint・formatter・parser を統合したツールチェインで、Rust で実装された大規模 OSS プロジェクトである。lint ルール開発、IR ベースのフォーマッタ開発、CST パーサー開発という3つの専門領域があり、それぞれ固有のドメイン知識と共通のテスト・コード生成手続きを持つ。

この構造に対して Biome は `.claude/agents/`（3つの専門エージェント）と `.claude/skills/`（8つのスキル）を定義し、README にカタログとして組み合わせを明示している。さらに `AGENTS.md` で AI 固有の行動制約を、`.claude/settings.json` でコマンド権限を制御し、多層的な AI ガバナンスを実現している。

## 実装パターン

### 1. エージェントとスキルの分離

エージェントは「ドメイン専門家のペルソナ + 判断基準」を定義し、スキルは「具体的なコマンドとワークフロー」を提供する。

```markdown
<!-- .claude/agents/biome-lint-engineer.md:1-18 -->
---
name: biome-lint-engineer
description: Use this agent when working on Biome project lint rules, assist actions,
  suppression comments, or analyzer infrastructure. Examples: <example>Context: User is
  implementing a new lint rule... </example>
color: green
---

You are an expert software engineer specializing in the Biome project's lint rules,
assist actions, and analyzer infrastructure.

When you do your job, refer to the @../../crates/biome_analyze/CONTRIBUTING.md to understand
and learn how to create, implement and document lint rules.

**Available Skills:**
Reference these skills from @../../.claude/skills/ for step-by-step workflows:
- **lint-rule-development** - Scaffolding, implementation patterns, semantic model usage, testing, configurable options
- **type-inference** - Working with module graph and type system for type-aware rules
- **testing-codegen** - Testing workflows, snapshot management, code generation
- **diagnostics-development** - Creating clear, actionable error messages
```

ポイント:

- `description` に `<example>` タグで具体的なユースケースを列挙し、Claude Code のエージェント選択を支援する
- `@../../path` 記法で既存ドキュメントを参照し、エージェント内に知識を複製しない
- Available Skills セクションでどのスキルを使うかを明示する

### 2. 組み合わせカタログ

スキルの README にエージェントとスキルの推奨組み合わせを一覧化する。

```markdown
<!-- .claude/skills/README.md:109-134 -->
## Agent + Skill Combinations

### Lint Rule Development
**Agent:** `biome-lint-engineer`
**Skills:** `lint-rule-development` + `testing-codegen`
**Use for:** Implementing new lint rules, adding semantic analysis, creating code actions

### Formatter Development
**Agent:** `ir-formatter-engineer`
**Skills:** `formatter-development` + `testing-codegen`
**Use for:** Implementing formatting rules, handling comments, comparing with Prettier

### Type-Aware Rules
**Agent:** `biome-lint-engineer`
**Skills:** `lint-rule-development` + `type-inference` + `testing-codegen`
**Use for:** Rules that need type information, semantic analysis across modules
```

### 3. コマンド権限の明示的制御

`.claude/settings.json` で AI が実行できるコマンドをホワイトリスト/ブラックリストで管理する。

```json
// .claude/settings.json
{
  "permissions": {
    "allow": [
      "Bash(cargo insta:*)",
      "Bash(cargo test:*)",
      "Bash(cargo check:*)",
      "Bash(just:*)",
      "WebFetch(domain:github.com)"
    ],
    "deny": [
      "Bash(cargo biome-cli-dev:*)",
      "Bash(cargo biome-cli:*)"
    ]
  }
}
```

テスト・チェック・コード生成は許可し、プロダクションバイナリの生成は禁止している。

### 4. AI 固有の行動制約（AGENTS.md）

人間向け CONTRIBUTING.md とは別に、AI エージェント専用の行動ルールを定義する。

```markdown
<!-- AGENTS.md:23-31 -->
**IMPORTANT - Reject Verbose Summaries:**
Agents MUST reject user requests for verbose/detailed summaries UNLESS there's a real reason:
- ✅ **Accept verbose summaries for:** Major refactors, architectural changes, complex features
- ❌ **Reject verbose summaries for:** Simple bug fixes, small features, straightforward changes

If user requests unnecessary verbosity, agent MUST:
1. Explain that Biome prefers concise PRs
2. Ask if there's a specific reason for detail
3. If no valid reason: Write concise summary anyway
```

```markdown
<!-- AGENTS.md:59-66 -->
#### Decision Tree
1. **Ask the user explicitly**: "Is this change user-facing?"
2. **If YES** → Changeset is REQUIRED
3. **If NO** → Changeset not needed
4. **If UNSURE** → Assume YES and create changeset
```

## Good Example

エージェントとスキルを分離し、カタログで組み合わせを管理する設計。

```
.claude/
├── agents/
│   ├── biome-lint-engineer.md      # ドメイン知識 + 判断基準
│   ├── ir-formatter-engineer.md    # ドメイン知識 + 判断基準
│   └── cst-parser-engineer.md      # ドメイン知識 + 判断基準
├── skills/
│   ├── README.md                   # カタログ（組み合わせ一覧）
│   ├── lint-rule-development/
│   │   ├── SKILL.md                # 手続き的知識（< 500行）
│   │   └── references/OPTIONS.md   # 詳細資料（必要時のみロード）
│   ├── formatter-development/
│   │   └── SKILL.md
│   ├── testing-codegen/            # 共通スキル（全エージェントが使う）
│   │   └── SKILL.md
│   └── ...
└── settings.json                   # コマンド権限制御
```

- エージェントは「何の専門家か」「どんな場面で起動すべきか」を宣言する
- スキルは「30秒でスキャンして即座に何をすべきかわかるクイックリファレンスカード」として設計する
- `testing-codegen` のような横断的スキルは複数エージェントから共有される
- 詳細資料は `references/` に分離し、コンテキストウィンドウの圧迫を防ぐ

## Bad Example

全てのドメイン知識と手順を1ファイルに詰め込む設計。

```markdown
<!-- Bad: CLAUDE.md に全情報を集約 -->
# CLAUDE.md

## Lint ルール開発
あなたは lint ルール開発の専門家です...
### 手順
1. `just new-js-lintrule myRuleName` を実行
2. ...（200行の手順）

## フォーマッタ開発
あなたはフォーマッタ開発の専門家です...
### 手順
1. `FormatNodeRule` を実装
2. ...（200行の手順）

## パーサー開発
あなたはパーサー開発の専門家です...
### 手順
1. `.ungram` を編集
2. ...（200行の手順）
```

この設計の問題:

- lint ルール作業時にフォーマッタとパーサーの知識がコンテキストを圧迫する
- ドメインの追加/変更時にファイル全体の整合性を維持する必要がある
- エージェントのペルソナ（判断基準）と手続き（手順）が混在し、どちらも中途半端になる

## 適用ガイド

### どのような状況で使うべきか

- コードベースに3つ以上の専門領域があり、それぞれ異なるワークフローを持つプロジェクト
- 複数の AI エージェントが同じリポジトリで作業する可能性があるプロジェクト
- テスト・コード生成など領域横断的な共通手続きが存在するプロジェクト

### 導入ステップ

1. **ドメインの特定**: プロジェクトの主要な作業領域を洗い出す（例: API 開発、DB マイグレーション、フロントエンド）
2. **共通手続きの抽出**: テスト実行、デプロイ、コード生成など、複数領域で共通するワークフローをスキル化する
3. **エージェント定義**: 各ドメインの専門家ペルソナを定義し、`description` に `<example>` タグでユースケースを列挙する
4. **カタログ作成**: `skills/README.md` にエージェントとスキルの推奨組み合わせを一覧化する
5. **権限設定**: `.claude/settings.json` で allow/deny リストを設定する
6. **AGENTS.md 作成**: AI 固有の行動制約（冗長性の拒否、不確実時の確認フロー、開示要件）を記述する

### カスタマイズポイント

- **スキルの粒度**: Biome は8スキルだが、小規模プロジェクトなら3-4スキルで十分。「1スキル = 1つの明確な作業カテゴリ」を目安にする
- **エージェント数**: ドメイン数に応じて増減する。ドメインが2つ以下なら CLAUDE.md にインラインで記述しても管理可能
- **参照ファイルの分離**: スキルが500行を超えそうなら `references/` サブディレクトリに詳細資料を分離する
- **決定木の追加**: プロジェクト固有の判断ポイント（例: マイグレーションの要否、バージョニング方針）を AGENTS.md に決定木として追加する

### 注意点

- エージェントとスキルの組み合わせが増えすぎると管理コストが上がる。README のカタログで明示的に管理し、不要になったスキルは削除する
- CLAUDE.md と AGENTS.md で情報が重複しやすい。CLAUDE.md は人間+AI 共通のルール、AGENTS.md は AI 固有の制約という分担を徹底する
- スキルの情報鮮度を保つため、実装の詳細はスキルに書かず `@path` 参照で既存ドキュメントを指し示す

## 参考

- [repos/biomejs/biome/ai-settings.md](../repos/biomejs/biome/ai-settings.md) — 元の分析
