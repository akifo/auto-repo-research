# practice: branded-domain-primitives

> 出典: [repos/ryoppippi/ccusage](../repos/ryoppippi/ccusage/) からの知見
> カテゴリ: practice

## 概要

Valibot の `brand()` + ファクトリ関数 + `InferOutput` の三点セットで、ドメインプリミティブ（ID、日付、パスなど）を型安全に構築するパターン。同じ `string` 型でも `SessionId` と `ModelName` を型レベルで区別し、引数の取り違えをコンパイル時に検出できる。さらにファクトリ関数を経由させることで、ランタイムでも不正な値の混入を構造的に防ぐ。

## 背景・文脈

ryoppippi/ccusage は複数の AI コーディングツール（Claude Code, Codex, Amp 等）の使用量を集計する CLI ツール群。内部で `ModelName`, `SessionId`, `DailyDate`, `MonthlyDate`, `FilterDate` など 12 種類のドメインプリミティブを扱う。これらはすべて基底型が `string` だが、意味やフォーマットが異なる。例えば `DailyDate`（YYYY-MM-DD）と `WeeklyDate`（YYYY-MM-DD）はフォーマットが同一でも、集約粒度が異なるため別の型として区別する必要がある。

このような状況でプレーンな `string` を使い続けると、関数の引数を取り違えてもコンパイラが検出できず、実行時に初めてバグが顕在化する。ccusage は Valibot のブランド型を全面採用することで、この問題を構造的に解決している。

## 実装パターン

三点セットは以下の順序で定義する:

**1. スキーマ定義** -- `v.pipe()` でバリデーションルールとブランドマーカーを結合する。

```typescript
// apps/ccusage/src/_types.ts:9-13
export const modelNameSchema = v.pipe(
	v.string(),
	v.minLength(1, 'Model name cannot be empty'),
	v.brand('ModelName'),
);
```

**2. 型導出** -- `v.InferOutput` でスキーマから型を導出する。手書きの型定義を排除し、スキーマと型の乖離を構造的に防ぐ。

```typescript
// apps/ccusage/src/_types.ts:91
export type ModelName = v.InferOutput<typeof modelNameSchema>;
```

**3. ファクトリ関数** -- `v.parse` を内部で呼ぶファクトリ関数を提供し、`string` からブランド型への変換を一箇所に集約する。

```typescript
// apps/ccusage/src/_types.ts:109
export const createModelName = (value: string): ModelName => v.parse(modelNameSchema, value);
```

この三点セットにより、ブランド型を取得するには必ずファクトリ関数を経由し、ファクトリ関数は必ずバリデーションを実行する。型安全とランタイム安全が一貫して保証される。

### 日付型の細分化

ccusage では同じ YYYY-MM-DD フォーマットでも用途に応じてブランドを分けている。

```typescript
// apps/ccusage/src/_types.ts:42-65
export const dailyDateSchema = v.pipe(
	v.string(),
	v.regex(yyyymmddRegex, 'Date must be in YYYY-MM-DD format'),
	v.brand('DailyDate'),
);

export const weeklyDateSchema = v.pipe(
	v.string(),
	v.regex(yyyymmddRegex, 'Date must be in YYYY-MM-DD format'),
	v.brand('WeeklyDate'),
);
```

フォーマットが同一でも `DailyDate` と `WeeklyDate` は異なるブランドを持つため、日次集計関数に週次の日付を渡すとコンパイルエラーになる。

### ユニオン型への安全なパース

複数の候補型を持つ場合は `v.safeParse` で順に試す。

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

### 集約データ型へのネスト

ブランド型はオブジェクトスキーマにネストして使える。集約データの型もスキーマから導出する。

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

### 信頼境界での safeParse

外部データ（JSONL ファイル等）はファクトリ関数（`v.parse` -- 例外を throw）ではなく `v.safeParse` で検証し、失敗時はスキップする。

```typescript
// apps/ccusage/src/data-loader.ts:793-800
try {
	const parsed = JSON.parse(line) as unknown;
	const result = v.safeParse(usageDataSchema, parsed);
	if (!result.success) {
		return;
	}
	const data = result.output;
```

## Good Example

三点セットが正しく適用された例。スキーマ、型、ファクトリが対になっている。

```typescript
// apps/ccusage/src/_types.ts:9-13, 91, 109
// 1. スキーマ: バリデーションルール + ブランドマーカー
export const modelNameSchema = v.pipe(
	v.string(),
	v.minLength(1, 'Model name cannot be empty'),
	v.brand('ModelName'),
);

// 2. 型導出: スキーマから自動生成
export type ModelName = v.InferOutput<typeof modelNameSchema>;

// 3. ファクトリ: 検証を経由した唯一の生成経路
export const createModelName = (value: string): ModelName => v.parse(modelNameSchema, value);
```

利用側はファクトリ経由で値を作り、型が引数の取り違えを防ぐ。

```typescript
function processSession(sessionId: SessionId, modelName: ModelName): void { /* ... */ }

// OK: ファクトリ関数を経由
processSession(createSessionId('sess_abc'), createModelName('claude-sonnet-4-20250514'));

// コンパイルエラー: 引数の順序が逆
processSession(createModelName('claude-sonnet-4-20250514'), createSessionId('sess_abc'));
```

## Bad Example

ブランド型を `as` キャストで生成するアンチパターン。ファクトリ関数を迂回するため、バリデーションが実行されない。

```typescript
// Bad: as キャストでブランド型を直接生成（バリデーションをバイパス）
const modelName = '' as v.InferOutput<typeof modelNameSchema>;
// -> 空文字列が ModelName として流通する。minLength(1) のバリデーションが効かない。

// Bad: テストコードでの as キャスト（実際のコードベースに存在する例）
// apps/pi/src/_pi-agent.ts:128
timestamp: '2024-01-01T00:00:00Z' as v.InferOutput<typeof isoTimestampSchema>,
// -> タイムスタンプのバリデーションルールが変更されてもテストが壊れない（= バグを見逃す）
```

```typescript
// Good: テストコードでもファクトリ関数を使う
timestamp: createISOTimestamp('2024-01-01T00:00:00Z'),
// -> バリデーションルールの変更がテストにも波及する
```

もうひとつの Bad Example は、スキーマと型定義を別々に管理するパターン。

```typescript
// Bad: スキーマと型定義が独立しており、乖離するリスクがある
const userIdSchema = v.pipe(v.string(), v.minLength(1), v.brand('UserId'));
type UserId = string & { __brand: 'UserId' };  // 手書きの型定義

// Good: スキーマから型を導出し、単一ソースを維持
const userIdSchema = v.pipe(v.string(), v.minLength(1), v.brand('UserId'));
type UserId = v.InferOutput<typeof userIdSchema>;  // スキーマが唯一の情報源
```

## 適用ガイド

### どのような状況で使うべきか

- **同じ基底型（string, number）のドメイン値が3つ以上存在する場合**: ID、日付、パス、名前など、意味が異なるが型が同じ値が複数あるとき。2つ以下なら引数名での区別で十分なケースも多い。
- **関数の引数に同じ型が2つ以上並ぶ場合**: `search(from: string, to: string)` のような関数は取り違えが起きやすい。`search(from: DailyDate, to: DailyDate)` でも改善だが、`search(from: StartDate, to: EndDate)` まで分けると更に安全。
- **外部データを受け取る信頼境界がある場合**: API レスポンス、ファイル読み込み、ユーザー入力など。`safeParse` でブランド型に変換し、以降は検証済みの値のみが流通する。

### 導入時の注意点

- **`v.parse`（throw）と `v.safeParse`（Result 返却）を使い分ける**: アプリ内部のデータ変換にはファクトリ関数（`v.parse`）、信頼境界の外部データには `v.safeParse` を使う。ccusage はこの使い分けを一貫して実践している。
- **ファクトリ関数なしのブランド型は効果が半減する**: `as` キャストで迂回されると、バリデーションが実行されない。ブランド型を導入するなら必ずファクトリ関数とセットで提供し、プロジェクト規約で `as` キャストを禁止する。
- **過剰な細分化に注意**: すべての string にブランド型を付けると、ファクトリ関数の呼び出しが煩雑になる。取り違えリスクが実際に存在する値に限定して適用する。

### カスタマイズポイント

- **バリデーションルールの強度**: `v.minLength(1)` のような最小限のルールから、`v.regex()` による厳密なフォーマット検証まで、ドメインの要件に応じて調整する。
- **エラーメッセージ**: `v.pipe` の各ステップにカスタムメッセージを渡せる。ユーザー向けエラーか開発者向けエラーかで使い分ける。
- **Zod への適用**: 同じパターンは Zod でも `z.string().brand<'ModelName'>()` + `z.infer` で実現できる。ただし Zod のブランド型はバリデーションルールとの結合が Valibot ほど自然ではない点に留意する。

### 三点セットの最小テンプレート

新しいドメインプリミティブを追加する際のテンプレート:

```typescript
import * as v from 'valibot';

// 1. スキーマ
export const fooIdSchema = v.pipe(
	v.string(),
	v.minLength(1, 'FooId cannot be empty'),
	v.brand('FooId'),
);

// 2. 型導出
export type FooId = v.InferOutput<typeof fooIdSchema>;

// 3. ファクトリ
export const createFooId = (value: string): FooId => v.parse(fooIdSchema, value);
```

## 参考

- [repos/ryoppippi/ccusage/type-system-patterns.md](../repos/ryoppippi/ccusage/type-system-patterns.md) -- 型システム全体の分析（ブランド型、Result 型、exhaustiveness check 等）
- [repos/ryoppippi/ccusage/data-processing-patterns.md](../repos/ryoppippi/ccusage/data-processing-patterns.md) -- データ処理パイプラインにおけるブランド型の活用事例
