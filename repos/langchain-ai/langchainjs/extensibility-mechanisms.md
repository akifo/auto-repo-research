# 拡張性メカニズム (Extensibility Mechanisms)

> リポジトリ: langchain-ai/langchainjs
> 分析日: 2026-02-20

## 概要

LangChain.js は 34 以上のプロバイダーパッケージをサポートする大規模エコシステムを、`@langchain/core` に集約した抽象基底クラス群と `Runnable` プロトコルで成立させている。プロバイダーの追加は「抽象メソッドを実装し、peerDependencies で core に依存する」だけで完結する設計であり、`create-langchain-integration` CLI や `@langchain/standard-tests` が品質の均一化を担う。この設計は「プロバイダー爆発問題」（多数のサードパーティ統合をいかにスケーラブルに管理するか）に対する実践的な解答として注目に値する。

## 背景にある原則

- **Protocol-Oriented Extensibility**: 拡張ポイントを abstract class + interface の組み合わせで定義し、すべてのコンポーネントが `Runnable` プロトコル（`invoke` / `stream` / `batch`）を実装することで、組み合わせ可能性を保証する。具体型ではなくプロトコルに依存させることで、任意のプロバイダーを差し替え可能にしている（`libs/langchain-core/src/runnables/base.ts:124-148`）。

- **Thin Core, Fat Periphery**: コア（`@langchain/core`）は抽象とユーティリティだけを持ち、具体的なAPI呼び出しロジックはすべてプロバイダーパッケージに閉じ込める。これにより、コアの変更がプロバイダーに波及しにくく、プロバイダーの変更がコアに影響しない。`peerDependencies` による疎結合がこの分離を強制している（`libs/providers/langchain-openai/package.json:40-42`）。

- **Convention over Configuration**: `create-langchain-integration` CLI がディレクトリ構成・ビルド設定・テストスケルトンを自動生成し、34 以上のプロバイダーが同一の構造を持つ。これにより、初めて見るプロバイダーでもコードの読み方が同じになり、コントリビューターの認知負荷を下げている。

- **Standardized Quality Gate**: `@langchain/standard-tests` が全プロバイダーに適用される標準テストスイートを提供し、`chatModelHasToolCalling` / `chatModelHasStructuredOutput` といった capability flag でオプショナル機能のテストを制御する。品質保証のコストをエコシステム全体で均一化する仕組み（`internal/standard-tests/src/base.ts:17-36`）。

## 実例と分析

### 抽象基底クラスの階層設計

LangChain.js の拡張性の根幹は、`@langchain/core` に定義された抽象基底クラスの階層にある。主要な拡張ポイントは以下の 5 つ。

| 基底クラス        | 抽象メソッド                                                          | 場所                                                     |
| ----------------- | --------------------------------------------------------------------- | -------------------------------------------------------- |
| `BaseChatModel`   | `_generate()`                                                         | `langchain-core/src/language_models/chat_models.ts:881`  |
| `SimpleChatModel` | `_call()`                                                             | `langchain-core/src/language_models/chat_models.ts:1058` |
| `Embeddings`      | `embedDocuments()`, `embedQuery()`                                    | `langchain-core/src/embeddings.ts:52-60`                 |
| `VectorStore`     | `addVectors()`, `addDocuments()`, `similaritySearchVectorWithScore()` | `langchain-core/src/vectorstores.ts:604-649`             |
| `BaseRetriever`   | `_getRelevantDocuments()`                                             | `langchain-core/src/retrievers/index.ts:126`             |

注目すべきは、`BaseChatModel` と `SimpleChatModel` の二段階抽象。`BaseChatModel` は `_generate()` で `ChatResult` 全体を返す高度なインターフェースを要求するが、`SimpleChatModel` はそれを継承し `_call()` でテキスト文字列だけ返せばよい簡易版を提供する。これにより「最初は簡易版で動かし、後から高度な実装に移行する」段階的拡張が可能になる。

### Runnable プロトコルによる合成可能性

すべての主要コンポーネント（ChatModel, Retriever, Tool など）が `Runnable` を extends することで、`pipe()` による直列合成が型安全に行える。

```typescript
// libs/langchain-core/src/runnables/base.ts:615-623
pipe<NewRunOutput>(
  coerceable: RunnableLike<RunOutput, NewRunOutput>
): Runnable<RunInput, Exclude<NewRunOutput, Error>> {
  return new RunnableSequence({
    first: this,
    last: _coerceToRunnable(coerceable),
  });
}
```

`RunnableLike` 型は `RunnableInterface | Function | RunnableMapLike` のユニオンであり、関数やオブジェクトもチェーンに組み込める柔軟性を持つ（`libs/langchain-core/src/runnables/base.ts:90-99`）。

### プロバイダーパッケージの解剖: Anthropic を例に

Anthropic プロバイダーは `BaseChatModel` を extends し、以下のパターンでプロバイダー固有のロジックを分離している。

**1. コンストラクタでの API キー解決**

```typescript
// libs/providers/langchain-anthropic/src/chat_models.ts:1030-1036
this.anthropicApiKey = fields?.apiKey
  ?? fields?.anthropicApiKey
  ?? getEnvironmentVariable("ANTHROPIC_API_KEY");

if (!this.anthropicApiKey && !fields?.createClient) {
  throw new Error("Anthropic API key not found");
}
```

コアの `getEnvironmentVariable()` ユーティリティ（Node.js / Deno 両対応）を使い、環境変数 -> コンストラクタ引数の優先順位で解決する。

**2. `invocationParams()` パターン**

プロバイダー固有のパラメータ変換を `invocationParams()` メソッドに集約し、`_streamResponseChunks()` と `_generate()` の両方で共用する。

```typescript
// libs/providers/langchain-anthropic/src/chat_models.ts:1150-1152
override invocationParams(
  options?: this["ParsedCallOptions"]
): AnthropicInvocationParams {
```

このメソッドは `_streamResponseChunks()` (L1257)、`_generate()` (L1383)、`getLsParams()` (L1075) のすべてから呼ばれ、パラメータ変換ロジックの重複を防いでいる。

**3. `lc_secrets` による秘匿情報管理**

```typescript
// libs/providers/langchain-anthropic/src/chat_models.ts (inherited pattern)
// cf. libs/providers/langchain-qdrant/src/vectorstores.ts:72-76
get lc_secrets(): { [key: string]: string } {
  return {
    apiKey: "QDRANT_API_KEY",
    url: "QDRANT_URL",
  };
}
```

シリアライズ時に秘匿情報を `SerializedSecret` に変換し、ログやトレースに API キーが漏洩しない仕組み。全プロバイダーで統一的に使われている。

### peerDependencies による疎結合アーキテクチャ

```json
// libs/providers/langchain-openai/package.json:40-42
"peerDependencies": {
  "@langchain/core": "workspace:^"
}
```

プロバイダーパッケージは `@langchain/core` を `peerDependencies` として宣言する。これにより:

- ユーザーアプリケーションで core のバージョンが 1 つに統一される（重複インストール防止）
- 複数のプロバイダーが同一の core インスタンスを共有し、`Runnable` の `pipe()` チェーンが型互換性を保つ
- プロバイダー固有の外部 SDK（`openai`, `@anthropic-ai/sdk`）は `dependencies` に配置する

CONTRIBUTING.md と INTEGRATIONS.md の両方でこの方針が明確にドキュメント化されている。

### Standard Tests フレームワーク

```typescript
// libs/providers/langchain-anthropic/src/tests/chat_models.standard.test.ts:5-14
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
```

プロバイダーは `ChatModelUnitTests` を extends し、capability flag を宣言するだけで標準テスト群が自動実行される。テストクラス自体が Template Method パターンであり、個別のテストメソッド（`testChatModelInit`, `testChatModelWithBindTools` 等）はオーバーライドで挙動を変更できる。

### create-langchain-integration CLI によるスキャフォールディング

```typescript
// libs/create-langchain-integration/template/src/chat_models.ts:33-36
export class ChatIntegration
  extends SimpleChatModel<BaseLanguageModelCallOptions>
  implements ChatIntegrationInput
{
```

CLI が生成するテンプレートは `SimpleChatModel` を基底クラスとし、`_call()`, `_llmType()`, `lc_secrets` の実装箇所をコメント付きで示す。ストリーミング（`_streamResponseChunks`）とツール呼び出し（`bindTools`）はコメントアウトされたスケルトンとして提供され、段階的に有効化できる設計。

## パターンカタログ

- **Template Method** (分類: 振る舞い)
  - 解決する問題: 処理のスケルトンを固定しつつ、具体的なステップをサブクラスに委譲する
  - 適用条件: コア側でコールバック管理・エラーハンドリング・ストリーミング制御を担い、プロバイダー側は API 呼び出しだけを実装する場合
  - コード例: `BaseChatModel._generateUncached()` が `_generate()` を呼ぶ (`chat_models.ts:422-464`)、`BaseRetriever.invoke()` が `_getRelevantDocuments()` を呼ぶ (`retrievers/index.ts:142-173`)
  - 注意点: 基底クラスのフック（`_streamResponseChunks` のデフォルト実装が例外を throw する）は、オーバーライドしなければ機能が無効になるというシグナルとして使われている

- **Strategy** (分類: 振る舞い)
  - 解決する問題: 同じインターフェースで異なるアルゴリズム（プロバイダー）を差し替える
  - 適用条件: ChatModel, Embeddings, VectorStore 等、同一カテゴリに複数プロバイダーが存在する場合
  - コード例: `BaseChatModel` を OpenAI / Anthropic / Google が同一インターフェースで実装
  - 注意点: `CallOptions` のジェネリクスでプロバイダー固有オプションを型安全に拡張可能

- **Abstract Factory** (分類: 生成)
  - 解決する問題: 関連するオブジェクト群（ChatModel + Embeddings + VectorStore）を一貫した方法で生成する
  - 適用条件: `create-langchain-integration` CLI がパッケージ全体を生成するケース
  - コード例: `libs/create-langchain-integration/template/`

## Good Patterns

- **二段階抽象 (Layered Abstraction)**: `BaseChatModel`（高度）と `SimpleChatModel`（簡易）の二段構成により、初心者は `_call()` でテキストを返すだけから始められ、上級者は `_generate()` で `ChatResult` 全体を制御できる。参入障壁を下げつつ拡張性を損なわない設計。
  ```typescript
  // libs/langchain-core/src/language_models/chat_models.ts:1055-1084
  export abstract class SimpleChatModel<...> extends BaseChatModel<...> {
    abstract _call(messages: BaseMessage[], ...): Promise<string>;
    async _generate(messages, options, runManager): Promise<ChatResult> {
      const text = await this._call(messages, options, runManager);
      // text -> ChatResult に自動変換
    }
  }
  ```

- **Capability Flag による機能宣言**: Standard Tests で `chatModelHasToolCalling: true` のようなフラグを宣言することで、オプショナル機能のテストを条件付きで実行する。未実装の機能に対するテストが自動スキップされる。
  ```typescript
  // internal/standard-tests/src/unit_tests/chat_models.ts:100-106
  testChatModelWithBindTools() {
    if (!this.chatModelHasToolCalling) {
      return;
    }
    const chatModel = new this.Cls(this.constructorArgs);
    this.expect(chatModel.bindTools?.([new PersonTool()])).toBeDefined();
  }
  ```

- **`invocationParams()` によるパラメータ変換の一元化**: プロバイダー固有のパラメータ変換ロジックを 1 メソッドに集約し、ストリーミング / 非ストリーミング / メトリクス取得のすべてから参照する。パラメータ変換の重複と不整合を防ぐ。

## Anti-Patterns / 注意点

- **コア基底クラスへの過剰な機能追加**: `BaseChatModel` は `withStructuredOutput()`, `bindTools()`, `getLsParams()` など多数のメソッドを持ち、ファイルは 1000 行を超える。拡張ポイントが増えるたびに基底クラスが肥大化するリスクがある。
  - Bad: 新機能ごとに基底クラスにオプショナルメソッドを追加し続ける
  - Better: Mixin / Trait パターンで機能を分離する（例: `ToolCallingMixin`, `StructuredOutputMixin`）

- **`@langchain/community` への無制限な統合追加**: CONTRIBUTING.md で「新規統合は `@langchain/community` に追加しないでください」と明記されている。かつて `community` パッケージが肥大化し、依存関係が管理不能になった経験から生まれた教訓。
  - Bad: 中央集権的なパッケージにすべての統合を集約する
  - Better: スタンドアロンパッケージとして公開し、`peerDependencies` でコアに依存する

## 導出ルール

- `[MUST]` プラグイン/プロバイダーシステムでは、コア側に抽象基底クラス（またはインターフェース）を定義し、すべてのプロバイダーが同一のプロトコル（invoke / stream / batch 等）を実装すること
  - 根拠: LangChain.js は `Runnable` プロトコルを全コンポーネントに強制することで、34 以上のプロバイダーを `pipe()` で自由に合成可能にしている

- `[MUST]` プラグインパッケージはコアライブラリを `peerDependencies` で参照し、プラグイン固有の外部 SDK は `dependencies` に配置すること
  - 根拠: `@langchain/openai` は `@langchain/core` を peerDependencies、`openai` SDK を dependencies とすることで、複数プロバイダーが同一の core インスタンスを共有しつつ、各自の SDK バージョンを独立管理している

- `[SHOULD]` 拡張ポイントには「簡易版」と「高度版」の二段階抽象を提供し、最小限の実装で動作するエントリポイントを用意すること
  - 根拠: `SimpleChatModel._call()` は文字列を返すだけで ChatModel を作れる簡易 API を提供し、`BaseChatModel._generate()` は完全な `ChatResult` 制御を可能にする二段構成

- `[SHOULD]` プラグインエコシステムでは、標準テストスイートを提供し capability flag でオプショナル機能のテスト実行を制御すること
  - 根拠: `@langchain/standard-tests` は `chatModelHasToolCalling` 等のフラグで機能別テストを条件付き実行し、34 以上のプロバイダーの品質を均一化している

- `[SHOULD]` プロバイダー固有のパラメータ変換は単一メソッド（`invocationParams()` 等）に集約し、ストリーミング・非ストリーミング・メトリクス取得の全経路から共用すること
  - 根拠: Anthropic プロバイダーの `invocationParams()` は `_streamResponseChunks()`, `_generate()`, `getLsParams()` のすべてから呼ばれ、パラメータ変換の重複と不整合を防止している

- `[SHOULD]` API キーなどの秘匿情報は `lc_secrets` のような宣言的マッピングで管理し、シリアライズ/ロギング時に自動的にマスクされる仕組みを用意すること
  - 根拠: 全プロバイダーが `get lc_secrets()` で環境変数名とプロパティ名のマッピングを宣言し、`Serializable` がトレースやログから秘匿情報を除外する

- `[AVOID]` 中央集権的な「コミュニティパッケージ」にすべてのサードパーティ統合を集約すること
  - 根拠: LangChain.js は `@langchain/community` の肥大化を経験し、CONTRIBUTING.md で「新規統合は community に追加しないでください」と明記。スタンドアロンパッケージへの移行を推進している

## 適用チェックリスト

- [ ] プラグイン/プロバイダーが実装すべき抽象メソッドを明確に定義し、最小限の実装で動作する簡易版エントリポイントを用意しているか
- [ ] すべてのプラグインが共通プロトコル（invoke / stream 等）を実装し、互いに差し替え・合成可能か
- [ ] プラグインパッケージがコアを `peerDependencies` で参照し、重複インストールを防止しているか
- [ ] プラグインの品質を担保する標準テストスイートが存在し、capability flag でオプショナル機能のテストを制御しているか
- [ ] 新規プラグイン作成用のスキャフォールディングツール（CLI / テンプレート）が提供されているか
- [ ] プロバイダー固有のパラメータ変換が単一メソッドに集約され、コードパス間で整合性が保たれているか
- [ ] API キーなどの秘匿情報が宣言的に管理され、シリアライズ・ログ出力時に自動マスクされているか
- [ ] 統合追加の方針（中央集権 vs 分散）が明文化され、パッケージの肥大化を防止しているか
