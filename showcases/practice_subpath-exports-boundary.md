# Practice: Subpath Exports Boundary

> 出典: [repos/ryoppippi/ccusage](../repos/ryoppippi/ccusage/), [repos/mastra-ai/mastra](../repos/mastra-ai/mastra/), [repos/open-circle/valibot](../repos/open-circle/valibot/)
> カテゴリ: practice

## 概要

`package.json` の `exports` フィールドでサブパスを明示的に列挙し、パッケージの API 境界を制御するプラクティス。`exports` に含まれないモジュールは Node.js のモジュール解決でアクセス不可になるため、内部実装の隠蔽とパブリック API の定義を `package.json` 一箇所で宣言的に管理できる。3 つのリポジトリが規模も用途も異なるアプローチでこのプラクティスを実践しており、それぞれの設計判断から汎用的な適用パターンを抽出する。

## 背景・文脈

TypeScript/JavaScript パッケージには言語レベルのアクセス修飾子（Java の `package-private` 相当）がない。`export` されたシンボルは、ファイルパスさえ分かれば誰でもインポートできてしまう。これにより「内部実装を直接参照するユーザーコード」が生まれ、ライブラリのリファクタリングが破壊的変更になる問題が起きる。

Node.js 12.7+ で導入された `package.json` の `exports` フィールド（Package Entry Points）は、この問題を解決する。`exports` に列挙されたサブパスのみがパッケージ外から解決可能になり、それ以外のモジュールへの直接アクセスは `ERR_PACKAGE_PATH_NOT_EXPORTED` エラーでブロックされる。

3 つのリポジトリでの適用:

- **ccusage** (CLI ツール): 公開モジュールを個別に列挙し、`_` プレフィックスの内部ファイルをビルドとエクスポートの両方から除外。`publishConfig` による開発時/公開時の二重エクスポート戦略。
- **mastra** (大規模モノレポ): 20 以上のサブパスをワイルドカード `./*` + 個別パスの二段構えで定義。E2E テストで全エクスポートのファイル存在を自動検証。
- **valibot** (ライブラリ): 条件付きエクスポート（`import`/`require`）で ESM+CJS デュアル配信し、`types` を `default` より前に配置して型解決を保証。

## 実装パターン

### 1. 公開モジュールの明示的列挙（ccusage）

公開 API となるモジュールを `exports` に個別列挙し、`_` プレフィックスの内部ファイルはエントリに含めない。tsdown の `entry` 設定でも `!./src/_*.ts` で内部ファイルを除外し、ビルド成果物にも含めない二重のガードを敷く。

```jsonc
// apps/ccusage/package.json:19-43
"exports": {
    ".": "./src/index.ts",
    "./calculate-cost": "./src/calculate-cost.ts",
    "./data-loader": "./src/data-loader.ts",
    "./debug": "./src/debug.ts",
    "./logger": "./src/logger.ts",
    "./package.json": "./package.json"
}
// _date-utils.ts, _pricing-fetcher.ts, _macro.ts は exports に含まれない
// -> パッケージ外から import しようとすると ERR_PACKAGE_PATH_NOT_EXPORTED
```

```typescript
// apps/ccusage/tsdown.config.ts:6-9
entry: [
  "./src/*.ts",
  "!./src/**/*.test.ts",  // テストファイルを除外
  "!./src/_*.ts",          // _ プレフィックスの内部ファイルを除外
],
```

### 2. ワイルドカード + 例外パスの二段構え（mastra）

`"./*"` ワイルドカードで `dist/*/index.js` にマッピングし、ディレクトリ構造に従わない特殊なエントリは個別に定義する。メインエントリ `"."` は最小限（`Mastra` と `Config` のみ）に保ち、利用者は `@mastra/core/agent`, `@mastra/core/storage` のようにサブパスで必要なモジュールだけをインポートする。

```jsonc
// packages/core/package.json:13-33 (抜粋)
"exports": {
  ".": {
    "import": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
  },
  "./*": {
    "import": { "types": "./dist/*/index.d.ts", "default": "./dist/*/index.js" }
  },
  "./tools/is-vercel-tool": {
    "import": { "types": "./dist/tools/is-vercel-tool.d.ts", "default": "./dist/tools/is-vercel-tool.js" }
  }
}
```

```typescript
// packages/core/src/index.ts:1
// メインエントリは最小限
export { type Config, Mastra } from "./mastra";
```

### 3. 条件付きエクスポートで ESM/CJS + 型定義を分離（valibot）

`import`/`require` 条件で ESM と CJS のエントリポイントを分け、それぞれに対応する型定義ファイルを `types` キーで指定する。`types` を `default` より前に配置することで、TypeScript が正しい型定義を優先的に解決する。

```json
// library/package.json:25-36
"exports": {
  ".": {
    "import": {
      "types": "./dist/index.d.mts",
      "default": "./dist/index.mjs"
    },
    "require": {
      "types": "./dist/index.d.cts",
      "default": "./dist/index.cjs"
    }
  }
}
```

### 4. publishConfig による開発時/公開時の切り替え（ccusage）

開発時は TypeScript ソースを直接参照し、npm publish 時に `publishConfig` でビルド成果物に差し替える。TypeScript をそのまま実行できる開発体験と、最適化されたバンドルの配布を `package.json` 一つで両立する。

```jsonc
// apps/ccusage/package.json:18-48
"exports": {
    ".": "./src/index.ts"           // 開発時: TypeScript ソース直接
},
"publishConfig": {
    "exports": {
        ".": "./dist/index.js",     // 公開時: バンドル済み JS
        "./calculate-cost": "./dist/calculate-cost.js",
        "./data-loader": "./dist/data-loader.js",
        "./debug": "./dist/debug.js",
        "./logger": "./dist/logger.js",
        "./package.json": "./package.json"
    }
}
```

### 5. exports の自動検証（mastra）

全パッケージの `exports` フィールドを E2E テストで走査し、宣言されたファイルが `dist/` に実在するかを自動検証する。exports の追加・削除時の不整合を publish 前に機械的に検出する。

```typescript
// e2e-tests/pkg-outputs/bundle.test.ts:27-57
it('should have type="module"', () => {
  expect(pkgJson.type).toBe("module");
});

it("should use .js and .d.ts extensions when using import", async () => {
  const exportConfig = pkgJson.exports[importPath] as any;
  expect(exportConfig.import).toBeDefined();
  expect(extname(exportConfig.import.default)).toMatch(/\.js$/);
  expect(exportConfig.import.types).toMatch(/\.d\.ts$/);
  const pathsOnDisk = await globby(join(__dirname, "..", pkgName, fileOutput[0]));
  for (const pathOnDisk of pathsOnDisk) {
    await expect(stat(pathOnDisk)).resolves.toBeDefined();
  }
});
```

## Good Example

**サブパスの明示的列挙 + 内部ファイルの除外 + publint による検証:**

```jsonc
// package.json
{
  "name": "my-library",
  "type": "module",
  "exports": {
    ".": {
      "import": {
        "types": "./dist/index.d.mts",
        "default": "./dist/index.mjs",
      },
      "require": {
        "types": "./dist/index.d.cts",
        "default": "./dist/index.cjs",
      },
    },
    "./utils": {
      "import": {
        "types": "./dist/utils.d.mts",
        "default": "./dist/utils.mjs",
      },
    },
    "./package.json": "./package.json",
  },
  "sideEffects": false,
}
// 内部モジュール（helpers, internals）は exports に含めない
// -> import { foo } from "my-library/internals/helper" は解決不可
```

```typescript
// tsdown.config.ts — publint でエクスポート設定の整合性を自動検証
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "./src/index.ts",
    "./src/utils.ts",
    "!./src/_*.ts", // _ プレフィックスの内部ファイルを除外
    "!./src/**/*.test.ts",
  ],
  format: ["es", "cjs"],
  dts: true,
  publint: true, // ビルド時に exports/types/main の不整合を検出
  unused: true, // 未使用エクスポートを検出
});
```

## Bad Example

**exports なしで main/types のみ指定（内部モジュールが全公開される）:**

```jsonc
// Bad: exports フィールドがない — dist/ 配下の全ファイルにアクセス可能
{
  "name": "my-library",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
}
// ユーザーが import { helper } from "my-library/dist/internals/helper" できてしまう
// ライブラリ側が内部構造を変えると破壊的変更になる
```

**_ プレフィックスで内部を示唆しつつ exports で公開してしまう:**

```jsonc
// Bad: "_" で内部を示唆しつつ exports でアクセス可能にしている
"exports": {
  ".": { "import": { "default": "./dist/index.js" } },
  "./agent": { "import": { "default": "./dist/agent/index.js" } },
  "./workflows/_constants": { "import": { "default": "./dist/workflows/constants.js" } }
}
// "_constants" は命名上は内部だが、exports に含まれているため誰でもインポートできる
// 名前と実態の乖離がユーザーの混乱を招く
```

**types を default の後に配置してしまう:**

```jsonc
// Bad: types が default の後 — TypeScript が型定義を正しく解決できない場合がある
"exports": {
  ".": {
    "import": {
      "default": "./dist/index.mjs",
      "types": "./dist/index.d.mts"
    }
  }
}
```

```jsonc
// Better: types を default より前に配置
"exports": {
  ".": {
    "import": {
      "types": "./dist/index.d.mts",
      "default": "./dist/index.mjs"
    }
  }
}
```

## 適用ガイド

### どのような状況で使うべきか

- **npm/JSR に公開するライブラリ・ツール**: 内部実装の変更が破壊的変更にならないよう、API 境界を明示したい場合
- **サブパスインポートを提供する中〜大規模パッケージ**: `@scope/pkg/feature` のようなモジュール分割を提供しつつ、内部ディレクトリへのアクセスを防ぎたい場合
- **ESM + CJS デュアル配信が必要なライブラリ**: 条件付きエクスポートで `import`/`require` を分けて型定義も適切に提供したい場合
- **モノレポ内パッケージの API 契約を明確にしたい場合**: ワークスペース内でもパッケージ間の依存を公開 API に限定できる

### 導入時の注意点

- **`types` は `default` より前に配置する**: TypeScript は `exports` の条件を上から順に評価するため、`types` が後に来ると型解決に失敗する場合がある。publint や attw（Are the Types Wrong?）でこの順序を検証できる
- **publint / attw で exports 設定を検証する**: `exports` の定義ミス（存在しないファイルの参照、拡張子の不一致、条件の欠落）はランタイムまで気づきにくい。tsdown の `publint: true` 設定、または CI での `npx publint` / `npx @arethetypeswrong/cli` 実行で自動検出する
- **ワイルドカード `./*` は便利だが内部を露出しうる**: `"./*": "./dist/*/index.js"` は `dist/` 配下の全サブディレクトリを公開する。内部モジュールが `dist/` に含まれていると意図せず公開されるため、ビルド設定で内部ファイルを除外するか、個別にサブパスを列挙する方が安全
- **`publishConfig.exports` の書き忘れに注意**: 開発時に `.ts` を指す `exports` を設定し、`publishConfig` でのオーバーライドを忘れると、ソースの `.ts` ファイルがそのまま publish される

### カスタマイズポイント

- **サブパスの粒度**: mastra のように機能カテゴリ単位（`/agent`, `/storage`, `/voice`）にするか、ccusage のようにファイル単位（`/calculate-cost`, `/logger`）にするかは、パッケージの規模と利用パターンに依存する
- **ワイルドカード vs 個別列挙**: パッケージが小規模（サブパス 5 個以下）なら個別列挙が安全。大規模（20 個以上）ならワイルドカード + 内部ファイルのビルド除外が現実的
- **ESM only vs Dual**: 新規ライブラリで CJS サポートが不要なら `import` 条件のみで十分。既存エコシステムとの互換が必要なら valibot のように `import`/`require` 両方を提供する
- **`./package.json` サブパス**: バンドラやツールが `package.json` を直接読む場合があるため、`"./package.json": "./package.json"` を含めておくと互換性が向上する

## 参考

- [repos/ryoppippi/ccusage/build-and-tooling.md](../repos/ryoppippi/ccusage/build-and-tooling.md) -- publishConfig による二重エクスポート戦略
- [repos/ryoppippi/ccusage/dependency-management.md](../repos/ryoppippi/ccusage/dependency-management.md) -- devDependencies Only 戦略と exports の連携
- [repos/mastra-ai/mastra/code-organization.md](../repos/mastra-ai/mastra/code-organization.md) -- サブパスエクスポートとメインエントリの極小化
- [repos/mastra-ai/mastra/build-and-tooling.md](../repos/mastra-ai/mastra/build-and-tooling.md) -- exports の E2E 自動検証
- [repos/open-circle/valibot/build-and-tooling.md](../repos/open-circle/valibot/build-and-tooling.md) -- 条件付きエクスポートと ESM+CJS デュアル出力
- [repos/open-circle/valibot/dependency-management.md](../repos/open-circle/valibot/dependency-management.md) -- sideEffects と exports の正確な設定
