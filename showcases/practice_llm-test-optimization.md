# Practice: LLM Test Optimization

> 出典: [repos/mastra-ai/mastra/testing-practices](../repos/mastra-ai/mastra/testing-practices.md), [repos/vercel/ai/testing-practices](../repos/vercel/ai/testing-practices.md), [repos/langchain-ai/langchainjs/testing-practices](../repos/langchain-ai/langchainjs/testing-practices.md)
> カテゴリ: practice

## 概要

AI/LLM フレームワークのテストには、通常のアプリケーションテストとは異なる最適化が求められる。(1) AI エージェントがテストを実行する前提での出力最適化、(2) LLM API バージョン横断テストの効率化、(3) 統合テストのキャッシュ戦略の 3 つの観点から、3 つの主要 AI フレームワークの実践を統合する。

## 背景・文脈

AI フレームワーク開発では、テストの実行主体が人間だけでなく AI エージェント（Claude Code, Codex 等）であるケースが増えている。mastra は明示的に「LLM がテストを実行する」前提でテスト設定を最適化している。また、LLM API のバージョン進化（v1→v2→v3）に伴い、複数バージョンの互換性を効率的に検証する必要がある。さらに、外部 AI API に依存するテストはキャッシュの扱いを誤ると誤った成功を生む。

## 実装パターン

### 1. AI エージェント向けテスト出力最適化（mastra）

mastra は複数のパッケージで、AI ツールがテスト結果を読む前提のレポーター設定を採用している。

```typescript
// packages/memory/vitest.config.ts:6-12
export default defineConfig({
  test: {
    name: "unit:packages/memory",
    isolate: false,
    // smaller output to save token space when LLMs run tests
    reporters: "dot",
    bail: 1,
  },
});
```

設計上の意図:

- **`reporters: "dot"`** — 各テストの成否を `.` と `F` の 1 文字で表現。デフォルトの verbose 出力に比べてトークン消費を大幅に削減する
- **`bail: 1`** — 最初の失敗で即座に停止。AI エージェントは「全テストの失敗一覧」よりも「最初の失敗の詳細」を必要とするため、早期終了が効果的

このパターンは `packages/agent-builder/vitest.config.ts` と `integration-tests/vitest.config.ts` にも適用されている。

### 2. LLM API バージョン横断テスト（mastra + vercel/ai）

LLM プロバイダーの API バージョン（v1/v2/v3）をまたいだテストでは、テストスイートを関数でラップしバージョンをパラメータ化する。

```typescript
// packages/core/src/agent/agent.test.ts:50,7596-7597
function agentTests({ version }: { version: "v1" | "v2"; }) {
  const model = getSingleDummyResponseModel(version);

  it("should generate text", async () => {
    const agent = new Agent({ model });
    const result = await agent.generate("Hello");
    expect(result.text).toBeDefined();
  });

  it("should handle tool calls", async () => {
    // バージョン非依存のテストロジック
  });
}

describe("Agent Tests", () => {
  agentTests({ version: "v1" });
  agentTests({ version: "v2" });
});
```

Mock 生成ヘルパーでバージョン分岐を集約:

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

### 3. 統合テストのキャッシュ無効化（langchain）

外部 AI API を呼ぶテストに Turborepo キャッシュが効くと、API の非互換変更を検知できない。langchain は全統合テストタスクで明示的にキャッシュを無効化する。

```json
// turbo.json
{
  "test": {
    "dependsOn": ["build:compile"],
    "cache": true // 単体テストはキャッシュ有効
  },
  "test:int": {
    "dependsOn": ["build:compile"],
    "cache": false // 統合テストはキャッシュ無効
  },
  "test:standard:int": {
    "dependsOn": ["build:compile"],
    "cache": false
  }
}
```

テスト種別ごとのタイムアウト設定も分離する:

| テスト種別 | タイムアウト | キャッシュ | 理由                                        |
| ---------- | ------------ | ---------- | ------------------------------------------- |
| 単体テスト | 30 秒        | あり       | 外部依存なし、高速に実行可能                |
| 統合テスト | 100 秒       | なし       | AI API の応答時間は不安定、キャッシュは危険 |
| 標準テスト | 100 秒       | あり/なし  | unit は有効、int は無効                     |

### 4. テスト分類の命名規約による自動化（3 リポ共通）

3 リポ全てがファイル拡張子でテスト種別を区別し、設定変更なしでテスト追加を可能にしている。

| 拡張子              | 種別           | mastra        | vercel/ai         | langchain         |
| ------------------- | -------------- | ------------- | ----------------- | ----------------- |
| `.test.ts`          | 単体テスト     | `unit:*`      | `test:node/edge`  | デフォルト        |
| `.e2e.test.ts`      | E2E テスト     | `e2e:*`       | exclude 対象      | -                 |
| `.int.test.ts`      | 統合テスト     | -             | -                 | `int` mode        |
| `.test-d.ts`        | 型テスト       | `typecheck:*` | `typecheck: true` | `typecheck: true` |
| `.ui.test.ts`       | UI テスト      | -             | jsdom 環境        | -                 |
| `.standard.test.ts` | 標準単体テスト | -             | -                 | `standard-unit`   |

mastra の Vitest projects による分類:

```typescript
// packages/core/vitest.config.ts:3-36
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit:packages/core",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.e2e.test.ts"],
        },
      },
      {
        test: {
          name: "e2e:packages/core",
          include: ["src/**/*.e2e.test.ts"],
        },
      },
      {
        test: {
          name: "typecheck:packages/core",
          typecheck: { enabled: true, include: ["src/**/*.test-d.ts"] },
        },
      },
    ],
  },
});
```

langchain の mode パラメータによる設定統合:

```typescript
// libs/providers/langchain-openai/vitest.config.ts:7-70
export default defineConfig((env) => {
  const common = {
    test: {
      environment: "node",
      testTimeout: 30_000,
      exclude: ["**/*.int.test.ts", ...configDefaults.exclude],
    },
  };
  if (env.mode === "int") {
    return { test: { ...common.test, testTimeout: 100_000, include: ["**/*.int.test.ts"] } };
  }
  if (env.mode === "standard-unit") {
    return { test: { ...common.test, testTimeout: 100_000, include: ["**/*.standard.test.ts"] } };
  }
  return common;
});
```

### 5. ビルドとテストの依存関係保証（vercel/ai）

テストが常にビルド済み成果物に対して実行されることを保証する:

```json
// turbo.json:80-82
{
  "test": {
    "dependsOn": ["^build", "build"]
  }
}
```

`^build` はワークスペース間の依存関係を含む上流ビルド、`build` は自パッケージのビルドを指す。この設定により、テスト実行前に必ず全依存パッケージがビルドされる。

## Good Example

```typescript
// Good: AI エージェント向け最適化 — コメントで意図を明示
export default defineConfig({
  test: {
    reporters: "dot",  // smaller output to save token space when LLMs run tests
    bail: 1,           // AI は最初の失敗に集中すべき
  },
});

// Good: バージョン横断テスト — ファクトリヘルパーで分岐を集約
describe("Agent Tests", () => {
  agentTests({ version: "v1" });
  agentTests({ version: "v2" });
});

// Good: テスト種別ごとにキャッシュ戦略を分離
// turbo.json
{ "test": { "cache": true }, "test:int": { "cache": false } }
```

## Bad Example

```typescript
// Bad: AI エージェントが大量のテスト出力を処理 — トークン浪費
export default defineConfig({
  test: {
    reporters: "verbose",  // 全テスト名を出力 — 数百行に
  },
});

// Bad: バージョン分岐をテスト本体に残す
it("should generate text", async () => {
  let model;
  if (version === "v1") {
    model = new MockLanguageModelV1({ /* ... */ });
  } else if (version === "v2") {
    model = new MockLanguageModelV2({ /* ... */ });
  }
  // → ファクトリヘルパーに集約すべき
});

// Bad: 統合テストにキャッシュが効く — API 変更を見逃す
{ "test:int": { "dependsOn": ["build:compile"] } }
// cache: false が抜けている！
```

## 適用ガイド

- **AI エージェント向け出力最適化のタイミング**: AI ツールがテストを頻繁に実行するプロジェクトで効果が高い。人間が直接テスト出力を読むプロジェクトでは `verbose` の方が適切な場合もある
- **`bail: 1` の注意点**: 複数の独立した問題が同時に存在する場合、1 つ目の修正後に 2 つ目が顕在化する。CI では `bail` なしで全テストを実行し、ローカル/AI 実行時のみ `bail: 1` にする二段構えも有効
- **バージョン横断テストの設計**: Mock 生成をファクトリヘルパーに集約し、テスト本体はバージョン非依存に保つ。テスト関数をパラメータ化し `describe` レベルでバージョンごとに呼び出す
- **統合テストのキャッシュ**: 外部 API に依存するテストは必ず `cache: false` に設定する。`turbo.json` のテンプレートにこの設定を含めておくと忘れにくい
- **命名規約の統一**: プロジェクト開始時にテストファイルの命名規約を決め、CONTRIBUTING.md に文書化する。CI の設定は命名規約と連動させ、新規テスト追加時に設定変更が不要な状態にする

## 参考

- [repos/mastra-ai/mastra/testing-practices.md](../repos/mastra-ai/mastra/testing-practices.md) — AI エージェント向けテスト出力最適化、バージョン横断テスト
- [repos/vercel/ai/testing-practices.md](../repos/vercel/ai/testing-practices.md) — デュアルランタイムテスト、テスト/ビルド依存関係
- [repos/langchain-ai/langchainjs/testing-practices.md](../repos/langchain-ai/langchainjs/testing-practices.md) — テスト種別分類、統合テストキャッシュ無効化
