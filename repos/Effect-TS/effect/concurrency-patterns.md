# concurrency-patterns

> リポジトリ: Effect-TS/effect
> 分析日: 2026-02-18

## 概要

Effect-TS における並行処理パターンを分析する。Fiber（軽量スレッド）、Scope（リソースライフサイクル管理）、構造的並行処理（Structured Concurrency）、キャンセレーション（Interruption）、リソース安全性の設計を横断的に調査した。Effect-TS は ZIO の設計思想を TypeScript に移植したライブラリであり、単一スレッドの JS ランタイム上で構造的並行処理・リソース安全性・型レベルでの依存追跡を実現している点が注目に値する。特に、Fiber の親子関係による自動キャンセレーション、Scope による RAII パターン、uninterruptible mask による割り込み安全なリソース確保の三位一体設計が際立つ。

## 背景にある原則

- **構造的並行処理（Structured Concurrency）の徹底**: 並行タスクの寿命は親タスクの寿命に束縛されるべき。Effect-TS では `fork` で生成された子 Fiber は親の FiberScope に自動登録され、親 Fiber の終了時に子 Fiber が interrupt される（`fiberScope.ts:43-58`）。これにより fire-and-forget なタスクリークが構造的に防止される。Daemon Fiber（`forkDaemon`）は意図的にこの束縛を解除する明示的なオプトアウトとして設計されている。

- **割り込み安全性（Interruption Safety）をデフォルトに**: リソースの acquire/release 間で割り込みが発生するとリソースリークが起きる。Effect-TS は `acquireRelease` を `core.uninterruptible` でラップし、acquire 完了→finalizer 登録までを不可分操作にすることでリソースリークを防ぐ（`fiberRuntime.ts:1682-1685`）。「安全でないものをデフォルトにして安全性をオプトインさせる」のではなく、「安全なものをデフォルトにして危険性をオプトアウトさせる」設計思想。

- **並行度は関心の分離で制御する**: 並行度の指定を個別の API に埋め込まず、`Concurrency` 型（`"unbounded" | "inherit" | number`）として抽象化し、`concurrency.match` で統一的にディスパッチする（`internal/concurrency.ts:6-30`）。これにより `forEach`, `mergeAll`, `partition` 等の並行コンビネータが Sequential / Parallel / ParallelN の 3 戦略を統一インターフェースで切り替えられる。

- **Scope = リソースのライフサイクル境界**: Scope はファイナライザの集合を管理するコンテナであり、close 時にすべてのファイナライザを実行する。子 Scope を fork できる木構造になっており、親 Scope の close は子 Scope を再帰的に close する（`fiberRuntime.ts:3213-3230`）。これは RAII パターンを関数型の文脈で一般化したもの。

## 実例と分析

### Fiber の親子関係と FiberScope

Fiber のフォーク時、子 Fiber は親の FiberScope に自動登録される。`unsafeMakeChildFiber` で親の scope を取得し、`parentScope.add()` で子を登録する:

```typescript
// packages/effect/src/internal/fiberRuntime.ts:2476-2481
const parentScope = overrideScope !== null ? overrideScope : pipe(
  parentFiber.getFiberRef(core.currentForkScopeOverride),
  Option.getOrElse(() => parentFiber.scope())
)
parentScope.add(parentRuntimeFlags, childFiber)
```

Local FiberScope の `add` メソッドでは、子 Fiber を親の children セットに追加し、子の完了を observer で監視して自動除去する:

```typescript
// packages/effect/src/internal/fiberScope.ts:50-58
add(_runtimeFlags: RuntimeFlags.RuntimeFlags, child: FiberRuntime.FiberRuntime<any, any>): void {
  this.parent.tell(
    FiberMessage.stateful((parentFiber) => {
      parentFiber.addChild(child)
      child.addObserver(() => {
        parentFiber.removeChild(child)
      })
    })
  )
}
```

親 Fiber が exit する際、`evaluateEffect` 内で `interruptAllChildren()` を呼び、すべての子 Fiber に interrupt signal を送信する（`fiberRuntime.ts:962-963`）。これが構造的並行処理の要。

### fork のバリエーションによるスコープ制御

Effect-TS は Fiber のスコープを制御するために 4 つの fork バリエーションを提供する:

| API | スコープ | 用途 |
|-----|---------|------|
| `fork` | 親 Fiber | 通常の子タスク |
| `forkDaemon` | グローバルスコープ | バックグラウンドサービス |
| `forkScoped` | 現在の Scope | スコープ寿命に紐づくタスク |
| `forkIn` | 指定 Scope | 任意スコープへの移植 |

`forkDaemon` は `forkWithScopeOverride(self, fiberScope.globalScope)` のエイリアスで、Global FiberScope は子 Fiber の完了を observer で監視するだけで interrupt しない（`fiberScope.ts:30-39`）。

`forkIn` は指定 Scope のファイナライザとして子 Fiber の interrupt を登録し、かつ子 Fiber の完了時にファイナライザを除去する双方向バインディングを実装している（`circular.ts:384-396`）。

### uninterruptibleMask による割り込みの精密制御

`acquireRelease` の実装は、acquire を uninterruptible にしつつ、使用部分は interruptible にする mask パターンを使う:

```typescript
// packages/effect/src/internal/fiberRuntime.ts:1682-1685
(acquire, release) =>
  core.uninterruptible(
    core.tap(acquire, (a) => addFinalizer((exit) => release(a, exit)))
  )
```

Semaphore の `withPermits` も同様のパターンで、permit の取得をキャンセル可能にしつつ、取得後の release を確実にする:

```typescript
// packages/effect/src/internal/effect/circular.ts:100-106
readonly withPermits = (n: number) => <A, E, R>(self: Effect.Effect<A, E, R>) =>
  core.uninterruptibleMask((restore) =>
    core.flatMap(
      restore(this.take(n)),
      (permits) => fiberRuntime.ensuring(restore(self), this.release(permits))
    )
  )
```

`restore` 関数が mask パターンの核心であり、「全体は uninterruptible だが、指定した部分だけ interruptible に戻す」という精密制御を可能にする。

### 並行コンビネータの統一設計

`forEach` は `concurrency` オプションに応じて内部で分岐する。`forEachConcurrentDiscard` は並行実行の核となる関数で、以下の戦略をとる:

1. 親 Fiber から `transplant` でスコープを隔離
2. 子 Fiber を `globalScope` にフォークし、手動で join する
3. いずれかの子が失敗したら他の全子に interrupt signal を送信（fail-fast）
4. 成功完了時は `joinOrder` に基づいて `inheritAll` を順次実行

```typescript
// packages/effect/src/internal/fiberRuntime.ts:2206-2211
const interruptAll = () =>
  fibers.forEach((fiber) => {
    fiber.currentScheduler.scheduleTask(() => {
      fiber.unsafeInterruptAsFork(parent.id())
    }, 0)
  })
```

失敗時の interrupt はスケジューラに委ねることで、現在の実行フローをブロックせず非同期に中断を伝播させている。

### FiberHandle / FiberMap / FiberSet — Fiber コレクション管理

Effect-TS は Fiber の動的管理のために 3 種の構造を提供する。すべてが共通パターンに従う:

1. `acquireRelease` で作成し、Scope に紐づける
2. Fiber 追加時に observer を登録し、完了時に自動除去
3. Scope close 時にすべての所属 Fiber を interrupt
4. 外部からの Fiber エラーは Deferred 経由で伝搬

```typescript
// packages/effect/src/FiberSet.ts:117-130
export const make = <A = unknown, E = unknown>(): Effect.Effect<FiberSet<A, E>, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.map(Deferred.make<void, unknown>(), (deferred) => unsafeMake(new Set(), deferred)),
    (set) =>
      Effect.withFiberRuntime((parent) => {
        const state = set.state
        if (state._tag === "Closed") return Effect.void
        set.state = { _tag: "Closed" }
        const fibers = state.backing
        return Fiber.interruptAllAs(fibers, FiberId.combine(parent.id(), internalFiberId)).pipe(
          Effect.intoDeferred(set.deferred)
        )
      })
  )
```

FiberHandle は「常に最大 1 つの Fiber」を持つ特殊ケースで、新しい Fiber を `run` すると前の Fiber を自動 interrupt する。

### Race パターンと MutableRef による競合制御

`race` は 2 つの Fiber をフォークし、先に完了した方の結果を使い、負けた方を interrupt する。競合状態の制御に `MutableRef<boolean>` を CAS（Compare And Swap）的に使用する:

```typescript
// packages/effect/src/internal/fiberRuntime.ts:3662-3671
const completeRace = <A2, A3, E2, E3, R, R1, R2, R3>(
  winner: Fiber.RuntimeFiber<any, any>,
  loser: Fiber.RuntimeFiber<any, any>,
  cont: (...) => Effect.Effect<any, any, any>,
  ab: MRef.MutableRef<boolean>,
  cb: (_: Effect.Effect<...>) => void
): void => {
  if (MRef.compareAndSet(true, false)(ab)) {
    cb(cont(winner, loser))
  }
}
```

単一スレッド環境でも observer のコールバックが複数回呼ばれる可能性があるため、CAS ガードで一度だけ continuation を実行する設計。

### Scope の木構造とファイナライザ実行戦略

Scope は `fork` メソッドで子 Scope を生成でき、子 Scope のクローズファイナライザが親のファイナライザリストに登録される。親 close 時に子も連鎖的に close される:

```typescript
// packages/effect/src/internal/fiberRuntime.ts:3237-3273
const finalizers = Array.from(this.state.finalizers.values()).reverse()
this.state = { _tag: "Closed", exit }
// 実行戦略に応じて Sequential / Parallel / ParallelN で実行
return executionStrategy.isSequential(this.strategy) ?
  pipe(core.forEachSequential(finalizers, (fin) => core.exit(fin(exit))), ...) :
  executionStrategy.isParallel(this.strategy) ?
  pipe(forEachParUnbounded(finalizers, (fin) => core.exit(fin(exit))), ...) :
  pipe(forEachParN(finalizers, this.strategy.parallelism, ...), ...)
```

注目すべきは、ファイナライザは **登録の逆順** で実行されること（`reverse()`）。これは LIFO セマンティクスで、後に acquire されたリソースが先に release される RAII の原則に忠実。

## パターンカタログ

- **RAII / Resource Acquisition Is Initialization** (分類: リソース管理)
  - 解決する問題: リソースリーク（ファイルハンドル、接続プール等のクリーンアップ漏れ）
  - 適用条件: リソースの acquire と release がペアになる操作
  - コード例: `packages/effect/src/internal/fiberRuntime.ts:1674-1685` — `acquireRelease`
  - 注意点: acquire は uninterruptible にすることで、acquire 成功後のファイナライザ登録漏れを防止

- **Observer パターン** (分類: 振る舞い)
  - 解決する問題: Fiber の完了を非同期に監視し、関連リソースのクリーンアップをトリガーする
  - 適用条件: Fiber の生存管理、競合完了検出
  - コード例: `packages/effect/src/internal/fiberRuntime.ts:531-537` — `addObserver`
  - 注意点: observer の登録タイミングと Fiber の完了タイミングの競合（既に完了している場合は即座にコールバック）

- **Semaphore / 許可制パターン** (分類: 同期プリミティブ)
  - 解決する問題: 並行アクセス数の制限
  - 適用条件: コネクションプール、レート制限、リソース共有
  - コード例: `packages/effect/src/internal/effect/circular.ts:36-118`
  - 注意点: `withPermits` は uninterruptibleMask + restore で permit 取得のキャンセル可能性と release の確実性を両立

## Good Patterns

- **uninterruptibleMask + restore による acquire-use-release の安全性**: acquire を uninterruptible にしつつ、use 部分は restore で interruptible に戻すパターン。これにより「リソース確保中は割り込み不可、使用中は割り込み可、解放は確実」を実現する。Semaphore の `withPermits`（`circular.ts:100-106`）と `acquireRelease`（`fiberRuntime.ts:1682-1685`）で一貫して使われている。

- **Fiber コレクション + Scope による自動ライフサイクル管理**: FiberSet / FiberMap / FiberHandle はすべて `acquireRelease` で Scope に紐づけ、Scope 終了時に所属 Fiber を一括 interrupt する。Fiber の完了を observer で監視して自動除去することで、手動のクリーンアップを不要にしている（`FiberSet.ts:117-130`）。

- **並行度の抽象化と inherit**: `Concurrency` 型を `"inherit"` にすると、FiberRef から親の設定を継承する。これにより呼び出し元が一括で並行度を制御でき、個別の API 呼び出しごとに並行度を指定する必要がない（`concurrency.ts:17-25`）。

- **ファイナライザの逆順実行（LIFO）**: Scope のファイナライザは登録順の逆で実行される。後から確保されたリソースが先に解放されるため、リソース間の依存関係がある場合でも安全にクリーンアップできる（`fiberRuntime.ts:3237`）。

## Anti-Patterns / 注意点

- **Fiber の fire-and-forget**: `forkDaemon` を安易に使うと、Fiber が親のライフサイクルから切り離され、リソースリークや未処理エラーの原因になる。Effect-TS では `forkDaemon` のドキュメントに明示的な注意があり、通常は `fork`（親スコープに紐づく）を使うべき。

```typescript
// Bad: 無制限にデーモン化するとリークする
const fiber = yield* Effect.forkDaemon(longRunningTask)

// Better: スコープに紐づける
const fiber = yield* Effect.forkScoped(longRunningTask)
// Scope 終了時に自動 interrupt
```

- **割り込み可能領域でのリソース確保**: `uninterruptibleMask` なしでリソースを確保すると、acquire と finalizer 登録の間に割り込みが入りリソースリークする可能性がある。

```typescript
// Bad: acquire と addFinalizer の間に interrupt が入る可能性
const resource = yield* acquire
yield* Scope.addFinalizer(scope, () => release(resource))

// Better: acquireRelease で不可分にする
const resource = yield* Effect.acquireRelease(acquire, (a) => release(a))
```

- **Observer 登録の競合を無視する**: Fiber が既に完了している状態で observer を登録する場合、コールバックが呼ばれないリスクがある。Effect-TS の `addObserver` は既に exit している場合に即座にコールバックする（`fiberRuntime.ts:531-536`）。この二重チェックパターンを怠ると通知漏れが起きる。

## 導出ルール

- `[MUST]` リソースの acquire-release ペアは不可分操作（uninterruptible 領域）で囲み、acquire 完了後のファイナライザ登録を割り込みから保護する
  - 根拠: `acquireRelease` が `core.uninterruptible(core.tap(acquire, (a) => addFinalizer(...)))` で実装されている（`fiberRuntime.ts:1682-1685`）

- `[MUST]` 並行タスクの寿命は親タスクまたは明示的なスコープの寿命に束縛する（構造的並行処理）
  - 根拠: `fork` はデフォルトで親の FiberScope に子を登録し、親終了時に `interruptAllChildren()` を呼ぶ（`fiberRuntime.ts:962-963`）

- `[SHOULD]` 並行度は個別 API に埋め込まず、統一的な concurrency パラメータとして抽象化する
  - 根拠: `Concurrency` 型（`"unbounded" | "inherit" | number`）を `concurrency.match` で分岐し、`forEach` 等の全コンビネータが統一的に処理する（`concurrency.ts:6-30`）

- `[SHOULD]` uninterruptibleMask + restore パターンで「キャンセル可能な待機」と「確実なクリーンアップ」を両立する
  - 根拠: Semaphore の `withPermits` が `restore(this.take(n))` で permit 取得をキャンセル可能にしつつ、`ensuring(restore(self), this.release(permits))` で release を保証する（`circular.ts:100-106`）

- `[SHOULD]` ファイナライザは登録の逆順（LIFO）で実行し、リソースの依存順序を尊重する
  - 根拠: Scope の `close` が `Array.from(this.state.finalizers.values()).reverse()` でファイナライザを逆順実行する（`fiberRuntime.ts:3237`）

- `[SHOULD]` Fiber の動的コレクションは Scope に紐づけ、observer で完了を監視して自動除去する
  - 根拠: FiberSet / FiberMap / FiberHandle がすべて `acquireRelease` で Scope に紐づき、fiber の完了 observer で自動クリーンアップする（`FiberSet.ts:117-130`）

- `[AVOID]` `forkDaemon`（グローバルスコープへのフォーク）を安易に使わない — 明示的なライフサイクル管理が不要なケースのみに限定する
  - 根拠: `forkDaemon` は `globalScope` にフォークし親の終了で interrupt されないため、意図せずタスクリークを起こしうる（`fiberRuntime.ts:2404-2405`）

- `[AVOID]` Observer 登録時に「既に完了済み」のケースを考慮しないまま非同期通知に依存する
  - 根拠: `addObserver` は `this._exitValue !== null` の場合に即座にコールバックする二重チェックを行っている（`fiberRuntime.ts:531-536`）

## 適用チェックリスト

- [ ] 並行タスクをフォークする際、タスクのライフサイクルが親に束縛されているか確認する（fire-and-forget になっていないか）
- [ ] リソースの acquire と release がペアになっており、acquire-release 間に割り込みポイントがないか確認する
- [ ] 並行度の指定が個別 API にハードコードされておらず、統一的なパラメータで制御可能か確認する
- [ ] ファイナライザ（クリーンアップ処理）が登録の逆順で実行されるか確認する
- [ ] 非同期 observer の登録時に「既に完了している」ケースのハンドリングがあるか確認する
- [ ] 長寿命のバックグラウンドタスクには明示的なスコープ紐づけ（`forkScoped` / `forkIn` 相当）があるか確認する
- [ ] Semaphore 等の同期プリミティブで permit 取得のキャンセル可能性と release の確実性が両立しているか確認する
