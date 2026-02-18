# E2E フィクスチャ合成: test.extend による宣言的フィクスチャ設計

> 出典: repos/epicweb-dev/epic-stack
> カテゴリ: pattern

## 概要

Playwright の `test.extend` を使い、認証バイパス・テストデータ管理・外部サービスモック・型安全ナビゲーションを宣言的なフィクスチャとして合成するパターン。`use()` コールバックの前後にセットアップ/ティアダウンを対称的に配置することで、テストデータのライフサイクルをフィクスチャ内に閉じ込め、テスト本体をビジネスロジックの検証に集中させる。共通フィクスチャ層とテスト固有フィクスチャ層の2段階拡張により、再利用性と局所的なカスタマイズを両立する。

## 背景・文脈

[epicweb-dev/epic-stack](https://github.com/epicweb-dev/epic-stack) は、Remix (React Router v7) ベースのフルスタックアプリケーションテンプレートである。認証（パスワード・OAuth・2FA・パスキー）、ノート CRUD、プロフィール管理など複数の機能を持ち、8つの E2E テストファイルがすべて共通のフィクスチャ層 (`tests/playwright-utils.ts`) を経由している。

E2E テストでは「認証済み状態」が大半のテストの前提条件となるが、毎回 UI ログインフォームを操作すると、テスト速度の低下とログイン UI 変更による無関係なテストの破壊を招く。Epic Stack はこの問題を、DB にセッションを直接作成し Cookie をブラウザコンテキストに注入するフィクスチャで解決している。

## 実装パターン

### 1. use() コールバックによるセットアップ/ティアダウンの対称構造

`use()` の前がセットアップ、後がティアダウン。テスト成否に関わらずティアダウンが実行される。Go の `defer` や Python のコンテキストマネージャと同等のリソース安全性をテストフィクスチャで実現する。

```typescript
// tests/playwright-utils.ts:82-89
insertNewUser: async ({}, use) => {
    let userId: string | undefined = undefined
    await use(async (options) => {
        const user = await getOrInsertUser(options)
        userId = user.id
        return user
    })
    // ティアダウン: テスト終了後に自動削除
    await prisma.user.delete({ where: { id: userId } }).catch(() => {})
},
```

### 2. Cookie 直接注入による認証バイパス

`login` フィクスチャは UI を一切操作せず、DB にセッションレコードを作成し、プロダクションコードの `authSessionStorage` を再利用して Cookie を生成・注入する。セッション形式の変更がテストに自動反映される点が重要である。

```typescript
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

### 3. 型安全ナビゲーション

react-router の `href()` 関数を活用し、ルートパスとパラメータの組み合わせを型レベルで保証する。存在しないルートやパラメータ不足がコンパイル時に検出される。

```typescript
// tests/playwright-utils.ts:67-81
export type AppPages = keyof Register['pages']

export const test = base.extend<{
    navigate: <Path extends AppPages>(
        ...args: Parameters<typeof href<Path>>
    ) => Promise<null | Response>
}>({
    navigate: async ({ page }, use) => {
        await use((...args) => {
            return page.goto(href(...args))
        })
    },
```

### 4. OAuth モックのヘッダーインジェクション

`prepareGitHubUser` は `page.route()` でリクエストヘッダーに `testInfo.testId` を注入し、サーバー側がテストごとに固有のモックユーザーを返す仕組みを構築する。並列実行時のデータ衝突を防止する。

```typescript
// tests/playwright-utils.ts:120-144
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

    // ティアダウン: DB ユーザーとモックデータの両方を削除
    const user = await prisma.user.findUnique({
        select: { id: true, name: true },
        where: { email: normalizeEmail(ghUser!.primaryEmail) },
    })
    if (user) {
        await prisma.user.delete({ where: { id: user.id } })
        await prisma.session.deleteMany({ where: { userId: user.id } })
    }
    await deleteGitHubUser(ghUser!.primaryEmail)
},
```

### 5. 2層フィクスチャ: 共通 + テスト固有の拡張

共通フィクスチャ (`playwright-utils.ts`) をベースとし、テストファイル内で `base.extend` で固有フィクスチャを追加する。

```typescript
// tests/e2e/onboarding.test.ts:17-46
import { test as base } from "#tests/playwright-utils.ts";

const test = base.extend<{
  getOnboardingData(): {
    username: string;
    name: string;
    email: string;
    password: string;
  };
}>({
  getOnboardingData: async ({}, use) => {
    const userData = createUser();
    await use(() => {
      const onboardingData = {
        ...userData,
        password: faker.internet.password(),
      };
      return onboardingData;
    });
    await prisma.user.deleteMany({ where: { username: userData.username } });
  },
});
```

## Good Example

フィクスチャがインフラを隠蔽し、テスト本体はビジネスロジックの検証だけに集中している。

```typescript
// tests/e2e/notes.test.ts:5-18
test("Users can create notes", async ({ page, navigate, login }) => {
  const user = await login();
  await navigate("/users/:username/notes", { username: user.username });

  const newNote = createNote();
  await page.getByRole("link", { name: /New Note/i }).click();

  await page.getByRole("textbox", { name: /title/i }).fill(newNote.title);
  await page.getByRole("textbox", { name: /content/i }).fill(newNote.content);

  await page.getByRole("button", { name: /submit/i }).click();
  await expect(page).toHaveURL(new RegExp(`/users/${user.username}/notes/.*`));
});
```

```typescript
// tests/e2e/2fa.test.ts:5-12
// login フィクスチャにパスワードを渡すだけで認証済み状態を構築
test("Users can add 2FA to their account and use it when logging in", async ({ page, navigate, login }) => {
  const password = faker.internet.password();
  const user = await login({ password });
  await navigate("/settings/profile");
  // ... 2FA 有効化のテスト本体
});
```

```typescript
// tests/e2e/onboarding.test.ts:147-152
// prepareGitHubUser フィクスチャで OAuth モックを自動セットアップ
test("completes onboarding after GitHub OAuth", async ({ page, navigate, prepareGitHubUser }) => {
  const ghUser = await prepareGitHubUser();
  await navigate("/signup");
  await page.getByRole("button", { name: /signup with github/i }).click();
  // ... OAuth オンボーディングのテスト本体
});
```

## Bad Example

フィクスチャを使わず、テスト本体にインフラコードが漏れている例。

```typescript
// Bad: 毎回 UI ログインを実行し、クリーンアップも手動
test("Users can create notes", async ({ page }) => {
  // 認証: テスト本体に UI ログインが混在
  await page.goto("/login");
  await page.fill("[name=username]", "testuser");
  await page.fill("[name=password]", "testpassword");
  await page.click("button[type=submit]");
  await page.waitForURL("/");

  // ナビゲーション: ハードコードされた URL（型安全性なし）
  await page.goto(`/users/testuser/notes`);

  // テスト本体
  await page.getByRole("link", { name: /New Note/i }).click();
  // ...

  // クリーンアップ忘れ: テストデータが残留し、他テストに影響
});
```

```typescript
// Bad: セットアップとティアダウンが分離し、クリーンアップ漏れのリスク
let testUserId: string

test.beforeEach(async () => {
    const user = await prisma.user.create({ data: { ... } })
    testUserId = user.id
})

test.afterEach(async () => {
    // テスト失敗時にここに到達しない可能性がある
    // また、どのテストがこのユーザーを必要としているか不明
    await prisma.user.delete({ where: { id: testUserId } })
})

test('test A', async ({ page }) => { /* testUserId を使う */ })
test('test B', async ({ page }) => { /* testUserId を使わないが削除される */ })
```

## 適用ガイド

### どのような状況で使うべきか

- 複数の E2E テストが同じ前提条件（認証済みユーザー、テストデータ）を必要とする場合
- 認証が大半のテストの前提条件であり、UI ログインの繰り返しがボトルネックになっている場合
- 外部 OAuth プロバイダのモックが必要で、並列実行時のデータ分離が課題になっている場合
- テストデータのクリーンアップ忘れによるテスト間の副作用が問題になっている場合

### 導入時の注意点

- **Cookie 生成にはプロダクションコードを再利用する**: テスト専用の Cookie 生成ロジックを作ると、セッション形式の変更時に乖離が生じる。Epic Stack では `authSessionStorage` と `sessionKey` をアプリ本体からインポートして使用している
- **フィクスチャ階層は2段階までに抑える**: 共通フィクスチャ + テスト固有フィクスチャの2層が実用上の上限。3層以上になると依存関係の追跡が困難になる
- **ティアダウンの `.catch(() => {})` は限定的に使う**: テスト中にデータが既に削除されている場合のエラー無視は許容されるが、広範な catch は DB 接続エラーなど別の問題を隠す。可能であれば `catch((e) => { if (e.code !== 'P2025') throw e })` のように期待するエラーのみ無視する
- **テストデータのユニーク性を保証する**: `faker` の生成値は衝突する可能性があるため、`enforce-unique` のような仕組みを導入する（`tests/db-utils.ts:3-5`）

### カスタマイズポイント

- **認証フィクスチャ**: セッション管理の仕組み（JWT、サーバーセッション等）に応じて Cookie 生成ロジックを差し替える
- **ナビゲーションフィクスチャ**: 使用するルーターの型システムに合わせて型パラメータを調整する。react-router 以外（Next.js 等）でも同様の型安全ナビゲーションが構築可能
- **OAuth モックフィクスチャ**: GitHub 以外のプロバイダ（Google、Apple 等）にも同じヘッダーインジェクションパターンを適用できる。`MOCK_CODE_<PROVIDER>_HEADER` の命名規則で拡張する
- **テスト固有フィクスチャ**: `base.extend` で追加するフィクスチャの粒度は「1テストファイル = 1固有フィクスチャセット」が目安

## 参考

- [repos/epicweb-dev/epic-stack/e2e-testing-patterns.md](../repos/epicweb-dev/epic-stack/e2e-testing-patterns.md) -- E2E テストパターン全体の分析
- [repos/epicweb-dev/epic-stack/test-fixture-patterns.md](../repos/epicweb-dev/epic-stack/test-fixture-patterns.md) -- Playwright / Vitest フィクスチャ設計の比較分析
- [repos/epicweb-dev/epic-stack/authentication-testing.md](../repos/epicweb-dev/epic-stack/authentication-testing.md) -- 認証テスト手法の横断分析
