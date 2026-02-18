# CI/CD

> リポジトリ: epicweb-dev/epic-stack
> 分析日: 2026-02-18

## 概要

Epic Stack の CI/CD パイプラインは、単一ワークフローファイル (`deploy.yml`) に 6 つのジョブを集約し、テスト・ビルド・デプロイを一貫して管理する。特に注目すべきは、Playwright 用の DB キャッシュ戦略（スキーマ + マイグレーションのハッシュをキーにする）、ローカル/CI での振る舞い分岐の明示的な設計、そして Build-then-Deploy パターンによるコンテナデプロイの分離である。テストの並列化戦略では Vitest と Playwright で真逆のアプローチを取っており、それぞれのテスト特性に最適化されている。

## 背景にある原則

- **フィードバック速度を最大化する並列ジョブ設計**: lint・typecheck・vitest・playwright・container の 5 ジョブが独立並列に実行され、最も遅いジョブがボトルネックになる。依存関係のないジョブを直列にしない設計により、CI 全体の所要時間を各ジョブの最長時間に抑える（deploy.yml:18-195）。
- **決定論的キャッシュで冪等性を保証する**: DB キャッシュのキーにスキーマファイルとマイグレーション SQL のハッシュを使うことで、「同じスキーマなら同じ DB」を保証する。ファイル内容ベースのキャッシュキーにより、ブランチ名やタイムスタンプに依存しない決定論的なキャッシュ戦略を実現している（deploy.yml:118-126）。
- **環境差異を設定値で吸収し、コードパスは共通化する**: Playwright の `retries`・`workers`・`webServer.command` を `process.env.CI` で切り替えるが、テストコード自体は環境を意識しない。設定レイヤーで差異を吸収することで、ローカルと CI で同一のテストが信頼性を持って動作する（playwright.config.ts:12-14, 31）。
- **ビルドとデプロイを分離して安全弁を設ける**: コンテナのビルド（`container` ジョブ）とデプロイ（`deploy` ジョブ）を別ジョブに分け、`needs` で全テスト通過を前提条件とする。ビルド済みイメージを SHA タグで参照してデプロイすることで、テスト失敗時のデプロイを構造的に防止する（deploy.yml:192-229）。

## 実例と分析

### ジョブ構成とイベントフィルタリング

ワークフローは `push`（main/dev）と `pull_request` の両方でトリガーされるが、`container` と `deploy` ジョブは <code v-pre>if: ${{ github.event_name == 'push' }}</code> で PR 時にはスキップされる。これにより、PR ではテストのみ、マージ後にデプロイという明確な分離が実現されている。

```yaml
# .github/workflows/deploy.yml:1-7
on:
  push:
    branches:
      - main
      - dev
  pull_request: {}
```

`concurrency` 設定で同一ブランチの重複実行を自動キャンセルする。短時間に連続プッシュされた場合、先行ジョブが自動的に中断され、最新のコミットだけがパイプラインを完走する。

::: v-pre

```yaml
# .github/workflows/deploy.yml:9-11
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

:::

### DB キャッシュ戦略（Playwright ジョブ）

Playwright ジョブでは、SQLite の DB ファイルをキャッシュする。キーの設計が秀逸で、`schema.prisma` と全 `migration.sql` のハッシュの組み合わせをキーとしている。

::: v-pre

```yaml
# .github/workflows/deploy.yml:118-131
- name: 🏦 Cache Database
  id: db-cache
  uses: actions/cache@v4
  with:
    path: prisma/data.db
    key:
      db-cache-schema_${{ hashFiles('./prisma/schema.prisma')
      }}-migrations_${{ hashFiles('./prisma/migrations/*/migration.sql')
      }}

- name: 🌱 Seed Database
  if: steps.db-cache.outputs.cache-hit != 'true'
  run: npx prisma migrate reset --force
```

:::

このキー設計により、以下が保証される:

1. スキーマが変更されない限りキャッシュがヒットし、シード処理（数秒〜数十秒）がスキップされる
2. マイグレーションが追加されるとキャッシュが無効化され、新しい DB が生成される
3. スキーマとマイグレーションを別々にハッシュすることで、どちらの変更でもキャッシュが適切に無効化される

### Vitest のテスト並列化とDB分離

Vitest のテストでは `VITEST_POOL_ID` を使ってワーカーごとに独立した DB ファイルを作成する。グローバルセットアップで基盤 DB を1回だけ構築し、各テストの `beforeEach` でコピーする Copy-on-Test パターンを採用している。

```typescript
// tests/setup/db-setup.ts:6-9
const poolId = process.env.VITEST_POOL_ID || "0";
const databaseFile = `./tests/prisma/data.${poolId}.db`;
const databasePath = path.join(process.cwd(), databaseFile);
process.env.DATABASE_URL = `file:${databasePath}`;
```

```typescript
// tests/setup/global-setup.ts:12-25
export async function setup() {
  const databaseExists = await fsExtra.pathExists(BASE_DATABASE_PATH)
  if (databaseExists) {
    const databaseLastModifiedAt = (await fsExtra.stat(BASE_DATABASE_PATH)).mtime
    const prismaSchemaLastModifiedAt = (
      await fsExtra.stat('./prisma/schema.prisma')
    ).mtime
    if (prismaSchemaLastModifiedAt < databaseLastModifiedAt) {
      return
    }
  }
  // スキーマが変更された場合のみ再構築
  await execaCommand(
    'npx prisma migrate reset --force --skip-seed --skip-generate',
    { ... }
  )
}
```

グローバルセットアップではスキーマファイルと基盤 DB の更新日時を比較し、スキーマが変更されていなければ再構築をスキップする。CI だけでなくローカル開発でも同じ最適化が効く。

### Playwright のCI/ローカル設定分岐

```typescript
// playwright.config.ts:12-14,31
retries: process.env.CI ? 2 : 0,
workers: process.env.CI ? 1 : undefined,
// ...
command: process.env.CI ? 'npm run start:mocks' : 'npm run dev',
```

CI では `workers: 1`（直列実行）と `retries: 2` を組み合わせる。E2E テストはブラウザ・サーバー・DB の3層が絡むため、並列実行ではリソース競合による flaky テストが発生しやすい。直列実行 + リトライにより信頼性を優先する判断をしている。ローカルでは `workers: undefined`（CPU コア数に自動調整）と `retries: 0` で高速フィードバックを優先する。

一方で Vitest は `fullyParallel` がデフォルトで有効であり、DB 分離（poolId ベース）によって並列実行しても安全になっている。テストの種類（ユニット vs E2E）に応じて並列化戦略を変えるのが要点である。

### Build-then-Deploy パターン

コンテナのビルドとデプロイを2段階に分離し、SHA ベースのイメージタグで紐付ける。

::: v-pre

```yaml
# .github/workflows/deploy.yml:167-175 (container ジョブ)
flyctl deploy \
  --build-only \
  --push \
  --image-label ${{ github.sha }} \
  --build-arg COMMIT_SHA=${{ github.sha }} \
  --app ${{ steps.app_name.outputs.value }}-staging
```

:::

::: v-pre

```yaml
# .github/workflows/deploy.yml:214-219 (deploy ジョブ)
flyctl deploy \
  --image "registry.fly.io/${{ steps.app_name.outputs.value }}-staging:${{ github.sha }}" \
  --app ${{ steps.app_name.outputs.value }}-staging
```

:::

`deploy` ジョブは `needs: [lint, typecheck, vitest, playwright, container]` で全ジョブの成功を要求する。ビルド済みイメージを SHA で参照するため、デプロイ時に再ビルドが走らず、テスト時と完全に同一のイメージがデプロイされる。

### ブランチベースのデプロイ戦略

::: v-pre

```yaml
# .github/workflows/deploy.yml:168,179
if: ${{ github.ref == 'refs/heads/dev' }}     # → staging
if: ${{ github.ref == 'refs/heads/main' }}     # → production
```

:::

staging（dev ブランチ）と production（main ブランチ）の2環境をブランチで自動選択する。`app_name` を `fly.toml` から動的に読み取り、staging は `-staging` サフィックスで区別する。production ビルドでは Sentry の `--build-secret` を追加し、ソースマップのアップロードを行う。

### マルチステージ Dockerfile

```dockerfile
# other/Dockerfile:4,13,22,29,55
FROM node:22-bookworm-slim as base
FROM base as deps           # 全依存インストール
FROM base as production-deps # devDependencies を除去
FROM base as build          # アプリケーションビルド
FROM base                   # 最終イメージ（最小構成）
```

4段階のマルチステージビルドにより、最終イメージに devDependencies やビルドツールを含めない。`production-deps` ステージで `npm prune --omit=dev` を実行し、本番用の `node_modules` のみを最終イメージにコピーする。

### ヘルスチェックとデプロイの安全性

```typescript
// app/routes/resources/healthcheck.tsx:12-20
await Promise.all([
  prisma.user.count(),
  fetch(`${new URL(request.url).protocol}${host}`, {
    method: "HEAD",
    headers: { "X-Healthcheck": "true" },
  }).then((r) => {
    if (!r.ok) return Promise.reject(r);
  }),
]);
```

ヘルスチェックは DB 接続とアプリケーション自身への HTTP リクエストの両方を検証する。`fly.toml` で 10 秒間隔のヘルスチェックが設定されており、デプロイ後にアプリケーションが正常に起動しない場合は `auto_rollback: true` により自動ロールバックされる。

## パターンカタログ

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: ローカルと CI で異なる実行戦略を使いたいが、テストコード自体は共通化したい
  - 適用条件: 環境ごとに異なるパラメータ（並列度、リトライ、サーバー起動方法）が必要な場合
  - コード例: `playwright.config.ts:12-14,31`（`process.env.CI` による分岐）
  - 注意点: 分岐が増えすぎると環境固有のバグが見逃される。設定値の分岐に留め、ロジック分岐は避ける

## Good Patterns

- **コンテンツベースのキャッシュキー**: ブランチ名やタイムスタンプではなく、実際のファイル内容のハッシュをキャッシュキーにする。キャッシュの有効性がコンテンツの同一性で保証され、不要な再計算を防ぐ。

::: v-pre

```yaml
# .github/workflows/deploy.yml:123-126
key:
  db-cache-schema_${{ hashFiles('./prisma/schema.prisma')
  }}-migrations_${{ hashFiles('./prisma/migrations/*/migration.sql')
  }}
```

:::

- **Pool ID によるテスト分離**: Vitest のワーカー ID (`VITEST_POOL_ID`) を使い、ワーカーごとに独立した DB ファイルを作成する。テストの並列実行時にデータ競合が発生しない。

```typescript
// tests/setup/db-setup.ts:6-8
const poolId = process.env.VITEST_POOL_ID || "0";
const databaseFile = `./tests/prisma/data.${poolId}.db`;
const databasePath = path.join(process.cwd(), databaseFile);
```

- **SHA ベースのイメージタグ**: コンテナイメージに Git の SHA をタグとして付与し、ビルドとデプロイで同一イメージを参照する。ビルド時とデプロイ時のイメージの同一性が保証される。

::: v-pre

```yaml
# .github/workflows/deploy.yml:173-174,218
--image-label ${{ github.sha }}
# ...
--image "registry.fly.io/...:${{ github.sha }}"
```

:::

- **Conditional Seed**: DB キャッシュがヒットした場合はシード処理をスキップし、ミスした場合のみ実行する。CI の実行時間を短縮しつつ、スキーマ変更時のデータ整合性を保つ。

```yaml
# .github/workflows/deploy.yml:129-130
- name: 🌱 Seed Database
  if: steps.db-cache.outputs.cache-hit != 'true'
```

## Anti-Patterns / 注意点

- **環境分岐の設定値ハードコード**: `process.env.CI ? 2 : 0` のような三項演算子での設定値分岐は、環境が増えると管理しづらくなる。現状は CI/ローカルの 2 環境なので問題ないが、staging テストや nightly テストなど環境が増える場合は設定ファイルの分離を検討すべき。

```typescript
// Bad: 環境が増えると三項演算子がネストする
retries: process.env.CI ? 2 : process.env.NIGHTLY ? 5 : 0,

// Better: 環境ごとの設定プロファイル
const profiles = {
  ci: { retries: 2, workers: 1 },
  nightly: { retries: 5, workers: 2 },
  local: { retries: 0, workers: undefined },
}
```

- **全ジョブで重複する DB セットアップ**: lint・typecheck・vitest の 3 ジョブで同一の `prisma migrate deploy && prisma generate --sql` が実行される。各ジョブが独立しているため避けられない面もあるが、composite action への切り出しでメンテナンスコストを下げられる。

```yaml
# Bad: 3箇所に同じステップが重複
- name: 🛠 Setup Database
  run: npx prisma migrate deploy && npx prisma generate --sql

# Better: composite action で共通化
- uses: ./.github/actions/setup-db
```

## 導出ルール

- `[MUST]` CI のキャッシュキーにはファイル内容のハッシュ（`hashFiles`）を使い、ブランチ名やタイムスタンプに依存させない
  - 根拠: Epic Stack は `schema.prisma` と `migration.sql` のハッシュ組み合わせでキャッシュキーを構成し、スキーマ変更時のみキャッシュを無効化する決定論的な設計を実現している（deploy.yml:123-126）

- `[MUST]` テストジョブとデプロイジョブを分離し、`needs` でテスト全通過をデプロイの前提条件にする
  - 根拠: `deploy` ジョブが `needs: [lint, typecheck, vitest, playwright, container]` で全ジョブの成功を要求しており、テスト失敗時のデプロイを構造的に防止している（deploy.yml:195）

- `[SHOULD]` E2E テストの並列度とリトライ回数は環境変数（`CI` フラグ等）で切り替え、テストコード自体は環境を意識しない設計にする
  - 根拠: `playwright.config.ts` で `process.env.CI` による分岐を設定レイヤーに限定し、テストコードは同一のまま CI では安定性重視（workers:1, retries:2）、ローカルでは速度重視（workers:auto, retries:0）を実現している（playwright.config.ts:12-14）

- `[SHOULD]` DB を使うテストを並列実行する場合は、ワーカーごとに独立した DB インスタンスを作成し、基盤 DB のコピーから始める
  - 根拠: `VITEST_POOL_ID` を使って `data.{poolId}.db` を作成し、`beforeEach` で基盤 DB をコピーすることで、並列実行時のデータ競合を防止している（tests/setup/db-setup.ts:6-23）

- `[SHOULD]` コンテナイメージのビルドとデプロイを分離し、Git SHA でイメージを一意に特定する
  - 根拠: <code v-pre>--build-only --push --image-label ${{ github.sha }}</code> でビルドし、<code v-pre>--image "registry.fly.io/...:${{ github.sha }}"</code> でデプロイすることで、テスト通過したイメージと完全に同一のものがデプロイされる（deploy.yml:167-175, 214-219）

- `[AVOID]` テストの重いセットアップ処理（DB 構築、シード等）を毎回のテスト実行で繰り返す — 変更検知（ファイルハッシュ、更新日時比較）でスキップ可能にする
  - 根拠: グローバルセットアップで `schema.prisma` と基盤 DB の更新日時を比較し、スキーマ未変更時は再構築をスキップしている（tests/setup/global-setup.ts:13-25）

## 適用チェックリスト

- [ ] CI ワークフローで独立したジョブ（lint, typecheck, test, e2e）が並列実行される構成になっているか
- [ ] `concurrency` で同一ブランチの重複実行がキャンセルされる設定があるか
- [ ] キャッシュキーがファイル内容のハッシュに基づいているか（ブランチ名やタイムスタンプではなく）
- [ ] DB を使うテストの並列実行時にワーカー間のデータ分離が実現されているか
- [ ] E2E テストの並列度・リトライ数が CI/ローカルで適切に分岐しているか
- [ ] デプロイジョブが全テストジョブの完了を `needs` で要求しているか
- [ ] PR ではテストのみ、マージ後にデプロイという分離が `if` 条件で実現されているか
- [ ] コンテナイメージがビルドとデプロイで同一であることが SHA タグ等で保証されているか
- [ ] ヘルスチェックエンドポイントが DB 接続を含む実質的な検証を行っているか
- [ ] CI で繰り返される共通セットアップ手順が composite action 等で共通化されているか
