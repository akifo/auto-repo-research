# project-structure

> リポジトリ: unjs/unbuild
> 分析日: 2026-02-16

## 概要

unbuild はわずか約 2,500 行・25 ファイルのソースコードで Rollup/mkdist/untyped/copy の 4 つのビルダーを統合するビルドツールである。小規模ながら、エントリポイントの分離・ビルダーごとのモジュール分割・型定義の階層構造・セルフホスティングビルドなど、構造設計のプラクティスが凝縮されている。特に「最小限のトップレベル + ビルダーごとの自己完結サブモジュール」という分割戦略は、プラグインアーキテクチャを採用するあらゆるツールに応用できる。

## 背景にある原則

- **Facade Pattern によるエントリポイント最小化**: ライブラリの公開エントリ (`src/index.ts`) は 2 行で re-export のみを行い、CLI エントリ (`src/cli.ts`) はコマンド定義と `build()` 呼び出しに徹する。これにより消費者が触れる表面積を最小化し、内部構造の変更が外部 API に波及しないようにしている。公開 API と内部実装の結合を断つことで、後方互換性を維持しつつ内部リファクタリングの自由度を確保すべきである。
- **関心ごとの水平分割 + 垂直分割**: トップレベル (`src/`) はビルドオーケストレーション (build.ts)・型定義 (types.ts)・ユーティリティ (utils.ts)・バリデーション (validate.ts)・自動推論 (auto.ts)・CLI (cli.ts) と機能軸で水平分割し、ビルダー実装 (`src/builders/<builder>/`) はビルダー軸で垂直分割している。機能が異なるものは水平に、同じ関心の実装バリエーションは垂直に分割すべきである。
- **型とフックのコロケーション**: 各ビルダーは `index.ts`（実装）と `types.ts`（型 + フック定義）のペアで構成される。型定義がビルダーの近くに存在することで、そのビルダーの拡張ポイントが一目で分かり、型のスコープが明確になる。
- **設定の段階的マージによるゼロコンフィグ実現**: `package.json` の exports/bin/main/types フィールドからビルドエントリを自動推論する `autoPreset` と、`defu` による多段マージ（buildConfig > pkg.unbuild > inputConfig > preset > defaults）で、設定ファイルなしでも合理的なデフォルトが適用される。ユーザーの認知負荷を下げるには「推論可能な情報を二重に書かせない」原則に従うべきである。

## 実例と分析

### トップレベルのファイル役割分担

`src/` 直下の 7 ファイルはそれぞれ明確に異なる責務を持ち、相互の依存が最小限に抑えられている。

| ファイル | 行数 | 責務 | 依存先 |
|---|---|---|---|
| `index.ts` | 2 | 公開 API の re-export | build.ts, types.ts |
| `cli.ts` | 69 | CLI コマンド定義 | build.ts |
| `build.ts` | 415 | ビルドオーケストレーション | utils, validate, builders/*, types, auto |
| `types.ts` | 212 | 型定義 + `defineBuildConfig`/`definePreset` | builders/*/types |
| `auto.ts` | 176 | package.json からのエントリ自動推論 | utils, types |
| `utils.ts` | 208 | 共通ユーティリティ | auto (resolvePreset 経由) |
| `validate.ts` | 86 | ビルド成果物の検証 | utils, types |

`build.ts` がオーケストレーション層として全ビルダーを束ね、それ以外のファイルは特定の関心にのみ集中している。この「1 つのオーケストレーター + 複数の特化モジュール」構成は、コードベースのナビゲーション性を高めている。

### ビルダーの自己完結サブモジュール構造

4 つのビルダーは `src/builders/<name>/` 以下にそれぞれ独立したサブモジュールとして配置されている。

```
src/builders/
├── copy/          (2 ファイル: index.ts, types.ts)
├── mkdist/        (2 ファイル: index.ts, types.ts)
├── untyped/       (2 ファイル: index.ts, types.ts)
└── rollup/        (8 ファイル: index.ts, types.ts, build.ts, config.ts, stub.ts, watch.ts, utils.ts, plugins/)
    └── plugins/   (5 ファイル: cjs.ts, esbuild.ts, json.ts, raw.ts, shebang.ts)
```

シンプルなビルダー (copy, mkdist, untyped) は `index.ts` + `types.ts` の 2 ファイル構成である。複雑な rollup ビルダーのみ内部でさらに分割されているが、外部に公開するのは `index.ts` からの re-export 1 行のみである。

```typescript
// src/builders/rollup/index.ts:1
export { rollupBuild } from "./build";
```

これにより、rollup ビルダーの内部複雑性がカプセル化され、`build.ts` からは 4 つのビルダーを対称的にインポートできる。

```typescript
// src/build.ts:21-24
import { rollupBuild } from "./builders/rollup";
import { typesBuild } from "./builders/untyped";
import { mkdistBuild } from "./builders/mkdist";
import { copyBuild } from "./builders/copy";
```

### 統一インターフェースによるビルダー実行

4 つのビルダーはすべて `(ctx: BuildContext) => Promise<void>` という同一シグネチャを持ち、配列に格納して順次または並列に実行される。

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

ビルダーの追加・削除はこの配列への 1 行追加で完了する。各ビルダーは内部で `ctx.options.entries.filter((e) => e.builder === "<name>")` として自分が担当するエントリのみを処理するため、ビルダー間の干渉がない。

### フック設計による拡張性の確保

`BuildHooks` インターフェースは各ビルダーのフック型をインターセクションで合成している。

```typescript
// src/types.ts:197-202
export interface BuildHooks
  extends CopyHooks, UntypedHooks, MkdistHooks, RollupHooks {
  "build:prepare": (ctx: BuildContext) => void | Promise<void>;
  "build:before": (ctx: BuildContext) => void | Promise<void>;
  "build:done": (ctx: BuildContext) => void | Promise<void>;
}
```

この設計により、各ビルダーは自身のフック型を `types.ts` にコロケーションしつつ、ユーザーにはフラットな 1 つの `BuildHooks` として見せることができる。例えば rollup ビルダーは 5 つのフック (`rollup:options`, `rollup:build`, `rollup:dts:options`, `rollup:dts:build`, `rollup:done`) を定義し、mkdist は 4 つ (`mkdist:entries`, `mkdist:entry:options`, `mkdist:entry:build`, `mkdist:done`) を定義する。

### セルフホスティングビルドの実現構造

unbuild は自分自身を使ってビルドする。開発時は `jiti` による JIT 実行で TypeScript ソースを直接実行する。

```json
// package.json:29
"unbuild": "jiti ./src/cli"
```

```typescript
// build.config.ts:1-2
import { defineBuildConfig } from "./src";
import { rm } from "node:fs/promises";
```

`build.config.ts` が `./src` からインポートすることで、ビルド前のソースコードで自身の設定を書ける。これはフレームワークが自身を使って構築される「ドッグフーディング」パターンであり、API の使いやすさを開発者自身が継続的に検証する効果がある。

### rollup ビルダーの内部分割: 関心の分離の深掘り

最も複雑な rollup ビルダーは以下のように内部分割されている。

| ファイル | 行数 | 責務 |
|---|---|---|
| `build.ts` | 130 | ビルド実行フロー（stub/build/watch の分岐） |
| `config.ts` | 168 | Rollup オプション構築 |
| `stub.ts` | 188 | JIT スタブ生成 |
| `watch.ts` | 39 | ウォッチモード |
| `utils.ts` | 53 | エイリアス解決、チャンクファイル名生成 |
| `types.ts` | 131 | 型定義 + フック定義 |

`build.ts` がエントリポイントとして stub/build/watch の 3 モードを分岐し、各モードの実装は別ファイルに委譲する。設定構築 (`config.ts`) と実行 (`build.ts`) が分離されているため、設定だけをテスト・検査することが容易である。

### 型定義の階層構造

型は「基底型 → ビルダー固有型 → ユニオン型」という階層で設計されている。

```typescript
// src/types.ts:14-20 (基底型)
export interface BaseBuildEntry {
  builder?: "untyped" | "rollup" | "mkdist" | "copy";
  input: string;
  name?: string;
  outDir?: string;
  declaration?: "compatible" | "node16" | boolean;
}

// src/builders/rollup/types.ts:20-22 (ビルダー固有型)
export interface RollupBuildEntry extends BaseBuildEntry {
  builder: "rollup";
}

// src/types.ts:36-41 (ユニオン型)
export type BuildEntry =
  | BaseBuildEntry
  | RollupBuildEntry
  | UntypedBuildEntry
  | MkdistBuildEntry
  | CopyBuildEntry;
```

`BaseBuildEntry` が共通フィールドを定義し、各ビルダーの型が `builder` フィールドをリテラル型で固定することで、判別可能なユニオン (Discriminated Union) を構成している。

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 4 つの異なるビルド戦略（rollup, mkdist, untyped, copy）を統一的に実行する
  - 適用条件: 同一インターフェースで異なる実装を切り替える場面
  - コード例: `src/build.ts:293-306` — ビルダー関数配列の順次/並列実行
  - 注意点: GoF の Strategy は実行時にストラテジーオブジェクトを注入するが、unbuild では静的な配列として定義されている。エントリの `builder` フィールドで処理対象を自己選択する方式は、Strategy + Chain of Responsibility のハイブリッドに近い

- **Facade パターン** (分類: 構造)
  - 解決する問題: rollup ビルダーの内部の 8 ファイルを 1 つの `rollupBuild` 関数に集約する
  - 適用条件: サブシステムの複雑性を隠蔽し、シンプルなインターフェースを提供する場面
  - コード例: `src/builders/rollup/index.ts:1` — 1 行 re-export
  - 注意点: barrel ファイル (index.ts) を Facade として使うパターン。re-export が多すぎると tree-shaking が効かなくなるが、ここでは単一関数のみで問題ない

- **Builder パターン** (分類: 生成) — 変形適用
  - 解決する問題: ビルドオプションの段階的構築と多段マージ
  - 適用条件: オプションが多く、デフォルト値の推論とユーザー指定の合成が必要な場面
  - コード例: `src/build.ts:98-175` — `defu` による 5 段階マージ
  - 注意点: GoF の Builder はステップバイステップの構築だが、ここでは `defu` の深いマージで一括構築している。宣言的設定にはこの方式が適している

## Good Patterns

- **公開 API を re-export のみに制限する**: `src/index.ts` は `export * from "./build"` と `export * from "./types"` の 2 行のみである。内部モジュール構成が変わっても、re-export 元を変えるだけで互換性を維持できる。

```typescript
// src/index.ts:1-2
export * from "./build";
export * from "./types";
```

- **`defineBuildConfig` / `definePreset` ヘルパーで型安全な設定を提供する**: 設定ファイルの型補完を実行時コストなしで実現する。関数内部はほぼパススルーだが、ユーザーの IDE 体験を劇的に改善する。

```typescript
// src/types.ts:204-208
export function defineBuildConfig(
  config: BuildConfig | BuildConfig[],
): BuildConfig[] {
  return (Array.isArray(config) ? config : [config]).filter(Boolean);
}
```

- **ビルダーの `builder` フィールドによるエントリ自己選択**: 各ビルダーが `ctx.options.entries.filter((e) => e.builder === "<name>")` で自分の担当エントリだけを抽出する。オーケストレーター側でルーティングロジックを持たず、ビルダー側に責務を持たせることで、新しいビルダー追加時にオーケストレーターの変更が最小化される。

```typescript
// src/builders/mkdist/index.ts:8-10
const entries = ctx.options.entries.filter(
  (e) => e.builder === "mkdist",
) as MkdistBuildEntry[];
```

- **フック型のインターセクション合成**: ビルダーごとに定義したフック型を `BuildHooks` で合成し、ユーザーにはフラットなインターフェースを提供する。ビルダー追加時はインターセクションに 1 つ追加するだけで済む。

## Anti-Patterns / 注意点

- **オーケストレーターファイルの肥大化**: `src/build.ts` は 415 行で、オプションマージ・エントリ正規化・ディレクトリ削除・ビルダー実行・出力レポート・バリデーション呼び出しという多くの責務を 1 ファイルに持つ。`_build` 関数が 330 行を超えており、例えばオプション構築やレポート出力を別ファイルに抽出できる余地がある。

```typescript
// Bad: 1つの関数に多くの責務
// src/build.ts:78-415 — _build 関数が約 340 行

// Better: フェーズごとにファイルまたは関数を分割
// options.ts — resolveOptions(rootDir, inputConfig, buildConfig, pkg)
// report.ts  — reportBuildOutput(ctx)
// build.ts   — _build() はフェーズを呼ぶだけ
```

- **暗黙的なビルダーフォールバック推論**: エントリの `builder` が未指定の場合、入力パスの末尾スラッシュで mkdist/rollup を判定する。この規則がドキュメント以外に明示されていないため、新規ユーザーが混乱する可能性がある。

```typescript
// src/build.ts:228-229
if (!entry.builder) {
  entry.builder = entry.input.endsWith("/") ? "mkdist" : "rollup";
}
```

## 導出ルール

- `[MUST]` ライブラリの公開エントリポイントは re-export のみにし、実装ロジックを含めない
  - 根拠: unbuild の `src/index.ts` は 2 行の re-export で、内部モジュール再構成が外部 API に影響しない設計を実現している (`src/index.ts:1-2`)

- `[MUST]` プラグイン/ストラテジーの実装バリエーションは統一インターフェース `(ctx: Context) => Promise<void>` に揃え、配列で管理する
  - 根拠: unbuild の 4 ビルダーは同一シグネチャを持ち、配列に格納して順次/並列実行を 3 行で切り替えている (`src/build.ts:293-306`)

- `[SHOULD]` 設定ファイル用に `defineXxx` ヘルパー関数を提供し、実行時コストなしで型補完を実現する
  - 根拠: `defineBuildConfig` はほぼパススルーだが、ユーザーが `build.config.ts` を書く際の IDE 体験を劇的に改善している (`src/types.ts:204-208`)

- `[SHOULD]` 複雑なサブモジュールは内部をさらに分割しつつ、`index.ts` からの re-export 1 行で外部にはシンプルなインターフェースを見せる
  - 根拠: rollup ビルダーは 8 ファイルの内部構成を持つが、外部には `export { rollupBuild } from "./build"` のみを公開している (`src/builders/rollup/index.ts:1`)

- `[SHOULD]` 判別可能なユニオン型 (Discriminated Union) を使い、基底型を拡張して各バリアントを定義する
  - 根拠: `BaseBuildEntry` → `RollupBuildEntry` (builder: "rollup") のように `builder` リテラル型で判別するユニオンが、型安全なエントリ処理を実現している (`src/types.ts:14-41`)

- `[SHOULD]` フック/イベント型はサブモジュールにコロケーションし、トップレベルの型定義でインターセクションとして合成する
  - 根拠: 各ビルダーの `types.ts` にフック定義を配置し、`BuildHooks extends CopyHooks, UntypedHooks, MkdistHooks, RollupHooks` で合成している (`src/types.ts:197-202`)

- `[AVOID]` オーケストレーター関数にオプション構築・実行・レポート・バリデーションなど複数の責務を詰め込んで 300 行超にすること
  - 根拠: `_build` 関数は 340 行に達しており、オプション構築やレポート出力をフェーズ関数に分割すればテスタビリティと可読性が向上する (`src/build.ts:78-415`)

## 適用チェックリスト

- [ ] 公開エントリポイント (`index.ts`) が re-export のみで構成されているか
- [ ] CLI エントリとライブラリエントリが分離されているか（`cli.ts` と `index.ts`）
- [ ] プラグイン/ストラテジーが統一インターフェースを持ち、配列で管理されているか
- [ ] 複雑なサブモジュールが `index.ts` を Facade として外部公開しているか
- [ ] 型定義がサブモジュールにコロケーションされ、トップレベルで合成されているか
- [ ] 設定ファイル用の `defineXxx` ヘルパーが提供されているか
- [ ] ゼロコンフィグを実現するために、既存のメタデータ（package.json 等）から設定を推論しているか
- [ ] オーケストレーター関数が 300 行を超えていないか（超えている場合はフェーズ分割を検討）
- [ ] 判別可能なユニオン型でバリアント間の型安全性を確保しているか
