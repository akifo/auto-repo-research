# Pattern: Middleware Composition

> 出典: [repos/honojs/hono](../repos/honojs/hono/)
> カテゴリ: pattern

## 概要

ファクトリ関数・名前付き関数式・クロージャ事前計算の三位一体によるミドルウェア合成パターン。すべてのミドルウェアを同一シグネチャ `(context, next) => Promise<Response | void>` に統一し、合成結果をさらに合成に渡せる代数的閉包性を実現する。HTTP フレームワークに限らず、プラグインシステムやパイプライン処理を設計するあらゆる場面で即座に採用できるベストプラクティスである。

## 背景・文脈

Hono は 25 種の組み込みミドルウェアすべてを `(options?) => async function middlewareName(c, next) { ... }` という統一パターンで実装している。この設計は以下の3つの要素を組み合わせている:

1. **ファクトリ関数パターン**: オプションを受け取り、ミドルウェア関数を返す
2. **名前付き関数式**: 返される関数に名前を付け、スタックトレースで識別可能にする
3. **クロージャ事前計算**: 設定値の解析・正規表現コンパイル・関数構築をファクトリ呼び出し時に1回だけ実行する

さらに `compose` 関数による onion-ring モデルと、`some`/`every`/`except` による論理演算合成を組み合わせ、宣言的なミドルウェア結合を可能にしている。

## 実装パターン

### 1. ファクトリ関数 + 名前付き関数式 + クロージャ事前計算

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

  // 名前付き関数式で返却 -- スタックトレースに "cors" と表示される
  return async function cors(c, next) {
    const allowOrigin = await findAllowOrigin(c.req.header("origin") || "", c);
    // ...
  };
};
```

### 2. onion-ring 合成エンジン

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
        throw new Error("next() called multiple times"); // 不変量ガード
      }
      index = i;
      // ... ハンドラの実行
    }
  };
};
```

### 3. 論理演算合成 -- プリミティブの組み合わせ

```typescript
// src/middleware/combine/index.ts:141-165
// except は some と every の合成で実現されている
export const except = (
  condition: string | Condition | (string | Condition)[],
  ...middleware: MiddlewareHandler[]
): MiddlewareHandler => {
  // ... 条件の解析
  const handler = some(
    (c: Context) => conditions.some((cond) => cond(c)),
    every(...middleware),
  );
  return async function except(c, next) {
    await handler(c, next);
  };
};
```

## Good Example

```typescript
// ファクトリ関数: 設定の事前計算 + 名前付き関数式
const rateLimit = (options: RateLimitOptions): MiddlewareHandler => {
  // ファクトリ呼び出し時に1回だけ実行
  const maxRequests = options.max ?? 100;
  const windowMs = options.windowMs ?? 60_000;
  const keyExtractor = options.keyBy ?? ((c) => c.req.header("x-forwarded-for") || "unknown");
  const store = new Map<string, { count: number; resetAt: number; }>();

  // 名前付き関数式でスタックトレースの可読性を確保
  return async function rateLimit(c, next) {
    const key = keyExtractor(c);
    const now = Date.now();
    const record = store.get(key);

    if (record && record.resetAt > now && record.count >= maxRequests) {
      throw new HTTPException(429, { message: "Too Many Requests" });
    }
    // ...
    await next();
  };
};

// 論理合成で柔軟に適用
app.use(
  except(
    "/health", // ヘルスチェックは除外
    every(rateLimit({ max: 50 }), cors()), // 残りには両方適用
  ),
);
```

## Bad Example

```typescript
// Bad: 無名アロー関数 -- スタックトレースに名前が出ない
const rateLimit = (options) => {
  return async (c, next) => { // anonymous function
    // ...
  };
};

// Bad: リクエストごとに設定を解析
const cors = (options) => {
  return async (c, next) => {
    // 毎リクエストで分岐と関数構築が走る
    const findOrigin = typeof options.origin === "string"
      ? () => options.origin
      : (o) => options.origin.includes(o) ? o : null;
    // ...
  };
};

// Bad: next() の多重呼び出しに無防備
const middleware = async (c, next) => {
  if (condition) {
    await next();
  }
  await next(); // 条件次第で二重呼び出し
};

// Bad: ファクトリ内でリクエスト固有の処理を行う
const myMiddleware = (opts) => {
  const data = fetchSomething(); // 起動時に1回だけ実行 -- 全リクエストで同じ値
  return async (c, next) => {
    c.set("data", data);
    await next();
  };
};
```

## 適用ガイド

### どのような状況で使うべきか

- HTTP フレームワークのミドルウェア/プラグインシステム設計
- CLI ツールのコマンドパイプライン
- イベント処理チェーン（WebSocket, メッセージキュー）
- バリデーション/トランスフォームパイプライン

### 導入時の注意点

- **合成の代数的閉包性を維持する**: 合成関数の入力と出力を同一シグネチャにし、合成結果をさらに合成に渡せるようにする
- **`next()` 多重呼び出しの不変量ガード**: インデックス比較でチェーンの逆走を検出し、明示的にエラーをスローする
- **ファクトリ時 vs リクエスト時の境界を明確に**: 設定の前計算はファクトリ時、リクエスト固有の処理はハンドラ内で行う
- **単一ハンドラの高速パス**: ハンドラが1つの場合は `compose` をスキップしてダイレクトコールする

### カスタマイズポイント

- オプション引数はオブジェクト形式 + 合理的なデフォルト値で、引数なし呼び出しを可能に
- 合成プリミティブ（AND/OR/NOT）を小さく定義し、複雑な合成は組み合わせで構築
- 合成ラッパーで元のハンドラへの参照を保持し、検査・アンラップ可能にする

## 参考

- [repos/honojs/hono/composition-patterns.md](../repos/honojs/hono/composition-patterns.md) — onion-ring 合成、論理演算合成の詳細分析
- [repos/honojs/hono/extensibility-mechanisms.md](../repos/honojs/hono/extensibility-mechanisms.md) — ファクトリパターン、プリセット、Declaration Merging 拡張の分析
- [repos/honojs/hono/api-design-practices.md](../repos/honojs/hono/api-design-practices.md) — Fluent API、遅延初期化の分析
