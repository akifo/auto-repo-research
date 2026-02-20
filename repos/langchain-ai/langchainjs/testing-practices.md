# Testing Practices

> リポジトリ: langchain-ai/langchainjs
> 分析日: 2026-02-20

## 概要

langchainjs は 30 以上のパッケージを持つ大規模 monorepo で、テスト戦略を 4 層（unit / integration / standard / type）に分離し、ファイル拡張子ベースの命名規約で自動的にテスト種別を振り分ける仕組みを構築している。特に注目すべきは `@langchain/standard-tests` パッケージで、プロバイダー横断の共通テストスイートをクラス継承ベースで提供し、20 以上のプロバイダーが同じテスト仕様に準拠することを強制している。さらに Docker による環境テスト（ESM/CJS/Edge/Bun 等）と依存関係範囲テストにより、パッケージ互換性を自動検証している。

## 背景にある原則

- **ファイル名規約による暗黙的テスト分類**: テスト種別を設定ファイルではなくファイル拡張子（`.test.ts`, `.int.test.ts`, `.standard.test.ts`, `.test-d.ts`）で示す。これにより vitest の `include`/`exclude` パターンだけで種別ごとの実行が完結し、テストを追加する開発者が設定を変更する必要がない（根拠: `vitest.config.ts` の `mode` 別 include パターン — `libs/providers/langchain-openai/vitest.config.ts`）。

- **抽象テスト基底クラスによるプロバイダー横断品質保証**: インターフェース準拠をテストで強制するために、テストロジック自体を抽象クラスとして切り出す。各プロバイダーはその基底クラスを継承し、コンストラクタ引数のみをカスタマイズする。これにより「あるプロバイダーだけテストが甘い」という事態を構造的に防止する（根拠: `internal/standard-tests/src/unit_tests/chat_models.ts` の `ChatModelUnitTests` 抽象クラス）。

- **テスト種別ごとのキャッシュ・タイムアウト戦略の分離**: 単体テストはキャッシュ可能・短タイムアウト（30秒）、統合テストはキャッシュ不可・長タイムアウト（100秒）と明確に分離する。外部 API を叩くテストのキャッシュは誤った成功を生むため、Turborepo レベルで `cache: false` を設定する（根拠: `turbo.json` の `test:int` タスク設定）。

- **環境ごとの互換性をコンテナで保証する**: ESM/CJS/esbuild/Vite/Cloudflare Workers/Bun 等の環境差異は、単体テストでは検出できない。Docker コンテナで各環境をシミュレートし、エクスポート互換性を CI で検証する（根拠: `environment_tests/docker-compose.yml` の 9 環境定義）。

## 実例と分析

### ファイル拡張子によるテスト種別の自動振り分け

vitest の設定で `mode` パラメータに応じて include パターンを切り替える仕組みが全パッケージに一貫して適用されている。

| 拡張子                   | 種別           | mode                         | タイムアウト | キャッシュ |
| ------------------------ | -------------- | ---------------------------- | ------------ | ---------- |
| `*.test.ts`              | 単体テスト     | (デフォルト)                 | 30秒         | あり       |
| `*.int.test.ts`          | 統合テスト     | `int`                        | 100秒        | なし       |
| `*.standard.test.ts`     | 標準単体テスト | `standard-unit`              | 100秒        | あり       |
| `*.standard.int.test.ts` | 標準統合テスト | `standard-int`               | 100秒        | なし       |
| `*.test-d.ts`            | 型テスト       | (デフォルト, typecheck 有効) | -            | あり       |

デフォルトモードでは `*.int.test.ts` を exclude し、`int` モードではそれだけを include する。この反転パターンにより、開発者は `vitest run` で安全に単体テストだけを実行できる。

### Standard Tests: プロバイダー横断テストスイート

`@langchain/standard-tests` は以下の階層構造で設計されている:

1. **`BaseChatModelsTests`** — テスト対象クラスの型パラメータとコンストラクタ引数を保持する基底クラス
2. **`ChatModelUnitTests`** / **`ChatModelIntegrationTests`** — テストメソッドを定義する抽象クラス（フレームワーク非依存）
3. **Vitest/Jest アダプタ** — `expect` の注入とテストランナーへの登録（`runTests()` メソッド）

各プロバイダーの実装パターンは極めて統一的で、以下の 3 ステップに収まる:

1. アダプタクラスを継承
2. コンストラクタでクラス参照・機能フラグ・引数を渡す
3. 非対応テストをオーバーライドして skip

### テストダブル: FakeChatModel ファミリー

`@langchain/core` の `utils/testing/` に複数の Fake 実装が提供されている:

- **`FakeChatModel`** — 入力メッセージをそのまま返す最小実装
- **`FakeStreamingChatModel`** — チャンク配列を制御可能、ツールバインディングも対応
- **`FakeListChatModel`** — 事前定義の応答リストを順番に返す

これらは `BaseChatModel` を継承し、テスト用途に特化した機能（`thrownErrorString` でエラー注入、`sleep` で遅延シミュレーション等）を持つ。コアの Runnable テスト群で広く使われており、外部 API に依存しないテストを可能にしている。

### 型テスト: vitest の typecheck 機能

`*.test-d.ts` ファイルは `expectTypeOf` を使った型レベルのテストで、実行時の振る舞いではなくコンパイル時の型推論を検証する。`vitest.config.ts` で `typecheck: { enabled: true }` が設定されており、通常のテスト実行と同時に型チェックが走る。

### 依存関係範囲テスト

Docker コンテナ内で依存パッケージの最新版と最低版を個別にインストールし、テストを実行する。`dependency_range_tests/docker-compose.yml` では `langchain-latest-deps` / `langchain-lowest-deps` のペアが定義されている。これにより semver 範囲指定の下限が実際に動作することを保証する。

## コード例

```typescript
// libs/providers/langchain-openai/vitest.config.ts:7-70
// mode パラメータによるテスト種別の振り分け
export default defineConfig((env) => {
  const common: UserConfigExport = {
    test: {
      environment: "node",
      hideSkippedTests: true,
      testTimeout: 30_000,
      maxWorkers: 0.5,
      exclude: ["**/*.int.test.ts", ...configDefaults.exclude],
      setupFiles: ["dotenv/config"],
    },
  };

  if (env.mode === "standard-unit") {
    return {
      test: {
        ...common.test,
        testTimeout: 100_000,
        include: ["**/*.standard.test.ts"],
        name: "standard-unit",
      },
    };
  }
  // ... int, standard-int モードも同様
});
```

```typescript
// libs/providers/langchain-anthropic/src/tests/chat_models.standard.test.ts:1-33
// Standard Test の利用例 — 継承 + コンストラクタ引数だけで完結
import { AIMessageChunk } from "@langchain/core/messages";
import { ChatModelUnitTests } from "@langchain/standard-tests/vitest";
import { ChatAnthropic, ChatAnthropicCallOptions } from "../chat_models.js";

class ChatAnthropicStandardUnitTests extends ChatModelUnitTests<
  ChatAnthropicCallOptions,
  AIMessageChunk
> {
  constructor() {
    super({
      Cls: ChatAnthropic,
      chatModelHasToolCalling: true,
      chatModelHasStructuredOutput: true,
      constructorArgs: {},
    });
    process.env.ANTHROPIC_API_KEY = "test";
  }
}

const testClass = new ChatAnthropicStandardUnitTests();
testClass.runTests("ChatAnthropicStandardUnitTests");
```

```typescript
// libs/providers/langchain-groq/src/tests/chat_models.standard.int.test.ts:31-45
// Standard Integration Test での非対応テストの skip パターン
async testToolMessageHistoriesListContent() {
  this.skipTestMessage(
    "testToolMessageHistoriesListContent",
    "ChatGroq",
    "Complex message types not properly implemented"
  );
}
```

```typescript
// libs/langchain-core/src/tools/tests/types.test-d.ts:8-31
// 型テスト — expectTypeOf による型推論の検証
describe("tool() literal name type inference", () => {
  it("should infer literal name type for DynamicStructuredTool", () => {
    const myTool = tool((_input) => "result", {
      name: "mySpecificTool",
      description: "A tool with a specific name",
      schema: z.object({ query: z.string() }),
    });
    expectTypeOf(myTool.name).toEqualTypeOf<"mySpecificTool">();
  });
});
```

```typescript
// internal/standard-tests/src/unit_tests/vitest.ts:30-49
// runTests() — テストメソッドとテストランナーの橋渡し
runTests(testName = "ChatModelUnitTests") {
  describe(testName, () => {
    test("should initialize chat model successfully", () =>
      this.testChatModelInit());
    test("should initialize chat model with API key", () =>
      this.testChatModelInitApiKey());
    // ...
  });
}
```

## パターンカタログ

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: プロバイダーごとに異なる詳細を持ちつつ、テスト手順は共通にしたい
  - 適用条件: 同一インターフェースの複数実装が存在し、それぞれに同じテストを適用する場合
  - コード例: `internal/standard-tests/src/unit_tests/chat_models.ts` — `ChatModelUnitTests` が各テストメソッドを定義し、サブクラスがコンストラクタ引数で差異を注入
  - 注意点: テストメソッドの override が自由すぎると空の skip になりがち。`skipTestMessage` で理由を明示する規約が必要

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: テストフレームワーク（Jest/Vitest）の差異を吸収する
  - 適用条件: テストロジックは共通だが、アサーションライブラリが異なる環境で動く場合
  - コード例: `internal/standard-tests/src/unit_tests/vitest.ts` と `jest.ts` — `expect` をコンストラクタで注入
  - 注意点: Jest と Vitest の `expect` は API が完全一致ではない。型定義で `typeof JestExpect | typeof VitestExpect` のユニオンにして互換性を確保

## Good Patterns

- **Feature Flag によるテスト自動 skip**: `chatModelHasToolCalling`, `chatModelHasStructuredOutput`, `supportsStandardContentType` 等のフラグをコンストラクタで宣言し、各テストメソッド冒頭で判定する。これにより「テスト一覧は全プロバイダー共通、実行範囲はプロバイダー能力に応じて自動調整」が実現する。

```typescript
// internal/standard-tests/src/integration_tests/chat_models.ts:773-777
async testToolCalling(callOptions?: any) {
  if (!this.chatModelHasToolCalling) {
    console.log("Test requires tool calling. Skipping...");
    return;
  }
  // ... テスト本体
}
```

- **Fake モデルでの段階的忠実度**: `FakeChatModel`（最小）, `FakeListChatModel`（応答制御）, `FakeStreamingChatModel`（チャンク/ツール/エラー注入）と忠実度の異なるダブルを用意し、テストの目的に応じて使い分ける。

```typescript
// libs/langchain-core/src/utils/testing/chat_models.ts:56-99
export class FakeChatModel extends BaseChatModel {
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const text = messages.map((m) => /* ... */).join("\n");
    return { generations: [{ message: new AIMessage(text), text }] };
  }
}
```

- **vitest の mode パラメータで設定ファイルを 1 つに統合**: 種別ごとに設定ファイルを分けるのではなく、`defineConfig((env) => { ... })` のコールバックで `env.mode` を分岐条件にして 1 ファイルで全種別をカバーする。

## Anti-Patterns / 注意点

- **非対応テストの空 override による暗黙的 skip**: 一部のプロバイダーでは `skipTestMessage` を使わず、テストメソッドを空で override して skip している。これではテストが通ったのか skip されたのかが区別できない。

```typescript
// Bad: 空 override — 何が起きたか不明
async testToolCalling() {
  // skip
}

// Better: skipTestMessage で理由を明示
async testToolCalling() {
  this.skipTestMessage(
    "testToolCalling",
    "MyChatModel",
    "Tool calling not yet supported by this provider"
  );
}
```

- **統合テストとキャッシュの組み合わせ**: 外部 API を呼ぶテストに Turborepo キャッシュが効くと、API の変更を検知できない。langchainjs では `turbo.json` で `test:int` に `cache: false` を設定して防止しているが、これを忘れると見逃しが起きる。

```json
// Bad: 統合テストにキャッシュが効く
"test:int": { "dependsOn": ["build:compile"] }

// Better: 明示的にキャッシュを無効化
"test:int": { "dependsOn": ["build:compile"], "cache": false }
```

## 導出ルール

- `[MUST]` テストファイルの種別（unit / integration / type）をファイル拡張子で明示的に区別する（例: `.test.ts` / `.int.test.ts` / `.test-d.ts`）。設定ファイルの exclude/include パターンだけで種別ごとの実行制御が完結し、新規テスト追加時に設定変更が不要になる
  - 根拠: langchainjs 全パッケージの `vitest.config.ts` がこの規約に統一されている

- `[MUST]` 外部サービスに依存するテスト（統合テスト）はビルドツールのキャッシュ対象から除外する。キャッシュが有効だと、API 側の非互換変更を検知できなくなる
  - 根拠: `turbo.json` で `test:int`, `test:integration`, `test:standard:int` すべてに `cache: false` が設定されている

- `[SHOULD]` 同一インターフェースの複数実装をテストする場合、テストロジックを抽象クラスに集約し、各実装はコンストラクタ引数（対象クラス・機能フラグ）だけを差し替える。テストの重複を排除しつつ、全実装に同一基準を適用できる
  - 根拠: `@langchain/standard-tests` の `ChatModelUnitTests` / `ChatModelIntegrationTests` が 20 以上のプロバイダーに同一テストを提供

- `[SHOULD]` テストダブルは忠実度別に複数バリエーションを用意し、テストの目的に応じて使い分ける。最小実装（echo）から高忠実度（ストリーミング・エラー注入・ツール対応）まで段階があると、テストの意図が明確になり実行速度も最適化される
  - 根拠: `FakeChatModel` / `FakeListChatModel` / `FakeStreamingChatModel` の 3 段階の Fake が `@langchain/core` に同居

- `[SHOULD]` 型テストは `expectTypeOf` を使って実行時テストと同じテストランナーで走らせる。型の回帰を CI で自動検知でき、別ツールの導入コストを避けられる
  - 根拠: `libs/langchain-core/vitest.config.ts` で `typecheck: { enabled: true }` が設定され、`.test-d.ts` ファイルが通常テストと同時に実行される

- `[SHOULD]` パッケージのエクスポートが複数の JS ランタイム・バンドラ環境（ESM / CJS / esbuild / Vite / Edge / Bun）で動作することを、Docker コンテナによる隔離テストで検証する。ローカルの Node.js 環境だけでは検出できない互換性問題を CI で自動検出できる
  - 根拠: `environment_tests/docker-compose.yml` の 9 つの環境定義

- `[AVOID]` 非対応テストを空メソッドで override して暗黙的に skip する。テスト結果からは「通った」のか「実行されなかった」のか判別できず、カバレッジの過大報告につながる。理由付きの `skipTestMessage` か、テストフレームワークの `skip` 機能を使う
  - 根拠: 一部プロバイダーの `*.standard.int.test.ts` で空 override と `skipTestMessage` が混在しており、前者は意図が不明

## 適用チェックリスト

- [ ] テストファイルの命名規約が定義されているか（unit / integration / type の拡張子ルール）
- [ ] テストランナーの設定が命名規約と連動して include/exclude を自動切り替えしているか
- [ ] 統合テスト（外部 API 依存）がビルドキャッシュの対象外になっているか
- [ ] 同一インターフェースの複数実装がある場合、共通テストスイートが抽出されているか
- [ ] テストダブル（Fake/Mock）が目的に応じた忠実度で用意されているか
- [ ] 型の回帰テスト（`.test-d.ts` 等）が CI に組み込まれているか
- [ ] 非対応テストの skip に理由が記載されているか（空 override の排除）
- [ ] 複数ランタイム環境（ESM/CJS/Edge 等）でのエクスポート互換性が検証されているか
- [ ] 依存パッケージの semver 範囲の上限・下限が実際にテストされているか
