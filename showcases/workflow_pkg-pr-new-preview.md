# Workflow: pkg-pr-new Preview

> 出典: [repos/cloudflare/agents](../repos/cloudflare/agents/)
> カテゴリ: workflow

## 概要

pkg-pr-new を使い、PR ごとにパッケージをプレビュー公開して、マージ前に実際の `npm install` で動作確認できるワークフロー。PR ワークフローでは `--peerDeps` フラグで peer dependencies も含めたプレビューパッケージを即座に公開し、レビュアーがローカル環境で実パッケージとして検証できる。changesets によるリリースフロー、Playwright 3 層ブラウザキャッシュ、concurrency の使い分け（PR は cancel-in-progress、release は no cancel）を含む、monorepo 向け CI/CD 設計の実践例。

## 背景・文脈

cloudflare/agents は Cloudflare Workers 上で動作する AI エージェントフレームワークを提供する monorepo である。複数のパッケージ（`./packages/*`）を npm に公開しており、パッケージ間で peer dependencies の関係がある。

従来の monorepo リリースフローでは、PR レビュー時にパッケージの動作確認ができるのは CI のテスト結果のみだった。実際にユーザーの手元で `npm install` してみないと分からない問題（exports フィールドの設定ミス、peer dependencies の解決失敗、バンドルサイズの変化など）は、マージ後のリリースで初めて顕在化する。

pkg-pr-new はこの問題を解決するツールで、PR に紐づいた一時的なパッケージを公開する。レビュアーは PR のコメントに記載された URL を使って `npm install https://pkg.pr.new/...` でパッケージをインストールし、実際のプロジェクトで動作確認できる。cloudflare/agents ではこれに加えて、changesets によるバージョン管理、Playwright ブラウザの効率的なキャッシュ戦略、ワークフロー種別ごとの concurrency 制御を組み合わせた CI/CD パイプラインを構築している。

## 実装パターン

### 1. ワークフローの分離設計

4 つのワークフローが異なるトリガーと責務を持ち、concurrency 制御を使い分ける。

| ワークフロー | トリガー                              | 責務                             | cancel-in-progress |
| ------------ | ------------------------------------- | -------------------------------- | ------------------ |
| pullrequest  | `pull_request` (paths-ignore あり)    | lint + test + preview publish    | true               |
| release      | `push` to main                        | changesets version + npm publish | false              |
| nightly      | `schedule` + `workflow_dispatch`      | E2E テスト（実 API 接続）        | true               |
| bonk         | `issue_comment` / `pr_review_comment` | AI アシスタント応答              | false              |

PR ワークフローは `cancel-in-progress: true` で同一 PR の古い実行をキャンセルし、高速フィードバックを実現する。release ワークフローは `cancel-in-progress: false` で npm publish の中断を防止する。

```yaml
# .github/workflows/pullrequest.yml:4-13
on:
  pull_request:
    paths-ignore:
      - "docs/**"
      - "design/**"
      - "*.md"
      - ".changeset/**"

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number }}
  cancel-in-progress: true
```

```yaml
# .github/workflows/release.yml:8-10
concurrency:
  group: ${{ github.workflow }}
  cancel-in-progress: false
```

### 2. pkg-pr-new による PR プレビュー公開

PR の publish-preview ジョブが `pkg-pr-new publish --peerDeps ./packages/*` を実行し、PR 単位のプレビューパッケージを公開する。`--peerDeps` フラグにより、monorepo 内のパッケージ間 peer dependencies もプレビューバージョンに解決される。

```yaml
# .github/workflows/pullrequest.yml:85-86
- name: Publish packages to pkg.pr.new
  run: npx pkg-pr-new publish --peerDeps ./packages/*
```

レビュアーは PR コメントに記載された URL で即座にパッケージをインストールし、マージ前に実際の `npm install` で動作確認できる。

### 3. Playwright ブラウザ 3 層キャッシュ戦略

Playwright ブラウザは数百 MB のバイナリであり、毎回ダウンロードすると CI 時間を大幅に消費する。3 層の戦略で対処している。

**第 1 層: デフォルトの自動ダウンロードを抑止**

ワークフローレベルの `env` で全ジョブのブラウザ自動ダウンロードを無効化する。

```yaml
# .github/workflows/pullrequest.yml:15-16
env:
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1"
```

**第 2 層: lockfile からバージョンキーを抽出してキャッシュ**

`jq` で package-lock.json から Playwright の正確なバージョンを抽出し、キャッシュキーに使用する。バージョンアップ時にキャッシュが自動的に無効化される。

```yaml
# .github/workflows/pullrequest.yml:51-62
- name: Get Playwright version
  id: playwright-version
  run: echo "version=$(jq -r '.packages["node_modules/playwright"].version' package-lock.json)" >> $GITHUB_OUTPUT

- name: Cache Playwright browsers
  uses: actions/cache@v5
  id: playwright-cache
  with:
    path: ~/.cache/ms-playwright
    key: ${{ runner.os }}-playwright-${{ steps.playwright-version.outputs.version }}
```

**第 3 層: キャッシュミス時のみインストール**

`cache-hit` 出力を条件に、キャッシュが存在しない場合のみ Chromium をインストールする。

```yaml
# .github/workflows/pullrequest.yml:64-65
- name: Install Playwright browsers
  if: steps.playwright-cache.outputs.cache-hit != 'true'
  run: npx playwright install --with-deps chromium
```

### 4. カスタム changesets リリーススクリプト

changesets/action の `version` と `publish` コマンドにカスタムスクリプトを指定し、標準ワークフローの既知の制限を補完している。

**changeset-version.ts**: changesets の既知の Issue (#421) への回避策として、`changeset version` 後に `npm install` を追加実行して package-lock.json を更新する。

```typescript
// .github/changeset-version.ts:1-13
import { execSync } from "node:child_process";

// This script is used by the `release.yml` workflow to update the version
// of the packages being released.
// The standard step is only to run `changeset version` but this does not
// update the package-lock.json file.
// See https://github.com/changesets/changesets/issues/421.
execSync("npx changeset version", { stdio: "inherit" });
execSync("npm install", { stdio: "inherit" });
```

**changeset-publish.ts**: publish 前に `resolve-workspace-versions.ts` を実行して `workspace:*` プロトコルを実際のバージョンに解決する。

```typescript
// .github/changeset-publish.ts:1-8
import { execSync } from "node:child_process";

execSync("npx tsx ./.github/resolve-workspace-versions.ts", {
  stdio: "inherit",
});
execSync("npx changeset publish", { stdio: "inherit" });
```

**resolve-workspace-versions.ts**: 全パッケージの package.json をスキャンし、monorepo 内の依存関係を `^<実バージョン>` に書き換える。nightly ビルド（`0.0.0-` プレフィックス）の場合はキャレットを付けない。

```typescript
// .github/resolve-workspace-versions.ts:62-64
let actualVersion = packageJsons[dependencyName].packageJson.version;
if (!actualVersion.startsWith("0.0.0-")) {
  actualVersion = `^${actualVersion}`;
}
```

### 5. チェックコマンドの失敗コスト順実行

`npm run check` が 5 つのチェックを軽量順に直列実行し、高コストなチェックに到達する前に問題を検出する。

```json
// package.json:23
"check": "sherif && npm run check:exports && oxfmt --check . && oxlint examples/ packages/ guides/ openai-sdk/ site/ && npm run typecheck"
```

1. **sherif**: monorepo の依存関係整合性チェック（最軽量）
2. **check:exports**: ビルド成果物が exports 宣言と一致するか検証
3. **oxfmt --check**: フォーマットチェック
4. **oxlint**: Lint チェック
5. **typecheck**: 全 tsconfig.json の型チェック（CPU コア数に基づく並列実行、最重量）

### 6. Nightly E2E の分離

秘匿情報（Cloudflare API トークン）を必要とする E2E テストは nightly ワークフローに分離されている。PR ワークフローでは secrets にアクセスできないフォークからの PR も安全に実行できる。

```yaml
# .github/workflows/nightly.yml:47-51
- name: Run ai-chat e2e tests
  env:
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
  run: npx playwright test --config e2e/playwright.config.ts
```

## Good Example

PR ワークフローの全体構成。check / test / publish-preview の 3 ジョブが並列実行され、pkg-pr-new でプレビューパッケージが即座に公開される。

```yaml
# .github/workflows/pullrequest.yml -- 全体構成
on:
  pull_request:
    paths-ignore:
      - "docs/**"
      - "design/**"
      - "*.md"
      - ".changeset/**"

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number }}
  cancel-in-progress: true

env:
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1"

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npm run build
      - run: npm run check  # sherif -> exports -> format -> lint -> typecheck

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npm run build
      # Playwright 3 層キャッシュ
      - id: playwright-version
        run: echo "version=$(jq -r '.packages["node_modules/playwright"].version' package-lock.json)" >> $GITHUB_OUTPUT
      - uses: actions/cache@v5
        id: playwright-cache
        with:
          path: ~/.cache/ms-playwright
          key: ${{ runner.os }}-playwright-${{ steps.playwright-version.outputs.version }}
      - if: steps.playwright-cache.outputs.cache-hit != 'true'
        run: npx playwright install --with-deps chromium
      - run: npm test

  publish-preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npm run build
      - run: npx pkg-pr-new publish --peerDeps ./packages/*
```

release ワークフローの concurrency 制御とカスタム changesets スクリプト。

```yaml
# .github/workflows/release.yml -- 安全なリリース
concurrency:
  group: ${{ github.workflow }}
  cancel-in-progress: false  # publish 中のキャンセルを禁止

env:
  NPM_CONFIG_PROVENANCE: true  # パッケージの来歴を暗号的に証明

permissions:
  contents: write
  pull-requests: write
  id-token: write  # trusted publishing に必要

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run build
      - uses: changesets/action@v1
        with:
          version: npx tsx ./.github/changeset-version.ts
          publish: npx tsx ./.github/changeset-publish.ts
```

## Bad Example

```yaml
# Bad: concurrency の使い分けがない
# PR と release で同じ設定を使うと、PR の高速フィードバックか
# release の安全性のどちらかを犠牲にすることになる
concurrency:
  group: ${{ github.workflow }}
  cancel-in-progress: true  # release ジョブもキャンセルされてしまう
```

```yaml
# Bad: Playwright バージョンをハードコードしてキャッシュ
- uses: actions/cache@v5
  with:
    key: playwright-1.42.0  # バージョンアップ時に手動更新が必要
    # lockfile と乖離するとキャッシュが古いブラウザを返し、テストが謎の失敗をする
```

```yaml
# Bad: ブラウザ自動ダウンロードを抑止せず、全ジョブでダウンロードが走る
jobs:
  check:
    steps:
      - run: npm ci  # postinstall で数百 MB のブラウザがダウンロードされる
      - run: npm run check  # ブラウザは不要なのにダウンロード時間がかかる
```

```typescript
// Bad: changesets の制限を知らずに標準コマンドだけで運用
// package-lock.json が更新されず、CI で lockfile 不整合エラーが出る
execSync("npx changeset version", { stdio: "inherit" });
// npm install を忘れている -> package-lock.json が古いまま
```

```yaml
# Bad: PR ワークフローで secrets 付き E2E を実行
# フォークからの PR で secrets にアクセスできず失敗する
- name: Run E2E tests
  env:
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
  run: npx playwright test
```

## 適用ガイド

### どのような状況で使うべきか

- npm パッケージを公開する monorepo で、PR レビュー時にパッケージの動作確認を行いたい場合
- パッケージ間で peer dependencies がある monorepo で、依存解決の問題をマージ前に検出したい場合
- Playwright や Cypress を使うプロジェクトで、CI のブラウザダウンロード時間を最適化したい場合
- changesets で monorepo のバージョン管理をしているが、lockfile の同期漏れや workspace プロトコルの未解決に悩んでいる場合

### 導入時の注意点

- **pkg-pr-new の GitHub App 設定**: pkg-pr-new を使うにはリポジトリに GitHub App をインストールする必要がある。パブリックリポジトリでは無料で利用可能
- **`--peerDeps` フラグの必要性**: monorepo 内のパッケージが peer dependencies として相互参照している場合、`--peerDeps` を付けないとプレビューパッケージで依存解決が失敗する
- **Playwright キャッシュのパス**: `~/.cache/ms-playwright` は Linux のデフォルトパスであり、macOS では `~/Library/Caches/ms-playwright` になる。CI ランナーの OS に合わせてパスを調整すること
- **changesets カスタムスクリプトの根拠を明記する**: Issue URL 付きのコメントを残すことで、アップストリームで修正された場合に不要なコードを除去しやすくなる
- **provenance の有効化**: `NPM_CONFIG_PROVENANCE: true` と `id-token: write` パーミッションの両方が必要。GitHub Actions 以外の CI では別途設定が必要な場合がある

### カスタマイズポイント

- **pkg-pr-new のパッケージ指定**: `./packages/*` の代わりに特定のパッケージのみを指定できる。ビルド時間が長い場合は変更があったパッケージのみに絞ることで CI 時間を短縮できる
- **Playwright のブラウザ選択**: `--with-deps chromium` の代わりに `--with-deps` で全ブラウザをインストールすることもできるが、CI 時間とキャッシュサイズのトレードオフがある
- **チェックの実行順序**: プロジェクトのチェックツール構成に合わせて、失敗コスト（実行時間）の昇順に並べ替える。最も軽量なチェックを先頭に置くことで早期失敗を実現する
- **nightly E2E の頻度**: `schedule` の cron 式を調整して、毎日・毎週・特定曜日のみなど、プロジェクトの規模に合わせた頻度に設定できる

## 参考

- [repos/cloudflare/agents/ci-cd.md](../repos/cloudflare/agents/ci-cd.md) -- CI/CD パイプラインの詳細分析
