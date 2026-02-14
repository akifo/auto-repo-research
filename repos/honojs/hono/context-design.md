# Context Design

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono の `Context` クラスは、HTTP リクエスト/レスポンスのライフサイクルを1つのオブジェクトに集約し、ミドルウェアチェーン全体で共有されるリクエストスコープのコンテナである。特に注目に値するのは、`c.set()`/`c.get()` による型安全な変数ストアの設計で、TypeScript の Declaration Merging と条件付き型を組み合わせて、ランタイムの `Map<unknown, unknown>` に対してコンパイル時の型安全性を実現している。この二重レイヤー（`Env['Variables']` と `ContextVariableMap`）の設計は、アプリケーション固有の型定義とライブラリ提供の型定義を両立させる巧みなアプローチである。

## 設計思想

- **リクエストスコープの最小コスト原則**: Context はリクエストごとに `new` されるため、コンストラクタでの初期化を最小限にしている。`#req`（HonoRequest）、`#var`（変数ストア）、`#preparedHeaders` はすべて遅延初期化であり、使われなければアロケーションが発生しない。根拠: `src/context.ts:291` で `#req` は `undefined` 初期化、`src/context.ts:306` で `#var` も `undefined` 初期化、`src/context.ts:357` で `get req()` が `??=` で遅延生成する。

- **型安全性とランタイム柔軟性の分離**: 変数ストアの実体は `Map<unknown, unknown>` だが、TypeScript の型レベルでは `Env['Variables']` または `ContextVariableMap` による厳密なキー/値マッピングが強制される。これにより、ランタイムのオーバーヘッドをゼロに保ちながらコンパイル時の安全性を確保している。根拠: `src/context.ts:306` と `src/context.ts:90-103` の Get/Set インタフェース定義。

- **段階的型付け（Progressive Typing）**: `IsAny<E>` による条件分岐で、型パラメータが `any`（未指定）の場合は `ContextVariableMap & Record<string, any>` にフォールバックし、明示的に型が指定された場合はその型のみを許可する。これにより「まず動かす、次に型を足す」という段階的開発を可能にしている。根拠: `src/context.ts:536-543` と `src/context.ts:561-568`。

- **単一 Context、複数アクセスパターン**: 同じ変数ストアに対して `c.set()`/`c.get()` のメソッドアクセスと `c.var` のプロパティアクセスという2つの API を提供している。`c.var` は `Readonly` でラップされた読み取り専用ビューであり、ハンドラでの参照用、`c.set()`/`c.get()` はミドルウェアでの読み書き用という使い分けを型レベルで示唆している。根拠: `src/context.ts:582-592`。

## 設計・実装の詳細

### Context のライフサイクル

Context オブジェクトは `hono-base.ts` の `#dispatch` メソッドで各リクエストごとに生成される。

```typescript
// src/hono-base.ts:415-421
const c = new Context(request, {
  path,
  matchResult,
  env,
  executionCtx,
  notFoundHandler: this.#notFoundHandler,
})
```

生成された Context は `compose()` 関数を通じてミドルウェアチェーン全体で共有される。`compose()` は koa-compose に基づいたオニオン構造で、同一の `context` オブジェクトを全ミドルウェアに渡す。

```typescript
// src/compose.ts:49-51
if (handler) {
  try {
    res = await handler(context, () => dispatch(i + 1))
```

ライフサイクルの終了は `context.finalized = true` で示される。`c.res` のセッターが呼ばれるとフラグが立ち、以降のミドルウェアでレスポンスが確定済みであることを示す。

```typescript
// src/context.ts:404-424
set res(_res: Response | undefined) {
  if (this.#res && _res) {
    _res = new Response(_res.body, _res)
    for (const [k, v] of this.#res.headers.entries()) {
      if (k === 'content-type') {
        continue
      }
      // ... set-cookie の特殊処理
    }
  }
  this.#res = _res
  this.finalized = true
}
```

### 型安全な変数ストアの二重レイヤー設計

変数ストアの型安全性は2つの異なるメカニズムで実現されている。

**レイヤー1: `Env['Variables']`（アプリケーション固有型）**

```typescript
// src/types.ts:31-34
export type Env = {
  Bindings?: Bindings
  Variables?: Variables
}
```

アプリケーション開発者が `new Hono<{ Variables: { id: number; title: string } }>()` のように型パラメータを指定すると、`c.set('id', ...)` と `c.get('id')` の型がそれに従って推論される。

```typescript
// src/hono.test.ts:2344-2370
type Variables = { id: number; title: string }
const app = new Hono<{ Variables: Variables }>()

app.use('*', async (c, next) => {
  c.set('id', 123)      // number のみ許可
  c.set('title', 'Hello') // string のみ許可
  await next()
})
app.get('/', (c) => {
  const id = c.get('id')       // 型: number
  const title = c.get('title') // 型: string
  return c.text(`${id} is ${title}`)
})
```

**レイヤー2: `ContextVariableMap`（Declaration Merging によるグローバル型拡張）**

```typescript
// src/context.ts:52
export interface ContextVariableMap {}
```

この空のインタフェースは Declaration Merging のターゲットとして設計されている。ミドルウェアライブラリが自身の変数を型レベルで登録できる。

```typescript
// src/middleware/request-id/index.ts:5-7
declare module '../..' {
  interface ContextVariableMap extends RequestIdVariables {}
}
```

```typescript
// src/middleware/jwt/index.ts:7-9
declare module '../..' {
  interface ContextVariableMap extends JwtVariables {}
}
```

**二重レイヤーの統合: Get/Set インタフェースのオーバーロード**

```typescript
// src/context.ts:90-103
interface Get<E extends Env> {
  <Key extends keyof E['Variables']>(key: Key): E['Variables'][Key]
  <Key extends keyof ContextVariableMap>(key: Key): ContextVariableMap[Key]
}

interface Set<E extends Env> {
  <Key extends keyof E['Variables']>(key: Key, value: E['Variables'][Key]): void
  <Key extends keyof ContextVariableMap>(key: Key, value: ContextVariableMap[Key]): void
}
```

2つのオーバーロードにより、`Env['Variables']` で定義されたキーと `ContextVariableMap` で定義されたキーの両方が型安全にアクセスできる。

**`IsAny` による分岐**

型パラメータ `E` が `any`（Context のデフォルト）の場合、`Env['Variables']` の keyof は `string | number | symbol` となり全てのキーを受け入れてしまう。これを防ぐため `IsAny<E>` で分岐し、`any` の場合は `ContextVariableMap & Record<string, any>` を使用する。

```typescript
// src/context.ts:536-543
set: Set<
  IsAny<E> extends true
    ? {
        Variables: ContextVariableMap & Record<string, any>
      }
    : E
> = (key: string, value: unknown) => {
  this.#var ??= new Map()
  this.#var.set(key, value)
}
```

```typescript
// src/utils/types.ts:110
export type IsAny<T> = boolean extends (T extends never ? true : false) ? true : false
```

### 遅延初期化パターン

Context は複数のフィールドで `??=`（Nullish Coalescing Assignment）を使った遅延初期化を採用している。

```typescript
// src/context.ts:357 - HonoRequest の遅延生成
get req(): HonoRequest<P, I['out']> {
  this.#req ??= new HonoRequest(this.#rawRequest, this.#path, this.#matchResult)
  return this.#req
}

// src/context.ts:544 - 変数 Map の遅延生成
this.#var ??= new Map()

// src/context.ts:394-396 - Response の遅延生成
get res(): Response {
  return (this.#res ||= new Response(null, {
    headers: (this.#preparedHeaders ??= new Headers()),
  }))
}
```

### c.text() のファストパス

`c.text()` には、ヘッダーもステータスも設定されていない場合に `#newResponse` を経由せず直接 `new Response(text)` を返すファストパスがある。

```typescript
// src/context.ts:672-684
text: TextRespond = (
  text: string,
  arg?: ContentfulStatusCode | ResponseOrInit,
  headers?: HeaderRecord
): ReturnType<TextRespond> => {
  return !this.#preparedHeaders && !this.#status && !arg && !headers && !this.finalized
    ? (new Response(text) as ReturnType<TextRespond>)
    : (this.#newResponse(
        text,
        arg,
        setDefaultContentType(TEXT_PLAIN, headers)
      ) as ReturnType<TextRespond>)
}
```

### c.var の読み取り専用ビュー

`c.var` は `Object.fromEntries(this.#var)` で毎回新しいオブジェクトを生成し、`Readonly<>` 型でラップされている。

```typescript
// src/context.ts:582-592
get var(): Readonly<
  ContextVariableMap & (IsAny<E['Variables']> extends true ? Record<string, any> : E['Variables'])
> {
  if (!this.#var) {
    return {} as any
  }
  return Object.fromEntries(this.#var)
}
```

これにより、ハンドラ側から `c.var.foo = 'bar'` のような直接代入を型レベルで禁止している。ただし `Object.fromEntries` は毎回新しいオブジェクトを生成するため、頻繁にアクセスするとコスト増になる点に注意。

## パターンカタログ

- **Mediator パターン** (分類: 振る舞い)
  - 解決する問題: ミドルウェア間の直接的な依存を排除し、Context を介した間接的なデータ受け渡しを実現する
  - 適用条件: 複数のミドルウェアが順序付きで実行され、後続のミドルウェアが前のミドルウェアの結果を参照する必要がある場合
  - コード例: `src/compose.ts:49-51` でハンドラに同一の context を渡し、`src/middleware/jwt/jwt.ts:154` で `ctx.set('jwtPayload', payload)` によりデータを伝播
  - 注意点: Context に何でも詰め込むと God Object 化するため、変数名の衝突や責務の肥大化に注意

- **Lazy Initialization パターン** (分類: 生成)
  - 解決する問題: リクエストごとのオブジェクト生成コストを使用時まで遅延させる
  - 適用条件: 全てのリクエストが全てのフィールドを使うわけではないホットパス
  - コード例: `src/context.ts:357` の `this.#req ??=`, `src/context.ts:544` の `this.#var ??=`
  - 注意点: フィールド間の依存関係があると初期化順の問題が生じうる

- **Module Augmentation パターン** (分類: TypeScript 固有/構造)
  - 解決する問題: サードパーティミドルウェアが型情報を Context に安全に追加できるようにする
  - 適用条件: プラグイン/ミドルウェアアーキテクチャで、コアの型定義を変更せずに拡張したい場合
  - コード例: `src/context.ts:52` の空 `interface ContextVariableMap {}` と `src/middleware/jwt/index.ts:7-9` の Declaration Merging
  - 注意点: グローバルな型空間を汚染するため、キー名の衝突リスクがある

## Good Patterns

- **空インタフェースを Declaration Merging のフックとして活用**: `ContextVariableMap` を空インタフェースとしてエクスポートし、ミドルウェアが `declare module` で型を追加できるようにしている。これによりコアの型定義を変更せずにエコシステム全体の型安全性を実現している。

```typescript
// src/context.ts:52
export interface ContextVariableMap {}

// src/middleware/request-id/index.ts:5-7
declare module '../..' {
  interface ContextVariableMap extends RequestIdVariables {}
}
// RequestIdVariables = { requestId: string }
```

- **オーバーロードによるローカル型とグローバル型の統合**: Get/Set インタフェースの2つのオーバーロードにより、アプリケーション固有の型（`Env['Variables']`）とグローバルな型（`ContextVariableMap`）を統合している。開発者はどちらの定義方法を使っても同じ `c.get()`/`c.set()` API で型安全にアクセスできる。

```typescript
// src/context.ts:90-93
interface Get<E extends Env> {
  <Key extends keyof E['Variables']>(key: Key): E['Variables'][Key]
  <Key extends keyof ContextVariableMap>(key: Key): ContextVariableMap[Key]
}
```

- **Private フィールド（`#`）による内部状態の完全隠蔽**: `#rawRequest`, `#var`, `#res`, `#status` などすべての内部状態に ES2022 private fields を使用し、外部からのアクセスとプロトタイプチェーン汚染を完全に防いでいる。公開 API は getter/setter とメソッドのみ。

```typescript
// src/context.ts:290-334
#rawRequest: Request
#req: HonoRequest<P, I['out']> | undefined
#var: Map<unknown, unknown> | undefined
#status: StatusCode | undefined
#executionCtx: FetchEventLike | ExecutionContext | undefined
#res: Response | undefined
```

- **ミドルウェアが型付き Variables を `type` でエクスポート**: JWT, Request ID, Language, Timing 等の各ミドルウェアは、`c.set()` で書き込むキーの型を Variables 型としてエクスポートしている。これによりユーザーが `new Hono<{ Variables: JwtVariables }>()` として明示的に型を取り込むことも可能。

```typescript
// src/middleware/jwt/jwt.ts:18-20
export type JwtVariables<T = any> = {
  jwtPayload: T
}

// src/middleware/request-id/request-id.ts:9-11
export type RequestIdVariables = {
  requestId: string
}
```

## Anti-Patterns / 注意点

- **c.var の頻繁なアクセスによるオブジェクト生成コスト**: `c.var` は getter 内で `Object.fromEntries(this.#var)` を毎回呼ぶため、アクセスのたびに新しいオブジェクトが生成される。ループ内やホットパスで繰り返し `c.var` を参照すると不要なアロケーションが発生する。

```typescript
// Bad: ループ内で c.var を繰り返しアクセス
for (const item of items) {
  processItem(item, c.var.config) // 毎回 Object.fromEntries が走る
}

// Better: 変数にキャッシュする、または c.get() を使う
const config = c.get('config')
for (const item of items) {
  processItem(item, config)
}
```

- **ContextVariableMap のキー名衝突**: 複数のミドルウェアが同じキー名で異なる型を `ContextVariableMap` に登録すると、TypeScript の Declaration Merging ではプロパティが交差型（intersection）になり、実用上は `never` 型になりうる。

```typescript
// Bad: 異なるミドルウェアが同じキー名を使う
// middleware-a
declare module 'hono' {
  interface ContextVariableMap { user: { id: string } }
}
// middleware-b
declare module 'hono' {
  interface ContextVariableMap { user: { name: string } }
}
// 結果: c.get('user') の型は { id: string } & { name: string }

// Better: プレフィックスで名前空間を分ける
declare module 'hono' {
  interface ContextVariableMap { authUser: { id: string } }
}
```

- **`await next()` 前後での c.res アクセスの落とし穴**: `c.res` の getter は初回アクセス時に空の Response を生成する。`await next()` の前に `c.res` にアクセスすると、後続ハンドラが返した Response に前の空 Response のヘッダーがマージされる可能性がある。

```typescript
// Bad: next() 前に c.res にアクセスして空 Response を生成
app.use('*', async (c, next) => {
  c.res.headers.set('X-Before', 'true') // 空 Response が生成される
  await next()
})

// Better: c.header() を使う（#preparedHeaders に蓄積され、最終 Response に反映）
app.use('*', async (c, next) => {
  c.header('X-Before', 'true')
  await next()
})
```

## 導出ルール

> このセクションは必須。synthesis-writer が rules.md 生成時に参照する。

- `[MUST]` リクエストスコープのコンテキストオブジェクトでは、使用頻度の低いフィールドを遅延初期化（`??=`）する
  - 根拠: Hono は `#req`, `#var`, `#preparedHeaders` をすべて遅延初期化しており、使われないフィールドのアロケーションコストをゼロにしている（`src/context.ts:306,357,394`）

- `[MUST]` ミドルウェアが共有コンテキストに書き込む変数は、型レベルでキーと値の型を宣言する
  - 根拠: Hono は `Env['Variables']` と `ContextVariableMap` の二重レイヤーで型安全性を確保し、ランタイムの `Map<unknown, unknown>` に対してコンパイル時の型チェックを実現している（`src/context.ts:90-103`）

- `[SHOULD]` プラグイン/ミドルウェアの型拡張ポイントには空インタフェースと Declaration Merging を使う
  - 根拠: Hono の `ContextVariableMap` は空インタフェースとして定義され、JWT/RequestID/Language 等のミドルウェアが `declare module` で型を追加する仕組みを実現している（`src/context.ts:52`, `src/middleware/jwt/index.ts:7-9`）

- `[SHOULD]` コンテキストの変数ストアには読み取り専用ビューと書き込み API を分離して提供する
  - 根拠: `c.var` は `Readonly<>` でラップされた参照専用、`c.set()`/`c.get()` はミドルウェアでの読み書き用と使い分けており、ハンドラからの不正な書き込みを型レベルで防止している（`src/context.ts:582-592`）

- `[SHOULD]` ホットパス（リクエストごとの処理）のレスポンスメソッドには条件分岐によるファストパスを設ける
  - 根拠: `c.text()` はヘッダー/ステータスが未設定の場合に `#newResponse` を経由せず直接 `new Response(text)` を返すファストパスを持ち、最も一般的なケースのオーバーヘッドを最小化している（`src/context.ts:677`）

- `[AVOID]` グローバルな型空間（Declaration Merging）で汎用的なキー名を使う
  - 根拠: `ContextVariableMap` は全ミドルウェアが共有するグローバル型空間であり、`user` や `data` のような汎用名はキー衝突による intersection 型の問題を引き起こす。Hono の公式ミドルウェアは `jwtPayload`, `requestId`, `language` のように具体的な名前を使用している

- `[AVOID]` `c.var` のような変換コストを伴う getter をループ内で繰り返し呼ぶ
  - 根拠: `c.var` は `Object.fromEntries(this.#var)` を毎回実行するため、アクセスごとに新しいオブジェクトが生成される（`src/context.ts:591`）

## 適用チェックリスト

- [ ] リクエストスコープのオブジェクトで、使用頻度の低いフィールドに遅延初期化（`??=`）を適用しているか
- [ ] ミドルウェア/プラグイン間のデータ受け渡しに使う変数ストアが型安全か（キーと値の型が定義されているか）
- [ ] 型拡張ポイント（プラグインが型を追加できる口）を空インタフェースとして提供しているか
- [ ] 変数ストアの読み取り専用ビューと書き込み API が適切に分離されているか
- [ ] ホットパスの処理に不要なオブジェクト生成や関数呼び出しがないか（ファストパスの検討）
- [ ] Declaration Merging で使用するキー名がミドルウェア固有の具体的な名前か（衝突リスクの確認）
- [ ] ES private fields（`#`）を使って内部状態を隠蔽し、公開 API を getter/setter/メソッドに限定しているか
