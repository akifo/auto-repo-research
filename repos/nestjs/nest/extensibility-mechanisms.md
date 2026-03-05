# Extensibility Mechanisms

> リポジトリ: nestjs/nest
> 分析日: 2026-03-03

## 概要

NestJS の拡張性設計を、動的モジュール、ConfigurableModuleBuilder、カスタムプロバイダ、グローバルモジュール、モジュール再エクスポートの5軸で横断的に分析する。フレームワークが「設定を受け取って振る舞いを変えるモジュール」をどう構造化し、利用者に一貫した API を提供しているかに注目する。DI コンテナとモジュールシステムの連携が、プラグイン的な拡張性を実現する中核メカニズムである。

## 背景にある原則

- **静的構造と動的設定の分離**: モジュールのクラス定義（`@Module()` デコレータ）は静的な依存関係グラフを記述し、`DynamicModule` インターフェースが実行時の設定を注入する。この分離により、モジュールの構造は宣言的に保ちつつ、設定は利用者が制御できる。根拠: `DynamicModule` は `ModuleMetadata` を拡張しつつ `module` プロパティで自身のクラス参照を保持する設計（`packages/common/interfaces/modules/dynamic-module.interface.ts:11`）。

- **ボイラープレート排除を型安全に行う**: `ConfigurableModuleBuilder` は Builder パターンと TypeScript の template literal types を組み合わせ、`register`/`registerAsync` メソッドのペア生成を自動化する。利用者が書くコードを最小化しつつ、型推論で誤用を防止する。根拠: `ConfigurableModuleCls` の型定義が `Record<MethodKey, (options) => DynamicModule>` と `Record<MethodKeyAsync, (options) => DynamicModule>` を交差型で結合（`packages/common/module-utils/interfaces/configurable-module-cls.interface.ts:22-39`）。

- **スコープの明示的制御とデフォルトの安全性**: プロバイダの可視性はモジュールスコープに閉じ、明示的に `exports` に含めなければ外部からアクセスできない。`@Global()` はその制約を意図的に緩和する例外機構であり、デフォルトではカプセル化が優先される。根拠: `validateExportedProvider` がエクスポートされていないプロバイダへのアクセスを例外で拒否する（`packages/core/injector/module.ts:488-504`）。

- **設定取得戦略の多態性**: `useClass` / `useFactory` / `useExisting` の3つの非同期設定取得パスが、Strategy パターンとして統一的に扱われる。利用者は設定の取得方法を選択でき、フレームワーク側は統一的に処理する。根拠: `createAsyncProviders` が3パスを分岐処理（`packages/common/module-utils/configurable-module.builder.ts:300-323`）。

## 実例と分析

### DynamicModule による設定の注入

静的な `@Module()` デコレータは imports/providers/controllers/exports を固定的に宣言する。`DynamicModule` はこの制約を緩和し、静的メソッド（`register`, `forRoot` 等）から設定を受け取って動的にモジュール定義を返す。

```typescript
// packages/common/interfaces/modules/dynamic-module.interface.ts:11-27
export interface DynamicModule extends ModuleMetadata {
  module: Type<any>;
  global?: boolean;
}
```

`module` プロパティが自身のクラス参照を保持することで、コンテナはどのクラスに動的メタデータを紐づけるかを判別する。`global?: boolean` フラグにより、動的モジュールもランタイムでグローバルスコープに昇格できる。

### ConfigurableModuleBuilder によるボイラープレート排除

動的モジュールの `register`/`registerAsync` ペアを手書きすると、プロバイダ定義・ファクトリ・型定義が重複する。`ConfigurableModuleBuilder` は Builder パターンでこのボイラープレートを排除する。

```typescript
// packages/common/module-utils/configurable-module.builder.ts:170-191
build(): ConfigurableModuleHost<...> {
  this.staticMethodKey ??= DEFAULT_METHOD_KEY as StaticMethodKey;
  this.factoryClassMethodKey ??= DEFAULT_FACTORY_CLASS_METHOD_KEY as FactoryClassMethodKey;
  this.options.optionsInjectionToken ??= this.options.moduleName
    ? this.constructInjectionTokenString()
    : generateOptionsInjectionToken();
  this.transformModuleDefinition ??= definition => definition;

  return {
    ConfigurableModuleClass: this.createConfigurableModuleCls<ModuleOptions>(),
    MODULE_OPTIONS_TOKEN: this.options.optionsInjectionToken,
    ASYNC_OPTIONS_TYPE: this.createTypeProxy('ASYNC_OPTIONS_TYPE'),
    OPTIONS_TYPE: this.createTypeProxy('OPTIONS_TYPE'),
  };
}
```

注目すべきは `ASYNC_OPTIONS_TYPE` と `OPTIONS_TYPE` が Proxy で実装されている点。これらは `typeof ASYNC_OPTIONS_TYPE` として型推論にのみ使われ、値としてアクセスするとエラーを投げる（`packages/common/module-utils/configurable-module.builder.ts:357-371`）。型レベルのユーティリティを値の世界で擬似的に表現するテクニック。

### setExtras による動的モジュール定義の変換

`setExtras` は動的モジュール定義を後処理する変換関数を登録する。典型例は `isGlobal` フラグ:

```typescript
// packages/common/test/module-utils/configurable-module.builder.spec.ts:8-26
const { ConfigurableModuleClass } = new ConfigurableModuleBuilder()
  .setExtras(
    { isGlobal: false },
    (definition, extras: { isGlobal: boolean; }) => ({
      ...definition,
      global: extras.isGlobal,
    }),
  )
  .build();
```

extras の値はオプション本体から分離される（`omitExtras` メソッド、行 263-279）。これにより、モジュールの構造的設定（`isGlobal`）とビジネス設定（接続文字列等）が型レベルで分離される。

### カスタムプロバイダの5つの戦略

プロバイダは `Type<any>` | `ClassProvider` | `ValueProvider` | `FactoryProvider` | `ExistingProvider` の Union 型で表現される:

```typescript
// packages/common/interfaces/modules/provider.interface.ts:10-15
export type Provider<T = any> =
  | Type<any>
  | ClassProvider<T>
  | ValueProvider<T>
  | FactoryProvider<T>
  | ExistingProvider<T>;
```

`Module.addCustomProvider` がタイプガードで各バリアントを判別し、適切な `InstanceWrapper` を生成する（`packages/core/injector/module.ts:305-324`）。特に `ExistingProvider` はエイリアス機能を提供し、`isAlias: true` フラグで内部的に区別される（行 440-455）。

### グローバルモジュールとスコープバインディング

`@Global()` デコレータは `Reflect.defineMetadata` でメタデータを付与するだけのシンプルな実装:

```typescript
// packages/common/decorators/modules/global.decorator.ts:14-18
export function Global(): ClassDecorator {
  return (target: Function) => {
    Reflect.defineMetadata(GLOBAL_MODULE_METADATA, true, target);
  };
}
```

コンテナ側で `isGlobalModule` が静的デコレータと動的フラグの両方を検査する（`packages/core/injector/container.ts:208-216`）。グローバルモジュールは `bindGlobalScope` で全モジュールの imports に追加され（行 318-320）、distance は `Number.MAX_VALUE` に設定されてライフサイクルフックの実行順序が最初になる（行 178-179）。

### モジュール再エクスポートと依存解決の再帰走査

`lookupComponentInImports` はインポートツリーを再帰的に走査し、exports に含まれるプロバイダのみを可視化する:

```typescript
// packages/core/injector/injector.ts:652-658
let children = [...imports.values()].filter(identity);
if (isTraversing) {
  const contextModuleExports = moduleRef.exports;
  children = children.filter(child => contextModuleExports.has(child.metatype));
}
```

`isTraversing` フラグが重要: 直接のインポート先では全プロバイダを検索するが、再帰的に辿る際は `exports` でフィルタリングする。これにより「モジュール A が B をインポートし、B が C を再エクスポート」のチェーンが安全に解決される。

### LazyModuleLoader による遅延ロード

`LazyModuleLoader` はアプリケーション起動後に動的にモジュールをロードする:

```typescript
// packages/core/injector/lazy-module-loader/lazy-module-loader.ts:21-55
public async load(
  loaderFn: () => Promise<Type<unknown> | DynamicModule> | Type<unknown> | DynamicModule,
  loadOpts?: LazyModuleLoaderLoadOptions,
): Promise<ModuleRef> {
  const moduleClassOrDynamicDefinition = await loaderFn();
  const moduleInstances = await this.dependenciesScanner.scanForModules({
    moduleDefinition: moduleClassOrDynamicDefinition,
    overrides: this.moduleOverrides,
    lazy: true,
  });
  // ...
}
```

`lazy: true` フラグにより、既にロード済みのモジュールはスキップされ、新規モジュールのみがコンテナに追加される。遅延ロードされたモジュールにもグローバルモジュールが自動バインドされる（`scanner.ts:172-173`、`bindGlobalsToImports`）。

### モジュール ID の生成戦略

動的モジュールの同一性判定は、オプションの内容によって「同じモジュールか別のモジュールか」が変わる。2つの戦略が提供される:

- **ByReference**: オブジェクト参照に基づく（デフォルト）。同じ `DynamicModule` オブジェクトは同一モジュールとして扱われる
- **DeepHashed**: オプションの内容を SHA-256 ハッシュ化。同じ内容なら同一モジュール

`alwaysTransient` オプションは `CONFIGURABLE_MODULE_ID` にランダム値を注入し、呼び出しごとにユニークなモジュールを生成する（`configurable-module.builder.ts:221-226`）。

## パターンカタログ

- **Builder パターン** (分類: 生成)
  - 解決する問題: 動的モジュール定義のボイラープレートと型安全性の両立
  - 適用条件: 設定可能なモジュールを提供するライブラリ・フレームワーク
  - コード例: `packages/common/module-utils/configurable-module.builder.ts:53-355`
  - 注意点: 各 `set*` メソッドが新しい Builder インスタンスを返す（immutable builder）。内部で `parentBuilder` を参照して設定を引き継ぐ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: プロバイダの生成方法（クラス/値/ファクトリ/エイリアス）の多態的な扱い
  - 適用条件: 依存性の提供方法が複数存在し、利用者に選択を委ねたい場面
  - コード例: `packages/core/injector/module.ts:305-324`（`addCustomProvider` のタイプガード分岐）
  - 注意点: タイプガードの順序が重要 — `useValue` の検査は `hasOwnProperty` を使う（`undefined` を値として許容するため）

- **Proxy パターン** (分類: 構造)
  - 解決する問題: 型推論専用の値（`OPTIONS_TYPE`, `ASYNC_OPTIONS_TYPE`）が実行時にアクセスされることの防止
  - 適用条件: TypeScript の `typeof` 演算子で型を抽出したいが、値としての使用を禁止したい場面
  - コード例: `packages/common/module-utils/configurable-module.builder.ts:357-371`

## Good Patterns

- **Immutable Builder チェーン**: `ConfigurableModuleBuilder` の `setExtras`/`setClassMethodName`/`setFactoryMethodName` は毎回新しいインスタンスを返し、型パラメータを段階的に特殊化する。これにより中間状態の型が正確に推論される。

```typescript
// packages/common/module-utils/configurable-module.builder.ts:102-118
setExtras<ExtraModuleDefinitionOptions>(
  extras: ExtraModuleDefinitionOptions,
  transformDefinition: (...) => DynamicModule = def => def,
) {
  const builder = new ConfigurableModuleBuilder<
    ModuleOptions, StaticMethodKey, FactoryClassMethodKey,
    ExtraModuleDefinitionOptions  // 新しい型パラメータ
  >(this.options, this as any);
  builder.extras = extras;
  builder.transformModuleDefinition = transformDefinition;
  return builder;  // 型が変わった新インスタンス
}
```

- **構造的設定とビジネス設定の分離**: `setExtras` の `omitExtras` は extras キーをオプションオブジェクトから除外し、`MODULE_OPTIONS_TOKEN` にはビジネス設定のみを注入する。モジュールのメタ設定（`isGlobal`）がプロバイダの設定値に混入しない。

```typescript
// packages/common/module-utils/configurable-module.builder.ts:263-279
private static omitExtras(
  input: ModuleOptions & ExtraModuleDefinitionOptions,
  extras: ExtraModuleDefinitionOptions | undefined,
): ModuleOptions {
  if (!extras) { return input; }
  const moduleOptions = {};
  const extrasKeys = Object.keys(extras);
  Object.keys(input as object)
    .filter(key => !extrasKeys.includes(key))
    .forEach(key => { moduleOptions[key] = input[key]; });
  return moduleOptions as ModuleOptions;
}
```

- **exports によるカプセル化の階層的制御**: `lookupComponentInImports` の `isTraversing` フラグにより、直接インポートしたモジュールのプロバイダは全て見えるが、間接的なモジュールは exports で明示されたものだけが可視になる。再エクスポートによる「ファサードモジュール」パターンが安全に機能する。

## Anti-Patterns / 注意点

- **@Global() の濫用によるスコープ汚染**: `bindGlobalScope` は全モジュールの imports にグローバルモジュールを追加する（`container.ts:318-320`）。グローバルモジュールが増えると暗黙の依存が生まれ、モジュール間の依存関係が不透明になる。

```typescript
// Bad: 多数のモジュールを @Global() にする
@Global()
@Module({ providers: [UtilsService], exports: [UtilsService] })
export class UtilsModule {}

@Global()
@Module({ providers: [LoggerService], exports: [LoggerService] })
export class LoggerModule {}

// Better: 必要なモジュールでインポートする
@Module({ imports: [UtilsModule, LoggerModule], ... })
export class FeatureModule {}
```

- **動的モジュールの同一性問題**: `ByReferenceModuleOpaqueKeyFactory` はオブジェクト参照で同一性を判定するため、`forRoot()` を複数箇所で呼ぶと別モジュールとして登録される。`alwaysTransient: true` を意図せず使うと、設定が重複してメモリリークの原因になる。

```typescript
// Bad: forRoot を複数回呼ぶ（意図せず別モジュールが生成される）
@Module({ imports: [ConfigModule.forRoot({ path: ".env" })] })
class Module1 {}
@Module({ imports: [ConfigModule.forRoot({ path: ".env" })] })
class Module2 {}

// Better: forRoot は AppModule で1回だけ、@Global() と組み合わせる
@Module({ imports: [ConfigModule.forRoot({ isGlobal: true, path: ".env" })] })
class AppModule {}
```

- **useValue での undefined 値の見落とし**: `isCustomValue` は `Object.prototype.hasOwnProperty.call(provider, 'useValue')` でチェックする（`module.ts:331-335`）。`useValue: undefined` は `hasOwnProperty` を通過するが、`isUndefined` ベースのチェックでは検出できない。プロバイダ種別の判定順序が重要。

## 導出ルール

- `[MUST]` 動的モジュールの設定メソッド（`register`/`forRoot` 等）は同期版と非同期版（`Async` サフィックス）をペアで提供する
  - 根拠: `ConfigurableModuleBuilder` が `staticMethodKey + 'Async'` で自動生成しており、NestJS エコシステム全体の規約（`configurable-module.builder.ts:209`）

- `[MUST]` カスタムプロバイダのタイプガードでは `useValue` の検査に `hasOwnProperty` を使う（`undefined` を正当な値として許容する）
  - 根拠: `module.ts:331-335` で `isCustomValue` が `Object.prototype.hasOwnProperty.call(provider, 'useValue')` を使用し、`useValue: undefined` と `useValue` プロパティ未設定を区別している

- `[SHOULD]` モジュールのメタ設定（グローバル化フラグ等）とビジネス設定（接続文字列等）は型レベルで分離し、DI トークンにはビジネス設定のみを注入する
  - 根拠: `ConfigurableModuleBuilder.setExtras` + `omitExtras` による分離パターン（`configurable-module.builder.ts:263-279`）

- `[SHOULD]` Builder パターンで段階的に型パラメータを特殊化する場合、各ステップで新しいインスタンスを返す（immutable builder）ことで中間状態の型安全性を保証する
  - 根拠: `setExtras`/`setClassMethodName`/`setFactoryMethodName` が毎回 `new ConfigurableModuleBuilder(this.options, this)` を返す（`configurable-module.builder.ts:109-117`）

- `[SHOULD]` グローバルスコープのモジュールは「インフラストラクチャ層」（設定、ロギング、リフレクション等）に限定し、ドメインモジュールには使わない
  - 根拠: `InternalCoreModule` のみが `@Global()` を持つ設計（`internal-core-module.ts:16-17`）。フレームワーク自身がグローバル化を最小限に抑えている

- `[SHOULD]` 遅延ロードモジュールでは、ロード済みモジュールの重複検出ロジックを持ち、既存インスタンスを返す
  - 根拠: `LazyModuleLoader.load` が `moduleInstances.length === 0` で既存モジュールを検出し、コンテナから取得する（`lazy-module-loader.ts:36-43`）

- `[AVOID]` 型推論専用の値を実行時にアクセス可能な状態で公開する — Proxy 等で実行時アクセスを明示的にブロックする
  - 根拠: `OPTIONS_TYPE`/`ASYNC_OPTIONS_TYPE` が Proxy で保護され、アクセス時に説明的なエラーメッセージを投げる（`configurable-module.builder.ts:357-371`）

## 適用チェックリスト

- [ ] 設定可能なモジュールを提供する場合、同期版と非同期版（`Async` サフィックス）の設定メソッドをペアで実装しているか
- [ ] モジュールのメタ設定（isGlobal 等）とビジネス設定を分離し、DI トークンにビジネス設定のみが注入されるようになっているか
- [ ] `@Global()` の使用がインフラストラクチャ層（設定・ロギング・コア機能）に限定されているか
- [ ] カスタムプロバイダのタイプガードで `useValue: undefined` を正しく扱えているか
- [ ] 動的モジュールの同一性（同じオプションで複数回呼ばれた場合の挙動）を意識した設計になっているか
- [ ] 遅延ロード対象のモジュールが、グローバルモジュールの恩恵を受けられる設計になっているか
- [ ] Builder パターンを使う場合、型パラメータの段階的特殊化のために immutable な設計にしているか
