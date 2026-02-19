# Tool: pnpm Catalogs

> 出典: [repos/ryoppippi/ccusage](../repos/ryoppippi/ccusage/), [repos/mastra-ai/mastra](../repos/mastra-ai/mastra/)
> カテゴリ: tool

## 概要

pnpm Catalogs は、モノレポ内の全パッケージの依存バージョンを `pnpm-workspace.yaml` の一箇所に集約し、各 `package.json` からは `"catalog:"` プロトコルで参照する仕組みである。`catalogMode: strict` を併用することで、catalog を経由しない直接バージョン指定がエラーとなり、バージョン不整合を構造的に排除できる。10 パッケージ規模（ccusage）から 100+ パッケージ規模（mastra）まで実証されており、モノレポの依存管理における「Single Source of Truth」を実現する実用的なツールである。

## 背景・文脈

モノレポでは複数パッケージが同じ依存を持つが、パッケージごとにバージョンを個別管理すると以下の問題が発生する:

- **バージョン不整合**: パッケージ A は `vitest@4.0.12`、パッケージ B は `vitest@3.2.0` のように異なるバージョンが混在し、テスト結果の再現性が損なわれる
- **更新漏れ**: 依存をアップデートする際に N 箇所の `package.json` を手動で修正する必要があり、一部の更新が漏れる
- **役割の不明瞭さ**: `package.json` を見ただけでは、その依存がビルドツールなのかランタイムライブラリなのかが分からない

pnpm Catalogs はこれらの問題を、バージョン定義の一元化とカテゴリ分類で解決する。ccusage では 10 パッケージ 153 箇所の `catalog:` 参照を管理し、mastra では 112 ファイル 375 箇所の `catalog:` 参照を運用している。

## 実装パターン

### 1. pnpm-workspace.yaml での catalog 定義

catalog にはデフォルトカタログ（`catalog:`）と名前付きカタログ（`catalogs:`）の 2 種類がある。

**ccusage: 名前付きカタログによる用途別分類**

ccusage は 8 カテゴリに分類した名前付きカタログを使用する。依存を追加する際に「この依存はどの用途か」を必ず考えさせる設計になっている。

```yaml
# ryoppippi/ccusage - pnpm-workspace.yaml:1-72
catalogMode: strict

packages:
  - apps/*
  - packages/*

catalogs:
  build:
    tsdown: ^0.16.6
    unplugin-macros: ^0.15.1
  runtime:
    valibot: ^1.1.0
    gunshi: ^0.32.1
    picocolors: ^1.1.1
  testing:
    vitest: ^4.0.15
    fs-fixture: ^2.6.0
  types:
    '@types/node': ^22.15.21
    '@types/bun': ^1.2.14
  docs:
    vitepress: ^1.6.3
    typedoc: ^0.28.5
  lint:
    '@ryoppippi/eslint-config': ^0.5.5
    publint: ^0.3.12
  release:
    bumpp: ^10.1.0
    changelogithub: ^13.15.0
  llm-docs:
    '@gunshi/docs': ^0.32.1
    '@praha/byethrow-docs': ^0.1.9
```

**mastra: デフォルトカタログによるシンプルな一元管理**

mastra はデフォルトカタログ（`catalog:`）を使い、ランタイム互換性に影響するパッケージに限定している。ビルドツール（`tsup`, `eslint` 等）は意図的に catalog に含めず、各パッケージで個別管理する。

```yaml
# mastra-ai/mastra - pnpm-workspace.yaml:24-29
catalog:
  '@microsoft/api-extractor': '^7.56.0'
  '@vitest/coverage-v8': 4.0.12
  '@vitest/ui': 4.0.12
  vitest: 4.0.16
  typescript: ^5.9.3
  zod: ^4.3.6
```

### 2. package.json での catalog: プロトコル使用

名前付きカタログは `"catalog:<カテゴリ名>"` で参照し、デフォルトカタログは `"catalog:"` で参照する。

**ccusage: カテゴリ付き参照**

```jsonc
// ryoppippi/ccusage - apps/ccusage/package.json:69-104
"devDependencies": {
    "@antfu/utils": "catalog:runtime",
    "@ccusage/internal": "workspace:*",
    "gunshi": "catalog:runtime",
    "valibot": "catalog:runtime",
    "picocolors": "catalog:runtime",
    "tsdown": "catalog:build",
    "vitest": "catalog:testing",
    "@types/node": "catalog:types"
}
```

**mastra: デフォルトカタログ参照**

```jsonc
// mastra-ai/mastra - stores/pg/package.json:49-54
"devDependencies": {
    "@vitest/coverage-v8": "catalog:",
    "@vitest/ui": "catalog:",
    "eslint": "^9.37.0",
    "tsup": "^8.5.1",
    "typescript": "catalog:",
    "vitest": "catalog:"
}
```

### 3. catalogMode: strict の有効化

`catalogMode: strict` を設定すると、catalog に定義されていないバージョン指定がエラーになる。これにより「うっかり個別のパッケージで異なるバージョンを指定してしまう」事故を構造的に防ぐ。

```yaml
# pnpm-workspace.yaml 冒頭
catalogMode: strict
```

strict モードでは以下がエラーになる:

- `"vitest": "^4.0.0"` のような直接バージョン指定
- catalog に登録されていないパッケージへの `"catalog:"` 参照

## Good Example

**用途別カテゴリで依存の役割を明示**

`package.json` を見ただけで「この依存はビルドツールか、ランタイムライブラリか」が即座に判別できる。

```jsonc
// Good: カテゴリ付き catalog プロトコルで依存の役割が明確
{
  "devDependencies": {
    "valibot": "catalog:runtime",
    "tsdown": "catalog:build",
    "vitest": "catalog:testing",
    "@types/node": "catalog:types",
  },
}
```

**ランタイム互換性に影響するパッケージのみ catalog に集約**

全パッケージで同一バージョンでなければテスト結果の一貫性が保証できないもの（テストランナー、型チェッカー、スキーマライブラリ等）に限定する。

```yaml
# Good: catalog の対象を絞り、意図的なバージョン差異も許容
catalog:
  vitest: 4.0.16
  typescript: ^5.9.3
  zod: ^4.3.6
```

```jsonc
// ビルドツールは各パッケージで個別管理（catalog に含めない）
"eslint": "^9.37.0",
"tsup": "^8.5.1"
```

## Bad Example

**catalog なしで各パッケージにバージョンを散在させる**

```jsonc
// Bad: 10 パッケージにバージョンが散在し、更新漏れが発生する
// packages/core/package.json
{
  "devDependencies": {
    "vitest": "^4.0.12",
    "typescript": "^5.8.0"
  }
}
// packages/server/package.json
{
  "devDependencies": {
    "vitest": "^3.2.0",      // 更新漏れでバージョン不一致
    "typescript": "^5.9.3"
  }
}
```

```yaml
# Good: バージョン定義は pnpm-workspace.yaml の 1 箇所のみ
catalogMode: strict

catalog:
  vitest: 4.0.16
  typescript: ^5.9.3
```

```jsonc
// 各パッケージは catalog: で参照するだけ
// packages/core/package.json
{ "devDependencies": { "vitest": "catalog:", "typescript": "catalog:" } }
// packages/server/package.json
{ "devDependencies": { "vitest": "catalog:", "typescript": "catalog:" } }
```

**catalog にビルドツールまで過剰に含める**

```jsonc
// Bad: すべてを catalog に入れると、特定パッケージだけ新バージョンを試す実験が困難
"tsup": "catalog:",
"rollup": "catalog:",
"eslint": "catalog:"
```

```jsonc
// Good: ランタイム互換性に影響するもののみ catalog
"vitest": "catalog:",
"typescript": "catalog:",
"tsup": "^8.5.1",       // パッケージ固有のツールは個別管理
"eslint": "^9.37.0"
```

**catalogMode を設定しない（または strict でない）**

```yaml
# Bad: catalogMode 未設定 — 直接バージョン指定と catalog: 参照が混在可能
packages:
  - packages/*

catalog:
  vitest: 4.0.16
```

```yaml
# Good: strict で catalog 外のバージョン指定をエラーにする
catalogMode: strict

packages:
  - packages/*

catalog:
  vitest: 4.0.16
```

## 適用ガイド

### どのような状況で使うべきか

- **3 パッケージ以上のモノレポ**: パッケージ数が増えるほどバージョン不整合のリスクが高まるため、早期に導入する価値がある
- **共通依存が多いプロジェクト**: テストランナー、型チェッカー、スキーマライブラリなど、全パッケージで統一すべき依存がある場合
- **チーム開発**: 複数人が異なるパッケージを編集する場合、catalog が「正しいバージョン」の唯一の参照先となる

### 導入手順

1. `pnpm-workspace.yaml` に `catalogMode: strict` と `catalog:` セクションを追加
2. 各 `package.json` のバージョン指定を `"catalog:"` に置換
3. `pnpm install` を実行し、catalog 外の直接指定がないことを確認

### カテゴリ設計の指針

**ccusage 方式（名前付きカタログ）** が適するケース:

- パッケージ数が 10-30 程度で、全依存を catalog に含めたい場合
- 依存の役割を `package.json` 上で明示したい場合
- `catalogMode: strict` で全依存を catalog 経由に強制する場合

**mastra 方式（デフォルトカタログ）** が適するケース:

- 100+ パッケージの大規模モノレポで、catalog の肥大化を避けたい場合
- ランタイム互換性に影響するパッケージのみ統一し、ビルドツールは個別管理したい場合

### 注意点

- `catalogMode: strict` は pnpm v9.5.0 以降で利用可能（pnpm v10 推奨）
- `workspace:*` プロトコル（内部パッケージ間の依存）は catalog の対象外であり、直接指定が必要
- catalog のバージョン更新は 1 ファイルの変更で済むため、Renovate / Dependabot との相性が良い。mastra では Renovate PR に対して changeset を自動生成するワークフローも併用している
- `enablePrePostScripts: true` は pnpm v10 で `pre/post` ライフサイクルスクリプトを使う場合に必要（ccusage の `prepack`/`preinstall` が依存）

## 参考

- [repos/ryoppippi/ccusage/dependency-management.md](../repos/ryoppippi/ccusage/dependency-management.md) -- pnpm Catalogs + サプライチェーンセキュリティの多層構成
- [repos/ryoppippi/ccusage/build-and-tooling.md](../repos/ryoppippi/ccusage/build-and-tooling.md) -- カテゴリ別 catalog と tsdown ビルドパイプライン
- [repos/mastra-ai/mastra/dependency-management.md](../repos/mastra-ai/mastra/dependency-management.md) -- 100+ パッケージ規模での catalog 運用と Renovate 連携
- [repos/mastra-ai/mastra/build-and-tooling.md](../repos/mastra-ai/mastra/build-and-tooling.md) -- Turborepo + pnpm catalog による大規模モノレポのビルド管理
