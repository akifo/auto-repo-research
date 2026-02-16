# API Design Practices

> リポジトリ: open-circle/valibot
> 分析日: 2026-02-16

## 概要

valibot のパブリック API 設計を、一貫性・エルゴノミクス・関数オーバーロード戦略の観点から分析する。このライブラリは 100 以上の公開関数を持ちながら、すべてが同一の構造的パターンに従っている。特に注目すべきは、TypeScript の関数オーバーロードを「オプショナル引数の型精度を犠牲にしない」ために体系的に使用している点と、`kind`/`type`/`reference` による自己記述的なオブジェクト設計が API の introspection とツリーシェイキングを両立させている点である。

## 背景にある原則

- **Optional パラメータの型精度を関数オーバーロードで保証する**: すべてのスキーマ・アクション関数が「引数なし or 必須引数のみ」と「全引数指定」の 2 つ以上のオーバーロードを持つ。`message?: ErrorMessage | undefined` のように optional パラメータを使うと、省略時にも `TMessage` が `ErrorMessage | undefined` に推論されてしまう。オーバーロードにより省略時は `undefined` リテラル型に確定し、型レベルで「メッセージ未指定」を追跡できる（`library/src/schemas/string/string.ts:56-67`）。
- **統一された kind-type-reference トリプレットで自己記述的オブジェクトを構成する**: 全 API 関数の戻り値が `kind`（カテゴリ: schema/validation/transformation/metadata）、`type`（具体名: string/email/trim 等）、`reference`（関数自身への参照）を持つ。これにより、実行時の判別・シリアライズ・ツール連携が型安全に行える（`library/src/types/schema.ts:9-69`）。
- **合成（pipe）で機能を拡張し、スキーマ関数自体は単機能に保つ**: 各スキーマは型チェックのみ、各アクションは単一バリデーション/変換のみを担当する。複合ロジックは `pipe()` で合成する設計により、個々の関数が小さく保たれ、ツリーシェイキングが効く（`library/src/methods/pipe/pipe.ts:2694`）。
- **sync/async を型レベルで明確に分離する**: `BaseSchema` と `BaseSchemaAsync`、`string()` と関数名に `Async` サフィックスを付与した非同期版を別関数として提供する。`async: false | true` フラグで実行時にも判別可能にし、同期パスでは Promise を一切生成しない設計（`library/src/types/schema.ts:74-109`）。

## 実例と分析

### オーバーロード戦略: message パラメータの段階的追加

valibot では全関数が一貫した 2-overload パターンを採用している。第 1 オーバーロードは message を省略し、第 2 オーバーロードで message を受け取る。

```typescript
// library/src/schemas/string/string.ts:56-67
export function string(): StringSchema<undefined>;
export function string<
  const TMessage extends ErrorMessage<StringIssue> | undefined,
>(message: TMessage): StringSchema<TMessage>;
```

アクション関数ではこれが requirement + message の 2 段階になる。

```typescript
// library/src/actions/minLength/minLength.ts:77-99
export function minLength<
  TInput extends LengthInput,
  const TRequirement extends number,
>(requirement: TRequirement): MinLengthAction<TInput, TRequirement, undefined>;

export function minLength<
  TInput extends LengthInput,
  const TRequirement extends number,
  const TMessage extends
    | ErrorMessage<MinLengthIssue<TInput, TRequirement>>
    | undefined,
>(
  requirement: TRequirement,
  message: TMessage,
): MinLengthAction<TInput, TRequirement, TMessage>;
```

このパターンは 100 以上のファイルで一貫して適用されている。JSDoc は第 1 オーバーロードにのみ記述し、IDE のホバー時に最も簡潔なシグネチャが表示される。

### pipe() の固定長オーバーロードによる型推論チェーン

`pipe()` は 1〜19 個のアイテムに対して固定長オーバーロードを定義し（約 2700 行）、最後にフォールバック用の rest パラメータ版を置く。各オーバーロードで `TItem(N+1) extends PipeItem<InferOutput<TItemN>, ...>` と書くことで、前段の出力型が後段の入力型制約になる型安全なチェーンを実現している。

```typescript
// library/src/methods/pipe/pipe.ts:80-92
export function pipe<
  const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>,
  const TItem1 extends PipeItem<
    InferOutput<TSchema>,
    unknown,
    BaseIssue<unknown>
  >,
>(
  schema: TSchema,
  item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>,
): SchemaWithPipe<readonly [TSchema, TItem1]>;
```

20 個目以降は rest パラメータにフォールバックし、型推論の精度は落ちるが機能は維持される（`library/src/methods/pipe/pipe.ts:2672-2682`）。

### parse / safeParse / is / assert の対称的 API 表面

実行系メソッドが 4 つの対称的な形態で提供されている。

| 関数          | 戻り値                     | エラー時          | 用途             |
| ------------- | -------------------------- | ----------------- | ---------------- |
| `parse()`     | `InferOutput<T>`           | throw             | 信頼境界での変換 |
| `safeParse()` | `SafeParseResult<T>`       | issues プロパティ | フォーム検証     |
| `is()`        | `boolean` (type predicate) | false             | 型ガード         |
| `assert()`    | `void` (assertion)         | throw             | 事前条件チェック |

```typescript
// library/src/methods/is/is.ts:13-17
export function is<
  const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>,
>(schema: TSchema, input: unknown): input is InferInput<TSchema> {
  return !schema["~run"]({ value: input }, { abortEarly: true }).issues;
}
```

`is()` は内部で `abortEarly: true` を自動設定し、最初のエラーで即座に判定を終了する。ユーザーが config を渡す必要がない。

### SafeParseResult の 3 状態判別共用体

`safeParse()` の戻り値は単純な success/failure の 2 分岐ではなく、`typed` と `success` の組み合わせで 3 状態を表現する。

```typescript
// library/src/methods/safeParse/types.ts:12-46
export type SafeParseResult<TSchema> =
  | { typed: true;  success: true;  output: InferOutput<TSchema>; issues: undefined }
  | { typed: true;  success: false; output: InferOutput<TSchema>; issues: [...] }
  | { typed: false; success: false; output: unknown;              issues: [...] };
```

`typed: true, success: false` は「型は正しいが検証に失敗した」状態を表す。これにより、部分的に有効な入力をフォーム UI のプレビュー等で活用できる。

### @\_\_NO_SIDE_EFFECTS\_\_ アノテーションによるツリーシェイキング最適化

ほぼ全ての公開関数の実装（overload 実体）に `// @__NO_SIDE_EFFECTS__` コメントが付与されている。これは Rollup/esbuild などのバンドラに「この関数呼び出しの結果が使われなければ安全に除去できる」と伝える。

```typescript
// library/src/schemas/string/string.ts:69-70
// @__NO_SIDE_EFFECTS__
export function string(
  message?: ErrorMessage<StringIssue>
): StringSchema<ErrorMessage<StringIssue> | undefined> {
```

これが全スキーマ・アクション・メソッドに一貫して適用されることで、未使用の関数はバンドルから完全に除去される。

### reference プロパティによる自己参照パターン

各関数の戻り値オブジェクトが `reference: typeof functionName` を持ち、関数自身への参照を保持する。

```typescript
// library/src/actions/email/email.ts:96-100
return {
  kind: 'validation',
  type: 'email',
  reference: email,  // 関数自身への参照
  expects: null,
  async: false,
```

これにより `getSpecificMessage(context.reference, issue.lang)` のように関数参照をキーとしたメッセージルックアップが可能になる（`library/src/utils/_addIssue/_addIssue.ts:109`）。文字列比較ではなく関数参照の同一性で判定するため、minification に影響されない。

### Object スキーマの意味的バリアント分離

オブジェクト検証を 4 つの独立した関数に分離し、デフォルト動作の違いを関数名で明示する。

| 関数               | 未知キーの扱い       |
| ------------------ | -------------------- |
| `object()`         | 除去（strip）        |
| `looseObject()`    | 透過（pass-through） |
| `strictObject()`   | エラー               |
| `objectWithRest()` | rest スキーマで検証  |

```typescript
// library/src/schemas/object/object.ts:49-55 (JSDoc)
// Hint: This schema removes unknown entries. The output will only include the
// entries you specify. To include unknown entries, use `looseObject`. To
// return an issue for unknown entries, use `strictObject`. To include and
// validate unknown entries, use `objectWithRest`.
```

options パラメータ（`{ strict: true }` 等）で制御する代わりに、関数自体を分けることで各関数のシグネチャが簡潔に保たれ、ツリーシェイキングも最大化される。

## パターンカタログ

- **Builder Pattern** (分類: 生成)
  - 解決する問題: 複雑なスキーマ定義を段階的に構築する
  - 適用条件: `pipe()` による段階的な制約追加
  - コード例: `library/src/methods/pipe/pipe.ts:2694`
  - 注意点: 各パイプアイテムが独立したオブジェクトを返すため、メソッドチェーンではなく関数合成で実現している

- **Discriminated Union** (分類: 振る舞い)
  - 解決する問題: kind/type の組み合わせで実行時の分岐を型安全に行う
  - 適用条件: `kind: 'schema' | 'validation' | 'transformation' | 'metadata'` の 4 カテゴリ
  - コード例: `library/src/types/issue.ts:225`（BaseIssue の kind フィールド）
  - 注意点: `kind` はカテゴリ、`type` は具体名という 2 段階の判別キーを使用

- **Decorator Pattern** (分類: 構造)
  - 解決する問題: スキーマの振る舞いを変更せずに追加機能を付与する
  - 適用条件: `optional()`, `nullable()`, `fallback()`, `config()` によるラッピング
  - コード例: `library/src/methods/fallback/fallback.ts:47-67`
  - 注意点: スプレッド構文で元のスキーマをコピーし `~run` のみ差し替える

## Good Patterns

- **const TMessage ジェネリクスで型引数にリテラル型を保持する**: すべてのオーバーロードで `const TMessage` を使い、ユーザーが渡した文字列リテラルやテンプレートリテラルの型情報を型引数に保持する。省略時は `undefined` リテラルに確定し、message の有無を型レベルで追跡できる。

```typescript
// library/src/schemas/string/string.ts:65-67
export function string<
  const TMessage extends ErrorMessage<StringIssue> | undefined,
>(message: TMessage): StringSchema<TMessage>;
```

- **内部メソッドに `~` プレフィックスを使った名前空間衝突の回避**: `~run`、`~standard`、`~types` のように `~` プレフィックスを使用し、ユーザーが誤って内部メソッドにアクセスすることを防ぐ。JavaScript のプロパティ名として有効だが、IDE の補完で通常プロパティより下に表示される。

```typescript
// library/src/types/schema.ts:53-56
readonly '~run': (
  dataset: UnknownDataset,
  config: Config<BaseIssue<unknown>>
) => OutputDataset<TOutput, TIssue>;
```

- **Issue インターフェースで expected/received を文字列テンプレートリテラルに型付けする**: `expected: '>=${TRequirement}'` のようにテンプレートリテラル型を使い、エラーメッセージの構成要素を型レベルで保証する。

```typescript
// library/src/actions/minLength/minLength.ts:27-31
readonly expected: `>=${TRequirement}`;
readonly received: `${number}`;
```

## Anti-Patterns / 注意点

- **固定長オーバーロードの保守コスト**: `pipe()` は 19 個のオーバーロードで約 2700 行を消費する。TypeScript に可変長ジェネリクスの制約があるためやむを得ないが、新しいパイプアイテム型を追加する際にすべてのオーバーロードに影響する。

```typescript
// Bad: 手動で N 個のオーバーロードを管理する（現状の制約下では必要だが保守コストが高い）
export function pipe<TSchema, TItem1>(schema, item1): ...;
export function pipe<TSchema, TItem1, TItem2>(schema, item1, item2): ...;
// ... 19 回繰り返し
```

```typescript
// Better: 可変長ジェネリクスが使えない場合は、十分な数のオーバーロード + rest フォールバック
// valibot はこれを実践している（19 overloads + 1 rest fallback）
```

- **@ts-expect-error の多用**: データセットの内部状態変更（`dataset.typed = true`、`dataset.issues = [...]`）に `// @ts-expect-error` が多用されている。これはパフォーマンスのためにミュータブル操作をしつつ、外部インターフェースは readonly に保つトレードオフだが、内部の型安全性が低下するリスクがある。

```typescript
// library/src/schemas/string/string.ts:86-87
// @ts-expect-error
dataset.typed = true;
```

内部専用の mutable 型を別途定義し、`@ts-expect-error` を減らす方が堅牢になる（推測）。

## 導出ルール

- `[MUST]` ライブラリの公開関数でオプショナルパラメータの型情報を保持する必要がある場合は、optional パラメータではなく関数オーバーロードを使い、省略時のジェネリクス型を `undefined` リテラルに確定させる
  - 根拠: valibot の全スキーマ・アクション関数（100+）がこのパターンで `TMessage` の有無を型レベルで追跡している（`library/src/schemas/string/string.ts:56-67`）

- `[MUST]` 同一カテゴリに属する公開関数群には、同一の構造プロパティセット（kind/type/reference 等）を持たせ、実行時の判別と静的型推論を両方サポートする
  - 根拠: valibot は schema/validation/transformation/metadata の 4 カテゴリすべてで kind-type-reference トリプレットを統一し、`_addIssue` や `pipe` の内部ロジックがこれに依存している（`library/src/utils/_addIssue/_addIssue.ts:103`）

- `[SHOULD]` ツリーシェイキング対象の公開関数には `// @__NO_SIDE_EFFECTS__` アノテーションを付与し、バンドラが未使用コードを安全に除去できるようにする
  - 根拠: valibot の全公開関数実装にこのアノテーションが付与されており、使用しないスキーマ・アクションがバンドルに含まれない設計を実現している

- `[SHOULD]` 同一概念の動作バリアントは options オブジェクトではなく独立した関数に分離し、各関数のシグネチャを単純に保ちながらツリーシェイキングを最大化する
  - 根拠: object/looseObject/strictObject/objectWithRest の 4 分離により、未使用バリアントが完全にバンドルから除外される（`library/src/schemas/` 配下の 4 ディレクトリ）

- `[SHOULD]` parse/safeParse のような「同一ロジック・異なるエラーハンドリング」のペアは、内部実装を共有しつつ戻り値型で使い分けを型レベルで表現する
  - 根拠: `parse()` は throw、`safeParse()` は discriminated union の結果オブジェクトを返し、同一の `schema['~run']` を呼ぶが戻り値の型が異なる（`library/src/methods/parse/parse.ts:20-32`, `library/src/methods/safeParse/safeParse.ts:20-34`）

- `[AVOID]` パイプ型の合成関数で可変長ジェネリクスのフォールバックだけに頼ること。フォールバックは型推論の精度が落ちるため、実用的な上限数まで固定長オーバーロードを定義した上で rest パラメータ版を最後に置く
  - 根拠: valibot は 19 個の固定長オーバーロードで型安全なチェーンを保証し、20 個目以降のみ rest にフォールバックする（`library/src/methods/pipe/pipe.ts`）

## 適用チェックリスト

- [ ] ライブラリの公開関数で optional パラメータを使っている箇所を洗い出し、ジェネリクスの型精度が必要な箇所をオーバーロードに変換したか
- [ ] 公開オブジェクトに kind/type 等の判別プロパティを統一的に付与し、switch 文やランタイム判定で型が絞れるようになっているか
- [ ] バンドルサイズが重要なライブラリで `@__NO_SIDE_EFFECTS__` アノテーションを付与し、ツリーシェイキングの効果を確認したか
- [ ] 同一関数に options フラグが 3 つ以上ある場合、独立した関数への分離を検討したか
- [ ] 内部メソッドに `_` プレフィックスや `~` プレフィックスを使い、ユーザー向け API と内部 API の境界を明示しているか
- [ ] parse 系の関数で throw 版と Result 版の両方を提供し、利用者のエラーハンドリング戦略に選択肢を与えているか
