# design-philosophy

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono は「Web Standards の上にフレームワークを構築する」という設計思想を徹底的に貫いた Web フレームワークである。Fetch API の Request/Response をコアの入出力境界とし、Web Crypto API でセキュリティ処理を行い、Streams API でストリーミングを実現する。この徹底した Web Standards 準拠により、ゼロ外部依存とマルチランタイム対応を同時に達成している。注目すべきは、これが単なるポータビリティの追求ではなく、「プラットフォームの進化に乗る」という長期的な設計判断であることだ。

## 設計思想

- **Web Standards を唯一の抽象化レイヤーとする原則**: Hono のコア全体が Fetch API の `Request`/`Response` を入出力の境界としている。`hono-base.ts` の `fetch` メソッド（`src/hono-base.ts:473-479`）は標準の `Request` を受け取り `Response` を返す。これは Cloudflare Workers の `export default { fetch }` パターンに直接対応しており、ランタイム固有の抽象化を一切介さない。Web Standards を選んだ理由は、各ランタイムが競って準拠を進める「最大公約数」だからである。

- **依存ゼロにより制約を自由に変える原則**: `package.json` の `dependencies` は空であり、全機能が自前実装されている。JWT 署名検証（`src/utils/jwt/jws.ts`）は `crypto.subtle` を直接使い、Base64 エンコード（`src/utils/encode.ts`）は `btoa`/`atob` を使う。外部ライブラリに依存しないことで、エッジランタイムのバンドルサイズ制約（Cloudflare Workers の 1MB 制限等）に対応し、かつ各ランタイムの Web Standards 実装差異を自前で吸収できる。

- **Adapter Pattern によるランタイム差異の隔離原則**: コアは Web Standards のみで動作し、ランタイム固有の処理は `src/adapter/` に隔離する。AWS Lambda アダプタ（`src/adapter/aws-lambda/handler.ts:308-327`）は Lambda イベントを `new Request()` に変換し、`Response` を Lambda 結果に戻す。コアの変更なしに新ランタイムを追加できるのは、この境界が Web Standards という安定した契約で定義されているからである。

- **Preset/Strategy による柔軟なトレードオフ選択原則**: 5種のルーターと3種のプリセット（default, tiny, quick）を提供し、ユーザーがパフォーマンスとバンドルサイズのトレードオフを選択できる。`hono/tiny`（`src/preset/tiny.ts`）は PatternRouter 単体で最小サイズを実現し、デフォルトの `Hono`（`src/hono.ts`）は SmartRouter が RegExpRouter と TrieRouter を自動選択する。設計思想として「正解は一つではない」ことを認め、選択肢を提供している。

## 設計・実装の詳細

### Web Standards 境界の設計

Hono の最も重要な設計判断は、フレームワークの入出力境界を Web Standards の Fetch API に固定したことである。`HonoBase` クラスの `fetch` プロパティが全てのエントリポイントとなる。

```ts
// src/hono-base.ts:473-479
fetch: (
  request: Request,
  Env?: E['Bindings'] | {},
  executionCtx?: ExecutionContext
) => Response | Promise<Response> = (request, ...rest) => {
  return this.#dispatch(request, rest[1], rest[0], request.method)
}
```

この設計により、Cloudflare Workers では `export default app` だけで動作し、Service Worker では `addEventListener('fetch', handle(app))` で動作する。Node.js のような Fetch API 非ネイティブ環境のみ別途アダプタ（`@hono/node-server`、devDependency として参照）が必要になるが、これは外部パッケージとしてコアから分離されている。

### Adapter Pattern の実装

各ランタイムアダプタの責務は「ランタイム固有イベントと Web Standards の相互変換」に限定される。AWS Lambda アダプタを例にとると、`EventProcessor` 抽象クラスが変換ロジックを定義し、API Gateway v1/v2、ALB、Lattice の差異をサブクラスで吸収する。

```ts
// src/adapter/aws-lambda/handler.ts:308-327
createRequest(event: E): Request {
  const queryString = this.getQueryString(event)
  const domainName = this.getDomainName(event)
  const path = this.getPath(event)
  const urlPath = `https://${domainName}${path}`
  const url = queryString ? `${urlPath}?${queryString}` : urlPath

  const headers = this.getHeaders(event)
  const method = this.getMethod(event)
  const requestInit: RequestInit = { headers, method }

  if (event.body) {
    requestInit.body = event.isBase64Encoded ? decodeBase64(event.body) : event.body
  }
  return new Request(url, requestInit)
}
```

全てのアダプタに共通するのは、最終的に `app.fetch(req, env)` を呼び出す点である。アダプタは「翻訳者」であり、ビジネスロジックを含まない。

### ゼロ依存の実現戦略

Hono が自前実装している主要な機能群と、それぞれが依拠する Web Standards API を以下に示す。

| 機能 | 使用する Web Standards API | 実装ファイル |
|------|---------------------------|-------------|
| JWT 署名/検証 | `crypto.subtle.sign`, `crypto.subtle.verify` | `src/utils/jwt/jws.ts` |
| ハッシュ計算 | `crypto.subtle.digest` | `src/utils/crypto.ts` |
| Base64 エンコード/デコード | `btoa`, `atob` | `src/utils/encode.ts` |
| ストリーミング | `TransformStream`, `ReadableStream` | `src/helper/streaming/stream.ts` |
| FormData パース | `Response.formData()` | `src/utils/buffer.ts:56-65` |
| タイミングセーフ比較 | `crypto.subtle.digest` 経由 | `src/utils/buffer.ts:29-45` |

特に注目すべきは `bufferToFormData` の実装で、`new Response(arrayBuffer, { headers }).formData()` というトリックにより、FormData パーサーを自前実装せずブラウザ/ランタイムの実装に委譲している。

### SmartRouter: 実行時自動最適化

SmartRouter は Strategy パターンの変形で、初回マッチ時に最適なルーターを自動選択し、以降はそのルーターに委譲する。

```ts
// src/router/smart-router/router.ts:21-50
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
        continue
      }
      throw e
    }
    this.match = router.match.bind(router)  // メソッド差し替え
    this.#routers = [router]
    this.#routes = undefined  // 初期データを解放
    break
  }
  // ...
}
```

`this.match = router.match.bind(router)` でメソッド自体を差し替え、2回目以降のマッチではオーバーヘッドがゼロになる。また `this.#routes = undefined` で初期化データをGC対象にする。

### ランタイム検出メカニズム

`getRuntimeKey()` 関数（`src/helper/adapter/index.ts:50-84`）は `navigator.userAgent` を第一の判定手段とし、フォールバックとしてグローバルオブジェクトの特徴を検査する。この実装は Web Standards（Navigator API）を優先しつつ、未対応環境への実用的な対応も行う現実主義を示している。

```ts
// src/helper/adapter/index.ts:50-84
export const getRuntimeKey = (): Runtime => {
  const global = globalThis as any
  const userAgentSupported =
    typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
  if (userAgentSupported) {
    for (const [runtimeKey, userAgent] of Object.entries(knownUserAgents)) {
      if (checkUserAgentEquals(userAgent)) {
        return runtimeKey as Runtime
      }
    }
  }
  if (typeof global?.EdgeRuntime === 'string') { return 'edge-light' }
  if (global?.fastly !== undefined) { return 'fastly' }
  if (global?.process?.release?.name === 'node') { return 'node' }
  return 'other'
}
```

## コード例

### Context が Web Standards Response を生成する過程

```ts
// src/context.ts:672-684
text: TextRespond = (
  text: string,
  arg?: ContentfulStatusCode | ResponseOrInit,
  headers?: HeaderRecord
): ReturnType<TextRespond> => {
  // 最適化: ヘッダもステータスも未設定なら直接 new Response(text)
  return !this.#preparedHeaders && !this.#status && !arg && !headers && !this.finalized
    ? (new Response(text) as ReturnType<TextRespond>)
    : (this.#newResponse(
        text, arg, setDefaultContentType(TEXT_PLAIN, headers)
      ) as ReturnType<TextRespond>)
}
```

ヘッダやステータスが設定されていない場合、`new Response(text)` を直接返すことで不要なオブジェクト生成を避けている。これは Web Standards API のデフォルト挙動（status=200, Content-Type=text/plain）を活用した最適化である。

### Dispatch の単一ハンドラ最適化

```ts
// src/hono-base.ts:423-442
// Do not `compose` if it has only one handler
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
    ? res
        .then(
          (resolved: Response | undefined) =>
            resolved || (c.finalized ? c.res : this.#notFoundHandler(c))
        )
        .catch((err: Error) => this.#handleError(err, c))
    : (res ?? this.#notFoundHandler(c))
}
```

ミドルウェアが1つだけの場合に `compose()` を呼ばず直接実行する。エッジ環境では1リクエストあたりの CPU 時間が制限されるため、このような微細な最適化が積み重なって意味を持つ。

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: ルーティングアルゴリズムの選択をユーザーに委ねつつ、デフォルトで最適な選択を提供する
  - 適用条件: 同じインターフェースで異なるアルゴリズムが必要な場合
  - コード例: `src/router.ts:29-52` の `Router<T>` インターフェース、5種のルーター実装
  - 注意点: SmartRouter の「初回マッチで確定」方式はホットパス最適化だが、全ルーターが同一インターフェースを満たす必要がある

- **Adapter パターン** (分類: 構造)
  - 解決する問題: ランタイム固有のイベント形式と Web Standards の Request/Response の変換
  - 適用条件: コアが標準インターフェースで設計されており、外部システムとの接続が必要な場合
  - コード例: `src/adapter/aws-lambda/handler.ts:268-388` の `EventProcessor` 抽象クラス
  - 注意点: アダプタにビジネスロジックを混入させないこと。アダプタの責務は「翻訳」のみ

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: AWS Lambda の複数イベント形式（API Gateway v1/v2, ALB, Lattice）のパース差異を統一
  - 適用条件: アルゴリズムの骨格は共通だが、個別ステップの実装が異なる場合
  - コード例: `src/adapter/aws-lambda/handler.ts:268-388` の `EventProcessor` と4つのサブクラス
  - 注意点: `getPath`, `getMethod`, `getHeaders` 等の抽象メソッドが差し替えポイント

- **Chain of Responsibility パターン** (分類: 振る舞い)
  - 解決する問題: ミドルウェアの連鎖的な処理（認証 -> ログ -> ハンドラ -> レスポンス加工）
  - 適用条件: リクエスト処理のパイプライン構築
  - コード例: `src/compose.ts:15-73` の koa-compose ベースのミドルウェア合成
  - 注意点: `next()` の呼び忘れで後続ミドルウェアが実行されない

## Good Patterns

- **Web Standards を入出力の契約とする**: コアの `fetch` メソッドが `(Request) => Response | Promise<Response>` という Web Standards の型を入出力の契約としている。これにより、Web Standards に準拠するランタイムであれば自動的に互換性を持つ。また `export default app` だけで Cloudflare Workers/Deno/Bun で動作し、アダプタなしで最も直接的な統合が実現される。

```ts
// src/hono-base.ts:473-479 - コアの契約
fetch: (request: Request, Env?: E['Bindings'] | {}, executionCtx?: ExecutionContext) =>
  Response | Promise<Response>

// ユーザーコード: これだけで複数ランタイムに対応
export default app
```

- **自前実装で Web API を直接利用する**: JWT、ハッシュ、Base64 等のユーティリティを全て Web Crypto API や `btoa`/`atob` で実装している。これにより Node.js 固有の `crypto` モジュールや `Buffer` への依存を排除し、エッジランタイムでの動作を保証する。

```ts
// src/utils/crypto.ts:33-58 - crypto.subtle を直接使用
export const createHash = async (data: Data, algorithm: Algorithm): Promise<string | null> => {
  // ...
  if (crypto && crypto.subtle) {
    const buffer = await crypto.subtle.digest({ name: algorithm.name }, sourceBuffer as ArrayBuffer)
    const hash = Array.prototype.map
      .call(new Uint8Array(buffer), (x) => ('00' + x.toString(16)).slice(-2))
      .join('')
    return hash
  }
  return null
}
```

- **メソッド差し替えによる初回コスト償却**: SmartRouter が初回マッチ後に `this.match` を最適ルーターのメソッドに差し替える。これは JavaScript の動的性質を活用した実用的な最適化であり、2回目以降のルーティングではゼロオーバーヘッドとなる。

```ts
// src/router/smart-router/router.ts:46-49
this.match = router.match.bind(router)  // 2回目以降はこの関数が直接呼ばれる
this.#routers = [router]
this.#routes = undefined  // GC 対象にする
```

## Anti-Patterns / 注意点

- **Web Standards の前提で Node.js 固有 API を使う**: Hono のアプローチを採用する際、Node.js の `Buffer`、`crypto`（非 Web Crypto）、`fs` 等を直接使うとマルチランタイム互換性が壊れる。

```ts
// Bad: Node.js 固有 API に依存
import { createHash } from 'node:crypto'
const hash = createHash('sha256').update(data).digest('hex')

// Better: Web Crypto API を使用
const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data))
const hash = Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('')
```

- **アダプタにビジネスロジックを混入させる**: アダプタの責務は「翻訳」のみであるべき。レスポンスの加工やバリデーションをアダプタに入れると、ランタイムごとに挙動が変わるリスクがある。

```ts
// Bad: アダプタ内でビジネスロジック
export const handle = (app) => async (event) => {
  const req = processor.createRequest(event)
  if (event.headers['x-api-key'] !== 'secret') { return { statusCode: 403 } } // NG
  const res = await app.fetch(req)
  return processor.createResult(res)
}

// Better: ビジネスロジックはミドルウェアで
app.use(async (c, next) => {
  if (c.req.header('x-api-key') !== 'secret') throw new HTTPException(403)
  await next()
})
export const handler = handle(app)
```

- **ランタイム分岐をコア全体に散在させる**: Hono は `getRuntimeKey()` を集約的に使い、ランタイム分岐をアダプタ層と一部のユーティリティに限定している。コアのロジックに `if (runtime === 'node')` のような分岐を散在させると保守性が著しく低下する。

## 導出ルール

- `[MUST]` マルチランタイム対応ライブラリでは、コアの入出力境界を Web Standards API（Request/Response）で定義する
  - 根拠: Hono は `fetch: (Request) => Response | Promise<Response>` を契約とし、9つのランタイムで同一コードが動作する（`src/hono-base.ts:473-479`）
- `[MUST]` ランタイム固有の処理はアダプタ層に隔離し、コアに混入させない
  - 根拠: Hono の `src/adapter/` は Lambda イベントの変換等をコアから完全分離しており、新ランタイム追加時にコア変更が不要（`src/adapter/aws-lambda/handler.ts`）
- `[SHOULD]` 暗号・ハッシュ処理は Web Crypto API (`crypto.subtle`) を使い、ランタイム固有の crypto モジュールに依存しない
  - 根拠: Hono の JWT 実装（`src/utils/jwt/jws.ts:29-47`）とハッシュ実装（`src/utils/crypto.ts:33-58`）は全て `crypto.subtle` で統一されている
- `[SHOULD]` 複数の実装戦略が考えられる場合、共通インターフェースを定義して Strategy パターンで切り替え可能にする
  - 根拠: Hono は `Router<T>` インターフェース（`src/router.ts:29-52`）で5種のルーターを統一し、SmartRouter による自動選択とプリセットによる手動選択の両方を提供する
- `[SHOULD]` エッジランタイム向けでは、ホットパス上の不要なオブジェクト生成・関数呼び出しを排除する
  - 根拠: `#dispatch` の単一ハンドラ最適化（`src/hono-base.ts:423-442`）や `text()` の直接 Response 生成（`src/context.ts:677-678`）がエッジ環境の CPU 時間制約に対応している
- `[AVOID]` フレームワークのコア部分に外部依存を追加してマルチランタイム互換性を損なうこと
  - 根拠: Hono は dependencies ゼロを維持し、`btoa`/`atob`（`src/utils/encode.ts`）や `Response.formData()`（`src/utils/buffer.ts:56-65`）等の Web Standards API で全ユーティリティを自前実装している

## 適用チェックリスト

- [ ] フレームワーク/ライブラリの入出力が Web Standards API（Request/Response, ReadableStream 等）で定義されているか確認する
- [ ] `package.json` の `dependencies` に含まれる各パッケージが対象ランタイム全てで動作するか検証する
- [ ] 暗号・ハッシュ処理で `node:crypto` ではなく `crypto.subtle` を使っているか確認する
- [ ] ランタイム固有コードがアダプタ層に隔離されており、コアに `if (runtime === 'xxx')` 分岐が散在していないか確認する
- [ ] パフォーマンスとサイズのトレードオフについて、ユーザーが選択肢を持てる設計（プリセット等）になっているか検討する
- [ ] エッジランタイムのバンドルサイズ制約とCPU時間制約を考慮し、ホットパスの最適化を行っているか確認する
- [ ] サードパーティ拡張（ミドルウェア等）を外部パッケージとして分離し、コアの依存ゼロを維持しているか確認する
