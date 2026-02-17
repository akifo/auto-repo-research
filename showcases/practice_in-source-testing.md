# practice: in-source-testing

> 出典: [repos/ryoppippi/ccusage](../repos/ryoppippi/ccusage/) からの知見
> カテゴリ: practice

## 概要

`import.meta.vitest` による in-source testing は、テストコードとプロダクションコードを同一ファイルに配置するパターンである。`await using` + `createFixture()` を組み合わせることで、ファイルシステムに依存するテストでも宣言的なセットアップと自動クリーンアップが実現できる。ビルド時に `define: { 'import.meta.vitest': 'undefined' }` を設定することでテストコードが tree-shaking で除去されるため、プロダクションバンドルへの混入が構造的に防止される。

## 背景・文脈

ryoppippi/ccusage は Claude Code の利用量を分析する CLI ツールで、モノレポ全体で 35 以上のソースファイルが in-source testing を採用している。テスト専用ディレクトリ（`__tests__/` 等）は存在せず、すべてのテストが実装ファイル末尾の `if (import.meta.vitest != null) { ... }` ブロック内に記述されている。この徹底的なコロケーションにより、実装を変更した際にテスト更新を忘れるリスクが最小化されている。

テストには純粋関数のユニットテスト、`createFixture()` によるファイルシステムテスト、MCP サーバーの統合テストの 3 層が含まれ、すべてが in-source の枠組みで運用されている。

## 実装パターン

### 1. Vitest の設定: includeSource で in-source testing を有効化

```typescript
// apps/ccusage/vitest.config.ts:1-15
import Macros from "unplugin-macros/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    watch: false,
    includeSource: ["src/**/*.{js,ts}"],
    globals: true,
  },
  plugins: [
    Macros({
      include: ["src/index.ts", "src/pricing-fetcher.ts"],
    }) as any,
  ],
});
```

`includeSource` がソースファイル内のテストブロックを検出し、`globals: true` が `describe` / `it` / `expect` をインポートなしで利用可能にする。

### 2. ビルドツールの設定: テストコードの本番除去

```typescript
// apps/ccusage/tsdown.config.ts:32-34
define: {
  'import.meta.vitest': 'undefined',
},
```

`import.meta.vitest` が `undefined` に置き換わるため、`if (import.meta.vitest != null)` ブロック全体が dead code となり、tree-shaking で除去される。tsdown の `treeshake: true` および `minify: 'dce-only'` と組み合わせて動作する。

### 3. ソースファイルへのテスト記述

```typescript
// apps/ccusage/src/_token-utils.ts:40-65
export function getTotalTokens(tokenCounts: AnyTokenCounts): number {
  const cacheCreation = "cacheCreationInputTokens" in tokenCounts
    ? tokenCounts.cacheCreationInputTokens
    : tokenCounts.cacheCreationTokens;

  const cacheRead = "cacheReadInputTokens" in tokenCounts
    ? tokenCounts.cacheReadInputTokens
    : tokenCounts.cacheReadTokens;

  return tokenCounts.inputTokens + tokenCounts.outputTokens + cacheCreation + cacheRead;
}

// In-source testing
if (import.meta.vitest != null) {
  describe("getTotalTokens", () => {
    it("should sum all token types correctly (raw format)", () => {
      const tokens: TokenCounts = {
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationInputTokens: 2000,
        cacheReadInputTokens: 300,
      };
      expect(getTotalTokens(tokens)).toBe(3800);
    });
  });
}
```

実装関数の直後にテストが続くため、関数の仕様変更時にテストが自然に目に入る。

### 4. await using + createFixture による宣言的フィクスチャ

```typescript
// apps/ccusage/src/data-loader.ts:1535-1579
it("loads usage data for a specific session", async () => {
  await using fixture = await createFixture({
    ".claude": {
      projects: {
        "test-project": {
          "session-123.jsonl": `${
            JSON.stringify({
              timestamp: "2024-01-01T00:00:00Z",
              sessionId: "session-123",
              message: {
                usage: { input_tokens: 100, output_tokens: 50 },
                model: "claude-sonnet-4-20250514",
              },
              costUSD: 0.5,
            })
          }`,
        },
      },
    },
  });

  vi.stubEnv("CLAUDE_CONFIG_DIR", fixture.getPath(".claude"));
  const result = await loadSessionUsageById("session-123", { mode: "display" });
  expect(result).not.toBeNull();
  expect(result?.totalCost).toBe(1.5);
});
```

`createFixture()` にオブジェクトリテラルを渡すと、そのままディレクトリ構造が生成される。`await using` により、テスト関数のスコープを抜けた時点で一時ファイルが自動的に削除される（`Symbol.asyncDispose` による Explicit Resource Management）。

### 5. テストブロック内へのヘルパー関数の閉じ込め

```typescript
// apps/ccusage/src/_session-blocks.ts:342-363
if (import.meta.vitest != null) {
  const SESSION_DURATION_MS = 5 * 60 * 60 * 1000;

  function createMockEntry(
    timestamp: Date,
    inputTokens = 1000,
    outputTokens = 500,
    model = "claude-sonnet-4-20250514",
    costUSD = 0.01,
  ): LoadedUsageEntry {
    return {
      timestamp,
      usage: { inputTokens, outputTokens, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      costUSD,
      model,
    };
  }

  describe("identifySessionBlocks", () => {
    it("creates single block for entries within 5 hours", () => {
      const baseTime = new Date("2024-01-01T10:00:00Z");
      const entries = [
        createMockEntry(baseTime),
        createMockEntry(new Date(baseTime.getTime() + 60 * 60 * 1000)),
      ];
      const blocks = identifySessionBlocks(entries);
      expect(blocks).toHaveLength(1);
    });
  });
}
```

`createMockEntry()` や `SESSION_DURATION_MS` がガードブロック内に定義されているため、プロダクションコードに一切漏洩しない。テスト専用ヘルパーの可視性が言語レベルではなくツールチェーンレベルで制御されている。

## Good Example

```typescript
// Good: 宣言的フィクスチャ + 自動クリーンアップ
it("reads config from fixture directory", async () => {
  await using fixture = await createFixture({
    ".claude": {
      projects: {
        "my-project": {
          "session.jsonl": '{"timestamp":"2024-01-01T00:00:00Z","costUSD":0.5}',
        },
      },
    },
  });

  // Arrange: ディレクトリ構造がオブジェクトリテラルで一目瞭然
  // Act
  const result = await loadData(fixture.getPath(".claude"));
  // Assert
  expect(result.totalCost).toBe(0.5);
  // Cleanup: await using が自動で実行 -- 何も書かなくてよい
});
```

```typescript
// Good: テストヘルパーをガードブロック内に閉じ込め
if (import.meta.vitest != null) {
  function createMockEntry(timestamp: Date, cost = 0.01): UsageEntry {
    return { timestamp, costUSD: cost /* ... */ };
  }

  describe("aggregate", () => {
    it("sums costs correctly", () => {
      const entries = [createMockEntry(new Date(), 0.5), createMockEntry(new Date(), 1.0)];
      expect(aggregate(entries).totalCost).toBe(1.5);
    });
  });
}
```

## Bad Example

```typescript
// Bad: 手続き的なセットアップ + 手動クリーンアップ
let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "test-"));
  await mkdir(path.join(tempDir, ".claude", "projects", "my-project"), { recursive: true });
  await writeFile(
    path.join(tempDir, ".claude", "projects", "my-project", "session.jsonl"),
    '{"timestamp":"2024-01-01T00:00:00Z","costUSD":0.5}',
  );
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true }); // 忘れると一時ファイルが残る
});

it("reads config from temp directory", async () => {
  const result = await loadData(path.join(tempDir, ".claude"));
  expect(result.totalCost).toBe(0.5);
});
```

```typescript
// Bad: テスト専用ヘルパーがプロダクションコードと同じスコープに存在
// ファイルトップレベルに定義 -- バンドルに含まれるリスク
function createMockEntry(timestamp: Date, cost = 0.01): UsageEntry {
  return { timestamp, costUSD: cost /* ... */ };
}

export function aggregate(entries: UsageEntry[]) {/* ... */}

if (import.meta.vitest != null) {
  describe("aggregate", () => {
    it("sums costs", () => {
      // createMockEntry がプロダクションバンドルに残る可能性
      expect(aggregate([createMockEntry(new Date())])).toBeDefined();
    });
  });
}
```

## 適用ガイド

### 導入手順

1. **Vitest の設定**: `vitest.config.ts` に `includeSource` と `globals: true` を追加する
2. **ビルドツールの設定**: tsdown / Vite / esbuild の `define` に `'import.meta.vitest': 'undefined'` を設定する
3. **TypeScript の型定義**: `tsconfig.json` の `types` に `"vitest/importMeta"` を追加して `import.meta.vitest` の型を認識させる
4. **テストの記述**: ファイル末尾に `if (import.meta.vitest != null) { ... }` ブロックを追加し、テストを記述する
5. **フィクスチャの導入**: ファイルシステムテストが必要なら `fs-fixture` を `devDependencies` に追加し、`await using` で自動クリーンアップを設定する

### 使うべき状況

- ユーティリティ関数や純粋関数が多いプロジェクトで、テストと実装のコロケーションを重視する場合
- バンドラー（tsdown, Vite, esbuild 等）による tree-shaking が確実に機能するツールチェーンを使用している場合
- ファイルシステムに依存するテストが多く、一時ファイルのクリーンアップ漏れが問題になっている場合

### 注意点

- **ファイルサイズの肥大化**: テスト量が多いファイルでは行数が膨張する（ccusage の `data-loader.ts` は実装+テストで 4753 行）。1 ファイルの行数が管理限界を超える場合は、テストの外部分離を検討する
- **動的インポートの禁止**: `await import()` は静的解析を阻害し、テスト専用依存がバンドルに残るリスクがある。ccusage では CLAUDE.md で明示的に禁止している
- **globals スタイルの統一**: `globals: true` を設定した場合、`import.meta.vitest` からの destructuring（`const { describe, it } = import.meta.vitest`）と混在させない。1 つのスタイルに統一する
- **`await using` のランタイム要件**: Explicit Resource Management は TypeScript 5.2+ でサポートされるが、ランタイム側のポリフィルが必要な場合がある

## 参考

- [repos/ryoppippi/ccusage/testing-practices.md](../repos/ryoppippi/ccusage/testing-practices.md) -- テスト戦略の詳細分析
- [repos/ryoppippi/ccusage/build-and-tooling.md](../repos/ryoppippi/ccusage/build-and-tooling.md) -- ビルド時テスト除去の仕組み
