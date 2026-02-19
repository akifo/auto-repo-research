# Workflow: E2E Parallel Isolation

> 出典: [repos/openclaw/openclaw](../repos/openclaw/openclaw/), [repos/epicweb-dev/epic-stack](../repos/epicweb-dev/epic-stack/)
> カテゴリ: workflow

## 概要

E2E テストを並列実行する際、テスト間でデータベース・認証状態・ネットワークポート・外部サービスのモック状態が干渉すると、フレーク（非決定的な失敗）が発生する。本ドキュメントでは、openclaw/openclaw と epicweb-dev/epic-stack の実践から抽出した「物理レベルでの分離」を軸とする並列テスト戦略を整理する。共有リソースにロックをかけるのではなく、リソースそのものをテスト単位・ワーカー単位で複製する設計思想が共通している。

## 背景・文脈

**openclaw/openclaw** は約 700 ユニットテスト + 363 E2E テスト + 10 ライブテストを持つ大規模 TypeScript モノリポである。Vitest の vmForks/forks プールをカスタムスクリプトで動的に切り替え、HOME ディレクトリや認証トークンをテスト環境から完全に隔離する 3 層アーキテクチャを構築している。ワーカー ID ベースの決定論的ポート割り当てによって、並列サーバ起動時のポート衝突も解消している。

**epicweb-dev/epic-stack** は Playwright + Vitest の二層テスト基盤を持ち、SQLite ファイルコピーによるワーカー単位の DB 分離、Playwright フィクスチャによるテスト単位の認証状態分離、`testInfo.testId` による OAuth モックユーザーの分離を実現している。テストデータの作成者がティアダウンの責任も持つ「所有権原則」がフィクスチャ設計全体を貫いている。

## 実装パターン

### 1. データベースの分離: ワーカー単位のファイルコピー

Vitest の `VITEST_POOL_ID` を DB ファイル名に埋め込み、ワーカーごとに物理的に分離された DB を提供する。グローバルセットアップで base DB を 1 回だけ作成し、各テストの `beforeEach` でコピーすることで、テストごとのクリーン状態を保証する。

```typescript
// epicweb-dev/epic-stack — tests/setup/db-setup.ts:6-9
const poolId = process.env.VITEST_POOL_ID || "0";
const databaseFile = `./tests/prisma/data.${poolId}.db`;
const databasePath = path.join(process.cwd(), databaseFile);
process.env.DATABASE_URL = `file:${databasePath}`;
```

```typescript
// epicweb-dev/epic-stack — tests/setup/db-setup.ts:21-23
beforeEach(async () => {
  await fsExtra.copyFile(BASE_DATABASE_PATH, databasePath);
});
```

グローバルセットアップ側ではスキーマの mtime 比較により、変更がなければマイグレーション再実行をスキップする最適化が入っている。

```typescript
// epicweb-dev/epic-stack — tests/setup/global-setup.ts:15-25
if (databaseExists) {
  const databaseLastModifiedAt = (await fsExtra.stat(BASE_DATABASE_PATH)).mtime;
  const prismaSchemaLastModifiedAt = (
    await fsExtra.stat("./prisma/schema.prisma")
  ).mtime;
  if (prismaSchemaLastModifiedAt < databaseLastModifiedAt) {
    return;
  }
}
```

### 2. 認証状態の分離: Cookie 直接注入とテスト単位のユーザー作成

E2E テストでは UI ログインを経由せず、DB にセッションを作成して Cookie をブラウザコンテキストに直接注入する。各テストが専用のユーザーとセッションを持つため、並列実行時に認証状態が干渉しない。

```typescript
// epicweb-dev/epic-stack — tests/playwright-utils.ts:91-118
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
        await page.context().addCookies([{
            ...cookieConfig,
            domain: 'localhost',
            expires: cookieConfig.expires?.getTime(),
            sameSite: cookieConfig.sameSite as 'Strict' | 'Lax' | 'None',
        }])
        return user
    })
    await prisma.user.deleteMany({ where: { id: userId } })
},
```

重要なのは、Cookie 生成にプロダクションコードの `authSessionStorage` を再利用している点である。テスト専用の認証ロジックを持たないため、セッション形式の変更が自動的にテストに反映される。

### 3. 環境変数・ファイルシステムの分離: HOME ディレクトリの隔離

openclaw/openclaw では、テスト環境のグローバルセットアップで HOME を一時ディレクトリに差し替え、API トークンや設定パスをすべて削除する 3 層アーキテクチャを採用している。

```typescript
// openclaw/openclaw — test/setup.ts:171-180
beforeEach(() => {
  setActivePluginRegistry(DEFAULT_PLUGIN_REGISTRY);
});

afterEach(() => {
  // Guard against leaked fake timers across test files/workers.
  if (vi.isFakeTimers()) {
    vi.useRealTimers();
  }
});
```

- **Layer 1**: グローバルセットアップでプラグインレジストリのスタブ注入、フェイクタイマー漏洩検知
- **Layer 2**: テスト環境隔離で HOME, XDG ディレクトリ, 全チャネルトークンを削除（`test/test-env.ts:94-121`）
- **Layer 3**: `withTempHome()` でテストごとに隔離されたホームディレクトリを提供（`test/helpers/temp-home.ts`）

### 4. ネットワークポートの分離: 決定論的ブロック割り当て

OS のフリーポート探索に頼ると、派生ポート（base+1, base+2, ...）の衝突が起きる。ワーカー ID に基づくポート範囲の事前割り当てで解決する。

```typescript
// openclaw/openclaw — src/test-utils/ports.ts:43-78
export async function getDeterministicFreePortBlock(params?: {
  offsets?: number[];
}): Promise<number> {
  const offsets = params?.offsets ?? [0, 1, 2, 3, 4];
  const workerIdRaw = process.env.VITEST_WORKER_ID ?? process.env.VITEST_POOL_ID ?? "";
  const workerId = Number.parseInt(workerIdRaw, 10);
  const rangeSize = 1000;
  const shardCount = 30;
  const base = 30_000 + (Math.abs(shard) % shardCount) * rangeSize;
  // ...ブロック単位でプローブし、派生ポートの衝突を回避
}
```

### 5. 外部サービスモックの分離: テスト ID によるユーザー分離

Playwright の `testInfo.testId` を使い、OAuth モックユーザーをテストごとにユニークにする。モック状態ファイルにもワーカー ID を埋め込んで並列ワーカー間の競合を防ぐ。

```typescript
// epicweb-dev/epic-stack — tests/playwright-utils.ts:120-127
prepareGitHubUser: async ({ page }, use, testInfo) => {
    await page.route(/\/auth\/github(?!\/callback)/, async (route, request) => {
        const headers = {
            ...request.headers(),
            [MOCK_CODE_GITHUB_HEADER]: testInfo.testId,
        }
        await route.continue({ headers })
    })
```

サーバー側の MSW ハンドラがヘッダーからテスト ID を読み取り、対応するモックユーザーデータを返す。モックユーザーデータは `users.${VITEST_POOL_ID}.local.json` に保存され、ワーカー単位でファイルが分離される。

### 6. CI シャーディングとワーカー数の制御

openclaw/openclaw のカスタム並列実行スクリプトは、CI/ローカル/OS 別にワーカー数を動的調整する。

```javascript
// openclaw/openclaw — scripts/test-parallel.mjs:130-150
const maxWorkersForRun = (name) => {
  if (resolvedOverride) return resolvedOverride;
  if (isCI && !isMacOS) return null; // Linux CI: 制限なし
  if (isCI && isMacOS) return 1; // macOS CI: シングル
  if (name === "unit-isolated") return 1;
  if (name === "extensions") return defaultExtensionsWorkers;
  if (name === "gateway") return defaultGatewayWorkers;
  return defaultUnitWorkers;
};
```

経験則として、ワーカー数は 16 を上限とする（`AGENTS.md:89`「Do not set test workers above 16; tried already」）。

## Good Example

### テストデータの所有権原則: フィクスチャ内で作成と削除を対にする

```typescript
// epicweb-dev/epic-stack — tests/playwright-utils.ts:82-89
// Good: use() の前後でリソースのライフサイクルが閉じている
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

テスト成否に関わらずティアダウンが実行されるため、後続テストへのデータ漏洩がない。テスト本体はビジネスロジックの検証に集中できる。

```typescript
// epicweb-dev/epic-stack — tests/e2e/notes.test.ts:5-17
// Good: テスト本体にはインフラコードが一切含まれない
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

### 環境変数の自動復元: vi.stubEnv + unstubEnvs

```typescript
// openclaw/openclaw — vitest.config.ts:23-24
// Good: unstubEnvs でテスト後に自動的に env が復元される
{
  unstubEnvs: true,   // vi.stubEnv() のスコープ漏洩を防止
  unstubGlobals: true, // vi.stubGlobal() のスコープ漏洩を防止
}
```

## Bad Example

### 手動での環境変数スナップショット/リストア

```typescript
// openclaw/openclaw — src/agents/agent-paths.e2e.test.ts:8-33
// Bad: 手動で env を保存・復元するのは漏れやすく、エラーハンドリングも煩雑
const previousStateDir = process.env.OPENCLAW_STATE_DIR;
afterEach(async () => {
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
});

// Good: vi.stubEnv() + unstubEnvs: true で自動復元される
beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempStateDir);
});
```

### OS フリーポートへの依存

```typescript
// Bad: OS のフリーポートを取得するだけでは派生ポートが衝突する
import getPort from "get-port";
const port = await getPort();
// サーバーが port, port+1, port+2 を使う場合、
// 別ワーカーの port+1 が同じ値になる可能性がある

// Good: ワーカー ID ベースのブロック割り当てで派生ポートも含めて予約する
const base = 30_000 + (workerId % shardCount) * rangeSize;
// base 〜 base+rangeSize の範囲が当該ワーカーに専有される
```

### テストファイルごとの個別クリーンアップ

```typescript
// epicweb-dev/epic-stack — tests/e2e/onboarding.test.ts
// Bad: GitHub モックの状態ファイルを各テストファイルの afterEach で個別に削除
afterEach(async () => {
  await deleteGitHubUsers();
});

// Good: setupFiles で一括登録し、テスト作成者がクリーンアップを忘れるリスクを排除
// tests/setup/setup-test-env.ts
afterEach(async () => {
  await deleteGitHubUsers();
});
```

## 適用ガイド

### どのような状況で使うべきか

- E2E テストが 10 件を超え、直列実行では CI 時間が許容範囲を超える場合
- テスト間で「なぜか時々失敗する」フレーク問題が発生している場合
- 複数の外部サービス（OAuth, メール, ストレージ）をモックする必要がある場合

### 分離レイヤーの選択基準

| リソース                | 分離単位           | 手法                                                     |
| ----------------------- | ------------------ | -------------------------------------------------------- |
| データベース            | ワーカー単位       | ファイルコピー（SQLite）またはスキーマ分離（PostgreSQL） |
| 認証状態                | テスト単位         | Cookie 直接注入 + テスト専用ユーザー                     |
| ネットワークポート      | ワーカー単位       | ワーカー ID ベースの決定論的ブロック割り当て             |
| 環境変数                | テスト単位         | `vi.stubEnv()` + `unstubEnvs: true`                      |
| HOME / 設定ディレクトリ | テストスイート単位 | グローバルセットアップで一時ディレクトリに差し替え       |
| 外部サービスモック      | テスト単位         | `testInfo.testId` でモックユーザーを分離                 |

### 導入時の注意点

- **ワーカー数の上限**: 経験的に 16 を超えると安定性が低下する。CI 環境の CPU コア数に応じて上限を設定する
- **DB コピーのコスト**: SQLite のファイルコピーは軽量だが、PostgreSQL ではスキーマ分離やテンプレートDB の方が適切な場合がある
- **フィクスチャ階層の深さ**: 共通フィクスチャ + テストファイル固有の 2 層までに留める。3 層以上は依存関係の追跡が困難になる
- **ティアダウンでの catch**: `.catch(() => {})` で全エラーを握りつぶさず、期待するエラーコード（Prisma の P2025 = Record not found 等）のみ無視する
- **セットアップの import 順序**: 環境変数に依存するモジュールは dynamic import で初期化タイミングを制御する

### カスタマイズポイント

- **PostgreSQL プロジェクト**: ファイルコピーの代わりに `CREATE DATABASE ... TEMPLATE base_test_db` を使い、ワーカーごとのスキーマで分離する
- **Playwright のシャーディング**: `npx playwright test --shard=1/3` で CI ジョブを分割し、各シャード内でさらにワーカー並列実行する
- **テストデータのユニーク性**: `enforce-unique` ライブラリやランダムプレフィックス付与で faker 生成値の衝突を防止する

## 参考

- [repos/openclaw/openclaw/testing-practices.md](../repos/openclaw/openclaw/testing-practices.md) -- テスト分類・環境分離・ポート割り当ての分析
- [repos/epicweb-dev/epic-stack/e2e-testing-patterns.md](../repos/epicweb-dev/epic-stack/e2e-testing-patterns.md) -- Playwright フィクスチャ・認証バイパス・OAuth モックの分析
- [repos/epicweb-dev/epic-stack/test-infrastructure.md](../repos/epicweb-dev/epic-stack/test-infrastructure.md) -- DB 分離・MSW 一元管理・console スパイの分析
- [repos/epicweb-dev/epic-stack/test-fixture-patterns.md](../repos/epicweb-dev/epic-stack/test-fixture-patterns.md) -- Playwright/Vitest フィクスチャの二層構造の分析
