# testing-practices

> リポジトリ: mastra-ai/mastra
> 分析日: 2026-02-14

## 概要

mastra は 90 以上の vitest.config.ts を持つ大規模 TypeScript モノレポであり、テスト戦略に関して4つの注目点がある。(1) 共有テストスイートファクトリによる「同一テストを複数実装に適用する」パターン、(2) ファイル命名規約（`.test.ts` / `.e2e.test.ts` / `.test-d.ts`）と Vitest projects 機能による unit/e2e/typecheck の3層分離、(3) E2E テストでローカル npm レジストリ（Verdaccio）を起動し実際のパッケージ公開フローを検証するインフラ、(4) AI エージェントがテストを実行する前提でのレポーター最適化。これらは多数のストア・アダプター・プロバイダーの互換性を高速に保証するために設計されている。

## 背景にある原則

- **Contract Testing by Factory（契約テストのファクトリ化）**: 同一インターフェースの実装が複数ある場合、テストスイート自体を関数として共有し、各実装は1行でテストを「適用」するだけにすべき。なぜなら、テストの重複はインターフェース仕様の分散を招き、あるストアでは検証されるが別のストアではされない振る舞いが生まれるため。各実装の差異は capability フラグで宣言的に表現する（`stores/_test-utils/src/factory.ts` の `createTestSuite`、`vector-factory.ts` の `TestDomains`）。

- **Naming Convention as Test Classification（命名規約によるテスト分類）**: テストの種別をファイル拡張子で区別し、Vitest の `projects` 設定で `unit:` / `e2e:` / `typecheck:` プレフィックスを付与すべき。なぜなら、テストファイルを対象コードと同じディレクトリに置きつつ、CI の `--project` フラグで選択的実行が可能になり、シャード分割やシークレット依存の分離も実現できるため（`packages/core/vitest.config.ts`、`.github/workflows/vitest-all.yml`）。

- **Test Infrastructure as Packages（テストインフラのパッケージ化）**: テストユーティリティはワークスペース内の独立パッケージ（`_test-utils`）として管理すべき。なぜなら、テストコードもプロダクションコードと同等の品質で管理する必要があり、CHANGELOG による変更追跡とバージョニングが可能になるため（`stores/_test-utils/CHANGELOG.md`、`server-adapters/_test-utils/CHANGELOG.md`）。

- **LLM-Friendly Test Output（AI ツール向けテスト出力最適化）**: テストのレポーター設定は、AI エージェントがテスト結果を読む前提で最適化すべき。なぜなら、冗長な出力はトークン消費を増やし、AI の分析精度を下げるため（`packages/memory/vitest.config.ts` の `reporters: 'dot'` + コメント `// smaller output to save token space when LLMs run tests`）。

## 実例と分析

### テストスイートファクトリパターン

mastra のテスト戦略の中核は `_test-utils` パッケージに集約されたテストスイートファクトリである。3つの領域で一貫して適用されている。

**ストレージテスト**: `createTestSuite(storage)` に `MastraStorage` インスタンスを渡すと、7ドメインのテストが自動生成される。

```typescript
// stores/_test-utils/src/factory.ts:28-86
export function createTestSuite(storage: MastraStorage, capabilities: TestCapabilities = {}) {
  describe(storage.constructor.name, () => {
    beforeAll(async () => {
      await storage.init();
    });
    afterAll(async () => {
      // dangerouslyClearAll for each domain
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

各ストアのテストは1行で全テストを適用する:

```typescript
// stores/pg/src/storage/index.test.ts:23-24
createTestSuite(new PostgresStore(TEST_CONFIG));
createTestSuite(new PostgresStore({ ...TEST_CONFIG, schemaName: "my_schema" }));
```

LibSQL でも同一パターン:

```typescript
// stores/libsql/src/storage/index.test.ts:26-35
const libsql = new LibSQLStore({ id: "libsql-test-store", url: TEST_DB_URL });
const mastra = new Mastra({ storage: libsql });
createTestSuite(mastra.getStorage()!);
```

**ベクトルストアテスト**: `createVectorTestSuite` は `TestDomains` でドメイン単位の on/off を提供する:

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

**サーバーアダプタテスト**: `createRouteAdapterTestSuite` は Hono / Express / Fastify / Koa の全アダプタ共通テストを提供する:

```typescript
// server-adapters/_test-utils/src/route-adapter-test-suite.ts:27-53
export function createRouteAdapterTestSuite(config: AdapterTestSuiteConfig) {
  describe("Route Validation", () => {
    createRouteTestSuite({ routes: SERVER_ROUTES });
  });
  describe(suiteName, () => {
    // パラメータ抽出、スキーマバリデーション、ハンドラ実行、レスポンスフォーマットを検証
  });
}
```

### 3層テスト分類と Vitest Projects

単一の `vitest.config.ts` 内で unit / e2e / typecheck を分割し、CI で `--project` フラグで実行範囲を制御する:

```typescript
// packages/core/vitest.config.ts:3-36
export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit:packages/core", include: ["src/**/*.test.ts"], exclude: ["src/**/*.e2e.test.ts"] } },
      { test: { name: "e2e:packages/core", include: ["src/**/*.e2e.test.ts"] } },
      { test: { name: "typecheck:packages/core", typecheck: { enabled: true, include: ["src/**/*.test-d.ts"] } } },
    ],
  },
});
```

型レベルテスト（`.test-d.ts`）の実例:

```typescript
// packages/core/src/agent/agent-types.test-d.ts:14-31
describe("Agent Type Tests", () => {
  it("should allow Zod schema in AgentExecutionOptions.structuredOutput", () => {
    const mySchema = z.object({ status: z.enum(["error", "success"]), message: z.string() });
    const options: AgentExecutionOptions<z.infer<typeof mySchema>> = {
      structuredOutput: { schema: mySchema },
    };
    expectTypeOf(options.structuredOutput.schema).toExtend<NonNullable<OutputSchema<z.infer<typeof mySchema>>>>();
  });
});
```

### ルートレベルの自動プロジェクト検出

ルートの `vitest.config.ts` はモノレポ全体の vitest 設定を動的に収集する。ネストされたプロジェクトも再帰的に展開される:

```typescript
// vitest.config.ts:37-101
async function discoverProjects(): Promise<TestProjectConfiguration[]> {
  const configPaths = PROJECT_GLOBS.flatMap(pattern => globSync(pattern));
  for (const configPath of configPaths) {
    if (EXCLUDED_DIRS.has(projectDir)) continue;
    const hasNestedProjects = /test:\s*\{[\s\S]*?projects:\s*\[/.test(configContent);
    if (!hasNestedProjects) {
      projects.push(projectDir);
      continue;
    }
    // Vite の config loader で動的に読み込み、プロジェクトを展開
    const loaded = await loadConfigFromFile({} as any, absolutePath);
    // ... nested projects を root パス付きで展開
  }
  return projects;
}
```

### Verdaccio を使ったパッケージ公開 E2E テスト

E2E テストは Vitest の `globalSetup` でローカル npm レジストリを起動し、パッケージを実際に publish してからテスト:

```typescript
// e2e-tests/commonjs/setup.ts:12-50
export default async function setup(project: TestProject) {
  const tag = "commonjs-e2e-test";
  const teardown = await prepareMonorepo(rootDir, globby, tag);
  const port = await getPort();
  const registry = await startRegistry(verdaccioPath, port, registryLocation);
  project.provide("tag", tag);
  project.provide("registry", registry.toString());
  await publishPackages([...filters], tag, rootDir, registry);
  return () => {
    teardown();
    registry.kill();
  };
}
```

`e2e-tests/pkg-outputs/bundle.test.ts` では全パッケージの exports 設定を動的に走査し、ESM/CJS 両方のエントリポイントがディスク上に存在することを検証する:

```typescript
// e2e-tests/pkg-outputs/bundle.test.ts:19-57
describe.for(
  allPackages.filter(pkg => !globalIgnore.includes(pkg.packageJson.name))
    .map(pkg => [pkg.packageJson.name, pkg.packageJson] as const),
)("%s", async ([pkgName, pkgJson]) => {
  it('should have type="module"', () => {
    expect(pkgJson.type).toBe("module");
  });
  describe.concurrent.for(imports)("%s", async ([importPath]) => {
    it("should use .js and .d.ts extensions when using import", async () => {/* ... */});
    it("should use .cjs and .d.ts extensions when using require", async () => {/* ... */});
  });
});
```

### MockLanguageModel によるバージョン横断テスト

LLM バージョン（v1/v2/v3）をまたいだテストは、テストスイートを関数でラップしバージョンごとに呼び出す:

```typescript
// packages/core/src/agent/agent.test.ts:50,7596-7597
function agentTests({ version }: { version: "v1" | "v2"; }) {
  // ... hundreds of tests using MockLanguageModelV1 or MockLanguageModelV2
}
describe("Agent Tests", () => {
  agentTests({ version: "v1" });
  agentTests({ version: "v2" });
});
```

Mock 生成は共通ヘルパーに集約:

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

### AI エージェント向けテスト出力最適化

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

`reporters: 'dot'` で出力を最小化し、`bail: 1` で最初の失敗時に即座に停止させることで、AI ツールが消費するトークン量を削減している。このパターンは `packages/agent-builder/vitest.config.ts` と `integration-tests/vitest.config.ts` にも適用されている。

### Docker Compose による統合テストインフラ

```yaml
# .dev/docker-compose.yaml:1-33
services:
  db:
    image: pgvector/pgvector:0.8.0-pg16
    ports: ['5432:5432']
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-postgres}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-postgres}
  qdrant:
    image: qdrant/qdrant:latest
    ports: ['6333:6333']
  redis:
    image: redis
    ports: ['6379:6379']
```

テスト設定でフォールバック値を使い、環境変数なしでもローカル実行可能:

```typescript
// stores/pg/src/storage/test-utils.ts:10-17
export const TEST_CONFIG: PostgresStoreConfig = {
  host: process.env.POSTGRES_HOST || "localhost",
  port: Number(process.env.POSTGRES_PORT) || 5434,
  database: process.env.POSTGRES_DB || "postgres",
  user: process.env.POSTGRES_USER || "postgres",
  password: process.env.POSTGRES_PASSWORD || "postgres",
};
```

## パターンカタログ

- **Abstract Test Suite / Contract Test Factory** (分類: 振る舞い)
  - 解決する問題: 同一インターフェースの N 個の実装に対するテストの重複と仕様乖離
  - 適用条件: Strategy / Adapter パターンで複数の実装が存在する場合
  - コード例: `stores/_test-utils/src/factory.ts:28-86`, `server-adapters/_test-utils/src/route-adapter-test-suite.ts:27-80`, `observability/_test-utils/src/test-scenarios.ts:32-36`
  - 注意点: capability フラグが増えすぎると設定の組み合わせ爆発のリスクがある。ドメイン単位のグループ化で対応する

- **Test Double with Call Recording** (分類: テスト設計)
  - 解決する問題: 非同期イベント駆動処理のテストで、呼び出し順序と引数を検証する必要がある
  - 適用条件: 抽象クラスの複数メソッドが特定の順序で呼ばれることを検証する場合
  - コード例: `observability/_test-utils/src/test-exporter.ts:33-244`
  - 注意点: `MethodCall` 配列で全呼び出しを記録し、`wasMethodCalledForSpan()` 等のヘルパーで検証する設計

## Good Patterns

- **1行テスト適用**: ストアの実装テストが `createTestSuite(new PostgresStore(TEST_CONFIG))` の1行で完結する。テストの追加・変更はファクトリ側で一括管理される。

- **Capability フラグによる宣言的テストスキップ**: テスト内で条件分岐するのではなく、ファクトリ引数で `supportsRegex: false` と宣言する。各実装の制約が一箇所に集約され、ドキュメントとしても機能する。

```typescript
// stores/_test-utils/src/vector-factory.ts:48-65
export interface TestDomains {
  basicOps?: boolean; // on/off でドメイン単位の制御
  filterOps?: boolean;
  edgeCases?: boolean;
  largeBatch?: boolean; // edgeCases のサブセットを個別制御
}
```

- **`dangerously` プレフィックスでのプロダクション誤用防止**: テストデータクリーンアップメソッドに `dangerouslyClearAll()` と命名し、プロダクションコードでの誤用を型レベルではなく命名レベルで防止する。

- **パッケージ出力の自動検証**: 全パッケージの exports を動的に走査し、ESM/CJS エントリポイントの存在を自動検証する E2E テストを持つ。

## Anti-Patterns / 注意点

- **巨大テストファイル**: `agent.test.ts` は 7,641 行。関連テストが `__tests__/` に分割されている部分もあるが、メインファイルの肥大化は可読性とメンテナンス性を損なう。

```
// Bad: 7,641 行のテストファイル
packages/core/src/agent/agent.test.ts

// Better: 機能ごとに分割（実際に部分的に行われている）
packages/core/src/agent/__tests__/tool-handling.test.ts
packages/core/src/agent/__tests__/structured-output.test.ts
```

- **テスト内のバージョン条件分岐**: `if (version === 'v1') { ... } else { ... }` がテスト本体に残る箇所がある。`mock-model.ts` の `getSingleDummyResponseModel` のように、ファクトリヘルパーに集約すべき。

```typescript
// Bad: テスト内での直接分岐
if (version === 'v1') {
  testModel = new MockLanguageModelV1({ doGenerate: async () => ({ ... }) });
} else {
  testModel = new MockLanguageModelV2({ doGenerate: async () => ({ ... }) });
}

// Better: ファクトリヘルパーに集約
const dummyModel = getSingleDummyResponseModel(version);
```

## 導出ルール

- `[MUST]` 同一インターフェースの複数実装をテストする場合、テストスイートファクトリを作成して共通テストを集約する。各実装の差異は capability フラグで宣言的に表現する
  - 根拠: mastra は `stores/_test-utils` で 20+ のストレージアダプタに共通テストを適用し、各ストアのテストファイルが1行のファクトリ呼び出しで済んでいる

- `[MUST]` モノレポのテストファイルは命名規約（`.test.ts` / `.e2e.test.ts` / `.test-d.ts`）で種別を区別し、Vitest projects でカテゴリプレフィックス（`unit:` / `e2e:` / `typecheck:`）を付与して CI で選択的実行する
  - 根拠: CI で `--project 'unit:*'` と `--project 'e2e:*'` を別ジョブ・別シークレットで実行する分離を実現している（`.github/workflows/vitest-all.yml`）

- `[SHOULD]` パッケージの exports 設定（ESM/CJS エントリポイント）を E2E テストで自動検証し、ビルド成果物の存在を保証する
  - 根拠: `e2e-tests/pkg-outputs/bundle.test.ts` が全パッケージの exports を動的に走査し、`.js` / `.cjs` / `.d.ts` ファイルの存在を検証している

- `[SHOULD]` AI エージェントがテストを実行する場面を想定し、テストレポーターを最小出力（`dot`）+ 早期終了（`bail: 1`）に設定する
  - 根拠: 複数パッケージで `reporters: 'dot'` + `bail: 1` が設定され、コメントで「smaller output to save token space when LLMs run tests」と意図が明示されている

- `[SHOULD]` 統合テスト用インフラは Docker Compose で管理し、テスト設定で `process.env.X || 'default'` のフォールバック値を使って環境変数なしでもローカル実行可能にする
  - 根拠: `.dev/docker-compose.yaml` + `test-utils.ts` のフォールバックパターンで CI とローカルの両方で動作する設計

- `[SHOULD]` テストユーティリティやテストスイートファクトリはワークスペース内の独立パッケージ（`_test-utils`）として管理し、CHANGELOG とバージョンを持たせる
  - 根拠: `stores/_test-utils`、`server-adapters/_test-utils`、`observability/_test-utils` がそれぞれ独自の `package.json` と `CHANGELOG.md` を持つ

- `[SHOULD]` バージョン横断テストでは Mock 生成を共通ヘルパーに集約し、テスト本体にバージョン条件分岐を残さない
  - 根拠: `mock-model.ts` の `getSingleDummyResponseModel(version)` は簡潔だが、`agent.test.ts` 内の直接分岐はコードの複雑性を増している

- `[AVOID]` テストファイルを 400 行以上に肥大化させること。機能ごとに分割し、各ファイルは単一のテスト関心事に集中させる
  - 根拠: `agent.test.ts` の 7,641 行は可読性の限界を超えており、`__tests__/` ディレクトリへの分割が部分的に行われている

## 適用チェックリスト

- [ ] 同一インターフェースの実装が2つ以上ある場合、テストファクトリ（`createXxxTestSuite`）を作成しているか
- [ ] テストファイルの命名規約を定め、CI で種別ごとに選択的実行できるようにしているか
- [ ] Vitest の projects 機能でテストカテゴリを分離し、`--project` フラグで CI 上で独立実行できるか
- [ ] パッケージの exports 設定を自動検証する E2E テストがあるか
- [ ] 統合テスト用のインフラ起動スクリプト（Docker Compose 等）と環境変数フォールバックがあるか
- [ ] AI エージェント向けのテスト出力最適化（`reporters: 'dot'`, `bail: 1`）を検討したか
- [ ] テスト用 Mock やヘルパーを `_test-utils` パッケージや共有モジュールに集約しているか
- [ ] テストファイルが肥大化していないか（400 行を超えたら分割を検討）
- [ ] バージョン横断テストの条件分岐がファクトリヘルパーに集約されているか
