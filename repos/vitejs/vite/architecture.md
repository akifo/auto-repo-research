# architecture

> リポジトリ: vitejs/vite
> 分析日: 2026-02-17

## 概要

Vite のアーキテクチャを「プラグインパイプライン」「環境抽象化」「レイヤー構成と依存関係の方向性」の3軸で分析した。Vite 8（Rolldown 統合世代）は、従来の client/SSR 二分法を超えて任意の実行環境を抽象化する Environment API を導入し、プラグインシステムもそれに合わせて再設計されている。注目に値するのは、大規模な破壊的変更をしながらも後方互換を Proxy や deprecation 警告で段階的に移行させている点と、プラグインの実行順序を「enforce → hook order」の二段階で制御する設計である。

## 背景にある原則

- **環境ごとの関心分離**: ひとつのビルドツールが client・SSR・カスタム環境など複数のターゲットを同時に扱うとき、環境固有の設定・プラグイン・モジュールグラフを分離しつつ共有すべきもの（設定のデフォルト値、WebSocket 接続）は共有する。これにより各環境が独立して最適化できる（`packages/vite/src/node/baseEnvironment.ts:47-60` の Proxy パターン）。

- **パイプラインの段階的制御**: プラグインの実行順序を「大まかな分類（enforce: pre/normal/post）」と「フック単位の細粒度（hook.order: pre/normal/post）」の二段階で制御することで、ユーザープラグインが Vite 内部プラグインと正しくインターリーブできる。一段階だけだとプラグイン間の依存関係が表現しきれない。

- **後方互換を Proxy と deprecation で段階的に移行する**: API の破壊的変更を一度に行うのではなく、古い API を Proxy 経由で新 API にリダイレクトし、`warnFutureDeprecation` で将来の削除を予告する。エコシステムに移行猶予を与えつつ、新コードは新 API を使える（`packages/vite/src/node/deprecations.ts:1-40`）。

- **WeakMap によるプラグイン横断状態管理**: プラグインが複数環境で動作するとき、環境ごとの状態を WeakMap で分離する。グローバル変数やクロージャ変数に状態を持つと環境間で衝突するため、`perEnvironmentState` ヘルパーで WeakMap ベースの状態管理を標準化している（`packages/vite/src/node/environment.ts:20-33`）。

## 実例と分析

### プラグインパイプラインの二段階順序制御

Vite のプラグインパイプラインは2つの独立した順序制御メカニズムを持つ。

第一段階は `enforce` プロパティによるプラグインレベルの分類。`sortUserPlugins` がユーザープラグインを `pre`/`normal`/`post` の3グループに振り分ける（`config.ts:2217-2233`）。その後 `resolvePlugins` が Vite 内部プラグインとユーザープラグインを以下の順序で合成する:

```
alias → [user pre] → vite core → [user normal] → vite build → [user post] → vite build post → server-only
```

第二段階はフック単位の `order` プロパティ。`getSortedPluginsByHook` が各フック呼び出し時にプラグインを `pre`/`normal`/`post` で再ソートする（`plugins/index.ts:159-187`）。これにより「プラグイン全体としては post だが、resolveId フックだけは pre で実行したい」といった細かい制御が可能になる。

### 環境抽象化の階層構造

環境クラスは3層の継承階層を形成する:

```
PartialEnvironment  ← 設定の Proxy 合成、ロガー
  └─ BaseEnvironment  ← プラグインリスト参照
       ├─ DevEnvironment  ← moduleGraph, pluginContainer, HMR
       │    ├─ RunnableDevEnvironment  ← ModuleRunner 統合
       │    └─ FullBundleDevEnvironment  ← Rolldown dev engine
       ├─ BuildEnvironment  ← ビルド状態管理
       └─ UnknownEnvironment  ← 型安全のプレースホルダー
```

`PartialEnvironment` のコンストラクタは `Proxy` を使って環境固有設定とトップレベル設定を透過的にマージする:

```typescript
// packages/vite/src/node/baseEnvironment.ts:47-60
this.config = new Proxy(
  options as ResolvedConfig & ResolvedEnvironmentOptions,
  {
    get: (target, prop: keyof ResolvedConfig) => {
      if (prop === 'logger') {
        return this.logger
      }
      if (prop in target) {
        return this._options[prop as keyof ResolvedEnvironmentOptions]
      }
      return this._topLevelConfig[prop]
    },
  },
)
```

これにより `environment.config.resolve`（環境固有）と `environment.config.root`（トップレベル共有）が同じ `config` プロパティから透過的にアクセスできる。

### プラグインの環境フィルタリング

プラグインが特定環境でのみ動作する仕組みは `applyToEnvironment` フックで実現される:

```typescript
// packages/vite/src/node/plugins/terser.ts:77-83
{
  name: 'vite:terser',
  applyToEnvironment(environment) {
    return environment.config.build.minify === 'terser' ||
           environment.config.build.minify === false
  },
}
```

`resolveEnvironmentPlugins`（`plugin.ts:390-412`）がこのフックを評価し、環境ごとに異なるプラグインセットを構成する。返り値が `boolean` の場合はフィルタリング、`PluginOption` の場合は代替プラグインへの差し替えが可能という柔軟な設計。

### 環境ごとの状態分離パターン

`perEnvironmentState` は WeakMap を使ってプラグインの環境ごとの状態を管理する:

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

実際の使用例（`plugins/clientInjections.ts:22-33`）:

```typescript
const getDefineReplacer = perEnvironmentState((environment) => {
  const userDefine: Record<string, any> = {}
  for (const key in environment.config.define) {
    if (!key.startsWith('import.meta.env.')) {
      userDefine[key] = environment.config.define[key]
    }
  }
  const serializedDefines = serializeDefine(userDefine)
  return (code: string) => code.replace(`__DEFINES__`, () => serializedDefines)
})
```

この関数は `manifest`, `html`, `reporter`, `dynamicImportVars`, `ssrManifest` など多くのプラグインで使われている。

### レイヤー構成と依存方向

Vite のソースは以下のレイヤーに分かれ、依存は上から下への一方向:

```
client/        ← ブラウザで実行されるHMRクライアント
module-runner/ ← 環境非依存のモジュール実行エンジン
shared/        ← client と node の両方で使われるユーティリティ
node/          ← Node.js サーバー・ビルドの主要ロジック
  ├── server/  ← DevEnvironment, pluginContainer, middleware
  ├── plugins/ ← 28個の内部プラグイン
  ├── optimizer/ ← 依存関係の事前バンドル
  └── ssr/     ← SSR 固有のロジック
```

`shared/utils.ts` は `client` と `node` の両方から参照される共有コードで、`cleanUrl`, `unwrapId`, `slash` など環境非依存のユーティリティを提供する。`node/utils.ts` は Node.js 固有のユーティリティ（ファイルシステム操作、パス解決など）を持つ。この分離により、ブラウザ側コードが Node.js API に依存しない。

### ミドルウェアの順序保証

`server/index.ts:879-989` のミドルウェア登録は明確な順序を持つ:

1. Pre-applied: request timer, reject invalid, reject no-cors, CORS, host validation
2. Plugin hooks: `configureServer`（戻り値の post hooks は後で実行）
3. Internal: cached transform, proxy, base, static, transform
4. Post hooks: `configureServer` の戻り値
5. HTML: index.html transform, 404 handler
6. Error handler（常に最後）

`configureServer` フックが「関数を返すと post hook として後で実行される」という設計は、ユーザーが内部ミドルウェアの前後どちらにも処理を挿入できる柔軟性を提供している。

## パターンカタログ

- **Chain of Responsibility** (振る舞い)
  - 解決する問題: プラグインの `resolveId` → `load` → `transform` パイプラインで、最初に結果を返したプラグインが処理を担当する
  - 適用条件: 複数のハンドラが同じリクエストを処理する可能性があり、優先順位で制御したい場合
  - コード例: `pluginContainer.ts:393-455`（resolveId は hookFirst）
  - 注意点: `transform` は全プラグインが順次処理する（chain ではなく pipeline）ため、hookFirst と hookSequential の使い分けが必要

- **Proxy** (構造)
  - 解決する問題: 環境固有の設定とグローバル設定を透過的にマージする
  - 適用条件: オブジェクトのプロパティアクセスをインターセプトして合成・リダイレクトしたい場合
  - コード例: `baseEnvironment.ts:47-60`, `server/index.ts:779-787`（reflexServer）
  - 注意点: Proxy はデバッグが難しくなるため、型安全性とテスト容易性の確保が必要

- **Template Method** (振る舞い)
  - 解決する問題: `DevEnvironment` の基本フローを固定しつつ、サブクラス（`RunnableDevEnvironment`, `FullBundleDevEnvironment`）で詳細を差し替える
  - 適用条件: 処理の骨格は共通だが、一部のステップを差し替えたい場合
  - コード例: `server/environment.ts:55-332`, `server/environments/runnableEnvironment.ts:43-78`

## Good Patterns

- **二段階の順序制御（enforce + hook.order）**: プラグインレベルの大まかな順序と、フックレベルの細かい順序を独立して制御する。これにより「このプラグインは全体的に post だが、resolveId だけは pre」といった複雑な要件を表現できる。Webpack の loader にも `enforce` はあるが、フック単位の `order` は Vite/Rollup 固有の改善。
  ```typescript
  // plugins/index.ts:159-187
  function getSortedPluginsByHook(hookName, plugins) {
    let pre = 0, normal = 0, post = 0
    for (const plugin of plugins) {
      const hook = plugin[hookName]
      if (hook) {
        if (typeof hook === 'object' && hook.order === 'pre') {
          sortedPlugins.splice(pre++, 0, plugin)
        } else if (typeof hook === 'object' && hook.order === 'post') {
          sortedPlugins.splice(pre + normal + post++, 0, plugin)
        } else {
          sortedPlugins.splice(pre + normal++, 0, plugin)
        }
      }
    }
  }
  ```

- **WeakMap + factory 関数による環境スコープ状態管理**: `perEnvironmentState` はグローバル変数の汚染を防ぎつつ、環境が GC されれば状態も自動的に解放される。プラグインのクロージャに状態を持つ従来パターンと比べて、マルチ環境での安全性が格段に高い。
  ```typescript
  // environment.ts:20-33
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

- **configureServer の戻り値による pre/post ミドルウェア挿入**: プラグインフックの戻り値を使って、内部ミドルウェアの前後どちらにもユーザーのミドルウェアを挿入可能にする設計。単純な配列やイベントではなく、関数の戻り値という慣用句で前後の区別を実現している。
  ```typescript
  // server/index.ts:908-911
  const postHooks: ((() => void) | void)[] = []
  for (const hook of config.getSortedPluginHooks('configureServer')) {
    postHooks.push(await hook.call(configureServerContext, reflexServer))
  }
  ```

## Anti-Patterns / 注意点

- **Proxy による設定合成の透過性と型安全のトレードオフ**: `PartialEnvironment.config` は Proxy で環境設定とグローバル設定をマージするが、TypeScript の型システムでは Proxy の動的な振る舞いを完全に表現できない。`as` キャストが必要になり、プロパティの出所が不明確になる。
  ```typescript
  // Bad: Proxy で型を偽装
  this.config = new Proxy(
    options as ResolvedConfig & ResolvedEnvironmentOptions, // 実際にはどちらでもない
    { get: ... }
  )
  // Better: 明示的な委譲メソッド or 合成済みオブジェクトを事前構築
  this.config = Object.freeze({
    ...topLevelConfig,
    ...environmentOptions,
  })
  ```
  ただし Vite の場合、後方互換のためにこの Proxy が必要という制約がある。新規プロジェクトでは事前合成を選ぶべき。

- **フィルタキャッシュの WeakMap キー設計**: `getCachedFilterForPlugin` は Plugin オブジェクトを WeakMap のキーにしているが、プラグインが再生成されるとキャッシュが無効になる。プラグインの identity が安定していることを暗黙の前提としている。
  ```typescript
  // plugins/index.ts:200
  const filterForPlugin = new WeakMap<Plugin, FilterForPluginValue>()
  ```
  WeakMap のキーにするオブジェクトの identity が安定していることを保証する設計にすべき。

## 導出ルール

- `[MUST]` プラグインパイプラインで「全プラグインが順次処理する」フックと「最初の非 null 結果で停止する」フックを明確に区別する
  - 根拠: Vite は `resolveId`（hookFirst）と `transform`（hookSequential）で異なるセマンティクスを持ち、`pluginContainer.ts:393-455` と `529-620` で明確に実装を分けている

- `[MUST]` マルチ環境・マルチテナントで共有されるプラグインの状態は、WeakMap で環境（テナント）ごとに分離する
  - 根拠: Vite の `perEnvironmentState`（`environment.ts:20-33`）が6つ以上の内部プラグインで統一的に使われており、クロージャ変数による状態管理からの移行で環境間の状態衝突を解消している

- `[SHOULD]` 設定の層（グローバル → 環境固有 → ランタイム）をマージする際は、Proxy や動的ルックアップではなく、事前に合成済みの不変オブジェクトを構築する
  - 根拠: Vite は後方互換のために Proxy パターンを採用しているが、`baseEnvironment.ts:47-60` のように型安全性とデバッグ容易性が犠牲になっている。新規プロジェクトではこのトレードオフは不要

- `[SHOULD]` プラグインの実行順序を二段階（グループレベル + フックレベル）で制御し、ユーザーに両方の粒度で順序指定を許可する
  - 根拠: Vite の `enforce`（`config.ts:2217-2233`）と `hook.order`（`plugins/index.ts:159-187`）の二段階制御が、Webpack の loader enforce 単独よりも柔軟なプラグインインターリーブを実現している

- `[SHOULD]` 破壊的 API 変更を行う際は、旧 API を Proxy/getter でラップして deprecation 警告を出し、新 API へのマイグレーション期間を設ける
  - 根拠: Vite は `server.moduleGraph` → `environment.moduleGraph` 等の移行で、`warnFutureDeprecation`（`deprecations.ts:55-60`）により段階的な移行パスを提供している

- `[AVOID]` 共有レイヤー（shared/）に実行環境固有の依存を混入させること。shared に置くユーティリティは純粋関数か環境非依存のロジックに限定する
  - 根拠: Vite の `shared/utils.ts` は `cleanUrl`, `slash`, `unwrapId` など純粋関数のみで構成され、Node.js API（`fs`, `path`）は `node/utils.ts` に分離されている

## 適用チェックリスト

- [ ] プラグインシステムを設計する際、hookFirst（最初の結果で停止）と hookSequential（全プラグイン順次処理）のセマンティクスを明確に文書化しているか
- [ ] マルチ環境・マルチテナントで動作するプラグインの状態管理に WeakMap ベースの分離パターンを使っているか
- [ ] 設定のレイヤー（デフォルト → ユーザー → 環境固有 → ランタイム）のマージ戦略が明確に定義されているか
- [ ] 共有レイヤーのコードが特定の実行環境（Node.js / ブラウザ）に依存していないか
- [ ] 破壊的変更を行う際に deprecation 警告付きの互換レイヤーを提供しているか
- [ ] プラグインの実行順序がユーザーにとって予測可能で、必要に応じて制御できるか
- [ ] ミドルウェアパイプラインで「ユーザーの処理を内部処理の前後どちらにも挿入できる」仕組みがあるか
