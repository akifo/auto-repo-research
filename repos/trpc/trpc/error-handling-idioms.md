# error-handling-idioms

> リポジトリ: trpc/trpc
> 分析日: 2026-02-24

## 概要

tRPC のエラーハンドリングは、サーバー側で発生した任意のエラーを型安全に正規化し、プロトコル境界を越えてクライアントまで伝播させる仕組みを中心に構成されている。注目に値する理由は3点ある。第一に、`getTRPCErrorFromUnknown` による正規化関数が `catch(cause)` の直後に必ず配置され、未知のエラーが内部的に一貫した型に変換される。第二に、ErrorFormatter によるシリアライズ時カスタマイズとErrorHandlerOptions による副作用フックが明確に分離されている。第三に、ミドルウェアチェーンのエラー伝播が Result 型（`{ ok: false, error }` / `{ ok: true, data }`）で表現され、例外と戻り値の二重チャネルを回避している。

## 背景にある原則

- **未知エラーは境界で即座に正規化すべき**: `catch` ブロックに入った時点でエラーの型は `unknown` であり、これを後段に伝播させると型安全性が失われる。tRPC は `getTRPCErrorFromUnknown` を全ての catch 直後に呼び出し、以降の処理が常に `TRPCError` 型を扱えるようにしている（`packages/server/src/unstable-core-do-not-import/error/TRPCError.ts:31-51`）。

- **エラーの「形状変換」と「副作用通知」は分離すべき**: ErrorFormatter はレスポンスの JSON 形状をカスタマイズする純粋関数であり、onError はログ送信や監視通知などの副作用を実行するコールバックである。両者を混在させると、フォーマッタのテストが困難になり、副作用の実行タイミングが不明確になる。

- **ミドルウェアチェーン内のエラーは Result 型で伝播すべき**: `callRecursive` は catch したエラーを例外として再スローせず `{ ok: false, error }` として返す。これにより、チェーンの呼び出し元がエラーを検査・ログ記録した上で再スローを制御できる。例外のみに頼るとミドルウェア間のエラー情報が失われやすい（`packages/server/src/unstable-core-do-not-import/procedureBuilder.ts:634-672`）。

- **ドメインエラーコードは HTTP ステータスコードから独立させるべき**: tRPC は JSON-RPC 2.0 の負数エラーコード体系（`-32000` 〜 `-32099`）をドメインコードとして使い、HTTP ステータスコードとは別のマッピングテーブル（`JSONRPC2_TO_HTTP_CODE`）で変換する。これにより、WebSocket や SSE など HTTP 以外のトランスポートでも同じエラーコード体系を使える（`packages/server/src/unstable-core-do-not-import/rpc/codes.ts:11-44`）。

## 実例と分析

### 1. エラー正規化パターン: getTRPCErrorFromUnknown

全てのアダプター（HTTP、WebSocket、Next.js App Dir、localLink）で `catch(cause)` の直後に `getTRPCErrorFromUnknown(cause)` が呼ばれる。この関数は3つのケースを処理する。

```typescript
// packages/server/src/unstable-core-do-not-import/error/TRPCError.ts:31-51
export function getTRPCErrorFromUnknown(cause: unknown): TRPCError {
  if (cause instanceof TRPCError) {
    return cause;
  }
  if (cause instanceof Error && cause.name === "TRPCError") {
    // https://github.com/trpc/trpc/pull/4848
    return cause as TRPCError;
  }

  const trpcError = new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    cause,
  });

  // Inherit stack from error
  if (cause instanceof Error && cause.stack) {
    trpcError.stack = cause.stack;
  }

  return trpcError;
}
```

注目すべきは `cause.name === 'TRPCError'` によるファジーマッチングである。これはモノレポやバンドラー環境で `instanceof` が失敗するケースへの対策であり、複数のパッケージバージョンが共存する実環境の問題を解決している。

### 2. ミドルウェアチェーンの Result 型伝播

`callRecursive` 関数はミドルウェアチェーンを再帰的に実行し、エラーを Result 型で返す。

```typescript
// packages/server/src/unstable-core-do-not-import/procedureBuilder.ts:634-672
async function callRecursive(
  index: number,
  _def: AnyProcedureBuilderDef,
  opts: ProcedureCallOptions<any>,
): Promise<MiddlewareResult<any>> {
  try {
    const middleware = _def.middlewares[index]!;
    const result = await middleware({
      ...opts,
      next(_nextOpts?: any) {
        return callRecursive(index + 1, _def, { ... });
      },
    });
    return result;
  } catch (cause) {
    return {
      ok: false,
      error: getTRPCErrorFromUnknown(cause),
      marker: middlewareMarker,
    };
  }
}
```

呼び出し元の `createProcedureCaller` はこの Result を検査し、`ok: false` の場合にエラーを再スローする。

```typescript
// packages/server/src/unstable-core-do-not-import/procedureBuilder.ts:674-696
const result = await callRecursive(0, _def, opts);
if (!result) {
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "No result from middlewares - did you forget to `return next()`?",
  });
}
if (!result.ok) {
  throw result.error;
}
return result.data;
```

### 3. 入力バリデーションエラーの変換

入力バリデーションミドルウェアは、バリデーションライブラリ（Zod 等）が投げるエラーを `BAD_REQUEST` コードの `TRPCError` にラップする。

```typescript
// packages/server/src/unstable-core-do-not-import/middleware.ts:186-199
export function createInputMiddleware<TInput>(parse: ParseFn<TInput>) {
  const inputMiddleware: AnyMiddlewareFunction = async function inputValidatorMiddleware(opts) {
    let parsedInput: ReturnType<typeof parse>;
    const rawInput = await opts.getRawInput();
    try {
      parsedInput = await parse(rawInput);
    } catch (cause) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        cause,
      });
    }
    // ...
  };
}
```

出力バリデーションも同様だが、コードは `INTERNAL_SERVER_ERROR` になる。これは入力エラーがクライアントの責任（4xx）、出力エラーがサーバーの責任（5xx）という HTTP セマンティクスに対応している。

```typescript
// packages/server/src/unstable-core-do-not-import/middleware.ts:219-240
export function createOutputMiddleware<TOutput>(parse: ParseFn<TOutput>) {
  const outputMiddleware: AnyMiddlewareFunction = async function outputValidatorMiddleware({ next }) {
    const result = await next();
    if (!result.ok) {
      return result; // pass through failures without validating
    }
    try {
      const data = await parse(result.data);
      return { ...result, data };
    } catch (cause) {
      throw new TRPCError({
        message: "Output validation failed",
        code: "INTERNAL_SERVER_ERROR",
        cause,
      });
    }
  };
}
```

### 4. ErrorFormatter と getErrorShape のパイプライン

`getErrorShape` はデフォルト形状を構築した上で、ユーザー定義の `errorFormatter` を通す。

```typescript
// packages/server/src/unstable-core-do-not-import/error/getErrorShape.ts:11-36
export function getErrorShape<TRoot extends AnyRootTypes>(opts: {
  config: RootConfig<TRoot>;
  error: TRPCError;
  type: ProcedureType | "unknown";
  path: string | undefined;
  input: unknown;
  ctx: TRoot["ctx"] | undefined;
}): TRoot["errorShape"] {
  const { path, error, config } = opts;
  const shape: DefaultErrorShape = {
    message: error.message,
    code: TRPC_ERROR_CODES_BY_KEY[code],
    data: {
      code,
      httpStatus: getHTTPStatusCodeFromError(error),
    },
  };
  if (config.isDev && typeof opts.error.stack === "string") {
    shape.data.stack = opts.error.stack;
  }
  if (typeof path === "string") {
    shape.data.path = path;
  }
  return config.errorFormatter({ ...opts, shape });
}
```

`errorFormatter` はデフォルトではパススルー（`({ shape }) => shape`）だが、ユーザーが Zod のバリデーションエラーの詳細を添付する等のカスタマイズが可能。この設計により、エラーの「内部表現」と「外部表現」が明確に分離されている。

### 5. onError コールバックの統一インターフェース

全てのアダプター（HTTP、WS、Next.js、localLink、Lambda）で同じ `ErrorHandlerOptions` インターフェースが使われる。

```typescript
// packages/server/src/unstable-core-do-not-import/procedure.ts:97-103
export interface ErrorHandlerOptions<TContext> {
  error: TRPCError;
  type: ProcedureType | "unknown";
  path: string | undefined;
  input: unknown;
  ctx: TContext | undefined;
}
```

HTTP アダプターはこれを拡張して `req` を追加する。アダプター固有のフィールドはインターフェース拡張で追加され、共通部分は常に同じ構造を維持する。

### 6. クライアント側エラーの対称設計

`TRPCClientError` はサーバーの `TRPCError` と対称的に設計されている。`TRPCClientError.from()` 静的メソッドがサーバーと同じ正規化パターンを踏襲する。

```typescript
// packages/client/src/TRPCClientError.ts:87-117
public static from<TRouterOrProcedure extends InferrableClientTypes>(
  _cause: Error | TRPCErrorResponse<any> | object,
  opts: { meta?: Record<string, unknown>; cause?: Error } = {},
): TRPCClientError<TRouterOrProcedure> {
  const cause = _cause as unknown;
  if (isTRPCClientError(cause)) {
    if (opts.meta) {
      cause.meta = { ...cause.meta, ...opts.meta };
    }
    return cause;
  }
  if (isTRPCErrorResponse(cause)) {
    return new TRPCClientError(cause.error.message, {
      ...opts, result: cause, cause: opts.cause,
    });
  }
  return new TRPCClientError(
    getMessageFromUnknownError(cause, 'Unknown error'), { ...opts, cause: cause as any }
  );
}
```

### 7. バッチレスポンスのマルチステータス

バッチリクエストで複数のプロシージャが異なるステータスコードを返す場合、HTTP 207（Multi-Status）を返す。

```typescript
// packages/server/src/unstable-core-do-not-import/http/getHTTPStatusCode.ts:71-94
export function getHTTPStatusCode(json: TRPCResponse | TRPCResponse[]) {
  const httpStatuses = new Set<number>(arr.map((res) => { ... }));
  if (httpStatuses.size !== 1) {
    return 207;
  }
  return httpStatus!;
}
```

## パターンカタログ

- **Chain of Responsibility** (分類: 振る舞い)
  - 解決する問題: ミドルウェアチェーンでのエラー伝播と段階的な処理
  - 適用条件: 複数の処理ステップを順序付きで実行し、各ステップがエラーを捕捉・変換する必要がある場合
  - コード例: `procedureBuilder.ts:634-672` の `callRecursive` 関数
  - 注意点: GoF の Chain of Responsibility では処理を引き継ぐか打ち切るかの判断だが、tRPC では Result 型を返すことで「エラーを伝播しつつチェーンを継続」するハイブリッド方式を採用

- **Normalizer / Canonicalizer** (分類: 変換)
  - 解決する問題: `catch(cause: unknown)` で捕捉した多様なエラー型を統一的に扱う
  - 適用条件: 外部ライブラリや非 Error 値が throw される可能性がある境界層
  - コード例: `TRPCError.ts:31-51` の `getTRPCErrorFromUnknown`
  - 注意点: `instanceof` だけでなく `name` プロパティによるファジーマッチングを併用し、バンドラー環境の `instanceof` 失敗に対応

## Good Patterns

- **catch 直後の正規化関数**: 全ての `catch(cause)` ブロックの最初の行で `getTRPCErrorFromUnknown(cause)` を呼び出し、以降の処理は常に `TRPCError` 型を前提にできる。これにより型キャストや条件分岐が後段に漏れない。

```typescript
// packages/server/src/unstable-core-do-not-import/http/resolveResponse.ts:382-396
} catch (cause) {
  const error = getTRPCErrorFromUnknown(cause);
  opts.onError?.({
    error,
    path: call.path,
    input,
    ctx: ctxManager.valueOrUndefined(),
    type: call.procedure?._def.type ?? 'unknown',
    req: opts.req,
  });
  return [error, undefined];
}
```

- **cause チェーンの保全**: `TRPCError` コンストラクタは `cause` を受け取り、`getCauseFromUnknown` で正規化した上で標準の `Error.cause` に設定する。文字列やオブジェクトが渡された場合も synthetic な Error を生成して cause チェーンを途切れさせない。

```typescript
// packages/server/src/unstable-core-do-not-import/error/TRPCError.ts:53-75
export class TRPCError extends Error {
  public override readonly cause?: Error;
  public readonly code;

  constructor(opts: {
    message?: string;
    code: TRPC_ERROR_CODE_KEY;
    cause?: unknown;
  }) {
    const cause = getCauseFromUnknown(opts.cause);
    const message = opts.message ?? cause?.message ?? opts.code;
    super(message, { cause });
    this.code = opts.code;
    this.name = "TRPCError";
    this.cause ??= cause;
  }
}
```

- **出力バリデーション失敗時のエラー通過**: `createOutputMiddleware` は `result.ok` が `false` の場合、バリデーションをスキップしてそのまま返す。既にエラー状態にあるレスポンスに対して二重にエラーを発生させない防御的設計。

```typescript
// packages/server/src/unstable-core-do-not-import/middleware.ts:222-225
const result = await next();
if (!result.ok) {
  return result; // pass through failures without validating
}
```

## Anti-Patterns / 注意点

- **エラー正規化の省略**: `catch(cause)` の後で `cause` をそのまま使い回すと、`cause` が `string`、`undefined`、あるいは非 Error オブジェクトの場合にランタイムエラーが発生する。

```typescript
// Bad: cause の型が不明なまま使用
} catch (cause) {
  logger.error(cause.message); // TypeError if cause is not an object
  throw cause;
}

// Better: 正規化してから使用
} catch (cause) {
  const error = getTRPCErrorFromUnknown(cause);
  logger.error(error.message); // 常に安全
  throw error;
}
```

- **エラーコードとHTTPステータスの直接結合**: エラーコードを HTTP ステータスコードそのもの（例: `code: 404`）として定義すると、WebSocket や gRPC など非 HTTP トランスポートで使えなくなる。

```typescript
// Bad: HTTP ステータスをエラーコードとして直接使用
class AppError extends Error {
  constructor(public statusCode: number) {
    super();
  }
}

// Better: ドメインコードを定義し、トランスポート層で変換
class AppError extends Error {
  constructor(public code: "NOT_FOUND" | "UNAUTHORIZED") {
    super();
  }
}
const HTTP_STATUS_MAP = { NOT_FOUND: 404, UNAUTHORIZED: 401 };
```

- **ErrorFormatter 内での副作用実行**: ErrorFormatter はレスポンス形状を返す純粋関数であるべきで、ここでログ送信や DB 書き込みを行うと、バッチレスポンスや SSE エラーで予期しない回数実行される。副作用は `onError` コールバックに分離すること。

```typescript
// Bad: フォーマッタ内で副作用
errorFormatter({ shape, error }) {
  sendToSentry(error); // バッチで N 回実行される
  return { ...shape, sentryId: getSentryId() };
}

// Better: onError で副作用、フォーマッタは形状変換のみ
onError({ error }) { sendToSentry(error); }
errorFormatter({ shape }) { return shape; }
```

## 導出ルール

- `[MUST]` `catch(cause: unknown)` の直後で正規化関数を呼び、以降の処理は常に正規化済みのエラー型を扱う
  - 根拠: tRPC は全アダプター・全 catch ブロックで `getTRPCErrorFromUnknown(cause)` を最初に呼び、後段のコードが型安全にエラーを処理できるようにしている

- `[MUST]` エラーの cause チェーンを保全する — ラップ時に元のエラーを `cause` として渡し、スタックトレースを継承する
  - 根拠: `TRPCError` は `getCauseFromUnknown` で文字列・オブジェクト・Error を全て cause に変換し、`trpcError.stack = cause.stack` で元のスタックを継承している

- `[SHOULD]` エラーの「形状変換（シリアライズ）」と「副作用通知（ログ・監視）」を別のフックとして分離する
  - 根拠: tRPC は `errorFormatter`（形状変換）と `onError`（副作用）を明確に分離し、バッチ処理やストリーミングで各々が独立して正しく動作することを保証している

- `[SHOULD]` ミドルウェアチェーン内のエラーは Result 型（`{ ok: false, error }` / `{ ok: true, data }`）で伝播し、最終段で必要に応じて再スローする
  - 根拠: `callRecursive` は catch で Result に変換し、`createProcedureCaller` が `!result.ok` を検査してからスローする設計により、エラー情報の欠落を防いでいる

- `[SHOULD]` ドメインエラーコードは特定のトランスポート層（HTTP ステータスコード等）から独立した列挙型として定義し、変換テーブルでマッピングする
  - 根拠: tRPC は JSON-RPC 2.0 の独自コード体系を使い、`JSONRPC2_TO_HTTP_CODE` テーブルで HTTP ステータスに変換する設計により、WS・SSE・HTTP で統一的なエラーコードを使えている

- `[SHOULD]` `instanceof` によるエラー型判定は `name` プロパティによるフォールバックを併用する
  - 根拠: モノレポやバンドラー環境では同一クラスの異なるインスタンスが存在し `instanceof` が失敗する。tRPC は `cause.name === 'TRPCError'` をフォールバックとして使用している（PR #4848 で修正）

- `[AVOID]` 既にエラー状態にあるレスポンスに対して追加のバリデーションや変換を適用する — エラーの二重発生を招く
  - 根拠: `createOutputMiddleware` は `result.ok === false` の場合にバリデーションをスキップし、二重エラーを防止している

## 適用チェックリスト

- [ ] プロジェクト全体で `catch(cause)` の直後にエラー正規化関数を呼んでいるか確認する
- [ ] エラークラスのコンストラクタが `cause` を受け取り、`Error.cause` として保全しているか確認する
- [ ] エラーのシリアライズ（レスポンス形状変換）とログ・監視の副作用が分離されているか確認する
- [ ] ドメインエラーコードが HTTP ステータスコードに直接依存していないか確認する（マッピングテーブルの有無）
- [ ] バッチ処理やストリーミングでエラーフォーマッタ・onError コールバックが正しい回数実行されるか検証する
- [ ] `instanceof` によるエラー判定にフォールバック（`name` プロパティ等）が用意されているか確認する
- [ ] ミドルウェアチェーンで Result 型を使っている場合、エラー状態のレスポンスに対して不要な処理をスキップしているか確認する
