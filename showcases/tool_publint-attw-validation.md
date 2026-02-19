# Tool: publint & attw Validation

> 出典: [repos/TanStack/query](../repos/TanStack/query/), [repos/ryoppippi/ccusage](../repos/ryoppippi/ccusage/), [repos/honojs/hono](../repos/honojs/hono/)
> カテゴリ: tool

## 概要

publint と @arethetypeswrong/cli (attw) は、npm パッケージ公開前に `package.json` の `exports`/`main`/`types` フィールドとビルド成果物の整合性を機械的に検証するツールである。publint はパッケージ構造の妥当性を、attw は TypeScript 型定義が各モジュール解決方式（ESM/CJS、bundler/node16 等）で正しく解決されるかを検証する。「ビルドは通るが `import` で壊れる」という人間のレビューでは見落としやすい問題を自動検出するために、CI パイプラインに組み込む。

## 背景・文脈

CJS/ESM デュアル配布が標準化された現在、`package.json` の `exports` フィールドの設定ミスは消費者側で原因特定が困難なエラーを引き起こす。特に以下のような状況で問題が顕在化する:

- **大量のサブパスエクスポート**: honojs/hono は 60 以上のエクスポートエントリを持ち、1 つでも設定漏れがあれば消費者の `import` が壊れる
- **モノレポの多パッケージ公開**: TanStack/query は 22 以上のパッケージを公開しており、全パッケージの exports 整合性を手動で管理するのは現実的でない
- **TypeScript の `moduleResolution` の多様性**: `node16`, `bundler`, `nodenext` など消費者側の設定によって型解決の挙動が異なり、開発者の環境では問題なくても消費者の環境で壊れることがある

これらの問題に対し、3 つのリポジトリはそれぞれ異なるアプローチで publint / attw を統合している:

| リポジトリ        | 統合方式                     | 特徴                                                                                         |
| ----------------- | ---------------------------- | -------------------------------------------------------------------------------------------- |
| TanStack/query    | `test:build` スクリプト + Nx | ビルド後に `publint --strict && attw --pack` を実行。Nx の `dependsOn: ["build"]` で順序保証 |
| ryoppippi/ccusage | tsdown ビルド設定に直接統合  | `publint: true` をビルドツールのオプションとして組み込み、ビルド時点で検証                   |
| honojs/hono       | `postbuild` npm フック       | `"postbuild": "publint"` でビルド完了時に自動実行                                            |

## 実装パターン

### パターン 1: package.json scripts での直列実行（TanStack/query）

最も汎用的なパターン。publint と attw を `&&` で直列実行し、どちらか一方でも失敗すればスクリプト全体が失敗する。

```json
// packages/query-core/package.json:33
"test:build": "publint --strict && attw --pack"
```

`--strict` フラグにより、publint は警告レベルの問題もエラーとして扱う。`--pack` フラグにより、attw は `npm pack` 相当の処理を行い、実際に公開されるファイルのみを検証対象とする。

Nx のタスク依存関係で、ビルド完了後に自動実行される:

```json
// nx.json:73-77
"test:build": {
  "cache": true,
  "dependsOn": ["build"],
  "inputs": ["production"]
}
```

### パターン 2: ビルドツールへの直接統合（ryoppippi/ccusage）

tsdown（esbuild/rolldown ベースのバンドラー）は publint をビルトイン機能として提供しており、ビルド設定に `publint: true` を追加するだけで有効化できる。

```typescript
// apps/ccusage/tsdown.config.ts:1-16
import { defineConfig } from "tsdown";
import Macros from "unplugin-macros/rolldown";

export default defineConfig({
  entry: [
    "./src/*.ts",
    "!./src/**/*.test.ts",
    "!./src/_*.ts",
  ],
  outDir: "dist",
  format: "esm",
  clean: true,
  sourcemap: false,
  minify: "dce-only",
  treeshake: true,
  publint: true,
  unused: true,
  // ...
});
```

CI やリリースフローとは独立してビルド時点で品質ゲートを通すため、ローカル開発でも即座にフィードバックが得られる。

### パターン 3: npm ライフサイクルフックでの自動実行（honojs/hono）

`postbuild` フックを利用し、`npm run build` の完了後に自動的に publint が実行される。開発者が検証ステップを意識する必要がない。

```json
// package.json:29-30
"build": "bun run ./build/build.ts",
"postbuild": "publint"
```

### GitHub Actions CI への組み込み

TanStack/query では、PR ワークフローで `nx affected` を使い、変更影響範囲のパッケージのみ `test:build` を実行する:

```json
// package.json:13
"test:pr": "nx affected --targets=test:sherif,test:knip,test:docs,test:eslint,test:lib,test:types,test:build,build"
```

リリースブランチでは `nx run-many` で全パッケージを検証する:

```json
// package.json:14
"test:ci": "nx run-many --targets=test:sherif,test:knip,test:docs,test:eslint,test:lib,test:types,test:build,build"
```

## Good Example

### publint + attw の組み合わせで CJS/ESM デュアル配布を検証する

```json
// package.json
{
  "name": "my-library",
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "scripts": {
    "build": "tsup src/index.ts --format esm,cjs --dts",
    "test:build": "publint --strict && attw --pack",
    "postbuild": "npm run test:build"
  },
  "devDependencies": {
    "publint": "^0.3.0",
    "@arethetypeswrong/cli": "^0.18.0"
  }
}
```

publint が検証する内容:

- `exports` フィールドで指定したファイルが実際に存在するか
- `types` フィールドが正しい `.d.ts` ファイルを指しているか
- `main`/`module` フォールバックフィールドの整合性
- `"type": "module"` と拡張子の一貫性

attw が検証する内容:

- ESM (`import`) での型解決が `node16`/`bundler` の両方で成功するか
- CJS (`require`) での型解決が正しいか
- `exports` の各エントリが全モジュール解決方式で正しく解決されるか

### Nx/Turborepo でビルド依存関係を定義する

```json
// nx.json（または turbo.json 相当）
{
  "targetDefaults": {
    "test:build": {
      "cache": true,
      "dependsOn": ["build"],
      "inputs": ["production"]
    }
  }
}
```

`dependsOn: ["build"]` により、ビルド成果物が存在しない状態で publint/attw が実行されることを防ぐ。`inputs: ["production"]` により、テストファイルやドキュメントの変更ではキャッシュが無効化されない。

## Bad Example

### ビルド後の検証なしで公開する

```json
// Bad: publint/attw なしでビルドと公開を直結
{
  "scripts": {
    "build": "tsup src/index.ts --format esm,cjs --dts",
    "prepublishOnly": "npm run build"
  }
}
// -> exports フィールドのパス誤りや型定義の不整合が
//    npm publish 後に消費者側で初めて発覚する
```

### exports フィールドに types 条件を含めない

```json
// Bad: types 条件が欠落
{
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "types": "./dist/index.d.ts"
}
// -> attw がエラーを検出: moduleResolution: "node16" で
//    型定義が正しく解決されない
```

```json
// Good: 各エントリに types 条件を含める
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  }
}
```

### CJS/ESM で異なる型定義ファイルが必要な場合を考慮しない

```json
// Bad: CJS と ESM で同一の .d.ts を指定（CJS 消費者で型エラーになりうる）
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  }
}
// -> attw の "FalseCJS" エラー: .d.ts が ESM として解釈され、
//    CJS の require() で型が合わない
```

```json
// Good: CJS/ESM それぞれに対応する型定義を指定
{
  "exports": {
    ".": {
      "import": {
        "types": "./dist/index.d.ts",
        "default": "./dist/index.js"
      },
      "require": {
        "types": "./dist/index.d.cts",
        "default": "./dist/index.cjs"
      }
    }
  }
}
```

TanStack/query はこの構造を全 22 パッケージで徹底している:

```json
// packages/query-core/package.json:42-54
"exports": {
  ".": {
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

## 適用ガイド

### どのような状況で使うべきか

- **npm にパッケージを公開するすべてのプロジェクト**: publint は最低限導入すべき。exports フィールドの設定ミスは公開後まで気づきにくい
- **CJS/ESM デュアル配布を行うプロジェクト**: attw を追加で導入し、型定義の解決が全モジュール解決方式で正しいことを保証する
- **モノレポで複数パッケージを公開するプロジェクト**: CI に組み込み、全パッケージを自動検証する。TanStack/query のように `test:build` スクリプトを統一し、タスクランナーで一括実行する

### 導入手順

1. devDependencies に追加:

```bash
npm install -D publint @arethetypeswrong/cli
```

2. package.json に検証スクリプトを追加:

```json
{
  "scripts": {
    "test:build": "publint --strict && attw --pack"
  }
}
```

3. CI ワークフローでビルド後に実行:

```yaml
# .github/workflows/ci.yml
jobs:
  build:
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npm run build
      - run: npm run test:build
```

### よくある検出エラーと修正方法

| エラー                | ツール  | 原因                                      | 修正方法                                               |
| --------------------- | ------- | ----------------------------------------- | ------------------------------------------------------ |
| `FILE_DOES_NOT_EXIST` | publint | exports で指定したパスにファイルがない    | ビルド出力先と exports のパスを一致させる              |
| `TYPES_NOT_EXPORTED`  | publint | exports に types 条件がない               | 各エントリに `"types"` を追加する                      |
| `FalseCJS`            | attw    | .d.ts が ESM として解釈され CJS と不整合  | `.d.cts` を生成し CJS 用 types を分離する              |
| `FalseESM`            | attw    | .d.cts が CJS として解釈され ESM と不整合 | `.d.ts` を ESM 用に、`.d.cts` を CJS 用に分ける        |
| `Missing`             | attw    | 特定の解決方式で型が見つからない          | `typesVersions` または exports の types 条件を追加する |
| `Wildcard`            | attw    | ワイルドカードエクスポートの型解決失敗    | 個別のエントリに展開するか、型定義のパスを修正する     |

### カスタマイズポイント

- **`publint --strict`**: 警告もエラーとして扱う。新規プロジェクトでは最初から strict を推奨。既存プロジェクトでは段階的に移行する
- **`attw --pack`**: `npm pack` 相当の処理で実際に公開されるファイルのみを検証する。`--pack` なしの場合はローカルファイルを直接検証する
- **tsdown の `publint: true`**: ビルドツールに統合する場合。attw の統合はまだ一般的ではないため、attw は別途スクリプトで実行する
- **`postbuild` フック**: 小規模プロジェクトではビルド完了時の自動実行が便利。モノレポではタスクランナーの依存関係定義の方が適切

## 参考

- [repos/TanStack/query/build-and-tooling.md](../repos/TanStack/query/build-and-tooling.md) -- publint + attw + size-limit の多層品質ゲート
- [repos/TanStack/query/ci-cd.md](../repos/TanStack/query/ci-cd.md) -- Nx による CI パイプラインへの統合
- [repos/ryoppippi/ccusage/build-and-tooling.md](../repos/ryoppippi/ccusage/build-and-tooling.md) -- tsdown ビルド設定への publint 直接統合
- [repos/honojs/hono/build-and-tooling.md](../repos/honojs/hono/build-and-tooling.md) -- postbuild フックでの publint 自動実行
- [repos/honojs/hono/dependency-management.md](../repos/honojs/hono/dependency-management.md) -- ゼロ依存パッケージの品質保証
