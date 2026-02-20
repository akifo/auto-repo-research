# Practice: LLM Mock Design

> 出典: [repos/vercel/ai/testing-practices](../repos/vercel/ai/testing-practices.md), [repos/langchain-ai/langchainjs/testing-practices](../repos/langchain-ai/langchainjs/testing-practices.md), [repos/mastra-ai/mastra/testing-practices](../repos/mastra-ai/mastra/testing-practices.md)
> カテゴリ: practice

## 概要

LLM（大規模言語モデル）のテストでは、API 呼び出しをモックする必要があるが、通常の HTTP モックとは異なり「生成テキスト・ストリーミングチャンク・ツール呼び出し」という多様な出力形態を扱う必要がある。3 つの主要 AI フレームワークが独立に到達したモック設計を統合し、(1) コンストラクタの 3 モード入力、(2) 忠実度別バリエーション、(3) 呼び出し記録による検証という 3 つの設計原則を体系化する。

## 背景・文脈

AI アプリケーションのテストでは、LLM API への依存を切り離す必要がある。しかし LLM の出力は非決定的であり、レスポンス構造も generate（同期）と stream（非同期チャンク）で大きく異なる。さらにツール呼び出し（function calling）やマルチモーダル入力など、テストで再現すべき振る舞いは多岐にわたる。

vercel/ai（AI SDK）、langchain-ai/langchainjs（LangChain.js）、mastra-ai/mastra の 3 つの主要フレームワークが、それぞれ独立にモックオブジェクト設計を進化させた結果、共通する設計パターンが浮かび上がった。

## 実装パターン

### 1. 3 モード入力コンストラクタ（vercel/ai）

`MockLanguageModelV3` は `doGenerate` / `doStream` のコンストラクタ引数に 3 つの形式を受け付ける。テストの記述量を最小化する鍵は、このコンストラクタの柔軟性にある。

```typescript
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
      // モード 1: 関数 — カスタムロジック
      if (typeof doGenerate === "function") return doGenerate(options);
      // モード 2: 配列 — 連続呼び出しで異なる値を返す
      else if (Array.isArray(doGenerate)) return doGenerate[this.doGenerateCalls.length];
      // モード 3: 単一値 — 固定レスポンス
      else return doGenerate;
    };
  }
}
```

3 モードの使い分け:

```typescript
// モード 3: 固定レスポンス — 最も簡潔（大半のテストはこれで十分）
const model = new MockLanguageModelV3({
  doGenerate: { text: "Hello, world!", usage: { inputTokens: 10, outputTokens: 5 } },
});

// モード 2: 配列 — リトライやマルチターンのテスト
const model = new MockLanguageModelV3({
  doGenerate: [
    { text: "First response", usage: { inputTokens: 10, outputTokens: 5 } },
    { text: "Second response", usage: { inputTokens: 12, outputTokens: 6 } },
  ],
});

// モード 1: 関数 — 入力に応じた動的レスポンス
const model = new MockLanguageModelV3({
  doGenerate: async (options) => ({
    text: `Echo: ${options.prompt[0].content}`,
    usage: { inputTokens: 10, outputTokens: 5 },
  }),
});
```

連続呼び出しヘルパー `mockValues` も提供される:

```typescript
// packages/ai/src/test/mock-values.ts:1-4
export function mockValues<T>(...values: T[]): () => T {
  let counter = 0;
  return () => values[counter++] ?? values[values.length - 1];
}
```

### 2. 忠実度別バリエーション（langchain-ai/langchainjs）

LangChain.js は忠実度の異なる 3 つの Fake 実装を提供し、テストの目的に応じた使い分けを可能にする。

```typescript
// libs/langchain-core/src/utils/testing/chat_models.ts:56-99
// レベル 1: 最小忠実度 — 入力をそのまま返す echo モデル
export class FakeChatModel extends BaseChatModel {
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const text = messages.map((m) => /* ... */).join("\n");
    return { generations: [{ message: new AIMessage(text), text }] };
  }
}

// レベル 2: 中忠実度 — 事前定義の応答リストを順番に返す
export class FakeListChatModel extends BaseChatModel {
  responses: string[];
  i = 0;
  async _generate(): Promise<ChatResult> {
    const text = this.responses[this.i++ % this.responses.length];
    return { generations: [{ message: new AIMessage(text), text }] };
  }
}

// レベル 3: 高忠実度 — ストリーミング、ツール呼び出し、エラー注入
export class FakeStreamingChatModel extends BaseChatModel {
  responses: string[];       // チャンク分割される応答
  sleep?: number;            // 遅延シミュレーション
  thrownErrorString?: string; // エラー注入
  // ストリーミング、ツールバインディングにも対応
}
```

### 3. バージョン横断モック生成ファクトリ（mastra-ai/mastra）

LLM プロバイダーの API バージョン（v1/v2/v3）をまたいだテストでは、Mock 生成を共通ヘルパーに集約する。

```typescript
// packages/core/src/agent/__tests__/mock-model.ts:26-42
export function getSingleDummyResponseModel(version: "v1" | "v2" | "v3") {
  if (version === "v1") {
    return new MockLanguageModelV1({ doGenerate: async () => ({/* ... */}) });
  } else if (version === "v2") {
    return new MockLanguageModelV2({ doGenerate: async () => ({/* ... */}) });
  }
  return new MockLanguageModelV3({ doGenerate: async () => ({/* ... */}) });
}
```

テストスイートはバージョンをパラメータとして受け取る関数でラップ:

```typescript
// packages/core/src/agent/agent.test.ts:50,7596-7597
function agentTests({ version }: { version: "v1" | "v2"; }) {
  // ... hundreds of tests using mock models
}
describe("Agent Tests", () => {
  agentTests({ version: "v1" });
  agentTests({ version: "v2" });
});
```

### 4. 呼び出し記録と検証

3 リポ全てのモックが呼び出し記録機構を持ち、テスト側がリクエスト内容を検証できる。

```typescript
// vercel/ai — 配列に呼び出しを蓄積
const model = new MockLanguageModelV3({ doGenerate: { text: "ok" } });
await generateText({ model, prompt: "Hello" });
expect(model.doGenerateCalls).toHaveLength(1);
expect(model.doGenerateCalls[0].prompt[0]).toMatchObject({ role: "user" });

// mastra — observability テスト用の詳細な記録
// observability/_test-utils/src/test-exporter.ts:33-244
type MethodCall = { method: string; args: unknown[]; timestamp: number; };
class TestExporter {
  calls: MethodCall[] = [];
  wasMethodCalledForSpan(method: string, spanId: string): boolean {/* ... */}
}
```

### 5. 未実装メソッドの明示的失敗

```typescript
// packages/ai/src/test/not-implemented.ts:1-3
export const notImplemented = () => {
  throw new Error("Not implemented");
};
```

モックの未設定メソッドが `undefined` を返すのではなく、明確なエラーで失敗させる。テストの見落としを即座に検出できる。

## Good Example

```typescript
// Good: 忠実度に応じた使い分け
// 単純な出力検証 → 固定値モック
const model = new MockLanguageModelV3({
  doGenerate: { text: "Hello", usage: { inputTokens: 5, outputTokens: 1 } },
});

// リトライロジック検証 → 配列モック
const model = new MockLanguageModelV3({
  doGenerate: [
    () => {
      throw new Error("Rate limit");
    }, // 1回目: 失敗
    { text: "Success", usage: { inputTokens: 5, outputTokens: 1 } }, // 2回目: 成功
  ],
});

// ストリーミング検証 → 高忠実度モック
const model = new FakeStreamingChatModel({
  responses: ["chunk1", "chunk2", "chunk3"],
  sleep: 10, // 実際のストリーミング遅延をシミュレート
});
```

## Bad Example

```typescript
// Bad: 全テストで関数モックを使い、冗長なセットアップが蔓延
const model = new MockLanguageModelV3({
  doGenerate: async (options) => {
    return {
      text: "Hello",
      usage: { inputTokens: 5, outputTokens: 1 },
      finishReason: "stop",
      rawResponse: { headers: {} },
    };
  },
});
// → 固定値モックで十分なのに 8 行のセットアップ

// Bad: バージョン分岐をテスト本体に残す
if (version === "v1") {
  testModel = new MockLanguageModelV1({ doGenerate: async () => ({ ... }) });
} else {
  testModel = new MockLanguageModelV2({ doGenerate: async () => ({ ... }) });
}
// → ファクトリヘルパーに集約すべき
```

## 適用ガイド

- **いつ使うか**: LLM API を呼び出すコードのテストで、外部 API 依存を排除したい場合
- **3 モード入力の選択基準**:
  - 大半のテスト → **単一値**（最も簡潔）
  - リトライ・マルチターン → **配列**
  - 入力依存の動的応答 → **関数**
- **忠実度の選択基準**:
  - テキスト出力のみ検証 → echo/固定値モック（レベル 1-2）
  - ストリーミング・ツール呼び出し → 高忠実度モック（レベル 3）
  - エラーハンドリング → エラー注入付きモック
- **呼び出し記録**: モックコンストラクタに `doGenerateCalls: []` のような配列を持たせ、呼び出しごとに push する。テスト側は配列の長さと内容を検証する
- **テストユーティリティの公開**: `ai/test` のようにモックを SDK のエクスポートとして公開すると、ユーザーが自作プロバイダーのテストにも同じ道具を使える
- **バージョン横断テスト**: Mock 生成はファクトリヘルパーに集約し、テスト本体にバージョン条件分岐を残さない

## 参考

- [repos/vercel/ai/testing-practices.md](../repos/vercel/ai/testing-practices.md) — MockLanguageModelV3, mockValues, notImplemented の設計
- [repos/langchain-ai/langchainjs/testing-practices.md](../repos/langchain-ai/langchainjs/testing-practices.md) — FakeChatModel ファミリーの忠実度別設計
- [repos/mastra-ai/mastra/testing-practices.md](../repos/mastra-ai/mastra/testing-practices.md) — getSingleDummyResponseModel, バージョン横断テスト
