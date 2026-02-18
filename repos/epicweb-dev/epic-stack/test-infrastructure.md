# テスト基盤の設計

> リポジトリ: epicweb-dev/epic-stack
> 分析日: 2026-02-18

## 概要

Epic Stack のテスト基盤は、Vitest の `globalSetup` / `setupFiles` / `restoreMocks` を組み合わせた多層セットアップアーキテクチャを採用している。特筆すべきは、SQLite ファイルベース DB を Vitest のワーカープール ID で分離する並列テスト戦略、console.error/warn をデフォルトで throw させる「沈黙禁止」ポリシー、そしてドメイン固有のカスタムマッチャーに TypeScript 型拡張を組み合わせたアサーション拡張パターンである。これらは単体では既知のテクニックだが、一貫した設計思想のもとに統合されている点が分析に値する。

## 背景にある原則

- **テストの独立性を物理レベルで保証する**: 各テストワーカーに専用の DB ファイルを割り当て、`beforeEach` でクリーンコピーを作ることで、テスト間のデータ汚染をプロセスレベルで排除している。共有 DB にトランザクションロールバックで対処するアプローチと比較して、並列実行時の競合を根本的に回避する設計判断である（`tests/setup/db-setup.ts:6-9`）。

- **警告を無視しない文化を仕組みで強制する**: console.error/warn をデフォルトで throw に変換することで、「テストは通るが警告が出ている」状態を許容しない。意図的に警告を許容する場合は `consoleError.mockImplementation(() => {})` と明示的にオプトアウトさせ、その判断をコードに残す（`tests/setup/setup-test-env.ts:17-36`）。

- **セットアップの実行コストを最小化する**: グローバルセットアップでスキーマの mtime を比較し、変更がなければ DB 再生成をスキップする。テストの信頼性を維持しつつ、開発サイクルの速度を犠牲にしない設計（`tests/setup/global-setup.ts:15-25`）。

- **テストコードの可読性をドメイン語彙で高める**: `toHaveRedirect`, `toHaveSessionForUser`, `toSendToast` のようなカスタムマッチャーにより、テストが「何を検証しているか」をドメイン用語で表現できる。低レベルの Cookie パース・DB クエリのようなインフラ的関心事をマッチャー内部に隠蔽している（`tests/setup/custom-matchers.ts`）。

## 実例と分析

### セットアップファイルの実行順序と依存チェーン

Vitest の設定により、テスト実行時に以下の順序でセットアップが走る:

1. **`globalSetup`** (`tests/setup/global-setup.ts`): テストスイート全体で1回だけ実行。base DB を Prisma マイグレーションで生成する。
2. **`setupFiles`** (`tests/setup/setup-test-env.ts`): 各テストファイルの実行前に実行される。内部で以下を順序付きインポートで制御:
   - `dotenv/config` -- 環境変数のロード
   - `./db-setup.ts` -- `VITEST_POOL_ID` による DB ファイル分離と `DATABASE_URL` の設定
   - `#app/utils/env.server.ts` -- 環境変数のバリデーション（DB URL が確定した後に実行する必要がある）

この順序は `setup-test-env.ts:1-4` のコメント `// we need these to be imported first` で明示されている。ES Module のトップレベルインポートが記述順に実行される仕様に依存した設計であり、依存関係が暗黙的なため注意が必要である。

### DB 分離のメカニズム

`db-setup.ts` の設計は以下の3段構成である:

1. **ファイル名の分離**: `VITEST_POOL_ID` をファイル名に埋め込む（`data.${poolId}.db`）。Vitest のワーカープール ID は並列実行される各ワーカーに一意に割り当てられる。
2. **テストごとのリセット**: `beforeEach` で base DB をコピーすることで、各テストが同じ初期状態から開始する。
3. **動的インポートによるクリーンアップ**: `afterAll` で Prisma の `$disconnect()` を呼ぶ際、`await import('#app/utils/db.server.ts')` と動的インポートを使う。これは `process.env.DATABASE_URL` がモジュールトップレベルで設定される前に Prisma がインポートされることを防ぐための意図的な選択である（`db-setup.ts:28` のコメント参照）。

キャッシュ DB についても同様に `VITEST_POOL_ID` でファイル名を分離しており（`db-setup.ts:11-19`）、複数の永続化レイヤーがある場合でも一貫した分離戦略が適用されている。

### Vite プラグインによるモジュール差し替え

`vite.config.ts:16-26` の `cacheServerStubPlugin` は、テスト環境でのみ `cache.server.ts` を `tests/mocks/cache-server.ts` にリダイレクトする。Vite の `resolveId` フックを使い、インポートパスの解決段階でモジュールを差し替える。

差し替え先のモックモジュール（`tests/mocks/cache-server.ts`）は、SQLite キャッシュを単純な `Map` に置換しており、テストから外部依存を排除しつつ、同一のインターフェースを維持している。

### MSW によるネットワークモックの一元管理

`tests/mocks/index.ts` で MSW サーバーを集約的にセットアップし、GitHub API、Resend（メール）、Tigris（S3 互換ストレージ）、PwnedPasswords API の4つの外部サービスを一括モックしている。各モックハンドラは `passthroughGitHub` のような条件分岐を持ち、本番の認証情報がある場合は実際の API にパススルーできる設計（`tests/mocks/github.ts:131-133`）。

`onUnhandledRequest` で Sentry や devtools の内部リクエストを明示的に除外し、それ以外の未ハンドルリクエストには警告を出す設計（`tests/mocks/index.ts:16-30`）は、モック漏れの検出に役立つ。

### GitHub モックにおけるファイルベースの状態管理

`tests/mocks/github.ts` では、モックユーザーデータを JSON ファイル（`users.${VITEST_POOL_ID}.local.json`）に永続化している。これは MSW ハンドラが複数のリクエストにわたって状態を共有する必要があるためであり（OAuth フローでは access_token 取得とユーザー情報取得が別リクエスト）、ファイルベースにすることでワーカー間の競合を `VITEST_POOL_ID` で回避している。

## コード例

```ts
// tests/setup/global-setup.ts:12-38
export async function setup() {
	const databaseExists = await fsExtra.pathExists(BASE_DATABASE_PATH)

	if (databaseExists) {
		const databaseLastModifiedAt = (await fsExtra.stat(BASE_DATABASE_PATH))
			.mtime
		const prismaSchemaLastModifiedAt = (
			await fsExtra.stat('./prisma/schema.prisma')
		).mtime

		if (prismaSchemaLastModifiedAt < databaseLastModifiedAt) {
			return
		}
	}

	await execaCommand(
		'npx prisma migrate reset --force --skip-seed --skip-generate',
		{
			stdio: 'inherit',
			env: {
				...process.env,
				DATABASE_URL: `file:${BASE_DATABASE_PATH}`,
			},
		},
	)
}
```

```ts
// tests/setup/db-setup.ts:6-9
const poolId = process.env.VITEST_POOL_ID || '0'
const databaseFile = `./tests/prisma/data.${poolId}.db`
const databasePath = path.join(process.cwd(), databaseFile)
process.env.DATABASE_URL = `file:${databasePath}`
```

```ts
// tests/setup/db-setup.ts:25-31
afterAll(async () => {
	// we *must* use dynamic imports here so the process.env.DATABASE_URL is set
	// before prisma is imported and initialized
	const { prisma } = await import('#app/utils/db.server.ts')
	await prisma.$disconnect()
	await fsExtra.remove(databasePath)
})
```

```ts
// tests/setup/setup-test-env.ts:17-36
beforeEach(() => {
	const originalConsoleError = console.error
	consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(
		(...args: Parameters<typeof console.error>) => {
			originalConsoleError(...args)
			throw new Error(
				'Console error was called. Call consoleError.mockImplementation(() => {}) if this is expected.',
			)
		},
	)
	// ... consoleWarn も同様
})
```

```ts
// tests/setup/custom-matchers.ts:160-169
interface CustomMatchers<R = unknown> {
	toHaveRedirect(redirectTo: string | null): R
	toHaveSessionForUser(userId: string): Promise<R>
	toSendToast(toast: ToastInput): Promise<R>
}

declare module 'vitest' {
	interface Assertion<T = any> extends CustomMatchers<T> {}
	interface AsymmetricMatchersContaining extends CustomMatchers {}
}
```

```ts
// app/utils/misc.error-message.test.ts:16-24
test('undefined falls back to Unknown', () => {
	consoleError.mockImplementation(() => {})
	expect(getErrorMessage(undefined)).toBe('Unknown Error')
	expect(consoleError).toHaveBeenCalledWith(
		'Unable to get error message for error',
		undefined,
	)
	expect(consoleError).toHaveBeenCalledTimes(1)
})
```

## パターンカタログ

- **Template Method** (分類: 振る舞い)
  - 解決する問題: テストごとに DB の初期状態が異なると、テスト結果が非決定的になる
  - 適用条件: ファイルベースの DB（SQLite 等）を使うプロジェクトで、並列テスト実行が必要な場合
  - コード例: `tests/setup/global-setup.ts:12-38`（base DB 生成）+ `tests/setup/db-setup.ts:21-23`（テストごとにコピー）
  - 注意点: base DB はスキーマのスナップショットであり、シード不要（`--skip-seed` フラグ）。テスト固有のデータはテスト内で作成する

- **Module Replacement / Service Stub** (分類: 構造)
  - 解決する問題: テスト時に外部サービス（キャッシュ、API）への依存を排除したい
  - 適用条件: バンドラー（Vite/webpack）のモジュール解決を制御できる環境
  - コード例: `vite.config.ts:16-26`（resolveId でモジュール差し替え）+ `tests/mocks/cache-server.ts`（Map ベースの代替実装）
  - 注意点: 差し替え先モジュールは元のモジュールと同一の export インターフェースを維持する必要がある

## Good Patterns

- **console スパイの「デフォルト禁止 + 明示的許可」パターン**: console.error/warn をデフォルトで throw にし、意図的な場合のみ `mockImplementation(() => {})` でオプトアウトさせる。エラーメッセージに解除方法を含めることで、開発者が初遭遇時に迷わない。

```ts
// tests/setup/setup-test-env.ts:20-27
consoleError.mockImplementation(
  (...args: Parameters<typeof console.error>) => {
    originalConsoleError(...args)
    throw new Error(
      'Console error was called. Call consoleError.mockImplementation(() => {}) if this is expected.',
    )
  },
)
```

テストコードでの使用例（明示的オプトアウト + 呼び出し検証）:

```ts
// app/utils/misc.error-message.test.ts:17-18
consoleError.mockImplementation(() => {})
// ... テスト実行 ...
expect(consoleError).toHaveBeenCalledWith(
  'Unable to get error message for error',
  undefined,
)
```

- **カスタムマッチャーの型拡張による IDE 統合**: `expect.extend()` でカスタムマッチャーを追加する際、`declare module 'vitest'` で `Assertion` と `AsymmetricMatchersContaining` の両インターフェースを拡張する。これにより、`expect(response).toHaveRedirect('/login')` が型チェックと補完の両方で機能する。

```ts
// tests/setup/custom-matchers.ts:160-169
interface CustomMatchers<R = unknown> {
  toHaveRedirect(redirectTo: string | null): R
  toHaveSessionForUser(userId: string): Promise<R>
  toSendToast(toast: ToastInput): Promise<R>
}

declare module 'vitest' {
  interface Assertion<T = any> extends CustomMatchers<T> {}
  interface AsymmetricMatchersContaining extends CustomMatchers {}
}
```

- **mtime 比較によるグローバルセットアップの最適化**: スキーマファイルと DB ファイルの更新日時を比較し、スキーマ未変更なら DB 再生成をスキップする。CI では毎回再生成されるが、ローカル開発では不要な再生成を回避して高速化する。

```ts
// tests/setup/global-setup.ts:15-25
if (databaseExists) {
  const databaseLastModifiedAt = (await fsExtra.stat(BASE_DATABASE_PATH)).mtime
  const prismaSchemaLastModifiedAt = (
    await fsExtra.stat('./prisma/schema.prisma')
  ).mtime
  if (prismaSchemaLastModifiedAt < databaseLastModifiedAt) {
    return
  }
}
```

## Anti-Patterns / 注意点

- **セットアップの暗黙的な順序依存**: `setup-test-env.ts` では ES Module のインポート順に依存してセットアップの実行順序を制御している。コメントで `// we need these to be imported first` と明示されているが、リファクタリング時にインポート順が変わると環境変数未設定のまま後続処理が走るリスクがある。

Bad:
```ts
// インポート順に依存（暗黙的な順序制御）
import 'dotenv/config'
import './db-setup.ts'
import '#app/utils/env.server.ts'
// we need these to be imported first
```

Better:
```ts
// 明示的な初期化関数で順序を制御
async function initTestEnv() {
  await loadDotenv()
  await setupDatabase()
  await validateEnv()
}
```

ただし、Vitest の `setupFiles` はモジュールの副作用による初期化を前提としているため、フレームワークの制約上この形式が実質的な標準である点は考慮が必要。

- **ファイルベース状態管理によるテスト間干渉リスク**: GitHub モックの JSON ファイルに状態を永続化する設計は、`afterEach` でのクリーンアップが漏れた場合にテスト間でデータが残留するリスクがある。`callback.test.ts:28-30` の `afterEach(async () => { await deleteGitHubUsers() })` が必須だが、忘れやすい。

Bad:
```ts
// テストファイルごとに afterEach を書く必要がある
afterEach(async () => {
  await deleteGitHubUsers()
})
```

Better:
```ts
// setupFiles で一括クリーンアップを登録する
// tests/setup/setup-test-env.ts
afterEach(async () => {
  await deleteGitHubUsers()
})
```

## 導出ルール

- `[MUST]` テストの console.error/warn はデフォルトで throw に変換し、意図的な場合のみ明示的にオプトアウトさせる。エラーメッセージに解除方法を含めること
  - 根拠: Epic Stack では console スパイの throw パターンにより、見逃されがちな warning がテスト失敗として即座に検出される。`app/utils/misc.error-message.test.ts:17` や `app/utils/auth.server.test.ts:60` でオプトアウトが実際に使われており、意図的な判断がコードに残る

- `[MUST]` 並列テスト実行時はワーカー ID（Vitest の `VITEST_POOL_ID` 等）をリソース名に組み込み、テストワーカー間でファイル・DB・ポートなどの共有リソースが衝突しないようにする
  - 根拠: `tests/setup/db-setup.ts:6-8` および `tests/mocks/github.ts:18` で、DB ファイルとモック状態ファイルの両方にプール ID を埋め込み、並列実行時のデータ競合を完全に排除している

- `[SHOULD]` グローバルセットアップで生成コストの高いリソース（DB スキーマ等）はソースファイルの mtime を比較し、変更時のみ再生成する
  - 根拠: `tests/setup/global-setup.ts:15-25` でスキーマの mtime と DB ファイルの mtime を比較し、スキーマ未変更時はマイグレーション実行をスキップしている。ローカル開発でのテスト起動時間を大幅に短縮する

- `[SHOULD]` ドメイン固有のアサーション（リダイレクト検証、セッション検証等）はカスタムマッチャーに抽出し、TypeScript の module augmentation で型安全にする。`Assertion` と `AsymmetricMatchersContaining` の両方を拡張すること
  - 根拠: `tests/setup/custom-matchers.ts:15-169` で Cookie パース・DB クエリ・URL 比較といったインフラ的処理をマッチャー内に隠蔽し、テストコードを `expect(response).toHaveRedirect('/login')` のようなドメイン語彙で記述可能にしている

- `[SHOULD]` バンドラーのモジュール解決フックを使い、テスト環境でのみ外部依存を同一インターフェースのスタブモジュールに差し替える
  - 根拠: `vite.config.ts:16-26` の `cacheServerStubPlugin` が `cache.server.ts` を Map ベースの実装に差し替えている。vi.mock() と異なり、インポート元のコード変更が不要で、アプリケーションコードにテストの関心事が漏れない

- `[AVOID]` 環境変数に依存するモジュールのクリーンアップで静的インポートを使うこと。セットアップ中に環境変数を変更する場合、動的インポートを使ってモジュール初期化のタイミングを制御する
  - 根拠: `tests/setup/db-setup.ts:28` のコメント「we *must* use dynamic imports here so the process.env.DATABASE_URL is set before prisma is imported and initialized」が設計意図を明示しており、静的インポートでは環境変数設定前にモジュールが初期化されてしまう

## 適用チェックリスト

- [ ] テストフレームワークの `globalSetup` と `setupFiles` を分離し、「1回だけ」と「各ファイルごと」の初期化を明確に区別しているか
- [ ] 並列テスト実行時のリソース分離戦略があるか（DB ファイル名、ポート番号、一時ファイル等にワーカー ID を含めているか）
- [ ] console.error/warn をデフォルトで throw に設定し、意図的な場合のみオプトアウトする仕組みがあるか
- [ ] テストで頻出するドメイン固有のアサーション（リダイレクト、認証状態、通知等）をカスタムマッチャーに抽出しているか
- [ ] カスタムマッチャーの TypeScript 型拡張で `Assertion` と `AsymmetricMatchersContaining` の両方を拡張しているか
- [ ] グローバルセットアップで生成コストの高いリソースにキャッシュ・スキップ戦略を適用しているか
- [ ] 外部サービスのモック（MSW 等）を一元管理し、未ハンドルリクエストの検出ポリシーを設定しているか
- [ ] テスト用のモジュール差し替えをバンドラーレベルで行い、アプリケーションコードにテストの関心事を漏らしていないか
