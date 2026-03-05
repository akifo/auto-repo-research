# Design Philosophy

> リポジトリ: drizzle-team/drizzle-orm
> 分析日: 2026-03-04

## 概要

Drizzle ORM は「SQL ファースト・ノーマジック・型安全」という三本柱の設計哲学を持つ TypeScript ORM である。多くの ORM が SQL を抽象化し独自の DSL を提供するのに対し、Drizzle は SQL 構文との 1:1 対応を維持しつつ、TypeScript の型推論でクエリ結果の型を自動導出する。これにより、SQL の知識がそのまま活用でき、コードジェネレーションやランタイムリフレクションなしに完全な型安全性を実現している。注目すべきは、0 依存・7.4kb（minified+gzipped）という軽量さと、20 以上のドライバーアダプターを単一パッケージで提供する設計の両立である。

## 背景にある原則

- **SQL をファーストクラスオブジェクトとして扱え**: API が SQL 構文と 1:1 対応するよう設計されている。`select().from().where().leftJoin()` のメソッドチェーンは SQL の句順序に一致し、`sql` テンプレートリテラルで任意の SQL を型安全に埋め込める。SQL の知識がそのまま Drizzle のコードに翻訳できることで、学習コストを最小化し、ORM が生成するクエリの予測可能性を保っている（`drizzle-orm/src/pg-core/dialect.ts:140-198` の buildDeleteQuery/buildUpdateQuery が SQL テンプレートをそのまま組み立てている点が顕著）。

- **ランタイムマジックを排除し、型レベルで保証せよ**: Drizzle はデコレーターもコードジェネレーションも使わない。代わりに `declare readonly _:` パターンでランタイムコストゼロの型メタデータを保持し、TypeScript の条件型・テンプレートリテラル型で JOIN の nullability や select 結果の型を自動推論する。`DrizzleTypeError<T>` 型により、誤った API 使用をランタイムエラーではなくコンパイルエラーとして検出する（`drizzle-orm/src/utils.ts:174-176`）。

- **依存ゼロを維持し、ユーザーのドライバーに寄り添え**: `package.json` に `"dependencies"` は存在せず、すべてのドライバーは `peerDependencies`（全 optional）として宣言されている。ドライバー固有のコードは `node-postgres/`, `better-sqlite3/` 等の個別ディレクトリに分離され、`"sideEffects": false` により未使用コードはバンドルから除外される。これにより、サーバーレス環境でのコールドスタートやバンドルサイズへの影響を最小化している。

- **エスケープハッチを提供し、抽象化の壁を作らない**: `customType()` による任意のカラム型定義、`sql` テンプレートリテラルによる生 SQL の型安全な埋め込み、knex/kysely/prisma 互換型ヘルパーなど、ORM の抽象化を超えた操作を常に許可している。ORM がボトルネックにならないよう、開発者が SQL に直接降りる道を用意している（`drizzle-orm/src/pg-core/columns/custom.ts:200-232`）。

## 実例と分析

### SQL テンプレートリテラルによるクエリ合成

Drizzle の中核は `sql` テンプレートリテラル関数である。これは Tagged Template Literal を活用し、文字列部分はそのまま SQL として、補間値はパラメータ化クエリのプレースホルダーとして処理される。この設計により SQL インジェクションを防ぎつつ、任意の SQL 表現を型安全に合成できる。

`buildQueryFromSourceParams` メソッド（`sql/sql.ts:148-300`）は、チャンクの型を `is()` 関数で判別し、Table/Column/View/Subquery/Param 等の各エンティティを適切な SQL 文字列に変換する。このメソッドは再帰的に動作し、ネストした SQL 式も正しく展開される。

条件式（`eq`, `gt`, `inArray` 等）は `sql` テンプレートリテラルで実装されている。例えば `eq` は `sql\`${left} = ${bindIfParam(right, left)}\`` という直接的な表現で、SQL との対応が一目瞭然である。

### entityKind パターンによる instanceof 回避

Drizzle は `instanceof` チェックの代わりに、`entityKind` シンボルベースの型判別を使用している（`entity.ts`）。`is()` 関数はまず `instanceof` を試み、失敗した場合はプロトタイプチェーンを辿って `entityKind` を比較する。これにより、複数バージョンの Drizzle が混在する環境（モノレポ等）でも型判別が正しく動作する。

ESLint ルール `no-instanceof/no-instanceof` でコードベース全体の `instanceof` 使用を制限し、外部ライブラリの型判別（`Date`, `Buffer`, `Pool` 等のやむを得ない場合）にはコメントで明示的に許可している。

### declare による型メタデータの零コスト保持

テーブル、カラム、クエリビルダーのすべてのクラスが `declare readonly _:` パターンで型情報を保持している。`declare` キーワードにより、この型情報はコンパイル時のみ存在し、ランタイムの JavaScript コードには一切含まれない。

例えば `Table` クラスの `_` プロパティは `brand`, `config`, `name`, `schema`, `columns`, `inferSelect`, `inferInsert` を持つが、これらは型推論のためだけに存在する。`$inferSelect` / `$inferInsert` はユーザーが型を抽出するための公開インターフェースである。

### ドライバーアダプター層の三層構造

Drizzle のアーキテクチャは Dialect → Session → Driver の三層に分かれる:

1. **Dialect**（`pg-core/dialect.ts`）: SQL 方言ごとのクエリ生成ロジック。`escapeName`, `escapeParam`, `buildSelectQuery` 等を提供
2. **Session**（`pg-core/session.ts`）: 抽象クラスで、`execute`, `all`, `transaction` 等のデータベース操作インターフェースを定義
3. **Driver**（`node-postgres/driver.ts` 等）: 具体的なドライバーライブラリとの接続を担当。Session を生成する

この分離により、新しいドライバーの追加は Driver + Session の実装だけで済み、Dialect 層のクエリ生成ロジックは完全に共有される。

### 型レベルのエラーメッセージ

`DrizzleTypeError<T extends string>` 型は `{ $drizzleTypeError: T }` という構造で、不正な API 使用時にコンパイルエラーとして人間が読めるメッセージを表示する。例えば:

- `.returning()` なしで `.all()` を呼ぶ → `".all() cannot be used without .returning()"`
- スキーマ未指定で `query` にアクセス → `"Seems like the schema generic is missing"`
- エイリアスなしのサブクエリ参照 → `"You cannot reference this field without assigning it an alias first"`

## コード例

```typescript
// drizzle-orm/src/sql/sql.ts:478-495
// sql テンプレートリテラル — SQL と値を分離し、パラメータ化クエリを生成
export function sql(strings: TemplateStringsArray, ...params: SQLChunk[]): SQL {
	const queryChunks: SQLChunk[] = [];
	if (params.length > 0 || (strings.length > 0 && strings[0] !== '')) {
		queryChunks.push(new StringChunk(strings[0]!));
	}
	for (const [paramIndex, param] of params.entries()) {
		queryChunks.push(param, new StringChunk(strings[paramIndex + 1]!));
	}
	return new SQL(queryChunks);
}
```

```typescript
// drizzle-orm/src/entity.ts:12-42
// entityKind パターン — instanceof に頼らず、シンボルベースで型判別
export function is<T extends DrizzleEntityClass<any>>(value: any, type: T): value is InstanceType<T> {
	if (!value || typeof value !== 'object') {
		return false;
	}
	if (value instanceof type) { // eslint-disable-line no-instanceof/no-instanceof
		return true;
	}
	if (!Object.prototype.hasOwnProperty.call(type, entityKind)) {
		throw new Error(
			`Class "${type.name ?? '<unknown>'}" doesn't look like a Drizzle entity.`,
		);
	}
	let cls = Object.getPrototypeOf(value).constructor;
	if (cls) {
		while (cls) {
			if (entityKind in cls && cls[entityKind] === type[entityKind]) {
				return true;
			}
			cls = Object.getPrototypeOf(cls);
		}
	}
	return false;
}
```

```typescript
// drizzle-orm/src/pg-core/columns/integer.ts:34-47
// カラム型 — getSQLType() で SQL 型名を返し、mapFromDriverValue でドライバー値を変換
export class PgInteger<T extends ColumnBaseConfig<'number', 'PgInteger'>> extends PgColumn<T> {
	static override readonly [entityKind]: string = 'PgInteger';

	getSQLType(): string {
		return 'integer';
	}

	override mapFromDriverValue(value: number | string): number {
		if (typeof value === 'string') {
			return Number.parseInt(value);
		}
		return value;
	}
}
```

```typescript
// drizzle-orm/src/utils.ts:174-176
// 型レベルのエラーメッセージ — コンパイル時にユーザーに誤りを通知
export interface DrizzleTypeError<T extends string> {
	$drizzleTypeError: T;
}
```

```typescript
// drizzle-orm/src/query-promise.ts:3-35
// QueryPromise — await 可能なクエリビルダー（Promise インターフェースを実装）
export abstract class QueryPromise<T> implements Promise<T> {
	static readonly [entityKind]: string = 'QueryPromise';
	[Symbol.toStringTag] = 'QueryPromise';

	then<TResult1 = T, TResult2 = never>(
		onFulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null,
		onRejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null,
	): Promise<TResult1 | TResult2> {
		return this.execute().then(onFulfilled, onRejected);
	}

	abstract execute(): Promise<T>;
}
```

## パターンカタログ

- **Builder パターン** (分類: 生成)
  - 解決する問題: SQL クエリの段階的な組み立てを型安全に行う
  - 適用条件: 可変数の句（WHERE, JOIN, ORDER BY 等）を持つクエリの構築
  - コード例: `pg-core/query-builders/select.ts:62-150` の PgSelectBuilder → PgSelectBase の変換
  - 注意点: 各メソッド呼び出しが型パラメータを変更するため、`.leftJoin()` 後の結果型は自動的に nullable カラムを含む。型パラメータのジェネリック数が多く（8 個以上）、型エラー時のメッセージが複雑になる

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: 各データベース方言での SQL 生成ロジックの共通化
  - 適用条件: Dialect クラスで `escapeName`, `escapeParam` 等のプリミティブを定義し、`buildSelectQuery` 等の高レベルメソッドから呼び出す
  - コード例: `pg-core/dialect.ts:114-124` vs `mysql-core/dialect.ts` で異なるエスケープ規則
  - 注意点: 新しい SQL 機能の追加時は Dialect 層の修正が必要だが、Driver 層は影響を受けない

- **Adapter パターン** (分類: 構造)
  - 解決する問題: 異なるドライバーライブラリ（pg, better-sqlite3, libsql 等）への統一インターフェースの提供
  - 適用条件: Session 抽象クラスを各ドライバーが実装し、共通の execute/all/transaction インターフェースを提供
  - コード例: `node-postgres/session.ts:21-60` の NodePgPreparedQuery
  - 注意点: ドライバー固有の型情報（`pg.QueryResult` 等）は import type で取り込み、ランタイム依存は発生しない

## Good Patterns

- **Tagged Template Literal による SQL インジェクション防止と型安全の両立**: `sql` テンプレートリテラルは文字列部分とパラメータを構造的に分離する。`sql\`SELECT * FROM ${users} WHERE ${users.id} = ${userId}\`` は `SELECT * FROM "users" WHERE "users"."id" = $1` とパラメータ `[userId]` に変換される。SQL を直接書く自由度を保ちつつ、パラメータは自動的にプレースホルダーに置換される。

```typescript
// drizzle-orm/src/sql/expressions/conditions.ts:62-63
export const eq: BinaryOperator = (left: SQLWrapper, right: unknown): SQL => {
	return sql`${left} = ${bindIfParam(right, left)}`;
};
```

- **declare による零コスト型メタデータ**: `declare readonly _:` で型情報をクラスに付与する。バンドルサイズに影響せず、`table.$inferSelect` で利用者がスキーマから TypeScript 型を導出できる。

```typescript
// drizzle-orm/src/table.ts:52-63
declare readonly _: {
	readonly brand: 'Table';
	readonly config: T;
	readonly name: T['name'];
	readonly schema: T['schema'];
	readonly columns: T['columns'];
	readonly inferSelect: InferSelectModel<Table<T>>;
	readonly inferInsert: InferInsertModel<Table<T>>;
};
declare readonly $inferSelect: InferSelectModel<Table<T>>;
declare readonly $inferInsert: InferInsertModel<Table<T>>;
```

- **ESLint プラグインによる安全ネット**: `eslint-plugin-drizzle` は `.delete()` や `.update()` が `.where()` なしで使われた場合に警告する。型システムでは防げない「全行削除」のようなロジックエラーを静的解析でカバーする。

```typescript
// eslint-plugin-drizzle/src/enforce-delete-with-where.ts:38
if (node.property.name === 'delete' && lastNodeName !== 'where' && isDrizzleObj(node, options)) {
	context.report({ node, messageId: 'enforceDeleteWithWhere', ... });
}
```

## Anti-Patterns / 注意点

- **ジェネリックパラメータの過剰な積み上げ**: PgSelectQueryBuilderBase は 10 個のジェネリック型パラメータを持つ。これにより型推論は正確だが、型エラーのメッセージは極めて読みにくくなる。

```typescript
// Bad: 10個のジェネリック型パラメータ（drizzle-orm/src/pg-core/query-builders/select.ts:153-164）
export abstract class PgSelectQueryBuilderBase<
	THKT extends PgSelectHKTBase,
	TTableName extends string | undefined,
	TSelection extends ColumnsSelection,
	TSelectMode extends SelectMode,
	TNullabilityMap extends Record<string, JoinNullability>,
	TDynamic extends boolean,
	TExcludedMethods extends string,
	TResult extends any[],
	TSelectedFields extends ColumnsSelection,
> extends TypedQueryBuilder<TSelectedFields, TResult> { ... }

// Better: 設定オブジェクト型でジェネリックをグループ化する
interface SelectConfig {
	tableName: string | undefined;
	selection: ColumnsSelection;
	selectMode: SelectMode;
	nullabilityMap: Record<string, JoinNullability>;
}
// ただし TypeScript の型推論の制約上、個別ジェネリックの方が推論精度が高い場合がある
```

- **型安全と SQL 自由度のトレードオフにおけるエスケープハッチの乱用**: `sql.raw()` は SQL インジェクションを防がない。ドキュメントに警告はあるが、`sql.identifier()` との使い分けが曖昧になりがちである。

```typescript
// Bad: ユーザー入力を sql.raw に渡す
const tableName = userInput;
const query = sql`SELECT * FROM ${sql.raw(tableName)}`;

// Better: sql.identifier を使う（エスケープされる）
const query = sql`SELECT * FROM ${sql.identifier(tableName)}`;
```

## 導出ルール

- `[MUST]` API が既知のドメイン言語（SQL, CSS, HTML 等）に対応する場合、その構文順序と命名をそのまま反映させる
  - 根拠: Drizzle の `select().from().where().orderBy()` は SQL 句順と一致し、SQL 知識者の学習コストをゼロにしている（`pg-core/query-builders/select.ts` 全体の設計）

- `[MUST]` ライブラリのランタイム依存は 0 に保ち、外部ライブラリはすべて optional な peer dependency として宣言する
  - 根拠: `drizzle-orm/package.json` に `"dependencies"` フィールドが存在せず、20 以上のドライバーすべてが `peerDependenciesMeta` で optional 指定されている

- `[SHOULD]` 型レベルのメタデータには `declare` キーワードを使い、ランタイムコスト 0 で型推論を支援する
  - 根拠: Drizzle はすべてのクラスで `declare readonly _:` パターンを使い、バンドルサイズに影響なく `$inferSelect` / `$inferInsert` の型導出を実現している（`table.ts:52-63`）

- `[SHOULD]` `instanceof` の代わりにブランドプロパティ（Symbol ベースの識別子）を使用し、バージョン不一致や異なるバンドルコンテキストでも型判別が機能するようにする
  - 根拠: `entityKind` シンボルと `is()` 関数により、モノレポやサーバーレス環境での複数インスタンス問題を回避している（`entity.ts:1-42`）

- `[SHOULD]` 型システムでは防げないロジックエラーに対して、専用の ESLint プラグインやランタイムバリデーションで補完する
  - 根拠: `eslint-plugin-drizzle` が `.delete()` / `.update()` の `.where()` 忘れを静的解析で検出する（`enforce-delete-with-where.ts`）

- `[SHOULD]` 型レベルのエラーメッセージを提供し、ユーザーがコンパイルエラーから対処法を読み取れるようにする
  - 根拠: `DrizzleTypeError<"message">` 型により、型エラー時に具体的な修正指示が表示される（`utils.ts:174-176`, `select.types.ts:123`）

- `[AVOID]` ORM の抽象化にエスケープハッチを設けずにリリースすること。生 SQL や独自型定義への降格パスがないと、ORM がボトルネックになる
  - 根拠: `sql` テンプレートリテラル、`sql.raw()`, `customType()`, knex/kysely 互換型により、Drizzle の抽象化を超えた操作が常に可能（`pg-core/columns/custom.ts:200-232`）

## 適用チェックリスト

- [ ] ライブラリの API 設計がターゲットドメインの言語（SQL, GraphQL 等）の構文順序を反映しているか確認する
- [ ] `declare` キーワードで型メタデータを保持し、ランタイムバンドルへの影響を排除しているか確認する
- [ ] `package.json` の `dependencies` を最小化し、ドライバーやアダプターは `peerDependencies`（optional）として宣言しているか確認する
- [ ] `"sideEffects": false` を設定し、使用されないドライバーコードがツリーシェイクで除外されるようにしているか確認する
- [ ] `instanceof` チェックの代わりにブランドプロパティまたは Symbol ベースの型判別を使用し、マルチバージョン環境での互換性を確保しているか確認する
- [ ] 型システムだけでは検出できないロジックエラーに対して、ESLint ルールまたはランタイムバリデーションによる安全ネットを設けているか確認する
- [ ] 抽象化のエスケープハッチ（生 SQL 埋め込み、カスタム型定義等）を提供し、ライブラリの制約がユーザーのボトルネックにならないようにしているか確認する
- [ ] 型エラー時にユーザーが読めるメッセージが表示されるよう、ブランド型やカスタムエラー型を活用しているか確認する
