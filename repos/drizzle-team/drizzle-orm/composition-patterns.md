# composition-patterns

> リポジトリ: drizzle-team/drizzle-orm
> 分析日: 2026-03-04

## 概要

drizzle-orm のクエリビルダーは、メソッドチェインによる段階的なクエリ構築と、タグ付きテンプレートリテラル (``sql```) による SQL 式の合成という2つの合成軸を持つ。注目に値するのは、TypeScript の型システムを駆使して「一度しか呼べないメソッド」を型レベルで排除する Phantom Type パターンと、``SQLWrapper` インターフェースによる統一的な式合成モデルである。これらの合成パターンは SQL ビルダーに限らず、任意の宣言的 DSL 構築に応用できる。

## 背景にある原則

- **統一インターフェースによる合成可能性**: すべての SQL 構成要素（テーブル、カラム、サブクエリ、ビュー、式）が `SQLWrapper` インターフェースの `getSQL(): SQL` を実装し、どの位置にも埋め込み可能になっている。合成可能性の基盤は「共通のインターフェースに還元できること」にある（`sql/sql.ts:65-68`）。
- **型レベルでの状態遷移制御**: チェインメソッドが返す型から既に呼ばれたメソッドを `Omit` で除外し、同一句の二重指定をコンパイル時に検出する。ランタイムバリデーションよりコンパイル時検証のほうがコストが低く、ユーザー体験も良い（`pg-core/query-builders/select.types.ts:246-264`）。
- **Builder と Product の分離**: `PgSelectBuilder`（from 前）→ `PgSelectBase`（from 後）のように、Builder 段階と Product（実行可能クエリ）段階を別クラスに分離し、各段階で利用可能な操作を型で制限する（`pg-core/query-builders/select.ts:62-151`）。
- **チャンク列としての SQL AST**: SQL を構文木ではなく `SQLChunk[]`（文字列チャンクとパラメータの線形リスト）で表現し、再帰的にフラット化して最終 SQL を生成する。構文木より単純で、テンプレートリテラルとの親和性が高い（`sql/sql.ts:118, 148-299`）。

## 実例と分析

### 1. タグ付きテンプレートによる式合成

`sql` タグ付きテンプレートリテラルは、文字列部分を `StringChunk` に、補間値を `SQLChunk` として交互に配列化する。補間値が `SQLWrapper` 実装なら自動的に展開され、プリミティブ値は `Param` にラップされてパラメータ化される。

```typescript
// sql/sql.ts:485-495
export function sql(strings: TemplateStringsArray, ...params: SQLChunk[]): SQL {
  const queryChunks: SQLChunk[] = [];
  if (params.length > 0 || (strings.length > 0 && strings[0] !== "")) {
    queryChunks.push(new StringChunk(strings[0]!));
  }
  for (const [paramIndex, param] of params.entries()) {
    queryChunks.push(param, new StringChunk(strings[paramIndex + 1]!));
  }
  return new SQL(queryChunks);
}
```

式の合成は入れ子にできる。`buildQueryFromSourceParams` が再帰的にチャンクを展開するため、`sql` の中に `sql` を入れても正しく動作する。

```typescript
// sql/expressions/conditions.ts:62-64
export const eq: BinaryOperator = (left: SQLWrapper, right: unknown): SQL => {
  return sql`${left} = ${bindIfParam(right, left)}`;
};
```

### 2. `sql.join` と `sql.raw` によるユーティリティ合成

複数の SQL チャンクをセパレータ付きで結合する `sql.join` と、エスケープなしの生文字列を挿入する `sql.raw` が提供される。Dialect 側の `buildSelectQuery` ではこれらを組み合わせてクエリ全体を構築する。

```typescript
// pg-core/dialect.ts:440-441
const finalQuery =
  sql`${withSql}select${distinctSql} ${selection} from ${tableSql}${joinsSql}${whereSql}${groupBySql}${havingSql}${orderBySql}${limitSql}${offsetSql}${lockingClauseSql}`;
```

### 3. 条件付き合成: `sql.if` と `and`/`or` の undefined フィルタリング

`SQL.if(condition)` は条件が falsy なら `undefined` を返す。`undefined` チャンクはクエリ生成時にスキップされるため、条件分岐なしで動的クエリを構築できる。

```typescript
// sql/sql.ts:369-371
if(condition: any | undefined): this | undefined {
  return condition ? this : undefined;
}

// pg-core/query-builders/count.ts:22 (使用例)
return sql<number>`(select count(*) from ${source}${sql.raw(' where ').if(filters)}${filters})`;
```

同様に `and()` / `or()` は引数の `undefined` を自動フィルタし、要素が0個なら `undefined`、1個なら単一式、2個以上なら括弧付き結合を返す。

```typescript
// sql/expressions/conditions.ts:106-125
export function and(...unfilteredConditions: (SQLWrapper | undefined)[]): SQL | undefined {
  const conditions = unfilteredConditions.filter(
    (c): c is Exclude<typeof c, undefined> => c !== undefined,
  );
  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return new SQL(conditions);
  return new SQL([
    new StringChunk("("),
    sql.join(conditions, new StringChunk(" and ")),
    new StringChunk(")"),
  ]);
}
```

### 4. メソッドチェインと型レベル排除

`PgSelectWithout` 型が中核で、呼ばれたメソッド名を `TExcludedMethods` ユニオンに蓄積し、`Omit` で返却型から除外する。

```typescript
// pg-core/query-builders/select.types.ts:246-264
export type PgSelectWithout<
  T extends AnyPgSelectQueryBuilder,
  TDynamic extends boolean,
  K extends keyof T & string,
  TResetExcluded extends boolean = false,
> = TDynamic extends true ? T : Omit<
  PgSelectKind<...>,
  TResetExcluded extends true ? K : T['_']['excludedMethods'] | K
>;
```

各メソッドは `return this as any` で内部状態を変更しつつ、戻り値型でメソッドを制限する。

```typescript
// pg-core/query-builders/select.ts:935-942
limit(limit: number | Placeholder): PgSelectWithout<this, TDynamic, 'limit'> {
  if (this.config.setOperators.length > 0) {
    this.config.setOperators.at(-1)!.limit = limit;
  } else {
    this.config.limit = limit;
  }
  return this as any;
}
```

### 5. `$dynamic()` による型制約の解除

ヘルパー関数に部分的なクエリを渡す場面では、`TExcludedMethods` が固定されると型が合わない。`$dynamic()` は `TDynamic = true` に設定し、すべての `PgSelectWithout` チェックをバイパスする。

```typescript
// pg-core/query-builders/select.ts:1014-1016
$dynamic(): PgSelectDynamic<this> {
  return this;
}

// pg-core/query-builders/select.types.ts:272-282
export type PgSelectDynamic<T extends AnyPgSelectQueryBuilder> = PgSelectKind<
  ..., true, never, ...  // TDynamic=true, TExcludedMethods=never
>;
```

### 6. Thenable パターンによる暗黙実行

`QueryPromise` は `Promise` インターフェースを実装し、`then` から `execute()` を呼ぶ。クエリビルダーが `await` されると自動実行される。

```typescript
// query-promise.ts:27-31
then<TResult1 = T, TResult2 = never>(
  onFulfilled?: ..., onRejected?: ...,
): Promise<TResult1 | TResult2> {
  return this.execute().then(onFulfilled, onRejected);
}
```

### 7. CTE (`$with`) とサブクエリ合成

`$with(alias).as(query)` で CTE を定義し、`with(...ctes).select()` でクエリに注入する。CTE は `WithSubquery`（`Subquery` のサブクラス、`isWith = true`）として表現され、SQL 生成時に `isWith` フラグで `(sql) alias` ではなくエイリアス名のみを出力する。

```typescript
// sql/sql.ts:264-274
if (is(chunk, Subquery)) {
  if (chunk._.isWith) {
    return { sql: escapeName(chunk._.alias), params: [] };
  }
  return this.buildQueryFromSourceParams([
    new StringChunk("("),
    chunk._.sql,
    new StringChunk(") "),
    new Name(chunk._.alias),
  ], config);
}
```

### 8. Proxy による選択フィールドの解決

`SelectionProxyHandler` は、サブクエリやビューのフィールド参照を Proxy で仲介し、`SQL.Aliased` の `isSelectionField` フラグで「サブクエリ由来のフィールドは常にエイリアス参照」という一貫した挙動を実現する。

```typescript
// selection-proxy.ts:79-88
if (is(value, SQL.Aliased)) {
  if (this.config.sqlAliasedBehavior === "sql" && !value.isSelectionField) {
    return value.sql;
  }
  const newValue = value.clone();
  newValue.isSelectionField = true;
  return newValue;
}
```

## パターンカタログ

- **Builder パターン** (分類: 生成)
  - 解決する問題: 複数のオプション句を持つ複雑なオブジェクト（SQLクエリ）の段階的構築
  - 適用条件: 構築過程に順序性があり、一部のステップが省略可能な場合
  - コード例: `pg-core/query-builders/select.ts:62-151`（PgSelectBuilder → PgSelectBase）
  - 注意点: TypeScript では Phantom Type と組み合わせることで、呼び出し順序や二重呼び出しを型レベルで制御できる

- **Composite パターン** (分類: 構造)
  - 解決する問題: SQL 式の再帰的な合成（式の中に式を埋め込む）
  - 適用条件: ツリー構造を統一的に扱いたい場合
  - コード例: `sql/sql.ts:103-371`（SQL クラスが SQLChunk の配列を持ち、SQLChunk 自身も SQL になりうる）
  - 注意点: drizzle-orm では完全なツリーではなく線形チャンク列を使っており、再帰展開は生成時に行う

- **Proxy パターン** (分類: 構造)
  - 解決する問題: サブクエリ・エイリアスのフィールド参照を透過的に解決する
  - 適用条件: プロパティアクセスの挙動をコンテキストに応じて切り替えたい場合
  - コード例: `selection-proxy.ts:8-121`, `alias.ts:10-75`
  - 注意点: Proxy はデバッグが困難になる場合がある。エラーメッセージを充実させること（`selection-proxy.ts:95-97`）

## Good Patterns

- **統一合成インターフェース (`SQLWrapper`)**: すべての SQL 構成要素が `getSQL(): SQL` を実装することで、テーブル、カラム、サブクエリ、生 SQL を区別なく式に埋め込める。新しい構成要素を追加する際も `SQLWrapper` を実装するだけでよい。

```typescript
// sql/sql.ts:65-68
export interface SQLWrapper {
  getSQL(): SQL;
  shouldOmitSQLParens?(): boolean;
}
```

- **undefined スキップによる条件的合成**: `and()`/`or()` が `undefined` 引数を自動フィルタし、`sql.if()` が falsy 条件で `undefined` を返すことで、`if` 分岐なしに動的クエリを構築できる。

```typescript
// 動的フィルタの組み立て（利用イメージ）
const filters = and(
  nameFilter ? eq(users.name, nameFilter) : undefined,
  minAge ? gte(users.age, minAge) : undefined,
);
db.select().from(users).where(filters);
```

- **`bindIfParam` による自動パラメータ化**: 比較演算子が左辺のカラムの型エンコーダを使って右辺の値を自動的に `Param` にラップする。ユーザーは生の値を渡すだけでSQL インジェクション安全なクエリが生成される。

```typescript
// sql/expressions/conditions.ts:17-30
export function bindIfParam(value: unknown, column: SQLWrapper): SQLChunk {
  if (
    isDriverValueEncoder(column)
    && !isSQLWrapper(value)
    && !is(value, Param)
    // ... 他の型チェック
  ) {
    return new Param(value, column);
  }
  return value as SQLChunk;
}
```

## Anti-Patterns / 注意点

- **`return this as any` の多用**: 型レベルの状態遷移を実現するため、メソッド内部で `return this as any` を使い、実際の型と戻り値型を乖離させている。型安全性はメソッドシグネチャが保証するが、内部実装は完全に型チェックを放棄している。

```typescript
// Bad: 内部では型チェックが効かない
where(where: SQL | undefined): PgSelectWithout<this, TDynamic, 'where'> {
  this.config.where = where;
  return this as any;  // 何でも返せてしまう
}

// Better: Builder の内部状態を readonly にし、新しいオブジェクトを返す（ただしパフォーマンスとのトレードオフ）
where(where: SQL | undefined): PgSelectWithout<this, TDynamic, 'where'> {
  return new PgSelectBase({ ...this.config, where }) as any;
}
```

- **サブクエリの `SQL.Aliased` エイリアス忘れ**: `sql` テンプレートで計算フィールドを作った際に `.as('alias')` を付けないと、サブクエリから参照する時にランタイムエラーになる。これは `SelectionProxyHandler` が明示的にエラーを投げて教えてくれる（`selection-proxy.ts:95-97`）が、型レベルでは検出しきれない。

```typescript
// Bad: エイリアスなしの SQL 式をサブクエリから参照
const sq = db.select({
  fullName: sql`first_name || ' ' || last_name`, // エイリアスなし
}).from(users).as("sq");
db.select({ name: sq.fullName }).from(sq); // ランタイムエラー

// Better: .as() でエイリアスを付与
const sq = db.select({
  fullName: sql<string>`first_name || ' ' || last_name`.as("full_name"),
}).from(users).as("sq");
```

## 導出ルール

- `[MUST]` 合成可能な DSL を設計する際は、すべての構成要素に共通の合成インターフェース（`getSQL()` のような変換メソッド）を実装し、どの位置にも埋め込み可能にする
  - 根拠: drizzle-orm の `SQLWrapper` インターフェースにより、Table, Column, Subquery, SQL 式がすべて同じ方法で合成可能になっている（`sql/sql.ts:65-68`、各構成要素の `getSQL()` 実装）

- `[MUST]` 条件的合成では `undefined` を「不在」のシグナルとして使い、合成関数側で自動フィルタする。呼び出し側に `if` 分岐を強制しない
  - 根拠: `and()`/`or()` が `undefined` 引数をフィルタし、`SQL.if()` が falsy で `undefined` を返すことで、動的クエリ構築がフラットに書ける（`sql/expressions/conditions.ts:104-125`）

- `[SHOULD]` メソッドチェインの Fluent API で「一度しか呼べない句」がある場合、型レベルで呼び出し済みメソッドを除外する（Phantom Type + Omit パターン）
  - 根拠: `PgSelectWithout` 型が `TExcludedMethods` ユニオンでメソッドを蓄積し、`Omit` で返却型から除外している（`pg-core/query-builders/select.types.ts:246-264`）

- `[SHOULD]` Fluent API をヘルパー関数に分割して渡す場合は、型制約を解除するエスケープハッチ（`$dynamic()` のような仕組み）を提供する
  - 根拠: `$dynamic()` が `TDynamic = true` に切り替えて型制約をバイパスし、部分適用可能にしている（`pg-core/query-builders/select.ts:1014-1016`）

- `[SHOULD]` タグ付きテンプレートリテラルで DSL を構築する際は、補間値の型に応じた自動変換（パラメータ化、括弧付与、エスケープ）を一元的に行い、ユーザーに生の変換を要求しない
  - 根拠: `sql` タグ関数の `buildQueryFromSourceParams` が SQLChunk の型を判定して自動変換し、`bindIfParam` がカラムの型エンコーダで自動パラメータ化する（`sql/sql.ts:148-299`, `sql/expressions/conditions.ts:17-30`）

- `[SHOULD]` ビルダーオブジェクトが「構築中」と「実行可能」の2つの段階を持つ場合、段階ごとに別クラスまたは別型を使い、不完全な状態での実行をコンパイル時に防ぐ
  - 根拠: `PgSelectBuilder`（from 未指定）と `PgSelectBase`（from 指定済み、実行可能）が別クラスに分離されている（`pg-core/query-builders/select.ts:62-151`）

- `[AVOID]` SQL テンプレートの合成で生文字列を直接結合する。必ず構造化されたチャンク列（AST やチャンクリスト）を介して合成し、パラメータバインディングを維持する
  - 根拠: drizzle-orm は `SQLChunk[]` ベースの合成を徹底しており、文字列結合は `sql.raw()` 経由でのみ行う。これにより SQL インジェクションを構造的に防止している（`sql/sql.ts:511-513`）

## 適用チェックリスト

- [ ] DSL の構成要素がすべて共通の合成インターフェースを実装しているか
- [ ] 条件的な要素の追加が `undefined` フィルタリングで表現されているか（呼び出し側に if 分岐を強制していないか）
- [ ] Fluent API のメソッドチェインで、二重呼び出しや不正な順序が型レベルで検出されるか
- [ ] ヘルパー関数にビルダーを渡す場合の型互換性問題に対処するエスケープハッチがあるか
- [ ] テンプレートリテラルの補間値が自動的にパラメータ化されるか（SQL インジェクション対策）
- [ ] ビルダーの「構築中」と「実行可能」の段階が型で区別されているか
- [ ] サブクエリや CTE からのフィールド参照にエイリアスが必要な場面で、適切なエラーメッセージが出るか
