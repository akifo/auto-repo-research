# API Design Practices

> リポジトリ: vitejs/vite
> 分析日: 2026-02-17

## 概要

Vite の設定 API・プラグイン API・非推奨管理の設計プラクティスを分析する。78,000 stars 超のビルドツールとして、膨大なプラグインエコシステムとの後方互換性を維持しつつ、メジャーバージョン間で API を段階的に進化させる仕組みが注目に値する。特に `UserConfig` → `ResolvedConfig` 変換パターン、`future` / `experimental` / `legacy` の三層 API ライフサイクル、getter ベースの非推奨警告トラップは、大規模エコシステムを持つライブラリの API 設計として汎用性が高い。

## 背景にある原則

- **Config は Optional、Resolved は Required**: ユーザー入力型（`UserConfig`）はすべてのフィールドが optional であり、解決済み型（`ResolvedConfig`）は `Required<>` で全フィールドが確定する。これにより、ユーザーは最小限の設定で始められ、内部コードは null チェックなしに動作できる。この分離が「設定の人間工学」と「内部コードの堅牢性」を両立させる鍵になっている（`config.ts:339-522`, `build.ts:371-375`）。

- **API ライフサイクルを型レベルで表現する**: `@experimental` → 安定 → `@deprecated` → 削除という進化を JSDoc タグとして型定義に埋め込み、IDE 上で即座にフィードバックする。さらに `ExperimentalOptions`, `FutureOptions`, `LegacyOptions` という三つの名前空間で API の成熟度を構造的に分離している（`config.ts:424-614`）。

- **Proxy によるゼロコスト非推奨警告**: 非推奨 API の呼び出しを `Object.defineProperty` の getter で捕捉し、実際にアクセスされた時のみ警告を発行する。API を削除せず動作を維持しつつ、移行を促す仕組み。内部コードが自身の非推奨 API を呼ぶ場合は `ignoreDeprecationWarnings` で一時的に抑制する（`deprecations.ts:99-105`, `server/index.ts:581-654`）。

- **プラグイン API は上位互換のスーパーセットとして設計する**: Vite プラグインは Rolldown（旧 Rollup）プラグインのスーパーセットであり、型テストでその関係を強制している。これにより、既存の Rollup エコシステム資産をそのまま活用できる（`__tests_dts__/plugin.ts:28-42`）。

## 実例と分析

### defineConfig: 型安全なアイデンティティ関数

`defineConfig` は受け取った値をそのまま返すだけの関数だが、6 つのオーバーロードを持ち、入力型に応じた正確な戻り値型を返す。これにより、ユーザーは TypeScript の補完・検証を IDE 上で享受できる。

```typescript
// packages/vite/src/node/config.ts:175-183
export function defineConfig(config: UserConfig): UserConfig;
export function defineConfig(config: Promise<UserConfig>): Promise<UserConfig>;
export function defineConfig(config: UserConfigFnObject): UserConfigFnObject;
export function defineConfig(config: UserConfigFnPromise): UserConfigFnPromise;
export function defineConfig(config: UserConfigFn): UserConfigFn;
export function defineConfig(config: UserConfigExport): UserConfigExport;
export function defineConfig(config: UserConfigExport): UserConfigExport {
  return config;
}
```

関数ファクトリ形式（`ConfigEnv` を受け取る関数）もサポートし、`build` / `serve` や `mode` に応じた動的な設定生成を型安全に行える。

### 三層 API ライフサイクル管理

Vite は API の成熟度を三つの名前空間で明示する:

```typescript
// packages/vite/src/node/config.ts:547-614
export interface ExperimentalOptions {
  // semver に従わない。ピン留め推奨
  importGlobRestoreExtension?: boolean;
  enableNativePlugin?: boolean | "v1" | "v2";
  bundledDev?: boolean;
}

export interface FutureOptions {
  // 次期メジャーで削除予定の API に対する事前警告
  removePluginHookHandleHotUpdate?: "warn";
  removeServerModuleGraph?: "warn";
  // ...
}

export interface LegacyOptions {
  // パッチ版でのみ semver に従う。マイナーで削除される可能性
  skipWebSocketTokenCheck?: boolean;
  inconsistentCjsInterop?: boolean;
}
```

`future: 'warn'` というショートカットで全ての将来の非推奨警告を一括有効化できる設計も秀逸:

```typescript
// packages/vite/src/node/config.ts:1943-1956
future:
  config.future === 'warn'
    ? ({
        removePluginHookHandleHotUpdate: 'warn',
        removePluginHookSsrArgument: 'warn',
        removeServerModuleGraph: 'warn',
        // ... 全フィールドを 'warn' に
      } satisfies Required<FutureOptions>)
    : config.future,
```

### Getter トラップによる非推奨 API 追跡

サーバーオブジェクト上の非推奨プロパティは、getter で実際のアクセスを検知して警告する:

```typescript
// packages/vite/src/node/server/index.ts:581-603
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
```

プラグインフックの `ssr` パラメータも同様に `Object.defineProperty` で捕捉する:

```typescript
// packages/vite/src/node/server/pluginContainer.ts:418-431
Object.defineProperty(normalizedOptions, "ssr", {
  get() {
    warnFutureDeprecation(
      topLevelConfig,
      "removePluginHookSsrArgument",
      `Used in plugin "${plugin.name}".`,
    );
    return ssrTemp;
  },
});
```

### rollupOptions → rolldownOptions: Proxy ベースの段階的移行

Rollup から Rolldown への移行に際して、`rollupOptions` を `rolldownOptions` への proxy として維持する:

```typescript
// packages/vite/src/node/utils.ts:1250-1283
export function setupRollupOptionCompat<
  T extends Pick<BuildEnvironmentOptions, "rollupOptions" | "rolldownOptions">,
>(buildConfig: T, path: string) {
  buildConfig.rolldownOptions ??= buildConfig.rollupOptions;
  // proxy rolldownOptions to rollupOptions
  Object.defineProperty(buildConfig, "rollupOptions", {
    get() {
      return buildConfig.rolldownOptions;
    },
    set(newValue) {
      if (runtimeDeprecatedPath.has(path)) {
        rollupOptionsDeprecationCall();
      }
      buildConfig.rolldownOptions = newValue;
    },
  });
}
```

古い名前でアクセスしても新しい値が返り、逆に古い名前に書き込んでも新しいフィールドに反映される。`VITE_DEPRECATION_TRACE=1` 環境変数でスタックトレースも取得可能。

### プラグイン API の柔軟な合成設計

`PluginOption` 型は falsy 値・Promise・ネスト配列を許容し、条件付きプラグイン追加を自然な構文で実現する:

```typescript
// packages/vite/src/node/plugin.ts:379-388
export type FalsyPlugin = false | null | undefined;

export type PluginOption = Thenable<
  | Plugin
  | { name: string; } // for rollup plugin compatibility
  | FalsyPlugin
  | PluginOption[]
>;
```

```typescript
// packages/vite/src/node/plugins/index.ts:55-129 (抜粋)
return [
  !isBundled ? optimizedDepsPlugin() : null,
  ...prePlugins,
  modulePreload !== false && modulePreload.polyfill
    ? modulePreloadPolyfillPlugin(config)
    : null,
  ...normalPlugins,
  ...postPlugins,
  ...buildPlugins.post,
].filter(Boolean) as Plugin[];
```

### 公開 API と内部 API の分離

`package.json` の `exports` フィールドで公開エントリポイントを厳密に制御:

```json
// packages/vite/package.json:19-31
"exports": {
  ".": "./dist/node/index.js",
  "./client": { "types": "./client.d.ts" },
  "./module-runner": "./dist/node/module-runner.js",
  "./internal": "./dist/node/internal.js",
  "./types/internal/*": null  // 内部型へのアクセスを明示的にブロック
}
```

`@internal` JSDoc タグで内部専用フィールドをマーキングし、`index.ts` では公開 API のみを re-export する。`internalIndex.ts` は内部専用のエクスポートを分離している。

### 型テストによる API 契約の強制

開発専用の型テストファイルで、プラグイン型の互換性を静的に検証する:

```typescript
// packages/vite/src/node/__tests_dts__/plugin.ts:28-42
export type cases = [
  // Vite プラグインは Rolldown プラグインのスーパーセット
  ExpectTrue<ExpectExtends<RolldownPlugin, Plugin>>,
  // 全 Rollup フックが Vite のコンテキスト拡張を持つ
  ExpectTrue<Equal<HooksMissingExtension, never>>,
  // ROLLUP_HOOKS 定数が最新である
  ExpectTrue<Equal<HooksMissingInConstants, never>>,
  // Vite/Rolldown/Rollup プラグインが全て plugins オプションに渡せる
  ExpectTrue<ExpectExtends<PluginOption, RolldownPlugin>>,
  ExpectTrue<ExpectExtends<PluginOption, RollupPlugin>>,
  ExpectTrue<ExpectExtends<PluginOption, Plugin>>,
];
```

## パターンカタログ

- **Builder パターン** (分類: 生成)
  - 解決する問題: ユーザー入力（部分的・曖昧）を、内部で安全に使える完全な設定オブジェクトに変換する
  - 適用条件: 多数のオプション・デフォルト値・相互依存のある設定を持つツール
  - コード例: `config.ts:1370-2141`（`resolveConfig` 関数全体）
  - 注意点: 解決プロセスが複雑化しやすい。Vite の `resolveConfig` は 800 行弱あり、後方互換コードが大部分を占める

- **Proxy パターン** (分類: 構造)
  - 解決する問題: 非推奨 API へのアクセスを検知して警告しつつ、動作を維持する
  - 適用条件: 破壊的変更を段階的に導入する必要がある場合
  - コード例: `server/index.ts:581-603`, `utils.ts:1270-1282`
  - 注意点: getter/setter による暗黙的な動作はデバッグを困難にする場合がある

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: プラグインの適用条件を実行時に切り替える
  - 適用条件: `apply: 'serve' | 'build' | ((config, env) => boolean)` のように、文字列リテラルまたは関数で選択を表現する
  - コード例: `plugin.ts:218-221`, `config.ts:1432-1441`

## Good Patterns

- **Optional-In / Required-Out 型変換**: ユーザー向け型は全フィールド optional、内部型は `Required<>` で全フィールド確定。`mergeWithDefaults` でデフォルト値を注入し、解決済み型に変換する。ユーザーの人間工学と内部コードの堅牢性を両立する。

```typescript
// packages/vite/src/node/config.ts:306-314
export interface EnvironmentOptions extends SharedEnvironmentOptions {
  dev?: DevEnvironmentOptions; // optional
  build?: BuildEnvironmentOptions; // optional
}

// packages/vite/src/node/config.ts:264-272
export type ResolvedDevEnvironmentOptions =
  & Omit<
    Required<DevEnvironmentOptions>, // Required に変換
    "sourcemapIgnoreList"
  >
  & {
    sourcemapIgnoreList: Exclude<
      DevEnvironmentOptions["sourcemapIgnoreList"],
      false | undefined // falsy を除外
    >;
  };
```

- **構造化された非推奨メタデータ**: 非推奨メッセージ・ドキュメント URL・コードを `Record<keyof FutureOptions, string>` で一元管理し、`satisfies` で型安全性を保証する。

```typescript
// packages/vite/src/node/deprecations.ts:6-18
const deprecationCode = {
  removePluginHookSsrArgument: "this-environment-in-hooks",
  removeServerModuleGraph: "per-environment-apis",
  removeSsrLoadModule: "ssr-using-modulerunner",
} satisfies Record<keyof FutureOptions, string>;
```

- **Falsy 許容のプラグイン配列**: `PluginOption` 型が `false | null | undefined | PluginOption[]` を含むことで、条件式の結果をそのまま配列に入れ、`filter(Boolean)` で除去できる。ユーザーコードの可読性が大幅に向上する。

```typescript
// ユーザーコード例
plugins: [
  react(),
  isProduction && compress(), // false が許容される
  legacy ? legacyPlugin() : null, // null が許容される
];
```

## Anti-Patterns / 注意点

- **後方互換レイヤーの肥大化**: `resolveConfig` 関数は約 800 行に達し、その大部分が後方互換のためのフィールド移行コードである。「Backward compatibility:」コメントが `config.ts` 内に 10 箇所以上ある。互換レイヤーは計画的にメジャーバージョンで除去しないと、設定解決ロジックが理解不能になる。

```typescript
// Bad: 互換コードが散在する resolveConfig 内部
// packages/vite/src/node/config.ts:1495-1503
// Backward compatibility: server.warmup.clientFiles/ssrFiles -> environment.dev.warmup
const warmupOptions = config.server?.warmup;
if (warmupOptions?.clientFiles) {
  configEnvironmentsClient.dev.warmup = warmupOptions.clientFiles;
}
```

```typescript
// Better: 互換レイヤーを独立関数に分離し、削除予定バージョンをコメントで明記
function migrateWarmupOptions(config: UserConfig): void {
  // TODO: Remove in v9
  // ...
}
```

- **`@ts-expect-error` による削除済みオプション検出**: 削除済みオプションがまだ使われていないかを `@ts-expect-error` でチェックする手法は巧みだが、コード上で何を検出しているのかが分かりにくい。

```typescript
// packages/vite/src/node/config.ts:2113-2116
if (
  // @ts-expect-error Option removed
  config.legacy?.buildSsrCjsExternalHeuristics ||
  // @ts-expect-error Option removed
  config.ssr?.format === 'cjs'
)
```

## 導出ルール

- `[MUST]` ユーザー入力型と解決済み型を分離する。入力型は全フィールド optional、解決済み型は `Required<>` ベースとし、`mergeWithDefaults` 相当の関数でデフォルト注入と型変換を行う
  - 根拠: Vite は `UserConfig`（optional）と `ResolvedConfig`（required）を明確に分離し、内部コードから null チェックを排除している（`config.ts:339` / `config.ts:635`）

- `[MUST]` 非推奨 API は削除せず動作を維持しつつ、実行時に警告を発行する仕組みを用意する。警告には移行先のドキュメント URL を含める
  - 根拠: Vite の `warnFutureDeprecation` は警告メッセージ、ドキュメント URL、スタックトレースを一括で提供し、プラグイン作者が迅速に対応できるようにしている（`deprecations.ts:55-97`）

- `[SHOULD]` 型安全なアイデンティティ関数（`defineConfig` パターン）を設定 API に提供する。実行時コストゼロで IDE 補完・型検証が得られる
  - 根拠: `defineConfig` は `return config` するだけだが、6 つのオーバーロードで入力形式に応じた正確な型推論を実現している（`config.ts:175-183`）

- `[SHOULD]` API のライフサイクルを `experimental` → 安定 → `future`（非推奨予告）→ `legacy` → 削除の段階で管理し、各段階を設定オブジェクトの名前空間として構造化する
  - 根拠: Vite は `ExperimentalOptions`, `FutureOptions`, `LegacyOptions` で API 成熟度を型レベルで表現し、semver との対応を JSDoc で明示している（`config.ts:424-614`）

- `[SHOULD]` プラグイン API の型は、基盤フレームワーク（Rollup/Rolldown）の型のスーパーセットとして設計し、型テストで契約を強制する
  - 根拠: `__tests_dts__/plugin.ts` で `ExpectExtends<RolldownPlugin, Plugin>` を検証し、互換性の回帰を防止している

- `[SHOULD]` `package.json` の `exports` フィールドで公開 API のエントリポイントを明示し、内部モジュールへのアクセスは `null` でブロックする
  - 根拠: Vite は `"./types/internal/*": null` で内部型へのアクセスを禁止し、`"./internal"` は意図的に公開する内部 API として分離している（`package.json:19-31`）

- `[AVOID]` 非推奨 API の互換レイヤーをメイン設定解決関数に直接書く。互換コードは独立関数に分離し、削除予定バージョンを明記すべき
  - 根拠: Vite の `resolveConfig` は後方互換コードが散在し約 800 行に肥大化している。`// Backward compatibility:` コメントが 10 箇所以上存在する（`config.ts:1495-1645`）

## 適用チェックリスト

- [ ] 設定 API に `UserConfig`（optional）と `ResolvedConfig`（required）の型分離があるか
- [ ] デフォルト値の注入が `Object.freeze` された定数オブジェクトから行われているか
- [ ] 非推奨 API に移行ドキュメント URL 付きの警告メッセージが設定されているか
- [ ] `defineConfig` 相当の型安全ヘルパーが提供されているか
- [ ] プラグイン型が `false | null | undefined` を許容し、条件付き追加が自然に書けるか
- [ ] `package.json` の `exports` で公開 API が明示的に制御されているか
- [ ] 実験的・非推奨・レガシーの API ライフサイクルが構造的に管理されているか
- [ ] 互換レイヤーに削除予定バージョンのコメントが付与されているか
