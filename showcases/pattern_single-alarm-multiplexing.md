# Pattern: Single Alarm Multiplexing

> 出典: [repos/cloudflare/agents/scheduling-and-workflow.md](../repos/cloudflare/agents/scheduling-and-workflow.md)
> カテゴリ: pattern

## 概要

プラットフォームが「同時に1つしか設定できない」制約のあるリソース（タイマー、アラーム、ウェイクアップ等）を、永続ストレージによる多重化レイヤーで抽象化し、任意数の論理リソースとして扱えるようにするパターン。Cloudflare Agents SDK では Durable Objects の単一アラーム制約に対して SQLite テーブル（`cf_agents_schedules`）で4種のスケジュールタイプ（scheduled, delayed, cron, interval）を統一管理している。

このパターンの価値は、プラットフォーム制約をアプリケーション層で吸収することにより、利用者がその制約を意識せずに自然な API でスケジューリングを行えるようにする点にある。

## 背景・文脈

Cloudflare の Durable Objects は `ctx.storage.setAlarm(time)` で単一のアラームしか設定できない。2つ目の `setAlarm()` を呼ぶと前のアラームが上書きされる。しかし実際のアプリケーションでは、同一 Durable Object 内で複数のスケジュール（定期タスク、遅延実行、cron ジョブ等）を同時に管理する必要がある。

Cloudflare Agents SDK（`cloudflare/agents`）は、この制約を SQLite テーブルで吸収する多重化レイヤーを実装している。同様の「単一リソース制約の多重化」はさまざまな場面で応用できる:

- シングルタイマーしか持たない組み込み環境での複数タイマー管理
- 1つのバックグラウンドスレッドで複数の定期処理を実行するサーバーレス環境
- 単一の WebSocket 接続で複数の論理チャネルを多重化するプロトコル

## 実装パターン

### 1. スケジュールテーブルの設計

全スケジュールを永続ストレージに保存する。スケジュールタイプ（`scheduled`, `delayed`, `cron`, `interval`）を1つのテーブルに統一し、`type` カラムで判別する。

```sql
-- packages/agents/src/index.ts:764-777 に基づく構造
CREATE TABLE IF NOT EXISTS cf_agents_schedules (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,           -- 'scheduled' | 'delayed' | 'cron' | 'interval'
  time INTEGER NOT NULL,        -- 次回実行時刻（Unix秒）
  callback TEXT NOT NULL,       -- 実行するメソッド名
  payload TEXT,                 -- JSON シリアライズされたペイロード
  cron_expression TEXT,         -- cron タイプの場合のみ
  interval_seconds INTEGER,     -- interval タイプの場合のみ
  running INTEGER DEFAULT 0,    -- interval の重複実行防止フラグ
  execution_started_at INTEGER, -- 実行開始時刻（ハング検知用）
  created_at INTEGER NOT NULL
);
```

### 2. 最小時刻のみをアラームに設定

全スケジュールの中から最も早い実行時刻を取得し、その時刻だけをプラットフォームのアラームに設定する。

```typescript
// packages/agents/src/index.ts:2296-2310
private async _scheduleNextAlarm() {
  const result = this.sql`
    SELECT time FROM cf_agents_schedules
    WHERE time >= ${Math.floor(Date.now() / 1000)}
    ORDER BY time ASC
    LIMIT 1
  `;
  if (!result) return;
  if (result.length > 0 && "time" in result[0]) {
    const nextTime = (result[0].time as number) * 1000;
    await this.ctx.storage.setAlarm(nextTime);
  }
}
```

ポイント: `ORDER BY time ASC LIMIT 1` で最小時刻のみを取得する。スケジュールの追加・削除・更新のたびにこのメソッドを呼び、アラームを再設定する。

### 3. アラーム発火時に期限到来スケジュールを一括処理

アラームが発火したら、現在時刻以前のスケジュールをすべて取得してループ実行する。

```typescript
// packages/agents/src/index.ts:2320-2328 に基づく
async alarm() {
  const now = Math.floor(Date.now() / 1000);
  const dueSchedules = this.sql`
    SELECT * FROM cf_agents_schedules
    WHERE time <= ${now}
    ORDER BY time ASC
  `;

  for (const row of dueSchedules) {
    await this._executeSchedule(row);
  }

  // 次のアラームを設定
  await this._scheduleNextAlarm();
}
```

`WHERE time <= now` により、アラームの精度ずれやプロセス再起動で実行が遅れたスケジュールも取りこぼさない。

### 4. タイプ別の後処理

実行後のスケジュール更新はタイプごとに異なる:

- **scheduled / delayed**: 実行後に DELETE（ワンショット）
- **cron**: `cron-schedule` ライブラリで次回実行時刻を算出し UPDATE
- **interval**: `running` フラグをリセットし、`time` を次回時刻に UPDATE

### 5. 統一的なスケジュール API

引数の型（`Date | string | number`）でスケジュールタイプを決定する discriminated union パターンで、利用者にとって自然な API を提供する。

```typescript
// packages/agents/src/index.ts:1995-2000
async schedule<T = string>(
  when: Date | string | number,
  callback: keyof this,    // コンパイル時に存在チェック
  payload?: T,
  options?: { retry?: RetryOptions }
): Promise<Schedule<T>> {
  // Date      → scheduled（指定日時に実行）
  // number    → delayed（N秒後に実行）
  // string    → cron（cron式に従い繰り返し実行）

  // ランタイムでもメソッド存在を検証
  if (typeof this[callback] !== "function") {
    throw new Error(`this.${callback} is not a function`);
  }
  // ...
}
```

`callback: keyof this` による型安全性と `typeof this[callback] !== "function"` によるランタイム検証の二重チェックにより、存在しないメソッド名の指定を防ぐ。

## Good Example

```typescript
// -- 多重化レイヤーの正しい実装 --

// 1. スケジュール追加時: テーブルに INSERT し、アラームを再計算
async addSchedule(schedule: ScheduleRow): Promise<void> {
  this.sql`
    INSERT INTO schedules (id, type, time, callback, payload)
    VALUES (${schedule.id}, ${schedule.type}, ${schedule.time},
            ${schedule.callback}, ${schedule.payload})
  `;
  // 新しいスケジュールが最も近い可能性があるのでアラーム再設定
  await this._scheduleNextAlarm();
}

// 2. スケジュール削除時: テーブルから DELETE し、アラームを再計算
async removeSchedule(id: string): Promise<void> {
  this.sql`DELETE FROM schedules WHERE id = ${id}`;
  // 削除したスケジュールがアラーム対象だった可能性があるので再設定
  await this._scheduleNextAlarm();
}

// 3. interval の重複実行防止: running フラグ + ハング検知
// packages/agents/src/index.ts:2338-2363
if (row.type === "interval" && row.running === 1) {
  const executionStartedAt = row.execution_started_at ?? 0;
  const hungTimeoutSeconds = this._resolvedOptions.hungScheduleTimeoutSeconds;
  const elapsedSeconds = now - executionStartedAt;

  if (elapsedSeconds < hungTimeoutSeconds) {
    console.warn(`Skipping interval schedule ${row.id}: previous execution still running`);
    continue;  // まだ実行中 → スキップ
  }
  // ハングとみなしてフォースリセット
  console.warn(`Forcing reset of hung interval schedule ${row.id} (started ${elapsedSeconds}s ago)`);
}
```

## Bad Example

```typescript
// Bad: アラームを直接使い回す（後勝ちで上書きされる）
class NaiveScheduler {
  async addTimer(name: string, time: number) {
    // 2つ目の setAlarm で1つ目が消える!
    await this.ctx.storage.setAlarm(time);
  }
}

// Bad: メモリ上のみでスケジュール管理（プロセス再起動で消失）
class VolatileScheduler {
  private schedules: Map<string, Schedule> = new Map();

  async addSchedule(schedule: Schedule) {
    this.schedules.set(schedule.id, schedule);
    // メモリ上の Map はエビクション/再起動で失われる
  }
}

// Bad: interval の重複実行を考慮しない
async executeSchedule(row: ScheduleRow) {
  // 前回のコールバックがまだ実行中でも気にせず再実行
  // → 同じ処理が並列で走り、データ不整合やリソース競合が発生
  await this[row.callback](row.payload);
}
```

## 適用ガイド

### どのような状況で使うべきか

- プラットフォームが提供するタイマー/アラーム/ウェイクアップが単一に制限されている環境
- 複数の独立したスケジュール（定期実行、遅延実行、cron 等）を同一プロセス/インスタンスで管理する必要がある場合
- プロセスの再起動やエビクションが起こりうる環境で、スケジュールの永続性を保証したい場合

### 導入時の注意点

- **`ORDER BY time ASC` クエリのコスト**: スケジュール数が増えるとソートのコストが増大する。実用上は数万件程度まで。それ以上の場合は `time` カラムにインデックスを作成するか、パーティショニングを検討する
- **アラーム再設定の頻度**: スケジュールの追加・削除・完了のたびに `_scheduleNextAlarm()` を呼ぶ必要がある。呼び忘れるとアラームが古い時刻のままになり、新しいスケジュールが実行されない
- **時刻精度**: アラームの発火はミリ秒精度だが、`WHERE time <= now` で期限到来スケジュールを一括取得するため、数秒程度の遅延は許容される設計になっている
- **interval の重複実行防止**: `running` フラグとハングタイムアウト（デフォルト30秒）の設計が必要。タイムアウト値はコールバックの想定実行時間に合わせて調整する

### カスタマイズポイント

- **スケジュールタイプの追加**: テーブルに新しい `type` を追加し、後処理ロジック（DELETE/UPDATE/リセット）を実装するだけで拡張できる
- **リトライ戦略**: `options.retry` でスケジュールごとにリトライポリシーを設定可能。エクスポネンシャルバックオフ等を組み込める
- **コールバックの型安全性**: `callback: keyof this` パターンを採用すると、TypeScript のコンパイル時チェックでメソッド名のタイポを防げる
- **ハング検知のタイムアウト**: アプリケーションの特性に合わせて `hungScheduleTimeoutSeconds` を調整する

## 参考

- [repos/cloudflare/agents/scheduling-and-workflow.md](../repos/cloudflare/agents/scheduling-and-workflow.md) -- 元の分析（スケジューリング・ワークフロー・ファイバーの三層実行モデル全体）
