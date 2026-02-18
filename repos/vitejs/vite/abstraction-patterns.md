# abstraction-patterns

> リポジトリ: vitejs/vite
> 分析日: 2026-02-17

## 概要

Vite のコードベースにおける抽象化設計パターン（プラグインフックシステム、Environment API、設定マージ、プラグインフィルタリング）を体系的に分析する。Vite は Rollup 互換のプラグインシステムを基盤としつつ、独自の多層的なフック拡張・環境ごとの分離・Proxy ベースの設定合成といった抽象化を積み上げており、大規模プラグインエコシステムを支える設計判断が随所に見られる。

## 背景にある原則

- **互換レイヤーの上に拡張を重ねる**: Rollup プラグインをそのまま動かしつつ Vite 固有のフック（`config`, `configureServer`, `hotUpdate` 等）を追加する。既存エコシステムの資産を壊さずに機能を拡張するために、既存インターフェースの superset を定義し、ハンドラ抽出関数 `getHookHandler` で ObjectHook / plain function の両形式を透過的に扱う。
  - 根拠: `packages/vite/src/node/plugin.ts:101` — `Plugin` は `RolldownPlugin` を extends する構造

- **設定は段階的に解決する**: ユーザー入力 → プラグイン `config` フック → `configEnvironment` フック → デフォルトマージ → `resolveConfig` という多段パイプラインで設定を構築する。各段階が部分的な設定オブジェクトを返し、`mergeConfig` で深層マージされる。この設計により、プラグインが他プラグインの設定変更を踏まえた上で追加変更できる。
  - 根拠: `packages/vite/src/node/config.ts:1370-1455` — `resolveConfig` 内の処理順序

- **環境ごとの関心を分離しつつ共通インターフェースを維持する**: Environment API により client / SSR / カスタム環境を統一的な `BaseEnvironment` 階層で扱いつつ、Proxy を使って環境固有オプションとトップレベル設定を透過的にマージする。プラグインは `this.environment` で現在の環境にアクセスし、環境を意識しないプラグインは変更不要。
  - 根拠: `packages/vite/src/node/baseEnvironment.ts:47-58` — Proxy ベースの config 合成

- **非破壊的な API 移行を構造で保証する**: `FutureOptions` と `warnFutureDeprecation` により、廃止予定の API を「警告モード」で段階的に移行させる。`Object.defineProperty` の getter トラップで旧 API へのアクセスを検知し、移行先を案内する。
  - 根拠: `packages/vite/src/node/deprecations.ts:44-97` — 非破壊的な廃止フレームワーク

## 実例と分析

### 1. ObjectHook パターン: フック関数とメタデータの共存

Vite のプラグインフックは plain function と `{ handler, order?, filter? }` 形式の両方を受け付ける。`getHookHandler` がこの差異を吸収する。

```typescript
// packages/vite/src/node/plugins/index.ts:189-193
export function getHookHandler<T extends ObjectHook<Function>>(
  hook: T,
): HookHandler<T> {
  return (typeof hook === "object" ? hook.handler : hook) as HookHandler<T>;
}
```

これにより、プラグイン作者は単純なケースでは関数だけを書き、実行順序やフィルタの制御が必要な場合にオブジェクト形式を使える。消費側コードは常に `getHookHandler` を通すので、形式の違いを気にしない。

### 2. プラグインの実行順序制御: enforce + hook.order の二段構成

プラグインの実行順序は 2 つのレベルで制御される。

**レベル 1: `enforce` によるグローバルな分類**

```typescript
// packages/vite/src/node/config.ts:2217-2233
export function sortUserPlugins(
  plugins: (Plugin | Plugin[])[] | undefined,
): [Plugin[], Plugin[], Plugin[]] {
  const prePlugins: Plugin[] = [];
  const postPlugins: Plugin[] = [];
  const normalPlugins: Plugin[] = [];
  if (plugins) {
    plugins.flat().forEach((p) => {
      if (p.enforce === "pre") prePlugins.push(p);
      else if (p.enforce === "post") postPlugins.push(p);
      else normalPlugins.push(p);
    });
  }
  return [prePlugins, normalPlugins, postPlugins];
}
```

**レベル 2: `hook.order` によるフック単位の並び替え**

```typescript
// packages/vite/src/node/plugins/index.ts:159-187
export function getSortedPluginsByHook<K extends keyof Plugin>(
  hookName: K,
  plugins: readonly Plugin[],
): PluginWithRequiredHook<K>[] {
  const sortedPlugins: Plugin[] = [];
  let pre = 0, normal = 0, post = 0;
  for (const plugin of plugins) {
    const hook = plugin[hookName];
    if (hook) {
      if (typeof hook === "object") {
        if (hook.order === "pre") {
          sortedPlugins.splice(pre++, 0, plugin);
          continue;
        }
        if (hook.order === "post") {
          sortedPlugins.splice(pre + normal + post++, 0, plugin);
          continue;
        }
      }
      sortedPlugins.splice(pre + normal++, 0, plugin);
    }
  }
  return sortedPlugins as PluginWithRequiredHook<K>[];
}
```

この二段構成により、プラグイン全体の優先度とフック単位の実行順序を独立に制御できる。

### 3. Environment 階層: Proxy ベースの設定合成

```typescript
// packages/vite/src/node/baseEnvironment.ts:47-58
this.config = new Proxy(
  options as ResolvedConfig & ResolvedEnvironmentOptions,
  {
    get: (target, prop: keyof ResolvedConfig) => {
      if (prop === "logger") {
        return this.logger;
      }
      if (prop in target) {
        return this._options[prop as keyof ResolvedEnvironmentOptions];
      }
      return this._topLevelConfig[prop];
    },
  },
);
```

`environment.config.xxx` でアクセスすると、環境固有オプションに存在するプロパティは環境固有値を、それ以外はトップレベル設定値を返す。プラグインが `this.environment.config` を参照するだけで、環境固有の設定と共通設定が自動的に解決される。

### 4. perEnvironmentState: WeakMap による環境スコープの状態管理

```typescript
// packages/vite/src/node/environment.ts:20-33
export function perEnvironmentState<State>(
  initial: (environment: Environment) => State,
): (context: PluginContext) => State {
  const stateMap = new WeakMap<Environment, State>();
  return function(context: PluginContext) {
    const { environment } = context;
    let state = stateMap.get(environment);
    if (!state) {
      state = initial(environment);
      stateMap.set(environment, state);
    }
    return state;
  };
}
```

プラグインが環境ごとに独立した状態を持つ必要がある場合に使う。WeakMap により環境オブジェクトが GC されると状態も解放される。実際に `manifestPlugin`, `buildHtmlPlugin`, `clientInjectionsPlugin` 等で使われている（`packages/vite/src/node/plugins/manifest.ts:61`, `html.ts:361`, `clientInjections.ts:22`）。

### 5. 設定マージ: mergeConfig と mergeWithDefaults の使い分け

```typescript
// packages/vite/src/node/utils.ts:1326-1414 (mergeConfigRecursively)
// 特殊なキーに対するカスタムマージロジック
if (key === "alias" && (rootPath === "resolve" || rootPath === "")) {
  merged[key] = mergeAlias(existing, value);
  continue;
} else if (key === "assetsInclude" && rootPath === "") {
  merged[key] = [].concat(existing, value);
  continue;
}
```

`mergeConfig` はプラグイン間の設定合成用で、配列は結合、特殊キー（`alias`, `assetsInclude` 等）は専用ロジック。`mergeWithDefaults` はデフォルト値の適用用で、`undefined` は無視し配列は上書き。意味が異なる 2 つのマージ戦略を明示的に分離している。

### 6. プラグインフィルタリング: 宣言的フィルタとキャッシュ

```typescript
// packages/vite/src/node/plugins/index.ts:200-241
const filterForPlugin = new WeakMap<Plugin, FilterForPluginValue>();
export function getCachedFilterForPlugin<
  H extends "resolveId" | "load" | "transform",
>(plugin: Plugin, hookName: H): FilterForPluginValue[H] | undefined {
  let filters = filterForPlugin.get(plugin);
  if (filters && hookName in filters) {
    return filters[hookName];
  }
  // ... フィルタ生成・キャッシュ
}
```

プラグインがフックに `filter` オプションを宣言すると、`pluginContainer` がそのフィルタをキャッシュし、マッチしないモジュールではフックを呼び出さない。プラグイン作者が `filter: { id: /\.vue$/ }` と宣言するだけで、内部的に最適化が適用される。

### 7. configureServer フック: pre/post hook パターン

```typescript
// packages/vite/src/node/server/index.ts:908-978
const postHooks: ((() => void) | void)[] = [];
for (const hook of config.getSortedPluginHooks("configureServer")) {
  postHooks.push(await hook.call(configureServerContext, reflexServer));
}
// ... 内部ミドルウェアの登録 ...
// apply configureServer post hooks
postHooks.forEach((fn) => fn && fn());
```

`configureServer` フックが関数を返すと、それが内部ミドルウェア適用後に実行される。プラグインは「内部ミドルウェアの前」と「後」の両方にロジックを配置できる。

### 8. esbuild プラグインから Rolldown プラグインへの変換

```typescript
// packages/vite/src/node/optimizer/pluginConverter.ts:31-189
export function convertEsbuildPluginToRolldownPlugin(
  esbuildPlugin: esbuild.Plugin,
): RolldownPlugin {
  // esbuild の onResolve/onLoad を Rolldown の resolveId/load にマッピング
}
```

esbuild プラグインの `PluginBuild` インターフェースを Proxy で部分実装し、`onResolve` → `resolveId`, `onLoad` → `load` に変換する Adapter パターン。未実装プロパティには即座にエラーを投げ、サポート範囲を明確化している。

## パターンカタログ

- **Adapter パターン** (構造)
  - 解決する問題: 異なるプラグインシステム（esbuild / Rollup / Vite）間の互換性
  - 適用条件: 既存エコシステムのプラグインを新しいランタイムで動かす必要がある場合
  - コード例: `packages/vite/src/node/optimizer/pluginConverter.ts:31-189`
  - 注意点: Proxy + throw で未実装を明示すること。サイレントな undefined 返却は誤動作の原因になる

- **Strategy パターン** (振る舞い)
  - 解決する問題: 環境（client / SSR / custom）ごとに異なる振る舞いが必要
  - 適用条件: 共通インターフェースの下で実行時に振る舞いを切り替えたい場合
  - コード例: `packages/vite/src/node/config.ts:220-224` — `createEnvironment` ファクトリ, `packages/vite/src/node/baseEnvironment.ts:104` — `BaseEnvironment` 階層
  - 注意点: `mode` プロパティのリテラル型で型レベルの判別を提供する（`'dev' | 'build' | 'unknown'`）

- **Chain of Responsibility パターン** (振る舞い)
  - 解決する問題: 複数プラグインが同じフック（resolveId, load, transform）を処理する優先度制御
  - 適用条件: 最初に非 null を返したハンドラが勝つ「hookFirst」セマンティクスが必要な場合
  - コード例: `packages/vite/src/node/server/pluginContainer.ts:352-476` — `resolveId` のループ
  - 注意点: フィルタリングを chain の手前で行うことで、不要なハンドラ呼び出しを削減する

## Good Patterns

- **宣言的フックメタデータ（ObjectHook）**: フック関数に `order` や `filter` をメタデータとして付与し、実行エンジンが最適化判断に使う。フック本体のロジックとオーケストレーション関心を分離できる。

```typescript
// plugin.ts:158-175 — transform フックの宣言的フィルタ
transform?: ObjectHook<
  (this: TransformPluginContext, code: string, id: string, options?: { ... }) =>
    Promise<TransformResult> | TransformResult,
  {
    filter?: {
      id?: StringFilter
      code?: StringFilter
      moduleType?: ModuleTypeFilter
    }
  }
>
```

- **WeakMap + ファクトリ関数による環境スコープ状態**: `perEnvironmentState` は、プラグイン定義時にクロージャでファクトリ関数を渡すだけで、環境ごとの状態が自動管理される。明示的な初期化・クリーンアップコードが不要。

```typescript
// plugins/manifest.ts:60-70
const getState = perEnvironmentState(() => {
  return {
    manifest: {} as Manifest,
    outputCount: 0,
    reset() {
      this.manifest = {};
      this.outputCount = 0;
    },
  };
});
// フック内で getState(this) で環境固有の状態を取得
```

- **段階的な廃止フレームワーク**: `FutureOptions` + `Object.defineProperty` getter trap で、旧 API 利用時にのみ警告を出す。プラグイン作者が自分のペースで移行でき、メジャーバージョンで一括削除できる。

```typescript
// deprecations.ts:44-49
export function isFutureDeprecationEnabled(
  config: ResolvedConfig,
  type: keyof FutureOptions,
): boolean {
  return !!config.future?.[type];
}
```

## Anti-Patterns / 注意点

- **Proxy の過剰利用によるデバッグ困難**: Proxy は強力だが、プロパティアクセスの挙動が非自明になる。Vite の `PartialEnvironment.config` は Proxy を使って環境設定とトップレベル設定を合成しているが、「このプロパティはどちらから来ているか」がコードリーディングだけでは判別しにくい。

```typescript
// Bad: Proxy で暗黙にフォールバックし、明示性が失われる
this.config = new Proxy(options, {
  get: (target, prop) => {
    if (prop in target) return target[prop];
    return this._topLevelConfig[prop]; // どのプロパティがフォールバックされるか不明
  },
});

// Better: 必要な場合は Proxy に debug ログや型定義でフォールバック先を明示する
// Vite はこのトレードオフを認識した上で、
// 型定義 (ResolvedConfig & ResolvedEnvironmentOptions) で補完している
```

- **特殊キーによるマージ分岐の増殖**: `mergeConfigRecursively` 内で `alias`, `assetsInclude`, `noExternal`, `plugins` 等に個別のマージロジックがある。新しい特殊キーを追加するたびにこの関数が肥大化する。

```typescript
// Bad: キーごとの if-else チェーン（utils.ts:1370-1412）
if (key === 'alias' && rootPath === 'resolve') { ... }
else if (key === 'assetsInclude' && rootPath === '') { ... }
else if (key === 'noExternal' && ...) { ... }

// Better: マージ戦略をキーに紐づけた宣言的なマップで管理する
const mergeStrategies: Record<string, MergeStrategy> = {
  'resolve.alias': mergeAlias,
  'assetsInclude': concatArrays,
  ...
}
```

## 導出ルール

- `[MUST]` プラグインフックが plain function と metadata object の両形式を受け付ける場合、ハンドラ抽出関数を一箇所に集約し、消費側で形式判定を繰り返さない
  - 根拠: Vite の `getHookHandler` が全フック消費箇所で共通利用されている（`plugins/index.ts:189`）

- `[MUST]` 設定マージ関数は「プラグイン間の合成」と「デフォルト値の適用」を別関数として提供する。前者は配列を結合し、後者は配列を上書きするなど、意味に応じたマージ戦略が異なるため
  - 根拠: `mergeConfig`（結合型）と `mergeWithDefaults`（フォールバック型）の明示的な分離（`utils.ts:1226, 1416`）

- `[SHOULD]` 環境やコンテキストごとに独立した状態が必要な場合、WeakMap + ファクトリ関数でスコープを管理する。明示的な初期化・破棄コードを書かずに済み、メモリリークも防げる
  - 根拠: `perEnvironmentState` が manifest, html, reporter, clientInjections 等 6 箇所以上で利用されている

- `[SHOULD]` 非破壊的な API 廃止は `Object.defineProperty` getter trap + 警告フレームワークで実装し、ユーザーが段階的に移行できるようにする
  - 根拠: `FutureOptions` による opt-in 警告モード。プロパティアクセス時にのみ警告を出し、使っていないユーザーには影響しない（`deprecations.ts:55-97`）

- `[SHOULD]` 複数プラグインが連鎖的にフックを処理するシステムでは、宣言的フィルタ（glob/正規表現等）を chain の手前で評価し、マッチしないハンドラの呼び出しをスキップする
  - 根拠: `getCachedFilterForPlugin` がフィルタ結果を WeakMap でキャッシュし、resolveId/load/transform の各ループで早期スキップを実現（`plugins/index.ts:202-241`）

- `[AVOID]` 設定マージ関数内にキー名ベースの特殊分岐を無制限に追加すること。特殊キーが増えるとメンテナンスコストが線形に増加し、マージの挙動予測が困難になる
  - 根拠: `mergeConfigRecursively` に 6 個以上の特殊キー分岐がある（`utils.ts:1370-1412`）。新規追加のたびにバグリスクが上がる

- `[AVOID]` プラグイン変換アダプターで未実装のプロパティを `undefined` で返すこと。代わりに明示的にエラーを throw し、互換性の境界を明確にする
  - 根拠: `pluginConverter.ts:70-74` の Proxy は未知プロパティに `throw new Error('Not implemented')` を返す

## 適用チェックリスト

- [ ] プラグインシステムを設計する際、フック関数が「plain function」と「メタデータ付きオブジェクト」の両方を受けられるか検討したか
- [ ] 設定マージが「合成用」と「デフォルト適用用」のどちらの意味で使われているかを区別し、適切な関数を選択しているか
- [ ] 環境・テナント・リクエストスコープ等の独立した状態管理に WeakMap + ファクトリパターンを適用できないか検討したか
- [ ] 非破壊的な API 廃止を計画する際、getter trap やラッパー関数で旧 API へのアクセスを検知し警告する仕組みを用意したか
- [ ] プラグインチェーンの各ステップに宣言的フィルタを導入し、不要なハンドラ呼び出しをスキップしているか
- [ ] 外部プラグインシステムとの互換性が必要な場合、Adapter パターンで未実装部分を明示的にエラーにしているか
