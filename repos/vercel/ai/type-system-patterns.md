# 型システムパターン

> リポジトリ: vercel/ai
> 分析日: 2026-02-20

## 概要

Vercel AI SDK の型設計を横断的に分析し、マルチプロバイダー対応・バージョン進化・スキーマ柔軟性を支える型レベルのプラクティスを抽出する。53 以上のパッケージに渡る巨大なモノレポで、プロバイダーインターフェース（`LanguageModelV3` 等）、判別共用体、テンプレートリテラル型によるレジストリ、`Symbol.for` ベースのエラー型ガード、複数スキーマライブラリの統一抽象といった、型安全な拡張性を実現する手法が体系的に使われている。

## 背景にある原則

- **インターフェースで境界を定義し、実装を自由にする**: プロバイダーが実装すべき契約は `type LanguageModelV3`（`packages/provider/src/language-model/v3/language-model-v3.ts`）のような純粋な型で定義し、`class` 継承を強制しない。これにより各プロバイダーが独自のクラス構成やコンフィグ方式を自由に採用でき、結合度を最小化している。
- **型にバージョンリテラルを埋め込み、破壊的変更を安全に管理する**: `specificationVersion: 'v3'` のようなリテラル型フィールドを全モデルインターフェースに持たせることで、v2/v3 の共存を判別共用体として扱い、ランタイムでの分岐とコンパイル時の型絞り込みを両立させている（`packages/ai/src/model/as-provider-v3.ts:10-14`）。
- **Provider-specific な拡張は型安全な拡張ポイントで吸収する**: `SharedV3ProviderOptions`（`Record<string, JSONObject>`）と `SharedV3ProviderMetadata` を全階層に配置し、コア型を変更せずにプロバイダー固有機能を追加できる。入力（Options）と出力（Metadata）を構造的に分離している。
- **スキーマの多様性を一段の抽象で統一する**: Zod 3、Zod 4、Standard Schema、JSON Schema、遅延スキーマを `FlexibleSchema<T>` 型で統合し、`InferSchema<T>` で型推論を一貫させている。ユーザーがどのスキーマライブラリを使っても同じ API を呼べる設計になっている。

## 実例と分析

### 判別共用体による型安全なストリーミング

`LanguageModelV3StreamPart` は `type` フィールドによる判別共用体で、ストリーム中のあらゆるイベントを型安全に処理する。`text-start`/`text-delta`/`text-end` のような三段階ライフサイクル、`tool-input-start`/`tool-input-delta`/`tool-input-end` のツール入力ストリーミング、メタデータ、エラーまで、単一の union 型に集約している。

```typescript
// packages/provider/src/language-model/v3/language-model-v3-stream-part.ts:12-106
export type LanguageModelV3StreamPart =
  | { type: "text-start"; id: string; providerMetadata?: SharedV3ProviderMetadata; }
  | { type: "text-delta"; id: string; delta: string; providerMetadata?: SharedV3ProviderMetadata; }
  | { type: "text-end"; id: string; providerMetadata?: SharedV3ProviderMetadata; }
  | { type: "reasoning-start"; id: string; providerMetadata?: SharedV3ProviderMetadata; }
  // ... 他のバリアント
  | { type: "finish"; usage: LanguageModelV3Usage; finishReason: LanguageModelV3FinishReason; }
  | { type: "error"; error: unknown; };
```

同様に `LanguageModelV3Message`（`packages/provider/src/language-model/v3/language-model-v3-prompt.ts:16-53`）は `role` フィールドで判別し、各ロールで許可されるコンテンツパーツ型を制限している。さらに `& { providerOptions?: SharedV3ProviderOptions }` で全バリアントに共通プロパティを intersection で付加する手法が使われている。

### テンプレートリテラル型によるレジストリ ID の型安全性

`ProviderRegistryProvider` は `KEY${SEPARATOR}${modelId}` 形式のテンプレートリテラル型で、`"openai:gpt-4"` のようなモデル ID 文字列を型レベルで検証する。

```typescript
// packages/ai/src/registry/provider-registry.ts:22-79
export interface ProviderRegistryProvider<
  PROVIDERS extends Record<string, ProviderV3> = Record<string, ProviderV3>,
  SEPARATOR extends string = ":",
> {
  languageModel<KEY extends keyof PROVIDERS>(
    id: KEY extends string
      ? `${KEY & string}${SEPARATOR}${ExtractLiteralUnion<Parameters<NonNullable<PROVIDERS[KEY]["languageModel"]>>[0]>}`
      : never,
  ): LanguageModelV3;
  // 2つ目のオーバーロードで string フォールバックを提供
  languageModel<KEY extends keyof PROVIDERS>(
    id: KEY extends string ? `${KEY & string}${SEPARATOR}${string}` : never,
  ): LanguageModelV3;
}
```

`ExtractLiteralUnion<T>` ヘルパーで `string` 全体を除外し、リテラル型のみを抽出するテクニックが使われている。

### Symbol.for によるクロスパッケージ型ガード

`instanceof` は同一パッケージの異なるバージョンが共存する環境で失敗する。AI SDK は `Symbol.for(marker)` でグローバルシンボルレジストリを使い、パッケージバージョン間でも安定した型判定を実現している。

```typescript
// packages/provider/src/errors/ai-sdk-error.ts:5-61
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
      error != null
      && typeof error === "object"
      && markerSymbol in error
      && typeof error[markerSymbol] === "boolean"
      && error[markerSymbol] === true
    );
  }
}
```

各サブクラス（`NoSuchModelError`, `TypeValidationError` 等 15 種以上）が独自のマーカー文字列（`vercel.ai.error.AI_NoSuchModelError` 等）を持ち、階層的な `isInstance` チェックを可能にしている。

### FlexibleSchema による多スキーマライブラリ統一

```typescript
// packages/provider-utils/src/schema.ts:72-87
export type FlexibleSchema<SCHEMA = any> =
  | Schema<SCHEMA>
  | LazySchema<SCHEMA>
  | ZodSchema<SCHEMA>
  | StandardSchema<SCHEMA>;

export type InferSchema<SCHEMA> = SCHEMA extends ZodSchema<infer T> ? T
  : SCHEMA extends StandardSchema<infer T> ? T
  : SCHEMA extends LazySchema<infer T> ? T
  : SCHEMA extends Schema<infer T> ? T
  : never;
```

`asSchema()` 関数がランタイムで `~standard` in schema をチェックし、vendor 判定で Zod かその他の Standard Schema かを分岐する。`generateObject` の型パラメータ `SCHEMA extends FlexibleSchema<unknown>` により、ユーザーが Zod オブジェクトをそのまま渡しても型推論が機能する。

### 条件付き型による Output モード推論

`generateObject` は出力モードに応じて `RESULT` 型パラメータを条件付きで推論する。

```typescript
// packages/ai/src/generate-object/generate-object.ts:113-123
export async function generateObject<
  SCHEMA extends FlexibleSchema<unknown> = FlexibleSchema<JSONValue>,
  OUTPUT extends 'object' | 'array' | 'enum' | 'no-schema' =
    InferSchema<SCHEMA> extends string ? 'enum' : 'object',
  RESULT = OUTPUT extends 'array'
    ? Array<InferSchema<SCHEMA>>
    : InferSchema<SCHEMA>,
>
```

`OUTPUT` のデフォルト値が `SCHEMA` から推論された型に基づいて決まり、`RESULT` がさらに `OUTPUT` から導出される三段階の型推論チェーンになっている。

### `do` プレフィックスによる内部 API の区別

モデルインターフェースのメソッドには `doGenerate`、`doStream`、`doEmbed` のように `do` プレフィックスが付けられている。

```typescript
// packages/provider/src/language-model/v3/language-model-v3.ts:46-47
// Naming: "do" prefix to prevent accidental direct usage of the method by the user.
doGenerate(options: LanguageModelV3CallOptions): PromiseLike<LanguageModelV3GenerateResult>;
```

これは型レベルのアクセス制御ではなく命名規約だが、「プロバイダー実装者が実装するメソッド」と「SDK ユーザーが呼ぶ関数（`generateText` 等）」を区別するという設計意図がコメントに明記されている。

### グローバル宣言マージによるモデル ID 拡張

```typescript
// packages/ai/src/types/language-model.ts:9-52
declare global {
  interface RegisteredProviderModels {}
}

export type GlobalProviderModelId = [keyof RegisteredProviderModels] extends [never] ? GatewayModelId
  : keyof RegisteredProviderModels | RegisteredProviderModels[keyof RegisteredProviderModels];

export type LanguageModel = GlobalProviderModelId | LanguageModelV3 | LanguageModelV2;
```

`[keyof T] extends [never]` で空インターフェースを検出し、拡張がなければデフォルトの `GatewayModelId` にフォールバックする。サードパーティが declaration merging でモデル ID を登録すると自動的に型補完に反映される。

## パターンカタログ

- **Strategy パターン** (振る舞い)
  - 解決する問題: 出力フォーマット（object / array / enum / no-schema）ごとにバリデーション・ストリーム生成のアルゴリズムを切り替える
  - 適用条件: 同じインターフェースで複数のアルゴリズムを入れ替える必要がある場面
  - コード例: `packages/ai/src/generate-object/output-strategy.ts:30-63` — `OutputStrategy<PARTIAL, RESULT, ELEMENT_STREAM>` interface
  - 注意点: 型パラメータが 3 つあり、各 Strategy 実装が正しく具体化する必要がある

- **Adapter パターン** (構造)
  - 解決する問題: v2 プロバイダーを v3 インターフェースで透過的に利用する
  - 適用条件: インターフェースのバージョンが共存する移行期
  - コード例: `packages/ai/src/model/as-provider-v3.ts:8-36` — `asProviderV3()` が v2 を v3 にラップ
  - 注意点: 変換関数 (`asLanguageModelV3` 等) をモデル種類ごとに用意する必要がある

- **Decorator / Middleware パターン** (振る舞い)
  - 解決する問題: モデルの振る舞いを非侵入的に拡張する（ログ、パラメータ変換、レート制限等）
  - 適用条件: モデル呼び出しの前後に処理を挟みたいが、モデル実装を変更したくない場合
  - コード例: `packages/ai/src/middleware/wrap-language-model.ts:22-38` — `wrapLanguageModel` が `LanguageModelV3` を返す
  - 注意点: 入出力型が変わらない（同じ `LanguageModelV3` を返す）ことが型安全性の鍵

## Good Patterns

- **リテラル型バージョンフィールドで判別共用体を構成する**: `specificationVersion: 'v3'` をすべてのモデル型・プロバイダー型・ミドルウェア型に持たせることで、バージョン間の安全な分岐と段階的マイグレーションを可能にしている。`type` ではなく `specificationVersion` という専用フィールドにすることで、他の判別フィールド（`type: 'text'` 等）と衝突しない。

```typescript
// packages/provider/src/language-model/v3/language-model-v3.ts:12
readonly specificationVersion: 'v3';
// packages/ai/src/model/as-provider-v3.ts:10-14 (ランタイム分岐)
if ('specificationVersion' in provider && provider.specificationVersion === 'v3') {
  return provider;
}
```

- **Input(Options) と Output(Metadata) を対称的に型定義する**: `SharedV3ProviderOptions`（入力）と `SharedV3ProviderMetadata`（出力）を同じ `Record<string, JSONObject>` 構造で対称的に定義し、プロバイダー名をキーとするネストで名前空間衝突を回避している。

```typescript
// packages/provider/src/shared/v3/shared-v3-provider-options.ts:24
export type SharedV3ProviderOptions = Record<string, JSONObject>;
// packages/provider/src/shared/v3/shared-v3-provider-metadata.ts:24
export type SharedV3ProviderMetadata = Record<string, JSONObject>;
```

- **`NeverOptional` 条件付き型で `any`/`never` を安全に処理する**: ツール定義で `OUTPUT` が `any` や `never` の場合に `execute` を省略可能にするヘルパー型。

```typescript
// packages/provider-utils/src/types/tool.ts:75-79
type NeverOptional<N, T> = 0 extends 1 & N ? Partial<T> // N が any のとき
  : [N] extends [never] ? Partial<Record<keyof T, undefined>> // N が never のとき
  : T; // 通常の型のとき
```

## Anti-Patterns / 注意点

- **判別共用体の判別フィールドに `string` 全体を許容する**: `type: string` のような広い型を判別フィールドにすると、型の絞り込みが機能しない。AI SDK では `type: 'text' | 'file' | 'reasoning'` のようにリテラル型の union で定義しているが、`LanguageModelV3FinishReason` は `unified` と `raw` を分離し、`raw: string | undefined` は判別に使わない設計にしている。

```typescript
// Bad: 判別に使えない
type Event = { type: string; data: unknown; };

// Better: リテラル型で判別を有効にする
type Event =
  | { type: "text"; text: string; }
  | { type: "error"; error: unknown; };
```

- **拡張ポイントを `any` で定義する**: プロバイダー固有のオプションを `any` で受けると型安全性が失われる。AI SDK は `Record<string, JSONObject>` + `parseProviderOptions` による Zod バリデーションで、拡張ポイントに型安全性を持たせている。

```typescript
// Bad: 型安全性なし
providerOptions?: any;

// Better: 構造を制約しつつ拡張可能に
providerOptions?: Record<string, JSONObject>;
// + parseProviderOptions でランタイムバリデーション
```

- **`instanceof` をパッケージ境界を超えて使う**: モノレポや複数バージョン共存環境では `instanceof` が信頼できない。

```typescript
// Bad: パッケージバージョンが異なると false になる
if (error instanceof AISDKError) { ... }

// Better: Symbol.for ベースのマーカーチェック
if (AISDKError.isInstance(error)) { ... }
```

## 導出ルール

- `[MUST]` 判別共用体の判別フィールドはリテラル型の union で定義する — `string` 全体を許容すると型絞り込みが機能しない
  - 根拠: `LanguageModelV3StreamPart` は `type` フィールドに 15 以上のリテラル型を使い、switch/case で型安全に分岐している（`language-model-v3-stream-part.ts`）
- `[MUST]` パッケージ境界を超えるエラー判定には `instanceof` ではなく `Symbol.for` ベースのマーカーパターンを使う
  - 根拠: AI SDK は 15 以上のエラークラスすべてに `Symbol.for(marker)` + `isInstance` を実装し、マルチバージョン環境での安定した型ガードを保証している（`ai-sdk-error.ts:5-61`）
- `[SHOULD]` 複数のスキーマライブラリをサポートする場合、union 型 + 条件付き推論型で統一的な抽象層を作る
  - 根拠: `FlexibleSchema` が Zod 3/4、Standard Schema、JSON Schema を統合し、`InferSchema<T>` で一貫した型推論を提供している（`schema.ts:72-87`）
- `[SHOULD]` バージョン付きインターフェースにはリテラル型の `specificationVersion` フィールドを含め、判別共用体として扱えるようにする
  - 根拠: `LanguageModelV3`, `ProviderV3`, `LanguageModelV3Middleware` すべてが `specificationVersion: 'v3'` を持ち、v2 との共存と段階的移行を実現している
- `[SHOULD]` プロバイダー固有の拡張データは、プロバイダー名をキーとする `Record<string, JSONObject>` 型で受け、ランタイムで Zod バリデーションする
  - 根拠: `SharedV3ProviderOptions` + `parseProviderOptions`（`parse-provider-options.ts`）で型安全な拡張ポイントを実現している
- `[SHOULD]` テンプレートリテラル型で文字列 ID のフォーマットをコンパイル時に検証する
  - 根拠: `ProviderRegistryProvider` が `${KEY}${SEPARATOR}${modelId}` 形式を型レベルで強制し、不正なモデル ID をコンパイル時に検出する（`provider-registry.ts:26-33`）
- `[AVOID]` 内部実装メソッドとパブリック API を同じ命名規則で公開する — プレフィックスや命名規約でレイヤーの違いを明示する
  - 根拠: `doGenerate`/`doStream` の `do` プレフィックスは「プロバイダー実装者向けメソッド」と「SDK ユーザー向け関数（`generateText`）」を命名レベルで区別している（`language-model-v3.ts:43-47`）

## 適用チェックリスト

- [ ] マルチプロバイダー/プラグインアーキテクチャで、プロバイダーの契約を `type` または `interface` で定義し、クラス継承を強制していないか確認する
- [ ] バージョン進化が予想されるインターフェースに `specificationVersion` のようなリテラル型フィールドを追加し、判別共用体として扱えるようにする
- [ ] パッケージを跨いで `instanceof` を使っている箇所を `Symbol.for` ベースのマーカーパターンに置き換える
- [ ] 拡張ポイント（プラグインオプション等）を `any` ではなく `Record<string, JSONObject>` + ランタイムバリデーションで型安全にする
- [ ] 複数のスキーマライブラリをサポートする必要がある場合、`FlexibleSchema` のような union 型 + `InferSchema` のような条件付き推論型を導入する
- [ ] 判別共用体の `type` フィールドがリテラル型 union で定義されており、`string` 全体を許容していないか確認する
- [ ] 内部 API とパブリック API の命名が区別されているか確認する（`do` プレフィックス等）
- [ ] 型テストファイル（`.test-d.ts`）を用意し、型推論の正しさを CI で検証しているか確認する
