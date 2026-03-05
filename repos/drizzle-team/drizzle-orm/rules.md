# drizzle-team/drizzle-orm — 導出ルール集

> 出典: repos/drizzle-team/drizzle-orm/ | 生成日: 2026-03-04
> 用途: CLAUDE.md にそのまま貼り付けて AI コンテキストとして活用

## アーキテクチャ・レイヤー設計

- `[MUST]` レイヤードアーキテクチャでは依存方向を厳格に一方向に保つ -- 上位レイヤーは抽象型のみに依存し、下位レイヤーの具象クラスを直接 import しない
  - 根拠: architecture — PgDatabase は PgSession 抽象クラスのみを参照し、20+ ドライバを dialect 変更なしで追加可能
- `[MUST]` 多数のバックエンド実装を束ねるアダプター層では、各アダプターが実装すべき最小契約を abstract メソッドで定義し、共通フローはデフォルト実装を持つ基底クラスに置く（Template Method パターン）
  - 根拠: adapter-implementation-patterns — `prepareQuery` + `transaction` の 2 メソッドのみ abstract とし、20+ アダプターが共通の `execute`/`all`/`count` を再利用
- `[MUST]` 多方言/多バリアント対応のシステムでは、各バリアントのディレクトリ構造を並列ミラーにし、同一のファイル名・モジュール構成を維持する
  - 根拠: dialect-normalization-patterns — pg-core/mysql-core/sqlite-core が同一構造を持ち、方言追加時のテンプレート化と変更影響範囲の特定が容易
- `[MUST]` バリアント固有の機能は基底クラスに条件分岐を持ち込まず、バリアント固有のサブクラスまたはモジュールで拡張する
  - 根拠: dialect-normalization-patterns — MySQL の autoincrement は MySQL 固有の中間クラスで追加し、基底 ColumnBuilder を汚染しない
- `[SHOULD]` 外部ライブラリをラップする際は、すべてのアダプターに同一のファイル構成とコンストラクタシグネチャを適用する
  - 根拠: architecture, adapter-implementation-patterns — 全ドライバが `driver.ts`/`session.ts`/`migrator.ts` の3ファイル構成、Session が `(client, dialect, schema, options)` の 4 引数パターンを統一
- `[SHOULD]` 多バリアント対応では「API の統一」より「方言固有 API の型安全な提供」を優先し、存在しない機能をランタイムエラーではなくコンパイルエラーで排除する
  - 根拠: dialect-normalization-patterns — MySQL に `returning()` を生やさず `$returningId()` を提供し、誤用を型レベルで防止
- `[AVOID]` インターフェースが定義する操作をサポートしないアダプターで、実行時例外を投げる実装にする -- 型レベルで capability を表現する方が望ましい
  - 根拠: adapter-implementation-patterns — neon-http 等が `transaction()` で throw するが、コンパイル時には検出できない
- `[AVOID]` 横断的関心事（ログ、キャッシュ、トレーシング等）を各実装にコピーする -- 共通基底または mixin に抽出する
  - 根拠: architecture — `queryWithCache` が 3 方言の PreparedQuery にほぼ同一コードで重複

## 型システム設計

- `[MUST]` 型レベル専用の情報は `declare` で宣言し、ランタイムプロパティと明確に分離する
  - 根拠: type-system-patterns — 全主要クラス（Table, Column, SQL 等 27 箇所以上）が `declare readonly _` で型メタデータを保持し、JS 出力に影響しない型推論チェーンを実現
- `[MUST]` メソッドチェーンで型状態を変更する場合、交差型 `T & { flag: true }` で累積し、条件型 `T extends { flag: true } ? A : B` で読み取る
  - 根拠: type-system-patterns — `NotNull<T>`, `HasDefault<T>` 等がこのパターンで実装され、insert 時の必須/オプショナル判定に使用
- `[SHOULD]` 型エラー時は `never` ではなくカスタムエラー型（`{ $error: "メッセージ" }`）を返してユーザーに修正方法を提示する
  - 根拠: type-system-patterns, error-handling-idioms — `DrizzleTypeError<T>` が 20 箇所以上で使用され、IDE 上に具体的なエラーメッセージを表示
- `[SHOULD]` 深い交差型やジェネリクスの結果は `Simplify<T>` パターン（`{ [K in keyof T]: T[K] } & {}`）で平坦化し、IDE のホバー表示を読みやすく保つ
  - 根拠: type-system-patterns — 複雑な型の出力に `Simplify` を適用してデバッグコストを削減
- `[SHOULD]` 一度だけ呼ぶべきメソッドの戻り値型では `Omit<this, 'methodName'>` で自身を除去し、二重呼び出しをコンパイルエラーにする
  - 根拠: type-system-patterns, composition-patterns — `PgSelectWithout` が `.where()` 等の二重呼び出しを防止
- `[SHOULD]` TypeScript で HKT が必要な場面では、ブランド付きインターフェース + intersection による型特殊化パターンを使う -- ただし複雑さのトレードオフを認識した上で採用する
  - 根拠: architecture — `PgQueryResultHKT` パターンによりドライバ固有の結果型を型安全に伝播
- `[AVOID]` ビルダーの型パラメータを 5 個以上に増やすこと -- コンパイル時間が増加しエラーメッセージが解読困難になる。config 型への集約を検討する
  - 根拠: database-patterns — `PgSelectBase` は 8 個の型パラメータを持ち、エラーメッセージが数百文字になることがある
- `[AVOID]` 多方言対応で条件型の分岐を 5 段以上ネストする -- ルックアップ型（マッピングオブジェクト型）でディスパッチテーブルを作り、条件型のネストを減らす
  - 根拠: type-system-patterns — `BuildColumn` は 6 方言の分岐を条件型チェーンで実装しており、方言追加のたびに分岐が増加

## `instanceof` 代替と型判定

- `[MUST]` npm パッケージとして公開するライブラリでは `instanceof` の代わりに `Symbol.for()` ベースの型識別を採用する -- バンドラーやモノレポ環境で `instanceof` は壊れやすい
  - 根拠: architecture, design-philosophy, entity.ts — `entityKind` Symbol と `is()` 関数で全エンティティの型チェックを行い、cross-bundle 環境でも安全に動作
- `[SHOULD]` 設計規約（型タグ、命名規則等）をカスタム ESLint ルールで機械的に強制する（ドキュメントやコードレビューに頼らない）
  - 根拠: project-structure — `require-entity-kind` ルールが全クラスの `entityKind` 宣言を強制し、auto-fix 付きで導入コストも低い

## エラーハンドリング

- `[MUST]` ライブラリ境界でキャッチしたエラーは `cause` チェーンで元エラーを保持してから再 throw する -- 元エラーを握りつぶすとデバッグが著しく困難になる
  - 根拠: error-handling-idioms — `DrizzleQueryError` は `cause` プロパティで元のドライバエラーを保持し、`Error.captureStackTrace` でラッパーフレームを除去
- `[MUST]` カスタムエラークラスにはデバッグに必要な構造化コンテキスト（入力値、クエリ文字列等）をプロパティとして保持する -- `message` 文字列のパースに頼らせない
  - 根拠: error-handling-idioms — `DrizzleQueryError` は `query` と `params` をパブリックプロパティとして公開
- `[SHOULD]` API の誤用パターンが型システムで表現可能なら、ランタイムチェックではなく条件付き型でコンパイル時エラーにする
  - 根拠: error-handling-idioms — `DrizzleTypeError<T>` で `.returning()` 未呼び出し等を型レベルで検出
- `[SHOULD]` 型で防げないが致命的な結果をもたらす操作には ESLint ルール等のリンターで安全ネットを設ける
  - 根拠: error-handling-idioms — `eslint-plugin-drizzle` の `enforce-delete-with-where` が全行削除を防止
- `[SHOULD]` コールバック型 API で中断シグナルが必要な場合、専用の例外クラスを `never` 戻り値型で throw するパターンを使う
  - 根拠: error-handling-idioms — `rollback(): never` が `TransactionRollbackError` を throw し、トランザクション catch ブロックを一本化
- `[AVOID]` エラークラスの階層を深くしすぎる -- ランタイムエラーの分類は 3-5 種類程度に抑え、エラーの詳細は `cause` チェーンとプロパティで表現する
  - 根拠: error-handling-idioms — 全データベース方言を 3 クラスのみで統一的に扱い、ドライバ固有のエラーは `cause` に委譲

## DSL・合成パターン

- `[MUST]` 合成可能な DSL を設計する際は、すべての構成要素に共通の合成インターフェース（`getSQL()` のような変換メソッド）を実装し、どの位置にも埋め込み可能にする
  - 根拠: composition-patterns — `SQLWrapper` インターフェースにより Table, Column, Subquery, SQL 式がすべて同じ方法で合成可能
- `[MUST]` 条件的合成では `undefined` を「不在」のシグナルとして使い、合成関数側で自動フィルタする -- 呼び出し側に `if` 分岐を強制しない
  - 根拠: composition-patterns, sql-template-abstraction — `and()`/`or()` が `undefined` をフィルタし、`SQL.if()` が falsy で `undefined` を返す
- `[MUST]` SQL テンプレートシステムでは補間値を文字列結合ではなくパラメータ化チャンクとして保持し、文字列化を最終出力時まで遅延させる
  - 根拠: sql-template-abstraction — `SQL` クラスにチャンク配列を持たせ、`toQuery()` 時に方言差異の吸収とパラメータ化を一元化
- `[MUST]` API が既知のドメイン言語（SQL, CSS, HTML 等）に対応する場合、その構文順序と命名をそのまま反映させる
  - 根拠: design-philosophy — `select().from().where().orderBy()` が SQL 句順と一致し、学習コストをゼロに
- `[SHOULD]` Fluent API をヘルパー関数に分割して渡す場合は、型制約を解除するエスケープハッチ（`$dynamic()` のような仕組み）を提供する
  - 根拠: composition-patterns — `$dynamic()` が `TDynamic = true` に切り替えて型制約をバイパス
- `[SHOULD]` ビルダーオブジェクトが「構築中」と「実行可能」の 2 つの段階を持つ場合、段階ごとに別クラスまたは別型を使い、不完全な状態での実行をコンパイル時に防ぐ
  - 根拠: composition-patterns — `PgSelectBuilder`（from 未指定）と `PgSelectBase`（from 指定済み）が別クラスに分離
- `[AVOID]` SQL テンプレートの合成で生文字列を直接結合する -- 必ず構造化されたチャンク列を介して合成し、パラメータバインディングを維持する
  - 根拠: composition-patterns — `sql.raw()` はエスケープなしのため SQL インジェクションの危険がある

## オプショナル機能・横断的関心事

- `[MUST]` オプショナルな横断的関心事（ロギング、キャッシュ、トレーシング等）は Null Object パターンでデフォルト無効にし、利用側コードから条件分岐を排除する
  - 根拠: adapter-implementation-patterns, performance-techniques — 全アダプターが `NoopLogger`/`NoopCache` で初期化し、PreparedQuery 内で null チェックなしに呼び出す
- `[MUST]` mutation 操作時のキャッシュ無効化はクエリ実行と並列に行い、レイテンシの直列加算を避ける
  - 根拠: performance-techniques — `Promise.all([query(), this.cache.onMutate(...)])` で並列発火
- `[SHOULD]` 繰り返し実行するクエリは prepare/execute の 2 フェーズに分離し、DB 側のクエリプラン再利用を有効にする
  - 根拠: performance-techniques — `prepare(name)` で PostgreSQL の named prepared statement としてサーバー側にキャッシュ
- `[SHOULD]` オプショナルな計装（トレーシング・ロギング）はモジュール存在チェック + 即時フォールバックで実装し、未使用時のランタイムコストをなくす
  - 根拠: performance-techniques — `if (!otel) { return fn() }` によりゼロコストフォールバック

## パッケージ管理・ビルド

- `[MUST]` CJS/ESM デュアルパブリッシュ時は、CI に `@arethetypeswrong/cli`（attw）検証を組み込み、型解決の正当性をリリースゲートにする
  - 根拠: build-and-tooling, dependency-management — 全 8 パッケージに対して attw を CI 必須ゲートとし、release ジョブが attw の成功に依存
- `[MUST]` モノレポでビルド成果物を他パッケージが参照する場合、ステージングディレクトリでビルドし、完了後にアトミックにリネームする
  - 根拠: build-and-tooling — `dist.new` → `dist` アトミックスワップでビルド途中の壊れた dist を参照するリスクを排除
- `[MUST]` ライブラリが複数の外部パッケージとの統合をサポートする場合、全てを optional な peerDependencies として宣言し、サブパスエクスポートでアダプタを分離する
  - 根拠: dependency-management, design-philosophy — 25+ ドライバを全て optional peer deps にし、ユーザーが必要なドライバだけをインストール
- `[SHOULD]` エントリポイントが多数あるパッケージの exports map は、ソースディレクトリから自動生成する
  - 根拠: build-and-tooling, api-design-practices — `src/**/*.ts` から exports map をビルド時に自動生成し、手動管理のコストとエラーを排除
- `[SHOULD]` CJS/ESM デュアルパブリッシュでインポートパスの拡張子を変換する場合は、正規表現ではなく AST 走査を使う
  - 根拠: build-and-tooling — recast で全ノード型を網羅し、正規表現では見逃しうるパターンを確実に変換
- `[SHOULD]` 大規模パッケージでは tsup の DTS 生成を使わず、tsc で型定義を別途生成して並列実行する
  - 根拠: build-and-tooling — tsup と tsc を `Promise.all` で並列実行し、tsup は JS トランスパイル、tsc は型生成に責務を分離
- `[SHOULD]` モノレポ内のパッケージ間参照では dist ディレクトリを直接指し、ビルド成果物で開発・テストする
  - 根拠: dependency-management — `workspace:./drizzle-orm/dist` で開発中に npm publish 後と同じ条件でテスト
- `[SHOULD]` フォーマッタ（dprint/Prettier）とリンタ（ESLint）は責務を分離し、フォーマッタはコードスタイル、リンタは意味的ルールに集中させる
  - 根拠: build-and-tooling — dprint がスタイル強制、ESLint が `no-instanceof`, `require-entity-kind` 等に専念
- `[AVOID]` 全ソースファイルを無条件に exports map に含める設計 -- 内部ユーティリティが公開 API 扱いになり、semver 管理が困難になる
  - 根拠: api-design-practices — `src/**/*.ts` の glob で内部モジュールもサブパスとして公開されている問題
- `[AVOID]` peer deps のメジャーバージョン移行時に旧バージョンのサポートを即座に切り捨てる -- OR 指定（`^3.25.0 || ^4.0.0`）でユーザーに移行猶予を与える
  - 根拠: dependency-management — drizzle-zod が Zod v3/v4 の両方をサポート

## テスト

- `[MUST]` マルチドライバ/マルチプロバイダライブラリのテストでは、共通テストロジックを関数としてエクスポートし、ドライバ固有ファイルは接続確立とコンテキスト注入のみに責任を持たせる
  - 根拠: testing-practices — pg-common.ts の `tests()` を 10+ ドライバ固有テストから呼び出し、テストケースの重複を回避
- `[MUST]` 統合テストでは各テスト前にデータベース状態を完全にリセットする（DROP + 再作成）-- テスト間の暗黙の状態共有を排除する
  - 根拠: testing-practices — `beforeEach` で `drop schema if exists public cascade` → 再作成を毎回実行
- `[SHOULD]` Docker コンテナのプログラム的管理では、ランダムポート割り当て + UUID コンテナ名 + AutoRemove を組み合わせて並列実行安全性を確保する
  - 根拠: testing-practices — `getPort()` + UUID + `AutoRemove: true` の 3 点セットが全 DB 方言で採用
- `[SHOULD]` 型テスト（推論結果の検証）はランタイムテストと同一ファイル・同一テストケース内にインラインで記述する -- 型テストを分離すると値の変更に伴う型の退行を見逃す
  - 根拠: testing-practices — `Expect<Equal<>>` と `expectTypeOf` がランタイム `expect()` と同じ `test()` ブロック内に配置
- `[SHOULD]` スキーマ検証など I/O 依存が小さいテストでは PGlite 等の in-process DB を使って Docker 不要で高速に実行する
  - 根拠: testing-practices — drizzle-kit は PGlite で introspect テストを実行し、Docker ベーステストと戦略を使い分け
- `[AVOID]` Docker コンテナの起動待機に固定 `setTimeout` を使うこと -- リトライベースのヘルスチェックを使い、環境差によるフレーキーテストを防ぐ
  - 根拠: testing-practices — PostgreSQL テストは `async-retry` を使うが、MySQL テストは固定待機に依存しフレーキーリスクあり

## スキーマ・バリデーション・マイグレーション

- `[MUST]` データベーススキーマ定義を型の単一ソースにする場合、テーブル定義からクエリ結果型を条件付き型で導出し、手動の型定義との二重管理を排除する
  - 根拠: database-patterns — `InferSelectModel` / `InferInsertModel` を `Table['_']['columns']` から導出
- `[MUST]` マイグレーション生成パイプラインでは、元のスキーマ定義と SQL 出力の間に方言非依存の中間表現（IR）を設ける
  - 根拠: migration-patterns — JSON スナップショット → squashed 表現 → JSON ステートメントの 3 層 IR により、差分検出ロジックを 4 方言で共有
- `[MUST]` スキーマ状態の永続化形式にはバージョン番号を含め、Zod 等のバリデーションスキーマで各バージョンの構造を厳密に定義する
  - 根拠: migration-patterns, metaprogramming-techniques — `pgSchemaV1` 〜 `pgSchemaV7` の Zod リテラル型定義と `backwardCompatiblePgSchema = union([v5, v6, v7])`
- `[MUST]` コード生成の中間表現にはランタイムバリデーションを付与し、`.strict()` 等で想定外のフィールドを拒否する
  - 根拠: metaprogramming-techniques — 全ての中間表現 Zod スキーマに `.strict()` を適用
- `[SHOULD]` バリデーションスキーマから型を導出し（`z.infer` / `TypeOf`）、スキーマと型の二重管理を避ける
  - 根拠: metaprogramming-techniques — `export type Column = TypeOf<typeof column>` で全型を Zod スキーマから導出
- `[SHOULD]` 操作モードごとの振る舞い差分は、条件分岐のハードコードではなく、述語関数のレコード（Strategy オブジェクト）として宣言的に定義する
  - 根拠: schema-validation-patterns — `Conditions` インターフェース（`{ never, optional, nullable }` の 3 述語）でモード追加がデータ追加のみで完結
- `[SHOULD]` カスタマイズ API は「既存スキーマの拡張（関数）」と「スキーマ全体の差し替え（値）」の 2 モードを提供する
  - 根拠: schema-validation-patterns — refinement が関数なら既存スキーマをパイプラインで拡張し、値ならスキーマ全体を差し替え
- `[SHOULD]` 初回実行と 2 回目以降のコードパスを統一するために、空の初期状態をデフォルト値として定義する
  - 根拠: migration-patterns — `dryPg` が空テーブルの合法スキーマとして初回マイグレーション生成の特殊分岐を排除

## API 設計

- `[MUST]` ライブラリのランタイム依存は 0 に保ち、外部ライブラリはすべて optional な peer dependency として宣言する
  - 根拠: design-philosophy — `package.json` に `"dependencies"` フィールドが存在せず、全ドライバが optional 指定
- `[SHOULD]` ライブラリの内部プロパティは `Symbol.for('namespace:key')` で定義し、通常のプロパティ列挙やオートコンプリートから隠蔽する
  - 根拠: api-design-practices — 27 以上の `Symbol.for('drizzle:...')` が内部プロパティキーとして使用
- `[SHOULD]` ファクトリ関数は段階的開示（progressive disclosure）のために複数のオーバーロードを提供する -- 最小シグネチャ（接続文字列のみ）から最大シグネチャ（全設定オブジェクト）まで
  - 根拠: api-design-practices — 全ドライバの `drizzle()` 関数が 3 形式のオーバーロードで段階的な利用を可能に
- `[SHOULD]` `$` プレフィックスでフレームワーク拡張 API をドメイン語彙と区別する -- ユーザー定義の名前空間との衝突を避けつつ、IDE 上での視認性を確保する
  - 根拠: api-design-practices — `$with`, `$count`, `$inferSelect`, `$client` 等が一貫して `$` で始まる
- `[SHOULD]` トランザクション API は通常のデータベース操作と同じインターフェースを提供し、利用側のコードがトランザクション内外で変わらないようにする
  - 根拠: database-patterns — `PgTransaction extends PgDatabase` により `db.select()` と `tx.select()` が同一シグネチャ
- `[SHOULD]` 値の変換責務は、変換元のドメイン型を持つ層（Column 等）に局所化する -- ドライバ層にアプリケーション型の知識を漏洩させない
  - 根拠: architecture — `Column.mapFromDriverValue()` / `mapToDriverValue()` でドライバ値変換がカラム定義ごとに閉じている
- `[AVOID]` アダプタークラスのコンストラクタに 8 個以上の位置引数を並べる -- オブジェクト引数にまとめて順序ミスを防ぐ
  - 根拠: adapter-implementation-patterns — `NodePgPreparedQuery` は 11 個の位置引数を取り、順序入れ替わりやすい

## ルール優先度の解釈

- `[MUST]`: 違反するとバグ・セキュリティリスク・重大な設計劣化を招くルール
- `[SHOULD]`: 従うことで品質が向上するが、文脈によっては例外を許容するルール
- `[AVOID]`: 意図的に避けるべきアンチパターン・非推奨プラクティス
