# vercel/ai

> URL: https://github.com/vercel/ai
> Stars: 21.9k | 言語: TypeScript | ライセンス: Apache-2.0 | 分析日: 2026-02-20

## サマリー

Vercel AI SDK は 30 以上の AI プロバイダーを単一の TypeScript インターフェースで統合するために、4 層アーキテクチャ（Spec → Utils → Provider → Core）と厳密な一方向依存を軸とした大規模モノレポ設計を採用している。このリポジトリから学べる核心は、(1) バージョン付きインターフェース仕様と Adapter パターンによる非破壊的進化戦略、(2) Web 標準ストリームプリミティブを基盤にした AsyncIterableStream / StitchableStream / DelayedPromise によるストリーミングファーストの非同期設計、(3) Symbol.for ベースのエラー判定・FlexibleSchema による多スキーマ統一・providerOptions による Open-Closed 拡張といった、50 パッケージ規模のエコシステムを型安全かつ拡張可能に維持するためのプラクティス群である。

## 技術スタック

- **言語**: TypeScript 5.8.3 (strict mode, Bundler moduleResolution)
- **フレームワーク**: React, Vue, Svelte, Angular, Solid（フレームワーク統合）
- **ビルド**: Turborepo + tsup (Dual CJS/ESM)
- **テスト**: Vitest (Edge/Node デュアルランタイム) + MSW
- **パッケージマネージャ**: pnpm v10 (53 パッケージモノレポ)
- **CI/CD**: GitHub Actions + Changesets (patch-only ポリシー)
- **フォーマッタ**: Prettier
- **リンター**: ESLint
- **Git Hooks**: Husky + lint-staged

## 分析した視点

| #  | 視点                   | ファイル                           | 概要                                                                                                           |
| -- | ---------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1  | プロジェクト構造       | project-structure.md               | 4層依存グラフ・OpenAI Compatible中間抽象層・共有設定パッケージ・サブパスexportsによるAPI境界制御               |
| 2  | アーキテクチャ         | architecture.md                    | Spec/Utils/Provider/Coreの一方向依存・Proxyベースv2→v3アダプタ・warnings配列によるグレースフルデグラデーション |
| 3  | 設計哲学               | design-philosophy.md               | 最小表面積で最大拡張性・Symbol.forベースのエラー判定・providerOptionsによるOpen-Closed拡張                     |
| 4  | 型システムパターン     | type-system-patterns.md            | 判別共用体によるストリーム型安全・テンプレートリテラル型レジストリ・FlexibleSchemaで多スキーマ統一             |
| 5  | 抽象化パターン         | abstraction-patterns.md            | 4層関心分離・ファクトリ関数の標準化・ミドルウェアによる横断的関心事合成・doプレフィックス境界                  |
| 6  | ストリーミング・非同期 | streaming-and-async-patterns.md    | AsyncIterableStreamデュアルIF・StitchableStreamマルチステップ結合・DelayedPromise遅延解決                      |
| 7  | エラーハンドリング     | error-handling-idioms.md           | Symbol.forマーカーで35+エラークラス統一・safe/unsafeペアAPI・冪等ラップ・isRetryableリトライ制御               |
| 8  | テストプラクティス     | testing-practices.md               | Edge/Nodeデュアルランタイムテスト・test-d.ts型テスト・MSWベーステストサーバーパッケージ                        |
| 9  | API設計                | api-design-practices.md            | experimental_段階的プロモーション・intersection型オプション合成・never型排他パラメータ                         |
| 10 | パフォーマンス         | performance-techniques.md          | Web標準ストリームファースト・DelayedPromise遅延生成・バンドルサイズCIゲート・OOM防止サイズ制限                 |
| 11 | 拡張性メカニズム       | extensibility-mechanisms.md        | プロバイダーレジストリ・透過的ミドルウェアパイプライン・MCP統合・experimental_安定化パイプライン               |
| 12 | ビルド・ツーリング     | build-and-tooling.md               | tsup Dual CJS/ESM・共有tsconfig3プリセット・CIバンドルサイズ+ロード時間自動検証                                |
| 13 | 依存管理               | dependency-management.md           | workspace:*統一管理・Zod3/4 peerDepsデュアルサポート・examples pinned版消費者シミュレーション                  |
| 14 | 開発規約               | dev-conventions.md                 | Prettier+ESLint責務分離・patch-onlyバージョニング・ARTISANAL_MODEバイパス・多層品質ゲート                      |
| 15 | CI/CD                  | ci-cd.md                           | ファサードジョブパターン・Changesets自動リリースチェーン・パフォーマンス閾値CI組み込み                         |
| 16 | AI設定                 | ai-settings.md                     | AGENTS.md→CLAUDE.mdシンボリックリンク・内部知識不信任パターン・段階的コンテキスト注入                          |
| 17 | アダプター実装         | adapter-implementation-patterns.md | 三層アダプター構造(Type A/B/C)・.nullish()防御的スキーマ・(string&{})モデルID型                                |
| 18 | スキーマバリデーション | schema-validation-patterns.md      | FlexibleSchema多ライブラリ統一・secureJsonParseプロトタイプ汚染防止・多段階バリデーションパイプライン          |

## 特に注目すべき知見

- **Symbol.for ベースのエラー型判定パターン**: `instanceof` がパッケージバージョン不一致で壊れる問題を、`Symbol.for(marker)` + `static isInstance()` で構造的に解決している。35 以上のエラークラスに一貫して適用されており、ライブラリ開発では即座に採用すべきプラクティス。（error-handling-idioms, architecture, design-philosophy）

- **AsyncIterableStream + StitchableStream + DelayedPromise によるストリーミング設計**: ReadableStream と AsyncIterable のデュアルインターフェース、マルチステップストリームの結合、ストリーム消費と Promise アクセスの統合という 3 つのパターンの組み合わせは、LLM に限らずあらゆるストリーミングデータフローに応用できる。（streaming-and-async-patterns, performance-techniques）

- **FlexibleSchema による多スキーマライブラリ統一**: Zod 3/4、Standard Schema、素の JSON Schema を union 型 + 条件付き推論型で統一し、`asSchema` でランタイム判別するアプローチは、バリデーションライブラリ移行期のライブラリ設計として汎用的に活用可能。（schema-validation-patterns, type-system-patterns, dependency-management）

- **experimental_ プレフィックスによる段階的 API 安定化**: デストラクチャリングのデフォルト値（`experimental_output, output = experimental_output`）で旧名・新名を同時サポートし、`@deprecated` + codemod で移行パスを提供するパターンは、急速に進化する API の後方互換性維持に有効。（api-design-practices, extensibility-mechanisms）

- **CI でのパフォーマンス閾値ゲート**: バンドルサイズ（560KB 上限）とモジュールロード時間（65-100ms 上限）を CI の必須チェックに組み込み、閾値超過時に修正方法を含むエラーメッセージを出力する設計は、SDK/ライブラリ開発での品質劣化防止として先進的。（ci-cd, build-and-tooling, dev-conventions）

## クイックリファレンス

- [導出ルール集](rules.md) -- CLAUDE.md にそのまま貼り付けて AI コンテキストとして活用
