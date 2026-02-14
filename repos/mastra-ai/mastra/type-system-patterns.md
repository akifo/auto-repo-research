# type-system-patterns

> リポジトリ: mastra-ai/mastra
> 分析日: 2026-02-14

## 概要

TypeScript の型システムを高度に活用し、ランタイムスキーマバリデーション（Zod）とコンパイル時の型安全性を統合している大規模 AI フレームワーク。Zod v3/v4 両方のサポート、7+ ジェネリクスを持つクラス定義、条件型による API 分岐、ブランド型によるプロトコル強制など、型レベルプログラミングの実践的なパターンが豊富に見られる。strict モードに加え `noUncheckedIndexedAccess` を有効にしており、型安全性への姿勢が徹底している。

## 背景にある原則

- **スキーマ駆動型設計（Schema as Single Source of Truth）**: Zod スキーマからランタイムバリデーションと TypeScript 型の両方を導出し、定義の二重管理を排除する。`z.infer<typeof schema>` による型導出がコードベース全体で一貫して使われ、型とバリデーションの乖離を防いでいる（`packages/core/src/evals/types.ts`, `packages/core/src/workflows/types.ts:536-569`）
- **型パラメータの伝播による API 安全性**: ジェネリクスをクラス/関数の入口で受け取り、内部の全メソッドに伝播させることで、ユーザーが型を意識せずとも end-to-end で型安全になる設計。`Workflow` クラスの 8 つのジェネリクスが `then()` チェーンで前ステップの出力型を次ステップの入力型に伝播させるのが典型例（`packages/core/src/workflows/workflow.ts:1276-1293`）
- **構造的部分型による互換性レイヤー**: 外部ライブラリ（Zod v3/v4、AI SDK v4/v5/v6）間の型互換性を、nominal な型ではなく構造的な型一致で吸収する。`ZodLikeSchema` 型が `safeParse` メソッドの存在をチェックするだけで両バージョンを受け入れるのがその例（`packages/core/src/types/zod-compat.ts:12`）
- **型レベルの制約表現**: ブランド型やテンプレートリテラル型を使い、「コンパイル時にしか検証できない制約」を型で表現する。suspend の戻り値を `InnerOutput`（ブランド型）に限定し、開発者が suspend 以外の値を返すことを防ぐ設計が代表的（`packages/core/src/workflows/step.ts:17-21`）

## 実例と分析

### Zod スキーマと型の統合パターン

スキーマ定義から型を導出する「Schema-First」アプローチが一貫して使われている。`StepParams` 型では、ジェネリクスとして Zod スキーマ型（`z.ZodTypeAny`）を受け取り、`z.infer<TInputSchema>` で値の型を導出する。これにより、スキーマ変更時に型が自動追従する。

```typescript
// packages/core/src/workflows/types.ts:536-569
export type StepParams<
  TStepId extends string,
  TStateSchema extends z.ZodTypeAny | undefined,
  TInputSchema extends z.ZodTypeAny,
  TOutputSchema extends z.ZodTypeAny,
  TResumeSchema extends z.ZodTypeAny | undefined = undefined,
  TSuspendSchema extends z.ZodTypeAny | undefined = undefined,
> = {
  id: TStepId;
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
  execute: ExecuteFunction<
    TStateSchema extends z.ZodTypeAny ? z.infer<TStateSchema> : unknown,
    z.infer<TInputSchema>,
    z.infer<TOutputSchema>,
    TResumeSchema extends z.ZodTypeAny ? z.infer<TResumeSchema> : unknown,
    TSuspendSchema extends z.ZodTypeAny ? z.infer<TSuspendSchema> : unknown,
    DefaultEngineType
  >;
};
```

さらに `z.infer` の応用として、`z.input`（変換前の入力型）と `z.infer`（変換後の出力型）を区別する型も定義されている。

```typescript
// packages/core/src/types/zod-compat.ts:17-18
export type InferZodLikeSchema<T extends ZodLikeSchema<any>> = T extends z.ZodType<infer V, z.ZodTypeDef, any> ? V
  : T extends zv4.ZodType<infer V> ? V
  : never;
```

### 条件型による API の分岐

`OUTPUT` ジェネリクスの値に応じて API のシグネチャを切り替えるパターンが複数箇所で使われている。`AgentExecutionOptions` では `OUTPUT extends {}` で構造化出力の有無を判定し、`structuredOutput` プロパティの必須/禁止を切り替える。

```typescript
// packages/core/src/agent/agent.types.ts:246-247
export type AgentExecutionOptions<OUTPUT = unknown> =
  & AgentExecutionOptionsBase<OUTPUT>
  & (OUTPUT extends {} ? { structuredOutput: StructuredOutputOptions<OUTPUT>; } : { structuredOutput?: never; });
```

コールバック型も同様に出力型で分岐する。

```typescript
// packages/core/src/agent/types.ts:304
onStepFinish?: OUTPUT extends undefined ? GenerateTextOnStepFinishCallback<any> : never;
```

```typescript
// packages/core/src/agent/types.ts:389
onFinish?: OUTPUT extends undefined ? StreamTextOnFinishCallback<any> : StreamObjectOnFinishCallback<OUTPUT>;
```

### ブランド型によるプロトコル強制

ワークフローの `suspend()` が返す型にブランド型を使い、`execute` 関数の戻り値として suspend 結果のみを返せるよう制約している。

```typescript
// packages/core/src/workflows/step.ts:17-21
declare const SuspendBrand: unique symbol;
export type InnerOutput = void & { readonly [SuspendBrand]: never; };
```

`suspend` の戻り値が `InnerOutput` 型であるため、`execute` の戻り値型 `Promise<TStepOutput | InnerOutput>` と整合し、suspend 以外のコードパスでは `TStepOutput` を返すことが型レベルで強制される。

### テンプレートリテラル型による ID 制約

プロバイダ定義ツールの ID は `${string}.${string}` 形式を要求し、不正な形式をコンパイル時に防ぐ。

```typescript
// packages/core/src/tools/types.ts:205-206
| {
    type: 'provider-defined';
    id: `${string}.${string}`;
    args: Record<string, unknown>;
  }
```

モデル設定でも同様のパターンが使われている。

```typescript
// packages/core/src/llm/model/shared.types.ts:32-33
export type OpenAICompatibleConfig =
  | { id: `${string}/${string}`; url?: string; apiKey?: string; ... }
  | { providerId: string; modelId: string; ... };
```

### ジェネリクス伝播によるチェーン API の型安全性

`Workflow.then()` メソッドは、前ステップの出力型 `TPrevSchema` を次ステップの入力型制約として使い、戻り値で `Workflow` 全体のジェネリクスを更新する。

```typescript
// packages/core/src/workflows/workflow.ts:1412-1449
then<TStepId extends string, TStepState, TStepInput, TSchemaOut>(
  step: Step<
    TStepId,
    unknown extends TStepState ? TStepState : SubsetOf<TStepState, TState>,
    TPrevSchema extends TStepInput ? TStepInput : TPrevSchema, // 型レベルの入力互換性チェック
    TSchemaOut, any, any, TEngineType, any
  >,
) {
  // ...
  return this as unknown as Workflow<
    TEngineType, TSteps, TWorkflowId, TState, TInput, TOutput,
    TSchemaOut, // TPrevSchema が更新される
    TRequestContext
  >;
}
```

`SubsetOf` はステップの状態スキーマがワークフロー全体の状態のサブセットであることを型レベルで検証する高度な条件型。

```typescript
// packages/core/src/workflows/types.ts:758-778
export type SubsetOf<TStepState, TState> =
  unknown extends TState ? TStepState :
  0 extends 1 & TStepState ? TStepState :    // any チェック
  unknown extends TStepState ? TStepState :
  TStepState extends infer TStepShape
    ? TState extends infer TStateShape
      ? keyof TStepShape extends keyof TStateShape
        ? { [K in keyof TStepShape]: TStepShape[K] extends TStateShape[K] ? TStepShape[K] : never }
            extends TStepShape ? TStepState : never
        : never
      : never
    : never;
```

### 型安全なコンテナ（RequestContext）

`RequestContext<Values>` は Map ベースのコンテナだが、ジェネリクス `Values` を活用して `get`/`set` メソッドの型安全性を実現している。

```typescript
// packages/core/src/request-context/index.ts:47-63
public set<K extends Values extends Record<string, any> ? keyof Values : string>(
  key: K,
  value: Values extends Record<string, any> ? (K extends keyof Values ? Values[K] : never) : unknown,
): void { ... }

public get<
  K extends Values extends Record<string, any> ? keyof Values : string,
  R = Values extends Record<string, any> ? (K extends keyof Values ? Values[K] : never) : unknown,
>(key: K): R { ... }
```

### 関数オーバーロードによる多態的ファクトリ

`createStep` は 5 つのオーバーロードで `StepParams` / `Agent` / `Tool` / `Processor` を受け取り、型安全に `Step` を生成する。実装では型ガード（`isAgent`, `isToolStep`, `isStepParams`）でディスパッチする。

```typescript
// packages/core/src/workflows/workflow.ts:156-280
// オーバーロード 1: StepParams
export function createStep<TStepId, TStateSchema, TInputSchema, TOutputSchema, ...>(
  params: StepParams<...>,
): Step<...>;
// オーバーロード 2: Agent（デフォルト出力）
export function createStep<TStepId extends string>(
  agent: Agent<TStepId, any>,
  agentOptions?: ...,
): Step<TStepId, unknown, { prompt: string }, { text: string }, ...>;
// オーバーロード 3: Agent（構造化出力）
export function createStep<TStepId extends string, TStepOutput>(
  agent: Agent<TStepId, any>,
  agentOptions: ... & { structuredOutput: { schema: OutputSchema<TStepOutput> } },
): Step<TStepId, unknown, { prompt: string }, TStepOutput, ...>;
// オーバーロード 4: Tool
// オーバーロード 5: Processor
```

### 判別共用体（Discriminated Unions）による状態管理

`StepResult` はワークフローステップの状態を判別共用体で表現し、`status` フィールドで型を絞り込める。

```typescript
// packages/core/src/workflows/types.ts:133-139
export type StepResult<P, R, S, T> =
  | StepSuccess<P, R, S, T>
  | StepFailure<P, R, S, T>
  | StepSuspended<P, S, T>
  | StepRunning<P, R, S, T>
  | StepWaiting<P, R, S, T>
  | StepPaused<P, R, S, T>;
```

各バリアントの `status` はリテラル型（`'success'`, `'failed'` 等）であり、`if (result.status === 'success')` で型が自動的に絞り込まれる。

## パターンカタログ

- **Adapter パターン** (構造)
  - 解決する問題: 外部ライブラリの異なるバージョン（Zod v3/v4, AI SDK v4/v5/v6）を統一的に扱う
  - 適用条件: 構造的に互換な複数の外部型を単一のインターフェースで受け入れたい場合
  - コード例: `packages/core/src/types/zod-compat.ts:12` (`ZodLikeSchema`)、`packages/core/src/stream/base/schema.ts:10-27` (`InferSchemaOutput`)
  - 注意点: 構造的部分型に依存するため、外部ライブラリの内部構造変更でブレイクする可能性がある

- **Builder パターン** (生成)
  - 解決する問題: 複雑なオブジェクト（Workflow）を段階的に型安全に構築する
  - 適用条件: メソッドチェーンで段階的にオブジェクトを構成し、各ステップの型を伝播させたい場合
  - コード例: `packages/core/src/workflows/workflow.ts:1412-1449` (`Workflow.then()`)
  - 注意点: ジェネリクスが増えすぎると型エラーメッセージが難解になる。フォールバックオーバーロードで改善している（workflow.ts:248-280）

## Good Patterns

- **Schema-First 型導出**: Zod スキーマを定義し `z.infer<typeof schema>` で型を導出するパターン。ランタイム検証とコンパイル時型安全性が一つの定義から得られる。

```typescript
// packages/core/src/evals/types.ts:55-67
export const scoringInputSchema = z.object({
  runId: z.string().optional(),
  input: z.unknown().optional(),
  output: z.unknown(),
  additionalContext: optionalRecordSchema,
});
export type ScoringInput = z.infer<typeof scoringInputSchema> & {
  tracingContext?: TracingContext; // ランタイム非直列化可能な型を追加
};
```

- **as const satisfies による型安全なリテラル定義**: `as const` でリテラル型を保持しつつ、`satisfies` で構造の妥当性を検証する。

```typescript
// packages/core/src/storage/domains/shared.ts:11-14
export const dbTimestamps = {
  createdAt: createdAtField,
  updatedAt: updatedAtField.nullable(),
} as const satisfies z.ZodRawShape;
```

- **型ガード + オーバーロードによるポリモーフィックファクトリ**: ユーザーには厳密なオーバーロード型を見せ、実装では型ガードでディスパッチする。型の安全性と実装の柔軟性を両立する。

```typescript
// packages/core/src/workflows/workflow.ts:123-139
function isAgent<TStepId extends string>(input: unknown): input is Agent<TStepId, any> {
  return input instanceof Agent;
}
function isToolStep(input: unknown): input is ToolStep<any, any, any, any, any> {
  return input instanceof Tool;
}
function isStepParams(input: unknown): input is StepParams<any, any, any, any, any, any> {
  return input !== null && typeof input === "object"
    && "id" in input && "execute" in input
    && !(input instanceof Agent) && !(input instanceof Tool);
}
```

- **DynamicArgument による遅延評価型**: 設定値を「静的な値」と「動的に解決する関数」の共用体で受け入れ、実行時コンテキストに応じた設定を型安全に提供する。

```typescript
// packages/core/src/types/dynamic-argument.ts:4-12
export type DynamicArgument<T, TRequestContext extends Record<string, any> | unknown = unknown> =
  | T
  | (({ requestContext, mastra }: {
    requestContext: RequestContext<TRequestContext>;
    mastra?: Mastra;
  }) => Promise<T> | T);
```

## Anti-Patterns / 注意点

- **ジェネリクス過多による型エラー難読化**: `Workflow` クラスは 8 つのジェネリクスを持ち、型エラーが発生すると数百行の型展開が表示される。mastra ではフォールバックオーバーロードで改善しているが、根本的には型パラメータの数を最小限に保つべき。

```typescript
// Bad: 8+ ジェネリクスのクラス
export class Workflow<TEngine, TSteps, TWorkflowId, TState, TInput, TOutput, TPrevSchema, TRequestContext>

// Better: 設定オブジェクト型でまとめる
type WorkflowTypes = { engine: ...; steps: ...; state: ...; input: ...; output: ...; };
export class Workflow<T extends WorkflowTypes>
```

- **`as unknown as` による型キャスト**: チェーンメソッドの戻り値で `this as unknown as Workflow<...>` が多用されている。安全性はオーバーロードのシグネチャに依存しており、実装の変更で型の整合性が壊れるリスクがある。

```typescript
// packages/core/src/workflows/workflow.ts:1440
return this as unknown as Workflow<
  TEngineType,
  TSteps,
  TWorkflowId,
  TState,
  TInput,
  TOutput,
  TSchemaOut,
  TRequestContext
>;
```

## 導出ルール

- `[MUST]` Zod スキーマを定義したら `z.infer<typeof schema>` で型を導出し、手書きの型定義と二重管理しない
  - 根拠: mastra は `evals/types.ts`, `workflows/types.ts`, `storage/domains/shared.ts` 等で一貫してスキーマから型を導出し、定義の乖離を防止している

- `[MUST]` 判別共用体（Discriminated Unions）の判別子にはリテラル型を使い、`switch`/`if` による型の絞り込みを可能にする
  - 根拠: `StepResult` 型は `status` リテラル（`'success'` | `'failed'` | ...）で 6 バリアントを判別し、各ブランチで異なるプロパティに型安全にアクセスできる（`workflows/types.ts:133-139`）

- `[SHOULD]` 外部ライブラリの複数バージョンを扱う場合、nominal 型ではなく構造的部分型（特定メソッドの有無）で互換性レイヤーを作る
  - 根拠: `ZodLikeSchema` は Zod v3/v4 両方を `z.ZodType | zv4.ZodType` の union で受け入れ、`InferSchemaOutput` は Zod v3/v4/AI SDK Schema/JSONSchema7 の 4 系統を条件型チェーンで処理している（`types/zod-compat.ts`, `stream/base/schema.ts:10-27`）

- `[SHOULD]` 設定値が「静的な値」と「実行時に解決する関数」の両方を取りうる場合、`T | ((ctx) => T | Promise<T>)` のユニオン型で表現する
  - 根拠: `DynamicArgument` 型が `tools`, `instructions`, `model` 等の設定に一貫して適用され、テスト時は静的値、本番では動的解決を同一 API で扱える（`types/dynamic-argument.ts:4-12`）

- `[SHOULD]` ブランド型（`unique symbol` + intersection）を使って、特定の関数からのみ生成可能な値を型レベルで強制する
  - 根拠: `InnerOutput` 型は `suspend()` の戻り値専用のブランド型で、開発者が `execute` 関数内で不正な void 値を返すことをコンパイル時に防止する（`workflows/step.ts:17-21`）

- `[SHOULD]` チェーンメソッド（Builder パターン）では `this` の型を更新して返し、前ステップの出力型を次ステップの入力型に伝播させる
  - 根拠: `Workflow.then()` は `TPrevSchema` を `TSchemaOut` に更新した `Workflow` 型を返すことで、ステップ間の型互換性をコンパイル時に検証する（`workflow.ts:1412-1449`）

- `[SHOULD]` 関数オーバーロードを使う場合、最後にフォールバックオーバーロードを置いてエラーメッセージを改善する
  - 根拠: `createStep` は「IMPORTANT: Fallback overload」コメント付きで最後に同一シグネチャを再定義し、マッチしなかった場合のエラーメッセージ品質を向上させている（`workflow.ts:248-280`）

- `[AVOID]` ジェネリクスを 5 つ以上持つ public API を作る（内部型は許容）。型エラーが難読化し、IDE の補完品質も低下する
  - 根拠: `Workflow` の 8 ジェネリクスや `Tool` の 7 ジェネリクスは強力だが、型エラーメッセージが数百行に膨れる。`@TODO: Figure out how to type this without breaking all the inner types` というコメント（`agent.types.ts:171`）が複雑さの代償を示している

## 適用チェックリスト

- [ ] プロジェクトの Zod スキーマから `z.infer` で型を導出しているか？ 手書きの型定義との二重管理がないか確認する
- [ ] 状態やイベントの共用体型に `status` / `type` などのリテラル判別子が付いているか？ `switch` で型が絞り込めるか確認する
- [ ] 外部ライブラリの複数バージョンをサポートする場合、構造的部分型で互換性レイヤーを定義しているか？
- [ ] 設定値で「静的 or 動的」を受け入れる場合、`T | ((ctx) => T | Promise<T>)` のユーティリティ型を作って統一しているか？
- [ ] Builder パターンのチェーンメソッドで、各ステップの型情報が戻り値の型に反映されているか？
- [ ] `tsconfig.json` で `strict: true` + `noUncheckedIndexedAccess` が有効か？
- [ ] 公開 API のジェネリクス数が 5 以下に収まっているか？ 超過する場合は設定オブジェクト型へのリファクタリングを検討する
- [ ] `as const satisfies` を使って、リテラル型の保持と構造検証を両立しているか？
