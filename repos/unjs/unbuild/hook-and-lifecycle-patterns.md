# hook-and-lifecycle-patterns

> リポジトリ: unjs/unbuild
> 分析日: 2026-02-16

## 概要

unbuild は `hookable` ライブラリを用いて、ビルドパイプライン全体に 20 のフックポイントを設置し、ユーザーやプリセットが各フェーズに介入できる拡張モデルを実現している。注目すべきは、グローバルライフサイクル（`build:prepare` / `build:before` / `build:done`）とビルダー固有ライフサイクル（`rollup:options` / `mkdist:entry:options` 等）を単一の型合成（intersection type）で統合し、1 つの `Hookable` インスタンスに集約している点である。これにより、プリセット・CLI 入力・`build.config.ts` の 3 層からフックを登録でき、ビルドプロセスの任意のフェーズを宣言的にカスタマイズできる設計が成立している。

## 背景にある原則

- **単一コンテキスト伝搬の原則**: フック間で共有状態を受け渡す場合、グローバルなミュータブルオブジェクト（`BuildContext`）を全フックの第一引数として渡す。これにより、フック間のデータ連携に別の仕組み（イベントバス、DI コンテナ等）を導入する必要がない。根拠: 全 20 フックが `ctx: BuildContext` を第一引数に取る設計（`src/types.ts:197-202`, 各ビルダーの hooks 型定義）。

- **フェーズ分離による介入粒度の制御**: ビルドプロセスを「準備→構成→実行→完了」のフェーズに分割し、各フェーズ間にフックを挿入することで、ユーザーが介入できるタイミングを制御する。「構成フェーズ」でオプションを変更し、「実行フェーズ」で成果物に触り、「完了フェーズ」で後処理を行う — この分離が暗黙のルールとなっている。根拠: `build:prepare`（コンテキスト拡張）→ `build:before`（設定確定後）→ ビルダー実行 → `build:done`（後処理）の順序（`src/build.ts:206-398`）。

- **型による契約としてのフック定義**: フックの名前・引数・戻り値を TypeScript の interface で厳密に定義し、フック登録側と呼び出し側の契約を型レベルで保証する。これにより、存在しないフック名の登録や引数の型不一致がコンパイル時に検出される。根拠: `BuildHooks` が `CopyHooks & UntypedHooks & MkdistHooks & RollupHooks` の intersection で構成されている（`src/types.ts:197-202`）。

- **登録順序による優先度制御**: 複数のフック提供元（preset → inputConfig → buildConfig）を順序付きで登録することで、後から登録されたフックが補完的に動作する。hookable は同一フック名に複数のハンドラを登録でき、登録順に実行されるため、preset の振る舞いを buildConfig で上書きではなく追加的に拡張できる。根拠: `src/build.ts:195-203` の addHooks 呼び出し順序。

## 実例と分析

### グローバルライフサイクルの 3 フェーズ設計

`build.ts` はビルドプロセスを 3 つのグローバルフックで区切っている。

```typescript
// src/build.ts:206
await ctx.hooks.callHook("build:prepare", ctx);

// ... エントリ正規化、依存関係推論 ...

// src/build.ts:250
await ctx.hooks.callHook("build:before", ctx);

// ... ビルダー実行（untyped → mkdist → rollup → copy） ...

// src/build.ts:398
await ctx.hooks.callHook("build:done", ctx);
```

`build:prepare` と `build:before` の間にエントリの正規化処理（`src/build.ts:209-238`）が挟まる設計が重要である。`build:prepare` でコンテキストを自由に変更でき（例: auto preset がエントリを自動推論して `ctx.options.entries` に追加する）、その後のパイプラインがその変更を前提として動作する。

### auto preset によるフックを活用した自動設定

`autoPreset` は `build:prepare` フックだけを実装したプリセットであり、`package.json` からエントリを自動推論する。

```typescript
// src/auto.ts:17-61
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
      },
    },
  };
});
```

このパターンでは、プリセットが「設定オブジェクトの静的なマージ」ではなく「フックによる動的な設定生成」を行っている。条件分岐（エントリが既に存在する場合はスキップ）も含められるため、静的マージでは不可能な柔軟性を実現している。

### ビルダー固有フックの粒度設計

4 つのビルダーはそれぞれ異なる粒度のフックを持つ。最も細かいのは untyped ビルダーで、4 段階のフックを持つ。

```typescript
// src/builders/untyped/types.ts:21-42
export interface UntypedHooks {
  "untyped:entries": (ctx, entries) => void | Promise<void>;
  "untyped:entry:options": (ctx, entry, options) => void | Promise<void>;
  "untyped:entry:schema": (ctx, entry, schema) => void | Promise<void>;
  "untyped:entry:outputs": (ctx, entry, outputs) => void | Promise<void>;
  "untyped:done": (ctx) => void | Promise<void>;
}
```

対照的に copy ビルダーは 2 つだけ（`copy:entries`, `copy:done`）。フックの粒度はビルダーの複雑度に比例している。

| ビルダー | フック数 | 粒度 |
|---------|---------|------|
| rollup | 5 | options → build → dts:options → dts:build → done |
| untyped | 5 | entries → entry:options → entry:schema → entry:outputs → done |
| mkdist | 4 | entries → entry:options → entry:build → done |
| copy | 2 | entries → done |

### フック名の名前空間規約

全フック名は `<namespace>:<phase>` または `<namespace>:<sub>:<phase>` の形式に従う。

```
build:prepare, build:before, build:done          — グローバル
rollup:options, rollup:build, rollup:done         — rollup ビルダー
rollup:dts:options, rollup:dts:build              — rollup DTS サブフェーズ
mkdist:entries, mkdist:entry:options              — mkdist ビルダー
untyped:entry:schema, untyped:entry:outputs       — untyped ビルダー
copy:entries, copy:done                           — copy ビルダー
```

コロン区切りの階層構造により、フック名だけでどのビルダーのどのフェーズかが判別できる。

### フック登録の 3 層モデル

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

preset（基盤）→ inputConfig（CLI/プログラマティック入力）→ buildConfig（`build.config.ts`）の順で登録される。hookable は同一フック名に対して複数ハンドラを登録順に実行するため、最もユーザーに近い buildConfig のフックが最後に実行される。

### ミュータブルな引数によるオプション変更パターン

rollup ビルダーでは、`rollup:options` フックにオプションオブジェクトへの参照を渡し、ユーザーが直接変更できるようにしている。

```typescript
// src/builders/rollup/build.ts:23-24
const rollupOptions = getRollupOptions(ctx);
await ctx.hooks.callHook("rollup:options", ctx, rollupOptions);
```

フック内で `rollupOptions.plugins.push(...)` や `rollupOptions.external = ...` とすることで、ビルド設定を完全にカスタマイズできる。戻り値ではなく引数の変更で制御する設計は、複数のフックハンドラが順次実行される場合に特に有効である（各ハンドラが同じオブジェクトを段階的に変更できる）。

### 早期リターンによるフェーズスキップ

rollup ビルダーは stub モードで一部のフェーズをスキップしつつ、`rollup:done` は必ず呼ぶ。

```typescript
// src/builders/rollup/build.ts:15-19
if (ctx.options.stub) {
  await rollupStub(ctx);
  await ctx.hooks.callHook("rollup:done", ctx);
  return;
}
```

同様に、入力エントリが空の場合もビルドをスキップするが `rollup:done` は発火する（`src/builders/rollup/build.ts:27-29`）。完了フックの確実な呼び出しは、リソースクリーンアップやログ出力の信頼性を保証する。

## パターンカタログ

- **Observer パターン** (分類: 振る舞い)
  - 解決する問題: ビルドパイプラインの各フェーズに外部コードが介入する仕組み
  - 適用条件: パイプラインの処理順序が固定で、各ステップ間にカスタムロジックを挿入したい場合
  - コード例: `src/build.ts:191`（`createHooks()` でオブザーバーを生成）、`src/build.ts:195-203`（`addHooks` でリスナー登録）
  - 注意点: hookable は pub/sub ではなく async waterfall 的な振る舞い（順次実行・await）を提供する。並列実行が必要な場面には不向き

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: ビルドの骨格（prepare → before → builders → done）を固定しつつ、各ステップの詳細を交換可能にする
  - 適用条件: 処理の大枠は共通だが、個々のステップをプリセットやユーザー設定で差し替えたい場合
  - コード例: `src/build.ts:206-398`（固定のフェーズ順序）、`src/auto.ts:17-61`（prepare ステップの実装をフックで提供）
  - 注意点: フックで骨格自体（フェーズの順序や有無）を変更することはできない。柔軟性と予測可能性のトレードオフ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 4 種類のビルダー（rollup, mkdist, untyped, copy）を統一的に呼び出す
  - 適用条件: 複数のアルゴリズム（ビルド方式）を同一インターフェースで切り替えたい場合
  - コード例: `src/build.ts:293-306`（`buildTasks` 配列で全ビルダーを統一的に実行）
  - 注意点: 各ビルダーが内部でエントリをフィルタする設計（`e.builder === "rollup"` 等）のため、Strategy の選択がビルダー内部に委ねられている

## Good Patterns

- **フック型の intersection 合成**: `BuildHooks extends CopyHooks, UntypedHooks, MkdistHooks, RollupHooks` により、各ビルダーが独立してフック型を定義し、統合は親型で行う。新しいビルダーを追加する場合、そのビルダーの hooks 型を定義して intersection に加えるだけで済む。

```typescript
// src/types.ts:197-202
export interface BuildHooks
  extends CopyHooks, UntypedHooks, MkdistHooks, RollupHooks {
  "build:prepare": (ctx: BuildContext) => void | Promise<void>;
  "build:before": (ctx: BuildContext) => void | Promise<void>;
  "build:done": (ctx: BuildContext) => void | Promise<void>;
}
```

- **プリセットをフックで実装する**: `autoPreset` は静的設定ではなく `build:prepare` フックとして動的ロジックを持つ。条件分岐や外部情報の参照（`package.json` のフィールド、ファイルシステムの走査）を含められるため、設定ファイルのマージでは表現できないロジックをプリセットに封じ込められる。

```typescript
// src/auto.ts:17-21
export const autoPreset: BuildPreset = definePreset(() => {
  return {
    hooks: {
      "build:prepare"(ctx): void {
        if (!ctx.pkg || ctx.options.entries.length > 0) {
          return;
        }
        // 動的にエントリを推論して ctx.options.entries に追加
```

- **完了フックの保証付き呼び出し**: 早期リターンやスキップの分岐でも `done` フックを必ず呼ぶ。rollup ビルダーでは stub モード・空エントリ・通常ビルドの 3 パスすべてで `rollup:done` が呼ばれる（`src/builders/rollup/build.ts:18,28,129`）。

## Anti-Patterns / 注意点

- **完了フックの呼び忘れ**: パイプラインに早期リターンの分岐を追加する際、`done` フックの呼び出しを忘れるとリソースリークや不整合が発生する。unbuild では各ビルダーが自分で `done` を呼ぶ責任を持つが、try/catch でのエラー時にはこの保証が崩れる可能性がある。

```typescript
// Bad: エラー時に done が呼ばれない
async function myBuild(ctx) {
  await ctx.hooks.callHook("my:options", ctx, options);
  const result = await doSomething(options); // ここで例外が発生すると...
  await ctx.hooks.callHook("my:done", ctx);  // ここに到達しない
}

// Better: try/finally で done を保証する
async function myBuild(ctx) {
  await ctx.hooks.callHook("my:options", ctx, options);
  try {
    const result = await doSomething(options);
  } finally {
    await ctx.hooks.callHook("my:done", ctx);
  }
}
```

- **ミュータブル引数の暗黙の依存**: フックにオブジェクト参照を渡してユーザーが直接変更する設計は、複数のフックハンドラ間で暗黙の依存を生む。あるハンドラが `plugins` 配列を置き換えると、別のハンドラが追加したプラグインが消える。

```typescript
// Bad: 配列全体を置き換える
hooks: {
  "rollup:options"(ctx, options) {
    options.plugins = [myPlugin()]; // 他のプラグインがすべて消える
  }
}

// Better: 既存の配列に追加する
hooks: {
  "rollup:options"(ctx, options) {
    options.plugins.push(myPlugin());
  }
}
```

## 導出ルール

- `[MUST]` ライフサイクルフックの完了イベント（done/finish/end）はすべてのコードパス（早期リターン・エラー含む）で発火を保証する
  - 根拠: unbuild の rollup ビルダーは stub モード・空エントリ・通常ビルドの 3 分岐すべてで `rollup:done` を呼ぶ（`src/builders/rollup/build.ts:18,28,129`）

- `[MUST]` フック名はコロン区切りの名前空間で `<scope>:<phase>` の形式に統一し、スコープとフェーズを名前だけで識別可能にする
  - 根拠: unbuild の全 20 フックがこの規約に従い、`rollup:dts:options` のようなサブスコープも一貫して表現している（`src/builders/rollup/types.ts:113-131`）

- `[SHOULD]` フックの型定義はサブシステムごとに独立した interface で宣言し、親の型で intersection 合成する
  - 根拠: `BuildHooks extends CopyHooks, UntypedHooks, MkdistHooks, RollupHooks` により、各ビルダーのフック定義が独立して変更・追加できる（`src/types.ts:197-202`）

- `[SHOULD]` パイプラインのフックには、処理対象のオブジェクト参照を引数として渡し、ユーザーがインプレースで変更できるようにする（戻り値による置換ではなく引数の変更）
  - 根拠: `rollup:options` フックが `RollupOptions` 参照を渡し、ユーザーが `options.plugins.push(...)` で拡張する設計（`src/builders/rollup/build.ts:23-24`）

- `[SHOULD]` プリセット機構を「静的な設定マージ」ではなく「prepare フックによる動的ロジック」として実装し、条件分岐や外部情報参照を含む設定生成を可能にする
  - 根拠: `autoPreset` が `build:prepare` フックとして実装され、ファイルシステム走査 + package.json 解析でエントリを動的に推論する（`src/auto.ts:17-61`）

- `[SHOULD]` フックの登録順序に意味を持たせる場合、「基盤→拡張→ユーザー」の順で登録し、ユーザーに最も近い層が最後に実行されるようにする
  - 根拠: preset → inputConfig → buildConfig の順で `addHooks` を呼び、`build.config.ts` のフックが最終的な調整権を持つ（`src/build.ts:195-203`）

- `[AVOID]` フックのコールバック内でオブジェクトのプロパティを丸ごと置換する操作（他のフックハンドラが追加した変更を消す恐れがある）
  - 根拠: `rollup:options` で `options.plugins = [...]` とすると、コアが設定したプラグインチェーンが消失する。配列なら `push`、オブジェクトなら spread で追加的に変更すべき

## 適用チェックリスト

- [ ] パイプラインのフェーズを「準備（prepare）→ 構成（before/options）→ 実行（build）→ 完了（done）」に分割し、各境界にフックポイントを設置しているか
- [ ] フック名が `<scope>:<phase>` の名前空間規約に従っているか
- [ ] 完了フック（done/finish）がすべてのコードパス（早期リターン・例外・スキップ含む）で発火するか
- [ ] フック型が TypeScript の interface で厳密に定義され、フック名の typo や引数ミスがコンパイル時に検出されるか
- [ ] サブシステムごとのフック型が独立して定義され、intersection 合成で統合されているか
- [ ] フック登録の優先順位（基盤→拡張→ユーザー）が明確に設計されているか
- [ ] フックの引数としてミュータブルなオブジェクト参照を渡す場合、ドキュメントで「追加的変更」を推奨し「置換」を非推奨としているか
- [ ] プリセットやプラグインが prepare フックを通じて動的設定を注入できる仕組みがあるか
