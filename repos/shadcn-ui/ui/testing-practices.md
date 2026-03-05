# Testing Practices

> リポジトリ: shadcn-ui/ui
> 分析日: 2026-03-04

## 概要

shadcn-ui/ui は CLI ツール（`shadcn`パッケージ）のテスト戦略として、Vitest Workspace による階層的テスト分離、MSW によるレジストリ HTTP モックと実 HTTP サーバーによる統合テストの 2 層構成、そしてフレームワーク別フィクスチャを使ったプロジェクトスキャフォールディングテストを採用している。テスト対象がコンポーネント UI ではなく「CLI ツールとレジストリ API」であるため、ファイルシステム操作とネットワークリクエストのテスト設計に独自の工夫が見られる。

## 背景にある原則

- **テスト境界の明確な分離**: 単体テスト（MSW でネットワークを遮断）と統合テスト（実サーバーを起動して CLI プロセスを実行）を Vitest Workspace で物理的に分離し、テストの実行速度とフィードバック品質を両立させている。根拠: `vitest.workspace.ts` が 2 つの config を束ね、`packages/tests/vitest.config.ts` は `testTimeout: 120000` と長タイムアウトで統合テスト用に調整されている。
- **実プロジェクト構造によるフィクスチャ**: テスト用フィクスチャは「実際のフレームワークプロジェクト構造」を再現する。`packages/tests/fixtures/next-app/`, `vite-app/`, `no-framework/` それぞれが `package.json`, `tsconfig.json` 等を含む完全なプロジェクト。根拠: `createFixtureTestDirectory()` がフィクスチャを一時ディレクトリにコピーし、テストごとに独立した環境を生成する (`helpers.ts:17-27`)。
- **型付きエラークラスによるテスト表現力の向上**: HTTP ステータスコードごとに専用のエラークラス（`RegistryNotFoundError`, `RegistryUnauthorizedError` 等）を定義し、テストで `rejects.toThrow(RegistryNotFoundError)` のように型レベルでエラーを検証する。根拠: `errors.ts` に 13 個のエラークラスが定義され、`fetcher.test.ts` で各ステータスコードに対応するエラークラスが検証されている。
- **インラインスナップショットによる変換テスト**: AST 変換のような入出力が複雑な処理に `toMatchInlineSnapshot()` を多用し、テストファイル内で期待値を直接可視化する。根拠: `transform-icons.test.ts`, `transform-cleanup.test.ts` 等の全変換テストで一貫して採用。

## 実例と分析

### Vitest Workspace によるテスト階層化

ルートの `vitest.workspace.ts` が 2 つの設定ファイルを束ねている。

- **ルート** (`vitest.config.ts`): `fixtures/`, `templates/`, `packages/tests/` を除外。単体テスト用。`vite-tsconfig-paths` でパスエイリアスを解決。
- **統合テスト** (`packages/tests/vitest.config.ts`): `testTimeout: 120000`, `hookTimeout: 120000` の長タイムアウト。`globalSetup` で一時ディレクトリを作成・破棄。`maxConcurrency: 4` で並列数を制限。`isolate: false` でワーカー間の分離を無効化しメモリ効率を改善。

```
// vitest.workspace.ts:1-6
import { defineWorkspace } from "vitest/config"

export default defineWorkspace([
  "./vitest.config.ts",
  "./packages/tests/vitest.config.ts",
])
```

### MSW によるレジストリ HTTP モック（単体テスト）

`api.test.ts` と `fetcher.test.ts` で MSW の `setupServer` を使い、レジストリ API のレスポンスをモックしている。パターンとして注目すべきは:

1. **デフォルトハンドラをファイル先頭で定義** し、テストケース固有のハンドラは `server.use()` で上書きする
2. **ライフサイクル管理**: `beforeAll(() => server.listen())`, `afterEach(() => server.resetHandlers())`, `afterAll(() => server.close())`
3. **ステータスコード別ハンドラ**: 200, 401, 403, 404, 410, ネットワークエラーそれぞれ専用のエンドポイントを用意

```
// packages/shadcn/src/registry/fetcher.test.ts:15-43
const server = setupServer(
  http.get(`${REGISTRY_URL}/test.json`, () => {
    return HttpResponse.json({
      name: "test",
      type: "registry:ui",
    })
  }),
  http.get(`${REGISTRY_URL}/error.json`, () => {
    return HttpResponse.error()
  }),
  http.get(`${REGISTRY_URL}/not-found.json`, () => {
    return new HttpResponse(null, { status: 404 })
  }),
  http.get(`${REGISTRY_URL}/unauthorized.json`, () => {
    return new HttpResponse(null, { status: 401 })
  }),
  http.get(`${REGISTRY_URL}/forbidden.json`, () => {
    return new HttpResponse(null, { status: 403 })
  }),
  http.get(`${REGISTRY_URL}/gone.json`, () => {
    return new HttpResponse(null, { status: 410 })
  }),
  http.get("https://external.com/component.json", () => {
    return HttpResponse.json({
      name: "external",
      type: "registry:ui",
    })
  })
)
```

### 実 HTTP サーバーによる統合テスト

`packages/tests/src/utils/registry.ts` の `createRegistryServer()` は Node.js の `http.createServer` を使い、テスト用の完全なレジストリサーバーを構築する。認証方式（Bearer, API Key, Client Secret, Query Params）ごとにルーティングが分岐しており、統合テスト内で認証フローのエンドツーエンド検証が可能。

```
// packages/tests/src/utils/registry.ts:5-14
export async function createRegistryServer(
  items: Array<{ name: string; type: string } & Record<string, unknown>>,
  {
    port = 4444,
    path = "/r",
  }: {
    port?: number
    path?: string
  }
) {
```

統合テストでは複数のサーバーインスタンスを異なるポートで起動し、クロスレジストリ依存解決をテストしている。

```
// packages/tests/src/tests/registries.test.ts:13-87
const registryShadcn = await createRegistryServer([...], { port: 4040, path: "/r" })
const registryOne = await createRegistryServer([...], { port: 4444, path: "/r" })
const registryTwo = await createRegistryServer([...], { port: 5555, path: "/registry" })
```

### フィクスチャによるプロジェクトスキャフォールディング

統合テストのフィクスチャは `packages/tests/fixtures/` 配下に実際のフレームワークプロジェクト構造（`next-app`, `vite-app`, `no-framework`）を配置。各フィクスチャは `package.json`, `tsconfig.json` 等を含む完全なプロジェクト。テスト実行時に `createFixtureTestDirectory()` で一時ディレクトリにコピーし、テスト間の独立性を保証する。

```
// packages/tests/src/utils/helpers.ts:17-27
export async function createFixtureTestDirectory(fixtureName: string) {
  const fixturePath = path.join(FIXTURES_DIR, fixtureName)
  const uniqueId = `${process.pid}-${randomUUID().substring(0, 8)}`
  let testDir = path.join(TEMP_DIR, `test-${uniqueId}-${fixtureName}`)
  await fs.ensureDir(testDir)
  await fs.copy(fixturePath, testDir)
  return testDir
}
```

### `it.each` によるパラメタライズドテスト

`parser.test.ts` は `it.each` を使って同一ロジックの大量のエッジケースを網羅的にテストしている。パースロジックのような入力パターンが多い関数に対して、テストコードの重複を排除しつつ各ケースを独立してレポートする。

```
// packages/shadcn/src/registry/parser.test.ts:7-26
describe("valid registry items", () => {
  it.each([
    ["@v0/button", { registry: "@v0", item: "button" }],
    ["@acme/data-table", { registry: "@acme", item: "data-table" }],
    ["@company/nested/component", { registry: "@company", item: "nested/component" }],
    // ... 7 more cases
  ])("should parse registry item: %s", (input, expected) => {
    expect(parseRegistryAndItemFromString(input)).toEqual(expected)
  })
})
```

## コード例

```
// packages/shadcn/src/registry/fetcher.test.ts:78-109
it("should use cache when enabled", async () => {
  const result1 = await fetchRegistry(["test.json"], { useCache: true })
  expect(result1[0]).toMatchObject({ name: "test" })
  const result2 = await fetchRegistry(["test.json"], { useCache: true })
  expect(result2[0]).toMatchObject({ name: "test" })
})

it("should not use cache when disabled", async () => {
  let callCount = 0
  server.use(
    http.get(`${REGISTRY_URL}/cache-test.json`, () => {
      callCount++
      return HttpResponse.json({
        name: `test-${callCount}`,
        type: "registry:ui",
      })
    })
  )
  const result1 = await fetchRegistry(["cache-test.json"], { useCache: false })
  expect(result1[0]).toMatchObject({ name: "test-1" })
  const result2 = await fetchRegistry(["cache-test.json"], { useCache: false })
  expect(result2[0]).toMatchObject({ name: "test-2" })
})
```

```
// packages/tests/src/utils/helpers.ts:29-65
export async function runCommand(
  cwd: string,
  args: string[],
  options?: { env?: Record<string, string>; input?: string }
) {
  try {
    const childProcess = execa("node", [SHADCN_CLI_PATH, ...args], {
      cwd,
      env: { ...process.env, FORCE_COLOR: "0", CI: "true", ...options?.env },
      input: options?.input,
      reject: false,
      timeout: 30000,
    })
    const result = await childProcess
    return {
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      exitCode: result.exitCode ?? 0,
    }
  } catch (error: any) {
    return {
      stdout: error.stdout || "",
      stderr: error.stderr || error.message || "",
      exitCode: error.exitCode ?? 1,
    }
  }
}
```

## パターンカタログ

- **Test Double: Fake Server** (分類: テストダブル)
  - 解決する問題: 外部レジストリ API への依存をテスト時に除去し、認証フローや依存解決を再現可能にする
  - 適用条件: HTTP API を消費するシステムの統合テスト
  - コード例: `packages/tests/src/utils/registry.ts:5-256`
  - 注意点: 実 HTTP サーバーを起動するためポート競合に注意。`port` をパラメータ化して複数サーバーの共存を実現している

- **Test Fixture: Project Scaffold** (分類: テストデータ管理)
  - 解決する問題: CLI ツールのテストで「ターゲットプロジェクト」という複雑なテストデータを管理する
  - 適用条件: ファイルシステムを操作する CLI ツール、ビルドツール、コードジェネレーターのテスト
  - コード例: `packages/tests/fixtures/next-app/`, `packages/tests/src/utils/helpers.ts:17-27`
  - 注意点: フィクスチャは git 管理する実プロジェクト構造にし、テスト実行時に一時ディレクトリにコピーして独立性を保つ

## Good Patterns

- **MSW ハンドラの階層化**: デフォルトハンドラをモジュールスコープで定義し、テスト固有のハンドラを `server.use()` で上書きする。`afterEach(() => server.resetHandlers())` でリセットすることで、テスト間の汚染を防ぐ。キャッシュのテストでは `server.use()` 内でクロージャ変数（`callCount`）を使い、サーバー呼び出し回数を計測する。

```typescript
// fetcher.test.ts:88-109
it("should not use cache when disabled", async () => {
  let callCount = 0;
  server.use(
    http.get(`${REGISTRY_URL}/cache-test.json`, () => {
      callCount++;
      return HttpResponse.json({ name: `test-${callCount}`, type: "registry:ui" });
    }),
  );
  // ...
});
```

- **型付きエラークラスによるテスト**: HTTP ステータスコードごとの振る舞いを `rejects.toThrow(SpecificErrorClass)` で検証する。エラーメッセージの文字列マッチに依存せず、エラーの種類をコードレベルで区別できる。

```typescript
// fetcher.test.ts:112-134
it("should handle 404 errors", async () => {
  await expect(fetchRegistry(["not-found.json"])).rejects.toThrow(RegistryNotFoundError);
});
it("should handle 401 errors", async () => {
  await expect(fetchRegistry(["unauthorized.json"])).rejects.toThrow(RegistryUnauthorizedError);
});
```

- **一時ディレクトリ + finally ブロック**: ファイルシステムに書き込むテストは `fs.mkdtemp()` で一時ディレクトリを作り、`try/finally` でクリーンアップする。テスト失敗時もゴミファイルが残らない。

```typescript
// api.test.ts:136-176
it("should read and parse a valid local JSON file", async () => {
  const tempDir = await fs.mkdtemp(path.join(tmpdir(), "shadcn-test-"));
  const tempFile = path.join(tempDir, "test-component.json");
  await fs.writeFile(tempFile, JSON.stringify(componentData, null, 2));
  try {
    const [result] = await getRegistryItems([tempFile]);
    expect(result).toMatchObject({ name: "test-component" });
  } finally {
    await fs.unlink(tempFile);
    await fs.rmdir(tempDir);
  }
});
```

- **環境変数の beforeEach/afterEach 管理**: テストで `process.env` を操作する場合、`beforeEach` で設定し `afterEach` で `delete` する。テスト間の環境変数汚染を防ぐ。

```typescript
// validator.test.ts:46-52
beforeEach(() => {
  process.env.TOKEN = "value";
});
afterEach(() => {
  delete process.env.TOKEN;
});
```

## Anti-Patterns / 注意点

- **統合テストの sleep による競合回避**: `init.test.ts` の先頭で `await new Promise((resolve) => setTimeout(resolve, 2000))` が使われている。レジストリサーバーの起動タイミングとの競合を回避するためだが、タイミング依存のテストは不安定になりやすい。

```typescript
// Bad: packages/tests/src/tests/init.test.ts:14
await new Promise((resolve) => setTimeout(resolve, 2000));
```

```typescript
// Better: サーバーの ready 状態をポーリングで確認する
async function waitForServer(url: string, maxRetries = 10) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`Server at ${url} did not start`);
}
```

- **vi.mock の繰り返し宣言**: `search.test.ts` では各テストケースで `vi.mock("./api", ...)` が繰り返し宣言されている。Vitest のモックはファイルレベルでホイスティングされるため、`describe` ブロック内での再宣言は冗長であり、`beforeEach` + `vi.mocked()` で十分。

```typescript
// Bad: search.test.ts での各テスト内の vi.mock 重複
it("should apply search filter", async () => {
  vi.mock("./api", () => ({ getRegistry: vi.fn() })); // 毎回宣言
  const mockGetRegistry = vi.mocked(getRegistry);
  // ...
});
```

```typescript
// Better: ファイル先頭で一度だけ宣言
vi.mock("./api", () => ({ getRegistry: vi.fn() }));

describe("searchRegistries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("should apply search filter", async () => {
    const mockGetRegistry = vi.mocked(getRegistry);
    mockGetRegistry.mockImplementation(async () => {/* ... */});
    // ...
  });
});
```

## 導出ルール

- `[MUST]` MSW サーバーのライフサイクルは `beforeAll/listen`, `afterEach/resetHandlers`, `afterAll/close` の 3 点セットで管理する
  - 根拠: shadcn-ui/ui の全 MSW テストファイル（`api.test.ts`, `fetcher.test.ts`, `resolver.test.ts`）が統一的にこのパターンを使用しており、`afterEach` での `resetHandlers` がテスト間のハンドラ汚染を防止している
- `[MUST]` ファイルシステムを操作するテストは一時ディレクトリを作成し、`try/finally` または `afterAll` でクリーンアップする
  - 根拠: `api.test.ts` の全ローカルファイルテスト、および `packages/tests/src/utils/setup.ts` の `globalSetup` が `rimraf` で一時ディレクトリを破棄している
- `[SHOULD]` 単体テストと統合テストは Vitest Workspace で別の設定ファイルに分離し、タイムアウトや並列度を独立して調整する
  - 根拠: ルートの `vitest.config.ts`（デフォルトタイムアウト）と `packages/tests/vitest.config.ts`（120 秒タイムアウト、`maxConcurrency: 4`）が異なるテスト要件に合わせて調整されている
- `[SHOULD]` HTTP エラーテストでは、ステータスコードごとに型付きエラークラスを定義し、`rejects.toThrow(SpecificErrorClass)` で検証する
  - 根拠: `errors.ts` に 13 個のエラークラスが定義され、`fetcher.test.ts` が 404/401/403/410 を個別のエラークラスで検証することで、テストの表現力とリファクタリング耐性が向上している
- `[SHOULD]` AST 変換や文字列変換のテストには `toMatchInlineSnapshot()` を使い、テストファイル内で入出力を可視化する
  - 根拠: `transform-icons.test.ts` 等の全変換テスト（20+ ケース）が一貫して `toMatchInlineSnapshot()` を使用し、期待値の変更が diff として可視化される
- `[SHOULD]` 入力パターンが多い純粋関数のテストには `it.each` でパラメタライズドテストを使い、各パターンを独立してレポートする
  - 根拠: `parser.test.ts` が 60 以上のパースパターンを `it.each` で網羅的にカバーし、失敗時に具体的な入力値がレポートされる
- `[AVOID]` テストで `sleep` を使ってサーバー起動を待つ。ポーリングまたはイベント駆動で ready 状態を確認すべき
  - 根拠: `init.test.ts:14` の `setTimeout(resolve, 2000)` は環境依存で不安定になりうる

## 適用チェックリスト

- [ ] HTTP API を消費するモジュールのテストに MSW を導入し、`beforeAll/afterEach/afterAll` のライフサイクル管理を統一する
- [ ] 単体テストと統合テストの設定ファイルを Vitest Workspace で分離し、タイムアウト・並列度をテスト種別に応じて調整する
- [ ] ファイルシステム操作を含むテストで一時ディレクトリ戦略を採用し、`try/finally` でクリーンアップを保証する
- [ ] CLI ツールの統合テスト用にフレームワーク別フィクスチャ（実プロジェクト構造）を用意する
- [ ] HTTP エラーハンドリングのテストで、ステータスコードごとの型付きエラークラスを使い、型レベルでエラー種別を検証する
- [ ] 文字列/AST 変換のテストに `toMatchInlineSnapshot()` を採用し、テストファイル内で変換結果を直接可視化する
- [ ] パースロジック等の入力パターンが多い関数のテストに `it.each` を採用し、テストコードの重複を排除する
- [ ] テスト内での `process.env` 操作は `beforeEach/afterEach` で設定・削除を対にする
