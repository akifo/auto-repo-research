# CI/CD

> リポジトリ: TanStack/query
> 分析日: 2026-02-17

## 概要

TanStack Query は 20 以上のパッケージを擁するマルチフレームワーク（React/Vue/Solid/Svelte/Angular/Preact）モノレポで、Nx による分散タスク実行、Changesets によるバージョン管理、pkg-pr-new による PR プレビューパブリッシュを組み合わせた CI/CD パイプラインを構築している。PR では `nx affected` で変更影響範囲のみを検証し、リリースブランチでは `nx run-many` で全パッケージを検証するという二段構えの品質ゲート設計が特徴的である。さらに autofix.ci によるフォーマット自動修正、provenance チェック、size-limit によるバンドルサイズ監視、publint/attw によるパッケージ品質検証など、多層的な品質保証を実現している。

## 背景にある原則

- **影響範囲限定の原則**: PR CI では `nx affected` を使い、変更に影響するパッケージのみテストを実行する。これにより 20 以上のパッケージを持つモノレポでも PR フィードバックを高速に保つ。一方リリース時は `nx run-many` で全パッケージを検証し、間接的な破壊を見逃さない（`package.json:13-14` の `test:pr` vs `test:ci`）。

- **品質ゲートの多層化原則**: 単一のテストスイートに頼らず、lint（eslint）、型検査（複数 TS バージョン）、ユニットテスト（vitest）、ビルド検証（publint + attw）、バンドルサイズ（size-limit）、ドキュメントリンク検証（verify-links）、依存関係整合性（sherif）、未使用コード検出（knip）を独立したターゲットとして並列実行する。各ゲートが独立しているため、失敗箇所の特定が容易になる。

- **自動修正と検証の分離原則**: autofix.ci ワークフローはフォーマット修正を自動コミットし、PR ワークフローは検証のみを行う。修正可能な問題（フォーマット）は機械が直し、人間のレビュー負荷を減らす。一方で意味的な問題（型エラー、テスト失敗）は人間が判断する（`.github/workflows/autofix.yml`）。

- **リリースチャネルのブランチマッピング原則**: `main`, `alpha`, `beta`, `rc`, `v4` の各ブランチが独立したリリースチャネルに対応し、同一のリリースワークフローで処理される。Changesets がバージョン番号とチャネル（prerelease tag）を管理するため、ワークフロー側にチャネル固有のロジックが不要になる（`release.yml:5`）。

## 実例と分析

### PR ワークフローの三層構造

PR ワークフロー（`pr.yml`）は Test、Preview、Provenance の 3 ジョブを並列実行する。

**Test ジョブ**: Nx Cloud の分散実行エージェントを起動し、`nx affected` で変更影響範囲のタスクのみを実行する。`nrwl/nx-set-shas` アクションが `main` ブランチとの差分から影響範囲を算出する。

**Preview ジョブ**: `pkg-pr-new` で全パッケージをビルドし、PR ごとのプレビュー npm パッケージを公開する。`--template './examples/*/*'` オプションにより、examples ディレクトリも含めたテンプレートが生成され、レビュアーが即座に動作確認できる。

**Provenance ジョブ**: `danielroe/provenance-action` で依存関係の provenance（来歴）をチェックし、サプライチェーン攻撃のリスクを低減する。`fail-on-downgrade: true` により、依存パッケージのダウングレードを検出する。

### Nx によるタスクオーケストレーション

`nx.json` の `targetDefaults` でタスク間の依存関係と入力キャッシュを精密に定義している。

```
test:eslint  → dependsOn: [^compile]  → inputs: [default, ^production, eslint.config.js]
test:lib     → dependsOn: [^compile]  → inputs: [default, ^production]
test:build   → dependsOn: [build]     → inputs: [production]
build        → dependsOn: [^build]    → inputs: [production, ^production]
```

`^` プレフィックスは依存パッケージのタスクを意味する。例えば `test:eslint` は自パッケージの `compile` だけでなく、依存先の `compile` も完了してから実行される。`namedInputs` で `.md` ファイルやテストファイルをキャッシュキーから除外し、不要な再実行を防いでいる。

### 分散 CI 実行の動的スケーリング

`.nx/workflows/dynamic-changesets.yaml` で changeset のサイズに応じてエージェント数を動的に変更する。

```yaml
# .nx/workflows/dynamic-changesets.yaml
distribute-on:
  small-changeset: 3 linux-medium-js
  medium-changeset: 4 linux-medium-js
  large-changeset: 5 linux-medium-js
```

小さな変更では 3 エージェント、大きな変更では 5 エージェントに自動スケールし、コストとスピードのバランスを取る。

### 複数 TypeScript バージョンでの型検査

各パッケージの `test:types` スクリプトは `npm-run-all --serial test:types:*` で TS 5.0 から 5.8 まで 9 バージョンを順番に検証する。`tsconfig.legacy.json` を用いて古いバージョンでもビルドが通ることを保証する。

```json
// packages/react-query/package.json:22-29
"test:types:ts50": "node ../../node_modules/typescript50/lib/tsc.js --build tsconfig.legacy.json",
"test:types:ts51": "node ../../node_modules/typescript51/lib/tsc.js --build tsconfig.legacy.json",
// ... ts52 ~ ts57
"test:types:tscurrent": "tsc --build"
```

各 TS バージョンは `typescriptXX` というエイリアスで `npm:typescript@5.X` としてインストールされ（`package.json:76-83`）、`node ../../node_modules/typescriptXX/lib/tsc.js` で直接呼び出される。これにより通常の `tsc` と干渉せずに複数バージョンを同一モノレポ内で扱える。

### パッケージビルド品質の二重検証

`test:build` スクリプトは `publint --strict && attw --pack` を実行する。

- **publint**: package.json の `exports`, `main`, `module`, `types` フィールドが正しく設定されているか検証する
- **attw** (Are The Types Wrong): パッケージのエクスポートが各モジュール解決方式（ESM/CJS、bundler/node16 等）で正しく解決されるか検証する

これらは `nx.json` で `dependsOn: ["build"]` と定義されており、ビルド後に自動実行される。

### symlink ベースの共有設定

`root.eslint.config.js` と `root.tsup.config.js` は各パッケージから monorepo ルートへの symlink になっている。

```
packages/query-core/root.eslint.config.js -> ../../eslint.config.js
packages/query-core/root.tsup.config.js   -> ../../scripts/getTsupConfig.js
```

各パッケージの `eslint.config.js` は `import rootConfig from './root.eslint.config.js'` で共有設定を読み込み、パッケージ固有のオーバーライドを追加できる構造になっている。

### Integration テストによるビルドツール互換性検証

`integrations/` ディレクトリに実際のビルドツール環境を配置し、ビルドが通るかを検証する。

- `react-webpack-4`, `react-webpack-5` — Webpack 4/5 での CJS/ESM 互換性
- `react-next-14`, `react-next-15`, `react-next-16` — Next.js バージョン互換性
- `react-vite`, `solid-vite`, `svelte-vite`, `vue-vite` — フレームワーク別 Vite 環境
- `angular-cli-20` — Angular CLI 環境

これらは `workspace:*` でローカルパッケージを参照し、ビルドの成否でエクスポートの正しさを実環境レベルで検証する。

### 自動ラベリングの生成

`scripts/generate-labeler-config.ts` は `packages/` ディレクトリを走査して `labeler-config.yml` を自動生成する。パッケージ追加時に手動で設定ファイルを更新する必要がなく、ラベル設定の不整合を防止する。

## コード例

```json
// package.json:13-14 — PR vs CI のタスク実行戦略
"test:pr": "nx affected --targets=test:sherif,test:knip,test:docs,test:eslint,test:lib,test:types,test:build,build",
"test:ci": "nx run-many --targets=test:sherif,test:knip,test:docs,test:eslint,test:lib,test:types,test:build,build",
```

```yaml
# .github/workflows/pr.yml:6-8 — 同一 PR の重複実行をキャンセル
concurrency:
  group: ${{ github.workflow }}-${{ github.event.number || github.ref }}
  cancel-in-progress: true
```

```yaml
# .github/workflows/release.yml:51-58 — Changesets Action によるリリース自動化
- name: Run Changesets (version or publish)
  id: changesets
  uses: changesets/action@v1.5.3
  with:
    version: pnpm run changeset:version
    publish: pnpm run changeset:publish
    commit: 'ci: Version Packages'
    title: 'ci: Version Packages'
```

```json
// nx.json:27-34 — タスク入力によるキャッシュ精密化
"namedInputs": {
  "default": [
    "sharedGlobals",
    "{projectRoot}/**/*",
    "!{projectRoot}/**/*.md"
  ],
  "production": [
    "default",
    "!{projectRoot}/tests/**/*",
    "!{projectRoot}/eslint.config.js"
  ]
}
```

```yaml
# .github/workflows/pr.yml:52 — pkg-pr-new による PR プレビューパブリッシュ
run: pnpx pkg-pr-new publish --pnpm --compact './packages/*' --template './examples/*/*'
```

## パターンカタログ

- **Pipeline パターン** (分類: 振る舞い)
  - 解決する問題: 多数の品質チェックを効率的に順序制御しつつ並列実行する
  - 適用条件: モノレポで複数の独立したテスト・ビルドタスクがあり、一部に依存関係がある場合
  - コード例: `nx.json` の `targetDefaults` で `dependsOn` によるタスク依存グラフを定義
  - 注意点: 依存関係の定義を誤ると不要な直列化やキャッシュ無効化が発生する

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: PR と リリースで異なるテスト実行戦略を使い分ける
  - 適用条件: 同一のテストスイートを場面によって異なる範囲で実行したい場合
  - コード例: `test:pr`（`nx affected`）vs `test:ci`（`nx run-many`）— `package.json:13-14`
  - 注意点: `affected` の基準ブランチが正しく設定されていないと意図しない範囲でテストが実行される

## Good Patterns

- **品質ゲートの独立タスク化**: 各品質チェック（lint, types, test, build, size）を独立した Nx ターゲットとして定義し、並列実行と個別キャッシュを実現する。失敗時にどのゲートが落ちたか即座に特定でき、修正後は該当タスクのみ再実行される。

```json
// package.json:13 — 8 つの独立ターゲットを一度に実行
"test:pr": "nx affected --targets=test:sherif,test:knip,test:docs,test:eslint,test:lib,test:types,test:build,build"
```

- **Concurrency グループによる重複排除**: ワークフロー名と PR 番号（またはブランチ ref）を組み合わせたグループで、同一 PR の古い実行を自動キャンセルする。force push 後に二重実行が走ることを防ぐ。

```yaml
# .github/workflows/pr.yml:6-8
concurrency:
  group: ${{ github.workflow }}-${{ github.event.number || github.ref }}
  cancel-in-progress: true
```

- **パッケージ配布品質の機械的検証**: `publint --strict && attw --pack` により、package.json の exports フィールドとビルド成果物の整合性を機械的に検証する。人間のレビューでは見落としやすい CJS/ESM デュアル配布の問題を自動検出する。

```json
// packages/query-core/package.json:33
"test:build": "publint --strict && attw --pack"
```

- **共有設定の symlink 運用**: モノレポ全体の設定（eslint, tsup）を symlink 経由で各パッケージに配布し、1 箇所の変更が全パッケージに反映される。パッケージ固有の設定は import 元のファイルでオーバーライド可能。

```javascript
// packages/query-core/eslint.config.js
import rootConfig from './root.eslint.config.js'  // symlink → ../../eslint.config.js
export default [...rootConfig]
```

## Anti-Patterns / 注意点

- **Nx キャッシュの過剰信頼**: Nx の入力定義から漏れたファイル（環境変数、外部サービスの状態等）がビルドに影響する場合、キャッシュが誤ったままになる。TanStack Query では `sharedGlobals` に `.nvmrc` や `pnpm-workspace.yaml` を含めることで対策しているが、明示的に定義されていないファイルは見落とされる。

```json
// Bad: 入力に含まれないファイルがビルドに影響
"build": { "cache": true, "inputs": ["production"] }
// ↑ 環境変数や外部設定ファイルの変更を検知できない

// Better: 影響するファイルを sharedGlobals に明示
"sharedGlobals": [
  "{workspaceRoot}/.nvmrc",
  "{workspaceRoot}/package.json",
  "{workspaceRoot}/scripts/*.js"
]
```

- **全バージョン直列テストのボトルネック化**: `test:types` は `npm-run-all --serial` で 9 バージョンの TypeScript を順番に実行するため、最も時間のかかるタスクの一つになりうる。並列化や最小/最新バージョンのみの実行で高速化できる場面もあるが、型互換性の保証とのトレードオフがある。

```json
// Bad: 全バージョン直列で時間がかかる
"test:types": "npm-run-all --serial test:types:*"

// Better（トレードオフあり）: PR では最新 + 最古のみ、リリースで全バージョン
"test:types:quick": "npm-run-all --parallel test:types:ts50 test:types:tscurrent"
```

## 導出ルール

- `[MUST]` CI ワークフローに concurrency グループと `cancel-in-progress: true` を設定し、同一 PR/ブランチの重複実行を排除する
  - 根拠: TanStack Query の全ワークフロー（pr.yml, release.yml, autofix.yml）で `group: ${{ github.workflow }}-${{ github.event.number || github.ref }}` が設定されており、force push 後の二重実行を防止している

- `[MUST]` パッケージのビルド品質を publint や attw 等のツールで機械的に検証する品質ゲートを CI に組み込む
  - 根拠: 全 22 パッケージの `test:build` で `publint --strict && attw --pack` を実行し、exports フィールドとビルド成果物の不整合（CJS/ESM デュアル配布の問題）を自動検出している

- `[SHOULD]` PR では変更影響範囲のみテストし（`affected`）、リリースブランチでは全範囲をテストする（`run-many`）二段構えのテスト戦略を採用する
  - 根拠: `test:pr` が `nx affected` を、`test:ci` が `nx run-many` を使い分けることで、PR の高速フィードバックとリリースの網羅的検証を両立している

- `[SHOULD]` モノレポのタスクキャッシュでは、ビルドに影響しないファイル（`.md`、テストファイル、設定ファイル）をキャッシュ入力から除外して不要な再実行を防ぐ
  - 根拠: `nx.json` の `namedInputs` で `!{projectRoot}/**/*.md` や `!{projectRoot}/tests/**/*` を除外し、ドキュメント修正時にビルドキャッシュが無効化されないようにしている

- `[SHOULD]` フォーマット修正のような機械的に解決可能な問題は自動修正ワークフローで処理し、PR の検証ワークフローとは分離する
  - 根拠: `autofix.yml` が prettier のフォーマット修正を自動コミットし、`pr.yml` の Test ジョブでは意味的な検証（型、テスト、lint）のみに集中している

- `[SHOULD]` ライブラリ公開パッケージでは、サポート対象の TypeScript バージョン全てで型検査を CI に含める
  - 根拠: 各パッケージが TS 5.0〜5.8 の 9 バージョンで `tsc --build` を実行し、型定義の後方互換性を保証している

- `[AVOID]` CI 設定ファイル（ラベラー設定等）の手動メンテナンスに依存すること。ディレクトリ構造から自動生成するスクリプトを用意する
  - 根拠: `scripts/generate-labeler-config.ts` が `packages/` ディレクトリを走査して `labeler-config.yml` を自動生成しており、パッケージ追加時の設定漏れを防止している

## 適用チェックリスト

- [ ] GitHub Actions ワークフローに `concurrency` グループを設定し、同一 PR の重複実行をキャンセルしているか
- [ ] PR 用とリリース用で異なるテスト範囲（affected vs run-many）を使い分けているか
- [ ] 各品質チェック（lint, test, types, build）が独立したターゲットとして定義され、並列実行可能か
- [ ] Nx 等のタスクランナーでキャッシュ入力（inputs）を精密に定義し、不要な再実行を防いでいるか
- [ ] npm パッケージ公開前に publint / attw 等でパッケージ品質を機械的に検証しているか
- [ ] サポート対象の TypeScript バージョン全てで型検査を CI に含めているか
- [ ] フォーマット修正が自動化され、開発者が手動で修正する必要がないか
- [ ] CI 設定ファイル（ラベラー設定等）がコードから自動生成される仕組みがあるか
- [ ] リリースブランチ（alpha, beta, rc 等）がワークフローで適切に処理されているか
- [ ] PR プレビューパッケージの仕組み（pkg-pr-new 等）でレビュアーが変更を即座に試せるか
