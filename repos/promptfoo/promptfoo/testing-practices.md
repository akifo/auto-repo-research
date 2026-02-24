# testing-practices

> リポジトリ: promptfoo/promptfoo
> 分析日: 2026-02-21

## 概要

promptfoo は 625 以上のテストファイルを持つ大規模 TypeScript プロジェクトで、Vitest を基盤に unit / integration / smoke の 3 層テスト戦略を採用している。各層は独立した Vitest 設定ファイルで管理され、テスト対象・実行環境・タイムアウトが明確に分離されている。特に注目すべきは、`pool: 'forks'` によるプロセス分離、`sequence.shuffle: true` によるランダム順序実行、そしてモック分離の多層戦略（`clearAllMocks` vs `mockReset` の使い分け）である。これらの設計判断はすべて「テスト間の隠れた依存を早期に検出し、大規模テストスイートの信頼性を担保する」という一貫した原則に基づいている。

## 背景にある原則

- **プロセス分離による完全な環境リセット**: worker threads ではなく forks（子プロセス）を使うことで、テストワーカーが終了した時点で OS がメモリを完全回収する。スレッドベースではメインプロセスとメモリを共有するためリークが蓄積する。根拠: `vitest.config.ts:28-31` のコメント "When a fork dies or is recycled, the OS fully reclaims its memory. Worker threads share memory with the main process and can leak."

- **テスト順序非依存の強制**: ランダム順序実行をデフォルトにすることで、共有状態への暗黙の依存をテスト時点で検出する。順序固定は問題の先送りにすぎない。根拠: `vitest.config.ts:22-24` "Run tests in random order to catch test isolation issues early. Tests should not depend on execution order or shared state."

- **タイムアウト延長は解決策ではない**: 遅いテストの根本原因を修正すべきであり、タイムアウトを延ばすことは問題を隠蔽する。根拠: `test/AGENTS.md:27` "NEVER increase test timeouts - fix the slow test"

- **テスト層ごとの責務分離**: unit テストはソースコードの振る舞い、integration テストはモジュール間の結合、smoke テストはビルド成果物の動作保証と、各層の責務を明確に分ける。これにより、テスト失敗時の原因特定が容易になる。

## 実例と分析

### 3 層テスト設定の分離

3 つの Vitest 設定ファイルが、各テスト層のリソース制約と実行特性を明確に定義している。

| 設定                           | テスト対象                 | タイムアウト | シャッフル | メモリ上限 |
| ------------------------------ | -------------------------- | ------------ | ---------- | ---------- |
| `vitest.config.ts`             | `test/**/*.test.ts` (unit) | 30s          | true       | 3GB/worker |
| `vitest.integration.config.ts` | `**/*.integration.test.ts` | 60s          | true       | 4GB/worker |
| `vitest.smoke.config.ts`       | `test/smoke/**/*.test.ts`  | 30s          | false      | (既定値)   |

unit テストの設定は integration テストを明示的に除外し (`exclude: ['**/*.integration.test.ts']`)、smoke テストは順序固定 (`shuffle: false`) で予測可能な出力を保証する。CI 環境では `bail: 1` で最初の失敗で即座に停止する。

### グローバルセットアップによる環境分離

```typescript
// vitest.setup.ts:9-16
const TEST_CONFIG_DIR = "./.local/vitest/config";
process.env.NODE_ENV = "test";
process.env.PROMPTFOO_CACHE_TYPE = "memory";
process.env.IS_TESTING = "true";
process.env.PROMPTFOO_CONFIG_DIR = TEST_CONFIG_DIR;
```

テスト環境ではキャッシュをメモリに、データベースをインメモリ SQLite に切り替える。ダミー API キーを設定してプロバイダのインスタンス化が認証エラーなしで動作するようにしている。

### グローバル afterEach によるタイマー・モックの安全ネット

```typescript
// vitest.setup.ts:33-45
afterEach(() => {
  vi.clearAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

afterAll(() => {
  vi.resetModules();
});
```

個別テストファイルが cleanup を忘れても、グローバルセットアップが安全ネットとして機能する。ただし `clearAllMocks()` はコール履歴のクリアのみで実装は残るため、`vi.hoisted()` で作成したモックには `mockReset()` が別途必要になる。

### vi.hoisted() と mockReset() の組み合わせ

```typescript
// test/main.test.ts:13-17
const mockTelemetryShutdown = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockCloseLogger = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockCloseDbIfOpen = vi.hoisted(() => vi.fn());
const mockDispatcherDestroy = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
```

```typescript
// test/main.test.ts:332-337
beforeEach(() => {
  vi.useFakeTimers();
  process.exit = vi.fn() as never;
  mockTelemetryShutdown.mockReset().mockResolvedValue(undefined);
  mockCloseLogger.mockReset().mockResolvedValue(undefined);
  mockCloseDbIfOpen.mockReset();
  mockDispatcherDestroy.mockReset().mockResolvedValue(undefined);
});
```

`vi.hoisted()` はモジュールのモック宣言より前に変数を確立するために使われる。`mockReset()` で実装ごとリセットした後、デフォルトの戻り値を再設定する。この 2 段階のパターンにより、ランダム順序実行でも各テストが一貫した初期状態から開始する。

### Echo プロバイダによるゼロコスト決定的テスト

```typescript
// src/providers/echo.ts:28-53
async callApi(input: string, _options?: Record<string, any>, context?: any): Promise<ProviderResponse> {
  // ...
  const response: ProviderResponse = {
    output: input,
    raw: input,
    cost: 0,
    cached: false,
    tokenUsage: { total: 0, prompt: 0, completion: 0, numRequests: 1 },
    isRefusal: false,
    metadata: context?.metadata || {},
  };
  return response;
}
```

echo プロバイダは入力をそのまま返す。コスト 0、外部依存なし、決定的な出力。smoke テストの fixture 群（`test/smoke/fixtures/configs/basic.yaml` 等）はほぼすべて `providers: [echo]` を使い、LLM API を呼び出さずにパイプライン全体を検証している。

### Smoke テストの spawnSync パターン

```typescript
// test/smoke/cli.test.ts:23-39
function runCli(
  args: string[],
  options: { cwd?: string; expectError?: boolean; env?: NodeJS.ProcessEnv; } = {},
): { stdout: string; stderr: string; exitCode: number; } {
  const result = spawnSync("node", [CLI_PATH, ...args], {
    cwd: options.cwd || ROOT_DIR,
    encoding: "utf-8",
    env: { ...process.env, ...options.env, NO_COLOR: "1" },
    timeout: 30000,
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.status ?? 1,
  };
}
```

smoke テストはビルド済みの `dist/src/main.js` を `spawnSync` で実行する。`NO_COLOR: '1'` で ANSI エスケープを抑制し、文字列マッチングを安定させている。`beforeAll` でビルド成果物の存在を確認し、なければ早期エラーを投げる。

### 条件付きスキップによる環境適応

```typescript
// test/python/worker.test.ts:13
const describeOrSkip = process.platform === "win32" && process.env.CI ? describe.skip : describe;

// test/providers/openai-codex-sdk.e2e.test.ts:50
const describeOrSkip = hasApiKey && hasSdk ? describe : describe.skip;

// test/integration/library-exports.integration.test.ts:23
const describeIfBuildExists = buildExists ? describe : describe.skip;
```

環境固有の問題（Windows CI のファイルシステム遅延、API キーの有無、ビルド成果物の有無）に応じてテストを条件付きでスキップする。`.skip()` をコードに直書きせず、変数で制御することで意図が明確になる。

### Zustand ストアの統合テスト

```typescript
// src/app/src/stores/evalConfig.test.ts:1-8
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, useStore } from "./evalConfig";

describe("evalConfig store", () => {
  beforeEach(() => {
    useStore.getState().reset();
  });

  it("should update config with updateConfig", () => {
    useStore.getState().updateConfig({ description: "Test" });
    const { config } = useStore.getState();
    expect(config.description).toBe("Test");
  });
});
```

ストアをモックせず実際のストアを使ってテストする。`getState()` で直接状態を検証し、モック呼び出しの確認ではなく実際の状態変更を検証する。

## パターンカタログ

- **Null Object パターン** (振る舞い)
  - 解決する問題: テスト時に外部 API（LLM）を呼び出さずにパイプラインを検証する必要がある
  - 適用条件: 入出力が決定的であればよいテスト、コストの発生を回避したい場面
  - コード例: `src/providers/echo.ts:5-55` — 入力をそのまま返す EchoProvider
  - 注意点: echo プロバイダは実際の LLM の振る舞い（トークン生成、フィルタリング等）を再現しないため、LLM 固有の振る舞いのテストには使えない

- **Template Method パターン** (振る舞い)
  - 解決する問題: smoke テストごとに CLI 実行のボイラープレートを排除する
  - 適用条件: 同一の実行パターン（spawnSync + 結果パース）を複数テストファイルで共有する場合
  - コード例: `test/smoke/cli.test.ts:23-39`, `test/smoke/eval.test.ts:24-40` — 各ファイルで `runCli` ヘルパーを定義
  - 注意点: 現状は各ファイルで `runCli` を独立定義しており、共通ユーティリティへの集約余地がある

## Good Patterns

- **テスト用共通ユーティリティの型安全な抽象化**: `test/util/mockChildProcess.ts` が `createMockChildProcess()` を提供し、ChildProcess のモック作成を標準化している。オプションオブジェクトで exitCode、stdout/stderr データ、エラーを宣言的に設定でき、イベントハンドラのセットアップを隠蔽する。

```typescript
// test/util/mockChildProcess.ts:72-126
export function createMockChildProcess(options: MockChildProcessOptions = {}): MockChildProcess {
  const { exitCode = 0, error, stdoutData, stderrData, killed = false } = options;
  const mockProcess: MockChildProcess = {
    stdout: { on: vi.fn().mockImplementation((event, callback) => {/* ... */}) },
    stderr: { on: vi.fn().mockImplementation((event, callback) => {/* ... */}) },
    killed,
    kill: vi.fn(),
    on: vi.fn().mockImplementation(function(event, callback) {/* ... */}),
  };
  return mockProcess;
}
```

- **Fake timers での非同期コード検証**: 非同期関数と fake timers を組み合わせる際、promise を `await` せずに先にタイマーを進める「start-advance-await」パターンを一貫して使用している。

```typescript
// test/main.test.ts:346-358
it("should complete gracefully when all operations succeed quickly", async () => {
  const shutdownPromise = shutdownGracefully();
  await vi.runAllTimersAsync(); // タイマーを先に進める
  await shutdownPromise; // 結果を受け取る
  expect(mockTelemetryShutdown).toHaveBeenCalled();
});
```

- **テスト用リトライポリシーの高速化**: テスト専用の高速リトライポリシーを定義し、本番のリトライ遅延をテスト時に排除している。

```typescript
// test/scheduler/providerRateLimitState.test.ts:4-9
const FAST_RETRY_POLICY = {
  maxRetries: 3,
  baseDelayMs: 1, // 本番: 1000ms
  maxDelayMs: 10, // 本番: 60000ms
  jitterFactor: 0,
};
```

## Anti-Patterns / 注意点

- **clearAllMocks のみでの不完全なリセット**: `vi.clearAllMocks()` はコール履歴 (`.mock.calls`, `.mock.results`) のみをクリアし、`mockReturnValue()` や `mockResolvedValue()` で設定した実装はリセットしない。ランダム順序実行でテスト A が設定した戻り値がテスト B に漏れる。

```typescript
// Bad: clearAllMocks だけでは mockReturnValue が残る
beforeEach(() => {
  vi.clearAllMocks();
});

// Better: vi.hoisted() で作成したモックには mockReset() を使う
beforeEach(() => {
  vi.clearAllMocks();
  mockMyFunction.mockReset().mockResolvedValue(defaultValue);
});
```

- **ストアのモックによる統合カバレッジの喪失**: Zustand ストアをモックすると、ストアのロジック（バリデーション、変換、副作用）がテストされない。モック呼び出しの確認は「呼ばれたか」を検証するだけで「正しく動くか」を検証しない。

```typescript
// Bad: ストアをモックして呼び出し確認のみ
vi.mock("./useMyStore");
const mockUpdate = vi.fn();
test("calls update", () => {
  fireEvent.click(button);
  expect(mockUpdate).toHaveBeenCalled(); // ストアロジック未検証
});

// Better: 実ストアで状態変更を検証
test("updates store correctly", async () => {
  render(<MyComponent />);
  await user.click(button);
  expect(useMyStore.getState().items).toHaveLength(1); // 実際の状態を検証
});
```

## 導出ルール

- `[MUST]` テストスイートの全設定で `pool: 'forks'` を使い、各テストファイルにプロセスレベルの分離を提供する
  - 根拠: promptfoo は 3 つの Vitest 設定すべてで forks を採用し、メモリリークの蓄積を OS レベルで防止している (`vitest.config.ts:31`, `vitest.integration.config.ts:29`, `vitest.smoke.config.ts:21`)

- `[MUST]` `vi.hoisted()` で作成したモックや `mockReturnValue()` を持つモックには `beforeEach` で `mockReset()` を呼んでから再設定する
  - 根拠: `vi.clearAllMocks()` は実装をリセットしないため、ランダム順序実行でテスト間の状態漏洩が起きる (`test/AGENTS.md:74-83`, `test/main.test.ts:332-337`)

- `[SHOULD]` unit テストはランダム順序実行をデフォルトにし、順序固定はデバッグ時のみ使用する
  - 根拠: `sequence.shuffle: true` を unit / integration の両設定でデフォルト化し、テスト間の暗黙の依存を早期検出している (`vitest.config.ts:22-24`)

- `[SHOULD]` 外部 API に依存する smoke テストでは、入力をそのまま返す echo プロバイダ相当のスタブを用意し、ゼロコストで決定的にパイプラインを検証する
  - 根拠: smoke テストの fixture 群はほぼ全て `providers: [echo]` を使い、LLM 呼び出しなしで CLI パイプライン全体を検証している (`test/smoke/fixtures/configs/basic.yaml`)

- `[SHOULD]` fake timers を使う非同期テストでは「promise 開始 → タイマー進行 → promise await」の順序で実行する
  - 根拠: promise を先に await するとタイマーが進まずハングする。promptfoo では `shutdownGracefully` テスト等でこのパターンを一貫して使用 (`test/main.test.ts:346-358`)

- `[SHOULD]` 環境やランタイムに依存するテストは `.skip()` 直書きではなく、条件変数による `describe.skip` の動的切り替えで制御する
  - 根拠: `describeOrSkip = condition ? describe : describe.skip` パターンが Windows CI、API キー有無、ビルド成果物有無の 3 パターンで一貫して使用されている (`test/python/worker.test.ts:13`, `test/providers/openai-codex-sdk.e2e.test.ts:50`)

- `[AVOID]` テストの遅延に対してタイムアウト値を延長して対処すること。根本原因（不要な待機、非効率なセットアップ、外部依存）を修正する
  - 根拠: `test/AGENTS.md:27` で "NEVER increase test timeouts - fix the slow test" と明記されている

- `[AVOID]` 状態管理ストアをモックして呼び出し確認のみ行うテスト。実ストアを使い `getState()` で実際の状態変更を検証する
  - 根拠: `test/AGENTS.md:87-104` でストアモックを明示的に Anti-Pattern とし、統合テストでの実ストア使用を推奨している

## 適用チェックリスト

- [ ] テストランナー設定で `pool: 'forks'` と `isolate: true` を有効にし、テスト間のメモリ分離を確保する
- [ ] `sequence.shuffle: true` をデフォルト設定にし、テスト順序依存を継続的に検出する
- [ ] `vitest.setup.ts` 等のグローバルセットアップで `afterEach` に `clearAllMocks` / `clearAllTimers` / `useRealTimers` を設定する
- [ ] `vi.hoisted()` や `mockReturnValue()` を使うモックには `beforeEach` で `mockReset()` + 再設定を行う
- [ ] 外部 API を使うコンポーネントに対して、入力をそのまま返す echo 相当のスタブプロバイダを用意する
- [ ] smoke テストをビルド成果物に対して実行し、`beforeAll` でビルド成果物の存在を検証する
- [ ] テスト環境変数（`IS_TESTING`, `CACHE_TYPE=memory` 等）でデータベース・キャッシュ・テレメトリを分離する
- [ ] CI 環境では `bail: 1` を設定し、最初の失敗で即座にフィードバックを得る
- [ ] タイマー関連コードのテストでは fake timers + 「promise 開始 → タイマー進行 → await」パターンを使う
- [ ] 環境依存テストは `describeOrSkip` パターンで条件付きスキップを実装する
