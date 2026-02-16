# abstraction-patterns

> リポジトリ: open-circle/valibot
> 分析日: 2026-02-16

## 概要

valibot は schema / validation / transformation / metadata という4種類のオブジェクトを、共通の `'~run'` メソッドを持つプレーンオブジェクトとして統一的に扱い、`pipe()` で関数型合成する抽象化手法を採用している。クラスを一切使わずにファクトリ関数 + リテラルオブジェクトで多態性を実現しており、tree-shaking 最適化とランタイムコスト最小化を両立させている。この「プレーンオブジェクト + プロトコルメソッド + パイプライン合成」という三位一体のアーキテクチャは、バンドルサイズが重要な領域でのライブラリ設計に広く応用できる。

## 背景にある原則

- **Protocol over Class（プロトコル優先原則）**: クラス継承ではなく、共通のプロパティ形状（`kind`, `type`, `'~run'`）を満たすプレーンオブジェクトで多態性を実現すべき。クラスはプロトタイプチェーン・コンストラクタを持つため tree-shaking が効かず、バンドラが安全に除去できない。valibot では `BaseSchema`, `BaseValidation`, `BaseTransformation` がすべて interface であり、実装はオブジェクトリテラルで返される（`library/src/types/schema.ts:9-69`）。

- **Discriminated Union による分岐最適化**: `kind` フィールドが `'schema' | 'validation' | 'transformation' | 'metadata'` のリテラル型で固定されることで、TypeScript の判別共用体として機能し、`switch`/`if` での型ナロイングが安全に行える。`pipe()` の実行ループ内で `item.kind !== 'metadata'` や `item.kind === 'schema'` による分岐が実際に使われている（`library/src/methods/pipe/pipe.ts:2705-2714`）。

- **合成可能性のための入出力型チェーン**: `pipe()` のオーバーロード定義において、各 `PipeItem` の入力型が前段の出力型に制約されることで、型安全なパイプライン合成を実現すべき。valibot では最大19個のアイテムまでオーバーロードを定義し、型の連鎖的推論を保証している（`library/src/methods/pipe/pipe.ts:80-2682`）。

- **副作用ゼロ宣言による最適化契約**: ファクトリ関数に `@__NO_SIDE_EFFECTS__` アノテーションを付与し、`package.json` で `"sideEffects": false` を宣言することで、バンドラに「使われていないエクスポートは安全に除去できる」という契約を明示すべき。これはプレーンオブジェクトパターンだからこそ成立する（クラスは静的メソッドやデコレータの副作用を持ちうる）。

## 実例と分析

### `'~run'` メソッドプロトコル

valibot の全オブジェクト（schema, validation, transformation）は `'~run'` というチルダプレフィクス付きのメソッドを持つ。チルダプレフィクスは意図的な設計で、内部 API であることを示し、外部利用者のプロパティ名と衝突しないよう名前空間を分離している。同様に `'~types'` は phantom type 用、`'~standard'` は Standard Schema 準拠用のプロパティである。

`'~run'` メソッドのシグネチャは種類ごとに微妙に異なり、型安全性を保証している:

- **Schema**: `(dataset: UnknownDataset, config) => OutputDataset<TOutput, TIssue>` -- 未知の入力を受け取る
- **Validation**: `(dataset: OutputDataset<TInput, ...>, config) => OutputDataset<TOutput, ...>` -- 型付き済みの値を検証する
- **Transformation**: `(dataset: SuccessDataset<TInput>, config) => OutputDataset<TOutput, ...>` -- 成功済みの値を変換する

これにより、validation は schema の後でしか実行できず、transformation は issues がない場合のみ実行されるという意味論が型レベルで強制される。

### ファクトリ関数 + オブジェクトリテラルの徹底

すべての schema / action / method は `class` ではなくファクトリ関数で実装される。例えば `string()` はプレーンオブジェクトを返す:

```typescript
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
  };
}
```

validation action も同一パターン:

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

transformation も同様に:

```typescript
// library/src/actions/toLowerCase/toLowerCase.ts:23-35
// @__NO_SIDE_EFFECTS__
export function toLowerCase(): ToLowerCaseAction {
  return {
    kind: "transformation",
    type: "to_lower_case",
    reference: toLowerCase,
    async: false,
    "~run"(dataset) {
      dataset.value = dataset.value.toLowerCase();
      return dataset;
    },
  };
}
```

### `pipe()` によるパイプライン合成

`pipe()` はスプレッド演算子でスキーマの全プロパティを引き継ぎつつ、`'~run'` を上書きしてパイプライン実行ロジックに差し替える:

```typescript
// library/src/methods/pipe/pipe.ts:2684-2732
// @__NO_SIDE_EFFECTS__
export function pipe(
  ...pipe: [TSchema, ...TItems]
): SchemaWithPipe<readonly [TSchema, ...TItems]> {
  return {
    ...pipe[0],
    pipe,
    get "~standard"() {
      return _getStandardProps(this);
    },
    "~run"(dataset, config) {
      for (const item of pipe) {
        if (item.kind !== "metadata") {
          if (
            dataset.issues
            && (item.kind === "schema" || item.kind === "transformation")
          ) {
            dataset.typed = false;
            break;
          }
          if (
            !dataset.issues
            || (!config.abortEarly && !config.abortPipeEarly)
          ) {
            dataset = item["~run"](dataset, config);
          }
        }
      }
      return dataset;
    },
  };
}
```

`kind` による分岐が3つの意味論を実装している: (1) metadata はスキップ、(2) issues がある場合 schema/transformation は実行せず中断、(3) validation は issues があっても追加検証を続行可能。

### `reference` プロパティによる自己参照

各オブジェクトは `reference` プロパティに自身のファクトリ関数への参照を持つ。これは `setSpecificMessage(string, 'Must be a string')` のように、ファクトリ関数をキーとしてエラーメッセージを登録・検索するために使われる:

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

関数オブジェクトの参照等値性を利用した Map キーは、文字列キーより衝突リスクが低く、型推論も効く。

### `'~types'` phantom property による型情報埋め込み

`'~types'` は optional で `undefined` になりうるが、`InferInput` / `InferOutput` / `InferIssue` が `NonNullable<TItem['~types']>` でアクセスすることで、ランタイムコストゼロで型情報を抽出する:

```typescript
// library/src/types/infer.ts:14-23
export type InferInput<TItem extends ...> =
  NonNullable<TItem['~types']>['input'];
```

これはランタイムには存在しないが、TypeScript の型システムで入出力型を伝搬させるための phantom type パターンである。

### Dataset パターン -- ミュータブルな累積結果

`'~run'` の引数と戻り値は `dataset` オブジェクトで、`typed`, `value`, `issues` を持つ。注目すべきは dataset が各ステップで immutable にコピーされるのではなく、ミュータブルに更新される点。`_addIssue` は `dataset.issues.push(issue)` で既存配列に追記し、schema は `dataset.value = {}` で値を上書きする。パイプライン全体で1つの dataset オブジェクトを使い回すことで、オブジェクト生成コストを最小化している。

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: schema / validation / transformation の `'~run'` 実装をオブジェクトごとに差し替える
  - 適用条件: 共通インターフェースで異なるアルゴリズムを交換可能にしたい場合
  - コード例: `library/src/schemas/string/string.ts:83-92`, `library/src/actions/minLength/minLength.ts:118-125`
  - 注意点: クラスではなくオブジェクトリテラルで実装するため、プロトタイプチェーンのオーバーヘッドがない

- **Chain of Responsibility パターン** (分類: 振る舞い)
  - 解決する問題: パイプライン内の各ステップが dataset を順次処理し、必要に応じて中断する
  - 適用条件: 複数の処理ステップを順序付けて実行し、条件に応じてスキップや中断が必要な場合
  - コード例: `library/src/methods/pipe/pipe.ts:2701-2730`
  - 注意点: `kind` による分岐で異なる中断条件を実装しているため、純粋な Chain of Responsibility ではなく変形版

- **Phantom Type パターン** (分類: 型レベル)
  - 解決する問題: ランタイムに存在しない型情報をオブジェクトに埋め込み、型推論で伝搬させる
  - 適用条件: 型レベルの情報が必要だがランタイムコストを払いたくない場合
  - コード例: `library/src/types/schema.ts:62-68`, `library/src/types/infer.ts:14-23`
  - 注意点: `'~types'` は optional なので NonNullable でのアクセスが必要

## Good Patterns

- **チルダプレフィクスによる内部 API 名前空間分離**: `'~run'`, `'~types'`, `'~standard'` のようにチルダプレフィクスを使うことで、ユーザー定義プロパティ（schema のフィールド名等）との衝突を防ぎ、内部 API であることを視覚的に明示する。Symbol を使う方法と比べて、JSON シリアライズ可能性を維持し、デバッグ時の可読性も高い。

```typescript
// library/src/types/schema.ts:53-56
readonly '~run': (
  dataset: UnknownDataset,
  config: Config<BaseIssue<unknown>>
) => OutputDataset<TOutput, TIssue>;
```

- **ファクトリ関数の自己参照 `reference` プロパティ**: ファクトリ関数自身をオブジェクトのプロパティとして保持することで、関数オブジェクトをキーとした Map lookup（エラーメッセージの i18n 対応等）や、同種のオブジェクト再生成（codemod でのマイグレーション等）が可能になる。

```typescript
// library/src/schemas/string/string.ts:76
reference: string,  // string ファクトリ関数自身への参照
```

- **Dataset のインプレース更新によるアロケーション最小化**: パイプラインの各ステップで新しいオブジェクトを生成せず、1つの dataset を直接変更していくことで GC 圧を軽減する。issues 配列も `push` で追記し、spread でコピーしない。

```typescript
// library/src/utils/_addIssue/_addIssue.ts:130-135
if (dataset.issues) {
  dataset.issues.push(issue);
} else {
  dataset.issues = [issue];
}
```

## Anti-Patterns / 注意点

- **クラスによるバリデータ実装**: クラスを使うとコンストラクタやプロトタイプが常にバンドルに含まれ、tree-shaking が効かない。特に validation ライブラリのように多数の小さなユニットが存在する場合、クラスのオーバーヘッドが積み重なる。

Bad:

```typescript
class StringSchema extends BaseSchema {
  "~run"(dataset, config) {/* ... */}
}
export const string = () => new StringSchema();
```

Better:

```typescript
// @__NO_SIDE_EFFECTS__
export function string() {
  return {
    kind: "schema",
    type: "string",
    "~run"(dataset, config) {/* ... */},
  };
}
```

- **パイプライン合成で immutable コピーを多用する**: 各ステップで `{ ...dataset, value: newValue }` のようにスプレッドすると、パイプが長くなるほどオブジェクト生成コストが線形に増加する。バリデーションのようなホットパスでは顕著なパフォーマンス劣化を招く。

Bad:

```typescript
'~run'(dataset, config) {
  return { ...dataset, value: dataset.value.toLowerCase() };
}
```

Better:

```typescript
'~run'(dataset) {
  dataset.value = dataset.value.toLowerCase();
  return dataset;
}
```

## 導出ルール

- `[MUST]` tree-shaking が重要なライブラリでは、class ではなくファクトリ関数 + オブジェクトリテラルで公開 API を構成する
  - 根拠: valibot は全 schema/action/method をファクトリ関数で実装し、`@__NO_SIDE_EFFECTS__` + `"sideEffects": false` と組み合わせることで、未使用コードの完全な除去を実現している（`library/src/schemas/string/string.ts:69`, `library/package.json:37`）

- `[MUST]` 共通プロトコルを定義する場合、リテラル型の判別フィールド（discriminant）を含めて、判別共用体として型ナロイングを可能にする
  - 根拠: `kind: 'schema' | 'validation' | 'transformation' | 'metadata'` により、`pipe()` の実行ループ内で `if (item.kind === 'schema')` のような分岐が型安全に行える（`library/src/methods/pipe/pipe.ts:2705-2714`）

- `[SHOULD]` パイプライン実行のホットパスでは、中間結果オブジェクトを immutable にコピーせずインプレースで更新する
  - 根拠: valibot は dataset をパイプライン全体でミュータブルに使い回し、`_addIssue` も `push` で追記する設計で、バリデーション実行時のアロケーションを最小化している（`library/src/utils/_addIssue/_addIssue.ts:130-135`）

- `[SHOULD]` 内部 API プロパティにはプレフィクス付き文字列キー（例: `'~run'`）を使い、ユーザー空間との名前衝突を防ぐ
  - 根拠: valibot は `'~run'`, `'~types'`, `'~standard'` の3つのチルダプレフィクスプロパティで内部 API を名前空間分離し、schema のフィールド名（`message`, `entries` 等）との衝突を防いでいる（`library/src/types/schema.ts:42-68`）

- `[SHOULD]` 型推論を通じた合成の型安全性を保証するために、関数オーバーロードで有限個のアリティを明示的に定義する（可変長ジェネリクスで推論が不十分な場合）
  - 根拠: `pipe()` は1〜19個のアイテムまで個別のオーバーロードを持ち、各ステージの出力型が次のステージの入力型に制約される連鎖的な型推論を実現している（`library/src/methods/pipe/pipe.ts:80-2682`）

- `[AVOID]` phantom type プロパティを required にして実行時に値を代入すること -- optional かつ `undefined` 可能にしてランタイムコストをゼロにする
  - 根拠: `'~types'` は `readonly '~types'?: { ... } | undefined` として定義され、実行時には値を持たないが、`NonNullable<T['~types']>` で型情報を抽出できる（`library/src/types/schema.ts:62-68`, `library/src/types/infer.ts:14-23`）

## 適用チェックリスト

- [ ] ライブラリの公開 API がクラスではなくファクトリ関数で構成されているか確認する
- [ ] 複数種類のオブジェクトを統一的に扱う場合、判別フィールド（`kind` 等）がリテラル型で定義されているか確認する
- [ ] `@__NO_SIDE_EFFECTS__` アノテーションがファクトリ関数に付与されているか確認する
- [ ] `package.json` に `"sideEffects": false`（または sideEffects 配列）が設定されているか確認する
- [ ] パイプライン/チェーン処理で中間結果のオブジェクトコピーが不要に行われていないか確認する
- [ ] 内部 API プロパティがユーザー空間のプロパティ名と衝突しない命名規則を持っているか確認する
- [ ] 型レベルのみの情報（phantom type）が実行時にコストを発生させていないか確認する
