# データ処理パターン

> リポジトリ: ryoppippi/ccusage
> 分析日: 2026-02-16

## 概要

ccusage は複数の AI コーディングツール（Claude Code, Codex, Amp, OpenCode 等）の使用量データを JSONL/JSON ファイルから読み込み、バリデーション・重複排除・時系列集約・コスト計算という多段パイプラインで処理する CLI ツール群である。本分析では、JSONL 行単位ストリーミング解析、Valibot Branded Types による型安全なドメインモデリング、`groupBy` + `reduce` による多段集約、外部価格データとのフォールバック付き統合、および `import.meta.vitest` によるコロケーションテストの5つのデータ処理パターンに注目する。中規模ながら堅牢なデータパイプライン設計の実例として価値がある。

## 背景にある原則

- **Fail-Safe over Fail-Fast（部分的成功を優先）**: JSONL の各行は独立しており、1行の不正データがパイプライン全体を止めてはならない。`v.safeParse` で検証失敗は黙殺し、ファイルアクセスエラーも `.catch(() => [])` で吸収する設計。コスト計算でも `Result.unwrap(value, 0)` でフォールバック値を提供する（`data-loader.ts:797-801`, `_pricing-fetcher.ts:29-49`）

- **Branded Types で計算の一貫性を強制する**: `DailyDate`, `ModelName`, `SessionId` 等を Valibot の `brand()` で区別し、異なるドメインの文字列が混在しないようにする。生成関数（`createDailyDate`, `createModelName` 等）を経由しないとブランド型を取得できないため、暗黙の型変換によるバグを構造的に防ぐ（`_types.ts:9-132`）

- **集約は「下位粒度の結果を上位粒度でまとめる」階層パターンで行う**: 日次データは JSONL 行レベルから直接構築し、週次・月次データは日次データを入力として再集約する。コスト計算も行レベルで確定させてから集約する。この階層設計により、各レベルの集約ロジックが独立してテスト可能になる（`data-loader.ts:1081-1091, 1167-1244`）

- **外部依存はキャッシュ + オフラインフォールバックで保護する**: LiteLLM の価格データベースはネットワーク取得を試み、失敗時はビルド時にプリフェッチしたデータにフォールバックする。`Disposable` プロトコルでキャッシュのライフサイクルを管理する（`pricing.ts:89-107, 126-143`）

## 実例と分析

### JSONL ストリーミング解析とサイレントスキップ

ccusage はファイル全体をメモリに読み込まず、`createReadStream` + `readline` インタフェースで1行ずつ処理する。各行は独立した JSON として `JSON.parse` → `v.safeParse(usageDataSchema, parsed)` のパイプラインを通る。パース失敗・バリデーション失敗は catch ブロックまたは early return で黙殺され、処理は次の行に進む。

この設計は、JSONL が追記ログであり途中で壊れる可能性がある（プロセスの異常終了、書き込み途中のクラッシュ等）という現実を反映している。全行の完全性を前提にしない設計がデータパイプラインの堅牢性を支えている。

### 重複排除（Hash-Based Deduplication）

同じ JSONL エントリが複数のファイルパスから読み込まれるケースに対応するため、`messageId:requestId` の結合文字列をハッシュとして `Set<string>` で管理する。ハッシュが null（ID が存在しないレガシーデータ）の場合は重複チェックをスキップし、すべて受け入れる。

### 多段集約パイプライン

日次集約の流れは: (1) ファイルを glob で収集 → (2) タイムスタンプ順にソート → (3) 各行をストリーム解析・バリデーション → (4) 重複排除 → (5) コスト計算 → (6) `groupBy` でグルーピング → (7) グループごとに `reduce` で集約 → (8) 日付範囲フィルタ → (9) ソート。

月次・週次は日次データを入力として受け取り、`loadBucketUsageData` という汎用関数でグルーピング関数を差し替える形で実装されている。このプラグイン的なバケット戦略により、新しい集約単位（四半期等）の追加が容易になっている。

### プロジェクト横断のグルーピングキー設計

日次データのグルーピングで、プロジェクト別集計が不要な場合は `date` のみ、必要な場合は `date\x00project` を複合キーとして使う。NUL 文字（`\x00`）をセパレータに使うことで、日付やプロジェクト名に含まれうる通常の文字との衝突を回避している。このパターンは月次・週次でも同様に適用される。

### コスト計算の3モード戦略

`CostMode` として `auto`・`calculate`・`display` の3モードを提供する。`auto` は JSONL に埋め込まれたコスト値を優先し、欠落時のみトークン数から計算する。`calculate` は常にトークン数ベースで再計算する。`display` は埋め込み値のみ使い、欠落時は 0 を返す。この設計により、ユーザーがコスト計算のトレードオフを選択できる。

### 段階的価格計算（Tiered Pricing）

LiteLLM の価格データは200kトークンを閾値とする段階的価格を含む。`calculateTieredCost` 関数は閾値以下と超過分を分離し、それぞれ異なる単価を適用する。閾値はパラメータ化されており、将来別のモデルが異なる閾値を採用した場合にも対応できる。

## コード例

```typescript
// apps/ccusage/src/data-loader.ts:538-556
// JSONL ストリーミング解析 — createReadStream で1行ずつ処理
async function processJSONLFileByLine(
  filePath: string,
  processLine: (line: string, lineNumber: number) => void | Promise<void>,
): Promise<void> {
  const fileStream = createReadStream(filePath, { encoding: "utf-8" });
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber++;
    if (line.trim().length === 0) {
      continue;
    }
    await processLine(line, lineNumber);
  }
}
```

```typescript
// apps/ccusage/src/_types.ts:9-13, 109
// Branded Types でドメイン値の型安全性を確保
export const modelNameSchema = v.pipe(
  v.string(),
  v.minLength(1, "Model name cannot be empty"),
  v.brand("ModelName"),
);

export const createModelName = (value: string): ModelName => v.parse(modelNameSchema, value);
```

```typescript
// apps/ccusage/src/data-loader.ts:826-833
// NUL 文字セパレータによる複合グルーピングキー
const needsProjectGrouping = options?.groupByProject === true || options?.project != null;
const groupingKey = needsProjectGrouping
  ? (entry: (typeof allEntries)[0]) => `${entry.date}\x00${entry.project}`
  : (entry: (typeof allEntries)[0]) => entry.date;

const groupedData = groupBy(allEntries, groupingKey);
```

```typescript
// apps/ccusage/src/data-loader.ts:629-667
// 3モードコスト計算 — exhaustive switch で漏れを防ぐ
export async function calculateCostForEntry(
  data: UsageData,
  mode: CostMode,
  fetcher: PricingFetcher,
): Promise<number> {
  if (mode === "display") {
    return data.costUSD ?? 0;
  }
  if (mode === "calculate") {
    if (data.message.model != null) {
      return Result.unwrap(
        fetcher.calculateCostFromTokens(data.message.usage, data.message.model),
        0,
      );
    }
    return 0;
  }
  if (mode === "auto") {
    if (data.costUSD != null) {
      return data.costUSD;
    }
    if (data.message.model != null) {
      return Result.unwrap(
        fetcher.calculateCostFromTokens(data.message.usage, data.message.model),
        0,
      );
    }
    return 0;
  }
  unreachable(mode);
}
```

```typescript
// apps/ccusage/src/data-loader.ts:1081-1091
// 月次集約は日次を入力として再集約するパターン
export async function loadMonthlyUsageData(options?: LoadOptions): Promise<MonthlyUsage[]> {
  return loadBucketUsageData(
    (data: DailyUsage) => createMonthlyDate(data.date.slice(0, 7)),
    options,
  ).then((usages) =>
    usages.map<MonthlyUsage>(({ bucket, ...rest }) => ({
      month: v.parse(monthlyDateSchema, bucket),
      ...rest,
    }))
  );
}
```

```typescript
// apps/ccusage/src/_token-utils.ts:40-53
// 2つの命名規約を1つの関数で吸収する polymorphic token counter
export function getTotalTokens(tokenCounts: AnyTokenCounts): number {
  const cacheCreation = "cacheCreationInputTokens" in tokenCounts
    ? tokenCounts.cacheCreationInputTokens
    : tokenCounts.cacheCreationTokens;

  const cacheRead = "cacheReadInputTokens" in tokenCounts
    ? tokenCounts.cacheReadInputTokens
    : tokenCounts.cacheReadTokens;

  return tokenCounts.inputTokens + tokenCounts.outputTokens + cacheCreation + cacheRead;
}
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: コスト計算ロジックを実行時に切り替えたい
  - 適用条件: 同じデータに対して複数の処理戦略が存在する場合
  - コード例: `data-loader.ts:629-667` の `CostMode` による分岐、`data-loader.ts:1167-1244` のバケットグルーピング関数の差し替え
  - 注意点: 戦略の列挙型 + `unreachable()` で網羅性を保証する

- **Pipeline / Chain of Responsibility パターン** (分類: 振る舞い)
  - 解決する問題: データ処理の各段階を分離し、組み合わせを変更可能にしたい
  - 適用条件: データが複数の変換・フィルタ段階を経る場合
  - コード例: `data-loader.ts:749-890` の loadDailyUsageData（glob → sort → parse → dedupe → cost → group → aggregate → filter → sort）
  - 注意点: 各段階が独立して失敗を処理するため、段階間の暗黙の依存に注意する

- **Null Object パターン** (分類: 振る舞い)
  - 解決する問題: 欠損値をエラーにせず、安全にデフォルト値で継続したい
  - 適用条件: 外部データソースからのオプショナルなフィールドを扱う場合
  - コード例: `data-loader.ts:636` の `data.costUSD ?? 0`、`_session-blocks.ts:190` の `entry.costUSD ?? 0`、`codex/data-loader.ts:25-27` の `ensureNumber()`
  - 注意点: 欠損と 0 の区別が必要なケースでは `null | number` を維持する

## Good Patterns

- **In-Source Testing（`import.meta.vitest`）**: テストがプロダクションコードと同じファイルに共存する。`_session-blocks.ts`, `_token-utils.ts`, `calculate-cost.ts`, `_daily-grouping.ts` 等ほぼすべてのモジュールで採用。プライベート関数のテストが自然に書け、コードとテストの乖離を防ぐ。

```typescript
// apps/ccusage/src/calculate-cost.ts:84-86
if (import.meta.vitest != null) {
  describe("token aggregation utilities", () => {
    // テストがプロダクションコードと同じファイルに
  });
}
```

- **`using` 宣言による Disposable リソース管理**: `PricingFetcher` は `Disposable` インタフェースを実装し、`using` 宣言でスコープ終了時に自動的にキャッシュをクリアする。手動 cleanup の漏れを防ぐ。

```typescript
// apps/ccusage/src/data-loader.ts:775
using fetcher = mode === "display" ? null : new PricingFetcher(options?.offline);
// スコープ終了時に fetcher[Symbol.dispose]() が自動呼出し → キャッシュクリア
```

- **ビルド時マクロによるオフラインデータのプリフェッチ**: `_pricing-fetcher.ts` で `import ... with { type: 'macro' }` を使い、ビルド時に価格データを静的に埋め込む。実行時のネットワーク依存を削減しつつ、最新データ取得も可能にするハイブリッド設計。

```typescript
// apps/ccusage/src/_pricing-fetcher.ts:3,14
import { prefetchClaudePricing } from "./_macro.ts" with { type: "macro" };
const PREFETCHED_CLAUDE_PRICING = prefetchClaudePricing();
```

- **`unreachable()` による網羅性チェック**: `CostMode` や `SortOrder` の分岐で、すべてのケースを処理した後に `unreachable(mode)` を配置。TypeScript の `never` 型チェックにより、列挙値の追加漏れがコンパイル時に検出される。

```typescript
// apps/ccusage/src/_utils.ts:5-7
export function unreachable(value: never): never {
  throw new Error(`Unreachable code reached with value: ${value as any}`);
}
```

## Anti-Patterns / 注意点

- **大規模ファイルでの全行メモリ蓄積**: `loadDailyUsageData` はストリーミングで JSONL を読むが、`allEntries` 配列にすべてのエントリを蓄積してからグルーピングする。極めて大規模なデータセットではメモリ圧迫のリスクがある。

```typescript
// Bad: apps/ccusage/src/data-loader.ts:781-787
const allEntries: { data: UsageData; date: string; cost: number; ... }[] = [];
// 全エントリをメモリに保持

// Better: ストリーミング集約 — 読みながらグループごとのアキュムレータに直接加算
const dailyAccumulator = new Map<string, TokenStats>();
await processJSONLFileByLine(file, (line) => {
	// ...parse and validate...
	const existing = dailyAccumulator.get(date) ?? defaultStats;
	dailyAccumulator.set(date, mergeStats(existing, newEntry));
});
```

- **トークンプロパティ名の不統一**: 生データは `cacheCreationInputTokens`、集約データは `cacheCreationTokens` と命名が異なり、`getTotalTokens()` で `'cacheCreationInputTokens' in tokenCounts` のランタイムチェックで吸収している。ユニオン型 `AnyTokenCounts` は型安全だが、プロパティ名の不一致がコードベース全体に波及するリスクがある。

```typescript
// Bad: apps/ccusage/src/_token-utils.ts:42-46
const cacheCreation = "cacheCreationInputTokens" in tokenCounts
  ? tokenCounts.cacheCreationInputTokens
  : tokenCounts.cacheCreationTokens;

// Better: 早い段階で正規化し、以降は統一名で扱う
type NormalizedTokenCounts = { input: number; output: number; cacheCreate: number; cacheRead: number; };
function normalizeTokenCounts(raw: AnyTokenCounts): NormalizedTokenCounts {/* ... */}
```

## 導出ルール

- `[MUST]` JSONL/CSV など行指向ログファイルの解析では、不正行をサイレントスキップし、パイプライン全体を停止させない
  - 根拠: ccusage はすべての JSONL 解析で `try/catch` + `v.safeParse` を使い、不正行を黙殺して処理を継続する（`data-loader.ts:793-801`）。追記ログは途中破損が日常的に起こるため
- `[MUST]` 列挙的な分岐（モード切替、ソート順等）では `unreachable(value: never)` で網羅性をコンパイル時に保証する
  - 根拠: `calculateCostForEntry` の CostMode 分岐で `unreachable(mode)` により、新しいモードの追加時にハンドリング漏れがコンパイルエラーになる（`data-loader.ts:666`, `_date-utils.ts:69`）
- `[SHOULD]` 時系列データの多段集約は「下位粒度を先に確定 → 上位粒度で再集約」の階層パターンで実装する
  - 根拠: ccusage は日次データを先に構築し、月次・週次は日次を入力として `loadBucketUsageData` で再集約する（`data-loader.ts:1081-1106`）。各階層が独立テスト可能で、集約ロジックの重複も防ぐ
- `[SHOULD]` 外部データソース（API 価格、為替レート等）にはキャッシュ + オフラインフォールバック + `Disposable` によるライフサイクル管理を適用する
  - 根拠: `LiteLLMPricingFetcher` はメモリキャッシュ → ネットワーク取得 → ビルド時プリフェッチデータの3段フォールバックを持ち、`using` で自動クリーンアップする（`pricing.ts:89-198`）
- `[SHOULD]` 複合グルーピングキーには NUL 文字（`\x00`）など通常データに出現しない文字をセパレータに使う
  - 根拠: `loadDailyUsageData` で `date\x00project` をグルーピングキーに使用し、日付やプロジェクト名に含まれうる `-` や `/` との衝突を回避する（`data-loader.ts:831`）
- `[SHOULD]` ドメイン固有の文字列値（ID、日付形式、モデル名等）には Branded Types を適用し、暗黙の型混在を防ぐ
  - 根拠: `DailyDate`, `MonthlyDate`, `SessionId`, `ModelName` 等を Valibot の `brand()` で区別し、`createXxx()` 関数を経由させることでバリデーション済みの値のみが流通する（`_types.ts:9-132`）
- `[AVOID]` データ処理パイプラインで全エントリをメモリに蓄積してから集約するパターン — 大規模データでは読み込みながら逐次集約（streaming aggregation）を検討する
  - 根拠: `loadDailyUsageData` は `allEntries[]` に全エントリを蓄積後にグルーピングするため、データ量に比例してメモリ使用量が増加する（`data-loader.ts:781-824`）

## 適用チェックリスト

- [ ] ログファイル（JSONL/CSV/TSV）の解析で、不正行がパイプライン全体を停止させない設計になっているか
- [ ] ストリーミング解析を使い、大規模ファイルでもメモリ使用量が制御されているか
- [ ] ドメイン固有の文字列値に Branded Types または Newtype パターンを適用し、型レベルで混在を防いでいるか
- [ ] 列挙的な分岐に `unreachable()` / exhaustive switch を配置し、値の追加時にコンパイルエラーが出るか
- [ ] 時系列集約が階層的に設計され、各粒度のロジックが独立テスト可能か
- [ ] 外部データソースにキャッシュとオフラインフォールバックが実装されているか
- [ ] 複合グルーピングキーのセパレータが、データ値と衝突しない文字を使っているか
- [ ] リソース（キャッシュ、接続等）のライフサイクルが `Disposable` / `using` で管理されているか
