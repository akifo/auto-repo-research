# Pattern: Options | false

> 出典: [repos/unjs/unbuild/type-system-patterns](../repos/unjs/unbuild/type-system-patterns.md), [repos/unjs/unbuild/configuration-patterns](../repos/unjs/unbuild/configuration-patterns.md)
> カテゴリ: pattern

## 概要

プラグインや機能モジュールの設定型を `PluginOptions | false` と定義し、`false` で明示的に無効化できる API を提供するパターン。`undefined`（未設定 = デフォルト使用）と `false`（明示的無効化）を型レベルで区別することで、設定の意図を正確に表現できる。`&&` 短絡評価と `.filter(Boolean)` を組み合わせることで、条件付き配列を宣言的に構築できる。

## 背景・文脈

unbuild は Rollup ベースのビルドツールで、6 つの Rollup プラグイン（replace, alias, resolve, json, esbuild, commonjs）を内蔵している。ユーザーはこれらのプラグインをカスタマイズしたいが、場合によっては特定のプラグインを完全に無効化したいこともある。

従来のアプローチでは `enabled: boolean` のようなフラグを別途用意するか、`options?: PluginOptions` として `undefined` で無効化を表現する方法が考えられる。しかし前者は設定の冗長さを招き、後者では「設定していない（デフォルト値を使いたい）」と「意図的に無効化したい」を区別できない。

unbuild は `PluginOptions | false` というユニオン型を採用し、この問題をエレガントに解決している。

## 実装パターン

### 1. 型定義: `PluginOptions | false`

各プラグインの設定フィールドに `| false` を付与する。JSDoc で `false` の意味を明示するのも重要なポイントである。

```typescript
// unjs/unbuild - src/builders/rollup/types.ts:60-100
export interface RollupBuildOptions {
  /**
   * Replace plugin options
   * Set to `false` to disable the plugin.
   * Read more: [@rollup/plugin-replace](https://www.npmjs.com/package/@rollup/plugin-replace)
   */
  replace: RollupReplaceOptions | false;

  /**
   * Alias plugin options
   * Set to `false` to disable the plugin.
   */
  alias: RollupAliasOptions | false;

  /**
   * Resolve plugin options
   * Set to `false` to disable the plugin.
   */
  resolve: RollupNodeResolveOptions | false;

  /**
   * JSON plugin options
   * Set to `false` to disable the plugin.
   */
  json: RollupJsonOptions | false;

  /**
   * ESBuild plugin options
   * Set to `false` to disable the plugin.
   */
  esbuild: EsbuildOptions | false;

  /**
   * CommonJS plugin options
   * Set to `false` to disable the plugin.
   */
  commonjs: RollupCommonJSOptions | false;
}
```

6 つのプラグイン設定が全て同じ `SpecificOptions | false` パターンで統一されている。この一貫性が API の予測可能性を高めている。

### 2. 条件付き配列構築: `&&` 短絡評価

プラグイン配列の中で `&&` 短絡評価を使い、設定値が truthy な場合のみプラグインを生成する。

```typescript
// unjs/unbuild - src/builders/rollup/config.ts:114-166
plugins: [
  ctx.options.rollup.replace &&
    replace({
      ...ctx.options.rollup.replace,
      values: {
        ...ctx.options.replace,
        ...ctx.options.rollup.replace.values,
      },
    }),

  ctx.options.rollup.alias &&
    alias({
      ...ctx.options.rollup.alias,
      entries: _aliases,
    }),

  ctx.options.rollup.resolve &&
    nodeResolve({
      extensions: DEFAULT_EXTENSIONS,
      exportConditions: ["production"],
      ...ctx.options.rollup.resolve,
    }),

  ctx.options.rollup.json &&
    JSONPlugin({
      ...ctx.options.rollup.json,
    }),

  shebangPlugin(),  // 常に有効なプラグインはそのまま配置

  ctx.options.rollup.esbuild &&
    esbuild({
      sourcemap: ctx.options.sourcemap,
      ...ctx.options.rollup.esbuild,
    }),

  ctx.options.rollup.commonjs &&
    commonjs({
      extensions: DEFAULT_EXTENSIONS,
      ...ctx.options.rollup.commonjs,
    }),
].filter((p): p is NonNullable<Exclude<typeof p, false>> => !!p),
```

`&&` 短絡評価の動作:

- 設定値がオブジェクト（truthy）の場合: プラグイン関数が呼ばれ、その戻り値が配列要素になる
- 設定値が `false`（falsy）の場合: `false` がそのまま配列要素になる

### 3. Falsy 値の除去: 型安全な `.filter()`

配列末尾の `.filter()` で `false` を含む falsy 値を除去する。型ガード付きで呼び出すことで、フィルタ後の配列型が正しく推論される。

```typescript
.filter((p): p is NonNullable<Exclude<typeof p, false>> => !!p)
```

この型ガードにより、フィルタ後の配列は `Plugin[]` として型安全に扱える。

### 3 つの値の意味的区別

| 値               | 意味                         | 動作                                     |
| ---------------- | ---------------------------- | ---------------------------------------- |
| `{ ...options }` | カスタム設定でプラグイン有効 | 指定されたオプションでプラグインを初期化 |
| `undefined`      | 未設定（DeepPartial 由来）   | デフォルト値がマージされてプラグイン有効 |
| `false`          | 明示的に無効化               | プラグインを生成しない                   |

`defu` によるディープマージとの相性も良い。`defu` は `false` を有効な値として扱い、デフォルト値で上書きしない。つまりユーザーが `esbuild: false` と指定すれば、デフォルト値のオプションオブジェクトではなく `false` が保持される。

## Good Example

### 宣言的なプラグイン配列構築

```typescript
// 型定義
interface BuildToolOptions {
  minify: MinifyOptions | false;
  sourcemap: SourcemapOptions | false;
  lint: LintOptions | false;
  typecheck: TypecheckOptions | false;
}

// プラグイン配列の構築
function createPlugins(options: BuildToolOptions): Plugin[] {
  return [
    // false でなければプラグインを生成、false なら false が配列に入る
    options.minify
    && createMinifyPlugin({
      ...options.minify,
    }),

    options.sourcemap
    && createSourcemapPlugin({
      ...options.sourcemap,
    }),

    options.lint
    && createLintPlugin({
      ...options.lint,
    }),

    options.typecheck
    && createTypecheckPlugin({
      ...options.typecheck,
    }),
  ].filter((p): p is Plugin => !!p);
}

// ユーザー側: esbuild を無効化し、他はカスタム設定
const plugins = createPlugins({
  minify: { target: "es2020" },
  sourcemap: { inline: true },
  lint: false, // 明示的に無効化
  typecheck: false, // 明示的に無効化
});
```

このパターンのメリット:

- 配列リテラル内で全プラグインの有効/無効が一目で見渡せる
- 各プラグインの条件が独立しており、追加・削除が容易
- `false` の意味が型レベルで「無効化」と明確に定義されている

### output 配列への応用

unbuild では出力形式の条件付き構築にも同じパターンを適用している。

```typescript
// unjs/unbuild - src/builders/rollup/config.ts:30-59
output: [
  ctx.options.rollup.emitCJS &&
    ({
      dir: resolve(ctx.options.rootDir, ctx.options.outDir),
      entryFileNames: "[name].cjs",
      format: "cjs",
      // ...
    } satisfies OutputOptions),
  {
    dir: resolve(ctx.options.rootDir, ctx.options.outDir),
    entryFileNames: "[name].mjs",
    format: "esm",
    // ...
  } satisfies OutputOptions,
].filter(Boolean) as OutputOptions[],
```

`emitCJS` が truthy な場合のみ CJS 出力が追加される。ESM 出力は常に含まれる。

## Bad Example

### if/else による命令的なプラグイン追加

```typescript
// Bad: 命令的にプラグインを追加する
function createPlugins(options: BuildToolOptions): Plugin[] {
  const plugins: Plugin[] = [];

  if (options.minify !== false && options.minify !== undefined) {
    plugins.push(createMinifyPlugin(options.minify || {}));
  }

  if (options.sourcemap !== false && options.sourcemap !== undefined) {
    plugins.push(createSourcemapPlugin(options.sourcemap || {}));
  }

  if (options.lint !== false && options.lint !== undefined) {
    plugins.push(createLintPlugin(options.lint || {}));
  }

  if (options.typecheck !== false && options.typecheck !== undefined) {
    plugins.push(createTypecheckPlugin(options.typecheck || {}));
  }

  return plugins;
}
```

問題点:

- **可読性**: プラグインの全体像を把握するために全ての `if` を読む必要がある
- **冗長性**: `!== false && !== undefined` の条件チェックが各プラグインで繰り返される
- **拡張性**: 新しいプラグインを追加するたびに同じボイラープレートを書く必要がある
- **宣言性の欠如**: 配列の最終形が実行してみないとわからない

### enabled フラグによる二重管理

```typescript
// Bad: enabled フラグと設定オプションの二重管理
interface PluginConfig {
  enabled: boolean;
  options: MinifyOptions;
}

interface BuildToolOptions {
  minify: PluginConfig;
  sourcemap: PluginConfig;
}

// enabled と options が独立して存在するため、
// enabled: false なのに options を細かく設定する矛盾が起きうる
const config: BuildToolOptions = {
  minify: {
    enabled: false,
    options: { target: "es2020" }, // 無効なのに設定がある...
  },
  sourcemap: {
    enabled: true,
    options: { inline: true },
  },
};
```

問題点:

- `enabled: false` のときに `options` が無意味になる構造的矛盾
- `Options | false` なら `false` で「無効」と「設定不要」が同時に表現される

## 適用ガイド

### 適用すべき場面

- **プラグインシステム**: ビルドツール、バンドラー、テストランナーなどのプラグイン配列構築
- **ミドルウェアチェーン**: Express/Koa 等のミドルウェアスタック構築
- **機能フラグ**: 複数の機能モジュールの有効/無効をユーザーが制御する設定
- **出力形式の選択**: CJS/ESM/UMD など複数の出力を条件付きで生成する場面

### 導入時の注意点

- **`false` と `undefined` の区別を一貫させる**: `defu` のようなディープマージライブラリは `false` を有効な値として扱う（デフォルト値で上書きしない）が、全てのマージライブラリがそうとは限らない。利用するマージライブラリの `false` の扱いを確認すること
- **JSDoc で `false` の意味を明示する**: `Set to \`false\` to disable the plugin.` のようなドキュメントを型定義に添える。unbuild では全 6 プラグインに同一フォーマットのコメントが記載されている
- **型ガード付き `.filter()` を使う**: 単純な `.filter(Boolean)` でも動作するが、型ガード `(p): p is NonNullable<Exclude<typeof p, false>> => !!p` を使うことでフィルタ後の配列型が正しく推論される
- **常に有効な要素はそのまま配列に配置する**: 条件なしで含めるべきプラグインは `&&` 短絡評価なしで直接配置する（unbuild の `shebangPlugin()` のように）

### カスタマイズポイント

```typescript
// 基本形: PluginOptions | false
type PluginSetting<T> = T | false;

// 応用: デフォルト設定を true で表現したい場合
// true = デフォルト設定で有効、false = 無効、object = カスタム設定
type PluginSettingWithDefault<T> = T | boolean;

// 利用側
interface Config {
  minify: PluginSettingWithDefault<MinifyOptions>;
}

// true -> デフォルト設定で有効
// false -> 無効
// { target: "es2020" } -> カスタム設定で有効
```

`T | boolean` に拡張すると `true`（デフォルトで有効）も表現できる。ただし `true` の場合にデフォルト値をどこから取得するかの設計が別途必要になる。

### `.filter(Boolean)` の型安全な書き方

```typescript
// 方法 1: 型ガード関数を直接書く（unbuild のアプローチ）
.filter((p): p is NonNullable<Exclude<typeof p, false>> => !!p)

// 方法 2: ヘルパー関数を定義して再利用する
function isTruthy<T>(value: T): value is NonNullable<T> {
  return !!value;
}

const plugins = [
  options.minify && createMinifyPlugin(options.minify),
  options.lint && createLintPlugin(options.lint),
].filter(isTruthy);
```

## 参考

- [repos/unjs/unbuild/type-system-patterns.md](../repos/unjs/unbuild/type-system-patterns.md) -- `OptionsType | false` パターンの型設計分析
- [repos/unjs/unbuild/configuration-patterns.md](../repos/unjs/unbuild/configuration-patterns.md) -- プラグイン有効/無効の条件付き構築パターン
