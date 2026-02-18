# extensibility-mechanisms

> リポジトリ: vitejs/vite
> 分析日: 2026-02-17

## 概要

Vite のプラグインシステムは Rollup プラグインインターフェースを拡張し、dev サーバー・ビルド・HMR を横断する統一的な拡張メカニズムを提供する。注目すべきは、フック実行順序の多層制御（`enforce` による大分類 + `order` によるフック単位の微調整）、環境ごとのプラグイン分岐（`applyToEnvironment`）、そして「返り値で後続フックを注入する」compose パターンの3つが、互いに干渉せず協調する設計になっている点である。プラグインシステムの規模（40以上のフック種別）に対して、開発者が理解すべき概念モデルが少数に集約されており、大規模エコシステムの拡張性を支えるアーキテクチャとして参考になる。

## 背景にある原則

- **既存エコシステムとの互換性を維持しながら拡張する**: Vite プラグインは Rollup プラグインの上位互換として設計されている。`Plugin` 型は `RolldownPlugin` を extends し、Vite 固有のフック（`configureServer`, `hotUpdate` 等）を追加する形をとる。既存の Rollup プラグインがそのまま動作することを保証しつつ、dev サーバー固有の拡張点を提供する設計は、エコシステム移行コストを最小化する（`packages/vite/src/node/plugin.ts:36-59`）。

- **フック実行戦略をフックの性質に応じて使い分ける**: `resolveId` は hookFirst（最初の非 null 結果で終了）、`transform` は hookSequential（全プラグインを順次実行してコードを変換チェーン）、`buildStart` は hookParallel（並列実行）と、フックの意味論に応じて実行戦略を変えている。これにより、各フックが最も自然な動作をする（`packages/vite/src/node/server/pluginContainer.ts:304-326, 393-455`）。

- **フィルタリングで不要な処理をスキップし、パフォーマンスを確保する**: `apply` による serve/build 分岐、`applyToEnvironment` による環境分岐、`filter` オプションによる ID/コード/モジュール種別のフィルタリングを多層的に提供する。プラグインの数が増えてもホットパスの処理量が比例的に増えない設計になっている（`packages/vite/src/node/plugins/pluginFilter.ts:1-161`）。

- **返り値で制御フローを変える（Convention over Configuration）**: `configureServer` フックが関数を返すと post-hook になる、`hotUpdate` が配列を返すと更新対象を絞り込む、`applyToEnvironment` が `PluginOption` を返すとプラグインを差し替える、といった「返り値の型で振る舞いが変わる」パターンを一貫して採用している。設定オブジェクトではなく返り値で宣言的に制御することで、プラグイン作者のコード量を減らしている。

## 実例と分析

### 1. プラグイン実行順序の多層制御

Vite はプラグインの実行順序を2つのレイヤーで制御する。

第1レイヤー: `enforce` プロパティによるグローバル分類。`sortUserPlugins` がユーザープラグインを `pre` / `normal` / `post` に分類し、`resolvePlugins` が以下の固定順序で全プラグインを配列化する。

```
alias → enforce:'pre' → vite core → normal → vite build → enforce:'post' → vite build post → server-only
```

第2レイヤー: 各フックの `order` プロパティによるフック単位の微調整。`getSortedPluginsByHook` が各フック内でさらに `pre` / `normal` / `post` にソートする。

```typescript
// packages/vite/src/node/plugins/index.ts:159-187
export function getSortedPluginsByHook<K extends keyof Plugin>(
  hookName: K,
  plugins: readonly Plugin[],
): PluginWithRequiredHook<K>[] {
  const sortedPlugins: Plugin[] = [];
  let pre = 0,
    normal = 0,
    post = 0;
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

この2層構造により、プラグイン全体の実行位置（`enforce`）とフック単位の細かな順序（`order`）を独立して制御できる。

### 2. configureServer の post-hook パターン

`configureServer` フックは関数を返すことで「内部ミドルウェア適用後に実行される post-hook」を登録できる。

```typescript
// packages/vite/src/node/server/index.ts:908-978
const postHooks: ((() => void) | void)[] = [];
for (const hook of config.getSortedPluginHooks("configureServer")) {
  postHooks.push(await hook.call(configureServerContext, reflexServer));
}

// Internal middlewares (proxy, base, static files, etc.)
// ...

// apply configureServer post hooks
postHooks.forEach((fn) => fn && fn());
```

このパターンにより、プラグインは内部ミドルウェアの「前」と「後」の両方にミドルウェアを挿入できる。`configurePreviewServer` も同一パターンを採用している（`packages/vite/src/node/preview.ts:223-269`）。

### 3. ObjectHook パターンによるフックメタデータの宣言

Vite のフックは「関数そのもの」か「関数 + メタデータのオブジェクト」のどちらでも定義できる。`getHookHandler` がこの二形態を統一的に処理する。

```typescript
// packages/vite/src/node/plugins/index.ts:189-193
export function getHookHandler<T extends ObjectHook<Function>>(
  hook: T,
): HookHandler<T> {
  return (typeof hook === "object" ? hook.handler : hook) as HookHandler<T>;
}
```

このパターンにより、フックに `order`, `filter`, `sequential` 等のメタデータを付与できる。例えば CSS プラグインのフィルタ付きフック定義:

```typescript
// packages/vite/src/node/plugins/css.ts:338-342
load: {
  filter: {
    id: CSS_LANGS_RE,
  },
  async handler(id) {
    // CSS ファイルのみ処理
  },
},
```

### 4. 環境ごとのプラグイン分岐

`applyToEnvironment` は真偽値を返すと有効/無効を切り替え、`PluginOption` を返すとプラグイン自体を別のプラグインに差し替える。

```typescript
// packages/vite/src/node/plugin.ts:390-412
export async function resolveEnvironmentPlugins(
  environment: PartialEnvironment,
): Promise<Plugin[]> {
  const environmentPlugins: Plugin[] = [];
  for (const plugin of environment.getTopLevelConfig().plugins) {
    if (plugin.applyToEnvironment) {
      const applied = await plugin.applyToEnvironment(environment);
      if (!applied) {
        continue; // false: プラグインを無効化
      }
      if (applied !== true) {
        environmentPlugins.push( // PluginOption: 別プラグインに差し替え
          ...((await asyncFlatten(arraify(applied))).filter(Boolean) as Plugin[]),
        );
        continue;
      }
    }
    environmentPlugins.push(plugin); // true / 未定義: そのまま使う
  }
  return environmentPlugins;
}
```

`perEnvironmentPlugin` はこの仕組みのショートカットで、環境ごとに異なるプラグインを生成する Factory として機能する。

```typescript
// packages/vite/src/node/plugin.ts:417-427
export function perEnvironmentPlugin(
  name: string,
  applyToEnvironment: (
    environment: PartialEnvironment,
  ) => boolean | Promise<boolean> | PluginOption,
): Plugin {
  return {
    name,
    applyToEnvironment,
  };
}
```

実際にコードベース全体で16箇所以上で使用されている（wasm, worker, manifest, oxc, dynamic-import-vars 等）。

### 5. フックフィルタリングによるパフォーマンス最適化

`getCachedFilterForPlugin` は各プラグインのフィルタを WeakMap でキャッシュし、`resolveId`, `load`, `transform` の3フックでフィルタリングを適用する。

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

`transform` フックは ID フィルタ、コードフィルタ、モジュール種別フィルタの3つを組み合わせる:

```typescript
// packages/vite/src/node/plugins/pluginFilter.ts:133-161
export function createFilterForTransform(
  idFilter: StringFilter | undefined,
  codeFilter: StringFilter | undefined,
  moduleTypeFilter: ModuleTypeFilter | undefined,
  cwd?: string,
): TransformHookFilter | undefined {
  if (!idFilter && !codeFilter && !moduleTypeFilter) return;
  const idFilterFn = createIdFilter(idFilter, cwd);
  const codeFilterFn = createCodeFilter(codeFilter);
  const moduleTypeFilterFn = createModuleTypeFilter(moduleTypeFilter);
  return (id, code, moduleType) => {
    let fallback = moduleTypeFilterFn?.(moduleType) ?? true;
    if (!fallback) return false;
    if (idFilterFn) fallback &&= idFilterFn(id);
    if (!fallback) return false;
    if (codeFilterFn) fallback &&= codeFilterFn(code);
    return fallback;
  };
}
```

### 6. PluginOption の再帰的フラット化

`PluginOption` 型は Promise、配列、falsy 値をネストして許容する。`asyncFlatten` がこれらを統一的に処理する。

```typescript
// packages/vite/src/node/plugin.ts:383-388
export type PluginOption = Thenable<
  | Plugin
  | { name: string; }
  | FalsyPlugin
  | PluginOption[] // 再帰的にネスト可能
>;

// packages/vite/src/node/utils.ts:1504-1511
export async function asyncFlatten<T extends unknown[]>(arr: T) {
  do {
    arr = (await Promise.all(arr)).flat(Infinity) as any;
  } while (arr.some((v: any) => v?.then));
  return arr;
}
```

これにより、条件付きプラグインの宣言が自然になる:

```typescript
plugins: [
  vue(),
  condition && somePlugin(), // falsy は自動除外
  [pluginA(), pluginB()], // 配列もフラット化
];
```

### 7. HMR フックの段階的移行パターン

`hotUpdate`（新 API）と `handleHotUpdate`（旧 API）の両方をサポートしつつ、旧 API 使用時に deprecation 警告を出す。

```typescript
// packages/vite/src/node/server/hmr.ts:341
const hook = plugin["hotUpdate"] ?? plugin["handleHotUpdate"];
```

```typescript
// packages/vite/src/node/server/hmr.ts:474-513
if (plugin.hotUpdate) {
  const filteredModules = await getHookHandler(plugin.hotUpdate).call(
    clientContext,
    clientHotUpdateOptions,
  );
  // ...
} else if (type === "update") {
  warnFutureDeprecation(
    config,
    "removePluginHookHandleHotUpdate",
    `Used in plugin "${plugin.name}".`,
  );
  const filteredModules = await getHookHandler(
    plugin.handleHotUpdate!,
  ).call(contextForHandleHotUpdate, mixedHmrContext);
  // ...
}
```

## パターンカタログ

- **Chain of Responsibility** (分類: 振る舞い)
  - 解決する問題: 複数のプラグインが同じフックを実装する場合の実行制御
  - 適用条件: `resolveId`（hookFirst）、`transform`（hookSequential）
  - コード例: `packages/vite/src/node/server/pluginContainer.ts:393-455`（resolveId のループで最初の非 null 結果で break）
  - 注意点: hookFirst と hookSequential の区別を混同するとバグになる。`resolveId` は最初の結果で停止するが `transform` は全プラグインを通す

- **Strategy** (分類: 振る舞い)
  - 解決する問題: フックの実行戦略（並列/直列/最初の結果）をフックの性質に応じて切り替える
  - 適用条件: フックの意味論が並列実行可能か、順次実行が必要か、最初の結果で終了すべきかが異なる場合
  - コード例: `hookParallel`（`pluginContainer.ts:304-326`）、resolveId の hookFirst ループ（`pluginContainer.ts:393-455`）、transform の hookSequential ループ（`pluginContainer.ts:529-620`）
  - 注意点: `sequential: true` フラグで並列フック内の個別プラグインを直列実行に変更できる

- **Abstract Factory** (分類: 生成)
  - 解決する問題: 環境（client/ssr/custom）ごとに異なるプラグイン構成が必要
  - 適用条件: 環境固有の設定やキャッシュを持つプラグイン
  - コード例: `perEnvironmentPlugin`（`packages/vite/src/node/plugin.ts:417-427`）
  - 注意点: 返り値が `boolean` の場合は有効/無効の切り替えのみ、`PluginOption` の場合は完全なプラグイン差し替え

## Good Patterns

- **返り値型によるフック挿入位置の制御**: `configureServer` フックが `() => void` を返すと post-hook として内部ミドルウェアの後に実行される。設定オブジェクトなしに挿入位置を制御でき、プラグイン作者が直感的に「前処理は直接実行、後処理は関数を返す」と記述できる。

```typescript
// configureServer の post-hook パターン
configureServer(server) {
  // ここは内部ミドルウェアの前に実行
  server.middlewares.use(earlyMiddleware)

  return () => {
    // ここは内部ミドルウェアの後に実行
    server.middlewares.use(lateMiddleware)
  }
}
```

- **WeakMap を用いたプラグインフィルタキャッシュ**: プラグインオブジェクトを key にした WeakMap でフィルタ関数をキャッシュし、同一プラグインに対するフィルタ再生成を防止する。プラグインが GC されればキャッシュも自動解放される。

```typescript
// packages/vite/src/node/plugins/index.ts:200
const filterForPlugin = new WeakMap<Plugin, FilterForPluginValue>();
```

- **asyncFlatten による宣言的なプラグイン構成**: Promise、配列、falsy 値を再帰的にフラット化し、条件分岐を `&&` で自然に記述できるようにしている。

```typescript
// packages/vite/src/node/utils.ts:1504-1511
export async function asyncFlatten<T extends unknown[]>(arr: T) {
  do {
    arr = (await Promise.all(arr)).flat(Infinity) as any;
  } while (arr.some((v: any) => v?.then));
  return arr;
}
```

## Anti-Patterns / 注意点

- **フックの実行戦略を誤解した設計**: `resolveId` は hookFirst（最初の非 null 結果で終了）だが、`transform` は hookSequential（全プラグインを通す）。この違いを理解せずに、transform フックで「最初の結果を返して終了」する設計をすると、後続プラグインの transform が実行されない。

```typescript
// Bad: transform で早期 return して他プラグインの変換を妨げる
transform(code, id) {
  if (!id.endsWith('.vue')) return null  // 問題なし
  return { code: newCode }              // 他の transform は引き続き実行される（正常）
}

// 注意: resolveId では最初の結果で break するため、
// 複数プラグインが同じモジュールを resolve しようとすると先勝ちになる
```

- **ObjectHook と関数フックの型不整合**: フックを `{ handler, order, filter }` 形式で定義する場合、`getHookHandler` を通さずに直接呼び出すとオブジェクトを関数として呼び出すエラーになる。プラグインコンテナ内では常に `getHookHandler` を経由している。

```typescript
// Bad: フックを直接呼び出す
const result = plugin.resolveId.call(ctx, id, importer, options);

// Better: getHookHandler で関数を取り出す
const handler = getHookHandler(plugin.resolveId);
const result = handler.call(ctx, id, importer, options);
```

- **環境固有のキャッシュをグローバルに保持**: `perEnvironmentPlugin` を使わずに、プラグインの closure でキャッシュを保持すると、client と ssr で意図せずキャッシュが共有される。Vite では `WeakMap<Environment, ...>` パターンでキャッシュを分離している（`packages/vite/src/node/plugins/define.ts:108-119`）。

```typescript
// Bad: closure でキャッシュを保持（環境間で共有される）
function myPlugin() {
  const cache = new Map();
  return { name: "my-plugin", transform(code, id) {/* cache 使用 */} };
}

// Better: 環境をキーにした WeakMap
function myPlugin() {
  const cache = new WeakMap<Environment, Map<string, unknown>>();
  return {
    name: "my-plugin",
    transform(code, id) {
      let envCache = cache.get(this.environment);
      if (!envCache) {
        envCache = new Map();
        cache.set(this.environment, envCache);
      }
    },
  };
}
```

## 導出ルール

- `[MUST]` プラグインシステムのフック実行戦略（first / sequential / parallel）をフックの意味論に合わせて明示的に選択する
  - 根拠: Vite は resolveId に hookFirst、transform に hookSequential、buildStart に hookParallel を使い分けており、フックの性質と実行戦略が一致しないとバグの温床になる（`pluginContainer.ts:304-455`）

- `[MUST]` フックが関数形式とオブジェクト形式（メタデータ付き）の両方をとりうる場合、ハンドラ取得を統一するユーティリティを用意する
  - 根拠: Vite の `getHookHandler` は全フック呼び出し箇所で使われており、これがないと ObjectHook を直接呼び出すランタイムエラーが発生する（`plugins/index.ts:189-193`）

- `[SHOULD]` プラグインの実行順序制御を「大分類（グローバル）」と「フック単位（ローカル）」の2層で設計する
  - 根拠: Vite の `enforce`（プラグイン全体の位置）と `order`（個別フックの順序）の分離により、プラグイン作者は全体の位置を変えずに特定フックの順序だけを調整できる（`plugins/index.ts:159-187, config.ts:2217-2233`）

- `[SHOULD]` プラグインのフィルタリング機構を提供し、不要なフック呼び出しを早期スキップする
  - 根拠: Vite の `filter` オプションと `getCachedFilterForPlugin` により、CSS プラグインは CSS ファイルのみ、define プラグインは JS ファイルのみを処理し、プラグイン数増加に対するパフォーマンス劣化を防いでいる（`pluginFilter.ts:1-161`）

- `[SHOULD]` 複数環境（client/server 等）でプラグインが動作する場合、環境をキーにした WeakMap でキャッシュを分離する
  - 根拠: Vite の define プラグインは `WeakMap<Environment, ...>` でパターンキャッシュを管理し、環境間のキャッシュ汚染を防いでいる（`plugins/define.ts:108-119`）

- `[SHOULD]` プラグイン配列の型定義で falsy 値と Promise とネストを許容し、条件分岐を宣言的に記述可能にする
  - 根拠: Vite の `PluginOption` 型と `asyncFlatten` により、`condition && plugin()` のような自然な条件付きプラグイン宣言が可能になっている（`plugin.ts:383-388, utils.ts:1504-1511`）

- `[AVOID]` プラグインの API 移行時に旧 API を即座に削除する。新旧 API の共存期間を設け、deprecation 警告で段階的に移行する
  - 根拠: Vite は `handleHotUpdate`（旧）→ `hotUpdate`（新）の移行で `warnFutureDeprecation` を使い、エコシステムの移行期間を確保している（`server/hmr.ts:341, 502-508`）

## 適用チェックリスト

- [ ] プラグインシステムの各フックに対して、hookFirst / hookSequential / hookParallel のどの実行戦略が適切かを決定したか
- [ ] フックが関数形式とオブジェクト形式の両方を受け付ける場合、ハンドラ取得ユーティリティ（`getHookHandler` 相当）を実装したか
- [ ] プラグインの実行順序を制御する仕組みが、グローバル位置（`enforce`）とフック単位順序（`order`）の2層で設計されているか
- [ ] ホットパスのフックにフィルタリング機構を設け、無関係なプラグインのフック呼び出しをスキップしているか
- [ ] プラグインが複数環境で動作する場合のキャッシュ分離戦略が定まっているか
- [ ] プラグイン配列に falsy 値を含められる型定義になっており、条件付きプラグインを `&&` で宣言できるか
- [ ] 既存の API を変更する場合、段階的な deprecation パスを用意しているか
- [ ] 返り値の型で制御フローを変えるフック（post-hook パターン等）を採用する場合、TypeScript の型定義でそれが明示されているか
