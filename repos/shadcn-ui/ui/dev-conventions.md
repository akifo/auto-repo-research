# dev-conventions

> リポジトリ: shadcn-ui/ui
> 分析日: 2026-03-04

## 概要

shadcn/ui は pnpm + Turborepo + Changesets を軸としたモノレポ開発体制を採用している。Conventional Commits を commitlint で強制し、Prettier（import ソート + Tailwind CSS プラグイン付き）とESLint（TypeScript strict + inline type imports 強制）でコード品質を自動担保する。CI/CD は PR 単位の lint/format/typecheck/test ゲートと、main マージ時の Changesets 自動リリース、ラベルトリガーのベータリリースという3層構造をとる。この設計は「人間のレビュー負荷を下げ、機械的に検証可能なことは機械に任せる」という原則を徹底しており、107k+ stars のコミュニティ規模でも一貫性を維持できている。

## 背景にある原則

- **ツールチェーンの層分離で検証を自動化する**: lint（論理的正しさ）、format（スタイル的一貫性）、typecheck（型安全性）、test（振る舞いの正しさ）を独立したタスクとして分離し、それぞれを CI ジョブとして並列実行している。これにより「フォーマットは通ったがテストが壊れた」といった問題を素早く特定できる。根拠: `turbo.json` で `lint`、`format:check`、`typecheck`、`test` が個別パイプラインとして定義されている（`turbo.json:29-53`）。

- **コードスタイルの議論を排除する**: Prettier で自動フォーマットし、import 順序もプラグインで自動ソートすることで、PR レビューからスタイル議論を完全に排除する。根拠: `prettier.config.cjs` で `@ianvs/prettier-plugin-sort-imports` による7層の import 順序ルールと `prettier-plugin-tailwindcss` によるクラス名ソートが設定されている。

- **リリースとコミットの因果関係を追跡可能にする**: Conventional Commits + Changesets の組み合わせにより、どのコミットがどのバージョンに含まれるかを自動的に追跡できる。CHANGELOG は GitHub PR リンク付きで自動生成される。根拠: `.changeset/config.json` で `@changesets/changelog-github` を使用し、`release.yml` で `changesets/action@v1` により自動バージョニング PR を作成している。

- **非公開ワークスペースをリリース対象から隔離する**: Changesets の `ignore` 設定でウェブサイト（`v4`）とテスト（`tests`）を除外し、公開パッケージ（`shadcn`）のみをリリース対象にしている。pnpm workspace の除外パターンでもテスト用フィクスチャを隔離している。根拠: `.changeset/config.json:10` の `"ignore": ["v4", "tests"]` と `pnpm-workspace.yaml:4-8` の除外設定。

## 実例と分析

### Conventional Commits の設計

CONTRIBUTING.md で `category(scope): message` 形式を定義し、`feat`, `fix`, `refactor`, `docs`, `build`, `test`, `ci`, `chore` の8カテゴリを明文化している。commitlint（`@commitlint/cli` + `@commitlint/config-conventional`）が依存に含まれており、フォーマット違反を機械的に検出する。

実際の git log を見ると、`fix(base-sidebar): fix tooltip rendering with render prop` や `feat: add emerald-ui to registry` のように scope 付きと scope なしが混在しており、scope は任意として運用されている。一方、リリースコミットは `chore(release): version packages` で統一されており、release.yml で明示的に指定している。

```
# .github/workflows/release.yml:54-55
commit: "chore(release): version packages"
title: "chore(release): version packages"
```

### Prettier + import ソートの多層設計

import 順序は7つのグループに分かれている。これはルートの `prettier.config.cjs` と `apps/v4/package.json` 内の `prettier` フィールドの両方で定義されている。

```javascript
// prettier.config.cjs:9-29
importOrder: [
  "^(react/(.*)$)|^(react$)",        // 1. React
  "^(next/(.*)$)|^(next$)",          // 2. Next.js
  "<THIRD_PARTY_MODULES>",            // 3. サードパーティ
  "",                                  // 空行
  "^@workspace/(.*)$",                // 4. ワークスペース内
  "",                                  // 空行
  "^types$",
  "^@/types/(.*)$",                   // 5. 型
  "^@/config/(.*)$",                  // 6. 設定 → ライブラリ → フック → コンポーネント
  "^@/lib/(.*)$",
  "^@/hooks/(.*)$",
  "^@/components/ui/(.*)$",
  "^@/components/(.*)$",
  "^@/registry/(.*)$",
  "^@/styles/(.*)$",
  "^@/app/(.*)$",
  "",                                  // 空行
  "^[./]",                            // 7. 相対パス
]
```

実際のコードで一貫して適用されていることが確認できる。

```typescript
// apps/v4/app/(create)/create/page.tsx:1-21
import { type Metadata } from "next"          // Next.js
import Link from "next/link"                   // Next.js
import { ArrowLeftIcon } from "lucide-react"   // サードパーティ
import type { SearchParams } from "nuqs/server" // サードパーティ

import { siteConfig } from "@/lib/config"      // @/lib
import { source } from "@/lib/source"          // @/lib
import { absoluteUrl } from "@/lib/utils"      // @/lib
import { Icons } from "@/components/icons"     // @/components
import { MainNav } from "@/components/main-nav" // @/components
```

### ESLint の設計方針

`apps/v4/eslint.config.mjs` では `typescript-eslint` の recommended をベースに、`@typescript-eslint/consistent-type-imports` を error レベルで強制している。`prefer: "type-imports"` + `fixStyle: "inline-type-imports"` の設定により、型インポートは `import { type Foo }` 形式が強制される。

```typescript
// apps/v4/eslint.config.mjs:31-37
"@typescript-eslint/consistent-type-imports": [
  "error",
  {
    prefer: "type-imports",
    fixStyle: "inline-type-imports",
  },
],
```

一方で `@typescript-eslint/no-unused-vars` は off にされている（`eslint.config.mjs:30`）。これはコンポーネントレジストリのコード生成特性上、未使用変数が一時的に発生することへの対応と推測される。

### CI/CD の3層構造

**第1層: PR ゲート** -- `code-check.yml` で lint / format:check / typecheck を並列実行し、`test.yml` でテストを実行する。いずれもパッケージビルド（`pnpm --filter=shadcn build`）を前提としている点が重要で、型チェックやテストはビルド済みアーティファクトに依存している。

**第2層: リリース** -- `release.yml` は main ブランチへの push で発火し、Changesets Action がバージョンアップ PR を作成するか、未公開の changeset がなければ npm publish を実行する。lockfile 更新の workaround（`.github/changeset-version.js`）も含まれている。

**第3層: ベータリリース** -- `prerelease.yml` は PR に `autorelease` ラベルを付与すると発火する。git short hash をバージョンに埋め込み（`0.0.0-beta.<hash>`）、ベータ版として publish する。`prerelease-comment.yml` が publish 完了後に PR にインストールコマンドをコメントする。

```yaml
# .github/workflows/prerelease.yml:17-19
if: |
  github.repository_owner == 'shadcn-ui' &&
  contains(github.event.pull_request.labels.*.name, 'autorelease')
```

### Turborepo のキャッシュ戦略

`turbo.json` で lint / format:check / test は `"cache": false` に設定されている。これは正しい判断で、lint やテストの結果はソースコードの変更だけでなく、外部依存の変更にも影響されるため、キャッシュすると偽陰性が発生するリスクがある。一方 `build` はキャッシュ有効で、`"outputs": ["dist/**", ".next/**"]` を指定している。

### テスト設計: ユニットテストと統合テストの分離

テストは2つのレイヤーに分かれている。`packages/shadcn` 内のユニットテスト（59ファイル）はソースコード近傍に配置され、`packages/tests` の統合テストは実際にCLIを実行してフィクスチャプロジェクトに対する操作を検証する。統合テストはルートの `pnpm test` で `start-server-and-test` を使って開発サーバーを起動してから実行される。

```json
// package.json:41-42
"test:dev": "turbo run test --filter=!shadcn-ui --force",
"test": "start-server-and-test v4:dev http://localhost:4000 test:dev",
```

統合テストの vitest 設定では `testTimeout: 120000`（2分）、`maxConcurrency: 4`、`isolate: false` という構成で、I/O 重いテストの並列度を制御している。

### ワークスペース除外パターン

pnpm workspace の `packages` 定義で、テスト用ディレクトリを明示的に除外している。これにより、テストフィクスチャ内の `package.json` がワークスペースメンバーとして認識されるのを防いでいる。

```yaml
# pnpm-workspace.yaml:1-8
packages:
  - "apps/*"
  - "packages/*"
  - "!**/test/**"
  - "!**/fixtures/**"
  - "!**/temp/**"
  - "!packages/tests/temp/**"
  - "!deprecated/**"
```

### 非推奨コードの検出自動化

`deprecated.yml` ワークフローが `apps/www/` への変更を検出し、PR にコメントと `deprecated` ラベルを自動付与する。これは v4 への移行期において、旧コードへの変更を防ぐゲートとして機能している。

## Good Patterns

- **import 順序の「依存の方向」による層別化**: React/Next.js → サードパーティ → ワークスペース内 → プロジェクト内（types → config → lib → hooks → components）→ 相対パスという順序は、「抽象度の高いもの → 具体的なもの」という依存の方向と一致しており、コードの依存構造を視覚的に把握できる。Prettier プラグインで自動化されており、人手による維持コストがゼロである。

```javascript
// prettier.config.cjs:9-29
importOrder: [
  "^(react/(.*)$)|^(react$)",
  "^(next/(.*)$)|^(next$)",
  "<THIRD_PARTY_MODULES>",
  "",
  "^@workspace/(.*)$",
  "",
  "^@/lib/(.*)$",
  "^@/components/(.*)$",
  "",
  "^[./]",
]
```

- **ラベルトリガーのベータリリース**: PR に `autorelease` ラベルを付けるだけでベータ版が publish され、完了後に PR にインストールコマンドがコメントされる。レビュアーがすぐにテストできる仕組みになっている。

```yaml
# .github/workflows/prerelease.yml:48-49 (version-script-beta.js)
pkg.version = "0.0.0-beta." + stdout.trim()  # git hash ベース
```

- **リリース用 changeset-version の lockfile 同期**: Changesets が lockfile を自動更新しない既知の問題（changesets/changesets#421）に対して、カスタムスクリプトで `pnpm install --lockfile-only` を追加実行する workaround を入れている。

```javascript
// .github/changeset-version.js:11-12
execSync("npx changeset version", { stdio: "inherit" })
execSync("pnpm install --lockfile-only", { stdio: "inherit" })
```

## Anti-Patterns / 注意点

- **lint/test のキャッシュ無効化を忘れる**: Turborepo でテストや lint にキャッシュを有効にすると、外部依存の変更や環境変数の変化を検出できず、偽の成功結果が返される。shadcn/ui では明示的に `"cache": false` を設定している。

```json
// Bad: キャッシュが有効なまま
{
  "test": {
    "outputs": []
    // cache は暗黙的に true
  }
}

// Better: 明示的に無効化
{
  "test": {
    "cache": false,
    "outputs": []
  }
}
```

- **テストフィクスチャをワークスペースに含めてしまう**: CLI のテストフィクスチャには `package.json` が含まれるため、ワークスペースの除外パターンを設定しないとフィクスチャがワークスペースメンバーとして認識され、依存解決が壊れる。

```yaml
# Bad: 除外パターンなし
packages:
  - "packages/*"

# Better: フィクスチャを明示的に除外
packages:
  - "packages/*"
  - "!**/test/**"
  - "!**/fixtures/**"
  - "!**/temp/**"
```

- **Prettier 設定の重複定義**: ルートの `prettier.config.cjs` と `apps/v4/package.json` 内の `prettier` フィールドに同じ設定が書かれている。ワークスペースごとに微妙な差異（`tailwindStylesheet` のパスなど）があるための設計だが、共通部分の同期が手動になるリスクがある。

## 導出ルール

- `[MUST]` モノレポの CI で lint / format / typecheck / test を独立したジョブとして実行する
  - 根拠: shadcn/ui の `code-check.yml` では3つの独立ジョブ（lint, format, tsc）が並列実行され、問題の特定が高速化されている

- `[MUST]` Turborepo 等のビルドシステムで、lint とテストのキャッシュを明示的に無効化する
  - 根拠: `turbo.json` で `lint`、`test`、`format:check` はすべて `"cache": false` に設定されており、環境依存の偽陰性を防止している

- `[MUST]` テスト用フィクスチャのディレクトリをモノレポのワークスペース定義から除外する
  - 根拠: `pnpm-workspace.yaml` で `!**/test/**`、`!**/fixtures/**`、`!**/temp/**` が除外されており、フィクスチャの `package.json` がワークスペースメンバーに含まれない

- `[SHOULD]` import 順序を Prettier プラグインで自動ソートし、フレームワーク → サードパーティ → プロジェクト内 → 相対パスの層構造を定義する
  - 根拠: `@ianvs/prettier-plugin-sort-imports` で7層の import 順序が定義され、全ファイルで一貫している

- `[SHOULD]` TypeScript の型インポートを inline 形式（`import { type Foo }`）で統一し、ESLint で強制する
  - 根拠: `eslint.config.mjs` で `consistent-type-imports` を error レベルに設定し、`fixStyle: "inline-type-imports"` でスタイルを統一している

- `[SHOULD]` ベータリリースを PR ラベルでトリガーし、PR コメントでインストールコマンドを自動通知する
  - 根拠: `prerelease.yml` + `prerelease-comment.yml` の組み合わせで、ラベル付与からインストール手順通知まで自動化されている

- `[SHOULD]` Changesets のリリースワークフローで lockfile を明示的に同期する
  - 根拠: `.github/changeset-version.js` で `changeset version` 後に `pnpm install --lockfile-only` を実行し、lockfile の不整合を防止している

- `[AVOID]` Prettier の設定を複数箇所に重複定義する（共通設定はルートに、ワークスペース固有の差分のみオーバーライドする）
  - 根拠: ルートの `prettier.config.cjs` と `apps/v4/package.json` の `prettier` フィールドに同じ設定が存在し、同期漏れのリスクがある

## 適用チェックリスト

- [ ] Conventional Commits の形式（`type(scope): message`）を CONTRIBUTING.md に明文化し、commitlint で機械検証する
- [ ] Prettier に import ソートプラグインを導入し、依存の方向に沿った層構造を定義する
- [ ] ESLint で `consistent-type-imports` を error レベルに設定し、inline 型インポートを強制する
- [ ] Turborepo 等のビルドオーケストレーターで、lint / test / format:check に `cache: false` を設定する
- [ ] CI ワークフローを lint / format / typecheck / test の独立ジョブに分割し、並列実行する
- [ ] pnpm workspace の除外パターンにテスト用ディレクトリ（test, fixtures, temp）を追加する
- [ ] Changesets を導入し、リリースワークフローで lockfile 同期スクリプトを組み込む
- [ ] ベータリリースのラベルトリガーと PR コメント通知を設定する
- [ ] 非推奨コードへの変更を検出する CI ワークフローを追加する（移行期がある場合）
