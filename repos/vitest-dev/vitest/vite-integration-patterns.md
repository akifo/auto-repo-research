# vite-integration-patterns

> リポジトリ: vitest-dev/vitest
> 分析日: 2026-03-05

## 概要

Vitest が Vite の ModuleRunner・プラグインシステム・DevEnvironment API をテストフレームワークのコアインフラとしてどう統合しているかを分析する。Vite を「ビルドツール」ではなく「モジュール変換・解決エンジン」として再利用するアーキテクチャは、Vite エコシステム上にツールを構築する際の参照実装として注目に値する。特に、Vite の内部 API を拡張しつつ互換性を保つための防御的パターンが豊富に見られる。

## 背景にある原則

- **ホストツールの設定をゲスト用途に再構成する原則**: ビルドツール（Vite）の設定体系をそのまま使うのではなく、テスト実行に不要な機能（HMR、プリトランスフォーム、ファイルウォッチ）を明示的に無効化し、必要な部分だけを活かす。これにより、ユーザーは既存の `vite.config` を流用しつつテスト固有の挙動を得られる（`packages/vitest/src/node/plugins/index.ts:78-122`）
- **変換パイプラインの再利用と介入の原則**: Vite のプラグインパイプライン（resolve → transform）をそのまま利用しつつ、テスト固有の変換（モック注入、`import.meta.env` 置換、CSS 無効化）をプラグインとして追加する。既存パイプラインを壊さず拡張するために、`enforce: 'pre'` / `enforce: 'post'` の使い分けが徹底されている
- **モジュール実行のサーバー/ワーカー分離原則**: モジュールの解決・変換はサーバー側（Vite DevServer）で行い、実行はワーカー側（ModuleRunner）で行う。この分離により、テスト間の状態汚染を防ぎつつ、変換キャッシュを共有できる
- **API バージョン互換の防御的吸収原則**: Vite 5/6/7、rolldown-vite など複数バージョンの差異を、条件分岐とフォールバックで吸収する。型エラーは `@ts-ignore`/`@ts-expect-error` で明示的に抑制し、ランタイムでの存在チェックで安全性を担保する（`packages/vitest/src/node/plugins/index.ts:124-151`）

## 実例と分析

### プラグイン合成による関心の分離

Vitest のメインプラグイン `VitestPlugin` は、単一の巨大プラグインではなく、責務ごとに分離された複数プラグインの配列を返す。

```typescript
// packages/vitest/src/node/plugins/index.ts:37-291
return [
  { name: 'vitest', enforce: 'pre', ... },  // コア設定
  MetaEnvReplacerPlugin(),                    // import.meta.env → process.env
  ...CSSEnablerPlugin(vitest),                // CSS 処理の有効/無効
  CoverageTransform(vitest),                  // カバレッジ計装
  VitestCoreResolver(vitest),                 // vitest パッケージ解決
  ...MocksPlugins(),                          // モック注入
  VitestOptimizer(),                          // キャッシュディレクトリ
  NormalizeURLPlugin(),                       // URL 正規化
  ModuleRunnerTransform(),                    // 環境ごとの変換設定
].filter(notNullish)
```

各プラグインは Vite の `Plugin` 型を満たす独立したモジュールであり、テスト可能性と保守性が高い。`CSSEnablerPlugin` のように `pre`/`post` の2つのプラグインを返すものもあり、Vite のパイプラインフェーズを活用している。

### Vite DevServer の目的外利用の制御

テスト実行では Vite の開発サーバー機能の多くが不要になる。Vitest はこれらを `config` フック内で明示的に無効化する。

```typescript
// packages/vitest/src/node/plugins/index.ts:89-98
server: {
  ...testConfig.api,
  open,
  hmr: false,                          // HMR 不要
  ws: testConfig.api?.middlewareMode ? false : undefined,  // WebSocket 条件付き無効
  preTransformRequests: false,         // 先行変換不要
  fs: {
    allow: resolveFsAllow(options.root || process.cwd(), testConfig.config),
  },
},
```

ワークスペースプロジェクトではさらに踏み込み、`watch: null`（ファイル監視無効）、`middlewareMode: true`（HTTP サーバー不起動）を設定する（`packages/vitest/src/node/plugins/workspace.ts:155-163`）。run モードではサーバー起動後に `server.watcher.close()` を呼び出してリソースを即座に解放する（`index.ts:277`）。

### ModuleRunner の拡張パターン

Vitest は Vite の `ModuleRunner` を継承した `VitestModuleRunner` を実装している。拡張のポイントは3つ。

1. **Transport のカスタム実装**: `VitestTransport` が `ModuleRunnerTransport` を実装し、RPC 経由のモジュールフェッチとモック解決を統合する（`moduleTransport.ts:10-57`）
2. **`cachedRequest` のオーバーライド**: private メソッドを `@ts-expect-error` で呼び出し、モック解決ロジックを挿入する（`moduleRunner.ts:153-201`）。既存の動作を維持しつつ、呼び出し前にモック判定を行う Decorator パターン
3. **`processImport` の緩和**: Vite がデフォルトで行う Node.js 互換の export チェックを無効化し、テスト環境での柔軟な import を許容する（`moduleRunner.ts:108-110`）

```typescript
// packages/vitest/src/runtime/moduleRunner/moduleRunner.ts:47-69
export class VitestModuleRunner
  extends viteModuleRunner.ModuleRunner
  implements TestModuleRunner {
  constructor(private vitestOptions: VitestModuleRunnerOptions) {
    const transport = new VitestTransport(options.transport, evaluatedModules, callstacks)
    super(
      {
        transport,
        hmr: false,
        evaluatedModules,
        sourcemapInterceptor: 'prepareStackTrace',
        createImportMeta: vitestOptions.createImportMeta,
      },
      options.evaluator,
    )
  }
}
```

### サーバーサイド ModuleRunner（DevEnvironment 統合）

Vitest のサーバープロセスでも ModuleRunner を使い、設定ファイルやプラグインのロードを行う。`ServerModuleRunner` は Vite の `DevEnvironment` と直接統合し、`pluginContainer.resolveId` を経由して解決する。

```typescript
// packages/vitest/src/node/environments/serverRunner.ts:9-46
export class ServerModuleRunner extends ModuleRunner {
  constructor(
    private environment: DevEnvironment,
    fetcher: VitestFetchFunction,
    private config: ResolvedConfig,
  ) {
    super(
      {
        hmr: false,
        transport: {
          async invoke(event) {
            // fetchModule のみ処理、他は拒否
            const result = await fetcher(data[0], data[1], environment, false, data[2])
            return { result }
          },
        },
      },
      new VitestModuleEvaluator(),
    )
  }
}
```

### define 設定の安全な移行

Vite の `define` はビルド時に静的置換を行うが、テスト環境ではランタイムで値を変更できる必要がある。Vitest は `define` の値を抽出して `process.env` に移し、Vite の静的置換を無効化する。

```typescript
// packages/vitest/src/node/plugins/utils.ts:66-101
export function deleteDefineConfig(viteConfig: ViteConfig): Record<string, any> {
  const defines: Record<string, any> = {}
  delete viteConfig.define['import.meta.vitest']
  delete viteConfig.define['process.env']
  for (const key in viteConfig.define) {
    if (key.startsWith('import.meta.env.')) {
      const envKey = key.slice('import.meta.env.'.length)
      process.env[envKey] = replacement
      delete viteConfig.define[key]
    }
    // ...
  }
  return defines
}
```

### 外部化制御の自前実装

Vite の SSR 外部化ロジックを使わず、Vitest 独自の外部化判定を行う。`ModuleRunnerTransform` プラグインで `resolve.noExternal = true` を設定して Vite のデフォルト外部化を無効化し、`fetchModule` 内で `isBuiltin()` チェックを行う。

```typescript
// packages/vitest/src/node/plugins/runnerTransform.ts:105-109
// by setting `noExternal` to `true`, we make sure that
// Vite will never use its own externalization mechanism
config.resolve.noExternal = true
```

```typescript
// packages/vitest/src/runtime/moduleRunner/startVitestModuleRunner.ts:128-129
if (isBuiltin(rawId)) {
  return { externalize: rawId, type: 'builtin' }
}
```

## パターンカタログ

- **Decorator パターン** (分類: 構造)
  - 解決する問題: 親クラスの private メソッドに追加のロジック（モック判定）を注入する
  - 適用条件: 継承元の API が拡張ポイントを十分に提供していないが、動作を変更する必要がある場合
  - コード例: `moduleRunner.ts:140-201` — `cachedRequest` をオーバーライドし、モック判定後に `super.cachedRequest` へ委譲
  - 注意点: private メソッドの呼び出しには `@ts-expect-error` が必要で、アップストリームの変更に脆い

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: モジュール実行方法をコンテキスト（VM 環境 / ネイティブ環境）で切り替える
  - 適用条件: 同一インターフェースで異なる実行戦略が必要な場合
  - コード例: `moduleEvaluator.ts:332-334` — `vm.runInContext` と `vm.runInThisContext` の使い分け
  - 注意点: 各 Strategy が同じ前提条件（CJS グローバル、import.meta の形式）を満たす必要がある

- **Proxy パターン** (分類: 構造)
  - 解決する問題: `import.meta.env` へのアクセスを `process.env` に透過的にリダイレクトする
  - 適用条件: 既存の API 表面を変えずに背後の実装を差し替えたい場合
  - コード例: `moduleEvaluator.ts:389-417` — `createImportMetaEnvProxy`
  - 注意点: Proxy のトラップで型変換（boolean ↔ string）を行う場合、一貫性のあるルールが必要

## Good Patterns

- **プラグインの責務分離と配列返却**: `VitestPlugin` が個別責務のプラグイン配列を返すことで、各プラグインを独立してテスト・無効化できる。`...MocksPlugins()` のようにスプレッドで挿入するパターンは、プラグインが複数のフェーズ（pre/post）に跨る場合に有効

- **コンソール出力の一時的抑制**: `createViteServer` で Vite の既知の警告を一時的に抑制し、処理後に即座に復元する。副作用の範囲を最小化する防御的パターン
```typescript
// packages/vitest/src/node/vite.ts:5-22
const error = console.error
console.error = (...args: any[]) => {
  if (typeof args[0] === 'string' && args[0].includes('WebSocket server error:')) {
    return
  }
  error(...args)
}
const server = await createServer(inlineConfig)
console.error = error  // 即座に復元
```

- **Vite バージョン検出による分岐**: `'rolldownVersion' in vite` でランタイムにバンドラーの種類を判定し、esbuild/oxc の設定を切り替える。型レベルでは `@ts-ignore` で抑制しつつ、ランタイムでは安全にフォールバックする
```typescript
// packages/vitest/src/node/plugins/index.ts:124-151
if ('rolldownVersion' in vite) {
  config = { ...config, oxc: { target: 'node18' } }
} else {
  config = { ...config, esbuild: { target: 'node18' } }
}
```

- **Vitest 自身の import のキャッシュ付き外部化**: `getCachedVitestImport` でフレームワーク自身のモジュールを常に外部化し、ワーカー側で Node.js のネイティブキャッシュを活用する。`Map` ベースのキャッシュで同一判定を繰り返さない
```typescript
// packages/vitest/src/runtime/moduleRunner/cachedResolver.ts:12-49
export function getCachedVitestImport(id, state) {
  if (externalizeMap.has(id)) {
    return { externalize: externalizeMap.get(id)!, type: 'module' }
  }
  // ...判定後にキャッシュ
  externalizeMap.set(id, externalize)
  return { externalize, type: 'module' }
}
```

## Anti-Patterns / 注意点

- **private メソッドの ts-expect-error 呼び出し**: `VitestModuleRunner` が親クラスの private メソッド `cachedRequest` を `@ts-expect-error` 経由で呼び出している。アップストリーム（Vite）の内部 API 変更で即座に壊れるリスクがある
```typescript
// Bad: private メソッドへの直接アクセス
// packages/vitest/src/runtime/moduleRunner/moduleRunner.ts:146-148
private _cachedRequest(url, module, callstack, metadata) {
  // @ts-expect-error "cachedRequest" is private
  return super.cachedRequest(url, module, callstack, metadata)
}
```
```typescript
// Better: アップストリームに拡張ポイント（protected メソッドやフック）を提案する。
// やむを得ず private アクセスする場合は、バージョン固定 + 統合テストで検出する
```

- **console メソッドのグローバル差し替え**: `createViteServer` での `console.error` 差し替えは、非同期処理中に他のエラーが発生すると握りつぶされる可能性がある
```typescript
// Bad: 非同期処理中のグローバル差し替え
console.error = filtered
const server = await createServer(inlineConfig) // この間に別のエラーが出ると握りつぶす
console.error = error
```
```typescript
// Better: try/finally で確実に復元する、または Vite の customLogger を使う
```

## 導出ルール

- `[MUST]` ホストツール（Vite 等）の設定を再利用する際は、不要な機能（HMR、WebSocket、ファイルウォッチ等）を明示的に無効化する
  - 根拠: Vitest は `hmr: false`, `preTransformRequests: false`, `watch: null` 等を明示設定し、run モードでは `watcher.close()` まで呼ぶ（`index.ts:89-98, 277`）
- `[MUST]` グローバル状態（`console`, `process.env` 等）を一時的に変更する場合は、変更前の値を保存し処理後に必ず復元する
  - 根拠: `createViteServer` で `console.error` を差し替え後に即座に復元している（`vite.ts:8-22`）
- `[SHOULD]` 単一の巨大プラグインではなく、責務ごとに分離したプラグイン配列を返す構成にする
  - 根拠: Vitest は MetaEnvReplacer, CSSEnabler, Coverage, Mocks 等を個別プラグインとして実装し、独立した無効化・テストを可能にしている（`index.ts:282-290`）
- `[SHOULD]` 依存ライブラリのバージョン差異はランタイムの機能検出（`in` 演算子、関数存在チェック）で吸収し、型エラーには理由付きの `@ts-expect-error` を使う
  - 根拠: `'rolldownVersion' in vite` での分岐や、`viteModuleRunner.createDefaultImportMeta` の存在チェック（`moduleRunner.ts:18-19`, `index.ts:124`）
- `[SHOULD]` フレームワーク自身のモジュールは ModuleRunner の変換パイプラインを通さず外部化し、ホストの Node.js キャッシュを利用する
  - 根拠: `getCachedVitestImport` が vitest パッケージを常に外部化してパフォーマンスを確保している（`cachedResolver.ts:12-49`）
- `[AVOID]` 上流ライブラリの private/internal メソッドを `@ts-expect-error` で直接呼び出すこと。やむを得ない場合は統合テストでの検出と、コメントでの意図説明を必須とする
  - 根拠: `VitestModuleRunner._cachedRequest` は親の private メソッドを呼んでおり、Vite のバージョンアップで壊れるリスクがある（`moduleRunner.ts:146-148`）
- `[AVOID]` Vite の `define` 設定をテスト環境でそのまま使うこと。静的置換はランタイムでの再代入を妨げるため、`process.env` への移行が必要
  - 根拠: `deleteDefineConfig` が `import.meta.env.*` / `process.env.*` の define を削除し、`process.env` に移行している（`utils.ts:66-101`）

## 適用チェックリスト

- [ ] Vite DevServer をツールのバックエンドとして使う場合、HMR・WebSocket・ファイルウォッチなど不要な機能を `config` フックで明示的に無効化しているか
- [ ] プラグインが複数の責務を持つ場合、配列として分離し、各プラグインが独立してテスト可能か
- [ ] Vite の `define` 設定がランタイムでの値変更を妨げていないか。テスト環境では `process.env` への移行を検討したか
- [ ] ModuleRunner を拡張する際、Transport と Evaluator をカスタム実装としてインジェクトしているか（継承よりコンポジション）
- [ ] 依存ライブラリの複数バージョンをサポートする場合、ランタイムの機能検出で分岐し、型エラーは理由付きで抑制しているか
- [ ] フレームワーク自身のコードが変換パイプラインを不必要に通過していないか（外部化による高速化の余地）
- [ ] グローバル状態の一時的な変更に対して、復元処理が確実に実行される構造（try/finally）になっているか
