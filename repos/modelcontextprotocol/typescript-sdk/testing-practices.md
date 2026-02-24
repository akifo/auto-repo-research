# testing-practices

> リポジトリ: modelcontextprotocol/typescript-sdk
> 分析日: 2026-02-24

## 概要

MCP TypeScript SDK のテスト戦略を分析する。このリポジトリは pnpm モノレポ上で Vitest ワークスペースを構成し、ユニットテスト・統合テスト・仕様準拠テスト（Conformance Test）の 3 層を明確に分離している。特に注目すべきは、プロトコル仕様への準拠を外部ツール（`@modelcontextprotocol/conformance`）で検証する Conformance テスト層と、`InMemoryTransport` による高速なインプロセス統合テストの設計である。テスト専用ワークスペースパッケージ（`test-helpers`, `vitest-config`）をモノレポ内パッケージとして管理するアプローチも、大規模モノレポのテスト基盤として参考になる。

## 背景にある原則

- **テスト層の責務分離**: ユニットテスト（パッケージ内 `test/`）は単一モジュールの振る舞いを高速に検証し、統合テスト（`test/integration/`）はパッケージ間の連携を検証し、Conformance テスト（`test/conformance/`）はプロトコル仕様への準拠を検証する。各層が異なる「何が正しいか」の基準を持つことで、テストの目的が明確になり、失敗原因の特定が容易になる。根拠: `test/` ディレクトリが `conformance/`, `integration/`, `helpers/` の 3 つに分かれ、それぞれ独立した `package.json` と `vitest.config.js` を持つ構成。

- **テストインフラのパッケージ化**: テストヘルパーや Vitest 設定を `workspace:^` で参照するパッケージとして切り出すことで、設定の一元管理とパッケージ間の再利用を実現する。テスト基盤の変更が全パッケージに一括で波及するため、設定のドリフトを防ぐ。根拠: `common/vitest-config/` を全パッケージの `vitest.config.js` が参照し（`import baseConfig from '@modelcontextprotocol/vitest-config'`）、`test/helpers/` を統合テスト・Conformance テスト双方が依存として使用。

- **InMemoryTransport によるテスト高速化**: ネットワーク層を介さずプロトコルの振る舞いを検証するために、`InMemoryTransport.createLinkedPair()` でクライアント・サーバーのペアをインプロセスで接続する。これにより、HTTP サーバーの起動・ポート確保・タイムアウトなどの不安定要因を排除し、テストの速度と決定性を向上させる。根拠: 統合テスト・パッケージ内テストの大半がこのパターンを使用（例: `test/integration/test/server/mcp.test.ts`, `packages/core/test/inMemory.test.ts`）。

- **回帰テストの Issue 紐付け**: バグ修正のテストを Issue 番号付きのファイル名で管理し、再発防止と修正の経緯追跡を両立する。根拠: `test/integration/test/issues/` 配下の `test400.optional-tool-params.test.ts`, `test1277.zod.v4.description.test.ts`, `test_1342OauthErrorHttp200.test.ts` 各ファイルの冒頭に Issue URL のリンクと問題の説明を記載。

## 実例と分析

### Vitest ワークスペース設計

ルートの `vitest.workspace.js` は 1 行で全パッケージの設定を集約する:

```
// vitest.workspace.js:1-3
import { defineWorkspace } from 'vitest/config';
export default defineWorkspace(['packages/**/vitest.config.js']);
```

各パッケージの `vitest.config.js` は共通基盤を継承し、必要に応じて差分のみをマージする。例えば `packages/client/vitest.config.js` はセットアップファイルを追加している:

```javascript
// packages/client/vitest.config.js:1-8
import baseConfig from "@modelcontextprotocol/vitest-config";
import { mergeConfig } from "vitest/config";

export default mergeConfig(baseConfig, {
  test: {
    setupFiles: ["./vitest.setup.js"],
  },
});
```

一方、差分不要のパッケージは単純な re-export で済む:

```javascript
// packages/core/vitest.config.js:1-3
import baseConfig from "@modelcontextprotocol/vitest-config";
export default baseConfig;
```

共通設定（`common/vitest-config/vitest.config.js`）は `vite-tsconfig-paths` プラグインで TypeScript パスエイリアスを解決し、`globals: true` でテスト関数のインポートを省略可能にしている。

### テストヘルパーのパッケージ化

`@modelcontextprotocol/test-helpers` パッケージは 3 つのヘルパーモジュールをエクスポートする:

1. **HTTP ヘルパー** (`helpers/http.ts`): `listenOnRandomPort()` でランダムポートにサーバーを起動し、`createExpressResponseMock()` / `createNodeServerResponseMock()` で Express/Node.js レスポンスのモックを生成
2. **OAuth ヘルパー** (`helpers/oauth.ts`): `createMockOAuthFetch()` で OAuth フロー全体（メタデータ発見・トークン交換）をモックする fetch 関数を提供
3. **Task ヘルパー** (`helpers/tasks.ts`): `waitForTaskStatus()` でポーリングベースの非同期タスク完了待ちを抽象化

これらは統合テスト（`test/integration/`）・Conformance テスト（`test/conformance/`）・パッケージ内テスト（`packages/client/`）から `workspace:^` で参照される。

### InMemoryTransport パターン

テストの大半で使われる中心的なパターンは `InMemoryTransport.createLinkedPair()` である。クライアント・サーバー間の通信をメモリ内で完結させ、実際のプロトコルメッセージの送受信を忠実に再現する:

```typescript
// test/integration/test/server/mcp.test.ts:74-76
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([client.connect(clientTransport), mcpServer.server.connect(serverTransport)]);
```

`Promise.all` による並行接続は、クライアントとサーバーの初期化ハンドシェイクを正しくシミュレートするために必要な慣用句である。このパターンは `test/integration/test/helpers/mcp.ts` の `createInMemoryTaskEnvironment()` でファクトリ関数として抽象化されている。

### Conformance テストのアーキテクチャ

Conformance テストは、SDK の実装が MCP プロトコル仕様に準拠しているかを外部ツール（`@modelcontextprotocol/conformance`）で検証する。テスト対象は SDK 自体ではなく、SDK を使って構築した「Everything Server」と「Everything Client」である:

- **everythingServer.ts**: MCP のすべての機能（tools, resources, prompts, logging, sampling, elicitation, reconnection）を実装した Express サーバー
- **everythingClient.ts**: シナリオ名に基づいて適切なクライアント動作を選択するルーティングクライアント

`everythingClient.ts` のシナリオルーティングは `registerScenario()` / `registerScenarios()` パターンで構成される:

```typescript
// test/conformance/src/everythingClient.ts:62-75
const scenarioHandlers: Record<string, ScenarioHandler> = {};

function registerScenario(name: string, handler: ScenarioHandler): void {
  scenarioHandlers[name] = handler;
}

function registerScenarios(names: string[], handler: ScenarioHandler): void {
  for (const name of names) {
    scenarioHandlers[name] = handler;
  }
}
```

サーバー側の Conformance テストは shell スクリプト（`run-server-conformance.sh`）がサーバープロセスを起動し、外部の conformance ランナーがリクエストを送って検証する。サーバーの起動待ちには `curl` によるポーリングを使用する:

```bash
# test/conformance/scripts/run-server-conformance.sh:29-38
while ! curl -s "${SERVER_URL}" > /dev/null 2>&1; do
    RETRY_COUNT=$((RETRY_COUNT + 1))
    if [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
        echo "Server failed to start after ${MAX_RETRIES} attempts"
        exit 1
    fi
    sleep 0.5
done
```

### 回帰テストのディレクトリパターン

`test/integration/test/issues/` ディレクトリに Issue 番号付きファイルを配置する:

```typescript
// test/integration/test/issues/test400.optional-tool-params.test.ts:1-7
/**
 * Regression test for https://github.com/modelcontextprotocol/typescript-sdk/issues/400
 *
 * When a tool has all optional parameters, some LLM models call the tool without
 * providing an `arguments` field. This test verifies that undefined arguments are
 * handled correctly by defaulting to an empty object.
 */
```

各ファイルの冒頭 JSDoc に Issue URL と問題の再現条件を明記するため、テストが失敗した際に修正の経緯を即座に追跡できる。

### 型の仕様準拠テスト

`packages/core/test/spec.types.test.ts` は、外部仕様（`spec.types.ts`）と SDK 内部型の互換性を静的型チェックとランタイム検証の両方で保証する。型の互換性を `MakeUnknownsNotOptional` のようなユーティリティ型で変換しつつ、型レベルのアサーションを行う:

```typescript
// packages/core/test/spec.types.test.ts:23-27
type IsUnknown<T> = [unknown] extends [T] ? ([T] extends [unknown] ? true : false) : false;
type MakeUnknownsNotOptional<T> =
    IsUnknown<T> extends true
        ? unknown
        : T extends object ? /* ... */ : T;
```

### Validator プロバイダーのパラメタライズテスト

JSON Schema バリデーターのテストは `describe.each` で複数のプロバイダー（AJV, CfWorker）を横断的にテストする:

```typescript
// packages/core/test/validation/validation.test.ts:18-24
const validators = [
    { name: 'AJV', provider: new AjvJsonSchemaValidator() },
    { name: 'CfWorker', provider: new CfWorkerJsonSchemaValidator() }
];

describe.each(validators)('$name Validator', ({ provider }) => {
```

同様のパラメタライズは `test/integration/test/server/elicitation.test.ts` でも使われており、同一のテストスイートを異なるバリデーター構成で実行する `testElicitationFlow()` 関数として抽出されている。

### CI でのマルチノードバージョンテスト

`.github/workflows/main.yml` の `test` ジョブは Node.js 20, 22, 24 のマトリクスで `pnpm test:all` を実行する。`fail-fast: false` により、特定バージョンの失敗が他バージョンのテストをキャンセルしない:

```yaml
# .github/workflows/main.yml:38-41
strategy:
    fail-fast: false
    matrix:
        node-version: [20, 22, 24]
```

`build` ジョブと `test` ジョブは並列実行され、テストはビルド成果物ではなくソースから直接実行される。Conformance テストは `main.yml` のテストスコープ外で独立して実行される設計。

## コード例

```typescript
// packages/core/test/inMemory.test.ts:8-16
// InMemoryTransport のリンクペア生成パターン
let clientTransport: InMemoryTransport;
let serverTransport: InMemoryTransport;

beforeEach(() => {
  [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
});
```

```typescript
// test/integration/test/helpers/mcp.ts:14-70
// テスト環境ファクトリ: InMemoryTransport + TaskStore を一括セットアップ
export async function createInMemoryTaskEnvironment(options?: {
  clientCapabilities?: ClientCapabilities;
  serverCapabilities?: ServerCapabilities;
}): Promise<InMemoryTaskEnvironment> {
  const taskStore = new InMemoryTaskStore();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  // ... client, server 初期化
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server, taskStore, clientTransport, serverTransport };
}
```

```typescript
// test/helpers/src/helpers/http.ts:10-17
// ランダムポートでの HTTP サーバー起動ヘルパー
export async function listenOnRandomPort(server: Server, host: string = "127.0.0.1"): Promise<URL> {
  return new Promise<URL>(resolve => {
    server.listen(0, host, () => {
      const addr = server.address() as AddressInfo;
      resolve(new URL(`http://${host}:${addr.port}`));
    });
  });
}
```

```typescript
// packages/core/test/shared/toolNameValidation.test.ts:19-32
// test.each によるテーブル駆動テスト
test.each`
    description                    | toolName
    ${"simple alphanumeric names"} | ${"getUser"}
    ${"names with underscores"}    | ${"get_user_profile"}
    ${"names with dashes"}         | ${"user-profile-update"}
    ${"names with dots"}           | ${"admin.tools.list"}
`("should accept $description", ({ toolName }) => {
  const result = validateToolName(toolName);
  expect(result.isValid).toBe(true);
  expect(result.warnings).toHaveLength(0);
});
```

## パターンカタログ

- **Linked Pair / Test Double パターン** (分類: 構造)
  - 解決する問題: ネットワーク通信を伴うクライアント・サーバー間テストの遅さと不安定さ
  - 適用条件: プロトコルレイヤーが Transport インターフェースで抽象化されている場合
  - コード例: `packages/core/src/util/inMemory.ts` の `InMemoryTransport.createLinkedPair()`
  - 注意点: Transport 抽象の忠実度が高くないと、実際のネットワーク環境で発生する問題を見逃す

- **Scenario Registry パターン** (分類: 振る舞い)
  - 解決する問題: 複数のテストシナリオを単一のテスト対象（Everything Client/Server）で効率的に管理する
  - 適用条件: 外部テストランナーが環境変数でシナリオを指定する場合
  - コード例: `test/conformance/src/everythingClient.ts:62-75`
  - 注意点: シナリオ数が増えると単一ファイルが肥大化する。ファイル分割の閾値を設けるべき

- **Factory Method パターン** (分類: 生成)
  - 解決する問題: テストごとに繰り返されるセットアップコードの重複
  - 適用条件: クライアント・サーバー・トランスポートの初期化が定型的な場合
  - コード例: `test/integration/test/helpers/mcp.ts:14-70` の `createInMemoryTaskEnvironment()`
  - 注意点: ファクトリのオプションが増えすぎると可読性が下がる。デフォルト値を適切に設定する

## Good Patterns

- **共有 Vitest 設定のパッケージ化**: `common/vitest-config/` を内部パッケージとして公開し、各パッケージが `import baseConfig from '@modelcontextprotocol/vitest-config'` で継承する。設定の一元管理により、テストランナーの設定ドリフトを防止する。差分がある場合は `mergeConfig()` で安全にオーバーライドする。

- **Issue 番号付き回帰テストファイル**: `test/integration/test/issues/test400.optional-tool-params.test.ts` のようにファイル名に Issue 番号を含め、冒頭に Issue URL と問題の説明を JSDoc で記載する。テストが「なぜ存在するか」が一目で分かり、不要な削除を防ぐ。

- **パラメタライズによる実装バリアント横断テスト**: `describe.each(validators)` で AJV と CfWorker の両バリデーターに同一テストスイートを適用する。テストロジックの重複を排除しつつ、実装の入れ替え可能性を保証する。

- **InMemoryTransport による決定論的テスト**: ネットワークスタックを排除したインプロセステストにより、ポート競合・タイムアウト・DNS 解決などの非決定性を排除する。`Promise.all` でのハンドシェイクが正しいテストセットアップの慣用句として確立している。

## Anti-Patterns / 注意点

- **everythingServer の肥大化**: `test/conformance/src/everythingServer.ts` は 1023 行あり、すべての MCP 機能を 1 ファイルに集約している。機能が増えるとファイルが更に肥大化し、変更の影響範囲の把握が困難になる。

```typescript
// Bad: 1 ファイルに全機能を集約
function createMcpServer() {
  // tools, resources, prompts, logging, completion, sampling, elicitation... (800+ 行)
}
```

```typescript
// Better: 機能ごとにモジュール分割し、createMcpServer() から参照する
import { registerResourceScenarios } from "./scenarios/resources.js";
import { registerToolScenarios } from "./scenarios/tools.js";

function createMcpServer() {
  const mcpServer = new McpServer(/* ... */);
  registerToolScenarios(mcpServer);
  registerResourceScenarios(mcpServer);
  return mcpServer;
}
```

- **テストでの `console.log` 残存**: `test/conformance/src/everythingServer.ts` 内に `console.log('Progress token:', progressToken)` などのデバッグ出力が残っている。テスト出力にノイズが混入する原因となる。

## 導出ルール

- `[MUST]` モノレポのテスト設定は共有パッケージとして切り出し、各パッケージから継承する形で管理する
  - 根拠: MCP SDK は `@modelcontextprotocol/vitest-config` を全 13 パッケージの Vitest 設定の基盤とし、設定ドリフトを防止している

- `[MUST]` バグ修正の回帰テストには Issue 番号を含むファイル名を使い、冒頭に Issue URL と問題の説明を記載する
  - 根拠: `test/integration/test/issues/` 配下の全ファイルが Issue URL 付き JSDoc を冒頭に持ち、修正の経緯を即座に追跡可能にしている

- `[SHOULD]` プロトコルやインターフェースのテストでは、ネットワーク層をバイパスするインメモリトランスポートを用意して高速かつ決定論的なテストを実現する
  - 根拠: MCP SDK のユニットテスト・統合テストの大半が `InMemoryTransport.createLinkedPair()` を使用し、ネットワーク由来の不安定さを排除している

- `[SHOULD]` 同一ロジックの実装バリアント（バリデーター、ストレージバックエンド等）は `describe.each` / パラメタライズテストで横断的に検証する
  - 根拠: `validation.test.ts` が AJV と CfWorker の 2 プロバイダーを同一テストスイートで検証し、実装の入れ替え可能性を担保している

- `[SHOULD]` 仕様準拠を検証するテストは通常のユニットテストとは別のテストスイートとして分離し、独立して実行できるようにする
  - 根拠: MCP SDK は `test/conformance/` を独立パッケージとして分離し、外部 conformance ランナーで仕様準拠を検証する設計にしている

- `[SHOULD]` テスト間で繰り返されるセットアップ手順はファクトリ関数に抽出し、オプション引数でカスタマイズ可能にする
  - 根拠: `createInMemoryTaskEnvironment()` がクライアント・サーバー・トランスポート・ストアの初期化を一括で行い、テストコードのボイラープレートを削減している

- `[AVOID]` Conformance テスト対象の「Everything」ファイルを 1 ファイルに集約して肥大化させる
  - 根拠: `everythingServer.ts` が 1000 行超となっており、機能追加時の変更影響範囲が不明瞭になっている

## 適用チェックリスト

- [ ] テスト設定（Vitest/Jest config）をモノレポ内パッケージとして切り出し、各パッケージから `import` / `extends` で継承しているか
- [ ] ユニットテスト・統合テスト・仕様準拠テストの 3 層が明確に分離されているか（ディレクトリ構成・実行コマンド・CI ジョブ）
- [ ] プロトコル層のテストにインメモリトランスポート（または同等の機構）を用意しているか
- [ ] バグ修正時に Issue 番号を含む回帰テストファイルを作成し、Issue URL を冒頭に記載しているか
- [ ] 同一インターフェースの複数実装がある場合、パラメタライズテストで横断的に検証しているか
- [ ] テストヘルパー（モック生成、環境セットアップ）を共有パッケージまたは共有モジュールとして整理しているか
- [ ] CI でマルチバージョン（Node.js 等のランタイム）マトリクステストを `fail-fast: false` で実行しているか
- [ ] テストファイルにデバッグ用 `console.log` が残存していないか
