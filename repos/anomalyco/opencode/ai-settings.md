# AI Settings

> リポジトリ: anomalyco/opencode
> 分析日: 2026-03-05

## 概要

opencode は AI コーディングエージェントの設定基盤として `.opencode/` ディレクトリに独自の拡張レイヤーを構築している。AGENTS.md によるプロジェクト全体のスタイル指示、カスタムエージェント・ツール・コマンドの定義、翻訳用グロッサリーまで、AI が扱うコンテキストを構造化して管理する設計パターンが注目に値する。特に、YAML frontmatter による宣言的なメタデータ管理と、ディレクトリ階層による AGENTS.md のスコープ制御が体系的に運用されている。

## 背景にある原則

- **関心ごとの物理的分離**: エージェント定義、ツール実装、コマンドテンプレート、用語集をそれぞれ独立したサブディレクトリに配置し、各カテゴリの追加・変更が他に波及しない構造にすべき。opencode では `.opencode/agent/`, `.opencode/tool/`, `.opencode/command/`, `.opencode/glossary/` を明確に分離している。
- **宣言的メタデータと命令的コンテンツの分離**: 設定値（モデル、権限、表示属性）は frontmatter に、振る舞いの指示はマークダウン本文に分けるべき。これにより、機械的なパースと人間可読なプロンプトが共存できる（`agent/duplicate-pr.md:1-9`, `command/commit.md:1-4`）。
- **最小権限の原則をツールアクセスに適用**: エージェントにはデフォルトで全ツールを無効にし、必要なものだけをホワイトリストで有効化すべき。triage エージェントは `"*": false` で全ツールを遮断し `"github-triage": true` のみ許可している（`agent/triage.md:6-8`）。
- **階層的コンテキスト注入**: AI への指示はディレクトリ階層に沿って配置し、読み込み時に親方向へ自動マージすべき。opencode では root, packages/\*, test/ など複数階層に AGENTS.md を配置して、スコープに応じた知識を注入している。

## 実例と分析

### AGENTS.md の階層配置によるスコープ制御

opencode リポジトリには 7 つの AGENTS.md が異なるディレクトリ階層に配置されている:

- `AGENTS.md`（ルート） — スタイルガイド・命名規則・テスト方針
- `packages/opencode/AGENTS.md` — DB スキーマ・マイグレーション規約
- `packages/opencode/test/AGENTS.md` — テストフィクスチャの使い方
- `packages/app/AGENTS.md` — SolidJS 固有のパターン・ブラウザ自動化
- `packages/app/e2e/AGENTS.md` — E2E テスト構造・セレクタ規約
- `packages/desktop-electron/AGENTS.md` — IPC ハンドラ規約
- `packages/desktop/AGENTS.md` — バインディング規約

各ファイルはそのディレクトリのコードを編集する際にのみロードされるため、エージェントのコンテキストウィンドウを節約しつつ、必要な知識だけを注入する設計になっている。

### エージェント定義の frontmatter パターン

各エージェントは異なる `mode` と `tools` の組み合わせで役割を制限している:

```markdown
<!-- .opencode/agent/duplicate-pr.md:1-9 -->
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

```markdown
<!-- .opencode/agent/translator.md:1-5 -->
---
description: Translate content for a specified locale while preserving technical terms
mode: subagent
model: opencode/gemini-3-pro
---
```

`mode: primary` は直接実行されるエージェント、`mode: subagent` は他のエージェントから呼び出される委譲先を意味する。`hidden: true` は CI/自動化用のエージェントをユーザーの選択肢から隠す。

### カスタムツールの実装-説明分離パターン

`.opencode/tool/` のカスタムツールは、TypeScript 実装ファイル（`.ts`）と説明ファイル（`.txt`）のペアで構成される:

```typescript
// .opencode/tool/github-pr-search.ts:1-4
/// <reference path="../env.d.ts" />
import { tool } from "@opencode-ai/plugin";
import DESCRIPTION from "./github-pr-search.txt";
```

```text
<!-- .opencode/tool/github-pr-search.txt -->
Use this tool to search GitHub pull requests by title and description.
```

`env.d.ts` で `.txt` ファイルの型宣言を提供し、TypeScript の型安全性を保ちながら長い説明文を外部化している。さらに、`opencode.jsonc` でツールのデフォルト有効/無効を制御する:

```jsonc
// .opencode/opencode.jsonc:9-12
"tools": {
  "github-triage": false,
  "github-pr-search": false,
}
```

ツールは定義しつつもデフォルト無効にし、特定のエージェントだけが `tools` frontmatter で明示的に有効化するという二段構えの権限管理を実現している。

### コマンドテンプレートの動的注入

コマンド定義ではシェル実行結果の埋め込み（`!` バッククォート記法）と変数参照（`$ARGUMENTS`）を使い、実行時コンテキストをプロンプトに注入する:

```markdown
<!-- .opencode/command/commit.md:28-35 -->

## GIT DIFF

!`git diff`

## GIT DIFF --cached

!`git diff --cached`
```

```markdown
<!-- .opencode/command/issues.md:8-9 -->

Search through existing issues in anomalyco/opencode using the gh cli to find issues matching this query:

$ARGUMENTS
```

`!`バッククォート`!` はコマンド実行時にシェル出力へ展開され、`$ARGUMENTS` はユーザーの入力引数に置換される（`config/markdown.ts:8`）。また `@package.json` のようなファイル参照構文（`config/markdown.ts:7`）でファイル内容もインライン展開される。

### コマンドのモデル・実行モード制御

コマンドの frontmatter でモデルや実行モードを指定し、タスクの性質に合わせたリソース配分を行っている:

```markdown
<!-- .opencode/command/commit.md:1-4 -->
---
description: git commit and push
model: opencode/kimi-k2.5
subtask: true
---
```

```markdown
<!-- .opencode/command/issues.md:1-3 -->
---
description: "find issue(s) on github"
model: opencode/claude-haiku-4-5
---
```

`subtask: true` は親セッションのコンテキストウィンドウを消費せずバックグラウンドで実行される。コミットや検索のような定型タスクには小型モデルを指定し、コスト効率を最適化している。

### ツール内のバリデーションガード

`github-triage.ts` では、エージェントの判断ミスを実行時に検出するバリデーションロジックをツール内に埋め込んでいる:

```typescript
// .opencode/tool/github-triage.ts:79-81
if (labels.includes("zen") && !zen) {
  throw new Error("Only add the zen label when issue title/body contains 'zen'");
}
```

```typescript
// .opencode/tool/github-triage.ts:83-85
if (web && !nix && !(TEAM.desktop as readonly string[]).includes(assignee)) {
  throw new Error("Web issues must be assigned to adamdotdevin, iamdavidhill, Brendonovich, or nexxeln");
}
```

エージェントのプロンプトに「zen ラベルは zen が含まれる場合のみ」と指示しつつ、ツール実行時にも同じルールを強制する多重防御パターンを採用している。

### 翻訳エージェントのグロッサリー体系

translator エージェントは巨大な「翻訳してはいけない用語リスト」を本文に埋め込み、言語固有の用語は `.opencode/glossary/<locale>.md` に外部化している:

```markdown
<!-- .opencode/glossary/README.md:9-12 -->

- One file per locale
- Use lowercase locale slugs that match docs locales when possible (for example, `zh-cn.md`, `zh-tw.md`)
- If only language-level guidance exists, use the language code (for example, `fr.md`)
```

グロッサリーは 17 言語分が用意され、PR 番号をソースとして追跡している。「コミュニティの PR レビューで合意された用語選択」を AI にフィードバックする仕組みとして機能している。

## Good Patterns

- **ツール権限のホワイトリスト制御**: エージェント定義で `"*": false` を基本にし、必要なツールだけを `true` に設定するパターン。エージェントが意図しないツールを呼び出すリスクを排除する。（`agent/duplicate-pr.md:6-8`, `agent/triage.md:6-8`）

- **実装-説明ペアによるツール定義**: TypeScript の実装と `.txt` の説明文を分離し、`env.d.ts` で型を補完するパターン。LLM へのツール説明を自然言語で記述しつつ型安全性を保つ。（`tool/github-pr-search.ts` + `tool/github-pr-search.txt`）

- **プロンプトとガードコードの二重防御**: エージェントへの自然言語指示とツール内のプログラム的バリデーションを併用するパターン。LLM の判断ミスをハードコードされたルールで捕捉する。（`agent/triage.md` のルール記述 + `tool/github-triage.ts:79-101` のバリデーション）

- **AI スロップ除去コマンド**: AI 生成コードの品質劣化パターン（不要なコメント、過剰な防御コード、`any` キャスト、絵文字）を検出・除去する専用コマンド。AI との協業でコード品質を維持する仕組み。（`command/rmslop.md`）

- **セッション学習の構造化抽出**: `learn` コマンドでセッション中の発見を AGENTS.md に抽出し、次回以降のエージェント実行に活かすフィードバックループ。（`command/learn.md`）

## Anti-Patterns / 注意点

- **モノリシックな翻訳プロンプト**: `translator.md` は 900 行超の単一ファイルに用語リスト全体を含んでおり、更新時に差分が見づらい。コンテキストウィンドウも大量に消費する。

```markdown
<!-- Bad: 900行超の巨大プロンプトファイル -->
<!-- .opencode/agent/translator.md (901 lines) -->
```

```markdown
<!-- Better: 用語リストを外部ファイルに分離し、@参照で読み込む -->
---
description: Translate content
---

Refer to @.opencode/glossary/global.md for do-not-translate terms.
```

- **ハードコードされたリポジトリ情報**: ツール内に `const owner = "anomalyco"`, `const repo = "opencode"` がハードコードされており、フォーク時に修正が必要。環境変数やコンフィグから取得すべき。

```typescript
// Bad: .opencode/tool/github-pr-search.ts:34-35
const owner = "anomalyco";
const repo = "opencode";
```

```typescript
// Better: 環境変数から取得
const owner = process.env.GITHUB_REPOSITORY_OWNER ?? "anomalyco";
const repo = process.env.GITHUB_REPOSITORY ?? "opencode";
```

## 導出ルール

- `[MUST]` AI エージェントにツールアクセスを許可する場合、デフォルトを全無効（`"*": false`）にし、必要なツールだけをホワイトリストで有効化する
  - 根拠: opencode の triage/duplicate-pr エージェントは全ツール無効から必要な1つだけを許可し、意図しない操作を防止している（`agent/triage.md:6-8`）
- `[MUST]` AI エージェントの自然言語プロンプトで指示したルールは、ツール実装内でもプログラム的にバリデーションする（多重防御）
  - 根拠: `github-triage.ts` はプロンプトのルールと同じ条件を `throw new Error()` で強制し、LLM の判断ミスを捕捉している（`tool/github-triage.ts:79-101`）
- `[SHOULD]` AI 向けの指示ファイル（AGENTS.md 等）はディレクトリ階層に沿って配置し、そのスコープに関連する知識だけを記載する
  - 根拠: opencode は 7 つの AGENTS.md を root, packages/\*, test/ 等に分散配置し、コンテキストウィンドウの効率的な利用とスコープの明確化を両立している
- `[SHOULD]` カスタムツールの実装コードと LLM 向け説明文は別ファイルに分離し、型宣言で接続する
  - 根拠: `.opencode/tool/` では `.ts` と `.txt` のペアで管理し、`env.d.ts` の `declare module "*.txt"` で型安全性を確保している
- `[SHOULD]` AI 生成コードの品質劣化（スロップ）を検出・除去する専用ワークフローを用意する
  - 根拠: `command/rmslop.md` は不要コメント・過剰防御・`any` キャスト・絵文字を検出対象とし、コード品質の自動維持を実現している
- `[SHOULD]` 定型的・低コストなタスク（コミット、検索、トリアージ）には小型・安価なモデルを明示的に指定し、コスト効率を最適化する
  - 根拠: commit コマンドは `kimi-k2.5`、issues コマンドは `claude-haiku-4-5`、triage エージェントは `minimax-m2.5` を指定している
- `[AVOID]` 単一の巨大プロンプトファイルにすべてのコンテキストを詰め込むこと。外部ファイル参照（`@ファイルパス` 等）で分割し、必要時にのみ読み込む構造にする
  - 根拠: `translator.md` は 900 行超になっており、差分の見通しとコンテキストウィンドウ効率の両面で改善余地がある

## 適用チェックリスト

- [ ] プロジェクトに `.opencode/`（または `.claude/` 等の AI 設定ディレクトリ）を作成し、agent/tool/command をサブディレクトリで分離しているか
- [ ] AI エージェント定義に YAML frontmatter でモデル・ツール権限・実行モードを宣言的に指定しているか
- [ ] ツールアクセスはデフォルト無効 + ホワイトリスト方式で管理しているか
- [ ] AI への自然言語指示と同じルールを、ツール実装のバリデーションコードでも強制しているか
- [ ] AGENTS.md（または CLAUDE.md）をディレクトリ階層に沿って配置し、スコープごとに適切な知識を分離しているか
- [ ] 定型タスク用のコマンドに小型モデルと `subtask` モードを指定してコスト最適化しているか
- [ ] AI 生成コードのスロップ（不要コメント・過剰防御・型回避）を検出する仕組みがあるか
- [ ] セッション中の学習を構造化して次回に活かすフィードバックループ（learn コマンド等）を用意しているか
