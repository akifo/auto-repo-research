# drizzle-team/drizzle-orm

> URL: https://github.com/drizzle-team/drizzle-orm
> Stars: 33.1k | 言語: TypeScript | ライセンス: Apache-2.0 | 分析日: 2026-03-04

## サマリー

drizzle-orm は TypeScript の型システムを限界まで活用した SQL ファースト ORM であり、20 以上のデータベースドライバを単一パッケージ内で 4 層レイヤードアーキテクチャと HKT エミュレーションにより型安全に束ねている。`declare` 幽霊プロパティによるゼロコスト型メタデータ、`Symbol.for` ベースの cross-bundle 型識別、タグ付きテンプレートリテラルによる SQL チャンク合成など、TypeScript ライブラリ設計の先端的なプラクティスが凝縮されており、マルチバックエンド対応ライブラリの設計リファレンスとして極めて高い価値を持つ。

## 技術スタック

- **言語**: TypeScript
- **ビルド**: tsup, Turborepo
- **テスト**: Vitest, Docker ベース統合テスト, PGlite
- **パッケージマネージャ**: pnpm (workspace)
- **リンター/フォーマッター**: dprint, ESLint (カスタムプラグイン含む)
- **型チェック**: TypeScript 5.6.3 (strict mode)
- **CI/CD**: GitHub Actions, @arethetypeswrong/cli (attw)

## 分析した視点

| #  | 視点                            | ファイル                           | 概要                                                                                                                         |
| -- | ------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1  | project-structure               | project-structure.md               | ファットコアパッケージ戦略とサブパスエクスポート自動生成で20+ドライバを単一パッケージに統合                                  |
| 2  | architecture                    | architecture.md                    | core/dialect/session/driverの4層レイヤードアーキテクチャでHKTと抽象クラスにより型安全なドライバ差し替えを実現                |
| 3  | design-philosophy               | design-philosophy.md               | SQL構文との1:1対応・0依存・declare型メタデータ・エスケープハッチ提供という4原則で型安全ORM を設計                            |
| 4  | type-system-patterns            | type-system-patterns.md            | declare幽霊プロパティ・交差型による型状態累積・HKTエミュレーション・DrizzleTypeErrorで型推論チェーンを構築                   |
| 5  | adapter-implementation-patterns | adapter-implementation-patterns.md | Dialect/Session/PreparedQueryの3層抽象とNullObjectパターンで20+ドライバの差異を統一的に吸収                                  |
| 6  | composition-patterns            | composition-patterns.md            | SQLWrapperインターフェースによる統一合成とOmitベースの型状態制御でFluent APIの安全性を保証                                   |
| 7  | database-patterns               | database-patterns.md               | テーブル定義を型の単一ソースとし、Session層でドライバを隠蔽しTransaction継承で同一APIを提供                                  |
| 8  | schema-validation-patterns      | schema-validation-patterns.md      | 4バリデーションライブラリを同型構造で並列管理しConditionsオブジェクトでselect/insert/updateの差分を宣言的に制御              |
| 9  | migration-patterns              | migration-patterns.md              | Serialize→Snapshot→Squash→Diff→JSON Statements→SQLの6段パイプラインでZodバージョン管理付きIRを介した方言横断マイグレーション |
| 10 | api-design-practices            | api-design-practices.md            | ビルド時exports自動生成・Symbol.forによる内部API隠蔽・$プレフィックス規約で444ファイルのAPI表面を統制                        |
| 11 | error-handling-idioms           | error-handling-idioms.md           | 3クラスのフラットなエラー階層・DrizzleTypeErrorによる型レベルエラー・ESLintプラグインの三層防御                              |
| 12 | testing-practices               | testing-practices.md               | 全テストを実DB統合テストとし共通テスト関数を10+ドライバで再利用、型テストをランタイムテストにインライン配置                  |
| 13 | build-and-tooling               | build-and-tooling.md               | tsup+tsc並列ビルド・ASTベースのCJS/ESMパス修正・attwによる型正当性ゲートでデュアルパブリッシュを自動化                       |
| 14 | performance-techniques          | performance-techniques.md          | Prepare/Execute分離・バッチパイプライン・NullObjectキャッシュ・テーブルベース自動無効化でゼロコスト抽象を実現                |
| 15 | dependency-management           | dependency-management.md           | 全25+ドライバをoptional peer depsにしworkspace:dist参照とSymbol.forで公開後と同一条件の開発環境を構築                        |
| 16 | metaprogramming-techniques      | metaprogramming-techniques.md      | Zodスキーマ付きバージョン管理IRを軸にDB→中間表現→TypeScriptコードの3層コード生成パイプラインを構築                           |
| 17 | sql-template-abstraction        | sql-template-abstraction.md        | タグ付きテンプレートでSQLをチャンク配列として保持しSQLWrapper統一インターフェースとundefinedスキップで宣言的合成を実現       |
| 18 | dialect-normalization-patterns  | dialect-normalization-patterns.md  | 並列ミラーディレクトリ構造と型タグベースの方言分離で共通APIを維持しつつ方言固有機能を型安全に提供                            |

## 特に注目すべき知見

- **`declare` 幽霊プロパティによるゼロコスト型メタデータ**: `declare readonly _:` パターンで全主要クラスに型情報を保持し、JavaScript 出力に一切影響させずに `$inferSelect` / `$inferInsert` の型導出チェーンを実現する。バンドルサイズとコンパイル時型安全性を両立するテクニックとして、TypeScript ライブラリ全般に応用可能。

- **`Symbol.for` + ESLint 強制による cross-bundle 型識別**: `instanceof` がバンドラーやモノレポ環境で壊れる問題を、`Symbol.for('drizzle:entityKind')` によるグローバルシンボル + プロトタイプチェーン走査の `is()` 関数で解決する。カスタム ESLint ルールで全クラスへの `entityKind` 付与を機械的に強制し、ヒューマンエラーを排除する。npm パッケージを公開するライブラリで広く活用できるパターン。

- **タグ付きテンプレートリテラル + `undefined` スキップによる宣言的 SQL 合成**: SQL をチャンク配列として構造化し、`undefined` チャンクを自動スキップすることで、条件分岐なしに動的クエリを組み立てる。`and()` / `or()` の `undefined` 自動フィルタと組み合わせることで、複雑な動的 WHERE 句をフラットに記述できる。DSL 設計全般に応用可能。

- **Null Object パターンによるゼロコスト横断的関心事**: Logger/Cache/Tracer を全て `NoopLogger` / `NoopCache` でデフォルト無効化し、利用側のコードに条件分岐を一切持ち込まない。20 以上のドライバアダプターが同一コード構造を維持でき、オプショナル機能の追加が既存コードに影響しない。

- **CJS/ESM デュアルパブリッシュの完全自動化パイプライン**: ソースファイル glob からの exports map 自動生成、AST ベースのインポートパス書き換え、ステージングディレクトリによるアトミックスワップ、`@arethetypeswrong/cli` による CI ゲートを組み合わせた、大規模ライブラリの CJS/ESM デュアルパブリッシュのリファレンス実装。

## クイックリファレンス

- [導出ルール集](rules.md) — CLAUDE.md に貼れる形式の全ルール
