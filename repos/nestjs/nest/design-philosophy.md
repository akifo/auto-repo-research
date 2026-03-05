# design-philosophy

> リポジトリ: nestjs/nest
> 分析日: 2026-03-03

## 概要

NestJS の設計思想を分析する。Angular にインスパイアされたモジュール/DI/デコレータ駆動のアーキテクチャ、プラットフォーム非依存の抽象化レイヤー、そして宣言的メタデータによる関心の分離が、なぜ・どのように実現されているかを横断的に掘り下げる。Node.js サーバーサイドに「アーキテクチャの不在」という問題を解決するために、これらの設計判断がどう連携しているかが注目に値する。

## 背景にある原則

- **宣言的メタデータによる構造表現**: ビジネスロジックとフレームワーク関心事を分離するために、デコレータ + `Reflect.defineMetadata` でクラスやメソッドに構造情報を付与する。ランタイムがメタデータを読み取って動作を組み立てるため、ユーザーコードはフレームワーク API を直接呼ばずに済む。根拠: `@Controller()`, `@Injectable()`, `@Module()` すべてが `Reflect.defineMetadata` で定数キーにメタデータを格納する統一パターンを採用している（`packages/common/decorators/core/`）。

- **契約（interface）による抽象化で実装を交換可能にする**: 具体的な HTTP サーバー（Express/Fastify）、WebSocket ライブラリ、マイクロサービストランスポートをインターフェースの背後に隠す。ユーザーコードはインターフェースに対してプログラミングし、起動時にアダプターを差し替えるだけでプラットフォームを変更できる。根拠: `HttpServer` インターフェース（`packages/common/interfaces/http/http-server.interface.ts`）を `AbstractHttpAdapter`（`packages/core/adapters/http-adapter.ts`）が実装し、`ExpressAdapter` と `FastifyAdapter` がそれぞれ継承している。

- **モジュールスコープによる依存関係の明示化**: すべてのプロバイダ・コントローラはモジュールに属し、モジュール間の依存は `imports`/`exports` で明示的に宣言する。暗黙的なグローバル依存を排除し、依存グラフを静的に検証可能にする。根拠: `ModuleMetadata` インターフェース（`packages/common/interfaces/modules/module-metadata.interface.ts`）が `imports`, `controllers`, `providers`, `exports` の 4 プロパティのみを許可し、`validateModuleKeys` で未知のキーを拒否する。

- **横断的関心事をパイプラインで合成する**: Guards, Interceptors, Pipes, Exception Filters を実行パイプラインの各段階に挿入するアーキテクチャにより、認証・変換・バリデーション・エラー処理を個別のクラスとして実装し、デコレータで宣言的に適用できる。根拠: `RouterExecutionContext.create` （`packages/core/router/router-execution-context.ts:80`）が guards → interceptors → pipes の順にコンテキストを組み立てる。

## 実例と分析

### デコレータ = メタデータの格納器

NestJS のデコレータは「何かを実行する」のではなく「メタデータを格納する」だけの薄い関数である。実際の振る舞いはフレームワークのスキャナ（`DependenciesScanner`）やルーター（`RouterExecutionContext`）がメタデータを読み取って構築する。

```typescript
// packages/common/decorators/core/injectable.decorator.ts:43-48
export function Injectable(options?: InjectableOptions): ClassDecorator {
  return (target: object) => {
    Reflect.defineMetadata(INJECTABLE_WATERMARK, true, target);
    Reflect.defineMetadata(SCOPE_OPTIONS_METADATA, options, target);
  };
}
```

`@Controller()` も同一パターンで、`CONTROLLER_WATERMARK`, `PATH_METADATA`, `HOST_METADATA` などを格納するだけである（`packages/common/decorators/core/controller.decorator.ts:151-178`）。HTTP メソッドデコレータ（`@Get`, `@Post` など）も `createMappingDecorator` ファクトリ関数で統一的に生成される（`packages/common/decorators/http/request-mapping.decorator.ts:32-39`）。

この「デコレータは格納、ランタイムが解釈」という分離により、デコレータ自体は副作用を持たず、テスト容易性とコンポーザビリティが確保される。

### プラットフォームアダプターパターン

`AbstractHttpAdapter` は abstract class として共通メソッドのデフォルト実装を提供しつつ、プラットフォーム固有の振る舞い（`initHttpServer`, `reply`, `status` など）を abstract メソッドとして強制する。

```typescript
// packages/core/adapters/http-adapter.ts:8-12
export abstract class AbstractHttpAdapter<
  TServer = any,
  TRequest = any,
  TResponse = any,
> implements HttpServer<TRequest, TResponse> {
```

Express アダプターと Fastify アダプターは共に `AbstractHttpAdapter` を継承する:

```typescript
// packages/platform-express/adapters/express-adapter.ts:51-53
export class ExpressAdapter extends AbstractHttpAdapter<
  http.Server | https.Server
> {
```

```typescript
// packages/platform-fastify/adapters/fastify-adapter.ts (class declaration)
export class FastifyAdapter<...> extends AbstractHttpAdapter<...> {
```

`NestFactory.create` は httpAdapter を受け取り、指定がなければデフォルトで `ExpressAdapter` を生成する（`packages/core/nest-factory.ts:318-325`）。ユーザーはアダプターを差し替えるだけでプラットフォームを変更でき、コントローラやサービスのコードは一切変更不要である。

同じパターンがマイクロサービスにも適用される。`Server` 基底クラス（`packages/microservices/server/server.ts`）を `ServerTCP`, `ServerRedis`, `ServerKafka` などが継承し、トランスポートプロトコルの差異を吸収する。

### ExecutionContext によるコンテキスト統一

`ArgumentsHost` インターフェースは `switchToHttp()`, `switchToRpc()`, `switchToWs()` を提供し、Guards/Interceptors/Filters が通信プロトコルを意識せずに動作できるようにする。

```typescript
// packages/common/interfaces/features/arguments-host.interface.ts:64-93
export interface ArgumentsHost {
  getArgs<T extends Array<any> = any[]>(): T;
  getArgByIndex<T = any>(index: number): T;
  switchToRpc(): RpcArgumentsHost;
  switchToHttp(): HttpArgumentsHost;
  switchToWs(): WsArgumentsHost;
  getType<TContext extends string = ContextType>(): TContext;
}
```

`ExecutionContext` はこれを拡張し、`getClass()` と `getHandler()` でハンドラのメタデータにアクセスできる。これにより、同一の Guard 実装が HTTP、WebSocket、マイクロサービスの全コンテキストで動作する。

### Provider の多態的定義

DI コンテナは 5 種類の Provider 定義をサポートする: クラス、値、ファクトリ、エイリアス、そしてクラス直接指定。

```typescript
// packages/common/interfaces/modules/provider.interface.ts:10-15
export type Provider<T = any> =
  | Type<any>
  | ClassProvider<T>
  | ValueProvider<T>
  | FactoryProvider<T>
  | ExistingProvider<T>;
```

この設計により、プロダクション環境とテスト環境で異なる実装を注入する、外部ライブラリのインスタンスを DI で管理する、非同期初期化が必要なサービスをファクトリで生成する、といった多様なユースケースに対応できる。

### モジュールの 4 プロパティ制約

`@Module()` デコレータは `imports`, `controllers`, `providers`, `exports` の 4 プロパティのみを受け付け、未知のプロパティはビルド前に拒否する。

```typescript
// packages/common/utils/validate-module-keys.util.ts:15-23
export function validateModuleKeys(keys: string[]) {
  const validateKey = (key: string) => {
    if (metadataKeys.includes(key)) {
      return;
    }
    throw new Error(INVALID_MODULE_CONFIG_MESSAGE`${key}`);
  };
  keys.forEach(validateKey);
}
```

この制約はモジュールの責務を明確に限定し、「何を所有し、何を公開し、何に依存するか」を4つの宣言で表現することを強制する。

### ライフサイクルフックのインターフェース駆動

プロバイダやコントローラは `OnModuleInit`, `OnModuleDestroy`, `OnApplicationBootstrap`, `OnApplicationShutdown` などのインターフェースを実装することで、ライフサイクルイベントに参加できる。

```typescript
// packages/common/interfaces/hooks/on-init.interface.ts:8-10
export interface OnModuleInit {
  onModuleInit(): any;
}
```

フレームワークがこれらのメソッドの存在をチェックして呼び出す（ダックタイピング的アプローチ）。TypeScript のインターフェースはランタイムに存在しないが、型安全性のガイドレールとして機能する。

## パターンカタログ

- **Adapter パターン** (分類: 構造)
  - 解決する問題: 異なる HTTP サーバーライブラリ（Express, Fastify）のインターフェース差異を吸収する
  - 適用条件: 同じ抽象操作を異なるライブラリで実装する必要がある場合
  - コード例: `packages/core/adapters/http-adapter.ts:8`, `packages/platform-express/adapters/express-adapter.ts:51`
  - 注意点: abstract class + interface の二重定義で共通実装とプラットフォーム固有実装を分離している

- **Decorator パターン / Chain of Responsibility** (分類: 振る舞い)
  - 解決する問題: リクエスト処理パイプラインに横断的関心事を挿入する
  - 適用条件: 認証、バリデーション、ロギング、変換など、複数のハンドラに共通する処理がある場合
  - コード例: `packages/core/router/router-execution-context.ts:80-139` (Guards → Interceptors → Pipes の組み立て)
  - 注意点: 各段階は単一責任インターフェース（`CanActivate`, `NestInterceptor`, `PipeTransform`）で定義される

- **Abstract Factory** (分類: 生成)
  - 解決する問題: アプリケーションのブートストラップ時に適切なインスタンス群（Container, Scanner, Loader）を一括生成する
  - 適用条件: 複数のオブジェクトを協調させて初期化する必要がある場合
  - コード例: `packages/core/nest-factory.ts:43-113` (`NestFactoryStatic.create`)

- **Composite / Module パターン** (分類: 構造)
  - 解決する問題: 依存関係のスコープとライフサイクルを管理する
  - 適用条件: アプリケーションを独立した機能単位に分割し、依存を明示的に管理したい場合
  - コード例: `packages/common/decorators/modules/module.decorator.ts:18-29`, `packages/core/injector/module.ts:44-77`

## Good Patterns

- **メタデータキーの定数化**: すべてのメタデータキーを `constants.ts` に集約し、文字列リテラルの散乱を防止する。デコレータとスキャナが同じ定数を参照するため、キーの不一致によるバグが構造的に排除される。

```typescript
// packages/common/constants.ts:1-6
export const MODULE_METADATA = {
  IMPORTS: "imports",
  PROVIDERS: "providers",
  CONTROLLERS: "controllers",
  EXPORTS: "exports",
};
```

- **デコレータファクトリによる DRY 生成**: HTTP メソッドデコレータを1つのファクトリ関数から生成し、個々のデコレータの実装重複を排除する。

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

- **applyDecorators による合成**: 複数のデコレータを1つのカスタムデコレータに合成できるユーティリティを提供し、デコレータの再利用性を高める。

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
        target,
        propertyKey!,
        descriptor!,
      );
    }
  };
}
```

- **Watermark パターンによるクラス分類**: `INJECTABLE_WATERMARK`, `CONTROLLER_WATERMARK`, `CATCH_WATERMARK` をデコレータ適用時に設定し、スキャナがクラスの役割を判定する際の高速なフラグとして機能する。

## Anti-Patterns / 注意点

- **デコレータ内でのロジック実行**: デコレータの中でバリデーション以上のロジック（外部 API 呼び出し、ファイル I/O など）を行うと、クラス定義時に副作用が発生し、テスト困難になる。NestJS のデコレータが `Reflect.defineMetadata` のみに徹しているのはこのためである。

```typescript
// Bad: デコレータ内で副作用を起こす
function MyDecorator(): ClassDecorator {
  return (target) => {
    const config = fs.readFileSync("config.json"); // 副作用
    Reflect.defineMetadata("config", config, target);
  };
}

// Better: デコレータはメタデータ格納のみ、解釈はランタイムに委ねる
function MyDecorator(configKey: string): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata("configKey", configKey, target);
  };
}
```

- **プラットフォーム固有 API への直接依存**: コントローラ内で `express.Request` や `fastify.FastifyRequest` に直接依存すると、プラットフォーム交換性が失われる。NestJS は `@Req()` デコレータと `ArgumentsHost.switchToHttp().getRequest()` で抽象化を提供している。

```typescript
// Bad: Express に直接依存
import { Request } from 'express';
@Get()
handler(@Req() req: Request) { /* Express 固有の API を使用 */ }

// Better: プラットフォーム非依存のパラメータデコレータを使用
@Get()
handler(@Query('id') id: string, @Body() dto: CreateDto) { /* 抽象化された入力 */ }
```

## 導出ルール

- `[MUST]` フレームワーク拡張ポイント（ミドルウェア、プラグインなど）はインターフェースで契約を定義し、具体実装をアダプターとして差し替え可能にする
  - 根拠: NestJS は `HttpServer` インターフェース + `AbstractHttpAdapter` で Express/Fastify を完全に交換可能にしており、ユーザーコードの変更なしにプラットフォームを切り替えられる（`packages/core/adapters/http-adapter.ts`）

- `[MUST]` デコレータ（またはアノテーション的な仕組み）はメタデータの格納のみを行い、副作用を持たせない — 実際の振る舞いはランタイムのスキャナやコンテキストビルダーが解釈する
  - 根拠: NestJS の全デコレータ（`@Injectable`, `@Controller`, `@Module`, `@Get` 等）は `Reflect.defineMetadata` の呼び出しのみで構成され、スキャナ（`DependenciesScanner`）が起動時にメタデータを読み取ってオブジェクトグラフを構築する

- `[SHOULD]` モジュール（機能単位）は「何を所有し、何を公開し、何に依存するか」を宣言的に表現する仕組みを設け、暗黙的なグローバル依存を排除する
  - 根拠: `@Module()` の `imports/controllers/providers/exports` の 4 プロパティ制約と `validateModuleKeys` による厳密なバリデーションにより、依存関係が常に明示的かつ検証可能である

- `[SHOULD]` 横断的関心事（認証、バリデーション、ロギング、エラー処理）は単一責任のインターフェースとして定義し、パイプライン上で合成する
  - 根拠: `CanActivate`, `NestInterceptor`, `PipeTransform`, `ExceptionFilter` がそれぞれ1メソッドのインターフェースとして定義され、`@UseGuards()`, `@UseInterceptors()` 等のデコレータで宣言的に合成される

- `[SHOULD]` メタデータキーは定数ファイルに集約し、格納側（デコレータ）と読み取り側（スキャナ）で同一の定数を参照する
  - 根拠: `packages/common/constants.ts` に全メタデータキーが集約されており、デコレータとスキャナ（`packages/core/scanner.ts`）が同じ定数をインポートして使用する

- `[SHOULD]` 同一カテゴリに属する複数のバリエーション（HTTP メソッドデコレータ、トランスポートアダプターなど）はファクトリ関数から生成し、実装の重複を排除する
  - 根拠: `createMappingDecorator` ファクトリが `@Get`, `@Post`, `@Put` 等を統一的に生成し、各デコレータ固有のコードが不要になっている（`packages/common/decorators/http/request-mapping.decorator.ts:32-39`）

- `[AVOID]` コントローラやサービスのコード内でプラットフォーム固有の API（Express の `req.ip`, Fastify の `reply.raw` など）に直接依存する — プラットフォーム交換性が失われる
  - 根拠: NestJS は `ArgumentsHost` / `ExecutionContext` で通信プロトコルを抽象化し、Guards/Interceptors/Filters が HTTP/WS/RPC 全体で再利用可能になっている

## 適用チェックリスト

- [ ] フレームワークやライブラリの拡張ポイントにインターフェース（または abstract class）を定義し、具体実装を差し替え可能にしているか
- [ ] デコレータ/アノテーション的な仕組みが副作用なくメタデータを格納し、ランタイムが解釈する分離になっているか
- [ ] モジュール（パッケージ）間の依存関係が明示的に宣言されており、暗黙のグローバル依存がないか
- [ ] 横断的関心事（認証、ロギング、バリデーション等）が独立したクラス/関数として実装され、パイプラインで合成されているか
- [ ] メタデータキーや定数が1箇所に集約され、格納側と読み取り側で同一の定数を参照しているか
- [ ] 同一パターンのバリエーション（複数の HTTP メソッド、複数のトランスポートなど）をファクトリで生成し、ボイラープレートを削減しているか
- [ ] ユーザーコードがプラットフォーム固有 API に直接依存していない（抽象化レイヤーを介してアクセスしている）か
