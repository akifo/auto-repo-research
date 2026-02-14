# AI Settings

> リポジトリ: mastra-ai/mastra
> 分析日: 2026-02-14

## 概要

mastra は Claude Code / Cursor の AI 設定を本格的に活用しているモノレポである。CLAUDE.md によるスコープ制御、`.claude/commands/` と `.cursor/commands/` による並行カスタムコマンド、`.claude/skills/` による再利用可能な知識モジュール、そして自社製 MCP ドキュメントサーバー（`@mastra/mcp-docs-server`）を組み合わせて、AI アシスタントが「正しいコードを書ける」環境を構築している。特に、MCP サーバーでドキュメントをツールとして提供し、AI が自分自身のフレームワークのドキュメントを参照しながらコードを書ける仕組みは、OSS フレームワーク開発における先進的なパターンである。

## 背景にある原則

- **スコープ境界の明示**: AI は指示がなければ全ファイルを探索するため、ノイズが多い大規模モノレポでは「見てはいけない領域」を明示する必要がある。mastra は CLAUDE.md の冒頭で `examples/` フォルダを明示的に除外し（`CLAUDE.md:7`）、パッケージごとの CLAUDE.md でさらに責務範囲を絞っている。これにより、AI のコンテキスト消費を抑え、的外れな提案を防止する。

- **コマンドの再利用性と AI ツール間の対称性**: 同一ワークフロー（changeset 作成、PR 作成、issue デバッグ等）を Claude Code と Cursor の両方で使えるよう、`.claude/commands/` と `.cursor/commands/` に同名のコマンドを並行配置している。コマンドを「人間向けドキュメント」ではなく「AI が実行するランブック」として設計することで、ツール切り替え時の学習コストをゼロにしている。

- **ドキュメントを AI のツールに昇格させる**: 従来のドキュメントは人間が読むものだが、mastra は MCP サーバー経由でドキュメントを AI が呼び出せるツールとして提供している。これにより、AI はコード生成時にフレームワークの最新 API を参照でき、hallucination を低減する。ドキュメントが「あれば便利」ではなく「AI の動作に必要なインフラ」になる。

- **スキルによる知識のモジュール化**: `.claude/skills/` に `react-best-practices`、`tailwind-best-practices`、`e2e-tests-studio` 等のスキルを配置し、特定のコンテキストでのみ読み込まれるルール集を構成している。これは CLAUDE.md に全ルールを詰め込むとコンテキストが溢れる問題への解答であり、「必要な知識を必要な時だけロードする」遅延評価の発想に基づく。

## 実例と分析

### 階層的な CLAUDE.md によるモノレポのスコープ制御

mastra はルートの CLAUDE.md に加え、パッケージ単位で CLAUDE.md を配置している。各レベルで役割が異なる。

ルート CLAUDE.md はモノレポ全体のビルドコマンド、アーキテクチャ概要、開発ガイドラインを記述し、冒頭でスコープ制限を宣言する。

パッケージレベルの CLAUDE.md は「このパッケージで何をしてよいか・してはならないか」を記述する。`packages/playground/CLAUDE.md` は特に厳格で、「このパッケージではコンポーネントを作るな」という禁止ルールを定義し、`packages/playground-ui/CLAUDE.md` にはスキル呼び出しの強制ルールがある。

### Claude / Cursor 並行カスタムコマンド

`.claude/commands/` と `.cursor/commands/` に同一名称のコマンドファイルが存在する。`changeset.md`、`commit.md`、`document.md`、`gh-debug-issue.md`、`gh-fix-ci.md`、`gh-fix-lint.md`、`gh-new-pr.md`、`gh-pr-comments.md`、`make-moves.md`、`pr.md` が両方のディレクトリに置かれている。

特筆すべきは `gh-debug-issue.md` で、GitHub Issue の取得だけでなく Discord スレッドの自動取得まで含む複合ワークフローになっている。また `gh-pr-comments.md` では、CodeRabbit（自動レビューボット）のコメントへの対応プロトコルが定義されており、AI がレビューボットと対話する仕組みが確立されている。

### MCP ドキュメントサーバーの二重ソース設計

`packages/mcp-docs-server` は2種類のドキュメントソースを提供する。

1. **ローカルパッケージドキュメント**: `node_modules` 内の `dist/docs/` に埋め込まれたドキュメントを読み、インストール済みバージョンと一致する API 情報を提供する（`embedded-docs.ts`）
2. **リモートドキュメント**: ビルド済みの `.docs/` ディレクトリから最新の公式ドキュメントを提供する（`docs.ts`）

この二重ソース設計により、「開発時はローカル版を参照し、学習時はリモート版を参照する」使い分けが可能になる。開発者向けとエンドユーザー向けの両方で `.cursor/mcp.json` が配置されている。リポジトリルートではローカルの tsx を直接実行し、テンプレートプロジェクトでは npm パッケージ経由で利用する。

### Skills によるコンテキストの遅延ロード

`.claude/skills/` に配置されたスキルは、YAML フロントマターで起動条件を定義し、本文にドメイン固有のルールと参照資料を持つ。

`react-best-practices` スキルは 12 ルールを 6 カテゴリに分類し、優先度テーブルで「何から適用すべきか」を明示している。`e2e-tests-studio` スキルは「UI 状態ではなく製品の振る舞いをテストせよ」という原則を詳細なパターン集（6 パターン）とともに提供する。テストの What NOT / What TO を対比形式で示しており、AI の判断基準が明確になっている。

### Cursor ルールによるドキュメント執筆スタイルの標準化

`.cursor/rules/writing-documentation.mdc` では、マーケティング用語の禁止リストを具体例付きで定義している。これは「AI が自然に生成しがちな表現」を明示的に禁止するアプローチであり、AI 特有の弱点に対する防衛的な設定である。

### AGENTS.md による特化型ガイド

`packages/codemod/AGENTS.md` は Codex 向けの包括的なコードモッド作成ガイドで、800 行超の詳細なパターンカタログと意思決定ツリーを含む。「何をどのユーティリティで変換するか」の Quick Decision Tree が実装のアンカーになっている。

## コード例

```
// CLAUDE.md:6-7
**IMPORTANT**: Unless explicitly mentioned in the user's prompt, do NOT check,
search, read, or reference files in the `examples/` folder.
```

```
// packages/playground/CLAUDE.md:39
- **FORBIDDEN**: Creating new UI components, layouts, or data-fetching logic
```

```
// packages/playground-ui/CLAUDE.md:7-9
On every change to this package, you MUST ALWAYS follow these instructions:
- use `e2e-frontend-validation` skill
- use `react-best-practices` skill
- use `tailwind-best-practices` skill
```

```
// .cursor/commands/gh-debug-issue.md:9
RUN curl -s -X GET -H "Authorization: Bot $MASTRA_DISCORD_BOT_TOKEN"
"https://discord.com/api/v10/channels/<THREAD_ID>/messages?limit=100"
> /tmp/discord_out.json && jq '[.[] | ...]' /tmp/discord_out.json
```

```
// .cursor/commands/gh-pr-comments.md:9-10
For any comments from coderabbit: if they make sense implement them,
if they don't... tag "@coderabbitai" in your response
```

```typescript
// packages/mcp-docs-server/src/tools/embedded-docs.ts:156-199
export const getMastraHelpTool = {
  name: "getMastraHelp",
  description: `...
    ## LOCAL PACKAGE DOCS (Recommended for Development)
    SOURCE: Your installed @mastra packages in node_modules
    VERSION: Matches your installed code exactly
    ...
    ## REMOTE WEBSITE DOCS (For Latest Info & Learning)
    SOURCE: mastra.ai website
    VERSION: Latest published documentation`,
};
```

```json
// .cursor/mcp.json (開発者向け)
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
// templates/template-deep-research/.cursor/mcp.json (ユーザー向け)
{
  "mcpServers": {
    "mastra": {
      "command": "npx",
      "args": ["-y", "@mastra/mcp-docs-server"]
    }
  }
}
```

```typescript
// packages/mcp-docs-server/src/tools/migration.ts:284-314
export const migrationTool = {
  description: `...
**Step 1: List top-level migrations**
- Call with no parameters: \`{}\`
**Step 2: Navigate into a directory**
- Add trailing slash to explore: \`{ path: "upgrade-to-v1/" }\`
**Step 3: View a migration guide**
- Without trailing slash: \`{ path: "upgrade-to-v1/agent" }\``,
};
```

```yaml
# .claude/skills/e2e-tests-studio/SKILL.md:1-9
---
name: e2e-tests-studio
description: >
  REQUIRED when modifying any file in packages/playground-ui or packages/playground.
model: claude-opus-4-5
---
```

```
// .cursor/rules/writing-documentation.mdc:1-5
1. do not use adjectives like "powerful" or "built-in"
2. do not use "complete" or "out-of-the-box"
3. do not use "production-ready", "makes it easy"
```

```json
// docs/.claude/settings.json
{
  "permissions": {
    "allow": [
      "Read(./**)",
      "Edit(./**)",
      "Write(./**)",
      "Bash(npx prettier:*)",
      "Bash(pnpm run docusaurus build:*)",
      "Bash(rm ./src/content/**)"
    ]
  }
}
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: AI ツールごとに異なる設定形式（CLAUDE.md / .cursor/rules / AGENTS.md）に同じ知識を適用する必要がある
  - 適用条件: 複数の AI ツールを併用するチーム
  - コード例: `.claude/commands/changeset.md` と `.cursor/commands/changeset.md` の並行配置
  - 注意点: 内容の同期が手動のため乖離するリスクがある

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: Issue 対応の各ステージを固定順序で実行させつつ、各ステージの内容は柔軟に
  - 適用条件: AI に複数ステップの作業を順序立てて実行させたい場合
  - コード例: `.claude/commands/gh-debug-issue.md` の Stage 1 Analyze -> Stage 2 Reproduce -> Stage 3 Fix
  - 注意点: ステージ間のゲート（ユーザー確認）を省略すると AI が先走る

- **Composite パターン** (分類: 構造)
  - 解決する問題: モノレポでルートとパッケージの AI 設定を階層的に構成する
  - 適用条件: パッケージごとに異なるコーディング規約がある大規模モノレポ
  - コード例: `CLAUDE.md`（ルート）+ `packages/playground/CLAUDE.md`（パッケージ）+ `.claude/skills/`（トピック）
  - 注意点: 階層が深すぎると AI のコンテキスト消費が増大する

## Good Patterns

- **コマンドを AI ランブックとして設計する**: `gh-debug-issue.md` は Issue 分析 -> 再現テスト作成 -> 修正の 3 ステージを定義し、各ステージの完了条件を明示している。AI が「何をどの順番でやるか」だけでなく「次のステージに進んでよい条件」まで理解できる。

```
// .claude/commands/gh-debug-issue.md:14-31
## Stage 2 "Reproduce"
4. Now that the user agrees with your findings, write a test...
   The test MUST fail and clearly show the problem.
5. If the test is not running properly or is failing for unrelated reasons,
   your task is not finished.
6. Explain your failing test to the user. They must understand fully.
```

- **スキルにモデル指定を含める**: `e2e-tests-studio` と `ralph-plan` のスキルは YAML フロントマターで `model: claude-opus-4-5` を指定している。タスクの複雑さに応じて適切なモデルを選択する仕組みにより、コストと品質のバランスを制御できる。

- **MCP ツールの description に使い方の完全なワークフローを埋め込む**: `migrationTool` の description はツールの操作手順をステップバイステップで記述し、AI がツールを「正しく」呼び出せるよう誘導している。

- **パッケージ内 CLAUDE.md で「禁止事項」を明示する**: `packages/playground/CLAUDE.md` は「このパッケージの責務外の行為」を FORBIDDEN として明示している。AI は明示的に禁止されないと「善意で」やってしまうため、「何をしてはいけないか」の宣言が重要になる。

- **権限設定による安全性の確保**: `docs/.claude/settings.json` で許可するコマンドをホワイトリスト化し、AI が意図しない操作を行うことを構造的に防いでいる。

## Anti-Patterns / 注意点

- **コマンドの重複管理**: `.claude/commands/` と `.cursor/commands/` に同一内容のファイルが存在し、手動同期に依存している。片方を更新して他方を忘れるリスクがある。

```
# Bad: 同一内容を2箇所で管理
.claude/commands/changeset.md   # 内容A
.cursor/commands/changeset.md   # 内容A（手動コピー）
```

```
# Better: 共有ファイルからのシンボリックリンクまたは生成スクリプト
shared/commands/changeset.md    # Single Source of Truth
.claude/commands/ -> symlink or generated
.cursor/commands/ -> symlink or generated
```

- **CLAUDE.md のスコープ宣言が暗黙的**: `examples/` の除外は「ユーザーが言及しない限り」という条件付きであり、AI が「ユーザーの意図を誤解して examples/ を参照する」ケースを完全には防げない。

```
# Bad: 条件付き除外（曖昧さが残る）
Unless explicitly mentioned in the user's prompt, do NOT check...

# Better: 無条件除外 + 必要時の明示的解除
DO NOT read files in examples/ directory.
If needed, user will explicitly say "include examples".
```

## 導出ルール

- `[MUST]` 階層的な AI 設定ファイル（CLAUDE.md / .cursor/rules 等）を使い、モノレポのパッケージごとにスコープと責務を明示する。ルートにモノレポ全体のアーキテクチャとビルドコマンドを、パッケージレベルにローカルルールと禁止事項を記載する
  - 根拠: mastra は `packages/playground/CLAUDE.md` で FORBIDDEN を宣言し、AI がパッケージの責務外のコードを生成することを防いでいる

- `[MUST]` AI カスタムコマンドで複数ステップのワークフローを定義する場合、ステージ制にし、各ステージに完了条件とユーザー確認ゲートを含める。AI が自律的に進行しすぎること・途中で止まることの両方を防ぐ
  - 根拠: `gh-debug-issue.md` は Analyze -> Reproduce -> Fix の 3 ステージを定義し、ステージ 2 では「テストが失敗することを確認してからステージ 3 に進む」条件を課している

- `[SHOULD]` 自社フレームワーク・ライブラリのドキュメントは MCP サーバー経由で AI ツールに提供し、ローカルインストール版（version-matched）とリモート最新版の二重ソースを用意する
  - 根拠: `@mastra/mcp-docs-server` は `embedded-docs.ts` でローカルの `node_modules` から version-matched なドキュメントを、`docs.ts` で最新ドキュメントを別々に提供している

- `[SHOULD]` AI が自然に生成しがちだが望ましくない表現・パターンを、禁止リストとして AI 設定に明記する（ドキュメント執筆スタイル、マーケティング用語、特定のコーディングパターン等）
  - 根拠: `.cursor/rules/writing-documentation.mdc` で "powerful", "production-ready", "makes it easy" 等を禁止語として列挙し、AI のデフォルト傾向を矯正している

- `[SHOULD]` AI のスキル・知識モジュールは遅延ロード方式で構成し、コンテキスト消費を最小化する。全ルールを CLAUDE.md に詰め込むのではなく、トリガー条件付きのスキルファイルに分離する
  - 根拠: `.claude/skills/react-best-practices/SKILL.md` は 12 ルールを優先度付きカテゴリで整理し、参照資料を `references/rules/` に分離している

- `[SHOULD]` MCP ツールの description には操作手順をステップバイステップで埋め込み、AI がツールを正しい順序で呼び出せるよう誘導する
  - 根拠: `migrationTool` の description は Step 1（一覧取得）-> Step 2（ディレクトリ探索）-> Step 3（ガイド閲覧）の操作手順を含み、AI の呼び出しパターンを制御している

- `[AVOID]` 複数の AI ツール間で同一内容のコマンドファイルを手動コピーで管理すること。変更漏れによる不整合が発生する
  - 根拠: `.claude/commands/` と `.cursor/commands/` に同名ファイルが並行管理されており、内容の同期は手動に依存している

## 適用チェックリスト

- [ ] CLAUDE.md をモノレポルートとパッケージレベルの両方に配置し、スコープ制限・ビルドコマンド・禁止事項を記載したか
- [ ] AI に「見せたくないディレクトリ」（examples、fixtures、generated 等）を CLAUDE.md の冒頭で除外宣言したか
- [ ] よく使うワークフロー（PR 作成、issue デバッグ、changeset 作成等）をカスタムコマンドとして定義し、ステージ制・完了条件付きで設計したか
- [ ] 自社ライブラリのドキュメントを MCP サーバーでツール化し、AI がコード生成時に参照できるようにしたか
- [ ] AI が生成しがちな望ましくない表現・パターンの禁止リストを作成し、AI 設定に含めたか
- [ ] ドメイン固有のルール集（コーディング規約、テスト方針、スタイルガイド等）をスキルファイルに分離し、必要な場面でのみロードされるよう設計したか
- [ ] 複数の AI ツール（Claude Code / Cursor）を使う場合、コマンド・ルールの Single Source of Truth を決め、同期の仕組みを構築したか
- [ ] AI 設定ファイルで権限のホワイトリスト（許可するコマンド・ディレクトリ）を定義し、意図しない操作を防いでいるか
