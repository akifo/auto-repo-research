# Architecture

> リポジトリ: mastra-ai/mastra
> 分析日: 2026-02-14

## 概要

Mastra は AI エージェント・ワークフロー・メモリ・ツールなどの機能を統合する TypeScript フレームワークであり、その全体アーキテクチャは「中央レジストリ + プラガブルな周辺パッケージ」の構造を取る。コアパッケージ (`@mastra/core`) が抽象インターフェースと登録メカニズムを定義し、ストレージ・ボイス・デプロイヤー・サーバーアダプターなどの具体実装は独立パッケージとして分離される。この分析では、レイヤー構成・依存関係の流れ・結合パターンを横断的に調査し、大規模モノレポにおける拡張可能なフレームワーク設計のプラクティスを抽出する。

## 背景にある原則

- **中央ハブによる構成集約（Composition Root）**: フレームワークの全コンポーネントを1つのエントリポイント（`Mastra` クラス）に集約し、依存関係の解決と横断的関心事（ロガー・オブザーバビリティ）の伝播を一箇所で行うべき。これにより、コンポーネント間の暗黙的な結合を排除し、テスト時のモック差し替えが容易になる（根拠: `packages/core/src/mastra/index.ts:500-699` のコンストラクタで全プリミティブを順序付きで登録し、`setLogger` で全コンポーネントに一括伝播する設計）。

- **インターフェースによる実装分離（Dependency Inversion）**: コアが依存するのは抽象クラス・インターフェースのみとし、具体実装はすべて外部パッケージに委ねるべき。これにより、23種のストレージバックエンド、13種のボイスプロバイダー、4種のデプロイヤーが同一のコアに対してプラグインできる（根拠: `MastraCompositeStore`, `MastraVoice`, `MastraDeployer`, `PubSub` などの抽象クラスがコアに定義され、具体実装は `stores/`, `voice/`, `deployers/` に分離）。

- **ドメイン分割による関心事の分離**: ストレージを機能ドメイン（memory, workflows, scores, observability, agents 等）ごとに独立したインターフェースに分割し、異なるバックエンドを組み合わせ可能にすべき。単一のストレージアダプターが全ドメインをカバーする必要はない（根拠: `MastraCompositeStore` の `domains` オプションにより、メモリは PostgreSQL、ワークフローは LibSQL のように混合構成が可能）。

- **NoOp パターンによるオプショナル機能の安全な無効化**: オプショナルな横断的機能（オブザーバビリティ等）には NoOp 実装を提供し、null チェックの散在を防ぐべき（根拠: `NoOpObservability` クラスがすべてのメソッドを空実装で提供し、利用側は `this.#observability.getDefaultInstance()` を null チェックなしで呼び出せる）。

## 実例と分析

### レイヤー構成と依存方向

Mastra のアーキテクチャは明確な4層構造を持つ。

1. **Core Layer** (`packages/core`): 抽象インターフェース、型定義、`Mastra` クラス（中央レジストリ）
2. **Feature Packages** (`packages/memory`, `packages/mcp`, `packages/rag`, `packages/server`): コアを拡張する機能パッケージ
3. **Adapter Layer** (`stores/`, `voice/`, `deployers/`, `server-adapters/`, `pubsub/`, `auth/`): プラガブルな具体実装
4. **Client Layer** (`client-sdks/`): クライアント向け SDK

依存方向は常に「外側 → 内側」であり、コアは一切の具体実装に依存しない。アダプターパッケージは `peerDependencies` でコアを参照する（例: `"@mastra/core": ">=1.4.0-0 <2.0.0-0"`）。

### 中央レジストリパターン（Mastra クラス）

`Mastra` クラスは10種以上のジェネリック型パラメータを持つ中央レジストリであり、全コンポーネントの登録・取得・ライフサイクル管理を行う。

```typescript
// packages/core/src/mastra/index.ts:292-306
export class Mastra<
  TAgents extends Record<string, Agent<any>> = Record<string, Agent<any>>,
  TWorkflows extends Record<string, AnyWorkflow> = Record<string, AnyWorkflow>,
  TVectors extends Record<string, MastraVector<any>> = Record<string, MastraVector<any>>,
  TTTS extends Record<string, MastraTTS> = Record<string, MastraTTS>,
  TLogger extends IMastraLogger = IMastraLogger,
  TMCPServers extends Record<string, MCPServerBase<any>> = Record<string, MCPServerBase<any>>,
  TScorers extends Record<string, MastraScorer<any, any, any, any>> = Record<string, MastraScorer<any, any, any, any>>,
  TTools extends Record<string, ToolAction<any, any, any, any, any, any>> = ...,
  TProcessors extends Record<string, Processor<any>> = ...,
  TMemory extends Record<string, MastraMemory> = ...,
> {
```

コンストラクタでの登録順序は意図的に制御されている。ツールとプロセッサが先に登録され、それらを参照する MCP サーバーとエージェントが後から登録される。

```typescript
// packages/core/src/mastra/index.ts:596-677
// Now add primitives - order matters for auto-registration
// Tools and processors should be added before agents and MCP servers that might use them
```

### 依存注入の伝播メカニズム

`Mastra` クラスは、コンポーネント登録時にロガー・ストレージ・他のプリミティブを `__registerPrimitives` / `__registerMastra` / `__setLogger` メソッドで注入する。これはフレームワーク内部の「プッシュ型 DI」であり、コンテナベースの DI ではなく明示的なメソッド呼び出しで行われる。

```typescript
// packages/core/src/mastra/index.ts:867-875
mastraAgent.__setLogger(this.#logger);
mastraAgent.__registerMastra(this);
mastraAgent.__registerPrimitives({
  logger: this.getLogger(),
  storage: this.getStorage(),
  agents: agents,
  tts: this.#tts,
  vectors: this.#vectors,
});
```

`setLogger` では全コンポーネントに対してロガーを一括伝播する（`packages/core/src/mastra/index.ts:2337-2395`）。これにより、ロガー変更時に全コンポーネントが自動的に新しいロガーを使う。

### ストレージのドメイン分割と合成

ストレージは `StorageDomains` 型で10個のドメインに分割され、各ドメインは独立した抽象クラスを持つ。

```typescript
// packages/core/src/storage/base.ts:16-27
export type StorageDomains = {
  workflows: WorkflowsStorage;
  scores: ScoresStorage;
  memory: MemoryStorage;
  observability?: ObservabilityStorage;
  agents?: AgentsStorage;
  datasets?: DatasetsStorage;
  experiments?: ExperimentsStorage;
  promptBlocks?: PromptBlocksStorage;
  scorerDefinitions?: ScorerDefinitionsStorage;
  mcpClients?: MCPClientsStorage;
};
```

`MastraCompositeStore` は `default` ストアと `domains` オーバーライドによる合成をサポートする。

```typescript
// packages/core/src/storage/base.ts:152-166
const storage = new MastraCompositeStore({
  id: "composite",
  default: pgStore,
  domains: {
    memory: libsqlStore.stores?.memory,
  },
});
```

PostgresStore の実装では、共有 DB クライアント設定 (`PgDomainClientConfig`) を全ドメインに渡す。各ドメインクラスは `StorageDomain` を継承し、`init()` と `dangerouslyClearAll()` を実装する。

```typescript
// stores/pg/src/storage/index.ts:136-154
const domainConfig: PgDomainClientConfig = {
  client: this.#db,
  schemaName: this.schema,
  skipDefaultIndexes: config.skipDefaultIndexes,
  indexes: config.indexes,
};

this.stores = {
  scores: new ScoresPG(domainConfig),
  workflows: new WorkflowsPG(domainConfig),
  memory: new MemoryPG(domainConfig),
  // ...
};
```

### 遅延初期化の Proxy パターン

ストレージの初期化は `augmentWithInit` 関数による Proxy で遅延実行される。全メソッド呼び出しの前に `ensureInit()` を挟むことで、利用側が明示的に `init()` を呼ぶ必要をなくしている。

```typescript
// packages/core/src/storage/storageWithInit.ts:34-63
const proxy = new Proxy(storage, {
  get(target, prop) {
    const value = target[prop as keyof typeof target];
    if (typeof value === "function") {
      if (prop === "init") {
        return async (...args: unknown[]) => {
          if (!hasInitialized) {
            hasInitialized = Reflect.apply(value, target, args) as Promise<void>;
          }
          return hasInitialized;
        };
      }
      // All other functions wait for init
      return async (...args: unknown[]) => {
        await ensureInit();
        return Reflect.apply(value, target, args);
      };
    }
    return Reflect.get(target, prop);
  },
});
```

### サーバーアダプターの分離

HTTP サーバー機能は3層に分離されている:

1. **ハンドラー層** (`packages/server/src/server/handlers/`): フレームワーク非依存のビジネスロジック（agents.ts, workflows.ts, memory.ts 等）
2. **アダプター基底** (`packages/server/src/server/server-adapter/`): ルート定義とミドルウェア管理
3. **フレームワークアダプター** (`server-adapters/hono/`, `server-adapters/express/` 等): Hono/Express 固有の実装

```typescript
// server-adapters/hono/src/index.ts:55
export class MastraServer extends MastraServerBase<HonoApp, HonoRequest, Context> {
```

Hono アダプターはフレームワーク固有の型（`HonoApp` インターフェース）を最小限に定義し、メソッドシグネチャの厳密な型マッチングを回避している。

### 共有テストスイートパターン

ストレージアダプターの品質保証には、共有テストスイート (`stores/_test-utils`) を使用する。各アダプターは `createTestSuite(storage)` を呼び出すだけで、全ドメインの標準テストが実行される。

```typescript
// stores/_test-utils/src/factory.ts:28
export function createTestSuite(storage: MastraStorage, capabilities: TestCapabilities = {}) {
```

## パターンカタログ

- **Composition Root** (構造)
  - 解決する問題: 多数のコンポーネント間の依存関係を明示的に管理し、暗黙的な結合を排除する
  - 適用条件: プラグイン可能なコンポーネントが5種以上あるフレームワーク
  - コード例: `packages/core/src/mastra/index.ts:500-699`
  - 注意点: コンストラクタが肥大化しやすい。登録順序の制約をコメントで明記すること

- **Abstract Factory / Plugin Architecture** (生成)
  - 解決する問題: 具体実装をコアから分離し、利用者が自由にバックエンドを差し替えられるようにする
  - 適用条件: 同一インターフェースに対して複数の実装が存在する（ストレージ 23 種、ボイス 13 種等）
  - コード例: `packages/core/src/storage/base.ts` (MastraCompositeStore), `packages/core/src/voice/voice.ts` (MastraVoice)
  - 注意点: peerDependencies のバージョン範囲管理が重要

- **Null Object / NoOp** (振る舞い)
  - 解決する問題: オプショナルな機能の null チェック散在を防ぐ
  - 適用条件: 横断的関心事（ロギング、オブザーバビリティ、キャッシュ等）がオプショナルな場合
  - コード例: `packages/core/src/observability/no-op.ts` (NoOpObservability)
  - 注意点: NoOp 実装はインターフェース変更時に追従が必要

- **Proxy-based Lazy Initialization** (構造)
  - 解決する問題: 非同期初期化が必要なリソースを、利用側に初期化タイミングを意識させずに使えるようにする
  - 適用条件: データベース接続やテーブル作成など、初回利用前に非同期セットアップが必要なリソース
  - コード例: `packages/core/src/storage/storageWithInit.ts:34-63`
  - 注意点: Proxy は vitest 環境で instanceof が正しく動作しないケースがある（コード内コメントに記載あり）

## Good Patterns

- **ドメイン分割ストレージと合成パターン**: ストレージを機能ドメインごとに独立インターフェースに分割し、`MastraCompositeStore` で異なるバックエンドを合成可能にしている。メモリは高速な LibSQL、ワークフロー状態は PostgreSQL のように、ドメインごとに最適なバックエンドを選択できる。

```typescript
// packages/core/src/storage/base.ts:194-222
if (config.default || config.domains) {
  const defaultStores = config.default?.stores;
  const domainOverrides = config.domains ?? {};
  this.stores = {
    memory: domainOverrides.memory ?? defaultStores?.memory,
    workflows: domainOverrides.workflows ?? defaultStores?.workflows,
    // ...
  } as StorageDomains;
}
```

- **プッシュ型 DI による横断的関心事の一括伝播**: `setLogger` メソッドがすべての登録済みコンポーネントにロガーを伝播する。コンテナベース DI のオーバーヘッドなしに、横断的関心事を確実に全コンポーネントへ届ける。

```typescript
// packages/core/src/mastra/index.ts:2337-2395
public setLogger({ logger }: { logger: TLogger }) {
  this.#logger = logger;
  if (this.#agents) {
    Object.keys(this.#agents).forEach(key => {
      this.#agents?.[key]?.__setLogger(this.#logger);
    });
  }
  // ... storage, vectors, mcpServers, workflows, workspace 等にも伝播
}
```

- **共有テストスイートによるアダプター品質保証**: `createTestSuite(storage)` に任意のストレージ実装を渡すだけで、全ドメインの標準テストが実行される。23 種のストレージアダプターすべてが同一のテスト基準を満たすことを保証する。

```typescript
// stores/_test-utils/src/factory.ts:28-30
export function createTestSuite(storage: MastraStorage, capabilities: TestCapabilities = {}) {
  describe(storage.constructor.name, () => {
    // 全ドメインのテストを自動登録
```

- **RequestContext による型安全なリクエストスコープ DI**: `RequestContext<Values>` がジェネリック型で型安全な key-value コンテナを提供し、ミドルウェアからツール実行まで一貫したコンテキスト伝播を実現する。

```typescript
// packages/core/src/request-context/index.ts:33-43
export class RequestContext<Values extends Record<string, any> | unknown = unknown> {
  private registry = new Map<string, unknown>();
  public set<K extends Values extends Record<string, any> ? keyof Values : string>(
    key: K,
    value: Values extends Record<string, any> ? (K extends keyof Values ? Values[K] : never) : unknown,
  ): void {
    this.registry.set(key as string, value);
  }
}
```

## Anti-Patterns / 注意点

- **コンストラクタの肥大化**: `Mastra` クラスのコンストラクタは約200行に及び、10種以上のコンポーネント登録、イベント設定、ロガー初期化を一手に引き受ける。コンストラクタが長大になると、初期化順序の把握が困難になり、新規コンポーネント追加時のリスクが高まる。

```typescript
// Bad: 200行超のコンストラクタ
constructor(config?: Config<...>) {
  // 200行にわたる初期化処理...
}

// Better: Builder パターンまたは初期化フェーズの分離
class Mastra {
  private initPrimitives(config) { /* ツール・プロセッサ登録 */ }
  private initInfra(config) { /* ロガー・ストレージ・オブザーバビリティ */ }
  private initComponents(config) { /* エージェント・ワークフロー */ }
}
```

- **ダブルアンダースコア API の増殖**: `__setLogger`, `__registerMastra`, `__registerPrimitives`, `__setRawConfig` など、フレームワーク内部のメソッドが `__` プレフィックスで命名されている。TypeScript では `private` / `#` で十分であり、`__` は慣習的に「触るな」という意味だが、実際には public アクセス可能なままである。

```typescript
// Bad: public だが __prefix で「内部用」を示す
public __setLogger(logger: IMastraLogger) { ... }

// Better: Symbol や #private を使い、型レベルで外部アクセスを防ぐ
#setLogger(logger: IMastraLogger) { ... }
// または、@internal JSDoc + API Extractor で public API から除外
```

## 導出ルール

- `[MUST]` プラガブルな周辺機能のインターフェースはコアパッケージに定義し、具体実装は `peerDependencies` で参照する独立パッケージに分離する
  - 根拠: Mastra は `MastraCompositeStore`, `MastraVoice`, `MastraDeployer`, `PubSub` の抽象をコアに置き、23種のストレージ・13種のボイス等の具体実装を独立パッケージとして提供しており、コアの変更なしにバックエンドを追加できる

- `[MUST]` フレームワークの全コンポーネントを1つのエントリポイント（Composition Root）に集約し、依存関係の解決と横断的関心事の伝播をそこで行う
  - 根拠: `Mastra` クラスのコンストラクタがすべてのプリミティブを登録し、`setLogger` で全コンポーネントにロガーを一括伝播する設計により、散在する暗黙的結合を排除している

- `[SHOULD]` オプショナルな横断的機能（ロギング・オブザーバビリティ・キャッシュ等）には NoOp 実装を提供し、利用側の null チェック散在を防ぐ
  - 根拠: `NoOpObservability` がすべてのメソッドを空実装で提供し、`this.#observability` を null チェックなしで安全に呼び出せるようにしている

- `[SHOULD]` 非同期初期化が必要なリソースには Proxy ベースの遅延初期化を適用し、利用側が初期化タイミングを意識しなくてよい API を提供する
  - 根拠: `augmentWithInit` が Proxy で全メソッドの前に `ensureInit()` を挿入し、ストレージのテーブル作成を初回利用時に自動実行する

- `[SHOULD]` プラグインの品質保証には共有テストスイートを提供し、すべての実装が同一の契約を満たすことを保証する
  - 根拠: `stores/_test-utils` の `createTestSuite(storage)` により、23種のストレージアダプターが全ドメインの標準テストをパスすることを保証している

- `[SHOULD]` ストレージ等のインフラ層は機能ドメインごとに独立したインターフェースに分割し、異なるバックエンドの合成を可能にする
  - 根拠: `StorageDomains` 型が10個のドメインを独立定義し、`MastraCompositeStore` の `domains` オプションで異種バックエンドの混合が可能

- `[AVOID]` コンストラクタに200行を超える初期化ロジックを詰め込む。コンポーネントの登録順序制約が暗黙的になり、追加・変更時のリスクが高まる
  - 根拠: `Mastra` クラスのコンストラクタは約200行に及び、ツール→プロセッサ→MCP→エージェントという順序制約がコメントでのみ伝達されている

- `[AVOID]` フレームワーク内部 API に `__` プレフィックスを使って public メソッドとして公開する。TypeScript の `#private` フィールドまたは `@internal` + API Extractor で型レベルの隠蔽を行うべき
  - 根拠: `__setLogger`, `__registerMastra` 等が public アクセス可能なまま残っており、フレームワーク利用者が誤って呼び出すリスクがある

## 適用チェックリスト

- [ ] フレームワーク/ライブラリを設計する際、プラガブルな機能のインターフェース（抽象クラスまたは interface）をコアに定義しているか
- [ ] 具体実装（DB ドライバ、外部サービスクライアント等）は `peerDependencies` で参照する独立パッケージに分離されているか
- [ ] コンポーネントの登録・取得・ライフサイクル管理を行う Composition Root が存在するか
- [ ] 横断的関心事（ロガー・テレメトリ等）の変更が全コンポーネントに確実に伝播する仕組みがあるか
- [ ] オプショナルな機能に NoOp 実装を提供し、null チェックの散在を防いでいるか
- [ ] 非同期初期化が必要なリソースに対して、利用側が初期化を意識しなくてよい API を提供しているか
- [ ] プラグイン/アダプターの品質保証に共有テストスイートを提供しているか
- [ ] ストレージ・インフラ層が機能ドメインごとに分割され、異なるバックエンドの合成が可能か
- [ ] コンストラクタが肥大化していないか（目安: 100行以内）
- [ ] 内部 API が `#private` または `@internal` で適切に隠蔽されているか
