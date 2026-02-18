# 抽象化パターン

> リポジトリ: unjs/unbuild
> 分析日: 2026-02-18

## 概要

unbuild は 4 つの異なるビルドバックエンド（rollup, mkdist, untyped, copy）を統一的なインターフェースで操作するビルドツールである。この視点では、Builder 抽象、設定のマルチソースマージ、フック機構による拡張点の設計、そして型レベルでの構成可能性（Composability）を分析する。小規模ながら多層の抽象化が凝縮されており、「設定オブジェクトをどう構造化し、どう合成するか」の実践的なリファレンスとして注目に値する。

## 背景にある原則

- **Convention over Configuration（規約優先）**: ユーザーが何も設定しなくても `package.json` の `exports` フィールドからビルドエントリを自動推論する（`src/auto.ts:17-62`）。明示的設定は規約のオーバーライドとして機能する。これにより zero-config の体験を実現しつつ、エスケープハッチも保持する。
- **DeepPartial による段階的確定**: ユーザー入力型（`BuildConfig`）と内部処理型（`BuildOptions`）を分離し、前者は `DeepPartial` で全フィールドをオプショナルに、後者は必須フィールドを持つ確定型とする（`src/types.ts:171-195`）。これにより「設定が欠けていてもエラーにならない」入力層と「処理時に型安全が保証される」実行層を両立する。
- **フックによる関心の分散**: ビルドライフサイクルの各段階にフックポイントを設け、ビルダー固有のロジックとユーザーのカスタマイズを同じ仕組みで注入する。autoPreset 自体が `build:prepare` フックとして実装されており（`src/auto.ts:20`）、コア機能とプリセットが同じ拡張メカニズムを共有する。
- **Discriminated Union による Builder 分岐**: `builder` フィールドをタグとする判別共用体（`BuildEntry` 型）で、各ビルダーのエントリ型を型安全に区別する（`src/types.ts:36-41`）。ランタイムのフィルタリング（`e.builder === "rollup"`）と型の絞り込みが一致する。

## 実例と分析

### 1. マルチソース設定マージ

unbuild の設定は最大 5 つのソースから合成される。`_build` 関数内の `defu()` 呼び出しがその中核である。

```typescript
// src/build.ts:98-174
const options = defu(
  buildConfig,          // 1. build.config.ts の個別設定
  pkg.unbuild || pkg.build,  // 2. package.json の unbuild/build フィールド
  inputConfig,          // 3. CLI 引数からの設定
  preset,               // 4. プリセット（auto or カスタム）
  { /* デフォルト値 */ } satisfies BuildOptions,  // 5. ハードコードデフォルト
) as BuildOptions;
```

`defu`（deep defaults utility）は「先に定義された値が優先される」セマンティクスを持つ。つまり `buildConfig` の値が最優先で、未定義のフィールドだけが後続ソースで埋められる。この方式には以下の設計判断がある。

- **優先順位が引数の順序に直接対応する**: マージ関数の引数順を見るだけで優先順位が分かる。`Object.assign` のような「後勝ち」セマンティクスより直感的。
- **`satisfies` による型安全なデフォルト**: デフォルトオブジェクトに `satisfies BuildOptions` を付与し、デフォルト値のオブジェクトが `BuildOptions` を完全に満たしていることをコンパイル時に保証する。

### 2. Preset 抽象 — 関数 or オブジェクト

プリセットは `BuildConfig | (() => BuildConfig)` という単純な合併型で表現される。

```typescript
// src/types.ts:169
export type BuildPreset = BuildConfig | (() => BuildConfig);
```

解決ロジック（`src/utils.ts:72-88`）は 3 段階のディスパッチを行う。

1. `"auto"` 文字列 → 組み込み `autoPreset` に解決
2. 任意の文字列 → `jiti.import()` で動的インポート
3. 関数 → 呼び出して結果を取得

この設計により、プリセットは「静的オブジェクト」「ファクトリ関数」「npm パッケージ名」のいずれでも指定でき、利用側のコード変更なしに提供形態を切り替えられる。

### 3. Builder 統一インターフェース

4 つのビルダーは明示的な interface を共有しないが、暗黙の契約で統一されている。

```typescript
// src/build.ts:293-298
const buildTasks = [
  typesBuild,   // (ctx: BuildContext) => Promise<void>
  mkdistBuild,
  rollupBuild,
  copyBuild,
] as const;
```

各ビルダーは以下の共通パターンに従う。

1. `ctx.options.entries` から自分の `builder` タグを持つエントリをフィルタリング
2. `ctx.hooks.callHook("<builder>:entries", ...)` でエントリ一覧を通知
3. 各エントリを処理
4. `ctx.hooks.callHook("<builder>:done", ...)` で完了を通知

この「暗黙の契約」は interface として型定義されていないが、全ビルダーが一貫して遵守している。ビルダー数が 4 つという小規模だからこそ、明示的 interface を導入せず、代わりにフック型定義（`BuildHooks`）で契約を表現する判断が合理的に機能している。

### 4. フック型のインターフェース合成

`BuildHooks` は 4 つのビルダーフックと 3 つのコアフックを `extends` で合成する。

```typescript
// src/types.ts:197-202
export interface BuildHooks
  extends CopyHooks, UntypedHooks, MkdistHooks, RollupHooks {
  "build:prepare": (ctx: BuildContext) => void | Promise<void>;
  "build:before": (ctx: BuildContext) => void | Promise<void>;
  "build:done": (ctx: BuildContext) => void | Promise<void>;
}
```

各ビルダーは自分のフック型をローカルに定義し（例: `src/builders/mkdist/types.ts:9-25`）、中央の `BuildHooks` がそれらを集約する。この設計は以下を実現する。

- ビルダーがフックの型定義を自己完結的に保持（変更がビルダー内で閉じる）
- ユーザーは `BuildHooks` の一枚型で全フックを参照できる
- `hookable` ライブラリが `Hookable<BuildHooks>` として型安全なフック呼び出しを提供

### 5. フック粒度のライフサイクル設計

各ビルダーのフックは一貫した粒度パターンに従う。

| 粒度 | 命名パターン | 例 | 用途 |
|---|---|---|---|
| 一覧レベル | `<builder>:entries` | `mkdist:entries` | エントリ一覧の変更 |
| エントリレベル（オプション） | `<builder>:entry:options` | `mkdist:entry:options` | 個別エントリの設定変更 |
| エントリレベル（結果） | `<builder>:entry:build` | `mkdist:entry:build` | ビルド結果への介入 |
| 完了 | `<builder>:done` | `mkdist:done` | 後処理 |

rollup ビルダーはさらに DTS ビルドフェーズ用のフック（`rollup:dts:options`, `rollup:dts:build`）を追加しており、ビルダーの複雑度に応じてフック粒度を拡張できることを示す。

### 6. `OptionType | false` による機能の無効化

Rollup プラグインのオプション型は一貫して `OptionsType | false` のパターンを採用する。

```typescript
// src/builders/rollup/types.ts:60-106
replace: RollupReplaceOptions | false;
alias: RollupAliasOptions | false;
resolve: RollupNodeResolveOptions | false;
json: RollupJsonOptions | false;
esbuild: EsbuildOptions | false;
commonjs: RollupCommonJSOptions | false;
```

設定ファイル構築側（`src/builders/rollup/config.ts:114-166`）ではこれを利用して条件付きプラグイン組み立てを行う。

```typescript
plugins: [
  ctx.options.rollup.replace && replace({ ...ctx.options.rollup.replace }),
  ctx.options.rollup.alias && alias({ ...ctx.options.rollup.alias }),
  // ...
].filter((p): p is NonNullable<Exclude<typeof p, false>> => !!p),
```

`false` を設定すると対応するプラグインがスキップされる。`undefined` ではなく `false` を使うのは意図的な「無効化」と「未設定」を区別するためである。

### 7. 入力の柔軟な正規化

エントリ定義は `string | BuildEntry` の合併型で受け付け、処理前に正規化する。

```typescript
// src/types.ts:183
entries?: (BuildEntry | string)[];

// src/build.ts:209-238
options.entries = options.entries.map((entry) =>
  typeof entry === "string" ? { input: entry } : entry,
);
```

さらに `builder` 未指定時のデフォルト推論も行う（`src/build.ts:228-229`）。

```typescript
if (!entry.builder) {
  entry.builder = entry.input.endsWith("/") ? "mkdist" : "rollup";
}
```

入力の末尾 `/` でビルダー種別を推論するのは小さな規約だが、zero-config 体験を支える重要な要素である。

## コード例

```typescript
// src/types.ts:169-195 — BuildConfig と BuildOptions の分離
type DeepPartial<T> = { [P in keyof T]?: DeepPartial<T[P]> };

export interface BuildConfig extends DeepPartial<
  Omit<BuildOptions, "entries">
> {
  entries?: (BuildEntry | string)[];
  preset?: string | BuildPreset;
  hooks?: Partial<BuildHooks>;
}
```

```typescript
// src/build.ts:194-203 — 多層フック登録
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

```typescript
// src/auto.ts:17-62 — プリセットがフックとして自己実装される
export const autoPreset: BuildPreset = definePreset(() => {
  return {
    hooks: {
      "build:prepare"(ctx): void {
        if (!ctx.pkg || ctx.options.entries.length > 0) {
          return;
        }
        const sourceFiles = listRecursively(join(ctx.options.rootDir, "src"));
        const res = inferEntries(ctx.pkg, sourceFiles, ctx.options.rootDir);
        ctx.options.entries.push(...res.entries);
        // ...
      },
    },
  };
});
```

```typescript
// src/builders/rollup/config.ts:114-166 — 条件付きプラグイン組み立て
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
  // ... 省略
].filter((p): p is NonNullable<Exclude<typeof p, false>> => !!p),
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 複数のビルドバックエンドを同一インターフェースで切り替える
  - 適用条件: 入力の `builder` フィールドで実行時にストラテジーが決定される
  - コード例: `src/build.ts:293-306` — `buildTasks` 配列による戦略の列挙と逐次/並列実行
  - 注意点: 明示的な Strategy interface は定義されていない。ビルダー数が少ないため配列に直接列挙する方式が採用されている。ビルダー数が増える場合はレジストリパターンへの移行が適切

- **Builder パターン** (分類: 生成)
  - 解決する問題: 多数のオプションを持つ設定オブジェクトを段階的に構築する
  - 適用条件: マルチソースからの設定マージ、デフォルト値の段階的適用
  - コード例: `src/build.ts:98-174` — `defu()` による段階的設定確定
  - 注意点: GoF の Builder とは異なり、`director` に相当するものがなく、`defu` のマージセマンティクスが構築順序を制御する

- **Observer パターン** (分類: 振る舞い)
  - 解決する問題: ビルドライフサイクルの各段階に外部ロジックを挿入する
  - 適用条件: プリセット・ユーザー設定・ビルダー内部が同じフックメカニズムで連携する
  - コード例: `src/build.ts:194-206` — 多層フック登録、`src/builders/rollup/build.ts:24` — フック呼び出し
  - 注意点: `hookable` ライブラリが実装を提供。フックは同期・非同期の両方に対応（`void | Promise<void>`）

- **Null Object パターン変形** (分類: 振る舞い)
  - 解決する問題: プラグインの有効/無効を分岐ロジックなしで切り替える
  - 適用条件: `OptionType | false` パターンで `false` 設定時にプラグインを生成しない
  - コード例: `src/builders/rollup/config.ts:115-166` — 真偽値ショートサーキットと `filter(Boolean)`
  - 注意点: 厳密な Null Object ではなく、条件付き配列要素の排除で同等の効果を得ている

## Good Patterns

- **`satisfies` によるデフォルト値の型保証**: デフォルト値オブジェクトに `satisfies BuildOptions` を付与することで、デフォルト値がスキーマを完全に満たしていることをコンパイル時に検証する（`src/build.ts:174`）。`as BuildOptions` と異なり、値の型が変わらないため narrowing が維持される。

```typescript
// src/build.ts:103-174
const options = defu(
  buildConfig,
  // ... 他のソース
  {
    name: (pkg?.name || "").split("/").pop() || "default",
    rootDir,
    entries: [],
    clean: true,
    // ... 全フィールドを網羅
  } satisfies BuildOptions,
) as BuildOptions;
```

- **`defineBuildConfig` / `definePreset` ヘルパー**: 実行時には何もしない identity 関数だが、TypeScript の型推論を支援し、IDE の補完を有効にする。ユーザーはこの関数を通すだけで型安全な設定記述が可能になる。

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

- **フック型定義のコロケーション**: 各ビルダーが自分のフック型をローカルファイルに定義し（例: `src/builders/mkdist/types.ts:9-25`）、中央の `BuildHooks` がインターフェース拡張で集約する。変更の影響範囲がビルダー単位で閉じる。

## Anti-Patterns / 注意点

- **暗黙の Builder 契約**: 4 つのビルダーは共通の `(ctx: BuildContext) => Promise<void>` シグネチャを持つが、明示的な interface が定義されていない。現在の規模では問題ないが、外部開発者がカスタムビルダーを追加する場合、どのパターン（フックの呼び出し順序、エントリのフィルタリング等）に従うべきかがコードを読まないと分からない。

```typescript
// Bad: 暗黙の契約に依存（現状）
const buildTasks = [typesBuild, mkdistBuild, rollupBuild, copyBuild] as const;

// Better: 契約を型で明示（ビルダー数が増える場合）
interface Builder {
  name: string;
  build(ctx: BuildContext): Promise<void>;
}
```

- **`defu` の戻り値型の不正確さ**: `defu()` は内部的に `DeepPartial` なオブジェクトをマージするが、戻り値が完全な型になることを TypeScript に証明できない。そのため `as BuildOptions` のアサーションが必要になる（`src/build.ts:175`）。デフォルト値が `satisfies BuildOptions` で検証されているため実行時の安全性は確保されているが、型レベルの保証は失われている。

```typescript
// 現状: アサーションが必要
const options = defu(buildConfig, ...) as BuildOptions;

// Better: ジェネリックラッパーで型を保証
function mergeWithDefaults<T>(defaults: T, ...sources: DeepPartial<T>[]): T {
  return defu(...sources, defaults) as T;
}
```

## 導出ルール

- `[MUST]` ユーザー入力型（partial/optional）と内部処理型（required/resolved）を明確に分離する。入力型は `DeepPartial` で受け付け、デフォルト値マージ後に確定型へ変換する
  - 根拠: unbuild は `BuildConfig`（DeepPartial）と `BuildOptions`（確定型）を分離し、`defu` マージ後にのみ `BuildOptions` として扱う（`src/types.ts:171-195`, `src/build.ts:98-175`）
- `[MUST]` 設定オブジェクトのデフォルト値には `satisfies` を使い、スキーマとの整合性をコンパイル時に検証する。`as` アサーションよりも `satisfies` を優先する
  - 根拠: デフォルト値の `satisfies BuildOptions` により、フィールド追加時にデフォルト値の更新漏れがコンパイルエラーで検出される（`src/build.ts:174`）
- `[SHOULD]` 設定マージは「先勝ち」セマンティクス（`defu` 等）を使い、引数の順序で優先順位を表現する。コメントでソース名と優先順位を明記する
  - 根拠: `defu(buildConfig, pkg.unbuild, inputConfig, preset, defaults)` の順序だけで優先順位が確定し、複雑な if-else チェーンが不要になる（`src/build.ts:98-102`）
- `[SHOULD]` プラグインやミドルウェアの有効/無効制御には `OptionType | false` パターンを使う。`undefined`（未設定）と `false`（明示的無効化）を区別する
  - 根拠: 全 6 つの rollup プラグインオプションがこのパターンを採用し、条件付き配列 + `filter(Boolean)` で分岐を排除している（`src/builders/rollup/types.ts:60-106`）
- `[SHOULD]` フレームワークのコア機能とプリセットが同じ拡張メカニズム（フック等）で実装されるようにする。「特別扱い」を減らし、ユーザーが同じ仕組みでカスタマイズできることを保証する
  - 根拠: `autoPreset` はコア機能（エントリ自動推論）を `build:prepare` フックとして実装しており、ユーザーのカスタムプリセットと同じ仕組みで動作する（`src/auto.ts:17-62`）
- `[SHOULD]` `defineXxx` ヘルパー関数（identity 関数）を設定ファイル用に提供し、型推論と IDE 補完を有効にする
  - 根拠: `defineBuildConfig` と `definePreset` は実行時に何もしないが、ユーザーの設定ファイルに型安全性をもたらす（`src/types.ts:204-212`）
- `[AVOID]` 設定マージ後の確定型への変換で `as` アサーションを直接使うこと。代わりにデフォルト値の `satisfies` 検証と組み合わせるか、型安全なラッパー関数を用意する
  - 根拠: `defu()` の戻り値を `as BuildOptions` でアサーションしている箇所は、デフォルト値の `satisfies` があるため実行時は安全だが、型レベルの保証が欠けている（`src/build.ts:175`）

## 適用チェックリスト

- [ ] ユーザー入力型と内部処理型を分離しているか（`Config` vs `Options` のような命名で区別）
- [ ] 設定のデフォルト値に `satisfies` を付与し、型の網羅性をコンパイル時に検証しているか
- [ ] 設定マージの優先順位が関数の引数順序で明示的に表現されているか
- [ ] プラグイン/機能の有効・無効を `OptionType | false` で制御し、`undefined` と `false` を区別しているか
- [ ] コア機能がフレームワークの拡張メカニズム（フック・プラグイン）を通じて実装されているか
- [ ] 設定ファイル用の `defineXxx` ヘルパー関数を提供し、型推論を支援しているか
- [ ] フック型定義がモジュール単位でコロケーションされ、中央のインターフェースで集約されているか
- [ ] ビルダー/プロバイダーの契約が暗黙のまま放置されていないか（規模に応じて interface 化を検討）
