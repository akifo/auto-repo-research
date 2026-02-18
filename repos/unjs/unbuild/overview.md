# unjs/unbuild

> URL: https://github.com/unjs/unbuild
> Stars: 2.7k | 言語: TypeScript | ライセンス: MIT | 分析日: 2026-02-18

## サマリー

unbuild は「設定をどう構造化し、どう合成するか」の実践的リファレンスとして優れたリポジトリである。4つの異なるビルドバックエンド（Rollup, mkdist, untyped, copy）を統一シグネチャ `(ctx: BuildContext) => Promise<void>` で束ね、package.json からのゼロコンフィグ自動推論と `defu` による5層設定マージで「書かなくても動く、書けば何でもできる」体験を実現している。TypeScript の型設計においても、`DeepPartial` による入力型と確定型の分離、`satisfies` によるデフォルト値の網羅性保証、`OptionType | false` による宣言的な機能無効化など、ライブラリ設定 API の型安全な設計パターンが凝縮されている。

## 技術スタック

- **言語**: TypeScript (ESModule, strict mode)
- **フレームワーク**: なし（CLI ツール）
- **ビルド**: Rollup, esbuild, mkdist, jiti (self-build)
- **テスト**: vitest + v8 coverage
- **パッケージマネージャ**: pnpm 10.x
- **主要依存**: defu, hookable, jiti, pathe, mlly, pkg-types, consola, citty

## 分析した視点

| # | 視点 | ファイル | 概要 |
| - | ---- | -------- | ---- |
| 1 | プロジェクト構造 | project-structure.md | 浅い階層+責務境界の明確化、型のco-location+集約re-export、統一インターフェースによるビルダー分離 |
| 2 | アーキテクチャ | architecture.md | 3層パイプライン（CLI→オーケストレーション→ビルダー）、統一シグネチャによるビルダー直交性、フック駆動の拡張設計 |
| 3 | 設計思想 | design-philosophy.md | Convention over Configuration、package.jsonからの自動推論、self-buildによるdogfooding、警告のデフォルトエラー化 |
| 4 | 抽象化パターン | abstraction-patterns.md | defuによる5層マルチソースマージ、DeepPartialと確定型の分離、OptionType\|falseによる宣言的無効化 |
| 5 | 型システムパターン | type-system-patterns.md | discriminated unionによるビルダー分岐、satisfiesによるデフォルト網羅性検証、フック型のinterface合成 |
| 6 | 設定パターン | configuration-patterns.md | ゼロコンフィグ+フルコンフィグの両立、defineBuildConfigヘルパーによる型推論、プリセット機構の多形的解決 |
| 7 | フック・ライフサイクル | hook-and-lifecycle-patterns.md | 線形ライフサイクル+名前空間付きフック、型安全なhookable統合、3層フック登録の優先度モデル |
| 8 | コード生成技法 | code-generation-techniques.md | 1-build-multi-writeによるESM/CJS/DTS同時出力、MagicStringによるAST-less変換、jitiスタブ生成 |
| 9 | 依存関係管理 | dependency-management.md | package.json駆動のexternal自動推論、暗黙バンドルへの警告+failOnWarn、unjsエコシステムの一貫採用 |
| 10 | テストプラクティス | testing-practices.md | 決定ロジックの純粋関数化+ユニットテスト、ミニチュアプロジェクト型fixture、self-buildによる暗黙的統合テスト |

## 特に注目すべき知見

- **`satisfies` によるデフォルト値の網羅性保証**: デフォルト値オブジェクトに `satisfies BuildOptions` を付与し、型の全フィールドを網羅しているかコンパイル時に検証する。`as` アサーションと異なり型推論を保持し、新フィールド追加時のデフォルト値定義漏れを即座に検出できる。設定オブジェクトを扱うあらゆるライブラリに適用可能。

- **`OptionType | false` による宣言的なプラグイン無効化**: プラグイン設定を `PluginOptions | false` のユニオン型で定義し、`false` で完全無効化、オブジェクトでカスタマイズ、`undefined` でデフォルト使用という三状態を単一フィールドで型安全に表現する。`enabled: boolean` フラグを別途持つ設計よりも簡潔で、条件付き配列 + `filter(Boolean)` で宣言的にプラグインを合成できる。

- **`DeepPartial` によるユーザー入力型と内部確定型の分離**: ユーザー向け設定型（`BuildConfig`）を `DeepPartial` で全フィールドオプショナルに、内部処理型（`BuildOptions`）を全フィールド必須にすることで、ユーザーの DX（最小限の設定で動作）と内部コードの型安全性を両立する。`defineBuildConfig` ヘルパー関数（実質 identity 関数）で IDE 補完を提供するパターンも汎用的。

- **フック型のコロケーション + interface 合成**: 各ビルダーが自身のフック型をローカルの `types.ts` に定義し、トップレベルの `BuildHooks` が `extends` で合成する。`namespace:action` 形式の命名規約でキー衝突を防ぎつつ、`Hookable<BuildHooks>` のジェネリクスでフック名・引数の型安全性をコンパイル時に保証する。プラグインアーキテクチャの型設計として即座に応用可能。

- **決定ロジックの純粋関数化によるテスタビリティ確保**: ビルドツールの中核ロジック（エントリ推論、依存関係バリデーション、export 型推論）を I/O 非依存の純粋関数として抽出し、高速かつ決定的なユニットテストを実現する。変換ロジック全体のテストは self-build と CI パイプラインの順序（build → test）で暗黙的にカバーする二層戦略。

## クイックリファレンス

- [導出ルール集](rules.md) — CLAUDE.md に貼れる形式の全ルール
