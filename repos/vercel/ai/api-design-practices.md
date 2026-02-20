# API Design Practices

> リポジトリ: vercel/ai
> 分析日: 2026-02-20

## 概要

Vercel AI SDK は generateText / streamText / generateObject / generateImage / embed など多数の高レベル API を提供するライブラリである。これらの API は共通のオプション構造、一貫したライフサイクルコールバック、`experimental_` プレフィックスによる段階的安定化、そして `ProviderOptions` による拡張ポイントを備えており、急速に進化する LLM エコシステムに対して後方互換性を維持しながら新機能を素早く出荷する戦略が見て取れる。本視点では、これらの API 設計プラクティスを横断的に分析し、汎用的な原則を抽出する。

## 背景にある原則

- **段階的安定化（Graduated Stability）**: 新しい API は `experimental_` プレフィックスで導入し、安定したら非プレフィックス版を追加して旧名を `@deprecated` にする。これにより semver patch での破壊的変更リスクを回避しつつ、ユーザーに早期アクセスを提供できる。根拠: `versioning.mdx` で「experimental_ APIs can change in any releases」と明文化されている。

- **オプション合成による関心事分離（Options Composition）**: 関数パラメータを `CallSettings & Prompt & { ...固有オプション }` のように intersection 型で合成し、共通設定（温度、リトライ数等）と関数固有の設定（tools、output 等）を分離する。各関心事を独立した型として管理でき、新しい関数の追加時に共通設定を再利用できる。根拠: `generate-text.ts:585` で `CallSettings & Prompt & { ... }` として合成。

- **Provider-Agnostic な拡張ポイント（Extension Without Core Change）**: プロバイダ固有の機能は `providerOptions: Record<string, JSONObject>` として外部に押し出し、コア API を変更せずにプロバイダ固有機能をシップする。根拠: `shared-v3-provider-options.ts` のコメント「This enables us to quickly ship provider-specific functionality without affecting the core AI SDK」。

- **対称的 API ペア（Symmetric API Pairs）**: 同一ドメインに対して同期的（`generateText`）とストリーミング（`streamText`）のペアを提供し、結果型のプロパティ名を統一する。ユーザーはモードを切り替える際にオプション構造を学び直す必要がない。根拠: `GenerateTextResult` と `StreamTextResult` が同一の `text`, `toolCalls`, `toolResults`, `usage` 等のプロパティを共有。

## 実例と分析

### experimental_ プレフィックスによる段階的プロモーション

AI SDK ではまず `experimental_` プレフィックス付きでフィーチャーを出し、安定化したら非プレフィックス版を併設して旧名を `@deprecated` にする。移行は関数のデストラクチャリングで透過的に行われる。

```typescript
// packages/ai/src/generate-text/generate-text.ts:565-572
  experimental_output,
  output = experimental_output,
  experimental_activeTools,
  activeTools = experimental_activeTools,
  experimental_prepareStep,
  prepareStep = experimental_prepareStep,
```

この手法により、既存ユーザーは `experimental_output` を渡し続けても動作し、新規ユーザーは `output` を使えるという両立が実現される。型定義側では旧名に `@deprecated` JSDoc を付与する。

### ProviderOptions による拡張ポイント設計

`ProviderOptions` は `Record<string, JSONObject>` というシンプルな型で、プロバイダ名をキーとする名前空間を形成する。プロバイダ側では `parseProviderOptions` で Zod スキーマによるバリデーションを行う。

```typescript
// packages/provider-utils/src/parse-provider-options.ts:5-32
export async function parseProviderOptions<OPTIONS>({
  provider,
  providerOptions,
  schema,
}: {
  provider: string;
  providerOptions: Record<string, unknown> | undefined;
  schema: FlexibleSchema<OPTIONS>;
}): Promise<OPTIONS | undefined> {
  if (providerOptions?.[provider] == null) {
    return undefined;
  }
  const parsedProviderOptions = await safeValidateTypes<OPTIONS | undefined>({
    value: providerOptions[provider],
    schema,
  });
  // ...
}
```

コア型は薄いまま（`Record<string, JSONObject>`）に保ち、バリデーションはプロバイダ側に委譲するという設計。

### 排他的パラメータの型レベル強制

`Prompt` 型は `prompt` と `messages` の排他性を TypeScript の discriminated union で表現する。

```typescript
// packages/ai/src/prompt/prompt.ts:7-43
export type Prompt =
  & {
    system?: string | SystemModelMessage | Array<SystemModelMessage>;
  }
  & (
    | { prompt: string | Array<ModelMessage>; messages?: never; }
    | { messages: Array<ModelMessage>; prompt?: never; }
  );
```

`never` 型を使って反対側のプロパティを禁止することで、コンパイル時に不正な組み合わせを検出できる。ランタイムでも `standardizePrompt` で二重チェックを行う多層防御の設計。

### _internal パラメータによるテスト接合点

全ての高レベル API 関数が `_internal` オプションを受け付け、ID 生成や現在時刻などの非決定的な要素をテスト時にモックできる。

```typescript
// packages/ai/src/generate-text/generate-text.ts:742-744
    _internal?: {
      generateId?: IdGenerator;
    };
// packages/ai/src/generate-object/generate-object.ts:191-194
      _internal?: {
        generateId?: () => string;
        currentDate?: () => Date;
      };
```

これはテスト容易性を確保しつつ、公開 API としてはドキュメント化しない（JSDoc に「Internal. For test use only. May change without notice.」と記載）アプローチ。

### NoInfer によるジェネリクス推論の制御

`TOOLS` ジェネリクスに対して `NoInfer<TOOLS>` を広範に適用し、ツール関連のオプションが `TOOLS` 型の推論ソースにならないようにしている。

```typescript
// packages/ai/src/generate-text/generate-text.ts:600
    toolChoice?: ToolChoice<NoInfer<TOOLS>>;
// packages/ai/src/generate-text/generate-text.ts:633
    activeTools?: Array<keyof NoInfer<TOOLS>>;
```

これにより `tools` プロパティのみが `TOOLS` 型の推論元となり、他のオプションで型推論が曖昧になることを防ぐ。

### FlexibleSchema による複数スキーマライブラリのサポート

`FlexibleSchema` 型は Zod v3、Zod v4、Standard Schema、カスタム Schema、LazySchema の union 型として定義されており、ユーザーは好みのスキーマライブラリを使える。

```typescript
// packages/provider-utils/src/schema.ts:72-76
export type FlexibleSchema<SCHEMA = any> =
  | Schema<SCHEMA>
  | LazySchema<SCHEMA>
  | ZodSchema<SCHEMA>
  | StandardSchema<SCHEMA>;
```

`asSchema` 関数がどの形式のスキーマでも内部の `Schema<OBJECT>` に正規化する。`LazySchema` は初期化コストを遅延させるためのパターン。

## コード例

```typescript
// packages/ai/src/generate-text/generate-text.ts:550-585
// intersection 型によるオプション合成の実例
export async function generateText<
  TOOLS extends ToolSet,
  OUTPUT extends Output = Output<string, string>,
>({
  model: modelArg,
  tools,
  toolChoice,
  system,
  prompt,
  messages,
  // ...
}: CallSettings &
  Prompt & {
    model: LanguageModel;
    tools?: TOOLS;
    toolChoice?: ToolChoice<NoInfer<TOOLS>>;
    // ...
  }): Promise<GenerateTextResult<TOOLS, OUTPUT>> {
```

```typescript
// packages/ai/src/generate-text/stop-condition.ts:1-17
// ストップ条件を関数として抽象化し、組み合わせ可能にする
export type StopCondition<TOOLS extends ToolSet> = (options: {
  steps: Array<StepResult<TOOLS>>;
}) => PromiseLike<boolean> | boolean;

export function stepCountIs(stepCount: number): StopCondition<any> {
  return ({ steps }) => steps.length === stepCount;
}

export function hasToolCall(toolName: string): StopCondition<any> {
  return ({ steps }) =>
    steps[steps.length - 1]?.toolCalls?.some(
      toolCall => toolCall.toolName === toolName,
    ) ?? false;
}
```

```typescript
// packages/ai/src/error/no-object-generated-error.ts:6-69
// エラー型の設計: 一意なマーカーシンボル + isInstance 静的メソッド
const name = "AI_NoObjectGeneratedError";
const marker = `vercel.ai.error.${name}`;
const symbol = Symbol.for(marker);

export class NoObjectGeneratedError extends AISDKError {
  private readonly [symbol] = true;
  readonly text: string | undefined;
  readonly response: LanguageModelResponseMetadata | undefined;
  readonly usage: LanguageModelUsage | undefined;
  readonly finishReason: FinishReason | undefined;
  // ...
  static isInstance(error: unknown): error is NoObjectGeneratedError {
    return AISDKError.hasMarker(error, marker);
  }
}
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: ストップ条件やツール選択戦略を実行時に切り替える必要がある
  - 適用条件: アルゴリズムのバリエーションが複数あり、呼び出し側で選択したい場合
  - コード例: `packages/ai/src/generate-text/stop-condition.ts:4-6` — `StopCondition` を関数型として定義し、`stepCountIs` / `hasToolCall` のファクトリ関数で生成
  - 注意点: クラスベースではなく関数ベースで実現しており、TypeScript の第一級関数を活かした軽量な Strategy

- **Decorator / Middleware パターン** (分類: 構造)
  - 解決する問題: モデルの振る舞いを非侵入的にカスタマイズしたい
  - 適用条件: 既存のインターフェースを変えずに機能を追加・変更したい場合
  - コード例: `packages/ai/src/middleware/wrap-language-model.ts:22-38` — `wrapLanguageModel` がミドルウェアのチェーンを構築
  - 注意点: 複数ミドルウェアの適用順序（reverse 後に reduce）に注意が必要

- **Adapter パターン** (分類: 構造)
  - 解決する問題: Zod v3 / v4 / Standard Schema など異なるスキーマライブラリのインターフェースを統一したい
  - 適用条件: 同じ概念の複数実装を統一インターフェースで扱いたい場合
  - コード例: `packages/provider-utils/src/schema.ts:132-144` — `asSchema` が `FlexibleSchema` を内部の `Schema` 型に正規化
  - 注意点: `LazySchema` による遅延初期化を含む点が典型的な Adapter と異なる

## Good Patterns

- **デストラクチャリングによる段階的プロモーション**: `experimental_output, output = experimental_output` パターンにより、旧名・新名の両方をランタイムコスト0で同時サポートする。型定義は `@deprecated` で移行を案内し、コードモジュール（`@ai-sdk/codemod`）で自動移行も提供する。
  ```typescript
  // packages/ai/src/generate-text/generate-text.ts:565-572
  experimental_output,
  output = experimental_output,
  experimental_activeTools,
  activeTools = experimental_activeTools,
  ```

- **never 型による排他的パラメータ**: `{ prompt: string; messages?: never } | { messages: Array<ModelMessage>; prompt?: never }` のように `never` 型を使うことで、TypeScript コンパイラが不正な組み合わせを検出する。ランタイムバリデーションと合わせて多層防御を実現。
  ```typescript
  // packages/ai/src/prompt/prompt.ts:21-42
  | { prompt: string | Array<ModelMessage>; messages?: never; }
  | { messages: Array<ModelMessage>; prompt?: never; }
  ```

- **結果オブジェクトのコンビニエンスアクセサ**: `GenerateImageResult` が `images`（配列）と `image`（最初の要素へのショートカット）の両方を提供するように、最も一般的なユースケースに対するショートカットを用意する。
  ```typescript
  // packages/ai/src/generate-image/generate-image.ts:291-294
  get image() {
    return this.images[0];
  }
  ```

- **Symbol マーカーによる instanceof 代替**: エラー型に `Symbol.for` ベースのマーカーを埋め込み、`isInstance` 静的メソッドで判定する。バンドル重複や異なるパッケージバージョンでも正しく動作する `instanceof` 代替。
  ```typescript
  // packages/ai/src/error/no-object-generated-error.ts:6-8,67-69
  const marker = `vercel.ai.error.${name}`;
  const symbol = Symbol.for(marker);
  // ...
  static isInstance(error: unknown): error is NoObjectGeneratedError {
    return AISDKError.hasMarker(error, marker);
  }
  ```

## Anti-Patterns / 注意点

- **コールバック内エラーの黙殺**: `onStart` コールバックのエラーを `catch (_ignored)` で無視している。ユーザーのコールバック内バグが検出されにくくなる。
  ```typescript
  // Bad: packages/ai/src/generate-text/generate-text.ts:813-815
  } catch (_ignored) {
    // Errors in callbacks should not break the generation flow.
  }
  ```
  ```typescript
  // Better: 開発モードではログ出力する / onError コールバックに委譲する
  } catch (error) {
    onError?.(error);
    if (process.env.NODE_ENV !== 'production') {
      console.warn('Callback error:', error);
    }
  }
  ```

- **experimental_ の際限なき増殖**: ひとつの関数に `experimental_context`, `experimental_include`, `experimental_onStart`, `experimental_onStepStart`, `experimental_onToolCallStart`, `experimental_onToolCallFinish` と6つ以上の `experimental_` パラメータがあると、どれが安定化に近いか判断しにくくなる。
  ```typescript
  // Bad: 多数の experimental_ が入り混じった関数シグネチャ
  generateText({
    experimental_context,
    experimental_include,
    experimental_onStart,
    experimental_onStepStart,
    experimental_onToolCallStart,
    experimental_onToolCallFinish,
    // ...
  });
  ```
  ```typescript
  // Better: experimental を options オブジェクトにグループ化する
  generateText({
    experimental: { context, include, onStart, onStepStart },
    // ...
  });
  ```

## 導出ルール

- `[MUST]` 公開 API に不安定な機能を追加する際は、命名規約によるプレフィックス（例: `experimental_`）で安定度を明示し、安定化時にはプレフィックスなし版を追加して旧名を `@deprecated` にする
  - 根拠: AI SDK の全 experimental_ API がこのパターンに従い、`versioning.mdx` でポリシーとして明文化されている

- `[MUST]` プロバイダ固有の拡張はコア型に `Record<string, JSONObject>` 型の名前空間付きオプションとして集約し、バリデーションはプロバイダ側に委譲する
  - 根拠: `ProviderOptions` 型と `parseProviderOptions` 関数がこの分離を実現し、コア API を変更せずにプロバイダ機能を追加できている

- `[SHOULD]` 同一ドメインの同期/ストリーミング API はオプション構造と結果型のプロパティ名を統一し、モード切り替え時の学習コストを最小化する
  - 根拠: `generateText` と `streamText` が `CallSettings & Prompt` を共有し、結果型も `text`, `toolCalls`, `usage` 等を統一

- `[SHOULD]` 排他的なパラメータは `never` 型で型レベルの排他制約を設け、加えてランタイムバリデーションで多層防御する
  - 根拠: `Prompt` 型が `prompt?: never` / `messages?: never` の union で排他性を表現し、`standardizePrompt` でランタイムにもチェック

- `[SHOULD]` 高レベル API 関数には `_internal` パラメータで非決定的要素（ID 生成、現在時刻等）を注入できる接合点を設け、テスト容易性を確保する
  - 根拠: `generateText`, `generateObject`, `streamText`, `streamObject` が全て `_internal` パラメータを持つ

- `[SHOULD]` ジェネリクスの推論ソースを制御するために `NoInfer<T>` を使い、意図しないパラメータから型が推論されることを防ぐ
  - 根拠: `generateText` の `toolChoice`, `activeTools`, `prepareStep` 等が全て `NoInfer<TOOLS>` を使い、`tools` のみを推論元にしている

- `[AVOID]` ライフサイクルコールバック内のエラーを完全に無視してはならない。少なくとも開発モードでの警告出力またはエラーハンドラへの委譲を行う
  - 根拠: `generate-text.ts:813-815` でコールバックエラーを `_ignored` で黙殺しており、デバッグが困難になる

## 適用チェックリスト

- [ ] 不安定な API に `experimental_` 等のプレフィックスを付けているか。安定化時のプロモーション手順（非プレフィックス版追加 + @deprecated）を定義しているか
- [ ] 関数パラメータを共通設定と固有設定に分離し、intersection 型で合成しているか
- [ ] プロバイダ/プラグイン固有の機能を名前空間付きオプション（`Record<string, JSONObject>`）として集約し、コア型から分離しているか
- [ ] 同期/ストリーミング等の対称的 API ペアがオプション構造と結果プロパティ名を統一しているか
- [ ] 排他的パラメータが型レベル（`never` 型）とランタイムの両方で検証されているか
- [ ] テスト時に非決定的要素をモック可能な接合点（`_internal` パラメータ等）が用意されているか
- [ ] エラー型に `Symbol.for` ベースのマーカーを使い、バンドル重複環境でも正しく判定できるか
- [ ] ジェネリクスの推論ソースが意図通りに制御されているか（`NoInfer<T>` の活用）
- [ ] コードモジュール等による自動マイグレーションパスが提供されているか
