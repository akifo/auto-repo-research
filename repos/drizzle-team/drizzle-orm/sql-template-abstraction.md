# SQL テンプレート抽象化

> リポジトリ: drizzle-team/drizzle-orm
> 分析日: 2026-03-04

## 概要

Drizzle ORM の SQL テンプレートリテラルシステムは、TypeScript のタグ付きテンプレート（`sql`\`...\``）を使って SQL フラグメントを型安全に合成する仕組みである。SQL 文字列の直接結合を避け、チャンクの再帰的な木構造として SQL を表現することで、パラメータ化・エスケープ・方言差異の吸収を一元化している。式ヘルパー（`eq`, `and`, `or` 等）はすべてこのテンプレートシステムの上に構築されており、DSL 的な使いやすさとロー SQL の柔軟性を両立させている点が注目に値する。

## 背景にある原則

- **SQL はデータ構造であり文字列ではない**: SQL を `string` として扱わず、`SQL` クラス（チャンクの配列）として表現する。これにより、合成・条件付き挿入・パラメータ抽出を安全に行える。タグ付きテンプレートは構文上の入口に過ぎず、内部では `StringChunk`, `Param`, `Name`, `SQL`（ネスト）等の異種チャンクの配列として保持される（`drizzle-orm/src/sql/sql.ts:118`）。

- **統一インターフェースによる合成可能性**: `SQLWrapper` インターフェース（`getSQL(): SQL` メソッドを持つ）をテーブル・カラム・ビュー・サブクエリ・式すべてに実装させることで、あらゆる SQL 構成要素をテンプレート内に自由に埋め込める。これが「合成の通貨」として機能している（`drizzle-orm/src/sql/sql.ts:65-68`）。

- **パラメータバインドの自動化と明示の棲み分け**: `bindIfParam` 関数がプリミティブ値を自動的に `Param` でラップし、既に SQL 構造を持つ値はそのまま通す。これにより、ユーザーは `eq(column, 'value')` のようにプリミティブを直接渡せる一方、SQL 式を渡す場合は二重バインドを防げる（`drizzle-orm/src/sql/expressions/conditions.ts:17-30`）。

- **遅延評価とコンテキスト依存のレンダリング**: SQL オブジェクトは構築時にはチャンク配列を保持するだけで、文字列化は `toQuery()` 呼び出し時に行われる。`BuildQueryConfig` にエスケープ関数やパラメータ形式（PostgreSQL の `$1` と MySQL の `?`）を注入することで、同じ SQL 木を異なる方言で出力できる（`drizzle-orm/src/sql/sql.ts:32-41`）。

## 実例と分析

### タグ付きテンプレートの内部構造

`sql` タグ付きテンプレート関数は、テンプレート文字列の静的部分を `StringChunk` に、補間部分をそのまま `SQLChunk` として交互に配置する。これは JavaScript のタグ付きテンプレートの仕様（`strings` 配列は常に `params` より 1 つ多い）を活用している。

```typescript
// drizzle-orm/src/sql/sql.ts:485-495
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

### 再帰的なチャンク解決

`buildQueryFromSourceParams` メソッドは SQL チャンクを再帰的に解決する。`SQL` チャンクが別の `SQL` を含む場合、内部チャンクを再帰的に展開する。配列チャンクは自動的に括弧で囲まれカンマ区切りになる。`undefined` は空文字列として無視される。

```typescript
// drizzle-orm/src/sql/sql.ts:172-174
if (chunk === undefined) {
	return { sql: '', params: [] };
}

// drizzle-orm/src/sql/sql.ts:188-193  — SQL のネスト解決
if (is(chunk, SQL)) {
	return this.buildQueryFromSourceParams(chunk.queryChunks, {
		...config,
		inlineParams: inlineParams || chunk.shouldInlineParams,
	});
}
```

この `undefined` スキップ機構が、条件付き SQL 挿入の基盤となっている。

### 条件付き SQL 挿入パターン

三項演算子と `undefined` スキップ、または `SQL.if()` メソッドを組み合わせることで、条件付きの SQL フラグメント挿入を実現している。

```typescript
// drizzle-orm/src/sql/sql.ts:369-371  — SQL.if() メソッド
if(condition: any | undefined): this | undefined {
	return condition ? this : undefined;
}
```

```typescript
// drizzle-orm/src/pg-core/dialect.ts:147  — 三項演算子パターン
const whereSql = where ? sql` where ${where}` : undefined;

// drizzle-orm/src/pg-core/query-builders/count.ts:22  — .if() パターン
return sql<number>`(select count(*) from ${source}${sql.raw(' where ').if(filters)}${filters})`;
```

### sql namespace のユーティリティ群

`sql` は関数であると同時に namespace でもあり、ユーティリティ関数群を持つ。これにより `sql.join()`, `sql.raw()`, `sql.empty()`, `sql.identifier()`, `sql.param()`, `sql.placeholder()` を単一のインポートで利用できる。

```typescript
// drizzle-orm/src/sql/sql.ts:497-565
export namespace sql {
	export function empty(): SQL { return new SQL([]); }
	export function raw(str: string): SQL { return new SQL([new StringChunk(str)]); }
	export function join(chunks: SQLChunk[], separator?: SQLChunk): SQL { ... }
	export function identifier(value: string): Name { return new Name(value); }
	export function param<TData, TDriver>(value: TData, encoder?: ...): Param { ... }
	export function placeholder<TName extends string>(name: TName): Placeholder { ... }
}
```

### 式ヘルパーによる DSL 構築

条件式（`eq`, `gt`, `and`, `or` 等）はすべて `sql` テンプレートと `bindIfParam` を組み合わせて実装されている。これにより、新しい式ヘルパーの追加が極めて簡潔になる。

```typescript
// drizzle-orm/src/sql/expressions/conditions.ts:62-64
export const eq: BinaryOperator = (left: SQLWrapper, right: unknown): SQL => {
	return sql`${left} = ${bindIfParam(right, left)}`;
};
```

`and` / `or` は `undefined` を自動フィルタし、`sql.join` で結合する。条件が 0 個なら `undefined` を返し、1 個ならそのまま返すという最適化も行われている。

```typescript
// drizzle-orm/src/sql/expressions/conditions.ts:107-125
export function and(...unfilteredConditions: (SQLWrapper | undefined)[]): SQL | undefined {
	const conditions = unfilteredConditions.filter(
		(c): c is Exclude<typeof c, undefined> => c !== undefined,
	);
	if (conditions.length === 0) return undefined;
	if (conditions.length === 1) return new SQL(conditions);
	return new SQL([
		new StringChunk('('),
		sql.join(conditions, new StringChunk(' and ')),
		new StringChunk(')'),
	]);
}
```

### 方言固有の式ヘルパー

各方言（PostgreSQL, MySQL, SQLite）は共通の式ヘルパーを再エクスポートしつつ、方言固有のヘルパーを追加する。全ての方言で `concat` と `substring` が同じパターンで実装されているが、SQLite のみ `rowId()` を追加している。

```typescript
// drizzle-orm/src/sqlite-core/expressions.ts:27-29
export function rowId(): SQL<number> {
	return sql<number>`rowid`;
}
```

### エンティティ種別判定（entityKind）

チャンクの型判別に `instanceof` ではなく `entityKind` シンボルベースの `is()` 関数を使っている。これはプロトタイプチェーンを辿って判定するため、異なるバージョンの drizzle パッケージが混在する場合でも正しく動作する。

```typescript
// drizzle-orm/src/entity.ts:12-42
export function is<T extends DrizzleEntityClass<any>>(value: any, type: T): value is InstanceType<T> {
	if (!value || typeof value !== 'object') return false;
	if (value instanceof type) return true;
	// ...プロトタイプチェーンを辿る
	let cls = Object.getPrototypeOf(value).constructor;
	if (cls) {
		while (cls) {
			if (entityKind in cls && cls[entityKind] === type[entityKind]) return true;
			cls = Object.getPrototypeOf(cls);
		}
	}
	return false;
}
```

## コード例

```typescript
// drizzle-orm/src/sql/sql.ts:118
// SQL クラスのコンストラクタ — チャンク配列を受け取る
constructor(readonly queryChunks: SQLChunk[]) {
	for (const chunk of queryChunks) {
		if (is(chunk, Table)) {
			const schemaName = chunk[Table.Symbol.Schema];
			this.usedTables.push(
				schemaName === undefined
					? chunk[Table.Symbol.Name]
					: schemaName + '.' + chunk[Table.Symbol.Name],
			);
		}
	}
}
```

```typescript
// drizzle-orm/src/pg-core/dialect.ts:440-441
// 複数の SQL フラグメントを undefined 許容で合成する SELECT 文の最終組み立て
const finalQuery =
	sql`${withSql}select${distinctSql} ${selection} from ${tableSql}${joinsSql}${whereSql}${groupBySql}${havingSql}${orderBySql}${limitSql}${offsetSql}${lockingClauseSql}`;
```

```typescript
// drizzle-orm/src/pg-core/dialect.ts:420-438
// sql.empty() + append で命令的に SQL を組み立てるパターン
const lockingClauseSql = sql.empty();
if (lockingClause) {
	const clauseSql = sql` for ${sql.raw(lockingClause.strength)}`;
	if (lockingClause.config.of) {
		clauseSql.append(
			sql` of ${sql.join(
				Array.isArray(lockingClause.config.of) ? lockingClause.config.of : [lockingClause.config.of],
				sql`, `,
			)}`
		);
	}
	if (lockingClause.config.noWait) {
		clauseSql.append(sql` nowait`);
	} else if (lockingClause.config.skipLocked) {
		clauseSql.append(sql` skip locked`);
	}
	lockingClauseSql.append(clauseSql);
}
```

```typescript
// drizzle-orm/src/sql/functions/aggregate.ts:19-20
// mapWith による結果型のデコード指定
export function count(expression?: SQLWrapper): SQL<number> {
	return sql`count(${expression || sql.raw('*')})`.mapWith(Number);
}
```

```typescript
// drizzle-orm/src/sql/expressions/conditions.ts:17-30
// bindIfParam — プリミティブ値の自動パラメータバインド
export function bindIfParam(value: unknown, column: SQLWrapper): SQLChunk {
	if (
		isDriverValueEncoder(column)
		&& !isSQLWrapper(value)
		&& !is(value, Param)
		&& !is(value, Placeholder)
		&& !is(value, Column)
		&& !is(value, Table)
		&& !is(value, View)
	) {
		return new Param(value, column);
	}
	return value as SQLChunk;
}
```

## パターンカタログ

- **Interpreter パターン** (分類: 振る舞い)
  - 解決する問題: SQL 文法をオブジェクト構造として表現し、異なるコンテキスト（方言）で解釈する
  - 適用条件: DSL の構文木を構築し、複数のバックエンドで出力する必要がある場合
  - コード例: `drizzle-orm/src/sql/sql.ts:148-299` — `buildQueryFromSourceParams` がチャンク種別ごとに分岐して解釈する
  - 注意点: チャンク種別の追加には `buildQueryFromSourceParams` の分岐追加が必要になるため、Open-Closed 原則には完全には従わない

- **Composite パターン** (分類: 構造)
  - 解決する問題: 単一の SQL 式と複合 SQL 式を同一の型で扱う
  - 適用条件: ツリー構造の再帰的合成が必要な場合
  - コード例: `drizzle-orm/src/sql/sql.ts:463-476` — `SQLChunk` 型は `SQL` 自身を含む再帰的ユニオン型
  - 注意点: 循環参照を防ぐため、`Column.prototype.getSQL` は別ファイルで定義されている（`sql.ts:710-712`）

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: エスケープ・パラメータ形式を方言ごとに切り替える
  - 適用条件: 同じデータ構造を異なるフォーマットで出力する場合
  - コード例: `drizzle-orm/src/sql/sql.ts:32-41` — `BuildQueryConfig` の `escapeName`, `escapeParam`, `escapeString`
  - 注意点: Strategy は構築時ではなく出力時に注入される（遅延評価）

## Good Patterns

- **undefined スキップによる宣言的な条件付き SQL 合成**: テンプレート内で `undefined` が自動スキップされることを利用し、`const whereSql = where ? sql\` where \${where}\` : undefined` のように条件付きフラグメントを変数として用意し、最終テンプレートに `${whereSql}` で埋め込む。命令的な文字列結合と比べて、最終形の構造が一目で見える。

```typescript
// drizzle-orm/src/pg-core/dialect.ts:140-149
buildDeleteQuery({ table, where, returning, withList }: PgDeleteConfig): SQL {
	const withSql = this.buildWithCTE(withList);
	const returningSql = returning
		? sql` returning ${this.buildSelection(returning, { isSingleTable: true })}`
		: undefined;
	const whereSql = where ? sql` where ${where}` : undefined;
	return sql`${withSql}delete from ${table}${whereSql}${returningSql}`;
}
```

- **and/or の undefined 自動フィルタリング**: `and()` / `or()` が `undefined` 引数を自動的に除外するため、条件のオプショナル合成が安全に行える。条件が 0 個のとき `undefined` を返すことで、呼び出し側のさらなる条件分岐にも対応する。

```typescript
// ユーザーコードでの利用例
const conditions = and(
	eq(users.role, 'admin'),
	searchTerm ? like(users.name, `%${searchTerm}%`) : undefined,
	minAge ? gte(users.age, minAge) : undefined,
);
// conditions は undefined | SQL
```

- **sql namespace パターン**: 関数と namespace の二重定義により、`sql\`...\`` と `sql.join()` を同一のインポートで使える。ユーザーの認知負荷を下げつつ、名前空間の汚染を防いでいる。

```typescript
import { sql } from 'drizzle-orm';
// タグ付きテンプレートとして
sql`SELECT * FROM ${users}`;
// namespace ユーティリティとして
sql.join([sql`a`, sql`b`], sql`, `);
sql.raw('SELECT 1');
sql.identifier('table-name');
```

- **bindIfParam による透過的パラメータ化**: 式ヘルパーが `bindIfParam` を通して値を受け取ることで、プリミティブ値も SQL 式も同じ API で渡せる。カラムのエンコーダ情報を使って適切な型変換も自動適用される。

## Anti-Patterns / 注意点

- **sql.raw() の安全でない使用**: `sql.raw()` はエスケープなしに文字列を SQL に埋め込むため、ユーザー入力を直接渡すと SQL インジェクションの危険がある。コードベース内でも `sql.identifier()` のドキュメントに「WARNING: This function does not offer any protection against SQL injections」と明記されている。

```typescript
// Bad: ユーザー入力を直接 raw に渡す
const query = sql.raw(`SELECT * FROM ${userInput}`);

// Better: sql.identifier() でエスケープし、値は補間で渡す
const query = sql`SELECT * FROM ${sql.identifier(tableName)} WHERE id = ${userId}`;
```

- **sql.empty() + append の多用**: `sql.empty()` で空の SQL を作って `append` で組み立てるパターンは命令的で、最終形が見づらくなる。条件付きフラグメントは変数 + undefined パターンの方が宣言的である。ただし、ループ内で動的にフラグメントを追加する場合（locking clause の組み立て等）では append が適切。

```typescript
// 命令的（append チェーン）
const query = sql.empty();
query.append(sql`SELECT * FROM users`);
if (where) query.append(sql` WHERE ${where}`);

// 宣言的（undefined スキップ）
const whereSql = where ? sql` WHERE ${where}` : undefined;
const query = sql`SELECT * FROM users${whereSql}`;
```

- **型引数なしの sql テンプレート**: `sql\`...\`` はデフォルトで `SQL<unknown>` を返す。SELECT の結果型を活かすには `sql<number>\`count(*)\`` のように型引数を付けるか、`.mapWith()` でデコーダを指定する必要がある。

```typescript
// Bad: 型情報なし
const result = sql`count(*)`;  // SQL<unknown>

// Better: 型引数またはmapWithで型を指定
const result = sql<number>`count(*)`.mapWith(Number);
```

## 導出ルール

- `[MUST]` SQL テンプレートシステムを構築する場合、補間値をプリミティブ文字列ではなくパラメータ化されたチャンクとして保持し、文字列化を最終出力時まで遅延させる
  - 根拠: Drizzle ORM は `SQL` クラスにチャンク配列を持たせ、`toQuery()` 時に初めてパラメータ番号の割り当てとエスケープを行うことで、方言差異の吸収とパラメータ化を一元化している（`sql.ts:137-146`）

- `[MUST]` 条件付き SQL フラグメントの合成には、`undefined` を「存在しない」を表す値として一貫して扱い、合成エンジン側で自動スキップする設計にする
  - 根拠: Drizzle ORM は `buildQueryFromSourceParams` で `undefined` チャンクを空文字列にマッピングし（`sql.ts:172-174`）、`and()`/`or()` でも `undefined` 引数をフィルタすることで（`conditions.ts:108-109`）、呼び出し側の条件分岐を最小化している

- `[MUST]` エスケープなしに文字列を SQL に埋め込む関数（`raw()` 等）はユーザー入力に対して使用しない。動的な識別子には専用のエスケープ付き関数（`identifier()` 等）を使う
  - 根拠: `sql.raw()` は `StringChunk` としてそのまま出力され、パラメータ化もエスケープも行われないため、SQL インジェクションの直接的な原因となる

- `[SHOULD]` 合成可能な SQL フラグメントを作るためのインターフェース（Drizzle の `SQLWrapper`）を定義し、テーブル・カラム・式・サブクエリ等すべての SQL 構成要素に実装させる
  - 根拠: `SQLWrapper` の `getSQL()` メソッドにより、異なる種類の SQL 構成要素を統一的にテンプレート内に埋め込めるようになっている（`sql.ts:65-68`）。これが式の自由な合成を支えている

- `[SHOULD]` バイナリ演算式（`eq`, `gt` 等）では、右辺の値が既に SQL 構造かプリミティブかを判別し、プリミティブの場合のみ自動パラメータ化する（`bindIfParam` パターン）
  - 根拠: `bindIfParam` は `isDriverValueEncoder` と `isSQLWrapper` の判定を組み合わせることで、二重バインドを防ぎつつプリミティブ値の型変換も適用している（`conditions.ts:17-30`）

- `[SHOULD]` 可変個数の条件を合成する関数（`and`, `or` 等）では、条件が 0 個のとき `undefined`、1 個のとき単体を返し、2 個以上のときのみ括弧とセパレータで結合する
  - 根拠: この最適化により、`and(onlyOneCondition)` が不要な括弧なしの SQL を生成し、`and()` が `undefined` を返すことで上位の条件合成にも正しく伝播する（`conditions.ts:112-125`）

- `[AVOID]` SQL テンプレートシステムにおいて `instanceof` による型判別を使う。パッケージのバージョン不一致やバンドラの重複により `instanceof` が失敗する環境がある
  - 根拠: Drizzle ORM は `entityKind` シンボル + プロトタイプチェーン辿りの `is()` 関数を使い、`instanceof` が失敗する環境でも正しく型判別できるようにしている（`entity.ts:12-42`）

## 適用チェックリスト

- [ ] SQL テンプレートシステムで補間値を文字列結合ではなくパラメータ化チャンクとして保持しているか
- [ ] 条件付き SQL フラグメントの生成で `undefined` スキップパターン（宣言的合成）を活用しているか
- [ ] `sql.raw()` 相当のエスケープなし埋め込みがユーザー入力に対して使われていないか
- [ ] SQL の構成要素（テーブル、カラム、式、サブクエリ）に共通インターフェースを実装させ、テンプレート内で統一的に扱えるようにしているか
- [ ] バイナリ演算の式ヘルパーで `bindIfParam` 相当のプリミティブ自動パラメータ化を行っているか
- [ ] `and()` / `or()` 相当の可変条件合成で空引数・単一引数の最適化を行っているか
- [ ] 型判別に `instanceof` ではなくシンボルベースの判定を使っているか（マルチパッケージ環境を想定する場合）
- [ ] 文字列化（レンダリング）をビルド時ではなく出力時に遅延させ、方言ごとのエスケープ戦略を注入可能にしているか
