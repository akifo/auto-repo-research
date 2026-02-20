# langchain-ai/langchainjs

> URL: https://github.com/langchain-ai/langchainjs
> Stars: 17.0k | 言語: TypeScript | ライセンス: MIT | 分析日: 2026-02-20

## サマリー

langchainjs は Runnable という単一の統一抽象を軸に、40 以上のパッケージを持つ大規模モノレポを型安全に合成可能にするフレームワークである。`invoke/stream/batch` の 3 メソッドプロトコル、`Symbol.for()` による instanceof 代替、AsyncGenerator パイプラインによるストリーミング統一、`@langchain/build` による共有ビルドインフラなど、プラグインアーキテクチャのスケーラビリティと品質均一化を両立するプラクティスが体系的に適用されている。特に「設計制約を ESLint ルールで機械的に強制する」「Standard Tests による横断品質保証」「宣言的ゲッターによるシリアライズプロトコル」は、規模に依存しない汎用的な設計パターンとして他のプロジェクトに直接応用できる。

## 技術スタック

- **言語**: TypeScript (ES2022 ターゲット)
- **フレームワーク**: 独自フレームワーク (Runnable ベース)
- **ビルド**: tsdown (rolldown ベース) + Turborepo + @langchain/build
- **テスト**: vitest (一部 jest) + @langchain/standard-tests
- **パッケージマネージャ**: pnpm workspaces
- **リント**: @langchain/eslint (typescript-eslint + no-instanceof + no-process-env)
- **バージョン管理**: changesets (fixed グループ + onlyUpdatePeerDependentsWhenOutOfRange)

## 分析した視点

| #  | 視点                   | ファイル                      | 概要                                                                                            |
| -- | ---------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------- |
| 1  | プロジェクト構造       | project-structure.md          | pnpm + Turborepo による 40+ パッケージ管理、3 層アーキテクチャと共有ビルドインフラで品質を統一  |
| 2  | アーキテクチャ         | architecture.md               | Runnable 基底クラスの invoke/stream/batch 統一プロトコルと pipe() による宣言的パイプライン合成  |
| 3  | 設計思想               | design-philosophy.md          | 統一インターフェース原則・ランタイム中立・Symbol ブランディングによる instanceof 排除の設計思想 |
| 4  | 抽象化パターン         | abstraction-patterns.md       | Template Method + アンダースコア接頭辞による拡張ポイント分離と合成ベースの機能追加パターン      |
| 5  | 型システムパターン     | type-system-patterns.md       | Zod v3/v4 Interop 型、declare + this['T'] パターン、12+ オーバーロードによる精密な型推論        |
| 6  | コード組織             | code-organization.md          | 空ルートエクスポート + 50+ サブパス分割、types.ts 分離と dpdm による循環依存検出                |
| 7  | ストリーミングパターン | streaming-patterns.md         | AsyncGenerator 3 層構造と concat チャンクプロトコルによる統一ストリーミングパイプライン         |
| 8  | エラーハンドリング     | error-handling-idioms.md      | Symbol ブランディング階層エラー型、プロバイダ境界での正規化、二重チャネル復旧設計               |
| 9  | テスト戦略             | testing-practices.md          | ファイル拡張子ベースの 4 層テスト分類と Standard Tests によるプロバイダー横断品質保証           |
| 10 | API 設計               | api-design-practices.md       | public/_/internal の三層 API 分離、Interop 型による依存メジャー移行、changesets 協調リリース    |
| 11 | 拡張性メカニズム       | extensibility-mechanisms.md   | Thin Core / Fat Periphery 原則、二段階抽象と Standard Tests による品質均一化                    |
| 12 | ビルド・ツーリング     | build-and-tooling.md          | getBuildConfig() ファクトリ + ATTW/publint 自動検証、Docker 9 環境テストによる互換性保証        |
| 13 | 依存管理               | dependency-management.md      | workspace:^/workspace:* 使い分け、pnpm overrides シングルトン強制、fixed グループ同期リリース   |
| 14 | コールバック・可観測性 | callback-and-observability.md | バックグラウンド/フォアグラウンド切替、Start/End/Error 三つ組ハンドラ、階層的 Run 伝播          |
| 15 | シリアライゼーション   | serialization-patterns.md     | 宣言的ゲッター 5 種によるシリアライズプロトコル、シークレット分離とインポートマップ許可リスト   |
| 16 | 並行制御               | concurrency-patterns.md       | AsyncCaller によるキュー + リトライ一元管理、チャンク分割バッチと AbortSignal 協調キャンセル    |
| 17 | 開発規約               | dev-conventions.md            | 共有 ESLint/tsconfig/build パッケージによる 40+ パッケージ統一と動的マトリクス CI               |
| 18 | AI 設定                | ai-settings.md                | 450 行の AGENTS.md による AI エージェント専用ガイド、禁止ルール + 代替手段のペア提示            |

## 特に注目すべき知見

- **Symbol.for() ブランディングによる instanceof 代替**: `createNamespace` + `ns.brand()` で階層的な型判定を実現し、ESLint `no-instanceof` ルールで全面禁止を強制。モノレポやバンドラー環境でのパッケージ重複問題を根本的に解消するパターンであり、npm パッケージとして配布するライブラリ全般に適用可能。

- **AsyncGenerator パイプラインによるストリーミング統一**: `_streamIterator` / `transform` / `stream` の 3 層構造と、チャンク型の `.concat()` プロトコルにより、ストリーミング未対応コンポーネントも `invoke` フォールバックでパイプラインに参加できる設計。backpressure が自然に効く pull-based なジェネレータチェーンは、あらゆるデータパイプラインに応用できる。

- **Standard Tests によるプラグイン横断品質保証**: `@langchain/standard-tests` が抽象テストクラスを提供し、各プロバイダーは継承 + capability flag 宣言だけで標準テストが自動実行される。プラグインアーキテクチャを持つプロジェクトで「品質の床」を均一化する即実践可能なパターン。

- **設計制約の ESLint ルール化**: `instanceof` 禁止、`process.env` 直接参照禁止、浮遊 Promise 禁止など、ドキュメントだけでは形骸化しやすい設計原則を ESLint カスタムルール/プラグインで機械的に強制。CI で自動検証されるため、コードレビュー負荷を削減しつつ原則の遵守を保証できる。

- **Interop 型パターンによる依存メジャーバージョン移行**: Zod v3/v4 デュアルサポートを `InteropZodType` (Union 型) + 型ガード + 条件型の三位一体で実現。依存ライブラリのメジャーバージョン移行時にエコシステムを壊さず段階的に進める汎用戦略。

## クイックリファレンス

- [導出ルール集](rules.md) — CLAUDE.md に貼れる形式の全ルール
