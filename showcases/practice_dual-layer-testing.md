# Practice: Dual-Layer Testing

> 出典: [repos/open-circle/valibot](../repos/open-circle/valibot/) からの知見
> カテゴリ: practice

## 概要

ランタイムテスト（`.test.ts`）と型テスト（`.test-d.ts`）を 1:1 で対応させ、ドメイン固有のテストヘルパーで語彙を均質化する二層テスト戦略。型推論を提供するライブラリでは「値が正しい」だけでなく「型が正しい」も独立したテスト対象であり、両者を同一コマンド（`vitest --typecheck`）で実行することで、片方の変更がもう片方を壊したことを即座に検知できる。

## 背景・文脈

valibot はスキーマバリデーションライブラリで、258 個のランタイムテストと 234 個の型テストが対になっている。各ユニット（スキーマ・アクション・メソッド）は固定の 4 ファイル構成（`name.ts` / `name.test.ts` / `name.test-d.ts` / `index.ts`）を持ち、テスト構造も三段構成（オブジェクト構造 / 成功ケース / 失敗ケース）で統一されている。8 つのドメイン固有テストヘルパー（`library/src/vitest/`）がアサーションロジックを一元化し、数百のテストファイルを宣言的かつ均質に保つ。

## 実装パターン

### 1. ランタイムテストと型テストの分離

同一ユニットに対して 2 つのテストファイルを配置する。

```typescript
// library/src/schemas/string/string.test.ts:1-3 — ランタイムテスト
import { describe, expect, test } from "vitest";
import { expectNoSchemaIssue, expectSchemaIssue } from "../../vitest/index.ts";
import { string, type StringIssue, type StringSchema } from "./string.ts";
```

```typescript
// library/src/schemas/string/string.test-d.ts:1-3 — 型テスト
import { describe, expectTypeOf, test } from "vitest";
import type { InferInput, InferIssue, InferOutput } from "../../types/index.ts";
import { string, type StringIssue, type StringSchema } from "./string.ts";
```

### 2. ドメイン固有テストヘルパー

内部 API `~run` の呼び出しをヘルパーに集約し、テスト側は値の配列を渡すだけの宣言的な記述にする。

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
        issues: [
          {
            requirement: undefined,
            path: undefined,
            issues: undefined,
            lang: undefined,
            abortEarly: undefined,
            abortPipeEarly: undefined,
            ...baseIssue,
            input: value,
            received: received ?? _stringify(value),
          },
        ],
      } satisfies FailureDataset<InferIssue<TSchema>>,
    );
  }
}
```

8 つのヘルパーが sync/async x schema/action の組み合わせをカバーする:

| ヘルパー              | 用途                                                |
| --------------------- | --------------------------------------------------- |
| `expectNoSchemaIssue` | スキーマが値を受理することを検証                    |
| `expectSchemaIssue`   | スキーマが値を拒否し正しい Issue を返すことを検証   |
| `expectNoActionIssue` | アクションが値を受理することを検証                  |
| `expectActionIssue`   | アクションが値を拒否し正しい Issue を返すことを検証 |
| `*Async` 版（4 つ）   | 上記それぞれの非同期版                              |

### 3. `satisfies` による二重検証

ランタイムテストの期待値に `satisfies` を付けることで、テストデータ自体の型安全性をコンパイル時に保証する。

```typescript
// library/src/schemas/string/string.test.ts:30-34
test("with string message", () => {
  expect(string("message")).toStrictEqual(
    {
      ...baseSchema,
      message: "message",
    } satisfies StringSchema<"message">,
  );
});
```

### 4. 型テストの三軸検証（Input / Output / Issue）

型テストでは `InferInput`, `InferOutput`, `InferIssue` の 3 つの観点を個別のテストケースで検証する。transform を経由するパイプラインでは Input と Output の型が異なる。

```typescript
// library/src/methods/pipe/pipe.test-d.ts:59-78
describe("should infer correct types", () => {
  type Schema = typeof schema;

  test("of input", () => {
    expectTypeOf<InferInput<Schema>>().toEqualTypeOf<string>();
  });

  test("of output", () => {
    expectTypeOf<InferOutput<Schema>>().toEqualTypeOf<number>();
  });

  test("of issue", () => {
    expectTypeOf<InferIssue<Schema>>().toEqualTypeOf<
      | StringIssue
      | MinLengthIssue<string, 1>
      | DecimalIssue<string>
      | NumberIssue
      | MinValueIssue<number, 100>
    >();
  });
});
```

### 5. 否定的型テスト

`not.toMatchTypeOf` と `@ts-expect-error` で「型が一致しないこと」を積極的にテストする。

```typescript
// library/src/actions/brand/brand.test-d.ts:28-46
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

## Good Example

`baseSchema` / `baseIssue` を冒頭で定義し、各テストは差分だけを検証する。ヘルパーに値の配列を渡す宣言的なスタイル。

```typescript
// library/src/actions/email/email.test.ts:7-42 + 164-178 (抜粋)
describe("email", () => {
  describe("should return action object", () => {
    // 共通プロパティを base として定義
    const baseAction: Omit<EmailAction<string, never>, "message"> = {
      kind: "validation",
      type: "email",
      reference: email,
      expects: null,
      requirement: EMAIL_REGEX,
      async: false,
      "~run": expect.any(Function),
    };

    test("with string message", () => {
      expect(email("message")).toStrictEqual(
        {
          ...baseAction,
          message: "message",
        } satisfies EmailAction<string, string>,
      );
    });
  });

  describe("should return dataset without issues", () => {
    const action = email();

    // 宣言的: 受理されるべき値の配列を渡す
    test("for simple email", () => {
      expectNoActionIssue(action, ["email@example.com"]);
    });
  });

  describe("should return dataset with issues", () => {
    const action = email("message");
    const baseIssue: Omit<EmailIssue<string>, "input" | "received"> = {
      kind: "validation",
      type: "email",
      expected: null,
      message: "message",
      requirement: EMAIL_REGEX,
    };

    // 宣言的: 拒否されるべき値の配列を渡す
    test("for empty strings", () => {
      expectActionIssue(action, baseIssue, ["", " ", "\n"]);
    });
  });
});
```

## Bad Example

ヘルパーを使わず、各テストに内部 API 呼び出しとアサーションロジックを散在させるパターン。内部 API 変更時に全ファイルの修正が必要になる。

```typescript
// Bad: ヘルパーなし — 同じアサーションパターンが数百ファイルに散在
describe("email", () => {
  test("for simple email", () => {
    // 内部 API の呼び出し方が各テストに直書き
    expect(
      action["~run"]({ typed: true, value: "email@example.com" }, {}),
    ).toStrictEqual({
      typed: true,
      value: "email@example.com",
    });
  });

  test("for underscore email", () => {
    // 同じパターンの繰り返し
    expect(
      action["~run"]({ typed: true, value: "_email@example.com" }, {}),
    ).toStrictEqual({
      typed: true,
      value: "_email@example.com",
    });
  });

  test("for empty strings", () => {
    // 失敗ケースも同じ冗長なパターン
    const result = action["~run"]({ typed: true, value: "" }, {});
    expect(result.typed).toBe(true);
    expect(result.issues).toBeDefined();
    expect(result.issues![0].kind).toBe("validation");
    // ... プロパティごとに個別アサーション
  });
});
```

```typescript
// Good: ヘルパーに集約 — 内部 API 変更時の修正箇所は 1 ファイル
describe("email", () => {
  test("for valid emails", () => {
    expectNoActionIssue(action, [
      "email@example.com",
      "_email@example.com",
    ]);
  });

  test("for empty strings", () => {
    expectActionIssue(action, baseIssue, ["", " ", "\n"]);
  });
});
```

## 適用ガイド

### どのような状況で使うべきか

- **型推論を公開 API として提供するライブラリ**: スキーマライブラリ、ORM、型安全な builder パターンなど、`InferInput<T>` / `InferOutput<T>` のような型ユーティリティをユーザーに提供する場合
- **同一カテゴリのユニットが 10 個以上あるライブラリ**: テストパターンの統一とヘルパーへの集約が保守コスト削減に直結する
- **brand/opaque type を使うライブラリ**: 異なるブランド間の非互換性を型テストで保証する必要がある

### 導入手順

1. **vitest.config に typecheck を有効化**: `vitest --typecheck` で `.test-d.ts` を型チェックモードで実行する
2. **テストヘルパーディレクトリを作成**: `src/vitest/` や `src/__test-helpers__/` に配置し、アサーションロジックを集約する
3. **三段構成のテンプレートを確立**: 「オブジェクト構造 / 成功ケース / 失敗ケース」の describe 構造を最初のユニットで確立し、以降はコピーする
4. **coverage 設定からテストヘルパー・型定義を除外**: `vitest.config.ts` の coverage.exclude に `src/vitest`, `src/types`, `**/index.ts`, `**/*.test-d.ts` を追加する

### vitest.config.ts の設定例

```typescript
// library/vitest.config.ts:1-21
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["src"],
      exclude: [
        "src/types",
        "src/vitest",
        "**/index.ts",
        "**/types.ts",
        "**/*.test.ts",
        "**/*.test-d.ts",
      ],
    },
  },
});
```

### カスタマイズポイント

- **ヘルパーの粒度**: valibot は schema/action x success/failure x sync/async で 8 つに分割しているが、プロジェクトの規模に応じて統合してよい。重要なのは「内部 API 呼び出しが 1 箇所に集約される」こと
- **テスト構造のテンプレート**: 三段構成は valibot のドメインに最適化されたもの。プロジェクトの API 形状に合わせて「構造検証 / 正常系 / 異常系」のような汎用的な構成に読み替える
- **否定的型テストの範囲**: brand/opaque type を使わないプロジェクトでは `@ts-expect-error` によるコンパイルエラーテストだけで十分な場合もある

### 注意点

- 型テストのカバレッジは vitest では計測できない。型テストの網羅性はコードレビューで担保する
- テストヘルパーが内部 API に密結合する設計は意図的なトレードオフ。パブリック API のテストは別途 `parse.test.ts` / `safeParse.test.ts` のような統合テストで行う
- `satisfies` は TypeScript 4.9 以降で利用可能。それ以前のバージョンをサポートする場合は型注釈で代替する

## 参考

- [repos/open-circle/valibot/testing-practices.md](../repos/open-circle/valibot/testing-practices.md) — テスト戦略の詳細分析
- [repos/open-circle/valibot/code-organization.md](../repos/open-circle/valibot/code-organization.md) — ファイル構成と命名規約
- [repos/open-circle/valibot/type-system-patterns.md](../repos/open-circle/valibot/type-system-patterns.md) — 型システム設計の分析
