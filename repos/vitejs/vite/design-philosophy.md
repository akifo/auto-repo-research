# design-philosophy

> リポジトリ: vitejs/vite
> 分析日: 2026-02-17

## 概要

Vite の設計哲学を「速度と DX の両立」という軸で分析する。Vite は Native ESM・ネイティブツールチェーン・プラグインシステムという3層で速度を確保しつつ、「オプションを増やさない」「ブラウザに仕事を委譲する」「devDependencies をバンドルする」等の意図的なトレードオフ選択で DX と保守性を維持している。Rolldown 統合世代（v8）に至る設計判断の連続性と、「Pragmatic Performance」という公式哲学の具体的な実装パターンを横断的に抽出する。

## 背景にある原則

- **Lean Extendable Core（薄いコアを拡張で補う）**: 機能をコアに追加するのではなくプラグインシステムに委譲することで、API 表面積を最小化し保守コストを抑える。CONTRIBUTING.md の "Think Before Adding Yet Another Option" セクションが明文化している。新オプション追加前に「smarter default で解決できないか」「既存オプションで代替できないか」「プラグインで対処できないか」を問う設計原則。
  - 根拠: `CONTRIBUTING.md:76-84`, `.github/copilot-instructions.md:29`

- **ブラウザへの仕事委譲（Let the Browser Do More Work）**: dev サーバーでは Native ESM を活用し、モジュール解決の一部をブラウザに委ねる。HTTP ヘッダ（304 Not Modified, `Cache-Control: immutable`）でキャッシュ戦略もブラウザに任せる。サーバー側の処理量を最小化しつつ、スケーラビリティを確保する。
  - 根拠: `docs/guide/why.md:25-42`

- **Pragmatic Performance（実用主義的パフォーマンス）**: 全てをネイティブツールに置き換えるのではなく、「ホットパス（パース・変換・バンドル）はネイティブツール、それ以外は JS」という戦略を採る。柔軟性（プラグインエコシステム互換）と速度のトレードオフを意識的に選択している。
  - 根拠: `docs/guide/philosophy.md:17-19`

- **依存の最小化と軽量配布**: devDependencies をビルド時にバンドルし、ランタイム dependencies を最小限に保つ。重い transitive dependency を持つパッケージを避け、軽量な代替を選ぶか自前実装する。
  - 根拠: `packages/vite/package.json:74` — `"//": "READ CONTRIBUTING.md to understand what to put under deps vs. devDeps!"`

## 実例と分析

### 1. devDependencies バンドル戦略

Vite は大部分の依存を devDependencies に置き、`rolldown.config.ts` でバンドルして配布する。`package.json` の `dependencies` には `rolldown`, `postcss`, `lightningcss`, `picomatch`, `tinyglobby`, `@oxc-project/runtime` の6パッケージのみが残る。

この戦略には制約がある。CONTRIBUTING.md が明示するように、バンドル後は `require('somedep')` が機能しないため、遅延ロードには `(await import('somedep')).default` パターンを使う必要がある。

```typescript
// packages/vite/src/node/plugins/css.ts:1701-1702
// postcss is an unbundled dep and should be lazy imported
postcssResult = await postcss.default(plugins).process(code, { ... })
```

さらに `rolldown.config.ts` では `shimDepsPlugin` で依存の内部コードを書き換え、不要な transitive dependency（`resolve`, `read-cache`）を除去している。

```typescript
// packages/vite/rolldown.config.ts:109-118
'postcss-import/index.js': [
  {
    src: 'const resolveId = require("./lib/resolve-id")',
    replacement: 'const resolveId = (id) => id',
  },
  {
    src: 'const loadContent = require("./lib/load-content")',
    replacement: 'const loadContent = () => ""',
  },
],
```

### 2. ネイティブツールへの段階的移行

`nativePluginEnabledLevel` によるフィーチャーフラグで、JS 実装とネイティブ実装を段階的に切り替える。OXC Transform、Alias、JSON、WASM、Define、Manifest、Reporter 等のプラグインにこのパターンが適用されている。

```typescript
// packages/vite/src/node/plugins/oxc.ts:211-238
export function oxcPlugin(config: ResolvedConfig): Plugin {
  if (config.isBundled && config.nativePluginEnabledLevel >= 1) {
    return perEnvironmentPlugin('native:transform', (environment) => {
      // ... ネイティブ実装を返す
      return nativeTransformPlugin({ ... })
    })
  }
  // JS フォールバック実装が続く
}
```

`perEnvironmentPlugin` は環境（client/ssr/scan）ごとに異なるプラグインインスタンスを生成するファクトリで、Environment API と組み合わせて使う。

### 3. 304 ETag による高速キャッシュ

dev サーバーの `cachedTransformMiddleware` はリクエストチェーンの最上流で ETag を検証し、モジュールグラフのキャッシュにヒットすれば即座に 304 を返す。

```typescript
// packages/vite/src/node/server/middlewares/transform.ts:70-103
export function cachedTransformMiddleware(server: ViteDevServer): Connect.NextHandleFunction {
  return function viteCachedTransformMiddleware(req, res, next) {
    const ifNoneMatch = req.headers['if-none-match']
    if (ifNoneMatch) {
      const moduleByEtag = environment.moduleGraph.getModuleByEtag(ifNoneMatch)
      if (moduleByEtag?.transformResult?.etag === ifNoneMatch
          && moduleByEtag.url === req.url) {
        res.statusCode = 304
        return res.end()
      }
    }
    next()
  }
}
```

`send` 関数ではデフォルトで `Cache-Control: no-cache` を設定し、ブラウザに条件付きリクエストを強制する。

### 4. Module Runner のバンドルサイズ制限

`rolldown.config.ts` で module-runner チャンクに 54kB のサイズ制限を設けている。ビルド時にサイズを超過するとエラーになる。これは軽量性を維持するためのガードレール。

```typescript
// packages/vite/rolldown.config.ts:150
plugins: [bundleSizeLimit(54), enableSourceMapsInWatchModePlugin()],
```

### 5. オプション抑制の原則

CONTRIBUTING.md と copilot-instructions.md の両方に、新しい config オプション追加時のチェックリストが記載されている。

```
We already have many config options, and we should avoid fixing an issue
by adding yet another one. Before adding an option, consider whether the problem:
- is really worth addressing
- can be fixed with a smarter default
- has workaround using existing options
- can be addressed with a plugin instead
```

`defineConfig` はゼロ設定で動作するよう設計されており、`DEFAULT_*` 定数群（`DEFAULT_EXTENSIONS`, `DEFAULT_CLIENT_MAIN_FIELDS`, `ESBUILD_BASELINE_WIDELY_AVAILABLE_TARGET` 等）が合理的なデフォルトを提供する。

### 6. 段階的非推奨と移行パス

`deprecations.ts` が非推奨 API の管理を一元化している。`warnFutureDeprecation` は `config.future` オプションにより `'warn'` モードで警告を出すか制御でき、移行ドキュメントへの URL を自動生成する。

```typescript
// packages/vite/src/node/deprecations.ts:55-97
export function warnFutureDeprecation(
  config: ResolvedConfig,
  type: keyof FutureOptions,
  extraMessage?: string,
  stacktrace = true,
): void {
  // ... 警告メッセージ + ドキュメント URL + スタックトレース
  const docs = `${docsURL}/changes/${deprecationCode[type].toLowerCase()}`
}
```

## パターンカタログ

- **Strategy Pattern** (分類: 振る舞い)
  - 解決する問題: JS 実装とネイティブ実装の切り替えを環境ごとに制御する
  - 適用条件: 同一インターフェースで複数の実装を動的に選択する必要がある場合
  - コード例: `packages/vite/src/node/plugins/oxc.ts:211-238` — `nativePluginEnabledLevel` によるディスパッチ
  - 注意点: フィーチャーフラグの粒度が粗いと、部分的なロールバックが困難になる

- **Proxy Pattern** (分類: 構造)
  - 解決する問題: 環境固有の設定とグローバル設定を透過的にマージする
  - 適用条件: 階層的な設定オブジェクトで、子が親のプロパティにフォールバックする必要がある場合
  - コード例: `packages/vite/src/node/baseEnvironment.ts:47-59` — `Proxy` で `environment.config` を合成
  - 注意点: デバッグ時にプロパティの出自が不明瞭になりうる

## Good Patterns

- **バンドルサイズのガードレール**: `bundleSizeLimit` プラグインで module-runner の出力サイズを CI で強制チェックする。閾値超過でビルドが失敗するため、意図しない依存追加による肥大化を防止する。
  ```typescript
  // packages/vite/rolldown.config.ts:377-405
  function bundleSizeLimit(limit: number): Plugin {
    return {
      name: 'bundle-limit',
      generateBundle(_, bundle) {
        size = Buffer.byteLength(
          Object.values(bundle).map((i) => ('code' in i ? i.code : '')).join(''), 'utf-8',
        )
      },
      closeBundle() {
        if (kb > limit) {
          this.error(`Bundle size exceeded ${limit} kB, current size is ${kb.toFixed(2)}kb.`)
        }
      },
    }
  }
  ```

- **遅延インポートによる起動時間最適化**: `terser`, `sass`, `less`, `stylus`, `postcss` 等のオプショナル依存を使用時まで `await import()` で遅延ロードする。起動時に不要なモジュールの読み込みを避ける。
  ```typescript
  // packages/vite/src/node/plugins/terser.ts:96-97
  // Lazy load worker.
  worker ||= makeWorker()
  ```

- **重複リクエスト抑制**: `transformRequest` で同一 URL のリクエストが並行して到着した場合、2つ目以降は最初のリクエストの Promise を再利用する。無効化タイムスタンプとの比較で古いリクエストを適切に破棄する。
  ```typescript
  // packages/vite/src/node/server/transformRequest.ts:109-146
  const pending = environment._pendingRequests.get(url)
  if (pending) {
    return environment.moduleGraph.getModuleByUrl(url).then((module) => {
      if (!module || pending.timestamp > module.lastInvalidationTimestamp) {
        return pending.request
      } else {
        pending.abort()
        return transformRequest(environment, url, options)
      }
    })
  }
  ```

## Anti-Patterns / 注意点

- **transitive dependency の爆発**: `http-proxy-middleware` のような、本体は小さいが transitive dependency が巨大なパッケージを安易に採用すると、配布サイズが数倍になる。CONTRIBUTING.md が具体例で警告している。
  - Bad: `http-proxy-middleware`（本体 380kB + 依存で 3MB）
  - Better: `http-proxy` に対する最小限のカスタムミドルウェア（数行のコード）

- **設定オプションの肥大化**: 問題をオプション追加で解決しようとすると、設定の組み合わせ爆発が起き、テスト・ドキュメント・保守コストが指数的に増加する。
  - Bad: 個別のエッジケースごとにフラグを追加する
  - Better: スマートデフォルト、既存オプションの活用、プラグインによる外部化

## 導出ルール

- `[MUST]` ランタイム dependencies は最小限にし、開発時依存はビルド時にバンドルして配布する — transitive dependency によるサイズ膨張とバージョン衝突を防止する
  - 根拠: Vite の dependencies は 6 パッケージのみ、残り 40+ は devDependencies としてバンドル（`packages/vite/package.json`）

- `[MUST]` パフォーマンスに影響するバンドルサイズには CI で自動ガードレールを設ける — 閾値超過をビルドエラーにすることで、意図しない肥大化を早期検出する
  - 根拠: `rolldown.config.ts:150` で module-runner に 54kB 上限を設定

- `[SHOULD]` オプショナルな重い依存は使用時まで遅延インポートし、起動時間を最適化する — `await import()` パターンでコールドスタートのコストを使用パスに分散する
  - 根拠: terser, sass, postcss 等が全て遅延ロードされている（`plugins/terser.ts:97`, `plugins/css.ts:1701`）

- `[SHOULD]` 新しいオプションを追加する前に「スマートデフォルトで解決できないか」「プラグインで対処できないか」を検証する — API 表面積の肥大化は保守コストと設定の組み合わせ爆発を招く
  - 根拠: `CONTRIBUTING.md:76-84` の "Think Before Adding Yet Another Option"

- `[SHOULD]` ネイティブツールへの移行はフィーチャーフラグで段階的に行い、JS フォールバックを維持する — エコシステム互換性を壊さず、パフォーマンス改善を漸進的に導入する
  - 根拠: `nativePluginEnabledLevel` による JS/ネイティブ切り替え（`plugins/oxc.ts:211-212`）

- `[SHOULD]` 非推奨 API は一元管理し、移行ドキュメント URL 付きの警告を出す — ユーザーに段階的な移行パスを提供しつつ、内部で非推奨コードの管理コストを低減する
  - 根拠: `deprecations.ts` で全非推奨の定義・メッセージ・URL を集中管理

- `[AVOID]` transitive dependency が本体より大きいパッケージの採用 — 機能に対してサイズが不釣り合いな依存は、最小限のラッパーで代替する
  - 根拠: `CONTRIBUTING.md:64` の http-proxy-middleware の例（380kB → 3MB）

## 適用チェックリスト

- [ ] プロジェクトの `dependencies` と `devDependencies` を棚卸しし、ランタイムに不要な依存が `dependencies` に入っていないか確認する
- [ ] 配布バンドルのサイズに上限ガードレール（CI チェック）を設けているか確認する
- [ ] オプショナルな重い依存（linter, formatter, CSS preprocessor 等）が遅延ロードされているか確認する
- [ ] 新しい設定オプションを追加する前に「スマートデフォルト」「既存オプション」「プラグイン」で解決できないか検証するプロセスがあるか確認する
- [ ] ネイティブツールへの移行を計画する場合、フィーチャーフラグによる段階的導入の仕組みを設計しているか確認する
- [ ] 非推奨 API の管理が一元化されており、移行ドキュメントへのリンクが警告に含まれているか確認する
