# 開発規約 (Dev Conventions)

> リポジトリ: ryoppippi/ccusage
> 分析日: 2026-02-16

## 概要

ccusage は TypeScript モノレポ（pnpm workspace）で構築された CLI ツール群であり、命名規約・import 規約・commit 規約・lint/format 設定・エクスポート制御が体系的に統一されている。特に注目すべきは、(1) アンダースコアプレフィックスによるファイルレベルの可視性制御、(2) `verbatimModuleSyntax` + `.ts` 拡張子 import による型安全な ESM 運用、(3) ESLint 一本化フォーマット + oxfmt の二段構成によるコードスタイル統一、(4) pnpm catalog による依存バージョンの中央管理とサプライチェーンセキュリティ設定の組み合わせである。

## 背景にある原則

- **ファイルシステムが API 境界を表現すべき**: 内部ファイルに `_` プレフィックスを付け、tsdown のビルド設定で `!./src/_*.ts` として除外する。ファイル名の命名規則がそのまま公開 API の境界定義になっており、`package.json` の `exports` フィールドと合わせて二重のアクセス制御を実現している。（`apps/ccusage/tsdown.config.ts:8`, `apps/ccusage/package.json:19-25`）

- **フォーマッタとリンタの関心を分離すべき**: ESLint を `stylistic: false` で運用し、コードフォーマットは oxfmt に委譲している。ESLint は論理的なルール（no-console、型安全性）に集中し、インデント・クォート等の表層的なスタイルは専用フォーマッタに任せる。これにより ESLint の設定が肥大化せず、フォーマット速度も向上する。（`eslint.config.js:3-6`, `package.json:15-16`）

- **バンドルされるアプリの依存は devDependencies に統一すべき**: `apps/` 配下のパッケージはすべて tsdown でバンドルされるため、ランタイム依存を `dependencies` に置く必要がない。全依存を `devDependencies` に集約することで、publish 時のパッケージサイズを最小化し、バンドラが依存の最適化を完全に制御できる。（`CLAUDE.md:19`, `apps/ccusage/package.json:69-105`）

- **型の import と値の import を構文レベルで強制分離すべき**: 全パッケージで `verbatimModuleSyntax: true` を有効化し、`import type` と `import` を明示的に分離する。これによりバンドラの tree-shaking が正確に動作し、型のみの import がランタイムコードに残留するバグを防止する。（`apps/ccusage/tsconfig.json:25`, 全 tsconfig.json で統一）

## 実例と分析

### アンダースコアプレフィックスによるモジュール可視性制御

`apps/ccusage/src/` では、20 ファイル中 14 ファイルが `_` プレフィックス付きの内部ファイルである。公開ファイルは `index.ts`, `calculate-cost.ts`, `data-loader.ts`, `debug.ts`, `logger.ts` と `commands/` ディレクトリのみ。この規約は tsdown のビルド設定と連動している。

```
entry: [
    './src/*.ts',
    '!./src/**/*.test.ts',
    '!./src/_*.ts',         // 内部ファイルを除外
],
```

`package.json` の `exports` フィールドでも公開モジュールを明示的に定義しており、ファイル名規約とビルド設定と exports の三層で API 境界を制御している。

### 命名規約の一貫性

変数・型・定数・ファイルの各レベルで命名規約が分離されている。

| 対象 | 規約 | 例 |
|------|------|-----|
| 変数 | camelCase | `usageDataSchema`, `modelBreakdownSchema` |
| 型 | PascalCase | `UsageData`, `ModelBreakdown`, `TokenCounts` |
| 定数 | UPPER_SNAKE_CASE | `DEFAULT_CLAUDE_CODE_PATH`, `BLOCKS_WARNING_THRESHOLD` |
| 内部ファイル | `_` プレフィックス | `_types.ts`, `_utils.ts`, `_consts.ts` |
| 公開ファイル | プレフィックスなし | `data-loader.ts`, `calculate-cost.ts` |

### pnpm catalog によるバージョン中央管理

`pnpm-workspace.yaml` で `catalogMode: strict` を設定し、全パッケージの依存バージョンを catalog で一元管理している。カテゴリ別（`build:`, `lint:`, `runtime:`, `testing:`, `types:`, `release:`, `docs:`, `llm-docs:`）に整理されており、各 `package.json` では `"catalog:runtime"` のようなラベルで参照する。

さらにサプライチェーンセキュリティ設定として、`strictDepBuilds: true`、`blockExoticSubdeps: true`、`trustPolicy: no-downgrade` を組み合わせている。

### ESLint の階層的設定

ルートの ESLint 設定ではサブディレクトリを ignore し、各パッケージが独自の eslint.config.js を持つ。`type` パラメータで `'lib'`（ライブラリ）と `'app'`（アプリケーション）を区別し、パッケージの性質に応じたルールを適用している。

### console.log 禁止と構造化ログ

`no-console` ルールが ESLint で有効化されており、`console.log` を使う箇所には `eslint-disable-next-line no-console` を明示する必要がある。代替として `consola` ベースの構造化ロガーを提供し、パッケージ名タグ付き・ログレベル制御可能なロガーインスタンスを使用する。

### Conventional Commits + scope ルール

モノレポの scope 規約が特に体系的に定義されている。scope はディレクトリ構造と直接対応しており、`apps/ccusage` → `(ccusage)`、`packages/terminal` → `(terminal)`、`docs` → `(docs)` というマッピングルールが明文化されている。

## コード例

```typescript
// apps/ccusage/tsdown.config.ts:4-9
// アンダースコアプレフィックスファイルをビルド出力から除外
export default defineConfig({
	entry: [
		'./src/*.ts',
		'!./src/**/*.test.ts',
		'!./src/_*.ts',
	],
```

```typescript
// apps/ccusage/src/_consts.ts:44
// 外部に公開しない定数は export なし（XDG_CONFIG_DIR）
const XDG_CONFIG_DIR = xdgConfig ?? `${USER_HOME_DIR}/.config`;
```

```typescript
// apps/ccusage/src/data-loader.ts:11-13
// verbatimModuleSyntax による import type と import の明示的分離
import type { WeekDay } from './_consts.ts';
import type { LoadedUsageEntry, SessionBlock } from './_session-blocks.ts';
import type { ActivityDate, Bucket, CostMode, ModelName, SortOrder, Version } from './_types.ts';
```

```typescript
// apps/ccusage/src/commands/daily.ts:1-22
// import type はファイル先頭にグループ化、.ts 拡張子付き
import type { UsageReportConfig } from '@ccusage/terminal/table';
import process from 'node:process';
import {
	addEmptySeparatorRow,
	createUsageReportTable,
	formatTotalsRow,
	formatUsageDataRow,
	pushBreakdownRows,
} from '@ccusage/terminal/table';
import { Result } from '@praha/byethrow';
import { define } from 'gunshi';
import pc from 'picocolors';
import { loadConfig, mergeConfigWithArgs } from '../_config-loader-tokens.ts';
```

```typescript
// packages/internal/src/logger.ts:5-20
// console.log の代替としての構造化ロガー
export function createLogger(name: string): ConsolaInstance {
	const logger: ConsolaInstance = consola.withTag(name);
	if (process.env.LOG_LEVEL != null) {
		const level = Number.parseInt(process.env.LOG_LEVEL, 10);
		if (!Number.isNaN(level)) {
			logger.level = level;
		}
	}
	return logger;
}
// eslint-disable-next-line no-console
export const log = console.log;
```

```typescript
// apps/ccusage/src/_utils.ts:25-76
// in-source testing パターン: テストがソースと同一ファイルに存在
if (import.meta.vitest != null) {
	describe('unreachable', () => {
		it('should throw an error when called', () => {
			expect(() => unreachable('test' as never)).toThrow(
				'Unreachable code reached with value: test',
			);
		});
	});
}
```

```yaml
# pnpm-workspace.yaml:6,77-82
# catalog strict mode + セキュリティ設定
catalogMode: strict
strictDepBuilds: true
blockExoticSubdeps: true
trustPolicy: no-downgrade
```

## Good Patterns

- **ファイル名プレフィックスで可視性を表現する**: `_` プレフィックスのファイルはパッケージ内部でのみ使用される。ビルド設定（tsdown の entry 除外）・パッケージ定義（exports フィールド）と三重に連動しており、IDE のファイルツリーでも視覚的に公開/非公開が判別できる。TypeScript の `internal` キーワードがない現状で、ファイルシステムの命名規約がその代替として機能している。

```typescript
// apps/ccusage/tsdown.config.ts:8
'!./src/_*.ts', // Exclude internal files with underscore prefix
```

- **`as const satisfies` で型安全なリテラル定義**: 定数配列やオブジェクトリテラルに `as const satisfies Type` を適用し、リテラル型の推論を保ちつつ型チェックも行う。これにより、`CostModes` から `CostMode` 型を導出する等、single source of truth を実現している。

```typescript
// apps/ccusage/src/_types.ts:140-145
export const CostModes = ['auto', 'calculate', 'display'] as const;
export type CostMode = TupleToUnion<typeof CostModes>;
```

- **Valibot ブランド型でドメインプリミティブを強制**: `v.brand()` で `ModelName`, `SessionId`, `DailyDate` 等のブランド型を定義し、素の `string` との混同を型レベルで防止する。ファクトリ関数（`createModelName`, `createSessionId`）でバリデーション付き生成を強制する。

```typescript
// apps/ccusage/src/_types.ts:9-13
export const modelNameSchema = v.pipe(
	v.string(),
	v.minLength(1, 'Model name cannot be empty'),
	v.brand('ModelName'),
);
```

- **in-source testing でテストとソースの距離をゼロにする**: `if (import.meta.vitest != null)` ブロックでテストをソースファイル内に配置し、ビルド時には `define: { 'import.meta.vitest': 'undefined' }` で完全に除去する。テストファイルの管理コストがなく、プライベート関数のテストも自然に書ける。

```typescript
// apps/ccusage/vitest.config.ts:6-8
test: {
	watch: false,
	includeSource: ['src/**/*.{js,ts}'],
	globals: true,
},
```

## Anti-Patterns / 注意点

- **eslint-disable の蓄積**: `apps/opencode` 等のパッケージでは `// eslint-disable-next-line no-console` が大量に存在する（session.ts, daily.ts, monthly.ts, weekly.ts の各ファイルで 5-6 箇所）。主パッケージの ccusage では logger.ts を通じた構造化ログに統一されているが、後発パッケージで規約が徹底されていない。

```typescript
// Bad: 同じファイルで何度も eslint-disable が出現する
// eslint-disable-next-line no-console
console.log(table.toString());
// ...
// eslint-disable-next-line no-console
console.log(JSON.stringify(jsonOutput, null, 2));
```

```typescript
// Better: ロガーモジュールを利用する
import { log } from '../logger.ts';
log(table.toString());
log(JSON.stringify(jsonOutput, null, 2));
```

- **`_macro.ts` の `console.warn` 使用**: マクロファイル内でエラー処理に `console.warn` が直接使われており、ロガーモジュールを通していない。マクロのビルド時実行という制約が理由と推測されるが、注意が必要。

```typescript
// apps/ccusage/src/_macro.ts:22
console.warn('Failed to prefetch Claude pricing data, proceeding with empty cache.', error);
```

## 導出ルール

- `[MUST]` モノレポの commit scope はディレクトリ構造と 1:1 で対応させる（`apps/foo` → `(foo)`, `packages/bar` → `(bar)`）
  - 根拠: ccusage では scope がディレクトリ名と完全一致しており、commit 履歴からどのパッケージが変更されたかを機械的に追跡できる（`CLAUDE.md:145-167`）

- `[MUST]` `verbatimModuleSyntax` を有効にし、`import type` と `import` を構文レベルで分離する
  - 根拠: 全 8 パッケージの tsconfig.json で統一的に `verbatimModuleSyntax: true` が設定されており、tree-shaking の正確性とバンドルサイズの最適化に寄与している

- `[MUST]` ESLint で `no-console` ルールを有効にし、ログ出力は構造化ロガー経由に統一する
  - 根拠: `packages/internal/src/logger.ts` で consola ベースのタグ付きロガーを提供し、LOG_LEVEL 環境変数でランタイム制御を可能にしている。直接の console.log はビルド時に検出される

- `[SHOULD]` ファイル名プレフィックス（`_`）でパッケージ内部モジュールを表現し、ビルド設定と exports フィールドの両方で公開境界を強制する
  - 根拠: ccusage では 14/20 ファイルが `_` プレフィックス付きで、tsdown の entry 除外と package.json exports の両方で非公開を保証している（`apps/ccusage/tsdown.config.ts:8`）

- `[SHOULD]` モノレポの依存バージョンは pnpm catalog（strict mode）で一元管理し、カテゴリラベル（`build:`, `runtime:`, `testing:` 等）で論理的にグループ化する
  - 根拠: `pnpm-workspace.yaml` で `catalogMode: strict` が設定され、8 カテゴリで依存を管理。個別パッケージでのバージョン指定のずれを構造的に防止している

- `[SHOULD]` バンドルされるアプリケーションの全依存を `devDependencies` に配置し、`dependencies` を空にする
  - 根拠: `apps/ccusage/package.json` では全ランタイム依存が `devDependencies` に置かれており、バンドラが依存の最適化を完全制御する設計（`CLAUDE.md:19`）

- `[SHOULD]` `as const satisfies Type` パターンでリテラル定数を定義し、値の配列から union 型を自動導出する（single source of truth）
  - 根拠: `CostModes`, `SortOrders`, `WEEK_DAYS` 等、定数配列からの型導出が一貫して適用されている（`apps/ccusage/src/_types.ts:140-155`）

- `[AVOID]` 同一ファイル内での `eslint-disable-next-line` の繰り返し使用。3 回以上同じルールを disable する場合は、モジュール設計を見直してルール適用の構造的な解決を検討する
  - 根拠: `apps/opencode/src/commands/` 配下では `no-console` の disable が各ファイル 5-6 箇所出現し、logger モジュール未適用の兆候を示している

- `[AVOID]` リンタにフォーマッティングルールを混在させる。フォーマットは専用ツール（oxfmt, Prettier, dprint 等）に委譲し、ESLint は `stylistic: false` で論理ルールに集中させる
  - 根拠: 全 eslint.config.js で `stylistic: false` が設定され、フォーマットは oxfmt に分離されている（`eslint.config.js:5`, `package.json:15-16`）

## 適用チェックリスト

- [ ] ファイル命名規約を定義し、内部モジュールの識別方法（`_` プレフィックス等）をチームで合意する
- [ ] ビルド設定（tsdown/tsup/rollup 等）で内部ファイルをエントリから除外し、`package.json` の `exports` と二重にアクセス制御する
- [ ] tsconfig.json で `verbatimModuleSyntax: true` を有効にし、`import type` の使用を強制する
- [ ] ESLint の `stylistic` ルールを無効化し、フォーマットを専用ツールに委譲する
- [ ] `no-console` ルールを有効にし、構造化ロガーモジュールを提供する
- [ ] モノレポの場合、commit scope とディレクトリ構造の対応表を CONTRIBUTING.md または CLAUDE.md に明文化する
- [ ] pnpm catalog（または同等の依存一元管理）を導入し、`catalogMode: strict` でバージョンの個別指定を禁止する
- [ ] バンドルされるアプリの依存を `devDependencies` に統一し、`dependencies` を空にする
- [ ] 定数配列からの型導出パターン（`as const` + `TupleToUnion` / `typeof arr[number]`）を採用し、値と型の二重定義を排除する
- [ ] pre-commit フック（lint-staged）でフォーマットを自動実行し、CI でのスタイル差分を防止する
