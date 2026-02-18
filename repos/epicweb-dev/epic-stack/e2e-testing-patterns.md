# E2E テストパターン

> リポジトリ: epicweb-dev/epic-stack
> 分析日: 2026-02-18

## 概要

Epic Stack の E2E テストは Playwright のカスタムフィクスチャ機構を中心に設計されており、認証バイパス・テストデータのライフサイクル管理・外部 OAuth モックを統一的なパターンで実現している。注目すべきは、UI ログインをスキップして Cookie を直接注入する認証フィクスチャと、`test.extend` の `use()` コールバック前後でセットアップ/ティアダウンを対称的に記述する設計である。8つの E2E テストファイルがすべて共通フィクスチャ層 (`playwright-utils.ts`) を経由しており、テスト本体にインフラコードが漏れない構造が一貫して維持されている。

## 背景にある原則

- **認証はテストの前提条件であり、テスト対象ではない**: ログイン済み状態が必要なテストでは UI を経由せず、DB にセッションを作成して Cookie をブラウザコンテキストに注入する。これにより認証フロー自体のテスト（onboarding.test.ts）と、認証済み状態を前提としたテスト（notes.test.ts, 2fa.test.ts 等）が明確に分離される。根拠: `login` フィクスチャ（`tests/playwright-utils.ts:91-118`）が DB + Cookie 操作のみで UI を一切触らない設計。

- **テストデータは作成者が責任を持って削除する（所有権原則）**: 各フィクスチャがティアダウンでデータを削除し、テスト間の副作用を排除する。`insertNewUser` は `use()` の後で `prisma.user.delete` を呼び、`prepareGitHubUser` は DB ユーザーと GitHub モックユーザーの両方を削除する。根拠: `tests/playwright-utils.ts:82-89`、`tests/playwright-utils.ts:136-144`。

- **テストインフラはフィクスチャに集約し、テスト本体は意図だけを表現する**: `test.extend` で定義されたフィクスチャが認証・データ生成・ルーティング・外部サービスモックを隠蔽し、テスト本体はビジネスロジックの検証に集中できる。テストファイル間で `prisma` の直接呼び出しが散在しないよう、共通操作はフィクスチャ化されている。根拠: 8つの E2E テストすべてが `#tests/playwright-utils.ts` からインポートし、テスト固有のフィクスチャも同じ `test.extend` パターンで追加している（`onboarding.test.ts:27-46`）。

- **外部サービスのモックは「テスト→アプリ」の境界で注入する**: GitHub OAuth のモックは Playwright の `page.route()` でリクエストヘッダーを書き換え、アプリ側の `handleMockAction` がそのヘッダーを読み取ってモックコードを使う二段構え。テスト側はブラウザレイヤーのみ操作し、サーバー側は MSW + ファイルベースのフィクスチャでモックする。根拠: `tests/playwright-utils.ts:120-127` と `app/utils/providers/github.server.ts:134-157`。

## 実例と分析

### カスタムフィクスチャの階層構造

Epic Stack のテストは Playwright の `test.extend` を二段階で活用している。

**第1層: 共通フィクスチャ** (`tests/playwright-utils.ts`) では `navigate`、`insertNewUser`、`login`、`prepareGitHubUser` の4つを定義。すべての E2E テストがこの `test` をインポートする。

**第2層: テスト固有フィクスチャ** はテストファイル内で第1層の `test` をさらに拡張する。`onboarding.test.ts` では `getOnboardingData` フィクスチャを追加し、ユーザーデータ生成とティアダウンをカプセル化している。

```typescript
// tests/e2e/onboarding.test.ts:27-46
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

この階層構造により、共通の認証・ナビゲーション機能はグローバルに共有しつつ、特定テスト群にのみ必要なセットアップを局所的に追加できる。

### Cookie 直接注入による認証バイパス

`login` フィクスチャは以下の手順で認証済み状態を構築する:

1. DB にユーザーを作成（または既存ユーザーを取得）
2. DB にセッションレコードを作成
3. サーバー側の `authSessionStorage` を使って Cookie 値を生成
4. `set-cookie-parser` で Cookie を解析し、ブラウザコンテキストに注入

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

重要なのは、Cookie 生成にアプリ本体の `authSessionStorage` と `sessionKey` を再利用している点である。テスト用の独自 Cookie 生成ロジックではなく、プロダクションコードと同じパスを通ることで、セッション形式の変更が自動的にテストにも反映される。

### 型安全なナビゲーション

`navigate` フィクスチャは react-router の `href()` 関数を活用し、ルートパスとパラメータの組み合わせを型レベルで保証する。

```typescript
// tests/playwright-utils.ts:69-81
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

テストでは `navigate('/users/:username/notes', { username: user.username })` のように記述し、存在しないルートやパラメータ不足がコンパイル時に検出される。`page.goto('/users/${user.username}/notes')` のような文字列テンプレートによるハードコードを排除している。

### GitHub OAuth モックの二層構造

GitHub OAuth テストでは、テスト側とサーバー側の2箇所で協調的にモックが動作する。

**テスト側** (`prepareGitHubUser` フィクスチャ): Playwright の `page.route()` で `/auth/github` へのリクエストにカスタムヘッダー `x-mock-code-github` を注入する。値は `testInfo.testId` で、テストごとにユニークである。

```typescript
// tests/playwright-utils.ts:120-127
prepareGitHubUser: async ({ page }, use, testInfo) => {
    await page.route(/\/auth\/github(?!\/callback)/, async (route, request) => {
        const headers = {
            ...request.headers(),
            [MOCK_CODE_GITHUB_HEADER]: testInfo.testId,
        }
        await route.continue({ headers })
    })
```

**サーバー側** (`app/utils/providers/github.server.ts:134-157`): `handleMockAction` がヘッダーからモックコードを読み取り、OAuth リダイレクトをシミュレートする。MSW がトークン交換やユーザー情報の取得をインターセプトし、ファイルベースのフィクスチャから対応するユーザーデータを返す。

この設計により、E2E テストが実際のブラウザリダイレクトフロー（`/auth/github` → `/auth/github/callback`）を通過しながらも、外部 GitHub API には一切アクセスしない。

### テストデータのユニーク性保証

`tests/db-utils.ts` では `UniqueEnforcer` を使ってテスト間でのユーザー名衝突を防止する。

```typescript
// tests/db-utils.ts:1-6
import { faker } from "@faker-js/faker";
import { UniqueEnforcer } from "enforce-unique";

const uniqueUsernameEnforcer = new UniqueEnforcer();
```

faker の `internet.username()` はデフォルトで衝突する可能性があるため、`enforce-unique` ライブラリがコールバックを再試行してユニーク値を保証する。さらにランダムな2文字のプレフィックスを付与することで衝突確率を下げている。

### WebAuthn テストにおけるブラウザ API モック

`passkey.test.ts` では Chrome DevTools Protocol (CDP) を直接使って仮想認証器を作成する。これはフィクスチャではなくヘルパー関数として実装されている。

```typescript
// tests/e2e/passkey.test.ts:5-20
async function setupWebAuthn(page: Page) {
  const client = await page.context().newCDPSession(page);
  await client.send("WebAuthn.enable", { enableUI: true });
  const result = await client.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "usb",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { client, authenticatorId: result.authenticatorId };
}
```

CDP セッションを通じて資格情報の登録・認証イベントを Promise で待機し、テストのタイミング制御をイベント駆動で行っている（`client.once('WebAuthn.credentialAdded', ...)` 等）。

### 非同期メール受信のポーリング

`waitFor` ユーティリティはメール送信のような非同期の副作用を待機するために使われる。

```typescript
// tests/playwright-utils.ts:156-175
export async function waitFor<ReturnValue>(
  cb: () => ReturnValue | Promise<ReturnValue>,
  {
    errorMessage,
    timeout = 5000,
  }: { errorMessage?: string; timeout?: number; } = {},
) {
  const endTime = Date.now() + timeout;
  let lastError: unknown = new Error(errorMessage);
  while (Date.now() < endTime) {
    try {
      const response = await cb();
      if (response) return response;
    } catch (e: unknown) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw lastError;
}
```

`settings-profile.test.ts:106` では `waitFor(() => readEmail(newEmailAddress))` のように使われ、メール配信の非同期性をポーリングで吸収する。Playwright 組み込みの `waitForResponse` などでは対応できないサーバーサイド副作用に対応するための汎用パターンである。

## コード例

```typescript
// tests/e2e/notes.test.ts:5-17 — login フィクスチャと型安全ナビゲーションの典型的な利用
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
// tests/playwright-utils.ts:82-89 — セットアップ/ティアダウンの対称パターン
insertNewUser: async ({}, use) => {
    let userId: string | undefined = undefined
    await use(async (options) => {
        const user = await getOrInsertUser(options)
        userId = user.id
        return user
    })
    await prisma.user.delete({ where: { id: userId } }).catch(() => {})
},
```

```typescript
// tests/e2e/passkey.test.ts:41-45 — CDP イベント駆動のタイミング制御
const passkeyRegisteredPromise = new Promise<void>((resolve) => {
  client.once("WebAuthn.credentialAdded", () => resolve());
});
await page.getByRole("button", { name: /register new passkey/i }).click();
await passkeyRegisteredPromise;
```

## パターンカタログ

- **Fixture パターン** (分類: 構造)
  - 解決する問題: テストごとに繰り返される前提条件のセットアップと、テスト後のクリーンアップを一元管理する
  - 適用条件: 複数テストが同じ前提条件（認証済みユーザー、テストデータ等）を必要とする場合
  - コード例: `tests/playwright-utils.ts:69-146`
  - 注意点: フィクスチャの階層が深くなると依存関係の追跡が困難になる。2段階（共通 + テスト固有）程度に留めるのが望ましい

- **Backdoor Authentication パターン** (分類: 振る舞い)
  - 解決する問題: 認証が前提条件に過ぎないテストで、毎回 UI ログインフローを通る時間とフレーク性を排除する
  - 適用条件: テスト対象が認証フロー自体ではなく、認証済み状態を前提とした機能の場合
  - コード例: `tests/playwright-utils.ts:91-118`
  - 注意点: Cookie/セッション形式の変更時にバイパスロジックの更新が必要。プロダクションコードの認証モジュールを再利用することで同期を保つ

- **Test Isolation via Ownership パターン** (分類: 振る舞い)
  - 解決する問題: テスト間のデータ依存・競合を排除し、並列実行を安全にする
  - 適用条件: テストが共有データベースに対してデータを作成・変更する場合
  - コード例: `tests/playwright-utils.ts:82-89`（insertNewUser）、`tests/playwright-utils.ts:136-144`（prepareGitHubUser）
  - 注意点: ティアダウンでの `.catch(() => {})` は「テスト中に既に削除された場合」を許容するための防御。必要以上に広い catch は避ける

## Good Patterns

- **プロダクションコードの認証モジュールを再利用した Cookie 生成**: `login` フィクスチャが `authSessionStorage.getSession()` → `.set()` → `commitSession()` というプロダクションと同じパスを通る。テスト専用の Cookie 生成ロジックを持たないため、セッション形式の変更がテストに自動反映される。

```typescript
// tests/playwright-utils.ts:104-108
const authSession = await authSessionStorage.getSession();
authSession.set(sessionKey, session.id);
const cookieConfig = setCookieParser.parseString(
  await authSessionStorage.commitSession(authSession),
);
```

- **`testInfo.testId` を使った OAuth モックのテスト分離**: 各テストが固有の GitHub ユーザーを持ち、並列実行時にモックデータが競合しない。`testInfo.testId` は Playwright が自動的にユニーク値を付与するため、テスト作者が ID 管理を意識する必要がない。

```typescript
// tests/playwright-utils.ts:120-127
prepareGitHubUser: async ({ page }, use, testInfo) => {
    await page.route(/\/auth\/github(?!\/callback)/, async (route, request) => {
        const headers = {
            ...request.headers(),
            [MOCK_CODE_GITHUB_HEADER]: testInfo.testId,
        }
        await route.continue({ headers })
    })
```

- **ARIA ロールベースのセレクタによる耐久性のあるテスト**: 全テストで `page.getByRole('button', { name: /submit/i })` 等のアクセシビリティセレクタが使われており、CSS クラスや `data-testid` に依存しない。UI リファクタリングに対する耐性が高く、同時にアクセシビリティの暗黙的なテストにもなっている。

```typescript
// tests/e2e/onboarding.test.ts:53-59
await page.getByRole("link", { name: /log in/i }).click();
await expect(page).toHaveURL(`/login`);
const createAccountLink = page.getByRole("link", {
  name: /create an account/i,
});
await createAccountLink.click();
```

## Anti-Patterns / 注意点

- **テストデータの暗黙的な依存**: `onboarding.test.ts` のいくつかのテストでは `prisma` を直接呼び出してユーザーの存在確認やコネクション検証を行っている。フィクスチャ経由のクリーンアップとテスト本体での直接 DB 操作が混在すると、どのレイヤーがデータの整合性を保証しているか不明瞭になる。

```typescript
// Bad: テスト本体で直接 DB 操作とフィクスチャの混在
const user = await prisma.user.create({
    data: { email: normalizeEmail(ghUser.primaryEmail), ... },
})
// この user は prepareGitHubUser のティアダウンで削除される前提

// Better: DB 操作もフィクスチャに含めるか、明示的なクリーンアップを記述
const user = await insertNewUser({
    email: normalizeEmail(ghUser.primaryEmail),
    username: normalizeUsername(ghUser.profile.login),
})
```

- **`page.waitForLoadState('networkidle')` の使用**: `onboarding.test.ts:97` と `onboarding.test.ts:182` で `networkidle` を使っている。Playwright 公式ドキュメントでも非推奨とされる手法で、特に SPA では不安定なタイミングを生む可能性がある。

```typescript
// Bad: networkidle は SPA で不安定
await page.waitForLoadState("networkidle");
await page.getByLabel(/terms/i).check();

// Better: 特定の要素の可視性を待機する
await expect(page.getByLabel(/terms/i)).toBeEnabled();
await page.getByLabel(/terms/i).check();
```

## 導出ルール

- `[MUST]` E2E テストの認証フィクスチャでは、プロダクションコードのセッション生成ロジックを再利用して Cookie を作成する。テスト専用の認証ロジックを別途実装するとセッション形式の変更時に乖離が生じる
  - 根拠: `tests/playwright-utils.ts:104-108` が `authSessionStorage` と `sessionKey` をアプリ本体からインポートして使用

- `[MUST]` テストデータを作成するフィクスチャは、同じフィクスチャ内にティアダウンを持ち、作成したデータを削除する。`use()` の前がセットアップ、後がティアダウンとして対称的に記述する
  - 根拠: `insertNewUser`（`tests/playwright-utils.ts:82-89`）、`login`（同:91-118）、`prepareGitHubUser`（同:120-145）すべてが `use()` 後に削除処理を実装

- `[SHOULD]` 認証が前提条件に過ぎないテストでは UI ログインをバイパスし、DB + Cookie 注入で認証状態を構築する。認証フロー自体のテストとは明確に分離する
  - 根拠: `notes.test.ts`、`2fa.test.ts`、`settings-profile.test.ts` 等は `login` フィクスチャで即座に認証済み状態を得ており、onboarding.test.ts だけが UI 経由のログインフローをテストしている

- `[SHOULD]` E2E テストのセレクタは CSS クラスや `data-testid` ではなく ARIA ロール（`getByRole`）を優先する。アクセシビリティの暗黙的検証になり、UI リファクタリングへの耐性も高い
  - 根拠: 8つの E2E テストすべてで `getByRole`、`getByLabel`、`getByText` が一貫して使われている

- `[SHOULD]` 外部 OAuth プロバイダのテストでは、テストごとにユニークな識別子（テスト ID 等）でモックユーザーを分離し、並列実行時のデータ競合を防止する
  - 根拠: `prepareGitHubUser` が `testInfo.testId` をヘッダーに注入し（`tests/playwright-utils.ts:124`）、テストごとに独立した GitHub モックユーザーを確保

- `[SHOULD]` テスト共通のフィクスチャは `test.extend` で定義し、テスト固有のフィクスチャは同じパターンで共通フィクスチャを拡張する。フィクスチャ階層は2段階までに抑える
  - 根拠: 共通フィクスチャ（`tests/playwright-utils.ts`）とテスト固有フィクスチャ（`onboarding.test.ts:27-46`）の2層で全テストを構成

- `[AVOID]` `page.waitForLoadState('networkidle')` を E2E テストのタイミング制御に使う。SPA では完全な network idle が保証されず、フレーク性の原因になる。特定の要素の状態（`toBeVisible`、`toBeEnabled` 等）を待機する
  - 根拠: `onboarding.test.ts:97` で使用されているが、Playwright 公式でも非推奨。SPA のバックグラウンドリクエスト（analytics、prefetch 等）で idle にならないケースがある

## 適用チェックリスト

- [ ] 認証が前提条件のテストで、UI ログインではなく Cookie/セッション直接注入のフィクスチャを用意しているか
- [ ] フィクスチャの `use()` 前後でセットアップ/ティアダウンが対称的に記述されているか
- [ ] テストデータの作成と削除が同一フィクスチャ内で完結しているか（所有権原則）
- [ ] 外部 OAuth プロバイダのテストで、テストごとにユニークなモックユーザーを使い分けているか
- [ ] E2E テストのセレクタが ARIA ロールベース（`getByRole` 等）で記述されているか
- [ ] テスト共通のインフラ（認証・ナビゲーション・データ生成）がフィクスチャに集約され、テスト本体はビジネスロジックの検証に集中しているか
- [ ] `networkidle` や固定 `setTimeout` ではなく、要素の状態変化を待機しているか
- [ ] faker 等でのテストデータ生成にユニーク性保証の仕組み（UniqueEnforcer 等）を導入しているか
