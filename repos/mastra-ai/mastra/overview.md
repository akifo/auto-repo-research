# mastra-ai/mastra

> URL: https://github.com/mastra-ai/mastra
> Stars: 21.1k | 言語: TypeScript | ライセンス: Apache-2.0 | 分析日: 2026-02-14

## サマリー

Mastra は Gatsby チーム出身の開発者が構築した AI エージェントフレームワークであり、100 超のパッケージを持つ大規模 TypeScript モノレポとして、「薄いコア + プラガブルな周辺パッケージ」のアーキテクチャを高い完成度で実現している。このリポジトリから学べる核心は、(1) カテゴリ別ディレクトリ分割・pnpm catalog・共有テストスイートファクトリによる大規模モノレポのスケーラブルな管理手法、(2) abstract class + Composition Root + DynamicArgument 型による拡張可能なフレームワーク設計パターン、(3) Zod スキーマ駆動型設計・ブランド型・条件型を駆使した TypeScript 型システムの実践的活用法である。

## 技術スタック

- **言語**: TypeScript (strict + noUncheckedIndexedAccess)
- **フレームワーク**: 独自 AI エージェントフレームワーク、Hono/Express/Fastify/Koa (サーバーアダプター)
- **ビルド**: Turborepo + tsup + カスタム型生成 (@internal/types-builder)
- **テスト**: Vitest (ワークスペース + 動的プロジェクト発見 + シャーディング)
- **パッケージマネージャ**: pnpm v10.18+ (catalog + workspace)
- **リリース**: Changesets (カスタム CLI + fixed グループ + alpha/stable/snapshot 3チャネル)
- **CI/CD**: GitHub Actions (35+ ワークフロー、Trusted Actions パターン)
- **スキーマ**: Zod v3/v4 両対応 + Standard Schema + プロバイダ別制約変換

## 分析した視点

| # | 視点 | ファイル | 概要 |
|---|------|---------|------|
| 1 | Project Structure | project-structure.md | 90超パッケージをカテゴリ別トップレベルディレクトリに分割し、@internal/*スコープとpnpm catalogで一貫管理 |
| 2 | Architecture | architecture.md | Mastraクラスを中央レジストリとした4層構造で、Proxy遅延初期化とNoOpパターンを活用 |
| 3 | Design Philosophy | design-philosophy.md | 薄いコア+プラガブル周辺、DynamicArgument型による静的/動的統一、AI SDKベンダリング戦略 |
| 4 | Abstraction Patterns | abstraction-patterns.md | 三層継承とフィルタ翻訳Interpreterで50超アダプターを統一インターフェースで管理 |
| 5 | Type System Patterns | type-system-patterns.md | Zodスキーマ駆動型設計、ブランド型によるsuspend安全性、条件型でのAPI分岐を高度に活用 |
| 6 | Code Organization | code-organization.md | メインエントリ1行+20超サブパスエクスポートで最小公開面を実現、@deprecatedエイリアスで段階的移行 |
| 7 | Extensibility Mechanisms | extensibility-mechanisms.md | abstract class+中央レジストリ+自動DIの三位一体で50超プラグインの拡張メカニズムを統一 |
| 8 | Error Handling Idioms | error-handling-idioms.md | ドメイン×カテゴリの構造化エラー、unknown正規化ユーティリティ、5段階バリデーションフォールバック |
| 9 | Testing Practices | testing-practices.md | テストスイートファクトリとcapabilityフラグで20超アダプターに統一テストを適用、CI差分実行を徹底 |
| 10 | API Design Practices | api-design-practices.md | 設定オブジェクト+createXxxファクトリ+Fluent Builderで型推論を活かしたDX重視のAPI設計 |
| 11 | Build and Tooling | build-and-tooling.md | tsup(dts:false)+カスタム型生成+Turborepo二層タスク定義で80超パッケージのビルドを統一 |
| 12 | Dependency Management | dependency-management.md | pnpm catalog+npm aliasing+カスタムchangeset CLIで100超パッケージの依存とバージョンを自動管理 |
| 13 | Dev Conventions | dev-conventions.md | @internal/lintで共有ESLint設定を一元化、依存検出による条件付きルール適用で異種パッケージに対応 |
| 14 | AI Settings | ai-settings.md | 階層的CLAUDE.md、MCP ドキュメントサーバー、スキルの遅延ロード、ステージ制ワークフロー |
| 15 | Concurrency Patterns | concurrency-patterns.md | branded type付きsuspend/resume、安全性制約による並行度自動降格、debounce+staleness永続化 |
| 16 | Schema Validation Patterns | schema-validation-patterns.md | Zod v3/v4互換のduck typing、プロバイダ別Strategy変換、5段階フォールバック入力正規化 |
| 17 | Composability Patterns | composability-patterns.md | createStepで異種コンポーネントをStep統一変換、Workflow自体がStepを実装するComposite構造 |
| 18 | CI/CD | ci-cd.md | Turboハッシュ変更検出+workflow_runチェーン+Trusted Actionsで大規模モノレポCIを安全に自動化 |

## 特に注目すべき知見

- **テストスイートファクトリ + Capability フラグ**: 同一インターフェースの 20 超の実装（ストレージアダプター等）に対し、`createTestSuite(storage)` の 1 行で全契約テストを適用する。各実装の機能差は `supportsRegex: false` のような capability フラグで宣言的に表現し、テストコード内の条件分岐を排除する。このパターンは DB ドライバ、API クライアント、プロバイダー実装など、Strategy/Adapter パターンを使うあらゆるプロジェクトに即座に応用できる。（testing-practices, architecture, code-organization）

- **DynamicArgument パターンによる静的/動的設定の統一**: `T | ((ctx) => T | Promise<T>)` というユニオン型で、設定値を「リテラル値」と「リクエストコンテキストに応じた関数」の両方で受け付ける。テスト時はハードコード、本番ではマルチテナント対応の動的解決を、API を一切変えずに実現する。Agent の instructions・tools・model 全てにこのパターンが適用されており、設定 API 設計の汎用テンプレートとして有用。（design-philosophy, type-system-patterns, api-design-practices, composability-patterns）

- **Zod v3/v4 両対応の構造的部分型 + Constraint Degradation**: Zod スキーマを Single Source of Truth として型とバリデーションの両方を導出しつつ、Zod v3/v4 の互換性を `instanceof` ではなく duck typing（`_def`/`_zod` プロパティの存在チェック）で吸収する。さらに、AI プロバイダがサポートしない JSON Schema 制約を削除するのではなく `description` フィールドに人間可読テキストとして移動する「制約のダウングレード」は、外部システムとの連携で情報を失わない巧妙な設計。（schema-validation-patterns, type-system-patterns）

- **5段階バリデーションフォールバックによる LLM 出力の防御的検証**: LLM ごとの出力の癖（Gemini の null 送信、GLM4.7 の文字列化 JSON、OpenAI の optional/nullable 変換）を段階的に吸収するパイプライン。各段階は GitHub Issue 番号で追跡されており、実運用で発見された問題を構造的に対処する模範例。外部システムからの入力検証一般に応用可能。（error-handling-idioms, schema-validation-patterns）

- **Trusted Actions パターン + 4層テスト戦略**: `workflow_run` 経由で PR コードを実行する際、ベースブランチからアクション定義のみを sparse-checkout で取得し、PR 由来のアクション改竄を防止する。加えて、Turborepo タスクハッシュで推移的依存を含む変更検出を行い、未変更パッケージのテストをスキップしつつ明示的に success ステータスを返す仕組みは、大規模モノレポ CI の模範的設計。（ci-cd）

## クイックリファレンス

- [導出ルール集](rules.md) -- CLAUDE.md にそのまま貼り付けて AI コンテキストとして活用
