# pattern: weakmap-scoped-state

> 出典: repos/vitejs/vite からの知見
> カテゴリ: pattern

## 概要

WeakMap とファクトリ関数を組み合わせて、スコープ（環境・テナント・リクエスト等）ごとに独立した状態を自動管理するパターン。Vite の `perEnvironmentState` として実装されており、明示的な初期化・破棄コードを書かずに済み、GC と連動してメモリリークも防げる。プラグインシステムに限らず、マルチテナントやリクエストスコープの状態管理に広く応用できる汎用的な設計パターンである。

## 背景・文脈

Vite はマルチ環境アーキテクチャ（client / SSR / カスタム環境）を採用しており、プラグインが複数の環境で同時に動作する。各プラグインは環境ごとに独立した状態（マニフェストデータ、処理済み HTML のマップ、フィルタ関数など）を保持する必要がある。

従来のアプローチではプラグインのクロージャ変数に状態を持たせていたが、マルチ環境では環境間で状態が衝突するリスクがあった。この問題を解決するため、Vite は `perEnvironmentState` ヘルパーを導入し、WeakMap ベースの状態管理を標準化した。このパターンは Vite 内部で manifest, html, reporter, clientInjections, dynamicImportVars, ssrManifest の 6 つ以上のプラグインで統一的に使われている。

## 実装パターン

### コアとなるヘルパー関数

```typescript
// packages/vite/src/node/environment.ts:20-33
export function perEnvironmentState<State>(
  initial: (environment: Environment) => State,
): (context: PluginContext) => State {
  const stateMap = new WeakMap<Environment, State>()
  return function (context: PluginContext) {
    const { environment } = context
    let state = stateMap.get(environment)
    if (!state) {
      state = initial(environment)
      stateMap.set(environment, state)
    }
    return state
  }
}
```

設計のポイントは 3 つある:

1. **WeakMap をキーに使う**: 環境オブジェクトが GC されれば状態も自動解放される。明示的な `dispose()` や `cleanup()` が不要
2. **ファクトリ関数で遅延初期化**: 状態は初回アクセス時にのみ生成される。使われない環境の状態は作られない
3. **PluginContext を引数にとる**: フック内で `getState(this)` と書くだけで環境固有の状態が得られる。環境の取得方法をプラグイン作者が知る必要がない

## Good Example

### 例1: マニフェストプラグインの環境スコープ状態

```typescript
// packages/vite/src/node/plugins/manifest.ts:60-70
const getState = perEnvironmentState(() => {
  return {
    manifest: {} as Manifest,
    outputCount: 0,
    reset() {
      this.manifest = {}
      this.outputCount = 0
    },
  }
})

// フック内での使用
// generateBundle フック内で this（PluginContext）を渡すだけ
generateBundle(_options, bundle) {
  const state = getState(this)  // 環境ごとに独立した manifest を取得
  // state.manifest に書き込み
}
```

### 例2: define 置換関数の環境スコープ生成

```typescript
// packages/vite/src/node/plugins/clientInjections.ts:22-33
const getDefineReplacer = perEnvironmentState((environment) => {
  const userDefine: Record<string, any> = {}
  for (const key in environment.config.define) {
    if (!key.startsWith('import.meta.env.')) {
      userDefine[key] = environment.config.define[key]
    }
  }
  const serializedDefines = serializeDefine(userDefine)
  const definesReplacement = () => serializedDefines
  return (code: string) => code.replace(`__DEFINES__`, definesReplacement)
})
```

### 例3: 動的インポートのフィルタ関数

```typescript
// packages/vite/src/node/plugins/dynamicImportVars.ts:192-196
const getFilter = perEnvironmentState((environment: Environment) => {
  const { include, exclude } =
    environment.config.build.dynamicImportVarsOptions
  return createFilter(include, exclude)
})
```

### 例4: SSR マニフェストのシンプルな状態

```typescript
// packages/vite/src/node/ssr/ssrManifestPlugin.ts:21-23
const getSsrManifest = perEnvironmentState(() => {
  return {} as Record<string, string[]>
})
```

ファクトリ関数が `environment` 引数を使わないケースでも `perEnvironmentState` を使うことで、環境ごとの分離が保証される。

## Bad Example

### クロージャ変数で状態を共有してしまうパターン

```typescript
// Bad: クロージャの変数がすべての環境で共有される
function myPlugin() {
  const cache = new Map()  // client も SSR もこの 1 つの Map を共有
  return {
    name: 'my-plugin',
    transform(code, id) {
      if (cache.has(id)) return cache.get(id)
      const result = expensiveTransform(code)
      cache.set(id, result)
      return result
    }
  }
}
```

この実装では、client 環境の `transform` で生成したキャッシュが SSR 環境でも使われてしまう。例えば `import.meta.env.SSR` の値が環境ごとに異なるのに、最初にキャッシュした結果が返される。

### 手動の初期化・破棄コードが必要なパターン

```typescript
// Bad: 環境ごとに Map を作るが、手動で管理が必要
function myPlugin() {
  const cacheMap = new Map<string, Map<string, unknown>>()
  return {
    name: 'my-plugin',
    configureServer() {
      // 初期化コードが必要
      cacheMap.set('client', new Map())
      cacheMap.set('ssr', new Map())
    },
    transform(code, id) {
      const envName = this.environment.name
      const cache = cacheMap.get(envName)!  // 初期化忘れで undefined の可能性
      // ...
    },
    buildEnd() {
      // 破棄コードが必要（忘れるとメモリリーク）
      cacheMap.clear()
    }
  }
}
```

この実装は `perEnvironmentState` を使えば初期化・破棄コードを完全に排除できる:

```typescript
// Good: perEnvironmentState で自動管理
function myPlugin() {
  const getCache = perEnvironmentState(() => new Map<string, unknown>())
  return {
    name: 'my-plugin',
    transform(code, id) {
      const cache = getCache(this)  // 初期化は自動、GC で破棄も自動
      // ...
    },
  }
}
```

## 適用ガイド

### どのような状況で使うべきか

- **プラグインシステムのマルチ環境対応**: 同一プラグインが client / SSR / worker など複数の実行環境で動作し、環境ごとに独立した状態が必要な場合
- **マルチテナントアプリケーション**: テナントごとに設定やキャッシュを分離したい場合。テナントオブジェクトを WeakMap のキーにする
- **リクエストスコープの状態管理**: HTTP リクエストオブジェクトをキーにして、リクエストごとの状態を管理する。リクエスト処理完了後に GC が状態を回収する
- **テストの分離**: テストごとにコンテキストオブジェクトを作り、WeakMap でテスト固有の状態を管理する

### 導入時の注意点

- **WeakMap のキーはオブジェクトに限定される**: プリミティブ値（文字列、数値）はキーにできない。スコープを識別するオブジェクト（環境、テナント、リクエスト等）が必要
- **キーの identity が安定していること**: 同一スコープに対して毎回新しいオブジェクトが生成されると、WeakMap のルックアップが失敗する。Vite では `Environment` オブジェクトのライフサイクルが安定しているため問題にならない
- **デバッグが難しい**: WeakMap の中身は開発者ツールから直接見えない。状態の確認が必要な場合は、ファクトリ関数内にログを仕込むか、開発モードでは通常の Map にフォールバックする仕組みを用意する
- **初期化の副作用に注意**: ファクトリ関数が重い副作用（ファイル I/O、ネットワーク通信等）を持つ場合、初回アクセスのタイミングが予測しにくい。重い初期化は別のライフサイクルフック（`buildStart` 等）で行い、`perEnvironmentState` には軽い状態オブジェクトの生成のみを任せるのが望ましい

### カスタマイズポイント

- **ファクトリ関数の引数**: Vite は `(environment: Environment) => State` だが、汎用化する場合は `(scope: TScope) => State` のようにジェネリックにできる
- **コンテキストの抽出方法**: Vite は `PluginContext` から `environment` を取り出すが、フレームワークに合わせて `(context: RequestContext) => State` のように変更可能
- **リセット機能**: manifest プラグインのように `reset()` メソッドを状態オブジェクトに持たせることで、環境オブジェクトを破棄せずに状態だけをクリアできる
- **直接 WeakMap を使うパターン**: Vite の define プラグイン（`packages/vite/src/node/plugins/define.ts:108-119`）のように、`perEnvironmentState` を使わず直接 `WeakMap<Environment, ...>` を使うケースもある。PluginContext を経由しない場面や、より細かい制御が必要な場合に有用

## 参考

- [repos/vitejs/vite/abstraction-patterns.md](../repos/vitejs/vite/abstraction-patterns.md) -- perEnvironmentState の設計パターン分析、WeakMap + ファクトリ関数による環境スコープ状態管理の詳細
- [repos/vitejs/vite/architecture.md](../repos/vitejs/vite/architecture.md) -- Environment API の階層構造と WeakMap による状態分離の背景
- [repos/vitejs/vite/extensibility-mechanisms.md](../repos/vitejs/vite/extensibility-mechanisms.md) -- プラグインシステムにおける環境ごとのキャッシュ分離戦略
