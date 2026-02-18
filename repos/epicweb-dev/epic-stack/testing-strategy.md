# Testing Strategy

> リポジトリ: epicweb-dev/epic-stack
> 分析日: 2026-02-18

## 概要

Epic Stack は Kent C. Dodds の Testing Trophy 哲学を体現したテスト戦略を採用している。Vitest による統合テスト（ローダー/アクション単位のサーバーサイドテスト + React コンポーネントテスト）を中心に据え、Playwright による E2E テストでユーザージャーニー全体を検証し、MSW による HTTP モックを開発・テスト環境で共用する。注目すべきは「純粋なユニットテスト」がほぼ存在せず、テストの大半が実際のデータベースやセッション管理と統合した状態で実行される点にある。

## 背景にある原則

- **統合テスト中心主義（Testing Trophy）**: ユニットテストとE2Eテストの中間層である統合テストに最大の投資を行う。純粋関数のユニットテストは `getErrorMessage` や `getConservativeCacheControl` など入出力が明確な関数に限定し、認証コールバックのような複雑なビジネスロジックは実際の DB・セッション・MSW モックと統合した状態でテストする。根拠: `callback.test.ts` が Prisma でユーザーを作成し、セッション Cookie を構築し、loader 関数を直接呼び出してリダイレクトと Cookie を検証している（`app/routes/_auth/auth.$provider/callback.test.ts:32-238`）。

- **テストとユーザー行動の一致**: テストはユーザーが実際にアプリケーションを使う方法に近い形で記述する。Vitest テストでもロール・ラベルによる要素取得を使い、E2E テストではユーザーストーリー全体を一つのテストケースとして表現する。根拠: E2E テストのテスト名が「Users can create notes」「Users can update their password」のようにユーザー視点で書かれている（`tests/e2e/notes.test.ts:5,20,47`）。

- **モックの境界を外部サービスに限定する**: アプリケーション内部のモジュールではなく、HTTP 境界（外部 API）でのみモックを行う。MSW で GitHub OAuth, Resend メール, Tigris ストレージ, Pwned Passwords API をインターセプトし、アプリ内のコードはそのまま実行する。根拠: `tests/mocks/` 配下のハンドラがすべて外部 HTTP エンドポイントに対するもので、アプリ内モジュールの jest.mock/vi.mock は使われていない。

- **テスト環境の自律性（Offline Development）**: 外部サービスへの依存なしにテストを実行できるようにする。`MOCKS=true` で MSW サーバーが起動し、開発時もテスト時も同じモックを使う。モックがリアルな API 実装を含む場合は `passthrough()` で本物の API に切り替え可能とする。根拠: `tests/mocks/github.ts:131-133` の `passthroughGitHub` フラグが環境変数によりモック/リアルを切り替える。

## 実例と分析

### テスト種別の使い分けと比率

Vitest テスト（6 ファイル, 643 行）と E2E テスト（8 ファイル, 1058 行）の構成から、テスト種別ごとの使い分け基準が明確に見える。

**純粋ユニットテスト**（Vitest, Node 環境）: 外部依存のない純粋関数のみ。

- `misc.error-message.test.ts`: `getErrorMessage` のパターン網羅（24 行, 3 テスト）
- `headers.server.test.ts`: `getConservativeCacheControl` の値テスト（39 行, 3 テスト）

**統合テスト**（Vitest, Node/jsdom 環境）: 実 DB + MSW + セッション管理を含むテスト。

- `callback.test.ts`: OAuth コールバックローダーの 8 シナリオ（291 行）。実際の Prisma でユーザー/セッション/コネクションを作成し、loader を直接呼び出す
- `auth.server.test.ts`: パスワードチェック関数の 5 ケース（109 行）。MSW で Pwned Passwords API の応答を切り替え
- `misc.use-double-check.test.tsx`: React フックのコンポーネントテスト（83 行）。Testing Library で DOM 操作を検証
- `index.test.tsx`: ルートコンポーネントのレンダリングテスト（97 行）。`createRoutesStub` で React Router をスタブ化

**E2E テスト**（Playwright）: ユーザージャーニー全体をブラウザで検証。

- `onboarding.test.ts`: 登録フロー全体の 8 シナリオ（438 行）
- `settings-profile.test.ts`: プロフィール設定変更の 4 シナリオ（127 行）
- `passkey.test.ts`: WebAuthn パスキー登録・使用の 2 シナリオ（162 行）

### DB スナップショットによるテスト分離

テスト間の独立性を確保する仕組みとして、DB スナップショットのコピー方式を採用している。

`global-setup.ts` がテストスイート起動前に `base.db` を Prisma マイグレーションで作成し、`db-setup.ts` が各テストの `beforeEach` で `base.db` を `data.{poolId}.db` にコピーする。これにより各テストは新鮮な DB 状態から開始される。

VITEST_POOL_ID を活用して並列実行時の DB ファイル衝突も回避している。

### MSW ハンドラの開発・テスト共用設計

MSW のモックハンドラは `tests/mocks/` に配置され、3 つの異なるコンテキストで共用される。

1. **開発時**: `MOCKS=true` で `index.ts` から起動。GitHub OAuth のリアル認証情報が設定されている場合は `passthrough()` で実 API を使用
2. **Vitest テスト**: `setup-test-env.ts` でサーバーを import し、`afterEach` で `server.resetHandlers()` を呼ぶ
3. **E2E テスト**: Playwright の `webServer` で `start:mocks` コマンドを使い、MSW が組み込まれたサーバーを起動

### Playwright カスタムフィクスチャによるテスト抽象化

`tests/playwright-utils.ts` で Playwright の `test` オブジェクトを拡張し、`login`, `insertNewUser`, `prepareGitHubUser`, `navigate` の 4 つのカスタムフィクスチャを提供している。

各フィクスチャはセットアップだけでなくティアダウン（ユーザー削除）も内包しており、テストコードがビジネスロジックの検証に集中できる。

### console.error/warn を例外に変換するガード

`setup-test-env.ts` で `console.error` と `console.warn` をスパイ化し、呼び出されると例外をスローする。テスト中に想定される警告・エラーがある場合は、テスト内で明示的に `consoleError.mockImplementation(() => {})` を呼ぶ必要がある。

## コード例

DB スナップショットコピーによるテスト分離:

```ts
// tests/setup/db-setup.ts:6-23
const poolId = process.env.VITEST_POOL_ID || "0";
const databaseFile = `./tests/prisma/data.${poolId}.db`;
const databasePath = path.join(process.cwd(), databaseFile);
process.env.DATABASE_URL = `file:${databasePath}`;

beforeEach(async () => {
  await fsExtra.copyFile(BASE_DATABASE_PATH, databasePath);
});
```

統合テストでのローダー直接呼び出し（DB + MSW + セッション統合）:

```ts
// app/routes/_auth/auth.$provider/callback.test.ts:64-94
test("when a user is logged in, it creates the connection", async () => {
  const githubUser = await insertGitHubUser();
  const session = await setupUser();
  const request = await setupRequest({
    sessionId: session.id,
    code: githubUser.code,
  });
  const response = await loader({
    request,
    ...LOADER_ARGS_BASE,
  });
  expect(response).toHaveRedirect("/settings/profile/connections");
  await expect(response).toSendToast(
    expect.objectContaining({
      title: "Connected",
      type: "success",
      description: expect.stringContaining(githubUser.profile.login),
    }),
  );
  const connection = await prisma.connection.findFirst({
    select: { id: true },
    where: {
      userId: session.userId,
      providerId: githubUser.profile.id.toString(),
    },
  });
  expect(connection, "the connection was not created in the database").toBeTruthy();
});
```

MSW ハンドラの環境別切り替え:

```ts
// tests/mocks/github.ts:131-139
const passthroughGitHub = !process.env.GITHUB_CLIENT_ID?.startsWith("MOCK_")
  && process.env.NODE_ENV !== "test";

export const handlers: Array<HttpHandler> = [
  http.post("https://github.com/login/oauth/access_token", async ({ request }) => {
    if (passthroughGitHub) return passthrough();
    // ... mock implementation
  }),
];
```

Playwright カスタムフィクスチャの自動クリーンアップ:

```ts
// tests/playwright-utils.ts:91-118
login: async ({ page }, use) => {
	let userId: string | undefined = undefined
	await use(async (options) => {
		const user = await getOrInsertUser(options)
		userId = user.id
		const session = await prisma.session.create({
			data: {
				expirationDate: getSessionExpirationDate(),
				userId: user.id,
			},
			select: { id: true },
		})
		const authSession = await authSessionStorage.getSession()
		authSession.set(sessionKey, session.id)
		const cookieConfig = setCookieParser.parseString(
			await authSessionStorage.commitSession(authSession),
		)
		await page.context().addCookies([newConfig])
		return user
	})
	await prisma.user.deleteMany({ where: { id: userId } })
},
```

console.error ガード:

```ts
// tests/setup/setup-test-env.ts:17-27
beforeEach(() => {
  const originalConsoleError = console.error;
  consoleError = vi.spyOn(console, "error");
  consoleError.mockImplementation(
    (...args: Parameters<typeof console.error>) => {
      originalConsoleError(...args);
      throw new Error(
        "Console error was called. Call consoleError.mockImplementation(() => {}) if this is expected.",
      );
    },
  );
});
```

カスタムマッチャーによるドメイン固有アサーション:

```ts
// tests/setup/custom-matchers.ts:15-78
expect.extend({
  toHaveRedirect(response: unknown, redirectTo?: string) {
    // Response オブジェクトの location ヘッダとステータスコードを検証
  },
  async toHaveSessionForUser(response: Response, userId: string) {
    // Set-Cookie からセッションを復元し、DB のセッションと照合
  },
  async toSendToast(response: Response, toast: ToastInput) {
    // Set-Cookie からトーストセッションを復元し、内容を検証
  },
});
```

## Good Patterns

- **DB スナップショットコピーによるテスト分離**: テストごとにマイグレーション済みの `base.db` をファイルコピーして新鮮な DB を提供する。`cleanupDb` のような「全テーブル削除」よりも高速で、Prisma のマイグレーションテーブルなどの実装詳細に依存しない。`VITEST_POOL_ID` で並列実行時のファイル衝突も回避する。

```ts
// tests/setup/db-setup.ts:6-8
const poolId = process.env.VITEST_POOL_ID || "0";
const databaseFile = `./tests/prisma/data.${poolId}.db`;
const databasePath = path.join(process.cwd(), databaseFile);
```

- **カスタムマッチャーでドメイン固有のアサーション言語を構築**: `toHaveRedirect`, `toHaveSessionForUser`, `toSendToast` のようなカスタムマッチャーにより、HTTP レスポンスの Cookie パース・セッション復元・DB 照合といった複雑な検証を一行で表現できる。テストコードの可読性と保守性が大幅に向上する。

```ts
// app/routes/_auth/auth.$provider/callback.test.ts:75-81
expect(response).toHaveRedirect("/settings/profile/connections");
await expect(response).toSendToast(
  expect.objectContaining({ title: "Connected", type: "success" }),
);
```

- **MSW ハンドラの開発・テスト共用**: 同一のモックハンドラを `MOCKS=true` の開発環境、Vitest のセットアップ、Playwright の E2E テストで共用することで、モックの重複を排除し一貫性を維持する。開発中に動作確認したモックがそのままテストでも使われるため、モックのずれが発生しにくい。

- **Playwright フィクスチャによるセットアップ/ティアダウンの自動化**: `test.extend` でログイン・ユーザー作成のフィクスチャを定義し、テスト終了後に自動でユーザーを削除する。テストコードにクリーンアップロジックが散在せず、テスト間の独立性が保証される。

- **console.error/warn の例外変換ガード**: テスト中の予期しない console.error/warn を例外に変換することで、サイレントに失敗するテストを防止する。意図的な警告の場合はテスト内で `mockImplementation(() => {})` を明示的に呼ぶことで、その判断がコードレビューで可視化される。

## Anti-Patterns / 注意点

- **ハンドラの状態をファイルシステムで管理する**: GitHub モックハンドラが `users.{poolId}.local.json` にユーザーデータを書き込む。これは並列実行時のレースコンディションを回避するための工夫だが、ファイル I/O のオーバーヘッドがあり、テスト後にファイルが残る可能性がある。

```ts
// Bad: ファイルベースの状態管理（レースコンディションの余地あり）
const githubUserFixturePath = path.join(
  here("..", "fixtures", "github", `users.${process.env.VITEST_POOL_ID || 0}.local.json`),
);
```

```ts
// Better: テスト単位でインメモリマップを使い、フィクスチャごとにスコープする
const githubUsers = new Map<string, GitHubUser>();
```

ただし、この方式は E2E テストとの共用という制約があるため完全な解消は難しい。E2E テストではプロセス間通信が必要でファイルが妥当な選択となるケースもある。

- **Vite プラグインによるモジュール差し替えの暗黙性**: `cache.server.ts` を Vitest 時のみスタブに差し替える `cacheServerStubPlugin` は、コードを読んだだけでは差し替えが起きていることに気づきにくい。

```ts
// Bad: 暗黙のモジュール差し替え
const cacheServerStubPlugin = {
  name: "vitest-cache-server-stub",
  resolveId(source: string) {
    if (!process.env.VITEST) return null;
    if (source.endsWith("cache.server.ts")) {
      return path.resolve("tests/mocks/cache-server.ts");
    }
    return null;
  },
};
```

```ts
// Better: vi.mock で明示的にモック対象を宣言する（ただしバンドル制約がある場合はプラグイン方式が必要）
vi.mock("#app/utils/cache.server.ts", () => import("#tests/mocks/cache-server.ts"));
```

実際にはこのケースは `node:sqlite` の Vite バンドル問題という技術的制約があるため、プラグイン方式が必要だった（ADR 047 参照）。

## 導出ルール

- `[MUST]` テスト中の `console.error` / `console.warn` をデフォルトで例外に変換し、意図的な呼び出しのみ明示的にモック解除する
  - 根拠: Epic Stack の `setup-test-env.ts` で実装されており、サイレントに失敗するテストを防止している（`tests/setup/setup-test-env.ts:17-37`）

- `[MUST]` 外部 HTTP API のモックは MSW のようなネットワーク層インターセプトで行い、アプリ内モジュールの mock/stub は最小限にする
  - 根拠: Epic Stack の全 MSW ハンドラが外部 API エンドポイント（GitHub, Resend, Tigris, Pwned Passwords）に対するもので、`vi.mock` によるモジュールモックは `cache.server.ts` の技術的制約のケースのみ（`tests/mocks/index.ts:1-39`）

- `[SHOULD]` ビジネスロジックのテストは純粋関数の入出力テストよりも、実際の依存（DB, セッション, HTTP）と統合した状態でのテストを優先する
  - 根拠: OAuth コールバックテストが Prisma で DB を操作し、セッション Cookie を構築し、loader を直接呼び出す統合テスト形式で記述されている（`app/routes/_auth/auth.$provider/callback.test.ts:32-238`）

- `[SHOULD]` E2E テストのフィクスチャにセットアップとティアダウンを内包し、テストコードからクリーンアップロジックを排除する
  - 根拠: Playwright の `test.extend` で `login`, `insertNewUser` フィクスチャを定義し、`use()` コールバック後にユーザー削除を自動実行している（`tests/playwright-utils.ts:69-145`）

- `[SHOULD]` テスト対象のドメインに特化したカスタムマッチャーを作成し、テストの意図を宣言的に表現する
  - 根拠: `toHaveRedirect`, `toHaveSessionForUser`, `toSendToast` の 3 つのカスタムマッチャーがレスポンス検証の複雑さを隠蔽し、テストコードを1行の宣言に変えている（`tests/setup/custom-matchers.ts:15-158`）

- `[SHOULD]` SQLite のようなファイルベース DB のテスト分離には、マイグレーション済みのベース DB ファイルをテストごとにコピーする方式を使う
  - 根拠: `cleanupDb` によるテーブル削除方式を廃止し、ファイルコピー方式に移行した ADR 038 の決定。ナノ秒単位で完了し、ORM の内部テーブルに依存しない（`tests/setup/db-setup.ts:21-23`）

- `[AVOID]` E2E テストでユニットテストが適切な範囲の検証を行う。純粋関数のバリデーションや分岐網羅は Vitest で高速にカバーし、E2E は「ユーザーが実際にできること」の確認に限定する
  - 根拠: `getErrorMessage` の 3 パターン・`getConservativeCacheControl` のエッジケースは Vitest で即座に検証し、E2E テストは「ユーザーがノートを作成できる」「2FA を設定できる」のようなジャーニー単位である（`tests/e2e/` のテスト名参照）

## 適用チェックリスト

- [ ] テストセットアップで `console.error` / `console.warn` を例外に変換するガードを導入している
- [ ] 外部 API のモックに MSW（またはネットワーク層インターセプト）を使い、`vi.mock` / `jest.mock` によるモジュールモックを最小限にしている
- [ ] MSW のモックハンドラを開発環境とテスト環境で共用し、モック定義の重複を避けている
- [ ] サーバーサイドのビジネスロジック（loader/action）テストが実際の DB とセッションを使った統合テストとして書かれている
- [ ] E2E テストにカスタムフィクスチャ（ログイン、ユーザー作成）を用意し、セットアップ/ティアダウンを自動化している
- [ ] ドメイン固有のカスタムマッチャー（リダイレクト検証、セッション検証など）を作成し、テストの可読性を高めている
- [ ] ファイルベース DB（SQLite）のテスト分離にスナップショットコピー方式を採用している
- [ ] 並列テスト実行時のリソース競合を回避する仕組み（プール ID によるファイル分離など）がある
- [ ] テスト名がユーザー視点の振る舞い記述になっている（「Users can ...」「when ... then ...」）
- [ ] E2E テストと統合テストの境界が明確で、E2E はユーザージャーニー、統合テストはサーバーロジックの分岐網羅に使い分けている
