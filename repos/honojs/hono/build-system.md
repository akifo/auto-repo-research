# build-system

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono のビルドシステムは、Bun をタスクランナー、esbuild をトランスパイラ、tsc を型定義生成器とし、ESM/CJS デュアル出力と JSR 対応を実現するカスタムパイプラインである。70 以上のエクスポートエントリポイントを持つモノリシックパッケージでありながら、バンドラレスの esbuild + `addExtension` プラグインという軽量な仕組みで一貫した出力を生成している。`package.json` と `jsr.json` のエクスポート整合性をビルド時にバリデーションする自動検証や、`.d.ts` から `#private` フィールドを AST ベースで除去する後処理など、パッケージ品質を自動保証する仕組みが注目に値する。

## 設計思想

- **ツールごとの責務分離**: esbuild は JS トランスパイル専任、tsc は型定義（`.d.ts`）生成専任、publint はパッケージバリデーション専任と、各ツールの得意分野だけを使う。esbuild に型チェックや型生成を任せず、tsc にバンドルを任せない。この分離により、esbuild の高速トランスパイルと tsc の正確な型情報を両立させている（`build/build.ts:100-106`）。

- **ソースコードは拡張子なし、ビルドが解決する**: ソースコード（`src/`）のインポートパスに `.ts` や `.js` 拡張子を付けず、esbuild プラグイン `addExtension` がビルド時に `.js` 拡張子を付与する。Deno/JSR は `unstable: ["sloppy-imports"]` で拡張子なしインポートを許容する。これにより、ソースコードをランタイム・ビルドツールの都合から独立させている（`build/build.ts:42-67`, `jsr.json:8`）。

- **パッケージ品質の自動保証**: ビルドスクリプト内で `validateExports` により `package.json` と `jsr.json` のエクスポート整合性をクロスチェックし、`postbuild` で publint によるパッケージ規約検証を行う。手動の目視確認ではなく、ビルドパイプラインに品質ゲートを組み込むことで、70 以上のエクスポートがあっても不整合を防止している（`build/build.ts:29-31`, `package.json:30`）。

- **CJS 互換は最小限の仕組みで実現する**: `package.cjs.json`（`{"type": "commonjs"}` のみの 3 行ファイル）を `dist/cjs/` にコピーするだけで CJS 判定を成立させる。ルートの `package.json` は `"type": "module"` であり、`dist/cjs/` 配下に `package.json` を置くことで Node.js のモジュール解決規則を利用して CJS/ESM を切り替えている（`package.cjs.json`, `package.json:29`）。

## 設計・実装の詳細

### ビルドパイプラインの全体構成

ビルドは 3 つの並列タスクで構成されている。

```
bun run build
  ├── rm -rf dist                        # クリーンビルド
  ├── bun ./build/build.ts               # メインビルド
  │   ├── validateExports()              # package.json <-> jsr.json 整合性チェック
  │   ├── Promise.all([                  # 3 タスク並列実行
  │   │   esbuild (ESM → dist/)          #   ESM 出力
  │   │   esbuild (CJS → dist/cjs/)      #   CJS 出力
  │   │   tsc (→ dist/types/)            #   型定義出力
  │   │ ])
  │   └── removePrivateFields()          # .d.ts から #private 除去
  ├── cp package.cjs.json dist/cjs/      # CJS 判定用 package.json 配置
  │   cp package.cjs.json dist/types/    # 型定義も CJS 解決用
  └── publint                            # postbuild: パッケージ検証
```

ESM ビルド・CJS ビルド・型定義生成は `Promise.all` で並列実行され、ビルド速度を最大化している。

### エントリポイントの収集戦略

```typescript
// build/build.ts:34-36
const entryPoints = glob.sync('./src/**/*.ts', {
  ignore: ['./src/**/*.test.ts', './src/mod.ts', './src/middleware.ts', './src/deno/**/*.ts'],
})
```

`src/` 配下の全 `.ts` ファイルをエントリポイントとして収集し、テストファイル・Deno 専用ファイル・集約モジュール（`mod.ts`, `middleware.ts`）を除外する。個々のエントリポイントを列挙するのではなく glob で自動収集することで、新しいモジュールの追加時にビルド設定の変更が不要になる。

### addExtension プラグインの仕組み

```typescript
// build/build.ts:42-67
const addExtension = (extension: string = '.js', fileExtension: string = '.ts'): Plugin => ({
  name: 'add-extension',
  setup(build: PluginBuild) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (args.importer) {
        const p = path.join(args.resolveDir, args.path)
        let tsPath = `${p}${fileExtension}`

        let importPath = ''
        if (fs.existsSync(tsPath)) {
          importPath = args.path + extension
        } else {
          tsPath = path.join(args.resolveDir, args.path, `index${fileExtension}`)
          if (fs.existsSync(tsPath)) {
            if (args.path.endsWith('/')) {
              importPath = `${args.path}index${extension}`
            } else {
              importPath = `${args.path}/index${extension}`
            }
          }
        }
        return { path: importPath, external: true }
      }
    })
  },
})
```

ESM ビルドでのみ使用される。全インポートを `external: true` として扱い、拡張子なしの `./foo` を `./foo.js` に、`./bar/` を `./bar/index.js` に解決する。これにより ESM 出力はバンドルされずファイル単位のまま出力されるが、Node.js ESM が要求する明示的な `.js` 拡張子がビルド時に自動付与される。

CJS ビルドはこのプラグインを使わず、`bundle: true` も設定しないため、esbuild のデフォルト動作で CJS に変換される。

### ESM/CJS デュアル出力のディレクトリ戦略

```
dist/
├── index.js              # ESM (ルート package.json の "type": "module" に従う)
├── middleware/
│   └── cors/index.js     # ESM
├── cjs/
│   ├── package.json      # {"type": "commonjs"} ← package.cjs.json のコピー
│   ├── index.js           # CJS
│   └── middleware/
│       └── cors/index.js  # CJS
└── types/
    ├── package.json       # {"type": "commonjs"} ← 同上
    ├── index.d.ts
    └── middleware/
        └── cors/index.d.ts
```

`package.json` の `exports` フィールドで条件付きエクスポートを定義する。

```json
// package.json:38-42
".": {
  "types": "./dist/types/index.d.ts",
  "import": "./dist/index.js",
  "require": "./dist/cjs/index.js"
}
```

`types` を最初に記述することで、TypeScript がまず型定義を解決できるようにしている。

### #private フィールドの AST ベース除去

```typescript
// build/remove-private-fields.ts:27-53
export function removePrivateFieldFromSourceCode(ast: ParseResult, sourceCode: string) {
  const removals: PropertyDefinition[] = []
  new Visitor({
    ClassDeclaration: (node) => {
      node.body.body.forEach((elem) => {
        if (elem.type === 'PropertyDefinition' && elem.key.type === 'PrivateIdentifier') {
          removals.push(elem)
        }
      })
    },
  }).visit(ast.program)

  if (removals.length === 0) {
    return
  }

  let sourceCodeWithoutPrivateFields = sourceCode
  for (const elem of removals) {
    sourceCodeWithoutPrivateFields = removeRange(
      sourceCodeWithoutPrivateFields,
      elem.start,
      elem.end
    )
  }

  return sourceCodeWithoutPrivateFields
}
```

tsc が `.d.ts` に出力する `#private;` フィールドは TypeScript の private class fields に対応するものだが、パッケージ利用者にとっては不要なノイズとなる。oxc-parser（Rust ベースの高速 AST パーサ）を使い、`#private;` を空白文字で置換することで、ソースマップの位置情報を壊さずにクリーンな型定義を生成している。

### package.json と jsr.json のエクスポート整合性バリデーション

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
    // ワイルドカードパターン ("./utils/*") のマッチング
    const wildcardPrefix = entry.replace(/\/\*$/, '')
    if (entry.endsWith('/*')) {
      return Object.keys(target).some(
        (targetEntry) =>
          targetEntry.startsWith(wildcardPrefix + '/') && targetEntry !== wildcardPrefix
      )
    }
    // ...
  }
  Object.keys(source).forEach((sourceEntry) => {
    if (!isEntryInTarget(sourceEntry)) {
      throw new Error(`Missing "${sourceEntry}" in '${fileName}'`)
    }
  })
}
```

双方向バリデーション: `package.json` のエクスポートが `jsr.json` にも存在するか、その逆も検証する。ワイルドカードパターン（`./utils/*`）にも対応しており、npm と JSR で異なるパターン展開方式を吸収している。これにより、片方にエントリを追加して他方を忘れるミスをビルド時に検出できる。

### JSR 対応の戦略

```json
// jsr.json
{
  "name": "@hono/hono",
  "version": "0.0.0",
  "compilerOptions": {
    "lib": ["dom", "dom.iterable", "deno.ns"]
  },
  "unstable": ["sloppy-imports"],
  "exports": {
    ".": "./src/index.ts",
    "./request": "./src/request.ts",
    ...
  }
}
```

JSR はソース TypeScript を直接パブリッシュするため、`exports` は `./src/*.ts` を直接指す。`version` は `"0.0.0"` としてあり、実際のバージョンは `deno run -A jsr:@david/publish-on-tag` がタグから決定する（`release.yml:24`）。`sloppy-imports` を有効にすることで、拡張子なしインポートを Deno/JSR 環境でも許容している。

### CI でのビルド品質チェック

CI パイプライン（`.github/workflows/ci.yml`）では以下のビルド関連検証が行われる:

1. **ビルド成功の確認**: `bun run build`（ESM/CJS 出力 + publint 検証）
2. **JSR dry-run**: `bunx jsr publish --dry-run` で JSR パブリッシュの事前検証
3. **バンドルサイズ計測**: esbuild で `dist/index.js` をミニファイバンドルし、サイズを octocov で追跡
4. **型チェック性能計測**: tsc と typescript-go の両方で型チェック性能を計測・比較
5. **pkg-pr-new**: PR ごとにパッケージを StackBlitz にプレビューパブリッシュ

### リリースフロー

```
prerelease: bun test:deno && bun run build
release: np (npm publish)
tags push → GitHub Actions → deno run -A jsr:@david/publish-on-tag (JSR publish)
```

npm と JSR への二重パブリッシュを、npm は `np`（対話式リリースツール）、JSR は Git タグトリガーの GitHub Actions でそれぞれ自動化している。

## コード例

### ESM/CJS 共通オプションとフォーマット分岐

```typescript
// build/build.ts:69-89
const commonOptions: BuildOptions = {
  entryPoints,
  logLevel: 'info',
  platform: 'node',
}

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

ESM ビルドのみ `bundle: true` と `addExtension` プラグインを使う点に注目。`bundle: true` は実際にはバンドルしないが（全インポートが `external: true` になるため）、esbuild のモジュール解決をトリガーするために必要である。

### 3 タスク並列実行

```typescript
// build/build.ts:100-106
await Promise.all([
  runBuild(esmConfig),
  runBuild(cjsConfig),
  $`tsc ${
    isWatch ? '-w' : ''
  } --emitDeclarationOnly --declaration --project tsconfig.build.json`.nothrow(),
])
```

Bun の Shell API（`$`）で tsc を実行し、`.nothrow()` で tsc の非ゼロ終了コードを無視する。これにより、型エラーがあってもビルド全体が中断しない（型チェックは別の `test` スクリプトで行う）。

### 条件付きエクスポートの定義パターン

```json
// package.json:38-42 (70+ エントリの一例)
".": {
  "types": "./dist/types/index.d.ts",
  "import": "./dist/index.js",
  "require": "./dist/cjs/index.js"
}
```

`types` → `import` → `require` の順序は Node.js の条件付きエクスポート解決の優先順位に従っている。

## パターンカタログ

- **Builder パターン** (分類: 生成)
  - 解決する問題: ESM/CJS/型定義の 3 種の出力を、共通設定をベースに差分だけ定義して生成する
  - 適用条件: 複数フォーマットの出力が必要で、設定の大部分が共通するとき
  - コード例: `build/build.ts:69-89`（`commonOptions` をスプレッドで拡張）
  - 注意点: 共通設定のオーバーライドが意図通りに動くか、スプレッド順序に注意

- **Visitor パターン** (分類: 振る舞い)
  - 解決する問題: AST を走査して特定のノード（`#private` フィールド）を検出・処理する
  - 適用条件: 構造化データ（AST、DOM 等）の走査と条件付き処理
  - コード例: `build/remove-private-fields.ts:29-37`（oxc-parser の Visitor API）
  - 注意点: 置換時にソースマップの位置情報を壊さないよう、空白文字で埋めている

## Good Patterns

- **glob ベースのエントリポイント自動収集**: `glob.sync('./src/**/*.ts', { ignore: [...] })` で新規モジュール追加時にビルド設定変更が不要。エントリポイントを手動列挙するとモジュール追加のたびに設定変更が必要になるが、glob + ignore パターンなら「除外すべきもの」だけ定義すれば良い。

```typescript
// build/build.ts:34-36
const entryPoints = glob.sync('./src/**/*.ts', {
  ignore: ['./src/**/*.test.ts', './src/mod.ts', './src/middleware.ts', './src/deno/**/*.ts'],
})
```

- **双方向エクスポートバリデーション**: `package.json` と `jsr.json` を相互にクロスチェックすることで、片方へのエントリ追加漏れをビルド時に自動検出する。単方向チェックでは片方だけに余分なエントリがあっても検出できないが、双方向にすることで完全な一致を保証する。

```typescript
// build/build.ts:29-31
validateExports(packageJsonExports, jsrJsonExports, 'jsr.json')
validateExports(jsrJsonExports, packageJsonExports, 'package.json')
```

- **package.cjs.json パターン**: 3 行のミニマルな JSON（`{"type": "commonjs"}`）を `dist/cjs/` にコピーするだけで、ルートの `"type": "module"` と競合せずに CJS サブディレクトリを成立させる。ビルドツール側で `.cjs` 拡張子に変換する方式より、Node.js のモジュール解決規則を直接利用するため透明性が高い。

```json
// package.cjs.json (全文)
{
  "type": "commonjs"
}
```

- **postbuild フックでの publint 検証**: ビルド直後に publint を自動実行し、`exports` の指すファイルが実在するか、条件付きエクスポートの構文が正しいかを検証する。CI だけでなくローカルビルドでも常に検証が走るため、パブリッシュ前に問題を発見できる。

```json
// package.json:30
"postbuild": "publint"
```

## Anti-Patterns / 注意点

- **エクスポートの手動同期**: `package.json` の `exports`、`typesVersions`、`jsr.json` の `exports` で 70 以上のエントリを手動管理している。`validateExports` で整合性は検証されるが、新しいモジュール追加時に 3 箇所を手動編集する必要がある。

```json
// Bad: 3 箇所に同じエントリを手動で追加する必要がある
// package.json exports:
"./cors": { "types": "...", "import": "...", "require": "..." }
// package.json typesVersions:
"cors": ["./dist/types/middleware/cors"]
// jsr.json exports:
"./cors": "./src/middleware/cors/index.ts"
```

```typescript
// Better: エクスポートマップを単一のソースから生成するスクリプト
// (Hono は validateExports で整合性を保証する方式を選択しているため、
//  これは「別のアプローチ」であり必ずしも優れているとは限らない)
const exports = generateExportsMap('./src')
writeJson('package.json', { ...pkg, exports: toNpmExports(exports) })
writeJson('jsr.json', { ...jsr, exports: toJsrExports(exports) })
```

- **tsc エラーの無視**: `$\`tsc ...\`.nothrow()` で tsc の終了コードを無視している。ビルドと型チェックの責務分離は合理的だが、型定義の生成自体が失敗しても気づかないリスクがある。CI で別途 `tsc --noEmit` を実行しているため実害は小さいが、ローカル開発では注意が必要。

## 導出ルール

> このセクションは必須。synthesis-writer が rules.md 生成時に参照する。

- `[MUST]` ESM/CJS デュアルパッケージでは `exports` フィールドに `types` → `import` → `require` の順序で条件を定義し、各条件が指すファイルの存在を publint 等で自動検証する
  - 根拠: Hono は 70 以上のエクスポートで `types` を最優先に配置し、`postbuild` で publint を実行してファイル参照の正当性を保証している（`package.json:30, 38-42`）

- `[MUST]` 複数のパッケージレジストリ（npm + JSR 等）にパブリッシュする場合、エクスポートマップの整合性をビルド時に自動検証する仕組みを設ける
  - 根拠: Hono は `validateExports` で `package.json` と `jsr.json` を双方向にクロスチェックし、エントリの追加漏れをビルド時に検出している（`build/build.ts:29-31`）

- `[SHOULD]` ビルドパイプラインではツールごとの責務を分離し、トランスパイル（esbuild）・型定義生成（tsc）・パッケージ検証（publint）を独立したステップとして並列実行する
  - 根拠: Hono は `Promise.all` で ESM ビルド・CJS ビルド・tsc を並列実行し、各ツールの得意分野だけを活用することでビルド速度と正確性を両立している（`build/build.ts:100-106`）

- `[SHOULD]` エントリポイントは glob パターンで自動収集し、除外リスト（テスト・内部モジュール）で制御する。手動列挙はモジュール追加時の設定変更漏れリスクがある
  - 根拠: Hono は `glob.sync('./src/**/*.ts', { ignore: [...] })` で全ソースファイルを自動収集し、新モジュール追加時のビルド設定変更を不要にしている（`build/build.ts:34-36`）

- `[SHOULD]` CJS 互換が必要な場合、ルートの `"type": "module"` と `dist/cjs/package.json` の `"type": "commonjs"` で Node.js のモジュール解決規則を利用し、`.cjs`/`.mjs` 拡張子変換を避ける
  - 根拠: Hono は 3 行の `package.cjs.json` をコピーするだけで CJS サブディレクトリを成立させ、ファイル拡張子を変更しない透明なデュアル出力を実現している（`package.cjs.json`, `package.json:29`）

- `[AVOID]` ソースコードのインポートパスにビルド出力用の拡張子（`.js`）をハードコードすること。ビルドツールのプラグインで拡張子を付与し、ソースコードをランタイムの都合から独立させる
  - 根拠: Hono は `addExtension` プラグインでビルド時に `.js` 拡張子を付与し、ソースコードは拡張子なしインポートのまま保っている（`build/build.ts:42-67`）

## 適用チェックリスト

- [ ] `package.json` に `"type": "module"` を設定し、ESM をデフォルトとしているか
- [ ] `exports` フィールドで `types` → `import` → `require` の順序を守っているか
- [ ] CJS 出力ディレクトリに `{"type": "commonjs"}` の `package.json` を配置しているか
- [ ] ビルド後に `publint` または同等のツールでパッケージ構造を自動検証しているか
- [ ] 複数レジストリ（npm, JSR 等）のエクスポートマップの整合性をビルド時に検証しているか
- [ ] エントリポイントを glob で自動収集し、除外リストで不要ファイルを排除しているか
- [ ] ソースコードのインポートパスにビルド出力用の拡張子をハードコードしていないか
- [ ] ESM ビルド・CJS ビルド・型定義生成を並列実行し、ビルド速度を最適化しているか
- [ ] `.d.ts` の不要な内部情報（`#private` 等）を後処理で除去しているか
- [ ] CI でバンドルサイズを計測し、リグレッションを検出できるようにしているか
