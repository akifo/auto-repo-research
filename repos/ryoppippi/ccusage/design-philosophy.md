# 設計思想

> リポジトリ: ryoppippi/ccusage
> 分析日: 2026-02-16

## 概要

ccusage は Claude Code / Codex CLI の使用量を JSONL ファイルから分析する CLI ツールである。設計思想として注目に値するのは、(1) バンドル前提の monorepo 設計で `devDependencies` のみに依存を集約する戦略、(2) AI エージェントをファーストクラスの開発者として扱い CLAUDE.md を階層的に配置する構造、(3) Result 型・Branded 型・in-source testing といった「正しさの境界を型とスキーマで定義する」一貫した哲学が、120 ファイル規模のプロジェクト全体を貫いていることである。

## 背景にある原則

- **配布単位＝バンドルなら依存は devDependencies に寄せるべき**: バンドル CLI ではランタイム依存がバンドラーに取り込まれるため、`dependencies` に記載する意味がない。ccusage では全 apps（mcp を除く）が `devDependencies` のみで構成され、パッケージサイズと依存ツリーの攻撃面を最小化している（`apps/ccusage/package.json` には `dependencies` フィールドが存在しない）。

- **内部 API は命名規約で明示し、ビルド設定で強制すべき**: `_` prefix のファイルは内部モジュールであり、tsdown の entry 設定で `!./src/_*.ts` として明示的にバンドル対象から除外している（`apps/ccusage/tsdown.config.ts:8`）。命名規約だけに頼らず、ビルドパイプラインで機械的に制約を課すことで、意図せぬ公開 API の露出を防いでいる。

- **AI 開発者にはプロジェクト構造と同じ粒度でコンテキストを提供すべき**: CLAUDE.md がルートと各パッケージ（10 ファイル）に配置され、スコープごとの開発ルール・コマンド・アーキテクチャが記述されている。AI エージェントが作業するスコープに応じて最適なコンテキストを得られる設計であり、さらに `.claude/skills/` でライブラリドキュメントへの参照も構造化されている。

- **データの正しさはパース時にスキーマで保証し、失敗は静かに無視すべき**: 外部データ（JSONL）のパースに `v.safeParse()` を使い、不正なデータは `return` / `continue` で静かにスキップする（`data-loader.ts:796-799`）。例外を投げずに「処理できるものだけ処理する」レジリエンスパターンにより、1 行の破損がツール全体の停止を引き起こさない。

## 実例と分析

### バンドル前提の依存管理戦略

ccusage monorepo の 6 つの apps のうち、MCP サーバーを除く 5 つは `devDependencies` のみで構成されている。これは「バンドル CLI として配布する以上、`dependencies` に列挙する必要がない」という判断に基づく。

```typescript
// apps/ccusage/package.json:69-104（抜粋）
"devDependencies": {
    "@ccusage/internal": "workspace:*",
    "@ccusage/terminal": "workspace:*",
    "@praha/byethrow": "catalog:runtime",
    "gunshi": "catalog:runtime",
    "valibot": "catalog:runtime",
    // ... すべて devDependencies
}
```

CLAUDE.md でもこの方針が明示されている:

> "All projects under `apps/` ship as bundled CLIs/binaries. Treat their runtime dependencies as bundled assets: list everything in each app's `devDependencies` (never `dependencies`) so the bundler owns the runtime payload."
> -- CLAUDE.md:19

pnpm catalogs（`pnpm-workspace.yaml`）で `catalogMode: strict` を設定し、全パッケージのバージョンを一元管理している。`catalog:runtime`, `catalog:build`, `catalog:lint` などのカテゴリ分けにより、依存の目的が宣言的に表現される。

### ビルド時マクロによる静的データの埋め込み

`unplugin-macros` を使い、ビルド時に LiteLLM の価格データを取得してバンドルに埋め込んでいる。

```typescript
// apps/ccusage/src/_pricing-fetcher.ts:3
import { prefetchClaudePricing } from './_macro.ts' with { type: 'macro' };

const PREFETCHED_CLAUDE_PRICING = prefetchClaudePricing();
```

```typescript
// apps/ccusage/src/_macro.ts:16-24
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

この設計により、オフラインでも価格計算が可能になり、ランタイムのネットワーク依存を排除している。`--offline` フラグで明示的にこのプリフェッチデータを使うモードも提供される。

### Branded 型による意味的な型安全性

Valibot の `brand()` を使い、同じ `string` 型でも `ModelName`, `SessionId`, `DailyDate` など 12 種類の Branded 型を定義している。

```typescript
// apps/ccusage/src/_types.ts:9-13
export const modelNameSchema = v.pipe(
    v.string(),
    v.minLength(1, 'Model name cannot be empty'),
    v.brand('ModelName'),
);
```

ファクトリ関数でバリデーション付きの変換を強制する:

```typescript
// apps/ccusage/src/_types.ts:109
export const createModelName = (value: string): ModelName => v.parse(modelNameSchema, value);
```

スキーマから型を導出する一貫したパターンにより、ランタイムバリデーションと静的型が常に同期する:

```typescript
// apps/ccusage/src/_types.ts:91
export type ModelName = v.InferOutput<typeof modelNameSchema>;
```

### In-source Testing パターン

テストファイルを分離せず、ソースファイル内に `if (import.meta.vitest != null)` ブロックでテストを記述する。ビルド時には `import.meta.vitest` を `undefined` に置換してデッドコード除去する。

```typescript
// apps/ccusage/tsdown.config.ts:33-34
define: {
    'import.meta.vitest': 'undefined',
},
```

```typescript
// apps/ccusage/src/_jq-processor.ts:42-48
if (import.meta.vitest != null) {
    describe('processWithJq', () => {
        it('should process JSON with simple filter', async () => {
            const data = { name: 'test', value: 42 };
            const result = await processWithJq(data, '.name');
            const unwrapped = Result.unwrap(result);
            expect(unwrapped).toBe('"test"');
        });
```

41 ファイルでこのパターンが使われており、テスト対象のコードとテストが常に同居する。

### Result 型による関数型エラーハンドリング

`@praha/byethrow` の Result 型を、try-catch の代替として一貫して使用する。`Result.pipe()` でチェーン、`Result.try()` で例外をキャッチ、`Result.unwrap()` でデフォルト値付きアンラップという3段構成が典型パターン。

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

エラーチェックは `Result.isFailure()` による早期リターンが推奨される:

```typescript
// apps/ccusage/src/commands/daily.ts:128
if (Result.isFailure(jqResult)) {
```

### Disposable パターンによるリソース管理

`Symbol.dispose` / `Symbol.asyncDispose` を実装し、`using` / `await using` 構文でリソース解放を自動化している。

```typescript
// packages/internal/src/pricing.ts:89,105-107
export class LiteLLMPricingFetcher implements Disposable {
    [Symbol.dispose](): void {
        this.clearCache();
    }
```

テストでは `using` で自動クリーンアップ:

```typescript
// apps/codex/src/pricing.ts:76
using source = new CodexPricingSource({
    offline: true,
    offlineLoader: async () => ({...}),
});
```

### AI ファーストの階層的コンテキスト設計

CLAUDE.md がルート + 各パッケージに配置され、スコープ別のガイダンスを提供する。さらに `.claude/skills/` でライブラリドキュメントへの構造化された参照を持つ。

```
CLAUDE.md                          # monorepo 全体のルール
apps/ccusage/CLAUDE.md             # メインCLI固有のルール
apps/mcp/CLAUDE.md                 # MCPサーバー固有のルール
packages/internal/CLAUDE.md        # 内部パッケージ固有のルール
.claude/skills/byethrow/SKILL.md   # byethrow ドキュメント参照
.claude/skills/use-gunshi-cli/SKILL.md  # gunshi ドキュメント参照
```

各 CLAUDE.md には「Post-Change Workflow」として `format` / `typecheck` / `test` の並列実行が記載されており、AI エージェントがコード変更後に必ず品質チェックを行う手順が標準化されている。

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: コスト計算モード（auto/calculate/display）の切り替え
  - 適用条件: 同じデータに対する処理方法をランタイムで選択する場面
  - コード例: `apps/ccusage/src/_types.ts:140` の `CostModes` 定義と `data-loader.ts:816-817` の分岐
  - 注意点: 列挙値を `as const` 配列で定義し、型を `TupleToUnion` で導出する手法で型安全に保つ

- **Adapter パターン** (分類: 構造)
  - 解決する問題: 各 AI ツール（Claude/Codex/Amp）の異なるデータ形式を統一的に処理
  - 適用条件: 共通の内部パッケージ（`@ccusage/internal`）を各 app が利用する構造
  - コード例: `apps/codex/src/pricing.ts:24` の `CodexPricingSource implements PricingSource, Disposable`
  - 注意点: 共通インターフェースを packages/ に、具体実装を各 app に置く責務分離

## Good Patterns

- **pnpm catalogs による依存バージョンの一元管理**: `pnpm-workspace.yaml` の `catalogs` セクションで `runtime`, `build`, `lint`, `testing` 等のカテゴリに分類し、バージョンを一箇所で管理する。各 `package.json` では `"valibot": "catalog:runtime"` のように参照するだけでよい。カテゴリ名が依存の目的を自己文書化する。

- **スキーマ駆動の型定義**: `v.object({...})` でスキーマを定義し、`v.InferOutput<typeof schema>` で型を導出する。ランタイムバリデーションと TypeScript の型が常に一致し、「型は通るがバリデーションは落ちる」不整合を構造的に排除する。

```typescript
// apps/ccusage/src/data-loader.ts:241-256
export const dailyUsageSchema = v.object({
    date: dailyDateSchema,
    inputTokens: v.number(),
    // ...
});
export type DailyUsage = v.InferOutput<typeof dailyUsageSchema>;
```

- **サプライチェーン攻撃への多層防御**: `pnpm-workspace.yaml` で `strictDepBuilds: true`, `blockExoticSubdeps: true`, `trustPolicy: no-downgrade`, `minimumReleaseAge: 2880`（48 時間）を設定。ビルドスクリプトの実行を明示的な allowlist に限定し、依存の公開直後のインストールを防止する。

## Anti-Patterns / 注意点

- **MCP アプリだけ dependencies に記載されている不一致**: `apps/mcp/package.json` のみ `dependencies` フィールドを持ち、他の 5 アプリの `devDependencies` only 方針と矛盾する。MCP サーバーはバンドルせずに直接実行する用途があるためと推測されるが、設計意図が文書化されておらず、新規開発者に混乱を与える可能性がある。

```json
// apps/mcp/package.json:55-64（Bad: 他のアプリと方針が異なる）
"dependencies": {
    "ccusage": "workspace:*",
    "gunshi": "catalog:runtime",
    "hono": "catalog:runtime",
    "zod": "catalog:runtime"
}
```

```json
// apps/ccusage/package.json（Better: 一貫して devDependencies のみ）
"devDependencies": {
    "gunshi": "catalog:runtime",
    "valibot": "catalog:runtime",
    // ... すべて devDependencies
}
```

例外がある場合は、その理由を CLAUDE.md またはパッケージの README に明記するべきである。

- **valibot と zod の混在**: ccusage 本体と codex は valibot を使用し、MCP サーバーは zod を使用している。バリデーションライブラリの混在は学習コストとバンドルサイズを増大させる。MCP サーバーが `@modelcontextprotocol/sdk` の zod 依存に引っ張られている可能性が高いが、変換レイヤーの検討が望ましい。

## 導出ルール

- `[MUST]` バンドル配布する CLI/ツールでは、ランタイム依存を `devDependencies` に配置し `dependencies` を空にする
  - 根拠: ccusage の全 apps（mcp 除く）がこの方針を採用し、CLAUDE.md で明文化。バンドラーが依存を内包するため `dependencies` への記載は不要であり、パッケージサイズと依存ツリーの攻撃面を削減できる

- `[MUST]` 外部入力のパースでは `safeParse()` 相当の非例外パターンを使い、不正データは静かにスキップする
  - 根拠: `data-loader.ts` で JSONL の各行を `v.safeParse()` でパースし、失敗行は `return` で無視（796-799 行）。1 件の不正データがツール全体を停止させないレジリエンス設計

- `[SHOULD]` スキーマ定義から型を導出し、手書きの型定義とバリデーションロジックの二重管理を避ける
  - 根拠: `_types.ts` で `v.brand()` 付きスキーマを定義し `v.InferOutput<typeof schema>` で型を導出。12 種類の Branded 型すべてがこのパターンに従い、型とバリデーションの一致を構造的に保証

- `[SHOULD]` 内部モジュールはファイル名の命名規約（`_` prefix）だけでなく、ビルド設定で公開 API からの除外を機械的に強制する
  - 根拠: tsdown の entry で `!./src/_*.ts` として内部ファイルを除外（`tsdown.config.ts:8`）。命名規約は破られうるが、ビルド設定の強制は自動的

- `[SHOULD]` monorepo で AI エージェントを活用する場合、パッケージごとに CLAUDE.md を配置してスコープ別のコンテキストを提供する
  - 根拠: 10 個の CLAUDE.md がルートと各パッケージに存在し、開発コマンド・アーキテクチャ・コード規約がスコープごとに記述されている。AI がどのディレクトリで作業しても最適なガイダンスを得られる

- `[SHOULD]` ビルド時マクロを使い、ランタイムでのネットワーク依存を減らすために静的データをバンドルに埋め込む
  - 根拠: `_macro.ts` で LiteLLM の価格データをビルド時にフェッチしバンドルに含めることで、オフライン実行を可能にしている

- `[AVOID]` 同じ monorepo 内でバリデーションライブラリ（valibot / zod 等）を混在させる
  - 根拠: ccusage は valibot、MCP は zod を使用。SDK の依存に引っ張られる場合でも、変換レイヤーで統一するか、混在の理由を文書化すべき

## 適用チェックリスト

- [ ] バンドル配布する CLI で `dependencies` が空であることを確認し、全ランタイム依存を `devDependencies` に移動する
- [ ] 外部データのパースに例外を投げるパーサーを使っていないか確認し、`safeParse` パターンに切り替える
- [ ] 型定義がスキーマから導出されているか確認し、手書きの型定義とバリデーションの二重管理を排除する
- [ ] 内部モジュールがビルド設定で公開 API から除外されていることを確認する（命名規約だけに依存していないか）
- [ ] monorepo で AI エージェントを活用する場合、パッケージごとの CLAUDE.md にスコープ別の開発ルールを記載する
- [ ] pnpm catalogs または同等の仕組みで依存バージョンを一元管理し、カテゴリ名で依存の目的を自己文書化する
- [ ] サプライチェーン保護設定（`strictDepBuilds`, `minimumReleaseAge` 等）が有効であることを確認する
