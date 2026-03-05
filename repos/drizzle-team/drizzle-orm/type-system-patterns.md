# type-system-patterns

> リポジトリ: drizzle-team/drizzle-orm
> 分析日: 2026-03-04

## 概要

drizzle-orm は TypeScript の型システムを限界まで活用し、SQL スキーマ定義からクエリ結果の型を完全に推論するライブラリである。テーブル定義 → カラム構築 → クエリビルダー → 結果型という一連の型推論チェーンが、条件型・交差型による型状態の累積・HKT（Higher-Kinded Type）エミュレーション・ブランド型・`declare` による幽霊プロパティなど、複数の高度な型テクニックの組み合わせで実現されている。

この型設計の注目点は、ランタイムコストゼロで SQL の構造的正しさをコンパイル時に保証し、かつ 5 つの SQL 方言（pg, mysql, sqlite, singlestore, gel）を単一の型基盤で統一している点にある。

## 背景にある原則

- **型状態を交差型で累積せよ**: メソッドチェーンの各ステップで `T & { _: { notNull: true } }` のように交差型を返すことで、型パラメータを書き換えずに型情報を蓄積できる。これにより Builder パターンの各メソッドが `this` を返しつつ、戻り値の型だけが段階的に精密化される。条件型 `T extends { notNull: true } ? true : false` で後から累積された情報を読み取る（`column-builder.ts:66-68` の `MakeColumnConfig`）。
- **コンパイル時専用の型情報はランタイムから分離せよ**: `declare _: { ... }` で宣言された幽霊プロパティは JavaScript に一切出力されないが、型推論チェーンの中間状態を保持する容器として機能する。ランタイムのオブジェクト構造と型レベルの情報モデルを独立させることで、型の複雑さがパフォーマンスに影響しない（`table.ts:52-60`, `column.ts:70`, `sql.ts:106-109`）。
- **方言差異は条件型でディスパッチせよ**: `BuildColumn<TTableName, TBuilder, TDialect>` のように方言を型パラメータとして渡し、条件型で方言固有の Column 型を選択する。共通ロジックは基底型に集約し、分岐点のみ条件型で切り替えることで、方言追加のコストを最小化する（`column-builder.ts:319-371`）。
- **不正な API 呼び出しは型エラーメッセージで案内せよ**: `DrizzleTypeError<"message">` というインターフェースを定義し、不正な使い方をした場合にユーザーフレンドリーなエラーメッセージを型レベルで表示する。`never` を返すだけでは原因が分かりにくいが、カスタムエラー型を用いることで開発者体験が大幅に向上する（`utils.ts:174-176`）。

## 実例と分析

### 幽霊プロパティ `declare _` によるメタデータ伝搬

drizzle-orm の型システムの要は `declare _` パターンである。`Table`, `Column`, `ColumnBuilder`, `SQL`, `Subquery`, `View`, `TypedQueryBuilder` など主要な全クラスが `_` プロパティを `declare` で宣言している。

```typescript
// table.ts:52-60
declare readonly _: {
  readonly brand: 'Table';
  readonly config: T;
  readonly name: T['name'];
  readonly schema: T['schema'];
  readonly columns: T['columns'];
  readonly inferSelect: InferSelectModel<Table<T>>;
  readonly inferInsert: InferInsertModel<Table<T>>;
};
```

```typescript
// sql/sql.ts:106-109
declare _: {
  brand: 'SQL';
  type: T;
};
```

`declare` キーワードにより JavaScript には出力されないが、`T['_']['name']` のような型レベルアクセスで推論チェーンを形成する。この設計により、`Table` の型パラメータ `T extends TableConfig` に格納された情報（テーブル名、カラムマップ、方言）を下流の型から参照できる。

### 交差型による型状態の段階的累積

`ColumnBuilder` のメソッドチェーンは交差型を使った型状態マシンとして機能する。

```typescript
// column-builder.ts:124-128
export type NotNull<T extends ColumnBuilderBase> = T & {
  _: {
    notNull: true;
  };
};
```

```typescript
// column-builder.ts:130-134
export type HasDefault<T extends ColumnBuilderBase> = T & {
  _: {
    hasDefault: true;
  };
};
```

`integer('id').notNull().default(0)` と呼ぶと、型が段階的に `PgIntegerBuilder & { _: { notNull: true } } & { _: { hasDefault: true } }` へ累積される。後段の `MakeColumnConfig` がこの蓄積情報を読み取る。

```typescript
// column-builder.ts:66-68
notNull: T extends { notNull: true } ? true : false;
hasDefault: T extends { hasDefault: true } ? true : false;
```

この条件型パターンにより、累積された交差型の各フラグが boolean リテラル型として解決され、最終的に `InferInsertModel` で「notNull かつ hasDefault なし → 必須フィールド」という判定に使われる。

### `serial()` の初期型状態の設定

`serial()` カラムは生成時点で `NotNull` かつ `HasDefault` であるべきだが、これを初期型に組み込む。

```typescript
// pg-core/columns/serial.ts:13-24
export type PgSerialBuilderInitial<TName extends string> = NotNull<
  HasDefault<
    PgSerialBuilder<{
      name: TName;
      dataType: "number";
      columnType: "PgSerial";
      data: number;
      driverParam: number;
      enumValues: undefined;
    }>
  >
>;
```

ユーザーが `.notNull()` を呼ばなくても、型レベルでは既に `notNull: true` が設定されている。これにより insert 時に serial カラムがオプショナルになる。

### `Omit` による不正なメソッドチェーンの静的排除

クエリビルダーは各メソッドの戻り値型で `Omit` を使い、一度呼ばれたメソッドを型レベルで除去する。

```typescript
// pg-core/query-builders/select.types.ts:246-264
export type PgSelectWithout<
  T extends AnyPgSelectQueryBuilder,
  TDynamic extends boolean,
  K extends keyof T & string,
  TResetExcluded extends boolean = false,
> = TDynamic extends true ? T : Omit<
  PgSelectKind<
    T['_']['hkt'],
    T['_']['tableName'],
    T['_']['selection'],
    T['_']['selectMode'],
    T['_']['nullabilityMap'],
    TDynamic,
    TResetExcluded extends true ? K : T['_']['excludedMethods'] | K,
    ...
  >,
  TResetExcluded extends true ? K : T['_']['excludedMethods'] | K
>;
```

`.where()` の戻り値は `PgSelectWithout<this, TDynamic, 'where'>` であり、返されたオブジェクトから `where` メソッドが型レベルで消える。これにより `.where().where()` のような二重呼び出しがコンパイルエラーになる。

### HKT エミュレーションによるクエリビルダーの多態性

TypeScript には Higher-Kinded Type がないため、drizzle-orm はインターフェースの `_type` プロパティを使って HKT をエミュレートしている。

```typescript
// pg-core/query-builders/select.types.ts:201-226
export interface PgSelectQueryBuilderHKT extends PgSelectHKTBase {
  _type: PgSelectQueryBuilderBase<
    PgSelectQueryBuilderHKT,
    this['tableName'],
    Assume<this['selection'], ColumnsSelection>,
    this['selectMode'],
    ...
  >;
}

export interface PgSelectHKT extends PgSelectHKTBase {
  _type: PgSelectBase<
    this['tableName'],
    Assume<this['selection'], ColumnsSelection>,
    this['selectMode'],
    ...
  >;
}
```

`PgSelectKind<T, ...>` は `(T & { tableName: ..., selection: ..., ... })['_type']` で具象型を計算する。これにより、同じクエリビルダーロジックが「DB 接続あり（`PgSelectBase`）」と「クエリビルダーのみ（`PgSelectQueryBuilderBase`）」の両方で使える。

### `DrizzleTypeError` によるカスタムコンパイルエラー

```typescript
// utils.ts:174-176
export interface DrizzleTypeError<T extends string> {
  $drizzleTypeError: T;
}
```

```typescript
// pg-core/query-builders/select.types.ts:124
table: TableLikeHasEmptySelection<TJoinedTable> extends true ? DrizzleTypeError<
    "Cannot reference a data-modifying statement subquery if it doesn't contain a `returning` clause"
  >
  : TJoinedTable,
```

`never` ではなく `DrizzleTypeError<"メッセージ">` を返すことで、IDE のエラー表示にリポジトリ固有の修正ヒントが表示される。

### JOIN 時の Nullability マップ追跡

```typescript
// query-builders/select.types.ts:137-147
export type AppendToNullabilityMap<
  TJoinsNotNull extends Record<string, JoinNullability>,
  TJoinedName extends string | undefined,
  TJoinType extends JoinType,
> = TJoinedName extends string ? 'left' extends TJoinType
    ? TJoinsNotNull & { [name in TJoinedName]: 'nullable' }
  : 'right' extends TJoinType
    ? SetJoinsNullability<TJoinsNotNull, 'nullable'> & { [name in TJoinedName]: 'not-null' }
  : ...
```

JOIN の種類ごとに Nullability マップを型レベルで更新し、最終的な `SelectResult` で各テーブルのカラムが `T | null` になるかを正確に推論する。`LEFT JOIN` では結合先が nullable、`RIGHT JOIN` では既存テーブルが nullable、`FULL JOIN` では両方が nullable になる。

### `entityKind` による Symbol ベースの型ガード

```typescript
// entity.ts:1-42
export const entityKind = Symbol.for("drizzle:entityKind");

export function is<T extends DrizzleEntityClass<any>>(value: any, type: T): value is InstanceType<T> {
  // instanceof チェック → プロトタイプチェーン上の entityKind シンボルマッチング
}
```

`instanceof` は bundler や複数パッケージバージョン環境で壊れやすいため、`Symbol.for` による globally unique な識別子とプロトタイプチェーン探索を組み合わせた型ガードを実装している。

## パターンカタログ

- **Builder パターン** (分類: 生成)
  - 解決する問題: SQL カラム定義の各属性（notNull, default, primaryKey 等）を段階的に設定する
  - 適用条件: 設定項目が多く、順序に依存せず、最終的な型が設定内容に応じて変わる場合
  - コード例: `column-builder.ts:185-317`（ColumnBuilder クラス全体）
  - 注意点: 交差型の累積が深くなると TypeScript コンパイラの負荷が増大する。drizzle-orm は `Simplify<T>` で中間型を平坦化して緩和している

- **Phantom Type パターン** (分類: 構造)
  - 解決する問題: ランタイムに存在しない型情報をコンパイル時のみ保持する
  - 適用条件: 型安全性のために追加情報が必要だが、ランタイムオーバーヘッドは許容できない場合
  - コード例: `table.ts:52` の `declare readonly _`, `sql.ts:106` の `declare _`
  - 注意点: `declare` は JavaScript に出力されないため、ランタイムで `_` にアクセスする箇所では明示的な初期化が必要（`subquery.ts:27-35` では constructor 内で代入）

- **Type State パターン** (分類: 振る舞い)
  - 解決する問題: メソッドチェーンの各段階で利用可能な操作を型で制限する
  - 適用条件: 状態遷移があり、不正な遷移をコンパイル時に検出したい場合
  - コード例: `select.types.ts:246-264` の `PgSelectWithout`（Omit による呼び出し済みメソッドの排除）
  - 注意点: `TDynamic extends true ? T : Omit<...>` で動的モードのエスケープハッチを提供し、型の厳密さとライブラリの柔軟性を両立している

## Good Patterns

- **`declare _` による幽霊プロパティの統一規約**: 全主要クラスが `_` という名前で型メタデータを保持する。`brand` フィールドで型の種別を区別し、残りのフィールドでジェネリクスの情報を公開する。統一的な命名により、`T['_']['name']` のようなアクセスパターンが直感的になる。

```typescript
// table.ts:52-60 — Table の幽霊プロパティ
declare readonly _: {
  readonly brand: 'Table';
  readonly config: T;
  readonly name: T['name'];
  readonly columns: T['columns'];
  readonly inferSelect: InferSelectModel<Table<T>>;
  readonly inferInsert: InferInsertModel<Table<T>>;
};
```

- **`Simplify<T>` によるマップ型の平坦化**: 交差型や条件型の結果が複雑になった際に `{ [K in keyof T]: T[K] } & {}` で平坦化し、IDE のホバー表示を読みやすくする。デバッグ時のコスト削減に直結する。

```typescript
// utils.ts:144-149
export type Simplify<T> =
  & {
    [K in keyof T]: T[K];
  }
  & {};
```

- **`Assume<T, U>` による安全な型ナローイング**: `T extends U ? T : U` というパターンで、型パラメータが期待する型に合致しない場合にフォールバック値を提供する。`as` キャストとは異なり、型の一貫性が保たれる。

```typescript
// utils.ts:170
export type Assume<T, U> = T extends U ? T : U;

// 使用例: select.types.ts:205
Assume<this["selection"], ColumnsSelection>;
```

## Anti-Patterns / 注意点

- **幽霊プロパティとランタイム代入の混同**: `declare _` で宣言したプロパティは JavaScript に存在しないが、一部のクラス（`Subquery`, `PgSelectQueryBuilderBase`）ではコンストラクタ内で `this._ = { ... }` と実体を代入している。これにより `_` がランタイムでもアクセス可能になるが、宣言と実装の間に型の不一致が生じやすい。

```typescript
// Bad: declare で宣言しつつ部分的に代入（型が as で強制変換される）
// pg-core/query-builders/select.ts:214-217
this._ = {
  selectedFields: fields as TSelectedFields,
  config: this.config,
} as this["_"];
```

```typescript
// Better: ランタイムで使うプロパティは declare ではなく通常のプロパティとして宣言し、
// 型レベル専用の情報のみ declare に限定する
readonly _metadata: { selectedFields: TSelectedFields; config: PgSelectConfig };
declare readonly _typeInfo: { brand: 'PgSelect'; selection: TSelection; ... };
```

- **深い条件型ネストによるコンパイル性能低下**: `MakeColumnConfig` や `BuildColumn` は多段の条件型を使っており、テーブル定義が多い場合にコンパイル時間が増大する。`noErrorTruncation: true` 設定が示すように、エラーメッセージの表示にも影響する。

```typescript
// Bad: 条件型を 6 段以上ネストする
type Result = T extends A ? X
  : T extends B ? Y
  : T extends C ? Z
  : T extends D ? W
  : T extends E ? V
  : never;
```

```typescript
// Better: ルックアップ型で分岐を平坦化する
type DialectMap = { pg: PgColumn<...>; mysql: MySqlColumn<...>; sqlite: SQLiteColumn<...> };
type Result = DialectMap[T];
```

## 導出ルール

- `[MUST]` 型レベル専用の情報は `declare` で宣言し、ランタイムプロパティと明確に分離する
  - 根拠: drizzle-orm の全主要クラス（Table, Column, SQL, Subquery 等 27 箇所以上）が `declare readonly _` で型メタデータを保持しており、JavaScript 出力に影響しない型推論チェーンを実現している
- `[MUST]` メソッドチェーンで型状態を変更する場合、交差型 `T & { flag: true }` で累積し、条件型 `T extends { flag: true } ? A : B` で読み取る
  - 根拠: `NotNull<T>`, `HasDefault<T>`, `IsPrimaryKey<T>` 等のヘルパー型がこのパターンで実装され、`MakeColumnConfig` で最終的に boolean リテラル型へ解決される（`column-builder.ts:55-79`）
- `[SHOULD]` 型エラー時は `never` ではなくカスタムエラー型（`{ $error: "メッセージ" }`）を返してユーザーに修正方法を提示する
  - 根拠: `DrizzleTypeError<T extends string>` が JOIN やセット演算子の型チェックで使われ、IDE 上に具体的なエラーメッセージを表示する（`utils.ts:174-176`, `select.types.ts:124`）
- `[SHOULD]` 深い交差型やジェネリクスの結果は `Simplify<T>` パターン（`{ [K in keyof T]: T[K] } & {}`）で平坦化し、IDE のホバー表示を読みやすく保つ
  - 根拠: drizzle-orm は `InferModelFromColumns`, `ColumnBuilderTypeConfig`, `AddAliasToSelection` 等の複雑な型の出力に `Simplify` を適用している（`utils.ts:144-149`）
- `[SHOULD]` 一度だけ呼ぶべきメソッドの戻り値型では `Omit<this, 'methodName'>` で自身を除去し、二重呼び出しをコンパイルエラーにする
  - 根拠: `PgSelectWithout` が `.where()`, `.having()`, `.groupBy()` 等の戻り値に適用され、SQL 文法上不正な二重呼び出しを防止する（`select.types.ts:246-264`）
- `[SHOULD]` `instanceof` の代わりに `Symbol.for` ベースの型ガードを使い、複数パッケージバージョン環境での型判定の安定性を確保する
  - 根拠: `entityKind` シンボルと `is()` 関数がプロトタイプチェーンを辿る実装で、bundler やモノレポ環境でも正確な型判定を実現している（`entity.ts:1-42`）
- `[AVOID]` 多方言対応で条件型の分岐を 5 段以上ネストする。ルックアップ型（マッピングオブジェクト型）でディスパッチテーブルを作り、条件型のネストを減らすべき
  - 根拠: `BuildColumn` は 6 方言の分岐を条件型チェーンで実装しており（`column-builder.ts:319-371`）、方言追加のたびに分岐が増える設計上の課題がある

## 適用チェックリスト

- [ ] ライブラリの公開 API で型推論チェーンが必要な場合、`declare _` による幽霊プロパティパターンを導入しているか
- [ ] Builder パターンのメソッドチェーンで型状態を変更する場合、交差型の累積 + 条件型の読み取りパターンを採用しているか
- [ ] 複雑な型推論結果に `Simplify<T>` を適用して IDE 表示を改善しているか
- [ ] 型エラー時に `never` ではなくカスタムエラー型で修正方法を案内しているか
- [ ] 一度だけ呼ぶべきメソッドに `Omit` ベースの制約を設けているか
- [ ] 多方言・多バリアントの分岐が条件型で 5 段以上ネストしていないか（ルックアップ型で平坦化できないか検討）
- [ ] `instanceof` の代わりに Symbol ベースの型ガードを使用し、パッケージ重複環境でも安全か
