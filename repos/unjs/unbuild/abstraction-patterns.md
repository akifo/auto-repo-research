# abstraction-patterns

> リポジトリ: unjs/unbuild
> 分析日: 2026-02-16

## 概要

unbuild は 4 つのビルダー（rollup, mkdist, untyped, copy）を共通のオーケストレーション層で制御するビルドツールである。この視点では、ビルダー間の共通インターフェース設計、エントリ解決の抽象化、ビルダー選択（ディスパッチ）パターンを分析する。注目すべきは、4 つのビルダーが GoF の Strategy パターンの「暗黙的変形」として機能しながらも、共通インターフェースを型レベルで定義せず、入力フィルタリングで疎結合を実現している点である。

## 背景にある原則

- **Discriminated Union による自己記述的ルーティング**: ビルダーの選択を中央のディスパッチャではなく、エントリ自体の `builder` フィールドに委ねることで、新しいビルダー追加時にルーティングロジックの変更が不要になる。各ビルダーが自分に該当するエントリを自ら `filter` するため、Open-Closed 原則に近い構造が自然に生まれる（`src/builders/copy/index.ts:11-12`, `src/builders/mkdist/index.ts:8-9`）。

- **Convention over Configuration によるデフォルト推論**: エントリの `builder` フィールドが未指定の場合、入力パスの末尾スラッシュの有無で `mkdist` か `rollup` を自動判定する（`src/build.ts:229`）。ユーザーに設定を強制せず、慣習（ディレクトリ = ファイル群コピー系、ファイル = バンドル系）から意図を推論する設計である。

- **Context Object による暗黙的プロトコル**: 4 つのビルダーは共通の TypeScript インターフェースを実装しない代わりに、すべて `BuildContext` を引数に取り `Promise<void>` を返す同一シグネチャの関数として定義されている。型レベルの契約ではなく、共有コンテキストオブジェクトへの副作用（`ctx.buildEntries.push`, `ctx.warnings`）が暗黙のプロトコルとして機能している（`src/build.ts:293-298`）。

- **Hooks による横断的関心事の分離**: 各ビルダーが独自のフックインターフェースを定義し、それらを `BuildHooks` で合成する（`src/types.ts:197-202`）。ビルダーのライフサイクルイベントを外部に公開しつつ、ビルダー間の依存を排除している。

## 実例と分析

### 1. ビルダーのディスパッチ: 全タスク実行 + 自己フィルタリング

unbuild のオーケストレーターは、ビルダーを「選択」しない。全ビルダーを常に呼び出し、各ビルダーが自分に該当するエントリを内部でフィルタリングする。

```typescript
// src/build.ts:293-306
const buildTasks = [
  typesBuild, // untyped
  mkdistBuild, // mkdist
  rollupBuild, // rollup
  copyBuild, // copy
] as const;

if (options.parallel) {
  await Promise.all(buildTasks.map((task) => task(ctx)));
} else {
  for (const task of buildTasks) {
    await task(ctx);
  }
}
```

各ビルダーは先頭で自分のエントリを抽出する:

```typescript
// src/builders/copy/index.ts:11-12
const entries = ctx.options.entries.filter(
  (e) => e.builder === "copy",
) as CopyBuildEntry[];

// src/builders/mkdist/index.ts:8-9
const entries = ctx.options.entries.filter(
  (e) => e.builder === "mkdist",
) as MkdistBuildEntry[];
```

このパターンにより、ビルダーの追加・削除がオーケストレーター側の `buildTasks` 配列の変更のみで完結する。条件分岐（`if/switch`）によるルーティングが存在しないため、分岐の複雑度が増加しない。

### 2. 型によるエントリの差別化: Discriminated Union

`BuildEntry` は `BaseBuildEntry` と 4 つの専用エントリ型の Union として定義されている:

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

各専用エントリは `builder` フィールドをリテラル型で固定し、独自のプロパティを追加する:

```typescript
// src/builders/copy/types.ts:3-6
export interface CopyBuildEntry extends BaseBuildEntry {
  builder: "copy";
  pattern?: string | string[];
}

// src/builders/untyped/types.ts:4-7
export interface UntypedBuildEntry extends BaseBuildEntry {
  builder: "untyped";
  defaults?: Record<string, any>;
}
```

ただし、`BaseBuildEntry.builder` は optional（`builder?`）であるため、TypeScript の narrowing を `filter` + `as` キャストで代替している点は設計上の妥協である。

### 3. エントリ解決の抽象化: auto preset

`auto` プリセットは `build:prepare` フックで `package.json` の `exports`/`bin`/`main`/`module` からエントリを自動推論する:

```typescript
// src/auto.ts:17-61
export const autoPreset: BuildPreset = definePreset(() => {
  return {
    hooks: {
      "build:prepare"(ctx): void {
        if (!ctx.pkg || ctx.options.entries.length > 0) {
          return;
        }
        const sourceFiles = listRecursively(join(ctx.options.rootDir, "src"));
        const res = inferEntries(ctx.pkg, sourceFiles, ctx.options.rootDir);
        // ...
        ctx.options.entries.push(...res.entries);
      },
    },
  };
});
```

`inferEntries` は出力ファイル名から逆算してソースファイルを特定する:

```typescript
// src/auto.ts:130-141
const possiblePaths = getEntrypointPaths(outputSlug);
const input = possiblePaths.reduce<string | undefined>((source, d) => {
  if (source) {
    return source;
  }
  const SOURCE_RE = new RegExp(
    `(?<=/|$)${d}${isDir ? "" : String.raw`\.\w+`}$`,
  );
  return sourceFiles
    .find((i) => SOURCE_RE.test(i))
    ?.replace(/(\.d\.(m|c)?ts|\.\w+)$/, "");
}, undefined as any);
```

`getEntrypointPaths` はパスのセグメントを先頭から順に削って候補を生成する（`dist/utils/index` -> `["dist/utils/index", "utils/index", "index"]`）。これにより、ソースのディレクトリ構造が出力パスと完全一致しなくても解決できる。

### 4. ビルダーのデフォルト推論: 入力パスからの暗黙的分類

```typescript
// src/build.ts:228-229
if (!entry.builder) {
  entry.builder = entry.input.endsWith("/") ? "mkdist" : "rollup";
}
```

ディレクトリ入力（末尾 `/`）は「ファイル群を個別変換する」mkdist、ファイル入力は「バンドルする」rollup。この 1 行の規約がユーザー設定を大幅に削減している。

### 5. Hooks の合成パターン

各ビルダーが独自の `Hooks` インターフェースを定義し、`BuildHooks` がそれらを交差型（intersection）で合成する:

```typescript
// src/types.ts:197-202
export interface BuildHooks
  extends CopyHooks, UntypedHooks, MkdistHooks, RollupHooks {
  "build:prepare": (ctx: BuildContext) => void | Promise<void>;
  "build:before": (ctx: BuildContext) => void | Promise<void>;
  "build:done": (ctx: BuildContext) => void | Promise<void>;
}
```

フックの粒度はビルダーごとに異なる。copy は 2 つ（`entries`, `done`）、untyped は 4 つ（`entries`, `entry:options`, `entry:schema`, `entry:outputs`, `done`）、rollup は 5 つ（`options`, `build`, `dts:options`, `dts:build`, `done`）。ビルダーの複雑さに応じて適切な粒度のフックを提供している。

### 6. 設定のマージ戦略: defu による多層デフォルト

```typescript
// src/build.ts:98-175
const options = defu(
  buildConfig,        // 1. build.config.ts の設定
  pkg.unbuild || pkg.build,  // 2. package.json の設定
  inputConfig,        // 3. CLI からの設定
  preset,             // 4. プリセットの設定
  { /* defaults */ } satisfies BuildOptions,  // 5. ハードコードデフォルト
) as BuildOptions;
```

`defu` は「最初に見つかった値が勝つ」セマンティクスを持ち、5 層の設定ソースを宣言的にマージする。

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 複数のビルド手法を統一的に扱い、切り替え可能にする
  - 適用条件: 共通の入力（BuildContext）から異なるアルゴリズムで出力を生成する場面
  - コード例: `src/build.ts:293-306`（ビルダー配列）、`src/builders/*/index.ts`（各戦略）
  - 注意点: 典型的な Strategy では共通インターフェース（`interface Builder { build(ctx): Promise<void> }`）を定義するが、unbuild は関数シグネチャの一致のみで暗黙的に実現。小規模なビルダー数（4つ）では十分だが、拡張性が求められる場合は明示的インターフェースが望ましい

- **Chain of Responsibility パターン** (分類: 振る舞い / 変形)
  - 解決する問題: 各ビルダーが自分に該当するエントリのみ処理し、残りは無視する
  - 適用条件: 複数のハンドラが同一のデータセットから自己の責務分を選別する場面
  - コード例: `src/builders/copy/index.ts:11-12`（自己フィルタリング）
  - 注意点: 厳密には CoR ではなく「Broadcast + Self-filtering」。全ハンドラが呼ばれる点が異なる

## Good Patterns

- **Self-filtering Strategy**: 各ビルダーが先頭で `entries.filter(e => e.builder === "xxx")` を実行し、自分に該当するエントリのみ処理する。ディスパッチャ側の条件分岐を排除し、ビルダー追加時の変更箇所を最小化する。

```typescript
// src/builders/mkdist/index.ts:7-10
export async function mkdistBuild(ctx: BuildContext): Promise<void> {
  const entries = ctx.options.entries.filter(
    (e) => e.builder === "mkdist",
  ) as MkdistBuildEntry[];
```

- **Convention-based Default Resolution**: 入力パスの形状（末尾スラッシュ）からビルダーを自動推論する。ユーザーの明示的設定が不要な場合に、慣習ベースのデフォルトを適用する。

```typescript
// src/build.ts:228-229
if (!entry.builder) {
  entry.builder = entry.input.endsWith("/") ? "mkdist" : "rollup";
}
```

- **Hooks Interface Composition**: ビルダーごとの独立した Hooks インターフェースを `extends` で合成し、型安全なフックシステムを構築する。

```typescript
// src/types.ts:197-202
export interface BuildHooks
  extends CopyHooks, UntypedHooks, MkdistHooks, RollupHooks {
  "build:prepare": (ctx: BuildContext) => void | Promise<void>;
  "build:before": (ctx: BuildContext) => void | Promise<void>;
  "build:done": (ctx: BuildContext) => void | Promise<void>;
}
```

- **Reverse Inference (出力から入力を逆算)**: `package.json` の `exports` フィールドから出力ファイルを列挙し、パスセグメントの部分一致でソースファイルを特定する。設定ゼロでエントリを自動検出する。

```typescript
// src/auto.ts:171-176
export const getEntrypointPaths = (path: string): string[] => {
  const segments = normalize(path).split("/");
  return segments
    .map((_, index) => segments.slice(index).join("/"))
    .filter(Boolean);
};
```

## Anti-Patterns / 注意点

- **Filter + as キャストによる型安全性の喪失**: 各ビルダーで `filter()` の結果を `as CopyBuildEntry[]` のようにキャストしている。`builder` フィールドが discriminant として機能しているにもかかわらず、TypeScript の型ガードではなくキャストで narrowing する。

```typescript
// Bad: src/builders/copy/index.ts:11-12
const entries = ctx.options.entries.filter(
  (e) => e.builder === "copy",
) as CopyBuildEntry[];

// Better: カスタム型ガードを定義して型安全にフィルタリング
function isCopyEntry(e: BuildEntry): e is CopyBuildEntry {
  return e.builder === "copy";
}
const entries = ctx.options.entries.filter(isCopyEntry);
```

- **暗黙的プロトコルへの依存**: ビルダー関数は明示的インターフェースを持たず、`(ctx: BuildContext) => Promise<void>` というシグネチャが暗黙の契約となっている。新しいビルダーを追加する際、`ctx.buildEntries.push` による結果報告や `ctx.hooks.callHook` による適切なフック呼び出しといった暗黙のルールに依存している。

```typescript
// Bad: 暗黙のプロトコルのみ
const buildTasks = [typesBuild, mkdistBuild, rollupBuild, copyBuild] as const;

// Better: 明示的なインターフェース定義（ビルダー数が増える場合）
interface Builder {
  (ctx: BuildContext): Promise<void>;
}
const buildTasks: Builder[] = [typesBuild, mkdistBuild, rollupBuild, copyBuild];
```

ただし、unbuild の規模（4 ビルダー）では暗黙的プロトコルで十分機能しており、過度な抽象化を避けている点は合理的である。

## 導出ルール

- `[SHOULD]` 複数の処理戦略を持つシステムでは、ディスパッチャの条件分岐ではなく各戦略が「自分に該当するか」を判定する Self-filtering パターンを使う
  - 根拠: unbuild の 4 ビルダーは全て `entries.filter(e => e.builder === "xxx")` で自己選別しており、オーケストレーター側に `switch`/`if` 分岐が存在しない（`src/build.ts:293-306`）

- `[SHOULD]` Discriminated Union を使う場合、ベース型の判別フィールドは optional ではなく required にし、TypeScript の narrowing を活用する
  - 根拠: unbuild の `BaseBuildEntry.builder?` は optional のため、`filter` 後に `as` キャストが必要になっている（`src/builders/copy/index.ts:11-12`）。required にすれば型ガード関数で安全に narrowing できる

- `[MUST]` 設定のデフォルト値は「最も一般的なユースケース」をゼロ設定で動作させる方向に設計し、推論ロジックは慣習ベースにする
  - 根拠: unbuild はパス末尾の `/` でビルダーを推論し、`package.json` の `exports` からエントリを自動検出することで、多くのプロジェクトが `build.config.ts` なしでビルドできる（`src/build.ts:228-229`, `src/auto.ts:17-61`）

- `[SHOULD]` プラグインシステムのフック定義は、各モジュールが独自のフックインターフェースを所有し、コア側で交差型として合成する
  - 根拠: unbuild の `BuildHooks extends CopyHooks, UntypedHooks, MkdistHooks, RollupHooks` は各ビルダーのフック定義を独立に保ちつつ型安全に統合している（`src/types.ts:197-202`）

- `[SHOULD]` 多層設定のマージには宣言的なマージ関数を使い、優先順位を配列の順序で表現する
  - 根拠: unbuild は `defu(buildConfig, pkg設定, inputConfig, preset, defaults)` の 5 層をワンライナーでマージしている（`src/build.ts:98-175`）

- `[AVOID]` 戦略パターンで共通インターフェースを定義せずに暗黙のプロトコル（同じシグネチャ + 同じ副作用パターン）に依存することを、戦略の数が 5 個を超える場合に行う
  - 根拠: unbuild は 4 ビルダーで暗黙的プロトコルが機能しているが、戦略数の増加に伴い「どの副作用が必須か」が不明確になるリスクがある

## 適用チェックリスト

- [ ] 複数の処理戦略を持つシステムで、ディスパッチャに `switch`/`if` の分岐が増えていないか確認する。増えている場合は Self-filtering パターンへのリファクタリングを検討する
- [ ] Discriminated Union の判別フィールドが optional になっていないか確認する。optional の場合は required に変更し、型ガード関数を定義する
- [ ] 設定のデフォルト値が「ゼロ設定で最も一般的なケースが動く」ように設計されているか確認する
- [ ] プラグインやフックのインターフェースが、各モジュール側で独立定義され、コア側で合成されているか確認する
- [ ] 多層の設定マージが `defu` 等の宣言的マージ関数で行われているか確認する。手続き的な `if/else` によるマージは優先順位の把握が困難になる
- [ ] 暗黙的プロトコルに依存している箇所を洗い出し、戦略の数が増加傾向にある場合は明示的インターフェースの導入を検討する
