# pattern: promise-coalescing

> 出典: repos/vitejs/vite
> カテゴリ: pattern

## 概要

並行リクエストの重複排除（Promise Coalescing）と無効化タイムスタンプ検証を組み合わせた並行処理パターン。同一キーへの並行リクエストを `Map` で合流させつつ、`lastInvalidationTimestamp` と比較して古い結果の再利用を防止する。キャッシュによる高速化と整合性保証を両立する、汎用的な並行制御の設計知見である。

## 背景・文脈

Vite の開発サーバーでは、ブラウザから同一モジュールへの変換リクエスト（`transformRequest`）が並行して発生する。例えば、複数のモジュールが同じ依存をインポートしている場合や、ブラウザの並列ロードにより同一 URL へのリクエストが同時に到着する場合がある。

素朴に実装すると、同じモジュールに対して重複した変換処理（パース、プラグイン適用、ソースマップ生成）が走り、CPU とメモリを無駄に消費する。一方で、単純にキャッシュだけで解決しようとすると、HMR（Hot Module Replacement）でモジュールが無効化された直後に古い結果を返してしまうリスクがある。

Vite はこの問題を「進行中の Promise を Map にキャッシュ + タイムスタンプによる無効化検証」という2つの仕組みの組み合わせで解決している。

## 実装パターン

パターンの全体構造は3つの要素で構成される:

1. **Pending Map**: 進行中の Promise を URL をキーとする Map に格納する
2. **タイムスタンプ検証**: リクエスト開始時のタイムスタンプとモジュールの `lastInvalidationTimestamp` を比較する
3. **自動クリーンアップ**: `finally` で Map からエントリを削除する

```typescript
// packages/vite/src/node/server/transformRequest.ts:77-147
export function transformRequest(
  environment: DevEnvironment,
  url: string,
  options: TransformOptionsInternal = {},
): Promise<TransformResult | null> {
  if (environment._closing && environment.config.dev.recoverable)
    throwClosedServerError()

  // リクエスト開始時のタイムスタンプを記録（単調増加を保証）
  const timestamp = monotonicDateNow()

  url = removeTimestampQuery(url)

  // --- (1) 進行中のリクエストがあれば合流を試みる ---
  const pending = environment._pendingRequests.get(url)
  if (pending) {
    return environment.moduleGraph.getModuleByUrl(url).then((module) => {
      if (!module || pending.timestamp > module.lastInvalidationTimestamp) {
        // pending のタイムスタンプが無効化より新しい → 結果はまだ有効
        return pending.request
      } else {
        // pending 中に無効化が発生 → 古い結果を破棄して再処理
        pending.abort()
        return transformRequest(environment, url, options)
      }
    })
  }

  // --- (2) 新規リクエストを開始し、Map に登録する ---
  const request = doTransform(environment, url, options, timestamp)

  let cleared = false
  const clearCache = () => {
    if (!cleared) {
      environment._pendingRequests.delete(url)
      cleared = true
    }
  }

  environment._pendingRequests.set(url, {
    request,
    timestamp,
    abort: clearCache,
  })

  // --- (3) 完了時に自動クリーンアップ ---
  return request.finally(clearCache)
}
```

無効化はモジュールグラフ側で `lastInvalidationTimestamp` を更新することで行われる:

```typescript
// packages/vite/src/node/server/moduleGraph.ts:166-201
invalidateModule(
  mod: EnvironmentModuleNode,
  seen: Set<EnvironmentModuleNode> = new Set(),
  timestamp: number = monotonicDateNow(),
  isHmr: boolean = false,
  softInvalidate = false,
): void {
  // ...
  if (isHmr) {
    mod.lastHMRTimestamp = timestamp
  } else {
    // 無効化タイムスタンプを記録 → 進行中の処理結果のキャッシュを防ぐ
    mod.lastInvalidationTimestamp = timestamp
  }
  // ...
}
```

変換結果をキャッシュに保存する際も、タイムスタンプで二重チェックする:

```typescript
// packages/vite/src/node/server/transformRequest.ts:435-436
// 処理中に無効化されていなければ結果をキャッシュする
if (timestamp > mod.lastInvalidationTimestamp)
  moduleGraph.updateModuleTransformResult(mod, result)
```

## Good Example

タイムスタンプ検証付きの Promise Coalescing。無効化との競合を安全に処理する。

```typescript
// packages/vite/src/node/server/transformRequest.ts:109-146
const pending = environment._pendingRequests.get(url)
if (pending) {
  return environment.moduleGraph.getModuleByUrl(url).then((module) => {
    if (!module || pending.timestamp > module.lastInvalidationTimestamp) {
      // The pending request is still valid, we can safely reuse its result
      return pending.request
    } else {
      // Request 1 for module A     (pending.timestamp)
      // Invalidate module A        (module.lastInvalidationTimestamp)
      // Request 2 for module A     (timestamp)

      // First request has been invalidated, abort it to clear the cache,
      // then perform a new doTransform.
      pending.abort()
      return transformRequest(environment, url, options)
    }
  })
}

const request = doTransform(environment, url, options, timestamp)

// Avoid clearing the cache of future requests if aborted
let cleared = false
const clearCache = () => {
  if (!cleared) {
    environment._pendingRequests.delete(url)
    cleared = true
  }
}

// Cache the request and clear it once processing is done
environment._pendingRequests.set(url, {
  request,
  timestamp,
  abort: clearCache,
})

return request.finally(clearCache)
```

ポイント:
- `pending.timestamp > module.lastInvalidationTimestamp` で結果の有効性を検証
- `abort()` で無効化されたリクエストの Map エントリを即座にクリア
- `clearCache` 内の `cleared` フラグで二重削除を防止
- `finally` による確実なクリーンアップ（成功・失敗どちらでも実行）

## Bad Example

無効化検証なしの素朴な Promise Coalescing。古い結果を返してしまうリスクがある。

```typescript
// Bad: 無効化を考慮しない実装
const pendingRequests = new Map<string, Promise<Result>>()

function processRequest(url: string): Promise<Result> {
  const pending = pendingRequests.get(url)
  if (pending) {
    // 危険: pending 中にリソースが無効化されていても古い結果を返す
    return pending
  }

  const request = doExpensiveWork(url)
  pendingRequests.set(url, request)

  return request.finally(() => {
    pendingRequests.delete(url)
  })
}
```

この実装の問題点:
- **古いデータの利用**: リクエスト処理中にリソースが変更されても、古い結果がそのまま返される
- **abort 機構の欠如**: 無効化された処理を中断する手段がない
- **整合性の破綻**: HMR のような頻繁な更新がある環境では、ブラウザに古いコードが配信される

## 適用ガイド

### どのような状況で使うべきか

- **同一キーへの並行リクエストが高頻度で発生する場合**: HTTP サーバーのリクエスト処理、モジュールバンドラの変換パイプライン、API ゲートウェイのリクエスト合流など
- **処理コストが高い非同期操作**: ファイル変換、データベースクエリ、外部 API 呼び出しなど、重複実行を避けたい処理
- **処理中に入力データが変更される可能性がある場合**: ファイル監視、リアルタイム更新、キャッシュ無効化が伴うシステム

### 導入時の注意点

- **冪等性の前提**: 同じ入力に対して同じ結果を返す処理にのみ適用する。副作用のある処理（データベース書き込み等）には使わない
- **タイムスタンプの単調増加**: `Date.now()` は OS の時刻調整で巻き戻る可能性がある。Vite は `monotonicDateNow()` で単調増加を保証している
- **メモリリーク防止**: `finally` での確実なクリーンアップが必須。エラー時にも Map からエントリが削除されることを保証する
- **二重削除の防止**: `abort()` と `finally` の両方から削除が呼ばれうるため、`cleared` フラグのようなガードが必要

### カスタマイズポイント

- **無効化の粒度**: Vite はタイムスタンプ比較だが、バージョン番号やハッシュ値での検証も可能
- **abort の実装**: Vite では Map からの削除のみだが、`AbortController` と組み合わせて実際の処理を中断することもできる
- **TTL の追加**: 長時間 pending のままになるリクエストに対してタイムアウトを設定することで、デッドロックを防止できる
- **キャッシュ結果の保存判定**: 処理完了時にも `timestamp > lastInvalidationTimestamp` を再チェックし、処理中に無効化された結果をキャッシュしない

## 参考

- [repos/vitejs/vite/concurrency-patterns.md](../repos/vitejs/vite/concurrency-patterns.md) — リクエスト重複排除、デバウンス、キャンセル可能な非同期処理などの並行制御パターン分析
- [repos/vitejs/vite/performance-techniques.md](../repos/vitejs/vite/performance-techniques.md) — Promise Coalescing を含む多層キャッシュ戦略とパフォーマンス最適化手法の分析
