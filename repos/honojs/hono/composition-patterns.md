# Composition Patterns

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

ミドルウェア合成・関数パイプライン・デコレータ的パターンの技法を横断的に分析する。このコードベースでは Koa 由来の onion-ring ミドルウェアモデルを中心に、ファクトリ関数によるクロージャ合成、論理演算によるミドルウェア結合（`some`/`every`/`except`）、Strategy パターンによるルーター合成など、多層的な合成技法が体系的に適用されている。特に注目に値するのは、合成の各レイヤーが同一シグネチャ `(c, next) => Promise<Response | void>` に統一されている点で、これによりミドルウェアの再帰的合成・入れ子・論理結合がすべて型安全に実現されている。

## 背景にある原則

- **統一シグネチャ原則**: すべてのミドルウェアとハンドラが `(context, next) => Promise<Response | void>` という同一インターフェースに準拠する。合成結果も同じシグネチャを返すため、`compose` の出力をさらに `compose` に渡す再帰的合成が可能になる（`src/compose.test.ts:626-649` の「compose w/ other compositions」テストで実証）。これにより関数合成の代数的閉包性が保たれる。

- **設定のクロージャ封入原則**: ミドルウェアファクトリは設定値をクロージャに閉じ込め、返却するミドルウェア関数からは設定の詳細を隠蔽する。設定の解析・バリデーション・前計算をファクトリ呼び出し時（1回だけ）に実行し、リクエストごとに実行されるミドルウェア本体では事前計算済みの値のみを参照する（`src/middleware/cors/index.ts:75-97` の `findAllowOrigin` 構築、`src/middleware/bearer-auth/index.ts:114-117` の正規表現コンパイル）。

- **合成による関心の分離原則**: 認証・レート制限・CORS などの横断的関心事を個別のミドルウェアとして独立実装し、`some`/`every`/`except` で論理的に結合する。各ミドルウェアは他のミドルウェアの存在を知らず、結合ロジックのみが組み合わせ方を決定する（`src/middleware/combine/index.ts`）。これは制御フローの宣言的記述を可能にする。

- **遅延選択原則**: SmartRouter は複数のルーター実装を保持し、最初のルーティング時に最適なルーターを自動選択してバインドする。選択後は `this.match` を選ばれたルーターの `match` に直接差し替え、以降のルーティングではオーバーヘッドなしで実行される（`src/router/smart-router/router.ts:46`）。初期化コストを最初のリクエストに遅延させることで、構成の柔軟性と実行時性能を両立させている。

## 実例と分析

### Onion-ring ミドルウェア合成

`compose` 関数は koa-compose を基盤とし、再帰的な `dispatch` 関数でミドルウェアチェーンを構築する。各ミドルウェアは `await next()` の前後に処理を配置でき、リクエストの前処理とレスポンスの後処理を1つの関数内で表現する。

`index` 変数による `next()` 多重呼び出し検知（`src/compose.ts:33-35`）は、合成の不変量を保護する重要なガードである。これがなければミドルウェアチェーンが非決定的な順序で実行され、副作用の追跡が不可能になる。

### 単一ハンドラの高速パス

`hono-base.ts:424-442` では、マッチしたハンドラが1つだけの場合に `compose` を呼ばず直接実行する最適化が施されている。`compose` は `dispatch` 関数のクロージャ生成とインデックス管理を伴うため、単純なルートでは不要なオーバーヘッドとなる。これはホットパスの合成コストを排除するプラクティスである。

### ファクトリ関数によるミドルウェア設定

コードベース全体で、ミドルウェアは一貫して「ファクトリ関数がオプションを受け取り、ミドルウェア関数を返す」パターンで実装される。最も単純な例は `poweredBy`（5行のミドルウェア本体）、最も複雑な例は `bearerAuth`（正規表現コンパイル、ヘルパー関数定義をファクトリ内で完結）。

特筆すべきは、返されるミドルウェア関数に名前を付けている慣習である（`return async function cors(c, next)` のように）。無名関数ではなく名前付き関数を返すことで、スタックトレースにミドルウェア名が表示され、デバッグ時の追跡性が向上する。

### 論理演算によるミドルウェア結合

`combine` モジュールは `some`（OR 合成）、`every`（AND 合成）、`except`（否定的条件付き合成）の3つの高階関数を提供する。これらは入力としてミドルウェアまたは条件関数（`(c: Context) => boolean`）を受け取り、出力として単一のミドルウェアを返す。

`except` の実装は `some` と `every` を内部で再利用しており（`src/middleware/combine/index.ts:161`）、プリミティブな合成演算から複雑な合成を構築する手法の好例である。

### sub-app 合成とエラーハンドラの伝播

`route()` メソッドは別の Hono インスタンスのルートを取り込む際、子アプリのエラーハンドラがデフォルトと異なる場合のみ `compose` でラップする（`src/hono-base.ts:220-226`）。このとき `COMPOSED_HANDLER` シンボルを使って元のハンドラへの参照を保持し、`findTargetHandler` で再帰的にアンラップ可能にしている。これは合成によるラッピングが「透過的」であることを保証するプラクティスである。

### AsyncLocalStorage によるコンテキスト伝播

`contextStorage` ミドルウェアは `asyncLocalStorage.run(c, next)` という1行でコンテキストをミドルウェアチェーン全体に伝播する（`src/middleware/context-storage/index.ts:44-46`）。ミドルウェア合成モデルと AsyncLocalStorage の組み合わせにより、明示的な引数渡しなしに任意の深さの関数呼び出しからコンテキストにアクセスできる。

## コード例

### onion-ring 合成エンジン

```typescript
// src/compose.ts:15-73
export const compose = <E extends Env = Env>(
  middleware: [[Function, unknown], unknown][] | [[Function]][],
  onError?: ErrorHandler<E>,
  onNotFound?: NotFoundHandler<E>,
): (context: Context, next?: Next) => Promise<Context> => {
  return (context, next) => {
    let index = -1;
    return dispatch(0);
    async function dispatch(i: number): Promise<Context> {
      if (i <= index) {
        throw new Error("next() called multiple times");
      }
      index = i;
      let res;
      let isError = false;
      let handler;
      if (middleware[i]) {
        handler = middleware[i][0][0];
      } else {
        handler = (i === middleware.length && next) || undefined;
      }
      if (handler) {
        try {
          res = await handler(context, () => dispatch(i + 1));
        } catch (err) {
          if (err instanceof Error && onError) {
            context.error = err;
            res = await onError(err, context);
            isError = true;
          } else {
            throw err;
          }
        }
      } else {
        if (context.finalized === false && onNotFound) {
          res = await onNotFound(context);
        }
      }
      if (res && (context.finalized === false || isError)) {
        context.res = res;
      }
      return context;
    }
  };
};
```

### ファクトリ関数での前計算クロージャ

```typescript
// src/middleware/cors/index.ts:63-97
export const cors = (options?: CORSOptions): MiddlewareHandler => {
  const defaults: CORSOptions = {
    origin: "*",
    allowMethods: ["GET", "HEAD", "PUT", "POST", "DELETE", "PATCH"],
    allowHeaders: [],
    exposeHeaders: [],
  };
  const opts = { ...defaults, ...options };

  // 設定値の型に基づく関数の事前構築 -- リクエストごとに分岐しない
  const findAllowOrigin = ((optsOrigin) => {
    if (typeof optsOrigin === "string") {
      if (optsOrigin === "*") {
        return () => optsOrigin;
      } else {
        return (origin: string) => (optsOrigin === origin ? origin : null);
      }
    } else if (typeof optsOrigin === "function") {
      return optsOrigin;
    } else {
      return (origin: string) => (optsOrigin.includes(origin) ? origin : null);
    }
  })(opts.origin);

  return async function cors(c, next) {
    const allowOrigin = await findAllowOrigin(c.req.header("origin") || "", c);
    // ...
  };
};
```

### 単一ハンドラの高速パス

```typescript
// src/hono-base.ts:423-442
// Do not `compose` if it has only one handler
if (matchResult[0].length === 1) {
  let res: ReturnType<H>;
  try {
    res = matchResult[0][0][0][0](c, async () => {
      c.res = await this.#notFoundHandler(c);
    });
  } catch (err) {
    return this.#handleError(err, c);
  }
  return res instanceof Promise
    ? res
      .then(
        (resolved: Response | undefined) => resolved || (c.finalized ? c.res : this.#notFoundHandler(c)),
      )
      .catch((err: Error) => this.#handleError(err, c))
    : (res ?? this.#notFoundHandler(c));
}
```

### SmartRouter の遅延バインディング

```typescript
// src/router/smart-router/router.ts:21-49
match(method: string, path: string): Result<T> {
  const routers = this.#routers
  const routes = this.#routes
  const len = routers.length
  let i = 0
  let res
  for (; i < len; i++) {
    const router = routers[i]
    try {
      for (let i = 0, len = routes.length; i < len; i++) {
        router.add(...routes[i])
      }
      res = router.match(method, path)
    } catch (e) {
      if (e instanceof UnsupportedPathError) {
        continue
      }
      throw e
    }
    // 選択後、自身の match を差し替え
    this.match = router.match.bind(router)
    this.#routers = [router]
    this.#routes = undefined
    break
  }
  // ...
}
```

### 論理演算合成 -- except は some と every の再合成

```typescript
// src/middleware/combine/index.ts:141-165
export const except = (
  condition: string | Condition | (string | Condition)[],
  ...middleware: MiddlewareHandler[]
): MiddlewareHandler => {
  let router: TrieRouter<true> | undefined = undefined;
  const conditions = (Array.isArray(condition) ? condition : [condition])
    .map((condition) => {
      if (typeof condition === "string") {
        router ||= new TrieRouter();
        router.add(METHOD_NAME_ALL, condition, true);
      } else {
        return condition;
      }
    })
    .filter(Boolean) as Condition[];

  if (router) {
    conditions.unshift((c: Context) => !!router?.match(METHOD_NAME_ALL, c.req.path)?.[0]?.[0]?.[0]);
  }
  // some と every を組み合わせて except を構築
  const handler = some((c: Context) => conditions.some((cond) => cond(c)), every(...middleware));
  return async function except(c, next) {
    await handler(c, next);
  };
};
```

## パターンカタログ

- **Chain of Responsibility** (分類: 振る舞い)
  - 解決する問題: 複数のミドルウェアが順序付きでリクエストを処理し、各段階で処理を中断・変更できる
  - 適用条件: HTTP リクエスト処理のように、横断的関心事を独立した処理単位に分離したい場合
  - コード例: `src/compose.ts:15-73`
  - 注意点: Onion-ring モデルは純粋な CoR と異なり、`next()` 後にレスポンスの後処理も可能。`await next()` の前後で異なるフェーズの処理を行える二方向パイプライン

- **Strategy** (分類: 振る舞い)
  - 解決する問題: 複数のルーティングアルゴリズムを交換可能にし、パスパターンに応じて最適な実装を選択する
  - 適用条件: 同一インターフェースの複数の実装が存在し、実行時に最適なものを選択したい場合
  - コード例: `src/router/smart-router/router.ts:4-70`
  - 注意点: 初回選択後に `this.match` を直接差し替えることで、以降は Strategy のディスパッチコストを排除している（Strategy の自己消去パターン）

- **Factory Method** (分類: 生成)
  - 解決する問題: ミドルウェアの設定と生成を分離し、設定の前処理を生成時に1度だけ行う
  - 適用条件: 設定可能なミドルウェア・ハンドラを提供し、呼び出し側は設定のみに集中させたい場合
  - コード例: `src/middleware/cors/index.ts:63`, `src/middleware/bearer-auth/index.ts:103`, `src/helper/factory/index.ts:353-355`
  - 注意点: `createMiddleware` は型推論の補助のみで実行時処理がない（identity function）。ファクトリの役割が型安全性の確保に限定される場合もある

- **Composite** (分類: 構造)
  - 解決する問題: 個々のミドルウェアと合成されたミドルウェアグループを同一のインターフェースで扱う
  - 適用条件: ミドルウェアの木構造的な合成が必要な場合（`some(a, every(b, c))` のようなネスト）
  - コード例: `src/middleware/combine/index.ts:38-165`
  - 注意点: 入力・出力が同じ `MiddlewareHandler` 型であるため、深いネストも型安全に構築できる

## Good Patterns

- **名前付きミドルウェア関数**: ファクトリから返す関数に名前を付与する慣習。全ミドルウェアで一貫して `return async function cors(c, next)` のように記述しており、`return async (c, next) =>` のアロー関数は使用していない。エラー発生時のスタックトレースで `at cors` のようにミドルウェア名が表示され、デバッグ効率が劇的に向上する。

```typescript
// src/middleware/logger/index.ts:82-83
export const logger = (fn: PrintFunc = console.log): MiddlewareHandler => {
  return async function logger(c, next) {
    // ...
  };
};
```

- **設定値の事前解決**: ファクトリ呼び出し時に設定の型判定と関数構築を完了させ、リクエストハンドラ内では事前構築済みの関数を呼ぶだけにする。CORS ミドルウェアの `findAllowOrigin` は即時実行関数で設定型に応じた最適な比較関数を1回だけ選択する。

```typescript
// src/middleware/cors/index.ts:75-87
const findAllowOrigin = ((optsOrigin) => {
  if (typeof optsOrigin === "string") {
    if (optsOrigin === "*") {
      return () => optsOrigin;
    } else {
      return (origin: string) => (optsOrigin === origin ? origin : null);
    }
  } else if (typeof optsOrigin === "function") {
    return optsOrigin;
  } else {
    return (origin: string) => (optsOrigin.includes(origin) ? origin : null);
  }
})(opts.origin);
```

- **合成プリミティブの組み合わせ**: `except` を `some` と `every` の合成で実装する手法。新しいプリミティブを追加せず、既存の合成演算の組み合わせで複雑なロジックを表現する。

```typescript
// src/middleware/combine/index.ts:161
const handler = some((c: Context) => conditions.some((cond) => cond(c)), every(...middleware));
```

- **合成ラッパーの透過性**: `route()` での sub-app 統合時、`COMPOSED_HANDLER` でラップ前の元ハンドラへの参照を保持する。`findTargetHandler` で再帰的にアンラップ可能にすることで、合成が検査可能（inspectable）になっている。

```typescript
// src/hono-base.ts:224-226
handler = async (c: Context, next: Next) => (await compose([], app.errorHandler)(c, () => r.handler(c, next))).res;
(handler as any)[COMPOSED_HANDLER] = r.handler;
```

## Anti-Patterns / 注意点

- **next() の多重呼び出し**: `compose` は `index` 変数で `next()` の多重呼び出しを検出し、明示的にエラーをスローする。これがなければ、ミドルウェアチェーンが複数回実行され、レスポンスの上書きやリソースの二重消費といった非決定的な動作が発生する。

```typescript
// Bad: next() を条件分岐の両方で呼ぶ
const middleware = async (c, next) => {
  if (condition) {
    await next();
    // 何か処理
  }
  await next(); // 条件次第で二重呼び出し
};

// Better: next() は必ず1回だけ呼ぶ
const middleware = async (c, next) => {
  if (condition) {
    // 前処理
  }
  await next();
  if (condition) {
    // 後処理
  }
};
```

- **ファクトリ内でのリクエスト依存処理**: ファクトリ関数内（クロージャの外側）でリクエスト固有の値を参照すると、最初のリクエストの値がすべてのリクエストに共有されてしまう。設定の前計算とリクエスト固有処理の境界を明確にする必要がある。

```typescript
// Bad: ファクトリ内でリクエスト固有の処理を行う
const myMiddleware = (opts) => {
  const data = fetchSomething(); // 起動時に1度だけ実行される
  return async (c, next) => {
    c.set("data", data); // 全リクエストで同じ値
    await next();
  };
};

// Better: リクエスト固有の処理はミドルウェア本体で行う
const myMiddleware = (opts) => {
  const config = validateOptions(opts); // 設定の前処理のみ
  return async function myMiddleware(c, next) {
    const data = await fetchSomething(config, c.req); // リクエストごとに実行
    c.set("data", data);
    await next();
  };
};
```

- **合成結果の finalize 漏れ**: `compose` はミドルウェアチェーン内でレスポンスが設定されない場合、`context.finalized` が `false` のまま返却される。`hono-base.ts:449-452` では明示的にこれを検出してエラーとしている。合成結果を使用する側は、必ず finalize 状態を検証すべきである。

```typescript
// src/hono-base.ts:449-452
if (!context.finalized) {
  throw new Error(
    "Context is not finalized. Did you forget to return a Response object or `await next()`?",
  );
}
```

## 導出ルール

- `[MUST]` ミドルウェア合成関数の入力と出力を同一のシグネチャに統一し、合成結果をさらに合成可能にする（代数的閉包性を保つ）
  - 根拠: `compose` の出力は `(context, next) => Promise<Context>` であり、これ自体を別の `compose` に渡せる設計が再帰的合成を可能にしている（`src/compose.test.ts:626-649`）

- `[MUST]` パイプライン中の `next()` の多重呼び出しを検出してエラーにする不変量ガードを設ける
  - 根拠: `src/compose.ts:33-35` でインデックス比較による多重呼び出し検知がなければ、レスポンスの上書きや副作用の重複実行が発生し、デバッグ困難な非決定的動作となる

- `[SHOULD]` ファクトリ関数から返すミドルウェア関数には名前を付与し、スタックトレースでの識別を可能にする
  - 根拠: コードベースの全25個のミドルウェアが一貫して `return async function <name>(c, next)` 形式を採用しており、エラー追跡時にミドルウェアの特定が容易になっている

- `[SHOULD]` ミドルウェアファクトリでは、設定値の解析・バリデーション・前計算をファクトリ呼び出し時に実行し、リクエストハンドラ本体では事前計算済みの値のみを参照する
  - 根拠: `src/middleware/cors/index.ts:75-97` で設定型に応じた比較関数を IIFE で1回だけ構築し、`src/middleware/bearer-auth/index.ts:116` で正規表現をファクトリ時にコンパイルすることでリクエストごとの再計算を排除している

- `[SHOULD]` 合成プリミティブ（AND/OR/NOT 等）を小さく定義し、複雑な合成をプリミティブの組み合わせで構築する
  - 根拠: `except` は `some` と `every` の合成で実現されており（`src/middleware/combine/index.ts:161`）、新しいプリミティブの追加なしに表現力を拡張している

- `[SHOULD]` ホットパスでは合成のオーバーヘッドが不要な場合（単一ハンドラ等）を検出して高速パスを設ける
  - 根拠: `src/hono-base.ts:424` の `matchResult[0].length === 1` チェックにより、大半のルートで `compose` のクロージャ生成とインデックス管理のオーバーヘッドを排除している

- `[AVOID]` 合成ラッパーで元のハンドラへの参照を失わせる -- 合成が「不透明な箱」になるとデバッグ・テスト・検査が困難になる
  - 根拠: `src/hono-base.ts:226` で `COMPOSED_HANDLER` を使い元ハンドラへの参照を保持し、`src/utils/handler.ts:9-15` の `findTargetHandler` で再帰的にアンラップ可能にしている

## 適用チェックリスト

- [ ] ミドルウェアの合成関数は入力と出力が同一の型シグネチャになっているか（合成結果をさらに合成に渡せるか）
- [ ] `next()` の多重呼び出しに対する防御ガードを合成関数に実装しているか
- [ ] ファクトリから返すミドルウェア関数に名前を付けているか（アロー関数ではなく名前付き関数式を使用）
- [ ] ファクトリ関数内での前計算（正規表現コンパイル、設定解析、関数構築）とリクエスト固有処理を明確に分離しているか
- [ ] 合成操作を小さなプリミティブに分解し、それらの組み合わせで複雑な合成を実現しているか
- [ ] 単一ハンドラなど合成が不要なケースに対する高速パスを検討しているか
- [ ] 合成ラッパーが元のハンドラへの参照を保持し、検査・アンラップが可能か
- [ ] ミドルウェアチェーンの終端で状態（finalized 等）が期待通りになっているかを検証しているか
