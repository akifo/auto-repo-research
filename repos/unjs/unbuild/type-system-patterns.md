# type-system-patterns

> リポジトリ: unjs/unbuild
> 分析日: 2026-02-18

## 概要

unbuild の型設計パターンを分析する。複数のビルダー（rollup, mkdist, copy, untyped）を統合するビルドシステムにおいて、discriminated union による型安全なエントリ分岐、`DeepPartial` による設定型の段階的具体化、`satisfies` 演算子による型検証、型レベルでのプラグイン有効/無効制御など、ライブラリ設定 API を型安全に設計する実践的なパターンが豊富に見られる。特に「内部表現は厳密、外部 API は柔軟」という二層構造の型設計が一貫して適用されている点が注目に値する。

## 背景にある原則

- **設定の段階的具体化 (Progressive Narrowing)**: ユーザーが渡す設定（`BuildConfig`）は `DeepPartial` で全フィールドをオプショナルにし、内部処理で使う型（`BuildOptions`）はデフォルト値注入後に全フィールドが確定した厳密な型とする。これにより、ユーザーの DX（最小限の設定で動作）と内部コードの型安全性を両立する。根拠: `src/types.ts:171-195` の `BuildConfig` が `DeepPartial<Omit<BuildOptions, "entries">>` を extends している設計。

- **判別共用体による安全な分岐 (Discriminated Union Dispatch)**: ビルダーの種類を `builder` リテラル型フィールドで判別し、各ビルダー固有の設定を型安全に扱う。ランタイムの `entry.builder === "rollup"` チェックがそのまま TypeScript の型ガードとして機能するため、型アサーション不要で分岐できるべき。根拠: `src/types.ts:14-41` の `BaseBuildEntry` と `BuildEntry` union の設計。

- **`false` リテラルによる機能無効化の型表現**: プラグインオプションに `OptionsType | false` を許容することで、「設定をカスタマイズ」と「完全に無効化」の両方を単一フィールドで型安全に表現する。`undefined`（デフォルト使用）との区別も明確になる。根拠: `src/builders/rollup/types.ts:60-106` の全プラグイン設定。

- **フック型による拡張ポイントの契約 (Hook Type Contracts)**: 各ビルダーが独自のフック interface を定義し、それらを `BuildHooks` で intersection して統合する。フック名を string literal 型で定義することで、`hooks.callHook("build:prepare", ctx)` のような呼び出しが型チェックされる。根拠: `src/types.ts:197-202` の `BuildHooks` が4つのフック interface を extends する構造。

## 実例と分析

### 1. Discriminated Union と型安全なフィルタリング

unbuild は4種類のビルダーを統合しており、各エントリは `builder` フィールドで判別される。`BaseBuildEntry` が基底型となり、各ビルダーが `builder` リテラル型を固定した派生 interface を定義する。

```typescript
// src/types.ts:14-20
export interface BaseBuildEntry {
  builder?: "untyped" | "rollup" | "mkdist" | "copy";
  input: string;
  name?: string;
  outDir?: string;
  declaration?: "compatible" | "node16" | boolean;
}

// src/types.ts:36-41
export type BuildEntry =
  | BaseBuildEntry
  | RollupBuildEntry
  | UntypedBuildEntry
  | MkdistBuildEntry
  | CopyBuildEntry;
```

各ビルダーの実装では、`filter` + `as` で型を絞り込む。このパターンはコードベース全体で統一されている。

```typescript
// src/builders/mkdist/index.ts:8-10
const entries = ctx.options.entries.filter(
  (e) => e.builder === "mkdist",
) as MkdistBuildEntry[];
```

```typescript
// src/builders/copy/index.ts:11-13
const entries = ctx.options.entries.filter(
  (e) => e.builder === "copy",
) as CopyBuildEntry[];
```

注目点として、`filter` の返り値を `as` でキャストしている。TypeScript の `filter` は type predicate を書かない限り配列の型を絞り込めないため、現実的な妥協である。ただし、type predicate 関数（例: `(e): e is CopyBuildEntry => e.builder === "copy"`）を使えば `as` を回避できる。

### 2. DeepPartial による設定の二層構造

ユーザー向け API の `BuildConfig` は全フィールドがオプショナルだが、内部の `BuildOptions` は必須フィールドを持つ。`defu` によるデフォルトマージ後に `as BuildOptions` でキャストすることで、段階的に型を具体化する。

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

`BuildConfig.entries` は `(BuildEntry | string)[]` を受け付けるが、`BuildOptions.entries` は `BuildEntry[]` のみ。`build.ts` の正規化処理で string を `{ input: entry }` に変換している。

```typescript
// src/build.ts:209-211
options.entries = options.entries.map((entry) =>
  typeof entry === "string" ? { input: entry } : entry,
);
```

`Omit<BuildOptions, "entries">` で `entries` を除外してから `DeepPartial` を適用し、独自の `entries` 定義で上書きしている点が重要。これにより `entries` だけ異なる型（string も受付可能）にできる。

### 3. `satisfies` 演算子による型検証パターン

`satisfies` は値の型推論を保持しつつ、特定の型に適合するかをコンパイル時に検証する。unbuild では2つの場面で使い分けられている。

**デフォルト値の型検証**:

```typescript
// src/build.ts:98-174
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
    // ... (多数のデフォルト値)
  } satisfies BuildOptions,
) as BuildOptions;
```

`satisfies BuildOptions` により、デフォルトオブジェクトが `BuildOptions` の全フィールドを網羅しているか検証される。新しいフィールドが `BuildOptions` に追加された場合、デフォルト値の定義漏れがコンパイルエラーになる。

**Rollup 設定の型検証**:

```typescript
// src/builders/rollup/config.ts:167
} satisfies RollupOptions;
```

```typescript
// src/builders/rollup/plugins/json.ts:25
} satisfies Plugin;
```

### 4. `OptionsType | false` によるプラグイン有効/無効制御

Rollup プラグインの設定は全て `OptionsType | false` 型を採用し、`false` で完全無効化できる。

```typescript
// src/builders/rollup/types.ts:60-106
export interface RollupBuildOptions {
  replace: RollupReplaceOptions | false;
  alias: RollupAliasOptions | false;
  resolve: RollupNodeResolveOptions | false;
  json: RollupJsonOptions | false;
  esbuild: EsbuildOptions | false;
  commonjs: RollupCommonJSOptions | false;
  dts: RollupDtsOptions; // dts は無効化不可
}
```

ランタイムでは truthy チェックでプラグインの有無を制御する。

```typescript
// src/builders/rollup/config.ts:114-166
plugins: [
  ctx.options.rollup.replace &&
    replace({ ...ctx.options.rollup.replace, /* ... */ }),
  ctx.options.rollup.alias &&
    alias({ ...ctx.options.rollup.alias, entries: _aliases }),
  // ...
].filter((p): p is NonNullable<Exclude<typeof p, false>> => !!p),
```

`filter` の type predicate `(p): p is NonNullable<Exclude<typeof p, false>>` により、`false | undefined | Plugin` の配列から `Plugin[]` に安全に絞り込んでいる。

### 5. 外部ライブラリ型の安全な再利用

外部パッケージの型を直接利用せず、ラップ・拡張して使う手法が一貫している。

```typescript
// src/builders/rollup/types.ts:18
export type RollupCommonJSOptions = Parameters<typeof commonjs>[0] & {};
```

`Parameters<typeof commonjs>[0]` で関数の第1引数型を抽出し、`& {}` で交差型にすることで型の正規化（型エイリアスの展開を防ぐ）を行っている。

```typescript
// src/builders/rollup/types.ts:109-111
export interface RollupOptions extends _RollupOptions {
  plugins: Plugin[];
}
```

Rollup の `_RollupOptions` では `plugins` が `InputPluginOption`（nullable/nested array 許容）だが、unbuild 内部では `Plugin[]` に固定して型を厳密化している。

### 6. フック interface の合成

各ビルダーが独自のフック interface を定義し、それらを intersection で統合する。

```typescript
// src/types.ts:197-202
export interface BuildHooks
  extends CopyHooks, UntypedHooks, MkdistHooks, RollupHooks {
  "build:prepare": (ctx: BuildContext) => void | Promise<void>;
  "build:before": (ctx: BuildContext) => void | Promise<void>;
  "build:done": (ctx: BuildContext) => void | Promise<void>;
}
```

各フック interface は string literal キーで定義され、`hookable` ライブラリの `Hookable<BuildHooks>` によって型安全な `callHook` が実現される。

```typescript
// src/builders/copy/types.ts:8-14
export interface CopyHooks {
  "copy:entries": (
    ctx: BuildContext,
    entries: CopyBuildEntry[],
  ) => void | Promise<void>;
  "copy:done": (ctx: BuildContext) => void | Promise<void>;
}
```

## パターンカタログ

- **Discriminated Union** (分類: 構造)
  - 解決する問題: 複数のビルダー型を統合しつつ、各ビルダー固有のフィールドを型安全に扱う
  - 適用条件: 共通の基底型 + バリアント固有フィールドが存在する場合
  - コード例: `src/types.ts:14-41`
  - 注意点: `Array.filter` では型の絞り込みが効かないため、type predicate か `as` が必要

- **Builder Pattern (型レベル)** (分類: 生成)
  - 解決する問題: ユーザーは最小限の設定で、内部は完全な型を持つ設定オブジェクトを構築する
  - 適用条件: 多数のオプショナルフィールドを持つ設定型が存在し、デフォルト値で補完する場合
  - コード例: `src/types.ts:171-195` (`DeepPartial` + `Omit` + 再定義)
  - 注意点: `defu` マージ後の `as BuildOptions` キャストは型安全性を担保しない。`satisfies` との併用が重要

- **Strategy Pattern (型レベル)** (分類: 振る舞い)
  - 解決する問題: ビルダーの追加・変更時に型定義の変更箇所を限定する
  - 適用条件: プラグイン/ストラテジーが独自の設定型とフック型を持つ場合
  - コード例: `src/builders/*/types.ts` の分散定義 + `src/types.ts:197-202` の統合
  - 注意点: interface の extends による合成はキー衝突時にコンパイルエラーになるため、名前空間プレフィックス（`copy:`, `rollup:` 等）が必要

## Good Patterns

- **`satisfies` でデフォルトオブジェクトの網羅性を保証する**: デフォルト値リテラルに `satisfies FullType` を付けることで、型の全フィールドが定義されているかコンパイル時に検証できる。新フィールド追加時のデフォルト値定義漏れを防ぐ。

```typescript
// src/build.ts:174
} satisfies BuildOptions,
```

- **`OptionsType | false` でプラグインの有効/無効を型表現する**: 設定値そのもので有効/無効を制御し、別途 `enabled: boolean` フィールドを持たない。`undefined`（=デフォルト設定を使う）と `false`（=完全無効化）の意味的区別も型で表現される。

```typescript
// src/builders/rollup/types.ts:65
replace: RollupReplaceOptions | false;
```

- **フック名を string literal 型で定義し、namespace プレフィックスで衝突を防ぐ**: `"rollup:options"`, `"copy:done"` のように、各ビルダーがプレフィックス付きのフック名を定義し、interface の extends で統合しても衝突しない。

```typescript
// src/builders/rollup/types.ts:113-131
export interface RollupHooks {
  "rollup:options": (ctx: BuildContext, options: RollupOptions) => void | Promise<void>;
  "rollup:build": (ctx: BuildContext, build: RollupBuild) => void | Promise<void>;
  // ...
}
```

- **`NonNullable<Exclude<typeof p, false>>` で filter 結果を型安全にする**: `&&` 演算子による条件付きプラグイン配列構築後、type predicate 付き `filter` で `false | undefined` を除去しつつ型を絞り込む。

```typescript
// src/builders/rollup/config.ts:166
].filter((p): p is NonNullable<Exclude<typeof p, false>> => !!p),
```

## Anti-Patterns / 注意点

- **`filter` + `as` による discriminated union の絞り込み**: `Array.filter` は type predicate を明示しないと戻り値の型が絞り込まれない。unbuild では `as MkdistBuildEntry[]` のようなキャストで対処しているが、フィルタ条件のミスがあっても型エラーにならない。

```typescript
// Bad: filter 条件のミスを型が検出できない
const entries = ctx.options.entries.filter(
  (e) => e.builder === "mkdist",
) as MkdistBuildEntry[];

// Better: type predicate で型を絞り込む
const entries = ctx.options.entries.filter(
  (e): e is MkdistBuildEntry => e.builder === "mkdist",
);
```

- **`defu` マージ後の `as` キャスト**: `defu` の戻り値型は入力型のマージ結果であり、`BuildOptions` とは一致しない場合がある。`as BuildOptions` キャストは型安全性を担保しない。`satisfies` でデフォルト値の網羅性を保証しているため実害は少ないが、マージ関数の型定義改善（ジェネリクスの制約追加など）がより望ましい。

```typescript
// Bad: マージ後のキャストは型安全性の穴
const options = defu(buildConfig, preset, defaults) as BuildOptions;

// Better: satisfies との併用で穴を最小化（unbuild が採用している方式）
const options = defu(
  buildConfig,
  preset,
  { /* ... */ } satisfies BuildOptions,
) as BuildOptions;
```

## 導出ルール

- `[MUST]` ユーザー向け設定型と内部処理型を分離し、設定型は `DeepPartial` で柔軟に、内部型は全フィールド必須で厳密にする
  - 根拠: unbuild の `BuildConfig`（`DeepPartial`）と `BuildOptions`（全必須）の分離により、ユーザーは最小限の設定で動作しつつ、内部コードはオプショナルチェーン不要で安全に動作する（`src/types.ts:43-195`）

- `[MUST]` デフォルト値オブジェクトリテラルに `satisfies` を付け、型の全フィールド網羅をコンパイル時に検証する
  - 根拠: `src/build.ts:174` で `satisfies BuildOptions` を使い、`BuildOptions` に新フィールドが追加された際にデフォルト値定義漏れが即座にコンパイルエラーになる

- `[SHOULD]` 複数のバリアントを持つ型は discriminated union で表現し、`builder` や `type` 等の string literal フィールドで判別する
  - 根拠: `src/types.ts:36-41` の `BuildEntry` union と各ビルダーの `builder: "rollup"` 等のリテラル型により、ランタイムのフィルタ条件がそのまま型ガードとして機能する

- `[SHOULD]` プラグイン/機能の有効/無効は `OptionsType | false` で表現し、`enabled: boolean` の別フィールドを持たない
  - 根拠: `src/builders/rollup/types.ts:60-106` で全プラグイン設定が `OptionsType | false` を採用し、`undefined`（デフォルト使用）/ オプション指定 / `false`（無効化）の三状態を単一フィールドで型安全に表現している

- `[SHOULD]` 複数モジュールのフック/イベント型を統合する際は、string literal キーに namespace プレフィックスを付けて interface の intersection で合成する
  - 根拠: `src/types.ts:197-202` で `CopyHooks`, `UntypedHooks`, `MkdistHooks`, `RollupHooks` を `extends` で合成し、`"copy:done"`, `"rollup:done"` のようにプレフィックスでキー衝突を防いでいる

- `[SHOULD]` 外部ライブラリの型を内部で利用する際は、interface extends や `Parameters<typeof fn>` で再定義・抽出し、内部の型制約を厳密にする
  - 根拠: `src/builders/rollup/types.ts:109-111` で Rollup の `_RollupOptions` を extends して `plugins: Plugin[]`（nullable 不可）に厳密化し、`src/builders/rollup/types.ts:18` では `Parameters<typeof commonjs>[0] & {}` で関数引数型を抽出している

- `[AVOID]` `Array.filter` の結果を `as SomeType[]` でキャストする。type predicate `(e): e is SomeType => ...` を使って型を絞り込む
  - 根拠: `src/builders/mkdist/index.ts:8-10` 等で `as MkdistBuildEntry[]` を使用しているが、フィルタ条件の誤りを型チェッカーが検出できない。一方 `src/builders/rollup/config.ts:166` では type predicate を使った安全なフィルタリングが実践されている

## 適用チェックリスト

- [ ] ライブラリの設定型は `DeepPartial<InternalOptions>` で定義し、内部型と分離しているか
- [ ] デフォルト値オブジェクトに `satisfies` を付けて網羅性を検証しているか
- [ ] 複数バリアントを持つ型に discriminated union を使い、string literal フィールドで判別しているか
- [ ] プラグインや機能の有効/無効制御に `OptionsType | false` パターンを採用しているか
- [ ] `Array.filter` の型絞り込みに type predicate を使用しているか（`as` キャストを避けているか）
- [ ] 外部ライブラリの型を内部で再利用する際、interface extends や `Parameters` で必要な制約を追加しているか
- [ ] フック/イベント型に namespace プレフィックスを付けて、intersection で合成しても衝突しないようにしているか
- [ ] `satisfies` と `as` の使い分けが適切か（`satisfies` = 型検証、`as` = 型変換）
