# test-fixture-patterns

> リポジトリ: epicweb-dev/epic-stack
> 分析日: 2026-02-18

## 概要

Playwright の `test.extend` によるフィクスチャ設計と Vitest の `setupFiles` / `globalSetup` によるテスト環境構成パターンを比較分析する。Epic Stack は E2E テストと単体/統合テストで明確に異なるフィクスチャ戦略を採用しており、Playwright 側はテストごとの宣言的な依存注入（use コールバックによるセットアップ/ティアダウン）、Vitest 側はプロセスレベルの環境構成（DB コピー、MSW 起動、console スパイ）という対照的な設計が見られる。この二層構造は「テストの粒度に応じてフィクスチャの管理単位を変える」という汎用原則を体現している。

## 背景にある原則

- **リソースのライフサイクルをテストの粒度に合わせる**: E2E テストではユーザー単位のリソース（DB レコード、Cookie、モックユーザー）が各テストで必要なため、`test.extend` のテストごとのセットアップ/ティアダウンが適合する。一方、Vitest のプロセスレベルのリソース（DB ファイル、MSW サーバー）はワーカープール単位で管理する方が効率的である。根拠: `db-setup.ts` が `VITEST_POOL_ID` でファイルを分離し、`beforeEach` で base DB をコピーしている（`tests/setup/db-setup.ts:6-23`）

- **暗黙のグローバル状態より明示的な依存宣言を優先する**: Playwright フィクスチャはテスト関数のパラメータとして依存を宣言するため、そのテストが何を必要としているかがシグネチャから読み取れる。Vitest のセットアップファイルは暗黙的にグローバル環境を構成する（MSW、DB、console スパイ）ため、何が利用可能かはファイルを追う必要がある。根拠: `test('Users can create notes', async ({ page, navigate, login }) => {` のように必要なフィクスチャが引数に現れる（`tests/e2e/notes.test.ts:5`）

- **ティアダウンの自動化でテスト間の汚染を防ぐ**: フィクスチャ内でリソース作成とクリーンアップを対にすることで、テスト作成者がクリーンアップを忘れるリスクを排除する。根拠: `insertNewUser` フィクスチャが `use()` の後に `prisma.user.delete` を自動実行する（`tests/playwright-utils.ts:82-89`）

- **テスト環境の差し替えは Vite プラグインレベルで行う**: モジュール解決の段階でテスト用スタブに差し替えることで、プロダクションコードに条件分岐を入れずにテスト時の挙動を変える。根拠: `cacheServerStubPlugin` が `cache.server.ts` のインポートを `tests/mocks/cache-server.ts` にリダイレクトしている（`vite.config.ts:16-26`）

## 実例と分析

### Playwright: test.extend による宣言的フィクスチャ

Epic Stack の E2E テストは `tests/playwright-utils.ts` で4つのフィクスチャを定義し、全テストファイルから共有している。各フィクスチャは Playwright の `use()` コールバックパターンに従い、セットアップ→テスト実行→ティアダウンの3フェーズを1つの関数内に閉じ込めている。

```typescript
// tests/playwright-utils.ts:82-89
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

このパターンの特徴は:

1. `use()` 呼び出しの**前**がセットアップフェーズ
2. `use()` に渡した関数がテスト内でフィクスチャ値として使われる
3. `use()` 呼び出しの**後**がティアダウンフェーズ（テスト成否に関わらず実行）

`login` フィクスチャはさらに `page` フィクスチャに依存しており、ブラウザコンテキストに Cookie を注入する。フィクスチャ間の依存関係を Playwright が自動解決する点も重要である。

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

### Playwright: フィクスチャの階層的拡張

`onboarding.test.ts` はベースフィクスチャをさらに拡張し、テストファイル固有のフィクスチャを追加している。この「基盤フィクスチャ + ファイル固有フィクスチャ」の階層化は、共通部分の再利用と特殊ケースの分離を両立する。

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

`base` を再エクスポートの `test` からインポートし、ローカルで `test` を再定義することで、このファイル内のテストだけが `getOnboardingData` を使えるようになる。

### Vitest: 多層セットアップファイルによる環境構成

Vitest 側のセットアップは3つの層に分かれている:

**Layer 1: globalSetup（プロセス起動時に1回）**

```typescript
// tests/setup/global-setup.ts:12-38
export async function setup() {
  const databaseExists = await fsExtra.pathExists(BASE_DATABASE_PATH);
  if (databaseExists) {
    const databaseLastModifiedAt = (await fsExtra.stat(BASE_DATABASE_PATH)).mtime;
    const prismaSchemaLastModifiedAt = (
      await fsExtra.stat("./prisma/schema.prisma")
    ).mtime;
    if (prismaSchemaLastModifiedAt < databaseLastModifiedAt) {
      return;
    }
  }
  await execaCommand(
    "npx prisma migrate reset --force --skip-seed --skip-generate",
    { stdio: "inherit", env: { ...process.env, DATABASE_URL: `file:${BASE_DATABASE_PATH}` } },
  );
}
```

base DB のタイムスタンプと Prisma スキーマのタイムスタンプを比較し、不要なマイグレーションをスキップする最適化が入っている。

**Layer 2: setupFiles — DB per worker pool**

```typescript
// tests/setup/db-setup.ts:1-31
const poolId = process.env.VITEST_POOL_ID || "0";
const databaseFile = `./tests/prisma/data.${poolId}.db`;
const databasePath = path.join(process.cwd(), databaseFile);
process.env.DATABASE_URL = `file:${databasePath}`;

beforeEach(async () => {
  await fsExtra.copyFile(BASE_DATABASE_PATH, databasePath);
});

afterAll(async () => {
  const { prisma } = await import("#app/utils/db.server.ts");
  await prisma.$disconnect();
  await fsExtra.remove(databasePath);
});
```

`VITEST_POOL_ID` による DB 分離は、並列ワーカー間の DB 競合を防ぐ。`beforeEach` でベース DB をコピーすることで、各テストが clean state から始まる。

**Layer 3: setupFiles — テスト環境グローバル設定**

```typescript
// tests/setup/setup-test-env.ts:1-37
import "./db-setup.ts";
// we need these to be imported first

afterEach(() => server.resetHandlers());
afterEach(() => cleanup());

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

### Vitest: カスタムマッチャーによるドメイン固有アサーション

`tests/setup/custom-matchers.ts` は `expect.extend` でドメイン固有のマッチャー（`toHaveRedirect`, `toHaveSessionForUser`, `toSendToast`）を定義している。これは Vitest の setupFiles 経由で全テストに注入される。

```typescript
// tests/setup/custom-matchers.ts:15-78
expect.extend({
  toHaveRedirect(response: unknown, redirectTo?: string) {
    if (!(response instanceof Response)) {
      throw new Error("toHaveRedirect must be called with a Response");
    }
    const location = response.headers.get("location");
    // ...URL比較ロジック
  },
  async toHaveSessionForUser(response: Response, userId: string) {
    const setCookies = response.headers.getSetCookie();
    // ...セッションCookie検証ロジック
  },
});
```

TypeScript の型拡張も同ファイルに記述されており、`vitest` モジュールの `Assertion` インターフェースを拡張することで型安全なカスタムマッチャーを実現している。

```typescript
// tests/setup/custom-matchers.ts:160-169
interface CustomMatchers<R = unknown> {
  toHaveRedirect(redirectTo: string | null): R;
  toHaveSessionForUser(userId: string): Promise<R>;
  toSendToast(toast: ToastInput): Promise<R>;
}

declare module "vitest" {
  interface Assertion<T = any> extends CustomMatchers<T> {}
  interface AsymmetricMatchersContaining extends CustomMatchers {}
}
```

### Vitest: console スパイによる意図しないエラーの検出

`setup-test-env.ts` は `console.error` / `console.warn` をスパイし、呼ばれたら例外をスローする。テスト内で意図的にエラーを発生させる場合は `consoleError.mockImplementation(() => {})` で明示的にオプトアウトする。これにより「テスト内の予期しないエラーを見逃さない」安全策が組み込まれている。

```typescript
// app/utils/misc.error-message.test.ts:17-18
// 意図的なエラーテストでのオプトアウト
consoleError.mockImplementation(() => {});
expect(getErrorMessage(undefined)).toBe("Unknown Error");
```

### Vite プラグインによるモジュール差し替え

`vite.config.ts` の `cacheServerStubPlugin` は、テスト時にキャッシュモジュールを Map ベースのインメモリ実装に差し替える。この手法は `vi.mock` よりも上位レベルで動作し、モジュールグラフ全体に影響する。

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

## パターンカタログ

- **Template Method パターンの変形** (分類: 振る舞い)
  - 解決する問題: テストごとにセットアップ/ティアダウンのライフサイクルを統一しつつ、具体的な振る舞いを差し替え可能にする
  - 適用条件: Playwright の `use()` コールバックパターン。フレームワークが「前処理→本体→後処理」の骨格を定義し、テスト作成者は `use()` 前後にコードを配置する
  - コード例: `tests/playwright-utils.ts:82-89`
  - 注意点: `use()` に渡す値が関数（遅延評価）かオブジェクト（即座に利用可能）かで設計が変わる

- **Decorator パターン** (分類: 構造)
  - 解決する問題: 基盤フィクスチャを変更せずにテストファイル固有のフィクスチャを追加する
  - 適用条件: `base.extend()` で基盤を拡張するケース
  - コード例: `tests/e2e/onboarding.test.ts:27-46`
  - 注意点: 拡張の連鎖が深くなると依存関係が追いにくくなる

## Good Patterns

- **use() コールバックによるリソースの確実な解放**: `insertNewUser` と `login` フィクスチャは、`use()` の後に必ず DB レコードを削除する。テストが成功/失敗いずれの場合もクリーンアップが保証される。Go の `defer` や Python のコンテキストマネージャと同等の安全性を、テストフィクスチャのレベルで実現している。

```typescript
// tests/playwright-utils.ts:82-89
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

- **DB ファイルコピーによるテスト分離**: globalSetup で base DB を1回だけ作成し、各テストの beforeEach でコピーする。マイグレーション実行が1回で済み、ワーカーごとの並列実行も DB ファイルパスの分離で安全に行える。

```typescript
// tests/setup/db-setup.ts:6-8
const poolId = process.env.VITEST_POOL_ID || "0";
const databaseFile = `./tests/prisma/data.${poolId}.db`;
const databasePath = path.join(process.cwd(), databaseFile);
```

- **console スパイのデフォルト拒否 + 明示的オプトイン**: `console.error` がテスト中に呼ばれたらデフォルトで例外をスローする設計。意図的にエラーを発生させるテストでは `consoleError.mockImplementation(() => {})` と1行書くだけでオプトアウトできる。予期しないエラーの見逃しを防ぎつつ、必要な場合の柔軟性も保つ。

```typescript
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

- **型安全なナビゲーションフィクスチャ**: `navigate` フィクスチャは react-router の `href()` 型を利用し、テスト内のページ遷移を型安全にしている。存在しないルートへの遷移がコンパイル時に検出される。

```typescript
// tests/playwright-utils.ts:77-81
navigate: async ({ page }, use) => {
    await use((...args) => {
        return page.goto(href(...args))
    })
},
```

## Anti-Patterns / 注意点

- **セットアップファイルの import 順序への暗黙の依存**: `setup-test-env.ts` は先頭で `import './db-setup.ts'` を行い、コメントで「we need these to be imported first」と記している。DB の `DATABASE_URL` 設定が Prisma のインポートより先に行われる必要があるため。この暗黙の順序依存はリファクタリング時に壊れやすい。

```typescript
// Bad: import順序に暗黙の依存
import "./db-setup.ts";
import "#app/utils/env.server.ts";
// we need these to be imported first

// Better: dynamic importで順序を明示的に制御
await import("./db-setup.ts");
const { prisma } = await import("#app/utils/db.server.ts");
```

実際に `db-setup.ts` の `afterAll` では dynamic import が使われており（`tests/setup/db-setup.ts:28`）、この問題を認識した上での設計判断であることがわかる。

- **フィクスチャ内でのエラー握りつぶし**: `insertNewUser` のティアダウンで `.catch(() => {})` を使っている。テスト中にユーザーが既に削除されている場合のエラーを無視する意図だが、DB 接続エラーなど別の問題も隠す可能性がある。

```typescript
// Bad: 全エラーを握りつぶす
await prisma.user.delete({ where: { id: userId } }).catch(() => {});

// Better: 期待するエラーのみ無視する
await prisma.user.delete({ where: { id: userId } }).catch((e) => {
  if (e.code !== "P2025") throw e; // P2025 = Record not found
});
```

## 導出ルール

- `[MUST]` テストフィクスチャのセットアップとティアダウンは同一スコープ内で対にする（Playwright の use() コールバック、Go の defer、Python の contextmanager 等）
  - 根拠: Epic Stack の全 Playwright フィクスチャが use() 前後でリソース管理を完結させており、8つの E2E テストファイルすべてでリーク無しの安定動作を実現している（`tests/playwright-utils.ts:82-145`）

- `[MUST]` テスト中の予期しない console.error / console.warn はテスト失敗として扱い、意図的なケースのみ明示的にオプトアウトする
  - 根拠: デフォルトで例外をスローする設計により、`callback.test.ts` や `misc.error-message.test.ts` で意図的なエラーテストが `mockImplementation(() => {})` で可視化されている（`tests/setup/setup-test-env.ts:17-36`）

- `[SHOULD]` テスト環境のモジュール差し替えは vi.mock より Vite プラグイン（resolveId）で行い、モジュールグラフ全体に一貫した影響を与える
  - 根拠: `cacheServerStubPlugin` が Vite のモジュール解決レベルでスタブを注入し、テストファイルごとに `vi.mock` を書く手間とバラつきを排除している（`vite.config.ts:16-26`）

- `[SHOULD]` 並列テスト実行時のデータベース分離は、ワーカー ID ベースのファイル/スキーマ分離で行う
  - 根拠: `VITEST_POOL_ID` による DB ファイル分離（`data.${poolId}.db`）が並列ワーカー間の競合を防いでいる（`tests/setup/db-setup.ts:6-8`）

- `[SHOULD]` E2E テストのフィクスチャは「基盤フィクスチャ（全テスト共通）+ テストファイル固有フィクスチャ」の2層構造にし、共通化と特殊化を分離する
  - 根拠: `playwright-utils.ts` の4つの基盤フィクスチャに対して、`onboarding.test.ts` が `base.extend` で `getOnboardingData` を追加している（`tests/e2e/onboarding.test.ts:27-46`）

- `[SHOULD]` ドメイン固有のアサーションは `expect.extend` でカスタムマッチャーとして定義し、型定義も同一ファイルに置く
  - 根拠: `toHaveRedirect`, `toHaveSessionForUser`, `toSendToast` の3つのカスタムマッチャーが `custom-matchers.ts` に型定義と共に集約されている（`tests/setup/custom-matchers.ts:15-169`）

- `[AVOID]` setupFiles 間で import 順序に暗黙の依存を持たせる（環境変数の設定が他のモジュールのインポートより先に必要な場合は dynamic import で順序を明示する）
  - 根拠: `setup-test-env.ts` の先頭コメント「we need these to be imported first」が暗黙の依存を示しており、`db-setup.ts` の `afterAll` では dynamic import で順序を制御している（`tests/setup/db-setup.ts:28`）

## 適用チェックリスト

- [ ] E2E テストで使うリソース（ユーザー、データ）の作成/削除が `use()` コールバックまたは同等のパターンで対になっているか
- [ ] 並列テスト実行時に DB やファイルリソースがワーカー間で衝突しない分離策が入っているか
- [ ] `console.error` / `console.warn` のデフォルト拒否が設定され、意図的なケースが明示的にオプトアウトされているか
- [ ] テスト環境でのモジュール差し替えが個別の `vi.mock` ではなくビルドツールレベルで一元管理されているか
- [ ] Playwright フィクスチャが「基盤（共通）+ ファイル固有」の2層に分かれ、不要なフィクスチャがテストに注入されていないか
- [ ] カスタムマッチャーに TypeScript の型定義（module augmentation）が添付されているか
- [ ] globalSetup でのリソース初期化に冪等性があるか（2回実行しても壊れない、スキーマ変更がなければスキップする等）
- [ ] Vitest の setupFiles 間の import 順序が明示的に制御されているか（暗黙の依存がないか）
