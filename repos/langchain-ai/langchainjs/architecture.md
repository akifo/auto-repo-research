# architecture

> リポジトリ: langchain-ai/langchainjs
> 分析日: 2026-02-20

## 概要

langchainjs は Runnable 抽象クラスを単一の基盤として、LLM・プロンプト・出力パーサー・リトリーバー・ツールなど異種コンポーネントを統一インターフェースで合成可能にするアーキテクチャを採用している。`invoke()` / `stream()` / `batch()` の3メソッドが全コンポーネントで一貫して使え、`pipe()` による直列合成と `RunnableMap` による並列合成でパイプラインを宣言的に構築できる。core パッケージが抽象層を定義し、34のプロバイダーパッケージが具象実装を提供する三層構造は、大規模フレームワークにおけるプラグイン分離の実用例として注目に値する。

## 背景にある原則

- **統一プロトコルによる合成可能性**: 全コンポーネントが同一の `invoke/stream/batch` プロトコルを実装することで、任意のコンポーネント同士を型安全に接続できる。これは「インターフェースの数を最小化すれば合成の組み合わせが爆発的に増える」という設計判断に基づく（`libs/langchain-core/src/runnables/types.ts:23-63` の `RunnableInterface` が 5 メソッドのみで全体を統御している）。

- **デフォルト実装 + オーバーライドによる段階的最適化**: `Runnable` 基底クラスは `batch()` を `invoke()` の N 回呼び出しで、`stream()` を単一 `invoke()` の yield で実装する。サブクラスは必要に応じてこれらをオーバーライドし、ストリーミングやバッチ処理を最適化できる（`libs/langchain-core/src/runnables/base.ts:243-302`）。これにより最小限の実装で機能する「電池付き」の基底クラスを実現している。

- **コア・プロバイダー分離による依存方向の制御**: `@langchain/core` は外部 SDK に依存せず、各プロバイダー（`@langchain/openai`, `@langchain/anthropic` 等）が core に依存する一方向の依存関係を強制する。これにより、ユーザーは必要なプロバイダーだけをインストールできる（`pnpm-workspace.yaml` で `libs/*` と `libs/providers/*` を分離）。

- **デコレータ的合成による関心の分離**: `withRetry()`, `withFallbacks()`, `withConfig()`, `withStructuredOutput()` といったメソッドは元の Runnable をラップして新しい Runnable を返す。振る舞いの追加を継承ではなく合成で実現し、ランタイムに柔軟に組み替えられる設計を採る（`libs/langchain-core/src/runnables/base.ts:156-205`）。

## 実例と分析

### 継承階層の設計

langchainjs の型階層は明確に 4 層に分かれている。

**Layer 0: Serializable** — シリアライゼーション基盤。`lc_namespace`, `lc_secrets`, `toJSON()` を提供。

**Layer 1: Runnable** — 合成の基盤。`invoke()`, `stream()`, `batch()`, `pipe()`, `transform()` および `with*()` デコレータメソッドを定義。

**Layer 2: BaseLangChain / BaseLanguageModel** — AI コンポーネントの共通基盤。`callbacks`, `tags`, `metadata`, `AsyncCaller`（リトライ＋並行制限）を追加。

**Layer 3: BaseChatModel / BaseRetriever / StructuredTool 等** — ドメイン固有の抽象。`_generate()`, `_getRelevantDocuments()`, `_call()` などのテンプレートメソッドを定義。

**Layer 4: プロバイダー実装** — `ChatOpenAI`, `ChatAnthropic` 等。Layer 3 のテンプレートメソッドを実装し、外部 SDK を呼び出す。

各レイヤーが追加する責務が明確で、下位レイヤーは上位レイヤーの存在を知らない。

### RunnableLike と暗黙的変換

`pipe()` が受け取る `RunnableLike` 型は 3 種類の値を受け付ける。

```typescript
// libs/langchain-core/src/runnables/base.ts:90-99
export type RunnableLike<RunInput, RunOutput, CallOptions> =
  | RunnableInterface<RunInput, RunOutput, CallOptions> // Runnable インスタンス
  | RunnableFunc<RunInput, RunOutput, CallOptions> // 関数
  | RunnableMapLike<RunInput, RunOutput>; // オブジェクト（並列実行）
```

`_coerceToRunnable()` が変換を担い、関数は `RunnableLambda` に、オブジェクトは `RunnableMap` に自動変換される（`base.ts:3063-3095`）。これにより、ユーザーは Runnable クラスを意識せず素の関数やオブジェクトリテラルでパイプラインを構築できる。

### テンプレートメソッドパターンの多段適用

`BaseChatModel` は `invoke()` → `generatePrompt()` → `_generate()` という呼び出しチェーンを持つ。各メソッドが異なる関心を担当する。

- `invoke()`: 入力の正規化（文字列/メッセージ配列/PromptValue → PromptValue）
- `generatePrompt()`: コールバック管理、キャッシュ制御
- `_generate()`: プロバイダーごとの実際の API 呼び出し（**abstract**）

ストリーミングも同様に `_streamIterator()` → `_streamResponseChunks()` の段階を持ち、`_streamResponseChunks()` をオーバーライドしないプロバイダーでは自動的に `invoke()` のシングル yield にフォールバックする（`chat_models.ts:302-308`）。

### デコレータ的合成の実装

`withStructuredOutput()` は `bindTools()` + `RunnableLambda`（出力パーサー）+ `withFallbacks()` を組み合わせて新しい Runnable パイプラインを構成する。

```typescript
// libs/langchain-core/src/language_models/chat_models.ts:1002-1024
const llm = this.bindTools(tools);
const outputParser = RunnableLambda.from<OutputMessageType, RunOutput>(
  (input: BaseMessageChunk): RunOutput => {
    // tool_calls からパース結果を抽出
    const toolCall = input.tool_calls.find((tc) => tc.name === functionName);
    return toolCall.args as RunOutput;
  },
);

if (!includeRaw) {
  return llm.pipe(outputParser).withConfig({
    runName: "StructuredOutput",
  });
}

// includeRaw の場合: RunnablePassthrough.assign + withFallbacks で構成
const parserAssign = RunnablePassthrough.assign({
  parsed: (input, config) => outputParser.invoke(input.raw, config),
});
const parsedWithFallback = parserAssign.withFallbacks({
  fallbacks: [parserNone],
});
```

この実装は「高レベル API を低レベルプリミティブの合成で構築する」原則を体現している。

### RunnableConfig の伝播メカニズム

全 Runnable が受け取る `RunnableConfig` はコールバック・タグ・メタデータ・タイムアウト・シグナルを保持する。`mergeConfigs()` が複数の設定をマージするルールは型ごとに異なる。

```typescript
// libs/langchain-core/src/runnables/config.ts:19-53
export function mergeConfigs<CallOptions extends RunnableConfig>(
  ...configs: (CallOptions | RunnableConfig | undefined | null)[]
): Partial<CallOptions> {
  // metadata → シャローマージ
  // tags → 重複除去の union
  // timeout → 最小値を採用
  // signal → AbortSignal.any() で合成
  // callbacks → 配列は concat、Manager はコピー後に addHandler
}
```

`RunnableSequence.invoke()` では各ステップに `patchConfig()` で子コールバックマネージャーを渡すことで、ネストした実行のトレーシングツリーを自動構築する（`base.ts:1900-1911`）。

### インターフェースベースの鴨型判定

`isRunnableInterface()` は `lc_runnable` プロパティの存在だけで判定する。

```typescript
// libs/langchain-core/src/runnables/utils.ts:5-7
export function isRunnableInterface(thing: any): thing is RunnableInterface {
  return thing ? thing.lc_runnable : false;
}
```

`instanceof` を避けることで、異なるバージョンの `@langchain/core` から来たオブジェクト間の互換性を確保している。`RunnableInterface` のコメントにも「cross-compatibility between different versions」と明記されている（`types.ts:22`）。

## コード例

```typescript
// libs/langchain-core/src/runnables/base.ts:124-148
// Runnable 基底クラス: invoke() のみ abstract、stream/batch はデフォルト実装
export abstract class Runnable<RunInput, RunOutput, CallOptions extends RunnableConfig>
  extends Serializable
  implements RunnableInterface<RunInput, RunOutput, CallOptions>
{
  abstract invoke(
    input: RunInput,
    options?: Partial<CallOptions>
  ): Promise<RunOutput>;

  // デフォルト batch: invoke を N 回呼び出し
  async batch(inputs: RunInput[], ...): Promise<(RunOutput | Error)[]> {
    const batchCalls = inputs.map((input, i) =>
      caller.call(async () => this.invoke(input, configList[i]))
    );
    return Promise.all(batchCalls);
  }

  // デフォルト stream: invoke の結果を1チャンクとして yield
  async *_streamIterator(input: RunInput, options?: Partial<CallOptions>) {
    yield this.invoke(input, options);
  }
}
```

```typescript
// libs/langchain-core/src/runnables/base.ts:615-622
// pipe() メソッド: 任意の RunnableLike を RunnableSequence に変換
pipe<NewRunOutput>(
  coerceable: RunnableLike<RunOutput, NewRunOutput>
): Runnable<RunInput, Exclude<NewRunOutput, Error>> {
  return new RunnableSequence({
    first: this,
    last: _coerceToRunnable(coerceable),
  });
}
```

```typescript
// libs/langchain-core/src/language_models/base.ts:240-273
// BaseLangChain: Runnable を継承し、callbacks/tags/metadata を追加
export abstract class BaseLangChain<RunInput, RunOutput, CallOptions> extends Runnable<RunInput, RunOutput, CallOptions>
  implements BaseLangChainParams
{
  verbose: boolean;
  callbacks?: Callbacks;
  tags?: string[];
  metadata?: Record<string, unknown>;
}
```

```typescript
// libs/providers/langchain-anthropic/src/chat_models.ts:939-947
// プロバイダー実装: BaseChatModel を継承し _generate を実装
export class ChatAnthropicMessages<CallOptions extends ChatAnthropicCallOptions>
  extends BaseChatModel<CallOptions, AIMessageChunk>
  implements AnthropicInput
{
  static lc_name() {
    return "ChatAnthropic";
  }
  // ...
}
```

## パターンカタログ

- **Template Method** (分類: 振る舞い)
  - 解決する問題: プロバイダーごとに異なる API 呼び出しロジックを、共通の実行フロー（コールバック管理・キャッシュ・ストリーミング切り替え）から分離する
  - 適用条件: 基底クラスが実行フローの骨格を持ち、サブクラスがドメイン固有の処理のみを実装する場面
  - コード例: `libs/langchain-core/src/language_models/chat_models.ts:274-287`（`invoke` → `_generate`）、`chat_models.ts:881-885`（abstract `_generate`）
  - 注意点: テンプレートメソッドの段数が深すぎると追跡困難になる。langchainjs では最大 3 段（invoke → generatePrompt → _generate）に抑えている

- **Decorator** (分類: 構造)
  - 解決する問題: リトライ・フォールバック・設定オーバーライドなどの横断的関心事を、元のコンポーネントを変更せず追加する
  - 適用条件: 既存の Runnable に振る舞いを動的に追加したい場面
  - コード例: `libs/langchain-core/src/runnables/base.ts:1260-1340`（`RunnableBinding`）、`base.ts:1649`（`RunnableRetry`）
  - 注意点: デコレータの積み重ねが深くなるとデバッグ時のスタックトレースが長くなる。`getName()` の委譲により表示名は維持される

- **Composite / Chain of Responsibility** (分類: 構造/振る舞い)
  - 解決する問題: 複数の処理ステップを直列・並列に合成し、入力を段階的に変換する
  - 適用条件: プロンプト → LLM → パーサー のようなパイプラインを構築する場面
  - コード例: `libs/langchain-core/src/runnables/base.ts:1847-1930`（`RunnableSequence.invoke`）、`base.ts:2183-2260`（`RunnableMap.invoke`）

- **Strategy** (分類: 振る舞い)
  - 解決する問題: 同一インターフェースに対する複数の実装（OpenAI, Anthropic, Google 等）を実行時に選択する
  - 適用条件: 同じ `BaseChatModel` 契約を異なるプロバイダーで実現する場面
  - コード例: `libs/providers/langchain-openai/src/chat_models/base.ts:243-248`、`libs/providers/langchain-anthropic/src/chat_models.ts:939-944`

## Good Patterns

- **最小 abstract + デフォルト実装**: `Runnable` は `invoke()` のみ abstract にし、`stream()` と `batch()` にはデフォルト実装を提供する。新しいコンポーネントの実装者は 1 メソッドだけ実装すれば全機能が動作し、必要に応じて最適化できる。

```typescript
// libs/langchain-core/src/runnables/base.ts:145-148, 297-302
abstract invoke(input: RunInput, options?: Partial<CallOptions>): Promise<RunOutput>;

// デフォルト stream: invoke の結果を yield するだけ
async *_streamIterator(input: RunInput, options?: Partial<CallOptions>) {
  yield this.invoke(input, options);
}
```

- **暗黙的変換による人間工学の向上**: `_coerceToRunnable()` が関数・オブジェクト・Runnable を統一的に扱えるようにすることで、ユーザーコードの記述量を大幅に削減する。

```typescript
// libs/langchain-core/src/runnables/base.ts:3070-3089
if (typeof coerceable === "function") {
  return new RunnableLambda({ func: coerceable });
} else if (Runnable.isRunnable(coerceable)) {
  return coerceable;
} else if (!Array.isArray(coerceable) && typeof coerceable === "object") {
  // オブジェクトの各値を RunnableMap に変換
  for (const [key, value] of Object.entries(coerceable)) {
    runnables[key] = _coerceToRunnable(value);
  }
  return new RunnableMap({ steps: runnables });
}
```

- **鴨型判定による cross-version 互換**: `instanceof` ではなくプロパティの存在（`lc_runnable`）で型判定することで、npm の異なるバージョンが混在するモノレポ環境でも互換性を保つ。

```typescript
// libs/langchain-core/src/runnables/utils.ts:5-7
export function isRunnableInterface(thing: any): thing is RunnableInterface {
  return thing ? thing.lc_runnable : false;
}
```

## Anti-Patterns / 注意点

- **深いデコレータチェーンによるデバッグ困難**: `withRetry().withFallbacks().withConfig()` のように装飾を重ねると、実行時のスタックトレースが `RunnableBinding` → `RunnableRetry` → `RunnableWithFallbacks` と深くなり、エラー発生箇所の特定が難しくなる。

```typescript
// Bad: 装飾の積み重ねが深すぎる
const chain = model
  .withRetry({ stopAfterAttempt: 3 })
  .withFallbacks([fallbackModel])
  .withConfig({ tags: ["prod"] })
  .pipe(parser)
  .withRetry({ stopAfterAttempt: 2 });

// Better: パイプラインの段階ごとに意味のある単位で名前を付ける
const resilientModel = model
  .withRetry({ stopAfterAttempt: 3 })
  .withFallbacks([fallbackModel]);
const chain = resilientModel
  .pipe(parser)
  .withConfig({ runName: "ExtractAndParse" });
```

- **Embeddings が Runnable を継承していない設計の不一致**: `Embeddings` クラスは `Runnable` を継承せず `AsyncCaller` を直接保持する。パイプラインに組み込む際に `pipe()` が使えないため、`RunnableLambda` でラップする必要がある。

```typescript
// libs/langchain-core/src/embeddings.ts:32-43
// Runnable を継承していない
export abstract class Embeddings<TOutput = number[]> implements EmbeddingsInterface<TOutput> {
  caller: AsyncCaller;
  // invoke/stream/batch なし
}

// Better: パイプラインの一貫性を保つなら Runnable を継承する
// （langchainjs の設計上の選択であり、意図的にシンプルに保っている可能性がある）
```

## 導出ルール

- `[MUST]` フレームワークの基盤となる抽象クラスには、abstract メソッドを最小化し、他のメソッドにはデフォルト実装を提供する — 実装者の負担を最小化しつつ段階的な最適化を可能にするため
  - 根拠: `Runnable` は `invoke()` のみ abstract にし、`stream()`/`batch()` はデフォルト実装を持つ設計で、34のプロバイダーが最小限のコードで全機能を提供できている（`base.ts:145-302`）

- `[MUST]` プラグインシステムではコア（抽象定義）からプラグイン（具象実装）への一方向の依存関係を強制し、コアがプラグインの存在を知らない構造にする
  - 根拠: `@langchain/core` は外部 SDK に依存せず、34のプロバイダーパッケージが core に依存する構造により、ユーザーは必要なプロバイダーのみインストールできる

- `[SHOULD]` 複数バージョンの共存が起こりうるライブラリでは、`instanceof` ではなくプロパティの存在（鴨型判定）で型を判定する
  - 根拠: `isRunnableInterface()` が `lc_runnable` プロパティの存在で判定することにより、モノレポ内で異なるバージョンの core が混在しても互換性を維持している（`utils.ts:5-7`）

- `[SHOULD]` パイプラインの合成 API では、ユーザーが渡す値を暗黙的に内部型へ変換する coerce 関数を用意し、関数・オブジェクトリテラル・型付きインスタンスを統一的に扱えるようにする
  - 根拠: `_coerceToRunnable()` が関数 → `RunnableLambda`、オブジェクト → `RunnableMap` に変換することで、ユーザーは Runnable クラスの詳細を意識せずパイプラインを構築できる（`base.ts:3063-3095`）

- `[SHOULD]` 横断的関心事（リトライ、フォールバック、設定注入等）は継承ではなくデコレータ的合成（ラッパーが同じインターフェースを返す `with*()` メソッド）で追加する
  - 根拠: `withRetry()`, `withFallbacks()`, `withConfig()` がそれぞれ新しい Runnable を返す設計により、振る舞いの追加がランタイムに柔軟に行え、既存コンポーネントを変更しない（`base.ts:156-205`）

- `[SHOULD]` コンポーネント間の設定伝播には、キーごとのマージ戦略を明示的に定義した設定マージ関数を用意する — 特にタイムアウト（最小値）、タグ（union）、メタデータ（シャローマージ）のように型ごとに異なるマージルールがある場合
  - 根拠: `mergeConfigs()` がキーごとに異なるマージ戦略（timeout は最小値、tags は重複除去 union、signal は `AbortSignal.any()`）を定義し、パイプライン全体で一貫した設定伝播を実現している（`config.ts:19-80`）

- `[AVOID]` フレームワークの統一インターフェースから外れるコンポーネントを作ること — パイプライン合成の一貫性が崩れ、ユーザーがアダプタコードを書く必要が生じる
  - 根拠: `Embeddings` が `Runnable` を継承していないため `pipe()` に直接渡せず、パイプライン構築時にラッパーが必要になる（`embeddings.ts:32-43`）

## 適用チェックリスト

- [ ] フレームワークの基盤クラスで abstract メソッドの数を確認し、3つ以下に抑えられているか
- [ ] abstract メソッド以外にデフォルト実装が提供され、実装者が段階的に最適化できるか
- [ ] プラグイン/プロバイダーからコアへの一方向依存が守られているか（コアがプラグインの型を import していないか）
- [ ] バージョン混在が起こりうる箇所で `instanceof` ではなくプロパティベースの型判定を使っているか
- [ ] パイプラインの合成 API が関数やオブジェクトリテラルを受け付ける暗黙的変換を備えているか
- [ ] リトライ・フォールバック等の横断的関心事が継承ではなくデコレータ的合成で実現されているか
- [ ] 設定（config）のマージ戦略がキーごとに明示的に定義されているか
- [ ] コールバック/トレーシングの伝播が自動的に行われ、ユーザーが手動でワイヤリングしなくてよい設計か
