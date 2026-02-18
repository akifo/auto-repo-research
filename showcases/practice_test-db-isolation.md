# Practice: test-db-isolation

> 出典: [epicweb-dev/epic-stack](../repos/epicweb-dev/epic-stack/test-infrastructure.md)
> カテゴリ: practice

## 概要

SQLite ファイルコピーと Vitest の `VITEST_POOL_ID` を組み合わせた並列テスト DB 分離パターン。global-setup で base DB を1回だけ生成し、各テストの `beforeEach` でワーカー固有のファイルにコピーすることで、トランザクションロールバックなしにテスト間の完全な分離を実現する。ローカル開発では mtime 比較で再生成をスキップし、CI ではスキーマ+マイグレーションのハッシュでキャッシュする二段構えの最適化も備える。

## 背景・文脈

テストで DB を使う場合、テスト間のデータ汚染は最も厄介な問題の一つである。一般的な解決策はトランザクションロールバック（テストをトランザクションで囲み、終了時にロールバック）だが、並列実行時の競合や、トランザクション内では再現できない振る舞い（DDL、`COMMIT` 後のイベント等）に対処できない。

Epic Stack は SQLite のファイルベース特性を活かし、「マイグレーション済みの base DB ファイルをテストごとにコピーする」というアプローチを採用している。Vitest のワーカープールごとに独立した DB ファイルを持ち、`beforeEach` でコピーし、`afterAll` で削除する。この Copy-on-Test パターンにより、並列実行時のデータ競合を物理ファイルレベルで排除している。

## 実装パターン

全体は3層構造で設計されている。

### 第1層: global-setup -- base DB の生成（1回だけ）

テストスイート全体の開始前に、Prisma マイグレーションでスキーマだけの base DB を作成する。`--skip-seed` でシードデータを入れないのがポイント。テスト固有のデータはテスト自身が生成する。

```ts
// tests/setup/global-setup.ts:1-39
import { execaCommand } from "execa";
import fsExtra from "fs-extra";
import path from "node:path";
import "dotenv/config";
import "#app/utils/env.server.ts";

export const BASE_DATABASE_PATH = path.join(
  process.cwd(),
  `./tests/prisma/base.db`,
);

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

mtime 比較により、`schema.prisma` が変更されていなければマイグレーションをスキップする。ローカル開発でテストを繰り返し実行する際の起動時間を大幅に短縮する仕組みである。

### 第2層: db-setup -- ワーカーごとの DB 分離

各 Vitest ワーカーのセットアップ時に実行される。`VITEST_POOL_ID` を DB ファイル名に埋め込み、ワーカー間の衝突を防ぐ。

```ts
// tests/setup/db-setup.ts:1-31
import fsExtra from "fs-extra";
import path from "node:path";
import { afterAll, beforeEach } from "vitest";
import { BASE_DATABASE_PATH } from "./global-setup.ts";

const poolId = process.env.VITEST_POOL_ID || "0";
const databaseFile = `./tests/prisma/data.${poolId}.db`;
const databasePath = path.join(process.cwd(), databaseFile);
process.env.DATABASE_URL = `file:${databasePath}`;

const cacheDatabasePath = process.env.CACHE_DATABASE_PATH;
if (cacheDatabasePath && cacheDatabasePath !== ":memory:") {
  const parsed = path.parse(cacheDatabasePath);
  const cacheFileName = parsed.ext
    ? `${parsed.name}.${poolId}${parsed.ext}`
    : `${parsed.name}.${poolId}`;
  const cacheDir = parsed.dir || ".";
  process.env.CACHE_DATABASE_PATH = path.join(cacheDir, cacheFileName);
}

beforeEach(async () => {
  await fsExtra.copyFile(BASE_DATABASE_PATH, databasePath);
});

afterAll(async () => {
  // we *must* use dynamic imports here so the process.env.DATABASE_URL is set
  // before prisma is imported and initialized
  const { prisma } = await import("#app/utils/db.server.ts");
  await prisma.$disconnect();
  await fsExtra.remove(databasePath);
});
```

注目すべき設計判断が3つある:

1. **`beforeEach` でコピー**: テスト「ごと」に真っ白な DB を提供する。テスト A が書き込んだデータがテスト B に漏れない
2. **キャッシュ DB も同様に分離**: `CACHE_DATABASE_PATH` にも `poolId` を埋め込み、複数の永続化レイヤーで一貫した分離を適用
3. **`afterAll` で動的インポート**: Prisma クライアントは初回インポート時に `DATABASE_URL` を読む。静的インポートだと環境変数設定前にモジュールが初期化されてしまうため、`await import()` で遅延させる

### 第3層: Vitest 設定での統合

```ts
// vite.config.ts:74-83
test: {
	include: ['./app/**/*.test.{ts,tsx}'],
	setupFiles: ['./tests/setup/setup-test-env.ts'],
	globalSetup: ['./tests/setup/global-setup.ts'],
	restoreMocks: true,
},
```

`globalSetup` はテストスイート全体で1回、`setupFiles` は各テストファイルの実行前に毎回実行される。`setup-test-env.ts` はインポート順で初期化を制御する:

```ts
// tests/setup/setup-test-env.ts:1-4
import "dotenv/config";
import "./db-setup.ts";
import "#app/utils/env.server.ts";
// we need these to be imported first
```

### CI でのキャッシュ戦略

CI 環境では GitHub Actions のキャッシュ機構を使い、スキーマとマイグレーションのファイルハッシュをキーにする:

::: v-pre

```yaml
# .github/workflows/deploy.yml:118-130
- name: Cache Database
  id: db-cache
  uses: actions/cache@v4
  with:
    path: prisma/data.db
    key:
      db-cache-schema_${{ hashFiles('./prisma/schema.prisma')
      }}-migrations_${{ hashFiles('./prisma/migrations/*/migration.sql')
      }}

- name: Seed Database
  if: steps.db-cache.outputs.cache-hit != 'true'
  run: npx prisma migrate reset --force
```

:::

スキーマもマイグレーションも変更されていなければキャッシュがヒットし、数秒~数十秒のシード処理がスキップされる。

## Good Example

### base DB のコピーで各テストが独立した DB を持つ

```ts
// tests/setup/db-setup.ts:6-9, 21-23
const poolId = process.env.VITEST_POOL_ID || "0";
const databaseFile = `./tests/prisma/data.${poolId}.db`;
const databasePath = path.join(process.cwd(), databaseFile);
process.env.DATABASE_URL = `file:${databasePath}`;

beforeEach(async () => {
  await fsExtra.copyFile(BASE_DATABASE_PATH, databasePath);
});
```

- ワーカー間のファイル衝突がない（`poolId` で名前空間を分離）
- テスト間のデータ汚染がない（`beforeEach` で毎回上書き）
- base DB はスキーマのみ（`--skip-seed`）で、テストがシードデータに依存しない
- ファイルコピーはナノ秒単位で完了し、トランザクションロールバックより高速

### mtime 比較によるスキップ最適化

```ts
// tests/setup/global-setup.ts:15-25
if (databaseExists) {
  const databaseLastModifiedAt = (await fsExtra.stat(BASE_DATABASE_PATH))
    .mtime;
  const prismaSchemaLastModifiedAt = (
    await fsExtra.stat("./prisma/schema.prisma")
  ).mtime;

  if (prismaSchemaLastModifiedAt < databaseLastModifiedAt) {
    return; // スキーマ未変更なら再生成不要
  }
}
```

ローカル開発で「コード修正 -> テスト実行」を繰り返す際、スキーマに変更がなければマイグレーションコマンドの実行を丸ごとスキップする。

### 動的インポートによる環境変数の遅延バインド

```ts
// tests/setup/db-setup.ts:25-31
afterAll(async () => {
  // we *must* use dynamic imports here so the process.env.DATABASE_URL is set
  // before prisma is imported and initialized
  const { prisma } = await import("#app/utils/db.server.ts");
  await prisma.$disconnect();
  await fsExtra.remove(databasePath);
});
```

Prisma クライアントは初回ロード時に `DATABASE_URL` を読み取る。`afterAll` のクリーンアップでは、ワーカー固有の `DATABASE_URL` が設定済みの状態でインポートする必要がある。

## Bad Example

### 共有 DB + トランザクションロールバック

```ts
// Bad: 全ワーカーが同じ DB を共有し、テストごとにロールバック
const prisma = new PrismaClient();

beforeEach(async () => {
  await prisma.$executeRaw`BEGIN`;
});

afterEach(async () => {
  await prisma.$executeRaw`ROLLBACK`;
});
```

問題点:

- 並列実行時に複数ワーカーが同じ DB にアクセスし、ロック競合が発生する
- トランザクション内では `PRAGMA` や DDL が期待通り動かない場合がある
- テストが暗黙的にトランザクション内で動いており、本番環境との振る舞いの差異が生まれる

### テーブル全削除によるリセット

```ts
// Bad: テストごとにテーブル内容を全削除
beforeEach(async () => {
  await prisma.session.deleteMany();
  await prisma.connection.deleteMany();
  await prisma.note.deleteMany();
  await prisma.user.deleteMany();
  // テーブルが増えるたびに追加が必要...
});
```

問題点:

- テーブル追加時にクリーンアップコードも更新が必要（ORM の内部テーブルを考慮する必要もある）
- 外部キー制約による削除順序の管理が煩雑
- ファイルコピーより遅い（複数テーブルへの DELETE 文 vs 単一ファイルコピー）

### シードデータに依存するテスト

```ts
// Bad: シードデータの特定ユーザーに依存
test("kody can edit notes", async () => {
  const kody = await prisma.user.findUnique({ where: { username: "kody" } });
  // kody が存在する前提 → シード変更で壊れる
});

// Good: テスト自身がデータを生成
test("users can edit their own notes", async () => {
  const user = createUser();
  await prisma.user.create({ data: { ...user, roles: { connect: { name: "user" } } } });
  // テストに必要なデータは自分で作る
});
```

Epic Stack は `--skip-seed` で base DB を作成し、テストのシードデータ依存を構造的に排除している。

## 適用ガイド

### どのような状況で使うべきか

- **SQLite をテスト DB として使うプロジェクト**: ファイルコピーによる分離はファイルベース DB でのみ有効。PostgreSQL/MySQL の場合は `CREATE DATABASE ... TEMPLATE` やコンテナ分離を検討する
- **Vitest で並列テスト実行するプロジェクト**: `VITEST_POOL_ID` は Vitest 固有だが、Jest の `--shard` や他のテストランナーでも同様のワーカー ID 機構があれば応用可能
- **テスト間のデータ汚染に悩んでいるプロジェクト**: トランザクションロールバックや `deleteMany` で不安定なテストが発生している場合の代替手段

### 導入時の注意点

- **セットアップの実行順序**: `setup-test-env.ts` のインポート順は暗黙的な依存関係を持つ。`dotenv/config` -> `db-setup.ts` -> `env.server.ts` の順序が崩れると、環境変数未設定のまま後続処理が走る
- **動的インポートの必要性**: `afterAll` で Prisma をクリーンアップする際は `await import()` を使う。静的インポートだと `DATABASE_URL` が設定される前にモジュールが初期化されてしまう
- **キャッシュ DB の分離忘れ**: メインの DB だけでなく、キャッシュ用 DB など複数の永続化レイヤーがある場合は全てに `poolId` を適用する必要がある

### カスタマイズポイント

- **mtime 比較の対象拡張**: `schema.prisma` だけでなく、マイグレーションファイルも mtime 比較に含めると、マイグレーション追加時にもスキップが効く。ただし CI ではファイルハッシュベースのキャッシュの方が確実
- **base DB へのシード投入**: Epic Stack は `--skip-seed` だが、全テストで共通の初期データ（ロール定義、マスタデータ等）が必要な場合は base DB にシードを含めてもよい。ただしテストがシードデータの特定レコードに依存しないよう注意
- **PostgreSQL への応用**: ファイルコピーは使えないが、`CREATE DATABASE test_${poolId} TEMPLATE base_db` で類似の戦略が実現可能。テンプレート DB の作成コストはマイグレーション1回分で済む

## 参考

- [repos/epicweb-dev/epic-stack/test-infrastructure.md](../repos/epicweb-dev/epic-stack/test-infrastructure.md) -- テスト基盤の全体設計
- [repos/epicweb-dev/epic-stack/test-data-management.md](../repos/epicweb-dev/epic-stack/test-data-management.md) -- ファクトリ関数とデータ生成
- [repos/epicweb-dev/epic-stack/testing-strategy.md](../repos/epicweb-dev/epic-stack/testing-strategy.md) -- テスト戦略全体像
- [repos/epicweb-dev/epic-stack/ci-cd.md](../repos/epicweb-dev/epic-stack/ci-cd.md) -- CI でのキャッシュ戦略
