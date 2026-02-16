# testing-practices

> リポジトリ: open-circle/valibot
> 分析日: 2026-02-16

## 概要

valibot はスキーマバリデーションライブラリとして、ランタイムテスト（`.test.ts`）と型テスト（`.test-d.ts`）を完全に分離した二層テスト戦略を採用している。258 個のランタイムテストファイルと 234 個の型テストファイルが 1:1 で対応し、`vitest --typecheck` で両者を同一コマンドで実行する。注目すべきは、ドメイン固有のテストヘルパー群（`src/vitest/`）による徹底的なアサーション抽象化と、全ユニットで統一された三段構成（オブジェクト構造テスト / 成功ケース / 失敗ケース）の一貫性である。型安全なライブラリにおいて「型の振る舞いもテスト対象」とする設計思想が、コードベース全体の品質を支えている。

## 背景にある原則

- **ランタイムと型は独立した正しさの軸**: ランタイムバリデーションが正しくても型推論が壊れればユーザーに被害が出る。逆も同様。両軸を独立してテストすることで、片方の変更がもう片方を壊したことを即座に検知できる（全スキーマ・アクションで `.test.ts` と `.test-d.ts` が対になっている）

- **テストヘルパーによるアサーションの一元化で保守コストを最小化すべき**: 同じ検証パターンが数百ファイルで繰り返される場合、アサーションロジックをヘルパーに集約すれば変更箇所が 1 つになる。valibot は `expectSchemaIssue` / `expectNoSchemaIssue` / `expectActionIssue` / `expectNoActionIssue` の 8 ヘルパー（sync + async）でランタイムテストの 90% 以上をカバーしている（`library/src/vitest/` ディレクトリ）

- **テスト構造の統一が認知負荷を下げる**: 全ユニットが同じ describe 構造（`should return schema/action object` → `should return dataset without issues` → `should return dataset with issues`）を持つことで、新しいスキーマやアクションを追加する際にテンプレートとしてコピーできる。レビューアも構造の逸脱を即座に見つけられる

- **内部 API を直接テストし、パブリック API テストと役割を分離すべき**: valibot は `schema['~run']({ value }, {})` のように内部メソッドを直接呼び出してユニットテストを行い、`parse()` / `safeParse()` のようなパブリック API は統合テスト的に別途テストしている。これにより単体テストが外部 API の変更に影響されない

## 実例と分析

### 二層テスト戦略: ランタイムと型の分離

各ユニット（スキーマ、アクション、メソッド）は必ず 2 つのテストファイルを持つ。例えば `string` スキーマの場合:

- `string.test.ts` — ランタイムの値検証（入力値が正しく受理/拒否されるか）
- `string.test-d.ts` — 型推論の正しさ（`InferInput`, `InferOutput`, `InferIssue` が期待通りか）

ランタイムテストでは `expect` + `toStrictEqual` で実際の値を検証し、型テストでは `expectTypeOf` + `toEqualTypeOf` で型レベルの等価性を検証する。両者は同じ describe 構造を共有しつつも、テスト内容は完全に独立している。

### ドメイン固有テストヘルパーの設計

`library/src/vitest/` に 8 つの専用ヘルパーが配置されている:

| ヘルパー              | 用途                                                | 対象                      |
| --------------------- | --------------------------------------------------- | ------------------------- |
| `expectNoSchemaIssue` | スキーマが値を受理することを検証                    | 同期スキーマ              |
| `expectSchemaIssue`   | スキーマが値を拒否し正しい Issue を返すことを検証   | 同期スキーマ              |
| `expectNoActionIssue` | アクションが値を受理することを検証                  | 同期アクション            |
| `expectActionIssue`   | アクションが値を拒否し正しい Issue を返すことを検証 | 同期アクション            |
| `*Async` 版（4 つ）   | 上記の非同期版                                      | 非同期スキーマ/アクション |

各ヘルパーは「値の配列」を受け取り、内部で for ループして全値をテストする。これにより、テスト側のコードが宣言的になる。

### 三段構成のテスト構造パターン

コードベース全体で、各ユニットのランタイムテストは以下の三段構成に統一されている:

1. **`should return schema/action object`** — ファクトリ関数が正しいオブジェクト構造を返すか
2. **`should return dataset without issues`** — 正常な入力で issues なしの結果が返るか
3. **`should return dataset with issues`** — 不正な入力で正しい issues が返るか

型テストも同様に:

1. **`should return schema/action object`** — 返り値の型が期待する型と一致するか
2. **`should infer correct types`** — `InferInput`, `InferOutput`, `InferIssue` の型推論が正しいか

### `satisfies` キーワードによる二重検証

ランタイムテストでは `toStrictEqual` の期待値に `satisfies` を付けることで、テストデータ自体の型安全性も同時に検証している。テストデータの型が実装の型定義と乖離した場合、テスト実行前にコンパイルエラーで検出できる。

### untyped input の透過テスト

アクションのテストでは「パイプの前段でスキーマ検証に失敗した untyped な入力」が渡された場合の振る舞いを明示的にテストしている。アクションは untyped input をそのまま透過させるべきであり、これは「アクションはスキーマが型を確定した後にのみ検証を行う」という設計制約を反映している。

## コード例

ドメイン固有ヘルパーの実装。値の配列をループし、内部 API `~run` を直接呼び出す:

```typescript
// library/src/vitest/expectNoSchemaIssue.ts:10-19
export function expectNoSchemaIssue<
  TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>,
>(schema: TSchema, values: InferInput<TSchema>[]): void {
  for (const value of values) {
    expect(schema["~run"]({ value }, {})).toStrictEqual({
      typed: true,
      value,
    });
  }
}
```

`satisfies` による二重検証。テストデータがコンパイル時にも型安全であることを保証:

```typescript
// library/src/schemas/string/string.test.ts:30-43
test("with string message", () => {
  expect(string("message")).toStrictEqual(
    {
      ...baseSchema,
      message: "message",
    } satisfies StringSchema<"message">,
  );
});
```

型テストで InferInput / InferOutput / InferIssue の三軸を検証:

```typescript
// library/src/schemas/string/string.test-d.ts:24-38
describe("should infer correct types", () => {
  type Schema = StringSchema<undefined>;

  test("of input", () => {
    expectTypeOf<InferInput<Schema>>().toEqualTypeOf<string>();
  });

  test("of output", () => {
    expectTypeOf<InferOutput<Schema>>().toEqualTypeOf<string>();
  });

  test("of issue", () => {
    expectTypeOf<InferIssue<Schema>>().toEqualTypeOf<StringIssue>();
  });
});
```

brand アクションの型テストで `not.toMatchTypeOf` による否定的型アサーション:

```typescript
// library/src/actions/brand/brand.test-d.ts:28-45
describe("should only match specific types", () => {
  type Output = InferOutput<Action>;

  test("should not match unbranded types", () => {
    expectTypeOf<string>().not.toMatchTypeOf<Output>();
  });

  test("should match types with same brand", () => {
    expectTypeOf<
      InferOutput<BrandAction<string, "foo">>
    >().toMatchTypeOf<Output>();
  });

  test("should not match types with different brand", () => {
    expectTypeOf<
      InferOutput<BrandAction<string, "bar">>
    >().not.toMatchTypeOf<Output>();
  });
});
```

`@ts-expect-error` を使って「コンパイルエラーになるべきコード」をテスト:

```typescript
// library/src/actions/guard/guard.test-d.ts:65-71
test("should error if pipe input doesn't match", () => {
  pipe(
    number(),
    // @ts-expect-error
    guard(isPixelString),
  );
});
```

object スキーマで `baseSchema` を分離し、メッセージ差分だけをテスト:

```typescript
// library/src/schemas/object/object.test.ts:15-41
describe("should return schema object", () => {
  const entries = { key: string() };
  type Entries = typeof entries;
  const baseSchema: Omit<ObjectSchema<Entries, never>, "message"> = {
    kind: "schema",
    type: "object",
    reference: object,
    expects: "Object",
    entries,
    async: false,
    "~standard": {
      version: 1,
      vendor: "valibot",
      validate: expect.any(Function),
    },
    "~run": expect.any(Function),
  };

  test("with undefined message", () => {
    const schema: ObjectSchema<Entries, undefined> = {
      ...baseSchema,
      message: undefined,
    };
    expect(object(entries)).toStrictEqual(schema);
  });
});
```

## パターンカタログ

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: 数百のスキーマ・アクションテストで同一のテスト構造を維持する
  - 適用条件: 同じカテゴリの多数のユニットが同一のテストパターンを共有する場合
  - コード例: 全スキーマテストが `should return schema object` / `without issues` / `with issues` の三段構成を共有（`library/src/schemas/string/string.test.ts:5-116`）
  - 注意点: 構造の強制はコードレビューに依存しており、自動チェックの仕組みはない

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: sync と async でテストロジックは同じだがアサーション方法が異なる
  - 適用条件: 同期・非同期の双方を提供する API のテスト
  - コード例: `expectSchemaIssue` と `expectSchemaIssueAsync` が同じロジックで sync/async を切り替え（`library/src/vitest/`）
  - 注意点: ヘルパーの数が倍になるため、共通ロジックの抽出も検討すべき

## Good Patterns

- **baseSchema / baseAction / baseIssue による差分テスト**: 各テストファイルの冒頭で共通プロパティを `baseSchema` や `baseIssue` として定義し、個別テストではメッセージなど差分だけを上書きする。これにより、共通プロパティの変更時に修正箇所が 1 箇所に集約される。`expect.any(Function)` で関数参照を柔軟にマッチさせている点も実用的。

```typescript
// library/src/actions/email/email.test.ts:9-17
const baseAction: Omit<EmailAction<string, never>, "message"> = {
  kind: "validation",
  type: "email",
  reference: email,
  expects: null,
  requirement: EMAIL_REGEX,
  async: false,
  "~run": expect.any(Function),
};
```

- **値の配列によるバッチテスト**: ヘルパーが `values: T[]` を受け取り、ループで全値をテストする設計。テストの意図（「これらの値は全て受理されるべき」）が宣言的に表現される。

```typescript
// library/src/schemas/string/string.test.ts:49-51
test("for empty strings", () => {
  expectNoSchemaIssue(schema, ["", " ", "\n"]);
});
```

- **型テストにおける三軸検証（Input / Output / Issue）**: 型が正しいかを `InferInput`, `InferOutput`, `InferIssue` の 3 つの観点から必ず検証する。特にスキーマパイプラインで transform を経由する場合、Input と Output の型が異なることを検証する点が重要。

```typescript
// library/src/methods/pipe/pipe.test-d.ts:59-78
test("of input", () => {
  expectTypeOf<InferInput<Schema>>().toEqualTypeOf<string>();
});
test("of output", () => {
  expectTypeOf<InferOutput<Schema>>().toEqualTypeOf<number>();
});
test("of issue", () => {
  expectTypeOf<InferIssue<Schema>>().toEqualTypeOf<
    StringIssue | MinLengthIssue<string, 1> | DecimalIssue<string> | NumberIssue | MinValueIssue<number, 100>
  >();
});
```

- **否定的型テスト（not.toMatchTypeOf + @ts-expect-error）**: 型が「一致しないこと」を積極的にテストする。brand/flavor のような名目型では、異なるブランド名の型が互換でないことを明示的に検証している。

## Anti-Patterns / 注意点

- **テストヘルパーが内部 API に密結合**: `expectNoSchemaIssue` が `schema['~run']` を直接呼び出しており、内部 API の変更が全ヘルパーに波及する。ただし、ヘルパーに集約されているからこそ変更箇所は 1 つで済む。内部 API をテストすること自体は意図的な設計判断であり、パブリック API のテストは `parse.test.ts` / `safeParse.test.ts` で別途行われている。

```typescript
// Bad: ヘルパーなしで各テストに内部API呼び出しを散在させる
test("for string", () => {
  expect(schema["~run"]({ value: "hello" }, {})).toStrictEqual({ typed: true, value: "hello" });
});
test("for number", () => {
  expect(schema["~run"]({ value: 123 }, {})).toStrictEqual({ typed: true, value: 123 });
});

// Better: ヘルパーに集約する
test("for valid inputs", () => {
  expectNoSchemaIssue(schema, ["hello", 123]);
});
```

- **型テストのカバレッジが不可視**: vitest の `--typecheck` は型テストの「通過/失敗」を報告するが、「どの型パスがテストされていないか」のカバレッジは取得できない。型テストの網羅性はレビューに依存する。

## 導出ルール

- `[MUST]` 型安全なライブラリでは、ランタイムテスト（`.test.ts`）と型テスト（`.test-d.ts`）を 1:1 で対応させ、同一コマンドで実行する
  - 根拠: valibot は 258 個のランタイムテストに対し 234 個の型テストを持ち、`vitest --typecheck` で両者を同時に実行することで、型と値の整合性を常に保証している

- `[MUST]` 同一カテゴリのユニットが多数ある場合、ドメイン固有のテストヘルパーを作成し、アサーションロジックを一元化する
  - 根拠: valibot は 8 つのテストヘルパー（`expectSchemaIssue` 等）で数百のテストファイルを統一し、内部 API 変更時の修正箇所を 1 ファイルに集約している

- `[SHOULD]` テストデータに `satisfies` キーワードを付与し、テストデータ自体の型安全性をコンパイル時に検証する
  - 根拠: valibot のランタイムテストでは `} satisfies StringSchema<'message'>` のように期待値の型を明示し、テストデータと実装の型定義の乖離をコンパイルエラーで検出している

- `[SHOULD]` 型テストでは「一致すること」だけでなく「一致しないこと」も検証する（`not.toMatchTypeOf` / `@ts-expect-error`）
  - 根拠: brand/flavor の型テストで `not.toMatchTypeOf` を使い、異なるブランド名の型が互換でないことを明示的に検証している（`library/src/actions/brand/brand.test-d.ts:32-44`）

- `[SHOULD]` 繰り返しテストでは `base` オブジェクトを定義して差分のみテストし、`expect.any(Function)` で動的値を柔軟にマッチさせる
  - 根拠: 全スキーマ・アクションのテストで `baseSchema` / `baseAction` / `baseIssue` を冒頭に定義し、個別テストではメッセージやオプションの差分だけを検証している

- `[SHOULD]` 型の推論テストでは Input / Output / Issue の三軸を個別のテストケースで検証する
  - 根拠: パイプラインで transform を挟むと Input と Output の型が異なるため、両者を独立して検証しないと型推論のバグを見逃す（`library/src/methods/pipe/pipe.test-d.ts:59-78`）

- `[AVOID]` テストヘルパーを作らずに同一のアサーションパターンを各テストファイルにコピーすること
  - 根拠: 内部 API の変更時に数百ファイルの修正が必要になり、保守コストが爆発する。valibot はヘルパー集約により変更箇所を最小化している

## 適用チェックリスト

- [ ] ライブラリが型推論を提供する場合、各ユニットに `.test-d.ts` ファイルを作成しているか
- [ ] vitest.config に `--typecheck` を有効化し、CI でランタイムテストと型テストを同時に実行しているか
- [ ] 同じカテゴリのユニットが 10 個以上ある場合、ドメイン固有のテストヘルパーを `src/vitest/` 等に集約しているか
- [ ] テストの describe 構造がカテゴリ内で統一されているか（新規追加時にテンプレートとしてコピー可能か）
- [ ] テストデータに `satisfies` を付けてコンパイル時の型安全性を確保しているか
- [ ] 型テストで `InferInput` / `InferOutput` / `InferIssue`（またはプロジェクト固有の型推論ユーティリティ）を個別に検証しているか
- [ ] 名目型（brand / opaque type）を使う場合、異なるブランド間の非互換性を `not.toMatchTypeOf` でテストしているか
- [ ] `@ts-expect-error` を使って「コンパイルエラーになるべきコード」をテストしているか
- [ ] テストのカバレッジ設定から型定義ファイル・テストヘルパー・index ファイルを除外しているか
