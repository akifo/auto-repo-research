# Pattern: Idempotent Schema Migration

> 出典: [repos/cloudflare/agents](../repos/cloudflare/agents/)
> カテゴリ: pattern

## 概要

`CREATE TABLE IF NOT EXISTS` と `ALTER TABLE ADD COLUMN` の duplicate エラー無視パターンを組み合わせた、外部マイグレーションツール不要の無停止スキーマ進化手法。サーバーレス環境や Durable Objects のように「どのバージョンのコードがインスタンスを起動するか」が不確定な状況で、既存データを破壊せずにスキーマをインクリメンタルに進化させる。

マイグレーションファイルの管理、バージョン追跡テーブル、ロールバック機構といった従来のマイグレーションツールの複雑さを排除し、コンストラクタの DDL 実行だけでスキーマの一貫性を保証する。

## 背景・文脈

Cloudflare Agents SDK（`cloudflare/agents`）は、Durable Objects 上にステートフルなエージェントを構築するフレームワークである。Durable Objects は WebSocket Hibernation により任意のタイミングで evict/wake-up され、新しいバージョンのコードでインスタンスが再生成される。このとき:

1. **バージョン不確定性**: デプロイ後、既存の DO インスタンスがいつ新コードで wake-up するかは制御できない。古いスキーマのデータベースに新しいコードがアクセスする状況が常に発生しうる。
2. **並行バージョン共存**: ローリングデプロイ中、旧バージョンと新バージョンのコードが同時に異なるインスタンスで動作する可能性がある。
3. **外部ツール不使用**: DO の SQLite は各インスタンスに閉じたローカルストレージであり、中央集権的なマイグレーションツール（Prisma Migrate, Drizzle Kit 等）を適用できない。

この制約下で、Agents SDK はコンストラクタでのべき等な DDL 実行という軽量なアプローチを採用している。

## 実装パターン

パターンは2つの要素で構成される。

### 1. テーブル作成: `CREATE TABLE IF NOT EXISTS`

コンストラクタで全テーブルを `IF NOT EXISTS` 付きで作成する。テーブルが既に存在する場合は何も起こらない。

```typescript
// packages/agents/src/index.ts:748-779 — コンストラクタ内のテーブル初期化
this.sql`
  CREATE TABLE IF NOT EXISTS cf_agents_state (
    id TEXT PRIMARY KEY NOT NULL,
    state TEXT
  )
`;

this.sql`
  CREATE TABLE IF NOT EXISTS cf_agents_schedules (
    id TEXT PRIMARY KEY NOT NULL,
    -- 初期カラム群
    callback TEXT NOT NULL,
    type TEXT NOT NULL,
    time INTEGER NOT NULL
  )
`;
```

### 2. カラム追加: `addColumnIfNotExists` パターン

テーブル作成後、後続バージョンで追加されたカラムを `ALTER TABLE ADD COLUMN` で追加する。`duplicate column` エラーのみを無視し、それ以外のエラーは再スローする。

```typescript
// packages/agents/src/index.ts:781-807 — addColumnIfNotExists パターン
// duplicate column エラーのみ無視するヘルパー
function addColumnIfNotExists(
  sql: TemplateLiteralFunction,
  table: string,
  column: string,
  definition: string,
): void {
  try {
    sql(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (e) {
    // "duplicate column name: <column>" エラーのみ安全に無視
    if (e instanceof Error && e.message.includes("duplicate column")) {
      return;
    }
    throw e; // 予期しないエラーは再スロー
  }
}

// 使用例: スケジュールテーブルへのカラム追加
addColumnIfNotExists(this.sql, "cf_agents_schedules", "running", "INTEGER DEFAULT 0");
addColumnIfNotExists(this.sql, "cf_agents_schedules", "execution_started_at", "INTEGER");
addColumnIfNotExists(this.sql, "cf_agents_schedules", "retry_options", "TEXT");
```

### 3. 全体の流れ

```
コンストラクタ実行
  |
  v
CREATE TABLE IF NOT EXISTS (テーブルが無ければ最新スキーマで作成)
  |
  v
addColumnIfNotExists x N (既存テーブルに不足カラムを追加)
  |
  v
通常のビジネスロジック開始
```

## Good Example

```typescript
// --- べき等スキーママイグレーション ---
// どのバージョンからアップグレードしても安全に動作する

class MyAgent extends Agent {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Step 1: テーブル作成（初回のみ実効）
    this.sql`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL
      )
    `;

    // Step 2: v2 で追加されたカラム（v1 のデータベースには存在しない）
    addColumnIfNotExists(this.sql, "tasks", "assigned_to", "TEXT");
    addColumnIfNotExists(this.sql, "tasks", "priority", "INTEGER DEFAULT 0");

    // Step 3: v3 で追加されたカラム
    addColumnIfNotExists(this.sql, "tasks", "retry_options", "TEXT");
    addColumnIfNotExists(this.sql, "tasks", "completed_at", "INTEGER");
  }
}

function addColumnIfNotExists(
  sql: TemplateLiteralFunction,
  table: string,
  column: string,
  definition: string,
): void {
  try {
    sql(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (e) {
    if (e instanceof Error && e.message.includes("duplicate column")) {
      return; // 既にカラムが存在する — 正常
    }
    throw e; // 型エラー、構文エラー等は再スロー
  }
}
```

**Good Example のポイント:**

- テーブル作成とカラム追加がすべてコンストラクタに集約されており、一目でスキーマの全体像がわかる
- `duplicate column` エラーのみを無視し、予期しないエラーは再スローする — silent failure を避けている
- 新しいカラムには `DEFAULT` 値を設定しており、既存行が `NULL` で壊れない
- バージョン管理テーブルや外部ツールが不要

## Bad Example

```typescript
// --- 外部マイグレーションツール依存 / 破壊的マイグレーション ---

class MyAgent extends Agent {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Bad 1: DROP TABLE で既存データを破壊する
    this.sql`DROP TABLE IF EXISTS tasks`;
    this.sql`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        assigned_to TEXT,
        priority INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      )
    `;
    // => 既存インスタンスの全タスクデータが消失する

    // Bad 2: エラーを全て握りつぶす
    try {
      this.sql`ALTER TABLE tasks ADD COLUMN new_field TEXT`;
    } catch {
      // 全エラーを無視 — 型エラーや構文エラーも見逃す
    }

    // Bad 3: バージョン番号による条件分岐
    const version = this.sql`SELECT version FROM schema_meta LIMIT 1`;
    if (version[0]?.version < 3) {
      this.sql`ALTER TABLE tasks ADD COLUMN assigned_to TEXT`;
      this.sql`UPDATE schema_meta SET version = 3`;
    }
    // => schema_meta テーブル自体のマイグレーションが必要になる
    // => 並行デプロイ中にレースコンディションが発生しうる
    // => バージョン番号の管理が複雑化する
  }
}
```

**Bad Example の問題点:**

- `DROP TABLE` は既存データを不可逆に破壊する。サーバーレス環境ではインスタンスごとにデータが異なるため、影響範囲の予測が困難
- エラーの全捕捉は、構文エラーやディスク容量不足といった本来対処すべきエラーを隠蔽する
- バージョン番号ベースのマイグレーションは、バージョン管理テーブル自体のブートストラップ問題を生み、並行バージョン共存時にレースコンディションを引き起こす

## 適用ガイド

### どのような状況で使うべきか

- **サーバーレス / エッジコンピューティング環境**: Durable Objects、Cloudflare Workers、AWS Lambda + DynamoDB のように、インスタンスのライフサイクルが制御不能な環境
- **組み込み SQLite を使うアプリケーション**: Electron、React Native (expo-sqlite)、Tauri など、各クライアントがローカル SQLite を持ち、中央のマイグレーションサーバーを経由できないケース
- **スキーマが加算的に進化するシステム**: カラム追加が主な変更で、カラム削除やリネームが稀なケース
- **ゼロダウンタイムが要件のシステム**: ローリングデプロイ中に旧バージョンと新バージョンが共存する必要がある場合

### 導入時の注意点

- **加算専用の制約**: このパターンはカラムの追加にのみ対応する。カラムの削除(`DROP COLUMN`)、リネーム(`RENAME COLUMN`)、型変更は安全に扱えない。破壊的変更が必要な場合は、新カラムを追加してデータを移行し、旧カラムは放置する戦略を取る
- **DEFAULT 値の設計**: `ADD COLUMN` で追加されるカラムには適切な `DEFAULT` 値を設定する。既存行はマイグレーション時に自動的にデフォルト値が適用されるが、`NOT NULL` 制約を `DEFAULT` なしで追加すると既存行が制約違反になる
- **エラー判定の正確さ**: `duplicate column` の文字列マッチングは SQLite のエラーメッセージ仕様に依存する。使用する DB エンジンに応じてエラーコードベースの判定（例: PostgreSQL の `42701`）に切り替えること
- **テーブル数の増加に注意**: コンストラクタでの DDL 実行はインスタンス起動のたびに走るため、テーブルやカラムが数百に達するとオーバーヘッドが無視できなくなる。現実的には数十テーブル・数十カラムの追加であれば問題ない

### カスタマイズポイント

- **ヘルパー関数のエラー判定**: `e.message.includes("duplicate column")` の部分を、使用する DB エンジンに合わせて変更する（PostgreSQL: エラーコード `42701`、MySQL: エラーコード `1060`）
- **インデックス追加**: `CREATE INDEX IF NOT EXISTS` を同じパターンで追加できる
- **データ移行の組み合わせ**: カラム追加後に `UPDATE ... WHERE new_column IS NULL` でデフォルト値の投入や既存カラムからの値コピーを行うことで、データレベルのマイグレーションも対応可能

## 参考

- [repos/cloudflare/agents/durable-objects-actor-patterns.md](../repos/cloudflare/agents/durable-objects-actor-patterns.md) — Durable Objects Actor パターンの分析。SQLite テーブル初期化と `addColumnIfNotExists` パターンの詳細
- [repos/cloudflare/agents/design-philosophy.md](../repos/cloudflare/agents/design-philosophy.md) — Hibernation を前提としたステート設計と、プラットフォームプリミティブの活用方針
