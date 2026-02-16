# Pattern: Escalating Escape Hatches

> 出典: [repos/open-circle/valibot/extensibility-mechanisms.md](../repos/open-circle/valibot/extensibility-mechanisms.md), [repos/open-circle/valibot/api-design-practices.md](../repos/open-circle/valibot/api-design-practices.md)
> カテゴリ: pattern

## 概要

Escalating Escape Hatches は、ライブラリの拡張ポイントを複数の抽象度レベルで段階的に提供する設計パターンである。高レベル API は制約が強く安全で、低レベル API は柔軟だが責任が大きい。大多数のユーザーは安全な高レベル API で完結しつつ、必要に応じて低レベルに「降りる」ことができるため、ライブラリの簡潔さと拡張性を両立できる。

## 背景・文脈

このパターンは [valibot](https://github.com/fabian-hiller/valibot) のバリデーション/変換アクションで観察された。valibot はスキーマバリデーションライブラリであり、ユーザーがカスタムバリデーションやカスタム変換を定義する際に、以下の 3 段階の抽象度レベルを提供している。

| Level | API                       | 抽象度 | ユーザーの責任                                               | 用途                                       |
| ----- | ------------------------- | ------ | ------------------------------------------------------------ | ------------------------------------------ |
| 1     | `check()` / `transform()` | 高     | 入力値のみ操作                                               | 単純な検証・変換                           |
| 2     | `rawCheck()`              | 中     | dataset + config にアクセス、カスタム issue 報告             | 複数フィールドの相関検証、カスタムパス指定 |
| 3     | `rawTransform()`          | 低     | dataset + config にアクセス、値変換 + エラー報告を同時に行う | 変換過程でのエラー報告、条件付き変換       |

このパターンが成立する前提は 3 つある:

1. **統一プロトコル**: 全レベルの API が同じパイプラインプロトコル (`'~run'` メソッド) に準拠し、`pipe()` で合成できる
2. **内部構造の隠蔽**: 高レベル API は内部の dataset 構造を隠蔽し、ユーザーに公開するインターフェースを最小化する
3. **段階的な情報開示**: レベルが下がるにつれ、dataset, config, addIssue といった内部概念が順に露出する

## 実装パターン

### Level 1: `check()` -- 最も制約が強く安全な API

入力値のみを受け取り、`boolean` を返す。エラーメッセージは自動的に生成される。ユーザーは dataset の存在すら意識しない。

```typescript
// open-circle/valibot — library/src/actions/check/check.ts:62-81
// @__NO_SIDE_EFFECTS__
export function check(
  requirement: (input: unknown) => boolean,
  message?: ErrorMessage<CheckIssue<unknown>>,
): CheckAction<unknown, ErrorMessage<CheckIssue<unknown>> | undefined> {
  return {
    kind: "validation",
    type: "check",
    reference: check,
    async: false,
    expects: null,
    requirement,
    message,
    "~run"(dataset, config) {
      if (dataset.typed && !this.requirement(dataset.value)) {
        _addIssue(this, "input", dataset, config);
      }
      return dataset;
    },
  };
}
```

`transform()` も同様に、入力値のみを受け取って変換後の値を返す高レベル API である。

```typescript
// open-circle/valibot — library/src/actions/transform/transform.ts:29-46
// @__NO_SIDE_EFFECTS__
export function transform<TInput, TOutput>(
  operation: (input: TInput) => TOutput,
): TransformAction<TInput, TOutput> {
  return {
    kind: "transformation",
    type: "transform",
    reference: transform,
    async: false,
    operation,
    "~run"(dataset) {
      dataset.value = this.operation(dataset.value);
      return dataset as SuccessDataset<TOutput>;
    },
  };
}
```

### Level 2: `rawCheck()` -- dataset と config への直接アクセス

コンテキストオブジェクト経由で `dataset`, `config`, `addIssue` にアクセスできる。カスタムパスやラベルを指定した issue 報告が可能。

```typescript
// open-circle/valibot — library/src/actions/rawCheck/rawCheck.ts:31-51
// @__NO_SIDE_EFFECTS__
export function rawCheck<TInput>(
  action: (context: RawCheckContext<TInput>) => void,
): RawCheckAction<TInput> {
  return {
    kind: "validation",
    type: "raw_check",
    reference: rawCheck,
    async: false,
    expects: null,
    "~run"(dataset, config) {
      action({
        dataset,
        config,
        addIssue: (info) => _addIssue(this, info?.label ?? "input", dataset, config, info),
      });
      return dataset;
    },
  };
}
```

`RawCheckContext` はユーザーに公開するインターフェースを明示的に定義している。

```typescript
// open-circle/valibot — library/src/actions/rawCheck/types.ts:45-49
export interface RawCheckContext<TInput> {
  readonly dataset: OutputDataset<TInput, BaseIssue<unknown>>;
  readonly config: Config<RawCheckIssue<TInput>>;
  readonly addIssue: RawCheckAddIssue<TInput>;
}
```

### Level 3: `rawTransform()` -- 値変換 + エラー報告の統合

変換と検証を同時に行う最も低レベルな拡張ポイント。コールバックの戻り値が新しいデータセット値になり、`addIssue` でエラーを報告すると変換結果は破棄される。

```typescript
// open-circle/valibot — library/src/actions/rawTransform/rawTransform.ts:31-67
// @__NO_SIDE_EFFECTS__
export function rawTransform<TInput, TOutput>(
  action: (context: RawTransformContext<TInput>) => TOutput,
): RawTransformAction<TInput, TOutput> {
  return {
    kind: "transformation",
    type: "raw_transform",
    reference: rawTransform,
    async: false,
    "~run"(dataset, config) {
      const output = action({
        dataset,
        config,
        addIssue: (info) => _addIssue(this, info?.label ?? "input", dataset, config, info),
        NEVER: null as never,
      });
      if (dataset.issues) {
        dataset.typed = false;
      } else {
        dataset.value = output;
      }
      return dataset;
    },
  };
}
```

### 段階ごとの制約の違い

| 観点                | Level 1 (`check`/`transform`)    | Level 2 (`rawCheck`)                     | Level 3 (`rawTransform`)                        |
| ------------------- | -------------------------------- | ---------------------------------------- | ----------------------------------------------- |
| コールバック引数    | `input: TInput`                  | `context: { dataset, config, addIssue }` | `context: { dataset, config, addIssue, NEVER }` |
| 戻り値              | `boolean` / `TOutput`            | `void`                                   | `TOutput`                                       |
| dataset アクセス    | 不可                             | 読み取り可能                             | 読み取り可能                                    |
| カスタム issue パス | 不可                             | `addIssue({ path: [...] })` で指定可能   | `addIssue({ path: [...] })` で指定可能          |
| 値の変換            | `transform` のみ可能             | 不可                                     | 可能（戻り値が新しい値）                        |
| エラー時の振る舞い  | 自動（`_addIssue` 内部呼び出し） | 手動（`addIssue` を明示的に呼ぶ）        | 手動 + issue 発生時に値が破棄される             |

## Good Example

### 適切なレベル選択の例

```typescript
// Good: 単純な検証には check() で十分
const positiveNumber = v.pipe(
  v.number(),
  v.check((input) => input > 0, "Must be positive"),
);

// Good: 複数フィールドの相関検証には rawCheck() を使う
const passwordForm = v.pipe(
  v.object({
    password: v.string(),
    confirmation: v.string(),
  }),
  v.rawCheck(({ dataset, addIssue }) => {
    if (
      dataset.typed
      && dataset.value.password !== dataset.value.confirmation
    ) {
      addIssue({
        message: "Passwords do not match",
        path: [
          {
            type: "object",
            origin: "value",
            input: dataset.value,
            key: "confirmation",
            value: dataset.value.confirmation,
          },
        ],
      });
    }
  }),
);

// Good: 変換過程でエラーが起こりうる場合のみ rawTransform() を使う
const parseJSON = v.pipe(
  v.string(),
  v.rawTransform(({ dataset, addIssue, NEVER }) => {
    try {
      return JSON.parse(dataset.value) as unknown;
    } catch {
      addIssue({ message: "Invalid JSON" });
      return NEVER;
    }
  }),
);
```

この例では、要件の複雑さに応じて適切なレベルの API が選択されている。`check()` で十分な場合は `check()` を、複数フィールドのパス指定が必要な場合のみ `rawCheck()` を、変換とエラー報告を同時に行う必要がある場合のみ `rawTransform()` を使っている。

## Bad Example

### 低レベル API の安易な使用

```typescript
// Bad: rawCheck で単純な検証を行う -- check で十分
const positiveNumber = v.pipe(
  v.number(),
  v.rawCheck(({ dataset, addIssue }) => {
    if (dataset.typed && dataset.value < 0) {
      addIssue({ message: "Must be positive" });
    }
  }),
);

// Better: check で十分
const positiveNumber = v.pipe(
  v.number(),
  v.check((input) => input >= 0, "Must be positive"),
);
```

`rawCheck()` を使うと dataset の内部構造への依存が生じ、将来のライブラリ内部リファクタリングで壊れるリスクがある。`check()` で実現可能なら、常に `check()` を優先すべきである。

### フラットな API で全機能を 1 関数に詰め込む設計

```typescript
// Bad: 1 つの関数に全レベルの機能を options で詰め込む
function validate(options: {
  mode: "simple" | "raw" | "transform";
  requirement?: (input: unknown) => boolean;
  action?: (ctx: Context) => void;
  transform?: (ctx: Context) => unknown;
  message?: string;
}): ValidationAction {
  // mode に応じて分岐...
}

// Better: 段階ごとに独立した関数を提供する
check(requirement, message); // 単純検証
rawCheck(action); // 高度な検証
rawTransform(action); // 変換 + エラー報告
```

1 つの関数に全レベルの機能を options で詰め込むと、型推論が弱くなり、不正な options の組み合わせをコンパイル時に検出できない。関数を分けることで各関数のシグネチャが単純になり、ツリーシェイキングも最大化される。

## 適用ガイド

### いつ使うべきか

- **ライブラリの拡張 API を設計する場合**: ユーザーが独自のロジックを注入する拡張ポイントを提供するライブラリで、ユーザーの要件の複雑さにばらつきがある場合に最適
- **内部構造を隠蔽しつつ柔軟性を確保したい場合**: 大多数のユーザーには内部構造を意識させず、一部のパワーユーザーにのみ内部へのアクセスを許可したい場合
- **API の誤用を防ぎたい場合**: 低レベル API に「raw」のようなプレフィックスを付けることで、「意図的に低レベルに降りている」ことをユーザーに自覚させられる

### 設計の手順

1. **最も一般的なユースケースを特定する**: 80% 以上のユーザーが満足できる高レベル API を最初に設計する。引数は最小限（値のみ）、戻り値は単純な型（`boolean` や変換後の値）にする
2. **高レベル API で解決できないユースケースを列挙する**: 複数フィールドの相関検証、カスタムエラーパスの指定、変換とエラー報告の同時実行など
3. **追加で公開する内部概念を段階的に決める**: Level 2 では `dataset` と `addIssue`、Level 3 では更に値の変換権限を追加するというように、公開する内部概念を段階的に増やす
4. **各レベルを独立した関数として提供する**: options フラグで切り替えるのではなく、別名の関数として提供する。これにより型シグネチャが単純になり、ツリーシェイキングも効く

### 命名規約

valibot では `raw` プレフィックスを使って低レベル API を示している。この命名規約には 2 つの効果がある:

1. **意図の明示**: 「通常の API では不十分な場合にのみ使う」ことがAPIの名前から伝わる
2. **ドキュメントの段階的開示**: 入門ドキュメントでは `check()` / `transform()` のみを紹介し、上級ドキュメントで `rawCheck()` / `rawTransform()` を説明する構成が自然になる

### 他のライブラリへの適用例

このパターンは valibot に限らず、あらゆるライブラリの拡張ポイント設計に応用できる。

- **ロガーライブラリ**: `log(message)` (高) -> `logWithContext(context)` (中) -> `rawLog(transport)` (低)
- **HTTP クライアント**: `get(url)` (高) -> `request(options)` (中) -> `rawRequest(socket)` (低)
- **テストフレームワーク**: `expect(value).toBe(expected)` (高) -> `expect(value).toSatisfy(predicate)` (中) -> `addAssertion(context)` (低)
- **ORM**: `findById(id)` (高) -> `findWhere(conditions)` (中) -> `rawQuery(sql)` (低)

共通する設計原則は以下の通り:

- 高レベル API は内部構造を完全に隠蔽する
- 低レベルに降りるほど、公開されるコンテキスト情報が増える
- 各レベルは独立した関数として提供し、options フラグで切り替えない
- 低レベル API の命名で「意図的な選択」であることを明示する（`raw` プレフィックス等）

### 導入時の注意点

1. **レベルの数は 2-3 が適切**: 4 段階以上になると各レベルの違いが曖昧になり、ユーザーが適切なレベルを選択しにくくなる
2. **高レベル API のカバレッジを十分に確保する**: 高レベル API で 80% 以上のユースケースをカバーできなければ、多くのユーザーが低レベル API に降りることになり、パターンの利点が薄れる
3. **低レベル API の安定性保証**: 低レベル API が公開する内部構造（valibot の場合は `dataset`）は、ライブラリのメジャーバージョン間で互換性を維持する必要がある。内部構造を公開する以上、それは事実上のパブリック API になる
4. **マイグレーションパスの提供**: ライブラリの進化に伴い、かつて低レベル API でしか実現できなかった機能を高レベル API に昇格させることで、ユーザーを安全な API に誘導できる

## 参考

- [repos/open-circle/valibot/extensibility-mechanisms.md](../repos/open-circle/valibot/extensibility-mechanisms.md) -- 拡張メカニズムの全体像と段階的拡張ポイントの詳細分析
- [repos/open-circle/valibot/api-design-practices.md](../repos/open-circle/valibot/api-design-practices.md) -- API 設計の一貫性、オーバーロード戦略、関数分離の原則
- [repos/open-circle/valibot/abstraction-patterns.md](../repos/open-circle/valibot/abstraction-patterns.md) -- プロトコルベースの多態性とファクトリ関数パターン
