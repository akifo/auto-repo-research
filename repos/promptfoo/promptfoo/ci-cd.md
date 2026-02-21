# CI/CD

> リポジトリ: promptfoo/promptfoo
> 分析日: 2026-02-21

## 概要

promptfoo は 12 の GitHub Actions ワークフローを軸に、メインCI・リリース自動化・AI コードレビュー・依存関係管理・Docker ビルド・セキュリティスキャンを統合した CI/CD パイプラインを構築している。特に注目に値するのは、(1) release-please によるリリース自動化と GitHub App トークンを使った CI トリガーの連鎖設計、(2) Claude Code Review による AI レビューの増分レビュー戦略、(3) Renovate の階層化されたスケジューリングポリシー、(4) フォーク PR に対する多層的なセキュリティガードの 4 点である。

## 背景にある原則

- **段階的品質ゲートの原則**: CI パイプラインはテスト・ビルド・リント・セキュリティスキャンを独立したジョブに分割し、並列実行で高速化しつつ、リリースフローでは `build -> publish-npm -> docker` と依存チェーンで品質を段階的に保証する。根拠: `release-please.yml` の `needs: [build, release-please]`（publish-npm）、`needs: [publish-npm, release-please]`（docker）の依存チェーン
- **最小権限の原則**: 各ワークフローに `permissions` ブロックを明示的に設定し、必要最小限の権限のみを付与する。ジョブレベルでもさらに絞り込んでいる。根拠: `main.yml` のワークフローレベル `contents: read, pull-requests: read, checks: write`、`share-test` ジョブの `permissions: contents: read` による追加絞り込み
- **フォーク分離の原則**: フォークからの PR にはシークレットがアクセスできないため、シークレット依存のジョブを条件分岐で分離し、フォーク PR でも基本的な CI は通るようにする。根拠: `main.yml:167` のフォーク検出によるビルド検証スキップ、`share-test` と `redteam-staging` の `if` 条件
- **コスト最適化の原則**: PR 時とメインブランチ push 時でテストマトリクスの範囲を変える。PR ではフィードバック速度を優先し、main では網羅性を優先する。根拠: `main.yml:44-63` の `ci-config` ジョブで PR 時は macOS 1 版のみ、main push 時は全 OS/バージョンを実行

## 実例と分析

### リリース自動化パイプライン

release-please と GitHub App トークンの組み合わせが特徴的である。GitHub のデフォルト `GITHUB_TOKEN` で作成した PR は CI ワークフローをトリガーしないため、GitHub App トークンを使う工夫が施されている。

リリースフローは4段階で構成される:
1. **release-please** がコミット履歴からバージョンを決定し、PR を作成/リリースを作成
2. **build** ジョブがリリース作成時にテストを実行
3. **publish-npm** が `--provenance` 付きで npm に公開（ソフトウェアサプライチェーンの透明性）
4. **docker** が `workflow_call` でマルチアーキテクチャイメージをビルド・公開・attestation

release-please が生成する CHANGELOG のフォーマットを prettier で自動修正する後処理も含まれている。

### AI コードレビュー（Claude Code Review）

増分レビューと全体レビューの切り替えが洗練されている。`determine-review-scope.sh` スクリプトがイベント種別を判定し、`synchronize` かつ非マージコミットの場合のみ増分レビューを行う。マージコミット（main をブランチに取り込んだ場合）は全体レビューにフォールバックすることで、main のコードを誤ってレビューすることを防止している。

レビュープロンプトはテンプレート方式で管理され（`.github/prompts/claude-code-review.md`）、変数置換でコンテキストを注入する。プロンプトは優先順位付きのレビュー観点を定義しており、セキュリティ > 正確性 > テスト の順で問題を分類する。

::: v-pre
```yaml
# .github/workflows/claude-code-review.yml:27-37
# Pass event data as env vars to avoid shell injection via ${{ }} interpolation
env:
  EVENT_ACTION: ${{ github.event.action }}
  EVENT_BEFORE: ${{ github.event.before }}
  PR_BASE_SHA: ${{ github.event.pull_request.base.sha }}
  PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}
```
:::

<code v-pre>${{ }}</code> 式を直接シェルコマンドに展開するとインジェクション脆弱性の原因になるため、環境変数経由で値を渡している。

### 動的テストマトリクス

テストマトリクスの構成を `ci-config` ジョブで動的に生成し、PR と main push で異なる範囲を実行する。

::: v-pre
```yaml
# .github/workflows/main.yml:21-68
ci-config:
  name: CI Config
  runs-on: ubuntu-latest
  timeout-minutes: 5
  outputs:
    test-matrix: ${{ steps.set-matrix.outputs.test-matrix }}
    build-matrix: ${{ steps.set-matrix.outputs.build-matrix }}
```
:::

PR 時: Linux 3 バージョン + Windows 3 シャード + macOS 1 バージョン（ビルドは Node 20, 24 のみ）
main 時: 全 OS 全 Node バージョンのフルマトリクス

Windows テストは 3 シャードに分割され、大量のテストを並列実行する。シャード番号は matrix の `shard` フィールドで渡され、falsy 値（`""`）で非シャード実行と区別される。

### Renovate の階層化スケジューリング

依存関係の更新頻度をパッケージの性質に応じて 4 段階に分類している:

| カテゴリ | スケジュール | minimumReleaseAge | 例 |
|---|---|---|---|
| LLMプロバイダ | 毎平日 | 0日 | @anthropic-ai/*, openai |
| ランタイム依存 | デフォルト | 5日 | npm dependencies |
| 開発依存 | デフォルト | 2日 | devDependencies |
| 低頻度ライブラリ | 月次 | 7日 | framer-motion, Storybook |

同一組織のパッケージは `groupName` でグルーピングし、PR の氾濫を防止している。lockFileMaintenance は月2回（1日と15日）に限定する。

### セキュリティスキャンの多層化

CI には 3 層のセキュリティ検証がある:
1. **Claude Code Review**: AI によるセキュリティレビュー（インジェクション、SSRF、パストラバーサル等）
2. **promptfoo-code-scan**: 自社の code-scan-action によるセキュリティスキャン
3. **lockfile-lint**: ロックファイルの整合性検証（npm レジストリ + HTTPS のみ許可）

### 並行制御とリソース管理

各ワークフローに `concurrency` グループを設定し、同一 PR/ブランチの重複実行を制御している。

::: v-pre
```yaml
# main.yml - PR時のみキャンセル、mainプッシュは完走させる
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

# claude.yml - AIタスクはキャンセルしない
concurrency:
  group: ${{ github.workflow }}-${{ github.event.issue.number || github.event.pull_request.number }}
  cancel-in-progress: false
```
:::

メインCIは PR 時のみ旧実行をキャンセルする（main push は常に完走）。Claude Code のタスクはキャンセルしない設計で、AI の作業中断を防いでいる。

## コード例

```bash
# .github/scripts/determine-review-scope.sh:33-48
# マージコミット検出による全体/増分レビュー切り替え
if [ "$EVENT_ACTION" = "synchronize" ] &&
  is_valid_sha "$EVENT_BEFORE" &&
  is_valid_sha "$EVENT_AFTER" &&
  ! is_merge_commit "$EVENT_AFTER"; then
  {
    echo "scope=incremental"
    echo "base_sha=$EVENT_BEFORE"
    echo "head_sha=$EVENT_AFTER"
  } >>"$GITHUB_OUTPUT"
else
  # Full review for: opened, ready_for_review, force push, or merge commits
  {
    echo "scope=full"
    echo "base_sha=$PR_BASE_SHA"
    echo "head_sha=$PR_HEAD_SHA"
  } >>"$GITHUB_OUTPUT"
fi
```

::: v-pre
```yaml
# .github/workflows/release-please.yml:21-32
# GitHub App トークンで release-please PR の CI トリガーを確保
- uses: actions/create-github-app-token@v2
  id: app-token
  with:
    app-id: ${{ vars.PROMPTFOOBOT_APP_ID }}
    private-key: ${{ secrets.PROMPTFOOBOT_APP_PRIVATE_KEY }}

- uses: googleapis/release-please-action@v4
  id: release
  with:
    token: ${{ steps.app-token.outputs.token }}
```
:::

::: v-pre
```yaml
# .github/workflows/main.yml:108-117
# node_modules キャッシュ（OS + Node バージョン + lockfile ハッシュでキー生成）
- name: Cache node_modules
  id: cache-node-modules
  uses: actions/cache@v5
  with:
    path: node_modules
    key: node-modules-${{ runner.os }}-node${{ matrix.node }}-${{ hashFiles('package-lock.json') }}

- name: Install Dependencies
  if: steps.cache-node-modules.outputs.cache-hit != 'true'
  run: npm ci
```
:::

::: v-pre
```yaml
# .github/workflows/main.yml:119-120
# テストシャーディング + カバレッジの条件付き有効化を1行で表現
- name: Test
  run: npm run test${{ matrix.shard && format(' -- --shard={0}/3', matrix.shard) || '' }}${{ matrix.os == 'ubuntu-latest' && matrix.node == '20.20' && !matrix.shard && ' -- --coverage' || '' }}
```
:::

## パターンカタログ

- **Pipeline パターン** (分類: 振る舞い)
  - 解決する問題: リリースプロセスの各段階で品質を保証しつつ、失敗時に後続を実行しない
  - 適用条件: テスト -> ビルド -> 公開 -> デプロイのように段階的に進む処理がある場合
  - コード例: `release-please.yml:80-131`（release-please -> build -> publish-npm -> docker の依存チェーン）
  - 注意点: 段階が増えるとリリース全体の所要時間が伸びるため、並列化可能な段階は `needs` で並べない

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 実行コンテキスト（PR vs main push）に応じてテスト範囲を切り替える
  - 適用条件: コスト/速度と網羅性のトレードオフがある場合
  - コード例: `main.yml:21-68`（ci-config ジョブによる動的マトリクス生成）
  - 注意点: マトリクスの定義が複雑になりすぎると可読性が下がる

## Good Patterns

- **GitHub App トークンによる CI トリガーの連鎖**: release-please が作成する PR に対して CI が自動実行されるよう、`GITHUB_TOKEN` ではなく GitHub App トークンを使用する。`GITHUB_TOKEN` で作成した PR はワークフローをトリガーしない制約を回避するための意図的な設計である。

::: v-pre
```yaml
# .github/workflows/release-please.yml:21-32
- uses: actions/create-github-app-token@v2
  id: app-token
  with:
    app-id: ${{ vars.PROMPTFOOBOT_APP_ID }}
    private-key: ${{ secrets.PROMPTFOOBOT_APP_PRIVATE_KEY }}
- uses: googleapis/release-please-action@v4
  with:
    token: ${{ steps.app-token.outputs.token }}
```
:::

- **環境変数経由のイベントデータ受け渡し**: <code v-pre>${{ }}</code> 式をシェルスクリプト内で直接展開するとインジェクション攻撃の対象になる。env ブロックで一度変数に格納し、シェル内では環境変数として参照することで安全にデータを渡す。

::: v-pre
```yaml
# .github/workflows/claude-code-review.yml:28-37
env:
  EVENT_ACTION: ${{ github.event.action }}
  PR_TITLE: ${{ github.event.pull_request.title }}
  PR_AUTHOR: ${{ github.event.pull_request.user.login }}
```
:::

- **条件付き concurrency キャンセル**: PR の実行は旧ビルドをキャンセルして最新のみ残す一方、main push は常に完走させる。`cancel-in-progress` を式で動的に制御する。

::: v-pre
```yaml
# .github/workflows/main.yml:15-17
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```
:::

- **AI レビューの増分/全体切り替え**: push ごとに全体レビューを行うとコストと時間がかかる。`synchronize` イベントかつ非マージコミットの場合のみ差分レビューにすることで、効率とカバレッジを両立させる。

## Anti-Patterns / 注意点

- **CI 設定ファイルの変更検証漏れ**: Renovate 設定の変更は専用ワークフロー（`validate-renovate-config.yml`）で検証しているが、他の CI 設定ファイル（main.yml 等）の変更は actionlint でしか検証されない。CI 設定のドライラン検証がないと、壊れたワークフローがマージされるリスクがある。

```yaml
# Bad: CI設定の変更がマージ後にしか検証されない
on:
  push:
    branches: [main]

# Better: paths フィルタで CI 設定変更時にも検証を実行
on:
  pull_request:
    paths:
      - '.github/workflows/**'
```

promptfoo では actionlint による静的検証が全 PR で実行されるため一定のガードはあるが、意味的な整合性（ジョブ間の依存関係、シークレット参照の正しさ等）は検証されない。

- **タイムアウトの未統一**: テスト系ジョブのタイムアウトが 5分〜15分で設定されているが、Docker ビルドは 60分と大きな差がある。タイムアウト値の根拠が明文化されていないと、ジョブの実行時間が徐々に伸びてもタイムアウトに引っかからず、CI 全体の遅延に気づきにくい。

```yaml
# Bad: タイムアウト値が根拠なく大きい
timeout-minutes: 60

# Better: 過去の実行時間 + マージンで設定し、根拠をコメントで記載
timeout-minutes: 25 # 平均15分 + 10分マージン
```

## 導出ルール

- `[MUST]` release-please や Dependabot など自動化ボットが作成する PR で CI を実行する必要がある場合、GitHub App トークンを使う（`GITHUB_TOKEN` で作成した PR はワークフローをトリガーしない）
  - 根拠: `release-please.yml:21-32` で `actions/create-github-app-token` を使い CI トリガーの連鎖を確保している
- `[MUST]` `pull_request_target` トリガーを使うワークフローでは、フォーク PR を条件分岐で除外するか、チェックアウト対象を base ブランチに限定する（フォークのコードを特権コンテキストで実行するとシークレット漏洩につながる）
  - 根拠: `claude-code-review.yml:23` で `head.repo.full_name == github.repository` によるフォーク除外を実施
- `[MUST]` GitHub Actions のシェルステップで <code v-pre>${{ }}</code> 式をコマンドラインに直接展開しない。`env` ブロックで環境変数に格納し、シェル内では `$ENV_VAR` で参照する（PR タイトル等にシェルメタ文字が含まれるとインジェクションになる）
  - 根拠: `claude-code-review.yml:28-37` で全イベントデータを env 経由で渡し、コメントで理由を明記している
- `[SHOULD]` CI のテストマトリクスは PR 時とメインブランチ push 時で範囲を変える（PR は高速フィードバック優先、main は網羅性優先）
  - 根拠: `main.yml:44-63` の `ci-config` ジョブが `EVENT_NAME` に応じてマトリクスを動的に切り替えている
- `[SHOULD]` Renovate の依存関係更新スケジュールはパッケージの性質に応じて階層化する（LLM プロバイダは毎日、安定ライブラリは月次など）。`minimumReleaseAge` で公開直後の壊れたバージョンを回避する
  - 根拠: `renovate.json` で LLM パッケージ（0日）、ランタイム（5日）、開発（2日）、低頻度（7日）の 4 階層を設定
- `[SHOULD]` `concurrency` グループの `cancel-in-progress` は PR 実行のみに適用し、メインブランチの push は常に完走させる（リリース判定に使う CI が中断されるとリリースフローが壊れる）
  - 根拠: `main.yml:17` で <code v-pre>cancel-in-progress: ${{ github.event_name == 'pull_request' }}</code> と条件式で制御
- `[SHOULD]` AI コードレビューは増分レビューと全体レビューを切り替え可能にする。push イベントの前後 SHA を比較し、マージコミットの場合は全体レビューにフォールバックする
  - 根拠: `determine-review-scope.sh` がマージコミット検出で全体レビューに切り替え、main の変更を誤レビューすることを防止
- `[AVOID]` npm publish 時に `--provenance` フラグを省略しない。OIDC ベースの provenance attestation はサプライチェーンセキュリティの基本である
  - 根拠: `release-please.yml:116` で `npm publish --provenance --access public` を使用し、Docker イメージにも `attest-build-provenance` を適用

## 適用チェックリスト

- [ ] 全ワークフローに `permissions` ブロックを明示的に設定し、最小権限にしているか
- [ ] 全ジョブに `timeout-minutes` を設定し、ハングアップによるランナー消費を防いでいるか
- [ ] フォーク PR でシークレットにアクセスするジョブを条件分岐で保護しているか
- [ ] `pull_request_target` を使う場合、フォークのコードを特権コンテキストで実行しない設計になっているか
- [ ] release-please 等の自動化ボットが作成する PR で CI がトリガーされることを確認したか（GitHub App トークンが必要）
- [ ] <code v-pre>${{ }}</code> 式をシェルコマンドに直接展開している箇所がないか（環境変数経由に変更）
- [ ] Renovate のスケジュールをパッケージ種別に応じて階層化し、`minimumReleaseAge` を設定しているか
- [ ] npm publish に `--provenance` を付与し、Docker イメージにも build attestation を設定しているか
- [ ] PR 時の `concurrency.cancel-in-progress` を有効にしつつ、main push では無効にしているか
- [ ] テストマトリクスを PR / main push で段階的に設定し、コストと網羅性を最適化しているか
