# Extensibility Mechanisms

> リポジトリ: mastra-ai/mastra
> 分析日: 2026-02-14

## 概要

mastra のコードベースは、プラグイン登録・アダプター拡張・カスタムプロバイダー統合のために一貫した拡張メカニズムを備えている。23 のストレージアダプター、13 の音声プロバイダー、4 つのデプロイヤー、2 つのサーバーアダプターといった豊富な拡張ポイントが、すべて同一の設計原則に基づいて構築されている。注目すべきは、これだけの規模のプラグインエコシステムを「abstract class + 中央レジストリ + 自動 DI」という簡潔なパターンで統一している点である。アダプター追加時のボイラープレートが最小化されており、新しいプロバイダーの実装コストが低い。

## 背景にある原則

- **Contract-First Extension（契約先行の拡張）**: 拡張ポイントはすべて abstract class で定義され、具象クラスが実装すべきメソッド群が型レベルで明示される。interface ではなく abstract class を使うことで、デフォルト実装を持つオプショナルメソッド（`connect()`, `send()` 等）と必須メソッド（`speak()`, `listen()`）を自然に区別できる。根拠: `MastraVoice` は `speak`/`listen` を abstract にしつつ、`connect`/`send`/`close` にはデフォルトの warn 実装を持つ（`packages/core/src/voice/voice.ts:103-117`）。

- **Automatic DI via Central Registry（中央レジストリを通じた自動 DI）**: `Mastra` クラスが全コンポーネントのレジストリかつ DI コンテナとして機能し、登録時にロガー・ストレージ等の横断的関心事を自動注入する。コンポーネント自身が依存を解決する必要がなく、Mastra 経由で必要なサービスを受け取る。根拠: `addAgent` メソッドが `__setLogger`, `__registerMastra`, `__registerPrimitives` を順次呼び出す（`packages/core/src/mastra/index.ts:867-875`）。

- **Domain Segregation（ドメイン分離）**: ストレージのように複数の責務を持つシステムは、単一の巨大 interface ではなくドメイン単位に分割する。各ドメイン（memory, workflows, scores 等）が独立した抽象クラスとなり、新ドメインの追加が既存ドメインに影響しない。根拠: `StorageDomains` 型は `workflows`, `scores`, `memory` を必須とし、`observability`, `agents`, `datasets` 等をオプショナルとして定義（`packages/core/src/storage/base.ts:16-27`）。

- **Transparent Lifecycle Management（透過的ライフサイクル管理）**: コンポーネントの初期化を利用者から隠蔽し、最初の呼び出し時に自動実行する。Proxy パターンで `getStore()` や各種メソッド呼び出しの前に `init()` を暗黙的に実行し、race condition も防ぐ。根拠: `augmentWithInit` が Proxy で全メソッド呼び出しの前に `ensureInit()` を差し込む（`packages/core/src/storage/storageWithInit.ts:34-63`）。

## 実例と分析

### 抽象基底クラスの階層設計

mastra では拡張ポイントごとに abstract class を定義し、共通の `MastraBase` を継承する。この共通基底により、全コンポーネントがログ機能を持ち、`__setLogger` で一括更新される。

拡張ポイントの階層は以下のようになる:

- **MastraBase** → `MastraVoice`, `MastraVector`, `StorageDomain`, `MastraDeployer`, `MastraServerBase`, `PubSub`, `MastraModelGateway`
- **StorageDomain** → `MemoryStorage`, `WorkflowsStorage`, `ScoresStorage`, `ObservabilityStorage` 等
- **StorageDomain** → `VersionedStorageDomain` → `AgentsStorage`, `PromptBlocksStorage`, `ScorerDefinitionsStorage`

ストレージアダプターは `MastraCompositeStore` を継承し、各ドメイン実装（`MemoryPG`, `WorkflowsPG` 等）を `stores` プロパティに組み立てる。

### 統一された登録パターン（add* メソッド群）

`Mastra` クラスの `addAgent`, `addVector`, `addTool`, `addProcessor`, `addGateway` 等のメソッドは、すべて同一のパターンに従う:

1. null/undefined チェック（`createUndefinedPrimitiveError` で統一エラー）
2. key の決定（明示的な key、なければ `component.id`）
3. 重複チェック（既存なら skip + debug ログ）
4. ロガー注入（`__setLogger`）
5. Mastra 参照の注入（`__registerMastra`、対応するコンポーネントのみ）
6. レジストリへの格納

この統一パターンにより、新しいコンポーネントタイプを追加する際も同じ骨格を踏襲すれば良い。

### Composite パターンによるストレージ合成

`MastraCompositeStore` は単一のストレージアダプターとしても使えるが、複数のストレージバックエンドからドメインを合成する機能も持つ。例えば PostgreSQL の memory と LibSQL の workflows を組み合わせることができる。

### ToolProvider インターフェースによる外部ツール統合

`ToolProvider` interface は「UI 向け Discovery」と「ランタイム向け Resolution」の 2 つの責務を分離している。`listToolkits()`, `listTools()` は UI がブラウジングに使い、`resolveTools()` はエージェントが実行時にツールを解決する。

### Processor のオプショナルメソッドパターン

`Processor` interface は 5 つのライフサイクルメソッド（`processInput`, `processInputStep`, `processOutputStream`, `processOutputResult`, `processOutputStep`）をすべてオプショナルに定義する。プロセッサーは必要なフェーズのメソッドだけ実装すれば良い。`BaseProcessor` abstract class を継承すれば、Mastra インスタンスへのアクセスも自動的に得られる。

## コード例

```typescript
// packages/core/src/voice/voice.ts:31-57
// abstract class + デフォルト実装パターン: 必須メソッドは abstract、オプショナルメソッドは warn 付きデフォルト
export abstract class MastraVoice<...> extends MastraBase {
  abstract speak(input: string | NodeJS.ReadableStream, options?: {...}): Promise<NodeJS.ReadableStream | void>;
  abstract listen(audioStream: NodeJS.ReadableStream | unknown, options?: TListenOptions): Promise<string | NodeJS.ReadableStream | void>;

  // オプショナルメソッド — 基底クラスで安全なデフォルトを提供
  connect(_options?: Record<string, unknown>): Promise<void> {
    this.logger.warn('connect not implemented by this voice provider');
    return Promise.resolve();
  }
}
```

```typescript
// packages/core/src/mastra/index.ts:1123-1138
// 統一された add* メソッドパターン
public addVector<V extends MastraVector>(vector: V, key?: string): void {
  if (!vector) {
    throw createUndefinedPrimitiveError('vector', vector, key);
  }
  const vectorKey = key || vector.id;
  const vectors = this.#vectors as Record<string, MastraVector>;
  if (vectors[vectorKey]) {
    const logger = this.getLogger();
    logger.debug(`Vector with key ${vectorKey} already exists. Skipping addition.`);
    return;
  }
  vector.__setLogger(this.#logger || this.getLogger());
  vectors[vectorKey] = vector;
}
```

```typescript
// packages/core/src/storage/base.ts:167-225
// Composite パターン: 単一 class がアダプター基底と合成コンテナを兼ねる
export class MastraCompositeStore extends MastraBase {
  constructor(config: MastraCompositeStoreConfig) {
    // ...
    if (config.default || config.domains) {
      // 合成モード: default から fallback し、domains で上書き
      this.stores = {
        memory: domainOverrides.memory ?? defaultStores?.memory,
        workflows: domainOverrides.workflows ?? defaultStores?.workflows,
        // ...
      } as StorageDomains;
    }
    // else: サブクラスが直接 stores を設定
  }
}
```

```typescript
// packages/core/src/storage/storageWithInit.ts:34-63
// Proxy を使った遅延初期化: 全メソッドを init 待ちでラップ
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
      return async (...args: unknown[]) => {
        await ensureInit();
        return Reflect.apply(value, target, args);
      };
    }
    return Reflect.get(target, prop);
  },
});
```

```typescript
// stores/pg/src/storage/index.ts:110-154
// ストレージアダプターの具象実装: ドメイン組み立てパターン
export class PostgresStore extends MastraCompositeStore {
  stores: StorageDomains;

  constructor(config: PostgresStoreConfig) {
    super({ id: config.id, name: "PostgresStore", disableInit: config.disableInit });
    const domainConfig: PgDomainClientConfig = {
      client: this.#db,
      schemaName: this.schema,
    };
    this.stores = {
      scores: new ScoresPG(domainConfig),
      workflows: new WorkflowsPG(domainConfig),
      memory: new MemoryPG(domainConfig),
      observability: new ObservabilityPG(domainConfig),
      agents: new AgentsPG(domainConfig),
      // ...
    };
  }
}
```

## パターンカタログ

- **Abstract Factory** (分類: 生成)
  - 解決する問題: ストレージアダプターが異なるバックエンド向けのドメイン実装群を一括生成する
  - 適用条件: 複数の関連オブジェクト（memory, workflows, scores 等）を一貫したバックエンドで生成する必要がある場合
  - コード例: `stores/pg/src/storage/index.ts:143-154` — `PostgresStore` が `MemoryPG`, `WorkflowsPG` 等を一括生成
  - 注意点: ドメイン追加時に全アダプターの stores 組み立てを更新する必要がある

- **Composite** (分類: 構造)
  - 解決する問題: 複数のストレージバックエンドのドメインを単一のストレージとして扱う
  - 適用条件: 用途ごとに異なるバックエンドを使いたい場合（memory は PG、workflows は LibSQL 等）
  - コード例: `packages/core/src/storage/base.ts:167-225` — `MastraCompositeStore` の `default` + `domains` 合成
  - 注意点: 合成されたストレージの初期化は全ドメインを並列に実行する

- **Template Method** (分類: 振る舞い)
  - 解決する問題: abstract class のデフォルト実装でオプショナル機能の骨格を定義し、サブクラスが必要な部分だけオーバーライドする
  - 適用条件: コンポーネントが「必須機能」と「オプショナル機能」を併せ持つ場合
  - コード例: `packages/core/src/voice/voice.ts:103-117` — `connect()`, `send()`, `close()` がデフォルト warn 付き実装
  - 注意点: デフォルト実装が「何もしない」のか「警告を出す」のかを統一すべき

- **Proxy** (分類: 構造)
  - 解決する問題: 初回アクセス時の遅延初期化を透過的に実現する
  - 適用条件: 初期化が非同期で、利用者に init() の明示的呼び出しを強制したくない場合
  - コード例: `packages/core/src/storage/storageWithInit.ts:34-63` — `augmentWithInit` の Proxy
  - 注意点: Proxy は vitest 等のテストフレームワークで `instanceof` が壊れる場合がある（Symbol でガード）

- **Service Locator / DI Container** (分類: 構造)
  - 解決する問題: コンポーネント間の依存を中央レジストリで管理し、横断的関心事を一箇所から注入する
  - 適用条件: 多数のプラグインが共通のインフラ（ロガー、ストレージ、オブザーバビリティ）を必要とする場合
  - コード例: `packages/core/src/mastra/index.ts:2337-2393` — `setLogger` が全コンポーネントへ一括伝播
  - 注意点: 循環参照を避けるため、登録順序に配慮が必要（tools → agents → MCP servers の順）

## Good Patterns

- **Null-safe 登録 with 一貫エラーメッセージ**: 全 `add*` メソッドが `createUndefinedPrimitiveError` を使い、config のスプレッドで発生しがちな undefined 値を検出する。エラーメッセージに「config was spread ({ ...config }) and the original object had getters or non-enumerable properties」という具体的なヒントを含め、デバッグを容易にしている。

```typescript
// packages/core/src/mastra/index.ts:44-68
function createUndefinedPrimitiveError(type: ..., value: null | undefined, key?: string): MastraError {
  return new MastraError({
    text: `Cannot add ${typeLabel}: ${typeLabel} is ${value === null ? 'null' : 'undefined'}. This may occur if config was spread...`,
  });
}
```

- **ドメイン分離による段階的オプトイン**: `StorageDomains` 型で必須ドメイン（`workflows`, `scores`, `memory`）とオプショナルドメイン（`observability?`, `agents?`, `datasets?`）を明確に区別する。新機能のドメインを `?` で追加すれば、既存のアダプターは変更なしで動作し続ける。

```typescript
// packages/core/src/storage/base.ts:16-27
export type StorageDomains = {
  workflows: WorkflowsStorage; // 必須
  scores: ScoresStorage; // 必須
  memory: MemoryStorage; // 必須
  observability?: ObservabilityStorage; // オプショナル
  agents?: AgentsStorage; // オプショナル
  datasets?: DatasetsStorage; // オプショナル
  // ...
};
```

- **CompositeVoice による入出力分離**: 音声プロバイダーの「入力（聴取）」と「出力（発話）」を別々のプロバイダーに委譲できる `CompositeVoice` パターン。AI SDK モデルの自動ラップも含め、異なるプロバイダーの組み合わせを柔軟に実現する。

```typescript
// packages/core/src/voice/composite-voice.ts:31-52
export class CompositeVoice extends MastraVoice<...> {
  constructor({ input, output, realtime }: {
    input?: MastraVoice | TranscriptionModel;
    output?: MastraVoice | SpeechModel;
    realtime?: MastraVoice;
  }) {
    // AI SDK モデルを自動ラップ
    if (input) {
      this.listenProvider = isTranscriptionModel(input) ? new AISDKTranscription(input) : input;
    }
  }
}
```

## Anti-Patterns / 注意点

- **setLogger の O(N) 伝播**: `setLogger` メソッドが全コンポーネント（agents, deployer, tts, storage, vectors, mcpServers, workflows, memory 等）を forEach で走査し、一つずつロガーを更新する。コンポーネント数が増えるほど追加コストが線形に増加し、新しいコンポーネントタイプを追加するたびにこのメソッドの修正が必要になる。

```typescript
// Bad: 各コンポーネントタイプごとに手動で走査
public setLogger({ logger }: { logger: TLogger }) {
  this.#logger = logger;
  if (this.#agents) { Object.keys(this.#agents).forEach(key => { ... }); }
  if (this.#deployer) { this.#deployer.__setLogger(this.#logger); }
  if (this.#tts) { Object.keys(this.#tts).forEach(key => { ... }); }
  // ... 10+ のコンポーネントタイプを個別に処理
}

// Better: MastraBase のリストを一元管理し、ループ一つで処理
private components: Set<MastraBase> = new Set();
public setLogger({ logger }: { logger: TLogger }) {
  this.#logger = logger;
  for (const component of this.components) {
    component.__setLogger(this.#logger);
  }
}
```

- **init() の二重ガード**: `MastraCompositeStore` の `hasInitialized` と `PostgresStore` の `isInitialized` が別々に初期化状態を管理しており、さらに `augmentWithInit` の Proxy が第三の初期化ガードを追加する。三重の防御が混乱を生む可能性がある。初期化ロジックは一つの層に集約すべき。

## 導出ルール

- `[MUST]` 拡張ポイントの契約は abstract class で定義し、必須メソッドは `abstract`、オプショナルメソッドは安全なデフォルト実装（warn ログ or no-op）を持たせる
  - 根拠: mastra の `MastraVoice` は `speak`/`listen` を abstract にしつつ、`connect`/`send`/`close` に warn 付きデフォルトを持ち、13 プロバイダーが必要なメソッドだけオーバーライドしている（`packages/core/src/voice/voice.ts:103-117`）

- `[MUST]` プラグイン登録メソッドは null/undefined チェック → key 決定 → 重複チェック → DI 注入 → 格納の順序で統一する
  - 根拠: mastra の `addAgent`, `addVector`, `addTool`, `addGateway` 等すべてが同一の 5 ステップに従い、一貫したエラーハンドリングと重複防止を実現している（`packages/core/src/mastra/index.ts:843-925, 1123-1138, 1884-1897`）

- `[SHOULD]` 大きなインターフェースは機能ドメインごとに分割し、必須ドメインとオプショナルドメインを型レベルで区別する
  - 根拠: `StorageDomains` が `workflows`/`scores`/`memory` を必須に、`observability`/`agents`/`datasets` をオプショナルにすることで、新ドメイン追加が既存アダプターを壊さない（`packages/core/src/storage/base.ts:16-27`）

- `[SHOULD]` 非同期初期化が必要なコンポーネントは Proxy で全メソッドの前に init を暗黙実行し、利用者に初期化の明示的呼び出しを強制しない
  - 根拠: `augmentWithInit` が storage の全メソッドを Proxy でラップし、初回アクセス時に自動で init() を実行する。`disableInit` フラグで CI/CD 環境ではオプトアウトも可能（`packages/core/src/storage/storageWithInit.ts:5-66`）

- `[SHOULD]` 横断的関心事（ロガー、オブザーバビリティ等）の注入は共通基底クラスの `__set*` メソッドで統一し、中央レジストリが一括管理する
  - 根拠: `MastraBase.__setLogger` を全コンポーネントが継承し、`Mastra.setLogger` が一括伝播する設計により、新コンポーネントの追加時もロガー対応が自動的に得られる（`packages/core/src/base.ts:46-52`）

- `[AVOID]` 拡張ポイントの合成（複数プロバイダーの組み合わせ）を利用者に手動で実装させない — フレームワーク側で Composite クラスを提供する
  - 根拠: `CompositeVoice` が入力・出力・リアルタイムの各プロバイダーを統合し、AI SDK モデルの自動ラップも含めて利用者のボイラープレートを排除している（`packages/core/src/voice/composite-voice.ts:26-52`）

- `[AVOID]` 初期化状態の管理を複数の層で重複させない — 一つの権威ある層で管理する
  - 根拠: `MastraCompositeStore.hasInitialized`, `PostgresStore.isInitialized`, `augmentWithInit` の Proxy が三重にガードしており、どの層が責任を持つか不明瞭になっている

## 適用チェックリスト

- [ ] 拡張ポイントごとに abstract class を定義し、必須/オプショナルメソッドを明確に区別しているか
- [ ] プラグイン登録パターン（null チェック → key 決定 → 重複チェック → DI → 格納）が全コンポーネントで統一されているか
- [ ] 大きなインターフェースがドメイン単位に分割され、新ドメインがオプショナルフィールドとして追加可能か
- [ ] 非同期初期化が Proxy や遅延パターンで透過的に処理されているか
- [ ] 横断的関心事（ロガー等）が共通基底クラスを通じて自動注入されているか
- [ ] 複数プロバイダーの合成が Composite クラスとして提供されているか
- [ ] 初期化状態の管理が一つの層に集約され、重複ガードがないか
- [ ] 新しいアダプター追加に必要なボイラープレートが最小限に抑えられているか（abstract メソッドの実装だけで済むか）
