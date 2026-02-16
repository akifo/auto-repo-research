# 抽象化パターン

> リポジトリ: ryoppippi/ccusage
> 分析日: 2026-02-16

## 概要

ccusage は 6 つの CLI アプリ（ccusage, codex, opencode, amp, pi, mcp）が類似機能を提供する monorepo であり、コード共有と DRY 原則の実践が直接的に設計品質を左右する構造を持つ。共有パッケージ（`@ccusage/internal`, `@ccusage/terminal`）にドメインロジックを集約する一方、各アプリは独自のデータソースとスキーマを持つため「共通化できる範囲」と「アプリ固有のまま残す範囲」の境界判断が明確に現れている。意図的に重複を残す場面と積極的に共通化する場面の使い分けが、monorepo における実用的な抽象化指針として注目に値する。

## 背景にある原則

- **表現層は共通化し、データ変換層はアプリ固有に保つ**: 6 つのアプリが異なるデータソース（JSONL, JSON, thread ファイル）を持つため、データのパースとスキーマ定義はアプリごとに保持し、フォーマット（通貨表示、テーブル描画）とインフラ（ロガー、価格取得）を共有パッケージに集約している。根拠: `@ccusage/terminal/table` は全アプリが import するが、`data-loader.ts` と `_types.ts` は各アプリに個別に存在する。
- **ビルド時マクロで共通ロジックの具体化を遅延させる**: 各アプリはプロバイダー固有のモデルフィルタリングを `_macro.ts` に定義し、`unplugin-macros` でビルド時に実行する。共通の `fetchLiteLLMPricingDataset` を使いつつ、フィルタ条件だけをアプリ側で差し替える。根拠: `apps/ccusage/src/_macro.ts`, `apps/amp/src/_macro.ts`, `apps/codex/src/_macro.ts` がすべて `@ccusage/internal/pricing-fetch-utils` を import しつつ、`isClaudeModel`, `isAmpModel`, `isCodexModel` でフィルタを変えている。
- **ファクトリパターンで設定の差分だけを各アプリに残す**: ロガー、CLI エントリポイント、価格ソースは「共通クラス/関数 + アプリ固有の設定値」のファクトリ構成で、ボイラープレートを最小化している。根拠: 各アプリの `logger.ts` は `createLogger(name)` の 1 行呼び出し、`run.ts` は `cli(args, mainCommand, {...})` のほぼ同一テンプレートになっている。
- **構造的類似を許容し、自動検出で管理する**: `.claude/commands/reduce-similarities.md` で `similarity-ts` による類似コード検出を CI/開発フローに組み込み、「共通化すべきか」の判断を人間が都度行う運用になっている。すべてを事前に共通化するのではなく、進化的に DRY を適用する姿勢。

## 実例と分析

### 共有パッケージの設計

`packages/internal` と `packages/terminal` は monorepo 内の全アプリから参照される共有パッケージで、`package.json` の `exports` フィールドでサブパスエクスポートを定義している。

`@ccusage/internal` は 5 つのエントリポイント（`./pricing`, `./pricing-fetch-utils`, `./logger`, `./format`, `./constants`）を公開し、各アプリは必要なものだけを `devDependencies` として import する。ランタイム依存として bundler に含める設計のため、`dependencies` ではなく `devDependencies` に置く点が特徴的。

`@ccusage/terminal` は `./table` と `./utils` の 2 エントリポイントで、`ResponsiveTable`, `createUsageReportTable`, `formatUsageDataRow`, `formatTotalsRow`, `pushBreakdownRows` など、全アプリ共通の表形式レポート機能を提供する。

### ロガーの抽象化: 1 行ファクトリ

各アプリの `logger.ts` は驚くほど短い。共通パッケージの `createLogger` をアプリ名で呼び出すだけの 1 行ファクトリになっている。

ccusage, codex, opencode, pi の 4 アプリは `package.json` から `name` を読み取って自動命名し、amp だけがハードコードしている（`'@ccusage/amp'`）。この微小な差異すら残すことで、各アプリが独自の logger インスタンスを持つ自由度を維持している。

### 意図的な重複: _types.ts と _consts.ts

各アプリの `_types.ts` はそれぞれ独自のスキーマを持つ。amp と codex は `TokenUsageDelta`, `TokenUsageEvent`, `ModelUsage`, `DailyUsageSummary`, `MonthlyUsageSummary`, `SessionUsageSummary`, `PricingSource` という構造的に酷似した型を定義しているが、フィールドに差異がある。

例えば amp の `TokenUsageDelta` は `cacheCreationInputTokens` + `cacheReadInputTokens` を分離し、codex は `cachedInputTokens` + `reasoningOutputTokens` を持つ。`PricingSource` インターフェースも amp は `cacheCreationCostPerMToken` を含むが codex は含まない。

同様に `MILLION = 1_000_000` は `packages/internal/src/constants.ts`, `apps/amp/src/_consts.ts`, `apps/codex/src/_consts.ts` の 3 箇所で重複定義されている。`@ccusage/internal/constants` に存在するにもかかわらず、アプリ側で再定義している。

### マクロによるビルド時コード生成

`unplugin-macros` を使い、`_macro.ts` の関数をビルド時に実行して結果をインライン化する。各アプリの `_macro.ts` は共通の `fetchLiteLLMPricingDataset` + `filterPricingDataset` を使い、アプリ固有のモデルフィルタだけを差し替える。

### 価格ソースの構成パターン

3 つのバリエーションが存在する:

1. **ccusage**: `PricingFetcher extends LiteLLMPricingFetcher` (継承)
2. **codex/amp**: `CodexPricingSource implements PricingSource, Disposable` (委譲 + インターフェース実装)
3. **opencode**: `calculateCostForEntry(entry, fetcher)` (関数 + 直接利用)

同じ問題を異なるアプローチで解決しており、進化的に設計が洗練されていく過程が見える。

### CLI エントリポイントのテンプレート構造

`run.ts` は全アプリでほぼ同一のテンプレートに従う。gunshi の `cli()` に `args`, `mainCommand`, `subCommands`, `name`, `version`, `description` を渡す構造で、差異は `args[0]` のバイナリ名チェック部分のみ。

## コード例

```typescript
// packages/internal/src/logger.ts:5-17
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
```

```typescript
// apps/amp/src/logger.ts:1-3
import { createLogger } from '@ccusage/internal/logger';

export const logger = createLogger('@ccusage/amp');
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
// apps/codex/src/run.ts:1-32
import process from 'node:process';
import { cli } from 'gunshi';
import { description, name, version } from '../package.json';
import { dailyCommand } from './commands/daily.ts';
import { monthlyCommand } from './commands/monthly.ts';
import { sessionCommand } from './commands/session.ts';

const subCommands = new Map([
	['daily', dailyCommand],
	['monthly', monthlyCommand],
	['session', sessionCommand],
]);

const mainCommand = dailyCommand;

export async function run(): Promise<void> {
	let args = process.argv.slice(2);
	if (args[0] === 'ccusage-codex') {
		args = args.slice(1);
	}

	await cli(args, mainCommand, {
		name,
		version,
		description,
		subCommands,
		renderHeader: null,
	});
}
```

```typescript
// apps/ccusage/src/_pricing-fetcher.ts:1-25
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { Result } from '@praha/byethrow';
import { prefetchClaudePricing } from './_macro.ts' with { type: 'macro' };
import { logger } from './logger.ts';

const CLAUDE_PROVIDER_PREFIXES = [
	'anthropic/',
	'claude-3-5-',
	'claude-3-',
	'claude-',
	'openrouter/openai/',
];

const PREFETCHED_CLAUDE_PRICING = prefetchClaudePricing();

export class PricingFetcher extends LiteLLMPricingFetcher {
	constructor(offline = false) {
		super({
			offline,
			offlineLoader: async () => PREFETCHED_CLAUDE_PRICING,
			logger,
			providerPrefixes: CLAUDE_PROVIDER_PREFIXES,
		});
	}
}
```

## パターンカタログ

- **Template Method** (分類: 振る舞い)
  - 解決する問題: 複数アプリの CLI エントリポイントで共通構造を維持しつつ差分を許容する
  - 適用条件: 同一フレームワーク（gunshi）を使う複数の CLI アプリが存在する場合
  - コード例: `apps/codex/src/run.ts:1-32`, `apps/amp/src/run.ts:1-29`, `apps/opencode/src/run.ts:1-30`
  - 注意点: テンプレートが暗黙的（共有基底クラスではなくコピー＋微調整）であるため、drift リスクがある

- **Strategy** (分類: 振る舞い)
  - 解決する問題: アプリごとに異なるモデル価格取得戦略を差し替える
  - 適用条件: 共通のインターフェース（`PricingSource`）に対し実装を切り替える必要がある場合
  - コード例: `apps/amp/src/_types.ts:78-80`, `apps/codex/src/_types.ts:53-55`, `apps/amp/src/pricing.ts:23`, `apps/codex/src/pricing.ts:24`
  - 注意点: `PricingSource` インターフェースが各アプリに重複定義されている（共有パッケージに移動する余地がある）

- **Factory Method** (分類: 生成)
  - 解決する問題: ロガーインスタンスの生成を共通化し、アプリ名だけを差し替える
  - 適用条件: 同一の構成ロジックに対しパラメータだけが異なるインスタンス生成
  - コード例: `packages/internal/src/logger.ts:5-17`, `apps/ccusage/src/logger.ts:10-17`
  - 注意点: ファクトリが単純すぎる場合、直接コンストラクタ呼び出しと変わらない

## Good Patterns

- **サブパスエクスポートによる最小公開面**: `@ccusage/internal` は `package.json` の `exports` フィールドで `./pricing`, `./logger`, `./format` 等を明示的に公開し、消費側は必要なモジュールだけを import する。パッケージ内部の実装詳細が漏れない。

```json
// packages/internal/package.json:8-13
"exports": {
    "./pricing": "./src/pricing.ts",
    "./pricing-fetch-utils": "./src/pricing-fetch-utils.ts",
    "./logger": "./src/logger.ts",
    "./format": "./src/format.ts",
    "./constants": "./src/constants.ts"
}
```

- **マクロによるビルド時データ取得 + ランタイムフォールバック**: `prefetchClaudePricing()` はビルド時に LiteLLM から価格データを取得してインライン化し、ランタイムの fetch 失敗時にフォールバックとして使う。オフラインでも動作する堅牢性と、オンラインでの最新データ取得を両立。

```typescript
// apps/amp/src/pricing.ts:21-30
const PREFETCHED_AMP_PRICING = prefetchAmpPricing();

export class AmpPricingSource implements PricingSource, Disposable {
    private readonly fetcher: LiteLLMPricingFetcher;
    constructor(options: AmpPricingSourceOptions = {}) {
        this.fetcher = new LiteLLMPricingFetcher({
            offline: options.offline ?? false,
            offlineLoader: async () => PREFETCHED_AMP_PRICING,
            // ...
        });
    }
}
```

- **pnpm catalog による依存バージョン一元管理**: `pnpm-workspace.yaml` の `catalogs` セクションで全パッケージの依存バージョンをカテゴリ別（`build`, `runtime`, `testing`, `lint`）に一元管理。各 `package.json` は `"catalog:runtime"` のような参照を使う。

```yaml
# pnpm-workspace.yaml:8-13
catalogs:
  build:
    tsdown: ^0.16.6
    unplugin-macros: ^0.18.0
  runtime:
    valibot: ^1.1.0
    consola: ^3.4.2
```

- **`using` + `Disposable` でリソースリークを防止**: `LiteLLMPricingFetcher` は `Disposable` を実装し、`using` キーワードでスコープ終了時にキャッシュをクリアする。テストコードでも `using fetcher = ...` で自動クリーンアップ。

```typescript
// packages/internal/src/pricing.ts:89-107
export class LiteLLMPricingFetcher implements Disposable {
    [Symbol.dispose](): void {
        this.clearCache();
    }
}

// apps/amp/src/commands/daily.ts:59
using pricingSource = new AmpPricingSource({ offline: false });
```

## Anti-Patterns / 注意点

- **定数の重複定義**: `MILLION = 1_000_000` が `packages/internal/src/constants.ts`, `apps/amp/src/_consts.ts`, `apps/codex/src/_consts.ts` の 3 箇所に存在する。共有パッケージにあるのに使われていない。

```typescript
// Bad: apps/amp/src/_consts.ts:37
export const MILLION = 1_000_000;

// Better: 共有パッケージから import する
import { MILLION } from '@ccusage/internal/constants';
```

- **構造的に同一のインターフェースが複数アプリに散在**: `PricingSource`, `TokenUsageDelta`, `ModelPricing` はアプリごとに微妙に異なるが構造的に酷似している。共通の基底型を定義し、アプリ固有のフィールドを拡張する方が保守性が高い。

```typescript
// Bad: apps/amp/src/_types.ts:78-80 と apps/codex/src/_types.ts:53-55 が別定義
export type PricingSource = {
    getPricing: (model: string) => Promise<ModelPricing>;
};

// Better: 共有パッケージに基底型を定義し、アプリ側で拡張
// packages/internal/src/types.ts
export type BasePricingSource<T> = {
    getPricing: (model: string) => Promise<T>;
};
```

- **暗黙的テンプレートによる drift リスク**: `run.ts` のテンプレート構造が共有基底関数ではなくコピーで実現されているため、あるアプリに改善を加えても他のアプリに自動伝播しない。

```typescript
// Bad: 各アプリが同一構造を個別に持つ
// apps/codex/src/run.ts, apps/amp/src/run.ts, apps/opencode/src/run.ts

// Better: 共通のファクトリ関数を提供する
// packages/internal/src/cli-runner.ts
export function createCliRunner(config: { name: string; binaryName: string; ... }) {
    return async function run() {
        let args = process.argv.slice(2);
        if (args[0] === config.binaryName) args = args.slice(1);
        await cli(args, config.mainCommand, { ... });
    };
}
```

## 導出ルール

- `[MUST]` monorepo で共有するコードは表現層（フォーマット・UI）とインフラ層（ロガー・設定）に限定し、ドメイン固有のデータ変換・スキーマはアプリ側に保持する
  - 根拠: ccusage の 6 アプリはデータソース（JSONL, JSON, thread ファイル）が異なるため `data-loader.ts` と `_types.ts` をアプリ側に置いているが、`@ccusage/terminal/table` と `@ccusage/internal/logger` は全アプリで共通利用されている

- `[MUST]` 共有パッケージの公開 API は `package.json` の `exports` フィールドで明示的にサブパスエクスポートし、内部実装の漏出を防ぐ
  - 根拠: `@ccusage/internal` は `./pricing`, `./logger` 等 5 つのエントリポイントのみを公開し、消費側の import パスを制約することで内部リファクタリングの自由度を確保している

- `[SHOULD]` 複数アプリで繰り返される構造（CLI エントリポイント、ファクトリ関数）は、テンプレートをコピーするのではなく共通関数として抽出し、設定値のみアプリ側から注入する
  - 根拠: `run.ts` が 4 アプリでほぼ同一であり、バイナリ名チェック部分の差分のみ。共通関数化すれば改善が全アプリに伝播する

- `[SHOULD]` ビルド時マクロ（`unplugin-macros` 等）を使い、共通ロジックの結果をビルド時に具体化し、ランタイムの外部依存を削減する。同時にランタイムフォールバックも備える
  - 根拠: `_macro.ts` でビルド時に価格データを取得・フィルタリングし、オフラインでも動作する設計を実現している

- `[SHOULD]` monorepo の依存バージョンは一元管理ツール（pnpm catalogs, Renovate config 等）で統一し、パッケージ間のバージョン不整合を防ぐ
  - 根拠: `pnpm-workspace.yaml` の `catalogs` + `catalogMode: strict` で全パッケージのバージョンを統一管理している

- `[AVOID]` 共有パッケージに定義済みの定数・型・ユーティリティをアプリ側で再定義する。import 元を統一し、定義の散在を防ぐ
  - 根拠: `MILLION` が `packages/internal/src/constants.ts` に存在するにもかかわらず `apps/amp/src/_consts.ts`, `apps/codex/src/_consts.ts` で再定義されている

- `[AVOID]` 類似構造のインターフェース（`PricingSource`, `TokenUsageDelta` 等）を各アプリに独立定義する。共通の基底型を共有パッケージに置き、アプリ固有の拡張は intersection type で追加する
  - 根拠: amp と codex の `PricingSource` は同一シグネチャだが別ファイルに存在し、変更時に同期漏れのリスクがある

## 適用チェックリスト

- [ ] monorepo 内の各パッケージで重複している型・定数・ユーティリティを洗い出し、共有パッケージへの移動候補をリストアップしたか
- [ ] 共有パッケージの `exports` フィールドで公開範囲を明示的に定義しているか（ワイルドカード `"./*"` ではなく個別パスを指定）
- [ ] ロガー・設定・CLI エントリポイントなどの「構成のみ異なる」ボイラープレートをファクトリ関数化しているか
- [ ] ビルド時に確定可能なデータ（外部 API のスナップショット、静的設定）をマクロやコード生成でインライン化し、ランタイム負荷を削減しているか
- [ ] 依存バージョンの一元管理（catalogs, constraints 等）を設定し、パッケージ間の不整合を CI で検出しているか
- [ ] 類似コード検出ツール（similarity-ts 等）を定期的に実行し、新たに発生した重複を把握しているか
- [ ] 共通化のコストが利益を上回るケース（データソース固有のスキーマ、プロバイダー固有のロジック）を明示的に文書化し、「意図的な重複」として管理しているか
