# プロジェクト構造

> リポジトリ: ryoppippi/ccusage
> 分析日: 2026-02-16

## 概要

ccusage は pnpm workspace による monorepo で、CLI ツール群（apps/）と共有パッケージ（packages/）を分離している。各 CLI は異なる AI ツール（Claude Code, Codex, OpenCode, Amp, Pi-agent）の使用量を追跡するが、共通の pricing ロジック・テーブル表示・ログ機構を `packages/` 経由で共有する。特筆すべきは「全 apps を devDependencies-only のバンドル CLI として設計する」という一貫した方針と、pnpm catalogs による依存バージョン一元管理、そして `_` prefix による内部ファイルの明示的なビルド除外パターンである。

## 背景にある原則

- **バンドル前提の依存管理**: apps 配下のパッケージは tsdown でバンドルされて配布されるため、ランタイム依存を `devDependencies` に置く。バンドラがコードを含めるため `dependencies` に書く必要がなく、公開パッケージの依存ツリーを空にできる。この方針を CLAUDE.md に明文化し、AI エージェントにも一貫性を守らせている（`CLAUDE.md:17-19`）。

- **catalog による集中バージョン管理**: `pnpm-workspace.yaml` の `catalogs` セクションで全依存のバージョンを用途別（build, runtime, testing, lint, docs, release, types）に分類し、各パッケージの package.json では `catalog:runtime` のようなラベル参照のみ記述する。これにより、バージョン不整合のリスクを構造的に排除している。

- **公開 API 面の最小化**: 内部ファイルに `_` prefix を付けてビルドから除外し、package.json の `exports` フィールドで公開するモジュールを限定する。加えて CLAUDE.md に「使われている定数だけを export する」旨を明記し、過剰な公開を防いでいる。

- **階層的 AI コンテキスト**: ルート CLAUDE.md に monorepo 全体のルールを、各パッケージの CLAUDE.md にパッケージ固有の仕様を書き、`AGENTS.md -> CLAUDE.md` シンボリックリンクで OpenAI Codex にも同じコンテキストを提供する。AI エージェントがどのディレクトリで作業しても、適切な粒度の指示を得られる設計になっている。

## 実例と分析

### apps/ と packages/ の分離戦略

`apps/` には独立して公開・配布される CLI ツールが配置され、`packages/` にはモノレポ内部でのみ使われる共有ライブラリが配置されている。

| ディレクトリ        | パッケージ名        | 公開     | 役割                    |
| ------------------- | ------------------- | -------- | ----------------------- |
| `apps/ccusage`      | `ccusage`           | npm 公開 | Claude Code 使用量 CLI  |
| `apps/codex`        | `@ccusage/codex`    | npm 公開 | Codex CLI               |
| `apps/opencode`     | `@ccusage/opencode` | npm 公開 | OpenCode CLI            |
| `apps/amp`          | `@ccusage/amp`      | npm 公開 | Amp CLI                 |
| `apps/pi`           | `@ccusage/pi`       | npm 公開 | Pi-agent CLI            |
| `apps/mcp`          | `@ccusage/mcp`      | npm 公開 | MCP サーバー            |
| `packages/internal` | `@ccusage/internal` | private  | pricing, logger, format |
| `packages/terminal` | `@ccusage/terminal` | private  | テーブル表示, TUI       |
| `docs/`             | `@ccusage/docs`     | private  | VitePress ドキュメント  |

依存の方向は厳密に一方向: `apps/ -> packages/` であり、`packages/` 間の依存は存在しない。`apps/mcp` だけが他の apps（`ccusage`, `@ccusage/codex`）に依存するが、これは MCP サーバーが各 CLI をサブプロセスとして呼び出す構成のためである。

### devDependencies-only バンドル CLI パターン

全 apps が `devDependencies` のみでランタイム依存を管理する。唯一の例外は `apps/mcp` で、これは他の workspace パッケージを `dependencies` に持つ。これは MCP サーバーが他の CLI バイナリのパスを解決する必要があるためと推測される。

### pnpm catalogs による依存カテゴリ管理

`pnpm-workspace.yaml` で 8 つのカタログを定義し、全パッケージで `catalog:<name>` 記法を使用する。`catalogMode: strict` が有効なため、カタログ外のバージョン指定はエラーになる。

カタログの分類: `build`, `docs`, `lint`, `llm-docs`, `release`, `runtime`, `testing`, `types`

### `_` prefix による内部ファイル規約

各 app 内のソースファイルは、公開される（バンドルのエントリポイントとなる）ファイルと、内部でのみ使われるファイルに分けられている。内部ファイルは `_` prefix で命名され、tsdown の設定で明示的に除外される。

ccusage app の例:

- 公開: `index.ts`, `calculate-cost.ts`, `data-loader.ts`, `debug.ts`, `logger.ts`
- 内部: `_types.ts`, `_consts.ts`, `_utils.ts`, `_macro.ts`, `_pricing-fetcher.ts` 等

### 階層的 CLAUDE.md と AGENTS.md シンボリックリンク

```
ccusage/
  CLAUDE.md          # ルート: monorepo 全体のルール（310行）
  AGENTS.md -> CLAUDE.md  # Codex 用シンボリックリンク
  apps/ccusage/
    CLAUDE.md        # パッケージ固有の開発ガイド
    AGENTS.md -> CLAUDE.md
  apps/codex/
    CLAUDE.md        # Codex 固有のログ仕様・トークン解説
  packages/internal/
    CLAUDE.md        # 内部パッケージの使い方・pricing 実装注意事項
  docs/
    CLAUDE.md        # ドキュメントサイト固有のガイド
    AGENTS.md -> CLAUDE.md
```

各 CLAUDE.md はそのスコープに特化した情報を持ち、パッケージ固有の開発コマンド・アーキテクチャ・注意事項を記述している。

## コード例

```typescript
// apps/ccusage/tsdown.config.ts:4-9
// _ prefix ファイルをビルドから除外する設定
export default defineConfig({
	entry: [
		'./src/*.ts',
		'!./src/**/*.test.ts', // Exclude test files
		'!./src/_*.ts', // Exclude internal files with underscore prefix
	],
```

```typescript
// apps/ccusage/package.json:69-104 (抜粋)
// 全ランタイム依存が devDependencies + catalog 参照
"devDependencies": {
	"@ccusage/internal": "workspace:*",
	"@ccusage/terminal": "workspace:*",
	"gunshi": "catalog:runtime",
	"valibot": "catalog:runtime",
	"vitest": "catalog:testing",
	"tsdown": "catalog:build",
}
```

```yaml
# pnpm-workspace.yaml:6-8
# strict モードで catalog 外のバージョン指定を禁止
catalogMode: strict

catalogs:
  build:
    tsdown: ^0.16.6
  runtime:
    gunshi: ^0.26.3
    valibot: ^1.1.0
```

```typescript
// packages/internal/package.json:7-13
// 公開 API を exports フィールドで厳密に制限
"exports": {
	"./pricing": "./src/pricing.ts",
	"./pricing-fetch-utils": "./src/pricing-fetch-utils.ts",
	"./logger": "./src/logger.ts",
	"./format": "./src/format.ts",
	"./constants": "./src/constants.ts"
},
```

```typescript
// apps/ccusage/package.json:18-25
// 開発時は src を直接参照、公開時は dist を参照する二重 exports
"exports": {
	".": "./src/index.ts",
	"./calculate-cost": "./src/calculate-cost.ts",
},
"publishConfig": {
	"exports": {
		".": "./dist/index.js",
		"./calculate-cost": "./dist/calculate-cost.js",
	}
},
```

## パターンカタログ

- **Facade パターン** (構造)
  - 解決する問題: 複数の CLI ツールが共通のロジック（pricing, logging, table rendering）を必要とするが、各ツールのデータ形式は異なる
  - 適用条件: 共有ロジックが複数の消費者から利用され、各消費者が異なるドメイン型を持つ場合
  - コード例: `packages/internal/src/pricing.ts` が LiteLLM API の複雑さを隠蔽し、`calculateCostFromTokens()` という単一インタフェースを提供
  - 注意点: Facade が肥大化すると結局 God Object になる。ccusage では pricing / logger / format / constants と機能別にモジュールを分割している

- **Strategy パターン** (振る舞い)
  - 解決する問題: 各 CLI app が異なるデータソース（Claude JSONL, Codex sessions, Amp threads 等）を持つが、同じ集計・表示フローを使いたい
  - 適用条件: 入力データの形式は異なるが、処理パイプライン（ロード -> 集計 -> 表示）が共通
  - コード例: 各 app に `data-loader.ts`, `_types.ts`, `commands/daily.ts` が存在し、共通の `@ccusage/terminal` で表示
  - 注意点: 型定義（`_types.ts`）が各 app で重複しているが、データ構造が本質的に異なるため意図的な重複と考えられる

## Good Patterns

- **publishConfig による開発/公開の二重 exports**: `exports` にはソース `.ts` を指定して開発時の DX を保ち、`publishConfig.exports` で公開時のビルド済み `.js` を指定する。monorepo 内では TypeScript ソースを直接参照でき、npm 公開時には自動的にビルド成果物に切り替わる。

```json
// apps/ccusage/package.json:18-48
"exports": { ".": "./src/index.ts" },
"publishConfig": { "exports": { ".": "./dist/index.js" } }
```

- **pnpm catalogs + strict mode による依存バージョン一元化**: `catalogMode: strict` を有効にすることで、カタログ外のバージョン指定を構造的に禁止する。用途別カタログ（runtime, build, testing 等）で意味的なグループ化も実現している。

```yaml
# pnpm-workspace.yaml:6
catalogMode: strict
```

- **supply chain attack 対策の設定群**: `strictDepBuilds`, `blockExoticSubdeps`, `trustPolicy: no-downgrade`, 明示的な `allowBuilds` で、サプライチェーン攻撃への防御を設定レベルで実装している。

```yaml
# pnpm-workspace.yaml:79-89
strictDepBuilds: true
blockExoticSubdeps: true
trustPolicy: no-downgrade
allowBuilds:
  esbuild: true
  sharp: true
```

- **`preinstall` ガードによるパッケージマネージャ強制**: `"preinstall": "npx only-allow pnpm"` でプロジェクトが必ず pnpm で管理されることを保証する。

## Anti-Patterns / 注意点

- **apps 間の型定義重複**: `_types.ts` が各 app（ccusage, codex, amp, pi）に存在し、`TokenUsageDelta`, `DailyUsageSummary` 等の類似型が個別に定義されている。データ構造が本質的に異なる（Codex は `reasoningOutputTokens` を持ち、Amp は `credits` を持つ）ため完全な共通化は難しいが、共通部分の抽出は検討に値する。

```typescript
// Bad: 各 app で類似の型を個別定義
// apps/codex/src/_types.ts
export type TokenUsageDelta = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number; // Codex 固有
  totalTokens: number;
};

// apps/amp/src/_types.ts
export type TokenUsageDelta = {
  inputTokens: number;
  cacheCreationInputTokens: number; // Amp 固有
  cacheReadInputTokens: number; // Amp 固有
  outputTokens: number;
  totalTokens: number;
};
```

```typescript
// Better: ジェネリックな基底型を packages/internal に定義
interface BaseTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}
// 各 app が拡張
interface CodexTokenUsage extends BaseTokenUsage {
  cachedInputTokens: number;
  reasoningOutputTokens: number;
}
```

- **MCP サーバーの CLI サブプロセス呼び出し**: `apps/mcp` は他の CLI をサブプロセスとして呼び出し、JSON 出力をパースするアーキテクチャをとっている。プロセス生成のオーバーヘッドやエラーハンドリングの複雑さがあるが、各 CLI の独立性を保つトレードオフとして意図的に選択されている。

## 導出ルール

- `[MUST]` バンドル CLI として配布する monorepo app では、ランタイム依存を `devDependencies` に配置し、バンドラに包含させる。`dependencies` には配置しない
  - 根拠: ccusage の全 apps が devDependencies-only 方針を採用し、CLAUDE.md にも明記している（`CLAUDE.md:17-19`）。公開パッケージの依存ツリーが空になり、消費者側の依存衝突を回避できる

- `[MUST]` monorepo の依存バージョンは一元管理する仕組み（pnpm catalogs, Renovate config 等）で統一し、パッケージごとの個別バージョン指定を禁止する
  - 根拠: `pnpm-workspace.yaml` で `catalogMode: strict` を設定し、カタログ外のバージョン指定をエラーにしている。8 カテゴリのカタログで全依存を管理

- `[SHOULD]` 内部ファイル（ビルド成果物に含めないモジュール）には命名規約（`_` prefix 等）を設け、ビルド設定で機械的に除外する
  - 根拠: tsdown.config.ts で `!./src/_*.ts` パターンにより、`_` prefix ファイルを自動除外。命名とビルド設定の一致により、人為的な除外漏れを防止

- `[SHOULD]` monorepo の各パッケージに AI エージェント用コンテキストファイル（CLAUDE.md 等）を配置し、作業スコープに応じた粒度の指示を提供する。異なる AI ツール用のファイルはシンボリックリンクで統一する
  - 根拠: ルート + 各パッケージに計 10 個の CLAUDE.md を配置し、AGENTS.md はシンボリックリンクで CLAUDE.md を参照。パッケージ固有の仕様・注意事項を AI に伝達

- `[SHOULD]` package.json の `exports` フィールドで開発時ソース参照と公開時ビルド成果物参照を `publishConfig` で切り替える
  - 根拠: `apps/ccusage/package.json` で `exports` に `.ts` ソース、`publishConfig.exports` に `.js` ビルド成果物を指定し、開発 DX と公開品質を両立

- `[SHOULD]` pnpm の supply chain attack 対策設定（`strictDepBuilds`, `blockExoticSubdeps`, `trustPolicy`, 明示的 `allowBuilds`）を有効にする
  - 根拠: `pnpm-workspace.yaml:79-89` でサプライチェーン攻撃への防御を設定レベルで実装

- `[AVOID]` monorepo 内の共有パッケージ（packages/）間に相互依存を作ること。依存の方向は apps -> packages の一方向に保つ
  - 根拠: `packages/internal` と `packages/terminal` は互いに依存せず、全 apps が一方向に参照する構造を維持している

## 適用チェックリスト

- [ ] monorepo のパッケージ分割が「公開単位（apps）」と「共有ライブラリ（packages）」で明確に分かれているか
- [ ] バンドル CLI として配布する app のランタイム依存が `devDependencies` に配置されているか
- [ ] 依存バージョンの一元管理（pnpm catalogs, yarn constraints 等）が有効になっているか
- [ ] 内部ファイルの命名規約があり、ビルド設定で機械的に除外されているか
- [ ] package.json の `exports` フィールドで公開 API が明示的に制限されているか
- [ ] AI エージェント用コンテキストファイルがパッケージごとに配置されているか
- [ ] packages/ 間の依存が一方向になっているか（循環依存がないか）
- [ ] supply chain attack 対策（build script 制限、信頼ポリシー等）が設定されているか
- [ ] `preinstall` スクリプトでパッケージマネージャが強制されているか
