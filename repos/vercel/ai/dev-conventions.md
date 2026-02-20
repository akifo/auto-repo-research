# 開発規約と品質ゲート

> リポジトリ: vercel/ai
> 分析日: 2026-02-20

## 概要

vercel/ai は 50 以上のパッケージを含む大規模 monorepo であり、Prettier・ESLint・Husky/lint-staged・Changeset・CI ワークフローを組み合わせた多層的な品質ゲートを構築している。特に注目すべきは、semver を独自に再解釈した「patch のみ」バージョニング運用、pre-commit hook のバイパス機構（`ARTISANAL_MODE`）、auto-merge PR への自動 Prettier 修正ワークフロー、CI でのモジュールロード時間チェックといった、大規模 monorepo ならではの実践的な工夫である。

## 背景にある原則

- **フォーマットは議論の対象外にする**: Prettier を唯一のフォーマッタとし、lint-staged で全ファイルに適用することで、コードレビューでスタイルの議論が発生しない状態を作っている。ESLint は `eslint-config-prettier` を組み込み、フォーマットルールの衝突を排除している（`tools/eslint-config/index.js:3`）。
- **リリース粒度を意図的に制限する**: semver の minor/major をデフォルト禁止し patch のみに制限することで、頻繁かつ安全なリリースを実現している。major/minor は「マーケティングリリース」（ブログ記事・マイグレーションガイド付き）にのみ使うという独自運用（`.github/workflows/verify-changesets.yml:1-5` コメント参照）。
- **pre-commit は補助であり障壁にしない**: `ARTISANAL_MODE` 環境変数で hook を完全バイパスできる設計により、WIP コミットの速度を犠牲にしない。品質は CI で担保する二層構造にしている（`.husky/pre-commit:1-5`）。
- **共有設定をワークスペースパッケージとして管理する**: ESLint config（`eslint-config-vercel-ai`）と TypeScript config（`@vercel/ai-tsconfig`）を `tools/` ディレクトリの内部パッケージとして管理し、全パッケージから `workspace:*` で参照する。設定の一元管理と即座の反映を両立している。

## 実例と分析

### Prettier 設定の一元管理

Prettier 設定はルート `package.json` の `prettier` フィールドに直接記述されている。`.prettierrc` は例外的なパッケージ（`examples/nest`）にのみ存在し、大多数のパッケージはルート設定を継承する。

```jsonc
// package.json:66-83
"prettier": {
  "tabWidth": 2,
  "useTabs": false,
  "singleQuote": true,
  "arrowParens": "avoid",
  "trailingComma": "all",
  "plugins": ["prettier-plugin-svelte"],
  "overrides": [
    { "files": "*.svelte", "options": { "parser": "svelte" } }
  ]
}
```

`.prettierignore` でビルド成果物・テストフィクスチャを除外している。

```
// .prettierignore:1-7
.next
.nuxt
node_modules
dist
.svelte-kit
_nuxt
__testfixtures__
```

### ESLint の多段構成

ルート `.eslintrc.js` がワークスペースパッケージ `eslint-config-vercel-ai` を参照し、各パッケージの `.eslintrc.js` もこれを継承する。設定の実体は `tools/eslint-config/index.js` にある。

```js
// tools/eslint-config/index.js:1-11
module.exports = {
  extends: ["next", "turbo", "prettier"],
  rules: {
    "@next/next/no-html-link-for-pages": "off",
  },
  parserOptions: {
    babelOptions: {
      presets: [require.resolve("next/babel")],
    },
  },
};
```

ポイントは `prettier` を extends の最後に配置し、ESLint のフォーマット系ルールを確実に無効化していること。これにより Prettier と ESLint の競合が発生しない。

### lint-staged とワイルドカード設定

lint-staged の設定は非常にシンプルで、全ファイル（`*`）に対して `prettier --ignore-unknown --write` を実行する。

```jsonc
// package.json:26-29
"lint-staged": {
  "*": ["prettier --ignore-unknown --write"]
}
```

`--ignore-unknown` フラグにより、Prettier がサポートしないファイル形式（画像・バイナリ等）でもエラーにならない。これにより、glob パターンの管理が不要になる。

### pre-commit hook の設計

`.husky/pre-commit` は 3 つの責務を持つ。

```bash
// .husky/pre-commit:1-17
# Skip all checks if ARTISANAL_MODE is set
if [ -n "$ARTISANAL_MODE" ]; then
  echo "ARTISANAL_MODE is set, skipping pre-commit hooks"
  exit 0
fi

# Run pnpm install if any package.json files are staged.
if git diff --cached --name-only | grep -q 'package\.json$'; then
  echo "package.json changes detected, running pnpm install..."
  pnpm install
  git add pnpm-lock.yaml
fi

pnpm lint-staged
```

1. `ARTISANAL_MODE` によるバイパス
2. `package.json` 変更時の自動 `pnpm install` + lockfile 更新
3. `lint-staged` 実行

特に 2 は lint-staged 経由にすると package.json の数だけ `pnpm install` が走る問題を回避するために、pre-commit hook のレベルで一度だけ実行している（コメントに理由が記載されている）。

### Changeset 運用と独自バージョニング

changeset config は最小限の設定で、`access: "public"`、`baseBranch: "main"` のみ。

```jsonc
// .changeset/config.json:1-10
{
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "fixed": [],
  "linked": [],
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
}
```

patch 以外を CI で強制拒否する独自の verify-changesets ワークフローが存在する。`minor` / `major` ラベルを PR に付与することでバイパス可能。

```js
// .github/workflows/actions/verify-changesets/index.js:123-135
const invalidVersionBumps = Object.entries(versionBumps).filter(
  ([, versionBump]) => versionBump !== "patch",
);

if (invalidVersionBumps.length > 0) {
  throw Object.assign(
    new Error(
      `Invalid .changeset file - invalid version bump (only "patch" is allowed, ...)`,
    ),
    { path, content },
  );
}
```

examples パッケージの changeset は `cleanup-examples-changesets.mjs` で自動クリーンアップされ、version を `0.0.0` にリセットし CHANGELOG.md を削除する。

### CI パイプラインの多層品質チェック

`.github/workflows/ci.yml` は以下のジョブを並列実行する。

| ジョブ             | 内容                                                 |
| ------------------ | ---------------------------------------------------- |
| `prettier`         | `pnpm prettier-check`                                |
| `eslint`           | `pnpm lint`（Turbo 経由で全パッケージ）              |
| `types`            | `tsc --build tsconfig.with-examples.json`            |
| `bundle-size`      | `ai` パッケージのバンドルサイズ上限チェック（560KB） |
| `test_matrix`      | Node 20/22 マトリクスでテスト実行                    |
| `load-time_matrix` | パッケージ別モジュールロード時間チェック             |

バンドルサイズとロード時間のチェックは、SDK として読み込み速度がユーザー体験に直結するための対策である。

```yaml
# .github/workflows/ci.yml:197-206
matrix:
  include:
    - module: 'ai'
      max-load-time: 100
    - module: '@ai-sdk/openai'
      max-load-time: 65
    - module: '@ai-sdk/anthropic'
      max-load-time: 65
```

### ファイル命名規約

ソースファイルは一貫してケバブケースを使用する。

- 実装: `generate-text.ts`, `openai-provider.ts`, `smooth-stream.ts`
- テスト: `generate-text.test.ts`（実装ファイルと同階層に配置）
- 型テスト: `generate-text.test-d.ts`（vitest の `typecheck` で実行）
- スナップショット: `__snapshots__/` ディレクトリに配置

テストファイルは npm パッケージの `files` フィールドで明示的に除外される。

```jsonc
// packages/ai/package.json:12-22
"files": [
  "dist/**/*",
  "docs/**/*",
  "src",
  "!src/**/*.test.ts",
  "!src/**/*.test-d.ts",
  "!src/**/__snapshots__",
  "CHANGELOG.md",
  "internal.d.ts",
  "test.d.ts"
]
```

### TypeScript 共有設定

`tools/tsconfig/base.json` が全パッケージの基底設定となる。strict モードが有効で、`moduleResolution: "Bundler"` を採用している。

```jsonc
// tools/tsconfig/base.json:1-22
{
  "compilerOptions": {
    "composite": false,
    "declaration": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "types": ["@types/node"],
  },
}
```

各パッケージは `tsconfig.json`（composite: true、references 付き）と `tsconfig.build.json`（composite: false）の二重構成を持つ。これにより IDE の型解決（composite + references）とビルド（tsup、composite 不要）を両立している。

### パッケージバージョンの注入パターン

全パッケージで `version.ts` + tsup の `define` によるビルド時注入パターンを使用する。

```ts
// packages/ai/src/version.ts:1-5
declare const __PACKAGE_VERSION__: string | undefined;
export const VERSION: string = typeof __PACKAGE_VERSION__ !== "undefined"
  ? __PACKAGE_VERSION__
  : "0.0.0-test";
```

```ts
// packages/ai/tsup.config.ts:14-17
define: {
  __PACKAGE_VERSION__: JSON.stringify(
    (await import('./package.json', { with: { type: 'json' } })).default.version,
  ),
},
```

テスト時はフォールバック値 `'0.0.0-test'` が使われるため、バージョン依存のテストでも動作する。

### auto-merge PR への自動 Prettier 修正

`prettier-on-automerge.yml` は、auto-merge が有効な PR で Prettier チェックが失敗した場合に自動修正を行う。

```yaml
# .github/workflows/prettier-on-automerge.yml:22-31
if: |
  github.event_name == 'workflow_dispatch' ||
  github.event_name == 'pull_request_target' ||
  (github.event_name == 'check_run' &&
   github.event.check_run.name == 'Prettier' &&
   github.event.check_run.conclusion == 'failure' ...)
```

これにより Renovate などの bot PR がフォーマット違反で止まることを防いでいる。

### Renovate のスケジュール戦略

dependency 更新は頻度別に 4 段階のスケジュールに分けられている。

```jsonc
// .github/renovate.json5 (要約)
// Rule 1: packages/* の dependencies → 毎週金曜
// Rule 2: packages/* の devDependencies → 月初の金曜
// Rule 3: root/examples/tools の全依存 → 四半期初の金曜
// Rule 4: GitHub Actions → 月の第3金曜
```

プロダクション依存は頻繁に、開発依存は低頻度で更新する。全て金曜にまとめることで、週明けまでの CI 安定確認期間を確保している。

## Good Patterns

- **lint-staged のワイルドカード + `--ignore-unknown`**: glob パターンの管理が不要になり、新しいファイル形式を追加しても設定変更が不要。`"*": ["prettier --ignore-unknown --write"]` という最小設定で全ファイルをカバーする。

- **pre-commit の batched install**: `package.json` 変更検知を lint-staged ではなく pre-commit hook 自体で行い、`pnpm install` を一度だけ実行する。lint-staged 経由だとファイルごとに実行されてしまう問題を回避。

- **CI の Prettier auto-fix ワークフロー**: bot PR（Renovate 等）のフォーマット違反を自動修正するワークフローにより、人間の介入なしに auto-merge を進行させる。

- **tsconfig の二重構成（composite / non-composite）**: `tsconfig.json`（IDE・型チェック用、composite: true）と `tsconfig.build.json`（tsup ビルド用、composite: false）を分離し、両方の要件を満たす。

- **ビルド時定数注入 + テストフォールバック**: `__PACKAGE_VERSION__` を tsup の `define` でビルド時に注入し、`version.ts` で `'0.0.0-test'` にフォールバックする。テストとプロダクションの両方で動作する。

## Anti-Patterns / 注意点

- **changeset patch-only を CI 検証なしで運用する**: vercel/ai は専用の verify-changesets ワークフローで patch 制約を自動検証している。ドキュメントだけで制限すると、minor/major が意図せず混入しリリースが不安定になる。

  Bad:
  ```
  <!-- CONTRIBUTING.md に「patch のみ使用」と記載するだけ -->
  ```
  Better:
  ```js
  // CI で changeset の frontmatter を解析し、patch 以外を自動拒否する
  const invalidVersionBumps = Object.entries(versionBumps).filter(
    ([, versionBump]) => versionBump !== "patch",
  );
  if (invalidVersionBumps.length > 0) throw new Error("...");
  ```

- **pre-commit hook に全責任を負わせる**: hook はローカル環境依存で、`--no-verify` やバイパス機構で飛ばされる可能性がある。vercel/ai は hook をあくまで「早期フィードバック」と位置づけ、同じチェックを CI でも実行する二層構造にしている。

  Bad:
  ```bash
  # pre-commit で lint + test + format を全て実行
  pnpm lint && pnpm test && pnpm format
  ```
  Better:
  ```bash
  # pre-commit は高速なフォーマットのみ、lint/test は CI に委任
  pnpm lint-staged
  ```

## 導出ルール

- `[MUST]` フォーマッタとリンターの責務を分離し、ESLint config に `prettier`（eslint-config-prettier）を必ず含める
  - 根拠: vercel/ai は `extends: ['next', 'turbo', 'prettier']` で衝突を排除しており、50+ パッケージでフォーマット起因の CI 失敗がゼロになっている（`tools/eslint-config/index.js:3`）

- `[MUST]` monorepo の共有設定（ESLint config, tsconfig）はワークスペースパッケージとして管理し、`workspace:*` で参照する
  - 根拠: vercel/ai は `tools/eslint-config` と `tools/tsconfig` を 50+ パッケージ全てが参照しており、設定変更が即座に全パッケージに波及する

- `[SHOULD]` lint-staged は対象ファイルの glob を `*` にし、ツール側で `--ignore-unknown` を使う
  - 根拠: vercel/ai は `"*": ["prettier --ignore-unknown --write"]` で全ファイルを対象にし、ファイル形式追加時の設定漏れを排除している（`package.json:26-29`）

- `[SHOULD]` pre-commit hook にはバイパス機構を設け、品質保証は CI を信頼源とする二層構造にする
  - 根拠: vercel/ai は `ARTISANAL_MODE` 環境変数でバイパス可能にし、CI の prettier/eslint/test ジョブで同等チェックを実行している

- `[SHOULD]` changeset のバージョン制約はドキュメントだけでなく CI で機械的に検証する
  - 根拠: vercel/ai は `verify-changesets.yml` で changeset の frontmatter を解析し、patch 以外を自動拒否する仕組みを持つ

- `[SHOULD]` SDK・ライブラリ monorepo ではバンドルサイズとモジュールロード時間を CI で定量チェックする
  - 根拠: vercel/ai は `check-bundle-size.ts`（560KB 上限）と `load-time_matrix`（パッケージ別 65-100ms 上限）で性能劣化を防いでいる

- `[SHOULD]` パッケージバージョンはビルド時定数注入 + テストフォールバックパターンで管理する
  - 根拠: vercel/ai は全パッケージで `__PACKAGE_VERSION__` を tsup の define で注入し、`version.ts` で `'0.0.0-test'` にフォールバックする統一パターンを使用している

- `[AVOID]` lint-staged 内で `pnpm install` のような重い副作用コマンドを実行する（ファイルごとに繰り返し実行される）
  - 根拠: vercel/ai は `package.json` 変更検知を pre-commit hook レベルで行い、`pnpm install` を一度だけ実行する設計にしている（`.husky/pre-commit:7-15` のコメント参照）

- `[AVOID]` dependency 更新を全て同一スケジュールで実行する
  - 根拠: vercel/ai は Renovate で 4 段階のスケジュール（本番依存は毎週、開発依存は月次、root は四半期）を設定し、更新の影響度に応じた頻度管理をしている

## 適用チェックリスト

- [ ] ESLint config の extends 末尾に `prettier`（eslint-config-prettier）が含まれているか
- [ ] monorepo の場合、ESLint config / tsconfig が共有パッケージとして管理されているか
- [ ] lint-staged の設定で `--ignore-unknown` を使い、不要なファイル形式の除外設定を減らせるか
- [ ] pre-commit hook のバイパス機構が存在し、CI で同等の品質チェックが実行されているか
- [ ] changeset 運用がある場合、バージョン制約を CI で自動検証しているか
- [ ] ライブラリパッケージのバンドルサイズ・ロード時間に CI での定量チェックがあるか
- [ ] テストファイル（`*.test.ts`, `*.test-d.ts`, `__snapshots__/`）が npm パッケージの `files` から除外されているか
- [ ] tsconfig が IDE 用（composite: true）とビルド用で分離されているか
- [ ] dependency 更新のスケジュールが依存の種類と影響度に応じて段階的に設定されているか
