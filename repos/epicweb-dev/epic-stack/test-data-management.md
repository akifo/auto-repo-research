# テストデータ管理

> リポジトリ: epicweb-dev/epic-stack
> 分析日: 2026-02-18

## 概要

Epic Stack はテストデータの生成・分離・クリーンアップにおいて、Vitest（ユニットテスト）と Playwright（E2E テスト）で異なる戦略を採用しつつ、`tests/db-utils.ts` というファクトリ層を共有する設計をとっている。特に注目すべきは、SQLite ファイルコピーによるテストごとの DB 分離、Playwright fixtures による setup/teardown の宣言的管理、そして `UniqueEnforcer` を使ったファクトリレベルの一意性保証である。テストデータのライフサイクル（生成 → 使用 → 破棄）が構造的に管理されており、並列実行時のデータ競合を排除している。

## 背景にある原則

- **テスト分離原則 (Test Isolation Principle)**: 各テストが他のテストの副作用を受けない独立した状態を持つべきである。Epic Stack では Vitest のプールごとに異なる DB ファイル（`data.${poolId}.db`）を使用し、`beforeEach` で base DB をコピーすることで、テスト単位の分離を物理ファイルレベルで実現している（`tests/setup/db-setup.ts:6-8`）。これにより、ロールバックやトランザクション制御なしに完全な分離を達成している。

- **テストデータのファクトリ集約 (Centralized Factory)**: テストデータの生成ロジックはテストファイルに散在させず、専用のファクトリ関数に集約すべきである。`tests/db-utils.ts` の `createUser()` はシード処理（`prisma/seed.ts`）、Vitest テスト、Playwright テストの三者で共有されており、データ形式の一貫性を保証している。

- **クリーンアップの自動化 (Automatic Cleanup)**: テストデータの削除を個々のテストに委ねず、フレームワーク機構で自動化すべきである。Playwright では `test.extend` のフィクスチャ関数が `use()` の後に teardown を実行し（`tests/playwright-utils.ts:82-89`）、Vitest では `afterAll` で DB ファイルごと削除する（`tests/setup/db-setup.ts:25-31`）。

- **遅延生成・オンデマンド原則 (Lazy Generation)**: テストに必要なデータだけをテスト実行時に生成すべきである。base DB はスキーマのみ（シードなし）で作成され（`global-setup.ts:28` の `--skip-seed`）、各テストが自らのデータを `createUser()` や `prisma.*.create()` で生成する。事前にシードデータに依存しないことで、テスト間の暗黙的な結合を排除している。

## 実例と分析

### ファクトリ関数の階層構造

テストデータ生成は3層の抽象度で設計されている。

**第1層: プリミティブファクトリ** (`tests/db-utils.ts`) — faker でデータオブジェクトを生成するが、DB には書き込まない。`createUser()` は `{ username, name, email }` を返し、`createPassword()` はハッシュ化されたパスワードオブジェクトを返す。この層は DB 非依存であり、シードでもテストでも利用可能。

**第2層: DB 操作付きファクトリ** (`tests/playwright-utils.ts` の `getOrInsertUser()`) — 第1層のデータを使い、Prisma で DB に書き込む。ロール付与（`roles: { connect: { name: 'user' } }`）やパスワードハッシュ化など、ドメインの制約を満たした状態で挿入する。

**第3層: テストフィクスチャ** (`tests/playwright-utils.ts` の `test.extend`) — `insertNewUser` や `login` はデータの生成・挿入だけでなく、セッション cookie の設定やクリーンアップまで含む。テストは最も高い抽象度のフィクスチャを呼ぶだけでよい。

### Vitest の DB 分離戦略

Vitest では、テストランナーのワーカープールごとに物理的に異なる SQLite ファイルを使う。これは `VITEST_POOL_ID` 環境変数で識別される。

1. **Global Setup** (`tests/setup/global-setup.ts`): テストスイート全体の開始時に一度だけ実行される。`prisma migrate reset` でスキーマだけの base DB を作成する。ただし mtime 比較により、`schema.prisma` が変更されていなければ再生成をスキップする。
2. **Setup File** (`tests/setup/db-setup.ts`): 各ワーカーのセットアップ時に実行される。`VITEST_POOL_ID` から固有のファイルパス `data.${poolId}.db` を算出し、`process.env.DATABASE_URL` を動的に書き換える。`beforeEach` で base DB をコピーすることで、テストごとに真っ白なデータベースを提供する。
3. **Teardown**: `afterAll` で Prisma 接続を閉じた後、ワーカー固有の DB ファイルを物理削除する。

キャッシュサーバーの DB も同様にプールID付きのパスに分離される（`tests/setup/db-setup.ts:11-19`）。

### Playwright の Fixture パターン

Playwright テストでは、`test.extend` を使ってフィクスチャを定義し、テストデータの生成からクリーンアップまでをカプセル化している。

- **`insertNewUser`**: ユーザーを DB に挿入し、`use()` 後に `prisma.user.delete` で削除する。削除は `.catch(() => {})` でガードされており、テスト中にユーザーが既に削除されていてもエラーにならない。
- **`login`**: ユーザー挿入に加えて、セッションの作成と cookie の設定を行う。テストはログイン済みの状態からスタートできる。teardown は `prisma.user.deleteMany` で行う。
- **`prepareGitHubUser`**: GitHub OAuth モックユーザーを作成し、リクエストインターセプトでテスト固有のコードを注入する。teardown では DB ユーザーと GitHub モックユーザーの両方を削除する。
- **`getOnboardingData`** (onboarding.test.ts 独自): DB 挿入なしのデータ生成フィクスチャ。ユーザーがオンボーディングで作成されるため、teardown で `prisma.user.deleteMany` を実行する。

### GitHub OAuth モックのデータ管理

GitHub ユーザーのモックデータは JSON ファイルベースで管理されている（`tests/mocks/github.ts`）。ファイルパスには `VITEST_POOL_ID` が含まれ、並列実行時の衝突を防ぐ（`users.${poolId}.local.json`）。`insertGitHubUser` で JSON に追記し、`deleteGitHubUser` で個別削除、`deleteGitHubUsers` でファイルごと削除する。この「ファイルベースの仮想データストア」パターンにより、外部 API モック（MSW）のデータソースがテストごとに制御可能になっている。

### メールフィクスチャの管理

MSW で Resend API をモックし、送信されたメールを JSON ファイルとして `tests/fixtures/email/{to}.json` に保存する（`tests/mocks/utils.ts:31-35`）。テストコードは `readEmail(recipient)` で保存されたメールを読み取り、検証コードやリンクを抽出する。ファイルシステムを通信チャネルとして利用することで、非同期の API モックとテストコード間のデータ共有を実現している。

### シードと テストの共通ファクトリ利用

`prisma/seed.ts` はテスト用の `db-utils.ts` からファクトリ関数をインポートしている（`seed.ts:8-9`）。これにより、シードデータとテストデータの生成ロジックが同じファクトリに集約される。ただし seed は `--skip-seed` で base DB には適用されず、開発環境向けの用途に限定されている。

## コード例

```typescript
// tests/db-utils.ts:1-30
// UniqueEnforcer でファクトリレベルの一意性を保証するパターン
import { faker } from "@faker-js/faker";
import { UniqueEnforcer } from "enforce-unique";

const uniqueUsernameEnforcer = new UniqueEnforcer();

export function createUser() {
  const firstName = faker.person.firstName();
  const lastName = faker.person.lastName();

  const username = uniqueUsernameEnforcer
    .enforce(() => {
      return (
        faker.string.alphanumeric({ length: 2 })
        + "_"
        + faker.internet.username({
          firstName: firstName.toLowerCase(),
          lastName: lastName.toLowerCase(),
        })
      );
    })
    .slice(0, 20)
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_");
  return {
    username,
    name: `${firstName} ${lastName}`,
    email: `${username}@example.com`,
  };
}
```

```typescript
// tests/setup/db-setup.ts:1-31
// プールID による DB 分離と beforeEach での base DB コピー
import fsExtra from "fs-extra";
import path from "node:path";
import { afterAll, beforeEach } from "vitest";
import { BASE_DATABASE_PATH } from "./global-setup.ts";

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

```typescript
// tests/playwright-utils.ts:82-89
// Playwright フィクスチャによる自動クリーンアップ
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
// tests/setup/global-setup.ts:12-39
// mtime 比較による base DB の再生成制御
export async function setup() {
  const databaseExists = await fsExtra.pathExists(BASE_DATABASE_PATH);

  if (databaseExists) {
    const databaseLastModifiedAt = (await fsExtra.stat(BASE_DATABASE_PATH))
      .mtime;
    const prismaSchemaLastModifiedAt = (
      await fsExtra.stat("./prisma/schema.prisma")
    ).mtime;

    if (prismaSchemaLastModifiedAt < databaseLastModifiedAt) {
      return;
    }
  }

  await execaCommand(
    "npx prisma migrate reset --force --skip-seed --skip-generate",
    {
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: `file:${BASE_DATABASE_PATH}`,
      },
    },
  );
}
```

```typescript
// tests/mocks/github.ts:13-19
// VITEST_POOL_ID によるフィクスチャファイルの分離
const githubUserFixturePath = path.join(
  here(
    "..",
    "fixtures",
    "github",
    `users.${process.env.VITEST_POOL_ID || 0}.local.json`,
  ),
);
```

```typescript
// tests/e2e/onboarding.test.ts:27-46
// テスト固有フィクスチャの拡張（データ生成のみ、DB 挿入は行わない）
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

## パターンカタログ

- **Template Database パターン** (分類: 生成)
  - 解決する問題: テストごとにマイグレーションを実行するとコストが高く、並列実行時に競合する
  - 適用条件: SQLite やファイルベース DB を使用している場合、またはスキーマ変更が頻繁でないプロジェクト
  - コード例: `tests/setup/global-setup.ts:12-39`, `tests/setup/db-setup.ts:21-23`
  - 注意点: PostgreSQL 等のサーバーベース DB では `CREATE DATABASE ... TEMPLATE` で類似の戦略が可能だが、ファイルコピーは使えない

- **Fixture as Resource Manager パターン** (分類: 振る舞い / RAII の変形)
  - 解決する問題: テストデータのセットアップとクリーンアップが対応していないと、後続テストに影響する
  - 適用条件: Playwright の `test.extend` や類似のフィクスチャ機構が利用可能な場合
  - コード例: `tests/playwright-utils.ts:69-145`
  - 注意点: `use()` 前後でセットアップとティアダウンが対になるため、try-finally と同様のリソース管理が自然に実現される

- **Factory Function パターン** (分類: 生成)
  - 解決する問題: テストデータのハードコーディングは脆く、変更に弱い
  - 適用条件: 複数のテストで同じエンティティの生成が必要な場合
  - コード例: `tests/db-utils.ts:7-30`
  - 注意点: ファクトリが DB に直接書き込む設計（Active Record 風）にすると、テストの柔軟性が下がる。Epic Stack では「データ生成」と「DB 書き込み」を分離している

## Good Patterns

- **UniqueEnforcer によるファクトリレベルの一意性保証**: faker はデフォルトで一意性を保証しない。`enforce-unique` ライブラリの `UniqueEnforcer` を使い、同一テスト実行内で生成される username が必ず一意になるよう保証している。DB のユニーク制約違反によるテスト失敗を未然に防ぐ。

```typescript
// tests/db-utils.ts:5,11-22
const uniqueUsernameEnforcer = new UniqueEnforcer()
const username = uniqueUsernameEnforcer
    .enforce(() => {
        return faker.string.alphanumeric({ length: 2 }) + '_' +
            faker.internet.username({ ... })
    })
    .slice(0, 20)
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
```

- **mtime 比較による base DB 再生成のスキップ**: スキーマが変更されていなければ base DB の再構築をスキップすることで、テスト起動時間を短縮している。CI 環境では毎回クリーンビルドだが、開発中の繰り返し実行を大幅に高速化する。

```typescript
// tests/setup/global-setup.ts:16-24
if (prismaSchemaLastModifiedAt < databaseLastModifiedAt) {
  return; // スキーマ未変更なら再生成不要
}
```

- **フィクスチャの teardown での寛容な削除**: Playwright フィクスチャの teardown で `.catch(() => {})` を付けることで、テスト中にデータが既に削除されたケースでもエラーにならない。テストが途中で失敗した場合のリソースリークも防ぐ。

```typescript
// tests/playwright-utils.ts:89
await prisma.user.delete({ where: { id: userId } }).catch(() => {});
```

- **Prisma の動的インポートによる DATABASE_URL の遅延バインド**: `db-setup.ts` で `process.env.DATABASE_URL` を書き換えた後に Prisma を動的インポートすることで、ワーカー固有の DB パスが確実に適用される。Prisma クライアントは初回インポート時に環境変数を読むため、この順序が重要である。

```typescript
// tests/setup/db-setup.ts:28
const { prisma } = await import("#app/utils/db.server.ts");
```

## Anti-Patterns / 注意点

- **テスト間のシードデータ依存**: シードデータ（kody ユーザーなど）に依存するテストを書くと、シード変更時に大量のテストが壊れる。Epic Stack の base DB はスキーマのみ（`--skip-seed`）で作成され、各テストが自前のデータを生成する。シードデータへの依存は暗黙的な結合であり、テスト分離を破壊する。

```typescript
// Bad: シードデータの特定ユーザーに依存
test("kody can edit notes", async () => {
  const kody = await prisma.user.findUnique({ where: { username: "kody" } });
  // kody が存在する前提 → シード実行順序に依存
});

// Better: テスト自身がデータを生成
test("users can edit notes", async ({ login }) => {
  const user = await login(); // ファクトリで新規ユーザー生成
  // テストに必要なデータは自分で作る
});
```

- **ファクトリ関数内での DB 書き込み混在**: データ生成と DB 操作を同一関数で行うと、「DB に書き込まずにデータだけ欲しい」ケースに対応できない。Epic Stack では `createUser()` は純粋なデータ生成のみを行い、DB 書き込みは呼び出し側の責務としている。

```typescript
// Bad: ファクトリ内で DB に書き込む
function createUser() {
    const data = { username: faker.internet.username() }
    return prisma.user.create({ data })  // 常に DB 操作が発生
}

// Better: データ生成と DB 書き込みを分離
function createUser() {
    return { username: ..., name: ..., email: ... }  // 純粋なデータ生成
}
// DB 書き込みは呼び出し側
await prisma.user.create({ data: { ...createUser(), roles: { connect: ... } } })
```

- **手動クリーンアップの散在**: `afterEach` でテストごとに個別のクリーンアップコードを書くと、漏れが発生しやすい。Playwright のフィクスチャ機構は setup/teardown をペアで宣言するため、クリーンアップ忘れが構造的に起きにくい。

```typescript
// Bad: afterEach で手動管理
let userId: string
beforeEach(async () => { userId = (await createAndInsertUser()).id })
afterEach(async () => { await prisma.user.delete({ where: { id: userId } }) })

// Better: フィクスチャで自動管理
insertNewUser: async ({}, use) => {
    let userId: string | undefined
    await use(async (options) => {
        const user = await getOrInsertUser(options)
        userId = user.id
        return user
    })
    await prisma.user.delete({ where: { id: userId } }).catch(() => {})
},
```

## 導出ルール

- `[MUST]` テストごとに独立した DB 状態を保証する仕組みを導入する（ファイルコピー、トランザクションロールバック、テンプレート DB 等）
  - 根拠: Epic Stack は `beforeEach` で base DB をコピーし、テスト間のデータ汚染を物理的に防いでいる（`tests/setup/db-setup.ts:21-23`）

- `[MUST]` テストデータの生成ロジックはテストファイル内にハードコードせず、共有ファクトリ関数に集約する
  - 根拠: `tests/db-utils.ts` の `createUser()` がシード、Vitest テスト、Playwright テストの全てで共有されており、データ形式の一貫性を担保している

- `[MUST]` faker でユニーク制約のあるフィールドを生成する場合は、一意性保証の仕組みを組み合わせる
  - 根拠: `UniqueEnforcer` により、並列テスト実行でも username の重複が発生しない設計になっている（`tests/db-utils.ts:5,11-22`）

- `[SHOULD]` テストデータのファクトリ関数は「データ生成」と「DB 書き込み」を分離し、純粋なデータ生成関数として設計する
  - 根拠: `createUser()` は DB に書き込まず `{ username, name, email }` を返すだけであり、seed と test の両方で柔軟に利用されている

- `[SHOULD]` テストデータのクリーンアップはフレームワーク機構（フィクスチャ、afterAll）に委ね、セットアップとティアダウンを対で宣言する
  - 根拠: Playwright の `test.extend` は `use()` 前後で setup/teardown を対にし、クリーンアップ漏れを構造的に防いでいる（`tests/playwright-utils.ts:82-89`）

- `[SHOULD]` テスト用 base DB の構築にキャッシュ戦略（mtime 比較等）を導入し、不要な再構築を避ける
  - 根拠: `global-setup.ts` はスキーマの mtime と base DB の mtime を比較し、変更がなければ再構築をスキップして開発ループを高速化している

- `[SHOULD]` 外部 API モックのデータソースを並列テスト間で分離する（プールID やテストID で名前空間を分ける）
  - 根拠: GitHub モックの JSON ファイルは `users.${VITEST_POOL_ID}.local.json` でワーカーごとに分離されている（`tests/mocks/github.ts:18`）

- `[AVOID]` シードデータの特定レコードに依存するテストを書く
  - 根拠: Epic Stack の base DB は `--skip-seed` で作成され、テストがシードデータに依存しない設計を徹底している（`tests/setup/global-setup.ts:28`）

- `[AVOID]` テストの teardown で削除失敗をハードエラーにする（テスト本体で既に削除済みのケースに対応できなくなる）
  - 根拠: `prisma.user.delete({ ... }).catch(() => {})` のように寛容な削除を行い、テスト途中での状態変化に耐える設計になっている（`tests/playwright-utils.ts:89`）

## 適用チェックリスト

- [ ] テストファクトリ関数を専用ファイルに集約し、テストファイルとシードの両方から利用できるようにしているか
- [ ] ファクトリ関数は「データ生成」のみを行い、DB 書き込みは呼び出し側に委ねているか
- [ ] faker でユニーク制約フィールドを生成する箇所に一意性保証（UniqueEnforcer 等）を導入しているか
- [ ] 各テストが独立した DB 状態を持つ仕組み（ファイルコピー / トランザクション / テンプレート DB）があるか
- [ ] テストデータのクリーンアップがフレームワーク機構（フィクスチャ / afterAll / afterEach）で自動化されているか
- [ ] 外部 API モックのデータソースが並列テスト間で分離されているか（ワーカーID による名前空間分割等）
- [ ] base DB やテンプレート DB の構築にキャッシュ戦略を導入し、不要な再構築を避けているか
- [ ] シードデータの特定レコードに依存するテストがないか
- [ ] teardown の削除処理が寛容に設計されているか（既に削除済みのケースでエラーにならないか）
