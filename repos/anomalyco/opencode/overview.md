# anomalyco/opencode

> URL: https://github.com/anomalyco/opencode
> Stars: 116.1k | 言語: TypeScript | ライセンス: MIT | 分析日: 2026-03-05

## サマリー

opencode は AI コーディングエージェントを TypeScript モノレポで構築した大規模プロジェクトであり、「SDK-first アーキテクチャによるマルチプラットフォーム統合」「Zod スキーマを Single Source of Truth とした型安全なパイプライン設計」「AGENTS.md による AI 生成コードの品質制御」の3つの核心的プラクティスが学べる。特に、OpenAPI 自動生成 → SDK 自動生成の契約駆動開発、.catch() チェーンによる宣言的エラーハンドリング、NamedError + Zod による構造的エラー判別、Output Mutation フックによるプラグインシステムなど、AI エージェント開発に限らず汎用的に適用可能なプラクティスが豊富に含まれている。

## 技術スタック

- **言語**: TypeScript
- **フレームワーク**: SolidJS (TUI/Web), Tauri (Desktop), Hono (API Server)
- **ビルド**: Bun + Turborepo, Vite
- **テスト**: Bun test, Playwright (E2E)
- **パッケージマネージャ**: Bun (workspaces)
- **AI SDK**: Vercel AI SDK v5
- **DB**: SQLite (Drizzle ORM)
- **インフラ**: SST (AWS), Nix
- **スキーマ**: Zod v4, hono-openapi, @hey-api/openapi-ts

## 分析した視点

| #  | 視点                     | ファイル                    | 概要                                                                                                   |
| -- | ------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1  | project-structure        | project-structure.md        | SDK-first アーキテクチャで一方向依存を強制し、OpenAPI 自動生成で型整合性を保証するモノレポ設計         |
| 2  | architecture             | architecture.md             | fetch 差し替えによるトランスポート抽象化で TUI/Web/Desktop を統一 SDK で接続する3層アーキテクチャ      |
| 3  | design-philosophy        | design-philosophy.md        | AI エージェント出力を矯正する AGENTS.md 規約と認知負荷最小化の設計哲学                                 |
| 4  | agent-orchestration      | agent-orchestration.md      | 三値ループ制御、doom loop 検出、ストリーム即時永続化による自律エージェントの安全な実行パイプライン     |
| 5  | tool-system-design       | tool-system-design.md       | Tool.define ファクトリで定義を統一し、レジストリ層で権限・トランケーションを一元管理するツールシステム |
| 6  | type-system-patterns     | type-system-patterns.md     | Zod を Single Source of Truth とし、namespace 同名エクスポートと discriminatedUnion で型安全性を確保   |
| 7  | provider-abstraction     | provider-abstraction.md     | 3段フォールバック、npm パッケージ名ディスパッチ、Transform 層でプロバイダー差異を吸収する抽象化設計    |
| 8  | api-design-practices     | api-design-practices.md     | Zod → hono-openapi → OpenAPI → SDK の自動生成パイプラインによる契約駆動 API 設計                       |
| 9  | session-state-management | session-state-management.md | SQLite + Database.effect + 型安全イベントバスで一方向データフローを実現する状態管理                    |
| 10 | storage-patterns         | storage-patterns.md         | スキーマ co-location、AsyncLocalStorage トランザクション伝播、ビルド時マイグレーション埋め込み         |
| 11 | permission-and-security  | permission-and-security.md  | 三層権限ルールセット、tree-sitter bash 解析、拒否理由別エラークラスの権限制御                          |
| 12 | error-handling-idioms    | error-handling-idioms.md    | .catch() チェーンで try/catch を回避し、NamedError + Zod で構造的判別可能なエラー型を構築              |
| 13 | composition-patterns     | composition-patterns.md     | pipe+mergeDeep 宣言的設定合成、Output Mutation フック、スプレッド条件付き配列合成                      |
| 14 | testing-practices        | testing-practices.md        | tmpdir + Instance.provide でモック回避、パッケージ境界テスト隔離、data-* セレクタ E2E 安定化           |
| 15 | build-and-tooling        | build-and-tooling.md        | Bun compile スタンドアロンバイナリ、define 静的値埋め込み、Nix 再現可能ビルド                          |
| 16 | ai-settings              | ai-settings.md              | AGENTS.md 階層配置、frontmatter エージェント宣言、プロンプト+バリデーション二重防御                    |
| 17 | tui-rendering-patterns   | tui-rendering-patterns.md   | SolidJS fine-grained reactivity + 16ms バッチングで 60fps TUI、15層 Provider で関心分離                |
| 18 | plugin-extensibility     | plugin-extensibility.md     | Output Mutation フックで LLM パイプライン全段に介入可能な統一プラグインシステム                        |

## 特に注目すべき知見

- **Zod → OpenAPI → SDK の自動生成パイプライン**: ドメインモジュールが所有する Zod スキーマから hono-openapi で OpenAPI スペックを生成し、@hey-api/openapi-ts で型付き SDK を自動生成する。サーバーの API 変更が SDK の型エラーとして全 UI パッケージに即座に伝播し、手動の型同期が完全に不要になる。この「スキーマが型・バリデーション・ドキュメント・SDK の唯一の情報源」という設計は、マルチクライアントを持つあらゆるプロジェクトに適用可能。

- **.catch() チェーンと NamedError による宣言的エラーハンドリング**: try/catch を回避し、`.catch(() => defaultValue)` でフォールバック値を宣言的に表現するイディオムがコードベース全体（85箇所以上）で徹底されている。加えて `NamedError.create()` ファクトリが Zod スキーマ統合・構造的判別（`isInstance`）・API レスポンス定義の一元管理を実現する。プロセス境界をまたいでもエラー判別が可能な設計は、分散システムやマルチプラットフォームアプリで特に有用。

- **Database.effect による副作用遅延パターン**: DB 書き込みとイベント発行の整合性を、トランザクション完了後に副作用を遅延実行する仕組みで保証する。ロールバック時にイベントが発火しないことを構造的に防止し、15箇所以上の CRUD 関数すべてが同一パターンに従う。イベント駆動アーキテクチャにおけるデータ整合性の実践的な解法。

- **AGENTS.md による AI 生成コード品質制御**: AI エージェントが生成するコードの品質を、プロジェクト規約の明文化で制御する先進的なアプローチ。短命名の強制、分割代入の禁止、else の排除、try/catch の回避といったルールが AGENTS.md に「THIS RULE IS MANDATORY FOR AGENT WRITTEN CODE」として記載され、1273 ファイル規模のコードベースで一貫性を維持している。

- **Output Mutation フックによるプラグインパイプライン**: プラグインが `(input, output) => void` の形式で output を直接変異させるシンプルな API で、LLM パイプラインの全段（パラメータ調整、ヘッダー注入、ツール実行前後、システムプロンプト変換等）に介入できる。ファイル配置だけで動くカスタムツール → フック関数のプラグイン → MCP プロトコルの外部統合と、参入障壁が段階的に設計されている点も秀逸。

## クイックリファレンス

- [導出ルール集](rules.md) — CLAUDE.md に貼れる形式の全ルール
