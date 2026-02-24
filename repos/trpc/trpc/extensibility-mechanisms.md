# Extensibility Mechanisms

> リポジトリ: trpc/trpc
> 分析日: 2026-02-24

## 概要

tRPC はクライアント側のリンクチェーン、サーバー側のミドルウェアスタック、lazy router によるコード分割、experimental_caller によるプロシージャ呼び出しオーバーライドなど、クライアント/サーバー双方に多層的な拡張機構を備えている。これらはすべて「関数合成」を基本単位とし、既存コードを変更せずに振る舞いを追加・差し替えできるよう設計されている。RPC フレームワークにおける拡張ポイント設計の優れた実例として注目に値する。

## 背景にある原則

- **関数合成による直交的な拡張**: リンクもミドルウェアも単なる関数であり、合成可能な最小単位として設計されている。リンクは `(opts) => Observable` 型、ミドルウェアは `(opts) => Promise<MiddlewareResult>` 型で統一されており、拡張機構同士が干渉しない。これにより、ロギング・リトライ・バッチングなど関心事をリンク単位で独立させられる（`packages/client/src/links/types.ts:95-104`）。

- **Chain of Responsibility による制御の逆転**: クライアントリンクチェーンとサーバーミドルウェアチェーンの両方で「next を呼ぶかどうかをハンドラが決める」パターンを採用し、制御の方向を反転させている。これによりフレームワーク側はチェーンの実行順序だけを管理すれば済み、各ハンドラは次のハンドラを呼ぶ前後に独自ロジックを挟める（`packages/client/src/links/internals/createChain.ts:19-35`）。

- **遅延解決による初期化コスト分散**: lazy router はルーター定義を `() => Promise<Router>` のサンクとして保持し、プロシージャが実際に呼ばれるまでモジュールロードを遅延させる。初期化時にすべてのルーターを登録する必要がなくなり、大規模アプリケーションの起動時間とメモリ使用量を削減できる（`packages/server/src/unstable-core-do-not-import/router.ts:105-135`）。

- **呼び出しセマンティクスの差し替え可能性**: experimental_caller はプロシージャの「呼ばれ方」を差し替える仕組みで、内部の resolve ロジックには触れずに外部インターフェースだけを変える。サーバーアクション対応のように、同じビジネスロジックを異なるプロトコルや呼び出し規約で再利用する場面で有効（`packages/server/src/unstable-core-do-not-import/procedureBuilder.ts:448-460`）。

## 実例と分析

### リンクアーキテクチャ: 3 層のクロージャ構造

tRPC のリンクは 3 層のクロージャで構成されている。この構造により、設定の解決・アプリ初期化・リクエスト処理の各段階でスコープを分離できる。

```typescript
// packages/client/src/links/retryLink.ts:39-46
export function retryLink<TInferrable extends InferrableClientTypes>(
  opts: RetryLinkOptions<TInferrable>,
): TRPCLink<TInferrable> {
  // 第1層: 設定解決（リンク生成時に一度だけ実行）
  return () => {
    // 第2層: アプリ初期化（TRPCUntypedClient 構築時に実行）
    return (callOpts) => {
      // 第3層: リクエスト処理（各操作ごとに実行）
      return observable((observer) => {/* ... */});
    };
  };
}
```

`TRPCLink` 型自体が「runtime を受け取って OperationLink を返す関数」として定義されており（`types.ts:109-111`）、リンクの初期化とリクエスト処理が明確に分離される。

### splitLink: 条件分岐によるリンクチェーンの動的ルーティング

`splitLink` はリクエストの種類に応じてリンクチェーンを分岐させる。subscriptions は WebSocket 経由、queries/mutations は HTTP 経由という使い分けが典型例。

```typescript
// packages/client/src/links/splitLink.ts:9-30
export function splitLink<TRouter extends AnyRouter = AnyRouter>(opts: {
  condition: (op: Operation) => boolean;
  true: TRPCLink<TRouter> | TRPCLink<TRouter>[];
  false: TRPCLink<TRouter> | TRPCLink<TRouter>[];
}): TRPCLink<TRouter> {
  return (runtime) => {
    const yes = asArray(opts.true).map((link) => link(runtime));
    const no = asArray(opts.false).map((link) => link(runtime));
    return (props) => {
      return observable((observer) => {
        const links = opts.condition(props.op) ? yes : no;
        return createChain({ op: props.op, links }).subscribe(observer);
      });
    };
  };
}
```

注目すべきは `true`/`false` プロパティが単一リンクだけでなくリンク配列も受け入れる点。分岐先にもチェーンを構築でき、再帰的な構成が可能。

### localLink: HTTP レイヤーをバイパスする拡張

`localLink` はサーバールーターを直接呼び出す terminating link で、テスト時やサーバーサイドレンダリング時に HTTP のオーバーヘッドを回避する。

```typescript
// packages/client/src/links/localLink.ts:40-42
export function unstable_localLink<TRouter extends AnyRouter>(
  opts: LocalLinkOptions<TRouter>,
): TRPCLink<TRouter> {
```

同じ `TRPCLink` インターフェースを返すため、上流のリンク（logger、retry 等）はトランスポートが HTTP か直接呼び出しかを意識する必要がない。

### createChain: リンクチェーンの実行エンジン

```typescript
// packages/client/src/links/internals/createChain.ts:10-40
export function createChain<TRouter extends AnyRouter>(opts: {
  links: OperationLink<TRouter>[];
  op: Operation;
}): OperationResultObservable<TRouter, unknown> {
  return observable((observer) => {
    function execute(index = 0, op = opts.op) {
      const next = opts.links[index];
      if (!next) {
        throw new Error("No more links to execute - did you forget to add an ending link?");
      }
      const subscription = next({
        op,
        next(nextOp) {
          return execute(index + 1, nextOp);
        },
      });
      return subscription;
    }
    const obs$ = execute();
    return obs$.subscribe(observer);
  });
}
```

再帰的に `execute` を呼び出し、各リンクに `next` コールバックを渡す。チェーンの末端（terminating link）は `next` を呼ばず、自分で Observable を生成して完結する。

### lazy router: 遅延読み込みとオンデマンド解決

```typescript
// packages/server/src/unstable-core-do-not-import/router.ts:105-135
export function lazy<TRouter extends AnyRouter>(
  importRouter: () => Promise<TRouter | { [key: string]: TRouter; }>,
): Lazy<NoInfer<TRouter>> {
  async function resolve(): Promise<TRouter> {
    const mod = await importRouter();
    if (isRouter(mod)) return mod;
    const routers = Object.values(mod);
    if (routers.length !== 1 || !isRouter(routers[0])) {
      throw new Error("Invalid router module...");
    }
    return routers[0];
  }
  (resolve as Lazy<NoInfer<TRouter>>)[lazyMarker] = true as const;
  return resolve as Lazy<NoInfer<TRouter>>;
}
```

`lazy` でラップされたルーターは `once` でメモ化されたローダーを通じてオンデマンドで解決される（`router.ts:90-99`）。`getProcedureAtPath` がプロシージャ呼び出し時に lazy ルーターを検出・ロードし、`procedures` マップに動的に追加する（`router.ts:373-396`）。

```typescript
// packages/server/src/unstable-core-do-not-import/router.ts:373-396
export async function getProcedureAtPath(router, path) {
  let procedure = _def.procedures[path];
  while (!procedure) {
    const key = Object.keys(_def.lazy).find((key) => path.startsWith(key));
    if (!key) return null;
    await lazyRouter.load();
    procedure = _def.procedures[path];
  }
  return procedure;
}
```

### experimental_caller: プロシージャ呼び出しのオーバーライド

```typescript
// packages/server/src/unstable-core-do-not-import/procedureBuilder.ts:64-68
export type CallerOverride<TContext> = (opts: {
  args: unknown[];
  invoke: (opts: ProcedureCallOptions<TContext>) => Promise<unknown>;
  _def: AnyProcedure["_def"];
}) => Promise<unknown>;
```

`CallerOverride` は元の `invoke` 関数をラップする形でプロシージャの外部インターフェースを差し替える。`createResolver` 内部で、caller が設定されている場合は `callerWrapper` が procedure の代わりに返される（`procedureBuilder.ts:595-610`）。

Next.js App Router 統合の `nextAppDirCaller` がこの仕組みの最重要ユースケース:

```typescript
// packages/server/src/adapters/next-app-dir/nextAppDirCaller.ts:79-107
switch (opts._def.type) {
  case "mutation": {
    // useFormState の追加引数を処理
    let input = opts.args.length === 1 ? opts.args[0] : opts.args[1];
    if (normalizeFormData && input instanceof FormData) {
      input = formDataToObject(input);
    }
    return await opts.invoke({
      type: opts._def.type,
      ctx,
      getRawInput: async () => input,
      path,
      input,
      signal: undefined,
      batchIndex: 0,
    }).catch(handleError);
  }
}
```

### ミドルウェアの再帰的実行と合成

サーバー側のミドルウェアチェーンも Chain of Responsibility で実行される:

```typescript
// packages/server/src/unstable-core-do-not-import/procedureBuilder.ts:634-672
async function callRecursive(index, _def, opts) {
  const middleware = _def.middlewares[index];
  const result = await middleware({
    ...opts,
    next(_nextOpts?) {
      return callRecursive(index + 1, _def, {
        ...opts,
        ctx: nextOpts?.ctx ? { ...opts.ctx, ...nextOpts.ctx } : opts.ctx,
        input: nextOpts && "input" in nextOpts ? nextOpts.input : opts.input,
      });
    },
  });
  return result;
}
```

`concat` メソッドにより ProcedureBuilder 同士を合成でき、ミドルウェア・入力パーサー・メタデータが統合される（`procedureBuilder.ts:325-357`）。

### dataLoader: バッチリンクの内部エンジン

`httpBatchLink` と `httpBatchStreamLink` は `dataLoader` を使って複数リクエストをバッチ化する。GraphQL の DataLoader パターンと同じマイクロタスクベースのバッチ処理を行う:

```typescript
// packages/client/src/internals/dataLoader.ts:135-155
function load(key: TKey): Promise<TValue> {
  const item = { aborted: false, key, batch: null, resolve: throwFatalError, reject: throwFatalError };
  const promise = new Promise<TValue>((resolve, reject) => {
    item.reject = reject;
    item.resolve = resolve;
    pendingItems ??= [];
    pendingItems.push(item);
  });
  dispatchTimer ??= setTimeout(dispatch);
  return promise;
}
```

`validate` 関数で URL 長やアイテム数の上限を検査し、超える場合は自動的にバッチを分割する（`httpBatchLink.ts:33-51`）。

## パターンカタログ

- **Chain of Responsibility** (分類: 振る舞い)
  - 解決する問題: リクエスト/レスポンスのパイプラインに横断的関心事を挿入する
  - 適用条件: 処理を複数のハンドラに分割し、順序付きで実行する必要がある場合
  - コード例: `packages/client/src/links/internals/createChain.ts:10-40`, `packages/server/src/unstable-core-do-not-import/procedureBuilder.ts:634-672`
  - 注意点: クライアント側は Observable ベース、サーバー側は async/await ベースで、同じパターンだが非同期モデルが異なる

- **Strategy** (分類: 振る舞い)
  - 解決する問題: トランスポート層のアルゴリズムを差し替え可能にする
  - 適用条件: HTTP/WebSocket/直接呼び出しなど、複数のトランスポートを統一インターフェースで扱いたい場合
  - コード例: `httpLink`, `wsLink`, `localLink` がすべて `TRPCLink<TRouter>` を返す
  - 注意点: terminating link と non-terminating link の区別がインターフェースに現れないため、チェーン末端に terminating link を配置する責任はユーザーにある

- **Proxy** (分類: 構造)
  - 解決する問題: 型安全な API を動的に生成する
  - 適用条件: ルーター定義からクライアント API を自動導出する場合
  - コード例: `packages/server/src/unstable-core-do-not-import/createProxy.ts:19-57`
  - 注意点: `then`、`call`、`apply` は予約語として特別処理が必要

- **Lazy Initialization** (分類: 生成)
  - 解決する問題: 大規模ルーターの初期化コスト
  - 適用条件: モジュール数が多く、起動時にすべてを登録するとパフォーマンスに影響する場合
  - コード例: `packages/server/src/unstable-core-do-not-import/router.ts:105-135`

## Good Patterns

- **統一インターフェースによるトランスポート抽象化**: `TRPCLink<TRouter>` という単一の型を通じて、HTTP・WebSocket・直接呼び出しが同じインターフェースで表現される。上流リンク（logger, retry）はトランスポートを意識しない。
  ```typescript
  // すべてのリンクが同じ TRPCLink<TRouter> 型を返す
  export function httpLink<TRouter extends AnyRouter>(...): TRPCLink<TRouter>
  export function wsLink<TRouter extends AnyRouter>(...): TRPCLink<TRouter>
  export function unstable_localLink<TRouter extends AnyRouter>(...): TRPCLink<TRouter>
  ```

- **validate/fetch 分離によるバッチ制御**: `BatchLoader` は `validate` で事前にバッチの妥当性を検査し、`fetch` で実際のリクエストを送る。URL 長制限など環境固有の制約をバッチロジックから分離できる。
  ```typescript
  // packages/client/src/internals/dataLoader.ts:13-16
  export type BatchLoader<TKey, TValue> = {
    validate: (keys: TKey[]) => boolean;
    fetch: (keys: TKey[]) => Promise<TValue[] | Promise<TValue>[]>;
  };
  ```

- **once によるサンクのメモ化**: lazy router のローダーは `once` で包まれ、同一ルーターの並行呼び出しでも二重ロードが発生しない。
  ```typescript
  // packages/server/src/unstable-core-do-not-import/router.ts:90-99
  function once<T>(fn: () => T): () => T {
    const uncalled = Symbol();
    let result: T | typeof uncalled = uncalled;
    return (): T => {
      if (result === uncalled) result = fn();
      return result;
    };
  }
  ```

- **ブランドマーカーによる型レベルの判別**: `lazyMarker` や `middlewareMarker` をブランド型として使い、ランタイムでの型判別と TypeScript の型推論を両立している。
  ```typescript
  // packages/server/src/unstable-core-do-not-import/router.ts:80-81
  const lazyMarker = "lazyMarker" as "lazyMarker" & { __brand: "lazyMarker"; };
  ```

## Anti-Patterns / 注意点

- **Terminating link の欠落**: リンクチェーンの末端に terminating link（httpLink, wsLink 等）を配置し忘れると、`createChain` がランタイムエラーを投げる。型レベルではこの制約が表現されていない。
  ```typescript
  // Bad: terminating link がない
  const client = createTRPCClient({
    links: [loggerLink(), retryLink({ retry: () => true })],
  });
  // -> "No more links to execute - did you forget to add an ending link?"

  // Better: 末端に httpLink を配置
  const client = createTRPCClient({
    links: [loggerLink(), retryLink({ retry: () => true }), httpLink({ url: "/api/trpc" })],
  });
  ```

- **ミドルウェアで next() を忘れる**: サーバーミドルウェアで `next()` を呼ばずに戻ると、結果が `undefined` となり INTERNAL_SERVER_ERROR が発生する。
  ```typescript
  // Bad: next() を呼ばない
  t.middleware(async (opts) => {
    console.log("logging");
    // return opts.next() を忘れている
  });

  // Better: 必ず next() の結果を返す
  t.middleware(async (opts) => {
    console.log("logging");
    return opts.next();
  });
  ```

- **lazy router の同期的アクセス**: lazy でラップしたルーターのプロシージャに `_def.procedures` から直接アクセスすると、まだロードされていない可能性がある。必ず `getProcedureAtPath` 経由でアクセスする必要がある。
  ```typescript
  // Bad: procedures マップに直接アクセス
  const proc = router._def.procedures["child.foo"]; // undefined の可能性

  // Better: getProcedureAtPath を使う（内部で lazy ロードを解決する）
  const proc = await getProcedureAtPath(router, "child.foo");
  ```

## 導出ルール

- `[MUST]` リクエストパイプラインの拡張ポイントを設計する際は、ハンドラに `next` コールバックを渡す Chain of Responsibility パターンを採用し、各ハンドラが後続を呼ぶかどうかを制御できるようにする
  - 根拠: tRPC のリンクチェーン（`createChain`）とミドルウェアチェーン（`callRecursive`）がともにこのパターンで、ロギング・リトライ・認証などの横断的関心事を独立して合成可能にしている

- `[MUST]` 遅延初期化のサンクには `once` パターン（1回だけ実行して結果をキャッシュ）を適用し、並行呼び出しによる二重実行を防止する
  - 根拠: lazy router の `createLazyLoader` は `once` でラップされ、並行テスト（`router.test.ts:96-114`）でも正しく動作することが検証されている

- `[SHOULD]` 拡張ポイントの各レイヤーをクロージャで分離し、「設定解決・初期化・リクエスト処理」の 3 段階スコープを持たせる
  - 根拠: tRPC のリンクは 3 層クロージャ構造で、設定の解決（1回）、アプリ初期化（1回）、リクエスト処理（N回）を明確に分離している

- `[SHOULD]` バッチ処理エンジンには validate/fetch を分離したインターフェースを採用し、環境固有の制約（URL 長、アイテム数上限）をバッチロジックから独立させる
  - 根拠: `BatchLoader` は `validate` で事前検査、`fetch` で実行を分離しており、`maxURLLength` や `maxItems` のような制約を宣言的に指定できる

- `[SHOULD]` 同じビジネスロジックを異なる呼び出し規約で再利用する必要がある場合、Procedure の「呼ばれ方」だけをオーバーライドする caller パターンを導入する
  - 根拠: `experimental_caller` により、tRPC プロシージャを通常の RPC 呼び出しとしても Next.js サーバーアクションとしても利用できる（`nextAppDirCaller.ts`）

- `[AVOID]` パイプラインの末端リンク（terminating link）の存在を型レベルで保証できない場合、ランタイムで明確なエラーメッセージを出す
  - 根拠: `createChain` は末端に到達した場合 `"No more links to execute"` という明示的エラーを投げ、デバッグを容易にしている

## 適用チェックリスト

- [ ] リクエスト処理パイプラインに Chain of Responsibility パターンを適用し、各ハンドラが `next` を通じて後続を制御できるようになっているか
- [ ] 拡張ポイント（リンク/ミドルウェア等）が統一インターフェースで定義され、異なる実装を差し替え可能か
- [ ] 遅延初期化が必要な箇所で `once` パターンによる二重実行防止が施されているか
- [ ] バッチ処理がある場合、バッチの妥当性検査（validate）と実行（fetch）が分離されているか
- [ ] パイプラインの設定解決・初期化・リクエスト処理がクロージャスコープで分離されているか
- [ ] 同じロジックを複数の呼び出し規約で再利用する必要がある場合、caller オーバーライドのような外部インターフェース差し替え機構を検討したか
- [ ] パイプラインの誤った構成（terminating handler の欠落等）に対して明確なランタイムエラーを出しているか
