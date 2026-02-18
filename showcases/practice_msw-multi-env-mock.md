# Practice: MSW Multi-Env Mock

> 出典: [repos/epicweb-dev/epic-stack](../repos/epicweb-dev/epic-stack/) からの知見
> カテゴリ: practice

## 概要

MSW (Mock Service Worker) のハンドラを `tests/mocks/` に集約し、開発・Vitest 単体テスト・Playwright E2E テストの三環境で同一のモック定義を共用するプラクティス。環境変数によるモック/リアル切り替え、デフォルト正常系 + テスト内異常系上書き、Vite プラグインによるモジュール差し替えを組み合わせることで、モック定義の乖離を防ぎつつ、各環境に最適な振る舞いを実現する。

## 背景・文脈

Epic Stack (epicweb-dev/epic-stack) は Kent C. Dodds の Testing Trophy 哲学を体現した Remix/React Router ベースのフルスタックアプリケーションテンプレートである。GitHub OAuth、Resend メール送信、Tigris オブジェクトストレージ、Have I Been Pwned API の 4 つの外部 API に依存しており、これらを開発時・テスト時ともにモックする必要がある。

従来の「テスト環境ごとにモックを個別定義する」アプローチでは、開発時モックとテスト時モックの振る舞いが乖離し、「開発では動くがテストでは壊れる」問題が頻発する。Epic Stack は MSW ハンドラを単一ディレクトリに集約し、環境変数で起動制御することでこの問題を解決している。

## 実装パターン

### 1. ハンドラの集約と MSW サーバー構成

全モックハンドラを `tests/mocks/index.ts` に集約し、`setupServer()` で一括登録する。

```typescript
// tests/mocks/index.ts:1-39
import closeWithGrace from "close-with-grace";
import { setupServer } from "msw/node";
import { handlers as githubHandlers } from "./github.ts";
import { handlers as pwnedPasswordApiHandlers } from "./pwned-passwords.ts";
import { handlers as resendHandlers } from "./resend.ts";
import { handlers as tigrisHandlers } from "./tigris.ts";

export const server = setupServer(
  ...resendHandlers,
  ...githubHandlers,
  ...tigrisHandlers,
  ...pwnedPasswordApiHandlers,
);

server.listen({
  onUnhandledRequest(request, print) {
    if (request.url.includes(".sentry.io")) return;
    if (request.url.includes("__rrdt")) return;
    print.warning();
  },
});

if (process.env.NODE_ENV !== "test") {
  console.info("Mock server installed");
  closeWithGrace(() => {
    server.close();
  });
}
```

### 2. 環境変数による三環境での起動制御

アプリケーションのエントリポイントで `MOCKS=true` のときだけモックサーバーを動的 import する。

```typescript
// index.ts:19-21
if (process.env.MOCKS === "true") {
  await import("./tests/mocks/index.ts");
}
```

```json
// package.json (抜粋)
"dev": "cross-env NODE_ENV=development MOCKS=true node index.ts",
"start:mocks": "cross-env NODE_ENV=production MOCKS=true node index.ts"
```

Vitest からは `setupFiles` 経由で同じモックサーバーを参照する。

```typescript
// vite.config.ts:74-77
test: {
	setupFiles: ['./tests/setup/setup-test-env.ts'],
}
```

E2E テストでは Playwright の `webServer` で `start:mocks` コマンドを使い、MSW が組み込まれたサーバーを起動する。

### 3. 環境変数プレフィックスによる Mock/Real 切り替え

`MOCK_` プレフィックスで始まる環境変数値を検出し、モックと実 API を自動切り替えする。

```typescript
// tests/mocks/github.ts:131-139
const passthroughGitHub = !process.env.GITHUB_CLIENT_ID?.startsWith("MOCK_")
  && process.env.NODE_ENV !== "test";

export const handlers: Array<HttpHandler> = [
  http.post(
    "https://github.com/login/oauth/access_token",
    async ({ request }) => {
      if (passthroughGitHub) return passthrough();
      // ... mock implementation
    },
  ),
];
```

`.env.example` でデフォルト値に `MOCK_` プレフィックスを付与し、初期セットアップ時に自動的にモックモードで動作させる。

```
# .env.example:13-17
# the mocks and some code rely on these two being prefixed with "MOCK_"
# if they aren't then the real github api will be attempted
GITHUB_CLIENT_ID="MOCK_GITHUB_CLIENT_ID"
GITHUB_CLIENT_SECRET="MOCK_GITHUB_CLIENT_SECRET"
```

### 4. デフォルト正常系ハンドラ

各ハンドラはデフォルトで正常系レスポンスを返す設計にする。異常系はテスト内で `server.use()` により上書きする。

```typescript
// tests/mocks/pwned-passwords.ts:1-7
import { http, HttpResponse } from "msw";

export const handlers = [
  http.get("https://api.pwnedpasswords.com/range/:prefix", () => {
    return new HttpResponse("", { status: 200 });
  }),
];
```

### 5. Vite プラグインによるモジュール差し替え

`node:sqlite` のようにテスト環境でバンドルできないネイティブ依存は、Vite の `resolveId` フックで軽量スタブに差し替える。

```typescript
// vite.config.ts:16-26
const cacheServerStubPlugin = {
  name: "vitest-cache-server-stub",
  enforce: "pre" as const,
  resolveId(source: string) {
    if (!process.env.VITEST) return null;
    if (source.endsWith("cache.server.ts")) {
      return path.resolve("tests/mocks/cache-server.ts");
    }
    return null;
  },
};
```

### 6. ファイルベースフィクスチャによるサイドエフェクト検証

メール送信モックはリクエスト内容をファイルに書き出し、E2E テストから読み取って検証する。

```typescript
// tests/mocks/resend.ts:7-22
export const handlers: Array<HttpHandler> = [
  http.post(`https://api.resend.com/emails`, async ({ request }) => {
    requireHeader(request.headers, "Authorization");
    const body = await request.json();
    console.info("mocked email contents:", body);

    const email = await writeEmail(body);

    return json({
      id: faker.string.uuid(),
      from: email.from,
      to: email.to,
      created_at: new Date().toISOString(),
    });
  }),
];
```

## Good Example

デフォルトで正常系を返し、テスト内で `server.use()` を使って異常系を上書きするパターン。テストコードが「何をテストしているか」に集中でき、`afterEach` の `resetHandlers()` で自動リセットされる。

```typescript
// app/utils/auth.server.test.ts:45-56
test("checkIsCommonPassword returns false when API returns 500", async () => {
  const password = "testpassword";
  const [prefix] = getPasswordHashParts(password);

  server.use(
    http.get(`https://api.pwnedpasswords.com/range/${prefix}`, () => {
      return new HttpResponse(null, { status: 500 });
    }),
  );

  const result = await checkIsCommonPassword(password);
  expect(result).toBe(false);
});
```

```typescript
// tests/setup/setup-test-env.ts (抜粋)
afterEach(() => server.resetHandlers());
```

このパターンの利点:

- デフォルトハンドラ（正常系）を書くだけで大半のテストが動く
- 異常系テストだけが `server.use()` でハンドラを上書きする
- `resetHandlers()` が上書きを自動リセットし、テスト間の独立性を保証する

## Bad Example

環境ごとにモックを分散定義するアンチパターン。同じ GitHub OAuth モックが開発用とテスト用で別ファイルに存在し、片方を修正してもう片方を修正し忘れる問題が起きる。

```typescript
// Bad: 開発用とテスト用でモックが分散
// dev/mocks/github.ts — 開発用モック
export function mockGitHubOAuth() {
  return http.post("https://github.com/login/oauth/access_token", () => {
    return json({ access_token: "dev_token", token_type: "bearer" });
  });
}

// tests/helpers/github-mock.ts — テスト用モック（微妙に異なる実装）
export function setupGitHubMock() {
  return http.post("https://github.com/login/oauth/access_token", () => {
    return json({ access_token: "test_token" }); // token_type が抜けている
  });
}
```

```typescript
// Good: 単一ディレクトリに集約し、全環境で同じハンドラを使う
// tests/mocks/github.ts — 全環境共用
const passthroughGitHub = !process.env.GITHUB_CLIENT_ID?.startsWith("MOCK_")
  && process.env.NODE_ENV !== "test";

export const handlers: Array<HttpHandler> = [
  http.post(
    "https://github.com/login/oauth/access_token",
    async ({ request }) => {
      if (passthroughGitHub) return passthrough();
      const params = new URLSearchParams(await request.text());
      const code = params.get("code");
      const user = await getOrCreateGitHubUser(code);
      return json({
        access_token: user.accessToken,
        token_type: "__MOCK_TOKEN_TYPE__",
      });
    },
  ),
];
```

もう一つの Bad Example: boolean フラグでモック/リアルを切り替えるパターン。`.env` を見ただけではモック状態が分からない。

```typescript
// Bad: boolean フラグによる切り替え — 意図が不明確
USE_MOCK_GITHUB = true;
GITHUB_CLIENT_ID = "real_client_id";

// Good: 値のプレフィックスで判定 — .env を見るだけでモック状態が分かる
GITHUB_CLIENT_ID = "MOCK_GITHUB_CLIENT_ID";
```

## 適用ガイド

### どのような状況で使うべきか

- 外部 HTTP API（OAuth、メール送信、ストレージ、課金 API 等）に依存するアプリケーション
- 開発時にも外部 API を使わずにオフラインで動作させたいプロジェクト
- Vitest の単体テストと Playwright の E2E テストが共存するプロジェクト
- チームメンバーが外部 API の認証情報を持っていなくても開発できるようにしたい場合

### 導入手順

1. `tests/mocks/` ディレクトリを作成し、外部 API ごとにハンドラファイルを配置する
2. `tests/mocks/index.ts` で全ハンドラを集約し `setupServer()` で登録する
3. アプリエントリポイントに `MOCKS=true` の条件分岐を追加する
4. `package.json` の `dev` スクリプトに `MOCKS=true` を設定する
5. Vitest の `setupFiles` からモックサーバーを import し、`afterEach` で `resetHandlers()` を呼ぶ
6. `.env.example` に `MOCK_` プレフィックス付きのデフォルト値を設定する

### 注意点

- **OAuth リダイレクトフロー**: MSW はネットワーク層でインターセプトするが、ブラウザリダイレクトは制御できない。OAuth の初回リダイレクトにはアプリケーションコード内の `shouldMock` 分岐が必要になる場合がある。この分岐は最小限に留め、理由を文書化すること
- **モック内の認証検証**: モックハンドラ内で外部 API の認証プロトコル（AWS Signature V4 等）を詳細に検証すると、認証ライブラリの内部実装変更でテストが壊れる。ヘッダーの存在チェック程度に留めるべき
- **並列テストのフィクスチャ分離**: ファイルベースフィクスチャを使う場合、`VITEST_POOL_ID` でファイルパスを分離し、テストワーカー間の競合を防ぐ
- **Vite プラグインによるモジュール差し替え**: `resolveId` フックでの差し替えはデバッグ時に「どの実装が使われているか」が分かりにくい。プラグイン名に用途を明記し、`VITEST` 環境変数でのみ発動する条件を入れる

### カスタマイズポイント

- **ハンドラの粒度**: Epic Stack は外部 API 単位でファイルを分割しているが、API エンドポイント数が多い場合はドメイン単位（認証系、通知系、ストレージ系）での分割も有効
- **passthrough の条件**: `MOCK_` プレフィックス以外にも、`NODE_ENV` や専用フラグ（`USE_REAL_GITHUB=true`）での切り替えも可能。チームの運用に合わせて選択する
- **サイドエフェクトの検証方法**: メール送信をファイルに書き出す方式は E2E テストとのプロセス間共有に適している。Vitest のみの場合はインメモリ配列で十分

## 参考

- [repos/epicweb-dev/epic-stack/mock-and-stub-patterns.md](../repos/epicweb-dev/epic-stack/mock-and-stub-patterns.md) -- MSW モック戦略の詳細分析
- [repos/epicweb-dev/epic-stack/testing-strategy.md](../repos/epicweb-dev/epic-stack/testing-strategy.md) -- テスト戦略全体の分析
- [repos/epicweb-dev/epic-stack/authentication-testing.md](../repos/epicweb-dev/epic-stack/authentication-testing.md) -- 認証テストにおける MSW 活用の分析
