# 抽象化パターン

> リポジトリ: langchain-ai/langchainjs
> 分析日: 2026-02-20

## 概要

langchainjs は大規模な TypeScript フレームワークであり、LLM・ツール・リトリーバー・ベクトルストアなど異質なコンポーネントを統一的に扱うために、多層的な抽象化パターンを採用している。特に注目すべきは、(1) `Runnable` を頂点とする統一インターフェース、(2) `_call` / `_generate` といったアンダースコア接頭辞メソッドによる Template Method パターン、(3) `instanceof` を排し Symbol ベースの `isInstance` で型チェックを行う仕組み、(4) `pipe()` による Runnable 合成の 4 点である。これらは「フレームワーク拡張者が最小限のメソッドだけを実装すれば、ストリーミング・バッチ・リトライ・コールバック等の横断的関心事が自動的に統合される」設計を実現している。

## 背景にある原則

- **最小実装面の原則**: フレームワーク拡張者が実装すべきメソッドを 1-2 個（`_generate`, `_call` 等）に限定し、残りの振る舞い（`invoke`, `batch`, `stream`, コールバック管理, リトライ）は基底クラスがデフォルト実装を提供する。これにより新しいプロバイダーの統合コストを最小化する。根拠: `BaseChatModel` では `_generate` のみ abstract で、`invoke`, `batch`, `stream`, `_streamIterator` 等はすべて基底クラスに実装がある（`libs/langchain-core/src/language_models/chat_models.ts:881`, `libs/langchain-core/src/runnables/base.ts:243-302`）。

- **合成による拡張の原則**: 継承ではなく合成（`pipe`, `withRetry`, `withFallbacks`, `withConfig`, `RunnableBinding`）で振る舞いを追加する。`Runnable.pipe()` は新しい `RunnableSequence` を生成し、`withRetry()` は `RunnableBinding` のサブクラス `RunnableRetry` でラップする。これにより既存クラスを変更せず機能を積み重ねられる（`libs/langchain-core/src/runnables/base.ts:615-623`）。

- **instanceof 回避とシンボルブランディング**: バンドラーによるコード重複やモノレポでのバージョン不一致により `instanceof` が信頼できないため、`Symbol.for()` ベースのブランディングと `isInstance` 静的メソッドで型判定を行う。`Symbol.for()` はグローバルシンボルレジストリを使うため、複数のパッケージバージョンが共存しても同一シンボルとして認識される（`libs/langchain-core/src/utils/namespace.ts:114-160`）。

- **Interface + Abstract Class 二重定義**: `RunnableInterface`, `EmbeddingsInterface`, `StructuredToolInterface` など、TypeScript の interface を別途定義し、abstract class がそれを `implements` する。これにより「異なるバージョン間での互換性チェック」をインターフェース側で行いつつ、共通実装は基底クラスに集約する（`libs/langchain-core/src/runnables/types.ts:23`, `libs/langchain-core/src/embeddings.ts:9`）。

## 実例と分析

### 多層継承ヒエラルキーと拡張ポイントの設計

langchainjs の抽象化は以下の階層を持つ:

```
Serializable
  └─ Runnable<I, O>              ... invoke/batch/stream/pipe の統一 API
      └─ BaseLangChain            ... callbacks/tags/metadata 統合
          ├─ BaseLanguageModel    ... LLM 共通（トークンカウント、キャッシュ）
          │   └─ BaseChatModel    ... チャットモデル（_generate が拡張点）
          │       └─ SimpleChatModel ... _call → _generate 変換レイヤー
          ├─ StructuredTool       ... ツール（_call が拡張点）
          └─ BaseRetriever        ... リトリーバー（_getRelevantDocuments が拡張点）
```

各レイヤーは **1 つの abstract メソッド** を追加し、その上のレイヤーの公開 API（`invoke` 等）からそれを呼び出す。これにより拡張者は `_generate` や `_call` だけ実装すればよい。

### Template Method パターンの徹底

基底クラスの `invoke()` が公開 API として「コールバック開始 → `_generate` / `_call` 実行 → コールバック終了」のフレームワークを提供し、サブクラスは `_generate` / `_call` だけをオーバーライドする:

- `BaseChatModel.invoke()` → 内部で `generatePrompt()` → `generate()` → `_generateUncached()` → **`_generate()`** (abstract)
- `StructuredTool.call()` → バリデーション → **`_call()`** (abstract)
- `BaseRetriever.invoke()` → コールバック管理 → **`_getRelevantDocuments()`**

アンダースコア接頭辞 (`_`) は「フレームワーク内部で呼ばれる拡張ポイント」であることを示す命名規約として機能する。

### Symbol ベースの isInstance パターン

`instanceof` を使わず、`Symbol.for()` でグローバルに一意なシンボルをプロトタイプに刻印し、`in` 演算子で検査する:

```typescript
// libs/langchain-core/src/utils/namespace.ts:114-137
export function createNamespace(path: string): Namespace {
  const symbol: symbol = Symbol.for(path);
  return {
    brand<TBase extends Constructor>(Base: TBase, marker?: string) {
      const brandSymbol: symbol = marker
        ? Symbol.for(`${path}.${marker}`)
        : symbol;
      class _Branded extends (Base as any) {
        readonly [brandSymbol] = true as const;
        static isInstance(obj: unknown): boolean {
          return (
            typeof obj === "object" && obj !== null
            && brandSymbol in obj
            && (obj as Record<symbol, unknown>)[brandSymbol] === true
          );
        }
      }
      return _Branded as unknown as BrandedClass<TBase>;
    },
    // ...
  };
}
```

この仕組みは階層的に機能する。`LangChainError.isInstance(err)` は `langchain.error` シンボルを検査し、`ModelAbortError.isInstance(err)` は `langchain.error.model-abort` シンボルを検査する。プロトタイプチェーンを `in` 演算子が辿るため、子クラスのインスタンスは親クラスの `isInstance` にも `true` を返す。

### Runnable 合成のフルーエント API

`Runnable` は `pipe()`, `pick()`, `assign()`, `withRetry()`, `withFallbacks()`, `withConfig()` をメソッドチェーンで使える。`pipe()` は `_coerceToRunnable()` を通じて「関数」「Runnable」「オブジェクト（→ RunnableMap）」を自動変換する:

```typescript
// libs/langchain-core/src/runnables/base.ts:3063-3095
export function _coerceToRunnable<RunInput, RunOutput, CallOptions>(
  coerceable: RunnableLike<RunInput, RunOutput, CallOptions>
): Runnable<RunInput, Exclude<RunOutput, Error>, CallOptions> {
  if (typeof coerceable === "function") {
    return new RunnableLambda({ func: coerceable }) as Runnable<...>;
  } else if (Runnable.isRunnable(coerceable)) {
    return coerceable as Runnable<...>;
  } else if (!Array.isArray(coerceable) && typeof coerceable === "object") {
    const runnables: Record<string, Runnable<RunInput>> = {};
    for (const [key, value] of Object.entries(coerceable)) {
      runnables[key] = _coerceToRunnable(value as RunnableLike);
    }
    return new RunnableMap({ steps: runnables }) as unknown as Runnable<...>;
  }
  // ...
}
```

### tool() ファクトリ関数による段階的抽象化

`tool()` 関数は、スキーマの種類に応じて `DynamicTool`（文字列入力）か `DynamicStructuredTool`（構造化入力）を返す。クラスを直接 `new` する代わりにファクトリ関数を使うことで、利用者はクラス階層を意識せずに済む:

```typescript
// libs/langchain-core/src/tools/index.ts:807-812
const isSimpleStringSchema = isSimpleStringZodSchema(fields.schema);
const isStringJSONSchema = validatesOnlyStrings(fields.schema);
if (!fields.schema || isSimpleStringSchema || isStringJSONSchema) {
  return new DynamicTool<ToolOutputT>({ ... });
}
// ... else DynamicStructuredTool
```

## コード例

```typescript
// libs/langchain-core/src/runnables/base.ts:124-148
// Runnable 基底クラス: invoke のみ abstract、batch/stream にはデフォルト実装
export abstract class Runnable<RunInput, RunOutput, CallOptions>
  extends Serializable
  implements RunnableInterface<RunInput, RunOutput, CallOptions>
{
  abstract invoke(
    input: RunInput,
    options?: Partial<CallOptions>
  ): Promise<RunOutput>;

  // batch のデフォルト実装: invoke を N 回呼ぶ
  async batch(inputs: RunInput[], ...): Promise<(RunOutput | Error)[]> {
    const batchCalls = inputs.map((input, i) =>
      caller.call(async () => this.invoke(input, configList[i]))
    );
    return Promise.all(batchCalls);
  }

  // stream のデフォルト実装: invoke の結果を 1 チャンクとして yield
  async *_streamIterator(input: RunInput, options?: Partial<CallOptions>) {
    yield this.invoke(input, options);
  }
}
```

```typescript
// libs/langchain-core/src/language_models/chat_models.ts:1058-1084
// SimpleChatModel: _call → _generate の変換レイヤー（Template Method の二段構成）
export abstract class SimpleChatModel extends BaseChatModel<CallOptions> {
  abstract _call(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<string>;

  async _generate(messages, options, runManager): Promise<ChatResult> {
    const text = await this._call(messages, options, runManager);
    const message = new AIMessage(text);
    return { generations: [{ text: message.content, message }] };
  }
}
```

```typescript
// libs/langchain-core/src/errors/index.ts:28-57
// Symbol ブランディングによるエラー階層
export const ns = baseNs.sub("error");

export class LangChainError extends ns.brand(Error) {
  readonly name: string = "LangChainError";
}

export class ModelAbortError extends ns.brand(LangChainError, "model-abort") {
  readonly name = "ModelAbortError";
  readonly partialOutput?: AIMessageChunk;
}

export class ContextOverflowError extends ns.brand(
  LangChainError,
  "context-overflow",
) {
  readonly name = "ContextOverflowError";
}
```

```typescript
// libs/langchain-core/src/runnables/base.ts:615-623
// pipe() メソッド: Runnable 合成
pipe<NewRunOutput>(
  coerceable: RunnableLike<RunOutput, NewRunOutput>
): Runnable<RunInput, Exclude<NewRunOutput, Error>> {
  return new RunnableSequence({
    first: this,
    last: _coerceToRunnable(coerceable),
  });
}
```

## パターンカタログ

- **Template Method** (分類: 振る舞い)
  - 解決する問題: フレームワーク拡張者が横断的関心事（コールバック、エラーハンドリング、ログ）を意識せずに実装できるようにする
  - 適用条件: 処理の前後に共通のフレームワーク処理が必要で、中核ロジックだけが可変な場合
  - コード例: `libs/langchain-core/src/language_models/chat_models.ts:881` (`_generate`), `libs/langchain-core/src/tools/index.ts:158` (`_call`)
  - 注意点: アンダースコア接頭辞で「直接呼ぶな」を示す命名規約に依存。TypeScript の `protected` とも併用

- **Decorator / Wrapper** (分類: 構造)
  - 解決する問題: 既存の Runnable にリトライ・フォールバック・設定バインド等を非破壊的に追加する
  - 適用条件: 既存コンポーネントの振る舞いを変更せず機能を追加したい場合
  - コード例: `libs/langchain-core/src/runnables/base.ts:1260` (`RunnableBinding`), `libs/langchain-core/src/runnables/base.ts:1649` (`RunnableRetry`)
  - 注意点: `RunnableRetry` は `RunnableBinding` を継承しており、Decorator の入れ子が可能

- **Composite / Chain of Responsibility** (分類: 構造)
  - 解決する問題: 複数の Runnable を直列・並列に合成して 1 つの Runnable として扱う
  - 適用条件: 処理パイプラインを部品から組み立てたい場合
  - コード例: `libs/langchain-core/src/runnables/base.ts:1847` (`RunnableSequence`), `libs/langchain-core/src/runnables/base.ts:2183` (`RunnableMap`)
  - 注意点: `pipe()` が `_coerceToRunnable()` で自動変換するため、関数やオブジェクトもそのまま渡せる

- **Factory Method** (分類: 生成)
  - 解決する問題: 利用者がクラス階層を意識せずに適切な具象クラスを取得する
  - 適用条件: 入力の型に応じて異なるクラスを生成する必要がある場合
  - コード例: `libs/langchain-core/src/tools/index.ts:807` (`tool()` 関数)
  - 注意点: オーバーロードを多用してスキーマ型ごとの戻り値型を精密に推論させている

- **Type-Safe Brand / Phantom Type** (分類: 構造)
  - 解決する問題: `instanceof` が信頼できない環境での安全な型判定
  - 適用条件: モノレポ・バンドラー・複数パッケージバージョンが共存する環境
  - コード例: `libs/langchain-core/src/utils/namespace.ts:114-160`
  - 注意点: `Symbol.for()` はプロセスグローバルなので、名前衝突を避けるためにネームスペースを階層化している

## Good Patterns

- **アンダースコア接頭辞による拡張ポイントの明示**: `_generate`, `_call`, `_getRelevantDocuments`, `_streamResponseChunks` といったメソッドは「サブクラスがオーバーライドすべき拡張ポイント」であることを命名で明示する。公開 API（`invoke`, `call`, `stream`）との区別が一目で分かり、フレームワーク利用者とフレームワーク拡張者の認知負荷を分離する。

```typescript
// libs/langchain-core/src/language_models/chat_models.ts:881-885
abstract _generate(
  messages: BaseMessage[],
  options: this["ParsedCallOptions"],
  runManager?: CallbackManagerForLLMRun
): Promise<ChatResult>;
```

- **デフォルト実装付き段階的最適化**: `batch` は `invoke` を N 回呼ぶデフォルト実装を持ち、`_streamIterator` は `invoke` の結果を 1 チャンクとして yield する。サブクラスはパフォーマンスが必要な場合にだけオーバーライドすればよい。「まず動く、次に速く」を構造的に保証する。

```typescript
// libs/langchain-core/src/runnables/base.ts:297-302
async *_streamIterator(input: RunInput, options?: Partial<CallOptions>) {
  yield this.invoke(input, options);
}
```

- **Interface と Abstract Class の分離**: `EmbeddingsInterface` を interface で定義し、`Embeddings` abstract class がそれを `implements` する。異なるパッケージバージョン間の互換性を interface 側で型チェックし、共通実装（`AsyncCaller` の初期化等）は abstract class に集約する。

```typescript
// libs/langchain-core/src/embeddings.ts:9-26
export interface EmbeddingsInterface<TOutput = number[]> {
  embedDocuments(documents: string[]): Promise<TOutput[]>;
  embedQuery(document: string): Promise<TOutput>;
}

export abstract class Embeddings<TOutput = number[]> implements EmbeddingsInterface<TOutput> {
  caller: AsyncCaller;
  constructor(params: EmbeddingsParams) {
    this.caller = new AsyncCaller(params ?? {});
  }
  abstract embedDocuments(documents: string[]): Promise<TOutput[]>;
  abstract embedQuery(document: string): Promise<TOutput>;
}
```

## Anti-Patterns / 注意点

- **`instanceof` による型チェック**: langchainjs はコードベース全体で ESLint ルール `no-instanceof/no-instanceof` を使い `instanceof` を禁止している（23 箇所の ESLint コメントで確認）。バンドラーが同じクラスを複数回バンドルした場合やモノレポで異なるバージョンが共存した場合、`instanceof` は false negative を返す。

```typescript
// Bad: バンドラーや複数バージョンで壊れる
if (error instanceof LangChainError) { ... }

// Better: Symbol ベースの isInstance を使う
if (LangChainError.isInstance(error)) { ... }
```

- **公開 API メソッドの直接オーバーライド**: `invoke()` を直接オーバーライドするとコールバック管理やトレーシングが失われる。拡張者は `_generate` / `_call` 等のアンダースコア付きメソッドだけをオーバーライドすべき。

```typescript
// Bad: コールバック統合が壊れる
class MyModel extends BaseChatModel {
  async invoke(input, options) {
    return myCustomLogic(input); // コールバックが呼ばれない
  }
}

// Better: 拡張ポイントを使う
class MyModel extends BaseChatModel {
  async _generate(messages, options, runManager) {
    return myCustomLogic(messages); // 基底クラスがコールバックを管理
  }
}
```

- **深い継承チェーンの濫用**: langchainjs 自体が `Serializable → Runnable → BaseLangChain → BaseLanguageModel → BaseChatModel → SimpleChatModel` と 6 階層に及ぶ。各層に明確な責務があるため成立しているが、安易に継承を重ねると「どのメソッドをオーバーライドすべきか」が不明瞭になる。階層は 3-4 層を上限とし、それ以上は合成（Decorator パターン）を検討すべき。

## 導出ルール

- `[MUST]` フレームワークの拡張ポイントとなるメソッドは公開 API と命名規約で区別する（例: `invoke` が公開、`_generate` が拡張点）
  - 根拠: langchainjs は `_` 接頭辞 + `protected` / `abstract` でフレームワーク利用者と拡張者のインターフェースを分離し、拡張者が誤って横断的関心事を壊すことを防いでいる（`chat_models.ts:881`, `tools/index.ts:158`）

- `[MUST]` モノレポやバンドラー環境で型判定が必要な場合、`instanceof` ではなく Symbol ベースの判定メカニズムを使う
  - 根拠: langchainjs はコードベース全体で `no-instanceof` ESLint ルールを適用し、`Symbol.for()` ベースの `isInstance` で安全な型チェックを実現している（`namespace.ts:114-160`）

- `[SHOULD]` 基底クラスの抽象メソッドは「最小限の 1-2 個」に留め、残りの振る舞いにはデフォルト実装を提供する
  - 根拠: `Runnable` は `invoke` のみ abstract で、`batch` / `stream` / `pipe` はデフォルト実装を持つ。これにより新しいプロバイダーの統合が `_generate` 1 メソッドの実装だけで済む（`base.ts:243-302`）

- `[SHOULD]` 既存コンポーネントへの機能追加は継承ではなく Decorator（ラッパー）パターンで行い、合成可能にする
  - 根拠: `withRetry()`, `withFallbacks()`, `withConfig()` はすべて新しい `RunnableBinding` を返し、元の Runnable を変更しない。これにより機能の積み重ねが自由にできる（`base.ts:156-205`）

- `[SHOULD]` クラス階層とは別に interface を定義し、abstract class がそれを `implements` する構造にする
  - 根拠: `RunnableInterface`, `EmbeddingsInterface`, `StructuredToolInterface` が interface として独立しており、パッケージバージョン間の互換性チェックに利用されている（`types.ts:23`, `embeddings.ts:9`）

- `[SHOULD]` ファクトリ関数を提供して利用者がクラス階層を意識せずに済むようにする
  - 根拠: `tool()` 関数はスキーマ型に応じて `DynamicTool` / `DynamicStructuredTool` を自動選択し、利用者はクラス名すら知らなくてよい（`tools/index.ts:807`）

- `[AVOID]` 継承階層を 4 層以上に深くすること。各層に明確な責務（シリアライズ、統一 API、コールバック統合、ドメイン固有ロジック）がない場合は合成に切り替える
  - 根拠: langchainjs は 6 層の継承を持つが、各層に `Serializable`（永続化）→ `Runnable`（統一 API）→ `BaseLangChain`（コールバック）→ `BaseLanguageModel`（トークン管理）→ `BaseChatModel`（チャット固有）という明確な責務があるため成立している

## 適用チェックリスト

- [ ] フレームワーク拡張ポイントとなるメソッドに一貫した命名規約（`_` 接頭辞等）を適用しているか
- [ ] 公開 API メソッド内でコールバック・ログ・エラーハンドリング等の横断的関心事を処理し、拡張ポイントはビジネスロジックのみに集中しているか
- [ ] `instanceof` に頼らない型判定メカニズム（Symbol ブランディング、duck typing 等）を検討したか
- [ ] 基底クラスの abstract メソッドが最小限（理想は 1-2 個）になっているか
- [ ] `batch` / `stream` 等のバリエーションにデフォルト実装を提供しているか
- [ ] 機能追加を継承ではなく合成（Decorator / Wrapper）で実現できないか検討したか
- [ ] interface と abstract class を分離し、互換性チェックと共通実装を分担しているか
- [ ] クラス階層の各層に明確な単一責務があるか（ない層があれば合成に置き換える）
- [ ] ファクトリ関数で利用者からクラス階層の複雑さを隠蔽しているか
