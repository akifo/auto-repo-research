# adapter-implementation-patterns

> リポジトリ: drizzle-team/drizzle-orm
> 分析日: 2026-03-04

## 概要

drizzle-orm は 20 以上のデータベースドライバに対して統一的な ORM API を提供している。各ドライバの差異（同期/非同期、結果型、接続管理方式、トランザクション制御方式）を、3 層の抽象階層（Dialect Core / Session / PreparedQuery）で吸収する設計が特徴的である。この視点では、アダプター群に共通する実装パターンと差分吸収メカニズムを横断的に分析し、「多数のバックエンドを統一 API で束ねるライブラリ」の設計原則を抽出する。

## 背景にある原則

- **Dialect は SQL 生成、Session はドライバ通信を担う（関心の分離）**: SQL の組み立て（`sqlToQuery`）は方言ごとに 1 つの Dialect クラスに集約し、ドライバ固有の通信処理は Session/PreparedQuery に閉じ込めることで、N 個のドライバが Dialect のロジックを重複なく再利用できる。（`pg-core/dialect.ts` が全 PG アダプターで共有、各 `session.ts` が固有の `client.query` を呼ぶ構造）

- **型レベルで結果型の差異を吸収する（HKT パターン）**: 各ドライバは固有の結果型（`QueryResult<Row>`, `RowList<Row[]>`, `Results<Row>` 等）を返すが、これを `QueryResultHKT` インターフェースを用いた型レベル高カインド型（Higher-Kinded Type）エンコーディングで抽象化し、Dialect Core のクエリビルダーが具体的な結果型を知らずに動作可能にしている。

- **不要な機能は Null Object で無効化する（ゼロコスト抽象化）**: Logger、Cache、OpenTelemetry Tracer のすべてが Null Object パターン（`NoopLogger`, `NoopCache`, 条件チェック付き `tracer`）で実装されており、未使用時のランタイムコストを最小化しつつ、全アダプターが同一のコード構造を維持できる。

- **アダプターが実装すべき最小契約を abstract メソッドで強制する**: `prepareQuery` と `transaction` を abstract にすることで、新しいドライバ追加時に「何を実装すべきか」がコンパイル時に明確になる。Session のそれ以外のメソッド（`execute`, `all`, `count`）はデフォルト実装を持ち、アダプターは必要な場合のみオーバーライドする（Template Method パターン）。

## 実例と分析

### 3 層抽象: Database / Session / PreparedQuery

drizzle-orm のアダプターアーキテクチャは、方言（Dialect）ごとに 3 つの抽象層を持つ。

1. **Database 層** (`PgDatabase`, `MySqlDatabase`, `BaseSQLiteDatabase`): ユーザー向け API。select/insert/update/delete のクエリビルダーを提供。
2. **Session 層** (`PgSession`, `MySqlSession`, `SQLiteSession`): ドライバ固有の接続管理とクエリ実行。`prepareQuery` と `transaction` を abstract で定義。
3. **PreparedQuery 層** (`PgPreparedQuery`, `MySqlPreparedQuery`, `SQLitePreparedQuery`): 個々のクエリ実行とキャッシュ制御。`execute` を abstract で定義。

各アダプターはこの 3 層のうち Session と PreparedQuery を具象化する。Database 層はほぼそのまま継承される（一部 `batch` メソッド等を追加）。

### 共通の Session コンストラクタパターン

全アダプターの Session は同一の構造を踏襲する。

```typescript
// node-postgres/session.ts:210-219
constructor(
    private client: NodePgClient,      // ドライバ固有のクライアント
    dialect: PgDialect,                 // 方言（共通）
    private schema: RelationalSchemaConfig<TSchema> | undefined,
    private options: NodePgSessionOptions = {},
) {
    super(dialect);
    this.logger = options.logger ?? new NoopLogger();
    this.cache = options.cache ?? new NoopCache();
}
```

postgres-js, neon-serverless, pglite, vercel-postgres, xata-http, d1, libsql, better-sqlite3, mysql2, planetscale-serverless -- すべてが `(client, dialect, schema, options)` の 4 引数パターンを取り、`NoopLogger` / `NoopCache` をデフォルトに設定する。

### HKT による結果型の差分吸収

各 PG アダプターは固有の `QueryResultHKT` インターフェースを定義する。

```typescript
// node-postgres/session.ts:304-306
export interface NodePgQueryResultHKT extends PgQueryResultHKT {
  type: QueryResult<Assume<this["row"], QueryResultRow>>;
}

// postgres-js/session.ts:219-221
export interface PostgresJsQueryResultHKT extends PgQueryResultHKT {
  type: RowList<Assume<this["row"], Row>[]>;
}

// pglite/session.ts:223-225
export interface PgliteQueryResultHKT extends PgQueryResultHKT {
  type: Results<Assume<this["row"], Row>>;
}
```

`PgQueryResultHKT` の `$brand` フィールドと `Assume` ユーティリティ型を用いた HKT エンコーディングにより、型パラメータ `TRow` を渡すと各ドライバ固有の結果型が導出される。これは TypeScript に HKT がない制約を回避するためのイディオムである。

### SQLite の sync/async 二分岐

SQLite アダプターは `TResultKind extends 'sync' | 'async'` という型パラメータで同期/非同期の差異を吸収する。

```typescript
// sqlite-core/session.ts:325
export type Result<TKind extends "sync" | "async", TResult> = { sync: TResult; async: Promise<TResult>; }[TKind];
```

- **sync アダプター**: better-sqlite3, bun-sqlite, expo-sqlite（`SQLiteSession<'sync', RunResult, ...>`）
- **async アダプター**: d1, libsql, sql-js, op-sqlite, durable-sqlite（`SQLiteSession<'async', D1Result, ...>`）

この条件付き型マッピングにより、sync ドライバは `Promise` を返さず、async ドライバは `Promise` を返す -- という API の差異を単一の型パラメータで制御している。

### トランザクション実装の 4 つの戦略

アダプター群のトランザクション実装を比較すると、4 つの戦略が浮かび上がる。

**1. Pool からコネクション取得 + 手動 BEGIN/COMMIT/ROLLBACK**（node-postgres, neon-serverless, mysql2）:

```typescript
// node-postgres/session.ts:248-268
override async transaction<T>(...): Promise<T> {
    const session = isPool
        ? new NodePgSession(await (<pg.Pool> this.client).connect(), ...)
        : this;
    const tx = new NodePgTransaction(this.dialect, session, this.schema);
    await tx.execute(sql`begin ...`);
    try {
        const result = await transaction(tx);
        await tx.execute(sql`commit`);
        return result;
    } catch (error) {
        await tx.execute(sql`rollback`);
        throw error;
    } finally {
        if (isPool) (session.client as PoolClient).release();
    }
}
```

**2. ドライバのネイティブトランザクション API に委譲**（postgres-js, pglite, better-sqlite3, libsql）:

```typescript
// postgres-js/session.ts:167-184
override transaction<T>(...): Promise<T> {
    return this.client.begin(async (client) => {
        const session = new PostgresJsSession(client, ...);
        const tx = new PostgresJsTransaction(this.dialect, session, ...);
        return transaction(tx);
    });
}
```

**3. セッションレベルで手動 SQL 発行**（d1, expo-sqlite）:

```typescript
// d1/session.ts:111-125
override async transaction<T>(...): Promise<T> {
    const tx = new D1Transaction('async', this.dialect, this, this.schema);
    await this.run(sql.raw(`begin ...`));
    try {
        const result = await transaction(tx);
        await this.run(sql`commit`);
        return result;
    } catch (err) {
        await this.run(sql`rollback`);
        throw err;
    }
}
```

**4. 未サポート例外**（neon-http, xata-http, pg-proxy, mysql-proxy）:

```typescript
// neon-http/session.ts:248-254
override async transaction<T>(...): Promise<T> {
    throw new Error('No transactions support in neon-http driver');
}
```

### ネストトランザクション (Savepoint) の統一パターン

ネストトランザクションの実装は全アダプターで同一のパターンを踏襲する。

```typescript
// node-postgres/session.ts:284-301
override async transaction<T>(...): Promise<T> {
    const savepointName = `sp${this.nestedIndex + 1}`;
    const tx = new NodePgTransaction(this.dialect, this.session, this.schema, this.nestedIndex + 1);
    await tx.execute(sql.raw(`savepoint ${savepointName}`));
    try {
        const result = await transaction(tx);
        await tx.execute(sql.raw(`release savepoint ${savepointName}`));
        return result;
    } catch (err) {
        await tx.execute(sql.raw(`rollback to savepoint ${savepointName}`));
        throw err;
    }
}
```

`nestedIndex` をインクリメントしてセーブポイント名を生成する方式が、PG/MySQL/SQLite の全アダプターで一貫している。

### entityKind による instanceof 代替

全アダプタークラスに `static readonly [entityKind]: string` が定義され、`is()` 関数がプロトタイプチェーンを走査してクラス同一性を判定する。

```typescript
// entity.ts:1
export const entityKind = Symbol.for("drizzle:entityKind");

// entity.ts:12-42
export function is<T>(value: any, type: T): value is InstanceType<T> {
  if (value instanceof type) return true;
  let cls = Object.getPrototypeOf(value).constructor;
  while (cls) {
    if (entityKind in cls && cls[entityKind] === type[entityKind]) return true;
    cls = Object.getPrototypeOf(cls);
  }
  return false;
}
```

これにより、異なるバンドラーやモジュールシステムで `instanceof` が失敗するケースでもクラス判定が安定動作する。

## パターンカタログ

- **Template Method** (分類: 振る舞い)
  - 解決する問題: 20+ アダプターが共通のクエリ実行フローを持ちつつ、ドライバ固有部分だけ差し替えたい
  - 適用条件: アルゴリズムの骨格が共通で、ステップの詳細だけ異なる場合
  - コード例: `pg-core/session.ts:190-207`（`PgSession.execute` が `prepareQuery` を呼び、具象クラスが `prepareQuery` を実装）
  - 注意点: abstract メソッドが増えすぎると契約が重くなる。drizzle-orm は `prepareQuery` + `transaction` の 2 つに絞っている

- **Null Object** (分類: 振る舞い)
  - 解決する問題: Logger, Cache, Tracer がオプショナルだが、利用側で毎回 null チェックを書きたくない
  - 適用条件: オプショナルな依存が多く、条件分岐を減らしたい場合
  - コード例: `logger.ts:41-47`（`NoopLogger`）, `cache/core/cache.ts:44-65`（`NoopCache`）
  - 注意点: Null Object を作りすぎると、何が有効で何が無効か追跡しにくくなる

- **Abstract Factory / Factory Method** (分類: 生成)
  - 解決する問題: 各ドライバの `drizzle()` エントリポイントが Dialect + Session + Database を組み立てる
  - 適用条件: 生成するオブジェクト群が方言ごとにセットで決まる場合
  - コード例: `node-postgres/driver.ts:49-89`（`construct` 関数）, `d1/driver.ts:39-78`
  - 注意点: ファクトリ関数のオーバーロードが複雑化しやすい（`drizzle(string)` vs `drizzle(client)` vs `drizzle(config)`）

- **HKT エンコーディング** (分類: 型レベルパターン)
  - 解決する問題: TypeScript に Higher-Kinded Types がないが、ジェネリクスの「型コンストラクタ」を渡したい
  - 適用条件: 型パラメータを「後から」適用して具体型を得たい場合
  - コード例: `pg-core/session.ts:284-292`（`PgQueryResultHKT` + `PgQueryResultKind`）
  - 注意点: `$brand` フィールドと `Assume` を組み合わせるため可読性は低い。型の理解にはこのパターンの前提知識が必要

## Good Patterns

- **最小契約の abstract メソッド + デフォルト実装**: `PgSession` は `prepareQuery` と `transaction` のみを abstract にし、`execute`, `all`, `count` はデフォルト実装を提供する。新しいアダプター追加時に実装すべき範囲が最小限に抑えられ、かつコンパイラが漏れを検出する。

```typescript
// pg-core/session.ts:177-188, 190-207
abstract prepareQuery<T>(...): PgPreparedQuery<T>;  // アダプターが実装
execute<T>(query: SQL): Promise<T> {                  // デフォルト実装
    return this.prepareQuery(...).execute();
}
```

- **コンストラクタパラメータの統一**: 全アダプターの Session が `(client, dialect, schema, options)` の 4 引数パターンに従い、options には `logger` と `cache` を持つ。これにより「新しいアダプターを追加する」ときのテンプレートが事実上固定され、コードレビューで逸脱を即発見できる。

```typescript
// d1/session.ts:39-48, better-sqlite3/session.ts:37-46, mysql2/session.ts:214-224
// すべて同一構造
constructor(
    private client: <DriverClient>,
    dialect: <DialectType>,
    private schema: RelationalSchemaConfig<TSchema> | undefined,
    private options: <AdapterSessionOptions> = {},
) {
    super(dialect);
    this.logger = options.logger ?? new NoopLogger();
    this.cache = options.cache ?? new NoopCache();
}
```

- **entityKind による堅牢な型判定**: `Symbol.for` でグローバルシンボルを使い、プロトタイプチェーン走査で `instanceof` の問題（異なるモジュールバージョン、バンドラーの重複など）を回避する。

```typescript
// entity.ts:1, 29-38
export const entityKind = Symbol.for('drizzle:entityKind');
// 各アダプタークラスで:
static override readonly [entityKind]: string = 'NodePgPreparedQuery';
```

## Anti-Patterns / 注意点

- **未サポート操作の実行時例外**: `neon-http`, `xata-http`, `pg-proxy` 等の HTTP 系アダプターは `transaction()` を `throw new Error(...)` で実装する。これはインターフェースの契約違反を実行時まで遅延させる。

```typescript
// Bad: neon-http/session.ts:248-254
override async transaction<T>(...): Promise<T> {
    throw new Error('No transactions support in neon-http driver');
}
```

```typescript
// Better: 型レベルで transaction を持たない型を区別する
type HttpDriver = Omit<PgSession, "transaction">;
// または、capability フラグでコンパイル時に検出
interface DriverCapabilities {
  supportsTransactions: boolean;
}
```

- **PreparedQuery のコンストラクタ引数の膨張**: `NodePgPreparedQuery` は 11 個、`MySql2PreparedQuery` は 11 個のコンストラクタ引数を取る。位置引数の順序ミスが起きやすい。

```typescript
// Bad: node-postgres/session.ts:27-41 — 11 個の位置引数
constructor(
    private client, private queryString, private params, private logger,
    cache, queryMetadata, cacheConfig, private fields, name,
    private _isResponseInArrayMode, private customResultMapper?,
) { ... }
```

```typescript
// Better: オブジェクト引数にまとめる
interface PreparedQueryInit {
    client: NodePgClient;
    query: { sql: string; params: unknown[] };
    logger: Logger;
    cache: Cache;
    // ...
}
constructor(init: PreparedQueryInit) { ... }
```

## 導出ルール

- `[MUST]` 多数のバックエンド実装を束ねるアダプター層では、各アダプターが実装すべき最小契約を abstract メソッドで定義し、共通フローはデフォルト実装を持つ基底クラスに置く（Template Method パターン）
  - 根拠: drizzle-orm は `prepareQuery` + `transaction` の 2 メソッドのみ abstract とし、20+ アダプターが `execute`/`all`/`count` のデフォルト実装を再利用している（`pg-core/session.ts:190-228`）

- `[MUST]` オプショナルな横断的関心事（ロギング、キャッシュ、トレーシング等）は Null Object パターンでデフォルト無効にし、利用側コードから条件分岐を排除する
  - 根拠: 全アダプターが `this.logger = options.logger ?? new NoopLogger()` / `this.cache = options.cache ?? new NoopCache()` で初期化し、PreparedQuery 内では null チェックなしに `this.logger.logQuery()` を呼ぶ（`logger.ts:41-47`, 各 session.ts のコンストラクタ）

- `[SHOULD]` アダプター（ドライバラッパー）のコンストラクタシグネチャを全実装で統一し、新規追加時のテンプレートを固定する
  - 根拠: 全 Session が `(client, dialect, schema, options)` の 4 引数パターンを踏襲しており、新規アダプター追加の学習コストが最小化されている

- `[SHOULD]` TypeScript で複数バックエンドが異なる結果型を返す場合、HKT エンコーディング（ブランド付きインターフェース + 条件付き型マッピング）で型安全に差異を吸収する
  - 根拠: `PgQueryResultHKT` を各アダプターが拡張し、`PgQueryResultKind<TKind, TRow>` で具体型を導出する仕組みにより、クエリビルダーがドライバ固有の結果型を知らずに型安全に動作する（`pg-core/session.ts:284-292`）

- `[SHOULD]` 同期/非同期の差異を型パラメータと条件付き型マッピングで吸収し、ランタイム分岐を最小化する
  - 根拠: SQLite アダプター群は `Result<'sync' | 'async', T>` 型で sync は `T`、async は `Promise<T>` を返す設計にし、方言コアの実装を共有している（`sqlite-core/session.ts:325`）

- `[AVOID]` インターフェースが定義する操作をサポートしないアダプターで、実行時例外を投げる実装にする -- 型レベルで capability を表現するか、ドキュメントで明確に制限を示す方が望ましい
  - 根拠: `neon-http`, `xata-http`, `pg-proxy` 等 5 つのアダプターが `transaction()` で `throw new Error(...)` を返し、コンパイル時には検出できない（`neon-http/session.ts:253`）

- `[AVOID]` アダプタークラスのコンストラクタに 8 個以上の位置引数を並べる -- オブジェクト引数にまとめて順序ミスを防ぐ
  - 根拠: `NodePgPreparedQuery` は 11 個の位置引数を取り、cache/queryMetadata/cacheConfig の順序が入れ替わりやすい構造になっている（`node-postgres/session.ts:27-41`）

## 適用チェックリスト

- [ ] 複数バックエンドをサポートするライブラリで、各アダプターが実装すべき最小契約を abstract メソッドで定義しているか
- [ ] 共通フロー（クエリ実行、ログ出力、キャッシュ確認）が基底クラスのデフォルト実装に集約されているか
- [ ] オプショナル機能（Logger, Cache, Tracer 等）が Null Object パターンで実装され、利用側に条件分岐がないか
- [ ] 各アダプターのコンストラクタシグネチャが統一されており、新規追加時に既存アダプターをテンプレートとしてコピーできるか
- [ ] バックエンドごとに異なる結果型を、型レベルの仕組み（HKT, 条件付き型等）で吸収しているか
- [ ] サポートしない操作がコンパイル時に検出できるか（実行時例外に頼っていないか）
- [ ] アダプタークラスのコンストラクタ引数が多すぎないか（8 個以上ならオブジェクト引数を検討）
