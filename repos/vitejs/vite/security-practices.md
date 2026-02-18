# security-practices

> リポジトリ: vitejs/vite
> 分析日: 2026-02-17

## 概要

Vite の開発サーバーは「ローカルで動くから安全」という前提を明示的に否定し、DNS rebinding、Cross-site WebSocket hijacking、XSSI（Cross-Site Script Inclusion）、ファイルシステムトラバーサルなど、開発サーバー特有の攻撃ベクトルに対して多層防御を実装している。各防御層は独立したミドルウェアとして分離され、ミドルウェアの登録順序自体がセキュリティ設計の一部となっている。CORS のデフォルトを `true`（全許可）から localhost 限定の正規表現に変更し、WebSocket にトークン認証を導入するなど、Vite 6 以降でセキュリティファーストへ大きく舵を切った点が注目に値する。

## 背景にある原則

- **開発サーバーも攻撃対象である**: ローカル開発サーバーはブラウザの Same-Origin Policy の保護外にある場面が多い。DNS rebinding で任意ドメインから localhost へアクセスされ得るため、「localhost = 安全」という前提を置かない設計が必要。Vite はホスト検証・CORS 制限・WebSocket トークンの三重防御でこの原則を具現化している（`packages/vite/src/node/server/index.ts:886-900`）。

- **デフォルトを安全側に倒す（Secure by Default）**: CORS デフォルトは `{ origin: /^https?:\/\/(?:(?:[^:]+\.)?localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/ }` と localhost 系のみ許可。`server.allowedHosts` のデフォルトは空配列（localhost とIPアドレスのみ自動許可）。ユーザーが明示的にセキュリティを緩和しない限り、攻撃面を最小化する（`packages/vite/src/node/constants.ts:217-218`）。

- **防御層は独立させ、ミドルウェアの合成順序で多層防御を構成する**: リクエスト検証 → CORS 拒否 → CORS ヘッダー付与 → ホスト検証の順にミドルウェアを登録し、各層が独立して攻撃を遮断できる。一つの層を突破されても次の層で止まる（`packages/vite/src/node/server/index.ts:879-900`）。

- **機密情報のデフォルト拒否リスト（Deny List）を提供する**: `server.fs.deny` のデフォルトで `.env`、`.env.*`、`*.{crt,pem}`、`**/.git/**` をブロックし、開発サーバー経由での機密ファイル漏洩を防止する。allow より deny の優先度が高い設計（`packages/vite/src/node/server/index.ts:1133`）。

## 実例と分析

### 1. DNS rebinding 防御: host-validation-middleware による Host ヘッダー検証

DNS rebinding 攻撃では、攻撃者が所有するドメインの DNS レコードを localhost の IP に向けることで、ブラウザの Same-Origin Policy を迂回して開発サーバーにアクセスする。Vite は `host-validation-middleware` パッケージを利用し、HTTP リクエストの `Host` ヘッダーを許可リストと照合する。

重要な設計判断として、**HTTPS 使用時はホスト検証をスキップする**。TLS 証明書の検証が DNS rebinding を防止するためである。

```typescript
// packages/vite/src/node/server/index.ts:895-900
// host check (to prevent DNS rebinding attacks)
const { allowedHosts } = serverConfig;
// no need to check for HTTPS as HTTPS is not vulnerable to DNS rebinding attacks
if (allowedHosts !== true && !serverConfig.https) {
  middlewares.use(hostValidationMiddleware(allowedHosts, false));
}
```

許可ホストリストは複数のソースから自動的に構成される。`server.host`、`hmr.host`、`preview.host`、`server.origin` の各設定値と環境変数 `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` がマージされる。

```typescript
// packages/vite/src/node/server/middlewares/hostCheck.ts:5-44
export function getAdditionalAllowedHosts(
  resolvedServerOptions: Pick<ResolvedServerOptions, "host" | "hmr" | "origin">,
  resolvedPreviewOptions: Pick<ResolvedPreviewOptions, "host">,
): string[] {
  const list = [];
  if (typeof resolvedServerOptions.host === "string" && resolvedServerOptions.host) {
    list.push(resolvedServerOptions.host);
  }
  // ... hmr.host, preview.host, server.origin も同様に収集
  return list;
}
```

### 2. Cross-site WebSocket Hijacking 防御: トークン認証 + タイミング安全比較

WebSocket は Same-Origin Policy の保護を受けないため、Cross-site WebSocket hijacking が成立し得る。Vite はプロセス起動ごとにランダムトークンを生成し、WebSocket 接続時に検証する。

```typescript
// packages/vite/src/node/config.ts:1968-1973
// random 72 bits (12 base64 chars)
// at least 64bits is recommended
// https://owasp.org/www-community/vulnerabilities/Insufficient_Session-ID_Length
webSocketToken: Buffer.from(
  crypto.getRandomValues(new Uint8Array(9)),
).toString('base64url'),
```

トークン検証には `crypto.timingSafeEqual` を使用し、タイミング攻撃を防止している。

```typescript
// packages/vite/src/node/server/ws.ts:104-116
function hasValidToken(config: ResolvedConfig, url: URL) {
  const token = url.searchParams.get("token");
  if (!token) return false;
  try {
    const isValidToken = crypto.timingSafeEqual(
      Buffer.from(token),
      Buffer.from(config.webSocketToken),
    );
    return isValidToken;
  } catch {} // an error is thrown when the length is incorrect
  return false;
}
```

`shouldHandle` 関数の設計も重要で、ブラウザからの接続（`Origin` ヘッダーあり）のみトークンを要求し、非ブラウザのツール連携は後方互換のため許可する。`vite-ping` プロトコルはデータの送受信を行わないため、トークンなしで接続を許可するが、`wss.clients` には含めずに即座にクローズする。

```typescript
// packages/vite/src/node/server/ws.ts:169-198
const shouldHandle = (req: IncomingMessage) => {
  const protocol = req.headers["sec-websocket-protocol"]!;
  if (protocol === "vite-ping") return true;

  if (allowedHosts !== true && !isHostAllowed(req.headers.host, allowedHosts)) {
    return false;
  }
  if (config.legacy?.skipWebSocketTokenCheck) {
    return true;
  }
  if (req.headers.origin) {
    const parsedUrl = new URL(`http://example.com${req.url!}`);
    return hasValidToken(config, parsedUrl);
  }
  return true;
};
```

### 3. XSSI 防御: Sec-Fetch メタデータによる no-cors スクリプト拒否

webpack-dev-server の脆弱性（GHSA-4v9v-hfq4-rm2v）を参照し、cross-origin の no-cors スクリプトリクエストを拒否する。HMR パッチファイルが ESM 構文を含まない場合、classic script として読み込まれ得るため、この防御が必要。

```typescript
// packages/vite/src/node/server/middlewares/rejectNoCorsRequest.ts:17-36
export function rejectNoCorsRequestMiddleware(): Connect.NextHandleFunction {
  return function viteRejectNoCorsRequestMiddleware(req, res, next) {
    if (
      req.headers["sec-fetch-mode"] === "no-cors"
      && req.headers["sec-fetch-site"] !== "same-origin"
      && req.headers["sec-fetch-dest"] === "script"
    ) {
      res.statusCode = 403;
      res.end("Cross-origin requests for classic scripts must be made with CORS mode enabled.");
      return;
    }
    return next();
  };
}
```

### 4. 不正リクエスト遮断: HTTP 仕様準拠の入力バリデーション

Node.js は HTTP 仕様に違反する `#` を含む URL を受け入れるが、下流のミドルウェア（特に `server.fs.deny` チェック）はこれを想定していない。仕様に従い早期に 400 で拒否する。

```typescript
// packages/vite/src/node/server/middlewares/rejectInvalidRequest.ts:6-23
export function rejectInvalidRequestMiddleware(): Connect.NextHandleFunction {
  return function viteRejectInvalidRequestMiddleware(req, res, next) {
    if (req.url?.includes("#")) {
      res.writeHead(400);
      res.end();
      return;
    }
    return next();
  };
}
```

### 5. ファイルシステムアクセス制御: allow/deny の優先度設計

`server.fs.strict` モードでは、ワークスペースルート外のファイルへのアクセスを拒否する。deny リストは allow リストより優先度が高い。ファイルが存在しない場合は「fallback」として次のミドルウェアに委譲し、API エンドポイントへのリクエストを妨げない。

```typescript
// packages/vite/src/node/server/middlewares/static.ts:292-327
export function isFileLoadingAllowed(config: ResolvedConfig, filePath: string): boolean {
  const { fs } = config.server;
  if (!fs.strict) return true;
  const filePathWithoutTrailingSlash = filePath.endsWith("/") ? filePath.slice(0, -1) : filePath;
  if (config.fsDenyGlob(filePathWithoutTrailingSlash)) return false;
  if (config.safeModulePaths.has(filePath)) return true;
  if (fs.allow.some((uri) => isFileInTargetPath(uri, filePath))) return true;
  return false;
}

export function checkLoadingAccess(config: ResolvedConfig, path: string): "allowed" | "denied" | "fallback" {
  if (isFileLoadingAllowed(config, slash(path))) return "allowed";
  if (isFileReadable(path)) return "denied";
  return "fallback";
}
```

### 6. エラー応答での XSS 防止

エラーメッセージの HTML レスポンスでは `escapeHtml` を使用し、JSON 埋め込み時には `<` を `\u003c` にエスケープして Script injection を防止する。

```typescript
// packages/vite/src/node/server/middlewares/error.ts:82-84
const error = ${JSON.stringify(prepareError(err)).replace(/</g, '\\u003c')}
```

```typescript
// packages/vite/src/node/server/middlewares/static.ts:354
return html`<p>${escapeHtml(msg).replace(/\n/g, "<br/>")}</p>`;
```

## パターンカタログ

- **Chain of Responsibility** (分類: 振る舞い)
  - 解決する問題: 複数のセキュリティ検証を疎結合に合成し、各検証の追加・削除を独立して行えるようにする
  - 適用条件: リクエストが複数の独立した検証を通過する必要がある場合
  - コード例: `packages/vite/src/node/server/index.ts:886-900`（rejectInvalid → rejectNoCors → cors → hostValidation の順に登録）
  - 注意点: 登録順序がセキュリティに直結する。バリデーション（reject）系は CORS ヘッダー付与より前に配置しないと、拒否すべきリクエストに CORS ヘッダーが付与される

- **Strategy** (分類: 振る舞い)
  - 解決する問題: WebSocket 接続の認証ポリシーを接続元（ブラウザ / ツール）に応じて切り替える
  - 適用条件: 同一エンドポイントに対して異なる認証レベルを適用する必要がある場合
  - コード例: `packages/vite/src/node/server/ws.ts:169-198`（Origin ヘッダーの有無でトークン検証の要否を分岐）

## Good Patterns

- **デフォルト CORS を localhost 限定の正規表現にする**: `true`（全許可）ではなく、`/^https?:\/\/(?:(?:[^:]+\.)?localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/` を使用。開発の利便性（ポート番号自由）を維持しつつ、外部オリジンからのアクセスを遮断する。

```typescript
// packages/vite/src/node/constants.ts:217-218
export const defaultAllowedOrigins: RegExp = /^https?:\/\/(?:(?:[^:]+\.)?localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;
```

- **トークン比較に timingSafeEqual を使用する**: 文字列の `===` 比較はタイミング攻撃に脆弱。`crypto.timingSafeEqual` を使い、比較時間からトークンの文字を推測されることを防ぐ。長さ不一致時の例外は空 catch で処理し、false を返す。

```typescript
// packages/vite/src/node/server/ws.ts:109-114
const isValidToken = crypto.timingSafeEqual(
  Buffer.from(token),
  Buffer.from(config.webSocketToken),
);
```

- **許可ホストの配列を Object.freeze で凍結しキャッシュを有効化する**: ミドルウェアが毎リクエストで呼ばれるため、allowedHosts 配列の参照同一性を保証してキャッシュ効率を上げる。

```typescript
// packages/vite/src/node/server/middlewares/hostCheck.ts:50-52
return originalHostValidationMiddleware({
  allowedHosts: Object.freeze([...allowedHosts]),
```

- **ミドルウェア関数に名前を付けてデバッグ性を確保する**: 無名関数ではなく `function viteRejectNoCorsRequestMiddleware` のように名前を付け、`DEBUG=connect:dispatcher` でのデバッグログに関数名を表示させる。

```typescript
// packages/vite/src/node/server/middlewares/rejectNoCorsRequest.ts:19
return function viteRejectNoCorsRequestMiddleware(req, res, next) {
```

## Anti-Patterns / 注意点

- **CORS を `true` に設定して全オリジンを許可する**: Vite のドキュメントで明確に警告されている。任意のウェブサイトからソースコードをダウンロードされる危険がある。

```typescript
// Bad: 全オリジン許可
export default defineConfig({
  server: { cors: true },
});

// Better: 必要なオリジンのみ許可
export default defineConfig({
  server: {
    cors: {
      origin: ["http://localhost:3000", "http://localhost:5173"],
    },
  },
});
```

- **allowedHosts を `true` に設定して全ホストを許可する**: DNS rebinding 攻撃への防御が無効化される。特に `.com` などの TLD を追加するのも危険。

```typescript
// Bad: DNS rebinding 防御の無効化
export default defineConfig({
  server: { allowedHosts: true },
});

// Better: 所有するドメインのみ許可
export default defineConfig({
  server: { allowedHosts: [".myapp.example.com"] },
});
```

- **セキュリティチェック前に CORS ヘッダーを付与する**: ミドルウェアの順序を誤ると、拒否すべきリクエストに `Access-Control-Allow-Origin` が付与される。Vite は rejectInvalid → rejectNoCors → cors → hostValidation の順で設計上この問題を回避している。

```typescript
// Bad: CORSヘッダー付与後にバリデーション
app.use(corsMiddleware());
app.use(rejectInvalidRequestMiddleware());

// Better: バリデーション後にCORSヘッダー付与（Vite の実装）
app.use(rejectInvalidRequestMiddleware());
app.use(rejectNoCorsRequestMiddleware());
app.use(corsMiddleware());
```

## 導出ルール

- `[MUST]` 開発サーバーの CORS デフォルトは localhost 系オリジンのみ許可する正規表現にする（全許可にしない）
  - 根拠: Vite は `defaultAllowedOrigins` で localhost/127.0.0.1/[::1] のみ許可し、ソースコード漏洩を防止している（`constants.ts:217-218`）

- `[MUST]` セキュリティトークンの比較には `crypto.timingSafeEqual` を使用する（`===` で比較しない）
  - 根拠: Vite の WebSocket トークン検証でタイミング攻撃を防止するために使用されている（`ws.ts:109`）

- `[MUST]` セキュリティ系ミドルウェアの登録順序は「入力バリデーション → アクセス制御 → レスポンスヘッダー付与」の順にする
  - 根拠: Vite は rejectInvalid → rejectNoCors → cors → hostValidation の順で登録し、拒否すべきリクエストに CORS ヘッダーが付与されることを防いでいる（`server/index.ts:886-900`）

- `[SHOULD]` 開発サーバーでもファイルアクセスの deny リストをデフォルトで設定する（`.env`、秘密鍵、`.git` 等）
  - 根拠: Vite の `server.fs.deny` デフォルトは `['.env', '.env.*', '*.{crt,pem}', '**/.git/**']` で、deny は allow より優先される（`server/index.ts:1133`）

- `[SHOULD]` WebSocket 接続には Origin ヘッダーに基づくトークン認証を導入し、cross-site hijacking を防止する
  - 根拠: Vite はプロセス起動ごとにランダムトークンを生成し、OWASP 推奨の 64 ビット以上（72 ビット）のエントロピーを確保している（`config.ts:1968-1973`）

- `[SHOULD]` HTTPS 使用時は DNS rebinding のホスト検証をスキップする（TLS 証明書検証が代替防御となるため）
  - 根拠: Vite は `!serverConfig.https` の条件でホスト検証を適用し、HTTPS 時の不要な検証オーバーヘッドを排除している（`server/index.ts:898`）

- `[SHOULD]` ランタイムで HTTP 仕様に違反するリクエストを早期に拒否し、下流のミドルウェアが想定外の入力を処理しないようにする
  - 根拠: Node.js は RFC 9112 に違反する `#` 入り URL を受け入れるが、`server.fs.deny` チェックが迂回される可能性があるため、Vite は最初のミドルウェアで 400 を返す（`rejectInvalidRequest.ts:9-13`）

- `[AVOID]` `server.allowedHosts: true` や `server.cors: true` のような全許可オプションをドキュメントの warning なしに提供する
  - 根拠: Vite のドキュメントは両オプションに `::: danger` ブロックで明確な警告を記載し、GHSA アドバイザリへのリンクを添えている

## 適用チェックリスト

- [ ] 開発サーバーの CORS デフォルトが `true`（全許可）になっていないか確認する
- [ ] 開発サーバーで Host ヘッダーの検証（DNS rebinding 防御）を実装しているか確認する
- [ ] WebSocket エンドポイントにトークン認証または Origin 検証を実装しているか確認する
- [ ] トークン・パスワードの比較に `timingSafeEqual` を使用しているか確認する
- [ ] セキュリティ系ミドルウェアの登録順序が「バリデーション → アクセス制御 → ヘッダー付与」になっているか確認する
- [ ] `.env`、秘密鍵、`.git` などの機密ファイルが開発サーバーから配信されないようブロックリストを設定しているか確認する
- [ ] HTTP 仕様に違反するリクエスト（`#` 入り URL 等）をランタイムレベルで早期に拒否しているか確認する
- [ ] エラーレスポンスの HTML にユーザー入力を埋め込む際に適切なエスケープ（`escapeHtml`、`<` → `\u003c`）を行っているか確認する
- [ ] セキュリティを緩和するオプション（全許可設定等）にはドキュメントで明確な警告を記載しているか確認する
