# dev-conventions

> リポジトリ: mastra-ai/mastra
> 分析日: 2026-02-14

## 概要

mastra-ai/mastra のコーディング規約・リンター設定・Changesets 運用・コミット規約を横断的に分析した。80以上のパッケージを持つ大規模 TypeScript モノレポにおいて、共有 ESLint 設定パッケージ（`@internal/lint`）、パッケージごとの lint-staged、カスタム Changeset CLI、AI コーディングアシスタント（Claude/Cursor）向けコマンド体系を組み合わせた多層的な品質統制が注目に値する。「人間の開発者」と「AI エージェント」の双方に同一の規約を一貫して適用する設計が独自性を持つ。

## 背景にある原則

- **設定の単一ソース化と分散適用**: ESLint・Prettier の設定を内部パッケージ (`@internal/lint`) に集約し、各パッケージは `createConfig()` をインポートした上でパッケージ固有の `ignores` を追加する。大規模モノレポではパッケージごとの設定ドリフトがメンテナンスコストの主要因になるため、一元管理しつつ柔軟なオーバーライドを許容すべき。根拠: `packages/_config/src/eslint.js` が全パッケージの共有ルール源、`packages/core/eslint.config.js` がインポート+上書きする構造。

- **段階的品質ゲートによる高速フィードバック**: pre-commit で変更ファイルのみ lint-staged（ESLint 自動修正 + Prettier）、CI で全体 lint・型チェック・テストという多層構造。ローカルでは変更ファイルのみ高速にチェックし、CI で全体の整合性を担保する。全チェックを pre-commit に入れると開発速度が下がり、CI だけだとフィードバックが遅くなるため、コストと安全性のバランスを段階ごとに最適化すべき。根拠: `.husky/pre-commit` が `pnpm dlx lint-staged` のみ実行。

- **変更記録はユーザー視点で書く**: Changeset メッセージは開発者内部の実装詳細ではなく、エンドユーザーにとっての影響と成果を記述する。行動動詞（Added, Fixed, Improved）で書き、breaking change や新機能にはコード例（before/after）を必須とする。根拠: `.claude/commands/changeset.md` の「Highlight outcomes! What does change for the end user?」「ensure that a code example is provided」。

- **AI エージェントも人間と同じ規約に従う**: Claude Code / Cursor のコマンド定義で conventional commits、changeset メッセージガイドライン、ドキュメント文体規約を明文化し、AI が生成するコード・コミット・PR も同じ品質基準に準拠させる。根拠: `.claude/commands/` と `.cursor/commands/` に同一の changeset/commit/pr ガイドラインが重複配置されている。

## 実例と分析

### 共有 ESLint 設定の設計

`@internal/lint` パッケージ (`packages/_config`) は epicweb-dev/config から着想を得た ESLint 設定を提供する。`import.meta.resolve` で依存パッケージの存在を検出し、React・TypeScript・Vitest・Testing Library の設定を動的に切り替える。

```javascript
// packages/_config/src/eslint.js:7-19
const has = pkg => {
  try {
    import.meta.resolve(pkg, import.meta.url);
    return true;
  } catch {
    return false;
  }
};

const hasTypeScript = has('typescript');
const hasReact = has('react');
const hasTestingLibrary = has('@testing-library/dom');
const hasVitest = has('vitest');
```

各パッケージの `eslint.config.js` は極めてシンプルで、必要な場合のみ上書きを追加する。

```javascript
// packages/core/eslint.config.js:1-11
import { createConfig } from '@internal/lint/eslint';
const config = await createConfig();

export default [
  ...config,
  {
    ignores: ['./*.d.ts', '**/*.d.ts', '!src/**/*.d.ts', '**/test-utils/**'],
  },
];
```

### TypeScript ルールの意図的な取捨選択

ESLint 設定のコメントには、無効にしたルールとその理由が詳細に記録されている。

```javascript
// packages/_config/src/eslint.js:191-199
// @typescript-eslint/require-await - sometimes you really do want
// async without await to make a function async. TypeScript will ensure
// it's treated as an async function by consumers and that's enough for me.

// @typescript-eslint/no-non-null-assertion - normally you should not
// use ! to tell TS to ignore the null case, but you're a responsible
// adult and if you're going to do that, the linter shouldn't yell at
// you about it.
```

有効にしたルールでは、TypeScript の型安全性を重視する。

```javascript
// packages/_config/src/eslint.js:162-175
'@typescript-eslint/consistent-type-imports': [
  ERROR,
  {
    prefer: 'type-imports',
    disallowTypeAnnotations: true,
    fixStyle: 'separate-type-imports',
  },
],
'@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
'@typescript-eslint/no-floating-promises': 'error',
```

`consistent-type-imports` + `separate-type-imports` で型インポートを物理的に分離し、tree-shaking 効率を向上。`no-floating-promises` で Promise のハンドリング漏れを防ぐ。`checksVoidReturn: false` はイベントハンドラ等で async 関数を void コンテキストに渡すことを許容する実用的な判断。

`@ts-ignore` は禁止、`@ts-expect-error` は最低3文字の説明付きで許可する。

```javascript
// packages/_config/src/eslint.js:176-185
'@typescript-eslint/ban-ts-comment': [
  ERROR,
  {
    'ts-expect-error': 'allow-with-description',
    'ts-ignore': true,
    'ts-nocheck': true,
    'ts-check': false,
    minimumDescriptionLength: 3,
  },
],
```

### FIXME コメント禁止と console 制限

```javascript
// packages/_config/src/eslint.js:53
'no-warning-comments': [ERROR, { terms: ['FIXME'], location: 'anywhere' }],

// packages/_config/src/eslint.js:72
'no-console': [ERROR, { allow: ['warn', 'error', 'info', 'table', 'time', 'timeEnd', 'dir'] }],
```

`FIXME` をエラーにして未解決の問題がコードに残り続けることを防ぎ、`TODO` は許容して計画的な改善を記録可能にする。実測値: `packages/core/src` 内の FIXME は 0 件、TODO は 20 件。`console.log`/`console.debug` は禁止だが、意図を明示するメソッド（`warn`/`error`/`info`）は許可。テストファイルではこの制限を解除。

### lint-staged の統一パターン

```javascript
// packages/core/lint-staged.config.js
export default {
  '*.{ts,tsx}': ['eslint --fix --max-warnings=0', 'prettier --write'],
  '*.{js,jsx}': ['eslint --fix', 'prettier --write'],
  '*.{json,md,yml,yaml}': ['prettier --write'],
};
```

TypeScript ファイルには `--max-warnings=0` を適用し、warning の蓄積を一切許容しない。JavaScript ファイルには max-warnings を設定しない（設定ファイル等に対する寛容さ）。ドキュメント (`docs/`) は ESLint を適用せず Prettier のみ。

### カスタム Changeset CLI と運用

標準の `@changesets/cli` をラップしたカスタム CLI (`packages/_changeset-cli`) が 3 つの課題を解決する。

1. **変更パッケージの自動検出**: `git diff` ベースで `origin/main` からの変更パッケージを自動検出
2. **ピア依存関係の自動更新**: コアパッケージのバージョンバンプ時に依存パッケージの peerDependencies レンジを自動更新
3. **AI エージェント向け非対話モード**: `--skipPrompt` フラグで完全自動化

```bash
# AI エージェントが非対話的に changeset を作成
pnpm changeset -s -m "Fixed a bug where ..." --patch @mastra/core
```

`fixed` グループにより密結合パッケージは常に同一バージョンでリリースされる。

```json
// .changeset/config.json:8
"fixed": [
  ["@mastra/core", "@mastra/server", "@mastra/deployer", "@mastra/deployer-cloud"],
  ["mastra", "create-mastra", "@internal/playground"]
]
```

changeset メッセージの実例は高品質で、ガイドラインに準拠している。

```markdown
<!-- .changeset/proud-pandas-nail.md -->
---
'@mastra/core': minor
---

Added typed workspace providers — `workspace.filesystem` and `workspace.sandbox`
now return the concrete types you passed to the constructor, improving autocomplete
and eliminating casts.

**Before:**
workspace.filesystem; // WorkspaceFilesystem | undefined

**After:**
workspace.filesystem; // LocalFilesystem
```

### AI アシスタント向けコマンド体系

`.claude/commands/` と `.cursor/commands/` に同一のコマンドセットが定義されている。

**コミット規約** (`.claude/commands/commit.md`):
- Conventional commits 必須
- タイトルに変更概要、本文に詳細と理由
- コミット後に push

**PR 規約** (`.claude/commands/pr.md`):
- changeset 作成 → PR オープンの二段階ワークフロー
- PR タイトルは conventional commits 形式 (`fix: title` / `feat(pkg-name): title`)
- PR 本文は「簡潔で謙虚、花言葉なし」、リスト・見出し不要

**PR レビュー対応** (`.claude/commands/gh-pr-comments.md`):
- CodeRabbit コメントへの対応フロー定型化
- AI のコメントは「Claude says:」で開始
- 修正ごとに個別コミット（コメントリンク付き）

**gh-fix-lint** (`.claude/commands/gh-fix-lint.md`):
- 外部コントリビューターの PR ブランチにリント修正を適用する運用フロー
- フォークへのプッシュまで自動化

### ドキュメント文体規約

```
// .cursor/rules/writing-documentation.mdc
1. マーケティング言語禁止: "powerful", "built-in", "production-ready", "makes it easy"
2. 曖昧な表現禁止: "your needs", "choose the right...solution"
3. 熱狂的な勧誘禁止: "Check out", "Learn more", "Explore"
5. 詳細に踏み込まない滑る文章を避ける: "This makes it easy to build..."
6. H1 見出しはタイトルケース必須
```

CLAUDE.md でもこの規約を参照しており、AI が生成するドキュメントのトーンを一貫して技術文書として制御している。

### パッケージマネージャの強制

```json
// package.json
"preinstall": "npx only-allow pnpm",
"engines": { "pnpm": ">=10.18.0" },
"packageManager": "pnpm@10.27.0"
```

`corepack enable` による自動バージョン管理を前提とし、pnpm `catalog:` でツールバージョン（vitest, typescript）をワークスペースレベルで一元管理する。

## パターンカタログ

- **Shared Kernel パターン** (分類: 構造)
  - 解決する問題: モノレポ内の設定重複と一貫性維持
  - 適用条件: 10以上のパッケージが同一の lint/format ルールを共有する場合
  - コード例: `packages/_config/src/eslint.js:1-303`
  - 注意点: 共有設定の変更は全パッケージに波及するため、変更時は慎重にテストが必要

- **Feature Detection パターン** (分類: 振る舞い)
  - 解決する問題: 依存関係の有無に応じた設定の条件的適用
  - 適用条件: 異なる技術スタック（React/非React）のパッケージが混在するモノレポ
  - コード例: `packages/_config/src/eslint.js:7-14`
  - 注意点: 検出失敗はサイレントに機能を無効化するため、期待する検出結果のテストが推奨

## Good Patterns

- **依存検出による条件付きリント設定**: `import.meta.resolve` でパッケージの存在を検出し、React/Testing Library/Vitest の ESLint ルールを動的に切り替える。1 つの共有設定で異種パッケージすべてに対応でき、パッケージごとの設定ファイルを最小限に抑える。

```javascript
// packages/_config/src/eslint.js:7-14
const has = pkg => {
  try {
    import.meta.resolve(pkg, import.meta.url);
    return true;
  } catch {
    return false;
  }
};
```

- **Changeset メッセージのユーザー視点記述**: changeset メッセージを「エンドユーザーにとって何が変わるか」で記述し、breaking change には before/after コード例を必須とする。CHANGELOG が自動的にユーザー向けドキュメントとして機能する。

- **AI エージェントと人間の規約統一**: `.claude/commands/` と `.cursor/commands/` に同一のガイドラインを配置。コマンド名（changeset, commit, pr）が直感的で、AI ワークフローへの統合が容易。

```markdown
<!-- .claude/commands/pr.md (抜粋) -->
Add a descriptive/concise title, use conventional commits in the title
(e.g. "fix: title here" or "feat(pkg-name): title here").
Add a concise, humble PR description without flowery or overly verbose language.
```

- **FIXME/TODO の意味的区別**: `FIXME` を ESLint エラーとして禁止し「デプロイ前に解決すべき問題」に限定、`TODO` は許容して「将来の改善」として残す。コメントの意味を型のように強制する。

- **無効ルールの理由記録**: ESLint 設定で無効にしたルールとその理由を詳細にコメントしており、将来の再評価や新メンバーの理解を助ける。

## Anti-Patterns / 注意点

- **lint-staged 設定の全パッケージ複製**: 80 以上のパッケージに同一内容の `lint-staged.config.js` が存在する。ルートに 1 つの設定を置くか、共有パッケージからインポートする構成が望ましい。ただし docs パッケージのように ESLint を外すケースがあるため、完全な統一は難しい。

```javascript
// Bad: 80+ 箇所に同一内容を複製
// packages/core/lint-staged.config.js
// stores/pg/lint-staged.config.js
// ... すべて同じ内容

// Better: 共有パッケージからインポート
import { defaultConfig } from '@internal/lint/lint-staged';
export default defaultConfig;
```

- **@ts-expect-error の説明が症状止まり**: `minimumDescriptionLength: 3` を設定して説明を要求しているが、根本原因ではなく症状を記述するケースが散見される。

```typescript
// Bad: 症状だけ記述
// @ts-expect-error - zod types mismatch between v3 and v4
inputData: workflow.inputSchema ?? z.object({}).passthrough(),

// Better: 根本原因と解決条件を記述
// @ts-expect-error - Zod v3/v4 の ZodSchema 型は互換性がないがランタイムでは動作する。
// schema-compat パッケージで型統一後に削除予定。
inputData: workflow.inputSchema ?? z.object({}).passthrough(),
```

## 導出ルール

- `[MUST]` モノレポのリンター設定は内部パッケージとして集約し、各パッケージは 1 行のインポートで取り込む
  - 根拠: mastra は `@internal/lint` で 80 以上のパッケージの ESLint 設定を一元管理している (`packages/_config/src/eslint.js`)

- `[MUST]` TypeScript プロジェクトでは `no-floating-promises` と `consistent-type-imports` を有効にする
  - 根拠: Promise ハンドリング漏れの防止と型インポートの分離を ESLint でエラーレベルで強制し、ランタイムバグと不要なバンドルを防いでいる (`packages/_config/src/eslint.js:162-175`)

- `[MUST]` pre-commit フックで lint + format を自動実行し、TypeScript ファイルは `--max-warnings=0` で警告ゼロを強制する
  - 根拠: `.husky/pre-commit` が lint-staged を実行し、全パッケージの lint-staged 設定が `eslint --fix --max-warnings=0` を TS ファイルに適用

- `[MUST]` changeset メッセージはエンドユーザー視点で記述し、breaking change・新機能にはコード例（before/after）を含める
  - 根拠: `.claude/commands/changeset.md` が「Highlight outcomes!」「ensure that a code example is provided」と明記

- `[SHOULD]` AI コーディングアシスタント向けのコマンド定義を作成し、人間と同じコミット・PR・changeset 規約を AI にも適用する
  - 根拠: `.claude/commands/` と `.cursor/commands/` に同一のガイドラインが配置され、AI エージェントのワークフローに規約を組み込んでいる

- `[SHOULD]` 共有リント設定は依存パッケージの存在を動的検出し、フレームワーク固有ルールを条件付きで適用する
  - 根拠: `import.meta.resolve` で React/Vitest 等の存在を検出し、1 つの設定で異種パッケージに対応 (`packages/_config/src/eslint.js:7-19`)

- `[SHOULD]` リンターで無効にしたルールには、無効にした理由をコメントで記録する
  - 根拠: ESLint 設定に無効にした各ルールの理由が詳細にコメントされている (`packages/_config/src/eslint.js:186-241`)

- `[SHOULD]` 密結合パッケージは changeset の `fixed` グループで同一バージョンリリースを保証する
  - 根拠: core/server/deployer を固定グループにし、ピア依存関係のレンジも自動更新 (`.changeset/config.json:8`)

- `[SHOULD]` パッケージマネージャとバージョンを `preinstall` スクリプト・`engines`・`packageManager` フィールドで三重に強制する
  - 根拠: `"preinstall": "npx only-allow pnpm"` + `"engines"` + `"packageManager": "pnpm@10.27.0"` の組み合わせ

- `[AVOID]` FIXME コメントをコードベースに残す（TODO は許容するが FIXME はエラーとして扱う）
  - 根拠: `no-warning-comments` で FIXME をエラーレベルに設定し、緊急の未解決問題がコミットされることを構造的に防止 (`packages/_config/src/eslint.js:53`)

- `[AVOID]` `console.log` をプロダクションコードで使用する（`console.warn`/`error`/`info` を意図に応じて使い分ける）
  - 根拠: `no-console` が `log`/`debug` を禁止し、意図を明示するメソッドのみ許容 (`packages/_config/src/eslint.js:72`)

- `[AVOID]` `@ts-expect-error` の説明に症状だけを書く（根本原因と解決条件も記述すべき）
  - 根拠: `packages/core/src/agent/agent.ts` で「zod types mismatch」のように症状のみの記述が散見され、解消時期の情報が欠落

## 適用チェックリスト

- [ ] ESLint/Prettier の共有設定を内部パッケージとして切り出し、各パッケージからインポートする構成にする
- [ ] 共有 ESLint 設定に Feature Detection パターンを導入し、React/非React パッケージで自動的にルールを切り替える
- [ ] `@typescript-eslint/no-floating-promises` と `consistent-type-imports` (`separate-type-imports`) を有効にする
- [ ] `@typescript-eslint/ban-ts-comment` で `@ts-ignore` を禁止し、`@ts-expect-error` に最低説明文字数を設定する
- [ ] pre-commit フック（Husky + lint-staged）を導入し、TypeScript ファイルに `--max-warnings=0` を設定する
- [ ] `no-warning-comments` で `FIXME` をエラーにし、`TODO` は許容する運用ルールを導入する
- [ ] `no-console` で `log`/`debug` を禁止し、`warn`/`error`/`info` のみ許容する設定を追加する
- [ ] 無効にした ESLint ルールにその理由をコメントとして記録する
- [ ] Changesets を導入し、changeset メッセージのガイドライン（ユーザー視点、行動動詞、コード例必須）を策定する
- [ ] `preinstall` フックでパッケージマネージャを強制し、`packageManager` フィールドでバージョンを固定する
- [ ] AI コーディングアシスタント向けのコマンド定義を作成し、conventional commits・changeset・PR の規約を組み込む
- [ ] ドキュメント文体規約（マーケティング言語禁止、技術的詳細重視）を AI ルールに組み込む
