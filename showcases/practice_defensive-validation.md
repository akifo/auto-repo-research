# Practice: Defensive Validation

> 出典: [repos/mastra-ai/mastra/schema-validation-patterns](../repos/mastra-ai/mastra/schema-validation-patterns.md), [repos/mastra-ai/mastra/error-handling-idioms](../repos/mastra-ai/mastra/error-handling-idioms.md)
> カテゴリ: practice

## 概要

外部システム（特に LLM）からの入力は仕様通りでないことが常態である。mastra は「5 段階フォールバック検証パイプライン」と「JSON Schema 制約のダウングレード（description への移動）」という 2 つの防御的検証パターンで、LLM ごとの出力差異を吸収している。各フォールバック段階は GitHub Issue で追跡されており、実運用の問題を構造的に対処する模範例となっている。

## 背景・文脈

mastra は AI エージェントフレームワークとして、OpenAI / Anthropic / Google / DeepSeek / Meta など複数の LLM プロバイダと連携する。各 LLM はツール呼び出しの引数を JSON で返すが、その挙動にはプロバイダ固有の癖がある:

- **Gemini**: optional フィールドに `undefined` ではなく `null` を送信する
- **GLM4.7**: 配列やオブジェクトの引数を文字列化した JSON（`"[\"file.py\"]"`）として返す
- **OpenAI strict mode**: `.optional()` を許容しない（すべてのフィールドが `required` でなければならない）
- **Claude 3.5 Haiku**: `minLength` / `maxLength` 制約を JSON Schema で受け取っても守らない

これらの差異に対して「一つのバリデーションで全部対応」は不可能であり、段階的なフォールバックと制約表現の変換が必要になる。

## 実装パターン

### パターン 1: 5 段階フォールバック検証パイプライン

ツール入力の検証を 5 段階で行い、各ステップが特定の LLM のバグに対応する。全段階失敗時は最初の検証エラー（最も情報量が多い）を返す。

```typescript
// packages/core/src/tools/validation.ts:320-397
export function validateToolInput<T = any>(
  schema: SchemaWithValidation<T> | undefined,
  input: unknown,
  toolId?: string,
): { data: T | unknown; error?: ValidationError<T> } {
  if (!schema || !('safeParse' in schema)) {
    return { data: input };
  }

  // Step 1: null/undefined → {} or [] (LLM が空入力を送る場合)
  let normalizedInput = normalizeNullishInput(schema, input);

  // Step 2: undefined → null (OpenAI strict mode 互換, GitHub #11457)
  normalizedInput = convertUndefinedToNull(normalizedInput);

  // Step 3: safeParse（本来のバリデーション、null 保持）
  const validation = schema.safeParse(normalizedInput);
  if (validation.success) return { data: validation.data };

  // Step 4: 文字列化 JSON のパース試行 (GLM4.7 対策, GitHub #12757)
  const coercedInput = coerceStringifiedJsonValues(schema, normalizedInput);
  if (coercedInput !== normalizedInput) {
    const coercedValidation = schema.safeParse(coercedInput);
    if (coercedValidation.success) return { data: coercedValidation.data };
  }

  // Step 5: null/undefined を除去してリトライ (Gemini 対策, GitHub #12362)
  const strippedInput = stripNullishValues(input);
  const normalizedStripped = normalizeNullishInput(schema, strippedInput);
  const retryValidation = schema.safeParse(normalizedStripped);
  if (retryValidation.success) return { data: retryValidation.data };

  // 全段階失敗 — 最初の検証エラーを返す（情報量が最も多い）
  const errorMessages = validation.error.issues
    .map(e => `- ${e.path?.join('.') || 'root'}: ${e.message}`)
    .join('\n');
  return {
    data: input,
    error: {
      error: true,
      message: `Tool input validation failed${toolId ? ` for ${toolId}` : ''}...\n${errorMessages}`,
      validationErrors: validation.error.format(),
    },
  };
}
```

### パターン 2: 制約の description へのダウングレード

プロバイダが JSON Schema 制約（`minLength`, `pattern`, `format` など）をサポートしない場合、制約を削除するのではなく `description` フィールドに人間可読テキストとして移動する。LLM は description を読んで制約を尊重できるため、情報は失われない。

```typescript
// packages/schema-compat/src/schema-compatibility-v3.ts:342-351
public mergeParameterDescription(
  description: string | undefined,
  constraints: ConstraintHelperText,
): string | undefined {
  if (constraints.length > 0) {
    return (description ? description + '\n' : '') + `constraints: ${constraints.join(`, `)}`;
  }
  return description;
}
```

```typescript
// packages/schema-compat/src/schema-compatibility-v3.ts:444-488
public defaultZodStringHandler(
  value: ZodString,
  handleChecks: readonly StringCheckType[] = ALL_STRING_CHECKS,
): ZodString {
  const constraints: ConstraintHelperText = [];
  const checks = value._def.checks || [];
  const newChecks: ZodStringCheck[] = [];
  for (const check of checks) {
    if ('kind' in check) {
      if (handleChecks.includes(check.kind as StringCheckType)) {
        switch (check.kind) {
          case 'email': case 'url': case 'uuid': case 'cuid':
            constraints.push(`a valid ${check.kind}`); break;
          case 'min': case 'max':
            constraints.push(`${check.kind}imum length ${check.value}`); break;
          case 'regex':
            constraints.push(`input must match this regex ${check.regex.source}`); break;
        }
      } else { newChecks.push(check); }
    }
  }
  let result = z.string();
  for (const check of newChecks) { result = result._addCheck(check); }
  const description = this.mergeParameterDescription(value.description, constraints);
  if (description) { result = result.describe(description); }
  return result;
}
```

プロバイダごとにダウングレード対象の制約を選択できる:

```typescript
// packages/schema-compat/src/provider-compats/anthropic.ts:36-37
// Anthropic Claude 3.5 Haiku: min/max のみダウングレード
if (this.getModel().modelId.includes('claude-3.5-haiku')) {
  return this.defaultZodStringHandler(value, ['max', 'min']);
}

// packages/schema-compat/src/provider-compats/google.ts:41-47
// Google: 全制約をダウングレード（モデルは守らないが description 経由で尊重する）
return this.defaultZodStringHandler(value);
return this.defaultZodNumberHandler(value);
```

## Good Example

### 段階的フォールバックで LLM 差異を吸収する

```typescript
// packages/core/src/tools/validation.ts:161-192
// Step 5 の実装: null を除去してリトライ
function stripNullishValues(input: unknown): unknown {
  if (input === null || input === undefined) return undefined;
  if (typeof input !== 'object') return input;
  if (Array.isArray(input)) {
    return input.map(item => (item === null ? null : stripNullishValues(item)));
  }
  if (!isPlainObject(input)) return input;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined) continue; // 省略 = "未提供"
    result[key] = stripNullishValues(value);
  }
  return result;
}

// Step 4 の実装: 文字列化 JSON の復元
function coerceStringifiedJsonValues(schema: SchemaWithValidation<unknown>, input: unknown): unknown {
  // スキーマが配列/オブジェクトを期待しているのに文字列が来た場合、JSON.parse を試みる
  const trimmed = value.trim();
  if (
    (isZodArray(baseFieldSchema) && trimmed.startsWith('[')) ||
    (isZodObject(baseFieldSchema) && trimmed.startsWith('{'))
  ) {
    try {
      const parsed = JSON.parse(value);
      // パース成功かつ期待型と一致すれば採用
      result[key] = parsed;
    } catch { /* Not valid JSON, leave as-is */ }
  }
}
```

**良い点**: 各ステップが独立しており、新しい LLM の癖が見つかれば新しいステップを追加するだけ。Issue 番号をコメントで追跡しているため、なぜそのステップが必要なのかが明確。

### 制約を削除せず description に移動する

```typescript
// Good: 制約情報を description に変換して保持
// 入力: z.string().min(3).email().describe("User email")
// 出力: z.string().describe("User email\nconstraints: a valid email, minimum length 3")
```

**良い点**: LLM は JSON Schema の `description` を読んで制約を尊重できるため、バリデーション情報が失われない。プロバイダごとにどの制約をダウングレードするか選択可能。

## Bad Example

### 一発バリデーションで即エラー

```typescript
// Bad: LLM の出力差異を考慮しない一発バリデーション
function validateToolInput(schema: ZodSchema, input: unknown) {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error(`Validation failed: ${result.error.message}`);
  }
  return result.data;
}
// Gemini が null を送信 → 即エラー
// GLM4.7 が文字列化 JSON を送信 → 即エラー
// 本来は有効な入力なのに拒絶してしまう
```

**問題点**: 「正しい入力を拒絶しない」ことは「不正な入力を通さない」ことと同等に重要。LLM の出力は仕様から外れることが常態であり、一度の検証失敗で即エラーにするとツール呼び出しの成功率が著しく下がる。

### バリデーション制約を単純に削除する

```typescript
// Bad: 制約を捨てる — LLM が制約を認知できなくなる
function processSchemaForProvider(schema: JSONSchema7) {
  if (schema.minLength !== undefined) {
    delete schema.minLength;
  }
  if (schema.pattern !== undefined) {
    delete schema.pattern;
  }
  return schema;
}
// LLM は「3文字以上」という制約を知る手段がなくなる

// Good: description に移動する
function processSchemaForProvider(schema: JSONSchema7) {
  const constraints: string[] = [];
  if (schema.minLength !== undefined) {
    constraints.push(`minimum length ${schema.minLength}`);
    delete schema.minLength;
  }
  if (constraints.length) {
    schema.description = (schema.description ? schema.description + '\n' : '')
      + `constraints: ${constraints.join(', ')}`;
  }
  return schema;
}
```

## 適用ガイド

### どのような状況で使うべきか

- **LLM のツール呼び出し（Function Calling）の入力検証**: 複数プロバイダをサポートする場合は必須。単一プロバイダでもモデルのバージョンアップで挙動が変わるリスクがある
- **外部 API のレスポンス検証**: LLM に限らず、レスポンス形式が厳密に保証されない外部システムからの入力全般に適用可能
- **スキーマ制約をプロバイダに送信する場面**: JSON Schema を LLM API に渡す際、プロバイダ固有の制約サポート差異を吸収する必要がある場合

### 導入時の注意点

1. **フォールバックの順序は重要**: mastra は Step 3（null 保持バリデーション）を Step 5（null 除去バリデーション）より先に実行する。`.nullable()` スキーマでは null が正当な値であり、先に null を除去すると壊れるため
2. **最初のエラーを保持する**: 全段階失敗時のエラーメッセージは最初の検証結果を使う。後段の正規化後のエラーは情報量が少ない（元の入力が既に変形されているため）
3. **エラーメッセージのセンシティブ情報をリダクトする**: mastra は `redactSensitiveKeys` で `apiKey` / `token` / `secret` 等を `[REDACTED]` に置換し、`truncateForLogging` で入力データの長さを制限している（`validation.ts:10-37, 51-61`）
4. **制約ダウングレードはプロバイダごとに粒度を変える**: Google は全制約をダウングレード、Anthropic は Haiku モデルのみ `min`/`max` をダウングレード、といったように対象を絞り込む

### カスタマイズポイント

- **新しい LLM の癖への対応**: フォールバックパイプラインに新しいステップを追加する。Issue 番号をコメントに記載して追跡性を維持する
- **ダウングレード対象の制約**: `defaultZodStringHandler` の `handleChecks` 引数で、プロバイダごとにどの制約を description に移動するか制御できる
- **プロバイダごとの Strategy 分離**: `SchemaCompatLayer` を継承して `shouldApply()` で自動選択、`processZodType()` でプロバイダ固有の変換を実装する

## 参考

- [repos/mastra-ai/mastra/schema-validation-patterns.md](../repos/mastra-ai/mastra/schema-validation-patterns.md) — スキーマ検証パターンの全体分析
- [repos/mastra-ai/mastra/error-handling-idioms.md](../repos/mastra-ai/mastra/error-handling-idioms.md) — エラーハンドリングイディオムの全体分析
