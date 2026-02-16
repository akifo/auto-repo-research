# testing-practices

> リポジトリ: unjs/unbuild
> 分析日: 2026-02-16

## 概要

unbuild のテスト戦略を分析し、ビルドツールにおけるテスト設計のプラクティスを抽出する。unbuild は 43 ソースファイルの小規模コードベースながら、ユニットテスト（3 ファイル）、フィクスチャベースの統合検証、セルフホスティングビルドという 3 層のテスト戦略を採っている。特に注目すべきは「テストコードの量を最小に保ちながら、ビルド正当性の高い確信を得る」実用的なアプローチである。

## 背景にある原則

- **純粋関数のみをユニットテストの対象にする**: ビルドパイプライン全体を通すテストはコストが高い。副作用のない変換ロジック（エントリポイント推論、export 解析、外部パッケージ推論）だけを切り出してユニットテストし、ビルダー本体（rollup, mkdist, copy, untyped）は直接テストしない。テスト ROI を最大化する設計判断（`src/auto.ts`, `src/utils.ts`, `src/validate.ts` のみがテスト対象で、`src/build.ts`, `src/builders/**` はテスト対象外）。

- **フィクスチャを「本物のプロジェクト」として構成する**: `test/fixture/` は `package.json`, `build.config.ts`, `src/` を備えた完全なミニプロジェクトで、ビルド対象として実際に動作する。モックオブジェクトで再現不可能な「package.json の exports フィールドとファイルシステムの整合性」をテストする手段として使われている（`test/validate.test.ts:26` で `fileURLToPath(import.meta.url)` 経由でフィクスチャパスを解決）。

- **セルフホスティングが最も強力な統合テストになる**: `"build": "pnpm unbuild"` により、unbuild 自身を unbuild でビルドする。これにより、ロールアップ設定・型生成・CJS/ESM デュアル出力など全ビルドパスが CI の `prepack` ステップで暗黙的に検証される。ビルドが壊れればリリースできないため、End-to-End テストを書かずにパイプライン全体の動作保証を得ている。

- **モックを避け、入力データの構築で代替する**: テストではビルドコンテキスト全体を再現するのではなく、テスト対象関数が必要とする最小限のデータ構造をインラインで構築する。`consola.mockTypes` を除き、外部依存のモックは行われていない。

## 実例と分析

### 純粋関数の切り出しとテスト戦略

unbuild はビルドパイプラインのうち、ファイルシステムに依存しない変換ロジックを独立した関数として `src/auto.ts` と `src/utils.ts` に分離している。これらの関数は「package.json の構造 -> ビルドエントリの推論結果」という純粋な変換であり、テストが容易である。

```typescript
// src/auto.ts:69-73
export function inferEntries(
  pkg: PackageJson,
  sourceFiles: string[],
  rootDir?: string,
): InferEntriesResult {
```

テストでは実際の package.json 断片とファイルパス配列を直接渡す。

```typescript
// test/auto.test.ts:5-16
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

一方、`src/build.ts` の `build()` 関数や `src/builders/rollup/build.ts` はファイルシステム操作・プロセス制御・外部ツール呼び出しを含むため、直接のユニットテストは書かれていない。

### フィクスチャプロジェクトの設計

`test/fixture/` は unbuild の全ビルダータイプ（rollup, mkdist, copy, untyped）をカバーする設計になっている。

```typescript
// test/fixture/build.config.ts:1-48
export default defineBuildConfig([
  // Auto preset (デフォルトの推論テスト)
  {},
  // Custom preset (全ビルダータイプをカバー)
  {
    preset: "./build.preset",
    rollup: { emitCJS: true },
    entries: [
      "./src/index.mts", // rollup
      "./src/nested/subpath.ts", // rollup (サブパス)
      { input: "src/runtime/", outDir: "dist/runtime" }, // mkdist
      { input: "src/", outDir: "dist/json/", builder: "copy", pattern: "**/*.json" }, // copy
      { input: "src/schema", builder: "untyped" }, // untyped
    ],
  },
  // Minified with sourcemaps (エッジケース)
  { name: "minified", entries: ["src/index"], outDir: "dist/min", sourcemap: true },
]);
```

このフィクスチャは `pnpm dev`（`pnpm unbuild test/fixture`）で開発中にも使われ、手動の統合テストとして機能する。

### 部分的なコンテキスト構築パターン

`test/validate.test.ts` では `BuildContext` 全体を構築する代わりに、テスト対象関数が参照するフィールドだけを持つ部分オブジェクトを `as any` で型を回避して渡している。

```typescript
// test/validate.test.ts:10-12
const buildContext = {
  warnings: new Set(),
} as any;
```

より複雑なケースでは、必要なフィールドを明示的に列挙し、不要なネストオブジェクトは `@ts-expect-error` で省略する。

```typescript
// test/validate.test.ts:45-71
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
    // ... 必要最小限のフィールド
    // @ts-expect-error
    rollup: { replace: false, alias: false, ... },
  },
});
```

### ファイルシステムを使った検証の境界

`validatePackage` のテストでは、実際のファイルシステム（`test/fixture/` ディレクトリ）を参照して「ファイルが存在しない」ことを検証している。これはモックではなく実フィクスチャに対するアサーションである。

```typescript
// test/validate.test.ts:26-27
validatePackage(
  { main: "./dist/test" /* ... */ },
  join(fileURLToPath(import.meta.url), "../fixture"),
  buildContext,
);
```

`dist/test` は fixture ディレクトリに存在しないため、warnings に "Potential missing" が追加されることを検証する。フィクスチャの「存在しないファイル」が期待値の一部になっている設計。

### 警告メッセージの部分一致テスト

検証テストでは、警告メッセージの完全一致ではなく部分一致（`.to.include`）で検証している。メッセージフォーマットの変更に対する耐性を持たせている。

```typescript
// test/validate.test.ts:32-37
expect(warnings[0]).to.include("Potential missing");
expect(warnings[0]).not.to.include("src/index.mts");
for (const file of ["dist/test", "dist/cli", "dist/mod", "runtime"]) {
  expect(warnings[0]).to.include(file);
}
```

### consola.mockTypes によるログ抑制

外部ライブラリ consola の `mockTypes` メソッドを使い、テスト中のログ出力をキャプチャしている。Vitest の `vi.mock` ではなく、ライブラリ提供のテストユーティリティを使う点が特徴的。

```typescript
// test/validate.test.ts:82-88
consola.mockTypes((type) =>
  type === "warn"
    ? (str: string): void => {
      logs.push(str);
    }
    : (): void => {}
);
```

### カバレッジ設定の意図的なスコーピング

カバレッジ対象を `src/**/*.ts` に限定し、テストファイルやフィクスチャはカバレッジから除外している。

```typescript
// vitest.config.ts:4-8
test: {
  coverage: {
    reporter: ["text", "clover", "json"],
    include: ["src/**/*.ts"],
  },
},
```

## Good Patterns

- **Input-Output スナップショットテスト**: `inferEntries` のテストは、package.json の断片（入力）とビルドエントリ構造（出力）の対応を `deep.equal` で検証する。スナップショットファイルを使わず、テストコード内に期待値を明示することで、テストの可読性と意図の明確性を両立している。

```typescript
// test/auto.test.ts:62-73 — 入力と出力が隣接して読める
it("recognises `type: module` projects", () => {
  const result = inferEntries({ main: "dist/test.js", type: "module" }, [
    "src/",
    "src/test.ts",
  ]);
  expect(result).to.deep.equal({
    cjs: false,
    dts: false,
    entries: [{ input: "src/test" }],
    warnings: [],
  });
});
```

- **フィクスチャが複数のビルダーを単一設定でカバー**: `test/fixture/build.config.ts` は rollup, mkdist, copy, untyped の 4 ビルダーを 1 つの設定ファイルに含め、開発時の `pnpm dev` で全パスを一括検証できる。フィクスチャの保守コストを最小化しつつカバレッジを最大化する設計。

```typescript
// test/fixture/build.config.ts:12-23
entries: [
  "./src/index.mts",
  "./src/nested/subpath.ts",
  { input: "src/runtime/", outDir: "dist/runtime" },
  { input: "src/", outDir: "dist/json/", builder: "copy", pattern: "**/*.json" },
  { input: "src/schema", builder: "untyped" },
],
```

- **テスト用プリセットで hooks をカバー**: `test/fixture/build.preset.ts` で `build:before` と `build:done` フックを定義し、プリセット機能の動作を開発時に検証できるようにしている。

```typescript
// test/fixture/build.preset.ts:3-16
export default definePreset({
  declaration: "compatible",
  rollup: { cjsBridge: true },
  hooks: {
    "build:before": () => {
      console.log("Before build");
    },
    "build:done": () => {
      console.log("After build");
    },
  },
});
```

## Anti-Patterns / 注意点

- **`as any` による型安全性の放棄**: `test/validate.test.ts` では `BuildContext` の部分オブジェクトを `as any` で渡している。テスト対象のインターフェースが変更された場合（フィールド追加・リネーム）、コンパイルエラーで検知できない。

```typescript
// Bad: 型チェックが効かない
const buildContext = { warnings: new Set() } as any;

// Better: Pick または Partial を使って必要フィールドのみ型安全に構築
const buildContext: Pick<BuildContext, "warnings"> = {
  warnings: new Set(),
};
```

- **ビルダー本体にユニットテストがない**: `src/builders/rollup/`, `src/builders/mkdist/`, `src/builders/copy/`, `src/builders/untyped/` はフィクスチャ経由の手動検証に依存している。セルフホスティングビルドで暗黙的にカバーされるが、エッジケース（例: rollup プラグインの設定不整合）の回帰検知が弱い。小規模プロジェクトでは許容されるが、ビルダーが増えるほどリスクが高まる。

## 導出ルール

- `[MUST]` ビルドツールのテストでは、ビルドパイプラインの純粋変換ロジック（設定解析・エントリ推論・依存解決）を副作用のある実行ロジック（ファイル書き出し・プロセス呼び出し）から分離し、前者をユニットテストの対象にする
  - 根拠: unbuild は `inferEntries`, `extractExportFilenames`, `inferPkgExternals` 等の純粋関数をテストし、`build()` 関数や各ビルダーは直接テストしない戦略で、3 ファイル 40 アサーションという最小コストで高い信頼性を実現している

- `[SHOULD]` フィクスチャプロジェクトは実際の `package.json` と設定ファイルを持つ「本物のプロジェクト」として構成し、全ビルドパス（ビルダータイプ・出力形式・エッジケース）を単一フィクスチャでカバーする
  - 根拠: `test/fixture/build.config.ts` は rollup/mkdist/copy/untyped の 4 ビルダーと auto preset/custom preset/minified の 3 設定を 1 ファイルに含み、`pnpm dev` で一括検証を可能にしている

- `[SHOULD]` セルフホスティング可能なツール（ビルドツール・コンパイラ・リンタ等）は、自身を自身で処理するステップを CI に組み込み、暗黙の End-to-End テストとする
  - 根拠: `"build": "pnpm unbuild"` によりリリースフローに統合テストが埋め込まれ、ビルドパイプラインの破壊が自動検知される

- `[SHOULD]` エラーメッセージや警告メッセージのテストでは、完全一致ではなく部分一致（`include` / `contains`）で検証し、メッセージフォーマットの軽微な変更に対する耐性を持たせる
  - 根拠: `test/validate.test.ts:32-36` では `to.include("Potential missing")` と個別ファイル名の `to.include` を組み合わせ、メッセージの装飾変更（色付け等）に影響されないテストを書いている

- `[AVOID]` ビルドコンテキストやオプションオブジェクトのテスト用構築で `as any` を多用してインターフェース変更の検知を放棄する。代わりに `Pick<T, K>` や `Partial<T>` でテスト対象が依存するフィールドを型安全に限定する
  - 根拠: `test/validate.test.ts` では `as any` が 2 箇所、`@ts-expect-error` が 2 箇所使われており、`BuildContext` や `BuildOptions` の変更がテストのコンパイルエラーとして検知されない

## 適用チェックリスト

- [ ] ビルド/変換パイプラインのロジックを「純粋変換」と「副作用を伴う実行」に分離し、前者にユニットテストを集中させているか
- [ ] フィクスチャプロジェクトが実際の設定ファイル（package.json, ビルド設定）を持ち、本物のプロジェクトとして動作するか
- [ ] フィクスチャが全ビルドパス（出力形式・ビルダータイプ・エッジケース）をカバーしているか
- [ ] セルフホスティング可能なツールの場合、CI で自身を自身で処理するステップが含まれているか
- [ ] テストで構築する部分オブジェクトが型安全か（`as any` の代わりに `Pick` / `Partial` を使っているか）
- [ ] エラー・警告メッセージのテストが部分一致で、フォーマット変更に耐性があるか
- [ ] カバレッジ対象がソースコードのみに限定され、テストファイルやフィクスチャが除外されているか
