# performance-techniques

> リポジトリ: vitejs/vite
> 分析日: 2026-02-17

## 概要

Vite の開発サーバーにおけるパフォーマンス最適化手法を横断的に分析する。依存関係のプリバンドル、変換結果のキャッシュ、リクエスト重複排除、プラグインフックのフィルタリング、遅延インポート、プリウォームアップ、ソフト無効化など、複数のレイヤーに渡る最適化が体系的に実装されている。これらは「開発時の体感速度を最大化しつつ、ページの完全リロードを最小化する」という一貫した設計思想に基づいている。

## 背景にある原則

- **投機的先行処理と遅延実行の二層構造**: 確実に使われるもの（静的インポート依存）は先行してプリバンドル・プリウォームし、不確実なもの（動的インポート、CLI サブコマンド）は使用時まで遅延する。両者を組み合わせることで起動速度とリソース効率を両立する（`optimizer/optimizer.ts` の crawl-then-discover 戦略、`cli.ts` の `await import('./server')` パターン）
- **無効化コストの最小化**: 変更が発生したときに「全体を再計算する」のではなく「影響範囲を限定する」。ソフト無効化はインポートタイムスタンプの書き換えだけで済ませ、完全な再変換を回避する（`moduleGraph.ts:180-186`）
- **重複作業の排除**: 同一リソースへの並行リクエストを単一の処理に合流させ、結果を共有する。これは HTTP レイヤー（ETag/304）、変換レイヤー（`_pendingRequests`）、依存最適化レイヤー（debounce による batch 処理）の各段階で適用される
- **計測コードのゼロコスト化**: デバッグ・計測コードそのものがホットパスの性能を劣化させないよう、条件付き実行で完全に除去する（`debug?.()` パターン、`debugLoad ? performance.now() : 0`）

## 実例と分析

### 1. 依存関係プリバンドルと段階的最適化

Vite の依存オプティマイザはコールドスタート時に「スキャン → プリバンドル → クロール → 再バンドル（必要時のみ）」という段階的パイプラインを実行する。

```typescript
// packages/vite/src/node/optimizer/optimizer.ts:196-271
// スキャンはバックグラウンドで並行実行される
depsOptimizer.scanProcessing = new Promise((resolve) => {
  (async () => {
    try {
      discover = discoverProjectDependencies(
        devToScanEnvironment(environment),
      );
      deps = await discover.result;
      // ...
      optimizationResult = runOptimizeDeps(environment, knownDeps);

      // holdUntilCrawlEnd 戦略でなければ、スキャン完了時点で結果をブラウザに提供
      if (!holdUntilCrawlEnd) {
        optimizationResult.result.then((result) => {
          if (!waitingForCrawlEnd) return;
          runOptimizer(result);
        });
      }
    } finally {
      resolve();
    }
  })();
});
```

`holdUntilCrawlEnd` オプション（デフォルト `true`）により、静的インポートのクロールが完了するまでバンドル結果の確定を遅延させ、フルページリロードを回避する。スキャナが見逃した依存が後から発見された場合でも、debounce（100ms）で batch 化して再バンドルを一度で済ませる。

### 2. 変換リクエストの重複排除

```typescript
// packages/vite/src/node/server/transformRequest.ts:109-146
const pending = environment._pendingRequests.get(url);
if (pending) {
  return environment.moduleGraph.getModuleByUrl(url).then((module) => {
    if (!module || pending.timestamp > module.lastInvalidationTimestamp) {
      // 保留中のリクエストがまだ有効 → 結果を再利用
      return pending.request;
    } else {
      // 保留中のリクエストが無効化された → キャッシュを破棄して再処理
      pending.abort();
      return transformRequest(environment, url, options);
    }
  });
}

const request = doTransform(environment, url, options, timestamp);
environment._pendingRequests.set(url, {
  request,
  timestamp,
  abort: clearCache,
});
return request.finally(clearCache);
```

同一 URL への並行リクエストは `_pendingRequests` Map で追跡され、先行リクエストの Promise を返すことで重複変換を防ぐ。ただし、無効化タイムスタンプとの比較により、古い結果を誤ってキャッシュしない安全性を確保している。

### 3. ETag ベースの多層キャッシュ

```typescript
// packages/vite/src/node/server/middlewares/transform.ts:70-103
// 第1層: ETag による即時 304 応答（ミドルウェアチェーンを短絡）
export function cachedTransformMiddleware(server: ViteDevServer) {
  return function viteCachedTransformMiddleware(req, res, next) {
    const ifNoneMatch = req.headers["if-none-match"];
    if (ifNoneMatch) {
      const moduleByEtag = environment.moduleGraph.getModuleByEtag(ifNoneMatch);
      if (moduleByEtag?.transformResult?.etag === ifNoneMatch) {
        res.statusCode = 304;
        return res.end();
      }
    }
    next();
  };
}

// packages/vite/src/node/server/middlewares/transform.ts:259-263
// 第2層: 最適化済み依存は immutable キャッシュヘッダ
cacheControl: isDep ? "max-age=31536000,immutable" : "no-cache";
```

`etagToModuleMap` により ETag からモジュールへの O(1) 逆引きを可能にし、`cachedTransformMiddleware` を変換ミドルウェアの前に配置して 304 応答を高速に返す。プリバンドル済み依存にはバージョンハッシュ付き URL で `immutable` キャッシュを適用する。

### 4. プラグインフックのフィルタリング

```typescript
// packages/vite/src/node/plugins/index.ts:200-241
const filterForPlugin = new WeakMap<Plugin, FilterForPluginValue>();

export function getCachedFilterForPlugin<
  H extends "resolveId" | "load" | "transform",
>(plugin: Plugin, hookName: H): FilterForPluginValue[H] | undefined {
  let filters = filterForPlugin.get(plugin);
  if (filters && hookName in filters) {
    return filters[hookName]; // キャッシュ済みフィルタを返す
  }
  // ... フィルタを初回のみ構築し WeakMap にキャッシュ
}

// packages/vite/src/node/server/pluginContainer.ts:398-399
// resolveId ループ内でフィルタを適用し、不要なプラグイン呼び出しをスキップ
const filter = getCachedFilterForPlugin(plugin, "resolveId");
if (filter && !filter(rawId)) continue;
```

各プラグインの `filter` 宣言（ID パターン、コード内容、モジュールタイプ）を WeakMap にキャッシュし、フックのループ内で早期スキップする。プラグイン数が多い大規模プロジェクトでの transform パイプラインの高速化に寄与する。

### 5. ソフト無効化によるインクリメンタル更新

```typescript
// packages/vite/src/node/server/moduleGraph.ts:166-231
invalidateModule(mod, seen, timestamp, isHmr, softInvalidate = false) {
  if (softInvalidate) {
    // 以前の transformResult を保持 → インポートタイムスタンプの書き換えだけで済む
    mod.invalidationState ??= mod.transformResult ?? 'HARD_INVALIDATED'
  } else {
    mod.invalidationState = 'HARD_INVALIDATED'
  }
  // ...
  mod.importers.forEach((importer) => {
    // 静的インポートの上流は再帰的にソフト無効化
    const shouldSoftInvalidateImporter =
      (importer.staticImportedUrls?.has(mod.url) || softInvalidate) &&
      importer.type === 'js'
    this.invalidateModule(importer, seen, timestamp, isHmr, shouldSoftInvalidateImporter)
  })
}
```

HMR 時に変更されたモジュールの直接のインポーターは「ソフト無効化」され、前回の変換結果を保持したままインポートタイムスタンプだけを更新する。これにより、完全な再変換を避けてブラウザに高速に配信できる。

### 6. CLI の遅延インポートによる起動高速化

```typescript
// packages/vite/src/node/cli.ts:214
const { createServer } = await import("./server");

// packages/vite/src/node/cli.ts:348
const { createBuilder } = await import("./build");

// packages/vite/src/node/cli.ts:441
const { preview } = await import("./preview");
```

CLI エントリは各サブコマンドの実装を動的インポートで遅延ロードする。`vite dev` 実行時に `build` や `preview` のモジュール解析・評価コストを負わない。Node.js 起動時間に直結するパターン。

### 7. 計測コードのゼロコスト化

```typescript
// packages/vite/src/node/server/transformRequest.ts:263,352
const loadStart = debugLoad ? performance.now() : 0;
// ...
const transformStart = debugTransform ? performance.now() : 0;

// packages/vite/src/node/server/pluginContainer.ts:390,433
const resolveStart = debugResolve ? performance.now() : 0;
```

`createDebugger()` は DEBUG 環境変数が設定されていないとき `undefined` を返す。`debugLoad ? performance.now() : 0` により、デバッグ無効時は `performance.now()` 呼び出し自体を回避する。`debug?.()` のオプショナルチェーンも同様にゼロコスト化する。

### 8. プリウォームアップ

```typescript
// packages/vite/src/node/server/warmup.ts:10-19
export function warmupFiles(server, environment): void {
  mapFiles(environment.config.dev.warmup, root).then((files) => {
    for (const file of files) {
      warmupFile(server, environment, file);
    }
  });
}

// packages/vite/src/node/plugins/importAnalysis.ts:675-684
// 静的インポートを発見した時点で先行変換
if (!isDynamicImport && isLocalImport && environment.config.dev.preTransformRequests) {
  const url = removeImportQuery(hmrUrl);
  environment.warmupRequest(url);
}
```

2つのレベルでプリウォームを実行する。(1) 設定ファイルで指定されたファイルをサーバー起動時に先行変換。(2) モジュールの静的インポートを解析した時点で、ブラウザがリクエストする前に先行変換を開始する（`preTransformRequests`）。

## パターンカタログ

- **Promise Coalescing** (分類: 振る舞い/並行制御)
  - 解決する問題: 同一リソースへの並行リクエストによる重複処理
  - 適用条件: 同一キーに対する非同期処理が並行して発生しうる場合
  - コード例: `packages/vite/src/node/server/transformRequest.ts:109-146`
  - 注意点: 無効化との競合を考慮し、タイムスタンプ比較で古い結果の利用を防ぐ必要がある

- **Speculative Execution** (分類: 振る舞い/最適化)
  - 解決する問題: ブラウザがリクエストしてから変換を開始すると遅い
  - 適用条件: 次に必要になるリソースが高い確率で予測できる場合
  - コード例: `packages/vite/src/node/plugins/importAnalysis.ts:675-684`
  - 注意点: 投機的処理の失敗はサイレントに無視する必要がある（`warmupRequest` の catch 処理）

## Good Patterns

- **条件付き計測のゼロコスト化**: `const start = debug ? performance.now() : 0` により、デバッグモードでないときは計測呼び出しそのものをスキップする。`debug?.()` のオプショナルチェーンと組み合わせて、本番パスに一切のオーバーヘッドを残さない。

```typescript
// packages/vite/src/node/server/transformRequest.ts:246-247
const prettyUrl = debugLoad || debugTransform ? prettifyUrl(url, config.root) : "";
```

- **WeakMap によるプラグインフィルタのキャッシュ**: プラグインオブジェクトをキーとした WeakMap でフィルタ関数をキャッシュし、プラグインが GC されればフィルタも自動回収される。ホットパスでのフィルタ再構築を避けつつ、メモリリークも防ぐ。

```typescript
// packages/vite/src/node/plugins/index.ts:200
const filterForPlugin = new WeakMap<Plugin, FilterForPluginValue>();
```

- **Debounce による依存発見の batch 化**: 新しい依存が発見されるたびに即座に再バンドルせず、100ms の debounce で追加の依存発見を待つ。これにより、短時間に複数の依存が発見される典型的なコールドスタートで再バンドル回数を最小化する。

```typescript
// packages/vite/src/node/optimizer/optimizer.ts:615-628
function debouncedProcessing(timeout = debounceMs) {
  if (debounceProcessingHandle) clearTimeout(debounceProcessingHandle);
  debounceProcessingHandle = setTimeout(() => {
    debounceProcessingHandle = undefined;
    enqueuedRerun = rerun;
    if (!currentlyProcessing) {
      enqueuedRerun();
    }
  }, timeout);
}
```

## Anti-Patterns / 注意点

- **無効化チェックなしのキャッシュ再利用**: 並行リクエストの結果を共有する際、無効化タイムスタンプを確認しないと古い変換結果をキャッシュに残してしまう。

```typescript
// Bad: 無効化を考慮しない
const pending = pendingRequests.get(url);
if (pending) return pending.request;

// Better: タイムスタンプで無効化を検出（Vite の実装）
if (pending) {
  const module = await moduleGraph.getModuleByUrl(url);
  if (!module || pending.timestamp > module.lastInvalidationTimestamp) {
    return pending.request; // まだ有効
  } else {
    pending.abort(); // 無効化された → 再処理
    return transformRequest(url);
  }
}
```

- **投機的処理の失敗を伝搬する**: プリウォームアップは「失敗してもブラウザの正常リクエストで再試行される」ため、エラーを握り潰すのが正しい。投機的処理のエラーを呼び出し元に伝搬すると、サーバーの安定性を損なう。

```typescript
// Bad: プリウォームのエラーをそのまま throw
await transformRequest(url)

// Better: 期待されるエラーを catch してログに留める（Vite の実装）
async warmupRequest(url: string): Promise<void> {
  try {
    await this.transformRequest(url)
  } catch (e) {
    if (e?.code === ERR_OUTDATED_OPTIMIZED_DEP || e?.code === ERR_CLOSED_SERVER) {
      return  // 期待されるエラー
    }
    this.logger.error(...)  // 予期しないエラーはログのみ
  }
}
```

## 導出ルール

- `[MUST]` 並行リクエストの重複排除（Promise Coalescing）を行う場合、キャッシュされた結果の有効性を検証する仕組み（タイムスタンプ・バージョン比較）を組み合わせること
  - 根拠: Vite は `_pendingRequests` の結果を返す前に `lastInvalidationTimestamp` と比較し、古い結果の利用を防いでいる（`transformRequest.ts:112`）
- `[MUST]` 投機的先行処理（プリフェッチ・プリウォーム等）のエラーは呼び出し元に伝搬せず、サイレントに処理するか警告レベルのログに留めること
  - 根拠: Vite の `warmupRequest` は期待されるエラーを catch し、予期しないエラーはログ出力のみとする（`environment.ts:238-257`）
- `[SHOULD]` ホットパスのデバッグ・計測コードは条件付き実行で完全にゼロコスト化すること。`const start = debug ? performance.now() : 0` + `debug?.(...)` パターンを使う
  - 根拠: Vite はすべての transform/resolve/load パスで `createDebugger` が `undefined` を返す場合に計測呼び出しを回避する（`transformRequest.ts:263`, `pluginContainer.ts:390`）
- `[SHOULD]` 短時間に連続する同種の操作は debounce で batch 化し、処理回数を最小化すること。特に I/O やバンドル処理など高コスト操作で有効
  - 根拠: Vite の依存オプティマイザは 100ms の debounce で新依存の発見を待ち、再バンドル回数を最小化する（`optimizer.ts:38,615-628`）
- `[SHOULD]` HTTP レスポンスのキャッシュ戦略は、不変コンテンツ（バージョンハッシュ付き URL）には `immutable`、変更可能コンテンツには `no-cache` + ETag の二分法を適用すること
  - 根拠: Vite はプリバンドル済み依存に `max-age=31536000,immutable` を、ユーザーコードに `no-cache` + ETag を適用する（`transform.ts:263`）
- `[SHOULD]` CLI エントリポイントではサブコマンドの実装を動的 `import()` で遅延ロードし、使用されないモジュールの評価コストを排除すること
  - 根拠: Vite の CLI は `dev`, `build`, `preview`, `optimize` 各コマンドの実装をアクションハンドラ内で動的インポートする（`cli.ts:214,348,441`）
- `[AVOID]` 変更検出時にモジュールグラフ全体を一括無効化すること。影響範囲を追跡し、変更が波及しないモジュールの変換結果を保持する
  - 根拠: Vite のソフト無効化は静的インポートの上流に限定してインポートタイムスタンプのみ更新し、完全な再変換を回避する（`moduleGraph.ts:180-231`）

## 適用チェックリスト

- [ ] 同一リソースへの並行リクエストが発生する箇所で Promise Coalescing を実装しているか。キャッシュの有効性検証も含めて確認する
- [ ] デバッグ・計測コードがホットパスでゼロコストになっているか。`performance.now()` や文字列生成がデバッグ無効時にも実行されていないか確認する
- [ ] CLI やアプリケーションの起動パスで、使用されないモジュールの遅延ロードが適用されているか確認する
- [ ] HMR やファイル変更時の無効化が最小範囲に限定されているか。不要なモジュールの再変換が発生していないか確認する
- [ ] HTTP キャッシュ戦略が「不変コンテンツは immutable」「変更可能コンテンツは ETag + no-cache」の二分法に従っているか確認する
- [ ] 短時間に連続する高コスト操作（バンドル、ファイル書き込み等）に debounce/batch 化が適用されているか確認する
- [ ] プラグインやフック等の拡張ポイントにフィルタリング機構があり、不要な呼び出しをスキップしているか確認する
