# Practice: Progressive Disclosure API

> 出典: [repos/nestjs/nest](../repos/nestjs/nest/) からの抽出
> カテゴリ: practice

## 概要

引数なし → 単一プリミティブ → オプションオブジェクトの段階的オーバーロードにより、初心者は最小コードで始められ、上級者は全オプションにアクセスできる API 設計プラクティス。さらに、同一パターンのバリエーションが複数必要な場合はファクトリ関数で統一生成し、一貫性の保証と追加コストの最小化を両立する。

## 背景・文脈

NestJS はデコレータベースのフレームワークであり、`@Controller()`, `@Body()`, `@Query()`, `@Param()`, `@WebSocketGateway()` など数十のデコレータを公開 API として提供している。全デコレータにおいて「最も一般的なケースを最小のコードで実現し、高度なケースはオプションオブジェクトで段階的に開示する」という設計方針が一貫して適用されている。

このパターンは TypeScript の function overloads を活用して型安全に実現され、実装側では型ガード（`isString()`, `isUndefined()`, `Number.isInteger()` 等）による分岐で全オーバーロードを単一の関数本体に統合する。

## 実装パターン

### パターン 1: 段階的オーバーロード

3 段階のオーバーロードシグネチャで API の複雑さを段階的に開示する。

```typescript
// packages/common/decorators/core/controller.decorator.ts:56-178
// 段階 1: 引数なし（デフォルトパス '/' で最も単純に使える）
export function Controller(): ClassDecorator;
// 段階 2: パス文字列のみ（最も一般的なユースケース）
export function Controller(prefix: string | string[]): ClassDecorator;
// 段階 3: 全オプション（host, scope, version 等の上級設定）
export function Controller(options: ControllerOptions): ClassDecorator;

// 実装: 型ガードで入力を判別し、統一的に処理
export function Controller(
  prefixOrOptions?: string | string[] | ControllerOptions,
): ClassDecorator {
  const defaultPath = "/";

  const [path, host, scopeOptions, versionOptions] = isUndefined(
      prefixOrOptions,
    )
    ? [defaultPath, undefined, undefined, undefined]
    : isString(prefixOrOptions) || Array.isArray(prefixOrOptions)
    ? [prefixOrOptions, undefined, undefined, undefined]
    : [
      prefixOrOptions.path || defaultPath,
      prefixOrOptions.host,
      { scope: prefixOrOptions.scope, durable: prefixOrOptions.durable },
      Array.isArray(prefixOrOptions.version)
        ? Array.from(new Set(prefixOrOptions.version))
        : prefixOrOptions.version,
    ];

  return (target: object) => {
    Reflect.defineMetadata(CONTROLLER_WATERMARK, true, target);
    Reflect.defineMetadata(PATH_METADATA, path, target);
    Reflect.defineMetadata(HOST_METADATA, host, target);
    Reflect.defineMetadata(SCOPE_OPTIONS_METADATA, scopeOptions, target);
    Reflect.defineMetadata(VERSION_METADATA, versionOptions, target);
  };
}
```

同様のパターンが `@Body()` でも適用されている。

```typescript
// packages/common/decorators/http/route-params.decorator.ts:432-510
// 段階 1: 引数なし — body 全体を取得
export function Body(): ParameterDecorator;
// 段階 2: パイプのみ — body 全体にバリデーションを適用
export function Body(
  ...pipes: (Type<PipeTransform> | PipeTransform)[]
): ParameterDecorator;
// 段階 3: プロパティ名 + パイプ — body の特定プロパティを抽出
export function Body(
  property: string,
  ...pipes: (Type<PipeTransform> | PipeTransform)[]
): ParameterDecorator;
```

### パターン 2: ファクトリ関数による統一生成

HTTP メソッドデコレータ (`@Get`, `@Post`, `@Delete` 等) は全て同じシグネチャを持つ。`createMappingDecorator` ファクトリが 16 種のデコレータを 1 行ずつで生成する。

```typescript
// packages/common/decorators/http/request-mapping.decorator.ts:32-48
const createMappingDecorator = (method: RequestMethod) => (path?: string | string[]): MethodDecorator => {
  return RequestMapping({
    [PATH_METADATA]: path,
    [METHOD_METADATA]: method,
  });
};

export const Post = createMappingDecorator(RequestMethod.POST);
export const Get = createMappingDecorator(RequestMethod.GET);
export const Delete = createMappingDecorator(RequestMethod.DELETE);
export const Put = createMappingDecorator(RequestMethod.PUT);
export const Patch = createMappingDecorator(RequestMethod.PATCH);
export const Options = createMappingDecorator(RequestMethod.OPTIONS);
export const Head = createMappingDecorator(RequestMethod.HEAD);
export const All = createMappingDecorator(RequestMethod.ALL);
export const Search = createMappingDecorator(RequestMethod.SEARCH);
// ... 合計 16 種
```

パラメータデコレータにも同様のファクトリ階層がある。`createPipesRouteParamDecorator` が `@Body`, `@Query`, `@Param` 等の共通ロジック（パイプ対応付きメタデータ書き込み）を統一する。

```typescript
// packages/common/decorators/http/route-params.decorator.ts:67-86
const createPipesRouteParamDecorator = (paramtype: RouteParamtypes) =>
(
  data?: any,
  ...pipes: (Type<PipeTransform> | PipeTransform)[]
): ParameterDecorator =>
(target, key, index) => {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, target.constructor, key!) || {};
  const hasParamData = isNil(data) || isString(data);
  const paramData = hasParamData ? data : undefined;
  const paramPipes = hasParamData ? pipes : [data, ...pipes];

  Reflect.defineMetadata(
    ROUTE_ARGS_METADATA,
    assignMetadata(args, paramtype, index, paramData!, ...paramPipes),
    target.constructor,
    key!,
  );
};
```

### パターン 3: パッケージ横断での一貫した適用

WebSocket パッケージの `@WebSocketGateway()` も同じ段階的オーバーロードを踏襲する。

```typescript
// packages/websockets/decorators/socket-gateway.decorator.ts:10-30
export function WebSocketGateway(port?: number): ClassDecorator;
export function WebSocketGateway<
  T extends Record<string, any> = GatewayMetadata,
>(options?: T): ClassDecorator;
export function WebSocketGateway<
  T extends Record<string, any> = GatewayMetadata,
>(port?: number, options?: T): ClassDecorator;

export function WebSocketGateway<
  T extends Record<string, any> = GatewayMetadata,
>(portOrOptions?: number | T, options?: T): ClassDecorator {
  const isPortInt = Number.isInteger(portOrOptions as number);
  let [port, opt] = isPortInt ? [portOrOptions, options] : [0, portOrOptions];
  opt = opt || ({} as T);

  return (target: object) => {
    Reflect.defineMetadata(GATEWAY_METADATA, true, target);
    Reflect.defineMetadata(PORT_METADATA, port, target);
    Reflect.defineMetadata(GATEWAY_OPTIONS, opt, target);
  };
}
```

## Good Example

段階的オーバーロードにより、利用シーンに応じた最適な呼び出し方を提供する。

```typescript
// NestJS の利用例: 段階的に複雑さが増す

// 初心者: 引数なしで即座に動く
@Controller()
export class AppController {}

// 一般的: パスだけ指定
@Controller('users')
export class UsersController {}

// 上級者: host, version, scope を全指定
@Controller({
  path: 'users',
  host: 'admin.example.com',
  version: '2',
  scope: Scope.REQUEST,
})
export class AdminUsersController {}

// パラメータデコレータも同じ原則
findAll(@Query() query) {}             // 全クエリ取得
findAll(@Query('page') page: string) {} // 特定キー抽出
findAll(@Query('page', ParseIntPipe) page: number) {} // 抽出 + バリデーション
```

ファクトリ関数により、新しいバリエーション追加が 1 行で済む。

```typescript
// packages/common/decorators/http/request-mapping.decorator.ts:120-129
// Search と Propfind を追加する際のコスト: わずか 1 行ずつ
export const Search = createMappingDecorator(RequestMethod.SEARCH);
export const Propfind = createMappingDecorator(RequestMethod.PROPFIND);
```

## Bad Example

段階的開示なしに全パラメータを常に要求する設計。

```typescript
// Bad: 全ユーザーにオプションオブジェクトを強制
// 初心者は「何を渡せばいいか」わからない
function Controller(options: {
  path: string;
  host?: string | RegExp | Array<string | RegExp>;
  scope?: Scope;
  durable?: boolean;
  version?: string | string[];
}): ClassDecorator { ... }

// 最も単純なケースでも冗長な呼び出しが必要
@Controller({ path: 'users' })
export class UsersController {}
```

ファクトリを使わず、同一パターンのバリエーションを個別に実装する設計。

```typescript
// Bad: 各 HTTP メソッドデコレータを個別に実装
// ロジックの重複、振る舞いの不一致、新メソッド追加時の高コスト
export const Get = (path?: string | string[]): MethodDecorator => {
  return (target, key, descriptor) => {
    Reflect.defineMetadata(PATH_METADATA, path, descriptor.value);
    Reflect.defineMetadata(METHOD_METADATA, RequestMethod.GET, descriptor.value);
    return descriptor;
  };
};

export const Post = (path?: string | string[]): MethodDecorator => {
  return (target, key, descriptor) => {
    Reflect.defineMetadata(PATH_METADATA, path, descriptor.value);
    Reflect.defineMetadata(METHOD_METADATA, RequestMethod.POST, descriptor.value);
    return descriptor;
  };
};

// ... 16 回同じコードを繰り返す
```

## 適用ガイド

### どのような状況で使うべきか

- **公開 API（ライブラリ/フレームワーク）の関数やデコレータ**: 利用者のスキルレベルが多様で、簡単なケースから高度なケースまでカバーする必要がある場合
- **同一パターンのバリエーションが 3 つ以上ある場合**: HTTP メソッド、イベント種別、データソース種別など、パラメータの差異だけで複数の API が必要な場面
- **段階的な学習曲線を設計したい場合**: チュートリアルの最初のステップで引数なし、次のステップでプリミティブ、最後にオプションオブジェクトと進められる

### 導入時の注意点

- **オーバーロードの順序**: 最もシンプルなシグネチャを先頭に、最も複雑なシグネチャを最後に配置する。TypeScript は上から順にマッチングするため、一般的なケースが先に解決される
- **実装本体の型ガード**: 全オーバーロードを受け入れる実装シグネチャでは、`isString()`, `isUndefined()`, `Number.isInteger()` などの型ガードで入力を判別する。NestJS は `packages/common/utils/shared.utils.ts` に型ガードを集約している
- **ファクトリのスコープ**: ファクトリが生成する API の共通部分が十分に大きいことを確認する。差異がわずかでない場合、ファクトリの抽象化が逆に複雑さを増す

### カスタマイズポイント

- **段階数の調整**: NestJS は 3 段階（引数なし / プリミティブ / オプションオブジェクト）を基本とするが、`@WebSocketGateway()` のように 4 段階（引数なし / ポート番号 / オプション / ポート番号 + オプション）にすることも可能
- **ファクトリの階層化**: NestJS は低レベル（`Reflect.defineMetadata` 直接）、中レベル（`createMappingDecorator`, `createPipesRouteParamDecorator`）、高レベル（`Reflector.createDecorator()`）の 3 階層でファクトリを提供している。プロジェクトの規模に応じて適切な階層数を選択する
- **デコレータ以外への応用**: このプラクティスはデコレータに限らない。設定関数、ビルダー API、CLI コマンドのオプションなど、ユーザーが直接触れる API 全般に適用できる

## 参考

- [repos/nestjs/nest/api-design-practices.md](../repos/nestjs/nest/api-design-practices.md) -- API 設計プラクティスの全体分析
- [repos/nestjs/nest/decorator-driven-architecture.md](../repos/nestjs/nest/decorator-driven-architecture.md) -- デコレータ駆動アーキテクチャの詳細分析
