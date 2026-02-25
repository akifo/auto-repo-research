# testing-practices

> リポジトリ: cloudflare/partykit
> 分析日: 2026-02-25

## 概要

Vitest と `@cloudflare/vitest-pool-workers` を軸としたテスト基盤を分析する。このリポジトリは Durable Objects (DO) をコアとする WebSocket サーバーフレームワークであり、テストにおいて「workerd ランタイム上で DO を直接操作するユニットテスト」「`wrangler dev` を起動して WebSocket クライアントから接続するインテグレーションテスト」「jsdom / Node.js 環境でクライアントライブラリをテストするユニットテスト」という 3 層構造を採用している。特に DO テストでは「テスト用ワーカーにテストシナリオごとの DO サブクラスを定義する」という設計が一貫しており、workerd の制約下でのテスト戦略として注目に値する。

## 背景にある原則

- **テスト実行環境は対象コードのランタイムに合わせるべき。なぜならランタイム固有の API やライフサイクルに起因するバグはその環境でしか再現できないから**: DO テストは `@cloudflare/vitest-pool-workers` で workerd 上で実行し、クライアントテストは `@vitest-environment jsdom` / `@vitest-environment node` でブラウザ / Node.js をエミュレートする。y-partyserver の hibernation テストは `wrangler dev` プロセスを spawn して restart を含む E2E シナリオをテストしている (`packages/y-partyserver/src/tests/server-harness.ts`)。

- **テスト対象のバリエーションは設定ではなくサブクラスで表現すべき。なぜならステートフルなコンポーネントは内部状態と振る舞いの組み合わせをテストする必要があり、サブクラスごとに DO としてバインドすることで各テストケースが独立した DO インスタンスを持てるから**: `worker.ts` では `Stateful`, `OnStartServer`, `HibernatingOnStartServer`, `AlarmServer`, `FailingOnStartServer` など 16 個の Server サブクラスが定義され、それぞれが異なるテストシナリオに対応する (`packages/partyserver/src/tests/worker.ts`)。

- **テスト階層は粒度別に分離し、重いテストは独立した設定ファイルで管理すべき。なぜなら高速な開発ループ（ユニットテスト）と信頼性保証（インテグレーションテスト）は異なるフィードバック速度を要求するから**: y-partyserver は `vitest.config.ts`（workerd プールテスト）、`vitest.hibernation.config.ts`（サーバー再起動テスト、120s タイムアウト）、`vitest.integration.config.ts`（`wrangler dev` を使う E2E テスト、globalSetup あり）の 3 つの設定を持つ。

## 実例と分析

### テスト用ワーカーパターン（DO テストの中核戦略）

`@cloudflare/vitest-pool-workers` を使った DO テストの最も特徴的なパターンは、テスト専用の `worker.ts` にテストシナリオごとの DO サブクラスを定義し、`wrangler.jsonc` でそれぞれを DO バインディングとして登録する構造にある。

`packages/partyserver/src/tests/worker.ts` では 16 の DO クラスが定義されている。各クラスは単一のテストシナリオに特化する:

```typescript
// packages/partyserver/src/tests/worker.ts:55-76
export class OnStartServer extends Server {
  counter = 0;
  async onStart() {
    assert(this.name, "name is not available inside onStart");
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        this.counter++;
        resolve();
      }, 300);
    });
  }
  onConnect(connection: Connection) {
    connection.send(this.counter.toString());
  }
  onRequest(
    _request: Request<unknown, CfProperties<unknown>>,
  ): Response | Promise<Response> {
    return new Response(this.counter.toString());
  }
}
```

対応する wrangler 設定:

```jsonc
// packages/partyserver/src/tests/wrangler.jsonc:13-20
"durable_objects": {
  "bindings": [
    { "name": "Stateful", "class_name": "Stateful" },
    { "name": "OnStartServer", "class_name": "OnStartServer" },
    // ... 14 more bindings
  ]
}
```

テスト側では `cloudflare:test` モジュールの `env` から DO スタブを取得するか、ワーカーの `fetch` ハンドラ経由でリクエストを送る:

```typescript
// packages/partyserver/src/tests/index.test.ts:1-16
import { createExecutionContext, env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "./worker";

import type { Env } from "./worker";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
```

### WebSocket テストのライフサイクル管理

DO テストでは WebSocket の接続・メッセージ受信・切断のライフサイクルを `Promise.withResolvers` で管理している。これはコールバックベースの WebSocket API をテストで扱うための定石となっている:

```typescript
// packages/partyserver/src/tests/index.test.ts:28-54
it("can be connected with a websocket", async () => {
  const ctx = createExecutionContext();
  const request = new Request("http://example.com/parties/stateful/123", {
    headers: { Upgrade: "websocket" },
  });
  const response = await worker.fetch(request, env, ctx);
  const ws = response.webSocket!;

  const { promise, resolve, reject } = Promise.withResolvers<void>();
  ws.accept();
  ws.addEventListener("message", (message) => {
    try {
      expect(JSON.parse(message.data as string)).toEqual({ name: "123" });
      resolve();
    } catch (e) {
      reject(e);
    } finally {
      ws.close();
    }
  });

  return promise;
});
```

### 環境ごとのテスト分離（partysocket パッケージ）

partysocket はクライアントライブラリであり、ブラウザ環境（jsdom）と Node.js 環境の両方で動作する必要がある。ファイルレベルの `@vitest-environment` ディレクティブでテストごとに環境を切り替えている:

- `partysocket.test.ts`: `@vitest-environment jsdom` -- ブラウザ DOM API を必要とするテスト
- `reconnecting.test.ts`: `@vitest-environment node` -- `ws` パッケージの WebSocketServer を使う再接続テスト
- `react-hooks.test.tsx`: `@vitest-environment jsdom` -- React Testing Library
- `react-ssr.test.tsx`: `@vitest-environment node` -- SSR 環境（`window` を `delete` して検証）

### CI 環境でのテストスキップ

partysocket のテストスイートは WebSocketServer を起動してポートバインドするため、CI 環境で不安定になりやすい。`describe.skipIf(!!process.env.GITHUB_ACTIONS)` で CI ではスキップし、ローカルでのみ実行する戦略を取っている:

```typescript
// packages/partysocket/src/tests/error-handling.test.ts:10-11
describe.skipIf(!!process.env.GITHUB_ACTIONS)(
  "Error Handling - URL Providers",
  () => {/* ... */},
);
```

### サーバーハーネスによるインテグレーションテスト

y-partyserver の hibernation テストでは `WranglerServer` クラスがテスト用の `wrangler dev` プロセスを管理する。`start()`, `stop()`, `restart()`, `cleanup()` メソッドを持ち、サーバー再起動シナリオの検証を可能にする:

```typescript
// packages/y-partyserver/src/tests/server-harness.ts:8-82
export class WranglerServer {
  private process: ChildProcess | null = null;
  private port: number;
  private persistDir: string;

  async start(): Promise<void> {
    this.process = spawn("npx", [
      "wrangler",
      "dev",
      "--config",
      path.join(TEST_DIR, "integration-wrangler.jsonc"),
      "--port",
      String(this.port),
      "--persist-to",
      this.persistDir,
      "--no-show-interactive-dev-session",
    ], {/* ... */});
    await this.waitForReady();
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  cleanup(): void {
    if (fs.existsSync(this.persistDir)) {
      fs.rmSync(this.persistDir, { recursive: true, force: true });
    }
  }
}
```

### テストヘルパー関数の体系化（y-partyserver）

y-partyserver の `index.test.ts` では、Yjs プロトコルの低レベル操作を抽象化するヘルパー関数群が定義されている。`wsRequest()`, `httpRequest()`, `acceptWs()`, `nextBinaryMessage()`, `nextStringMessage()`, `collectMessages()`, `performSync()`, `sendUpdate()`, `applyIncomingMessages()` など 9 つのヘルパーがテストの可読性を維持している:

```typescript
// packages/y-partyserver/src/tests/index.test.ts:28-44
function wsRequest(path: string): Request {
  return new Request(`http://example.com/parties/${path}`, {
    headers: { Upgrade: "websocket" },
  });
}

function acceptWs(response: Response): WebSocket {
  const ws = response.webSocket!;
  ws.accept();
  return ws;
}

function nextBinaryMessage(ws: WebSocket): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for binary message")),
      5000,
    );
    const handler = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        clearTimeout(timeout);
        ws.removeEventListener("message", handler);
        resolve(event.data);
      }
    };
    ws.addEventListener("message", handler);
  });
}
```

### isolatedStorage の意図的な無効化

`@cloudflare/vitest-pool-workers` のデフォルトではテスト間でストレージが分離されるが、partyserver・partysub・y-partyserver のテストでは `isolatedStorage: false` に設定している。これは DO の状態がテストをまたいで保持されることを前提としたシナリオ（名前の永続化テスト、セッション間の永続化テストなど）を可能にするためである:

```typescript
// packages/partyserver/src/tests/vitest.config.ts:3-14
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        isolatedStorage: false,
        wrangler: { configPath: "./wrangler.jsonc" },
      },
    },
  },
});
```

## パターンカタログ

- **Test Double as Subclass** (分類: テストパターン / Test Fixture)
  - 解決する問題: ステートフルなコンポーネント（DO）のバリエーションテストで、設定ファイルだけでは表現しきれない振る舞いの違いをテストする
  - 適用条件: テスト対象がサブクラス化可能なフレームワーク（DO, Actor, etc.）を使っている場合
  - コード例: `packages/partyserver/src/tests/worker.ts:30-53`（`Stateful`）, `packages/partyserver/src/tests/worker.ts:350-368`（`FailingOnStartServer`）
  - 注意点: サブクラスが増えすぎると wrangler.jsonc のバインディング管理が煩雑になる

- **Server Harness** (分類: テストパターン / Object Mother)
  - 解決する問題: 外部プロセス（`wrangler dev`）のライフサイクルをテストから制御する
  - 適用条件: テスト対象がプロセス再起動・ネットワーク断などを含む E2E シナリオを持つ場合
  - コード例: `packages/y-partyserver/src/tests/server-harness.ts:8-104`
  - 注意点: ポート競合、プロセスリーク、タイムアウトに注意が必要

## Good Patterns

- **テストシナリオごとに DO サブクラスを分離する**: 各 DO サブクラスが単一のテストシナリオに対応するため、テストの意図が明確になり、テスト間の状態干渉が起こらない。`FailingOnStartServer` は初回 `onStart` で例外を投げ、2 回目で成功するという振る舞いをクラスレベルで定義している (`packages/partyserver/src/tests/worker.ts:350-368`)。

- **Promise.withResolvers でコールバック API をテスト可能にする**: WebSocket のイベントリスナー内で `expect` を実行し、失敗時に `reject` で伝搬する。`finally` で必ず接続を閉じるため、テスト失敗時もリソースリークしない (`packages/partyserver/src/tests/index.test.ts:38-53`)。

- **ヘルパー関数でプロトコル操作を抽象化する**: Yjs の sync/awareness プロトコルのバイナリ操作をヘルパー関数に集約し、テストケース本体はビジネスロジックの検証に集中できる (`packages/y-partyserver/src/tests/index.test.ts:28-162`)。

- **vitest 設定の分割で重いテストを分離する**: y-partyserver は通常テスト（workerd プール）、hibernation テスト（120s タイムアウト）、integration テスト（globalSetup で wrangler dev 起動）を別設定ファイルで管理し、`npm run check:test` では軽量テストのみ実行する。

## Anti-Patterns / 注意点

- **CI スキップの多用**: partysocket の全テストスイートが `describe.skipIf(!!process.env.GITHUB_ACTIONS)` でスキップされており、CI でのリグレッション検出ができない。WebSocketServer のポートバインドが CI で不安定という問題に対して、テストをスキップするのではなく、ランダムポート割り当てやテスト分離で解決すべき。

```typescript
// Bad: CI で全テストスキップ
describe.skipIf(!!process.env.GITHUB_ACTIONS)(
  "Error Handling - URL Providers",
  () => {/* ... */},
);

// Better: ランダムポートで競合回避
const server = await createServer(0); // OS に空きポートを割り当てさせる
const port = (server.address() as AddressInfo).port;
```

- **マジックナンバーのタイムアウト**: `await new Promise((r) => setTimeout(r, 300))` のような固定待機時間がテスト全体に散見される。ネットワーク状態やマシン負荷によってフレーキーテストになりやすい。イベント駆動の待機（`waitForSync`, `waitForConnection` のようなヘルパー）を優先すべき。

```typescript
// Bad: 固定待機
await new Promise((r) => setTimeout(r, 500));

// Better: 条件ベースの待機
await waitUntil(() => doc.getText("shared").toString() === expected);
```

## 導出ルール

- `[MUST]` Durable Objects / Actor ベースのテストでは、テストシナリオごとに専用のサブクラスを定義し、バインディングとして登録する -- テスト間の状態干渉を構造的に排除できる
  - 根拠: partyserver は 16 の DO サブクラスで各テストシナリオを分離し、`isolatedStorage: false` でも安全にテストできている (`packages/partyserver/src/tests/worker.ts`)

- `[MUST]` WebSocket テストではコールバック内のアサーション失敗を Promise の reject で伝搬する -- コールバック内の例外は Vitest のテストランナーに捕捉されないため、テストが意図せず成功する
  - 根拠: 全 WebSocket テストで `Promise.withResolvers` + try/catch/reject パターンが一貫して使われている (`packages/partyserver/src/tests/index.test.ts:38-53`)

- `[SHOULD]` テスト階層ごとに Vitest 設定ファイルを分割する（ユニット / インテグレーション / E2E） -- CI の高速フィードバックループと信頼性検証を両立できる
  - 根拠: y-partyserver は 3 つの vitest 設定で軽量テスト（デフォルト実行）と重量テスト（明示実行）を分離している (`packages/y-partyserver/src/tests/vitest*.config.ts`)

- `[SHOULD]` プロトコル操作やインフラ操作をテストヘルパーに抽出し、テストケース本体はビジネスロジックの検証に集中させる
  - 根拠: y-partyserver のテストでは 9 つのヘルパー関数が Yjs プロトコルの複雑さを吸収し、テストケースは「何を検証するか」だけを表現している (`packages/y-partyserver/src/tests/index.test.ts:28-162`)

- `[SHOULD]` 外部プロセスを使うテストではサーバーハーネスクラスを作成し、`start/stop/restart/cleanup` のライフサイクルを制御可能にする
  - 根拠: `WranglerServer` クラスがプロセス管理・ポート待機・永続ディレクトリのクリーンアップを一元化している (`packages/y-partyserver/src/tests/server-harness.ts`)

- `[AVOID]` CI 環境でのテスト全スキップ -- ポートバインドの問題はランダムポート割り当てで解決し、不安定なテストは個別に修正すべき
  - 根拠: partysocket の全テストスイートが `describe.skipIf(!!process.env.GITHUB_ACTIONS)` でスキップされており、CI でのリグレッション検出が機能していない

- `[AVOID]` 固定待機時間（`setTimeout` + 固定ms）によるテスト同期 -- イベント駆動の待機（ポーリング + タイムアウト）に置き換えることで、フレーキーテストを減らせる
  - 根拠: hibernation テストでは `waitForSync`, `waitForReconnectAndSync` のイベント駆動ヘルパーが使われている一方、多くのテストで `await new Promise((r) => setTimeout(r, 300))` が併用されている

## 適用チェックリスト

- [ ] Durable Objects / Actor のテストで、テストシナリオごとに専用サブクラスを定義しているか
- [ ] `wrangler.jsonc`（または相当の設定）で全テスト DO をバインディングとして登録しているか
- [ ] WebSocket テストでコールバック内のアサーション失敗が reject で伝搬されるか（silent pass を防ぐ）
- [ ] テスト階層（ユニット / インテグレーション / E2E）ごとに Vitest 設定ファイルが分離されているか
- [ ] プロトコル操作・接続管理のヘルパー関数がテストユーティリティとして抽出されているか
- [ ] `@vitest-environment` ディレクティブで各テストファイルの実行環境が明示されているか
- [ ] 外部プロセス（wrangler dev 等）のライフサイクル管理がハーネスクラスに集約されているか
- [ ] 固定待機時間の代わりにイベント駆動の待機ヘルパーを使っているか
- [ ] CI でスキップされるテストが最小限に抑えられているか
