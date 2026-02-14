# CI/CD

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono の CI/CD は「マルチランタイムフレームワーク」という特性を最大限に活かした設計になっている。Node.js / Deno / Bun / Cloudflare Workers (workerd) / Fastly Compute / AWS Lambda / Lambda@Edge の 7 つのランタイムに対するテストを単一の CI ワークフローで並列実行し、さらに PR ごとに型チェック速度・バンドルサイズ・HTTP パフォーマンスの回帰検出を自動化している。`.tool-versions` による全ランタイムのバージョン一元管理、カバレッジのマルチランタイム統合、autofix.ci による自動フォーマット修正など、OSS メンテナンスの負担を最小化する工夫が随所にある。

## 設計・実装の詳細

### ワークフロー全体構成

5 つの GitHub Actions ワークフローで CI/CD パイプラインを構成している。

| ワークフロー | トリガー | 役割 |
|---|---|---|
| `ci.yml` | push (main/next), PR | テスト・リント・カバレッジ・パフォーマンス計測 |
| `autofix.yml` | push (main), PR | フォーマット/リント自動修正 |
| `cr.yml` | push (main), PR (ラベル付き) | pkg.pr.new によるプレビューパッケージ公開 |
| `release.yml` | タグ push | JSR へのパッケージ公開 |
| `no-response.yml` | cron (毎日) | 「not bug」ラベル付き Issue の自動クローズ |

### マルチランタイムテスト戦略

ci.yml には 10 個のテストジョブが定義されており、ランタイムごとに異なるテストインフラを使い分けている。

```yaml
# .github/workflows/ci.yml:34-55
main:           # vitest (メインテストスイート + tsc --noEmit)
deno:           # deno test (3つのJSX設定でテスト)
bun:            # bun test (Linux)
bun-windows:    # bun test (Windows)
fastly:         # vitest + vite-plugin-fastly-js-compute
node:           # vitest (Node.js 18/20/22 マトリックス)
workerd:        # vitest (Cloudflare Workers)
lambda:         # vitest (AWS Lambda)
lambda-edge:    # vitest (Lambda@Edge)
```

vitest の `projects` 機能を使い、ランタイムごとに独立した vitest config を定義している。

```typescript
// vitest.config.ts:26-27
projects: [
  './runtime-tests/*/vitest.config.ts',
```

各ランタイムテストは `vitest --run --project <name>` で個別実行可能であり、package.json のスクリプトに対応している。

```json
// package.json:17-21
"test:bun": "bun test --jsx-import-source ../../src/jsx runtime-tests/bun/*",
"test:fastly": "vitest --run --project fastly",
"test:node": "vitest --run --project node",
"test:workerd": "vitest --run --project workerd",
"test:lambda": "vitest --run --project lambda",
```

Deno テストは vitest を使わず `deno test` を直接実行し、3 つの JSX 設定（react-jsx / precompile / デフォルト）でそれぞれテストしている。

```yaml
# .github/workflows/ci.yml:77-79
- run: env NAME=Deno deno test --coverage=coverage/raw/deno-runtime --allow-read --allow-env --allow-write --allow-net -c runtime-tests/deno/deno.json runtime-tests/deno
- run: deno test -c runtime-tests/deno-jsx/deno.precompile.json --coverage=coverage/raw/deno-precompile-jsx runtime-tests/deno-jsx
- run: deno test -c runtime-tests/deno-jsx/deno.react-jsx.json --coverage=coverage/raw/deno-react-jsx runtime-tests/deno-jsx
```

### .tool-versions によるバージョン一元管理

すべてのランタイムバージョンを `.tool-versions` で一元管理し、CI の `setup-*` アクションから参照している。

```
# .tool-versions
nodejs 24.7.0
bun  1.2.19
deno 2.4.5
```

```yaml
# .github/workflows/ci.yml:41-44
- uses: actions/setup-node@v6
  with:
    node-version-file: '.tool-versions'
- uses: oven-sh/setup-bun@v2
  with:
    bun-version-file: '.tool-versions'
```

これにより CI とローカル開発環境のバージョン乖離が防止され、Node.js マトリックスのみ明示的なバージョン指定（18/20/22）で古い LTS との互換性を検証している。

### カバレッジの統合パイプライン

main / bun / deno の 3 ジョブがそれぞれカバレッジアーティファクトを upload し、`coverage` ジョブが `download-artifact` の `merge-multiple: true` で統合してから Codecov へ送信する。

```yaml
# .github/workflows/ci.yml:15-31
coverage:
  name: 'Coverage'
  runs-on: ubuntu-latest
  needs:
    - main
    - bun
    - deno
  steps:
    - uses: actions/checkout@v6
    - uses: actions/download-artifact@v6
      with:
        pattern: coverage-*
        merge-multiple: true
        path: ./coverage
    - uses: codecov/codecov-action@v5
      with:
        fail_ci_if_error: true
        directory: ./coverage
```

vitest 側ではカバレッジ出力先を `coverage/raw/default` に設定し、Deno は `coverage/raw/deno-runtime` 等に分離している。

### パフォーマンス回帰検出

#### 型チェック + バンドルサイズ（octocov）

カスタム composite action `.github/actions/perf-measures/action.yml` が 3 つの計測を実行する。

1. **tsc 型チェック速度**: 200 ルートの Hono アプリを自動生成し、`tsc --diagnostics` の出力を JSON 化
2. **typescript-go 型チェック速度**: 同じアプリを `tsgo --diagnostics` で計測（tsc との比較）
3. **バンドルサイズ**: esbuild でビルド後のファイルサイズを計測

```typescript
// perf-measures/type-check/scripts/generate-app.ts:4-17
const count = 200

const generateRoutes = (count: number) => {
  let routes = `import { Hono } from '../../../src'
export const app = new Hono()`
  for (let i = 1; i <= count; i++) {
    routes += `
  .get('/route${i}/:id', (c) => {
    return c.json({
      ok: true
    })
  })`
  }
  return routes
}
```

型チェックのベンチマークは `client.ts` で `hc<typeof app>('/')` を使い、型推論のパフォーマンスを計測している。これは Hono の RPC クライアントの型推論が重い処理であることを踏まえた設計。

```typescript
// perf-measures/type-check/client.ts:1-5
import { hc } from '../../src/client'
import type { app } from './generated/app'

const client = hc<typeof app>('/')
```

PR 上では octocov が前回の main との差分をコメントで報告し、main への push 時はベースラインデータを保存する。

#### HTTP ベンチマーク（bombardier）

PR ごとに bombardier を使った HTTP パフォーマンスベンチマークを実行し、baseline (main) と target (PR) の差分を自動コメントする。

```yaml
# .github/workflows/ci.yml:201-205
- name: Install bombardier
  run: |
    wget -O bombardier https://github.com/codesenberg/bombardier/releases/download/v2.0.1/bombardier-linux-amd64
    chmod +x bombardier
    sudo mv bombardier /usr/local/bin/
```

ベンチマークスクリプトは git stash + checkout で baseline コードを取得し、3 エンドポイント（`/`, `/id/:id`, `/json`）に対して並行 500 接続でリクエストを送る。

Fork PR の場合はセキュリティ制約のためコメントを投稿せず、ログ出力にフォールバックする点も考慮されている。

```yaml
# .github/workflows/ci.yml:246-251
- name: Show benchmark results for forks
  if: github.event.pull_request.head.repo.full_name != github.repository
  run: |
    echo "## HTTP Performance Benchmark Results"
    echo "Note: Cannot post comment due to security restrictions on fork PRs"
    cat benchmarks/http-server/benchmark-results.md
```

### autofix.ci による自動修正

PR とメインブランチへの push 時に `bun run format:fix` と `bun run lint:fix` を実行し、autofix-ci/action で自動コミットする。ドラフト PR はスキップする設計。

```yaml
# .github/workflows/autofix.yml:19-33
if: ${{ github.event_name == 'push' || !github.event.pull_request.draft }}
steps:
  - name: Checkout
    uses: actions/checkout@v6
  - uses: oven-sh/setup-bun@v2
  - run: bun install --frozen-lockfile
  - run: bun run format:fix
  - run: bun run lint:fix
  - name: Apply fixes
    uses: autofix-ci/action@v1
    with:
      commit-message: 'ci: apply automated fixes'
```

### pkg.pr.new によるプレビューパッケージ

`cr-tracked` ラベルが付いた PR で `pkg-pr-new publish --compact` を実行し、StackBlitz 上でプレビュー可能なパッケージを公開する。

```yaml
# .github/workflows/cr.yml:15
if: github.repository == 'honojs/hono' && (github.ref == 'refs/heads/main' || contains(github.event.pull_request.labels.*.name, 'cr-tracked'))
```

### リリースパイプライン

タグ push 時に JSR へ自動公開する。npm 公開は `np` ツール経由でローカルから手動実行する設計。

```yaml
# .github/workflows/release.yml:9-25
on:
  push:
    tags:
      - '*'
jobs:
  jsr:
    permissions:
      contents: read
      id-token: write
    steps:
      - run: deno run -A jsr:@david/publish-on-tag@0.1.4
```

jsr.json の `version: "0.0.0"` と `publish-on-tag` の組み合わせにより、タグ名からバージョンを自動決定している。

### ビルド時の export 検証

ビルドスクリプト内で `package.json` と `jsr.json` の exports が同期していることを検証する仕組みがある。

```typescript
// build/validate-exports.ts:1-5
export const validateExports = (
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  fileName: string
) => {
```

```typescript
// build/build.ts:30-31
validateExports(packageJsonExports, jsrJsonExports, 'jsr.json')
validateExports(jsrJsonExports, packageJsonExports, 'package.json')
```

## コード例

### composite action でのパフォーマンス計測統合

```yaml
# .github/actions/perf-measures/action.yml:20-26
- name: Performance measurement of type check (tsc)
  run: |
    bun scripts/generate-app.ts
    bun tsc -p tsconfig.build.json --diagnostics | bun scripts/process-results.ts > diagnostics-tsc.json
  shell: bash
  working-directory: perf-measures/type-check
  env:
    BENCHMARK_TS_IMPL_LABEL: tsc
```

### バンドルサイズ計測スクリプト

```typescript
// perf-measures/bundle-check/scripts/check-bundle-size.ts:6-20
async function main() {
  const tempDir = os.tmpdir()
  const tempFilePath = path.join(tempDir, 'bundle.tmp.js')

  try {
    await esbuild.build({
      entryPoints: ['dist/index.js'],
      bundle: true,
      minify: true,
      format: 'esm' as esbuild.Format,
      target: 'es2022',
      outfile: tempFilePath,
    })

    const bundleSize = fs.statSync(tempFilePath).size
```

### CI 内での paths-ignore による不要実行の回避

```yaml
# .github/workflows/ci.yml:6-11
pull_request:
  branches: ['*']
  paths-ignore:
    - 'docs/**'
    - '.vscode/**'
    - 'README.md'
    - '.gitignore'
    - 'LICENSE'
```

## Good Patterns

- **マルチランタイムカバレッジ統合**: 各ランタイムのテストジョブがアーティファクトとしてカバレッジを upload し、最終ジョブで `merge-multiple: true` を使って統合する。ランタイム固有のコードパスも漏れなくカバレッジに反映される。

```yaml
# .github/workflows/ci.yml:24-28
- uses: actions/download-artifact@v6
  with:
    pattern: coverage-*
    merge-multiple: true
    path: ./coverage
```

- **.tool-versions による一元管理**: CI の `setup-*` アクションが `*-version-file: '.tool-versions'` を参照することで、ローカル開発と CI のバージョンが常に同期する。バージョンアップは 1 ファイルの変更で完結する。

```yaml
# 全ジョブで統一的に参照
- uses: actions/setup-node@v6
  with:
    node-version-file: '.tool-versions'
```

- **型推論パフォーマンスの回帰テスト**: 200 ルートのアプリを自動生成し、RPC クライアントの型推論を含む `tsc --diagnostics` の結果を PR ごとに比較する。型が遅くなる変更を早期に検出できる。

```typescript
// perf-measures/type-check/client.ts:1-5
import { hc } from '../../src/client'
import type { app } from './generated/app'
const client = hc<typeof app>('/')
```

- **Fork PR へのセキュリティ配慮**: HTTP ベンチマーク結果のコメント投稿を `head.repo.full_name == github.repository` でガードし、fork PR では代わりにログ出力にフォールバックする。`GITHUB_TOKEN` の権限悪用を防止している。

- **autofix.ci によるフォーマット自動修正**: コントリビューターにフォーマットルールの学習を強制せず、自動修正コミットで対応する。ドラフト PR はスキップする合理的な判定条件付き。

- **ビルド時の exports 同期検証**: `package.json` と `jsr.json` の exports を双方向でバリデーションし、エントリポイントの追加漏れを防止する。npm と JSR のデュアル公開で発生しやすい不整合を CI レベルで検出。

## Anti-Patterns / 注意点

- **bombardier のバイナリ直接ダウンロード**: HTTP ベンチマークで bombardier をバージョン固定の URL から直接ダウンロードしている。パッケージマネージャや GitHub Action のキャッシュを使わないため、ダウンロード元の可用性に依存する。

```yaml
# Bad: 外部バイナリの直接ダウンロード
- run: |
    wget -O bombardier https://github.com/codesenberg/bombardier/releases/download/v2.0.1/bombardier-linux-amd64
    chmod +x bombardier
    sudo mv bombardier /usr/local/bin/
```

```yaml
# Better: actions/cache でバイナリをキャッシュする
- uses: actions/cache@v4
  with:
    path: /usr/local/bin/bombardier
    key: bombardier-v2.0.1
- run: |
    if [ ! -f /usr/local/bin/bombardier ]; then
      wget -O bombardier https://github.com/.../bombardier-linux-amd64
      chmod +x bombardier
      sudo mv bombardier /usr/local/bin/
    fi
```

- **HTTP ベンチマークの再現性**: CI 環境（GitHub Actions の共有ランナー）で HTTP ベンチマークを実行しているため、同一ランナーの負荷状況で結果にブレが出る。デフォルト `runs=1` だとノイズが大きい可能性がある。ただし、baseline と target を同一ランナーで実行するため相対比較としては許容範囲。

- **concurrency 設定の欠如（ci.yml）**: autofix.yml と cr.yml には `concurrency` でキャンセル制御があるが、ci.yml にはない。連続 push 時に古いジョブが走り続ける可能性がある。

```yaml
# autofix.yml にはある
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

# ci.yml にはない — 追加を検討すべき
```

## 自分のプロジェクトへの適用

- [ ] `.tool-versions` で全ランタイムのバージョンを一元管理し、CI の setup アクションから `*-version-file` で参照する
- [ ] バンドルサイズの回帰検出を導入する（esbuild でビルド + サイズ計測 + octocov で PR コメント）
- [ ] 型チェックのパフォーマンス計測を CI に組み込む（大規模な型推論を含むプロジェクトの場合）
- [ ] autofix.ci を導入し、コントリビューターのフォーマット修正の手間を削減する
- [ ] マルチランタイム対応ライブラリの場合、ランタイムごとのカバレッジをアーティファクト経由で統合する
- [ ] CI ワークフローに `concurrency` + `cancel-in-progress` を設定し、連続 push 時の無駄な実行を防ぐ
- [ ] npm と JSR のデュアル公開時、ビルドスクリプトで exports の同期検証を入れる
- [ ] Fork PR からのワークフロー実行時はコメント投稿など書き込み操作をガードする
