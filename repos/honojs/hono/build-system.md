# Build System

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono のビルドシステムは、Bun で実行される esbuild ベースのカスタムビルドスクリプトを中心に構成される。75 のエクスポートエントリーポイントを持つ大規模パッケージを ESM + CJS デュアルフォーマットで出力し、npm と JSR（Deno レジストリ）の両方に公開する。ビルド時にエクスポート定義の整合性検証、`.d.ts` からのプライベートフィールド除去、publint によるパッケージバリデーションを自動実行するなど、パッケージ品質を担保する仕組みが注目に値する。

## 設計・実装の詳細

### ビルドパイプラインの全体像

ビルドは `bun run build` で起動され、以下の順序で実行される。

1. `rm -rf dist` — 前回の成果物を削除
2. `bun ./build/build.ts` — esbuild による ESM/CJS ビルド + tsc による型定義生成
3. `cp ./package.cjs.json ./dist/cjs/package.json` — CJS ディレクトリに `{"type": "commonjs"}` を配置
4. `publint` — postbuild フックでパッケージの正当性を検証

ステップ 2 の内部では ESM ビルド、CJS ビルド、tsc の 3 タスクが `Promise.all` で並列実行される。tsc 完了後にはプライベートフィールドの除去が走る。

```
build/build.ts:100-110
await Promise.all([
  runBuild(esmConfig),
  runBuild(cjsConfig),
  $`tsc ${
    isWatch ? '-w' : ''
  } --emitDeclarationOnly --declaration --project tsconfig.build.json`.nothrow(),
])

// Remove #private fields
const dtsEntries = glob.globSync('./dist/types/**/*.d.ts')
await removePrivateFields(dtsEntries)
```

### ESM と CJS のデュアル出力戦略

ESM と CJS で異なるビルド戦略を採用している点が特徴的である。

**ESM ビルド** (`dist/`): `bundle: true` を設定し、各エントリーポイントの依存をバンドルする。ただし `addExtension` プラグインで全インポートを `external: true` にマークするため、実質的にはバンドルされない。このプラグインの真の目的は TypeScript の拡張子なしインポートに `.js` 拡張子を付与することにある。

**CJS ビルド** (`dist/cjs/`): `bundle` オプションなし（デフォルト `false`）で、単純なトランスパイルのみを行う。

```
build/build.ts:75-89
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

### addExtension プラグイン: ESM インポートパス解決

ESM では Node.js の `import` 文に明示的な `.js` 拡張子が必要になるケースがある。TypeScript ソースでは拡張子なし (`./router`) でインポートしているため、ビルド時に `.js` を付与する esbuild プラグインが組み込まれている。

ファイル解決のロジックは 2 段階:
1. `{path}.ts` が存在すれば `{path}.js` に変換
2. `{path}/index.ts` が存在すれば `{path}/index.js` に変換

すべてのインポートを `external: true` でマークすることで、バンドル対象から除外しつつパス書き換えのみを実現している。

```
build/build.ts:42-67
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

### CJS 互換性の実現: package.cjs.json パターン

Node.js は `package.json` の `"type": "module"` フィールドでモジュールシステムを判定する。Hono のルート `package.json` は `"type": "module"` であるため、`dist/cjs/` 内の `.js` ファイルもデフォルトでは ESM と解釈されてしまう。

この問題を解決するため、`dist/cjs/package.json` と `dist/types/package.json` に `{"type": "commonjs"}` のみを記述した `package.cjs.json` をコピーする。これにより `dist/cjs/` 配下のファイルは CJS として正しく解釈される。

```
package.cjs.json
{
  "type": "commonjs"
}
```

```
package.json (scripts)
"copy:package.cjs.json": "cp ./package.cjs.json ./dist/cjs/package.json && cp ./package.cjs.json ./dist/types/package.json"
```

### エントリーポイントの自動検出とフィルタリング

ビルド対象は `src/**/*.ts` の glob パターンで自動検出される。テストファイル、Deno 専用モジュール、集約エクスポートファイル (`mod.ts`, `middleware.ts`) は除外される。

```
build/build.ts:34-36
const entryPoints = glob.sync('./src/**/*.ts', {
  ignore: ['./src/**/*.test.ts', './src/mod.ts', './src/middleware.ts', './src/deno/**/*.ts'],
})
```

`tsconfig.build.json` でも同じ除外パターンが定義されており、JavaScript 出力と型定義出力の整合性が保たれている。

```
tsconfig.build.json:14-22
"exclude": [
  "src/mod.ts",
  "src/helper.ts",
  "src/middleware.ts",
  "src/deno/**/*.ts",
  "src/test-utils/*.ts",
  "src/**/*.test.ts",
  "src/**/*.test.tsx",
]
```

### エクスポート整合性の自動検証

`package.json` と `jsr.json` のエクスポート定義が相互に一致するかをビルド時に検証する。片方にあるエントリーポイントがもう片方に存在しない場合、エラーをスローしてビルドを中断する。ワイルドカードパターン (`./utils/*`) の展開にも対応している。

```
build/build.ts:28-31
const [packageJsonExports, jsrJsonExports] = ['./package.json', './jsr.json'].map(readJsonExports)

// Validate exports of package.json and jsr.json
validateExports(packageJsonExports, jsrJsonExports, 'jsr.json')
validateExports(jsrJsonExports, packageJsonExports, 'package.json')
```

```
build/validate-exports.ts:1-37
export const validateExports = (
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  fileName: string
) => {
  const isEntryInTarget = (entry: string): boolean => {
    if (entry in target) {
      return true
    }

    // e.g., "./utils/*" -> "./utils"
    const wildcardPrefix = entry.replace(/\/\*$/, '')
    if (entry.endsWith('/*')) {
      return Object.keys(target).some(
        (targetEntry) =>
          targetEntry.startsWith(wildcardPrefix + '/') && targetEntry !== wildcardPrefix
      )
    }

    const separatedEntry = entry.split('/')
    while (separatedEntry.length > 0) {
      const pattern = `${separatedEntry.join('/')}/*`
      if (pattern in target) {
        return true
      }
      separatedEntry.pop()
    }

    return false
  }

  Object.keys(source).forEach((sourceEntry) => {
    if (!isEntryInTarget(sourceEntry)) {
      throw new Error(`Missing "${sourceEntry}" in '${fileName}'`)
    }
  })
}
```

### 型定義の後処理: プライベートフィールド除去

TypeScript の `#private` フィールドは `.d.ts` 宣言ファイルにも出力される。これは公開 API として不要であり、パッケージサイズの増大やユーザーの混乱を招くため、`oxc-parser` を使って AST レベルで除去する。

```
build/remove-private-fields.ts:27-53
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

除去処理はスペースで置換する方式で、ソースマップへの影響を最小限に抑えている。

### デュアルレジストリ公開: npm + JSR

npm 公開は `np` ツール経由で行われ、`prerelease` スクリプトで Deno テスト + ビルドが前提条件として実行される。

```
package.json (scripts)
"prerelease": "bun test:deno && bun run build",
"release": "np",
```

JSR 公開は GitHub Actions のタグプッシュトリガーで自動実行される。JSR は TypeScript ソースを直接公開できるため、ビルド成果物ではなく `src/` をそのまま配布する。

```
jsr.json:107-110
"publish": {
  "include": ["jsr.json", "LICENSE", "README.md", "src/**/*.ts"],
  "exclude": ["src/**/*.test.ts", "src/**/*.test.tsx"]
}
```

### CI でのバンドルサイズ監視

PR ごとにバンドルサイズを計測し、octocov でトラッキングする仕組みがある。esbuild で `dist/index.js` を minify バンドルし、そのファイルサイズを JSON メトリクスとして出力する。

```
perf-measures/bundle-check/scripts/check-bundle-size.ts:11-18
await esbuild.build({
  entryPoints: ['dist/index.js'],
  bundle: true,
  minify: true,
  format: 'esm' as esbuild.Format,
  target: 'es2022',
  outfile: tempFilePath,
})
```

### PR プレビュー公開: pkg-pr-new

`cr.yml` ワークフローにより、`cr-tracked` ラベルが付いた PR や main ブランチへのプッシュ時に `pkg-pr-new` 経由で StackBlitz にプレビューパッケージが公開される。これによりリリース前に実際のパッケージインストールを試行できる。

## Good Patterns

- **3 タスク並列ビルド**: ESM トランスパイル、CJS トランスパイル、型定義生成を `Promise.all` で並列実行することで、ビルド時間を大幅に短縮している。各タスクが独立しているため安全に並列化できる設計になっている。

```
build/build.ts:100-106
await Promise.all([
  runBuild(esmConfig),
  runBuild(cjsConfig),
  $`tsc ${
    isWatch ? '-w' : ''
  } --emitDeclarationOnly --declaration --project tsconfig.build.json`.nothrow(),
])
```

- **エクスポート整合性の双方向検証**: `package.json` と `jsr.json` のエクスポートを相互に検証することで、一方にエントリーポイントを追加してもう一方を忘れるミスを防止している。ワイルドカードの展開ロジックも含め、堅牢な検証になっている。

```
build/build.ts:30-31
validateExports(packageJsonExports, jsrJsonExports, 'jsr.json')
validateExports(jsrJsonExports, packageJsonExports, 'package.json')
```

- **postbuild での publint 実行**: `npm publish` のパッケージ構造の正当性を publint で自動チェックする。`exports` のパスが実際に存在するか、条件付きエクスポートの優先順位が正しいかなどを検証できる。

```
package.json
"postbuild": "publint",
```

- **package.cjs.json によるモジュールシステム制御**: ルートの `"type": "module"` と CJS サブディレクトリの `"type": "commonjs"` を `package.json` の階層構造で制御する。`.cjs` 拡張子を使わずに CJS 互換を実現するシンプルなアプローチ。

- **ビルドスクリプト自体のテスト**: `validate-exports` と `remove-private-fields` にはユニットテストが存在し、ビルドツール自体の信頼性を担保している。

```
build/validate-exports.test.ts:25-30
describe('validateExports', () => {
  it('Works', async () => {
    expect(() => validateExports(mockExports1, mockExports1, 'package.json')).not.toThrowError()
    expect(() => validateExports(mockExports1, mockExports2, 'jsr.json')).not.toThrowError()
    expect(() => validateExports(mockExports1, mockExports3, 'package.json')).toThrowError()
  })
})
```

## Anti-Patterns / 注意点

- **ESM ビルドでの bundle + external パターンの複雑さ**: ESM 設定で `bundle: true` を有効にしつつ、`addExtension` プラグインで全インポートを `external` にマークするのは、実質的にバンドルを行わない設定である。この間接的なアプローチは初見で意図を理解しにくい。

```
// Bad: bundle: true だが実質バンドルしない（わかりにくい）
const esmConfig: BuildOptions = {
  ...commonOptions,
  bundle: true,
  plugins: [addExtension('.js')],  // 全て external にする
}
```

```
// Better: esbuild にインポートパス書き換え専用の仕組みがない制約があるため、
// コメントで意図を明記する
const esmConfig: BuildOptions = {
  ...commonOptions,
  // bundle: true is required for the addExtension plugin to intercept imports.
  // All imports are marked as external, so no actual bundling occurs.
  // The real purpose is to add .js extensions to import paths for ESM compatibility.
  bundle: true,
  plugins: [addExtension('.js')],
}
```

- **tsc の `.nothrow()` による型エラーのサイレント無視**: tsc が `nothrow()` 付きで実行されているため、型エラーがあってもビルドが成功してしまう。CI の `test` スクリプトで `tsc --noEmit` を別途実行しているため実害はないが、ビルドスクリプト単体では型安全性が保証されない。

```
// 注意: nothrow() により型エラーがあってもビルドは通る
$`tsc ${isWatch ? '-w' : ''} --emitDeclarationOnly --declaration --project tsconfig.build.json`.nothrow()
```

## 自分のプロジェクトへの適用

- [ ] ESM + CJS デュアル出力が必要なライブラリで、`package.cjs.json` パターンを導入してサブディレクトリ単位でモジュールシステムを制御する
- [ ] 複数レジストリ（npm + JSR）に公開するライブラリで、エクスポート定義の双方向検証ロジックをビルドスクリプトに組み込む
- [ ] `publint` を postbuild フックに追加して、パッケージの exports / types / main 設定の正当性を自動検証する
- [ ] esbuild + tsc の並列実行パターン（esbuild で JS 出力、tsc で型定義のみ出力）を採用してビルド時間を短縮する
- [ ] ビルドスクリプト自体にユニットテストを書き、特にエクスポート検証やコード変換ロジックの正しさを担保する
- [ ] PR ごとのバンドルサイズ計測を CI に組み込み、パフォーマンスリグレッションを検知する
