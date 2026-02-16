# architecture

> リポジトリ: open-circle/valibot
> 分析日: 2026-02-16

## 概要

valibot はスキーマ/アクション/メソッドの3層に分離された関数型パイプラインアーキテクチャを採用しており、各レイヤーのオブジェクトが統一された `'~run'` メソッドインタフェースで連結される。クラスを一切使わずにプレーンオブジェクトのファクトリ関数だけで構築することで、tree-shaking を最大化しつつ型安全性を維持している点が注目に値する。この設計は「バリデーションライブラリ」の枠を超え、任意のデータ変換パイプラインに応用可能な汎用的アーキテクチャパターンを体現している。

## 背景にある原則

- **Discriminated Union による多態性の実現**: クラス継承や `instanceof` を使わず、`kind` フィールド (`'schema'` / `'validation'` / `'transformation'` / `'metadata'`) で型を判別する。これにより tree-shaking が効き、不要なコードがバンドルに含まれない。根拠: `BaseSchema` は `kind: 'schema'`、`BaseValidation` は `kind: 'validation'` を持ち、パイプライン実行時に `item.kind` で分岐する (`library/src/methods/pipe/pipe.ts:2705-2713`)。

- **Dataset を唯一の通貨とするパイプライン設計**: パイプライン内の全ステップが `Dataset` オブジェクト (typed / value / issues) を受け取り返す。ステップ間でデータ形式を変換する必要がなく、各ステップは前のステップの出力をそのまま消費する。これにより、ステップの追加・削除・並べ替えが自由になる。根拠: `UnknownDataset` -> `OutputDataset` という統一的な入出力型定義 (`library/src/types/dataset.ts`)。

- **ファクトリ関数 + プレーンオブジェクト = ゼロコストの抽象化**: 全てのスキーマ・アクションは `new` キーワードを使わないファクトリ関数がプレーンオブジェクトを返す形式。`// @__NO_SIDE_EFFECTS__` アノテーション付きで、呼び出されなければバンドルから完全に除去される。根拠: `string()`, `minLength()`, `transform()` 等の全ファクトリ関数に `@__NO_SIDE_EFFECTS__` が付与 (ライブラリ全体で200箇所以上)。

- **型推論をオブジェクト構造に埋め込む (Phantom Types)**: `'~types'` プロパティにオプショナルな型情報を持たせ、ランタイムには存在しないが TypeScript の型推論で活用する。`InferInput`, `InferOutput`, `InferIssue` がこれを参照する。根拠: `library/src/types/infer.ts` で `NonNullable<TItem['~types']>['input']` のように抽出。

## 実例と分析

### 3層アーキテクチャの構造

valibot の中核は以下の3層で構成される。

**Layer 1: Schemas** (`library/src/schemas/`) -- 入力値の型チェック (unknown -> typed value)。`kind: 'schema'` を持ち、`'~run'` は `UnknownDataset` を受け取る。型が不正な場合に `dataset.typed = false` を設定する責務を持つ。

**Layer 2: Actions** (`library/src/actions/`) -- バリデーション (`kind: 'validation'`) とトランスフォーメーション (`kind: 'transformation'`) とメタデータ (`kind: 'metadata'`) の3種。`'~run'` は型付き済み `OutputDataset` を受け取る。スキーマで型が確定した後の制約チェックや値変換を担う。

**Layer 3: Methods** (`library/src/methods/`) -- `pipe()`, `parse()`, `safeParse()`, `flatten()`, `forward()` 等のオーケストレーション関数群。ユーザーが直接呼び出す外部 API であり、スキーマとアクションを組み合わせる接着剤。

### `'~run'` メソッドの入力型による責務の分離

3つの `'~run'` シグネチャは入力型で責務を表現している。

```typescript
// library/src/types/schema.ts:53-56
// Schema: unknown 入力を受け取り、型を確定する
readonly '~run': (
  dataset: UnknownDataset,
  config: Config<BaseIssue<unknown>>
) => OutputDataset<TOutput, TIssue>;
```

```typescript
// library/src/types/validation.ts:47-50
// Validation: 型付き済みデータを検証する
readonly '~run': (
  dataset: OutputDataset<TInput, BaseIssue<unknown>>,
  config: Config<BaseIssue<unknown>>
) => OutputDataset<TOutput, BaseIssue<unknown> | TIssue>;
```

```typescript
// library/src/types/transformation.ts:43-46
// Transformation: 成功データのみを変換する (SuccessDataset)
readonly '~run': (
  dataset: SuccessDataset<TInput>,
  config: Config<BaseIssue<unknown>>
) => OutputDataset<TOutput, BaseIssue<unknown> | TIssue>;
```

この設計により、Transformation がエラー状態のデータを受け取ることがない (コンパイル時に防がれる)。パイプラインの実行エンジン (`pipe.ts:2706-2714`) でも同じルールがランタイムで強制されている。

### パイプライン実行エンジンの設計

```typescript
// library/src/methods/pipe/pipe.ts:2701-2730
'~run'(dataset, config) {
  for (const item of pipe) {
    if (item.kind !== 'metadata') {
      // issues があり次が schema/transformation なら中断
      if (
        dataset.issues &&
        (item.kind === 'schema' || item.kind === 'transformation')
      ) {
        dataset.typed = false;
        break;
      }
      // abort 設定がなければ続行
      if (
        !dataset.issues ||
        (!config.abortEarly && !config.abortPipeEarly)
      ) {
        dataset = item['~run'](dataset, config);
      }
    }
  }
  return dataset;
},
```

注目すべき設計判断:

1. **metadata は実行スキップ**: `kind !== 'metadata'` で実行から除外。metadata はパイプラインに参加するが副作用を持たず、introspection 用途のみ。
2. **エラー時の段階的劣化**: issues がある状態で schema/transformation に到達すると `typed = false` にしてパイプを中断するが、validation は issues があっても続行する (全エラー収集)。
3. **abort 制御の分離**: `abortEarly` (スキーマ全体) と `abortPipeEarly` (パイプライン内) の2段階で中断タイミングを制御。

### reference プロパティによる自己参照パターン

```typescript
// library/src/schemas/string/string.ts:40-41
readonly reference: typeof string;

// library/src/actions/minLength/minLength.ts:55
readonly reference: typeof minLength;
```

全てのスキーマ・アクションが自身のファクトリ関数への参照を `reference` プロパティに保持する。これにより、特定メッセージの設定 (`setSpecificMessage`) でファクトリ関数をキーとして利用でき、`instanceof` なしにオブジェクトの出自を特定できる。

```typescript
// library/src/storages/specificMessage/specificMessage.ts:40-48
export function setSpecificMessage<const TReference extends Reference>(
  reference: TReference,
  message: ErrorMessage<InferIssue<ReturnType<TReference>>>,
  lang?: string,
): void {
  if (!store) store = new Map();
  if (!store.get(reference)) store.set(reference, new Map());
  store.get(reference)!.set(lang, message);
}
```

### 型推論チェーンの実現: pipe のオーバーロード戦略

`pipe()` は1〜19引数の個別オーバーロードを持ち、各引数が前の引数の `InferOutput` に型を連鎖させる。

```typescript
// library/src/methods/pipe/pipe.ts:103-123
export function pipe<
  const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>,
  const TItem1 extends PipeItem<
    InferOutput<TSchema>,
    unknown,
    BaseIssue<unknown>
  >,
  const TItem2 extends PipeItem<
    InferOutput<TItem1>,
    unknown,
    BaseIssue<unknown>
  >,
>(
  schema: TSchema,
  item1: TItem1 | PipeAction<InferOutput<TSchema>, InferOutput<TItem1>, InferIssue<TItem1>>,
  item2: TItem2 | PipeAction<InferOutput<TItem1>, InferOutput<TItem2>, InferIssue<TItem2>>,
): SchemaWithPipe<readonly [TSchema, TItem1, TItem2]>;
```

19を超える場合は最終的なフォールバックオーバーロード (`pipe.ts:2672-2682`) で同一型制約のバリアント引数として受ける。可変長テンプレートリテラル型ではなく個別オーバーロードを選択した理由は、TypeScript の型推論で可変長のジェネリックチェーンが正確に推論されないためと推測される。

### Dataset による3状態モデル

```typescript
// library/src/types/dataset.ts
// 未型付き初期状態
interface UnknownDataset {
  typed?: false;
  value: unknown;
  issues?: undefined;
}
// 型付き成功
interface SuccessDataset<TValue> {
  typed: true;
  value: TValue;
  issues?: undefined;
}
// 型付きだがエラーあり (部分成功)
interface PartialDataset<TValue, TIssue> {
  typed: true;
  value: TValue;
  issues: [TIssue, ...TIssue[]];
}
// 型付け失敗
interface FailureDataset<TIssue> {
  typed: false;
  value: unknown;
  issues: [TIssue, ...TIssue[]];
}
```

`PartialDataset` の存在が重要: 型は確定したがバリデーションエラーがある場合に `typed: true` かつ `issues` を持つ。これによりパイプライン内の後続 validation が引き続き実行される (全エラー収集)。一方 `typed: false` になると transformation は実行されない (型が不確定な値を変換するのは危険なため)。

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: バリデーション/変換のアルゴリズムを実行時に差し替え可能にする
  - 適用条件: 同じインタフェース (`'~run'`) を満たす多数の具象実装がある場合
  - コード例: `library/src/types/schema.ts:53`, `library/src/types/validation.ts:47`, `library/src/types/transformation.ts:43` の各 `'~run'` 定義
  - 注意点: valibot ではクラス継承ではなく Discriminated Union で Strategy を実現。関数型寄りの設計。

- **Pipeline パターン (Pipes and Filters)** (分類: アーキテクチャ)
  - 解決する問題: データ処理の各ステップを独立して定義・組み合わせ・再利用する
  - 適用条件: 複数の処理ステップを逐次適用し、各ステップが同一のデータ構造 (Dataset) を入出力する場合
  - コード例: `library/src/methods/pipe/pipe.ts:2694-2732` の実装
  - 注意点: ステップの kind に応じて実行可否を判定する「フィルタ付きパイプライン」になっている

- **Phantom Type パターン** (分類: 型レベル)
  - 解決する問題: ランタイムコストなしに型情報を伝搬させる
  - 適用条件: オブジェクトの構造は同じだが型パラメータだけが異なるバリエーションが多数ある場合
  - コード例: `library/src/types/schema.ts:62-68` の `'~types'` プロパティ、`library/src/types/infer.ts` の `InferInput` / `InferOutput`
  - 注意点: `?:` でオプショナルにし `undefined` を許可することで、ランタイムでは値が存在しない

## Good Patterns

- **統一インタフェースによる合成可能性**: 全ての処理単位 (schema, validation, transformation) が `{ kind, type, reference, '~run' }` という同一構造を持つ。これにより `pipe()` は各要素の具象型を知らずに逐次実行できる。新しいバリデーションの追加は新しいファクトリ関数を1つ書くだけで完了し、パイプラインエンジンの変更は不要。

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
        dataset.typed = true;
      } else {
        _addIssue(this, "type", dataset, config);
      }
      return dataset;
    },
  };
}
```

- **`@__NO_SIDE_EFFECTS__` による tree-shaking 最適化**: ライブラリ全体 (200箇所以上) でファクトリ関数に `@__NO_SIDE_EFFECTS__` アノテーションを付与。バンドラがデッドコード除去を安全に行える。クラスベースの設計では prototype チェーンの副作用が tree-shaking を阻害するが、プレーンオブジェクトのファクトリ関数はこの問題を回避する。

- **エラーメッセージ解決の優先度チェーン**: `_addIssue` は以下の優先順でメッセージを解決し、ユーザーがどのレベルでもカスタマイズ可能にしている。

```typescript
// library/src/utils/_addIssue/_addIssue.ts:106-112
const message = other?.message // 1. インラインメッセージ
  ?? context.message // 2. スキーマ/アクション定義時のメッセージ
  ?? getSpecificMessage(context.reference, issue.lang) // 3. 関数リファレンス単位のグローバル設定
  ?? (isSchema ? getSchemaMessage(issue.lang) : null) // 4. スキーマ全体のデフォルト
  ?? config.message // 5. parse 呼び出し時の設定
  ?? getGlobalMessage(issue.lang); // 6. グローバルメッセージ
```

## Anti-Patterns / 注意点

- **オーバーロード地獄 (型安全チェーンの代償)**: `pipe()` は19個の個別オーバーロードを持ち、ファイルは2733行に達する。TypeScript の可変長ジェネリック推論の限界から来る制約だが、保守コストが高い。

```typescript
// Bad: 19 個の手動オーバーロード (library/src/methods/pipe/pipe.ts)
export function pipe<TSchema, TItem1>(schema, item1): SchemaWithPipe<[TSchema, TItem1]>;
export function pipe<TSchema, TItem1, TItem2>(schema, item1, item2): SchemaWithPipe<[TSchema, TItem1, TItem2]>;
// ... 17 more overloads
```

```typescript
// Better: 将来的には TypeScript が Higher-Kinded Types や
// 再帰的な型推論チェーンをサポートすれば、1つのシグネチャで済む可能性がある。
// 現状では型安全性を優先した妥当なトレードオフ。
```

- **`@ts-expect-error` の多用**: Dataset のミュータブルな操作 (typed フラグの変更、issues の追加) で型システムを回避している箇所が多い。内部実装の性能最適化としては妥当だが、Dataset 操作を抽象化するヘルパー関数を用意すれば `@ts-expect-error` を局所化できる。

```typescript
// Bad: 各スキーマの '~run' 内で繰り返し現れるパターン
// @ts-expect-error
dataset.typed = true;
// @ts-expect-error
dataset.issues = valueDataset.issues;
```

```typescript
// Better: 専用のヘルパーで局所化
function markTyped<T>(dataset: UnknownDataset, value: T): SuccessDataset<T> {
  return { typed: true, value, issues: undefined };
}
```

## 導出ルール

- `[MUST]` パイプラインの各ステップは同一のデータ構造 (Dataset/Context 等) を入出力とし、ステップ間のアダプタ変換を不要にする
  - 根拠: valibot の全ステップが `Dataset` を受け渡すことで、ステップの追加・削除・並べ替えが型安全に行える (`library/src/types/dataset.ts`, `library/src/methods/pipe/pipe.ts:2701-2730`)

- `[MUST]` 拡張可能なライブラリでは、クラス継承ではなく Discriminated Union (`kind` / `type` フィールド) で多態性を実現し、tree-shaking 互換性を維持する
  - 根拠: valibot は全ファクトリ関数に `@__NO_SIDE_EFFECTS__` を付与し、クラスを避けることでバンドルサイズを最小化している (`library/src/schemas/`, `library/src/actions/` の全ファイル)

- `[SHOULD]` ファクトリ関数が返すオブジェクトに自身のファクトリ関数への `reference` を持たせ、`instanceof` に依存しないオブジェクト識別を実現する
  - 根拠: `reference` プロパティにより `setSpecificMessage(string, ...)` のように関数をキーとした設定が可能 (`library/src/storages/specificMessage/specificMessage.ts:40-48`)

- `[SHOULD]` ランタイムに不要な型情報はオプショナルな Phantom Type プロパティとして埋め込み、型推論とバンドルサイズを両立する
  - 根拠: `'~types'?: { input: TInput; output: TOutput; issue: TIssue } | undefined` がランタイムでは存在せず、`InferInput<T>` 等の型ユーティリティでのみ参照される (`library/src/types/infer.ts:14-51`)

- `[SHOULD]` エラーメッセージのカスタマイズは優先度チェーン (インライン > インスタンス > リファレンス単位 > カテゴリ単位 > グローバル) で解決し、ユーザーがどの粒度でも介入できるようにする
  - 根拠: `_addIssue` の6段階メッセージ解決チェーン (`library/src/utils/_addIssue/_addIssue.ts:106-112`)

- `[AVOID]` パイプラインでデータの型状態を無視して後続ステップを実行する。型未確定 (typed: false) の値に対する変換は不正な結果を招く
  - 根拠: パイプライン実行エンジンが `issues && (kind === 'schema' || kind === 'transformation')` の場合にパイプを中断する (`library/src/methods/pipe/pipe.ts:2708-2714`)

## 適用チェックリスト

- [ ] パイプラインの各ステップが同一のデータ構造を入出力しているか (変換アダプタが不要になっているか)
- [ ] 多態性を Discriminated Union (`kind` / `type` リテラル) で実現し、`instanceof` や抽象クラスに依存していないか
- [ ] ファクトリ関数に `@__NO_SIDE_EFFECTS__` (または `/*#__PURE__*/`) アノテーションを付与し、tree-shaking を有効にしているか
- [ ] 型推論に必要だがランタイムに不要な情報を Phantom Type として埋め込んでいるか
- [ ] パイプラインのエラー伝搬で「部分成功」状態 (型は確定、バリデーションエラーあり) を区別して扱っているか
- [ ] エラーメッセージを複数レベル (インスタンス/リファレンス/グローバル) でカスタマイズ可能にしているか
- [ ] 新しい処理ステップの追加がパイプラインエンジンの変更なしに行えるか (Open-Closed Principle)
