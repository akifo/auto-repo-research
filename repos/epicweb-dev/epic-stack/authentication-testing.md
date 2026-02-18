# authentication-testing

> リポジトリ: epicweb-dev/epic-stack
> 分析日: 2026-02-18

## 概要

セッション・Cookie・OAuth（GitHub）・2FA・パスキーを含む認証機能のテスト手法を横断的に分析した。
このリポジトリでは、認証テストを3層（ユニットテスト / Vitest 統合テスト / Playwright E2E テスト）に分離し、各層に最適なバイパスとモック戦略を使い分けている。
特に注目すべきは「E2E テストで UI ログインをスキップし、DB + Cookie 直接注入で認証状態を構築する」パターンと、「OAuth を MSW + ファイルベースフィクスチャでモックし、E2E では Playwright のルートインターセプトでテストIDをヘッダに注入する」二重モック戦略である。

## 背景にある原則

- **認証はテストのセットアップであり、テスト対象ではない（大半のケースで）**: 認証テスト自体を書くテスト以外では、ログインはテスト前提条件に過ぎない。UI ログインフローを毎回実行すると低速かつ脆いテストになるため、認証状態をプログラマティックに構築すべき。epic-stack の `login` フィクスチャが DB にセッションを直接作成し Cookie を注入している設計がこれを体現している（`tests/playwright-utils.ts:91-118`）。

- **外部認証プロバイダは決定論的にモックすべき**: OAuth のような外部依存はネットワーク障害やレート制限で非決定的になりうる。全テスト層で MSW によるモックを敷き、テストごとに固有のコード（`testInfo.testId`）を注入することで、並列実行時のデータ衝突を防いでいる（`tests/mocks/github.ts:13-19`、`tests/playwright-utils.ts:120-145`）。

- **セキュリティ外部 API はフォールセーフでテストすべき**: パスワード漏洩チェック（Have I Been Pwned API）のように失敗しても致命的でないセキュリティ機能は、タイムアウト・500エラー・不正レスポンスの全異常系で `false` を返すことをテストする。本番での障害がユーザーブロックにつながらないことを保証するため（`app/utils/auth.server.test.ts:45-109`）。

- **カスタムマッチャーでドメイン固有のアサーションを抽象化すべき**: 認証結果の検証は Set-Cookie ヘッダのパース → セッションストレージの復号 → DB 照合という多段階処理になる。これをテストごとに繰り返すと可読性が下がりバグの温床になるため、`toHaveSessionForUser` のようなカスタムマッチャーに集約する（`tests/setup/custom-matchers.ts:79-119`）。

## 実例と分析

### Cookie 直接注入による認証バイパス（E2E）

E2E テストの `login` フィクスチャは、UI ログインを一切行わずに認証状態を構築する。手順は以下の通り:

1. DB にユーザーとセッションレコードを作成
2. `authSessionStorage` でセッション Cookie を生成
3. `set-cookie-parser` でパースし、Playwright の `addCookies` で直接注入

この設計により、`notes.test.ts` や `2fa.test.ts` などの非認証テストは `await login()` 一行で認証状態をセットアップし、テスト本来の対象に集中できる。

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
        const newConfig = {
            ...cookieConfig,
            domain: 'localhost',
            expires: cookieConfig.expires?.getTime(),
            sameSite: cookieConfig.sameSite as 'Strict' | 'Lax' | 'None',
        }
        await page.context().addCookies([newConfig])
        return user
    })
    await prisma.user.deleteMany({ where: { id: userId } })
},
```

### OAuth モックの二重戦略（Vitest + Playwright）

OAuth テストは2層で異なるモック戦略を使い分けている:

**Vitest 統合テスト層**（`callback.test.ts`）: MSW でGitHub APIを直接モックし、`setupRequest` ヘルパーで OAuth コールバックリクエストを組み立てる。Cookie の構築まで自前で行い、ローダー関数を直接呼び出す。

```ts
// app/routes/_auth/auth.$provider/callback.test.ts:240-272
async function setupRequest({
    sessionId,
    code = faker.string.uuid(),
}: { sessionId?: string; code?: string } = {}) {
    const url = new URL(ROUTE_PATH, BASE_URL)
    const state = faker.string.uuid()
    url.searchParams.set('state', state)
    url.searchParams.set('code', code)
    const authSession = await authSessionStorage.getSession()
    if (sessionId) authSession.set(sessionKey, sessionId)
    const setSessionCookieHeader =
        await authSessionStorage.commitSession(authSession)
    const searchParams = new URLSearchParams({ code, state })
    let authCookie = new SetCookie({
        name: 'github',
        value: searchParams.toString(),
        path: '/',
        sameSite: 'Lax',
        httpOnly: true,
        maxAge: 60 * 10,
        secure: process.env.NODE_ENV === 'production' || undefined,
    })
    const request = new Request(url.toString(), {
        method: 'GET',
        headers: {
            cookie: [
                authCookie.toString(),
                convertSetCookieToCookie(setSessionCookieHeader),
            ].join('; '),
        },
    })
    return request
}
```

**Playwright E2E 層**（`onboarding.test.ts`）: `prepareGitHubUser` フィクスチャが Playwright のルートインターセプトを使い、リクエストヘッダに `testInfo.testId` を注入する。サーバー側の `handleMockAction` がこのヘッダを読み取り、テスト固有の OAuth コードとして扱う。

```ts
// tests/playwright-utils.ts:120-145
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
        ghUser = newGitHubUser
        return newGitHubUser
    })
    // cleanup...
},
```

### ファイルベースフィクスチャによるプロセス間共有

GitHub ユーザーモックデータは JSON ファイルに永続化し、プロセス境界を越えて共有する。E2E テストでは Playwright（テストランナー）とアプリサーバー（別プロセス）が同じモックデータを参照する必要があるため、インメモリストアでは不十分である。`VITEST_POOL_ID` でファイルを分離し、並列実行時の競合も防いでいる。

```ts
// tests/mocks/github.ts:13-19
const githubUserFixturePath = path.join(
    here(
        '..',
        'fixtures',
        'github',
        `users.${process.env.VITEST_POOL_ID || 0}.local.json`,
    ),
)
```

### カスタムマッチャーによる認証アサーション

`toHaveSessionForUser` は Set-Cookie ヘッダからセッションを復号し、DB のセッションレコードと照合するまでの一連の検証をワンライナーで表現する。

```ts
// tests/setup/custom-matchers.ts:79-119
async toHaveSessionForUser(response: Response, userId: string) {
    const setCookies = response.headers.getSetCookie()
    const sessionSetCookie = setCookies.find(
        (c) => setCookieParser.parseString(c).name === 'en_session',
    )
    // ... Cookie 存在チェック
    const authSession = await authSessionStorage.getSession(
        convertSetCookieToCookie(sessionSetCookie),
    )
    const sessionValue = authSession.get(sessionKey)
    // ... セッション値チェック
    const session = await prisma.session.findUnique({
        select: { id: true },
        where: { userId, id: sessionValue },
    })
    return {
        pass: Boolean(session),
        message: () => `A session was${...} created in the database for ${userId}`,
    }
}
```

### フォールセーフ外部 API のテスト

パスワード漏洩チェック API のテストは、正常系だけでなく500エラー・不正レスポンス・タイムアウトの全異常系で `false`（安全側）を返すことを検証する。`AbortSignal.timeout` と fake timers の非互換問題（`sinonjs/fake-timers#418`）をコメントで文書化している点も実務的に参考になる。

```ts
// app/utils/auth.server.test.ts:83-109
describe('timeout handling', () => {
    // normally we'd use fake timers for a test like this, but there's an issue
    // with AbortSignal.timeout() and fake timers: https://github.com/sinonjs/fake-timers/issues/418
    test('checkIsCommonPassword times out after 1 second', async () => {
        consoleWarn.mockImplementation(() => {})
        server.use(
            http.get('https://api.pwnedpasswords.com/range/:prefix', async () => {
                const twoSecondDelay = 2000
                await new Promise((resolve) => setTimeout(resolve, twoSecondDelay))
                return new HttpResponse(/* ... */)
            }),
        )
        const result = await checkIsCommonPassword('testpassword')
        expect(result).toBe(false)
        expect(consoleWarn).toHaveBeenCalledWith('Password check timed out')
    })
})
```

### WebAuthn テストの CDP 連携

パスキーテストは Chrome DevTools Protocol (CDP) で仮想認証器を作成し、登録・認証・削除の全ライフサイクルをテストする。`WebAuthn.credentialAdded` / `WebAuthn.credentialAsserted` イベントを Promise で待機する非同期パターンが特徴的。

```ts
// tests/e2e/passkey.test.ts:5-20
async function setupWebAuthn(page: Page) {
    const client = await page.context().newCDPSession(page)
    await client.send('WebAuthn.enable', { enableUI: true })
    const result = await client.send('WebAuthn.addVirtualAuthenticator', {
        options: {
            protocol: 'ctap2',
            transport: 'usb',
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
        },
    })
    return { client, authenticatorId: result.authenticatorId }
}
```

## パターンカタログ

- **Test Fixture パターン** (分類: テスト設計)
  - 解決する問題: テストのセットアップコードが各テストに分散し、重複と不整合が生じる
  - 適用条件: 複数のテストが共通の前提条件（認証状態、テストデータ）を必要とする場合
  - コード例: `tests/playwright-utils.ts:69-146`（Playwright の `base.extend` による `login` / `insertNewUser` / `prepareGitHubUser` フィクスチャ）
  - 注意点: フィクスチャ内でクリーンアップ処理を必ず実装すること。このリポジトリでは `await use()` 後の行でユーザー削除を行っている

- **Service Stub パターン** (分類: テストダブル)
  - 解決する問題: 外部 API（GitHub OAuth、Have I Been Pwned）への依存がテストの非決定性を生む
  - 適用条件: HTTP ベースの外部サービスに依存する認証フロー
  - コード例: `tests/mocks/github.ts:135-194`（MSW による GitHub OAuth API の完全なスタブ実装）
  - 注意点: `passthroughGitHub` フラグでモックと実際の API を切り替えられる設計にすると、手動テスト時に実際の OAuth フローを確認できる

## Good Patterns

- **Cookie 直接注入による認証バイパス**: E2E テストで UI ログインをスキップし、DB にセッションを作成して Cookie を直接注入する。テスト実行速度の大幅な改善と、認証 UI 変更による非認証テストの破壊を防止する。
  ```ts
  // tests/playwright-utils.ts:96-115
  const session = await prisma.session.create({
      data: { expirationDate: getSessionExpirationDate(), userId: user.id },
      select: { id: true },
  })
  const authSession = await authSessionStorage.getSession()
  authSession.set(sessionKey, session.id)
  const cookieConfig = setCookieParser.parseString(
      await authSessionStorage.commitSession(authSession),
  )
  await page.context().addCookies([{ ...cookieConfig, domain: 'localhost' }])
  ```

- **テストIDベースの OAuth モック分離**: Playwright の `testInfo.testId` をリクエストヘッダに注入し、各テストの OAuth フローを分離する。並列実行時のデータ衝突を防ぎつつ、ファイルベースフィクスチャでプロセス間共有を実現する。
  ```ts
  // tests/playwright-utils.ts:121-125
  await page.route(/\/auth\/github(?!\/callback)/, async (route, request) => {
      const headers = { ...request.headers(), [MOCK_CODE_GITHUB_HEADER]: testInfo.testId }
      await route.continue({ headers })
  })
  ```

- **console.warn/error のデフォルト例外化**: テストセットアップで `console.warn` / `console.error` をスパイし、呼ばれたらテスト失敗にする。意図的に発生させる場合のみ `mockImplementation(() => {})` でオプトアウトする。予期しない警告・エラーの見落としを防止する。
  ```ts
  // tests/setup/setup-test-env.ts:17-37
  consoleError = vi.spyOn(console, 'error')
  consoleError.mockImplementation((...args) => {
      originalConsoleError(...args)
      throw new Error('Console error was called. Call consoleError.mockImplementation(() => {}) if this is expected.')
  })
  ```

## Anti-Patterns / 注意点

- **E2E テストでの毎回 UI ログイン**: 認証テスト以外のテストで毎回 UI ログインフォームを操作すると、テスト時間が数倍になり、ログイン UI の変更で無関係なテストが壊れる。
  ```ts
  // Bad: E2E テストで毎回 UI 操作でログイン
  test('ノートを作成できる', async ({ page }) => {
      await page.goto('/login')
      await page.fill('[name=username]', 'user')
      await page.fill('[name=password]', 'pass')
      await page.click('button[type=submit]')
      // ここからが本来のテスト...
  })

  // Better: Cookie 直接注入フィクスチャでバイパス
  test('ノートを作成できる', async ({ page, login }) => {
      await login()
      // すぐに本来のテスト開始
  })
  ```

- **OAuth モックでのハードコードされたコード値**: テストごとに固有の OAuth コードを使わないと、並列実行時にテスト間でデータが混在する。
  ```ts
  // Bad: 全テストで同じ OAuth コードを使う
  const request = await setupRequest({ code: 'fixed-code' })

  // Better: テスト固有のIDをコードとして使う
  const request = await setupRequest({ code: testInfo.testId })
  ```

- **セキュリティ API テストでの正常系のみの検証**: パスワード漏洩チェックのような外部 API は障害時にユーザーをブロックしてはならない。異常系（タイムアウト、500、不正レスポンス）で安全側にフォールバックすることを必ずテストすべき。

## 導出ルール

- `[MUST]` E2E テストの認証セットアップでは、UI ログインではなく DB + Cookie 直接注入を使い、認証テスト自体以外で UI ログインフローに依存しない
  - 根拠: epic-stack の全 E2E テスト（notes, 2fa, passkey）が `login` フィクスチャで Cookie 直接注入を使い、onboarding テストのみが UI ログインフローをテストしている（`tests/playwright-utils.ts:91-118`）

- `[MUST]` フォールセーフな外部 API（パスワード漏洩チェック等）は、タイムアウト・サーバーエラー・不正レスポンスの全異常系で安全側（false / デフォルト値）にフォールバックすることをテストする
  - 根拠: `auth.server.test.ts` が正常系2件 + 異常系3件（500、不正フォーマット、タイムアウト）を全て検証し、全異常系で `false` を期待している

- `[SHOULD]` 認証結果のアサーションは、Set-Cookie パース → セッション復号 → DB 照合の一連の検証をカスタムマッチャーに集約する
  - 根拠: `toHaveSessionForUser` マッチャーにより、OAuth コールバックテスト8件が `await expect(response).toHaveSessionForUser(userId)` のワンライナーで検証できている（`tests/setup/custom-matchers.ts:79-119`）

- `[SHOULD]` OAuth テストでは、テストランナーのテストIDをモック用識別子として使い、並列実行時のデータ衝突を防ぐ
  - 根拠: `prepareGitHubUser` が `testInfo.testId` を OAuth コードに使い、ファイルフィクスチャを `VITEST_POOL_ID` で分離している（`tests/playwright-utils.ts:120-145`、`tests/mocks/github.ts:13-19`）

- `[SHOULD]` テスト環境では `console.warn` / `console.error` をデフォルトで例外にし、意図的な呼び出しのみオプトアウトする
  - 根拠: `setup-test-env.ts` で全テストに適用され、`auth.server.test.ts` のタイムアウトテストが `consoleWarn.mockImplementation(() => {})` で明示的にオプトアウトしている

- `[AVOID]` E2E テストと統合テストで OAuth モックを共有しようとすること — E2E はプロセス間共有（ファイルベース）、統合テストはインプロセス（MSW）と、テスト層に応じたモック戦略を選択すべき
  - 根拠: epic-stack は MSW ハンドラを両層で共有しつつ、E2E 層ではファイルベースフィクスチャ、統合テスト層では直接的なローダー呼び出しという異なる戦略を採用している

## 適用チェックリスト

- [ ] E2E テスト用の認証バイパスフィクスチャ（DB セッション作成 + Cookie 直接注入）を実装しているか
- [ ] 認証テスト以外の E2E テストが UI ログインフローに依存していないか
- [ ] OAuth モックがテストごとに固有の識別子（テストID等）を使い、並列実行で衝突しないか
- [ ] 外部セキュリティ API のテストが異常系（タイムアウト、サーバーエラー、不正レスポンス）を網羅しているか
- [ ] 認証結果のアサーションがカスタムマッチャーに集約され、テストの可読性が確保されているか
- [ ] テスト環境で console.warn / console.error がデフォルトで例外化され、予期しない警告を検知できるか
- [ ] E2E テストのモックデータがプロセス間で共有可能な永続化方式（ファイル等）を使っているか
- [ ] フィクスチャにクリーンアップ処理が実装され、テスト後のデータ残存を防いでいるか
