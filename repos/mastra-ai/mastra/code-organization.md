# Code Organization

> リポジトリ: mastra-ai/mastra
> 分析日: 2026-02-14

## 概要

mastra-ai/mastra は大規模 TypeScript モノレポ（4464 ソースファイル）のコード構成を分析した視点である。このリポジトリは「カテゴリ別ワークスペース分割」「サブパスエクスポートによる極小メインエントリ」「ドメイン分割ストレージ」「内部パッケージの命名規約」など、スケーラブルなモノレポ構成の実践例が豊富に含まれている。特に注目すべきは、メインの `index.ts` がたった1行のエクスポートしか持たず、すべてのモジュールをサブパスエクスポートで公開する戦略である。

## 背景にある原則

- **最小公開面の原則**: パッケージのメインエントリポイントは最小限に保ち、ユーザーが必要な機能だけをインポートできるようにすべき。なぜなら、大規模フレームワークでメインエントリからすべてをエクスポートすると、Tree-shaking の効果が低下し、バンドルサイズが膨らむため（`packages/core/src/index.ts` がわずか1行で `Mastra` と `Config` のみをエクスポート）。

- **カテゴリ・役割による物理的分離の原則**: 同じ責務を持つパッケージ群は独立したトップレベルディレクトリに配置すべき。なぜなら、パッケージ数が 60 を超えると `packages/` 一箇所に押し込めるだけでは見通しが悪くなり、新しいアダプター追加時にどこに置くべきか迷いが生じるため（`stores/`, `voice/`, `auth/`, `deployers/`, `server-adapters/` が各カテゴリごとに分離）。

- **抽象とアダプターの階層分離の原則**: コアパッケージが抽象インターフェースと基底クラスを定義し、具体的な実装はカテゴリ別パッケージに配置すべき。なぜなら、コアに実装を持つと外部依存が増え、コアのバンドルサイズと複雑性が膨らむため（`MastraVoice` 抽象クラスは `@mastra/core/voice`、`OpenAIVoice` 実装は `@mastra/voice-openai`）。

- **共有テストスイートによる適合性保証の原則**: アダプターパターンを採用するときは、共有テストスイートを用意して全アダプターの契約準拠を保証すべき。なぜなら、23 ストアアダプターを個別テストで品質維持するのは非現実的であり、インターフェース違反が見逃されるため（`@internal/storage-test-utils` が `createTestSuite(storage)` で全ストアに統一テストを適用）。

## 実例と分析

### メインエントリの極小化とサブパスエクスポート

`@mastra/core` のメインエントリポイントは驚くほど小さい。

```typescript
// packages/core/src/index.ts:1
export { Mastra, type Config } from './mastra';
```

一方で、`package.json` の `exports` フィールドに 20 以上のサブパスエクスポートが定義されている。これにより利用者は `@mastra/core/agent`, `@mastra/core/storage`, `@mastra/core/voice` のように必要なモジュールだけをインポートする。

```jsonc
// packages/core/package.json:13-33 (抜粋)
"exports": {
  ".": { "import": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "./*": { "import": { "types": "./dist/*/index.d.ts", "default": "./dist/*/index.js" } },
  "./tools/is-vercel-tool": { /* ... */ },
  "./workflows/_constants": { /* ... */ }
}
```

ワイルドカード `./*` パターンで `dist/*/index.js` にマッピングしつつ、特定のファイルへの直接パスも `./tools/is-vercel-tool` のように個別に定義している。この「ワイルドカード + 例外パス」の二段構えが重要で、ディレクトリ構造に従わない特殊なエントリポイントにも対応できる。

### カテゴリ別トップレベルディレクトリ

pnpm ワークスペース定義がカテゴリ別のトップレベルディレクトリを反映している。

```yaml
# pnpm-workspace.yaml:1-14
packages:
  - packages/*
  - deployers/*
  - stores/*
  - voice/*
  - workflows/*
  - server-adapters/*
  - auth/*
  - client-sdks/*
  - integrations/*
  - observability/*
  - pubsub/*
```

`stores/` に 23 アダプター、`voice/` に 13 プロバイダー、`auth/` に 6 プロバイダーが配置されている。各カテゴリ内のパッケージは対等な構造を持ち、スコープ付き npm パッケージ名で一貫して命名されている（例: `@mastra/pg`, `@mastra/voice-openai`, `@mastra/auth-clerk`）。

### 内部パッケージのアンダースコア命名規約

内部専用パッケージはディレクトリ名にアンダースコアプレフィックスを使い、npm スコープは `@internal/` を使う。

```jsonc
// packages/_config/package.json
{ "name": "@internal/lint", "private": true }

// packages/_types-builder/package.json
{ "name": "@internal/types-builder", "private": true }

// stores/_test-utils/package.json
{ "name": "@internal/storage-test-utils", "private": true }
```

`private: true` でレジストリに公開されないことを保証しつつ、ファイルシステム上のアンダースコアプレフィックスで「これは内部パッケージである」ことを視覚的に即座に判別できる。各カテゴリディレクトリ（`stores/`, `server-adapters/`）にも `_test-utils` が配置されており、テストユーティリティのスコープがカテゴリに閉じている。

### 共有テストスイートファクトリ

23 のストアアダプターが同一の契約に準拠していることを保証するために、ファクトリパターンでテストスイートを共有している。

```typescript
// stores/_test-utils/src/factory.ts:28
export function createTestSuite(storage: MastraStorage, capabilities: TestCapabilities = {}) {
  describe(storage.constructor.name, () => {
    beforeAll(async () => { await storage.init(); });
    // ... 全ドメインのテストを実行
  });
}

// stores/pg/src/storage/index.test.ts:23-24
createTestSuite(new PostgresStore(TEST_CONFIG));
createTestSuite(new PostgresStore({ ...TEST_CONFIG, schemaName: 'my_schema' }));
```

各ストアは `createTestSuite(new XxxStore(config))` の1行で全契約テストを実行できる。ストア固有のテストはその後に追加する。

### ドメイン分割ストレージアーキテクチャ

ストレージを単一の巨大インターフェースではなく、機能ドメインごとに分割している。

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

各ドメインが独立した型定義を持ち、オプショナルなドメインは `?` で表現されている。`MastraCompositeStore` はこれらのドメインを異なるストレージバックエンドから合成できる。

```typescript
// packages/core/src/storage/base.ts:154-165 (コメントから)
// const storage = new MastraCompositeStore({
//   id: 'composite',
//   default: pgStore,
//   domains: { memory: libsqlStore.stores?.memory },
// });
```

### モジュール内の index.ts パターン

各サブモジュールの `index.ts` は明確なエクスポート戦略を持つ。多くのモジュールでは `export * from './xxx'` を使って内部ファイルを再エクスポートしつつ、選択的に `export type` で型のみのエクスポートを行っている。

```typescript
// packages/core/src/agent/index.ts:1-15
export { TripWire } from './trip-wire';
export { MessageList, convertMessages, aiV5ModelMessageToV2PromptMessage, TypeDetector } from './message-list';
export type { OutputFormat } from './message-list';
export * from './types';
export * from './agent';
export * from './utils';
export type {
  AgentExecutionOptions,
  AgentExecutionOptionsBase,
  InnerAgentExecutionOptions,
  MultiPrimitiveExecutionOptions,
} from './agent.types';
export type { MastraLanguageModel, MastraLegacyLanguageModel } from '../llm/model/shared.types';
```

`export *` と名前付きエクスポートの混在で、公開 API の制御と利便性を両立している。特に `export type` による型のみの再エクスポートは、ランタイムコードと型定義の分離を明示する。

### 後方互換性のためのエイリアスパターン

クラスやインターフェースのリネーム時に `@deprecated` エイリアスを残して段階的に移行する。

```typescript
// packages/core/src/storage/base.ts:304-312
/**
 * @deprecated Use MastraCompositeStoreConfig instead. This alias will be removed in a future version.
 */
export interface MastraStorageConfig extends MastraCompositeStoreConfig {}

/**
 * @deprecated Use MastraCompositeStore instead. This alias will be removed in a future version.
 */
export class MastraStorage extends MastraCompositeStore {}
```

```typescript
// packages/memory/src/index.ts:1734-1738
// Re-export memory processors from @mastra/core for backward compatibility
export { SemanticRecall, WorkingMemory, MessageHistory } from '@mastra/core/processors';
// Re-export clone-related types for convenience
export type { StorageCloneThreadInput, StorageCloneThreadOutput, ThreadCloneMetadata } from '@mastra/core/storage';
```

### フィーチャーフラグによる漸進的機能追加

`Set` ベースの軽量フィーチャーフラグで、パッケージ間のバージョン互換性を実行時に検証する。

```typescript
// packages/core/src/features/index.ts:16-17
export const coreFeatures = new Set<string>([
  'observationalMemory', 'asyncBuffering', 'workspaces-v1', 'datasets'
]);

// packages/memory/src/index.ts:1665-1666 (使用側)
const coreSupportsOM = coreFeatures.has('observationalMemory');
```

これにより、`@mastra/memory` は `@mastra/core` のバージョンに依存する機能を安全にチェックし、未対応なら明確なエラーメッセージを出すことができる。

### peerDependencies によるコア依存管理

すべてのアダプターパッケージは `@mastra/core` を `peerDependencies` として宣言し、`devDependencies` で `workspace:*` を参照する。

```jsonc
// stores/pg/package.json:58-60
"peerDependencies": {
  "@mastra/core": ">=1.4.0-0 <2.0.0-0"
}

// voice/openai/package.json:48-51
"peerDependencies": {
  "@mastra/core": ">=1.0.0-0 <2.0.0-0",
  "zod": "^3.25.0 || ^4.0.0"
}
```

`devDependencies` に `"@mastra/core": "workspace:*"` を設定し、モノレポ内ではローカル参照しつつ、公開時にはユーザーのプロジェクトの `@mastra/core` バージョンに従う設計。

## パターンカタログ

- **Abstract Factory** (分類: 生成)
  - 解決する問題: 23 のストアアダプターに対して統一されたストレージドメインインスタンスを生成する
  - 適用条件: 複数の具体実装が同一のドメインインターフェース群を実装する場合
  - コード例: `stores/pg/src/storage/index.ts:38-48` — `ALL_DOMAINS` 配列で全ドメインクラスを列挙し、`PostgresStore` コンストラクタで一括生成
  - 注意点: ドメインの追加時に ALL_DOMAINS 配列と StorageDomains 型の両方を更新する必要がある

- **Template Method** (分類: 振る舞い)
  - 解決する問題: ストアの初期化フローを統一しつつ、具体的なテーブル作成は各ドメインに委譲する
  - 適用条件: 共通のライフサイクル（init → 各ドメイン init → ready）をすべてのアダプターで統一したい場合
  - コード例: `packages/core/src/storage/base.ts:249-301` — `MastraCompositeStore.init()` が全ドメインの `init()` を並行実行
  - 注意点: 初期化の冪等性を各ドメインが保証する必要がある（`shouldCacheInit` フラグで制御）

- **Composite** (分類: 構造)
  - 解決する問題: 異なるストレージバックエンドのドメインを単一のストレージとして扱う
  - 適用条件: メモリは PostgreSQL、ワークフローは LibSQL など、ドメインごとに異なるバックエンドを使いたい場合
  - コード例: `packages/core/src/storage/base.ts:167-225` — `MastraCompositeStore` が `default` と `domains` オーバーライドを合成

## Good Patterns

- **ワイルドカード + 例外のサブパスエクスポート**: `"./*"` でディレクトリ構造ベースのサブパスを一括定義し、構造に従わないエントリポイントだけ個別定義する。パッケージが成長してもエクスポート定義の保守が最小限で済む。

```jsonc
// packages/core/package.json:13-33
"exports": {
  ".": { /* メイン: 最小限 */ },
  "./*": { /* ワイルドカード: dist/*/index.js にマッピング */ },
  "./tools/is-vercel-tool": { /* 例外: ディレクトリではなくファイル直接 */ }
}
```

- **アンダースコア + `@internal/` による内部パッケージの視覚的区別**: ファイルシステム上（`_config/`, `_test-utils/`）と npm スコープ上（`@internal/lint`）の二重のシグナルで内部パッケージを識別する。開発者がディレクトリ一覧を見たとき、公開パッケージと内部パッケージを即座に区別できる。

```
packages/
├── _config/          # @internal/lint — 内部
├── _types-builder/   # @internal/types-builder — 内部
├── core/             # @mastra/core — 公開
├── memory/           # @mastra/memory — 公開
```

- **共有テストスイートファクトリ**: アダプターパターンを採用する際、ファクトリ関数でテストスイートを生成し、全アダプターに適用する。新しいアダプター追加時のテスト記述が `createTestSuite(new XxxStore(config))` の1行で完了する。

```typescript
// stores/pg/src/storage/index.test.ts:23
createTestSuite(new PostgresStore(TEST_CONFIG));
```

- **`@deprecated` エイリアスによる段階的移行**: クラス・インターフェースのリネーム時に旧名を `@deprecated` エイリアスとして残す。利用者の既存コードを破壊せず、IDE の警告で新名への移行を促す。

## Anti-Patterns / 注意点

- **Barrel file の過剰な `export *` チェーン**: `index.ts` が `export * from './types'` と `export * from './xxx'` を連鎖させすぎると、どのシンボルがどのファイルから来ているか追跡困難になり、名前衝突のリスクが高まる。

```typescript
// Bad: 全ファイルを export * で連鎖
export * from './workflow';
export * from './execution-engine';
export * from './default';
export * from './step';
export * from './types';
export * from './utils';
```

```typescript
// Better: 公開 API を明示的に列挙
export { Workflow, type WorkflowConfig } from './workflow';
export { ExecutionEngine } from './execution-engine';
export type { StepDefinition, StepResult } from './step';
```

mastra 自体では `agent/index.ts` のように名前付きエクスポートと `export *` を混在させており、公開 API の制御度はモジュールごとにばらつきがある。

- **サブパスエクスポートの `_` プレフィックスによる擬似 internal**: `./workflows/_constants` のようにサブパスに `_` プレフィックスを使って「内部用」を表現しているが、実際には誰でもインポートできる。`package.json` の `exports` で公開している以上、セマンティクスと実態が乖離する可能性がある。

```jsonc
// Bad: "_" で内部を示唆しつつ exports で公開
"./workflows/_constants": { "import": { "default": "./dist/workflows/constants.js" } }
```

```jsonc
// Better: 本当に内部なら exports から除外するか、ドキュメントで明示する
// exports に含めないことで、Node.js のモジュール解決でアクセス不可にする
```

## 導出ルール

- `[MUST]` モノレポでパッケージ数が 15 を超える場合、役割・カテゴリ別にトップレベルディレクトリを分割する
  - 根拠: mastra は `stores/`（23）, `voice/`（13）, `auth/`（6）等を `packages/` から分離し、68 以上のパッケージを管理可能にしている

- `[MUST]` アダプターパターンを採用するときは、共有テストスイートファクトリを用意して全アダプターの契約準拠をテストする
  - 根拠: `@internal/storage-test-utils` が `createTestSuite(storage)` で 23 ストアアダプターの動作を統一的に検証している

- `[SHOULD]` 大規模パッケージのメインエントリポイント（`index.ts`）は最小限に保ち、モジュール別のインポートはサブパスエクスポート（`package.json` の `exports` フィールド）で提供する
  - 根拠: `@mastra/core` のメインエントリは `Mastra` と `Config` のみをエクスポートし、`@mastra/core/agent`, `@mastra/core/storage` 等 20 以上のサブパスで機能を公開している

- `[SHOULD]` 内部専用パッケージにはファイルシステム上のアンダースコアプレフィックスと `private: true` + 専用 npm スコープ（例: `@internal/`）を併用する
  - 根拠: mastra は `_config/`→`@internal/lint`, `_test-utils/`→`@internal/storage-test-utils` で視覚的にも npm 的にも内部パッケージを分離している

- `[SHOULD]` 破壊的リネーム時は旧名を `@deprecated` エイリアスとして同一ファイルに残し、段階的移行を支援する
  - 根拠: `MastraStorage extends MastraCompositeStore` のように旧クラスを空の派生クラスとして残し、既存コードの即時破壊を防いでいる

- `[SHOULD]` パッケージ間のバージョン互換性を検証する軽量フィーチャーフラグ（`Set` ベース）を導入する
  - 根拠: `coreFeatures.has('observationalMemory')` により、`@mastra/memory` が `@mastra/core` の未対応バージョンと組み合わされた場合に明確なエラーを出す

- `[AVOID]` `index.ts` で `export *` だけを連鎖させて公開 API を暗黙的にする。名前衝突リスクが高まり、API 境界が曖昧になる
  - 根拠: mastra の `workflows/index.ts` は 6 つの `export *` を連鎖させているが、`agent/index.ts` では名前付きエクスポートで API を明示しており、後者の方が API 境界が明確

- `[AVOID]` コアパッケージに具体的な外部サービスの実装を含める。コアは抽象クラスと型定義に留め、実装はアダプターパッケージに分離する
  - 根拠: `MastraVoice` 抽象クラスは `@mastra/core/voice` に、`OpenAIVoice` 実装は `voice/openai` に配置され、コアの外部依存を最小化している

## 適用チェックリスト

- [ ] モノレポのパッケージ数を確認し、15 を超えていたらカテゴリ別トップレベルディレクトリへの分割を検討する
- [ ] 各パッケージの `index.ts` を確認し、メインエントリのエクスポート数が多すぎないか検証する（目安: 5 シンボル以下）
- [ ] サブパスエクスポート（`package.json` の `exports` フィールド）を活用し、モジュール別インポートを提供しているか確認する
- [ ] 内部専用パッケージに `private: true` が設定されているか、ディレクトリ名で視覚的に区別できるか確認する
- [ ] アダプターパターンを使用している場合、共有テストスイートが存在し全アダプターに適用されているか確認する
- [ ] コアパッケージが抽象インターフェースのみを定義し、具体実装がアダプターパッケージに分離されているか確認する
- [ ] リネームや破壊的変更が発生した場合、`@deprecated` エイリアスを残して段階的移行を支援しているか確認する
- [ ] `export *` の連鎖が3段階以上になっていないか確認し、必要に応じて名前付きエクスポートに切り替える
