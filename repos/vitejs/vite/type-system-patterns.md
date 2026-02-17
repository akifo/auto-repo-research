# type-system-patterns

> リポジトリ: vitejs/vite
> 分析日: 2026-02-17

## 概要

Vite 8 の型設計を分析した。78k stars のビルドツールとして、プラグイン API・設定・HMR という3つの主要ドメインで複雑な型を管理している。特筆すべきは、公開型定義(`types/`)と内部型定義(`src/types/`)を明確に分離し、`@internal` JSDoc + `stripInternal` + カスタムビルドパイプラインで公開 API の表面積を制御している点、および `isolatedDeclarations: true` を採用して型生成の高速化と明示性を両立している点である。条件型・module augmentation・`satisfies never` による網羅性チェックなど、大規模 TypeScript プロジェクトの型設計プラクティスが凝縮されている。

## 背景にある原則

- **公開 API の表面積を最小化すべき。内部型の漏洩はメジャーバージョン間の互換性維持コストを増大させるため**: Vite は `@internal` JSDoc + `compilerOptions.stripInternal` でビルド時に内部型を除去し、さらに `rolldown.dts.config.ts` の `patchTypes` プラグインで TypeScript が取りこぼした `@internal` パラメータ等も追加で除去している（`rolldown.dts.config.ts:354-378`）
- **型の正確性はビルドパイプラインで機械的に検証すべき。人間のレビューに依存すると漏れが生じるため**: 型バンドル後に `tsconfig.check.json` で `moduleResolution: "node16"` + `exactOptionalPropertyTypes: true` による厳格な消費者視点チェックを実行している（`tsconfig.check.json:1-18`）
- **devDependencies の型がランタイムバンドルに混入してはならない。消費者がインストールしていない型への参照は解決不能エラーを引き起こすため**: `src/types/` ディレクトリに devDependencies の型をインラインし、`#dep-types/*` パスマッピングで内部参照する戦略を取っている（`package.json:39`）
- **条件型と `satisfies` を組み合わせて、コンパイル時に不変条件を保証すべき。ランタイムエラーより型エラーのほうが修正コストが低いため**: 網羅性チェック、設定デフォルト値の型安全性、プラグインフック互換性テストなど、随所で `satisfies` が活用されている

## 実例と分析

### 3層の型エクスポート戦略

Vite は型を3つのレイヤーに分離している:

1. **公開型 (`types/`)**: ユーザーが `vite/types/*` として参照する `.d.ts` ファイル。`package.json` の `exports` で `"./types/*": { "types": "./types/*" }` としてエクスポートし、内部サブパスは `"./types/internal/*": null` で遮断している。
2. **内部型 (`src/types/`)**: devDependencies の型をインラインした `.d.ts` ファイル。`#dep-types/*` パスマッピングで内部参照する。消費者には一切公開されない。
3. **ソース型 (`src/node/*.ts`)**: 実装と同居する型定義。`src/node/index.ts` の `export type { ... }` で公開するものだけを選別している。

```typescript
// packages/vite/package.json:33-40
"imports": {
  "#types/*": "./types/*.d.ts",
  "#dep-types/*": "./src/types/*.d.ts"
},
```

```typescript
// packages/vite/src/node/index.ts:270-286 — dep-types の再エクスポート
export type {
  AliasOptions,
  MapToFunction,
  ResolverFunction,
  ResolverObject,
  Alias,
} from '#dep-types/alias'
export type { Connect } from '#dep-types/connect'
export type { WebSocket, WebSocketAlias } from '#dep-types/ws'
```

### `@internal` による公開 API 制御

`@internal` JSDoc タグをフィールド・パラメータ単位で付与し、`stripInternal: true` で型生成時に除去する。TypeScript の `stripInternal` が対応しない箇所（関数パラメータ内の `@internal` コメント、union 型の一部メンバー等）は、型バンドル後に Babel AST を解析して追加除去する。

```typescript
// packages/vite/src/node/server/moduleGraph.ts:49-50
/** @internal */
lastHMRInvalidationReceived = false
```

```typescript
// packages/vite/rolldown.dts.config.ts:384-404
function removeInternal(s: MagicString, node: any): boolean {
  if (
    node.leadingComments &&
    node.leadingComments.some((c: any) => {
      return c.type === 'CommentBlock' && c.value.includes('@internal')
    })
  ) {
    // strip trailing comma or pipe
    const trailingRe = /\s*[,|]/y
    trailingRe.lastIndex = node.end
    const trailingStr = trailingRe.exec(s.original)?.[0] ?? ''
    s.remove(node.leadingComments[0].start, node.end + trailingStr.length)
    return true
  }
  return false
}
```

### Module Augmentation による外部型の拡張

Vite は `declare module` を3つの目的で使っている:

1. **Rolldown プラグインコンテキストの拡張**: Vite 固有の `environment` プロパティを Rolldown の `MinimalPluginContext` に注入する。これにより、すべてのプラグインフックで `this.environment` にアクセスできるようになる。

```typescript
// packages/vite/src/node/plugin.ts:86-89
declare module 'rolldown' {
  export interface MinimalPluginContext extends PluginContextExtension {}
  export interface PluginContextMeta extends PluginContextMetaExtension {}
}
```

2. **Rolldown 出力メタデータの拡張**: `OutputAsset` や `RenderedChunk` に `viteMetadata` を追加する。

```typescript
// packages/vite/types/metadata.d.ts:32-47
declare module 'rolldown' {
  export interface OutputAsset {
    viteMetadata?: AssetMetadata
  }
  export interface RenderedChunk {
    viteMetadata?: ChunkMetadata
  }
}
```

3. **型なし依存関係への型付与**: `connect`, `cors`, `postcss-import` 等の型なしパッケージに対して `src/types/shims.d.ts` で宣言する。

### 条件型による型推論パターン

`InferCustomEventPayload<T>` は、既知イベント名にはマップから型を引き、未知イベント名には `any` にフォールバックする。

```typescript
// packages/vite/types/customEvent.d.ts:46-47
export type InferCustomEventPayload<T extends string> =
  T extends keyof CustomEventMap ? CustomEventMap[T] : any
```

`HookHandler<T>` は `ObjectHook<H>` ラッパーから内部ハンドラ型を抽出する。

```typescript
// packages/vite/src/node/plugin.ts:373
export type HookHandler<T> = T extends ObjectHook<infer H> ? H : T
```

`ImportGlobFunction` はジェネリクスと条件型で `eager` フラグに応じて同期/非同期の戻り値型を切り替える。

```typescript
// packages/vite/types/importGlob.d.ts:61-70
<
  Eager extends boolean,
  As extends string,
  T = As extends keyof KnownAsTypeMap ? KnownAsTypeMap[As] : unknown,
>(
  glob: string | string[],
  options?: ImportGlobOptions<Eager, As>,
): (Eager extends true ? true : false) extends true
  ? Record<string, T>
  : Record<string, () => Promise<T>>
```

### ViteTypeOptions: ユーザー拡張可能な型スイッチ

`importMeta.d.ts` で空インターフェース `ViteTypeOptions` を定義し、ユーザーが augmentation で `strictImportMetaEnv` キーを追加すると `ImportMetaEnv` の挙動が変わる仕組み。

```typescript
// packages/vite/types/importMeta.d.ts:7-14
interface ViteTypeOptions {}

type ImportMetaEnvFallbackKey =
  'strictImportMetaEnv' extends keyof ViteTypeOptions ? never : string

interface ImportMetaEnv extends Record<ImportMetaEnvFallbackKey, any> {
  BASE_URL: string
  MODE: string
  DEV: boolean
  PROD: boolean
  SSR: boolean
}
```

これにより、デフォルトでは `import.meta.env.ANY_KEY` が `any` で通り、`strictImportMetaEnv` を有効化すると未定義のキーがエラーになる。型テストも専用ファイルで検証されている（`src/node/__tests_dts__/typeOptions.ts`）。

### `satisfies never` による網羅性チェック

switch 文の `default` ケースで `satisfies never` を使い、すべての分岐が網羅されていることをコンパイル時に保証する。新しい列挙値が追加された場合、対応する分岐がなければ型エラーになる。

```typescript
// packages/vite/src/node/build.ts:1119-1121
default:
  logLeveling satisfies never
  // fallback to info if a unknown log level is passed
```

```typescript
// packages/vite/src/node/plugins/css.ts:3278-3279
default:
  throw new Error(`Unknown lang: ${lang satisfies never}`)
```

### Resolved 型パターン: UserConfig → ResolvedConfig

設定オブジェクトを「ユーザー入力型（すべてオプショナル）」と「解決済み型（必須フィールドが確定）」に分離し、`Omit` + intersection で差分を表現する。

```typescript
// packages/vite/src/node/config.ts:264-272
export type ResolvedDevEnvironmentOptions = Omit<
  Required<DevEnvironmentOptions>,
  'sourcemapIgnoreList'
> & {
  sourcemapIgnoreList: Exclude<
    DevEnvironmentOptions['sourcemapIgnoreList'],
    false | undefined
  >
}
```

```typescript
// packages/vite/src/node/config.ts:635-740 (抜粋)
export interface ResolvedConfig extends Readonly<
  Omit<UserConfig, 'plugins' | 'css' | 'json' | ...> & {
    root: string
    base: string
    plugins: readonly Plugin[]
    // ...
  }
> {}
```

### `string & {}` による文字列リテラル + 任意文字列の両立

```typescript
// packages/vite/types/customEvent.d.ts:52
export type CustomEventName = keyof CustomEventMap | (string & {})
```

```typescript
// packages/vite/src/node/server/index.ts:301
environments: Record<'client' | 'ssr' | (string & {}), DevEnvironment>
```

`string & {}` により、IDE の自動補完で既知のリテラル候補を提示しつつ、任意の文字列も受け付ける。

### 型レベルでの深い再帰マージ

`MergeWithDefaultsResult` は再帰的条件型でデフォルト値とオーバーライド値のマージ結果型を正確に推論する。

```typescript
// packages/vite/src/node/utils.ts:1176-1195
type MergeWithDefaultsResult<D, V> =
  Equal<D, undefined> extends true
    ? V
    : D extends Function | Array<any>
      ? MaybeFallback<D, V>
      : V extends Function | Array<any>
        ? MaybeFallback<D, V>
        : D extends Record<string, any>
          ? V extends Record<string, any>
            ? {
                [K in keyof D | keyof V]: K extends keyof D
                  ? K extends keyof V
                    ? MergeWithDefaultsResult<D[K], V[K]>
                    : D[K]
                  : K extends keyof V
                    ? V[K]
                    : never
              }
            : MaybeFallback<D, V>
          : MaybeFallback<D, V>
```

## パターンカタログ

- **Adapter パターン** (構造)
  - 解決する問題: Rolldown のプラグインインターフェースを Vite 固有のフック（`hotUpdate`, `configureServer` 等）で拡張しつつ、Rolldown プラグインとの互換性を維持する
  - 適用条件: 上流ライブラリの型を拡張しつつ、上流型との代入互換を保ちたい場合
  - コード例: `src/node/plugin.ts:101` — `Plugin<A> extends RolldownPlugin<A>` + module augmentation
  - 注意点: augmentation が上流の型更新で壊れる可能性がある。型テスト（`__tests_dts__/plugin.ts`）で `ExpectExtends` を使って互換性を継続検証している

- **Type State パターン** (振る舞い)
  - 解決する問題: `UserConfig`（未解決状態）と `ResolvedConfig`（解決済み状態）を型レベルで区別し、未解決設定を解決済みとして使うミスを防ぐ
  - 適用条件: オブジェクトが「未確定→確定」の状態遷移を持つ場合
  - コード例: `src/node/config.ts:339` `UserConfig` → `src/node/config.ts:635` `ResolvedConfig`
  - 注意点: `Omit` + intersection の組み合わせが複雑になりやすいため、ユーティリティ型（`RequiredExceptFor` 等）で分解する

## Good Patterns

- **`satisfies` によるデフォルト値の型安全性**: `Object.freeze({...} satisfies UserConfig)` により、デフォルト値オブジェクトがインターフェースに適合することをコンパイル時に保証しつつ、リテラル型を保持する。
```typescript
// packages/vite/src/node/config.ts:775-883
const configDefaults = Object.freeze({
  // ... フィールド群
} satisfies UserConfig)
```

- **`as const satisfies Record<K, V>` による型安全な定数マップ**: リテラル型の推論と Record 型の制約を両立する。
```typescript
// packages/vite/src/node/build.ts:1573-1579
const customRelativeUrlMechanisms = {
  ...relativeUrlMechanisms,
  'worker-iife': (relativePath) => getResolveUrl(...),
} as const satisfies Record<string, (relativePath: string) => string>
```

- **keyof ベースの型安全ジェネリック getter/setter**: `ModuleNode._get<T extends keyof EnvironmentModuleNode>(prop: T)` で、プロパティ名から戻り値型を自動推論する。
```typescript
// packages/vite/src/node/server/mixedModuleGraph.ts:33-37
_get<T extends keyof EnvironmentModuleNode>(
  prop: T,
): EnvironmentModuleNode[T] {
  return (this._clientModule?.[prop] ?? this._ssrModule?.[prop])!
}
```

- **`consistent-type-imports` ESLint ルール**: `import type` を強制することで、型インポートがランタイムバンドルに含まれないことを保証する。
```typescript
// eslint.config.js:154-157
'@typescript-eslint/consistent-type-imports': [
  'error',
  { prefer: 'type-imports', disallowTypeAnnotations: false },
],
```

## Anti-Patterns / 注意点

- **`Omit` の連鎖による可読性低下**: `ResolvedConfig` は `Omit<UserConfig, 10+ keys> & { ... }` という巨大な intersection 型になっており、IDE のホバー表示が読みにくい。

```typescript
// Bad: 大量の Omit キー
export interface ResolvedConfig extends Readonly<
  Omit<UserConfig, 'plugins' | 'css' | 'json' | 'assetsInclude' | 'optimizeDeps'
    | 'worker' | 'build' | 'dev' | 'environments' | 'experimental' | 'future'
    | 'server' | 'preview' | 'devtools'> & { /* 30+ フィールド */ }
> {}
```

```typescript
// Better: 共通部分をベース型として分離し、未解決/解決済みで個別に拡張する
interface ConfigBase { root?: string; base?: string; mode?: string }
interface UserConfig extends ConfigBase { plugins?: PluginOption[]; /* optional */ }
interface ResolvedConfig extends Required<ConfigBase> { plugins: readonly Plugin[]; /* required */ }
```

- **`mergeConfig` の引数に `Function` を渡す罠**: ランタイムで `throw` するが、型レベルでは `D extends Function ? never : D` で防いでいる。この制約型は呼び出し側で見落とされやすい。

```typescript
// packages/vite/src/node/utils.ts:1420-1421
defaults: D extends Function ? never : D,
overrides: O extends Function ? never : O,
```

## 導出ルール

- `[MUST]` 公開型と内部型を物理的に分離し、内部型は公開 API に漏洩させない
  - 根拠: Vite は `types/`（公開）、`src/types/`（devDeps インライン）、`src/node/`（ソース型）の3層に分離し、`package.json` の `exports` と `imports` で境界を制御している

- `[MUST]` `@internal` タグ付きメンバーがビルド成果物に残らないことを CI で検証する
  - 根拠: Vite は `stripInternal` + カスタム AST パッチ + `tsconfig.check.json` による消費者視点チェックの3段階で検証している

- `[SHOULD]` switch 文の網羅性チェックに `satisfies never` を使い、列挙値追加時の分岐漏れをコンパイル時に検出する
  - 根拠: Vite は `build.ts:1120`、`config.ts:2158`、`css.ts:3279`、`oxc.ts:68` など4箇所以上で `satisfies never` を使用している

- `[SHOULD]` ユーザー入力型（オプショナル）と解決済み型（必須）を明示的に分離し、`Required<T>` / `Omit` + intersection で変換する
  - 根拠: `UserConfig` → `ResolvedConfig`、`DevEnvironmentOptions` → `ResolvedDevEnvironmentOptions` など、Vite 全体で一貫して適用されている

- `[SHOULD]` デフォルト値オブジェクトには `satisfies InterfaceName` を付与し、インターフェースとの乖離をコンパイル時に検出する
  - 根拠: `configDefaults`（`config.ts:883`）、`buildEnvironmentOptionsDefaults`（`build.ts:413`）、`ssrConfigDefaults`（`ssr/index.ts:62`）等で一貫使用

- `[SHOULD]` devDependencies の型を公開 API に含める必要がある場合は、型定義をインラインし内部パスマッピングで参照する
  - 根拠: `src/types/alias.d.ts` 等でインラインし、`#dep-types/*` マッピングで参照。消費者が devDeps をインストールせずに型チェックが通る

- `[SHOULD]` 文字列リテラルの自動補完と任意文字列の受容を両立するには `'known' | (string & {})` パターンを使う
  - 根拠: `CustomEventName` や `environments` の Record キー型で採用されている

- `[AVOID]` `Omit` のキーを10個以上列挙する型定義。可読性が著しく低下し、キーの追加漏れリスクが増す
  - 根拠: `ResolvedConfig` は13個のキーを `Omit` しており、型定義の見通しが悪くなっている

## 適用チェックリスト

- [ ] 公開型定義と内部型定義が物理的に分離されているか確認する
- [ ] `package.json` の `exports` / `imports` で内部型のサブパスが遮断されているか確認する
- [ ] `@internal` タグ付きメンバーがビルド成果物から除去されることをテストしているか確認する
- [ ] ビルド済み型を消費者の `moduleResolution` 設定（`node16` 等）でチェックしているか確認する
- [ ] switch 文に `satisfies never` による網羅性チェックが入っているか確認する
- [ ] デフォルト値オブジェクトに `satisfies` が付与されているか確認する
- [ ] `import type` の強制ルール（ESLint `consistent-type-imports`）が設定されているか確認する
- [ ] 文字列リテラルユニオンで任意文字列も受け付けたい箇所に `(string & {})` を使っているか確認する
