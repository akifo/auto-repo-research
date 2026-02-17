# dev-conventions

> リポジトリ: vitejs/vite
> 分析日: 2026-02-17

## 概要

Vite リポジトリにおける ESLint 設定・コミット規約・lint-staged・コードスタイル統一の仕組みを分析した。78k スターを擁するモノレポで、Prettier + ESLint + simple-git-hooks + lint-staged の組み合わせにより「コントリビューターがスタイルを意識せずに済む」自動化パイプラインを構築している。特に注目すべきは、ESLint の**レイヤード構成**（パッケージ・ディレクトリの種別ごとにルールを段階的に緩和する設計）と、**セマンティック PR タイトル**の CI 自動検証による changelog 自動生成パイプラインである。

## 背景にある原則

- **フォーマットの議論を排除する**: Prettier でフォーマットを完全自動化し、コードレビューでスタイルに時間を費やさない。CONTRIBUTING.md で「No need to worry about code style as long as you have installed the dev dependencies」と明言しており、コントリビューターの認知負荷を下げることを最優先としている（`CONTRIBUTING.md:251`）
- **コンテキスト依存でルールの厳格度を変える**: プロダクションコード・テスト・playground・テンプレートなど、コードの役割ごとに ESLint ルールの厳格度を段階的に調整する。全体に一律のルールを適用するのではなく、各コンテキストに適した制約レベルを設定する（`eslint.config.js:192-378`）
- **自動化ゲートで人間のミスを防ぐ**: pre-commit フック（lint-staged）でローカル、CI で PR タイトル検証・lint・format チェック・typecheck を自動実行し、手動レビューでは設計・ロジックに集中する（`package.json:77-92`, `.github/workflows/ci.yml:240-247`）
- **大規模スタイル変更の git blame 汚染を管理する**: `.git-blame-ignore-revs` ファイルで Prettier trailing comma 導入時のコミットを除外し、`git blame` の有用性を維持している（`.git-blame-ignore-revs:1-4`）

## 実例と分析

### レイヤード ESLint 構成

Vite の `eslint.config.js` は flat config を活用し、named config ブロックを積み上げる構成を採る。ベースルール → パッケージ固有ルール → ディレクトリ種別ごとの disable、という3段構造になっている。

1. **ベース層**（`main`）: TypeScript 推奨ルール + import 順序 + Node.js バージョン互換チェック + regexp 最適化
2. **パッケージ固有層**: `packages/vite/src/node/` では `no-console: error`、`no-restricted-globals` で `require`/`__dirname`/`__filename` を禁止
3. **disable 層**: playground / テスト / .d.ts / .js ファイルでは不要なルールを段階的にオフ

```typescript
// eslint.config.js:192-199 -- パッケージ内では CJS グローバルを禁止
{
  name: 'vite/globals',
  files: ['packages/**/*.?([cm])[jt]s?(x)'],
  ignores: ['**/__tests__/**'],
  rules: {
    'no-restricted-globals': ['error', 'require', '__dirname', '__filename'],
  },
},
```

```typescript
// eslint.config.js:201-216 -- Node 側では console.log を禁止し devDeps の require も禁止
{
  name: 'vite/node',
  files: ['packages/vite/src/node/**/*.?([cm])[jt]s?(x)'],
  rules: {
    'no-console': ['error'],
    'n/no-restricted-require': [
      'error',
      Object.keys(pkgVite.devDependencies).map((d) => ({
        name: d,
        message:
          `devDependencies can only be imported using ESM syntax so ` +
          `that they are included in the rolldown bundle. ...`,
      })),
    ],
  },
},
```

この構成により、`packages/vite/src/node/logger.ts` だけが `/* eslint no-console: 0 */` で console アクセスを許可され、他の全ファイルでは ESLint が console 使用を検出する。意図的な例外は inline disable + 理由コメントで管理される（例: `eslint-disable-next-line no-console -- logger cannot be used here`）。

### import 順序の二重制御

`import-x/order` と `sort-imports` を組み合わせて、宣言レベルの並び順と named export のアルファベット順を分離して制御している。

```typescript
// eslint.config.js:165-184
'import-x/order': ['error', {
  groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
}],
'sort-imports': ['error', {
  ignoreDeclarationSort: true, // 宣言順は import-x/order に委ねる
}],
```

`import-x/order` が `import` 文同士の並び順（builtin → external → ...）を決め、`sort-imports` は `import { A, B, C }` 内のメンバーのアルファベット順を強制する。`ignoreDeclarationSort: true` により両者の責務が衝突しない。

### Type Import の強制

`consistent-type-imports` ルールにより、型のみの import は必ず `import type` または `import { type ... }` で記述する。

```typescript
// packages/vite/src/node/build.ts:3-25 -- type import と value import の分離例
import type {
  ExternalOption,
  InputOption,
  // ...
} from 'rolldown'

// packages/vite/src/node/config.ts:11-17 -- inline type import の例
import {
  type NormalizedOutputOptions,
  type OutputChunk,
  type PluginContextMeta,
  type RolldownOptions,
  rolldown,
} from 'rolldown'
```

### pre-commit フックと lint-staged の構成

`simple-git-hooks` + `lint-staged` で、コミット時に最小限のチェックを高速に実行する。

```json
// package.json:77-92
"simple-git-hooks": {
  "pre-commit": "pnpm exec lint-staged --concurrent false"
},
"lint-staged": {
  "*": ["prettier --write --cache --ignore-unknown"],
  "packages/*/{src,types}/**/*.ts": ["eslint --cache --fix"],
  "packages/**/*.d.ts": ["eslint --cache --fix"],
  "playground/**/__tests__/**/*.ts": ["eslint --cache --fix"]
}
```

設計上の特徴:
- **全ファイルに Prettier**: `*` パターンで言語を問わず自動フォーマット（`--ignore-unknown` で未対応ファイルをスキップ）
- **ESLint は限定範囲**: パッケージソース + 型定義 + テストのみ。playground のアプリケーションコードは ESLint の対象外（意図的に緩い）
- **`--concurrent false`**: Prettier と ESLint の順序衝突を回避
- **`--cache`**: Prettier / ESLint 両方でキャッシュを活用し、変更ファイルのみを処理

### コミット規約と PR タイトル検証

Angular 由来の Conventional Commits を採用し、`semantic-pull-request` GitHub Action で PR タイトルを自動検証する。

```
// .github/commit-convention.md:11
/^(revert: )?(feat|fix|docs|style|refactor|perf|test|build|ci|chore)(\(.+\))?!?: .{1,50}/
```

```yaml
# .github/workflows/semantic-pull-request.yml:20-26
- name: Validate PR title
  uses: amannn/action-semantic-pull-request@... # v6
  with:
    subjectPattern: ^(?![A-Z]).+$
    subjectPatternError: |
      The subject "{subject}" found in the pull request title "{title}"
      didn't match the configured pattern. Please ensure that the subject
      doesn't start with an uppercase character.
```

「Squash and Merge」前提のため、PR タイトルがそのままコミットメッセージとなり、changelog の自動生成につながる。

### CI でのフォーマット検証

CI の lint ジョブでは `prettier --check` ではなく `prettier --write && git diff --exit-code` を使用している。

```yaml
# .github/workflows/ci.yml:244
- name: Check formatting
  run: pnpm prettier --write --log-level=warn . && git diff --exit-code
```

`--check` ではなく `--write` 後に `git diff` する方式は、Prettier のバージョン差異による false positive を回避し、実際のフォーマット結果の差分を直接検出する。

### パッケージマネージャの強制

```json
// package.json:21
"preinstall": "npx only-allow pnpm"
```

`packageManager` フィールド（`pnpm@10.29.2`）と `preinstall` スクリプトの二重ガードで、npm / yarn の誤使用を防止する。

## Good Patterns

- **Named config ブロックによる ESLint レイヤリング**: 各設定ブロックに `name` を付与し（例: `'vite/globals'`, `'disables/playground'`）、ルールの適用範囲を明確に文書化する。`eslint --inspect-config` でどのルールがどのファイルに適用されるか追跡可能になる

```typescript
// eslint.config.js:193 -- 名前付きブロック
{ name: 'vite/globals', files: [...], rules: {...} },
{ name: 'disables/playground', files: [...], rules: {...} },
```

- **eslint-disable コメントへの理由付記**: 単に `eslint-disable-next-line` とするのではなく、なぜ例外が必要かをコメントで明示する

```typescript
// packages/vite/src/node/plugins/esbuild.ts:90
// eslint-disable-next-line no-console -- logger cannot be used here
console.warn(...)
```

- **`no-console` + Logger パターン**: プロダクションコードでは `no-console: error` で console 直接使用を禁止し、専用の Logger モジュール（`logger.ts`）を唯一の出力チャネルとする。logger.ts のみファイルレベルで `/* eslint no-console: 0 */` を宣言

```typescript
// packages/vite/src/node/logger.ts:1
/* eslint no-console: 0 */
```

- **devDependencies の `require()` 禁止と `await import()` への誘導**: ESLint カスタムルールで devDependencies の `require()` を検出し、エラーメッセージ内でバンドルに含めるための正しいパターンを案内する

```typescript
// eslint.config.js:206-213
'n/no-restricted-require': ['error',
  Object.keys(pkgVite.devDependencies).map((d) => ({
    name: d,
    message: `devDependencies can only be imported using ESM syntax so that they are
      included in the rolldown bundle. ...use (await import('dependency')).default instead.`,
  })),
],
```

## Anti-Patterns / 注意点

- **全ファイル一律の ESLint ルール適用**: テスト・playground・テンプレートに本番コード同等の厳格なルールを適用すると、不要な `eslint-disable` が散在し、ルールの形骸化を招く

```typescript
// Bad: テストでも no-console を強制
// → 大量の eslint-disable コメントが必要になる

// Better: Vite のようにファイルグロブで段階的に緩和
{ name: 'disables/test', files: ['**/__tests__/**'], rules: { 'no-console': 'off' } }
```

- **Prettier と ESLint のフォーマットルール競合**: ESLint にフォーマット関連ルール（`semi`, `indent` 等）を持たせると Prettier と衝突する

```typescript
// Bad: ESLint でもフォーマットを制御
rules: { semi: 'error', indent: ['error', 2] }

// Better: Vite のように Prettier 競合ルールを明示的にオフ
'no-extra-semi': 'off',
'@typescript-eslint/no-extra-semi': 'off', // conflicts with prettier
```

- **lint-staged で全ファイルに ESLint を実行**: 変更されたファイルが多い場合に pre-commit が極端に遅くなる

```json
// Bad: 全 TS ファイルに ESLint
"*.ts": ["eslint --fix"]

// Better: Vite のようにソースコードのみに限定し、playground は対象外
"packages/*/{src,types}/**/*.ts": ["eslint --cache --fix"]
```

## 導出ルール

- `[MUST]` ESLint の `eslint-disable` コメントには禁止理由を添える（`-- reason` 形式）
  - 根拠: Vite では `// eslint-disable-next-line no-console -- logger cannot be used here` のように理由を必ず付記し、将来のメンテナが例外の妥当性を判断できるようにしている（`packages/vite/src/node/plugins/esbuild.ts:90`）
- `[MUST]` pre-commit フックの lint/format では `--cache` フラグを有効にし、変更ファイルのみを処理する
  - 根拠: Vite の lint-staged 設定では Prettier・ESLint 両方に `--cache` を指定し、モノレポ規模でも pre-commit を高速に保っている（`package.json:80-91`）
- `[SHOULD]` ESLint の flat config で名前付きブロック（`name` プロパティ）を使い、ルールの適用範囲ごとにレイヤーを分離する
  - 根拠: Vite は `'vite/globals'`, `'vite/node'`, `'disables/playground'` 等の命名規則で 15+ のブロックを管理し、どのルールがどの範囲に適用されるかを一目で把握可能にしている（`eslint.config.js:193-378`）
- `[SHOULD]` プロダクションコードでは `console.*` を ESLint で禁止し、ロギングを専用の Logger モジュールに集約する
  - 根拠: Vite は `no-console: error` で console 直接使用を禁止し、`logger.ts` に集約することで出力レベル制御・フォーマット統一を実現している（`eslint.config.js:204`, `packages/vite/src/node/logger.ts:1`）
- `[SHOULD]` CI のフォーマットチェックは `--check` ではなく `--write && git diff --exit-code` パターンを使う
  - 根拠: Vite の CI では `prettier --write . && git diff --exit-code` を採用し、フォーマッタのバージョン差異による不整合を実差分で検出している（`.github/workflows/ci.yml:244`）
- `[SHOULD]` import 順序の制御は「宣言順（`import-x/order`）」と「メンバー順（`sort-imports`）」を分離し、責務を衝突させない
  - 根拠: Vite では `import-x/order` に `groups` を設定しつつ、`sort-imports` は `ignoreDeclarationSort: true` で宣言順を無視させ、二つのルールが協調動作している（`eslint.config.js:166-184`）
- `[AVOID]` テスト・playground・テンプレートコードに本番コード同等の ESLint 厳格度を適用する
  - 根拠: Vite は playground に対して `explicit-module-boundary-types`, `no-unused-vars`, `no-undef` 等を全て `off` にし、E2E テスト用コードの記述容易性を優先している（`eslint.config.js:306-323`）

## 適用チェックリスト

- [ ] ESLint の flat config で名前付きブロック（`name`）を使い、プロダクション / テスト / 設定ファイルでルールレイヤーを分けているか
- [ ] Prettier とフォーマッティング関連の ESLint ルールが競合していないか（`no-extra-semi`, `indent` 等がオフになっているか）
- [ ] `consistent-type-imports` で `import type` を強制し、バンドルサイズの最小化と意図の明示化を実現しているか
- [ ] lint-staged の対象がプロダクションコードに限定されており、playground / fixtures が除外されているか
- [ ] pre-commit フックの Prettier / ESLint に `--cache` フラグが付いているか
- [ ] `eslint-disable` コメントに理由が付記されているか（`-- reason` 形式）
- [ ] プロダクションコードで `console.*` が禁止され、専用 Logger に集約されているか
- [ ] コミット規約（Conventional Commits）が CI で自動検証されているか
- [ ] `.git-blame-ignore-revs` で大規模フォーマット変更のコミットが除外されているか
- [ ] パッケージマネージャの誤使用防止（`preinstall` + `only-allow`）が設定されているか
