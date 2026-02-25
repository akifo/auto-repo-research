# CI/CD

> リポジトリ: vercel/chat
> 分析日: 2026-02-25

## 概要

vercel/chat は GitHub Actions + Changesets + Turborepo を組み合わせたモノレポ CI/CD パイプラインを構築している。CI ワークフローは lint・typecheck・build-and-test の 3 ジョブを並列実行し、Release ワークフローは CI 成功後に `workflow_run` トリガーで Changesets による自動バージョニング・npm パブリッシュを行う。特筆すべきは、本番 webhook トラフィックをプレビューブランチにプロキシする Preview Branch Testing の仕組みと、本番インタラクションを録画してテストフィクスチャに変換する Recording & Replay テスト戦略の存在である。

## 背景にある原則

- **段階的品質ゲート**: CI を lint → typecheck → build-and-test の独立ジョブに分割し、失敗の特定を迅速化しつつ並列実行で全体の待ち時間を最小化している。さらに `validate` スクリプトは knip → check → typecheck → test → build:validate の順序で網羅的に検証する（`package.json:22`）
- **ワークフロー連鎖による関心の分離**: CI とリリースを別ワークフローに分離し、`workflow_run` イベントで連鎖させることで、CI は品質保証に、Release はパブリッシュに専念できる構造を作っている（`.github/workflows/release.yml:4-5`）
- **本番トラフィックによる検証**: Webhook 統合のようにモックでは再現しにくいシナリオに対し、本番トラフィックのプロキシ（Preview Branch Testing）と録画・再生（Recording & Replay）の二段構えで品質を担保している
- **依存関係グラフの宣言的定義**: Turborepo の `dependsOn` でタスク間の依存を明示し、ビルド順序の誤りを防止している。`test` は `build` に依存し、`typecheck` は `^build`（依存パッケージのビルド完了）に依存する（`turbo.json:17-29`）

## 実例と分析

### CI ワークフローの並列ジョブ設計

CI ワークフローは 4 つのジョブで構成される。

1. **lint**: Ultracite（Biome ベース）によるフォーマットチェック + Knip による不要依存・未使用エクスポート検出
2. **typecheck**: TypeScript の型チェック
3. **build-and-test**: ビルド後のテスト実行（モック環境変数で外部サービス依存を排除）
4. **preview-comment**: PR 時のみ実行。テスト手順をコメントとして投稿（冪等 -- 既存コメントがあればスキップ）

4 ジョブはすべて互いに依存関係がなく並列実行される。これにより、lint のみの失敗でもビルドを待つ必要がなく、フィードバックが速い。

### Concurrency 制御

```yaml
# .github/workflows/ci.yml:9-11
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

ブランチ単位で重複実行をキャンセルする。push を連続して行った場合、古い CI ランが自動的に中止され、リソースの浪費を防ぐ。

Release ワークフローでも同様の concurrency 制御を行うが、`cancel-in-progress` を省略（デフォルト `false`）することでリリースの途中キャンセルを防止している。

### モック環境変数によるビルド独立性

```yaml
# .github/workflows/ci.yml:62-69
env:
  SLACK_BOT_TOKEN: xoxb-mock
  SLACK_SIGNING_SECRET: mock
  TEAMS_APP_ID: mock
  TEAMS_APP_PASSWORD: mock
  TEAMS_APP_TENANT_ID: mock
  GOOGLE_CHAT_CREDENTIALS: '{"type":"service_account",...}'
  REDIS_URL: redis://localhost:6379
  RECORDING_ENABLED: "false"
```

外部サービスへの実際の接続なしにビルドとテストが完結するよう、すべての必須環境変数にモック値を設定している。`turbo.json` の `globalEnv` で Turborepo にもこれらの環境変数を認識させ、キャッシュの整合性を保っている。

### Changesets によるバージョン管理戦略

`.changeset/config.json` の `fixed` 設定により、`chat` と `@chat-adapter/*` のすべてのパッケージが同一バージョンで固定リリースされる。

```json
// .changeset/config.json:5
"fixed": [["chat", "@chat-adapter/*"]]
```

- `ignore` でサンプルアプリ（`example-nextjs-chat`）と統合テスト（`@chat-adapter/integration-tests`）をリリース対象から除外
- `commit: false` で changeset 消費時の自動コミットを無効化し、Changesets Action に委任
- `updateInternalDependencies: "patch"` でモノレポ内の依存パッケージを自動バンプ

### workflow_run によるリリースチェーン

```yaml
# .github/workflows/release.yml:3-9
on:
  workflow_run:
    workflows: ["CI"]
    types:
      - completed
    branches:
      - main
```

`workflow_run` は CI ワークフローの完了をトリガーとするが、完了は成功・失敗両方を含む。そのため、ジョブレベルで明示的に成功判定を行っている。

```yaml
# .github/workflows/release.yml:18
if: ${{ github.event.workflow_run.conclusion == 'success' }}
```

この二段構えにより、CI 失敗時のリリースを確実に防止している。

### Preview Branch Testing アーキテクチャ

webhook のような外部プラットフォームからのコールバックは、URL を変更できないため通常のプレビューデプロイでは検証が困難である。vercel/chat はこの問題を Next.js middleware によるリバースプロキシで解決している。

```
[Slack/Teams/GChat] → Production → middleware → Preview Branch
                                       ↑
                                  Redis に保存された
                                  プレビュー URL で判定
```

1. 本番デプロイの `/settings` ページでプレビュー URL を Redis に保存
2. middleware が `/api/webhooks/*` へのリクエストを検知
3. Redis にプレビュー URL が設定されていれば `NextResponse.rewrite()` でプロキシ
4. 本番環境でのみ動作（`NODE_ENV === "production"` && `VERCEL_ENV === "production"`）

### Recording & Replay テスト戦略

本番の webhook インタラクションを Redis に録画し、テストフィクスチャとして再利用する仕組みが構築されている。

1. `RECORDING_ENABLED=true` で本番デプロイ
2. セッション ID に `VERCEL_GIT_COMMIT_SHA` を組み込み、デプロイとの紐付けを容易化
3. CLI ツール（`recorder.ts`）で録画をエクスポートし、JSON フィクスチャに変換
4. `replay.test.ts` 等の統合テストで再生

この戦略により、外部プラットフォームの実際の webhook フォーマット変更を検出でき、モックの乖離リスクを排除している。

### Dependabot の運用戦略

```yaml
# .github/dependabot.yml:17-23
groups:
  minor-and-patch:
    update-types:
      - "minor"
      - "patch"
```

GitHub Actions と npm の両方を monthly で更新しつつ、npm の minor/patch 更新をグループ化して PR ノイズを削減している。

### Vitest Workspace による統合テスト実行

`vitest.workspace.ts` で 11 パッケージのテストを一括実行する `test:workspace` コマンドを用意し、CI パイプラインとは別にローカルでの高速なフィードバックループを実現している。統合テストパッケージ（`@chat-adapter/integration-tests`）は外部認証情報が必要なためワークスペースから除外されている。

### Knip による不要コード検出

CI の lint ジョブで Knip を実行し、不要な依存関係・未使用エクスポートを検出している。`knip.json` で `@biomejs/biome` を `ignoreDependencies` に指定し、Ultracite 経由で間接利用される依存の誤検出を回避している。

## コード例

```yaml
# .github/workflows/ci.yml:92-131
# PR へのプレビューテスト手順コメント（冪等な投稿）
preview-comment:
  if: github.event_name == 'pull_request'
  runs-on: ubuntu-latest
  permissions:
    pull-requests: write
  steps:
    - name: Post preview testing instructions
      uses: actions/github-script@v8
      with:
        script: |
          const body = `## Preview Branch Testing
          ...`;
          const { data: comments } = await github.rest.issues.listComments({
            owner: context.repo.owner,
            repo: context.repo.repo,
            issue_number: context.issue.number,
          });
          const botComment = comments.find(comment =>
            comment.user.type === 'Bot' &&
            comment.body.includes('## Preview Branch Testing')
          );
          if (!botComment) {
            await github.rest.issues.createComment({...});
          }
```

```typescript
// examples/nextjs-chat/src/middleware.ts:57-86
// 本番 webhook リクエストをプレビューブランチへプロキシ
export async function middleware(request: NextRequest) {
  if (process.env.NODE_ENV !== "production") {
    return NextResponse.next();
  }
  if (process.env.VERCEL_ENV !== "production") {
    return NextResponse.next();
  }
  const { pathname } = request.nextUrl;
  const previewBranchUrl = await getPreviewBranchUrl();
  if (!previewBranchUrl) {
    return NextResponse.next();
  }
  const targetUrl = new URL(
    pathname + request.nextUrl.search,
    previewBranchUrl,
  );
  return NextResponse.rewrite(targetUrl);
}
```

```yaml
# .github/workflows/release.yml:14-18
# CI 成功時のみリリースを実行
jobs:
  release:
    name: Release
    runs-on: ubuntu-latest
    if: ${{ github.event.workflow_run.conclusion == 'success' }}
```

```json
// turbo.json:17-28
// タスク依存グラフの宣言
"tasks": {
  "build": {
    "dependsOn": ["^build"],
    "outputs": ["dist/**", "docs/**", ".next/**", "!.next/cache/**"]
  },
  "test": {
    "dependsOn": ["build"],
    "outputs": []
  },
  "typecheck": {
    "dependsOn": ["^build"],
    "outputs": []
  }
}
```

```typescript
// examples/nextjs-chat/src/lib/recorder.ts:108-121
// 録画セッション ID に git SHA を組み込み
constructor() {
  this.enabled = process.env.RECORDING_ENABLED === "true";
  this.sessionId =
    process.env.RECORDING_SESSION_ID ||
    `session-${process.env.VERCEL_GIT_COMMIT_SHA || "local"}`;
  if (this.enabled && process.env.REDIS_URL) {
    this.redis = createClient({ url: process.env.REDIS_URL });
    this.redis.on("error", (err) =>
      console.error("[recorder] Redis error:", err)
    );
  }
}
```

## パターンカタログ

- **Proxy パターン** (構造)
  - 解決する問題: 外部プラットフォームからの webhook コールバック URL を変更できないため、プレビュー環境での動作検証ができない
  - 適用条件: 本番のみが外部サービスからの受信エンドポイントを持ち、プレビュー環境が独立した URL で動作する場合
  - コード例: `examples/nextjs-chat/src/middleware.ts:57-86`
  - 注意点: プロキシ先の障害が本番の webhook 処理をブロックしうる。本番のフォールバックを検討すること

- **Record & Replay パターン** (振る舞い)
  - 解決する問題: 外部プラットフォームの webhook フォーマットは文書化が不十分で頻繁に変更されるため、モックベースのテストが実態と乖離する
  - 適用条件: 外部サービスの実際のペイロードをテストに組み込みたいが、CI でそのサービスを利用できない場合
  - コード例: `examples/nextjs-chat/src/lib/recorder.ts`, `packages/integration-tests/src/replay.test.ts`
  - 注意点: 録画データの鮮度管理が必要。プラットフォームの API 変更時はフィクスチャの更新が必要

- **Pipeline パターン** (振る舞い)
  - 解決する問題: CI の品質チェックとリリースを密結合すると、片方の変更がもう片方に波及する
  - 適用条件: 品質ゲートの通過をリリースの前提条件としたいモノレポ
  - コード例: `.github/workflows/release.yml:3-9`, `.github/workflows/release.yml:18`
  - 注意点: `workflow_run` の `completed` は成功・失敗両方を含むため、ジョブレベルの `if` による成功判定が必須

## Good Patterns

- **CI ジョブの並列独立実行**: lint・typecheck・build-and-test が互いに依存せず並列実行されるため、lint エラーのフィードバックがビルド完了を待たずに得られる。各ジョブの失敗原因も明確になる

```yaml
# .github/workflows/ci.yml:14, 38, 59
# 3つの独立ジョブが並列実行
jobs:
  lint: ...
  typecheck: ...
  build-and-test: ...
```

- **冪等な PR コメント**: `preview-comment` ジョブは既存のボットコメントを検索し、存在しなければ投稿する。これにより PR の再実行で重複コメントが発生しない

```javascript
// .github/workflows/ci.yml:119-121
const botComment = comments.find(comment =>
  comment.user.type === "Bot"
  && comment.body.includes("## Preview Branch Testing")
);
```

- **validate スクリプトによるローカル再現性**: CI のチェック項目をローカルで一括実行できる `pnpm validate` を用意し、CI とローカルの検証内容を同期させている

```json
// package.json:22
"validate": "pnpm knip && pnpm check && turbo typecheck && turbo test && pnpm build:validate"
```

- **Changesets の fixed バージョニング**: モノレポ内の全パブリックパッケージを同一バージョンで管理し、バージョンの不整合によるランタイムエラーを防止

- **Dependabot のグループ化**: minor/patch 更新を1つの PR にまとめ、レビュー負担を軽減しつつ依存関係の鮮度を維持

## Anti-Patterns / 注意点

- **セットアップステップの重複**: 4 つの CI ジョブすべてで checkout → pnpm setup → node setup → install を繰り返している。Composite Action や Reusable Workflow で共通化すれば保守性が向上する

```yaml
# Bad: 各ジョブで同一のセットアップを繰り返す
lint:
  steps:
    - uses: actions/checkout@v6
    - uses: pnpm/action-setup@v4
    - uses: actions/setup-node@v6
    - run: pnpm install --frozen-lockfile

typecheck:
  steps:
    - uses: actions/checkout@v6     # 同じ
    - uses: pnpm/action-setup@v4   # 同じ
    - uses: actions/setup-node@v6  # 同じ
    - run: pnpm install --frozen-lockfile  # 同じ
```

```yaml
# Better: Composite Action で共通化
# .github/actions/setup/action.yml
steps:
  - uses: actions/checkout@v6
  - uses: pnpm/action-setup@v4
  - uses: actions/setup-node@v6
    with:
      node-version: 20
      cache: "pnpm"
  - run: pnpm install --frozen-lockfile
```

- **workflow_run の暗黙的な制約**: `workflow_run` は `completed` タイプで成功・失敗の両方をトリガーする。`if` での成功判定を忘れると、CI 失敗時にもリリースが実行される。vercel/chat では正しく対処されているが、この暗黙のセマンティクスは見落としやすい

```yaml
# Bad: workflow_run だけでは CI 失敗時もトリガーされる
on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]

jobs:
  release:
    runs-on: ubuntu-latest
    # ← if が無いと CI 失敗でもリリースが走る
```

```yaml
# Better: ジョブレベルで成功を明示的に確認
jobs:
  release:
    runs-on: ubuntu-latest
    if: ${{ github.event.workflow_run.conclusion == 'success' }}
```

## 導出ルール

- `[MUST]` CI ワークフローでは `pnpm install --frozen-lockfile`（または `npm ci`）を使い、ロックファイルとの不一致でビルドを失敗させる
  - 根拠: `ci.yml` の全ジョブで `--frozen-lockfile` を指定し、CI とローカルの依存バージョンの一致を保証している

- `[MUST]` `workflow_run` トリガーで連鎖するワークフローでは、ジョブレベルの `if` で前ワークフローの `conclusion == 'success'` を必ず検証する
  - 根拠: `release.yml:18` で明示的に成功判定を行っている。`completed` タイプは成功と失敗の両方を含むため、省略するとCI失敗時にもリリースが実行される

- `[MUST]` モノレポの CI は Turborepo 等のタスクランナーでビルド順序の依存関係を宣言的に定義し、test タスクが build 完了後に実行されるようにする
  - 根拠: `turbo.json` で `test` が `build` に依存し、`typecheck` が `^build` に依存する宣言的グラフを構築している

- `[SHOULD]` CI で検証する品質チェック項目をローカルで一括実行できる `validate` スクリプトを用意し、CI とローカルの検証内容を同期させる
  - 根拠: `package.json` の `validate` スクリプトが knip → lint → typecheck → test → build の全チェックをカバーしている

- `[SHOULD]` PR に自動コメントを投稿するジョブは冪等にする（既存コメントの存在チェック後に投稿）
  - 根拠: `ci.yml` の `preview-comment` ジョブが `comments.find()` で既存コメントを検索し、重複投稿を防止している

- `[SHOULD]` CI ジョブで外部サービスの認証情報が必要な場合、モック値を環境変数として渡し、外部依存なしにビルド・テストが完結するようにする
  - 根拠: `ci.yml` の `build-and-test` ジョブですべてのプラットフォーム認証情報にモック値を設定し、外部サービスへの接続なしにテストを実行している

- `[SHOULD]` ブランチ単位の concurrency 制御で `cancel-in-progress: true` を設定し、同一ブランチへの連続 push で古い CI ランをキャンセルする。ただしリリースワークフローでは `cancel-in-progress` を省略して途中キャンセルを防ぐ
  - 根拠: `ci.yml` は `cancel-in-progress: true`、`release.yml` はデフォルトの `false` で使い分けている

- `[SHOULD]` Changesets の `fixed` 設定で関連パッケージ群のバージョンを揃え、`ignore` で非公開パッケージ（サンプルアプリ・テスト）をリリース対象から除外する
  - 根拠: `.changeset/config.json` で全パブリックパッケージを固定バージョンとし、`example-nextjs-chat` と `integration-tests` を除外している

- `[SHOULD]` Dependabot の minor/patch 更新はグループ化して PR ノイズを削減し、更新頻度は monthly に設定してレビュー負担を軽減する
  - 根拠: `dependabot.yml` で `groups.minor-and-patch` を設定し、`interval: monthly` で運用している

- `[AVOID]` CI ワークフローの各ジョブにセットアップステップ（checkout, パッケージマネージャー, Node.js, install）をコピー&ペーストで複製すること。Composite Action か Reusable Workflow で共通化する
  - 根拠: `ci.yml` では 4 ジョブに同一の 4 ステップが重複しており、バージョン更新時に 4 箇所の修正が必要になる

## 適用チェックリスト

- [ ] CI ワークフローの依存インストールに `--frozen-lockfile`（または `npm ci`）を使用しているか
- [ ] CI ジョブが lint・typecheck・build-and-test に分離され、並列実行されているか
- [ ] ブランチ単位の `concurrency` + `cancel-in-progress` が CI ワークフローに設定されているか
- [ ] リリースワークフローが CI 成功の明示的な判定を持っているか（`workflow_run` 使用時）
- [ ] 外部サービス依存のビルド・テストがモック環境変数で自己完結しているか
- [ ] CI の品質チェック項目をローカルで一括実行できる `validate` スクリプトが存在するか
- [ ] Turborepo 等のタスクランナーでビルド→テストの依存関係が宣言されているか
- [ ] モノレポのバージョン管理戦略（fixed / independent）が決定・設定されているか
- [ ] PR への自動コメント投稿が冪等に実装されているか
- [ ] Dependabot の更新がグループ化され、適切な頻度で設定されているか
- [ ] Webhook 等の外部コールバックを受けるアプリにプレビューブランチでの検証手段があるか
