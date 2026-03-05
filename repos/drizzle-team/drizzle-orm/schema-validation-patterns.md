# Schema Validation Patterns

> リポジトリ: drizzle-team/drizzle-orm
> 分析日: 2026-03-04

## 概要

drizzle-orm は drizzle-zod / drizzle-typebox / drizzle-valibot / drizzle-arktype の4つのバリデーション統合パッケージを提供しており、ORM のテーブル定義からバリデーションスキーマを自動導出する仕組みを持つ。4パッケージは同一のファイル構成・同一のアルゴリズム骨格を共有しつつ、各バリデーションライブラリの API 差分だけを吸収する設計になっている。この「構造的同型性を意図的に維持する」アプローチは、マルチバリデーションライブラリ対応に限らず、プラグインエコシステム設計の汎用パターンとして注目に値する。

## 背景にある原則

- **Single Source of Truth（単一情報源）**: テーブル定義がバリデーションルールの唯一の情報源であるべき。カラムの型・制約（notNull, hasDefault, generated）からバリデーションスキーマを機械的に導出することで、定義の二重管理を排除している。根拠: `columnToSchema` 関数が `column.dataType` / `column.columnType` / `column.notNull` 等のメタデータのみからスキーマを構築している（`drizzle-zod/src/column.ts:70-135`）。
- **Adapter Pattern による抽象化の最小化**: 4つの統合パッケージはバリデーションライブラリごとの「薄いアダプタ」として機能する。共通の抽象インターフェースを作らず、同一構造のコードを各ライブラリの API で書き直すことで、型安全性と各ライブラリ固有の機能（Zod の coerce、Valibot の pipe 等）を犠牲にしない。根拠: `Conditions` インターフェースは全パッケージで同一だが、`handleColumns` 内の nullable/optional 適用は各ライブラリの API を直接呼ぶ（例: Zod は `.nullable()` / TypeBox は `t.Union([schema, t.Null()])` / Valibot は `v.nullable(schema)` / ArkType は `schema.or(type.null)`）。
- **Refinement-first のカスタマイズ設計**: デフォルトで「正しい」スキーマを生成しつつ、2種類のカスタマイズ手段（関数による refinement とスキーマ直接差し替え）を提供する。これにより、生成されたスキーマを「拡張」する場合と「完全に置換」する場合の両方を自然に扱える。根拠: `drizzle-zod/src/schema.ts:37-44` の条件分岐で、refinement が関数なら既存スキーマを引数に渡し、オブジェクト（スキーマ）ならそのまま採用する。
- **Conditions オブジェクトによる振る舞いの宣言的分離**: select/insert/update の3つの操作モードをハードコードの分岐ではなく、`never` / `optional` / `nullable` の3つの述語関数を持つ Conditions オブジェクトで表現する。新しい操作モードの追加が既存コードへの変更なしで可能になる。根拠: `drizzle-zod/src/schema.ts:76-92` で3つの conditions が宣言的に定義され、`handleColumns` はそれを参照するだけ。

## 実例と分析

### 4パッケージの構造的同型性

4つのバリデーション統合パッケージは完全に同一のファイル構成を持つ:

| ファイル                   | 役割                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `column.ts`                | カラム→スキーマ変換のランタイムロジック                                              |
| `column.types.ts`          | カラム→スキーマ変換の型レベルマッピング                                              |
| `constants.ts`             | 整数範囲定数（全パッケージで同一内容）                                               |
| `schema.ts`                | `createSelectSchema` / `createInsertSchema` / `createUpdateSchema` + `handleColumns` |
| `schema.types.ts`          | 公開 API の型定義                                                                    |
| `schema.types.internal.ts` | `Conditions` / `BuildSchema` / `BuildRefine` / `NoUnknownKeys`                       |
| `utils.ts`                 | `isColumnType` / `isWithEnum` / `isPgEnum` + ユーティリティ型                        |
| `index.ts`                 | re-export                                                                            |

`constants.ts` は4パッケージで **完全同一** のファイルである（`drizzle-zod/src/constants.ts`, `drizzle-typebox/src/constants.ts` 等、全21行が一致）。`utils.ts` の `isColumnType` / `isWithEnum` / `isPgEnum` も実装が同一であり、型定義部分のみがライブラリごとに異なる。

### Conditions パターン: 操作モードの宣言的表現

3つの操作モード（select / insert / update）の違いを Conditions オブジェクトで宣言的に表現する:

```typescript
// drizzle-zod/src/schema.ts:76-92
const selectConditions: Conditions = {
  never: () => false, // 除外カラムなし
  optional: () => false, // 全フィールド必須
  nullable: (column) => !column.notNull, // NOT NULL でなければ nullable
};

const insertConditions: Conditions = {
  never: (column) =>
    column?.generated?.type === "always"
    || column?.generatedIdentity?.type === "always", // 自動生成カラムを除外
  optional: (column) => !column.notNull || (column.notNull && column.hasDefault),
  nullable: (column) => !column.notNull,
};

const updateConditions: Conditions = {
  never: (column) =>
    column?.generated?.type === "always"
    || column?.generatedIdentity?.type === "always",
  optional: () => true, // 全フィールドオプショナル
  nullable: (column) => !column.notNull,
};
```

この3つの Conditions 定義は4パッケージすべてで **ロジックが完全に同一** である。ライブラリごとに異なるのは、条件の結果をスキーマに適用する部分のみ。

### nullable/optional の適用: ライブラリ API の差分吸収

同一のロジック（nullable → optional の順序で適用）を各ライブラリの API で書き分ける:

```typescript
// drizzle-zod/src/schema.ts:53-59 — メソッドチェーン
if (conditions.nullable(column)) {
  columnSchemas[key] = columnSchemas[key]!.nullable();
}
if (conditions.optional(column)) {
  columnSchemas[key] = columnSchemas[key]!.optional();
}

// drizzle-typebox/src/schema.ts:52-58 — ラッパー関数
if (conditions.nullable(column)) {
  columnSchemas[key] = t.Union([columnSchemas[key]!, t.Null()]);
}
if (conditions.optional(column)) {
  columnSchemas[key] = t.Optional(columnSchemas[key]!);
}

// drizzle-valibot/src/schema.ts:45-51 — 関数ラッピング
if (conditions.nullable(column)) {
  columnSchemas[key] = v.nullable(columnSchemas[key]!);
}
if (conditions.optional(column)) {
  columnSchemas[key] = v.optional(columnSchemas[key]!);
}

// drizzle-arktype/src/schema.ts:48-54 — fluent API
if (conditions.nullable(column)) {
  columnSchemas[key] = columnSchemas[key]!.or(type.null);
}
if (conditions.optional(column)) {
  columnSchemas[key] = columnSchemas[key]!.optional();
}
```

### Refinement の2モード設計

各パッケージの `handleColumns` は refinement を2つのモードで処理する:

```typescript
// drizzle-zod/src/schema.ts:36-44
const refinement = refinements[key];
// モード1: スキーマ直接差し替え（refinement が関数でないスキーマオブジェクト）
if (refinement !== undefined && typeof refinement !== "function") {
  columnSchemas[key] = refinement;
  continue;
}
// モード2: 既存スキーマの拡張（refinement が関数）
const schema = column ? columnToSchema(column, factory) : z.any();
const refined = typeof refinement === "function" ? refinement(schema) : schema;
```

ArkType の実装では、ArkType の Type 自体が callable（`expression` プロパティを持つ関数）であるため、判定条件が追加されている:

```typescript
// drizzle-arktype/src/schema.ts:29-35
if (
  refinement !== undefined
  && (typeof refinement !== "function"
    || (typeof refinement === "function" && refinement.expression !== undefined))
) {
  columnSchemas[key] = refinement;
  continue;
}
```

### createSchemaFactory: Zod 固有の拡張

drizzle-zod のみが `createSchemaFactory` でカスタム Zod インスタンスと型強制（coerce）をサポートする:

```typescript
// drizzle-zod/src/schema.ts:121-152
export function createSchemaFactory<
  TCoerce extends
    | Partial<Record<"bigint" | "boolean" | "date" | "number" | "string", true>>
    | true
    | undefined,
>(options?: CreateSchemaFactoryOptions<TCoerce>) {
  // options.zodInstance — カスタム Zod インスタンス注入
  // options.coerce — 型強制の有効化（true で全型、個別指定も可能）
  return { createSelectSchema, createInsertSchema, createUpdateSchema };
}
```

drizzle-typebox は `typeboxInstance` のみ、drizzle-valibot / drizzle-arktype は factory パターン自体を持たない。これはライブラリごとのカスタマイズニーズの差を反映している。

### columnToSchema: データ型に基づくスキーマ導出

全パッケージ共通のアルゴリズムで、優先度順にスキーマを決定する:

1. enum カラム → enum スキーマ
2. 特殊な PG 型（Geometry, Point, Vector, Line 等） → 専用スキーマ
3. PgArray → 再帰的にベースカラムのスキーマを配列化
4. `column.dataType` による分岐（number / bigint / boolean / date / string / json / custom / buffer）
5. フォールバック → any / unknown

数値カラムでは SQL の型ごとに正確な min/max を設定する。例えば `PgSmallInt` は `-32768` から `32767` の範囲制約を付与する。この精密さは全パッケージで共通。

```typescript
// drizzle-zod/src/column.ts:149-152 — TinyInt の範囲制約
if (isColumnType<MySqlTinyInt<any> | SingleStoreTinyInt<any>>(column, ["MySqlTinyInt", "SingleStoreTinyInt"])) {
  min = unsigned ? 0 : CONSTANTS.INT8_MIN; // -128
  max = unsigned ? CONSTANTS.INT8_UNSIGNED_MAX : CONSTANTS.INT8_MAX; // 255 or 127
  integer = true;
}
```

### NoUnknownKeys: コンパイル時のリファインメント安全性

全パッケージが `NoUnknownKeys` 型を使い、refinement に存在しないカラム名を指定するとコンパイルエラーにする:

```typescript
// drizzle-zod/src/schema.types.internal.ts:68-76
export type NoUnknownKeys<
  TRefinement extends Record<string, any>,
  TCompare extends Record<string, any>,
> = {
  [K in keyof TRefinement]: K extends keyof TCompare
    ? TRefinement[K] extends Record<string, z.ZodType> ? NoUnknownKeys<TRefinement[K], TCompare[K]> // ネスト対応
    : TRefinement[K]
    : DrizzleTypeError<`Found unknown key in refinement: "${K & string}"`>;
};
```

テストで `@ts-expect-error` を使って型エラーの発生を検証している（`drizzle-zod/tests/pg.test.ts:574-578`）。

## パターンカタログ

- **Strategy Pattern** (分類: 振る舞い)
  - 解決する問題: select/insert/update の操作モードごとにカラムの扱い（除外・オプショナル・nullable）が異なる
  - 適用条件: 同一のアルゴリズム骨格に対して、判定ロジックのみが異なる場面
  - コード例: `drizzle-zod/src/schema.ts:76-92`（Conditions オブジェクト）
  - 注意点: GoF の Strategy はインターフェースとクラスで実装するが、ここでは関数のレコードとして軽量に実現している

- **Adapter Pattern** (分類: 構造)
  - 解決する問題: 異なる API を持つ4つのバリデーションライブラリに対して、同一のスキーマ導出ロジックを提供する
  - 適用条件: 外部ライブラリの API 差分を吸収しつつ、共通のアルゴリズムを維持したい場面
  - コード例: 4パッケージの `schema.ts` における `handleColumns` の nullable/optional 適用部分
  - 注意点: 共通の抽象レイヤーを作らず「同型コードの並列維持」で実現している点が特徴的

- **Factory Method Pattern** (分類: 生成)
  - 解決する問題: カスタム設定（coerce、カスタムインスタンス）を事前に束縛した schema 生成関数を作りたい
  - 適用条件: 同一設定で複数のスキーマを生成する場面
  - コード例: `drizzle-zod/src/schema.ts:121-152`（`createSchemaFactory`）
  - 注意点: drizzle-zod のみが coerce をサポート。drizzle-typebox は instance のみ

## Good Patterns

- **Conditions による宣言的モード分岐**: 操作モードの違いを if/switch ではなく、`{ never, optional, nullable }` の述語関数オブジェクトで表現する。新しいモードの追加がデータの追加のみで完結し、`handleColumns` の変更が不要。

```typescript
// drizzle-zod/src/schema.ts:76-92 — 条件を追加するだけで新モード対応可能
const patchConditions: Conditions = {
  never: (column) => column?.generated?.type === "always",
  optional: () => true,
  nullable: () => false, // patch では null を許容しない等
};
```

- **Refinement の関数/値デュアルモード**: refinement が関数なら既存スキーマをパイプラインで拡張し、値ならスキーマ全体を差し替える。利用者は場面に応じて最適な方法を選べる。

```typescript
// drizzle-zod/tests/pg.test.ts:237-240 — 拡張と差し替えの混在
const result = createSelectSchema(table, {
  c2: (schema) => schema.lte(1000), // 既存スキーマを拡張
  c3: z.string().transform(Number), // スキーマ全体を差し替え
});
```

- **SQL 型の精密な範囲制約**: データベースの型制約をバリデーションスキーマに正確に反映する。`INT8` なら `-128..127`、`INT16` なら `-32768..32767` など、SQL の型仕様に忠実な制約を設定する。

```typescript
// drizzle-zod/src/constants.ts:1-20 — SQL 型の正確な範囲定数
export const CONSTANTS = {
  INT8_MIN: -128,
  INT8_MAX: 127,
  INT8_UNSIGNED_MAX: 255,
  // ... INT16, INT24, INT32, INT48, INT64 まで網羅
};
```

## Anti-Patterns / 注意点

- **コード重複の維持コスト**: 4パッケージが同型コードを並列管理しているため、ロジック変更時に4箇所の同期が必要。`constants.ts` や `isColumnType` のように完全同一のコードが複数箇所に存在する。共有ユーティリティパッケージの抽出を検討すべきだが、型安全性の維持が困難なため意図的にこの構造を選択している（推測）。

```typescript
// Bad: 4パッケージに同一の constants.ts が存在
// drizzle-zod/src/constants.ts === drizzle-typebox/src/constants.ts
//   === drizzle-valibot/src/constants.ts === drizzle-arktype/src/constants.ts

// Better: 共有パッケージに抽出（型に依存しない純粋な値）
// drizzle-schema-common/src/constants.ts からインポート
```

- **isColumnType の文字列ベース型判定**: カラム型の判定を文字列リテラルの配列で行っているため、カラム型の追加・リネームに対して脆弱。ただし TypeScript の型パラメータでジェネリクスの型ガードとして機能させているため、コンパイル時にある程度の安全性は確保されている。

```typescript
// Bad: 文字列ベースの型判定（型名の変更に追従できない）
if (isColumnType<PgSmallInt<any>>(column, ['PgSmallInt'])) { ... }

// Better: シンボルやクラスベースの型判定（リファクタリング耐性あり）
if (is(column, PgSmallInt)) { ... }
```

## 導出ルール

- `[MUST]` データベーススキーマからバリデーションスキーマを導出する場合、select / insert / update の3つの操作モードで異なるスキーマを生成する — select は全カラム必須、insert は generated を除外し default 付きを optional に、update は全カラム optional にする
  - 根拠: `drizzle-zod/src/schema.ts:76-92` の3つの Conditions オブジェクトが、SQL の操作セマンティクスに基づいた正確なルールを定義している
- `[MUST]` バリデーションスキーマの nullable/optional 適用は、必ず nullable → optional の順で行う — 逆順にすると optional が nullable を包含してしまい型が崩れる
  - 根拠: 4パッケージすべての `handleColumns` で nullable チェック後に optional チェックを行う順序が統一されている（例: `drizzle-zod/src/schema.ts:52-60`）
- `[SHOULD]` 操作モードごとの振る舞いの違いは、条件分岐のハードコードではなく、述語関数のレコード（Strategy オブジェクト）として宣言的に定義する — モードの追加・変更がデータの追加で完結し、コアロジックの変更を回避できる
  - 根拠: `Conditions` インターフェース（`{ never, optional, nullable }` の3述語）が全4パッケージで共通のコアロジック `handleColumns` から参照される設計
- `[SHOULD]` カスタマイズ API は「既存スキーマの拡張（関数）」と「スキーマ全体の差し替え（値）」の2モードを提供する — 利用者が軽微な調整と完全なオーバーライドの両方を1つの API で行える
  - 根拠: `drizzle-zod/src/schema.ts:37-44` で `typeof refinement !== 'function'` の条件分岐により2モードを自然に切り替えている
- `[SHOULD]` 数値カラムのバリデーションには SQL 型の正確な範囲制約（INT8 は -128..127 等）を含める — DB 書き込み時のエラーをバリデーション段階で防止できる
  - 根拠: `drizzle-zod/src/constants.ts:1-20` および `column.ts:149-248` で全 SQL 数値型の範囲を網羅している
- `[AVOID]` 複数のバリデーションライブラリに対応する際に、全ライブラリを統合する共通抽象レイヤーを作る — 各ライブラリ固有の型システムや API（Zod の coerce、Valibot の pipe、ArkType の fluent API 等）を活かせなくなる。代わりに「同一構造のコードを並列管理」するアプローチを取る
  - 根拠: 4パッケージが抽象レイヤーなしで同型構造を維持し、各ライブラリの API を直接利用している設計選択

## 適用チェックリスト

- [ ] DB テーブル定義からバリデーションスキーマを自動生成する仕組みがあるか（手動での二重定義を回避できているか）
- [ ] select / insert / update でバリデーションスキーマを使い分けているか（generated カラムの除外、default 付きカラムの optional 化）
- [ ] nullable と optional の適用順序は正しいか（nullable → optional の順）
- [ ] 数値カラムに SQL 型の正確な範囲制約を設定しているか（INT32 なら -2147483648..2147483647）
- [ ] スキーマのカスタマイズは「拡張」と「差し替え」の両方が可能か（refinement の2モード設計）
- [ ] 操作モードの振る舞い差分を宣言的に管理しているか（ハードコードの if/switch を避ける）
- [ ] refinement に存在しないカラム名を指定した場合にコンパイルエラーになるか（NoUnknownKeys 型ガード）
