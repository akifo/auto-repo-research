# code-organization

> リポジトリ: vitejs/vite
> 分析日: 2026-02-17

## 概要

Vite のコードベースは、単一パッケージ内で「ブラウザ向けクライアント」「Node.js 向けサーバー」「ランタイム非依存の共有コード」を明確に分離し、ランタイム境界をモジュール境界として厳密に制御している。`package.json` の `exports` フィールドと `imports` フィールド、そして複数の `tsconfig.json` を組み合わせて、公開 API と内部 API の境界をビルド時・型チェック時の両方で強制している点が注目に値する。

## 背景にある原則

- **ランタイム境界 = モジュール境界にすべき**: `shared/` は Node.js API (`fs`, `path` 等) を一切使わず、`node/` と `module-runner/` の両方から安全に参照できる。ランタイムが異なるコードは物理的にディレクトリを分け、tsconfig で依存方向を強制することで、ビルドターゲットの混在を構造的に防止している（`src/shared/tsconfig.json` は `node/` を `include` に含めていない）。

- **公開 API は単一ファイルで明示的に列挙すべき**: `index.ts` が全 `export` を集約するバレルファイルとして機能し、ここに書かれたものだけが公開 API となる。「何をエクスポートするか」を1箇所で管理することで、API サーフェスの肥大化を防ぎ、破壊的変更の影響範囲を可視化できる。

- **型エクスポートと値エクスポートは分離すべき**: `export type { ... }` と `export { ... }` を意図的に分け、ESLint の `consistent-type-imports` ルールで強制している。型だけを参照する側がランタイムバンドルに不要なモジュールを引き込むことを防ぐ。

- **内部型は import alias で隔離すべき**: `#types/*` / `#dep-types/*` という Node.js subpath imports を使い、`types/internal/*` を `exports` フィールドで `null` にマッピングして外部アクセスを遮断している。peer dependency の型（esbuild, terser 等）を直接 re-export せず、薄いラッパー型ファイルで間接参照することで、peer dependency がインストールされていなくても型チェックが壊れない設計になっている。

## 実例と分析

### ランタイム分離の物理的境界

`src/` 直下は5つのディレクトリに分かれ、それぞれ異なるランタイムターゲットを持つ:

| ディレクトリ | ランタイム | ビルドエントリ |
|---|---|---|
| `client/` | ブラウザ (ES2020) | `dist/client/client.mjs`, `dist/client/env.mjs` |
| `node/` | Node.js (ES2023) | `dist/node/index.js`, `dist/node/cli.js`, `dist/node/internal.js` |
| `module-runner/` | ランタイム非依存 | `dist/node/module-runner.js` |
| `shared/` | ランタイム非依存 | (他バンドルに含まれる) |
| `types/` | 型のみ | なし |

依存方向は厳密に一方向で、`shared/` が最下層に位置する:

```
node/ ---> shared/ <--- module-runner/
node/ ---> module-runner/ (config.ts のみ)
client/ (独立、shared/ を参照しない)
```

`shared/` から `node/` への import は存在しない。これは tsconfig レベルでも強制されている。

### index.ts / internalIndex.ts の二重エントリポイント

```typescript
// packages/vite/src/node/index.ts:26-36
export {
  defineConfig,
  loadConfigFromFile,
  resolveConfig,
  sortUserPlugins,
} from './config'
export { perEnvironmentPlugin } from './plugin'
export { perEnvironmentState } from './environment'
export { createServer } from './server'
export { preview } from './preview'
export { build, createBuilder } from './build'
```

`index.ts` (289行) は公開 API の列挙に専念し、`internalIndex.ts` (1行) は内部専用エクスポートを分離する:

```typescript
// packages/vite/src/node/internalIndex.ts:1
export { viteReactRefreshWrapperPlugin as reactRefreshWrapperPlugin } from 'rolldown/experimental'
```

これらは `package.json` の `exports` で異なるエントリポイントにマッピングされる:

```json
// packages/vite/package.json:19-31
"exports": {
  ".": "./dist/node/index.js",
  "./module-runner": "./dist/node/module-runner.js",
  "./internal": "./dist/node/internal.js",
  "./types/internal/*": null
}
```

`"./types/internal/*": null` は内部型への外部アクセスを明示的にブロックする。

### #types / #dep-types による型の隔離

`package.json` の `imports` フィールドで内部エイリアスを定義:

```json
// packages/vite/package.json:33-39
"imports": {
  "#types/*": "./types/*.d.ts",
  "#dep-types/*": "./src/types/*.d.ts"
}
```

peer dependency の型を薄いラッパーファイルで包む:

```typescript
// packages/vite/src/types/alias.d.ts:30-31
import type { FunctionPluginHooks } from 'rolldown'
export interface Alias {
  find: string | RegExp
  replacement: string
}
```

```typescript
// packages/vite/types/internal/esbuildOptions.d.ts:4
// @ts-ignore `esbuild` may not be installed
import type esbuild from 'esbuild'
```

`@ts-ignore` で peer dependency が未インストールでもコンパイルを通す。これにより、esbuild や terser が optional でも Vite 本体の型チェックが破綻しない。

### 型と値の分離エクスポート

`index.ts` では値エクスポート (約30ブロック) と型エクスポート (約46ブロック) が明確に分かれている。ESLint の `consistent-type-imports` ルール (`eslint.config.js:154-157`) がこれを強制する:

```typescript
// packages/vite/src/node/server/environment.ts:5-9
import type {
  EnvironmentOptions,
  ResolvedConfig,
  ResolvedEnvironmentOptions,
} from '../config'
```

値と型を混合する場合は inline type import を使用:

```typescript
// packages/vite/src/node/server/environment.ts:39
import { type WebSocketServer, isWebSocketServer } from './ws'
```

### プラグインの1ファイル=1関心事パターン

`plugins/` ディレクトリには28のプラグインファイルがあり、各ファイルが単一の関心事に対応する。ファイルサイズは19行 (`json.ts`) から3539行 (`css.ts`) まで幅があるが、名前からコンテンツが予測できる:

```
json.ts (19行) - JSON の型定義のみ（実装は native plugin に委譲）
define.ts (269行) - process.env 等の置換
resolve.ts (1242行) - モジュール解決
css.ts (3539行) - CSS 処理全般
```

`plugins/index.ts` がプラグインの合成順序を管理する中央集約ファイルとして機能:

```typescript
// packages/vite/src/node/plugins/index.ts:55-129
return [
  !isBundled ? optimizedDepsPlugin() : null,
  ...prePlugins,
  ...oxcResolvePlugin(...),
  cssPlugin(config),
  ...normalPlugins,
  definePlugin(config),
  ...postPlugins,
  ...buildPlugins.post,
  ...(isBundled ? [] : [clientInjectionsPlugin(config), ...]),
].filter(Boolean) as Plugin[]
```

### ディレクトリごとの tsconfig による型安全性

3つの異なる `tsconfig.json` がランタイム境界を型レベルで強制する:

```json
// src/node/tsconfig.json - Node.js コード
{ "include": ["./", "../module-runner", "../types"] }

// src/shared/tsconfig.json - 共有コード
{ "include": ["./", "../types"] }   // node/ を含まない

// src/module-runner/tsconfig.json - ランタイム非依存
{ "include": ["./", "../node", "../types"] }
```

`shared/tsconfig.json` は `../node` を含まないため、`shared/` 内で `node/` のモジュールを import すると型エラーになる。これはコードレビューに依存しない構造的な保証である。

### ESLint による import 順序の強制

```javascript
// eslint.config.js:166-178
'import-x/order': [
  'error',
  {
    groups: [
      'builtin',    // node:fs, node:path
      'external',   // rolldown, picocolors
      'internal',   // #types/*, #dep-types/*
      'parent',     // ../config, ../../shared/utils
      'sibling',    // ./hmr, ./ws
      'index',      // .
    ],
  },
],
```

この順序規則により、import 文を見るだけでモジュールの依存方向を把握できる。

## パターンカタログ

- **Facade パターン** (構造)
  - 解決する問題: 内部モジュール構造の複雑さを外部に露出させない
  - 適用条件: パッケージの公開 API が内部構造と大きく異なる場合
  - コード例: `src/node/index.ts` が30以上の内部モジュールから選択的に re-export
  - 注意点: バレルファイルが肥大化すると tree-shaking に影響する可能性がある

- **Layered Architecture パターン** (構造)
  - 解決する問題: ランタイムの異なるコードの混在
  - 適用条件: 同一パッケージ内で複数のランタイム環境をサポートする場合
  - コード例: `src/shared/` (最下層) → `src/node/`, `src/module-runner/` (上位層)
  - 注意点: 層の数を増やしすぎると間接参照コストが増す

## Good Patterns

- **`exports` フィールドによる API 境界の明示**: `package.json` の `exports` で公開エントリポイントを列挙し、`"./types/internal/*": null` で内部型へのアクセスをブロックする。これによりユーザーが内部 API に依存することを Node.js レベルで防止できる。

```json
// packages/vite/package.json:19-31
"exports": {
  ".": "./dist/node/index.js",
  "./module-runner": "./dist/node/module-runner.js",
  "./internal": "./dist/node/internal.js",
  "./types/internal/*": null
}
```

- **peer dependency 型の間接参照**: optional な peer dependency (esbuild, terser 等) の型を `src/types/*.d.ts` でラップし、`@ts-ignore` で未インストール時も型チェックを通す。本体コードは `#dep-types/*` 経由で参照するため、peer dependency の型定義変更に強い。

```typescript
// packages/vite/types/internal/esbuildOptions.d.ts:3-4
// @ts-ignore `esbuild` may not be installed
import type esbuild from 'esbuild'
export type EsbuildTransformOptions = esbuild.TransformOptions
```

- **条件分岐を配列 + filter で表現するプラグイン合成**: `plugins/index.ts` では `null` を返す三項演算子と `.filter(Boolean)` を組み合わせて、条件付きプラグインを宣言的に合成する。if-else のネストより読みやすく、順序の意図が明確になる。

```typescript
// packages/vite/src/node/plugins/index.ts:55-129
return [
  !isBundled ? optimizedDepsPlugin() : null,
  ...prePlugins,
  cssPlugin(config),
  ...normalPlugins,
  ...postPlugins,
  ...(isBundled ? [] : [clientInjectionsPlugin(config)]),
].filter(Boolean) as Plugin[]
```

## Anti-Patterns / 注意点

- **巨大ユーティリティファイル**: `src/node/utils.ts` は1793行、`src/node/config.ts` は2725行に達している。関心事ごとの分割が不十分で、どの関数がどの文脈で使われるか把握しにくい。

```typescript
// Bad: utils.ts に雑多な関数が集約 (1793行)
// src/node/utils.ts - normalizePath, mergeConfig, resolveHostname, generateCodeFrame, ...

// Better: 関心事ごとに分割
// src/node/utils/path.ts - normalizePath, slash
// src/node/utils/network.ts - resolveHostname, resolveServerUrls
// src/node/utils/sourcemap.ts - generateCodeFrame
```

- **`css.ts` の3539行問題**: プリプロセッサ処理 (Sass, Less, Stylus)、PostCSS 処理、CSS Modules、Lightning CSS をすべて1ファイルに収めている。ファイルが巨大すぎて変更の影響範囲を把握しにくく、レビューコストが高い。

```typescript
// Bad: 1ファイルに全CSS関連処理 (3539行)
// src/node/plugins/css.ts

// Better: プリプロセッサごとに分割
// src/node/plugins/css/index.ts - メインプラグイン
// src/node/plugins/css/preprocessors.ts - Sass/Less/Stylus
// src/node/plugins/css/postcss.ts - PostCSS 統合
// src/node/plugins/css/modules.ts - CSS Modules
```

## 導出ルール

- `[MUST]` パッケージの公開 API は `index.ts` (バレルファイル) で明示的に列挙し、`package.json` の `exports` フィールドと一致させる
  - 根拠: Vite は `index.ts` の約289行で全公開 API を管理し、`exports` フィールドの4エントリポイントで外部からのアクセスを制御している。内部型は `null` マッピングでブロックされる

- `[MUST]` ランタイムが異なるコード (ブラウザ/Node.js/ユニバーサル) は物理的にディレクトリを分離し、tsconfig で依存方向を強制する
  - 根拠: Vite は `client/`, `node/`, `shared/`, `module-runner/` を別ディレクトリとし、各ディレクトリに独立した `tsconfig.json` を配置して include 範囲を制限している

- `[SHOULD]` 型のみのインポートは `import type` を使い、ESLint の `consistent-type-imports` ルールで強制する
  - 根拠: Vite は `eslint.config.js` で `@typescript-eslint/consistent-type-imports` を `error` に設定し、型と値の import を分離することでバンドルサイズの意図しない増加を防いでいる

- `[SHOULD]` optional な peer dependency の型は薄いラッパーファイルで間接参照し、`@ts-ignore` で未インストール時もコンパイルを通す
  - 根拠: `types/internal/esbuildOptions.d.ts` で esbuild の型を `@ts-ignore` 付きでラップし、`#dep-types/*` エイリアス経由で参照することで、esbuild 未インストール環境でも型チェックが成功する

- `[SHOULD]` import 順序を ESLint ルールで強制し、依存の方向性を可読性に反映させる（builtin → external → internal → parent → sibling → index）
  - 根拠: `eslint.config.js` の `import-x/order` ルールがグループ順を定義しており、import 文を見るだけで依存がどの層から来ているか判断できる

- `[AVOID]` 1ファイルに複数の関心事を詰め込んで巨大化させること（目安: 500行超で分割を検討）
  - 根拠: `css.ts` (3539行) や `utils.ts` (1793行) は関心事が混在しており、変更影響範囲の把握やレビューが困難になっている。対照的に `plugins/define.ts` (269行) や `plugins/terser.ts` (139行) は単一関心事で読みやすい

## 適用チェックリスト

- [ ] パッケージの `package.json` に `exports` フィールドを定義し、公開エントリポイントを明示しているか
- [ ] ランタイムが異なるコード（ブラウザ/サーバー/共有）が物理的に別ディレクトリに分離されているか
- [ ] 共有コードが上位層（Node.js 固有 API 等）に依存していないことを tsconfig の `include` で保証しているか
- [ ] `index.ts` (バレルファイル) が公開 API の一覧として機能し、内部モジュールの詳細を隠蔽しているか
- [ ] `import type` と `import` が分離され、ESLint ルールで強制されているか
- [ ] import 順序のルールが ESLint で定義・強制されているか
- [ ] 1ファイルが500行を超えていないか。超えている場合、関心事の分割を検討したか
- [ ] optional な外部依存の型が薄いラッパーで間接参照されているか
