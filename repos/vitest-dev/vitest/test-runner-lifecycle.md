# test-runner-lifecycle

> リポジトリ: vitest-dev/vitest
> 分析日: 2026-03-05

## 概要

テストランナーのライフサイクル設計を分析する。Vitest のランナーは Collect（テスト収集）、Fixture Resolution（フィクスチャ解決）、Execution（テスト実行）、Reporting（結果通知）の 4 フェーズを明確に分離し、各フェーズに対して VitestRunner インターフェースのフック群で拡張ポイントを提供している。この設計は、テストフレームワークに限らず「パイプライン型処理にフック機構を組み込む」汎用パターンとして注目に値する。

## 背景にある原則

- **フェーズの明示的分離**: 収集と実行を同一パスで行わず、先にすべてのテストを収集してからフィルタリング・ソートし、その後に実行する。これにより `.only` や `--testNamePattern` のようなフィルタが全テストを把握した上で動作でき、実行順序の制御（シャッフル、失敗優先）も可能になる。根拠: `startTests` が `collectTests` → `onCollected` → `runFiles` の順で呼ばれる設計（`packages/runner/src/run.ts:1070-1083`）

- **フックは「何を」ではなく「いつ」で分類すべき**: `onBeforeRunTask` / `onAfterTryTask` / `onAfterRetryTask` のように、同じ対象（テスト）に対してタイミング違いで複数のフックを提供する。これにより利用者は「テスト関数の呼び出し前後」「リトライ判定後」など、正確なタイミングに介入できる。根拠: `VitestRunner` インターフェースが 15 以上のオプショナルフックを定義（`packages/runner/src/types/runner.ts:94-213`）

- **クリーンアップは取得と対称に、逆順で行う**: フィクスチャのクリーンアップは登録の逆順で実行される。`beforeEach` のクリーンアップは `afterEach` の後に逆順で呼ばれる。これはリソースのスタック的な取得・解放を保証するプラクティス。根拠: `callFixtureCleanup` が `cleanupFnArray.reverse()` で逆順実行（`packages/runner/src/fixture.ts:237-242`）

- **状態は WeakMap で隔離し、タスクオブジェクトはシリアライズ可能に保つ**: テスト関数やフィクスチャ、フックなどの非シリアライズ可能なデータを WeakMap に退避させ、Task オブジェクト自体は Worker 間通信でシリアライズ可能な状態を維持する。根拠: `map.ts` が `fnMap` / `testFixtureMap` / `hooksMap` をすべて WeakMap で管理（`packages/runner/src/map.ts:6-8`）

## 実例と分析

### 4 フェーズのライフサイクル

`startTests` 関数がランナーのエントリポイントとして全体のオーケストレーションを担う。

```typescript
// packages/runner/src/run.ts:1043-1090
export async function startTests(specs, runner) {
  // Phase 1: Collect
  await runner.onBeforeCollect?.(paths)
  const files = await collectTests(specs, runner)
  await runner.onCollected?.(files)

  // Phase 2-3: Execute (fixtures resolved inside each test)
  await runner.onBeforeRunFiles?.(files)
  await runFiles(files, runner)
  await runner.onAfterRunFiles?.(files)

  // Phase 4: Report (throttled updates sent throughout)
  await finishSendTasksUpdate(runner)
  return files
}
```

各フェーズ境界に `onXxx` フックが配置され、ランナーの実装クラス（`TestRunner`）がスナップショット初期化やモッククリアなどの具体的処理を差し込む。

### フィクスチャのスコープとライフサイクル管理

フィクスチャは `test` / `file` / `worker` の 3 スコープを持ち、スコープごとにコンテキストオブジェクトが異なる。`use()` コールバックパターンで setup/teardown を 1 関数にまとめ、確実なクリーンアップを保証する。

```typescript
// packages/runner/src/fixture.ts:472-509
async function resolveFixtureFunction(fixtureFn, context, cleanupFnArray) {
  const useFnArgPromise = createDefer()
  let isUseFnArgResolved = false

  const fixtureReturn = fixtureFn(context, async (useFnArg) => {
    isUseFnArgResolved = true
    useFnArgPromise.resolve(useFnArg)

    // teardown はクリーンアップ配列に登録し、use() の Promise で中断
    const useReturnPromise = createDefer()
    cleanupFnArray.push(async () => {
      useReturnPromise.resolve()
      await fixtureReturn
    })
    await useReturnPromise
  }).catch((e) => {
    if (!isUseFnArgResolved) {
      useFnArgPromise.reject(e)
      return
    }
    throw e
  })

  return useFnArgPromise
}
```

`use()` を呼んだ時点でフィクスチャ値が確定し、`use()` の Promise が解決されるまで teardown コードは中断される。この「中断可能な setup/teardown」パターンにより、リソースのライフサイクルがテスト実行と正確に同期する。

### aroundEach/aroundAll による入れ子フック

`callAroundHooks` は再帰的にフックをネストし、各フックの setup/teardown に独立したタイムアウトを設ける。

```typescript
// packages/runner/src/run.ts:306-432
const runNextHook = async (index) => {
  if (index >= hooks.length) {
    return runInner()  // 最内周でテスト本体を実行
  }
  const hook = hooks[index]
  // ...
  const use = async () => {
    // setup 完了
    setupTimeout.clear()
    await runNextHook(index + 1)  // 次のフックへ再帰
    // teardown 開始（独立タイムアウト）
    teardownTimeout = createTimeoutPromise(timeout, 'teardown', ...)
  }
  await invokeHook(hook, use)
}
```

setup と teardown にそれぞれ個別のタイムアウトを設け、`use()` の多重呼び出しや呼び忘れも専用エラークラスで検出する。

### スロットルされたタスク更新

テスト結果の通知は 100ms 間隔でスロットルされ、大量テスト実行時のオーバーヘッドを抑制する。

```typescript
// packages/runner/src/run.ts:502-528
const sendTasksUpdateThrottled = throttle(sendTasksUpdate, 100)

export function updateTask(event, task, runner) {
  eventsPacks.push([task.id, event, undefined])
  packs.set(task.id, [task.result, task.meta])
  sendTasksUpdateThrottled(runner)
}
```

`packs` が Map なので同一タスクの複数更新は最新値で上書きされ、不要な中間状態の送信を回避する。

### 並行実行の制御

`limitConcurrency` がシングルトンのセマフォとして機能し、`maxConcurrency` 設定に基づいてテスト・フック・フィクスチャの同時実行数を制限する。リンクリストによるキュー実装で、Promise ベースの acquire/release パターンを提供する。

```typescript
// packages/runner/src/utils/limit-concurrency.ts:13-85
export function limitConcurrency(concurrency = Infinity) {
  let count = 0
  let head, tail  // リンクリストキュー

  const finish = () => {
    count--
    if (head) {
      head[0]()       // 次のタスクを resolve
      head = head[1]  // キューを進める
      tail = head && tail
    }
  }
  // ...
}
```

## パターンカタログ

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: テストライフサイクルの骨格を固定しつつ、個別ステップをカスタマイズ可能にする
  - 適用条件: パイプライン処理で各段階の拡張が必要な場合
  - コード例: `VitestRunner` インターフェースの `onBeforeRunTask` / `runTask` / `onAfterRunTask` (`packages/runner/src/types/runner.ts:118-168`)
  - 注意点: フックが多すぎると利用者の認知負荷が上がる。タイミング名で命名規約を統一すること

- **Middleware / Chain of Responsibility パターン** (分類: 振る舞い)
  - 解決する問題: 複数の aroundEach/aroundAll フックを入れ子で実行し、各フックが前後の処理を挟める
  - 適用条件: AOP 的な横断関心事（トランザクション、トレーシング等）をテストに適用する場合
  - コード例: `callAroundHooks` の `runNextHook` 再帰 (`packages/runner/src/run.ts:306-432`)
  - 注意点: 各フックの setup/teardown にそれぞれタイムアウトを設けないとデッドロックの原因になる

- **Semaphore パターン** (分類: 並行制御)
  - 解決する問題: 並行テスト実行数の上限制御
  - 適用条件: リソース制約のある環境での並行処理
  - コード例: `limitConcurrency` のリンクリストキュー実装 (`packages/runner/src/utils/limit-concurrency.ts:13-85`)

## Good Patterns

- **use() コールバックによる setup/teardown 一体化**: フィクスチャの setup と teardown を単一関数にまとめ、`use()` 呼び出しを境界として分割する。try/finally では表現しにくい「値を外部に公開してから teardown まで待機」というパターンを、Promise の中断で実現している。これにより、リソースリークの可能性が構造的に排除される。
  ```typescript
  // packages/runner/src/fixture.ts:484-497
  const fixtureReturn = fixtureFn(context, async (useFnArg) => {
    useFnArgPromise.resolve(useFnArg)
    const useReturnPromise = createDefer()
    cleanupFnArray.push(async () => {
      useReturnPromise.resolve()
      await fixtureReturn
    })
    await useReturnPromise
  })
  ```

- **WeakMap によるメタデータ隔離**: テストオブジェクトをシリアライズ可能に保ちつつ、関数やフック等の非シリアライズ可能データを WeakMap に退避する。GC と連動して自動的にメモリ解放されるため、手動の cleanup が不要。
  ```typescript
  // packages/runner/src/map.ts:6-8
  const fnMap = new WeakMap()
  const testFixtureMap = new WeakMap()
  const hooksMap = new WeakMap()
  ```

- **フィクスチャ依存グラフの静的検証**: フィクスチャ登録時にスコープの包含関係（test < file < worker）を検証し、test スコープのフィクスチャが worker スコープに依存するような不正な構成を早期にエラーにする。
  ```typescript
  // packages/runner/src/fixture.ts:214-216
  if (TestFixtures._fixtureScopes.indexOf(fixture.scope)
    > TestFixtures._fixtureScopes.indexOf(dep.scope)) {
    errors.push(new FixtureDependencyError(...))
  }
  ```

- **exhaustive check に `satisfies never` を使用**: `collectTests` でタスクの type 分岐において `c satisfies never` でコンパイル時に型の網羅性を検証する。switch の default に `never` を使うよりも簡潔。
  ```typescript
  // packages/runner/src/collect.ts:96-98
  else {
    c satisfies never
  }
  ```

## Anti-Patterns / 注意点

- **フック内でのコンテキスト API 不正使用**: `afterEach` や `onTestFinished` フック内で `onTestFailed` / `onTestFinished` を呼ぶと無限ループやタイミング不整合を起こす。Vitest はフック実行中にこれらの API を上書きして `throw` させることで防御している。
  ```typescript
  // Bad: フック内で onTestFailed を呼ぶ
  afterEach(({ onTestFailed }) => {
    onTestFailed(() => {}) // Error: Cannot call "onTestFailed" inside a test hook.
  })

  // Better: テスト本体内で登録する
  test('example', ({ onTestFailed }) => {
    onTestFailed(() => { /* cleanup */ })
    // ... test logic
  })
  ```

- **aroundEach の `use()` 呼び忘れ・多重呼び出し**: `aroundEach` / `aroundAll` で `runTest()` / `runSuite()` を呼ばないとテストが実行されず、複数回呼ぶと予測不能な状態になる。専用のエラークラス `AroundHookSetupError` / `AroundHookMultipleCallsError` で即座に検出される。
  ```typescript
  // Bad: use() を呼ばない
  aroundEach(async (runTest) => {
    console.log('setup')
    // runTest() を忘れている → AroundHookSetupError
  })

  // Better: 必ず use() を 1 回だけ呼ぶ
  aroundEach(async (runTest) => {
    await setup()
    await runTest()
    await teardown()
  })
  ```

## 導出ルール

- `[MUST]` ライフサイクルの各フェーズ（収集・実行・レポート）を関数レベルで分離し、フェーズ間のデータ受け渡しを明示的な戻り値で行う
  - 根拠: `startTests` が `collectTests` → `runFiles` → `finishSendTasksUpdate` を順次呼び出し、各フェーズが独立してテスト可能な設計になっている（`run.ts:1070-1083`）

- `[MUST]` setup/teardown が対になるリソース管理では、クリーンアップを登録順の逆順で実行する
  - 根拠: `callFixtureCleanup` が `cleanupFnArray.reverse()` で実行し、スタック的なリソース解放を保証（`fixture.ts:237-242`）

- `[SHOULD]` 長時間パイプラインの進捗通知はスロットルし、同一エンティティの更新は最新値で上書きする
  - 根拠: `sendTasksUpdateThrottled` が 100ms スロットルで `packs` Map を使い、中間状態の重複送信を排除（`run.ts:502-528`）

- `[SHOULD]` シリアライズ境界を越えるオブジェクトから非シリアライズ可能なメタデータを WeakMap に分離する
  - 根拠: `fnMap` / `hooksMap` / `testFixtureMap` がすべて WeakMap で、Task オブジェクトの Worker 間転送を可能にしている（`map.ts:6-8`）

- `[SHOULD]` 「何を」ではなく「いつ」でフックを命名し、同一対象に対して複数のタイミングフックを提供する
  - 根拠: `onBeforeRunTask` / `onBeforeTryTask` / `onAfterTryTask` / `onAfterRetryTask` / `onAfterRunTask` が同一テストの異なるタイミングを正確に表現（`types/runner.ts:118-148`）

- `[AVOID]` タイムアウトを単一で設定して setup/teardown の両方をカバーすること。setup と teardown にそれぞれ独立したタイムアウトを設けるべき
  - 根拠: `callAroundHooks` が `setupTimeout` と `teardownTimeout` を別々に管理し、どちらのフェーズがタイムアウトしたかを正確にエラーメッセージで伝えている（`run.ts:276-431`）

## 適用チェックリスト

- [ ] パイプライン処理のフェーズが関数レベルで分離されているか（収集→変換→実行→レポートが混在していないか）
- [ ] フック/コールバックの命名が「タイミング」を正確に表現しているか（`onBefore`/`onAfter` + 具体的なアクション名）
- [ ] setup/teardown ペアのクリーンアップが逆順で実行されることを保証しているか
- [ ] Worker/プロセス間で受け渡すオブジェクトから、関数やクロージャなど非シリアライズ可能なデータを分離しているか
- [ ] 大量イベントの通知にスロットル/バッチ処理を適用し、同一エンティティの重複更新を排除しているか
- [ ] `use()` パターンやコールバック型 API で、呼び忘れ・多重呼び出しを検出するガードがあるか
- [ ] 並行実行数の上限制御（セマフォ）が、テスト・フック・フィクスチャ解決すべてに適用されているか
