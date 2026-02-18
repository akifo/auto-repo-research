# Code Organization

> リポジトリ: ryoppippi/ccusage
> 分析日: 2026-02-16

## 概要

ccusage はモノレポ構成の CLI ツール群であり、ファイル命名規則（アンダースコアプレフィックス）、package.json の `exports` フィールド、バンドラ設定（tsdown）の三層で内部/外部の境界を厳密に制御している。この三層境界制御は「命名規則を人間が守る」だけでなく「ツールチェーンが強制する」仕組みになっており、CLI ツールのライブラリ公開における公開 API 表面積の最小化手法として注目に値する。

## 背景にある原則

- **命名規則による視覚的境界**: アンダースコアプレフィックス（`_types.ts`, `_utils.ts`, `_consts.ts`）でファイル単位の可視性を表現し、開発者がファイルリストを見た瞬間に内部/外部を判別できるようにしている。Python の `_private` 命名規則と同じ発想だが、TypeScript ではランタイムでのアクセス制限はないため、ビルド設定で強制する必要がある（`apps/ccusage/tsdown.config.ts:8` の `!./src/_*.ts`）。

- **ビルド設定による強制的な境界**: 命名規則は紳士協定に過ぎないため、tsdown の entry 設定で `_` プレフィックスファイルをバンドルエントリから除外し、外部パッケージへの型・値の漏洩を構造的に防止している。命名規則 + ビルド設定の組み合わせにより「うっかり公開」を防いでいる。

- **Subpath exports によるパッケージ境界**: package.json の `exports` フィールドで公開するモジュールを明示的に列挙し、消費者側がアクセスできるパスを制限している。`ccusage` パッケージは `.`, `./calculate-cost`, `./data-loader`, `./debug`, `./logger` の 5 エントリのみを公開しており、内部の 12 以上の `_` プレフィックスファイルは一切外部から到達できない。

- **devDependencies-only の依存管理**: CLAUDE.md に「All projects under `apps/` ship as bundled CLIs/binaries. Treat their runtime dependencies as bundled assets: list everything in each app's `devDependencies`」と明記されており、バンドル前提の CLI アプリでは `dependencies` を使わないことで、消費者のインストールサイズを最小化している。

## 実例と分析

### アンダースコアプレフィックスによるファイル分類

ccusage アプリ（`apps/ccusage/src/`）では、20 以上のソースファイルが以下の 2 カテゴリに明確に分かれている。

**公開ファイル（プレフィックスなし）**: `index.ts`, `data-loader.ts`, `calculate-cost.ts`, `debug.ts`, `logger.ts`
これらは package.json の `exports` にマッピングされ、`@ccusage/mcp` パッケージ等から `import { getClaudePaths } from 'ccusage/data-loader'` のように参照される。

**内部ファイル（`_` プレフィックス）**: `_types.ts`, `_consts.ts`, `_utils.ts`, `_macro.ts`, `_date-utils.ts`, `_session-blocks.ts`, `_shared-args.ts`, `_token-utils.ts`, `_pricing-fetcher.ts`, `_jq-processor.ts`, `_daily-grouping.ts`, `_project-names.ts`, `_json-output-types.ts`, `_config-loader-tokens.ts`
これらはアプリ内部でのみ使われ、公開ファイルや commands/ ディレクトリのファイルから参照されるが、パッケージ外部には公開されない。

この命名規則は全アプリで一貫しており、`apps/codex/src/` にも `_consts.ts`, `_types.ts`, `_macro.ts`, `_shared-args.ts` が存在する。

### 三層境界制御の実装

**第 1 層: ファイル命名規則** -- `_` プレフィックスが開発者への視覚的シグナル
**第 2 層: tsdown entry 設定** -- `!./src/_*.ts` で `_` ファイルをビルドエントリから除外
**第 3 層: package.json exports** -- 公開するサブパスを明示的に列挙

この 3 層は冗長に見えるが、それぞれ異なる問題を解決している。第 1 層は開発時の認知負荷軽減、第 2 層は型定義（`.d.ts`）の漏洩防止、第 3 層は Node.js ランタイムでのモジュール解決制限。

### パッケージ間の依存グラフ

```
packages/internal (shared: pricing, logger, format, constants)
packages/terminal (shared: table rendering, terminal utilities)
     ↑                    ↑
     |                    |
apps/ccusage ─────────────┘ (主CLI, exports 5 modules)
apps/codex   ─────────────┘ (Codex CLI)
apps/amp     ─────────────┘ (Amp CLI)
apps/pi      ─────────────┘ (Pi CLI)
apps/opencode ────────────┘ (OpenCode CLI)
     ↑
apps/mcp  (ccusage の公開 API を消費)
```

`packages/internal` と `packages/terminal` は共通ユーティリティを subpath exports で公開し、各アプリが必要なモジュールだけを選択的に import している。

### commands/ ディレクトリの構造パターン

各アプリの `commands/` ディレクトリは、CLI サブコマンドに 1:1 対応するファイルを配置し、`commands/index.ts` がルーティングを集約する。commands/ 内でも `_session_id.ts` のようにアンダースコアプレフィックスでヘルパーを分離している。

## コード例

```typescript
// apps/ccusage/tsdown.config.ts:4-9
// アンダースコアプレフィックスファイルをビルドエントリから除外
export default defineConfig({
	entry: [
		'./src/*.ts',
		'!./src/**/*.test.ts', // Exclude test files
		'!./src/_*.ts', // Exclude internal files with underscore prefix
	],
```

```typescript
// apps/ccusage/package.json:18-25
// 公開 API を 5 エントリに限定
"exports": {
	".": "./src/index.ts",
	"./calculate-cost": "./src/calculate-cost.ts",
	"./data-loader": "./src/data-loader.ts",
	"./debug": "./src/debug.ts",
	"./logger": "./src/logger.ts",
	"./package.json": "./package.json"
},
```

```typescript
// apps/mcp/src/mcp.ts:11, apps/mcp/src/command.ts:1,4-5
// 外部パッケージからは公開 API のみ参照可能
import type { LoadOptions } from "ccusage/data-loader";
import { getClaudePaths } from "ccusage/data-loader";
import { logger } from "ccusage/logger";
```

```typescript
// packages/internal/package.json:7-13
// 共有パッケージも subpath exports で公開範囲を限定
"exports": {
	"./pricing": "./src/pricing.ts",
	"./pricing-fetch-utils": "./src/pricing-fetch-utils.ts",
	"./logger": "./src/logger.ts",
	"./format": "./src/format.ts",
	"./constants": "./src/constants.ts"
},
```

```typescript
// apps/ccusage/src/logger.ts:10-22
// 公開ファイルが共有パッケージをラップし、アプリ固有の設定を注入
import { createLogger, log as internalLog } from "@ccusage/internal/logger";
import { name } from "../package.json";

export const logger = createLogger(name);
export const log = internalLog;
```

```typescript
// packages/internal/src/pricing.ts:14
// 内部定数は export しない（CLAUDE.md のルールに準拠）
const DEFAULT_TIERED_THRESHOLD = 200_000;
```

## パターンカタログ

- **Facade パターン** (分類: 構造)
  - 解決する問題: 内部の複雑なモジュール群を、外部消費者に対してシンプルなインターフェースで提供する
  - 適用条件: ライブラリとしても利用される CLI アプリケーション
  - コード例: `apps/ccusage/src/logger.ts` が `@ccusage/internal/logger` をラップして公開
  - 注意点: Facade が薄すぎると存在意義が問われる。アプリ固有の設定注入（パッケージ名タグ付け等）があるから正当化される

- **Module パターン** (分類: 構造)
  - 解決する問題: 内部実装の詳細を隠蔽しつつ、必要な機能だけを公開する
  - 適用条件: 複数のモジュールを持つパッケージで、公開 API を制限したい場合
  - コード例: `apps/ccusage/package.json` の `exports` フィールドと `tsdown.config.ts` の entry 除外設定
  - 注意点: Node.js の `exports` フィールドは TypeScript の型解決にも影響するため、`publishConfig.exports` で dist パスへの変換が必要

## Good Patterns

- **命名規則 + ビルド設定のダブルガード**: `_` プレフィックスは開発者への視覚的シグナルに過ぎないが、`tsdown.config.ts` で `!./src/_*.ts` としてビルドエントリから除外することで、機械的に境界を強制している。命名規則単独では「知らない開発者がうっかり import する」リスクがあるが、ビルド時エラーで検出できる。

```typescript
// apps/ccusage/tsdown.config.ts:8
'!./src/_*.ts', // Exclude internal files with underscore prefix
```

- **Subpath exports による精密な API 表面制御**: package.json の `exports` で公開パスを列挙することで、パッケージ消費者が内部モジュールに直接アクセスすることを Node.js レベルで防止している。`publishConfig.exports` で開発時（`./src/`）とビルド後（`./dist/`）のパスを分離している点も巧妙。

```json
// apps/ccusage/package.json:18-25 (開発時)
"exports": {
    ".": "./src/index.ts",
    "./data-loader": "./src/data-loader.ts"
}

// apps/ccusage/package.json:39-46 (公開時)
"publishConfig": {
    "exports": {
        ".": "./dist/index.js",
        "./data-loader": "./dist/data-loader.js"
    }
}
```

- **共通パッケージの機能別 subpath exports**: `@ccusage/internal` は単一の index.ts ではなく、`./pricing`, `./logger`, `./format`, `./constants` のように機能別サブパスで公開している。消費者は必要な機能だけを import でき、tree-shaking の効率が向上する。

```typescript
// apps/codex/src/token-utils.ts:2
import { formatCurrency, formatTokens } from "@ccusage/internal/format";
// pricing は import しない -> バンドルサイズに含まれない
```

- **CLAUDE.md での export ルール明文化**: 「Only export constants, functions, and types that are actually used by other modules」「Internal/private constants that are only used within the same file should NOT be exported」という原則を CLAUDE.md に明記し、AI コーディングアシスタントにも適用させている。

## Anti-Patterns / 注意点

- **内部ファイル間の循環参照リスク**: `_` プレフィックスファイル同士の参照関係が深く、`_date-utils.ts` -> `_consts.ts`, `_types.ts`, `_utils.ts` のように複数の内部ファイルを横断的に参照している。内部ファイル群の依存グラフが複雑化すると、リファクタリング時の影響範囲把握が困難になる。

```typescript
// Bad: 内部ファイルが 3 つ以上の他の内部ファイルに依存
// apps/ccusage/src/data-loader.ts (公開ファイルだが多数の内部依存を持つ)
import { ... } from './_consts.ts';
import { ... } from './_date-utils.ts';
import { PricingFetcher } from './_pricing-fetcher.ts';
import { identifySessionBlocks } from './_session-blocks.ts';
import { ... } from './_types.ts';
import { unreachable } from './_utils.ts';

// Better: 中間的な集約モジュールで依存を整理
// apps/ccusage/src/_internals.ts として re-export を集約する
```

- **`commands/` 内から `_` ファイルへの直接参照**: commands/ ディレクトリ内のファイルが `../_consts.ts` や `../_shared-args.ts` を直接 import しており、commands/ が内部実装詳細を知りすぎている。公開ファイル（`data-loader.ts` 等）を経由した間接参照にすると、commands/ の内部実装への依存が減る。ただし、これは CLI アプリのように外部消費者がいない場合は許容される設計判断でもある。

## 導出ルール

- `[MUST]` パッケージの公開 API は package.json の `exports` フィールドで明示的に列挙し、内部モジュールへの直接アクセスを禁止する
  - 根拠: ccusage は `exports` に 5 エントリのみ列挙し、14 の内部ファイルへのアクセスを構造的に防止している（`apps/ccusage/package.json:18-25`）

- `[MUST]` 内部ファイルを示す命名規則を採用したら、ビルド設定でもその規則を強制する（命名規則だけでは紳士協定に過ぎない）
  - 根拠: tsdown の entry 設定で `!./src/_*.ts` を指定し、`_` プレフィックスファイルがビルド成果物に含まれないことを機械的に保証している（`apps/ccusage/tsdown.config.ts:8`）

- `[SHOULD]` バンドルされる CLI アプリの runtime 依存は全て `devDependencies` に記載し、`dependencies` は空にする
  - 根拠: CLAUDE.md に「list everything in each app's `devDependencies` (never `dependencies`) so the bundler owns the runtime payload」と明記されており、消費者のインストールサイズを最小化している

- `[SHOULD]` 共有パッケージは単一エントリポイントではなく、機能別の subpath exports で公開する（`./pricing`, `./logger` 等）
  - 根拠: `@ccusage/internal` は 5 つのサブパスを個別に公開しており、消費者は必要な機能だけを import できる（`packages/internal/package.json:8-13`）

- `[SHOULD]` エクスポートは「実際に他モジュールから使われているもの」のみに限定し、公開 API 表面積を最小化する
  - 根拠: CLAUDE.md のルール「Only export constants, functions, and types that are actually used by other modules」が全コード変更時の原則として適用されている

- `[AVOID]` 内部実装の命名規則（`_` プレフィックス等）をビルド設定なしで運用すること。命名規則は破られる前提で、ツールチェーンによる強制を組み合わせる
  - 根拠: ccusage では命名規則（第 1 層）、tsdown entry 除外（第 2 層）、package.json exports（第 3 層）の三層で冗長に保護している

## 適用チェックリスト

- [ ] package.json に `exports` フィールドを追加し、公開するモジュールパスを明示的に列挙しているか
- [ ] 内部ファイルを示す命名規則（`_` プレフィックス、`internal/` ディレクトリ等）を定め、チーム全体で統一しているか
- [ ] ビルドツールの設定で内部ファイルがエントリポイントやビルド成果物から除外されているか
- [ ] `publishConfig.exports` で開発時パスとビルド後パスの変換を定義しているか
- [ ] バンドル前提のアプリで runtime 依存を `devDependencies` に寄せているか
- [ ] 共有パッケージが機能別 subpath exports を提供し、消費者が必要な機能だけを import できるか
- [ ] エクスポートルール（公開 API 最小化の原則）がドキュメント化され、AI ツールやレビューで参照されているか
