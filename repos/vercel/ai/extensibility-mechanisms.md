# extensibility-mechanisms

> リポジトリ: vercel/ai
> 分析日: 2026-02-20

## 概要

Vercel AI SDK の拡張性メカニズムを分析した。プロバイダーレジストリ、ミドルウェアパイプライン、MCP 統合、DevTools 統合の4軸で拡張ポイントが設計されている。注目すべきは、すべての拡張メカニズムが「インターフェース境界の明確な分離」と「デコレータパターンによる透過的な振る舞い追加」という共通原則に基づいている点である。バージョニングされたインターフェース（V2/V3）、`experimental_` プレフィックスによる段階的 API 安定化、ファクトリ関数によるプロバイダー生成など、大規模エコシステムを持つライブラリの拡張性設計として参考になるプラクティスが多い。

## 背景にある原則

- **インターフェース境界でバージョニングする**: `ProviderV3`、`LanguageModelV3`、`LanguageModelV3Middleware` など、すべての拡張ポイントに `specificationVersion: 'v3'` プロパティを持たせている。これにより、古いバージョンのプロバイダーを `asProviderV3()` で新バージョンに変換しつつ共存でき、破壊的変更を段階的に導入できる（`packages/ai/src/model/as-provider-v3.ts`）。拡張インターフェースが多くのサードパーティに実装される場合、バージョンフィールドによる互換性判定は必須である。

- **ミドルウェアはモデルと同じインターフェースを返す**: `wrapLanguageModel` はミドルウェアを適用した結果として `LanguageModelV3` をそのまま返す（`packages/ai/src/middleware/wrap-language-model.ts:32-37`）。利用側はラップされたモデルかオリジナルかを区別する必要がない。この透過性により、ミドルウェアを自由に積み重ねても型の整合性が保たれる。

- **ファクトリ関数 + フォールバックチェーンで柔軟性と安全性を両立する**: `customProvider` は明示的に登録されたモデルを優先し、見つからなければ `fallbackProvider` に委譲する（`packages/ai/src/registry/custom-provider.ts:74-83`）。これにより、部分的なカスタマイズ（特定モデルだけ差し替え）と完全なカスタマイズの両方を単一の API で実現している。

- **`do` プレフィックスで内部 API と公開 API を分離する**: `doGenerate`、`doStream`、`doEmbed` などのメソッド名に意図的に `do` プレフィックスを付け、利用者がプロバイダーの低レベル API を直接呼ぶことを防いでいる（`packages/provider/src/language-model/v3/language-model-v3.ts:43-44`）。高レベル関数（`generateText`、`streamText`）経由での利用を促す命名規約。

## 実例と分析

### プロバイダー登録メカニズム

3層のプロバイダー抽象が存在する: (1) `ProviderV3` インターフェース、(2) `customProvider` ファクトリ、(3) `createProviderRegistry` レジストリ。

`ProviderV3` は `languageModel(id)`、`embeddingModel(id)`、`imageModel(id)` 等のファクトリメソッドを定義するインターフェースで、各メソッドは文字列 ID を受け取ってモデルインスタンスを返す（`packages/provider/src/provider/v3/provider-v3.ts:11-93`）。`transcriptionModel`、`speechModel`、`rerankingModel` はオプショナルで、プロバイダーが対応するモデルタイプのみ実装すればよい。

プロバイダーレジストリは `"providerId:modelId"` 形式の複合 ID を受け取り、セパレーター（デフォルト `:`）で分割して適切なプロバイダーにルーティングする。セパレーターはジェネリクスで型レベルでカスタマイズ可能（`packages/ai/src/registry/provider-registry.ts:94-125`）。

```typescript
// packages/ai/src/registry/provider-registry.ts:94-125
export function createProviderRegistry<
  PROVIDERS extends Record<string, ProviderV3>,
  SEPARATOR extends string = ":",
>(
  providers: PROVIDERS,
  {
    separator = ":" as SEPARATOR,
    languageModelMiddleware,
    imageModelMiddleware,
  }: {
    separator?: SEPARATOR;
    languageModelMiddleware?:
      | LanguageModelMiddleware
      | LanguageModelMiddleware[];
    imageModelMiddleware?: ImageModelMiddleware | ImageModelMiddleware[];
  } = {},
): ProviderRegistryProvider<PROVIDERS, SEPARATOR>;
```

レジストリ自体がミドルウェアを受け取り、全プロバイダーのモデルに一括適用できる設計になっている。

### ミドルウェアパイプライン

ミドルウェアは3つのフック（`transformParams`、`wrapGenerate`、`wrapStream`）を持つオブジェクトとして定義される。複数ミドルウェアを配列で渡すと、`reverse().reduce()` で内側から外側へラップされる。

```typescript
// packages/ai/src/middleware/wrap-language-model.ts:33-37
return [...asArray(middlewareArg)]
  .reverse()
  .reduce((wrappedModel, middleware) => {
    return doWrap({ model: wrappedModel, middleware, modelId, providerId });
  }, model);
```

この結果、配列の最初のミドルウェアが最も外側（入力を最初に変換し、出力を最後に処理する）となる。ミドルウェアのフックは部分的に実装可能で、`transformParams` だけ、または `wrapGenerate` だけを定義すればよい。

具体的なミドルウェア実装例:

- **`defaultSettingsMiddleware`**: `transformParams` のみを使い、デフォルト値をマージする（`packages/ai/src/middleware/default-settings-middleware.ts:8-33`）
- **`extractReasoningMiddleware`**: `wrapGenerate` と `wrapStream` の両方を使い、XML タグで囲まれた推論部分を構造化データに変換する（`packages/ai/src/middleware/extract-reasoning-middleware.ts:16-249`）
- **`simulateStreamingMiddleware`**: `wrapStream` 内で `doGenerate` を呼び出し、非ストリーミング結果をストリームに変換する。ミドルウェアが `doGenerate` と `doStream` の両方にアクセスできる設計が、この種の操作変換を可能にしている（`packages/ai/src/middleware/simulate-streaming-middleware.ts:7-79`）
- **`devToolsMiddleware`**: 外部パッケージ（`@ai-sdk/devtools`）としてミドルウェアを提供し、生成/ストリーミング操作をインターセプトして SQLite に記録する（`packages/devtools/src/middleware.ts:100-392`）

### MCP 統合

MCP クライアントはトランスポート層を抽象化した `MCPTransport` インターフェースで拡張可能。`start()`、`send()`、`close()` の3メソッドとイベントハンドラ（`onclose`、`onerror`、`onmessage`）を定義する。

```typescript
// packages/mcp/src/tool/mcp-transport.ts:11-42
export interface MCPTransport {
  start(): Promise<void>;
  send(message: JSONRPCMessage): Promise<void>;
  close(): Promise<void>;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
}
```

組み込みトランスポート（`SseMCPTransport`、`HttpMCPTransport`、`StdioMCPTransport`）を提供しつつ、カスタムトランスポートはダックタイピングで検出する:

```typescript
// packages/mcp/src/tool/mcp-transport.ts:77-88
export function isCustomMcpTransport(
  transport: MCPTransportConfig | MCPTransport,
): transport is MCPTransport {
  return (
    "start" in transport
    && typeof transport.start === "function"
    && "send" in transport
    && typeof transport.send === "function"
    && "close" in transport
    && typeof transport.close === "function"
  );
}
```

MCP ツールは自動的に AI SDK の `Tool` 型に変換される。スキーマを `'automatic'` にすると MCP サーバーから取得した JSON Schema をそのまま使い、明示的なスキーマを渡すと型安全な入出力が得られる（`packages/mcp/src/tool/mcp-client.ts:541-619`）。

### API 安定化パイプライン

`experimental_` プレフィックス付きエクスポートから安定版への移行パターンが確立されている。安定化後も `@deprecated` 注釈付きで旧名をエイリアスとして残す:

```typescript
// packages/ai/src/registry/provider-registry.ts:128-130
/**
 * @deprecated Use `createProviderRegistry` instead.
 */
export const experimental_createProviderRegistry = createProviderRegistry;
```

### バージョン間の互換性ブリッジ

`asProviderV3()` は V2 プロバイダーを V3 インターフェースに変換するアダプターで、各モデルタイプごとに変換関数を持つ:

```typescript
// packages/ai/src/model/as-provider-v3.ts:8-36
export function asProviderV3(provider: ProviderV2 | ProviderV3): ProviderV3 {
  if (
    "specificationVersion" in provider
    && provider.specificationVersion === "v3"
  ) {
    return provider;
  }
  const v2Provider: ProviderV2 = provider as ProviderV2;
  return {
    specificationVersion: "v3",
    languageModel: (modelId: string) => asLanguageModelV3(v2Provider.languageModel(modelId)),
    // ...
  };
}
```

## パターンカタログ

- **Decorator パターン** (分類: 構造)
  - 解決する問題: モデルの振る舞いを変更せずに機能を追加する（ロギング、パラメータ変換、出力変換など）
  - 適用条件: 元のインターフェース（`LanguageModelV3`）を変えずに横断的関心事を追加したい場合
  - コード例: `packages/ai/src/middleware/wrap-language-model.ts:22-38`
  - 注意点: `reverse().reduce()` の適用順序を理解する必要がある。配列先頭のミドルウェアが最も外側に位置する

- **Abstract Factory パターン** (分類: 生成)
  - 解決する問題: 異なるプロバイダー（OpenAI、Anthropic 等）が同じインターフェースでモデルを生成する
  - 適用条件: 複数の実装を統一的に扱いつつ、プロバイダー固有の設定を許容する場合
  - コード例: `packages/openai/src/openai-provider.ts:143-265`（`createOpenAI` ファクトリ）
  - 注意点: ファクトリ関数自体を callable にする（`provider('gpt-4o')` のようにデフォルトモデルタイプを直接呼べる）パターンは TypeScript で型を合わせる工夫が必要

- **Adapter パターン** (分類: 構造)
  - 解決する問題: 旧バージョン（V2）のプロバイダーを新バージョン（V3）のインターフェースで利用する
  - 適用条件: インターフェースのメジャーバージョンアップ時に後方互換性を維持する場合
  - コード例: `packages/ai/src/model/as-provider-v3.ts:8-36`

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: MCP トランスポートの実装（HTTP、SSE、stdio）を実行時に切り替える
  - 適用条件: 同じプロトコルで異なる通信方式をサポートする場合
  - コード例: `packages/mcp/src/tool/mcp-transport.ts:63-75`（`createMcpTransport`）

## Good Patterns

- **ミドルウェアフックの部分実装を許容する**: `LanguageModelV3Middleware` の `transformParams`、`wrapGenerate`、`wrapStream` はすべてオプショナル。必要なフックだけ実装すればよく、`doWrap` 関数内でフックの有無を確認して透過的にフォールスルーする。これにより `defaultSettingsMiddleware` は `transformParams` だけ、`simulateStreamingMiddleware` は `wrapStream` だけで完結する。

```typescript
// packages/ai/src/middleware/wrap-language-model.ts:77-91
async doGenerate(
  params: LanguageModelV3CallOptions,
): Promise<LanguageModelV3GenerateResult> {
  const transformedParams = await doTransform({ params, type: 'generate' });
  const doGenerate = async () => model.doGenerate(transformedParams);
  const doStream = async () => model.doStream(transformedParams);
  return wrapGenerate
    ? wrapGenerate({
        doGenerate,
        doStream,
        params: transformedParams,
        model,
      })
    : doGenerate();
},
```

- **ミドルウェア内で doGenerate と doStream を相互参照可能にする**: `wrapGenerate` コールバックに `doStream` も渡し、`wrapStream` コールバックに `doGenerate` も渡す。これにより `simulateStreamingMiddleware` のように、ストリーミング要求を非ストリーミング結果から合成する操作が可能になる。

```typescript
// packages/ai/src/middleware/simulate-streaming-middleware.ts:9-10
wrapStream: async ({ doGenerate }) => {
  const result = await doGenerate();
```

- **エラー型に Symbol マーカーを使った型判別**: `NoSuchProviderError` は Symbol ベースのマーカーで `isInstance` を実装しており、`instanceof` に頼らない堅牢な型判別を提供する。モジュールバンドラーによるクラスの重複インスタンス化問題を回避する。

```typescript
// packages/ai/src/registry/no-such-provider-error.ts:3-8
const name = 'AI_NoSuchProviderError';
const marker = `vercel.ai.error.${name}`;
const symbol = Symbol.for(marker);

export class NoSuchProviderError extends NoSuchModelError {
  private readonly [symbol] = true; // used in isInstance
```

- **MCP サーバー機能のケイパビリティチェック**: MCP クライアントは `initialize` 応答で取得した `serverCapabilities` を保持し、各メソッド呼び出し前に `assertCapability()` で対応状況を検証する（`packages/mcp/src/tool/mcp-client.ts:299-333`）。「使えない機能を呼ぶ前に失敗する」Fail-fast パターン。

## Anti-Patterns / 注意点

- **ミドルウェアの適用順序の誤解**: 配列で渡したミドルウェアは `reverse()` されてから `reduce` で適用される。つまり配列の先頭が最も外側（入力を最初に処理する）となるが、直感に反する場合がある。ドキュメントでは「the first middleware will transform the input first, and the last middleware will be wrapped directly around the model」と明記しているが、コードだけ見ると見落としやすい。

```typescript
// Bad: 順序を意識せずにミドルウェアを並べる
wrapLanguageModel({
  model,
  middleware: [loggingMiddleware, cachingMiddleware],
  // logging が外側、caching が内側になる
  // caching の結果を logging が観測する
});

// Better: 意図的な順序を明示するコメントを残す
wrapLanguageModel({
  model,
  middleware: [
    loggingMiddleware, // 最外層: すべての入出力を記録
    cachingMiddleware, // 内層: キャッシュヒット時は model を呼ばない
  ],
});
```

- **プロバイダーのプロダクション環境ガード漏れ**: `devToolsMiddleware` は `process.env.NODE_ENV === 'production'` で明示的にエラーを投げるが、このガードはミドルウェア側に責任がある。レジストリやラップ関数にはこの仕組みがないため、開発専用ミドルウェアが本番に混入するリスクがある。

```typescript
// Bad: 環境チェックなしにデバッグミドルウェアを登録
const registry = createProviderRegistry({
  openai: createOpenAI(),
}, {
  languageModelMiddleware: devToolsMiddleware(), // 本番で例外
});

// Better: 環境で分岐する、または devToolsMiddleware のように内部でガード
const middleware = process.env.NODE_ENV !== "production"
  ? [devToolsMiddleware()]
  : [];
```

## 導出ルール

- `[MUST]` 拡張インターフェースにバージョンフィールドを含め、旧バージョンをアダプターで変換する仕組みを用意する
  - 根拠: Vercel AI SDK は `specificationVersion: 'v3'` を全拡張インターフェースに持たせ、`asProviderV3()` で V2 との互換性を維持している（`packages/provider/src/provider/v3/provider-v3.ts:12`、`packages/ai/src/model/as-provider-v3.ts`）

- `[MUST]` ミドルウェアの戻り値型を元のモデルインターフェースと同一に保ち、ラップが透過的に動作するようにする
  - 根拠: `wrapLanguageModel` は `LanguageModelV3` を受け取り `LanguageModelV3` を返すため、利用側はミドルウェアの有無を意識せず同じ API でモデルを扱える（`packages/ai/src/middleware/wrap-language-model.ts:22-38`）

- `[SHOULD]` ミドルウェアのフック（transformParams / wrapGenerate / wrapStream 等）は各々オプショナルにし、不要なフックの実装を強制しない
  - 根拠: `defaultSettingsMiddleware` は `transformParams` のみ、`simulateStreamingMiddleware` は `wrapStream` のみで機能する。フックの部分実装により、単一責務のミドルウェアを小さく作れる（`packages/ai/src/middleware/default-settings-middleware.ts`、`packages/ai/src/middleware/simulate-streaming-middleware.ts`）

- `[SHOULD]` `experimental_` プレフィックスで API を公開し、安定化後も `@deprecated` 付きエイリアスで旧名を残して段階的に移行する
  - 根拠: `experimental_createProviderRegistry` → `createProviderRegistry` の移行パターンが一貫して適用されている（`packages/ai/src/registry/provider-registry.ts:128-130`）

- `[SHOULD]` エラー型の判別には `instanceof` ではなく Symbol ベースのマーカー + 静的 `isInstance` メソッドを使う
  - 根拠: モジュールバンドラーでクラスが重複インスタンス化される環境でも正確な型判別を実現している（`packages/ai/src/registry/no-such-provider-error.ts:3-8`）

- `[SHOULD]` プロバイダーのファクトリ関数（`createOpenAI` 等）は callable な関数オブジェクトとして返し、デフォルトモデルタイプへのショートカットアクセスを提供する
  - 根拠: `openai('gpt-4o')` で直接モデルを取得でき、`openai.chat('gpt-4o')` や `openai.embedding('text-embedding-3-small')` で明示的なモデルタイプ指定もできる二段階 API が使いやすさと明確さを両立している（`packages/openai/src/openai-provider.ts:239-264`）

- `[AVOID]` プロバイダーインターフェースの低レベルメソッドに自然な名前を使うこと。意図的に `do` プレフィックスを付けて直接呼び出しを抑止する
  - 根拠: `doGenerate`、`doStream` の命名は「このメソッドは直接使うな」という意図を表現し、利用者を高レベル API（`generateText`、`streamText`）へ誘導している（`packages/provider/src/language-model/v3/language-model-v3.ts:43-44`）

## 適用チェックリスト

- [ ] 拡張ポイントのインターフェースにバージョンフィールド（`specificationVersion` 等）を含めているか
- [ ] 旧バージョンのインターフェースから新バージョンへのアダプター関数を用意しているか
- [ ] ミドルウェア/プラグインの適用結果が元のインターフェースと同じ型を返すか（透過的ラップ）
- [ ] ミドルウェアの各フックがオプショナルで、部分実装を許容しているか
- [ ] 複数ミドルウェアの適用順序が明確にドキュメント化されているか
- [ ] 実験的 API に `experimental_` プレフィックスを付け、安定化時の移行パスを用意しているか
- [ ] エラー型の判別が `instanceof` に依存せず、Symbol マーカーなどバンドラー耐性のある手法を使っているか
- [ ] 低レベル API に命名規約（`do` プレフィックス等）で直接利用を抑止しているか
- [ ] プロトコル統合（MCP 等）のトランスポート層がインターフェースで抽象化され、カスタム実装を差し込めるか
- [ ] 開発専用のミドルウェア/プラグインに環境ガード（本番での使用防止）が組み込まれているか
