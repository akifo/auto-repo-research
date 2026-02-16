# Code Organization

> リポジトリ: open-circle/valibot
> 分析日: 2026-02-16

## 概要

valibot のコアライブラリ (`library/src/`) は、schemas/actions/methods/types/utils/storages という6つのトップレベルカテゴリに分かれ、各ユニット（スキーマ・アクション・メソッド）が同一の4ファイル構成（`name.ts`, `name.test.ts`, `name.test-d.ts`, `index.ts`）を厳格に守っている。117以上のアクション、47のスキーマ、28のメソッドがこの規約に例外なく従っており、モジュラーライブラリにおけるファイル組織の徹底的な一貫性がどのような効果をもたらすかを示す好例である。

## 背景にある原則

- **構造的一貫性による認知負荷の排除**: すべてのユニットが同じファイル構成を持つことで、新しいユニットを追加する際のテンプレートが暗黙的に確立され、コントリビューターが迷う余地がなくなる。117個のアクションフォルダが例外なく同じ構成であることが根拠（`library/src/actions/` 配下）。
- **ツリーシェイキング最適化のためのファイル粒度**: 各ユニットが独立したフォルダに分離されているのは、バンドラーがユニット単位で不要コードを除外できるようにするため。`// @__NO_SIDE_EFFECTS__` アノテーションがすべてのファクトリ関数に付与されていることが、この意図を裏付ける（全73スキーマファイルで確認）。
- **型テストと実行テストの分離**: `.test.ts`（実行時の振る舞い検証）と `.test-d.ts`（コンパイル時の型推論検証）を分離することで、型安全性のリグレッションを独立して検出できる。TypeScript の型システムが複雑なライブラリでは、型レベルの正しさは実行時テストでは捕捉できない。
- **Barrel export による段階的な公開スコープ制御**: 各フォルダの `index.ts` がそのユニットの公開 API を定義し、カテゴリレベルの `index.ts` がそれを集約し、最終的にルートの `index.ts` が全体を束ねる。3段階の barrel export により、内部ヘルパーの漏洩を防ぎつつフラットな API を提供できる。

## 実例と分析

### ユニットフォルダの4ファイル構成

最も単純な構成は `string` スキーマに見られる。

| ファイル           | 役割                                                              |
| ------------------ | ----------------------------------------------------------------- |
| `string.ts`        | 実装本体（Issue interface + Schema interface + factory function） |
| `string.test.ts`   | 実行時テスト（vitest）                                            |
| `string.test-d.ts` | 型テスト（`expectTypeOf`）                                        |
| `index.ts`         | barrel export（`export * from './string.ts'`）                    |

async バリアントがある場合は `nameAsync.ts`, `nameAsync.test.ts`, `nameAsync.test-d.ts` が追加される。共有型がある場合は `types.ts` が追加される。この拡張も完全に規約化されている。

### 同一ファイルへの型定義と実装の同居

各ユニットの `.ts` ファイルは以下の順序で構成される:

1. import 文
2. Issue interface（そのユニット固有のエラー型）
3. Schema/Action/Method interface（返却オブジェクトの型）
4. overload signatures（JSDoc 付き）
5. `// @__NO_SIDE_EFFECTS__` アノテーション
6. implementation function（オブジェクトリテラルを返す）

この順序は `string.ts`, `email.ts`, `minLength.ts`, `trim.ts`, `parse.ts` などすべてのユニットで一貫している。

### フォルダ名の命名規約

フォルダ名は関数名と完全に一致する camelCase を採用している:

- `exactOptional/` (関数名: `exactOptional`)
- `looseObject/` (関数名: `looseObject`)
- `tupleWithRest/` (関数名: `tupleWithRest`)
- `minLength/` (関数名: `minLength`)
- `checkItems/` (関数名: `checkItems`)

ケバブケース（`min-length`）やスネークケース（`min_length`）ではなく、エクスポートされる関数名と1:1対応する camelCase を使用する。

### 内部ヘルパーのアンダースコアプレフィックス

`utils/` 配下の内部ヘルパーは `_` プレフィックスで命名される:

- `_addIssue/` - Issue 追加ロジック
- `_getStandardProps/` - Standard Schema プロパティ生成
- `_stringify/` - 値の文字列化
- `_getByteCount/`, `_getGraphemeCount/`, `_getWordCount/` - カウントヘルパー
- `_isLuhnAlgo/` - Luhn アルゴリズム検証
- `_joinExpects/` - expected 文字列結合

一方、公開 API として提供されるユーティリティ（`isOfKind`, `isOfType`, `getDotPath`, `ValiError` 等）にはプレフィックスがない。アンダースコアプレフィックスは「エクスポートはされるが外部利用を想定しない」ことを示す命名規約である。

### types ディレクトリの責務分離

`library/src/types/` は関心ごとにファイルが分割されている:

| ファイル            | 責務                                          |
| ------------------- | --------------------------------------------- |
| `schema.ts`         | BaseSchema, BaseSchemaAsync, GenericSchema    |
| `validation.ts`     | BaseValidation, BaseValidationAsync           |
| `transformation.ts` | BaseTransformation, BaseTransformationAsync   |
| `issue.ts`          | BaseIssue, path item types                    |
| `dataset.ts`        | OutputDataset, SuccessDataset, FailureDataset |
| `config.ts`         | Config interface                              |
| `infer.ts`          | InferInput, InferOutput, InferIssue           |
| `pipe.ts`           | PipeItem, PipeAction                          |
| `other.ts`          | ErrorMessage, Default                         |
| `utils.ts`          | MaybeReadonly, FirstTupleItem など            |

各ファイルが20行前後の明確な責務を持ち、`index.ts` で束ねられる。

## コード例

```typescript
// library/src/schemas/string/string.ts:69-94
// @__NO_SIDE_EFFECTS__
export function string(
  message?: ErrorMessage<StringIssue>,
): StringSchema<ErrorMessage<StringIssue> | undefined> {
  return {
    kind: "schema",
    type: "string",
    reference: string,
    expects: "string",
    async: false,
    message,
    get "~standard"() {
      return _getStandardProps(this);
    },
    "~run"(dataset, config) {
      if (typeof dataset.value === "string") {
        // @ts-expect-error
        dataset.typed = true;
      } else {
        _addIssue(this, "type", dataset, config);
      }
      // @ts-expect-error
      return dataset as OutputDataset<string, StringIssue>;
    },
  };
}
```

```typescript
// library/src/schemas/string/index.ts:1
export * from "./string.ts";
```

```typescript
// library/src/schemas/object/index.ts:1-3
export * from "./object.ts";
export * from "./objectAsync.ts";
export * from "./types.ts";
```

```typescript
// library/src/actions/minLength/minLength.ts:101-127
// @__NO_SIDE_EFFECTS__
export function minLength(
  requirement: number,
  message?: ErrorMessage<MinLengthIssue<LengthInput, number>>
): MinLengthAction<...> {
  return {
    kind: 'validation',
    type: 'min_length',
    reference: minLength,
    async: false,
    expects: `>=${requirement}`,
    requirement,
    message,
    '~run'(dataset, config) {
      if (dataset.typed && dataset.value.length < this.requirement) {
        _addIssue(this, 'length', dataset, config, {
          received: `${dataset.value.length}`,
        });
      }
      return dataset;
    },
  };
}
```

```typescript
// library/src/utils/index.ts:1-2 (内部 vs 公開ヘルパーの命名差)
export * from "./_addIssue/index.ts"; // _ prefix = internal
export * from "./entriesFromList/index.ts"; // no prefix = public API
```

## パターンカタログ

- **Factory Pattern** (分類: 生成)
  - 解決する問題: 各ユニットが実行時にプレーンオブジェクトを生成する必要があるが、クラスインスタンスではツリーシェイキングが困難
  - 適用条件: ライブラリが提供するオブジェクトがすべて同一の `kind`/`type`/`reference`/`async`/`'~run'` プロパティを持つ場合
  - コード例: `library/src/schemas/string/string.ts:69-94`
  - 注意点: `// @__NO_SIDE_EFFECTS__` アノテーションをファクトリ関数の直前に付与しないとバンドラーがツリーシェイクできない

- **Template Method Pattern (変形)** (分類: 振る舞い)
  - 解決する問題: すべてのスキーマ/アクション/メソッドが `'~run'` メソッドを持ち、pipe 実行時に統一的に呼び出される必要がある
  - 適用条件: 共通インターフェースの `'~run'` メソッドを各ユニットが独自に実装し、`pipe` がそれを順次呼び出す
  - コード例: `library/src/methods/pipe/pipe.ts:2684-2732`（pipe の実装が `item['~run'](dataset, config)` を順次呼び出す）
  - 注意点: クラス継承ではなくオブジェクトリテラルのメソッドとして実装されている点が GoF の Template Method とは異なる

## Good Patterns

- **テストヘルパーによるテスト記述の均質化**: `library/src/vitest/` に `expectSchemaIssue`, `expectNoSchemaIssue`, `expectActionIssue` 等の共通ヘルパーを用意し、全ユニットのテストが同じ語彙で書かれている。これにより、新しいユニットのテストを書く際にコピー&修正で済むだけでなく、テストの意図が統一的に読める。

```typescript
// library/src/vitest/expectSchemaIssue.ts:18-45
export function expectSchemaIssue<
  TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>,
>(
  schema: TSchema,
  baseIssue: Omit<InferIssue<TSchema>, "input" | "received">,
  values: unknown[],
  received?: string,
): void {
  for (const value of values) {
    expect(schema["~run"]({ value }, {})).toStrictEqual(
      {
        typed: false,
        value,
        issues: [{ ...baseIssue, input: value, received: received ?? _stringify(value) }],
      } satisfies FailureDataset<InferIssue<TSchema>>,
    );
  }
}
```

- **Issue/Schema interface の同居による co-location**: 各ユニットの `StringIssue` と `StringSchema` が同一ファイルに定義されている。型の利用者はインポートパスを1つ覚えるだけでよく、型定義が実装から離れて陳腐化するリスクを排除している。

```typescript
// library/src/schemas/string/string.ts:12-49
export interface StringIssue extends BaseIssue<unknown> { ... }
export interface StringSchema<TMessage ...> extends BaseSchema<...> { ... }
```

- **async バリアントの命名と配置の一貫性**: async バリアントは常に `nameAsync.ts` として同一フォルダに配置される。`objectAsync.ts` は `object/` フォルダに、`parseAsync.ts` は `parse/` フォルダに置かれる。非同期版が別フォルダに分離されることはない。

## Anti-Patterns / 注意点

- **types.ts の配置位置の曖昧さ**: スキーマフォルダ内の `types.ts`（例: `schemas/object/types.ts` に `ObjectIssue`）とアクションのトップレベル `actions/types.ts`（`LengthInput` 等の共有型）は、同じ `types.ts` というファイル名ながら責務レベルが異なる。前者はそのユニットの Issue 型、後者はカテゴリ横断の入力型である。

```typescript
// Bad: 同名ファイルだが責務が異なる
// schemas/object/types.ts - ObjectIssue (ユニット固有)
// actions/types.ts - LengthInput, ValueInput, SizeInput (カテゴリ横断)
```

```typescript
// Better: 責務を名前で区別する
// schemas/object/types.ts -> schemas/object/issue.ts (ユニット固有なら issue.ts)
// actions/types.ts -> actions/shared-types.ts (横断なら shared- prefix)
```

- **overload の重複による行数爆発**: `pipe.ts` は19個の overload を手書きしており2700行を超える。型安全性を最大化するためのトレードオフだが、新しい pipe item 上限を追加する際にコピー&ペーストエラーのリスクがある。

```typescript
// Bad: 手書きの繰り返し overload (pipe.ts は2733行)
export function pipe<TSchema, TItem1>(schema, item1): SchemaWithPipe<[TSchema, TItem1]>;
export function pipe<TSchema, TItem1, TItem2>(schema, item1, item2): SchemaWithPipe<[TSchema, TItem1, TItem2]>;
// ... 19個の overload が続く
```

```typescript
// Better: コード生成 + 生成されたファイルであることを示すコメント
// WARNING: This file is auto-generated. Do not edit manually.
// Run `pnpm generate:overloads` to regenerate.
```

## 導出ルール

- `[MUST]` モジュラーライブラリの各ユニットは固定のファイル構成（実装 + テスト + 型テスト + barrel export）を持たせ、例外を許容しない
  - 根拠: valibot では 117 のアクション、47 のスキーマ、28 のメソッドすべてが同一の4ファイル構成を遵守しており、新規ユニット追加時のテンプレートが暗黙的に確立されている

- `[MUST]` ツリーシェイキング対象のファクトリ関数には `// @__NO_SIDE_EFFECTS__` アノテーションを付与する
  - 根拠: valibot のすべてのスキーマ・アクション・メソッドのファクトリ関数（73スキーマファイルで確認）に例外なくこのアノテーションが付与されており、バンドラーによるデッドコード除去を保証している

- `[SHOULD]` フォルダ名はエクスポートされる関数名と1:1で対応させ、ケースを一致させる（関数が camelCase なら フォルダも camelCase）
  - 根拠: `exactOptional/`, `looseObject/`, `tupleWithRest/` など、フォルダ名と関数名が完全に一致しており、コードナビゲーション時に推測が不要

- `[SHOULD]` 内部ヘルパー関数は `_` プレフィックスで命名し、公開 API と視覚的に区別する
  - 根拠: `_addIssue`, `_getStandardProps`, `_stringify` 等の内部ヘルパーは `_` プレフィックスを持ち、`isOfKind`, `getDotPath`, `ValiError` 等の公開 API とは明確に区別されている

- `[SHOULD]` 型テスト（`.test-d.ts`）を実行テスト（`.test.ts`）とは別ファイルに分離し、型推論のリグレッションを独立して検出する
  - 根拠: valibot の全ユニットが `.test.ts`（振る舞い検証）と `.test-d.ts`（`expectTypeOf` による型検証）を分離しており、型レベルのバグを専用テストで捕捉している

- `[AVOID]` テストユーティリティを各テストファイル内にインライン定義する。共通のテストヘルパーを専用ディレクトリに集約すべき
  - 根拠: `library/src/vitest/` に `expectSchemaIssue`, `expectNoSchemaIssue` 等の8つのテストヘルパーが集約されており、全ユニットのテストが均質な語彙で記述されている

## 適用チェックリスト

- [ ] ライブラリの各ユニットが統一された固定ファイル構成（実装 + テスト + 型テスト + barrel export）に従っているか
- [ ] フォルダ名がエクスポートされる関数/クラス名と1:1で対応しているか
- [ ] ツリーシェイキング対象のファクトリ関数に `// @__NO_SIDE_EFFECTS__` アノテーションが付与されているか
- [ ] 内部ヘルパーと公開 API が命名規約（`_` プレフィックス等）で視覚的に区別されているか
- [ ] 型テストが実行テストとは別ファイルに分離されているか
- [ ] テストヘルパーが専用ディレクトリに集約され、テストの語彙が均質化されているか
- [ ] barrel export が段階的（ユニット → カテゴリ → ルート）に構成され、内部モジュールの漏洩を防いでいるか
- [ ] async バリアントが `nameAsync.ts` として同一フォルダ内に配置されているか
