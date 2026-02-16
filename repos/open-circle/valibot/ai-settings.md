# AI 支援開発の設定パターン

> リポジトリ: open-circle/valibot
> 分析日: 2026-02-16

## 概要

Valibot は AGENTS.md と Agent Skills（agentskills.io 準拠）の二層構造で AI エージェントへの指示を体系化している。AGENTS.md がリポジトリ全体の「何をどう守るか」を簡潔に定義し、`skills/` ディレクトリ配下の 6 つの SKILL.md がタスク別の手順書を提供する。この分離設計により、AI エージェントは「常時ロードするコンテキスト」と「タスク発生時にオンデマンドで読むコンテキスト」を使い分けられる。AGENTS.md が約 60 行、各 SKILL.md が 100-350 行という配分は、コンテキストウィンドウの効率的利用として参考になる。

## 背景にある原則

- **Progressive Disclosure（段階的開示）**: AI エージェントのコンテキストウィンドウは有限であるため、全情報を一度に渡すのではなく、タスクに応じて必要な情報だけをロードさせるべき。Valibot では AGENTS.md（常時ロード、約 60 行）→ SKILL.md（タスク発動時にロード、100-350 行）→ ソースコード（SKILL.md 内の参照で必要時に読む）という 3 段階を設計している。
- **Source Code as Single Source of Truth（ソースコードが唯一の正）**: ドキュメントや AI 向け指示が古くなるリスクを最小化するため、「ソースコードが正である」とルールで明示し、AI がドキュメントとコードの不一致を発見した場合にコードを信頼するよう誘導する（`AGENTS.md:38`）。これにより AI 向けの指示自体のメンテナンスコストも削減される。
- **タスクスコープの明示的分割**: 「コードレビュー」「ドキュメント作成」「構造ナビゲーション」といったタスクの境界を SKILL.md 単位で物理的に分離することで、AI エージェントが混在するコンテキストから誤った行動を取るリスクを減らすべき。Valibot の 6 スキルはそれぞれ独立した関心事を持ち、相互参照で連携する。
- **コンベンション駆動の品質担保**: ESLint ルールと AI 向け指示を同期させることで、人間の開発者と AI エージェントの両方に同一の規約を適用する。`interface` 強制（`eslint.config.js:45` の `consistent-type-definitions`）、`.ts` 拡張子強制（`eslint.config.js:49` の `import/extensions`）、JSDoc 必須（`eslint.config.js:67` の `require-jsdoc`）がその例。

## 実例と分析

### AGENTS.md の構造設計

AGENTS.md は GitHub Copilot の規約（`# Copilot Instructions` ヘッダ）に従いつつ、汎用的な AI エージェントが読める構造になっている。約 60 行で以下の 6 セクションに分割されている。

1. **リポ概要**（1 行）: ライブラリの一文説明
2. **Planning Mode**（3 行）: 質問を一つずつ行う対話パターンの指示
3. **Monorepo Layout**（テーブル形式）: ディレクトリ → 目的のマッピング
4. **Essential Commands**（コードブロック）: 4 つの主要コマンド
5. **Code Conventions**（箇条書き 4 項目）: ESM `.ts` 拡張子、`interface` 優先、JSDoc 必須、`@__NO_SIDE_EFFECTS__`
6. **Agent Skills 参照**（2 行）: skills/ ディレクトリの存在と命名規約

注目すべき点は、AGENTS.md に冗長な説明を一切含めず、「一覧性」と「正確性」に徹している点である。コンベンションは 4 項目に絞られ、各項目が ESLint ルールで機械的にも検証可能。

### Agent Skills の設計パターン

6 つのスキルは `repo-` プレフィックスで「このリポジトリ固有のスキル」であることを明示し、タスクのドメインで分類されている。

```
repo-structure-navigate     → 読み取り専用ナビゲーション
repo-source-code-document   → JSDoc・コメントの書き方
repo-source-code-review     → PRレビューのチェックリスト
repo-website-api-create     → API ドキュメント新規作成
repo-website-api-update     → API ドキュメント更新
repo-website-guide-create   → ガイド記事の作成
```

この分類は「読む」「書く（コード側）」「書く（ドキュメント側）」の 3 軸で整理されており、1 つのスキルが複数の関心事を持たないよう設計されている。

### description フィールドの設計

各 SKILL.md の `description` フィールドは「何をするか」と「いつ使うか」の両方を含んでいる。これは agentskills.io 仕様の推奨に従ったもので、AI エージェントがスキル選択を正しく行うための鍵となる。

```yaml
# skills/repo-source-code-review/SKILL.md:2-3
name: repo-source-code-review
description: Review pull requests and source code changes in /library/src/. Use when reviewing PRs, validating implementation patterns, or checking code quality before merging.
```

「Review pull requests」が「何をするか」、「Use when reviewing PRs, validating implementation patterns」が「いつ使うか」に対応する。パスの明示（`/library/src/`）もスコープを限定する役割を果たしている。

### スキル間の相互参照パターン

スキル同士は名前で参照し合い、依存関係を明示している。

```markdown
# skills/repo-source-code-review/SKILL.md:131-134

## Related Skills

- `repo-structure-navigate` — Navigate the codebase
- `repo-source-code-document` — JSDoc requirements
```

```markdown
# skills/repo-website-api-update/SKILL.md:10

**Prerequisite:** Read the `repo-website-api-create` skill for `properties.ts` and `index.mdx` patterns.
```

これにより、AI エージェントは「レビュー中にドキュメント規約を確認したい」場合に `repo-source-code-document` を追加ロードできる。前提条件を `Prerequisite:` で明示するパターンは、スキルの実行順序を AI に伝える有効な手法。

### Planning Mode の対話制御

AGENTS.md の Planning Mode セクションは短いが極めて実用的。

```markdown
# AGENTS.md:7-8

When in planning mode and something is unclear, ask questions **one at a time** (like a quiz).
Wait for each answer before asking the next question.
```

AI エージェントが一度に大量の質問をすると、ユーザーの認知負荷が上がり回答の質も下がる。「一問一答」を強制することで、各回答に基づいた次の質問の最適化が可能になる。

### ESLint とAI 指示の同期

AGENTS.md の Code Conventions セクションに書かれた 4 つのルールは、すべて `library/eslint.config.js` で機械的に強制されている。

| AGENTS.md の記述                                     | ESLint ルール                                           | 行番号                   |
| ---------------------------------------------------- | ------------------------------------------------------- | ------------------------ |
| ESM with `.ts` extensions                            | `import/extensions: ['error', 'always']`                | `eslint.config.js:49`    |
| `interface` over `type`                              | `consistent-type-definitions: 'error'`                  | `eslint.config.js:45`    |
| JSDoc required on exported functions                 | `jsdoc/require-jsdoc: 'error'`                          | `eslint.config.js:67`    |
| `@__NO_SIDE_EFFECTS__` before pure factory functions | `jsdoc/check-tag-names` に `__NO_SIDE_EFFECTS__` を登録 | `eslint.config.js:78-83` |

この同期により、AI エージェントが規約に違反するコードを生成しても、lint で即座に検出される。AI 向け指示は「なぜそうするか」を伝え、ESLint は「守らなかったら止める」フェイルセーフとして機能する。

## コード例

AGENTS.md のモノレポレイアウトテーブル（簡潔で一覧性の高いフォーマット）:

```markdown
# AGENTS.md:11-17

| Directory                  | Purpose                                         |
| -------------------------- | ----------------------------------------------- |
| `library/`                 | Core `valibot` package — most work happens here |
| `packages/to-json-schema/` | JSON Schema converter                           |
| `packages/i18n/`           | Translated error messages                       |
| `website/`                 | valibot.dev (Qwik + Vite)                       |
| `codemod/`                 | Migration and conversion tools                  |
```

SKILL.md のチェックリスト形式（AI エージェントが漏れなく確認できる構造）:

```markdown
# skills/repo-source-code-review/SKILL.md:122-130

## Checklist

- [ ] Implementation follows existing patterns in similar files
- [ ] `// @__NO_SIDE_EFFECTS__` on pure factory functions
- [ ] All imports use `.ts` extension
- [ ] `interface` used for object shapes
- [ ] JSDoc complete on all exports
- [ ] Runtime tests in `.test.ts`
- [ ] Type tests in `.test-d.ts`
- [ ] Naming conventions followed
```

SKILL.md の Quick Reference テーブル（パターンと具体例の対応）:

```markdown
# skills/repo-source-code-document/SKILL.md:274-288

| Pattern                       | Example                                        |
| ----------------------------- | ---------------------------------------------- |
| `// Get [what]`               | `// Get input value from dataset`              |
| `// If [condition], [action]` | `// If root type is valid, check nested types` |
| `// Otherwise, [action]`      | `// Otherwise, add issue`                      |
| `// Create [what]`            | `// Create object path item`                   |
| `// Hint: [explanation]`      | `// Hint: This is for performance`             |
```

## Good Patterns

- **二層コンテキスト設計**: AGENTS.md（常時ロード、要約レベル）と SKILL.md（タスク発動時ロード、手順レベル）を分離することで、コンテキストウィンドウを効率的に使う。AGENTS.md は 60 行以内に収め、詳細は skills/ に委譲する。Valibot の AGENTS.md 末尾で `This repository includes agent skills in /skills/` と一文で接続しているのが好例。

- **description の「What + When」パターン**: SKILL.md の description に「何をするか」と「いつ使うか」を両方記述することで、AI エージェントのスキル選択精度を高める。`Review pull requests and source code changes in /library/src/. Use when reviewing PRs, validating implementation patterns, or checking code quality before merging.` のように、対象パス・トリガー条件を具体的に書く。

- **チェックリスト駆動のタスク完了保証**: 各 SKILL.md の末尾にチェックリストを配置し、AI エージェントが作業完了時に自己検証できるようにする。`repo-source-code-review` の 8 項目チェックリスト、`repo-website-api-create` の 11 項目チェックリストがその例。

- **ESLint ルールと AI 指示の二重防御**: AI 向けの指示（AGENTS.md）で「なぜ」を伝え、ESLint ルール（`eslint.config.js`）で機械的に強制する。片方だけでは不十分 -- AI 指示だけでは違反を検出できず、ESLint だけでは「なぜ」が伝わらない。

- **スキルの相互参照による知識グラフ**: `Related Skills` セクションや `Prerequisite:` キーワードでスキル間の関連を明示し、AI エージェントが必要に応じて追加コンテキストをロードできるようにする。

## Anti-Patterns / 注意点

- **AGENTS.md に全規約を詰め込む**: AGENTS.md を数百行に膨らませると、AI エージェントが常時大量のコンテキストを消費する。Valibot が AGENTS.md を 60 行に抑え、詳細を SKILL.md に分離しているのは意図的な設計。

  ```markdown
  # Bad: AGENTS.md に全部書く（400行超）

  ## JSDoc Patterns

  ### Interface Documentation

  (100行のJSDocルール...)

  ### Function Overloads

  (80行のオーバーロードルール...)
  ```

  ```markdown
  # Better: AGENTS.md は要約、詳細は SKILL.md

  ## Code Conventions

  - **JSDoc required** on exported functions (first overload only for overload sets)

  ## Agent Skills

  This repository includes agent skills in `/skills/`
  ```

- **description に「何をするか」だけ書く**: `description: Review source code.` のように「いつ使うか」を欠くと、AI エージェントがスキルを適切なタイミングで発動できない。

  ```yaml
  # Bad
  description: Review source code.
  ```

  ```yaml
  # Better
  description: Review pull requests and source code changes in /library/src/. Use when reviewing PRs, validating implementation patterns, or checking code quality before merging.
  ```

- **AI 指示と Linter の不整合**: AGENTS.md で `interface` を推奨しつつ ESLint で強制していない場合、AI が `type` を生成してもエラーにならず、規約が形骸化する。Valibot は `consistent-type-definitions: 'error'` で機械的に保証している。

## 導出ルール

> このセクションは必須。最低 3 個のルールを記載すること。synthesis-writer が rules.md 生成時に参照する。
> リトマステスト: 「このリポジトリを知らない開発者が読んで、自分のコードに適用できるか？」-- Yes でなければ抽象度が不足している。

- `[MUST]` AI エージェント向けの指示ファイル（AGENTS.md / CLAUDE.md）は常時ロードされるコストを考慮し、100 行以内に収める。詳細な手順はタスク別のスキルファイルやドキュメントに分離する
  - 根拠: Valibot の AGENTS.md は約 60 行で 6 セクションを網羅し、タスク別詳細は `skills/` 配下の 6 つの SKILL.md（各 100-350 行）に委譲している

- `[MUST]` AI 向けコーディング規約は、対応する Linter ルールで機械的にも強制する。AI が規約に違反するコードを生成した場合のフェイルセーフとなる
  - 根拠: AGENTS.md の 4 つの Code Conventions はすべて `eslint.config.js` の ESLint ルールで `'error'` レベルで強制されている

- `[SHOULD]` AI エージェント向けのタスク別指示（SKILL.md 等）には、末尾にチェックリスト（`- [ ]` 形式）を設け、作業完了時の自己検証を促す
  - 根拠: Valibot の 6 つの SKILL.md のうち 5 つがチェックリストセクションを持ち、AI エージェントのタスク完了品質を担保している

- `[SHOULD]` AI 向けスキルの description には「何をするか」と「いつ使うか」を両方記述し、対象パスやトリガー条件を具体的に含める
  - 根拠: Valibot のスキル description は `Review pull requests and source code changes in /library/src/. Use when reviewing PRs...` のように対象パスとトリガーを明示している

- `[SHOULD]` 「ソースコードが唯一の正」ルールを AI 向け指示に明記し、ドキュメントとコードに不一致がある場合はコードを信頼するよう誘導する
  - 根拠: `AGENTS.md:38` の `Source code is the single source of truth. All documentation must match /library/src/.` がこの原則を端的に表現している

- `[AVOID]` AI 向けの指示ファイルに、機械的に検証できないあいまいなルールだけを書く。ルールには具体的なパターン（テーブル形式やコード例）を添える
  - 根拠: Valibot の SKILL.md はすべて「パターン | 例」形式のテーブルや Good/Bad のコード例を含み、AI エージェントが曖昧さなく従える粒度で記述されている

## 適用チェックリスト

- [ ] AGENTS.md / CLAUDE.md が 100 行以内に収まっているか。超過している場合、タスク別の指示ファイルに分離できないか検討する
- [ ] AI 向け指示に書いたコーディング規約に、対応する Linter ルール（ESLint / Biome 等）が設定されているか
- [ ] タスク別の AI 指示（スキルファイル等）に、完了チェックリストが含まれているか
- [ ] スキルの description に「何をするか」と「いつ使うか」の両方が記述されているか
- [ ] モノレポの場合、ディレクトリ構成がテーブル形式で AGENTS.md に記載されているか
- [ ] AI 向け指示内のコード規約と、実際の Linter 設定に不整合がないか定期的にレビューしているか
- [ ] スキル間の依存関係が Related Skills / Prerequisite で明示されているか
