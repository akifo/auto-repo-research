# Hook and Lifecycle Patterns

> リポジトリ: unjs/unbuild
> 分析日: 2026-02-18

## 概要

unbuild は hookable ライブラリを使い、ビルドプロセス全体を「prepare -> before -> builders -> done」という直線的なライフサイクルで制御しつつ、各ビルダー内部にもフェーズごとの細粒度フックを提供している。この設計により、ユーザーは `build.config.ts` の `hooks` フィールドに関数を渡すだけで、ビルドパイプラインの任意の段階に介入できる。特筆すべきは、フック定義が TypeScript の型安全なインターフェース合成で管理されている点、および preset/inputConfig/buildConfig の3層からフックを段階的に登録する優先度モデルである。

## 背景にある原則

- **ライフサイクルの線形化**: ビルドツールの処理は本質的に複雑だが、フックポイントを線形のフェーズ列として公開することで、ユーザーが介入タイミングを直感的に理解できるようにすべき。unbuild は `build:prepare -> build:before -> (各 builder のフック群) -> build:done` という一方向フローを徹底している（`src/build.ts:206-398`）。

- **context オブジェクトの一貫した受け渡し**: 全フックの第1引数に `BuildContext` を渡すことで、フック間で状態を暗黙的に共有する必要をなくし、かつフックハンドラが自律的に動作できるようにすべき。unbuild では 21 箇所の `callHook` すべてが `ctx` を第1引数に渡す一貫したシグネチャを持つ。

- **型によるフック契約の強制**: フック名とそのシグネチャを TypeScript の interface で宣言し、`Hookable<BuildHooks>` のジェネリクスで制約することで、存在しないフック名の呼び出しや引数の型ミスマッチをコンパイル時に検出すべき。手動の文字列ベースのイベントシステムではこの保証が得られない（`src/types.ts:197-202`, `src/builders/*/types.ts`）。

- **合成による拡張**: フック定義を各ビルダーの型ファイルに分散配置し、最終的に `BuildHooks extends CopyHooks, UntypedHooks, MkdistHooks, RollupHooks` で合成する。新しいビルダーを追加する際はその型ファイルにフック定義を追加し、`BuildHooks` の extends に加えるだけでよい（`src/types.ts:197-202`）。

## 実例と分析

### ライフサイクルフェーズの全体構造

ビルドプロセスは以下のフェーズに分かれる。各フェーズには対応するフックが存在し、ユーザーの介入を許可する。

1. **prepare** (`build:prepare`): コンテキスト構築直後、エントリ正規化前。設定の動的変更に使う
2. **before** (`build:before`): エントリ正規化・外部依存解決後、実際のビルド開始前
3. **builder-specific**: 各ビルダーが独自のフックを発火（後述）
4. **done** (`build:done`): 全ビルド完了後。バリデーション・クリーンアップ後に発火

```
build:prepare -> build:before -> [builder hooks] -> build:done
```

重要なのは、`build:done` がスタブモード・ウォッチモードの場合も含め、すべてのコードパスで確実に呼ばれることである。

### フックの登録: 3層の優先度モデル

フックは3つのソースから段階的に登録される。

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

hookable の `addHooks` は既存のフックを上書きせず追加する。したがって同一フック名に対して複数のハンドラが登録可能であり、preset -> CLI入力 -> build.config.ts の順で全てが実行される。

### ビルダーごとのフック粒度の設計

4つのビルダーはそれぞれ異なる粒度のフックを提供するが、共通パターンがある。

**共通パターン**: `<builder>:entries` (開始) -> `<builder>:entry:*` (エントリ単位) -> `<builder>:done` (完了)

| ビルダー | entries | entry-level hooks | done |
|---------|---------|-------------------|------|
| rollup | - | `rollup:options`, `rollup:build`, `rollup:dts:options`, `rollup:dts:build` | `rollup:done` |
| mkdist | `mkdist:entries` | `mkdist:entry:options`, `mkdist:entry:build` | `mkdist:done` |
| untyped | `untyped:entries` | `untyped:entry:options`, `untyped:entry:schema`, `untyped:entry:outputs` | `untyped:done` |
| copy | `copy:entries` | - | `copy:done` |

rollup ビルダーはエントリ列挙フックを持たないが、代わりに `rollup:options` でオプション全体（入力エントリを含む）を操作できる。また DTS ビルド用に独立したフックペア (`rollup:dts:options`, `rollup:dts:build`) を持ち、通常ビルドと型定義ビルドで異なる介入が可能。

### フックインターフェースの型合成

各ビルダーが自分のフック型を独立して定義し、最終的に intersection で合成される。

```typescript
// src/types.ts:197-202
export interface BuildHooks
  extends CopyHooks, UntypedHooks, MkdistHooks, RollupHooks {
  "build:prepare": (ctx: BuildContext) => void | Promise<void>;
  "build:before": (ctx: BuildContext) => void | Promise<void>;
  "build:done": (ctx: BuildContext) => void | Promise<void>;
}
```

各ビルダーのフック型は、そのビルダーの型ファイル内にコロケーションされている。

```typescript
// src/builders/mkdist/types.ts:9-25
export interface MkdistHooks {
  "mkdist:entries": (
    ctx: BuildContext,
    entries: MkdistBuildEntry[],
  ) => void | Promise<void>;
  "mkdist:entry:options": (
    ctx: BuildContext,
    entry: MkdistBuildEntry,
    options: MkdistOptions,
  ) => void | Promise<void>;
  // ...
}
```

### self-build でのフック実用例

unbuild 自身の `build.config.ts` がフックを使い、不要な型定義ファイルをビルド後に削除している。

```typescript
// build.config.ts:4-12
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

これは `build:done` がバリデーション完了後に呼ばれることを利用し、生成された不要ファイルをクリーンアップする実用的なパターンである。

### preset でのフック定義

テストフィクスチャの preset がフックを含む例。

```typescript
// test/fixture/build.preset.ts:3-16
export default definePreset({
  declaration: "compatible",
  rollup: {
    cjsBridge: true,
  },
  hooks: {
    "build:before": () => {
      console.log("Before build");
    },
    "build:done": () => {
      console.log("After build");
    },
  },
});
```

preset にフックを含められることで、「設定 + 振る舞い」をセットで再利用可能なユニットとして配布できる。

### rollup:options フックによるビルド設定の動的変更

rollup ビルダーでは、オプション構築後・ビルド実行前にフックが呼ばれる。

```typescript
// src/builders/rollup/build.ts:22-24
const rollupOptions = getRollupOptions(ctx);
await ctx.hooks.callHook("rollup:options", ctx, rollupOptions);
```

`RollupOptions` オブジェクトへの参照が渡されるため、フック内でプラグインの追加・削除、input の変更などが可能。これは「設定をミュータブルなオブジェクトとしてフックに渡す」パターンで、Webpack の compiler hooks や Nuxt の hook システムと同じアプローチである。

## コード例

ビルドコンテキスト生成とフック登録の全体像。

```typescript
// src/build.ts:184-206
const ctx: BuildContext = {
  options,
  jiti,
  warnings: new Set(),
  pkg,
  buildEntries: [],
  usedImports: new Set(),
  hooks: createHooks(),
};

// Register hooks
if (preset.hooks) {
  ctx.hooks.addHooks(preset.hooks);
}
if (inputConfig.hooks) {
  ctx.hooks.addHooks(inputConfig.hooks);
}
if (buildConfig.hooks) {
  ctx.hooks.addHooks(buildConfig.hooks);
}

// Allow prepare and extending context
await ctx.hooks.callHook("build:prepare", ctx);
```

スタブモード・通常モード両方で `build:done` が呼ばれる保証。

```typescript
// src/build.ts:308-312 (stub/watch mode)
if (options.stub || options.watch) {
  await ctx.hooks.callHook("build:done", ctx);
  return;
}

// src/build.ts:398 (normal mode)
await ctx.hooks.callHook("build:done", ctx);
```

untyped ビルダーのフェーズごとのフック発火。

```typescript
// src/builders/untyped/index.ts:23-89
await ctx.hooks.callHook("untyped:entries", ctx, entries);

for (const entry of entries) {
  // ...
  await ctx.hooks.callHook("untyped:entry:options", ctx, entry, options);
  // ... resolve schema ...
  await ctx.hooks.callHook("untyped:entry:schema", ctx, entry, schema);
  // ... generate outputs ...
  await ctx.hooks.callHook("untyped:entry:outputs", ctx, entry, outputs);
  // ... write files ...
}
await ctx.hooks.callHook("untyped:done", ctx);
```

## パターンカタログ

- **Observer パターン** (分類: 振る舞い)
  - 解決する問題: ビルドパイプラインの各段階に外部から介入する仕組みの提供
  - 適用条件: パイプラインのフェーズが明確で、各フェーズのシグネチャが型で定義できる場合
  - コード例: `src/build.ts:191`（`createHooks()` でインスタンス生成）、`src/build.ts:206`（`callHook` で通知）
  - 注意点: hookable は同期/非同期の両方をサポートし、`callHook` は常に Promise を返す。全ハンドラが直列に実行される（並列ではない）

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: ビルドの骨格（prepare -> before -> build -> done）を固定しつつ、各ステップの具体的な振る舞いをフックで差し替え可能にする
  - 適用条件: 処理の順序は固定だが、各ステップの内容を外部から制御したい場合
  - コード例: `src/build.ts:206-398`（`_build` 関数がテンプレートメソッドとして機能）
  - 注意点: フックは「差し替え」ではなく「追加」なので、デフォルト動作は常に実行される

- **Composite パターン（型レベル）** (分類: 構造)
  - 解決する問題: 複数のビルダーが定義するフック型を統一的に扱う
  - 適用条件: サブシステムごとに独立したフック定義があり、統合された型として利用者に提供したい場合
  - コード例: `src/types.ts:197-202`（`BuildHooks extends CopyHooks, UntypedHooks, MkdistHooks, RollupHooks`）
  - 注意点: TypeScript の interface extends は intersection と同等。フック名の衝突に注意が必要

## Good Patterns

- **一貫した第1引数としての Context**: 21 箇所すべての `callHook` 呼び出しが `ctx: BuildContext` を第1引数に渡す。フックハンドラはコンテキストへのアクセスが保証され、グローバル状態やクロージャへの依存が不要になる。

```typescript
// src/builders/mkdist/types.ts:14-17
"mkdist:entry:options": (
  ctx: BuildContext,
  entry: MkdistBuildEntry,
  options: MkdistOptions,
) => void | Promise<void>;
```

- **namespace:action 命名規約によるフック名の構造化**: フック名は `<namespace>:<action>` または `<namespace>:<scope>:<action>` 形式で統一されている。これにより、フック一覧を見るだけでどのビルダーのどのフェーズに対応するかが即座にわかる。

```
build:prepare, build:before, build:done
rollup:options, rollup:build, rollup:dts:options, rollup:dts:build, rollup:done
mkdist:entries, mkdist:entry:options, mkdist:entry:build, mkdist:done
untyped:entries, untyped:entry:options, untyped:entry:schema, untyped:entry:outputs, untyped:done
copy:entries, copy:done
```

- **フック型定義のコロケーション**: 各ビルダーのフック型はそのビルダーの `types.ts` に定義され、エントリ型やオプション型と同居している。フック型が「どのビルダーに属するか」が物理的なファイル配置で明示される。

```typescript
// src/builders/copy/types.ts:8-14 (copy のフック定義は copy のディレクトリ内)
export interface CopyHooks {
  "copy:entries": (ctx: BuildContext, entries: CopyBuildEntry[]) => void | Promise<void>;
  "copy:done": (ctx: BuildContext) => void | Promise<void>;
}
```

- **早期リターン時もライフサイクル完了フックを呼ぶ**: rollup ビルダーはスタブモード時やエントリ空時に早期リターンするが、いずれの場合も `rollup:done` を呼んでからリターンする。ライフサイクルの完了通知が条件分岐に関わらず保証される。

```typescript
// src/builders/rollup/build.ts:15-20
if (ctx.options.stub) {
  await rollupStub(ctx);
  await ctx.hooks.callHook("rollup:done", ctx);
  return;
}
```

## Anti-Patterns / 注意点

- **フックでのミュータブル引数への暗黙的依存**: `rollup:options` フックはオプションオブジェクトへの参照を渡し、フック内での変更を期待する。これは柔軟だが、複数のフックハンドラが同じオブジェクトを変更する場合に順序依存や意図しない上書きが起こりうる。

```typescript
// Bad: 複数のフックが同じ options を競合的に変更
hooks: {
  "rollup:options"(ctx, options) {
    options.plugins = [myPlugin]; // 既存プラグインをすべて消してしまう
  }
}

// Better: 既存値を尊重した追加的変更
hooks: {
  "rollup:options"(ctx, options) {
    options.plugins.push(myPlugin); // 追加のみ
  }
}
```

- **フックの存在を前提としたテスト設計の欠如**: テストコードで `hooks: [] as any` として型を回避している箇所がある。フックシステムをモック化する標準的な手段が用意されていないため、テスト時にフックの振る舞いを検証しにくい。

```typescript
// test/validate.test.ts:49 (hooks を型安全にモックできていない)
hooks: [] as any,
```

## 導出ルール

- `[MUST]` ライフサイクルの完了フック（done / cleanup 等）は、早期リターン・エラーパスを含むすべてのコードパスで呼び出す
  - 根拠: unbuild の rollup ビルダーはスタブモード・エントリ空・通常モードのいずれでも `rollup:done` を呼んでからリターンする（`src/builders/rollup/build.ts:18,28,129`）

- `[MUST]` フック型を TypeScript の interface として宣言し、ジェネリクスでフックシステムに渡して、フック名・引数の型安全性をコンパイル時に保証する
  - 根拠: `Hookable<BuildHooks>` により存在しないフック名やシグネチャ不一致がコンパイルエラーになる（`src/types.ts:166`）

- `[SHOULD]` フック名は `namespace:action` または `namespace:scope:action` のコロン区切り命名規約に従い、所属と意味を構造的に表現する
  - 根拠: unbuild の全 17 フック名がこの規約に従い、ビルダー名とフェーズが一目でわかる命名になっている

- `[SHOULD]` すべてのフックハンドラの第1引数に共有コンテキストオブジェクトを渡し、フック間の状態共有を明示的にする
  - 根拠: unbuild の全フックが `ctx: BuildContext` を第1引数に取り、グローバル変数やクロージャへの依存を排除している

- `[SHOULD]` フック型定義は、そのフックを発火するモジュールとコロケーションし、最終的に intersection（extends）で合成する
  - 根拠: `CopyHooks` は `src/builders/copy/types.ts`、`RollupHooks` は `src/builders/rollup/types.ts` に定義され、`BuildHooks` で合成される構造により、ビルダー追加時の変更箇所が局所化されている

- `[SHOULD]` フックに渡すミュータブルオブジェクトは「追加的変更」を前提とした設計にし、破壊的変更のリスクをドキュメント・型で示す
  - 根拠: `rollup:options` フックは `RollupOptions` への参照を渡して変更を許可するが、`plugins` 配列の置換など破壊的操作の防止機構はない

- `[AVOID]` フックシステムにおいてイベント名を文字列リテラルのみで管理し、型による制約を設けないこと
  - 根拠: hookable + TypeScript の組み合わせにより、フック名のタイポや引数ミスマッチがコンパイル時に検出される。型なしの `EventEmitter` ではこの保証が得られない

## 適用チェックリスト

- [ ] プロジェクトのパイプライン処理に明確なフェーズ（初期化・前処理・本処理・後処理）を定義し、各フェーズにフックポイントを設置しているか
- [ ] フック名が `namespace:action` 形式の構造化された命名規約に従っているか
- [ ] フック型が TypeScript の interface として宣言され、フックシステムにジェネリクスで渡されているか
- [ ] 全フックの第1引数が共有コンテキストオブジェクトになっているか
- [ ] ライフサイクル完了フックが早期リターン・エラーパスを含む全コードパスで呼ばれることが保証されているか
- [ ] フック型定義が、フックを発火するモジュールと同じディレクトリにコロケーションされているか
- [ ] 複数ソース（preset, config, CLI入力等）からのフック登録が可能で、全ハンドラが実行される仕組みになっているか
- [ ] フックに渡すオブジェクトの変更範囲（追加のみ / 置換可）が明確にされているか
