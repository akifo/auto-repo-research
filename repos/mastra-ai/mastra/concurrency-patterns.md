# Concurrency Patterns

> リポジトリ: mastra-ai/mastra
> 分析日: 2026-02-14

## 概要

mastra の並行処理パターンを横断的に分析した。このリポジトリは AI エージェントフレームワークとして、ワークフローの suspend/resume、ストリーミング、並列ステップ実行、debounce 付きメッセージ永続化など、多層的な非同期処理を扱っている。特筆すべきは、ワークフローエンジンが「一時停止可能な実行」を第一級概念として設計しており、branded type による型安全な suspend と、スナップショットベースの状態復元を組み合わせている点である。

## 背景にある原則

- **中断可能性をプリミティブとして設計する**: 非同期ワークフローでは「途中で止まる」ことが例外ではなく通常のフローである。suspend/resume をステップ関数のパラメータとして注入し、呼び出し側が中断ポイントを宣言的に定義できるようにしている（`packages/core/src/workflows/step.ts:49-51`）。人間の承認待ちや外部イベント待ちなど、長時間の中断を想定した設計。

- **並行度は安全性制約から導出する**: tool call の並行実行数はデフォルト 10 だが、承認が必要なツールや suspend スキーマを持つツールがある場合は自動的に 1（逐次実行）に降格する（`packages/core/src/loop/workflows/agentic-execution/index.ts:37-66`）。並行度は性能パラメータではなく、安全性制約の帰結として決定される。

- **ストリームはバッファリング付き EventEmitter で多重消費を許可する**: `MastraModelOutput` はチャンクをバッファに蓄積しつつ EventEmitter で配信し、新しいリーダーが接続した時点でバッファを再生する（`packages/core/src/stream/base/output.ts:1392-1434`）。これにより同一ストリームから `textStream`、`objectStream`、`fullStream` を同時に読み取れる。

- **書き込みの頻度をアプリケーション層で制御する**: メッセージの永続化はストリーミング中に高頻度で発生しうるため、debounce + staleness チェックのハイブリッド戦略で書き込み頻度を制御する（`packages/core/src/agent/save-queue/index.ts:114-124`）。インフラ層ではなくアプリケーション層で書き込み戦略を持つことで、リアルタイム性と I/O 効率のバランスを取る。

## 実例と分析

### Suspend/Resume: 型安全な中断メカニズム

ワークフローのステップは `suspend()` 関数を呼ぶことで実行を中断できる。再開時には `resumeData` が注入される。注目すべきは、`suspend()` の戻り値が branded type `InnerOutput` として定義されている点で、これにより suspend を呼ばずにステップを終了しようとするとコンパイルエラーになる。

```typescript
// packages/core/src/workflows/step.ts:17-21
declare const SuspendBrand: unique symbol;
export type InnerOutput = void & { readonly [SuspendBrand]: never; };
```

suspend 実行時には `__workflow_meta` という内部メタデータが payload に付加され、再開時のルーティングに使われる。この内部データはステップコードに露出する前にフィルタされる。

```typescript
// packages/core/src/workflows/handlers/step.ts:125-132
let suspendDataToUse = stepResults[step.id]?.status === "suspended" ? stepResults[step.id]?.suspendPayload : undefined;
if (suspendDataToUse && "__workflow_meta" in suspendDataToUse) {
  const { __workflow_meta, ...userSuspendData } = suspendDataToUse;
  suspendDataToUse = userSuspendData;
}
```

### Foreach の並行度制御とバッチ実行

`executeForeach` は配列データに対してステップを並列適用するが、concurrency パラメータでバッチサイズを制御する。バッチ内は `Promise.all` で並行実行し、バッチ間は逐次実行する。

```typescript
// packages/core/src/workflows/handlers/control-flow.ts:862-864
for (let i = 0; i < prevOutput.length; i += concurrency) {
  const items = prevOutput.slice(i, i + concurrency);
  const itemsResults = await Promise.all(
    items.map(async (item: any, j: number) => {
      // ...
    }),
  );
```

各バッチの結果に suspended が含まれる場合、そのインデックスを記録して `__workflow_meta.foreachOutput` に蓄積する。再開時にはこのメタデータを参照して、完了済みイテレーションをスキップする。

### DelayedPromise: 遅延構築による unhandled rejection 回避

`DelayedPromise` は Promise を実際にアクセスされるまで構築しない。これにより、ストリームの完了前に resolve/reject が呼ばれても unhandled promise rejection が発生しない。

```typescript
// packages/core/src/stream/aisdk/v5/compat/delayed-promise.ts:6-48
export class DelayedPromise<T> {
  public status: { type: "pending"; } | { type: "resolved"; value: T; } | { type: "rejected"; error: unknown; } = {
    type: "pending",
  };
  private _promise: Promise<T> | undefined;
  // ...
  get promise(): Promise<T> {
    if (this._promise) {
      return this._promise;
    }
    this._promise = new Promise<T>((resolve, reject) => {
      if (this.status.type === "resolved") {
        resolve(this.status.value);
      } else if (this.status.type === "rejected") {
        reject(this.status.error);
      }
      this._resolve = resolve;
      this._reject = reject;
    });
    return this._promise;
  }
}
```

`MastraModelOutput` はこの仕組みを使って `text`、`toolCalls`、`object` など多数のプロパティを遅延 Promise として公開する（`packages/core/src/stream/base/output.ts:191-211`）。

### SaveQueueManager: debounce + staleness ハイブリッド永続化

メッセージのバッチ保存で、最古の未保存メッセージが 1 秒（MAX_STALENESS_MS）を超えていれば即座に flush し、そうでなければ debounce する。スレッドごとにキューを持ち、同一スレッドの書き込みは直列化される。

```typescript
// packages/core/src/agent/save-queue/index.ts:114-124
async batchMessages(messageList: MessageList, threadId?: string, memoryConfig?: MemoryConfig) {
  if (!threadId) return;
  const earliest = messageList.getEarliestUnsavedMessageTimestamp();
  const now = Date.now();
  if (earliest && now - earliest > SaveQueueManager.MAX_STALENESS_MS) {
    return this.flushMessages(messageList, threadId, memoryConfig);
  } else {
    return this.debounceSave(threadId, messageList, memoryConfig);
  }
}
```

### AbortController の伝播パターン

ワークフロー全体で単一の `AbortController` を共有し、各ステップには `abortSignal` を渡す。ステップ内から `abort()` を呼ぶと全体がキャンセルされる。並列実行時は、いずれかのステップが失敗してもシグナル経由で他のステップをキャンセルできる。

```typescript
// packages/core/src/workflows/handlers/step.ts:368-370
abort: () => {
  abortController?.abort();
},
```

### Durable Operation ラッパー

`DefaultExecutionEngine` は `wrapDurableOperation` をフック点として提供する。デフォルト実装は単純な関数呼び出しだが、Inngest 等の外部エンジンがオーバーライドすることで、リプレイ可能な永続操作に変換できる。

```typescript
// packages/core/src/workflows/default.ts:131-133
async wrapDurableOperation<T>(_operationId: string, operationFn: () => Promise<T>): Promise<T> {
  return operationFn();
}
```

## パターンカタログ

- **Command パターン** (分類: 振る舞い)
  - 解決する問題: ワークフローステップの実行・中断・再開を統一的に扱う
  - 適用条件: 実行の中断と再開が必要な長時間処理
  - コード例: `packages/core/src/workflows/step.ts:82-100` の `ExecuteFunction` 型
  - 注意点: suspend の戻り値を branded type で制約し、型レベルで中断を強制する

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 実行エンジンの差し替え（インメモリ vs 永続化対応 vs 外部オーケストレーター）
  - 適用条件: 同一のワークフロー定義を複数の実行基盤で動かす必要がある場合
  - コード例: `packages/core/src/workflows/execution-engine.ts:51` の `ExecutionEngine` 抽象クラスと `packages/core/src/workflows/default.ts:52` の `DefaultExecutionEngine`
  - 注意点: フック点（`wrapDurableOperation`, `executeSleepDuration` 等）を細粒度で提供し、部分的なオーバーライドを許可する

- **Observer パターン** (分類: 振る舞い)
  - 解決する問題: ストリーム中のチャンクを複数のコンシューマーに配信する
  - 適用条件: 同一データソースから textStream、objectStream 等の派生ストリームを提供する場合
  - コード例: `packages/core/src/stream/base/output.ts:1387-1434` の EventEmitter + バッファリング

## Good Patterns

- **Branded Type による suspend 安全性**: `InnerOutput` は `void & { readonly [SuspendBrand]: never }` として定義され、ステップ関数の戻り値型が `Promise<TStepOutput | InnerOutput>` となる。これにより `suspend()` を呼ばずに void を返すことが型エラーになり、中断パスの漏れをコンパイル時に検出できる。

```typescript
// packages/core/src/workflows/step.ts:17-21
declare const SuspendBrand: unique symbol;
export type InnerOutput = void & { readonly [SuspendBrand]: never; };
```

- **内部メタデータの分離**: suspend payload に `__workflow_meta` を付加して実行復元に必要な情報を保持しつつ、ステップコードにはユーザーデータのみを露出する。プレフィックス `__` ではなく特定キー名で分離し、destructuring で除去する。

```typescript
// packages/core/src/workflows/handlers/step.ts:129-132
if (suspendDataToUse && "__workflow_meta" in suspendDataToUse) {
  const { __workflow_meta, ...userSuspendData } = suspendDataToUse;
  suspendDataToUse = userSuspendData;
}
```

- **安全性制約による並行度の自動降格**: tool call のうち承認が必要なものや suspend スキーマを持つものがある場合、並行度を自動的に 1 に下げる。ユーザーが並行度を明示的に指定していても安全性が優先される。

```typescript
// packages/core/src/loop/workflows/agentic-execution/index.ts:66
const sequentialExecutionRequired = hasRequireToolApproval || hasSuspendSchema || hasRequireApproval;
// ...
.foreach(toolCallStep, { concurrency: sequentialExecutionRequired ? 1 : toolCallConcurrency })
```

## Anti-Patterns / 注意点

- **ライフサイクルコールバックでのエラー握り潰し**: `invokeLifecycleCallbacks` は onFinish/onError コールバックのエラーを catch してログに記録するだけで、呼び出し元には伝播しない。これは意図的な設計（コールバックの失敗がワークフロー結果を変えるべきではない）だが、コールバック内のバグが検出しにくくなるリスクがある。

```typescript
// Bad: エラーが完全に握り潰される
// packages/core/src/workflows/execution-engine.ts:117-119
} catch (err) {
  this.logger.error('Error in onFinish callback', { error: err });
}
```

```typescript
// Better: エラーを記録しつつ、テスト環境では伝播させる
} catch (err) {
  this.logger.error('Error in onFinish callback', { error: err });
  if (process.env.NODE_ENV === 'test') throw err;
}
```

- **Promise.all での部分失敗時の継続**: 並列ステップ実行で `Promise.all` を使っているが、一つが失敗しても他は完了まで走り続ける。結果の集約時に最初の失敗を返すが、残りのステップの cleanup が保証されない。

```typescript
// packages/core/src/workflows/handlers/control-flow.ts:133-179
const results: StepResult<any, any, any, any>[] = await Promise.all(
  entry.steps.map(async (step, i) => {
    // 一つが失敗しても他は走り続ける
  }),
);
const hasFailed = results.find(result => result.status === "failed");
```

## 導出ルール

- `[MUST]` 長時間中断が想定される非同期処理では、中断と再開を第一級の概念として設計し、状態をシリアライズ可能にする
  - 根拠: mastra のワークフローは suspend 時にスナップショットを永続化し、プロセス再起動後も再開できる（`packages/core/src/workflows/handlers/entry.ts:50-84`）

- `[MUST]` 並列実行する操作に副作用の競合がある場合、並行度を自動的に 1 に降格させる仕組みを持つ
  - 根拠: tool call で承認や suspend が必要な場合、明示的な concurrency 設定よりも安全性制約が優先される（`packages/core/src/loop/workflows/agentic-execution/index.ts:66`）

- `[SHOULD]` ストリーミング結果の各プロパティは遅延構築 Promise（DelayedPromise）として公開し、アクセスされるまで Promise を構築しない
  - 根拠: 早期に resolve/reject されても unhandled rejection が発生せず、未使用プロパティのオーバーヘッドもない（`packages/core/src/stream/aisdk/v5/compat/delayed-promise.ts`）

- `[SHOULD]` 高頻度の書き込みには debounce + staleness 上限のハイブリッド戦略を適用する
  - 根拠: `SaveQueueManager` は debounce で書き込みをバッチ化しつつ、MAX_STALENESS_MS（1秒）を超えたら即座に flush する。これによりバースト時の I/O を抑えつつデータロスを防ぐ（`packages/core/src/agent/save-queue/index.ts:11,119`）

- `[SHOULD]` ワークフローの内部メタデータはユーザー向けデータと明確に分離し、ステップコードに露出させない
  - 根拠: `__workflow_meta` は suspend/resume のルーティングに必要だが、ステップ関数には除去して渡される（`packages/core/src/workflows/handlers/step.ts:129-132`）

- `[AVOID]` バッチ並列実行で `Promise.all` を使う場合に、失敗時の他タスクのキャンセル戦略を持たないこと
  - 根拠: mastra の並列ステップは AbortController を共有するが、Promise.all は一つの失敗で他を自動キャンセルしない。`Promise.allSettled` + abort signal の組み合わせや、`p-map` のようなライブラリでの並行度制御を検討すべき

## 適用チェックリスト

- [ ] 長時間中断する非同期処理（人間の承認待ち、外部 API のコールバック待ち）の状態がシリアライズ可能か確認する
- [ ] 並列実行する操作に副作用の競合（共有リソースへの書き込み、承認フロー）がないか確認し、ある場合は並行度を自動降格する仕組みを入れる
- [ ] ストリーミング API の各プロパティが、アクセスされない場合にリソースを消費しないことを確認する（DelayedPromise パターンの適用を検討）
- [ ] 高頻度の永続化処理に debounce を適用し、かつデータの鮮度上限（staleness）を設けてデータロスを防いでいるか確認する
- [ ] AbortController/AbortSignal が並行タスク全体に伝播されており、一部の失敗で残りのタスクを停止できるか確認する
- [ ] ワークフローの内部制御データ（ルーティング情報、再開メタデータ）がユーザーコードに漏洩していないか確認する
- [ ] ライフサイクルコールバックのエラーハンドリング方針を明確にする（握り潰し vs 伝播 vs 監視）
