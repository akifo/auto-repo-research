# Practice: Provider Conformance Testing

> 出典: [repos/mastra-ai/mastra/testing-practices](../repos/mastra-ai/mastra/testing-practices.md), [repos/langchain-ai/langchainjs/testing-practices](../repos/langchain-ai/langchainjs/testing-practices.md), [repos/vercel/ai/testing-practices](../repos/vercel/ai/testing-practices.md)
> カテゴリ: practice

## 概要

AI フレームワークでは 20 以上のプロバイダー（OpenAI, Anthropic, Google, Cohere 等）が同一インターフェースを実装するため、全プロバイダーに同一の品質基準を強制する仕組みが不可欠である。主要 3 フレームワークが独立に到達した 2 つのアプローチ — (A) ファクトリ関数 + capability フラグ（mastra）と (B) 抽象テスト基底クラス + skipTestMessage（langchain）— を比較し、プロバイダー適合テストの設計指針を提供する。

## 背景・文脈

AI フレームワークのプロバイダーエコシステムでは、各プロバイダーの能力が均一ではない。あるプロバイダーはツール呼び出しをサポートし、別のプロバイダーは構造化出力をサポートしない。この差異がある中で「テスト一覧は全プロバイダー共通、実行範囲はプロバイダー能力に応じて自動調整」を実現するのが適合テストの目標である。

テストを各プロバイダーに個別に書くと、「OpenAI ではテストされるが Cohere ではテストされない振る舞い」が生まれ、インターフェース仕様が暗黙的に分散する。3 つのフレームワークがこの問題を異なるアプローチで解決している。

## 実装パターン

### アプローチ A: ファクトリ関数 + Capability フラグ（mastra）

テストスイート全体を関数として定義し、各実装は 1 行でテストを「適用」する。能力差は `TestCapabilities` オブジェクトで宣言する。

```typescript
// stores/_test-utils/src/factory.ts:28-86
export type TestCapabilities = {
  listScoresBySpan?: boolean;
};

export function createTestSuite(storage: MastraStorage, capabilities: TestCapabilities = {}) {
  describe(storage.constructor.name, () => {
    beforeAll(async () => {
      await storage.init();
    });
    afterAll(async () => {
      await Promise.all(clearList);
    });
    createWorkflowsTests({ storage });
    createMemoryTest({ storage });
    createScoresTest({ storage, capabilities });
    createObservabilityTests({ storage });
    createAgentsTests({ storage });
    createDatasetsTests({ storage });
    createExperimentsTests({ storage });
  });
}
```

各ストアのテストは 1 行:

```typescript
// stores/pg/src/storage/index.test.ts:23-24
createTestSuite(new PostgresStore(TEST_CONFIG));

// stores/libsql/src/storage/index.test.ts:26-35
createTestSuite(mastra.getStorage()!);
```

ベクトルストアでは `TestDomains` でドメイン単位の on/off を提供:

```typescript
// stores/_test-utils/src/vector-factory.ts:48-65
export interface TestDomains {
  basicOps?: boolean;
  filterOps?: boolean;
  edgeCases?: boolean;
  largeBatch?: boolean;
  errorHandling?: boolean;
  metadataFiltering?: boolean;
}
```

### アプローチ B: 抽象テスト基底クラス + skipTestMessage（langchain）

テストロジックを抽象クラスとして定義し、各プロバイダーはクラスを継承してコンストラクタ引数のみをカスタマイズする。

```typescript
// internal/standard-tests/src/unit_tests/chat_models.ts
abstract class BaseChatModelsTests<CallOptions, OutputMessageType> {
  abstract Cls: new(...args: any[]) => BaseChatModel;
  chatModelHasToolCalling: boolean;
  chatModelHasStructuredOutput: boolean;

  // テストメソッドを定義
  async testChatModelInit() {/* ... */}
  async testChatModelInitApiKey() {/* ... */}
  async testToolCalling(callOptions?: any) {
    if (!this.chatModelHasToolCalling) {
      console.log("Test requires tool calling. Skipping...");
      return;
    }
    // ... テスト本体
  }
}
```

各プロバイダーの実装は 3 ステップに収まる:

```typescript
// libs/providers/langchain-anthropic/src/tests/chat_models.standard.test.ts:1-33
class ChatAnthropicStandardUnitTests extends ChatModelUnitTests<
  ChatAnthropicCallOptions,
  AIMessageChunk
> {
  constructor() {
    super({
      Cls: ChatAnthropic,
      chatModelHasToolCalling: true,
      chatModelHasStructuredOutput: true,
      constructorArgs: {},
    });
    process.env.ANTHROPIC_API_KEY = "test";
  }
}

const testClass = new ChatAnthropicStandardUnitTests();
testClass.runTests("ChatAnthropicStandardUnitTests");
```

非対応テストの明示的スキップ:

```typescript
// libs/providers/langchain-groq/src/tests/chat_models.standard.int.test.ts:31-45
async testToolMessageHistoriesListContent() {
  this.skipTestMessage(
    "testToolMessageHistoriesListContent",
    "ChatGroq",
    "Complex message types not properly implemented"
  );
}
```

### アプローチ比較

| 観点           | A: ファクトリ関数 (mastra)                   | B: 抽象基底クラス (langchain)               |
| -------------- | -------------------------------------------- | ------------------------------------------- |
| テスト記述量   | 1 行（ファクトリ呼び出しのみ）               | 10-30 行（クラス定義 + コンストラクタ）     |
| 能力差の表現   | capability フラグ（boolean オブジェクト）    | コンストラクタ引数 + メソッド override      |
| 非対応テスト   | ドメイン単位の on/off                        | メソッド単位の skip + 理由メッセージ        |
| テストランナー | Vitest 直結                                  | Jest/Vitest 両対応（expect 注入）           |
| 拡張性         | ファクトリに新テスト追加 → 全実装に即反映    | 基底クラスに新メソッド追加 → 全実装に即反映 |
| 粒度           | ドメイン単位                                 | テストメソッド単位                          |
| 適用規模       | 20+ ストレージ / 14 ベクトル DB / 4 サーバー | 20+ LLM プロバイダー                        |

### テストランナー非依存の設計（langchain）

langchain の Standard Tests はテストランナーに依存しない設計で、Jest と Vitest の両方をサポートする。

```typescript
// internal/standard-tests/src/unit_tests/vitest.ts:30-49
runTests(testName = "ChatModelUnitTests") {
  describe(testName, () => {
    test("should initialize chat model successfully", () =>
      this.testChatModelInit());
    test("should initialize chat model with API key", () =>
      this.testChatModelInitApiKey());
    // ...
  });
}
```

`expect` をコンストラクタで注入することで、テストロジック自体はフレームワーク非依存に保つ。

## Good Example

```typescript
// Good: ファクトリ + capability フラグで宣言的
createTestSuite(new PostgresStore(TEST_CONFIG), {
  listScoresBySpan: true,
});

// Good: 非対応テストの理由を明示
async testToolCalling() {
  this.skipTestMessage(
    "testToolCalling",
    "ChatGroq",
    "Tool calling not yet supported by this provider"
  );
}
```

## Bad Example

```typescript
// Bad: 非対応テストを空メソッドで override — 意図が不明
async testToolCalling() {
  // skip
}

// Bad: 各プロバイダーに個別テストを書く — 仕様が分散
describe("OpenAI", () => {
  it("should generate text", async () => { /* ... */ });
  it("should handle tool calls", async () => { /* ... */ });
});
describe("Anthropic", () => {
  it("should generate text", async () => { /* ... */ });
  // tool calls テストが抜けている！
});
```

## 適用ガイド

- **いつ使うか**: 同一インターフェースを 3 つ以上のプロバイダーが実装する場合。2 つまでなら個別テストでも管理可能
- **アプローチ A（ファクトリ）の適用条件**:
  - テスト記述量を最小化したい（1 行で全テスト適用）
  - 能力差がドメイン単位で表現可能（on/off のグループ）
  - テストランナーが統一されている
- **アプローチ B（抽象クラス）の適用条件**:
  - テストメソッド単位の粒度が必要（特定テストだけ skip）
  - 複数テストランナー対応が必要（Jest + Vitest 等）
  - skip 理由の記録が重要（プロバイダー能力の文書化）
- **テストインフラのパッケージ化**: テストスイートは `_test-utils` のような独立パッケージとして管理し、CHANGELOG でテスト仕様の変更を追跡する
- **注意点**: capability フラグが増えすぎると組み合わせ爆発のリスクがある。ドメイン単位のグループ化で対応する

## 参考

- [repos/mastra-ai/mastra/testing-practices.md](../repos/mastra-ai/mastra/testing-practices.md) — ファクトリ関数 + capability フラグパターン
- [repos/langchain-ai/langchainjs/testing-practices.md](../repos/langchain-ai/langchainjs/testing-practices.md) — 抽象テスト基底クラス + Standard Tests
- [repos/vercel/ai/testing-practices.md](../repos/vercel/ai/testing-practices.md) — テストユーティリティの公開エクスポートパターン
- [practice_test-suite-factory](./practice_test-suite-factory) — mastra のファクトリパターンの詳細解説
