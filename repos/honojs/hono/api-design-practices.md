# API Design Practices

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

メソッドチェーン、流暢な API、開発者体験重視の設計を横断的に分析した。Hono は「Web Standard に準拠しつつ、最小限のコードで最大の開発者体験を実現する」ことを API 設計の中核に据えている。ルート登録の Fluent API、Context の便利メソッド群、型安全な RPC クライアント、ミドルウェアのファクトリパターンなど、コードベース全体に一貫した設計哲学が浸透している点で注目に値する。

## 背景にある原則

- **書く量を減らし、読む量も減らす（Minimal Ceremony）**: API の呼び出しに必要なボイラープレートを極限まで削減すべき。なぜなら、利用者が書くコード量が少ないほど認知負荷が下がり、バグの混入機会も減るため。`c.json({ message: 'ok' })` 一行で Content-Type 設定・シリアライズ・Response 生成がすべて完結する設計（`src/context.ts:698-711`）がこの原則の典型。

- **プラットフォームの語彙を借用する（Web Standard Alignment）**: 独自の抽象を作るのではなく、`Request`/`Response`/`Headers` など Web Standard API の語彙をそのまま使うべき。なぜなら、学習済み知識をそのまま転用でき、エコシステムとの互換性も保たれるため。`c.req.raw` で生の `Request` に直接アクセスできる設計（`src/request.ts:51`）や、`fetch` シグネチャの採用（`src/hono-base.ts:473-479`）が根拠。

- **型がドキュメントになる（Types as Documentation）**: TypeScript の型システムを活用して、利用者がエディタの補完だけで正しい API を使えるようにすべき。なぜなら、外部ドキュメントを参照する手間を省き、コンパイル時に誤用を検出できるため。`HandlerInterface`（`src/types.ts:128-548`）の大量のオーバーロードは、`path` と `handler` の組み合わせごとに型推論を効かせるための意図的設計。

- **デフォルトを賢く、カスタマイズは常に可能に（Smart Defaults, Full Escape Hatches）**: ゼロコンフィグで動作しつつ、すべての挙動をオーバーライドできるべき。`cors()` を引数なしで呼べば `origin: '*'` で動作し、細かい制御が必要なら全オプションを指定できる（`src/middleware/cors/index.ts:63-73`）。

## 実例と分析

### Fluent API によるルート登録チェーン

Hono の `app.get().post().put()` チェーンは、各 HTTP メソッド呼び出しが `return this as any`（`src/hono-base.ts:139`）を返すことで実現している。重要なのは、パスを省略した場合は直前のパスが再利用される点。

```typescript
// src/hono-base.ts:129-141
const allMethods = [...METHODS, METHOD_NAME_ALL_LOWERCASE];
allMethods.forEach((method) => {
  this[method] = (args1: string | H, ...args: H[]) => {
    if (typeof args1 === "string") {
      this.#path = args1;
    } else {
      this.#addRoute(method, this.#path, args1);
    }
    args.forEach((handler) => {
      this.#addRoute(method, this.#path, handler);
    });
    return this as any;
  };
});
```

第1引数が `string` か `Function` かで分岐するユニオン型引数パターンにより、`app.get('/path', handler)` と `app.get(handler)` の両方を同じメソッドで受け付ける。これはユーザーの記述量を減らすが、型安全性を維持するために `HandlerInterface` で 10 以上のオーバーロードを定義する必要がある。

### Context の便利メソッド群とファストパス最適化

`c.text()`, `c.json()`, `c.html()`, `c.redirect()` は単なるシンタックスシュガーではない。`c.text()` では、ヘッダーもステータスも設定されていない最も一般的なケースで `new Response(text)` を直接返すファストパスが設けられている。

```typescript
// src/context.ts:672-684
text: TextRespond = (
  text: string,
  arg?: ContentfulStatusCode | ResponseOrInit,
  headers?: HeaderRecord,
): ReturnType<TextRespond> => {
  return !this.#preparedHeaders && !this.#status && !arg && !headers && !this.finalized
    ? (new Response(text) as ReturnType<TextRespond>)
    : (this.#newResponse(
      text,
      arg,
      setDefaultContentType(TEXT_PLAIN, headers),
    ) as ReturnType<TextRespond>);
};
```

これは「便利 API は抽象化のコストをゼロに近づけるべき」という原則の表れ。ホットパスの条件分岐で不要なオブジェクト生成を回避している。

### 遅延初期化によるゼロコスト抽象化

`Context` の `req` プロパティは getter + `??=`（nullish coalescing assignment）で遅延初期化される。`HonoRequest` オブジェクトはアクセスされるまで生成されない。

```typescript
// src/context.ts:356-359
get req(): HonoRequest<P, I['out']> {
  this.#req ??= new HonoRequest(this.#rawRequest, this.#path, this.#matchResult)
  return this.#req
}
```

同パターンは `bodyCache`（`src/request.ts:215`）、`#preparedHeaders`（`src/context.ts:395`）、`#var` Map（`src/context.ts:544`）でも使われており、コードベース全体で一貫している。

### ミドルウェアのファクトリ関数パターン

すべてのビルトインミドルウェアが「オプションオブジェクトを受け取り `MiddlewareHandler` を返すファクトリ関数」として統一されている。

```typescript
// src/middleware/cors/index.ts:63
export const cors = (options?: CORSOptions): MiddlewareHandler => { ... }

// src/middleware/logger/index.ts:81
export const logger = (fn: PrintFunc = console.log): MiddlewareHandler => { ... }

// src/middleware/bearer-auth/index.ts:103
export const bearerAuth = (options: BearerAuthOptions): MiddlewareHandler => { ... }
```

名前付き関数式 `return async function cors(c, next)` の採用（`src/middleware/cors/index.ts:99`）も一貫しており、スタックトレースの可読性を意図的に確保している。

### Proxy オブジェクトによる RPC クライアント

`hc()` は JavaScript の `Proxy` を使い、ルートパス構造をプロパティアクセスチェーンに変換する。

```typescript
// src/client/client.ts:15-31
const createProxy = (callback: Callback, path: string[]) => {
  const proxy: unknown = new Proxy(() => {}, {
    get(_obj, key) {
      if (typeof key !== "string" || key === "then") {
        return undefined;
      }
      return createProxy(callback, [...path, key]);
    },
    apply(_1, _2, args) {
      return callback({
        path,
        args,
      });
    },
  });
  return proxy;
};
```

`key === 'then'` のチェック（16行目）は、`await` 時に `thenable` として扱われないための防御。この Proxy パターンにより `client.api.users.$get()` のような記述が可能になり、サーバー側の型定義がそのままクライアント側の型として伝搬する。

### 関数オーバーロードによる柔軟な引数パターン

`c.req.param()` はキーありで `string` を、キーなしで `Record<string, string>` を返す。`c.req.query()` も同様。

```typescript
// src/request.ts:94-102
param<P2 extends ParamKeys<P> = ParamKeys<P>>(key: P2 extends `${infer _}?` ? never : P2): string
param<P2 extends RemoveQuestion<ParamKeys<P>> = RemoveQuestion<ParamKeys<P>>>(
  key: P2
): string | undefined
param(key: string): string | undefined
param<P2 extends string = P>(): Simplify<UnionToIntersection<ParamKeyToRecord<ParamKeys<P2>>>>
param(key?: string): unknown {
  return key ? this.#getDecodedParam(key) : this.#getAllDecodedParams()
}
```

「1つのメソッドで複数のユースケースを賢く処理する」設計だが、オーバーロードシグネチャの管理コストは高い。

### ミドルウェア合成の高階関数

`some()`, `every()`, `except()` は論理演算子の語彙でミドルウェアを合成する。

```typescript
// src/middleware/combine/index.ts:38
export const some = (...middleware: (MiddlewareHandler | Condition)[]): MiddlewareHandler => { ... }

// src/middleware/combine/index.ts:99
export const every = (...middleware: (MiddlewareHandler | Condition)[]): MiddlewareHandler => { ... }

// src/middleware/combine/index.ts:141
export const except = (
  condition: string | Condition | (string | Condition)[],
  ...middleware: MiddlewareHandler[]
): MiddlewareHandler => { ... }
```

入力も出力も `MiddlewareHandler` であるため、任意にネスト可能。`except('/api/public/*', bearerAuth({ token }))` のように文字列パスも条件として受け付ける柔軟性がある。

## パターンカタログ

- **Builder Pattern** (分類: 生成)
  - 解決する問題: 複数のオプション設定を宣言的に組み立てる
  - 適用条件: 設定の組み合わせが多く、段階的な構築が読みやすい場合
  - コード例: `src/hono-base.ts:129-141` （`app.get('/path', handler).post('/path', handler)` チェーン）
  - 注意点: `return this as any` により型安全性を犠牲にしているが、`HandlerInterface` のオーバーロードで補完

- **Factory Method** (分類: 生成)
  - 解決する問題: ミドルウェアの生成を設定と分離する
  - 適用条件: 同じ種類のオブジェクトを異なるオプションで生成する場合
  - コード例: `src/middleware/cors/index.ts:63`, `src/helper/factory/index.ts:332-361`
  - 注意点: ファクトリと直接コンストラクタの使い分けは利用者の認知負荷に影響する

- **Proxy Pattern** (分類: 構造)
  - 解決する問題: API のパス構造を型安全なプロパティチェーンに変換する
  - 適用条件: サーバーとクライアントの型を共有し、エンドポイントへのアクセスを型安全にしたい場合
  - コード例: `src/client/client.ts:15-31`
  - 注意点: デバッグ困難、`then` プロパティアクセスの罠（Promise 互換性）への防御が必須

- **Chain of Responsibility** (分類: 振る舞い)
  - 解決する問題: リクエスト処理を複数のハンドラに分散する
  - 適用条件: 前処理・認証・ロギング・エラーハンドリングを独立したモジュールで管理したい場合
  - コード例: `src/compose.ts:15-73`（koa-compose ベースのミドルウェアチェーン）
  - 注意点: `next()` の呼び忘れや二重呼び出しのガードが必要（`src/compose.ts:33-35`）

## Good Patterns

- **統一された関数シグネチャ**: ミドルウェアを含む全ハンドラが `(c: Context, next: Next) => Response | Promise<Response>` の統一シグネチャを持つ。ハンドラとミドルウェアの境界が曖昧になることで、同じ関数をどちらとしても使える柔軟性が生まれる。

```typescript
// src/types.ts:77-96
export type Handler<E, P, I, R> = (c: Context<E, P, I>, next: Next) => R;
export type MiddlewareHandler<E, P, I, R> = (c: Context<E, P, I>, next: Next) => Promise<R | void>;
export type H<E, P, I, R> = Handler<E, P, I, R> | MiddlewareHandler<E, P, I, R>;
```

- **名前付き関数式でスタックトレースを明示**: 全ミドルウェアが `return async function cors(c, next)` のように名前付き関数式を使い、デバッグ時のスタックトレースを読みやすくしている。

```typescript
// src/middleware/cors/index.ts:99
return async function cors(c, next) { ... }

// src/middleware/combine/index.ts:39
return async function some(c, next) { ... }

// src/middleware/bearer-auth/index.ts:153
return async function bearerAuth(c, next) { ... }
```

- **テスト容易性の組み込み**: `app.request()` メソッドと `testClient` ヘルパーにより、HTTP サーバーを起動せずにハンドラをテストできる。テストのためのインフラではなく、API 自体にテスト容易性が埋め込まれている。

```typescript
// src/hono-base.ts:493-511
request = (input: RequestInfo | URL, requestInit?: RequestInit, ...): Response | Promise<Response> => {
  // ...
  return this.fetch(new Request(
    /^https?:\/\//.test(input) ? input : `http://localhost${mergePath('/', input)}`,
    requestInit
  ), Env, executionCtx)
}

// src/helper/testing/index.ts:16-27
export const testClient = <T extends Hono<any, Schema, string>>(app: T, ...): Client<T, ...> => {
  const customFetch = (input, init) => app.request(input, init, Env, executionCtx)
  return hc<typeof app, 'http://localhost'>('http://localhost', { ...options, fetch: customFetch })
}
```

## Anti-Patterns / 注意点

- **過剰なオーバーロードの型定義コスト**: `HandlerInterface` は handler x1 から handler x10 まで、path あり/なしで 20 以上のオーバーロードを持つ（`src/types.ts:128-548+`）。型安全性は得られるが、型のコンパイル時間と型定義のメンテナンスコストが指数的に増大する。

```typescript
// Bad: オーバーロード数が手動管理される
// app.get(handler x2), app.get(handler x3), ..., app.get(handler x10)
// それぞれに path あり/なしで 2 パターン = 20+ のシグネチャ

// Better: 可能であれば可変長引数の型推論（TypeScript 5.x の改善を活用）
// または、型の自動生成スクリプトを設ける
```

- **`return this as any` による型の断絶**: メソッドチェーンの戻り値で `as any` を使うと、チェーン途中の型エラーが検出されにくくなる。

```typescript
// Bad: src/hono-base.ts:139
return this as any; // 型チェックがここで途切れる

// Better: ジェネリック型パラメータを正確に返す
// （ただし TypeScript の制約上、this の型を正確に返すのは困難な場合がある）
```

## 導出ルール

- `[MUST]` API の便利メソッドでは、最も一般的な使用パターンにファストパス（条件分岐による最適化パス）を設けて抽象化コストをゼロに近づける
  - 根拠: `c.text()` はヘッダー/ステータス未設定時に `new Response(text)` を直接返すファストパスを持ち、便利メソッドのオーバーヘッドを除去している（`src/context.ts:677`）

- `[MUST]` ファクトリ関数から返すミドルウェアや非同期ハンドラには名前付き関数式を使い、スタックトレースでの識別性を確保する
  - 根拠: 全ビルトインミドルウェアが `return async function cors(c, next)` 形式で統一されており（`src/middleware/cors/index.ts:99` 他多数）、デバッグ時に匿名関数の羅列にならない

- `[SHOULD]` 頻繁にアクセスされるがすべてのリクエストで必要とは限らないオブジェクトは、`??=`（nullish coalescing assignment）による遅延初期化で生成コストを先送りする
  - 根拠: `Context.req`（`src/context.ts:357`）、`bodyCache`（`src/request.ts:215`）、`#var` Map（`src/context.ts:544`）などコードベース全体で一貫して適用されている

- `[SHOULD]` 同じ抽象レベルの操作は統一されたシグネチャで設計し、入力も出力も同じ型にすることで合成可能性を確保する
  - 根拠: ミドルウェアが入力・出力ともに `MiddlewareHandler` であるため `some()`, `every()`, `except()` による自由な合成が可能（`src/middleware/combine/index.ts`）

- `[SHOULD]` オプション引数はオブジェクト形式で受け取り、すべてのフィールドに合理的なデフォルト値を設定して引数なし呼び出しを可能にする
  - 根拠: `cors()`, `logger()`, `prettyJSON()` がすべて引数なしで動作し、必要に応じてオプションで挙動を変更できる設計で統一されている

- `[SHOULD]` Proxy を使って型安全なプロパティチェーン API を構築する場合、`then` プロパティへのアクセスに対して `undefined` を返すガードを設ける
  - 根拠: `await proxy` で意図しない Promise 解決が発生する問題を `key === 'then'` チェックで防御している（`src/client/client.ts:18-19`）

- `[AVOID]` 便利さのために関数の引数型をユニオンにする（`string | Function`）際、オーバーロードシグネチャなしで実装すること。手動管理のオーバーロード数が爆発するリスクがあるため、型生成の自動化を検討する
  - 根拠: `HandlerInterface` のオーバーロード定義は 700 行以上に及び（`src/types.ts`）、メンテナンスの困難さがコメントやコード構造から推測される

## 適用チェックリスト

- [ ] 公開 API の各メソッドが「最も一般的な呼び出し」でボイラープレートなしに動作するか確認する
- [ ] ファクトリ関数から返すクロージャに名前付き関数式を使っているか（`return async function myName()` 形式）
- [ ] 頻繁に使われるが常に必要ではないプロパティに遅延初期化（`??=` パターン）を適用しているか
- [ ] ミドルウェアや Plugin の設計で、入力と出力の型を統一して合成可能にしているか
- [ ] オプション引数を持つ API にデフォルト値を設定し、引数なし呼び出しが可能か
- [ ] プラットフォーム標準 API（`Request`, `Response`, `Headers` 等）をラップする場合、生のオブジェクトへのエスケープハッチ（`.raw` 等）を提供しているか
- [ ] TypeScript のオーバーロードシグネチャが手動管理で肥大化していないか、自動生成の余地がないか検討する
