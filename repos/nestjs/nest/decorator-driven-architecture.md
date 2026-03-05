# decorator-driven-architecture

> リポジトリ: nestjs/nest
> 分析日: 2026-03-03

## 概要

NestJS はデコレータをフレームワークの中核パラダイムとして採用し、クラス・メソッド・パラメータの 3 レベルでメタデータを付与する設計を貫いている。`reflect-metadata` を介してデコレータが書き込んだメタデータを、DI コンテナ・ルーティングエンジン・ガード/インターセプタ等のランタイムが統一的に読み取る「Write（デコレータ）/ Read（フレームワーク）分離」が最大の特徴である。この設計により、宣言的な構成と実行時の振る舞いを完全に分離し、コードの可読性・拡張性・テスタビリティを同時に実現している。

## 背景にある原則

- **メタデータを唯一の構成インターフェースとする**: デコレータが `Reflect.defineMetadata` で書き込み、フレームワーク側が `Reflect.getMetadata` で読み取る。構成情報のやり取りがメタデータ API に一本化されているため、デコレータとランタイムの間に暗黙の結合が生まれない。定数キー（`constants.ts`）が両者の契約となる。
  - 根拠: `packages/common/constants.ts` に全メタデータキーが集約されており、デコレータ側（`packages/common/decorators/`）とランタイム側（`packages/core/scanner.ts`, `injector.ts`）が同じ定数を参照する設計。

- **Watermark パターンによるクラス分類**: `@Injectable()`, `@Controller()`, `@Catch()` は boolean の「Watermark」メタデータを付与し、スキャナがクラスの役割を判別する。型システムではなくメタデータでクラスのカテゴリを識別することで、動的な分類と厳密なバリデーション（`InvalidClassModuleException` の発生）を両立する。
  - 根拠: `scanner.ts:726-744` の `isInjectable()`, `isController()`, `isExceptionFilter()` が Watermark を読んでクラスを分類する。

- **デコレータの合成可能性を保証する**: 個々のデコレータは単一の関心に集中し、`applyDecorators()` や `extendArrayMetadata()` を介して合成できるように設計されている。デコレータ同士が互いの存在を知らないため、独立した拡張が可能になる。
  - 根拠: `packages/common/decorators/core/apply-decorators.ts` が任意のデコレータ配列を順次適用する合成関数として実装されている。

- **3 階層メタデータマージ（Global → Class → Method）**: ガード・インターセプタ・パイプ・フィルタの 4 つの enhancer は、グローバル・クラスレベル・メソッドレベルの 3 階層でメタデータを収集し、配列として結合する。これにより、共通の横断的関心事をグローバルに、コントローラ固有のものをクラスに、エンドポイント固有のものをメソッドに宣言できる。
  - 根拠: `packages/core/helpers/context-creator.ts:16-41` の `createContext()` が `globalMetadata`, `classMetadata`, `methodMetadata` を順に収集して連結する。

## 実例と分析

### デコレータの設計パターン体系

NestJS のデコレータは用途に応じて明確なパターンに分類できる。

**1. Watermark デコレータ（分類マーカー）**

クラスの役割を示す boolean メタデータを付与する。フレームワークのスキャナがこの Watermark を読んでクラスを適切なコレクション（providers, controllers, injectables）に振り分ける。

```typescript
// packages/common/decorators/core/injectable.decorator.ts:43-48
export function Injectable(options?: InjectableOptions): ClassDecorator {
  return (target: object) => {
    Reflect.defineMetadata(INJECTABLE_WATERMARK, true, target);
    Reflect.defineMetadata(SCOPE_OPTIONS_METADATA, options, target);
  };
}
```

```typescript
// packages/core/scanner.ts:726-727
private isInjectable(metatype: Type<any>): boolean {
  return !!Reflect.getMetadata(INJECTABLE_WATERMARK, metatype);
}
```

**2. 構成デコレータ（Configuration）**

複数のメタデータキーに値を書き込み、クラスやメソッドの振る舞いを宣言的に構成する。`@Controller()` はパス・ホスト・スコープ・バージョンの 4 つのメタデータを一度に設定する。

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

**3. 累積デコレータ（Accumulative）**

同一メタデータキーに対してメタデータを追加（extend）するパターン。`@UseGuards()`, `@UseInterceptors()`, `@UsePipes()`, `@UseFilters()` の 4 つの enhancer デコレータと `@Header()` がこの方式を採用する。

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

**4. パラメータデコレータ（Parameter Extraction）**

メソッドパラメータの位置とデータソースをメタデータとして記録する。`@Body()`, `@Param()`, `@Query()` 等がこのパターンに従い、キーとして `paramtype:index` の複合キーを使う。

```typescript
// packages/common/decorators/http/route-params.decorator.ts:47-65
function createRouteParamDecorator(paramtype: RouteParamtypes) {
  return (data?: ParamData): ParameterDecorator => (target, key, index) => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, target.constructor, key!)
      || {};
    Reflect.defineMetadata(
      ROUTE_ARGS_METADATA,
      assignMetadata<RouteParamtypes, Record<number, RouteParamMetadata>>(
        args,
        paramtype,
        index,
        data,
      ),
      target.constructor,
      key!,
    );
  };
}
```

### ファクトリ関数によるデコレータ生成の階層構造

NestJS はデコレータ生成を多段階に抽象化している。

- **低レベル**: `Reflect.defineMetadata` を直接呼ぶ（`@Injectable()`, `@Controller()`）
- **中レベル**: `createMappingDecorator`, `createRouteParamDecorator` などのファクトリ関数を通じて HTTP メソッド別のデコレータを量産する
- **高レベル**: `Reflector.createDecorator()`, `createParamDecorator()` でユーザーがカスタムデコレータを定義する

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
```

### reflect-metadata によるコンストラクタ型の自動解決

TypeScript コンパイラが `emitDecoratorMetadata` 設定下で `design:paramtypes` メタデータを自動生成し、DI コンテナがこれを読んでコンストラクタ引数の型を推論する。`@Inject()` デコレータは `SELF_DECLARED_DEPS_METADATA` でこの自動推論を上書きできる。

```typescript
// packages/core/injector/injector.ts:440-456
public reflectConstructorParams<T>(type: Type<T>): any[] {
  const paramtypes = [
    ...(Reflect.getMetadata(PARAMTYPES_METADATA, type) || []),
  ];
  const selfParams = this.reflectSelfParams<T>(type);
  selfParams.forEach(({ index, param }) => (paramtypes[index] = param));
  return paramtypes;
}
```

`@Inject()` は parameter と property の両方で使え、`index` の有無で自動判別する。

```typescript
// packages/common/decorators/core/inject.decorator.ts:43-67
return (target: object, key: string | symbol | undefined, index?: number) => {
  let type = token || Reflect.getMetadata("design:type", target, key!);
  if (!type && !injectCallHasArguments) {
    type = Reflect.getMetadata(PARAMTYPES_METADATA, target, key!)?.[index!];
  }
  if (!isUndefined(index)) {
    let dependencies = Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, target) || [];
    dependencies = [...dependencies, { index, param: type }];
    Reflect.defineMetadata(SELF_DECLARED_DEPS_METADATA, dependencies, target);
    return;
  }
  // property injection
  let properties = Reflect.getMetadata(PROPERTY_DEPS_METADATA, target.constructor) || [];
  properties = [...properties, { key, type }];
  Reflect.defineMetadata(PROPERTY_DEPS_METADATA, properties, target.constructor);
};
```

### メタデータキーの一元管理

全メタデータキーを `packages/common/constants.ts` に集約する設計は、デコレータとランタイム間の契約を明示化する。Watermark キーには `__` prefix を使い、enhancer キーには `__xxx__` のダブルアンダースコアパターンを使う。

```typescript
// packages/common/constants.ts:1-47 (抜粋)
export const MODULE_METADATA = {
  IMPORTS: "imports",
  PROVIDERS: "providers",
  CONTROLLERS: "controllers",
  EXPORTS: "exports",
};
export const PARAMTYPES_METADATA = "design:paramtypes";
export const SELF_DECLARED_DEPS_METADATA = "self:paramtypes";
export const GUARDS_METADATA = "__guards__";
export const INTERCEPTORS_METADATA = "__interceptors__";
export const INJECTABLE_WATERMARK = "__injectable__";
export const CONTROLLER_WATERMARK = "__controller__";
```

### クロスパッケージでのデコレータパターンの再利用

microservices パッケージの `@MessagePattern()`, websockets パッケージの `@WebSocketGateway()` と `@SubscribeMessage()` は、core のデコレータパターン（メタデータ書き込み → スキャナが読み取り）を忠実に踏襲しており、パッケージ横断で一貫したアーキテクチャを維持している。

```typescript
// packages/websockets/decorators/subscribe-message.decorator.ts:8-18
export const SubscribeMessage = <T = string>(message: T): MethodDecorator => {
  return (target: object, key: string | symbol, descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata(MESSAGE_MAPPING_METADATA, true, descriptor.value);
    Reflect.defineMetadata(MESSAGE_METADATA, message, descriptor.value);
    return descriptor;
  };
};
```

## パターンカタログ

- **Metadata-Driven Architecture** (分類: アーキテクチャパターン)
  - 解決する問題: 宣言的な構成と実行時の振る舞いの分離
  - 適用条件: フレームワーク/ライブラリ設計で、ユーザーコードから構成情報を収集する必要がある場合
  - コード例: `packages/common/decorators/` (Write) → `packages/core/scanner.ts` (Read)
  - 注意点: メタデータキーの衝突管理が必要。NestJS は `constants.ts` で一元管理する

- **Strategy / Template Method** (分類: 振る舞い)
  - 解決する問題: enhancer（Guard, Interceptor, Pipe, Filter）の適用ロジックの共通化
  - 適用条件: 異なる種類のデコレータが同一の収集・適用パイプラインを持つ場合
  - コード例: `packages/core/helpers/context-creator.ts` が基底クラス、`GuardsContextCreator` 等がサブクラス
  - 注意点: グローバル→クラス→メソッドの順序が動作を決定するため、順序の保証が必要

- **Factory Method** (分類: 生成)
  - 解決する問題: 類似デコレータの量産
  - 適用条件: パラメータの差異だけで複数のデコレータが必要な場合
  - コード例: `createMappingDecorator(RequestMethod.POST)` → `Post` (`request-mapping.decorator.ts:32-48`)
  - 注意点: ファクトリの抽象度を上げすぎるとデバッグが困難になる

## Good Patterns

- **メタデータキーの一元管理と命名規約**: 全メタデータキーを単一の `constants.ts` に集約し、Watermark には `__xxx__` パターン、TS コンパイラ生成メタデータには `design:` prefix、自己宣言メタデータには `self:` prefix を使い分ける。これによりキーの衝突を防ぎ、メタデータの由来を名前から判別できる。

```typescript
// packages/common/constants.ts:11-14
export const PARAMTYPES_METADATA = "design:paramtypes"; // TS コンパイラ生成
export const SELF_DECLARED_DEPS_METADATA = "self:paramtypes"; // ユーザー宣言
export const PROPERTY_DEPS_METADATA = "self:properties_metadata";
export const OPTIONAL_PROPERTY_DEPS_METADATA = "optional:properties_metadata";
```

- **デコレータ入力のバリデーション**: `@UseGuards()`, `@UseInterceptors()` 等の enhancer デコレータは、受け取った引数が期待するインターフェースを実装しているかをデコレータ適用時にバリデーションする。実行時エラーの早期検出により、起動時ではなくデコレーション時に問題を発見できる。

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

- **`@Module()` の構成キーバリデーション**: `@Module()` デコレータは受け取ったオブジェクトのキーが `imports`, `providers`, `controllers`, `exports` のいずれかであることを検証する。タイポや不正なキーを即座に検出し、デバッグコストを削減する。

```typescript
// packages/common/utils/validate-module-keys.util.ts:15-23
export function validateModuleKeys(keys: string[]) {
  const validateKey = (key: string) => {
    if (metadataKeys.includes(key)) return;
    throw new Error(INVALID_MODULE_CONFIG_MESSAGE`${key}`);
  };
  keys.forEach(validateKey);
}
```

- **Class/Method 両用デコレータの設計**: `UseGuards`, `UseInterceptors` 等は `descriptor` の有無でクラスデコレータかメソッドデコレータかを判定し、メタデータの書き込み先を切り替える。これにより単一のデコレータ関数で両方のユースケースに対応する。

```typescript
// packages/common/decorators/core/use-guards.decorator.ts:31-53
return (target: any, key?: string | symbol, descriptor?: TypedPropertyDescriptor<any>) => {
  if (descriptor) {
    // メソッドデコレータ: descriptor.value にメタデータを付与
    extendArrayMetadata(GUARDS_METADATA, guards, descriptor.value);
    return descriptor;
  }
  // クラスデコレータ: target にメタデータを付与
  extendArrayMetadata(GUARDS_METADATA, guards, target);
  return target;
};
```

## Anti-Patterns / 注意点

- **メタデータキーのインライン文字列使用**: メタデータキーを定数化せずにインライン文字列で使うと、キーの衝突やタイポを検出できない。NestJS は全キーを `constants.ts` で管理しているが、ユーザーが `SetMetadata('roles', [...])` のように文字列を直接使うと型安全性が失われる。

```typescript
// Bad: キーが文字列リテラル
@SetMetadata('roles', ['admin'])

// Better: Reflector.createDecorator で型安全なデコレータを生成
const Roles = Reflector.createDecorator<string[]>();
@Roles(['admin'])
```

- **デコレータ内での副作用（メソッド書き換え）**: `GrpcStreamMethod` はデコレータ内で `descriptor.value` を別の関数に差し替えている。この場合、元のメソッドのメタデータを新しい関数に手動コピーする必要があり、コピー漏れのリスクがある。

```typescript
// packages/microservices/decorators/message-pattern.decorator.ts:155-178
// Bad: デコレータ内でメソッドを書き換え、メタデータを手動コピー
descriptor.value = function (this: any, observable: any, ...args: any[]) { ... };
const metadataKeys = Reflect.getMetadataKeys(originalMethod);
metadataKeys.forEach(metadataKey => {
  const metadataValue = Reflect.getMetadata(metadataKey, originalMethod);
  Reflect.defineMetadata(metadataKey, metadataValue, descriptor.value);
});

// Better: メソッド書き換えはデコレータの責務外にし、
// ラッパーパターンやプロキシで対応する
```

## 導出ルール

- `[MUST]` デコレータ駆動アーキテクチャでは、全メタデータキーを単一ファイルに定数として集約し、デコレータ（書き込み側）とランタイム（読み取り側）の両方がその定数を参照すること
  - 根拠: NestJS は `constants.ts` に約 30 のメタデータキーを集約し、`packages/common/decorators/` と `packages/core/scanner.ts` が同じ定数を import する設計で一貫性を保っている

- `[MUST]` デコレータに渡される引数は、適用時にバリデーションすること。ランタイムまでエラーの検出を遅延させない
  - 根拠: `validateEach()` が `@UseGuards`, `@UseInterceptors` 等で呼ばれ、不正な引数をデコレータ適用時に即座に検出する（`validate-each.util.ts:16-31`）

- `[SHOULD]` 類似デコレータが複数必要な場合は、ファクトリ関数で生成することで実装の重複を排除する
  - 根拠: `createMappingDecorator()` が `@Get`, `@Post`, `@Delete` 等 10 以上の HTTP メソッドデコレータを単一のファクトリから生成している（`request-mapping.decorator.ts:32-39`）

- `[SHOULD]` クラスとメソッドの両方に適用可能なデコレータは、`descriptor` パラメータの有無で判定して書き込み先を切り替えること
  - 根拠: `@UseGuards`, `@UseInterceptors`, `@UsePipes`, `@UseFilters` の 4 つの enhancer デコレータが全て同じパターンで `descriptor` の有無を判定し、メタデータ書き込み先を `descriptor.value`（メソッド）と `target`（クラス）に切り替えている

- `[SHOULD]` デコレータで書き込むメタデータは累積型（配列マージ）にし、階層ごとの宣言が合成されるようにすること。上書き型にすると上位階層の宣言が無視される
  - 根拠: `extendArrayMetadata()` が既存配列にスプレッド結合する設計により、`ContextCreator.createContext()` がグローバル→クラス→メソッドの 3 階層を自然に合成できている

- `[SHOULD]` Watermark パターンでクラスの役割を識別する場合は、boolean メタデータを付与し、スキャナ側で `!!Reflect.getMetadata(KEY, target)` で判定すること
  - 根拠: `INJECTABLE_WATERMARK`, `CONTROLLER_WATERMARK`, `CATCH_WATERMARK` の 3 つが全て同じパターンで、scanner.ts がクラス分類時に統一的に判定している

- `[AVOID]` デコレータ内で `descriptor.value` を別の関数に差し替えること。メタデータの手動コピーが必要になり、コピー漏れによるバグが発生する
  - 根拠: `GrpcStreamMethod` が `descriptor.value` を差し替えた後に `Reflect.getMetadataKeys` で全メタデータを手動コピーしており、このパターンは脆弱である（`message-pattern.decorator.ts:155-178`）

## 適用チェックリスト

- [ ] メタデータキーを定数ファイルに集約し、デコレータとランタイムの両方から参照しているか
- [ ] デコレータのメタデータキーに命名規約（prefix / suffix）を設けて衝突を防止しているか
- [ ] デコレータに渡される引数のバリデーションをデコレータ適用時に行っているか
- [ ] 類似デコレータをファクトリ関数で生成し、実装の重複を排除しているか
- [ ] クラス/メソッド両用デコレータで `descriptor` の有無による書き込み先の切り替えを実装しているか
- [ ] 複数階層（グローバル/クラス/メソッド）のメタデータを累積型で合成できる設計になっているか
- [ ] ユーザー向けにカスタムデコレータの作成支援 API（`Reflector.createDecorator` や `createParamDecorator` に相当するもの）を提供しているか
- [ ] `emitDecoratorMetadata` に依存する場合、その前提をドキュメントに明記しているか
