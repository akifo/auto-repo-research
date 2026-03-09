# vitest-dev/vitest

> URL: https://github.com/vitest-dev/vitest
> Stars: 16.1k | 言語: TypeScript | ライセンス: MIT | 分析日: 2026-03-06

## サマリー

Vitest は Vite のモジュール変換パイプラインをテスト実行基盤として再利用する設計により、「既存インフラの上に新しいツールを構築する」際の実践的パターンの宝庫である。17 パッケージのモノレポを 3 層の依存グラフで管理し、プロセス境界を跨ぐ birpc 通信、プロバイダ抽象化による複数バックエンド統一、No-mock テストポリシーによるリファクタリング耐性の高いテスト戦略など、大規模 TypeScript プロジェクトのアーキテクチャ・テスト・ビルド・CI/CD のあらゆる面で応用可能な知見を提供する。

## 技術スタック

- **言語**: TypeScript (ESM-first, strict)
- **フレームワーク**: Vite 7.x (DevEnvironment / ModuleRunner / プラグインシステム)
- **ビルド**: Rollup + OXC (unplugin-isolated-decl) + rollup-plugin-dts
- **テスト**: Vitest (セルフホスティング)、Playwright (E2E)
- **パッケージマネージャ**: pnpm 10.x (workspaces + catalog + patches)
- **CI**: GitHub Actions (マルチOS/Node マトリクス)
- **その他**: Tinypool (ワーカー), Chai (アサーション), birpc (RPC), Playwright/WebDriverIO (ブラウザ)

## 分析した視点

| # | 視点 | ファイル | 概要 |
| - | ---- | -------- | ---- |
| 1 | project-structure | project-structure.md | pnpm ワークスペースモノレポの3層依存グラフ、テストと本体の分離、catalog による依存一元管理 |
| 2 | architecture | architecture.md | CLI→Core→Pool→PoolRunner→Worker の5層構成、birpc 双方向 RPC、Safe Timers による防御 |
| 3 | design-philosophy | design-philosophy.md | Vite パイプライン再利用、No-mock テストポリシー、スマートデフォルト、サブパスエクスポート強制 |
| 4 | worker-isolation-patterns | worker-isolation-patterns.md | 5種プール（threads/forks/vm系/typescript）の Strategy 切替、状態マシン、ワーカー再利用戦略 |
| 5 | test-runner-lifecycle | test-runner-lifecycle.md | 4フェーズ分離（収集→実行→レポート）、use() コールバックによるフィクスチャ管理、スロットル通知 |
| 6 | api-design-practices | api-design-practices.md | Chai プラグインで Jest API を構築、expect.extend の自動非対称マッチャー化、エイリアス廃止戦略 |
| 7 | vite-integration-patterns | vite-integration-patterns.md | プラグイン配列による責務分離、DevServer 機能の選択的無効化、バージョン差異の機能検出吸収 |
| 8 | module-mocking-architecture | module-mocking-architecture.md | 正規表現ガード+MagicString による AST ホイスティング、RefTracker 循環参照追跡、3環境インターセプト |
| 9 | snapshot-design | snapshot-design.md | 3形態統一 match、プラグインチェーンシリアライズ、MagicString 非破壊書き戻し、冪等書き込み |
| 10 | browser-testing-abstraction | browser-testing-abstraction.md | BrowserProvider 最小インターフェース、declare module 型拡張、名前ベースコマンドディスパッチ |
| 11 | coverage-provider-patterns | coverage-provider-patterns.md | 二層インターフェース（Runtime/Host）、CoverageMap 共通フォーマット正規化、動的プロバイダ解決 |
| 12 | configuration-patterns | configuration-patterns.md | Vite config 寄生拡張、3フェーズ設定マージ、矛盾早期検出、ホワイトリスト式 CLI 伝播 |
| 13 | error-handling-idioms | error-handling-idioms.md | 多段フォールバック表示、Worker 間エラーシリアライズ、差分の段階的劣化、actionable エラーメッセージ |
| 14 | type-system-patterns | type-system-patterns.md | 空 interface 拡張ポイント、declare module 段階的型合成、ThisType/Phantom Type/再帰 mapped type |
| 15 | testing-practices | testing-practices.md | セルフホスティング、runInlineTests 宣言的テスト、onTestFinished 自動クリーンアップ、結果ツリー検証 |
| 16 | build-and-tooling | build-and-tooling.md | 2段階 DTS 生成（OXC+rollup-plugin-dts）、ビルド設定共通化、pnpm catalog/patches 戦略的活用 |
| 17 | ci-cd | ci-cd.md | 非対称マトリクス、変更検出スキップ、Rolldown 互換独立ジョブ、SHA ピン留め、最小権限設計 |
| 18 | ai-settings | ai-settings.md | Hub-Spoke 3層構成、制約駆動の品質保証（禁止事項明示）、専門エージェント委譲パターン |

## 特に注目すべき知見

- **No-mock テストポリシーと runInlineTests**: テストフレームワーク自身のテストでモックを一切使わず、`runInlineTests` で実際に vitest を起動して結果を検証する。宣言的にファイルシステム構造を定義し、`onTestFinished` で自動クリーンアップする設計は、CLI ツールや統合テスト全般に即座に応用可能。(design-philosophy, testing-practices)

- **Safe Timers とグローバル事前バインドによるフレームワーク保護**: テストコードが `setTimeout` や `process.exit` をモックしても、フレームワーク内部の RPC 通信やプロセス制御が壊れないよう、初期化時にネイティブ関数を bind で保存し `withSafeTimers()` で保護する。ユーザーコードとフレームワークコードの実行コンテキスト分離パターン。(architecture, worker-isolation-patterns)

- **空 interface + declare module による段階的型拡張**: `Matchers<T>`, `TaskMeta`, `ProvidedContext` 等を空 interface として公開し、ユーザーやプラグインが declaration merging で型を追加する設計。`TestArtifactRegistry[keyof TestArtifactRegistry]` パターンでユニオン型を自動拡張する手法は、プラグインシステムの型設計に直接適用可能。(type-system-patterns)

- **エラー表示の多段フォールバック**: シリアライズ失敗時のマーカー置換、pretty-print 失敗時の `callToJSON: false` リトライ、stringify の `maxDepth` 半減リトライなど、エラー表示パイプラインの各段階にフォールバックを設け「エラーの表示に失敗してエラー」を構造的に排除する。巨大入力への 5 段階サイズ制限も含め、堅牢なエラーハンドリングの教科書的実装。(error-handling-idioms)

- **プロバイダ抽象化の多層設計**: ブラウザテスト（Playwright/WebDriverIO）、カバレッジ（V8/Istanbul）、ワーカープール（threads/forks/vm系）のすべてで、最小インターフェース + Strategy パターンによるプロバイダ切り替えを採用。共通フォーマットへの正規化で下流処理を統一し、新プロバイダ追加時の影響を最小化する設計。(browser-testing-abstraction, coverage-provider-patterns, worker-isolation-patterns)

## クイックリファレンス

- [導出ルール集](rules.md) — CLAUDE.md に貼れる形式の全ルール
