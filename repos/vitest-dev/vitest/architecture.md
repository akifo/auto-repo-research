# architecture

> リポジトリ: vitest-dev/vitest
> 分析日: 2026-03-05

## 概要

Vitest のレイヤー構成 CLI -> Node (Vitest core) -> Pool -> PoolRunner -> Worker (Runtime) と、その間の通信パターンを分析する。テストフレームワークを「メインプロセスでオーケストレーション、ワーカープロセスで実行」という二分割にし、birpc による双方向 RPC でつなぐ設計が、拡張性・分離性・パフォーマンスの三点で優れたプラクティスを生み出している。

## 背景にある原則

- **プロセス境界による強制的な関心分離**: Node 側（設定解決・テスト発見・レポーティング・カバレッジ集約）とランタイム側（環境セットアップ・モジュール実行・テスト実行）を物理的に別プロセス/スレッドに配置する。これにより、テストコードがメインプロセスの状態を汚染できない。根拠: `packages/vitest/src/node/pool.ts` で Pool を作成し、`packages/vitest/src/runtime/worker.ts` でワーカー側の実行を完全に分離している。

- **抽象インターフェースによるプール戦略の交換可能性**: `PoolWorker` インターフェース (`packages/vitest/src/node/pools/types.ts:22-41`) が `start/stop/send/on/off/deserialize` だけを要求し、forks/threads/vmForks/vmThreads/typescript/custom をすべて同一の `PoolRunner` で扱う。実装の切り替えがコンフィグ一行で完結する。

- **メッセージパッシングによる疎結合**: Node 側とワーカー側は `WorkerRequest`/`WorkerResponse` の型付きメッセージのみでやり取りし、birpc で RPC を構成する。直接のメソッド呼び出しが存在しないため、通信経路（IPC/postMessage）の差異を吸収できる (`packages/vitest/src/node/pools/types.ts:68-108`)。

- **段階的初期化と明示的ライフサイクル管理**: PoolRunner は `IDLE -> STARTING -> STARTED -> STOPPING -> STOPPED` の状態遷移を持ち、操作ロック (`_operationLock`) で並行 start/stop を防止する (`packages/vitest/src/node/pools/poolRunner.ts:14-21`)。

## 実例と分析

### レイヤー1: CLI -> Vitest Core

CLI エントリポイントは極めて薄い。`packages/vitest/src/node/cli.ts` は3行で、cac パーサーに委譲するだけである。

```typescript
// packages/vitest/src/node/cli.ts:1-3
import { createCLI } from './cli/cac'
createCLI().parse()
```

実際のブートストラップは `startVitest()` (`packages/vitest/src/node/cli/cli-api.ts:56-62`) が担い、`createVitest()` -> `Vitest` インスタンス生成 -> Vite サーバー起動 -> `ctx.start()` の順で進む。この分離により、CLI を経由しないプログラマティック利用（`startVitest()` 直接呼び出し）が容易になっている。

### レイヤー2: Vitest Core -> Pool

`Vitest.start()` はテストスペック収集後、`createPool(ctx)` (`packages/vitest/src/node/pool.ts:54`) で `Pool` インスタンスを生成し、`pool.runTests(specs)` を呼ぶ。

Pool 内部では `groupSpecs()` がテストファイルを environment/project/sequenceOrder でグループ化し、各グループを `maxWorkers` の並列度で実行する。この grouping ロジックが、環境の異なるテスト（jsdom vs node vs happy-dom）を別バッチで走らせることを可能にしている。

### レイヤー3: Pool -> PoolRunner -> PoolWorker

`Pool` クラス (`packages/vitest/src/node/pools/pool.ts:31`) はワーカーキューを管理する。`pool.run(task)` が呼ばれると:

1. `getPoolRunner(task)` で適切な PoolWorker を選択（switch 文で `forks/threads/vmForks/vmThreads/typescript` を分岐）
2. `PoolRunner` を生成し、PoolWorker をラップ
3. `runner.start()` -> `runner.request('run', context)` -> ワーカー側で実行
4. `testfileFinished` メッセージを受信して resolve

非分離モード (`isolate: false`) では `sharedRunners` に PoolRunner を保持し、同一環境のテストを再利用する最適化が入っている (`packages/vitest/src/node/pools/pool.ts:149-157`)。

### レイヤー4: Worker Runtime

ワーカー側のエントリポイントは transport に応じて異なる:
- `threads.ts`: `worker_threads` の `parentPort` 経由
- `forks.ts`: `child_process` の `process.send` 経由

いずれも `init()` (`packages/vitest/src/runtime/workers/init.ts:22`) を呼び、メッセージハンドラを登録する。`init()` は `start/run/collect/stop` の4つのメッセージタイプを処理する状態マシンとして機能する。

### レイヤー5: TestRunner (実行エンジン)

`@vitest/runner` パッケージの `startTests()` / `collectTests()` がテストの実際の実行を担う。`runBaseTests()` (`packages/vitest/src/runtime/runBaseTests.ts:22-92`) が環境セットアップ済みの状態で `resolveTestRunner()` -> `startTests()` を呼ぶ。

`resolveTestRunner()` (`packages/vitest/src/runtime/runners/index.ts:32-156`) は `TestRunner` インスタンスを生成し、`onTaskUpdate` / `onCollected` / `onAfterRunFiles` 等のライフサイクルフックを RPC 呼び出しで装飾（パッチ）する。カスタムランナーが RPC を意識せずに済むよう、フレームワークがフックを自動的にラップしている。

### RPC 通信の設計

birpc を使い、Node 側は `RuntimeRPC` インターフェース (`packages/vitest/src/types/rpc.ts:7-33`) を公開し、ワーカー側は `RunnerRPC` (`onCancel` のみ) を公開する。非対称な RPC 設計で、情報の流れを「ワーカー -> ノード」方向に制約している。

ワーカー側の RPC は `createSafeRpc()` (`packages/vitest/src/runtime/rpc.ts:94-118`) で Proxy ラップされ、全呼び出しが `withSafeTimers()` を経由する。これはテストが `setTimeout` 等をモックした場合でも RPC 通信が壊れないようにする防御策である。

## コード例

```typescript
// packages/vitest/src/node/pools/pool.ts:239-254
// PoolWorker の選択 - Strategy パターンの switch 実装
switch (task.worker) {
  case 'forks':
    return new PoolRunner(options, new ForksPoolWorker(options))
  case 'vmForks':
    return new PoolRunner(options, new VmForksPoolWorker(options))
  case 'threads':
    return new PoolRunner(options, new ThreadsPoolWorker(options))
  case 'vmThreads':
    return new PoolRunner(options, new VmThreadsPoolWorker(options))
  case 'typescript':
    return new PoolRunner(options, new TypecheckPoolWorker(options))
}
```

```typescript
// packages/vitest/src/node/pools/poolRunner.ts:14-21
// PoolRunner のライフサイクル状態
enum RunnerState {
  IDLE = 'idle',
  STARTING = 'starting',
  STARTED = 'started',
  START_FAILURE = 'start_failure',
  STOPPING = 'stopping',
  STOPPED = 'stopped',
}
```

```typescript
// packages/vitest/src/runtime/rpc.ts:94-118
// Safe RPC Proxy - テストのモック環境から RPC を保護
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

```typescript
// packages/vitest/src/runtime/workers/init-forks.ts:9-14
// テストによるグローバル汚染からプロセス関数を保護
const processExit = process.exit.bind(process)
const processSend = process.send.bind(process)
const processOn = process.on.bind(process)
const processOff = process.off.bind(process)
const processRemoveAllListeners = process.removeAllListeners.bind(process)
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 複数のワーカー実行戦略（threads/forks/vmThreads/vmForks）を統一的に扱う
  - 適用条件: 実行時にアルゴリズムを切り替える必要がある場合
  - コード例: `packages/vitest/src/node/pools/pool.ts:239-261` の switch + `PoolWorker` インターフェース
  - 注意点: switch 文は GoF の典型実装とは異なるが、`PoolWorker` インターフェースが Strategy の役割を果たしている。カスタムプールも `PoolRunnerInitializer` で拡張可能。

- **Mediator パターン** (分類: 振る舞い)
  - 解決する問題: PoolRunner が Node 側とワーカー側の通信を仲介し、双方が直接依存しない
  - 適用条件: 複数のコンポーネント間の通信を集約したい場合
  - コード例: `packages/vitest/src/node/pools/poolRunner.ts:42-412`
  - 注意点: PoolRunner は EventEmitter を内包し、メッセージの振り分け・状態管理・RPC 生成を一手に担う

- **Decorator パターン** (分類: 構造)
  - 解決する問題: カスタムランナーが RPC を意識せずに済むよう、フックを自動的にラップする
  - 適用条件: 既存オブジェクトの振る舞いを透過的に拡張したい場合
  - コード例: `packages/vitest/src/runtime/runners/index.ts:66-153` で `onTaskUpdate` 等をパッチ
  - 注意点: Proxy ではなく直接メソッド上書きなので、原本のメソッドは `original*` 変数に退避する必要がある

## Good Patterns

- **Safe Timers による RPC 保護**: テストが `setTimeout/setImmediate` をモックしても、フレームワークの RPC 通信は `getSafeTimers()` で取得した本物のタイマーを使う。テストコードとフレームワークコードの実行コンテキストを分離する汎用テクニック。

```typescript
// packages/vitest/src/runtime/rpc.ts:11-52
function withSafeTimers(fn: () => void) {
  const { setTimeout, clearTimeout, nextTick, setImmediate, clearImmediate }
    = getSafeTimers()
  // ... グローバルを一時退避・復元
}
```

- **グローバル関数の事前バインド**: ワーカー初期化時に `process.exit.bind(process)` 等を変数に保存し、テストが `process.exit` を上書きしてもワーカーの制御フローが壊れない。

```typescript
// packages/vitest/src/runtime/workers/init-forks.ts:9-14
const processExit = process.exit.bind(process)
const processSend = process.send.bind(process)
```

- **操作ロックによる状態遷移の保護**: PoolRunner の `start()` / `stop()` は `_operationLock` (DeferPromise) を使い、同時呼び出しを直列化する。非同期ライフサイクル管理で競合状態を防ぐ実践的なパターン。

```typescript
// packages/vitest/src/node/pools/poolRunner.ts:166-181
async start(options: { workerId: number }): Promise<void> {
  if (this._operationLock) {
    await this._operationLock
  }
  // ...
  this._operationLock = createDefer()
```

- **型付きメッセージプロトコル**: `WorkerRequest` / `WorkerResponse` をタグ付きユニオンで定義し、`__vitest_worker_request__: true` / `__vitest_worker_response__: true` フラグで自プロトコルのメッセージを識別する。

```typescript
// packages/vitest/src/node/pools/types.ts:68-108
export type WorkerRequest
  = { __vitest_worker_request__: true } & (
    | { type: 'start'; ... }
    | { type: 'stop'; ... }
    | { type: 'run'; ... }
    | { type: 'collect'; ... }
  )
```

## Anti-Patterns / 注意点

- **ホットパスでの switch によるワーカー選択**: `getPoolRunner()` は switch 文で5つの組み込みプールを分岐している。プール数が増えると保守コストが上がる。ただし、カスタムプールは `PoolRunnerInitializer` インターフェースで対応済みなので、現状は実用上問題ない。

Bad (仮に全てを switch で処理する場合):
```typescript
switch (task.worker) {
  case 'forks': ...
  case 'threads': ...
  case 'customA': ...
  case 'customB': ...
  // 無限に増える
}
```

Better (実際の実装 - 組み込み以外は Registry パターンへ):
```typescript
// packages/vitest/src/node/pools/pool.ts:256-261
const customPool = task.project.config.poolRunner
if (customPool != null && customPool.name === task.worker) {
  return new PoolRunner(options, customPool.createPoolWorker(options))
}
```

- **メソッドパッチによるフック装飾**: `resolveTestRunner()` で `testRunner.onTaskUpdate` を直接上書きしている。これはカスタムランナーが同じフックを上書きした場合に順序依存になりうる。Proxy や EventEmitter ベースの方が安全だが、パフォーマンスとのトレードオフ。

Bad:
```typescript
// フック上書きの連鎖が追跡困難
testRunner.onTaskUpdate = async (task, events) => {
  const p = rpc().onTaskUpdate(task, events)
  await originalOnTaskUpdate?.call(testRunner, task, events)
  return p
}
```

Better (概念的):
```typescript
// イベントベースで順序を明示
testRunner.on('taskUpdate', (task, events) => rpc().onTaskUpdate(task, events))
testRunner.on('taskUpdate', (task, events) => originalHandler(task, events))
```

## 導出ルール

- `[MUST]` メインプロセスとワーカープロセスの境界には型付きメッセージプロトコル（タグ付きユニオン + 識別フラグ）を定義する
  - 根拠: Vitest は `WorkerRequest` / `WorkerResponse` に `__vitest_worker_request__` フラグを付与し、birpc メッセージと自プロトコルメッセージを安全に区別している (`packages/vitest/src/node/pools/types.ts:68-108`)

- `[MUST]` テストコードが上書きしうるグローバル関数（タイマー、`process.exit` 等）は、フレームワーク初期化時に bind で事前キャプチャする
  - 根拠: `init-forks.ts:9-14` で `process.exit/send/on/off` を事前保存し、`rpc.ts` で `withSafeTimers()` を経由させることで、テストのモック環境からフレームワーク通信を保護している

- `[SHOULD]` マルチプロセスアーキテクチャでは、ワーカーのライフサイクルを明示的な状態マシン（IDLE/STARTING/STARTED/STOPPING/STOPPED）で管理し、操作ロックで並行遷移を防止する
  - 根拠: `PoolRunner` は `RunnerState` enum と `_operationLock` で start/stop の競合を排除している (`packages/vitest/src/node/pools/poolRunner.ts:14-21, 166-243`)

- `[SHOULD]` 実行戦略が複数ある場合は、共通インターフェースを定義し Strategy パターンで切り替える。組み込み戦略は switch/factory で、カスタム戦略は Registry パターンで拡張できるようにする
  - 根拠: `PoolWorker` インターフェースが forks/threads/vm 系を統一し、カスタムプールは `PoolRunnerInitializer` で拡張可能 (`packages/vitest/src/node/pools/types.ts:7-10, 22-41`)

- `[SHOULD]` CLI エントリポイントは薄く保ち、コア機能はプログラマティック API として独立させる
  - 根拠: `cli.ts` は3行でパーサーに委譲し、`startVitest()` / `createVitest()` が独立した API として利用可能 (`packages/vitest/src/node/cli.ts`, `packages/vitest/src/node/cli/cli-api.ts:56`)

- `[AVOID]` ワーカープロセス内でメインプロセスの状態に直接アクセスする設計。RPC 経由で必要なデータのみ受け渡す
  - 根拠: `RuntimeRPC` は `fetch/resolve/transform` 等の必要最小限のメソッドのみを公開し、ワーカーがメインプロセスの内部状態（Vite サーバー、ファイルシステムキャッシュ等）に直接触れない設計になっている (`packages/vitest/src/types/rpc.ts:7-33`)

## 適用チェックリスト

- [ ] メインプロセスとワーカー間の通信にタグ付きユニオン型のメッセージプロトコルを定義しているか
- [ ] ワーカーのライフサイクル（初期化・実行・停止）が明示的な状態遷移として管理されているか
- [ ] テストコードやプラグインが上書きしうるグローバルを事前にキャプチャしているか
- [ ] CLI と API が分離されており、プログラマティック利用が可能か
- [ ] ワーカー実行戦略（threads/forks/custom）が共通インターフェースで交換可能か
- [ ] RPC の非対称設計（ワーカー -> メインへの情報フローの制約）が意図的に行われているか
- [ ] 非分離モード（isolate: false）でのワーカー再利用条件が明確に定義されているか
