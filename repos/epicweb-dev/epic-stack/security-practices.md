# セキュリティ実装パターン

> リポジトリ: epicweb-dev/epic-stack
> 分析日: 2026-02-18

## 概要

Epic Stack のセキュリティ実装を横断的に分析した。CSP nonce 注入、階層化レート制限、ハニーポット、TOTP ベースの検証、パスキー (WebAuthn)、HIBP によるパスワード漏洩チェックなど、多層防御が体系的に設計されている。特筆すべきは「CSRF トークンを意図的に削除した」という設計判断で、`SameSite=Lax` + honeypot の組み合わせで十分であるとする根拠が ADR として残されている。セキュリティ機能を段階的に導入できる設計（CSP report-only デフォルト等）は、スターターテンプレートとして優れたバランスである。

## 背景にある原則

- **多層防御 (Defense in Depth)**: 単一の防御策に頼らず、レート制限・ハニーポット・TOTP・パスキー・CSP・セッション検証を組み合わせている。パスワード認証にも HIBP チェックを加えることで、「既知の漏洩パスワードを使えない」層を追加している（`app/utils/auth.server.ts:269-294`）
- **安全なデフォルトと段階的厳格化**: CSP を report-only で開始し、ユーザーが準備できたら enforce に切り替える方針を採用。新規導入者が CSP でブロックされて挫折するリスクを回避しつつ、本番では厳格化できる道を残している（ADR `022-report-only-csp.md`）
- **プロトコルレベルの保護を優先する**: CSRF トークンを削除し `SameSite=Lax` に依存する判断は、アプリケーション層のトークン管理よりブラウザのプロトコルレベル保護を信頼するという原則に基づく。ただし GET リクエストで状態変更しないという前提条件が明示されている（ADR `035-remove-csrf.md`）
- **Fail-open ではなく Fail-safe をデフォルトにする**: HIBP API がタイムアウトした場合は `false`（パスワードは安全と見なす）を返す。ただし 1 秒のタイムアウトを設定し、UX への影響を最小化している。セキュリティチェックが外部依存する場合の fail-open 設計の判断が明確

## 実例と分析

### 1. 階層化レート制限

`server/index.ts:92-149` では、3 段階のレート制限を HTTP メソッドとエンドポイントに応じて使い分けている。

```ts
// server/index.ts:110-122
const strongestRateLimit = rateLimit({
  ...rateLimitDefault,
  windowMs: 60 * 1000,
  limit: 10 * maxMultiple,
})

const strongRateLimit = rateLimit({
  ...rateLimitDefault,
  windowMs: 60 * 1000,
  limit: 100 * maxMultiple,
})

const generalRateLimit = rateLimit(rateLimitDefault)
```

適用ロジックでは、認証関連パス (`/login`, `/signup`, `/verify` 等) への非 GET リクエストに最も厳しい制限を、その他の非 GET に中程度の制限を、GET には一般的な制限を適用する。さらに `/verify` は GET でもトークンを含むため最も厳しい制限を適用している。

IP アドレスの取得では `Fly-Client-Ip` ヘッダーを優先する設計が重要。`req.ip` はプロキシチェーン経由で簡単に偽装できるが、CDN/PaaS が付与するヘッダーは信頼性が高い。

```ts
// server/index.ts:104-107
keyGenerator: (req: express.Request) => {
  const ip = req.ip ?? req.socket?.remoteAddress
  return req.get('fly-client-ip') ?? ipKeyGenerator(ip ?? '0.0.0.0')
},
```

### 2. CSP nonce の注入フロー

リクエストごとに暗号学的に安全な nonce を生成し、React Context を通じてアプリケーション全体に伝播させる。

```ts
// app/entry.server.tsx:46
const nonce = crypto.randomBytes(16).toString('hex')
```

この nonce は `NonceProvider` で React ツリーに注入され、`root.tsx` の `Document` コンポーネントで全ての `<script>` タグに渡される。

```tsx
// app/root.tsx:163-170
<script
  nonce={nonce}
  dangerouslySetInnerHTML={{
    __html: `window.ENV = ${JSON.stringify(env)}`,
  }}
/>
<ScrollRestoration nonce={nonce} />
<Scripts nonce={nonce} />
```

CSP ディレクティブでは `'strict-dynamic'` と nonce を併用し、nonce 付きスクリプトから動的にロードされるスクリプトも許可される。

```ts
// app/entry.server.tsx:82-86
'script-src': [
  "'strict-dynamic'",
  "'self'",
  `'nonce-${nonce}'`,
],
```

### 3. ハニーポットによるボット対策

公開フォーム（ログイン、サインアップ、パスワードリセット、検証）にハニーポットフィールドを設置している。認証済みフォームには不要という判断が ADR に記載されている。

```ts
// app/utils/honeypot.server.ts:3-6
export const honeypot = new Honeypot({
  validFromFieldName: process.env.NODE_ENV === 'test' ? null : undefined,
  encryptionSeed: process.env.HONEYPOT_SECRET,
})
```

テスト環境では `validFromFieldName: null` にすることで時間ベースの検証を無効化し、テストが高速で通るようにしている。各フォームの action では `checkHoneypot(formData)` を先頭で呼び出す統一パターンを採用。

### 4. TOTP ベースの統一検証フレームワーク

メール検証・パスワードリセット・2FA をすべて同一の TOTP 基盤 (`Verification` モデル) で処理する。`type` フィールドで用途を区別し、`target` フィールドで検証対象（メールアドレスまたはユーザー ID）を指定する。

```ts
// app/routes/_auth/verify.server.ts:90-95
const { otp, ...verificationConfig } = await generateTOTP({
  algorithm: 'SHA-256',
  // Leaving off 0, O, and I on purpose to avoid confusing users.
  charSet: 'ABCDEFGHJKLMNPQRSTUVWXYZ123456789',
  period,
})
```

文字セットから `0`, `O`, `I` を除外している点は UX とセキュリティの交差点として優れた判断。検証成功後は `deleteVerification()` でワンタイム性を担保している（2FA の場合は永続的に保持）。

### 5. 認証の多層構造

ログインフローで 2FA が有効な場合、セッションは「未検証状態」で `verifySessionStorage` に保持される。2FA コード入力後に初めて `authSessionStorage` に昇格する。

```ts
// app/routes/_auth/login.server.ts:39-60
if (userHasTwoFactor) {
  const verifySession = await verifySessionStorage.getSession()
  verifySession.set(unverifiedSessionIdKey, session.id)
  verifySession.set(rememberKey, remember)
  // ... redirect to 2FA verification
}
```

さらに `shouldRequestTwoFA()` は「最後に 2FA 検証してから 2 時間経過したか」をチェックし、重要な操作の前に再検証を要求する。

```ts
// app/routes/_auth/login.server.ts:155-157
const twoHours = 1000 * 60 * 2
return Date.now() - verifiedTime > twoHours
```

### 6. パスワードセキュリティ

bcrypt のハッシュ化に加え、HIBP (Have I Been Pwned) API による漏洩パスワードチェックを実装。k-anonymity モデルを使い、パスワードの SHA-1 ハッシュの先頭 5 文字のみを送信する。

```ts
// app/utils/auth.server.ts:260-267
export function getPasswordHashParts(password: string) {
  const hash = crypto
    .createHash('sha1')
    .update(password, 'utf8')
    .digest('hex')
    .toUpperCase()
  return [hash.slice(0, 5), hash.slice(5)] as const
}
```

Zod バリデーションでは bcrypt の 72 バイト制限を考慮した上限チェックも行っている。

```ts
// app/utils/user-validation.ts:17-23
export const PasswordSchema = z
  .string({ required_error: 'Password is required' })
  .min(6, { message: 'Password is too short' })
  .refine((val) => new TextEncoder().encode(val).length <= 72, {
    message: 'Password is too long',
  })
```

### 7. WebAuthn / パスキー

チャレンジ・レスポンス方式で実装。チャレンジは httpOnly cookie に保存され、認証完了後に即座に削除される。

```ts
// app/routes/_auth/webauthn/authentication.ts:32
const deletePasskeyCookie = await passkeyCookie.serialize('', { maxAge: 0 })
```

登録時には `requireUserVerification: true` を設定し、生体認証または PIN の入力を必須にしている。認証後はカウンターを更新してリプレイ攻撃を防止する。

```ts
// app/routes/_auth/webauthn/authentication.ts:72-75
await prisma.passkey.update({
  where: { id: passkey.id },
  data: { counter: BigInt(verification.authenticationInfo.newCounter) },
})
```

### 8. Cookie セキュリティ

全てのセッション Cookie に一貫したセキュリティ属性を設定している。

```ts
// app/utils/session.server.ts:5-11
cookie: {
  name: 'en_session',
  sameSite: 'lax', // CSRF protection is advised if changing to 'none'
  path: '/',
  httpOnly: true,
  secrets: process.env.SESSION_SECRET.split(','),
  secure: process.env.NODE_ENV === 'production',
},
```

`secrets` を配列で管理し、カンマ区切りでシークレットローテーションに対応している。`commitSession` をオーバーライドしてセッション内に `expires` を保持することで、Cookie の有効期限を再コミット時に維持する工夫がある。

### 9. リダイレクト安全性

全てのユーザー入力由来のリダイレクト先に `safeRedirect()` を適用し、オープンリダイレクト攻撃を防止。ログインフォームの応答では `hideFields: ['password']` でパスワードがレスポンスに含まれないようにしている。

```ts
// app/routes/_auth/login.tsx:70
{ result: submission.reply({ hideFields: ['password'] }) },
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 複数の認証方式（パスワード、OAuth、パスキー）を統一的に扱う
  - 適用条件: 認証方式が将来的に増減する可能性がある場合
  - コード例: `app/utils/auth.server.ts:20-27` で `remix-auth` の `Authenticator` にプロバイダーを動的に登録
  - 注意点: 各 Strategy のセキュリティ特性が異なるため、最も弱い方式が全体のセキュリティレベルを決定する

- **Chain of Responsibility パターン** (分類: 振る舞い)
  - 解決する問題: HTTP リクエストに対するセキュリティチェックの順序付き実行
  - 適用条件: 複数のセキュリティミドルウェアを段階的に適用する場合
  - コード例: `server/index.ts` の Express ミドルウェアチェーン（HTTPS 強制 → helmet → レート制限）
  - 注意点: ミドルウェアの順序が重要。レート制限は認証前に配置しないとブルートフォース攻撃を防げない

## Good Patterns

- **統一検証基盤**: メール検証・パスワードリセット・2FA を単一の `Verification` モデルと TOTP アルゴリズムで実装。コードの重複を排除し、全ての検証フローに同一レベルのセキュリティ保証を提供している。`app/routes/_auth/verify.server.ts:183-199` の `switch` 文で検証タイプに応じた処理に分岐する。

- **環境に応じたセキュリティ調整**: テスト環境ではレート制限の倍率を `10_000` にし、ハニーポットの時間検証を無効化。本番のセキュリティを損なわずに開発・テスト効率を確保している。
  ```ts
  // server/index.ts:92-93
  const maxMultiple =
    !IS_PROD || process.env.PLAYWRIGHT_TEST_BASE_URL ? 10_000 : 1
  ```

- **CDN/PaaS ヘッダーによる IP 識別**: `req.ip` ではなく `fly-client-ip` を優先することで、IP スプーフィング耐性を持つレート制限を実現。コメントで CDN 変更時の対応方法（`cf-connecting-ip` への差し替え等）も記載している。

- **OTP 文字セットの UX 最適化**: `0`, `O`, `I` を除外した文字セットにより、ユーザーが目視で入力する際の誤認を防止。セキュリティ（ブルートフォース耐性）と UX のバランスを取った判断。

## Anti-Patterns / 注意点

- **外部 API 依存のセキュリティチェックで fail-open**: HIBP API がダウンまたはタイムアウトした場合にパスワードを「安全」として扱う。セキュリティクリティカルな環境では fail-closed（拒否）にすべき場合がある。ただしサインアップの可用性とのトレードオフであり、判断自体は妥当。

  ```ts
  // Bad: 外部APIの障害でセキュリティチェックをスキップ
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      console.warn('Password check timed out')
      return false  // パスワードは安全と見なす
    }
  }

  // Better: ログを残しつつ、リスクレベルに応じて判断を変える
  } catch (error) {
    logger.warn('HIBP check failed', { error })
    if (isHighSecurityContext) {
      throw new Error('Password validation unavailable. Please try again.')
    }
    return false
  }
  ```

- **CSRF 保護の暗黙的前提**: `SameSite=Lax` に依存して CSRF トークンを削除しているが、この前提は「GET リクエストで状態変更しない」に依存している。コメントで注意を促しているが、新しい開発者が GET で mutation を追加してしまうリスクがある。

  ```ts
  // Bad: SameSite=Lax 前提なのに GET で mutation
  app.get('/api/delete-account', (req, res) => { /* ... */ })

  // Better: mutation は常に POST/PUT/DELETE で行い、
  // Cookie 設定コメントを必ず確認する
  // sameSite: 'lax', // CSRF protection is advised if changing to 'none'
  ```

## 導出ルール

- `[MUST]` セッション Cookie には `httpOnly`, `secure` (本番), `sameSite: 'lax'` を必ず設定する
  - 根拠: Epic Stack の全 Cookie 設定で一貫して適用されており、XSS によるセッション窃取と CSRF を防止する基本措置（`app/utils/session.server.ts:5-11`）

- `[MUST]` ユーザー入力由来のリダイレクト先には安全なリダイレクト検証を適用し、オープンリダイレクト攻撃を防止する
  - 根拠: `safeRedirect()` が全てのリダイレクト箇所で使用されている（`app/utils/auth.server.ts:224`, `app/routes/_auth/login.server.ts:68,136`）

- `[MUST]` レート制限はエンドポイントの機密度に応じて段階化する（認証エンドポイントに最も厳しい制限を適用する）
  - 根拠: `/login`, `/signup`, `/verify` に `strongestRateLimit`（10リクエスト/分）を適用し、一般エンドポイントの 100 分の 1 に絞っている（`server/index.ts:123-149`）

- `[SHOULD]` 検証フロー（メール確認・パスワードリセット・2FA）は統一されたワンタイムコード基盤で実装し、コード重複と検証ロジックの分散を防ぐ
  - 根拠: `Verification` モデルに `type` と `target` を持たせることで、4 種類の検証フローを 1 つの TOTP 基盤で処理している（`app/routes/_auth/verify.server.ts`）

- `[SHOULD]` パスワード設定・変更時に HIBP (Have I Been Pwned) API で漏洩チェックを行い、k-anonymity モデルでプライバシーを保護する
  - 根拠: サインアップ・パスワードリセット・パスワード変更の全箇所で `checkIsCommonPassword()` を呼び出している（`app/routes/_auth/onboarding/index.tsx:80`, `app/routes/_auth/reset-password.tsx:50` 等）

- `[SHOULD]` CSP nonce はリクエストごとに暗号学的に安全な方法で生成し、React Context 等の仕組みでアプリケーション全体に一貫して伝播させる
  - 根拠: `crypto.randomBytes(16).toString('hex')` で生成し、`NonceProvider` で全コンポーネントに nonce を供給（`app/entry.server.tsx:46-54`）

- `[SHOULD]` レート制限の IP 識別には CDN/PaaS が付与する信頼できるヘッダーを優先し、`X-Forwarded-For` や `req.ip` への直接依存を避ける
  - 根拠: コメントに「Malicious users can spoof their IP address」と明記し、`fly-client-ip` を優先している（`server/index.ts:100-107`）

- `[AVOID]` GET リクエストで状態変更を行うこと（`SameSite=Lax` Cookie に依存する CSRF 保護が無効化される）
  - 根拠: CSRF トークン削除の前提条件として「GET endpoints that perform mutations」が存在しないことが明記されている（ADR `035-remove-csrf.md`）

- `[AVOID]` フォームバリデーションのエラーレスポンスにパスワード等の機密フィールドを含めること
  - 根拠: `submission.reply({ hideFields: ['password'] })` で機密情報がレスポンスに含まれないようにしている（`app/routes/_auth/login.tsx:70`）

## 適用チェックリスト

- [ ] 全てのセッション Cookie に `httpOnly`, `sameSite: 'lax'`, `secure` (本番) を設定しているか
- [ ] 認証関連エンドポイントに一般エンドポイントより厳しいレート制限を適用しているか
- [ ] レート制限の IP 識別でインフラが付与する信頼できるヘッダーを使用しているか
- [ ] CSP を設定し、インラインスクリプトに nonce を付与しているか
- [ ] 公開フォームにハニーポットフィールドを設置しているか
- [ ] パスワードのハッシュ化に bcrypt/scrypt/argon2 等の適切なアルゴリズムを使用しているか
- [ ] パスワード設定時に漏洩パスワードチェック（HIBP 等）を行っているか
- [ ] ユーザー入力由来のリダイレクト先をバリデーションしているか
- [ ] フォームエラーレスポンスからパスワード等の機密フィールドを除外しているか
- [ ] 2FA/MFA の実装で、認証セッションと検証セッションを分離しているか
- [ ] GET リクエストで状態変更を行っていないか（CSRF 保護の前提条件）
- [ ] テスト環境でセキュリティ設定を緩和する場合、本番に影響しない仕組みになっているか
