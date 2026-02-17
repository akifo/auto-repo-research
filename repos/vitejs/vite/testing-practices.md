# testing-practices

> リポジトリ: vitejs/vite
> 分析日: 2026-02-17

## 概要

Vite のテストアーキテクチャを分析する。Vitest + Playwright を組み合わせた E2E テスト基盤と、playground ディレクトリを活用したインテグレーションテスト手法が中核にある。同一テストスイートを serve モードと build モードの両方で実行する「デュアルモード実行」や、playground アプリを実際の Vite プロジェクトとして起動しブラウザ操作で検証する手法は、ビルドツール・開発サーバー系のプロジェクトに広く応用可能なプラクティスである。

## 背景にある原則

- **テスト対象と同じ実行環境で検証すべき**: ビルドツールの出力はブラウザで実際に動作するかどうかが最終的な品質基準である。Vite は playground アプリを実際に起動し Playwright でブラウザ操作を行うことで、ユニットテストでは検出できない統合的な問題を捕捉する（`playground/vitestSetup.ts:276-334`）。
- **同一テストをモード間で共有し、分岐は最小限にすべき**: Vite は `VITE_TEST_BUILD` 環境変数で serve/build を切り替え、同一テストスイートを両モードで実行する。モード固有の検証は `test.runIf(isBuild)` / `test.runIf(isServe)` で制御し、テストの重複を防ぐ（`vitest.config.e2e.ts:4`, `playground/test-utils.ts:17`）。
- **テストフィクスチャは隔離コピー上で操作すべき**: `vitestGlobalSetup.ts` が playground を `playground-temp/` にコピーしてからテストを実行する。ファイル編集を伴う HMR テスト等がソースを汚染しない設計（`playground/vitestGlobalSetup.ts:19-39`）。
- **ポーリングベースの非同期アサーションで非決定的なタイミングを吸収すべき**: ブラウザの DOM 更新や HMR のモジュール反映はタイミングが不確定であるため、`expect.poll()` を使って一定間隔で条件を再評価する。固定の `sleep` に依存しない（`vitest.config.e2e.ts:37-39`）。

## 実例と分析

### デュアルモードテスト実行アーキテクチャ

Vite のテストスクリプトは3段構成で設計されている。

```
"test": "pnpm test-unit && pnpm test-serve && pnpm test-build"
"test-serve": "vitest run -c vitest.config.e2e.ts"
"test-build": "VITE_TEST_BUILD=1 vitest run -c vitest.config.e2e.ts"
```

`vitest.config.e2e.ts` 内で環境変数に基づきタイムアウトや除外パターンを動的に変更する。

```typescript
// vitest.config.e2e.ts:4-6
const isBuild = !!process.env.VITE_TEST_BUILD
const timeout = process.env.PWDEBUG ? Infinity : process.env.CI ? 50000 : 30000
```

テスト内では `isBuild` / `isServe` フラグで条件分岐する。3つのパターンが使い分けられる。

1. **`if (isBuild) return` で残りをスキップ**: HMR テスト等、serve 専用の検証部分のみスキップ
2. **`test.runIf(isBuild)` / `describe.runIf(isServe)`**: テスト全体をモードで切り替え
3. **期待値をモードで分岐**: 同一テストだがアセットパスの形式が異なる場合等

```typescript
// playground/assets/__tests__/assets.spec.ts:21-23
const assetMatch = isBuild
  ? /\/foo\/bar\/assets\/asset-[-\w]{8}\.png/
  : '/foo/bar/nested/asset.png'
```

### playground-temp による隔離実行

`vitestGlobalSetup.ts` が担う隔離プロセスは以下の通り。

```typescript
// playground/vitestGlobalSetup.ts:19-39
const tempDir = path.resolve(import.meta.dirname, '../playground-temp')
await fs.rm(tempDir, { recursive: true, force: true })
await fs.mkdir(tempDir, { recursive: true })
await fs.cp(path.resolve(import.meta.dirname, '../playground'), tempDir, {
  recursive: true,
  dereference: false,
  filter(file) {
    file = file.replace(/\\/g, '/')
    return !file.includes('__tests__') && !/dist(?:\/|$)/.test(file)
  },
})
```

`__tests__` と `dist` を除外してコピーし、テストコード自身は元の場所から参照する。`vitestSetup.ts` が `testDir` をコピー先に書き換える。

```typescript
// playground/vitestSetup.ts:131-137
testName = slash(testPath).match(/playground\/([\w-]+)\//)?.[1]
testDir = path.dirname(testPath)
if (testName) {
  testDir = path.resolve(workspaceRoot, 'playground-temp', testName)
}
```

### Variant テスト（同一アプリ・異なる設定）

同じ playground アプリに対して異なる Vite 設定で実行する仕組み。`__tests__/` 下にサブフォルダを作り、フォルダ名に対応する `vite.config-{folderName}.js` を自動で読み込む。

```
playground/assets/
├── __tests__/
│   ├── assets.spec.ts           # デフォルト設定
│   ├── encoded-base/
│   │   └── assets-encoded-base.spec.ts  # vite.config-encoded-base.js
│   └── url-base/
│       └── assets-url-base.spec.ts      # vite.config-url-base.js
├── vite.config.js               # デフォルト
├── vite.config-encoded-base.js  # variant: encoded-base
└── vite.config-url-base.js      # variant: url-base
```

`vitestGlobalSetup.ts` がバリアント用のコピーも事前に作成する。

```typescript
// playground/vitestGlobalSetup.ts:41-53
for (const [original, variants] of [
  ['assets', ['encoded-base', 'relative-base', 'runtime-base', 'url-base']],
  ['css', ['lightningcss']],
  ['transform-plugin', ['base']],
] as const) {
  for (const variant of variants) {
    await fs.cp(
      path.resolve(tempDir, original),
      path.resolve(tempDir, `${original}__${variant}`),
      { recursive: true },
    )
  }
}
```

### テスト共有関数による DRY

CSS テストでは `tests.ts` に共通テスト関数を抽出し、デフォルトと LightningCSS バリアントで共有する。

```typescript
// playground/css/__tests__/css.spec.ts
import { tests } from './tests'
tests(false)

// playground/css/__tests__/tests.ts:17
export const tests = (isLightningCSS: boolean) => {
  test('linked css', async () => { /* ... */ })
}
```

### カスタム serve による柔軟なサーバー起動

`vitestSetup.ts` は `__tests__/serve.ts` の存在を自動検出し、カスタムサーバー起動処理を差し込める。SSR テストや CLI テストはこの仕組みを活用する。

```typescript
// playground/vitestSetup.ts:184-199
const testCustomServe = [
  path.resolve(path.dirname(testPath), 'serve.ts'),
  path.resolve(path.dirname(testPath), 'serve.js'),
].find((i) => fs.existsSync(i))
if (testCustomServe) {
  const mod = await import(testCustomServe)
  const serve = mod.serve || mod.default?.serve
  // ...
}
```

SSR の `serve.ts` は Express サーバーを手動で起動する。

```typescript
// playground/ssr/__tests__/serve.ts:12-20
export async function serve(): Promise<{ close(): Promise<void> }> {
  await kill(port)
  const { createServer } = await import(path.resolve(rootDir, 'server.js'))
  const { app, vite } = await createServer(rootDir, hmrPorts.ssr, createInMemoryLogger(serverLogs))
  // ...
}
```

### ブラウザコンソールログの順序検証

HMR テストでは `untilBrowserLogAfter` ヘルパーで「操作 → 期待するログが順番に出力される」を検証する。

```typescript
// playground/hmr/__tests__/hmr.spec.ts:53-67
await untilBrowserLogAfter(
  () => editFile('hmr.ts', (code) =>
    code.replace('const foo = 1', 'const foo = 2'),
  ),
  [
    '>>> vite:beforeUpdate -- update',
    'foo was: 1',
    '(self-accepting 1) foo is now: 2',
    '(self-accepting 2) foo is now: 2',
    '[vite] hot updated: /hmr.ts',
    '>>> vite:afterUpdate -- update',
  ],
  true, // expectOrder: ログの順序も検証
)
```

### ポーリングベースの非同期アサーション

Vitest の `expect.poll()` を活用し、DOM 更新を待つ。固定 sleep ではなくポーリング間隔とタイムアウトで制御する。

```typescript
// playground/optimize-deps/__tests__/optimize-deps.spec.ts:15-17
await expect.poll(() => page.textContent('.cjs button')).toBe('count is 0')
await page.click('.cjs button')
await expect.poll(() => page.textContent('.cjs button')).toBe('count is 1')
```

タイムアウトは CI/ローカルで動的に設定される。

```typescript
// vitest.config.e2e.ts:37-39
expect: {
  poll: { timeout: 50 * (process.env.CI ? 200 : 50) },
},
```

### ユニットテストの分離設計

ユニットテスト（`packages/**/__tests__/`）と E2E テスト（`playground/**/__tests__/`）は別の Vitest 設定で管理される。ユニットテストは `isolate: false` で高速化。

```typescript
// vitest.config.ts:8-15
test: {
  include: ['**/__tests__/**/*.spec.[tj]s'],
  exclude: [
    '**/node_modules/**', '**/dist/**',
    './playground/**/*.*',        // E2E を除外
    './playground-temp/**/*.*',
  ],
  testTimeout: 20000,
  isolate: false,
},
```

### インメモリロガーによるサーバーログの捕捉

`createInMemoryLogger` がサーバーのログ出力を配列に蓄積し、テストからアサーションできるようにする。

```typescript
// playground/vitestSetup.ts:357-387
export function createInMemoryLogger(logs: string[]): Logger {
  const loggedErrors = new WeakSet<Error | RollupError>()
  const logger: Logger = {
    info(msg) { logs.push(msg) },
    warn(msg) { logs.push(msg); logger.hasWarned = true },
    error(msg, opts) { logs.push(msg); /* ... */ },
    // ...
  }
  return logger
}
```

テストでの使用例:

```typescript
// playground/ssr/__tests__/ssr.spec.ts:70-82
test.runIf(isServe)('should restart ssr', async () => {
  editFile('./vite.config.ts', (content) => content)
  await expect.poll(() => {
    expect(serverLogs).toEqual(
      expect.arrayContaining([expect.stringMatching('server restarted')]),
    )
  }).toSatisfy(() => true)
})
```

## パターンカタログ

- **Template Method** (振る舞い)
  - 解決する問題: E2E テストのセットアップ手順（ブラウザ起動・サーバー起動・ページ遷移）を共通化しつつ、テスト固有のサーバー起動処理を差し替えたい
  - 適用条件: 大半のテストは同一のセットアップで動くが、一部が異なるサーバー起動を必要とする
  - コード例: `playground/vitestSetup.ts:184-203`（`serve.ts` の自動検出と差し込み）
  - 注意点: カスタム `serve.ts` を提供する場合、`close()` メソッドを返してリソースリークを防ぐ必要がある

- **Strategy** (振る舞い)
  - 解決する問題: 同一テストを異なる設定（variant）で実行したい
  - 適用条件: テストロジックは同一だが、設定ファイルやベースパスが異なるケース
  - コード例: `playground/css/__tests__/tests.ts:17`（`isLightningCSS` パラメータで動作分岐）
  - 注意点: バリアントが増えすぎると `vitestGlobalSetup.ts` のコピー定義が肥大化する

## Good Patterns

- **editFile + expect.poll の組み合わせ**: ファイルを編集して HMR/再ビルドをトリガーし、ポーリングで DOM 変化を検証する。タイミングに依存しない堅牢な E2E テストパターン。

```typescript
// playground/css/__tests__/tests.ts:36-37
editFile('linked.css', (code) => code.replace('color: blue', 'color: red'))
await expect.poll(() => getColor(linked)).toBe('red')
```

- **ポート番号の集中管理**: テスト用ポート番号を `test-utils.ts` に一元定義し、並列実行時の衝突を防ぐ。

```typescript
// playground/test-utils.ts:22-52
export const ports = {
  cli: 9510,
  'cli-module': 9511,
  json: 9512,
  // ...
}
```

- **エイリアスによるユーティリティインポート**: `~utils` エイリアスでテストユーティリティへのパスを簡潔に保つ。深いディレクトリからの相対パスの煩雑さを解消する。

```typescript
// vitest.config.e2e.ts:11-13
resolve: {
  alias: { '~utils': resolve(import.meta.dirname, './playground/test-utils') },
},
```

- **カスタムスナップショットシリアライザ**: ソースマップのスナップショットテスト用に、パス正規化やタイムスタンプ除去を行うカスタムシリアライザを登録する。環境依存の差異を吸収してスナップショットを安定化する。

```typescript
// playground/vitestSetup.ts:42-58
expect.addSnapshotSerializer({
  serialize(val, config, indentation, depth, refs, printer) {
    const map = { ...val.map }
    // ...パス正規化、visualization リンク生成
  },
  test(val) {
    return typeof val === 'object' && val && val[sourcemapSnapshot]
  },
})
```

## Anti-Patterns / 注意点

- **固定 sleep による非同期待ち**: タイミングに依存した `setTimeout` や `sleep` を使うと CI 環境で不安定になる。

```typescript
// Bad
await new Promise(resolve => setTimeout(resolve, 2000))
expect(await page.textContent('.result')).toBe('updated')

// Better
await expect.poll(() => page.textContent('.result')).toBe('updated')
```

- **テストからソースファイルを直接編集**: playground-temp へのコピー機構を使わずソースを直接変更すると、テスト後にファイルが汚染される。Vite の `editFile` ヘルパーは `testDir`（コピー先）を基準にパスを解決する。

```typescript
// Bad: ソースを直接変更
fs.writeFileSync('/path/to/playground/hmr/hmr.ts', modified)

// Better: editFile ヘルパーを使う（testDir 相対で解決される）
editFile('hmr.ts', (code) => code.replace('foo = 1', 'foo = 2'))
```

- **ハードコードされたポート番号**: テスト内で直接ポート番号を書くと、並列実行時に衝突する。集中管理された `ports` / `hmrPorts` マップを使う。

```typescript
// Bad
const server = app.listen(3000)

// Better
import { ports } from '~utils'
const server = app.listen(ports.ssr)
```

## 導出ルール

- `[MUST]` E2E テストの非同期アサーションにはポーリングベースの検証（`expect.poll` 等）を使い、固定 sleep に依存しない
  - 根拠: Vite は `expect.poll()` を全 playground テストで一貫使用し、CI/ローカル環境差を吸収している（`vitest.config.e2e.ts:37-39`）

- `[MUST]` ファイル編集を伴うテストではソースの隔離コピー上で操作し、テスト完了後に元のソースが汚染されない設計にする
  - 根拠: `vitestGlobalSetup.ts` が playground を `playground-temp/` にコピーし、HMR テスト等のファイル変更がソースに影響しない（`playground/vitestGlobalSetup.ts:19-39`）

- `[SHOULD]` 同一テストスイートを複数のモード（dev/build 等）で実行する場合、環境変数によるモード切り替え + テスト内条件分岐で実現し、テストコードの重複を最小化する
  - 根拠: Vite は `VITE_TEST_BUILD` 1つで serve/build を切り替え、テスト内は `isBuild` / `test.runIf` で分岐する（`package.json:27-28`）

- `[SHOULD]` テスト用ポート番号は集中管理ファイルで一元定義し、並列実行時の衝突を防ぐ
  - 根拠: `playground/test-utils.ts:22-52` で全 playground のポートを一箇所で管理している

- `[SHOULD]` E2E テストの共通セットアップは globalSetup / setupFiles に集約し、個別テストにはカスタムフック（serve.ts 等）の差し込みポイントを提供する
  - 根拠: `vitestSetup.ts` が共通の beforeAll を提供しつつ、`serve.ts` の存在で動作を切り替える Template Method パターンを採用（`playground/vitestSetup.ts:184-203`）

- `[SHOULD]` サーバーのログ出力はインメモリロガーで捕捉し、テストから警告・エラーの発生有無を検証する
  - 根拠: `createInMemoryLogger` が全テストでサーバーログを配列に蓄積し、副作用の検証を可能にしている（`playground/vitestSetup.ts:357-387`）

- `[AVOID]` ユニットテストと E2E テストを同一の Vitest 設定で混在させない。設定ファイルを分離し、テスト種別ごとに適切なタイムアウト・隔離設定を適用する
  - 根拠: Vite は `vitest.config.ts`（ユニット、`isolate: false`）と `vitest.config.e2e.ts`（E2E、長いタイムアウト）を完全に分離している

## 適用チェックリスト

- [ ] E2E テスト専用の Vitest 設定ファイル（`vitest.config.e2e.ts` 等）を作成し、ユニットテストと分離しているか
- [ ] テスト用フィクスチャのファイル変更がソースコードを汚染しない隔離機構（コピー先ディレクトリ）を導入しているか
- [ ] ブラウザの DOM 更新待ちに `expect.poll()` 等のポーリングアサーションを使用し、固定 sleep を排除しているか
- [ ] テスト用ポート番号を一元管理するファイルを作成し、並列テスト時の衝突を防止しているか
- [ ] 複数モード（dev/build/preview 等）で同一テストを実行する仕組みを整備し、テストコードの重複を最小化しているか
- [ ] サーバーログをインメモリで捕捉し、警告やエラーの発生をテストで検証しているか
- [ ] テストの共通セットアップに、テスト固有のカスタマイズポイント（カスタム serve 等）を提供しているか
- [ ] バリアントテスト（同一アプリ・異なる設定）の仕組みを、設定の組み合わせ爆発に対応できる形で整備しているか
