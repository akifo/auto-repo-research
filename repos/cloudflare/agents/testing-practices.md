# testing-practices

> リポジトリ: cloudflare/agents
> 分析日: 2026-02-25

## 概要

cloudflare/agents は Cloudflare Workers + Durable Objects 上で動作する AI エージェントフレームワークであり、テスト戦略には 5 つの異なるレイヤーが存在する: Workers 統合テスト（vitest-pool-workers）、React ブラウザテスト（vitest-browser-react + Playwright）、CLI ユニットテスト（Node 環境）、型レベルテスト（.test-d.ts）、E2E テスト（wrangler プロセス起動）。各レイヤーが独立した `vitest.config.ts` と専用の `wrangler.jsonc` を持ち、vitest の projects 機能で統合される。この多層構造は「プラットフォーム固有の制約ごとにテストランタイムを分離する」という原則に基づいており、エッジランタイム・ブラウザ・Node.js という異なる実行環境を単一のテストスイートに統一する際の実践的なアプローチを示している。

## 背景にある原則

- **ランタイム境界ごとにテスト環境を分離すべき**: Workers テストは `cloudflare:test` モジュールを通じて Durable Object バインディングにアクセスし、React テストは実ブラウザ内で WebSocket を張り、CLI テストは Node.js で `process.exit` をモックする。これらを同一の vitest プロジェクトに混在させると、ランタイム固有の API（`cloudflare:test` の `env` や `createExecutionContext` 等）が衝突する。vitest の projects 機能で各テストスイートに専用の config を与えることで、この問題を根本的に回避している（`packages/agents/vitest.config.ts:5-12`）。

- **テスト用 Worker は本番コードと同じバインディング定義を共有すべき**: `wrangler.jsonc` にテスト用 Durable Object バインディングを宣言し、`worker.ts` がそれらを re-export する。テスト内では `cloudflare:test` の `env` を通じて実際のバインディングを取得する。これにより、モックではなく実際の Durable Object インスタンスに対してテストが実行される（`src/tests/wrangler.jsonc:1-167`, `src/tests/worker.ts:1-162`）。

- **不安定なテストは除外しつつ手元実行の道は残すべき**: CI でハングするファイバーテストは `exclude` で除外し、E2E テストは projects 配列からコメントアウトされている。両方ともコメントでローカル実行コマンドを記載しており、「壊れているから消す」ではなく「CI では無効化、ローカルでは実行可能」という方針を取っている（`src/tests/vitest.config.ts:7-8`, `vitest.config.ts:10`）。

- **型の正しさはランタイムテストとは独立して検証すべき**: `.test-d.ts` ファイルで `satisfies` や `@ts-expect-error` を使い、RPC メソッドの型推論・シリアライズ可能性・深いネスト型の再帰制限回避をコンパイル時に検証する。これはランタイムテストでは検出できない型レベルのリグレッションを防ぐ（`src/tests-d/serializable.test-d.ts:1-268`）。

## 実例と分析

### 多層テスト構成: vitest projects による統合

ルートの `vitest.config.ts` が 4 つのサブプロジェクトを束ねる。各プロジェクトは独自の名前・環境・依存関係を持つ。

```typescript
// packages/agents/vitest.config.ts:1-13
export default defineConfig({
  test: {
    projects: [
      "src/tests/vitest.config.ts", // Workers (vitest-pool-workers)
      "src/react-tests/vitest.config.ts", // React (browser mode)
      "src/cli-tests/vitest.config.ts", // CLI (Node.js)
      "src/x402-tests/vitest.config.ts", // x402 (Node.js)
      // "src/e2e-tests/vitest.config.ts" — disabled: hangs in CI
    ],
  },
});
```

`--project` フラグで個別実行が可能: `vitest --project workers`, `vitest --project react`。

### Workers テスト: Durable Object の実バインディングを使った統合テスト

Workers テストは `@cloudflare/vitest-pool-workers` を使い、テストが Cloudflare Workers ランタイム内で実行される。`cloudflare:test` モジュールから `env` と `createExecutionContext` を取得し、実際の Durable Object バインディングを操作する。

```typescript
// src/tests/alarms.test.ts:1-31
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "..";
import type { Env } from "./worker";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

describe("scheduled destroys", () => {
  it("should not throw when a scheduled callback nukes storage", async () => {
    let agentStub = await getAgentByName(
      env.TestDestroyScheduleAgent,
      "alarm-destroy-repro",
    );
    await agentStub.scheduleSelfDestructingAlarm();
    await expect(agentStub.getStatus()).resolves.toBe("scheduled");
    // ...
  });
});
```

重要な設計判断として `isolatedStorage: false` と `singleWorker: true` が設定されている。これは Durable Object が名前ベースでインスタンスを解決するため、テスト間でストレージを分離する代わりに各テストがユニークな名前を生成する方式を採用していることを意味する。

### React テスト: globalSetup で miniflare を起動し、ブラウザ内テスト

React テストは `vitest-browser-react` を使い、実際の Chromium ブラウザ内でコンポーネントをレンダリングする。`globalSetup` が miniflare ベースの Worker を固定ポートで起動し、テスト内のコンポーネントがそこに WebSocket 接続する。

```typescript
// src/react-tests/setup.ts:75-128
export async function setup() {
  const portAvailable = await isPortAvailable(TEST_WORKER_PORT);
  if (!portAvailable) {
    killProcessOnPort(TEST_WORKER_PORT);
    await new Promise((r) => setTimeout(r, 500));
  }
  // Signal handlers for clean teardown on Ctrl+C
  if (!signalHandlersInstalled) {
    signalHandlersInstalled = true;
    const onSignal = () => {
      stopWorker().finally(() => process.exit(1));
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }
  worker = await unstable_dev(workerPath, {
    config: configPath,
    port: TEST_WORKER_PORT,
    ip: "0.0.0.0", // Playwright browser needs all-interface bind
    persist: false,
    logLevel: "warn",
  });
}
```

テスト側では `vi.waitFor` でポーリングして非同期の接続完了を待つ。

```typescript
// src/react-tests/useAgent.test.tsx:53-90
it("should connect and receive identity", async () => {
  const { host, protocol } = getTestWorkerHost();
  let capturedAgent: TestAgent | null = null;
  const { container } = render(
    <SuspenseWrapper>
      <TestAgentComponent
        options={{ agent: "TestStateAgent", name: "hook-test-identity", host, protocol }}
        onAgent={(agent) => {
          capturedAgent = agent;
        }}
      />
    </SuspenseWrapper>,
  );
  await vi.waitFor(() => {
    const status = container.querySelector('[data-testid="agent-status"]');
    expect(status?.textContent).toBe("connected");
  }, { timeout: 10000 });
});
```

### CLI テスト: process.exit のモック戦略

CLI テストは yargs の `process.exit` 呼び出しをモックし、exit コードを捕捉する。throw で実行を停止し、後続のアサーションで exit コードと出力を検証する。

```typescript
// src/cli-tests/cli.test.ts:30-35
process.exit = vi.fn((code?: number) => {
  exitCode = code ?? 0;
  throw new Error(`process.exit(${code ?? 0})`);
}) as unknown as typeof process.exit;
```

### 型レベルテスト: satisfies と @ts-expect-error による静的検証

`satisfies` で戻り値型の一致を検証し、`@ts-expect-error` でシリアライズ不可能な型の排除を検証する。これらは `tsc` のコンパイルが成功/失敗することで自動的に検証される。

```typescript
// src/tests-d/serializable.test-d.ts:89-134
const agent = useAgent<SerializableAgent, SimpleState>({ agent: "test" });

// Positive tests: should compile
agent.call("getSimpleState") satisfies Promise<SimpleState>;
agent.call("getNestedState") satisfies Promise<NestedState>;

// Negative tests: should NOT compile
// @ts-expect-error Date return not serializable
agent.call("nonSerializableReturn");
// @ts-expect-error Date parameter not serializable
agent.call("nonSerializableParams", [new Date()]);
```

深いネスト型の再帰制限を回避するテストも含まれ、特定の GitHub issue（#903）に紐づいている。

### E2E テスト: プロセス kill によるエビクション再現

E2E テストは wrangler を子プロセスとして起動し、SIGKILL で殺してから再起動し、Durable Object の永続化状態からのリカバリを検証する。

```typescript
// src/e2e-tests/fiber-eviction.test.ts:248-337
it("should recover a fiber after wrangler process is killed", async () => {
  wrangler = startWrangler();
  await waitForReady();
  const fiberId = (await callAgent("startSlowFiber", [10])) as string;
  await sleep(3500);
  // Phase 2: Kill the process (simulate eviction)
  await killProcess(wrangler);
  await waitForPortFree();
  // Phase 3: Restart wrangler (same persist dir)
  wrangler = startWrangler();
  await waitForReady();
  // Phase 4: Trigger recovery
  await callAgent("triggerAlarm", []);
  // Phase 5: Verify recovery
  expect(statusAfter!.status).toBe("completed");
  expect(statusAfter!.retryCount).toBeGreaterThanOrEqual(1);
});
```

### Playwright E2E: WebSocket を page.evaluate 内で操作

ai-chat パッケージの Playwright テストは `page.evaluate` 内で WebSocket を生成し、ブラウザコンテキスト内でメッセージの送受信を行う。wrangler dev をウェブサーバーとして起動し、stale プロセスの kill コマンドを `command` に組み込んでいる。

```typescript
// packages/ai-chat/e2e/playwright.config.ts:9-27
export default defineConfig({
  timeout: 30_000,
  retries: 3,
  workers: 1, // Sequential - single wrangler dev instance
  webServer: {
    command: `lsof -ti tcp:${PORT} | xargs kill -9 2>/dev/null; npx wrangler dev --config ${configPath} --port ${PORT}`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
  },
});
```

### テストヘルパーの共通パターン: WebSocket 接続とメッセージ待ち

複数のテストファイルに `connectWS` と `waitForMessage` というヘルパーが繰り返し出現する。各ファイルが独立してヘルパーを定義する方式を取っている。

```typescript
// src/tests/state.test.ts:42-71 (同様のパターンが callable.test.ts, routing.test.ts にも)
async function connectWS(path: string) {
  const ctx = createExecutionContext();
  const req = new Request(`http://example.com${path}`, {
    headers: { Upgrade: "websocket" },
  });
  const res = await worker.fetch(req, env, ctx);
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  ws.accept();
  return { ws, ctx };
}
```

## パターンカタログ

- **Test Double: Test Worker as Shared Fixture** (構造)
  - 解決する問題: Durable Object は Worker バインディングを通じてのみアクセスでき、単体テストでモックすると本質的な振る舞いが検証できない
  - 適用条件: テスト対象がプラットフォーム固有のバインディング（DO, KV, Queue 等）に依存する場合
  - コード例: `src/tests/worker.ts:1-162`, `src/tests/wrangler.jsonc:1-167`
  - 注意点: テスト用 Worker に全てのバインディングを宣言する必要があり、テストエージェント追加のたびに wrangler.jsonc と worker.ts の両方を更新する必要がある

- **Adapter Pattern: globalSetup による環境ブリッジ** (構造)
  - 解決する問題: ブラウザ内テストから Workers ランタイムにアクセスするにはネットワーク経由の接続が必要
  - 適用条件: テスト対象がクライアント-サーバー間通信を含む場合
  - コード例: `src/react-tests/setup.ts:75-128`
  - 注意点: ポート衝突の回避、stale プロセスの kill、シグナルハンドラによる確実な teardown が必要

## Good Patterns

- **ユニークインスタンス名によるテスト分離**: 各テストが `crypto.randomUUID()` やテスト名をインスタンス名に含め、Durable Object の名前空間でテストを分離する。`isolatedStorage: false` でもテスト間の干渉が起きない。

```typescript
// src/tests/callable.test.ts:172-183
it("should call sync method and return result", async () => {
  const room = `callable-sync-${crypto.randomUUID()}`;
  const { ws } = await connectWS(`/agents/test-callable-agent/${room}`);
  await skipInitialMessages(ws);
  const response = expectSuccess(await callRPC(ws, "add", [5, 3]));
  expect(response.result).toBe(8);
  ws.close();
});
```

- **型ガードによる RPC レスポンスのナローイング**: テストヘルパーで型ガード関数を定義し、成功/失敗レスポンスを安全にナローイングする。

```typescript
// src/tests/callable.test.ts:17-36
function isSuccessResponse(r: RPCResponse): r is SuccessRPCResponse {
  return r.success === true;
}
function expectSuccess(r: RPCResponse): SuccessRPCResponse {
  expect(r.success).toBe(true);
  if (!isSuccessResponse(r)) throw new Error("Expected success response");
  return r;
}
```

- **CODE REVIEW NOTES によるテスト意図の文書化**: テストファイル冒頭に将来の改善点をコメントとして記載し、テストの意図と既知の制限を明示する。

```typescript
// src/tests/state.test.ts:1-27
/**
 * State Management Tests
 *
 * CODE REVIEW NOTES - Future improvements to address:
 *
 * SERVER-SIDE (packages/agents/src/index.ts):
 * 1. State getter has side effects - The `get state()` accessor calls `setState()`
 *    on first access when initialState is defined. ...
 */
```

## Anti-Patterns / 注意点

- **WebSocket ヘルパーのコピペ重複**: `connectWS` と `waitForMessage` が `state.test.ts`, `callable.test.ts`, `routing.test.ts`, `msg-ordering.test.ts` で個別に定義されている。共通モジュールへの抽出で保守性が向上する。

```typescript
// Bad: 4 ファイルに同じヘルパーが重複
// src/tests/state.test.ts:42-52
async function connectWS(path: string) {/* ... */}
// src/tests/callable.test.ts:44-55
async function connectWS(path: string) {/* ... */}

// Better: 共通テストユーティリティに抽出
// src/tests/test-utils.ts
export async function connectWS(path: string) {/* ... */}
```

- **固定 sleep によるタイミング依存**: 一部のテストが `await new Promise(r => setTimeout(r, 100))` で非同期処理の完了を待つ。これは CI 環境の負荷次第でフレーキーになりうる。`vi.waitFor` や条件ポーリングへの置き換えが望ましい。

```typescript
// Bad: 固定 sleep
await new Promise((resolve) => setTimeout(resolve, 100));

// Better: 条件ポーリング (state.test.ts:217-223 で実際に使われているパターン)
let calls = [];
const start = Date.now();
while (calls.length === 0 && Date.now() - start < 500) {
  calls = await agentStub.getStateUpdateCalls();
  if (calls.length === 0) await new Promise((r) => setTimeout(r, 10));
}
```

## 導出ルール

- `[MUST]` テスト環境が異なるランタイム（エッジ、ブラウザ、Node.js）を跨ぐ場合、vitest の projects 機能でプロジェクトを分離し、各プロジェクトに独自の config を持たせる
  - 根拠: cloudflare/agents では `cloudflare:test` を使う Workers テストと `vitest-browser-react` を使う React テストが同一 config では共存できず、4 つの独立した vitest config に分離している（`packages/agents/vitest.config.ts:5-12`）

- `[MUST]` プラットフォーム固有の API（Durable Object, KV 等）をテストする場合、モックではなく実バインディングを使った統合テストを書き、テスト用 Worker にバインディングを宣言する
  - 根拠: 全 Workers テストが `cloudflare:test` の `env` 経由で実際の Durable Object インスタンスを操作しており、バインディングの振る舞い（SQLite 永続化、アラーム発火等）をモックなしで検証している（`src/tests/wrangler.jsonc`）

- `[SHOULD]` 共有リソース（DB, Durable Object 等）を使うテストでは、各テストケースがユニークな識別子を生成して名前空間を分離する
  - 根拠: `crypto.randomUUID()` やテスト名をインスタンス名に含めることで `isolatedStorage: false` でもテスト間干渉を防いでいる（`src/tests/callable.test.ts:172` 等、全 Workers テストで統一）

- `[SHOULD]` 公開 API の型推論（特にジェネリクスや条件型）は `.test-d.ts` ファイルで `satisfies` と `@ts-expect-error` を使いコンパイル時に検証する
  - 根拠: RPC メソッドのシリアライズ可能性チェックや深いネスト型の再帰制限は、ランタイムテストでは検出できない型レベルのリグレッションであり、7 つの `.test-d.ts` ファイルがこれを防いでいる（`src/tests-d/serializable.test-d.ts`）

- `[SHOULD]` ブラウザ統合テストの globalSetup では、stale プロセスの検出・kill・シグナルハンドラ登録を行い、テストの再現性を保証する
  - 根拠: `setup.ts` が前回のテスト中断で残ったプロセスを kill し、SIGINT/SIGTERM でも確実に teardown が走る仕組みを実装している（`src/react-tests/setup.ts:40-97`）

- `[SHOULD]` CI で不安定なテストはソースコード内の exclude/コメントで無効化し、ローカル実行コマンドをコメントに残す
  - 根拠: ファイバーテストが `exclude: ["**/fiber.test.ts"]` で除外されつつ、`// Run locally with: npx vitest run src/tests/fiber.test.ts` とローカル実行方法が明記されている（`src/tests/vitest.config.ts:7-8`）

- `[AVOID]` 非同期処理の完了待ちに固定 sleep を使う。代わりに条件ポーリングまたは `vi.waitFor` を使う
  - 根拠: 一部のテストが `setTimeout(resolve, 100)` を使用しているが、同一リポジトリ内の他のテストでは `vi.waitFor` や `while` ループによるポーリング（`src/tests/state.test.ts:217-223`）が使われており、後者の方が CI での安定性が高い

## 適用チェックリスト

- [ ] テスト対象が複数のランタイム環境（エッジ、ブラウザ、Node.js）を跨ぐ場合、vitest の projects 機能でプロジェクトを分離しているか
- [ ] プラットフォーム固有のバインディング（DO, KV, Queue 等）を使うテストで、テスト用 Worker と wrangler.jsonc を用意しているか
- [ ] 共有リソースを使うテストが、各テストケースでユニークな識別子を生成してテスト分離を実現しているか
- [ ] 公開 API のジェネリクスや条件型に対する型レベルテスト（`.test-d.ts`）を用意しているか
- [ ] ブラウザ統合テストの setup/teardown で stale プロセスの検出と確実なクリーンアップを行っているか
- [ ] CI で不安定なテストを除外する際、ローカル実行方法をコメントに残しているか
- [ ] 非同期処理の待機に固定 sleep ではなく条件ポーリングまたは `vi.waitFor` を使用しているか
- [ ] テストヘルパー（WebSocket 接続、メッセージ待ち等）が重複していないか。共通モジュールに抽出しているか
