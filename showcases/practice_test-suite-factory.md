# Practice: Test Suite Factory

> 出典: [repos/mastra-ai/mastra/testing-practices](../repos/mastra-ai/mastra/testing-practices.md), [repos/mastra-ai/mastra/extensibility-mechanisms](../repos/mastra-ai/mastra/extensibility-mechanisms.md), [repos/mastra-ai/mastra/abstraction-patterns](../repos/mastra-ai/mastra/abstraction-patterns.md)
> カテゴリ: practice

## 概要

同一インターフェースの 20 超の実装（ストレージアダプター、ベクトル DB、サーバーアダプター等）に対し、`createTestSuite()` の 1 行で全契約テストを適用するパターン。各実装の機能差は capability フラグで宣言的に表現し、テストコード内の条件分岐を排除する。テストの重複を防ぎつつ、インターフェース仕様の一元管理を実現する実践的なアプローチである。

## 背景・文脈

mastra は 23 のストレージアダプター（PostgreSQL, LibSQL, MongoDB, DynamoDB, Cloudflare D1 等）、14 のベクトル DB アダプター（PgVector, Pinecone, Qdrant, Chroma 等）、4 つのサーバーアダプター（Hono, Express, Fastify, Koa）を持つ大規模 TypeScript モノレポである。これらは全て同一の抽象インターフェース（`MastraStorage`, `MastraVector`, サーバーアダプター）を実装しており、契約テストの一貫性が極めて重要になる。

テストを各アダプターに個別に書くと、「PostgreSQL ではテストされるが MongoDB ではテストされない振る舞い」が生まれ、インターフェース仕様が暗黙的に分散する。Test Suite Factory パターンはこの問題を根本的に解決する。

## 実装パターン

### 1. ストレージテストファクトリ

ファクトリ関数はストレージインスタンスを受け取り、全ドメイン（workflows, memory, scores, observability, agents, datasets, experiments）のテストを自動生成する。

```typescript
// stores/_test-utils/src/factory.ts:1-86
import { describe, beforeAll, afterAll } from 'vitest';
import type { MastraStorage } from '@mastra/core/storage';

export type TestCapabilities = {
  /** Whether the adapter supports listing scores by span (defaults to true) */
  listScoresBySpan?: boolean;
};

export function createTestSuite(storage: MastraStorage, capabilities: TestCapabilities = {}) {
  describe(storage.constructor.name, () => {
    beforeAll(async () => {
      await storage.init();
    });

    afterAll(async () => {
      // 各ドメインの dangerouslyClearAll() で後片付け
      const clearList: Promise<void>[] = [];
      const workflowStorage = await storage.getStore('workflows');
      if (workflowStorage) clearList.push(workflowStorage.dangerouslyClearAll());
      // ... 他のドメインも同様
      await Promise.all(clearList);
    });

    // テストは無条件に登録 — 各テスト内でドメインの利用可否を判定
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

### 2. ベクトルストアテストファクトリ

ベクトル DB はアダプターごとの機能差が大きいため、`TestDomains` と個別の capability フラグを組み合わせた粒度の細かい制御を提供する。

```typescript
// stores/_test-utils/src/vector-factory.ts:48-130
export interface TestDomains {
  basicOps?: boolean;         // インデックス CRUD、upsert、query
  filterOps?: boolean;        // $gt, $lt, $in, $regex 等のフィルタ演算子
  edgeCases?: boolean;        // 空インデックス、大規模バッチ、並行操作
  largeBatch?: boolean;       // 1000+ ベクトルの一括操作（edgeCases のサブセット）
  errorHandling?: boolean;    // 不正入力、パラメータバリデーション
  metadataFiltering?: boolean; // メモリシステム互換フィルタリング
  advancedOps?: boolean;      // フィルタ付き deleteVectors/updateVector
}

export interface VectorTestConfig {
  vector: MastraVector<any>;
  createIndex: (indexName: string, options?: CreateIndexOptions) => Promise<void>;
  deleteIndex: (indexName: string) => Promise<void>;
  testDomains?: TestDomains;
  supportsArrayMetadata?: boolean;  // Chroma は false
  supportsRegex?: boolean;          // LibSQL, Chroma は false
  supportsNotOperator?: boolean;    // Chroma は false
  supportsNorOperator?: boolean;    // Chroma, LibSQL は false
  // ... 他の capability フラグ
}

export function createVectorTestSuite(config: VectorTestConfig) {
  const { testDomains = {} } = config;

  describe(config.vector.constructor.name, () => {
    // ドメイン単位で on/off（デフォルトは全て有効）
    if (testDomains.basicOps !== false)    createBasicOperationsTest(config);
    if (testDomains.filterOps !== false)   createFilterOperatorsTest(config);
    if (testDomains.edgeCases !== false)   createEdgeCasesTest(config, { skipLargeBatch: testDomains.largeBatch === false });
    if (testDomains.errorHandling !== false) createErrorHandlingTest(config);
    // ...
  });
}
```

### 3. サーバーアダプターテストファクトリ

HTTP リクエスト/レスポンスのサイクル全体を検証するファクトリ。ルート定義から自動的にテストデータを生成する。

```typescript
// server-adapters/_test-utils/src/route-adapter-test-suite.ts:27-53
export function createRouteAdapterTestSuite(config: AdapterTestSuiteConfig) {
  const { suiteName, setupAdapter, executeHttpRequest } = config;

  describe('Route Validation', () => {
    createRouteTestSuite({ routes: SERVER_ROUTES });
  });

  describe(suiteName, () => {
    // パラメータ抽出、スキーマバリデーション、ハンドラ実行、レスポンスフォーマットを検証
    activeRoutes.forEach(route => {
      describe(`${route.method} ${route.path}`, () => {
        it('should execute with valid request', async () => { /* ... */ });
      });
    });
  });
}
```

## Good Example

各アダプターのテストファイルが 1 行のファクトリ呼び出しで全契約テストを適用する。

```typescript
// stores/pg/src/storage/index.test.ts:23-24
// PostgreSQL: 2 つの構成で同一テストを適用
createTestSuite(new PostgresStore(TEST_CONFIG));
createTestSuite(new PostgresStore({ ...TEST_CONFIG, schemaName: 'my_schema' }));
```

```typescript
// stores/convex/src/storage/index.test.ts:47
// Convex: capability フラグで未対応機能を宣言
createTestSuite(store, { listScoresBySpan: false });
```

```typescript
// stores/libsql/src/vector/index.test.ts:12-39
// LibSQL: ドメイン単位 + 個別フラグの組み合わせ
createVectorTestSuite({
  vector: libSQLVectorDB,
  createIndex: async (indexName, options) => {
    await libSQLVectorDB.createIndex({ indexName, dimension: 1536, metric: options?.metric ?? 'cosine' });
  },
  deleteIndex: async (indexName) => { /* ... */ },
  testDomains: {
    largeBatch: false,       // レート制限のため大規模バッチをスキップ
  },
  supportsRegex: false,      // LibSQL は $regex 非対応
  supportsContains: false,
  supportsNotOperator: false,
  supportsNorOperator: false,
  supportsElemMatch: false,
  supportsSize: false,
  supportsStrictOperatorValidation: false,
});
```

```typescript
// stores/chroma/src/vector/index.test.ts:566-588
// Chroma: プリミティブ型のみ対応という制約を宣言的に表現
createVectorTestSuite({
  vector: chromaVector,
  createIndex: async (indexName, options) => { /* ... */ },
  deleteIndex: async (indexName) => { /* ... */ },
  supportsArrayMetadata: false,          // プリミティブ型のみ
  supportsNullValues: false,
  supportsExistsOperator: false,
  supportsRegex: false,
  supportsContains: false,
  supportsNotOperator: false,
  supportsNorOperator: false,
  supportsEmptyLogicalOperators: false,
  supportsAdvancedNotSyntax: false,
});
```

```typescript
// server-adapters/hono/src/__tests__/hono-adapter.test.ts:24-39
// Hono: setupAdapter と executeHttpRequest を渡すだけで全ルートが検証される
describe('Hono Server Adapter', () => {
  createRouteAdapterTestSuite({
    suiteName: 'Hono Adapter Integration Tests',
    setupAdapter: async (context, options?) => {
      const app = new Hono();
      const adapter = new MastraServer({ app, mastra: context.mastra, /* ... */ });
      // ...
    },
    executeHttpRequest: async (app, request) => { /* ... */ },
  });
});
```

## Bad Example

テストスイートファクトリを使わず、各アダプターにテストをコピペする場合の問題。

```typescript
// Bad: 各アダプターに同じテストを個別に記述
// stores/pg/src/storage/index.test.ts
describe('PostgresStore', () => {
  it('should save and retrieve a workflow', async () => {
    const workflow = { id: 'test', name: 'Test Workflow', /* ... */ };
    await pgStore.saveWorkflow(workflow);
    const result = await pgStore.getWorkflow('test');
    expect(result).toEqual(workflow);
  });
  it('should save and retrieve a thread', async () => { /* ... */ });
  // ... 50+ テストケース
});

// stores/mongodb/src/storage/index.test.ts
describe('MongoDBStore', () => {
  // 同じテストをコピペ — ただし微妙に条件が違ったり、一部テストが抜けたりする
  it('should save and retrieve a workflow', async () => {
    // PostgreSQL のテストから微妙に仕様が異なる可能性
    const workflow = { id: 'test', name: 'Test Workflow', /* ... */ };
    await mongoStore.saveWorkflow(workflow);
    const result = await mongoStore.getWorkflow('test');
    expect(result).toEqual(workflow);
  });
  // スレッドのテストが抜けている — 誰も気づかない
});
```

```typescript
// Bad: テスト内でアダプター種別の条件分岐
describe('Vector Store Tests', () => {
  it('should filter by regex', async () => {
    if (storeName === 'chroma' || storeName === 'libsql') {
      // Chroma と LibSQL は regex 非対応なのでスキップ
      return;
    }
    // テスト本体
    const results = await vector.query({ filter: { name: { $regex: 'test.*' } } });
    expect(results.length).toBeGreaterThan(0);
  });

  it('should handle array metadata', async () => {
    if (storeName === 'chroma') {
      // Chroma はプリミティブ型のみ
      return;
    }
    // テスト本体
  });
});
```

## 適用ガイド

### どのような状況で使うべきか

- 同一インターフェースの実装が **3 つ以上** ある場合（2 つでも将来増える見込みがあれば適用すべき）
- Strategy / Adapter / Provider パターンでプラグイン的に実装が追加される設計の場合
- バックエンドごとの機能差（対応する演算子、サポートするデータ型等）が存在する場合

### 導入手順

1. **テストユーティリティを独立パッケージにする**: mastra は `stores/_test-utils` と `server-adapters/_test-utils` を独立したワークスペースパッケージとして管理し、`package.json` と `CHANGELOG.md` を持たせている。テストコードもプロダクションコードと同等の品質で管理するため。

2. **ファクトリ関数を設計する**: 引数は (1) テスト対象のインスタンス、(2) ライフサイクルフック（`createIndex`, `deleteIndex` 等）、(3) capability フラグの 3 カテゴリに整理する。

3. **capability フラグを 2 層に分ける**:
   - **ドメインレベル** (`TestDomains`): テスト群の大分類の on/off。`filterOps: false` でフィルタ関連テスト全体をスキップ。
   - **機能レベル** (`supportsRegex`, `supportsNullValues` 等): 個別テストケースの skip 制御。ドメインは有効のまま、特定の演算子だけスキップできる。

4. **各アダプターのテストファイルを簡素化する**: ファクトリ呼び出し 1 行 + アダプター固有のテスト（設定バリデーション、固有機能等）だけを記述する。

### 注意点

- **capability フラグの増殖**: フラグが 15 個を超えると設定の認知負荷が高くなる。mastra の `VectorTestConfig` は既に 15 個のフラグを持っており、ドキュメントコメントによる説明が不可欠になっている。フラグのグループ化（ドメイン単位の `TestDomains`）で対処する。

- **テストデータの管理**: ファクトリ内のテストが使うデータ（フィクスチャ）は `domains/*/data.ts` のように専用ファイルに分離し、ファクトリとテストデータの関心を分離する。

- **アダプター固有テストとの併用**: ファクトリは契約テスト（共通振る舞い）のみを担当する。アダプター固有の機能（PostgreSQL のスキーマ指定、Convex のインデックス最適化等）は別途テストを書く。

### カスタマイズポイント

- `describe` ブロックのラベルは `storage.constructor.name` から自動取得される。テスト出力でどのアダプターの結果かを即座に識別できる。
- `dangerouslyClearAll()` メソッドで命名レベルでのプロダクション誤用防止を行う。テスト専用のクリーンアップメソッドであることが名前から明白になる。
- ファクトリは `beforeAll` / `afterAll` でストレージの初期化・クリーンアップを一括管理するため、各テストケースは独立した状態を前提にできる。

## 参考

- [repos/mastra-ai/mastra/testing-practices.md](../repos/mastra-ai/mastra/testing-practices.md) -- テストスイートファクトリの全体設計と 3 層テスト分類
- [repos/mastra-ai/mastra/extensibility-mechanisms.md](../repos/mastra-ai/mastra/extensibility-mechanisms.md) -- abstract class による拡張ポイント設計（テスト対象となるインターフェース）
- [repos/mastra-ai/mastra/abstraction-patterns.md](../repos/mastra-ai/mastra/abstraction-patterns.md) -- Capability Flag パターンと Filter Translator パターン
- [repos/openclaw/openclaw/abstraction-patterns.md](../repos/openclaw/openclaw/abstraction-patterns.md) -- 能力ベースインターフェースの比較事例
