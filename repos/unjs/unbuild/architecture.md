# Architecture

> リポジトリ: unjs/unbuild
> 分析日: 2026-02-18

## 概要

unbuild のアーキテクチャを「ビルドパイプラインのレイヤー構成」と「Builder パターンの抽象化」の観点から分析する。unbuild は Rollup、mkdist、untyped、copy という4つの異なるビルドバックエンドを統一的な `BuildContext` とフック機構のもとでオーケストレーションする構造を持つ。注目に値するのは、各ビルダーが同一の `(ctx: BuildContext) => Promise<void>` シグネチャに統一されながら、内部ではそれぞれ独自の複雑性を隠蔽している点、および `package.json` からビルドエントリーを自動推論する Convention over Configuration の徹底である。

## 背景にある原則

- **統一コンテキストによるビルダー間の疎結合**: 複数のビルドバックエンドを統合する場合、各ビルダーが独自のオプション体系を持ちがちだが、共通の `BuildContext` を介することでビルダー間の結合を最小化すべき。なぜなら、ビルダーの追加・削除が他のビルダーに影響しないため、エコシステムの進化に追従しやすい。unbuild では `BuildContext` が全ビルダーに渡される唯一の引数であり、各ビルダーは自分の担当エントリーだけを `filter` して処理する（`src/builders/copy/index.ts:11`, `src/builders/mkdist/index.ts:8-9`）。

- **Convention over Configuration を段階的に適用する**: デフォルトを「推論で十分に動作する状態」に設定し、明示的な設定は上書きとして機能させるべき。なぜなら、ゼロコンフィグで始められることが導入障壁を下げ、カスタマイズの余地を残すことで成長するプロジェクトにも対応できる。unbuild は `package.json` の `exports` フィールドからビルドエントリーを自動推論する `autoPreset`（`src/auto.ts:17-62`）をデフォルトプリセットとして適用する。

- **フック駆動によるパイプラインの拡張ポイント設計**: ビルドパイプラインの各段階にフックポイントを設けることで、コア実装を変更せずに振る舞いを拡張すべき。なぜなら、プラグインシステムの設計が不十分だとフォークや monkey-patching が発生する。unbuild は `hookable` ライブラリで `build:prepare` → `build:before` → 各ビルダー固有フック → `build:done` の一貫したライフサイクルを提供する（`src/types.ts:197-202`）。

- **設定のマージは「最も具体的なものが勝つ」順序で行う**: 複数の設定ソース（ビルド設定ファイル、package.json、CLI 引数、プリセット、デフォルト値）がある場合、優先順位を明確にすべき。unbuild は `defu` で `buildConfig > pkg.unbuild > inputConfig > preset > defaults` の順にマージする（`src/build.ts:98-175`）。

## 実例と分析

### レイヤー構成: 3層パイプライン

unbuild のビルドパイプラインは3つの明確なレイヤーで構成される。

**Layer 1: エントリーポイント層** (`src/cli.ts`, `src/build.ts:27-76`)
CLI 引数のパース、設定ファイルの読み込み、複数ビルドコンフィグのイテレーションを担当する。`build()` 関数は `build.config.ts` から設定配列を読み込み、各設定に対して `_build()` を呼ぶ。

**Layer 2: オーケストレーション層** (`src/build.ts:78-415`)
`_build()` 関数がプリセット解決、オプションマージ、コンテキスト構築、フック登録、ビルダー呼び出し、バリデーション、後処理を一貫して制御する。4つのビルダーは同一の関数シグネチャを持ち、`buildTasks` 配列として直列または並列に実行される。

**Layer 3: ビルダー層** (`src/builders/*/index.ts`)
各ビルダーは `BuildContext` を受け取り、自分の担当エントリーをフィルタし、固有のビルドロジックを実行する。ビルダー間に依存関係はなく、互いの存在を知らない。

### Builder パターンの抽象化: Discriminated Union + 統一シグネチャ

各ビルダーのエントリー型は `BaseBuildEntry` を継承し、`builder` フィールドでディスクリミネートされる。

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

各ビルダー固有の型はこれを拡張して `builder` を literal type で固定する。

```typescript
// src/builders/rollup/types.ts:20-22
export interface RollupBuildEntry extends BaseBuildEntry {
  builder: "rollup";
}

// src/builders/copy/types.ts:3-6
export interface CopyBuildEntry extends BaseBuildEntry {
  builder: "copy";
  pattern?: string | string[];
}
```

ビルダー関数の統一シグネチャにより、オーケストレーション層はビルダーの内部実装を知らずに実行できる。

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

### フック体系: 名前空間付きイベントの合成

各ビルダーは独自のフック型を定義し、トップレベルの `BuildHooks` はそれらを interface extends で合成する。

```typescript
// src/types.ts:197-202
export interface BuildHooks
  extends CopyHooks, UntypedHooks, MkdistHooks, RollupHooks {
  "build:prepare": (ctx: BuildContext) => void | Promise<void>;
  "build:before": (ctx: BuildContext) => void | Promise<void>;
  "build:done": (ctx: BuildContext) => void | Promise<void>;
}
```

フック名はコロン区切りの名前空間（`rollup:options`, `mkdist:entry:build` 等）で構造化されている。これにより、フック名だけでどのビルダーのどの段階に介入するかが明確になる。

### プリセットとしてのエントリー自動推論

`autoPreset` は `build:prepare` フックにロジックを登録するプリセットとして実装されている。これはプリセットが「設定の静的なオーバーライド」だけでなく「フックによる動的なコンテキスト変更」も含むことを示す。

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
        // ... エントリーをコンテキストに注入
        ctx.options.entries.push(...res.entries);
      },
    },
  };
});
```

### プラグインの条件付き合成

Rollup プラグインの構成では、各プラグインのオプションが `false` の場合にプラグイン自体を無効化できるパターンが使われている。

```typescript
// src/builders/rollup/config.ts:114-166
plugins: [
  ctx.options.rollup.replace &&
    replace({ ...ctx.options.rollup.replace, /* ... */ }),
  ctx.options.rollup.alias &&
    alias({ ...ctx.options.rollup.alias, entries: _aliases }),
  // ... 他のプラグイン
  ctx.options.rollup.cjsBridge && cjsPlugin({}),
  rawPlugin(),
].filter((p): p is NonNullable<Exclude<typeof p, false>> => !!p),
```

`OptionType | false` という型設計と、配列リテラル内の短絡評価 + `filter(Boolean)` を組み合わせることで、宣言的にプラグインの有効/無効を制御している。

### Self-build: 自己適用による信頼性証明

unbuild は自身のビルドに unbuild を使用する（`build.config.ts`）。`package.json` の `"build": "pnpm unbuild"` と、`"unbuild": "jiti ./src/cli"` により、開発時は jiti 経由でソースから直接実行し、リリース時はビルド済みバイナリを使う。

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

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 複数のビルドアルゴリズム（Rollup, mkdist, untyped, copy）を動的に選択・実行する
  - 適用条件: エントリーの `builder` フィールドの値に応じて異なるビルダーが処理を担当する
  - コード例: `src/build.ts:228-229`（`builder` フィールドによるデフォルト戦略決定）、`src/build.ts:293-306`（戦略の実行）
  - 注意点: 典型的な Strategy パターンでは Context がストラテジーオブジェクトを保持するが、unbuild では全ストラテジーを常に呼び出し、各ストラテジーが自分のエントリーをフィルタする形（「全員呼んで自分で判断」方式）

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: ビルドパイプラインの骨格（準備 → フック → ビルド → 検証 → 完了通知）を固定しつつ、各段階の詳細をカスタマイズ可能にする
  - 適用条件: `_build()` 関数がテンプレートメソッドの役割を果たし、フックが各ステップのカスタマイズポイントとなる
  - コード例: `src/build.ts:206` (`build:prepare`), `src/build.ts:250` (`build:before`), `src/build.ts:398` (`build:done`)
  - 注意点: 継承ではなくフック（イベント）で実現されており、GoF の原型よりも柔軟

- **Discriminated Union パターン** (分類: 型設計)
  - 解決する問題: `BuildEntry` の union 型を `builder` フィールドで型安全に判別する
  - 適用条件: 同一の基底型を共有しつつ、バリアントごとに追加フィールドを持つ場合
  - コード例: `src/types.ts:14-41`
  - 注意点: ランタイムのフィルタ（`entry.builder === "rollup"`）と型ガードが連動する

## Good Patterns

- **統一シグネチャによるビルダーの直交性**: 全ビルダーが `(ctx: BuildContext) => Promise<void>` に統一されていることで、ビルダーの追加・削除がオーケストレーション層のコード変更を最小化する。並列/直列の切り替えも `Promise.all` と `for...of` の分岐だけで済む。

```typescript
// src/build.ts:293-306
const buildTasks = [
  typesBuild,
  mkdistBuild,
  rollupBuild,
  copyBuild,
] as const;

if (options.parallel) {
  await Promise.all(buildTasks.map((task) => task(ctx)));
} else {
  for (const task of buildTasks) {
    await task(ctx);
  }
}
```

- **`OptionType | false` による宣言的なプラグイン無効化**: プラグインオプション型に `| false` を加えることで、`false` 設定時にプラグインごと無効化できる。boolean 型のフラグを別途管理する必要がなく、設定とプラグインの対応が1対1で明確になる。

```typescript
// src/builders/rollup/types.ts:60-72
/**
 * Replace plugin options
 * Set to `false` to disable the plugin.
 */
replace: RollupReplaceOptions | false;

/**
 * Alias plugin options
 * Set to `false` to disable the plugin.
 */
alias: RollupAliasOptions | false;
```

- **フック名の名前空間化**: `"builder:event"` 形式でフック名を構造化し、interface extends で合成する。新しいビルダーを追加する際、そのビルダーの Hooks 型を定義して extends に追加するだけで、既存のフック体系と衝突しない。

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

- **自己フィルタリング戦略の暗黙的実行順序依存**: 全ビルダーを常に呼び出し、各ビルダーが自分のエントリーをフィルタする方式は、ビルダー間の実行順序が `buildTasks` 配列の並び順に暗黙的に依存する。現状は `untyped → mkdist → rollup → copy` の順で問題ないが、ビルダー間に依存関係が生じた場合（例: rollup の出力を copy が利用する）に順序の保証が脆くなる。

```typescript
// Bad: 実行順序が配列の並びに暗黙依存
const buildTasks = [typesBuild, mkdistBuild, rollupBuild, copyBuild] as const;
for (const task of buildTasks) {
  await task(ctx);
}

// Better: 依存関係が生じた場合は明示的な順序制御を導入
const buildPhases = [
  { name: "generate", tasks: [typesBuild, mkdistBuild] },
  { name: "bundle", tasks: [rollupBuild] },
  { name: "post-process", tasks: [copyBuild] },
];
```

- **巨大なデフォルトオブジェクトリテラル**: `_build()` 内の `defu()` に渡すデフォルト値オブジェクトが70行を超え（`src/build.ts:98-175`）、オプションの全体像が把握しづらい。デフォルト値を別ファイルに切り出すか、ビルダー固有のデフォルト値はビルダー側で管理すると見通しが良くなる。

```typescript
// Bad: 一箇所に全てのデフォルトを集約
const options = defu(buildConfig, pkg.unbuild, inputConfig, preset, {
  name: "default",
  rootDir,
  entries: [],
  // ... 70行以上続く
  rollup: { emitCJS: false, /* ... rollup 固有の詳細設定 */ },
});

// Better: ビルダー固有のデフォルトはビルダーモジュールで定義
import { ROLLUP_DEFAULTS } from "./builders/rollup/defaults";
const options = defu(buildConfig, preset, {
  ...CORE_DEFAULTS,
  rollup: ROLLUP_DEFAULTS,
});
```

## 導出ルール

- `[MUST]` 複数のバックエンド（ビルダー/ドライバー/プロバイダー）を統合するシステムでは、全バックエンドが共有する Context 型を定義し、統一シグネチャ `(ctx: Context) => Promise<void>` で実行する
  - 根拠: unbuild の4ビルダーはすべて `BuildContext` のみを引数に取り、オーケストレーション層のコード変更なしにビルダーの追加・削除が可能（`src/build.ts:293-306`）

- `[MUST]` パイプラインのライフサイクルフックは名前空間付き文字列キー（`"scope:event"` 形式）で定義し、型レベルで合成する
  - 根拠: `BuildHooks` が `extends CopyHooks, UntypedHooks, MkdistHooks, RollupHooks` で合成されており、各ビルダーのフックが名前衝突なく共存している（`src/types.ts:197-202`）

- `[SHOULD]` プラグイン/ミドルウェアのオプション型に `| false` を含め、`false` 設定時にそのプラグインを完全に無効化できるようにする
  - 根拠: Rollup プラグインの各オプション（`replace`, `alias`, `resolve` 等）が `OptionType | false` で定義され、短絡評価 + `filter(Boolean)` で宣言的に合成される（`src/builders/rollup/types.ts:60-107`, `src/builders/rollup/config.ts:114-166`）

- `[SHOULD]` 設定マージの優先順位を「具体性が高い順」で明示的に定めた上で、深いマージユーティリティ（defu 等）を使用する
  - 根拠: `defu(buildConfig, pkg.unbuild, inputConfig, preset, defaults)` の引数順が優先順位そのものであり、この順序がコード上で即座に読み取れる（`src/build.ts:98-175`）

- `[SHOULD]` ゼロコンフィグの自動推論ロジックはプリセット/フックとして実装し、明示的な設定が与えられた場合は無条件にバイパスする
  - 根拠: `autoPreset` は `build:prepare` フックで「エントリーが既に存在する場合は即 return」する条件分岐を持ち、明示設定と自動推論の競合を回避している（`src/auto.ts:21-23`）

- `[AVOID]` ビルダー/プロバイダーの実行順序を配列の並びだけに暗黙的に依存させること（依存関係がある場合はフェーズを明示的に分離する）
  - 根拠: `buildTasks` 配列の並び順が実質的な実行順序を決定しており、コメントによる注記もないため、将来のビルダー追加時に順序問題が起きるリスクがある（`src/build.ts:293-298`）

## 適用チェックリスト

- [ ] 複数のバックエンド/ドライバーを統合するシステムで、共通の Context 型を定義しているか
- [ ] バックエンドの関数シグネチャが統一されており、オーケストレーション層がバックエンドの詳細を知らなくて済むか
- [ ] ライフサイクルフックが名前空間付きで定義され、型レベルで合成されているか
- [ ] プラグインやオプショナル機能に `| false` による無効化パスが用意されているか
- [ ] 設定マージの優先順位がコード上で明確に読み取れるか（引数の順序 = 優先順位）
- [ ] ゼロコンフィグの自動推論と明示的設定の境界が明確か（明示設定がある場合に推論をスキップするか）
- [ ] 複数バックエンドの実行順序に暗黙の依存がないか（依存がある場合はフェーズ分離しているか）
- [ ] バックエンド追加時に既存コードの変更範囲が最小限に収まるか（型の追加 + 配列へのエントリ追加のみで済むか）
