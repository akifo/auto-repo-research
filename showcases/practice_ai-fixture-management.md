# Practice: AI Fixture Management

> 出典: [repos/vercel/ai/testing-practices](../repos/vercel/ai/testing-practices.md)
> カテゴリ: practice

## 概要

AI プロバイダー API のテストフィクスチャを「手書き」ではなく「実レスポンスのキャプチャ」で作成・管理するプラクティス。SSE（Server-Sent Events）ストリーミングのチャンクフィクスチャ形式、プロバイダー別のフォーマット差異への対応、型安全なテストサーバーパッケージとの統合を体系化する。AI API のレスポンス形式は予告なく変わりうるため、実データに基づくフィクスチャがテストの信頼性を保証する。

## 背景・文脈

vercel/ai は 50 以上の AI プロバイダーパッケージを持ち、各プロバイダーの API レスポンスをテストで再現する必要がある。AI プロバイダーの API は (1) 同期レスポンス（`doGenerate`）と (2) SSE ストリーミングレスポンス（`doStream`）の 2 種類を持ち、さらにプロバイダーごとに SSE のフォーマットが異なる（OpenAI 形式 vs Event-typed 形式等）。手書きのフィクスチャでは API 仕様の変更を検出できず、テストが実質的に無意味になるリスクがある。

## 実装パターン

### 1. 2 種類のフィクスチャ形式

フィクスチャは `__fixtures__` サブフォルダに保存され、2 つのフォーマットが使い分けられる。

**JSON フィクスチャ** (`.json`) — `doGenerate` の同期レスポンス用。実 API の `response.body` をそのまま保存する。

```
src/responses/__fixtures__/
  ├── generate-text.json           # テキスト生成
  ├── generate-tool-call.json      # ツール呼び出し
  └── generate-structured.json     # 構造化出力
```

**チャンクフィクスチャ** (`.chunks.txt`) — `doStream` のストリーミングレスポンス用。1 行 1 JSON オブジェクト形式で、SSE のデータペイロードのみを保存する。

```
src/responses/__fixtures__/
  ├── stream-text.chunks.txt       # テキストストリーミング
  ├── stream-tool-call.chunks.txt  # ツール呼び出しストリーミング
  └── stream-reasoning.chunks.txt  # 推論ストリーミング
```

### 2. プロバイダー別 SSE フォーマット対応

SSE のフォーマットはプロバイダーによって異なる。フィクスチャローダー関数でこの差異を吸収する。

**OpenAI スタイル**: `data:` プレフィックス + `[DONE]` センチネル

```typescript
// packages/openai/src/responses/openai-responses-language-model.test.ts:81-93
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

**Event-typed スタイル**: `event:` + `data:` プレフィックス（Cohere 等）

```typescript
// packages/cohere/src/cohere-chat-language-model.test.ts:41-59
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

### 3. 型安全テストサーバーとの統合

`@ai-sdk/test-server` パッケージが MSW をラップし、6 種のレスポンスモードを判別共用体で提供する。

```typescript
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

Vitest ライフサイクルとの統合:

```typescript
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

### 4. テストでのフィクスチャ活用パターン

```typescript
// 典型的なプロバイダーテストの構造
import { createTestServer } from "@ai-sdk/test-server/with-vitest";

const server = createTestServer({
  "https://api.openai.com/v1/responses": {},
});

function prepareJsonFixtureResponse(filename: string) {
  server.urls["https://api.openai.com/v1/responses"].response = {
    type: "json-value",
    body: JSON.parse(
      fs.readFileSync(`src/responses/__fixtures__/${filename}.json`, "utf8"),
    ),
  };
}

it("should generate text", async () => {
  prepareJsonFixtureResponse("generate-text");
  const result = await model.doGenerate({/* ... */});
  expect(result.text).toBe("Expected text from fixture");
  // リクエスト内容の検証
  expect(server.calls).toHaveLength(1);
});
```

### 5. controlled-stream による非同期テスト

UI コンポーネントのストリーミング検証では、テスト側がチャンクの送信タイミングを制御する。

```typescript
const controller = new TestResponseController();
server.urls["https://api.openai.com/v1/responses"].response = {
  type: "controlled-stream",
  controller,
};

// テスト側がチャンクを手動で送信
await controller.send('data: {"text": "Hello"}\n\n');
// UI の更新を待って検証
expect(screen.getByText("Hello")).toBeInTheDocument();
await controller.send('data: {"text": " World"}\n\n');
await controller.close();
```

## Good Example

```typescript
// Good: フィクスチャローダーをテストファイル冒頭で定義し、テストケースは宣言的
function prepareJsonFixtureResponse(filename: string) {
  server.urls[API_URL].response = {
    type: "json-value",
    body: JSON.parse(fs.readFileSync(`src/__fixtures__/${filename}.json`, "utf8")),
  };
}

function prepareChunksFixtureResponse(filename: string) {
  const chunks = fs.readFileSync(`src/__fixtures__/${filename}.chunks.txt`, "utf8")
    .split("\n")
    .filter(line => line.trim().length > 0)
    .map(line => `data: ${line}\n\n`);
  chunks.push("data: [DONE]\n\n");
  server.urls[API_URL].response = { type: "stream-chunks", chunks };
}

it("should handle tool calls", async () => {
  prepareJsonFixtureResponse("generate-tool-call"); // 1行でセットアップ完了
  const result = await model.doGenerate({/* ... */});
  expect(result.toolCalls).toHaveLength(1);
});
```

## Bad Example

```typescript
// Bad: フィクスチャを手書きで模倣 — API 仕様変更を検出できない
it("should handle streaming", async () => {
  server.urls[API_URL].response = {
    type: "stream-chunks",
    chunks: [
      'data: {"id":"resp_1","type":"response.output_item.added","output_index":0}\n\n',
      'data: {"id":"resp_1","type":"response.content_part.added","content":{"text":""}}\n\n',
      'data: {"id":"resp_1","type":"response.output_text.delta","delta":"Hello"}\n\n',
      "data: [DONE]\n\n",
    ],
  };
  // → 手書きチャンクは API の実フォーマットと乖離しやすい
});

// Bad: フィクスチャローダーの重複実装
// packages/openai/src/.../test.ts に prepareChunksFixtureResponse
// packages/anthropic/src/.../test.ts にも同名関数を再実装
// → SSE フォーマットの共通パターンはテストサーバーパッケージに集約すべき
```

## 適用ガイド

- **いつ使うか**: AI プロバイダーの API レスポンスをテストで再現する必要がある場合。特にストリーミング（SSE）を扱うプロバイダーで効果が高い
- **フィクスチャのキャプチャ手順**:
  1. テスト用 API キーで実際の API を呼び出す
  2. `saveRawChunks` ヘルパー等でレスポンスをファイルに保存
  3. `.json`（同期）または `.chunks.txt`（ストリーミング）として `__fixtures__/` に配置
  4. テストの `contributing/testing.md` にキャプチャ手順を文書化する
- **SSE フォーマットの差異**: プロバイダーごとに SSE フォーマットが異なるため、フィクスチャローダー関数でフォーマット差異を吸収する。共通パターン（OpenAI スタイル）が多い場合は共通ヘルパーに集約する
- **テストサーバーの分離**: コア（MSW ラッパー）とテストランナー統合（`with-vitest`）を別エントリポイントにすると、将来のテストランナー移行時にコアを再利用できる
- **`controlled-stream`**: UI コンポーネントのストリーミングテストでは、チャンク送信タイミングをテスト側が制御できる `controlled-stream` モードが有効
- **npm パッケージからの除外**: `package.json` の `files` フィールドで `!src/**/__fixtures__` を指定し、フィクスチャが npm パッケージに含まれないようにする

## 参考

- [repos/vercel/ai/testing-practices.md](../repos/vercel/ai/testing-practices.md) — テストサーバーパッケージ、フィクスチャ管理、デュアルランタイムテスト
