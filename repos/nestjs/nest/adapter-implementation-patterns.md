# アダプター実装パターン

> リポジトリ: nestjs/nest
> 分析日: 2026-03-03

## 概要

NestJS は HTTP サーバー（Express/Fastify）と WebSocket サーバー（Socket.IO/WS）を統一的なインターフェースで抽象化し、実行時にプラットフォームを切り替え可能にしている。この抽象化は単なるインターフェース分離に留まらず、抽象クラスによるデフォルト実装の提供、Proxy による透過的なメソッド委譲、遅延ローディングによるオプショナル依存の解決といった複数の手法を組み合わせて実現されている。フレームワーク利用者がプラットフォーム固有 API にアクセスしたい場合の「脱出口」も型安全に設計されており、抽象化のコストと利便性のバランスが参考になる。

## 背景にある原則

- **契約は最小限のインターフェースで定義し、共通実装は抽象クラスで提供すべき**: `HttpServer` インターフェース（`packages/common/interfaces/http/http-server.interface.ts`）はフレームワークコアが依存する最小契約を定義し、`AbstractHttpAdapter` がデフォルト実装を提供する。これにより、新しいプラットフォームを追加する際のボイラープレートを最小化しつつ、コアの依存先を安定させている。

- **プラットフォーム固有の機能は型付きの脱出口で公開すべき**: `NestExpressApplication` / `NestFastifyApplication` インターフェースがプラットフォーム固有メソッド（Express の `set()` / `enable()` や Fastify の `register()` / `inject()`）を型安全に公開する。完全な抽象化はコスト対効果が悪い場合、制約付きの脱出口を用意することで現実的な解を提供している。

- **オプショナル依存はファクトリ＋遅延ロードで解決すべき**: `loadPackage()` / `loadAdapter()` で `@nestjs/platform-express` や `@fastify/static` などを動的にロードし、未インストール時には明確なエラーメッセージで即座に失敗させる（`packages/common/utils/load-package.util.ts:8-20`）。これにより、必須ではないプラットフォーム依存をハードコードせずに済む。

- **差異の吸収は各アダプターに閉じ込め、コア層にプラットフォーム条件分岐を持ち込まない**: コア層（`NestApplication`, `BaseExceptionFilter` 等）は常に `HttpServer` インターフェースを通じてアダプターを利用し、`if (adapter.getType() === 'express')` のような分岐を行わない。差異はアダプター内部で吸収される。

## 実例と分析

### 三層抽象化アーキテクチャ

HTTP アダプターの抽象化は三層構造で設計されている。

1. **インターフェース層**: `HttpServer`（`packages/common/interfaces/http/http-server.interface.ts`） -- フレームワークコアが依存する契約
2. **抽象クラス層**: `AbstractHttpAdapter`（`packages/core/adapters/http-adapter.ts`） -- デフォルト実装の提供（`use()`, `get()`, `post()` 等の委譲メソッド）
3. **具象クラス層**: `ExpressAdapter` / `FastifyAdapter` -- プラットフォーム固有の実装

同様に WebSocket でも:

1. **インターフェース層**: `WebSocketAdapter`（`packages/common/interfaces/websockets/web-socket-adapter.interface.ts`）
2. **抽象クラス層**: `AbstractWsAdapter`（`packages/websockets/adapters/ws-adapter.ts`）
3. **具象クラス層**: `IoAdapter` / `WsAdapter`

この三層構造により、インターフェースの安定性（破壊的変更の防止）と実装の共通化（コード重複の削減）を両立している。

### デフォルトアダプターの遅延ロード

`NestFactory.create()` でアダプターが指定されない場合、Express がデフォルトとして遅延ロードされる。

```typescript
// packages/core/nest-factory.ts:318-325
private createHttpAdapter<T = any>(httpServer?: T): AbstractHttpAdapter {
  const { ExpressAdapter } = loadAdapter(
    '@nestjs/platform-express',
    'HTTP',
    () => require('@nestjs/platform-express'),
  );
  return new ExpressAdapter(httpServer);
}
```

```typescript
// packages/core/nest-factory.ts:83-86
public async create<T extends INestApplication = INestApplication>(
  ...
): Promise<T> {
  const [httpServer, appOptions] = this.isHttpServer(serverOrOptions!)
    ? [serverOrOptions, options]
    : [this.createHttpAdapter(), serverOrOptions];
```

この設計により、Fastify のみを使うプロジェクトでは Express を一切インストール・ロードする必要がない。

### Proxy によるアダプターメソッドの透過的公開

`NestFactory` は `createAdapterProxy` で Proxy を使い、`NestApplication` に存在しないメソッド呼び出しをアダプターに委譲する。

```typescript
// packages/core/nest-factory.ts:344-371
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
      // ...
    },
  });
  return proxy as unknown as T;
}
```

この Proxy パターンにより、`NestExpressApplication.set()` や `NestFastifyApplication.register()` のようなアダプター固有メソッドが、型定義上はインターフェースで宣言されつつ、実行時には Proxy 経由でアダプターに委譲される。

### 同一抽象メソッドの異なる実装戦略

`applyVersionFilter()` は Express と Fastify で根本的に異なるアプローチを取っている。

Express はミドルウェアパターンで各リクエストに対してバージョン判定を行う:

```typescript
// packages/platform-express/adapters/express-adapter.ts:345-490
public applyVersionFilter(
  handler: Function,
  version: VersionValue,
  versioningOptions: VersioningOptions,
): VersionedRoute {
  // ... 各バージョニングタイプに応じたハンドララッパーを返す
  const handlerForCustomVersioning: VersionedRoute = (req, res, next) => {
    const extractedVersion = versioningOptions.extractor(req);
    // ...バージョンマッチング
  };
}
```

Fastify はルーター制約（route constraints）としてバージョンを組み込む:

```typescript
// packages/platform-fastify/adapters/fastify-adapter.ts:412-423
public applyVersionFilter(
  handler: Function,
  version: VersionValue,
  versioningOptions: VersioningOptions,
): VersionedRoute<TRequest, TReply> {
  if (!this.versioningOptions) {
    this.versioningOptions = versioningOptions;
  }
  const versionedRoute = handler as VersionedRoute<TRequest, TReply>;
  versionedRoute.version = version;
  return versionedRoute;
}
```

Fastify 版は `versionConstraint`（161-231行）でルーターレベルの制約として統合する。同一の抽象メソッドでも、各プラットフォームのネイティブなパラダイムに合わせた実装が許容されている。

### Express ↔ Fastify 間のミドルウェア互換性の橋渡し

Fastify は本来 Express 形式のミドルウェアをサポートしないが、NestJS は `@fastify/middie` を内部的に fork し、セキュリティ修正を加えた独自実装を持っている。

```typescript
// packages/platform-fastify/adapters/fastify-adapter.ts:733-741
public use(...args: any[]) {
  // Fastify requires @fastify/middie plugin to be registered before middleware can be used.
  if (!this.isMiddieRegistered) {
    this.pendingMiddlewares.push({ args });
    return this;
  }
  return (this.instance.use as any)(...args);
}
```

初期化前に `use()` が呼ばれた場合はキューに蓄積し、`init()` 時にまとめて登録するパターンで、Express との API 互換性を実現している。

### 型パラメータによるプラットフォーム型の伝播

`AbstractHttpAdapter` はジェネリック型パラメータ `TServer`, `TRequest`, `TResponse` を持ち、具象クラスで具体型にバインドされる。

```typescript
// packages/core/adapters/http-adapter.ts:8-12
export abstract class AbstractHttpAdapter<
  TServer = any,
  TRequest = any,
  TResponse = any,
> implements HttpServer<TRequest, TResponse> {
```

```typescript
// packages/platform-express/adapters/express-adapter.ts:51-53
export class ExpressAdapter extends AbstractHttpAdapter<
  http.Server | https.Server
> {
```

```typescript
// packages/platform-fastify/adapters/fastify-adapter.ts:124-142
export class FastifyAdapter<
  TServer extends RawServerBase = RawServerDefault,
  TRawRequest extends FastifyRawRequest<TServer> = FastifyRawRequest<TServer>,
  // ... 6つの型パラメータ
> extends AbstractHttpAdapter<TServer, TRequest, TReply> {
```

Fastify アダプターは複雑な型パラメータチェーンを持つが、デフォルト型により通常の利用ではジェネリクスを意識せずに使える。

## パターンカタログ

- **Adapter パターン** (分類: 構造)
  - 解決する問題: 互換性のない HTTP サーバー API（Express / Fastify）を統一インターフェースで利用する
  - 適用条件: 複数の外部ライブラリが同等の機能を異なる API で提供する場合
  - コード例: `packages/core/adapters/http-adapter.ts:8-193`, `packages/platform-express/adapters/express-adapter.ts:51-518`
  - 注意点: 抽象層が薄すぎると各プラットフォームの強みを殺し、厚すぎると保守コストが増大する

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: アルゴリズムの骨格は共通だが、個別ステップがプラットフォームごとに異なる
  - 適用条件: `AbstractHttpAdapter` のデフォルト実装（`use()`, `get()` 等）を具象クラスがオーバーライドする構造
  - コード例: `packages/core/adapters/http-adapter.ts:22-24`（`use()` のデフォルト委譲）, `packages/platform-fastify/adapters/fastify-adapter.ts:733-741`（Fastify のオーバーライド）
  - 注意点: デフォルト実装が `this.instance` に直接委譲するため、`instance` の API が異なる Fastify では大半をオーバーライドする必要がある

- **Proxy パターン** (分類: 構造)
  - 解決する問題: `NestApplication` にプラットフォーム固有のメソッドを動的に追加する
  - 適用条件: コンパイル時に不明なメソッドを実行時に委譲する必要がある場合
  - コード例: `packages/core/nest-factory.ts:344-371`
  - 注意点: 型安全性は別途インターフェース定義（`NestExpressApplication` 等）で担保する必要がある

## Good Patterns

- **デフォルト値付きジェネリクスによる段階的型特殊化**: `AbstractHttpAdapter<TServer = any, TRequest = any, TResponse = any>` のようにデフォルト型を `any` にすることで、型を気にしない利用者はそのまま使え、厳密な型が必要な利用者はジェネリクスで指定できる。Fastify アダプターの 6 つの型パラメータもすべてデフォルト値を持つ。

```typescript
// packages/platform-fastify/adapters/fastify-adapter.ts:124-142
export class FastifyAdapter<
  TServer extends RawServerBase = RawServerDefault,
  TRawRequest extends FastifyRawRequest<TServer> = FastifyRawRequest<TServer>,
  TRawResponse extends RawReplyDefaultExpression<TServer> =
    RawReplyDefaultExpression<TServer>,
  // ...
> extends AbstractHttpAdapter<TServer, TRequest, TReply> {
```

- **`getType()` による型識別子パターン**: 各アダプターが `getType(): string` で文字列識別子（`'express'`, `'fastify'`）を返す。ただしコア層ではこれを条件分岐に使わず、テストやデバッグ用途に限定している。これにより Open-Closed Principle を維持している。

```typescript
// packages/platform-express/adapters/express-adapter.ts:341-343
public getType(): string {
  return 'express';
}
```

- **ミドルウェアキューによる初期化順序の吸収**: Fastify アダプターは `middie` プラグイン登録前の `use()` 呼び出しをキューに蓄積し、`init()` 時に一括登録する。プラットフォームごとの初期化順序の違いを利用者に意識させない設計。

```typescript
// packages/platform-fastify/adapters/fastify-adapter.ts:304-317
public async init() {
  if (this.isMiddieRegistered) {
    return;
  }
  await this.registerMiddie();
  if (this.pendingMiddlewares.length > 0) {
    for (const { args } of this.pendingMiddlewares) {
      (this.instance.use as any)(...args);
    }
    this.pendingMiddlewares = [];
  }
}
```

- **`loadPackage` による明確な失敗**: オプショナル依存が未インストールの場合、暗黙の失敗ではなく即座にエラーメッセージとプロセス終了で知らせる。

```typescript
// packages/common/utils/load-package.util.ts:8-20
export function loadPackage(
  packageName: string,
  context: string,
  loaderFn?: Function,
) {
  try {
    return loaderFn ? loaderFn() : require(packageName);
  } catch (e) {
    logger.error(MISSING_REQUIRED_DEPENDENCY(packageName, context));
    Logger.flush();
    process.exit(1);
  }
}
```

## Anti-Patterns / 注意点

- **抽象クラスのデフォルト実装が特定プラットフォームに偏る問題**: `AbstractHttpAdapter` のデフォルト実装は `this.instance.get()`, `this.instance.post()` 等に直接委譲しており、これは Express の API を前提としている。Fastify はルーティング API が異なるため、`get()`, `post()` 等をすべてオーバーライドして `injectRouteOptions()` 経由にする必要がある。

```typescript
// Bad: デフォルト実装が Express API を前提
// packages/core/adapters/http-adapter.ts:28-30
public get(...args: any[]) {
  return this.instance.get(...args);
}

// Better: 各アダプターが明示的に実装を提供
// packages/platform-fastify/adapters/fastify-adapter.ts:352-354
public get(...args: any[]) {
  return this.injectRouteOptions('GET', ...args);
}
```

- **プラットフォーム固有の内部コピー（fork）による保守コスト**: `@fastify/middie` を fork して `packages/platform-fastify/adapters/middie/fastify-middie.ts`（431行）に内部コピーしている。セキュリティ修正のためだが、上流の変更追従コストが発生する。外部依存を fork する場合は、差分を最小に保つか、上流に修正を提案すべき。

## 導出ルール

- `[MUST]` プラットフォームアダプターの契約はインターフェースで定義し、共通実装は抽象クラスで提供する（インターフェースのみでは重複コードが増え、抽象クラスのみでは契約が実装に依存する）
  - 根拠: NestJS は `HttpServer` インターフェース + `AbstractHttpAdapter` 抽象クラスの三層構造で、コア層の安定性と実装の共通化を両立している（`packages/common/interfaces/http/http-server.interface.ts`, `packages/core/adapters/http-adapter.ts`）

- `[MUST]` アダプター間の差異はアダプター内部で吸収し、コア層にプラットフォーム条件分岐を持ち込まない
  - 根拠: `NestApplication`, `BaseExceptionFilter` 等のコア層は `HttpServer` インターフェースのみを参照し、`getType()` による条件分岐を行わない（`packages/core/nest-application.ts:75`, `packages/core/exceptions/base-exception-filter.ts:24`）

- `[SHOULD]` プラットフォーム固有 API へのアクセスは型付きの脱出口（platform-specific interface）で提供する
  - 根拠: `NestExpressApplication` / `NestFastifyApplication` が `INestApplication` を拡張し、`set()`, `register()` 等のプラットフォーム固有メソッドを型安全に公開している（`packages/platform-express/interfaces/nest-express-application.interface.ts`, `packages/platform-fastify/interfaces/nest-fastify-application.interface.ts`）

- `[SHOULD]` オプショナルなプラットフォーム依存は遅延ロード + 明確なエラーメッセージで解決する（暗黙の失敗やフォールバックではなく、未インストール時に即座に原因を通知する）
  - 根拠: `loadPackage()` は `try/catch` で require し、失敗時にパッケージ名と利用コンテキストを含むエラーメッセージを出力して `process.exit(1)` する（`packages/common/utils/load-package.util.ts:8-20`）

- `[SHOULD]` 抽象メソッドの実装は各プラットフォームのネイティブなパラダイムに合わせる（共通の実装パターンを強制しない）
  - 根拠: `applyVersionFilter()` は Express ではミドルウェアラッパー、Fastify ではルーター制約として実装されており、同一インターフェースでも最適な実装戦略が異なることを許容している

- `[AVOID]` 抽象クラスのデフォルト実装を特定プラットフォームの API に偏らせること（他のプラットフォームで大半のメソッドをオーバーライドする必要が生じる）
  - 根拠: `AbstractHttpAdapter` の `get()`, `post()` 等のデフォルト実装は `this.instance.get()` に委譲しているが、Fastify では API が異なるためすべてオーバーライドが必要になっている

## 適用チェックリスト

- [ ] プラットフォーム抽象化の契約がインターフェースとして定義されているか（抽象クラスのみに依存していないか）
- [ ] 各アダプターがインターフェースの全メソッドを実装しているか（抽象クラスのデフォルト実装に暗黙的に依存していないか確認）
- [ ] コア層にプラットフォーム固有の条件分岐（`if (type === 'xxx')`）が存在しないか
- [ ] プラットフォーム固有の機能にアクセスするための型付き脱出口が用意されているか
- [ ] オプショナル依存のロード失敗時に、原因が明確なエラーメッセージで通知されるか
- [ ] 新しいプラットフォームを追加する際に、コア層のコード変更が不要か（Open-Closed Principle）
- [ ] 各アダプターの実装がそのプラットフォームのネイティブなパラダイムを活かしているか（無理に共通パターンを強制していないか）
