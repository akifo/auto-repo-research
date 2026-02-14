# Dependency Management

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono は **ランタイム依存ゼロ**（`dependencies` フィールドが存在しない）という極めて稀な設計を採用した Web フレームワークである。devDependencies のみで開発・ビルド・テスト・公開を完結させ、75 の package.json exports と 97 の JSR exports を持つ大規模なマルチエントリーポイント構成を、カスタムビルドスクリプトと exports バリデーションで厳密に管理している。npm と JSR のデュアルレジストリ公開、7 つのランタイム環境でのテスト、`pkg-pr-new` による PR ごとのプレビュー公開など、依存管理の全レイヤーに工夫が凝らされている。

## 設計・実装の詳細

### ゼロランタイム依存の実現戦略

Hono の `package.json` には `dependencies` フィールドが一切存在しない。全ての外部パッケージは `devDependencies` に配置されている。ソースコード内で使用される外部モジュールは `node:*` プレフィックス付きの Node.js ビルトインのみで、かつそれはランタイム固有のアダプタに限定される。

```typescript
// src/middleware/context-storage/index.ts:6
import { AsyncLocalStorage } from 'node:async_hooks'

// src/adapter/bun/serve-static.ts:2-3
import { stat } from 'node:fs/promises'
import { join } from 'node:path'

// src/adapter/lambda-edge/handler.ts:1
import crypto from 'node:crypto'
```

コアモジュール（`src/hono-base.ts`, `src/context.ts`, `src/router/` 等）は Web Standards API（`Request`, `Response`, `URL`, `crypto.subtle` 等）のみに依存し、一切の外部パッケージを import しない。これにより Cloudflare Workers, Deno, Bun, Node.js, Fastly, AWS Lambda, Service Worker の全環境で動作する。

### マルチエントリーポイント管理（75 exports）

`package.json` の `exports` フィールドは 75 エントリーを持ち、各エントリーが CJS/ESM/型定義の 3 パスを提供する。

```json
// package.json:38-42
".": {
  "types": "./dist/types/index.d.ts",
  "import": "./dist/index.js",
  "require": "./dist/cjs/index.js"
}
```

`typesVersions` フィールド（71 エントリー）は、`exports` 未対応の古い TypeScript バージョン向けの型解決フォールバックとして機能する。

### package.json と jsr.json の exports 同期バリデーション

ビルド時に `package.json` と `jsr.json` の exports を双方向で検証する仕組みが組み込まれている。

```typescript
// build/build.ts:28-31
const [packageJsonExports, jsrJsonExports] = ['./package.json', './jsr.json'].map(readJsonExports)

validateExports(packageJsonExports, jsrJsonExports, 'jsr.json')
validateExports(jsrJsonExports, packageJsonExports, 'package.json')
```

`validateExports` はワイルドカードパターン（`./utils/*`）の展開も考慮し、一方に存在して他方に存在しないエントリーがあればビルドを即座に失敗させる。

```typescript
// build/validate-exports.ts:1-37
export const validateExports = (
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  fileName: string
) => {
  const isEntryInTarget = (entry: string): boolean => {
    if (entry in target) {
      return true
    }
    const wildcardPrefix = entry.replace(/\/\*$/, '')
    if (entry.endsWith('/*')) {
      return Object.keys(target).some(
        (targetEntry) =>
          targetEntry.startsWith(wildcardPrefix + '/') && targetEntry !== wildcardPrefix
      )
    }
    // ... 省略: 階層的なワイルドカードマッチング
    return false
  }

  Object.keys(source).forEach((sourceEntry) => {
    if (!isEntryInTarget(sourceEntry)) {
      throw new Error(`Missing "${sourceEntry}" in '${fileName}'`)
    }
  })
}
```

### CJS/ESM デュアルビルドの仕組み

esbuild によるカスタムビルドスクリプトが CJS と ESM の両方を同時に生成する。

```typescript
// build/build.ts:75-89
const cjsConfig: BuildOptions = {
  ...commonOptions,
  outbase: './src',
  outdir: './dist/cjs',
  format: 'cjs',
}

const esmConfig: BuildOptions = {
  ...commonOptions,
  bundle: true,
  outbase: './src',
  outdir: './dist',
  format: 'esm',
  plugins: [addExtension('.js')],
}
```

CJS ディレクトリには `package.cjs.json`（`{"type": "commonjs"}`）が配置され、Node.js のモジュール解決が正しく動作する。

```typescript
// build/build.ts:100-106
await Promise.all([
  runBuild(esmConfig),
  runBuild(cjsConfig),
  $`tsc ${isWatch ? '-w' : ''} --emitDeclarationOnly --declaration --project tsconfig.build.json`.nothrow(),
])
```

型定義は `tsc --emitDeclarationOnly` で生成され、ビルド後に `oxc-parser` を使って `#private` フィールドを除去するポストプロセスが走る。

### ツールバージョンの一元管理

`.tool-versions` ファイルで Node.js, Bun, Deno のバージョンを一元管理し、CI の全ジョブが同じファイルを参照する。

```
// .tool-versions
nodejs 24.7.0
bun  1.2.19
deno 2.4.5
```

```yaml
# .github/workflows/ci.yml:43-44
- uses: oven-sh/setup-bun@v2
  with:
    bun-version-file: '.tool-versions'
```

### npm / JSR デュアルレジストリ公開

npm 公開は `np` パッケージ経由で行い、prerelease スクリプトで Deno テストとビルドを事前実行する。

```json
// package.json:33-34
"prerelease": "bun test:deno && bun run build",
"release": "np",
```

JSR 公開は Git タグの push をトリガーとして `deno run -A jsr:@david/publish-on-tag` で自動実行される。

```yaml
# .github/workflows/release.yml:23-25
- run: deno install --no-lock --allow-scripts
- name: Publish to JSR
  run: deno run -A jsr:@david/publish-on-tag@0.1.4
```

JSR 向けの `jsr.json` は TypeScript ソースを直接エクスポートし、ビルド成果物ではなくソースコードを配布する。

```json
// jsr.json:107-110
"publish": {
  "include": ["jsr.json", "LICENSE", "README.md", "src/**/*.ts"],
  "exclude": ["src/**/*.test.ts", "src/**/*.test.tsx"]
}
```

### PR プレビュー公開（pkg-pr-new）

`cr.yml` ワークフローで `pkg-pr-new` を使い、PR ごとにパッケージのプレビュー版を StackBlitz に公開する。`cr-tracked` ラベルが付いた PR で自動実行される。

```yaml
# .github/workflows/cr.yml:38-39
- name: Publish to StackBlitz
  run: bun pkg-pr-new publish --compact
```

### パッケージ品質バリデーション

`publint` がビルド後に自動実行（`postbuild` スクリプト）され、パッケージの公開前バリデーションを行う。exports の整合性、型定義の存在確認、CJS/ESM の互換性チェックなどが含まれる。

```json
// package.json:30
"postbuild": "publint",
```

### バンドルサイズ・型チェックのパフォーマンス計測

CI で `octocov` を使い、バンドルサイズと型チェック時間（tsc / typescript-go 両方）を PR ごとに計測・比較する。

```typescript
// perf-measures/bundle-check/scripts/check-bundle-size.ts:11-18
await esbuild.build({
  entryPoints: ['dist/index.js'],
  bundle: true,
  minify: true,
  format: 'esm' as esbuild.Format,
  target: 'es2022',
  outfile: tempFilePath,
})
```

## コード例

### Preset パターンによるバンドルサイズ制御

ユーザーが必要なルーター実装だけを選択できるよう、preset パターンで tree-shaking を促進する。

```typescript
// src/preset/tiny.ts:6-20
import { HonoBase } from '../hono-base'
import { PatternRouter } from '../router/pattern-router'

export class Hono<...> extends HonoBase<E, S, BasePath> {
  constructor(options: HonoOptions<E> = {}) {
    super(options)
    this.router = new PatternRouter()
  }
}
```

```typescript
// src/hono.ts:1-34 (デフォルト — フルサイズ)
import { RegExpRouter } from './router/reg-exp-router'
import { SmartRouter } from './router/smart-router'
import { TrieRouter } from './router/trie-router'

export class Hono<...> extends HonoBase<E, S, BasePath> {
  constructor(options: HonoOptions<E> = {}) {
    super(options)
    this.router = options.router ?? new SmartRouter({
      routers: [new RegExpRouter(), new TrieRouter()],
    })
  }
}
```

`hono` と `hono/tiny` で異なるルーター構成を読み込むことで、ユーザーのバンドルサイズ要件に応じた選択を可能にしている。

### ランタイム検出によるアダプタパターン

外部依存なしにランタイムを検出する仕組み。

```typescript
// src/helper/adapter/index.ts:50-84
export const getRuntimeKey = (): Runtime => {
  const global = globalThis as any

  const userAgentSupported =
    typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'

  if (userAgentSupported) {
    for (const [runtimeKey, userAgent] of Object.entries(knownUserAgents)) {
      if (checkUserAgentEquals(userAgent)) {
        return runtimeKey as Runtime
      }
    }
  }

  if (typeof global?.EdgeRuntime === 'string') {
    return 'edge-light'
  }

  if (global?.fastly !== undefined) {
    return 'fastly'
  }

  if (global?.process?.release?.name === 'node') {
    return 'node'
  }

  return 'other'
}
```

## Good Patterns

- **ゼロランタイム依存ポリシー**: `dependencies` を持たないことで、依存チェーンの深さ問題、バージョン競合、セキュリティ脆弱性のカスケードを完全に排除している。Web Standards API への依存は全ランタイムで安定しており、破壊的変更のリスクが極めて低い。

- **Exports 双方向バリデーション**: `validateExports()` で `package.json` と `jsr.json` の exports を相互検証し、一方の更新忘れをビルド段階で検出する。97 + 75 エントリーの手動同期は人間には不可能であり、自動化が必須。

```typescript
// build/build.ts:30-31
validateExports(packageJsonExports, jsrJsonExports, 'jsr.json')
validateExports(jsrJsonExports, packageJsonExports, 'package.json')
```

- **frozen-lockfile の徹底**: CI の全ジョブ（11 箇所）で `bun install --frozen-lockfile` を使用し、ロックファイルと `package.json` の不一致を即座に検出する。開発者のローカル環境とCI環境の依存バージョン差異を防止。

- **publint による公開前バリデーション**: `postbuild` フックで `publint` を自動実行し、exports の不整合、型定義の欠落、CJS/ESM の互換性問題をビルド直後に検出する。

```json
// package.json:30
"postbuild": "publint",
```

- **PR プレビュー公開（pkg-pr-new）**: PR の変更内容を実際にインストールして動作確認できる仕組みを提供。`npm link` のような不安定な方法に頼らず、利用者が変更前にテストできる。

## Anti-Patterns / 注意点

- **大規模な package.json の保守負荷**: 691 行に及ぶ `package.json` は `exports`（75 エントリー）と `typesVersions`（71 エントリー）の重複記述が大部分を占める。新しいモジュールを追加するたびに 3 箇所（`exports`, `typesVersions`, `jsr.json`）を手動で更新する必要がある。

```json
// Bad: 同じエントリーが 3 箇所に散在
// package.json exports
"./cookie": { "types": "...", "import": "...", "require": "..." }
// package.json typesVersions
"cookie": ["./dist/types/helper/cookie"]
// jsr.json exports
"./cookie": "./src/helper/cookie/index.ts"
```

```typescript
// Better: ビルドスクリプトで package.json を自動生成
// build/generate-exports.ts (提案)
const entries = glob.sync('./src/**/index.ts')
const exports = generateExportsFromEntries(entries)
writeFileSync('package.json', JSON.stringify({ ...base, exports }))
```

ただし Hono は `validateExports()` でこの問題を緩和しており、完全に放置しているわけではない。

- **devDependencies のバージョン固定が不統一**: 一部は `^`（セマンティックレンジ）、一部はピン止め（`"eslint": "9.39.1"`, `"jsdom": "22.1.0"`）と混在している。意図的な選択かもしれないが、方針が明文化されていない。

```json
// package.json:658-685 (抜粋)
"eslint": "9.39.1",           // ピン止め
"vitest": "^3.2.4",           // セマンティックレンジ
"wrangler": "4.12.0",         // ピン止め
"typescript": "^5.9.2",       // セマンティックレンジ
```

## 自分のプロジェクトへの適用

- [ ] ランタイム依存を最小化する設計を検討する。特にライブラリ開発時は、Web Standards API で代替可能な機能に外部パッケージを使っていないか棚卸しする
- [ ] マルチレジストリ公開（npm + JSR）を行う場合は、exports の双方向バリデーションスクリプトを導入する
- [ ] CI の全ジョブで `--frozen-lockfile`（または `--ci`）を徹底し、ロックファイルの不整合を即座に検出する仕組みを作る
- [ ] `publint` をビルドパイプラインに組み込み、パッケージ公開前のバリデーションを自動化する
- [ ] `.tool-versions` でランタイムバージョンを一元管理し、CI と開発環境の乖離を防止する
- [ ] `pkg-pr-new` を導入して PR ごとのプレビュー公開を可能にし、利用者からのフィードバックループを短縮する
