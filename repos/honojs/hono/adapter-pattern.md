# Adapter Pattern

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono は Cloudflare Workers、Deno、Bun、AWS Lambda、Vercel、Netlify、Service Worker など 9 つのランタイムで動作するマルチランタイム Web フレームワークである。この分析では、ランタイム固有の差異を吸収しつつ Web Standards API（`Request`/`Response`）を一貫したインターフェースとして維持するアダプター抽象化の設計を掘り下げる。注目に値する理由は、フレームワークコアがゼロ依存でありながら 9 ランタイム対応を実現している点、そしてアダプターの粒度と責務分離が極めて実用的なバランスを保っている点にある。

## 設計思想

- **Web Standards を正規表現とする原則**: Hono のコアは `fetch(request: Request, env?, executionCtx?): Response | Promise<Response>` というシグネチャのみを公開する（`src/hono-base.ts:473-479`）。全アダプターの責務は「ランタイム固有の入力を `Request` に変換し、`Response` をランタイム固有の出力に逆変換する」ことに限定される。この設計により、コアのミドルウェアチェーンはランタイムを一切意識しない。

- **アダプターは薄いブリッジに徹する原則**: Vercel アダプターは 3 行（`src/adapter/vercel/handler.ts:4-8`）、Netlify アダプターも 4 行（`src/adapter/netlify/handler.ts:4-10`）。Web Standards を既にサポートするランタイムほどアダプターは薄くなる。複雑さはランタイムの API 乖離度に比例して増える（AWS Lambda アダプターは 680 行）。この比例関係は意図的な設計であり、不要な抽象化層を入れていない。

- **Strategy Injection による環境差異の吸収**: `serveStatic` や `toSSG`、`upgradeWebSocket` では、コアが「振る舞いの骨格」を提供し、ランタイム固有の実装を関数として注入する。例えば `serveStatic` は `getContent`、`join`、`isDir` を受け取る高階関数であり、各アダプターはランタイム固有のファイルシステム操作を注入する（`src/middleware/serve-static/index.ts:34-47`）。

- **ランタイム検出はヘルパーに隔離する原則**: ランタイムの動的検出は `src/helper/adapter/index.ts` の `getRuntimeKey()` に集約される。アダプター自体はコンパイル時に確定するため動的検出を必要としないが、汎用ヘルパー（`env()` 等）が実行時にランタイムを判別する必要がある場合のみこの機構を使う。

## 設計・実装の詳細

### アダプター階層の全体像

Hono のアダプター群は大きく 3 カテゴリに分類できる。

**Category A: Web Standards ネイティブランタイム（薄いアダプター）**

Cloudflare Workers、Deno、Bun は `Request`/`Response` を直接サポートする。これらのアダプターには `handle()` 関数が存在せず、`app.fetch` をそのままエクスポートできる。アダプター層が提供するのは `serveStatic`、`upgradeWebSocket`、`getConnInfo` など補助機能のみ。

**Category B: イベント変換が必要なランタイム（中間アダプター）**

Vercel、Netlify は `Request` を受け取るが、追加のコンテキスト情報を `env` に注入する必要がある。

**Category C: 完全な変換が必要なランタイム（厚いアダプター）**

AWS Lambda、Lambda@Edge は独自のイベントオブジェクトを使用し、`Request` への変換と `Response` からの逆変換を両方行う必要がある。

### handle() 関数のシグネチャ比較

各アダプターの `handle()` は同名だが型シグネチャが異なる。これは意図的な設計判断で、統一インターフェースを強制するよりも、各ランタイムの慣習に合わせることを優先している。

```typescript
// src/adapter/vercel/handler.ts:4-8 — 最もシンプル
export const handle = (app: Hono<any, any, any>) =>
  (req: Request): Response | Promise<Response> => {
    return app.fetch(req)
  }

// src/adapter/netlify/handler.ts:4-10 — context 透過
export const handle = (app: Hono<any, any>) =>
  (req: Request, context: any): Response | Promise<Response> => {
    return app.fetch(req, { context })
  }

// src/adapter/cloudflare-pages/handler.ts:32-46 — env + executionCtx 展開
export const handle = <E extends Env>(app: Hono<E>): PagesFunction<E['Bindings']> =>
  (eventContext) => {
    return app.fetch(
      eventContext.request,
      { ...eventContext.env, eventContext },
      { waitUntil: eventContext.waitUntil, passThroughOnException: eventContext.passThroughOnException, props: {} }
    )
  }

// src/adapter/aws-lambda/handler.ts:239-266 — 完全な変換 + ジェネリクス
export const handle = <E extends Env>(app: Hono<E>, options?) => {
  return async (event, lambdaContext?) => {
    const processor = getProcessor(event)
    const req = processor.createRequest(event)
    const res = await app.fetch(req, { event, requestContext, lambdaContext })
    return processor.createResult(event, res, options)
  }
}
```

### AWS Lambda アダプターの Template Method + Strategy パターン

AWS Lambda アダプターは最も複雑で、4 種類のイベント形式（API Gateway v1/v2、ALB、VPC Lattice）を処理する。ここでは `EventProcessor` 抽象クラスを中心に Template Method パターンが適用されている。

```typescript
// src/adapter/aws-lambda/handler.ts:268-328
export abstract class EventProcessor<E extends LambdaEvent> {
  protected abstract getPath(event: E): string
  protected abstract getMethod(event: E): string
  protected abstract getQueryString(event: E): string
  protected abstract getHeaders(event: E): Headers
  protected abstract getCookies(event: E, headers: Headers): void
  protected abstract setCookiesToResult(result: APIGatewayProxyResult, cookies: string[]): void

  // Template Method: 共通の変換ロジック
  createRequest(event: E): Request {
    const queryString = this.getQueryString(event)
    const domainName = this.getDomainName(event)
    const path = this.getPath(event)
    const url = `https://${domainName}${path}${queryString ? '?' + queryString : ''}`
    const headers = this.getHeaders(event)
    const method = this.getMethod(event)
    // ... Request を構築
    return new Request(url, requestInit)
  }
}
```

4 つの具象クラス（`EventV1Processor`、`EventV2Processor`、`ALBProcessor`、`LatticeV2Processor`）がそれぞれのイベント形式の差異を吸収する。プロセッサはシングルトンとしてモジュールスコープにキャッシュされる（`src/adapter/aws-lambda/handler.ts:427, 499, 581, 629`）。

イベント形式の判別はプロパティの存在チェックで行われる:

```typescript
// src/adapter/aws-lambda/handler.ts:645-661
const isProxyEventALB = (event: LambdaEvent): event is ALBProxyEvent => {
  return Object.hasOwn(event.requestContext, 'elb')
}
const isProxyEventV2 = (event: LambdaEvent): event is APIGatewayProxyEventV2 => {
  return Object.hasOwn(event, 'rawPath')
}
const isLatticeEventV2 = (event: LambdaEvent): event is LatticeProxyEventV2 => {
  return Object.hasOwn(event.requestContext, 'serviceArn')
}
```

### serveStatic の Strategy Injection パターン

`serveStatic` は高階関数パターンでランタイム差異を吸収する。コアミドルウェアが共通ロジック（パス解決、MIME 判定、プリコンプレス対応）を持ち、アダプターは `getContent` 関数を注入する。

```typescript
// src/adapter/deno/serve-static.ts:12-26 — Deno: Deno.open() を注入
const getContent = async (path: string) => {
  const file = await open(path)
  return file.readable  // ReadableStream を返す
}

// src/adapter/bun/serve-static.ts:12-16 — Bun: Bun.file() を注入
const getContent = async (path: string) => {
  const file = Bun.file(path)
  return (await file.exists()) ? file : null
}

// src/adapter/cloudflare-workers/serve-static.ts:25-36 — CF: KV を注入
const getContent = async (path: string) => {
  return getContentFromKVAsset(path, { manifest, namespace })
}
```

### WebSocket の defineWebSocketHelper パターン

WebSocket 実装では `defineWebSocketHelper` がファクトリ関数として機能し、各ランタイムの WebSocket 実装を統一的な `UpgradeWebSocket` インターフェースにラップする。

```typescript
// src/helper/websocket/index.ts:111-140
export const defineWebSocketHelper = <T>(
  handler: WebSocketHelperDefineHandler<T, U>
): UpgradeWebSocket<T, U> => { ... }
```

各ランタイムはこのファクトリに自身の WebSocket ハンドシェイク処理を渡す:
- Cloudflare Workers: `WebSocketPair` を使用（`src/adapter/cloudflare-workers/websocket.ts:17-19`）
- Deno: `Deno.upgradeWebSocket()` を使用（`src/adapter/deno/websocket.ts:10`）
- Bun: `server.upgrade()` を使用（`src/adapter/bun/websocket.ts:61`）

### ConnInfo の統一インターフェース

`GetConnInfo` 型（`src/helper/conninfo/types.ts:45`）は全アダプターで共通だが、IP アドレスの取得方法はランタイムごとに全く異なる:

| ランタイム | 取得方法 | ファイル |
|---|---|---|
| Cloudflare Workers | `cf-connecting-ip` ヘッダー | `src/adapter/cloudflare-workers/conninfo.ts:3-7` |
| Vercel | `x-real-ip` ヘッダー | `src/adapter/vercel/conninfo.ts:3-8` |
| Bun | `server.requestIP()` API | `src/adapter/bun/conninfo.ts:10-43` |
| Deno | `c.env.remoteAddr` | `src/adapter/deno/conninfo.ts:8-17` |
| Lambda@Edge | `event.Records[0].cf.request.clientIp` | `src/adapter/lambda-edge/conninfo.ts:11-15` |

## パターンカタログ

- **Template Method** (分類: 振る舞い)
  - 解決する問題: AWS Lambda の 4 種類のイベント形式に対して、Request 構築と Response 変換の共通骨格を提供する
  - 適用条件: 同一ドメイン内で変換ロジックの骨格が共通だがステップの詳細が異なる場合
  - コード例: `src/adapter/aws-lambda/handler.ts:268-388`（`EventProcessor` 抽象クラス）
  - 注意点: Hono では AWS Lambda アダプターのみに適用。他アダプターは十分にシンプルなため Template Method は使わず、直接関数で実装している

- **Strategy（関数注入型）** (分類: 振る舞い)
  - 解決する問題: ファイルシステムアクセス・WebSocket ハンドシェイクなどランタイム固有操作の差し替え
  - 適用条件: 共通ロジックの中で一部の操作がランタイム依存である場合
  - コード例: `src/middleware/serve-static/index.ts:34-47`（`getContent` / `join` / `isDir` の注入）
  - 注意点: インターフェースではなく関数シグネチャで契約を定義している。TypeScript では GoF の Strategy よりこの関数注入型の方が軽量で実用的

- **Adapter** (分類: 構造)
  - 解決する問題: ランタイム固有のイベント/リクエスト形式を Web Standards の `Request`/`Response` に変換する
  - 適用条件: 外部システム（ランタイム）のインターフェースが制御不能で、内部システムのインターフェースと異なる場合
  - コード例: 全 `src/adapter/*/handler.ts`
  - 注意点: GoF の Adapter パターンそのものだが、クラスベースではなく関数ベースで実装されている

## Good Patterns

- **アダプターの厚みをランタイムの乖離度に比例させる**: Vercel（3 行）から AWS Lambda（680 行）まで、アダプターの複雑さはランタイム API と Web Standards の距離に正確に比例する。不要な抽象化層を入れず、必要な分だけ変換コードを書くことで保守コストを最小化している。

```typescript
// src/adapter/vercel/handler.ts:4-8 — Web Standards に近いランタイムは極薄
export const handle = (app: Hono<any, any, any>) =>
  (req: Request): Response | Promise<Response> => app.fetch(req)
```

- **型ガード関数によるイベントディスクリミネーション**: AWS Lambda アダプターでは `isProxyEventALB`、`isProxyEventV2`、`isLatticeEventV2` の型ガード関数でイベント形式を判別する。`Object.hasOwn` による存在チェックは実行時コストが低く、TypeScript の型ナローイングとも連携する。

```typescript
// src/adapter/aws-lambda/handler.ts:631-643
export const getProcessor = (event: LambdaEvent): EventProcessor<LambdaEvent> => {
  if (isProxyEventALB(event)) return albProcessor
  if (isProxyEventV2(event)) return v2Processor
  if (isLatticeEventV2(event)) return latticeV2Processor
  return v1Processor  // デフォルトフォールバック
}
```

- **ヘルパー型による統一インターフェースの強制**: `GetConnInfo`、`UpgradeWebSocket`、`FileSystemModule` などの型定義をヘルパー層で一元管理し、全アダプターがこの型に準拠する。型レベルの契約によりアダプター間の一貫性を保証する。

```typescript
// src/helper/conninfo/types.ts:45 — 全アダプターがこの型に従う
export type GetConnInfo = (c: Context) => ConnInfo
```

## Anti-Patterns / 注意点

- **アダプター内にビジネスロジックを持ち込む**: アダプターの責務は「変換」のみであるべき。例えば Service Worker アダプターの「404 時に fetch にフォールバック」する処理（`src/adapter/service-worker/handler.ts:30-31`）は境界事例だが、これ以上の判断ロジックをアダプター内に入れると責務が曖昧になる。

```typescript
// Bad: アダプター内でルーティング的な判断を行う
export const handle = (app, opts) => (evt) => {
  evt.respondWith((async () => {
    const res = await app.fetch(evt.request, {}, evt)
    if (opts.fetch && res.status === 404) {
      return await opts.fetch(evt.request)  // この判断はミドルウェアで行うべき
    }
    return res
  })())
}

// Better: フォールバックはミドルウェアとして実装する
app.use('*', async (c, next) => {
  await next()
  if (c.res.status === 404) {
    return fetch(c.req.raw)
  }
})
```

- **プロセッサ選択のイベント判別ロジックの脆弱性**: `isProxyEventV2` は `rawPath` の存在だけで判定する。将来 AWS が新しいイベント形式を追加した場合、判定順序によっては誤ったプロセッサが選択される可能性がある。判別ロジックはより厳密なバージョンチェック（`event.version === '2.0'`）の方が安全だが、Hono は軽量さを優先してこの設計を採用している。

## 導出ルール

- `[MUST]` マルチランタイムフレームワークを設計する場合、コアの入出力を Web Standards API（Request/Response）に限定し、ランタイム固有の型をコアに漏洩させない
  - 根拠: Hono のコア（`hono-base.ts`）はランタイム固有の型を一切 import しておらず、`fetch(Request): Response` のみを公開する。これにより 9 ランタイム対応でもコアの変更が不要

- `[MUST]` アダプターの責務は「外部インターフェースから内部インターフェースへの変換」に限定し、ビジネスロジックやルーティング判断を含めない
  - 根拠: Vercel/Netlify アダプターが各 3-4 行で済むのは、変換以外の責務を持たないため。AWS Lambda も EventProcessor の責務は Request/Response の変換のみ

- `[SHOULD]` ランタイム固有の操作を Strategy として注入可能にし、共通ロジックは高階関数またはベースクラスで提供する
  - 根拠: `serveStatic` は `getContent`/`join`/`isDir` を注入する高階関数パターンで、3 ランタイムのファイルアクセス差異を吸収しつつ、パス解決・MIME 判定・プリコンプレス対応のコードは共有している（`src/middleware/serve-static/index.ts:34-125`）

- `[SHOULD]` アダプターの複雑さはターゲットプラットフォームの API 乖離度に比例させ、不要な抽象化層を導入しない
  - 根拠: Hono は 9 アダプター共通の `AbstractAdapter` クラスを作っていない。Vercel は 3 行、Lambda は 680 行。統一インターフェースを強制するよりも各ランタイムの慣習に合わせる方が実用的

- `[SHOULD]` 判別型ユニオンに対する型ガードは、プロパティの存在チェック（`Object.hasOwn` / `in`）で実装し、TypeScript の型ナローイングと連携させる
  - 根拠: AWS Lambda アダプターの `isProxyEventALB` 等は `Object.hasOwn` で判別し、戻り値型の `event is ALBProxyEvent` で型を絞り込む。これにより後続のコードで型安全にイベントを扱える（`src/adapter/aws-lambda/handler.ts:645-661`）

- `[AVOID]` 全アダプターに共通の抽象基底クラスを作ること。各ランタイムの入出力が根本的に異なる場合、共通インターフェースの強制はアダプターを不自然に複雑にする
  - 根拠: Hono は `EventProcessor` を AWS Lambda 内部でのみ使用し、全アダプター共通の基底クラスは持たない。Vercel の `handle` と Lambda の `handle` はシグネチャが異なり、統一する意味がない

- `[AVOID]` アダプター層でランタイムの動的検出を行うこと。アダプターはコンパイル時（ビルド時）にランタイムが確定しているべきで、実行時の `typeof Deno !== 'undefined'` のような分岐はヘルパー層に隔離する
  - 根拠: `getRuntimeKey()` は `src/helper/adapter/index.ts` に隔離されており、`src/adapter/` 内のコードはランタイム検出を行わない

## 適用チェックリスト

- [ ] フレームワーク/ライブラリのコアが Web Standards API（Request/Response/Headers/URL 等）のみに依存しているか確認する
- [ ] 各アダプターが「変換」以外の責務を持っていないか確認する（ルーティング、認証、バリデーション等が混入していないか）
- [ ] ランタイム固有の操作（ファイル I/O、WebSocket、接続情報取得等）に対して、注入可能な Strategy インターフェースを定義しているか確認する
- [ ] アダプターの複雑さがターゲットプラットフォームの API 乖離度に比例しているか確認する（過剰な抽象化をしていないか）
- [ ] 新しいランタイムを追加する際に、コアの変更が不要であることを確認する
- [ ] 型ガードによるイベント/リクエスト形式の判別が TypeScript の型ナローイングと連携しているか確認する
- [ ] ランタイム検出ロジックがアダプター層ではなくヘルパー層に隔離されているか確認する
