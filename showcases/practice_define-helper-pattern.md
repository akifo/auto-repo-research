# Practice: defineXxxConfig ヘルパーパターン

> 出典: repos/unjs/unbuild, repos/mastra-ai/mastra, repos/honojs/hono からの横断分析
> カテゴリ: practice

## 概要

`defineXxxConfig` は、実行時にはほぼパススルー（identity 関数）でありながら、IDE の型補完をユーザーの設定ファイルに自然に持ち込むヘルパー関数パターンである。ユーザーは型注釈や `as` キャストを書くことなく、エディタの自動補完だけで型安全な設定を記述できる。unbuild の `defineBuildConfig`、Vitest の `defineConfig`、Nuxt の `defineNuxtConfig` など、unjs/Vue エコシステムを中心に広く採用されており、ライブラリが提供する設定 API の DX を飛躍的に向上させる定番プラクティスである。

## 背景・文脈

TypeScript プロジェクトでは、設定ファイルを `.ts` で書くことが一般的になった。しかし、設定オブジェクトをただの `export default { ... }` で記述すると、IDE は型情報を持たないためプロパティの補完が効かない。ユーザーが型安全に設定を書くには、以下のいずれかが必要になる。

1. 変数に型注釈を付ける: `const config: BuildConfig = { ... }`
2. `as` でキャストする: `export default { ... } as BuildConfig`
3. `satisfies` を使う: `export default { ... } satisfies BuildConfig`

いずれもユーザーにライブラリの型名を import させ、手動で型を適用させる手間が発生する。`defineXxxConfig` パターンはこの摩擦を解消する。関数呼び出しの引数として設定を渡すだけで、TypeScript の引数型推論により自動的に型補完が有効になる。

このパターンは以下のリポジトリで確認されている。

- **unbuild** (`defineBuildConfig`, `definePreset`): ビルド設定と共有プリセットの型安全なヘルパー。`defineBuildConfig` は配列正規化の薄いロジックのみ持つ。`definePreset` は完全な identity 関数。
- **Mastra** (`createTool`, `createStep`, `createWorkflow`): `create` プレフィックスの命名だが、本質は同じ。ファクトリ関数がジェネリクスの型推論を引き受け、ユーザーが型パラメータを手動指定する必要をなくしている。
- **Hono** (ミドルウェアファクトリ `cors()`, `bearerAuth()` 等): オプションオブジェクトを受け取りミドルウェアを返すファクトリ関数。設定に型が付くことで、IDE 補完でオプションを探索できる。

## 実装パターン

### 基本形: identity 関数

最もシンプルな実装は、引数をそのまま返す identity 関数である。

```typescript
// 最小限の defineXxxConfig
// 実行時コスト: ほぼゼロ
// 型の効果: 引数に型が付くため IDE 補完が有効になる

interface MyLibConfig {
  entry?: string;
  outDir?: string;
  minify?: boolean;
  plugins?: string[];
}

export function defineConfig(config: MyLibConfig): MyLibConfig {
  return config;
}
```

### unbuild の実装: 配列正規化を兼ねる

```typescript
// unjs/unbuild — src/types.ts:204-212
export function defineBuildConfig(
  config: BuildConfig | BuildConfig[],
): BuildConfig[] {
  return (Array.isArray(config) ? config : [config]).filter(Boolean);
}

export function definePreset(preset: BuildPreset): BuildPreset {
  return preset;
}
```

`defineBuildConfig` は単一設定と配列の両方を受け付け、必ず配列として返す。このわずかな正規化ロジック以外はパススルーであり、主目的は型補完の提供である。`definePreset` に至っては完全な identity 関数で、ランタイムコストはゼロ。

### Mastra の実装: ファクトリ関数 + 型推論

```typescript
// mastra-ai/mastra — packages/core/src/tools/tool.ts:403-419
// createTool はジェネリクスの型推論をファクトリに任せるパターン
export function createTool<
  TSchemaIn extends z.ZodType,
  TSchemaOut extends z.ZodType,
>(config: ToolConfig<TSchemaIn, TSchemaOut>): Tool<TSchemaIn, TSchemaOut> {
  return new Tool(config);
}
```

`createTool` は `new Tool(config)` のラッパーだが、ジェネリック型パラメータ `TSchemaIn` と `TSchemaOut` が `config` の Zod スキーマから自動推論される。ユーザーが `createTool<typeof inputSchema, typeof outputSchema>(...)` と手動指定する必要がない。

### Hono の実装: ファクトリ関数でミドルウェアを返す

```typescript
// honojs/hono — src/middleware/cors/index.ts:63
export const cors = (options?: CORSOptions): MiddlewareHandler => {
  // ...
  return async function cors(c, next) {
    // CORS 処理
  };
};
```

Hono のミドルウェアファクトリは、設定を受け取って `MiddlewareHandler` を返す。`options` パラメータに `CORSOptions` 型が付くため、`cors({ origin: '...' })` と書くだけで IDE がプロパティを補完する。

## Good Example

### ライブラリ側の定義

```typescript
// lib/types.ts

// 1. 内部用の厳密な型（全フィールド必須）
interface PluginOptions {
  name: string;
  entry: string;
  outDir: string;
  minify: boolean;
  sourcemap: boolean;
  target: "es2020" | "es2022" | "esnext";
}

// 2. ユーザー向けの寛容な型（DeepPartial で全フィールド optional）
type DeepPartial<T> = { [P in keyof T]?: DeepPartial<T[P]>; };

export interface PluginConfig extends DeepPartial<Omit<PluginOptions, "entry">> {
  entry?: string | string[]; // ユーザー向けにショートハンドを許容
}

// 3. defineConfig ヘルパー（型補完のための identity 関数）
export function definePluginConfig(config: PluginConfig): PluginConfig {
  return config;
}
```

### ユーザー側の利用

```typescript
// plugin.config.ts
import { definePluginConfig } from "my-lib";

// 型注釈も as キャストも不要。
// definePluginConfig の引数型から IDE 補完が自動的に有効になる。
export default definePluginConfig({
  entry: "src/index.ts",
  minify: true,
  // ↑ ここで Ctrl+Space を押すと target, sourcemap, outDir 等が候補に出る
});
```

### 配列対応 + プリセット対応の応用例

```typescript
// lib/config.ts
export type Preset = PluginConfig | (() => PluginConfig);

export function definePluginConfig(
  config: PluginConfig | PluginConfig[],
): PluginConfig[] {
  return (Array.isArray(config) ? config : [config]).filter(Boolean);
}

export function definePreset(preset: Preset): Preset {
  return preset;
}
```

```typescript
// 複数設定を一括定義
export default definePluginConfig([
  { entry: "src/index.ts", target: "esnext" },
  { entry: "src/cli.ts", target: "es2020" },
]);
```

## Bad Example

### 型注釈を直接書く方式

```typescript
// Bad: ユーザーが型名を import して手動で注釈する必要がある
import type { BuildConfig } from "unbuild";

const config: BuildConfig = {
  entries: ["src/index"],
  declaration: true,
};

export default config;
```

問題点:

- ユーザーが型名を知っている必要がある（`BuildConfig` か `UnbuildConfig` か `Config` か?）
- `import type` を書く手間が発生する
- 配列で複数設定を渡す場合、`BuildConfig[]` に変わることに気づきにくい

### `as` キャストに頼る方式

```typescript
// Bad: as キャストは型チェックをバイパスする
export default {
  entries: ["src/index"],
  declartion: true, // typo! しかし as キャストでは検出されない
} as BuildConfig;
```

問題点:

- `as` は型の上書きであり、実際の値と型が不一致でもエラーにならない
- タイポや不正なプロパティが検出されない
- `satisfies` を使えばタイポは検出されるが、ユーザーに TypeScript の `satisfies` 演算子の知識を要求する

### ジェネリクスを手動指定させる方式

```typescript
// Bad: ユーザーが型パラメータを手動で書く必要がある
const tool = new Tool<typeof inputSchema, typeof outputSchema>({
  inputSchema,
  outputSchema,
  execute: async ({ context }) => { ... },
});
```

問題点:

- ジェネリクスの指定が冗長で、スキーマの変更時に2箇所を更新する必要がある
- `createTool({ inputSchema, outputSchema, execute })` なら型パラメータは自動推論される

## 適用ガイド

### どのような状況で使うべきか

- **ライブラリの設定ファイル**: `build.config.ts`, `vite.config.ts` のようにユーザーが `.ts` ファイルで設定を書く場面。最も典型的なユースケース。
- **プラグイン / プリセットの定義**: 共有可能な設定の断片を型安全に定義させたい場面。unbuild の `definePreset` のように、プリセット定義にも同パターンを適用できる。
- **ファクトリ関数の公開 API**: `new Class(config)` の代わりに `createXxx(config)` を提供し、ジェネリクスの推論をファクトリに任せる場面。Mastra の `createTool` パターン。

### 命名規約

| プレフィックス    | 用途                             | 例                                      |
| ----------------- | -------------------------------- | --------------------------------------- |
| `defineXxxConfig` | 設定ファイルのヘルパー           | `defineBuildConfig`, `defineNuxtConfig` |
| `defineXxx`       | 設定以外のヘルパー               | `definePreset`, `defineComponent`       |
| `createXxx`       | インスタンス生成を伴うファクトリ | `createTool`, `createWorkflow`          |

`define` は identity 関数に近い場合、`create` はインスタンスを生成する場合に使い分ける。

### 導入時の注意点

1. **戻り値型を明示する**: `defineConfig(config: T): T` のように戻り値型を引数型と揃える。TypeScript が戻り値型を推論に使うため、ここを `any` にすると型の恩恵が消える。

2. **内部型とユーザー型を分離する**: 内部で使う型（全フィールド必須）とユーザーが触る型（`DeepPartial`）を分けることで、ユーザーは必要な部分だけ指定すればよくなる。unbuild は `BuildOptions`（内部）と `BuildConfig`（ユーザー向け）を明確に分離している。

3. **単一値と配列の両方を受け付ける**: `config: T | T[]` のようにユニオンで受け取り、内部で配列に正規化する。ユーザーが設定1つの場合に `[{ ... }]` と書く必要がなくなる。

4. **ランタイムロジックは最小限に**: 主目的は型補完の提供。バリデーションやデフォルト値注入は呼び出し側（ライブラリ内部）で行い、define ヘルパー自体は軽く保つ。

### カスタマイズポイント

- **バリデーション付き define**: 設定のバリデーションを define ヘルパーに入れたい場合は、Zod スキーマの `parse` を呼ぶ方式がある。ただしランタイムコストが増えるため、開発時のみ有効にする（`process.env.NODE_ENV !== 'production'`）等の工夫が要る。
- **非同期 define**: プリセットの解決に非同期処理が必要な場合は、関数を返す形式（`() => Config`）を許容するユニオン型にする。unbuild の `BuildPreset = BuildConfig | (() => BuildConfig)` がこのパターン。
- **`satisfies` との組み合わせ**: ライブラリ内部でデフォルト値オブジェクトを定義する際は `satisfies` で型検証し、ディープマージ後に `as` で型を確定する二段構えが有効（unbuild の `defu(...) as BuildOptions` パターン）。

## 参考

- [repos/unjs/unbuild/type-system-patterns.md](../repos/unjs/unbuild/type-system-patterns.md) -- 型安全な define ヘルパー関数の実装と Good Patterns
- [repos/unjs/unbuild/design-philosophy.md](../repos/unjs/unbuild/design-philosophy.md) -- define ヘルパーによる型安全な設定、セルフホスティング
- [repos/unjs/unbuild/configuration-patterns.md](../repos/unjs/unbuild/configuration-patterns.md) -- Identity Function Helper パターン、defu マージチェーン
- [repos/mastra-ai/mastra/api-design-practices.md](../repos/mastra-ai/mastra/api-design-practices.md) -- createXxx ファクトリ関数、ジェネリクス型推論
- [repos/honojs/hono/api-design-practices.md](../repos/honojs/hono/api-design-practices.md) -- ミドルウェアファクトリパターン、オプションオブジェクト設計
