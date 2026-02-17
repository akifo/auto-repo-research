# practice: api-lifecycle

> 出典: repos/vitejs/vite からの分析
> カテゴリ: practice

## 概要

`experimental` → 安定 → `future`（非推奨予告）→ `legacy` → 削除の三層 API ライフサイクル管理パターン。`UserConfig`（optional）→ `ResolvedConfig`（required）の型状態分離と組み合わせ、getter trap で非推奨プロパティへのアクセスを検知し、移行ドキュメント URL 付き警告を自動発行する。大規模エコシステム（78k+ stars、数万プラグイン）で破壊的変更を安全に導入するための体系的な手法であり、API を進化させ続ける必要があるライブラリ・フレームワーク全般に適用できる。

## 背景・文脈

Vite は esbuild/Rollup から Rolldown/Oxc へのバンドラー移行という大規模な基盤技術の入れ替えを進めている。数万のプラグインとフレームワークが Vite の API に依存しているため、一夜にして API を変更することは不可能である。この制約の中で、Vite は API の成熟度を `ExperimentalOptions`、`FutureOptions`、`LegacyOptions` の3つの型で構造的に表現し、semver との対応関係を JSDoc で明示する仕組みを構築した。さらに、非推奨プロパティへのアクセスを getter trap で検知し、「何が非推奨か」「どう移行するか」「どこで使われているか」の3点を一度に提供する警告システムを実装している。

## 実装パターン

### 1. 三層 API ライフサイクル型

API の成熟度を3つのインターフェースで構造的に分離する。各層には semver との対応規約を JSDoc で明記する。

```typescript
// packages/vite/src/node/config.ts:547-614
export interface ExperimentalOptions {
  // semver に従わない。ピン留め推奨
  importGlobRestoreExtension?: boolean
  enableNativePlugin?: boolean | 'v1' | 'v2'
  bundledDev?: boolean
}

export interface FutureOptions {
  // 次期メジャーで削除予定の API に対する事前警告
  removePluginHookHandleHotUpdate?: 'warn'
  removePluginHookSsrArgument?: 'warn'
  removeServerModuleGraph?: 'warn'
  removeServerReloadModule?: 'warn'
  removeServerPluginContainer?: 'warn'
  removeServerHot?: 'warn'
  removeServerTransformRequest?: 'warn'
  removeServerWarmupRequest?: 'warn'
  removeSsrLoadModule?: 'warn'
}

export interface LegacyOptions {
  // パッチ版でのみ semver に従う。マイナーで削除される可能性
  skipWebSocketTokenCheck?: boolean
  inconsistentCjsInterop?: boolean
}
```

UserConfig にはこれらが optional フィールドとして配置され、`future` には `'warn'` ショートカットも用意されている。

```typescript
// packages/vite/src/node/config.ts:420-438
export interface UserConfig extends DefaultEnvironmentOptions {
  experimental?: ExperimentalOptions
  future?: FutureOptions | 'warn'  // 'warn' で全非推奨警告を一括有効化
  legacy?: LegacyOptions
  // ...
}
```

### 2. 非推奨メタデータの構造化と型安全な網羅性保証

非推奨項目ごとにドキュメントコードとメッセージを `satisfies Record<keyof FutureOptions, string>` で管理する。`FutureOptions` にキーを追加すると、対応表への追加漏れがコンパイルエラーになる。

```typescript
// packages/vite/src/node/deprecations.ts:1-40
const deprecationCode = {
  removePluginHookSsrArgument: 'this-environment-in-hooks',
  removePluginHookHandleHotUpdate: 'hotupdate-hook',
  removeServerModuleGraph: 'per-environment-apis',
  removeServerReloadModule: 'per-environment-apis',
  removeServerPluginContainer: 'per-environment-apis',
  removeServerHot: 'per-environment-apis',
  removeServerTransformRequest: 'per-environment-apis',
  removeServerWarmupRequest: 'per-environment-apis',
  removeSsrLoadModule: 'ssr-using-modulerunner',
} satisfies Record<keyof FutureOptions, string>

const deprecationMessages = {
  removePluginHookSsrArgument:
    "Plugin hook `options.ssr` is replaced with `this.environment.config.consumer === 'server'`.",
  removePluginHookHandleHotUpdate:
    'Plugin hook `handleHotUpdate()` is replaced with `hotUpdate()`.',
  removeServerModuleGraph:
    'The `server.moduleGraph` is replaced with `this.environment.moduleGraph`.',
  // ... 各項目に移行先を明記
} satisfies Record<keyof FutureOptions, string>
```

### 3. warnFutureDeprecation: メッセージ + ドキュメント URL + スタックトレース

警告関数は「何が非推奨か」「移行ドキュメントの URL」「呼び出し元のスタックトレース」の3点を一度に提供する。

```typescript
// packages/vite/src/node/deprecations.ts:55-97
export function warnFutureDeprecation(
  config: ResolvedConfig,
  type: keyof FutureOptions,
  extraMessage?: string,
  stacktrace = true,
): void {
  if (
    _ignoreDeprecationWarnings ||
    !config.future ||
    config.future[type] !== 'warn'
  )
    return

  let msg = `[vite future] ${deprecationMessages[type]}`
  if (extraMessage) {
    msg += ` ${extraMessage}`
  }

  const docs = `${docsURL}/changes/${deprecationCode[type].toLowerCase()}`
  msg +=
    colors.gray(`\n  ${stacktrace ? '├' : '└'}─── `) +
    colors.underline(docs) +
    '\n'

  if (stacktrace) {
    const stack = new Error().stack
    if (stack) {
      let stacks = stack
        .split('\n')
        .slice(3)
        .filter((i) => !i.includes('/node_modules/vite/dist/'))
      if (stacks.length === 0) {
        stacks.push('No stack trace found.')
      }
      // ツリー形式で見やすく整形
      stacks = stacks.map(
        (i, idx) => `  ${idx === stacks.length - 1 ? '└' : '│'} ${i.trim()}`,
      )
      msg += colors.dim(stacks.join('\n')) + '\n'
    }
  }
  config.logger.warnOnce(msg)
}
```

### 4. Getter trap による遅延非推奨警告

非推奨プロパティへの実際のアクセス時にのみ警告を発火する。使われない限りノイズにならない。

```typescript
// packages/vite/src/node/server/index.ts:581-603
let server: ViteDevServer = {
  config,
  // ...
  get hot() {
    warnFutureDeprecation(config, 'removeServerHot')
    return hot
  },
  get pluginContainer() {
    warnFutureDeprecation(config, 'removeServerPluginContainer')
    return pluginContainer
  },
  get moduleGraph() {
    warnFutureDeprecation(config, 'removeServerModuleGraph')
    return moduleGraph
  },
  // ...
}
```

プラグインフックの引数レベルでも同様の trap を仕掛けられる。

```typescript
// packages/vite/src/node/server/pluginContainer.ts:418-431
Object.defineProperty(normalizedOptions, 'ssr', {
  get() {
    warnFutureDeprecation(
      topLevelConfig,
      'removePluginHookSsrArgument',
      `Used in plugin "${plugin.name}".`,  // どのプラグインが使ったかを特定
    )
    return ssrTemp
  },
  set(v) {
    ssrTemp = v
  },
})
```

### 5. future: 'warn' ショートカットによる一括有効化

フレームワーク作者が全ての非推奨警告を一括確認できるよう、`future: 'warn'` ショートカットを提供する。`satisfies Required<FutureOptions>` で全フィールドの網羅を保証する。

```typescript
// packages/vite/src/node/config.ts:1943-1956
future:
  config.future === 'warn'
    ? ({
        removePluginHookHandleHotUpdate: 'warn',
        removePluginHookSsrArgument: 'warn',
        removeServerModuleGraph: 'warn',
        removeServerReloadModule: 'warn',
        removeServerPluginContainer: 'warn',
        removeServerHot: 'warn',
        removeServerTransformRequest: 'warn',
        removeServerWarmupRequest: 'warn',
        removeSsrLoadModule: 'warn',
      } satisfies Required<FutureOptions>)
    : config.future,
```

### 6. 内部コード用の警告抑制メカニズム

内部コードが後方互換のために非推奨 API を意図的に使う場合、警告を一時的に抑制する。

```typescript
// packages/vite/src/node/deprecations.ts:99-105
export function ignoreDeprecationWarnings<T>(fn: () => T): T {
  const before = _ignoreDeprecationWarnings
  _ignoreDeprecationWarnings = true
  const ret = fn()
  _ignoreDeprecationWarnings = before
  return ret
}

// packages/vite/src/node/server/hmr.ts:376
const mixedModuleGraph = ignoreDeprecationWarnings(() => server.moduleGraph)
```

### 7. Property Proxy による名前変更の段階的移行

旧プロパティ名を新プロパティ名への Proxy として定義し、読み書きを透過的に転送する。

```typescript
// packages/vite/src/node/utils.ts:1250-1283
export function setupRollupOptionCompat<
  T extends Pick<BuildEnvironmentOptions, 'rollupOptions' | 'rolldownOptions'>,
>(buildConfig: T, path: string) {
  buildConfig.rolldownOptions ??= buildConfig.rollupOptions

  Object.defineProperty(buildConfig, 'rollupOptions', {
    get() {
      return buildConfig.rolldownOptions
    },
    set(newValue) {
      if (runtimeDeprecatedPath.has(path)) {
        rollupOptionsDeprecationCall()
      }
      buildConfig.rolldownOptions = newValue
    },
    configurable: true,
    enumerable: true,
  })
}
```

## Good Example

型安全な非推奨メタデータ管理と getter trap を組み合わせた、体系的なライフサイクル管理。

```typescript
// --- 1. 非推奨項目を型で定義 ---
interface FutureOptions {
  removeOldApi?: 'warn'
  removeDeprecatedHook?: 'warn'
}

// --- 2. メタデータを satisfies で網羅性保証 ---
const deprecationCode = {
  removeOldApi: 'new-api-migration',
  removeDeprecatedHook: 'new-hook-system',
} satisfies Record<keyof FutureOptions, string>

const deprecationMessages = {
  removeOldApi: '`oldApi()` is replaced with `newApi()`.',
  removeDeprecatedHook: '`onOldHook()` is replaced with `onNewHook()`.',
} satisfies Record<keyof FutureOptions, string>

// --- 3. 警告関数はドキュメント URL 付き ---
function warnFutureDeprecation(
  config: ResolvedConfig,
  type: keyof FutureOptions,
): void {
  if (!config.future?.[type]) return
  const msg = `[future] ${deprecationMessages[type]}`
  const docs = `https://docs.example.com/changes/${deprecationCode[type]}`
  config.logger.warnOnce(`${msg}\n  See: ${docs}`)
}

// --- 4. getter trap で遅延検知 ---
const server = {
  get oldApi() {
    warnFutureDeprecation(config, 'removeOldApi')
    return newApi  // 内部的には新 API に委譲
  },
}
```

## Bad Example

非推奨管理が場当たり的で、型の網羅性保証がなく、警告に移行情報が含まれない例。

```typescript
// Bad: 非推奨メッセージが散在し、移行先の情報がない
class Server {
  get moduleGraph() {
    console.warn('moduleGraph is deprecated')  // どう移行すべきか不明
    return this._moduleGraph
  }
}

// Bad: 非推奨項目の追加時に対応表の更新漏れを検出できない
const messages: Record<string, string> = {  // any key を許容
  removeOldApi: 'deprecated',
  // removeNewlyDeprecated を追加し忘れてもエラーにならない
}

// Bad: 設定解決時に非推奨の互換コードが本体ロジックに混在
function resolveConfig(config: UserConfig): ResolvedConfig {
  // 800行の関数の中に互換コードが散在...
  if (config.oldOption) {
    config.newOption = config.oldOption  // 変換ロジックが埋もれる
  }
  // ... 数百行後 ...
  if (config.anotherOldOption) {
    config.anotherNewOption = convertOld(config.anotherOldOption)
  }
}
```

## 適用ガイド

### どのような状況で使うべきか

- プラグインエコシステムやサードパーティ依存がある OSS ライブラリで、メジャーバージョン間の API 進化を管理する場合
- API のプロパティ名変更やメソッド移行を、利用者のコードを壊さずに段階的に実施したい場合
- 非推奨警告を「フラグを有効にした人だけに出す」ことで、移行準備ができたユーザーから順に対応してもらいたい場合

### 導入時の注意点

- **getter trap のデバッグ困難性**: `Object.defineProperty` による Proxy は `console.log` で見えるプロパティと実際の動作が異なる場合がある。Vite は `VITE_DEPRECATION_TRACE=1` 環境変数でスタックトレースを出す回避策を提供している
- **互換レイヤーの肥大化**: Vite の `resolveConfig` は後方互換コードが散在し約 800 行に肥大化している。互換コードは独立関数に分離し、削除予定バージョンを明記すべき
- **内部コードの非推奨 API 使用**: 内部で非推奨 API を意図的に使う場面（後方互換のための委譲など）には `ignoreDeprecationWarnings` のような抑制メカニズムが必要
- **`satisfies Record<keyof T, string>` の網羅性保証**: `FutureOptions` に新しいキーを追加した時点で、`deprecationCode` と `deprecationMessages` への追加が強制される。これにより「警告メッセージの書き忘れ」が型エラーとして検出される

### カスタマイズポイント

- **警告の粒度制御**: Vite の `future: 'warn'` ショートカットのように、一括有効化と個別制御の両方を提供する。フレームワーク作者は一括で全項目を確認し、一般ユーザーは特定項目のみ対応できる
- **自動変換レイヤーの併用**: `rollupOptions` → `rolldownOptions` のように、旧 API を新 API への Proxy として維持すれば、利用者はコード変更なしに動作を継続できる。変換不可能なオプションのみ警告を出す
- **スタックトレースの付与**: 警告にスタックトレースを含めることで、プラグイン作者が「どのプラグインのどの行が非推奨 API を呼んでいるか」を即座に特定できる。Vite は内部の `node_modules/vite/dist/` パスをフィルタして外部コードの呼び出し元のみを表示する

## 参考

- [repos/vitejs/vite/api-design-practices.md](../repos/vitejs/vite/api-design-practices.md) -- 設定 API・プラグイン API・非推奨管理の設計プラクティス分析
- [repos/vitejs/vite/migration-patterns.md](../repos/vitejs/vite/migration-patterns.md) -- esbuild→Rolldown 移行の段階的戦略パターン分析
- [repos/vitejs/vite/type-system-patterns.md](../repos/vitejs/vite/type-system-patterns.md) -- TypeScript 型設計・UserConfig/ResolvedConfig の型状態分離分析
