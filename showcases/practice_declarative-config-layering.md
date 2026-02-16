# Practice: Declarative Config Layering

> 出典: [repos/unjs/unbuild/configuration-patterns.md](../repos/unjs/unbuild/configuration-patterns.md), [repos/unjs/unbuild/design-philosophy.md](../repos/unjs/unbuild/design-philosophy.md)
> カテゴリ: practice

## 概要

`defu` などのディープマージユーティリティの「引数順序」で設定の優先順位を表現する宣言的レイヤリング手法。命令的な `if/switch` 分岐を一切書かずに、複数レイヤーの設定を1行でマージできる。さらに `satisfies` でデフォルト値の型を検証し `as` で出力型を確定する二段構えの TypeScript テクニックを組み合わせることで、型安全性と実用性を両立する。

## 背景・文脈

[unjs/unbuild](https://github.com/unjs/unbuild) は JavaScript/TypeScript ライブラリ向けの統合ビルドツールである。ビルドツールの設定は本質的に多層構造を持つ。unbuild の場合、以下の5つのソースから設定が供給される:

1. `build.config.ts`（ユーザーの明示的設定）
2. `package.json` の `unbuild` / `build` フィールド
3. CLI 引数由来の設定
4. プリセット（共有設定テンプレート）
5. ハードコードされたデフォルト値

従来、この種の多層設定は `if` 文や三項演算子の連鎖で「どのソースの値を使うか」を手続き的に決定していた。unbuild は `defu`（deep defaults utility）の「先に定義された値を優先する」セマンティクスを活用し、引数の順序だけで優先順位を宣言的に表現している。

## 実装パターン

### defu による5層マージ

`defu` は「最初に見つかった非 undefined の値を採用する」というセマンティクスを持つ。つまり、引数の順序がそのまま優先順位になる。

```typescript
// unjs/unbuild — src/build.ts:98-175
const options = defu(
  buildConfig, // 1. build.config.ts の設定（最優先）
  pkg.unbuild || pkg.build, // 2. package.json 内の設定
  inputConfig, // 3. CLI 引数由来の設定
  preset, // 4. プリセットの設定
  { // 5. ハードコードされたデフォルト値（最低優先）
    name: (pkg?.name || "").split("/").pop() || "default",
    rootDir,
    entries: [],
    clean: true,
    declaration: undefined,
    outDir: "dist",
    stub: _stubMode,
    stubOptions: {
      jiti: {
        interopDefault: true,
        alias: {},
      },
    },
    watch: _watchMode,
    externals: [
      ...Module.builtinModules,
      ...Module.builtinModules.map((m) => "node:" + m),
    ],
    dependencies: [],
    devDependencies: [],
    peerDependencies: [],
    alias: {},
    replace: {},
    failOnWarn: true,
    sourcemap: false,
    rollup: {
      emitCJS: false,
      watch: false,
      cjsBridge: false,
      inlineDependencies: false,
      preserveDynamicImports: true,
      output: {
        importAttributesKey: "with",
      },
      replace: {
        preventAssignment: true,
      },
      alias: {},
      resolve: {
        preferBuiltins: true,
      },
      json: {
        preferConst: true,
      },
      commonjs: {
        ignoreTryCatch: true,
      },
      esbuild: { target: "esnext" },
      dts: {
        compilerOptions: {
          preserveSymlinks: false,
          composite: false,
        },
        respectExternal: true,
      },
    },
    parallel: false,
  } satisfies BuildOptions,
) as BuildOptions;
```

この1行（正確には `defu(...)` の呼び出し）が、5つのレイヤーからの設定を統合している。注目すべきポイント:

- **引数の順序 = 優先順位**: 左にあるほど優先度が高い。条件分岐は不要
- **ディープマージ**: ネストされたオブジェクト（`rollup.esbuild` など）もレイヤーごとに部分的にオーバーライド可能
- **`satisfies BuildOptions`**: デフォルト値オブジェクトが `BuildOptions` 型に合致することをコンパイル時に検証
- **`as BuildOptions`**: `defu` の戻り値型は DeepPartial のユニオンになるため、最終的な出力型を `as` で確定

### satisfies + as の二段構え

`defu` のようなマージユーティリティは、引数が全て `DeepPartial` 型であるため、戻り値も DeepPartial のままになる。しかし実際にはデフォルト値で全プロパティが埋まるため、マージ結果は完全な型になる。この「型推論の限界」を補うのが二段構えのテクニックである。

```typescript
// 入力側: satisfies で「デフォルト値が型に合致すること」を検証
// → プロパティ名のタイポや型の不一致をコンパイル時に検出
{
  clean: true,
  outDir: "dist",
  failOnWarn: true,
  // ...
} satisfies BuildOptions,

// 出力側: as で「マージ結果が完全な型であること」を断言
// → 利用側で undefined チェックを不要にする
) as BuildOptions;
```

`satisfies` は型を狭めずにチェックだけを行うため、リテラル型の情報が保持される。一方 `as` は型を上書きするため、入力側の検証なしに使うと危険になる。両方を組み合わせることで、入力の正しさを保証した上で出力型を確定できる。

### DeepPartial によるユーザー設定型

ユーザーが設定を記述する際、全プロパティを書く必要はない。変更したい部分だけを書けるように、ユーザー向けの型は `DeepPartial` で定義されている。

```typescript
// unjs/unbuild — src/types.ts:171-179
type DeepPartial<T> = { [P in keyof T]?: DeepPartial<T[P]>; };

export interface BuildConfig extends
  DeepPartial<
    Omit<BuildOptions, "entries">
  >
{
  entries?: (BuildEntry | string)[];
  preset?: string | BuildPreset;
  hooks?: Partial<BuildHooks>;
}
```

`BuildOptions` は内部で使う完全な型、`BuildConfig` はユーザーが記述する部分的な型。この分離により「デフォルトで全て埋まるが、ユーザーは差分だけ書ける」を実現している。

## Good Example

### 宣言的レイヤリングの実装

```typescript
import { defu } from "defu";

// 型定義
interface AppConfig {
  port: number;
  host: string;
  database: {
    url: string;
    pool: { min: number; max: number; };
    ssl: boolean;
  };
  logging: {
    level: "debug" | "info" | "warn" | "error";
    format: "json" | "text";
  };
}

type DeepPartial<T> = { [P in keyof T]?: DeepPartial<T[P]>; };
type UserConfig = DeepPartial<AppConfig>;

// 各レイヤーの設定
const envConfig: UserConfig = {
  port: Number(process.env.PORT) || undefined,
  database: {
    url: process.env.DATABASE_URL,
  },
};

const fileConfig: UserConfig = {
  host: "0.0.0.0",
  database: {
    pool: { max: 20 },
  },
  logging: { level: "info" },
};

// 1行で5層をマージ（左が優先）
const config = defu(
  envConfig, // 1. 環境変数（最優先）
  fileConfig, // 2. 設定ファイル
  presetConfig, // 3. プリセット
  { // 4. デフォルト値（最低優先）
    port: 3000,
    host: "localhost",
    database: {
      url: "postgresql://localhost:5432/app",
      pool: { min: 2, max: 10 },
      ssl: false,
    },
    logging: {
      level: "warn",
      format: "json",
    },
  } satisfies AppConfig,
) as AppConfig;

// config.database.pool は { min: 2, max: 20 }
// → fileConfig の max: 20 とデフォルトの min: 2 がディープマージされる
```

このアプローチの利点:

- 優先順位が引数の並び順として視覚的に明確
- 新しいレイヤーの追加は引数を1つ挿入するだけ
- 各レイヤーは独立しており、互いの存在を知らない

## Bad Example

### 命令的な if/switch による設定マージ

```typescript
// Bad: 命令的な条件分岐で設定を構築
function buildConfig(): AppConfig {
  const config: AppConfig = {
    port: 3000,
    host: "localhost",
    database: {
      url: "postgresql://localhost:5432/app",
      pool: { min: 2, max: 10 },
      ssl: false,
    },
    logging: { level: "warn", format: "json" },
  };

  // プリセットの適用
  if (preset === "production") {
    config.database.ssl = true;
    config.database.pool.max = 50;
    config.logging.level = "error";
  } else if (preset === "staging") {
    config.database.pool.max = 20;
    config.logging.level = "info";
  }

  // 設定ファイルの適用（プロパティごとに条件分岐）
  if (fileConfig.host) config.host = fileConfig.host;
  if (fileConfig.database?.pool?.max) {
    config.database.pool.max = fileConfig.database.pool.max;
  }
  if (fileConfig.logging?.level) {
    config.logging.level = fileConfig.logging.level;
  }
  // ... プロパティが増えるたびに分岐が増殖する

  // 環境変数の適用
  if (process.env.PORT) config.port = Number(process.env.PORT);
  if (process.env.DATABASE_URL) config.database.url = process.env.DATABASE_URL;

  return config;
}
```

この命令的アプローチの問題点:

- **優先順位が分散**: どのレイヤーが勝つかは if 文の順序に暗黙的に依存
- **プロパティ追加時のコスト**: 新しいプロパティを追加するたびに全レイヤーの分岐を書く必要がある
- **ネスト構造の取り扱い**: ディープなオブジェクトの部分的なオーバーライドが煩雑
- **テスト困難**: 分岐の組み合わせ爆発によりテストケースが膨大になる

## 適用ガイド

### いつ使うか

- **3層以上の設定ソースがある場合**: デフォルト値、プリセット、設定ファイル、環境変数など複数のソースから設定を集める場面
- **ネストされた設定オブジェクトがある場合**: ユーザーが深い階層の一部だけを変更したい場面（例: `rollup.esbuild.target` だけ変えたい）
- **設定の型が安定している場合**: プロパティの追加・変更が頻繁でなく、完全な `satisfies` 検証が有効な場面

### defu の挙動を理解する

`defu` のマージルールは通常のスプレッド構文やObject.assign とは異なる:

- **オブジェクト**: 再帰的にディープマージされる
- **配列**: マージされず、先に定義された方が採用される（上書き）
- **`undefined`**: スキップされる（次のレイヤーにフォールバック）
- **`null`**: 値として扱われる（`undefined` とは異なりフォールバックしない）

配列の挙動は特に重要である。unbuild では `entries: []` がデフォルトだが、ユーザーが `entries` を指定すればそれがそのまま使われる。配列の要素単位でマージしたい場合は `defu` ではなく別のアプローチが必要になる。

### satisfies + as を使うタイミング

| 状況                           | 推奨                                          |
| ------------------------------ | --------------------------------------------- |
| デフォルト値オブジェクトの検証 | `satisfies FullType`                          |
| マージ結果の型確定             | `as FullType`                                 |
| 両方を組み合わせる             | デフォルト値に `satisfies`、マージ結果に `as` |
| ランタイム検証が必要           | Zod などのバリデーションライブラリを追加      |

`satisfies` + `as` はコンパイル時の検証のみであり、ランタイムでの型安全性は保証しない。外部入力（ユーザー設定ファイル、環境変数）を含む場合は、Zod 等によるランタイムバリデーションの追加を検討すべきである。

### 注意点

- **循環参照**: `defu` は循環参照を検出しない。循環するオブジェクトをマージすると無限ループになる
- **プロトタイプ汚染**: 信頼できない入力をマージする場合は `defu` のセキュリティ特性を確認する（defu は `__proto__` と `constructor` を無視する設計）
- **パフォーマンス**: 設定マージは通常アプリケーション起動時に1回だけ実行されるため、パフォーマンスは問題にならない。ただしホットパスで繰り返し呼ぶ場合は注意
- **デバッグ困難性**: マージ結果がどのレイヤー由来かを追跡しにくい。unbuild は推論結果を `consola.info` でログ出力することで緩和している

## 参考

- [repos/unjs/unbuild/configuration-patterns.md](../repos/unjs/unbuild/configuration-patterns.md) — 設定パターンの詳細分析
- [repos/unjs/unbuild/design-philosophy.md](../repos/unjs/unbuild/design-philosophy.md) — 設計思想の分析
- [defu](https://github.com/unjs/defu) — ディープマージユーティリティ
