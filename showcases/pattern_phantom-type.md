# Pattern: Phantom Type

> 出典: [repos/open-circle/valibot](../repos/open-circle/valibot/) からの知見
> カテゴリ: pattern

## 概要

Phantom Type は、ランタイムには存在しないがコンパイル時の型推論にのみ使われるプロパティをオブジェクトに埋め込むパターンである。valibot では `'~types'?` という optional プロパティに入力型・出力型・エラー型の3つを格納し、`NonNullable<T['~types']>['input']` で取り出すことで、実行時オーバーヘッドゼロの型情報伝播を実現している。型安全な DSL、ビルダーパターン、パイプライン合成など、ジェネリックな構造体に型レベルのメタデータを持たせたいあらゆる場面に転用できる。

## 背景・文脈

valibot はスキーマバリデーションライブラリであり、`string()`, `object()`, `pipe()` などの関数を組み合わせてスキーマを構築する。ユーザーが定義したスキーマから TypeScript の型を推論する（`InferInput<T>`, `InferOutput<T>`）ことがライブラリの核心機能だが、スキーマオブジェクトのランタイム構造と TypeScript の型パラメータは本来別の世界に存在する。

この「ランタイム値と型情報のギャップ」を埋めるのが Phantom Type パターンである。valibot は `BaseSchema`, `BaseValidation`, `BaseTransformation`, `BaseMetadata` の全基底 interface に統一的に `'~types'?` プロパティを配置し、ライブラリ全体の型推論基盤としている。

チルダ `~` プレフィックスは valibot 独自の命名規約で、`'~run'`（内部実行メソッド）、`'~standard'`（Standard Schema 準拠プロパティ）、`'~types'`（phantom type）の3つに使われている。通常のプロパティ名（`message`, `entries`, `kind` 等）と名前空間を分離し、内部 API であることを視覚的に明示する効果がある。

## 実装パターン

### 基底 interface での phantom property 定義

全ての基底型に共通の形状で `'~types'?` が定義されている。`readonly` かつ `optional` かつ `| undefined` の3重ガードにより、ランタイムでの値代入を防ぎ、メモリ消費をゼロにしている。

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

同じパターンが `BaseValidation`（`library/src/types/validation.ts:56-62`）、`BaseTransformation`（`library/src/types/transformation.ts:52-58`）、`BaseMetadata`（`library/src/types/metadata.ts:26-32`）にも適用される。

### 型情報の抽出

`InferInput`, `InferOutput`, `InferIssue` が `NonNullable<T['~types']>` で phantom property にアクセスし、型情報を取り出す。

```ts
// library/src/types/infer.ts:14-23
export type InferInput<
  TItem extends
    | BaseSchema<unknown, unknown, BaseIssue<unknown>>
    | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>
    | BaseValidation<any, unknown, BaseIssue<unknown>>
    | BaseValidationAsync<any, unknown, BaseIssue<unknown>>
    | BaseTransformation<any, unknown, BaseIssue<unknown>>
    | BaseTransformationAsync<any, unknown, BaseIssue<unknown>>
    | BaseMetadata<any>,
> = NonNullable<TItem["~types"]>["input"];
```

`NonNullable` が必要な理由は、`'~types'` が `T | undefined` の union であるため。`undefined` を除去してから `['input']` でインデックスアクセスする。

### ファクトリ関数は phantom property に値を代入しない

ファクトリ関数が返すオブジェクトリテラルに `'~types'` は含まれない。TypeScript の型推論がジェネリックパラメータを通じて phantom property の型を解決するため、値の代入は不要である。

```ts
// library/src/schemas/string/string.ts:70-94
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
        dataset.typed = true;
      } else {
        _addIssue(this, "type", dataset, config);
      }
      return dataset;
    },
    // '~types' はここに存在しない -- 型レベルでのみ機能する
  };
}
```

## Good Example

Phantom Type を使ってランタイムコストゼロで型情報を伝播するパターン。

```ts
// --- 1. 基底 interface に phantom property を定義する ---
interface BaseNode<TInput, TOutput> {
  readonly kind: string;
  // phantom property: ランタイムには値を持たない
  readonly "~types"?: {
    readonly input: TInput;
    readonly output: TOutput;
  } | undefined;
}

// --- 2. 型抽出ユーティリティを定義する ---
type InferInput<T extends BaseNode<unknown, unknown>> = NonNullable<T["~types"]>["input"];
type InferOutput<T extends BaseNode<unknown, unknown>> = NonNullable<T["~types"]>["output"];

// --- 3. 具象ノードの interface を定義する ---
interface StringNode extends BaseNode<string, string> {
  readonly kind: "string";
}

interface NumberNode extends BaseNode<unknown, number> {
  readonly kind: "number";
}

// --- 4. ファクトリ関数は phantom property に値を代入しない ---
function stringNode(): StringNode {
  return {
    kind: "string",
    // '~types' は存在しない -- 型パラメータ経由で推論される
  };
}

// --- 5. 型推論が機能する ---
type Input = InferInput<StringNode>; // string
type Output = InferOutput<NumberNode>; // number
```

### チルダプレフィックスによる名前空間分離

```ts
// valibot の3つの内部プロパティ
// library/src/types/schema.ts:42, 53, 62
readonly '~standard': StandardProps<TInput, TOutput>;  // Standard Schema 準拠
readonly '~run': (dataset, config) => OutputDataset;    // 内部実行メソッド
readonly '~types'?: { input; output; issue } | undefined; // phantom type

// チルダプレフィックスの利点:
// - ユーザー定義プロパティ (message, entries, kind 等) と衝突しない
// - Symbol と異なり JSON シリアライズ可能性を維持する
// - _ (アンダースコア) や $ より視覚的に「内部 API」であることが明確
// - IDE の補完リストで末尾にソートされ、公開 API の邪魔にならない
```

## Bad Example

### NG: ジェネリクスの型パラメータをランタイム値として格納する

```ts
// Bad: ランタイムに型情報を格納してしまう
interface BadSchema<TInput, TOutput> {
  kind: string;
  _inputType: TInput; // ランタイムに値が必要 -> メモリを消費する
  _outputType: TOutput; // かつ、実際に何を代入すべきか不明
}

function badString(): BadSchema<string, string> {
  return {
    kind: "string",
    _inputType: "" as string, // 無意味なダミー値を代入する羽目になる
    _outputType: "" as string, // 型安全でもなく、バンドルサイズも増加する
  };
}
```

### NG: phantom property を required にする

```ts
// Bad: optional でないと値の代入が必須になる
interface BadSchema<TInput, TOutput> {
  kind: string;
  "~types": { // ← optional (?) がない
    input: TInput;
    output: TOutput;
  };
}

function badString(): BadSchema<string, string> {
  return {
    kind: "string",
    "~types": { // 値を代入しなければ型エラーになる
      input: "" as string, // ランタイムにオブジェクトが生成されてしまう
      output: "" as string,
    },
  };
}
```

### NG: `as any` で phantom property の型情報を破壊する

```ts
// Bad: as any を使うと型情報が失われる
function inferInput<T extends BaseSchema<unknown, unknown, any>>(
  schema: T,
): T["~types"] { // NonNullable を使わないと undefined が混入する
  return undefined as any; // 型安全性が完全に崩壊する
}
```

## 適用ガイド

### どのような状況で使うべきか

- **スキーマ / バリデーションライブラリ**: 入力型と出力型をスキーマオブジェクトから推論したい場合。valibot, Zod, ArkType 等が実際に使用している。
- **型安全なビルダーパターン**: ビルダーの各メソッド呼び出しで型パラメータが変化し、最終的な `build()` の戻り値型を累積的に決定したい場合。
- **型安全なパイプライン / ミドルウェア**: 前段の出力型が次段の入力型に制約されるチェーンを構築する場合。valibot の `pipe()` がまさにこの用途。
- **DSL の型レベルメタデータ**: ORM のカラム定義、ルーター定義、CLI 引数パーサなど、宣言的な構造体に型情報を埋め込みたい場合。

### 導入時の注意点

1. **phantom property は必ず `optional` + `| undefined` にする**: required にするとファクトリ関数で値の代入が必要になり、Phantom Type の意味がなくなる。valibot では `readonly '~types'?: T | undefined` の形を全基底型で徹底している。

2. **`NonNullable` で取り出す**: phantom property が `T | undefined` なので、直接 `T['~types']['input']` とするとコンパイルエラーになる。必ず `NonNullable<T['~types']>['input']` の形でアクセスする。

3. **名前衝突を避けるプレフィックスを使う**: valibot はチルダ `~` を採用しているが、`__` (ダブルアンダースコア), `$` (ドル), Symbol なども選択肢。チルダは JSON 互換性を維持しつつ視覚的に目立つバランスの良い選択。

4. **`interface` で定義する**: `type` ではなく `interface` で基底型を定義すると、TypeScript コンパイラが型をキャッシュするため、深くネストされたジェネリクスでの型チェックパフォーマンスが向上する。

5. **`@internal` JSDoc で公開 API でないことを明示する**: valibot では phantom property に `@internal` を付与し、ドキュメント生成から除外している。

### カスタマイズポイント

- **phantom property に格納する情報の種類**: valibot は `input`, `output`, `issue` の3つだが、用途に応じて `metadata`, `context`, `config` など任意の型情報を追加できる。
- **プレフィックスの選択**: `~` 以外にも `$internal_`, `__phantom_` など、プロジェクトの命名規約に合わせて選択する。重要なのは「通常のプロパティと衝突しない」こと。
- **抽出ユーティリティの粒度**: valibot は `InferInput`, `InferOutput`, `InferIssue` の3つを個別に提供しているが、1つの `Infer<T, K>` ジェネリックユーティリティにまとめることも可能。

## 参考

- [repos/open-circle/valibot/type-system-patterns.md](../repos/open-circle/valibot/type-system-patterns.md) -- Phantom Type を含む型システムパターンの包括的分析
- [repos/open-circle/valibot/abstraction-patterns.md](../repos/open-circle/valibot/abstraction-patterns.md) -- `'~run'`, `'~types'` のチルダプレフィックス設計
- [repos/open-circle/valibot/metaprogramming-techniques.md](../repos/open-circle/valibot/metaprogramming-techniques.md) -- Phantom Property と型レベルユーティリティの詳細分析
- [repos/open-circle/valibot/architecture.md](../repos/open-circle/valibot/architecture.md) -- パイプラインアーキテクチャにおける Phantom Type の役割
