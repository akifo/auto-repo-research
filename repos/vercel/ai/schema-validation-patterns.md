# Schema Validation Patterns

> リポジトリ: vercel/ai
> 分析日: 2026-02-20

## 概要

AI SDK が採用するスキーマバリデーションの設計パターンを分析する。このコードベースは Zod 3 / Zod 4 のデュアルサポート、Standard Schema 準拠、JSON.parse の安全なラッパー、LLM 出力の段階的バリデーション（パース → 修復 → 型検証）といった複数のプラクティスを統合的に実装している。特にライブラリがメジャーバージョン間の互換性をどう維持するか、外部入力（LLM レスポンス）のバリデーションをどう多層化するかという点で、汎用的に応用可能なプラクティスが豊富である。

## 背景にある原則

- **スキーマライブラリ非依存の抽象層を設けるべき**: 特定のバリデーションライブラリに直接依存すると、メジャーバージョンアップやライブラリ乗り換え時にコードベース全体を書き換える必要が生じる。AI SDK は `Schema` インターフェースを中心とした抽象層を設け、Zod 3 / Zod 4 / Standard Schema / 素の JSON Schema をすべて同じ `FlexibleSchema` 型で扱えるようにしている（`packages/provider-utils/src/schema.ts:72-76`）。

- **JSON 解析と型バリデーションは分離すべき**: LLM の出力は常にテキストであるため、JSON パースと型検証を 1 ステップで行うと、どちらが失敗したか判別しにくい。AI SDK は `safeParseJSON` で JSON パースだけを行い、`safeValidateTypes` で型検証だけを行う 2 段階設計を採用している（`packages/provider-utils/src/parse-json.ts`, `packages/provider-utils/src/validate-types.ts`）。

- **安全でない入力は安全なラッパーで一元管理すべき**: `JSON.parse` をコードベース全体で直接呼ぶと、プロトタイプ汚染攻撃への対策が漏れる。AI SDK は `secureJsonParse` で `__proto__` と `constructor.prototype` を検出・排除し、全 JSON パースをこのラッパー経由に統一している（`packages/provider-utils/src/secure-json-parse.ts`）。

- **スキーマの生成コストは遅延評価で最小化すべき**: JSON Schema への変換は CPU コストが高いが、バリデーションだけで済む場面も多い。`jsonSchema` ファクトリは getter で JSON Schema 生成を遅延し、`lazySchema` はスキーマ自体の生成を呼び出し時まで遅延する（`packages/provider-utils/src/schema.ts:50-61, 95-119`）。

## 実例と分析

### Zod 3 / Zod 4 デュアルサポート

AI SDK は Zod のメジャーバージョン移行期にユーザーが Zod 3 と Zod 4 のどちらを使っていても動作するよう、ランタイムで版を判別する仕組みを持つ。

判別方法は Zod 公式のライブラリ著者向けガイドに準拠しており、Zod 4 のスキーマオブジェクトが持つ `_zod` プロパティの有無で分岐する:

```typescript
// packages/provider-utils/src/schema.ts:241-246
export function isZod4Schema(
  zodSchema: z4.core.$ZodType<any, any> | z3.Schema<any, z3.ZodTypeDef, any>,
): zodSchema is z4.core.$ZodType<any, any> {
  // https://zod.dev/library-authors?id=how-to-support-zod-3-and-zod-4-simultaneously
  return "_zod" in zodSchema;
}
```

この判別に基づき、統一的な `zodSchema()` 関数が内部で `zod3Schema()` / `zod4Schema()` に振り分ける。さらに Standard Schema（`~standard` プロトコル）にも対応し、Zod 以外のバリデーションライブラリ（Valibot 等）もサポートする:

```typescript
// packages/provider-utils/src/schema.ts:132-143
export function asSchema<OBJECT>(
  schema: FlexibleSchema<OBJECT> | undefined,
): Schema<OBJECT> {
  return schema == null
    ? jsonSchema({ properties: {}, additionalProperties: false })
    : isSchema(schema)
    ? schema
    : "~standard" in schema
    ? schema["~standard"].vendor === "zod"
      ? zodSchema(schema as ZodSchema<OBJECT>)
      : standardSchema(schema as StandardSchema<OBJECT>)
    : schema();
}
```

内部の import ルールは `contributing/zod.md` に明文化されている。Zod 3 は `import * as z3 from "zod/v3"`、Zod 4 は `import * as z4 from "zod/v4"` と統一し、名前空間の衝突を防いでいる。

### FlexibleSchema 型による統一的スキーマ受け入れ

ユーザー向け API は `FlexibleSchema<T>` 型でスキーマを受け取る。これにより 4 種類の入力形式を透過的に扱える:

```typescript
// packages/provider-utils/src/schema.ts:72-76
export type FlexibleSchema<SCHEMA = any> =
  | Schema<SCHEMA> // AI SDK 独自の Schema 型
  | LazySchema<SCHEMA> // 遅延評価される Schema
  | ZodSchema<SCHEMA> // Zod 3 or Zod 4
  | StandardSchema<SCHEMA>; // Standard Schema v1 準拠
```

### 安全な JSON パース

`secureJsonParse` は Fastify の `secure-json-parse` を移植したもので、プロトタイプ汚染を防ぐ。さらにパフォーマンス最適化として `Error.stackTraceLimit = 0` でスタックトレース生成を抑制している:

```typescript
// packages/provider-utils/src/secure-json-parse.ts:77-92
export function secureJsonParse(text: string) {
  const { stackTraceLimit } = Error;
  try {
    Error.stackTraceLimit = 0;
  } catch (e) {
    return _parse(text);
  }
  try {
    return _parse(text);
  } finally {
    Error.stackTraceLimit = stackTraceLimit;
  }
}
```

コードベース全体（`packages/ai/src/` 配下）で `JSON.parse` の直接使用は 0 件であり、すべて `safeParseJSON` / `parseJSON` 経由に統一されている。

### LLM 出力のバリデーションパイプライン

LLM のレスポンスは不完全な JSON を返す場合があるため、AI SDK は多段階のバリデーションパイプラインを実装している:

1. **JSON パース**: `safeParseJSON` で安全にパース
2. **修復**: パース失敗時に `fixJson` で不完全な JSON を自動修復（括弧の補完等）
3. **リペア**: それでも失敗する場合、`repairText` コールバックで外部ロジック（LLM に再度問い合わせ等）で修復を試みる
4. **型バリデーション**: `safeValidateTypes` でスキーマに対して検証

```typescript
// packages/ai/src/generate-object/parse-and-validate-object-result.ts:77-111
export async function parseAndValidateObjectResultWithRepair<RESULT>(
  result: string,
  outputStrategy: OutputStrategy<any, RESULT, any>,
  repairText: RepairTextFunction | undefined,
  context: { ... },
): Promise<RESULT> {
  try {
    return await parseAndValidateObjectResult(result, outputStrategy, context);
  } catch (error) {
    if (
      repairText != null &&
      NoObjectGeneratedError.isInstance(error) &&
      (JSONParseError.isInstance(error.cause) ||
        TypeValidationError.isInstance(error.cause))
    ) {
      const repairedText = await repairText({
        text: result,
        error: error.cause,
      });
      if (repairedText === null) {
        throw error;
      }
      return await parseAndValidateObjectResult(
        repairedText, outputStrategy, context,
      );
    }
    throw error;
  }
}
```

### 部分 JSON のストリーミングバリデーション

ストリーミング中の不完全な JSON をリアルタイムにパースするために、`parsePartialJson` は 3 段階の結果状態を返す:

```typescript
// packages/ai/src/util/parse-partial-json.ts:5-30
export async function parsePartialJson(jsonText: string | undefined): Promise<{
  value: JSONValue | undefined;
  state:
    | "undefined-input"
    | "successful-parse"
    | "repaired-parse"
    | "failed-parse";
}> {
  if (jsonText === undefined) {
    return { value: undefined, state: "undefined-input" };
  }
  let result = await safeParseJSON({ text: jsonText });
  if (result.success) {
    return { value: result.value, state: "successful-parse" };
  }
  result = await safeParseJSON({ text: fixJson(jsonText) });
  if (result.success) {
    return { value: result.value, state: "repaired-parse" };
  }
  return { value: undefined, state: "failed-parse" };
}
```

### lazySchema による起動時間最適化

プロバイダーパッケージでは `lazySchema` を広く使用している。これはスキーマ定義のコストを初回アクセスまで遅延させ、ライブラリの import 時間を短縮する:

```typescript
// packages/provider-utils/src/schema.ts:50-61
export function lazySchema<SCHEMA>(
  createSchema: () => Schema<SCHEMA>,
): LazySchema<SCHEMA> {
  let schema: Schema<SCHEMA> | undefined;
  return () => {
    if (schema == null) {
      schema = createSchema();
    }
    return schema;
  };
}
```

使用例（OpenAI プロバイダー）:

```typescript
// packages/openai/src/tool/file-search.ts:25
export const fileSearchArgsSchema = lazySchema(() =>
  zodSchema(z.object({ ... }))
);
```

### additionalProperties: false の自動注入

OpenAI 等のプロバイダーが `additionalProperties: true` をサポートしないため、JSON Schema 変換時に再帰的に `additionalProperties: false` を注入するユーティリティが存在する:

```typescript
// packages/provider-utils/src/add-additional-properties-to-json-schema.ts:6-48
export function addAdditionalPropertiesToJsonSchema(
  jsonSchema: JSONSchema7,
): JSONSchema7 {
  if (jsonSchema.type === 'object' || ...) {
    jsonSchema.additionalProperties = false;
    // properties, items, anyOf, allOf, oneOf, definitions を再帰走査
  }
  return jsonSchema;
}
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: object / array / enum / no-schema など出力形式ごとに異なるバリデーションロジックを統一的に扱う
  - 適用条件: 同一インターフェースで複数のバリデーション戦略を切り替える必要がある場合
  - コード例: `packages/ai/src/generate-object/output-strategy.ts:30-63`（`OutputStrategy` インターフェース）
  - 注意点: ストラテジーの数が増えると `getOutputStrategy` のスイッチが肥大化するが、exhaustive check で漏れを防いでいる

- **Adapter パターン** (分類: 構造)
  - 解決する問題: Zod 3 / Zod 4 / Standard Schema という異なるインターフェースを統一的な `Schema` インターフェースに変換する
  - 適用条件: 互換性のないスキーマライブラリを統一的に扱いたい場合
  - コード例: `packages/provider-utils/src/schema.ts:132-143`（`asSchema` 関数）
  - 注意点: `'~standard' in schema` のようなダックタイピングで版を判別するため、偶然同名プロパティを持つオブジェクトとの衝突リスクがある

- **Lazy Initialization パターン** (分類: 生成)
  - 解決する問題: JSON Schema 変換の CPU コストをスキーマが実際に使われるまで遅延する
  - 適用条件: スキーマ定義数が多く、すべてが同時に使われるわけではない場合
  - コード例: `packages/provider-utils/src/schema.ts:50-61`（`lazySchema`）
  - 注意点: キャッシュされるため、動的にスキーマが変わるケースには不向き

## Good Patterns

- **throw/safe のペアパターン**: 全バリデーション関数が `validateTypes` / `safeValidateTypes`、`parseJSON` / `safeParseJSON` のようにペアで提供される。呼び出し側は制御フローに応じて例外版と Result 版を選択できる。

```typescript
// packages/provider-utils/src/parse-json.ts:16-31 (throw 版)
export async function parseJSON<T>(options: {
  text: string;
  schema: FlexibleSchema<T>;
}): Promise<T>;

// packages/provider-utils/src/parse-json.ts:85-88 (safe 版)
export async function safeParseJSON<T>(options: {
  text: string;
  schema: FlexibleSchema<T>;
}): Promise<ParseResult<T>>;
```

- **ParseResult 型による構造化エラー**: `ParseResult<T>` は `{ success: true; value: T; rawValue: unknown }` と `{ success: false; error: ...; rawValue: unknown }` の判別共用体で、バリデーション前の `rawValue` も保持する。これにより、エラー発生時にも元データへのアクセスが可能になる。

```typescript
// packages/provider-utils/src/parse-json.ts:59-65
export type ParseResult<T> =
  | { success: true; value: T; rawValue: unknown; }
  | {
    success: false;
    error: JSONParseError | TypeValidationError;
    rawValue: unknown;
  };
```

- **型ガードベースのエラー判別**: `JSONParseError.isInstance(error)` や `TypeValidationError.isInstance(error)` のような静的メソッドでエラーの種類を判別する。`instanceof` はバンドル分割やモジュール重複で壊れるため、より堅牢な判別手段となっている。

```typescript
// packages/provider-utils/src/parse-json.ts:48-55
  } catch (error) {
    if (
      JSONParseError.isInstance(error) ||
      TypeValidationError.isInstance(error)
    ) {
      throw error;
    }
    throw new JSONParseError({ text, cause: error });
  }
```

## Anti-Patterns / 注意点

- **JSON.parse の直接使用**: プロトタイプ汚染（`__proto__` や `constructor.prototype`）に対する防御が漏れ、セキュリティホールになる。AI SDK は `secureJsonParse` で一元化し、`packages/ai/src/` 配下では `JSON.parse` を一切使用していない。

```typescript
// Bad: 直接 JSON.parse
const data = JSON.parse(userInput);

// Better: セキュアなラッパー経由
const data = await safeParseJSON({ text: userInput });
```

- **バリデーションライブラリへの直接依存**: ユーザー向け API が `z.object(...)` のような特定ライブラリの型を直接受け取ると、ライブラリのメジャーバージョンアップ時に破壊的変更が波及する。

```typescript
// Bad: Zod に直接依存
function generateObject(schema: z.ZodSchema) { ... }

// Better: 抽象層を挟む
function generateObject(schema: FlexibleSchema<T>) { ... }
```

- **パースと検証の混合**: JSON パースエラーと型バリデーションエラーを区別せずに一つの catch で処理すると、ユーザーに適切なエラーメッセージを返せない。

```typescript
// Bad: パースと検証を混合
try {
  const obj = JSON.parse(text);
  schema.parse(obj);
} catch (e) {
  throw new Error("Invalid input"); // 原因が不明
}

// Better: 段階的に処理
const parseResult = await safeParseJSON({ text });
if (!parseResult.success) {
  throw new JSONParseError({ text, cause: parseResult.error });
}
const validationResult = await safeValidateTypes({ value: parseResult.value, schema });
if (!validationResult.success) {
  throw new TypeValidationError({ value: parseResult.value, cause: validationResult.error });
}
```

## 導出ルール

- `[MUST]` 外部入力の JSON パースにはプロトタイプ汚染対策済みのラッパーを使用し、`JSON.parse` の直接呼び出しを禁止する
  - 根拠: AI SDK は `secureJsonParse` で `__proto__` / `constructor.prototype` を検出・排除し、コードベース全体（`packages/ai/src/`）で `JSON.parse` の直接使用を 0 件に統一している（`packages/provider-utils/src/secure-json-parse.ts`）

- `[MUST]` バリデーション関数は throw 版と safe 版（Result 型を返す版）をペアで提供する
  - 根拠: AI SDK は `parseJSON` / `safeParseJSON`、`validateTypes` / `safeValidateTypes` の全ペアを提供し、制御フローに応じた使い分けを可能にしている（`packages/provider-utils/src/parse-json.ts`, `validate-types.ts`）

- `[SHOULD]` 外部スキーマライブラリへの依存は抽象層（Adapter）で隔離し、ユーザー向け API は抽象型で受け取る
  - 根拠: AI SDK は `FlexibleSchema` 型で Zod 3 / Zod 4 / Standard Schema / 素の JSON Schema を統一的に受け入れ、ライブラリ移行時の影響範囲を `asSchema` 変換層に封じ込めている（`packages/provider-utils/src/schema.ts`）

- `[SHOULD]` スキーマの JSON Schema 変換は遅延評価し、実際に必要になるまで計算コストを発生させない
  - 根拠: `jsonSchema` ファクトリは getter でスキーマ変換を遅延し、`lazySchema` はスキーマ自体の生成も初回アクセスまで遅延する。プロバイダーパッケージ全体で `lazySchema` が広く使用されている（`packages/openai/src/tool/` 等）

- `[SHOULD]` 不完全な入力に対してはパース → 自動修復 → 外部修復の多段階パイプラインを設ける
  - 根拠: LLM は不完全な JSON を頻繁に返すため、AI SDK は `fixJson`（括弧補完等のルールベース修復）→ `repairText`（外部コールバックによる修復）の多段階リカバリーを実装している（`packages/ai/src/util/fix-json.ts`, `packages/ai/src/generate-object/parse-and-validate-object-result.ts`）

- `[SHOULD]` メジャーバージョン間の互換性維持には、ランタイムでの版判別に公式ドキュメント推奨の手法を使い、import パスを名前空間で分離する
  - 根拠: AI SDK は Zod 公式のライブラリ著者向けガイドに従い `'_zod' in schema` で版を判別し、`zod/v3` / `zod/v4` の import パスを `contributing/zod.md` で明文化している

- `[AVOID]` `instanceof` でエラー型を判別すること（バンドル分割やモジュール重複で壊れる）
  - 根拠: AI SDK は `JSONParseError.isInstance(error)` のような静的メソッドでエラー型を判別し、`instanceof` の信頼性問題を回避している（`packages/provider-utils/src/parse-json.ts:48-54`）

## 適用チェックリスト

- [ ] `JSON.parse` の直接呼び出しがコードベースにないか確認し、プロトタイプ汚染対策済みのラッパーに置き換える
- [ ] バリデーションライブラリ（Zod, Valibot 等）への依存が抽象層で隔離されているか確認する
- [ ] バリデーション関数が throw 版と safe 版のペアで提供されているか確認する
- [ ] JSON パースエラーと型バリデーションエラーが区別可能な別のエラー型として表現されているか確認する
- [ ] スキーマの JSON Schema 変換がホットパスで毎回実行されていないか確認し、遅延評価やキャッシュを適用する
- [ ] 外部入力（API レスポンス、LLM 出力等）の不完全な JSON に対するリカバリー戦略があるか検討する
- [ ] ライブラリのメジャーバージョンアップに備え、ランタイム版判別の仕組みが公式推奨の方法に準拠しているか確認する
