# configuration-patterns

> リポジトリ: unjs/unbuild
> 分析日: 2026-02-16

## 概要

unbuild はゼロコンフィグでも動作し、必要に応じて段階的にカスタマイズできる設定システムを持つ。`package.json` の `exports`/`main`/`bin` フィールドからビルドエントリを自動推論し、`defu` によるディープマージで部分的なオーバーライドを可能にし、プリセット機構で設定の再利用を提供する。この「何も書かなくても正しく動く → 必要な部分だけ上書きする → プリセットで共有する」という3層の段階的設定カスタマイズは、ビルドツールに限らず広く応用可能な設計パターンである。

## 背景にある原則

- **Convention over Configuration（規約による設定省略）**: `package.json` という既存のメタデータから出力形式・エントリポイント・型宣言の要否を自動推論することで、設定ファイルの記述量をゼロにできる。新たな設定フォーマットを発明するのではなく、既存のエコシステム標準を入力として活用すべきである。根拠: `src/auto.ts:69-169` の `inferEntries` 関数が `pkg.exports`/`pkg.main`/`pkg.module`/`pkg.bin`/`pkg.types` を網羅的にパースしている。

- **DeepPartial による段階的オーバーライド**: ユーザー設定の型を `DeepPartial<Omit<BuildOptions, "entries">>` とすることで、巨大な設定オブジェクトの一部だけを安全に上書きできる。設定全体を再定義させるのではなく、差分だけを受け取るべきである。根拠: `src/types.ts:177-179` の `BuildConfig` 型定義。

- **明示的なデフォルト値の一元管理**: デフォルト値を `defu` のマージチェーンの末尾に単一のオブジェクトリテラルとして配置し、`satisfies BuildOptions` で型安全性を担保する。デフォルト値が複数箇所に散在すると変更時の影響範囲が把握できなくなるため、一箇所に集約すべきである。根拠: `src/build.ts:98-174` の `defu` 呼び出し。

- **false でプラグインを無効化するユニオン型パターン**: `esbuild: EsbuildOptions | false` のように、設定値と `false` のユニオン型を使い、プラグインの有効/無効をユーザーが制御できるようにする。boolean フラグを別途用意するのではなく、設定値自体に無効化の意味を持たせるべきである。根拠: `src/builders/rollup/types.ts:64-107` の `RollupBuildOptions` 内の各プラグインオプション。

## 実例と分析

### 1. ゼロコンフィグ自動推論の実装

unbuild の自動推論はプリセットとして実装されている。`autoPreset` は `build:prepare` フックで動作し、エントリが明示されていない場合にのみ自動推論を行う。

```typescript
// src/auto.ts:17-62
export const autoPreset: BuildPreset = definePreset(() => {
  return {
    hooks: {
      "build:prepare"(ctx): void {
        // Disable auto if entries already provided or pkg not available
        if (!ctx.pkg || ctx.options.entries.length > 0) {
          return;
        }
        const sourceFiles = listRecursively(join(ctx.options.rootDir, "src"));
        const res = inferEntries(ctx.pkg, sourceFiles, ctx.options.rootDir);
        // ...
        ctx.options.entries.push(...res.entries);
```

注目すべきは、自動推論が「プリセットの1つ」として実装されている点である。特別な分岐ロジックではなく、フック機構を通じて動作するため、ユーザーが別のプリセットを指定すれば自然にオーバーライドされる。

### 2. defu による4層マージチェーン

設定のマージは `defu` を使った明確な優先順位で行われる。

```typescript
// src/build.ts:88-95
const preset = await resolvePreset(
  buildConfig.preset
    || pkg.unbuild?.preset
    || pkg.build?.preset
    || inputConfig.preset
    || "auto",
  rootDir,
);

// src/build.ts:98-175
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
    // ... 以下略
  } satisfies BuildOptions,
) as BuildOptions;
```

`defu` はディープマージを行うが、配列はマージせず上書きする。これにより、上位レイヤーが `entries` を指定すればそれが使われ、指定しなければ下位レイヤーのものが採用される。

### 3. プリセットの柔軟な解決メカニズム

プリセットは3つの形式をサポートする: オブジェクト・関数・文字列（モジュールパス）。

```typescript
// src/types.ts:169
export type BuildPreset = BuildConfig | (() => BuildConfig);

// src/utils.ts:72-88
export async function resolvePreset(
  preset: string | BuildPreset,
  rootDir: string,
): Promise<BuildConfig> {
  if (preset === "auto") {
    preset = autoPreset;
  } else if (typeof preset === "string") {
    preset = (await createJiti(rootDir, { interopDefault: true }).import(preset, {
      default: true,
    })) || {};
  }
  if (typeof preset === "function") {
    preset = preset();
  }
  return preset as BuildConfig;
}
```

文字列の場合は `jiti` で動的にインポートされるため、ユーザーは `preset: "./build.preset"` のように別ファイルを参照したり、npm パッケージを指定できる。

### 4. 型安全なヘルパー関数

`defineBuildConfig` と `definePreset` は薄いラッパーだが、TypeScript の型推論を活性化する重要な役割を果たす。

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

`definePreset` は引数をそのまま返すだけだが、これにより `export default definePreset({...})` と書くとエディタで型補完が効く。ランタイムコストなしで DX を向上させる技法である。

### 5. プラグイン有効/無効の条件付き構築

Rollup プラグインの配列は、設定値が `false` でないことを条件として構築される。

```typescript
// src/builders/rollup/config.ts:114-166
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
  // ...
  ctx.options.rollup.esbuild &&
    esbuild({
      sourcemap: ctx.options.sourcemap,
      ...ctx.options.rollup.esbuild,
    }),
  // ...
].filter((p): p is NonNullable<Exclude<typeof p, false>> => !!p),
```

`&&` による短絡評価で `false` の場合はプラグインが生成されず、末尾の `.filter()` で falsy 値が除去される。

### 6. フック機構による設定の動的拡張

フックは `hookable` ライブラリで実装されており、preset、inputConfig、buildConfig の3レイヤーから登録される。

```typescript
// src/build.ts:194-203
if (preset.hooks) {
  ctx.hooks.addHooks(preset.hooks);
}
if (inputConfig.hooks) {
  ctx.hooks.addHooks(inputConfig.hooks);
}
if (buildConfig.hooks) {
  ctx.hooks.addHooks(buildConfig.hooks);
}
```

フックは「設定のマージ」ではなく「追加的に登録」される。これにより、プリセットのフックとユーザーのフックが両方実行される（上書きではなく共存する）。

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 複数のビルダー（rollup, mkdist, copy, untyped）を統一的に扱う
  - 適用条件: 同一インターフェースを持つ複数の実装を切り替える場面
  - コード例: `src/build.ts:228-229` でエントリの `builder` フィールドに応じてビルダーが選択される。`src/build.ts:293-306` で全ビルダーが同一シグネチャ `(ctx: BuildContext) => Promise<void>` で呼び出される
  - 注意点: unbuild では明示的な Strategy インターフェースは定義されておらず、暗黙の契約に依存している

- **Null Object / Auto-detect パターン** (分類: 振る舞い)
  - 解決する問題: 設定が省略された場合にもシステムが正しく動作する必要がある
  - 適用条件: デフォルトの振る舞いが推論可能で、かつユーザーが明示的に上書きしたい場面
  - コード例: `src/auto.ts:17-62` の `autoPreset` がデフォルトプリセットとして機能し、設定が空の場合にフックで自動推論を実行する
  - 注意点: 自動推論の結果が期待と異なった場合のデバッグが困難になりうる。unbuild は `consola.info` でログを出力して対処している

## Good Patterns

- **Identity Function Helper（define ヘルパー）**: `defineBuildConfig` や `definePreset` のように、型推論のためだけに存在する identity 関数を提供する。ランタイムコストはゼロだが、ユーザーはエディタで補完・バリデーションを得られる。

```typescript
// src/types.ts:210-212
export function definePreset(preset: BuildPreset): BuildPreset {
  return preset;
}

// test/fixture/build.preset.ts:3-16 （利用側）
export default definePreset({
  declaration: "compatible",
  rollup: {
    cjsBridge: true,
  },
  hooks: {/* ... */},
});
```

- **OptionOrFalse ユニオン型によるプラグイン制御**: プラグインの設定型を `Options | false` とし、`false` でプラグインを完全に無効化できるようにする。`enabled: boolean` を別途持つよりシンプルで、`defu` によるマージとも相性が良い。

```typescript
// src/builders/rollup/types.ts:92-94
esbuild: EsbuildOptions | false;

// src/builders/rollup/config.ts:144-148 （利用側）
ctx.options.rollup.esbuild &&
  esbuild({
    sourcemap: ctx.options.sourcemap,
    ...ctx.options.rollup.esbuild,
  }),
```

- **satisfies によるデフォルトオブジェクトの型チェック**: デフォルト値オブジェクトに `satisfies BuildOptions` を付けることで、デフォルト値が型定義と一致していることをコンパイル時に保証する。`as` とは異なり型を狭めないため、リテラル型の情報が保持される。

```typescript
// src/build.ts:103-174
const options = defu(
  buildConfig,
  // ...
  {
    name: (pkg?.name || "").split("/").pop() || "default",
    rootDir,
    entries: [],
    clean: true,
    // ...
  } satisfies BuildOptions,
) as BuildOptions;
```

## Anti-Patterns / 注意点

- **過剰な自動推論による予測不能性**: ゼロコンフィグは便利だが、推論ロジックが複雑になると「なぜこのビルド結果になったのか」が追跡困難になる。unbuild は `consola.info("Automatically detected entries:", ...)` でログ出力して緩和しているが、推論の各ステップを可視化する仕組みが理想的である。

```typescript
// Bad: 自動推論の結果をサイレントに適用する
ctx.options.entries.push(...res.entries);

// Better: unbuild の実装のように、推論結果を明示的にログ出力する
consola.info(
  "Automatically detected entries:",
  colors.cyan(
    ctx.options.entries
      .map((e) => colors.bold(e.input.replace(ctx.options.rootDir + "/", "")))
      .join(", "),
  ),
);
```

- **defu マージ後の型アサーション**: `defu` の戻り値型は元の引数の型に依存するため、最終的な型が `BuildOptions` と完全に一致する保証がない。unbuild は `as BuildOptions` でキャストしている。

```typescript
// Bad: defu の結果をそのまま使う（型が DeepPartial のまま）
const options = defu(buildConfig, preset, defaults);

// Better: satisfies で入力を検証し、as で出力を断言する（unbuild のアプローチ）
const options = defu(
  buildConfig,
  preset,
  {/* ... */} satisfies BuildOptions,
) as BuildOptions;
```

マージライブラリの型推論には限界があるため、入力側を `satisfies` で、出力側を `as` で守るのが現実的な妥協点である。

## 導出ルール

- `[MUST]` 設定オブジェクトのデフォルト値は単一の場所に集約し、マージチェーンの最低優先位置に配置する
  - 根拠: `src/build.ts:98-174` で `defu` の最終引数にデフォルト値を `satisfies BuildOptions` 付きで一元配置し、散在を防止している

- `[MUST]` 自動推論やゼロコンフィグ機能を実装する場合、推論結果をログ等で明示的にユーザーに通知する
  - 根拠: `src/auto.ts:39-58` で推論されたエントリと設定フラグを `consola.info` で出力し、暗黙の動作を可視化している

- `[SHOULD]` ユーザー設定の型には `DeepPartial` を適用し、変更したいプロパティだけを記述できるようにする
  - 根拠: `src/types.ts:177-179` で `BuildConfig extends DeepPartial<Omit<BuildOptions, "entries">>` とし、全プロパティをオプショナルにしている

- `[SHOULD]` 型安全な設定ヘルパー（`defineXxxConfig` 関数）を提供し、IDE 補完を有効にする。関数はランタイムで引数をそのまま返す identity 関数でよい
  - 根拠: `src/types.ts:204-212` の `defineBuildConfig`/`definePreset` がランタイムコストなしで型補完を提供している

- `[SHOULD]` プラグインや機能モジュールの有効/無効切り替えには `Options | false` ユニオン型を使い、`false` で無効化できるようにする
  - 根拠: `src/builders/rollup/types.ts:64-107` で全プラグインオプションが `SpecificOptions | false` 型を持ち、`src/builders/rollup/config.ts:114-166` で `&&` 短絡評価による条件付き構築に活用されている

- `[SHOULD]` プリセット機構を設けて設定の再利用を可能にする場合、オブジェクト・関数・文字列（モジュールパス）の3形式をサポートする
  - 根拠: `src/utils.ts:72-88` の `resolvePreset` が3形式を統一的に解決し、`test/fixture/build.config.ts:8` で `preset: "./build.preset"` のように利用されている

- `[AVOID]` ディープマージライブラリの戻り値型を信頼して型アサーションを省略すること。入力を `satisfies` で検証し、出力を `as` で明示する
  - 根拠: `src/build.ts:174-175` で `satisfies BuildOptions` と `as BuildOptions` を組み合わせ、`defu` の型推論の限界を補っている

## 適用チェックリスト

- [ ] 設定オブジェクトにデフォルト値を持つプロパティがある場合、デフォルト値を単一のオブジェクトに集約しているか
- [ ] ユーザー設定の型は `DeepPartial` で全プロパティがオプショナルになっているか（必須プロパティは `Omit` で除外）
- [ ] `defineXxxConfig` のような型安全ヘルパーを提供しているか
- [ ] ディープマージを使う場合、マージの優先順位（ユーザー設定 > パッケージ設定 > プリセット > デフォルト）が明確に定義されているか
- [ ] 自動推論やゼロコンフィグ機能の推論結果をログで通知しているか
- [ ] プラグインの有効/無効切り替えに `Options | false` パターンを採用しているか
- [ ] プリセットや設定の共有メカニズムが設計に含まれているか
- [ ] デフォルト値オブジェクトに `satisfies` を付けてコンパイル時検証しているか
