# design-philosophy

> リポジトリ: unjs/unbuild
> 分析日: 2026-02-16

## 概要

unbuild の設計思想を分析する。ゼロコンフィグ推論・unjs エコシステムによる機能分解・hook ベースの拡張性・セルフホスティングの 4 つの軸から、DX を最優先にしたビルドツール設計のプラクティスを抽出する。小規模なコードベース（43 ファイル）にもかかわらず、rollup・mkdist・untyped・copy の 4 ビルダーを統合し、package.json だけで ESM/CJS/DTS のデュアルパブリッシュを実現する仕組みは、「設定より規約」アプローチの優れた実装例である。

## 背景にある原則

- **Convention over Configuration（規約による推論）**: ビルド設定を明示的に書かせず、package.json の `exports`・`main`・`module`・`types`・`bin` フィールドから自動的にエントリポイント・出力フォーマット・型定義生成の要否を推論する（`src/auto.ts:69-169`）。ユーザーが「何をビルドするか」ではなく「何をパブリッシュするか」を宣言すれば、ビルドはそこから逆算される。
- **Composable Ecosystem（小さなツールの合成）**: 単一の巨大ツールを作るのではなく、各関心事を独立パッケージ（pathe, consola, defu, hookable, citty, mlly, pkg-types, jiti, mkdist, untyped）に分解し、それらを組み合わせて機能を構築する。unbuild 自体はこれらのオーケストレーターとして振る舞い、各機能の実装詳細を外部に委譲している。
- **Safe Defaults with Escape Hatches（安全なデフォルト + 脱出口）**: `failOnWarn: true`・`clean: true`・`externals` に全 builtinModules を含むなど、安全側に倒したデフォルトを提供しつつ、`build.config.ts` や hook システムで任意のカスタマイズを許容する（`src/build.ts:98-175`）。
- **Dogfooding by Self-Hosting（セルフホスティングによる自己検証）**: unbuild は自身を unbuild でビルドする（`package.json` の `"build": "pnpm unbuild"`、`build.config.ts` で `defineBuildConfig` を使用）。これによりツール自体がユーザーと同じ体験を強制的に経験し、設計上の問題を早期に発見できる。

## 実例と分析

### package.json からの自動推論

`auto.ts` の `inferEntries` 関数は、package.json のフィールドを入力として受け取り、ビルドエントリを逆算する。この「出力から入力を推論する」アプローチが unbuild のゼロコンフィグの核心である。

推論のステップ:
1. `exports`・`bin`・`main`・`module`・`types` から出力ファイル一覧を抽出（`src/auto.ts:80-97`）
2. 出力ファイルの拡張子と `type` フィールドから ESM/CJS を判別（`src/auto.ts:100-108`）
3. 出力パスからソースファイルを逆引きし、エントリポイントを特定（`src/auto.ts:114-166`）
4. `.d.ts` 出力があれば型定義生成を有効化（`src/auto.ts:158-159`）

この設計により、zero-config の例（`examples/1.zero-config/`）では `build.config.ts` が存在せず、package.json の `exports` フィールドだけでビルドが完結する。

### defu によるレイヤードマージ

設定の優先順位を `defu`（deep defaults utility）で実現している。`defu` は「先に定義された値を優先する」セマンティクスを持つため、引数の順序がそのまま優先順位になる:

```
buildConfig > pkg.unbuild > inputConfig > preset > hardcoded defaults
```

これにより、ユーザーの明示的な設定 > package.json 内の設定 > CLI 引数 > プリセット > デフォルト値という自然な優先順位が宣言的に表現される。

### hook システムによるプラグインアーキテクチャ

全 4 ビルダーが統一的な hook インターフェースを持つ。hook は粒度の異なる 3 レイヤーで提供される:

1. **ライフサイクル hook**: `build:prepare` → `build:before` → `build:done`
2. **ビルダー固有 hook**: `rollup:options` → `rollup:build` → `rollup:dts:options` → `rollup:dts:build` → `rollup:done`
3. **エントリ単位 hook**: `mkdist:entry:options` → `mkdist:entry:build`、`untyped:entry:options` → `untyped:entry:schema` → `untyped:entry:outputs`

hook の登録は preset → inputConfig → buildConfig の順で行われ（`src/build.ts:195-203`）、後から登録した hook が後に実行される。これにより、プリセットのデフォルト動作をユーザー設定で上書きできる。

### ビルダーのプラグイン有効/無効パターン

Rollup プラグインの設定で `false` を渡すとプラグイン自体が無効化されるパターンを採用している:

```typescript
// src/builders/rollup/config.ts:114-166
plugins: [
  ctx.options.rollup.replace && replace({ ... }),
  ctx.options.rollup.esbuild && esbuild({ ... }),
  ctx.options.rollup.commonjs && commonjs({ ... }),
].filter((p): p is NonNullable<Exclude<typeof p, false>> => !!p),
```

型定義でもこのパターンが反映されている（`src/builders/rollup/types.ts:65-100`）。各プラグインオプションは `PluginOptions | false` 型で定義され、`false` で明示的に無効化できる。

## コード例

```typescript
// src/auto.ts:17-61 — autoPreset: package.json からの自動推論をフックとして実装
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
        for (const message of res.warnings) {
          warn(ctx, message);
        }
        ctx.options.entries.push(...res.entries);
        // ...
      },
    },
  };
});
```

```typescript
// src/build.ts:98-175 — defu によるレイヤードコンフィグマージ
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
    // ...
    failOnWarn: true,
    rollup: {
      emitCJS: false,
      // ...
      esbuild: { target: "esnext" },
    },
  } satisfies BuildOptions,
) as BuildOptions;
```

```typescript
// src/types.ts:204-208 — defineBuildConfig: 型安全なヘルパー関数
export function defineBuildConfig(
  config: BuildConfig | BuildConfig[],
): BuildConfig[] {
  return (Array.isArray(config) ? config : [config]).filter(Boolean);
}
```

```typescript
// src/validate.ts:8-47 — ビルド後の依存関係検証
export function validateDependencies(ctx: BuildContext): void {
  const usedDependencies = new Set<string>();
  const unusedDependencies = new Set<string>(
    Object.keys(ctx.pkg.dependencies || {}),
  );
  const implicitDependencies = new Set<string>();
  // ... 使用された import を追跡し、未使用・暗黙依存を警告
}
```

```typescript
// build.config.ts:1-12 — セルフホスティング: unbuild 自身のビルド設定
import { defineBuildConfig } from "./src";

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
  - 解決する問題: 異なるビルド方式（rollup/mkdist/untyped/copy）を統一的に扱う
  - 適用条件: 同一インターフェースで異なるアルゴリズムを切り替える場面
  - コード例: `src/build.ts:293-298` — `buildTasks` 配列に各ビルダーを格納し、順次またはパラレルに実行
  - 注意点: 各ビルダーは `(ctx: BuildContext) => Promise<void>` という統一シグネチャを持つが、内部で `entry.builder` フィールドによりフィルタリングする自己選択式

- **Observer パターン** (分類: 振る舞い)
  - 解決する問題: ビルドプロセスの各段階をユーザーが監視・介入できるようにする
  - 適用条件: プロセスの拡張ポイントを外部に公開したい場面
  - コード例: `src/build.ts:191-206` — `hookable` による hook 登録、各ビルダーでの `callHook` 呼び出し
  - 注意点: hook は async 対応。`hookable` は unjs 独自の軽量実装で、EventEmitter より型安全

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: ビルドの骨格（prepare → before → build → done）を固定し、各ステップの実装を差し替え可能にする
  - 適用条件: アルゴリズムの構造は共通だが、個々のステップが異なる場面
  - コード例: `src/build.ts:206-398` — `build:prepare` → `build:before` → builder 実行 → validate → `build:done`

## Good Patterns

- **define ヘルパーによる型安全な設定**: `defineBuildConfig` と `definePreset` は実行時にはほぼ何もしない（配列化と filter のみ）が、IDE 上での型補完とバリデーションを提供する。この「型のためだけの関数」パターンにより、JSON や plain object では得られない開発体験を実現する。

```typescript
// src/types.ts:204-208
export function defineBuildConfig(
  config: BuildConfig | BuildConfig[],
): BuildConfig[] {
  return (Array.isArray(config) ? config : [config]).filter(Boolean);
}
```

- **satisfies による型安全なデフォルト値**: `as` キャストではなく `satisfies` 演算子を使い、デフォルト値オブジェクトが `BuildOptions` の構造に合致することをコンパイル時に検証している。`defu` のマージ結果は型推論が困難なため、入力側で型安全性を確保するアプローチ。

```typescript
// src/build.ts:174
} satisfies BuildOptions,
```

- **ビルド後の自動検証**: ビルド完了後に `validateDependencies` と `validatePackage` を実行し、未使用依存・暗黙依存・package.json で宣言されたファイルの欠損を検出する（`src/build.ts:394-395`）。`failOnWarn: true` がデフォルトのため、CI で問題を早期に発見できる。

```typescript
// src/build.ts:402-414
if (ctx.warnings.size > 0) {
  consola.warn(
    "Build is done with some warnings:\n\n" +
      [...ctx.warnings].map((msg) => "- " + msg).join("\n"),
  );
  if (ctx.options.failOnWarn) {
    consola.error(
      "Exiting with code (1). You can change this behavior by setting `failOnWarn: false` .",
    );
    process.exit(1);
  }
}
```

- **スタブモードによる開発体験の高速化**: `unbuild --stub` で dist に jiti ベースの JIT コンパイルスタブを生成し、ソースコードの変更が即座に反映される。ビルド→テストのフィードバックループを除去する発想。

```typescript
// src/builders/rollup/stub.ts:141-163 (MJS スタブ生成の核心部分)
`import { createJiti } from ${JSON.stringify(jitiESMPath)};`,
// ...
`const jiti = createJiti(import.meta.url, ${serializedJitiOptions})`,
`const _module = await jiti.import(${JSON.stringify(resolvedEntry)});`,
```

## Anti-Patterns / 注意点

- **暗黙のインライン化による予期しないバンドルサイズ膨張**: externals にも dependencies にも含まれないモジュールは暗黙的にバンドルにインラインされ、警告のみ出力される。これは安全側（ランタイムエラーを防ぐ）だが、意図しないバンドルサイズの増大を招く可能性がある。

```typescript
// Bad: 依存関係を package.json に宣言し忘れると暗黙インライン
// src/builders/rollup/config.ts:103-104
warn(ctx, `Implicitly bundling "${originalId}"`);
return false; // external ではなくインラインする

// Better: 依存関係は必ず package.json に明示し、
// failOnWarn: true（デフォルト）で CI を止める
```

- **`as` キャストによる型安全性の喪失**: `defu` のマージ結果を `as BuildOptions` でキャストしている箇所がある。`defu` の戻り値型が deep merge の正確な型を推論できないための妥協だが、ランタイムエラーのリスクがある。

```typescript
// Bad: defu の結果を as でキャスト
// src/build.ts:175
) as BuildOptions;

// Better: defu の結果を runtime validation (Zod 等) で検証する
// ただし unbuild のケースではパフォーマンスとのトレードオフ
```

## 導出ルール

- `[MUST]` ツールのデフォルト設定は「安全側」に倒す（`failOnWarn: true`、`clean: true`、builtinModules の自動 external 化）。ユーザーが明示的にオプトアウトする設計にすることで、暗黙の不具合を防ぐ
  - 根拠: unbuild は `failOnWarn: true` をデフォルトとし、未使用依存・暗黙インライン・出力ファイル欠損を CI で検出する（`src/build.ts:136`, `src/build.ts:402-414`）
- `[MUST]` 設定ファイルには `defineXxx` 形式の型安全ヘルパー関数を提供する。実行時ロジックは最小限にし、主目的は IDE の型補完と入力検証とする
  - 根拠: `defineBuildConfig` は配列化と filter のみ行い、型推論だけで開発者の設定ミスを防止する（`src/types.ts:204-208`）
- `[SHOULD]` 設定のマージは「明示的な優先順位チェーン」で行い、deep merge ユーティリティ（defu 等）を使って宣言的に表現する。条件分岐による手続き的なマージを避ける
  - 根拠: unbuild は `defu(buildConfig, pkg.unbuild, inputConfig, preset, defaults)` の引数順序で優先順位を表現し、複雑な if 文を排除している（`src/build.ts:98-175`）
- `[SHOULD]` ゼロコンフィグを実現する場合、「出力仕様（マニフェスト）から入力を逆算する」アプローチを採る。ユーザーが宣言するのは「何を公開するか」であり、「どうビルドするか」はツールが推論する
  - 根拠: unbuild は package.json の `exports`/`main`/`module`/`types` からエントリポイントとフォーマットを自動推論する（`src/auto.ts:69-169`）
- `[SHOULD]` ビルドツール・開発ツールは自身のツールで自身をビルドする（セルフホスティング）。ユーザーと同じ体験を自ら経験することで、DX 上の問題を早期発見できる
  - 根拠: unbuild は `build.config.ts` で `defineBuildConfig` を使い、`pnpm unbuild` で自身をビルドする（`package.json:20`, `build.config.ts`）
- `[SHOULD]` プラグインの有効/無効は、オプション型を `PluginOptions | false` とし、`false` で明示的に無効化する API にする。プラグインが未設定の場合はデフォルトで有効にする
  - 根拠: Rollup プラグイン群は全て `options | false` の型定義を持ち、`false` が渡された場合は `.filter(Boolean)` で除外される（`src/builders/rollup/types.ts:65-100`, `src/builders/rollup/config.ts:114-166`）
- `[AVOID]` ビルドプロセスの拡張を「設定オプションの追加」だけで対応しようとすること。hook/plugin システムを提供し、想定外のカスタマイズにも対応できる拡張ポイントを残す
  - 根拠: unbuild は 20 以上の hook ポイント（build:prepare, rollup:options, mkdist:entry:options 等）を提供し、設定だけでは対応できないカスタマイズを可能にしている（`src/types.ts:197-202`, 各ビルダーの types.ts）

## 適用チェックリスト

- [ ] ツールのデフォルト設定を「安全側」に倒しているか？（厳格なバリデーション、自動クリーンアップ等がデフォルトで有効か）
- [ ] 設定ファイルに `defineXxx` 形式の型安全ヘルパーを提供しているか？（IDE 補完だけで設定ミスを防げるか）
- [ ] 設定のマージに明示的な優先順位チェーンを使っているか？（条件分岐の手続き的マージになっていないか）
- [ ] ゼロコンフィグが可能な場面で、出力仕様から入力を逆算する推論ロジックを実装しているか？
- [ ] 自分のツール/ライブラリを自分自身で使ってビルド・テストしているか？（セルフホスティング）
- [ ] プラグイン・拡張機能に `options | false` パターンを採用し、無効化の API を提供しているか？
- [ ] 設定オプションだけでなく、hook/plugin による拡張ポイントを提供しているか？
- [ ] エコシステムの機能を単一ツールに埋め込まず、独立パッケージに分解して合成しているか？
