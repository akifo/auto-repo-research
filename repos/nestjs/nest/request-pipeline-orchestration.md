# request-pipeline-orchestration

> リポジトリ: nestjs/nest
> 分析日: 2026-03-03

## 概要

NestJS のリクエスト処理は Guards -> Interceptors -> Pipes -> Handler -> Exception Filters の固定順序パイプラインで構成される。各ステージは同一の `ContextCreator` 基底クラスを継承し、メタデータの3層合成（グローバル -> クラス -> メソッド）を統一的に行う。さらに `ExecutionContextHost` が HTTP/RPC/WebSocket の差異を吸収し、全パイプラインコンポーネントがトランスポートを意識せず動作する設計になっている。この「固定順序 + 統一コンテキスト + 3層合成」の組み合わせは、フレームワーク設計における汎用的なパイプラインオーケストレーションパターンとして注目に値する。

## 背景にある原則

- **関心の分離を実行順序で強制する**: 認可（Guards）、横断的処理（Interceptors）、入力変換・検証（Pipes）、ビジネスロジック（Handler）、エラー処理（Exception Filters）を別々のレイヤーに分け、実行順序をフレームワーク側で固定することで、開発者が順序を誤る余地を排除している。順序が開発者の設定次第で変わると、たとえば「バリデーション前に認可を通過してしまう」といった脆弱性が生まれうる。
  - 根拠: `RouterExecutionContext.create()` (`packages/core/router/router-execution-context.ts:80-174`) で Guards -> Interceptors(内部に Pipes + Handler を包含) の呼び出し順が宣言的に固定されている

- **コンテキスト抽象でトランスポート非依存を実現する**: `ArgumentsHost` / `ExecutionContext` インターフェースが HTTP/RPC/WebSocket の引数アクセスを `switchToHttp()` / `switchToRpc()` / `switchToWs()` で切り替え可能にし、同一の Guard や Interceptor がトランスポートをまたいで再利用できる。プロトコル固有の詳細はコンテキストの内側に閉じ込め、パイプラインコンポーネントのインターフェースはプロトコルに依存しない。
  - 根拠: `ExecutionContextHost` (`packages/core/helpers/execution-context-host.ts:10-65`) と `CanActivate` / `NestInterceptor` / `PipeTransform` のインターフェース定義

- **メタデータ駆動の3層合成でスコープ制御を統一する**: グローバル・クラス・メソッドの3階層でデコレータメタデータを収集し、結合する処理を `ContextCreator` 基底クラスに一元化している。各パイプラインコンポーネント（Guards/Interceptors/Pipes/ExceptionFilters）は `createConcreteContext` の実装だけを差し替えればよく、メタデータ収集ロジックの重複を排除している。
  - 根拠: `ContextCreator.createContext()` (`packages/core/helpers/context-creator.ts:16-41`) が `globalMetadata` + `classMetadata` + `methodMetadata` を順番に結合する

- **短絡評価で不要な処理コストを回避する**: Guards/Pipes/Interceptors が空配列の場合、対応する関数を `null` にして呼び出し自体をスキップする。高頻度で呼ばれるリクエスト処理パスでは、空チェック+関数呼び出しの繰り返しより、事前に null を返して `&&` 演算子で短絡させるほうが効率的である。
  - 根拠: `createGuardsFn` が `guards.length ? canActivateFn : null` を返す (`router-execution-context.ts:375`)、呼び出し側の `fnCanActivate && (await fnCanActivate([req, res, next]))` (`router-execution-context.ts:159`)

## 実例と分析

### パイプライン実行順序の固定

`RouterExecutionContext.create()` がリクエスト処理の実行関数を組み立てる。この関数の内部構造がパイプラインの実行順序を決定している。

```typescript
// packages/core/router/router-execution-context.ts:153-174
return async <TRequest, TResponse>(
  req: TRequest,
  res: TResponse,
  next: Function,
) => {
  const args = this.contextUtils.createNullArray(argsLength);
  fnCanActivate && (await fnCanActivate([req, res, next])); // 1. Guards

  this.responseController.setStatus(res, httpStatusCode);
  hasCustomHeaders
    && this.responseController.setHeaders(res, responseHeaders);

  const result = await this.interceptorsConsumer.intercept( // 2. Interceptors
    interceptors,
    [req, res, next],
    instance,
    callback,
    handler(args, req, res, next), // handler 内部で 3. Pipes -> 4. Handler
    contextType,
  );
  await (fnHandleResponse as HandlerResponseBasicFn)(result, res, req);
};
```

Guards が失敗すると `ForbiddenException` が throw されるため、後続の Interceptors/Pipes/Handler は実行されない。Interceptors は `handler` をラップする形で実行され、`handler` の内部で Pipes -> Handler の順に実行される。

### ContextCreator による統一的なメタデータ3層合成

Guards, Interceptors, Pipes, Exception Filters の4つのコンテキストクリエータはすべて同じ `ContextCreator` 基底クラスを継承する。

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
      globalMetadata || ([] as unknown[] as T),
      contextId, inquirerId,
    ),
    ...this.createConcreteContext<T, R>(classMetadata, contextId, inquirerId),
    ...this.createConcreteContext<T, R>(methodMetadata, contextId, inquirerId),
  ] as R;
}
```

グローバル -> クラス -> メソッドの順に結合されるため、実行順序はこの並びに従う。`GuardsContextCreator`, `InterceptorsContextCreator`, `PipesContextCreator`, `BaseExceptionFilterContext` はすべてこのパターンを踏襲し、差分は `createConcreteContext` と `getGlobalMetadata` の実装のみである。

### トランスポート横断のコンテキスト抽象

`ExecutionContextHost` は引数を位置ベースの配列で保持し、`switchToHttp()` / `switchToRpc()` / `switchToWs()` でプロトコル固有のアクセサを動的に付与する。

```typescript
// packages/core/helpers/execution-context-host.ts:43-64
switchToRpc(): RpcArgumentsHost {
  return Object.assign(this, {
    getData: () => this.getArgByIndex(0),
    getContext: () => this.getArgByIndex(1),
  });
}

switchToHttp(): HttpArgumentsHost {
  return Object.assign(this, {
    getRequest: () => this.getArgByIndex(0),
    getResponse: () => this.getArgByIndex(1),
    getNext: () => this.getArgByIndex(2),
  });
}

switchToWs(): WsArgumentsHost {
  return Object.assign(this, {
    getClient: () => this.getArgByIndex(0),
    getData: () => this.getArgByIndex(1),
    getPattern: () => this.getArgByIndex(this.getArgs().length - 1),
  });
}
```

HTTP の `RouterExecutionContext`, RPC の `RpcContextCreator`, WebSocket の `WsContextCreator` が同じ `GuardsConsumer`, `InterceptorsConsumer`, `PipesConsumer` を使い回している。トランスポートごとの差異は `contextType` 文字列のセットと Proxy クラス（`RouterProxy`, `RpcProxy`, `WsProxy`）に閉じ込められている。

### Interceptor チェーンの再帰的 Observable 合成

`InterceptorsConsumer.intercept()` は Interceptor の配列を再帰関数 `nextFn` で走査し、rxjs の `defer` + `mergeAll` で遅延評価チェーンを構築する。

```typescript
// packages/core/interceptors/interceptors-consumer.ts:28-38
const nextFn = async (i = 0) => {
  if (i >= interceptors.length) {
    return defer(AsyncResource.bind(() => this.transformDeferred(next)));
  }
  const handler: CallHandler = {
    handle: () => defer(AsyncResource.bind(() => nextFn(i + 1))).pipe(mergeAll()),
  };
  return interceptors[i].intercept(context, handler);
};
```

各 Interceptor は `CallHandler.handle()` を呼ぶことで次の Interceptor（または最終ハンドラ）に制御を渡す。`AsyncResource.bind` により Node.js の AsyncLocalStorage コンテキストがチェーン全体で保持される。この設計により、Interceptor はレスポンスストリームを Observable として変換・監視でき、ログ記録やキャッシュ、タイムアウト制御といった横断的関心事を宣言的に挿入できる。

### Exception Filter による安全な境界

`RouterProxy.createProxy()` がパイプライン全体を try-catch で囲み、`ExceptionsHandler.next()` に委譲する。

```typescript
// packages/core/router/router-proxy.ts:13-28
public createProxy(
  targetCallback: RouterProxyCallback,
  exceptionsHandler: ExceptionsHandler,
) {
  return async <TRequest, TResponse>(
    req: TRequest, res: TResponse, next: () => void,
  ) => {
    try {
      await targetCallback(req, res, next);
    } catch (e) {
      const host = new ExecutionContextHost([req, res, next]);
      exceptionsHandler.next(e, host);
      return res;
    }
  };
}
```

Exception Filter はパイプラインの「外殻」として動作し、Guards/Interceptors/Pipes/Handler のいずれで発生した例外もキャッチする。`ExceptionsHandler.next()` はカスタムフィルタを優先的に試行し、該当しなければ `BaseExceptionFilter.catch()` にフォールバックする (`packages/core/exceptions/exceptions-handler.ts:12-17`)。RPC/WS でも同じ構造が `RpcProxy` / `WsProxy` で再現されている。

### Pipe の2段階スコープ（ルートレベル + パラメータレベル）

Pipes は他のコンポーネントと異なり、ルートレベル（`@UsePipes()` デコレータ）とパラメータレベル（`@Body(ValidationPipe)` のようにパラメータデコレータに直接渡す）の2段階で適用される。

```typescript
// packages/core/router/router-execution-context.ts:400-407
args[index] = this.isPipeable(type)
  ? await this.getParamValue(
    value,
    { metatype, type, data } as any,
    pipes.concat(paramPipes), // ルートレベル pipes + パラメータレベル paramPipes
  )
  : value;
```

`pipes.concat(paramPipes)` により、ルートレベルの Pipe が先に実行され、その結果がパラメータレベルの Pipe に渡される。さらに `isPipeable()` で `BODY`, `QUERY`, `PARAM`, `FILE` 等のパイプ対象パラメータタイプのみにフィルタリングしている。

## パターンカタログ

- **Chain of Responsibility** (分類: 振る舞い)
  - 解決する問題: リクエスト処理の各関心事（認可、変換、横断処理、エラー処理）を独立したハンドラとして連鎖させ、各ハンドラが処理を続行するか中断するかを決定する
  - 適用条件: 複数の処理ステップが固定順序で実行され、各ステップが独立して成否を判断する場合
  - コード例: `GuardsConsumer.tryActivate()` (`packages/core/guards/guards-consumer.ts:8-35`) — guards 配列を順次走査し、いずれかが false を返した時点でチェーン全体を中断
  - 注意点: NestJS では「処理順序の決定をフレームワーク側に固定」しており、典型的な CoR のように各ハンドラが次のハンドラを自由に決定するのではない。これにより予測可能性が向上している

- **Template Method** (分類: 振る舞い)
  - 解決する問題: メタデータ収集・合成のアルゴリズム骨格を基底クラスで定義し、具体的なインスタンス化ロジックをサブクラスに委ねる
  - 適用条件: 同一のアルゴリズム構造を共有しつつ、特定のステップだけが異なるクラス群が存在する場合
  - コード例: `ContextCreator.createContext()` (`packages/core/helpers/context-creator.ts:16-41`) が骨格、`GuardsContextCreator.createConcreteContext()` (`packages/core/guards/guards-context-creator.ts:39-56`) が具体実装
  - 注意点: `getGlobalMetadata` はオプショナルメソッドとして定義されており、Template Method の厳密なパターンからは若干逸脱している

- **Decorator (Wrapper)** (分類: 構造)
  - 解決する問題: ハンドラの前後に透過的に処理を挿入し、ハンドラ自体を変更せずに機能を追加する
  - 適用条件: リクエスト/レスポンスの変換、ログ記録、キャッシュなど、ハンドラに対する横断的関心事を追加する場合
  - コード例: `InterceptorsConsumer.intercept()` (`packages/core/interceptors/interceptors-consumer.ts:14-39`) — `CallHandler.handle()` を介してハンドラをラップし、Observable ストリームとして前後処理を挿入
  - 注意点: rxjs の `defer` + `mergeAll` による遅延評価が必要。同期的なラップでは Observable チェーンが正しく動作しない

## Good Patterns

- **Null 関数による短絡最適化**: パイプラインの各ステージで、コンポーネントが空の場合に関数を `null` にして `&&` で呼び出しをスキップする。これにより、デコレータを使わないシンプルなルートでは不要なオーバーヘッドがゼロになる。

```typescript
// packages/core/router/router-execution-context.ts:357-376
public createGuardsFn<TContext extends string = ContextType>(
  guards: CanActivate[],
  instance: Controller,
  callback: (...args: any[]) => any,
  contextType?: TContext,
): ((args: any[]) => Promise<void>) | null {
  const canActivateFn = async (args: any[]) => {
    const canActivate = await this.guardsConsumer.tryActivate<TContext>(
      guards, args, instance, callback, contextType,
    );
    if (!canActivate) {
      throw new ForbiddenException(FORBIDDEN_MESSAGE);
    }
  };
  return guards.length ? canActivateFn : null;  // 空なら null を返す
}
```

- **Handler メタデータキャッシュ**: `HandlerMetadataStorage` がコントローラ+メソッド名をキーにメタデータをキャッシュし、同一ルートへの2回目以降のリクエストで Reflect.getMetadata の呼び出しを省略する。

```typescript
// packages/core/helpers/handler-metadata-storage.ts:43-57
export class HandlerMetadataStorage<TValue = HandlerMetadata, TKey extends Type<unknown> = any> {
  private readonly [HANDLER_METADATA_SYMBOL] = new Map<string, TValue>();

  set(controller: TKey, methodName: string, metadata: TValue) {
    const metadataKey = this.getMetadataKey(controller, methodName);
    this[HANDLER_METADATA_SYMBOL].set(metadataKey, metadata);
  }

  get(controller: TKey, methodName: string): TValue | undefined {
    const metadataKey = this.getMetadataKey(controller, methodName);
    return this[HANDLER_METADATA_SYMBOL].get(metadataKey);
  }
}
```

- **Exception Filter の型マッチングによるフォールバック**: `selectExceptionFilterMetadata` が `@Catch()` デコレータの型引数に基づいて `instanceof` でフィルタを選択し、マッチしないものは `BaseExceptionFilter` にフォールバックする。`exceptionMetatypes` が空配列のフィルタはすべての例外にマッチするワイルドカードとして機能する。

```typescript
// packages/common/utils/select-exception-filter-metadata.util.ts:3-13
export const selectExceptionFilterMetadata = <T = any>(
  filters: ExceptionFilterMetadata[],
  exception: T,
): ExceptionFilterMetadata | undefined =>
  filters.find(
    ({ exceptionMetatypes }) =>
      !exceptionMetatypes.length // 空 = ワイルドカード
      || exceptionMetatypes.some(
        ExceptionMetaType => exception instanceof ExceptionMetaType,
      ),
  );
```

## Anti-Patterns / 注意点

- **Interceptor 内で CallHandler.handle() を呼び忘れる**: Interceptor が `next.handle()` を呼ばないとパイプラインがそこで停止し、後続の Interceptor やハンドラが実行されず、レスポンスが返らない。ミドルウェアの `next()` 呼び忘れと同種の問題だが、Observable ベースのため検出がより困難。

```typescript
// Bad: handle() を呼ばない — レスポンスが返らない
intercept(context: ExecutionContext, next: CallHandler) {
  console.log('Before...');
  return of({ data: 'cached' }); // next.handle() を呼んでいない
}

// Better: handle() を呼んで後続チェーンを実行する
intercept(context: ExecutionContext, next: CallHandler) {
  console.log('Before...');
  return next.handle().pipe(
    map(data => ({ data, timestamp: Date.now() })),
  );
}
```

- **Guard 内でトランスポート固有のコードを直接書く**: `context.switchToHttp().getRequest()` をハードコードすると、その Guard は RPC や WebSocket で再利用できない。Guard の本来の設計意図であるトランスポート非依存性が損なわれる。

```typescript
// Bad: HTTP 固有のコードが Guard に直接埋め込まれている
canActivate(context: ExecutionContext) {
  const request = context.switchToHttp().getRequest();
  return request.headers.authorization === 'valid-token';
}

// Better: トランスポートに応じて分岐する、またはメタデータベースの判定にする
canActivate(context: ExecutionContext) {
  const type = context.getType();
  if (type === 'http') {
    const request = context.switchToHttp().getRequest();
    return this.validateHttp(request);
  } else if (type === 'rpc') {
    const data = context.switchToRpc().getContext();
    return this.validateRpc(data);
  }
  return false;
}
```

- **Pipe のスコープ混同**: ルートレベル Pipe とパラメータレベル Pipe は `concat` で連結される（ルートが先）。両方で同じ変換を適用すると二重変換になる。

```typescript
// Bad: ルートレベルとパラメータレベルの両方に同じ Pipe を適用
@UsePipes(new ValidationPipe())
@Post()
create(@Body(new ValidationPipe()) dto: CreateDto) { ... }
// ValidationPipe が2回実行される

// Better: スコープを明確に分ける
@Post()
create(@Body(new ValidationPipe()) dto: CreateDto) { ... }
```

## 導出ルール

- `[MUST]` リクエストパイプラインの実行順序はフレームワーク側で固定し、利用者が順序を変更できないようにする
  - 根拠: NestJS は Guards -> Interceptors -> Pipes -> Handler -> Exception Filters の順序を `RouterExecutionContext.create()` 内で強制し、認可前にバリデーションが走るといった論理的矛盾を構造的に防止している (`router-execution-context.ts:153-174`)

- `[MUST]` パイプラインコンポーネントが空の場合、呼び出し自体をスキップする短絡パスを設ける
  - 根拠: `createGuardsFn` / `createPipesFn` が空配列に対して `null` を返し、呼び出し側で `fn && (await fn(...))` と短絡評価することで、デコレータ未使用のルートではゼロコストになる (`router-execution-context.ts:375, 411`)

- `[SHOULD]` パイプラインの各ステージに共通するメタデータ収集・合成ロジックは Template Method で基底クラスに一元化する
  - 根拠: `ContextCreator` 基底クラスがグローバル/クラス/メソッドの3層メタデータ合成を定義し、4つのサブクラスは `createConcreteContext` のみを差し替える。これにより約120行のメタデータ収集ロジックの重複が排除されている (`context-creator.ts:16-41`)

- `[SHOULD]` マルチトランスポート対応のパイプラインでは、トランスポート固有の詳細をコンテキストオブジェクト内に閉じ込め、パイプラインコンポーネントのインターフェースはプロトコル非依存にする
  - 根拠: `ExecutionContextHost` の `switchToHttp()` / `switchToRpc()` / `switchToWs()` が同一オブジェクト上にプロトコル固有のアクセサを動的付与し、`CanActivate` / `NestInterceptor` のインターフェースは `ExecutionContext` のみを受け取る (`execution-context-host.ts:43-64`)

- `[SHOULD]` Interceptor チェーンは遅延評価（defer/lazy）で構築し、チェーン内の各 Interceptor が実行タイミングを制御できるようにする
  - 根拠: `InterceptorsConsumer` が rxjs の `defer()` で各ステップを遅延評価し、`CallHandler.handle()` が呼ばれるまで後続の Interceptor もハンドラも実行されない。これによりキャッシュヒット時のハンドラスキップ等が可能になる (`interceptors-consumer.ts:28-38`)

- `[AVOID]` ハンドラメタデータの反復的な Reflect.getMetadata 呼び出し — ルーティング時にメタデータをキャッシュし、リクエスト時に再利用する
  - 根拠: `HandlerMetadataStorage` がコントローラ+メソッド名のキーでメタデータをキャッシュし、2回目以降のリクエストでリフレクション呼び出しを完全にスキップしている (`handler-metadata-storage.ts:43-57`)

## 適用チェックリスト

- [ ] リクエスト処理パイプラインに固定の実行順序を定義しているか（認可 -> 横断処理 -> 入力変換 -> ビジネスロジック -> エラー処理）
- [ ] パイプラインの各ステージが空の場合の短絡パスがあるか（不要なオーバーヘッドを避ける）
- [ ] パイプラインコンポーネント間で共通するメタデータ収集ロジックが基底クラスに一元化されているか
- [ ] パイプラインコンポーネントのインターフェースがトランスポート（HTTP/gRPC/WebSocket 等）に依存していないか
- [ ] Exception Filter がパイプライン全体を外殻として囲んでおり、どのステージの例外もキャッチできるか
- [ ] Interceptor チェーンが遅延評価で構築されており、各 Interceptor が後続の実行をスキップできるか
- [ ] ハンドラメタデータ（デコレータ情報等）がリクエストごとに再計算されず、キャッシュされているか
- [ ] グローバル/クラス/メソッドの3層スコープでパイプラインコンポーネントを適用でき、合成順序が明確に定義されているか
