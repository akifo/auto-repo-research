# AI Settings

> リポジトリ: Effect-TS/effect
> 分析日: 2026-02-18

## 概要

Effect-TS/effect は AGENTS.md をルートに配置し、AI コーディングアシスタント向けの開発ワークフロー・コードスタイル・テストパターンを一元的に定義している。`.claude/` や `.cursor*` は存在せず、単一ファイルで全 AI ツールに対応するアプローチを採っている。AGENTS.md の指示は ESLint ルール・CI ワークフロー・gitignore 等の実際のツールチェーンと高い整合性を持ち、AI が生成するコードが自動チェックをすり抜けないよう設計されている。特に注目すべきは、scratchpad ディレクトリによるサンドボックス機構と、`.repos/` による外部参照リポジトリの知識注入パターンである。

## 背景にある原則

- **機械的に検証可能な指示のみ記述する**: AGENTS.md の指示はほぼすべて ESLint・TypeScript コンパイラ・CI で自動検証される。「コードを美しく書け」のような曖昧な指示はなく、`pnpm lint-fix` を実行せよ、`pnpm check` で型を確認せよ、といった具体的なコマンドに落とし込まれている（AGENTS.md "Mandatory Validation Steps" セクション、`.github/workflows/check.yml`）
- **既存コードを教師とする**: AGENTS.md は「既存コードを見て学べ」と繰り返し指示する。テストセクションでは "look at existing tests in the codebase for similar functionality to follow established patterns" と2回記述されており、AI にパターン認識を委ねつつ暗黙知を伝搬させる設計（AGENTS.md "Code Style Guidelines"、"Testing" セクション）
- **安全な実験環境を提供する**: scratchpad/ ディレクトリは pnpm-workspace.yaml に含まれ全パッケージに workspace:* でアクセスでき、`.gitignore` で追跡対象外とされている。AI がコードを試行錯誤する際に本体コードを汚染しない仕組み（`scratchpad/package.json`、`.gitignore`）
- **認知負荷を最小化する**: Core Principles で "Conciseness"（簡潔さ）と "Reduce comments" を掲げ、文法よりも簡潔さを優先するよう明示。AI が冗長なコメントや説明を生成するデフォルト傾向を抑制している（AGENTS.md "Core Principles"）

## 実例と分析

### AGENTS.md の構造設計

AGENTS.md は以下の階層構造で情報を整理している:

1. **コンテキスト宣言** — リポジトリが何であるかを1行で説明（"This is the Effect library repository"）
2. **開発ワークフロー** — ブランチ戦略とパッケージマネージャーの指定
3. **Core Principles** — 4つの原則（Zero Tolerance for Errors / Clarity over Cleverness / Conciseness / Reduce comments）
4. **バリデーション手順** — 具体的なコマンドを実行順序で列挙
5. **コードスタイル** — フォーマッタに任せる宣言 + 自動生成ファイルの注意
6. **変更管理** — Changeset の要求
7. **テスト** — テストランナー、ファイル配置、パターン（it.effect）
8. **知識参照** — 外部リポジトリへのポインタ

この構造は「上から順に重要度が下がる」のではなく、「開発フローの時系列に沿っている」。コードを書く前のコンテキスト理解 → 書く際のスタイル → 書いた後のバリデーション → PR 提出時の changeset、という流れになっている。

### バリデーションパイプラインと CI の対応

AGENTS.md が指示するバリデーション手順は CI ワークフロー（`.github/workflows/check.yml`）と一致している:

| AGENTS.md の指示       | CI ジョブ                                               |
| ---------------------- | ------------------------------------------------------- |
| `pnpm lint-fix`        | `lint` ジョブの `pnpm lint`                             |
| `pnpm check`           | `types` ジョブの `pnpm check`                           |
| `pnpm test run <file>` | `test` ジョブの `pnpm vitest --shard`                   |
| `pnpm docgen`          | `lint` ジョブの `pnpm codegen` + `git diff --exit-code` |
| `pnpm build`           | 明示的にはないが release ワークフローで実行             |

CI には AGENTS.md に記述されていない追加チェックもある: `pnpm circular`（循環依存チェック）、`pnpm test-types`（型テスト）、`pnpm codegen` の結果が git diff を生まないこと。これらは AI 向けには不要と判断されて省略されている。

### scratchpad ディレクトリのサンドボックス設計

scratchpad/ は以下の要素が組み合わさって安全な実験環境を実現している:

1. `pnpm-workspace.yaml` に含まれているため、全パッケージを `workspace:*` で参照可能
2. `.gitignore` で追跡対象外
3. `.changeset/config.json` の `"ignore": ["scratchpad"]` でリリース対象から除外
4. AGENTS.md で「使い終わったら削除せよ」と明示

この設計により、AI は本番コードに影響を与えずにコードを実行・テストできる。単なる一時ディレクトリではなく、モノレポ内の全パッケージにアクセスできる「プレイグラウンドパッケージ」である。

### .repos/ による外部知識の注入

AGENTS.md の末尾に `.repos/effect-v4` への参照がある。`.gitignore` で `.repos/` は追跡対象外とされており、ローカルにクローンされた外部リポジトリを AI のコンテキストとして利用する仕組みである。これにより、AI はリリースされていない次期バージョンの情報をローカルファイルシステム経由で参照できる。

### テストパターンの明示的指定

AGENTS.md はテストにおいて `it.effect` パターンを具体的に指定している。`@effect/vitest` パッケージが提供するこのパターンは、通常の `it` + `Effect.runSync` の代わりに Effect ランタイム上でテストを実行する。AGENTS.md ではさらに以下を指定:

- `assert` メソッドを使え（vitest の `expect` ではなく）
- `@effect/vitest` から `{ assert, describe, it }` をインポートせよ

実際のテストコードでは `@effect/vitest/utils` から `deepStrictEqual`、`strictEqual`、`assertTrue` 等をインポートしており、AGENTS.md の記述はやや簡略化されているが方向性は一致している。

### コメント抑制ポリシーの実践

"Reduce comments" 原則は internal コードで徹底されている。`packages/effect/src/internal/core.ts`（3166行）にはインラインコメントがほとんどなく、セクション区切り用の `// ----- Effect -----` 形式のバナーコメントのみ。一方、公開 API（`Effect.ts` 等）では JSDoc が充実しており、`@since`、`@category`、`@example` が一貫して付与されている。つまり「コメントを減らせ」は内部実装に対する指示であり、公開 API のドキュメントは別の基準で管理されている。

## コード例

AGENTS.md のバリデーション手順:

```
// AGENTS.md:17-23
### Mandatory Validation Steps

- Run `pnpm lint-fix` after editing files
- Always run tests after making changes: `pnpm test run <test_file.ts>`
- Run type checking: `pnpm check`
  - If type checking continues to fail, run `pnpm clean` to clear caches, then re-run `pnpm check`
- Build the project: `pnpm build`
- Check JSDoc examples compile: `pnpm docgen`
```

CI でのコード生成の差分チェック:

```yaml
# .github/workflows/check.yml:36-39
      - run: pnpm codegen
      - name: Check for codegen changes
        run: git diff --exit-code
```

scratchpad の changeset 除外設定:

```json
// .changeset/config.json:8-9
  "ignore": ["scratchpad"],
```

scratchpad のワークスペース定義:

```yaml
# pnpm-workspace.yaml:1-4
packages:
  - scratchpad
  - packages/*
  - packages/ai/*
```

it.effect テストパターンの実例:

```typescript
// packages/effect/test/ScopedCache.test.ts:1-2,79-81
import { describe, it } from "@effect/vitest"
import { assertFalse, assertLeft, assertNone, assertRight, assertSome, assertTrue, deepStrictEqual, strictEqual } from "@effect/vitest/utils"

  it.effect("invalidate - should properly remove and clean a resource from the cache", () =>
    Effect.gen(function*() {
      const capacity = 100
```

バレルインポート禁止の ESLint ルール（ソースコード限定）:

```javascript
// eslint.config.mjs:150-159
  {
    files: ["packages/*/src/**/*"],
    rules: {
      "@effect/no-import-from-barrel-package": [
        "error",
        {
          packageNames: ["effect", "@effect/platform", "@effect/sql"]
        }
      ]
    }
  }
```

## パターンカタログ

- **Sandbox Pattern** (分類: 構造)
  - 解決する問題: AI が試行錯誤する際に本番コードを汚染するリスク
  - 適用条件: モノレポ構成で、AI が複数パッケージを横断してコードを試す必要がある場合
  - コード例: `scratchpad/package.json`、`pnpm-workspace.yaml:2`、`.gitignore:10`、`.changeset/config.json:9`
  - 注意点: ワークスペースに含めないと依存パッケージを参照できない。changeset の ignore に入れないとリリースフローが壊れる

- **Knowledge Injection Pattern** (分類: 構造)
  - 解決する問題: AI がリリース前の次期バージョンや非公開ドキュメントにアクセスできない
  - 適用条件: AI に特定の外部知識を参照させたいが、リポジトリに含めたくない場合
  - コード例: `AGENTS.md:72-77`、`.gitignore:14`
  - 注意点: `.gitignore` に含めないとリポジトリサイズが肥大化する。パスが存在しない場合の AI の振る舞いは未定義

- **Validation Pipeline Pattern** (分類: 振る舞い)
  - 解決する問題: AI が変更を加えた後のチェック手順が不明確で、壊れたコードが PR に含まれる
  - 適用条件: CI パイプラインが存在し、AI にローカルでの事前検証を求める場合
  - コード例: `AGENTS.md:17-23`、`.github/workflows/check.yml`
  - 注意点: CI 側にしかないチェック（circular 等）は AI が見落とす可能性がある

## Good Patterns

- **コマンドベースの指示**: AGENTS.md のバリデーション手順は曖昧な「テストを実行してください」ではなく、`pnpm test run <test_file.ts>` のように実行可能なコマンドを直接記述している。AI はこれをそのまま実行できるため、解釈の余地がない。

```
// AGENTS.md:19
- Always run tests after making changes: `pnpm test run <test_file.ts>`
```

- **フォーマッタへの委譲宣言**: コードスタイルセクションで「フォーマットは `pnpm lint-fix` に任せろ、完璧にしようとするな」と明示している。AI がフォーマットに時間を浪費することを防ぎ、意味のある変更に集中させる。

```
// AGENTS.md:29-30
Do not worry about getting code formatting perfect while writing. Use `pnpm lint-fix`
to automatically format code according to the project's style guidelines.
```

- **エラー時のリカバリ手順の提供**: 型チェックが失敗し続ける場合の対処法（`pnpm clean` でキャッシュクリア後に再実行）を記載している。AI がエラーループに陥ることを防ぐ。

```
// AGENTS.md:21-22
- Run type checking: `pnpm check`
  - If type checking continues to fail, run `pnpm clean` to clear caches, then re-run `pnpm check`
```

- **自動生成ファイルの明示的警告**: barrel file（`index.ts`）が自動生成であることを明記し、手動編集を禁止している。AI が自動生成ファイルを書き換えてしまう事故を防ぐ。

```
// AGENTS.md:33-35
The `index.ts` files are automatically generated. Do not manually edit them. Use
`pnpm codegen` to regenerate barrel files after adding or removing modules.
```

## Anti-Patterns / 注意点

- **AGENTS.md とコードベースの微妙な乖離**: AGENTS.md は「`assert` メソッドを使え」と書いているが、実際のテストでは `@effect/vitest/utils` から `deepStrictEqual` や `strictEqual` を個別にインポートしている。`assert.deepStrictEqual` ではなく `deepStrictEqual` が直接使われている。AGENTS.md の記述が実際のパターンを100%反映していない。

```typescript
// Bad: AGENTS.md の記述に従った場合の想定コード
import { assert } from "@effect/vitest";
assert.deepStrictEqual(actual, expected);

// Better: 実際のコードベースのパターン
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils";
deepStrictEqual(actual, expected);
```

- **暗黙の前提知識への依存**: AGENTS.md は `.repos/effect-v4` への参照を記載しているが、このディレクトリのセットアップ手順は書かれていない。AI がこのパスにアクセスしようとして失敗した場合のフォールバックも定義されていない。

```
// AGENTS.md:72-77
## Learning about "effect" v4
If you need to learn more about the new version of effect (version 4), you can
access the repository here:
`.repos/effect-v4`
```

- **CI 限定チェックの非記載**: `pnpm circular`（循環依存チェック）は CI で実行されるが AGENTS.md には記載されていない。AI が循環依存を導入しても、ローカルでは検出されない可能性がある。

## 導出ルール

- `[MUST]` AGENTS.md にはコマンドベースのバリデーション手順を記載し、各手順は実際にシェルで実行可能な形式にする
  - 根拠: Effect-TS/effect の AGENTS.md は `pnpm lint-fix`、`pnpm check`、`pnpm test run <file>` 等の具体的コマンドを列挙し、AI が解釈なしに実行できるようにしている

- `[MUST]` 自動生成ファイルを明示し、手動編集禁止と再生成コマンドをセットで記述する
  - 根拠: barrel file（`index.ts`）が自動生成であることを明記し、`pnpm codegen` を案内することで AI による意図しない編集を防止している

- `[MUST]` AI がコードを試行するための git 追跡外のサンドボックスディレクトリを用意し、使い終わったら削除する旨を指示に含める
  - 根拠: scratchpad/ は workspace に含まれつつ `.gitignore` と changeset の ignore でリリースから隔離され、安全な実験環境として機能している

- `[SHOULD]` AGENTS.md の冒頭でリポジトリの性質を1行で宣言し、AI が文脈を誤解するリスクを下げる
  - 根拠: "This is the Effect library repository, focusing on functional programming patterns and effect systems in TypeScript." の1行でドメインを限定している

- `[SHOULD]` コードスタイルは「既存コードを見て学べ」と指示し、フォーマッタに任せられる部分は「完璧にしようとするな」と明示する
  - 根拠: AGENTS.md で "Always look at existing code" と "Do not worry about getting code formatting perfect" の両方を記述し、AI の行動を効率的に制御している

- `[SHOULD]` テストフレームワークのカスタムパターン（it.effect 等）がある場合、インポート元・使用パターン・禁止事項をセットで記述する
  - 根拠: `it.effect` パターンの記述では import 元、使用形式、vitest の `expect` の禁止を明示し、AI が標準パターンに回帰することを防止している

- `[SHOULD]` バリデーション手順にはエラー時のリカバリ手順を含め、AI がエラーループに陥ることを防ぐ
  - 根拠: `pnpm check` の失敗時に `pnpm clean` を実行するリカバリ手順を記載している

- `[SHOULD]` AI に参照させたい外部知識（次期バージョンのコード等）がある場合、gitignore 対象のローカルディレクトリにクローンし、AGENTS.md からパスを参照する
  - 根拠: `.repos/effect-v4` パターンにより、リリース前の知識をリポジトリサイズを増やさずに AI に提供している

- `[AVOID]` AGENTS.md に曖昧な品質基準（「きれいなコードを書け」「適切にテストせよ」等）を書くこと。機械的に検証不可能な指示は AI の行動を制御できない
  - 根拠: Effect-TS/effect の AGENTS.md には主観的な品質基準が一切なく、すべての指示がコマンド実行・具体的パターン・禁止事項の形式で記述されている

- `[AVOID]` CI でのみ実行されるチェックを AGENTS.md から省略すること。AI がローカルで検出できない問題を導入するリスクがある
  - 根拠: `pnpm circular` は CI に存在するが AGENTS.md に未記載であり、循環依存の導入を AI がローカルで検出できないギャップがある

## 適用チェックリスト

- [ ] AGENTS.md（または CLAUDE.md 等）にリポジトリの概要を1行で記述しているか
- [ ] バリデーション手順がシェルで実行可能なコマンド形式で列挙されているか
- [ ] 自動生成ファイルの一覧と再生成コマンドが明示されているか
- [ ] AI 用のサンドボックスディレクトリ（scratchpad 等）が用意され、gitignore・リリース除外の設定がされているか
- [ ] テストフレームワーク固有のパターンがある場合、インポート元・使用形式・禁止事項が記述されているか
- [ ] コードスタイルに関してフォーマッタ委譲の方針が明示されているか
- [ ] エラー時のリカバリ手順（キャッシュクリア等）が記載されているか
- [ ] CI のチェック項目と AGENTS.md のバリデーション手順が一致しているか確認したか
- [ ] AI に参照させたい外部知識がある場合、gitignore 対象のローカルディレクトリを経由する仕組みを構築しているか
