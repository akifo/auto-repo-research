# error-handling-idioms

> リポジトリ: ryoppippi/ccusage
> 分析日: 2026-02-16

## 概要

ccusage は `@praha/byethrow` の Result 型を採用し、try-catch に代わる関数型エラーハンドリングをコードベース全体で実践している。JSONL パース・外部 API フェッチ・ファイル I/O・コスト計算といった失敗しうる操作を `Result.try()` でラップし、`Result.pipe()` による合成、`Result.isFailure()` による早期リターン、`Result.unwrap()` によるデフォルト値付き値取り出しの3つのイディオムを軸に統一されたエラーハンドリング戦略を構築している。モノレポ内の6つのアプリで同一パターンが反復適用されており、プラクティスの一貫性と再現性が高い。

## 背景にある原則

- **エラーを値として扱う**: throw/catch の制御フローではなく、成功/失敗を型で表現することで、エラーの伝播経路がコード上で明示的になる。TypeScript の型システムがエラーハンドリングの漏れを静的に検出できる利点がある。
  - 根拠: `packages/internal/src/pricing.ts:339-361` で `calculateCostFromTokens` が `Result.ResultAsync<number, Error>` を返し、呼び出し側がエラーを型として受け取る設計。

- **失敗は早期にスキップし、正常パスを浅く保つ**: `if (Result.isFailure(result)) continue;` パターンにより、ループ内の不正データを即座にスキップし、正常処理のネストを最小化する。
  - 根拠: `apps/codex/src/data-loader.ts:209-216` や `apps/ccusage/src/debug.ts:122-124` で、失敗行をスキップして次のイテレーションに進む統一パターンが使われている。

- **パイプラインで変換とエラーを同時に合成する**: `Result.pipe()` により、値の変換 (`Result.map`)・エラーのログ (`Result.inspectError`)・デフォルト値の提供 (`Result.unwrap`) を一つのフローにまとめる。手続き的な if/else チェーンが不要になる。
  - 根拠: `apps/ccusage/src/commands/statusline.ts:289-301` で、非同期データロード -> コスト抽出 -> エラーログ -> デフォルト値、の4段パイプラインが一つの式として記述されている。

- **try-catch は境界に限定する**: Result 型を採用しつつも、ファイル I/O のストリーム処理やプロセス間通信など、Result に変換するコストが高い箇所では try-catch を許容する。全てを Result にするのではなく、境界を明確にする。
  - 根拠: CLAUDE.md に "Keep traditional try-catch only for: file I/O with complex error handling, legacy code" と明記。`apps/mcp/src/cli-utils.ts:79-101` で SubprocessError のハンドリングに try-catch を使用。

## 実例と分析

### Result.try() による throw 可能な操作のラップ

コードベース全体で JSON パース、ファイル読み込み、外部 API 呼び出しなど throw する可能性のある操作を `Result.try()` でラップしている。同期操作と非同期操作で使い分けがある。

**同期操作** -- `try` に関数を渡す:

```typescript
// apps/ccusage/src/debug.ts:116-119
const parseParser = Result.try({
	try: () => JSON.parse(line) as unknown,
	catch: () => new Error('Invalid JSON'),
});
const parseResult = parseParser();
```

**非同期操作** -- `try` に Promise を渡す:

```typescript
// apps/codex/src/data-loader.ts:204-207
const statResult = await Result.try({
	try: stat(directoryPath),
	catch: (error) => error,
});
```

重要な違いとして、同期の `Result.try()` はファクトリ関数を返す（`parseParser()` で呼び出しが必要）のに対し、非同期では直接 await する、あるいは `()` で即時呼び出しするパターンが混在する。

### Result.isFailure() + continue による早期スキップ

ループ内で不正なデータ行をスキップする統一パターン。JSONL パース失敗・スキーマバリデーション失敗のいずれでも同一のイディオムを使う:

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

このパターンは `apps/ccusage/src/debug.ts:116-124`、`apps/amp/src/data-loader.ts:178-184` でも同一構造で使われており、モノレポ全体で統一されている。

### Result.pipe() による関数合成パイプライン

最も高度な活用は `Result.pipe()` による複数操作の合成。エラーハンドリング・ログ・デフォルト値設定を一つの宣言的な式で表現する:

```typescript
// apps/ccusage/src/_utils.ts:15-23
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

より複雑な例として、statusline コマンドでは4段階のパイプラインが使われている:

```typescript
// apps/ccusage/src/commands/statusline.ts:289-301
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

### Result.unwrap() によるデフォルト値付き値取り出し

Result から値を取り出す際に、失敗時のデフォルト値を指定するパターンが頻出する:

```typescript
// apps/ccusage/src/data-loader.ts:642-645
return Result.unwrap(
	fetcher.calculateCostFromTokens(data.message.usage, data.message.model),
	0,
);
```

```typescript
// apps/opencode/src/cost-utils.ts:41
return Result.unwrap(result, 0);
```

コスト計算ではデフォルト値 `0` が統一的に使われ、「価格情報が取得できない場合は 0 として扱う」というビジネスルールを型安全に表現している。

### Result.succeed() / Result.fail() による明示的な値の生成

条件分岐で成功/失敗を明示的に生成し、パイプラインに合流させる:

```typescript
// packages/internal/src/pricing.ts:146-149
this.cachedPricing != null
	? Result.succeed(this.cachedPricing)
	: Result.fail(new Error('Cached pricing not available')),
```

```typescript
// packages/internal/src/pricing.ts:354-358
Result.andThen((pricing) => {
	if (pricing == null) {
		return Result.fail(new Error(`Model pricing not found for ${modelName}`));
	}
	return Result.succeed(this.calculateCostFromPricing(tokens, pricing));
}),
```

### LiteLLMPricingFetcher に見る高度なパイプライン合成

`packages/internal/src/pricing.ts:145-197` の `ensurePricingLoaded` メソッドは、このコードベースで最も複雑な Result パイプラインの例である。キャッシュ確認 -> オフライン/オンライン分岐 -> フェッチ -> レスポンスバリデーション -> パース -> キャッシュ保存 -> フォールバック、という7段階の処理を一つの式で表現している:

```typescript
// packages/internal/src/pricing.ts:145-197 (構造を簡略化)
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
				Result.try({ try: fetch(this.url), catch: (error) => new Error(...) }),
				Result.andThrough((response) => { /* validate status */ }),
				Result.andThen(async (response) => Result.try({ try: response.json(), ... })),
				Result.map((data) => { /* parse and build Map */ }),
				Result.inspect((pricing) => { this.cachedPricing = pricing; }),
				Result.orElse(async (error) => this.handleFallbackToCachedPricing(error)),
			);
		}),
	);
}
```

### try-catch が残されている箇所

CLAUDE.md のガイドラインに従い、Result に変換するコストが高い箇所では try-catch が残されている:

```typescript
// apps/mcp/src/cli-utils.ts:79-101
export async function executeCliCommand(...): Promise<string> {
	try {
		const result = await spawn(executable, args, { ... });
		// ...
	} catch (error: unknown) {
		if (error instanceof SubprocessError) {
			const message = (error.stderr ?? error.stdout ?? ...).trim();
			throw new Error(message);
		}
		throw error;
	}
}
```

```typescript
// apps/ccusage/src/data-loader.ts:563-590 (getEarliestTimestamp)
export async function getEarliestTimestamp(filePath: string): Promise<Date | null> {
	try {
		// ストリーム処理 + 内部の JSON パースも try-catch
		await processJSONLFileByLine(filePath, (line) => {
			try {
				// ...
			} catch {
				// Skip invalid JSON lines
			}
		});
		return earliestDate;
	} catch (error) {
		logger.debug(`Failed to get earliest timestamp for ${filePath}:`, error);
		return null;
	}
}
```

注目すべきは、MCP サーバー (`apps/mcp/src/ccusage.ts`) では CLI を子プロセスとして呼び出すため、Result 型ではなく try-catch + 空オブジェクト返却のパターンを使っている点。プロセス境界では Result 型の恩恵が薄れるため、pragmatic な判断といえる。

## パターンカタログ

- **Railway Oriented Programming** (分類: 振る舞い / 関数型パターン)
  - 解決する問題: 連鎖する操作のエラーハンドリングにおける分岐の爆発
  - 適用条件: 複数の失敗しうる操作を順次合成する必要がある場面
  - コード例: `packages/internal/src/pricing.ts:145-197` -- `Result.pipe` + `Result.orElse` + `Result.andThen` による「成功レール / 失敗レール」の構築
  - 注意点: パイプラインが深くなるとデバッグ時にスタックトレースが追いにくくなる。`Result.inspectError` を要所に挟むことで可観測性を担保している

- **Null Object Pattern の変形** (分類: 振る舞い)
  - 解決する問題: 失敗時に null/undefined を返すと呼び出し側で null チェックが必要になる
  - 適用条件: 失敗時にデフォルト値で処理を続行できる場面
  - コード例: `apps/ccusage/src/data-loader.ts:642-645` -- `Result.unwrap(..., 0)` でコスト 0 をデフォルト値にする
  - 注意点: デフォルト値が業務的に妥当か慎重に検討が必要（コスト 0 はサイレント失敗を意味する）

## Good Patterns

- **Result.pipe() + Result.inspectError() + Result.unwrap() の三点セット**: 非同期操作のエラーを値に変換し、ログを残しつつデフォルト値で処理を続行する。statusline コマンド (`apps/ccusage/src/commands/statusline.ts:339-358`) で頻出するこのパターンは、UI 層がエラーで止まらないことを保証しながら、デバッグ情報を失わない。

```typescript
// apps/ccusage/src/commands/statusline.ts:339-358
const todayCost = await Result.pipe(
	Result.try({
		try: async () => loadDailyUsageData({ ... }),
		catch: (error) => error,
	})(),
	Result.map((dailyData) => { /* 集計 */ }),
	Result.inspectError((error) => logger.error('Failed to load daily data:', error)),
	Result.unwrap(0),
);
```

- **Result.try() + isFailure() + continue のループスキップイディオム**: JSONL の各行パースでは、不正行をサイレントにスキップし、有効なデータのみを処理する。ネストを最小化し、正常パスの可読性を保つ。

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

- **Result.andThrough() によるバリデーション挿入**: パイプラインの途中にバリデーションを挟み、条件を満たさなければ失敗レールに切り替える。値を消費せず通過させる点が `andThen` との違い。

```typescript
// packages/internal/src/pricing.ts:162-167
Result.andThrough((response) => {
	if (!response.ok) {
		return Result.fail(new Error(`Failed to fetch pricing data: ${response.statusText}`));
	}
	return Result.succeed();
}),
```

## Anti-Patterns / 注意点

- **Result.unwrap() でのサイレント失敗**: `Result.unwrap(0)` は便利だが、エラーが発生してもデフォルト値 `0` で処理が続行されるため、問題に気づきにくい。コスト計算で価格情報が取得できない場合、0 ドルと報告されるリスクがある。

```typescript
// Bad: エラーを無視してデフォルト値で続行
return Result.unwrap(
	fetcher.calculateCostFromTokens(data.message.usage, data.message.model),
	0,
);

// Better: inspectError でログを残してからデフォルト値を使う
return Result.pipe(
	fetcher.calculateCostFromTokens(data.message.usage, data.message.model),
	Result.inspectError((error) => logger.warn('Cost calculation failed:', error)),
	Result.unwrap(0),
);
```

- **同期/非同期の Result.try() 呼び出し規約の混在**: 同期版は `Result.try({...})()` と即時呼び出しが必要だが、非同期版は `await Result.try({...})` と書ける。この不統一がコードの認知負荷を高める。

```typescript
// 同期: ファクトリ関数を即時呼び出し
const result = Result.try({ try: () => JSON.parse(line), catch: ... })();

// 非同期: Promise を直接渡して await
const result = await Result.try({ try: stat(path), catch: ... });

// 非同期でもファクトリ呼び出しが必要なケース (async 関数)
const result = Result.try({ try: async () => { ... }, catch: ... })();
```

## 導出ルール

- `[MUST]` throw する可能性のある操作は Result.try() でラップし、戻り値を Result 型にする。ただしプロセス境界（子プロセス呼び出し、ストリーム I/O）は try-catch を許容する
  - 根拠: ccusage ではJSON パース・ファイル読み込み・API フェッチを一律 Result.try() でラップし、MCP サーバーのプロセス間通信のみ try-catch を使うという境界を明確にしている（`apps/mcp/src/cli-utils.ts:79-101` vs `apps/codex/src/data-loader.ts:204-207`）

- `[MUST]` Result.unwrap() でデフォルト値を使う場合は Result.inspectError() でエラーログを残し、サイレント失敗を防止する
  - 根拠: statusline コマンドでは全ての unwrap の前に inspectError を配置しているが（`statusline.ts:299,357,455`）、data-loader.ts の calculateCostForEntry ではログなしで unwrap(0) している（`data-loader.ts:642-645`）。後者はコストが 0 になる原因の追跡が困難になる

- `[SHOULD]` ループ内で失敗しうるパース処理は `if (Result.isFailure(result)) continue;` の早期スキップパターンを使い、正常パスのネストを浅く保つ
  - 根拠: JSONL パースのループ処理が codex/ccusage/amp の3つの data-loader で同一パターンで実装されており（`apps/codex/src/data-loader.ts:249-257`）、正常パスのインデントが1段浅くなっている

- `[SHOULD]` 複数の失敗しうる操作を連鎖させる場合は Result.pipe() で合成し、エラーの伝播と変換を宣言的に記述する
  - 根拠: `packages/internal/src/pricing.ts:145-197` で7段階の操作チェーンを一つの式として記述し、各段階のエラーハンドリングが明示的になっている

- `[SHOULD]` Result 型を返すメソッドの戻り値型は `Result.ResultAsync<T, Error>` を明示し、呼び出し側がエラー型を認識できるようにする
  - 根拠: `LiteLLMPricingFetcher` の全メソッドが `Result.ResultAsync<T, Error>` を戻り値型に明示しており（`packages/internal/src/pricing.ts:200,215,239,347`）、呼び出し側の型推論を助けている

- `[AVOID]` Result.unwrap() をログなしで使いデフォルト値でエラーを握りつぶすこと。デフォルト値が業務的に妥当かどうかの判断なしに `unwrap(0)` を使うと、計算結果の信頼性が損なわれる
  - 根拠: `apps/ccusage/src/data-loader.ts:642-645` で inspectError なしの `Result.unwrap(..., 0)` が使われており、コスト計算のエラーが検知不可能になっている

## 適用チェックリスト

- [ ] プロジェクトに Result 型ライブラリ（byethrow, neverthrow, oxide.ts 等）を導入し、throw する操作のラップ方針を CLAUDE.md / CONTRIBUTING.md に明記する
- [ ] JSON パース・外部 API 呼び出し・ファイル読み込みなど throw する操作を洗い出し、Result.try() 相当でラップする
- [ ] ループ内の失敗しうる操作に「isFailure -> continue」の早期スキップパターンを適用し、正常パスのネストを1段以下に保つ
- [ ] Result.unwrap() でデフォルト値を使う全箇所に inspectError / ログ出力を追加し、サイレント失敗を防止する
- [ ] Result 型を使わない境界（プロセス間通信、ストリーム処理等）を明確に定義し、チームで合意する
- [ ] Result.pipe() によるパイプライン合成を非同期エラーチェーンに導入し、手続き的な if/else チェーンを置き換える
