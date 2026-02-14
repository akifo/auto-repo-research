# project-structure

> リポジトリ: mastra-ai/mastra
> 分析日: 2026-02-14

## 概要

Mastra は 90 以上のワークスペースパッケージを持つ大規模 TypeScript モノレポであり、AI フレームワークのコア・ストレージアダプター・音声プロバイダー・認証・デプロイ・オブザーバビリティなど多様な関心領域をディレクトリ単位で分割している。注目すべきは、トップレベルディレクトリが「機能カテゴリ」を表し、各ディレクトリ内のサブパッケージが「プロバイダー実装」を表すという二層構造の一貫性と、`@internal/*` スコープによる非公開パッケージの明確な分離にある。

## 背景にある原則

- **カテゴリ・プロバイダー二層分割**: パッケージが増え続ける大規模モノレポでは、packages/ に全てを並べるとナビゲーションが崩壊する。トップレベルディレクトリで「何のカテゴリか」を表し、その配下で「どの実装か」を表す二層構造にすることで、100 パッケージ超でも O(1) で目的のパッケージにたどり着ける。根拠: `stores/`, `voice/`, `auth/`, `deployers/`, `observability/` 等のトップレベルディレクトリがそれぞれ 4-23 の実装パッケージを格納している（`pnpm-workspace.yaml:5-14`）。

- **抽象はコアに、実装は周辺に**: コアパッケージに抽象クラス（`MastraVector`, `MastraVoice`, `MastraAuthProvider` 等）を配置し、具象実装は別ディレクトリの独立パッケージに分離する。これにより、コアの依存を最小化しつつ、ユーザーは必要なアダプターだけをインストールできる。根拠: `packages/core/src/vector/vector.ts:72` の `abstract class MastraVector` に対し、`stores/pg`, `stores/pinecone` 等 18 の具象実装が存在する。

- **公開/非公開の境界を npm スコープで明示する**: `@mastra/*` は公開パッケージ、`@internal/*` は非公開パッケージという命名規約により、changesets の ignore 設定やビルド対象の制御がパターンマッチで簡潔に行える。根拠: `.changeset/config.json:14-21` で `@internal/*` を ignore し、`@mastra/*` のみをパブリッシュ対象としている。

- **共通テストユーティリティのカテゴリ同居**: テストユーティリティをカテゴリディレクトリ内の `_test-utils/` として配置することで、テスト共通コードが対象カテゴリと近い場所に存在し、発見しやすくなる。根拠: `stores/_test-utils/`, `server-adapters/_test-utils/`, `observability/_test-utils/`, `workspaces/_test-utils/` が各カテゴリ配下に存在する。

## 実例と分析

### ディレクトリ構造の全体像

```
mastra/
├── packages/           # コア + フレームワーク基盤（25パッケージ）
│   ├── core/           # 抽象クラス群 + フレームワーク本体
│   ├── server/         # HTTP サーバー抽象
│   ├── deployer/       # デプロイ抽象
│   ├── auth/           # 認証ユーティリティ
│   ├── _config/        # @internal/lint（ESLint/Prettier 共通設定）
│   ├── _types-builder/ # @internal/types-builder（型生成ツール）
│   ├── _vendored/      # @internal/ai-sdk-v4, v5, v6（バージョン固定の外部型）
│   ├── _external-types/# @internal/external-types
│   └── _changeset-cli/ # @internal/changeset-cli
├── stores/             # ストレージ/ベクターアダプター（23パッケージ）
├── voice/              # 音声プロバイダー（13パッケージ）
├── auth/               # 認証プロバイダー（6パッケージ）
├── deployers/          # デプロイアダプター（4パッケージ）
├── server-adapters/    # サーバーアダプター（4パッケージ + _test-utils）
├── client-sdks/        # クライアント SDK（3パッケージ）
├── observability/      # オブザーバビリティ（12パッケージ + _test-utils + _examples）
├── workflows/          # ワークフローエンジン（1パッケージ）
├── workspaces/         # ワークスペースプロバイダー（3パッケージ + _test-utils）
├── pubsub/             # Pub/Sub プロバイダー（1パッケージ）
├── integrations/       # 外部統合（1パッケージ）
├── e2e-tests/          # E2E テスト群（独立したワークスペース）
├── explorations/       # 実験的コード（一部のみワークスペース登録）
└── examples/           # サンプルプロジェクト（ビルド対象外）
```

### アンダースコアプレフィクスによる非公開パッケージの可視化

非公開パッケージは物理ディレクトリ名にアンダースコアプレフィクス `_` を使用し、ファイルシステム上でソート順が先頭に来る。これにより `ls` や IDE のファイルツリーで内部パッケージが一目で識別できる。

```
packages/
├── _changeset-cli/     # @internal/changeset-cli (private: true)
├── _config/            # @internal/lint (private: true)
├── _external-types/    # @internal/external-types (private: true)
├── _types-builder/     # @internal/types-builder (private: true)
├── _vendored/          # @internal/ai-sdk-v4, v5, v6 (private: true)
├── core/               # @mastra/core (public)
├── server/             # @mastra/server (public)
...
```

同様に、各カテゴリ内の `_test-utils/` も同じ規約に従う:

```
stores/
├── _test-utils/        # @internal/storage-test-utils (private: true)
├── pg/                 # @mastra/pg (public)
├── pinecone/           # @mastra/pinecone (public)
...
```

### pnpm catalog による依存バージョンの一元管理

`pnpm-workspace.yaml` の `catalog:` 機能を使い、テストツール（vitest, @vitest/coverage-v8）と TypeScript のバージョンをモノレポ全体で統一している。各 `package.json` では `"vitest": "catalog:"` と記述するだけで、実際のバージョンは一箇所で管理される。

```yaml
# pnpm-workspace.yaml:23-29
catalog:
  '@microsoft/api-extractor': '^7.56.0'
  '@vitest/coverage-v8': 4.0.12
  '@vitest/ui': 4.0.12
  vitest: 4.0.16
  typescript: ^5.9.3
  zod: ^4.3.6
```

### changesets の fixed / ignore による版管理戦略

`@mastra/core`, `@mastra/server`, `@mastra/deployer`, `@mastra/deployer-cloud` はバージョンが固定同期される（fixed グループ）。`@internal/*` は全て changesets の ignore 対象で、バージョニングやパブリッシュの対象外となる。

```json
// .changeset/config.json:8-21
"fixed": [
  ["@mastra/core", "@mastra/server", "@mastra/deployer", "@mastra/deployer-cloud"],
  ["mastra", "create-mastra", "@internal/playground"]
],
"ignore": [
  "*",
  "@internal/*",
  "!mastra",
  "!create-mastra",
  "!@mastra/*",
  "!@internal/playground"
]
```

### peerDependencies によるコアへの疎結合

全てのアダプターパッケージは `@mastra/core` を `peerDependencies` として宣言し、semver のプレリリースも含む範囲指定 `>=1.0.0-0 <2.0.0-0` を使用する。これにより、アダプターはコアのバージョンに柔軟に追従しつつ、メジャーバージョンの互換性の壁を明示できる。

```json
// stores/pg/package.json:57-58
"peerDependencies": {
  "@mastra/core": ">=1.4.0-0 <2.0.0-0"
}
```

### 中間抽象パッケージのパターン

一部のカテゴリでは、`packages/` 内に抽象ユーティリティパッケージを配置し、カテゴリ配下のプロバイダーがそれを依存する多段構造を採用している。

- `packages/auth` (`@mastra/auth`) --- JWT 検証ユーティリティを提供
- `auth/clerk` (`@mastra/auth-clerk`) --- `@mastra/auth` と `@mastra/core` の両方に依存

```typescript
// auth/clerk/src/index.ts:3-6
import { verifyJwks } from '@mastra/auth';
import type { MastraAuthProviderOptions } from '@mastra/core/server';
import { MastraAuthProvider } from '@mastra/core/server';
```

### 共通ビルド設定と型生成

`@internal/types-builder` が全パッケージ共通の型生成ロジックを提供し、各パッケージの `tsup.config.ts` の `onSuccess` フックで呼び出される。これにより、tsup のビルド後に API Extractor ベースの型生成が統一的に実行される。

```typescript
// stores/pg/tsup.config.ts:1-17
import { generateTypes } from '@internal/types-builder';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  clean: true,
  dts: false,
  splitting: true,
  treeshake: { preset: 'smallest' },
  sourcemap: true,
  onSuccess: async () => {
    await generateTypes(process.cwd());
  },
});
```

### E2E テストの独立性

E2E テストは独自の `pnpm-lock.yaml` を持つ独立したプロジェクトとして構成されるものがある（`e2e-tests/monorepo/`, `e2e-tests/pkg-outputs/`）。これは実際のユーザー環境（`npm install` で依存を解決する環境）を模倣するためで、Verdaccio（ローカル npm レジストリ）を使ってパッケージをパブリッシュ後にインストールするテストを行っている。

## コード例

```typescript
// packages/core/src/vector/vector.ts:72-86
// 抽象クラスが core に定義され、全ストレージアダプターの基底となる
export abstract class MastraVector<Filter = VectorFilter> extends MastraBase {
  id: string;
  constructor({ id }: { id: string }) {
    if (!id || typeof id !== 'string' || id.trim() === '') {
      throw new MastraError({
        id: 'VECTOR_INVALID_ID',
        text: 'Vector id must be provided and cannot be empty',
        domain: ErrorDomain.MASTRA_VECTOR,
        category: ErrorCategory.USER,
      });
    }
    super({ name: 'MastraVector', component: 'VECTOR' });
    this.id = id;
  }
```

```typescript
// stores/pg/src/vector/index.ts:78
// 具象実装はカテゴリディレクトリ配下の独立パッケージ
export class PgVector extends MastraVector<PGVectorFilter> {
```

```typescript
// stores/_test-utils/src/factory.ts:28-29
// カテゴリ共通のテストスイートファクトリ
export function createTestSuite(storage: MastraStorage, capabilities: TestCapabilities = {}) {
  describe(storage.constructor.name, () => {
```

## パターンカタログ

- **Abstract Factory / Adapter** (分類: 構造パターン)
  - 解決する問題: 20 以上のストレージバックエンドを統一インターフェースで扱う
  - 適用条件: 同じ操作（query, upsert, createIndex）を異なるバックエンドに対して実行する必要がある場合
  - コード例: `packages/core/src/vector/vector.ts:72` (抽象), `stores/pg/src/vector/index.ts:78` (具象)
  - 注意点: 抽象クラスの API が肥大化するとアダプター実装の負担が増える。optional メソッドは分離すべき

- **Shared Test Suite (Template Method 変形)** (分類: 振る舞いパターン)
  - 解決する問題: 23 のストレージアダプターに同一のテストを適用する
  - 適用条件: 同一インターフェースの複数実装に対して同じ振る舞いを検証したい場合
  - コード例: `stores/_test-utils/src/factory.ts:28`
  - 注意点: 各実装固有のテストは別途追加が必要。共通テストが肥大化すると CI 時間に影響する

## Good Patterns

- **カテゴリ別トップレベルディレクトリ分割**: `packages/` に全てを詰めるのではなく、`stores/`, `voice/`, `auth/` 等の機能カテゴリでトップレベルを分割している。これにより、パッケージ数が 90 以上でもディレクトリツリーの見通しが良い。新しいカテゴリが必要な場合は `pnpm-workspace.yaml` に 1 行追加するだけで対応できる。

```yaml
# pnpm-workspace.yaml
packages:
  - packages/*
  - stores/*
  - voice/*
  - auth/*
  - deployers/*
```

- **アンダースコアプレフィクスによる内部パッケージの分離**: `_test-utils/`, `_config/`, `_vendored/` のようにアンダースコアで始まるディレクトリ名は、ファイルシステム上でソートが先頭に来り、公開パッケージと視覚的に区別される。npm スコープも `@internal/*` で統一されており、changesets の ignore パターンが `@internal/*` の一行で完結する。

```
stores/
├── _test-utils/    # 先頭にソートされ、非公開であることが一目でわかる
├── astra/
├── chroma/
...
```

- **pnpm catalog によるツールチェーンバージョン統一**: vitest, typescript 等のバージョンを `catalog:` で一元管理し、90 以上のパッケージ間でのバージョンドリフトを防いでいる。

```json
// 任意のパッケージの package.json
"devDependencies": {
  "vitest": "catalog:",
  "typescript": "catalog:"
}
```

- **peerDependencies のプレリリース対応 semver 範囲**: `>=1.0.0-0 <2.0.0-0` という範囲指定により、プレリリースバージョン（`1.4.0-alpha.1` 等）も含めてコアとの互換性を宣言している。通常の `^1.0.0` ではプレリリースが除外されるため、活発な開発中のモノレポではこの書き方が有効。

## Anti-Patterns / 注意点

- **カテゴリの過剰分割**: `workflows/` に 1 パッケージ、`pubsub/` に 1 パッケージ、`integrations/` に 1 パッケージと、トップレベルディレクトリに対してパッケージが極端に少ないケースがある。カテゴリの将来的な拡張が見込まれるなら問題ないが、1-2 パッケージのカテゴリが増え続けるとディレクトリツリーがフラットに広がりすぎる。

```
# Bad: 1パッケージのためだけにトップレベルディレクトリを作成
pubsub/
└── google-cloud-pubsub/

# Better: 成長が見込まれるまでは packages/ 内にフラット配置
packages/
├── pubsub-google-cloud/
```

- **固定バージョングループの暗黙的な結合**: `"fixed": [["@mastra/core", "@mastra/server", "@mastra/deployer", "@mastra/deployer-cloud"]]` により、これらのパッケージは常に同じバージョンに同期される。これはユーザーの理解を助けるが、deployer の小さな修正が core のバージョンバンプを引き起こすリスクがある。

```json
// Bad: 全てを同一バージョングループに
"fixed": [["@mastra/core", "@mastra/server", "@mastra/deployer", ...全パッケージ]]

// Better: 密結合なパッケージのみを fixed に含める
"fixed": [["@mastra/core", "@mastra/server"]]
```

## 導出ルール

- `[MUST]` モノレポでパッケージ数が 20 を超える場合、機能カテゴリ別のトップレベルディレクトリに分割し、`pnpm-workspace.yaml` に `カテゴリ/*` パターンで登録する
  - 根拠: Mastra は `stores/*`, `voice/*`, `auth/*` 等 11 のトップレベルカテゴリで 90 以上のパッケージを管理しており、`packages/` 単一ディレクトリでの管理では破綻する規模である（`pnpm-workspace.yaml:1-22`）

- `[MUST]` 公開パッケージと非公開パッケージは npm スコープで明確に分離し、非公開パッケージには `private: true` を設定する
  - 根拠: `@mastra/*` (公開) と `@internal/*` (非公開) のスコープ分離により、changesets の ignore 設定が `@internal/*` の 1 パターンで完結し、誤パブリッシュを防止している（`.changeset/config.json:14-21`）

- `[SHOULD]` モノレポ全体で共有するツールチェーン（テストランナー、TypeScript、リンター）のバージョンは pnpm catalog 等の一元管理機構で統一する
  - 根拠: 90 以上のパッケージが `"vitest": "catalog:"` で同一バージョンを参照しており、パッケージ間のバージョンドリフトによるテスト挙動の不一致を防止している（`pnpm-workspace.yaml:23-29`）

- `[SHOULD]` アダプターパッケージはコアを `peerDependencies` として宣言し、semver 範囲にプレリリースを含める `>=X.Y.Z-0 <(X+1).0.0-0` 形式を使う
  - 根拠: 全 50 以上のアダプターパッケージが `"@mastra/core": ">=1.0.0-0 <2.0.0-0"` 形式を統一的に使用しており、プレリリース版との互換性テストを可能にしている

- `[SHOULD]` 同一インターフェースの複数実装（アダプター群）にはカテゴリ配下に `_test-utils/` パッケージを配置し、共通テストスイートを提供する
  - 根拠: `stores/_test-utils/` の `createTestSuite()` 関数が 23 のストレージアダプター全てに統一テストを適用しており、インターフェース準拠を自動検証している（`stores/_test-utils/src/factory.ts:28`）

- `[SHOULD]` 非公開パッケージのディレクトリ名にはアンダースコアプレフィクス（`_`）を付与し、ファイルシステム上で公開パッケージと視覚的に区別する
  - 根拠: `_test-utils/`, `_config/`, `_vendored/`, `_changeset-cli/` 等が一貫してアンダースコアプレフィクスを使用している

- `[AVOID]` 抽象クラスとその具象実装を同一パッケージに配置すること。コアパッケージに抽象を、カテゴリ別パッケージに具象を分離することで、ユーザーは必要なアダプターのみをインストールできる
  - 根拠: `packages/core/src/vector/vector.ts` に `abstract class MastraVector` を配置し、18 の具象実装をそれぞれ `stores/` 配下の独立パッケージとして分離している

## 適用チェックリスト

- [ ] モノレポのパッケージ数が 15-20 を超えたら、機能カテゴリ別のトップレベルディレクトリ分割を検討する
- [ ] 公開パッケージと非公開パッケージの npm スコープを分離し、非公開側に `private: true` を設定している
- [ ] 非公開パッケージのディレクトリ名にアンダースコアプレフィクスを付与し、ファイルシステム上で区別できるようにしている
- [ ] pnpm catalog（または同等の機構）でテストランナー・TypeScript 等の共有ツールチェーンバージョンを一元管理している
- [ ] アダプターパッケージの peerDependencies にプレリリース対応の semver 範囲を指定している
- [ ] 同一インターフェースの複数実装に対して共通テストスイートを提供している
- [ ] changesets の fixed/ignore 設定がパッケージスコープのパターンに基づいて簡潔に記述されている
- [ ] E2E テストが実際のユーザーインストール環境を模倣する独立したプロジェクトとして構成されている
