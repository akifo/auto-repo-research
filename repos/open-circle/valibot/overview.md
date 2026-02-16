# open-circle/valibot

> URL: https://github.com/open-circle/valibot
> Stars: 8.4k | 言語: TypeScript | ライセンス: MIT | 分析日: 2026-02-16

## サマリー

valibot は「ファクトリ関数 + プレーンオブジェクト + Discriminated Union」という設計原則を貫くことで、200以上のモジュールにわたる tree-shaking 完全対応・型安全・ゼロランタイム依存を同時に達成した TypeScript スキーマバリデーションライブラリである。クラスを一切使わずプロトコルベースの多態性（`'~run'` メソッド）で合成可能なパイプラインを構築する手法、Phantom Type による型情報埋め込み、`@__NO_SIDE_EFFECTS__` の全関数への一貫適用、そして ReDoS 防御からプロトタイプ汚染ガードまで含むセキュリティファーストの設計は、バンドルサイズが重要な任意の TypeScript ライブラリ設計に直接応用できるプラクティスの宝庫である。

## 技術スタック

- **言語**: TypeScript 5.9+ (strict + exactOptionalPropertyTypes + isolatedDeclarations)
- **フレームワーク**: なし（ゼロ依存ライブラリ）
- **ビルド**: tsdown (ESM + CJS dual output, minified + unminified の4バリアント)
- **テスト**: Vitest 4.x (ランタイムテスト + 型テスト `--typecheck`)
- **パッケージマネージャ**: pnpm (monorepo workspace)
- **リンター**: ESLint 9 (flat config) + Prettier + eslint-plugin-regexp + eslint-plugin-redos-detector + eslint-plugin-security
- **CI**: GitHub Actions (composite action + workflow_call + pkg.pr.new)
- **レジストリ**: NPM + JSR デュアルパブリッシュ
- **ウェブサイト**: Qwik + Vite (valibot.dev)

## 分析した視点

| #  | 視点                       | ファイル                      | 概要                                                                                                  |
| -- | -------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1  | project-structure          | project-structure.md          | 1機能=1フォルダの4ファイル構成を200以上のモジュールで例外なく適用し、tree-shakingと認知負荷低減を両立 |
| 2  | architecture               | architecture.md               | Schema/Action/Methodの3層をDiscriminated Unionで分類し、統一された'~run'メソッドでパイプライン合成    |
| 3  | design-philosophy          | design-philosophy.md          | ファクトリ関数+プレーンオブジェクトでtree-shakingを最大化し、interface優先とstrict TSで型安全を徹底   |
| 4  | type-system-patterns       | type-system-patterns.md       | Phantom Type・Branded Type・const type parameter・Prettifyなど型レベルプログラミングの体系的活用      |
| 5  | abstraction-patterns       | abstraction-patterns.md       | プレーンオブジェクト+プロトコルメソッド+pipe合成の三位一体でクラスレスな多態性を実現                  |
| 6  | code-organization          | code-organization.md          | Issue型・Schema型・オーバーロード・実装の固定順序と、テストヘルパー集約による語彙の均質化             |
| 7  | api-design-practices       | api-design-practices.md       | 全関数でオーバーロードによる型精度保持と、kind-type-referenceトリプレットの自己記述的API設計          |
| 8  | testing-practices          | testing-practices.md          | ランタイムテストと型テストの1:1対応、8つのドメイン固有ヘルパーによる三段構成の統一テスト戦略          |
| 9  | error-handling-idioms      | error-handling-idioms.md      | Dataset 3状態モデル・非空タプル型issues・6段階メッセージ解決チェーン・flatten変換の一貫設計           |
| 10 | performance-techniques     | performance-techniques.md     | 全関数への@\_\_NO_SIDE_EFFECTS\_\_付与、spread回避、遅延初期化、RegExp ESLintによる多層最適化         |
| 11 | build-and-tooling          | build-and-tooling.md          | tsdownでESM+CJS 4バリアント出力、isolatedDeclarationsで高速型生成、JSR/Deno同一ソース配信             |
| 12 | extensibility-mechanisms   | extensibility-mechanisms.md   | check→rawCheck→rawTransformの段階的拡張ポイントとkindディスクリミネータによるOCP準拠設計              |
| 13 | security-practices         | security-practices.md         | ReDoS三層ESLint防御、\_isValidObjectKeyによるプロトタイプ汚染ガード、オブジェクト再構築パターン       |
| 14 | dev-conventions            | dev-conventions.md            | パッケージリスクに応じた段階的ESLint厳格化と、ツール強制による一貫性担保の多層規約統制                |
| 15 | dependency-management      | dependency-management.md      | コアライブラリのランタイム依存ゼロを徹底し、遅延初期化とimport type活用でバンドルを最小化             |
| 16 | ai-settings                | ai-settings.md                | AGENTS.md(60行)+6スキルファイルの二層Progressive Disclosure設計とESLintとの二重防御                   |
| 17 | ci-cd                      | ci-cd.md                      | composite actionで環境一元管理、workflow_callでCI再利用、NPM+JSRデュアルパブリッシュ                  |
| 18 | metaprogramming-techniques | metaprogramming-techniques.md | Phantom Typeによる型埋め込み、スキーマの代数的変換、ASTベースcodemodの三軸メタプログラミング          |

## 特に注目すべき知見

- **ファクトリ関数 + `@__NO_SIDE_EFFECTS__` による関数単位の tree-shaking**: クラスを一切使わず、全 250 以上のファクトリ関数に `// @__NO_SIDE_EFFECTS__` を付与し、`sideEffects: false` と組み合わせることで、未使用コードの完全な除去を構造的に保証している。getter を含むオブジェクトリテラルにも漏れなく適用する徹底ぶりは、tree-shakeable ライブラリ設計の模範として即座に応用可能。(設計思想 / パフォーマンス / 依存管理)

- **Phantom Type (`'~types'?`) によるゼロコスト型情報埋め込み**: ランタイムには存在しない optional プロパティに型情報を格納し、`NonNullable<T['~types']>['input']` で抽出する手法は、バンドルサイズに一切影響を与えずに `InferInput` / `InferOutput` / `InferIssue` という型ユーティリティを実現する。チルダプレフィックス (`~`) による名前空間分離も含め、型安全な DSL やビルダーパターンに広く転用できる。(型システム / アーキテクチャ / メタプログラミング)

- **ランタイムテスト + 型テストの二層テスト戦略**: 全モジュールに `.test.ts`（ランタイム）と `.test-d.ts`（型推論）を 1:1 で対応させ、8 つのドメイン固有テストヘルパー (`expectSchemaIssue` 等) で三段構成のテストを均質化している。`satisfies` キーワードによるテストデータの二重検証や、`not.toMatchTypeOf` による否定的型テストなど、型安全ライブラリのテスト手法として体系的に参考になる。(テスト / コード組織)

- **セキュリティファーストの設計**: ReDoS 三層防御（eslint-plugin-redos-detector + eslint-plugin-regexp + eslint-plugin-security）、`_isValidObjectKey` によるプロトタイプ汚染ガード、`object` スキーマのホワイトリスト再構築パターン、`strictObject` のリソース枯渇防止（最初の1件で break）など、バリデーションライブラリに求められるセキュリティ対策が構造的に組み込まれている。(セキュリティ / 開発規約)

- **段階的拡張ポイントの設計（Escalating Escape Hatches）**: `check()` (高レベル・制約強) → `rawCheck()` (中レベル・dataset アクセス) → `rawTransform()` (低レベル・値変換+エラー報告) という 3 段階の抽象度で拡張ポイントを提供し、大多数のユーザーは安全な高レベル API で完結しつつ、必要に応じて低レベルに降りられる設計は、ライブラリの拡張性設計として汎用的に適用できる。(拡張性 / API 設計)

## クイックリファレンス

- [導出ルール集](rules.md) — CLAUDE.md に貼れる形式の全ルール
