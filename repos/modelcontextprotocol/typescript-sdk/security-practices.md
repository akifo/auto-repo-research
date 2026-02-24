# security-practices

> リポジトリ: modelcontextprotocol/typescript-sdk
> 分析日: 2026-02-24

## 概要

MCP TypeScript SDK の OAuth 2.0 / 2.1 実装におけるセキュリティプラクティスを分析する。このリポジトリは RFC 6749, 7591, 8414, 8707, 9728 など多数の OAuth 関連 RFC を忠実に実装しており、PKCE 必須化、URL スキーム検証、DNS リバインディング保護、段階的な資格情報無効化といった防御的なセキュリティパターンが体系的に組み込まれている。SDK レベルでセキュリティを構造的に強制する設計は、プロトコルライブラリに限らず広く応用できるプラクティスの宝庫である。

## 背景にある原則

- **入力は信頼しない -- スキーマで構造的に排除する**: URL フィールドに対して `SafeUrlSchema` で `javascript:`, `data:`, `vbscript:` スキームを拒否し、OAuth メタデータの全 URL フィールドに一律適用している。個別のバリデーションチェックではなくスキーマ定義時点で危険な入力を構造的に不可能にすることで、検証漏れのクラスそのものを排除する（`packages/core/src/shared/auth.ts:6-25`）。

- **セキュリティのデフォルトは「安全な側」に倒す**: PKCE は S256 のみをサポートし、`plain` は許可しない。localhost バインド時は DNS リバインディング保護を自動有効化する。`0.0.0.0` バインド時は警告を出す。安全でない選択肢を「使えるが非推奨」ではなく「使えない」にする設計思想が一貫している。

- **エラーからの自動回復は「限定的かつ分類ベース」で行う**: `auth()` 関数は `InvalidClient`/`UnauthorizedClient` で全資格情報を無効化、`InvalidGrant` でトークンのみを無効化する。回復戦略をエラーコードに紐付け、回復不能なエラーは即座に再送出する。これにより、無限リトライや不適切な回復を防ぎつつ、ユーザー介入なしで解決可能な問題は自動修復する（`packages/client/src/client/auth.ts:403-419`）。

- **RFC 準拠を型レベルで強制する**: Zod スキーマで RFC のフィールド定義を忠実にモデル化し、`.strip()` で未知フィールドを除去する。`z.looseObject` と `z.object().strip()` の使い分けにより、メタデータは拡張を許容しつつ、クライアント情報やトークンは厳密に制約する。

## 実例と分析

### URL インジェクション防御の構造化

`SafeUrlSchema` は URL バリデーションを再利用可能なスキーマとして定義し、OAuth メタデータ、クライアントメタデータ、OpenID Provider メタデータの全 URL フィールドに一律適用している。

```typescript
// packages/core/src/shared/auth.ts:6-25
export const SafeUrlSchema = z
    .url()
    .superRefine((val, ctx) => {
        if (!URL.canParse(val)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'URL must be parseable',
                fatal: true
            });
            return z.NEVER;
        }
    })
    .refine(
        url => {
            const u = new URL(url);
            return u.protocol !== 'javascript:' && u.protocol !== 'data:' && u.protocol !== 'vbscript:';
        },
        { message: 'URL cannot use javascript:, data:, or vbscript: scheme' }
    );
```

このスキーマは `OAuthMetadataSchema` の `authorization_endpoint`, `token_endpoint`, `registration_endpoint` など全エンドポイント URL に適用されている（`auth.ts:52-53`）。テストでも `javascript:alert(1)` が明示的に検証される（`packages/core/test/shared/auth.test.ts:19-22`）。

### PKCE の必須化と S256 限定

認可フロー開始時に PKCE チャレンジを無条件に生成し、S256 のみを使用する。サーバーが `code_challenge_methods_supported` を公開していない場合は S256 対応と見なす（Issue #832 の対策）が、`plain` のみの場合はエラーとして拒否する。

```typescript
// packages/client/src/client/auth.ts:1142-1150
const challenge = await pkceChallenge();
const codeVerifier = challenge.code_verifier;
const codeChallenge = challenge.code_challenge;

authorizationUrl.searchParams.set('response_type', AUTHORIZATION_CODE_RESPONSE_TYPE);
authorizationUrl.searchParams.set('client_id', clientInformation.client_id);
authorizationUrl.searchParams.set('code_challenge', codeChallenge);
authorizationUrl.searchParams.set('code_challenge_method', AUTHORIZATION_CODE_CHALLENGE_METHOD);
```

`AUTHORIZATION_CODE_CHALLENGE_METHOD` は `'S256'` に固定されており（`auth.ts:243`）、設定で変更できない。

### DNS リバインディング保護の多層実装

DNS リバインディング保護は 3 つのレイヤーで提供される:

1. **コア関数**: `validateHostHeader()` は Host ヘッダーをパースし、許可リストと照合する（`packages/server/src/server/middleware/hostHeaderValidation.ts:17-35`）
2. **フレームワーク別ミドルウェア**: Express（`packages/middleware/express/src/middleware/hostHeaderValidation.ts`）と Hono（`packages/middleware/hono/src/middleware/hostHeaderValidation.ts`）用のラッパー
3. **ファクトリ関数**: `createMcpExpressApp()` は localhost バインド時に自動でミドルウェアを適用する

```typescript
// packages/middleware/express/src/express.ts:60-76
if (allowedHosts) {
    app.use(hostHeaderValidation(allowedHosts));
} else {
    const localhostHosts = ['127.0.0.1', 'localhost', '::1'];
    if (localhostHosts.includes(host)) {
        app.use(localhostHostValidation());
    } else if (host === '0.0.0.0' || host === '::') {
        console.warn(
            `Warning: Server is binding to ${host} without DNS rebinding protection. ...`
        );
    }
}
```

ホスト名検証は URL API でパースしてポートを無視するため、`localhost:3000` と `localhost:8080` を同一視できる。IPv6 アドレス `[::1]` も正しく処理される。

### エラーコードに基づく段階的な資格情報無効化

`auth()` 関数はエラーの種類に応じて無効化スコープを変える:

```typescript
// packages/client/src/client/auth.ts:403-419
try {
    return await authInternal(provider, options);
} catch (error) {
    if (error instanceof OAuthError) {
        if (error.code === OAuthErrorCode.InvalidClient || error.code === OAuthErrorCode.UnauthorizedClient) {
            await provider.invalidateCredentials?.('all');
            return await authInternal(provider, options);
        } else if (error.code === OAuthErrorCode.InvalidGrant) {
            await provider.invalidateCredentials?.('tokens');
            return await authInternal(provider, options);
        }
    }
    throw error;
}
```

`invalidateCredentials` のスコープは `'all' | 'client' | 'tokens' | 'verifier' | 'discovery'` の 5 段階に分かれており、クライアント登録情報の再取得が必要な場合は `'all'`、トークンのリフレッシュだけで済む場合は `'tokens'` と、最小限の影響範囲で回復を試みる。

### クライアント認証方式の自動選択

`selectClientAuthMethod()` はサーバーの対応メソッドに基づいて最もセキュアな方式を自動選択する:

```typescript
// packages/client/src/client/auth.ts:257-290
export function selectClientAuthMethod(clientInformation: OAuthClientInformationMixed, supportedMethods: string[]): ClientAuthMethod {
    const hasClientSecret = clientInformation.client_secret !== undefined;
    if (supportedMethods.length === 0) {
        return hasClientSecret ? 'client_secret_post' : 'none';
    }
    // Prefer method from registration if valid
    if ('token_endpoint_auth_method' in clientInformation && ...) {
        return clientInformation.token_endpoint_auth_method;
    }
    // Try methods in priority order (most secure first)
    if (hasClientSecret && supportedMethods.includes('client_secret_basic')) {
        return 'client_secret_basic';
    }
    if (hasClientSecret && supportedMethods.includes('client_secret_post')) {
        return 'client_secret_post';
    }
    // ...
}
```

優先順位は `client_secret_basic` > `client_secret_post` > `none` で、Basic 認証（ヘッダー送信）を POST ボディ送信より優先する。

### リソース URL の検証と RFC 8707 準拠

`checkResourceAllowed()` はリソース URL のオリジン一致とパスプレフィックス一致を検証し、パスの部分一致による偽装（`/mcpxxxx` が `/mcp` にマッチする問題）を末尾スラッシュ付加で防止する:

```typescript
// packages/core/src/shared/authUtils.ts:53-56
const requestedPath = requested.pathname.endsWith('/') ? requested.pathname : requested.pathname + '/';
const configuredPath = configured.pathname.endsWith('/') ? configured.pathname : configured.pathname + '/';
return requestedPath.startsWith(configuredPath);
```

### Zod スキーマによるレスポンスの厳格化

`.strip()` を使って未知フィールドを除去し、サーバーが返す余分なデータが内部に伝播しないようにしている。一方、メタデータスキーマには `z.looseObject()` を使い、サーバー側の拡張フィールドを許容する:

```typescript
// packages/core/src/shared/auth.ts:131-140 (.strip() で厳格化)
export const OAuthTokensSchema = z
    .object({
        access_token: z.string(),
        token_type: z.string(),
        expires_in: z.coerce.number().optional(),
        // ...
    })
    .strip();

// packages/core/src/shared/auth.ts:50 (looseObject で拡張許容)
export const OAuthMetadataSchema = z.looseObject({ ... });
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: クライアント認証方式（Basic / POST / none / private_key_jwt）の切り替え
  - 適用条件: 実行時にサーバーの対応メソッドに応じて方式を選択する必要がある場合
  - コード例: `packages/client/src/client/auth.ts:257-290` (`selectClientAuthMethod`)、`auth.ts:306-331` (`applyClientAuthentication`)
  - 注意点: `addClientAuthentication` による完全カスタマイズも可能で、Strategy の差し替えポイントが明確

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: OAuth フロー全体の制御構造を固定しつつ、個別ステップをプロバイダーに委譲する
  - 適用条件: `OAuthClientProvider` インターフェースの各メソッドがフローの各ステップを担当
  - コード例: `packages/client/src/client/auth.ts:393-603` (`auth` / `authInternal`)
  - 注意点: `prepareTokenRequest()` でグラントタイプごとのカスタマイズを可能にしつつ、デフォルト動作も提供

## Good Patterns

- **SafeUrlSchema による構造的な URL 検証**: 個別チェックではなくスキーマ定義に防御を組み込むことで、新しいフィールド追加時にも検証が自動適用される。`SafeUrlSchema` を使い回す一貫性が高い。

```typescript
// packages/core/src/shared/auth.ts:52-53
authorization_endpoint: SafeUrlSchema,
token_endpoint: SafeUrlSchema,
```

- **段階的な資格情報無効化**: エラーコードを分類し、影響範囲を最小化しつつ自動回復を試みるパターン。全部捨てる/何もしない の二択ではなく、5 段階のスコープで粒度を制御する。

- **CORS エラーの型判別によるリトライ**: `TypeError` を CORS エラーとみなしてヘッダーなしでリトライする。ブラウザ環境での well-known メタデータ取得で実用的。

```typescript
// packages/client/src/client/auth.ts:766-777
async function fetchWithCorsRetry(url: URL, headers?: Record<string, string>, fetchFn: FetchLike = fetch): Promise<Response | undefined> {
    try {
        return await fetchFn(url, { headers });
    } catch (error) {
        if (error instanceof TypeError) {
            return headers ? fetchWithCorsRetry(url, undefined, fetchFn) : undefined;
        }
        throw error;
    }
}
```

- **セキュリティのデフォルト自動適用**: `createMcpExpressApp()` が localhost バインド時に自動で DNS リバインディング保護を有効化し、明示的なオプトインを不要にする。

## Anti-Patterns / 注意点

- **HTTP 200 でエラーを返すサーバーへの防御的パース**: GitHub のように `200 OK` でエラーレスポンスを返すサーバーが存在するため、トークンレスポンスのパース失敗時に `error` フィールドの存在を二次チェックしている。OAuth 準拠サーバーのみを想定するとこの問題を見逃す。

```typescript
// packages/client/src/client/auth.ts:1252-1261 (Better)
try {
    return OAuthTokensSchema.parse(json);
} catch (parseError) {
    if (typeof json === 'object' && json !== null && 'error' in json) {
        throw await parseErrorResponse(JSON.stringify(json));
    }
    throw parseError;
}
```

- **デモコード内の `origin: '*'` CORS 設定**: `examples/shared/src/authServer.ts:109` で全オリジンを許可している。デモ目的であっても、コピー&ペーストされるリスクがあるため、コメントで「DEMO ONLY」と明記し、関数名にもデモであることを示している。実運用コードでは許可オリジンを明示すること。

## 導出ルール

- `[MUST]` OAuth メタデータやリダイレクト URI など外部由来の URL には、スキーマレベルで `javascript:`, `data:`, `vbscript:` スキームを拒否するバリデーションを適用する
  - 根拠: `SafeUrlSchema` が全 URL フィールドに一律適用され、XSS ベクターを構造的に排除している（`packages/core/src/shared/auth.ts:6-25`）

- `[MUST]` OAuth 認可コードフローでは PKCE (S256) を無条件に使用し、`plain` メソッドはサポートしない
  - 根拠: `AUTHORIZATION_CODE_CHALLENGE_METHOD` が `'S256'` に固定され、設定で変更不可（`packages/client/src/client/auth.ts:243`）

- `[MUST]` セッション ID は暗号的に安全な方法で生成する（例: `crypto.randomUUID()`）
  - 根拠: `sessionIdGenerator` のドキュメントに「SHOULD be globally unique and cryptographically secure」と明記（`packages/server/src/server/streamableHttp.ts:77`）

- `[SHOULD]` 認証エラーからの自動回復では、エラーコードに応じて無効化スコープを分け、最小限の資格情報のみを無効化して再試行する
  - 根拠: `InvalidClient` で `'all'`、`InvalidGrant` で `'tokens'` のみを無効化する段階的回復戦略（`packages/client/src/client/auth.ts:403-419`）

- `[SHOULD]` localhost にバインドする HTTP サーバーには DNS リバインディング保護（Host ヘッダー検証）をデフォルトで有効化する
  - 根拠: `createMcpExpressApp()` が localhost バインド時に自動で `localhostHostValidation()` を適用（`packages/middleware/express/src/express.ts:64-65`）

- `[SHOULD]` 外部 API レスポンスは Zod スキーマの `.strip()` で未知フィールドを除去し、信頼境界を超えたデータの伝播を防ぐ
  - 根拠: `OAuthTokensSchema`, `OAuthClientMetadataSchema` 等が `.strip()` を使用（`packages/core/src/shared/auth.ts:140, 179, 191`）

- `[SHOULD]` クライアント認証方式は、サーバーが対応する方式の中から最もセキュアなものを自動選択し、フォールバックも明示的に定義する
  - 根拠: `selectClientAuthMethod()` が `client_secret_basic` > `client_secret_post` > `none` の優先順で選択（`packages/client/src/client/auth.ts:257-290`）

- `[AVOID]` URL のパスプレフィックスマッチで末尾スラッシュを正規化せずに比較すること（`/api` が `/api123` にマッチする偽陽性が発生する）
  - 根拠: `checkResourceAllowed()` が末尾スラッシュを付加してからプレフィックス比較する対策を実装（`packages/core/src/shared/authUtils.ts:53-56`）

## 適用チェックリスト

- [ ] 外部由来の URL を受け取る箇所で、危険なスキーム（`javascript:`, `data:`, `vbscript:`）を拒否するバリデーションが入っているか
- [ ] OAuth 認可コードフローで PKCE (S256) を必須にしているか（`plain` を許可していないか）
- [ ] セッション ID の生成に `crypto.randomUUID()` や同等の暗号的に安全な方法を使っているか
- [ ] localhost バインドの HTTP サーバーに DNS リバインディング保護（Host ヘッダー検証）が適用されているか
- [ ] OAuth エラー発生時の回復戦略がエラーコード別に定義され、無効化スコープが最小限になっているか
- [ ] 外部 API レスポンスのパース時に未知フィールドを除去して信頼境界を維持しているか
- [ ] URL のパスプレフィックスマッチで末尾スラッシュの正規化を行い、偽陽性を防いでいるか
- [ ] デモ・サンプルコード内のセキュリティ設定（CORS `origin: '*'` 等）が本番コードに混入しないよう明確にマークされているか
