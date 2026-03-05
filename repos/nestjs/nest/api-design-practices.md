# API 設計プラクティス

> リポジトリ: nestjs/nest
> 分析日: 2026-03-03

## 概要

NestJS は 9 パッケージからなるモノレポで、デコレータベースの宣言的 API を公開 API の中心に据えている。`@publicApi` JSDoc タグによる公開面の明示管理、function overloads による段階的 API エルゴノミクス、メタデータ駆動のデコレータ合成パターン、そして `VERSION_NEUTRAL` Symbol による柔軟なバージョニング設計など、大規模フレームワークの API 設計において学ぶべき実践が多い。特にデコレータの「短い形式→オプションオブジェクト形式」という段階的開示パターンは、初心者と上級者の両方を満足させる API エルゴノミクスの好例である。

## 背景にある原則

- **段階的開示（Progressive Disclosure）**: API は最も一般的なユースケースを最小のコードで実現でき、高度なユースケースはオプションオブジェクトで段階的に開示すべき。NestJS のほぼ全てのデコレータが「引数なし」「単一文字列」「オプションオブジェクト」の 3 段階オーバーロードで設計されている（`packages/common/decorators/core/controller.decorator.ts:56-115`）。
- **メタデータとロジックの分離**: デコレータは `Reflect.defineMetadata` でメタデータを付与するだけの薄いレイヤーに留め、そのメタデータを消費するロジックは別モジュール（router, injector 等）に配置すべき。これによりデコレータの安定性が保たれ、内部実装を自由に変更できる（`packages/common/decorators/core/injectable.decorator.ts:43-48`）。
- **インターフェースによる契約定義**: 拡張ポイントは具象クラスではなく単一メソッドのインターフェースで定義すべき。NestJS は `PipeTransform.transform()`, `CanActivate.canActivate()`, `NestInterceptor.intercept()` のように、拡張者が実装すべき契約を最小のインターフェースで表現している（`packages/common/interfaces/features/`）。
- **公開面の明示的制御**: barrel ファイル（`index.ts`）と `@publicApi` JSDoc タグの併用により、何が公開 API で何が内部実装かを明確に区別すべき。NestJS は `packages/common/index.ts` で interfaces を名前付きエクスポートに絞り込み、内部型の漏洩を防いでいる。

## 実例と分析

### デコレータの段階的オーバーロード設計

NestJS のデコレータ API は、TypeScript の function overloads を活用して段階的に複雑さを開示する。`@Controller()` を例にとると:

```typescript
// packages/common/decorators/core/controller.decorator.ts:56-115
// 段階 1: 引数なし（最も単純）
export function Controller(): ClassDecorator;
// 段階 2: パスだけ指定（最も一般的）
export function Controller(prefix: string | string[]): ClassDecorator;
// 段階 3: 全オプション（上級者向け）
export function Controller(options: ControllerOptions): ClassDecorator;
```

同様のパターンは `@Body()`, `@Query()`, `@Param()` 等のパラメータデコレータでも一貫して適用されている。`@Body()` は「引数なし」「パイプのみ」「プロパティ名+パイプ」の 3 段階を持つ（`packages/common/decorators/http/route-params.decorator.ts:432-510`）。

### ファクトリ関数によるデコレータの量産

HTTP メソッドデコレータは `createMappingDecorator` ファクトリで統一的に生成される:

```typescript
// packages/common/decorators/http/request-mapping.decorator.ts:32-39
const createMappingDecorator = (method: RequestMethod) => (path?: string | string[]): MethodDecorator => {
  return RequestMapping({
    [PATH_METADATA]: path,
    [METHOD_METADATA]: method,
  });
};

export const Post = createMappingDecorator(RequestMethod.POST);
export const Get = createMappingDecorator(RequestMethod.GET);
export const Delete = createMappingDecorator(RequestMethod.DELETE);
```

この手法により、16 種類の HTTP メソッドデコレータ（`Get`, `Post`, `Delete`, `Put`, `Patch`, `Options`, `Head`, `All`, `Search`, `Propfind` 等）が一貫した振る舞いを保証されている。

### Watermark パターンによるクラス識別

NestJS はデコレータ適用済みクラスを実行時に識別するため、`WATERMARK` 定数をメタデータキーとして使う:

```typescript
// packages/common/constants.ts:44-47
export const INJECTABLE_WATERMARK = "__injectable__";
export const CONTROLLER_WATERMARK = "__controller__";
export const CATCH_WATERMARK = "__catch__";
export const ENTRY_PROVIDER_WATERMARK = "__entryProvider__";
```

```typescript
// packages/common/decorators/core/injectable.decorator.ts:43-48
export function Injectable(options?: InjectableOptions): ClassDecorator {
  return (target: object) => {
    Reflect.defineMetadata(INJECTABLE_WATERMARK, true, target);
    Reflect.defineMetadata(SCOPE_OPTIONS_METADATA, options, target);
  };
}
```

Watermark はブール値のメタデータで、「このクラスが特定のデコレータで装飾されたか」を DI コンテナが実行時に判定するために使われる。

### 公開面の明示管理

`packages/common/index.ts` は interfaces を `export *` ではなく名前付きエクスポートで制御する:

```typescript
// packages/common/index.ts:9-65
export * from "./decorators"; // デコレータは全公開
export * from "./enums"; // enum は全公開
export {
  Abstract,
  ArgumentMetadata,
  ArgumentsHost,
  // ... 40 以上の明示的な名前付きエクスポート
  WsMessageHandler,
} from "./interfaces";
```

decorators や enums は `export *` で全公開する一方、interfaces は個別にピックしている。これにより内部実装用の型が外部に漏れることを防ぎ、公開 API 面を厳密に管理している。

### バージョニング API の設計

NestJS のバージョニングは 4 つの戦略（URI, Header, Media Type, Custom）を判別共用体型で表現する:

```typescript
// packages/common/interfaces/version-options.interface.ts:104-110
export type VersioningOptions =
  & VersioningCommonOptions
  & (
    | HeaderVersioningOptions
    | UriVersioningOptions
    | MediaTypeVersioningOptions
    | CustomVersioningOptions
  );
```

各戦略は `type` プロパティで判別され、戦略固有のオプション（`header`, `prefix`, `key`, `extractor`）が型安全に要求される。`VERSION_NEUTRAL` は Symbol として定義され、バージョン指定なしのルートを明示的に表現する:

```typescript
// packages/common/interfaces/version-options.interface.ts:8
export const VERSION_NEUTRAL = Symbol("VERSION_NEUTRAL");
```

バージョンはコントローラレベル（`@Controller({ version: '1' })`）とメソッドレベル（`@Version('2')`）の両方で指定でき、メソッドレベルが優先される（`packages/core/router/route-path-factory.ts:83`）。

### ConfigurableModuleBuilder による動的モジュール API の標準化

動的モジュールの `forRoot` / `forRootAsync` パターンのボイラープレートを削減するビルダー:

```typescript
// packages/common/module-utils/configurable-module.builder.ts:53-86
export class ConfigurableModuleBuilder<ModuleOptions, ...> {
  setExtras<ExtraModuleDefinitionOptions>(extras, transformDefinition) { ... }
  setClassMethodName<StaticMethodKey>(key) { ... }
  setFactoryMethodName<FactoryClassMethodKey>(key) { ... }
  build(): ConfigurableModuleHost<...> { ... }
}
```

ビルダーパターンを採用し、各 `set*` メソッドが新しいビルダーインスタンスを返すイミュータブル設計。`OPTIONS_TYPE` と `ASYNC_OPTIONS_TYPE` は実行時にアクセスすると例外を投げる型専用プロキシで、「型レベルでのみ使用する値」を安全に表現している（`packages/common/module-utils/configurable-module.builder.ts:357-371`）。

## パターンカタログ

- **Decorator パターン** (分類: 構造)
  - 解決する問題: クラスやメソッドに宣言的にメタデータを付与し、横断的関心事を分離する
  - 適用条件: TypeScript + `reflect-metadata` が利用可能な環境で、設定をコードに近接して宣言したい場合
  - コード例: `packages/common/decorators/core/controller.decorator.ts:151-178`
  - 注意点: デコレータ内にロジックを入れるとテスト困難になる。メタデータ付与のみに留めること

- **Abstract Factory パターン** (分類: 生成)
  - 解決する問題: 同一インターフェースのバリエーションを統一的に生成する
  - 適用条件: 同じ構造を持つが引数だけ異なるデコレータが複数必要な場合
  - コード例: `packages/common/decorators/http/request-mapping.decorator.ts:32-39`（`createMappingDecorator`）
  - 注意点: ファクトリの戻り値の型シグネチャを正確に保つこと

- **Builder パターン** (分類: 生成)
  - 解決する問題: 多数のオプションを段階的に構成し、最終的なオブジェクトを生成する
  - 適用条件: 構成のバリエーションが多く、デフォルト値と上書きの組み合わせが複雑な場合
  - コード例: `packages/common/module-utils/configurable-module.builder.ts:53-191`（`ConfigurableModuleBuilder`）、`packages/testing/testing-module.builder.ts:37-203`（`TestingModuleBuilder`）
  - 注意点: 各メソッドで新インスタンスを返すイミュータブル方式（`ConfigurableModuleBuilder`）と、`this` を返すフルーエント方式（`TestingModuleBuilder`）の使い分けに注意

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: バージョニングの抽出ロジックを差し替え可能にする
  - 適用条件: 同一の処理フローで、一部のアルゴリズムだけを差し替えたい場合
  - コード例: `packages/common/interfaces/version-options.interface.ts:76-88`（`CustomVersioningOptions.extractor`）
  - 注意点: `type` プロパティによる判別共用体で型安全にバリデーションできる

## Good Patterns

- **段階的開示オーバーロード**: 最も一般的なケース（引数なし or 文字列のみ）を最初のオーバーロードに配置し、上級ケース（オプションオブジェクト）を後段に配置する。実装は最後のオーバーロードで `isString()` 等の型ガードを使い統一的に処理する。

```typescript
// packages/common/decorators/core/controller.decorator.ts:56,81,115,151-178
export function Controller(): ClassDecorator;
export function Controller(prefix: string | string[]): ClassDecorator;
export function Controller(options: ControllerOptions): ClassDecorator;
export function Controller(
  prefixOrOptions?: string | string[] | ControllerOptions,
): ClassDecorator {
  const [path, host, scopeOptions, versionOptions] = isUndefined(prefixOrOptions)
    ? [defaultPath, undefined, undefined, undefined]
    : isString(prefixOrOptions) || Array.isArray(prefixOrOptions)
      ? [prefixOrOptions, undefined, undefined, undefined]
      : [prefixOrOptions.path || defaultPath, prefixOrOptions.host, ...];
  // ...
}
```

- **入力バリデーション付きデコレータ**: `@UseGuards()`, `@UseInterceptors()` 等はデコレータ適用時に引数を `validateEach` で検証し、不正な値が渡された場合に即座にエラーを投げる。実行時まで問題が遅延するのを防ぐ。

```typescript
// packages/common/decorators/core/use-guards.decorator.ts:36-50
const isGuardValid = <T extends Function | Record<string, any>>(guard: T) =>
  guard && (isFunction(guard) || isFunction(guard.canActivate));

if (descriptor) {
  validateEach(target.constructor, guards, isGuardValid, "@UseGuards", "guard");
  extendArrayMetadata(GUARDS_METADATA, guards, descriptor.value);
  return descriptor;
}
```

- **applyDecorators によるデコレータ合成**: 複数のデコレータを 1 つにまとめるユーティリティで、ドメイン固有のカスタムデコレータを簡潔に定義できる。

```typescript
// packages/common/decorators/core/apply-decorators.ts:10-30
export function applyDecorators(
  ...decorators: Array<ClassDecorator | MethodDecorator | PropertyDecorator>
) {
  return <TFunction extends Function, Y>(
    target: TFunction | object,
    propertyKey?: string | symbol,
    descriptor?: TypedPropertyDescriptor<Y>,
  ) => {
    for (const decorator of decorators) {
      if (target instanceof Function && !descriptor) {
        (decorator as ClassDecorator)(target);
        continue;
      }
      (decorator as MethodDecorator | PropertyDecorator)(target, propertyKey!, descriptor!);
    }
  };
}
```

- **Module キーのバリデーション**: `@Module()` デコレータは許可されたキー（`imports`, `exports`, `controllers`, `providers`）のみを受け入れ、タイポや不正なプロパティを即座に検出する。

```typescript
// packages/common/utils/validate-module-keys.util.ts:8-23
const metadataKeys = [IMPORTS, EXPORTS, CONTROLLERS, PROVIDERS];

export function validateModuleKeys(keys: string[]) {
  const validateKey = (key: string) => {
    if (metadataKeys.includes(key)) return;
    throw new Error(INVALID_MODULE_CONFIG_MESSAGE`${key}`);
  };
  keys.forEach(validateKey);
}
```

## Anti-Patterns / 注意点

- **デコレータ内にビジネスロジックを書く**: デコレータはメタデータ付与のみを担い、ロジックはメタデータ消費側（router, injector）に配置すべき。デコレータにロジックを入れると、単体テストが困難になり、デコレータの適用順序に依存するバグが生まれる。

```typescript
// Bad: デコレータ内でバリデーションロジックを実行
function Auth(role: string): MethodDecorator {
  return (target, key, descriptor) => {
    const original = descriptor.value;
    descriptor.value = function(...args) {
      if (!checkRole(args[0], role)) throw new Error("Forbidden");
      return original.apply(this, args);
    };
  };
}

// Better: メタデータを付与し、Guard でロジックを実行（NestJS のアプローチ）
const Roles = (...roles: string[]) => SetMetadata("roles", roles);
// Guard 側で Reflector を使ってメタデータを読み取る
```

- **公開 API を barrel の `export *` だけで管理する**: interfaces ディレクトリを `export *` で丸ごと公開すると、内部実装用の型が意図せず公開 API に含まれ、破壊的変更のリスクが増大する。

```typescript
// Bad: 全てを無条件にエクスポート
export * from "./interfaces";

// Better: 公開する型を明示的にピック（NestJS の packages/common/index.ts のアプローチ）
export {
  ArgumentMetadata,
  CanActivate,
  PipeTransform,
  // ... 公開したい型のみを列挙
} from "./interfaces";
```

## 導出ルール

- `[MUST]` デコレータ API は「引数なし / 単一プリミティブ / オプションオブジェクト」の段階的オーバーロードで設計する
  - 根拠: NestJS の全デコレータ（Controller, Body, Query, Param 等）がこのパターンに統一され、一般的ケースの簡潔さと上級ケースの柔軟性を両立している（`controller.decorator.ts:56-115`, `route-params.decorator.ts:346-416`）
- `[MUST]` パッケージの公開 API 面は barrel ファイルで明示管理し、内部型が漏洩しないよう名前付きエクスポートでフィルタする
  - 根拠: NestJS は `packages/common/index.ts` で interfaces を個別にピックし、内部実装用の型（constants, 内部ユーティリティ型等）が公開面に含まれないよう制御している
- `[SHOULD]` 同一パターンのバリエーションが 3 つ以上ある場合、ファクトリ関数で統一的に生成する
  - 根拠: `createMappingDecorator` で 16 種の HTTP メソッドデコレータが一貫した振る舞いを保証されており、新規メソッド追加時も 1 行で済む（`request-mapping.decorator.ts:32-39`）
- `[SHOULD]` デコレータはメタデータ付与のみに留め、ロジックはメタデータ消費側に配置する
  - 根拠: NestJS の全デコレータが `Reflect.defineMetadata` のみを行い、Guard/Interceptor/Pipe がメタデータを読み取ってロジックを実行するアーキテクチャで安定性を実現している
- `[SHOULD]` 複数の戦略を受け入れる設定型は判別共用体（discriminated union）で定義し、`type` フィールドで分岐させる
  - 根拠: `VersioningOptions` が `type` フィールドで URI/Header/MediaType/Custom を判別し、各戦略固有のオプションを型安全に要求している（`version-options.interface.ts:104-110`）
- `[SHOULD]` デコレータに渡される引数はデコレータ適用時にバリデーションし、不正な値を早期に検出する
  - 根拠: `@UseGuards()`, `@UseInterceptors()` が `validateEach` で即座に検証し、実行時エラーの遅延を防いでいる（`use-guards.decorator.ts:36-50`）
- `[AVOID]` ユーザー拡張ポイントのインターフェースに複数のメソッドを要求する（単一メソッドインターフェースを優先する）
  - 根拠: `PipeTransform`（`transform`）、`CanActivate`（`canActivate`）、`NestInterceptor`（`intercept`）は全て単一メソッドで、実装コストが最小限に保たれている

## 適用チェックリスト

- [ ] 公開デコレータ/関数に「引数なし→プリミティブ→オプションオブジェクト」の段階的オーバーロードを適用しているか
- [ ] パッケージの `index.ts` で公開する型を明示的に管理し、`export *` による内部型漏洩を防いでいるか
- [ ] 同一パターンのデコレータやハンドラが 3 つ以上ある場合、ファクトリ関数でコードを統一しているか
- [ ] デコレータがメタデータ付与のみに留まり、ビジネスロジックが混入していないか
- [ ] 複数の戦略を受け入れる設定型に判別共用体を使っているか
- [ ] ユーザーが拡張するインターフェースが単一メソッド原則に従っているか
- [ ] `@publicApi` 等のタグでどの API が安定版でどれが内部実装かを明示しているか
- [ ] 設定オブジェクトのキーをバリデーションし、タイポや不正プロパティを早期検出しているか
