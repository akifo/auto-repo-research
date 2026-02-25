# Scheduling and Workflow

> リポジトリ: cloudflare/agents
> 分析日: 2026-02-25

## 概要

Cloudflare Agents SDK におけるスケジューリングとワークフローの設計を分析する。このリポジトリは Durable Objects の単一アラーム制約を SQLite ベースの多重スケジュール管理で克服し、永続的なバックグラウンド処理と human-in-the-loop 承認パターンを提供している。注目すべきは、スケジューリング（時間駆動の軽量タスク）・ワークフロー（耐久性のある多段処理）・ファイバー（長寿命の実験的実行）という三層の実行モデルを、統一的な SQLite 永続化基盤の上に構築している点である。

## 背景にある原則

- **単一制約を多重化レイヤーで吸収すべき**: Durable Objects は同時に1つのアラームしか持てない。この制約に対して「最も近い次回実行時刻のみをアラームに設定し、全スケジュールは SQLite で管理する」というレイヤーを挟むことで、任意数のスケジュールを実現している（`_scheduleNextAlarm` が `ORDER BY time ASC LIMIT 1` で最小時刻を取得し `setAlarm` する）。プラットフォーム制約をアプリ層で多重化する典型的パターン。
  - 根拠: `packages/agents/src/index.ts:2296-2310`

- **耐久性の境界を型レベルで明示すべき**: `AgentWorkflowStep` は `WorkflowStep` を拡張して `reportComplete`/`reportError`/`sendEvent` 等の耐久メソッドを追加する。一方 `reportProgress` や `broadcastToClients` は `this` のメソッドであり非耐久（リトライ時に再実行される）。この「step 経由 = 耐久」「this 経由 = 非耐久」という設計規約により、開発者はメソッドの呼び出し元で耐久性を判断できる。
  - 根拠: `packages/agents/src/workflow-types.ts:28-69`, `packages/agents/src/workflows.ts:196-263`

- **ワークフローとエージェントの責務を分離し、双方向 RPC で接続すべき**: エージェント（リアルタイム通信、状態管理）とワークフロー（耐久実行、リトライ）はそれぞれの強みに特化し、`this.agent` RPC スタブと `onWorkflow*` コールバックで疎結合に接続している。ワークフローがエージェントの状態を直接更新することも可能だが、すべて `step.do` ラッパー経由でべき等性を担保する。
  - 根拠: `packages/agents/src/workflows.ts:62-67`, `packages/agents/src/index.ts:3597-3730`

- **ハイバネーション耐性を永続化の第一原則とすべき**: Durable Objects はいつでもエビクションされうる。スケジュール・ワークフロー追跡・ファイバー状態をすべて SQLite に永続化し、アラーム起動時に `WHERE time <= now` で未実行タスクを一括取得する設計により、ハイバネーション後も確実にタスクが実行される。
  - 根拠: `packages/agents/src/index.ts:764-777`（スケジュールテーブル）, `packages/agents/src/index.ts:2320-2328`（alarm 内の SELECT）

## 実例と分析

### SQLite による多重スケジュール管理

Durable Objects は `ctx.storage.setAlarm()` で単一のアラームしか設定できない。SDK は `cf_agents_schedules` テーブルに全スケジュールを保存し、次回最小実行時刻のみをアラームに設定する。

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

アラーム発火時には `WHERE time <= now` で期限到来の全スケジュールを取得し、ループで順次実行する（`packages/agents/src/index.ts:2320-2328`）。cron スケジュールは `cron-schedule` ライブラリで次回実行時刻を算出し UPDATE、one-time スケジュールは DELETE、interval は `running` フラグをリセットして次回時刻を設定する。

### 4種のスケジュールタイプの統一設計

`schedule()` メソッドは引数の型（`Date` / `number` / `string`）で振る舞いを分岐する discriminated union パターンを採用している。

```typescript
// packages/agents/src/index.ts:1995-2000
async schedule<T = string>(
  when: Date | string | number,
  callback: keyof this,
  payload?: T,
  options?: { retry?: RetryOptions }
): Promise<Schedule<T>>
```

`callback` パラメータは `keyof this` で型安全にメソッド名を受け取り、実行時に `typeof this[callback] !== "function"` でバリデーションする二重チェック（`packages/agents/src/index.ts:2024-2030`）。

### インターバルスケジュールの重複実行防止

`scheduleEvery()` で作成されるインターバルスケジュールには、`running` フラグと `execution_started_at` タイムスタンプによる重複防止機構がある。

```typescript
// packages/agents/src/index.ts:2338-2363
// Overlap prevention for interval schedules with hung callback detection
if (row.type === "interval" && row.running === 1) {
  const executionStartedAt = (row as { execution_started_at?: number; }).execution_started_at ?? 0;
  const hungTimeoutSeconds = this._resolvedOptions.hungScheduleTimeoutSeconds;
  const elapsedSeconds = now - executionStartedAt;

  if (elapsedSeconds < hungTimeoutSeconds) {
    console.warn(
      `Skipping interval schedule ${row.id}: previous execution still running`,
    );
    continue;
  }
  // Previous execution appears hung, force reset and re-execute
  console.warn(
    `Forcing reset of hung interval schedule ${row.id} (started ${elapsedSeconds}s ago)`,
  );
}
```

前回実行がまだ `running` 状態であれば、ハングタイムアウト（デフォルト30秒）以内ならスキップし、超過していればフォースリセットして再実行する。テストでは `simulateHungSchedule` でこの挙動を明示的に検証している（`packages/agents/src/tests/agents/schedule.ts:149-163`）。

### AgentWorkflow のプロトタイプラッピング

`AgentWorkflow` のコンストラクタは `run()` メソッドをプロトタイプレベルでラップし、ユーザーの `run()` 呼び出し前にエージェント接続を初期化する。`WeakSet` で二重ラッピングを防止し、`__agentInitCalled` インスタンスフラグで `super.run()` 呼び出し時の二重初期化も防ぐ。

```typescript
// packages/agents/src/workflows.ts:93-149
const proto = Object.getPrototypeOf(this);
if (Object.hasOwn(proto, "run") && !wrappedPrototypes.has(proto)) {
  const originalRun = proto.run;
  proto.run = async function(this, event, step) {
    if (!this.__agentInitCalled) {
      const { __agentName, __agentBinding, __workflowName, ...userParams } = event.payload;
      await this._initAgent(__agentName, __agentBinding, __workflowName, event.instanceId);
      this.__agentInitCalled = true;
      const cleanedEvent = { ...event, payload: userParams };
      const wrappedStep = this._wrapStep(step);
      return originalRun.call(this, cleanedEvent, wrappedStep);
    }
    return originalRun.call(this, event, step);
  };
  wrappedPrototypes.add(proto);
}
```

内部パラメータ（`__agentName`, `__agentBinding`, `__workflowName`）はユーザーの `run()` に渡す前にペイロードから除去される。

### Human-in-the-Loop: waitForApproval パターン

ワークフロー内で `this.waitForApproval(step, opts)` を呼ぶと、内部的に `step.waitForEvent()` でワークフローが一時停止する。エージェント側では `approveWorkflow()` / `rejectWorkflow()` が `sendWorkflowEvent()` 経由で `{ type: "approval", payload: { approved: true/false } }` イベントを送信する。

```typescript
// packages/agents/src/workflows.ts:358-389
protected async waitForApproval<T = unknown>(
  step: AgentWorkflowStep,
  options?: WaitForApprovalOptions
): Promise<T> {
  const stepName = options?.stepName ?? "wait-for-approval";
  const eventType = options?.eventType ?? "approval";
  const timeout = options?.timeout;

  const event = await step.waitForEvent(stepName, {
    type: eventType,
    timeout
  });

  const payload = event.payload as { approved: boolean; reason?: string; metadata?: T };
  if (!payload.approved) {
    const reason = payload.reason;
    await step.reportError(reason ?? "Workflow rejected");
    throw new WorkflowRejectedError(reason, this._workflowId);
  }
  return payload.metadata as T;
}
```

却下時は `WorkflowRejectedError` を throw し、ワークフロー側で `try/catch` で処理できる（`examples/playground/src/demos/workflow/approval-workflow.ts:43-80`）。

### ファイバー: 実験的な長寿命実行

`withFibers` ミックスインは `scheduleEvery` によるハートビート（10秒間隔）で DO を生存させ、エビクション後にはハートビートコールバックから中断されたファイバーを検知・復旧する。`stashFiber()` で中間状態を SQLite にチェックポイントでき、復旧時にスナップショットから再開可能。

```typescript
// packages/agents/src/experimental/forever.ts:175-193
async keepAlive(): Promise<() => void> {
  const heartbeatSeconds = Math.ceil(KEEP_ALIVE_INTERVAL_MS / 1000);
  const schedule = await (this as unknown as Agent<Cloudflare.Env>).scheduleEvery(
    heartbeatSeconds,
    "_cf_fiberHeartbeat" as keyof Agent<Cloudflare.Env>
  );
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    void this.cancelSchedule(schedule.id);
  };
}
```

## パターンカタログ

- **Multiplexer パターン** (構造)
  - 解決する問題: プラットフォームが単一リソース（アラーム1つ）しか提供しない場合に、複数の論理的リソース（任意数のスケジュール）を実現する
  - 適用条件: 基盤層の制約が固定されており、アプリ層で多重化が必要な場合
  - コード例: `packages/agents/src/index.ts:2296-2310`（`_scheduleNextAlarm`）
  - 注意点: 全スケジュールをスキャンする `ORDER BY` クエリのコストに留意。実用上は数万件まで

- **Mediator パターン** (振る舞い)
  - 解決する問題: ワークフロー（耐久実行）とエージェント（リアルタイム通信）という異なるライフサイクルのコンポーネント間通信
  - 適用条件: 双方向通信が必要だが、直接依存を避けたい場合
  - コード例: `packages/agents/src/workflows.ts:304-307`（`notifyAgent`）, `packages/agents/src/index.ts:3608-3666`（`onWorkflowCallback`）
  - 注意点: コールバック型の discriminated union で型安全性を確保している

- **Disposer パターン** (振る舞い)
  - 解決する問題: リソース（ハートビートスケジュール）のライフサイクル管理
  - 適用条件: 開始と終了が対になるリソースの確実な後始末
  - コード例: `packages/agents/src/experimental/forever.ts:175-193`（`keepAlive` が disposer 関数を返す）

## Good Patterns

- **型による耐久性の区別**: `step` のメソッドは耐久（べき等）、`this` のメソッドは非耐久（リトライ時再実行）。呼び出し先のオブジェクトだけで耐久性を判断できるため、開発者の認知負荷が低い。

```typescript
// packages/agents/src/workflows.ts:196-263 - step 経由のメソッドは step.do() でラップされべき等
wrappedStep.reportComplete = async <T>(result?: T): Promise<void> => {
  await step.do(`__agent_reportComplete_${stepCounter++}`, async () => {
    await this.notifyAgent({ ... type: "complete", result, ... });
  });
};

// packages/agents/src/workflows.ts:324-332 - this 経由のメソッドは非耐久
protected async reportProgress(progress: ProgressType): Promise<void> {
  await this.notifyAgent({ ... type: "progress", progress, ... });
}
```

- **コールバック名の型安全**: `schedule()` の `callback` パラメータに `keyof this` を使い、存在しないメソッド名のコンパイル時検出 + ランタイム検証を組み合わせている。

```typescript
// packages/agents/src/index.ts:1995-2030
async schedule<T = string>(
  when: Date | string | number,
  callback: keyof this,  // コンパイル時チェック
  ...
): Promise<Schedule<T>> {
  if (typeof this[callback] !== "function") {  // ランタイムチェック
    throw new Error(`this.${callback} is not a function`);
  }
```

- **内部パラメータの透過的注入と除去**: `runWorkflow()` が `__agentName` 等を params に注入し、`AgentWorkflow` のラッパーが `run()` 呼び出し前に除去する。ユーザーのワークフローコードは内部パラメータを意識しない。

```typescript
// packages/agents/src/index.ts:2604-2610 - 注入
const augmentedParams = {
  ...params,
  __agentName: this.name,
  __agentBinding: agentBindingName,
  __workflowName: workflowName,
};

// packages/agents/src/workflows.ts:116-131 - 除去
const { __agentName, __agentBinding, __workflowName, ...userParams } = event.payload;
const cleanedEvent = { ...event, payload: userParams as Params };
```

## Anti-Patterns / 注意点

- **ワークフロー追跡テーブルの無制限増加**: `cf_agents_workflows` テーブルは自動クリーンアップがない。完了・エラーのレコードが蓄積し続け、`getWorkflows()` のパフォーマンスが劣化する。

```typescript
// Bad: クリーンアップなし
async onWorkflowComplete(workflowName, workflowId, result) {
  // 完了を通知するだけで追跡レコードはそのまま
  this.broadcast(JSON.stringify({ type: "complete", workflowId }));
}

// Better: 完了時にクリーンアップ、または定期削除
async onWorkflowComplete(workflowName, workflowId, result) {
  this.broadcast(JSON.stringify({ type: "complete", workflowId }));
  this.deleteWorkflow(workflowId);
}
// or
this.deleteWorkflows({
  status: ["complete", "errored"],
  createdBefore: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
});
```

- **broadcastToClients のリトライ時再実行**: `broadcastToClients` は `step.do` でラップされていないため、ワークフローのリトライ時にクライアントへ重複メッセージが送信される可能性がある。頻度の高い進捗通知以外はべき等な step メソッドを使うべき。

```typescript
// Bad: 重要な通知を非耐久メソッドで送信
this.broadcastToClients({ type: "payment-processed", amount: 1000 });

// Better: 重要な状態変更は step 経由で耐久的に実行
await step.sendEvent({ type: "payment-processed", amount: 1000 });
```

## 導出ルール

- `[MUST]` スケジューリングデータは揮発性ストレージではなく永続ストアに保存し、プロセス再起動後も確実に実行されるようにする
  - 根拠: `cf_agents_schedules` テーブルの全スケジュールを SQLite に永続化し、alarm 起動時に `WHERE time <= now` で未実行タスクを一括取得する設計がハイバネーション耐性を保証している（`packages/agents/src/index.ts:764-777`, `2320-2328`）

- `[MUST]` ワークフローのステップにおいて、べき等な操作と非べき等な操作の境界を API レベルで明確に分離する
  - 根拠: `step` メソッド（耐久、リトライセーフ）と `this` メソッド（非耐久）の区別が設計規約として徹底されており、`AgentWorkflowStep` インターフェースで型安全に表現されている（`packages/agents/src/workflow-types.ts:28-69`）

- `[SHOULD]` プラットフォームの単一リソース制約に対しては、永続ストアによる多重化レイヤーを挟んで複数の論理リソースをエミュレートする
  - 根拠: Durable Objects の単一アラーム制約に対して、SQLite テーブル + `MIN(time)` でのアラーム再設定というパターンで任意数のスケジュールを実現している（`packages/agents/src/index.ts:2296-2310`）

- `[SHOULD]` 定期実行タスクには重複実行防止（`running` フラグ + ハング検知タイムアウト）を組み込む
  - 根拠: インターバルスケジュールで `running=1` フラグとタイムスタンプベースのハング検知を実装し、コールバックが遅延した場合のスキップとハング時のフォースリセットを区別している（`packages/agents/src/index.ts:2338-2363`）

- `[SHOULD]` human-in-the-loop 承認フローでは、ワークフロー一時停止 + イベント送信パターンを使い、承認/却下の結果を型安全に伝達する
  - 根拠: `waitForApproval` が `step.waitForEvent` でワークフローを停止し、`approveWorkflow`/`rejectWorkflow` が定型イベントを送信する。却下時は専用エラー型 `WorkflowRejectedError` で処理フローを制御する（`packages/agents/src/workflows.ts:358-389`）

- `[AVOID]` ワークフロー追跡テーブルを自動クリーンアップなしで運用すること — 完了・エラーレコードの保持ポリシーを必ず設計する
  - 根拠: ドキュメントで明示的に「The `cf_agents_workflows` table can grow unbounded」と警告し、3つのクリーンアップ戦略（即時削除、定期削除、全保持）を提示している（`docs/workflows.md:799-817`）

- `[AVOID]` リトライ対象のワークフロー内で、べき等でない副作用（外部 API 呼び出し、通知送信等）を `step.do` の外で実行すること
  - 根拠: `broadcastToClients` はリトライ時に再実行される旨が明記されており（`docs/workflows.md:202`）、重要な状態変更は `step.reportComplete` 等の耐久メソッド経由が推奨されている

## 適用チェックリスト

- [ ] プロセス再起動・エビクション後にスケジュールタスクが消失しない永続化機構があるか
- [ ] 定期実行タスクに重複実行防止の仕組み（ロック、running フラグ等）が実装されているか
- [ ] ワークフローの各ステップで、べき等な操作と非べき等な操作が API レベルで区別されているか
- [ ] ワークフロー追跡テーブルのレコード保持ポリシー（自動削除、アーカイブ等）が定義されているか
- [ ] human-in-the-loop パターンにおいて、承認待ちタイムアウトとエスカレーションの設計があるか
- [ ] スケジュールのコールバック名が型安全に検証されているか（コンパイル時 + ランタイム）
- [ ] 長寿命タスクのハイバネーション対策（ハートビート、チェックポイント）が考慮されているか
