# project-structure

> リポジトリ: TanStack/query
> 分析日: 2026-02-17

## 概要

TanStack Query は 24 パッケージを擁する pnpm workspace モノレポで、「フレームワーク非依存のコアと、6 つのフレームワークアダプタ」という階層構造を持つ。注目すべきは、コアロジックを完全に分離しつつ、devtools・persist・ESLint プラグインといった関心事ごとにもパッケージを分割している点にある。この設計により、React/Vue/Solid/Svelte/Angular/Preact という根本的に異なるリアクティビティモデルを持つフレームワーク群に対して、同一のキャッシュ戦略・状態管理ロジックを提供している。symlink ベースの設定共有、Nx によるタスクオーケストレーション、dual build（modern/legacy）出力など、大規模モノレポの運用プラクティスも豊富である。

## 背景にある原則

- **コアとアダプタの分離（Dependency Inversion）**: フレームワーク固有のリアクティビティ層に依存せず、Observer パターンで抽象化されたコアを提供すべき。なぜなら、コアロジック（キャッシュ、リトライ、GC）はフレームワークを跨いで共通であり、分離しなければ N フレームワーク分のロジック重複が発生するため。`packages/query-core` が全フレームワークアダプタの唯一の依存先となっている構造がこれを証明する。

- **関心事の直交分割**: 機能の「軸」ごとにパッケージを分割すべき。devtools、persist、ESLint プラグインはそれぞれ独立した関心事であり、コアやアダプタに混入させるとバンドルサイズが増大し、optional な機能が必須依存になる。TanStack Query では `query-devtools`（フレームワーク非依存の devtools コア）→ `react-query-devtools`（React アダプタ）という二段階構造を devtools にも適用している。

- **設定の DRY 化と局所的オーバーライド**: モノレポの設定は symlink で共有し、パッケージ固有の差分のみローカルファイルで上書きすべき。共有設定の変更が全パッケージに即座に反映され、設定ドリフトを防止できるため。`root.tsup.config.js` → `../../scripts/getTsupConfig.js` への symlink がこのパターンを実現している。

- **実験的機能の段階的導入**: 安定性の異なる API を同一リポジトリで管理する場合、パッケージ名やエクスポート名で成熟度を明示すべき。ユーザーが不安定な機能を意図せず本番利用するリスクを軽減するため。`angular-query-experimental`、`query-broadcast-client-experimental`、`experimental_streamedQuery` の 3 つの命名パターンが使い分けられている。

## 実例と分析

### パッケージ依存グラフの階層設計

24 パッケージは明確な 4 層構造を持つ。

**Layer 0: コア**

- `query-core` — キャッシュ、Observer、リトライ、GC。フレームワーク依存ゼロ
- `query-persist-client-core` — 永続化のフレームワーク非依存コア
- `query-devtools` — devtools UI のフレームワーク非依存実装（Solid.js で実装）

**Layer 1: フレームワークアダプタ**

- `react-query`, `vue-query`, `solid-query`, `svelte-query`, `angular-query-experimental`, `preact-query`
- 全てが `query-core` に `dependencies` で依存し、`export * from '@tanstack/query-core'` で再エクスポート

**Layer 2: 機能アドオン**

- `react-query-devtools`, `vue-query-devtools` など — Layer 0 の devtools コアと Layer 1 のアダプタに依存
- `react-query-persist-client`, `solid-query-persist-client` など — persist コアとアダプタに依存
- `query-async-storage-persister`, `query-sync-storage-persister` — ストレージ実装

**Layer 3: ユーティリティ・ツール**

- `eslint-plugin-query` — 静的解析ルール
- `query-codemods` — マイグレーション用 codemod（private パッケージ）
- `query-test-utils` — 内部テストユーティリティ（private、未公開）

この階層により、依存の方向は常に「上から下」であり、循環依存が構造的に排除されている。

### symlink による設定共有パターン

各パッケージの `root.eslint.config.js` と `root.tsup.config.js` はルートへの symlink である。

```
# packages/react-query/root.eslint.config.js → ../../eslint.config.js
# packages/react-query/root.tsup.config.js → ../../scripts/getTsupConfig.js
```

パッケージローカルの `eslint.config.js` は symlink された共有設定を import し、差分のみ上書きする。

```js
// packages/query-core/eslint.config.js:1-5
import rootConfig from "./root.eslint.config.js";

export default [...rootConfig];
```

```ts
// packages/query-core/tsup.config.ts:1-7
import { defineConfig } from "tsup";
import { legacyConfig, modernConfig } from "./root.tsup.config.js";

export default defineConfig([
  modernConfig({ entry: ["src/*.ts"] }),
  legacyConfig({ entry: ["src/*.ts"] }),
]);
```

tsconfig.json も同様に、ルートの `tsconfig.json` を `extends` し、パッケージ固有の設定（`jsx`, `outDir` 等）のみオーバーライドする。

### Dual Build 出力（modern/legacy）

`scripts/getTsupConfig.js` で `modernConfig` と `legacyConfig` を分離し、2 つのビルドターゲットを出力する。

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

`package.json` の `exports` フィールドで `build/modern/` と `build/legacy/` を使い分け、バンドラーが最適なビルドを選択できるようにしている。

### カスタム条件によるソース直接参照

```json
// tsconfig.json:10
"customConditions": ["@tanstack/custom-condition"]
```

全パッケージの `exports` に `"@tanstack/custom-condition": "./src/index.ts"` が定義されている。この仕組みにより、モノレポ内の開発時はビルド済みファイルではなく TypeScript ソースを直接参照でき、ビルドなしで型チェックやテストが即座に実行できる。

### 実験的機能の 3 つの命名パターン

1. **パッケージ名に `-experimental` を付与**: `@tanstack/angular-query-experimental`, `@tanstack/query-broadcast-client-experimental` — パッケージ全体が実験的
2. **エクスポート名に `experimental_` プレフィクス**: `experimental_streamedQuery` (`packages/query-core/src/index.ts:42`) — 個別 API が実験的
3. **オプション名に `experimental_` プレフィクス**: `experimental_prefetchInRender` (`packages/query-core/src/types.ts:440`) — 機能フラグ

### Nx によるタスク依存グラフ

```json
// nx.json:67-71
"build": {
  "cache": true,
  "dependsOn": ["^build"],
  "inputs": ["production", "^production"],
  "outputs": ["{projectRoot}/build", "{projectRoot}/dist"]
}
```

`"dependsOn": ["^build"]` は「自身のビルド前に、依存パッケージのビルドを完了させる」という意味で、Layer 0 → Layer 1 → Layer 2 の順序でビルドが自動的に実行される。`test:eslint` と `test:lib` は `"dependsOn": ["^compile"]` により、依存先の TypeScript コンパイルが先行する。

### integrations ディレクトリによる統合テスト

`examples/` とは別に `integrations/` ディレクトリが存在し、各バンドラー・フレームワークの組み合わせでのビルド検証を行う。

```
integrations/
├── angular-cli-20      # Angular CLI 20
├── react-next-14       # Next.js 14
├── react-next-15       # Next.js 15
├── react-next-16       # Next.js 16
├── react-vite          # Vite + React
├── react-webpack-4     # Webpack 4 + React
├── react-webpack-5     # Webpack 5 + React
├── solid-vite          # Vite + Solid
├── svelte-vite         # Vite + Svelte
└── vue-vite            # Vite + Vue
```

これらは `pnpm-workspace.yaml` にワークスペースとして登録されているが、`nx.json` の `build` や `test:*` からは `--exclude=integrations/**` で除外されている。CI の `test:build` でのみ実行され、日常の開発サイクルには影響しない設計。

## パターンカタログ

- **Observer パターン** (分類: 振る舞い)
  - 解決する問題: フレームワーク非依存のコアが、UI 層の状態更新をトリガーする必要がある
  - 適用条件: コアライブラリが複数のフレームワークをサポートする場合
  - コード例: `packages/query-core/src/subscribable.ts:1-30` — 汎用の Subscribable 基底クラス。`QueryObserver` (`packages/query-core/src/queryObserver.ts:40-46`) がこれを継承し、各フレームワークアダプタが `subscribe` で購読する
  - 注意点: Observer は「何を通知するか」のみ定義し、「通知をどう UI に反映するか」はアダプタに委譲すること

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: GC やライフサイクル管理のアルゴリズム骨格を固定しつつ、サブクラスで詳細を変更したい
  - 適用条件: 基底クラスがアルゴリズムの骨格を持ち、具体的な判断をサブクラスに委ねる場合
  - コード例: `packages/query-core/src/removable.ts:5-39` — `scheduleGc()` がアルゴリズム骨格、`optionalRemove()` が abstract メソッドとしてサブクラスに委譲
  - 注意点: JavaScript/TypeScript では abstract class より composition が好まれる傾向があるが、内部実装では Template Method が簡潔に機能する

## Good Patterns

- **Re-export による API 表面の統一**: 全フレームワークアダプタが `export * from '@tanstack/query-core'` を行い、ユーザーは `@tanstack/react-query` のみを import すればコア API にもアクセスできる。これにより、ユーザーが `query-core` を直接依存に追加する必要がなく、アダプタパッケージだけで完結する。

```ts
// packages/react-query/src/index.ts:4
export * from "@tanstack/query-core";
```

- **Private パッケージによる内部共有**: `query-test-utils` は `"private": true` で npm に公開されないが、ワークスペース内では `workspace:*` で参照可能。テストヘルパー（`sleep`, `queryKey`, `mockVisibilityState`）を全パッケージで共有しつつ、外部公開のメンテナンスコストを避けている。

```json
// packages/query-test-utils/package.json:6
"private": true,
```

- **pnpm overrides による依存バージョン統一**: ルートの `package.json` で `pnpm.overrides` を使い、`@types/react`、`vite` 等のバージョンを全ワークスペースで統一。パッケージ間のバージョン不整合による型エラーやランタイムの不具合を構造的に防止。

```json
// package.json:88-94
"pnpm": {
  "overrides": {
    "@types/react": "^19.2.7",
    "@types/react-dom": "^19.2.3",
    "@types/node": "^22.15.3",
    "vite": "^6.4.1",
    "esbuild": "^0.27.2"
  }
}
```

- **Multi-version TypeScript テスト**: 各パッケージが TS 5.0 から 5.8 まで 9 バージョンの型チェックを実行。`tsconfig.legacy.json` でテストを除外した型チェック用設定を分離し、`npm-run-all2` で直列実行する。公開 API の型互換性を保証する仕組み。

```json
// packages/query-core/package.json:22-29
"test:types:ts50": "node ../../node_modules/typescript50/lib/tsc.js --build tsconfig.legacy.json",
...
"test:types:tscurrent": "tsc --build",
```

## Anti-Patterns / 注意点

- **symlink が動作しない環境での開発**: CONTRIBUTING.md で「symlink-based configuration files」と明記されているように、Windows（WSL 以外）では symlink が正常に動作しない可能性がある。モノレポで symlink を活用する場合、`pnpm-workspace.yaml` の `linkWorkspacePackages` と組み合わせて使うか、CI 環境を Linux に統一する必要がある。

```
# Bad: Windows ネイティブで symlink が無効な環境
packages/react-query/root.tsup.config.js → エラー

# Better: pnpm-workspace.yaml で明示的にリンクを有効化
linkWorkspacePackages: true
preferWorkspacePackages: true
```

- **コアパッケージへの UI 依存の混入**: `query-devtools` は UI コンポーネントを含むにもかかわらず `query-core` と同じ Layer 0 に位置する。もし devtools がコアの内部 API に直接依存すると、コアの変更が devtools を壊すリスクが高まる。TanStack Query では devtools の `query-core` 依存を `devDependencies` に留めることでこれを軽減している。

```json
// packages/query-devtools/package.json:72
// query-core は devDependencies（ビルド時のみ）
"@tanstack/query-core": "workspace:*",
```

## 導出ルール

- `[MUST]` マルチフレームワーク対応のライブラリでは、フレームワーク非依存のコアパッケージを分離し、アダプタパッケージからの一方向依存のみ許可する
  - 根拠: TanStack Query は `query-core` を唯一の共通依存とし、6 フレームワークでロジック重複ゼロを実現している（`packages/query-core` → 全アダプタの `dependencies` に `workspace:*`）

- `[MUST]` モノレポの各パッケージの `package.json` に `"sideEffects": false` を設定し、バンドラーの tree-shaking を有効にする
  - 根拠: TanStack Query の全 20+ 公開パッケージが `"sideEffects": false` を宣言しており、ユーザーのバンドルサイズを最小化している

- `[SHOULD]` モノレポの共有設定（ESLint, ビルド, tsconfig）は symlink またはファイル参照で単一ソースから配布し、パッケージ固有の差分のみローカルでオーバーライドする
  - 根拠: `root.tsup.config.js` → `../../scripts/getTsupConfig.js` への symlink により、24 パッケージの設定が 1 ファイルで管理されている

- `[SHOULD]` 公開ライブラリの dual build（modern/legacy）は、共通のビルド関数にターゲット差分をパラメータとして渡す構造にする
  - 根拠: `modernConfig()` と `legacyConfig()` が同一の構造でターゲットのみ異なり、各パッケージの `tsup.config.ts` は 2 行で両ビルドを定義できている

- `[SHOULD]` 実験的な機能は、影響範囲に応じてパッケージ名（`-experimental`）、エクスポート名（`experimental_` プレフィクス）、オプション名（`experimental_` プレフィクス）の 3 段階で成熟度を明示する
  - 根拠: `angular-query-experimental`（パッケージ全体）、`experimental_streamedQuery`（単一 API）、`experimental_prefetchInRender`（機能フラグ）の使い分けが存在する

- `[SHOULD]` モノレポ内の非公開共有コード（テストユーティリティ等）は `"private": true` の内部パッケージとして切り出し、`workspace:*` で参照する
  - 根拠: `query-test-utils` は `private: true` で `sleep`, `queryKey`, `mockVisibilityState` を全パッケージに提供し、テストコードの重複を排除している

- `[SHOULD]` 公開パッケージの型互換性を保証するために、サポート対象の TypeScript バージョン全てで型チェックを CI に組み込む
  - 根拠: 全パッケージが TS 5.0〜5.8 の 9 バージョンで `tsc --build` を実行し、`publint` + `@arethetypeswrong/cli` でパッケージ品質も検証している

- `[AVOID]` モノレポの examples や integrations を通常のビルド・テストタスクに含める — 日常の開発サイクルが遅くなる
  - 根拠: `nx.json` の `build` と `test:*` は `--exclude=examples/** --exclude=integrations/**` で除外し、CI の専用ステップでのみ検証している

## 適用チェックリスト

- [ ] ライブラリのフレームワーク非依存コアが分離されているか確認する（コアの `dependencies` にフレームワーク固有パッケージが含まれていないこと）
- [ ] パッケージ間の依存方向が単方向であることを確認する（循環依存がないこと）
- [ ] 全公開パッケージに `"sideEffects": false` が設定されているか確認する
- [ ] 共有設定（ESLint, tsconfig, ビルド）が単一ソースから配布されているか確認する
- [ ] `package.json` の `exports` フィールドで CJS/ESM/types を正しく定義しているか確認する
- [ ] 実験的機能に明確な命名規則（`experimental` プレフィクス等）が適用されているか確認する
- [ ] テストユーティリティや内部共有コードが `private: true` の内部パッケージとして管理されているか確認する
- [ ] CI で複数の TypeScript バージョンでの型チェックが実行されているか確認する
- [ ] `pnpm.overrides`（または `resolutions`）で型定義パッケージのバージョンがワークスペース全体で統一されているか確認する
- [ ] examples/integrations が通常のビルド・テストから除外されているか確認する
