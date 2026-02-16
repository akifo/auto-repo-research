# Build and Tooling

> リポジトリ: ryoppippi/ccusage
> 分析日: 2026-02-16

## 概要

ccusage は pnpm workspace によるモノレポ上で、tsdown（esbuild/rolldown ベース）をバンドラーに採用し、pnpm catalogs による厳格な依存バージョン管理、unplugin-macros によるビルド時データ埋め込み、publint/unused による出荷品質の自動検証を一貫して適用している。サプライチェーン攻撃への防御を pnpm-workspace.yaml のセキュリティ設定で体系化している点、および開発時は `.ts` を直接実行しつつ `publishConfig` で出荷時のみ `dist/` に切り替える二重エクスポート戦略が注目に値する。

## 背景にある原則

- **依存バージョンの一元管理（Single Source of Truth）**: `catalogMode: strict` により、全ワークスペースパッケージが `catalog:<category>` 経由でのみバージョンを参照する。カテゴリ分類（build, docs, lint, runtime, testing, types, release, llm-docs）によって依存の役割を明示し、バージョン不整合を構造的に排除する。根拠: `pnpm-workspace.yaml:6` の `catalogMode: strict` と各 `package.json` での `"catalog:runtime"` 等の参照パターン。

- **ビルド成果物の出荷品質を自動保証する**: tsdown の `publint: true`（パッケージ互換性チェック）と `unused: true`（未使用 export 検出）をビルド設定に直接組み込むことで、CI やリリースフローと独立してビルド時点で品質ゲートを通す。根拠: 6 つの `tsdown.config.ts` すべてで `publint: true` と `unused: true` が設定されている。

- **開発体験とパッケージ互換性を両立する二重エクスポート**: `exports` フィールドでは `./src/index.ts` を直接指し、`publishConfig.exports` では `./dist/index.js` を指す。開発中は TypeScript をそのまま実行でき、npm publish 時に `publishConfig` が上書きする。根拠: `apps/ccusage/package.json:19-25` と `apps/ccusage/package.json:37-43`。

- **サプライチェーンの防衛的設定**: ビルドスクリプトの実行をホワイトリスト制に、新規リリースパッケージに 48 時間の待機期間を設け、依存の信頼性低下（downgrade）を禁止する。根拠: `pnpm-workspace.yaml:79-89` の `strictDepBuilds`, `blockExoticSubdeps`, `trustPolicy`, `minimumReleaseAge`, `allowBuilds`。

## 実例と分析

### pnpm catalogs によるカテゴリ別依存管理

pnpm catalogs はバージョンの一元管理だけでなく、依存の意味的分類を強制する仕組みとして機能している。`catalog:build` にはバンドラ関連、`catalog:runtime` にはアプリケーション実行時の依存、`catalog:testing` にはテスト関連というように、依存追加時にその「役割」を宣言させる。

`catalogMode: strict` が設定されているため、catalog を経由しない直接バージョン指定はエラーになる。これにより「どのパッケージがどのカテゴリに属するか」がワークスペース設定に集約される。

特徴的なのは `catalog:llm-docs` カテゴリで、`@gunshi/docs` や `@praha/byethrow-docs` という LLM 向けドキュメントパッケージを管理している。ドキュメント生成パイプラインでライブラリの型情報を LLM が読める形式で提供する仕組みが、依存管理レベルで組み込まれている。

### tsdown の統一ビルド設定パターン

6 つの app すべてが tsdown を使用し、共通の設定パターンを持つ。ライブラリパッケージ（ccusage, mcp, pi）向けの「フル品質チェック付き」設定と、実行専用バイナリ（amp, opencode）向けの「軽量」設定の 2 パターンに分かれる。

**ライブラリ向け共通設定**:
- `minify: 'dce-only'`（Dead Code Elimination のみ、難読化なし）
- `treeshake: true`
- `publint: true` + `unused: true`（品質ゲート）
- `nodeProtocol: true`（`node:` プレフィクス強制）
- `exports.devExports: true`
- `define: { 'import.meta.vitest': 'undefined' }`（in-source test の除去）

**実行専用バイナリ向け設定**（amp, opencode）:
- `dts: false`（型定義不要）
- `shims: true` + `platform: 'node'` + `target: 'node20'`
- publint/unused なし（npm に publish しないか、エクスポートを持たないため）

### unplugin-macros によるビルド時データ埋め込み

pricing データ（API の料金情報）をビルド時にネットワークフェッチし、バンドルに静的に埋め込む。`_macro.ts` ファイルに async 関数を定義し、それを `with { type: 'macro' }` で import すると、ビルド時に関数が実行されて戻り値がインライン化される。

この仕組みにより、ランタイムでのネットワーク依存が排除され、`--offline` フラグの実装が自然になる。ccusage, codex, amp の 3 アプリがこのパターンを使用し、それぞれ異なるモデルプレフィクスでフィルタリングしている。

### `_` プレフィクスによる内部ファイルの制御

`apps/ccusage/src/` では、公開 API となるファイル（`index.ts`, `calculate-cost.ts`, `data-loader.ts` 等）と内部実装ファイル（`_date-utils.ts`, `_pricing-fetcher.ts`, `_macro.ts` 等）を `_` プレフィクスで区別している。tsdown の entry 設定で `'!./src/_*.ts'` として内部ファイルをバンドル対象から除外し、`exports` フィールドでは公開ファイルのみ列挙する。

### in-source testing と vitest の統合

`import.meta.vitest` を使った in-source testing が全パッケージで採用されている。34 ファイルで使用されており、実装とテストが同一ファイルに共存する。vitest 設定の `includeSource: ['src/**/*.{js,ts}']` で認識し、tsdown の `define: { 'import.meta.vitest': 'undefined' }` で本番ビルド時にテストコードを除去する。

### publishConfig による開発/出荷の切り替え

`bin` フィールドは開発時 `./src/index.ts` を直接指し、`publishConfig.bin` で `./dist/index.js` に切り替わる。`exports` も同様の二重構造。これにより `bun ./src/index.ts` での即時実行と `npx ccusage` での dist 実行が同じ package.json で共存する。

### リリースパイプライン

```
prerelease (各 app) → lint → typecheck → build
release (root)      → bumpp -r（全パッケージのバージョンバンプ）
postrelease (root)  → git checkout ./**/package.json（バンプ後のリセット）
prepack (各 app)    → build && clean-pkg-json（パッケージ最小化）
```

`postrelease` で package.json を `git checkout` するのは、bumpp が変更した package.json を git の状態に戻すため。publish は npm の `prepack` スクリプト経由で行われ、`clean-pkg-json` が devDependencies 等を除去した最小 package.json を生成する。

## コード例

```typescript
// apps/ccusage/tsdown.config.ts:1-35
import { defineConfig } from 'tsdown';
import Macros from 'unplugin-macros/rolldown';

export default defineConfig({
	entry: [
		'./src/*.ts',
		'!./src/**/*.test.ts', // Exclude test files
		'!./src/_*.ts', // Exclude internal files with underscore prefix
	],
	outDir: 'dist',
	format: 'esm',
	clean: true,
	sourcemap: false,
	minify: 'dce-only',
	treeshake: true,
	fixedExtension: false,
	dts: {
		tsgo: false,
		resolve: ['type-fest', 'valibot', '@ccusage/internal', '@ccusage/terminal'],
	},
	publint: true,
	unused: true,
	exports: {
		devExports: true,
	},
	nodeProtocol: true,
	plugins: [
		Macros({
			include: ['src/index.ts', 'src/_pricing-fetcher.ts'],
		}),
	],
	define: {
		'import.meta.vitest': 'undefined',
	},
});
```

```typescript
// apps/ccusage/src/_macro.ts:1-24
import type { LiteLLMModelPricing } from '@ccusage/internal/pricing';
import {
	createPricingDataset,
	fetchLiteLLMPricingDataset,
	filterPricingDataset,
} from '@ccusage/internal/pricing-fetch-utils';

function isClaudeModel(modelName: string, _pricing: LiteLLMModelPricing): boolean {
	return (
		modelName.startsWith('claude-') ||
		modelName.startsWith('anthropic.claude-') ||
		modelName.startsWith('anthropic/claude-')
	);
}

export async function prefetchClaudePricing(): Promise<Record<string, LiteLLMModelPricing>> {
	try {
		const dataset = await fetchLiteLLMPricingDataset();
		return filterPricingDataset(dataset, isClaudeModel);
	} catch (error) {
		console.warn('Failed to prefetch Claude pricing data, proceeding with empty cache.', error);
		return createPricingDataset();
	}
}
```

```typescript
// apps/ccusage/src/_pricing-fetcher.ts:3
import { prefetchClaudePricing } from './_macro.ts' with { type: 'macro' };

const PREFETCHED_CLAUDE_PRICING = prefetchClaudePricing();
```

```yaml
# pnpm-workspace.yaml:76-89
# Security settings for supply chain attack prevention
strictDepBuilds: true
blockExoticSubdeps: true
trustPolicy: no-downgrade

# Explicitly allow build scripts for packages that require them
allowBuilds:
  esbuild: true
  sharp: true
  sqlite3: true
  workerd: true
```

```json
// apps/ccusage/package.json:19-43（exports と publishConfig の二重構造）
"exports": {
    ".": "./src/index.ts",
    "./calculate-cost": "./src/calculate-cost.ts",
    "./data-loader": "./src/data-loader.ts",
    "./debug": "./src/debug.ts",
    "./logger": "./src/logger.ts",
    "./package.json": "./package.json"
},
"publishConfig": {
    "bin": {
        "ccusage": "./dist/index.js"
    },
    "exports": {
        ".": "./dist/index.js",
        "./calculate-cost": "./dist/calculate-cost.js",
        "./data-loader": "./dist/data-loader.js",
        "./debug": "./dist/debug.js",
        "./logger": "./dist/logger.js",
        "./package.json": "./package.json"
    }
}
```

## パターンカタログ

- **Dual Export Strategy** (分類: 構造)
  - 解決する問題: 開発時の TypeScript 直接実行と npm publish 時のビルド成果物配布を両立する
  - 適用条件: TypeScript で書かれた npm パッケージで、開発時に Bun/tsx 等で直接実行する場合
  - コード例: `apps/ccusage/package.json:19-43`
  - 注意点: `publishConfig` に `exports` を書き忘れると、ソースの `.ts` ファイルが publish されてしまう

- **Build-time Data Embedding** (分類: 生成)
  - 解決する問題: ランタイムのネットワーク依存を排除しつつ、常に最新のデータをバンドルに含める
  - 適用条件: ビルド時にフェッチ可能で、頻繁には変わらないがリリースごとに更新したいデータ
  - コード例: `apps/ccusage/src/_macro.ts:16-24`, `apps/ccusage/src/_pricing-fetcher.ts:3`
  - 注意点: ビルド環境にネットワークアクセスが必要。フォールバック（空データ返却）を必ず実装する

- **Convention-based Visibility Control** (分類: 構造)
  - 解決する問題: TypeScript にはパッケージレベルの可視性制御がないため、export 対象と内部実装を区別する方法が必要
  - 適用条件: 複数のエクスポートを持つ TypeScript パッケージ
  - コード例: `apps/ccusage/tsdown.config.ts:8` の `'!./src/_*.ts'`
  - 注意点: ファイル命名規約をチーム内で徹底する必要がある。ESLint ルール等で強制できると望ましい

## Good Patterns

- **`minify: 'dce-only'` による可読性と最適化の両立**: CLI ツールにおいて、完全な minify ではなく Dead Code Elimination のみを適用する。エラー時のスタックトレースが読みやすく保たれつつ、未使用コードは除去される。

```typescript
// apps/ccusage/tsdown.config.ts:14
minify: 'dce-only',
```

- **`dts.resolve` によるワークスペース内パッケージの型解決**: `@ccusage/internal` 等のワークスペース内パッケージの型を `.d.ts` に解決・インライン化することで、publish 後に消費者が `@ccusage/internal` を別途インストールする必要がなくなる。

```typescript
// apps/ccusage/tsdown.config.ts:17-20
dts: {
    tsgo: false,
    resolve: ['type-fest', 'valibot', '@ccusage/internal', '@ccusage/terminal'],
},
```

- **`erasableSyntaxOnly` と `verbatimModuleSyntax` の全パッケージ適用**: TypeScript 5.5+ の `erasableSyntaxOnly` を全 tsconfig で有効にし、Node.js の `--experimental-strip-types` との互換性を確保。`verbatimModuleSyntax` で import/export の書き換えを防ぎ、バンドラーとの挙動不一致を回避する。

```json
// packages/internal/tsconfig.json:18-19
"verbatimModuleSyntax": true,
"erasableSyntaxOnly": true,
```

- **カテゴリ分類された pnpm catalogs**: 8 カテゴリ（build, docs, lint, llm-docs, release, runtime, testing, types）に分類することで、依存の追加時に「この依存はどの用途か」を必ず考えさせる設計になっている。

```yaml
# pnpm-workspace.yaml:8-72
catalogs:
  build:
    tsdown: ^0.16.6
  runtime:
    valibot: ^1.1.0
  testing:
    vitest: ^4.0.15
```

- **`preinstall: "npx only-allow pnpm"` によるパッケージマネージャ強制**: npm や yarn での誤ったインストールを防ぐ。`shellEmulator: true` と組み合わせて、プラットフォーム差異を吸収する。

```json
// package.json:18
"preinstall": "npx only-allow pnpm",
```

## Anti-Patterns / 注意点

- **tsconfig の重複定義**: 全 9 パッケージの tsconfig.json が、共通の `compilerOptions` をそれぞれ独立して定義している。`extends` による共通設定の抽出が行われていないため、設定変更時に全ファイルを更新する必要がある。ただし、各パッケージの `types` フィールドが異なるため、意図的に分離している可能性もある。

```json
// Bad: 9ファイルに同一設定が重複
// apps/ccusage/tsconfig.json
{
    "compilerOptions": {
        "strict": true,
        "noUncheckedIndexedAccess": true,
        "verbatimModuleSyntax": true,
        "erasableSyntaxOnly": true
        // ... 他の共通設定
    }
}
```

```json
// Better: 共通設定を抽出して extends
// tsconfig.base.json
{
    "compilerOptions": {
        "strict": true,
        "noUncheckedIndexedAccess": true,
        "verbatimModuleSyntax": true,
        "erasableSyntaxOnly": true
    }
}
// apps/ccusage/tsconfig.json
{
    "extends": "../../tsconfig.base.json",
    "compilerOptions": {
        "types": ["@types/bun", "vitest/globals", "vitest/importMeta"]
    }
}
```

- **ビルド時マクロのネットワーク依存**: `_macro.ts` のビルド時フェッチはオフライン環境やネットワーク制限のある CI で失敗しうる。フォールバック（空データ返却）は実装されているが、その場合に `--offline` モードが正常に動作しない。

```typescript
// Bad: ビルド失敗時のフォールバックが空データ
catch (error) {
    console.warn('Failed to prefetch Claude pricing data, proceeding with empty cache.', error);
    return createPricingDataset(); // 空のデータセット
}
```

```typescript
// Better: ローカルにフォールバック用の静的データを持つ
catch (error) {
    console.warn('Failed to prefetch, using bundled fallback data.', error);
    return BUNDLED_FALLBACK_PRICING; // ビルド前にコミットされた静的データ
}
```

## 導出ルール

- `[MUST]` モノレポで依存バージョンを管理する場合、すべてのバージョン指定を単一の定義ファイル（pnpm catalogs, Renovate config 等）に集約し、個別パッケージからの直接指定を禁止する
  - 根拠: `catalogMode: strict` により catalog 外のバージョン指定がエラーになる設計で、9 パッケージ 70 以上の依存が一元管理されている

- `[MUST]` npm パッケージのビルド設定に publint（パッケージ互換性チェック）を統合し、ビルド時点で exports/types/main の不整合を検出する
  - 根拠: 全 6 アプリの `tsdown.config.ts` で `publint: true` が設定されており、CI の前段階で品質ゲートが機能している

- `[SHOULD]` TypeScript パッケージで開発時の `.ts` 直接実行と publish 時の `.js` 配布を両立するには、`exports` と `publishConfig.exports` の二重定義を使う
  - 根拠: `apps/ccusage/package.json` で `exports: { ".": "./src/index.ts" }` と `publishConfig.exports: { ".": "./dist/index.js" }` が共存し、`bun ./src/index.ts` と `npx ccusage` の両方が動作する

- `[SHOULD]` CLI ツールのバンドルでは完全な minify ではなく DCE（Dead Code Elimination）のみを適用し、エラー時のスタックトレースの可読性を維持する
  - 根拠: 全アプリで `minify: 'dce-only'` が設定されており、バンドルサイズ削減と運用時デバッグのバランスを取っている

- `[SHOULD]` ビルド時に外部データを埋め込む場合、フェッチ失敗時のフォールバックを必ず実装し、オフライン環境でもビルドが成功するようにする
  - 根拠: 3 つの `_macro.ts` すべてで try/catch + 空データ返却のフォールバックが実装されている

- `[SHOULD]` pnpm workspace のセキュリティ設定（`strictDepBuilds`, `blockExoticSubdeps`, `trustPolicy`, `minimumReleaseAge`）を有効にし、ビルドスクリプトの実行を明示的に許可したパッケージのみに限定する
  - 根拠: `pnpm-workspace.yaml:79-89` で 4 パッケージのみにビルドスクリプト実行を許可し、48 時間の新規リリース待機期間を設けている

- `[SHOULD]` in-source testing を採用する場合、ビルド設定で `define: { 'import.meta.vitest': 'undefined' }` を指定してテストコードが本番バンドルに含まれないようにする
  - 根拠: 34 ファイルで `import.meta.vitest` パターンが使われ、全 tsdown 設定でビルド時除去が設定されている

- `[AVOID]` モノレポ内の tsconfig.json に共通設定を重複して記述すること。共通オプションは `tsconfig.base.json` に抽出し `extends` で参照する
  - 根拠: 現状 9 つの tsconfig.json に `strict`, `verbatimModuleSyntax`, `erasableSyntaxOnly` 等が重複しており、設定変更時のメンテナンスコストが高い

## 適用チェックリスト

- [ ] pnpm catalogs（または同等の一元管理）で全依存のバージョンを管理し、`catalogMode: strict` を有効にしているか
- [ ] catalogs のカテゴリ分類が依存の用途（build, runtime, testing, types 等）を反映しているか
- [ ] tsdown/rollup/esbuild 等のビルド設定に publint を統合し、出荷前にパッケージ互換性を自動検証しているか
- [ ] TypeScript パッケージで `exports` と `publishConfig.exports` の二重定義により、開発時 `.ts` 直接実行と publish 時 `.js` 配布を両立しているか
- [ ] CLI ツールのバンドルで `minify: 'dce-only'` 等、スタックトレースの可読性を保つ設定にしているか
- [ ] in-source testing を使う場合、本番ビルドで `import.meta.vitest` が除去される設定になっているか
- [ ] pnpm-workspace.yaml で `strictDepBuilds`, `blockExoticSubdeps`, `trustPolicy`, `minimumReleaseAge` を設定し、ビルドスクリプトの実行をホワイトリスト制にしているか
- [ ] tsconfig.json の共通設定を `extends` で共有し、各パッケージ固有の設定のみをオーバーライドしているか
- [ ] `preinstall` スクリプトで `only-allow` 等によりパッケージマネージャを強制しているか
- [ ] ビルド時のネットワーク依存処理にフォールバックが実装され、オフラインビルドが成功するか
