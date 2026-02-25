# AI エージェント向けコンテキスト設計

> リポジトリ: vercel/chat
> 分析日: 2026-02-25

## 概要

vercel/chat は CLAUDE.md、skills/chat/SKILL.md、.cursor/plans/ の3種類の AI エージェント向けコンテキストファイルを使い分けている。注目すべき点は、CLAUDE.md が「リポジトリの貢献者（内部開発者）」向けに設計されているのに対し、SKILL.md は「SDK の利用者（外部開発者）」向けに設計されている点である。さらに、npm パッケージのビルドプロセスにドキュメントを組み込み、`npx skills add` 経由でエージェントに SDK の使い方を教える仕組みを確立している。AI ツール横断（Claude Code、Cursor）でのコンテキスト設計戦略が体系的に整備されたリポジトリである。

## 背景にある原則

- **対象読者によるコンテキスト分離**: AI エージェントに渡す情報は、読者（エージェントの利用シーン）によって分離すべき。貢献者向けにはアーキテクチャ・ビルドコマンド・テスト方法を、利用者向けには API の使い方・クイックスタートを提供する。同じ情報を混在させるとコンテキストの S/N 比が下がる。根拠: CLAUDE.md はモノレポの内部構造（パッケージ間依存、テストユーティリティ、Recording & Replay ワークフロー）を詳述する一方、SKILL.md は Chat クラスの使い方やイベントハンドラの一覧に集中している（`skills/chat/SKILL.md:1-148`）。

- **ドキュメントをパッケージの成果物として配布する**: AI エージェントが参照すべきドキュメントは、npm パッケージに同梱して `node_modules/` から読ませるべき。ドキュメントサイトの URL を渡すだけでは、エージェントがリアルタイムにフェッチできない場合がある。根拠: `packages/chat/package.json` の `files` フィールドに `"docs"` が含まれ、ビルドスクリプトで `cp -r ../../apps/docs/content/docs ./docs` により MDX ドキュメントをパッケージに同梱している（`packages/chat/package.json:23-28`）。

- **検証ゲートを AI に明示的に伝える**: AI エージェントがタスク完了を判断する前に実行すべきコマンドを、強調表現で明示的に指示すべき。根拠: CLAUDE.md で `# Run full validation. ALWAYS do this before declaring a task to be done.` と大文字で強調し、`pnpm validate` をゲートとして指定している（`CLAUDE.md:26-27`）。

- **計画ファイルでタスクの構造を AI に事前共有する**: 複雑な機能追加では、変更対象ファイル・手順・完了条件を構造化した計画ファイルを AI に渡すことで、実装の方向性ブレを防ぐ。根拠: `.cursor/plans/` 配下の plan ファイルは YAML フロントマターで `todos` リストと `status` を管理し、変更対象ファイルごとの具体的な実装指示を含んでいる（`.cursor/plans/ephemeral_messages_6f0d6906.plan.md:1-36`）。

## 実例と分析

### CLAUDE.md: 貢献者向けコンテキストの階層設計

CLAUDE.md は339行にわたり、以下の階層で情報を構成している。

1. **Build Commands**: 最も頻繁に必要になるコマンドを最上位に配置
2. **Code Style**: 短い行動規範（`pnpm add` を使え、等）
3. **Architecture**: パッケージ構成、コアコンセプト、メッセージフロー
4. **Testing**: モックユーティリティの使い方、Recording & Replay の詳細手順
5. **Changesets**: リリースフロー
6. **Ultracite Code Standards**: Biome ベースのコーディング規約（100行超）

特筆すべきは、テストユーティリティを CLAUDE.md 内に直接コード例として記載している点である。

```typescript
// CLAUDE.md:118-123
import { createMockAdapter, createMockState, createTestMessage } from "./mock-adapter";

const adapter = createMockAdapter("slack");
const state = createMockState();
const message = createTestMessage("msg-1", "Hello world");
```

これにより、AI エージェントがテストコードを書く際に mock-adapter.ts を読みに行く手間を省いている。

### SKILL.md: 利用者向けコンテキストのフロントマター設計

SKILL.md は YAML フロントマターで `name` と `description` を定義し、AI エージェントがいつこのスキルを参照すべきかをトリガー条件として記述している。

```yaml
# skills/chat/SKILL.md:1-11
---
name: chat-sdk
description: >
  Build multi-platform chat bots with Chat SDK (`chat` npm package). Use when developers want to
  (1) Build a Slack, Teams, Google Chat, Discord, GitHub, or Linear bot,
  (2) Use the Chat SDK to handle mentions, messages, reactions, slash commands, cards, modals, or streaming,
  (3) Set up webhook handlers for chat platforms,
  (4) Send interactive cards or stream AI responses to chat platforms.
  Triggers on "chat sdk", "chat bot", "slack bot", "teams bot", "discord bot", "@chat-adapter",
  building bots that work across multiple chat platforms.
---
```

`description` の中に「Triggers on ...」としてキーワードマッチング条件を埋め込んでいる。これは AI エージェントのルーティング（どのスキルを呼ぶか）を意図的に制御するプラクティスである。

さらに SKILL.md の冒頭に「Critical: Read the bundled docs」と明記し、`node_modules/chat/docs/` と `node_modules/chat/dist/` を読むよう指示している。

```markdown
# skills/chat/SKILL.md:17-36

## Critical: Read the bundled docs

The `chat` package ships with full documentation in `node_modules/chat/docs/` and TypeScript source types. **Always read these before writing code:**

node_modules/chat/docs/ # Full documentation (MDX files)
node_modules/chat/dist/ # Built types (.d.ts files)
```

### .cursor/plans: タスク実行計画の構造化

`.cursor/plans/` の plan ファイルは Cursor エージェント向けに設計されている。YAML フロントマターで `name`、`overview`、`todos` リスト（各 `id`、`content`、`status`）、`isProject` フラグを持つ。

```yaml
# .cursor/plans/ephemeral_messages_6f0d6906.plan.md:1-12
---
name: Ephemeral Messages
overview: Add ephemeral message support via thread.postEphemeral(userId, message)...
todos:
  - id: core-types
    content: Add EphemeralMessage type and postEphemeral to Adapter/Thread interfaces
    status: completed
  - id: thread-impl
    content: Implement postEphemeral() in ThreadImpl with DM fallback logic
    status: completed
```

plan ファイルの本文では、以下の要素が構造的に記述されている。

1. **Rationale**: なぜこの設計を選んだか
2. **New Types**: 追加する型定義（コード付き）
3. **Implementation by Package**: パッケージごとの実装指示
4. **Platform Behavior Summary**: プラットフォームごとの挙動表
5. **Files to Modify**: 変更対象の全ファイルリスト
6. **Code Style Notes**: 守るべきコードスタイル

### docs の npm 同梱メカニズム

ドキュメントの配布パイプラインは以下の流れで構築されている。

1. `apps/docs/content/docs/` に MDX ファイルとしてドキュメントを管理（VitePress/Fumadocs で Web サイトにも利用）
2. `packages/chat/package.json` の build スクリプトで `cp -r ../../apps/docs/content/docs ./docs` を実行
3. `"files": ["dist", "docs"]` により npm パッケージに docs ディレクトリを同梱
4. `.gitignore` で `packages/chat/docs` を除外（ビルド生成物のため）

```json
// packages/chat/package.json:27-28
"build": "pnpm clean && tsup && cp -r ../../apps/docs/content/docs ./docs",
```

これにより、`npx skills add vercel/chat` で取得したスキルが `node_modules/chat/docs/` を参照でき、AI エージェントがオフラインでもドキュメントにアクセスできる。

### CLAUDE.md 内のコーディング規約埋め込み

CLAUDE.md の後半に「Ultracite Code Standards」として100行超のコーディングガイドラインが直接埋め込まれている。これは外部ファイル参照ではなく、CLAUDE.md 単体で完結するよう設計されている。

```markdown
# CLAUDE.md:216-218

# Ultracite Code Standards

This project uses **Ultracite**, a zero-config preset that enforces strict code quality standards...
```

カテゴリは Type Safety、Modern JS/TS、Async & Promises、React & JSX、Error Handling、Code Organization、Security、Performance、Framework-Specific Guidance に分類されている。

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: AI エージェントのコンテキスト注入をツール（Claude Code、Cursor）ごとに差し替える必要がある
  - 適用条件: 複数の AI ツールを開発ワークフローに組み込む場合
  - コード例: CLAUDE.md（Claude Code 向け）、`.cursor/plans/`（Cursor 向け）、`skills/chat/SKILL.md`（スキルシステム向け）がそれぞれ異なるフォーマットで同等の情報を提供
  - 注意点: 情報の重複管理コストが発生する。DRY を優先するなら、ドキュメントソースを一元化し、各フォーマットにトランスパイルする仕組みが望ましい

## Good Patterns

- **コマンドファースト配置**: CLAUDE.md の最上位にビルドコマンドを配置し、AI エージェントが最初に必要とする情報へのアクセスを最速にしている。AI エージェントはコードを読む前にまずビルド・テスト・検証コマンドを知る必要があるため、この配置は合理的である。

````markdown
# CLAUDE.md:5-45

## Build Commands

```bash
# Install dependencies
pnpm install

# Build all packages (uses Turborepo)
pnpm build
...
```
````

````
- **検証コマンドの強調注入**: `ALWAYS do this before declaring a task to be done` という指示文により、AI エージェントの「完了判断」に検証ステップを組み込んでいる。これは AI エージェントが早まってタスク完了を宣言することを防ぐガードレールとして機能する。

```markdown
# CLAUDE.md:26-27
# Run full validation. ALWAYS do this before declaring a task to be done.
pnpm validate
````

- **トリガーキーワードの明示**: SKILL.md の description に `Triggers on "chat sdk", "chat bot", "slack bot"` とキーワードを列挙することで、AI エージェントのスキルルーティング精度を高めている。

```yaml
# skills/chat/SKILL.md:9-10
  Triggers on "chat sdk", "chat bot", "slack bot", "teams bot", "discord bot", "@chat-adapter",
  building bots that work across multiple chat platforms.
```

- **plan ファイルの TODO 進捗管理**: `.cursor/plans/` の YAML フロントマターで `status: completed` を管理し、AI エージェントが未完了タスクを識別できるようにしている。

```yaml
# .cursor/plans/add_url_prop_to_button_41f497bd.plan.md:6-8
  - id: core-types
    content: Add LinkButtonElement interface and LinkButton() function
    status: completed
```

## Anti-Patterns / 注意点

- **コンテキストの肥大化**: CLAUDE.md に Ultracite Code Standards（100行超）を直接埋め込んでいるため、ファイル全体が339行に達している。AI エージェントのコンテキストウィンドウを圧迫するリスクがある。コーディング規約は Biome の設定ファイルとして自動適用できる部分が多く、AI に「ルールを覚えさせる」より「ツールに強制させる」方が信頼性が高い。

```markdown
# Bad: 100行超のコーディング規約を CLAUDE.md に埋め込む

## Core Principles

Write code that is **accessible, performant, type-safe, and maintainable**...

### Type Safety & Explicitness

- Use explicit types for function parameters...

### Modern JavaScript/TypeScript

- Use arrow functions for callbacks...
  (以下100行以上続く)

# Better: ツールで自動適用し、AI には例外と判断基準だけ伝える

## Code Style

This project uses Ultracite (Biome) for automated formatting and linting.
Run `pnpm check` to verify, `pnpm fix` to auto-fix.
Focus on: business logic correctness, meaningful naming, architecture decisions.
```

- **ドキュメントソースの二重管理**: CLAUDE.md の Architecture セクションと SKILL.md の Core concepts セクションは、ほぼ同じ情報（Chat、Adapter、State、Thread、Message の説明）を異なる粒度で記述している。ソースが分散すると更新漏れが発生しやすい。

```markdown
# CLAUDE.md:67-77 (貢献者向け)

### Core Concepts

1. **Chat** - Main entry point that coordinates adapters and handlers
2. **Adapter** - Platform-specific implementations...

# skills/chat/SKILL.md:66-74 (利用者向け)

## Core concepts

- **Chat** — main entry point, coordinates adapters and routes events
- **Adapters** — platform-specific (Slack, Teams, GChat, Discord, GitHub, Linear)
```

## 導出ルール

- `[MUST]` AI エージェント向けコンテキストファイルは対象読者（貢献者/利用者）ごとに分離し、混在させない
  - 根拠: vercel/chat は CLAUDE.md（貢献者向け: ビルド・テスト・アーキテクチャ）と SKILL.md（利用者向け: API 使用方法）を明確に分離し、各ファイルの S/N 比を維持している

- `[MUST]` AI エージェントに完了判断させるタスクには、検証コマンドを強調表現（ALWAYS/NEVER 等）で明示的に指示する
  - 根拠: CLAUDE.md で `ALWAYS do this before declaring a task to be done` と `pnpm validate` を紐付け、AI の早期完了宣言を防いでいる（`CLAUDE.md:26-27`）

- `[SHOULD]` npm パッケージにドキュメントを同梱し、AI エージェントが `node_modules/` からオフラインで参照できるようにする
  - 根拠: `packages/chat/package.json` の build スクリプトで MDX ドキュメントをコピーし、`"files": ["dist", "docs"]` で配布している

- `[SHOULD]` AI 向けスキルファイルの description にトリガーキーワードを明示し、エージェントのスキルルーティング精度を高める
  - 根拠: SKILL.md の description に `Triggers on "chat sdk", "chat bot", "slack bot"...` とキーワードを列挙している（`skills/chat/SKILL.md:9-10`）

- `[SHOULD]` 複雑な機能追加は、変更対象ファイル・手順・完了条件を構造化した計画ファイルとして AI に事前共有する
  - 根拠: `.cursor/plans/` の plan ファイルは YAML フロントマターで TODO リストと status を管理し、プラットフォームごとの実装指示を構造化している

- `[SHOULD]` CLAUDE.md ではビルド・テスト・検証コマンドを最上位セクションに配置し、AI エージェントが最初に必要とする情報へのアクセスを最速にする
  - 根拠: CLAUDE.md の最上位が `## Build Commands` であり、`pnpm install` から `pnpm validate` までの全コマンドが冒頭に集約されている（`CLAUDE.md:5-45`）

- `[SHOULD]` テストユーティリティ（モックファクトリ等）の使い方は CLAUDE.md 内にコード例付きで記載し、AI エージェントがソースを読みに行く手間を省く
  - 根拠: CLAUDE.md に `createMockAdapter`、`createMockState`、`createTestMessage` の使用例が直接記載されている（`CLAUDE.md:108-123`）

- `[AVOID]` ツールで自動適用可能なコーディング規約（フォーマット、リントルール等）を AI コンテキストファイルに大量に埋め込むこと
  - 根拠: CLAUDE.md の Ultracite Code Standards セクション（100行超）は Biome が自動検出・修正できる内容が多く、AI のコンテキストウィンドウを圧迫している

- `[AVOID]` 同一の概念説明を複数の AI コンテキストファイルに異なる粒度で重複記述すること
  - 根拠: CLAUDE.md と SKILL.md の両方に Core Concepts（Chat、Adapter、Thread 等）の説明があり、更新漏れのリスクを生んでいる

## 適用チェックリスト

- [ ] CLAUDE.md（貢献者向け）とスキルファイル（利用者向け）を分離して設計しているか
- [ ] CLAUDE.md の最上位セクションにビルド・テスト・検証コマンドを配置しているか
- [ ] タスク完了前に実行すべき検証コマンドを ALWAYS/NEVER 等の強調表現で明示しているか
- [ ] npm パッケージのビルドプロセスにドキュメントの同梱ステップを含めているか
- [ ] AI 向けスキルファイルの description にトリガーキーワードを列挙しているか
- [ ] 複雑なタスクの実行計画を構造化された plan ファイルとして用意しているか
- [ ] AI コンテキストファイルにツールで自動適用可能なルールを不必要に埋め込んでいないか
- [ ] テストユーティリティの使い方をコンテキストファイル内にコード例付きで記載しているか
- [ ] 複数のコンテキストファイル間で情報の重複がないか確認しているか
