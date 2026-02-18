# 型システムパターン

> リポジトリ: ryoppippi/ccusage
> 分析日: 2026-02-16

## 概要

ccusage は valibot によるブランド型 + ランタイム検証、@praha/byethrow の Result 型による関数型エラーハンドリング、zod との戦略的共存という3つの型安全パターンを組み合わせて使っている。特筆すべきは、ドメインプリミティブ（日付・ID・モデル名など）をすべてブランド型で表現し、コンパイル時とランタイム両方で不正値の混入を防いでいる点と、try-catch を排して Result パイプラインで非同期処理のエラーフローを宣言的に制御している点である。

## 背景にある原則

- **ドメインプリミティブは string のままにしない**: 同じ string 型でも SessionId と ModelName は異なる意味を持つ。ブランド型で区別することで、引数の取り違えをコンパイル時に検出できる。`_types.ts` の 12 種類のブランド型定義が根拠。
- **検証とファクトリは対にする**: スキーマ定義と `create*` ファクトリ関数をセットで提供し、未検証の string がブランド型として流通する経路を断つ。`v.parse` によるファクトリ関数群（`_types.ts:109-124`）が根拠。
- **エラーは値として扱う**: 例外を throw するのではなく、Result 型でエラーを第一級の値として返す。呼び出し側はパイプラインで変換・フォールバック・ログ出力を宣言的に記述できる。`pricing.ts` の `ensurePricingLoaded` が典型例。
- **外部データは常に検証してから使う**: JSONL ファイルや外部 API レスポンスなど、信頼境界を超えるデータは必ず `v.safeParse` で検証し、失敗時はスキップする。`data-loader.ts:796` のパース処理が根拠。

## 実例と分析

### ブランド型によるドメインプリミティブの型安全化

ccusage のコアアプリ（`apps/ccusage`）では、12 種類のドメインプリミティブをブランド型で定義している。valibot の `v.pipe` + `v.brand` を使い、バリデーションルール（正規表現・最小長）とブランドマーカーをひとつのスキーマに結合する。

```typescript
// apps/ccusage/src/_types.ts:9-13
export const modelNameSchema = v.pipe(
  v.string(),
  v.minLength(1, "Model name cannot be empty"),
  v.brand("ModelName"),
);
```

日付型は特に細かく分類され、DailyDate（YYYY-MM-DD）、MonthlyDate（YYYY-MM）、WeeklyDate（YYYY-MM-DD）、FilterDate（YYYYMMDD）がそれぞれ異なるブランドを持つ。フォーマットが同じ DailyDate と WeeklyDate も別の型として区別している。

```typescript
// apps/ccusage/src/_types.ts:42-65
export const dailyDateSchema = v.pipe(
  v.string(),
  v.regex(yyyymmddRegex, "Date must be in YYYY-MM-DD format"),
  v.brand("DailyDate"),
);

export const weeklyDateSchema = v.pipe(
  v.string(),
  v.regex(yyyymmddRegex, "Date must be in YYYY-MM-DD format"),
  v.brand("WeeklyDate"),
);
```

型は `v.InferOutput<typeof schema>` で導出し、手書きの型定義との乖離を防いでいる。

```typescript
// apps/ccusage/src/_types.ts:91-103
export type ModelName = v.InferOutput<typeof modelNameSchema>;
export type SessionId = v.InferOutput<typeof sessionIdSchema>;
export type DailyDate = v.InferOutput<typeof dailyDateSchema>;
// ...
```

### ファクトリ関数パターン

各ブランド型に対応する `create*` ファクトリ関数を提供し、string からブランド型への変換を一箇所に集約している。

```typescript
// apps/ccusage/src/_types.ts:109-124
export const createModelName = (value: string): ModelName => v.parse(modelNameSchema, value);
export const createSessionId = (value: string): SessionId => v.parse(sessionIdSchema, value);
export const createDailyDate = (value: string): DailyDate => v.parse(dailyDateSchema, value);
```

ユニオン型へのパースでは `v.safeParse` を使い、複数の候補を順に試す。

```typescript
// apps/ccusage/src/_types.ts:126-132
export function createBucket(value: string): Bucket {
  const weeklyResult = v.safeParse(weeklyDateSchema, value);
  if (weeklyResult.success) {
    return weeklyResult.output;
  }
  return createMonthlyDate(value);
}
```

### スキーマからの型導出による一貫性確保

集約データ型（DailyUsage, SessionUsage 等）もすべて valibot スキーマから型を導出している。スキーマはネストしたブランド型を含む。

```typescript
// apps/ccusage/src/data-loader.ts:224-236
export const modelBreakdownSchema = v.object({
  modelName: modelNameSchema,
  inputTokens: v.number(),
  outputTokens: v.number(),
  cacheCreationTokens: v.number(),
  cacheReadTokens: v.number(),
  cost: v.number(),
});
export type ModelBreakdown = v.InferOutput<typeof modelBreakdownSchema>;
```

### Result 型による宣言的エラーハンドリング

byethrow の `Result` をパイプラインスタイルで使い、try-catch を排している。典型パターンは `Result.try` -> `Result.pipe` -> `Result.map/andThen` -> `Result.inspectError` -> `Result.unwrap`。

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

非同期処理チェーンでは `Result.andThen`、`Result.orElse`、`Result.andThrough` を組み合わせて分岐を制御する。

```typescript
// packages/internal/src/pricing.ts:145-198
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
				Result.andThrough((response) => { ... }),
				Result.andThen(async (response) => Result.try({ ... })),
				Result.map((data) => { ... }),
				Result.inspect((pricing) => { this.cachedPricing = pricing; }),
				Result.orElse(async (error) => this.handleFallbackToCachedPricing(error)),
			);
		}),
	);
}
```

`Result.unwrap` にデフォルト値を渡すことで、エラー時のフォールバックを簡潔に表現する。

```typescript
// apps/opencode/src/cost-utils.ts:41
return Result.unwrap(result, 0);
```

### valibot と zod の戦略的共存

コアロジック（`apps/ccusage`, `apps/codex`, `apps/amp`, `apps/opencode`, `apps/pi`, `packages/internal`）では valibot を使い、MCP サーバー（`apps/mcp`）では zod を使っている。MCP SDK が zod を要求するため、境界部分で使い分けている。

```typescript
// apps/mcp/src/codex.ts:56-62 (zod)
export const codexParametersShape = {
  since: z.string().optional(),
  until: z.string().optional(),
  timezone: z.string().optional(),
} as const satisfies Record<string, z.ZodTypeAny>;
```

```typescript
// apps/ccusage/src/_types.ts:9-13 (valibot)
export const modelNameSchema = v.pipe(
  v.string(),
  v.minLength(1, "Model name cannot be empty"),
  v.brand("ModelName"),
);
```

### `as const satisfies` による型安全な定数定義

定数配列からユニオン型を導出するパターンと、`as const satisfies` でリテラル型を保持しながら型制約を課すパターンが全体で使われている。

```typescript
// apps/ccusage/src/_types.ts:140-145
export const CostModes = ["auto", "calculate", "display"] as const;
export type CostMode = TupleToUnion<typeof CostModes>;
```

```typescript
// apps/ccusage/src/_shared-args.ts:43
default: 'auto' as const satisfies CostMode,
```

### unreachable 関数による網羅性チェック

`never` 型を利用した exhaustiveness check で、switch/if 文の分岐漏れをコンパイル時に検出する。

```typescript
// apps/ccusage/src/_utils.ts:5-7
export function unreachable(value: never): never {
  throw new Error(`Unreachable code reached with value: ${value as any}`);
}
```

```typescript
// apps/ccusage/src/data-loader.ts:634-666
if (mode === 'display') { return data.costUSD ?? 0; }
if (mode === 'calculate') { ... }
if (mode === 'auto') { ... }
unreachable(mode);  // CostMode の分岐が漏れていればコンパイルエラー
```

### safeParse による外部データの防御的検証

外部データ（JSONL、API レスポンス）はすべて `v.safeParse` で検証し、失敗時は例外を投げずスキップする。

```typescript
// apps/ccusage/src/data-loader.ts:794-801
const parsed = JSON.parse(line) as unknown;
const result = v.safeParse(usageDataSchema, parsed);
if (!result.success) {
  return; // 不正な行を静かにスキップ
}
const data = result.output;
```

同じパターンが codex（`apps/codex/src/data-loader.ts:119-128`）、amp（`apps/amp/src/data-loader.ts:188`）、pi（`apps/pi/src/data-loader.ts:173`）でも繰り返されている。

## パターンカタログ

- **Branded Type Pattern** (分類: 型安全)
  - 解決する問題: 同じプリミティブ型（string）の値を取り違える
  - 適用条件: ドメイン固有の識別子・日付・パスなど、形式が異なるが基底型が同じ値が複数存在する場合
  - コード例: `apps/ccusage/src/_types.ts:9-86`
  - 注意点: ファクトリ関数を提供しないと `as` キャストで回避される危険がある

- **Factory Function + Validation** (分類: 生成)
  - 解決する問題: 未検証の値がブランド型として流通する
  - 適用条件: ブランド型を使う場合に必ずセットで提供
  - コード例: `apps/ccusage/src/_types.ts:109-124`
  - 注意点: `v.parse` は throw する。信頼境界では `v.safeParse` を使い分ける

- **Result Pipeline Pattern** (分類: 振る舞い / Railway Oriented Programming)
  - 解決する問題: try-catch のネストによる可読性低下、エラーフローの暗黙性
  - 適用条件: 複数の失敗可能な操作を連鎖させる非同期処理
  - コード例: `packages/internal/src/pricing.ts:145-198`
  - 注意点: 単純な処理に適用すると冗長になる。1-2 ステップなら try-catch の方が簡潔

## Good Patterns

- **スキーマ定義と型定義の同一ソース化**: valibot スキーマから `v.InferOutput` で型を導出し、スキーマと型定義の二重管理を排除している。スキーマを変更すれば型も自動的に追従する。
  ```typescript
  // apps/ccusage/src/data-loader.ts:219
  export type UsageData = v.InferOutput<typeof usageDataSchema>;
  ```

- **Result.unwrap にデフォルト値を渡すフォールバック**: エラー時に例外を投げずデフォルト値を返す簡潔なパターン。特にファイル存在確認や価格計算など、失敗が許容される場面で有効。
  ```typescript
  // apps/ccusage/src/_utils.ts:21
  Result.unwrap(0), // Default to 0 if file doesn't exist
  ```

- **`as const satisfies` による定数のリテラル型保持 + 型制約**: リテラル型を維持しながら型の整合性を保証する。CLI 引数定義で特に威力を発揮している。
  ```typescript
  // apps/ccusage/src/_shared-args.ts:43
  default: 'auto' as const satisfies CostMode,
  ```

- **safeParse + 早期 return による防御的データ処理**: 不正データを例外なしでスキップし、処理全体を止めない。大量データのストリーム処理に適している。
  ```typescript
  // apps/ccusage/src/data-loader.ts:796-799
  const result = v.safeParse(usageDataSchema, parsed);
  if (!result.success) return;
  ```

## Anti-Patterns / 注意点

- **ブランド型の `as` キャストによる検証バイパス**: テストコード内で `as v.InferOutput<typeof isoTimestampSchema>` のようにキャストしてブランド型を作成している箇所がある。テストの利便性のためだが、ファクトリ関数を使うべき。
  ```typescript
  // Bad: apps/pi/src/_pi-agent.ts:128
  timestamp: '2024-01-01T00:00:00Z' as v.InferOutput<typeof isoTimestampSchema>,

  // Better:
  timestamp: createISOTimestamp('2024-01-01T00:00:00Z'),
  ```

- **検証ライブラリの混在による認知負荷**: valibot と zod が共存しているため、開発者はどちらを使うべきか判断する必要がある。ccusage では MCP 境界で zod を使うルールが暗黙的に存在するが、明文化しないとルールが崩れやすい。
  ```typescript
  // apps/mcp/src/codex.ts:2 — zod
  import { z } from "zod";
  // apps/ccusage/src/_types.ts:2 — valibot
  import * as v from "valibot";
  ```

## 導出ルール

- `[MUST]` 外部データ（ファイル・API レスポンス・ユーザー入力）は信頼境界で safeParse し、失敗時は例外ではなくスキップまたは Result で伝播する
  - 根拠: ccusage は JSONL パース時に `v.safeParse` + 早期 return で不正行をスキップし、数千行のファイル処理を1行の不正データで止めない（`data-loader.ts:796-799`）

- `[MUST]` ドメインプリミティブ（ID・日付・パスなど）にブランド型を使う場合、対応するファクトリ関数を必ず提供し、`as` キャストによるバイパスを防ぐ
  - 根拠: ccusage は 12 種のブランド型すべてに `create*` ファクトリを提供し、検証なしのブランド型生成を構造的に排除している（`_types.ts:109-124`）

- `[SHOULD]` スキーマ検証ライブラリの型導出（`z.infer` / `v.InferOutput`）を使い、スキーマと型定義を単一ソースから生成する
  - 根拠: ccusage は UsageData, ModelBreakdown, DailyUsage 等すべての集約型を `v.InferOutput<typeof schema>` で導出し、スキーマと型の乖離を構造的に防いでいる（`data-loader.ts:219,236,256`）

- `[SHOULD]` 複数の失敗可能な非同期操作を連鎖させる場合は Result パイプラインを使い、エラーフローを宣言的に記述する
  - 根拠: pricing.ts の `ensurePricingLoaded` は キャッシュ確認 -> fetch -> パース -> フォールバック を Result.pipe で一本のパイプラインにまとめ、各段階のエラーハンドリングを明示的に記述している（`pricing.ts:145-198`）

- `[SHOULD]` union 型の分岐には exhaustiveness check（`unreachable(value: never)`）を配置し、分岐の追加漏れをコンパイル時に検出する
  - 根拠: CostMode の3分岐を if 文で処理した後に `unreachable(mode)` を置くことで、新しいモードが追加された際にコンパイルエラーで気付ける（`data-loader.ts:666`）

- `[SHOULD]` 同一プロジェクト内でスキーマ検証ライブラリが複数必要な場合は、利用境界を明文化する（例: コアロジックは valibot、外部 SDK 連携は zod）
  - 根拠: ccusage は MCP SDK が zod を要求する `apps/mcp` でのみ zod を使い、他の 5 アプリ + 共有パッケージはすべて valibot に統一している

- `[AVOID]` テストコードであってもブランド型を `as` キャストで生成する。ファクトリ関数を経由させることで、テストデータの検証ロジック変更時にテストも壊れるようにする
  - 根拠: `_pi-agent.ts:128` で `as v.InferOutput<...>` キャストが使われており、タイムスタンプ形式の検証ルール変更がテストに反映されないリスクがある

## 適用チェックリスト

- [ ] プロジェクト内の string 型プリミティブ（ID、日付、パスなど）を洗い出し、取り違えリスクのあるものにブランド型を導入する
- [ ] ブランド型を導入する場合、スキーマ + 型導出 + ファクトリ関数の3点セットで提供する
- [ ] 外部データの入口（API レスポンス、ファイル読み込み、ユーザー入力）で safeParse を使い、失敗時の挙動（スキップ / フォールバック / エラー伝播）を明示的に決定する
- [ ] 3 ステップ以上の失敗可能な非同期処理チェーンがある場合、Result パイプラインへのリファクタリングを検討する
- [ ] union 型を使った分岐処理に unreachable 関数を配置し、exhaustiveness check を有効にする
- [ ] `as const satisfies` を使って定数配列・オブジェクトのリテラル型を保持しつつ型制約を課す
- [ ] 検証ライブラリが複数存在する場合、どの境界でどのライブラリを使うかを CLAUDE.md 等に明文化する
