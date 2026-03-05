# testing-practices

> リポジトリ: drizzle-team/drizzle-orm
> 分析日: 2026-03-04

## 概要

drizzle-orm は「すべてのテストは統合テスト」という方針を明確に掲げ、モックではなく実データベースに対してクエリを実行する。Docker コンテナをプログラム的に起動し、テスト後に自動削除する仕組みを採用している。型テストはランタイムテストと同一ファイル内でインラインで実行し、型の正しさと振る舞いの正しさを一箇所で保証する。さらに「共通テスト関数のエクスポート」パターンにより、10以上のドライバで同一のテストスイートを再利用しながら、ドライバ固有の差分だけを各テストファイルで扱う設計が注目に値する。

## 背景にある原則

- **ORM テストではモックに意味がない、実 DB こそが真実**: ORM のバグは SQL 生成とドライバの振る舞いの組み合わせで発生する。モックではこの組み合わせを検証できないため、全テストを実 DB に対して実行する。CONTRIBUTING.md にも「All tests for Drizzle ORM are integration tests that simulate real databases」と明記されている。
- **テストの共通化と差分の分離によりドライバ増加に対応する**: 同一の ORM API を複数のドライバで提供する場合、テストケースの重複は保守コストを爆発させる。共通ロジックを関数として切り出し、各ドライバは接続確立とコンテキスト注入のみに責任を持つ構造にすることで、新規ドライバ追加時のテスト作成コストを最小化できる。
- **型テストはランタイムテストと同居させるべき**: 型推論の正しさは API の出力の一部であり、振る舞いテストから分離すると型の退行に気づけない。`Expect<Equal<...>>` や `expectTypeOf` をランタイムテスト内にインラインで記述することで、1つのテストが型と値の両方を検証する。
- **外部依存テストは段階的に除外可能にする**: フォークからの PR では外部 DB サービスの秘密鍵が利用できない。`SKIP_EXTERNAL_DB_TESTS` 環境変数で外部 DB テストを除外可能にし、コントリビューターの参入障壁を下げる。

## 実例と分析

### Docker コンテナのプログラム的管理

各 DB 方言の `*-common.ts` ファイルに `createDockerDB()` 関数が実装されており、`dockerode` ライブラリを使って Docker コンテナを Node.js から直接制御する。Docker Compose ファイルは特殊なケース（Neon WebSocket プロキシ）にのみ使用し、基本的にはプログラム的な制御を選択している。

```typescript
// integration-tests/tests/pg/pg-common.ts:367-392
export async function createDockerDB(): Promise<{ connectionString: string; container: Docker.Container }> {
	const docker = new Docker();
	const port = await getPort({ port: 5432 });
	const image = 'postgres:14';

	const pullStream = await docker.pull(image);
	await new Promise((resolve, reject) =>
		docker.modem.followProgress(pullStream, (err) => (err ? reject(err) : resolve(err)))
	);

	pgContainer = await docker.createContainer({
		Image: image,
		Env: ['POSTGRES_PASSWORD=postgres', 'POSTGRES_USER=postgres', 'POSTGRES_DB=postgres'],
		name: `drizzle-integration-tests-${uuidV4()}`,
		HostConfig: {
			AutoRemove: true,
			PortBindings: {
				'5432/tcp': [{ HostPort: `${port}` }],
			},
		},
	});

	await pgContainer.start();
	return { connectionString: `postgres://postgres:postgres@localhost:${port}/postgres`, container: pgContainer };
}
```

重要な設計判断として、`AutoRemove: true` でコンテナを自動削除し、`getPort` でランダムポートを割り当て、コンテナ名に UUID を含めることで並列実行時のポート衝突とコンテナ名衝突を防いでいる。

### 共通テスト関数のエクスポートパターン

`pg-common.ts`（6,518行）、`mysql-common.ts`（5,480行）、`sqlite-common.ts`（3,963行）は、それぞれの方言の全テストケースを `tests()` 関数としてエクスポートする。各ドライバ固有のテストファイルはこの関数を呼び出すだけでよい。

```typescript
// integration-tests/tests/pg/pg-common.ts:398-399
export function tests() {
	describe('common', () => {

// integration-tests/tests/pg/node-postgres.test.ts:11-12,最後の行
import { createDockerDB, tests, usersMigratorTable, usersTable } from './pg-common';
// ...（接続確立、コンテキスト注入）
tests();

// integration-tests/tests/pg/pglite.test.ts:7-8,最後の行
import { tests, usersMigratorTable, usersTable } from './pg-common';
// ...（PGlite 接続）
tests();
```

同じ `tests()` が `node-postgres.test.ts`、`postgres-js.test.ts`、`pglite.test.ts`、`neon-serverless.test.ts`、`pg-proxy.test.ts` など全 PG ドライバで共有される。

### Vitest TestContext によるドライバ抽象化

Vitest のモジュール拡張で `TestContext` にデータベースインスタンスを注入し、共通テスト関数がドライバを意識せずに動作する仕組みを構築している。

```typescript
// integration-tests/tests/pg/pg-common.ts:100-109
declare module 'vitest' {
	interface TestContext {
		pg: {
			db: PgDatabase<PgQueryResultHKT>;
		};
		neonPg: {
			db: NeonHttpDatabase<typeof schema>;
		};
	}
}

// integration-tests/tests/pg/node-postgres.test.ts:52-56
beforeEach((ctx) => {
	ctx.pg = {
		db,
	};
});
```

共通テストは `ctx.pg.db` を通じてデータベースにアクセスするため、PostgreSQL、MySQL、SQLite いずれの方言でも同じパターンが適用される。

### ドライバ固有テストの skipTests メカニズム

一部のドライバで動作しないテスト（例: better-sqlite3 ではトランザクションロールバックが正しく動作しない）を、名前ベースでスキップする仕組みが用意されている。

```typescript
// integration-tests/tests/common.ts:3-9
export function skipTests(names: string[]) {
	beforeEach((ctx) => {
		if (ctx.task.suite?.name === 'common' && names.includes(ctx.task.name)) {
			ctx.skip();
		}
	});
}

// integration-tests/tests/sqlite/better-sqlite.test.ts:51-59
skipTests([
	'transaction rollback',
	'nested transaction rollback',
]);
tests();
```

### インライン型テスト

型の正しさをランタイムテストと同じテストケース内で検証する。2つの手法が混在している。

```typescript
// integration-tests/tests/pg/pg-common.ts:2460-2468 — Expect<Equal<>> パターン
const result = await db.select({
	id: sql<number>`id`,
	name: sql<string>`name`,
}).from(sql`(select 1 as id, 'John' as name) as users`);

Expect<Equal<{ id: number; name: string }[], typeof result>>;
expect(result).toEqual([{ id: 1, name: 'John' }]);

// integration-tests/tests/pg/pg-common.ts:1765-1768 — expectTypeOf パターン
expectTypeOf(res).toEqualTypeOf<{
	population: number;
	name: string;
}[]>();
```

`Expect` と `Equal` は自前のユーティリティ型で、コンパイル時のみ効果を持つ（ランタイムでは空関数）。

```typescript
// integration-tests/tests/utils.ts:3-6
export function Expect<T extends true>() {}
export type Equal<X, Y extends X> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true
	: false;
```

### 分離された型テスト（NodeNext 互換性）

`type-tests/join-nodenext/` ディレクトリに、`moduleResolution: node16` 環境での型互換性を検証する専用テストが存在する。これは `tsc` のみで検証され、ランタイム実行は不要である。

```typescript
// integration-tests/type-tests/join-nodenext/pg.ts:20-38
const db = drizzle.mock();
(async () => {
	const res = await db.select()
		.from(users)
		.innerJoin(account, eq(users.id, account.id));

	expectTypeOf(res).toEqualTypeOf<{
		accounts: { id: string; userId: string; meta: string; };
		users: { id: string; name: string; username: string; };
	}[]>();
});

// integration-tests/package.json:8
"test:types": "tsc && cd type-tests/join-nodenext && tsc",
```

`drizzle.mock()` でモックインスタンスを生成し、ネットワークなしで型チェックのみを行う設計。`package.json` の `type: "commonjs"` 設定で nodenext 環境をシミュレートしている。

### CI のシャーディング戦略

GitHub Actions でテストをドライバ単位でシャーディングし、マトリクス並列実行を行う。外部 DB サービス（PlanetScale、Neon、Xata 等）はシャードとして分離され、ローカル Docker で完結するテストとは独立にスケジューリングされる。

```yaml
# .github/workflows/release-latest.yaml:26-43
strategy:
  matrix:
    shard:
      - gel
      - planetscale
      - singlestore-core
      - neon-http
      - neon-serverless
      - drizzle-orm
      - drizzle-kit
      - other
```

フォークからの PR では秘密鍵が利用できないため、`SKIP_EXTERNAL_DB_TESTS=1` を設定して外部 DB テストを自動スキップする。

```bash
# .github/workflows/release-feature-branch.yaml:164-165
if [[ ${{ github.event_name }} != "push" && "..." != "..." ]]; then
  export SKIP_EXTERNAL_DB_TESTS=1
fi
```

### 接続リトライパターン

すべてのドライバ固有テストで `async-retry` を使い、Docker コンテナの起動完了を待つ。固定間隔（250ms）で最大20回リトライする統一パターン。

```typescript
// integration-tests/tests/pg/node-postgres.test.ts:29-42
client = await retry(async () => {
	client = new Client(connectionString);
	await client.connect();
	return client;
}, {
	retries: 20,
	factor: 1,
	minTimeout: 250,
	maxTimeout: 250,
	randomize: false,
	onRetry() {
		client?.end();
	},
});
```

### drizzle-kit の PGlite 採用

drizzle-kit のテストでは Docker ではなく PGlite（WebAssembly ベースの PostgreSQL）を使用する。スキーマ差分検出のテストはクエリの振る舞いではなくスキーマのイントロスペクション結果を検証するため、軽量な in-process DB で十分である。

```typescript
// drizzle-kit/tests/introspect/pg.test.ts:46-64
test('basic introspect test', async () => {
	const client = new PGlite();
	const schema = {
		users: pgTable('users', {
			id: integer('id').notNull(),
			email: text('email'),
		}),
	};
	const { statements, sqlStatements } = await introspectPgToFile(
		client, schema, 'basic-introspect',
	);
	expect(statements.length).toBe(0);
	expect(sqlStatements.length).toBe(0);
});
```

### ESM/CJS 互換性テスト

`js-tests/driver-init/` で、CommonJS（`.cjs`）と ES Modules（`.mjs`）の両方からのドライバ初期化を検証する。ほぼ同一のテストコードを2つのモジュール形式で維持し、両方のエコシステムでの動作を保証する。

```javascript
// integration-tests/js-tests/driver-init/commonjs/node-pg.test.cjs:2-3
const { drizzle } = require('drizzle-orm/node-postgres');
const pg = require('pg');

// integration-tests/js-tests/driver-init/module/node-pg.test.mjs:2-3
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
```

## パターンカタログ

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: 複数ドライバで共通のテストロジックを実行しつつ、接続確立とクリーンアップだけをドライバごとに差し替える
  - 適用条件: 同一 API を複数の実装で提供するライブラリ
  - コード例: `pg-common.ts:398`（テンプレート）、`node-postgres.test.ts:52-60`（差し替え部分）
  - 注意点: 共通テストファイルが巨大化しやすい（pg-common.ts は 6,518 行）。機能カテゴリでの分割を検討すべき

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: テスト対象のデータベースインスタンスを実行時に切り替える
  - 適用条件: テストコンテキストを通じてデータベースを注入するケース
  - コード例: Vitest TestContext 拡張（`pg-common.ts:100-109`）と `beforeEach` でのコンテキスト注入
  - 注意点: TypeScript のモジュール拡張に依存するため、型定義の管理が必要

## Good Patterns

- **環境変数フォールバックによる DB ソース切り替え**: テストファイルは `process.env['PG_CONNECTION_STRING']` があればそれを使い、なければ `createDockerDB()` で自動起動する。ローカル開発と CI の両方で同じテストコードが動作する。

```typescript
// integration-tests/tests/pg/node-postgres.test.ts:22-28
if (process.env['PG_CONNECTION_STRING']) {
	connectionString = process.env['PG_CONNECTION_STRING'];
} else {
	const { connectionString: conStr } = await createDockerDB();
	connectionString = conStr;
}
```

- **beforeEach での完全なスキーマ再構築**: 各テスト前にスキーマを DROP CASCADE して再作成する。テスト間の状態汚染を完全に排除し、テスト順序への依存を防ぐ。

```typescript
// integration-tests/tests/pg/pg-common.ts:400-403
beforeEach(async (ctx) => {
	const { db } = ctx.pg;
	await db.execute(sql`drop schema if exists public cascade`);
	await db.execute(sql`create schema public`);
	// ...テーブル作成
});
```

- **コンテナ名に UUID を含めて衝突を防止**: `name: drizzle-integration-tests-${uuidV4()}` により、並列実行やテスト中断後の再実行でコンテナ名が衝突しない。`AutoRemove: true` と組み合わせてゾンビコンテナの蓄積も防ぐ。

- **型テストとランタイムテストの共存**: 同一の `test()` ブロック内で `expect()` と `Expect<Equal<>>` を並べることで、型推論の正しさと実行結果の正しさを同時に検証する。片方だけの退行を見逃さない。

## Anti-Patterns / 注意点

- **共通テストファイルの巨大化**: `pg-common.ts` は 6,518 行に達しており、新しいテストケース追加時の見通しが悪い。機能カテゴリ（CRUD、集約、トランザクション等）での分割が望ましいが、`tests()` 関数のスコープ共有と `beforeEach` の適用範囲を維持するために分割が難しい構造になっている。

```
Bad: 1つの tests() に全テスト (6,518行)
Better: カテゴリ別に tests_crud(), tests_aggregation() 等に分割
```

- **固定タイムアウトによるコンテナ待機**: MySQL と SingleStore で `setTimeout(resolve, 4000)` の固定待機が使われている。ヘルスチェックベースの待機に比べて、遅い環境では不足し、速い環境では無駄な待機が発生する。

```typescript
// Bad: integration-tests/tests/mysql/mysql-common.ts:279
await new Promise((resolve) => setTimeout(resolve, 4000));

// Better: PostgreSQL で使われている retry パターン
client = await retry(async () => {
	client = new Client(connectionString);
	await client.connect();
	return client;
}, { retries: 20, minTimeout: 250 });
```

## 導出ルール

- `[MUST]` マルチドライバ ORM やマルチプロバイダライブラリのテストでは、共通テストロジックを関数としてエクスポートし、ドライバ固有ファイルは接続確立とコンテキスト注入のみに責任を持たせる
  - 根拠: drizzle-orm は pg-common.ts の `tests()` を10以上のドライバ固有テストから呼び出し、6,000超のテストケースの重複を回避している
- `[MUST]` 統合テストでは各テスト前にデータベース状態を完全にリセットする（DROP + 再作成）。テスト間の暗黙の状態共有を排除する
  - 根拠: pg-common.ts の `beforeEach` で `drop schema if exists public cascade` → `create schema public` → テーブル再作成を毎回実行し、テスト順序への依存を防いでいる
- `[SHOULD]` Docker コンテナのプログラム的管理では、ランダムポート割り当て + UUID コンテナ名 + AutoRemove を組み合わせて並列実行安全性を確保する
  - 根拠: `getPort()` + `drizzle-integration-tests-${uuidV4()}` + `AutoRemove: true` の3点セットが全 DB 方言の `createDockerDB()` で採用されている
- `[SHOULD]` 型テスト（推論結果の検証）はランタイムテストと同一ファイル・同一テストケース内にインラインで記述する。型テストを分離すると値の変更に伴う型の退行を見逃す
  - 根拠: pg-common.ts 内で `Expect<Equal<>>` と `expectTypeOf` がランタイム `expect()` と同じ `test()` ブロック内に配置されている
- `[SHOULD]` 統合テストと外部依存テストを環境変数で切り替え可能にし、フォーク PR やオフライン環境でもテストスイートの大部分を実行可能にする
  - 根拠: `SKIP_EXTERNAL_DB_TESTS` 環境変数と vitest.config.ts の条件付き exclude でフォーク PR からの貢献を可能にしている
- `[SHOULD]` スキーマ差分検出やマイグレーション生成など I/O 依存が小さいテストでは、PGlite 等の in-process DB を使って Docker 不要で高速に実行する
  - 根拠: drizzle-kit は PGlite で introspect テストを実行し、drizzle-orm の Docker ベーステストとテスト戦略を使い分けている
- `[AVOID]` Docker コンテナの起動待機に固定 `setTimeout` を使うこと。リトライベースのヘルスチェックを使い、環境差によるフレーキーテストを防ぐ
  - 根拠: PostgreSQL テストは `async-retry` で接続確認リトライを行うが、MySQL テストは `setTimeout(resolve, 4000)` の固定待機に依存しており、遅い CI 環境での失敗リスクがある

## 適用チェックリスト

- [ ] テストスイートが複数のドライバ/プロバイダをサポートする場合、共通テストロジックを関数として切り出し、ドライバ固有ファイルから呼び出す構造にしているか
- [ ] 統合テストで各テストケースの前にデータベース状態を完全にリセットしているか（テスト間の状態依存がないか）
- [ ] Docker コンテナを使う統合テストで、ランダムポート・ユニーク名・自動削除を設定しているか
- [ ] 型推論の正しさをランタイムテストと同じテストケースで検証しているか（型テストが分離されて形骸化していないか）
- [ ] 外部サービス依存のテストを環境変数で除外可能にしているか（CI のフォーク PR やオフライン環境への配慮）
- [ ] テスト対象の特性に応じて DB の重さを使い分けているか（フルテスト→Docker 実 DB、スキーマ検証→in-process DB）
- [ ] コンテナ起動待機がリトライベースになっているか（固定 sleep ではなくヘルスチェック/接続確認）
- [ ] ESM/CJS の両方のモジュール形式でライブラリが正しく動作するか検証しているか
