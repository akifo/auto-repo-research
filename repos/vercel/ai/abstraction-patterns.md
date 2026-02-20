# abstraction-patterns

> リポジトリ: vercel/ai
> 分析日: 2026-02-20

## 概要

Vercel AI SDK のプロバイダー抽象化レイヤーを分析する。30以上のAIプロバイダー（OpenAI, Anthropic, Google等）を単一のインターフェースで統合するために、4層アーキテクチャ（Specification → Utilities → Providers → Core）を採用している。注目に値するのは、インターフェースの「バージョンタグ付きの型」による非破壊的進化戦略、`do` プレフィックスによる内部/外部API境界の明示、そしてミドルウェアによる横断的関心事の分離である。

## 背景にある原則

- **契約はデータで、実装は関数で**: モデルインターフェース（`LanguageModelV3` 等）は `type` で定義され、プロバイダーは `interface` で定義される。これにより、30以上のプロバイダーが同一契約を満たしつつ、各自の API 差異を内部に隠蔽できる。根拠: `packages/provider/src/language-model/v3/language-model-v3.ts` がインターフェースではなく `type` で定義されている点。
- **層を超えた依存を禁止し、共通ユーティリティで水平結合する**: `provider` パッケージはインターフェースのみ、`provider-utils` は実装共有ユーティリティ、各プロバイダーはこの2つに依存する。Core（`ai`）はプロバイダーに直接依存しない。これにより、新プロバイダー追加時に Core を変更する必要がない。
- **未サポート機能は隠さず明示する**: プロバイダーがサポートしない機能（例: Anthropic の embedding）は `NoSuchModelError` をスローし、呼び出し時に明確な失敗で表現する。サイレントに `null` を返すのではなく、`UnsupportedFunctionalityError` や `NoSuchModelError` で即座にフィードバックする。根拠: `packages/anthropic/src/anthropic-provider.ts:161-163` など複数のプロバイダーで一貫したパターン。
- **バージョンは型の一部にする**: `specificationVersion: 'v3'` というリテラル型プロパティにより、ランタイムで discriminated union として判別可能にし、破壊的変更なしにインターフェースを進化させる。根拠: `packages/ai/src/model/as-provider-v3.ts` での V2→V3 アダプタ実装。

## 実例と分析

### 4層アーキテクチャによる関心の分離

AI SDK は以下の4層でプロバイダー抽象化を実現している:

1. **Specification層**（`@ai-sdk/provider`）: インターフェース定義のみ。`LanguageModelV3`, `EmbeddingModelV3`, `ProviderV3` 等。実装を一切含まない。
2. **Utilities層**（`@ai-sdk/provider-utils`）: プロバイダー実装が共通で使うヘルパー。`loadApiKey`, `postJsonToApi`, `combineHeaders`, `parseProviderOptions` 等。
3. **Provider層**（`@ai-sdk/openai`, `@ai-sdk/anthropic` 等）: 各 API の差異を吸収する具体実装。
4. **Core層**（`ai`）: `generateText`, `streamText` 等の高レベル API。プロバイダーインターフェースのみに依存。

この設計により、Core を変更せずにプロバイダーを追加でき、53パッケージ規模のモノレポでも各層の独立デプロイが可能になっている。

### ファクトリ関数によるプロバイダー生成の標準化

全プロバイダーが `create<Provider>` ファクトリ関数パターンを採用し、同一の設定項目構造を共有している:

```typescript
// packages/openai/src/openai-provider.ts:143-265
export function createOpenAI(options: OpenAIProviderSettings = {}): OpenAIProvider {
  const baseURL = withoutTrailingSlash(
    loadOptionalSetting({ settingValue: options.baseURL, environmentVariableName: 'OPENAI_BASE_URL' }),
  ) ?? 'https://api.openai.com/v1';

  const getHeaders = () => withUserAgentSuffix(
    { Authorization: `Bearer ${loadApiKey({ ... })}`, ...options.headers },
    `ai-sdk/openai/${VERSION}`,
  );

  // 各モデル種別のファクトリ
  const createChatModel = (modelId) =>
    new OpenAIChatLanguageModel(modelId, {
      provider: `${providerName}.chat`,
      url: ({ path }) => `${baseURL}${path}`,
      headers: getHeaders,
      fetch: options.fetch,
    });
  // ...
}
export const openai = createOpenAI(); // デフォルトインスタンスのエクスポート
```

Anthropic, Groq, DeepSeek 全てが同一パターンを踏襲している。設定項目は `baseURL`, `apiKey`, `headers`, `fetch` を必ず含む。`loadApiKey` ユーティリティにより、引数 > 環境変数の優先順位が全プロバイダーで統一される。

### `do` プレフィックスによる内部API境界の明示

```typescript
// packages/provider/src/language-model/v3/language-model-v3.ts:41-60
/**
 * Naming: "do" prefix to prevent accidental direct usage of the method
 * by the user.
 */
doGenerate(options: LanguageModelV3CallOptions): PromiseLike<LanguageModelV3GenerateResult>;
doStream(options: LanguageModelV3CallOptions): PromiseLike<LanguageModelV3StreamResult>;
```

プロバイダーが実装するメソッドは `doGenerate`/`doStream`/`doEmbed`、ユーザーが呼ぶ高レベル API は `generateText`/`streamText`/`embed`。`do` プレフィックスにより、ユーザーがプロバイダーの低レベルメソッドを誤って直接呼ぶことを名前レベルで抑止している。

### バージョンタグによる非破壊的インターフェース進化

```typescript
// packages/provider/src/language-model/v3/language-model-v3.ts:8-12
export type LanguageModelV3 = {
  readonly specificationVersion: "v3";
  // ...
};
```

```typescript
// packages/ai/src/model/as-provider-v3.ts:8-14
export function asProviderV3(provider: ProviderV2 | ProviderV3): ProviderV3 {
  if ("specificationVersion" in provider && provider.specificationVersion === "v3") {
    return provider;
  }
  const v2Provider: ProviderV2 = provider as ProviderV2;
  return { specificationVersion: "v3" /* ...V2→V3 変換... */ };
}
```

V2 と V3 が共存し、`asProviderV3` アダプタが自動変換を行う。利用者は V2 プロバイダーを渡しても V3 API で使える。リテラル型 `'v3'` を discriminated union のタグとして使うことで、TypeScript の型システムでバージョン判別が可能。

### ミドルウェアによる横断的関心事の合成

```typescript
// packages/ai/src/middleware/wrap-language-model.ts:22-38
export const wrapLanguageModel = ({ model, middleware: middlewareArg }) => {
  return [...asArray(middlewareArg)]
    .reverse()
    .reduce((wrappedModel, middleware) => {
      return doWrap({ model: wrappedModel, middleware, modelId, providerId });
    }, model);
};
```

ミドルウェアは `transformParams`, `wrapGenerate`, `wrapStream` の3つのフックを持ち、複数ミドルウェアは `reduce` でネストされる（最初のミドルウェアが最外層）。具体例:

- `extractReasoningMiddleware`: XML タグから推論部分を抽出
- `defaultSettingsMiddleware`: デフォルトパラメータの注入
- `simulateStreamingMiddleware`: generate 結果をストリーム形式に変換

### providerOptions による拡張ポイントの設計

```typescript
// packages/provider/src/shared/v3/shared-v3-provider-options.ts:1
export type SharedV3ProviderOptions = Record<string, JSONObject>;
```

```typescript
// packages/provider-utils/src/parse-provider-options.ts:5-32
export async function parseProviderOptions<OPTIONS>({ provider, providerOptions, schema }) {
  if (providerOptions?.[provider] == null) return undefined;
  const parsedProviderOptions = await safeValidateTypes({ value: providerOptions[provider], schema });
  // ...
}
```

共通インターフェースの `providerOptions` は `Record<string, JSONObject>` 型で、プロバイダー名をキーとしたネームスペースで拡張を隔離する。各プロバイダーは `parseProviderOptions` で自プロバイダーのオプションのみをスキーマ検証付きで取得する。

### Symbol ベースのクロスバージョン型チェック

```typescript
// packages/provider/src/errors/ai-sdk-error.ts:5-61
const marker = "vercel.ai.error";
const symbol = Symbol.for(marker);

export class AISDKError extends Error {
  private readonly [symbol] = true;

  static isInstance(error: unknown): error is AISDKError {
    return AISDKError.hasMarker(error, marker);
  }
}
```

`instanceof` はパッケージバージョンが異なると失敗するため、`Symbol.for()` によるグローバルシンボルでインスタンス判定を行う。モノレポ内で複数バージョンのパッケージが共存しうる環境での堅牢なエラー判別を実現している。

## パターンカタログ

- **Abstract Factory** (分類: 生成)
  - 解決する問題: 30以上のプロバイダーを統一インターフェースで生成する
  - 適用条件: 同一契約を満たす複数の実装ファミリーが存在する場合
  - コード例: `packages/openai/src/openai-provider.ts:143` (`createOpenAI`)、`packages/anthropic/src/anthropic-provider.ts:90` (`createAnthropic`)
  - 注意点: ファクトリの戻り値は `ProviderV3` インターフェースに準拠しつつ、プロバイダー固有の拡張メソッド（`chat`, `completion` 等）も型安全に公開する

- **Decorator / Middleware** (分類: 構造/振る舞い)
  - 解決する問題: 個別モデルの変更なしに横断的関心事（ログ、パラメータ変換、ストリーム変換）を追加する
  - 適用条件: モデルの振る舞いを合成的に拡張したい場合
  - コード例: `packages/ai/src/middleware/wrap-language-model.ts:22-38`
  - 注意点: ミドルウェアの適用順序が重要（`reverse().reduce()` で最初のミドルウェアが最外層になる）

- **Adapter** (分類: 構造)
  - 解決する問題: 旧バージョン（V2）のプロバイダーを新バージョン（V3）のインターフェースで使う
  - 適用条件: インターフェースのバージョンアップ時に後方互換を保つ必要がある場合
  - コード例: `packages/ai/src/model/as-provider-v3.ts:8-36`
  - 注意点: アダプタは変換のオーバーヘッドを伴うため、新バージョンへの移行を促す `@deprecated` と併用する

- **Registry** (分類: 生成)
  - 解決する問題: 文字列 ID（`"openai:gpt-4o"`）からモデルインスタンスを動的に解決する
  - 適用条件: 設定ファイルやユーザー入力でモデルを指定する場合
  - コード例: `packages/ai/src/registry/provider-registry.ts:94-125`
  - 注意点: セパレータ（デフォルト `:`）によるプロバイダーID:モデルID の分割ロジックが固定

## Good Patterns

- **共通設定構造体によるプロバイダー実装の標準化**: 全プロバイダーが `{ provider, url, headers, fetch }` の内部設定構造体を共有する。新プロバイダー作成時のボイラープレートが最小化され、30以上のプロバイダーで一貫した振る舞いが保証される。

```typescript
// packages/groq/src/groq-config.ts:1-9
export type GroqConfig = {
  provider: string;
  url: (options: { modelId: string; path: string; }) => string;
  headers: () => Record<string, string | undefined>;
  fetch?: FetchFunction;
  generateId?: () => string;
};
```

- **レスポンスハンドラの分離によるエラー処理の統一**: `postToApi` が `successfulResponseHandler` と `failedResponseHandler` をコールバックとして受け取り、HTTP 通信とレスポンス解釈を分離する。各プロバイダーはエラースキーマを差し込むだけでよい。

```typescript
// packages/provider-utils/src/response-handler.ts:17-26
export const createJsonErrorResponseHandler = <T>({
  errorSchema, errorToMessage, isRetryable,
}: { ... }): ResponseHandler<APICallError> =>
  async ({ response, url, requestBodyValues }) => {
    // スキーマに基づくエラーパース + フォールバック
  };
```

- **FlexibleSchema によるスキーマ抽象**: Zod v3, Zod v4, Standard Schema, カスタム JSON Schema のいずれも受け入れる `FlexibleSchema` 型により、ユーザーのバリデーションライブラリ選択を制約しない。

```typescript
// packages/provider-utils/src/schema.ts:72-76
export type FlexibleSchema<SCHEMA = any> =
  | Schema<SCHEMA>
  | LazySchema<SCHEMA>
  | ZodSchema<SCHEMA>
  | StandardSchema<SCHEMA>;
```

## Anti-Patterns / 注意点

- **プロバイダー固有型の直接エクスポートによるロックイン**: プロバイダーが `OpenAIChatModelId` のような具象型を公開 API に露出すると、利用側がその型に依存し、プロバイダー切り替えが困難になる。

```typescript
// Bad: プロバイダー固有の型に依存
import { OpenAIChatModelId } from '@ai-sdk/openai';
function generate(model: OpenAIChatModelId) { ... }

// Better: 共通インターフェースに依存
import { LanguageModelV3 } from '@ai-sdk/provider';
function generate(model: LanguageModelV3) { ... }
```

- **未サポート機能のサイレント無視**: 一部のプロバイダーでサポートされない機能を `null` や空結果で返すと、ユーザーが問題に気づかない。

```typescript
// Bad: サイレントに null を返す
embeddingModel(modelId: string) { return null; }

// Better: 明示的にエラーをスロー（AI SDK の実際のパターン）
// packages/anthropic/src/anthropic-provider.ts:161-163
provider.embeddingModel = (modelId: string) => {
  throw new NoSuchModelError({ modelId, modelType: 'embeddingModel' });
};
```

## 導出ルール

- `[MUST]` 抽象化レイヤーのインターフェース定義パッケージは実装コードを含めない -- インターフェースと実装を同一パッケージに置くと、実装の変更がインターフェース利用者のリビルドを誘発する
  - 根拠: `@ai-sdk/provider` は型定義のみで構成され、`@ai-sdk/provider-utils` が実装を担当する分離設計により、30以上のプロバイダーが独立してリリース可能になっている

- `[MUST]` インターフェースにバージョンタグ（リテラル型プロパティ）を含め、discriminated union で新旧バージョンを判別可能にする
  - 根拠: `specificationVersion: 'v3'` により V2→V3 の非破壊的移行が実現され、`asProviderV3` アダプタが自動変換を行う（`packages/ai/src/model/as-provider-v3.ts:8-14`）

- `[MUST]` パッケージ境界を跨ぐ `instanceof` チェックの代わりに `Symbol.for()` ベースのマーカーパターンを使う
  - 根拠: モノレポや重複インストール環境では `instanceof` が失敗する。AI SDK は全エラークラスで `Symbol.for('vercel.ai.error.*')` による判定を採用している（`packages/provider/src/errors/ai-sdk-error.ts:5-61`）

- `[SHOULD]` プロバイダー実装者向けの低レベルメソッドには `do` プレフィックスを付け、エンドユーザー向け API と名前レベルで区別する
  - 根拠: `doGenerate`/`doStream`/`doEmbed` は内部メソッドであり、ユーザーは `generateText`/`streamText`/`embed` を使うべきだが、型システムだけではこの意図を伝えられない（`packages/provider/src/language-model/v3/language-model-v3.ts:43-45`）

- `[SHOULD]` 共通インターフェースには `providerOptions` のようなネームスペース付き拡張ポイントを設け、プロバイダー固有の機能を型安全に受け渡す
  - 根拠: `SharedV3ProviderOptions = Record<string, JSONObject>` により、プロバイダー名をキーとしたネームスペースで拡張を隔離し、共通インターフェースの肥大化を防いでいる（`packages/provider/src/shared/v3/shared-v3-provider-options.ts`）

- `[SHOULD]` 複数プロバイダーに共通するボイラープレート（API キー読み込み、HTTP 通信、エラーハンドリング）は共有ユーティリティパッケージに集約する
  - 根拠: `loadApiKey`, `postJsonToApi`, `createJsonErrorResponseHandler` 等が `@ai-sdk/provider-utils` に集約され、全プロバイダーで再利用されている

- `[SHOULD]` ミドルウェアパターンで横断的関心事を合成する場合、ミドルウェアインターフェースに `transformParams`（入力変換）と `wrapGenerate`/`wrapStream`（操作ラップ）の両フックを用意する
  - 根拠: パラメータ変換だけでは不十分なケース（結果の後処理、ストリーム変換）に対応でき、`extractReasoningMiddleware` のような高度なミドルウェアが `wrapGenerate` と `wrapStream` 両方を活用している（`packages/ai/src/middleware/extract-reasoning-middleware.ts`）

- `[AVOID]` プロバイダーがサポートしない機能を `null` や空結果でサイレントに返す -- 代わりに専用エラー（`NoSuchModelError`, `UnsupportedFunctionalityError`）をスローする
  - 根拠: Anthropic, Groq, DeepSeek 等のプロバイダーは、未サポートのモデル種別に対して一貫して `NoSuchModelError` をスローし、利用者に即座にフィードバックしている

## 適用チェックリスト

- [ ] インターフェース定義と実装が同一パッケージに混在していないか確認する
- [ ] 公開インターフェースにバージョンタグ（リテラル型プロパティ）が含まれ、将来の非破壊的進化が可能か確認する
- [ ] プロバイダー/プラグイン実装者向けの内部メソッドとエンドユーザー向け API が名前で区別されているか確認する
- [ ] 複数の実装が共有するボイラープレート（設定読み込み、HTTP通信、エラー処理）がユーティリティパッケージに集約されているか確認する
- [ ] プロバイダー固有の拡張がネームスペース付きの拡張ポイント経由で行われ、共通インターフェースを汚染していないか確認する
- [ ] パッケージ境界を跨ぐ型チェックに `instanceof` ではなく Symbol マーカーパターンを使っているか確認する
- [ ] 未サポート機能に対してサイレント失敗ではなく明示的なエラーを返しているか確認する
- [ ] 横断的関心事（ログ、認証、パラメータ変換）がミドルウェアとして分離され、個別実装にハードコードされていないか確認する
