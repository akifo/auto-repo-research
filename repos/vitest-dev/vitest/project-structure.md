# project-structure

> リポジトリ: vitest-dev/vitest
> 分析日: 2026-03-05

## 概要

17 パッケージを擁する pnpm ワークスペースモノレポの構成を分析する。特に注目すべきは、ソースパッケージ (`packages/*`) と統合テスト (`test/*`) を完全に分離し、それぞれを独立したワークスペースとして管理する設計である。さらに pnpm catalog による依存バージョン一元管理、tsconfig paths による開発時のソース直接参照、`workspace:*` プロトコルによるパッケージ間結合など、大規模モノレポを維持するための実践的なパターンが体系的に適用されている。

## 背景にある原則

- **依存方向の一方向性**: パッケージ間の依存関係は厳密に下位（leaf）から上位（aggregator）への一方向に制限されている。`@vitest/pretty-format` と `@vitest/spy` は外部依存ゼロの leaf パッケージであり、`vitest` 本体は全 7 コアパッケージに依存するファサードとして機能する。循環依存が発生しないよう依存グラフが DAG（有向非巡回グラフ）として設計されている（`packages/vitest/rollup.config.js:270` で `CIRCULAR_DEPENDENCY` 警告を明示的に抑制している点から、意識的に管理していることがわかる）。

- **テストはプロダクトコードから独立した消費者である**: `test/*` ディレクトリは `packages/*` のソースコードを直接参照せず、`workspace:*` で公開パッケージとして依存する。これにより統合テストがエンドユーザーと同じ依存解決パスを通り、パッケージの公開インターフェースの正しさを検証できる（`test/core/package.json` で `"vitest": "workspace:*"` として依存している）。

- **関心の分離によるビルド・テスト並列化**: 各パッケージと各テストワークスペースが独立した `package.json` を持つことで、pnpm の `--filter` オプションでビルドとテストを選択的に並列実行できる。ルートの `build` スクリプトは `pnpm -r --filter @vitest/ui --filter='./packages/**' run build` と明示的なフィルタを使い、テストワークスペースをビルド対象から除外している（`package.json:14`）。

- **共有依存バージョンの単一ソース化**: pnpm catalog で外部依存のバージョンを `pnpm-workspace.yaml` に一元定義し、各パッケージは `"catalog:"` で参照する。バージョンの散在を防ぎ、アップデート時の変更箇所を1ファイルに集約する。

## 実例と分析

### パッケージ依存グラフの階層構造

依存関係は明確な3階層を形成する:

**Layer 0（Leaf パッケージ / 外部依存なし）:**
- `@vitest/pretty-format` — フォーマッタ（依存: tinyrainbow のみ）
- `@vitest/spy` — スパイ実装（依存: tinyspy のみ）
- `@vitest/ws-client` — WebSocket クライアント

**Layer 1（内部依存あり / 単機能パッケージ）:**
- `@vitest/utils` → `@vitest/pretty-format`
- `@vitest/mocker` → `@vitest/spy`
- `@vitest/runner` → `@vitest/utils`
- `@vitest/snapshot` → `@vitest/pretty-format`, `@vitest/utils`
- `@vitest/expect` → `@vitest/spy`, `@vitest/utils`

**Layer 2（統合パッケージ / 上位依存）:**
- `vitest` → expect, mocker, pretty-format, runner, snapshot, spy, utils（7 コアパッケージ全て）
- `@vitest/browser` → mocker, utils + vitest (peer)
- `@vitest/coverage-v8` → utils + vitest (peer)
- `@vitest/ui` → utils + vitest (peer)

### テストワークスペースのカテゴリ分類

`test/README.md` に明文化されているように、テストは機能単位ではなくテスト手法・関心領域で分類されている:

| ワークスペース | 名前 | テストファイル数 | 特性 |
|---|---|---|---|
| test/core | @vitest/test-core | 189 | 単一 vitest インスタンスで複数プール実行 |
| test/cli | @vitest/test-cli | 291 | 新しい vitest プロセスを毎テスト起動 |
| test/config | @vitest/test-config | 83 | 設定オプションのテスト |
| test/browser | @vitest/test-browser | 117 | ブラウザモードテスト |
| test/coverage-test | @vitest/test-coverage | 79 | カバレッジプロバイダのテスト |
| test/ui | @vitest/test-ui | 11 | Playwright による E2E テスト |
| test/workspaces | @vitest/test-workspaces | 12 | ワークスペース機能テスト |
| test/test-utils | @vitest/internal-testing-helpers | 0 | 共有テストユーティリティ（テスト自体は持たない） |

特筆すべきは `test/core` が「唯一、毎テストで新しい vitest インスタンスを起動しない」カテゴリであること。他のテストカテゴリは全て CLI 経由または API 経由で vitest インスタンスを立ち上げる統合テストである。

### テストユーティリティの共有メカニズム

`test/test-utils/` は独立したワークスペースパッケージ `@vitest/internal-testing-helpers` として定義されている。他のテストワークスペースからは、Node.js の `imports` フィールド（import maps）で参照する:

```jsonc
// test/cli/package.json:5-7
{
  "imports": {
    "#test-utils": "../test-utils/index.ts"
  }
}
```

ただし、この `#test-utils` パターンを使っているのは `test/cli` のみである。`tsconfig.base.json` にも `"#test-utils": ["./test/test-utils/index.ts"]` としてパスエイリアスが定義されており（`tsconfig.base.json:32`）、他のテストワークスペースでは TypeScript の paths 解決に依存している。

### tsconfig paths によるモノレポ内ソース直接参照

開発時の型解決には `tsconfig.base.json` の `paths` を活用し、ビルド済み `dist/` ではなくソースファイルを直接参照する:

```jsonc
// tsconfig.base.json:8-12
{
  "paths": {
    "@vitest/ws-client": ["./packages/ws-client/src/index.ts"],
    "@vitest/utils": ["./packages/utils/src/index.ts"],
    "@vitest/utils/*": ["./packages/utils/src/*"]
  }
}
```

ワイルドカードパスを使ってサブパスエクスポート（`@vitest/utils/diff`, `@vitest/runner/utils` など）にも対応している。これにより、パッケージを再ビルドせずにソース変更が即座に型チェックに反映される。

### ビルド設定の共通化

全 17 パッケージが Rollup を使用し、共通のビルドユーティリティ `scripts/build-utils.js` を共有する。このユーティリティは `unplugin-isolated-decl` と `rollup-plugin-dts` の2段階 DTS 生成パイプラインを提供する:

```javascript
// scripts/build-utils.js:7-10
export function createDtsUtils({
  isolatedDeclDir = '.types',
  cleanupDir = '.types',
} = {}) {
```

各パッケージの `rollup.config.js` は `external` 配列を `package.json` の `dependencies` + `peerDependencies` から自動生成する共通パターンを採用している:

```javascript
// packages/utils/rollup.config.js:28-32
const external = [
  ...builtinModules,
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.peerDependencies || {}),
]
```

### pnpm overrides によるモノレポ内バージョン統一

`pnpm-workspace.yaml` の `overrides` セクションで、モノレポ内パッケージの解決を `workspace:*` に強制している:

```yaml
# pnpm-workspace.yaml:30-39
overrides:
  '@vitest/browser': workspace:*
  '@vitest/ui': workspace:*
  vitest: workspace:*
  vite: $vite
```

`$vite` 構文は catalog からの参照であり、vite のバージョンもモノレポ全体で統一される。

## コード例

```javascript
// packages/vitest/rollup.config.js:18-46
// vitest 本体のエントリポイント定義 - public/ ディレクトリで API 表面を明示的に制御
const entries = {
  'path': 'src/paths.ts',
  'index': 'src/public/index.ts',
  'cli': 'src/node/cli.ts',
  'config': 'src/public/config.ts',
  'node': 'src/public/node.ts',
  // ... 省略
  // for performance reasons we bundle them separately so we don't import everything at once
  'workers/forks': 'src/runtime/workers/forks.ts',
  'workers/threads': 'src/runtime/workers/threads.ts',
}
```

```javascript
// test/core/vite.config.ts:177-193
// テストを複数プール（threads, forks, vmThreads）で並列実行する projects 定義
projects: [
  project('threads', 'red'),
  project('forks', 'green'),
  project('vmThreads', 'blue'),
],

function project(pool: Pool, color: LabelColor) {
  return {
    extends: './vite.config.ts',
    test: {
      name: { label: pool, color },
      pool,
    },
  }
}
```

```typescript
// test/test-utils/index.ts:58-62
// テストユーティリティ: vitest インスタンスを API 経由で起動し stdout/stderr をキャプチャ
export async function runVitest(
  config: RunVitestConfig,
  cliFilters: string[] = [],
  runnerOptions: VitestRunnerCLIOptions = {},
) {
```

## パターンカタログ

- **Facade パターン** (分類: 構造)
  - 解決する問題: 17 パッケージの複雑な依存関係をエンドユーザーから隠蔽する
  - 適用条件: 内部パッケージの API を統合して単一エントリポイントから公開する必要がある場合
  - コード例: `packages/vitest/src/public/index.ts:31-114` — `@vitest/runner`, `@vitest/expect`, `@vitest/spy` 等から re-export
  - 注意点: re-export が多すぎると tree-shaking が効きにくくなるため、サブパスエクスポート（`vitest/node`, `vitest/config` 等）で分割している

- **Layered Architecture** (分類: 構造)
  - 解決する問題: パッケージ間の循環依存を防ぎ、独立したリリース・テストを可能にする
  - 適用条件: 10 以上のパッケージを持つモノレポで依存関係の管理が複雑になる場合
  - コード例: `@vitest/pretty-format`（依存ゼロ）→ `@vitest/utils` → `@vitest/expect` → `vitest`
  - 注意点: 層の数が増えるとビルド順序の管理が複雑になる。pnpm はトポロジカルソートで自動解決する

## Good Patterns

- **`src/public/` ディレクトリによる API 表面の明示化**: `packages/vitest/src/public/` に 12 個のエントリファイルを配置し、内部実装と公開 API を物理的に分離している。`rollup.config.js` の `entries` と `dtsEntries` で公開するものだけを明示的に列挙し、内部モジュールの漏洩を防ぐ。

```typescript
// packages/vitest/src/public/node.ts:1-4
import * as vite from 'vite'
import { Vitest } from '../node/core'
export const version: string = Vitest.version
```

- **テストワークスペースの独立 package.json による依存分離**: 各テストワークスペースが独自の `package.json` を持ち、テスト固有の依存（`playwright`, `msw` 等）がプロダクトパッケージに影響しない。`test/core/package.json` は `file:` や `link:` プロトコルでテスト専用のモックパッケージを参照する。

```jsonc
// test/core/package.json:22-24
{
  "@vitest/test-dep-cjs": "file:./deps/dep-cjs",
  "@vitest/test-dep1": "file:./deps/dep1"
}
```

- **pnpm catalog による依存バージョン一元管理**: 48 個の共有依存バージョンが `pnpm-workspace.yaml` の `catalog` セクションに集約され、各 `package.json` では `"catalog:"` で参照する。バージョン不整合を構造的に排除する。

```yaml
# pnpm-workspace.yaml:48-50
catalog:
  '@iconify-json/carbon': ^1.2.19
  tinyrainbow: ^3.0.3
```

- **patchedDependencies による上流バグ回避の透明化**: 5 つの外部パッケージにパッチを適用し、パッチファイルを `patches/` ディレクトリで管理している。パッチの存在が `pnpm-workspace.yaml` に明示されており、なぜパッチが必要かをトレースできる。

## Anti-Patterns / 注意点

- **テストユーティリティ共有の不統一**: `#test-utils` の import maps パターンを使っているのは `test/cli` のみで、他のテストワークスペースは `tsconfig.base.json` の paths に依存している。共有メカニズムが統一されていないと、新しいテストワークスペース追加時にどちらを使うべきか迷う。

```jsonc
// Bad: test/cli のみ imports フィールドを使用
// test/cli/package.json
{ "imports": { "#test-utils": "../test-utils/index.ts" } }

// Better: 全テストワークスペースで同じメカニズムを使う
// tsconfig paths だけに統一するか、全ワークスペースで imports フィールドを使う
```

- **テスト名プレフィックスの不一致**: テストワークスペースのパッケージ名に `@vitest/test-` プレフィックスを使うもの（`@vitest/test-core`, `@vitest/test-cli`）と使わないもの（`@test/node-runner`, `@vitest/internal-testing-helpers`）が混在している。CI の `--filter '@vitest/test-*'` でフィルタする設計と一致しないパッケージが存在する。

```jsonc
// Bad: フィルタパターンに一致しない名前
{ "name": "@test/node-runner" }
{ "name": "@vitest/internal-testing-helpers" }

// Better: 統一的な命名規則
{ "name": "@vitest/test-node-runner" }
```

## 導出ルール

- `[MUST]` モノレポのパッケージ間依存は DAG（有向非巡回グラフ）を維持し、循環依存が発生しないよう leaf パッケージ（外部依存ゼロ）を依存グラフの底に配置する
  - 根拠: vitest は `@vitest/pretty-format` と `@vitest/spy` を依存ゼロの leaf パッケージとして設計し、上位パッケージが一方向にのみ依存する3層構造を形成している（17パッケージで循環依存を回避）

- `[MUST]` 統合テストはプロダクトパッケージのソースコードを直接 import せず、公開パッケージとして（`workspace:*` や公開 API 経由で）依存する
  - 根拠: `test/*` は全て `"vitest": "workspace:*"` で依存し、`packages/vitest/src/` を直接参照しない。エンドユーザーと同じ依存解決パスでテストすることで公開 API の正しさを保証する

- `[SHOULD]` モノレポ内で共有する外部依存のバージョンは単一ソース（pnpm catalog, Renovate config, 共有 package.json 等）で管理し、各パッケージから参照する
  - 根拠: pnpm catalog に 48 依存のバージョンを集約し `"catalog:"` で参照することで、`pnpm-workspace.yaml` の1ファイル変更だけでモノレポ全体のバージョンを更新可能にしている

- `[SHOULD]` 公開 API を `src/public/` のような専用ディレクトリに集約し、ビルド設定のエントリポイントと一致させることで、内部実装の漏洩を物理的に防ぐ
  - 根拠: `packages/vitest/src/public/` に 12 エントリファイルを配置し、`rollup.config.js` の `entries`/`dtsEntries` と対応させている。内部モジュール（`src/node/`, `src/runtime/`）は直接 export されない

- `[SHOULD]` テストワークスペースは機能単位ではなくテスト手法・実行特性（単体テスト / CLI 統合テスト / E2E テスト等）で分類し、各カテゴリの実行コストと分離要件に応じた設定を適用する
  - 根拠: `test/core` は単一 vitest インスタンスで高速実行、`test/cli` は毎テストで新プロセス起動、`test/ui` は Playwright による E2E と、カテゴリごとに実行戦略が異なる

- `[AVOID]` モノレポ内のワークスペースパッケージの命名規則を不統一にすること。CI フィルタやスクリプトがパターンマッチに依存する場合、例外的な命名はフィルタ漏れを引き起こす
  - 根拠: `test:ci` スクリプトが `--filter '@vitest/test-*'` でフィルタするが、`@test/node-runner` や `@vitest/internal-testing-helpers` はこのパターンに一致しない

## 適用チェックリスト

- [ ] パッケージ間の依存グラフを可視化し、循環依存がないことを確認する
- [ ] leaf パッケージ（他の内部パッケージに依存しないもの）を特定し、依存グラフの底に配置する
- [ ] 統合テストが `workspace:*` 等で公開パッケージとして依存しているか確認する（ソース直接参照になっていないか）
- [ ] 共有外部依存のバージョンが単一ソースで管理されているか確認する（pnpm catalog / Renovate config 等）
- [ ] 公開 API のエントリポイントが明示的に定義され、内部モジュールが漏洩していないか確認する
- [ ] テストワークスペースの分類基準が明確か、README 等に文書化されているか確認する
- [ ] ワークスペースパッケージの命名規則が統一され、CI フィルタパターンと整合しているか確認する
- [ ] ビルドスクリプトがテストワークスペースを適切に除外しているか確認する
