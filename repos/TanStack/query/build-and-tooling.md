# Build and Tooling

> リポジトリ: TanStack/query
> 分析日: 2026-02-17

## 概要

TanStack Query は 24 以上のパッケージを持つマルチフレームワーク対応モノレポで、React / Vue / Solid / Svelte / Angular / Preact の各バインディングを単一リポジトリから公開している。ビルドパイプラインは tsup によるデュアルフォーマット（CJS + ESM）出力、modern/legacy のターゲット分離、Nx によるタスクオーケストレーション、Changesets によるリリース管理で構成される。特にフレームワークごとにビルド戦略を切り替えつつ、共通設定をシンボリックリンクで一元管理する手法が注目に値する。

## 背景にある原則

- **設定の DRY 原則 via シンボリックリンク**: 設定ファイルの重複を、コードのコピーではなくファイルシステムレベルのシンボリックリンクで解決すべき。なぜなら設定ファイルはパッケージ固有の解決（`import` の相対パス）が必要な場面があり、npm の `workspace:*` やパスエイリアスでは対応できないため。`root.tsup.config.js -> ../../scripts/getTsupConfig.js` と `root.eslint.config.js -> ../../eslint.config.js` のシンボリックリンクで実現している（`CONTRIBUTING.md:17`、各 `packages/*/` 配下のシンボリックリンク群）。

- **ビルドターゲットの階層化**: 消費者の環境差異に対応するため、同一ソースから複数のビルドターゲットを出力すべき。modern（Chrome91+ 等）と legacy（ES2020 + Node16）を分離することで、モダンブラウザには最適化されたコードを、レガシー環境には互換性のあるコードを提供する。`scripts/getTsupConfig.js` の `modernConfig` と `legacyConfig` で実装。

- **公開前の多層品質ゲート**: パッケージ公開の品質を担保するため、ビルド成果物に対して複数の独立した検証ツールを実行すべき。publint（パッケージ構造の検証）、attw（型定義の正確性検証）、size-limit（バンドルサイズ回帰検知）、sherif（モノレポ整合性）、knip（未使用コード検出）を組み合わせることで、単一ツールでは検出できない問題を包括的に捕捉する。

- **フレームワーク固有の最適化と共通パイプラインの両立**: マルチフレームワークモノレポでは、各フレームワーク向けビルドの特殊要件を許容しつつ、共通のタスクインターフェース（`build`, `test:build`, `compile` 等のスクリプト名）を統一すべき。フレームワーク固有の差異はビルドツール選択（tsup / svelte-package / Vite）で吸収し、Nx のタスクグラフは共通名で定義する。

## 実例と分析

### シンボリックリンクによる設定共有パターン

全パッケージの `root.tsup.config.js` と `root.eslint.config.js` が共通の参照先にシンボリックリンクされている。各パッケージの `tsup.config.ts` はこのシンボリックリンク経由で共通関数を import し、エントリポイントだけをカスタマイズする。

```
packages/query-core/root.tsup.config.js  -> ../../scripts/getTsupConfig.js
packages/query-core/root.eslint.config.js -> ../../eslint.config.js
packages/react-query/root.tsup.config.js  -> ../../scripts/getTsupConfig.js
...（全パッケージ共通）
```

例外として `eslint-plugin-query` は独自の `root.tsup.config.js` を持つ（シンボリックリンクではなく実ファイル）。ESLint プラグインは CJS のデフォルトエクスポート互換や `typescript` の externalize が必要なため。

### modern / legacy デュアルターゲット出力

```js
// scripts/getTsupConfig.js:10-21
export function modernConfig(opts) {
  return {
    entry: opts.entry,
    format: ["cjs", "esm"],
    target: ["chrome91", "firefox90", "edge91", "safari15", "ios15", "opera77"],
    outDir: "build/modern",
    dts: true,
    sourcemap: true,
    clean: true,
    esbuildPlugins: [esbuildPluginFilePathExtensions({ esmExtension: "js" })],
  };
}
```

```js
// scripts/getTsupConfig.js:28-39
export function legacyConfig(opts) {
  return {
    entry: opts.entry,
    format: ["cjs", "esm"],
    target: ["es2020", "node16"],
    outDir: "build/legacy",
    dts: true,
    sourcemap: true,
    clean: true,
    esbuildPlugins: [esbuildPluginFilePathExtensions({ esmExtension: "js" })],
  };
}
```

`package.json` の `exports` で modern と legacy を振り分ける:

```json
// packages/query-core/package.json:42-54
"exports": {
  ".": {
    "@tanstack/custom-condition": "./src/index.ts",
    "import": {
      "types": "./build/modern/index.d.ts",
      "default": "./build/modern/index.js"
    },
    "require": {
      "types": "./build/modern/index.d.cts",
      "default": "./build/modern/index.cjs"
    }
  }
}
```

`types` フィールド（フォールバック）は `build/legacy/index.d.ts` を参照し、古い `moduleResolution: node` にも対応している。

### カスタム条件による開発時ソースコード直接参照

```json
// tsconfig.json:10
"customConditions": ["@tanstack/custom-condition"]
```

全パッケージの `exports` に `"@tanstack/custom-condition": "./src/index.ts"` を設定し、Vitest や開発時のツールがビルド済みファイルではなくソースコードを直接参照する仕組みを実現している。これにより、テスト実行時にビルドステップを経由せず最新のソースを即座に反映できる。

### フレームワーク別ビルド戦略の分岐

| パッケージ群                          | ビルドツール             | 理由                                            |
| ------------------------------------- | ------------------------ | ----------------------------------------------- |
| query-core, react-query, vue-query 等 | tsup (共有設定)          | 標準的な CJS + ESM 出力                         |
| eslint-plugin-query                   | tsup (独自設定)          | CJS default export 互換、typescript externalize |
| solid-query, query-devtools           | tsup + tsup-preset-solid | SolidJS の JSX トランスフォーム、dev/prod 分離  |
| svelte-query                          | svelte-package           | Svelte コンポーネントのコンパイル               |
| angular-query-experimental            | Vite + vite-plugin-dts   | Angular の ESM-only 出力、prepack スクリプト    |

### Nx によるタスクオーケストレーション

```json
// nx.json:28-38
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
```

`compile`（tsc --build による型チェック・宣言ファイル生成）を依存パッケージから先に実行し、`test:eslint` と `test:lib` はその成果物に依存する。`build` は `^build`（依存先の build 完了後）に依存し、ビルド順序の正しさを保証する。

`namedInputs` で `production` 入力（テストファイル・eslint 設定を除外）を定義し、不要な再ビルドを回避している。

### 多層品質ゲート

```json
// packages/query-core/package.json:33
"test:build": "publint --strict && attw --pack"
```

- **publint**: `package.json` の `exports`/`main`/`module`/`types` がビルド成果物と一致しているか検証
- **attw** (@arethetypeswrong/cli): CJS/ESM 双方の型定義解決が正しいか検証
- **size-limit**: バンドルサイズの回帰を PR ごとに検知（`.size-limit.json` で閾値管理）
- **sherif**: モノレポ内の依存関係整合性を検証（`-i typescript` でバージョン違いを許容）
- **knip**: 未使用のエクスポート・依存関係を検出

### TypeScript マルチバージョンテスト

```json
// packages/query-core/package.json:22-30
"test:types:ts50": "node ../../node_modules/typescript50/lib/tsc.js --build tsconfig.legacy.json",
"test:types:ts51": "node ../../node_modules/typescript51/lib/tsc.js --build tsconfig.legacy.json",
...
"test:types:ts57": "node ../../node_modules/typescript57/lib/tsc.js --build tsconfig.legacy.json",
"test:types:tscurrent": "tsc --build",
```

ルートの `package.json` で TypeScript の各メジャーバージョンを別名インストール:

```json
// package.json:76-83
"typescript50": "npm:typescript@5.0",
"typescript51": "npm:typescript@5.1",
...
"typescript57": "npm:typescript@5.7",
```

`npm:` プロトコルで同一パッケージの複数バージョンを共存させ、`tsconfig.legacy.json`（より保守的な設定）でビルドすることで後方互換性を検証する。

### リリースパイプライン

```yaml
# .github/workflows/release.yml:51-58
- name: Run Changesets (version or publish)
  uses: changesets/action@v1.5.3
  with:
    version: pnpm run changeset:version
    publish: pnpm run changeset:publish
    commit: 'ci: Version Packages'
    title: 'ci: Version Packages'
```

Changesets により「main への push -> テスト -> バージョン PR 自動作成 -> マージで npm publish」の完全自動リリースフローを実現。`pkg-pr-new` により PR 段階でパッケージのプレビュー公開も実行される。

## パターンカタログ

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: 複数パッケージで共通のビルド手順を共有しつつ、エントリポイントだけを変更可能にする
  - 適用条件: 同一のビルド設定を10以上のパッケージで共有する場合
  - コード例: `scripts/getTsupConfig.js` の `modernConfig(opts)` / `legacyConfig(opts)` がテンプレート、各 `tsup.config.ts` が具象実装
  - 注意点: 例外パッケージ（eslint-plugin-query）には独自設定を許容する柔軟性が必要

## Good Patterns

- **シンボリックリンク + 薄いラッパーによる設定共有**: 共通設定をシンボリックリンクで配布し、各パッケージの設定ファイルは薄いラッパーとして機能する。npm workspace のホイスティングに依存せず、各パッケージが独立して設定を解決できる。

```ts
// packages/query-core/tsup.config.ts:1-7
import { defineConfig } from "tsup";
import { legacyConfig, modernConfig } from "./root.tsup.config.js";

export default defineConfig([
  modernConfig({ entry: ["src/*.ts"] }),
  legacyConfig({ entry: ["src/*.ts"] }),
]);
```

- **ビルド成果物に対する自動検証パイプライン**: `test:build` スクリプトで publint と attw を直列実行し、`package.json` の宣言とビルド成果物の不整合を自動検知する。CI の `dependsOn: ["build"]` でビルド後に必ず実行される。

```json
// nx.json:73-77
"test:build": {
  "cache": true,
  "dependsOn": ["build"],
  "inputs": ["production"]
}
```

- **src 同梱公開 + カスタム条件でのソースコード参照**: `"files": ["build", "src", "!src/__tests__"]` でソースコードも公開し、開発時はカスタム条件で直接参照する。デバッグ時にソースマップなしでもブレークポイントが効き、パッチ適用も容易になる。

## Anti-Patterns / 注意点

- **シンボリックリンクの透過性への過信**: シンボリックリンクは Windows 環境（WSL 外）や一部の CI 環境で問題を起こす可能性がある。CONTRIBUTING.md でも明示的に「symlink をサポートする環境での開発を推奨」と記載している。

```
# Bad: シンボリックリンクの代わりに設定ファイルをコピーする
cp ../../scripts/getTsupConfig.js ./root.tsup.config.js
# -> 設定変更時に全パッケージへの反映漏れが発生する

# Better: シンボリックリンクを使い、サポート外環境の制約を明示する
ln -s ../../scripts/getTsupConfig.js ./root.tsup.config.js
# CONTRIBUTING.md に環境要件を明記する
```

- **ビルド出力ディレクトリの不統一**: 多くのパッケージは `build/` を出力先とするが、Svelte は `dist/`、Angular は `dist/` を使う。これは各フレームワークのツールチェーンの慣例に従った結果だが、`nx.json` の `outputs` 定義で `["{projectRoot}/build", "{projectRoot}/dist"]` と両方を指定する必要が生じている。

```json
// Bad: 出力ディレクトリをフレームワークごとに異なる名前にする（キャッシュ設定が複雑化）
"outputs": ["{projectRoot}/build", "{projectRoot}/dist"]

// Better: 可能な限り出力ディレクトリ名を統一する（ただしツールチェーンの制約がある場合は許容）
```

## 導出ルール

- `[MUST]` モノレポで公開するパッケージの `test:build` には publint と @arethetypeswrong/cli を含め、`exports` と実際のビルド成果物の整合性を CI で検証する
  - 根拠: TanStack Query の全 18 パッケージで `publint --strict && attw --pack` を実行し、CJS/ESM デュアル出力の型解決不整合を公開前に検出している（`packages/*/package.json` の `test:build` スクリプト）

- `[MUST]` ライブラリのバンドルサイズを `size-limit` 等のツールで CI に組み込み、PR ごとにサイズ回帰を検知する
  - 根拠: `.size-limit.json` で full import と minimal import の両方に閾値を設定し、PR ワークフローの `size-limit-action` でサイズ変化をコメントとして可視化している

- `[SHOULD]` 10 以上のパッケージでビルド設定を共有する場合、シンボリックリンク + 薄いラッパーパターンで設定の DRY を実現する
  - 根拠: 18 の tsup 設定が `root.tsup.config.js -> ../../scripts/getTsupConfig.js` を参照し、ビルドターゲット変更が1ファイルの修正で全パッケージに反映される

- `[SHOULD]` CJS + ESM デュアル出力のライブラリでは modern ターゲット（最新ブラウザ）と legacy ターゲット（ES2020 + Node16）を分離し、`package.json` の `exports` で振り分ける
  - 根拠: `modernConfig`（Chrome91+）と `legacyConfig`（ES2020）を分離し、`exports` の `import`/`require` で modern を、`main`/`module` フォールバックで legacy を参照する設計

- `[SHOULD]` ライブラリの TypeScript 型定義の後方互換性を担保するため、サポート範囲内の複数 TypeScript バージョンで CI ビルドを実行する
  - 根拠: `npm:typescript@5.0` から `5.7` までの 8 バージョンを別名インストールし、`tsconfig.legacy.json` でビルドテストを実行している

- `[SHOULD]` Nx の `namedInputs` と `dependsOn` を活用して、タスク間の依存関係と入力ファイルを明示的に定義し、不要な再ビルドを抑制する
  - 根拠: `nx.json` で `production` 入力（テスト・設定ファイル除外）を定義し、`test:eslint` -> `^compile`、`build` -> `^build` の依存チェーンでビルド順序を保証している

- `[AVOID]` モノレポの全パッケージに対して無条件でフルビルドを実行すること。`nx affected` で変更影響範囲のみをビルド対象にする
  - 根拠: PR ワークフローは `pnpm run test:pr`（内部で `nx affected`）を使い、CI ワークフローのみ `nx run-many`（全パッケージ）を使い分けている

## 適用チェックリスト

- [ ] `package.json` の `exports` フィールドが `import`/`require` 両方の `types` と `default` を正しく定義しているか
- [ ] `test:build` スクリプトに `publint --strict && attw --pack` を設定し、CI で実行しているか
- [ ] `size-limit` 等のバンドルサイズ計測を CI に組み込み、PR ごとに回帰を検知しているか
- [ ] モノレポのビルド設定に不要な重複がないか（10 パッケージ以上ならシンボリックリンクパターンを検討）
- [ ] TypeScript のサポートバージョン範囲を明示し、複数バージョンでの型チェックを CI に含めているか
- [ ] `sideEffects: false` を設定してバンドラーのツリーシェイキングを有効にしているか
- [ ] `nx affected` / `turbo --filter` 等で変更影響範囲のみをビルド対象にしているか
- [ ] ソースコードを `files` に含めて公開し、デバッグ・パッチ適用を容易にしているか
