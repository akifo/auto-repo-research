# Practice: Multi-Runtime Test Isolation

> 出典: [repos/cloudflare/agents/testing-practices.md](../repos/cloudflare/agents/testing-practices.md)
> カテゴリ: practice

## 概要

異なるランタイム（Workers / ブラウザ / Node.js）を跨ぐテストを vitest の projects 機能で分離し、各テストディレクトリに独立した `vitest.config.ts` と `wrangler.jsonc` を配置するパターン。Workers 統合テスト（vitest-pool-workers）、React ブラウザテスト（Playwright + vitest-browser-react）、CLI テスト（Node.js）、型レベルテスト（.test-d.ts）の 4 層構成により、ランタイム固有の API 衝突を根本的に回避しつつ、単一の `vitest` コマンドで全テストを実行できる。

## 背景・文脈

cloudflare/agents は Cloudflare Workers + Durable Objects 上で動作する AI エージェントフレームワーク。テスト対象がエッジランタイム（Workers）、ブラウザ（React hooks の WebSocket 接続）、Node.js（CLI ツール）、型システム（RPC の型推論）と多岐にわたる。

これらを同一の vitest プロジェクトに混在させると、以下の問題が発生する:

- `cloudflare:test` モジュール（Workers 専用）がブラウザ・Node.js テストでインポートエラーになる
- `vitest-pool-workers` と `vitest-browser-react` は pool 設定が排他的で共存できない
- Node.js の `process.exit` モックがエッジランタイムでは存在しない

このパターンは「ランタイム境界ごとにテスト環境を完全に分離し、トップレベルの config で統合する」というアプローチで、マルチプラットフォーム対応ライブラリのテスト戦略として汎用的に応用できる。

## 実装パターン

### 1. ルート vitest.config.ts で projects を宣言

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

### 2. Workers 統合テスト: 実バインディングによるテスト

Workers テストは `@cloudflare/vitest-pool-workers` を使い、テストコードが Workers ランタイム内で実行される。`cloudflare:test` モジュールから `env` を取得し、実際の Durable Object バインディングを操作する。

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
  });
});
```

テスト用 Worker (`worker.ts`) がテスト対象の全 Agent を re-export し、`wrangler.jsonc` にバインディングを宣言する。モックではなく実際の Durable Object インスタンスに対してテストが実行される。

### 3. React ブラウザテスト: globalSetup で Worker を起動

`globalSetup` が miniflare ベースの Worker を固定ポートで起動し、テスト内のコンポーネントが WebSocket 接続する。

```typescript
// src/react-tests/setup.ts:75-128
export async function setup() {
  const portAvailable = await isPortAvailable(TEST_WORKER_PORT);
  if (!portAvailable) {
    killProcessOnPort(TEST_WORKER_PORT);
    await new Promise((r) => setTimeout(r, 500));
  }
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

テスト側では `vi.waitFor` で非同期の接続完了をポーリングする。

```typescript
// src/react-tests/useAgent.test.tsx:53-90
it("should connect and receive identity", async () => {
  const { host, protocol } = getTestWorkerHost();
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

### 4. CLI テスト: process.exit モック

CLI テストは Node.js 環境で実行され、yargs の `process.exit` 呼び出しをモックして exit コードを捕捉する。

```typescript
// src/cli-tests/cli.test.ts:30-35
process.exit = vi.fn((code?: number) => {
  exitCode = code ?? 0;
  throw new Error(`process.exit(${code ?? 0})`);
}) as unknown as typeof process.exit;
```

### 5. 型レベルテスト: .test-d.ts による静的検証

`satisfies` で戻り値型の一致を検証し、`@ts-expect-error` でシリアライズ不可能な型の排除を検証する。

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

## Good Example

ディレクトリ構成で各ランタイムのテスト環境を物理的に分離し、ルートの projects で束ねる。

```
packages/agents/
├── vitest.config.ts              # ルート: projects で統合
├── src/
│   ├── tests/                    # Workers 統合テスト
│   │   ├── vitest.config.ts      # pool: @cloudflare/vitest-pool-workers
│   │   ├── wrangler.jsonc        # テスト用 DO バインディング
│   │   ├── worker.ts             # テスト用 Worker（全 Agent re-export）
│   │   ├── alarms.test.ts
│   │   ├── callable.test.ts
│   │   └── state.test.ts
│   ├── react-tests/              # React ブラウザテスト
│   │   ├── vitest.config.ts      # browser: { provider: "playwright" }
│   │   ├── setup.ts              # globalSetup: miniflare 起動
│   │   └── useAgent.test.tsx
│   ├── cli-tests/                # CLI テスト
│   │   ├── vitest.config.ts      # environment: "node"
│   │   └── cli.test.ts
│   └── tests-d/                  # 型レベルテスト
│       └── serializable.test-d.ts
```

各テストケースでユニークなインスタンス名を生成し、共有リソースでもテスト間干渉を防ぐ。

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

## Bad Example

全ランタイムのテストを同一の vitest config に混在させる。

```typescript
// Bad: 単一の vitest.config.ts に全環境を押し込む
export default defineConfig({
  test: {
    // Workers テストと React テストの pool が衝突する
    pool: "@cloudflare/vitest-pool-workers",
    browser: { provider: "playwright" }, // pool と排他的
    environment: "node", // Workers テストと矛盾
  },
});
```

```typescript
// Bad: 固定 sleep でタイミング依存
await new Promise((resolve) => setTimeout(resolve, 100));
// CI の負荷次第でフレーキーになる

// Better: vi.waitFor で条件ポーリング
await vi.waitFor(() => {
  expect(status?.textContent).toBe("connected");
}, { timeout: 10000 });
```

```typescript
// Bad: WebSocket ヘルパーを各テストファイルにコピペ
// state.test.ts, callable.test.ts, routing.test.ts に同一関数が重複

// Better: 共通テストユーティリティに抽出
// src/tests/test-utils.ts
export async function connectWS(path: string) {/* ... */}
```

## 適用ガイド

### どのような状況で使うべきか

- テスト対象が複数のランタイム環境（エッジ、ブラウザ、Node.js）を跨ぐ場合
- vitest の pool 設定が排他的な複数のテスト種別（`vitest-pool-workers`, `vitest-browser-react` 等）を共存させる必要がある場合
- 型レベルのリグレッション（ジェネリクス、条件型、シリアライズ可能性）をランタイムテストとは独立して検証したい場合

### 導入時の注意点

- テスト用 Worker に全てのバインディングを宣言する必要がある。テストエージェント追加のたびに `wrangler.jsonc` と `worker.ts` の両方を更新する
- ブラウザ統合テストの `globalSetup` では、stale プロセスの検出・kill・シグナルハンドラ登録を必ず実装する。テスト中断時のポート占有がフレーキーテストの主因になる
- CI で不安定なテストは `exclude` で除外しつつ、ローカル実行コマンドをコメントに残す（`// Run locally with: npx vitest run src/tests/fiber.test.ts`）
- `isolatedStorage: false` を使う場合、各テストケースが `crypto.randomUUID()` やテスト名でユニークなインスタンス名を生成し、名前空間でテストを分離する

### カスタマイズポイント

- projects の粒度: ランタイムが同一なら1プロジェクトにまとめてよい（例: CLI テストと x402 テストは両方 Node.js 環境）
- `--project` フラグを CI ジョブのマトリクスと組み合わせて並列実行を最適化できる
- `.test-d.ts` は vitest の `typecheck` オプションまたは `tsc --noEmit` のいずれかで実行可能。プロジェクトの CI パイプラインに合わせて選択する
- E2E テスト（wrangler プロセス起動 + SIGKILL によるエビクション再現）は projects 配列からコメントアウトして管理し、ローカル実行のみに留めるのが現実的

## 参考

- [repos/cloudflare/agents/testing-practices.md](../repos/cloudflare/agents/testing-practices.md) -- 元の分析
