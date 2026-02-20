# AI アシスタント設定パターン

> リポジトリ: vercel/ai
> 分析日: 2026-02-20

## 概要

vercel/ai は、AI コーディングアシスタント向けの設定を多層的に構築している大規模なモノレポである。ルートレベルの `AGENTS.md`（`CLAUDE.md` はそのシンボリックリンク）をハブとし、`skills/` ディレクトリに用途別のタスクガイド、`contributing/` に人間向けコントリビューションガイド、パッケージレベルの `packages/ai/AGENTS.md` にスコープ限定の使用例を配置している。注目すべきは、スキルに「内部用 / 外部用」の区分を設け、AI アシスタントの知識を意図的に不信任する指示（"Everything you know is outdated or wrong"）を含む点で、急速に変化する SDK の最新仕様を AI に正しく参照させるための実践的な戦略が見られる。

## 背景にある原則

- **情報の鮮度保証の原則**: AI アシスタントの学習データは常に古い可能性がある。スキル内で「内部知識を信用するな、必ずソースコードかドキュメントを検証せよ」と明示することで、古い API を使ったコード生成を防止する。`use-ai-sdk/SKILL.md` の "Critical: Do Not Trust Internal Knowledge" セクションがこの原則を体現している。

- **関心の分離による段階的コンテキスト注入**: プロジェクト全体の規約（`AGENTS.md`）、特定タスクの手順（`skills/`）、人間向けガイド（`contributing/`）、パッケージスコープの使い方（`packages/ai/AGENTS.md`）を分離し、AI アシスタントが必要なタスクに応じて適切な粒度の情報を取得できるようにしている。

- **ツール横断の統一設定**: `AGENTS.md` を正規のファイルとし、`CLAUDE.md` をシンボリックリンクにすることで、Claude Code、Cursor、GitHub Copilot など複数の AI ツールに同一の指示を適用する。ファイル名による分岐ではなく、エイリアスによる統合を選択している。

- **禁止事項の明示的列挙**: "Do Not" セクションや `[AVOID]` 相当の指示を AGENTS.md 末尾に集約し、AI がやりがちな間違い（minor/major changeset の追加、`require()` の使用、`JSON.parse` の直接使用）を事前に防止する。

## 実例と分析

### 多層的な設定ファイル構成

vercel/ai では AI 設定を以下の4層に分けている:

| レイヤー         | ファイル                            | スコープ           | 内容                                                                       |
| ---------------- | ----------------------------------- | ------------------ | -------------------------------------------------------------------------- |
| プロジェクト全体 | `AGENTS.md` (+ `CLAUDE.md` symlink) | リポジトリ全体     | 概要、コマンド、コーディング規約、アーキテクチャ、エラーパターン、禁止事項 |
| パッケージ       | `packages/ai/AGENTS.md`             | ai パッケージ      | API 使用例（generateText, streamText）                                     |
| タスク（スキル） | `skills/*/SKILL.md`                 | 特定タスク         | プロバイダ追加、テストフィクスチャ取得、サンプル開発など                   |
| 人間向けガイド   | `contributing/*.md`                 | コントリビューター | 手動テスト手順、リリースフロー、Zod 注意事項                               |

AGENTS.md はこの中で最もコンテキスト効率が高く、285行に以下を凝縮している:

- リポジトリ構造（テーブル形式）
- 依存関係グラフ（ASCII ダイアグラム）
- 開発コマンド一覧（ルートレベル / パッケージレベル）
- コーディング規約
- エラーパターン（コード例付き）
- タスク完了ガイドライン（バグ修正 / 新機能 / リファクタ）
- 禁止事項一覧

### AGENTS.md をハブとした統一戦略

```
# AGENTS.md:1
# AGENTS.md

This file provides context for AI coding assistants (Cursor, GitHub Copilot, Claude Code, etc.) working with the Vercel AI SDK repository.
```

ファイル名を `AGENTS.md` にしている理由は、Claude Code 以外のツール（Cursor、GitHub Copilot）も対象にしているため。`CLAUDE.md` はシンボリックリンクとして作成:

```
CLAUDE.md -> AGENTS.md
```

これにより CLAUDE.md を期待する Claude Code と、AGENTS.md を読む他ツールの両方が同じ内容を参照する。ファイルを複製する方式と比べて同期の問題が起きない。

### スキルの内部/外部区分

5つのスキルのうち4つが `metadata.internal: true` を持ち、1つ（`use-ai-sdk`）だけが外部向け:

```yaml
# skills/add-provider-package/SKILL.md:1-6
---
name: add-provider-package
description: Guide for adding new AI provider packages to the AI SDK.
metadata:
  internal: true
---
```

```yaml
# skills/use-ai-sdk/SKILL.md:1-4
---
name: ai-sdk
description: 'Answer questions about the AI SDK and help build AI-powered features...'
---
```

内部スキル（`internal: true`）はリポジトリの開発タスク用、外部スキル（`use-ai-sdk`）は SDK のユーザーが AI アシスタント経由で使い方を質問する際に発動する。この区分により、同一リポジトリ内で「開発者向け」と「利用者向け」の知識を分離している。

### AI の内部知識を明示的に不信任するパターン

```
# skills/use-ai-sdk/SKILL.md:14-16
## Critical: Do Not Trust Internal Knowledge

Everything you know about the AI SDK is outdated or wrong.
```

このパターンは SDK が頻繁に破壊的変更を行う場合に有効。具体的な対処として:

1. `node_modules/ai/docs/` から最新ドキュメントを検索させる
2. 見つからなければ ai-sdk.dev を検索させる
3. それでも見つからなければ「見つからなかった」と明示させる

これは「幻覚防止」の実用的な戦略であり、AI が自信を持って古い API を使ったコードを生成する問題に直接対処している。

### references/ サブディレクトリによるスキルの知識拡張

`use-ai-sdk` スキルは `references/` ディレクトリに4つの補足ドキュメントを持つ:

```
skills/use-ai-sdk/
├── SKILL.md                       (78行: メインの指示)
└── references/
    ├── common-errors.md           (443行: よくある間違い)
    ├── type-safe-agents.md        (204行: 型安全パターン)
    ├── ai-gateway.md              (66行: ゲートウェイ設定)
    └── devtools.md                (52行: デバッグツール)
```

SKILL.md 本体は78行と軽量に保ち、詳細な参照情報は references/ に分離している。AI アシスタントは必要に応じてこれらを読み込む。

### common-errors.md によるマイグレーション支援

```typescript
// skills/use-ai-sdk/references/common-errors.md:9-24
// deprecated → current のマッピング例:
// maxTokens → maxOutputTokens
// maxSteps → stopWhen: stepCountIs(n)
// parameters → inputSchema
// generateObject → generateText with output
// toDataStreamResponse → toUIMessageStreamResponse
```

AI アシスタントの学習データには旧 API が含まれている前提で、deprecated API から現行 API へのマイグレーションガイドをスキルに組み込んでいる。これにより型チェックで失敗した際に AI が自力で修正方法を発見できる。

### タスク完了チェックリストの埋め込み

```markdown
# AGENTS.md:240-276

## Task Completion Guidelines

### Bug Fixes

1. Reproduction example
2. Unit tests (regression tests)
3. Implementation
4. Manual verification
5. Changeset

### New Features

1. Implementation
2. Examples
3. Unit tests
4. Documentation
5. Changeset
```

タスクの種類ごとに成果物の期待値を定義し、AI アシスタントが「何をもって完了とするか」を判断できるようにしている。同時に "When to Deviate" セクションで例外ケースも示しており、硬直的なチェックリストにならないよう配慮している。

### スキル間の相互参照

```markdown
# skills/add-provider-package/SKILL.md:218

See `capture-api-response-test-fixture` skill for capturing real API responses for testing.

# skills/add-provider-package/SKILL.md:359-364

## Related Documentation

- [Provider Architecture](../../contributing/provider-architecture.md)
- [Develop AI Functions Example](../develop-ai-functions-example/SKILL.md)
```

スキル同士が明示的にリンクしあい、複合的なタスク（例: 新プロバイダ追加にはテストフィクスチャの取得も必要）を AI アシスタントが自律的に遂行できる情報ネットワークを形成している。

## コード例

```yaml
# skills/add-provider-package/SKILL.md:1-6
# スキルのフロントマター（内部用）
---
name: add-provider-package
description: Guide for adding new AI provider packages to the AI SDK. Use when creating a new @ai-sdk/<provider> package to integrate an AI service into the SDK.
metadata:
  internal: true
---
```

```yaml
# skills/use-ai-sdk/SKILL.md:1-4
# スキルのフロントマター（外部用: metadata なし）
---
name: ai-sdk
description: 'Answer questions about the AI SDK and help build AI-powered features. Use when developers: (1) Ask about AI SDK functions...'
---
```

```markdown
# AGENTS.md:278-285

# 禁止事項を末尾にまとめるパターン

## Do Not

- Add minor/major changesets
- Change public APIs without updating documentation
- Use `require()` for imports
- Add new dependencies without running `pnpm update-references`
- Modify `content/docs/08-migration-guides` or `packages/codemod` as part of broader codebase changes
```

```typescript
// AGENTS.md:170-188
// エラーパターンのテンプレートをコード例として埋め込む
const name = "AI_MyError";
const marker = `vercel.ai.error.${name}`;
const symbol = Symbol.for(marker);

export class MyError extends AISDKError {
  private readonly [symbol] = true;

  constructor({ message, cause }: { message: string; cause?: unknown; }) {
    super({ name, message, cause });
  }

  static isInstance(error: unknown): error is MyError {
    return AISDKError.hasMarker(error, marker);
  }
}
```

## パターンカタログ

- **Adapter パターン** (分類: 構造)
  - 解決する問題: 複数の AI プロバイダの API 差異を吸収する
  - 適用条件: AGENTS.md の Architecture セクションで AI アシスタントに設計判断を伝える
  - コード例: `AGENTS.md:193-199`（4層のプロバイダアーキテクチャ解説）
  - 注意点: AI アシスタントが新しいプロバイダを追加する際の判断基準として機能する。スキル（`add-provider-package`）が具体的な手順を補完する

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: スキルのフロントマターの `description` が AI アシスタントの「どのスキルを発動するか」の判断基準になる
  - 適用条件: `use-ai-sdk` の description にトリガーワードを列挙 ("AI SDK", "generateText", "build an agent" など)
  - コード例: `skills/use-ai-sdk/SKILL.md:3`
  - 注意点: description の質がスキルの発動精度に直結する。vercel/ai では具体的なキーワードとユースケース番号を併記している

## Good Patterns

- **シンボリックリンクによるツール横断統一**: `CLAUDE.md -> AGENTS.md` とすることで、ファイル複製の同期問題を回避しつつ複数ツールに対応する。

```bash
# リポジトリルート
ls -la CLAUDE.md
# lrwxr-xr-x CLAUDE.md -> AGENTS.md
```

- **段階的コンテキスト注入**: AGENTS.md を軽量なハブ（285行）に保ち、詳細はスキルや contributing/ に分離する。AI アシスタントは AGENTS.md を常に読み、タスクに応じてスキルを追加参照する。

- **"Do Not" セクションの末尾集約**: AI がやりがちな間違いを禁止リストとして AGENTS.md の末尾に列挙する。末尾に配置することで、AI が最後に読む情報として記憶に残りやすい。

```markdown
## Do Not

- Add minor/major changesets
- Change public APIs without updating documentation
- Use `require()` for imports
```

- **スキル description へのトリガーワード列挙**: 外部向けスキルの description にユーザーが使いそうなキーワードを網羅的に列挙し、スキルの自動発動精度を高める。

```yaml
description: 'Answer questions about the AI SDK and help build AI-powered features. Use when developers: (1) Ask about AI SDK functions like generateText, streamText... Triggers on: "AI SDK", "Vercel AI SDK", "generateText"...'
```

- **内部知識不信任パターン**: 頻繁に変更される API を持つプロジェクトで、AI の学習データが古い前提を明示し、ソースコードやドキュメントからの検証を強制する。

## Anti-Patterns / 注意点

- **AGENTS.md の肥大化**: AGENTS.md にすべての情報を詰め込むと、トークン数が増大し AI のコンテキストウィンドウを圧迫する。vercel/ai は285行に抑えているが、プロバイダが増え続ける場合はさらなる分離が必要になる。

```markdown
# Bad: すべてのプロバイダの詳細を AGENTS.md に記載

## OpenAI Provider

### Models: gpt-4o, gpt-4o-mini, ...

### Options: temperature, maxTokens, ...

(1000行以上に膨れ上がる)

# Better: AGENTS.md はリンクのみ

## Providers

See `contributing/packages.md` for the full provider list.
See `skills/add-provider-package` for adding a new provider.
```

- **ファイルコピーによるツール横断対応**: CLAUDE.md と AGENTS.md を同内容で別ファイルとして管理すると、片方の更新を忘れて不整合が起きる。シンボリックリンクまたは単一ファイルを正とすべき。

```bash
# Bad: ファイルコピー
cp AGENTS.md CLAUDE.md  # 片方だけ更新される危険性

# Better: シンボリックリンク
ln -s AGENTS.md CLAUDE.md  # 常に同期
```

- **スキルの description 不足**: スキルの description が曖昧だと AI アシスタントが適切なタイミングでスキルを発動できない。`capture-api-response-test-fixture` の description は "Capture API response test fixture." と短すぎる点が改善余地。

## 導出ルール

- `[MUST]` AI アシスタント設定ファイル（AGENTS.md / CLAUDE.md 等）に禁止事項を "Do Not" セクションとして明示的に列挙する
  - 根拠: vercel/ai の AGENTS.md は末尾の "Do Not" セクション（5項目）で AI がやりがちな誤り（minor changeset の追加、`require()` の使用等）を防止しており、曖昧な「注意」より具体的な禁止リストの方が AI の遵守率が高い

- `[MUST]` 頻繁に破壊的変更がある API を扱うプロジェクトでは、AI アシスタントに内部知識を信用させず、ソースコードまたはドキュメントからの検証を強制する指示を含める
  - 根拠: `use-ai-sdk/SKILL.md` が "Everything you know about the AI SDK is outdated or wrong" と明示し、`node_modules/ai/docs/` の検索を必須ステップとすることで、古い API の誤用を防止している

- `[SHOULD]` 複数の AI ツール（Claude Code, Cursor, Copilot 等）を対象にする場合、1つの正規ファイル（AGENTS.md）を作成し、他のファイル名（CLAUDE.md 等）はシンボリックリンクで対応する
  - 根拠: vercel/ai は `CLAUDE.md -> AGENTS.md` のシンボリックリンクにより、ファイルコピーの同期問題を回避しつつ複数ツールに同一の指示を適用している

- `[SHOULD]` スキルファイルの description には、ユーザーが使いそうなキーワードとユースケースを具体的に列挙し、自動発動の精度を高める
  - 根拠: `use-ai-sdk/SKILL.md` の description は「Use when developers: (1)... (2)... Triggers on: "AI SDK", "generateText"...」のように具体的なトリガーワードを含み、漠然とした description より発動精度が高い

- `[SHOULD]` AI アシスタント設定を「プロジェクト全体（AGENTS.md）→ パッケージ/モジュール（サブ AGENTS.md）→ タスク（skills/）」の階層構造にし、ルートファイルは300行以下に抑える
  - 根拠: vercel/ai は AGENTS.md を285行に抑え、詳細を skills/（5つ）と contributing/（12ファイル）に分離することで、AI のコンテキスト効率と情報の網羅性を両立している

- `[SHOULD]` タスク完了の判断基準を、タスク種別ごとに成果物リストとして AI 設定に含め、同時に「逸脱してよい条件」も明示する
  - 根拠: AGENTS.md の "Task Completion Guidelines" はバグ修正（5ステップ）/新機能（5ステップ）/リファクタ（3ステップ）を定義しつつ、"When to Deviate" で例外を認めており、硬直性と柔軟性のバランスを取っている

- `[AVOID]` AI アシスタント設定ファイルにリポジトリの全情報を詰め込むこと。テーブルや ASCII ダイアグラムで情報密度を上げ、詳細は別ファイルへのリンクで対応する
  - 根拠: vercel/ai の AGENTS.md は依存関係を ASCII グラフ（3行）、ディレクトリ構造をテーブル（11行）で表現し、50以上のパッケージを持つモノレポの情報を285行に凝縮している

## 適用チェックリスト

- [ ] プロジェクトルートに AGENTS.md（または CLAUDE.md）を作成し、プロジェクト概要・コマンド・コーディング規約・禁止事項を記載する
- [ ] 複数の AI ツールを使う場合、1つのファイルを正として他はシンボリックリンクにする
- [ ] AGENTS.md は300行以下に抑え、詳細はスキルや別ドキュメントに分離する
- [ ] "Do Not" セクションを設け、AI がやりがちな間違いを具体的に列挙する
- [ ] 頻繁に変更される API がある場合、AI に内部知識を信用させない指示を含める
- [ ] 繰り返し行うタスク（プロバイダ追加、テスト作成等）はスキルとして構造化する
- [ ] スキルの description にはトリガーワードとユースケースを具体的に列挙する
- [ ] 内部用スキルと外部用スキルを metadata で区分する
- [ ] タスク種別ごとの完了基準を定義し、例外条件も明示する
- [ ] deprecated API のマイグレーションガイドを AI が参照できる形で用意する（common-errors.md パターン）
