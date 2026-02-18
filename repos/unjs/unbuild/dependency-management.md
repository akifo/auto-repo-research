# dependency-management

> リポジトリ: unjs/unbuild
> 分析日: 2026-02-18

## 概要

unbuild における依存関係の選定方針と分離戦略を分析する。このリポジトリは unjs エコシステムの中核ビルドツールであり、依存パッケージの大半を同エコシステム内で賄いつつ、Rollup/esbuild などの外部ツールチェーンとの接合点を明確に管理している。特に注目すべきは、package.json の `dependencies` / `peerDependencies` / `devDependencies` を活用したビルド時 external 自動判定ロジックと、バンドル境界を型安全に制御する仕組みである。

## 背景にある原則

- **package.json を唯一の依存関係真実源とする**: unbuild はビルド対象パッケージの `package.json` の `dependencies` / `peerDependencies` から外部依存を自動推論する（`src/utils.ts:inferPkgExternals`）。設定ファイルに依存リストを二重管理させず、package.json を Single Source of Truth としてバンドル境界を決定する。これにより「package.json に書いたものだけが外部依存」という暗黙のルールが強制される。

- **エコシステム内パッケージで汎用ユーティリティを置換する**: Node.js 標準の `path` の代わりに `pathe`、glob に `tinyglobby`、モジュール解析に `mlly`、型情報に `pkg-types` を採用している。これらは unjs エコシステム内の軽量代替パッケージであり、クロスプラットフォーム互換性や ESM 対応を一貫して確保する方針の表れである。

- **optional な大型依存は peerDependencies に追い出す**: TypeScript は `peerDependencies` + `peerDependenciesMeta.optional` として宣言されている（`package.json:69-76`）。ビルドツールとして TypeScript を必要とするが、利用者の環境に既にあることを前提とし、バンドルサイズや重複インストールを回避する。

- **プラグインの有効化/無効化を型で制御する**: Rollup プラグインの各オプションは `PluginOptions | false` というユニオン型で定義され（`src/builders/rollup/types.ts:60-106`）、`false` を渡すことでプラグインごと無効化できる。依存の有無を実行時に分岐するのではなく、設定型で「この依存を使わない」選択肢を与える。

## 実例と分析

### package.json からの external 自動推論

unbuild の最も重要な依存管理プラクティスは、package.json の宣言情報からバンドル外部依存を自動的に推論する仕組みである。

`inferPkgExternals` 関数は `dependencies`、`peerDependencies`、`@types/` プレフィックス付きの `devDependencies`、`optionalDependencies` の全キーを外部依存リストに変換する。さらに、パッケージ自身の名前とその `exports` サブパス、`imports` フィールドのハッシュパスもexternalとして登録する。

この推論結果は `build.ts` の `_build` 関数で Node.js builtins と合成され、Rollup の `external` 判定関数に渡される。

### Rollup external 判定の多段フォールバック

`src/builders/rollup/config.ts` の `external` 関数は以下の優先順序で依存をバンドルに含めるか判定する:

1. エイリアス解決後の ID でパッケージ名を推定
2. 明示的な `externals` リストに含まれていれば外部依存
3. ソースコード（相対パス、絶対パス、`src/` 含むパス、自パッケージ名）は常にバンドル
4. `inlineDependencies` に明示されていればバンドル
5. いずれにも該当しなければ暗黙的にバンドルしつつ警告を出力

この設計の要点は「明示されていないインライン化には警告を出す」ことで、意図しない依存の取り込みを開発者に気づかせる点にある。

### 依存バリデーションによるビルド後チェック

`src/validate.ts` の `validateDependencies` 関数はビルド完了後に実行され、以下をチェックする:

- **未使用依存の検出**: `package.json` の `dependencies` に宣言されているがビルド出力で一度も import されていない依存
- **暗黙的依存の検出**: ビルド出力で import されているが `dependencies` / `peerDependencies` / `externals` のいずれにも宣言されていない依存

`failOnWarn: true`（デフォルト）の場合、これらの警告はビルドを失敗させる。

### unjs エコシステムパッケージの一貫した採用

unbuild の `dependencies` 21 パッケージのうち、以下が unjs エコシステム製である:

| パッケージ | 代替対象 | 採用理由 |
|-----------|---------|---------|
| `pathe` | `node:path` | クロスプラットフォーム正規化、ESM 対応 |
| `mlly` | - | ESM モジュール解析・解決 |
| `pkg-types` | 手動 JSON パース | PackageJson 型定義 + ユーティリティ |
| `consola` | `console` | 構造化ログ・カラー出力 |
| `defu` | `Object.assign` / lodash.merge | 深いマージ + undefined 保持 |
| `citty` | commander / yargs | 軽量 CLI フレームワーク |
| `hookable` | EventEmitter | 型安全な非同期フックシステム |
| `jiti` | ts-node / tsx | ランタイム TS/ESM インポート |
| `scule` | change-case | 文字列ケース変換 |
| `tinyglobby` | globby / fast-glob | 軽量 glob ライブラリ |
| `untyped` | - | 型スキーマ生成 |
| `mkdist` | tsc | ファイル単位のトランスパイル + 型生成 |

### 型インポートによる依存境界の明確化

各ビルダーの型定義ファイル（`types.ts`）は外部ライブラリの型を `import type` で取り込み、ランタイム依存とコンパイル時依存を分離している。例えば `src/builders/rollup/types.ts` では Rollup プラグインの Options 型を `import type` で参照しつつ、実際のプラグイン呼び出しは `config.ts` に集約する。

### Node.js builtins の明示的 external 登録

`src/build.ts:127-129` で `Module.builtinModules` とそのプレフィックス付きバージョン（`node:fs` 等）の両方を externals に登録している。これにより、`import fs from "fs"` と `import fs from "node:fs"` の両方のパターンがバンドルに含まれないことを保証する。

## コード例

```typescript
// src/utils.ts:166-196
export function inferPkgExternals(pkg: PackageJson): (string | RegExp)[] {
  const externals: (string | RegExp)[] = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.peerDependencies || {}),
    ...Object.keys(pkg.devDependencies || {}).filter((dep) =>
      dep.startsWith("@types/"),
    ),
    ...Object.keys(pkg.optionalDependencies || {}),
  ];

  if (pkg.name) {
    externals.push(pkg.name);
    if (pkg.exports) {
      for (const subpath of Object.keys(pkg.exports)) {
        if (subpath.startsWith("./")) {
          externals.push(pathToRegex(`${pkg.name}/${subpath.slice(2)}`));
        }
      }
    }
  }

  if (pkg.imports) {
    for (const importName of Object.keys(pkg.imports)) {
      if (importName.startsWith("#")) {
        externals.push(pathToRegex(importName));
      }
    }
  }

  return [...new Set(externals)];
}
```

```typescript
// src/builders/rollup/config.ts:61-106
external(originalId): boolean {
  const resolvedId = resolveAlias(originalId, _aliases);
  const pkgName =
    parseNodeModulePath(resolvedId)?.name ||
    parseNodeModulePath(originalId)?.name ||
    getpkg(originalId);

  // 明示的 external ルールのチェック
  if (
    arrayIncludes(ctx.options.externals, pkgName) ||
    arrayIncludes(ctx.options.externals, originalId) ||
    arrayIncludes(ctx.options.externals, resolvedId)
  ) {
    return true;
  }

  // ソースコードは常にバンドル
  for (const id of [originalId, resolvedId]) {
    if (
      id[0] === "." ||
      isAbsolute(id) ||
      /src[/\\]/.test(id) ||
      id.startsWith(ctx.pkg.name!)
    ) {
      return false;
    }
  }

  // 明示的 inline ルールのチェック
  if (
    ctx.options.rollup.inlineDependencies === true ||
    (Array.isArray(ctx.options.rollup.inlineDependencies) &&
      (arrayIncludes(ctx.options.rollup.inlineDependencies, pkgName) ||
        arrayIncludes(ctx.options.rollup.inlineDependencies, originalId) ||
        arrayIncludes(ctx.options.rollup.inlineDependencies, resolvedId)))
  ) {
    return false;
  }

  // 暗黙的インラインは警告付き
  warn(ctx, `Implicitly bundling "${originalId}"`);
  return false;
},
```

```typescript
// src/validate.ts:8-47
export function validateDependencies(ctx: BuildContext): void {
  const usedDependencies = new Set<string>();
  const unusedDependencies = new Set<string>(
    Object.keys(ctx.pkg.dependencies || {}),
  );
  const implicitDependencies = new Set<string>();
  for (const id of ctx.usedImports) {
    unusedDependencies.delete(id);
    usedDependencies.add(id);
  }
  // ...
  if (unusedDependencies.size > 0) {
    warn(ctx, "Potential unused dependencies found: " + [...unusedDependencies].map((id) => colors.cyan(id)).join(", "));
  }
  if (implicitDependencies.size > 0 && !ctx.options.rollup.inlineDependencies) {
    warn(ctx, "Potential implicit dependencies found: " + [...implicitDependencies].map((id) => colors.cyan(id)).join(", "));
  }
}
```

```typescript
// src/builders/rollup/types.ts:60-66
/**
 * Replace plugin options
 * Set to `false` to disable the plugin.
 */
replace: RollupReplaceOptions | false;
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 複数のビルド戦略（rollup, mkdist, copy, untyped）を統一インターフェースで切り替える
  - 適用条件: 同一の入力に対して異なる処理パイプラインが必要な場合
  - コード例: `src/build.ts:293-306` — `buildTasks` 配列に各ビルダー関数を格納し、統一シグネチャ `(ctx: BuildContext) => Promise<void>` で呼び出す
  - 注意点: 各ビルダーは自身に関係する entries のみをフィルタして処理するため、呼び出し側は全ビルダーを無条件に実行する

- **Null Object パターンの変形** (分類: 振る舞い)
  - 解決する問題: オプションの依存（Rollup プラグイン）を「無効」にする手段
  - 適用条件: プラグインアーキテクチャで個別プラグインのオン/オフが必要な場合
  - コード例: `src/builders/rollup/config.ts:114-166` — `ctx.options.rollup.replace && replace({...})` で `false` なら `undefined` となり `.filter(Boolean)` で除外
  - 注意点: `false` ではなく `undefined` で無効化すると型安全性が損なわれる

## Good Patterns

- **package.json 駆動の external 推論**: 依存の外部化判定を package.json から自動導出することで、設定ファイルと package.json の二重管理を排除する。開発者は package.json の `dependencies` に正しく宣言するだけでバンドル境界が決まる。

```typescript
// src/build.ts:241-247
options.dependencies = Object.keys(pkg.dependencies || {});
options.peerDependencies = Object.keys(pkg.peerDependencies || {});
options.devDependencies = Object.keys(pkg.devDependencies || {});
options.externals.push(...inferPkgExternals(pkg));
options.externals = [...new Set(options.externals)];
```

- **暗黙的バンドルへの警告**: `external` 判定関数のフォールバックで暗黙的にバンドルされる依存に警告を出す。`failOnWarn: true` と組み合わせることで、意図しないバンドルをCI で検出できる。

```typescript
// src/builders/rollup/config.ts:103-106
warn(ctx, `Implicitly bundling "${originalId}"`);
return false;
```

- **プラグイン無効化の型安全な表現**: `PluginOptions | false` ユニオンで「このプラグインを使わない」を明示的に表現する。`undefined` やオプショナルではなく `false` というリテラルを使うことで、「意図的に無効化した」ことが型レベルで読み取れる。

```typescript
// src/builders/rollup/types.ts:89-93
esbuild: EsbuildOptions | false;
```

```typescript
// src/builders/rollup/config.ts:144-148
ctx.options.rollup.esbuild &&
  esbuild({
    sourcemap: ctx.options.sourcemap,
    ...ctx.options.rollup.esbuild,
  }),
```

- **エコシステム内パッケージの一貫採用**: Node.js 標準 API のクロスプラットフォーム互換ラッパーを unjs エコシステムで統一することで、パッケージ間の互換性問題を最小化している。例えば `pathe` は全 16 ファイル中 13 ファイルで使用されている。

## Anti-Patterns / 注意点

- **@types/ を devDependencies から external に含める暗黙ルール**: `inferPkgExternals` は `devDependencies` のうち `@types/` プレフィックスのもののみを external に追加する。これは型定義パッケージがバンドルされることを防ぐための措置だが、この動作はドキュメントに明示されておらず、他の devDependency がバンドルされる可能性がある。

```typescript
// Bad: devDependencies の特定プレフィックスだけを暗黙ルールで拾う
...Object.keys(pkg.devDependencies || {}).filter((dep) =>
  dep.startsWith("@types/"),
),
```

```typescript
// Better: externals に明示的に追加するか、ルールをドキュメントで説明する
externals: [
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.peerDependencies || {}),
  ...Object.keys(pkg.optionalDependencies || {}),
  // devDependencies のうち @types/* のみ — 型定義がバンドルされることを防ぐ
  ...Object.keys(pkg.devDependencies || {}).filter((dep) =>
    dep.startsWith("@types/"),
  ),
],
```

- **self-build 時の循環依存リスク**: `build.config.ts` が `./src` から `defineBuildConfig` をインポートし、`package.json` の `unbuild` script が `jiti ./src/cli` を実行する。自身をビルドするブートストラップ構成は強力だが、依存のバージョン不整合時にデバッグが困難になる。

```typescript
// build.config.ts:1
import { defineBuildConfig } from "./src";
```

## 導出ルール

- `[MUST]` ライブラリのバンドル境界は package.json の依存宣言から自動導出し、設定ファイルと二重管理しない
  - 根拠: unbuild は `inferPkgExternals` で `dependencies` / `peerDependencies` を external リストに変換し、`validateDependencies` でビルド後に宣言と実態の乖離を検出する（`src/utils.ts:166-196`, `src/validate.ts:8-47`）

- `[MUST]` 暗黙的にバンドルされる依存には警告を出し、デフォルトでビルドを失敗させる
  - 根拠: unbuild は `external` 関数でどのカテゴリにも属さない import に `warn` を発行し、`failOnWarn: true` でプロセスを exit(1) する（`src/builders/rollup/config.ts:103-106`, `src/build.ts:407-413`）

- `[SHOULD]` 大型依存やユーザー環境に既存の依存は peerDependencies + optional フラグで宣言する
  - 根拠: TypeScript は `peerDependencies` + `peerDependenciesMeta.optional: true` として宣言され、バンドルサイズと重複インストールを回避している（`package.json:69-76`）

- `[SHOULD]` オプション型に `Options | false` ユニオンを使い、プラグイン・機能の無効化を型安全に表現する
  - 根拠: Rollup プラグインの 6 つのオプションすべてが `PluginOptions | false` 型で定義され、`false` 時にプラグインが除外される（`src/builders/rollup/types.ts:60-106`）

- `[SHOULD]` エコシステム内のユーティリティライブラリを一貫して採用し、同一目的の重複依存を排除する
  - 根拠: unbuild は `path` の代わりに `pathe`、glob に `tinyglobby`、ログに `consola` を全ファイルで統一的に使用し、クロスプラットフォーム互換と ESM 対応を確保している

- `[SHOULD]` Node.js builtins は bare specifier とプレフィックス付き specifier の両方を external に登録する
  - 根拠: `Module.builtinModules` と `Module.builtinModules.map(m => "node:" + m)` の両方を externals に追加している（`src/build.ts:127-129`）

- `[AVOID]` devDependencies に宣言したパッケージが暗黙的にバンドルされる構成にしない — external リストに含まれない devDependency はバンドラが取り込む可能性がある
  - 根拠: `inferPkgExternals` は devDependencies のうち `@types/*` のみを external に含め、それ以外は無視する。意図しない取り込みは `warn` + `failOnWarn` で検出される（`src/utils.ts:170-173`）

## 適用チェックリスト

- [ ] ライブラリプロジェクトの `dependencies` に宣言した全パッケージが実際にバンドル出力から import されているか（未使用依存の検出）
- [ ] バンドル出力が import しているパッケージが `dependencies` または `peerDependencies` に全て宣言されているか（暗黙的依存の検出）
- [ ] 大型の依存やユーザー環境に既存の依存が `peerDependencies` + `optional` で宣言されているか
- [ ] Node.js builtins が `node:` プレフィックス有り/無し両方で external 扱いになっているか
- [ ] プロジェクト内で同一目的のユーティリティライブラリ（path, glob, logging 等）が統一されているか、重複した依存がないか
- [ ] プラグインやオプション機能の無効化が `false` リテラルで型安全に表現できるようになっているか
- [ ] ビルド後に依存整合性を検証する仕組み（lint ルール、ビルドスクリプト内チェック等）が CI に組み込まれているか
