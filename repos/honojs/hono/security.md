# Security

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono はセキュリティを「ミドルウェアの組み合わせ」として設計しており、認証(basic-auth, bearer-auth, jwt, jwk)、CSRF 防御、CORS 制御、IP 制限、ボディサイズ制限、セキュリティヘッダーなど包括的なセキュリティスタックを提供する。
特筆すべきは、Web Crypto API への全面依存によるランタイム非依存の暗号処理、タイミング攻撃を防ぐ比較関数の標準搭載、JWT における Algorithm Confusion Attack 対策の徹底である。
フレームワーク組み込みのセキュリティミドルウェアとして、開発者が安全なデフォルトを得られる設計になっている。

## 設計・実装の詳細

### 認証ミドルウェアのアーキテクチャ

Hono の認証ミドルウェアは「静的トークン比較」と「カスタム検証関数」の二つのモードを Union Type で提供する統一パターンを採用している。

Basic Auth は `username`/`password` 指定と `verifyUser` 関数の二択、Bearer Auth は `token` 指定と `verifyToken` 関数の二択をオプション型として定義する。これにより、シンプルなユースケースと複雑なユースケース（DB 照合等）の両方を型安全にカバーする。

```typescript
// src/middleware/basic-auth/index.ts:14-27
type BasicAuthOptions =
  | {
      username: string
      password: string
      realm?: string
      hashFunction?: Function
      invalidUserMessage?: string | object | MessageFunction
    }
  | {
      verifyUser: (username: string, password: string, c: Context) => boolean | Promise<boolean>
      realm?: string
      hashFunction?: Function
      invalidUserMessage?: string | object | MessageFunction
    }
```

認証失敗時は全ミドルウェアが `HTTPException` をスローし、適切な HTTP ステータスコードと `WWW-Authenticate` ヘッダーを返す。レスポンスオブジェクトを例外に内包することで、フレームワークのエラーハンドラと統合できる。

### タイミングセーフ比較

Basic Auth と Bearer Auth はクレデンシャル比較に `timingSafeEqual` を使用する。この関数はハッシュ化してから比較することで、文字列長の違いによるタイミング情報の漏洩を防ぐ。

```typescript
// src/utils/buffer.ts:29-45
export const timingSafeEqual = async (
  a: string | object | boolean,
  b: string | object | boolean,
  hashFunction?: Function
): Promise<boolean> => {
  if (!hashFunction) {
    hashFunction = sha256
  }

  const [sa, sb] = await Promise.all([hashFunction(a), hashFunction(b)])

  if (!sa || !sb) {
    return false
  }

  return sa === sb && a === b
}
```

ハッシュ比較（`sa === sb`）で定数時間比較を実現した後、元の値の等価性（`a === b`）でハッシュ衝突を排除する二段階方式を採る。`Promise.all` で両方のハッシュを並列計算し、処理時間から入力の正誤を推測されることを防ぐ。

### JWT 検証の多層防御

JWT ミドルウェアは `alg` パラメータを必須とし、ヘッダーの `alg` と照合することで Algorithm Confusion Attack を防止する。

```typescript
// src/utils/jwt/jwt.ts:96-129
export const verify = async (
  token: string,
  publicKey: SignatureKey,
  algOrOptions: SignatureAlgorithm | VerifyOptionsWithAlg
): Promise<JWTPayload> => {
  if (!algOrOptions) {
    throw new JwtAlgorithmRequired()
  }
  // ...
  if (header.alg !== alg) {
    throw new JwtAlgorithmMismatch(alg, header.alg)
  }
```

JWK 検証（`verifyWithJwks`）ではさらに厳格な対策を実装する。対称鍵アルゴリズム（HS256/384/512）を明示的に禁止し、許可リストに含まれるアルゴリズムのみを受け入れる。

```typescript
// src/utils/jwt/jwt.ts:184-219
const symmetricAlgorithms: SymmetricAlgorithm[] = [
  AlgorithmTypes.HS256,
  AlgorithmTypes.HS384,
  AlgorithmTypes.HS512,
]

export const verifyWithJwks = async (
  token: string,
  options: {
    keys?: HonoJsonWebKey[]
    jwks_uri?: string
    verification?: VerifyOptions
    allowedAlgorithms: readonly AsymmetricAlgorithm[]
  },
  init?: RequestInit
): Promise<JWTPayload> => {
  // ...
  // Reject symmetric algorithms to prevent algorithm confusion attacks
  if (symmetricAlgorithms.includes(header.alg as SymmetricAlgorithm)) {
    throw new JwtSymmetricAlgorithmNotAllowed(header.alg)
  }
  // Validate against allowed algorithms
  if (!options.allowedAlgorithms.includes(header.alg as AsymmetricAlgorithm)) {
    throw new JwtAlgorithmNotAllowed(header.alg, options.allowedAlgorithms)
  }
```

JWT のクレーム検証も包括的で、`exp`（有効期限）、`nbf`（開始時刻）、`iat`（発行時刻）、`iss`（発行者、文字列と正規表現の両対応）、`aud`（対象者、配列と正規表現の両対応）をサポートする。エラーは専用の例外クラスで分類される。

### CSRF 防御の二重検証

CSRF ミドルウェアは Origin ヘッダーと `Sec-Fetch-Site` ヘッダーの二重検証を行う。両方が失敗した場合のみリクエストを拒否する。

```typescript
// src/middleware/csrf/index.ts:138-151
return async function csrf(c, next) {
  if (
    !isSafeMethodRe.test(c.req.method) &&
    isRequestedByFormElementRe.test(c.req.header('content-type') || 'text/plain') &&
    !(await isAllowedSecFetchSite(c.req.header('sec-fetch-site'), c)) &&
    !(await isAllowedOrigin(c.req.header('origin'), c))
  ) {
    const res = new Response('Forbidden', { status: 403 })
    throw new HTTPException(403, { res })
  }
  await next()
}
```

GET/HEAD はセーフメソッドとしてスキップし、フォーム送信の Content-Type（`application/x-www-form-urlencoded`, `multipart/form-data`, `text/plain`）のみを検査対象とする。API 呼び出し（`application/json`）は CORS プリフライトで保護されるため、意図的にスコープ外としている。

### Secure Headers のセキュアデフォルト

`secureHeaders()` はゼロ引数で呼ぶだけで 12 種類のセキュリティヘッダーが有効になる。

```typescript
// src/middleware/secure-headers/secure-headers.ts:109-124
const DEFAULT_OPTIONS: SecureHeadersOptions = {
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: true,
  crossOriginOpenerPolicy: true,
  originAgentCluster: true,
  referrerPolicy: true,
  strictTransportSecurity: true,
  xContentTypeOptions: true,
  xDnsPrefetchControl: true,
  xDownloadOptions: true,
  xFrameOptions: true,
  xPermittedCrossDomainPolicies: true,
  xXssProtection: true,
  removePoweredBy: true,
  permissionsPolicy: {},
}
```

CSP の nonce 生成は `crypto.getRandomValues` を使い、暗号論的に安全な乱数を保証する。

```typescript
// src/middleware/secure-headers/secure-headers.ts:131-145
const generateNonce = () => {
  const arrayBuffer = new Uint8Array(16)
  crypto.getRandomValues(arrayBuffer)
  return encodeBase64(arrayBuffer.buffer)
}

export const NONCE: ContentSecurityPolicyOptionHandler = (ctx) => {
  const key = 'secureHeadersNonce'
  const init = ctx.get(key)
  const nonce = init || generateNonce()
  if (init == null) {
    ctx.set(key, nonce)
  }
  return `'nonce-${nonce}'`
}
```

### IP 制限の効率的なマッチング

IP 制限ミドルウェアは CIDR 表記をビット演算で処理し、IPv4/IPv6 の両方に対応する。ルールをビルド時に「静的ルール（Set）」「CIDR ルール（ビットマスク）」「関数ルール」に分類し、実行時の分岐を最小化する。

```typescript
// src/middleware/ip-restriction/index.ts:37-113
const buildMatcher = (
  rules: IPRestrictionRule[]
): ((addr: { addr: string; type: AddressType; isIPv4: boolean }) => boolean) => {
  const functionRules: IPRestrictionRuleFunction[] = []
  const staticRules: Set<string> = new Set()
  const cidrRules: [boolean, bigint, bigint][] = []
  // ...ビルド時にルールを分類
```

deny-first 評価順序（拒否リスト -> 許可リスト -> デフォルト）を採用し、許可リストが空の場合は全てのアドレスを許可するフォールバック動作を持つ。

### Body Limit によるリソース枯渇防御

ボディサイズ制限はストリーミング方式で実装されている。Content-Length ヘッダーがある場合は事前チェックで即座に拒否し、chunked transfer の場合はストリームを監視して累積サイズを追跡する。

```typescript
// src/middleware/body-limit/index.ts:74-88
// RFC 7230: If both Transfer-Encoding and Content-Length are present,
// Transfer-Encoding takes precedence and Content-Length should be ignored
if (hasTransferEncoding && hasContentLength) {
  // Both headers present - follow RFC 7230 and ignore Content-Length
  // This might indicate request smuggling attempt
}

if (hasContentLength && !hasTransferEncoding) {
  // Only Content-Length present - we can trust it
  const contentLength = parseInt(c.req.raw.headers.get('content-length') || '0', 10)
  return contentLength > maxSize ? onError(c) : next()
}
```

`Transfer-Encoding` と `Content-Length` の同時存在を RFC 7230 に従って処理し、HTTP Request Smuggling の兆候を検知する設計になっている。

### combine ミドルウェアによる認証の合成

`some`/`every`/`except` コンビネータを使って認証ロジックを合成できる。

```typescript
// src/middleware/combine/index.ts:38 の使用例（コメントより）
// If client has a valid token, then skip rate limiting.
// Otherwise, apply rate limiting.
app.use('/api/*', some(
  bearerAuth({ token }),
  myRateLimit({ limit: 100 }),
));
```

`some` は最初に成功したミドルウェアで評価を停止し、`every` は全ての条件を満たす必要がある。`except` はパスパターンやコンディション関数で特定のルートを認証から除外する。

## コード例

タイミングセーフ比較を用いた Basic Auth のクレデンシャル検証。

```typescript
// src/middleware/basic-auth/index.ts:94-104
for (const user of users) {
  const [usernameEqual, passwordEqual] = await Promise.all([
    timingSafeEqual(user.username, requestUser.username, options.hashFunction),
    timingSafeEqual(user.password, requestUser.password, options.hashFunction),
  ])
  if (usernameEqual && passwordEqual) {
    await next()
    return
  }
}
```

JWT ペイロードをコンテキスト変数に格納して後続ハンドラで利用可能にする設計。

```typescript
// src/middleware/jwt/jwt.ts:131-157
let payload
let cause
try {
  payload = await Jwt.verify(token, options.secret, {
    alg: options.alg,
    ...verifyOpts,
  })
} catch (e) {
  cause = e
}
if (!payload) {
  throw new HTTPException(401, {
    message: 'Unauthorized',
    res: unauthorizedResponse({ /* ... */ }),
    cause,  // 元の検証エラーを cause として伝播
  })
}
ctx.set('jwtPayload', payload)
```

CORS ミドルウェアが Vary ヘッダーを適切に設定し、キャッシュポイズニングを防止する例。

```typescript
// src/middleware/cors/index.ts:117-119
if (opts.origin !== '*') {
  set('Vary', 'Origin')
}
```

## Good Patterns

- **Union Type による認証オプションの型安全な分岐**: Basic Auth / Bearer Auth は「静的値」と「検証関数」を Union Type で表現し、コンパイル時に不正な組み合わせを排除する。`'username' in options` による型ガードで実行時も安全に分岐する。

```typescript
// src/middleware/basic-auth/index.ts:14-27
type BasicAuthOptions =
  | { username: string; password: string; realm?: string; /* ... */ }
  | { verifyUser: (username: string, password: string, c: Context) => boolean | Promise<boolean>; /* ... */ }
```

- **HTTPException によるセキュアなエラーレスポンス**: 認証失敗時に `HTTPException` へ事前構築した `Response` を渡すことで、エラーハンドラが意図しない情報漏洩を起こさない。ステータスコード、`WWW-Authenticate` ヘッダー、エラーメッセージが一体で管理される。

```typescript
// src/middleware/basic-auth/index.ts:108-126
const res =
  typeof responseMessage === 'string'
    ? new Response(responseMessage, { status, headers })
    : new Response(JSON.stringify(responseMessage), {
        status,
        headers: { ...headers, 'content-type': 'application/json' },
      })
throw new HTTPException(status, { res })
```

- **JWK 検証での対称鍵アルゴリズム明示拒否**: `verifyWithJwks` で HS256/384/512 を明示的に禁止する。公開鍵インフラ（JWK）で対称鍵アルゴリズムを許可すると、公開鍵を HMAC シークレットとして悪用する Algorithm Confusion Attack が成立するため、この防御は必須。

```typescript
// src/utils/jwt/jwt.ts:212-215
if (symmetricAlgorithms.includes(header.alg as SymmetricAlgorithm)) {
  throw new JwtSymmetricAlgorithmNotAllowed(header.alg)
}
```

- **Secure Headers のゼロコンフィグデフォルト**: `secureHeaders()` を引数なしで呼ぶだけで、HSTS、X-Frame-Options、CSP 関連の主要ヘッダーが設定される。`removePoweredBy: true` がデフォルトで、技術スタック情報の漏洩も防ぐ。ヘッダー値を `boolean | string` で受け付け、`true` でデフォルト値、文字列で上書きという柔軟性を持つ。

- **ストリーミング対応の Body Limit**: Content-Length がない chunked リクエストでもストリームを監視してサイズ制限を適用する。RFC 7230 に準拠して `Transfer-Encoding` と `Content-Length` の同時存在時の優先順位を正しく処理する。

## Anti-Patterns / 注意点

- **CORS の origin: '*' とクレデンシャルの同時指定**: Hono の CORS ミドルウェアはデフォルトで `origin: '*'` であり、`credentials: true` と組み合わせるとブラウザが拒否する。この組み合わせは明示的にエラーにならないため、開発者が気づきにくい。

```typescript
// Bad: ブラウザが CORS エラーを返す
app.use('/api/*', cors({
  credentials: true,
  // origin のデフォルトは '*'
}))

// Better: 明示的にオリジンを指定
app.use('/api/*', cors({
  origin: 'https://app.example.com',
  credentials: true,
}))
```

- **JWT の alg 指定なしでの利用**: Hono v4 以降は `alg` が必須パラメータだが、他のフレームワークでは省略可能な場合がある。alg をトークンのヘッダーから読み取って信頼すると、攻撃者が `none` アルゴリズムや意図しない対称鍵アルゴリズムを指定できる。

```typescript
// Bad: alg をサーバー側で指定しない（Hono では型エラーで防止される）
jwt({ secret: 'my-secret' })

// Better: 明示的にアルゴリズムを指定（Hono の設計）
jwt({ secret: 'my-secret', alg: 'HS256' })
```

- **timingSafeEqual のハッシュ関数依存**: `timingSafeEqual` は `crypto.subtle` が利用できない環境（一部の古いランタイム）で `null` を返し、比較が常に `false` になる。テスト環境と本番環境の暗号 API 可用性が異なる場合にサイレントに認証が失敗する可能性がある。

```typescript
// src/utils/buffer.ts:40-43 - crypto.subtle がない環境で null が返る
const [sa, sb] = await Promise.all([hashFunction(a), hashFunction(b)])
if (!sa || !sb) {
  return false  // 常に false になり認証が通らない
}
```

## 自分のプロジェクトへの適用

- [ ] 認証ミドルウェアで文字列比較を行っている箇所を `timingSafeEqual` 相当の定数時間比較に置き換える
- [ ] JWT 検証時に `alg` パラメータをサーバー側で必ず指定し、トークンヘッダーの `alg` と照合する
- [ ] JWK/JWKS を使う場合は対称鍵アルゴリズム（HS256/384/512）を明示的に拒否する
- [ ] `secureHeaders()` 相当のセキュリティヘッダーを全レスポンスに適用する（特に HSTS, X-Frame-Options, X-Content-Type-Options）
- [ ] CSRF 防御は Origin と Sec-Fetch-Site の二重検証を検討し、フォーム送信の Content-Type のみスコープとする
- [ ] ファイルアップロード等のエンドポイントに Body Limit を適用し、chunked transfer にも対応するストリーミング方式を採用する
- [ ] CORS の `origin: '*'` をデフォルトで使わず、許可するオリジンを明示的に列挙する
- [ ] `some`/`every`/`except` パターンで認証ロジックを合成可能に設計し、パスごとに異なるセキュリティポリシーを宣言的に記述する
