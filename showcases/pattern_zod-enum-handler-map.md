# Pattern: Zod Enum Handler Map

> 出典: [repos/promptfoo/promptfoo](../repos/promptfoo/promptfoo/)
> カテゴリ: pattern

## 概要

Zod の `z.enum` で列挙型を定義し、`Record<ZodEnumType, Handler>` でハンドラマップを構成することで、型の追加時にハンドラ未実装がコンパイルエラーになるパターン。promptfoo では 50 種以上のアサーション評価ロジックをこの手法でゼロ漏れ管理しており、型定義への 1 行追加だけで「どこにハンドラが足りないか」をコンパイラが即座に報告する。ランタイムバリデーションも同一の Zod スキーマを使うため、型定義とバリデーションの乖離も発生しない。

## 背景・文脈

promptfoo は LLM 出力の品質評価フレームワークで、文字列含有チェック・正規表現マッチ・コサイン類似度・LLM-as-judge など多種多様な評価ロジックを持つ。これらの評価種別は頻繁に追加されるため、「新しい種別を追加したがハンドラの実装を忘れた」というバグが発生しやすい。

従来の switch-case や if-else チェーンでは、ケースの追加漏れをコンパイラが検出できない（`default` で暗黙にフォールスルーする）。promptfoo はこの問題を以下の 3 層構造で解決している:

1. **Zod enum で型を閉じた集合として定義** -- Single Source of Truth
2. **`Record<EnumType, Handler>` でハンドラマップを構成** -- 網羅性のコンパイル時保証
3. **`not-` プレフィックスでテンプレートリテラル型を自動生成** -- 否定版を 0 行の追加コードで提供

## 実装パターン

### 1. Zod enum による型定義

```typescript
// src/types/index.ts:514-576
export const BaseAssertionTypesSchema = z.enum([
  "answer-relevance",
  "bleu",
  "classifier",
  "contains",
  "contains-all",
  "contains-any",
  "contains-json",
  "cost",
  "equals",
  "factuality",
  "javascript",
  "latency",
  "llm-rubric",
  "python",
  "regex",
  "similar",
  // ... 50+ types
  "word-count",
]);

export type BaseAssertionTypes = z.infer<typeof BaseAssertionTypesSchema>;
```

`z.enum` で定義することで、TypeScript の型（`BaseAssertionTypes`）は `z.infer` で自動導出される。手動で `type BaseAssertionTypes = 'contains' | 'equals' | ...` を書く必要がなく、型とスキーマが常に一致する。

### 2. Record 型によるハンドラマップ

```typescript
// src/assertions/index.ts:117-200
const ASSERTION_HANDLERS: Record<
  BaseAssertionTypes,
  (params: AssertionParams) => GradingResult | Promise<GradingResult>
> = {
  "answer-relevance": handleAnswerRelevance,
  bleu: handleBleuScore,
  contains: handleContains,
  "contains-all": handleContainsAll,
  cost: handleCost,
  equals: handleEquals,
  factuality: handleFactuality,
  javascript: handleJavascript,
  latency: handleLatency,
  "llm-rubric": handleLlmRubric,
  python: handlePython,
  regex: handleRegex,
  similar: handleSimilar,
  // ... 全型に対応するハンドラが必須
  "word-count": handleWordCount,
};
```

`Record<BaseAssertionTypes, Handler>` により、Zod enum に含まれるすべてのキーに対してハンドラの存在がコンパイル時に強制される。新しい型を Zod enum に追加すると、このマップに対応するエントリがなければコンパイルエラーになる。

### 3. 統一戻り値型と O(1) ディスパッチ

```typescript
// src/types/index.ts:453-461
export interface GradingResult {
  pass: boolean;
  score: number;
  reason: string;
  namedScores?: Record<string, number>;
  tokensUsed?: TokenUsage;
  // ...
}

// src/assertions/index.ts:485-487 — O(1) ディスパッチ
const handler = ASSERTION_HANDLERS[assertionParams.baseType as keyof typeof ASSERTION_HANDLERS];
if (handler) {
  const result = await handler(assertionParams);
}
```

### 4. `not-` プレフィックスによる自動否定拡張

```typescript
// src/types/index.ts:578-598
type NotPrefixed<T extends string> = `not-${T}`;

export const NotPrefixedAssertionTypesSchema = BaseAssertionTypesSchema.transform(
  (baseType) => `not-${baseType}` as NotPrefixed<BaseAssertionTypes>,
);

export const AssertionTypeSchema = z.union([
  BaseAssertionTypesSchema,
  NotPrefixedAssertionTypesSchema,
  SpecialAssertionTypesSchema,
  z.custom<RedteamAssertionTypes>(),
]);
```

```typescript
// src/assertions/index.ts:237-249
export function isAssertionInverse(assertion: Assertion): boolean {
  return assertion.type.startsWith("not-");
}

export function getAssertionBaseType(assertion: Assertion): AssertionType {
  const inverse = isAssertionInverse(assertion);
  return inverse ? (assertion.type.slice(4) as AssertionType) : (assertion.type as AssertionType);
}
```

各ハンドラは `inverse` パラメータで結果を反転するだけでよい:

```typescript
// src/assertions/contains.ts:18
const pass = outputString.includes(String(value)) !== inverse;
```

## Good Example

### Zod enum + Record 型で型の追加漏れをコンパイル時に検出

```typescript
// Step 1: Zod enum に新しい型 'embedding-distance' を追加
export const BaseAssertionTypesSchema = z.enum([
  "contains",
  "equals",
  "embedding-distance", // 新規追加
  // ...
]);
export type BaseAssertionTypes = z.infer<typeof BaseAssertionTypesSchema>;

// Step 2: ハンドラマップに追加を忘れると...
const ASSERTION_HANDLERS: Record<
  BaseAssertionTypes,
  (params: AssertionParams) => GradingResult | Promise<GradingResult>
> = {
  contains: handleContains,
  equals: handleEquals,
  // 'embedding-distance' のハンドラがない!
  // => コンパイルエラー:
  //    Property 'embedding-distance' is missing in type '...'
  //    but required in type 'Record<BaseAssertionTypes, ...>'
};
```

### 統一パラメータオブジェクトで各ハンドラが必要なフィールドのみ使用

```typescript
// src/assertions/cost.ts — 2 フィールドのみ使用するシンプルなハンドラ
export const handleCost = ({ cost, assertion }: AssertionParams): GradingResult => {
  // ...
};

// src/assertions/contains.ts:5-11 — 5 フィールドを使用するハンドラ
export const handleContains = ({
  assertion,
  renderedValue,
  valueFromScript,
  outputString,
  inverse,
}: AssertionParams): GradingResult => {
  const value = valueFromScript ?? renderedValue;
  const pass = outputString.includes(String(value)) !== inverse;
  return {
    pass,
    score: pass ? 1 : 0,
    reason: pass
      ? "Assertion passed"
      : `Expected output to ${inverse ? "not " : ""}contain "${value}"`,
    assertion,
  };
};
```

`AssertionParams` は 15 フィールドを持つが、各ハンドラは分割代入で必要なものだけ取り出す。将来パラメータが追加されても既存ハンドラの変更は不要。

## Bad Example

### switch-case で暗黙のフォールスルー

```typescript
// Bad: 新しい型を追加しても default でサイレントに失敗する
function runAssertion(type: string, params: AssertionParams): GradingResult {
  switch (type) {
    case "contains":
      return handleContains(params);
    case "equals":
      return handleEquals(params);
    default:
      // 'embedding-distance' を追加しても、ここでサイレントに失敗する
      return { pass: false, score: 0, reason: `Unknown assertion type: ${type}` };
  }
}
```

```typescript
// Good: Record 型で網羅性を保証 + O(1) ルックアップ
const ASSERTION_HANDLERS: Record<
  BaseAssertionTypes,
  (params: AssertionParams) => GradingResult | Promise<GradingResult>
> = {
  contains: handleContains,
  equals: handleEquals,
  // 型の追加漏れはコンパイルエラーになる
};

function runAssertion(type: BaseAssertionTypes, params: AssertionParams) {
  const handler = ASSERTION_HANDLERS[type];
  return handler(params);
}
```

### 型定義とバリデーションの二重管理

```typescript
// Bad: 型定義とバリデーションが分離しており、乖離のリスクがある
type AssertionType = "contains" | "equals" | "regex";

function isValidType(type: string): type is AssertionType {
  return ["contains", "equals"].includes(type);
  // 'regex' が含まれていない! でもコンパイラは検出しない
}
```

```typescript
// Good: Zod enum から型を導出し、バリデーションも同一スキーマで行う
export const BaseAssertionTypesSchema = z.enum(["contains", "equals", "regex"]);
export type BaseAssertionTypes = z.infer<typeof BaseAssertionTypesSchema>;

// バリデーション: スキーマと型定義が常に一致
const result = BaseAssertionTypesSchema.safeParse(input);
if (result.success) {
  // result.data は BaseAssertionTypes 型
}
```

## 適用ガイド

### どのような状況で使うべきか

- **10 種以上のハンドラを持つディスパッチテーブル**: 評価ロジック、プラグインシステム、コマンドハンドラなど、種別ごとに異なる処理を実行する場面。種別が頻繁に追加される場合に特に有効。
- **ランタイムバリデーションが必要な列挙型**: 設定ファイルやユーザー入力から受け取る値の型チェックが必要な場合、Zod enum で型定義とバリデーションを統一できる。
- **否定・反転が必要な種別体系**: `not-` のようなプレフィックスで既存の全種別の否定版を自動生成したい場合、テンプレートリテラル型との組み合わせが強力。

### 導入時の注意点

- **ハンドラマップの型は `Record<EnumType, Handler>` にする**: `Partial<Record<...>>` にすると網羅性保証が無効になる。すべてのキーが必須であることが重要。
- **Zod enum と TypeScript enum を混同しない**: `z.enum()` は文字列リテラルの配列を受け取る Zod のメソッドで、TypeScript の `enum` キーワードとは異なる。ツリーシェイキングを阻害しない。
- **`z.infer` で導出した型には同名の `type` を使う**: `export type BaseAssertionTypes = z.infer<typeof BaseAssertionTypesSchema>` のように、スキーマ変数名から `Schema` サフィックスを除いた名前を型名にすると対応が明確になる。

### カスタマイズポイント

- **統一戻り値型の設計**: promptfoo は `{pass, score, reason}` の 3 フィールドを必須にしている。プロジェクトのドメインに合わせて最小限の共通フィールドを設計する。`boolean` のみの戻り値はスコア集約やデバッグ情報の欠落につながるため避ける。
- **パラメータオブジェクトの粒度**: 全ハンドラに共通のパラメータオブジェクトを渡すか、`Pick<Params, ...>` でハンドラごとに必要なフィールドを限定するかを選択する。promptfoo は前者を採用しつつ、一部ハンドラ（`handleEquals` 等）で `Pick` による限定も行っている。
- **オプショナル依存のハンドリング**: 外部パッケージに依存するハンドラは dynamic import + catch でグレースフルに処理し、インストール手順をエラーメッセージに含める。promptfoo の `meteor` ハンドラがこのパターンの実例。

```typescript
// src/assertions/index.ts:157-177 — オプショナル依存のグレースフルハンドリング
meteor: async (params: AssertionParams) => {
  try {
    const { handleMeteorAssertion } = await import('./meteor.js');
    return handleMeteorAssertion(params);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Cannot find module')) {
      return {
        pass: false,
        score: 0,
        reason: 'METEOR assertion requires the natural package. '
              + 'Please install it using: npm install natural@^8.1.0',
        assertion: params.assertion,
      };
    }
    throw error;
  }
},
```

## 参考

- [repos/promptfoo/promptfoo/assertion-patterns.md](../repos/promptfoo/promptfoo/assertion-patterns.md) -- アサーション型の定義・ディスパッチ・合成パイプラインの分析
- [repos/promptfoo/promptfoo/type-system-patterns.md](../repos/promptfoo/promptfoo/type-system-patterns.md) -- Zod スキーマと TypeScript 型の同期保証、enum 代替パターンの分析
