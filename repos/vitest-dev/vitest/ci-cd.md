# CI/CD

> リポジトリ: vitest-dev/vitest
> 分析日: 2026-03-06

## 概要

vitest の CI/CD パイプラインは、モノレポの大規模テストスイートを効率的に実行するための高度な戦略を備えている。変更検出による不要なテストスキップ、マルチ OS/Node マトリクスの非対称構成、Rolldown（Vite beta）互換テストの独立ジョブ化、ecosystem-ci によるコメント駆動の下流互換性検証など、CI コスト最適化とリリース品質保証の両立が注目に値する。

## 背景にある原則

- **最小権限の原則 (Principle of Least Privilege)**: ワークフロー冒頭で `permissions: {}` を宣言して GITHUB_TOKEN の権限を全剥奪し、必要なジョブのみで最小限の権限を付与する。サプライチェーン攻撃のリスクを構造的に排除する設計（`.github/workflows/ci.yml:5`, `.github/workflows/cr.yml:9`）

- **変更に比例したフィードバック**: docs や .md ファイルのみの変更ではテストをスキップし、CI リソースを節約する。「変更の影響範囲に応じて検証コストを調整すべき」という原則（`.github/workflows/ci.yml:62-84`）

- **非対称マトリクスによるコスト最適化**: 全組み合わせを網羅するのではなく、主要プラットフォーム（Ubuntu）で全 Node バージョンをテストし、macOS/Windows は最新 Node のみに限定する。「コスト対カバレッジの最適点を探る」という原則（`.github/workflows/ci.yml:89-98`）

- **失敗の独立性**: `fail-fast: false` によって、1つの環境の失敗が他の環境のテスト結果を隠さない。全環境の結果を同時に得ることでデバッグ効率を最大化する（`.github/workflows/ci.yml:98,144,178`）

## 実例と分析

### 変更検出によるスキップ戦略

`changed` ジョブが `tj-actions/changed-files` を使い、docs/`.github`/`.md` のみの変更を検出する。テストジョブはすべて `needs: changed` で依存し、`should_skip` が `true` なら実行しない。

ポイントは `.github/ci.yml` 自体は除外リストから外している（`!.github/workflows/ci.yml`）点にある。CI 設定ファイル自体の変更ではテストを実行する必要があるため、この除外は意図的。

```yaml
# .github/workflows/ci.yml:62-84
changed:
  runs-on: ubuntu-latest
  name: 'Diff: node-latest, ubuntu-latest'
  outputs:
    should_skip: ${{ steps.changed-files.outputs.only_changed == 'true' }}
  steps:
    - uses: actions/checkout@v6
    - name: Get changed files
      id: changed-files
      uses: tj-actions/changed-files@7dee1b0c1557f278e5c7dc244927139d78c0e22a # v47.0.4
      with:
        files: |
          docs/**
          .github/**
          !.github/workflows/ci.yml
          **.md
```

### 非対称マトリクス構成

Ubuntu で Node 20/22/24 の3バージョン、macOS と Windows は最新の Node 24 のみ。これにより 3+1+1=5 ジョブに抑えている（全組み合わせなら 3x3=9 ジョブ）。

```yaml
# .github/workflows/ci.yml:89-98
strategy:
  matrix:
    os: [ubuntu-latest]
    node_version: [20, 22, 24]
    include:
      - os: macos-latest
        node_version: 24
      - os: windows-latest
        node_version: 24
  fail-fast: false
```

さらに `test-cached` と `test-browser` は macOS/Windows のみの専用ジョブとして分離されている。テスト内容（キャッシュテスト、ブラウザテスト）によってジョブを分割し、Ubuntu では不要なマトリクスの膨張を防いでいる。

### Rolldown 互換テストの独立ジョブ化

`test-rolldown` ジョブは、`pnpm-workspace.yaml` の `overrides.vite` を `npm:vite@beta`（Rolldown ベースの Vite）に書き換えてからテストを実行する。通常のテストとは独立しており、`--no-bail` フラグで全テストを最後まで実行する。

```yaml
# .github/workflows/ci.yml:225-227
- name: Install
  run: |
    yq -i '.overrides.vite = "npm:vite@beta"' pnpm-workspace.yaml
    git add . && git commit -m "ci" && pnpm i --prefer-offline --no-frozen-lockfile
```

`git add . && git commit -m "ci"` で lockfile 変更をコミットしているのは、pnpm が dirty working tree でのインストールを拒否するためのワークアラウンド。`--no-frozen-lockfile` と組み合わせて、CI 上で依存を動的に切り替える手法。

### ecosystem-ci: コメント駆動の下流テスト

PR コメントで `/ecosystem-ci run` と入力すると、別リポジトリ `vitest-ecosystem-ci` のワークフローを `workflow_dispatch` で起動する。権限チェックは `getCollaboratorPermissionLevel` で triage 権限の有無を確認し、無許可ユーザには `-1` リアクションで拒否する。

```yaml
# .github/workflows/ecosystem-ci-trigger.yml:10
if: github.repository == 'vitest-dev/vitest' && github.event.issue.pull_request && startsWith(github.event.comment.body, '/ecosystem-ci run')
```

テスト側でも `ECOSYSTEM_CI` 環境変数を参照し、git 操作に依存するテストを `skipIf` でスキップする工夫がある。

```typescript
// test/cli/test/git-changed.test.ts:12
describe.skipIf(process.env.ECOSYSTEM_CI)('forceRerunTrigger', () => {
```

### Composite Actions による DRY 化

`setup-and-cache` と `setup-playwright` を composite action として抽出し、6つのジョブで再利用している。特に `setup-playwright` は lockfile から Playwright バージョンを動的解決してキャッシュキーに使う高度な実装。

```yaml
# .github/actions/setup-playwright/action.yml:10-19
- name: Resolve package versions
  id: resolve-package-versions
  shell: bash
  run: >
    echo "$(
      node -e "
        const fs = require('fs');
        const lockfile = fs.readFileSync('./pnpm-lock.yaml', 'utf8');
        const pattern = (name) => new RegExp(name + ':\\\s+specifier: [\\\s\\\w\\\.^]+version: (\\\d+\\\.\\\d+\\\.\\\d+)');
        const playwrightVersion = lockfile.match(pattern('playwright'))[1];
        console.log('PLAYWRIGHT_VERSION=' + playwrightVersion);
      "
    )" >> $GITHUB_OUTPUT
```

### ビルド成果物の整合性チェック

lint ジョブで `pnpm run build` 後に `git diff --exit-code` を実行し、ビルドで生成されるファイル（LICENSE.md、auto-imports.d.ts 等）がコミットされた状態と一致するか検証する。

```yaml
# .github/workflows/ci.yml:43-45
# check uncommited LICENSE.md, auto-imports.d.ts, etc...
- name: Check stale build artifacts
  run: git diff --exit-code
```

### Continuous Release (pkg.pr.new)

CR ワークフローは main push または `cr-tracked` ラベル付き PR で発火し、`pkg-pr-new` で StackBlitz にプレビューパッケージを公開する。ユーザが PR の変更を即座に試せる仕組み。

```yaml
# .github/workflows/cr.yml:17
if: github.repository == 'vitest-dev/vitest' && (github.ref == 'refs/heads/main' || contains(github.event.pull_request.labels.*.name, 'cr-tracked'))
```

### パブリッシュの安全策

`publish-ci.ts` は環境変数 `VITEST_GENERATE_UI_TOKEN` と `VITE_TEST_WATCHER_DEBUG` の値を検証し、不正な状態でのリリースを防止する。タグのバージョンと `package.json` のバージョンの一致も検証する。

```typescript
// scripts/publish-ci.ts:7-9
if (process.env.VITEST_GENERATE_UI_TOKEN !== 'true' || process.env.VITE_TEST_WATCHER_DEBUG !== 'false') {
  throw new Error(`Cannot release Vitest without VITEST_GENERATE_UI_TOKEN=...`)
}
```

## コード例

```yaml
# .github/workflows/ci.yml:1-5
# permissions: {} でデフォルト権限を全剥奪
name: CI
permissions: {}
```

```yaml
# .github/workflows/ci.yml:16-18
# PR 番号ベースの concurrency グループで重複実行を排除
concurrency:
  group: ci-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
```

```yaml
# .github/workflows/ci.yml:122-128
# !cancelled() で前ステップが失敗してもアーティファクトを保存
- uses: actions/upload-artifact@v7
  if: ${{ !cancelled() }}
  with:
    name: playwright-report-${{ matrix.os }}-node-${{ matrix.node_version }}
    path: test/ui/test-results/
    retention-days: 30
```

## Good Patterns

- **SHA ピン留め + バージョンコメント**: サードパーティ Action を commit SHA で固定しつつ、コメントでバージョンを明示する（`tj-actions/changed-files@7dee1b0c...# v47.0.4`）。再現性とサプライチェーンセキュリティの両立。ただし GitHub 公式 Action（`actions/checkout@v6`）はタグ参照を使い分けている点に注意。

```yaml
# .github/workflows/ci.yml:73
uses: tj-actions/changed-files@7dee1b0c1557f278e5c7dc244927139d78c0e22a # v47.0.4
```

- **ジョブ分割による関心の分離**: lint / test / test-cached / test-browser / test-rolldown を独立ジョブにし、それぞれ最適なマトリクスと実行条件を設定。テスト種別ごとに最適な環境を選択でき、失敗の原因特定が容易。

- **`!cancelled()` によるアーティファクト保全**: テストが失敗しても Playwright レポートをアップロードする。`failure()` ではなく `!cancelled()` を使うことで、手動キャンセル時のみスキップし、失敗時のデバッグ情報を確実に残す。

- **repository guard**: `if: github.repository == 'vitest-dev/vitest'` で fork からの意図しない実行を防止。publish、ecosystem-ci、lock-issues などの特権操作に一貫して適用されている。

## Anti-Patterns / 注意点

- **lockfile 変更の git commit ワークアラウンド**: Rolldown テストで `git add . && git commit -m "ci"` を実行して lockfile 変更をコミットする手法は、CI 上の workaround として機能するが、意図が不明瞭。より明確な方法として、`--no-frozen-lockfile` だけで済むパッケージマネージャ設定を検討すべき。

```yaml
# Bad: CI 上で git commit して lockfile を変更
run: |
  yq -i '.overrides.vite = "npm:vite@beta"' pnpm-workspace.yaml
  git add . && git commit -m "ci" && pnpm i --prefer-offline --no-frozen-lockfile

# Better: pnpm の設定で dirty tree を許容するか、
# 別の workspace overlay メカニズムを使う（利用可能な場合）
```

- **全マトリクスへの暗黙的な timeout 依存**: 全テストジョブに `timeout-minutes: 30` を設定しているが、lint は `timeout-minutes: 10` と差をつけている。タイムアウト値を全ジョブで同一にせず、ジョブの性質に合わせて調整しているのは良いが、テストが遅くなった際に 30 分が長すぎないか定期的に見直す必要がある。

## 導出ルール

- `[MUST]` CI ワークフローの冒頭で `permissions: {}` を宣言し、ジョブレベルで必要最小限の権限のみ付与する
  - 根拠: vitest は全 7 ワークフローで一貫してこのパターンを適用しており、サプライチェーン攻撃のリスクを構造的に排除している

- `[MUST]` サードパーティ GitHub Action は commit SHA でピン留めし、コメントにバージョン番号を併記する
  - 根拠: vitest では `tj-actions/changed-files`、`browser-actions/setup-chrome`、`pnpm/action-setup` 等すべてのサードパーティ Action を SHA 固定している（`.github/workflows/ci.yml:73,107` 等）

- `[SHOULD]` マルチ OS/ランタイム マトリクスは非対称に構成し、主要プラットフォームで全バージョン、副次プラットフォームは最新バージョンのみテストする
  - 根拠: vitest は Ubuntu で Node 20/22/24、macOS/Windows は Node 24 のみとし、ジョブ数を 9 から 5 に削減している

- `[SHOULD]` CI ワークフローに変更検出ジョブを設け、コード変更を伴わない PR（docs、CI 設定等）ではテストをスキップする
  - 根拠: `changed` ジョブが docs/.github/.md のみの変更を検出し、5 つのテストジョブすべてをスキップする（`.github/workflows/ci.yml:62-84`）

- `[SHOULD]` 将来の依存（Vite beta/Rolldown 等）への互換テストは独立ジョブとして `--no-bail` で実行し、通常テストの成功判定に影響させない
  - 根拠: `test-rolldown` ジョブは通常テストとは独立しており、全テストを最後まで実行して互換性の全体像を把握する設計（`.github/workflows/ci.yml:206-250`）

- `[SHOULD]` `concurrency` グループを PR 番号ベースで設定し、同一 PR の古い CI 実行を自動キャンセルする
  - 根拠: <code v-pre>ci-${{ github.event.pull_request.number || github.ref }}</code> + `cancel-in-progress: true` で不要な並走を排除（`.github/workflows/ci.yml:16-18`）

- `[SHOULD]` ビルド生成物をリポジトリにコミットしている場合、CI で `git diff --exit-code` を使って stale な成果物を検出する
  - 根拠: lint ジョブでビルド後に `git diff --exit-code` を実行し、LICENSE.md や auto-imports.d.ts の更新漏れを防止（`.github/workflows/ci.yml:43-45`）

- `[AVOID]` マトリクスの `fail-fast` をデフォルト（`true`）のまま使う。1 環境の失敗で他の環境の結果が隠れる
  - 根拠: vitest は全マトリクスジョブで `fail-fast: false` を明示し、全環境の結果を常に取得している

## 適用チェックリスト

- [ ] ワークフロー冒頭に `permissions: {}` を宣言し、ジョブ単位で最小権限を付与しているか
- [ ] サードパーティ Action を commit SHA でピン留めし、バージョンコメントを付けているか
- [ ] マルチ OS/ランタイム マトリクスが非対称構成になっているか（全組み合わせは不要か検討）
- [ ] docs のみの変更でテストをスキップする変更検出ジョブがあるか
- [ ] `concurrency` + `cancel-in-progress` で同一 PR の重複実行を排除しているか
- [ ] `fail-fast: false` をマトリクスに明示しているか
- [ ] テスト失敗時のデバッグ用アーティファクトを `!cancelled()` 条件でアップロードしているか
- [ ] ビルド生成物がコミットされている場合、`git diff --exit-code` で stale 検出しているか
- [ ] 各ジョブに適切な `timeout-minutes` を設定しているか（lint と test で差をつける）
- [ ] fork からの特権操作を `github.repository` ガードで防止しているか
