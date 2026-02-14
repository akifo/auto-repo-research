# Web Standards

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono は "Web framework built on Web Standards" を標榜し、Fetch API (Request/Response/Headers)、Web Crypto API、Streams API、URL API をフレームワークのコアインターフェースとして採用している。特筆すべきは、これらの標準 API をそのまま公開するのではなく、薄いラッパーと巧みな抽象化によって DX を向上させつつ、標準 API への脱出口（`c.req.raw`、`c.newResponse()`）を常に残している点にある。この設計により Cloudflare Workers、Deno、Bun、Node.js、Service Worker など異なるランタイムで同一コードが動作するポータビリティを実現している。

## 設計思想

- **Standard as Interface**: ランタイム間の共通インターフェースとして Web Standards を採用し、フレームワーク独自の抽象化層を最小限にとどめる。`fetch()` のシグネチャ `(Request, Env, ExecutionContext) => Response | Promise<Response>` がアプリ全体のエントリポイントとなっている（`src/hono-base.ts:473-479`）。これによりアダプター層はランタイム固有の型を Request/Response に変換するだけで済む。

- **Wrap, Don't Replace**: 標準 API をラップして DX を改善するが、置換はしない。`HonoRequest` は `Request` をラップするが `.raw` プロパティで常に元の `Request` にアクセスできる（`src/request.ts:51`）。同様に `Context` は `Response` を直接構築して返すのではなく、`c.json()`/`c.text()` などの便利メソッドを提供しつつ、`c.newResponse()` で任意の `Response` を構築できる。

- **Progressive Enhancement of Crypto**: `crypto.subtle` の存在を前提とせず、存在チェック後にフォールバックする。`src/utils/crypto.ts:45` では `if (crypto && crypto.subtle)` のガードで `null` を返し、呼び出し側に判断を委ねる。JWT ミドルウェアは起動時にチェックして明示的なエラーメッセージを出す（`src/middleware/jwt/jwt.ts:72-74`）。

- **Stream as First-class Citizen**: Streams API を Response の body として直接使い、`TransformStream` をベースにしたストリーミングユーティリティを提供する。`ReadableStream`/`WritableStream` のペアを `TransformStream` で生成し、書き込み側を `StreamingApi` でラップ、読み取り側を `Response` の body にそのまま渡す。

## 設計・実装の詳細

### Fetch API の活用: Request/Response を中心としたアーキテクチャ

Hono のリクエスト処理パイプラインは、標準 `Request` を受け取り標準 `Response` を返す関数として設計されている。`HonoBase#fetch` メソッドがそのエントリポイントとなる。

`HonoRequest` クラスは標準 `Request` の Decorator パターンであり、パスパラメータ抽出、クエリ文字列パース、ボディキャッシュなどの機能を追加する。注目すべきは `#cachedBody` メソッドの設計で、一度消費された body を別の形式で再利用するために `new Response(body)[key]()` という手法を用いている（`src/request.ts:226-237`）。これは Response コンストラクタを「データ変換器」として利用する Web Standards ならではのテクニックである。

同様に `bufferToFormData` 関数（`src/utils/buffer.ts:55-65`）は `ArrayBuffer` から `FormData` へのパースを `new Response(arrayBuffer, { headers }).formData()` で実現している。ブラウザネイティブのパーサーを活用することで自前実装を避けている。

### URL パース: new URL() を避けるパフォーマンス最適化

`getPath()` 関数（`src/utils/url.ts:106-140`）は `new URL()` による URL パースを意図的に避け、文字列の `indexOf` と `charCodeAt` で pathname を手動抽出している。`new URL()` はリクエストごとに呼ばれるホットパスであり、オブジェクト生成コストが無視できないため、文字コード走査で高速に処理する。`HonoRequest` はクエリ文字列のパースも同様にカスタム実装（`getQueryParam`/`getQueryParams`）で行い、`URLSearchParams` の生成コストを回避している。

### Web Crypto API: ハッシュ・署名・検証の統一的利用

Web Crypto API は以下の3つの用途で体系的に利用されている:

1. **ハッシュ生成**: `crypto.subtle.digest()` による SHA-256/SHA-1 ハッシュ（`src/utils/crypto.ts:46-51`、`src/middleware/etag/digest.ts`）
2. **HMAC 署名/検証**: Cookie 署名（`src/utils/cookie.ts:39-48`）
3. **JWT 署名/検証**: `crypto.subtle.sign()`/`crypto.subtle.verify()` + `crypto.subtle.importKey()` による HMAC/RSA/ECDSA/EdDSA 対応（`src/utils/jwt/jws.ts:29-48`）

JWT 実装（`src/utils/jwt/jws.ts`）はアルゴリズムごとのパラメータマッピングを `getKeyAlgorithm()` 関数に集約し、鍵インポートは PEM/JWK/raw/CryptoKey の4形式に対応する。ランタイム差異（Node.js v18 の `CryptoKey` がグローバルにない問題）は `isCryptoKey()` で吸収する（`src/utils/jwt/jws.ts:226-234`）。

### Streams API: TransformStream ベースのストリーミング抽象化

ストリーミングヘルパーの中核は `TransformStream` でパイプを作り、`WritableStream` 側を `StreamingApi` でラップする設計である。

```
TransformStream
  ├── writable → StreamingApi (開発者が write/writeln/pipe で操作)
  └── readable → Response body (クライアントへ送出)
```

`stream()` ヘルパー（`src/helper/streaming/stream.ts:7-45`）は `new TransformStream()` で ReadableStream/WritableStream ペアを生成し、`StreamingApi` で高レベルな書き込みインターフェースを提供する。SSE 用の `SSEStreamingApi` は `StreamingApi` を継承し `writeSSE()` メソッドで SSE フォーマットを自動生成する。

`StreamingApi`（`src/utils/stream.ts`）は以下の Web Standards API を組み合わせている:
- `WritableStreamDefaultWriter` で書き込み制御
- `ReadableStream` コンストラクタで pull ベースの読み取りストリーム生成
- `TextEncoder` で文字列をバイナリ変換
- `body.pipeTo()` でストリーム接続

`compress` ミドルウェア（`src/middleware/compress/index.ts:62-63`）は `CompressionStream` を `pipeThrough()` で Response body に接続する一行で圧縮を実現している。

### body-limit ミドルウェア: ReadableStream によるサイズ制限

`bodyLimit` ミドルウェア（`src/middleware/body-limit/index.ts:93-114`）は、`body.getReader()` でチャンク単位にサイズを積算し、閾値超過時に `controller.error()` でストリームを中断する。そして元の `Request` を新しい `ReadableStream` で上書きする。これは Request body が一度しか読めないという制約を逆手に取り、ストリーム中間処理で制限をかけるパターンである。

### Service Worker / FetchEvent アダプター

`FetchEventLike`（`src/types.ts:2484-2488`）は Service Worker の `FetchEvent` を抽象化した型で、`respondWith()` と `waitUntil()` を定義する。Service Worker アダプター（`src/adapter/service-worker/handler.ts`）は `evt.respondWith()` に `app.fetch()` の結果を渡すだけの薄い層として実装されている。

### Proxy ヘルパー: RFC 準拠の Fetch ラッパー

`proxy()` 関数（`src/helper/proxy/index.ts:160-190`）は、`Request`/`Response` コンストラクタを駆使してプロキシリクエストを構築する。Hop-by-hop ヘッダーの除去、`accept-encoding` の削除、`content-encoding`/`content-length` ヘッダーの整合性維持を RFC 2616/9110 に従って処理する。`body` と `duplex: 'half'` オプションを組み合わせたリクエスト転送は、Streams API による半二重ストリーミングの実用例である。

## コード例

```typescript
// src/request.ts:218-237 — Response をデータ変換器として利用するボディキャッシュ
#cachedBody = (key: keyof Body) => {
  const { bodyCache, raw } = this
  const cachedBody = bodyCache[key]

  if (cachedBody) {
    return cachedBody
  }

  const anyCachedKey = Object.keys(bodyCache)[0]
  if (anyCachedKey) {
    return (bodyCache[anyCachedKey as keyof Body] as Promise<BodyInit>).then((body) => {
      if (anyCachedKey === 'json') {
        body = JSON.stringify(body)
      }
      return new Response(body)[key]()
    })
  }

  return (bodyCache[key] = raw[key]())
}
```

```typescript
// src/middleware/compress/index.ts:62-63 — CompressionStream による一行圧縮
const stream = new CompressionStream(encoding)
ctx.res = new Response(ctx.res.body.pipeThrough(stream), ctx.res)
```

```typescript
// src/utils/buffer.ts:55-65 — Response を使った FormData パーサー
export const bufferToFormData = (
  arrayBuffer: ArrayBuffer,
  contentType: string
): Promise<FormData> => {
  const response = new Response(arrayBuffer, {
    headers: { 'Content-Type': contentType },
  })
  return response.formData()
}
```

```typescript
// src/utils/jwt/jws.ts:29-47 — Web Crypto API による署名・検証
export async function signing(
  privateKey: SignatureKey, alg: SignatureAlgorithm, data: BufferSource
): Promise<ArrayBuffer> {
  const algorithm = getKeyAlgorithm(alg)
  const cryptoKey = await importPrivateKey(privateKey, algorithm)
  return await crypto.subtle.sign(algorithm, cryptoKey, data)
}

export async function verifying(
  publicKey: SignatureKey, alg: SignatureAlgorithm,
  signature: BufferSource, data: BufferSource
): Promise<boolean> {
  const algorithm = getKeyAlgorithm(alg)
  const cryptoKey = await importPublicKey(publicKey, algorithm)
  return await crypto.subtle.verify(algorithm, cryptoKey, signature, data)
}
```

## パターンカタログ

- **Decorator パターン** (構造)
  - 解決する問題: 標準 `Request` に DX 向上メソッド（`param()`, `query()`, ボディキャッシュ）を追加しつつ、元オブジェクトへのアクセスを保持する
  - 適用条件: 標準 API を拡張したいが、元のインターフェースとの互換性を維持する必要がある場合
  - コード例: `src/request.ts:36` (`HonoRequest` が `Request` を `raw` プロパティで保持)
  - 注意点: `raw` プロパティで body を直接消費すると `cloneRawRequest()` が動作しなくなる

- **Facade パターン** (構造)
  - 解決する問題: `Response` 構築に必要な Headers 管理、ステータスコード設定、Content-Type 設定を統一インターフェースで提供する
  - 適用条件: 複数の Web Standards API を組み合わせて使う場面で、利用者に簡潔な API を提供したい場合
  - コード例: `src/context.ts:283` (`Context` クラスの `json()`, `text()`, `html()`, `body()`)
  - 注意点: Facade が厚くなりすぎると標準 API の学習が無駄になる。`newResponse()` で脱出口を設ける

- **Strategy パターン** (振る舞い)
  - 解決する問題: JWT 署名アルゴリズムの切り替えを、Web Crypto API のパラメータマッピングに変換する
  - 適用条件: `crypto.subtle` の操作がアルゴリズム種別で分岐する場合
  - コード例: `src/utils/jwt/jws.ts:122-224` (`getKeyAlgorithm()` によるアルゴリズム→パラメータ変換)

## Good Patterns

- **Response-as-Parser**: `new Response(body)` を使ってデータ形式を変換するパターン。`bufferToFormData()` では `Response.formData()` を、`#cachedBody()` では `Response.json()`/`.text()` 等をパーサーとして活用する。ブラウザネイティブの実装を再利用でき、自前パーサーが不要になる。

```typescript
// src/utils/buffer.ts:55-65
const response = new Response(arrayBuffer, {
  headers: { 'Content-Type': contentType },
})
return response.formData()
```

- **TransformStream Pipe**: `TransformStream` で readable/writable ペアを生成し、writable 側をアプリケーション用、readable 側をレスポンス用に分離するパターン。ストリーミング処理と HTTP レスポンスの関心を分離できる。

```typescript
// src/helper/streaming/stream.ts:12-13
const { readable, writable } = new TransformStream()
const stream = new StreamingApi(writable, readable)
// ...
return c.newResponse(stream.responseReadable)
```

- **Graceful Crypto Degradation**: `crypto.subtle` の存在チェックを行い、利用不可能な環境では `null` を返してフォールバックを許容する。ミドルウェアレベルでは起動時チェックで明確なエラーを出す二段構え。

```typescript
// src/utils/crypto.ts:45-57
if (crypto && crypto.subtle) {
  const buffer = await crypto.subtle.digest({ name: algorithm.name }, sourceBuffer as ArrayBuffer)
  // ...
  return hash
}
return null
```

- **Escape Hatch via raw**: ラッパークラスに `.raw` プロパティを設け、標準 API への直接アクセスを常に保証する。フレームワークの抽象化が不十分な場合でもユーザーがブロックされない。

```typescript
// src/request.ts:51 — 元の Request オブジェクトに常にアクセス可能
raw: Request
// 使用例: Cloudflare Workers 固有の cf プロパティへのアクセス
const metadata = c.req.raw.cf?.hostMetadata
```

## Anti-Patterns / 注意点

- **Body の二重消費**: `Request.body` は一度しか読めない。`c.req.raw.body` を直接消費した後に `c.req.json()` 等を呼ぶとエラーになる。Hono はボディキャッシュで対処しているが、`raw` 経由の直接消費はキャッシュをバイパスするため `cloneRawRequest()` が失敗する。

```typescript
// Bad: raw body を直接消費するとキャッシュされない
const data = await c.req.raw.json()
const cloned = await cloneRawRequest(c.req) // HTTPException: Cannot clone request

// Better: HonoRequest のメソッドを使う（キャッシュされる）
const data = await c.req.json()
const cloned = await cloneRawRequest(c.req) // OK
```

- **ホットパスでの URL オブジェクト生成**: `new URL()` はリクエストごとに呼ばれるパスでは高コスト。pathname の抽出だけなら文字列操作で十分。

```typescript
// Bad: リクエストごとに URL オブジェクトを生成
const path = new URL(request.url).pathname

// Better: 文字列操作でパスを抽出（Hono の getPath 方式）
const url = request.url
const start = url.indexOf('/', url.indexOf(':') + 4)
// charCodeAt でスキャン...
```

- **crypto.subtle 未チェック**: Web Crypto API はすべての環境で利用可能とは限らない（HTTP 環境、古い Node.js）。存在チェックなしに呼び出すとランタイムエラーになる。

```typescript
// Bad: チェックなしで呼び出す
const hash = await crypto.subtle.digest('SHA-256', data)

// Better: 存在チェック + フォールバック
if (crypto && crypto.subtle) {
  return await crypto.subtle.digest('SHA-256', data)
}
return null
```

## 導出ルール

- `[MUST]` Web Standards ベースのフレームワークでは、ラッパークラスに標準 API への直接アクセス手段（escape hatch）を必ず設けること
  - 根拠: `HonoRequest.raw` により Cloudflare Workers の `cf` プロパティ等、フレームワークが想定しないランタイム固有機能にアクセスできる（`src/request.ts:51`）

- `[MUST]` `crypto.subtle` を使用する前に存在チェックを行い、利用不可環境での振る舞いを明示的に決定すること
  - 根拠: Hono はユーティリティ層で `null` 返却（`src/utils/crypto.ts:45`）、ミドルウェア層で起動時エラー（`src/middleware/jwt/jwt.ts:72-74`）という二段構えで対処している

- `[SHOULD]` `Request`/`Response` コンストラクタをデータ変換ユーティリティとして活用し、自前パーサーの実装を避けること
  - 根拠: `bufferToFormData()` が `new Response(buf, { headers }).formData()` で multipart パースを実現し、ブラウザネイティブ実装を再利用している（`src/utils/buffer.ts:55-65`）

- `[SHOULD]` ストリーミングレスポンスには `TransformStream` でペアを生成し、書き込み側と読み取り側の関心を分離すること
  - 根拠: `stream()` ヘルパーが `TransformStream` ベースで SSE/テキスト/バイナリストリーミングを統一的に実装している（`src/helper/streaming/stream.ts:12-13`）

- `[SHOULD]` リクエスト処理のホットパスでは `new URL()` の代わりに文字列操作でパスを抽出し、オブジェクト生成コストを避けること
  - 根拠: `getPath()` が `indexOf`/`charCodeAt` でパスを高速抽出し、URL パースのオーバーヘッドを排除している（`src/utils/url.ts:106-140`）

- `[AVOID]` `Request.body` を標準メソッド（`.json()`, `.text()` 等）とラッパーメソッドの両方で消費すること。ボディキャッシュの一貫性が崩れる
  - 根拠: `cloneRawRequest()` は `bodyCache` からの復元に依存しており、`raw` 経由の直接消費ではキャッシュされないため復元に失敗する（`src/request.ts:458-487`）

## 適用チェックリスト

- [ ] フレームワーク/ライブラリの入出力インターフェースに標準 `Request`/`Response` を採用しているか
- [ ] 標準 API のラッパーに escape hatch（`.raw` 等）を設けているか
- [ ] `crypto.subtle` を使用する箇所で存在チェックとフォールバック戦略を定義しているか
- [ ] `Response` コンストラクタをデータ変換（FormData パース、body 形式変換）に活用できる箇所がないか
- [ ] ストリーミング処理に `TransformStream` ベースの readable/writable 分離パターンを適用しているか
- [ ] リクエスト処理のホットパスで `new URL()` の代わりに文字列操作でパスを抽出できないか
- [ ] Request body の消費を一箇所に集約し、ボディキャッシュの一貫性を保っているか
- [ ] マルチランタイム対応が必要な場合、ランタイム検出を `navigator.userAgent` / グローバル変数チェックで行っているか
