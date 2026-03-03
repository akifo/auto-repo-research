# type-system-patterns

> リポジトリ: nestjs/nest
> 分析日: 2026-03-03

## 概要

NestJS の型システムを分析し、ジェネリックモジュール型、メタデータリフレクション型、プロバイダトークン設計、条件型による API 型安全性のパターンを抽出した。NestJS は TypeScript の型システムを DI コンテナ、デコレータメタデータ、プラットフォーム抽象化の3層で活用しており、「ランタイムの柔軟性を保ちつつコンパイル時に誤用を検出する」という設計哲学が一貫している。特にユニオン型による DI トークン設計、`inject?: never` による排他的プロパティ制約、`as const` + indexed access type による定数からの型導出は、大規模フレームワークにおける型設計の教科書的な実例である。

## 背景にある原則

- **最小のインターフェース契約で最大の拡張性を実現する**: `Type<T>` は `new (...args: any[]): T` というコンストラクタシグネチャだけを要求し、あらゆるクラスを DI トークンとして使えるようにしている。抽象度の高い型制約は実装の自由度を最大化する。（`packages/common/interfaces/type.interface.ts:1`）

- **ランタイム値と型情報を同一ソースから導出する**: `ENHANCER_KEY_TO_SUBTYPE_MAP` を `as const` で定義し、そこから `EnhancerSubtype` 型を indexed access type で導出することで、定数と型が乖離する問題を構造的に排除している。（`packages/common/constants.ts:26-34`）

- **型レベルで不正な組み合わせを排除する**: Provider 型で `inject?: never` を使い、`ClassProvider` や `ValueProvider` に `inject` を渡すとコンパイルエラーにすることで、ランタイムの不正な引数を事前に検出する。型による「不正な状態を表現不能にする」原則の実践である。（`packages/common/interfaces/modules/provider.interface.ts:54,93`）

- **型パラメータの伝播でエンドツーエンドの型安全性を確保する**: `ConfigurableModuleBuilder` は4つのジェネリック型パラメータを Builder Pattern のメソッドチェーンで段階的に確定させ、最終的な `build()` の戻り値まで型が一貫して伝播する。中間状態で型が失われない設計にすることで、フレームワーク利用者がどの段階でも正しい補完を得られる。（`packages/common/module-utils/configurable-module.builder.ts:53-59`）

## 実例と分析

### DI トークンのユニオン型設計

NestJS の DI システムの根幹を成すのが `InjectionToken` 型である。

```typescript
// packages/common/interfaces/modules/injection-token.interface.ts:7-12
export type InjectionToken<T = any> =
  | string
  | symbol
  | Type<T>
  | Abstract<T>
  | Function;
```

このユニオン型は5種類のトークンを統一的に扱う。`Type<T>` はコンストラクタを持つ具象クラス、`Abstract<T>` はプロトタイプのみを公開する抽象クラスを表現する。この2つのインターフェースは最小限のシグネチャで設計されている。

```typescript
// packages/common/interfaces/type.interface.ts:1-3
export interface Type<T = any> extends Function {
  new (...args: any[]): T;
}

// packages/common/interfaces/abstract.interface.ts:1-3
export interface Abstract<T> extends Function {
  prototype: T;
}
```

`Type<T>` がコンストラクタの存在を要求するのに対し、`Abstract<T>` はプロトタイプ形状のみを要求する。これにより抽象クラスをトークンとして使いつつ、インスタンス化は別のクラスに委譲するパターンを型安全に表現できる。

### `inject?: never` による排他的プロパティ制約

Provider のバリアント型（`ClassProvider`, `ValueProvider`, `FactoryProvider`）は判別ユニオンとして設計されているが、TypeScript には標準的な「排他的プロパティ」構文がない。NestJS は `inject?: never` を使ってこの制約を型レベルで表現する。

```typescript
// packages/common/interfaces/modules/provider.interface.ts:36-62
export interface ClassProvider<T = any> {
  provide: InjectionToken;
  useClass: Type<T>;
  scope?: Scope;
  inject?: never;  // FactoryProvider 専用のプロパティを明示的に禁止
  durable?: boolean;
}
```

`inject?: never` は「このプロパティに値を渡すとコンパイルエラーになる」ことを意味する。`ClassProvider` に `inject` を渡す誤用をコンパイル時に検出できる。`ValueProvider` にも同じパターンが適用されている（93行目）。

### `as const` + indexed access type による型導出

定数オブジェクトから型を導出するパターンが `constants.ts` に見られる。

```typescript
// packages/common/constants.ts:26-34
export const ENHANCER_KEY_TO_SUBTYPE_MAP = {
  [GUARDS_METADATA]: 'guard',
  [INTERCEPTORS_METADATA]: 'interceptor',
  [PIPES_METADATA]: 'pipe',
  [EXCEPTION_FILTERS_METADATA]: 'filter',
} as const;

export type EnhancerSubtype =
  (typeof ENHANCER_KEY_TO_SUBTYPE_MAP)[keyof typeof ENHANCER_KEY_TO_SUBTYPE_MAP];
```

`as const` でリテラル型を保持し、indexed access type で値型のユニオン（`'guard' | 'interceptor' | 'pipe' | 'filter'`）を自動導出する。新しいエンハンサーを追加する際、定数にエントリを追加するだけで型が自動的に拡張される。

### ジェネリック Builder Pattern による段階的型確定

`ConfigurableModuleBuilder` は4つの型パラメータを持ち、Builder メソッドごとに1つずつ確定させていく。

```typescript
// packages/common/module-utils/configurable-module.builder.ts:53-59
export class ConfigurableModuleBuilder<
  ModuleOptions,
  StaticMethodKey extends string = typeof DEFAULT_METHOD_KEY,
  FactoryClassMethodKey extends string = typeof DEFAULT_FACTORY_CLASS_METHOD_KEY,
  ExtraModuleDefinitionOptions = {},
> {
```

各メソッド（`setClassMethodName`, `setFactoryMethodName`, `setExtras`）は新しい `ConfigurableModuleBuilder` インスタンスを返し、変更された型パラメータだけを更新する。

```typescript
// packages/common/module-utils/configurable-module.builder.ts:131-140
setClassMethodName<StaticMethodKey extends string>(key: StaticMethodKey) {
  const builder = new ConfigurableModuleBuilder<
    ModuleOptions,
    StaticMethodKey,         // この型パラメータだけ更新
    FactoryClassMethodKey,
    ExtraModuleDefinitionOptions
  >(this.options, this as any);
  builder.staticMethodKey = key;
  return builder;
}
```

最終的に `build()` が返す `ConfigurableModuleHost` は、すべての型パラメータが確定した状態で正確な型を提供する。

### テンプレートリテラル型による動的メソッド名

`ConfigurableModuleCls` はテンプレートリテラル型を使って、動的に決定されるメソッド名を型レベルで表現する。

```typescript
// packages/common/module-utils/interfaces/configurable-module-cls.interface.ts:16-39
export type ConfigurableModuleCls<
  ModuleOptions,
  MethodKey extends string = typeof DEFAULT_METHOD_KEY,
  FactoryClassMethodKey extends string = typeof DEFAULT_FACTORY_CLASS_METHOD_KEY,
  ExtraModuleDefinitionOptions = {},
> = {
  new (): any;
} & Record<
  `${MethodKey}`,
  (options: ModuleOptions & Partial<ExtraModuleDefinitionOptions>) => DynamicModule
> & Record<
  `${MethodKey}Async`,
  (options: ConfigurableModuleAsyncOptions<ModuleOptions, FactoryClassMethodKey> &
    Partial<ExtraModuleDefinitionOptions>) => DynamicModule
>;
```

`MethodKey` が `"register"` なら `register()` と `registerAsync()` メソッドが型として現れる。`"forRoot"` を渡せば `forRoot()` と `forRootAsync()` になる。

### Proxy による型のみのトークン（値として使用不可）

`ConfigurableModuleBuilder.build()` が返す `OPTIONS_TYPE` と `ASYNC_OPTIONS_TYPE` は、`typeof` でのみ使うことを想定した「型専用トークン」である。

```typescript
// packages/common/module-utils/configurable-module.builder.ts:357-371
private createTypeProxy(
  typeName: 'OPTIONS_TYPE' | 'ASYNC_OPTIONS_TYPE' | 'OptionsFactoryInterface',
) {
  const proxy = new Proxy(
    {},
    {
      get: () => {
        throw new Error(
          `"${typeName}" is not supposed to be used as a value.`,
        );
      },
    },
  );
  return proxy as any;
}
```

ランタイムでアクセスすると例外がスローされる。`typeof OPTIONS_TYPE` として型推論にのみ使用する設計で、「型としてのみ存在し値としては使えない」概念を Proxy で実現している。

### プラットフォーム固有の型絞り込み

`NestFactory.create<T>()` の型パラメータ `T extends INestApplication` により、プラットフォーム固有のインターフェースに絞り込める。

```typescript
// packages/core/nest-factory.ts:59-62
public async create<T extends INestApplication = INestApplication>(
  module: IEntryNestModule,
  options?: NestApplicationOptions,
): Promise<T>;
```

利用側は `NestFactory.create<NestExpressApplication>(AppModule)` と書くことで、Express 固有のメソッド（`useStaticAssets`, `setViewEngine` 等）にアクセスできる。

`NestExpressApplication` と `NestFastifyApplication` はそれぞれ `INestApplication<TServer>` を拡張し、`TServer` でサーバー型を具体化している。

```typescript
// packages/platform-express/interfaces/nest-express-application.interface.ts:20-22
export interface NestExpressApplication<
  TServer extends CoreHttpServer | CoreHttpsServer = CoreHttpServer,
> extends INestApplication<TServer> {
```

```typescript
// packages/platform-fastify/interfaces/nest-fastify-application.interface.ts:27-29
export interface NestFastifyApplication<
  TServer extends RawServerBase = RawServerDefault,
> extends INestApplication<TServer> {
```

### デコレータメタデータの二層管理

NestJS はデコレータメタデータを2層で管理する。第1層は TypeScript の `emitDecoratorMetadata` による自動メタデータ（`design:paramtypes`）、第2層は独自のメタデータキー（`self:paramtypes` 等）である。

```typescript
// packages/common/constants.ts:11-14
export const PARAMTYPES_METADATA = 'design:paramtypes';
export const SELF_DECLARED_DEPS_METADATA = 'self:paramtypes';
export const OPTIONAL_DEPS_METADATA = 'optional:paramtypes';
export const PROPERTY_DEPS_METADATA = 'self:properties_metadata';
```

`@Inject()` デコレータは、明示的なトークンが渡されない場合に `design:paramtypes` からメタタイプを推論し、`self:paramtypes` に手動オーバーライドを格納する。

```typescript
// packages/common/decorators/core/inject.decorator.ts:43-56
return (target: object, key: string | symbol | undefined, index?: number) => {
  let type = token || Reflect.getMetadata('design:type', target, key!);
  if (!type && !injectCallHasArguments) {
    type = Reflect.getMetadata(PARAMTYPES_METADATA, target, key!)?.[index!];
  }

  if (!isUndefined(index)) {
    let dependencies =
      Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, target) || [];
    dependencies = [...dependencies, { index, param: type }];
    Reflect.defineMetadata(SELF_DECLARED_DEPS_METADATA, dependencies, target);
    return;
  }
```

### Reflector の型安全なメタデータ取得

`Reflector.createDecorator` は `ReflectableDecorator<TParam, TTransformed>` を返し、`Reflector.get()` で取得する際に条件型 `infer R` で戻り値型を自動推論する。

```typescript
// packages/core/services/reflector.service.ts:84-87
public get<T extends ReflectableDecorator<any>>(
  decorator: T,
  target: Type<any> | Function,
): T extends ReflectableDecorator<any, infer R> ? R : unknown;
```

これにより、メタデータのセット時と取得時で型が一貫する。文字列キーによる旧来の API も残しているが、新しい `createDecorator` API は型安全なパスを提供する。

### ContextType のオープン拡張

`ArgumentsHost.getType()` は `ContextType = 'http' | 'ws' | 'rpc'` をデフォルトとしつつ、ジェネリック型 `TContext extends string` でカスタムトランスポートへの拡張を許容する。

```typescript
// packages/common/interfaces/features/arguments-host.interface.ts:92
getType<TContext extends string = ContextType>(): TContext;
```

## パターンカタログ

- **Builder Pattern** (生成)
  - 解決する問題: 多数のジェネリック型パラメータを持つオブジェクトの段階的構築
  - 適用条件: 構築過程の各ステップで異なる型パラメータが確定する場合
  - コード例: `packages/common/module-utils/configurable-module.builder.ts:53-191`
  - 注意点: 各メソッドが新しいインスタンスを返す immutable builder として実装。型パラメータの伝播のために `parentBuilder` を介して状態をコピーしている。

- **Discriminated Union** (構造)
  - 解決する問題: Provider の4つのバリアント（Class, Value, Factory, Existing）を型安全に区別する
  - 適用条件: 同じ抽象を異なる構成で実現するバリアントが存在する場合
  - コード例: `packages/common/interfaces/modules/provider.interface.ts:10-15`
  - 注意点: TypeScript の標準的な判別ユニオン（リテラル型のタグ）ではなく、存在するプロパティの違い（`useClass` vs `useValue` vs `useFactory`）で判別している。型ガード関数 `isClassProvider`, `isValueProvider`, `isFactoryProvider`（`packages/core/injector/helpers/provider-classifier.ts`）で実行時にも区別する。

- **Proxy Pattern** (構造)
  - 解決する問題: 型専用の値（`typeof` でのみ使う）が実行時に誤ってアクセスされることの防止
  - 適用条件: 型推論のためだけに存在するオブジェクトがある場合
  - コード例: `packages/common/module-utils/configurable-module.builder.ts:357-371`
  - 注意点: `as any` でキャストしており、Proxy の型安全性は外側の `ConfigurableModuleHost` インターフェースに委ねている

## Good Patterns

- **`inject?: never` による排他的プロパティ制約**: TypeScript には排他的プロパティの標準構文がないが、`never` 型をオプショナルプロパティに指定することで、特定のバリアントでのみ許可されるプロパティを他のバリアントで禁止できる。ユニオン型のバリアントが構造的に重複しうる場合に有効。

```typescript
// packages/common/interfaces/modules/provider.interface.ts:36-62
export interface ClassProvider<T = any> {
  provide: InjectionToken;
  useClass: Type<T>;
  scope?: Scope;
  inject?: never;  // FactoryProvider 専用プロパティの誤用を防止
}
```

- **`as const` + indexed access type で Single Source of Truth**: ランタイム定数とその型を同一ソースから導出することで、定数の追加・変更時に型が自動追従する。enum を使わずにリテラルユニオン型を得る手法。

```typescript
// packages/common/constants.ts:26-34
export const ENHANCER_KEY_TO_SUBTYPE_MAP = {
  [GUARDS_METADATA]: 'guard',
  [INTERCEPTORS_METADATA]: 'interceptor',
  [PIPES_METADATA]: 'pipe',
  [EXCEPTION_FILTERS_METADATA]: 'filter',
} as const;

export type EnhancerSubtype =
  (typeof ENHANCER_KEY_TO_SUBTYPE_MAP)[keyof typeof ENHANCER_KEY_TO_SUBTYPE_MAP];
// => 'guard' | 'interceptor' | 'pipe' | 'filter'
```

- **条件型 `infer` によるデコレータ↔リフレクター間の型連携**: `Reflector.get()` の戻り値型を、渡されたデコレータの型パラメータから `infer R` で自動推論する。メタデータのセットと取得で型が乖離するバグを構造的に排除する。

```typescript
// packages/core/services/reflector.service.ts:84-87
public get<T extends ReflectableDecorator<any>>(
  decorator: T,
  target: Type<any> | Function,
): T extends ReflectableDecorator<any, infer R> ? R : unknown;
```

## Anti-Patterns / 注意点

- **ジェネリック型パラメータのデフォルト `any` の多用**: `InjectionToken<T = any>` や `Type<T = any>` のように `any` デフォルトが多いため、型パラメータを明示しないと型安全性が失われる。フレームワーク内部では許容されるが、アプリケーションコードでは具体型を渡すべきである。

```typescript
// Bad: 型パラメータを省略して any に落ちる
const token: InjectionToken = someValue;

// Better: 具体型を指定して型安全性を確保
const token: InjectionToken<UserService> = UserService;
```

- **`as any` / `as unknown as` によるキャスト**: `ConfigurableModuleBuilder` 内部で `this as any`（114行目）や `return InternalModuleClass as unknown as ConfigurableModuleCls<...>`（350行目）のようなキャストが使われている。ジェネリック Builder の内部実装では避けがたい場合があるが、キャストの範囲をフレームワーク内部に限定し、公開 API の型シグネチャでは正確な型を提供することが重要。

```typescript
// Bad: 公開 API でキャストを利用者に要求する
function getService(): any { ... }

// Better: 内部でキャストしつつ、公開型は正確にする
build(): ConfigurableModuleHost<ModuleOptions, StaticMethodKey, ...> {
  // 内部では as unknown as で変換
  return InternalModuleClass as unknown as ConfigurableModuleCls<...>;
}
```

- **プロパティ存在チェックによる型判別**: `isClassProvider` は `(provider as ClassProvider).useClass` の存在チェックで判別する。`useClass` と `useValue` の両方を持つオブジェクトが渡された場合、意図しないバリアントとして判定される可能性がある。判別ユニオンのタグフィールド方式と比べて堅牢性が劣る。

```typescript
// packages/core/injector/helpers/provider-classifier.ts:9-13
export function isClassProvider<T = any>(
  provider: Provider,
): provider is ClassProvider<T> {
  return Boolean((provider as ClassProvider<T>)?.useClass);
}
```

## 導出ルール

- `[MUST]` 複数バリアントのユニオン型で特定バリアントにのみ許可されるプロパティがある場合、他のバリアントでは `prop?: never` を指定して型レベルで排他性を保証する
  - 根拠: NestJS の Provider 型で `inject?: never` により ClassProvider/ValueProvider への inject 誤用をコンパイル時に検出している（`provider.interface.ts:54,93`）

- `[MUST]` ランタイム定数とその型を同時に管理する場合、`as const` で定数を定義し indexed access type (`typeof MAP[keyof typeof MAP]`) で型を導出する（enum ではなく）
  - 根拠: `ENHANCER_KEY_TO_SUBTYPE_MAP` + `EnhancerSubtype` の設計で、定数追加時に型が自動追従し Single Source of Truth を維持している（`constants.ts:26-34`）

- `[SHOULD]` ジェネリック Builder Pattern では各メソッドが更新された型パラメータを持つ新しいインスタンスを返し、中間状態でも正確な型補完を提供する
  - 根拠: `ConfigurableModuleBuilder` の `setClassMethodName`, `setExtras` 等がそれぞれ新しい型パラメータを持つ builder を返し、`build()` まで型が一貫して伝播する（`configurable-module.builder.ts:109-140`）

- `[SHOULD]` メタデータのセットと取得が対になる API では、条件型の `infer` を使って戻り値型をデコレータの型パラメータから自動導出し、型の一貫性を保証する
  - 根拠: `Reflector.get()` が `ReflectableDecorator<any, infer R>` で R を推論し、`createDecorator<TParam>` で渡した型と取得時の型が一致することを保証している（`reflector.service.ts:84-87`）

- `[SHOULD]` プラットフォーム抽象化層では、共通インターフェースをジェネリックパラメータ付きで定義し、プラットフォーム固有のインターフェースが具体型で拡張する階層構造にする
  - 根拠: `INestApplication<TServer>` → `NestExpressApplication<CoreHttpServer>` / `NestFastifyApplication<RawServerDefault>` の階層で、`NestFactory.create<T>()` の型パラメータによりプラットフォーム固有の API に型安全にアクセスできる（`nest-factory.ts:59-62`）

- `[AVOID]` ジェネリック型パラメータのデフォルトを `any` にすることで型安全性を暗黙に放棄させる設計。可能な場合は `unknown` をデフォルトにするか、型パラメータの明示を強制する
  - 根拠: `Type<T = any>`, `InjectionToken<T = any>` 等は後方互換性のために `any` デフォルトだが、新規設計では型パラメータの省略時に `unknown` にすることでより安全な API になる

## 適用チェックリスト

- [ ] ユニオン型のバリアント間で排他的なプロパティがある場合、`prop?: never` を使って型レベルで禁止しているか
- [ ] ランタイム定数と型定義が別々に管理されていないか（`as const` + indexed access type で統一できないか）
- [ ] ジェネリック Builder のメソッドチェーンで、各ステップの戻り値型が更新後の型パラメータを反映しているか
- [ ] メタデータのセット/取得 API で型の一貫性が保証されているか（条件型 `infer` の活用）
- [ ] プラットフォーム抽象化にジェネリック型パラメータを使い、具象プラットフォームで型安全に絞り込めるか
- [ ] 公開 API のジェネリック型パラメータのデフォルトが `any` でなく `unknown` になっているか（やむを得ない場合を除く）
- [ ] 型ガード関数が判別ユニオンのプロパティ存在チェックに依存する場合、複数のバリアントキーを同時に持つオブジェクトへの対処があるか
