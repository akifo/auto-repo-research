# security-practices

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono のセキュリティミドルウェア群（認証・CORS・CSRF・セキュリティヘッダー・IP 制限・ボディサイズ制限・JWT/JWK）を横断的に分析し、Web フレームワークにおけるセキュリティプラクティスを抽出した。特に注目に値するのは、Web Crypto API への全面的な依存による ランタイム可搬性の確保、タイミングセーフ比較の一貫した適用、そして安全なデフォルト値の設計哲学である。エッジランタイム（Cloudflare Workers, Deno Deploy 等）で動作するフレームワークとして、Node.js 固有の `crypto` モジュールを一切使わずにセキュリティ機能を実現している点が実践的な参考になる。

## 背景にある原則

- **Secure by Default（安全なデフォルト）**: セキュリティ関連の設定はデフォルトで最も制限的な値を採用し、開発者が明示的に緩和しない限り保護が有効になる設計を取るべき。`secureHeaders` はデフォルトで 11 個のヘッダーを有効にし `X-Powered-By` を削除する（`src/middleware/secure-headers/secure-headers.ts:109-124`）。CSRF ミドルウェアは `same-origin` のみを許可する（`src/middleware/csrf/index.ts:117`）。
- **Platform-Agnostic Cryptography（プラットフォーム非依存の暗号処理）**: セキュリティ機能の暗号処理は特定ランタイムの API ではなく、W3C 標準の Web Crypto API（`crypto.subtle`）に統一すべき。これにより Node.js/Deno/Bun/Cloudflare Workers 間の可搬性が保証される。コードベース全体で `crypto.subtle.importKey`, `crypto.subtle.sign`, `crypto.subtle.verify`, `crypto.subtle.digest` を直接使用し、Node.js の `crypto` モジュールへの依存が皆無である。
- **Constant-Time Comparison（定数時間比較の原則）**: 秘密情報の比較は入力長に依存しない定数時間アルゴリズムを使うべき。平文の `===` はタイミング攻撃に対して脆弱である。Basic Auth と Bearer Auth の両方で `timingSafeEqual` を通じた比較を強制している（`src/utils/buffer.ts:29-45`）。
- **RFC 準拠によるエッジケース防御**: セキュリティ境界に関わる処理は RFC の仕様に忠実に実装すべき。Cookie の `__Secure-`/`__Host-` プレフィックス制約（RFC 6265bis）、`Transfer-Encoding` と `Content-Length` の同時存在時の優先順位（RFC 7230）、CORS の `Vary: Origin` ヘッダー付与（MDN/RFC 7231）など、仕様に基づいた防御をコードレベルで強制している。

## 実例と分析

### タイミングセーフ比較の設計

認証ミドルウェアでの秘密情報比較は、直接的な文字列比較を避け、ハッシュ化後に比較する二段階方式を採用している。

```typescript
// src/utils/buffer.ts:29-45
export const timingSafeEqual = async (
  a: string | object | boolean,
  b: string | object | boolean,
  hashFunction?: Function,
): Promise<boolean> => {
  if (!hashFunction) {
    hashFunction = sha256;
  }

  const [sa, sb] = await Promise.all([hashFunction(a), hashFunction(b)]);

  if (!sa || !sb) {
    return false;
  }

  return sa === sb && a === b;
};
```

ハッシュ値の比較を先に行い、一致した場合のみ元の値を比較する。ハッシュ値は固定長のため、文字列長の違いから情報が漏洩することを防ぐ。Basic Auth では username と password を `Promise.all` で並列にタイミングセーフ比較している（`src/middleware/basic-auth/index.ts:96-98`）。

### CSRF 対策の多層防御

CSRF ミドルウェアは Origin ヘッダーと `Sec-Fetch-Site` ヘッダーの二重検証を行い、どちらか一方が通れば許可する OR 条件で設計されている。

```typescript
// src/middleware/csrf/index.ts:138-150
return async function csrf(c, next) {
  if (
    !isSafeMethodRe.test(c.req.method)
    && isRequestedByFormElementRe.test(c.req.header("content-type") || "text/plain")
    && !(await isAllowedSecFetchSite(c.req.header("sec-fetch-site"), c))
    && !(await isAllowedOrigin(c.req.header("origin"), c))
  ) {
    const res = new Response("Forbidden", { status: 403 });
    throw new HTTPException(403, { res });
  }
  await next();
};
```

重要な設計判断として、`application/json` リクエストは CSRF チェックの対象外にしている（`isRequestedByFormElementRe` が `application/x-www-form-urlencoded`, `multipart/form-data`, `text/plain` のみにマッチ）。これはブラウザの HTML フォームから送信可能な Content-Type のみを対象にする合理的な絞り込みである。ヘッダーが未設定の場合は一律拒否する（`src/middleware/csrf/index.ts:107-109`, `127-129`）。

### セキュリティヘッダーの一括適用とカスタマイズ

`secureHeaders` ミドルウェアはデフォルトで包括的なヘッダーセットを有効にしつつ、個別のオーバーライドを許容する。

```typescript
// src/middleware/secure-headers/secure-headers.ts:94-107
const HEADERS_MAP: HeadersMap = {
  crossOriginResourcePolicy: ["Cross-Origin-Resource-Policy", "same-origin"],
  crossOriginOpenerPolicy: ["Cross-Origin-Opener-Policy", "same-origin"],
  referrerPolicy: ["Referrer-Policy", "no-referrer"],
  strictTransportSecurity: ["Strict-Transport-Security", "max-age=15552000; includeSubDomains"],
  xContentTypeOptions: ["X-Content-Type-Options", "nosniff"],
  xFrameOptions: ["X-Frame-Options", "SAMEORIGIN"],
  xXssProtection: ["X-XSS-Protection", "0"],
  // ...
};
```

`boolean | string` のユニオン型でオプションを定義し、`true` でデフォルト値、文字列でカスタム値、`false` で無効化する三段階の制御を実現している（`src/middleware/secure-headers/secure-headers.ts:67` の `overridableHeader` 型）。CSP の Nonce は Context 変数に保存し、ミドルウェアとテンプレートの間で共有する設計をとっている（`src/middleware/secure-headers/secure-headers.ts:137-145`）。

### JWT アルゴリズム混乱攻撃の防御

JWK 検証で対称アルゴリズム（HS256/HS384/HS512）を明示的に拒否し、アルゴリズム混乱攻撃を防いでいる。

```typescript
// src/utils/jwt/jwt.ts:184-220
const symmetricAlgorithms: SymmetricAlgorithm[] = [
  AlgorithmTypes.HS256,
  AlgorithmTypes.HS384,
  AlgorithmTypes.HS512,
];

export const verifyWithJwks = async (token, options, init) => {
  // ...
  if (symmetricAlgorithms.includes(header.alg as SymmetricAlgorithm)) {
    throw new JwtSymmetricAlgorithmNotAllowed(header.alg);
  }
  if (!options.allowedAlgorithms.includes(header.alg as AsymmetricAlgorithm)) {
    throw new JwtAlgorithmNotAllowed(header.alg, options.allowedAlgorithms);
  }
  // ...
};
```

さらに `verify` 関数ではトークンヘッダーの `alg` と指定されたアルゴリズムの一致を検証し、攻撃者がヘッダーを改竄してアルゴリズムをダウングレードする攻撃を防御している（`src/utils/jwt/jwt.ts:127-129`）。JWT のエラーは 13 種の専用 Error サブクラスで細分化し、デバッグと監査を容易にしている（`src/utils/jwt/types.ts`）。

### ボディサイズ制限とリクエストスマグリング対策

`bodyLimit` ミドルウェアは RFC 7230 に基づき、`Transfer-Encoding` と `Content-Length` が同時に存在する場合を明示的にハンドリングしている。

```typescript
// src/middleware/body-limit/index.ts:77-82
// RFC 7230: If both Transfer-Encoding and Content-Length are present,
// Transfer-Encoding takes precedence and Content-Length should be ignored
if (hasTransferEncoding && hasContentLength) {
  // Both headers present - follow RFC 7230 and ignore Content-Length
  // This might indicate request smuggling attempt
}
```

`Content-Length` が単独で存在する場合のみヘッダー値を信頼し、それ以外ではストリーミング読み取りで実際のバイト数を計測する。これはリクエストスマグリング攻撃への防御を兼ねている。

### Cookie セキュリティプレフィックスの型レベル強制

Cookie の `__Secure-` / `__Host-` プレフィックスに対する制約を、TypeScript の条件型（`CookieConstraint`）でコンパイル時に強制している。

```typescript
// src/utils/cookie.ts:31-35
export type CookieConstraint<Name> = Name extends `__Secure-${string}` ? CookieOptions & SecureCookieConstraint
  : Name extends `__Host-${string}` ? CookieOptions & HostCookieConstraint
  : CookieOptions;
```

テンプレートリテラル型を使い、Cookie 名に応じて `secure: true` や `path: '/'` を型レベルで必須にしている。加えてランタイムでも同じ制約を検証し、二重の防御を実現している（`src/utils/cookie.ts:144-162`）。

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 認証方式（固定トークン vs カスタム検証関数）や CORS オリジン検証（文字列/配列/関数）を統一的なインターフェースで切り替える
  - 適用条件: セキュリティポリシーの検証ロジックが複数のバリエーションを持つ場合
  - コード例: `src/middleware/cors/index.ts:75-87`（`findAllowOrigin` — 文字列/配列/関数を同一シグネチャに統一）、`src/middleware/bearer-auth/index.ts:103-106`（`token` vs `verifyToken`）
  - 注意点: 即時実行関数で初期化時にストラテジーを確定させ、リクエストごとの分岐コストを排除している

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: 認証失敗時のレスポンス生成を共通化しつつ、メッセージ・ステータス・ヘッダーをカスタマイズ可能にする
  - 適用条件: エラーレスポンスの構造は同じだが、詳細が異なる複数のエラーケースがある場合
  - コード例: `src/middleware/bearer-auth/index.ts:119-151`（`throwHTTPException` ヘルパー）
  - 注意点: `WWW-Authenticate` ヘッダーの組み立てを関数に閉じ込め、RFC 準拠のレスポンスを保証している

## Good Patterns

- **安全なデフォルトの一括有効化**: `secureHeaders()` を引数なしで呼ぶだけで 11 個のセキュリティヘッダー + `X-Powered-By` 削除が有効になる。開発者が個別にヘッダーを知らなくても基本的な保護が得られる設計。

```typescript
// src/middleware/secure-headers/secure-headers.ts:109-124
const DEFAULT_OPTIONS: SecureHeadersOptions = {
  crossOriginResourcePolicy: true,
  crossOriginOpenerPolicy: true,
  originAgentCluster: true,
  referrerPolicy: true,
  strictTransportSecurity: true,
  xContentTypeOptions: true,
  // ... 全て true
  removePoweredBy: true,
};
```

- **CORS の Vary ヘッダー自動付与**: オリジンが `*` でない場合に `Vary: Origin` を自動で追加し、CDN キャッシュ汚染を防ぐ。OPTIONS レスポンスと通常レスポンスの両方で付与している。

```typescript
// src/middleware/cors/index.ts:117-119, 156-158
if (opts.origin !== "*") {
  set("Vary", "Origin");
}
// ...
if (opts.origin !== "*") {
  c.header("Vary", "Origin", { append: true });
}
```

- **JWT エラーの詳細な型分類**: JWT 検証の失敗理由を 13 種の専用 Error サブクラスに分離し、`error.name` でプログラマティックにハンドリング可能にしている。

```typescript
// src/utils/jwt/types.ts — 例の一部
export class JwtAlgorithmMismatch extends Error { ... }
export class JwtTokenExpired extends Error { ... }
export class JwtSymmetricAlgorithmNotAllowed extends Error { ... }
export class JwtAlgorithmNotAllowed extends Error { ... }
```

- **IP 制限のルール事前コンパイル**: CIDR ルールをビット演算用のバイナリ表現に変換し、静的ルールを `Set` にキャッシュすることで、リクエストごとの評価コストを最小化している。

```typescript
// src/middleware/ip-restriction/index.ts:37-113
const buildMatcher = (rules: IPRestrictionRule[]) => {
  const staticRules: Set<string> = new Set();
  const cidrRules: [boolean, bigint, bigint][] = [];
  // ... ルール解析を初期化時に実行
  return (remote) => {
    if (staticRules.has(remote.addr)) return true; // O(1) ルックアップ
    for (const [isIPv4, addr, mask] of cidrRules) {
      if ((remoteAddr & mask) === addr) return true; // ビット演算
    }
    // ...
  };
};
```

## Anti-Patterns / 注意点

- **平文のトークン/パスワード比較**: 認証情報の比較に `===` を直接使うと、文字列の先頭から一致しない文字が見つかった時点で短絡終了するため、タイミング攻撃で秘密情報を推測される危険がある。

Bad:

```typescript
// 平文の直接比較（タイミング攻撃に脆弱）
if (submittedToken === secretToken) {
  // 認証成功
}
```

Better:

```typescript
// ハッシュ化後の定数時間比較（Hono の実装）
// src/utils/buffer.ts:29-45
const [sa, sb] = await Promise.all([sha256(a), sha256(b)]);
return sa === sb && a === b;
```

- **CORS で `origin: '*'` と `credentials: true` の併用**: CORS で全オリジンを許可しつつ認証情報（Cookie 等）を含むリクエストを受け入れると、ブラウザが拒否する仕様になっているが、サーバー側でこの組み合わせを検出せずに設定ミスが埋もれる。Hono の CORS ミドルウェアはこの検証を行っていない点に注意が必要。

Bad:

```typescript
cors({ origin: "*", credentials: true });
```

Better:

```typescript
cors({
  origin: ["https://app.example.com", "https://admin.example.com"],
  credentials: true,
});
```

- **JWT アルゴリズムを検証しない**: トークンヘッダーの `alg` フィールドをそのまま信頼すると、攻撃者が `none` や意図しないアルゴリズムにすり替え可能。Hono は `alg` オプションを必須にし、ヘッダーの値と一致するか検証している。

Bad:

```typescript
// ヘッダーの alg をそのまま使う
const { alg } = decode(token).header;
verify(token, secret, alg);
```

Better:

```typescript
// アルゴリズムをサーバー側で指定し、ヘッダーと照合
// src/utils/jwt/jwt.ts:127-129
if (header.alg !== alg) {
  throw new JwtAlgorithmMismatch(alg, header.alg);
}
```

## 導出ルール

- `[MUST]` 認証トークン・パスワード等の秘密情報の比較にはタイミングセーフな比較関数を使う — 平文の `===` 比較はタイミングサイドチャネルで情報が漏洩する
  - 根拠: Basic Auth / Bearer Auth の全比較箇所で `timingSafeEqual`（ハッシュ後の固定長比較）を使用している（`src/middleware/basic-auth/index.ts:96-98`, `src/middleware/bearer-auth/index.ts:184-187`）

- `[MUST]` JWT 検証時はサーバー側で許可するアルゴリズムを明示的に指定し、トークンヘッダーの `alg` をそのまま信頼しない
  - 根拠: `jwt()` ミドルウェアは `alg` を必須オプションとし、`verify` 関数内でヘッダーの `alg` との一致を検証している（`src/utils/jwt/jwt.ts:114-129`）。JWK 検証では対称アルゴリズムを明示的に拒否している（`src/utils/jwt/jwt.ts:212-214`）

- `[MUST]` セキュリティヘッダーはデフォルトで有効にし、無効化を明示的な選択にする
  - 根拠: `DEFAULT_OPTIONS` で 11 個のヘッダーが `true`、`removePoweredBy` も `true` に設定されており、`secureHeaders()` を引数なしで呼ぶだけで保護が有効になる（`src/middleware/secure-headers/secure-headers.ts:109-124`）

- `[SHOULD]` 暗号処理には Node.js `crypto` ではなく Web Crypto API（`crypto.subtle`）を使い、ランタイム可搬性を確保する
  - 根拠: ハッシュ、署名、検証、鍵インポートの全ての暗号処理が `crypto.subtle` 経由で実装されており、Node.js 固有の `require('crypto')` が一切存在しない

- `[SHOULD]` CORS でオリジンをリクエストの `Origin` ヘッダー値に動的に設定する場合は `Vary: Origin` をレスポンスに含め、CDN キャッシュ汚染を防ぐ
  - 根拠: `cors()` ミドルウェアは `origin !== '*'` の場合に `Vary: Origin` を自動付与している（`src/middleware/cors/index.ts:118-119, 156-158`）

- `[SHOULD]` セキュリティルールの評価ロジック（IP 制限、CIDR マッチング等）はミドルウェア初期化時に事前コンパイルし、リクエストごとの解析コストを排除する
  - 根拠: `buildMatcher` は静的ルールを `Set` に、CIDR を `bigint` ビットマスクに変換し、リクエスト時は O(1) ルックアップとビット演算のみで判定する（`src/middleware/ip-restriction/index.ts:37-113`）

- `[AVOID]` Origin ヘッダーや `Sec-Fetch-Site` ヘッダーが未設定の場合にリクエストを許可するデフォルト実装にしない — 未設定は「不明」であり「安全」ではない
  - 根拠: CSRF ミドルウェアは Origin が `undefined` の場合に一律 `false` を返す設計にしている（`src/middleware/csrf/index.ts:107-109`）

- `[AVOID]` Cookie のセキュリティ属性（`Secure`, `HttpOnly`, `SameSite`, `__Host-`/`__Secure-` プレフィックス）をランタイム検証だけに頼る — 可能な限り型レベルでも制約を表現する
  - 根拠: `CookieConstraint<Name>` 条件型が `__Secure-` / `__Host-` プレフィックスに応じた型制約をコンパイル時に強制している（`src/utils/cookie.ts:31-35`）

## 適用チェックリスト

- [ ] 認証トークン・パスワード・API キーの比較にタイミングセーフな関数を使っているか（`===` 直接比較を検索して排除する）
- [ ] JWT 検証でサーバー側のアルゴリズム指定を必須にし、トークンヘッダーの `alg` を無条件に信頼していないか
- [ ] JWK 検証で対称アルゴリズム（HS256 等）を明示的に拒否しているか
- [ ] セキュリティヘッダー（HSTS, X-Content-Type-Options, X-Frame-Options, CSP 等）がデフォルトで有効になっているか
- [ ] `X-Powered-By` ヘッダーが本番環境で削除されているか
- [ ] CORS 設定で `origin: '*'` と `credentials: true` を同時に使っていないか
- [ ] CORS でオリジンを動的に返す場合に `Vary: Origin` ヘッダーを含めているか
- [ ] CSRF 対策が GET/HEAD 以外のメソッドで有効になっているか
- [ ] リクエストボディのサイズ制限が設定されているか（DoS 防御）
- [ ] `Transfer-Encoding` と `Content-Length` の同時存在を適切にハンドリングしているか（リクエストスマグリング対策）
- [ ] 暗号処理が Web Crypto API で実装され、特定ランタイムに依存していないか（マルチランタイム対応が必要な場合）
- [ ] Cookie のセキュリティ属性（`Secure`, `HttpOnly`, `SameSite`）が適切に設定されているか、型レベルでの制約も検討したか
