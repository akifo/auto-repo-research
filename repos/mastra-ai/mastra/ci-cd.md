# CI/CD

> リポジトリ: mastra-ai/mastra
> 分析日: 2026-02-14

## 概要

100 超のパッケージを擁する大規模 TypeScript モノレポにおける CI/CD パイプライン設計を分析する。35 以上の GitHub Actions ワークフローが、テスト・リント・ビルド検証・リリース・依存更新・Issue トリアージまでを自動化している。特に注目すべきは、Changesets による 3 段階リリース戦略（alpha/stable/snapshot）、Turborepo タスクハッシュを使った変更検出による条件付きテスト実行、そして `workflow_run` イベントを活用したフォーク PR への安全なシークレット注入パターンである。

## 背景にある原則

- **フィードバックループの最小化**: PR で変更のあったパッケージのみテストを実行することで、モノレポのスケールに伴う CI 時間の肥大化を抑制する。Turborepo のタスクハッシュ比較（`.github/actions/turbo-changed/action.yaml`）で推移的依存を含む変更検出を行い、変更がなければテストをスキップして即座に success ステータスを返す設計がこれを体現している。

- **信頼境界の明示的分離**: フォーク PR からのコードに secrets を渡さず、`workflow_run` イベント経由で本体リポジトリのコンテキストからテストを実行する。さらに「trusted actions」パターンで、PR のコードが含むアクション定義ではなくベースブランチのアクション定義を使うことでサプライチェーン攻撃を防ぐ（`vitest-changed.yml:69-79`）。

- **リリースチャネルの段階的品質保証**: prerelease（alpha）-> stable -> snapshot という 3 チャネルで、変更が段階的に品質ゲートを通過する。alpha は main マージ時に自動公開、stable は手動トリガーのみ、snapshot はフィーチャーブランチからの ad-hoc テスト用という明確な役割分担がある。

- **Bot アイデンティティの一元管理**: GitHub App（Dane）のトークンで git 操作・PR 作成・パッケージ公開を行い、個人トークンへの依存を排除する。`.github/actions/app-auth/action.yaml` で認証・git 設定・`.netrc` 書き込みを composite action に集約し、全ワークフローで再利用する。

## 実例と分析

### 多層テスト戦略: PR から main マージまでの品質ゲート

テストパイプラインは 4 層に分かれている。

**第 1 層: PR 直接トリガー（lint.yml）** -- `pull_request` イベントで即座に実行。リント・フォーマット・ビルド検証・package.json バリデーション・peer dependency チェックを並列実行する。secrets 不要な検証のみで構成され、フォーク PR でも安全に動作する。

**第 2 層: Prebuild -> workflow_run チェーン** -- `prebuild.yml` が PR の `pull_request` イベントでビルドを実行し、成功すると `workflow_run` イベントが発火。これを受けて `vitest-changed.yml` や各 `secrets.test-*.yml` が PR の変更に対応するテストを実行する。この 2 段階構成により、ビルド済みの状態でのみテストを開始でき、secrets も安全に注入できる。

**第 3 層: パッケージ固有テスト（secrets.test-*.yml）** -- core, memory, rag, mcp など機能領域ごとに独立したワークフローを持つ。各ワークフローは `turbo-changed` アクションで対象パッケージの変更を検出し、変更がなければスキップする。変更検出は Turborepo のタスクハッシュを使い、推移的依存も含めて判定する。

**第 4 層: E2E テスト（secrets.e2e.yml）** -- monorepo 構成・no-bundling・CommonJS・deployers・type-check など複数の利用形態を個別ジョブで検証する。

### テスト分割と並列化

::: v-pre
```
# vitest-all.yml:19-20, 47-54 -- 4 シャードに分割して並列実行
strategy:
  fail-fast: false
  matrix:
    shard: [1, 2, 3, 4]

# 実行時
pnpm vitest run \
  --project 'unit:*' --project 'typecheck:*' \
  --reporter=blob \
  --shard=${{ matrix.shard }}/4 \
  --passWithNoTests
```
:::

`fail-fast: false` により、1 シャードの失敗が他のシャードを中断しない。Vitest の blob reporter で各シャードの結果をアーティファクトとして保存し、`merge-reports` ジョブで統合する。

ルートの `vitest.config.ts` は全パッケージの vitest 設定を動的に探索し、各パッケージの `unit:*`、`e2e:*`、`typecheck:*` プロジェクトをネスト展開する仕組みを持つ。CI のユニットテストと E2E テストは別々のマトリクスジョブで並列化される。

### Trusted Actions パターン: フォーク PR のセキュリティ

::: v-pre
```yaml
# vitest-changed.yml:67-79
- name: Checkout trusted actions from base branch
  uses: actions/checkout@v5
  with:
    ref: ${{ github.event.workflow_run.head_branch == '0.x' && '0.x' || 'main' }}
    sparse-checkout: .github/actions
    path: trusted-actions

- name: Use trusted actions
  run: |
    rm -rf .github/actions
    cp -r trusted-actions/.github/actions .github/actions
```
:::

PR のコードをチェックアウトした後、ベースブランチからアクション定義のみを sparse-checkout で取得し、PR 由来のアクションを上書きする。これにより、悪意ある PR がアクション定義を改竄してもシークレットを窃取できない。

### Changesets による 3 チャネルリリース

```json
// .changeset/config.json:8
"fixed": [
  ["@mastra/core", "@mastra/server", "@mastra/deployer", "@mastra/deployer-cloud"],
  ["mastra", "create-mastra", "@internal/playground"]
]
```

`fixed` グループにより、core/server/deployer は常に同一バージョンで公開される。これはこれらのパッケージ間の密結合を認めつつ、ユーザーにとってのバージョン不整合を防ぐ設計判断である。

リリースフロー:

1. PR に changeset ファイルを含める
2. main マージ時に `version-packages.yml` が changeset/action でバージョン PR を自動作成
3. バージョン PR マージ時のコミットメッセージ `chore: version packages` を npm-publish.yml が検知し、alpha タグで自動公開
4. 手動で `npm-publish.yml` の stable を dispatch すると、prerelease モード解除 -> stable 公開 -> prerelease モード再突入を自動実行
5. フィーチャーブランチから snapshot を dispatch すると、ブランチ名をスラグ化した npm タグで公開

さらに `publish-alpha-tags.js` が stable リリース後に全パッケージの現在バージョンに `alpha` dist-tag も付与することで、alpha チャネルのユーザーが stable 後も最新版を取得できるようにしている。

### Turbo Remote Cache の読み書き制御

```yaml
# prebuild.yml -- ビルドキャッシュは読み書き両方
TURBO_CACHE: remote:rw

# vitest-changed.yml -- テスト時はキャッシュ読み取りのみ
TURBO_CACHE: remote:r

# lint.yml -- リントもキャッシュ読み書き
TURBO_CACHE: remote:rw
```

ビルドとリントはキャッシュに書き込み、テスト実行はキャッシュを読み取りのみで使う。テスト結果のキャッシュは意図しない偽陽性を招くため読み取り専用にする判断が見える。

### PR ステータス管理の統一パターン

::: v-pre
```yaml
# .github/workflows/shared-actions/set-pr-status/action.yml:37-52
- name: Set PR Status
  shell: bash
  env:
    GH_TOKEN: ${{ inputs.github_token }}
  run: |
    gh api repos/${{ github.repository }}/statuses/${{ inputs.sha }} \
      --method POST \
      --field state="${{ inputs.status }}" \
      --field context="${{ inputs.context }}" \
      --field description="${{ inputs.description }}"
```
:::

GitHub Checks API ではなく Commit Status API を使い、`workflow_run` 経由のジョブでも PR に正しくステータスを表示する。各テストワークフローは pending -> (skip-tests で success | test で success/failure) という 3 分岐パターンを統一的に実装している。

### 破壊的変更の人的ゲート

```yaml
# major-version-check.yml:148-149 -- "!allow-major" コメントによる承認
const approvalComments = comments.filter(
  comment => comment.body.trim().toLowerCase() === '!allow-major'
);
```

changeset に `major` バンプが含まれる PR は、Organization メンバーが `!allow-major` とコメントしない限りマージできない。`issue_comment` イベントでも再評価されるため、後から承認を追加できる。PR の base SHA からアクション定義をチェックアウトし、PR 側の改竄を防ぐ二重防御も行っている。

### 自動化された依存更新パイプライン

Renovate は self-hosted で 6 時間ごとに実行され（`renovate.yml`）、更新 PR には `sync_renovate-changesets.yml` が自動で changeset を追加し、examples/e2e-tests の lockfile を更新した上で自動承認する。`renovate.json` では `minimumReleaseAge: "3 days"` で新バージョンの安定性を確認し、`groupName` で関連パッケージの更新をグループ化している。major 更新は `dependencyDashboardApproval: true` で手動承認を要する。

### 定期的な自動生成とコミット

`regenerate-provider-registry.yml` が 6 時間ごとにプロバイダレジストリとモデルドキュメントを再生成する。変更がある場合のみ changeset を作成してコミットし、`[skip ci]` でテストの無限ループを防ぐ。既存の automated changeset が存在する場合は重複作成をスキップする冪等な設計。

## パターンカタログ

- **Pipeline パターン** (振る舞い)
  - 解決する問題: 複数の品質ゲートを順序立てて実行し、早期に失敗をフィードバックする
  - 適用条件: ビルド -> テスト -> デプロイのように前段の成功が後段の前提となる場合
  - コード例: `prebuild.yml` -> `vitest-changed.yml`（`workflow_run` で連鎖）
  - 注意点: `workflow_run` はデフォルトブランチのワークフロー定義で実行されるため、新規ワークフローは main マージ後に初めて発火する

- **Strategy パターン** (振る舞い)
  - 解決する問題: 同一インターフェースで異なるテスト戦略を切り替える
  - 適用条件: パッケージごとに異なるテスト要件（サービスコンテナ、API キー、タイムアウト）がある場合
  - コード例: `secrets.test-memory.yml`（Postgres + Redis サービスコンテナ）vs `secrets.test-core.yml`（API キーのみ）
  - 注意点: ワークフロー数が増えすぎると管理コストが上がるため、共通部分のアクション化が重要

## Good Patterns

- **Composite Action によるセットアップの DRY 化**: `setup-pnpm-node` アクションで pnpm + Node.js + install を 1 ステップに集約。オプションパラメータ（`install-dependencies`, `package-manager-cache`）で柔軟性を確保しつつ、全ワークフローのセットアップを統一する。

::: v-pre
```yaml
# .github/actions/setup-pnpm-node/action.yaml:14-33
runs:
  using: composite
  steps:
    - uses: pnpm/action-setup@v4
    - uses: actions/setup-node@v6
      with:
        node-version: 22.13.0
        cache: 'pnpm'
    - if: ${{ inputs.install-dependencies == 'true' }}
      run: pnpm install --frozen-lockfile
```
:::

- **Concurrency グループによる重複実行の排除**: ワークフローごとに適切な concurrency キーを設定し、同一 PR への連続 push で古い実行をキャンセルする。

::: v-pre
```yaml
# prebuild.yml:8-10
concurrency:
  group: ${{ github.workflow }}-${{ github.head_ref || github.run_id }}
  cancel-in-progress: true

# vitest-changed.yml:9-11 -- workflow_run では head_sha をキーに
concurrency:
  group: ${{ github.workflow }}-${{ github.event.workflow_run.head_sha }}
  cancel-in-progress: true
```
:::

- **権限の最小化**: ワークフローレベルで `permissions: {}` を宣言し、ジョブごとに必要な権限のみを付与する。

```yaml
# vitest-all.yml:11-12
permissions: {}
# ...各ジョブ内で
permissions:
  contents: read
```

- **Turbo タスクハッシュによる変更検出**: `turbo-changed` アクションが Turborepo の `--dry-run=json` で HEAD とベースブランチのタスクハッシュを比較し、推移的依存を含む正確な変更検出を行う。turbo.json の `inputs` 設定を自動的に尊重するため、README の変更でテストが発火しない。

```yaml
# .github/actions/turbo-changed/action.yaml:63-73
get_all_task_hashes() {
  local task=$1
  local filter_args=$2
  turbo "$task" $filter_args --dry-run=json 2>/dev/null | \
    jq -r '.tasks[] | "\(.package)#\(.task)=\(.hash)"'
}
```

- **カスタム changeset CLI によるリリースオペレーション**: `pnpm changeset-cli` で標準 changeset CLI をラップし、`pre enter/exit`、`version`、`tag` をカスタム実装。バックポート（`backport.ts`）もこの CLI に統合されている。

## Anti-Patterns / 注意点

- **ワークフロー間の暗黙的な依存**: `npm-publish.yml` は `version-packages.yml` が作成したバージョン PR のマージコミットメッセージ（`chore: version packages`）をトリガーとする。この暗黙の依存はコミットメッセージの変更で壊れるリスクがある。

```yaml
# Bad: コミットメッセージで連携
if: startsWith(github.event.head_commit.message, 'chore: version packages')

# Better: 明示的なワークフロー連携（workflow_call や repository_dispatch）
on:
  workflow_call:
    inputs:
      publish_type:
        type: string
```

- **セットアップの重複**: `npm-publish.yml` や `create-release.yml` では `setup-pnpm-node` アクションを使わず、pnpm + Node.js を手動でセットアップしている箇所がある。Node.js バージョンも 22 と 24 が混在している。

```yaml
# Bad: npm-publish.yml:58-62 -- 手動セットアップ + Node 24
- name: Setup Node.js 24.x
  uses: actions/setup-node@v5
  with:
    node-version: 24

# Better: 共通アクション使用で Node バージョンを一元管理
- uses: ./.github/actions/setup-pnpm-node
```

## 導出ルール

- `[MUST]` `workflow_run` 経由で PR コードを実行する場合、ベースブランチからアクション定義を取得して PR 由来のアクションを置換する（Trusted Actions パターン）
  - 根拠: `vitest-changed.yml:67-79` で PR のアクション定義を信頼せず、main/0.x ブランチから sparse-checkout で上書きしている

- `[MUST]` モノレポの CI では、変更のないパッケージのテストをスキップする仕組みを設け、スキップ時にも明示的に success ステータスを返す
  - 根拠: `secrets.test-core.yml:51-67` で変更なしの場合 `skip-tests` ジョブが success ステータスを設定し、required check のブロックを回避している

- `[SHOULD]` リリースワークフローは prerelease/stable/snapshot の複数チャネルを設け、alpha は自動公開、stable は手動トリガーで段階的に品質保証する
  - 根拠: `npm-publish.yml` で 3 種の publish_type を使い分け、alpha は main 直接、stable は workflow_dispatch、snapshot はフィーチャーブランチから公開する

- `[SHOULD]` CI のセットアップ手順（言語ランタイム・パッケージマネージャ・依存インストール）は composite action に集約し、全ワークフローで再利用する
  - 根拠: `setup-pnpm-node` アクションが 20 以上のワークフローで使われ、Node.js バージョンやキャッシュ設定の一元管理を実現している

- `[SHOULD]` ワークフローレベルで `permissions: {}` を宣言し、ジョブごとに必要最小限の権限のみを付与する
  - 根拠: `vitest-all.yml:12` でワークフロー全体の権限を空にし、各ジョブで `contents: read` のみ付与している

- `[SHOULD]` ビルドキャッシュの読み書き権限を役割で分離する（ビルド: rw、テスト: r のみ）
  - 根拠: prebuild.yml で `TURBO_CACHE: remote:rw`、テスト系で `remote:r` を使い分け、テスト結果の誤キャッシュを防いでいる

- `[SHOULD]` 破壊的変更（major バージョンバンプ）には、自動チェック + 人的承認の二重ゲートを設ける
  - 根拠: `major-version-check.yml` が changeset の major 検出 -> org メンバーの `!allow-major` コメント確認 -> Checks API で結果報告、という多層防御を実装している

- `[AVOID]` コミットメッセージの文字列マッチでワークフロー間を連携させること（暗黙的で壊れやすい）
  - 根拠: `npm-publish.yml:43` が `chore: version packages` というコミットメッセージに依存しており、メッセージ変更時に連携が壊れるリスクがある

- `[AVOID]` 依存更新 PR を手動でレビュー・承認すること（自動化で changeset 追加 + lockfile 更新 + 承認を一括処理すべき）
  - 根拠: `sync_renovate-changesets.yml` が Renovate PR に自動で changeset を追加し、lockfile を更新した上で `gh pr review --approve` で自動承認している

## 適用チェックリスト

- [ ] モノレポの CI で変更検出（Turborepo hash、paths-filter 等）を導入し、未変更パッケージのテストをスキップしているか
- [ ] テストスキップ時に required check の success ステータスを明示的に返す `skip-tests` ジョブがあるか
- [ ] フォーク PR で secrets を使うワークフローは `workflow_run` 経由で実行し、trusted actions パターンを適用しているか
- [ ] セットアップ手順（ランタイム、パッケージマネージャ、キャッシュ）が composite action に集約され、全ワークフローで共有されているか
- [ ] リリースが複数チャネル（prerelease、stable、snapshot）に分かれ、それぞれ適切なトリガー（自動/手動）を持っているか
- [ ] Changesets の `fixed` グループで密結合パッケージのバージョンを同期しているか
- [ ] ワークフローの `permissions` がジョブレベルで最小限に設定されているか
- [ ] `concurrency` グループで同一 PR への連続 push 時に古い実行をキャンセルしているか
- [ ] 破壊的変更に対する人的承認ゲート（major version check 等）が CI に組み込まれているか
- [ ] 依存更新（Renovate/Dependabot）が changeset ベースのリリースフローに統合されているか
