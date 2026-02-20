# Type System Patterns

> リポジトリ: langchain-ai/langchainjs
> 分析日: 2026-02-20

## 概要

langchainjs は TypeScript の型システムを高度に活用し、Runnable パイプライン・ツール定義・LLM プロバイダを型安全に構成するフレームワークである。特に注目に値するのは、(1) Zod v3/v4 のデュアルバージョンサポートを型レベルで統一する Interop 型の体系、(2) `Runnable<RunInput, RunOutput, CallOptions>` の3パラメータジェネリクスによるパイプライン型推論、(3) スキーマから実行時型を自動導出する条件型の多段活用、(4) `declare` フィールドと `this["T"]` による polymorphic this パターンの4点である。

## 背景にある原則

- **Union型による入力の柔軟性、ジェネリクスによる出力の型安全性**: `RunnableLike` は関数・Runnable インスタンス・オブジェクトマップの Union 型で入力を柔軟に受け付ける一方、`pipe()` の戻り値は `Runnable<RunInput, Exclude<NewRunOutput, Error>>` として型安全を保つ。利便性と安全性を入力/出力で分離する設計原則。(`libs/langchain-core/src/runnables/base.ts:90-99`, `:615-617`)

- **型の分岐はランタイム分岐と1:1対応させる**: `InteropZodType` が Zod v3/v4 の Union 型であるのと同様に、ランタイムの `isZodSchemaV3()` / `isZodSchemaV4()` 型ガードが対になっている。条件型とランタイム分岐を同じ構造にすることで、型の正しさがコードの正しさを保証する。(`libs/langchain-core/src/utils/types/zod.ts:49-51`, `:109-161`)

- **オーバーロードで型推論の精度を最大化する**: `tool()` 関数は12個以上のオーバーロードシグネチャを持ち、`ZodStringV3` / `ZodStringV4` / `ZodObjectV3` / `ZodObjectV4` / `JSONSchema` ごとに異なる戻り値型を返す。実装シグネチャは緩いが、呼び出し側では常に最も具体的な型が推論される。(`libs/langchain-core/src/tools/index.ts:598-807`)

- **型パラメータのデフォルト値で段階的型付けを実現する**: `Runnable<RunInput = any, RunOutput = any, CallOptions extends RunnableConfig = RunnableConfig>` のように全パラメータにデフォルト値を設定し、型パラメータを省略した既存コードとの後方互換性を維持しつつ、指定すれば型安全になる段階的型付けを実現している。(`libs/langchain-core/src/runnables/base.ts:124-130`)

## 実例と分析

### Interop 型: Zod v3/v4 のデュアルバージョンサポート

langchainjs は Zod v3 と v4 を同時にサポートする必要がある。これを型レベルで Union 型 `InteropZodType` として統一し、ランタイムでは型ガード関数群 (`isZodSchemaV3`, `isZodSchemaV4`) で分岐する二層構造をとっている。

型推論も `InferInteropZodOutput<T>` / `InferInteropZodInput<T>` の条件型で v3/v4 両方に対応し、オブジェクトの shape 取得は `InteropZodObjectShape<T>` がネストした条件型で4つのバリアント（v3, v4 core, v4 classic, zod main）を網羅する。

この Interop パターンは「異なるバージョンのライブラリを同時にサポートする」という汎用課題への型レベルの解法であり、v3→v4 マイグレーションを段階的に進められる設計を実現している。

### `this["ParsedCallOptions"]` パターン: Polymorphic This 型

`BaseChatModel` は `declare ParsedCallOptions` フィールドを持ち、サブクラスで `this["ParsedCallOptions"]` として参照される。`declare` は JavaScript にコンパイルされないため、型情報のみのフィールドとして機能する。

このパターンにより、サブクラスが `CallOptions` ジェネリクスを拡張すると、`ParsedCallOptions` も自動的に追従する。`Omit` と `Exclude` を組み合わせてランタイムコンフィグのキーをフィルタリングしつつ、`signal` / `timeout` / `maxConcurrency` だけは保持するという精密な型操作が `declare` + `this["T"]` で実現されている。

### ToolReturnType: 多段条件型による戻り値の精密な型付け

`ToolReturnType<TInput, TConfig, TOutput>` は5段の条件型で、入力とコンフィグの組み合わせに応じてツールの戻り値型を正確に決定する。`DirectToolOutput` が返される場合、`ToolCall` が入力される場合、`toolCall.id` の有無による場合分けなど、ランタイムの振る舞いを型レベルで忠実に表現している。

### tool() ファクトリ: オーバーロードの戦略的活用

`tool()` 関数は入力スキーマの型に応じて `DynamicTool` または `DynamicStructuredTool` を返し分ける。12以上のオーバーロードが存在する理由は、(1) Zod v3/v4 のバージョン分岐、(2) String/Object/JSONSchema のスキーマ種別分岐、(3) ToolRuntime の有無による分岐、という3軸の組み合わせである。さらに `NameT extends string` をキャプチャすることでリテラル型のツール名を保持し、discriminated union が可能になる。

### pipe() と RunnableSequence: パイプライン型推論

`pipe<NewRunOutput>(coerceable: RunnableLike<RunOutput, NewRunOutput>): Runnable<RunInput, Exclude<NewRunOutput, Error>>` は、前段の `RunOutput` を次段の入力に接続し、エラー型を `Exclude` で除外する。`RunnableSequence` の `first` / `middle` / `last` 構造は、first に `RunInput`、last に `RunOutput` のみを型パラメータとして保持し、middle は `Runnable[]` (any) に緩和している。端点の型安全性を保ちつつ、中間ステップの型爆発を回避する実用的なトレードオフである。

## コード例

```typescript
// libs/langchain-core/src/utils/types/zod.ts:49-51
// Interop Union 型: Zod v3 と v4 を統一する型
export type InteropZodType<Output = any, Input = Output> =
  | z3.ZodType<Output, z3.ZodTypeDef, Input>
  | z4.$ZodType<Output, Input>;
```

```typescript
// libs/langchain-core/src/utils/types/zod.ts:87-103
// 条件型による Zod v3/v4 両対応の型推論
export type InferInteropZodInput<T> = T extends z3.ZodType<unknown, z3.ZodTypeDef, infer Input> ? Input
  : T extends z4.$ZodType<unknown, infer Input> ? Input
  : T extends { _zod: { input: infer Input; }; } ? Input
  : never;

export type InferInteropZodOutput<T> = T extends z3.ZodType<infer Output, z3.ZodTypeDef, unknown> ? Output
  : T extends z4.$ZodType<infer Output, unknown> ? Output
  : T extends { _zod: { output: infer Output; }; } ? Output
  : never;
```

```typescript
// libs/langchain-core/src/tools/types.ts:44-55
// 多段条件型: 入力とコンフィグに応じた戻り値型の精密な決定
export type ToolReturnType<TInput, TConfig, TOutput> = TOutput extends DirectToolOutput ? TOutput
  : TConfig extends { toolCall: { id: string; }; } ? ToolMessage
  : TConfig extends { toolCall: { id: undefined; }; } ? TOutput
  : TConfig extends { toolCall: { id?: string; }; } ? TOutput | ToolMessage
  : TInput extends ToolCall ? ToolMessage
  : TOutput;
```

```typescript
// libs/langchain-core/src/language_models/chat_models.ts:207-216
// declare + this["T"] パターン: ランタイムに影響しない型フィールド
export abstract class BaseChatModel<
  CallOptions extends BaseChatModelCallOptions = BaseChatModelCallOptions,
  OutputMessageType extends BaseMessageChunk = AIMessageChunk,
> extends BaseLanguageModel<OutputMessageType, CallOptions> {
  declare ParsedCallOptions: Omit<
    CallOptions,
    Exclude<keyof RunnableConfig, "signal" | "timeout" | "maxConcurrency">
  >;
```

```typescript
// libs/langchain-core/src/runnables/base.ts:615-623
// pipe() のジェネリクス: 前段の出力を次段の入力に接続、Error を Exclude
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
// libs/langchain-core/src/tools/index.ts:616-631
// tool() オーバーロード: スキーマの型に応じてリテラルなツール名を保持
export function tool<
  SchemaT extends ZodObjectV3,
  NameT extends string,
  SchemaOutputT = InferInteropZodOutput<SchemaT>,
  SchemaInputT = InferInteropZodInput<SchemaT>,
  ToolOutputT = ToolOutputType,
>(
  func: RunnableFunc<SchemaOutputT, ToolOutputT, ToolRunnableConfig>,
  fields: ToolWrapperParams<SchemaT, NameT>,
): DynamicStructuredTool<
  SchemaT,
  SchemaOutputT,
  SchemaInputT,
  ToolOutputT,
  NameT
>;
```

```typescript
// libs/langchain-core/src/tools/tests/types.test-d.ts:9-19
// 型テスト: expectTypeOf によるリテラル型の検証
it("should infer literal name type for DynamicStructuredTool", () => {
  const myTool = tool((_input) => "result", {
    name: "mySpecificTool",
    description: "A tool with a specific name",
    schema: z.object({ query: z.string() }),
  });
  expectTypeOf(myTool.name).toEqualTypeOf<"mySpecificTool">();
});
```

## パターンカタログ

- **Adapter パターン** (分類: 構造)
  - 解決する問題: Zod v3 と v4 という互換性のない2つのスキーマライブラリを統一的に扱う
  - 適用条件: 複数バージョンのライブラリを同時にサポートする必要がある場合
  - コード例: `libs/langchain-core/src/utils/types/zod.ts:49-51` (`InteropZodType`), `:250-295` (`interopParseAsync`)
  - 注意点: Union 型が肥大化すると型チェックが遅くなる。型ガード関数をランタイム分岐と1:1対応させないと型安全性が破綻する

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: `Runnable` の `invoke` / `batch` / `stream` の共通処理を基底クラスに集約し、サブクラスは実装のみ提供する
  - 適用条件: 処理の骨格は共通だが、具体的な実装がサブクラスごとに異なる場合
  - コード例: `libs/langchain-core/src/runnables/base.ts:124-132` (`Runnable` abstract class)
  - 注意点: `this["ParsedCallOptions"]` を使うことでサブクラスの型パラメータが基底クラスのメソッドシグネチャに反映される

- **Builder パターン** (分類: 生成)
  - 解決する問題: Runnable パイプラインを `pipe()` / `pick()` / `assign()` で段階的に構築する
  - 適用条件: 複数の処理ステップを型安全にチェインしたい場合
  - コード例: `libs/langchain-core/src/runnables/base.ts:615-623` (`pipe()`)
  - 注意点: 中間ステップの型は `any` に緩和されており、端点（first/last）の型安全性に依存する設計

## Good Patterns

- **Union 型 + 型ガード + 条件型の三位一体**: `InteropZodType` (Union) + `isZodSchemaV3()` (型ガード) + `InferInteropZodOutput<T>` (条件型) が同じ分岐構造を共有し、型レベルの正しさがランタイムの正しさを保証する。

```typescript
// libs/langchain-core/src/utils/types/zod.ts
// Union 型
export type InteropZodType<Output = any, Input = Output> =
  | z3.ZodType<Output, z3.ZodTypeDef, Input>
  | z4.$ZodType<Output, Input>;

// 型ガード（ランタイム分岐）
export function isZodSchemaV4(schema: unknown): schema is z4.$ZodType<unknown, unknown> { ... }

// 条件型（型レベル分岐）
export type InferInteropZodOutput<T> =
  T extends z3.ZodType<infer Output, z3.ZodTypeDef, unknown> ? Output
    : T extends z4.$ZodType<infer Output, unknown> ? Output
      : T extends { _zod: { output: infer Output } } ? Output
        : never;
```

- **`declare` フィールドによる型のみのプロパティ**: `declare ParsedCallOptions` は JavaScript に出力されないため、ランタイムコストゼロでサブクラスの型パラメータに依存する型を公開できる。`this["ParsedCallOptions"]` と組み合わせることで、サブクラスが `CallOptions` を変更するだけで自動的にメソッドシグネチャが追従する。

```typescript
// libs/langchain-core/src/language_models/chat_models.ts:213-216
declare ParsedCallOptions: Omit<
  CallOptions,
  Exclude<keyof RunnableConfig, "signal" | "timeout" | "maxConcurrency">
>;

// メソッドで this["ParsedCallOptions"] として参照
_streamResponseChunks(
  _messages: BaseMessage[],
  _options: this["ParsedCallOptions"],
  _runManager?: CallbackManagerForLLMRun
): AsyncGenerator<ChatGenerationChunk> { ... }
```

- **NameT extends string によるリテラル型キャプチャ**: `tool()` の `NameT extends string` パラメータにより、`name: "search"` と書くだけでリテラル型 `"search"` がキャプチャされ、ツール配列で discriminated union パターンが使える。

```typescript
// libs/langchain-core/src/tools/tests/types.test-d.ts:33-58
const searchTool = tool((_input) => "search result", {
  name: "search",
  description: "Search",
  schema: z.object({ query: z.string() }),
});
// searchTool.name は "search" リテラル型
if (firstTool.name === "search") {
  expectTypeOf(firstTool.name).toEqualTypeOf<"search">();
}
```

- **型テストファイル (`*.test-d.ts`) による型レベルの回帰テスト**: `expectTypeOf` を使って型推論の正しさを検証するテストを専用ファイルに分離。型の破壊的変更をCI で検出できる。

## Anti-Patterns / 注意点

- **ジェネリクスパラメータのデフォルト `any` の伝播**: `Runnable<RunInput = any, RunOutput = any>` のデフォルトにより、型パラメータを省略すると型チェックが事実上無効になる。47箇所の `eslint-disable no-explicit-any` が base.ts に存在し、型安全の穴が広がるリスクがある。

```typescript
// Bad: デフォルト any のまま使う
const runnable: Runnable = someRunnable; // RunInput = any, RunOutput = any

// Better: 型パラメータを明示する
const runnable: Runnable<string, number> = someRunnable;
```

- **条件型のネストが深すぎると可読性・デバッグ性が低下する**: `InteropZodObjectShape` は4段の条件型であり、`ToolReturnType` は5段。型エラーメッセージが難解になり、利用者にとって理解が困難になる。

```typescript
// Bad: 5段の条件型を一つの型定義に詰め込む
export type ToolReturnType<TInput, TConfig, TOutput> =
  TOutput extends DirectToolOutput ? TOutput
    : TConfig extends { toolCall: { id: string } } ? ToolMessage
      : TConfig extends { toolCall: { id: undefined } } ? TOutput
        : TConfig extends { toolCall: { id?: string } } ? TOutput | ToolMessage
          : TInput extends ToolCall ? ToolMessage : TOutput;

// Better: 中間型に名前をつけて分割する
type ResolveByConfig<TConfig, TOutput> = ...;
type ResolveByInput<TInput, TOutput> = ...;
export type ToolReturnType<TInput, TConfig, TOutput> =
  TOutput extends DirectToolOutput ? TOutput : ResolveByConfig<TConfig, ResolveByInput<TInput, TOutput>>;
```

- **中間ステップの型が `any` に緩和される**: `RunnableSequence` の `middle: Runnable[]` は型パラメータなしの `Runnable` (= `Runnable<any, any>`) であり、パイプライン途中の型不整合はコンパイル時に検出できない。

```typescript
// libs/langchain-core/src/runnables/base.ts:1857-1862
protected first: Runnable<RunInput>;
protected middle: Runnable[] = [];        // any, any
protected last: Runnable<any, RunOutput>; // input は any
```

## 導出ルール

- `[MUST]` 複数バージョンのライブラリをサポートする場合、Union 型・型ガード関数・条件型の3つを同じ分岐構造で定義し、型レベルとランタイムの分岐を1:1対応させる
  - 根拠: `InteropZodType` / `isZodSchemaV3` / `InferInteropZodOutput` が同じ v3/v4 分岐構造を持つことで型安全な interop を実現している (`libs/langchain-core/src/utils/types/zod.ts`)

- `[MUST]` ファクトリ関数が入力の型に応じて異なる型の値を返す場合、実装シグネチャではなくオーバーロードシグネチャで戻り値型を制約する
  - 根拠: `tool()` は12以上のオーバーロードで入力スキーマの型ごとに正確な `DynamicTool` / `DynamicStructuredTool` 型を返し、呼び出し側の型推論を最大化している (`libs/langchain-core/src/tools/index.ts:598-807`)

- `[SHOULD]` 基底クラスのメソッドシグネチャがサブクラスの型パラメータに依存する場合、`declare` フィールド + `this["T"]` で型のみのプロパティを定義し、サブクラスでの明示的なオーバーライドを不要にする
  - 根拠: `BaseChatModel` の `declare ParsedCallOptions` は `CallOptions` から `Omit` で派生し、全サブクラスで自動的に適切な型が得られる (`libs/langchain-core/src/language_models/chat_models.ts:213-216`)

- `[SHOULD]` パイプライン型の API では、入力側を Union 型（柔軟性）、出力側をジェネリクス（型安全）で設計し、`Exclude<T, Error>` で不要な型を除外する
  - 根拠: `pipe()` は `RunnableLike` (Union) を受け取り `Runnable<RunInput, Exclude<NewRunOutput, Error>>` を返す設計で、利便性と安全性を両立している (`libs/langchain-core/src/runnables/base.ts:615-617`)

- `[SHOULD]` ジェネリクスで文字列リテラル型をキャプチャしたい場合、`T extends string` 制約のパラメータを使い、呼び出し側でリテラル型推論を有効にする
  - 根拠: `tool()` の `NameT extends string` により `name: "search"` がリテラル型として保持され、discriminated union パターンが可能になる (`libs/langchain-core/src/tools/index.ts:618`)

- `[SHOULD]` 型の振る舞いを検証する専用テストファイル (`*.test-d.ts`) を作成し、`expectTypeOf` で型推論の正しさを CI で回帰テストする
  - 根拠: langchainjs は 17 個の `.test-d.ts` ファイルでツール型推論・エージェント型推論・メッセージ型の正しさを検証している

- `[AVOID]` ジェネリクスの全パラメータを `any` デフォルトにすること。型パラメータを省略した際に型チェックが無効化され、型安全の穴が静かに広がる
  - 根拠: `Runnable<RunInput = any, RunOutput = any>` のデフォルト any により、47箇所の `eslint-disable no-explicit-any` が必要になっている (`libs/langchain-core/src/runnables/base.ts`)

- `[AVOID]` 条件型を4段以上ネストすること。型エラーメッセージが難解になり、利用者のデバッグコストが増大する。中間型に名前をつけて分割すべき
  - 根拠: `InteropZodObjectShape` (4段) や `ToolReturnType` (5段) は正しく動作するが、型エラー発生時の理解が困難

## 適用チェックリスト

- [ ] 複数バージョンのライブラリをサポートする必要がある場合、Interop パターン（Union 型 + 型ガード + 条件型）の導入を検討したか
- [ ] ファクトリ関数が複数の型を返す場合、オーバーロードシグネチャで戻り値型を制約しているか
- [ ] 基底クラスでサブクラスの型パラメータに依存する型フィールドがある場合、`declare` + `this["T"]` パターンを使っているか
- [ ] パイプライン API の入力は Union 型で柔軟に、出力はジェネリクスで型安全に設計しているか
- [ ] 文字列リテラル型を保持したい箇所で `T extends string` 制約を使っているか
- [ ] 型推論の正しさを検証する `.test-d.ts` ファイルと `expectTypeOf` を導入しているか
- [ ] ジェネリクスのデフォルト型が `any` になっている箇所を `unknown` や適切なデフォルトに置き換えられないか検討したか
- [ ] 条件型が3段以上ネストしている箇所を中間型に分割して可読性を改善できないか検討したか
