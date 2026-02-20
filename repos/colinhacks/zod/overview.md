# colinhacks/zod

> URL: https://github.com/colinhacks/zod
> Stars: 41.9k | 言語: TypeScript | ライセンス: MIT | 分析日: 2026-02-19

## サマリー

Zod v4 は「TypeScript の型推論とバンドルサイズ最適化を両立させる」という本来トレードオフになる二軸を、設計レイヤーの分離によって同時に追求する戦略がコードベース全体を貫くライブラリである。クラス継承を完全に排除したトレイトベースの `$constructor` パターン、`defineLazy` / self-caching getter / `cached` の 3 層遅延評価、`sideEffects: false` + 511 箇所の PURE アノテーションによる tree-shaking 保証、そして core/classic/mini の三層ファサード設計は、スキーマバリデーションに限らず、型安全で高性能な TypeScript ライブラリを構築する際の汎用的なリファレンスとなる。特に「不変 API + 可変内部状態」の分離、構造化エラーの遅延メッセージ解決、段階的開示の拡張 API 設計は、あらゆる TypeScript プロジェクトに応用可能なプラクティスである。

## 技術スタック

- **言語**: TypeScript
- **ビルド**: zshy (カスタム条件付き CJS/ESM デュアルビルド)
- **テスト**: Vitest (型チェック統合、console.log 禁止 setupFile)
- **リンター/フォーマッター**: Biome + Prettier (Markdown のみ)
- **パッケージマネージャ**: pnpm (ワークスペース、hoistWorkspacePackages: false)
- **CI**: GitHub Actions (TypeScript 5.5 + latest マトリクス、循環依存チェック)
- **Git hooks**: Husky (pre-commit: untracked チェック + semver + lint-staged、pre-push: テスト全実行)

## 分析した視点

| # | 視点 | ファイル | 概要 |
| - | ---- | -------- | ---- |
| 1 | project-structure | project-structure.md | 共有カーネル(core)+複数シェル(classic/mini)構成、10サブパスエクスポート、@zod/sourceカスタム条件による開発/本番切替 |
| 2 | architecture | architecture.md | トレイトベース$constructorによるクラス継承排除、core/classic/mini三層ファサード、JITコード生成とdefineLazy遅延評価 |
| 3 | design-philosophy | design-philosophy.md | 型を値から駆動するSSoT思想、不変API+可変内部の分離、パフォーマンスのためのプラグマティックなルール逸脱 |
| 4 | type-system-patterns | type-system-patterns.md | Phantom Propertyによるinput/output分離、インクリメンタル型合成、方向付きブランド型、(string & {})パターン |
| 5 | builder-pattern-and-fluent-api | builder-pattern-and-fluent-api.md | 不変クローンによるfluentチェーン、self-caching getter、mergeDefs記述子レベル合成、Check分離パターン |
| 6 | abstraction-patterns | abstraction-patterns.md | トレイト合成で継承を排除しtree-shaking対応、_zod名前空間への内部状態集約、run/parse二段パイプライン |
| 7 | performance-techniques | performance-techniques.md | payload in-place変更によるアロケーション最小化、JITオブジェクトパース、判別共用体O(1)ルックアップ、ベンチマーク駆動判断 |
| 8 | error-handling-idioms | error-handling-idioms.md | 構造化issueのフラットリスト+パス、4段優先度エラーマップチェーン、Result型デュアルAPI、4種の変換パイプライン |
| 9 | testing-practices | testing-practices.md | ランタイムと型テストの同一ファイル統合、インラインスナップショット限定、console禁止setupFile、TS複数バージョンCI |
| 10 | api-design-practices | api-design-practices.md | string&#x7C;ParamsObjectパラメータ正規化、parse/safeParseデュアルAPI、Class注入ファクトリ、@deprecated移行パターン |
| 11 | extensibility-mechanisms | extensibility-mechanisms.md | refine→superRefine→check→$constructorの段階的開示、Checkファーストクラスオブジェクト化、codecによる双方向パース |
| 12 | dependency-management | dependency-management.md | defineLazy/cached/self-caching getterの3層遅延評価、import type徹底、madge --circular CI防御、barrel回避 |
| 13 | build-and-tooling | build-and-tooling.md | zshy(tsc API)によるデュアルビルド、attw型解決検証、stub package.json自動生成、多層パッケージ品質ゲート |
| 14 | versioning-strategy | versioning-strategy.md | サブパスエクスポートによるv3/v4共存、compat.tsの@deprecated移行レイヤー、三重バージョン整合性チェック |
| 15 | tree-shaking-optimization | tree-shaking-optimization.md | sideEffects:false+@\_\_PURE\_\_/@\_\_NO\_SIDE\_EFFECTS\_\_の体系的適用、classic/miniバリアント分離、treeshakeテストパッケージ |
| 16 | dev-conventions | dev-conventions.md | Biome off設定に理由コメント義務化、pre-commit高速チェック/pre-pushテストの2段フック、fail-on-console機構 |
| 17 | ai-settings | ai-settings.md | CLAUDE.md→AGENTS.mdシンボリックリンク統一、llms.txt/llms-full.txt段階的コンテキスト、CI最小権限レビュー |
| 18 | internationalization-patterns | internationalization-patterns.md | ファクトリ関数ロケール遅延生成、4段優先度メッセージ解決チェーン、言語固有辞書構造の柔軟設計、個別サブパスエクスポート |

## 特に注目すべき知見

- **トレイトベース `$constructor` パターン**: クラス継承を完全に排除し、`init()` メソッドの連鎖呼び出しで振る舞いを合成する。`Symbol.hasInstance` をオーバーライドしてトレイト名ベースの `instanceof` を実現しつつ、各トレイトが独立して tree-shake 可能になる。JavaScript の単一継承制約とバンドルサイズ最適化を同時に解決する汎用的な設計パターンである。（architecture, abstraction-patterns）

- **不変 API + 可変内部状態の分離**: 公開 API のメソッドチェーンは全て `clone()` で新インスタンスを返す不変設計にしつつ、ホットパス（バリデーション実行）では `payload.value` を直接書き換える可変処理でアロケーションを最小化する。API 契約と内部最適化を明確なレイヤーで分離する思想は、パフォーマンス要件のあるライブラリ全般に適用可能である。（design-philosophy, builder-pattern-and-fluent-api, performance-techniques）

- **構造化エラーの遅延メッセージ解決**: バリデーションエラーをフラットな issue リスト（コード + パス + メタデータ）で蓄積し、人間可読メッセージは消費時に 4 段優先度チェーン（スキーマ > パース > グローバル > ロケール）で遅延解決する。これにより、同一スキーマの異なるロケールでの再利用、フォーム/CLI/API 向けの 4 種の変換パイプライン、50 以上の言語サポートが単一の設計で実現されている。（error-handling-idioms, internationalization-patterns）

- **`@zod/source` カスタム条件による開発/本番切替**: `package.json` の `exports` にカスタム条件を仕込み、vitest / tsx / tsconfig / VSCode の全ツールで一貫して使用することで、開発時はソース TypeScript を直接参照しビルドを省略、公開時はデュアルモジュール成果物を提供する。モノレポ内の DX とパッケージ品質を両立させる実践的なパターンである。（project-structure, build-and-tooling）

- **消費者視点の多層品質検証**: attw による全サブパスの型解決検証、3 つの `moduleResolution` 設定でのコンパイルテスト、独立ワークスペースでの tree-shaking サイズ計測、主要エコシステム（drizzle-zod, AI SDK）との型互換テストなど、「ライブラリの消費者が実際に遭遇する問題」を CI で構造的に検出する仕組みは、npm パッケージを公開する全てのプロジェクトに適用可能である。（project-structure, build-and-tooling, versioning-strategy）

## クイックリファレンス

- [導出ルール集](rules.md) — CLAUDE.md に貼れる形式の全ルール
