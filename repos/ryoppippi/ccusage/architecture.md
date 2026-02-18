# architecture

> リポジトリ: ryoppippi/ccusage
> 分析日: 2026-02-16

## 概要

ccusage は Claude Code / Codex CLI の使用量をローカル JSONL ファイルから分析する CLI ツール群であり、pnpm workspace による monorepo 構成を採用している。注目すべきは、複数の AI ツール（Claude Code, Codex, OpenCode, Amp, Pi）ごとに独立した app を持ちながら、共通の pricing ロジックとターミナル表示を `packages/` に切り出す「扇形依存」のアーキテクチャを実現している点である。データフロー（JSONL 読み込み → バリデーション → 集約 → 出力）が全 app で一貫しており、レイヤー間の責務分離が明確である。

## 背景にある原則

- **Branded Types による境界の型安全性**: ドメイン固有の文字列（SessionId, ModelName, DailyDate 等）を Valibot の `brand()` でブランド型化し、素の `string` との混同をコンパイル時に防止する。バリデーションと型付けを同一のスキーマで一元管理することで、「検証済みデータ」と「未検証データ」の区別を型システムに委ねている（`_types.ts:9-132`）。
- **Result 型によるエラー伝搬の明示化**: `@praha/byethrow` の `Result` 型をデータ取得・外部 API 呼び出し・ファイル I/O の全レイヤーで使用し、例外ベースのエラーハンドリングを排除する。`Result.pipe` によるモナディックな合成で、エラー処理のチェーンを宣言的に記述している（102 箇所、14 ファイルで使用）。
- **In-source Testing による凝集性の維持**: `import.meta.vitest` を活用し、テストコードを実装ファイル内に同居させる。ビルド時には `define: { 'import.meta.vitest': 'undefined' }` でテストコードを除去する。これにより、実装とテストの距離を最小化し、内部関数のテストを export なしで実現している（41 ファイルで使用）。
- **Build-time Macro による外部データの埋め込み**: `unplugin-macros` を使い、LiteLLM の pricing データをビルド時に取得してバンドルに埋め込む（`_macro.ts`）。ランタイムの外部依存を排除しつつ、オフラインモードをゼロコストで実現する設計。

## 実例と分析

### Monorepo のレイヤー構造と依存方向

依存グラフは厳密に一方向（apps → packages）を維持している。

```
apps/ccusage ──→ @ccusage/internal (pricing, format, logger)
             ──→ @ccusage/terminal (table, utils)
apps/codex   ──→ @ccusage/internal
             ──→ @ccusage/terminal
apps/mcp     ──→ ccusage (data-loader, logger を再利用)
             ──→ @ccusage/codex
             ──→ @ccusage/internal
```

MCP サーバー（`apps/mcp`）は `ccusage` パッケージの `data-loader` を直接 import して利用する。これは「MCP は ccusage のデータ層をそのまま外部プロトコルに公開するアダプタ」という設計判断を反映している。

```typescript
// apps/mcp/src/command.ts:1-5
import type { LoadOptions } from "ccusage/data-loader";
import { getClaudePaths } from "ccusage/data-loader";
import { logger } from "ccusage/logger";
```

### データフローのパイプライン構造

全コマンドが共通の 4 段パイプラインに従う:

1. **Discover**: `getClaudePaths()` でデータディレクトリを特定（`data-loader.ts:78-143`）
2. **Load & Validate**: JSONL ファイルを Valibot スキーマで検証（`usageDataSchema`, `data-loader.ts:167-192`）
3. **Aggregate**: 時間軸に応じた集約（daily/weekly/monthly/session/blocks）
4. **Render**: JSON または `ResponsiveTable` で出力

各コマンドの `run()` 関数がこのパイプラインを組み立てる。例えば daily コマンドでは:

```typescript
// apps/ccusage/src/commands/daily.ts:78-93
const dailyData = await loadDailyUsageData({
  ...mergedOptions,
  groupByProject: mergedOptions.instances,
});
// ... calculate totals, then render as JSON or table
const totals = calculateTotals(dailyData);
```

### `_` プレフィックスによる内部モジュールの可視性制御

ビルド設定で `!./src/_*.ts` を除外し、`_` プレフィックスのファイルを公開 API から隠蔽している:

```typescript
// apps/ccusage/tsdown.config.ts:7-8
entry: [
  './src/*.ts',
  '!./src/_*.ts', // Exclude internal files with underscore prefix
],
```

これにより、`_types.ts`, `_consts.ts`, `_utils.ts`, `_session-blocks.ts` 等はパッケージ内でのみ利用可能となり、外部からの依存を防止している。

### Config の優先度付きマージ戦略

CLI 引数・コマンド固有設定・デフォルト設定の 3 層マージを、Gunshi の tokens を利用して「ユーザーが明示的に指定した引数」のみを最優先にする:

```typescript
// apps/ccusage/src/_config-loader-tokens.ts:260-269
const explicit = extractExplicitArgs(ctx.tokens);
for (const [key, value] of Object.entries(ctx.values)) {
  if (value != null && explicit[key] === true) {
    (merged as any)[key] = value;
    sources[key] = "CLI";
  }
}
```

この設計により、設定ファイルのデフォルト値が CLI のデフォルト値（gunshi が付与）で上書きされる問題を回避している。

### Disposable パターンによるリソース管理

`using` 文（TC39 Explicit Resource Management）を活用し、PricingFetcher のキャッシュや test fixture を自動クリーンアップ:

```typescript
// apps/ccusage/src/data-loader.ts:775
using fetcher = mode === 'display' ? null : new PricingFetcher(options?.offline);

// packages/internal/src/pricing.ts:105-107
[Symbol.dispose](): void {
  this.clearCache();
}
```

## パターンカタログ

- **Adapter パターン** (構造)
  - 解決する問題: ccusage の内部データモデルを MCP プロトコルに変換する
  - 適用条件: 既存のデータ層を別のプロトコルで外部公開する場合
  - コード例: `apps/mcp/src/mcp.ts:46-184` - `createMcpServer` が ccusage の load 関数を MCP ツールとしてラップ
  - 注意点: アダプタが薄いほど保守コストが低い。MCP サーバーは自前のデータローダーを持たず、ccusage を直接依存している

- **Strategy パターン** (振る舞い)
  - 解決する問題: コスト計算モード（auto/calculate/display）を実行時に切り替える
  - 適用条件: 同じインターフェースで異なるアルゴリズムを適用する場合
  - コード例: `apps/ccusage/src/_types.ts:140-145` - `CostModes` 定義、`data-loader.ts:772` でモードに応じた fetcher の生成
  - 注意点: `as const satisfies` で enum 値を型安全に制約している

## Good Patterns

- **Valibot Brand + Factory 関数で型安全な値オブジェクトを構築**: スキーマ定義と型導出を一体化し、`createXxx()` ファクトリ関数で検証済みブランド値を生成する。素の文字列の混入をコンパイル時に検出できる。

```typescript
// apps/ccusage/src/_types.ts:9-13, 109
export const modelNameSchema = v.pipe(
  v.string(),
  v.minLength(1, "Model name cannot be empty"),
  v.brand("ModelName"),
);
export const createModelName = (value: string): ModelName => v.parse(modelNameSchema, value);
```

- **pnpm catalogs で依存バージョンを一元管理**: `pnpm-workspace.yaml` の `catalogs:` セクションで、ランタイム・ビルド・テスト・lint のカテゴリ別にバージョンを定義し、各 `package.json` では `catalog:runtime` のような参照で使用する。

```yaml
# pnpm-workspace.yaml:8-10, 41
catalogs:
  build:
    tsdown: ^0.16.6
  runtime:
    valibot: ^1.1.0
```

- **exhaustive switch + `satisfies never` で網羅性を保証**: switch 文の default ケースで `satisfies never` を使い、新しい enum 値の追加時にコンパイルエラーで漏れを検出する。

```typescript
// apps/mcp/src/command.ts:80-83
default: {
  mcpType satisfies never;
  throw new Error(`Unsupported MCP type: ${mcpType as string}`);
}
```

- **ResponsiveTable によるターミナル幅適応型 UI**: ターミナル幅を検出し、閾値以下でコンパクトモードに自動切り替え。表示カラムの動的削減と日付フォーマットの圧縮を行う。

```typescript
// packages/terminal/src/table.ts:182-188
const terminalWidth = Number.parseInt(process.env.COLUMNS ?? "", 10) || process.stdout.columns || 120;
this.compactMode = this.forceCompact || (terminalWidth < this.compactThreshold && this.compactHead != null);
```

## Anti-Patterns / 注意点

- **God File (data-loader.ts)**: 単一ファイルが 1300 行超・46K トークンに達しており、データ読み込み・バリデーション・集約・ユーティリティが混在している。責務の分離が不十分で、変更の影響範囲が広い。

```typescript
// Bad: data-loader.ts に 7 つの load 関数 + スキーマ定義 + ユーティリティが同居
export async function loadDailyUsageData(options?: LoadOptions): Promise<DailyUsage[]> { ... }
export async function loadSessionData(options?: LoadOptions): Promise<SessionUsage[]> { ... }
export async function loadMonthlyUsageData(options?: LoadOptions): Promise<MonthlyUsage[]> { ... }
// ... 他にも 4 つの load 関数
```

```typescript
// Better: 責務ごとにファイルを分割
// _schemas.ts  - Valibot スキーマ定義
// _file-reader.ts - JSONL ファイル読み込み
// _aggregator.ts  - 時間軸別の集約ロジック
// data-loader.ts  - 公開 API（上記を組み合わせるファサード）
```

- **App 間のデータローダー重複**: `apps/ccusage/src/data-loader.ts`, `apps/codex/src/data-loader.ts`, `apps/amp/src/data-loader.ts` がそれぞれ独自のデータローダーを持つ。JSONL の読み込みパターンやバリデーションロジックに重複がある。`packages/internal` にデータ読み込みの基盤を抽出すれば、重複を削減できる。

## 導出ルール

- `[MUST]` ドメイン固有の識別子（ID, 日付フォーマット等）には、バリデーションスキーマとブランド型をセットで定義し、ファクトリ関数経由でのみ値を生成する
  - 根拠: ccusage は SessionId, ModelName, DailyDate 等の全ドメイン値を Valibot brand で型付けし、素の string との混同をコンパイル時に防止している（`_types.ts:9-132`）

- `[MUST]` monorepo の依存方向は apps → packages の一方向に制限し、packages 間の相互依存を禁止する
  - 根拠: ccusage は `@ccusage/internal` と `@ccusage/terminal` を packages に配置し、全 app から一方向に参照する構造を維持している。MCP は ccusage を直接依存することでデータ層を再利用している

- `[SHOULD]` 外部 API のレスポンスやファイル I/O の結果は Result 型で包み、例外ではなく値としてエラーを伝搬する
  - 根拠: `@praha/byethrow` の `Result.pipe` / `Result.try` が 14 ファイル・102 箇所で使用され、pricing 取得・ファイル読み込み・jq 実行の全てで宣言的なエラーチェーンを構成している

- `[SHOULD]` CLI ツールの設定マージでは、「ユーザーが明示的に指定した引数」と「フレームワークが付与したデフォルト値」を区別し、設定ファイルのデフォルトがフレームワークのデフォルトで上書きされないようにする
  - 根拠: `_config-loader-tokens.ts` が gunshi の tokens から明示的な引数を抽出し、3 層マージ（defaults → command config → CLI）の優先度を正確に制御している

- `[SHOULD]` ビルド時に除去可能なインソーステストを活用し、実装とテストの距離を最小化する
  - 根拠: `import.meta.vitest` + `define: { 'import.meta.vitest': 'undefined' }` で、41 ファイルのテストがプロダクションバンドルに含まれない形で同居している

- `[AVOID]` 単一ファイルにデータ読み込み・バリデーション・集約・型定義を詰め込んで 800 行を超過させる
  - 根拠: `data-loader.ts` は 1300 行超に膨らみ、7 つの load 関数とスキーマ定義が混在している。ファサードパターンで公開 API を薄く保ち、内部処理を `_` プレフィックスファイルに分割する方が保守性が高い

## 適用チェックリスト

- [ ] ドメイン固有の文字列型（ユーザーID、日付フォーマット等）にブランド型を導入し、素の string との混同を防止しているか
- [ ] monorepo の依存方向が一方向（apps → packages）に制限され、packages 間の相互依存がないか
- [ ] 外部 API 呼び出し・ファイル I/O のエラーが Result 型で伝搬され、例外に依存していないか
- [ ] CLI の設定マージで「明示的な引数」と「デフォルト値」を区別し、設定ファイルの値が意図せず上書きされていないか
- [ ] 800 行を超えるファイルがないか。超過している場合、責務を分割する `_` プレフィックスの内部モジュールに切り出せないか
- [ ] ビルド時に除去されるインソーステスト、またはコロケーションテストの仕組みがあるか
- [ ] pnpm catalogs や類似の仕組みで、monorepo 全体の依存バージョンが一元管理されているか
