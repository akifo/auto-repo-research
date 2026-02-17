# practice: devdeps-bundling

> 出典: repos/vitejs/vite からの分析
> カテゴリ: practice

## 概要

devDependencies バンドルによるランタイム依存の極小化戦略。ランタイムで使うパッケージを `devDependencies` に配置し、ビルド時にバンドルすることで `dependencies` を最小限に抑える逆転の発想である。Vite はこの手法で 50 以上の依存をバンドルに内包し、公開パッケージの `dependencies` をわずか 6 パッケージまで削減している。npm alias（`debug` を `obug` に置換）、shimDepsPlugin による依存コードの書き換え、bundleSizeLimit による自動ガードレールを組み合わせ、配布パッケージの軽量性を構造的に保証する。

## 背景・文脈

npm パッケージを publish する際、`dependencies` に列挙されたパッケージはユーザーの `node_modules` にすべてインストールされる。依存が多ければ多いほど、インストール時間の増大、バージョン衝突のリスク、`node_modules` の肥大化が起こる。

Vite は「ビルドツール」という性質上、`connect`, `chokidar`, `ws`, `picocolors`, `magic-string` など多数のランタイム依存を持つ。しかし、これらをすべて `dependencies` に入れると、ユーザーの環境に推移的依存を含めた大量のパッケージがインストールされる。

Vite の解決策は「ランタイムで使うパッケージであっても、バンドル可能なら `devDependencies` に入れてビルド時にバンドルする」というものである。CONTRIBUTING.md にはこの方針が明文化されている:

```
Most deps should be added to devDependencies even if they are needed at runtime.
Some exceptions are:
- Type packages. Example: @types/*.
- Deps that cannot be properly bundled due to binary files. Example: esbuild.
- Deps that ship their own types that are used in Vite's own public types. Example: rollup.
```

<!-- CONTRIBUTING.md:58-63 -->

## 実装パターン

### 1. dependencies と devDependencies の逆転配置

`package.json` では `dependencies` にバンドルできないパッケージのみを残し、ランタイム依存の大半を `devDependencies` に配置する。意図が分かるようコメントで誘導する。

```json
// packages/vite/package.json:74-82
"//": "READ CONTRIBUTING.md to understand what to put under deps vs. devDeps!",
"dependencies": {
  "@oxc-project/runtime": "0.113.0",
  "lightningcss": "^1.31.1",
  "picomatch": "^4.0.3",
  "postcss": "^8.5.6",
  "rolldown": "1.0.0-rc.4",
  "tinyglobby": "^0.2.15"
},
```

対して `devDependencies` には `connect`, `chokidar`, `ws`, `picocolors`, `magic-string` 等のランタイム依存を含む 50 以上のパッケージが列挙されている。

### 2. バンドル設定で dependencies のみ external 化

ビルド設定の `external` に `pkg.dependencies` と `pkg.peerDependencies` のみを指定し、`devDependencies` はすべてバンドルに取り込む。

```ts
// packages/vite/rolldown.config.ts:79-92
external: [
  /^vite\//,
  'fsevents',
  /^rolldown\//,
  /^tsx\//,
  /^@vitejs\/devtools\//,
  /^#/,
  'sugarss',
  'supports-color',
  'utf-8-validate',
  'bufferutil',
  ...Object.keys(pkg.dependencies),
  ...Object.keys(pkg.peerDependencies),
],
```

### 3. shimDepsPlugin による依存コードの書き換え

バンドル対象の依存が CJS の `require()` や不要なモジュールを参照している場合、ビルド時に MagicString でコードを差し替える。

```ts
// packages/vite/rolldown.config.ts:94-125
shimDepsPlugin({
  'postcss-load-config/src/req.js': [
    {
      src: "const { pathToFileURL } = require('node:url')",
      replacement: `const { fileURLToPath, pathToFileURL } = require('node:url')`,
    },
    {
      src: '__filename',
      replacement: 'fileURLToPath(import.meta.url)',
    },
  ],
  // postcss-import の resolve と read-cache は Vite が自前で処理するため除去
  'postcss-import/index.js': [
    {
      src: 'const resolveId = require("./lib/resolve-id")',
      replacement: 'const resolveId = (id) => id',
    },
    {
      src: 'const loadContent = require("./lib/load-content")',
      replacement: 'const loadContent = () => ""',
    },
  ],
}),
```

`buildEnd` フックで未適用の shim がないか検証し、依存のアップデートでファイル名が変わった場合にビルドを失敗させる安全策も備える。

### 4. npm alias による依存の軽量化

`pnpm-workspace.yaml` の `overrides` で、`debug` パッケージを軽量互換品 `obug` に差し替える。

```yaml
# pnpm-workspace.yaml:17
overrides:
  debug: 'npm:obug@^1.0.2'
```

ソースコードでは `obug` から直接インポートする:

```ts
// packages/vite/src/node/utils.ts:17-18
import type { Debugger } from 'obug'
import debug from 'obug'
```

### 5. bundleSizeLimit プラグインによる自動ガードレール

サイズ制約が重要なバンドルに kB 単位のハードリミットを設定し、超過時にビルドエラーにする。

```ts
// packages/vite/rolldown.config.ts:150
plugins: [bundleSizeLimit(54), enableSourceMapsInWatchModePlugin()],

// packages/vite/rolldown.config.ts:377-405
function bundleSizeLimit(limit: number): Plugin {
  let size = 0
  return {
    name: 'bundle-limit',
    generateBundle(_, bundle) {
      if (this.meta.watchMode) return
      size = Buffer.byteLength(
        Object.values(bundle)
          .map((i) => ('code' in i ? i.code : ''))
          .join(''),
        'utf-8',
      )
    },
    closeBundle() {
      if (this.meta.watchMode) return
      const kb = size / 1000
      if (kb > limit) {
        this.error(
          `Bundle size exceeded ${limit} kB, current size is ${kb.toFixed(2)}kb.`,
        )
      }
    },
  }
}
```

### 6. ESLint による require() 禁止の強制

ESLint ルールで `devDependencies` の `require()` を禁止し、`await import()` のみを許可する。これにより、devDependencies がバンドルに確実に含まれることを lint レベルで担保する。

```js
// eslint.config.js:205-214
'n/no-restricted-require': [
  'error',
  Object.keys(pkgVite.devDependencies).map((d) => ({
    name: d,
    message:
      `devDependencies can only be imported using ESM syntax so ` +
      `that they are included in the rolldown bundle. If you are trying to ` +
      `lazy load a dependency, use (await import('dependency')).default instead.`,
  })),
],
```

### 7. 型定義のインライン化

バンドルされた devDependencies の型をユーザーに公開するため、`src/types/` に型定義を手動でインラインし、`#dep-types/*` import map で参照する。

```ts
// packages/vite/src/types/chokidar.d.ts:1
// Inlined to avoid extra dependency (chokidar is bundled in the published build)

// packages/vite/src/types/alias.d.ts:1-2
// Types from https://github.com/rollup/plugins/blob/master/packages/alias/types/index.d.ts
// Inlined because the plugin is bundled.
```

```json
// packages/vite/package.json:38-39
"imports": {
  "#dep-types/*": "./src/types/*.d.ts"
}
```

## Good Example

`dependencies` を最小限にし、ランタイム依存をバンドルに内包する構成。推移的依存の影響を評価して軽量な代替を選択している。

```json
// package.json — dependencies は「バンドルできない」ものだけ
{
  "//": "READ CONTRIBUTING.md to understand what to put under deps vs. devDeps!",
  "dependencies": {
    "postcss": "^8.5.6",
    "rolldown": "1.0.0-rc.4",
    "lightningcss": "^1.31.1"
  },
  "devDependencies": {
    "connect": "^3.7.0",
    "chokidar": "^3.6.0",
    "ws": "^8.19.0",
    "picocolors": "^1.1.1",
    "magic-string": "^0.30.21"
  }
}
```

```ts
// rolldown.config.ts — devDependencies をバンドルに含める
external: [
  ...Object.keys(pkg.dependencies),     // dependencies は外部化
  ...Object.keys(pkg.peerDependencies),  // peerDependencies も外部化
  // devDependencies は external に含めない → バンドルに取り込まれる
],
```

```ts
// 軽量代替の選択: http-proxy-middleware(3MB) ではなく http-proxy-3(380kB) を直接使用
// packages/vite/src/node/server/middlewares/proxy.ts:2
import * as httpProxy from 'http-proxy-3'
```

## Bad Example

すべてのランタイム依存を `dependencies` に配置し、推移的依存の評価なしに便利なラッパーライブラリを採用する構成。

```json
// package.json — ランタイム依存をすべて dependencies に入れてしまう
{
  "dependencies": {
    "connect": "^3.7.0",
    "chokidar": "^3.6.0",
    "ws": "^8.19.0",
    "picocolors": "^1.1.1",
    "magic-string": "^0.30.21",
    "http-proxy-middleware": "^2.0.0",
    "debug": "^4.3.0"
  }
}
// ユーザーの node_modules に推移的依存を含めた大量のパッケージがインストールされる
// http-proxy-middleware だけで 3MB の推移的依存が発生
```

```ts
// ESM で require() を使う — バンドラに無視され、devDependencies は publish 時に存在しない
const dep = require('somedep')  // バンドルに含まれず、二重に壊れる

// 正しくは await import() を使う
const dep = (await import('somedep')).default
```

## 適用ガイド

### どのような状況で使うべきか

- **npm パッケージとして publish するツール・ライブラリ**: ユーザーの `node_modules` を肥大化させたくない場合に有効
- **依存が多い CLI ツールやビルドツール**: ランタイムで多くのパッケージを使うが、ユーザーにその負担を転嫁したくない場合
- **バンドルサイズが品質指標となるプロジェクト**: module-runner のように、軽量性が機能要件であるモジュール

### 導入時の注意点

- **`dependencies` に残すべきもの基準を明文化する**: バイナリ依存（rolldown, esbuild 等）、型が公開 API に露出する依存（postcss 等）、optional な peerDependencies は `dependencies` に残す必要がある。この判断基準を CONTRIBUTING.md のようなドキュメントに明記すること
- **ESM では `require()` が使えない**: devDependencies をバンドルに含めるため、遅延ロードには `(await import('somedep')).default` パターンを使う。ESLint ルールで `require()` を禁止し、チーム全体で強制するのが望ましい
- **型定義の公開が複雑になる**: バンドルされた依存の型はユーザーから見えなくなるため、公開 API に型が露出する場合は `src/types/` に型をインラインする必要がある。ビルド時に型リークを検証する仕組み（`validateChunkImports` 相当）も導入すべき
- **shim の増殖に注意**: `shimDepsPlugin` は文字列ベースの書き換えであり、依存のアップデートで壊れやすい。shim が増えすぎたら、ESM 対応の代替パッケージへの移行を検討する

### カスタマイズポイント

- **bundleSizeLimit の閾値**: プロジェクトの要件に応じて kB 単位で設定する。Watch モードではスキップし、プロダクションビルドでのみ検証する設計が実用的
- **npm alias の活用**: `debug` を `obug` に差し替えるように、pnpm/npm の overrides で軽量互換パッケージに置換できる。ただし互換性の検証が必要
- **pnpm patches の活用**: fork せずにピンポイントで依存をカスタマイズできる。パフォーマンス改善や機能追加が少量の変更で済む場合に有効

## 参考

- [repos/vitejs/vite/dependency-management.md](../repos/vitejs/vite/dependency-management.md) --- 依存管理の全体戦略
- [repos/vitejs/vite/build-and-tooling.md](../repos/vitejs/vite/build-and-tooling.md) --- ビルドパイプラインとセルフバンドリング
- [repos/vitejs/vite/design-philosophy.md](../repos/vitejs/vite/design-philosophy.md) --- 設計哲学と軽量配布の原則
