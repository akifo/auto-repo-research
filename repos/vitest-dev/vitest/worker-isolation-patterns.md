# worker-isolation-patterns

> リポジトリ: vitest-dev/vitest
> 分析日: 2026-03-05

## 概要

Vitest のワーカー分離アーキテクチャを分析し、テスト並列化における「プロセス/スレッド分離」「VM コンテキスト分離」「非分離モードでのワーカー再利用」の設計パターンを抽出する。Vitest は Node.js の `worker_threads`・`child_process`・`vm` モジュールを組み合わせ、分離レベルの異なる 5 種類のプール（threads, forks, vmThreads, vmForks, typescript）を同一インターフェースで提供している。この多層分離戦略と、birpc による双方向 RPC 通信の設計は、並列処理を伴う任意のタスクランナーに応用可能である。

## 背景にある原則

- **分離レベルをユーザーが選択できるようにする**: テスト間の状態汚染を完全に防ぐ `isolate: true`（デフォルト）から、パフォーマンス優先の `isolate: false`（ワーカー再利用）まで段階的に選べる設計。トレードオフの判断をフレームワーク側で固定せずユーザーに委ねることで、多様なプロジェクト規模に対応する（`packages/vitest/src/node/pools/pool.ts:149-157`）。

- **通信層とワーカー実装を分離する**: `PoolWorker` インターフェースが `send`/`on`/`off`/`start`/`stop`/`deserialize` の 6 メソッドだけを要求し、通信の物理層（IPC・postMessage・インプロセス）を抽象化する。これにより `PoolRunner` は通信手段を知らずに状態管理・ライフサイクル制御・RPC 設定を担える（`packages/vitest/src/node/pools/types.ts:22-41`）。

- **メッセージプロトコルを型安全な判別可能ユニオンで定義する**: `WorkerRequest` と `WorkerResponse` を `__vitest_worker_request__` / `__vitest_worker_response__` のブランドフィールドと `type` フィールドの判別可能ユニオンで定義する。RPC メッセージとワーカー制御メッセージを同一チャネルで安全に分離できる（`packages/vitest/src/node/pools/types.ts:68-108`）。

- **グレースフル停止とフォースキルを2段階で設計する**: 通常の停止は `stop` メッセージを送り応答を待つ。ユーザーが CTRL+C を2回押した場合は `force: true` で応答を待たずに即座にプロセスを終了する。forks プールでは SIGTERM → 500ms 後に SIGKILL のエスカレーションパターンを採用する（`packages/vitest/src/node/pools/workers/forksWorker.ts:74-87`）。

## 実例と分析

### プール実装のストラテジーパターン

5 種類のワーカープールは `PoolWorker` インターフェースを共有し、`Pool.getPoolRunner()` 内の `switch` 文で選択される。各実装は Node.js の異なる分離メカニズムを使う:

| プール | 分離単位 | Node.js API | 特徴 |
|--------|----------|-------------|------|
| threads | worker_thread | `Worker` | 軽量、メモリ共有可能 |
| forks | child_process | `fork()` | 完全プロセス分離、`serialization: 'advanced'` |
| vmThreads | worker_thread + vm | `Worker` + `vm.createContext` | スレッド内 VM 分離 |
| vmForks | child_process + vm | `fork()` + `vm.createContext` | プロセス内 VM 分離 |
| typescript | インプロセス | EventEmitter | 型検査専用、分離不要 |

VM 系プールは基底クラス（`ThreadsPoolWorker` / `ForksPoolWorker`）を継承し、`--experimental-vm-modules` フラグの追加とエントリポイントの差し替えだけで実装される。

### 非分離モードでのワーカー再利用

`pool.ts:149-157` で、テスト完了後にワーカーを即座に終了させず `sharedRunners` 配列に退避する。次のタスクが同じプール・プロジェクト・環境であれば再利用する:

```typescript
// packages/vitest/src/node/pools/pool.ts:149-157
if (
  !task.isolate
  && !isMemoryLimitReached
  && this.queue[0]?.task.isolate === false
  && isEqualRunner(runner, this.queue[0].task)
) {
  this.sharedRunners.push(runner)
  return this.schedule()
}
```

再利用の判定は `isEqualRunner()` 関数が担う。通常のプール（threads/forks）は環境名とオプションの完全一致を要求するが、VM 系プールは `canReuse()` が常に `true` を返す。VM コンテキストが各テストファイルごとに作り直されるため、ワーカープロセス自体の再利用が安全に行える。

### PoolRunner の状態マシン

`PoolRunner` は `RunnerState` enum で 6 状態を管理する:

```typescript
// packages/vitest/src/node/pools/poolRunner.ts:14-21
enum RunnerState {
  IDLE = 'idle',
  STARTING = 'starting',
  STARTED = 'started',
  START_FAILURE = 'start_failure',
  STOPPING = 'stopping',
  STOPPED = 'stopped',
}
```

`_operationLock` による排他制御で `start` と `stop` の同時呼び出しを防ぐ。これは `DeferPromise`（resolve/reject を外部から呼べる Promise）をロックとして使う軽量パターンである。

### birpc による双方向 RPC

メインスレッドとワーカー間の通信は `birpc` ライブラリで双方向 RPC 化されている。メインスレッド側は `RuntimeRPC`（fetch, resolve, onCollected 等 15 メソッド）を公開し、ワーカー側は `RunnerRPC`（onCancel のみ）を公開する。

```typescript
// packages/vitest/src/node/pools/poolRunner.ts:97-112
this._rpc = createBirpc<RunnerRPC, RuntimeRPC>(
  createMethodsRPC(this.project, {
    collect: options.method === 'collect',
    cacheFs: worker.cacheFs,
  }),
  {
    eventNames: ['onCancel'],
    post: (request) => {
      if (this._state !== RunnerState.STOPPING && this._state !== RunnerState.STOPPED) {
        this.postMessage(request)
      }
    },
    on: callback => this._eventEmitter.on('rpc', callback),
    timeout: -1,
  },
)
```

ワーカー側では `createSafeRpc()` が全 RPC 呼び出しを `withSafeTimers()` でラップし、テストコードが `setTimeout` 等をモックしても RPC 通信が壊れないようにしている。

### テスト順序の最適化

`BaseSequencer.sort()` は以下の優先順位でテストファイルをソートする:

1. `sequence.groupOrder` の昇順（グループ間順序制御）
2. プロジェクト名の辞書順（プロジェクト間分離）
3. `isolate: true` を先に実行（分離テストを優先）
4. 過去にファイル統計がないもの（未知のファイル）を先に実行
5. 過去に失敗したテストを先に実行
6. 実行時間が長いテストを先に実行

この「失敗優先・長時間優先」の戦略は、CI フィードバックループの最小化に寄与する。

### メモリ制限によるワーカーリサイクル

VM 系プールでは `memoryLimit` 設定によりワーカーのヒープ使用量を監視する。テスト完了時に `usedMemory` を報告し、制限に達した場合はワーカーを再利用せず終了させる:

```typescript
// packages/vitest/src/node/pools/pool.ts:94-98
const onFinished = (message: WorkerResponse) => {
  if (message?.__vitest_worker_response__ && message.type === 'testfileFinished') {
    if (task.memoryLimit && message.usedMemory) {
      isMemoryLimitReached = message.usedMemory >= task.memoryLimit
    }
```

デフォルトのメモリ制限は `1 / maxWorkers`（総メモリの割合）で自動計算される。

## コード例

```typescript
// packages/vitest/src/node/pools/workers/forksWorker.ts:74-87
// SIGTERM → SIGKILL エスカレーションパターン
const sigkillTimeout = setTimeout(
  () => fork.kill('SIGKILL'),
  SIGKILL_TIMEOUT,
)
fork.kill()
await waitForExit
clearTimeout(sigkillTimeout)
```

```typescript
// packages/vitest/src/runtime/workers/init-forks.ts:9-13
// テストコードによるグローバル上書きからの防御
const processExit = process.exit.bind(process)
const processSend = process.send.bind(process)
const processOn = process.on.bind(process)
const processOff = process.off.bind(process)
const processRemoveAllListeners = process.removeAllListeners.bind(process)
```

```typescript
// packages/vitest/src/runtime/rpc.ts:94-117
// RPC をフェイクタイマーから保護する Proxy パターン
export function createSafeRpc(rpc: WorkerRPC): WorkerRPC {
  return new Proxy(rpc, {
    get(target, p, handler) {
      if (p === '$rejectPendingCalls') {
        return rpc.$rejectPendingCalls
      }
      const sendCall = get(target, p, handler)
      const safeSendCall = (...args: any[]) =>
        withSafeTimers(async () => {
          const result = sendCall(...args)
          promises.add(result)
          try {
            return await result
          }
          finally {
            promises.delete(result)
          }
        })
      safeSendCall.asEvent = sendCall.asEvent
      return safeSendCall
    },
  })
}
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 異なる分離メカニズム（threads/forks/vm）を統一的に扱う
  - 適用条件: 同一タスクに対して複数の実行戦略が存在する場合
  - コード例: `packages/vitest/src/node/pools/pool.ts:239-254`（`getPoolRunner` の switch 文）、`packages/vitest/src/node/pools/types.ts:22-41`（`PoolWorker` インターフェース）
  - 注意点: VM 系プールは基底クラスの継承で実装されており、Strategy + Template Method の組み合わせになっている

- **State パターン** (分類: 振る舞い)
  - 解決する問題: ワーカーのライフサイクル（IDLE→STARTING→STARTED→STOPPING→STOPPED）を安全に管理する
  - 適用条件: 非同期操作のライフサイクルに複数の遷移状態がある場合
  - コード例: `packages/vitest/src/node/pools/poolRunner.ts:14-21`（`RunnerState` enum）
  - 注意点: `_operationLock` による排他制御が必須。start/stop の同時呼び出しはデッドロックの原因になる

- **Object Pool パターン** (分類: 生成)
  - 解決する問題: ワーカープロセスの生成コストを削減する
  - 適用条件: `isolate: false` かつメモリ制限未到達の場合のみ再利用
  - コード例: `packages/vitest/src/node/pools/pool.ts:149-157`（`sharedRunners` への退避と再利用）
  - 注意点: 再利用可能かの判定（`canReuse` / `isEqualRunner`）を誤ると状態汚染が発生する

## Good Patterns

- **ブランドフィールドによるメッセージ分離**: `__vitest_worker_request__` / `__vitest_worker_response__` というブランドフィールドで RPC メッセージとワーカー制御メッセージを同一チャネル上で安全に区別する。判別可能ユニオンの `type` フィールドと組み合わせることで、型安全なメッセージルーティングが実現される。

```typescript
// packages/vitest/src/node/pools/poolRunner.ts:353-367
private emitWorkerMessage = (response: WorkerResponse | { m: string; __vitest_worker_response__: false }): void => {
  const message = this.worker.deserialize(response) as WorkerResponse
  if (typeof message === 'object' && message != null && message.__vitest_worker_response__) {
    this._eventEmitter.emit('message', message)
  } else {
    this._eventEmitter.emit('rpc', message)
  }
}
```

- **ネイティブ API の事前バインド**: フォークプロセスのワーカー初期化時に `process.exit.bind(process)` 等でネイティブ関数を保存する。テストコードがグローバルを上書きしてもワーカー基盤の動作が壊れない。

```typescript
// packages/vitest/src/runtime/workers/init-forks.ts:10-14
const processExit = process.exit.bind(process)
const processSend = process.send.bind(process)
const processOn = process.on.bind(process)
```

- **IPC チャネル閉鎖への防御的ハンドリング**: `ERR_IPC_CHANNEL_CLOSED` / `EPIPE` エラーを検知して即座にプロセスを終了させることで、メインスレッド切断後のエラーループを防止する。

```typescript
// packages/vitest/src/runtime/workers/init-forks.ts:62-66
function onError(error: any) {
  if (error?.code === 'ERR_IPC_CHANNEL_CLOSED' || error?.code === 'EPIPE') {
    processExit(1)
  }
}
```

## Anti-Patterns / 注意点

- **ワーカー再利用時の環境不一致**: 非分離モードでワーカーを再利用する際、環境（jsdom, happy-dom 等）やその設定が異なるテストファイルに同じワーカーを使うと状態汚染が発生する。Vitest は `isEqualRunner()` で環境名とオプションの完全一致を検証しているが、カスタムプール実装では見落としやすい。

```typescript
// Bad: 環境チェックなしの再利用
canReuse() { return true }  // VM プール以外で使うと危険

// Better: 環境の等価性を検証する
canReuse(task: PoolTask) {
  return isEnvironmentEqual(task.context.environment, this.currentEnvironment)
}
```

- **グローバル Timer モックの伝播**: テストコードが `vi.useFakeTimers()` でタイマーをモックすると、RPC 通信の内部タイマーも影響を受ける。Vitest は `withSafeTimers()` で元のタイマーを一時的に復元して RPC 呼び出しを行うが、この防御を忘れるとワーカーがハングアップする。

```typescript
// Bad: モック影響下でタイマー依存の通信を行う
await rpc.someMethod()  // fakeTimers が有効だと setTimeout が動かない

// Better: ネイティブタイマーを復元してから呼び出す
withSafeTimers(async () => {
  await rpc.someMethod()
})
```

## 導出ルール

- `[MUST]` ワーカープロセスとの通信チャネルでは、制御メッセージと業務メッセージをブランドフィールド（`__brand__: true`）で型安全に分離する
  - 根拠: Vitest は `__vitest_worker_request__` / `__vitest_worker_response__` で RPC とワーカーライフサイクルメッセージを同一チャネル上で安全に区別している（`poolRunner.ts:353-367`）

- `[MUST]` ワーカー内でテストコードが上書き可能なグローバル（`process.exit`, `setTimeout` 等）は、初期化時にバインドして保存する
  - 根拠: forks ワーカーは `process.exit.bind(process)` 等を起動直後に保存し、テストコードによるグローバル汚染からワーカー基盤を防御している（`init-forks.ts:10-14`）

- `[SHOULD]` ワーカーの停止処理はグレースフル停止（メッセージ応答待ち）→ タイムアウト → フォースキル（SIGKILL）の 2-3 段階で設計する
  - 根拠: forks プールは SIGTERM → 500ms 後 SIGKILL のエスカレーションを実装し、同期ブロッキング等でハングしたプロセスにも対応している（`forksWorker.ts:74-87`）

- `[SHOULD]` ワーカープールの再利用判定には、タスクの実行コンテキスト（環境名・設定・プロジェクト）の等価性チェックを必ず含める
  - 根拠: `isEqualRunner()` が環境名・オプションの深い比較を行い、VM プールのみ `canReuse()` で判定をオーバーライドしている（`pool.ts:308-321`）

- `[SHOULD]` テスト実行順序は「失敗優先・長時間優先」でソートし、CI フィードバックループを最小化する
  - 根拠: `BaseSequencer.sort()` が過去の実行結果キャッシュを参照し、失敗テスト → 長時間テスト → 未知テストの順で並べ替えている（`BaseSequencer.ts:35-87`）

- `[AVOID]` IPC チャネル閉鎖後にメッセージ送信を試みる実装。`ERR_IPC_CHANNEL_CLOSED` がエラーハンドラ内で再度送信を試み、無限ループに陥る
  - 根拠: forks ワーカーは `ERR_IPC_CHANNEL_CLOSED` / `EPIPE` を検知して即座に `process.exit(1)` する防御コードを持つ（`init-forks.ts:62-66`）

## 適用チェックリスト

- [ ] ワーカーとの通信プロトコルに判別可能ユニオン + ブランドフィールドを使い、制御メッセージと業務メッセージを型安全に分離しているか
- [ ] ワーカー内で使うネイティブ API（タイマー、IPC 送信、プロセス終了等）を初期化時にバインドして保存しているか
- [ ] ワーカーの停止処理にグレースフル停止とフォースキルの段階的エスカレーションがあるか
- [ ] ワーカー再利用時に実行コンテキストの等価性（環境、設定、状態）を検証しているか
- [ ] テスト順序の最適化（失敗優先、長時間優先）によって CI フィードバックを高速化しているか
- [ ] IPC チャネル閉鎖時の無限ループ防止策があるか
- [ ] フェイクタイマー等のグローバルモックがワーカー基盤の通信を破壊しない防御機構があるか
