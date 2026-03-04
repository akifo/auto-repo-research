# Pattern: Metadata-Driven Architecture

> 出典: [repos/nestjs/nest](../repos/nestjs/nest/)
> カテゴリ: pattern

## 概要

デコレータでメタデータを格納し、ランタイムがそれを解釈する「Write / Read 分離」アーキテクチャパターン。デコレータは `Reflect.defineMetadata` で構成情報を書き込むだけの薄い関数に留め、フレームワークのスキャナやコンテキストビルダーがメタデータを読み取って動作を組み立てる。メタデータキーの一元管理と Global / Class / Method の 3 層マージ戦略により、宣言的な構成と実行時の振る舞いを完全に分離し、拡張性・テスタビリティ・合成可能性を同時に実現する。

## 背景・文脈

NestJS は Node.js のサーバーサイドフレームワークで、Angular にインスパイアされたデコレータ駆動のアーキテクチャを採用している。DI コンテナ、ルーティング、ガード、インターセプタ、パイプ、例外フィルタといったフレームワーク機能が全て `reflect-metadata` を介したメタデータの読み書きで制御される。

このパターンが効果を発揮するのは、ユーザーコードからフレームワーク構成情報を収集し、それに基づいて動的に振る舞いを組み立てる必要がある場面である。ルーティング定義、認可ルール、バリデーションパイプライン、ライフサイクル管理など、宣言的に表現したい横断的関心事が複数存在するシステムで特に有効に機能する。

## 実装パターン

### 1. Write 側: デコレータはメタデータの格納のみ

デコレータは副作用を持たず、`Reflect.defineMetadata` の呼び出しだけで構成される。実行時のロジックは一切含まない。

```typescript
// packages/common/decorators/core/injectable.decorator.ts:43-48
export function Injectable(options?: InjectableOptions): ClassDecorator {
  return (target: object) => {
    Reflect.defineMetadata(INJECTABLE_WATERMARK, true, target);
    Reflect.defineMetadata(SCOPE_OPTIONS_METADATA, options, target);
  };
}
```

`@Controller()` も同じパターンで、複数のメタデータを一度に書き込む構成デコレータとして機能する。

```typescript
// packages/common/decorators/core/controller.decorator.ts:171-178
return (target: object) => {
  Reflect.defineMetadata(CONTROLLER_WATERMARK, true, target);
  Reflect.defineMetadata(PATH_METADATA, path, target);
  Reflect.defineMetadata(HOST_METADATA, host, target);
  Reflect.defineMetadata(SCOPE_OPTIONS_METADATA, scopeOptions, target);
  Reflect.defineMetadata(VERSION_METADATA, versionOptions, target);
};
```

### 2. Read 側: ランタイムがメタデータを解釈

スキャナがクラスに付与された Watermark メタデータを読み取り、クラスの役割を判定する。

```typescript
// packages/core/scanner.ts:726-744
private isInjectable(metatype: Type<any>): boolean {
  return !!Reflect.getMetadata(INJECTABLE_WATERMARK, metatype);
}

private isController(metatype: Type<any>): boolean {
  return !!Reflect.getMetadata(CONTROLLER_WATERMARK, metatype);
}

private isExceptionFilter(metatype: Type<any>): boolean {
  return !!Reflect.getMetadata(CATCH_WATERMARK, metatype);
}
```

### 3. メタデータキーの一元管理

全メタデータキーを単一の `constants.ts` に集約し、命名規約でキーの種類を識別する。デコレータ（Write 側）とスキャナ（Read 側）が同じ定数を参照することで、キー不整合を構造的に排除する。

```typescript
// packages/common/constants.ts:1-47 (抜粋)
// モジュール構成キー
export const MODULE_METADATA = {
  IMPORTS: "imports",
  PROVIDERS: "providers",
  CONTROLLERS: "controllers",
  EXPORTS: "exports",
};

// TS コンパイラ生成メタデータ (design: prefix)
export const PARAMTYPES_METADATA = "design:paramtypes";

// ユーザー宣言メタデータ (self: prefix)
export const SELF_DECLARED_DEPS_METADATA = "self:paramtypes";
export const PROPERTY_DEPS_METADATA = "self:properties_metadata";

// Enhancer メタデータ (__xxx__ パターン)
export const GUARDS_METADATA = "__guards__";
export const INTERCEPTORS_METADATA = "__interceptors__";
export const PIPES_METADATA = "__pipes__";
export const EXCEPTION_FILTERS_METADATA = "__exceptionFilters__";

// Watermark メタデータ (__xxx__ パターン)
export const INJECTABLE_WATERMARK = "__injectable__";
export const CONTROLLER_WATERMARK = "__controller__";
export const CATCH_WATERMARK = "__catch__";
```

### 4. 累積メタデータと 3 層マージ

同一メタデータキーに対して値を蓄積する `extendArrayMetadata` ユーティリティにより、複数のデコレータが非破壊的にメタデータを追加できる。

```typescript
// packages/common/utils/extend-metadata.util.ts:1-9
export function extendArrayMetadata<T extends Array<unknown>>(
  key: string,
  metadata: T,
  target: Function,
) {
  const previousValue = Reflect.getMetadata(key, target) || [];
  const value = [...previousValue, ...metadata];
  Reflect.defineMetadata(key, value, target);
}
```

`ContextCreator` がグローバル、クラス、メソッドの 3 階層からメタデータを収集し、配列として結合する。

```typescript
// packages/core/helpers/context-creator.ts:16-41
public createContext<T extends unknown[] = any, R extends unknown[] = any>(
  instance: Controller,
  callback: (...args: any[]) => void,
  metadataKey: string,
  contextId = STATIC_CONTEXT,
  inquirerId?: string,
): R {
  const globalMetadata =
    this.getGlobalMetadata &&
    this.getGlobalMetadata<T>(contextId, inquirerId);
  const classMetadata = this.reflectClassMetadata<T>(instance, metadataKey);
  const methodMetadata = this.reflectMethodMetadata<T>(callback, metadataKey);
  return [
    ...this.createConcreteContext<T, R>(
      globalMetadata || ([] as unknown[] as T), contextId, inquirerId,
    ),
    ...this.createConcreteContext<T, R>(classMetadata, contextId, inquirerId),
    ...this.createConcreteContext<T, R>(methodMetadata, contextId, inquirerId),
  ] as R;
}
```

### 5. Reflector による 3 つの読み取り戦略

`Reflector` サービスは複数ターゲットからのメタデータ読み取りに 3 つの戦略を提供する。

```typescript
// packages/core/services/reflector.service.ts:194-224
// getAllAndMerge: 配列は concat、オブジェクトは spread で結合
public getAllAndMerge<TResult extends any[] | object = any[], TKey = any>(
  metadataKeyOrDecorator: TKey,
  targets: (Type<any> | Function)[],
): TResult {
  const metadataCollection = this.getAll<any[], TKey>(
    metadataKeyOrDecorator, targets,
  ).filter(item => item !== undefined);
  // ...
  return metadataCollection.reduce((a, b) => {
    if (Array.isArray(a)) { return a.concat(b); }
    if (isObject(a) && isObject(b)) { return { ...a, ...b }; }
    return [a, b];
  });
}

// packages/core/services/reflector.service.ts:256-267
// getAllAndOverride: 最初に見つかった値を返す（メソッド優先）
public getAllAndOverride<TResult = any, TKey = any>(
  metadataKeyOrDecorator: TKey,
  targets: (Type<any> | Function)[],
): TResult | undefined {
  for (const target of targets) {
    const result = this.get(metadataKeyOrDecorator, target);
    if (result !== undefined) { return result; }
  }
  return undefined;
}
```

## Good Example

### 型安全なカスタムデコレータの生成

`Reflector.createDecorator` を使うと、メタデータキーが自動生成され、デコレータとリーダーが型安全に紐付く。文字列キーのタイポや型不整合が構造的に排除される。

```typescript
// packages/core/services/reflector.service.ts:57-72
static createDecorator<TParam, TTransformed = TParam>(
  options: CreateDecoratorOptions<TParam, TTransformed> = {},
): ReflectableDecorator<TParam, TTransformed> {
  const metadataKey = options.key ?? uid(21);
  const decoratorFn =
    (metadataValue: TParam) =>
    (target: object | Function, key?: string | symbol, descriptor?: any) => {
      const value = options.transform
        ? options.transform(metadataValue)
        : metadataValue;
      SetMetadata(metadataKey, value ?? {})(target, key!, descriptor);
    };
  decoratorFn.KEY = metadataKey;
  return decoratorFn as ReflectableDecorator<TParam, TTransformed>;
}
```

使用例（型安全な読み書き）:

```typescript
// Write: デコレータ適用
const Roles = Reflector.createDecorator<string[]>();

@Roles(['admin', 'moderator'])
handleRequest() {}

// Read: Reflector で型安全に取得
const roles = this.reflector.get(Roles, context.getHandler());
// roles の型は string[] として推論される
```

### ファクトリ関数によるデコレータの量産

同一構造のデコレータをファクトリから生成し、実装の重複を排除する。NestJS はこのパターンで 15 以上の HTTP メソッドデコレータを単一のファクトリから生成している。

```typescript
// packages/common/decorators/http/request-mapping.decorator.ts:32-39
const createMappingDecorator = (method: RequestMethod) => (path?: string | string[]): MethodDecorator => {
  return RequestMapping({
    [PATH_METADATA]: path,
    [METHOD_METADATA]: method,
  });
};

// 1 行で具象デコレータを量産
export const Post = createMappingDecorator(RequestMethod.POST);
export const Get = createMappingDecorator(RequestMethod.GET);
export const Delete = createMappingDecorator(RequestMethod.DELETE);
export const Put = createMappingDecorator(RequestMethod.PUT);
export const Patch = createMappingDecorator(RequestMethod.PATCH);
// ... 以下 Options, Head, All, Search, Propfind 等 10 種以上
```

### デコレータ適用時のバリデーション

`@UseGuards()` は引数の正当性をデコレータ適用時に検証する。ランタイムまでエラー検出を遅延させない設計。

```typescript
// packages/common/decorators/core/use-guards.decorator.ts:28-53
export function UseGuards(
  ...guards: (CanActivate | Function)[]
): MethodDecorator & ClassDecorator {
  return (target: any, key?: string | symbol, descriptor?: TypedPropertyDescriptor<any>) => {
    const isGuardValid = <T extends Function | Record<string, any>>(guard: T) =>
      guard && (isFunction(guard) || isFunction(guard.canActivate));

    if (descriptor) {
      validateEach(target.constructor, guards, isGuardValid, "@UseGuards", "guard");
      extendArrayMetadata(GUARDS_METADATA, guards, descriptor.value);
      return descriptor;
    }
    validateEach(target, guards, isGuardValid, "@UseGuards", "guard");
    extendArrayMetadata(GUARDS_METADATA, guards, target);
    return target;
  };
}
```

## Bad Example

### メタデータキーをインライン文字列で使用

キーを定数化せずに文字列リテラルで直接使うと、Write 側と Read 側でタイポによる不整合が発生し、静的解析で検出できない。

```typescript
// Bad: 文字列リテラルの散在
// decorator.ts
Reflect.defineMetadata("myCustomKey", value, target);

// scanner.ts (別ファイル)
Reflect.getMetadata("my_custom_key", target); // タイポで undefined が返る

// -----------------------------------------------

// Good: 定数の一元管理 (NestJS のアプローチ)
// constants.ts
export const MY_CUSTOM_KEY = "myCustomKey";

// decorator.ts
import { MY_CUSTOM_KEY } from "./constants";
Reflect.defineMetadata(MY_CUSTOM_KEY, value, target);

// scanner.ts
import { MY_CUSTOM_KEY } from "./constants";
Reflect.getMetadata(MY_CUSTOM_KEY, target); // 同一定数で不整合を排除
```

### 累積すべきメタデータを上書きで書き込む

Guards のように複数のデコレータから蓄積されるべきメタデータを `defineMetadata` で直接書き込むと、先行デコレータの値が消失する。

```typescript
// Bad: 先行する Guard が上書きされる
// GUARDS_METADATA = [AuthGuard]
// GUARDS_METADATA = [RateLimitGuard] ← AuthGuard が消える
// もし UseGuards が以下のように実装されていたら:
// Reflect.defineMetadata(GUARDS_METADATA, [guard], target);

// -----------------------------------------------

// Good: extendArrayMetadata で非破壊的に蓄積 (NestJS の実装)
// packages/common/utils/extend-metadata.util.ts:1-9
export function extendArrayMetadata<T extends Array<unknown>>(
  key: string,
  metadata: T,
  target: Function,
) {
  const previousValue = Reflect.getMetadata(key, target) || [];
  const value = [...previousValue, ...metadata];
  Reflect.defineMetadata(key, value, target);
}
// 結果: GUARDS_METADATA = [AuthGuard, RateLimitGuard]
```

### デコレータ内での副作用（メソッド書き換え）

デコレータ内で `descriptor.value` を別の関数に差し替えると、元のメソッドのメタデータを手動コピーする必要が生じ、コピー漏れによるバグが発生する。

```typescript
// Bad: デコレータ内でメソッドを書き換え、メタデータを手動コピー
// packages/microservices/decorators/message-pattern.decorator.ts:155-178
const originalMethod = descriptor.value;
descriptor.value = function(this: any, observable: any, ...args: any[]) {
  // ... ラッパーロジック
};
// 元メソッドのメタデータを手動で全コピー（漏れのリスクあり）
const metadataKeys = Reflect.getMetadataKeys(originalMethod);
metadataKeys.forEach(metadataKey => {
  const metadataValue = Reflect.getMetadata(metadataKey, originalMethod);
  Reflect.defineMetadata(metadataKey, metadataValue, descriptor.value);
});

// -----------------------------------------------

// Good: デコレータはメタデータ格納のみ。振る舞いの変更はランタイムが担当
// packages/common/decorators/http/request-mapping.decorator.ts:14-30
const RequestMapping = (metadata: RequestMappingMetadata): MethodDecorator => {
  return (target, key, descriptor) => {
    Reflect.defineMetadata(PATH_METADATA, path, descriptor.value);
    Reflect.defineMetadata(METHOD_METADATA, requestMethod, descriptor.value);
    return descriptor; // descriptor.value は変更しない
  };
};
```

## 適用ガイド

### どのような状況で使うべきか

- フレームワークやライブラリを設計しており、ユーザーコードから構成情報を宣言的に収集する必要がある場合
- ルーティング、認可、バリデーション、ロギングなどの横断的関心事を、ビジネスロジックから分離して合成したい場合
- 同一の構成情報を複数の粒度（グローバル、モジュール、クラス、メソッド）で宣言し、階層的にマージする必要がある場合
- プラグインやユーザー定義のカスタムデコレータを安全に受け入れる拡張ポイントを提供したい場合

### 導入時の注意点

- **メタデータキーの衝突管理が最重要**: キーは必ず定数ファイルに集約し、命名規約（`__xxx__` で内部キー、`design:` で TS コンパイラ生成、`self:` でユーザー宣言）を設ける
- **累積型と上書き型のメタデータを明確に区別する**: Guards のようにリスト型のメタデータは `extendArrayMetadata` パターンで蓄積し、Path のようなスカラー型は直接書き込む
- **`reflect-metadata` への依存を認識する**: このパターンは `reflect-metadata` polyfill に依存する。TC39 の Decorator Metadata 提案が Stage 3 に進んでおり、将来的にネイティブ API への移行を検討する余地がある
- **デコレータ内の副作用を禁止する**: デコレータはメタデータの格納のみに徹し、ファイル I/O や API 呼び出しなどの副作用を行わない。テスト容易性と合成可能性を維持するための鉄則

### カスタマイズポイント

- **マージ戦略の選択**: `Reflector` の 3 つの読み取りメソッド（`getAll`, `getAllAndMerge`, `getAllAndOverride`）のように、ユースケースに応じてメタデータのマージ戦略を選べる設計にする
- **ユーザー向けデコレータ作成 API**: `Reflector.createDecorator` のように、型安全なカスタムデコレータを生成するヘルパーを提供することで、ユーザーがフレームワークのメタデータ規約に沿った拡張を安全に行える
- **バリデーションのタイミング**: デコレータ適用時にバリデーションを行う（`validateEach`）ことで、ランタイムエラーを起動前に検出する。CI でのインポートエラーとして早期発見が可能

## 参考

- [repos/nestjs/nest/decorator-driven-architecture.md](../repos/nestjs/nest/decorator-driven-architecture.md) -- デコレータの設計パターン体系と Write/Read 分離の詳細分析
- [repos/nestjs/nest/metaprogramming-techniques.md](../repos/nestjs/nest/metaprogramming-techniques.md) -- reflect-metadata の活用、ファクトリ階層構造、プロトタイプチェーン走査
- [repos/nestjs/nest/design-philosophy.md](../repos/nestjs/nest/design-philosophy.md) -- 宣言的メタデータ設計の背景にある設計思想
