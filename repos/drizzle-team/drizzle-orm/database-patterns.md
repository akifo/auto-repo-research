# database-patterns

> リポジトリ: drizzle-team/drizzle-orm
> 分析日: 2026-03-04

## 概要

Drizzle ORM のスキーマ定義 API、クエリビルダ、コネクション/セッション管理の設計パターンを分析する。
Drizzle は「TypeScript ファースト」を掲げ、スキーマ定義自体が型情報のソースになる設計を採用している。
テーブル定義からクエリ結果の型が自動推論される仕組み、Builder パターンによるメソッドチェーン API、
Session/Transaction の抽象化階層、そしてキャッシュレイヤーの挿入設計は、データベースライブラリに限らず
型安全なAPIを構築する際に広く応用できるプラクティスを多数含む。

## 背景にある原則

- **スキーマ定義 = 型の単一ソース（Single Source of Truth）**: テーブル定義のオブジェクトリテラルから `InferSelectModel`/`InferInsertModel` を型レベルで導出し、スキーマと型定義の二重管理を排除する。`declare readonly _:` パターンで型情報をランタイムコストなしに保持する（`table.ts:52-60`, `column.ts:70`）。

- **Dialect 間の共通抽象を最大化し、差分だけをオーバーライドする**: `Table` → `PgTable`、`Column` → `PgColumn` → `PgInteger` のように、共通基盤クラスを設け、各 dialect はそれを継承して `getSQLType()` 等の差分だけを実装する。これにより pg/mysql/sqlite/singlestore 間でクエリビルダ・リレーション・キャッシュのコードが共有される。

- **コネクションの詳細を Session 層で隠蔽する**: `PgSession` が `prepareQuery` を抽象メソッドとして定義し、各ドライバ固有の実装（`NodePgSession`, `NeonSession` 等）がそれを実装する。`PgDatabase` は Session だけに依存し、ドライバの切り替えが Session 差し替えで完結する（`pg-core/session.ts:168-234`）。

- **型状態パターンでビルダーの不正な操作順序をコンパイル時に検出する**: `PgSelectWithout<this, TDynamic, 'offset'>` のように、使用済みメソッドを型パラメータで除外し、同じメソッドの二重呼び出しを型エラーにする。

## 実例と分析

### スキーマ定義のビルダーチェーン

テーブルカラムの定義は `ColumnBuilder` → `PgColumnBuilder` → 具体カラムビルダー（`PgIntegerBuilder` 等）の階層で構成される。各メソッドは `this` を返し、型レベルで属性を追加していく。

```typescript
// pg-core/columns/integer.ts:49-53
export function integer(): PgIntegerBuilderInitial<''>;
export function integer<TName extends string>(name: TName): PgIntegerBuilderInitial<TName>;
export function integer(name?: string) {
  return new PgIntegerBuilder(name ?? '');
}
```

`notNull()` を呼ぶと `NotNull<this>` 型が返り、`hasDefault` が追加されると `HasDefault<this>` 型になる。これにより insert 時に必須/オプショナルなフィールドが型レベルで自動決定される。

```typescript
// column-builder.ts:234-237
notNull(): NotNull<this> {
  this.config.notNull = true;
  return this as NotNull<this>;
}
```

### entityKind による instanceof 代替

Drizzle は `Symbol.for('drizzle:entityKind')` を全クラスに静的プロパティとして付与し、独自の `is()` 関数で型判定を行う。これは bundler によるクラスの複製や、異なるパッケージバージョンの混在時に `instanceof` が失敗する問題を回避する。

```typescript
// entity.ts:1-42
export const entityKind = Symbol.for('drizzle:entityKind');

export function is<T extends DrizzleEntityClass<any>>(value: any, type: T): value is InstanceType<T> {
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (value instanceof type) {
    return true;
  }
  // プロトタイプチェーンを辿って entityKind を比較
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

`Symbol.for()` はプロセス全体で同一シンボルを返すため、パッケージの重複インストール時にも正しく動作する。

### Session/Transaction の抽象化階層

Session は Dialect 共通の抽象クラスで定義され、各ドライバが具体実装を提供する。Transaction は `PgDatabase` を継承しており、トランザクション内でも `db.select()` と同じ API が使える。

```typescript
// pg-core/session.ts:236-282
export abstract class PgTransaction<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown> = Record<string, never>,
  TSchema extends TablesRelationalConfig = Record<string, never>,
> extends PgDatabase<TQueryResult, TFullSchema, TSchema> {
  // ...
  rollback(): never {
    throw new TransactionRollbackError();
  }
}
```

ネストされたトランザクションは `nestedIndex` を使って savepoint 名を生成する。

```typescript
// node-postgres/session.ts:284-301
override async transaction<T>(transaction: (tx: NodePgTransaction<TFullSchema, TSchema>) => Promise<T>): Promise<T> {
  const savepointName = `sp${this.nestedIndex + 1}`;
  const tx = new NodePgTransaction<TFullSchema, TSchema>(
    this.dialect, this.session, this.schema, this.nestedIndex + 1,
  );
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

### キャッシュレイヤーの設計

Cache は `strategy()` / `get()` / `put()` / `onMutate()` の4メソッドを持つ抽象クラスで定義される。デフォルトは `NoopCache` で、実装を差し込むとミューテーション時に自動無効化される。

```typescript
// cache/core/cache.ts:5-42
export abstract class Cache {
  abstract strategy(): 'explicit' | 'all';
  abstract get(key: string, tables: string[], isTag: boolean, isAutoInvalidate?: boolean): Promise<any[] | undefined>;
  abstract put(hashedQuery: string, response: any, tables: string[], isTag: boolean, config?: CacheConfig): Promise<void>;
  abstract onMutate(params: MutationOption): Promise<void>;
}
```

`PgPreparedQuery.queryWithCache()` が SELECT/INSERT/UPDATE/DELETE を判別し、SELECT ならキャッシュ参照、ミューテーションなら `onMutate()` を呼ぶ。クエリ単位で `$withCache()` を付与してキャッシュ制御できる。

### Read/Write スプリットの withReplicas パターン

`withReplicas()` は読み取り系メソッド（`select`, `selectDistinct`, `query`）をレプリカに、書き込み系メソッド（`insert`, `update`, `delete`, `transaction`）をプライマリにルーティングするプロキシを生成する。

```typescript
// pg-core/db.ts:660-668
const select: Q['select'] = (...args: []) => getReplica(replicas).select(...args);
const update: Q['update'] = (...args: [any]) => primary.update(...args);
const insert: Q['insert'] = (...args: [any]) => primary.insert(...args);
const transaction: Q['transaction'] = (...args: [any]) => primary.transaction(...args);
```

### QueryPromise: クエリビルダを直接 await 可能にする

`QueryPromise` が `Promise<T>` を `implements` し、`then()` 内で `execute()` を呼ぶことで、クエリビルダを直接 `await` できる。明示的に `.execute()` を呼ぶ必要がない。

```typescript
// query-promise.ts:3-35
export abstract class QueryPromise<T> implements Promise<T> {
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
  - 解決する問題: 多数のオプションを持つオブジェクト（カラム定義、クエリ）をメソッドチェーンで段階的に構築する
  - 適用条件: 構築過程の各ステップが型状態を変化させる必要がある場合
  - コード例: `column-builder.ts:185-317`（ColumnBuilder）、`pg-core/query-builders/select.ts:62-94`（PgSelectBuilder）
  - 注意点: 型パラメータが膨れやすい。Drizzle は最大8個の型パラメータを持つクエリビルダがある

- **Abstract Factory パターン** (分類: 生成)
  - 解決する問題: 複数の DB 方言（pg/mysql/sqlite）ごとに整合性のある Table/Column/Session の組を生成する
  - 適用条件: 関連オブジェクト群を方言ごとに切り替える必要がある場合
  - コード例: `pgTable`（`pg-core/table.ts:244`）、`PgSchema`（`pg-core/schema.ts:9-58`）
  - 注意点: ファクトリが返す型を `BuildColumn<TTableName, TBuilder, TDialect>` で dialect ごとに分岐させている

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: Session の共通フロー（prepare → execute → map）を基盤で定義し、ドライバ固有部分だけを差し替える
  - 適用条件: アルゴリズムの骨格は共通で、一部ステップが可変な場合
  - コード例: `PgSession.execute()`（`pg-core/session.ts:190-207`）が `prepareQuery()` を呼び、具体クラスが実装

- **Null Object パターン** (分類: 振る舞い)
  - 解決する問題: キャッシュやロガーが未設定時の null チェックを排除する
  - 適用条件: オプショナルな依存を注入する場面
  - コード例: `NoopCache`（`cache/core/cache.ts:44-65`）、`NoopLogger`
  - 注意点: `is(this.cache, NoopCache)` で NoopCache かどうかを判定し、キャッシュ処理全体をスキップする

## Good Patterns

- **`declare readonly _:` による型情報のゼロコスト保持**: `Table` や `Column` クラスで `declare` を使い、ランタイムに存在しない型専用プロパティを定義する。JavaScript の出力には含まれないため、メモリもバンドルサイズも増えない。`$inferSelect` / `$inferInsert` で外部から型を取り出せる。

```typescript
// table.ts:52-63
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

- **Symbol.for() による cross-package 安全な型判定**: `Symbol.for('drizzle:entityKind')` はグローバルレジストリからシンボルを取得するため、異なるバージョンのパッケージが共存しても同一シンボルとして扱われる。`instanceof` が失敗するケース（bundler の重複、monorepo のシンボリックリンク等）でも安全に動作する。

```typescript
// entity.ts:1
export const entityKind = Symbol.for('drizzle:entityKind');
// Table クラスでの使用: table.ts:50
static readonly [entityKind]: string = 'Table';
```

- **Transaction が Database を継承して同一 API を提供**: `PgTransaction extends PgDatabase` により、通常の DB 操作と全く同じメソッドがトランザクション内で使える。利用者はコールバック引数の `tx` を `db` と同じように扱うだけでよい。

```typescript
// pg-core/db.ts:636-641
transaction<T>(
  transaction: (tx: PgTransaction<TQueryResult, TFullSchema, TSchema>) => Promise<T>,
  config?: PgTransactionConfig,
): Promise<T> {
  return this.session.transaction(transaction, config);
}
```

## Anti-Patterns / 注意点

- **型パラメータの過剰な増殖**: Drizzle のクエリビルダは最大 8 個以上の型パラメータを持つ（`PgSelectBase` の `TTableName`, `TSelection`, `TSelectMode`, `TNullabilityMap`, `TDynamic`, `TExcludedMethods`, `TResult`, `TSelectedFields`）。型安全性は高いがコンパイル時間とエラーメッセージの可読性に影響する。

```typescript
// Bad: 型パラメータが8個以上
export class PgSelectBase<
  TTableName, TSelection, TSelectMode, TNullabilityMap,
  TDynamic, TExcludedMethods, TResult, TSelectedFields
> { ... }

// Better: 型パラメータを config 型にまとめる
interface SelectConfig { tableName: string; selection: unknown; mode: SelectMode; ... }
export class PgSelectBase<T extends SelectConfig> { ... }
```

実用上、Drizzle はこのトレードオフを「型安全性 > エラーメッセージの可読性」として許容している。自分のプロジェクトでは型パラメータ 4 個を目安に config 型への集約を検討すべき。

- **ドライバ固有の型パーサー上書きの重複**: `NodePgPreparedQuery` のコンストラクタで `getTypeParser` のカスタマイズが `rawQueryConfig` と `queryConfig` で完全に重複している（`node-postgres/session.ts:47-131`）。抽出すべき共通ロジック。

## 導出ルール

- `[MUST]` データベーススキーマ定義を型の単一ソースにする場合、テーブル定義オブジェクトから select/insert 型を条件付き型で導出し、手動の型定義との二重管理を排除する
  - 根拠: Drizzle は `InferSelectModel` / `InferInsertModel` を `Table['_']['columns']` から導出し、スキーマ変更が自動的に型に反映される（`table.ts:155-205`）

- `[MUST]` トランザクション API は通常のデータベース操作と同じインターフェースを提供し、利用側のコードがトランザクション内外で変わらないようにする
  - 根拠: `PgTransaction extends PgDatabase` により、`db.select()` と `tx.select()` が同一シグネチャであり、ビジネスロジックの関数を `db | tx` のどちらでも呼べる（`pg-core/session.ts:236-240`）

- `[SHOULD]` ライブラリの型判定に `instanceof` ではなく `Symbol.for()` ベースの判定を使い、パッケージ重複時の判定失敗を防ぐ
  - 根拠: Drizzle は `entityKind` シンボルとプロトタイプチェーン走査で、bundler の tree-shaking やモノレポでのバージョン不整合に耐える型判定を実現している（`entity.ts:12-42`）

- `[SHOULD]` オプショナルな依存（キャッシュ、ロガー等）には Null Object パターンを適用し、利用側での null チェックを排除する
  - 根拠: `NoopCache` と `NoopLogger` により、キャッシュ/ロガー未設定時も `if (cache !== null)` の分岐が不要になり、メインの実行パスがシンプルになる（`cache/core/cache.ts:44-65`）

- `[SHOULD]` ビルダーパターンのメソッドチェーンで型状態を変化させ、不正な操作順序（同一メソッドの二重呼び出し等）をコンパイル時に検出する
  - 根拠: `PgSelectWithout<this, TDynamic, 'offset'>` が使用済みメソッドを型レベルで除外し、`.offset().offset()` を型エラーにする

- `[SHOULD]` DB ドライバの抽象化は Session 層で行い、Database クラスはドライバに一切依存しない設計にする
  - 根拠: `PgDatabase` は `PgSession` のみに依存し、`node-postgres`, `neon`, `pglite` 等のドライバ切り替えが Session クラスの差し替えだけで完結する（`pg-core/db.ts:56-91`、37 種類のドライバが同一パターンで実装）

- `[AVOID]` ビルダーの型パラメータを 5 個以上に増やすこと。型パラメータが多すぎるとコンパイル時間が増加し、エラーメッセージが解読困難になる
  - 根拠: Drizzle の `PgSelectBase` は 8 個の型パラメータを持ち、TypeScript のエラーメッセージが数百文字になることがある。config 型への集約を検討すべき

## 適用チェックリスト

- [ ] スキーマ/テーブル定義から select/insert の型を自動導出しているか（手動の型定義と二重管理していないか）
- [ ] `declare` キーワードで型専用プロパティを定義し、ランタイムコストなしに型情報を保持しているか
- [ ] トランザクション API が通常の DB 操作と同じインターフェースを公開しているか
- [ ] ネストされたトランザクションを savepoint で実現しているか
- [ ] `instanceof` の代わりに `Symbol.for()` ベースの型判定を使っているか（ライブラリ提供側の場合）
- [ ] キャッシュ・ロガー等のオプショナル依存に Null Object パターンを適用しているか
- [ ] ドライバ固有の実装が Session 層に隔離されており、Database 層からドライバを直接参照していないか
- [ ] ビルダーパターンの型パラメータが膨れすぎていないか（4 個以下を目安）
- [ ] Read/Write スプリットが必要な場合、プロキシパターンで読み取り/書き込みのルーティングを分離しているか
