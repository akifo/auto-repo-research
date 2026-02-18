# Practice: Monorepo Quality Gates

> 出典: repos/TanStack/query からの知見
> カテゴリ: practice

## 概要

publint（exports 整合性）、@arethetypeswrong/cli（CJS/ESM 型解決）、size-limit（バンドルサイズ回帰）、sherif（依存バージョン整合性）、knip（未使用コード検出）の 5 層 CI 品質検証パターン。単一ツールでは捕捉できない問題を包括的に防ぐモノレポ品質管理手法であり、「ビルドは通るが import で壊れる」「気づかないうちにバンドルサイズが肥大化する」「未使用コードが蓄積する」といった、人間のレビューでは見落としやすい問題を機械的に検出する。

## 背景・文脈

TanStack Query は 24 以上のパッケージを持つマルチフレームワーク（React / Vue / Solid / Svelte / Angular / Preact）対応モノレポで、CJS + ESM デュアル出力のライブラリを npm に公開している。パッケージ数が多く、フレームワークごとにビルド戦略が異なるため、手動レビューだけでは exports フィールドの不整合、型解決の問題、依存バージョンのドリフトを網羅的に検出することが困難である。そこで 5 つの独立した品質検証ツールを Nx のタスクグラフに組み込み、PR ごとに自動実行する設計を採用している。

さらに、PR では `nx affected` で変更影響範囲のみを検証し、リリースブランチでは `nx run-many` で全パッケージを検証する二段構えのテスト戦略により、CI のフィードバック速度とリリース品質を両立している。

## 実装パターン

### 1. 5 層品質ゲートの全体構成

各ツールの検出領域は以下のように分担されている。

| ツール                       | 役割                 | 検出する問題                                                     |
| ---------------------------- | -------------------- | ---------------------------------------------------------------- |
| publint                      | exports 整合性       | package.json の exports/main/module/types とビルド成果物の不一致 |
| @arethetypeswrong/cli (attw) | CJS/ESM 型解決       | ESM/CJS 各モジュール解決方式での型定義の解決失敗                 |
| size-limit                   | バンドルサイズ回帰   | PR によるバンドルサイズの意図しない増加                          |
| sherif                       | 依存バージョン整合性 | モノレポ内パッケージ間の依存バージョン不整合                     |
| knip                         | 未使用コード検出     | 未使用の export、依存関係、ファイル                              |

### 2. パッケージレベルのスクリプト定義

```jsonc
// packages/query-core/package.json:33
"test:build": "publint --strict && attw --pack"
```

各パッケージの `test:build` で publint と attw を直列実行する。`--strict` フラグにより warnings もエラーとして扱い、`--pack` で実際の npm pack 結果に対して検証する。

### 3. ルートレベルのスクリプト定義

```jsonc
// package.json:13-14
"test:pr": "nx affected --targets=test:sherif,test:knip,test:docs,test:eslint,test:lib,test:types,test:build,build",
"test:ci": "nx run-many --targets=test:sherif,test:knip,test:docs,test:eslint,test:lib,test:types,test:build,build",
```

```jsonc
// package.json:16-17,22
"test:sherif": "sherif -i typescript -p \"./integrations/*\" -p \"./examples/*\"",
"test:size": "size-limit",
"test:knip": "knip",
```

### 4. Nx によるタスク依存グラフ

```jsonc
// nx.json:27-78
"targetDefaults": {
  "compile": {
    "cache": true,
    "inputs": ["default", "^production"],
    "outputs": ["{projectRoot}/dist-ts"]
  },
  "test:eslint": {
    "cache": true,
    "dependsOn": ["^compile"],
    "inputs": ["default", "^production", "{workspaceRoot}/eslint.config.js"]
  },
  "build": {
    "cache": true,
    "dependsOn": ["^build"],
    "inputs": ["production", "^production"],
    "outputs": ["{projectRoot}/build", "{projectRoot}/dist"]
  },
  "test:build": {
    "cache": true,
    "dependsOn": ["build"],
    "inputs": ["production"]
  }
}
```

`test:build` は `dependsOn: ["build"]` により、ビルド完了後に必ず実行される。ビルド成果物が存在しない状態での検証を防ぎ、false negative を排除する。

### 5. size-limit の閾値管理

```json
// .size-limit.json:1-15
[
  {
    "name": "react full",
    "path": "packages/react-query/build/modern/index.js",
    "limit": "13.00 kB",
    "ignore": ["react", "react-dom"]
  },
  {
    "name": "react minimal",
    "path": "packages/react-query/build/modern/index.js",
    "limit": "9.99 kB",
    "import": "{ useQuery, QueryClient, QueryClientProvider }",
    "ignore": ["react", "react-dom"]
  }
]
```

full import（全 API）と minimal import（最小利用パターン）の両方に閾値を設定し、ユースケースごとのサイズ回帰を検知する。

### 6. knip の設定

```json
// knip.json:1-32
{
  "$schema": "https://unpkg.com/knip@5/schema.json",
  "ignore": [
    ".pnpmfile.cjs",
    "scripts/*.{j,t}s",
    "**/root.*.config.*",
    "**/ts-fixture/file.ts"
  ],
  "ignoreDependencies": [
    "@types/react",
    "@types/react-dom",
    "react",
    "react-dom"
  ],
  "ignoreWorkspaces": ["examples/**", "integrations/**"]
}
```

シンボリックリンク経由の設定ファイル（`root.*.config.*`）を ignore し、examples/integrations を検証対象から除外することで、ライブラリパッケージの未使用コードに集中する。

### 7. CI ワークフローへの組み込み

:::: v-pre

```yaml
# .github/workflows/pr.yml:6-8,34-35
concurrency:
  group: ${{ github.workflow }}-${{ github.event.number || github.ref }}
  cancel-in-progress: true

# Test ジョブ
- name: Run Checks
  run: pnpm run test:pr  # nx affected で変更影響範囲のみ

# Preview ジョブ内の size-limit
- name: Size Limit
  uses: andresz1/size-limit-action@94bc357df29c36c8f8d50ea497c3e225c3c95d1d
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    skip_step: install
    build_script: build:all
```

::::

```yaml
# .github/workflows/release.yml:36
- name: Run Tests
  run: pnpm run test:ci  # nx run-many で全パッケージ
```

PR では `test:pr`（`nx affected`）、リリースでは `test:ci`（`nx run-many`）を使い分ける。size-limit は `size-limit-action` により PR コメントとしてサイズ差分を可視化する。

## Good Example

5 つのツールを独立した Nx ターゲットとして定義し、タスク依存グラフで実行順序を制御する。

```jsonc
// package.json — ルートスクリプト
{
  "scripts": {
    "test:pr": "nx affected --targets=test:sherif,test:knip,test:eslint,test:lib,test:types,test:build,build",
    "test:ci": "nx run-many --targets=test:sherif,test:knip,test:eslint,test:lib,test:types,test:build,build",
    "test:sherif": "sherif -i typescript -p \"./integrations/*\" -p \"./examples/*\"",
    "test:knip": "knip",
    "test:size": "size-limit"
  }
}

// packages/*/package.json — パッケージスクリプト
{
  "scripts": {
    "test:build": "publint --strict && attw --pack"
  }
}

// nx.json — ビルド後に test:build を実行
{
  "targetDefaults": {
    "test:build": {
      "cache": true,
      "dependsOn": ["build"],
      "inputs": ["production"]
    }
  }
}
```

各品質ゲートが独立しているため、失敗箇所の特定が容易であり、修正後は該当タスクのみ再実行される。PR では変更影響範囲のみ、リリースでは全パッケージを検証することで、速度と網羅性を両立する。

## Bad Example

品質チェックを単一のスクリプトにまとめ、依存関係を考慮しない実装。

```jsonc
// Bad: 全チェックを一つのスクリプトに直列実行
{
  "scripts": {
    "test": "publint --strict && attw --pack && sherif && knip && size-limit"
  }
}
// 問題点:
// - ビルド前に publint/attw が走る可能性がある（false negative）
// - 最初のツールが失敗すると後続が実行されず、全体の問題が見えない
// - キャッシュが効かず、無関係な変更でも全チェックが再実行される
// - PR でも全パッケージが対象になり、CI が遅い

// Bad: 品質ツールを導入せず手動レビューに依存
{
  "scripts": {
    "test:build": "echo 'check exports manually'"
  }
}
// 問題点:
// - CJS/ESM デュアル出力の型解決問題は人間のレビューでは検出困難
// - パッケージ数が増えるほど、exports 不整合の見落としリスクが増大
```

## 適用ガイド

### どのような状況で使うべきか

- npm に公開するパッケージを 3 つ以上持つモノレポ
- CJS + ESM デュアル出力を行うライブラリ
- バンドルサイズがユーザー体験に影響するフロントエンドライブラリ
- 複数の開発者が並行して異なるパッケージを変更する環境

### 導入時の注意点

- **段階的に導入する**: 5 ツール一括導入は初期ノイズが大きい。まず publint + attw（最も影響が大きい）から始め、sherif、knip、size-limit の順に追加するのが現実的
- **sherif の除外設定**: 意図的に複数バージョンをインストールしている依存（TypeScript エイリアス等）は `-i` で明示的に除外する。除外漏れは CI の誤検知を招く
- **knip の ignoreWorkspaces**: examples や integrations は検証対象から除外する。これらは意図的に異なるバージョンやパターンを使うため、ライブラリパッケージと同じ基準で検証すべきではない
- **size-limit の閾値設定**: 最初は現状値の 10-20% 増しを設定し、実際の変動を観察してから厳格化する。full import と minimal import の両方に閾値を設ける
- **Nx のタスク依存**: `test:build` は必ず `dependsOn: ["build"]` を設定する。ビルド成果物がない状態で publint/attw を走らせると false negative になる

### カスタマイズポイント

- **Turborepo 環境**: Nx の代わりに Turborepo を使う場合、`turbo.json` の `pipeline` で同等の依存グラフを定義できる。`test:build` -> `build` の依存は `"dependsOn": ["build"]` で表現する
- **size-limit のエントリ**: ライブラリの主要ユースケースに合わせて full/minimal 以外のエントリ（例: サーバー専用 API、特定フレームワーク向け）を追加する
- **knip のワークスペース別設定**: パッケージ固有のエントリポイントや ignore パターンは `workspaces` キーで個別に設定できる（Angular の production エントリ、codemods の testfixtures 除外など）
- **affected の基準ブランチ**: `nrwl/nx-set-shas` アクションで main ブランチとの差分を自動算出するが、他のブランチ戦略を使う場合は `main-branch-name` を変更する

## 参考

- [repos/TanStack/query/build-and-tooling.md](../repos/TanStack/query/build-and-tooling.md) -- ビルドパイプラインと多層品質ゲートの詳細分析
- [repos/TanStack/query/ci-cd.md](../repos/TanStack/query/ci-cd.md) -- CI ワークフローの三層構造と nx affected/run-many 戦略
- [repos/TanStack/query/dev-conventions.md](../repos/TanStack/query/dev-conventions.md) -- 7 層品質ゲートの全体設計と開発規約
- [repos/TanStack/query/dependency-management.md](../repos/TanStack/query/dependency-management.md) -- sherif による依存整合性検証と workspace プロトコル戦略
