# API Design Practices

> リポジトリ: mastra-ai/mastra
> 分析日: 2026-02-14

## 概要

Mastra は TypeScript で構築された AI フレームワークであり、Agent・Tool・Workflow・Memory・Storage など多数の概念を統一的な API で提供している。パブリック API 全体に「設定オブジェクトパターン」「ファクトリ関数 + クラス」「Fluent Builder」「DynamicArgument による遅延解決」が一貫して適用されており、DX（Developer Experience）を重視した設計判断が随所に見られる。特に注目に値するのは、Zod スキーマを型レベルで伝播させるジェネリクス設計と、`createXxx` ファクトリ関数で初学者の認知負荷を下げつつ型安全性を維持している点である。

## 背景にある原則

- **Configuration Object Principle（設定オブジェクト原則）**: コンストラクタの引数を単一の設定オブジェクトにまとめることで、パラメータの順序依存を排除し、オプショナル項目の追加を後方互換で行えるようにすべき。Mastra では `Mastra`・`Agent`・`Tool`・`Workflow` すべてのコンストラクタが単一オブジェクトを受け取り、10以上のジェネリック型パラメータを持つ `Config` インターフェースでも破綻しない設計を実現している（`packages/core/src/mastra/index.ts:101-257`）。

- **Factory over Constructor（ファクトリ関数優先原則）**: `new Class()` より `createXxx()` を公開 API とすることで、内部実装の自由度を確保し、消費者には最小限のインターフェースだけ見せるべき。`createTool`・`createStep`・`createWorkflow`・`createScorer` がこのパターンを一貫して適用している。特に `createStep` は Agent / Tool / StepParams / Processor の4種を型ガードで分岐する多態ファクトリとして機能している。

- **DynamicArgument Pattern（遅延解決パターン）**: 設定値をリテラル値と関数の Union 型にすることで、静的設定と実行時解決の両方を同一 API で扱えるようにすべき。これにより「テスト時はハードコード、本番は動的」という切り替えが API 変更なしに可能になる（`packages/core/src/types/dynamic-argument.ts:4-12`）。

- **Progressive Disclosure（段階的開示原則）**: API は最小限の必須項目で動作し、高度な機能はオプショナルとして段階的に露出すべき。`new Mastra({})` はゼロコンフィグで起動可能であり、`logger` はデフォルトで `ConsoleLogger`（dev: INFO, prod: WARN）、`observability` は未指定時に `NoOpObservability` にフォールバックする。モデル指定も `'openai/gpt-5'` というマジック文字列から設定オブジェクト、ネイティブ LanguageModel インスタンスまで段階的に複雑さを開示する。

## 実例と分析

### 1. 中央レジストリとしての Mastra クラス（DI Hub パターン）

`Mastra` クラスは全コンポーネントのレジストリであり、DI コンテナとして機能する。コンストラクタで `agents`・`tools`・`workflows`・`storage` 等を受け取り、各コンポーネントに `__registerMastra(this)` で自身を注入する。

```typescript
// packages/core/src/mastra/index.ts:867-875
mastraAgent.__setLogger(this.#logger);
mastraAgent.__registerMastra(this);
mastraAgent.__registerPrimitives({
  logger: this.getLogger(),
  storage: this.getStorage(),
  agents: agents,
  tts: this.#tts,
  vectors: this.#vectors,
});
```

この設計により、Tool の `execute` 内で `context.mastra.getAgent('agentId')` のようにサービスロケータとして利用できる。コンポーネント間の依存を Mastra インスタンス経由で解決するため、循環参照を回避しつつ疎結合を維持している。

初期化順序にも注目すべき設計判断がある。コンストラクタ内でコンポーネントを登録する順序は `tools → processors → memory → vectors → scorers → workflows → gateways → mcpServers → agents` と明示的に制御されている（`packages/core/src/mastra/index.ts:596-677`）。依存元より先に依存先を登録することで、Agent が Tool や Workflow を参照する際に確実に解決できる。

### 2. Fluent Builder としての Workflow API

Workflow は `createWorkflow({...}).then(step1).then(step2).commit()` という Fluent Builder パターンで構築される。各メソッドは型パラメータ `TPrevSchema` を連鎖的に更新し、前ステップの出力型が次ステップの入力型と一致しなければコンパイルエラーになる。

```typescript
// examples/workflow-with-separate-steps/src/mastra/workflows/index.ts:82-96
export const myWorkflow = createWorkflow({
  id: "my-workflow",
  inputSchema: z.object({ inputValue: z.number() }),
  outputSchema: z.object({ isEven: z.boolean() }),
})
  .then(stepOne)
  .then(stepTwo)
  .then(stepThree)
  .then(stepFour);

myWorkflow.commit();
```

`then` に加えて `branch`・`parallel`・`dowhile`・`dountil`・`foreach`・`sleep`・`sleepUntil`・`map` が同じ Fluent インターフェースで提供されている。`commit()` で実行グラフを確定させる 2-Phase Build パターンにより、構築中と実行可能の状態を分離している。

```typescript
// packages/core/src/workflows/workflow.ts:1412-1450
then<TStepId extends string, TStepState, TStepInput, TSchemaOut>(
  step: Step<TStepId, ..., TPrevSchema extends TStepInput ? TStepInput : TPrevSchema, TSchemaOut, ...>,
) {
  this.stepFlow.push({ type: 'step', step: step as any });
  // ...
  return this as unknown as Workflow<..., TSchemaOut, TRequestContext>;
}
```

### 3. Scorer のステップチェーン Builder（Immutable Builder）

`createScorer({...}).preprocess().analyze().generateScore().generateReason()` という Builder パターンで、各チェーンメソッドが累積型 `TAccumulatedResults` を拡張しながら新しい `MastraScorer` インスタンスを返す。Workflow の Mutable Builder（`this` を返す）と異なり、Scorer は Immutable Builder（新インスタンスを返す）を採用している。

```typescript
// packages/core/src/evals/base.ts:332-360
generateScore<TScoreOutput extends number = number>(
  stepDef: GenerateScoreStepDef<TAccumulatedResults, TInput, TRunOutput>,
): MastraScorer<
  TID, TInput, TRunOutput,
  AccumulatedResults<TAccumulatedResults, 'generateScore', Awaited<TScoreOutput>>
> {
  return new MastraScorer(
    this.config,
    [...this.steps, { name: 'generateScore', definition: ..., isPromptObject: ... }],
    new Map(this.originalPromptObjects),
    this.#mastra,
  );
}
```

各ステップの結果型が `AccumulatedResults` に累積されるため、後段のステップから前段の結果に型安全にアクセスできる。

### 4. DynamicArgument による静的/動的の統一

Agent の設定値は `DynamicArgument<T>` 型で統一されている。これは「静的な値」と「リクエスト時に解決される関数」のユニオン型であり、ユーザーが文脈に応じて選択できる。

```typescript
// packages/core/src/types/dynamic-argument.ts:4-12
export type DynamicArgument<T, TRequestContext extends Record<string, any> | unknown = unknown> =
  | T
  | (({ requestContext, mastra }: {
    requestContext: RequestContext<TRequestContext>;
    mastra?: Mastra;
  }) => Promise<T> | T);
```

Agent の `instructions`, `tools`, `model`, `memory`, `workflows`, `scorers` 等のプロパティがすべてこの型を使う:

```typescript
// packages/core/src/agent/types.ts:155-172
instructions: DynamicArgument<AgentInstructions, TRequestContext>;
tools?: DynamicArgument<TTools, TRequestContext>;
workflows?: DynamicArgument<Record<string, Workflow<...>>>;
```

単純なケースでは文字列を渡し、マルチテナントやリクエスト依存のケースでは関数を渡す。フレームワーク側で解決ロジックを吸収するため、API シグネチャの変更なしにビジネスロジックの複雑さを受け止められる。

### 5. サブパスエクスポートによるモジュール分離

`@mastra/core` パッケージは `package.json` の `exports` フィールドでサブパスを公開している。`"./*"` ワイルドカードエクスポート（`packages/core/package.json:24-33`）により、各サブディレクトリの `index.ts` が自動的にサブパスとして公開される。

```typescript
// examples/ ディレクトリより収集した実際の import パス
import { Agent } from "@mastra/core/agent";
import { createScorer } from "@mastra/core/evals";
import { Mastra } from "@mastra/core/mastra";
import { createTool } from "@mastra/core/tools";
import { createStep, createWorkflow } from "@mastra/core/workflows";
```

サブパスごとに `index.ts` が公開 API のみを re-export するため、内部モジュールへの直接アクセスを防ぎつつ Tree Shaking を有効にしている。

### 6. 構造化エラーと DX 向上の工夫

`MastraError` は `id`（機械可読な大文字識別子）・`domain`（機能ドメイン）・`category`（USER/SYSTEM/THIRD_PARTY）の 3 軸でエラーを分類する。

```typescript
// packages/core/src/error/index.ts:48-64
export interface IErrorDefinition<DOMAIN, CATEGORY> {
  id: Uppercase<string>;
  text?: string;
  domain: DOMAIN;
  category: CATEGORY;
  details?: Record<string, Json<Scalar>>;
}
```

エラーメッセージにはユーザーが修正できるアクション指示を含め、よくあるミスの原因を先回りして説明する:

```typescript
// packages/core/src/mastra/index.ts:58-68
text: `Cannot add ${typeLabel}: ${typeLabel} is ${value === null ? 'null' : 'undefined'}. This may occur if config was spread ({ ...config }) and the original object had getters or non-enumerable properties.`,
```

バリデーションエラー時には機密キー（apiKey, token, password 等）を自動的にマスクする:

```typescript
// packages/core/src/tools/validation.ts:10-20
const SENSITIVE_KEYS = new Set([
  MASTRA_RESOURCE_ID_KEY,
  MASTRA_THREAD_ID_KEY,
  "apiKey",
  "api_key",
  "token",
  "secret",
  "password",
  "credential",
  "authorization",
]);
```

### 7. Dual API Surface（generate/stream 対称性）

Agent は同一のメッセージ入力に対して `generate()` と `stream()` の 2 つのメソッドを対称的に提供する。オプション型も共通基盤（`AgentExecutionOptionsBase`）を持ちつつ、各モード固有の設定を追加できる。

```typescript
// packages/core/src/agent/agent.ts:3740-3852
async generate(messages: MessageListInput, options?: AgentExecutionOptions<TOutput>): Promise<FullOutput<TOutput>>;
async stream(messages: MessageListInput, streamOptions?: AgentExecutionOptions): Promise<MastraModelOutput>;
```

両メソッドは `structuredOutput` オプションでの型安全なオーバーロードも対称的に提供しており、同じ `StructuredOutputOptions<OUTPUT>` 型を共有している。

### 8. RequestContext による型安全なリクエストスコープ DI

`RequestContext<Values>` は型パラメータでキーと値の型を制約し、認証情報などのリクエストスコープ値を型安全に伝搬させる。予約キー `MASTRA_RESOURCE_ID_KEY` と `MASTRA_THREAD_ID_KEY` でセキュリティ上重要な値の上書きを制御する。

```typescript
// packages/core/src/request-context/index.ts:33-63
export class RequestContext<Values extends Record<string, any> | unknown = unknown> {
  public set<K extends Values extends Record<string, any> ? keyof Values : string>(
    key: K,
    value: Values extends Record<string, any> ? (K extends keyof Values ? Values[K] : never) : unknown,
  ): void { ... }

  public get<K extends ...>(key: K): R { ... }
}
```

## パターンカタログ

- **Builder Pattern** (生成パターン)
  - 解決する問題: 多段階のオブジェクト構築を型安全に行う
  - 適用条件: 構築ステップが可変で、途中状態の型を追跡したい場合
  - コード例: `packages/core/src/workflows/workflow.ts:1412-1450`（Workflow.then - Mutable Builder）、`packages/core/src/evals/base.ts:332-360`（MastraScorer - Immutable Builder）
  - 注意点: Workflow は `this as unknown as Workflow<...>` で型パラメータを更新する Mutable Builder、Scorer は新インスタンスを返す Immutable Builder。用途に応じて使い分けている

- **Abstract Factory / Polymorphic Factory** (生成パターン)
  - 解決する問題: 入力型に応じて異なるオブジェクトを生成する
  - 適用条件: 複数の型を統一的な API で生成したい場合
  - コード例: `createTool()` (`packages/core/src/tools/tool.ts:403-419`), `createStep()` (4種の入力を受け付ける多態ファクトリ)
  - 注意点: TypeScript のオーバーロードで消費者には型安全に見せつつ、実装は型ガードで分岐する

- **Service Locator** (構造パターン)
  - 解決する問題: コンポーネント間の依存解決
  - 適用条件: 多数のコンポーネントが相互に参照し合う DI コンテナ的な構成
  - コード例: `Mastra.getAgent()`, `Mastra.getWorkflow()` (`packages/core/src/mastra/index.ts:723-741`)
  - 注意点: 登録順序に依存関係がある場合は初期化順序を制御する必要がある（mastra は tools → agents の順で初期化）

- **Strategy Pattern** (振る舞いパターン)
  - 解決する問題: 実行時にアルゴリズムを切り替える
  - 適用条件: ストレージ・ロガー・サーバーアダプタなどのプラグイン機構
  - コード例: `logger?: TLogger | false`（Config）、`MastraServerBase` を継承する各フレームワークアダプタ

## Good Patterns

- **DynamicArgument による静的/動的の統合**: 設定値を `T | ((ctx) => T | Promise<T>)` の Union 型にすることで、テスト時はリテラル、本番は RequestContext ベースの動的解決を同一 API で扱える。Agent の `instructions`・`tools`・`model` すべてがこのパターンを採用している。

```typescript
// packages/core/src/types/dynamic-argument.ts:4-12
export type DynamicArgument<T, TRequestContext = unknown> =
  | T
  | (({ requestContext, mastra }: {
    requestContext: RequestContext<TRequestContext>;
    mastra?: Mastra;
  }) => Promise<T> | T);
```

- **エラーメッセージ品質への投資**: `createUndefinedPrimitiveError` では `{ ...config }` スプレッドでゲッターが消える問題を具体的にエラーメッセージで指摘している。また `createStep` では「better error messages」のために意図的にフォールバックオーバーロードを追加している。

```typescript
// packages/core/src/mastra/index.ts:58-68
return new MastraError({
  id: errorId,
  domain: ErrorDomain.MASTRA,
  category: ErrorCategory.USER,
  text: `Cannot add ${typeLabel}: ${typeLabel} is ${
    value === null ? "null" : "undefined"
  }. This may occur if config was spread ({ ...config }) and the original object had getters or non-enumerable properties.`,
  details: { status: 400, ...(key && { key }) },
});
```

- **`logger: false` による明示的無効化**: Logger 設定は `TLogger | false` で、`false` を渡すと `noopLogger` に置換される。`undefined`（省略）とは意味が異なり、「意図的に無効化した」ことを型レベルで表現できる。

```typescript
// packages/core/src/mastra/index.ts:136-140, 542-543
logger?: TLogger | false;
// ...
if (config?.logger === false) {
  logger = noopLogger as unknown as TLogger;
}
```

- **構造化エラーシステム**: `MastraError` は `id`（機械可読）・`domain`（エラー分類）・`category`（USER/SYSTEM/THIRD_PARTY）・`details`（追加情報）を持つ構造化エラーで、ログ・API レスポンス・デバッグの全場面で一貫した情報を提供する。`toJSON()` メソッドでシリアライズ可能。

- **SchemaWithValidation で Zod v3/v4/JSON Schema を統一**: `SchemaWithValidation` 型は Zod v3, Zod v4, AI SDK の Schema, JSONSchema7 すべてを受け付け、内部で適切に変換する。ユーザーは使い慣れたスキーマライブラリを選択でき、フレームワーク側で差異を吸収する。

```typescript
// packages/core/src/stream/base/schema.ts:22-30
export type OutputSchema<OBJECT = any> =
  | z4.ZodType<OBJECT, any>
  | z3.Schema<OBJECT, z3.ZodTypeDef, any>
  | Schema<OBJECT>
  | JSONSchema7
  | undefined;
```

## Anti-Patterns / 注意点

- **ジェネリクスの過剰膨張**: `Mastra` クラスは 10 個のジェネリック型パラメータを持ち、`Workflow` は 8 個を持つ。型推論を正確にするために必要だが、エラーメッセージが極めて長くなり IDE のパフォーマンスにも影響する。

```typescript
// Bad: 10個のジェネリクスを手動指定することはほぼ不可能
export class Mastra<
  TAgents, TWorkflows, TVectors, TTTS, TLogger,
  TMCPServers, TScorers, TTools, TProcessors, TMemory,
> { ... }

// Better: ファクトリ関数で推論に任せる（Mastra は new しか提供していないが、
// createWorkflow のように createMastra を検討する余地がある）
```

- **`as unknown as` による型キャスト頻用**: Workflow の `then`・`branch`・`parallel` 等は戻り値で `this as unknown as Workflow<...新しい型パラメータ...>` を使っている。Fluent Builder の型推論では避けにくいが、内部実装のバグが型チェックをすり抜けるリスクがある。

```typescript
// packages/core/src/workflows/workflow.ts:1440-1450
return this as unknown as Workflow<
  TEngineType,
  TSteps,
  TWorkflowId,
  TState,
  TInput,
  TOutput,
  TSchemaOut, // ← 前ステップの出力型で更新
  TRequestContext
>;
```

- **`__` プレフィックスによる内部 API の曖昧な境界**: `__registerMastra()`, `__setLogger()`, `__registerPrimitives()` 等の内部メソッドが `public` としてエクスポートされている。命名規約で内部性を示すのは、外部から誤って呼ばれるリスクがある。ただし `api-extractor.json` が存在しており、モノレポ内パッケージ間アクセスを許可しつつ外部ユーザーには使わせたくないという要件に対する実用的な妥協と考えられる。

- **`commit()` 呼び忘れの実行時エラー**: Workflow のフルエント API は `commit()` を呼ばないと実行時にエラーになる。型レベルで `commit()` 後のみ `execute()` を許可する Phantom Type パターンを使えば、コンパイル時に検出可能。

```typescript
// packages/core/src/workflows/workflow.ts:1988-1994
if (!this.executionGraph.steps) {
  throw new Error("Uncommitted step flow changes detected. Call .commit() to register the steps.");
}
```

## 導出ルール

- `[MUST]` パブリック API のコンストラクタ引数は単一の設定オブジェクトにし、3 個以上の位置引数を避ける
  - 根拠: Mastra の全主要クラス（Mastra / Agent / Tool / Workflow）が設定オブジェクトパターンを一貫して採用し、後方互換を保ちながら 10 以上のオプションを段階的に追加している

- `[MUST]` フレームワークのエラーメッセージには機械可読な識別子（エラーコード）と人間が読めるアクション指示を含める
  - 根拠: `MastraError` は `id: Uppercase<string>`（例: `AGENT_CONSTRUCTOR_MODEL_REQUIRED`）と修正方法を示す `text` を必須フィールドとして持つ（`packages/core/src/error/index.ts:48-64`）

- `[SHOULD]` クラスコンストラクタの代わりに `createXxx` ファクトリ関数をパブリック API として公開し、型推論をファクトリに任せる
  - 根拠: `createTool`・`createStep`・`createWorkflow`・`createScorer` が一貫してこのパターンを使い、ジェネリクスの明示的指定なしで正確な型推論を実現している

- `[SHOULD]` 設定値が「静的値」と「実行時解決関数」の両方を受け付けるべき場合、`T | ((ctx) => T | Promise<T>)` の DynamicArgument パターンを使う
  - 根拠: Agent の `instructions`・`tools`・`model`・`memory` 全てでこのパターンを使い、テスト・開発・本番で API を変えずに設定戦略を切り替えている

- `[SHOULD]` 同一リソースに対して「一括取得」と「ストリーミング」の対称的な API を提供し、オプション型の共通部分を基底型として共有する
  - 根拠: Agent の `generate()` / `stream()` は `AgentExecutionOptionsBase` を共通基盤として持ち、同一のメッセージ入力で両方の呼び出しパターンをサポートしている

- `[SHOULD]` バリデーションエラーのログ出力時に、機密キー（apiKey, token, password 等）を自動的にマスクする仕組みをフレームワーク側で提供する
  - 根拠: `SENSITIVE_KEYS` セットによる自動マスキング（`packages/core/src/tools/validation.ts:10-20`）

- `[SHOULD]` ライブラリのパッケージはサブパスエクスポート（`package.json` の `exports` フィールド）を使い、機能単位で import パスを分離する
  - 根拠: `@mastra/core` は `@mastra/core/agent`, `@mastra/core/tools`, `@mastra/core/workflows` 等のサブパスで公開し、Tree Shaking と関心の分離を両立している

- `[AVOID]` フルエント API で「確定メソッド」（`commit()` 等）を要求する場合に、確定前の実行を実行時エラーでのみ検出する設計。可能であれば Phantom Type や Branded Type で型レベルの制約とする
  - 根拠: `Workflow.commit()` 未呼出しは実行時にのみ検出される（`packages/core/src/workflows/workflow.ts:1988-1994`）

- `[AVOID]` 同一概念の指定方法を 4 種類以上に増やすこと（マジック文字列・設定オブジェクト・インスタンス程度に留める）
  - 根拠: `MastraModelConfig` は 6 つの Union メンバーを持ち、`resolveModelConfig` の分岐ロジックが複雑化している。段階的開示は有用だが、選択肢が多すぎるとドキュメントとテストの負荷が指数的に増大する

## 適用チェックリスト

- [ ] パブリック API のコンストラクタが単一設定オブジェクトを受け取り、必須プロパティが 2-3 個以下に抑えられているか確認する
- [ ] `createXxx` ファクトリ関数を用意し、ジェネリクスの明示的指定なしで型推論が効くか検証する
- [ ] 設定値で「テスト時は固定値、本番は動的」が必要な箇所に DynamicArgument パターンを適用する
- [ ] ストリーミング対応が必要な API で、一括取得とストリーミングの対称的なメソッドが提供されているか確認する
- [ ] エラーメッセージに機械可読なエラーコードと、原因の説明・解決策のヒントが含まれているか見直す
- [ ] バリデーションエラーのログに機密情報が漏洩しないようマスキングが実装されているか確認する
- [ ] 構造化エラー（id + domain + category + details）を導入し、ログ・API レスポンス・デバッグで統一的にエラー情報を扱えるか検討する
- [ ] ライブラリのパッケージがサブパスエクスポートで機能単位に分離されているか確認する
- [ ] Fluent Builder のメソッドチェーンで型パラメータが正しく伝播しているかテスト型ファイル（`.test-d.ts`）で検証する
- [ ] フルエントAPIに「確定操作」がある場合、未確定での実行を型レベルで防止できているか検討する
