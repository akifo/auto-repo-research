# CLI Framework Patterns

> リポジトリ: ryoppippi/ccusage
> 分析日: 2026-02-16

## 概要

Gunshi フレームワークを使ったマルチアプリ・マルチサブコマンド CLI のアーキテクチャパターンを分析した。このリポジトリは 6 つの CLI アプリ（ccusage, codex, amp, opencode, pi, mcp）を monorepo で管理し、すべてが統一された Gunshi ベースの構造に従う。サブコマンドの定義パターン、引数の共有・拡張手法、設定ファイルとの優先度マージ、出力の二重モード（テーブル/JSON）設計が特に注目に値する。

## 背景にある原則

- **宣言的コマンド定義**: `define()` で名前・説明・引数・実行関数を一つのオブジェクトにまとめ、コマンドの全情報を凝集させる。分散した設定ファイルや手続き的なビルダーチェーンを避けることで、コマンドの全容を一目で把握できる（`apps/ccusage/src/commands/daily.ts:24-237`, `apps/mcp/src/command.ts:22-86` 等の全コマンドで一貫適用）。

- **共有引数のスプレッド拡張**: 共通引数を `sharedArgs` オブジェクトとして切り出し、各コマンドでスプレッド構文により継承・上書きする。OOP の継承ではなくオブジェクトリテラルの合成で柔軟性を確保する（`apps/ccusage/src/_shared-args.ts:19-121`, `apps/ccusage/src/commands/session.ts:24` の除外パターン）。

- **エントリポイントの薄さ**: エントリポイント（`index.ts` / `run.ts`）は Gunshi の `cli()` を呼ぶだけの最小限のボイラープレートとし、ビジネスロジックは各コマンド定義に閉じ込める。全 6 アプリで同一構造を採るため、新規アプリの追加コストが極めて低い（`apps/ccusage/src/commands/index.ts:51-66`, `apps/codex/src/run.ts:16-31` 等）。

- **出力形式の直交性**: `--json` フラグで構造化出力と人間向けテーブル出力を切り替え、`--jq` で後処理パイプラインに接続する。出力形式の選択はデータ取得・計算ロジックとは独立しており、同一データから複数の表現を生成できる。

## 実例と分析

### サブコマンド登録の二層構造

ccusage アプリは 6 つのサブコマンドを持つ最大のアプリである。サブコマンドの登録は `subCommandUnion` タプル配列 → `Map` 変換の二層構造をとる。

```typescript
// apps/ccusage/src/commands/index.ts:24-44
export const subCommandUnion = [
  ["daily", dailyCommand],
  ["monthly", monthlyCommand],
  ["weekly", weeklyCommand],
  ["session", sessionCommand],
  ["blocks", blocksCommand],
  ["statusline", statuslineCommand],
] as const;

export type CommandName = (typeof subCommandUnion)[number][0];

const subCommands = new Map();
for (const [name, command] of subCommandUnion) {
  subCommands.set(name, command);
}
```

`as const` タプルから `CommandName` 型を導出しつつ、Gunshi が要求する `Map` に変換する。他の小規模アプリ（codex, amp, opencode, pi）は Map リテラルで直接登録するが、型の導出が不要なためこの簡素化は妥当である。

### デフォルトコマンドのエイリアス化

全 6 アプリで `mainCommand = dailyCommand` とし、サブコマンド未指定時に daily レポートを表示する。

```typescript
// apps/ccusage/src/commands/index.ts:49
const mainCommand = dailyCommand;

// apps/codex/src/run.ts:14
const mainCommand = dailyCommand;
```

ユーザーが最も頻繁に使うコマンドをデフォルトにすることで、`ccusage` だけで最も一般的な使い方が完結する。

### 共有引数の除外パターン

session コマンドでは `order` 引数を共有引数セットから除外する destructuring パターンを用いている。

```typescript
// apps/ccusage/src/commands/session.ts:23-24
// eslint-disable-next-line ts/no-unused-vars
const { order: _, ...sharedArgs } = sharedCommandConfig.args;
```

共有引数を継承しつつ、特定コマンドで不要な引数を型安全に除外する。インターフェース継承の `Omit<>` ではなく、ランタイム値レベルで除外する点が実用的である。

### 設定ファイルと CLI 引数の優先度マージ

`_config-loader-tokens.ts` は Gunshi の `tokens` を活用して「ユーザーが明示的に指定した引数」を検出し、設定ファイルの値を適切にオーバーライドする。

```typescript
// apps/ccusage/src/_config-loader-tokens.ts:29-42
function extractExplicitArgs(tokens: unknown[]): Record<string, boolean> {
  const explicit: Record<string, boolean> = {};
  for (const token of tokens) {
    if (typeof token === "object" && token !== null) {
      const t = token as { kind?: string; name?: string; };
      if (t.kind === "option" && typeof t.name === "string") {
        explicit[t.name] = true;
      }
    }
  }
  return explicit;
}
```

優先順位は「CLI 引数 > コマンド固有設定 > デフォルト設定 > Gunshi デフォルト」の 4 層。これにより `--json` を明示的に渡した場合のみ設定ファイルの値を上書きし、省略時は設定ファイルの値を維持する。

### Valibot による引数バリデーション

Gunshi の `custom` 型引数と Valibot を組み合わせ、パース時にバリデーションを行う。

```typescript
// apps/ccusage/src/_shared-args.ts:12-14
function parseDateArg(value: string): string {
	return v.parse(filterDateSchema, value);
}

// apps/ccusage/src/_shared-args.ts:20-25
since: {
	type: 'custom',
	short: 's',
	description: 'Filter from date (YYYYMMDD format)',
	parse: parseDateArg,
},
```

statusline コマンドではさらに高度な Valibot パイプラインを使い、string/number のユニオン入力を正規化する（`apps/ccusage/src/commands/statusline.ts:85-103`）。

### npx 対応のバイナリ名フィルタ

全アプリのエントリポイントで、npx 経由実行時にバイナリ名が引数に混入する問題を回避する。

```typescript
// apps/ccusage/src/commands/index.ts:53-57
let args = process.argv.slice(2);
if (args[0] === "ccusage") {
  args = args.slice(1);
}
```

各アプリで固有のバイナリ名（`ccusage`, `ccusage-codex`, `ccusage-amp`, `ccusage-opencode`, `ccusage-pi`, `ccusage-mcp`）に対応する。

### 網羅性チェックの exhaustive パターン

MCP コマンドの switch 文で `satisfies never` を使い、enum の網羅性をコンパイル時に保証する。

```typescript
// apps/mcp/src/command.ts:80-82
default: {
	mcpType satisfies never;
	throw new Error(`Unsupported MCP type: ${mcpType as string}`);
}
```

## コード例

```typescript
// apps/ccusage/src/_shared-args.ts:117-121
// 共有コマンド設定: 引数セットと toKebab を一つにバンドル
export const sharedCommandConfig = {
  args: sharedArgs,
  toKebab: true,
} as const;
```

```typescript
// apps/ccusage/src/commands/daily.ts:24-48
// コマンド定義: sharedCommandConfig をスプレッドし、コマンド固有引数を追加
export const dailyCommand = define({
  name: "daily",
  description: "Show usage report grouped by date",
  ...sharedCommandConfig,
  args: {
    ...sharedCommandConfig.args,
    instances: {
      type: "boolean",
      short: "i",
      description: "Show usage breakdown by project/instance",
      default: false,
    },
    project: {
      type: "string",
      short: "p",
      description: "Filter to specific project name",
    },
  },
  async run(ctx) {/* ... */},
});
```

```typescript
// apps/ccusage/src/commands/index.ts:51-66
// エントリポイント: 薄いブートストラップ
export async function run(): Promise<void> {
  let args = process.argv.slice(2);
  if (args[0] === "ccusage") {
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
// apps/ccusage/src/_config-loader-tokens.ts:222-269
// 4 層優先度マージ: defaults → command config → CLI 明示引数
export function mergeConfigWithArgs<T extends Record<string, unknown>>(
  ctx: ConfigMergeContext<T>,
  config?: ConfigData,
  debug = false,
): T {
  const merged = {} as T;
  // 1. Apply defaults from config (lowest priority)
  if (config.defaults != null) { /* ... */ }
  // 2. Apply command-specific config
  if (commandName != null && config.commands?.[commandName] != null) { /* ... */ }
  // 3. Apply CLI arguments (highest priority) — only explicitly provided ones
  const explicit = extractExplicitArgs(ctx.tokens);
  for (const [key, value] of Object.entries(ctx.values)) {
    if (value != null && explicit[key] === true) {
      (merged as any)[key] = value;
    }
  }
  return merged;
}
```

## パターンカタログ

- **Command パターン** (分類: 振る舞い)
  - 解決する問題: サブコマンドごとに異なるパラメータと実行ロジックを持つ CLI の設計
  - 適用条件: 複数のサブコマンドを持つ CLI ツール
  - コード例: `apps/ccusage/src/commands/daily.ts:24-237` の `define()` がコマンドオブジェクトを生成し、`cli()` のディスパッチャに渡す
  - 注意点: Gunshi の `define()` は Command パターンの宣言的実現であり、Receiver/Invoker の分離は暗黙的

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: daily/monthly/weekly/session の各コマンドが同一の処理フロー（データ読込 → 計算 → 出力分岐）に従いつつ、詳細が異なる
  - 適用条件: 処理の骨格が共通で、ステップの詳細が異なるサブコマンド群
  - コード例: 全コマンドの `run(ctx)` が「config読込 → データ読込 → 空チェック → JSON/テーブル分岐」の骨格に従う
  - 注意点: 基底クラスの継承ではなく、オブジェクトリテラルの合成で実現している

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 出力形式（JSON/テーブル）を実行時に切り替える
  - 適用条件: 同一データに対して複数の出力形式が必要な CLI
  - コード例: `apps/ccusage/src/commands/daily.ts:73-235` の `if (useJson) { ... } else { ... }` 分岐
  - 注意点: 本来は出力ストラテジを抽象化すべきだが、2 分岐のみのため if/else で十分

## Good Patterns

- **共有引数の `as const satisfies Args` パターン**: 共有引数オブジェクトに `as const satisfies Args` を付与することで、Gunshi の型制約を満たしつつリテラル型を保持する。各コマンドがスプレッド時に型推論の恩恵を受けられる。
  ```typescript
  // apps/ccusage/src/_shared-args.ts:113
  } as const satisfies Args;
  ```

- **sharedCommandConfig による引数+オプションのバンドル**: 引数だけでなく `toKebab: true` 等のコマンドオプションも共有設定に含め、スプレッド一発で適用する。設定の散逸を防ぐ。
  ```typescript
  // apps/ccusage/src/_shared-args.ts:118-121
  export const sharedCommandConfig = {
    args: sharedArgs,
    toKebab: true,
  } as const;
  ```

- **enum 選択肢の `as const` 配列 + 型導出**: `CostModes`, `SortOrders` を `as const` 配列で定義し、同じ配列を Gunshi の `choices` と TypeScript の型導出の両方に使う。単一情報源の原則を守る。
  ```typescript
  // apps/ccusage/src/_types.ts:140-145
  export const CostModes = ['auto', 'calculate', 'display'] as const;
  export type CostMode = TupleToUnion<typeof CostModes>;
  // apps/ccusage/src/_shared-args.ts:43-44
  default: 'auto' as const satisfies CostMode,
  choices: CostModes,
  ```

- **`--jq` による暗黙的 `--json` の活性化**: `--jq` フラグが指定されると自動的に JSON モードになる。ユーザーが `--json --jq '.totals'` と冗長に指定する必要がない。
  ```typescript
  // apps/ccusage/src/commands/daily.ts:73
  const useJson = Boolean(mergedOptions.json) || mergedOptions.jq != null;
  ```

## Anti-Patterns / 注意点

- **コマンド間の出力ロジック重複**: daily, monthly, weekly, session コマンドのテーブル出力ロジック（テーブル作成 → 行追加 → 空行 → 合計行 → compact モード案内）がほぼ同一のまま各ファイルにコピーされている。変更時に全コマンドを同期する必要がある。
  ```typescript
  // Bad: 各コマンドに重複する出力ロジック
  // apps/ccusage/src/commands/daily.ts:137-234
  // apps/ccusage/src/commands/monthly.ts:96-152
  // apps/ccusage/src/commands/weekly.ts:106-158
  // すべて同じ構造: logger.box → createTable → for loop → addEmptySeparator → totalsRow → compact check

  // Better: 出力テンプレート関数を共通化
  // function renderUsageTable(config: { header: string, data: Row[], ... }) { ... }
  ```

- **アプリ間のエントリポイント重複**: 全 6 アプリの `run()` 関数が npx フィルタ以外まったく同一構造。共通化すれば新規アプリ追加時のボイラープレートを排除できる。
  ```typescript
  // Bad: 各アプリで同じコード
  // apps/codex/src/run.ts, apps/amp/src/run.ts, apps/opencode/src/run.ts ...
  // すべて: argv.slice(2) → バイナリ名フィルタ → cli(args, mainCommand, opts)

  // Better: 共通 createCliRunner(binaryName, mainCommand, subCommands) を提供
  ```

## 導出ルール

- `[MUST]` CLI のサブコマンド定義は宣言的に一箇所で完結させ、名前・引数・説明・実行関数を同じオブジェクトに凝集させる
  - 根拠: 全 6 アプリ・20 以上のコマンドが `define({ name, description, args, run })` で統一され、コマンドの全容が一目で把握できている（`apps/ccusage/src/commands/*.ts`）

- `[MUST]` enum 的な CLI 引数の選択肢は `as const` 配列で一度だけ定義し、型とランタイム値の両方をその配列から導出する（単一情報源の原則）
  - 根拠: `CostModes`, `SortOrders`, `MCP_TYPE_CHOICES` が配列定義 → `choices` オプション＋型導出の両方に使われ、選択肢の不整合を型レベルで防いでいる（`apps/ccusage/src/_types.ts:140-155`）

- `[SHOULD]` 複数サブコマンドで共通する引数はオブジェクトリテラルとして分離し、スプレッド構文で継承・拡張する。不要な引数は destructuring で除外する
  - 根拠: `sharedArgs` / `sharedCommandConfig` のスプレッド拡張と、session コマンドの `{ order: _, ...sharedArgs }` 除外パターンにより、コマンド間の引数定義の重複を排除しつつ柔軟性を維持している（`apps/ccusage/src/_shared-args.ts`, `apps/ccusage/src/commands/session.ts:24`）

- `[SHOULD]` CLI ツールに設定ファイルを導入する場合、「CLI 明示引数 > コマンド固有設定 > グローバルデフォルト > フレームワークデフォルト」の優先度階層を設け、CLI パーサーの tokens から「明示的に渡された引数」を判定する
  - 根拠: `mergeConfigWithArgs()` が Gunshi の tokens を解析して明示引数を検出し、未指定の引数は設定ファイルの値を保持する。これにより `ccusage daily` と `ccusage daily --json` で設定ファイルの値が正しく反映される（`apps/ccusage/src/_config-loader-tokens.ts:222-269`）

- `[SHOULD]` 最頻利用のサブコマンドをデフォルトコマンドに設定し、サブコマンド未指定時の挙動を明確にする
  - 根拠: 全 6 アプリが `mainCommand = dailyCommand` として、引数なし実行でも有用な出力を返す（`apps/ccusage/src/commands/index.ts:49`）

- `[AVOID]` サブコマンド間で同一の出力テンプレートロジック（テーブル構築 → 合計行 → compact 案内）をコピーペーストすること。共通テンプレート関数として抽出し、コマンド固有部分のみをパラメータ化する
  - 根拠: daily/monthly/weekly/session の 4 コマンドで出力ロジックがほぼ同一にもかかわらず各ファイルに展開されており、compact モード案内の追加時に全ファイルの同期が必要になった

## 適用チェックリスト

- [ ] サブコマンドの定義が宣言的オブジェクト（名前・引数・説明・実行関数を凝集）になっているか
- [ ] 複数コマンドで共通する引数が一箇所のオブジェクトに切り出され、スプレッドで継承されているか
- [ ] enum 選択肢が `as const` 配列で定義され、型と `choices` の両方に使われているか（重複定義していないか）
- [ ] エントリポイントが薄いブートストラップのみになっているか（ビジネスロジックが混入していないか）
- [ ] 設定ファイルと CLI 引数の優先度が明確に定義・実装されているか
- [ ] `--json` フラグでの構造化出力が全コマンドで一貫して実装されているか
- [ ] 最頻利用コマンドがデフォルトコマンドとして設定されているか
- [ ] 出力ロジックのコマンド間重複がテンプレート関数で共通化されているか
