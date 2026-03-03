# metaprogramming-techniques

> リポジトリ: nestjs/nest
> 分析日: 2026-03-03

## 概要

NestJS はデコレータと `reflect-metadata` を全面的に採用し、クラスやメソッドにメタデータを付与 → 起動時にスキャンして動的にルーティング・DI・ミドルウェアパイプラインを構築するアーキテクチャを持つ。TypeScript の `emitDecoratorMetadata` によるランタイム型情報 (`design:paramtypes`) を DI 解決に直接活用している点が特徴的であり、宣言的なコード記述と実行時の柔軟な振る舞い構築を両立させるメタプログラミングの体系的な実践例として注目に値する。

## 背景にある原則

- **宣言的メタデータによる関心の分離**: ビジネスロジック（メソッド本体）とフレームワーク関心事（ルーティング、認可、バリデーション）をデコレータで分離すべき。メタデータはクラス/メソッドの「属性」であり、実行時ロジックに直接混入させない。根拠: `@Controller()`, `@Get()`, `@UseGuards()` 等のデコレータはすべて `Reflect.defineMetadata` でメタデータを付与するのみで、実行時ロジックを一切含まない (`packages/common/decorators/` 全体)。

- **メタデータキーの中央集権管理**: メタデータキーを文字列定数として一箇所に集約し、書き込み側（デコレータ）と読み取り側（スキャナ・インジェクタ）で同一の定数を参照すべき。根拠: `packages/common/constants.ts` に全メタデータキーが定義され、`scanner.ts` と各デコレータが同じ定数をインポートしている。

- **ウォーターマークによる型分類**: クラスの「種類」をランタイムで判別するために、boolean メタデータ（ウォーターマーク）をデコレータで付与すべき。`instanceof` ではなくメタデータベースの分類にすることで、継承階層に依存しない柔軟な型判別が可能になる。根拠: `INJECTABLE_WATERMARK`, `CONTROLLER_WATERMARK`, `CATCH_WATERMARK` で `scanner.ts:727-743` がクラス種別を判定している。

- **累積メタデータパターン**: 同一キーのメタデータを複数のデコレータから段階的に蓄積できる仕組みを提供すべき。根拠: `extendArrayMetadata` (`packages/common/utils/extend-metadata.util.ts`) が `@UseGuards()`, `@UseInterceptors()`, `@UsePipes()`, `@Header()` で共通利用されている。

## 実例と分析

### デコレータファクトリの階層構造

NestJS のデコレータは 3 層のファクトリパターンで構築されている。

**第1層: 低レベル API** - `Reflect.defineMetadata` を直接呼ぶ基本デコレータ。`SetMetadata` がこれにあたり、メタデータキーと値を受け取って対象に付与する。

```typescript
// packages/common/decorators/core/set-metadata.decorator.ts:22-36
export const SetMetadata = <K = string, V = any>(
  metadataKey: K,
  metadataValue: V,
): CustomDecorator<K> => {
  const decoratorFactory = (target: object, key?: any, descriptor?: any) => {
    if (descriptor) {
      Reflect.defineMetadata(metadataKey, metadataValue, descriptor.value);
      return descriptor;
    }
    Reflect.defineMetadata(metadataKey, metadataValue, target);
    return target;
  };
  decoratorFactory.KEY = metadataKey;
  return decoratorFactory;
};
```

**第2層: ドメイン固有ファクトリ** - 第1層を組み合わせてドメインロジックを持つデコレータを生成する関数。`createMappingDecorator` が HTTP メソッドごとのデコレータを一括生成する。

```typescript
// packages/common/decorators/http/request-mapping.decorator.ts:32-39
const createMappingDecorator =
  (method: RequestMethod) =>
  (path?: string | string[]): MethodDecorator => {
    return RequestMapping({
      [PATH_METADATA]: path,
      [METHOD_METADATA]: method,
    });
  };
```

**第3層: エンドユーザー向けデコレータ** - ファクトリから生成された具象デコレータ。

```typescript
// packages/common/decorators/http/request-mapping.decorator.ts:48-57
export const Post = createMappingDecorator(RequestMethod.POST);
export const Get = createMappingDecorator(RequestMethod.GET);
```

### ランタイム型情報による DI 解決

`emitDecoratorMetadata: true` が有効な場合、TypeScript コンパイラはデコレータ付きクラスのコンストラクタ引数型を `design:paramtypes` メタデータとして自動付与する。NestJS の Injector はこれを読み取って依存関係を解決する。

```typescript
// packages/core/injector/injector.ts:440-448
public reflectConstructorParams<T>(type: Type<T>): any[] {
  const paramtypes = [
    ...(Reflect.getMetadata(PARAMTYPES_METADATA, type) || []),
  ];
  const selfParams = this.reflectSelfParams<T>(type);
  selfParams.forEach(({ index, param }) => (paramtypes[index] = param));
  return paramtypes;
}
```

ここで `PARAMTYPES_METADATA` は `'design:paramtypes'` そのもの (`packages/common/constants.ts:11`)。`selfParams` は `@Inject()` で明示的にオーバーライドされた引数で、`design:paramtypes` の自動推論を上書きする。この「自動推論 + 明示的オーバーライド」の 2 層構造が DI の柔軟性を支えている。

### メタデータスキャンのプロトタイプチェーン走査

`MetadataScanner` はクラスの全メソッド名を収集する際にプロトタイプチェーンを再帰的に走査し、継承元のメソッドも含めてメタデータを探索する。走査結果をキャッシュして再利用する。

```typescript
// packages/core/metadata-scanner.ts:78-120
public getAllMethodNames(prototype: object | null): string[] {
  if (!prototype) {
    return [];
  }
  if (this.cachedScannedPrototypes.has(prototype)) {
    return this.cachedScannedPrototypes.get(prototype)!;
  }
  const visitedNames = new Map<string, boolean>();
  const result: string[] = [];
  this.cachedScannedPrototypes.set(prototype, result);
  do {
    for (const property of Object.getOwnPropertyNames(prototype)) {
      if (visitedNames.has(property)) { continue; }
      visitedNames.set(property, true);
      const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
      if (descriptor!.set || descriptor!.get || isConstructor(property) || !isFunction(prototype[property])) {
        continue;
      }
      result.push(property);
    }
  } while (
    (prototype = Reflect.getPrototypeOf(prototype)) &&
    prototype !== Object.prototype
  );
  return result;
}
```

### 複合キーによるパラメータメタデータの格納

ルートハンドラのパラメータデコレータ (`@Body()`, `@Param()`, `@Query()`) はメタデータを `{paramtype}:{index}` の複合キーで格納し、同一メソッドの複数パラメータを 1 つのメタデータオブジェクトにフラットに蓄積する。

```typescript
// packages/common/decorators/http/route-params.decorator.ts:30-45
export function assignMetadata<TParamtype = any, TArgs = any>(
  args: TArgs,
  paramtype: TParamtype,
  index: number,
  data?: ParamData,
  ...pipes: (Type<PipeTransform> | PipeTransform)[]
) {
  return {
    ...args,
    [`${paramtype as string}:${index}`]: {
      index,
      data,
      pipes,
    },
  };
}
```

### メタデータのコピー（プロキシラッパー）

ルートハンドラをプロキシで包む際、元の関数に付与されたメタデータをすべて新しい関数にコピーする。`Reflect.getMetadataKeys` で全キーを列挙し、一括転写する。

```typescript
// packages/core/router/router-explorer.ts:451-462
private copyMetadataToCallback(
  originalCallback: RouterProxyCallback,
  targetCallback: Function,
) {
  for (const key of Reflect.getMetadataKeys(originalCallback)) {
    Reflect.defineMetadata(
      key,
      Reflect.getMetadata(key, originalCallback),
      targetCallback,
    );
  }
}
```

## パターンカタログ

- **Decorator Factory (GoF: Factory Method の変形)**
  - 解決する問題: 類似するデコレータ群を個別に実装すると重複が多くなる
  - 適用条件: 同一構造で引数のみ異なるデコレータが 3 個以上ある場合
  - コード例: `packages/common/decorators/http/request-mapping.decorator.ts:32-39`
  - 注意点: ファクトリの戻り値型を正しく定義しないとデコレータの型安全性が失われる

- **Watermark Pattern (分類: 構造 - マーカーインタフェースの動的版)**
  - 解決する問題: `instanceof` ではクラスの役割（Controller/Injectable/Filter）を判別できない
  - 適用条件: クラスの「カテゴリ」をランタイムで判別する必要がある場合
  - コード例: `packages/common/constants.ts:44-47`, `packages/core/scanner.ts:726-743`
  - 注意点: ウォーターマークを付け忘れるとスキャナが検出できない。バリデーション機構と組み合わせる

- **Reflector (分類: 振る舞い - Strategy + Facade)**
  - 解決する問題: メタデータの読み取りを型安全に統一的に行いたい
  - 適用条件: 複数の場所からメタデータを読み取る必要がある場合
  - コード例: `packages/core/services/reflector.service.ts:44-268`
  - 注意点: `getAll`, `getAllAndMerge`, `getAllAndOverride` の使い分けで階層的メタデータの結合戦略を選べる

## Good Patterns

- **型安全なデコレータファクトリ (`Reflector.createDecorator`)**: `SetMetadata` の文字列キーを隠蔽し、デコレータ自体に `.KEY` プロパティを持たせて読み書きを型安全に紐付ける。

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

- **累積メタデータユーティリティ**: 配列値のメタデータを非破壊的に蓄積する汎用関数を用意し、複数のデコレータ（Guards, Interceptors, Pipes, Headers）から共通利用する。

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

- **デコレータ合成関数 (`applyDecorators`)**: 複数デコレータを 1 つにまとめるユーティリティ。クラスデコレータとメソッドデコレータを自動判別する。

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
      (decorator as MethodDecorator | PropertyDecorator)(
        target, propertyKey!, descriptor!,
      );
    }
  };
}
```

## Anti-Patterns / 注意点

- **メタデータキーの散在 (Magic String)**: メタデータキーを各デコレータにハードコードすると、読み取り側との不整合が発生する。

```typescript
// Bad: キーを直接文字列で指定
Reflect.defineMetadata('myCustomKey', value, target);
// ... 別ファイルで
Reflect.getMetadata('my_custom_key', target); // タイポで不整合

// Better: 定数を中央管理
// constants.ts
export const MY_CUSTOM_KEY = 'myCustomKey';
// decorator.ts
Reflect.defineMetadata(MY_CUSTOM_KEY, value, target);
// scanner.ts
Reflect.getMetadata(MY_CUSTOM_KEY, target);
```

- **メタデータの上書きによるデータ消失**: 累積すべきメタデータを `defineMetadata` で直接書き込むと、先行デコレータの値を消してしまう。

```typescript
// Bad: 先行する Guards が上書きされる
Reflect.defineMetadata(GUARDS_METADATA, [NewGuard], target);

// Better: 既存値を読み取って結合
const previous = Reflect.getMetadata(GUARDS_METADATA, target) || [];
Reflect.defineMetadata(GUARDS_METADATA, [...previous, NewGuard], target);

// Best: 専用ユーティリティを使う
extendArrayMetadata(GUARDS_METADATA, [NewGuard], target);
```

- **`design:paramtypes` への過度な依存**: インタフェースや型エイリアスはランタイムに消えるため、`design:paramtypes` が `Object` になる。明示的な `@Inject()` トークンを併用しないと DI 解決に失敗する。

```typescript
// Bad: インタフェースは design:paramtypes で解決できない
constructor(private readonly config: ConfigInterface) {} // => Object

// Better: 文字列/シンボルトークンで明示
constructor(@Inject('CONFIG') private readonly config: ConfigInterface) {}
```

## 導出ルール

- `[MUST]` メタデータキーは定数として一箇所に集約し、書き込み側と読み取り側で同一の定数を参照する
  - 根拠: NestJS は `packages/common/constants.ts` に全キーを集約し、scanner・injector・decorator が同一定数をインポートしている。分散するとキー不整合のバグが静的解析で検出できない

- `[MUST]` デコレータは副作用（実行時ロジック）を持たず、メタデータの付与のみに責務を限定する
  - 根拠: NestJS の全デコレータ (`@Controller`, `@Injectable`, `@Get` 等) は `Reflect.defineMetadata` の呼び出しのみで構成され、実行時ロジックを一切含まない。これにより宣言とロジックが完全に分離される

- `[SHOULD]` 累積型メタデータには read-merge-write ユーティリティを用意し、デコレータから直接 `defineMetadata` しない
  - 根拠: `extendArrayMetadata` が `@UseGuards`, `@UseInterceptors`, `@UsePipes`, `@Header` の 4 箇所で共通利用されており、上書きバグを構造的に排除している

- `[SHOULD]` ランタイム型推論 (`design:paramtypes`) は具象クラスに対してのみ信頼し、インタフェース/ユニオン型には明示的トークンを併用する
  - 根拠: `@Inject()` デコレータ (`packages/common/decorators/core/inject.decorator.ts:38-68`) は `design:paramtypes` の自動推論をオーバーライドする機構を持ち、インタフェース型の場合にフォールバックとして機能する

- `[SHOULD]` メタデータスキャン結果はキャッシュし、同一プロトタイプの再走査を避ける
  - 根拠: `MetadataScanner` (`packages/core/metadata-scanner.ts:9`) が `cachedScannedPrototypes` Map でプロトタイプごとの走査結果をキャッシュしている

- `[SHOULD]` クラスの役割分類には `instanceof` ではなくブーリアンメタデータ（ウォーターマーク）を使う
  - 根拠: `INJECTABLE_WATERMARK`, `CONTROLLER_WATERMARK`, `CATCH_WATERMARK` (`packages/common/constants.ts:44-46`) がクラスの種別判定に使われ、継承関係に依存しない分類を実現している

- `[AVOID]` メタデータキーに生の文字列リテラルを使うこと（定数化せずにデコレータ内でハードコードする）
  - 根拠: NestJS はすべてのメタデータキーを `constants.ts` の名前付き定数として管理しており、文字列リテラルの直接使用は 1 箇所も存在しない

## 適用チェックリスト

- [ ] メタデータキーが定数ファイルに集約されているか確認する
- [ ] デコレータが `Reflect.defineMetadata` のみを行い、副作用を含んでいないか検証する
- [ ] 累積型メタデータ（Guards, Interceptors 等のリスト）に対して read-merge-write パターンを適用しているか確認する
- [ ] `emitDecoratorMetadata` を有効にしている場合、インタフェース型の DI 解決に明示的トークンを使っているか確認する
- [ ] メタデータスキャン処理にプロトタイプチェーン走査のキャッシュが実装されているか確認する
- [ ] 関数のラッピング/プロキシ時にメタデータのコピー処理 (`Reflect.getMetadataKeys` + 一括転写) が漏れていないか確認する
- [ ] 類似デコレータが 3 個以上ある場合、デコレータファクトリによる生成パターンを検討しているか確認する
