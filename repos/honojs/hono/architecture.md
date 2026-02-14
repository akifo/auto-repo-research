# architecture

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono の全体アーキテクチャ・レイヤー構成・依存関係の方向性を分析する。Hono は Web Standards（Fetch API）の上に構築されたゼロ依存フレームワークであり、薄いコア層と交換可能なルーターという構造が特徴的である。コアの依存方向が常に「内側から外側」へ流れる設計は、9 つのランタイムアダプターと 25 のミドルウェアを支える基盤となっている。フレームワークとしての表現力を TypeScript の型システムに大きく委ねている点も注目に値する。

## 設計思想

- **Web Standards を唯一の抽象化境界とする**: Hono はランタイム固有の API を一切コアに取り込まず、Fetch API の `Request` / `Response` を唯一のインターフェースとする。`fetch()` メソッドが全エントリーポイントの共通シグネチャであり（`src/hono-base.ts:473-479`）、Cloudflare Workers, Deno, Bun, Node.js のいずれでも同一のコアコードが動作する。これにより「ランタイム中立性」をフレームワークレベルで保証している。

- **コアを最小に保ち、拡張を外縁に押し出す**: コアは `hono-base.ts`（約540行）、`compose.ts`（73行）、`context.ts`（約770行）、`router.ts`（103行）の 4 ファイルに集約される。ミドルウェア・ヘルパー・アダプター・JSX はすべてコアの外側にあり、コアへの逆方向の依存は存在しない。`package.json` の exports マップで各モジュールを個別エントリーポイントとして公開し、tree-shaking を促進する設計。

- **Strategy パターンによるルーター交換可能性**: `Router<T>` インターフェース（`src/router.ts:29-52`）は `add` と `match` の 2 メソッドのみを定義し、5 つの実装（RegExpRouter, TrieRouter, LinearRouter, PatternRouter, SmartRouter）が存在する。SmartRouter は初回リクエスト時にルーターを自動選択し、`this.match` をバインドし直すことで以降のオーバーヘッドをゼロにする（`src/router/smart-router/router.ts:46`）。

- **型安全性をランタイムコストなしで実現する**: ハンドラーの型推論、パスパラメータの型抽出、ミドルウェアチェーンの環境型合成がすべてコンパイル時に解決される。`types.ts` の大部分（800行以上）は型定義であり、実行時コードはゼロ。RPC クライアント（`src/client/`）はサーバー定義から型を推論し、Proxy ベースの動的ディスパッチを行う。

## 設計・実装の詳細

### レイヤー構成

Hono のアーキテクチャは以下の 5 層で構成される。依存方向は常に外側から内側へ向かい、内側の層が外側を参照することはない。

```
Layer 5: Adapter (adapter/)      ← ランタイム固有コード
Layer 4: Middleware (middleware/) ← 横断的関心事
Layer 3: Helper/Client/JSX       ← ユーティリティ・拡張機能
Layer 2: HonoBase + Context      ← フレームワークコア
Layer 1: Router Interface + Compose ← 基盤抽象
Layer 0: Web Standards (Request/Response) ← 外部依存（ブラウザ/ランタイム提供）
```

**Layer 1: Router Interface + Compose** は最も安定した層であり、変更頻度が最も低い。`Router<T>` インターフェースは 2 メソッド（`add`, `match`）のみ、`compose` 関数は koa-compose 由来の 73 行の関数。この層は他の一切に依存しない。

**Layer 2: HonoBase + Context** はフレームワークの骨格。`HonoBase` は abstract class 的な設計で、`router` プロパティを持つが初期化しない（`src/hono-base.ts:117-118`）。サブクラスがコンストラクタでルーターを注入する。`Context` は Request/Response のラッパーであり、`c.text()`, `c.json()`, `c.html()` 等のレスポンスヘルパーを提供する。

**Layer 3: Helper/Client/JSX** はコアに依存するが、コアからは参照されない。`createFactory()` はアプリケーション構築のためのヘルパー、`hc()` は型安全 RPC クライアント。

**Layer 4: Middleware** は `MiddlewareHandler` 型に準拠する関数群。各ミドルウェアは独立したモジュールとして `src/middleware/` に配置され、相互依存がない。

**Layer 5: Adapter** はランタイム固有の機能（serve-static, WebSocket, conninfo 等）を提供する。

### Preset によるルーター構成の分離

`src/hono.ts` はデフォルト構成（SmartRouter + RegExpRouter + TrieRouter）を定義する薄いファイル（34行）である。バンドルサイズを最適化するための代替構成が `src/preset/` に用意されている。

```typescript
// src/hono.ts:27-33 - デフォルト: 高性能だがバンドルサイズ大
this.router = options.router ?? new SmartRouter({
  routers: [new RegExpRouter(), new TrieRouter()],
})

// src/preset/tiny.ts:16-18 - 最小: PatternRouter のみ
this.router = new PatternRouter()

// src/preset/quick.ts:20-22 - 開発向け: 登録が速い LinearRouter
this.router = new SmartRouter({
  routers: [new LinearRouter(), new TrieRouter()],
})
```

いずれも `HonoBase` を継承し、コンストラクタでルーターを注入するだけの構成。これは「コアが特定のルーター実装を知らない」という依存方向の正しさを示している。

### ミドルウェア合成とディスパッチの最適化

`compose` 関数（`src/compose.ts`）は koa-compose の設計を踏襲した再帰的ディスパッチである。特筆すべきは `hono-base.ts:424` のシングルハンドラー最適化で、マッチしたハンドラーが 1 つだけの場合は `compose` を呼ばず、直接実行する。

```typescript
// src/hono-base.ts:424-442
if (matchResult[0].length === 1) {
  let res: ReturnType<H>
  try {
    res = matchResult[0][0][0][0](c, async () => {
      c.res = await this.#notFoundHandler(c)
    })
  } catch (err) {
    return this.#handleError(err, c)
  }

  return res instanceof Promise
    ? res.then(/* ... */).catch(/* ... */)
    : (res ?? this.#notFoundHandler(c))
}
```

この最適化は「大半のリクエストはミドルウェアなしで単一ハンドラーにマッチする」というユースケースを想定しており、Promise のオーバーヘッドも条件分岐で回避している。

### Context の遅延初期化パターン

`Context` クラスは多くのプロパティを遅延初期化する。`HonoRequest` は初回アクセス時にのみ生成される（`src/context.ts:356-359`）。

```typescript
// src/context.ts:356-359
get req(): HonoRequest<P, I['out']> {
  this.#req ??= new HonoRequest(this.#rawRequest, this.#path, this.#matchResult)
  return this.#req
}
```

`c.var` も `Map` ベースの遅延初期化を採用（`src/context.ts:544`）。`c.text()` に至っては、ヘッダーやステータスの設定がなければ `new Response(text)` を直接返す fast path を持つ（`src/context.ts:677`）。

### アダプター層の薄さと統一インターフェース

各アダプター（Cloudflare Workers, Bun, Deno 等）の index.ts は 3-6 行の re-export のみ。アダプターが提供する機能は `serveStatic`, `upgradeWebSocket`, `getConnInfo` といったランタイム固有の API ブリッジに限定される。コアロジックは一切含まない。

`helper/adapter/index.ts` の `getRuntimeKey()` はランタイム検出を行うが、これはコアの依存ではなくヘルパーとして外側に配置されている。コアが「自分がどのランタイムで動いているか」を知る必要がない設計。

### エラーハンドリングの階層

エラー処理は 3 層構造:

1. **HTTPException** (`src/http-exception.ts`): ユーザーが意図的に投げる HTTP エラー。`getResponse()` メソッドで Response に変換可能。
2. **errorHandler** (`src/hono-base.ts:35-42`): `onError()` でカスタマイズ可能。`HTTPException` は `getResponse()` 経由で処理、その他の Error は `console.error` + 500。
3. **route() でのエラーハンドラー合成** (`src/hono-base.ts:221-226`): サブアプリがカスタムエラーハンドラーを持つ場合、`compose` でラップして親アプリにマウントする。

```typescript
// src/hono-base.ts:35-42
const errorHandler: ErrorHandler = (err, c) => {
  if ('getResponse' in err) {
    const res = err.getResponse()
    return c.newResponse(res.body, res)
  }
  console.error(err)
  return c.text('Internal Server Error', 500)
}
```

## コード例

### SmartRouter の自動選択と自己書き換え

```typescript
// src/router/smart-router/router.ts:21-60
match(method: string, path: string): Result<T> {
  // ...
  for (; i < len; i++) {
    const router = routers[i]
    try {
      for (let i = 0, len = routes.length; i < len; i++) {
        router.add(...routes[i])
      }
      res = router.match(method, path)
    } catch (e) {
      if (e instanceof UnsupportedPathError) {
        continue  // このルーターでは処理できないパスの場合、次を試す
      }
      throw e
    }
    // 成功したルーターに match メソッドを差し替え（以降はこのルーターを直接使用）
    this.match = router.match.bind(router)
    this.#routers = [router]
    this.#routes = undefined
    break
  }
  // ...
}
```

### Validator ミドルウェアのターゲット抽象化

```typescript
// src/validator/validator.ts:89-171
return async (c, next) => {
  let value = {}
  const contentType = c.req.header('Content-Type')

  switch (target) {
    case 'json':   value = await c.req.json(); break
    case 'form':   /* FormData 処理 */ break
    case 'query':  value = Object.fromEntries(/* ... */); break
    case 'param':  value = c.req.param(); break
    case 'header': value = c.req.header(); break
    case 'cookie': value = getCookie(c); break
  }

  const res = await validationFunc(value as never, c as never)
  if (res instanceof Response) { return res }
  c.req.addValidatedData(target, res as never)
  return (await next())
}
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: ルーティングアルゴリズムの交換を、フレームワークコアを変更せずに実現する
  - 適用条件: 同一インターフェースを持つ複数の実装が存在し、用途に応じて選択したい場合
  - コード例: `src/router.ts:29-52`（Router インターフェース）, `src/router/reg-exp-router/router.ts`, `src/router/trie-router/router.ts`
  - 注意点: SmartRouter は Strategy の動的選択を行い、選択後に `this.match` を書き換えるため、Strategy + State のハイブリッド

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: フレームワークの骨格を固定しつつ、ルーター構成をサブクラスに委ねる
  - 適用条件: 共通の処理フローがあり、一部のステップだけを差し替えたい場合
  - コード例: `src/hono-base.ts:98-103`（HonoBase は `router` を初期化せず、`src/hono.ts:26-33` で注入）
  - 注意点: TypeScript では abstract class ではなく `!` (definite assignment assertion) で表現している

- **Chain of Responsibility パターン** (分類: 振る舞い)
  - 解決する問題: リクエスト処理を複数のミドルウェアに順次委譲し、各ミドルウェアが独立に処理・委譲を判断する
  - 適用条件: 処理の順序と組み合わせを動的に構成したい場合
  - コード例: `src/compose.ts:15-73`（koa-compose ベースのミドルウェア合成）
  - 注意点: `next()` の多重呼び出し検知（`src/compose.ts:33-35`）でチェーンの整合性を保証

- **Proxy パターン** (分類: 構造)
  - 解決する問題: サーバー定義のスキーマ型情報を利用して、型安全な RPC クライアントを動的に構築する
  - 適用条件: コンパイル時の型情報をランタイムの動的ディスパッチと組み合わせたい場合
  - コード例: `src/client/client.ts:15-31`（`Proxy` でパスを蓄積し、メソッド呼び出し時に fetch を実行）
  - 注意点: JavaScript の Proxy はパフォーマンスコストがあるため、クライアント側（ブラウザ等）での使用が前提

## Good Patterns

- **インターフェースの最小化による交換可能性**: `Router<T>` は `name`, `add`, `match` の 3 メンバーのみ。この極小インターフェースにより、5 つの全く異なるアルゴリズム（正規表現合成、Trie木、線形探索、パターンマッチ、自動選択）が同一の型制約で共存できる。

```typescript
// src/router.ts:29-52
export interface Router<T> {
  name: string
  add(method: string, path: string, handler: T): void
  match(method: string, path: string): Result<T>
}
```

- **Hot Path の分岐による最適化**: ハンドラーが 1 つのみの場合に `compose` をスキップし、さらに同期/非同期を `instanceof Promise` で分岐する。フレームワークの最も頻繁に実行されるパスを最短にする設計。

```typescript
// src/hono-base.ts:424-442
if (matchResult[0].length === 1) {
  let res: ReturnType<H>
  try {
    res = matchResult[0][0][0][0](c, async () => {
      c.res = await this.#notFoundHandler(c)
    })
  } catch (err) {
    return this.#handleError(err, c)
  }
  return res instanceof Promise
    ? res.then((resolved) => resolved || (c.finalized ? c.res : this.#notFoundHandler(c)))
         .catch((err: Error) => this.#handleError(err, c))
    : (res ?? this.#notFoundHandler(c))
}
```

- **自己書き換えによる初期化コスト償却**: SmartRouter は初回 `match` 呼び出し時にルーターを選択した後、`this.match` を選択されたルーターの `match` にバインドし直す。以降の呼び出しでは SmartRouter のロジックは一切実行されない。

```typescript
// src/router/smart-router/router.ts:46-48
this.match = router.match.bind(router)
this.#routers = [router]
this.#routes = undefined
```

## Anti-Patterns / 注意点

- **Adapter 層を経由しないランタイム固有コードの混入**: コアやミドルウェアにランタイム固有の API（例: `node:async_hooks`）を直接 import すると、他のランタイムでの動作を阻害する。`context-storage` ミドルウェア（`src/middleware/context-storage/index.ts:6`）は `node:async_hooks` に依存しており、WinterCG 互換ではないランタイムでは動作しない。

```typescript
// Bad: コアやミドルウェアにランタイム固有 import
import { AsyncLocalStorage } from 'node:async_hooks'

// Better: ランタイム検出で分岐するか、アダプター層に分離する
// Hono はこれをミドルウェアとして分離しており、
// 使用するかどうかをユーザーが選択できるようにしている
```

- **コアに過度な型複雑性を持ち込む**: `types.ts` は 800 行以上の型定義で構成され、高度な型推論（条件型、マップ型、再帰型）を多用している。型の表現力は強力だが、IDE のパフォーマンス低下やエラーメッセージの難読化を招く場合がある。

```typescript
// Bad: 型レベルの処理が深すぎて理解困難
type IntersectNonAnyTypes<T> = /* 複雑な条件型の連鎖 */

// Better: 型の複雑度に上限を設け、必要に応じて型テストでカバーする
// Hono は types.test.ts で型レベルのテストを実施しており、
// 型の正しさを検証する仕組みを持っている
```

## 導出ルール

> このセクションは必須。最低 3 個のルールを記載すること。synthesis-writer が rules.md 生成時に参照する。

- `[MUST]` フレームワークのコア層は Web Standards（Fetch API 等）のみに依存し、ランタイム固有 API を直接参照しない
  - 根拠: Hono は `Request`/`Response` を唯一の境界とすることで、9 つのランタイムアダプターを 3-6 行の re-export で実現している（`src/adapter/*/index.ts`）

- `[MUST]` プラグイン/ミドルウェアのインターフェースは最小限のメソッドで定義し、実装詳細を漏洩させない
  - 根拠: `Router<T>` は `add`/`match` の 2 メソッドのみで 5 つの全く異なるアルゴリズムを統一し、SmartRouter による動的選択を可能にしている（`src/router.ts:29-52`）

- `[SHOULD]` Hot Path（最頻実行パス）では抽象化レイヤーをバイパスする最適化を実装する
  - 根拠: `hono-base.ts:424` のシングルハンドラー最適化は `compose` をスキップし、同期レスポンスでは Promise のオーバーヘッドも回避する

- `[SHOULD]` オブジェクトの初期化コストが高い場合、遅延初期化（nullish coalescing assignment `??=`）で必要時まで生成を遅延させる
  - 根拠: `Context.req` は初回アクセス時にのみ `HonoRequest` を生成し、`c.text()` の fast path ではリクエストオブジェクトが一切生成されない（`src/context.ts:356-359`, `src/context.ts:677`）

- `[SHOULD]` 依存関係の方向は常に「外側（具体）から内側（抽象）」へ向かわせ、内側の層が外側を参照しない
  - 根拠: Hono のアダプター/ミドルウェア/ヘルパーはすべてコア（HonoBase/Context/Router）に依存するが、コアからこれらへの参照は存在しない

- `[AVOID]` コアフレームワーク内で特定のルーティングアルゴリズムやミドルウェア実装にハードコードする
  - 根拠: `HonoBase` は `router` を `!` (definite assignment) で宣言し、具体的なルーター実装を知らない。Preset（`src/hono.ts`, `src/preset/tiny.ts`, `src/preset/quick.ts`）がサブクラスとして構成を注入する

- `[AVOID]` ミドルウェア間に暗黙の依存関係を作る（実行順序への暗黙の期待）
  - 根拠: Hono の各ミドルウェア（cors, jwt, logger 等）は独立したモジュールとして `src/middleware/` に配置され、相互 import がない。`compose` が順序を制御し、各ミドルウェアは `next()` の呼び出しでのみ連携する

## 適用チェックリスト

- [ ] フレームワーク/ライブラリのコア層がランタイム固有 API に直接依存していないか確認する
- [ ] プラグインインターフェースが 3 メソッド以下に収まっているか確認する
- [ ] 最頻実行パス（リクエスト処理等）で不要な抽象化レイヤーを通過していないか計測する
- [ ] 遅延初期化が適用可能なオブジェクト生成箇所を特定し、`??=` パターンで最適化する
- [ ] 依存関係図を描き、内側の層から外側の層への参照がないことを検証する
- [ ] ミドルウェア/プラグイン間の暗黙の依存（実行順序への期待、共有状態へのアクセス）がないか確認する
- [ ] Preset パターン（サブクラスによる構成注入）でバンドルサイズの最適化が可能か検討する
