# CI/CD

> リポジトリ: vercel/ai
> 分析日: 2026-02-20

## 概要

vercel/ai は 17 の GitHub Actions ワークフローを持つ大規模モノレポで、CI の品質ゲート（型チェック・テスト・バンドルサイズ・モジュールロード時間）、Changesets によるリリース自動化、AI 駆動のトリアージ、label ベースのバックポート、Slack 通知を統合している。特に注目すべきは、バンドルサイズとモジュールロード時間に閾値を設けた「パフォーマンスを品質ゲートに組み込む」設計、マトリクスビルドの結果を安定したジョブ名に集約する「ファサードジョブ」パターン、そして Changesets の `patch` 制約をカスタム検証で強制する独自のバージョニング戦略である。

## 背景にある原則

- **品質ゲートは測定可能な閾値で定義する**: バンドルサイズ（560KB 上限）やモジュールロード時間（65-100ms 上限）のように、数値閾値を CI に組み込むことで「気付かないうちに劣化する」問題を防ぐ。閾値を超えた場合のエラーメッセージに修正方法を含める設計が根拠（`ci.yml:246-251`, `packages/ai/scripts/check-bundle-size.ts:105-110`）。

- **リリースフローは冪等かつ人手を最小化する**: release.yml は `concurrency: { cancel-in-progress: false }` で直列実行を保証し、Changesets action が「PR 作成」と「npm publish」を状態に応じて自動判定する。さらに auto-merge-release-prs.yml がリリース PR を自動承認・マージし、人手介入を排除している（`release.yml:12-14`, `auto-merge-release-prs.yml:17-19`）。

- **マトリクス変更を branch protection から隔離する**: Node.js バージョンやモジュール追加のたびにマトリクスジョブ名が変わるが、ファサードジョブ（`test`, `load-time`）が結果を集約することで branch protection の required check が安定する（`ci.yml:177-189`）。

- **バージョニングポリシーは機械的に強制する**: セマンティックバージョニングに従わず `patch` のみを許可するカスタムポリシーを、CI ワークフローとカスタム検証スクリプトで自動チェックする。ラベルによるバイパス機構で例外も管理する（`verify-changesets.yml`, `.github/workflows/actions/verify-changesets/index.js`）。

## 実例と分析

### 並列品質ゲートの設計

CI ワークフローは 7 つの独立ジョブを並列実行する: `build-examples`, `prettier`, `eslint`, `types`, `bundle-size`, `test_matrix`, `load-time_matrix`。ジョブ間に依存関係がなく、各ジョブが個別に `pnpm install --frozen-lockfile` を実行する。キャッシュは pnpm の `cache: 'pnpm'` 設定と Turborepo の Remote Cache（`TURBO_TOKEN`/`TURBO_TEAM`）で高速化する。

テストジョブのみ `strategy.matrix` で Node.js 20/22 をテストし、ロード時間チェックは `fail-fast: false` でモジュールごとに独立して実行する。

### ファサードジョブパターン

::: v-pre

```yaml
# ci.yml:177-189
test:
  runs-on: ubuntu-latest
  needs: test_matrix
  if: ${{ !cancelled() }}
  steps:
    - name: All matrix versions passed
      if: ${{ !(contains(needs.*.result, 'failure')) }}
      run: exit 0
    - name: Some matrix version failed
      if: ${{ contains(needs.*.result, 'failure') }}
      run: exit 1
```

:::

マトリクスビルドの各バリアントは `Test (20)`, `Test (22)` のように動的な名前を持つため、branch protection の required check として直接指定すると、Node バージョン変更のたびに設定変更が必要になる。ファサードジョブ `test` は常に同じ名前で、マトリクス全体の成否を集約する。<code v-pre>if: ${{ !cancelled() }}</code> により、一部のマトリクスがキャンセルされても必ず実行される。

### Changesets カスタム検証

vercel/ai はセマンティックバージョニングに従わず、`patch` を機能追加とバグ修正の両方に使い、`minor` は「マーケティングリリース」（ブログ記事・マイグレーションガイド付き）にのみ使う独自ポリシーを採用している。これをカスタム Node.js スクリプトで強制する:

```javascript
// .github/workflows/actions/verify-changesets/index.js:50-136
export async function verifyChangesets(event, env, readFile) {
  const byPassLabel = event.pull_request.labels.find(label => BYPASS_LABELS.includes(label.name));
  if (byPassLabel) {
    return `Skipping changeset verification - "${byPassLabel.name}" label found`;
  }

  for (const path of env.CHANGED_FILES.trim().split(" ")) {
    if (path === ".changeset/README.md") continue;
    // ... frontmatter 解析 ...
    const invalidVersionBumps = Object.entries(versionBumps).filter(
      ([, versionBump]) => versionBump !== "patch",
    );
    if (invalidVersionBumps.length > 0) {
      throw Object.assign(
        new Error(`Invalid .changeset file - invalid version bump ...`),
        { path, content },
      );
    }
  }
}
```

この検証にはユニットテストが付属しており（`test.js`、7 テストケース）、CI ワークフロー自体の信頼性を担保している。

### リリースの自動化チェーン

リリースフローは 4 つのワークフローが連鎖する:

1. **verify-changesets.yml**: PR で changeset が `patch` であることを検証
2. **release.yml**: main マージ時に Changesets action が「Version Packages」PR を作成、または既存 PR のマージで npm publish
3. **auto-merge-release-prs.yml**: bot 作成のリリース PR を自動承認・squash マージ
4. **prettier-on-automerge.yml**: auto-merge 有効 PR に Prettier を自動適用

release.yml は GitHub App トークンを使って Git commit する。個人トークンではなく App を使う理由は、App が作成した PR を別のトークンで承認できるようにするためである（`auto-merge-release-prs.yml:27-29` のコメントに明記）。

### snapshot リリース

pre-release モードがモノレポ全体をブロックする問題を回避するため、`workflow_dispatch` によるスナップショットリリースを用意している。バージョンは `0.4.0-{commit-hash}-{timestamp}` 形式で `snapshot` dist-tag に publish される（`release-snapshot.yml:1-29` のコメントに設計理由が詳述）。

### AI 駆動トリアージ

`triage.yml` は `vercel/ai-action@v2` を使い、GPT-4o で Issue/PR のラベルを自動分類する。JSON Schema で出力を制約し、confidence > 0.6 のときのみラベルを適用する。さらに `tigent.yml` でもラベリングルールを定義しており、二重のトリアージ機構を持つ。

### 自動バックポート

`backport.yml` は `backport` ラベル付きの PR がマージされたとき、最新の `release-v*` ブランチに cherry-pick して PR を自動作成する。コンフリクト時はドラフト PR を作成し、cherry-pick の出力を PR 本文に含める。バージョン間のディレクトリ構造差異（`examples/ai-functions` vs `examples/ai-core`）のリマッピングまで自動化している。

### Renovate のスケジュール戦略

依存更新の頻度をパッケージ種別で 4 段階に分けている:

- `packages/*/dependencies`: 毎週金曜
- `packages/*/devDependencies`: 月初金曜
- ルート・examples・tools: 四半期初の金曜
- GitHub Actions ワークフロー: 月の第 3 金曜

## コード例

```yaml
# ci.yml:191-261 — モジュール別ロード時間チェック（閾値付きマトリクス）
load-time_matrix:
  name: 'Load Time Check'
  runs-on: ubuntu-latest
  strategy:
    fail-fast: false
    matrix:
      include:
        - module: 'ai'
          max-load-time: 100
        - module: '@ai-sdk/openai'
          max-load-time: 65
        - module: '@ai-sdk/anthropic'
          max-load-time: 65
```

```javascript
// packages/ai/scripts/check-bundle-size.ts:6-7 — バンドルサイズ上限の定義
const LIMIT = 560 * 1024;
```

```yaml
# release.yml:12-14 — リリースの直列実行保証
concurrency:
  group: 'release'
  cancel-in-progress: false
```

```yaml
# auto-merge-release-prs.yml:17-19 — bot PR の自動マージ条件
if: |
  github.event.pull_request.user.login == 'vercel-ai-sdk[bot]' &&
  startsWith(github.event.pull_request.head.ref, 'changeset-release/')
```

```bash
# .husky/pre-commit:7-15 — package.json 変更時の自動 lockfile 同期
if git diff --cached --name-only | grep -q 'package\.json$'; then
  echo "package.json changes detected, running pnpm install..."
  pnpm install
  git add pnpm-lock.yaml
fi
```

```javascript
// .github/scripts/cleanup-examples-changesets.mjs:19-37 — examples の version リセット
function cleanup(app, url) {
  const appPath = join(fileURLToPath(url), app);
  if (statSync(appPath).isDirectory()) {
    const packageJsonPath = join(appPath, "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    packageJson.version = "0.0.0";
    writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n");
    // CHANGELOG.md も削除
  }
}
```

## パターンカタログ

- **Facade パターン** (分類: 構造)
  - 解決する問題: マトリクスビルドの動的ジョブ名が branch protection と相性が悪い
  - 適用条件: CI マトリクスのバリアント数やラベルが頻繁に変わるモノレポ
  - コード例: `ci.yml:177-189` (test), `ci.yml:264-275` (load-time)
  - 注意点: <code v-pre>if: ${{ !cancelled() }}</code> を忘れると、一部キャンセル時にファサードジョブがスキップされ branch protection が永久に pending になる

- **Chain of Responsibility パターン** (分類: 振る舞い)
  - 解決する問題: リリースプロセスの各段階を独立したワークフローとして分離し、それぞれが自律的に判定・実行する
  - 適用条件: 複数段階のリリースパイプラインで、各段階の責務を明確に分離したい場合
  - コード例: verify-changesets.yml -> release.yml -> auto-merge-release-prs.yml -> prettier-on-automerge.yml
  - 注意点: ワークフロー間の暗黙の依存（PR 作成者が bot であることを前提とする等）をドキュメント化する必要がある

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 依存更新の頻度をパッケージの重要度に応じて変える
  - 適用条件: モノレポで production/dev/infra の依存更新サイクルを分けたい場合
  - コード例: `.github/renovate.json5:12-43`
  - 注意点: スケジュールが複雑すぎると「いつ何が更新されるか」の予測が困難になる

## Good Patterns

- **パフォーマンス閾値を CI に組み込む**: バンドルサイズ（`check-bundle-size.ts` で 560KB 上限）とモジュールロード時間（`ci.yml` で 65-100ms 上限）を CI ゲートとして強制する。閾値超過時のエラーメッセージに「修正方法」と「閾値変更方法」の両方を提示する:

```typescript
// packages/ai/scripts/check-bundle-size.ts:105-110
console.log("\nTo fix this, either:");
console.log("1. Reduce the bundle size by optimizing code");
console.log("2. Update the limit at https://github.com/vercel/ai/settings/...");
```

- **CI ワークフローのカスタムアクションにテストを書く**: changeset 検証のカスタム Node.js スクリプトに 7 件のユニットテストが付属しており、`node --test` で実行できる。CI 自体のロジックをテスト可能にすることで、検証ルール変更時のリグレッションを防ぐ:

```javascript
// .github/workflows/actions/verify-changesets/test.js:6-27
test("happy path", async () => {
  const event = { pull_request: { labels: [] } };
  const env = { CHANGED_FILES: ".changeset/some-happy-path.md" };
  const readFile = mock.fn(async path => {
    return `---\nai: patch\n@ai-sdk/provider: patch\n---\n## Test changeset`;
  });
  await verifyChangesets(event, env, readFile);
  assert.strictEqual(readFile.mock.callCount(), 1);
});
```

- **NPM トークンの定期的なバリデーション**: `validate-npm-token.yml` で毎時トークンの有効性を検証し、失効時は Slack 通知する。リリース時に「トークンが無効でした」と気付くのを予防する。

- **pre-commit で lockfile 同期を自動化**: `.husky/pre-commit` で `package.json` のステージング変更を検出し、自動で `pnpm install` → `git add pnpm-lock.yaml` を実行する。lint-staged 経由だとファイルごとに実行されてしまう問題を回避するため、pre-commit フック本体に実装している。

## Anti-Patterns / 注意点

- **GitHub App トークンの複雑な取得パターンの重複**: `release.yml`, `backport.yml`, `triage.yml`, `update-model-settings.yml`, `prettier-on-automerge.yml` の 5 ワークフローで App トークン取得の 3 ステップ（create token -> get user ID -> configure git）が重複している。Composite Action への切り出しが検討されるべき:

::: v-pre

```yaml
# Bad: 5 つのワークフローで同じ 3 ステップが重複
- name: Create access token for GitHub App
  uses: actions/create-github-app-token@v2
  id: app-token
  with:
    app-id: ${{ vars.VERCEL_AI_SDK_GITHUB_APP_CLIENT_ID }}
    private-key: ${{ secrets.VERCEL_AI_SDK_GITHUB_APP_PRIVATE_KEY_PKCS8 }}
- name: Get GitHub App User ID
  id: app-user-id
  run: echo "user-id=$(gh api ...)" >> "$GITHUB_OUTPUT"
- name: Configure git user for GitHub App
  run: |
    git config --global user.name '...'
    git config --global user.email '...'

# Better: Composite Action に集約
- uses: ./.github/actions/setup-app-token
  id: app
  with:
    app-id: ${{ vars.VERCEL_AI_SDK_GITHUB_APP_CLIENT_ID }}
    private-key: ${{ secrets.VERCEL_AI_SDK_GITHUB_APP_PRIVATE_KEY_PKCS8 }}
```

:::

- **pnpm バージョンのハードコード分散**: `pnpm/action-setup` の `version: 10.11.0` が CI ワークフロー内に散在している。`package.json` の `packageManager` フィールドと二重管理になっている。`pnpm/action-setup@v4` は `packageManager` フィールドを自動検出するため、ワークフロー側の version 指定は不要にできる:

```yaml
# Bad: バージョンが ci.yml 内に 6 回ハードコード
- uses: pnpm/action-setup@v4
  with:
    version: 10.11.0

# Better: packageManager フィールドに任せる
- uses: pnpm/action-setup@v4
```

## 導出ルール

- `[MUST]` パフォーマンス劣化を防ぐ指標（バンドルサイズ、ロード時間等）は CI の品質ゲートとして閾値付きで自動チェックする。閾値超過時のエラーメッセージに修正方法を含める
  - 根拠: vercel/ai は 560KB のバンドルサイズ上限と 65-100ms のロード時間上限を CI で強制し、エラーメッセージに修正手順を記載している（`ci.yml:246-251`, `check-bundle-size.ts:105-110`）

- `[MUST]` リリースワークフローには `concurrency` で直列実行を保証し、`cancel-in-progress: false` で実行中のリリースがキャンセルされないようにする
  - 根拠: npm publish の並行実行はバージョン競合を引き起こすため、vercel/ai は `concurrency: { group: 'release', cancel-in-progress: false }` で保護している（`release.yml:12-14`）

- `[MUST]` CI マトリクスの結果を集約するファサードジョブを作り、そのジョブ名を branch protection の required check に指定する。ファサードジョブには <code v-pre>if: ${{ !cancelled() }}</code> を付ける
  - 根拠: マトリクスのバリアント名は変動するため、直接 required check に使うとバージョン追加・削除のたびに設定変更が必要になる（`ci.yml:177-189` のコメントに設計理由が明記）

- `[SHOULD]` CI で使うカスタム検証スクリプト（changeset 検証、バンドルサイズチェック等）にはユニットテストを付ける
  - 根拠: vercel/ai の changeset 検証スクリプトは 7 件のテストを持ち、`node --test` で実行可能。CI ロジック自体のバグを防ぐ（`.github/workflows/actions/verify-changesets/test.js`）

- `[SHOULD]` リリースに使うクレデンシャル（NPM トークン等）はスケジュールワークフローで定期的に有効性を検証し、失効時は Slack 等で通知する
  - 根拠: vercel/ai は毎時 NPM トークンを検証し、失効をリリース前に検出する（`validate-npm-token.yml`）

- `[SHOULD]` Changesets モノレポで examples/ のバージョンが不要な場合、`ci:version` スクリプトで version リセット + CHANGELOG 削除のクリーンアップを挟む
  - 根拠: vercel/ai は `cleanup-examples-changesets.mjs` で examples の version を `0.0.0` に戻し、不要な CHANGELOG を削除する（`package.json:22`）

- `[SHOULD]` 依存更新の頻度をパッケージの重要度で段階的に設定する（本番依存は高頻度、ツール・例は低頻度）
  - 根拠: vercel/ai は Renovate で 4 段階のスケジュールを設定し、ノイズを制御しながら更新を継続している（`.github/renovate.json5`）

- `[AVOID]` 同じ GitHub App トークン取得パターンを複数ワークフローにコピー&ペーストする。Composite Action に集約する
  - 根拠: vercel/ai は 5 ワークフローで 3 ステップの App トークン取得が重複しており、変更時に全箇所の同期が必要

- `[AVOID]` パッケージマネージャのバージョンを CI ワークフローと `package.json` の `packageManager` フィールドで二重管理する
  - 根拠: vercel/ai は `pnpm/action-setup` に `version: 10.11.0` を指定しつつ `package.json` にも `"packageManager": "pnpm@10.11.0"` を持ち、更新時に 2 箇所の変更が必要

## 適用チェックリスト

- [ ] バンドルサイズやロード時間の閾値を CI ゲートとして設定しているか
- [ ] リリースワークフローに concurrency 設定があり、並行実行を防いでいるか
- [ ] CI マトリクスにファサードジョブを設け、branch protection がマトリクス変更に影響されないようにしているか
- [ ] カスタム CI スクリプトにユニットテストがあるか
- [ ] NPM トークンなどのクレデンシャルを定期検証する仕組みがあるか
- [ ] モノレポの examples/ 等、リリース不要なパッケージの changeset クリーンアップが自動化されているか
- [ ] 依存更新の頻度がパッケージの重要度に応じて段階的に設定されているか
- [ ] GitHub App トークン取得などの共通ステップが Composite Action に集約されているか
- [ ] pre-commit フックで lockfile の同期が自動化されているか
- [ ] snapshot リリースの仕組みがあり、pre-release モードを使わずにブランチの動作確認ができるか
