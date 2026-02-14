# Practice: Zero-Dependency Security

> 出典: [repos/honojs/hono](../repos/honojs/hono/)
> カテゴリ: practice

## 概要

Web Crypto API（`crypto.subtle`）のみで JWT 署名/検証・Cookie 署名・タイミングセーフ比較・ETag ハッシュを実装し、Node.js 固有の `crypto` モジュールを一切使わずにセキュリティ機能を実現するゼロ依存プラクティス。ランタイム可搬性（Node.js/Deno/Bun/Cloudflare Workers/Edge Runtime）を確保しつつ、RFC 準拠のセキュリティ品質を維持する。セキュリティヘッダーのデフォルト有効化やアルゴリズム混乱攻撃の防御など、"Secure by Default" の設計哲学も実践的な参考になる。

## 背景・文脈

Hono は9以上のランタイムで動作する Web フレームワークであり、Node.js の `require('crypto')` を使うとエッジランタイム（Cloudflare Workers, Deno Deploy 等）で動作しなくなる。W3C 標準の Web Crypto API に統一することで、全ランタイムで同一のセキュリティコードが動作する設計を実現している。

セキュリティミドルウェア群（Basic Auth, Bearer Auth, JWT, CORS, CSRF, Secure Headers, IP Restriction, Body Limit）のすべてがこの原則に従っている。

## 実装パターン

### 1. タイミングセーフ比較 -- ハッシュ後の固定長比較

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

  // ハッシュ値は固定長 → 文字列長の違いから情報が漏洩しない
  return sa === sb && a === b
}
```

### 2. JWT アルゴリズム混乱攻撃の防御

```typescript
// src/utils/jwt/jwt.ts:127-129 -- ヘッダーの alg と指定の alg を照合
if (header.alg !== alg) {
  throw new JwtAlgorithmMismatch(alg, header.alg)
}

// src/utils/jwt/jwt.ts:184-220 -- JWK 検証で対称アルゴリズムを拒否
const symmetricAlgorithms: SymmetricAlgorithm[] = [
  AlgorithmTypes.HS256, AlgorithmTypes.HS384, AlgorithmTypes.HS512,
]

export const verifyWithJwks = async (token, options, init) => {
  // ...
  if (symmetricAlgorithms.includes(header.alg as SymmetricAlgorithm)) {
    throw new JwtSymmetricAlgorithmNotAllowed(header.alg)
  }
  if (!options.allowedAlgorithms.includes(header.alg as AsymmetricAlgorithm)) {
    throw new JwtAlgorithmNotAllowed(header.alg, options.allowedAlgorithms)
  }
  // ...
}
```

### 3. セキュリティヘッダーの安全デフォルト

```typescript
// src/middleware/secure-headers/secure-headers.ts:94-124
const HEADERS_MAP: HeadersMap = {
  crossOriginResourcePolicy: ['Cross-Origin-Resource-Policy', 'same-origin'],
  crossOriginOpenerPolicy: ['Cross-Origin-Opener-Policy', 'same-origin'],
  referrerPolicy: ['Referrer-Policy', 'no-referrer'],
  strictTransportSecurity: ['Strict-Transport-Security', 'max-age=15552000; includeSubDomains'],
  xContentTypeOptions: ['X-Content-Type-Options', 'nosniff'],
  xFrameOptions: ['X-Frame-Options', 'SAMEORIGIN'],
  xXssProtection: ['X-XSS-Protection', '0'],
  // ...
}

// すべてデフォルト有効 + X-Powered-By 削除
const DEFAULT_OPTIONS: SecureHeadersOptions = {
  crossOriginResourcePolicy: true,
  crossOriginOpenerPolicy: true,
  originAgentCluster: true,
  referrerPolicy: true,
  strictTransportSecurity: true,
  xContentTypeOptions: true,
  // ... 全て true
  removePoweredBy: true,
}
```

### 4. Cookie セキュリティプレフィックスの型レベル強制

```typescript
// src/utils/cookie.ts:31-35
export type CookieConstraint<Name> = Name extends `__Secure-${string}`
  ? CookieOptions & SecureCookieConstraint    // secure: true が必須
  : Name extends `__Host-${string}`
    ? CookieOptions & HostCookieConstraint    // secure: true, path: '/' が必須
    : CookieOptions
```

### 5. CSRF の多層防御

```typescript
// src/middleware/csrf/index.ts:138-150
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
// Origin 未設定 → 一律拒否（「不明」は「安全」ではない）
```

## Good Example

```typescript
// Web Crypto API によるランタイム可搬な署名検証
const verifySignature = async (
  payload: string,
  signature: string,
  secret: string
): Promise<boolean> => {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  )
  const sig = Uint8Array.from(atob(signature), c => c.charCodeAt(0))
  return crypto.subtle.verify('HMAC', key, sig, encoder.encode(payload))
}

// タイミングセーフなトークン検証
const verifyApiKey = async (submitted: string, expected: string): Promise<boolean> => {
  const [hashA, hashB] = await Promise.all([
    sha256(submitted),
    sha256(expected),
  ])
  return hashA === hashB && submitted === expected
}

// セキュリティヘッダーはデフォルト有効、緩和は明示的に
app.use(secureHeaders())  // 引数なしで11ヘッダー + X-Powered-By 削除

// CORS: 動的オリジン設定時は Vary: Origin を自動付与
app.use(cors({
  origin: ['https://app.example.com', 'https://admin.example.com'],
  credentials: true,
}))
```

## Bad Example

```typescript
// Bad: 平文の直接比較 -- タイミング攻撃に脆弱
if (submittedToken === secretToken) {
  // 文字列の先頭から比較し、不一致で即 return → 応答時間で情報漏洩
}

// Bad: JWT のヘッダー alg をそのまま信頼
const { alg } = decode(token).header
verify(token, secret, alg)  // 攻撃者が alg を none に改竄可能

// Bad: Node.js 固有の crypto に依存
import { createHmac } from 'crypto'
const hash = createHmac('sha256', secret).update(data).digest('hex')
// → Cloudflare Workers, Deno Deploy で動作しない

// Bad: セキュリティヘッダーを個別に設定 -- 漏れが生じやすい
app.use((c, next) => {
  c.header('X-Content-Type-Options', 'nosniff')
  // X-Frame-Options は? HSTS は? Referrer-Policy は? → 漏れる
  return next()
})

// Bad: CORS で origin: '*' と credentials: true を併用
cors({ origin: '*', credentials: true })
// ブラウザが拒否する仕様だが、サーバー側で検出されない
```

## 適用ガイド

### どのような状況で使うべきか

- **マルチランタイム対応のライブラリ/フレームワーク**: Node.js, Deno, Bun, Cloudflare Workers で同一コードを動かす場合
- **エッジランタイムでのセキュリティ実装**: CDN エッジで認証・署名検証を行う場合
- **サーバーレス環境**: Lambda@Edge, Vercel Edge Functions 等で `crypto` モジュールが使えない場合
- **ゼロ依存を重視するプロジェクト**: 外部セキュリティライブラリへの依存を排除したい場合

### 導入時の注意点

- **`crypto.subtle` は非同期 API**: `createHmac(...).digest()` のような同期的な書き方はできない。`await` が必要
- **タイミングセーフ比較は async**: SHA-256 ハッシュの生成が `crypto.subtle.digest` で非同期になるため、比較関数全体が `Promise<boolean>` を返す
- **JWT エラーの細分化**: エラー理由（期限切れ、アルゴリズム不一致、署名不正等）ごとに専用の Error サブクラスを定義すると、監査とデバッグが容易になる（Hono は13種）
- **CSP Nonce の共有**: Content-Security-Policy の nonce はミドルウェアで生成し、Context 変数経由でテンプレートに渡す設計にする

### カスタマイズポイント

- セキュリティヘッダーのオプションは `boolean | string` のユニオン型で、`true` でデフォルト値、文字列でカスタム値、`false` で無効化の三段階制御
- IP 制限ルールの事前コンパイル（CIDR → bigint ビットマスク、静的 IP → Set）でリクエスト時のコストを最小化
- Cookie プレフィックス（`__Secure-`, `__Host-`）の制約を型レベルとランタイムの二重で検証

## 参考

- [repos/honojs/hono/security-practices.md](../repos/honojs/hono/security-practices.md) — タイミングセーフ比較、JWT 防御、セキュリティヘッダー、CSRF 多層防御の詳細分析
- [repos/honojs/hono/dependency-management.md](../repos/honojs/hono/dependency-management.md) — Web Crypto API によるゼロ依存戦略の全体像
- [repos/honojs/hono/type-system-patterns.md](../repos/honojs/hono/type-system-patterns.md) — CookieConstraint 条件型による型レベルセキュリティ制約
