# type-system-patterns

> リポジトリ: unjs/unbuild
> 分析日: 2026-02-16

## 概要

unbuild の型設計を分析し、ライブラリが公開する設定型をどう構造化すべきかのプラクティスを抽出する。特に注目すべきは、ユニオン型による「ビルダー種別ごとのエントリ型分岐」、`DeepPartial<Omit<T>>` の合成によるユーザー向け設定型の緩和、`OptionsType | false` によるプラグイン無効化パターン、そして各サブモジュールが独自の `types.ts` を持ちつつ中央ファイルで re-export する型エクスポート戦略である。43ファイルの小規模コードベースながら、ライブラリ型設計の定石が凝縮されている。

## 背景にある原則

- **内部は厳密、外部は寛容（Strict Internal / Lenient External）**: 内部で使う `BuildOptions` は全フィールド必須の厳密型として定義し、ユーザー向け `BuildConfig` は `DeepPartial<Omit<BuildOptions, "entries">>` で緩和する。これによりライブラリ内部はデフォルト値が確定した安全な型で操作でき、ユーザーは必要な部分だけ指定すればよい。根拠: `src/types.ts:43-148`（BuildOptions）と `src/types.ts:177-195`（BuildConfig）の対比。
- **判別可能ユニオン（Discriminated Union）で分岐を型安全にする**: `builder` フィールドをリテラル型のディスクリミナントとして使い、各ビルダー固有のエントリ型をユニオンで統合する。ランタイムの `entry.builder === "copy"` チェックがそのまま型の絞り込みに対応する設計意図がある。根拠: `src/types.ts:14-41`。
- **Intersection 型でフック体系を合成する**: 各ビルダーが独立に定義したフック interface を `extends` で交差合成し、一つの `BuildHooks` 型にまとめる。ビルダーの追加・削除がフック型の変更箇所を最小限に抑える。根拠: `src/types.ts:197-202`。
- **`OptionsType | false` でオプトアウトを型で表現する**: プラグインの設定型に `| false` を加えることで「設定するか、完全に無効化するか」の二択を型レベルで表現する。`undefined`（未設定）と `false`（明示的無効化）を区別できる。根拠: `src/builders/rollup/types.ts:65-100`。

## 実例と分析

### ユニオン型によるビルダー型分岐

`BaseBuildEntry` を共通基底とし、各ビルダーがそれを拡張した固有型を定義する。ユニオン型 `BuildEntry` は全てのバリアントを包含する。

```typescript
// src/types.ts:14-20
export interface BaseBuildEntry {
  builder?: "untyped" | "rollup" | "mkdist" | "copy";
  input: string;
  name?: string;
  outDir?: string;
  declaration?: "compatible" | "node16" | boolean;
}
```

```typescript
// src/builders/copy/types.ts:3-6
export interface CopyBuildEntry extends BaseBuildEntry {
  builder: "copy";
  pattern?: string | string[];
}
```

```typescript
// src/builders/mkdist/types.ts:4-7
type _BaseAndMkdist = BaseBuildEntry & MkdistOptions;
export interface MkdistBuildEntry extends _BaseAndMkdist {
  builder: "mkdist";
}
```

```typescript
// src/types.ts:36-41
export type BuildEntry =
  | BaseBuildEntry
  | RollupBuildEntry
  | UntypedBuildEntry
  | MkdistBuildEntry
  | CopyBuildEntry;
```

ここで重要なのは `BaseBuildEntry` の `builder` が optional（`builder?`）である点だ。ユーザーが `builder` を省略した場合にもユニオンのメンバーとして受け入れ、ランタイムでデフォルト値を割り当てる設計になっている。

```typescript
// src/build.ts:228-229
if (!entry.builder) {
  entry.builder = entry.input.endsWith("/") ? "mkdist" : "rollup";
}
```

各ビルダーの実装では `.filter()` + `as` キャストで型を絞り込む。TypeScript の制御フロー解析では `.filter()` コールバック内の文字列比較による絞り込みが `BuildEntry` ユニオンに対して自動的には効かないため、明示的キャストが実用上の妥協として採用されている。

```typescript
// src/builders/copy/index.ts:11-13
const entries = ctx.options.entries.filter(
  (e) => e.builder === "copy",
) as CopyBuildEntry[];
```

### DeepPartial + Omit による設定型の段階的緩和

内部用の `BuildOptions` は全フィールドが必須（`entries: BuildEntry[]`、`clean: boolean` 等）だが、ユーザーが直接触る `BuildConfig` は `DeepPartial<Omit<BuildOptions, "entries">>` で全フィールドを optional かつネスト階層も partial にしている。

```typescript
// src/types.ts:171
type DeepPartial<T> = { [P in keyof T]?: DeepPartial<T[P]> };

// src/types.ts:177-195
export interface BuildConfig extends DeepPartial<
  Omit<BuildOptions, "entries">
> {
  entries?: (BuildEntry | string)[];
  preset?: string | BuildPreset;
  hooks?: Partial<BuildHooks>;
}
```

`Omit<BuildOptions, "entries">` で `entries` を一旦除外し、`BuildConfig` 側で `entries?: (BuildEntry | string)[]` として再定義している。これにより `entries` に文字列ショートハンドを許容しつつ、`BuildOptions.entries` の型（`BuildEntry[]` のみ）は厳密に保つ。

ランタイムでは `defu` によるディープマージと `satisfies BuildOptions` でデフォルト値が注入され、`as BuildOptions` で型を確定させる。

```typescript
// src/build.ts:98-175
const options = defu(
  buildConfig,
  pkg.unbuild || pkg.build,
  inputConfig,
  preset,
  {
    name: (pkg?.name || "").split("/").pop() || "default",
    rootDir,
    entries: [],
    clean: true,
    // ...全デフォルト値
  } satisfies BuildOptions,
) as BuildOptions;
```

`satisfies BuildOptions` でデフォルトオブジェクトの型整合性をコンパイル時に検証し、`defu` の戻り値を `as BuildOptions` でキャストするという二段構えになっている。

### `OptionsType | false` によるプラグイン無効化パターン

Rollup プラグインの設定型は一貫して `PluginOptions | false` のユニオンを採用している。

```typescript
// src/builders/rollup/types.ts:65-100
replace: RollupReplaceOptions | false;
alias: RollupAliasOptions | false;
resolve: RollupNodeResolveOptions | false;
json: RollupJsonOptions | false;
esbuild: EsbuildOptions | false;
commonjs: RollupCommonJSOptions | false;
```

設定側で `ctx.options.rollup.replace &&` のように truthy チェックするだけで、`false` のときはプラグインをスキップできる。

```typescript
// src/builders/rollup/config.ts:115-116
ctx.options.rollup.replace &&
  replace({
    ...ctx.options.rollup.replace,
    values: { ... },
  }),
```

配列内の `false` 値は最後に `.filter()` で除去される。

```typescript
// src/builders/rollup/config.ts:166
].filter((p): p is NonNullable<Exclude<typeof p, false>> => !!p),
```

### 型エクスポート戦略: 分散定義・中央 re-export

各ビルダーは独自の `types.ts` を持ち、そこでエントリ型とフック型を定義する。

```
src/builders/
├── copy/types.ts      → CopyBuildEntry, CopyHooks
├── mkdist/types.ts    → MkdistBuildEntry, MkdistHooks
├── rollup/types.ts    → RollupBuildEntry, RollupBuildOptions, RollupHooks, ...
└── untyped/types.ts   → UntypedBuildEntry, UntypedHooks, ...
```

中央の `src/types.ts` が `export type { ... } from "..."` で必要な型だけを re-export する。

```typescript
// src/types.ts:23-34
export type {
  RollupBuildEntry,
  RollupBuildOptions,
  RollupOptions,
} from "./builders/rollup/types";
export type { MkdistBuildEntry } from "./builders/mkdist/types";
export type { CopyBuildEntry } from "./builders/copy/types";
export type {
  UntypedBuildEntry,
  UntypedOutput,
  UntypedOutputs,
} from "./builders/untyped/types";
```

`src/index.ts` は `export * from "./types"` で全公開型をバレルエクスポートする。`verbatimModuleSyntax: true` の設定下で `export type` を使い、型と値のエクスポートを明確に分離している。

### Parameters 型による外部ライブラリの型抽出

外部ライブラリの設定型を直接 import できない場合に `Parameters<typeof fn>[0]` で型を逆算する手法が使われている。

```typescript
// src/builders/rollup/types.ts:13,18
import type commonjs from "@rollup/plugin-commonjs";
export type RollupCommonJSOptions = Parameters<typeof commonjs>[0] & {};
```

`& {}` は空の交差型で、TypeScript のホバー表示を展開させるテクニック（ブランド化の副作用）として知られる。

## パターンカタログ

- **Discriminated Union** (分類: 型設計パターン)
  - 解決する問題: 複数のバリアント型を統合しつつ、ランタイムで安全に分岐する
  - 適用条件: 複数のサブタイプが共通のリテラル型フィールドで区別可能な場合
  - コード例: `src/types.ts:14-41`
  - 注意点: `BaseBuildEntry` で `builder` を optional にしているため、`.filter()` 後の型絞り込みに `as` キャストが必要になっている

- **Facade Type（寛容な外部型 / 厳密な内部型）** (分類: 構造パターン)
  - 解決する問題: ユーザー向け API の使いやすさと内部実装の型安全性の両立
  - 適用条件: デフォルト値が多い設定オブジェクトをライブラリが提供する場合
  - コード例: `src/types.ts:171-195`（BuildConfig）と `src/types.ts:43-148`（BuildOptions）
  - 注意点: `DeepPartial` はプリミティブ型のプロパティにも再帰するため、意図しない optional 化に注意

## Good Patterns

- **`satisfies` + `as` の二段構え**: デフォルトオブジェクトに `satisfies BuildOptions` を適用してコンパイル時に型チェックし、`defu` の戻り値を `as BuildOptions` でキャストする。`satisfies` だけでは `defu` の戻り値型が推論に依存するため不十分であり、`as` だけでは実際の値の型安全性が担保されない。二つを組み合わせることで両方のリスクを緩和している。

```typescript
// src/build.ts:98-175
const options = defu(
  buildConfig,
  inputConfig,
  preset,
  {
    name: "default",
    rootDir,
    entries: [],
    clean: true,
    // ...
  } satisfies BuildOptions,
) as BuildOptions;
```

- **型安全な `define*` ヘルパー関数**: `defineBuildConfig` と `definePreset` は実質的にはパススルー関数だが、引数に型が付くため IDE の自動補完が効く。ユーザーは `as` や型注釈なしで型安全な設定を書ける。

```typescript
// src/types.ts:204-212
export function defineBuildConfig(
  config: BuildConfig | BuildConfig[],
): BuildConfig[] {
  return (Array.isArray(config) ? config : [config]).filter(Boolean);
}

export function definePreset(preset: BuildPreset): BuildPreset {
  return preset;
}
```

- **`export type` による型のみの re-export**: `verbatimModuleSyntax: true` のもとで `export type { ... } from "..."` を使い、型のみを公開する。ランタイムバンドルに不要な import が残らないことが保証される。

```typescript
// src/types.ts:23-34
export type {
  RollupBuildEntry,
  RollupBuildOptions,
  RollupOptions,
} from "./builders/rollup/types";
```

## Anti-Patterns / 注意点

- **`.filter()` 後の `as` キャストによる型絞り込み**: 4つの全ビルダー実装で同一パターンが繰り返されている。型ガード関数を定義すれば `as` キャストなしで絞り込める。

```typescript
// Bad: src/builders/copy/index.ts:11-13
const entries = ctx.options.entries.filter(
  (e) => e.builder === "copy",
) as CopyBuildEntry[];

// Better: 型ガード関数を使う
function isCopyEntry(e: BuildEntry): e is CopyBuildEntry {
  return e.builder === "copy";
}
const entries = ctx.options.entries.filter(isCopyEntry);
```

- **`BaseBuildEntry.builder` の optional 定義によるディスクリミナント弱体化**: `builder?` が optional であるため、TypeScript は `BuildEntry` ユニオンに対する `builder` チェックで完全な絞り込みができない。`BaseBuildEntry` がユニオンのメンバーに含まれているため、`builder` が `undefined` であるケースが常に残る。設計上は「ユーザーが `builder` を省略可能にする」要件を優先した結果だが、内部処理で型の恩恵が薄くなるトレードオフがある。

```typescript
// Bad: BaseBuildEntry が optional builder を持ちユニオンに混在
export type BuildEntry =
  | BaseBuildEntry        // builder?: ... (optional)
  | RollupBuildEntry      // builder: "rollup" (required)
  | ...

// Better: ユーザー入力型と内部処理型を分離する
type UserBuildEntry = BaseBuildEntry | RollupBuildEntry | ...;
type ResolvedBuildEntry = Required<Pick<BaseBuildEntry, "builder">> & BuildEntry;
```

## 導出ルール

- `[MUST]` ライブラリの設定型は「内部用（全フィールド必須）」と「ユーザー向け（DeepPartial）」を分離する
  - 根拠: unbuild は `BuildOptions`（内部）と `BuildConfig`（外部）を分け、デフォルト値注入後に内部型へ変換している（`src/types.ts:43-195`）
- `[MUST]` ユーザー向け設定に型安全なヘルパー関数（`defineXxxConfig`）を提供する
  - 根拠: `defineBuildConfig` と `definePreset` により、型注釈なしで IDE 補完が得られる（`src/types.ts:204-212`）
- `[SHOULD]` サブモジュールの型は各モジュールの `types.ts` で定義し、パッケージのルート型ファイルから `export type` で re-export する
  - 根拠: 4つのビルダーが各自 `types.ts` を持ち、`src/types.ts` で一括 re-export する構成により、型の責務が分散され変更影響が局所化されている
- `[SHOULD]` 判別可能ユニオンのバリアントが「省略可能なデフォルト値を持つ基底型」を含む場合、ユーザー入力型と内部処理型を分けてディスクリミナントの強度を維持する
  - 根拠: `BaseBuildEntry.builder?` が optional のため `.filter()` 後に `as` キャストが4箇所で必要になっている（`src/builders/*/index.ts`）
- `[SHOULD]` オプショナルなプラグイン・機能の設定型には `OptionsType | false` パターンを使い、`undefined`（未設定）と `false`（明示的無効化）を区別する
  - 根拠: 6つの Rollup プラグイン設定が全て `PluginOptions | false` で統一されている（`src/builders/rollup/types.ts:65-100`）
- `[SHOULD]` ディープマージ関数の戻り値には `satisfies` でデフォルト値の型整合性を検証し、`as` で最終型を確定する二段構えを使う
  - 根拠: `defu` の汎用的な戻り値型では `BuildOptions` として扱えないため、`satisfies` + `as` で安全性と実用性を両立させている（`src/build.ts:98-175`）
- `[AVOID]` `.filter()` のコールバックで判別可能ユニオンを絞り込む際に `as` キャストを使う -- 代わりに型ガード関数を定義する
  - 根拠: 4つのビルダーで同一の `as XxxBuildEntry[]` キャストが繰り返されており、型ガード関数に統一すれば型安全性が向上する

## 適用チェックリスト

- [ ] 設定型が「内部用（必須フィールド）」と「ユーザー向け（optional フィールド）」に分離されているか
- [ ] ユーザー向けに `defineXxxConfig` 等の型安全なヘルパー関数を公開しているか
- [ ] 判別可能ユニオンのディスクリミナントフィールドが、ユーザー入力時の optional 要件と内部処理での絞り込み要件を両立できているか
- [ ] プラグインや機能の無効化を `undefined` と `false` で意味的に区別しているか
- [ ] サブモジュールの型が各モジュール内で定義され、ルートの型ファイルから `export type` で re-export されているか
- [ ] ディープマージやデフォルト値注入の結果に対して、`satisfies` で入力値の型検証と `as` で出力型の確定を行っているか
- [ ] `.filter()` 後のユニオン型絞り込みに型ガード関数を使っているか（`as` キャストに頼っていないか）
