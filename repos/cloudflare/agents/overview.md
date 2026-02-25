# cloudflare/agents

> URL: https://github.com/cloudflare/agents
> Stars: 4.2k | 言語: TypeScript | ライセンス: MIT | 分析日: 2026-02-25

## サマリー

Cloudflare Agents SDK は Durable Objects 上にステートフル AI エージェントを構築するフレームワークであり、「Hibernation を前提にしたすべての状態の SQLite 永続化」「境界での一括アクセス制御」「冪等マイグレーションによる無停止スキーマ進化」という3つの設計原則がコードベース全体を貫いている。partyserver の Server を一段継承した Agent クラスに、状態同期・RPC・スケジューリング・MCP・Workflow の5サブシステムを SQLite テーブルとして積層する構造は、サーバーレス環境でのステートフルサービス設計の実践的なリファレンスとなる。また、18+ サブパス exports の三位一体検証、遅延1回警告付き非推奨ラッパー、6階層 AGENTS.md によるAI向けコンテキスト局所化など、ライブラリ公開・モノレポ運用・AI設定の各側面にも汎用的に応用可能なプラクティスが豊富に含まれている。

## 技術スタック

- **言語**: TypeScript (ES2021 target, ES2022 modules, strict mode)
- **ランタイム**: Cloudflare Workers / Durable Objects / Workflows
- **フレームワーク**: partyserver (DO 基盤), Vercel AI SDK (peer), MCP SDK
- **ビルド**: tsdown (ESM-only, .d.ts + sourcemaps), oxfmt (formatter)
- **テスト**: vitest + @cloudflare/vitest-pool-workers, Playwright, evalite
- **リンター**: oxlint (react, jsx-a11y, typescript plugins)
- **パッケージマネージャ**: npm workspaces
- **リリース**: changesets + pkg-pr-new

## 分析した視点

| #  | 視点                           | ファイル                          | 概要                                                                                                    |
| -- | ------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1  | project-structure              | project-structure.md              | 安定度ベースの4階層ワークスペース分類、source-level export、AGENTS.md ネストによるコンテキスト局所化    |
| 2  | architecture                   | architecture.md                   | Server→Agent 一段継承に5つの SQLite サブシステムを積層、AsyncLocalStorage による透過的コンテキスト注入  |
| 3  | design-philosophy              | design-philosophy.md              | Hibernation 前提の SQLite 永続化、Eager Validation、構造的セキュリティ、State vs SQL の二層分離         |
| 4  | durable-objects-actor-patterns | durable-objects-actor-patterns.md | SQLite を Actor の永続化レイヤーに活用、べき等な再初期化、冪等マイグレーション、running フラグ重複防止  |
| 5  | state-sync-and-rpc             | state-sync-and-rpc.md             | 対称的な CF_AGENT_STATE プロトコル、@callable デコレータ + WeakMap RPC、再帰的 Serializable 型制約      |
| 6  | api-design-practices           | api-design-practices.md           | 18+ サブパス exports の三位一体検証、遅延1回警告付き非推奨ラッパー、安定性レベルの命名規約              |
| 7  | mcp-protocol-integration       | mcp-protocol-integration.md       | 3トランスポートの Strategy 切り替え、初期化リクエスト永続化による Hibernation 復元、auto フォールバック |
| 8  | composition-patterns           | composition-patterns.md           | 単一基盤+複数拡張面、DO RPC スタブの型安全な合成、WeakSet 二重ラップ防止、mixin パターン                |
| 9  | extensibility-mechanisms       | extensibility-mechanisms.md       | Object Augmentation による型安全な拡張、薄い Middleware Adapter、@callable オプトイン公開               |
| 10 | error-handling-idioms          | error-handling-idioms.md          | tryN 単一リトライ基盤、設定の Eager Validation、二重 try-catch による onError 保護、Jitter Backoff      |
| 11 | testing-practices              | testing-practices.md              | ランタイム境界ごとの vitest projects 分離、実 DO バインディング統合テスト、型レベル .test-d.ts 検証     |
| 12 | streaming-patterns             | streaming-patterns.md             | SQLite バッファリングによる resumable stream、3フェーズ再開プロトコル、チャンクパーサーの欠落耐性       |
| 13 | scheduling-and-workflow        | scheduling-and-workflow.md        | 単一アラーム制約の SQLite 多重化、step 経由=耐久/this 経由=非耐久の境界、waitForApproval パターン       |
| 14 | observability                  | observability.md                  | emit() 単一メソッド Strategy、Emitter/DisposableStore 階層伝搬、optional chaining ゼロコスト無効化      |
| 15 | ai-settings                    | ai-settings.md                    | 6階層 AGENTS.md のスコープ分離、Always/Ask first/Never 行動境界、Diataxis ベースの docs/design 分離     |
| 16 | build-and-tooling              | build-and-tooling.md              | tsdown API 直接呼び出し+oxfmt 後処理、check-exports 自動検証、並行 typecheck スクリプト                 |
| 17 | ci-cd                          | ci-cd.md                          | concurrency 使い分け、Playwright 3層キャッシュ、changesets 制限のカスタムスクリプト補完                 |
| 18 | dev-conventions                | dev-conventions.md                | verbatimModuleSyntax 強制、Oxide ツールチェーン、単一 check コマンド集約、wrangler.jsonc 統一           |

## 特に注目すべき知見

- **冪等マイグレーションによる無停止スキーマ進化**: `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN` の duplicate 無視パターンにより、サーバーレス環境で「どのバージョンのコードがインスタンスを起動するか」が不確定な状況でも、外部マイグレーションツールなしでスキーマを安全に進化させている。ステートフルサーバーレス環境で永続化を扱うすべてのプロジェクトに即座に適用可能なパターン。

- **exports 三位一体検証と非推奨 API の遅延1回警告**: package.json の `exports`、ビルドエントリ、CI チェックスクリプトの3点で公開 API の整合性を自動検証し、非推奨 API にはモジュールスコープのフラグ + `console.warn` + 新関数への委譲という一貫したパターンを6箇所以上で適用している。ライブラリパッケージの公開品質管理として汎用的に適用できる。

- **境界でのアクセス制御一括強制**: readonly チェックを個別メソッドではなく `setState()` 内部の単一ポイントに集約し、開発者がメソッドごとにパーミッションチェックを書く必要をなくしている。「アクセス制御は共通パスで強制し、個別ハンドラに分散させない」というフレームワーク設計原則は、認証・認可を持つ任意のシステムに適用可能。

- **6階層 AGENTS.md による AI コンテキストの局所化**: ディレクトリごとにスコープの異なる AGENTS.md を配置し、ルートにナビゲーションテーブルを設ける構成で、AI ツールが必要なコンテキストだけを段階的に取得できる。Always/Ask first/Never の3段階行動境界も含め、大規模モノレポにおけるAI設定の先進的事例。

- **tryN 単一リトライ基盤 + Eager Validation**: 全サブシステム（キュー、スケジュール、ワークフロー、MCP 接続）が共通の `tryN` 関数でリトライし、リトライ設定は登録時に即座にバリデーションする。リトライロジックの重複を排除しつつ、「数分後のアラーム実行時に初めて設定エラーが発覚する」事態を防ぐ設計は、非同期タスク処理を持つ任意のシステムに適用できる。

## クイックリファレンス

- [導出ルール集](rules.md) — CLAUDE.md に貼れる形式の全ルール
