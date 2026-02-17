# CI/CD

> リポジトリ: vitejs/vite
> 分析日: 2026-02-17

## 概要

Vite の CI/CD パイプラインは、12 のワークフローファイルで構成される成熟したシステムである。CI はクロスプラットフォーム・マルチ Node バージョンのマトリクステストを軸とし、リリースは「ローカルで tag 作成 → CI で npm publish」という2段階分離方式を採用している。特筆すべきは、エコシステム CI（外部プロジェクトを PR の変更で自動テストする仕組み）、`pkg-pr-new` によるコミット単位のプレビューリリース、GitHub Environment による publish 承認ゲートの3点であり、大規模 OSS のリリース品質保証として洗練されている。

## 背景にある原則

- **リリースとパブリッシュの関心分離**: リリース判断（バージョン決定・changelog 生成・tag 作成）は人間がローカルで行い、パブリッシュ（npm への公開）は CI が tag トリガーで自動実行する。これにより、人間の判断が必要な工程と機械的な工程を明確に分けている（`scripts/release.ts` → `publish.yml`）。
- **セキュリティファーストのパイプライン設計**: GitHub Actions の GITHUB_TOKEN 権限をワークフロー単位で最小化し（CI は `permissions: {}`）、サードパーティ Action は SHA ピン留めし、publish 系ワークフローではキャッシュを無効化（cache poisoning 対策）する。防御が多層的である。
- **変更検知によるリソース最適化**: docs や markdown のみの変更では高コストなテストジョブをスキップし、CI の実行時間とランナーコストを抑える。
- **エコシステムへの影響を PR 段階で検知する**: 自分のテストだけでなく、下流プロジェクトに対する破壊的変更をマージ前に発見する仕組み（ecosystem-ci）を設けている。

## 実例と分析

### ワークフロー構成の全体像

Vite は 12 のワークフローを役割ごとに明確に分離している:

| カテゴリ | ワークフロー | トリガー |
|---------|------------|---------|
| テスト | `ci.yml` | push / PR |
| リリース | `publish.yml`, `release-tag.yml` | tag push |
| プレビュー | `preview-release.yml` | push to main / label |
| エコシステム | `ecosystem-ci-trigger.yml` | issue comment |
| 品質ゲート | `semantic-pull-request.yml` | PR |
| Issue 管理 | `issue-labeled.yml`, `issue-close-require.yml`, `lock-closed-issues.yml`, `issue-template-check.yml`, `clarity-label.yml` | issue event / schedule |
| AI 連携 | `copilot-setup-steps.yml` | workflow_dispatch |

### CI パイプラインの最適化戦略

CI ワークフローは変更検知 → テスト → ゲートジョブという3層構造を持つ。

::: v-pre
```yaml
# .github/workflows/ci.yml:34-60
jobs:
  changed:
    name: Get changed files
    runs-on: ubuntu-latest
    outputs:
      should_skip: ${{ steps.changed-files.outputs.only_changed == 'true' }}
    steps:
      - name: Get changed files
        id: changed-files
        uses: tj-actions/changed-files@e0021407031f5be11a464abee9a0776171c79891 # v47.0.1
        with:
          files: |
            docs/**
            .github/**
            !.github/workflows/ci.yml
            packages/create-vite/template**
            **.md

  test:
    needs: changed
    if: needs.changed.outputs.should_skip != 'true'
```
:::

docs や `.github/` 配下のみの変更はテストをスキップするが、`ci.yml` 自体の変更はスキップ対象から除外している点が巧妙である。

### マトリクステストとゲートジョブパターン

テストマトリクスは `fail-fast: false` で全組み合わせを完走させ、結果を集約する2つのゲートジョブで判定する:

```yaml
# .github/workflows/ci.yml:130-145
test-passed:
  if: (!cancelled() && !failure())
  needs: test
  runs-on: ubuntu-latest
  name: Build & Test Passed or Skipped
  steps:
    - run: echo "Build & Test Passed or Skipped"

test-failed:
  if: (!cancelled() && failure())
  needs: test
  runs-on: ubuntu-latest
  name: Build & Test Failed
  steps:
    - run: echo "Build & Test Failed"
```

この「pass/fail ゲートジョブ」パターンにより、branch protection rule で単一のジョブ名を指定するだけで、動的マトリクスの全結果を必須チェックにできる。

### 2段階リリースフロー

リリースの流れは以下の通り:

1. ローカルで `pnpm release` を実行（`scripts/release.ts`）
2. `@vitejs/release-scripts` がバージョンバンプ・changelog 生成・git tag 作成・push を実行
3. tag push が `publish.yml` をトリガー
4. GitHub Environment "Release" の承認待ち（人間が "Approve and deploy" をクリック）
5. `pnpm run ci-publish` でパッケージ公開

```typescript
// scripts/release.ts:1-21
import { generateChangelog, release } from '@vitejs/release-scripts'
import colors from 'picocolors'
import { logRecentCommits, updateTemplateVersions } from './releaseUtils'

release({
  repo: 'vite',
  packages: ['vite', 'create-vite', 'plugin-legacy'],
  toTag: (pkg, version) =>
    pkg === 'vite' ? `v${version}` : `${pkg}@${version}`,
  logChangelog: (pkg) => logRecentCommits(pkg),
  generateChangelog: async (pkgName) => {
    if (pkgName === 'create-vite') await updateTemplateVersions()
    console.log(colors.cyan('\nGenerating changelog...'))
    await generateChangelog({
      getPkgDir: () => `packages/${pkgName}`,
      tagPrefix: pkgName === 'vite' ? undefined : `${pkgName}@`,
    })
  },
})
```

### エコシステム CI のセキュリティモデル

`/ecosystem-ci run` コマンドは PR コメントでトリガーされるが、以下の多層防御を持つ:

1. **権限チェック**: triage 権限以上のユーザーのみ実行可能
2. **タイミング検証**: コメント投稿後に PR が更新されていないか確認（コード注入防止）
3. **GitHub App Token**: 専用 App で最小権限トークンを生成

```javascript
// .github/workflows/ecosystem-ci-trigger.yml:69-97
const commentCreatedAt = new Date(context.payload.comment.created_at)
const commitPushedAt = new Date(pr.head.repo.pushed_at)

if (commitPushedAt > commentCreatedAt) {
  const errorMsg = [
    '⚠️ Security warning: PR was updated after the trigger command was posted.',
    '',
    'This could indicate an attempt to inject code after approval.',
    'Please review the latest changes and re-run /ecosystem-ci run if they are acceptable.'
  ].join('\n')
  core.setFailed(errorMsg)
}
```

### Publish ワークフローのサプライチェーン防御

```yaml
# .github/workflows/publish.yml:15-43
permissions:
  contents: read
  id-token: write
environment: Release
steps:
  - name: Disallow installation scripts
    run: yq '.onlyBuiltDependencies = []' -i pnpm-workspace.yaml
  - name: Install deps
    run: pnpm install
    env:
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1"
```

`onlyBuiltDependencies = []` で全インストールスクリプトを無効化し、依存パッケージの postinstall による任意コード実行を防いでいる。また、publish に不要な Playwright バイナリのダウンロードもスキップしている。

### Preview Release と pkg-pr-new

main push 時と `trigger: preview` ラベル付与時にプレビューリリースが作成される:

```yaml
# .github/workflows/preview-release.yml:55
- run: pnpm dlx pkg-pr-new@0.0 publish --pnpm './packages/vite' './packages/plugin-legacy' --packageManager=pnpm,npm,yarn --commentWithDev
```

`pkg-pr-new` はコミット SHA 単位でパッケージを公開するため、PR レビュアーや下流プロジェクトのメンテナーが実際のパッケージをインストールして検証できる。

### Renovate による依存更新の制御

```json5
// .github/renovate.json5:8-16
"packageRules": [
  {
    "matchDepTypes": ["peerDependencies"],
    "enabled": false,
  },
  {
    "matchDepTypes": ["action"],
    "pinDigests": true,
    "matchPackageNames": ["!actions/{/,}**", "!github/{/,}**"],
  },
]
```

peerDependencies は自動更新しない、サードパーティ Action は SHA ピン留めを強制、`rollup` や `typescript` など影響の大きい依存は手動管理（`ignoreDeps`）、という階層的な更新戦略を持つ。

## パターンカタログ

- **Gate Job パターン** (分類: 構造)
  - 解決する問題: 動的マトリクスの全結果を1つの branch protection ルールで検証したい
  - 適用条件: マトリクスのサイズが変動する CI（OS・Node バージョン追加時など）
  - コード例: `.github/workflows/ci.yml:130-145`
  - 注意点: `(!cancelled() && !failure())` と `(!cancelled() && failure())` の両方を定義しないと、キャンセル時の状態が曖昧になる

- **Tag-Triggered Publish パターン** (分類: 振る舞い)
  - 解決する問題: リリース判断とパブリッシュ実行の分離
  - 適用条件: npm/PyPI/crates.io 等のパッケージレジストリへの公開を伴うプロジェクト
  - コード例: `.github/workflows/publish.yml:5-8`, `scripts/release.ts`
  - 注意点: Environment approval を組み合わせないと tag push だけで公開されるリスクがある

## Good Patterns

- **変更検知による CI スキップ**: docs のみの変更で重いテストを回さない仕組み。`!.github/workflows/ci.yml` のように CI 定義自体の変更を除外リストから外す点が洗練されている。

```yaml
# .github/workflows/ci.yml:47-56
files: |
  docs/**
  .github/**
  !.github/workflows/ci.yml
  packages/create-vite/template**
  **.md
```

- **インストールスクリプト無効化**: publish/preview ワークフローで `yq '.onlyBuiltDependencies = []' -i pnpm-workspace.yaml` を実行し、依存パッケージの postinstall を全無効化する。サプライチェーン攻撃の攻撃面を最小化する。

```yaml
# .github/workflows/publish.yml:34-35
- name: Disallow installation scripts
  run: yq '.onlyBuiltDependencies = []' -i pnpm-workspace.yaml
```

- **Flaky テストへの自動リトライ**: segfault によるフレーク対策として `VITEST_SEGFAULT_RETRY: 3` をグローバルに設定。タイムアウト延長ではなく、特定の失敗モードに対するリトライという適切なアプローチ。

```yaml
# .github/workflows/ci.yml:9-10
# Vitest auto retry on flaky segfault
VITEST_SEGFAULT_RETRY: 3
```

- **キャッシュ無効化（publish 系）**: publish と preview-release で `package-manager-cache: false` を明示設定し、cache poisoning を防止。コメントに zizmor の audit URL を記載している点も教育的。

```yaml
# .github/workflows/publish.yml:30-32
cache: "pnpm"  # ← CI ワークフローではキャッシュ有効
# vs
package-manager-cache: false  # ← publish では無効（cache poisoning 対策）
```

## Anti-Patterns / 注意点

- **Fork 上での不要なワークフロー実行**: issue 管理系ワークフロー（`issue-labeled.yml` 等）は `if: github.repository == 'vitejs/vite'` で fork 実行を防止しているが、`ci.yml` にはこのガードがない。CI は fork の PR でも実行する必要があるため意図的だが、fork 上での直接 push トリガーは無駄なランナー消費につながりうる。

```yaml
# Bad: fork で push 時も CI が走る
on:
  push:
    branches: [main]
  pull_request:

# Better: fork での push を制限（ただし PR テストは維持）
on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    if: github.event_name == 'pull_request' || github.repository == 'vitejs/vite'
```

- **Playwright キャッシュキーの OS 依存**: <code v-pre>${{ runner.os }}-playwright-bin-v1-${{ env.PLAYWRIGHT_VERSION }}</code> で Playwright バイナリをキャッシュしているが、キーのバージョン部分 (`v1`) を手動管理しており、キャッシュ無効化時にワークフロー内の複数箇所を同時に更新する必要がある。

## 導出ルール

- `[MUST]` publish ワークフローでは GITHUB_TOKEN の権限を最小限に設定し、GitHub Environment による承認ゲートを設ける
  - 根拠: Vite は `permissions: { contents: read, id-token: write }` と `environment: Release` を組み合わせ、tag push だけでは公開されない二重のガードを実装している（`.github/workflows/publish.yml:15-18`）

- `[MUST]` サードパーティ GitHub Action はコミット SHA でピン留めし、Renovate 等で自動更新する
  - 根拠: Vite は全てのサードパーティ Action を SHA ピン留めし、Renovate の `pinDigests: true` で更新を自動化している（`.github/renovate.json5:14-16`）

- `[SHOULD]` マトリクステストの結果を集約するゲートジョブを定義し、branch protection はゲートジョブのみを必須にする
  - 根拠: `test-passed` / `test-failed` パターンにより、マトリクスサイズが変動しても branch protection ルールの変更が不要になる（`.github/workflows/ci.yml:130-145`）

- `[SHOULD]` publish/release 系ワークフローでは依存パッケージのインストールスクリプトを無効化する
  - 根拠: Vite は `onlyBuiltDependencies = []` で全 postinstall を無効化し、サプライチェーン攻撃の攻撃面を最小化している（`.github/workflows/publish.yml:34-35`）

- `[SHOULD]` CI で不要な大容量バイナリのダウンロードをスキップする環境変数を設定する
  - 根拠: Vite は `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1"` をグローバル env で設定し、手動で必要なブラウザのみをインストールしている（`.github/workflows/ci.yml:8`, `ci.yml:116`）

- `[SHOULD]` 変更検知で docs やテンプレートのみの変更時にテストジョブをスキップする
  - 根拠: Vite は `tj-actions/changed-files` で変更ファイルをフィルタし、CI 定義自体の変更は除外リストから外している（`.github/workflows/ci.yml:47-56`）

- `[AVOID]` publish ワークフローで依存パッケージのキャッシュを有効にする
  - 根拠: Vite は publish と preview-release で明示的にキャッシュを無効化し、cache poisoning を防止している（`.github/workflows/publish.yml:31-32`）

## 適用チェックリスト

- [ ] publish ワークフローの GITHUB_TOKEN 権限を最小限に設定しているか
- [ ] publish ワークフローに GitHub Environment の承認ゲートを設定しているか
- [ ] サードパーティ Action を SHA でピン留めしているか（tag 指定になっていないか）
- [ ] Renovate や Dependabot で Action の SHA 更新を自動化しているか
- [ ] マトリクステストの結果を集約するゲートジョブを定義しているか
- [ ] publish 系ワークフローでインストールスクリプトを無効化しているか
- [ ] publish 系ワークフローでキャッシュを無効化しているか
- [ ] docs のみの変更で重いテストをスキップする仕組みがあるか
- [ ] concurrency 設定で同一 PR の重複実行をキャンセルしているか
- [ ] PR タイトルの Conventional Commits 準拠を自動検証しているか
- [ ] エコシステムへの影響を確認する仕組み（ecosystem-ci 等）を導入しているか
- [ ] リリース判断（バージョン・changelog）とパブリッシュ（npm 公開）を分離しているか
