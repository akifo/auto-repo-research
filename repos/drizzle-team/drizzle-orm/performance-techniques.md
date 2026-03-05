# performance-techniques

> リポジトリ: drizzle-team/drizzle-orm
> 分析日: 2026-03-04

## 概要

drizzle-orm のパフォーマンス最適化を Prepared Statements、バッチ操作、キャッシュレイヤー、トレーシング、遅延実行の5つの軸で横断分析した。ORM としての抽象化を維持しつつ、ゼロコスト・オプトイン原則でパフォーマンス機能を提供する設計が特徴的である。特にキャッシュレイヤーは全方言で共通の `queryWithCache` メソッドを持ちながら、ストラテジーパターンでバックエンド実装を差し替え可能にしている。

## 背景にある原則

- **ゼロコスト抽象の原則**: パフォーマンス機能は使わなければコストゼロであるべき。Logger・Cache・Tracing はすべて Noop 実装がデフォルトで、機能を有効にしない限り呼び出しオーバーヘッドが最小限に抑えられている。根拠: 全ドライバセッションで `options.cache ?? new NoopCache()` と `options.logger ?? new NoopLogger()` がフォールバック（`node-postgres/session.ts:217-218`、`mysql2/session.ts:221-223` 等）。

- **同一インターフェースによる方言横断**: Pg/MySQL/SQLite 間で PreparedQuery の抽象クラスと `queryWithCache` メソッドを共有し、キャッシュロジックの重複を排除している。各方言の PreparedQuery 基底クラス（`pg-core/session.ts:64-147`、`mysql-core/session.ts:70-154`、`sqlite-core/session.ts:71-155`）が完全に同一の `queryWithCache` ロジックを持つ。

- **クエリ構築と実行の分離**: クエリビルダーの `.prepare()` でクエリを確定し、`.execute()` で実行する2フェーズ設計。これにより DB 側の prepared statement 再利用（PostgreSQL の named prepared statement 等）と、バッチ投入の両方に対応できる。根拠: `pg-core/query-builders/select.ts:1078-1108` で `_prepare()` がクエリを確定し、`execute` が `_prepare().execute()` を呼ぶ構造。

- **副作用の並列化**: キャッシュ無効化とクエリ実行を `Promise.all` で並列に行い、レイテンシの増加を最小化する。根拠: `pg-core/session.ts:94-98` で mutation 時にクエリ実行とキャッシュ無効化を同時に発火。

## 実例と分析

### Prepared Statements の階層的な抽象化

drizzle-orm は PreparedQuery を3層で構成している。

1. **インターフェース層** (`session.ts:3-8`): `getQuery()`、`mapResult()`、`isResponseInArrayMode()` の最小契約
2. **方言基底クラス層** (`pg-core/session.ts:20-160`、`mysql-core/session.ts:47-162`、`sqlite-core/session.ts:42-204`): キャッシュ統合・クエリメタデータ管理
3. **ドライバ実装層** (`node-postgres/session.ts:21-194`、`mysql2/session.ts:45-196` 等): 実際のクライアント呼び出し

PostgreSQL の node-postgres ドライバでは `name` パラメータを `QueryConfig` に渡すことで、DB サーバー側の named prepared statement を活用する:

```typescript
// node-postgres/session.ts:44-46
this.rawQueryConfig = {
    name,
    text: queryString,
```

ユーザーコードでは `prepare('queryName')` を呼ぶだけでこの最適化が有効になる:

```typescript
// pg-core/query-builders/select.ts:1107-1109
prepare(name: string): PgSelectPrepare<this> {
    return this._prepare(name);
}
```

### バッチ操作の設計

バッチ機能はドライバごとに異なる戦略を取る。共通しているのは「クエリを先にすべて prepare し、ドライバの一括実行 API に投入し、結果を各 PreparedQuery の `mapResult` で変換する」という3段階パイプラインである。

LibSQL では `client.batch()` に複数の `InStatement` を一括送信:

```typescript
// libsql/session.ts:77-90
async batch<T extends BatchItem<'sqlite'>[] | readonly BatchItem<'sqlite'>[]>(queries: T) {
    const preparedQueries: PreparedQuery[] = [];
    const builtQueries: InStatement[] = [];

    for (const query of queries) {
        const preparedQuery = query._prepare();
        const builtQuery = preparedQuery.getQuery();
        preparedQueries.push(preparedQuery);
        builtQueries.push({ sql: builtQuery.sql, args: builtQuery.params as InArgs });
    }

    const batchResults = await this.client.batch(builtQueries);
    return batchResults.map((result, i) => preparedQueries[i]!.mapResult(result, true));
}
```

Neon HTTP では HTTP バッチを `client.transaction()` で実行:

```typescript
// neon-http/session.ts:199-219
async batch<U extends BatchItem<'pg'>, T extends Readonly<[U, ...U[]]>>(queries: T) {
    const preparedQueries: PreparedQuery[] = [];
    const builtQueries: NeonQueryPromise<any, true>[] = [];
    for (const query of queries) {
        const preparedQuery = query._prepare();
        const builtQuery = preparedQuery.getQuery();
        preparedQueries.push(preparedQuery);
        builtQueries.push(
            this.clientQuery(builtQuery.sql, builtQuery.params, {
                fullResults: true,
                arrayMode: preparedQuery.isResponseInArrayMode(),
            }),
        );
    }
    const batchResults = await this.client.transaction(builtQueries, queryConfig);
    return batchResults.map((result, i) => preparedQueries[i]!.mapResult(result, true)) as any;
}
```

`mapResult` の `isFromBatch` フラグにより、通常実行とバッチ実行で異なる結果マッピングを行える:

```typescript
// libsql/session.ts:219-222
override mapAllResult(rows: unknown, isFromBatch?: boolean): unknown {
    if (isFromBatch) {
        rows = (rows as ResultSet).rows;
    }
```

### キャッシュレイヤーの設計

キャッシュは `Cache` 抽象クラス（`cache/core/cache.ts:5-42`）を通じて提供され、`strategy()` が `'explicit'` か `'all'` かでグローバル有効/クエリ単位有効を制御する。

クエリハッシュには SHA-256 を使用し、SQL 文字列とパラメータの組み合わせをキーにする:

```typescript
// cache/core/cache.ts:69-78
export async function hashQuery(sql: string, params?: any[]) {
    const dataToHash = `${sql}-${JSON.stringify(params)}`;
    const encoder = new TextEncoder();
    const data = encoder.encode(dataToHash);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = [...new Uint8Array(hashBuffer)];
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
}
```

Upstash 実装（`cache/upstash/cache.ts`）は Redis パイプラインと Lua スクリプトを活用し、複数の Redis コマンドを単一ラウンドトリップで処理する:

```typescript
// cache/upstash/cache.ts:158-188
const pipeline = this.redis.pipeline();
pipeline.hset(compositeKey, { [key]: response });
pipeline.hexpire(compositeKey, key, ttlSeconds, hexOptions);
if (isTag) {
    pipeline.hset(UpstashCache.tagsMapKey, { [key]: compositeKey });
    pipeline.hexpire(UpstashCache.tagsMapKey, key, ttlSeconds, hexOptions);
}
for (const table of tables) {
    pipeline.sadd(this.addTablePrefix(table), compositeKey);
}
await pipeline.exec();
```

キャッシュ無効化は Lua スクリプトでアトミックに実行し、テーブル単位の一括削除を1回の `EVAL` で完了させる:

```lua
-- cache/upstash/cache.ts:21-53
local compositeTableNames = redis.call('SUNION', unpack(tables))
for _, compositeTableName in ipairs(compositeTableNames) do
    keysToDelete[#keysToDelete + 1] = compositeTableName
end
redis.call('DEL', unpack(keysToDelete))
```

### トレーシングの条件付き計装

OpenTelemetry 統合はオプショナル依存として設計されている。`otel` モジュールが存在しなければ、tracer の `startActiveSpan` は計装なしで直接コールバックを実行する:

```typescript
// tracing.ts:25-28
startActiveSpan<F extends (span?: Span) => unknown>(name: SpanName, fn: F): ReturnType<F> {
    if (!otel) {
        return fn() as ReturnType<F>;
    }
```

`iife` ヘルパー（`tracing-utils.ts:1-3`）は、クロージャによる変数キャプチャを明示的な引数渡しに変換し、V8 のインライン展開を促進する:

```typescript
// tracing-utils.ts:1-3
export function iife<T extends unknown[], U>(fn: (...args: T) => U, ...args: T): U {
    return fn(...args);
}
```

### QueryPromise による遅延実行

`QueryPromise` クラス（`query-promise.ts`）は Promise インターフェースを実装しつつ、`then()` が呼ばれるまでクエリを実行しない遅延パターンを実現する:

```typescript
// query-promise.ts:27-32
then<TResult1 = T, TResult2 = never>(
    onFulfilled?: ...,
    onRejected?: ...,
): Promise<TResult1 | TResult2> {
    return this.execute().then(onFulfilled, onRejected);
}
```

これにより `await` されるまでクエリは発行されず、チェーンメソッドで条件分岐やキャッシュ設定を追加できる。

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: キャッシュバックエンドの差し替え（Redis、インメモリ、Noop）
  - 適用条件: オプショナルな横断的関心事を複数の実装で切り替えたいとき
  - コード例: `cache/core/cache.ts:5-42`（Cache 抽象クラス）、`cache/upstash/cache.ts:60-202`（UpstashCache 実装）
  - 注意点: `strategy()` メソッドで `'explicit'`/`'all'` を返す設計は、設定の責務がキャッシュ実装側にある

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: 方言ごとに異なるクエリ実行を共通のキャッシュ・トレーシングフローに統合
  - 適用条件: アルゴリズムの骨格は共通だが、個々のステップがサブクラスで異なるとき
  - コード例: `pg-core/session.ts:64-147`（`queryWithCache` が骨格、`execute` をサブクラスが実装）
  - 注意点: `queryWithCache` が Pg/MySQL/SQLite の3箇所に重複している（DRY 違反だが、型制約の都合上やむを得ない）

- **Null Object パターン** (分類: 振る舞い)
  - 解決する問題: Logger/Cache 未設定時の null チェック排除
  - 適用条件: オプショナルな依存をデフォルトで無効化しつつ、呼び出し側の条件分岐を避けたいとき
  - コード例: `logger.ts:41-47`（NoopLogger）、`cache/core/cache.ts:44-65`（NoopCache）

## Good Patterns

- **Prepare-Execute 2フェーズ分離**: クエリオブジェクトの構築と実行を分離し、再利用可能な prepared statement を作成する。DB 側でクエリプランをキャッシュでき、同一クエリの繰り返し実行でパース・プランニングコストを削減する。

```typescript
// pg-core/query-builders/select.ts:1107-1109
prepare(name: string): PgSelectPrepare<this> {
    return this._prepare(name);
}
// 利用例: const prepared = db.select().from(users).where(eq(users.id, sql.placeholder('id'))).prepare('getUser');
// await prepared.execute({ id: 1 });
```

- **バッチの prepare-collect-execute-map パイプライン**: 複数のクエリを先にすべて prepare し、ドライバの一括送信 API で実行し、結果を各 PreparedQuery の `mapResult` で型安全に変換する。ネットワークラウンドトリップを1回に削減する。

```typescript
// libsql/session.ts:77-90
for (const query of queries) {
    const preparedQuery = query._prepare();
    preparedQueries.push(preparedQuery);
    builtQueries.push({ sql: builtQuery.sql, args: builtQuery.params as InArgs });
}
const batchResults = await this.client.batch(builtQueries);
return batchResults.map((result, i) => preparedQueries[i]!.mapResult(result, true));
```

- **Redis パイプライン + Lua スクリプトによるアトミック操作**: キャッシュの読み書きを Redis パイプラインでバッチ化し、無効化を Lua スクリプトでアトミックに実行。複数の Redis ラウンドトリップを回避しつつ、一貫性を保つ。

```typescript
// cache/upstash/cache.ts:158-188
const pipeline = this.redis.pipeline();
pipeline.hset(compositeKey, { [key]: response });
pipeline.hexpire(compositeKey, key, ttlSeconds, hexOptions);
// ... 複数コマンドを蓄積
await pipeline.exec(); // 1回のラウンドトリップ
```

- **テーブルベース自動キャッシュ無効化**: クエリビルダーが参加テーブルを `usedTables` として自動追跡し、mutation 時に関連キャッシュを自動無効化する。手動の無効化キー管理が不要になる。

```typescript
// pg-core/query-builders/select.ts:221,246
for (const item of extractUsedTable(table)) this.usedTables.add(item);
// pg-core/session.ts:86-102
// mutation 時に usedTables を使ってキャッシュ無効化
```

## Anti-Patterns / 注意点

- **queryWithCache の方言間コピー**: `queryWithCache` メソッドが `PgPreparedQuery`、`MySqlPreparedQuery`、`SQLitePreparedQuery` の3箇所にほぼ同一のコードで存在する。型制約の違いが原因だが、ロジック変更時に3箇所の同期が必要になる。

Bad:
```typescript
// pg-core/session.ts:64-147, mysql-core/session.ts:70-154, sqlite-core/session.ts:71-155
// 3つの基底クラスに同一の queryWithCache 実装
protected async queryWithCache<T>(queryString: string, params: any[], query: () => Promise<T>): Promise<T> {
    // ... 80行の同一ロジック x 3箇所
}
```

Better: 共通ロジックを standalone 関数またはミックスインに抽出し、方言基底クラスから委譲する:
```typescript
// shared/cache-executor.ts
export async function executeWithCache<T>(
    cache: Cache | undefined,
    queryMetadata: QueryMetadata | undefined,
    cacheConfig: WithCacheConfig | undefined,
    queryString: string, params: any[],
    query: () => Promise<T>,
): Promise<T> { /* 共通ロジック */ }
```

- **hashQuery の二重呼び出しリスク**: `queryWithCache` 内でキャッシュミス時に `hashQuery` を2回呼び出す可能性がある（`get` と `put` の両方で `await hashQuery(queryString, params)` を実行）。SHA-256 ハッシュ計算は暗号的に重い操作。

Bad:
```typescript
// pg-core/session.ts:114-135
const fromCache = await this.cache.get(
    this.cacheConfig.tag ?? await hashQuery(queryString, params), // 1回目
    ...
);
if (fromCache === undefined) {
    result = await query();
    await this.cache.put(
        this.cacheConfig.tag ?? await hashQuery(queryString, params), // 2回目
        ...
    );
}
```

Better: ハッシュ値を事前計算して変数に保持する:
```typescript
const cacheKey = this.cacheConfig.tag ?? await hashQuery(queryString, params);
const fromCache = await this.cache.get(cacheKey, ...);
if (fromCache === undefined) {
    result = await query();
    await this.cache.put(cacheKey, ...);
}
```

## 導出ルール

- `[MUST]` キャッシュレイヤーを追加する場合、Null Object パターン（NoopCache）をデフォルトにし、キャッシュ未設定時の分岐コストをゼロにする
  - 根拠: drizzle-orm の全ドライバセッションで `options.cache ?? new NoopCache()` がデフォルトであり、キャッシュ無効時も `queryWithCache` 内で `is(this.cache, NoopCache)` の早期 return により追加オーバーヘッドが最小（`pg-core/session.ts:69-75`）

- `[MUST]` mutation 操作時のキャッシュ無効化はクエリ実行と並列に行い、レイテンシの直列加算を避ける
  - 根拠: `pg-core/session.ts:94-98` で `Promise.all([query(), this.cache.onMutate(...)])` により、DB クエリとキャッシュ無効化を同時に発火している

- `[SHOULD]` 繰り返し実行するクエリは prepare/execute の2フェーズに分離し、DB 側のクエリプラン再利用を有効にする
  - 根拠: `pg-core/query-builders/select.ts:1100-1109` で `prepare(name)` がクエリを確定し、PostgreSQL の named prepared statement としてサーバー側にキャッシュされる

- `[SHOULD]` 複数の独立したクエリをまとめて実行する場合は、ドライバのバッチ/パイプライン API を活用してネットワークラウンドトリップを1回に削減する
  - 根拠: `libsql/session.ts:77-90`、`neon-http/session.ts:199-219`、`d1/session.ts:77-97` のすべてで prepare-collect-execute-map パイプラインが採用されている

- `[SHOULD]` キャッシュキーの生成に暗号ハッシュを使う場合は結果を変数に保持し、同一リクエスト内の二重計算を避ける
  - 根拠: `pg-core/session.ts:114-135` で `hashQuery` が get/put の両方で呼ばれており、改善の余地がある

- `[SHOULD]` オプショナルな計装（トレーシング・ロギング）はモジュール存在チェック + 即時フォールバックで実装し、未使用時のランタイムコストをなくす
  - 根拠: `tracing.ts:25-28` で `if (!otel) { return fn() }` によりゼロコストフォールバックを実現

- `[AVOID]` Redis キャッシュ操作で個々のコマンドを逐次 `await` する設計。パイプラインまたは Lua スクリプトで一括送信し、ラウンドトリップを最小化する
  - 根拠: `cache/upstash/cache.ts:158-188` で Redis パイプラインを使い、複数のHSET/HEXPIRE/SADD を1回のラウンドトリップに集約

## 適用チェックリスト

- [ ] ORM やデータアクセス層にキャッシュを追加する場合、NoopCache をデフォルトにしてキャッシュ未使用時のコストをゼロにしているか
- [ ] 繰り返し実行する同一クエリに対して prepared statement を使用しているか（DB 側のプランキャッシュを活用）
- [ ] 複数の独立クエリを発行する箇所でバッチ API を使い、ラウンドトリップを削減しているか
- [ ] キャッシュ無効化を DB クエリ実行と並列に行い、レイテンシの直列加算を回避しているか
- [ ] Redis 操作でパイプラインまたは Lua スクリプトを使い、複数コマンドを1回のラウンドトリップで処理しているか
- [ ] 暗号ハッシュ（SHA-256 等）のキャッシュキー生成結果を変数に保持し、同一リクエスト内の二重計算を避けているか
- [ ] トレーシング・ロギング等のオプショナルな計装が、未使用時にゼロコストで動作するか（Null Object パターンまたは存在チェック）
- [ ] クエリの構築（ビルダー）と実行（ランタイム）を分離し、遅延実行が可能な設計になっているか
