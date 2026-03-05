# Pattern: Three-Layer Platform Abstraction

> 出典: [repos/nestjs/nest](../repos/nestjs/nest/) (主要), [repos/modelcontextprotocol/typescript-sdk](../repos/modelcontextprotocol/typescript-sdk/) (補助)
> カテゴリ: pattern

## 概要

Interface → Abstract Class → Concrete の三層でプラットフォーム抽象化を構築するパターン。インターフェースがコア層の安定した契約を定義し、抽象クラスが共通実装のボイラープレートを削減し、具象クラスがプラットフォーム固有の振る舞いを提供する。完全な抽象化が現実的でない場面では「型付き脱出口」（platform-specific interface）を用意し、利用者がプラットフォーム固有 API に型安全にアクセスできるようにする。

## 背景・文脈

NestJS は Express と Fastify という API 設計が根本的に異なる 2 つの HTTP サーバーを、フレームワーク利用者のコードを一切変更せずに交換可能にしている。この抽象化を支えるのが `HttpServer` インターフェース、`AbstractHttpAdapter` 抽象クラス、`ExpressAdapter` / `FastifyAdapter` 具象クラスの三層構造である。

MCP TypeScript SDK も同様に、JSON Schema バリデーターの実装を `jsonSchemaValidator` インターフェース → `AjvJsonSchemaValidator` / `CfWorkerJsonSchemaValidator` 具象クラスという構造で抽象化し、Node.js と Cloudflare Workers のデュアルランタイムに対応している。

両リポジトリに共通するのは「コア層にプラットフォーム条件分岐を持ち込まない」という設計原則である。

## 実装パターン

### 第1層: インターフェース -- コア層が依存する契約

コア層が依存する最小限の契約をインターフェースとして定義する。

```typescript
// nestjs/nest - packages/common/interfaces/http/http-server.interface.ts:17-101
export interface HttpServer<
  TRequest = any,
  TResponse = any,
  ServerInstance = any,
> {
  use(handler: RequestHandler<TRequest, TResponse> | ErrorHandler<TRequest, TResponse>): any;
  use(path: string, handler: RequestHandler<TRequest, TResponse> | ErrorHandler<TRequest, TResponse>): any;
  get(handler: RequestHandler<TRequest, TResponse>): any;
  get(path: string, handler: RequestHandler<TRequest, TResponse>): any;
  post(handler: RequestHandler<TRequest, TResponse>): any;
  post(path: string, handler: RequestHandler<TRequest, TResponse>): any;
  // ... 他の HTTP メソッド
  listen(port: number | string, callback?: () => void): any;
  reply(response: any, body: any, statusCode?: number): any;
  status(response: any, statusCode: number): any;
  getType(): string;
  initHttpServer(options: NestApplicationOptions): void;
  getInstance(): ServerInstance;
  // ...
}
```

MCP SDK でも同じ原則でバリデーターの契約を定義している:

```typescript
// modelcontextprotocol/typescript-sdk - packages/core/src/validation/types.ts:51-59
export interface jsonSchemaValidator {
  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T>;
}
```

### 第2層: 抽象クラス -- 共通実装の提供

抽象クラスがインターフェースを implements し、共通メソッドのデフォルト実装を提供する。プラットフォーム固有の振る舞いは abstract メソッドとして具象クラスに委ねる。

```typescript
// nestjs/nest - packages/core/adapters/http-adapter.ts:8-193
export abstract class AbstractHttpAdapter<
  TServer = any,
  TRequest = any,
  TResponse = any,
> implements HttpServer<TRequest, TResponse> {
  protected httpServer: TServer;

  constructor(protected instance?: any) {}

  // デフォルト実装: instance への委譲
  public use(...args: any[]) {
    return this.instance.use(...args);
  }

  public get(...args: any[]) {
    return this.instance.get(...args);
  }

  // ... 他の HTTP メソッドも同様に委譲

  // プラットフォーム固有: 具象クラスで必ず実装する
  abstract close();
  abstract initHttpServer(options: NestApplicationOptions);
  abstract status(response: any, statusCode: number);
  abstract reply(response: any, body: any, statusCode?: number);
  abstract getRequestHostname(request: any);
  abstract getRequestMethod(request: any);
  abstract getRequestUrl(request: any);
  abstract getType(): string;
  abstract applyVersionFilter(
    handler: Function,
    version: VersionValue,
    versioningOptions: VersioningOptions,
  ): (req: TRequest, res: TResponse, next: () => void) => Function;
}
```

### 第3層: 具象クラス -- プラットフォーム固有の実装

各プラットフォームのネイティブな API を活かした実装を提供する。

```typescript
// nestjs/nest - packages/platform-express/adapters/express-adapter.ts:51-53
export class ExpressAdapter extends AbstractHttpAdapter<
  http.Server | https.Server
> {
  public getType(): string {
    return "express";
  }
  // デフォルト実装（this.instance.get() 等）をそのまま継承
}
```

```typescript
// nestjs/nest - packages/platform-fastify/adapters/fastify-adapter.ts:124-142
export class FastifyAdapter<
  TServer extends RawServerBase = RawServerDefault,
  TRawRequest extends FastifyRawRequest<TServer> = FastifyRawRequest<TServer>,
> // ... デフォルト型により通常は型引数指定不要
  extends AbstractHttpAdapter<TServer, TRequest, TReply>
{
  // Fastify は Express と API が異なるため、ルーティングメソッドをオーバーライド
  public get(...args: any[]) {
    return this.injectRouteOptions("GET", ...args);
  }

  public post(...args: any[]) {
    return this.injectRouteOptions("POST", ...args);
  }

  public getType(): string {
    return "fastify";
  }
}
```

### 型付き脱出口 -- プラットフォーム固有 API への安全なアクセス

完全な抽象化はコスト対効果が見合わない場面がある。Express の `set()` / `enable()` や Fastify の `register()` / `inject()` はプラットフォーム固有の強力な機能であり、これらを抽象化で隠すのではなく、型付きインターフェースで明示的に公開する。

```typescript
// nestjs/nest - packages/platform-express/interfaces/nest-express-application.interface.ts:20-53
export interface NestExpressApplication<
  TServer extends CoreHttpServer | CoreHttpsServer = CoreHttpServer,
> extends INestApplication<TServer> {
  // Express 固有の API を型安全に公開
  set(...args: any[]): this;
  engine(...args: any[]): this;
  enable(...args: any[]): this;
  disable(...args: any[]): this;
  useStaticAssets(path: string, options?: ServeStaticOptions): this;
}
```

```typescript
// nestjs/nest - packages/platform-fastify/interfaces/nest-fastify-application.interface.ts:27-49
export interface NestFastifyApplication<
  TServer extends RawServerBase = RawServerDefault,
> extends INestApplication<TServer> {
  // Fastify 固有の API を型安全に公開
  register<Options extends FastifyPluginOptions = any>(
    plugin: FastifyPluginCallback<Options> | FastifyPluginAsync<Options>,
    opts?: FastifyRegisterOptions<Options>,
  ): Promise<FastifyInstance>;
  inject(): LightMyRequestChain;
  inject(opts: InjectOptions | string): Promise<LightMyRequestResponse>;
}
```

利用側は `NestFactory.create` の型パラメータで脱出口を選択する:

```typescript
// nestjs/nest - packages/core/nest-factory.ts:79-86
public async create<T extends INestApplication = INestApplication>(
  moduleCls: IEntryNestModule,
  serverOrOptions?: AbstractHttpAdapter | NestApplicationOptions,
  options?: NestApplicationOptions,
): Promise<T> {
  // ...
  return this.createAdapterProxy<T>(target, httpServer);
}

// 利用側: Express 固有 API にアクセスする場合
const app = await NestFactory.create<NestExpressApplication>(AppModule);
app.set('trust proxy', 'loopback');  // Express 固有、型安全

// 利用側: Fastify 固有 API にアクセスする場合
const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
app.register(fastifyHelmet);  // Fastify 固有、型安全
```

## Good Example

三層構造により、コア層はインターフェースのみに依存し、プラットフォーム条件分岐を持たない。

```typescript
// nestjs/nest - packages/core/nest-factory.ts:344-371
// Proxy パターンでアダプター固有メソッドを NestApplication に透過的に委譲
private createAdapterProxy<T>(app: NestApplication, adapter: HttpServer): T {
  const proxy = new Proxy(app, {
    get: (receiver: Record<string, any>, prop: string) => {
      const mapToProxy = (result: unknown) => {
        return result instanceof Promise
          ? result.then(mapToProxy)
          : result instanceof NestApplication
            ? proxy
            : result;
      };

      if (!(prop in receiver) && prop in adapter) {
        return (...args: unknown[]) => {
          const result = this.createExceptionZone(adapter, prop)(...args);
          return mapToProxy(result);
        };
      }
      if (isFunction(receiver[prop])) {
        return (...args: unknown[]) => {
          const result = receiver[prop](...args);
          return mapToProxy(result);
        };
      }
      return receiver[prop];
    },
  });
  return proxy as unknown as T;
}
```

この Proxy により、`NestExpressApplication.set()` や `NestFastifyApplication.register()` は型定義上はインターフェースで宣言されつつ、実行時には Proxy 経由でアダプターに委譲される。コア層（`NestApplication`）にはプラットフォーム固有のコードが一切混入しない。

MCP SDK でも同じ原則がインターフェース + 具象クラスで実現されている:

```typescript
// modelcontextprotocol/typescript-sdk - packages/core/src/validation/ajvProvider.ts:38-39
export class AjvJsonSchemaValidator implements jsonSchemaValidator {
  private _ajv: Ajv;
  // Node.js 向け: コード生成ベースで高速
}

// modelcontextprotocol/typescript-sdk - packages/core/src/validation/cfWorkerProvider.ts:35-36
export class CfWorkerJsonSchemaValidator implements jsonSchemaValidator {
  private shortcircuit: boolean;
  // Cloudflare Workers 向け: eval/new Function 禁止環境対応
}
```

消費側はインターフェースを通じてのみ利用し、どの実装が使われるかは export conditions で静的に解決される:

```typescript
// modelcontextprotocol/typescript-sdk - packages/server/src/shimsNode.ts:6-7
export { AjvJsonSchemaValidator as DefaultJsonSchemaValidator } from "@modelcontextprotocol/core";
export { default as process } from "node:process";

// modelcontextprotocol/typescript-sdk - packages/server/src/shimsWorkerd.ts:6
export { CfWorkerJsonSchemaValidator as DefaultJsonSchemaValidator } from "@modelcontextprotocol/core";
```

## Bad Example

コア層にプラットフォーム条件分岐を持ち込む設計は、新しいプラットフォーム追加のたびにコアを修正する必要が生じる。

```typescript
// Bad: コア層にプラットフォーム条件分岐
class HttpServer {
  private type: "express" | "fastify";

  handleRequest(req: any, res: any) {
    if (this.type === "express") {
      // Express 固有の処理
      res.send(data);
    } else if (this.type === "fastify") {
      // Fastify 固有の処理
      res.send(data);
    }
    // 新しいプラットフォームを追加するたびに分岐が増える
  }
}
```

NestJS の実際のコードでも、抽象クラスのデフォルト実装が特定プラットフォームに偏ると問題が起きる:

```typescript
// nestjs/nest - packages/core/adapters/http-adapter.ts:28-30
// デフォルト実装が Express の API を前提としている
public get(...args: any[]) {
  return this.instance.get(...args);  // Express の .get() に依存
}

// nestjs/nest - packages/platform-fastify/adapters/fastify-adapter.ts:352-354
// Fastify は API が異なるため、すべてオーバーライドが必要になる
public get(...args: any[]) {
  return this.injectRouteOptions('GET', ...args);  // Fastify のルーティング API に変換
}
```

デフォルト実装が最初に対応したプラットフォーム（Express）に偏っているため、Fastify では `get()`, `post()`, `put()`, `patch()`, `delete()`, `head()` すべてをオーバーライドする必要がある。三層構造を採用する場合、抽象クラスのデフォルト実装は特定プラットフォームに偏らないようにすべきである。

## 適用ガイド

### どのような状況で使うべきか

- 同一機能を異なるプラットフォーム（HTTP サーバー、DBドライバ、ランタイムなど）で提供する必要がある場合
- プラットフォーム間で共通の処理が多く、重複を排除したい場合
- 利用者がプラットフォーム固有の機能にもアクセスしたい場合（完全な抽象化がコスト対効果に見合わない場合）

### 導入時の注意点

- **インターフェースは最小限に**: コア層が本当に必要とするメソッドのみをインターフェースに含める。将来必要になりそうなメソッドを先行して追加しない
- **抽象クラスのデフォルト実装は中立に**: 特定プラットフォームの API を前提としたデフォルト実装は、他のプラットフォームで大量のオーバーライドを強いる
- **脱出口は明示的に**: プラットフォーム固有 API へのアクセスは、専用のインターフェース（`NestExpressApplication` 等）で型安全に提供する。暗黙の `as any` キャストに頼らない
- **条件分岐の禁止をルール化する**: コア層に `if (adapter.getType() === 'express')` のような分岐を入れないことを開発規約として明文化する

### カスタマイズポイント

- **新しいプラットフォームの追加**: 具象クラスを1つ追加するだけで対応可能。コア層の変更は不要（Open-Closed Principle）
- **脱出口の粒度**: プラットフォーム全体の脱出口（`NestExpressApplication`）だけでなく、機能単位の脱出口も検討できる
- **選択の静的化**: NestJS はファクトリパターン（`NestFactory.create`）で実行時に選択し、MCP SDK は export conditions でビルド時に選択する。プロジェクトの性質に応じて使い分ける

## 参考

- [repos/nestjs/nest/adapter-implementation-patterns.md](../repos/nestjs/nest/adapter-implementation-patterns.md) -- NestJS アダプター実装の詳細分析
- [repos/nestjs/nest/design-philosophy.md](../repos/nestjs/nest/design-philosophy.md) -- NestJS 設計思想の全体像
- [repos/modelcontextprotocol/typescript-sdk/platform-abstraction.md](../repos/modelcontextprotocol/typescript-sdk/platform-abstraction.md) -- MCP SDK のプラットフォーム抽象化分析
- [repos/modelcontextprotocol/typescript-sdk/adapter-implementation-patterns.md](../repos/modelcontextprotocol/typescript-sdk/adapter-implementation-patterns.md) -- MCP SDK アダプター実装の詳細分析
