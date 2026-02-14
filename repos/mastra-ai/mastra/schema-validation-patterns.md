# Schema Validation Patterns

> リポジトリ: mastra-ai/mastra
> 分析日: 2026-02-14

## 概要

mastra は AI エージェントフレームワークとして、ツール入出力・ワークフロー状態・LLM 構造化出力など多層でスキーマ検証を行っている。特筆すべきは Zod v3/v4 両メジャーバージョンの同時サポートを `@mastra/schema-compat` パッケージで実現し、6 つの AI プロバイダ（OpenAI, Anthropic, Google, DeepSeek, Meta, OpenAI Reasoning）ごとにスキーマの制約を変換する Strategy パターンを適用している点である。Standard Schema 仕様を中間表現として活用するバージョン共存戦略と、LLM の既知挙動差異を多段フォールバックで吸収する防御的バリデーション設計は、AI ツール連携に限らず複数外部依存を持つライブラリ開発全般に応用可能である。

## 背景にある原則

- **中間表現による依存分離**: Zod v3 と v4 の内部 API の違い（`_def` vs `_zod`、`check.kind` vs `check._zod.def.check`）を直接公開せず、`SchemaCompatLayer` 抽象クラスと Standard Schema (`@standard-schema/spec`) を中間表現として使うことで、利用側コードがバージョン詳細に依存しない。ライブラリのメジャーバージョン変更は内部 API の破壊を伴うため、中間表現で吸収すべき（`packages/schema-compat/src/schema-compatibility.ts:45-60`）。

- **制約のダウングレード（Constraint Degradation）**: AI プロバイダが特定の JSON Schema 制約（`minLength`, `pattern`, `format` など）をサポートしない場合、制約を削除するのではなく `description` フィールドに人間可読テキストとして移動する。バリデーション情報は削除せず表現を変えて保存すべき。LLM は description を読んで制約を尊重できるから（`schema-compatibility-v3.ts:342-351`, `schema-compatibility-v3.ts:447-488`）。

- **フェイルセーフ・バリデーション・パイプライン**: ツール入力検証で最初の `safeParse` が失敗しても即座にエラーにせず、LLM の既知の挙動（null 送信、文字列化 JSON など）に対して段階的にフォールバックを試みる。バリデーションは「正しい入力を拒絶しない」ことが「不正な入力を通さない」ことと同等に重要（`packages/core/src/tools/validation.ts:320-397`）。

- **バージョン検出はプロパティの有無で行う**: `instanceof` はパッケージの重複インストール（dual-package hazard）で壊れるため、Zod v3 と v4 の判別を `_zod` プロパティの存在で行う。ランタイムの型判別は構造的特徴（duck typing）に基づくべき（`standard-schema.ts:60-61`, `utils.ts:57-69`）。

## 実例と分析

### 1. バージョンスイッチによる v3/v4 共存アーキテクチャ

`SchemaCompatLayer`（親クラス）はすべての型判別メソッドで `'_zod' in value` による単一分岐を行い、v4 なら `SchemaCompatLayerV4`、v3 なら `SchemaCompatLayerV3` のメソッドに委譲する。この「1 つの分岐点で全てを振り分ける」パターンが約 15 のメソッドで一貫している。

```typescript
// packages/schema-compat/src/schema-compatibility.ts:70-76
getUnsupportedZodTypes(value: ZodType): readonly string[] {
  if ('_zod' in value) {
    return this.v4Layer.getUnsupportedZodTypes();
  } else {
    return this.v3Layer.getUnsupportedZodTypes();
  }
}
```

v3 と v4 で制約チェックの内部表現が完全に異なる。v3 は `check.kind === 'min'`、v4 は `check._zod.def.check === 'min_length'`。この差異がバージョン固有レイヤー（`schema-compatibility-v3.ts` と `schema-compatibility-v4.ts`）に閉じ込められている。

### 2. Standard Schema を介した Zod v3 の JSON Schema 変換

Zod v4 は `~standard.jsonSchema` を内蔵しているが v3 にはない。この差を `toStandardSchema()` 関数が吸収する。

```typescript
// packages/schema-compat/src/standard-schema/standard-schema.ts:101-132
export function toStandardSchema<T = unknown>(schema: PublicSchema<T>): StandardSchemaWithJSON<T> {
  if (isStandardSchemaWithJSON(schema)) {
    return schema;                                  // v4 / ArkType はそのまま
  }
  if (isZodV3(schema)) {
    return toStandardSchemaZodV3(schema as ZodType); // v3 にはアダプタで JSON Schema を付与
  }
  if (isVercelSchema(schema)) {
    return toStandardSchemaAiSdk(schema as Schema<T>);
  }
  return toStandardSchemaJsonSchema(schema as JSONSchema7);
}
```

v3 用アダプタは `Object.create(zodSchema)` でプロトタイプ継承して `~standard` プロパティを追加する。元の Zod スキーマの `safeParse` 等は維持しつつ、JSON Schema 変換機能を後付けする設計（`adapters/zod-v3.ts:92-123`）。

### 3. PublicSchema: 5 種のスキーマ入力を統一する Union 型

ユーザーが渡すスキーマ形式を制限せず、5 つの表現を受け入れる型を定義している。

```typescript
// packages/schema-compat/src/schema.types.ts:17-22
export type PublicSchema<Output = unknown, Input = Output> =
  | z4.ZodType<Output, Input>
  | z3.Schema<Output, z3.ZodTypeDef, Input>
  | Schema<Output>                    // AI SDK Schema
  | JSONSchema7                       // 素の JSON Schema
  | StandardSchemaWithJSON<Input, Output>;  // Standard Schema 準拠
```

### 4. プロバイダ固有の制約変換と description への移動

Google や Anthropic (Haiku) は文字列の `minLength` や `pattern` を JSON Schema で受け取っても守らない。そこで制約を `description` に変換する。

```typescript
// packages/schema-compat/src/schema-compatibility-v3.ts:444-488
public defaultZodStringHandler(value: ZodString, handleChecks = ALL_STRING_CHECKS): ZodString {
  const constraints: ConstraintHelperText = [];
  for (const check of checks) {
    if (handleChecks.includes(check.kind as StringCheckType)) {
      switch (check.kind) {
        case 'email': constraints.push(`a valid email`); break;
        case 'min':   constraints.push(`minimum length ${check.value}`); break;
      }
    } else { newChecks.push(check); }
  }
  const description = this.mergeParameterDescription(value.description, constraints);
}
```

プロバイダごとに変換対象の制約を選択できる。Anthropic は `['max', 'min']` のみ（`provider-compats/anthropic.ts:37`）、Google は全制約（`provider-compats/google.ts:43-44`）、DeepSeek R1 は互換レイヤー自体をスキップ（`provider-compats/deepseek.ts:22`）。

### 5. OpenAI strict mode での optional → nullable 変換

OpenAI の reasoning モデル（o1/o3/o4）は strict mode で `.optional()` を許容しない。`.optional()` を `.nullable().transform(val => val === null ? undefined : val)` に変換し、LLM は null を送信、transform で undefined に戻す。

```typescript
// packages/schema-compat/src/provider-compats/openai.ts:33-51
if (isOptional(z)(value)) {
  const innerType = '_def' in value ? value._def.innerType : (value as any)._zod?.def?.innerType;
  if (innerType) {
    const processedInner = this.processZodType(innerType);
    return processedInner.nullable().transform((val: any) => (val === null ? undefined : val));
  }
}
```

`.default()` に対しても同様の変換を行い、null 受信時にデフォルト値を返す transform を挟む（`openai.ts:73-89`）。

### 6. 多段フォールバック・バリデーション・パイプライン

ツール入力の検証は 5 段階で行われ、各ステップは特定の LLM のバグに対応する。GitHub Issue 番号がコメントで追跡されている。

```typescript
// packages/core/src/tools/validation.ts:351-384
// Step 1: null/undefined → {} or [] (LLM が空入力を送る場合)
let normalizedInput = normalizeNullishInput(schema, input);
// Step 2: undefined → null (OpenAI strict mode 互換, #11457)
normalizedInput = convertUndefinedToNull(normalizedInput);
// Step 3: safeParse（本来のバリデーション）
const validation = schema.safeParse(normalizedInput);
if (validation.success) return { data: validation.data };
// Step 4: 文字列化 JSON のパース試行 (GLM4.7 対策, #12757)
const coercedInput = coerceStringifiedJsonValues(schema, normalizedInput);
// Step 5: null/undefined を除去してリトライ (Gemini 対策, #12362)
const strippedInput = stripNullishValues(input);
```

### 7. pnpm workspace による E2E バージョン分離

E2E テストでは zod v3 と v4 を完全に別の `package.json` で管理し、pnpm workspace で隔離している。

```json
// e2e-tests/client-js/zod-v3/package.json
{ "dependencies": { "zod": "^3.24.0" } }

// e2e-tests/client-js/zod-v4/package.json
{ "dependencies": { "zod": "^4.3.5" } }
```

schema-compat パッケージ自体は `zod/v3` と `zod/v4` のサブパスインポートを使い、単一パッケージ内で両バージョンの型にアクセスする。`peerDependencies` は `"zod": "^3.25.0 || ^4.0.0"` として両バージョンを許容する。

## パターンカタログ

- **Adapter パターン** (構造: GoF)
  - 解決する問題: Zod v3 が Standard Schema の `jsonSchema` インターフェースを持たない
  - 適用条件: 外部ライブラリが必要なインターフェースを実装していないが、プロトタイプを拡張できる場合
  - コード例: `packages/schema-compat/src/standard-schema/adapters/zod-v3.ts:92-123`
  - 注意点: `Object.create()` でプロトタイプ継承するため `instanceof` チェックが維持される

- **Strategy パターン** (振る舞い: GoF)
  - 解決する問題: プロバイダごとに異なるスキーマ変換ロジックが必要
  - 適用条件: 同じインターフェースで振る舞いをランタイムで切り替えたい場合
  - コード例: `packages/schema-compat/src/provider-compats/` 配下 6 クラス
  - 注意点: `shouldApply()` + `applyCompatLayer()` の Chain of Responsibility 的な選択機構と組み合わせており、判定順序がセマンティクスに影響する

- **Template Method パターン** (振る舞い: GoF)
  - 解決する問題: v3/v4 の型判別ロジックを親クラスに集約しつつ、変換の詳細はサブクラスに委譲
  - 適用条件: アルゴリズムの骨格は共通だが、一部ステップが異なる場合
  - コード例: `packages/schema-compat/src/schema-compatibility.ts:160-162`（`shouldApply`, `getSchemaTarget`, `processZodType` が abstract）

- **Chain of Responsibility パターン** (振る舞い: GoF)
  - 解決する問題: 入力の正規化方法が一意に決まらず、複数の戦略を順に試す必要がある
  - 適用条件: 外部から渡されるデータの形式が予測不能で、複数の補正ルールを段階的に適用したい場合
  - コード例: `packages/core/src/tools/validation.ts:330-397` の 5 段階パイプライン
  - 注意点: 最初のエラー情報を保持し、全段階失敗時にはそれを返す（後段のエラーは情報量が少ない）

## Good Patterns

- **Duck Typing によるライブラリバージョン検出**: `instanceof` の代わりにプロパティの存在（`_def` vs `_zod`）とメソッドのシグネチャ（`parse`/`safeParse`）で型判定。dual-package hazard を完全回避。

```typescript
// packages/schema-compat/src/utils.ts:57-69
export function isZodType(value: unknown): value is ZodType {
  return (
    typeof value === 'object' && value !== null &&
    ('_def' in value || '_zod' in value) &&
    'parse' in value && typeof (value as any).parse === 'function' &&
    'safeParse' in value && typeof (value as any).safeParse === 'function'
  );
}
```

- **Constraint-to-Description Degradation**: バリデーション制約を削除せず description に変換。LLM は description を読んで制約を尊重できるため情報が失われない。

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

- **Transform チェーンによる optional/nullable の相互変換**: OpenAI strict mode で `.optional()` が使えない制約を `.nullable().transform()` で回避し、LLM のインターフェースと内部型システムの不整合を透過的に吸収。

```typescript
// packages/schema-compat/src/provider-compats/openai.ts:48-50
const processedInner = this.processZodType(innerType);
return processedInner.nullable().transform((val: any) => (val === null ? undefined : val));
```

- **バージョン固有の型ガードファクトリ**: `zodTypes.ts` で `isOptional(z)` のように Zod のモジュール参照を引数に取る高階関数で型ガードを生成。v3/v4 どちらの `z` を渡しても正しい `instanceof` チェックが行われる。

```typescript
// packages/schema-compat/src/zodTypes.ts:99-103
export function isOptional<Z extends typeof zV3>(z: Z): (v: any) => v is zV3.ZodOptional<any>;
export function isOptional<Z extends typeof zV4>(z: Z): (v: any) => v is zV4.ZodOptional<any>;
export function isOptional<Z extends typeof zV3 | typeof zV4>(z: Z) {
  return (v: any): v is Z['ZodOptional'] => v instanceof z['ZodOptional'];
}
```

## Anti-Patterns / 注意点

- **instanceof によるスキーマ型判別**: Zod の dual-package hazard により、`zod/v3` と旧 `zod-v3` パッケージで `instanceof` が失敗する。mastra のソースコメントにも問題が明記されている（`standard-schema.ts:67-78`）。

```typescript
// Bad: dual-package hazard で壊れる
function isZodSchema(value: unknown): boolean {
  return value instanceof z.ZodType;
}

// Better: 構造的特徴で判定する
function isZodSchema(value: unknown): boolean {
  return typeof value === 'object' && value !== null &&
    ('_def' in value || '_zod' in value) &&
    typeof (value as any).safeParse === 'function';
}
```

- **バリデーション制約の無条件削除**: プロバイダがサポートしない制約を単に削除すると、LLM が制約を認知できなくなる。

```typescript
// Bad: 制約を捨てる
if (schema.minLength !== undefined) {
  delete schema.minLength;
}

// Better: description に移動する
if (schema.minLength !== undefined) {
  constraints.push(`minimum length ${schema.minLength}`);
  delete schema.minLength;
}
schema.description = mergeParameterDescription(schema.description, constraints);
```

## 導出ルール

- `[MUST]` スキーマライブラリのメジャーバージョン共存時は、バージョン判別を `instanceof` ではなくプロパティの存在確認（duck typing）で行う
  - 根拠: mastra は `'_zod' in value` で v3/v4 を判別し、dual-package hazard を回避している（`schema-compatibility.ts:71`, `utils.ts:60-63`）

- `[MUST]` バリデーション制約を外部システム向けに削除する場合は、人間可読な description に変換して情報を保持する
  - 根拠: 全 6 プロバイダの SchemaCompatLayer が `mergeParameterDescription` で制約を description に移動しており、LLM が制約を description 経由で尊重できる（`schema-compatibility-v3.ts:342-351`）

- `[SHOULD]` スキーマの入力検証にフォールバック・パイプラインを実装し、外部システム（LLM 等）の既知の挙動差異を段階的に吸収する
  - 根拠: mastra のツール入力検証は 5 段階のフォールバックで Gemini の null 送信、GLM4.7 の文字列化 JSON、OpenAI の optional→nullable 変換をそれぞれ吸収（`validation.ts:330-397`、#11457, #12362, #12757）

- `[SHOULD]` 複数の外部スキーマ形式を受け入れる場合は Union 型で公開 API を定義し、内部で Standard Schema 等の共通表現に正規化する
  - 根拠: `PublicSchema` 型が Zod v3/v4、AI SDK Schema、JSON Schema、Standard Schema の 5 形式を受け入れ、`toStandardSchema()` で統一表現に変換（`schema.types.ts:17-22`）

- `[SHOULD]` プロバイダごとのスキーマ変換ロジックは Strategy パターンで分離し、`shouldApply()` による自動選択機構を設ける
  - 根拠: 6 つの `SchemaCompatLayer` サブクラスが `shouldApply()` でモデル ID/プロバイダ名に基づく自動選択を行い、`applyCompatLayer()` が最初にマッチしたレイヤーを適用（`utils.ts:200-204`）

- `[SHOULD]` スキーマ検証エラーは例外ではなく Result 型（`{ data, error }`）で返し、エラーメッセージには入力データのトランケートされたダンプを含める
  - 根拠: AI ツール連携ではエラー情報を LLM にフィードバックしてリトライさせる必要があるため、例外ではなくデータとして扱う方が柔軟（`validation.ts:39-43, 388-396`）

- `[AVOID]` E2E テストでメジャーバージョン違いの依存を同一 `package.json` で管理すること。pnpm workspace 等で別パッケージに分離し、バージョン間の干渉を防ぐ
  - 根拠: mastra は `e2e-tests/client-js/zod-v3/` と `zod-v4/` を完全に別パッケージとして管理し、それぞれ独立した zod バージョンをインストールしている

## 適用チェックリスト

- [ ] スキーマライブラリのバージョン検出に `instanceof` を使っていないか確認する（dual-package hazard 対策）
- [ ] 外部システムにスキーマを渡す箇所で、サポートされない制約が黙って削除されていないか確認し、description への移動を検討する
- [ ] LLM からのツール入力に対して null/undefined の正規化処理・フォールバック検証を実装しているか確認する
- [ ] 複数のスキーマ形式を受け入れる API がある場合、Union 型 + 正規化関数で内部表現に統一するパターンを適用する
- [ ] プロバイダごとのスキーマ制約の差異がある場合、Strategy パターンで分離されているか確認する
- [ ] スキーマ検証エラーが Result 型で返され、エラーメッセージが呼び出し元にフィードバック可能な形式か確認する
- [ ] スキーマライブラリの複数バージョンをテストする場合、monorepo の別パッケージとしてバージョンごとに隔離する
