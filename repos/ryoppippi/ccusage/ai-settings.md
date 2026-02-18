# AI Settings

> リポジトリ: ryoppippi/ccusage
> 分析日: 2026-02-16

## 概要

ccusage は monorepo 全体で 10 個の CLAUDE.md（合計 1,158 行）、2 つの skills、1 つの custom command、MCP サーバー統合、そして pnpm catalog を活用した LLM ドキュメント配布を組み合わせ、AI エージェントが各パッケージの文脈を正確に把握できる階層的コンテキスト設計を実現している。特に「ライブラリドキュメントを node_modules 経由で配布し skills から参照させる」パターンと、ルート CLAUDE.md に全体方針を集約し各パッケージ CLAUDE.md でドメイン固有知識を補完する二層構造は、monorepo における AI 協調開発の実践的なリファレンスとなる。

## 背景にある原則

- **階層的コンテキスト分離**: ルート CLAUDE.md にコードスタイル・Git 規約・テストガイドラインなど横断的ルールを集約し、各パッケージの CLAUDE.md にはそのパッケージ固有のアーキテクチャ・データフロー・依存関係を記述する。AI エージェントは作業ディレクトリに応じて必要なコンテキストだけを取得でき、トークン消費を最適化できる（ルート CLAUDE.md:5-16 の Monorepo Structure セクション）
- **学習済み失敗のガードレール化**: 過去に AI が繰り返した誤り（動的 import の使用、console.log の直接呼び出し、不要なファイル生成）を `CRITICAL`/`NEVER`/`ALWAYS` のマーカー付きで明示的に禁止し、同一ミスの再発を防止する（ルート CLAUDE.md:279, 302, 304-310）
- **ドキュメント依存の npm パッケージ化**: ライブラリの使い方ガイドを `@gunshi/docs`, `@praha/byethrow-docs` として npm パッケージ化し、pnpm catalog の `llm-docs` カテゴリで管理する。skills が `node_modules` 内のドキュメントを直接参照することで、バージョン管理・依存解決・更新の仕組みをパッケージマネージャに委譲している（pnpm-workspace.yaml:29-31, SKILL.md 内のドキュメントパス指定）
- **MCP による外部ツール統合**: ESLint MCP、Context7 MCP、grep MCP をプロジェクトレベルの `.mcp.json` で宣言し、AI エージェントがリント・ドキュメント検索・コード検索をツールとして直接実行できる環境を構築する（.mcp.json, ルート CLAUDE.md:128-133）

## 実例と分析

### 1. ルート CLAUDE.md の構造設計

ルート CLAUDE.md は 310 行に及び、以下の 10 セクションで構成される:

1. **Monorepo Structure** — パッケージ一覧と各 CLAUDE.md へのポインタ
2. **Development Commands** — 全パッケージ共通のコマンド体系
3. **Architecture Overview** — データフロー・キーコンポーネントの概要
4. **Git Commit and PR Conventions** — Conventional Commits + scope 規約
5. **Code Style Notes** — ESLint 設定・import 規約・export ルール・命名規約
6. **Documentation Guidelines** — スクリーンショット配置ルール
7. **Claude Models and Testing** — テストにおけるモデル名の正確性
8. **Tips for Claude Code** — AI エージェント向けの短い行動ガイド
9. **important-instruction-reminders** — AI の行動制約（ファイル生成禁止等）

注目すべきは「Tips for Claude Code」と「important-instruction-reminders」が独立セクションとして末尾に配置されている点である。これらは AI が最後に読む位置にあり、直前のコンテキストとして行動に強い影響を与える recency bias を活用した配置と解釈できる。

### 2. パッケージ別 CLAUDE.md の役割分担

パッケージ別 CLAUDE.md は 2 つのスタイルに分かれる:

**構造化スタイル**（ccusage, mcp, pi, terminal, docs）:

- Package Overview / Development Commands / Architecture / Testing / Code Style / Dependencies / Exports の定型セクション
- ルートの規約を繰り返さず、パッケージ固有情報に集中

**ドメイン知識スタイル**（codex, amp, opencode）:

- Log Sources / Token Fields / Cost Calculation / CLI Usage / Testing Notes
- 外部サービスのデータ形式・計算ロジックなど、AI が実装時に参照すべきドメイン固有知識を詳述

この二極化は意図的であり、汎用パッケージには構造テンプレートを、外部データソース統合パッケージにはドメイン辞書を提供する戦略となっている。

### 3. AGENTS.md シンボリックリンク戦略

```
apps/ccusage/AGENTS.md -> CLAUDE.md
apps/codex/AGENTS.md -> CLAUDE.md
apps/mcp/AGENTS.md -> CLAUDE.md
apps/opencode/AGENTS.md -> CLAUDE.md
```

4 つの apps パッケージで `AGENTS.md` が `CLAUDE.md` へのシンボリックリンクとなっている。これは Claude Code は `CLAUDE.md` を、OpenAI Codex は `AGENTS.md` を参照するため、単一のソースファイルで複数の AI エージェントに同一コンテキストを提供するマルチエージェント対応パターンである。

### 4. Skills によるライブラリドキュメント提供

2 つの skill がそれぞれ異なるアプローチで AI にライブラリ知識を供給する:

**byethrow skill**: `allowed-tools: Read, Grep, Glob` を指定し、`node_modules/@praha/byethrow-docs/docs/**/*.md` を AI が直接読み取る。さらに CLI コマンド（`npx @praha/byethrow-docs list/search/toc`）でドキュメントの検索・閲覧も可能にしている。

**use-gunshi-cli skill**: `globs: '*.ts, *.tsx, *.js, *.jsx, package.json'` でファイルパターンを限定し、`node_modules/@gunshi/docs/**.md` を参照先として指定する。`alwaysApply: false` により必要時のみ呼び出される設計。

両 skill とも `node_modules` 内のドキュメントパッケージを参照先とし、ドキュメントのバージョン管理を pnpm catalog に委譲している。

### 5. Custom Command による品質維持

`.claude/commands/reduce-similarities.md` は `similarity-ts .` コマンドを実行し、コードベースの重複パターンを検出してリファクタリング計画を立てるよう AI に指示する。これは AI エージェントの分析能力を「コード生成」ではなく「コード品質の監視」に活用する例である。

### 6. pnpm catalog の llm-docs カテゴリ

```yaml
# pnpm-workspace.yaml
catalogs:
  llm-docs:
    '@gunshi/docs': ^0.27.5
    '@praha/byethrow-docs': ^0.9.0
```

ライブラリドキュメントを pnpm catalog の専用カテゴリで管理することで、LLM 向けドキュメント依存がランタイム依存（`runtime`）やビルド依存（`build`）と明確に分離される。ルート `package.json` の `devDependencies` にのみ記載され、各 apps パッケージには伝播しない。

### 7. .mcp.json によるプロジェクトレベル MCP 統合

```json
{
  "mcpServers": {
    "context7": { "type": "http", "url": "https://mcp.context7.com/mcp" },
    "grep": { "type": "http", "url": "https://mcp.grep.app" }
  }
}
```

プロジェクトルートの `.mcp.json` で HTTP 型の MCP サーバーを宣言し、AI エージェントが Context7（ライブラリドキュメント検索）と grep.app（コード検索）をツールとして利用できる環境を整備している。CLAUDE.md 内でも「Context7 MCP server available for library documentation lookup」と明記し、AI に利用を促している。

## コード例

ルートの CLAUDE.md における「Tips for Claude Code」セクション:

```markdown
// CLAUDE.md:296-302

# Tips for Claude Code

- Context7 MCP server available for library documentation lookup
- use-gunshi-cli skill available for gunshi CLI framework documentation
- byethrow skill available for @praha/byethrow Result type documentation
- do not use console.log. use logger.ts instead
- **CRITICAL VITEST REMINDER**: Vitest globals are enabled - use `describe`, `it`, `expect` directly WITHOUT imports. NEVER use `await import()` dynamic imports anywhere, especially in test blocks.
```

ルートの CLAUDE.md における「important-instruction-reminders」セクション:

```markdown
// CLAUDE.md:304-310

# important-instruction-reminders

Do what has been asked; nothing more, nothing less.
NEVER create files unless they're absolutely necessary for achieving your goal.
ALWAYS prefer editing an existing file to creating a new one.
NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.
Dependencies should always be added as devDependencies unless explicitly requested otherwise.
```

byethrow skill によるドキュメント参照パターン:

```yaml
// .claude/skills/byethrow/SKILL.md:1-5
---
name: byethrow
description: Reference the byethrow documentation to understand and use the Result type library for error handling in JavaScript/TypeScript.
allowed-tools: Read, Grep, Glob
---
```

```markdown
// .claude/skills/byethrow/SKILL.md:12
For detailed API references and usage examples, refer to the documentation in `node_modules/@praha/byethrow-docs/docs/**/*.md`.
```

pnpm catalog による LLM ドキュメント管理:

```yaml
// pnpm-workspace.yaml:29-31
  llm-docs:
    '@gunshi/docs': ^0.27.5
    '@praha/byethrow-docs': ^0.9.0
```

AGENTS.md シンボリックリンク:

```
// apps/ccusage/AGENTS.md -> CLAUDE.md (シンボリックリンク)
// apps/codex/AGENTS.md -> CLAUDE.md
// apps/mcp/AGENTS.md -> CLAUDE.md
// apps/opencode/AGENTS.md -> CLAUDE.md
```

custom command による重複コード検出:

```markdown
// .claude/commands/reduce-similarities.md:1
Run `similarity-ts .` to detect semantic code similarities. Execute this command, analyze the duplicate code patterns, and create a refactoring plan. Check `similarity-ts -h` for detailed options.
```

## パターンカタログ

- **Hierarchical Context Pattern** (分類: 構造)
  - 解決する問題: monorepo で AI エージェントに適切なスコープのコンテキストを提供する必要がある
  - 適用条件: monorepo 構成で、パッケージごとに異なるドメイン知識や規約が存在する場合
  - コード例: `CLAUDE.md:5-16` (ルートの Monorepo Structure セクション), `apps/ccusage/CLAUDE.md` (パッケージ固有コンテキスト)
  - 注意点: ルートと子パッケージ間でルールが重複すると矛盾リスクが生じる。ルートは横断的ルール、子は固有知識に限定する

- **Documentation-as-Dependency Pattern** (分類: 構造)
  - 解決する問題: AI エージェントが参照するライブラリドキュメントのバージョン管理と配布
  - 適用条件: AI が頻繁に参照する外部ライブラリがあり、そのドキュメントが npm パッケージとして提供されている場合
  - コード例: `pnpm-workspace.yaml:29-31` (llm-docs catalog), `.claude/skills/byethrow/SKILL.md:12` (node_modules 参照)
  - 注意点: ドキュメントパッケージがない場合は skill 内にインラインで記述するか、Context7 MCP に委譲する

- **Guardrail Reinforcement Pattern** (分類: 振る舞い)
  - 解決する問題: AI エージェントが繰り返す特定の誤りを防止する
  - 適用条件: AI が過去に犯したミスパターンが特定されている場合
  - コード例: `CLAUDE.md:279` (動的 import 禁止), `CLAUDE.md:302` (CRITICAL VITEST REMINDER)
  - 注意点: 全パッケージの CLAUDE.md に同一ガードレールを記載すると保守コストが高い。ルートに集約し、特に重要なものだけ子でも繰り返す

## Good Patterns

- **Tips for Claude Code セクション**: AI エージェント専用の短い行動指針セクションを設け、利用可能な skill・MCP サーバー・禁止事項を箇条書きで列挙する。人間向けドキュメントとは別に AI 向けの「すぐ参照できるチートシート」として機能する。

```markdown
# Tips for Claude Code

- Context7 MCP server available for library documentation lookup
- use-gunshi-cli skill available for gunshi CLI framework documentation
- do not use console.log. use logger.ts instead
```

- **AGENTS.md シンボリックリンク**: `AGENTS.md -> CLAUDE.md` のシンボリックリンクにより、Claude Code と OpenAI Codex の両方に同一コンテキストを単一ソースから供給する。ファイルの二重管理を排除し、一方だけ更新して整合性が崩れるリスクを根本的に解消する。

```
apps/ccusage/AGENTS.md -> CLAUDE.md
```

- **pnpm catalog の llm-docs カテゴリ**: LLM 向けドキュメント依存を独立カテゴリで管理し、runtime/build/lint などの他カテゴリと明確に分離する。`catalogMode: strict` により全依存が catalog 経由で管理されるため、LLM ドキュメントのバージョンも厳格に統制される。

```yaml
catalogs:
  llm-docs:
    '@gunshi/docs': ^0.27.5
    '@praha/byethrow-docs': ^0.9.0
```

- **ドメイン知識型 CLAUDE.md**: 外部データソースを扱うパッケージ（codex, amp, opencode）では、データ形式・トークンフィールド・コスト計算ロジックなどのドメイン固有知識を CLAUDE.md に詳述し、AI がデータパーサーやコスト計算の実装時に参照できる「ドメイン辞書」として機能させる。

```markdown
## Token Fields

- `input_tokens`: total input tokens sent to the model.
- `cached_input_tokens`: cached portion of the input.
- `output_tokens`: normal output tokens.
```

- **Post-Change Workflow の明示**: コード変更後に実行すべきコマンド（format, typecheck, test）を「ALWAYS run these commands in parallel」と明記し、並列実行可能であることも伝える。AI エージェントの変更後検証を標準化する。

```markdown
After making any code changes, ALWAYS run these commands in parallel:

- `pnpm run format`
- `pnpm typecheck`
- `pnpm run test`
```

## Anti-Patterns / 注意点

- **ガードレールの全パッケージ重複**: 「NEVER use `await import()` dynamic imports」が ルート CLAUDE.md、apps/ccusage、apps/amp、apps/mcp、apps/pi、packages/terminal の 6 ファイルに記載されている。重要なルールの強調として意図的ではあるが、文言の微妙な差異が生まれやすく、修正時に全ファイルの更新が必要となる保守コストがある。

```markdown
// Bad: 6 ファイルに同一ルールを重複記載
// CLAUDE.md:279

- **IMPORTANT**: DO NOT use `await import()` dynamic imports anywhere
  // apps/ccusage/CLAUDE.md:71
- **CRITICAL**: NEVER use `await import()` dynamic imports anywhere, especially in test blocks
  // apps/amp/CLAUDE.md:56
- **CRITICAL**: NEVER use `await import()` dynamic imports anywhere, especially in test blocks.

// Better: ルートに集約し、子では「ルートの規約に従う」と参照する
// ただし、特に深刻な問題に限り子でも繰り返すことは合理的な強調手段
```

- **Code Style 規約のフォワード参照不足**: 複数のパッケージ CLAUDE.md が「Follow the same code style guidelines as the main ccusage package」と記載するが、具体的にどの CLAUDE.md のどのセクションかを明示していない。AI エージェントが正確に参照先を特定できない可能性がある。

```markdown
// Bad: 参照先が曖昧

## Code Style

Follow the same code style guidelines as the main ccusage package:

// Better: 明示的にパスを指定

## Code Style

Follow the code style guidelines defined in the root `CLAUDE.md` (## Code Style Notes section):
```

## 導出ルール

- `[MUST]` monorepo では ルート CLAUDE.md に横断的ルール（コードスタイル・Git 規約・テスト方針）を集約し、各パッケージの CLAUDE.md にはそのパッケージ固有のアーキテクチャ・データフロー・ドメイン知識のみを記述する
  - 根拠: ccusage は 10 個の CLAUDE.md でこの分離を実践し、ルート 310 行に全体方針を集約しつつ各パッケージは 40-120 行の固有情報に限定している
- `[MUST]` AI エージェントが過去に繰り返したミスは `CRITICAL`/`NEVER`/`ALWAYS` のマーカー付きで CLAUDE.md に明示的に禁止事項として記載する
  - 根拠: ccusage では動的 import 禁止・console.log 禁止・不要ファイル生成禁止をマーカー付きで記載し、ガードレールとして機能させている
- `[MUST]` 複数の AI エージェント（Claude Code, Codex 等）を併用する場合、`AGENTS.md -> CLAUDE.md` のシンボリックリンクで単一ソースを共有し、コンテキストの重複管理を避ける
  - 根拠: ccusage では 4 つの apps パッケージで AGENTS.md シンボリックリンクを採用し、マルチエージェント対応を単一ファイルで実現している
- `[SHOULD]` AI が頻繁に参照するライブラリのドキュメントは npm パッケージ化し、pnpm catalog 等で専用カテゴリ（例: `llm-docs`）として管理する。skills からは `node_modules` 内のドキュメントを参照させる
  - 根拠: ccusage は `@gunshi/docs`・`@praha/byethrow-docs` を `catalog:llm-docs` で管理し、skills がバージョン管理されたドキュメントを参照する仕組みを構築している
- `[SHOULD]` CLAUDE.md の末尾に AI エージェント専用の「Tips」セクションを設け、利用可能な MCP サーバー・skills・特に重要な禁止事項を箇条書きで簡潔にまとめる
  - 根拠: ccusage のルート CLAUDE.md は末尾に「Tips for Claude Code」と「important-instruction-reminders」を配置し、AI が最後に読むコンテキストとして行動指針を強化している
- `[SHOULD]` コード変更後に実行すべき検証コマンド（lint, typecheck, test）を CLAUDE.md に明記し、並列実行可能かどうかも指定する
  - 根拠: ccusage は「ALWAYS run these commands in parallel」と記載し、AI エージェントの変更後ワークフローを標準化している
- `[SHOULD]` プロジェクトレベルの `.mcp.json` で外部ツール（リンター、ドキュメント検索、コード検索）を MCP サーバーとして宣言し、AI エージェントのツールチェーンを拡張する
  - 根拠: ccusage は Context7 MCP と grep MCP を `.mcp.json` で統合し、AI が外部リソースにアクセスできる環境を構築している
- `[AVOID]` 同一のガードレールルールを全パッケージの CLAUDE.md に重複記載すること。ルートに集約し、子パッケージでは本当に重要なもののみ繰り返す
  - 根拠: ccusage では動的 import 禁止ルールが 6 ファイルに分散しており、文言の微差が生じている。保守コストとの トレードオフを意識すべきである

## 適用チェックリスト

- [ ] monorepo であれば、ルート CLAUDE.md に横断的ルールを集約し、各パッケージには固有情報のみ記述する二層構造を設計する
- [ ] AI が過去に犯したミスをリストアップし、`CRITICAL`/`NEVER`/`ALWAYS` マーカー付きで CLAUDE.md に禁止事項として追加する
- [ ] Claude Code 以外の AI エージェント（Codex 等）も使用する場合、`AGENTS.md -> CLAUDE.md` シンボリックリンクを作成する
- [ ] AI が頻繁に参照するライブラリドキュメントが npm パッケージとして提供されているか確認し、あれば pnpm catalog の専用カテゴリで管理する
- [ ] CLAUDE.md の末尾に「Tips for AI」セクションを追加し、利用可能な MCP・skills・主要な禁止事項を箇条書きでまとめる
- [ ] コード変更後の検証ワークフロー（format, typecheck, test）を CLAUDE.md に明記する
- [ ] `.mcp.json` でプロジェクトに有用な外部 MCP サーバー（Context7, grep.app 等）を宣言する
- [ ] skills ディレクトリに、プロジェクトで使用する主要ライブラリの使い方ガイドを配置する（ドキュメントパッケージがあれば node_modules 参照、なければインライン記述）
- [ ] custom commands で、AI の分析能力を活用した品質維持タスク（重複検出、依存関係分析等）を定義する
- [ ] ガードレールルールの重複箇所を点検し、ルートへの集約が可能な箇所を特定する
