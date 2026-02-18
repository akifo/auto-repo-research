# concurrency-patterns

> リポジトリ: vitejs/vite
> 分析日: 2026-02-17

## 概要

Vite のコードベースにおけるファイル監視・並列処理・デバウンス/スロットル・非同期制御フローのパターンを分析した。Vite は開発サーバーという性質上、ファイル変更イベントの高頻度発火、モジュール変換リクエストの重複、依存関係の動的発見といった並行性の課題に直面しており、それぞれに対して明確なパターンで対処している。特にリクエスト重複排除、キャンセル可能な非同期処理、デバウンス付きバッチ処理の3つは他のプロジェクトにも広く応用できる設計知見である。

## 背景にある原則

- **重複作業の排除で応答速度を守る**: 同一モジュールへの変換リクエストが並行して発生した場合、最初のリクエストの Promise を後続に共有する。計算コストの高い処理を二重実行しないことで、dev サーバーの応答性を維持する。（`transformRequest.ts:109-126` の `_pendingRequests` Map）
- **バッチ処理でシステムの安定性を確保する**: 依存関係の発見やファイル変更といったイベントが短時間に集中する場合、デバウンスで一定時間待ってからまとめて処理する。個別に即時処理すると不要なフルリロードや最適化再実行が頻発する。（`optimizer.ts:615-628` のデバウンス戦略）
- **キャンセル可能な設計で無駄な計算を防ぐ**: 長時間実行される最適化処理やスキャン処理に `cancel()` メソッドを持たせ、新しい結果が必要になった時点で古い処理を中断する。リソースの無駄遣いを防ぎつつ、常に最新の状態を保つ。（`optimizer/index.ts:740-748` の cancel パターン）
- **グレースフルシャットダウンで状態を壊さない**: `Promise.allSettled` で全非同期処理の完了を待ち、一部の失敗が他に波及しない形でシャットダウンを行う。進行中のリクエストも待機してからクローズする。（`server/index.ts:559-569`, `environment.ts:297-311`）

## 実例と分析

### リクエスト重複排除（Request Deduplication）

`transformRequest` は URL をキーとする `_pendingRequests` Map で進行中の変換を追跡する。同じ URL へのリクエストが来た場合、pending な Promise をそのまま返す。ただし、pending 中にモジュールが invalidate された場合は、`abort()` で古い結果をキャッシュから除去し、新しい変換を開始する。

```typescript
// packages/vite/src/node/server/transformRequest.ts:109-146
const pending = environment._pendingRequests.get(url);
if (pending) {
  return environment.moduleGraph.getModuleByUrl(url).then((module) => {
    if (!module || pending.timestamp > module.lastInvalidationTimestamp) {
      // The pending request is still valid, we can safely reuse its result
      return pending.request;
    } else {
      // First request has been invalidated, abort it to clear the cache,
      // then perform a new doTransform.
      pending.abort();
      return transformRequest(environment, url, options);
    }
  });
}

const request = doTransform(environment, url, options, timestamp);

let cleared = false;
const clearCache = () => {
  if (!cleared) {
    environment._pendingRequests.delete(url);
    cleared = true;
  }
};

environment._pendingRequests.set(url, {
  request,
  timestamp,
  abort: clearCache,
});

return request.finally(clearCache);
```

### デバウンス付き依存関係最適化

依存関係オプティマイザは、新しい依存が発見されるたびに即座に再最適化するのではなく、100ms のデバウンスで待機する。さらに `currentlyProcessing` フラグで排他制御を行い、処理中に新たなデバウンスが発火した場合は `enqueuedRerun` に保存して、現在の処理が完了してから実行する。

```typescript
// packages/vite/src/node/optimizer/optimizer.ts:615-628
function debouncedProcessing(timeout = debounceMs) {
  enqueuedRerun = undefined;
  if (debounceProcessingHandle) clearTimeout(debounceProcessingHandle);
  if (newDepsToLogHandle) clearTimeout(newDepsToLogHandle);
  newDepsToLogHandle = undefined;
  debounceProcessingHandle = setTimeout(() => {
    debounceProcessingHandle = undefined;
    enqueuedRerun = rerun;
    if (!currentlyProcessing) {
      enqueuedRerun();
    }
  }, timeout);
}

// packages/vite/src/node/optimizer/optimizer.ts:518-520
// runOptimizer の最後で、待機中の再実行を処理
currentlyProcessing = false;
// @ts-expect-error `enqueuedRerun` could exist because `debouncedProcessing` may run while awaited
enqueuedRerun?.();
```

### HMR 更新のマイクロタスクバッファリング

クライアント側の `HMRClient.queueUpdate` は、同一のソース変更から生じる複数の HMR 更新をマイクロタスク境界（`await Promise.resolve()`）でバッファリングし、まとめて適用する。`fetchUpdate` で非同期にモジュールをロードしつつ、副作用の適用は同期関数として返す。これにより、ロードは並列、適用は順序保証という両立を実現している。

```typescript
// packages/vite/src/shared/hmr.ts:252-261
public async queueUpdate(payload: Update): Promise<void> {
  this.updateQueue.push(this.fetchUpdate(payload))
  if (!this.pendingUpdateQueue) {
    this.pendingUpdateQueue = true
    await Promise.resolve()
    this.pendingUpdateQueue = false
    const loading = [...this.updateQueue]
    this.updateQueue = []
    ;(await Promise.all(loading)).forEach((fn) => fn && fn())
  }
}
```

### キャンセル可能な非同期処理

依存スキャンと最適化の両方に `{ cancel, result }` 構造を持たせている。`cancel()` は内部のコンテキストフラグを立てて処理を中断し、クローズ時には `Promise.allSettled` で全キャンセルの完了を待つ。

```typescript
// packages/vite/src/node/optimizer/optimizer.ts:143-149
async function close() {
  closed = true;
  await Promise.allSettled([
    discover?.cancel(),
    depsOptimizer.scanProcessing,
    optimizationResult?.cancel(),
  ]);
}
```

### クロール完了検知（CrawlEndFinder）

静的インポートのクロールが完了したことを検知する仕組み。各リクエストを `registeredIds` に登録し、すべてが完了した後、50ms のタイムアウトで「もう新しいリクエストは来ない」と判断する。これにより、依存スキャンの結果をブラウザに送るタイミングを最適化する。

```typescript
// packages/vite/src/node/server/environment.ts:342-401
function setupOnCrawlEnd(): CrawlEndFinder {
  const registeredIds = new Set<string>();
  const seenIds = new Set<string>();
  const onCrawlEndPromiseWithResolvers = promiseWithResolvers<void>();

  let timeoutHandle: NodeJS.Timeout | undefined;

  function registerRequestProcessing(id: string, done: () => Promise<any>): void {
    if (!seenIds.has(id)) {
      seenIds.add(id);
      registeredIds.add(id);
      done()
        .catch(() => {})
        .finally(() => markIdAsDone(id));
    }
  }

  function checkIfCrawlEndAfterTimeout() {
    if (cancelled || registeredIds.size > 0) return;
    if (timeoutHandle) clearTimeout(timeoutHandle);
    timeoutHandle = setTimeout(callOnCrawlEndWhenIdle, callCrawlEndIfIdleAfterMs);
  }
  // ...
}
```

### ファイル変更のポーリング読み取り

HMR でファイル変更イベントを受けた直後にファイルを読み取ると、OS がまだ書き込みを完了していない場合がある（特に Vue ファイル）。Vite は空バッファが返された場合に mtime を監視して最大 100ms（10回 x 10ms）ポーリングする。

```typescript
// packages/vite/src/node/server/hmr.ts:1090-1110
// vitejs/vite#610 when hot-reloading Vue files, we read immediately on file
// change event and sometimes this can be too early and get an empty buffer.
// Poll until the file's modified time has changed before reading again.
async function readModifiedFile(file: string): Promise<string> {
  const content = await fsp.readFile(file, "utf-8");
  if (!content) {
    const mtime = (await fsp.stat(file)).mtimeMs;
    for (let n = 0; n < 10; n++) {
      await new Promise((r) => setTimeout(r, 10));
      const newMtime = (await fsp.stat(file)).mtimeMs;
      if (newMtime !== mtime) {
        break;
      }
    }
    return await fsp.readFile(file, "utf-8");
  } else {
    return content;
  }
}
```

### 直列 Promise キュー

CSS の emit 処理など、順序保証が必要な非同期処理のために `createSerialPromiseQueue` ユーティリティを用意している。各タスクは並行して開始されるが、resolve の順序は呼び出し順に保たれる。

```typescript
// packages/vite/src/node/utils.ts:1638-1661
export function createSerialPromiseQueue<T>(): {
  run(f: () => Promise<T>): Promise<T>;
} {
  let previousTask: Promise<[unknown, Awaited<T>]> | undefined;
  return {
    async run(f) {
      const thisTask = f();
      const depTasks = Promise.all([previousTask, thisTask]);
      previousTask = depTasks;
      const [, result] = await depTasks;
      if (previousTask === depTasks) {
        previousTask = undefined;
      }
      return result;
    },
  };
}
```

## パターンカタログ

- **Promise Deduplication** (分類: 並行制御)
  - 解決する問題: 同一リソースへの並行リクエストによる計算の無駄
  - 適用条件: 同じ入力に対して同じ結果を返す冪等な非同期処理
  - コード例: `packages/vite/src/node/server/transformRequest.ts:109-146`
  - 注意点: invalidation が起こった場合は古い Promise を破棄する必要がある

- **Debounce with Enqueue** (分類: フロー制御)
  - 解決する問題: 高頻度イベントによる処理の乱立
  - 適用条件: 処理が排他的（同時に1つしか走らない）でありつつ、最新状態を反映すべき場合
  - コード例: `packages/vite/src/node/optimizer/optimizer.ts:615-628`
  - 注意点: `currentlyProcessing` フラグと `enqueuedRerun` の組み合わせで、処理中に来た新しいリクエストを漏らさない

- **Cancellable Async Operation** (分類: リソース管理)
  - 解決する問題: 結果が不要になった長時間非同期処理のリソース浪費
  - 適用条件: 計算コストが高く、途中で不要になりうる処理
  - コード例: `packages/vite/src/node/optimizer/index.ts:740-748`
  - 注意点: キャンセル後のクリーンアップ処理を忘れない

- **Microtask Batching** (分類: フロー制御)
  - 解決する問題: 同一ティック内の複数イベントを1回の処理にまとめたい
  - 適用条件: 複数の非同期操作を並列にフェッチしつつ、適用は一括で行いたい場合
  - コード例: `packages/vite/src/shared/hmr.ts:252-261`
  - 注意点: `await Promise.resolve()` はマイクロタスク1つ分の遅延しかないため、同一イベントループターンの更新のみがバッチされる

## Good Patterns

- **Promise の一時キャッシュで重複排除**: `_pendingRequests` Map に進行中の Promise を保存し、同一 URL のリクエストは既存の Promise を返す。処理完了後に `finally` でキャッシュを自動クリアする。invalidation による古い結果の破棄も組み込まれている。

```typescript
// packages/vite/src/node/server/transformRequest.ts:128-146
const request = doTransform(environment, url, options, timestamp);
let cleared = false;
const clearCache = () => {
  if (!cleared) {
    environment._pendingRequests.delete(url);
    cleared = true;
  }
};
environment._pendingRequests.set(url, { request, timestamp, abort: clearCache });
return request.finally(clearCache);
```

- **`Promise.allSettled` によるグレースフルシャットダウン**: 複数の非同期リソースを閉じる際に `Promise.allSettled` を使い、一部の失敗が他のクリーンアップを妨げない。

```typescript
// packages/vite/src/node/server/index.ts:559-569
await Promise.allSettled([
  watcher.close(),
  ws.close(),
  Promise.allSettled(
    Object.values(server.environments).map((environment) => environment.close()),
  ),
  closeHttpServer(),
  server._ssrCompatModuleRunner?.close(),
]);
```

- **WeakMap による計算結果のキャッシュ**: ソート済みプラグインリストを `WeakMap<Environment, Plugin[]>` でキャッシュし、Environment オブジェクトが GC されれば自動的にキャッシュも解放される。

```typescript
// packages/vite/src/node/server/hmr.ts:360-368
const sortedHotUpdatePluginsCache = new WeakMap<Environment, Plugin[]>();
function getSortedHotUpdatePlugins(environment: Environment): Plugin[] {
  let sortedPlugins = sortedHotUpdatePluginsCache.get(environment);
  if (!sortedPlugins) {
    sortedPlugins = getSortedPluginsByHotUpdateHook(environment.plugins);
    sortedHotUpdatePluginsCache.set(environment, sortedPlugins);
  }
  return sortedPlugins;
}
```

- **`promiseWithResolvers` による外部制御可能な Promise**: 標準の `Promise.withResolvers()` のポリフィルを共有ユーティリティとして持ち、resolve/reject を Promise 外部から制御可能にしている。依存関係最適化の処理キューで活用。

```typescript
// packages/vite/src/shared/utils.ts:76-84
export function promiseWithResolvers<T>(): PromiseWithResolvers<T> {
  let resolve: any;
  let reject: any;
  const promise = new Promise<T>((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });
  return { promise, resolve, reject };
}
```

## Anti-Patterns / 注意点

- **close の二重実行**: サーバーの `close()` が複数回呼ばれる可能性がある場合、毎回 `closeServer()` を実行すると状態が壊れる。Vite は `closeServerPromise` 変数で一度だけ実行を保証する。

```typescript
// Bad: 毎回 close を実行
async close() {
  await closeServer()
}

// Better: Promise をキャッシュして冪等にする
// packages/vite/src/node/server/index.ts:729-734
async close() {
  if (!closeServerPromise) {
    closeServerPromise = closeServer()
  }
  return closeServerPromise
}
```

- **ファイル変更イベント直後の即時読み取り**: OS のファイル書き込みが完了する前にファイルを読み取ると空バッファが返ることがある。イベント駆動でファイルを読む場合は、空の場合のリトライ戦略が必要。

```typescript
// Bad: 変更通知の即座に読み取り
watcher.on("change", async (file) => {
  const content = await fs.readFile(file, "utf-8");
  // content が空の可能性がある
});

// Better: mtime ポーリングでリトライ
// packages/vite/src/node/server/hmr.ts:1093-1110
async function readModifiedFile(file: string): Promise<string> {
  const content = await fsp.readFile(file, "utf-8");
  if (!content) {
    const mtime = (await fsp.stat(file)).mtimeMs;
    for (let n = 0; n < 10; n++) {
      await new Promise((r) => setTimeout(r, 10));
      const newMtime = (await fsp.stat(file)).mtimeMs;
      if (newMtime !== mtime) break;
    }
    return await fsp.readFile(file, "utf-8");
  }
  return content;
}
```

- **`Promise.all` でのクリーンアップ処理**: シャットダウンのような「全部実行したい」処理で `Promise.all` を使うと、1つの失敗で他が実行されない。

```typescript
// Bad: 一つが失敗すると後続が待たれない
await Promise.all([resourceA.close(), resourceB.close(), resourceC.close()]);

// Better: allSettled で全てのクリーンアップを実行
await Promise.allSettled([resourceA.close(), resourceB.close(), resourceC.close()]);
```

## 導出ルール

- `[MUST]` 冪等な非同期処理への並行リクエストは、進行中の Promise を Map にキャッシュして重複排除する。キャッシュのクリーンアップは `finally` で行い、invalidation 時は古い Promise を破棄する
  - 根拠: Vite の `transformRequest` は `_pendingRequests` Map で同一 URL への変換リクエストを重複排除し、invalidation が起きた場合は `abort()` で古い結果を破棄して再実行する（`transformRequest.ts:109-146`）

- `[MUST]` 複数リソースのクリーンアップ処理では `Promise.all` ではなく `Promise.allSettled` を使う。一部の失敗が他のクリーンアップを妨げてはならない
  - 根拠: Vite のサーバーシャットダウンは `Promise.allSettled` でウォッチャー・WebSocket・環境・HTTP サーバーを並行クローズし、一部の失敗が他に波及しない（`server/index.ts:559-569`）

- `[SHOULD]` 高頻度イベントからの重い処理はデバウンス＋排他制御で保護する。処理中に来た新しいリクエストは `enqueuedRerun` パターンで処理完了後に実行する
  - 根拠: 依存関係オプティマイザは 100ms のデバウンスと `currentlyProcessing` フラグで、新しい依存が発見されるたびに再最適化が乱立することを防いでいる（`optimizer.ts:615-628`）

- `[SHOULD]` 長時間実行される非同期処理には `{ cancel, result }` 構造でキャンセル機能を持たせ、結果が不要になった時点で中断できるようにする
  - 根拠: Vite の依存スキャン・最適化は `cancel()` メソッドを持ち、新しいスキャンが必要になった時点や close 時に古い処理を中断する（`optimizer/index.ts:740-748`）

- `[SHOULD]` 同一イベントループターン内の複数更新は、マイクロタスクバッファリング（`await Promise.resolve()` でのバッチ境界）で1回の処理にまとめる
  - 根拠: HMR クライアントは `queueUpdate` でモジュールのフェッチを並列化しつつ、副作用の適用を順序保証付きで一括実行する（`shared/hmr.ts:252-261`）

- `[AVOID]` ファイル監視イベント直後のファイル読み取りを無条件に信頼すること。OS の書き込みバッファが完了する前に読み取りが起こりうるため、空結果に対するリトライ戦略が必要
  - 根拠: `readModifiedFile` は空バッファが返された場合に mtime ポーリングでリトライし、ファイルシステムの遅延に対処している（`server/hmr.ts:1090-1110`）

## 適用チェックリスト

- [ ] 同一リソースへの並行リクエストが発生しうる箇所で、Promise の重複排除（pending map + `finally` でのクリーンアップ）を実装しているか
- [ ] `close()` や `shutdown()` のような破棄処理は冪等か（複数回呼ばれても安全か）
- [ ] 複数リソースのクリーンアップに `Promise.allSettled` を使い、一部の失敗が他に波及しないようにしているか
- [ ] 高頻度イベント（ファイル変更、ユーザー入力等）からの重い処理にデバウンスを適用しているか
- [ ] デバウンス中の排他制御と、処理中に溜まった新リクエストの実行漏れがないか（enqueuedRerun パターン）
- [ ] 長時間実行される非同期処理にキャンセル機能があるか
- [ ] ファイル監視イベント後の読み取りに空結果リトライ戦略があるか
- [ ] 順序保証が必要な非同期処理に Serial Promise Queue またはマイクロタスクバッファリングを使っているか
