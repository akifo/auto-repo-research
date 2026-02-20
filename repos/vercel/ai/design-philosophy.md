# design-philosophy

> リポジトリ: vercel/ai
> 分析日: 2026-02-20

## 概要

AI SDK の設計哲学を、統一インターフェース設計・プロバイダー非依存コア・技術選定の根拠の観点から分析した。このリポジトリは 50 以上の AI プロバイダーを単一の TypeScript SDK で扱うという野心的な目標を、4 層アーキテクチャ・バージョン付き仕様インターフェース・Symbol ベースのエラー識別という独自の設計判断で実現している。プロバイダー固有の機能を `providerOptions` という拡張ポイントに封じ込めることで、コア API の安定性とプロバイダーの自由度を両立させている点が特に注目に値する。

## 背景にある原則

- **仕様とユーティリティと実装の分離原則**: インターフェース仕様（`@ai-sdk/provider`）を最上流に置き、共有ユーティリティ（`@ai-sdk/provider-utils`）、具象プロバイダー（`@ai-sdk/<provider>`）、高レベル API（`ai`）の 4 層に分離する。仕様パッケージは他のパッケージに一切依存しないため、プロバイダーはコアの内部実装を知る必要がない。この分離により、プロバイダーの追加・変更がコア API に影響を与えない（`packages/provider/src/language-model/v3/language-model-v3.ts`、`contributing/provider-architecture.md`）。

- **最小表面積で最大拡張性の原則**: 仕様インターフェースは `doGenerate` と `doStream` の 2 メソッドのみを要求し、プロバイダー固有の機能は `providerOptions` として外出しにする。インターフェースを小さく保つことで新プロバイダーの実装コストを下げつつ、`providerOptions` で任意の拡張を可能にしている（`packages/provider/src/shared/v3/shared-v3-provider-options.ts`）。

- **バージョン付き進化の原則**: すべてのモデルインターフェースに `specificationVersion` フィールドを持たせ、discriminated union として扱う。v2 から v3 への移行は Proxy ベースのアダプタで透過的に処理される。これにより、破壊的変更を導入しつつ既存プロバイダーの動作を保証する（`packages/ai/src/model/as-language-model-v3.ts`、`packages/provider/src/language-model/v3/language-model-v3.ts:13`）。

- **境界防御の原則**: パッケージ境界・ランタイム境界・バージョン境界をまたぐ箇所に防御策を集中配置する。`JSON.parse` の代わりに `secureJsonParse`（prototype pollution 対策）、`instanceof` の代わりに Symbol ベースの marker パターン（パッケージバージョン間の互換性）、`Promise` の代わりに `PromiseLike`（任意の thenable を受容）を採用する（`packages/provider-utils/src/secure-json-parse.ts`、`packages/provider/src/errors/ai-sdk-error.ts`）。

## 実例と分析

### 統一インターフェースによるプロバイダー非依存コア

コア関数 `generateText` は `LanguageModelV3` インターフェースのみに依存する。50 以上のプロバイダーのどれを渡しても同じコードパスで動作する。

```typescript
// packages/ai/src/generate-text/generate-text.ts:1-6
import {
  LanguageModelV3,
  LanguageModelV3Content,
  LanguageModelV3ToolCall,
  LanguageModelV3ToolChoice,
} from "@ai-sdk/provider";
```

```typescript
// packages/ai/src/generate-text/generate-text.ts:1088
const result = await stepModel.doGenerate({
  ...callSettings,
  tools: stepTools,
  toolChoice: stepToolChoice,
  // ...
});
```

コアが呼ぶのは `doGenerate` / `doStream` だけであり、プロバイダーの内部実装には一切触れない。

### "do" プレフィクスによる API 階層の明示

`LanguageModelV3` のメソッドは `doGenerate` / `doStream` と命名されている。コメントに設計意図が明記されている。

```typescript
// packages/provider/src/language-model/v3/language-model-v3.ts:43-46
/**
 * Naming: "do" prefix to prevent accidental direct usage of the method
 * by the user.
 */
doGenerate(
  options: LanguageModelV3CallOptions,
): PromiseLike<LanguageModelV3GenerateResult>;
```

ユーザーが呼ぶべきは `generateText()` / `streamText()` であり、低レベルの `doGenerate` は直接呼ばれることを意図していない。プレフィクスの命名規約で「これは内部 API」という意図を型レベルでも読み取れるようにしている。

### Symbol ベースの marker パターンによるエラー識別

`instanceof` はパッケージの重複インストールやバンドラーの挙動で破綻するため、Symbol.for を使った marker パターンで代替している。

```typescript
// packages/provider/src/errors/ai-sdk-error.ts:5-6
const marker = 'vercel.ai.error';
const symbol = Symbol.for(marker);

// packages/provider/src/errors/ai-sdk-error.ts:13
private readonly [symbol] = true; // used in isInstance

// packages/provider/src/errors/ai-sdk-error.ts:52-61
protected static hasMarker(error: unknown, marker: string): boolean {
  const markerSymbol = Symbol.for(marker);
  return (
    error != null &&
    typeof error === 'object' &&
    markerSymbol in error &&
    typeof error[markerSymbol] === 'boolean' &&
    error[markerSymbol] === true
  );
}
```

各エラークラスは固有の marker 文字列（`vercel.ai.error.AI_MyError`）を持ち、`static isInstance()` で型ガード付きの判定を提供する。`Symbol.for` はグローバルレジストリを使うため、パッケージバージョンが異なっても同じ Symbol が得られる。

### providerOptions による拡張ポイントの設計

プロバイダー固有のオプションはコアインターフェースの `providerOptions` フィールドとして通過する。型は `Record<string, JSONObject>` で、プロバイダー名をキーとする名前空間方式。

```typescript
// packages/provider/src/shared/v3/shared-v3-provider-options.ts:24
export type SharedV3ProviderOptions = Record<string, JSONObject>;
```

プロバイダー側では `parseProviderOptions` で自分の名前空間のオプションだけを Zod スキーマで検証・取得する。

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
  // Zod スキーマで検証
  const parsedProviderOptions = await safeValidateTypes<OPTIONS | undefined>({
    value: providerOptions[provider],
    schema,
  });
  // ...
}
```

これにより、Anthropic の `cacheControl` や OpenAI の responses 固有オプションなど、プロバイダー固有の機能をコア API を変更せずに追加できる。

### スキーマ抽象化層による Zod 3/4 デュアルサポート

`FlexibleSchema` 型がスキーマライブラリの差異を吸収する。

```typescript
// packages/provider-utils/src/schema.ts:72-76
export type FlexibleSchema<SCHEMA = any> =
  | Schema<SCHEMA>
  | LazySchema<SCHEMA>
  | ZodSchema<SCHEMA>
  | StandardSchema<SCHEMA>;
```

Zod 3 と 4 の判別は `_zod` プロパティの存在で行い、それぞれ専用の変換関数に分岐する。さらに Standard Schema にも対応し、将来の Valibot 等への拡張も見据えている。JSON Schema への変換は遅延評価（`lazySchema`）で不要な計算を避ける設計になっている。

### バージョン間互換アダプタ

v2 プロバイダーを v3 インターフェースで使うために Proxy ベースのアダプタを提供する。

```typescript
// packages/ai/src/model/as-language-model-v3.ts:27-53
return new Proxy(model, {
  get(target, prop: keyof LanguageModelV2) {
    switch (prop) {
      case "specificationVersion":
        return "v3";
      case "doGenerate":
        return async (...args: Parameters<LanguageModelV2["doGenerate"]>) => {
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

コア側は v3 だけを見ればよく、レガシープロバイダーの存在を意識しない。

## パターンカタログ

- **Adapter パターン** (分類: 構造)
  - 解決する問題: 異なる AI プロバイダー API を統一インターフェースで扱う
  - 適用条件: 複数の外部サービスを同じ抽象で扱いたい場合
  - コード例: `packages/openai/src/openai-provider.ts:143-265`（`createOpenAI` が `ProviderV3` を実装）
  - 注意点: プロバイダー固有機能は `providerOptions` に退避するため、型安全性がやや弱まる

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: テキスト生成・ストリーミング・画像生成等のアルゴリズムを差し替え可能にする
  - 適用条件: 同じインターフェースで異なる実装戦略を切り替えたい場合
  - コード例: `packages/provider/src/language-model/v3/language-model-v3.ts`（`doGenerate` / `doStream` が戦略メソッド）

- **Decorator パターン** (分類: 構造)
  - 解決する問題: モデルの振る舞いを非侵入的に拡張する
  - 適用条件: ロギング・キャッシュ・パラメータ変換等の横断的関心事を追加したい場合
  - コード例: `packages/ai/src/middleware/wrap-language-model.ts:22-38`（middleware による動的ラッピング）
  - 注意点: 複数 middleware 適用時の順序（最初が入力変換、最後がモデルに最も近い）に注意

- **Registry パターン** (分類: 生成)
  - 解決する問題: 文字列 ID からプロバイダーとモデルを動的に解決する
  - 適用条件: 設定ファイルや UI からモデルを選択する場合
  - コード例: `packages/ai/src/registry/provider-registry.ts:94-125`

## Good Patterns

- **"do" プレフィクスによる内部 API の命名規約**: ユーザー向け API（`generateText`）と低レベル実装メソッド（`doGenerate`）を命名規約で区別する。型システムだけでは防げない「間違った API を直接呼ぶ」事故を、命名の不自然さで抑止する。
  ```typescript
  // packages/provider/src/language-model/v3/language-model-v3.ts:43-48
  // "do" prefix to prevent accidental direct usage
  doGenerate(options: LanguageModelV3CallOptions): PromiseLike<LanguageModelV3GenerateResult>;
  doStream(options: LanguageModelV3CallOptions): PromiseLike<LanguageModelV3StreamResult>;
  ```

- **名前空間付き providerOptions による Open-Closed 拡張**: コアインターフェースを変更せずにプロバイダー固有機能を追加できる。名前空間キー（プロバイダー名）で衝突を防ぎ、各プロバイダーが自身のオプションだけを Zod スキーマで検証する。
  ```typescript
  // ユーザーコード
  const result = await generateText({
    model: anthropic("claude-3-opus"),
    prompt: "Hello",
    providerOptions: {
      anthropic: { cacheControl: { type: "ephemeral" } },
    },
  });
  ```

- **設定の 2 段フォールバック（引数 > 環境変数）**: `loadApiKey` / `loadSetting` は明示的な引数を優先し、なければ環境変数にフォールバックする。Edge Runtime（`process` が存在しない）でも適切なエラーメッセージを出す。
  ```typescript
  // packages/provider-utils/src/load-api-key.ts:14-16
  if (typeof apiKey === "string") {
    return apiKey;
  }
  // ... process.env にフォールバック
  ```

- **PromiseLike による最小制約インターフェース**: 仕様インターフェースの戻り値型を `Promise` ではなく `PromiseLike` にすることで、任意の thenable 実装を受け入れる。これにより `async function` の強制やカスタム Promise ライブラリへの依存を避けている。

## Anti-Patterns / 注意点

- **生の JSON.parse 使用**: prototype pollution 攻撃に対して脆弱。外部 API レスポンスを `JSON.parse` で直接パースすると、`__proto__` や `constructor.prototype` を含む悪意あるペイロードでオブジェクトの動作を改竄される可能性がある。
  ```typescript
  // Bad
  const data = JSON.parse(responseText);

  // Better
  import { parseJSON, safeParseJSON } from "@ai-sdk/provider-utils";
  const data = await parseJSON({ text: responseText, schema: mySchema });
  ```

- **instanceof によるクロスパッケージ型判定**: npm の重複インストールやバンドラーの tree-shaking で同一クラスの異なるインスタンスが存在すると `instanceof` が false を返す。モノレポやライブラリ開発では特に発生しやすい。
  ```typescript
  // Bad
  if (error instanceof AISDKError) { ... }

  // Better
  if (AISDKError.isInstance(error)) { ... }
  ```

- **スキーマバリデーションなしの providerOptions 使用**: providerOptions を型アサーションで直接アクセスすると、ランタイムエラーの原因になる。必ず `parseProviderOptions` を介して Zod スキーマで検証する。
  ```typescript
  // Bad
  const opts = providerOptions?.openai as OpenAIOptions;

  // Better
  const opts = await parseProviderOptions({
    provider: "openai",
    providerOptions,
    schema: openaiOptionsSchema,
  });
  ```

## 導出ルール

- `[MUST]` 多バージョン共存が必要なライブラリでは、`instanceof` の代わりに `Symbol.for` ベースの marker パターンでインスタンス判定する
  - 根拠: AI SDK は `Symbol.for(marker)` + `static isInstance()` で、パッケージバージョンが異なっても正しくエラー型を判定している（`packages/provider/src/errors/ai-sdk-error.ts:5-61`）

- `[MUST]` 外部入力の JSON パースには prototype pollution 対策を施した安全なパーサーを使う（生の `JSON.parse` を禁止する）
  - 根拠: AI SDK は `secureJsonParse` で `__proto__` / `constructor.prototype` を検出・排除しており、CONTRIBUTING やコーディング規約でも `JSON.parse` 禁止を明文化している（`packages/provider-utils/src/secure-json-parse.ts`）

- `[SHOULD]` プラグイン/プロバイダーの拡張ポイントは、コアインターフェースに名前空間付きの汎用フィールド（`Record<string, JSONObject>` 型）を設け、プラグイン側でスキーマ検証する
  - 根拠: AI SDK の `providerOptions` は `SharedV3ProviderOptions = Record<string, JSONObject>` で、各プロバイダーが `parseProviderOptions` で自身の名前空間だけを Zod スキーマで検証する（`packages/provider-utils/src/parse-provider-options.ts`）

- `[SHOULD]` ユーザーに直接呼ばれるべきでない低レベルメソッドには、不自然なプレフィクス（`do-`、`_`、`internal-` 等）を付けて誤用を抑止する
  - 根拠: AI SDK は `doGenerate` / `doStream` の `do` プレフィクスで「これはユーザー向けではない」というシグナルを送り、コメントにも設計意図を明記している（`packages/provider/src/language-model/v3/language-model-v3.ts:43-46`）

- `[SHOULD]` インターフェースのバージョンを `specificationVersion` のようなリテラル型フィールドで明示し、discriminated union として扱う
  - 根拠: AI SDK は v2/v3 をリテラル型で区別し、Proxy ベースのアダプタで透過的に変換する。コアは最新バージョンのみを扱えばよい設計になっている（`packages/ai/src/model/resolve-model.ts:24-39`）

- `[SHOULD]` 仕様インターフェースの戻り値型は `Promise` ではなく `PromiseLike` にして、実装側の自由度を最大化する
  - 根拠: `LanguageModelV3` の全メソッドが `PromiseLike` を返す設計になっており、カスタム thenable や同期的な値のラッピングも受け入れる（`packages/provider/src/language-model/v3/language-model-v3.ts`）

- `[AVOID]` 設定値のロード元をコード内にハードコードする。引数 > 環境変数 > デフォルト値の優先順位で解決するユーティリティを共有する
  - 根拠: AI SDK は `loadApiKey` / `loadSetting` / `loadOptionalSetting` で設定ロードを一元化し、Edge Runtime 等の `process` が存在しない環境でも適切なエラーメッセージを出す（`packages/provider-utils/src/load-api-key.ts`）

## 適用チェックリスト

- [ ] プラグイン/プロバイダーパターンを採用する場合、仕様インターフェース（型定義のみ）を独立パッケージに分離しているか
- [ ] 仕様インターフェースに `specificationVersion` のようなバージョンフィールドを含めているか
- [ ] `instanceof` の代わりに `Symbol.for` ベースの判定メソッドを提供しているか（特にライブラリ開発時）
- [ ] 外部入力（API レスポンス等）の JSON パースに prototype pollution 対策を施しているか
- [ ] プロバイダー固有の拡張は名前空間付きの汎用フィールドで受け渡し、プロバイダー側でスキーマ検証しているか
- [ ] 設定値（API キー等）は引数優先・環境変数フォールバックの 2 段構成になっているか
- [ ] 内部 API と公開 API の命名規約を区別し、ドキュメントまたはコメントで意図を明示しているか
- [ ] インターフェースの戻り値型が実装を不必要に制約していないか（`Promise` vs `PromiseLike`）
