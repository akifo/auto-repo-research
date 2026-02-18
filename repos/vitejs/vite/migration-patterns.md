# migration-patterns

> リポジトリ: vitejs/vite
> 分析日: 2026-02-17

## 概要

Vite 8 は esbuild/Rollup から Rolldown/Oxc への大規模なバンドラー移行を進めている。この移行は一夜にして行われたものではなく、`future`/`legacy` フラグ、自動変換レイヤー、Property Proxy による段階的な非推奨化、中間パッケージ（`rolldown-vite`）の活用など、複数の戦略が組み合わされている。数万のプラグイン・フレームワークのエコシステムを壊さずに基盤技術を入れ替えるための実践的パターンが詰まっており、大規模な破壊的変更を管理する際の参考になる。

## 背景にある原則

- **段階的移行の原則**: 破壊的変更は一度に適用せず、「事前警告フェーズ → 互換レイヤーフェーズ → 削除フェーズ」の3段階で行うべき。なぜなら、エコシステム全体が同時に追従することは不可能であり、移行期間中の混在状態を安全に扱う仕組みが必要だから。Vite は `future` オプションで事前警告を出し、`convertEsbuildConfigToOxcConfig` で自動変換を行い、最終的に旧 API を削除する計画を示している（`config.ts:431`, `deprecations.ts:53-54`）。

- **互換レイヤーは「変換」であり「共存」ではない原則**: 旧 API と新 API を独立して維持するのではなく、旧 API を内部的に新 API へ変換すべき。これにより実装が一本化され、二重メンテナンスのコストが消える。Vite は `rollupOptions` を `rolldownOptions` への Proxy に変換し（`utils.ts:1270-1282`）、`esbuild` オプションを `oxc` オプションに変換している（`config.ts:1849-1850`）。

- **非推奨警告の構造化原則**: 非推奨警告はコード・ドキュメントURL・スタックトレースの3点セットで提供すべき。開発者が「何が非推奨か」「どう移行するか」「どこで使われているか」を即座に判断できるようにするため。`deprecations.ts:68-93` でこの3点を一元管理している。

- **フィーチャーフラグによる前方互換性**: ユーザーが自分のペースで新しい振る舞いをオプトインできるべき。`future: 'warn'` で全非推奨警告を一括有効化する shorthand と、個別フラグによる粒度の両方を提供している（`config.ts:1943-1956`）。

## 実例と分析

### 1. 自動変換レイヤーによる設定移行

esbuild の設定を oxc の設定に自動変換する `convertEsbuildConfigToOxcConfig` は、移行の中核パターンである。旧設定を受け取り、新設定の形式にマッピングし、マッピング不可能なオプション（`banner`/`footer`）については警告を出す。

```typescript
// packages/vite/src/node/plugins/oxc.ts:366-427
export function convertEsbuildConfigToOxcConfig(
  esbuildConfig: ESBuildOptions,
  logger: Logger,
): OxcOptions {
  const { jsxInject, include, exclude, ...esbuildTransformOptions } = esbuildConfig;

  const oxcOptions: OxcOptions = {
    jsxInject,
    include,
    exclude,
  };

  // JSX 設定の変換: esbuild と oxc で API 体系が異なるため、
  // switch-case でマッピング
  if (esbuildTransformOptions.jsx === "preserve") {
    oxcOptions.jsx = "preserve";
  } else {
    const jsxOptions: OxcJsxOptions = {};
    switch (esbuildTransformOptions.jsx) {
      case "automatic":
        jsxOptions.runtime = "automatic";
        // ...
        break;
      case "transform":
        jsxOptions.runtime = "classic";
        // ...
        break;
    }
    oxcOptions.jsx = jsxOptions;
  }

  // 変換不可能なオプションは警告で通知
  if (esbuildTransformOptions.banner) {
    warnDeprecatedShouldBeConvertedToPluginOptions(logger, "banner");
  }

  return oxcOptions;
}
```

設定の解決時、両方指定された場合は新 API を優先し、警告を出す:

```typescript
// packages/vite/src/node/config.ts:1841-1851
let oxc: OxcOptions | false | undefined = config.oxc;
if (config.esbuild) {
  if (config.oxc) {
    logger.warn(
      `Both esbuild and oxc options were set. oxc options will be used...`,
    );
  } else {
    oxc = convertEsbuildConfigToOxcConfig(config.esbuild, logger);
  }
}
```

### 2. Property Proxy による名前変更の後方互換性

`rollupOptions` から `rolldownOptions` への移行では、旧プロパティを新プロパティへの Proxy として定義する手法が使われている。旧プロパティへの読み書きが新プロパティに透過的に転送されるため、既存のプラグインが壊れない。

```typescript
// packages/vite/src/node/utils.ts:1250-1283
export function setupRollupOptionCompat<
  T extends Pick<BuildEnvironmentOptions, "rollupOptions" | "rolldownOptions">,
>(buildConfig: T, path: string): asserts buildConfig is T & {
  rolldownOptions: Exclude<T["rolldownOptions"], undefined>;
} {
  // rolldownOptions が未設定なら rollupOptions の値をフォールバック
  buildConfig.rolldownOptions ??= buildConfig.rollupOptions;

  // rollupOptions を rolldownOptions への Proxy に変換
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
    configurable: true,
    enumerable: true,
  });
}
```

この Proxy は config 解決の複数箇所で一貫して適用されている（`config.ts:1383-1390`）。

### 3. future/legacy フラグによる段階的な非推奨通知

`future` オプションは「将来のメジャーバージョンで削除予定の機能」を事前に警告する仕組みである。各非推奨項目にコードとメッセージが構造化されている。

```typescript
// packages/vite/src/node/deprecations.ts:6-18
const deprecationCode = {
  removePluginHookSsrArgument: "this-environment-in-hooks",
  removePluginHookHandleHotUpdate: "hotupdate-hook",
  removeServerModuleGraph: "per-environment-apis",
  // ...
} satisfies Record<keyof FutureOptions, string>;
```

`warnFutureDeprecation` は「フラグが `'warn'` に設定されている場合のみ」警告を出す。プラグイン作者向けにスタックトレースとドキュメントURLを付与する:

```typescript
// packages/vite/src/node/deprecations.ts:55-96
export function warnFutureDeprecation(
  config: ResolvedConfig,
  type: keyof FutureOptions,
  extraMessage?: string,
  stacktrace = true,
): void {
  if (
    _ignoreDeprecationWarnings || !config.future
    || config.future[type] !== "warn"
  ) {
    return;
  }

  let msg = `[vite future] ${deprecationMessages[type]}`;
  const docs = `${docsURL}/changes/${deprecationCode[type].toLowerCase()}`;
  // スタックトレースを付与してプラグイン内の該当箇所を特定可能にする
}
```

getter trap を使って、非推奨プロパティへのアクセス時に警告を発火する:

```typescript
// packages/vite/src/node/server/index.ts:581-583
get hot() {
  warnFutureDeprecation(config, 'removeServerHot')
  return hot
},
```

### 4. 中間パッケージ（rolldown-vite）による段階的移行

Vite 7 時代に `rolldown-vite` という npm パッケージを公開し、Vite 7 + Rolldown の技術プレビューを提供した。これにより、Vite 8 の他の破壊的変更とバンドラー移行を分離して検証できる。

```json
// 段階的移行: まず rolldown-vite で Rolldown のみ検証
{ "vite": "npm:rolldown-vite@7.2.2" }
// 次に Vite 8 に移行
{ "vite": "^8.0.0" }
```

### 5. ネイティブプラグインのバージョニング

`enableNativePlugin` は `'v1'` / `'v2'` / `true` / `false` のレベル制御を提供し、Rust 実装のネイティブプラグインを段階的に有効化する。

```typescript
// packages/vite/src/node/config.ts:2143-2160
function resolveNativePluginEnabledLevel(enableNativePlugin) {
  switch (enableNativePlugin) {
    case "v1":
      return 1;
    case "v2":
    case true:
      return 2;
    case false:
      return -1;
  }
}
```

oxc プラグインはこのレベルに基づき、ネイティブ実装と JS 実装を切り替える:

```typescript
// packages/vite/src/node/plugins/oxc.ts:211-239
export function oxcPlugin(config: ResolvedConfig): Plugin {
  if (config.isBundled && config.nativePluginEnabledLevel >= 1) {
    return perEnvironmentPlugin("native:transform", (environment) => {
      return nativeTransformPlugin({/* ... */});
    });
  }
  // ネイティブが無効の場合は JS 実装にフォールバック
  // ...
}
```

### 6. 非推奨警告の一時抑制

内部コードが非推奨 API を意図的に使用する場合（後方互換性のための委譲など）、警告を一時的に抑制する仕組みがある。

```typescript
// packages/vite/src/node/deprecations.ts:99-105
export function ignoreDeprecationWarnings<T>(fn: () => T): T {
  const before = _ignoreDeprecationWarnings;
  _ignoreDeprecationWarnings = true;
  const ret = fn();
  _ignoreDeprecationWarnings = before;
  return ret;
}

// packages/vite/src/node/server/hmr.ts:376
const mixedModuleGraph = ignoreDeprecationWarnings(() => server.moduleGraph);
```

## パターンカタログ

- **Adapter パターン** (分類: 構造)
  - 解決する問題: 旧 API (esbuild 設定) と新 API (oxc 設定) のインターフェース不一致
  - 適用条件: ツールの入れ替え時に設定体系が異なる場合
  - コード例: `plugins/oxc.ts:366-427` の `convertEsbuildConfigToOxcConfig`
  - 注意点: 1対1マッピングできないオプション（`banner`/`footer`）は明示的に警告する

- **Proxy パターン** (分類: 構造)
  - 解決する問題: プロパティ名変更時の後方互換性
  - 適用条件: API 名を変更しつつ、旧名でのアクセスも暫定的にサポートする場合
  - コード例: `utils.ts:1270-1282` の `Object.defineProperty` による getter/setter
  - 注意点: Proxy の存在をユーザーに意識させないために `enumerable: true` を設定

- **Feature Flag パターン** (分類: 振る舞い / Strategy)
  - 解決する問題: 破壊的変更の段階的な導入
  - 適用条件: メジャーバージョンアップに先立ち、ユーザーに移行準備期間を提供する場合
  - コード例: `config.ts:533-545` の `FutureOptions`, `deprecations.ts:44-48` の `isFutureDeprecationEnabled`
  - 注意点: フラグの粒度（個別 vs 一括 `'warn'`）を両方提供する

## Good Patterns

- **自動変換 + 警告の組み合わせ**: 旧オプションを自動的に新オプションに変換しつつ、移行を促す警告を出す。ユーザーは移行前でもアプリケーションが動作し、かつ移行すべき箇所が明示される。
  ```typescript
  // packages/vite/src/node/config.ts:1841-1851
  if (config.esbuild) {
    if (config.oxc) {
      logger.warn(`Both esbuild and oxc options were set...`);
    } else {
      oxc = convertEsbuildConfigToOxcConfig(config.esbuild, logger);
    }
  }
  ```

- **`satisfies Record<keyof T, string>` による網羅性保証**: 非推奨コードとメッセージの対応表が型レベルで網羅されていることを保証する。新しい非推奨項目を `FutureOptions` に追加すると、対応表への追加漏れがコンパイルエラーになる。
  ```typescript
  // packages/vite/src/node/deprecations.ts:18
  } satisfies Record<keyof FutureOptions, string>
  ```

- **getter trap による遅延警告**: 非推奨プロパティへのアクセス時にのみ警告を出す。プロパティが使われない限り警告が発生しないため、ノイズが少ない。
  ```typescript
  // packages/vite/src/node/server/index.ts:597-600
  get moduleGraph() {
    warnFutureDeprecation(config, 'removeServerModuleGraph')
    return moduleGraph
  },
  ```

- **中間パッケージによるリスク分離**: `rolldown-vite` により「バンドラー変更」と「他の破壊的変更」を独立して検証できるようにした。ユーザーが問題の原因を切り分けやすくなる。

## Anti-Patterns / 注意点

- **互換レイヤーの無期限維持**: 自動変換レイヤーを作ったまま削除期限を設けないと、二重メンテナンスが永続化する。Vite は「deprecated and will be removed in the future」と明記しているが、具体的な削除バージョンの記載がない箇所もある。
  ```typescript
  // Bad: 削除時期が不明確
  console.warn("`transformWithEsbuild` is deprecated and will be removed in the future.");

  // Better: 削除時期を明示
  console.warn("`transformWithEsbuild` is deprecated and will be removed in v9.0.");
  ```

- **Proxy ベースの互換性の複雑さ**: `Object.defineProperty` による Proxy は強力だが、デバッグ時に `console.log` で見えるプロパティと実際の動作が異なる場合がある。`VITE_DEPRECATION_TRACE=1` 環境変数でスタックトレースを出す回避策を提供している（`utils.ts:1238`）が、知らないユーザーにとっては非直感的。
  ```typescript
  // Bad: 環境変数に頼ったデバッグ
  const method = process.env.VITE_DEPRECATION_TRACE ? "trace" : "warn";

  // Better: デフォルトで trace を含めるか、ドキュメントの URL を常に提示
  ```

## 導出ルール

- `[MUST]` 破壊的変更にはマイグレーションパスを必ず用意する（自動変換レイヤー、互換 Proxy、移行ガイドのいずれか）
  - 根拠: Vite は esbuild→oxc（`convertEsbuildConfigToOxcConfig`）、rollup→rolldown（`setupRollupOptionCompat`）の両方で自動変換を提供し、既存設定が動作し続けるようにしている

- `[MUST]` 非推奨警告には「何が非推奨か」「どう移行するか」の2点を含める
  - 根拠: `deprecations.ts` では各非推奨項目にメッセージとドキュメントURL を紐付け、開発者が即座に移行方法を参照できるようにしている

- `[SHOULD]` 旧 API を自動変換レイヤーで新 API に内部変換し、実装を一本化する
  - 根拠: `config.ts:1849-1850` で `esbuild` オプションを `oxc` に変換した後、実行時には `oxc` のみを参照する設計により、旧 API 用の独立した実行パスが不要

- `[SHOULD]` フィーチャーフラグに個別制御と一括制御の両方を提供する
  - 根拠: `future: 'warn'` で全非推奨警告を一括有効化でき（`config.ts:1944`）、個別のフラグでも制御できる設計により、フレームワーク作者（全フラグ確認）と一般ユーザー（特定フラグのみ）の両方のニーズに対応

- `[SHOULD]` 大規模な基盤変更では中間リリース（stepping stone）を提供して、変更を分離検証可能にする
  - 根拠: `rolldown-vite` パッケージにより、Vite 7 のまま Rolldown だけを検証でき、問題の原因切り分けが容易になった

- `[SHOULD]` 非推奨項目と対応コードの対応表は型システムで網羅性を保証する
  - 根拠: `satisfies Record<keyof FutureOptions, string>` により、`FutureOptions` にキーを追加すると `deprecationCode` と `deprecationMessages` への追加漏れがコンパイル時に検出される（`deprecations.ts:18,40`）

- `[AVOID]` 旧 API と新 API を独立した実行パスとして維持すること（分岐の爆発と二重バグのリスク）
  - 根拠: Vite は旧設定を新設定に変換した上で新しい実行パスのみを通す設計を採用しており、esbuild 用の独立した最適化パスは維持していない

## 適用チェックリスト

- [ ] 破壊的変更を計画する際、「警告フェーズ → 互換レイヤーフェーズ → 削除フェーズ」の3段階を設計しているか
- [ ] 旧 API の設定を新 API に自動変換するアダプター関数を用意しているか
- [ ] 非推奨警告にドキュメントURL または移行ガイドへのリンクを含めているか
- [ ] 非推奨項目の一覧を型レベルで管理し、追加漏れをコンパイルエラーで検出できるようにしているか
- [ ] プロパティ名の変更には `Object.defineProperty` による Proxy を使い、旧名でのアクセスを透過的に転送しているか
- [ ] フィーチャーフラグに一括有効化の shorthand を提供しているか
- [ ] 大規模な基盤変更（バンドラー入れ替え等）では中間パッケージや段階的リリースを検討しているか
- [ ] 内部コードが非推奨 API を使う場合の警告抑制メカニズム（`ignoreDeprecationWarnings`）があるか
