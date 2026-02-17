# practice: result-error-pipeline

> 出典: [repos/ryoppippi/ccusage](../repos/ryoppippi/ccusage/) からの知見
> カテゴリ: practice

## 概要

`@praha/byethrow` の Result 型を使い、`Result.try()` / `Result.pipe()` / `Result.unwrap()` の3イディオムと `Result.isFailure()` + `continue` の早期スキップで、関数型エラーハンドリングを統一するプラクティス。try-catch の暗黙的な制御フローを排除し、エラーの伝播経路をコード上で明示的にすることで、TypeScript の型システムによるエラーハンドリング漏れの静的検出を実現する。

## 背景・文脈

ccusage は Claude Code / Codex CLI の使用量を分析する CLI ツール群で、pnpm workspace による monorepo 構成を取る。JSONL パース、外部 API フェッチ、ファイル I/O、コスト計算といった失敗しうる操作がコードベース全体に散在しており、これらを統一的にハンドリングする必要があった。`@praha/byethrow` の Result 型を採用し、モノレポ内の6つのアプリで同一パターンを反復適用することで、エラーハンドリングの一貫性と再現性を確保している。14ファイル・102箇所で Result 型が使用されている。

## 実装パターン

### イディオム 1: Result.try() -- throw を値に変換する

throw する可能性のある操作を `Result.try()` でラップし、例外を Result 型の値に変換する。

```typescript
// apps/ccusage/src/debug.ts:116-119
const parseParser = Result.try({
	try: () => JSON.parse(line) as unknown,
	catch: () => new Error('Invalid JSON'),
});
const parseResult = parseParser();
```

非同期操作では Promise を直接渡す:

```typescript
// apps/codex/src/data-loader.ts:204-207
const statResult = await Result.try({
	try: stat(directoryPath),
	catch: (error) => error,
});
```

### イディオム 2: Result.pipe() -- 変換とエラーを宣言的に合成する

複数の失敗しうる操作を一つのパイプラインにまとめる。各段階で値の変換 (`map`)、エラーのログ (`inspectError`)、デフォルト値の提供 (`unwrap`) を宣言的に記述する。

```typescript
// apps/ccusage/src/_utils.ts:14-23
export async function getFileModifiedTime(filePath: string): Promise<number> {
	return Result.pipe(
		Result.try({
			try: stat(filePath),
			catch: (error) => error,
		}),
		Result.map((stats) => stats.mtime.getTime()),
		Result.unwrap(0),
	);
}
```

### イディオム 3: Result.unwrap() -- デフォルト値で安全に取り出す

Result から値を取り出す際に、失敗時のデフォルト値を指定する。

```typescript
// apps/ccusage/src/data-loader.ts:642-645
return Result.unwrap(
	fetcher.calculateCostFromTokens(data.message.usage, data.message.model),
	0,
);
```

### 早期スキップ: isFailure() + continue

ループ内で不正データをスキップし、正常パスのネストを浅く保つ。

```typescript
// apps/codex/src/data-loader.ts:249-257
const parseLine = Result.try({
	try: () => JSON.parse(trimmed) as unknown,
	catch: (error) => error,
});
const parsedResult = parseLine();

if (Result.isFailure(parsedResult)) {
	continue;
}
```

## Good Example

### inspectError + unwrap の三点セット

非同期操作のエラーを値に変換し、ログを残しつつデフォルト値で処理を続行する。UI 層がエラーで止まらないことを保証しながら、デバッグ情報を失わない。

```typescript
// apps/ccusage/src/commands/statusline.ts:288-301
const getCcusageCost = async (): Promise<number | undefined> => {
	return Result.pipe(
		Result.try({
			try: async () =>
				loadSessionUsageById(sessionId, {
					mode: 'auto',
					offline: mergedOptions.offline,
				}),
			catch: (error) => error,
		})(),
		Result.map((sessionCost) => sessionCost?.totalCost),
		Result.inspectError((error) => logger.error('Failed to load session data:', error)),
		Result.unwrap(undefined),
	);
};
```

```typescript
// apps/ccusage/src/commands/statusline.ts:339-358
const todayCost = await Result.pipe(
	Result.try({
		try: async () =>
			loadDailyUsageData({
				since: todayStr,
				until: todayStr,
				mode: 'auto',
				offline: mergedOptions.offline,
			}),
		catch: (error) => error,
	})(),
	Result.map((dailyData) => {
		if (dailyData.length > 0) {
			const totals = calculateTotals(dailyData);
			return totals.totalCost;
		}
		return 0;
	}),
	Result.inspectError((error) => logger.error('Failed to load daily data:', error)),
	Result.unwrap(0),
);
```

### 7段階パイプラインによる Railway Oriented Programming

キャッシュ確認 -> オフライン/オンライン分岐 -> フェッチ -> レスポンスバリデーション -> パース -> キャッシュ保存 -> フォールバック、を一つの式で表現する。

```typescript
// packages/internal/src/pricing.ts:145-197
private async ensurePricingLoaded(): Result.ResultAsync<Map<string, LiteLLMModelPricing>, Error> {
	return Result.pipe(
		this.cachedPricing != null
			? Result.succeed(this.cachedPricing)
			: Result.fail(new Error('Cached pricing not available')),
		Result.orElse(async () => {
			if (this.offline) {
				return this.loadOfflinePricing();
			}
			return Result.pipe(
				Result.try({
					try: fetch(this.url),
					catch: (error) => new Error('Failed to fetch', { cause: error }),
				}),
				Result.andThrough((response) => {
					if (!response.ok) {
						return Result.fail(new Error(`Failed: ${response.statusText}`));
					}
					return Result.succeed();
				}),
				Result.andThen(async (response) =>
					Result.try({
						try: response.json() as Promise<Record<string, unknown>>,
						catch: (error) => new Error('Failed to parse', { cause: error }),
					}),
				),
				Result.map((data) => { /* parse and build Map */ }),
				Result.inspect((pricing) => { this.cachedPricing = pricing; }),
				Result.orElse(async (error) => this.handleFallbackToCachedPricing(error)),
			);
		}),
	);
}
```

## Bad Example

### unwrap でエラーを握りつぶす

`inspectError` なしの `Result.unwrap(0)` はサイレント失敗を招く。コスト計算で価格情報が取得できない場合、0 ドルと報告されてしまう。

```typescript
// Bad: エラーが発生しても気づけない
return Result.unwrap(
	fetcher.calculateCostFromTokens(data.message.usage, data.message.model),
	0,
);

// Good: inspectError でログを残してからデフォルト値を使う
return Result.pipe(
	fetcher.calculateCostFromTokens(data.message.usage, data.message.model),
	Result.inspectError((error) => logger.warn('Cost calculation failed:', error)),
	Result.unwrap(0),
);
```

### try-catch のネスト地獄

Result 型を使わない場合、失敗しうる操作のチェーンが深くネストする。

```typescript
// Bad: try-catch のネストで正常パスが埋もれる
async function getFileModifiedTime(filePath: string): Promise<number> {
	try {
		const stats = await stat(filePath);
		return stats.mtime.getTime();
	} catch {
		return 0;
	}
}

// Good: Result.pipe で宣言的に記述
async function getFileModifiedTime(filePath: string): Promise<number> {
	return Result.pipe(
		Result.try({ try: stat(filePath), catch: (error) => error }),
		Result.map((stats) => stats.mtime.getTime()),
		Result.unwrap(0),
	);
}
```

上の例は1段階だけなので差は小さいが、操作が3段階以上になると try-catch では分岐が爆発する。`pricing.ts:145-197` の7段階パイプラインを try-catch で書くと、ネストが5段以上になり可読性が大幅に低下する。

### try-catch と Result の使い分け誤り

全てを Result にするのではなく、プロセス境界では try-catch を許容する。

```typescript
// Good: プロセス境界では try-catch が適切
// apps/mcp/src/cli-utils.ts:78-101
export async function executeCliCommand(
	executable: string,
	args: string[],
	env?: Record<string, string>,
): Promise<string> {
	try {
		const result = await spawn(executable, args, { env: { ...process.env, ...env } });
		const output = (result.stdout ?? result.output ?? '').trim();
		if (output === '') {
			throw new Error('CLI command returned empty output');
		}
		return output;
	} catch (error: unknown) {
		if (error instanceof SubprocessError) {
			const message = (error.stderr ?? error.stdout ?? error.output ?? error.message).trim();
			throw new Error(message);
		}
		throw error;
	}
}
```

## 適用ガイド

### どのような状況で使うべきか

- **JSON パース、ファイル I/O、外部 API 呼び出し**など、throw する可能性のある操作が複数連鎖する場面
- **ループ内で不正データをスキップ**する JSONL パースなどのバッチ処理
- **デフォルト値で処理を続行**するが、エラーログは残したい UI 層やコスト計算
- **複数の非同期操作を宣言的に合成**したい場面（キャッシュ -> フェッチ -> パース -> フォールバックなど）

### try-catch との使い分け基準

| 使い分け | Result 型 | try-catch |
|---|---|---|
| JSON パース・API フェッチ | 使う | 使わない |
| ファイル stat / readFile | 使う | 使わない |
| 子プロセス呼び出し | 使わない | 使う |
| ストリーム処理 | 使わない | 使う |
| 境界の判断基準 | エラーを値として伝搬できる | プロセス境界・複雑な例外階層 |

### 導入時の注意点

- **同期/非同期の呼び出し規約の違い**: 同期版 `Result.try()` はファクトリ関数を返すため `()` での即時呼び出しが必要。非同期版は `await` で直接受け取れる。この不統一はチーム内で規約を明文化して対処する
- **inspectError の配置を忘れない**: `Result.unwrap(defaultValue)` を使う全箇所で `Result.inspectError()` を前に挟み、サイレント失敗を防止する
- **パイプラインの深さに注意**: 7段階を超えるパイプラインはデバッグ時にスタックトレースが追いにくくなる。`Result.inspectError` を要所に挟んで可観測性を確保する

### カスタマイズポイント

- Result 型ライブラリは `@praha/byethrow` 以外にも `neverthrow`、`oxide.ts`、`ts-results` など選択肢がある。API の差異はあるが、3イディオムの構造は共通して適用可能
- デフォルト値のポリシー（コスト計算で 0 を返すか、undefined を返すか）はビジネス要件に応じて決定する
- CLAUDE.md や CONTRIBUTING.md に「Result 型を使う境界」と「try-catch を許容する境界」を明記し、チーム全体で一貫性を保つ

## 参考

- [repos/ryoppippi/ccusage/error-handling-idioms.md](../repos/ryoppippi/ccusage/error-handling-idioms.md) -- 元の分析（イディオム詳細・導出ルール）
- [repos/ryoppippi/ccusage/architecture.md](../repos/ryoppippi/ccusage/architecture.md) -- Result 型の全体的な活用とアーキテクチャ
