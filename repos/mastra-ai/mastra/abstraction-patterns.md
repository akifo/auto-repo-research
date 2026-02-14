# abstraction-patterns

> リポジトリ: mastra-ai/mastra
> 分析日: 2026-02-14

## 概要

mastra はエージェントフレームワークとして、ストレージ（23 アダプター）、ベクトル DB（18 アダプター）、音声プロバイダー（13 アダプター）、認証（6 プロバイダー）、サーバー、デプロイヤーなど広範な外部バックエンドを統一インターフェースで抽象化している。この視点では「何を共通化し、何をアダプター固有にするか」の設計判断、及びプラグイン接続を支える抽象化手法を横断的に分析する。大規模プロバイダーエコシステムを一貫して拡張可能に保つための実践的パターンが数多く見られる。

## 背景にある原則

- **"最小限の抽象メソッド + デフォルトの no-op/warn" 原則**: 抽象基底クラスで全メソッドを `abstract` にせず、コア機能（speak/listen 等）のみ abstract とし、オプショナル機能（connect, send, on/off 等）は warn ログ付きのデフォルト実装を提供する。これにより、新規プロバイダー実装時の摩擦を最小化しつつ、利用者には統一 API を保証する（`packages/core/src/voice/voice.ts:95-175`）。
- **"共通基底 → ドメイン基底 → ベンダー実装" の三層継承**: `MastraBase` → 機能ドメインの abstract class（`MastraVector`, `MastraVoice`, `MemoryStorage` 等）→ ベンダー実装（`PgVector`, `ElevenLabsVoice` 等）の三層で、ロガー注入やコンポーネント識別は最上位で、ドメイン共通ロジック（バリデーション等）は中間層で、バックエンド固有処理は最下層で処理する。これは関心の分離を継承階層で明確化するため。
- **ジェネリクスによる "Filter-per-Vendor" 型安全性**: `MastraVector<Filter>` のように基底クラスをフィルタ型でパラメタライズし、各ベンダーが自身のフィルタ型（`PGVectorFilter`, `PineconeVectorFilter` 等）を注入する。これにより統一 API を保ちつつ、ベンダー固有のフィルタ演算子を型レベルで安全に拡張できる（`packages/core/src/vector/vector.ts:72`, `stores/pg/src/vector/filter.ts`）。
- **ドメイン分割による Composite Store**: ストレージを単一巨大インターフェースにせず、`MemoryStorage`, `WorkflowsStorage`, `AgentsStorage` 等のドメインに分割し、`MastraCompositeStore` で合成する。これにより異なるバックエンドのドメインを混在可能にする（例: メモリは PG、ワークフローは LibSQL）。

## 実例と分析

### 1. 抽象基底クラスのメソッド分類戦略

mastra の abstract class は、メソッドを3段階に分類している:

1. **abstract（実装必須）**: ドメインの本質機能。例: `MastraVector.query()`, `MastraVector.upsert()`, `MastraVoice.speak()`, `MastraVoice.listen()`
2. **デフォルト実装（warn ログ）**: サポートは任意だがインターフェース上存在するメソッド。例: `MastraVoice.connect()`, `MastraVoice.send()`, `MastraVoice.on()`
3. **デフォルト実装（throw Error）**: 将来的に実装が期待されるが、現時点では一部アダプターのみ対応。例: `MemoryStorage.listMessagesByResourceId()`, `MemoryStorage.cloneThread()`

```typescript
// packages/core/src/voice/voice.ts:103-107
// カテゴリ2: warn ログ付きデフォルト（任意実装）
connect(_options?: Record<string, unknown>): Promise<void> {
  this.logger.warn('connect not implemented by this voice provider');
  return Promise.resolve();
}
```

```typescript
// packages/core/src/storage/domains/memory/base.ts:72-77
// カテゴリ3: throw Error（段階的実装を促す）
async listMessagesByResourceId(_args: StorageListMessagesByResourceIdInput): Promise<StorageListMessagesOutput> {
  throw new Error(
    `Resource-scoped message listing is not implemented by this storage adapter (${this.constructor.name}). ` +
      `Use an adapter that supports Observational Memory (pg, libsql, mongodb) or disable observational memory.`,
  );
}
```

この「3段階分類」により、新しいアダプターは最低限の abstract メソッドだけ実装すれば動作し、必要に応じて段階的にケイパビリティを拡張できる。

### 2. フィルタ翻訳の Interpreter パターン

ベクトル検索のフィルタ構文は MongoDB-like な統一文法 (`$eq`, `$gt`, `$and` 等) を定義し、各ベンダーの `FilterTranslator` がこれをネイティブ文法に変換する。

```typescript
// packages/core/src/vector/filter/base.ts:154-156
abstract class BaseFilterTranslator<Filter = VectorFilter, Result = Filter> {
  abstract translate(filter: Filter): Result;
  // ... 共通のバリデーション・ユーティリティメソッド群
}
```

```typescript
// stores/pinecone/src/vector/filter.ts:35-51
export class PineconeFilterTranslator extends BaseFilterTranslator<PineconeVectorFilter> {
  protected override getSupportedOperators(): OperatorSupport {
    return {
      ...BaseFilterTranslator.DEFAULT_OPERATORS,
      logical: ["$and", "$or"], // Pinecone は $not/$nor 非対応
      array: ["$in", "$all", "$nin"],
      element: ["$exists"],
      regex: [], // Pinecone は regex 非対応
    };
  }
  // ...
}
```

各ベンダーは `getSupportedOperators()` をオーバーライドして対応演算子を宣言する。基底クラスの `validateFilter()` がこの宣言に基づいて入力を検証するため、非対応演算子の使用は実行前にエラーとなる。14 のベクトル DB アダプター全てがこのパターンを使用している。

### 3. Composite パターンによるプロバイダー合成

`CompositeVoice` は複数の `MastraVoice` プロバイダーを合成し、input/output/realtime の各機能を別プロバイダーに委譲する。

```typescript
// packages/core/src/voice/composite-voice.ts:26-52
export class CompositeVoice extends MastraVoice<...> {
  protected speakProvider?: MastraVoice;
  protected listenProvider?: MastraVoice;
  protected realtimeProvider?: MastraVoice;

  constructor({ input, output, realtime }: {
    input?: MastraVoice | TranscriptionModel;
    output?: MastraVoice | SpeechModel;
    realtime?: MastraVoice;
  }) {
    super();
    // AI SDK モデルの自動ラップ
    if (input) {
      this.listenProvider = isTranscriptionModel(input) ? new AISDKTranscription(input) : input;
    }
    if (output) {
      this.speakProvider = isSpeechModel(output) ? new AISDKSpeech(output) : output;
    }
    this.realtimeProvider = realtime;
  }
```

同様に `MastraCompositeStore` はストレージドメインを異なるバックエンドから合成する。

```typescript
// packages/core/src/storage/base.ts:210-222
this.stores = {
  memory: domainOverrides.memory ?? defaultStores?.memory,
  workflows: domainOverrides.workflows ?? defaultStores?.workflows,
  scores: domainOverrides.scores ?? defaultStores?.scores,
  // ...
} as StorageDomains;
```

### 4. VersionedStorageDomain のテンプレートメソッドパターン

`VersionedStorageDomain` は 12 個ものジェネリクスパラメータを持つ汎用基底クラスで、エンティティのバージョン管理ロジック（resolve, listResolved 等）をテンプレートメソッドとして提供する。具象サブクラスは CRUD と version 操作の abstract メソッドを実装するだけでよい。

```typescript
// packages/core/src/storage/domains/versioned.ts:124-137
export abstract class VersionedStorageDomain<
  TEntity extends VersionedEntityBase,
  TSnapshot,
  TResolved extends TEntity,
  TVersion extends VersionBase,
  TCreateVersion extends CreateVersionInputBase,
  TListVersionsInput extends ListVersionsInputBase,
  TListVersionsOutput extends ListVersionsOutputBase<TVersion>,
  TCreateInput,
  TUpdateInput,
  TListInput,
  TListOutput,
  TListResolvedOutput,
> extends StorageDomain {
  protected abstract readonly listKey: string;
  protected abstract readonly versionMetadataFields: string[];
  // ... resolveEntity, listResolved 等のテンプレートメソッド
}
```

```typescript
// packages/core/src/storage/domains/agents/base.ts:63-93
export abstract class AgentsStorage extends VersionedStorageDomain<
  StorageAgentType, StorageAgentSnapshotType, StorageResolvedAgentType,
  AgentVersion, CreateVersionInput, ListVersionsInput, ListVersionsOutput,
  { agent: StorageCreateAgentInput }, StorageUpdateAgentInput,
  StorageListAgentsInput | undefined, StorageListAgentsOutput, StorageListAgentsResolvedOutput
> {
  protected readonly listKey = 'agents';
  protected readonly versionMetadataFields = ['id', 'agentId', 'versionNumber', ...] satisfies (keyof AgentVersion)[];
}
```

## パターンカタログ

- **Adapter パターン** (構造)
  - 解決する問題: 異なる外部 API（PG, Pinecone, ElevenLabs 等）を統一インターフェースで利用可能にする
  - 適用条件: 同一機能を提供する複数バックエンドが存在し、交換可能にしたい場合
  - コード例: `MastraVector` → `PgVector`, `MastraVoice` → `ElevenLabsVoice`
  - 注意点: abstract class による継承型アダプターを採用（interface のみだと共通ロジックの再利用が困難）

- **Composite パターン** (構造)
  - 解決する問題: 複数プロバイダーの機能を1つのインターフェースに合成する
  - 適用条件: 入出力や機能ドメインが分離可能で、異なるバックエンドを組み合わせたい場合
  - コード例: `CompositeVoice` (`packages/core/src/voice/composite-voice.ts`), `MastraCompositeStore` (`packages/core/src/storage/base.ts`)

- **Interpreter パターン** (振る舞い)
  - 解決する問題: 統一フィルタ文法を各ベンダーのネイティブクエリに変換する
  - 適用条件: DSL をバックエンド固有の表現に翻訳する必要がある場合
  - コード例: `BaseFilterTranslator` → `PineconeFilterTranslator`, `PGFilterTranslator` 等（14 実装）

- **Template Method パターン** (振る舞い)
  - 解決する問題: バージョン管理の共通ワークフロー（resolve, list resolved）を再利用する
  - 適用条件: 異なるエンティティが同じライフサイクル操作を共有する場合
  - コード例: `VersionedStorageDomain` (`packages/core/src/storage/domains/versioned.ts`)

## Good Patterns

- **"Capability Flag" による段階的機能拡張**: `MemoryStorage.supportsObservationalMemory` のように boolean フラグでケイパビリティを宣言する。基底クラスのデフォルトメソッドは throw するが、フラグにより呼び出し元がサポート状況を事前チェックできる。

```typescript
// packages/core/src/storage/domains/memory/base.ts:37-38
readonly supportsObservationalMemory?: boolean = false;
```

- **型パラメータによるベンダー固有拡張の型安全性**: `MastraVector<Filter>` や `MastraServer<TApp, TRequest, TResponse>` のように、基底クラスをジェネリクスで開放し、ベンダーがフレームワーク固有の型を注入する。呼び出し元は統一 API を使いつつ、ベンダー固有パラメータも型安全に渡せる。

```typescript
// packages/core/src/vector/vector.ts:72
export abstract class MastraVector<Filter = VectorFilter> extends MastraBase {
  abstract query(params: QueryVectorParams<Filter>): Promise<QueryResult[]>;
}
// stores/pg/src/vector/index.ts:78
export class PgVector extends MastraVector<PGVectorFilter> { ... }
```

- **共通バリデーションロジックの基底クラスへの集約**: `MastraVector.validateExistingIndex()`, `MemoryStorage.validateMetadataKeys()`, `MemoryStorage.validatePagination()`, `BaseFilterTranslator.validateFilter()` のように、バリデーションは基底クラスの protected メソッドとして定義される。全アダプターで一貫したエラーハンドリングを保証する。

```typescript
// packages/core/src/vector/vector.ts:146-198
protected async validateExistingIndex(indexName: string, dimension: number, metric: string) {
  // 全ベクトル DB アダプター共通のインデックス検証ロジック
}
```

## Anti-Patterns / 注意点

- **過剰なジェネリクスパラメータ**: `VersionedStorageDomain` は 12 個の型パラメータを持つ。型安全性は高いが、新しいドメインを追加する際の認知負荷が大きい。

```typescript
// Bad: 12個のジェネリクスパラメータ
export abstract class VersionedStorageDomain<
  TEntity, TSnapshot, TResolved, TVersion, TCreateVersion,
  TListVersionsInput, TListVersionsOutput,
  TCreateInput, TUpdateInput, TListInput, TListOutput, TListResolvedOutput,
> extends StorageDomain { ... }
```

```typescript
// Better: 関連する型をグループ化して型パラメータ数を削減
interface VersionConfig<TEntity, TSnapshot, TVersion> {
  entity: TEntity; snapshot: TSnapshot; version: TVersion;
  // ...
}
export abstract class VersionedStorageDomain<C extends VersionConfig<any, any, any>>
  extends StorageDomain { ... }
```

- **abstract class + throw Error の混在**: `MemoryStorage` では一部メソッドが abstract（コンパイル時に実装を強制）、別のメソッドがデフォルトで throw Error（実行時にのみ検出）となっており、どのメソッドが実装必須かがコード上不明瞭。一貫したパターンが望ましい。

## 導出ルール

- `[MUST]` プラグインインターフェースでは、コア機能を abstract メソッドとし、オプショナル機能はデフォルト実装（warn ログ or throw）を提供する
  - 根拠: mastra の全 abstract class（MastraVoice, MastraVector, StorageDomain 等）がこのパターンを採用し、50 以上のアダプターの実装コストを最小化している
- `[MUST]` 複数バックエンドを統一する抽象レイヤーでは、バリデーションと共通ロジックを基底クラスの protected メソッドに集約する
  - 根拠: `MastraVector.validateExistingIndex()` や `BaseFilterTranslator.validateFilter()` が 18 のベクトル DB アダプター全てで一貫したバリデーションを保証している
- `[SHOULD]` 異なるバックエンドが同一機能に対して異なる制約を持つ場合、共通 DSL + Translator パターンで抽象化する
  - 根拠: `BaseFilterTranslator` とその 14 のベンダー実装が、MongoDB-like フィルタ文法を統一 API としつつベンダー固有制約を `getSupportedOperators()` で宣言している
- `[SHOULD]` 複数プロバイダーの機能を組み合わせる場合、Composite パターンで委譲する（継承ではなく合成）
  - 根拠: `CompositeVoice` が input/output/realtime を個別プロバイダーに委譲し、`MastraCompositeStore` がドメインごとに異なるストレージを合成している
- `[SHOULD]` ジェネリクスで基底クラスをパラメタライズし、ベンダー固有の型情報（フィルタ型、リクエスト型等）をコンパイル時に安全に伝搬させる
  - 根拠: `MastraVector<Filter>`, `MastraServer<TApp, TRequest, TResponse>` が統一 API とベンダー固有型安全性を両立している
- `[AVOID]` abstract class の型パラメータを 5 個以上にする。関連する型をインターフェースにグループ化して削減する
  - 根拠: `VersionedStorageDomain` の 12 個の型パラメータは宣言箇所（`AgentsStorage` 等）で可読性を著しく低下させている

## 適用チェックリスト

- [ ] 複数バックエンドを抽象化する際、メソッドを「abstract（必須）」「デフォルト warn（任意）」「デフォルト throw（段階的）」に分類しているか
- [ ] 共通バリデーションロジック（入力検証、制約チェック）を基底クラスの protected メソッドに集約しているか
- [ ] バックエンド固有の制約（対応演算子、サポート機能等）をメタデータ or メソッドオーバーライドで宣言可能にしているか
- [ ] 異なるプロバイダーの機能を組み合わせる必要がある場合、Composite パターン（委譲）を検討しているか
- [ ] ジェネリクスの型パラメータが 4 個以下に収まっているか（超える場合はグループ化を検討）
- [ ] 新しいアダプター追加時に実装すべきメソッドと任意のメソッドが明確に区別されているか
- [ ] DSL → バックエンド固有構文の変換が必要な場合、Translator/Interpreter パターンで対応しているか
