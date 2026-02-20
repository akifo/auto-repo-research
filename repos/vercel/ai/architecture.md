# architecture

> リポジトリ: vercel/ai
> 分析日: 2026-02-20

## 概要

Vercel AI SDK の 4 層プロバイダーアーキテクチャ（Spec → Utils → Provider → Core）を分析する。
このアーキテクチャは 30 以上の AI プロバイダーを単一のインターフェースで統一し、プロバイダーの追加・変更がコア SDK に一切影響しない設計を実現している。
レイヤー間の依存方向が厳密に一方向（上位→下位のみ）で、各レイヤーの責務が明確に分離されている点が注目に値する。

## 背景にある原則

- **インターフェース分離による依存逆転**: 最下層の `@ai-sdk/provider` パッケージが型定義のみを持ち、実装を一切含まない。プロバイダー実装もコア SDK もこの仕様に依存する形になっており、具象実装間の直接依存が発生しない。`@ai-sdk/provider` の `dependencies` は `json-schema` のみで、ランタイム依存が事実上ゼロである（`packages/provider/package.json`）。

- **バージョン付き仕様による後方互換性**: すべてのモデルインターフェースに `specificationVersion: 'v2' | 'v3'` を持たせ、判別共用体（discriminated union）で処理を分岐する。これにより、既存プロバイダーを壊さずにインターフェースを進化させられる。`packages/ai/src/model/as-language-model-v3.ts` で v2 → v3 のアダプタを Proxy で実現している。

- **共有ユーティリティによるボイラープレート排除**: API 呼び出し、エラーハンドリング、設定読み込みといった全プロバイダー共通の処理を `@ai-sdk/provider-utils` に集約し、各プロバイダーはビジネスロジック（リクエスト変換・レスポンスパース）のみに集中する。30 以上のプロバイダーが `postJsonToApi`, `loadApiKey`, `createJsonErrorResponseHandler` 等を共有している。

- **内部メソッドの意図的な隠蔽（do プレフィックス）**: モデルインターフェースのメソッドに `doGenerate`, `doStream`, `doEmbed` という `do` プレフィックスを付けることで、ユーザーの直接呼び出しを抑止し、コア SDK 経由のみで使われる設計を明示している（`packages/provider/src/language-model/v3/language-model-v3.ts:43-44` のコメント参照）。

## 実例と分析

### レイヤー構造と依存グラフ

4 層の依存関係は厳密に一方向である:

```
Layer 4: Core SDK (ai)
  ↓ depends on
Layer 3: Provider implementations (@ai-sdk/openai, @ai-sdk/anthropic, ...)
  ↓ depends on
Layer 2: Shared utilities (@ai-sdk/provider-utils)
  ↓ depends on
Layer 1: Specification interfaces (@ai-sdk/provider)
```

各パッケージの `package.json` の `dependencies` がこの構造を裏付ける:

- `@ai-sdk/provider`: 外部依存は `json-schema` のみ。他の `@ai-sdk/*` への依存なし
- `@ai-sdk/provider-utils`: `@ai-sdk/provider` にのみ依存
- `@ai-sdk/openai`: `@ai-sdk/provider` と `@ai-sdk/provider-utils` に依存
- `ai` (Core): `@ai-sdk/provider` と `@ai-sdk/provider-utils` に依存

注目すべきは、Core SDK (`ai`) がプロバイダー実装パッケージ（`@ai-sdk/openai` 等）に**依存しない**点である。Core はインターフェース型のみを通じてプロバイダーと通信する。

### 仕様のバージョニング戦略

すべてのモデル型が `specificationVersion` を判別フィールドとして持つ:

```typescript
// LanguageModelV3: specificationVersion: 'v3'
// LanguageModelV2: specificationVersion: 'v2'
// EmbeddingModelV3: specificationVersion: 'v3'
// ImageModelV3: specificationVersion: 'v3'
// SpeechModelV3: specificationVersion: 'v3'
```

Core SDK 側では Proxy ベースのアダプタで旧バージョンを透過的に変換する:

```typescript
// packages/ai/src/model/as-language-model-v3.ts:27-53
return new Proxy(model, {
  get(target, prop: keyof LanguageModelV2) {
    switch (prop) {
      case "specificationVersion":
        return "v3";
      case "doGenerate":
        return async (...args) => {
          const result = await target.doGenerate(...args);
          return {
            ...result,
            finishReason: convertV2FinishReasonToV3(result.finishReason),
            usage: convertV2UsageToV3(result.usage),
          };
        };
        // ...
    }
  },
}) as unknown as LanguageModelV3;
```

### プロバイダーファクトリパターンの一貫性

全プロバイダーが同一の構造を踏襲する:

1. `create<Provider>()` ファクトリ関数でプロバイダーインスタンスを生成
2. プロバイダーインスタンスは callable（関数として呼び出し可能）かつ `ProviderV3` を実装
3. デフォルトインスタンスを `export const <name> = create<Provider>()` でエクスポート

### プロバイダーオプションによる拡張性

仕様インターフェースの `providerOptions` フィールドと `parseProviderOptions` ユーティリティにより、プロバイダー固有の機能をコア仕様を変更せずに追加できる。各プロバイダーは Zod スキーマでオプションを定義し、型安全にパースする。

### Symbol ベースのエラー識別

`instanceof` はパッケージバージョンが異なると壊れるため、`Symbol.for()` でグローバルに一意なマーカーを使い、パッケージバージョンをまたいでも安全にエラー型を判定できるようにしている。

## コード例

### Layer 1: 仕様インターフェース（型定義のみ、実装なし）

```typescript
// packages/provider/src/language-model/v3/language-model-v3.ts:8-61
export type LanguageModelV3 = {
  readonly specificationVersion: "v3";
  readonly provider: string;
  readonly modelId: string;
  supportedUrls: PromiseLike<Record<string, RegExp[]>> | Record<string, RegExp[]>;

  // "do" prefix to prevent accidental direct usage by the user
  doGenerate(options: LanguageModelV3CallOptions): PromiseLike<LanguageModelV3GenerateResult>;
  doStream(options: LanguageModelV3CallOptions): PromiseLike<LanguageModelV3StreamResult>;
};
```

### Layer 2: 共有ユーティリティ（プロバイダー横断の共通処理）

```typescript
// packages/provider-utils/src/post-to-api.ts:77-107
export const postToApi = async <T>({
  url, headers = {}, body,
  successfulResponseHandler, failedResponseHandler,
  abortSignal, fetch = getOriginalFetch(),
}: { /* ... */ }) => {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: withUserAgentSuffix(headers, `ai-sdk/provider-utils/${VERSION}`, ...),
      body: body.content,
      signal: abortSignal,
    });
    const responseHeaders = extractResponseHeaders(response);
    if (!response.ok) {
      // failedResponseHandler に委譲
    }
    return await successfulResponseHandler({ response, url, requestBodyValues: body.values });
  } catch (error) {
    throw handleFetchError({ error, url, requestBodyValues: body.values });
  }
};
```

### Layer 3: プロバイダー実装（仕様への適合 + 固有ロジック）

```typescript
// packages/openai/src/openai-provider.ts:143-265
export function createOpenAI(options: OpenAIProviderSettings = {}): OpenAIProvider {
  const baseURL = withoutTrailingSlash(
    loadOptionalSetting({ settingValue: options.baseURL, environmentVariableName: "OPENAI_BASE_URL" }),
  ) ?? "https://api.openai.com/v1";

  const getHeaders = () =>
    withUserAgentSuffix({
      Authorization: `Bearer ${
        loadApiKey({ apiKey: options.apiKey, environmentVariableName: "OPENAI_API_KEY", description: "OpenAI" })
      }`,
      ...options.headers,
    }, `ai-sdk/openai/${VERSION}`);

  const createChatModel = (modelId) =>
    new OpenAIChatLanguageModel(modelId, {
      provider: `${providerName}.chat`,
      url: ({ path }) => `${baseURL}${path}`,
      headers: getHeaders,
      fetch: options.fetch,
    });

  const provider = function(modelId) {
    return createLanguageModel(modelId);
  };
  provider.specificationVersion = "v3" as const;
  provider.languageModel = createLanguageModel;
  provider.chat = createChatModel;
  // ...
  return provider as OpenAIProvider;
}
```

### Layer 4: Core SDK（仕様インターフェースのみに依存）

```typescript
// packages/ai/src/model/resolve-model.ts:24-42
export function resolveLanguageModel(model: LanguageModel): LanguageModelV3 {
  if (typeof model !== 'string') {
    if (model.specificationVersion !== 'v3' && model.specificationVersion !== 'v2') {
      throw new UnsupportedModelVersionError({ ... });
    }
    return asLanguageModelV3(model);
  }
  return getGlobalProvider().languageModel(model);
}
```

### Symbol ベースのエラー判定

```typescript
// packages/provider/src/errors/ai-sdk-error.ts:1-62
const marker = "vercel.ai.error";
const symbol = Symbol.for(marker);

export class AISDKError extends Error {
  private readonly [symbol] = true;

  static isInstance(error: unknown): error is AISDKError {
    return AISDKError.hasMarker(error, marker);
  }

  protected static hasMarker(error: unknown, marker: string): boolean {
    const markerSymbol = Symbol.for(marker);
    return (
      error != null && typeof error === "object"
      && markerSymbol in error && error[markerSymbol] === true
    );
  }
}
```

### エラー応答ハンドラの再利用パターン

```typescript
// packages/openai/src/openai-error.ts:1-22
export const openaiFailedResponseHandler = createJsonErrorResponseHandler({
  errorSchema: openaiErrorDataSchema,
  errorToMessage: data => data.error.message,
});

// packages/anthropic/src/anthropic-error.ts:1-26
export const anthropicFailedResponseHandler = createJsonErrorResponseHandler({
  errorSchema: anthropicErrorDataSchema,
  errorToMessage: data => data.error.message,
});
```

## パターンカタログ

- **Abstract Factory** (生成)
  - 解決する問題: 30+ プロバイダーの生成を統一し、利用側をプロバイダー実装から切り離す
  - 適用条件: 同一インターフェースを持つ実装群をファミリーとして生成する必要がある場合
  - コード例: `packages/openai/src/openai-provider.ts:143` (`createOpenAI`)、`packages/anthropic/src/anthropic-provider.ts:90` (`createAnthropic`)
  - 注意点: 各ファクトリが返すオブジェクトは callable かつインターフェース準拠という二重の役割を持つ

- **Adapter / Proxy** (構造)
  - 解決する問題: 仕様バージョンの差異を吸収し、Core SDK が最新バージョンのみを扱えるようにする
  - 適用条件: インターフェースに破壊的変更を加えつつ、旧バージョンの互換性を維持する場合
  - コード例: `packages/ai/src/model/as-language-model-v3.ts:27-53`
  - 注意点: Proxy ベースのため、型安全性が部分的に失われる（`as unknown as LanguageModelV3` キャスト）

- **Decorator / Middleware** (振る舞い)
  - 解決する問題: モデルの振る舞いを実装を変更せずに拡張する（ログ、キャッシュ、パラメータ変換等）
  - 適用条件: 横断的関心事をモデルに追加したい場合
  - コード例: `packages/ai/src/middleware/wrap-language-model.ts:22-38`
  - 注意点: ミドルウェアの適用順序が重要。配列の先頭が最初に入力を変換し、末尾がモデルに最も近い

- **Strategy** (振る舞い)
  - 解決する問題: エラーレスポンスの解析方法をプロバイダーごとに差し替える
  - 適用条件: 同じ処理フローで部分的なアルゴリズムだけが異なる場合
  - コード例: `packages/provider-utils/src/response-handler.ts:17-81` (`createJsonErrorResponseHandler`)
  - 注意点: スキーマとメッセージ抽出関数の 2 点のみを差し替えれば新プロバイダーのエラーハンドリングが完成する

- **Service Locator / Registry** (構造)
  - 解決する問題: 文字列 ID からプロバイダー・モデルを動的に解決する
  - 適用条件: 設定ファイルや UI からモデルを選択する場合
  - コード例: `packages/ai/src/registry/provider-registry.ts:94-125` (`createProviderRegistry`)
  - 注意点: 型安全性を Template Literal Types で維持している（`${KEY}${SEPARATOR}${string}`）

## Good Patterns

- **型のみのパッケージで依存逆転を実現**: `@ai-sdk/provider` はランタイム依存をほぼゼロに保ち、純粋なインターフェース定義として機能する。これにより、プロバイダー実装とコア SDK の間に安定した契約が成立し、いずれの側も独立してリリースできる。

```typescript
// packages/provider/package.json
"dependencies": {
  "json-schema": "^0.4.0"  // 型定義のみ
}
```

- **Warning によるグレースフルデグラデーション**: サポートしていない機能がリクエストされた場合、例外を投げるのではなく `warnings` 配列に記録して処理を続行する。ユーザーは結果を受け取りつつ、何が無視されたかを確認できる。

```typescript
// packages/openai/src/chat/openai-chat-language-model.ts:100-102
if (topK != null) {
  warnings.push({ type: "unsupported", feature: "topK" });
}
```

- **設定値の解決チェーン（明示的パラメータ → 環境変数）**: `loadApiKey` と `loadSetting` が一貫した優先順位で設定値を解決し、不足時には何が必要でどう設定すべきかを伝えるエラーメッセージを生成する。

```typescript
// packages/provider-utils/src/load-api-key.ts:3-45
export function loadApiKey({ apiKey, environmentVariableName, description }) {
  if (typeof apiKey === "string") return apiKey;
  // ... 環境変数から読み込み
  // ... 不在時は解決方法を含むエラーメッセージ
}
```

- **providerOptions による拡張ポイント**: 仕様インターフェースの `CallOptions` に `providerOptions: Record<string, JSONObject>` を設け、プロバイダー固有の機能をコア仕様を変更せずにパススルーする。Zod スキーマで型安全にパースされる。

```typescript
// packages/provider-utils/src/parse-provider-options.ts:5-32
export async function parseProviderOptions<OPTIONS>({
  provider, providerOptions, schema,
}) {
  if (providerOptions?.[provider] == null) return undefined;
  const parsed = await safeValidateTypes({ value: providerOptions[provider], schema });
  if (!parsed.success) throw new InvalidArgumentError({ ... });
  return parsed.value;
}
```

## Anti-Patterns / 注意点

- **Proxy アダプタの型安全性の喪失**: v2 → v3 変換で `as unknown as LanguageModelV3` キャストが使われており、Proxy の内部で型チェックが効かない。新しいバージョンが追加されるたびにアダプタの保守負荷が増大する。

```typescript
// Bad: 型安全性が失われるキャスト
return new Proxy(model, {/* ... */}) as unknown as LanguageModelV3;

// Better: 明示的なアダプタクラスで全フィールドをマッピング
class V2ToV3Adapter implements LanguageModelV3 {
  readonly specificationVersion = "v3";
  constructor(private model: LanguageModelV2) {}
  async doGenerate(options) {
    const result = await this.model.doGenerate(options);
    return { ...result, finishReason: convertFinishReason(result.finishReason) };
  }
}
```

- **callable + オブジェクト代入によるインターフェース実装**: プロバイダーファクトリが関数にプロパティを動的に代入し `as OpenAIProvider` でキャストする。プロパティの追加漏れがコンパイル時に検出されない可能性がある。

```typescript
// Bad: プロパティ代入 + キャスト
const provider = function(modelId) {
  return createLanguageModel(modelId);
};
provider.specificationVersion = "v3" as const;
provider.languageModel = createLanguageModel;
return provider as OpenAIProvider;

// Better: satisfies で型チェックを強制
const provider = Object.assign(
  (modelId: string) => createLanguageModel(modelId),
  { specificationVersion: "v3" as const, languageModel: createLanguageModel /* ... */ },
) satisfies OpenAIProvider;
```

## 導出ルール

- `[MUST]` インターフェース定義パッケージはランタイム実装を含まず、型とエラー定義のみとする
  - 根拠: `@ai-sdk/provider` が実装ゼロで 30+ プロバイダーの安定した契約として機能している（`packages/provider/package.json` の dependencies が `json-schema` のみ）

- `[MUST]` プラグイン/プロバイダーのインターフェースにバージョン識別フィールドを含め、判別共用体で処理を分岐する
  - 根拠: `specificationVersion: 'v2' | 'v3'` により、Core SDK が旧バージョンのプロバイダーを Adapter パターンで透過的に扱える（`packages/ai/src/model/resolve-model.ts:27-38`）

- `[MUST]` モノレポ内のパッケージ間依存は一方向のみとし、循環依存を作らない
  - 根拠: Spec ← Utils ← Provider、Spec ← Utils ← Core という DAG 構造により、各レイヤーが独立してテスト・リリース可能

- `[SHOULD]` プラグイン実装者が毎回書くボイラープレート（API 呼び出し、エラー処理、設定読み込み）は共有ユーティリティレイヤーに集約する
  - 根拠: `postJsonToApi`, `loadApiKey`, `createJsonErrorResponseHandler` を 30+ プロバイダーが共有し、各プロバイダーは差分（リクエスト変換・レスポンスパース）のみを実装（`packages/openai/src/openai-error.ts` 等）

- `[SHOULD]` サポートしない機能は例外ではなく警告で報告し、処理を続行する（グレースフルデグラデーション）
  - 根拠: `warnings` 配列パターンにより、プロバイダー間の機能差をユーザーに透過的に伝えつつ処理を中断しない（`packages/openai/src/chat/openai-chat-language-model.ts:100-102`）

- `[SHOULD]` プラグイン固有の拡張パラメータは、コアインターフェースに `Record<string, unknown>` 型の拡張ポイントを設けてパススルーする
  - 根拠: `providerOptions` フィールドにより、OpenAI の `reasoningEffort` や Anthropic の `cacheControl` をコア仕様を変更せずに追加できる（`packages/provider/src/language-model/v3/language-model-v3-call-options.ts:124`）

- `[SHOULD]` パッケージバージョンをまたぐ型判定には `Symbol.for()` ベースのマーカーパターンを使い、`instanceof` に依存しない
  - 根拠: `AISDKError.isInstance` が `Symbol.for(marker)` で判定することで、異なるバージョンの `@ai-sdk/provider` が共存しても正しく動作する（`packages/provider/src/errors/ai-sdk-error.ts:5-61`）

- `[AVOID]` 内部実装メソッドをユーザー向け API と同じ名前にする。`do` プレフィックス等で「直接呼ぶべきではない」ことを命名で示す
  - 根拠: `doGenerate` / `doStream` の `do` プレフィックスにより、ユーザーが Core SDK（`generateText` / `streamText`）を経由すべきことが命名から明確になる（`packages/provider/src/language-model/v3/language-model-v3.ts:43-44`）

## 適用チェックリスト

- [ ] プラグイン/プロバイダーシステムで、インターフェース定義を実装から分離した専用パッケージにしているか
- [ ] インターフェースにバージョン識別フィールドがあり、破壊的変更時にアダプタで旧バージョンを吸収できるか
- [ ] パッケージ間の依存グラフが DAG（有向非巡回グラフ）になっているか。循環依存がないか
- [ ] プラグイン実装者が毎回書くボイラープレート（HTTP 呼び出し、エラー処理等）を共有レイヤーに集約しているか
- [ ] プラグイン固有の拡張パラメータを、コアインターフェースを変更せずにパススルーする仕組みがあるか
- [ ] サポートしない機能をエラーではなく警告で報告し、処理を続行するパスがあるか
- [ ] 内部メソッドと公開 API が命名で区別されているか（`do` プレフィックス、`_` プレフィックス等）
- [ ] パッケージバージョンをまたぐ型判定で `instanceof` ではなく `Symbol.for()` マーカーを使っているか
