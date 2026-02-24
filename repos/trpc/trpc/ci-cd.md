# CI/CD

> リポジトリ: trpc/trpc
> 分析日: 2026-02-24

## 概要

tRPC の CI/CD パイプラインは、11 の GitHub Actions ワークフローで構成されたモノレポ向けリリース戦略を実現している。特徴的なのは、canary / tmp / prerelease / manual の 4 段階のリリースチャネルを使い分け、メインブランチへのプッシュだけで自動 canary パブリッシュが走る仕組みである。E2E テストは Node / Deno / Bun の 3 ランタイムに対応したマトリクスで実行され、`continue-on-error: true` によりメインパイプラインをブロックしない設計が採用されている。加えて、PR ごとに `pkg-pr-new` で即座にインストール可能なパッケージが公開される仕組みは、ライブラリ開発における高速フィードバックループの好例である。

## 背景にある原則

- **リリースチャネルの分離で安全にイテレーションする**: 安定版 (`latest`)、プレリリース (`next`)、canary (`canary`)、一時ブランチ (`tmp`) の 4 チャネルを npm dist-tag で分離し、ユーザーが意図的にオプトインしない限り不安定なバージョンが配信されない。根拠: `release-canary.yml:34` の `--dist-tag canary`、`release-manual.yml:50` の <code v-pre>--dist-tag ${{ inputs.dist_tag }}</code>
- **E2E テストの信頼性とパイプライン速度はトレードオフにせず共存させる**: E2E テストは `continue-on-error: true` で実行しつつ結果は可視化する。これにより「不安定な E2E テストが原因で PR がマージできない」問題を回避しながら、リグレッション検知の機会を保つ。根拠: `main.yml:109`
- **CI の共通セットアップを Composite Action に集約し、ワークフロー間の不整合を防ぐ**: 全ワークフローが `.github/setup` を参照し、Node バージョン・pnpm キャッシュ戦略が 1 箇所で管理される。根拠: `.github/setup/action.yml`
- **PR 品質ゲートとリリースフローを分離する**: PR 時は build / typecheck / test / lint のみ実行し、リリース処理は main ブランチへのプッシュまたは手動トリガーでのみ発火する。CI の責務が明確に分かれている。根拠: `main.yml:15` の `if: github.event_name == 'pull_request'`

## 実例と分析

### 4 段階のリリースチャネル

tRPC は npm の dist-tag 機能を活用して 4 つのリリースチャネルを運用している。

1. **canary** (`release-canary.yml`): main ブランチへの push で自動発火。`--preid canary --dist-tag canary` で lerna canary publish する。`packages/**` の変更のみがトリガーだが、`!packages/**/package.json` で package.json の変更（バージョンバンプ等）は除外している
2. **tmp** (`release-tmp.yml`): 特定のフィーチャーブランチから一時的にパブリッシュする。preid にブランチ名を含め (`alpha-tmp-$(pnpm --silent current-branch)`)、dist-tag は `tmp` を使用する。ブランチ名はワークフローファイルに直接ハードコードされており、使う側が都度書き換える運用
3. **prerelease** (`package.json` の `publish-prerelease` スクリプト): `lerna publish prerelease --dist-tag next` で next タグにリリースする。ローカルから実行する想定
4. **manual** (`release-manual.yml`): `workflow_dispatch` で patch / minor を選択し、任意の dist-tag で安定版をリリースする。OIDC ベースの npm provenance 署名付き

### Semantic PR タイトル検証の動的スコープ生成

`semantic-pr.yml` は Conventional Commits フォーマットの PR タイトルを検証するが、許可スコープのリストをハードコードせず、`packages/` 配下の `package.json` の `name` フィールドから動的に生成している。

```bash
# semantic-pr.yml:38-43
ALL_SCOPES=$(find packages -maxdepth 2 -name "package.json" -type f \
    | xargs -I {} jq -r '.name // empty' {} \
    | sed 's/^@trpc\///' \
    | grep -v '^$' \
    | (cat && echo "$ADDITIONAL_SCOPES" | tr ',' '\n') \
    | sort -u)
```

パッケージの追加・削除に追従して検証ルールが自動更新されるため、メンテナンスコストが低い。fork PR でもベースブランチの package 一覧を checkout することで正しいスコープが参照される (`semantic-pr.yml:28-29`)。

### autofix-ci による自動修正コミット

`lint.yml` ワークフローは lint / manypkg fix / format-fix を `failure() || success()` 条件で連鎖実行し、修正内容を `autofix-ci/action` で PR に自動コミットする。コントリビューターがローカルで lint を走らせ忘れても CI が自動修正するため、「フォーマットが合ってないから直してください」というレビューコメントが不要になる。

```yaml
# lint.yml:30-43
- run: pnpm turbo lint -- --fix
  if: ${{ failure() || success() }}
- run: pnpm manypkg fix
  if: ${{ failure() || success() }}
- run: pnpm format-fix
  if: ${{ failure() || success() }}

- uses: autofix-ci/action@551dded8c6cc8a1054039c8bc0b8b48c51dfc6ef
  if: ${{ failure() || success() }}
  with:
    commit-message: 'chore: apply lint and formatting fixes'
```

### pkg-pr-new による PR パッケージ公開

main ワークフロー内の `release-tmp` ジョブは、全 PR で `pkg-pr-new publish './packages/*'` を実行する。これにより、PR が作成されるたびに全パッケージの一時バージョンが npm にインストール可能な形で公開される。ライブラリの利用者が「この PR の修正を手元で試したい」ときに即座にインストールできる。

```yaml
# main.yml:294
- run: pnpx pkg-pr-new publish './packages/*'
```

### モノレポ内バージョン同期スクリプト

`scripts/version.ts` は `prepack` / `version` フックで自動実行され、全 `@trpc/*` パッケージの相互依存バージョンを現在のバージョンにピン留めする。lerna のバージョンバンプと組み合わせて、モノレポ内の不整合を防止する。

```typescript
// scripts/version.ts:30-33
const newContent = content.replace(
  /\"@trpc\/((\w|-)+)\": "([^"]|\\")*"/g,
  `"@trpc/$1": "${version}"`,
);
```

### E2E テストのマルチランタイムマトリクス

E2E テストは Node (ubuntu-latest) / Deno / Bun の 3 ランタイムに対応し、さらに Node は v18.x / v20.x のレガシーバージョンでもマトリクス実行される。全 E2E ジョブに `continue-on-error: true` が設定されており、不安定なテストがマージをブロックしない。

### Turbo Remote Cache による CI 高速化

全ワークフローで `TURBO_TOKEN` / `TURBO_TEAM` が環境変数として設定され、Turborepo のリモートキャッシュが有効化されている。ビルド出力 (`dist/**`) がキャッシュされるため、変更のないパッケージのビルドがスキップされる。

### Renovate + Dependabot 自動承認

依存更新には Renovate を使用し (`renovate.json`)、Dependabot / Renovate ボットの PR は `dependabot-approve.yml` で自動承認 + auto-squash-merge される。examples ディレクトリは Renovate の対象外 (`"ignorePaths": ["**/examples/**"]`)。

### subtree による下流リポジトリ同期

`subtree.yml` は main ブランチへのプッシュ時に、`examples/` 配下の各サンプルプロジェクトを `trpc/examples-*` の個別リポジトリに `git subtree push` する。サンプルの `@trpc/*` 依存は `canary` タグに書き換えてから push するため、常に最新の canary バージョンで動作することが保証される。

## コード例

```yaml
# .github/workflows/release-canary.yml:34
# main push 時の自動 canary リリース。package.json 変更は除外し、
# コード変更のみでトリガーする
- run: pnpm lerna publish --force-publish --canary --preid canary --dist-tag canary --yes
```

```yaml
# .github/workflows/release-manual.yml:48-50
# workflow_dispatch で patch/minor を選択し、dist-tag も指定可能
- name: Publish packages
  run: |
    pnpm lerna publish ${{ inputs.version_bump }} --force-publish --dist-tag ${{ inputs.dist_tag }} --yes
```

```yaml
# .github/workflows/main.yml:8-10
# 同一ブランチの並行実行を防止し、最新のみ実行する
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

```yaml
# .github/setup/action.yml:6-24
# Composite Action で pnpm + Node.js + キャッシュを一括セットアップ
- uses: pnpm/action-setup@v4
- uses: actions/setup-node@v6
  with:
    node-version: 22.x
- uses: actions/cache@v5
  name: Setup pnpm cache
  with:
    path: ${{ steps.pnpm-cache.outputs.pnpm_cache_dir }}
    key: ${{ runner.os }}-pnpm-store-${{ hashFiles('**/pnpm-lock.yaml') }}
```

```yaml
# .github/workflows/main.yml:85-87
# Fork PR でも codecov が機能するよう、トークンの有無で条件分岐
- uses: codecov/codecov-action@v5
  with:
    fail_ci_if_error: true
    token: ${{ github.event.pull_request.head.repo.fork == false && secrets.CODECOV_TOKEN || '' }}
```

## パターンカタログ

- **Pipeline パターン** (分類: 振る舞い)
  - 解決する問題: CI の各ステップ（build, test, lint, release）の依存関係と実行順序の管理
  - 適用条件: ジョブ間にデータ依存がある場合（E2E テストは build 完了後に実行等）
  - コード例: `main.yml:94` の `needs: [build]`、`main.yml:56` の `needs: [build]`
  - 注意点: `needs` を増やしすぎると並列度が下がり、全体の実行時間が伸びる

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 同一テストロジックを複数環境（ランタイム、Node バージョン、サンプルプロジェクト）で実行する際の重複排除
  - 適用条件: マトリクス変数で環境だけ切り替えて同じステップを実行したい場合
  - コード例: `main.yml:110-132` の `strategy.matrix.dir`、`main.yml:253` の `node-start: ['18.x', '20.x']`
  - 注意点: マトリクスの組み合わせ爆発に注意。tRPC は E2E ジョブを Node / Deno / Bun で分離して抑制している

## Good Patterns

- **canary リリースのパスフィルタリング**: `release-canary.yml` では `packages/**` の変更のみをトリガーにし、`!packages/**/package.json` で package.json の変更を除外している。lerna のバージョンバンプコミットが canary リリースを再トリガーする無限ループを防ぐ実用的なパターン。

```yaml
# .github/workflows/release-canary.yml:7-12
paths:
  - '.github/setup/*'
  - '.github/workflows/release-canary.yml'
  - 'packages/**'
  - '!packages/**/package.json'
  - '!packages/test/**'
```

- **Composite Action によるセットアップ集約**: `.github/setup/action.yml` に pnpm / Node.js / キャッシュ設定を集約し、全ワークフローが `uses: ./.github/setup` で参照する。Node バージョン更新が 1 箇所で完結する。

```yaml
# 各ワークフローの利用側
- uses: ./.github/setup
```

- **PR ごとの即時パッケージ公開**: `pkg-pr-new` により全 PR でパッケージが一時公開される。「PR を手元で試したい」というフィードバックサイクルが npm install で即座に完結する。

```yaml
# main.yml:294
- run: pnpx pkg-pr-new publish './packages/*'
```

- **Semantic PR の動的スコープ検証**: 許可スコープをハードコードせず packages 配下から動的生成する。パッケージ追加時にスコープリストの更新漏れが起きない。

## Anti-Patterns / 注意点

- **ブランチ名のハードコード**: `release-tmp.yml` は対象ブランチ名をワークフローファイルに直接記述している。使うたびにファイルを書き換えて push する必要があり、ワークフローの変更履歴がノイズになる。

```yaml
# Bad: release-tmp.yml:8-9
branches:
  - '6955/again'  # ブランチ名を毎回ハードコード
```

```yaml
# Better: workflow_dispatch で入力パラメータにする
on:
  workflow_dispatch:
    inputs:
      branch:
        description: 'Branch to release from'
        required: true
        type: string
```

- **E2E の continue-on-error を長期間放置**: `continue-on-error: true` は初期導入や不安定テストの一時対処としては有効だが、常態化するとテスト失敗が見過ごされる。定期的に失敗率を確認し、安定したテストは `continue-on-error` を外すべきである。

## 導出ルール

- `[MUST]` CI ワークフローの共通セットアップ（言語バージョン、パッケージマネージャ、キャッシュ設定）は Composite Action または再利用可能ワークフローに集約する
  - 根拠: tRPC は `.github/setup/action.yml` で全 11 ワークフローのセットアップを統一し、Node バージョン更新を 1 箇所で管理している
- `[MUST]` 自動リリースワークフローのトリガーにパスフィルタと除外パターンを設定し、リリースコミット自体がリリースを再トリガーする無限ループを防止する
  - 根拠: `release-canary.yml` は `!packages/**/package.json` でバージョンバンプの package.json 変更を除外し、canary publish の無限ループを防いでいる
- `[SHOULD]` npm dist-tag を活用して安定版 / プレリリース / canary の複数リリースチャネルを分離し、ユーザーが明示的にオプトインしない限り不安定バージョンを配信しない
  - 根拠: tRPC は `latest` / `next` / `canary` / `tmp` の 4 チャネルを dist-tag で分離し、`npm install @trpc/server` は常に安定版をインストールする
- `[SHOULD]` Semantic PR タイトル検証のスコープリストはモノレポのパッケージ一覧から動的生成し、パッケージ追加・削除に自動追従させる
  - 根拠: `semantic-pr.yml` は `find packages -name "package.json"` + `jq` でスコープを動的生成し、ハードコードによるメンテナンス漏れを防いでいる
- `[SHOULD]` PR ごとにライブラリパッケージを一時公開し（`pkg-pr-new` 等）、利用者が PR の変更を手元で即座に検証できるようにする
  - 根拠: `main.yml:294` で全 PR に対して `pkg-pr-new publish` が実行され、フィードバックループを短縮している
- `[SHOULD]` Lint / フォーマット修正を CI で自動コミットし、スタイルに関するレビューコメントを不要にする
  - 根拠: `lint.yml` で `autofix-ci/action` が lint --fix / manypkg fix / format-fix の結果を自動コミットしている
- `[AVOID]` E2E テストの `continue-on-error: true` を恒久的に放置する。不安定テストの一時対処としては有効だが、定期的に失敗率を監視し、安定したテストからフラグを除去する仕組みを持つべきである
  - 根拠: tRPC の全 E2E ジョブ（Node / Deno / Bun / legacy-node）に `continue-on-error: true` が設定されており、テスト失敗が見過ごされるリスクがある

## 適用チェックリスト

- [ ] CI セットアップ（Node バージョン、パッケージマネージャ、キャッシュ）を Composite Action に集約しているか
- [ ] 全ワークフローに `concurrency` と `cancel-in-progress` を設定し、同一ブランチの並行実行を防いでいるか
- [ ] 全ジョブに `timeout-minutes` を明示的に設定しているか（デフォルトの 6 時間に依存しない）
- [ ] 自動リリースワークフローにパスフィルタを設定し、リリースコミットによる無限ループを防いでいるか
- [ ] npm dist-tag で安定版とプレリリースチャネルを分離しているか
- [ ] Semantic PR タイトル検証のスコープリストがモノレポのパッケージ一覧から自動生成されているか
- [ ] Fork PR でもシークレット不要な CI ステップが正常動作するか検証しているか
- [ ] PR ごとにパッケージの一時公開（`pkg-pr-new` 等）を行い、利用者がすぐ試せるようにしているか
- [ ] Lint / フォーマットの自動修正コミットを CI に導入し、スタイル差分のレビュー負荷を削減しているか
- [ ] `continue-on-error: true` を使用しているジョブの失敗率を定期的に確認する仕組みがあるか
