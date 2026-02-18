# Architecture

> リポジトリ: unjs/unbuild
> 分析日: 2026-02-16

## 概要

unbuild はビルダーアーキテクチャ、パイプライン設計、コンテキストオブジェクトパターンを中心に設計されたライブラリビルドツールである。4 つの異なるビルダー（rollup, mkdist, copy, untyped）を単一の `BuildContext` オブジェクトで統合し、hookable によるライフサイクルフックで拡張性を確保している。注目すべきは、各ビルダーが完全に独立しつつもコンテキストオブジェクトを唯一の結合点として協調動作する設計にある。この「疎結合なビルダー群 + 共有コンテキスト + フックによる拡張」のパターンは、プラグインシステムを持つあらゆるパイプラインツールに応用できる。

## 背景にある原則

- **コンテキストオブジェクトを唯一の結合点にすべき**: 複数のビルダーが協調動作する際、各ビルダー間を直接結合させず、`BuildContext` という単一のオブジェクトを通じて状態を共有する。これによりビルダーの追加・削除が既存コードに影響を与えない。根拠: `src/build.ts:184-192` で構築された `ctx` が全ビルダー関数の唯一の引数となっている。

- **設定のマージは「宣言的レイヤリング」で行うべき**: ユーザー設定をどう適用するかという問題に対し、unbuild は `defu` による深いマージで複数レイヤー（buildConfig, pkg.unbuild, inputConfig, preset, defaults）を宣言的に統合する。命令的な if 分岐ではなく、優先順位付きの設定レイヤリングにより、設定の予測可能性と拡張性を両立している。根拠: `src/build.ts:98-175` の `defu()` 呼び出し。

- **ビルダーは自分が処理すべきエントリを自分でフィルタリングすべき**: オーケストレーター（`_build` 関数）がエントリの振り分けを行うのではなく、各ビルダー関数が自身の `builder` フィールドを持つエントリだけを `filter` で取得する。これにより新しいビルダーの追加が、既存ビルダーやオーケストレーターの変更を必要としない。根拠: 4 つのビルダー全てが `ctx.options.entries.filter(e => e.builder === "<name>")` パターンを使用。

- **フックは「コロン区切りの名前空間」で階層化すべき**: `build:prepare`, `rollup:options`, `mkdist:entry:build` のように、フック名をコロン区切りで階層化することで、グローバルフック（`build:*`）とビルダー固有フック（`rollup:*`）を自然に分離している。根拠: `src/types.ts:197-202` の `BuildHooks` 型定義。

## 実例と分析

### ビルダーの統合パターン: タスク配列による逐次/並列実行

オーケストレーターは 4 つのビルダー関数を配列として保持し、`parallel` オプションに応じて逐次または並列で実行する。ビルダー関数は全て同一のシグネチャ `(ctx: BuildContext) => Promise<void>` を持ち、交換可能性を保証している。

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

重要なのは、ビルダーの追加は配列への要素追加だけで済む点である。各ビルダーは自身が処理すべきエントリがなければ何もせず即座に返る設計のため、全ビルダーを常に呼び出しても問題がない。

### エントリの自己フィルタリングパターン

4 つのビルダー全てが同一のパターンでエントリをフィルタリングしている。

```typescript
// src/builders/copy/index.ts:11-13
const entries = ctx.options.entries.filter(
  (e) => e.builder === "copy",
) as CopyBuildEntry[];

// src/builders/mkdist/index.ts:8-10
const entries = ctx.options.entries.filter(
  (e) => e.builder === "mkdist",
) as MkdistBuildEntry[];

// src/builders/untyped/index.ts:20-22
const entries = ctx.options.entries.filter(
  (entry) => entry.builder === "untyped",
) as UntypedBuildEntry[];
```

このパターンにより、オーケストレーター側にビルダーの種類を判定する switch/if ロジックが不要になる。新しいビルダー型を追加する場合、`BaseBuildEntry.builder` のユニオン型に追加し、対応するビルダー関数を実装するだけで良い。

### フックライフサイクルの3層構造

フックは明確な 3 層構造を持つ。

**第 1 層: グローバルビルドライフサイクル**（`src/build.ts`）

- `build:prepare` -- コンテキスト構築直後、エントリ正規化前
- `build:before` -- エントリ正規化後、ビルダー実行前
- `build:done` -- 全ビルダー完了後

**第 2 層: ビルダー固有ライフサイクル**（各ビルダー内部）

- `rollup:options` / `rollup:build` / `rollup:dts:options` / `rollup:dts:build` / `rollup:done`
- `mkdist:entries` / `mkdist:entry:options` / `mkdist:entry:build` / `mkdist:done`
- `untyped:entries` / `untyped:entry:options` / `untyped:entry:schema` / `untyped:entry:outputs` / `untyped:done`
- `copy:entries` / `copy:done`

**第 3 層: フック登録の優先順位**（`src/build.ts:195-203`）

```typescript
// src/build.ts:195-203
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

preset, inputConfig, buildConfig の順にフックを登録する。hookable は登録順にフックを実行するため、buildConfig のフックが最後に実行される。

### 自動推論プリセット（auto preset）のフック活用

`auto` プリセットは `build:prepare` フックを使ってエントリを動的に推論する。これはフックシステムの実践的な活用例であり、コア実装を変更せずにビルド前処理を差し込む手法を示している。

```typescript
// src/auto.ts:17-62
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

### 設定のレイヤリングと defu による深いマージ

設定は 5 つのレイヤーが `defu` で統合される。`defu` は「最初に定義された値が優先」するセマンティクスを持つため、引数の順序が優先順位を表現する。

```typescript
// src/build.ts:98-175
const options = defu(
  buildConfig, // 最高優先: build.config.ts
  pkg.unbuild || pkg.build, // package.json の unbuild/build フィールド
  inputConfig, // CLI 引数
  preset, // プリセット
  {/* defaults */} satisfies BuildOptions, // 最低優先: デフォルト値
) as BuildOptions;
```

### BuildContext の設計: ミュータブルな共有状態

`BuildContext` はイミュータブルではなく、ビルダーが直接変更を書き込む設計になっている。`buildEntries` 配列や `warnings` Set、`usedImports` Set は各ビルダーから直接操作される。

```typescript
// src/types.ts:151-167
export interface BuildContext {
  options: BuildOptions;
  pkg: PackageJson;
  jiti: Jiti;
  buildEntries: {
    path: string;
    bytes?: number;
    exports?: string[];
    chunks?: string[];
    chunk?: boolean;
    modules?: { id: string; bytes: number; }[];
  }[];
  usedImports: Set<string>;
  warnings: Set<string>;
  hooks: Hookable<BuildHooks>;
}
```

これは関数型的なアプローチ（各ビルダーが結果を返す）ではなく、命令型のアプローチである。ビルドツールのように「各段階の副作用（ファイル生成）が本質的な出力」である場合は、ミュータブルなコンテキストの方が自然に書ける。

### Rollup プラグインの条件付き適用パターン

Rollup ビルダーの設定構築では、プラグインを `false` で無効化できるパターンを採用している。

```typescript
// src/builders/rollup/config.ts:114-166
plugins: [
  ctx.options.rollup.replace && replace({ ... }),
  ctx.options.rollup.alias && alias({ ... }),
  ctx.options.rollup.resolve && nodeResolve({ ... }),
  // ...
].filter((p): p is NonNullable<Exclude<typeof p, false>> => !!p),
```

各プラグインオプションが `PluginOptions | false` 型を持ち、`false` の場合は短絡評価で `false` が配列に入り、最後に `filter` で除去される。

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 複数のビルド戦略（rollup, mkdist, copy, untyped）を統一的に扱いたい
  - 適用条件: 同一インターフェースで交換可能な処理が複数存在する場合
  - コード例: `src/build.ts:293-298` の `buildTasks` 配列。全ビルダーが `(ctx: BuildContext) => Promise<void>` シグネチャに従う
  - 注意点: GoF の Strategy はクラスベースだが、ここでは関数の配列としてシンプルに実現している。ビルダーの選択はエントリの `builder` フィールドで宣言的に行われ、ランタイムの if 分岐ではない

- **Mediator パターン** (分類: 振る舞い)
  - 解決する問題: 複数のビルダーが互いを知らずに協調動作する必要がある
  - 適用条件: 複数の独立コンポーネントが共有状態を通じて協調する場合
  - コード例: `BuildContext` が Mediator として機能。`src/build.ts:184-192` でコンテキストを構築し、全ビルダーに渡す
  - 注意点: 典型的な Mediator はメッセージの仲介を行うが、ここではフック（`ctx.hooks`）がその役割を担い、共有状態（`ctx.buildEntries`）が協調の媒介となる

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: ビルドの骨格（prepare -> before -> build -> done）を固定しつつ、各ステップの詳細を可変にしたい
  - 適用条件: 処理の全体的な流れは共通だが、個々のステップをカスタマイズしたい場合
  - コード例: `src/build.ts:206-398` の `_build` 関数がテンプレート。フック呼び出しが各ステップの拡張ポイント
  - 注意点: 継承ではなくフック関数の登録で実現しているため、より柔軟

## Good Patterns

- **統一シグネチャによるビルダー合成**: 全ビルダーが `(ctx: BuildContext) => Promise<void>` という同一シグネチャを持つことで、配列に格納して逐次/並列実行を切り替えられる。戻り値を使わず副作用（`ctx.buildEntries.push`）で結果を伝播するのは関数型的には不純だが、ファイル生成が本質の処理ではシンプルに書ける。

```typescript
// src/build.ts:293-306
const buildTasks = [typesBuild, mkdistBuild, rollupBuild, copyBuild] as const;
if (options.parallel) {
  await Promise.all(buildTasks.map((task) => task(ctx)));
} else {
  for (const task of buildTasks) {
    await task(ctx);
  }
}
```

- **`options | false` による条件付きプラグイン構成**: プラグインのオプション型を `PluginOptions | false` にし、`false` で無効化できるようにする。配列に偽値が混入しても最後の `filter` で除去されるため、宣言的に書ける。

```typescript
// src/builders/rollup/types.ts:65-66 (型定義)
replace: RollupReplaceOptions | false;

// src/builders/rollup/config.ts:115-116 (使用)
ctx.options.rollup.replace && replace({ ...ctx.options.rollup.replace, ... }),
```

- **フック名の名前空間化**: `build:prepare`, `rollup:options`, `mkdist:entry:build` のようにコロン区切りの命名規則で、フックのスコープと粒度を表現する。これにより型定義でも構造が明確になり、利用者がフックの適用範囲を名前だけで把握できる。

```typescript
// src/types.ts:197-202
export interface BuildHooks extends CopyHooks, UntypedHooks, MkdistHooks, RollupHooks {
  "build:prepare": (ctx: BuildContext) => void | Promise<void>;
  "build:before": (ctx: BuildContext) => void | Promise<void>;
  "build:done": (ctx: BuildContext) => void | Promise<void>;
}
```

- **プリセットによるフック注入**: `auto` プリセットのように、プリセットがフックを通じてビルドパイプラインにロジックを注入する設計。コア実装に手を加えずに動作を追加できる。

```typescript
// src/auto.ts:17-21
export const autoPreset: BuildPreset = definePreset(() => {
  return {
    hooks: {
      "build:prepare"(ctx): void {
        // コアコードを変更せずにエントリ推論ロジックを追加
```

## Anti-Patterns / 注意点

- **コンテキストオブジェクトの型安全性の喪失**: ビルダーが `filter` でエントリを取得する際、`as CopyBuildEntry[]` のような型アサーションを使用している。`builder` フィールドによるフィルタリングは実行時には正しく動作するが、TypeScript の型絞り込みでは判定できないため `as` が必要になる。

```typescript
// Bad: 型アサーションに依存
const entries = ctx.options.entries.filter(
  (e) => e.builder === "copy",
) as CopyBuildEntry[];

// Better: 型ガード関数を定義してコンパイラに判定を委ねる
function isCopyEntry(e: BuildEntry): e is CopyBuildEntry {
  return e.builder === "copy";
}
const entries = ctx.options.entries.filter(isCopyEntry);
```

- **ミュータブルコンテキストの並列実行リスク**: `options.parallel` が `true` の場合、全ビルダーが同一の `ctx.buildEntries` 配列に `push` する。JavaScript の配列操作はアトミックではないため、理論上はレースコンディションが発生しうる。現時点では問題にならないが（各ビルダーが独立した出力を生成するため）、並列実行をサポートするならコンテキストの書き込みを保護する仕組みを検討すべき。

## 導出ルール

- `[MUST]` パイプラインの各ステージは統一されたシグネチャを持つ関数として実装し、オーケストレーターは配列の反復で実行する
  - 根拠: unbuild の 4 ビルダーは全て `(ctx: BuildContext) => Promise<void>` を満たし、`buildTasks` 配列での逐次/並列切り替えを可能にしている（`src/build.ts:293-306`）

- `[MUST]` 複数コンポーネントが協調するシステムでは、共有コンテキストオブジェクトを唯一の結合点とし、コンポーネント間の直接参照を排除する
  - 根拠: 4 つのビルダーは互いを参照せず、`BuildContext` のみを介して状態を共有する（`src/types.ts:151-167`）

- `[SHOULD]` 設定の統合には「宣言的レイヤリング」（深いマージ + 優先順位）を使い、命令的な if/switch による設定上書きを避ける
  - 根拠: `defu()` による 5 レイヤーの設定マージが、優先順位の明示と設定の予測可能性を両立している（`src/build.ts:98-175`）

- `[SHOULD]` ライフサイクルフックの名前はコロン区切りの名前空間で階層化し、`scope:phase` または `scope:target:action` の形式にする
  - 根拠: `build:prepare`, `rollup:dts:options`, `mkdist:entry:build` のように、スコープと粒度がフック名だけで判別できる（`src/types.ts:197-202`）

- `[SHOULD]` パイプラインの各ステージは自分が処理すべきデータを自己選択（self-filtering）で取得し、オーケストレーターによる振り分けロジックを排除する
  - 根拠: 4 ビルダー全てが `ctx.options.entries.filter(e => e.builder === "<name>")` で自己フィルタリングし、オーケストレーターに判定ロジックがない（`src/builders/*/index.ts`）

- `[SHOULD]` プラグインやオプションの有効/無効は `OptionsType | false` の型で表現し、条件付き配列 + `filter(Boolean)` で構成する
  - 根拠: Rollup プラグインの条件付き適用が `ctx.options.rollup.replace && replace({...})` + `.filter(...)` で宣言的に実現されている（`src/builders/rollup/config.ts:114-166`）

- `[AVOID]` パイプラインの各ステージ間を戻り値で結合すること。副作用が本質的な処理（ファイル生成、ビルド出力）では、共有コンテキストへの書き込みの方がステージの独立性を保てる
  - 根拠: ビルダーが `void` を返しつつ `ctx.buildEntries.push()` で結果を伝播する設計により、オーケストレーターがビルダーの戻り値型に依存しない（`src/builders/copy/index.ts:44-54`）

## 適用チェックリスト

- [ ] パイプラインの各ステージが統一されたシグネチャ `(ctx: Context) => Promise<void>` を持っているか
- [ ] コンテキストオブジェクトに必要十分な共有状態（options, 結果蓄積用の配列/Set, フックシステム）が含まれているか
- [ ] 新しいステージの追加が、既存ステージやオーケストレーターのコード変更なしに行えるか
- [ ] 設定の統合に深いマージライブラリ（defu 等）を使い、レイヤーの優先順位が明示されているか
- [ ] フック名が名前空間化されており、スコープと粒度が名前から判別できるか
- [ ] 各ステージが自分の処理対象を self-filtering で選択し、オーケストレーターに振り分けロジックがないか
- [ ] プラグインの有効/無効が `Options | false` 型で宣言的に制御されているか
- [ ] 並列実行オプションがある場合、共有コンテキストへの並行書き込みが安全か検証したか
