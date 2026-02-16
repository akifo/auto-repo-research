# type-system-patterns

> リポジトリ: open-circle/valibot
> 分析日: 2026-02-16

## 概要

valibot は「ランタイムバリデーションスキーマから TypeScript 型を推論する」というスキーマライブラリの核心課題に対し、TypeScript 型システムの高度な機能を体系的に活用している。特に注目すべきは、`interface` による構造的サブタイピングの階層設計、phantom type（`~types` プロパティ）による型情報の埋め込み、overload による型安全なパイプライン合成、そして brand/flavor パターンによる名目的型の導入である。これらの手法はバリデーションライブラリに限らず、型安全な DSL や builder パターンの設計に広く応用可能である。

## 背景にある原則

- **interface を型の構造的基盤として使う**: `type` ではなく `interface` でベース型を定義すべき。なぜなら TypeScript コンパイラは `interface` をキャッシュするため、複雑に入れ子になったジェネリクスでも型チェックのパフォーマンスが大幅に向上する（`library/src/types/schema.ts` で `BaseSchema` を `interface` として定義、`type` は union やユーティリティにのみ使用）
- **型情報は phantom property に閉じ込める**: ランタイムには存在しないが型推論に必要な情報は、optional な phantom プロパティに格納すべき。なぜなら実行時のオーバーヘッドなしに型レベルの情報伝播を実現でき、`infer` で安全に取り出せるから（`'~types'?` プロパティが `BaseSchema`, `BaseValidation`, `BaseTransformation`, `BaseMetadata` の全基底型に統一的に配置）
- **discriminated union は文字列リテラル型で分岐する**: `kind` や `type` に文字列リテラル型を持たせることで、条件分岐や型の絞り込みを型レベルでも実行時でも一貫して行える。`kind: 'schema' | 'validation' | 'transformation' | 'metadata'` の4値で全パイプアイテムを分類する設計は、拡張性と型安全性を両立する（`library/src/types/schema.ts:17`, `validation.ts:11`, `transformation.ts:11`, `metadata.ts:8`）
- **const type parameter で呼び出し時のリテラル型を保持する**: ジェネリクスに `const` 修飾子を使うことで、ユーザーが渡した値のリテラル型情報を失わずに推論できる。これにより入力型 → 出力型 → 推論型の連鎖が正確に動作する（`library/src/schemas/string/string.ts:66`, `library/src/schemas/object/object.ts:60` 等、全スキーマファクトリ関数で `const TEntries`, `const TMessage` を使用）

## 実例と分析

### Phantom Type による型情報埋め込み（`~types` パターン）

valibot の型推論の根幹は `'~types'` phantom プロパティにある。このプロパティは `BaseSchema`, `BaseValidation`, `BaseTransformation`, `BaseMetadata` の全基底 interface に `readonly '~types'?: { input; output; issue } | undefined` として定義され、ランタイムには値を持たないが、`InferInput`, `InferOutput`, `InferIssue` 型が `NonNullable<TItem['~types']>['input']` のように参照することで型情報を取り出す。

```ts
// library/src/types/schema.ts:62-68
readonly '~types'?:
  | {
      readonly input: TInput;
      readonly output: TOutput;
      readonly issue: TIssue;
    }
  | undefined;
```

```ts
// library/src/types/infer.ts:14-23
export type InferInput<
  TItem extends
    | BaseSchema<unknown, unknown, BaseIssue<unknown>>
    | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>
    | BaseValidation<any, unknown, BaseIssue<unknown>>
    | ...
> = NonNullable<TItem['~types']>['input'];
```

`~` プレフィックスにより通常のプロパティと衝突せず、`@internal` JSDoc でライブラリ内部専用であることを明示している。

### Overload による型安全なパイプライン合成

`pipe()` 関数は19個のオーバーロードを持ち、各オーバーロードで「前段の出力型が次段の入力型に一致する」制約をチェーンで表現する。

```ts
// library/src/methods/pipe/pipe.ts:80-92 (1項目の例)
export function pipe<
  const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>,
  const TItem1 extends PipeItem<
    InferOutput<TSchema>,
    unknown,
    BaseIssue<unknown>
  >,
>(
  schema: TSchema,
  item1:
    | TItem1
    | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>,
): SchemaWithPipe<readonly [TSchema, TItem1]>;
```

2項目以降では `TItem2 extends PipeItem<InferOutput<TItem1>, ...>` のように前段の `InferOutput` を次段の制約に使い、型レベルでパイプラインの連結整合性を保証する。最終オーバーロード（19項目超）はフォールバックとして `readonly PipeItem<InferOutput<TSchema>, InferOutput<TSchema>, ...>[]` を受け取り、同一型のパイプラインに制限される。

この「有限個のオーバーロード + フォールバック」パターンは、TypeScript で可変長ジェネリクスの制約チェーンを表現する定番手法である。

### Brand / Flavor による名目的型付け

`brand()` は `unique symbol` を用いた交差型で名目的型（nominal type）を実現する。

```ts
// library/src/actions/brand/brand.ts:5-7
export declare const BrandSymbol: unique symbol;

export interface Brand<TName extends BrandName> {
  [BrandSymbol]: { [TValue in TName]: TValue; };
}
```

`BrandAction` は `BaseTransformation<TInput, TInput & Brand<TName>, never>` を extends し、出力型に `Brand<TName>` を交差する。`never` issue 型はブランディングが失敗しない（純粋な型レベル操作）ことを示す。

一方 `flavor()` は `BrandSymbol` の代わりに `FlavorSymbol?:` を使い、optional にすることで「弱い名目的型」を実現する。flavor されていない値は flavor 付きの変数に代入可能だが、異なる flavor 間の代入は禁止される。

```ts
// library/src/actions/flavor/flavor.ts:22-23
export interface Flavor<TName extends FlavorName> {
  [FlavorSymbol]?: { [TValue in TName]: TValue; };
}
```

### Discriminated Union によるデータセット型の分岐

バリデーション結果のデータセットは `typed` プロパティの `true/false` をディスクリミナントとして使い分ける。

```ts
// library/src/types/dataset.ts:24-37
export interface SuccessDataset<TValue> {
  typed: true;
  value: TValue;
  issues?: undefined;
}

// library/src/types/dataset.ts:60-73
export interface FailureDataset<TIssue extends BaseIssue<unknown>> {
  typed: false;
  value: unknown;
  issues: [TIssue, ...TIssue[]];
}
```

`issues` プロパティが `undefined` と `[T, ...T[]]` で排他的に定義されることで、`typed: true` のとき `issues` は存在しない（または空）、`typed: false` のとき `issues` は必ず1件以上あることが型レベルで保証される。非空配列の表現に `[T, ...T[]]` タプル型を使うのは valibot 全体で一貫している。

### Mapped Type によるオブジェクトスキーマの型推論

オブジェクトスキーマでは、エントリ定義から入力型・出力型・オプショナルキーをそれぞれ mapped type で導出する。

```ts
// library/src/types/object.ts:154-160
type OptionalInputKeys<TEntries extends ObjectEntries | ObjectEntriesAsync> = {
  [TKey in keyof TEntries]: TEntries[TKey] extends
    | OptionalEntrySchema
    | OptionalEntrySchemaAsync ? TKey
    : never;
}[keyof TEntries];
```

このパターンは「mapped type で条件に合うキーだけを抽出し、`[keyof T]` でユニオンにする」という型レベルフィルタリングの典型例である。さらに `MarkOptional` ユーティリティと組み合わせて `?` 修飾子を適切に付与する。

### ユーティリティ型による型レベルプログラミング

`library/src/types/utils.ts` には汎用的な型ユーティリティが集約されている。

```ts
// library/src/types/utils.ts:4
export type IsAny<Type> = 0 extends 1 & Type ? true : false;

// library/src/types/utils.ts:9
export type IsNever<Type> = [Type] extends [never] ? true : false;

// library/src/types/utils.ts:44
export type Prettify<TObject> = { [TKey in keyof TObject]: TObject[TKey]; } & {};

// library/src/types/utils.ts:81-87
export type UnionToIntersect<TUnion> = (TUnion extends any ? (arg: TUnion) => void : never) extends (
  arg: infer Intersect,
) => void ? Intersect
  : never;
```

`IsAny` は `0 extends 1 & Type` という一見不可解な式だが、`any` の場合のみ `1 & any` が `any` になり `0 extends any` が `true` になる。`IsNever` は `[Type] extends [never]` とタプルで包むことで distributive conditional type を回避する。これらは TypeScript の型システムの挙動を深く理解した上でのイディオムである。

## パターンカタログ

- **Phantom Type** (構造)
  - 解決する問題: ランタイムコストなしに型レベルの情報を伝播する
  - 適用条件: ジェネリックな構造体に付随する型情報を、プロパティアクセスなしに推論させたい場合
  - コード例: `library/src/types/schema.ts:62-68`（`'~types'?` プロパティ）
  - 注意点: phantom プロパティの名前は通常プロパティと衝突しないプレフィックスを使う

- **Branded Type / Nominal Typing** (構造)
  - 解決する問題: 構造的に同一だが意味的に異なる型を区別する
  - 適用条件: `UserId` と `OrderId` のように同じ `string` だが混同を防ぎたい場合
  - コード例: `library/src/actions/brand/brand.ts:5-18`
  - 注意点: `unique symbol` を使い、必須プロパティにすると強い（Brand）、optional にすると弱い（Flavor）名目的型になる

- **Discriminated Union** (振る舞い)
  - 解決する問題: ユニオン型のメンバーを型安全に分岐する
  - 適用条件: 複数のバリアントを持つデータ構造で、各バリアントに固有の処理が必要な場合
  - コード例: `library/src/types/dataset.ts:78-81`（`OutputDataset`）、`library/src/types/issue.ts:225`（`kind` による分類）
  - 注意点: ディスクリミナントには文字列リテラル型を使い、全バリアントで同名プロパティにする

## Good Patterns

- **Generic 型に `any` デフォルトを持つ "Generic" エイリアス**: `BaseSchema<TInput, TOutput, TIssue>` に対して `GenericSchema<TInput = unknown, TOutput = TInput>` を提供する。ライブラリ内部では厳密な型パラメータを使い、利用者側の型注釈では緩い `GenericSchema` を使えるようにする二重構造。

```ts
// library/src/types/schema.ts:114-118
export type GenericSchema<
  TInput = unknown,
  TOutput = TInput,
  TIssue extends BaseIssue<unknown> = BaseIssue<unknown>,
> = BaseSchema<TInput, TOutput, TIssue>;
```

- **非空配列を `[T, ...T[]]` タプルで表現**: `issues` や `path` のように「必ず1つ以上の要素がある」配列を `[TIssue, ...TIssue[]]` で表現し、空配列を型レベルで排除する。

```ts
// library/src/types/dataset.ts:54
issues: [TIssue, ...TIssue[]];
```

- **`Prettify<T>` で IDE 表示を改善**: `{ [K in keyof T]: T[K] } & {}` で intersection 型を展開し、型のプレビューを読みやすくする。

```ts
// library/src/types/utils.ts:44
export type Prettify<TObject> = { [TKey in keyof TObject]: TObject[TKey]; } & {};
```

- **async バリアントを `Omit` + 差分プロパティで定義**: `BaseSchemaAsync` は `Omit<BaseSchema<...>, 'reference' | 'async' | '~run'>` を extends し、差分のみを再定義する。同期/非同期の共通部分を DRY に保つ。

```ts
// library/src/types/schema.ts:74-81
export interface BaseSchemaAsync<TInput, TOutput, TIssue extends BaseIssue<unknown>>
  extends Omit<BaseSchema<TInput, TOutput, TIssue>, 'reference' | 'async' | '~run'> {
  readonly async: true;
  readonly '~run': (...) => Promise<OutputDataset<TOutput, TIssue>>;
}
```

## Anti-Patterns / 注意点

- **過度な `@ts-expect-error` への依存**: valibot のランタイム実装（`~run` メソッド内）では内部的な型の安全性を犠牲にして `@ts-expect-error` を多用している（object.ts 内だけで10箇所以上）。これは「公開 API の型安全性を最大化するために内部実装では型チェックを緩和する」というトレードオフの結果である。

```ts
// Bad: 内部実装で型チェックを全面的に無視
// @ts-expect-error
dataset.typed = true;
// @ts-expect-error
dataset.value = {};

// Better: 内部用の型ガード関数や assertion 関数を用意して最小限に抑える
function setTyped(dataset: UnknownDataset): asserts dataset is TypedDataset {
  (dataset as TypedDataset).typed = true;
}
```

ただし valibot の場合、これはパフォーマンス最適化（オブジェクト再生成の回避）のための意図的な判断であり、公開型の安全性は overload と phantom type で保証されている。

- **Overload の爆発的増加**: `pipe()` は19個のオーバーロードで2700行超のファイルになっている。TypeScript が variadic tuple type の制約チェーンを十分にサポートしないための回避策だが、保守コストが高い。

```ts
// Bad: 手動で N 個のオーバーロードを書く
export function pipe<TSchema, TItem1>(schema, item1): SchemaWithPipe<[TSchema, TItem1]>;
export function pipe<TSchema, TItem1, TItem2>(schema, item1, item2): SchemaWithPipe<[TSchema, TItem1, TItem2]>;
// ... 19 overloads

// Better（将来的に）: TypeScript の改善を待つか、コード生成で管理する
```

## 導出ルール

- `[MUST]` ライブラリの公開型定義でオブジェクト形状を定義する場合は `interface` を使い、`type` はユニオン・交差・マップ型に限定する
  - 根拠: valibot は全ての基底型（`BaseSchema`, `BaseValidation`, `BaseTransformation` 等）を `interface` で定義し、TypeScript コンパイラの型キャッシュを活用して深いジェネリクスのパフォーマンスを確保している（`library/src/types/schema.ts`, `validation.ts`, `transformation.ts`）
- `[MUST]` discriminated union のディスクリミナントには文字列リテラル型を使い、全バリアントで同名の `readonly` プロパティとして定義する
  - 根拠: valibot は `kind: 'schema' | 'validation' | 'transformation' | 'metadata'` と `type: 'string' | 'object' | ...` の2段ディスクリミナントで型の絞り込みとランタイム分岐を統一している（`library/src/types/schema.ts:17-21`, `library/src/utils/_addIssue/_addIssue.ts:103`）
- `[SHOULD]` 型レベルで「少なくとも1つの要素がある配列」を表現する場合は `[T, ...T[]]` タプル型を使う
  - 根拠: valibot は `issues`, `path`, `pipe` など安全性が求められるあらゆる配列で非空タプルを使い、空配列によるランタイムエラーを型レベルで防止している（`library/src/types/dataset.ts:54`, `issue.ts:253`）
- `[SHOULD]` ランタイムに不要だが型推論に必要な情報は phantom プロパティとして optional で定義し、`NonNullable<T[prop]>` で取り出す
  - 根拠: valibot の `'~types'?` は実行時に値を持たないが、`InferInput<T>`, `InferOutput<T>`, `InferIssue<T>` の推論を可能にしている。プレフィックス `~` により通常プロパティとの衝突を回避（`library/src/types/schema.ts:62-68`, `infer.ts:14-23`）
- `[SHOULD]` 構造的に同一だが意味的に異なるプリミティブ型を区別したい場合は、`unique symbol` を使った branded type パターンを適用する
  - 根拠: valibot は `Brand` と `Flavor` の2種類の名目的型を提供し、交差型でプリミティブに名目的な区別を付与する。`Brand`（必須）は厳密、`Flavor`（optional）は緩やかな区別（`library/src/actions/brand/brand.ts:5-18`, `flavor/flavor.ts:22-23`）
- `[SHOULD]` 同期/非同期バリアントを持つ型は、同期版を基底として `Omit` + 差分プロパティの `extends` で非同期版を定義し、共通部分の重複を排除する
  - 根拠: valibot は `BaseSchemaAsync extends Omit<BaseSchema, 'async' | '~run' | 'reference'>` のパターンを `Schema`, `Validation`, `Transformation` の全基底型で統一的に適用し、差分は `async: true` と `Promise` 戻り値のみ（`library/src/types/schema.ts:74-81`）
- `[AVOID]` ジェネリック関数で `const` type parameter を使わずに引数のリテラル型を失う設計
  - 根拠: valibot は全てのスキーマファクトリ関数で `const TEntries`, `const TMessage`, `const TOptions` を使い、`object({ key: string() })` のようにリテラルキー情報を保持して正確な型推論を実現している（`library/src/schemas/object/object.ts:60`, `string/string.ts:66`）
- `[AVOID]` IDE での型表示が intersection や条件型の入れ子のまま展開されない状態を放置すること
  - 根拠: valibot は `Prettify<T>` 型（`{ [K in keyof T]: T[K] } & {}`）を `InferObjectInput`, `InferObjectOutput` に適用し、ユーザーが hover した際に読みやすい展開済みの型が表示されるようにしている（`library/src/types/utils.ts:44`, `object.ts:222`）

## 適用チェックリスト

- [ ] ライブラリの公開型でオブジェクト形状に `type` を使っている箇所を `interface` に置き換える
- [ ] ユニオン型のバリアントに共通のディスクリミナント（`kind`, `type` 等の文字列リテラル `readonly` プロパティ）があるか確認する
- [ ] 「必ず1つ以上」の制約がある配列に `[T, ...T[]]` タプル型を適用しているか確認する
- [ ] 型推論に必要だがランタイムに不要な情報がある場合、phantom プロパティのパターンを検討する
- [ ] `UserId`, `OrderId` のような意味的に異なるプリミティブ型に branded type を導入しているか確認する
- [ ] ジェネリック関数の引数でリテラル型を保持する必要がある箇所に `const` type parameter を使っているか確認する
- [ ] 公開型の IDE プレビューが読みやすいか確認し、必要に応じて `Prettify<T>` を適用する
- [ ] 同期/非同期バリアントの型定義で共通部分が重複していないか確認する
- [ ] 型レベルテスト（vitest `--typecheck` + `expectTypeOf`）をテストスイートに含めているか確認する
