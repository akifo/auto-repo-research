# Build and Tooling

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

マルチランタイム対応の Web フレームワークが、単一の TypeScript ソースから ESM / CJS / 型定義の 3 成果物を並行生成し、npm と JSR の 2 レジストリに矛盾なく公開するビルドパイプラインを分析する。60 以上のサブパスエクスポートを持ちながら、ビルドスクリプトは約 110 行に収まっている点が注目に値する。さらに CI で型チェック速度・バンドルサイズ・HTTP スループットの 3 指標を PR ごとに自動計測し、パフォーマンスリグレッションを検知する仕組みを構築している。

## 背景にある原則

- **単一ソース・複数出力（Single Source of Truth for Builds）**: ソースコードは `src/` に 1 つだけ存在し、ESM (`dist/`)・CJS (`dist/cjs/`)・型定義 (`dist/types/`) は全て同一ソースから自動生成される。手書きの CJS ファイルや個別の型定義ファイルを持たないことで、フォーマット間の不整合を構造的に排除する。根拠: `build/build.ts:100-106` で ESM・CJS・tsc を `Promise.all` で並行実行している。

- **エクスポートマップの相互検証（Cross-Validation of Export Maps）**: 複数のレジストリ（npm・JSR）に公開する場合、エクスポート定義の漏れは消費者の import エラーに直結する。ビルド時に `package.json` と `jsr.json` のエクスポート定義を双方向に検証し、片方にしか存在しないエントリがあればビルドを失敗させることで、公開前に齟齬を検出する。根拠: `build/build.ts:31` で `validateExports` を双方向に呼び出している。

- **公開成果物の機械的検証（Automated Publish Validation）**: `publint` を `postbuild` フックで自動実行し、`package.json` の `exports` フィールド・`types` 指定・ファイル存在の整合性を検証する。手動レビューに頼らず、ビルドパイプラインの一部として公開品質を担保する。根拠: `package.json:30` の `"postbuild": "publint"`。

- **パフォーマンスバジェットの自動化（Automated Performance Budgets）**: バンドルサイズ・型チェック速度・HTTP スループットを CI で毎 PR 計測し、ベースラインとの差分を自動コメントする。数値が悪化した場合に merge 前に気づける仕組みを構築することで、「気づいたら遅くなっていた」を防止する。根拠: `.github/actions/perf-measures/action.yml` で octocov を使った差分レポートを生成している。

## 実例と分析

### ESM/CJS デュアル出力の設計

ルートの `package.json` は `"type": "module"` を宣言し、プロジェクト全体を ESM として扱う。CJS 出力を有効にするために、`dist/cjs/` ディレクトリに `package.cjs.json`（内容は `{"type": "commonjs"}` のみ）をコピーする手法を採用している。この 1 ファイルのコピーだけで Node.js のモジュール解決が CJS として動作する。

```jsonc
// package.cjs.json (全内容)
{
  "type": "commonjs"
}
```

ESM ビルドでは esbuild の `bundle: true` + カスタム `addExtension` プラグインを使い、内部 import に `.js` 拡張子を付与する。CJS ビルドではバンドルせずそのまま出力する。この非対称な設定により、ESM 側はモジュール解決の問題を回避しつつ、CJS 側はファイル構造を保持する。

### エクスポートマップの 3 層構造

各エクスポートは `types` / `import` / `require` の 3 条件を持つトリプレット構造で定義されている。

```jsonc
// package.json exports（1エントリの例）
"./cors": {
  "types": "./dist/types/middleware/cors/index.d.ts",
  "import": "./dist/middleware/cors/index.js",
  "require": "./dist/cjs/middleware/cors/index.js"
}
```

60 以上のエントリが同一パターンに従い、パス構造も `src/` のディレクトリ構造と 1:1 対応する。`typesVersions` フィールドも同時に定義し、古い TypeScript バージョンでの型解決もサポートしている（`package.json:414-629`）。

### ビルド時の型定義後処理

TypeScript の `#private` フィールドは `.d.ts` ファイルに `#private;` として出力される。これを消費者に露出させないため、`oxc-parser` で AST を解析し、`PrivateIdentifier` を持つ `PropertyDefinition` をスペースで置換する後処理を行う（`build/remove-private-fields.ts:27-53`）。文字列置換ではなく AST ベースの変換を採用し、位置がずれないよう `removeRange` でスペース埋めする点が堅牢な実装である。

### tsconfig の分離戦略

`tsconfig.json`（開発・テスト用）と `tsconfig.build.json`（ビルド用）を分離し、ビルド時のみ `noUnusedLocals` / `noUnusedParameters` を有効化する。テスト中は未使用変数を許容して開発体験を損なわず、ビルド成果物には厳格なチェックを適用する。

```jsonc
// tsconfig.build.json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "module": "ES2020",
    "rootDir": "./src/",
    "outDir": "./dist/types/",
    "noUnusedLocals": true,
    "noUnusedParameters": true
  },
  "exclude": [
    "src/mod.ts",
    "src/**/*.test.ts",
    "src/**/*.test.tsx"
  ]
}
```

### マルチランタイムテスト戦略

Vitest の `projects` 機能で複数のランタイム環境を統合管理している。`vitest.config.ts` で `main`・`jsx-runtime-default`・`jsx-runtime-dom` の 3 プロジェクトを定義し、`runtime-tests/*/vitest.config.ts` を外部プロジェクトとして取り込む。各ランタイム（Node.js・workerd・Fastly・Lambda）は独自の vitest 設定を持ち、環境固有のプラグイン（例: `vite-plugin-fastly-js-compute`）を適用する。

CI では更に Deno（`deno test`）と Bun（`bun test`）をネイティブテストランナーで実行し、計 7 ランタイムをカバーする（`ci.yml:34-179`）。

### pkg-pr-new による PR プレビュー

`cr.yml` で `pkg-pr-new` を使い、PR ごとにパッケージを StackBlitz にプレビュー公開する。消費者が merge 前に変更を試せる仕組みで、ラベル `cr-tracked` が付いた PR または main ブランチへのプッシュ時にのみ実行される。

### パフォーマンス計測の 3 軸

CI で以下 3 軸を自動計測している:

1. **バンドルサイズ**: esbuild で minify ビルドし、バイト数を記録（`perf-measures/bundle-check/scripts/check-bundle-size.ts`）
2. **型チェック速度**: `tsc --diagnostics` と `tsgo --diagnostics` の両方を計測（`action.yml:20-33`）。TypeScript Go コンパイラとの比較まで含めている
3. **HTTP スループット**: `bombardier` で 3 エンドポイントを負荷テストし、baseline と target の req/sec を比較（`benchmarks/http-server/benchmark.ts`）

## コード例

```typescript
// build/build.ts:42-67 — ESM import パスに .js 拡張子を付与するプラグイン
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

```typescript
// build/build.ts:100-106 — ESM/CJS/型定義の並行ビルド
await Promise.all([
  runBuild(esmConfig),
  runBuild(cjsConfig),
  $`tsc ${
    isWatch ? '-w' : ''
  } --emitDeclarationOnly --declaration --project tsconfig.build.json`.nothrow(),
])
```

```typescript
// build/validate-exports.ts:1-37 — package.json と jsr.json のエクスポート相互検証
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
    // ... wildcard pattern matching
    return false
  }

  Object.keys(source).forEach((sourceEntry) => {
    if (!isEntryInTarget(sourceEntry)) {
      throw new Error(`Missing "${sourceEntry}" in '${fileName}'`)
    }
  })
}
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 同一クラスから異なるルーターアルゴリズムを選択可能にする
  - 適用条件: プリセット（`tiny`/`quick`/default）ごとに異なるルーター組み合わせを注入
  - コード例: `src/preset/tiny.ts:11-20`、`src/preset/quick.ts:13-24`、`src/hono.ts:16-34`
  - 注意点: ビルド観点では、各プリセットが独立したエクスポートエントリとなり、ツリーシェイキングで不要なルーターを除外できる

- **Builder パターン** (分類: 生成)
  - 解決する問題: ビルド設定の共通部分と個別部分を分離し、設定の重複を排除する
  - 適用条件: `commonOptions` を基底として ESM / CJS 設定をスプレッド構文で拡張
  - コード例: `build/build.ts:69-89`
  - 注意点: esbuild の `BuildOptions` 型がスプレッド構文と相性が良いため成立する

## Good Patterns

- **CJS ディレクトリに `package.json` を配置する Dual Package 手法**: ルートを `"type": "module"` としつつ、CJS 出力先に `{"type": "commonjs"}` の `package.json` を配置するだけで Node.js のモジュール解決が正しく動作する。条件付きエクスポートと組み合わせることで、ESM/CJS の両方の消費者をサポートできる。

```jsonc
// package.json (ルート)
{ "type": "module" }

// dist/cjs/package.json (ビルド時コピー)
{ "type": "commonjs" }

// package.json scripts
"copy:package.cjs.json": "cp ./package.cjs.json ./dist/cjs/package.json && cp ./package.cjs.json ./dist/types/package.json"
```

- **ビルドスクリプト自体にテストを書く**: `build/validate-exports.test.ts` と `build/remove-private-fields.test.ts` が存在し、ビルドロジック自体の正しさを検証している。ビルドツールのバグは全成果物に波及するため、ビルドスクリプトをテスト対象として扱うことで信頼性を確保する。

```typescript
// build/validate-exports.test.ts:25-31
describe('validateExports', () => {
  it('Works', async () => {
    expect(() => validateExports(mockExports1, mockExports1, 'package.json')).not.toThrowError()
    expect(() => validateExports(mockExports1, mockExports2, 'jsr.json')).not.toThrowError()
    expect(() => validateExports(mockExports1, mockExports3, 'package.json')).toThrowError()
  })
})
```

- **`.tool-versions` による全ランタイムのバージョン固定**: Node.js・Bun・Deno の 3 ランタイムのバージョンを `.tool-versions` に一元管理し、CI の `setup-*` アクションから `bun-version-file` / `node-version-file` / `deno-version-file` で参照する。バージョン情報の散在を防ぎ、更新箇所を 1 ファイルに集約する。

```yaml
# .tool-versions
nodejs 24.7.0
bun  1.2.19
deno 2.4.5
```

## Anti-Patterns / 注意点

- **型チェック付き ESLint ルールの全面無効化**: `eslint.config.mjs` で `@typescript-eslint` の型情報を使うルールを 40 以上 `off` にしている。型チェック付き ESLint は大規模プロジェクトで速度低下を招くが、全面無効化は型安全性の検証を linter から失う。段階的に必要なルールのみ有効化する方がバランスが良い。

```typescript
// eslint.config.mjs:4-68（抜粋）
const typeCheckedRules = {
  '@typescript-eslint/await-thenable': 'off',
  '@typescript-eslint/no-floating-promises': 'off',
  '@typescript-eslint/no-misused-promises': 'off',
  // ... 40+ rules disabled
}
```

Better: パフォーマンスが許容できるなら、安全性に直結するルール（`no-floating-promises`、`no-misused-promises`、`await-thenable`）だけは有効にする。

- **エクスポートマップの手動同期**: `package.json` の `exports` と `typesVersions` は手動で同期する必要がある。60 以上のエントリがあるため、追加・削除時に片方を忘れるリスクがある。`validateExports` は `package.json` vs `jsr.json` の検証のみで、`typesVersions` との整合性は検証していない。

Better: `typesVersions` を `exports` から自動生成するスクリプトを追加するか、`moduleResolution: "bundler"` を消費者が使うことを前提に `typesVersions` を段階的に廃止する。

## 導出ルール

- `[MUST]` ESM/CJS デュアル出力時、各エクスポートエントリに `types` / `import` / `require` の 3 条件を全て定義する
  - 根拠: honojs/hono は 60 以上のエントリ全てで 3 条件トリプレットを徹底しており、`publint` でビルドごとに整合性を機械検証している（`package.json:38-412`）

- `[MUST]` ビルドパイプラインに公開前検証ステップ（`publint` 等）を組み込み、`exports` フィールドと実ファイルの整合性を機械的にチェックする
  - 根拠: `postbuild` フックで `publint` を自動実行し、ビルド成功＝公開可能を保証している（`package.json:30`）

- `[SHOULD]` 複数レジストリ（npm / JSR 等）に公開する場合、ビルド時にエクスポート定義を相互検証して片方だけに存在するエントリを検出する
  - 根拠: `build/build.ts:31` で `validateExports` を双方向に呼び出し、`package.json` と `jsr.json` の不整合をビルド失敗として検出している

- `[SHOULD]` ビルドスクリプト自体にユニットテストを書き、ビルドロジックの正しさをテストスイートで保証する
  - 根拠: `build/validate-exports.test.ts` と `build/remove-private-fields.test.ts` でビルドツールの振る舞いを検証している

- `[SHOULD]` CI でバンドルサイズ・型チェック速度を PR ごとに計測し、ベースラインとの差分をレポートする
  - 根拠: `.github/actions/perf-measures/action.yml` で esbuild minify 後のサイズと `tsc --diagnostics` の結果を octocov で差分追跡している

- `[SHOULD]` 開発用とビルド用の tsconfig を分離し、ビルド時のみ `noUnusedLocals` / `noUnusedParameters` を有効化する
  - 根拠: `tsconfig.build.json` が `tsconfig.json` を extends して厳格オプションを追加し、テストファイルを exclude している

- `[AVOID]` ESM パッケージで CJS 出力が必要な場合に、ファイルごとに拡張子を `.cjs` に変更する方法を採用する。代わりにサブディレクトリに `{"type": "commonjs"}` の `package.json` を配置する
  - 根拠: honojs/hono は `dist/cjs/package.json` に 3 行の JSON を置くだけで CJS 解決を実現しており、拡張子の変換ロジックが不要（`package.cjs.json`）

- `[AVOID]` 大量のサブパスエクスポートを手動で管理する。エントリポイントの追加・削除時にビルド検証なしで公開すると、消費者の import が壊れる
  - 根拠: `validateExports` による相互検証が存在しなければ、60 以上のエントリのうち 1 つでも漏れがあれば import エラーになる

## 適用チェックリスト

- [ ] `package.json` の `exports` フィールドで全サブパスに `types` / `import` / `require` の 3 条件を定義しているか
- [ ] `postbuild` または CI で `publint`（または `arethetypeswrong`）を実行し、公開前にエクスポートの整合性を検証しているか
- [ ] ESM/CJS デュアル出力の場合、CJS 出力先ディレクトリに `{"type": "commonjs"}` の `package.json` を配置しているか
- [ ] 複数レジストリに公開する場合、エクスポート定義の相互検証スクリプトが存在するか
- [ ] ビルドスクリプトにカスタムロジック（AST 変換・エクスポート検証等）がある場合、そのロジックにテストが書かれているか
- [ ] tsconfig を開発用とビルド用に分離し、ビルド時のみ厳格チェックを有効化しているか
- [ ] CI でバンドルサイズを PR ごとに計測し、リグレッションを検知する仕組みがあるか
- [ ] マルチランタイム対応の場合、各ランタイムのバージョンを `.tool-versions` 等で一元管理しているか
