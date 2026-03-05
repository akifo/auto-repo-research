# middleware-composition

> リポジトリ: nestjs/nest
> 分析日: 2026-03-03

## 概要

NestJS のミドルウェアシステムは、Express/Fastify の低レベルミドルウェア機構の上に、モジュールスコープ・ルートスコープ・DI 統合を加えた高レベルの抽象層を構築している。クラスベースと関数ベースの両方をサポートしつつ、fluent API による宣言的な登録・除外・ルートバインディングの仕組みを提供する点が特徴的である。ミドルウェアの実行順序がモジュールの依存グラフ（トポロジカルソート）によって決定される設計は、暗黙の実行順序問題を構造的に解決するアプローチとして注目に値する。

## 背景にある原則

- **宣言的登録による実行順序の可視化**: ミドルウェアの登録を `configure(consumer)` メソッドのフルーエントチェーンで行い、「何を」「どのルートに」「何を除外して」適用するかを一箇所で宣言的に記述させる。命令的に `app.use()` を散在させる方式と比較して、ミドルウェアの適用範囲が自己文書化される（根拠: `packages/common/interfaces/middleware/middleware-consumer.interface.ts`, `MiddlewareConfigProxy` インターフェース）。

- **モジュール境界によるミドルウェアスコープの暗黙的制御**: ミドルウェアはモジュール単位で登録され、実行順序はモジュールの依存グラフ上の距離（depth）で決定される。グローバルモジュールは常に最優先で実行される。これにより、ミドルウェアの順序を数値で明示する必要がなく、モジュール構造自体が順序を表現する（根拠: `packages/core/middleware/middleware-module.ts:149-166` のソート、`packages/core/injector/topology-tree/topology-tree.ts` の distance 計算）。

- **関数ミドルウェアをクラスに正規化してDI統合する**: 関数ミドルウェアは内部でクラスにラップ（`mapToClass`）され、クラスミドルウェアと統一的に扱われる。これにより、DI コンテナ・例外フィルタ・ライフサイクル管理を一本化できる。「二つの世界」を内部的に一つに統一するパターンである（根拠: `packages/core/middleware/utils.ts:57-98`）。

- **プロキシパターンによるクロスカッティング関心事の透過的注入**: ミドルウェアの実行は直接呼び出しではなく `RouterProxy` を介した例外ハンドリングプロキシでラップされる。ミドルウェア実装者は例外処理を意識する必要がなく、フレームワーク側がそれを一貫して処理する（根拠: `packages/core/router/router-proxy.ts:10-28`, `packages/core/middleware/middleware-module.ts:303-315`）。

## 実例と分析

### ミドルウェア登録の Fluent API 設計

`MiddlewareBuilder` は Builder パターンと Fluent Interface を組み合わせている。`apply()` が `MiddlewareConfigProxy` を返し、`forRoutes()` が `MiddlewareConsumer`（= Builder 自身）を返すことで、チェーンの切り替えが自然に行われる。

```typescript
// packages/core/middleware/builder.ts:17-34
export class MiddlewareBuilder implements MiddlewareConsumer {
  private readonly middlewareCollection = new Set<MiddlewareConfiguration>();

  public apply(
    ...middleware: Array<Type<any> | Function | Array<Type<any> | Function>>
  ): MiddlewareConfigProxy {
    return new MiddlewareBuilder.ConfigProxy(
      this,
      middleware.flat(),
      this.routeInfoPathExtractor,
    );
  }

  public build(): MiddlewareConfiguration[] {
    return [...this.middlewareCollection];
  }
}
```

ポイントは `ConfigProxy` が `MiddlewareBuilder` の内部静的クラスとして定義されている点である。`forRoutes()` が Builder に戻ることで、複数のミドルウェアチェーンを一つの `configure()` 内で連鎖的に定義できる。

### 関数ミドルウェアのクラスラッピング

`mapToClass` は関数ミドルウェアをクラスベースのミドルウェアに変換する。ここでの注目点は、除外ルートの処理をラッピング時に注入している設計である。

```typescript
// packages/core/middleware/utils.ts:57-98
export const mapToClass = <T extends Function | Type<any>>(
  middleware: T,
  excludedRoutes: ExcludeRouteMetadata[],
  httpAdapter: HttpServer,
) => {
  if (isMiddlewareClass(middleware)) {
    if (excludedRoutes.length <= 0) {
      return middleware;
    }
    const MiddlewareHost = class extends middleware {
      use(...params: unknown[]) {
        const [req, _, next] = params as [Record<string, any>, any, Function];
        const isExcluded = isMiddlewareRouteExcluded(
          req,
          excludedRoutes,
          httpAdapter,
        );
        if (isExcluded) {
          return next();
        }
        return super.use(...params);
      }
    };
    return assignToken(MiddlewareHost, middleware.name);
  }
  return assignToken(
    class {
      use = (...params: unknown[]) => {
        const [req, _, next] = params as [Record<string, any>, any, Function];
        const isExcluded = isMiddlewareRouteExcluded(
          req,
          excludedRoutes,
          httpAdapter,
        );
        if (isExcluded) {
          return next();
        }
        return (middleware as Function)(...params);
      };
    },
  );
};
```

関数をクラスでラップする際に、除外ロジックをデコレータ的に `use()` メソッドの前段に注入している。クラスミドルウェアの場合は継承 + `super.use()` で、関数ミドルウェアの場合はクロージャでキャプチャする。

### モジュール依存グラフに基づく実行順序

ミドルウェアの登録順序は、モジュールの依存関係の深さ（distance）をキーとしたソートで決定される。

```typescript
// packages/core/middleware/middleware-module.ts:149-166
const entriesSortedByDistance = [...configs.entries()].sort(
  ([moduleA], [moduleB]) => {
    const moduleARef = this.container.getModuleByKey(moduleA)!;
    const moduleBRef = this.container.getModuleByKey(moduleB)!;
    const isModuleAGlobal = moduleARef.distance === Number.MAX_VALUE;
    const isModuleBGlobal = moduleBRef.distance === Number.MAX_VALUE;
    if (isModuleAGlobal && isModuleBGlobal) {
      return 0;
    }
    if (isModuleAGlobal) {
      return -1;
    }
    if (isModuleBGlobal) {
      return 1;
    }
    return moduleARef.distance - moduleBRef.distance;
  },
);
```

`@Global()` モジュールは `distance = Number.MAX_VALUE` が割り当てられ、ソートで常に先頭に来る（`-1` を返す）。非グローバルモジュールは `TopologyTree` がBFS的に算出した深さの昇順で並ぶ。

```typescript
// packages/core/injector/topology-tree/topology-tree.ts:17-23
public walk(callback: (value: Module, depth: number) => void) {
  function walkNode(node: TreeNode<Module>, depth = 1) {
    callback(node.value, depth);
    node.children.forEach(child => walkNode(child, depth + 1));
  }
  walkNode(this.root);
}
```

### スコープ対応の動的インジェクション

`bindHandler` メソッドは、ミドルウェアの依存ツリーがすべて静的（シングルトン）か否かで挙動を分岐させる。

```typescript
// packages/core/middleware/middleware-module.ts:245-301
private async bindHandler(wrapper, applicationRef, routeInfo, moduleRef, collection) {
  const { instance, metatype } = wrapper;
  if (isUndefined(instance?.use)) {
    throw new InvalidMiddlewareException(metatype!.name);
  }
  const isStatic = wrapper.isDependencyTreeStatic();
  if (isStatic) {
    const proxy = await this.createProxy(instance);
    return this.registerHandler(applicationRef, routeInfo, proxy);
  }
  // リクエストスコープの場合はリクエストごとにインスタンスを解決する
  await this.registerHandler(applicationRef, routeInfo,
    async (req, res, next) => {
      const contextId = this.getContextId(req, isTreeDurable);
      const contextInstance = await this.injector.loadPerContext(
        instance, moduleRef, collection, contextId,
      );
      const proxy = await this.createProxy(contextInstance, contextId);
      return proxy(req, res, next);
    },
  );
}
```

静的な場合はプロキシを一度だけ生成してキャッシュし、リクエストスコープの場合はリクエストごとに `loadPerContext` で新しいインスタンスを解決する。このパターンにより、シングルトン時のパフォーマンスを維持しつつ、リクエストスコープの柔軟性も提供する。

### HTTP アダプタ抽象によるプラットフォーム非依存性

`createMiddlewareFactory` メソッドは `HttpServer` インターフェースに定義され、Express と Fastify で異なる実装を持つ。

```typescript
// packages/platform-express/adapters/express-adapter.ts:272-280
public createMiddlewareFactory(requestMethod: RequestMethod) {
  return (path: string, callback: Function) => {
    const convertedPath = LegacyRouteConverter.tryConvert(path);
    return this.routerMethodFactory
      .get(this.instance, requestMethod)
      .call(this.instance, convertedPath, callback);
  };
}
```

Express では同期的にファクトリを返すが、Fastify では `@fastify/middie` プラグインの遅延登録が必要なため非同期になっている（`packages/platform-fastify/adapters/fastify-adapter.ts:672-674`）。ミドルウェアモジュール側は `await` で受けることで両方に対応している。

## パターンカタログ

- **Builder パターン** (分類: 生成)
  - 解決する問題: 複数のミドルウェア設定を段階的に構築する必要がある
  - 適用条件: 設定項目が多く、異なる組み合わせが必要な場合
  - コード例: `packages/core/middleware/builder.ts:17-34`
  - 注意点: `build()` の戻り値は設定の配列であり、実行はまだ行われない（遅延評価）

- **Proxy パターン** (分類: 構造)
  - 解決する問題: ミドルウェア実行に例外ハンドリングを透過的に追加する
  - 適用条件: クロスカッティング関心事をコールバックの前後に追加したい場合
  - コード例: `packages/core/router/router-proxy.ts:10-28`
  - 注意点: プロキシの多重ラップはスタックトレースの追跡を困難にする

- **Adapter パターン** (分類: 構造)
  - 解決する問題: 関数ミドルウェアをクラスベースのDI対応インターフェースに統合する
  - 適用条件: 二つの異なるインターフェースを統一的に扱いたい場合
  - コード例: `packages/core/middleware/utils.ts:57-98`（`mapToClass`）
  - 注意点: 変換時にトークン（名前）を付与しないとDIコンテナで識別できなくなる

## Good Patterns

- **Fluent API で登録と適用範囲を一体化する**: `apply().exclude().forRoutes()` のチェーンにより、ミドルウェアの定義・除外・適用先が一つの式で完結する。分散した設定ファイルや別の登録機構を参照する必要がない。

```typescript
// integration/hello-world/e2e/exclude-middleware.spec.ts:70-86
consumer
  .apply((req, res, next) => res.send(MIDDLEWARE_VALUE))
  .exclude(
    "test",
    "overview/:id",
    "wildcard/*",
    { path: "middleware", method: RequestMethod.POST },
  )
  .exclude("multiple/exclude")
  .forRoutes("*path");
```

- **コントローラクラス参照によるルートスコープ**: 文字列パスではなくコントローラクラスを `forRoutes()` に渡すことで、そのコントローラの全ルートに自動的にミドルウェアが適用される。パスのハードコーディングを避け、コントローラのリファクタリングに対して堅牢になる。

```typescript
// integration/inspector/src/core/core.module.ts:14-18
export class CoreModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(LoggerMiddleware).forRoutes(CatsController);
  }
}
```

- **静的/動的ツリーの判定によるパフォーマンス最適化**: ミドルウェアの依存ツリーがすべてシングルトンなら一度だけプロキシを生成し、リクエストスコープの依存があれば毎回インスタンスを解決する。呼び出し側がスコープを意識せずに使える。

## Anti-Patterns / 注意点

- **ミドルウェアの登録順序に暗黙の依存を持たせる**: 同一モジュール内の `apply().forRoutes()` は記述順に登録されるが、モジュール間では依存グラフの距離で決まる。同じルートに複数のミドルウェアを登録して先に `res.send()` するものが勝つ設計は、実行順序への暗黙の依存を生む。

```typescript
// Bad: 最初にマッチしたミドルウェアが応答を返してしまい、後続が実行されない
consumer
  .apply((req, res, next) => res.send("A"))
  .forRoutes("*")
  .apply((req, res, next) => res.send("B")) // 到達しない
  .forRoutes("*");

// Better: next() を呼んでチェーンを維持する
consumer
  .apply((req, res, next) => {
    req.tag = "A";
    next();
  })
  .forRoutes("*")
  .apply((req, res, next) => res.send(req.tag))
  .forRoutes("*");
```

- **`use()` メソッドを持たないクラスをミドルウェアとして登録する**: NestJS は `instance.use` の存在を実行時にチェックし、なければ `InvalidMiddlewareException` を投げる。インターフェース準拠のコンパイル時チェックだけでは不十分で、DI 解決後の実体が `use` を持っているかが重要である。

```typescript
// Bad: @Injectable() だけではミドルウェアにならない
@Injectable()
class InvalidMiddleware {} // use() メソッドがない

// Better: NestMiddleware を implements して型安全にする
@Injectable()
class ValidMiddleware implements NestMiddleware {
  use(req: any, res: any, next: () => void) {
    next();
  }
}
```

## 導出ルール

- `[MUST]` ミドルウェアの登録 API は「何を」「どこに」「何を除外して」適用するかを一つの式で表現できるようにする
  - 根拠: NestJS の `apply().exclude().forRoutes()` チェーンは、ミドルウェアの適用範囲を自己文書化し、設定の散在を防止している（`packages/core/middleware/builder.ts:26-34`, `ConfigProxy` の `forRoutes` が Builder を返す設計）

- `[MUST]` 関数型とクラス型のミドルウェアを受け入れる場合、内部で統一的な形式に正規化してからパイプラインに流す
  - 根拠: `mapToClass` が関数ミドルウェアをクラスに変換し、除外ロジックも統一的に注入することで、後続の DI 解決・プロキシ生成・例外処理が単一のコードパスで処理できている（`packages/core/middleware/utils.ts:44-98`）

- `[SHOULD]` ミドルウェアの実行順序を明示的な数値ではなく、モジュール/依存関係の構造から導出する
  - 根拠: NestJS はモジュール依存グラフの深さ（distance）でソートし、`@Global()` モジュールは `MAX_VALUE` で常に先頭に来る。数値ベースの `order` プロパティと比較して、構造変更時に順序が自動的に追従する（`packages/core/middleware/middleware-module.ts:149-166`）

- `[SHOULD]` ミドルウェア実行をプロキシでラップし、例外ハンドリングをミドルウェア実装者から分離する
  - 根拠: `RouterProxy.createProxy` がすべてのミドルウェア呼び出しを `try/catch` でラップし、`ExceptionsHandler` に委譲している。ミドルウェア実装者は自前で例外を処理する必要がない（`packages/core/router/router-proxy.ts:10-28`）

- `[SHOULD]` ミドルウェアのルートバインディングで文字列パスだけでなくコントローラクラス参照を受け付け、リフレクションでルートを自動解決する
  - 根拠: `RoutesMapper.getRouteInfoFromController` がコントローラのメタデータからルートを自動抽出し、パスのハードコーディングを排除している（`packages/core/middleware/routes-mapper.ts:73-123`）

- `[AVOID]` ミドルウェアのチェーン中で応答を返す（`res.send()` / `res.end()`）ミドルウェアと `next()` を呼ぶミドルウェアを混在させる際に、実行順序への暗黙の依存を作る
  - 根拠: 統合テスト `middleware-execute-order.spec.ts` が示すように、応答を返すミドルウェアが先に実行されると後続のミドルウェアは到達不能になる。モジュール間の実行順序はトポロジカルソートで決まるため、登録順序の直感と一致しない場合がある

## 適用チェックリスト

- [ ] ミドルウェアの登録 API が apply/route/exclude を一つの式で宣言的に記述できるか確認する
- [ ] 関数型ミドルウェアとクラス型ミドルウェアの両方を受け入れる場合、内部で統一形式に正規化する変換層を設けているか
- [ ] ミドルウェアの実行順序が暗黙的な登録順序ではなく、構造的な基準（モジュール依存、優先度グループなど）で決定されるか
- [ ] ミドルウェア実行時の例外がフレームワーク側で一貫してキャッチ・処理され、ミドルウェア実装者が個別に try/catch する必要がないか
- [ ] プラットフォーム固有のミドルウェア登録（Express の `app.use` vs Fastify の middie）がアダプタ層で抽象化されているか
- [ ] リクエストスコープのミドルウェアとシングルトンのミドルウェアを同一のパイプラインで透過的に扱えるか
