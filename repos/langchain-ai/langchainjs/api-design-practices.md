# API 設計プラクティス

> リポジトリ: langchain-ai/langchainjs
> 分析日: 2026-02-20

## 概要

langchainjs は LLM アプリケーション構築のための TypeScript フレームワークであり、60 以上のプロバイダパッケージが共通の `@langchain/core` 抽象に依存するモノレポ構成を取る。この規模のエコシステムで下位互換性を維持しながら API を進化させる手法には、多くの汎用的プラクティスが含まれる。特に、統一インターフェースによるプロバイダ交換可能性、Symbol ベースの型判定による `instanceof` 回避、Zod v3/v4 デュアルサポートによるメジャーバージョン移行戦略が注目に値する。

## 背景にある原則

- **統一インターフェースによる交換可能性**: すべてのコンポーネントが `Runnable` インターフェース（`invoke`/`stream`/`batch`）を実装することで、プロバイダを差し替え可能にしている。API の表面積を最小限に保ちつつ、組み合わせの自由度を最大化するために、「少数の汎用メソッド」を統一契約として定めるべき。根拠: `RunnableInterface` のコメントに「Should not change on patch releases」と明記されている（`libs/langchain-core/src/runnables/types.ts:21`）。

- **public / protected / internal の三層分離**: 利用者が呼ぶメソッド（`invoke`, `stream`）、サブクラスが実装するメソッド（`_generate`, `_streamResponseChunks`）、内部実装メソッド（`_callWithConfig`, `_concatOutputChunks`）を命名規約で明確に分離している。これにより、内部実装を変更してもパブリック API の下位互換性を壊さない。

- **コア依存の peerDependencies 化**: プロバイダパッケージは `@langchain/core` を `peerDependencies` に置くことで、ユーザーが使用するコアのバージョンを一つに統一させる。これにより、複数のコアバージョンが共存する「ダイヤモンド依存問題」を回避している（`libs/providers/langchain-openai/package.json:40-42`）。

- **段階的非推奨化**: 既存 API を突然削除せず、`@deprecated` アノテーションで移行先を示しながら共存期間を設ける。バージョン番号付きの削除予定（例: `will be removed in 0.4.0`）を明記することで、ユーザーに移行の猶予を与えている。

## 実例と分析

### Runnable 統一インターフェース

`RunnableInterface` は LangChain のすべてのコンポーネントの共通契約である。Chat Model、Tool、Retriever、Chain のいずれも `invoke`/`stream`/`batch` の3メソッドで操作できる。

```typescript
// libs/langchain-core/src/runnables/types.ts:17-63
/**
 * Base interface implemented by all runnables.
 * Used for cross-compatibility between different versions of LangChain core.
 *
 * Should not change on patch releases.
 */
export interface RunnableInterface<RunInput, RunOutput, CallOptions> {
  invoke(input: RunInput, options?: Partial<CallOptions>): Promise<RunOutput>;
  batch(inputs: RunInput[], options?, batchOptions?): Promise<RunOutput[]>;
  stream(input: RunInput, options?): Promise<IterableReadableStreamInterface<RunOutput>>;
  transform(generator: AsyncGenerator<RunInput>, options): AsyncGenerator<RunOutput>;
  getName(suffix?: string): string;
}
```

基底クラス `Runnable` は `stream` と `batch` のデフォルト実装を提供し、サブクラスは `invoke` のみ実装すれば最低限動作する。ストリーミングをサポートする場合は `_streamIterator` をオーバーライドする。

```typescript
// libs/langchain-core/src/runnables/base.ts:297-302
async *_streamIterator(
  input: RunInput,
  options?: Partial<CallOptions>
): AsyncGenerator<RunOutput> {
  yield this.invoke(input, options);  // デフォルトは invoke に委譲
}
```

### 内部メソッド命名規約（アンダースコアプレフィックス）

プロバイダが実装すべきメソッドには `_` プレフィックスを付け、パブリック API と区別する。`BaseChatModel` では利用者が呼ぶ `invoke()` と、プロバイダが実装する `_generate()` / `_streamResponseChunks()` が明確に分離されている。

```typescript
// libs/langchain-core/src/language_models/chat_models.ts:274-296
// パブリック API（利用者が呼ぶ）
async invoke(input: BaseLanguageModelInput, options?): Promise<OutputMessageType> {
  const promptValue = BaseChatModel._convertInputToPromptValue(input);
  const result = await this.generatePrompt([promptValue], options, options?.callbacks);
  return result.generations[0][0].message as OutputMessageType;
}

// サブクラスが実装する（利用者は直接呼ばない）
abstract _generate(
  messages: BaseMessage[],
  options: this["ParsedCallOptions"],
  runManager?: CallbackManagerForLLMRun
): Promise<ChatResult>;

// オプションでオーバーライド（ストリーミング対応時）
async *_streamResponseChunks(...): AsyncGenerator<ChatGenerationChunk> {
  throw new Error("Not implemented.");
}
```

`_streamIterator` はプロトタイプ比較で `_streamResponseChunks` がオーバーライドされているかを検出し、未実装なら `invoke` にフォールバックする:

```typescript
// libs/langchain-core/src/language_models/chat_models.ts:302-308
if (
  this._streamResponseChunks === BaseChatModel.prototype._streamResponseChunks ||
  this.disableStreaming
) {
  yield this.invoke(input, options);
}
```

### Symbol ベースの isInstance パターン（instanceof 回避）

ESLint ルールで `instanceof` を全面禁止し（`no-instanceof/no-instanceof: error`）、代わりに `Symbol.for()` ベースの `isInstance` 静的メソッドを使用する。これはモノレポ内で複数バージョンのパッケージが共存した場合にも正しく動作する。

```typescript
// libs/langchain-core/src/utils/namespace.ts:114-144
export function createNamespace(path: string): Namespace {
  const symbol: symbol = Symbol.for(path);
  return {
    brand<TBase extends Constructor>(Base: TBase, marker?: string) {
      const brandSymbol = marker ? Symbol.for(`${path}.${marker}`) : symbol;
      class _Branded extends (Base as any) {
        readonly [brandSymbol] = true as const;
        static isInstance(obj: unknown): boolean {
          return typeof obj === "object" && obj !== null
            && brandSymbol in obj && obj[brandSymbol] === true;
        }
      }
      return _Branded;
    },
    sub(childPath) {
      return createNamespace(`${path}.${childPath}`);
    },
  };
}
```

使用例として、エラー階層が namespace ベースのブランディングで構築されている:

```typescript
// libs/langchain-core/src/errors/index.ts:48-88
export class LangChainError extends ns.brand(Error) {
  readonly name = "LangChainError";
}
export class ModelAbortError extends ns.brand(LangChainError, "model-abort") {
  readonly name = "ModelAbortError";
}
// LangChainError.isInstance(err) → true（ModelAbortError にも一致）
// ModelAbortError.isInstance(err) → マーカーで絞り込み
```

### Zod v3/v4 デュアルサポート

依存ライブラリのメジャーバージョン移行中、両バージョンを同時にサポートする `InteropZodType` 型を導入し、利用者の移行猶予を確保している:

```typescript
// libs/langchain-core/src/utils/types/zod.ts:49-51
export type InteropZodType<Output = any, Input = Output> =
  | z3.ZodType<Output, z3.ZodTypeDef, Input>
  | z4.$ZodType<Output, Input>;
```

`tool()` ファクトリ関数は Zod v3 用と v4 用のオーバーロードを別々に定義し、型推論を維持している:

```typescript
// libs/langchain-core/src/tools/index.ts:598-648
export function tool<SchemaT extends ZodStringV3, ToolOutputT>(
  func: ..., fields: ToolWrapperParams<SchemaT>
): DynamicTool<ToolOutputT>;

export function tool<SchemaT extends ZodStringV4, ToolOutputT>(
  func: ..., fields: ToolWrapperParams<SchemaT>
): DynamicTool<ToolOutputT>;

export function tool<SchemaT extends ZodObjectV3, ...>(
  func: ..., fields: ...
): DynamicStructuredTool<...>;

export function tool<SchemaT extends ZodObjectV4, ...>(
  func: ..., fields: ...
): DynamicStructuredTool<...>;
```

### サブパスエクスポートによるモジュール境界

`@langchain/core` のルート `index.ts` は `export {}` のみで空。すべての API はサブパスエクスポート（`@langchain/core/runnables`, `@langchain/core/messages` 等）で公開される。これにより、未使用モジュールのバンドルを防ぎ、各サブパスを独立した API 境界として管理できる。

```jsonc
// libs/langchain-core/package.json（exports フィールド、約40エントリ）
{
  "exports": {
    ".": { "input": "./src/index.ts", ... },        // 空
    "./runnables": { "input": "./src/runnables/index.ts", ... },
    "./messages": { "input": "./src/messages/index.ts", ... },
    "./tools": { "input": "./src/tools/index.ts", ... },
    // ...
  }
}
```

### changesets による協調バージョニング

Google 関連パッケージ群は `fixed` グループとして同一バージョンで同時リリースされる。また `onlyUpdatePeerDependentsWhenOutOfRange` により、コアのパッチリリースが全プロバイダの不要なバージョンアップを引き起こさないようにしている。

```json
// .changeset/config.json:10-27
{
  "fixed": [
    [
      "@langchain/google-common",
      "@langchain/google-gauth",
      "@langchain/google-webauth",
      "@langchain/google-vertexai",
      "@langchain/google-vertexai-web",
      "@langchain/google-genai"
    ]
  ],
  "___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH": {
    "onlyUpdatePeerDependentsWhenOutOfRange": true
  }
}
```

## パターンカタログ

- **Template Method** (分類: 振る舞い)
  - 解決する問題: 基底クラスがアルゴリズムの骨格（`invoke` → `_generate` → コールバック処理）を定義し、サブクラスが可変部分のみ実装する
  - 適用条件: 複数プロバイダが共通のライフサイクル（前処理・実行・後処理）を持つ場合
  - コード例: `libs/langchain-core/src/language_models/chat_models.ts:274-296`（`invoke` が `_generate` を呼ぶ）
  - 注意点: オーバーライド可能メソッドが多すぎると、サブクラスの実装コストが増大する

- **Strategy / Plugin** (分類: 振る舞い)
  - 解決する問題: プロバイダ固有のロジックを差し替え可能にする
  - 適用条件: 同一インターフェースで異なる実装を提供する場合
  - コード例: `@langchain/anthropic`、`@langchain/openai` が共に `BaseChatModel` を拡張
  - 注意点: `peerDependencies` でコアバージョンを統一しないとランタイム不整合が発生する

- **Symbol Branding** (分類: 構造 — Marker Interface の変形)
  - 解決する問題: `instanceof` がパッケージ重複時に失敗する問題を `Symbol.for()` のグローバル一意性で回避する
  - 適用条件: モノレポやプラグインアーキテクチャで複数バージョンが共存する環境
  - コード例: `libs/langchain-core/src/utils/namespace.ts:114-160`
  - 注意点: `Symbol.for()` はグローバルスコープで一意なため、パス命名の衝突に注意

## Good Patterns

- **Fluent Builder チェーン（`pipe` / `withRetry` / `withFallbacks`）**: `Runnable` の各メソッドが新しい `Runnable` を返すことで、宣言的にパイプラインを構築できる。メソッドチェーンが可読性を高めつつ、各ステップが独立した Runnable として再利用可能。

```typescript
// pipe で連結し、withRetry / withFallbacks で耐障害性を付与
const chain = prompt
  .pipe(model.withRetry({ stopAfterAttempt: 3 }))
  .pipe(outputParser)
  .withFallbacks([fallbackModel.pipe(outputParser)]);
```

- **Flexible Input Coercion（`BaseMessageLike` 型）**: 入力型を `string | BaseMessage[] | BasePromptValueInterface` の union として定義し、内部で正規化することで、利用者に柔軟な入力形式を許しつつ型安全性を維持している。

```typescript
// libs/langchain-core/src/language_models/base.ts:356-359
export type BaseLanguageModelInput =
  | BasePromptValueInterface
  | string
  | BaseMessageLike[];
```

- **環境変数アクセスの抽象化（`getEnvironmentVariable`）**: `process.env` の直接参照を ESLint で禁止し、Deno/ブラウザ/Node 対応のユーティリティ関数経由でアクセスする。マルチランタイム対応を一箇所に集約。

```typescript
// libs/langchain-core/src/utils/env.ts:78
export function getEnvironmentVariable(name: string): string | undefined {
  try {
    if (typeof process !== "undefined") { /* Node */ }
  } catch { /* Deno/Browser fallback */ }
}
```

## Anti-Patterns / 注意点

- **`instanceof` によるクロスパッケージ型判定**: モノレポやプラグインアーキテクチャでは、同じクラスの複数コピーが存在し得るため `instanceof` が偽陰性を返す。

```typescript
// Bad: パッケージ重複時に false を返す可能性がある
if (error instanceof LangChainError) { ... }

// Better: Symbol ベースで安全に判定
if (LangChainError.isInstance(error)) { ... }
```

- **サブパスを使わない一括インポート**: コアパッケージのルートから全モジュールをインポートすると、バンドルサイズが肥大化し、ツリーシェイキングが効かなくなる。

```typescript
// Bad: ルートインポート（langchainjs では空だが一般論として）
import { AIMessage, Runnable, tool } from "@langchain/core";

// Better: サブパスインポートで必要なモジュールのみ
import { AIMessage } from "@langchain/core/messages";
import { Runnable } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
```

- **依存ライブラリのメジャー移行時に旧版を即座に切り捨てる**: Zod v3 → v4 のような移行で旧版サポートを突然打ち切ると、エコシステム全体が同時に移行を強いられる。

```typescript
// Bad: Zod v4 のみ受け付ける
export function tool<SchemaT extends z4.ZodObject>(...)

// Better: InteropZodType で v3/v4 両方を受け付け、段階的に移行を促す
export type InteropZodType<Output> =
  | z3.ZodType<Output> | z4.$ZodType<Output>;
```

## 導出ルール

- `[MUST]` パブリック API のインターフェースをパッチリリースで変更しない。内部実装の変更はアンダースコアプレフィックス付きメソッドに閉じ込める
  - 根拠: `RunnableInterface` に「Should not change on patch releases」と明記されており、コアとプロバイダの独立リリースを可能にしている（`runnables/types.ts:21`）

- `[MUST]` モノレポのプラグインパッケージはコアパッケージを `peerDependencies` に配置し、ダイヤモンド依存を防止する
  - 根拠: 全プロバイダパッケージが `"@langchain/core": "workspace:^"` を peerDependencies に持ち、ユーザー環境でコアが1つに統一される設計（`langchain-openai/package.json:40-42`）

- `[SHOULD]` クロスパッケージの型判定には `instanceof` ではなく `Symbol.for()` ベースの型ブランディングを使う
  - 根拠: ESLint で `no-instanceof` を error に設定し、`createNamespace` + `brand()` による Symbol ベース判定に統一している（`internal/eslint/src/configs/base.ts:102`）

- `[SHOULD]` 依存ライブラリのメジャーバージョン移行時は Interop 型を導入し、新旧バージョンの共存期間を設ける
  - 根拠: `InteropZodType` が Zod v3/v4 両方を受け付け、`tool()` 関数は各バージョン用のオーバーロードを提供している（`utils/types/zod.ts:49-51`）

- `[SHOULD]` パッケージのルートエクスポートを空にし、すべての API をサブパスエクスポートで公開する
  - 根拠: `@langchain/core/index.ts` は `export {}` のみで、約 40 のサブパスエクスポートが package.json の `exports` で定義されている

- `[SHOULD]` 非推奨 API には `@deprecated` JSDoc と移行先パスを明記し、バージョン番号付きの削除予定を記載する
  - 根拠: `@deprecated Use {@link AIMessage.isInstance} instead` のように移行先を具体的に指定し、`will be removed in 0.4.0` のように期限を示している（`messages/base.ts:673`）

- `[SHOULD]` 関連パッケージ群を changesets の `fixed` グループで同期リリースし、コアのパッチで下流が不要更新されないよう `onlyUpdatePeerDependentsWhenOutOfRange` を設定する
  - 根拠: Google 関連 6 パッケージが `fixed` グループ化されている（`.changeset/config.json:10-18`）

- `[AVOID]` `process.env` の直接参照。マルチランタイム対応のユーティリティ関数を経由する
  - 根拠: ESLint で `no-process-env: error` を設定し、`getEnvironmentVariable()` に集約している（`internal/eslint/src/configs/base.ts:103`）

## 適用チェックリスト

- [ ] パブリック API（利用者が呼ぶメソッド）とサブクラス実装メソッド（`_` プレフィックス）を命名規約で分離しているか
- [ ] プラグイン/プロバイダパッケージがコアを `peerDependencies` に配置しているか
- [ ] クロスパッケージの型判定で `instanceof` を使っていないか。使っている場合、Symbol ベースの代替を検討したか
- [ ] 依存ライブラリのメジャー移行時に Interop 型を用意し、段階的移行パスを提供しているか
- [ ] サブパスエクスポート（package.json の `exports` フィールド）でモジュール境界を管理しているか
- [ ] 非推奨 API に `@deprecated` + 移行先 + 削除予定バージョンを記載しているか
- [ ] 環境変数アクセスが直接 `process.env` ではなく、ランタイム抽象化関数を経由しているか
- [ ] changesets（または同等ツール）で関連パッケージの同期リリースと不要なカスケード更新の抑制を設定しているか
