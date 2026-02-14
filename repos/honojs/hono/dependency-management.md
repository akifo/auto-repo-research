# dependency-management

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono はランタイム依存パッケージをゼロに保ちながら、JWT 署名/検証、Cookie パース、HTML エスケープ、Body パース、Base64 エンコード、MIME 判定、IP アドレス処理などすべてを自前実装している。これは「Web Standard API が提供する機能だけでフレームワークを構成する」という設計方針に基づいており、結果としてマルチランタイム対応（Cloudflare Workers, Deno, Bun, Node.js, Fastly Compute, AWS Lambda）とバンドルサイズの極小化（`hono/tiny` プリセットで 12kB 未満）を同時に実現している。この視点では、ゼロ依存を維持するための具体的なプラクティスと、その判断基準を分析する。

## 背景にある原則

- **ランタイム可搬性の最大化**: 外部パッケージは特定ランタイムの API に依存していることが多い。Web Standard API のみに依存することで、コードの変更なしに 7 以上のランタイムで動作する。`node:` プレフィックスの import は adapter 層と一部のオプショナルミドルウェアに限定されている（`src/middleware/context-storage/index.ts:6`, `src/adapter/deno/serve-static.ts:1`）
- **バンドルサイズの予測可能性**: 外部依存は推移的依存（transitive dependency）を持ち込み、バンドルサイズを予測不能にする。すべてを自前で実装することで、tree-shaking の効果を最大化し、サイズの管理を完全にコントロールできる。preset パターン（tiny/quick/default）によるサイズ階層がこれを証明している
- **API の安定性と応答速度**: 外部パッケージの breaking change やセキュリティパッチへの追従コストを排除する。自前実装なら修正を即座にリリースできる
- **ホットパスの最適化余地**: 汎用ライブラリは広範なユースケースをカバーするため、特定の用途に対して過剰な処理を含む。自前実装ならフレームワーク固有のホットパスに特化した最適化が可能（例: `getPath` での `new URL()` 回避）

## 実例と分析

### Web Crypto API による暗号処理の自前実装

JWT の署名・検証を `jsonwebtoken` や `jose` に頼らず、`crypto.subtle` を直接使用して実装している。これにより Node.js の `crypto` モジュールへの依存を回避し、Cloudflare Workers や Deno でも同一コードが動作する。

```typescript
// src/utils/jwt/jws.ts:36
return await crypto.subtle.sign(algorithm, cryptoKey, data)
```

```typescript
// src/utils/jwt/jws.ts:47
return await crypto.subtle.verify(algorithm, cryptoKey, signature, data)
```

Cookie 署名にも同じパターンを適用している。

```typescript
// src/utils/cookie.ts:41
return await crypto.subtle.importKey('raw', secretBuf, algorithm, false, ['sign', 'verify'])
```

ETag ミドルウェアでは `crypto.subtle.digest` をデフォルトの digest 生成器として使用しつつ、`crypto.subtle` が利用不可能な場合のフォールバックも考慮している。

```typescript
// src/middleware/etag/index.ts:42-43
if (crypto && crypto.subtle) {
  generator = (body: Uint8Array<ArrayBuffer>) =>
    crypto.subtle.digest({ name: 'SHA-1' }, body)
}
```

### URL パースの高速自前実装

`new URL()` の呼び出しは比較的コストが高い。Hono はリクエストごとに呼ばれるホットパスでこれを回避し、`charCodeAt` と `indexOf` による手動パースを行っている。

```typescript
// src/utils/url.ts:106-134
export const getPath = (request: Request): string => {
  const url = request.url
  const start = url.indexOf('/', url.indexOf(':') + 4)
  let i = start
  for (; i < url.length; i++) {
    const charCode = url.charCodeAt(i)
    if (charCode === 37) {
      // '%' - percent encoding path
      const queryIndex = url.indexOf('?', i)
      const hashIndex = url.indexOf('#', i)
      // ...
    } else if (charCode === 63 || charCode === 35) {
      // '?' or '#'
      break
    }
  }
  return url.slice(start, i)
}
```

クエリパラメータの取得でも `URLSearchParams` を使わず、手動で `indexOf` ベースの解析を行っている（`src/utils/url.ts:219-300`）。コメントで「optimized for unencoded key」と明記されており、パフォーマンスを意識した分岐が設計されている。

### Cookie パーサーの自前実装

`cookie` パッケージ（npm）を使わず、RFC 6265 に準拠した自前パーサーを実装している。fast-path として、要求されたキーが Cookie 文字列に存在しない場合は即座に空オブジェクトを返す最適化がある。

```typescript
// src/utils/cookie.ts:79-82
export const parse = (cookie: string, name?: string): Cookie => {
  if (name && cookie.indexOf(name) === -1) {
    // Fast-path: return immediately if the demanded-key is not in the cookie string
    return {}
  }
```

### Response オブジェクトの創造的活用

FormData のパースに `new Response()` を経由するパターンで、Web API のみで ArrayBuffer から FormData への変換を実現している。

```typescript
// src/utils/buffer.ts:55-65
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

### CompressionStream / ReadableStream の活用

Compress ミドルウェアでは `CompressionStream`（Web Standard）を使い、zlib 等の外部ライブラリなしでレスポンス圧縮を実現している。

```typescript
// src/middleware/compress/index.ts:62-63
const stream = new CompressionStream(encoding)
ctx.res = new Response(ctx.res.body.pipeThrough(stream), ctx.res)
```

Body Limit ミドルウェアでは `ReadableStream` を使ってストリーミングでサイズを監視し、閾値を超えた時点でエラーを発行する。

```typescript
// src/middleware/body-limit/index.ts:93-114
const rawReader = c.req.raw.body.getReader()
const reader = new ReadableStream({
  async start(controller) {
    try {
      for (;;) {
        const { done, value } = await rawReader.read()
        if (done) { break }
        size += value.length
        if (size > maxSize) {
          controller.error(new BodyLimitError(ERROR_MESSAGE))
          break
        }
        controller.enqueue(value)
      }
    } finally { controller.close() }
  },
})
```

### TextEncoder/TextDecoder のシングルトン化

頻繁に使われる `TextEncoder` / `TextDecoder` はモジュールレベルでシングルトンとして生成し、インスタンス生成コストを削減している。

```typescript
// src/utils/jwt/utf8.ts:6-7
export const utf8Encoder: TextEncoder = new TextEncoder()
export const utf8Decoder: TextDecoder = new TextDecoder()
```

### Object.create(null) によるプロトタイプ汚染回避

ルーター全体で `Object.create(null)` を一貫して使用し、プロトタイプチェーンのないプレーンオブジェクトを生成している。`Map` を使わないのはシリアライズの容易さと V8 の hidden class 最適化が効くためと推測される。

```typescript
// src/router/trie-router/node.ts:16
const emptyParams = Object.create(null)
```

```typescript
// src/router/reg-exp-router/router.ts:128-129
this.#middleware = { [METHOD_NAME_ALL]: Object.create(null) }
this.#routes = { [METHOD_NAME_ALL]: Object.create(null) }
```

### minify を意識した変数エイリアス

長い組み込み関数名をローカル変数にエイリアスし、minifier が短縮できるようにしている。コメントで意図が明記されている。

```typescript
// src/utils/url.ts:317-319
// `decodeURIComponent` is a long name.
// By making it a function, we can use it commonly when minified, reducing the amount of code.
export const decodeURIComponent_ = decodeURIComponent
```

### ランタイム固有 API の隔離パターン

`node:` プレフィックスの import は adapter 層（`src/adapter/`）とオプショナルミドルウェア（`context-storage`）に厳密に限定されている。コアの `src/utils/` や `src/middleware/`（context-storage 以外）は一切 Node.js 固有 API を使用しない。`getRuntimeKey()` 関数でランタイムを判定し、差異を adapter 層で吸収する設計になっている。

```typescript
// src/helper/adapter/index.ts:50-84
export const getRuntimeKey = (): Runtime => {
  const global = globalThis as any
  const userAgentSupported =
    typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
  if (userAgentSupported) {
    for (const [runtimeKey, userAgent] of Object.entries(knownUserAgents)) {
      if (checkUserAgentEquals(userAgent)) { return runtimeKey as Runtime }
    }
  }
  // ... fallback chain
}
```

### Preset パターンによるバンドルサイズの段階的制御

ゼロ依存の利点を最大化するため、ルーター構成を preset で切り替えられるようにしている。`tiny` はルーター 1 つ（PatternRouter のみ）、`quick` は 2 つ（LinearRouter + TrieRouter）、デフォルトは 2 つ（RegExpRouter + TrieRouter）。ユーザーはユースケースに応じてサイズとパフォーマンスのトレードオフを選択できる。

```typescript
// src/preset/tiny.ts:11-20
export class Hono<...> extends HonoBase<E, S, BasePath> {
  constructor(options: HonoOptions<E> = {}) {
    super(options)
    this.router = new PatternRouter()
  }
}
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: ランタイムごとに異なる API（ファイルシステムアクセス、WebSocket 実装等）への対応
  - 適用条件: ランタイム固有の機能が必要だが、コア API を統一したい場合
  - コード例: `src/middleware/serve-static/index.ts:34` の `getContent` コールバック、`src/helper/adapter/index.ts:25` の `runtimeEnvHandlers`
  - 注意点: Strategy の注入は adapter レイヤーに限定し、コアには持ち込まない

- **Facade パターン** (分類: 構造)
  - 解決する問題: Web Crypto API の冗長なインターフェースをドメイン固有の簡潔な API に変換
  - 適用条件: 低レベル API の複雑さをユーザーから隠蔽したい場合
  - コード例: `src/utils/cookie.ts:39-48` の `getCryptoKey` / `makeSignature`、`src/utils/crypto.ts:33-58` の `createHash`
  - 注意点: Facade の裏で使う Web API の可用性チェックを怠らない（`if (crypto && crypto.subtle)`）

## Good Patterns

- **Web Standard API のみで暗号処理を完結させる**: `crypto.subtle` は JWT 署名/検証、Cookie 署名、ETag ハッシュ生成のすべてをカバーする。外部の暗号ライブラリが不要になり、Cloudflare Workers のような制限的環境でもそのまま動作する。コード例: `src/utils/jwt/jws.ts:29-48`, `src/utils/cookie.ts:39-48`

- **ホットパスでは Web API より低レベルな文字列操作を選択する**: `new URL()` や `URLSearchParams` の代わりに `charCodeAt` / `indexOf` / `slice` による手動パースを行い、リクエストごとのオーバーヘッドを最小化する。コード例: `src/utils/url.ts:106-134`

- **Response コンストラクタを変換ユーティリティとして活用する**: `new Response(body, { headers })` を使って ArrayBuffer から FormData へ変換する。Web API の組み合わせで専用ライブラリの機能を代替する発想。コード例: `src/utils/buffer.ts:55-65`

- **ランタイム固有コードの境界を明確にする**: `node:` import は `src/adapter/` と明示的にオプトインするミドルウェアにのみ存在し、コアコードは Web Standard API のみを使用する。コード例: `src/adapter/deno/serve-static.ts:1`, `src/adapter/bun/serve-static.ts:2-3`

## Anti-Patterns / 注意点

- **何でも自前実装する**: ゼロ依存ポリシーが適切なのは、(1) Web Standard API でカバーできる範囲が広い場合、(2) マルチランタイム対応が要件の場合、(3) フレームワークの規模で自前実装の品質を維持できるコントリビューター数がいる場合に限る。一般的なアプリケーションで暗号処理やパーサーを自前実装するのはセキュリティリスクが高い。

```typescript
// Bad: アプリケーションレベルで JWT を自前実装
const sign = (payload, secret) => {
  // 独自の Base64 + HMAC 実装...
}

// Better: ライブラリ/フレームワークが提供する機能を使い、
// 自前実装はライブラリ/フレームワーク側に限定する
import { sign } from 'hono/utils/jwt'
```

- **最適化のために可読性を犠牲にしすぎる**: `getPath` の `charCodeAt` ベースのパースは高速だが、`new URL()` と比べて意図が読み取りにくい。ホットパス以外では可読性を優先すべき。Hono では `getPath` がリクエストごとに呼ばれるため正当化されるが、月に 1 回呼ばれる関数に適用するのは過剰最適化。

```typescript
// Bad: すべての URL パースを手動で行う
const path = url.slice(url.indexOf('/', url.indexOf(':') + 4), url.indexOf('?'))

// Better: ホットパスのみ手動パース、それ以外は new URL() を使う
const url = new URL(request.url)
const path = url.pathname
```

## 導出ルール

- `[MUST]` ライブラリ/フレームワークのコアモジュールからランタイム固有 API（`node:` prefix, `Deno.*` 等）を排除し、adapter 層に隔離する
  - 根拠: Hono は `node:` import を `src/adapter/` と `context-storage`（オプトイン型ミドルウェア）にのみ限定しており、コア 350+ ファイルで Web Standard API のみを使用することで 7 ランタイムへの可搬性を実現している
- `[MUST]` 外部依存を追加する前に、同等機能を Web Standard API（`crypto.subtle`, `ReadableStream`, `CompressionStream`, `TextEncoder` 等）で実現できないか検証する
  - 根拠: Hono は JWT 処理を `crypto.subtle` で、圧縮を `CompressionStream` で、FormData 変換を `new Response()` で実現しており、ランタイム依存ゼロを達成している
- `[SHOULD]` リクエストごとに実行されるホットパスでは、`new URL()` / `URLSearchParams` の代わりに `indexOf` / `charCodeAt` / `slice` による手動パースを検討する
  - 根拠: `src/utils/url.ts` では `getPath` / `getQueryParam` で手動パースを行い、コメントで「optimized for unencoded key」と最適化意図を明記している
- `[SHOULD]` 頻繁にインスタンス化される Web API オブジェクト（`TextEncoder`, `TextDecoder`）はモジュールスコープでシングルトン化する
  - 根拠: `src/utils/jwt/utf8.ts` でモジュールレベルの `utf8Encoder` / `utf8Decoder` を共有し、リクエストごとの `new TextEncoder()` 呼び出しを排除している
- `[SHOULD]` ルックアップ用の辞書オブジェクトには `Object.create(null)` を使い、プロトタイプチェーンを排除する
  - 根拠: Hono のルーター実装全体（`reg-exp-router`, `trie-router`, `linear-router`, `pattern-router`）で一貫して `Object.create(null)` を使用しており、プロトタイプ汚染防止と V8 最適化の両方に寄与している
- `[SHOULD]` minifier の効果を最大化するため、長い組み込み関数名はローカル変数にエイリアスして再利用する
  - 根拠: `src/utils/url.ts:317-319` で `decodeURIComponent` を `decodeURIComponent_` にエイリアスし、コメントで minify 時のコード量削減を意図として明記している
- `[AVOID]` アプリケーションコードで暗号処理や HTTP パースを自前実装する。ゼロ依存戦略はフレームワーク/ライブラリレベルの判断であり、十分なテストカバレッジとコントリビューターが前提
  - 根拠: Hono の JWT 実装（`src/utils/jwt/`）は 5 ファイル・数百行の規模で RFC 7515/7519 に準拠しており、網羅的なテスト（`jwt.test.ts` 1000行超）に支えられている。この投資はフレームワークだからこそ正当化される

## 適用チェックリスト

- [ ] `package.json` の `dependencies`（devDependencies ではない）を棚卸しし、Web Standard API で代替できるものがないか確認する
- [ ] `crypto.subtle` で代替できる暗号処理（ハッシュ生成、HMAC 署名、JWT）に外部ライブラリを使っていないか確認する
- [ ] ランタイム固有の import（`node:`, `Deno.*`）がコアモジュールに混在していないか確認し、adapter 層に隔離する
- [ ] リクエストホットパスで `new URL()` や `URLSearchParams` を毎回呼んでいないか確認し、必要に応じて手動パースに置き換える
- [ ] `TextEncoder` / `TextDecoder` がリクエストごとに `new` されていないか確認し、シングルトン化する
- [ ] ルックアップ用辞書が `{}` リテラルで作られていないか確認し、`Object.create(null)` に置き換えを検討する
- [ ] フレームワーク/ライブラリの場合、preset パターンによるバンドルサイズの段階的制御が可能か検討する
