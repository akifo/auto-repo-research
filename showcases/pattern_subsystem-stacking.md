# Pattern: Subsystem Stacking

> 出典: [repos/cloudflare/agents/architecture.md](../repos/cloudflare/agents/architecture.md)
> カテゴリ: pattern

## 概要

単一の基盤クラスに対して、独立した関心事（状態管理、スケジューリング、キュー、MCP 接続、ワークフロー追跡など）をそれぞれ専用の SQLite テーブルとしてコンストラクタ内で宣言的に積層するアーキテクチャパターン。各サブシステムは自身のスキーマとマイグレーションを持ち、`CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN`（duplicate 無視）で冪等に初期化される。

このパターンの価値は、外部データベースや別サービスへの依存を排除しつつ、単一オブジェクト内で複数の関心事を整合性をもって統合管理できる点にある。特にサーバーレス環境やエッジコンピューティングのように「いつインスタンスが再作成されるか分からない」特性を持つランタイムで強力に機能する。

## 背景・文脈

Cloudflare Agents SDK（`cloudflare/agents`）では、`Agent` クラスが partyserver の `Server` を一段継承し、その上に5つの独立したサブシステムを積層している。各サブシステムは Durable Object 内蔵の SQLite ストレージにテーブルとして存在し、外部サービスへの通信なしにすべての機能が動作する。

```
┌─────────────────────────────────────────────┐
│  Agent (extends Server)                     │
│  ┌─────────────┐ ┌──────────────────────┐   │
│  │ cf_agents_   │ │ cf_agents_           │   │
│  │ state        │ │ schedules            │   │
│  └─────────────┘ └──────────────────────┘   │
│  ┌─────────────┐ ┌──────────────────────┐   │
│  │ cf_agents_   │ │ cf_agents_           │   │
│  │ queues       │ │ mcp_servers          │   │
│  └─────────────┘ └──────────────────────┘   │
│  ┌──────────────────────────────────────┐   │
│  │ cf_agents_workflows                  │   │
│  └──────────────────────────────────────┘   │
│                                             │
│  ── SQLite Storage (単一ライター保証) ──    │
└─────────────────────────────────────────────┘
```

同様の「サブシステム積層」は以下の場面で応用できる:

- マイクロサービスの機能を単一プロセス/オブジェクトに統合するモノリシック設計
- プラグインごとに独立したテーブルを持つ CMS やフレームワーク
- IoT デバイスでオフライン動作可能な複合機能の実装
- ローカルファースト・アプリケーションの組み込みデータベース活用

## 実装パターン

### 1. テーブル宣言によるサブシステム定義

各サブシステムの存在は「テーブルが存在するかどうか」で決まる。コンストラクタ内で `CREATE TABLE IF NOT EXISTS` を使い、テーブルがなければ作成、あれば何もしないという冪等な初期化を行う。

```typescript
// packages/agents/src/index.ts:736-777 に基づく構造
constructor(ctx: DurableObjectState, env: Env) {
  super(ctx, env);

  // サブシステム 1: 状態管理
  this.sql`
    CREATE TABLE IF NOT EXISTS cf_agents_state (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    )
  `;

  // サブシステム 2: スケジューリング
  this.sql`
    CREATE TABLE IF NOT EXISTS cf_agents_schedules (
      id TEXT PRIMARY KEY NOT NULL DEFAULT (randomblob(9)),
      callback TEXT,
      payload TEXT,
      type TEXT NOT NULL CHECK(type IN ('scheduled', 'delayed', 'cron', 'interval')),
      time INTEGER,
      delayInSeconds INTEGER,
      cron TEXT,
      intervalSeconds INTEGER,
      running INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch())
    )
  `;

  // サブシステム 3: キュー
  // サブシステム 4: MCP サーバー接続
  // サブシステム 5: ワークフロー追跡
  // ... 同様のパターンで初期化
}
```

ポイント: 各テーブルは `cf_agents_` プレフィックスで名前空間を分離しており、ユーザーが独自テーブルを追加しても衝突しない。

### 2. 冪等マイグレーション

バージョンアップでカラムを追加する際、`ALTER TABLE ADD COLUMN` を try-catch で wrap し、`duplicate column` エラーを無視する。これにより、どのバージョンのコードが起動しても正しいスキーマが得られる。

```typescript
// packages/agents/src/index.ts:781-806
const addColumnIfNotExists = (sql: string) => {
  try {
    this.ctx.storage.sql.exec(sql);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (!message.toLowerCase().includes("duplicate column")) {
      throw e;
    }
  }
};

// スケジュールテーブルへのカラム追加マイグレーション
addColumnIfNotExists(
  "ALTER TABLE cf_agents_schedules ADD COLUMN execution_started_at INTEGER",
);
addColumnIfNotExists(
  "ALTER TABLE cf_agents_schedules ADD COLUMN max_retries INTEGER DEFAULT 0",
);
```

### 3. サブシステム間の疎結合

各サブシステムは独立して動作するが、必要に応じて Agent クラスを介して連携する。Agent は Mediator として各サブシステム間の調停を行う。

```typescript
// packages/agents/src/index.ts:844-856 に基づく
// MCP 接続の状態変更をクライアントにブロードキャスト
this.mcp.onUpdate(async (servers) => {
  this.broadcast(
    JSON.stringify({
      type: MessageType.CF_AGENT_MCP_SERVERS,
      servers,
    }),
  );
});
```

### 4. Composition によるサブシステム注入

継承ではなく、フィールドとしてサブシステムマネージャを注入する。これにより基盤クラスの継承チェーンを浅く保つ。

```typescript
// packages/agents/src/index.ts:838-842
this.mcp = new MCPClientManager(this._ParentClass.name, "0.0.1", {
  storage: this.ctx.storage,
  createAuthProvider: (callbackUrl) => this.createMcpOAuthProvider(callbackUrl),
});
```

## Good Example

```typescript
// -- サブシステム積層の正しい実装 --

class MyAgent extends BaseAgent {
  constructor(ctx: ObjectState, env: Env) {
    super(ctx, env);

    // 各サブシステムは独立したテーブルとして宣言
    this.sql`
      CREATE TABLE IF NOT EXISTS agent_tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending',
        payload TEXT,
        created_at INTEGER DEFAULT (unixepoch())
      )
    `;

    this.sql`
      CREATE TABLE IF NOT EXISTS agent_metrics (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        value REAL NOT NULL,
        recorded_at INTEGER DEFAULT (unixepoch())
      )
    `;

    // 冪等マイグレーション: 新バージョンで追加したカラム
    this.addColumnIfNotExists(
      "ALTER TABLE agent_tasks ADD COLUMN priority INTEGER DEFAULT 0",
    );
    this.addColumnIfNotExists(
      "ALTER TABLE agent_tasks ADD COLUMN retry_count INTEGER DEFAULT 0",
    );

    // サブシステムマネージャの注入 (composition)
    this.notifications = new NotificationManager(this.ctx.storage);
    this.notifications.onSend((msg) => this.broadcast(msg));
  }

  // サブシステム間の連携は Agent を介する (Mediator)
  async completeTask(taskId: string) {
    this.sql`UPDATE agent_tasks SET status = 'done' WHERE id = ${taskId}`;
    this.sql`
      INSERT INTO agent_metrics (id, name, value)
      VALUES (${crypto.randomUUID()}, 'task_completed', 1)
    `;
    await this.notifications.send(`Task ${taskId} completed`);
  }
}
```

## Bad Example

```typescript
// Bad: サブシステムごとに外部データベースに依存
class FragmentedAgent extends BaseAgent {
  constructor() {
    super();
    this.taskDb = new ExternalDB("tasks-service"); // 外部依存
    this.metricsDb = new ExternalDB("metrics-service"); // 外部依存
    this.notifyDb = new ExternalDB("notify-service"); // 外部依存
    // 3つの外部サービスすべてが利用可能でないと起動できない
    // ネットワーク障害で部分的に機能停止する
  }
}

// Bad: テーブル作成を条件分岐で管理（冪等でない）
class VersionedAgent extends BaseAgent {
  constructor() {
    super();
    const version = this.getStoredVersion();
    if (version < 2) {
      this.sql`ALTER TABLE tasks ADD COLUMN priority INTEGER`;
      // バージョン1 → 3 に飛ぶと ALTER が失敗する
    }
    if (version < 3) {
      this.sql`ALTER TABLE tasks ADD COLUMN retry_count INTEGER`;
    }
    this.setStoredVersion(3);
  }
}

// Bad: 全サブシステムを1つの巨大テーブルに詰め込む
class MonoTableAgent extends BaseAgent {
  constructor() {
    super();
    this.sql`
      CREATE TABLE IF NOT EXISTS agent_data (
        id TEXT PRIMARY KEY,
        type TEXT,     -- 'task' | 'metric' | 'schedule' | 'config'
        data TEXT      -- JSON blob
      )
    `;
    // 型安全性なし、インデックス最適化困難、スキーマ進化が複雑
  }
}

// Bad: 深い継承チェーンでサブシステムを追加
class ScheduleAgent extends BaseAgent {/* schedules テーブル */}
class QueueAgent extends ScheduleAgent {/* queues テーブル */}
class McpAgent extends QueueAgent {/* mcp テーブル */}
class WorkflowAgent extends McpAgent {/* workflows テーブル */}
// 4段の継承 → コンストラクタ実行順序の把握が困難
// 中間クラスの変更が全下位クラスに波及
```

## 適用ガイド

### どのような状況で使うべきか

- 単一のプロセスやオブジェクト内で複数の独立した関心事（状態管理、スケジューリング、キュー、外部接続管理など）を統合管理する必要がある場合
- サーバーレスやエッジ環境のように、外部データベースへの接続コストが高い、または利用できない場合
- インスタンスの再作成タイミングが不確定で、起動時に常にスキーマの整合性を担保する必要がある場合
- サブシステムの追加・削除がアプリケーションの進化とともに段階的に発生する場合

### 導入時の注意点

- **テーブル名のプレフィックス規約**: フレームワークのテーブルとユーザーのテーブルが衝突しないよう、`cf_agents_` のような一貫したプレフィックスを設計する
- **マイグレーションの冪等性**: `CREATE TABLE IF NOT EXISTS` と `ALTER TABLE ADD COLUMN`（duplicate 無視）を必ずセットで使う。バージョン番号による条件分岐は、バージョンの飛び越しに脆弱なため避ける
- **コンストラクタの肥大化**: サブシステムが増えるとコンストラクタが長くなる。各サブシステムの初期化を専用メソッド（`_initSchedules()`, `_initQueues()` など）に分割し、コンストラクタからは呼び出すだけにする
- **サブシステム間の循環依存**: Agent を Mediator として使う場合でも、サブシステム A がサブシステム B のテーブルを直接操作するような結合は避ける。必ず Agent のメソッドを経由する

### カスタマイズポイント

- **テーブル設計**: サブシステムの用途に合わせてカラムを設計する。CHECK 制約（`CHECK(type IN (...))` など）でデータの整合性をテーブルレベルで担保できる
- **サブシステムの追加**: 新しいテーブルを `CREATE TABLE IF NOT EXISTS` で追加するだけで、既存のサブシステムに影響を与えずに機能を拡張できる
- **Composition vs 直接 SQL**: 単純なサブシステムはテーブル操作メソッドとして Agent に直接実装し、複雑なもの（MCP クライアント管理など）は専用のマネージャクラスに委譲する
- **カラム追加の段階的展開**: `addColumnIfNotExists` パターンにより、新カラムを必要とするコードと古いスキーマのインスタンスが共存できる

## 参考

- [repos/cloudflare/agents/architecture.md](../repos/cloudflare/agents/architecture.md) -- 元の分析（Agent の基盤委譲・サブシステム集約・プロトコル注入の全体像）
