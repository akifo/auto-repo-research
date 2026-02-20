# adapter-implementation-patterns

> リポジトリ: vercel/ai
> 分析日: 2026-02-20

## 概要

Vercel AI SDK は 30 以上の AI プロバイダーを統一的なインターフェースで扱うための、階層化されたアダプターアーキテクチャを採用している。`@ai-sdk/provider`（仕様）、`@ai-sdk/provider-utils`（共有ユーティリティ）、`@ai-sdk/openai-compatible`（OpenAI 互換基盤）の三層構造により、新プロバイダー追加時のボイラープレートを最小化しつつ、API 差異への柔軟な対応を可能にしている。特に、同じパターンを 30 以上のパッケージで一貫して適用しているスケーラビリティと、「互換レイヤーの上に薄いカスタマイズを乗せる」戦略が注目に値する。

## 背景にある原則

- **仕様と実装の分離（Specification-Implementation Split）**: `@ai-sdk/provider` パッケージが `LanguageModelV3`、`ProviderV3` 等の型仕様のみを定義し、実装は一切持たない。これにより仕様のバージョニング（v2 → v3）が実装と独立して行え、破壊的変更の影響範囲を限定できる。根拠: `packages/provider/src/language-model/v2/` と `v3/` が並存する構造。

- **防御的スキーマ設計（Defensive Schema Parsing）**: 外部 API レスポンスの Zod スキーマで全フィールドに `.nullish()` を使い、API 仕様変更に対する耐性を最大化する。コメント "limited version of the schema, focussed on what is needed for the implementation / this approach limits breakages when the API changes" が明示的に設計意図を述べている。根拠: `packages/deepseek/src/chat/deepseek-chat-api-types.ts:89-90`。

- **共通化の段階的適用（Graduated Commonality）**: 全プロバイダーに共通するロジック（API キー読み込み、ヘッダー構成、URL 正規化）は `provider-utils` に、OpenAI 互換 API のプロバイダーに共通するロジック（チャット完了、ストリーミング、エラーハンドリング）は `openai-compatible` に配置する。カスタム API を持つプロバイダー（Anthropic、Google）は `provider-utils` のみに依存し、独自の言語モデルクラスを実装する。根拠: `contributing/provider-architecture.md` の依存グラフ。

- **「do」プレフィックスによる内部 API 境界の明示**: `doGenerate`、`doStream` のように、直接呼び出しを意図しないメソッドに `do` プレフィックスを付けることで、パブリック API と内部実装の境界を命名規則で表現する。根拠: `packages/provider/src/language-model/v2/language-model-v2.ts:49-52` のコメント "Naming: 'do' prefix to prevent accidental direct usage"。

## 実例と分析

### 三層アダプター構造

プロバイダーの実装パターンは、API 互換性のレベルによって 3 種類に分類される。

**Type A: OpenAI 互換の薄いラッパー（Cerebras, TogetherAI）**
`@ai-sdk/openai-compatible` の `OpenAICompatibleChatLanguageModel` をそのまま使い、エラースキーマや `transformRequestBody` のカスタマイズのみ行う。プロバイダー固有のコードは最小限。

**Type B: 独自言語モデルクラス + 共有ユーティリティ（Groq, DeepSeek）**
OpenAI 互換の API を持つが、独自の reasoning 処理やストリーミング挙動があるため、`LanguageModelV3` を直接実装する。ただし `postJsonToApi`、`createJsonResponseHandler` 等の `provider-utils` ユーティリティは活用する。

**Type C: 完全カスタム実装（Anthropic, Google）**
API フォーマットが根本的に異なるため、メッセージ変換・レスポンス解析・エラーハンドリング全てを独自実装する。共通化は `provider-utils` のヘルパー関数レベルにとどまる。

### プロバイダーファクトリの定形パターン

全 30+ プロバイダーが同一の「ファクトリ関数 + 関数オブジェクト」パターンに従っている。

1. `createXxx(options)` ファクトリ関数がプロバイダーオブジェクトを返す
2. プロバイダーオブジェクト自体が `(modelId) => LanguageModel` として呼び出し可能
3. `.languageModel()`, `.embeddingModel()`, `.imageModel()` 等の名前付きメソッドを持つ
4. サポートしないモデルタイプは `NoSuchModelError` を throw する
5. デフォルトインスタンスを `export const xxx = createXxx()` でエクスポートする

### Provider Options の Zod スキーマ定義

各プロバイダーは provider-specific なオプションを Zod スキーマで定義し、`parseProviderOptions` で型安全に解析する。これにより利用者側の `providerOptions` に任意のプロバイダー固有設定を渡せる。

### ヘッダー構成の一貫パターン

全プロバイダーが `getHeaders` をサンクとして定義し、遅延評価で API キーを読み込む。`withUserAgentSuffix` で `ai-sdk/<provider>/<version>` 形式の User-Agent を付加する。

## コード例

Type A プロバイダー（Cerebras）は `OpenAICompatibleChatLanguageModel` を直接利用する。

```typescript
// packages/cerebras/src/cerebras-provider.ts:94-103
const createLanguageModel = (modelId: CerebrasChatModelId) => {
  return new OpenAICompatibleChatLanguageModel(modelId, {
    provider: `cerebras.chat`,
    url: ({ path }) => `${baseURL}${path}`,
    headers: getHeaders,
    fetch: options.fetch,
    errorStructure: cerebrasErrorStructure,
    supportsStructuredOutputs: true,
  });
};
```

Type B プロバイダー（DeepSeek）は独自のクラスで `LanguageModelV3` を実装する。

```typescript
// packages/deepseek/src/chat/deepseek-chat-language-model.ts:42-67
export type DeepSeekChatConfig = {
  provider: string;
  headers: () => Record<string, string | undefined>;
  url: (options: { modelId: string; path: string }) => string;
  fetch?: FetchFunction;
};

export class DeepSeekChatLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3';
  readonly modelId: DeepSeekChatModelId;
  readonly supportedUrls = {};
  private readonly config: DeepSeekChatConfig;
  private readonly failedResponseHandler: ResponseHandler<APICallError>;

  constructor(modelId: DeepSeekChatModelId, config: DeepSeekChatConfig) {
    this.modelId = modelId;
    this.config = config;
    this.failedResponseHandler = createJsonErrorResponseHandler({
      errorSchema: deepSeekErrorSchema,
      errorToMessage: (error) => error.error.message,
    });
  }
```

外部 API レスポンススキーマには全フィールドに `.nullish()` を使う。

```typescript
// packages/deepseek/src/chat/deepseek-chat-api-types.ts:89-117
// limited version of the schema, focussed on what is needed for the implementation
// this approach limits breakages when the API changes and increases efficiency
export const deepseekChatResponseSchema = z.object({
  id: z.string().nullish(),
  created: z.number().nullish(),
  model: z.string().nullish(),
  choices: z.array(
    z.object({
      message: z.object({
        role: z.literal("assistant").nullish(),
        content: z.string().nullish(),
        reasoning_content: z.string().nullish(),
        tool_calls: z.array(/* ... */).nullish(),
      }),
      finish_reason: z.string().nullish(),
    }),
  ),
  usage: tokenUsageSchema,
});
```

モデル ID 型はリテラルユニオン + `(string & {})` で自動補完と拡張性を両立する。

```typescript
// packages/deepseek/src/chat/deepseek-chat-options.ts:4-7
export type DeepSeekChatModelId =
  | "deepseek-chat"
  | "deepseek-reasoner"
  | (string & {});
```

サポートしないモデルタイプは `NoSuchModelError` で明示的に拒否する。

```typescript
// packages/groq/src/groq-provider.ts:125-131
provider.embeddingModel = (modelId: string) => {
  throw new NoSuchModelError({ modelId, modelType: "embeddingModel" });
};
provider.textEmbeddingModel = provider.embeddingModel;
provider.imageModel = (modelId: string) => {
  throw new NoSuchModelError({ modelId, modelType: "imageModel" });
};
```

## パターンカタログ

- **Adapter パターン** (分類: 構造)
  - 解決する問題: API フォーマットが異なる複数の外部サービスを統一的なインターフェースで扱う
  - 適用条件: 同じ概念（言語モデル、埋め込みモデル等）を異なるプロトコルで提供するサービスが複数存在する
  - コード例: `packages/provider/src/language-model/v3/language-model-v3.ts` が統一インターフェース、各プロバイダーの `*-language-model.ts` がアダプター
  - 注意点: アダプターの粒度が粗すぎるとプロバイダー固有の能力を表現できない。AI SDK は `providerOptions` と `providerMetadata` でエスケープハッチを提供している

- **Abstract Factory パターン** (分類: 生成)
  - 解決する問題: 関連するオブジェクト群（言語モデル、埋め込みモデル、画像モデル）を一貫した方法で生成する
  - 適用条件: プロバイダーごとに生成可能なモデル種別が異なり、関連モデルのファミリーを提供する必要がある
  - コード例: `packages/provider/src/provider/v3/provider-v3.ts` が抽象ファクトリ、`createGroq()` / `createAnthropic()` 等が具象ファクトリ
  - 注意点: サポートしないモデルタイプには `NoSuchModelError` を throw する（`null` や空実装を返さない）

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: エラー解析やメタデータ抽出の処理を、プロバイダーごとに差し替え可能にする
  - 適用条件: 処理の大枠は共通だが、特定のステップだけプロバイダーごとに異なる
  - コード例: `ProviderErrorStructure<T>` 型（`packages/openai-compatible/src/openai-compatible-error.ts:20-24`）、`MetadataExtractor` 型（`packages/openai-compatible/src/chat/openai-compatible-metadata-extractor.ts`）
  - 注意点: Strategy は型として定義し、DI で注入する。継承ではなく合成を使う

## Good Patterns

- **`.nullish()` による防御的スキーマ**: 外部 API のレスポンスフィールドに `z.string().nullish()` / `z.number().nullish()` を一貫して使用する。API のマイナーバージョンアップでフィールドが追加・削除されても、パースが壊れない。同時に必要最小限のフィールドだけスキーマに含めることで、不要なフィールドの型変更による破壊も防ぐ。

```typescript
// packages/openai-compatible/src/chat/openai-compatible-chat-language-model.ts:743-780
// "limited version of the schema" というコメントが設計意図を明示
const OpenAICompatibleChatResponseSchema = z.looseObject({
  id: z.string().nullish(),
  created: z.number().nullish(),
  model: z.string().nullish(),
  choices: z.array(z.object({
    message: z.object({
      content: z.string().nullish(),
      reasoning_content: z.string().nullish(),
      // ...
    }),
    finish_reason: z.string().nullish(),
  })),
});
```

- **`(string & {})` によるモデル ID 型**: TypeScript のリテラルユニオンに `| (string & {})` を追加することで、IDE の自動補完を保持しつつ任意の文字列も受け入れる。新しいモデルがリリースされてもパッケージ更新なしに利用できる。

```typescript
// packages/groq/src/groq-chat-options.ts:4-27
export type GroqChatModelId =
  | "gemma2-9b-it"
  | "llama-3.1-8b-instant"
  | "llama-3.3-70b-versatile"
  // ...
  | (string & {});
```

- **FinishReason マッパーの統一構造**: 各プロバイダーが `mapXxxFinishReason` 関数を持ち、プロバイダー固有の終了理由を `LanguageModelV3FinishReason['unified']` に変換する。switch 文の default は常に `'other'` を返し、未知の値に対する安全なフォールバックを保証する。

```typescript
// packages/openai-compatible/src/chat/map-openai-compatible-finish-reason.ts:3-19
export function mapOpenAICompatibleFinishReason(
  finishReason: string | null | undefined,
): LanguageModelV3FinishReason["unified"] {
  switch (finishReason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "content_filter":
      return "content-filter";
    case "function_call":
    case "tool_calls":
      return "tool-calls";
    default:
      return "other";
  }
}
```

- **ヘッダー構成の遅延評価**: `getHeaders` を関数として定義し、呼び出し時に API キーを解決する。これにより、環境変数の読み込みをリクエスト時まで遅延でき、インスタンス生成時点での環境変数の有無に依存しない。

```typescript
// packages/groq/src/groq-provider.ts:77-88
const getHeaders = () =>
  withUserAgentSuffix(
    {
      Authorization: `Bearer ${
        loadApiKey({
          apiKey: options.apiKey,
          environmentVariableName: "GROQ_API_KEY",
          description: "Groq",
        })
      }`,
      ...options.headers,
    },
    `ai-sdk/groq/${VERSION}`,
  );
```

## Anti-Patterns / 注意点

- **FinishReason マッパーの重複実装**: `mapOpenAICompatibleFinishReason` と `mapGroqFinishReason` が完全に同一のコードである。Groq は OpenAI 互換 API を使っているにもかかわらず、独自のマッパーを定義している。共通処理を再利用せず各プロバイダーでコピーすると、バグ修正が全箇所に波及しないリスクがある。

```typescript
// Bad: 完全に同一の関数を別パッケージにコピー
// packages/openai-compatible/src/chat/map-openai-compatible-finish-reason.ts
// packages/groq/src/map-groq-finish-reason.ts
// （内容が完全一致）

// Better: 共通の関数を import して使う
import { mapOpenAICompatibleFinishReason } from "@ai-sdk/openai-compatible";
export const mapGroqFinishReason = mapOpenAICompatibleFinishReason;
```

- **`getResponseMetadata` の重複**: `openai-compatible` と `groq` で同一の `getResponseMetadata` 関数が重複している。OpenAI 互換のレスポンスメタデータ抽出は共通化可能だが、パッケージ間の依存を避けるためにコピーされている。トレードオフとして許容されうるが、意図的な判断であることをコメントで示すべき。

```typescript
// Bad: 同一実装が複数パッケージに存在（暗黙のコピー）
// packages/openai-compatible/src/chat/get-response-metadata.ts
// packages/groq/src/get-response-metadata.ts

// Better: provider-utils に共通関数として配置するか、
// コピーの場合はコメントで意図を明示する
// NOTE: Intentionally duplicated to avoid cross-package dependency
```

## 導出ルール

- `[MUST]` 外部 API レスポンスの Zod スキーマではフィールドに `.nullish()` を使い、必要最小限のフィールドだけをスキーマに含める
  - 根拠: AI SDK の 30+ プロバイダーが全てこのパターンを採用しており、"limits breakages when the API changes" とコメントで設計意図を明示している（`deepseek-chat-api-types.ts:89`）

- `[MUST]` アダプターが統一インターフェースの特定の能力をサポートしない場合、`null` や空実装ではなく専用のエラー型を throw する
  - 根拠: 全プロバイダーが `NoSuchModelError` を使い、サポートしないモデルタイプを明示的に拒否している。静かに失敗するとデバッグが困難になる

- `[SHOULD]` アダプターの共通処理を段階的に分離する — 全アダプターに共通するユーティリティ層と、サブセットのアダプターに共通する互換レイヤーを区別する
  - 根拠: AI SDK は `provider-utils`（全プロバイダー共通）と `openai-compatible`（OpenAI 互換サブセット）の二段階で共通化し、カスタム API のプロバイダーが不要な依存を持たない設計にしている

- `[SHOULD]` 列挙型のモデル ID にはリテラルユニオン + `(string & {})` を使い、IDE 補完と将来の拡張性を両立する
  - 根拠: 30+ プロバイダーの全モデル ID 型がこのパターンを採用。新モデルリリース時にパッケージ更新なしで利用可能にする

- `[SHOULD]` ファクトリ関数からデフォルトインスタンスを export し、ゼロコンフィグでの利用と明示的な設定の両方を可能にする
  - 根拠: 全プロバイダーが `export const xxx = createXxx()` パターンを採用し、環境変数からの自動設定読み込みを提供している

- `[SHOULD]` API 認証情報はファクトリ関数の引数（明示的指定）と環境変数（暗黙的指定）の両方をサポートし、`loadApiKey` のような統一ヘルパーで読み込む
  - 根拠: `provider-utils/src/load-api-key.ts` が環境変数フォールバック付きの統一的な API キー読み込みを提供し、全プロバイダーが使用している

- `[AVOID]` レスポンス変換関数（finish reason マッパー、usage コンバーター等）を OpenAI 互換プロバイダー間でコピーペーストする — 共通ユーティリティから再利用するか、コピーの意図をコメントで明示する
  - 根拠: `mapGroqFinishReason` と `mapOpenAICompatibleFinishReason` が完全同一だが、意図的なコピーかどうか不明。修正漏れリスクがある

## 適用チェックリスト

- [ ] 複数の外部サービスを統合する場合、仕様インターフェース（型定義のみ）と実装を別パッケージ/モジュールに分離しているか
- [ ] 外部 API レスポンスのスキーマバリデーションで `.nullish()` を使い、未知フィールドの追加・削除に耐性があるか
- [ ] サポートしない操作に対して専用エラーを throw しているか（`null` や空の結果を返していないか）
- [ ] 共通処理のレイヤー分けが適切か — 「全アダプター共通」と「サブセット共通」を区別しているか
- [ ] 認証情報の読み込みに明示的指定（引数）と暗黙的指定（環境変数）のフォールバックがあるか
- [ ] モデル ID やバリアント型にリテラルユニオン + `(string & {})` を使い、補完と拡張性を両立しているか
- [ ] ファクトリ関数からデフォルトインスタンスを export し、ゼロコンフィグ利用を可能にしているか
- [ ] 各アダプターの変換関数（マッパー、コンバーター）が共通化されているか、コピーの場合はその理由がコメントで明示されているか
