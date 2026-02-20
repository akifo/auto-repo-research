# project-structure

> リポジトリ: langchain-ai/langchainjs
> 分析日: 2026-02-20

## 概要

langchainjs は 40 以上のパッケージを持つ大規模 TypeScript モノレポであり、pnpm workspaces + Turborepo で管理されている。コアパッケージ (`@langchain/core`) を頂点とした厳格な依存方向の制御、34 個のプロバイダーパッケージの均質な構成、共有ビルドインフラ (`@langchain/build`) による一貫した出力形式が特徴的である。この分析では、パッケージ分割戦略・依存関係管理・共有インフラの設計から汎用的なプラクティスを抽出する。

## 背景にある原則

- **コアの安定性を最優先する**: `@langchain/core` はすべてのパッケージが依存する基盤であり、外部依存を最小限に抑え、循環依存を `dpdm` で静的検査している。コアが不安定だとエコシステム全体が崩壊するため、変更の影響範囲を小さく保つ設計になっている。根拠: `@langchain/core` の `dependencies` はわずか 8 個で、全プロバイダーが `peerDependencies` として参照している (`libs/providers/langchain-openai/package.json:41`)。
- **統合パッケージの独立リリースを可能にする**: 各プロバイダーは独立した npm パッケージとして公開され、個別にバージョニングされる。これにより、特定のプロバイダーの破壊的変更が他のプロバイダーに波及しない。根拠: changesets の設定で Google 系パッケージのみ `fixed` グループとし、それ以外は独立管理 (`.changeset/config.json:10-18`)。
- **共有インフラで品質の床を統一する**: ビルド (`@langchain/build`)、リント (`@langchain/eslint`)、TypeScript 設定 (`@langchain/tsconfig`)、標準テスト (`@langchain/standard-tests`) を内部パッケージとして提供し、全パッケージが同一のルールに従う。新しいプロバイダーを追加しても品質が下がらない仕組みを担保している。根拠: 全プロバイダーの `eslint.config.ts` が `langchainConfig` を 1 行で import するだけで完結する。
- **環境互換性を仕組みで保証する**: Docker ベースの環境テスト (ESM, CJS, esbuild, Vite, Bun, Cloudflare Workers, Vercel 等) と依存バージョン範囲テスト (latest/lowest) により、パッケージの互換性を CI で自動検証している。根拠: `environment_tests/` に 9 種類のランタイム環境テスト、`dependency_range_tests/` に最低・最新バージョンの組み合わせテストが存在する。

## 実例と分析

### 3 層パッケージアーキテクチャ

langchainjs のパッケージは明確な 3 層構造を持つ:

**Layer 1: Core (`libs/langchain-core/`)**
抽象インターフェースと基底クラスを提供する。外部依存は最小限 (zod, uuid, langsmith 等)。全パッケージがこの層に依存する。

**Layer 2: Main + Utilities (`libs/langchain/`, `libs/langchain-textsplitters/`, `libs/langchain-classic/`)**
Core の上に構築されたオーケストレーション層。`langchain` は `@langchain/core` を `peerDependencies` とし、`@langchain/langgraph` を `dependencies` として持つ。

**Layer 3: Providers (`libs/providers/langchain-*/`, `libs/langchain-community/`)**
個別の外部サービスとの統合。各プロバイダーは Core のみに依存し、他のプロバイダーには依存しない (Google ファミリーを除く)。

依存の方向は常に Layer 3 → Layer 2 → Layer 1 で、逆方向の依存は存在しない。

### pnpm overrides による単一バージョン強制

ルートの `package.json` で `@langchain/core` に対して `"workspace:^"` の override を設定し、モノレポ内のすべてのパッケージが同一バージョンの Core を使用することを保証している。

```json
// package.json:56-58
"pnpm": {
  "overrides": {
    "@langchain/core": "workspace:^"
  }
}
```

これにより、異なるバージョンの Core が node_modules に混在して型の不一致やランタイムエラーが発生する問題を防いでいる。

### 共有ビルド設定の抽象化

`@langchain/build` パッケージが `getBuildConfig()` 関数を提供し、全パッケージのビルド設定を統一している。個々のパッケージの `tsdown.config.ts` は最小限の差分のみ記述する。

```typescript
// libs/providers/langchain-openai/tsdown.config.ts:1-10
import { cjsCompatPlugin, getBuildConfig } from "@langchain/build";

export default getBuildConfig({
  entry: ["./src/index.ts"],
  plugins: [
    cjsCompatPlugin({
      files: ["dist/", "CHANGELOG.md", "README.md", "LICENSE"],
    }),
  ],
});
```

`getBuildConfig()` のデフォルト設定 (`internal/build/src/index.ts:53-130`) は以下を含む:

- Dual format (CJS + ESM) 出力
- TypeScript 宣言ファイル生成 (tsgo による並列処理)
- ATTW (Are The Types Wrong) による型互換性チェック
- publint による npm パッケージ品質チェック
- 未使用エクスポートの検出

### ビルドプラグインによる自動生成

4 つのカスタムビルドプラグインが横断的関心事を自動処理する:

1. **`cjsCompatPlugin`**: ESM/CJS 両対応のバレルファイルを自動生成し、`package.json` の `files` フィールドも自動更新する (`internal/build/src/plugins/cjs-compat.ts`)
2. **`lcSecretsPlugin`**: TypeScript AST を走査して `lc_secrets` パターンを収集し、秘密情報のインターフェースを自動生成する (`internal/build/src/plugins/lc-secrets.ts`)
3. **`importMapPlugin`**: エントリーポイントから動的 import 用のマップファイルを自動生成する (`internal/build/src/plugins/import-map.ts`)
4. **`importConstantsPlugin`**: オプショナル依存のエントリーポイント定数を自動生成する (`internal/build/src/plugins/import-constants.ts`)

### Google プロバイダーの階層的分割パターン

同一サービスの認証方式や実行環境が異なる場合、共通ロジックを中間パッケージに抽出する戦略を取っている:

```
@langchain/google-common    ← 共通ロジック (API 変換、型定義)
  └── @langchain/google-gauth  ← Node.js 用認証 (google-auth-library)
       └── @langchain/google-vertexai  ← Vertex AI 統合
  └── @langchain/google-webauth ← ブラウザ用認証
       └── @langchain/google-vertexai-web ← Web 向け Vertex AI
  └── @langchain/google-genai  ← Google GenAI SDK 統合
```

これらは changesets の `fixed` グループで同一バージョンがリリースされる。

### 標準テストスイートによるプロバイダー品質保証

`@langchain/standard-tests` パッケージが抽象テストクラスを提供し、各プロバイダーはこれを継承して標準テストを実行する。テストはランタイム (vitest/jest) に応じたエクスポートを持つ。

```typescript
// libs/providers/langchain-openai/src/chat_models/tests/index.standard.test.ts:1-34
import { AIMessageChunk } from "@langchain/core/messages";
import { ChatModelUnitTests } from "@langchain/standard-tests/vitest";
import { ChatOpenAI, ChatOpenAICallOptions } from "../index.js";

class ChatOpenAIStandardUnitTests extends ChatModelUnitTests<
  ChatOpenAICallOptions,
  AIMessageChunk
> {
  constructor() {
    super({
      Cls: ChatOpenAI,
      chatModelHasToolCalling: true,
      chatModelHasStructuredOutput: true,
      constructorArgs: {},
    });
    process.env.OPENAI_API_KEY = "test";
  }
}

const testClass = new ChatOpenAIStandardUnitTests();
testClass.runTests("ChatOpenAIStandardUnitTests");
```

### テストモードによる実行分離

`vitest.config.ts` で `env.mode` を使ってテストの種類 (unit, int, standard-unit, standard-int) を切り替える:

```typescript
// libs/providers/langchain-openai/vitest.config.ts:7-57
export default defineConfig((env) => {
  const common = { test: { environment: "node", testTimeout: 30_000 } };

  if (env.mode === "standard-unit") {
    return { test: { ...common.test, include: ["**/*.standard.test.ts"] } };
  }
  if (env.mode === "int") {
    return { test: { ...common.test, include: ["**/*.int.test.ts"] } };
  }
  // default: unit tests (exclude *.int.test.ts)
});
```

### community パッケージの optional peerDependencies 戦略

`@langchain/community` は 100 以上の外部ライブラリを `peerDependencies` + `peerDependenciesMeta: { optional: true }` として宣言する。ユーザーは使いたい統合のみをインストールすればよく、不要な依存はインストールされない。

## パターンカタログ

- **Abstract Factory / Template Method** (振る舞い)
  - 解決する問題: 多数のプロバイダーが同一インターフェースを実装する際の品質保証
  - 適用条件: プラグインアーキテクチャで実装者が増え続ける場合
  - コード例: `internal/standard-tests/src/base.ts:38-60` の `BaseChatModelsTests` がテンプレート、各プロバイダーの `*.standard.test.ts` がコンクリート実装
  - 注意点: テストの柔軟性が失われやすいため、テストメソッドを個別にオーバーライド可能にしている

- **Strategy** (振る舞い)
  - 解決する問題: ビルド時の横断的処理を差し替え可能にする
  - 適用条件: 共通ビルドパイプラインにパッケージ固有の処理を挿入したい場合
  - コード例: `getBuildConfig({ plugins: [...] })` でビルドプラグインを注入 (`internal/build/src/index.ts:53`)
  - 注意点: プラグインの実行順序に依存関係がある場合はドキュメント化が必要

## Good Patterns

- **共有設定の 1 行 import パターン**: 各パッケージの `eslint.config.ts` が `import { langchainConfig } from "@langchain/eslint"; export default langchainConfig;` の 1 行で完結する。設定の一元管理と個別パッケージでのオーバーライドを両立しており、パッケージ追加時の設定コストがゼロに近い。

- **peerDependencies + devDependencies の二重宣言パターン**: プロバイダーパッケージは `@langchain/core` を `peerDependencies` (公開 API 契約) と `devDependencies` (開発時解決) の両方で宣言する。これにより、npm 公開時はユーザーが Core のバージョンを選択でき、モノレポ内開発時は `workspace:^` で解決される。
  ```json
  // libs/providers/langchain-openai/package.json:40-48
  "peerDependencies": {
    "@langchain/core": "workspace:^"
  },
  "devDependencies": {
    "@langchain/core": "workspace:^",
  }
  ```

- **ファイル命名規約によるテスト分類**: テストファイルの命名規約 (`*.test.ts`, `*.int.test.ts`, `*.standard.test.ts`, `*.standard.int.test.ts`) だけで vitest の include/exclude パターンによるテスト実行の切り替えを実現している。CI 設定や追加のメタデータが不要で、ファイル名だけで意図が伝わる。

## Anti-Patterns / 注意点

- **テストランナーの混在**: 一部のパッケージは vitest を使用し、一部は jest を使用している (例: `@langchain/community` は jest、`@langchain/openai` は vitest)。これは歴史的経緯だが、テスト設定の二重管理とデバッグの混乱を招く。
  - Bad: パッケージごとに異なるテストランナーの設定が必要
  - Better: 新規パッケージは vitest に統一し、既存パッケージも段階的に移行する (langchainjs は現在この移行中)

- **community パッケージの肥大化**: `@langchain/community` は 100 以上の optional peerDependencies を持つ巨大パッケージになっている。package.json だけで 1000 行を超え、ビルド時間も長い。
  - Bad: すべてのサードパーティ統合を 1 パッケージに集約する
  - Better: 独立したプロバイダーパッケージ (`libs/providers/langchain-*`) として分離する (langchainjs は現在 34 パッケージに分離済みで、community からの移行を進めている)

## 導出ルール

- `[MUST]` モノレポのコア抽象パッケージは外部への依存を最小限にし、循環依存を CI で静的検査する
  - 根拠: langchainjs は `@langchain/core` で `dpdm` による循環依存チェックを lint に組み込み、外部依存を 8 個に抑えている (`libs/langchain-core/package.json:22`)
- `[MUST]` モノレポ内の共有パッケージは pnpm overrides (または npm overrides) で単一バージョンに固定し、重複インスタンスによる型不一致を防ぐ
  - 根拠: `@langchain/core` の override がなければ、プロバイダーごとに異なるバージョンの Core が解決され、`instanceof` チェックの失敗やランタイムエラーが発生する (`package.json:57`)
- `[SHOULD]` モノレポのビルド設定は共有パッケージの関数として提供し、各パッケージは差分のみ記述する
  - 根拠: `getBuildConfig()` により 40 以上のパッケージが統一されたビルド出力を生成し、ATTW・publint チェックも自動適用される (`internal/build/src/index.ts:53-130`)
- `[SHOULD]` プラグインアーキテクチャでは抽象テストスイートを提供し、実装者が継承するだけで最低限の品質を保証する
  - 根拠: `@langchain/standard-tests` の `ChatModelUnitTests` を継承するだけで 8 種類の標準テストが自動実行される (`internal/standard-tests/src/unit_tests/vitest.ts:30-49`)
- `[SHOULD]` テストファイルの命名規約でテスト種別 (unit, integration, standard) を区別し、vitest の mode 機能で実行を切り替える
  - 根拠: `*.int.test.ts`, `*.standard.test.ts` の規約により、追加の設定ファイルなしで `vitest run --mode int` 等で選択的に実行できる (`libs/providers/langchain-openai/vitest.config.ts:19-57`)
- `[SHOULD]` 同一サービスの認証方式やランタイム環境が異なる場合、共通ロジックを中間パッケージに抽出して階層化する
  - 根拠: Google プロバイダーは `google-common` → `google-gauth`/`google-webauth` → `google-vertexai`/`google-vertexai-web` の 3 層に分割し、changesets の fixed グループで同期リリースしている (`.changeset/config.json:10-18`)
- `[AVOID]` 1 つのパッケージに 100 以上の optional peerDependencies を集約する -- インストール時の警告ノイズ、ビルド時間の肥大化、保守コストの集中を招く
  - 根拠: `@langchain/community` の package.json は 1000 行超で、個別プロバイダーパッケージへの分離が進行中

## 適用チェックリスト

- [ ] コアパッケージの外部依存数を確認し、循環依存チェック (dpdm 等) を lint に組み込んでいるか
- [ ] モノレポのルート package.json で共有パッケージの overrides を設定し、バージョン重複を防いでいるか
- [ ] ビルド設定が共有関数として抽象化されており、新規パッケージ追加時のボイラープレートが最小限か
- [ ] ESLint・tsconfig が共有パッケージとして提供され、各パッケージが 1 行で import できるか
- [ ] テストファイルの命名規約が定まっており、テスト種別ごとに選択実行できる仕組みがあるか
- [ ] プラグイン/プロバイダー向けの標準テストスイートがあり、新規実装者が品質基準を自動で満たせるか
- [ ] community 的な巨大パッケージが存在する場合、独立パッケージへの分離計画があるか
- [ ] changesets 等のバージョニングツールで、関連パッケージの同期リリース (fixed) と独立リリースを適切に制御しているか
