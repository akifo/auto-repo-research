# error-handling-idioms

> リポジトリ: nestjs/nest
> 分析日: 2026-03-03

## 概要

NestJS の例外処理設計を横断的に分析した。HTTP・RPC・WebSocket の3つのトランスポートにまたがる例外階層と、デコレータ駆動の例外フィルタチェーンという二層構造が特徴的である。注目に値するのは、トランスポートごとに例外基底クラスを分離しつつ、フィルタの選択アルゴリズム（`instanceof` マッチング + 空配列フォールバック）を全トランスポートで共有している点である。この設計は「例外の意味」と「例外の処理方法」を明確に分離し、プロトコル固有の応答形式をフィルタ側に閉じ込めることを可能にしている。

## 背景にある原則

- **例外の型でドメイン意図を表現する原則**: 例外クラスを HTTP ステータスコードと1対1で対応させ、`throw new NotFoundException()` のように投げるだけで適切なレスポンスが生成される。例外にステータスコードやエラーメッセージを埋め込むのではなく、型そのものが意味を持つ設計。根拠: `packages/common/exceptions/` 配下に22個の具象例外クラスがあり、すべて `HttpException` を継承して固定のステータスコードをコンストラクタで束縛している（`bad-request.exception.ts:49` 等）。

- **フォールバックチェーンによる安全網の原則**: 例外処理を「カスタムフィルタ → 基底フィルタ → 未知例外ハンドラ」の段階的フォールバックで構成し、どんな例外も必ずキャッチされる。未処理例外がプロセスをクラッシュさせることを構造的に防止する。根拠: `ExceptionsHandler.next()` はカスタムフィルタを試行し、マッチしなければ `BaseExceptionFilter.catch()` に委譲、さらに `HttpException` でなければ `handleUnknownError()` が 500 を返す（`exceptions-handler.ts:12-17`, `base-exception-filter.ts:31-33`）。

- **トランスポート非依存のフィルタ選択原則**: 例外フィルタのマッチングロジック（`selectExceptionFilterMetadata`）をトランスポート間で共有し、HTTP/RPC/WS すべてで同じ `instanceof` ベースのディスパッチを使う。プロトコルごとの差異はフィルタの応答生成部分にのみ閉じ込める。根拠: `select-exception-filter-metadata.util.ts` が `ExceptionsHandler`, `RpcExceptionsHandler`, `WsExceptionsHandler` の3箇所から参照されている。

- **ログ抑制のための型マーカー原則**: `IntrinsicException` という中間基底クラスを設け、フレームワーク内部で意図的に投げる例外（HttpException 等）のログ出力を抑制する。未知のエラーだけがログに記録されることで、ノイズのない運用ログを実現する。根拠: `BaseExceptionFilter.handleUnknownError()` で `!(exception instanceof IntrinsicException)` のときだけ `logger.error()` を呼ぶ（`base-exception-filter.ts:72-74`）。同じパターンが RPC・WS の基底フィルタにも存在する。

## 実例と分析

### 例外クラス階層の設計

例外階層は3層で構成される:

1. `IntrinsicException extends Error` — ログ抑制マーカー
2. `HttpException extends IntrinsicException` — HTTP 例外の基底。ステータスコード・レスポンスボディ・cause を保持
3. 具象例外（`BadRequestException`, `NotFoundException` 等 22クラス）— ステータスコードを固定

具象例外クラスのコンストラクタはすべて同一パターンに従う。`extractDescriptionAndOptionsFrom` で引数を正規化し、`createBody` でレスポンスボディを構築する。このファクトリメソッドパターンにより、レスポンス形式の一貫性を保証している。

```typescript
// packages/common/exceptions/bad-request.exception.ts:36-52
constructor(
  objectOrError?: any,
  descriptionOrOptions: string | HttpExceptionOptions = 'Bad Request',
) {
  const { description, httpExceptionOptions } =
    HttpException.extractDescriptionAndOptionsFrom(descriptionOrOptions);

  super(
    HttpException.createBody(
      objectOrError,
      description!,
      HttpStatus.BAD_REQUEST,
    ),
    HttpStatus.BAD_REQUEST,
    httpExceptionOptions,
  );
}
```

RPC と WebSocket は HTTP とは独立した例外基底を持つ。`RpcException` と `WsException` は `HttpException` を継承せず、直接 `Error` を継承する。これによりトランスポートをまたいだ `instanceof` の誤マッチを防いでいる。

```typescript
// packages/microservices/exceptions/rpc-exception.ts:6-7
export class RpcException extends Error {
  constructor(private readonly error: string | object) {
```

```typescript
// packages/websockets/errors/ws-exception.ts:3-4
export class WsException extends Error {
  constructor(private readonly error: string | object) {
```

### 例外フィルタチェーンの実行フロー

フィルタチェーンの組み立ては `ContextCreator.createContext()` で行われる。グローバル → クラス → メソッドの順でメタデータを収集し、配列として結合した後に `reverse()` で逆順にする。結果としてメソッド → クラス → グローバルの優先順で最初にマッチしたフィルタが実行される。

```typescript
// packages/core/helpers/context-creator.ts:28-40
return [
  ...this.createConcreteContext<T, R>(
    globalMetadata || ([] as unknown[] as T),
    contextId,
    inquirerId,
  ),
  ...this.createConcreteContext<T, R>(classMetadata, contextId, inquirerId),
  ...this.createConcreteContext<T, R>(
    methodMetadata,
    contextId,
    inquirerId,
  ),
] as R;
```

```typescript
// packages/core/router/router-exception-filters.ts:43
exceptionHandler.setCustomFilters(filters.reverse());
```

フィルタの選択は `selectExceptionFilterMetadata` が担う。`@Catch()` デコレータの引数で宣言された例外型と `instanceof` で照合し、最初にマッチしたフィルタを返す。`@Catch()` に引数を渡さない（空配列の）フィルタはすべての例外にマッチする「キャッチオール」として機能する。

```typescript
// packages/common/utils/select-exception-filter-metadata.util.ts:3-13
export const selectExceptionFilterMetadata = <T = any>(
  filters: ExceptionFilterMetadata[],
  exception: T,
): ExceptionFilterMetadata | undefined =>
  filters.find(
    ({ exceptionMetatypes }) =>
      !exceptionMetatypes.length
      || exceptionMetatypes.some(
        ExceptionMetaType => exception instanceof ExceptionMetaType,
      ),
  );
```

### RouterProxy による例外の自動捕捉

ルートハンドラはすべて `RouterProxy.createProxy()` で例外ハンドラ付きのプロキシに包まれる。これにより、ハンドラ内で `throw` した例外が自動的にフィルタチェーンに流れる。開発者は try-catch を書く必要がない。

```typescript
// packages/core/router/router-proxy.ts:14-28
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

### 例外ファクトリパターン（ValidationPipe の事例）

`ValidationPipe` は `exceptionFactory` オプションで例外の生成をカスタマイズ可能にしている。デフォルトでは `HttpErrorByCode` マップからステータスコードに対応する例外クラスを動的に取得する。このパターンにより、バリデーションエラーの HTTP ステータスコードを変更可能にしている。

```typescript
// packages/common/pipes/validation.pipe.ts:181-188
public createExceptionFactory() {
  return (validationErrors: ValidationError[] = []) => {
    if (this.isDetailedOutputDisabled) {
      return new HttpErrorByCode[this.errorHttpStatusCode]();
    }
    const errors = this.flattenValidationErrors(validationErrors);
    return new HttpErrorByCode[this.errorHttpStatusCode](errors);
  };
}
```

### http-errors ライブラリとの互換レイヤー

`BaseExceptionFilter` は NestJS 独自の `HttpException` だけでなく、Express エコシステムで広く使われる `http-errors` ライブラリの例外オブジェクト（`statusCode` と `message` プロパティを持つオブジェクト）も認識する。これによりサードパーティミドルウェアが投げる例外も適切に処理される。

```typescript
// packages/core/exceptions/base-exception-filter.ts:85-87
public isHttpError(err: any): err is { statusCode: number; message: string } {
  return err?.statusCode && err?.message;
}
```

### Kafka リトライ可能例外

`KafkaRetriableException` は `getError()` で `this` 自身を返すことで、通常の RPC 例外処理フローをバイパスし、kafkajs の `eachMessage` コールバックにエラーを伝播させる。トランスポート固有のリトライセマンティクスを例外型で表現する手法。

```typescript
// packages/microservices/exceptions/kafka-retriable-exception.ts:13-16
export class KafkaRetriableException extends RpcException {
  public getError(): string | object {
    return this;
  }
}
```

## パターンカタログ

- **Chain of Responsibility** (分類: 振る舞い)
  - 解決する問題: 複数の例外フィルタを優先順位付きで連鎖させ、最初にマッチしたフィルタに処理を委譲する
  - 適用条件: 例外の種類ごとに異なる処理が必要で、フォールバックが求められる場合
  - コード例: `select-exception-filter-metadata.util.ts:3-13`, `exceptions-handler.ts:12-17`
  - 注意点: チェーンの順序は「メソッド → クラス → グローバル」の reverse で確定する。空配列の `@Catch()` はチェーンを終端させるため、配置位置に注意

- **Template Method** (分類: 振る舞い)
  - 解決する問題: HTTP/RPC/WS の基底フィルタが `catch()` → `handleUnknownError()` の処理骨格を定義し、サブクラスが応答形式を変える
  - 適用条件: 処理フローは共通だが、出力形式がプロトコルごとに異なる場合
  - コード例: `BaseExceptionFilter.catch()` (`base-exception-filter.ts:26-48`), `BaseRpcExceptionFilter.catch()` (`base-rpc-exception-filter.ts:21-29`)
  - 注意点: RPC フィルタは `Observable` を返すが、HTTP フィルタは `void` を返す。戻り値の型がテンプレートの一部となっている

- **Marker Interface / Marker Class** (分類: 構造)
  - 解決する問題: `IntrinsicException` がログ出力の判定マーカーとして機能し、フレームワーク内部例外とアプリケーション例外を区別する
  - 適用条件: 例外の処理方法（ログするか否か等）を型で分類したい場合
  - コード例: `intrinsic.exception.ts:7`, `base-exception-filter.ts:72-74`

## Good Patterns

- **ステータスコード固定の具象例外クラス**: 各 HTTP ステータスコードに対応する例外クラスを用意し、コンストラクタでステータスコードを束縛する。呼び出し側は `throw new NotFoundException()` と書くだけで、ステータスコードの誤指定を型レベルで防止できる。

```typescript
// packages/common/exceptions/not-found.exception.ts:36-53
constructor(
  objectOrError?: any,
  descriptionOrOptions: string | HttpExceptionOptions = 'Not Found',
) {
  const { description, httpExceptionOptions } =
    HttpException.extractDescriptionAndOptionsFrom(descriptionOrOptions);
  super(
    HttpException.createBody(objectOrError, description!, HttpStatus.NOT_FOUND),
    HttpStatus.NOT_FOUND,
    httpExceptionOptions,
  );
}
```

- **`@Catch()` デコレータによる型安全なフィルタ登録**: 例外フィルタが処理する例外型をデコレータの引数で宣言し、リフレクションメタデータに格納する。フィルタと例外の対応関係がコード上で明示され、ランタイムの `instanceof` チェックで型安全に選択される。

```typescript
// integration/inspector/src/common/filters/http-exception.filter.ts:8-22
@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter<HttpException> {
  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const statusCode = exception.getStatus();
    response.status(statusCode).json({
      statusCode,
      timestamp: new Date().toISOString(),
      path: ctx.getRequest().url,
    });
  }
}
```

- **Error Cause チェーンのサポート**: `HttpException` が `cause` オプションを受け取り、元のエラーを保持する。Node.js の Error Cause 仕様（v16.9+）に準拠し、例外の再ラップ時に原因追跡を可能にする。

```typescript
// packages/common/exceptions/http.exception.ts:39-41
// throw new HttpException('message', HttpStatus.BAD_REQUEST, {
//   cause: new Error('Cause Error'),
// })
```

- **`ArgumentsHost` によるトランスポート抽象化**: 例外フィルタの `catch()` メソッドが `ArgumentsHost` を受け取り、`switchToHttp()` / `switchToRpc()` / `switchToWs()` でプロトコル固有のコンテキストに切り替える。1つのフィルタが複数トランスポートに対応できる拡張ポイント。

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

## Anti-Patterns / 注意点

- **キャッチオールフィルタの先頭配置**: `@Catch()` に引数を渡さないフィルタ（空の `exceptionMetatypes`）は全例外にマッチする。これがチェーンの先頭に来ると、後続のより具体的なフィルタが一切実行されない。

```typescript
// Bad: キャッチオールがメソッドレベルにあり、クラスレベルの具体フィルタを遮蔽
@UseFilters(new CatchAllFilter())
@Get()
findOne() { ... }

// Better: 具体フィルタをメソッドに、キャッチオールをグローバルに配置
@UseFilters(new NotFoundFilter())
@Get()
findOne() { ... }
// app.useGlobalFilters(new CatchAllFilter());
```

- **トランスポートをまたいだ例外の誤用**: HTTP コントローラで `RpcException` を投げたり、マイクロサービスで `HttpException` を投げると、対応するフィルタにマッチせず未知例外として 500 エラーになる。NestJS が例外基底を分離している理由はこの誤用を防ぐためである。

```typescript
// Bad: マイクロサービスハンドラ内で HttpException を投げる
@MessagePattern('process')
process() {
  throw new HttpException('error', 400); // RpcExceptionFilter にマッチしない
}

// Better: トランスポートに対応する例外を使う
@MessagePattern('process')
process() {
  throw new RpcException('error');
}
```

- **例外フィルタ内での例外の再スロー制御不備**: カスタムフィルタ内で未処理例外が発生すると、フレームワークの安全網（`BaseExceptionFilter`）ではなく Node.js の未処理例外として扱われる可能性がある。フィルタ内のエラーハンドリングにも防御的コーディングが必要。

```typescript
// Bad: フィルタ内で例外が発生する可能性
@Catch(HttpException)
export class LoggingFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const data = JSON.parse(exception.message); // パース失敗の可能性
    // ...
  }
}

// Better: フィルタ内も防御的に書く
@Catch(HttpException)
export class LoggingFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();
    const status = exception.getStatus();
    response.status(status).json({
      statusCode: status,
      message: exception.message,
    });
  }
}
```

## 導出ルール

- `[MUST]` 例外クラス階層はトランスポート（HTTP/RPC/WS 等）ごとに独立した基底を持たせ、異なるプロトコル間での `instanceof` 誤マッチを防止する
  - 根拠: NestJS は `HttpException`, `RpcException`, `WsException` を互いに独立した継承ツリーにしており、トランスポートをまたいだ例外の誤用を型レベルで排除している（`rpc-exception.ts:6`, `ws-exception.ts:3`）

- `[MUST]` 例外処理チェーンの終端に「全例外キャッチ」のフォールバックハンドラを設け、未処理例外によるプロセスクラッシュを構造的に防止する
  - 根拠: `BaseExceptionFilter.handleUnknownError()` が `HttpException` 以外のあらゆる例外を 500 レスポンスに変換し、フレームワーク外への例外漏洩を防いでいる（`base-exception-filter.ts:50-75`）

- `[SHOULD]` HTTP ステータスコードごとの具象例外クラスを用意し、`throw new XxxException()` で投げられるようにする。生のステータスコード数値をビジネスロジック内で扱わせない
  - 根拠: 22個の具象例外クラスがすべて同一パターンのコンストラクタでステータスコードを束縛しており、`HttpErrorByCode` マップでステータスコードから例外クラスへの逆引きも可能にしている（`http-error-by-code.util.ts:46-66`）

- `[SHOULD]` 例外フィルタの選択を `instanceof` ベースの型マッチングで行い、フィルタの対象例外型を宣言的に指定できるようにする
  - 根拠: `selectExceptionFilterMetadata` が `instanceof` で最初にマッチしたフィルタを返す設計であり、フィルタと例外の対応関係が `@Catch()` デコレータの引数として明示される（`select-exception-filter-metadata.util.ts:8-11`）

- `[SHOULD]` 例外の再ラップ時に `cause` プロパティで元のエラーを保持し、エラーチェーンを追跡可能にする
  - 根拠: `HttpException` が `options.cause` を受け取り、Node.js Error Cause 仕様に準拠した原因追跡を提供している（`http.exception.ts:84-89`）

- `[SHOULD]` フレームワーク内部で意図的に投げる例外にはマーカー基底クラスを設け、ログ出力対象から除外する。ログには「想定外のエラー」のみを記録する
  - 根拠: `IntrinsicException` がマーカーとして機能し、HTTP/RPC/WS の全基底フィルタで `!(exception instanceof IntrinsicException)` のときだけログ出力する（`base-exception-filter.ts:72-74`, `base-rpc-exception-filter.ts:34-37`）

- `[AVOID]` 例外フィルタ内で例外を握りつぶしたり、別の例外を無防備に投げる。フィルタ自体がクラッシュすると安全網が機能しなくなる
  - 根拠: `ExternalExceptionFilter.catch()` はログ出力後に例外を再スローしており、フィルタが「処理できない例外」を上位に伝播させる設計を取っている（`external-exception-filter.ts:6-15`）

## 適用チェックリスト

- [ ] プロジェクトの例外クラスが HTTP ステータスコード（または業務エラーコード）と1対1で対応しているか確認する
- [ ] 例外処理のフォールバックチェーンが存在し、未処理例外がプロセスをクラッシュさせない構造になっているか検証する
- [ ] 複数のトランスポート（REST API + WebSocket 等）を持つ場合、例外基底クラスがトランスポートごとに分離されているか確認する
- [ ] 例外の再ラップ時に元のエラー（cause）を保持しているか、エラーチェーンが追跡可能か確認する
- [ ] フレームワーク内部の意図的な例外と、想定外のアプリケーションエラーをログレベルで区別しているか確認する
- [ ] 例外フィルタ（またはエラーハンドラ）の優先順序が「具体的 → 汎用」の順になっているか確認する
- [ ] バリデーションエラーの例外生成にファクトリパターンを使い、エラーのステータスコードや形式をカスタマイズ可能にしているか検討する
