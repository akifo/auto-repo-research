# testing-practices

> リポジトリ: vercel/ai
> 分析日: 2026-02-20

## 概要

vercel/ai は 50 以上のプロバイダパッケージと UI フレームワークバインディングを持つ大規模モノレポであり、テスト戦略にはランタイム互換性の保証、プロバイダ間のテストパターン統一、実 API レスポンスに基づくフィクスチャ管理という独自の課題がある。同一テストスイートを Edge Runtime と Node.js の両環境で実行する「デュアルランタイムテスト」、Vitest の `typecheck` 機能を活用した型レベルテスト、MSW ベースの型安全テストサーバーパッケージなど、マルチプラットフォーム SDK に特化したプラクティスが体系的に整備されている。

## 背景にある原則

- **ランタイム非依存の品質保証**: Edge Runtime（Cloudflare Workers 等）と Node.js では利用可能な API が異なるため、同一テストを両環境で実行することでランタイム固有の不具合を早期発見すべき。`vitest.edge.config.js` と `vitest.node.config.js` を分離し、`test: "pnpm test:node && pnpm test:edge"` で直列実行する設計がこの原則を体現している（全 40+ パッケージで統一）。

- **実レスポンスに基づくフィクスチャ駆動テスト**: API プロバイダのレスポンス形式は予告なく変わりうるため、テストフィクスチャは実際の API レスポンスをキャプチャして保存すべき。`saveRawChunks` ヘルパーや `contributing/testing.md` のガイドラインが、フィクスチャを「手書き」ではなく「実データのキャプチャ」で作成する文化を根付かせている。

- **テストインフラの共有パッケージ化**: 50 以上のプロバイダパッケージが同じテストパターンを使う場合、テストユーティリティを `@ai-sdk/test-server` や `@ai-sdk/provider-utils/test` として独立パッケージにすべき。これにより、テストサーバーのセットアップ・リセット・停止のライフサイクルが一箇所に集約され、各プロバイダはフィクスチャの読み込みと検証に集中できる。

- **型の正しさはランタイムテストとは別レイヤーで検証すべき**: ジェネリクスを多用する SDK では、型推論の正しさをランタイムテストだけでは保証できない。`*.test-d.ts` ファイルで `expectTypeOf` を使い、出力型の推論・ツール型の整合性を独立して検証することで、型回帰を防止する。

## 実例と分析

### デュアルランタイムテスト（Edge/Node 分離）

全プロバイダパッケージが同一のパターンで Edge と Node のテストを分離している。Vitest の `environment` 設定のみが異なり、テストファイル自体は共通。

```js
// packages/openai/vitest.edge.config.js:8-16
export default defineConfig({
  test: {
    environment: "edge-runtime",
    include: ["**/*.test.ts", "**/*.test.tsx"],
  },
  define: {
    __PACKAGE_VERSION__: JSON.stringify(version),
  },
});
```

```js
// packages/openai/vitest.node.config.js:8-16
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx"],
  },
  define: {
    __PACKAGE_VERSION__: JSON.stringify(version),
  },
});
```

`ai` コアパッケージでは UI テストと E2E テストを除外し、さらに型チェックを有効化している。

```js
// packages/ai/vitest.node.config.js:9-24
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts{,x}"],
    exclude: [
      "**/*.ui.test.ts{,x}",
      "**/*.e2e.test.ts{,x}",
      "**/node_modules/**",
    ],
    typecheck: {
      enabled: true,
    },
  },
});
```

Node バージョン依存のテストは `isNodeVersion` ヘルパーと `it.skipIf` で条件付きスキップされる。

```ts
// packages/openai/src/chat/openai-chat-language-model.test.ts:2943
it.skipIf(isNodeVersion(20))(
  "should handle unparsable stream parts",
  async () => {/* ... */},
);
```

### 型テスト（test-d.ts）

`*.test-d.ts` ファイルは Vitest の `typecheck.enabled: true` と組み合わせて使用される。13 ファイルがコードベース全体に存在し、主に以下を検証する。

1. **ジェネリック出力型の推論** -- `Output.text()`, `Output.object()`, `Output.array()` 等の出力型が正しく推論されること。

```ts
// packages/ai/src/generate-text/generate-text.test-d.ts:9-16
it("should infer text output type (default)", async () => {
  const result = await generateText({
    model: new MockLanguageModelV3(),
    prompt: "Hello, world!",
  });
  expectTypeOf<typeof result.output>().toEqualTypeOf<string>();
});
```

2. **ツール型のディスクリミネーション** -- `onToolCall` コールバックの引数型がツール定義から正しく導出されること。

```ts
// packages/ai/src/ui/chat.test-d.ts:56-87
it("multiple tools with output schema", () => {
  type Tools = {
    simple: { input: number; output: string; };
    complex: { input: { title: string; description: string; }; output: Array<{ message: string; }>; };
  };
  expectTypeOf<ToolCallArgument<Tools> & { dynamic?: false; }>().toMatchTypeOf<
    | { toolName: "simple"; input: number; }
    | { toolName: "complex"; input: { title: string; description: string; }; }
  >();
});
```

3. **コンパイルエラーの意図的検証** -- `@ts-expect-error` を使って「許可されていない引数」が型エラーになることを確認。

```ts
// packages/ai/src/agent/tool-loop-agent.test-d.ts:43-47
await agent.generate({
  // @ts-expect-error - system prompt is not allowed
  system: "123",
  prompt: "Hello, world!",
});
```

### テストサーバーパッケージ（@ai-sdk/test-server）

MSW（Mock Service Worker）をラップした型安全なテストサーバーが独立パッケージとして提供される。2 つのエントリポイントを持つ。

- `@ai-sdk/test-server` -- フレームワーク非依存のコア
- `@ai-sdk/test-server/with-vitest` -- Vitest ライフサイクル統合済み

```ts
// packages/test-server/src/with-vitest.ts:10-54
export function createTestServer<URLS>(routes: URLS) {
  const server = createCoreTestServer(routes);
  beforeAll(() => {
    server.server.start();
  });
  beforeEach(() => {
    server.server.reset();
  });
  afterAll(() => {
    server.server.stop();
  });
  return {
    urls: server.urls,
    get calls() {
      return server.calls;
    },
  };
}
```

レスポンス型は判別共用体（Discriminated Union）で 6 種のレスポンスモードをサポートする。

```ts
// packages/test-server/src/create-test-server.ts:5-37
export type UrlResponse =
  | { type: "json-value"; headers?: Record<string, string>; body: JsonBodyType; }
  | { type: "stream-chunks"; headers?: Record<string, string>; chunks: Array<string>; }
  | { type: "controlled-stream"; headers?: Record<string, string>; controller: TestResponseController; }
  | { type: "binary"; headers?: Record<string, string>; body: Buffer; }
  | { type: "error"; headers?: Record<string, string>; status?: number; body?: string; }
  | { type: "empty"; headers?: Record<string, string>; status?: number; }
  | undefined;
```

`controlled-stream` は非同期テスト（UI コンポーネントのストリーミング検証等）で使用され、テスト側がチャンクの送信タイミングを制御できる。

### フィクスチャ管理

フィクスチャは `__fixtures__` サブフォルダに保存され、2 つのフォーマットが使われる。

1. **JSON フィクスチャ** (`.json`) -- `doGenerate` の同期レスポンス用。実 API の `response.body` をそのまま保存。
2. **チャンクフィクスチャ** (`.chunks.txt`) -- `doStream` のストリーミングレスポンス用。1 行 1 JSON オブジェクト形式。

プロバイダごとにフィクスチャの読み込み方法が異なる。これは各プロバイダの SSE フォーマットの違いを反映している。

```ts
// packages/openai/src/responses/openai-responses-language-model.test.ts:81-93
// OpenAI-style SSE: data: prefix + [DONE] sentinel
function prepareChunksFixtureResponse(filename: string) {
  const chunks = fs
    .readFileSync(`src/responses/__fixtures__/${filename}.chunks.txt`, "utf8")
    .split("\n")
    .filter(line => line.trim().length > 0)
    .map(line => `data: ${line}\n\n`);
  chunks.push("data: [DONE]\n\n");
  server.urls["https://api.openai.com/v1/responses"].response = {
    type: "stream-chunks",
    chunks,
  };
}
```

```ts
// packages/cohere/src/cohere-chat-language-model.test.ts:41-59
// Event-typed SSE: event: + data: prefix
function prepareChunksFixtureResponse(filename: string) {
  const chunks = fs
    .readFileSync(`src/__fixtures__/${filename}.chunks.txt`, "utf8")
    .split("\n")
    .filter(line => line.trim() !== "")
    .map(line => {
      const parsed = JSON.parse(line);
      return `event: ${parsed.type}\ndata: ${line}\n\n`;
    });
  server.urls["https://api.cohere.com/v2/chat"].response = {
    type: "stream-chunks",
    chunks,
  };
}
```

### モックオブジェクト設計

モックは `src/test/` ディレクトリに集約され、`ai/test` エクスポートとして外部公開される。

```ts
// packages/ai/src/test/mock-language-model-v3.ts:9-77
export class MockLanguageModelV3 implements LanguageModelV3 {
  doGenerateCalls: LanguageModelV3CallOptions[] = [];
  doStreamCalls: LanguageModelV3CallOptions[] = [];

  constructor({
    doGenerate = notImplemented,
    doStream = notImplemented,
  }) {
    this.doGenerate = async options => {
      this.doGenerateCalls.push(options);
      if (typeof doGenerate === "function") return doGenerate(options);
      else if (Array.isArray(doGenerate)) return doGenerate[this.doGenerateCalls.length];
      else return doGenerate;
    };
  }
}
```

設計上の特徴:

- **3 モード入力**: コンストラクタ引数として関数・単一値・配列を受け付ける。テストの記述量を最小化する工夫。
- **呼び出し記録**: `doGenerateCalls`/`doStreamCalls` でテスト側がリクエスト内容を検証可能。
- **`notImplemented` デフォルト**: 未設定のメソッドは明確なエラーで失敗する。

`mockValues` は連続呼び出しで異なる値を返すシンプルなヘルパー。

```ts
// packages/ai/src/test/mock-values.ts:1-4
export function mockValues<T>(...values: T[]): () => T {
  let counter = 0;
  return () => values[counter++] ?? values[values.length - 1];
}
```

### UI コンポーネントテスト環境分離

React/Vue/Svelte/Angular の UI テストは独自の Vitest 設定を持ち、`jsdom` 環境で実行される。ファイル命名規則で Edge/Node テストと分離される。

```js
// packages/react/vitest.config.js:5-11
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.ui.test.ts", "src/**/*.ui.test.tsx"],
  },
});
```

React テストでは `setupTestComponent` ヘルパーが SWR キャッシュの分離を保証する。

```tsx
// packages/react/src/setup-test-component.tsx:5-26
export const setupTestComponent = (TestComponent, { init } = {}) => {
  beforeEach(() => {
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        {init?.(TestComponent) ?? <TestComponent />}
      </SWRConfig>,
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });
};
```

## パターンカタログ

- **Strategy パターン** (振る舞い)
  - 解決する問題: プロバイダごとに異なる SSE フォーマットのフィクスチャ読み込み
  - 適用条件: 同一インターフェースで振る舞いが異なる実装が複数存在する場合
  - コード例: 各プロバイダの `prepareChunksFixtureResponse` 関数
  - 注意点: Strategy をテストヘルパーとして各テストファイルに定義し、共通のテストサーバーと組み合わせている

- **Null Object パターン** (振る舞い)
  - 解決する問題: モックの未設定メソッドが `undefined` を返すと、バグの原因が不明瞭になる
  - 適用条件: モックオブジェクトで未実装メソッドの明示的な失敗が必要な場合
  - コード例: `packages/ai/src/test/not-implemented.ts:1-3`
  - 注意点: `notImplemented` はエラーを投げる明示的な失敗であり、黙って `undefined` を返す Null Object の逆パターン

## Good Patterns

- **テストサーバーのフレームワーク分離**: `@ai-sdk/test-server` はコア部分（MSW ラッパー）と Vitest 統合部分（`with-vitest`）を分離エクスポートしている。これにより、将来 Jest や他のフレームワークに移行しても、コアのテストサーバーロジックを再利用できる。

```ts
// packages/test-server/package.json:34-44
"exports": {
  ".": { /* コア */ },
  "./with-vitest": { /* Vitest 統合 */ }
}
```

- **テストユーティリティの公開エクスポート**: `ai/test` や `@ai-sdk/provider-utils/test` としてモックやユーティリティを公開している。SDK のユーザーが自身のプロバイダ実装をテストする際にも同じ道具を使える。

```ts
// packages/ai/test/index.ts:1-14
export { MockEmbeddingModelV3 } from "../src/test/mock-embedding-model-v3";
export { MockLanguageModelV3 } from "../src/test/mock-language-model-v3";
// ...
```

- **Turborepo のテスト依存関係**: `test` タスクが `^build` と `build` に依存するよう設定されている。テストが常にビルド済みの成果物に対して実行されることを保証する。

```json
// turbo.json:80-82
"test": {
  "dependsOn": ["^build", "build"]
}
```

- **`package.json` の `files` フィールドによるテスト除外**: テストファイル・フィクスチャ・スナップショットが npm パッケージに含まれないよう明示的に除外している。

```json
// packages/openai/package.json:10-19
"files": [
  "dist/**/*",
  "src",
  "!src/**/*.test.ts",
  "!src/**/*.test-d.ts",
  "!src/**/__snapshots__",
  "!src/**/__fixtures__",
]
```

## Anti-Patterns / 注意点

- **フィクスチャ読み込みロジックの重複**: 各プロバイダテストファイルに `prepareJsonFixtureResponse` / `prepareChunksFixtureResponse` が個別に定義されている。SSE フォーマットの違いがあるとはいえ、共通パターン（OpenAI スタイル）は多く、ヘルパー関数の共有余地がある。

```ts
// Bad: 各プロバイダで同一パターンを再実装
// packages/openai/src/responses/openai-responses-language-model.test.ts:71-93
function prepareJsonFixtureResponse(filename: string) {/* ... */}
function prepareChunksFixtureResponse(filename: string) {/* ... */}

// packages/anthropic/src/anthropic-messages-language-model.test.ts:38-59
function prepareJsonFixtureResponse(filename: string) {/* ... */}
function prepareChunksFixtureResponse(filename: string) {/* ... */}
```

```ts
// Better: SSE フォーマットごとのフィクスチャローダーをテストサーバーパッケージに集約
// @ai-sdk/test-server/fixtures
export function createOpenAIStyleFixtureLoader(server, url, fixtureDir) {/* ... */}
export function createEventTypedFixtureLoader(server, url, fixtureDir) {/* ... */}
```

## 導出ルール

- `[MUST]` マルチランタイムをサポートする SDK では、同一テストスイートを各ターゲットランタイム環境で実行する設定を用意する
  - 根拠: vercel/ai は全 40+ パッケージで `vitest.edge.config.js` と `vitest.node.config.js` を分離し、`test: "pnpm test:node && pnpm test:edge"` で両環境での動作を保証している

- `[MUST]` テストフィクスチャは実際の API レスポンスをキャプチャして作成し、手書きで模倣しない
  - 根拠: `contributing/testing.md` と `saveRawChunks` ヘルパーが、実 API レスポンスのキャプチャワークフローを標準化しており、レスポンス形式の変更を正確に検出できる

- `[SHOULD]` ジェネリクスを多用するライブラリでは `*.test-d.ts` ファイルで型推論の正しさを独立して検証する
  - 根拠: vercel/ai は 13 の `test-d.ts` ファイルで `expectTypeOf` を使い、出力型推論やツール型のディスクリミネーションを検証している。ランタイムテストでは型の回帰を検出できない

- `[SHOULD]` モノレポのテストユーティリティは独立パッケージとして切り出し、ライフサイクル統合は別エントリポイントで提供する
  - 根拠: `@ai-sdk/test-server` はコア（MSW ラッパー）と `with-vitest`（ライフサイクル統合）を分離し、90+ のテストファイルが統一されたパターンでテストサーバーを利用している

- `[SHOULD]` モックオブジェクトのコンストラクタは「関数・単一値・配列」の 3 モード入力を受け付け、テストの記述量を最小化する
  - 根拠: `MockLanguageModelV3` は `doGenerate` に関数（カスタムロジック）・単一値（固定レスポンス）・配列（連続呼び出し）を渡せる設計で、テストケースの大半が 1-3 行で応答を設定できる

- `[SHOULD]` Turborepo 等のビルドオーケストレーターでテストタスクをビルドタスクに依存させ、テストが常にビルド済み成果物に対して実行されることを保証する
  - 根拠: `turbo.json` で `"test": { "dependsOn": ["^build", "build"] }` を設定し、ワークスペース間の依存関係を含めたビルド完了後にテストが実行される

- `[AVOID]` テストファイルの命名規則をランタイム環境の分離に活用せず、Vitest の `include`/`exclude` だけに頼る
  - 根拠: vercel/ai は `*.ui.test.ts` (jsdom)、`*.e2e.test.ts` (Playwright)、`*.test.ts` (Node/Edge) と命名規則で明確に分類し、各 vitest config の `exclude` で相互排他的に実行している

## 適用チェックリスト

- [ ] マルチランタイム（Node/Edge/Bun 等）をサポートする場合、ランタイムごとの Vitest 設定ファイルを用意しているか
- [ ] テストフィクスチャの作成ワークフロー（実 API レスポンスのキャプチャ手順）を文書化しているか
- [ ] ジェネリクスを多用する公開 API に対して `*.test-d.ts` ファイルで型テストを書いているか
- [ ] モノレポのテストユーティリティが独立パッケージとして切り出され、テストランナーとの統合が分離されているか
- [ ] テストファイルの命名規則（`*.ui.test.ts`、`*.e2e.test.ts` 等）がランタイム環境に対応しているか
- [ ] モックオブジェクトが呼び出し記録を保持し、リクエスト内容の検証を可能にしているか
- [ ] npm パッケージの `files` フィールドでテスト関連ファイルを明示的に除外しているか
- [ ] ビルドオーケストレーターでテストタスクがビルド完了後に実行されるよう依存関係を設定しているか
