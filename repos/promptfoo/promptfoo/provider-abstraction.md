# provider-abstraction

> リポジトリ: promptfoo/promptfoo
> 分析日: 2026-02-21

## 概要

100以上の LLM プロバイダ（OpenAI, Anthropic, Google, Azure, Bedrock, Mistral, Ollama, Replicate, Groq, xAI 等）を統一インターフェースで扱うための抽象化戦略を分析した。promptfoo はコロン区切りの文字列識別子（`provider:modelType:modelName`）をファクトリ配列で順次マッチングし、動的にプロバイダインスタンスを生成する。OpenAI 互換 API を持つプロバイダは継承で薄くラップし、非互換プロバイダは独自の Generic 基底クラスを持つ二層構造になっている。ツール定義や tool_choice のフォーマット変換を OpenAI 正規形から各プロバイダ形式へ変換する関数群が共有レイヤーに集約されている点が特筆に値する。

## 背景にある原則

- **文字列駆動のプロバイダ解決（String-Driven Resolution）**: YAML/JSON 設定ファイルから `"openai:chat:gpt-4o"` のような文字列一つでプロバイダを特定・生成できる設計。設定ファイルの宣言性を最大化し、コードを書かずにプロバイダを切り替えられる。`src/providers/registry.ts` の `providerMap` 配列が全てのマッチングルールを保持する。

- **OpenAI 互換プロトコルの最大活用（Protocol Conformance Over Abstraction）**: 多くの LLM プロバイダが OpenAI 互換 API を提供する現実に基づき、`OpenAiChatCompletionProvider` を直接継承して `apiBaseUrl` と `apiKeyEnvar` を差し替えるだけで新プロバイダを追加できる。DeepSeek, Cerebras, OpenRouter, Fireworks, Perplexity 等がこのパターンを採用（`src/providers/deepseek.ts`, `src/providers/cerebras.ts`, `src/providers/openrouter.ts`）。

- **正規形変換による相互運用（Canonical Form Transformation）**: ツール定義と tool_choice を OpenAI フォーマットを正規形として定義し、Anthropic/Bedrock/Google 各形式への変換関数を `src/providers/shared.ts` に集約。ユーザーは OpenAI 形式で記述すれば全プロバイダで動作する。非 OpenAI 形式はパススルーされる。

- **環境変数による認証の透過的解決（Environment-Based Credential Resolution）**: API キーの解決順序を `config.apiKey > config.apiKeyEnvar 経由の env > provider固有の env > 環境変数` と統一し、`src/types/env.ts` で Zod スキーマとして全 120+ 環境変数を型安全に定義。プロバイダ実装は `getApiKey()` メソッドを呼ぶだけでよい。

## 実例と分析

### ファクトリ配列による線形マッチング

プロバイダの解決は `src/providers/registry.ts` の `providerMap: ProviderFactory[]` 配列を上から順に `test()` でマッチングし、最初に一致したファクトリの `create()` を呼ぶ。GoF の Chain of Responsibility に近いが、配列の順序が優先度を決定する点が特徴的である。

```typescript
// src/providers/registry.ts:127-134
interface ProviderFactory {
  test: (providerPath: string) => boolean;
  create: (
    providerPath: string,
    providerOptions: ProviderOptions,
    context: LoadApiProviderContext,
  ) => Promise<ApiProvider>;
}
```

この設計により、新規プロバイダの追加は配列にエントリを一つ追加するだけで完了する。ただし配列の順序が重要で、`anthropic:claude-agent-sdk` は `anthropic:` より前に配置しないと誤マッチする。実際にこの順序依存が `registry.ts` の 216-266 行で確認できる。

### OpenAI 互換プロバイダの薄いラッパーパターン

OpenAI 互換 API を持つプロバイダは、`OpenAiChatCompletionProvider` を継承し、コンストラクタで `apiBaseUrl` と `apiKeyEnvar` を差し替えるだけで実装される。

```typescript
// src/providers/deepseek.ts:74-96
class DeepSeekProvider extends OpenAiChatCompletionProvider {
  constructor(modelName: string, providerOptions: DeepSeekProviderOptions) {
    const deepseekConfig = providerOptions.config?.config;
    super(modelName, {
      ...providerOptions,
      config: {
        ...providerOptions.config,
        ...deepseekConfig,
        apiKeyEnvar: 'DEEPSEEK_API_KEY',
        apiBaseUrl: 'https://api.deepseek.com/v1',
      },
    });
  }
}
```

さらに薄い例として、Fireworks はクラスすら作らずインラインで OpenAI プロバイダを直接生成する:

```typescript
// src/providers/registry.ts:674-691
{
  test: (providerPath: string) => providerPath.startsWith('fireworks:'),
  create: async (providerPath, providerOptions) => {
    const modelName = providerPath.split(':').slice(1).join(':');
    return new OpenAiChatCompletionProvider(modelName, {
      ...providerOptions,
      config: {
        ...providerOptions.config,
        apiBaseUrl: 'https://api.fireworks.ai/inference/v1',
        apiKeyEnvar: 'FIREWORKS_API_KEY',
      },
    });
  },
},
```

### 非互換プロバイダの二層基底クラス設計

OpenAI 互換でないプロバイダ（Anthropic, Bedrock 等）は独自の Generic 基底クラスを持つ。例えば Anthropic は `AnthropicGenericProvider`（SDK 初期化、認証）と `AnthropicMessagesProvider`（Messages API 実装）の二層構造:

```typescript
// src/providers/anthropic/generic.ts:21-46
export class AnthropicGenericProvider implements ApiProvider {
  modelName: string;
  config: AnthropicBaseOptions;
  env?: EnvOverrides;
  anthropic: Anthropic;

  constructor(modelName: string, options = {}) {
    this.modelName = modelName;
    this.config = options.config || {};
    this.apiKey = this.getApiKey();
    this.anthropic = new Anthropic({
      apiKey: this.apiKey,
      baseURL: this.getApiBaseUrl(),
    });
  }

  async callApi(): Promise<ProviderResponse> {
    throw new Error('Not implemented: callApi must be implemented by subclasses');
  }
}
```

### ツールフォーマットの正規形変換

`src/providers/shared.ts` に OpenAI 形式を正規形とする変換レイヤーが実装されている。ツール定義（`tools`）と選択指示（`tool_choice`）の両方に対応:

```typescript
// src/providers/shared.ts:439-457
export function transformTools(tools: unknown, format: ToolFormat): unknown {
  if (!isOpenAIToolArray(tools)) {
    return tools; // 非 OpenAI 形式はパススルー
  }
  switch (format) {
    case 'openai':    return tools;
    case 'anthropic': return openaiToolsToAnthropic(tools);
    case 'bedrock':   return openaiToolsToBedrock(tools);
    case 'google':    return openaiToolsToGoogle(tools);
    default:          return tools;
  }
}
```

Google/Gemini 向けにはスキーマのサニタイズ（`additionalProperties` 除去、type の大文字化等）も組み込まれている（`shared.ts:385-417`）。

### コロン区切り URI の階層的解析

プロバイダ識別子 `prefix:modelType:modelName` のパースは各ファクトリ内で `split(':')` で行われる。Azure の例:

```typescript
// src/providers/registry.ts:287-316
const splits = providerPath.split(':');
const modelType = splits[1];  // 'chat', 'embedding', 'completion', etc.
const deploymentName = splits[2];

if (modelType === 'chat') {
  return new AzureChatCompletionProvider(deploymentName, providerOptions);
}
if (modelType === 'embedding' || modelType === 'embeddings') {
  return new AzureEmbeddingProvider(deploymentName, providerOptions);
}
```

### スクリプトベースプロバイダのファクトリ抽象化

Python, Go, Ruby, exec の各スクリプトプロバイダは `createScriptBasedProviderFactory` で共通化:

```typescript
// src/providers/scriptBasedProvider.ts:13-55
export function createScriptBasedProviderFactory(
  prefix: string,
  fileExtension: string | null,
  providerConstructor: new (scriptPath: string, options: ProviderOptions) => ApiProvider,
) {
  return {
    test: (providerPath: string) => {
      if (providerPath.startsWith(`${prefix}:`)) return true;
      if (fileExtension && providerPath.startsWith('file://')) {
        return providerPath.endsWith(`.${fileExtension}`);
      }
      return false;
    },
    create: async (providerPath, providerOptions, _context) => {
      let scriptPath = providerPath.startsWith('file://')
        ? providerPath.slice('file://'.length)
        : providerPath.split(':').slice(1).join(':');
      const resolvedPath = getResolvedRelativePath(scriptPath);
      return new providerConstructor(resolvedPath, providerOptions);
    },
  };
}
```

### 環境変数ベースのデフォルトプロバイダ自動選択

`src/providers/defaults.ts` はどの API キーが設定されているかを検出し、適切なデフォルトプロバイダセットを自動選択するカスケードロジックを実装:

```typescript
// src/providers/defaults.ts:68-218
// 優先順: Azure > Anthropic > Google AI Studio > Vertex > Mistral > GitHub > OpenAI
if (preferAzure) { /* Azure providers */ }
else if (preferAnthropic) { /* Anthropic providers */ }
else if (hasGoogleAiStudioCredentials) { /* Google AI Studio providers */ }
else if (await hasGoogleDefaultCredentials()) { /* Vertex providers */ }
else if (hasMistralCredentials) { /* Mistral providers */ }
else if (hasGitHubCredentials) { /* GitHub Models providers */ }
else { /* OpenAI providers (default) */ }
```

### プロセスライフサイクル管理

`src/providers/providerRegistry.ts` はプロセス終了時のクリーンアップを一元管理。Python プロバイダなどリソースを持つプロバイダが登録し、`SIGINT`/`SIGTERM`/`beforeExit` で確実にシャットダウンされる:

```typescript
// src/providers/providerRegistry.ts:14-73
class ProviderRegistry {
  private providers: Set<CleanupProvider> = new Set();

  register(provider: CleanupProvider): void {
    this.providers.add(provider);
    if (!this.shutdownRegistered) {
      this.registerShutdownHandlers();
    }
  }

  async shutdownAll(): Promise<void> {
    const results = await Promise.allSettled(
      Array.from(this.providers).map((p) => p.shutdown())
    );
    this.providers.clear();
  }
}
```

## コード例

```typescript
// src/providers/registry.ts:136-140 - ファクトリ配列の先頭（スクリプトベースプロバイダ）
export const providerMap: ProviderFactory[] = [
  createScriptBasedProviderFactory('exec', null, ScriptCompletionProvider),
  createScriptBasedProviderFactory('golang', 'go', GolangProvider),
  createScriptBasedProviderFactory('python', 'py', PythonProvider),
  createScriptBasedProviderFactory('ruby', 'rb', RubyProvider),
```

```typescript
// src/providers/index.ts:153-165 - ファクトリ配列の線形走査
for (const factory of providerMap) {
  if (factory.test(renderedProviderPath)) {
    const ret = await factory.create(renderedProviderPath, providerOptions, context);
    ret.transform = options.transform;
    ret.delay = options.delay;
    ret.inputs = options.inputs;
    ret.label ||= getNunjucksEngine().renderString(
      String(options.label || ''),
      mergedEnv ? { env: mergedEnv } : {},
    );
    return ret;
  }
}
```

```typescript
// src/types/providers.ts:102-120 - 統一プロバイダインターフェース
export interface ApiProvider {
  id: () => string;
  callApi: CallApiFunction;
  callClassificationApi?: (prompt: string) => Promise<ProviderClassificationResponse>;
  callEmbeddingApi?: (input: string) => Promise<ProviderEmbeddingResponse>;
  config?: any;
  delay?: number;
  label?: ProviderLabel;
  transform?: string;
  cleanup?: () => void | Promise<void>;
}
```

```typescript
// src/providers/shared.ts:162-166 - ツール選択の正規形（OpenAI 形式）
export type OpenAIToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } };
```

```typescript
// src/providers/cerebras.ts:14-56 - OpenAI 互換プロバイダの最薄ラッパー
export function createCerebrasProvider(providerPath, options = {}): ApiProvider {
  const modelName = providerPath.split(':').slice(1).join(':');

  class CerebrasProvider extends OpenAiChatCompletionProvider {
    async getOpenAiBody(prompt, context, callApiOptions) {
      const { body, config } = await super.getOpenAiBody(prompt, context, callApiOptions);
      if (body.max_completion_tokens) {
        delete body.max_tokens; // Cerebras 固有の非互換を吸収
      }
      return { body, config };
    }
  }

  return new CerebrasProvider(modelName, {
    config: {
      apiBaseUrl: 'https://api.cerebras.ai/v1',
      apiKeyEnvar: 'CEREBRAS_API_KEY',
    },
  });
}
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 100以上のプロバイダの呼び出しロジックを統一インターフェースで切り替える
  - 適用条件: 同じ入出力契約（`callApi(prompt) => ProviderResponse`）を持つ複数の実装が存在する
  - コード例: `src/types/providers.ts:102-120` の `ApiProvider` インターフェース
  - 注意点: `config?: any` が型安全性を犠牲にしている。プロバイダごとの config 型は個別に定義

- **Chain of Responsibility パターン** (分類: 振る舞い)
  - 解決する問題: 文字列識別子から適切なプロバイダファクトリを見つける
  - 適用条件: プロバイダの種類が動的に増加し、識別ルールが多様
  - コード例: `src/providers/registry.ts:136-1708` の `providerMap` 配列
  - 注意点: 配列の順序が優先度を決定するため、プレフィックスの包含関係に注意（`anthropic:claude-agent-sdk` は `anthropic:` より前に配置）

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: OpenAI 互換プロバイダ間で共通の API 呼び出しフローを再利用しつつ、差分だけをオーバーライド
  - 適用条件: 多くのプロバイダが OpenAI 互換 API を提供している
  - コード例: `src/providers/cerebras.ts:30-41` の `getOpenAiBody()` オーバーライド
  - 注意点: 差分が大きくなると継承の複雑性が増す（OpenRouter は `callApi` 全体をオーバーライド）

- **Adapter パターン** (分類: 構造)
  - 解決する問題: OpenAI 形式のツール定義を各プロバイダ固有の形式に変換する
  - 適用条件: 正規形（OpenAI）と変換先（Anthropic, Bedrock, Google）が明確に定義されている
  - コード例: `src/providers/shared.ts:356-457` の `openaiToolsToAnthropic()`, `openaiToolsToBedrock()`, `openaiToolsToGoogle()`
  - 注意点: 非 OpenAI 形式の入力はパススルーされるため、検出ロジック（`isOpenAIToolArray()`）が正確でなければならない

- **Abstract Factory パターン** (分類: 生成)
  - 解決する問題: スクリプトベースプロバイダ（Python, Go, Ruby, exec）のファクトリ生成を共通化
  - 適用条件: マッチングロジック（プレフィックスとファイル拡張子の二重チェック）が同じパターンで繰り返される
  - コード例: `src/providers/scriptBasedProvider.ts:13-55` の `createScriptBasedProviderFactory()`
  - 注意点: ファクトリ自体を生成するメタファクトリであり、パターンの二重適用

## Good Patterns

- **OpenAI 互換プロバイダの 2 行追加パターン**: `apiBaseUrl` と `apiKeyEnvar` の差し替えだけで新プロバイダを追加できる設計。Fireworks, F5 はクラスすら不要で、レジストリにインラインエントリを一つ追加するだけ。コード量が最小で、OpenAI 側の機能アップデート（ストリーミング、ツール呼び出し等）が自動的に全互換プロバイダに伝播する。

```typescript
// src/providers/registry.ts:674-691
// Fireworks: OpenAiChatCompletionProvider の直接利用
return new OpenAiChatCompletionProvider(modelName, {
  config: {
    apiBaseUrl: 'https://api.fireworks.ai/inference/v1',
    apiKeyEnvar: 'FIREWORKS_API_KEY',
  },
});
```

- **正規形パススルー付き変換**: `transformTools()` と `transformToolChoice()` は入力が OpenAI 形式でない場合にそのまま返す。ユーザーがプロバイダネイティブ形式で記述した場合も正常に動作する柔軟性を保つ。

```typescript
// src/providers/shared.ts:439-442
export function transformTools(tools: unknown, format: ToolFormat): unknown {
  if (!isOpenAIToolArray(tools)) {
    return tools; // 非 OpenAI 形式はパススルー
  }
```

- **テスト用 Echo プロバイダ**: `ApiProvider` を最小実装する Echo プロバイダがテスト支援として組み込まれている。入力をそのまま出力する単純な実装で、統合テストやデバッグで依存関係なしにプロバイダ層を検証できる。

```typescript
// src/providers/echo.ts:5-55
export class EchoProvider implements ApiProvider {
  id(): string { return 'echo'; }
  async callApi(input: string): Promise<ProviderResponse> {
    return { output: input, raw: input, cost: 0, cached: false };
  }
}
```

- **ProviderRegistry による防衛的シャットダウン**: `Promise.allSettled` で個々のシャットダウン失敗が他に影響しないようにし、プロセス終了時のリソースリークを防止。

```typescript
// src/providers/providerRegistry.ts:59-70
async shutdownAll(): Promise<void> {
  const results = await Promise.allSettled(
    Array.from(this.providers).map((p) => p.shutdown())
  );
  for (const result of results) {
    if (result.status === 'rejected') {
      logger.warn(`Error shutting down provider: ${result.reason}`);
    }
  }
  this.providers.clear();
}
```

## Anti-Patterns / 注意点

- **config の `any` 型による型安全性の欠如**: `ProviderOptions.config` が `any` 型で定義されており、各プロバイダの設定型チェックがコンパイル時に効かない。プロバイダごとに独自の config インターフェースを定義しているが、`ProviderOptions` から取り出す際にキャストが必要。

```typescript
// Bad: src/types/providers.ts:50-59
export interface ProviderOptions {
  config?: any; // 任意のプロバイダ設定を受け入れるが型安全性なし
}

// Better: ジェネリクスで型パラメータ化
export interface ProviderOptions<TConfig = unknown> {
  config?: TConfig;
}
```

- **レジストリ配列の順序依存**: `providerMap` の順序がマッチング優先度を暗黙に決定する。`anthropic:claude-agent-sdk` と `anthropic:` のように、プレフィックスの包含関係がある場合に順序を間違えるとバグになる。コメントや lint ルールでの保護がない。

```typescript
// Bad: 順序を間違えると anthropic:claude-agent-sdk が anthropic: にマッチ
{ test: (p) => p.startsWith('anthropic:'), ... },          // 先にマッチしてしまう
{ test: (p) => p.startsWith('anthropic:claude-agent-sdk'), ... },

// Better: 現在の実装は正しい順序だが、明示的なコメントかテストで保護すべき
// 1. より具体的なプレフィックスを先に配置
{ test: (p) => p.startsWith('anthropic:claude-agent-sdk'), ... },
{ test: (p) => p.startsWith('anthropic:'), ... },
```

- **デフォルトプロバイダ選択の条件分岐の複雑化**: `getDefaultProviders()` の if-else チェーンが 7 段階に達しており、新プロバイダ追加のたびに分岐が増加する。非同期の `hasGoogleDefaultCredentials()` 呼び出しが複数箇所で繰り返されるなど、条件の組み合わせ爆発が見られる。

```typescript
// Bad: src/providers/defaults.ts:105-218 の 7 段階 if-else
if (preferAzure) { ... }
else if (preferAnthropic) { ... }
else if (hasGoogleAiStudioCredentials) { ... }
else if (await hasGoogleDefaultCredentials()) { ... }  // 非同期を含む条件
else if (hasMistralCredentials) { ... }
else if (hasGitHubCredentials) { ... }
else { /* OpenAI */ }

// Better: プロバイダ検出を配列に構造化
const detectors = [
  { name: 'azure', detect: () => preferAzure, providers: getAzureProviders },
  { name: 'anthropic', detect: () => preferAnthropic, providers: getAnthropicProviders },
  // ...
];
```

## 導出ルール

- `[MUST]` 100 以上の実装が存在するプロバイダ抽象化では、最小インターフェースを定義して `id()` と `callApi()` のみを必須とし、`callEmbeddingApi()` 等の拡張メソッドはオプショナルにする
  - 根拠: promptfoo の `ApiProvider` は `id()` と `callApi` のみ必須で、embedding/classification/moderation は optional。これにより Echo プロバイダのような最小実装が 20 行で書ける一方、フル機能プロバイダも同じインターフェースに収まる

- `[MUST]` 文字列識別子からプロバイダを生成するファクトリレジストリでは、具体的なプレフィックス（`anthropic:claude-agent-sdk`）を汎用プレフィックス（`anthropic:`）より先にマッチングさせる。順序を保証するテストを書く
  - 根拠: `src/providers/registry.ts` でプレフィックスの包含関係がある箇所は必ず具体的なものが先に配置されており、順序を間違えると誤ったプロバイダが生成される

- `[MUST]` マルチプロバイダシステムではツール定義の正規形を一つ決め、各プロバイダ向け変換関数を共有レイヤーに集約する。非正規形の入力はパススルーする
  - 根拠: `src/providers/shared.ts` の `transformTools()` / `transformToolChoice()` は OpenAI 形式を正規形とし、`isOpenAIToolArray()` で検出できない場合はそのまま返す。これにより「OpenAI 形式で書けば全プロバイダで動く」「ネイティブ形式で書いても壊れない」の両立を実現

- `[SHOULD]` OpenAI 互換 API を持つプロバイダは、基底クラスを継承し `apiBaseUrl` と `apiKeyEnvar` の差し替えだけで実装する。プロバイダ固有の差分は `getOpenAiBody()` 等のフックメソッドでオーバーライドする
  - 根拠: DeepSeek, Cerebras, Fireworks, Perplexity, OpenRouter 等 10 以上のプロバイダがこのパターンを採用。OpenAI 側の機能追加（ストリーミング、構造化出力等）が自動伝播し、メンテナンスコストが激減する

- `[SHOULD]` API キーの解決は `config 直指定 > 環境変数名の間接指定（apiKeyEnvar） > プロバイダ固有の環境変数 > デフォルトの環境変数` の優先順位チェーンで行い、各プロバイダは `getApiKey()` メソッドに集約する
  - 根拠: `src/providers/openai/index.ts:68-78` の `getApiKey()` が4段階のフォールバックチェーンを実装。テスト環境、CI、ローカル開発で異なる認証方式を透過的に切り替えられる

- `[SHOULD]` プロセス終了時のクリーンアップが必要なプロバイダ（子プロセス、WebSocket 等）は、グローバルレジストリに登録してシグナルハンドラで一括シャットダウンする。`Promise.allSettled` で個別の失敗が他に影響しないようにする
  - 根拠: `src/providers/providerRegistry.ts` の `ProviderRegistry` が Python プロバイダのゾンビプロセスを防止。`SIGINT`/`SIGTERM`/`beforeExit` の三重フックで確実性を担保

- `[AVOID]` ファクトリレジストリの配列に順序依存の暗黙ルールを持たせたまま、順序を保証するテストやコメントを省略する
  - 根拠: `registry.ts` のプロバイダ数が 60 以上に達しており、新規追加時に挿入位置を間違えるリスクが高い。プレフィックスの包含関係チェックが自動化されていない

- `[AVOID]` プロバイダ設定の型を `any` にして型安全性を犠牲にする。設定オブジェクトが複雑な場合は Zod スキーマや discriminated union で検証する
  - 根拠: `ProviderOptions.config?: any` により、設定ミスがランタイムまで検出されない。DeepSeek の `config.config` のようなネスト構造も型チェックが効かず、バグの温床になりうる

## 適用チェックリスト

- [ ] プロバイダインターフェースの必須メソッドは `id()` と `callApi()` のみに絞れているか。拡張メソッドはオプショナルになっているか
- [ ] 文字列識別子（`provider:type:name`）のパース規則が統一されているか。コロン区切りの階層構造が一貫しているか
- [ ] OpenAI 互換プロバイダは基底クラスの継承で実装できているか。不要な独自実装をしていないか
- [ ] ツール定義や共通パラメータの正規形が定義されており、各プロバイダ向けの変換関数が共有レイヤーに集約されているか
- [ ] API キーの解決が `getApiKey()` 等のメソッドに集約され、config > env変数名 > 環境変数 のフォールバックチェーンになっているか
- [ ] ファクトリレジストリの順序にプレフィックス包含関係の制約がある場合、テストで保護されているか
- [ ] リソースを持つプロバイダ（子プロセス、コネクション）のクリーンアップが一元管理されているか
- [ ] テスト用のモック/スタブプロバイダ（Echo 相当）が用意されているか
- [ ] 環境変数による認証情報が Zod 等で型安全に定義され、不明な変数がパススルーされる拡張性を持っているか
