# Mock and Stub Patterns

> リポジトリ: epicweb-dev/epic-stack
> 分析日: 2026-02-18

## 概要

MSW (Mock Service Worker) を中心としたモック戦略の設計と、開発環境・テスト環境・E2E テスト・DB シードで共用するモックサーバーのパターンを分析した。Epic Stack は外部 API モックを `tests/mocks/` に集約し、環境変数による条件分岐と Vite プラグインによるモジュール差し替えを組み合わせて、単一のモック定義を複数の実行コンテキストで再利用する設計を採用している。この設計は「モックの一貫性」と「テストの信頼性」を両立させる実用的なアプローチとして注目に値する。

## 背景にある原則

- **Single Source of Mock Truth**: モックハンドラを一箇所に集約し、開発・テスト・E2E・シードの全環境で同じ定義を再利用すべき。なぜなら、環境ごとにモックを分散させると振る舞いの乖離が起き、「開発では動くがテストで壊れる」問題が頻発するため (`tests/mocks/index.ts` が全ハンドラを集約し、`index.ts:19-21` で開発モード、`tests/setup/setup-test-env.ts:8` でテスト環境から参照)。

- **環境変数による Mock/Real の切り替え**: モックとリアル実装の切り替えはコード変更ではなく環境変数で制御すべき。なぜなら、コード内の条件分岐を最小化し、CI/ローカル/ステージングで同じバイナリから異なる振る舞いを引き出せるため (`.env.example:13-17` で `MOCK_` プレフィックスの環境変数、`github.ts:131-133` で `passthroughGitHub` の判定)。

- **Fixture as Side-Effect Capture**: 非同期サイドエフェクト（メール送信等）はモックハンドラ内でファイルシステムに書き出し、テストコードから読み取れるようにすべき。なぜなら、送信内容の検証を可能にしつつ、アプリケーションコードには手を加えずに済むため (`tests/mocks/resend.ts:13` で `writeEmail(body)` を呼び、`tests/e2e/onboarding.test.ts:70` で `readEmail()` から内容を検証)。

- **バンドル不可能な依存のモジュール差し替え**: テスト環境でバンドルできないネイティブモジュール（`node:sqlite` 等）は、Vite プラグインの `resolveId` フックで軽量なスタブに差し替えるべき。なぜなら、テスト対象コードの import を書き換えずに依存を入れ替えられ、本番コードに一切影響を与えないため (`vite.config.ts:16-26` の `cacheServerStubPlugin`)。

## 実例と分析

### MSW ハンドラの集約と起動制御

`tests/mocks/index.ts` が全モックハンドラの集約ポイントとして機能する。`setupServer()` で MSW サーバーを構成し、開発環境では `closeWithGrace` でプロセス終了時のクリーンアップを行う。テスト環境ではログ出力を抑制し、`setup-test-env.ts` で `afterEach(() => server.resetHandlers())` によりテスト間の独立性を保証する。

```typescript
// tests/mocks/index.ts:8-39
export const server = setupServer(
  ...resendHandlers,
  ...githubHandlers,
  ...tigrisHandlers,
  ...pwnedPasswordApiHandlers,
);

server.listen({
  onUnhandledRequest(request, print) {
    if (request.url.includes(".sentry.io")) {
      return;
    }
    if (request.url.includes("__rrdt")) {
      return;
    }
    print.warning();
  },
});

if (process.env.NODE_ENV !== "test") {
  console.info("🔶 Mock server installed");
  closeWithGrace(() => {
    server.close();
  });
}
```

アプリケーションのエントリポイント (`index.ts:19-21`) では `MOCKS=true` のときだけモックサーバーを動的 import する。

```typescript
// index.ts:19-21
if (process.env.MOCKS === "true") {
  await import("./tests/mocks/index.ts");
}
```

`package.json` のスクリプトで `dev` コマンドに `MOCKS=true` を設定し、開発時は常にモック経由で外部 API を呼ぶ。

```json
"dev": "cross-env NODE_ENV=development MOCKS=true node index.ts",
"start:mocks": "cross-env NODE_ENV=production MOCKS=true node index.ts",
```

### 条件付き Passthrough パターン

GitHub モックハンドラは `passthrough()` を活用し、実際の GitHub API キーが設定されている場合はリアル API へリクエストを中継する。環境変数のプレフィックスで Mock/Real を判定する設計により、同一コードで両方の振る舞いを実現する。

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

### ファイルシステムベースの Fixture 共有

GitHub モックはテストワーカーの並列実行に対応するため、`VITEST_POOL_ID` でフィクスチャファイルを分離する。フィクスチャは JSON ファイルとしてディスクに永続化され、単体テスト・E2E テスト・DB シードの全てから読み書きできる。

```typescript
// tests/mocks/github.ts:13-20
const githubUserFixturePath = path.join(
  here(
    "..",
    "fixtures",
    "github",
    `users.${process.env.VITEST_POOL_ID || 0}.local.json`,
  ),
);
```

メール送信モックも同じパターンで、モックハンドラがメール内容をフィクスチャに書き出し、E2E テストがそのファイルを読み取って内容を検証する。

```typescript
// tests/mocks/utils.ts:31-35
export async function writeEmail(rawEmail: unknown) {
  const email = EmailSchema.parse(rawEmail);
  await createFixture("email", email.to, email);
  return email;
}
```

### Vite プラグインによるモジュール差し替え

`cache.server.ts` は `node:sqlite` に依存しており、Vitest の jsdom 環境ではバンドルできない。Vite プラグインの `resolveId` フックで、テスト時のみインメモリ実装に差し替える。

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

スタブ実装は `Map` ベースのインメモリキャッシュで、`cachified` 関数は常に `getFreshValue` を呼ぶ簡易実装を提供する。

```typescript
// tests/mocks/cache-server.ts:50-58
export async function cachified<Value>(
  options: {
    getFreshValue: (context: { metadata: CacheEntry<unknown>["metadata"]; }) => Promise<Value> | Value;
  },
): Promise<Value> {
  return options.getFreshValue({
    metadata: { createdTime: Date.now(), ttl: null, swr: null },
  });
}
```

### E2E テストでのモック連携

Playwright テストでは `prepareGitHubUser` フィクスチャが MSW モックと連携する。テスト ID をカスタムヘッダーとして注入し、モックハンドラ側でテストごとに異なるユーザーを返す。

```typescript
// tests/playwright-utils.ts:120-131
prepareGitHubUser: async ({ page }, use, testInfo) => {
	await page.route(/\/auth\/github(?!\/callback)/, async (route, request) => {
		const headers = {
			...request.headers(),
			[MOCK_CODE_GITHUB_HEADER]: testInfo.testId,
		}
		await route.continue({ headers })
	})

	let ghUser: GitHubUser | null = null
	await use(async () => {
		const newGitHubUser = await insertGitHubUser(testInfo.testId)!
```

アプリケーション側の `handleMockAction` でこのヘッダーを読み取り、OAuth フローをモック化する。

```typescript
// app/utils/providers/github.server.ts:134-141
async handleMockAction(request: Request) {
	if (!shouldMock) return

	const state = cuid()
	const code =
		request.headers.get(MOCK_CODE_GITHUB_HEADER) || MOCK_CODE_GITHUB
```

### テスト内でのハンドラ上書き

デフォルトモックが正常系を返す設計にしておき、テスト内で `server.use()` を使って異常系やエッジケースを上書きする。`afterEach` の `resetHandlers()` により、上書きは自動的にリセットされる。

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

## パターンカタログ

- **Proxy パターン** (分類: 構造)
  - 解決する問題: 外部 API への依存をテスト環境から排除しつつ、本番と同じ API 呼び出しコードを使いたい
  - 適用条件: HTTP 通信を行うサードパーティ API が存在し、テスト・開発で実 API を使えない/使いたくない場合
  - コード例: `tests/mocks/github.ts:135-157` (MSW ハンドラが GitHub API のプロキシとして動作)
  - 注意点: `passthrough()` で本物の API にも中継できる点が通常の Proxy と異なる

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 環境ごとに異なるキャッシュ実装（SQLite vs インメモリ）を切り替えたい
  - 適用条件: 同一インターフェースに対して複数の実装を提供し、実行環境で切り替える場合
  - コード例: `tests/mocks/cache-server.ts` と `app/utils/cache.server.ts` が同じエクスポートシグネチャを持つ
  - 注意点: Vite プラグインが暗黙的に差し替えるため、デバッグ時に「どの実装が使われているか」が分かりにくくなる

## Good Patterns

- **デフォルト正常系 + テスト内異常系上書き**: デフォルトモックは正常系レスポンスを返し、異常系テストでのみ `server.use()` でハンドラを上書きする。これによりテストのボイラープレートが減り、テストコードが「何をテストしているか」に集中できる。`pwned-passwords.ts` はデフォルトで空レスポンス（パスワード漏洩なし）を返し、`auth.server.test.ts:7-22` で漏洩ありケースを上書きする。

- **環境変数プレフィックスによる Mock/Real スイッチ**: `GITHUB_CLIENT_ID` が `MOCK_` で始まるかどうかでモック適用を判定する。boolean フラグよりも意図が明確で、`.env` ファイルを見るだけでモック状態が分かる。実際の認証情報を設定すれば自動的にリアル API に切り替わるため、開発者の認知負荷が低い。

```typescript
// tests/mocks/github.ts:131-133
const passthroughGitHub = !process.env.GITHUB_CLIENT_ID?.startsWith("MOCK_")
  && process.env.NODE_ENV !== "test";
```

- **VITEST_POOL_ID によるフィクスチャ分離**: 並列テスト実行時にフィクスチャファイルの競合を避けるため、テストワーカー ID をファイル名に含める。データベースファイル (`db-setup.ts:7`) と GitHub ユーザーフィクスチャ (`github.ts:18`) の両方で同じ手法を適用している。

- **Zod スキーマによるモック入力バリデーション**: メール送信モックで `EmailSchema.parse(rawEmail)` により入力を検証する (`utils.ts:31-33`)。モック内でもバリデーションを行うことで、本番 API が受け付けない不正な入力がテストをすり抜けることを防ぐ。

## Anti-Patterns / 注意点

- **モックの過度な忠実性**: オブジェクトストレージモック (`tigris.ts`) は AWS Signature V4 の認証ヘッダーを部分的に検証している (`tigris.ts:19-33`)。モック内での認証検証はテストの脆弱性を高め、認証ライブラリの内部実装変更でテストが壊れる原因になる。

```typescript
// Bad: モック内で認証プロトコルの詳細を検証
function validateAuth(headers: Headers) {
  const authHeader = headers.get("Authorization");
  if (!authHeader?.startsWith("AWS4-HMAC-SHA256")) return false;
  if (authHeader.includes(`Credential=${STORAGE_ACCESS_KEY}/`)) return true;
  return false;
}

// Better: モックでは認証ヘッダーの存在のみ検証
function validateAuth(headers: Headers) {
  return headers.has("Authorization");
}
```

- **アプリケーションコード内のモック分岐**: `github.server.ts:23-25` でアプリケーションコード自体に `shouldMock` 分岐がある。MSW はネットワークレイヤーでインターセプトするため本来不要だが、OAuth リダイレクトフローではブラウザ遷移が発生するため MSW だけでは対処できない。この分岐は最小限に留め、ADR 等で理由を文書化すべき。

```typescript
// app/utils/providers/github.server.ts:23-25
const shouldMock = process.env.GITHUB_CLIENT_ID?.startsWith("MOCK_")
  || process.env.NODE_ENV === "test";
```

## 導出ルール

- `[MUST]` MSW モックサーバーのハンドラリセット (`server.resetHandlers()`) をテストの afterEach で実行し、テスト間のモック状態汚染を防ぐ
  - 根拠: `setup-test-env.ts:11` で全テストに適用しており、`server.use()` による個別テストの上書きが他テストに漏れない保証を作っている

- `[MUST]` 並列テスト実行時にフィクスチャファイルのパスにワーカー ID を含め、テスト間のファイル競合を防ぐ
  - 根拠: `github.ts:18` で `VITEST_POOL_ID` をファイル名に組み込み、`db-setup.ts:7` でも同一パターンを適用して並列テストの独立性を確保している

- `[SHOULD]` モックハンドラのデフォルトは正常系レスポンスとし、異常系は個別テストの `server.use()` で上書きする
  - 根拠: `pwned-passwords.ts:3-7` で正常系（漏洩なし）をデフォルトとし、`auth.server.test.ts` の各テストで漏洩あり・500エラー・タイムアウト等を個別に上書きしている

- `[SHOULD]` 開発・テスト・E2E・シードで使うモック定義を単一ディレクトリに集約し、環境変数で有効化を制御する
  - 根拠: `tests/mocks/` に全ハンドラを集約し、`MOCKS=true` (開発時) と Vitest setupFiles (テスト時) の両方から同じコードを参照することで、モック定義の乖離を防止している

- `[SHOULD]` テスト環境でバンドル不可能なネイティブ依存は、ビルドツールのモジュール解決フックで軽量スタブに差し替える
  - 根拠: `vite.config.ts:16-26` で `resolveId` フックを使い、`node:sqlite` 依存の `cache.server.ts` をインメモリ `Map` ベースのスタブに差し替え、テストコードの import パスを一切変更していない

- `[SHOULD]` 非同期サイドエフェクト（メール送信等）のモックは内容をファイルシステムに書き出し、テストコードから検証可能にする
  - 根拠: `resend.ts:13` で `writeEmail(body)` を呼び出してフィクスチャに保存し、E2E テスト (`onboarding.test.ts:70`) から `readEmail()` で送信内容を検証できる設計を実現している

- `[AVOID]` モックハンドラ内で外部 API の認証プロトコル詳細（署名アルゴリズム、ヘッダーフォーマット等）を検証すること
  - 根拠: `tigris.ts:19-33` で AWS Signature V4 の部分検証を行っているが、認証ライブラリの内部実装変更でテストが壊れるリスクがあり、ヘッダーの存在チェック程度に留めるべき

## 適用チェックリスト

- [ ] MSW のモックハンドラを `tests/mocks/` に集約し、`setupServer()` で一括登録しているか
- [ ] テスト用 setupFiles で `afterEach(() => server.resetHandlers())` を設定しているか
- [ ] 開発環境でモックを有効化する仕組み（`MOCKS=true` 等）があるか
- [ ] 外部 API のモック/リアル切り替えが環境変数で制御できるか（コード変更不要か）
- [ ] 並列テスト実行時にフィクスチャファイルがワーカー間で競合しないか
- [ ] バンドルできないネイティブ依存をテスト時にスタブで差し替える仕組みがあるか
- [ ] メール送信等の非同期サイドエフェクトをテストから検証する手段があるか
- [ ] モックハンドラのデフォルトが正常系で、異常系テストは `server.use()` で上書きしているか
- [ ] E2E テストからモック状態を制御するためのカスタムヘッダーやフィクスチャ API があるか
