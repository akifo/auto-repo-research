# project-structure

> リポジトリ: unjs/unbuild
> 分析日: 2026-02-18

## 概要

unbuild のディレクトリ構成とモジュール分割の設計意図を分析した。43 ファイル・小規模な TypeScript プロジェクトでありながら、4 種類のビルダー（rollup, mkdist, copy, untyped）を統合する複合ビルドシステムを実現している。注目すべきは、フラットなトップレベル + ビルダーごとのサブディレクトリという「浅い階層 + 責務境界の明確化」の設計と、型定義を各ビルダー内に co-locate する判断、そして自分自身を unbuild でビルドする self-build アーキテクチャである。

## 背景にある原則

- **責務境界はディレクトリで表現し、ファイルの深さは最小に留める**: トップレベルの `src/` には orchestration 層（`build.ts`, `cli.ts`, `auto.ts`, `validate.ts`, `utils.ts`, `types.ts`）のみを配置し、各ビルダーの実装は `src/builders/<name>/` に完全に封じ込めている。3 階層を超えるネストは rollup の plugins のみであり、それ以外は 2 階層以内に収まる。理由は「ファイルを探す認知コストの最小化」と「ビルダー間の依存を構造的に防止する」ことにある（`src/builders/rollup/config.ts:9` で `../../utils` をインポートする際、ビルダー同士が直接依存しない構造が強制される）。

- **型定義は使用箇所に co-locate し、集約ファイルで再エクスポートする**: 各ビルダーが独自の `types.ts` を持ち（`src/builders/rollup/types.ts`, `src/builders/copy/types.ts` 等）、トップレベルの `src/types.ts` がそれらを `export type { ... }` で再エクスポートする。これにより、型の所有権がビルダーに帰属しつつ、外部消費者は単一のエントリポイントからすべての型にアクセスできる。

- **エントリポイントは最小限の re-export に限定する**: `src/index.ts` はわずか 2 行（`export * from "./build"` と `export * from "./types"`）であり、ロジックを一切含まない。CLI エントリ（`src/cli.ts`）も `build()` を呼ぶだけの薄いアダプタ層である。これは「public API の表面積を制御し、内部リファクタリングの自由度を確保する」原則に基づく。

- **自己参照（self-build）で設計の一貫性を検証する**: `build.config.ts` が `./src` から `defineBuildConfig` をインポートし、unbuild 自身を unbuild でビルドする（`package.json` の `"build": "pnpm unbuild"`）。ビルドツール自身がそのツールの最初のユーザーとなることで、API 設計の不整合を早期に検出できる。

## 実例と分析

### トップレベル: orchestration 層の分離

`src/` 直下のファイルは 7 つのみで、各ファイルが明確に単一の責務を持つ。

| ファイル | 責務 | 行数 |
|---|---|---|
| `build.ts` | ビルドの orchestration（設定読み込み、コンテキスト生成、ビルダー呼び出し、検証） | 415 |
| `types.ts` | 全型定義の集約と公開 API 型 | 213 |
| `auto.ts` | package.json からのエントリ自動推論 | 177 |
| `utils.ts` | 汎用ユーティリティ関数 | 209 |
| `validate.ts` | ビルド後のパッケージ整合性検証 | 87 |
| `cli.ts` | CLI コマンド定義 | 69 |
| `index.ts` | 公開エントリポイント（re-export のみ） | 2 |

`build.ts` が最大ファイルだが、公開関数 `build()` と内部関数 `_build()` の 2 関数構成で見通しが保たれている。`build()` は設定ファイル読み込みと複数 config のループ、`_build()` は単一 config のビルド実行という分担である。

### ビルダーのディレクトリ構造: 統一インターフェースと独立実装

4 つのビルダーはすべて同じ構造パターンに従う。

```
src/builders/<name>/
  ├── index.ts   # エクスポートされるビルド関数
  └── types.ts   # ビルダー固有の型定義（Entry, Hooks）
```

rollup ビルダーのみ、複雑さに応じてさらにファイルが分割されている。

```
src/builders/rollup/
  ├── index.ts    # re-export のみ（1行）
  ├── build.ts    # ビルド実行ロジック
  ├── config.ts   # Rollup オプション組み立て
  ├── stub.ts     # スタブモード実装
  ├── watch.ts    # ウォッチモード実装
  ├── utils.ts    # rollup 固有ユーティリティ
  ├── types.ts    # rollup 固有型定義
  └── plugins/    # カスタム Rollup プラグイン群
      ├── cjs.ts
      ├── esbuild.ts
      ├── json.ts
      ├── raw.ts
      └── shebang.ts
```

この構成の設計意図は、rollup の `index.ts` に現れている。

```typescript
// src/builders/rollup/index.ts:1
export { rollupBuild } from "./build";
```

わずか 1 行の re-export ファイルだが、これにより他のビルダーと同じ `import { rollupBuild } from "./builders/rollup"` というインポートパスが維持される。内部のファイル分割（`build.ts`, `config.ts`, `stub.ts`, `watch.ts`）は外部から見えない実装詳細となる。

### 型定義の co-location と集約パターン

各ビルダーの `types.ts` は以下の 3 要素を定義する。

1. **BuildEntry の特殊化**: `BaseBuildEntry` を拡張し、`builder` フィールドをリテラル型で固定
2. **ビルダー固有のオプション型**: 外部ライブラリの型を交差型で取り込み
3. **Hooks インターフェース**: ビルダーのライフサイクルフック定義

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

トップレベルの `src/types.ts` はこれらを集約する。

```typescript
// src/types.ts:36-41
export type BuildEntry =
  | BaseBuildEntry
  | RollupBuildEntry
  | UntypedBuildEntry
  | MkdistBuildEntry
  | CopyBuildEntry;
```

```typescript
// src/types.ts:197-202
export interface BuildHooks
  extends CopyHooks, UntypedHooks, MkdistHooks, RollupHooks {
  "build:prepare": (ctx: BuildContext) => void | Promise<void>;
  "build:before": (ctx: BuildContext) => void | Promise<void>;
  "build:done": (ctx: BuildContext) => void | Promise<void>;
}
```

`BuildHooks` は 4 つのビルダー Hooks インターフェースを交差型で合成する。各ビルダーが自身のフックを独立して定義し、集約層で合成するアプローチにより、ビルダーの追加・削除がトップレベル型の 1 行変更で完結する。

### ビルダーの呼び出し: 統一された関数シグネチャ

すべてのビルダーは `(ctx: BuildContext) => Promise<void>` という同一のシグネチャを持つ。

```typescript
// src/build.ts:293-298
const buildTasks = [
  typesBuild, // untyped
  mkdistBuild, // mkdist
  rollupBuild, // rollup
  copyBuild, // copy
] as const;
```

各ビルダーは内部でエントリを自分でフィルタリングする。

```typescript
// src/builders/copy/index.ts:11-13
const entries = ctx.options.entries.filter(
  (e) => e.builder === "copy",
) as CopyBuildEntry[];
```

この「呼び出し側は全ビルダーを呼ぶ、フィルタリングはビルダー側」というパターンにより、orchestration 層はビルダーの詳細を知る必要がない。

### self-build パターン

```typescript
// build.config.ts:1-12
import { defineBuildConfig } from "./src";
import { rm } from "node:fs/promises";

export default defineBuildConfig({
  hooks: {
    async "build:done"() {
      await rm("dist/index.d.ts");
      await rm("dist/cli.d.ts");
      await rm("dist/cli.d.mts");
    },
  },
});
```

`./src` から直接インポートすることで、ビルド済みの `dist/` に依存しない。`package.json` の `"unbuild": "jiti ./src/cli"` が `jiti` による JIT 実行を可能にし、bootstrap 問題を回避している。

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 異なるビルド方式（rollup, mkdist, copy, untyped）を統一的に扱う
  - 適用条件: 同一インターフェースで切り替え可能な複数のアルゴリズムがある場合
  - コード例: `src/build.ts:293-306` で `buildTasks` 配列に格納し、順次またはパラレルで実行
  - 注意点: GoF の Strategy はオブジェクトベースだが、ここでは関数ベースで実現。`(ctx: BuildContext) => Promise<void>` が共通インターフェースに相当する

- **Facade パターン** (分類: 構造)
  - 解決する問題: rollup ビルダーの複雑な内部構造（7 ファイル + 5 プラグイン）を `rollupBuild` 一関数で隠蔽
  - 適用条件: サブシステムが複雑で、外部からのアクセスポイントを単純化したい場合
  - コード例: `src/builders/rollup/index.ts:1` の 1 行 re-export
  - 注意点: Facade が薄すぎると存在意義が問われるが、ここではインポートパスの一貫性と内部リファクタリングの自由度が明確な価値

## Good Patterns

- **型の co-location + 集約 re-export**: ビルダー固有の型をビルダーディレクトリに配置し、トップレベル `types.ts` で再エクスポートする。型の所有権が明確になり、ビルダー追加時の変更箇所が局所化される。

```typescript
// src/types.ts:22-34 — 各ビルダーの型を re-export
/** Bundler types */
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

- **index.ts を re-export 専用にする**: ロジックを含まない re-export ファイルにすることで、モジュールの公開 API と内部実装を構造的に分離する。

```typescript
// src/index.ts:1-2
export * from "./build";
export * from "./types";
```

```typescript
// src/builders/rollup/index.ts:1
export { rollupBuild } from "./build";
```

- **discriminated union による builder タイプ分岐**: `builder` フィールドのリテラル型で各ビルダーの Entry 型を区別し、`filter` + 型アサーションでタイプセーフなフィルタリングを実現する。

```typescript
// src/builders/mkdist/index.ts:8-10
const entries = ctx.options.entries.filter(
  (e) => e.builder === "mkdist",
) as MkdistBuildEntry[];
```

- **Hooks のインターフェース合成**: 各ビルダーが独自の Hooks 型を定義し、`extends` で合成する。ビルダーの追加・削除が型レベルで追跡可能になる。

```typescript
// src/types.ts:197-202
export interface BuildHooks
  extends CopyHooks, UntypedHooks, MkdistHooks, RollupHooks {
  "build:prepare": (ctx: BuildContext) => void | Promise<void>;
  "build:before": (ctx: BuildContext) => void | Promise<void>;
  "build:done": (ctx: BuildContext) => void | Promise<void>;
}
```

## Anti-Patterns / 注意点

- **型アサーションによるフィルタリングの型安全性欠如**: `filter` + `as` キャストはランタイムフィルタと型の整合性がコンパイラに検証されない。`builder` フィールドの値を間違えても型エラーにならない。

```typescript
// Bad: filter の条件と as の型が連動しない
const entries = ctx.options.entries.filter(
  (e) => e.builder === "copy",
) as CopyBuildEntry[];
```

```typescript
// Better: ユーザー定義型ガードで型を絞り込む
function isCopyEntry(e: BuildEntry): e is CopyBuildEntry {
  return e.builder === "copy";
}
const entries = ctx.options.entries.filter(isCopyEntry);
```

- **ビルダー複雑度に応じたファイル分割の基準が暗黙的**: copy/mkdist/untyped は `index.ts` + `types.ts` の 2 ファイル構成だが、rollup は 12 ファイルに分割されている。分割基準がドキュメント化されておらず、新しいビルダー追加時に判断が難しい。プロジェクトのコントリビューションガイドで「N 行を超えたら分割」等の基準を明示するのが望ましい。

## 導出ルール

- `[MUST]` モジュールの公開エントリポイント（`index.ts`）にはロジックを書かず、re-export のみにする
  - 根拠: unbuild の `src/index.ts`（2 行）と `src/builders/rollup/index.ts`（1 行）は、内部ファイル構成の変更を外部に波及させない防壁として機能している

- `[MUST]` プラグイン/ストラテジーの追加で orchestration 層のコード変更が最小になるよう、統一インターフェース（共通の関数シグネチャまたは interface）を設ける
  - 根拠: 4 つのビルダーが `(ctx: BuildContext) => Promise<void>` で統一され、`src/build.ts:293-306` の呼び出し側は配列走査のみで新規ビルダーに対応できる

- `[SHOULD]` 型定義はその型を「所有」するモジュール内に co-locate し、消費者向けには集約ファイルで re-export する
  - 根拠: 各ビルダーの `types.ts` が Entry/Hooks 型を所有し、`src/types.ts` で集約。型の追加・変更がビルダーディレクトリ内で完結する

- `[SHOULD]` サブモジュールの複雑度が他と大きく異なる場合でも、外部インターフェース（ディレクトリ名 + index.ts の export）は他と同じ構造に揃える
  - 根拠: rollup ビルダーは内部 12 ファイルだが、`src/builders/rollup/index.ts` は 1 行の re-export で他ビルダーと同じインポートパスを維持している

- `[SHOULD]` ビルドツールは自分自身のビルドに使う（dogfooding / self-build）ことで API 設計の不整合を早期検出する
  - 根拠: `build.config.ts` が `./src` から `defineBuildConfig` をインポートし、`package.json` の `"unbuild": "jiti ./src/cli"` でソースから直接実行する

- `[AVOID]` ディレクトリ階層を 3 レベル以上にネストする（`src/builders/rollup/plugins/` が上限の目安）
  - 根拠: unbuild は 43 ファイルで最大深度 4（`src/builders/rollup/plugins/*.ts`）であり、それ以外はすべて深度 3 以内。浅い構造がファイル探索の認知コストを抑えている

## 適用チェックリスト

- [ ] プロジェクトの `index.ts`（エントリポイント）が re-export のみであり、ロジックを含んでいないか確認する
- [ ] プラグインやストラテジーなど同種の複数実装がある場合、共通インターフェース（関数シグネチャまたは interface）を定義しているか確認する
- [ ] 型定義がそれを「所有」するモジュール内に配置され、消費者向けに集約 re-export されているか確認する
- [ ] サブモジュール内部の複雑度に関係なく、外部から見たインターフェース（ディレクトリ構造、index.ts の export）が他のサブモジュールと統一されているか確認する
- [ ] ディレクトリのネスト深度が 3 レベル以内に収まっているか確認する（超える場合は正当な理由があるか）
- [ ] ツール/ライブラリの場合、自分自身を使ってビルド・テストしているか（dogfooding）確認する
