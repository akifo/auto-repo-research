# dependency-management

> リポジトリ: vitejs/vite
> 分析日: 2026-02-17

## 概要

Vite は「軽量であること」をコア原則の一つとして掲げ、依存関係の管理に独自の戦略を持つ。ほぼすべてのランタイム依存を `devDependencies` として宣言し、Rolldown でバンドルしてから publish する。CSS プリプロセッサや minifier などのオプショナル機能は遅延 `import()` で必要時にのみロードし、型の公開と依存バンドルの両立のために型定義のインライン化を行う。npm alias（`debug` → `obug`）やパッチファイルによる依存のカスタマイズも含め、サイズ意識の高い依存管理戦略が体系的に実装されている。

## 背景にある原則

- **最小 dependencies 原則**: `dependencies` に含めるものは「バンドルできない」か「公開型に必要」な場合のみに限定すべき。runtime で使うパッケージでも、バンドル可能なら `devDependencies` に入れて事前バンドルする。これにより、ユーザーの `node_modules` の肥大化を防ぐ（`CONTRIBUTING.md:44-63`）。

- **遅延ロードによる起動時間最適化**: すべての機能モジュールを起動時にロードせず、CLI コマンドのアクションハンドラ内で `await import()` することで、使わないコードパスのロードコストをゼロにすべき。ビルドツールは多数の機能を持つが、1回の実行で使うのはその一部だけだからである（`src/node/cli.ts:214, 348, 397, 441`）。

- **推移的依存の警戒**: 依存を追加する前に、その推移的依存のサイズと提供する機能のバランスを評価すべき。`http-proxy-middleware`（3MB）の代わりに `http-proxy`（380kB）+ 数行のカスタムコードを選ぶのがその例である（`CONTRIBUTING.md:64`）。

- **バンドルサイズのガードレール**: サイズ制約が重要なモジュールには、CI で自動検証するサイズリミットを設けるべき。module-runner に 54kB 上限が設定されており、意図せぬ依存追加による膨張を検出する（`rolldown.config.ts:150, 377-405`）。

## 実例と分析

### devDependencies のバンドリング戦略

Vite の `packages/vite/package.json` を見ると、`dependencies` はわずか 6 パッケージ（`@oxc-project/runtime`, `lightningcss`, `picomatch`, `postcss`, `rolldown`, `tinyglobby`）に対して、`devDependencies` には 50 以上のパッケージが列挙されている。`connect`, `chokidar`, `ws`, `picocolors`, `magic-string` など、明らかにランタイムで使うパッケージも `devDependencies` に入っている。

```
// packages/vite/package.json:74
"//": "READ CONTRIBUTING.md to understand what to put under deps vs. devDeps!",
```

このコメントは、一見不自然な依存配置に対する明示的な説明導線である。`rolldown.config.ts` の `external` 設定で `pkg.dependencies` と `pkg.peerDependencies` のみをバンドル外とし、`devDependencies` はすべてバンドルに取り込む:

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

### 遅延インポートパターン

CLI のアクションハンドラは、各コマンドの実行コードをすべて `await import()` で遅延ロードする:

```ts
// packages/vite/src/node/cli.ts:214
const { createServer } = await import('./server')

// packages/vite/src/node/cli.ts:348
const { createBuilder } = await import('./build')

// packages/vite/src/node/cli.ts:396-397
const { resolveConfig } = await import('./config')
const { optimizeDeps } = await import('./optimizer')

// packages/vite/src/node/cli.ts:441
const { preview } = await import('./preview')
```

CSS プリプロセッサ（Sass, Less, Stylus）や HTML パーサー（parse5）、terser など、ユーザー環境に存在しない可能性のある依存は、使用時に動的にロードする:

```ts
// packages/vite/src/node/plugins/html.ts:209
const { parse } = await import('parse5')

// packages/vite/src/node/plugins/css.ts:2512
const sass: typeof Sass = await import(sassPath)

// packages/vite/src/node/plugins/css.ts:2861
const nodeLess: typeof Less = (await import(lessPath)).default

// packages/vite/src/node/plugins/css.ts:2974
const stylus: typeof Stylus = (await import(stylusPath)).default
```

CONTRIBUTING.md はこのパターンの根拠を明示している: ESM ファイルでは `require()` が無視されバンドルに含まれないため、`(await import('somedep')).default` を使う必要がある（`CONTRIBUTING.md:50-54`）。

### npm alias による依存置換（debug → obug）

`pnpm-workspace.yaml` に `debug: 'npm:obug@^1.0.2'` という override が定義されている:

```yaml
# pnpm-workspace.yaml:17
overrides:
  debug: 'npm:obug@^1.0.2'
```

これにより、モノレポ全体で `debug` パッケージの代わりに `obug` が使われる。ソースコード上でも直接 `obug` からインポートしている:

```ts
// packages/vite/src/node/utils.ts:17-18
import type { Debugger } from 'obug'
import debug from 'obug'
```

`obug` は `debug` の軽量フォーク（または互換パッケージ）であり、バンドルサイズ削減のための意図的な選択である。

### pnpm patches による依存のカスタマイズ

4 つのパッチファイルが `patches/` ディレクトリに存在する:

- `sirv@3.0.2.patch` — `shouldServe` オプションを追加（ファイルサーブのフィルタリング機能）
- `chokidar@3.6.0.patch` — ignored ファイルリストのバイパスでパフォーマンス向上
- `dotenv-expand@12.0.3.patch` — 動作のカスタマイズ
- `http-proxy-3.patch` — プロキシの動作修正

```yaml
# pnpm-workspace.yaml:18-22
patchedDependencies:
  "sirv@3.0.2": "patches/sirv@3.0.2.patch"
  "chokidar@3.6.0": "patches/chokidar@3.6.0.patch"
  "dotenv-expand@12.0.3": "patches/dotenv-expand@12.0.3.patch"
  "http-proxy-3": patches/http-proxy-3.patch
```

パッチは「fork してメンテナンスコストを背負う」ことを避けつつ、ピンポイントで必要な変更を加える中間策である。

### 型のインライン化（#dep-types パターン）

バンドルされる devDependencies の型をユーザーに公開するために、`src/types/` に型定義をインライン化している:

```ts
// packages/vite/src/types/alias.d.ts:1-2
/**
Types from https://github.com/rollup/plugins/blob/master/packages/alias/types/index.d.ts
Inlined because the plugin is bundled.
```

```ts
// packages/vite/src/types/chokidar.d.ts:1
// Inlined to avoid extra dependency (chokidar is bundled in the published build)
```

```ts
// packages/vite/src/types/connect.d.ts:1
// Inlined to avoid extra dependency
```

`package.json` の `imports` フィールドでパスエイリアスを設定:

```json
// packages/vite/package.json:38-39
"imports": {
  "#dep-types/*": "./src/types/*.d.ts"
}
```

`rolldown.dts.config.ts` には、ビルド後の型ファイルが devDependencies からインポートしていないことを検証するプラグインがある:

```ts
// packages/vite/rolldown.dts.config.ts:234-261
function validateChunkImports(...) {
  const deps = Object.keys(pkg.dependencies)
  for (const { id, bindings } of importBindings) {
    if (
      !id.startsWith('./') && !id.startsWith('../') &&
      !id.startsWith('#') && !id.startsWith('node:') &&
      !deps.includes(id) &&
      !deps.some((name) => id.startsWith(name + '/'))
    ) {
      this.warn(`${chunk.fileName} imports "${bindings.join(', ')}" from "${id}" which is not allowed`)
      process.exitCode = 1
    }
  }
}
```

### shimDepsPlugin によるバンドル時の依存コード書き換え

バンドル対象の依存が CJS の `require()` や不要なモジュールをインポートしている場合、ビルド時にコードを差し替える:

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

`postcss-import` の `resolve` と `read-cache` は Vite が自前で処理するため、バンドルから除去して不要な推移的依存を排除している。

### bundleSizeLimit プラグイン

module-runner は軽量であることが要求されるため、54kB のハードリミットが設定されている:

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
        this.error(`Bundle size exceeded ${limit} kB, current size is ${kb.toFixed(2)}kb.`)
      }
    },
  }
}
```

### peerDependencies によるオプショナル機能の分離

CSS プリプロセッサ（sass, less, stylus）、minifier（terser）、設定ローダー（jiti, tsx）などは `peerDependencies` + `peerDependenciesMeta: { optional: true }` で宣言されている:

```json
// packages/vite/package.json:141-192
"peerDependencies": {
  "esbuild": "^0.27.0",
  "jiti": ">=1.21.0",
  "less": "^4.0.0",
  "sass": "^1.70.0",
  "terser": "^5.16.0",
  "tsx": "^4.8.1"
},
"peerDependenciesMeta": {
  "esbuild": { "optional": true },
  "sass": { "optional": true },
  "terser": { "optional": true }
}
```

## パターンカタログ

- **Facade パターン** (構造)
  - 解決する問題: devDependencies をバンドルすることで、publish されるパッケージが直接依存を持たない「ファサード」として機能する
  - 適用条件: ツールやライブラリの publish 時に、ユーザーの `node_modules` を肥大化させたくない場合
  - コード例: `rolldown.config.ts:79-92`（external 設定で dependencies のみ外部化）
  - 注意点: 型定義の公開が複雑になる（インライン化が必要）

- **Lazy Initialization パターン** (振る舞い)
  - 解決する問題: 未使用の機能モジュールのロードコストを排除する
  - 適用条件: CLI ツールのように、1 回の実行で機能の一部しか使わない場合
  - コード例: `src/node/cli.ts:214`（`await import('./server')`）
  - 注意点: ESM では `require()` が使えないため `await import()` が必須

## Good Patterns

- **dependencies/devDependencies の意図的な逆転配置**: ランタイムで使うパッケージを `devDependencies` に配置し、ビルド時にバンドルすることで `dependencies` を最小化する。`package.json` に `"//": "READ CONTRIBUTING.md to understand what to put under deps vs. devDeps!"` というコメントで意図を明示している点が重要。

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

- **CLI コマンドごとの遅延ロード**: 各 CLI サブコマンドの action ハンドラ内で、そのコマンドに必要なモジュールだけを動的インポートする。`vite dev` を実行したときに `build` モジュールのロードが発生しない。

```ts
// packages/vite/src/node/cli.ts:214
// dev コマンド → server のみロード
const { createServer } = await import('./server')

// packages/vite/src/node/cli.ts:348
// build コマンド → build のみロード
const { createBuilder } = await import('./build')
```

- **ビルドパイプラインでの依存コード書き換え（shimDepsPlugin）**: バンドル対象の依存が持つ不要な `require()` やモジュール参照を、ビルド時に差し替えることで推移的依存を削減する。fork のメンテナンスコストなく、ピンポイントで最適化できる。

## Anti-Patterns / 注意点

- **重量級ラッパーライブラリの安易な採用**: 薄いラッパーのために巨大な推移的依存を引き込むことは避けるべき。

```ts
// Bad: http-proxy-middleware（3MB、大量の推移的依存）
import { createProxyMiddleware } from 'http-proxy-middleware'

// Better: http-proxy-3（380kB）+ 数行のカスタムミドルウェア
// packages/vite/src/node/server/middlewares/proxy.ts:2
import * as httpProxy from 'http-proxy-3'
```

- **ESM バンドルで require() を使う**: ESM コンテキストでは `require()` はバンドラに無視され、さらに devDependencies は publish 時に存在しないため二重に壊れる。

```ts
// Bad: ESM で require（バンドルに含まれず、devDep も見つからない）
const dep = require('somedep')

// Better: 動的 import を使う
const dep = (await import('somedep')).default
```

## 導出ルール

- `[MUST]` バンドルして publish するパッケージでは、バンドル対象の依存を `devDependencies` に配置し、バンドルできない依存（バイナリ、型公開が必要なもの）のみ `dependencies` に入れる
  - 根拠: Vite は connect, chokidar, ws 等のランタイム依存をすべて devDependencies に置き、Rolldown でバンドルして dependencies を 6 パッケージに抑えている（`packages/vite/package.json:75-82`）

- `[MUST]` バンドルされた devDependencies の型をユーザーに公開する場合は、型定義をインライン化してビルド時にバリデーションする
  - 根拠: Vite は `src/types/` に型をインライン化し、`rolldown.dts.config.ts` の `validateChunkImports` で devDependencies からの型リークを CI で検出している

- `[SHOULD]` CLI ツールでは各サブコマンドの実行コードを `await import()` で遅延ロードし、未使用コードパスのロードコストをゼロにする
  - 根拠: Vite の CLI は dev/build/preview/optimize の各コマンドで必要なモジュールのみを動的インポートしている（`src/node/cli.ts:214, 348, 441`）

- `[SHOULD]` サイズ制約が重要なバンドルには、ビルドパイプラインにバンドルサイズのハードリミットを設けて CI で自動検証する
  - 根拠: module-runner に `bundleSizeLimit(54)` プラグインが設定され、54kB 超過でビルドが失敗する（`rolldown.config.ts:150, 377-405`）

- `[SHOULD]` 依存パッケージの一部機能だけが必要な場合は、パッチファイルや shimDepsPlugin で不要コードを除去し、fork のメンテナンスコストを回避する
  - 根拠: `postcss-import` の `resolve` と `read-cache` 依存を shimDepsPlugin で除去、sirv には `shouldServe` を pnpm patch で追加している

- `[AVOID]` 薄いラッパーのために推移的依存が大きいパッケージを追加すること。直接 API を使って数行のコードで済むなら、その方がサイズ・保守の両面で優れる
  - 根拠: CONTRIBUTING.md が `http-proxy`（380kB）と `http-proxy-middleware`（3MB）の比較を明示的に例示して警告している

## 適用チェックリスト

- [ ] publish するパッケージの `dependencies` を見直し、バンドル可能な依存を `devDependencies` に移動してビルド時にバンドルする構成にできないか検討する
- [ ] `dependencies` に残すべきものの基準を明文化する（バイナリ依存、型公開が必要な依存、optional peer dependencies）
- [ ] CLI ツールやプラグインシステムで、各コマンド/機能のエントリポイントを `await import()` で遅延ロードしているか確認する
- [ ] 新しい依存を追加する前に、その推移的依存のサイズを `npm pack --dry-run` や `bundlephobia` で確認するフローを導入する
- [ ] サイズクリティカルなバンドルに `bundleSizeLimit` 相当のガードレールを設定し、CI で自動検証する
- [ ] devDependencies をバンドルしている場合、公開型が devDependencies の型に依存していないことをビルド時に検証する仕組みを導入する
- [ ] 依存のカスタマイズが必要な場合、fork ではなくパッチファイル（pnpm patch）やビルド時コード書き換えを優先する
