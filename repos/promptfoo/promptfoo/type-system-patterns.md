# Type System Patterns

> リポジトリ: promptfoo/promptfoo
> 分析日: 2026-02-21

## 概要

promptfoo は 2,300+ ファイル規模の TypeScript コードベースで、Biome による `noEnum: "error"`・`noExplicitAny: "error"`（src 配下）ルールのもと、enum 禁止・`any` 最小化を徹底している。Zod スキーマと TypeScript 型の二重定義を避ける仕組み、`as const` + indexed access types による enum 代替パターン、コンパイル時の型一致検証など、大規模プロジェクトの型設計に再利用可能なプラクティスが豊富に存在する。

## 背景にある原則

- **Single Source of Truth**: 型定義とバリデーションスキーマを一箇所に集約し、`z.infer<typeof Schema>` で型を導出することで、手動での型同期コストを排除する。ただし手書き interface が先に存在するケースでは `AssertEqual` 型で一致を静的に検証する（`src/validators/prompts.ts:28-33`）。型が先かスキーマが先かに関わらず、整合性を担保する仕組みを必ず持つべきである。

- **Enum-Free Union Types**: TypeScript の `enum` はツリーシェイキングできず、reverse mapping で意図しないコードが生成される。`as const` + `typeof` の indexed access type で同等の型安全性を実現しつつ、ランタイムオブジェクトとしても利用可能にすべきである（`biome.jsonc:119` で `noEnum: "error"` 適用）。

- **Progressive Strictness**: `noExplicitAny` を src 配下では `"error"` としつつ、テスト・providers・redteam ディレクトリでは `"off"` に緩和している（`biome.jsonc:276,313,333`）。外部 API との境界やレガシーコードでは型の厳密さよりも柔軟性を優先するが、コア部分は厳格に保つべきである。

- **Schema Composition over Duplication**: `TestCaseSchema.extend()`・`TestSuiteConfigSchema.extend()`・`.omit()` を活用し、スキーマ間の差分だけを記述することで重複を排除すべきである（`src/types/index.ts:872,1203`）。

## 実例と分析

### Enum 代替: `as const` + Indexed Access Type

promptfoo では enum を全面禁止し、3つの代替パターンを使い分けている。

**パターン A: オブジェクト定数 + 同名 type（数値・文字列マップ用）**

名前付き定数として値を参照したい場合に使用される。`const` オブジェクトと同名の `type` を定義し、値型と名前空間を一体化する。`ResultFailureReason`（`src/types/index.ts:309-317`）、`BrowserBehavior`（`src/util/server.ts:9-17`）、`Severity`（`src/redteam/constants/metadata.ts:419-426`）、`CodeScanSeverity`（`src/types/codeScan.ts:7-14`）で一貫して使用されている。

**パターン B: 配列定数 + `[number]` 型（文字列リテラルユニオン用）**

プラグインやストラテジーの ID リストなど、文字列リテラルの集合を管理する場合に使用される。`FOUNDATION_PLUGINS`（`src/redteam/constants/plugins.ts:38-83`）、`MULTI_TURN_STRATEGIES`（`src/redteam/constants/strategies.ts:20-28`）をはじめ数十箇所で適用されている。配列のまま `Set` へ変換して `.has()` による O(1) ルックアップもセットで提供する。

**パターン C: `z.enum()` によるスキーマ兼型定義**

バリデーションが必要な場面では `z.enum()` から型を導出する。`BaseAssertionTypesSchema`（`src/types/index.ts:514-574`）、`OutputFileExtension`（`src/types/index.ts:1326-1336`）で使用。

### Zod スキーマと TypeScript 型の同期保証

Zod スキーマから型を導出する `z.infer<typeof Schema>` が主流だが、手書き interface が先行する場合（外部公開 API など）はコンパイル時型一致検証を行う。

`src/validators/prompts.ts` では 2 つの型が完全一致するかを検証する `AssertEqual` 型を定義している。`src/validators/redteam.ts` では `Exclude` ベースの `TypeEqualityGuard` を使用する。いずれもランタイムコストゼロで型の不一致をコンパイル時に検出する。

### `z.custom<T>()` による関数型のスキーマ化

Zod は関数型を直接表現できないため、`z.custom<T>()` でブリッジする。`CallApiFunctionSchema`（`src/validators/providers.ts:25-27`）、`PromptFunctionSchema`（`src/validators/prompts.ts:11`）、`ScoringFunction`（`src/types/index.ts:797`）で使用。バリデーション関数 `(v) => typeof v === 'function'` を添えることでランタイム検査も行う。

### スキーマ合成: extend / omit / catchall

スキーマの差分合成が徹底されている。`TestCaseSchema` を `.extend()` して `AtomicTestCaseSchema`（vars 確定版）や `TestCaseWithVarsFileSchema`（vars がファイルパス可）を派生させている。`UnifiedConfigSchema` は `TestSuiteConfigSchema.extend()` で構築され、`.refine()` による相互排他バリデーション（`targets` と `providers` のいずれか一方のみ）と `.transform()` による正規化を組み合わせている。

`catchall(z.any())` は、既知プロパティの型安全性を維持しつつ任意のキーを許容する場面で使用される（`src/types/index.ts:819,833`、`src/redteam/types.ts:113`）。コメントで「z.intersection() は allOf + additionalProperties:false を生成し検証エラーになる」と代替理由を明記している（`src/types/index.ts:802-805`）。

### Template Literal Types

`NotPrefixed<T>` 型（`src/types/index.ts:578`）は `not-${T}` でアサーションの否定形を自動生成する。`RedteamAssertionTypes`（`src/redteam/types.ts:239`）は `promptfoo:redteam:${string}` でプレフィックス付き文字列型を表現する。

### `satisfies` による型安全な定数定義

`as const satisfies readonly Plugin[]` パターン（`src/redteam/constants/plugins.ts:472,477,485`）で、定数配列がリテラル型を保持しつつ `Plugin` 型の部分集合であることをコンパイル時に保証する。

## コード例

```typescript
// src/types/index.ts:309-317 — Enum 代替パターン A（オブジェクト定数 + 同名 type）
export const ResultFailureReason = {
  NONE: 0,
  ASSERT: 1,
  ERROR: 2,
} as const;
export type ResultFailureReason = (typeof ResultFailureReason)[keyof typeof ResultFailureReason];
```

```typescript
// src/redteam/constants/plugins.ts:152-155 — Enum 代替パターン B（配列定数 + [number] 型）
export const AGENTIC_PLUGINS = ["agentic:memory-poisoning"] as const;
export type AgenticPlugin = (typeof AGENTIC_PLUGINS)[number];
```

```typescript
// src/types/index.ts:1326-1336 — Enum 代替パターン C（z.enum による定義）
export const OutputFileExtension = z.enum([
  "csv",
  "html",
  "json",
  "jsonl",
  "txt",
  "xml",
  "yaml",
  "yml",
]);
export type OutputFileExtension = z.infer<typeof OutputFileExtension>;
```

```typescript
// src/validators/prompts.ts:28-33 — コンパイル時の型一致検証
type AssertEqual<T, U> = T extends U ? (U extends T ? true : false) : false;
function assert<_T extends true>() {}

assert<AssertEqual<PromptConfig, z.infer<typeof PromptConfigSchema>>>();
assert<AssertEqual<Prompt, z.infer<typeof PromptSchema>>>();
```

```typescript
// src/types/index.ts:578 — Template literal types による型の自動生成
type NotPrefixed<T extends string> = `not-${T}`;
```

```typescript
// src/types/index.ts:1203-1235 — スキーマ合成 + refine + transform
export const UnifiedConfigSchema = TestSuiteConfigSchema.extend({
  evaluateOptions: EvaluateOptionsSchema.optional(),
  commandLineOptions: CommandLineOptionsSchema.partial().optional(),
  providers: ProvidersSchema.optional(),
  targets: ProvidersSchema.optional(),
})
  .refine(
    (data) => {
      const hasTargets = data.targets !== undefined;
      const hasProviders = data.providers !== undefined;
      return (hasTargets && !hasProviders) || (!hasTargets && hasProviders);
    },
    { message: "Exactly one of 'targets' or 'providers' must be provided, but not both" },
  )
  .transform((data) => {
    if (data.targets && !data.providers) {
      data.providers = data.targets;
      delete data.targets;
    }
    return data;
  });
```

```typescript
// src/types/env.ts:124-125 — 既知プロパティ + 任意キーの交差型
export type EnvOverrides =
  & z.infer<typeof ProviderEnvOverridesSchema>
  & Record<string, string | undefined>;
```

```typescript
// src/redteam/constants/plugins.ts:465-472 — satisfies で型安全な定数定義
export const DEFAULT_PLUGINS: ReadonlySet<Plugin> = new Set(
  [
    ...[
      ...BASE_PLUGINS,
      ...(Object.keys(HARM_PLUGINS) as HarmPlugin[]),
      ...PII_PLUGINS,
      ...BIAS_PLUGINS,
    ].sort(),
  ] as const satisfies readonly Plugin[],
);
```

```typescript
// src/util/invariant.ts:14-27 — asserts 型ガードによるナローイング
export default function invariant(
  condition: any,
  message?: string | (() => string),
): asserts condition {
  if (condition) return;
  const prefix = "Invariant failed";
  const provided = typeof message === "function" ? message() : message;
  throw new Error(provided ? `${prefix}: ${provided}` : prefix);
}
```

## パターンカタログ

- **Const Enum Object Pattern** (分類: 構造)
  - 解決する問題: TypeScript enum のツリーシェイキング不可・reverse mapping 問題を回避しつつ、名前付き定数アクセスを維持する
  - 適用条件: 数値や文字列の有限集合を定義し、ランタイムでも名前参照したい場合
  - コード例: `src/types/index.ts:309-317`、`src/types/codeScan.ts:7-14`
  - 注意点: 同名の `const` と `type` を export するため、import 側で値と型の使い分けが必要

- **Schema-First Type Derivation** (分類: 生成)
  - 解決する問題: バリデーションスキーマと TypeScript 型の二重定義・乖離
  - 適用条件: ランタイムバリデーションが必要な設定・API ペイロード型
  - コード例: `src/types/index.ts:113`（`CommandLineOptions`）、`src/types/codeScan.ts:267-277`
  - 注意点: `z.transform()` を含むスキーマでは入力型と出力型が異なるため、`z.input<>` と `z.infer<>` の使い分けが必要

- **Compile-Time Type Synchronization Guard** (分類: 振る舞い)
  - 解決する問題: 手書き interface と Zod スキーマの乖離を検出
  - 適用条件: 外部公開 API など手書き型が先行し、スキーマが後追いの場合
  - コード例: `src/validators/prompts.ts:28-33`、`src/validators/redteam.ts:565-569`
  - 注意点: `assert` 関数は呼び出されるだけで実行されない。あくまでコンパイル時チェック

## Good Patterns

- **`as const satisfies` で定数配列の型安全性を確保**: `as const` でリテラル型を保持しつつ、`satisfies readonly Plugin[]` で配列要素が `Plugin` 型に含まれることを保証する。タイポや無効な値をコンパイル時に検出できる。

```typescript
// src/redteam/constants/plugins.ts:474-477
export const MINIMAL_TEST_PLUGINS: ReadonlySet<Plugin> = new Set(
  [
    "harmful:hate",
    "harmful:self-harm",
  ] as const satisfies readonly Plugin[],
);
```

- **配列定数 + ReadonlySet でルックアップを最適化**: 型定義用の `as const` 配列と、ランタイムルックアップ用の `ReadonlySet` をセットで提供する。型安全性と O(1) パフォーマンスを両立している。

```typescript
// src/redteam/constants/strategies.ts:14-16
export const DEFAULT_STRATEGIES = ["basic", "jailbreak:meta", "jailbreak:composite"] as const;
export type DefaultStrategy = (typeof DEFAULT_STRATEGIES)[number];
export const DEFAULT_STRATEGIES_SET: ReadonlySet<string> = new Set(DEFAULT_STRATEGIES);
```

- **型ガード関数で構造的型判定を行う**: `isApiProvider` と `isProviderOptions` は `id` プロパティが `function` か `string` かで区別する。同じプロパティ名だが型が異なる2つの interface を安全に判別している。

```typescript
// src/types/providers.ts:262-278
export function isApiProvider(provider: any): provider is ApiProvider {
  return typeof provider === "object" && provider != null
    && "id" in provider && typeof provider.id === "function";
}
export function isProviderOptions(provider: any): provider is ProviderOptions {
  return typeof provider === "object" && provider != null
    && "id" in provider && typeof provider.id === "string";
}
```

- **`Omit` + `&` で型のバリエーションを簡潔に表現**: サーバー向けの型変換（`Date` -> `string`）を `Omit` と交差型で明示的に記述している。

```typescript
// src/types/index.ts:305-307
export type ServerPromptWithMetadata = Omit<PromptWithMetadata, "recentEvalDate"> & {
  recentEvalDate: string;
};
```

## Anti-Patterns / 注意点

- **`z.any()` の過度な使用**: `config: z.any().optional()` が複数箇所に残存している（`src/validators/providers.ts:17`、`src/types/providers.ts:53,107`）。`noExplicitAny` が有効でも Zod の `z.any()` は lint で検出されない。ランタイムバリデーションが無効化され、型安全性が失われる。

```typescript
// Bad: z.any() — バリデーションが無効化される
config: z.any().optional(),

// Better: z.record() や z.object() で既知の構造を定義し、z.catchall() で拡張性を確保
config: z.object({
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
}).catchall(z.unknown()).optional(),
```

- **型とスキーマの分散定義**: `src/types/index.ts` のコメント「This file is in the process of being deconstructed into `types/` and `validators/`」（1行目）が示すように、型定義と Zod スキーマが混在している。型の定義場所を探すコストが増大する。

```typescript
// Bad: 1ファイルに型とスキーマが混在（src/types/index.ts は 1355 行）
export const AssertionSchema = z.object({ ... });
export type Assertion = z.infer<typeof AssertionSchema>;
export interface GradingResult { ... }  // 手書き interface

// Better: types/ に型、validators/ にスキーマを分離し、AssertEqual で同期を検証
```

- **circular dependency を避けるための interface 再宣言**: `src/types/prompts.ts:4-8` で `ApiProvider` を `declare interface` で再宣言している。循環参照の回避としては有効だが、元の interface との乖離リスクがある。

```typescript
// Bad: declare interface で interface を複製
declare interface ApiProvider {
  id: () => string;
  callApi: (prompt: string, context?: any, options?: any) => Promise<any>;
}

// Better: 最小限の Pick 型や共有型を別ファイルに切り出す
```

## 導出ルール

- `[MUST]` enum を使わず `as const` オブジェクト + indexed access type で union 型を定義する
  - 根拠: promptfoo は Biome `noEnum: "error"` を全体に適用し、ツリーシェイキング阻害と reverse mapping 問題を排除している（`biome.jsonc:119`）

- `[MUST]` Zod スキーマから型を導出する場合は `z.infer<typeof Schema>` を使い、手動で同じ型を二重定義しない
  - 根拠: promptfoo のコア型定義の大部分（`CommandLineOptions`、`TestCase`、`UnifiedConfig` 等）がこのパターンに従い、型とスキーマの乖離を防いでいる（`src/types/index.ts`）

- `[MUST]` 手書き interface と Zod スキーマが並存する場合は、コンパイル時型一致検証（`AssertEqual` や `TypeEqualityGuard`）を添える
  - 根拠: `src/validators/prompts.ts:28-33` と `src/validators/redteam.ts:565-569` でスキーマと型の一致を静的に検証している

- `[SHOULD]` 文字列リテラルの有限集合は `as const` 配列で定義し、ランタイムルックアップ用に `ReadonlySet` をセットで提供する
  - 根拠: `src/redteam/constants/strategies.ts` では全ストラテジー定義が配列 + Set のペアで提供され、型推論と O(1) ルックアップを両立している

- `[SHOULD]` `as const` 配列を型安全に特定の union 型の部分集合に制約するには `satisfies` を使う
  - 根拠: `src/redteam/constants/plugins.ts:472` で `as const satisfies readonly Plugin[]` により、配列要素がすべて有効な `Plugin` であることをコンパイル時に保証している

- `[SHOULD]` `z.intersection()` より `catchall(z.unknown())` で拡張可能なオブジェクトスキーマを構築する
  - 根拠: `z.intersection()` は `allOf` + `additionalProperties: false` を生成し JSON Schema 検証エラーを引き起こす。promptfoo はこの問題を `catchall` で回避している（`src/types/index.ts:802-805`）

- `[SHOULD]` 型ガード関数は「構造的な差異」（プロパティの型やメソッドの有無）に基づいて判定し、`instanceof` に依存しない
  - 根拠: `isApiProvider` は `typeof provider.id === 'function'`、`isProviderOptions` は `typeof provider.id === 'string'` で判定し、クラス継承に依存しない構造的型ガードを実現している（`src/types/providers.ts:262-278`）

- `[AVOID]` Zod スキーマ内で `z.any()` を使うこと。`z.unknown()` + `z.custom<T>()` で型情報を保持する
  - 根拠: `z.any()` はバリデーションをバイパスし、`noExplicitAny` lint ルールでも検出されない。promptfoo 自身も `config: z.any()` が残存しており、コードコメントで改善対象と認識されている

## 適用チェックリスト

- [ ] プロジェクトの lint 設定で `noEnum` (Biome) または `no-restricted-syntax` (ESLint) で enum を禁止しているか
- [ ] Zod スキーマから `z.infer<typeof Schema>` で型を導出し、手動の二重定義を排除しているか
- [ ] 手書き interface と Zod スキーマが並存する箇所に `AssertEqual` 型の静的検証を追加しているか
- [ ] `as const` 配列に `satisfies` を付与し、要素が期待する union 型の部分集合であることを保証しているか
- [ ] 文字列リテラルの定数集合に対して `ReadonlySet` をセットで提供し、ランタイムルックアップを O(1) にしているか
- [ ] `z.any()` が残存していないか確認し、`z.unknown()` または `z.custom<T>()` に置換しているか
- [ ] 型ガード関数が構造的な判定（プロパティの型・有無）に基づいており、`instanceof` に依存していないか
- [ ] スキーマの重複を `extend()` / `omit()` / `pick()` で排除しているか
