# メタプログラミング手法

> リポジトリ: open-circle/valibot
> 分析日: 2026-02-16

## 概要

Valibot はスキーマ定義からランタイムバリデーションと TypeScript 型を同時に導出する「Runtime-to-Type」メタプログラミングの代表例である。さらに、jscodeshift を用いた AST ベースの codemod（Zod からの移行、バージョン間マイグレーション）を備え、コードを「データとして操作する」手法が横断的に適用されている。本分析では、型レベル計算・スキーマの代数的変換・AST 変換の3軸からメタプログラミングのプラクティスを抽出する。

## 背景にある原則

- **Phantom Property パターンで型情報を埋め込む**: ランタイムオブジェクトに `'~types'?` というオプショナルな phantom プロパティを持たせ、実行時にはメモリを消費せず型推論にのみ使う。これにより、ランタイム値と型情報を単一オブジェクトに同居させられる（`library/src/types/schema.ts:62-68`）。
- **関数オーバーロードの段階展開で可変長の型安全を実現する**: TypeScript の variadic generics だけでは表現力が不足する場面で、具体的なアリティ別オーバーロードを並べて完全な型安全を提供する（`library/src/methods/pipe/pipe.ts` に 19 個のオーバーロード）。冗長だが型エラーメッセージの品質とコンパイル速度に優れる。
- **スキーマを代数的に操作する**: `partial()`, `required()`, `pick()`, `omit()` はスキーマオブジェクトの `entries` を走査・変換して新しいスキーマを返す。元のスキーマを変異させず、spread コピーした上で entries だけ差し替える Immutable 変換パターンを一貫して適用している。
- **AST 変換で API マイグレーションを自動化する**: jscodeshift/ast-grep を使ったパターンマッチ + 置換でユーザーコードを機械的に書き換える。テスト駆動（input/output fixture）で変換の正確性を保証する。

## 実例と分析

### 1. Phantom Property による型情報の埋め込み

Valibot の全スキーマ・バリデーション・トランスフォーメーションは `'~types'?` プロパティを持つ。このプロパティはオプショナルかつ `undefined` との union であるため、ランタイムには値が割り当てられない。しかし型レベルでは `NonNullable<TItem['~types']>['input']` のように取り出せる。

```typescript
// library/src/types/schema.ts:62-68
readonly '~types'?:
  | {
      readonly input: TInput;
      readonly output: TOutput;
      readonly issue: TIssue;
    }
  | undefined;
```

```typescript
// library/src/types/infer.ts:14-23
export type InferInput<
  TItem extends
    | BaseSchema<unknown, unknown, BaseIssue<unknown>>
    | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>
    | BaseValidation<any, unknown, BaseIssue<unknown>>,
> // ... 省略
 = NonNullable<TItem["~types"]>["input"];
```

注目すべきは `~` プレフィックスの使用である。これにより通常のプロパティとの衝突を回避し、内部 API であることを視覚的に示している（`~standard`, `~run`, `~types`）。

### 2. 型レベルのユーティリティ型

`library/src/types/utils.ts` には型レベル計算のための精巧なユーティリティが揃っている。

**any 型の検出**:

```typescript
// library/src/types/utils.ts:4
export type IsAny<Type> = 0 extends 1 & Type ? true : false;
```

**Union から Intersection への変換**:

```typescript
// library/src/types/utils.ts:81-87
export type UnionToIntersect<TUnion> = (TUnion extends any ? (arg: TUnion) => void : never) extends (
  arg: infer Intersect,
) => void ? Intersect
  : never;
```

ここでは contravariant position を利用した inference trick が使われている。関数の引数位置に型を配置することで、TypeScript の推論が intersection を生成する性質を利用する。

**Union から Tuple への変換**（末尾再帰最適化付き）:

```typescript
// library/src/types/utils.ts:94-104
type UnionToTupleHelper<TUnion, TResult extends unknown[]> = UnionToIntersect<
  TUnion extends never ? never : () => TUnion
> extends () => infer TLast ? UnionToTupleHelper<Exclude<TUnion, TLast>, [TLast, ...TResult]>
  : TResult;

export type UnionToTuple<TUnion> = UnionToTupleHelper<TUnion, []>;
```

**Prettify 型** -- IDE のプレビュー品質向上のための「何もしない」mapped type:

```typescript
// library/src/types/utils.ts:44
export type Prettify<TObject> = { [TKey in keyof TObject]: TObject[TKey]; } & {};
```

この型は動作上は何も変えないが、TypeScript の hover プレビューで中間型が展開されて表示される効果がある。

### 3. オブジェクトスキーマの型レベル optional 判定

`library/src/types/object.ts` では、entries の各キーが optional かどうかを型レベルで判定し、出力型にクエスチョンマーク（`?`）を付与している。

```typescript
// library/src/types/object.ts:154-161
type OptionalInputKeys<TEntries extends ObjectEntries | ObjectEntriesAsync> = {
  [TKey in keyof TEntries]: TEntries[TKey] extends
    | OptionalEntrySchema
    | OptionalEntrySchemaAsync ? TKey
    : never;
}[keyof TEntries];
```

この「mapped type でキーをフィルタし、最後に `[keyof T]` でキーの union を取得する」パターンは、TypeScript の型レベルプログラミングにおける頻出イディオムである。

### 4. スキーマの代数的変換（partial/required/pick/omit）

`partial()` は entries を走査して各スキーマを `optional()` でラップする。ランタイムとコンパイル時の両方で正しく動作する。

```typescript
// library/src/methods/partial/partial.ts:270-292
export function partial(
  schema: Schema,
  keys?: ObjectKeys<Schema>,
): SchemaWithPartial<Schema, ObjectKeys<Schema> | undefined> {
  const entries: PartialEntries<ObjectEntries, ObjectKeys<Schema>> = {};
  for (const key in schema.entries) {
    // @ts-expect-error
    entries[key] = !keys || keys.includes(key)
      ? optional(schema.entries[key])
      : schema.entries[key];
  }
  return {
    ...schema,
    entries,
    get "~standard"() {
      return _getStandardProps(this);
    },
  };
}
```

型レベルでは `PartialEntries` が同じロジックを表現する:

```typescript
// library/src/methods/partial/partial.ts:52-61
type PartialEntries<
  TEntries extends ObjectEntries,
  TKeys extends readonly (keyof TEntries)[] | undefined,
> = {
  [TKey in keyof TEntries]: TKeys extends readonly (keyof TEntries)[]
    ? TKey extends TKeys[number] ? OptionalSchema<TEntries[TKey], undefined>
    : TEntries[TKey]
    : OptionalSchema<TEntries[TKey], undefined>;
};
```

### 5. Pipe の型チェイン

`pipe()` の overload では、各アイテムの入力型が前のアイテムの出力型に連鎖する制約を表現している:

```typescript
// library/src/methods/pipe/pipe.ts:80-92 (2-item overload)
export function pipe<
  const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>,
  const TItem1 extends PipeItem<
    InferOutput<TSchema>, // 前段の出力 = 次段の入力
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

最終的な出力型は `FirstTupleItem` (入力型) と `LastTupleItem` (出力型) で決まる:

```typescript
// library/src/methods/pipe/pipe.ts:37-39
readonly '~standard': StandardProps<
  InferInput<FirstTupleItem<TPipe>>,
  InferOutput<LastTupleItem<TPipe>>
>;
```

### 6. self-reference パターン

各スキーマファクトリ関数は `reference` プロパティに自分自身を格納する:

```typescript
// library/src/schemas/object/object.ts:87-90
return {
  kind: "schema",
  type: "object",
  reference: object, // 関数自身への参照
  // ...
};
```

これにより、スキーマオブジェクトからそのコンストラクタ関数を取得でき、動的なスキーマ再構築やイントロスペクションが可能になる。

### 7. AST ベースの codemod

**Zod-to-Valibot codemod** は jscodeshift を使い、Zod の API 呼び出しを Valibot 相当に変換する。`library/src/transform/index.ts` でインポート変換とスキーマ変換を分離し、各変換は独立したモジュールとして実装されている。

**バージョンマイグレーション codemod** は ast-grep を使い、パターンマッチベースで API 変更を適用する。`deepSearch` ヘルパーにより、ネストされた変換を繰り返し適用する:

```typescript
// codemod/migrate-to-v0.31.0/src/index.ts:164-172
async function deepSearch(
  action: (continue_: () => void) => Promise<unknown>,
) {
  let notDone = true;
  while (notDone) {
    notDone = false;
    await action(() => (notDone = true));
  }
}
```

テストは input/output fixture ペアで駆動され、入力ファイルを変換した結果が期待出力と一致するか検証する。

## パターンカタログ

- **Phantom Type パターン** (分類: 構造)
  - 解決する問題: ランタイム値と型情報の同居
  - 適用条件: コンパイル時にのみ必要な型情報をランタイムオブジェクトに紐づけたい場合
  - コード例: `library/src/types/schema.ts:62-68`
  - 注意点: プロパティをオプショナル + `| undefined` にしないとメモリを消費する

- **Builder / Fluent Composition パターン** (分類: 生成)
  - 解決する問題: スキーマの段階的構築と変換
  - 適用条件: 不変データ構造を組み合わせて複雑な構造を宣言的に構築したい場合
  - コード例: `library/src/methods/pipe/pipe.ts:2694-2732`, `library/src/methods/partial/partial.ts:270-292`
  - 注意点: spread による浅いコピーなので、ネストされた entries 内部は共有される

- **Visitor / AST Transformation パターン** (分類: 振る舞い)
  - 解決する問題: 既存コードの機械的な書き換え
  - 適用条件: API の破壊的変更時にユーザーコードを自動マイグレーションしたい場合
  - コード例: `codemod/migrate-to-v0.31.0/src/index.ts:193-209`
  - 注意点: AST パターンマッチは false positive に注意（インポート元の検証が必須）

## Good Patterns

- **Phantom Property でランタイムコストなしの型情報埋め込み**: `'~types'?` を `| undefined` との union にすることで、ランタイムでプロパティが存在しなくても型レベルでは `NonNullable<T['~types']>` で情報を取り出せる。メモリ効率と型安全を両立する優れた手法。

```typescript
// library/src/types/schema.ts:62-68
readonly '~types'?:
  | { readonly input: TInput; readonly output: TOutput; readonly issue: TIssue; }
  | undefined;

// library/src/types/infer.ts:23
export type InferInput<TItem extends ...> = NonNullable<TItem['~types']>['input'];
```

- **@\_\_NO_SIDE_EFFECTS\_\_ アノテーションによる Tree-shaking 保証**: 全てのスキーマファクトリ関数に `// @__NO_SIDE_EFFECTS__` コメントを付与し、バンドラー（Rollup/Vite 等）が未使用のスキーマを確実に除去できるようにしている。クラスではなくファクトリ関数 + オブジェクトリテラルを採用する設計判断と密接に関連する。

```typescript
// library/src/schemas/object/object.ts:82-86
// @__NO_SIDE_EFFECTS__
export function object(
  entries: ObjectEntries,
  message?: ErrorMessage<ObjectIssue>
): ObjectSchema<ObjectEntries, ErrorMessage<ObjectIssue> | undefined> {
```

- **Codemod のインポート検証**: Zod-to-Valibot codemod では、AST パターンに合致しても実際に `zod` からインポートされたものかどうかを検証してから変換する。`createImportCheck()` と `createNameCheck()` で「名前だけの一致」による誤変換を防止している。

```typescript
// codemod/migrate-to-v0.31.0/src/index.ts:126-137
function createImportCheck() {
  return (name: string | undefined): boolean => {
    if (
      name
      && ((wildcardImport && name.startsWith(`${wildcardImport}.`))
        || directImports.includes(name))
    ) {
      return true;
    }
    return false;
  };
}
```

## Anti-Patterns / 注意点

- **オーバーロード爆発**: `pipe()` は 19 個のオーバーロードで 2700 行に達する。型安全性は完璧だが、保守コストが高い。TypeScript の variadic generics やテンプレートリテラル型が将来的に改善されれば、マクロ的な生成に移行できる可能性がある。

Bad: 手動で N 個のオーバーロードを書く（現在の手法、保守は可能だが脆い）

```typescript
// library/src/methods/pipe/pipe.ts (19 overloads, ~2700 lines)
export function pipe<TSchema, TItem1>(schema, item1): SchemaWithPipe<[TSchema, TItem1]>;
export function pipe<TSchema, TItem1, TItem2>(schema, item1, item2): SchemaWithPipe<[TSchema, TItem1, TItem2]>;
// ... 17 more overloads
```

Better: 可変長の場合はフォールバック overload を末尾に配置し、型の精度と保守性のバランスを取る（Valibot は実際にこれも行っている）

```typescript
// library/src/methods/pipe/pipe.ts:2672-2682
// フォールバック: 型の精度は下がるが任意個数に対応
export function pipe<
  const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>,
  const TItems extends readonly PipeItem<
    InferOutput<TSchema>,
    InferOutput<TSchema>,
    BaseIssue<unknown>
  >[],
>(schema: TSchema, ...items: TItems): SchemaWithPipe<readonly [TSchema, ...TItems]>;
```

- **@ts-expect-error の多用**: スキーマ変換メソッド（`partial`, `pick`, `omit` 等）のランタイム実装部分で `@ts-expect-error` が頻出する。型レベルの表現とランタイムの表現にギャップがある場合の妥協策だが、型安全の穴になりうる。

Bad: 理由なしの `@ts-expect-error`

```typescript
// @ts-expect-error
entries[key] = optional(schema.entries[key]);
```

Better: 理由を明示する（Valibot のコードでは一部に記述あり）

```typescript
// @ts-expect-error -- entries の型パラメータが具体型に解決される前のため
entries[key] = optional(schema.entries[key]);
```

## 導出ルール

- `[MUST]` ランタイムオブジェクトに型情報を埋め込む場合、phantom property はオプショナル + `| undefined` にしてランタイムコストをゼロにする
  - 根拠: Valibot の `'~types'?` はランタイムに値を持たないがコンパイル時に `NonNullable<>` で型を抽出でき、バンドルサイズに影響しない（`library/src/types/schema.ts:62-68`）

- `[MUST]` AST ベースの codemod ではパターンマッチだけでなくインポート元を検証し、誤変換を防止する
  - 根拠: 同名の関数が異なるライブラリに存在しうるため、Valibot の codemod は `createImportCheck()` でインポート元が `zod` か `valibot` かを確認してから変換する（`codemod/migrate-to-v0.31.0/src/index.ts:126-137`）

- `[SHOULD]` Tree-shaking が重要なライブラリでは、クラスではなくファクトリ関数 + オブジェクトリテラルで構造体を構築し、`@__NO_SIDE_EFFECTS__` アノテーションを付与する
  - 根拠: Valibot の全スキーマファクトリは `// @__NO_SIDE_EFFECTS__` 付きの関数で、バンドラーが未使用コードを確実に除去できる（`library/src/schemas/object/object.ts:82`）

- `[SHOULD]` 型レベルの Prettify 型（`{ [K in keyof T]: T[K] } & {}`）を使い、IDE のホバープレビューでユーティリティ型の中間形を展開表示させる
  - 根拠: Valibot の `Prettify<TObject>` は動作に影響しないが、ユーザーが `InferOutput` の結果をホバーした際に展開された型を表示し、DX を向上させている（`library/src/types/utils.ts:44`）

- `[SHOULD]` 可変長引数の型安全が必要な場合、頻用アリティのオーバーロードを列挙しつつ、末尾にフォールバックオーバーロードを置いて任意個数にも対応する
  - 根拠: Valibot の `pipe()` は 1-19 個の overload で厳密な型チェインを提供し、20 個以上にはフォールバックで対応する（`library/src/methods/pipe/pipe.ts:2672-2682`）

- `[SHOULD]` スキーマの代数的変換（partial/pick/omit 等）では、元のスキーマを変異させず spread コピーして entries のみ差し替えた新しいオブジェクトを返す
  - 根拠: Valibot の `partial()`, `pick()`, `omit()` は全て `{ ...schema, entries: newEntries }` で不変性を保つ（`library/src/methods/partial/partial.ts:285-291`）

- `[AVOID]` `@ts-expect-error` を理由なしで使う -- 型レベルとランタイムのギャップが不可避な場合でも、なぜエラーが発生するかをコメントに記述する
  - 根拠: Valibot の `partial`, `pick`, `omit` のランタイム実装には理由なしの `@ts-expect-error` が多数あり、将来の型定義変更時に安全性を検証しづらい

## 適用チェックリスト

- [ ] ランタイムオブジェクトに型情報を持たせる場合、phantom property パターン（`'~types'?: { ... } | undefined`）を採用しているか
- [ ] スキーマや設定オブジェクトの変換メソッドが元オブジェクトを変異させず、新しいオブジェクトを返しているか
- [ ] ライブラリのエクスポート関数に `@__NO_SIDE_EFFECTS__` アノテーションを付与して tree-shaking を保証しているか
- [ ] 型ユーティリティに `Prettify` 型を適用して IDE のホバー表示を改善しているか
- [ ] codemod や lint ルールで AST パターンマッチを使う場合、インポート元を検証して false positive を防いでいるか
- [ ] 可変長ジェネリクスのオーバーロードに、フォールバック定義を末尾に配置しているか
- [ ] `@ts-expect-error` に理由コメントを付けているか
