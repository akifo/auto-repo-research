# Effect-TS/effect

> URL: https://github.com/Effect-TS/effect
> Stars: 13.2k | 言語: TypeScript | ライセンス: MIT | 分析日: 2026-02-18

## サマリー

Effect-TS/effect は TypeScript に関数型エフェクトシステムを持ち込む大規模ライブラリであり、30+ パッケージのモノレポ全体を通じて「型安全性をランタイムコストなしで最大化する」という一貫した設計哲学を貫いている。`Effect<A, E, R>` の三型パラメータモデルを核に、依存性注入・エラーハンドリング・並行処理・ストリーミング・スキーマバリデーションのすべてを型レベルで追跡・合成する仕組みが体系的に構築されており、大規模 TypeScript ライブラリの設計パターン、高度な型レベルプログラミング技法、モノレポの構造的品質管理のプラクティスを広範に学ぶことができる。

## 技術スタック

- **言語**: TypeScript
- **フレームワーク**: 独自エフェクトシステム（Scala ZIO / Haskell IO の TypeScript 移植）
- **ビルド**: tsc + Babel (annotate-pure-calls, transform-modules-commonjs) + @effect/build-utils
- **テスト**: Vitest + @effect/vitest (it.effect パターン) + tstyche (型テスト) + fast-check (プロパティベーステスト)
- **パッケージマネージャ**: pnpm (workspace) + changesets
- **リンター**: ESLint + @effect/eslint-plugin + dprint
- **CI**: GitHub Actions (6 ワークフロー, 4 シャード並列テスト)

## 分析した視点

| #  | 視点                   | ファイル                    | 概要                                                                                                            |
| -- | ---------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1  | プロジェクト構造       | project-structure.md        | pnpm workspace 基盤の4層モノレポで、exports null による内部モジュール封鎖と madge 循環検出で構造を保護          |
| 2  | アーキテクチャ         | architecture.md             | Tag/Layer/Context の DI 三角形と public/internal 2層分離で、30+ パッケージの一方向依存を実現                    |
| 3  | 設計思想               | design-philosophy.md        | 計算の記述と実行の分離、dual API、ジェネレータ構文モナドで FP を TypeScript に自然に翻訳                        |
| 4  | 型システムパターン     | type-system-patterns.md     | TypeLambda/Kind による HKT エミュレーションと分散ファントム型で型安全性をランタイムコストなしに実現             |
| 5  | Effect モデル          | effect-model.md             | never デフォルトの三型パラメータで成功・エラー・依存を union 合成し、段階的型付けを実現                         |
| 6  | 依存性注入             | dependency-injection.md     | Tag + Layer + MemoMap による型追跡 DI で、自動メモ化・スコープ付きリソース管理・テスト差し替えを統合            |
| 7  | エラーハンドリング     | error-handling-idioms.md    | Cause ツリーによるロスレスエラーモデルと _tag+reason 二層分類で型安全なエラーディスパッチを実現                 |
| 8  | 並行処理パターン       | concurrency-patterns.md     | 構造的並行処理・uninterruptibleMask・Scope LIFO ファイナライザで割り込み安全なリソース管理を実現                |
| 9  | 抽象パターン           | abstraction-patterns.md     | Symbol ベースのプロトコルとプロトタイプ合成で 177+ モジュールに横断的振る舞いを一括付与                         |
| 10 | コード生成             | code-generation.md          | package.json exports から barrel file を自動生成し、ESLint 統合で生成コードの鮮度を CI で保証                   |
| 11 | パフォーマンス技法     | performance-techniques.md   | Monomorphic shape・HAMT・Chunk ロープ・トランジェントミューテーション・ハッシュキャッシュで高スループットを実現 |
| 12 | テストプラクティス     | testing-practices.md        | it.effect/it.scoped による Effect ライフサイクル統合テストと Schema→Arbitrary 自動導出で型安全テストを実現      |
| 13 | API 設計               | api-design-practices.md     | dual 関数で data-first/data-last 両対応、Refinement 優先オーバーロードと namespace re-export で API を統一      |
| 14 | ストリーミング         | streaming-patterns.md       | Channel 統一抽象の上に Stream/Sink を構築し、Chunk バッチ転送と pull-based バックプレッシャーを実現             |
| 15 | スキーマバリデーション | schema-validation.md        | AST を単一の真実の源泉とし、Parser/JSONSchema/Pretty/Arbitrary を独立インタプリタとして導出                     |
| 16 | 拡張性メカニズム       | extensibility-mechanisms.md | Tag/Layer DI と dual-tag パターンで 10+ SQL ドライバ・3 プラットフォームを型安全に差し替え可能に                |
| 17 | 開発規約               | dev-conventions.md          | dprint ESLint 統合・codegen 差分チェック・tstyche 型テスト・4 シャード並列 CI で品質ゲートを多層化              |
| 18 | AI 設定                | ai-settings.md              | コマンドベースの検証手順・scratchpad サンドボックス・.repos 知識注入で AI エージェント開発環境を構築            |

## 特に注目すべき知見

- **dual 関数による data-first/data-last 二重 API**: arity ベースの分岐で単一実装から両スタイルを導出し、593 箇所で統一適用。pipe チェーンと直接呼び出しの両方を型安全にサポートする汎用パターンとして、どの TypeScript ライブラリでも即座に導入可能。

- **`_tag` + `reason` 二層エラー分類**: エラー型に `_tag` リテラル型で種類を、`reason` リテラルユニオンで原因を持たせる設計。`catchTag` による型安全ディスパッチと `Exclude` による処理済みエラーの型除去を組み合わせ、エラーの網羅性を型システムに委ねる。Result/Either ベースのエラーハンドリングを採用するプロジェクト全般に応用可能。

- **`exports: { "./internal/*": null }` による API 境界の物理的封鎖**: package.json の exports フィールドで内部モジュールを Node.js レベルでブロックし、ESLint ルールでバレル import を禁止する多層防御。ライブラリの公開 API と内部実装の分離を、コードレビューではなくツーリングで強制する実践パターン。

- **Symbol.for + hasProperty による instanceof 代替型判定**: CJS/ESM 混在環境やバンドラーによるモジュール重複で `instanceof` が壊れる問題を、`Symbol.for("effect/TypeName")` のグローバルシンボルレジストリと `hasProperty` 型ガードで解決。TypeScript ライブラリの型判定で広く適用可能な堅牢なパターン。

- **AST + Match 型による拡張可能なインタプリタパターン**: Schema の AST を tagged union として定義し、`Match<A>` 型で全ノードに対するハンドラを強制する `getCompiler` ヘルパーを提供。新しいインタプリタの追加がコンパイル時に網羅性チェックされ、5行で新しいコンパイラを構築できる。DSL やバリデーションライブラリの設計に直接応用可能。

## クイックリファレンス

- [導出ルール集](rules.md) — CLAUDE.md に貼れる形式の全ルール
