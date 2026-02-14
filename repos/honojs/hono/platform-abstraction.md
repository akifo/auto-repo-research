# platform-abstraction

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono は 9 つ以上のランタイム（Cloudflare Workers, Deno, Bun, AWS Lambda, Vercel, Netlify, Lambda@Edge, Service Worker, Fastly）上で動作するマルチプラットフォーム Web フレームワークである。この視点では、Web Standards（Request/Response API）を唯一の抽象化レイヤーとして採用し、プラットフォーム固有の差異をアダプターパターンで吸収する戦略を分析する。注目に値するのは、コアに一切のランタイム依存を持たず、アダプターの追加だけで新プラットフォームを支援できるアーキテクチャを実現している点である。

## 背景にある原則

- **Web Standards を最小公約数の契約とせよ**: プラットフォーム間の差異を独自の抽象型で吸収するのではなく、すでにすべてのランタイムが実装している Web Standards（`Request`, `Response`, `Headers`, `ReadableStream`）を契約インターフェースにすることで、抽象化レイヤーそのもののメンテナンスコストをゼロにしている。コアの `fetch` シグネチャ（`src/hono-base.ts:473-479`）は `(request: Request, Env?, executionCtx?) => Response | Promise<Response>` であり、これは Cloudflare Workers の Service Worker API と同一の形をしている。

- **コアはプラットフォームを知らず、アダプターだけがプラットフォームを知る**: `src/hono-base.ts` にランタイム固有のコードは一切存在しない。代わりに `src/adapter/` 配下のモジュールがランタイム固有の入出力を Request/Response に変換する責務を持つ。これにより、コアのテストはすべて標準 API だけで完結し、ランタイム固有のテストは `runtime-tests/` に分離される。

- **共通ロジックを引き上げ、差分だけをプラットフォーム側で注入する**: `serveStatic`, `upgradeWebSocket`, `toSSG` といったクロスカッティングな機能は、コアに「プラットフォーム非依存のロジック」を置き、各アダプターが `getContent` や `FileSystemModule` 等の薄いコールバックを注入する構造を取っている（Strategy パターン）。これにより、ロジックの重複を最小化しつつ各ランタイムの API を直接利用できる。

- **型レベルでプラットフォーム差異を表現し、ランタイム検出は最終手段とする**: `Env` 型のジェネリクス（`Bindings`, `Variables`）で各プラットフォームの環境変数・バインディングを型安全に扱い、コンパイル時に不整合を検出する。ランタイム検出（`getRuntimeKey`）は `helper/adapter` に閉じ込め、ユーザーコードでの分岐を最小化している。

## 実例と分析

### アダプターの統一パターン: `handle` 関数

すべてのアダプターは `handle(app)` という関数を公開し、プラットフォーム固有のイベント/リクエストを受け取って `app.fetch()` を呼ぶ構造を共有する。この一貫したパターンにより、ユーザーはどのプラットフォームでも同じメンタルモデルで導入できる。

各アダプターの `handle` の差分は「入力をどう Request に変換し、Response をどうプラットフォーム固有の出力に変換するか」のみである。

- **Vercel** (`src/adapter/vercel/handler.ts:4-8`): 最も薄い。Request をそのまま `app.fetch` に渡す
- **Netlify** (`src/adapter/netlify/handler.ts:4-10`): Request + context を渡すだけ
- **Service Worker** (`src/adapter/service-worker/handler.ts:18-37`): `evt.respondWith()` でラップ
- **Cloudflare Pages** (`src/adapter/cloudflare-pages/handler.ts:32-46`): `eventContext` の分解と再構築
- **AWS Lambda** (`src/adapter/aws-lambda/handler.ts:239-266`): 最も厚い。4種類のイベント形式を判別してプロセッサで変換

### EventProcessor: Template Method パターンによるイベント変換

AWS Lambda アダプターは、API Gateway v1/v2, ALB, VPC Lattice という 4 種類のイベント形式を扱う。これらの変換を `EventProcessor` 抽象クラス（`src/adapter/aws-lambda/handler.ts:268-388`）で統一し、差分を `getPath`, `getMethod`, `getQueryString`, `getHeaders`, `setCookiesToResult` のオーバーライドで表現している。

```typescript
// src/adapter/aws-lambda/handler.ts:268-279
export abstract class EventProcessor<E extends LambdaEvent> {
  protected abstract getPath(event: E): string
  protected abstract getMethod(event: E): string
  protected abstract getQueryString(event: E): string
  protected abstract getHeaders(event: E): Headers
  protected abstract getCookies(event: E, headers: Headers): void
  protected abstract setCookiesToResult(result: APIGatewayProxyResult, cookies: string[]): void
  // ...
  createRequest(event: E): Request { /* 共通ロジック */ }
  async createResult(event: E, res: Response, options): Promise<APIGatewayProxyResult> { /* 共通ロジック */ }
}
```

イベントの判別はプロパティの有無による型ガード（`src/adapter/aws-lambda/handler.ts:645-661`）で行い、プロセッサインスタンスはシングルトンとしてキャッシュされている。

### serveStatic: コールバック注入による共通化

`src/middleware/serve-static/index.ts:34-47` でコアの `serveStatic` は `getContent`, `join`, `isDir` をオプションとして受け取る。プラットフォーム非依存のロジック（パス解決、MIME タイプ判定、プリコンプレス対応）はコアが担い、ファイル読み取りだけがアダプターに委ねられる。

```typescript
// src/adapter/bun/serve-static.ts:11-16 (Bun)
const getContent = async (path: string) => {
  const file = Bun.file(path)
  return (await file.exists()) ? file : null
}

// src/adapter/deno/serve-static.ts:12-20 (Deno)
const getContent = async (path: string) => {
  const file = await open(path)  // Deno.open
  return file.readable
}
```

コアの関数シグネチャのコメントに「This middleware is not directly used by the user」（`src/middleware/serve-static/index.ts:33`）と明記されており、ユーザーが直接触るのはアダプター側の薄いラッパーであることが意図的に設計されている。

### ConnInfo: 同一インターフェース・異なるデータソース

`GetConnInfo` 型（`src/helper/conninfo/types.ts:45`）は `(c: Context) => ConnInfo` というシンプルなシグネチャで、各アダプターがプラットフォーム固有の方法でクライアント IP を取得する。

```typescript
// Cloudflare Workers (src/adapter/cloudflare-workers/conninfo.ts:3-7)
export const getConnInfo: GetConnInfo = (c) => ({
  remote: { address: c.req.header('cf-connecting-ip') },
})

// Vercel (src/adapter/vercel/conninfo.ts:3-5)
export const getConnInfo: GetConnInfo = (c) => ({
  remote: { address: c.req.header('x-real-ip') },
})

// Bun (src/adapter/bun/conninfo.ts:10-43)
export const getConnInfo: GetConnInfo = (c: Context) => {
  const server = getBunServer(c)
  const info = server.requestIP(c.req.raw)
  return { remote: { address: info.address, ... } }
}
```

HTTP ヘッダーから取得（Cloudflare, Vercel）、サーバー API から取得（Bun, Deno）、イベントオブジェクトから取得（Lambda@Edge）という 3 パターンが、同一の型に統一されている。

### WebSocket: defineWebSocketHelper による共通フレームワーク

`src/helper/websocket/index.ts:111-140` の `defineWebSocketHelper` は、WebSocket アダプター作成のためのファクトリ関数である。各プラットフォームは `WebSocketHelperDefineHandler` を実装するだけで、ミドルウェアとしての統合（`createEvents` のコールバック呼び出し、`next()` の制御）はヘルパーが担う。

```typescript
// src/helper/websocket/index.ts:111-113
export const defineWebSocketHelper = <T = unknown, U = any>(
  handler: WebSocketHelperDefineHandler<T, U>
): UpgradeWebSocket<T, U> => { /* ... */ }
```

各アダプターはこのヘルパーを使い、プラットフォーム固有の WebSocket API を `WSContext` に変換する薄い実装だけを書けばよい。

### ランタイム検出: navigator.userAgent 優先の段階的フォールバック

`src/helper/adapter/index.ts:50-84` の `getRuntimeKey` は、以下の優先順位でランタイムを判別する:

1. `navigator.userAgent` による一致（Deno, Bun, Cloudflare Workers, Node.js）
2. `globalThis.EdgeRuntime` の存在（Edge Runtime）
3. `globalThis.fastly` の存在（Fastly）
4. `process.release.name` によるフォールバック（Node.js v21.1.0 未満）
5. `'other'` を返す

標準 API（`navigator.userAgent`）を最優先し、非標準のグローバル変数は後方互換のフォールバックに留めている。

### プリセットによるルーター戦略の選択

`src/preset/tiny.ts` と `src/preset/quick.ts` は `HonoBase` を継承しルーターのみを差し替えた派生クラスである。コアを `HonoBase`（抽象基底）と `Hono`（デフォルト構成）に分離することで、ユーザーがバンドルサイズやパフォーマンス特性に応じてプリセットを選択できる。

```typescript
// src/preset/tiny.ts:11-20
export class Hono<...> extends HonoBase<...> {
  constructor(options: HonoOptions<E> = {}) {
    super(options)
    this.router = new PatternRouter()
  }
}
```

## パターンカタログ

- **Adapter パターン** (分類: 構造)
  - 解決する問題: プラットフォーム固有の入出力形式を統一インターフェースに変換する
  - 適用条件: コアが Web Standards のみに依存し、プラットフォーム固有 API を直接呼べない場合
  - コード例: 各 `src/adapter/*/handler.ts` の `handle` 関数
  - 注意点: アダプターが厚くなるとロジックの重複が発生する。AWS Lambda のように EventProcessor を導入して共通化する

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 同じアルゴリズム（静的ファイル配信、SSG 出力）でファイルシステムアクセスだけが異なる
  - 適用条件: ロジックの大半が共通で、プラットフォーム依存部分が明確に分離できる場合
  - コード例: `src/middleware/serve-static/index.ts` の `getContent` コールバック
  - 注意点: コールバックの型を広くしすぎると抽象の漏れが起きる。最小のインターフェース（`(path: string, c: Context) => Promise<Data | Response | null>`）に留める

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: 複数のイベント形式に対して共通の変換フローを適用しつつ、細部を派生クラスで差し替える
  - 適用条件: 同一プラットフォーム内で複数のサブバリアント（API Gateway v1/v2, ALB, Lattice）が存在する場合
  - コード例: `src/adapter/aws-lambda/handler.ts:268-388` の `EventProcessor`
  - 注意点: 抽象メソッドが増えすぎると理解コストが上がる。Hono では 6 メソッドに留めている

- **Factory Method パターン** (分類: 生成)
  - 解決する問題: WebSocket ヘルパーの生成を統一しつつ、プラットフォーム固有の初期化を隠蔽する
  - 適用条件: アダプターごとに異なるオブジェクト生成ロジックを統一的に扱いたい場合
  - コード例: `src/helper/websocket/index.ts:111-140` の `defineWebSocketHelper`

## Good Patterns

- **アダプター層の薄さのグラデーション**: Vercel アダプターは 5 行、AWS Lambda アダプターは 680 行。プラットフォームの複雑度に応じてアダプターの厚みが自然にスケールする設計になっている。「すべてのアダプターを同じ厚みにする」という過剰な統一を避け、必要最小限の変換だけを書くことで保守コストを最小化している。

```typescript
// src/adapter/vercel/handler.ts:4-8 — 最も薄いアダプター
export const handle =
  (app: Hono<any, any, any>) =>
  (req: Request): Response | Promise<Response> => {
    return app.fetch(req)
  }
```

- **プラットフォーム固有 API へのアクセスを `Env` 型ジェネリクスで型安全に提供**: `c.env` 経由でランタイム固有のバインディング（KV Namespace, Deno.env 等）にアクセスできるが、`Env['Bindings']` のジェネリクスによりコンパイル時に型チェックされる。コアには `any` が漏れない。

```typescript
// src/types.ts:31-34
export type Env = {
  Bindings?: Bindings
  Variables?: Variables
}
```

- **ランタイムテストの「最小パターン + 既存テスト信頼」戦略**: `runtime-tests/bun/index.test.tsx:17-18` のコメント「Test just only minimal patterns. Because others are tested well in Cloudflare Workers environment already.」に見られるように、コアのテストを 1 つのランタイムで網羅的に行い、他のランタイムでは差分（ランタイム固有 API の動作）のみをテストする戦略を明示的に採用している。

## Anti-Patterns / 注意点

- **アダプター内でのロジック重複**: AWS Lambda の `isContentTypeBinary`（`src/adapter/aws-lambda/handler.ts:669-673`）と Lambda@Edge の `isContentTypeBinary`（`src/adapter/lambda-edge/handler.ts:191-195`）はほぼ同一のロジックだが、別々に定義されている。共通ユーティリティへの引き上げが望ましい。

```typescript
// Bad: 同一ロジックがアダプター間で重複
// src/adapter/aws-lambda/handler.ts:669-673
export const defaultIsContentTypeBinary = (contentType: string): boolean => {
  return !/^text\/(?:plain|html|css|javascript|csv)|.../.test(contentType)
}
// src/adapter/lambda-edge/handler.ts:191-195
export const isContentTypeBinary = (contentType: string): boolean => {
  return !/^(text\/(plain|html|css|javascript|csv).*|...)$/.test(contentType)
}

// Better: 共通ユーティリティに抽出
// src/utils/content-type.ts
export const isContentTypeBinary = (contentType: string): boolean => { /* ... */ }
```

- **`@ts-expect-error` によるプラットフォーム固有 API の型回避**: Cloudflare Workers の `WebSocketPair`、Bun の `Bun.file` など、プラットフォーム固有 API の呼び出しで `@ts-expect-error` が頻出する。これは「プラットフォーム固有の型定義をアダプターの型スコープに閉じ込める」設計の副作用であるが、型安全性の穴になり得る。プラットフォーム固有の `.d.ts` ファイル（`src/adapter/deno/deno.d.ts` のように）を各アダプターに用意するのが堅牢なアプローチ。

## 導出ルール

- `[MUST]` マルチプラットフォーム対応のコアは、業界標準のインターフェース（Web Standards, POSIX 等）のみに依存し、プラットフォーム固有 API をコアに持ち込まない
  - 根拠: `src/hono-base.ts` は `Request`/`Response` のみに依存し、9 つのランタイムで動作する。コアに `Deno.open` や `Bun.file` が存在しないことで、新プラットフォーム追加時にコア変更が不要になっている

- `[MUST]` アダプターの公開インターフェースを統一する（同名の `handle` 関数、同一の型シグネチャ）
  - 根拠: 全アダプターが `handle(app)` を公開し、ユーザーのプラットフォーム移行コストを最小化している（`src/adapter/*/index.ts`）

- `[SHOULD]` クロスカッティングな機能は「プラットフォーム非依存のロジック + プラットフォーム固有のコールバック注入」に分割する
  - 根拠: `serveStatic` はコアにパス解決・MIME 判定・プリコンプレスのロジックを持ち、ファイル読み取りだけを `getContent` コールバックとして注入している。3 つのランタイム実装でロジック重複がない（`src/middleware/serve-static/index.ts:34-47`）

- `[SHOULD]` ランタイム検出はアプリケーションコードから分離し、標準 API を最優先の判定手段とする
  - 根拠: `getRuntimeKey()` は `navigator.userAgent`（標準 API）を最優先し、非標準グローバル変数への依存をフォールバックに留めている（`src/helper/adapter/index.ts:50-84`）

- `[SHOULD]` テスト戦略はコアの網羅的テスト + ランタイム固有テストの差分のみとし、全ランタイムでの全テスト実行を避ける
  - 根拠: `runtime-tests/` のコメント（「Test just only minimal patterns」）に明記。ランタイム固有テストはそのランタイムの API 差異のみを検証する

- `[AVOID]` アダプター間で同一ロジックを個別に実装すること。共通ユーティリティへ引き上げる
  - 根拠: `isContentTypeBinary` が AWS Lambda と Lambda@Edge で微妙に異なる正規表現で重複実装されており、将来的なバグの温床になっている

- `[AVOID]` コアのインターフェースにプラットフォーム固有の型を含めること。`Env` ジェネリクスで型パラメータとして外部化する
  - 根拠: `Env['Bindings']` により Cloudflare の KV Namespace も Deno の `remoteAddr` も型安全に扱えるが、コアの `Env` 型自体はプラットフォーム中立（`src/types.ts:31-34`）

## 適用チェックリスト

- [ ] コアモジュールがプラットフォーム固有 API を直接 import していないことを確認する
- [ ] すべてのアダプターが統一された公開インターフェース（関数名・型シグネチャ）を持っているか検証する
- [ ] クロスカッティングな機能（ファイル I/O, WebSocket, ログ等）が「共通ロジック + コールバック注入」の構造になっているか確認する
- [ ] プラットフォーム固有の型が `Env` ジェネリクスや型パラメータで外部化されているか確認する
- [ ] ランタイム検出コードがアプリケーションロジックに散在していないか（専用ヘルパーに集約されているか）確認する
- [ ] アダプター間でのコード重複を検出し、共通ユーティリティへの引き上げを検討する
- [ ] テスト戦略がコア網羅テスト + ランタイム差分テストの 2 層構造になっているか確認する
- [ ] 新しいプラットフォームを追加する際にコアの変更が不要であることを確認する（アダプター追加のみで対応できるか）
