# promptfoo/promptfoo

> URL: https://github.com/promptfoo/promptfoo
> Stars: 10.6k | 言語: TypeScript | ライセンス: MIT | 分析日: 2026-02-21

## サマリー

promptfoo は「宣言的 YAML 設定から 100 以上の LLM プロバイダを統一的にテストする」という課題に対して、最小インターフェース（`id()` + `callApi()`）による抽象化、文字列プレフィックスベースのファクトリ配列による動的解決、Zod スキーマを Single Source of Truth とする設定パイプラインを組み合わせた大規模プラグインアーキテクチャを構築している。このコードベースから学べる核心は、「多数のバックエンド実装を低コストで統合しつつ、設定駆動の宣言性とプログラマティックな拡張性を両立する設計技法」と「2,300+ ファイル規模の TypeScript モノレポを Lint ルール・テスト 3 層戦略・適応的レートリミッタで品質管理する運用プラクティス」の二つである。

## 技術スタック

- **言語**: TypeScript (ESM/CJS デュアルビルド, strict mode)
- **フレームワーク**: Commander.js (CLI), Express + Socket.IO (Server), React 19 + Vite (Web UI), Docusaurus (Docs)
- **ビルド**: tsdown (4 構成), postbuild スクリプト, Biome + Prettier
- **テスト**: Vitest (unit / integration / smoke 3 層), pool: forks, sequence.shuffle
- **リンター/フォーマッタ**: Biome (JS/TS/JSON) + Prettier (CSS/MD/YAML)
- **データベース**: SQLite (better-sqlite3 + Drizzle ORM, WAL モード)
- **パッケージマネージャ**: npm workspaces (src/app, site)
- **CI/CD**: GitHub Actions, release-please, Renovate, Claude Code Review

## 分析した視点

| #  | 視点                   | ファイル                      | 概要                                                                                                            |
| -- | ---------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1  | プロジェクト構造       | project-structure.md          | npm workspaces で依存方向を制御し、tsdown 4構成ビルドと3層テストを単一設定で管理するモノレポ構成                |
| 2  | アーキテクチャ         | architecture.md               | 最小インターフェース ApiProvider と eval パイプラインを共有コアに集約し CLI/Server/Library の三面を提供する設計 |
| 3  | 設計思想               | design-philosophy.md          | 宣言的 YAML 設定と file:// エスケープハッチの組み合わせで柔軟性と簡潔さを両立する設計思想                       |
| 4  | プラグイン合成         | plugin-composition.md         | Plugin+Grader ペアの Template Method とコレクション定数による宣言的プラグイン合成パターン                       |
| 5  | アサーションパターン   | assertion-patterns.md         | Zod enum + Record 型ハンドラマップで50種以上のアサーションの網羅性をコンパイル時に保証する設計                  |
| 6  | プロバイダ抽象化       | provider-abstraction.md       | 文字列駆動のファクトリ配列と OpenAI 互換継承で100以上のプロバイダを統一的に管理する抽象化戦略                   |
| 7  | 設定駆動アーキテクチャ | config-driven-architecture.md | Zod スキーマを型・バリデーション・JSON Schema の Single Source of Truth とする多段設定パイプライン              |
| 8  | テスト戦略             | testing-practices.md          | forks プール・ランダム順序・Echo プロバイダで625以上のテストファイルの信頼性と分離性を担保する戦略              |
| 9  | エラーハンドリング     | error-handling-idioms.md      | Return-based Error・3層リトライ・一時的/永続的エラー分類で部分的失敗を許容するエラー戦略                        |
| 10 | 型システム             | type-system-patterns.md       | enum 禁止・Zod スキーマ型導出・AssertEqual 静的検証で型とスキーマの整合性を構造的に保証する設計                 |
| 11 | セキュリティ           | security-practices.md         | Lint による fetch 一元化・3層ログサニタイズ・リスク別依存更新遅延の多層セキュリティプラクティス                 |
| 12 | 拡張性機構             | extensibility-mechanisms.md   | URI プレフィックス統一ディスパッチと JSON 契約で多言語拡張を宣言的設定から接続する拡張機構                      |
| 13 | ビルド・ツーリング     | build-and-tooling.md          | tsdown 4構成デュアルビルドと Biome/Prettier 責務分離で大規模 TS プロジェクトの品質を自動担保                    |
| 14 | AI エージェント設定    | ai-settings.md                | CLAUDE.md 委任パターンと階層的 AGENTS.md で AI エージェントにコンテキストの局所性を提供する戦略                 |
| 15 | CI/CD                  | ci-cd.md                      | release-please 自動化・動的テストマトリクス・AI レビュー増分戦略を統合した段階的品質ゲート                      |
| 16 | 並行制御               | concurrency-patterns.md       | 同期スロット割当・AIMD 風適応的並列度・Symbol 二重ラップ防止で API レートリミットに自動適応する設計             |
| 17 | 開発規約               | dev-conventions.md            | Lint ルールで fetch 一元化と enum 禁止を強制し差分ベースの品質チェックで開発体験を維持する規約体系              |
| 18 | データベースパターン   | database-patterns.md          | SQLite WAL + Drizzle ORM + コンテンツアドレス Blob でローカルファースト CLI のゼロ設定永続化を実現              |

## 特に注目すべき知見

- **Zod enum + Record 型によるハンドラ網羅性保証**: アサーション型を Zod enum で定義し、`Record<BaseAssertionTypes, Handler>` でハンドラマップを構成することで、型の追加時にハンドラ未実装がコンパイルエラーになる。50 種以上の評価ロジックをゼロ漏れで管理する手法として、プラグインシステムを持つあらゆるプロジェクトに応用できる。

- **適応的レートリミッタ（AIMD 風並列度制御）**: ユーザに設定を求めず、API レスポンスヘッダから残クォータを自動学習し、「残量 10% 未満でプロアクティブ削減 -> 429 で即時半減 -> 5 連続成功で 1.5 倍回復」の 3 層で並列度を自動調整する。外部 API を大量に並列呼び出しするあらゆるツールに適用可能。

- **Lint ルールによるアーキテクチャ制約の強制**: `noRestrictedGlobals` で `fetch` 直接使用を禁止し `fetchWithProxy` に一元化する手法は、プロキシ・TLS・リトライ・ログ出力の漏れを構造的に防ぐ。コードレビューに頼らず、ツールチェーンでアーキテクチャ制約を担保する設計パターンとして汎用性が高い。

- **宣言的設定の二層構造と file:// エスケープハッチ**: ユーザ向け設定（`TestSuiteConfig`）とランタイム内部表現（`TestSuite`）を分離し、`evaluate()` で一括変換する。YAML の制約を超えるロジックは `file://` プロトコルで外部委譲する統一的なエスケープハッチを全構成要素に適用。設定駆動ツール全般に再利用できるパターン。

- **階層的 AGENTS.md による AI エージェントのコンテキスト管理**: ルートにディレクトリ -> ローカル AGENTS.md の対応テーブルを設置し、「Read the relevant AGENTS.md when working in that directory」と指示する委任パターン。PostToolUse フックで lint/format を自動強制する仕組みと合わせ、AI エージェントをチームメンバーとして設計に組み込む先進的な取り組み。

## クイックリファレンス

- [導出ルール集](rules.md) — CLAUDE.md に貼れる形式の全ルール
