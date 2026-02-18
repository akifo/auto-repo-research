# 設計思想

> リポジトリ: unjs/unbuild
> 分析日: 2026-02-18

## 概要

unbuild は「unified JavaScript build system」を標榜する、複数のビルドツール（Rollup, esbuild, mkdist, untyped）を単一の設定で統合するビルドシステムである。この視点では、なぜ既存の個別ツールをそのまま使わず統合レイヤーを設けたのか、ゼロコンフィグ設計をどう実現しているか、self-build（自身を自身でビルドする）という特異な構造が何を保証しているか、そして unjs エコシステム全体の設計哲学がどうこのツールに反映されているかを分析する。

## 背景にある原則

- **Convention over Configuration（規約優先設計）**: package.json の `exports` フィールドからビルドエントリ・出力フォーマット・型生成の要否をすべて自動推論する。ユーザーが明示的に設定しなくても、package.json を正しく書いていれば正しいビルド出力が得られる。`src/auto.ts` の `inferEntries` 関数がこの設計の中核であり、「設定ファイルは最適化のためにあり、動作のためにあるべきではない」という思想を体現している。

- **Composition over Monolith（合成による統合）**: unbuild は自らバンドラーやトランスパイラを実装せず、Rollup・esbuild・mkdist・untyped という既存の専門ツールを「ビルダー」として組み合わせる。各ビルダーは `builders/` 配下に独立したディレクトリを持ち、共通の `BuildContext` を受け取る統一インタフェースで動作する。これにより、各ツールの進化に追従しながら統合レイヤーの薄さを維持している。

- **Defaults that Just Work（賢いデフォルト値）**: `src/build.ts:98-174` の `defu` によるオプションマージでは、`failOnWarn: true`、`clean: true`、Node.js builtins の自動 external 化、`esnext` ターゲットなど、ライブラリ開発のベストプラクティスをデフォルト値として埋め込んでいる。ユーザーは「何を変えたいか」だけを記述すればよい。

- **Self-Hosting as Verification（セルフホスティングによる品質保証）**: `build.config.ts` で `import { defineBuildConfig } from "./src"` として自身のソースコードから直接ビルド設定を読み込んでいる。これは「dogfooding の極致」であり、ビルドシステム自体の破壊的変更を即座に検知する仕組みとして機能している。

## 実例と分析

### ゼロコンフィグの実現メカニズム

unbuild のゼロコンフィグ設計は、package.json の `exports` フィールドを「ビルド設定の唯一の情報源」として活用する点にある。`src/auto.ts` の `autoPreset` は `build:prepare` フックで動作し、ユーザーが entries を明示していない場合のみ自動推論を行う。

推論ロジックの流れ:
1. `src/` 配下のファイルを再帰的に列挙する
2. package.json の `exports`, `bin`, `main`, `module`, `types` から出力ファイル一覧を抽出する
3. 出力ファイルの拡張子とパスから、対応するソースファイルを自動マッチングする
4. `.mjs` / `.cjs` の出力指定から ESM/CJS の生成要否を判定する
5. `types` フィールドの有無から型定義生成の要否を判定する

この仕組みにより、examples/1.zero-config のように `build.config.ts` が一切存在しないプロジェクトでも、`unbuild` コマンドだけで正しいビルド出力が得られる。

### ビルダーの統合アーキテクチャ

4つのビルダー（rollup, mkdist, copy, untyped）は `src/build.ts:293-306` で統一的に呼び出される。各ビルダーは `(ctx: BuildContext) => Promise<void>` というシグネチャを共有し、`BuildContext` を通じて設定・状態・フック機構にアクセスする。

ビルダー選択のルールは極めてシンプルである。`src/build.ts:228-229` で、エントリのパスが `/` で終わるなら `mkdist`（ディレクトリ単位のファイル変換）、それ以外なら `rollup`（バンドル）が選択される。`untyped` と `copy` はユーザーが明示的に指定する。

### フックによる拡張ポイントの設計

`BuildHooks` 型（`src/types.ts:197-202`）はビルドライフサイクル全体をカバーするフック体系を定義している。構成は以下の通り:
- ビルド全体: `build:prepare`, `build:before`, `build:done`
- Rollup: `rollup:options`, `rollup:build`, `rollup:dts:options`, `rollup:dts:build`, `rollup:done`
- mkdist: `mkdist:entries`, `mkdist:entry:options`, `mkdist:entry:build`, `mkdist:done`
- copy: `copy:entries`, `copy:done`
- untyped: `untyped:entries`, `untyped:entry:options`, `untyped:entry:schema`, `untyped:entry:outputs`, `untyped:done`

フック名は `<ビルダー名>:<ライフサイクル>` の命名規則に従い、予測可能性を高めている。各ビルダーは必ず `entries` フックでフィルタリング後のエントリを公開し、`done` フックで完了を通知する。

### 設定マージの多層戦略

`src/build.ts:98-175` の `defu` によるマージは5層の優先順位を持つ:
1. `build.config.ts` の設定（最優先）
2. `package.json` の `unbuild` / `build` フィールド
3. CLI 引数経由の設定
4. プリセットの設定
5. ハードコードされたデフォルト値（最低優先）

`defu` は deep merge ライブラリであり、ネストされたオブジェクトも再帰的にマージする。これにより、ユーザーは変更したいプロパティだけを指定でき、残りはデフォルト値が補完される。

### 型安全性とバリデーションの二重防御

ビルド後に `src/validate.ts` で依存関係とパッケージ出力の整合性を検証する。`validateDependencies` は使用されたインポートと package.json の dependencies を照合し、未使用依存・暗黙的依存を警告する。`validatePackage` は package.json で宣言された出力ファイルの実在を検証する。`failOnWarn: true` のデフォルトにより、これらの警告はビルドを失敗させる。

## コード例

```typescript
// src/auto.ts:17-62
// autoPreset: build:prepare フックでエントリを自動推論する
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
        if (res.cjs) {
          ctx.options.rollup.emitCJS = true;
        }
        if (ctx.options.declaration === undefined) {
          ctx.options.declaration = res.dts ? "compatible" : false;
        }
      },
    },
  };
});
```

```typescript
// src/build.ts:293-306
// ビルダーの統一的呼び出し: 共通インタフェースで4つのビルダーを直列/並列実行
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

```typescript
// build.config.ts:1-12
// Self-build: 自身のソースコードを直接インポートしてビルド設定に使用
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

```typescript
// src/build.ts:226-229
// Convention-based builder selection: パスの末尾で自動的にビルダーを決定
if (!entry.builder) {
  entry.builder = entry.input.endsWith("/") ? "mkdist" : "rollup";
}
```

```typescript
// src/builders/rollup/config.ts:61-106
// 外部依存判定の多段フォールバック: 明示ルール → ソース判定 → インライン → 暗黙バンドル(警告)
external(originalId): boolean {
  const resolvedId = resolveAlias(originalId, _aliases);
  const pkgName =
    parseNodeModulePath(resolvedId)?.name ||
    parseNodeModulePath(originalId)?.name ||
    getpkg(originalId);

  if (
    arrayIncludes(ctx.options.externals, pkgName) ||
    arrayIncludes(ctx.options.externals, originalId) ||
    arrayIncludes(ctx.options.externals, resolvedId)
  ) {
    return true;
  }

  for (const id of [originalId, resolvedId]) {
    if (id[0] === "." || isAbsolute(id) || /src[/\\]/.test(id)) {
      return false;
    }
  }

  warn(ctx, `Implicitly bundling "${originalId}"`);
  return false;
},
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 異なるビルドツール（Rollup, mkdist, copy, untyped）を統一的に呼び出す
  - 適用条件: 同じ入出力契約を持つ複数のアルゴリズム/ツールを切り替える必要がある場合
  - コード例: `src/build.ts:293-306` ビルダー配列の統一呼び出し、`src/types.ts:14-20` BaseBuildEntry の `builder` フィールド
  - 注意点: unbuild では GoF の Strategy とは異なりクラスベースではなく、`(ctx: BuildContext) => Promise<void>` という関数シグネチャで統一している。型レベルでの明示的なインタフェース定義はなく、暗黙的な契約に依存している

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: ビルドライフサイクルの骨格を固定しつつ、各段階をフックで拡張可能にする
  - 適用条件: 処理の全体フローは固定だが、各ステップのカスタマイズが必要な場合
  - コード例: `src/build.ts:206-311` の `_build` 関数が prepare → normalize → build:before → builders → validate → build:done の固定フローを定義
  - 注意点: 継承ではなく hookable ライブラリのイベント駆動で実現。オーバーライドではなく追加的なフックにより拡張

- **Null Object パターン** (分類: 振る舞い)
  - 解決する問題: プリセットやビルド設定が未指定の場合でも安全に動作させる
  - 適用条件: オプショナルなオブジェクトが null/undefined の場合にデフォルトの振る舞いを提供したい場合
  - コード例: `src/build.ts:38-42` の `|| {}` によるフォールバック、`src/utils.ts:76-77` の `autoPreset` がデフォルトプリセットとして機能
  - 注意点: TypeScript の型システムと `defu` の deep merge を組み合わせることで、明示的な Null Object クラスなしに同等の効果を得ている

## Good Patterns

- **package.json を Single Source of Truth として活用**: ビルドエントリ・出力フォーマット・型生成の要否を package.json の `exports` から推論する。ビルド設定と公開設定の乖離を構造的に防止し、`package.json → ビルド出力 → バリデーション → package.json の宣言と照合` という循環的な整合性チェックを実現している。

```typescript
// src/auto.ts:69-97
export function inferEntries(
  pkg: PackageJson,
  sourceFiles: string[],
  rootDir?: string,
): InferEntriesResult {
  const outputs = extractExportFilenames(pkg.exports);
  if (pkg.bin) { /* ... */ }
  if (pkg.main) { outputs.push({ file: pkg.main }); }
  if (pkg.module) { outputs.push({ type: "esm", file: pkg.module }); }
  if (pkg.types || pkg.typings) { outputs.push({ file: pkg.types || pkg.typings! }); }
  // ...
}
```

- **Rollup プラグインの条件付き合成**: 各プラグインを `ctx.options.rollup.<plugin> && <plugin>(...)` の短絡評価で条件付き挿入し、末尾の `.filter(Boolean)` で falsy 値を除去する。プラグインの有効/無効を `false` 値で制御でき、設定 API の表現力と型安全性を両立している。

```typescript
// src/builders/rollup/config.ts:114-166
plugins: [
  ctx.options.rollup.replace && replace({ ...ctx.options.rollup.replace }),
  ctx.options.rollup.alias && alias({ ...ctx.options.rollup.alias }),
  ctx.options.rollup.resolve && nodeResolve({ ...ctx.options.rollup.resolve }),
  // ...
].filter((p): p is NonNullable<Exclude<typeof p, false>> => !!p),
```

- **暗黙的動作の警告**: 外部依存の判定で明示的なルールに合致しない場合、暗黙的にバンドルしつつ警告を発する（`src/builders/rollup/config.ts:103-104`）。`failOnWarn: true` のデフォルトと組み合わせることで、「動くが危険な状態」を許容せず、ユーザーに明示的な判断を促す。

```typescript
// src/builders/rollup/config.ts:103-104
warn(ctx, `Implicitly bundling "${originalId}"`);
return false;
```

- **`satisfies` による型安全なデフォルト値**: デフォルトオプションの定義に `satisfies BuildOptions` を使い、型推論を保ちながら構造的な型チェックを行っている。`as BuildOptions` と異なり、型の情報を失わない。

```typescript
// src/build.ts:103-174
const options = defu(
  buildConfig,
  pkg.unbuild || pkg.build,
  inputConfig,
  preset,
  { /* ... */ } satisfies BuildOptions,
) as BuildOptions;
```

## Anti-Patterns / 注意点

- **暗黙的な関数契約の脆弱性**: 4つのビルダー関数は `(ctx: BuildContext) => Promise<void>` という同一シグネチャを持つが、これは型レベルで明示されていない。ビルダーの配列は `as const` で固定されているものの、新しいビルダーを追加する際にシグネチャの不整合を型チェッカーが検知できない。

```typescript
// Bad: 暗黙的な契約
const buildTasks = [
  typesBuild,
  mkdistBuild,
  rollupBuild,
  copyBuild,
] as const;
```

```typescript
// Better: 明示的なインタフェースで契約を型レベルで表現
type Builder = (ctx: BuildContext) => Promise<void>;
const buildTasks: readonly Builder[] = [
  typesBuild,
  mkdistBuild,
  rollupBuild,
  copyBuild,
];
```

- **警告の重複排除とリッチなエラー情報のトレードオフ**: `ctx.warnings` が `Set<string>` であるため、同じメッセージの重複は排除される。しかし文字列比較に依存しているため、同じ種類の問題でもコンテキスト情報が異なると別の警告として扱われる。構造化された警告オブジェクトの方が集約・フィルタリングに適している。

```typescript
// Bad: 文字列ベースの警告
export function warn(ctx: BuildContext, message: string): void {
  if (ctx.warnings.has(message)) { return; }
  ctx.warnings.add(message);
}
```

```typescript
// Better: 構造化された警告
interface BuildWarning {
  code: string;
  message: string;
  source?: string;
}
warnings: Map<string, BuildWarning>;
```

## 導出ルール

- `[MUST]` ビルドツールのデフォルト設定は「ライブラリ公開のベストプラクティス」を反映させ、ユーザーが変更したい部分だけを記述する設計にする
  - 根拠: unbuild は `failOnWarn: true`, `clean: true`, Node builtins の自動 external 化をデフォルトにし、ゼロコンフィグで安全なビルドを実現している（`src/build.ts:98-174`）

- `[MUST]` ツール自身のビルドにツール自身を使う（self-hosting / dogfooding）ことで、破壊的変更を即座に検知する仕組みを持つ
  - 根拠: unbuild は `build.config.ts` で `import { defineBuildConfig } from "./src"` として自身をビルドし、CI の `pnpm build` ステップで自動的に回帰テストとして機能する（`build.config.ts:1`）

- `[SHOULD]` 既存のマニフェストファイル（package.json, tsconfig.json 等）から設定を推論し、専用の設定ファイルなしでも動作する Convention over Configuration 設計を採用する
  - 根拠: `src/auto.ts` が package.json の `exports` フィールドからビルドエントリ・フォーマット・型生成を自動推論し、examples/1.zero-config のように設定ファイルなしでビルドできる

- `[SHOULD]` 複数のツールを統合する際は、共通コンテキストオブジェクトを介した統一インタフェースとフック機構で拡張性を確保する
  - 根拠: 4つのビルダーが `BuildContext` を共有し、`hookable` によるライフサイクルフックで各段階にユーザーコードを挿入できる（`src/types.ts:197-202`, `src/build.ts:184-203`）

- `[SHOULD]` 暗黙的な動作には必ず警告を伴わせ、デフォルトで警告をエラーとして扱うことで、ユーザーに明示的な判断を促す
  - 根拠: 外部依存の暗黙バンドル時に `warn()` を呼び、`failOnWarn: true` のデフォルトでビルドを失敗させる設計（`src/builders/rollup/config.ts:103-104`, `src/build.ts:407`）

- `[SHOULD]` deep merge ライブラリ（defu 等）を用いた多層設定マージにより、設定の優先順位を明確にしつつ部分的なオーバーライドを可能にする
  - 根拠: `src/build.ts:98-175` で buildConfig > pkg.unbuild > inputConfig > preset > defaults の5層マージを `defu` で実現している

- `[AVOID]` プラグインやビルダーの合成で、型レベルでの契約なしに暗黙的な関数シグネチャに依存すること
  - 根拠: ビルダー配列は `as const` で固定されているが、`Builder` 型のような明示的なインタフェースがなく、新規ビルダー追加時にシグネチャの不整合を型チェッカーが検知できない（`src/build.ts:293-298`）

## 適用チェックリスト

- [ ] ビルドツールやCLIツールを開発する場合、ツール自身をそのツールでビルドする self-hosting 構造を導入しているか
- [ ] ゼロコンフィグ設計を目指す場合、既存のマニフェストファイル（package.json 等）から必要な情報を推論するロジックを実装しているか
- [ ] デフォルト値はターゲットユースケース（ライブラリ公開、アプリビルド等）のベストプラクティスを反映しているか
- [ ] 複数のツールを統合する場合、共通のコンテキストオブジェクトと統一インタフェースで抽象化しているか
- [ ] ライフサイクルの各段階にフック（イベント）を設け、ユーザーが拡張できるポイントを明確にしているか
- [ ] 暗黙的な動作（自動推論、フォールバック等）には警告を伴わせ、ユーザーが意図しない動作に気づける仕組みがあるか
- [ ] 設定のマージ戦略（優先順位、deep merge の挙動）が明確に定義されているか
- [ ] ビルド後のバリデーション（出力ファイルの存在確認、依存関係の整合性チェック）を組み込んでいるか
