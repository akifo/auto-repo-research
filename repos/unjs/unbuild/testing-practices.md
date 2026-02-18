# testing-practices

> リポジトリ: unjs/unbuild
> 分析日: 2026-02-18

## 概要

unbuild のテスト設計を「fixture ベーステスト」と「ビルドツール特有のテスト戦略」の観点から分析した。unbuild はビルドツールでありながら、ビルド出力のエンドツーエンド検証を直接テストに含めず、純粋関数のユニットテストと CI パイプラインでの self-build + 実行による暗黙的統合テストという二層構造を採用している。fixture ディレクトリはビルドツール自身の全ビルダー（rollup, mkdist, untyped, copy）をカバーする「ミニチュアプロジェクト」として設計されており、テストコードと開発ワークフロー（`dev` スクリプト）の両方から参照される。

## 背景にある原則

- **テスト対象の層を分離する**: ビルドツールは「入力→出力変換」が主機能だが、変換ロジック全体をテストすると外部ツール（Rollup, esbuild）の挙動に依存してテストが脆くなる。unbuild は変換前の決定ロジック（エントリ推論・依存関係バリデーション・export 型推論）を純粋関数として抽出し、そこにユニットテストを集中させている。根拠: テストファイル 3 本すべてが `../src/auto`, `../src/utils`, `../src/validate` からの直接インポートでテストしている（`test/auto.test.ts:2`, `test/utils.test.ts:2-7`, `test/validate.test.ts:6`）。

- **fixture は「代表的な本物のプロジェクト」として構築する**: テスト fixture は最小限のモックではなく、実際のプロジェクト構造（`package.json`, `build.config.ts`, `src/`, `bin/`）を持つミニチュアプロジェクトとして構成する。これにより fixture が `dev` スクリプトのターゲットとしても再利用でき、手動検証と自動テストで同一のデータを共有できる。根拠: `package.json` の `"dev": "pnpm unbuild test/fixture"` が fixture を開発時のビルドターゲットとして使用している。

- **self-build をゲートキーパーにする**: ビルドツール自身を自分でビルドする（self-build / bootstrapping）ことで、ビルド機能の回帰を実行前に検出する。CI で `pnpm build`（self-build）を `vitest run` の前に配置することで、ビルドが壊れればテスト以前にパイプラインが失敗する。根拠: `.github/workflows/ci.yml:24-26` で `pnpm build` → `pnpm vitest run --coverage` の順序が強制されている。

- **テストの型安全性よりもテストの書きやすさを許容範囲内で優先する**: 複雑な内部型（`BuildContext` 等）の部分的なモック構築では `as any` を限定的に使用し、テストに必要な最小限のプロパティだけを渡す。根拠: `test/validate.test.ts:12` で `{ warnings: new Set() } as any`、`test/validate.test.ts:49` で `hooks: [] as any` を使用している。

## 実例と分析

### 純粋関数のユニットテスト設計

unbuild のテストは 3 ファイル・約 73 アサーションで構成され、すべてが副作用のない純粋関数をテスト対象としている。

`auto.test.ts` は `inferEntries` 関数をテストしている。この関数は `package.json` の内容とソースファイル一覧を受け取り、ビルドエントリを推論する。ファイルシステムアクセスを必要とせず、入力データのみで動作する。

```typescript
// test/auto.test.ts:5-16
describe("inferEntries", () => {
  it("recognises main and module outputs", () => {
    const result = inferEntries(
      { main: "dist/test.cjs", module: "dist/test.mjs" },
      ["src/", "src/test.ts"],
    );
    expect(result).to.deep.equal({
      cjs: true,
      dts: false,
      entries: [{ input: "src/test" }],
      warnings: [],
    });
  });
```

`utils.test.ts` は `inferExportType`, `extractExportFilenames`, `arrayIncludes`, `inferPkgExternals` の 4 つのユーティリティ関数をテストしている。すべて純粋関数であり、I/O を行わない。

```typescript
// test/utils.test.ts:9-22
describe("inferExportType", () => {
  it("infers export type by condition", () => {
    expect(inferExportType("import")).to.equal("esm");
    expect(inferExportType("require")).to.equal("cjs");
    expect(inferExportType("node")).to.equal("esm");
    expect(inferExportType("some_unknown_condition")).to.equal("esm");
  });
  it("infers export type based on previous conditions", () => {
    expect(inferExportType("import", ["require"])).to.equal("esm");
    expect(inferExportType("node", ["require"])).to.equal("cjs");
    expect(inferExportType("node", ["import"])).to.equal("esm");
    expect(inferExportType("node", ["unknown", "require"])).to.equal("cjs");
  });
});
```

### fixture ディレクトリの構造設計

test fixture は `test/fixture/` に配置され、実プロジェクトと同一の構造を持つ。

```
test/fixture/
├── bin/cli.mjs           # shebang 付きバイナリ（shebang プラグインの検証用）
├── build.config.ts       # 全ビルダーを網羅する設定（rollup, mkdist, untyped, copy）
├── build.preset.ts       # プリセット機能の検証用
├── package.json          # exports, bin フィールド付き
└── src/
    ├── index.mts          # メインエントリ（__filename, require, dynamic import を含む）
    ├── nested/subpath.ts  # サブパスエクスポートの検証
    ├── runtime/foo.ts     # ディレクトリエントリ（mkdist ビルダー用）
    ├── schema.ts          # untyped ビルダー用スキーマ
    └── test.json          # copy ビルダー + JSON インポートの検証
```

重要なのは `build.config.ts` で、3 つのビルド設定を配列で定義し、1 つの fixture で複数のビルドシナリオをカバーしている点である。

```typescript
// test/fixture/build.config.ts:3-48
export default defineBuildConfig([
  // Auto preset
  {},
  // Custom preset
  {
    preset: "./build.preset",
    rollup: {
      emitCJS: true,
    },
    entries: [
      "./src/index.mts",
      "./src/nested/subpath.ts",
      { input: "src/runtime/", outDir: "dist/runtime" },
      {
        input: "src/",
        outDir: "dist/json/",
        builder: "copy",
        pattern: "**/*.json",
      },
      { input: "src/schema", builder: "untyped" },
    ],
    // ...
  },
  // Minified with sourcemaps
  {
    name: "minified",
    entries: ["src/index"],
    outDir: "dist/min",
    sourcemap: true,
    declaration: "compatible",
    rollup: {
      esbuild: {
        minify: true,
      },
    },
  },
]);
```

### fixture を開発フローでも活用する設計

`package.json` の `dev` スクリプトが fixture を直接ビルドターゲットとして使用している。

```json
// package.json:21
"dev": "pnpm unbuild test/fixture",
```

これにより、開発者は `pnpm dev` で fixture のビルドを手動実行でき、ビルド出力を目視確認できる。テスト fixture と開発ワークフローが同一データを共有することで、fixture の陳腐化を防いでいる。

### テストにおける部分モック構築

`validate.test.ts` では `BuildContext` の完全な構築を避け、テストに必要なプロパティだけを持つ部分オブジェクトを `as any` で渡している。

```typescript
// test/validate.test.ts:10-12
const buildContext = {
  warnings: new Set(),
} as any;
```

一方、`validateDependencies` のテストではより多くのプロパティが必要なため、型の構造に従いつつ不要な部分のみ `as any` で省略している。

```typescript
// test/validate.test.ts:45-73
validateDependencies({
  warnings,
  pkg: {},
  buildEntries: [],
  hooks: [] as any,
  usedImports: new Set(["pkg-a/core"]),
  options: {
    externals: [],
    dependencies: ["react"],
    peerDependencies: [],
    devDependencies: [],
    rootDir: ".",
    entries: [] as BuildEntry[],
    clean: false,
    outDir: "dist",
    stub: false,
    alias: {},
    replace: {},
    // @ts-expect-error
    rollup: {
      replace: false,
      alias: false,
      resolve: false,
      json: false,
      esbuild: false,
      commonjs: false,
    },
  },
});
```

### CI パイプラインによる統合テストの代替

CI は以下の順序で実行される（`.github/workflows/ci.yml:24-26`）。

```yaml
- run: pnpm lint
- run: pnpm test:types
- run: pnpm build        # self-build: unbuild で unbuild 自身をビルド
- run: pnpm vitest run --coverage
```

`pnpm build` は `build.config.ts` で `import { defineBuildConfig } from "./src"` としてソースコードを直接参照し、ビルドを実行する。この self-build が成功すること自体が、ビルドパイプライン全体の統合テストとして機能している。

### consola.mockTypes によるログ検証

`validate.test.ts` では consola の `mockTypes` メソッドを使い、ログ出力の有無を検証している。

```typescript
// test/validate.test.ts:80-88
it("does not print implicit deps warning for peerDependencies", () => {
  const logs: string[] = [];
  consola.mockTypes((type) =>
    type === "warn"
      ? (str: string): void => {
          logs.push(str);
        }
      : (): void => {},
  );
  // ...
  expect(logs.length).to.eq(0);
});
```

## パターンカタログ

- **Bootstrapping / Self-hosting** (分類: 統合テスト戦略)
  - 解決する問題: ビルドツールのビルドパイプライン全体の回帰検出
  - 適用条件: ツールが自分自身を処理できる再帰的な性質を持つ場合（コンパイラ、ビルドツール、フォーマッタ等）
  - コード例: `build.config.ts:1` (`import { defineBuildConfig } from "./src"`)、`.github/workflows/ci.yml:25` (`pnpm build`)
  - 注意点: self-build の成功は「動く」ことの証明であって「正しい」ことの証明ではない。特定のエッジケースの検証にはユニットテストが別途必要

- **Fixture as Miniature Project** (分類: テストデータ設計)
  - 解決する問題: テスト用のダミーデータとプロダクトが扱う実データ構造の乖離
  - 適用条件: テスト対象がプロジェクト構造全体を入力として受け取るツール（ビルドツール、リンター、コード生成器等）
  - コード例: `test/fixture/` ディレクトリ全体、`test/fixture/build.config.ts:3-48`
  - 注意点: fixture が複雑化しすぎると保守コストが増す。1 つの fixture で複数シナリオをカバーする設計がよい

## Good Patterns

- **決定ロジックを純粋関数として分離し、ユニットテスト可能にする**: `inferEntries` は `package.json` オブジェクトとファイルリスト文字列を受け取り、ビルドエントリを返す。ファイルシステムやビルドツールへの依存がないため、高速かつ決定的にテストできる。

```typescript
// src/auto.ts:69-73
export function inferEntries(
  pkg: PackageJson,
  sourceFiles: string[],
  rootDir?: string,
): InferEntriesResult {
```

```typescript
// test/auto.test.ts:5-16 (テスト側: I/O なしで即座に検証)
const result = inferEntries(
  { main: "dist/test.cjs", module: "dist/test.mjs" },
  ["src/", "src/test.ts"],
);
expect(result).to.deep.equal({
  cjs: true,
  dts: false,
  entries: [{ input: "src/test" }],
  warnings: [],
});
```

- **1 fixture で複数のビルドシナリオを網羅する**: `build.config.ts` が配列で 3 つの設定（auto preset, custom preset + 全ビルダー, minified + sourcemap）を定義し、1 つの fixture プロジェクトで幅広いカバレッジを実現している。

```typescript
// test/fixture/build.config.ts:3-5
export default defineBuildConfig([
  // Auto preset
  {},
  // Custom preset (rollup, mkdist, untyped, copy を網羅)
  // Minified with sourcemaps
]);
```

- **fixture を dev スクリプトのターゲットに再利用する**: テスト専用データと開発用データを統一することで、fixture の鮮度が自動的に保たれる。

```json
// package.json:21
"dev": "pnpm unbuild test/fixture"
```

## Anti-Patterns / 注意点

- **ビルド出力のアサーション不在**: テストコードはビルド実行結果（dist/ の中身）を一切検証していない。`inferEntries` の出力が正しくても、Rollup や esbuild の設定ミスで壊れた出力が生成される可能性がある。self-build と dev スクリプトによる手動確認に依存している。

```typescript
// Bad: ビルド出力の検証がない
// テストは inferEntries の戻り値のみ検証し、実際のビルド結果は見ていない

// Better: スナップショットテストやファイル存在チェックを追加
import { build } from "../src/build";
it("produces expected output files", async () => {
  await build("test/fixture", false);
  expect(existsSync("test/fixture/dist/index.mjs")).toBe(true);
  // またはスナップショット: expect(readFileSync(...)).toMatchSnapshot();
});
```

- **`as any` の多用による型安全性の喪失**: テスト内で `as any` を 4 箇所使用しており、テスト対象の関数シグネチャが変更されてもコンパイルエラーで検出できない。

```typescript
// Bad: test/validate.test.ts:12
const buildContext = {
  warnings: new Set(),
} as any;

// Better: 必要なプロパティだけ Pick で絞るか、テスト用ファクトリ関数を用意する
function createMinimalBuildContext(
  overrides: Partial<BuildContext> = {},
): BuildContext {
  return {
    warnings: new Set(),
    pkg: {},
    buildEntries: [],
    // ... 最低限のデフォルト値
    ...overrides,
  } as BuildContext;
}
```

## 導出ルール

- `[MUST]` ビルドツール・コード生成器のテストでは、決定ロジック（何をビルドするか）と変換ロジック（どうビルドするか）を分離し、決定ロジックを純粋関数としてユニットテストする
  - 根拠: unbuild は `inferEntries`, `inferExportType`, `validateDependencies` 等の決定ロジックを I/O 非依存の純粋関数として抽出し、3 ファイル 73 アサーションで高速にテストしている（`test/auto.test.ts`, `test/utils.test.ts`, `test/validate.test.ts`）

- `[MUST]` テスト fixture がプロジェクト構造全体を必要とする場合、実際のプロジェクトと同じ構成（package.json, 設定ファイル, ソースコード）を持つミニチュアプロジェクトとして構築する
  - 根拠: `test/fixture/` は `package.json`, `build.config.ts`, `build.preset.ts`, `src/`, `bin/` を含む完全なプロジェクト構造を持ち、全 4 ビルダー（rollup, mkdist, untyped, copy）をカバーしている

- `[SHOULD]` ツールが自分自身を処理できる場合、CI パイプラインで self-build をテスト実行前のゲートとして配置する
  - 根拠: `.github/workflows/ci.yml` で `pnpm build`（self-build）を `pnpm vitest run` の前に配置し、ビルドパイプライン全体の回帰をテスト以前に検出している

- `[SHOULD]` テスト用 fixture を開発ワークフロー（dev スクリプト等）からも参照し、fixture の鮮度を自動的に維持する
  - 根拠: `package.json` の `"dev": "pnpm unbuild test/fixture"` がテスト fixture を開発時のビルドターゲットとして再利用している

- `[SHOULD]` 1 つの fixture プロジェクトに複数のビルド設定・シナリオを定義し、fixture の増殖を抑えつつカバレッジを広げる
  - 根拠: `test/fixture/build.config.ts` が `defineBuildConfig([...])` の配列形式で 3 つの異なるビルド設定（auto, custom, minified）を 1 ファイルに集約している

- `[AVOID]` テストコードで `as any` を使って型チェックを全面的に迂回すること。部分モックが必要な場合はテスト用ファクトリ関数や `Partial<T>` + 必須フィールドの組み合わせを検討する
  - 根拠: `test/validate.test.ts` で `as any` が 4 箇所使用されており、`BuildContext` のインターフェース変更時にテストがコンパイルエラーで検出できないリスクがある

## 適用チェックリスト

- [ ] ビルドツール・コード生成器の決定ロジック（入力解析・設定解決・依存関係判定）が純粋関数として分離されているか
- [ ] テスト fixture が実際のプロジェクト構造を反映した「ミニチュアプロジェクト」になっているか（単なるデータファイルではなく、設定ファイルやディレクトリ構造を含む）
- [ ] テスト fixture が開発ワークフロー（dev スクリプト、手動実行）からも利用できる設計になっているか
- [ ] ツールが自分自身を処理できる場合、CI で self-build / self-host をテスト前のゲートとして配置しているか
- [ ] テストの部分モック構築で `as any` を濫用していないか。テスト用ファクトリ関数の導入を検討したか
- [ ] CI パイプラインで lint → 型チェック → ビルド → テスト の順序が適切に設定されているか
- [ ] カバレッジ設定がソースコード（`src/**`）のみを対象とし、テストコードや fixture を除外しているか
