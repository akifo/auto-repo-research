# architecture

> リポジトリ: drizzle-team/drizzle-orm
> 分析日: 2026-03-04

## 概要

drizzle-orm は core / dialect / driver / session の4層レイヤードアーキテクチャを採用し、20以上のデータベースドライバを単一のコードベースで支えている。各レイヤーは「下位は上位を知らない」という厳格な依存方向を持ち、抽象クラスと HKT（Higher-Kinded Type）パターンを組み合わせることで、型安全性を犠牲にせずにドライバの差し替えを実現している。この設計は「多方言 ORM」という問題領域に対する、TypeScript ならではの構造的な回答として注目に値する。

## 背景にある原則

- **依存の逆転で拡張可能性を確保する**: 上位レイヤー（dialect, db）は抽象型（`PgSession`, `PgPreparedQuery`）に依存し、具体的なドライバ実装を知らない。これにより、新しいドライバ追加時に dialect や query builder の変更が不要になる。`PgDatabase` が `PgSession` 抽象クラスだけを参照し、`NodePgSession` や `NeonHttpSession` といった具象クラスに直接依存しない設計がこの原則を体現している（`pg-core/db.ts:56-60`）。

- **方言固有ロジックを dialect レイヤーに封じ込める**: SQL 生成はすべて dialect クラス（`PgDialect`, `MySqlDialect`, `SQLiteDialect`）に集約し、session やドライバに SQL 構築ロジックを漏洩させない。`PgDialect.buildDeleteQuery()` や `PgDialect.buildUpdateQuery()` のように、SQL 文字列の組み立ては dialect の責務であり、session は `dialect.sqlToQuery()` の結果を受け取って実行するだけである（`pg-core/dialect.ts:140-149`）。

- **ドライバの多様性を HKT で型安全に吸収する**: 各ドライバが返す結果型（`QueryResult`, `FullQueryResults` 等）が異なる問題を、TypeScript の HKT エミュレーション（`PgQueryResultHKT` インターフェース）で解決している。ドライバごとに `type` フィールドを特殊化することで、ジェネリクスだけでは表現できない「型コンストラクタの抽象化」を実現している（`pg-core/session.ts:284-292`）。

- **Column を値変換の境界とする**: `Column.mapFromDriverValue()` / `Column.mapToDriverValue()` がドライバ固有の値型とアプリケーション型の変換境界を形成している。これにより、ドライバが返す生の値（文字列の timestamp、文字列の bigint 等）をカラム定義ごとに適切な型へ変換でき、ドライバ間の差異をカラム層で吸収する（`column.ts:115-121`）。

## 実例と分析

### 4層レイヤーの構成と依存方向

コードベースは以下の4層で構成され、依存方向は上から下への一方向である。

**Layer 1: Core（`src/` 直下）** -- テーブル、カラム、SQL 式の抽象定義。方言に依存しない。`Table`, `Column`, `ColumnBuilder`, `SQL`, `SQLWrapper` がこの層に属する。

**Layer 2: Dialect（`src/pg-core/`, `src/mysql-core/`, `src/sqlite-core/`）** -- 方言固有のテーブル・カラム・クエリビルダー・SQL 生成ロジック。Core に依存し、Driver には依存しない。`PgDialect`, `PgTable`, `PgColumn`, `PgSelectBuilder` 等がこの層に属する。

**Layer 3: Session（dialect 内の `session.ts`）** -- クエリの準備・実行の抽象インターフェース。Dialect に依存するが、具体的なドライバクライアントには依存しない。`PgSession`, `PgPreparedQuery` がこの層に属する。

**Layer 4: Driver（`src/node-postgres/`, `src/neon-http/`, `src/better-sqlite3/` 等）** -- 具体的なデータベースクライアントを Session インターフェースに適合させるアダプター。上位すべてに依存する。`NodePgSession`, `NodePgPreparedQuery`, `NodePgDriver` がこの層に属する。

```
Core (table.ts, column.ts, sql/)
  ↑
Dialect (pg-core/, mysql-core/, sqlite-core/)
  ↑
Session (pg-core/session.ts -- abstract)
  ↑
Driver (node-postgres/, neon-http/, better-sqlite3/ -- concrete)
```

### クエリ実行の流れに見るレイヤー間インタラクション

`db.select().from(users).where(eq(users.id, 1))` の実行フローを追跡すると、レイヤー間の責務分離が明確になる。

1. **PgDatabase.select()** が `PgSelectBuilder` を生成（`session` と `dialect` を注入）
2. **PgSelectBuilder.from()** がテーブル情報を受け取り `PgSelectBase` を生成
3. **PgSelectBase.execute()** が `_prepare()` を呼び、`dialect.sqlToQuery()` で SQL を生成した後、`session.prepareQuery()` で `PreparedQuery` を取得
4. **PreparedQuery.execute()** が具体的なドライバクライアント（`pg.Pool.query()` 等）を呼び出し、結果を `mapResultRow()` で型変換して返す

```typescript
// pg-core/query-builders/select.ts:1078-1097
_prepare(name?: string): PgSelectPrepare<this> {
    const { session, config, dialect, joinsNotNullableMap } = this;
    // ...
    return tracer.startActiveSpan('drizzle.prepareQuery', () => {
        const fieldsList = orderSelectedFields<PgColumn>(fields);
        const query = session.prepareQuery<...>(
            dialect.sqlToQuery(this.getSQL()),  // dialect が SQL 生成
            fieldsList,                          // session が実行を担当
            name,
            true,
            ...
        );
        query.joinsNotNullableMap = joinsNotNullableMap;
        return query;
    });
}
```

### ドライバアダプターの統一パターン

20以上のドライバはすべて同じ3ファイル構成で実装されている。

```
src/<driver>/
  ├── driver.ts   -- drizzle() ファクトリ関数、Driver クラス
  ├── session.ts  -- *Session extends PgSession/SQLiteSession/MySqlSession
  └── migrator.ts -- マイグレーション実装（オプション）
```

各ドライバの `driver.ts` 内の `construct()` 関数は、dialect→driver→session→db の組み立てを責務とする。

```typescript
// node-postgres/driver.ts:49-88
function construct<TSchema>(client: TClient, config: DrizzleConfig<TSchema>) {
    const dialect = new PgDialect({ casing: config.casing });
    // ...
    const driver = new NodePgDriver(client, dialect, { logger, cache });
    const session = driver.createSession(schema);
    const db = new NodePgDatabase(dialect, session, schema);
    return db;
}
```

この組み立てパターンは `better-sqlite3/driver.ts`, `d1/driver.ts`, `neon-http/driver.ts` 等すべてのドライバで同一構造をとる。

### entityKind による安全な型識別

`instanceof` の代わりに `entityKind` Symbol を用いた型識別システムは、バンドラー環境やマルチバージョン環境で `instanceof` が壊れる問題を解決している。

```typescript
// entity.ts:1-42
export const entityKind = Symbol.for('drizzle:entityKind');

export function is<T extends DrizzleEntityClass<any>>(value: any, type: T): value is InstanceType<T> {
    if (value instanceof type) return true;
    // instanceof が失敗した場合、プロトタイプチェーンを辿って entityKind を比較
    let cls = Object.getPrototypeOf(value).constructor;
    while (cls) {
        if (entityKind in cls && cls[entityKind] === type[entityKind]) return true;
        cls = Object.getPrototypeOf(cls);
    }
    return false;
}
```

`Symbol.for()` はグローバルシンボルレジストリを使うため、異なるバンドルや異なるバージョンの drizzle-orm が混在しても同一の Symbol が得られる。すべてのクラスに `static readonly [entityKind]: string = 'ClassName'` を付与し、`is()` 関数でチェックする統一パターンとなっている。

### HKT による結果型の抽象化

TypeScript には Higher-Kinded Type がないため、drizzle-orm は「ブランド付きインターフェース + intersection で型を特殊化する」パターンで HKT をエミュレートしている。

```typescript
// pg-core/session.ts:284-292
export interface PgQueryResultHKT {
    readonly $brand: 'PgQueryResultHKT';
    readonly row: unknown;
    readonly type: unknown;  // 「型変数のスロット」
}

export type PgQueryResultKind<TKind extends PgQueryResultHKT, TRow> = (TKind & {
    readonly row: TRow;    // row を特殊化
})['type'];                // type を取り出す
```

各ドライバが `type` フィールドを具体型にマッピングする。

```typescript
// node-postgres/session.ts:304-306
export interface NodePgQueryResultHKT extends PgQueryResultHKT {
    type: QueryResult<Assume<this['row'], QueryResultRow>>;
}
```

これにより `PgDatabase<NodePgQueryResultHKT>` の型パラメータを通じて、ドライバ固有の結果型が型レベルで伝播する。

## パターンカタログ

- **Abstract Factory** (生成)
  - 解決する問題: 方言ごとに異なるテーブル・カラム・クエリビルダーの整合的な生成
  - 適用条件: 関連するオブジェクト群を方言ごとに一貫して生成する必要がある場合
  - コード例: `pg-core/table.ts:71-137` の `pgTableWithSchema()` が `PgTable`、`PgColumn` を組み立て
  - 注意点: drizzle-orm では GoF の Factory クラスではなく、関数（`pgTable`, `mysqlTable`, `sqliteTable`）としてユーザーに公開している

- **Template Method** (振る舞い)
  - 解決する問題: session / dialect の共通フロー（prepare → execute → map）を定義し、ドライバ固有部分だけをオーバーライドさせる
  - 適用条件: アルゴリズムの骨格は共通だが、ステップの実装がドライバごとに異なる場合
  - コード例: `PgSession.execute()` (`pg-core/session.ts:190-207`) が `prepareQuery()` を呼び出し、サブクラスが `prepareQuery()` を実装
  - 注意点: `transaction()` も同様のパターンで、`NodePgSession` と `NeonHttpSession` で実装が異なる

- **Adapter** (構造)
  - 解決する問題: 異なるドライバ API（`pg.Pool.query()`, `neon()`, `D1Database.prepare()`）を統一インターフェースに適合させる
  - 適用条件: 既存の外部ライブラリを統一的に扱う必要がある場合
  - コード例: `NodePgPreparedQuery` が `pg.Pool.query()` を `PgPreparedQuery.execute()` に適合（`node-postgres/session.ts:21-194`）
  - 注意点: 各ドライバの PreparedQuery がアダプターの役割を担い、ドライバ固有の結果型マッピングもここに閉じ込める

- **Strategy** (振る舞い)
  - 解決する問題: SQL 生成ロジックの方言別切り替え
  - 適用条件: 同じ操作（SELECT, INSERT, UPDATE, DELETE）が方言ごとに異なる SQL 構文を要する場合
  - コード例: `PgDialect.escapeParam()` は `$1, $2...`、`SQLiteDialect.escapeParam()` は `?`（`pg-core/dialect.ts:118`, `sqlite-core/dialect.ts:61`）

## Good Patterns

- **一貫した3ファイル構成でドライバを追加**: すべてのドライバが `driver.ts` / `session.ts` / `migrator.ts` という同一構造を持つ。新しいドライバを追加する開発者は、既存のドライバをコピーして具象メソッドを埋めるだけでよい。構造が予測可能なため、コードレビューやメンテナンスも効率的になる。

```typescript
// 全ドライバ共通の組み立てパターン（node-postgres/driver.ts:49-88 を代表例として）
function construct(client, config) {
    const dialect = new PgDialect({ casing: config.casing });
    const driver = new NodePgDriver(client, dialect, { logger, cache });
    const session = driver.createSession(schema);
    const db = new NodePgDatabase(dialect, session, schema);
    return db;
}
```

- **Symbol.for による cross-bundle 型識別**: `instanceof` が壊れるエッジケースを、グローバル Symbol レジストリを活用して解決している。`Symbol.for('drizzle:entityKind')` は異なるパッケージバージョン間でも同一のシンボルを返すため、バンドル境界を超えた型チェックが可能になる。

```typescript
// entity.ts:1
export const entityKind = Symbol.for('drizzle:entityKind');
// 全クラスで統一的に宣言
static readonly [entityKind]: string = 'PgColumn';
```

- **Column がドライバ値変換の責務を持つ**: `mapFromDriverValue` / `mapToDriverValue` を Column サブクラスに定義することで、変換ロジックがカラム型に局所化される。ドライバ側は生の値をそのまま渡せばよく、変換の責務を負わない。

```typescript
// pg-core/columns/json.ts:44-57
override mapToDriverValue(value: T['data']): string {
    return JSON.stringify(value);
}
override mapFromDriverValue(value: T['data'] | string): T['data'] {
    if (typeof value === 'string') {
        try { return JSON.parse(value); }
        catch { return value as T['data']; }
    }
    return value;
}
```

## Anti-Patterns / 注意点

- **HKT エミュレーションの複雑さ**: TypeScript に HKT がないために用いられる `PgQueryResultHKT` + intersection パターンは、型エラーが発生した際のデバッグが極めて難しい。`Assume<this['row'], QueryResultRow>` のような型レベルキャストも頻出する。

```typescript
// Bad: 型エラー時に追跡困難
export type PgQueryResultKind<TKind extends PgQueryResultHKT, TRow> = (TKind & {
    readonly row: TRow;
})['type'];

// Better: 可能であれば、ジェネリクスのみで解決できる設計を検討する。
// ただし drizzle-orm の場合、ドライバごとの結果型が構造的に異なるため HKT エミュレーションは合理的な選択。
```

- **`queryWithCache` の重複実装**: キャッシュ戦略のロジックが `PgPreparedQuery`, `SQLitePreparedQuery`, `MySqlPreparedQuery` にほぼ同一コードとしてコピーされている。共通の基底クラスまたは mixin に抽出すべき箇所だが、現状はコード重複が残っている（`pg-core/session.ts:64-147`, `sqlite-core/session.ts:70-100`, `mysql-core/session.ts:70-100`）。

## 導出ルール

- `[MUST]` レイヤードアーキテクチャでは依存方向を厳格に一方向に保つ -- 上位レイヤーは抽象型のみに依存し、下位レイヤーの具象クラスを直接 import しない
  - 根拠: drizzle-orm の PgDatabase は PgSession 抽象クラスのみを参照し、NodePgSession 等の具象を知らないことで、20以上のドライバを dialect 変更なしで追加できている（`pg-core/db.ts:56-60`）

- `[MUST]` 外部ライブラリのラッパーを作る際は、すべてのアダプターに同一のファイル構成を適用する
  - 根拠: drizzle-orm の全ドライバが `driver.ts` / `session.ts` / `migrator.ts` の3ファイル構成を統一しており、新規ドライバの追加やレビューが予測可能になっている

- `[SHOULD]` `instanceof` の代わりに、グローバル Symbol（`Symbol.for()`）ベースの型識別を採用する -- バンドラーやモノレポ環境で `instanceof` は壊れやすい
  - 根拠: drizzle-orm は `entityKind` Symbol と `is()` 関数で全エンティティの型チェックを行い、cross-bundle 環境でも安全に動作する設計としている（`entity.ts:1-42`）

- `[SHOULD]` 値の変換責務は、変換元のドメイン型を持つ層（Column 等）に局所化する -- ドライバ層にアプリケーション型の知識を漏洩させない
  - 根拠: `Column.mapFromDriverValue()` / `mapToDriverValue()` により、ドライバが返す生の値とアプリケーション型の変換がカラム定義ごとに閉じている（`column.ts:115-121`, `pg-core/columns/json.ts:44-57`）

- `[SHOULD]` TypeScript で HKT が必要な場面では、ブランド付きインターフェース + intersection による型特殊化パターンを使う -- ただし複雑さのトレードオフを認識した上で採用する
  - 根拠: `PgQueryResultHKT` パターンにより、ドライバ固有の結果型を型安全に伝播させている（`pg-core/session.ts:284-292`）

- `[AVOID]` 各方言の PreparedQuery に同一ロジックをコピーする -- キャッシュ戦略のような横断的関心事は共通基底クラスまたは mixin に抽出する
  - 根拠: `queryWithCache` が PgPreparedQuery / SQLitePreparedQuery / MySqlPreparedQuery に重複しており、変更時に3箇所を同期する必要がある

## 適用チェックリスト

- [ ] プロジェクトのレイヤー間依存方向を図示し、下位→上位への逆依存がないか確認する
- [ ] 外部ライブラリをラップする際、アダプターのファイル構成が統一されているか確認する
- [ ] `instanceof` を使っている箇所で、バンドル分割やモノレポ環境での動作を検証する -- 必要に応じて Symbol ベースの型識別に切り替える
- [ ] ドライバや外部 API の値変換ロジックが、呼び出し側ではなくドメイン型を持つ層に局所化されているか確認する
- [ ] 横断的関心事（ログ、キャッシュ、トレーシング等）が各実装にコピーされていないか確認し、共通基底または mixin への抽出を検討する
- [ ] 多バリアント対応（マルチ DB、マルチプロバイダー等）がある場合、Abstract Factory / Strategy の適用で一貫性を保てているか確認する
