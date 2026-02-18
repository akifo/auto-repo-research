# Configuration Patterns

> リポジトリ: unjs/unbuild
> 分析日: 2026-02-18

## 概要

unbuild の設定システムは「宣言的な設定 + 深いマージ + 自動推論 + フックによる拡張」の4層構造で成り立っている。ユーザーが設定を書かなくても package.json から自動的にビルドエントリを推論し、部分的に上書きする場合は `defu` による深いマージでデフォルトと合成される。さらに、型レベルでの `DeepPartial` 変換により「完全な設定型」と「ユーザー入力型」を分離し、`OptionsObject | false` パターンでサブシステムの無効化をも型安全に表現している。ビルドツールの設定設計として高い再利用性を持つ。

## 背景にある原則

- **Zero-Config First, Full-Config Possible**: ユーザーが明示的に設定を書かない場合でも、package.json の `exports`, `main`, `bin`, `types` フィールドから自動的にビルドエントリを推論する。一方で `build.config.ts` により完全な制御も可能。この原則は「デフォルトの妥当性」を担保することで、設定ファイルが存在しないプロジェクトでもすぐに動作する体験を提供する（`src/auto.ts:17-62`, `src/build.ts:38-42`）

- **Layered Merge with Clear Precedence**: 設定は `buildConfig > pkg.unbuild > inputConfig > preset > defaults` の5層を `defu` で深くマージする。各層が「部分設定」を持ち、最終的に完全な `BuildOptions` が得られる。これにより設定の責務が分離され、「何を上書きしたか」が明確になる（`src/build.ts:98-174`）

- **Type-Safe Optionality via DeepPartial**: ユーザーが記述する `BuildConfig` は `DeepPartial<Omit<BuildOptions, "entries">>` として定義されており、内部で確定された `BuildOptions` とは型レベルで区別される。これによりユーザーは任意のプロパティだけを指定でき、かつ内部コードは常に完全な型で動作する（`src/types.ts:171-195`）

- **Disable via False, Configure via Object**: Rollup プラグインの各設定は `OptionsObject | false` のユニオン型で定義されており、`false` を渡すことで個別に無効化できる。この規約により「オプション渡し」と「機能無効化」を同じ設定キーで一貫して表現する（`src/builders/rollup/types.ts:60-107`）

## 実例と分析

### 設定の多段マージ

unbuild の設定マージは `_build` 関数内で `defu` を使って実行される。マージ順序は明確な優先度を持つ:

1. `buildConfig` (build.config.ts の内容)
2. `pkg.unbuild || pkg.build` (package.json 内の設定)
3. `inputConfig` (CLI 引数由来)
4. `preset` (プリセット、デフォルトは "auto")
5. ハードコードされたデフォルト値 (`satisfies BuildOptions`)

`defu` は「先に定義された値を優先する」深いマージライブラリであり、配列を上書きではなくそのまま保持する点で `Object.assign` や `lodash.merge` とは異なる。`satisfies BuildOptions` アノテーションにより、デフォルト値オブジェクトが `BuildOptions` 型を満たすことがコンパイル時に検証される。

### 自動推論 (Auto Preset)

`autoPreset` は `build:prepare` フックを使って、ビルド直前にエントリを自動推論する。推論ロジックは `inferEntries` 関数に分離されており:

1. package.json の `exports`, `bin`, `main`, `module`, `types` から出力ファイル一覧を収集
2. `src/` ディレクトリのファイル一覧と照合して入力ファイルを推定
3. CJS/DTS の出力が必要かどうかを判定
4. エントリが事前定義されている場合はスキップ (`ctx.options.entries.length > 0`)

この「推論ロジックをフックとして実装する」設計により、auto preset は他のプリセットと同じインターフェースで差し替え可能になっている。

### プリセットの解決

`resolvePreset` は文字列・オブジェクト・関数の3形式を統一的に解決する:

- `"auto"` → 内蔵の `autoPreset` にマッピング
- 文字列 → `jiti.import` でモジュールとしてロード
- 関数 → 即時呼び出しして結果を取得
- オブジェクト → そのまま返す

この多形的なプリセット解決により、設定ファイルでは `preset: "auto"` のような簡潔な記述から、`preset: () => ({ ... })` のような動的生成まで対応する。

### エントリの正規化

マージ後のエントリ配列は正規化フェーズを経る:

1. 文字列エントリを `{ input: entry }` オブジェクトに変換
2. `name` が未設定なら入力パスから自動生成（`src/` プレフィックスと拡張子を除去）
3. `builder` が未設定なら、入力パスの末尾が `/` かどうかで `mkdist` or `rollup` を推定
4. グローバルの `declaration` 設定を個別エントリに伝播
5. 相対パスを絶対パスに解決

### プラグイン有効化/無効化パターン

Rollup プラグインの設定は `OptionsObject | false` 型で定義され、`getRollupOptions` 内で条件付きで配列に追加される:

```
ctx.options.rollup.replace && replace({ ...ctx.options.rollup.replace, ... })
```

`&&` 演算子の短絡評価を利用し、値が `false` ならプラグインインスタンスを生成せず `false` を返す。最終的に `.filter(Boolean)` で除去される。この一貫したパターンが全プラグイン（replace, alias, resolve, json, esbuild, commonjs）に適用されている。

### フックによる設定拡張

hookable を使ったフックシステムにより、設定が確定した後でも特定のタイミングで介入できる:

- `build:prepare` → エントリの自動推論（auto preset が使用）
- `build:before` → ビルド開始直前の最終調整
- `rollup:options` → Rollup オプション確定後の修正
- `rollup:dts:options` → DTS ビルド固有のオプション修正
- `mkdist:entry:options` → mkdist エントリごとのオプション修正

フックの登録順序も明確で、`preset.hooks → inputConfig.hooks → buildConfig.hooks` の順に登録される。

## コード例

```typescript
// src/types.ts:171-195
type DeepPartial<T> = { [P in keyof T]?: DeepPartial<T[P]> };

/**
 * In addition to basic `entries`, `presets`, and `hooks`,
 * there are also all the properties of `BuildOptions` except for BuildOptions's `entries`.
 */
export interface BuildConfig extends DeepPartial<
  Omit<BuildOptions, "entries">
> {
  entries?: (BuildEntry | string)[];
  preset?: string | BuildPreset;
  hooks?: Partial<BuildHooks>;
}
```

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
    declaration: undefined,
    outDir: "dist",
    stub: _stubMode,
    // ... 以下省略
  } satisfies BuildOptions,
) as BuildOptions;
```

```typescript
// src/builders/rollup/types.ts:60-101
// OptionsObject | false パターン
export interface RollupBuildOptions {
  replace: RollupReplaceOptions | false;
  alias: RollupAliasOptions | false;
  resolve: RollupNodeResolveOptions | false;
  json: RollupJsonOptions | false;
  esbuild: EsbuildOptions | false;
  commonjs: RollupCommonJSOptions | false;
  dts: RollupDtsOptions;
}
```

```typescript
// src/auto.ts:17-24
export const autoPreset: BuildPreset = definePreset(() => {
  return {
    hooks: {
      "build:prepare"(ctx): void {
        // Disable auto if entries already provided or pkg not available
        if (!ctx.pkg || ctx.options.entries.length > 0) {
          return;
        }
        // ... 推論ロジック
```

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
    alias({ ...ctx.options.rollup.alias, entries: _aliases }),
  // ... 同じパターンが全プラグインに適用
].filter((p): p is NonNullable<Exclude<typeof p, false>> => !!p),
```

```typescript
// src/utils.ts:72-88
export async function resolvePreset(
  preset: string | BuildPreset,
  rootDir: string,
): Promise<BuildConfig> {
  if (preset === "auto") {
    preset = autoPreset;
  } else if (typeof preset === "string") {
    preset =
      (await createJiti(rootDir, { interopDefault: true }).import(preset, {
        default: true,
      })) || {};
  }
  if (typeof preset === "function") {
    preset = preset();
  }
  return preset as BuildConfig;
}
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 複数のビルダー（rollup, mkdist, copy, untyped）の設定・実行を統一インターフェースで扱う
  - 適用条件: 複数のアルゴリズム（ビルド戦略）を実行時に切り替える必要がある場合
  - コード例: `src/build.ts:293-306` — ビルドタスク配列を順次/並列で実行
  - 注意点: エントリの `builder` フィールドが discriminated union のタグとして機能し、各ビルダーが自身に該当するエントリだけをフィルタする

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: ビルドプロセスの骨格（prepare → before → build → done）を固定しつつ、各ステップの詳細をフックで差し替え可能にする
  - 適用条件: 処理の流れは共通だが、ステップの実装をユーザーやプリセットが拡張する場合
  - コード例: `src/build.ts:206-311` — フックの呼び出し順序が骨格を形成
  - 注意点: hookable ライブラリによりクラス継承ではなくイベント駆動で実現している

- **Null Object パターン** (分類: 振る舞い)
  - 解決する問題: 設定が存在しない場合のデフォルト動作を保証する
  - 適用条件: 外部入力（設定ファイル、CLI引数）が省略可能な場合
  - コード例: `src/build.ts:38-42` — `build.config` が存在しなければ空オブジェクトにフォールバック
  - 注意点: `jiti.import` の `try: true` オプションにより、ファイル不在時のエラーを抑制している

## Good Patterns

- **satisfies による型安全なデフォルト値定義**: デフォルト値オブジェクトに `satisfies BuildOptions` を付けることで、デフォルト値が完全な型を満たすことをコンパイル時に保証しつつ、`defu` のマージ結果は `as BuildOptions` でキャストする。これにより「デフォルトの漏れ」がコンパイルエラーになる。

```typescript
// src/build.ts:98-174
const options = defu(
  buildConfig,
  // ...
  { /* 全フィールドを網羅 */ } satisfies BuildOptions,
) as BuildOptions;
```

- **defineBuildConfig / definePreset ヘルパー関数**: 実装はほぼ identity 関数だが、TypeScript の型推論を活かしてユーザーの設定ファイルで自動補完を提供する。配列正規化も兼ねており、単一オブジェクト/配列の両方を受け付ける。

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

- **publishConfig の透過的適用**: 非stub/非watchモードのビルド時に `Object.assign(pkg, pkg.publishConfig)` で publishConfig のフィールドをトップレベルに昇格させる。npm publish 時の `exports` 書き換えなどに対応し、ユーザーが意識する必要がない。

```typescript
// src/build.ts:60-63
if (!_watchMode && !_stubMode) {
  Object.assign(pkg, pkg.publishConfig);
}
```

- **エントリの文字列/オブジェクト両対応**: `entries` は `(BuildEntry | string)[]` 型を受け付け、正規化フェーズで文字列を `{ input: entry }` に変換する。これにより簡単なケースは `entries: ["src/index.ts"]`、複雑なケースは `entries: [{ input: "src/", builder: "mkdist", outDir: "dist/" }]` と書き分けられる。

```typescript
// src/build.ts:209-211
options.entries = options.entries.map((entry) =>
  typeof entry === "string" ? { input: entry } : entry,
);
```

## Anti-Patterns / 注意点

- **マージ結果の as キャスト**: `defu` の戻り値を `as BuildOptions` でキャストしている。`defu` は内部で型を保証しきれないため、ランタイムでは正しくても型安全性に穴がある。

```typescript
// Bad: マージ結果を信頼して as キャスト
const options = defu(buildConfig, preset, defaults) as BuildOptions;

// Better: 可能であれば Zod 等でランタイムバリデーションを追加する
// ただし unbuild の場合、パフォーマンスとのトレードオフで意図的にスキップしている
```

- **フォールバックチェーンの暗黙的な優先順序**: preset の解決で `buildConfig.preset || pkg.unbuild?.preset || pkg.build?.preset || inputConfig.preset || "auto"` と記述されているが、この優先順位はドキュメント化されておらず、特に `pkg.build` は他のツールとの名前衝突リスクがある。

```typescript
// Bad: 暗黙的なフォールバックチェーン
const preset = await resolvePreset(
  buildConfig.preset || pkg.unbuild?.preset || pkg.build?.preset || inputConfig.preset || "auto",
  rootDir,
);

// Better: 明示的に優先順位を文書化し、曖昧なキー (pkg.build) は deprecation 警告を出す
```

## 導出ルール

- `[MUST]` 設定の「ユーザー入力型」と「内部確定型」を型レベルで分離する（DeepPartial と完全型）
  - 根拠: unbuild は `BuildConfig`（DeepPartial）と `BuildOptions`（完全型）を分離することで、ユーザーは任意のプロパティだけを指定でき、内部コードは型安全に全プロパティへアクセスできる（`src/types.ts:171-195`）
- `[MUST]` デフォルト値オブジェクトには `satisfies` アノテーションで型の網羅性を保証する
  - 根拠: `satisfies BuildOptions` により、デフォルト値に必須フィールドの漏れがあればコンパイルエラーになり、設定追加時の更新漏れを防止する（`src/build.ts:174`）
- `[SHOULD]` 設定ヘルパー関数（`defineXxxConfig`）を提供し、TypeScript の型推論による自動補完を利用者に与える
  - 根拠: `defineBuildConfig` は実質 identity 関数だが、型推論を通じて設定ファイルでの DX を大幅に向上させる。コストゼロで提供できるため、設定を受け付けるライブラリでは標準的に提供すべき（`src/types.ts:204-208`）
- `[SHOULD]` サブシステムの有効/無効を `OptionsObject | false` のユニオン型で表現し、設定キーと制御を同じフィールドに統合する
  - 根拠: Rollup プラグインごとに `replace: RollupReplaceOptions | false` と定義することで、ユーザーは `replace: false` で無効化、`replace: { ... }` でカスタマイズを同じ場所で行える。別途 `enableXxx` フラグを持つ設計より簡潔（`src/builders/rollup/types.ts:60-101`）
- `[SHOULD]` 深いマージライブラリを使って多段設定を合成し、各レイヤーの優先順位を明示する
  - 根拠: `defu` による5層マージ（`buildConfig > pkg > CLI > preset > defaults`）により、設定の責務が分離され、ユーザーは変更したい部分だけを記述すれば済む（`src/build.ts:98-174`）
- `[SHOULD]` 設定ファイルが存在しない場合のゼロコンフィグ動作を、エコシステム標準のメタデータ（package.json 等）からの自動推論で実現する
  - 根拠: `autoPreset` は package.json の `exports` フィールドからビルドエントリを推論し、設定ファイルなしで動作する。推論ロジックはプリセットとして分離されているため、差し替えも容易（`src/auto.ts:17-62`）
- `[AVOID]` 設定のマージ結果を `as` キャストのみで型安全性を担保すること（ランタイムバリデーションの併用を検討する）
  - 根拠: `defu` の戻り値は厳密には DeepPartial 同士のマージ結果であり、TypeScript 上は `as BuildOptions` で強制している。設定の組み合わせによっては必須フィールドが欠落する可能性がある（`src/build.ts:175`）

## 適用チェックリスト

- [ ] ユーザー入力型（Partial/DeepPartial）と内部確定型（完全型）を型レベルで分離しているか
- [ ] デフォルト値オブジェクトに `satisfies` を付けて型の網羅性をコンパイル時検証しているか
- [ ] 設定ヘルパー関数（`defineXxxConfig`）を提供し、利用者の型推論・自動補完を支援しているか
- [ ] サブシステムの無効化に `OptionsObject | false` パターンを採用し、別途フラグを持たない設計にしているか
- [ ] 設定のマージ順序（優先度）がコード上で明確であり、ドキュメントにも記載されているか
- [ ] ゼロコンフィグ動作のために package.json や既存のメタデータから設定を自動推論しているか
- [ ] 設定ファイルの不在時にエラーではなくフォールバック（空オブジェクト等）を返しているか
- [ ] プリセット機構により、設定の共通パターンを再利用可能な単位でパッケージできるか
- [ ] フックシステムにより、設定確定後の拡張ポイントをユーザーに提供しているか
