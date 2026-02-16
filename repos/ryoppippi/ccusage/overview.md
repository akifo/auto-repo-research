# ryoppippi/ccusage

> URL: https://github.com/ryoppippi/ccusage
> Stars: 10.7k | 言語: TypeScript | ライセンス: NOASSERTION | 分析日: 2026-02-16

## サマリー

ccusage は pnpm workspace monorepo 上に構築された CLI ツール群であり、バンドル前提の devDependencies-only 戦略、Valibot Branded Types + Result 型による型安全なデータパイプライン、そして 10 個の階層的 CLAUDE.md による AI ファーストの開発環境という 3 つの柱が、120 ファイル規模のプロジェクト全体を一貫して貫いている。特に「正しさの境界を型・スキーマ・ビルド設定の三層で機械的に強制する」設計哲学と、safeParse + サイレントスキップによるレジリエンス設計は、他のプロジェクトに即座に応用できる実践知の宝庫である。

## 技術スタック

- **言語**: TypeScript (Node.js / Bun)
- **フレームワーク**: Gunshi (CLI), Hono (MCP server)
- **ビルド**: tsdown, pnpm workspaces
- **テスト**: Vitest (in-source testing), fs-fixture
- **パッケージマネージャ**: pnpm (catalogs, strict mode)
- **バリデーション**: valibot, zod
- **エラーハンドリング**: @praha/byethrow (Result型)
- **リンター/フォーマッター**: ESLint (@ryoppippi/eslint-config), oxfmt
- **スペルチェック**: typos

## 分析した視点

| # | 視点 | ファイル | 概要 |
| - | ---- | -------- | ---- |
| 1 | project-structure | project-structure.md | pnpm workspace monorepo で apps/packages 分離、devDependencies-only 戦略、pnpm catalogs strict、_ prefix 内部ファイル規約 |
| 2 | architecture | architecture.md | 扇形依存の一方向アーキテクチャ、4段データパイプライン、Branded 型・Result 型・in-source testing の一貫適用 |
| 3 | design-philosophy | design-philosophy.md | バンドル前提の devDeps 集約、AI ファーストの階層的 CLAUDE.md、スキーマ駆動型定義、safeParse + サイレントスキップ |
| 4 | type-system-patterns | type-system-patterns.md | Valibot brand() で 12 種のドメインプリミティブを型安全化、ファクトリ関数 + スキーマ型導出、Result パイプライン |
| 5 | abstraction-patterns | abstraction-patterns.md | 表現層・インフラ層を共有パッケージに集約しデータ変換層はアプリ固有に保持、ビルド時マクロ、意図的重複の管理 |
| 6 | code-organization | code-organization.md | _ prefix 命名 + tsdown entry 除外 + exports 三層で API 境界を制御、subpath exports で機能別公開 |
| 7 | error-handling-idioms | error-handling-idioms.md | Result.try/pipe/unwrap の 3 イディオムで統一、isFailure + continue の早期スキップ、境界でのみ try-catch 許容 |
| 8 | testing-practices | testing-practices.md | 全ファイルで in-source testing、await using + createFixture で宣言的フィクスチャ + 自動クリーンアップ |
| 9 | cli-framework-patterns | cli-framework-patterns.md | Gunshi define() による宣言的コマンド定義、共有引数のスプレッド拡張、tokens 活用の 4 層設定優先度マージ |
| 10 | build-and-tooling | build-and-tooling.md | tsdown + publint + unused 品質ゲート統合、unplugin-macros ビルド時データ埋め込み、DCE-only minify |
| 11 | data-processing-patterns | data-processing-patterns.md | JSONL ストリーミング解析 + safeParse サイレントスキップ、階層的時系列集約、3 モードコスト計算 |
| 12 | dependency-management | dependency-management.md | catalogMode:strict + 8 カテゴリで 153 箇所の依存を一元管理、4 層サプライチェーン防御 |
| 13 | ai-settings | ai-settings.md | 10 個の CLAUDE.md 階層的コンテキスト、AGENTS.md シンボリックリンク、npm 化 LLM ドキュメント + skills |
| 14 | dev-conventions | dev-conventions.md | verbatimModuleSyntax + .ts 拡張子 import、ESLint 論理ルール + oxfmt フォーマット分離、構造化ロガー |

## 特に注目すべき知見

- **Valibot Branded Types + ファクトリ関数による型安全なドメインプリミティブ**: 12 種の文字列型（SessionId, ModelName, DailyDate 等）をスキーマ定義 + `v.InferOutput` + `create*` ファクトリの三点セットで構築し、未検証の string が型を越えて流通する経路を構造的に断つ。スキーマと型が常に同期するため二重管理のリスクがない。

- **safeParse + サイレントスキップによるレジリエンスパターン**: JSONL の各行を `v.safeParse()` で検証し、不正データは例外を投げず `continue` でスキップする。1 行の破損がツール全体を停止させないこの設計は、追記ログやストリームデータの処理で広く応用可能。

- **_ prefix + tsdown entry 除外 + package.json exports の三層境界制御**: 命名規約（人間への視覚的シグナル）、ビルド設定（型定義の漏洩防止）、exports フィールド（Node.js ランタイムでのアクセス制限）の三層で冗長に内部モジュールを保護する。

- **pnpm catalogs strict + 4 層サプライチェーン防御**: `catalogMode: strict` で依存バージョンを一元管理しつつ、`strictDepBuilds` + `blockExoticSubdeps` + `trustPolicy: no-downgrade` + `minimumReleaseAge: 2880` の 4 設定で多層防御を構成。

- **AI ファーストの階層的 CLAUDE.md + AGENTS.md シンボリックリンク**: ルート CLAUDE.md に横断的ルール、各パッケージに固有コンテキストを配置する二層設計。`AGENTS.md -> CLAUDE.md` のシンボリックリンクでマルチエージェント対応を単一ソースで実現。

## クイックリファレンス

- [導出ルール集](rules.md) — CLAUDE.md に貼れる形式の全ルール
