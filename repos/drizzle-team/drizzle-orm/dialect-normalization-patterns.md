# 方言正規化パターン

> リポジトリ: drizzle-team/drizzle-orm
> 分析日: 2026-03-04

## 概要

drizzle-orm は PostgreSQL / MySQL / SQLite の3方言を、共通の基底レイヤーと方言固有レイヤーの2層構造で正規化している。`drizzle-orm/src/` に共通の `Table`, `Column`, `ColumnBuilder` 基底クラスを配置し、`pg-core/`, `mysql-core/`, `sqlite-core/` に方言固有の拡張を並列ミラー構造で配置する設計は、SQL 方言差分の吸収パターンとして体系的に分析する価値がある。特に、型レベルで方言を `dialect` リテラル型タグとして伝搬させ、コンパイル時に方言間の誤用を防止するアプローチは注目に値する。

## 背景にある原則

- **構造の並列性で認知負荷を最小化すべき**: 3方言の `*-core/` ディレクトリが同一のファイル構造（`table.ts`, `columns/common.ts`, `dialect.ts`, `session.ts`, `query-builders/`）を持つことで、ある方言のコードを理解すれば他方言の対応コードを即座に特定できる。根拠: `pg-core/`, `mysql-core/`, `sqlite-core/` が `table.ts`, `columns/common.ts`, `dialect.ts`, `session.ts`, `query-builders/insert.ts` 等の完全に対応するファイルセットを持つ。

- **方言差分は SQL 生成レイヤーに集約すべき**: テーブル定義やカラム定義の API は方言間で共通の構造を持ち、実際の SQL 文字列生成（`escapeName`, `escapeParam`, `buildInsertQuery` 等）のみが方言ごとに異なる。これにより、ユーザー向け API の一貫性と SQL 出力の正確性を両立できる。根拠: `PgDialect.escapeName` は `"name"`、`MySqlDialect.escapeName` は `` `name` ``、`SQLiteDialect.escapeName` は `"name"` とそれぞれ異なる（`pg-core/dialect.ts:114`, `mysql-core/dialect.ts:94`, `sqlite-core/dialect.ts:57`）。

- **型タグによる方言分離で誤用をコンパイル時に防止すべき**: `TableConfig` の `dialect` プロパティと `ColumnBuilderBase` の `TTypeConfig & { dialect: 'pg' | 'mysql' | 'sqlite' }` により、PG のカラムを MySQL のテーブルに混入させるような誤用を型レベルで排除できる。根拠: `column-builder.ts:28` の `Dialect` 型と各 `columns/common.ts` の `TTypeConfig & { dialect: 'pg' }` パターン。

- **方言固有機能は基底を汚染せず拡張で対応すべき**: PG の `RETURNING`, `enableRLS`, `array()`, MySQL の `autoincrement()`, `$returningId()`, SQLite の sync/async 二重実行モデルなど、方言固有の機能は基底クラスに条件分岐を持ち込まず、各方言の拡張クラスで独立に実装する。根拠: `MySqlColumnBuilderWithAutoIncrement`（`mysql-core/columns/common.ts:128`）や PG の `PgArrayBuilder`（`pg-core/columns/common.ts:260`）は基底 `ColumnBuilder` を直接拡張しない。

## 実例と分析

### 2層テーブル継承: 共通基底と方言固有拡張

`Table` 基底クラス（`table.ts`）は `name`, `schema`, `columns` を管理し、`PgTable`, `MySqlTable`, `SQLiteTable` がそれを継承する。各方言テーブルは共通の `Symbol` を `Object.assign` で拡張し、方言固有のシンボル（例: `InlineForeignKeys`）を追加する。

```typescript
// pg-core/table.ts:33-54
export class PgTable<T extends TableConfig = TableConfig> extends Table<T> {
  static override readonly [entityKind]: string = "PgTable";

  static override readonly Symbol = Object.assign({}, Table.Symbol, {
    InlineForeignKeys: InlineForeignKeys as typeof InlineForeignKeys,
    EnableRLS: EnableRLS as typeof EnableRLS, // PG 固有
  });

  [InlineForeignKeys]: ForeignKey[] = [];
  [EnableRLS]: boolean = false; // PG 固有
}
```

MySQL は `InlineForeignKeys` のみを追加し、`EnableRLS` は持たない。SQLite も同様。このパターンにより、PG の `enableRLS()` メソッドは PG テーブルのみに存在し、MySQL/SQLite には型レベルで存在しない。

### カラムビルダーの方言型タグ伝搬

3方言のカラムビルダーは全て共通の `ColumnBuilder` を継承するが、型パラメータに `{ dialect: 'pg' | 'mysql' | 'sqlite' }` を注入することで、方言を型レベルで追跡する。

```typescript
// pg-core/columns/common.ts:38-44
export abstract class PgColumnBuilder<
  T extends ColumnBuilderBaseConfig<ColumnDataType, string>,
  TRuntimeConfig extends object = object,
  TTypeConfig extends object = object,
  TExtraConfig extends ColumnBuilderExtraConfig = ColumnBuilderExtraConfig,
> extends ColumnBuilder<T, TRuntimeConfig, TTypeConfig & { dialect: 'pg' }, TExtraConfig>
```

```typescript
// mysql-core/columns/common.ts:40-48
export abstract class MySqlColumnBuilder<
  T extends ColumnBuilderBaseConfig<ColumnDataType, string>,
  ...
> extends ColumnBuilder<T, TRuntimeConfig, TTypeConfig & { dialect: 'mysql' }, TExtraConfig>
```

`column-builder.ts:319-371` の `BuildColumn` 型では、`TDialect` に応じて `PgColumn` / `MySqlColumn` / `SQLiteColumn` を条件型で振り分ける。

### SQL 生成の方言分岐: 3つのエスケープ戦略

各 `Dialect` クラスは `escapeName`, `escapeParam`, `escapeString` の3メソッドで SQL 出力の方言差分を吸収する。

| メソッド       | PG            | MySQL        | SQLite   |
| -------------- | ------------- | ------------ | -------- |
| `escapeName`   | `"name"`      | `` `name` `` | `"name"` |
| `escapeParam`  | `$1`, `$2`... | `?`          | `?`      |
| `escapeString` | `'str'`       | `'str'`      | `'str'`  |

これらは `BuildQueryConfig` インターフェース（`sql/sql.ts:32-41`）を通じて SQL ノードツリーの最終変換時に注入される。

### INSERT 文の方言差分: ON CONFLICT vs ON DUPLICATE KEY

3方言で最も顕著な差分は INSERT 時のコンフリクト処理と結果返却である。

**PG / SQLite**: `onConflictDoNothing()`, `onConflictDoUpdate()`, `returning()` を持つ。

```typescript
// pg-core/dialect.ts:575-579
const onConflictSql = onConflict ? sql` on conflict ${onConflict}` : undefined;
return sql`${withSql}insert into ${table} ${insertOrder} ${overridingSql}${valuesSql}${onConflictSql}${returningSql}`;
```

**MySQL**: `onDuplicateKeyUpdate()` と `ignore()` を持ち、`returning()` の代わりに `$returningId()` を提供。

```typescript
// mysql-core/dialect.ts:557-562
const ignoreSql = ignore ? sql` ignore` : undefined;
const onConflictSql = onConflict ? sql` on duplicate key ${onConflict}` : undefined;
return {
  sql: sql`insert${ignoreSql} into ${table} ${insertOrder} ${valuesSql}${onConflictSql}`,
  generatedIds: generatedIdsResponse,
};
```

MySQL の `buildInsertQuery` は SQL に加えて `generatedIds` を返す。これは `RETURNING` 句を持たない MySQL のために、`$defaultFn` で生成された ID をクライアントサイドで追跡するメカニズムである（`mysql-core/dialect.ts:528`）。

### 方言固有カラム型: 同じ概念・異なる実装

`serial` 型は3方言で意味論が異なるが、ユーザー向け API は統一される。

- **PG**: `PgSerialBuilder` は `PgColumnBuilder` を直接継承。`getSQLType()` は `'serial'` を返す。`hasDefault` と `notNull` を自動設定（`pg-core/columns/serial.ts:29-33`）。
- **MySQL**: `MySqlSerialBuilder` は `MySqlColumnBuilderWithAutoIncrement` を継承。`autoIncrement: true` と `hasDefault: true` を設定。`IsPrimaryKey` と `IsAutoincrement` の型マーカーを付与（`mysql-core/columns/serial.ts:15-30`）。
- **SQLite**: `serial` は存在せず、`integer().primaryKey({ autoIncrement: true })` で代替。`SQLiteBaseIntegerBuilder` が `primaryKeyHasDefault: true` を `ColumnBuilderExtraConfig` で伝搬する（`sqlite-core/columns/integer.ts:23-44`）。

### entityKind による型安全な instanceof 代替

`entity.ts` の `is()` 関数は、`entityKind` シンボルをプロトタイプチェーンで照合することで、バンドラーによるクラス名マングリングやモジュール重複に耐性を持つ `instanceof` 代替を提供する。各方言のカラム・テーブル・ダイアレクトクラスは全てこのシンボルを持ち、SQL 生成時の分岐（`is(encoder, PgJsonb)` 等）に使用される。

```typescript
// entity.ts:12-42
export function is<T extends DrizzleEntityClass<any>>(value: any, type: T): value is InstanceType<T> {
  // ... instanceof check first, then entityKind symbol check through prototype chain
  let cls = Object.getPrototypeOf(value).constructor;
  while (cls) {
    if (entityKind in cls && cls[entityKind] === type[entityKind]) {
      return true;
    }
    cls = Object.getPrototypeOf(cls);
  }
  return false;
}
```

### SQLite の sync/async 二重モデル

SQLite は同期・非同期の両方の実行モデルをサポートする必要があるため、`SQLiteDialect` を `abstract` クラスとし、`SQLiteSyncDialect` と `SQLiteAsyncDialect` に分岐する（`sqlite-core/dialect.ts:830,882`）。PG と MySQL は常に非同期であるため、このような分岐は不要。

## パターンカタログ

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: 方言間で共通のアルゴリズム骨格（INSERT 文構築）を持ちつつ、個々のステップ（エスケープ、コンフリクト処理）を方言ごとに差し替える
  - 適用条件: 3つ以上の方言/バリアントが同一の処理フローを共有する場合
  - コード例: `pg-core/dialect.ts:513` / `mysql-core/dialect.ts:493` / `sqlite-core/dialect.ts:455` の `buildInsertQuery`
  - 注意点: drizzle-orm では共通基底の `Dialect` abstract class を用いず、各方言が独立して同一シグネチャのメソッドを実装している（暗黙の Template Method）

- **Abstract Factory パターン** (分類: 生成)
  - 解決する問題: 方言に応じて整合的な Table/Column/ColumnBuilder/Dialect のセットを生成する
  - 適用条件: 互いに整合性を保つべきオブジェクト群を方言ごとに生成する場合
  - コード例: `pgTable` / `mysqlTable` / `sqliteTable` がそれぞれ対応する `*WithSchema` 関数を呼び出し、方言固有の Table/Column を生成する
  - 注意点: 明示的な Factory クラスは存在せず、関数エクスポート（`pgTable`, `mysqlTable`, `sqliteTable`）がファクトリの役割を担う

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: SQL ノードツリーを方言固有の SQL 文字列に変換する際のエスケープ戦略を差し替える
  - 適用条件: 同一のデータ構造を異なるフォーマットにシリアライズする場合
  - コード例: `sql/sql.ts:32-41` の `BuildQueryConfig` に `escapeName`, `escapeParam` を注入

## Good Patterns

- **並列ミラーディレクトリ構造**: 3方言の `*-core/` が同一のファイル名・構造を持つことで、ある方言での変更が他方言への影響範囲を即座に特定できる。新しい方言（例: SingleStore）の追加時にも、既存方言をテンプレートとしてコピーできる。

```
pg-core/               mysql-core/            sqlite-core/
├── table.ts           ├── table.ts           ├── table.ts
├── columns/           ├── columns/           ├── columns/
│   ├── common.ts      │   ├── common.ts      │   ├── common.ts
│   ├── integer.ts     │   ├── int.ts         │   ├── integer.ts
│   └── serial.ts      │   └── serial.ts      │   └── (なし)
├── dialect.ts         ├── dialect.ts         ├── dialect.ts
└── query-builders/    └── query-builders/    └── query-builders/
    └── insert.ts          └── insert.ts          └── insert.ts
```

- **方言固有機能の型レベル排除**: MySQL の `$returningId()` と PG/SQLite の `returning()` はそれぞれの方言の insert builder にのみ定義される。ユーザーが MySQL で `.returning()` を呼ぼうとすると TypeScript がコンパイルエラーを出す。

```typescript
// PG: returning() あり
const result = await db.insert(users).values({ name: "John" }).returning();

// MySQL: $returningId() のみ（returning() は型に存在しない）
const result = await db.insert(users).values({ name: "John" }).$returningId();
```

- **getSQLType() による SQL 型名の方言分離**: 各カラムクラスの `getSQLType()` abstract メソッドが方言固有の SQL 型名を返す。PG の `pgEnum` は `enumName` を返し、MySQL の `mysqlEnum` は `enum('a','b','c')` をインラインで返す。これにより型マッピングロジックが各カラムクラスにカプセル化される。

```typescript
// pg-core/columns/enum.ts:68
getSQLType(): string { return this.enum.enumName; }

// mysql-core/columns/enum.ts:46-48
getSQLType(): string { return `enum(${this.enumValues!.map((value) => `'${value}'`).join(',')})`; }
```

## Anti-Patterns / 注意点

- **コード重複の許容とそのトレードオフ**: 各方言の `buildInsertQuery` は構造がほぼ同一だが、共通基底に抽出されていない。これは意図的な選択である（方言ごとの微妙な差分を if 分岐で処理するより、コード重複を許容して各方言を独立に保つ方が保守しやすい）。ただし、クロスカッティングな変更（例: CTE サポートの追加）では3箇所を同時に修正する必要がある。

```typescript
// Bad: 共通基底に条件分岐を詰め込む
buildInsertQuery(config) {
  if (this.dialect === 'pg') { /* PG 固有 */ }
  else if (this.dialect === 'mysql') { /* MySQL 固有 */ }
  // ... 分岐が増え続ける
}

// Better (drizzle-orm の実際のアプローチ): 各方言が独立した実装を持つ
// pg-core/dialect.ts:513  — PG 版
// mysql-core/dialect.ts:493  — MySQL 版
// sqlite-core/dialect.ts:455  — SQLite 版
```

- **mapFromDriverValue の不統一**: SQLite の `buildInsertQuery` では未定義値のデフォルトに `sql\`null\``を使うが、PG と MySQL は`sql\`default\``を使う（`sqlite-core/dialect.ts:496`vs`pg-core/dialect.ts:553`）。これは SQLite の`DEFAULT` 句の制約に起因するが、方言間で異なるフォールバック挙動がバグの温床になりうる。

## 導出ルール

- `[MUST]` 多方言/多バリアント対応のシステムでは、各バリアントのディレクトリ構造を並列ミラーにし、同一のファイル名・モジュール構成を維持する
  - 根拠: drizzle-orm の `pg-core/`, `mysql-core/`, `sqlite-core/` が同一構造を持つことで、方言追加時のテンプレート化と変更影響範囲の特定が容易になっている

- `[MUST]` バリアント固有の機能は基底クラスに条件分岐を持ち込まず、バリアント固有のサブクラスまたはモジュールで拡張する
  - 根拠: MySQL の `MySqlColumnBuilderWithAutoIncrement`（`mysql-core/columns/common.ts:128`）は MySQL 固有の autoIncrement を基底 `ColumnBuilder` に混入させず、MySQL 固有の中間クラスで追加している

- `[SHOULD]` SQL 生成など出力フォーマットの差分は、Strategy パターンで変換関数を注入し、データ構造の構築とシリアライゼーションを分離する
  - 根拠: `BuildQueryConfig`（`sql/sql.ts:32-41`）に `escapeName` / `escapeParam` を注入することで、SQL ノードツリーの構築と方言固有の文字列化が分離されている

- `[SHOULD]` 多バリアント対応では「API の統一」より「方言固有 API の型安全な提供」を優先し、存在しない機能をランタイムエラーではなくコンパイルエラーで排除する
  - 根拠: MySQL に `returning()` を生やさず `$returningId()` を提供し、PG に `autoincrement()` を生やさず `serial` 型で代替することで、誤用を型レベルで防止している

- `[SHOULD]` `instanceof` の代わりに Symbol ベースのエンティティ識別を使い、バンドラーやモジュール重複に耐性を持たせる
  - 根拠: `entity.ts` の `entityKind` シンボルと `is()` 関数により、異なるバンドルからインポートされた同一クラスのインスタンスも正しく識別できる

- `[AVOID]` 多バリアントの共通処理を1つの関数内の条件分岐で実装すること。微妙な差分が増えると分岐が複雑化し、あるバリアントの修正が他に影響するリスクが高まる
  - 根拠: drizzle-orm は `buildInsertQuery` を各方言で独立実装し、コード重複を許容する代わりに方言間の独立性を確保している

## 適用チェックリスト

- [ ] 多バリアント対応のシステムで、各バリアントのディレクトリ構造が並列ミラーになっているか確認する
- [ ] バリアント固有の機能が基底クラスの条件分岐ではなく、バリアント固有のサブクラス/モジュールで実装されているか確認する
- [ ] 型パラメータにバリアント識別タグ（リテラル型）を含め、異なるバリアント間のオブジェクト混在をコンパイル時に防止しているか確認する
- [ ] 出力フォーマットの差分が Strategy パターンで注入されており、データ構造の構築と分離されているか確認する
- [ ] `instanceof` に依存している箇所がバンドラー環境で正しく動作するか、Symbol ベースの識別が必要か検討する
- [ ] 共通 API で方言差分を吸収するか、方言固有 API を型安全に提供するか、トレードオフを明確に判断しているか確認する
