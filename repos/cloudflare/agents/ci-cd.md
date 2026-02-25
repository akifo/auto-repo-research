# CI/CD

> リポジトリ: cloudflare/agents
> 分析日: 2026-02-25

## 概要

cloudflare/agents は changesets ベースのリリース、pkg-pr-new による PR プレビューパブリッシュ、Playwright ブラウザキャッシュ戦略を組み合わせた CI/CD パイプラインを構築している。4 つのワークフロー（pullrequest, release, nightly, bonk）が役割ごとに明確に分離され、concurrency 制御と paths-ignore による無駄なビルドの排除が徹底されている。リリースワークフローではカスタム TypeScript スクリプトで changesets の既知の制限（package-lock.json の未更新、workspace プロトコルの未解決）を補完しており、実用的な回避策として注目に値する。

## 背景にある原則

- **フィードバックループの最小化**: PR ワークフローで `paths-ignore` により docs/design/changeset の変更を除外し、`cancel-in-progress: true` で同一 PR の古い実行をキャンセルする。check/test/publish-preview の 3 ジョブが並列実行され、不要な待ち時間を排除している。一方で release ワークフローでは `cancel-in-progress: false` とし、公開作業の中断を防止する。速度と安全性のバランスを concurrency 設定で制御する原則。

- **重い依存の遅延ダウンロード**: Playwright ブラウザのような大きなバイナリ依存は CI の全ジョブで必要なわけではない。`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1"` をワークフローレベルの環境変数で設定し、テストジョブでのみキャッシュ経由でインストールする。「デフォルトは無効、必要な場所でのみ有効化」という原則。

- **リリースの原子性と来歴保証**: changesets/action で version と publish を単一ジョブ内で実行し、`NPM_CONFIG_PROVENANCE: true` + `id-token: write` で npm の trusted publishing を有効化する。パッケージの出所を暗号的に証明し、サプライチェーン攻撃のリスクを軽減する原則。

- **ビルド成果物の検証を CI に組み込む**: `check:exports` スクリプトが package.json の exports フィールドに列挙されたファイルが実際に存在するかを検証する。ビルド後に実行することで「宣言と成果物の乖離」を自動検出し、壊れたパッケージの公開を防止する原則。

## 実例と分析

### ワークフローの分離設計

4 つのワークフローが異なるトリガーと責務を持つ:

| ワークフロー | トリガー                                         | 責務                             | cancel-in-progress |
| ------------ | ------------------------------------------------ | -------------------------------- | ------------------ |
| pullrequest  | `pull_request` (paths-ignore あり)               | lint + test + preview publish    | true               |
| release      | `push` to main                                   | changesets version + npm publish | false              |
| nightly      | `schedule` (毎日 0:00 UTC) + `workflow_dispatch` | E2E テスト（実 API 接続）        | true               |
| bonk         | `issue_comment` / `pr_review_comment`            | AI アシスタント応答              | false              |

PR ワークフローの `paths-ignore` は docs、design、Markdown、changeset ファイルを除外する。これにより README やドキュメントのみの変更で不要なビルドが走らない。

```yaml
# .github/workflows/pullrequest.yml:4-9
on:
  pull_request:
    paths-ignore:
      - "docs/**"
      - "design/**"
      - "*.md"
      - ".changeset/**"
```

concurrency グループの設計も重要で、PR ワークフローは PR 番号ごとのグループで古い実行をキャンセルし、release ワークフローはワークフロー名のみのグループでキャンセルを禁止する:

```yaml
# .github/workflows/pullrequest.yml:11-13
concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number }}
  cancel-in-progress: true

# .github/workflows/release.yml:8-10
concurrency:
  group: ${{ github.workflow }}
  cancel-in-progress: false
```

### Playwright ブラウザキャッシュ戦略

Playwright ブラウザは数百 MB のバイナリであり、毎回ダウンロードすると CI 時間を大幅に消費する。このリポジトリでは 3 層の戦略で対処している:

**第 1 層: デフォルトの自動ダウンロードを抑止**

ワークフローレベルの `env` で `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1"` を設定し、`npm ci` 時の postinstall による自動ダウンロードを無効化する。これは release ワークフローなどテストを実行しないジョブでも効果がある。

```yaml
# .github/workflows/pullrequest.yml:15-16
env:
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1"
```

**第 2 層: package-lock.json からバージョンキーを抽出してキャッシュ**

`jq` で package-lock.json から Playwright の正確なバージョンを抽出し、キャッシュキーに使用する。Playwright のバージョンが変わるとキャッシュが自動的に無効化される:

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

`cache-hit` 出力を条件に、キャッシュが存在しない場合のみブラウザをインストールする。`--with-deps chromium` で Chromium のみをインストールし、不要なブラウザ（Firefox, WebKit）のダウンロードを回避する:

```yaml
# .github/workflows/pullrequest.yml:64-65
- name: Install Playwright browsers
  if: steps.playwright-cache.outputs.cache-hit != 'true'
  run: npx playwright install --with-deps chromium
```

### カスタム changesets リリーススクリプト

changesets/action の `version` と `publish` コマンドにカスタムスクリプトを指定して、標準ワークフローの制限を補完している:

**changeset-version.ts**: `changeset version` 実行後に `npm install` を追加実行して package-lock.json を更新する。これは changesets の既知の Issue (#421) への回避策:

```typescript
// .github/changeset-version.ts:1-13
import { execSync } from "node:child_process";

// This script is used by the `release.yml` workflow to update the version of the packages being released.
// The standard step is only to run `changeset version` but this does not update the package-lock.json file.
// So we also run `npm install`, which does this update.
// This is a workaround until this is handled automatically by `changeset version`.
// See https://github.com/changesets/changesets/issues/421.
execSync("npx changeset version", { stdio: "inherit" });
execSync("npm install", { stdio: "inherit" });
```

**changeset-publish.ts**: publish 前に `resolve-workspace-versions.ts` を実行して `workspace:*` プロトコルを実際のバージョンに解決する:

```typescript
// .github/changeset-publish.ts:1-8
import { execSync } from "node:child_process";

execSync("npx tsx ./.github/resolve-workspace-versions.ts", {
  stdio: "inherit",
});
execSync("npx changeset publish", { stdio: "inherit" });
```

**resolve-workspace-versions.ts**: 全パッケージの package.json をスキャンし、monorepo 内の依存関係を `^<実バージョン>` に書き換える。`0.0.0-` プレフィックス（nightly ビルド）の場合はキャレットを付けない:

```typescript
// .github/resolve-workspace-versions.ts:62-64
let actualVersion = packageJsons[dependencyName].packageJson.version;
if (!actualVersion.startsWith("0.0.0-")) {
  actualVersion = `^${actualVersion}`;
}
```

### pkg-pr-new による PR プレビュー

PR の publish-preview ジョブが `pkg-pr-new publish --peerDeps ./packages/*` を実行し、PR 単位のプレビューパッケージを公開する。`--peerDeps` フラグにより、peerDependencies もプレビューバージョンに解決される。これにより、レビュアーはマージ前にパッケージをインストールして動作確認できる:

```yaml
# .github/workflows/pullrequest.yml:85-86
- name: Publish packages to pkg.pr.new
  run: npx pkg-pr-new publish --peerDeps ./packages/*
```

### 多層チェックの統合

`npm run check` コマンドが 5 つのチェックを直列実行する。失敗が早い順（低コスト順）に並べることで、高コストなチェック（typecheck）に到達する前に問題を検出する:

```json
// package.json:23
"check": "sherif && npm run check:exports && oxfmt --check . && oxlint examples/ packages/ guides/ openai-sdk/ site/ && npm run typecheck"
```

1. **sherif**: monorepo の依存関係整合性チェック（最軽量）
2. **check:exports**: ビルド成果物が exports 宣言と一致するか検証
3. **oxfmt --check**: フォーマットチェック
4. **oxlint**: Lint チェック
5. **typecheck**: 全 tsconfig.json の型チェック（並列実行、最重量）

typecheck スクリプトは CPU コア数に基づく並列度で全プロジェクトを同時にチェックする:

```typescript
// scripts/typecheck.ts:15-18
const concurrency = Math.max(os.cpus().length, 2);
console.log(
  `Typechecking ${tsconfigs.length} projects (${concurrency} concurrent)...`,
);
```

### Nightly E2E の分離

秘匿情報（Cloudflare API トークン）を必要とする E2E テストは nightly ワークフローに分離されている。PR ワークフローでは secrets にアクセスできないフォークからの PR も安全に実行できるようにしている:

```yaml
# .github/workflows/nightly.yml:47-51
- name: Run ai-chat e2e tests
  env:
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
  run: npx playwright test --config e2e/playwright.config.ts
```

Playwright の設定でも CI 環境を意識して `reuseExistingServer: !process.env.CI` としている。ローカル開発では既存のサーバーを再利用して高速化し、CI では常に新しいサーバーを起動して再現性を保証する:

```typescript
// packages/ai-chat/e2e/playwright.config.ts:24
reuseExistingServer: !process.env.CI,
```

### changeset の ignore パターン

changeset config で `@cloudflare/agents-*` を ignore に指定し、内部パッケージ（repo-level のワークスペースパッケージ名 `@cloudflare/agents-repo` など）を changesets の対象外としている:

```json
// .changeset/config.json:13
"ignore": ["@cloudflare/agents-*"]
```

## Good Patterns

- **環境変数でブラウザ自動ダウンロードを抑止 + キャッシュで補完**: `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` でデフォルトのダウンロードを無効化し、必要なジョブでのみ `actions/cache` + 条件付きインストールを行う。ブラウザバージョンを lockfile から抽出してキャッシュキーに使うことで、バージョンアップ時の自動キャッシュ無効化も実現する。

```yaml
env:
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1"
# ...
- run: echo "version=$(jq -r '.packages["node_modules/playwright"].version' package-lock.json)" >> $GITHUB_OUTPUT
- uses: actions/cache@v5
  with:
    key: ${{ runner.os }}-playwright-${{ steps.playwright-version.outputs.version }}
- if: steps.playwright-cache.outputs.cache-hit != 'true'
  run: npx playwright install --with-deps chromium
```

- **concurrency の使い分け**: PR ワークフローは `cancel-in-progress: true` で高速フィードバック、release ワークフローは `cancel-in-progress: false` で安全なリリースを実現する。同じ仕組みを目的に応じて反転させるパターン。

- **カスタムスクリプトによる changesets の制限補完**: changesets の既知の問題（lockfile 未更新、workspace プロトコル未解決）をカスタム TypeScript スクリプトで解決する。問題の根拠を Issue URL 付きのコメントで残しており、将来的にアップストリームで修正された場合に不要なコードを除去しやすい。

- **チェックの失敗コスト順実行**: `sherif && check:exports && oxfmt && oxlint && typecheck` の順で、軽量で速いチェックを先に実行し、早期失敗を実現する。

## Anti-Patterns / 注意点

- **E2E テストの wrangler プロセス kill がプラットフォーム依存**: Playwright config のポート kill コマンドが `lsof -ti tcp:${PORT} | xargs kill -9` と Linux/macOS 前提で、Windows CI では動作しない。CI ランナーが ubuntu 固定なら問題ないが、マルチプラットフォーム化時に壊れる。

```typescript
// Bad: プラットフォーム依存の kill コマンド
command: `lsof -ti tcp:${PORT} | xargs kill -9 2>/dev/null; npx wrangler dev ...`;

// Better: cross-platform な kill-port パッケージを使うか、webServer.timeout でのみ制御する
command: `npx kill-port ${PORT} 2>/dev/null; npx wrangler dev ...`;
```

- **check ジョブと test ジョブが npm ci + npm run build を重複実行**: pullrequest.yml の check ジョブと test ジョブはそれぞれ独立して `npm ci` と `npm run build` を実行する。並列実行のメリットはあるが、ビルド成果物をアーティファクトとして共有すれば合計ビルド時間を削減できる可能性がある。ただし、ジョブ間の依存を作ることでフィードバックの遅延が発生するトレードオフがある。

## 導出ルール

- `[MUST]` CI でブラウザテストを実行する場合、ブラウザバイナリの自動ダウンロードをデフォルトで無効化し、テストジョブでのみキャッシュ付きインストールを行う
  - 根拠: cloudflare/agents では `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1"` をワークフローレベルで設定し、release ジョブ等の不要なダウンロードを排除している（`pullrequest.yml:16`、`release.yml:14`）

- `[MUST]` リリースワークフローの concurrency 設定で `cancel-in-progress: false` を指定し、パブリッシュ中のジョブがキャンセルされないようにする
  - 根拠: cloudflare/agents の release.yml は `cancel-in-progress: false` で npm publish の中断を防止している（`release.yml:10`）

- `[SHOULD]` CI のチェックコマンドは失敗コスト（実行時間）の昇順で直列実行し、低コストなチェックで早期失敗させる
  - 根拠: cloudflare/agents の `check` スクリプトは sherif(最軽量) -> exports -> format -> lint -> typecheck(最重量) の順で実行する（`package.json:23`）

- `[SHOULD]` changesets の version コマンドをカスタマイズする場合、`changeset version` 後に `npm install` を実行して lockfile を同期する
  - 根拠: changesets は package-lock.json を自動更新しない既知の問題（#421）があり、カスタムスクリプトで補完している（`.github/changeset-version.ts:6-7`）

- `[SHOULD]` monorepo で workspace プロトコル（`workspace:*`）を使用する場合、publish 前にワークスペース参照を実バージョンに解決するスクリプトを挟む
  - 根拠: `resolve-workspace-versions.ts` が全パッケージの依存を走査し `^<実バージョン>` に書き換えている（`.github/resolve-workspace-versions.ts:47-78`）

- `[SHOULD]` 秘匿情報を必要とする E2E テストは PR ワークフローから分離し、nightly または手動トリガーのワークフローで実行する
  - 根拠: nightly.yml が `workflow_dispatch` と `schedule` でのみ secrets 付き E2E を実行し、フォークからの PR でも安全にチェックを通せる設計（`nightly.yml:1-52`）

- `[SHOULD]` npm パッケージの公開時は `NPM_CONFIG_PROVENANCE: true` と `id-token: write` パーミッションを設定して、パッケージの来歴（provenance）を保証する
  - 根拠: release.yml で trusted publishing を有効化し、サプライチェーンの透明性を確保している（`release.yml:17-18`, `release.yml:47`）

- `[AVOID]` Playwright ブラウザのキャッシュキーにハードコードされたバージョン文字列を使わない。lockfile から動的に抽出し、バージョンアップ時のキャッシュ不整合を防ぐ
  - 根拠: `jq -r '.packages["node_modules/playwright"].version' package-lock.json` で常に lockfile と同期するキーを生成している（`pullrequest.yml:53`）

## 適用チェックリスト

- [ ] ブラウザテスト（Playwright/Cypress）がある場合、ブラウザの自動ダウンロードをワークフローレベルで無効化しているか
- [ ] ブラウザキャッシュのキーが lockfile のバージョンと連動しているか（ハードコードでないか）
- [ ] PR ワークフローに `cancel-in-progress: true`、release ワークフローに `cancel-in-progress: false` を設定しているか
- [ ] CI のチェックコマンドが実行コスト昇順で並んでいるか（軽量チェックが先頭か）
- [ ] changesets 使用時、lockfile の同期漏れがないか（カスタム version スクリプトの必要性を確認）
- [ ] monorepo の workspace プロトコルが publish 前に実バージョンに解決されているか
- [ ] secrets を必要とするテストが PR ワークフローから分離されているか
- [ ] npm publish で provenance（`NPM_CONFIG_PROVENANCE`）を有効化しているか
- [ ] `paths-ignore` でドキュメントのみの変更が不要なビルドをトリガーしないようになっているか
- [ ] ビルド成果物と package.json の exports 宣言の整合性を CI で検証しているか
