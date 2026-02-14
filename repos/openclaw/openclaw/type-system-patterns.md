# 型システムパターン

> リポジトリ: openclaw/openclaw
> 分析日: 2026-02-14

## 概要

openclaw/openclaw は TypeBox・Zod・AJV の3つの型バリデーションライブラリを境界ごとに使い分け、さらに TypeBox スキーマから JSON Schema を経由して Swift コードを自動生成するパイプラインを持つ。この「スキーマ定義を単一の情報源（Single Source of Truth）として複数の成果物を導出する」パターンは、WebSocket プロトコル・設定ファイル・AI ツール呼び出し・クロスプラットフォームクライアントという4つの型安全境界を1つのコードベースで一貫して管理するために設計されている。特に注目に値するのは、LLM プロバイダー（OpenAI, Claude/Vertex AI, Google）が JSON Schema のサブセットしか受け付けないという実運用上の制約が、型設計の意思決定を直接左右している点である。

## 背景にある原則

- **境界ごとにバリデーションライブラリを選択すべき、なぜならランタイム特性と要件が異なるから**: TypeBox はJSON Schema 互換のため WebSocket プロトコル（AJV でバリデーション）とツールスキーマ（LLM に渡す）に使い、Zod は TypeScript ネイティブな設定バリデーション（`superRefine` でクロスフィールド検証）に使う。1つのライブラリで全てを賄おうとせず、各境界の要件に最適なツールを選んでいる（`src/gateway/protocol/schema/` は TypeBox、`src/config/zod-schema*.ts` は Zod）。

- **スキーマは型とバリデーションの両方を導出する唯一の情報源とすべき、なぜなら型定義とバリデーションの乖離はランタイムエラーの温床だから**: TypeBox の `Static<typeof Schema>` で型を導出し（`src/gateway/protocol/schema/types.ts` で全プロトコル型を一括導出）、同じスキーマを AJV でコンパイルしてバリデーション関数を生成する（`src/gateway/protocol/index.ts:233-319`）。型とバリデーションが同一のスキーマから派生するため、両者が乖離する余地がない。

- **外部システムの制約は設計の一級市民として扱うべき、なぜなら実運用で最も壊れやすいのは外部境界だから**: LLM プロバイダーが `anyOf`/`oneOf`/`allOf` を拒否するという制約を AGENTS.md にガードレールとして明文化し、`Type.Union` の代わりに `stringEnum`（`Type.Unsafe` ベース）を標準ヘルパーとして提供している（`src/agents/schema/typebox.ts:15-24`）。

- **クロスプラットフォーム型同期はコード生成で保証すべき、なぜなら手動同期は規模に比例して破綻するから**: TypeBox スキーマ → JSON Schema → Swift 構造体という生成パイプライン（`scripts/protocol-gen-swift.ts`）により、TypeScript 側のプロトコル変更が自動的に iOS/macOS クライアントに反映される。

## 実例と分析

### ライブラリの境界別使い分け

コードベースは3つのバリデーションライブラリを明確な役割分担で使い分けている。

**TypeBox（56ファイル）**: WebSocket プロトコルスキーマ定義（`src/gateway/protocol/schema/`）とエージェントツールの入力スキーマ（`src/agents/tools/`）。JSON Schema との互換性が必要な箇所で一貫して使用。

**Zod（31ファイル）**: 設定ファイルバリデーション（`src/config/zod-schema*.ts`）とプラグイン設定スキーマ（`extensions/*/src/config-schema.ts`）、OpenResponses API スキーマ（`src/gateway/open-responses.schema.ts`）。`superRefine` によるクロスフィールド検証や `z.registry` による機密フィールドマーキングなど、TypeScript ネイティブな高度機能が必要な箇所で使用。

**AJV**: TypeBox スキーマをランタイムバリデーションにコンパイル（`src/gateway/protocol/index.ts`）。プラグイン設定の JSON Schema バリデーション（`src/plugins/schema-validator.ts`）。

### LLM プロバイダー制約に適応したスキーマ設計

LLM にツールスキーマを渡す際、`Type.Union([Type.Literal(...)])` は `anyOf` にコンパイルされ、Claude API（Vertex AI）や OpenAI が拒否する。この問題に対する解決策として `stringEnum` ヘルパーが設計されている。

```typescript
// src/agents/schema/typebox.ts:13-24
// NOTE: Avoid Type.Union([Type.Literal(...)]) which compiles to anyOf.
// Some providers reject anyOf in tool schemas; a flat string enum is safer.
export function stringEnum<T extends readonly string[]>(
  values: T,
  options: StringEnumOptions<T> = {},
) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...options,
  });
}
```

`Type.Unsafe` を使うことで JSON Schema 出力を直接制御しつつ、TypeScript 側では `T[number]` で正しいリテラルユニオン型を得ている。この手法は browser-tool のスキーマで広く適用されている。

```typescript
// src/agents/tools/browser-tool.schema.ts:45-50
// NOTE: Using a flattened object schema instead of Type.Union([Type.Object(...), ...])
// because Claude API on Vertex AI rejects nested anyOf schemas as invalid JSON Schema.
// The discriminator (kind) determines which properties are relevant; runtime validates.
const BrowserActSchema = Type.Object({
  kind: stringEnum(BROWSER_ACT_KINDS),
  // ...全 kind の properties をフラットに並べる
});
```

本来は kind ごとに別の Type.Object を Type.Union で束ねるのが型的には正確だが、LLM の JSON Schema 制約のため意図的にフラットなオブジェクトにしている。型の厳密性よりも実運用の互換性を優先した設計判断である。

### Schema-First プロトコル設計と型導出

プロトコルスキーマは TypeBox で定義し、型は `Static<typeof>` で機械的に導出する。

```typescript
// src/gateway/protocol/schema/types.ts:133-134
export type ConnectParams = Static<typeof ConnectParamsSchema>;
export type HelloOk = Static<typeof HelloOkSchema>;
// ...241行にわたり全プロトコル型を同じパターンで導出
```

AJV バリデーション関数も同じスキーマからコンパイルされ、型パラメータとして同じ導出型が使われる。

```typescript
// src/gateway/protocol/index.ts:233-234
export const validateConnectParams = ajv.compile<ConnectParams>(ConnectParamsSchema);
export const validateRequestFrame = ajv.compile<RequestFrame>(RequestFrameSchema);
```

### Zod による設定バリデーションの階層的分割

設定スキーマは機能ドメインごとにファイル分割され、合成される。

```
src/config/
├── zod-schema.ts              # ルートスキーマ（OpenClawSchema）
├── zod-schema.core.ts         # モデル定義、TTS、メディア等
├── zod-schema.agents.ts       # エージェント設定
├── zod-schema.agent-runtime.ts # エージェントランタイム設定
├── zod-schema.agent-defaults.ts # エージェントデフォルト
├── zod-schema.providers-core.ts # チャネルプロバイダー
├── zod-schema.hooks.ts        # Webhook フック
├── zod-schema.session.ts      # セッション設定
├── zod-schema.sensitive.ts    # 機密フィールドレジストリ
└── ...
```

特筆すべきは Zod 4 の `z.registry` を使った機密フィールドのマーキングパターンである。

```typescript
// src/config/zod-schema.sensitive.ts:5
export const sensitive = z.registry<undefined, z.ZodType>();

// src/config/zod-schema.core.ts:60（使用例）
apiKey: z.string().optional().register(sensitive),
```

このレジストリを使って設定をダッシュボードに公開する際に自動的に機密値をリダクトする仕組みを実現している。スキーマ定義の時点で機密性を宣言できるため、バリデーションロジックとセキュリティポリシーが一体化している。

### TypeBox → JSON Schema → Swift コード生成パイプライン

```typescript
// scripts/protocol-gen.ts:9-41
async function writeJsonSchema() {
  const definitions: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(ProtocolSchemas)) {
    definitions[name] = schema;
  }
  const rootSchema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    // ...
    definitions,
  };
  await fs.writeFile(jsonSchemaPath, JSON.stringify(rootSchema, null, 2));
}
```

TypeBox スキーマは JSON Schema 互換のため、`ProtocolSchemas` レコードをそのまま `definitions` に注入して JSON Schema ファイルを出力。さらに `protocol-gen-swift.ts` がこのスキーマを読み取り、Swift の `Codable` 構造体を生成する。

```typescript
// scripts/protocol-gen-swift.ts:113-155（Swift 構造体生成）
function emitStruct(name: string, schema: JsonSchema): string {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  lines.push(`public struct ${name}: Codable, Sendable {`);
  // ...プロパティ定義、CodingKeys、init メソッドを自動生成
}
```

### プラグイン設定の型安全な拡張

プラグイン（extensions）は `openclaw/plugin-sdk` から共通スキーマをインポートし、独自の設定スキーマを定義する。

```typescript
// extensions/matrix/src/config-schema.ts:1-2
import { MarkdownConfigSchema, ToolPolicySchema } from "openclaw/plugin-sdk";
import { z } from "zod";
```

プラグインの設定バリデーションは AJV（JSON Schema）で行われる（`src/plugins/schema-validator.ts`）。Zod スキーマで定義された設定と JSON Schema で検証されるプラグイン設定が共存する設計である。

## パターンカタログ

- **Adapter パターン** (構造)
  - 解決する問題: LLM プロバイダーが標準的な JSON Schema の全機能を受け付けない
  - 適用条件: 外部システムが受け入れるスキーマフォーマットに制約がある場合
  - コード例: `src/agents/schema/typebox.ts:15-24`（`stringEnum` が TypeBox と LLM 間のアダプタとして機能）
  - 注意点: `Type.Unsafe` は型安全性を部分的に放棄するため、ヘルパー関数に封じ込めてプロジェクト全体で再利用する

- **Registry パターン** (振る舞い)
  - 解決する問題: スキーマ定義時にメタデータ（機密性など）を付与し、後続処理で参照したい
  - 適用条件: スキーマにバリデーション以外の横断的関心事を紐づける必要がある場合
  - コード例: `src/config/zod-schema.sensitive.ts:5`（`z.registry` による機密フィールド登録）
  - 注意点: Zod 4 固有の機能。他のバリデーションライブラリでは同等の仕組みが必要

## Good Patterns

- **Schema-First Type Derivation（スキーマ駆動型導出）**: スキーマを定義し、`Static<typeof>` や `z.infer<typeof>` で型を導出する。型とバリデーションが乖離しない。

```typescript
// src/gateway/protocol/schema/types.ts:133
export type ConnectParams = Static<typeof ConnectParamsSchema>;
```

- **LLM-Compatible Enum Helper（LLM 互換列挙ヘルパー）**: `Type.Union([Type.Literal(...)])` の代わりに `Type.Unsafe` でフラットな string enum を生成するヘルパーを全ツールで共有する。型安全性と外部互換性を両立。

```typescript
// src/agents/schema/typebox.ts:15-24
export function stringEnum<T extends readonly string[]>(values: T, options = {}) {
  return Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...options });
}
```

- **Flattened Discriminated Object（フラット化された判別オブジェクト）**: Union の代わりに全バリアントの properties をフラット化した単一 Object に `discriminator` フィールドを持たせる。ランタイムで discriminator に基づきバリデーション。

```typescript
// src/agents/tools/browser-tool.schema.ts:48-78
const BrowserActSchema = Type.Object({
  kind: stringEnum(BROWSER_ACT_KINDS),
  targetId: Type.Optional(Type.String()),
  text: Type.Optional(Type.String()),
  // ...kind ごとの properties をフラットに配置
});
```

- **Sensitive Field Registry（機密フィールドレジストリ）**: スキーマ定義時に `.register(sensitive)` で機密性を宣言。設定公開時に自動リダクト。

```typescript
// src/config/zod-schema.core.ts:60
apiKey: z.string().optional().register(sensitive),
```

## Anti-Patterns / 注意点

- **手動型定義とスキーマの二重管理**: `OpenClawConfig` 型は手動で定義された interface（`src/config/types.openclaw.ts`）であり、Zod スキーマ（`src/config/zod-schema.ts`）とは別に維持されている。`z.infer<typeof OpenClawSchema>` による自動導出ではないため、型定義とスキーマの同期は開発者の注意に依存する。

```typescript
// Bad: 手動型定義とスキーマが別々に管理される
// src/config/types.openclaw.ts:28
export type OpenClawConfig = {
  meta?: { lastTouchedVersion?: string; lastTouchedAt?: string; };
  // ...100行にわたる手動型定義
};

// Better: スキーマから型を自動導出する
export type OpenClawConfig = z.infer<typeof OpenClawSchema>;
```

ただし、このリポジトリでは設定型がコードベース全体で広く参照されており、Zod の推論型が複雑になりすぎる場合や IDE パフォーマンスの観点から、意図的に手動管理している可能性がある。

- **Type.Union の不統一な使い方**: AGENTS.md は `Type.Union` の回避を明記しているが、プロトコルスキーマ（内部用途）では `Type.Union` がそのまま使われている（例: `src/gateway/protocol/schema/frames.ts:161`）。用途に応じた使い分け自体は正当だが、どこで `Type.Union` を使ってよいかの判断基準がコードコメントに散在しており、統一的なドキュメントがない。

```typescript
// 内部プロトコル用（AJV バリデーション） — OK
// src/gateway/protocol/schema/frames.ts:161
export const GatewayFrameSchema = Type.Union(
  [RequestFrameSchema, ResponseFrameSchema, EventFrameSchema],
  { discriminator: "type" },
);

// ツールスキーマ（LLM に渡す） — NG: anyOf になる
// 代わりに stringEnum や Flattened Object を使う
```

## 導出ルール

- `[MUST]` ランタイムバリデーションスキーマと TypeScript 型は同一の定義から導出する（`Static<typeof>` / `z.infer<typeof>` を使う）
  - 根拠: openclaw は `src/gateway/protocol/schema/types.ts` で241行にわたり全プロトコル型を `Static<typeof Schema>` で導出し、型とバリデーションの乖離をゼロにしている

- `[MUST]` 外部システム（LLM API、モバイルクライアント等）に渡すスキーマの制約は、ヘルパー関数に封じ込めてプロジェクト全体で共有する
  - 根拠: openclaw は `stringEnum` / `optionalStringEnum` を標準ヘルパーとして提供し、17以上のツール定義ファイルで一貫して使用している

- `[SHOULD]` バリデーションライブラリは用途（外部プロトコル / 内部設定 / クロスプラットフォーム生成）ごとに選択し、1つのライブラリに統一しようとしない
  - 根拠: openclaw は TypeBox（JSON Schema 互換が必要な境界）と Zod（TypeScript ネイティブな高度バリデーションが必要な境界）を明確に使い分け、各ライブラリの強みを活かしている

- `[SHOULD]` クロスプラットフォームの型同期にはスキーマ駆動のコード生成パイプラインを導入する
  - 根拠: `scripts/protocol-gen-swift.ts` が TypeBox スキーマから Swift の Codable 構造体を自動生成し、プロトコル変更時の手動同期を排除している

- `[SHOULD]` 設定スキーマに機密フィールドのメタデータを宣言的に付与し、公開時のリダクトを自動化する
  - 根拠: `z.registry` による `.register(sensitive)` パターンが設定スキーマ全体で30箇所以上使われ、API キー・トークン・パスワードの漏洩を構造的に防いでいる

- `[AVOID]` LLM に渡すツールスキーマで JSON Schema の `anyOf` / `oneOf` / `allOf` を使うこと — プロバイダーによって拒否される
  - 根拠: AGENTS.md に明記されたガードレールであり、Claude API（Vertex AI）と OpenAI が実際に拒否するケースが確認されている（`src/agents/tools/browser-tool.schema.ts:45-47` のコメント）

- `[AVOID]` 型安全性を損なう `Type.Unsafe` を個別のスキーマ定義で直接使うこと — 必ずヘルパー関数に封じ込める
  - 根拠: `Type.Unsafe` の直接使用は `src/channels/plugins/agent-tools/whatsapp-login.ts:12` など散発的に見られるが、`stringEnum` ヘルパー経由に統一されている箇所（`src/agents/tools/browser-tool.schema.ts`）の方が可読性・保守性が高い

## 適用チェックリスト

- [ ] プロジェクトの型安全境界（API、設定、外部サービス連携等）を列挙し、各境界に適したバリデーションライブラリを選択しているか確認する
- [ ] ランタイムバリデーションスキーマと TypeScript 型が同一の定義から導出されているか確認する（手動で型を定義してスキーマと別管理していないか）
- [ ] 外部システムに渡すスキーマに制約がある場合、その制約をヘルパー関数に封じ込め、プロジェクトの AGENTS.md やガイドラインに明文化しているか確認する
- [ ] クロスプラットフォーム（Web/iOS/Android 等）で共有するデータ型がある場合、スキーマ駆動のコード生成パイプラインの導入を検討する
- [ ] 設定ファイルに機密情報（API キー、トークン等）を含む場合、スキーマレベルで機密性をマークし、公開時に自動リダクトする仕組みがあるか確認する
- [ ] LLM ツール呼び出しのスキーマ定義がある場合、`anyOf`/`oneOf`/`allOf` を使わず、フラットな `string enum` やフラット化されたオブジェクトに変換しているか確認する
