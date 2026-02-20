# error-handling-idioms

> リポジトリ: colinhacks/zod
> 分析日: 2026-02-19

## 概要

Zod のエラーハンドリングは、バリデーションエラーを構造化データとして扱い、複数のレイヤーで消費者のニーズに応える設計になっている。単なる「エラーメッセージ」ではなく、型コード・パス・メタデータを持つ issue オブジェクトのフラットリストを核とし、そこから flatten / format / treeify / prettify という多様な変換パイプラインを提供する。i18n はエラーマップ関数による遅延解決で実現し、40+ 言語をプラグイン的にサポートする。この設計はバリデーションライブラリに限らず、構造化エラーを扱うあらゆるシステムに応用可能なパターンを提供している。

## 背景にある原則

- **エラーはデータであり、例外ではない**: `safeParse` が `{ success: false, error }` を返す Result 型パターンを第一級 API として提供している。`parse` は throw するが、内部的には同じコードパスを通り、issues 配列を構築した上で最後に `ZodError` に包む。例外を投げるかどうかは呼び出し側が選択する設計であり、エラー情報自体はいずれの場合も同一の構造化データである（`packages/zod/src/v4/core/parse.ts:59-72`）。

- **フラットリスト + パス = ツリー構造の遅延構築**: issues は常にフラットな配列で蓄積され、各 issue が `path: PropertyKey[]` を持つ。ツリー構造（`formatError`, `treeifyError`）はエラー消費時にオンデマンドで構築される。これにより、パース中のメモリ確保が最小化され、消費側のユースケースに応じた変換が可能になる（`packages/zod/src/v4/core/errors.ts:262-385`）。

- **メッセージ解決の責務分離**: issue はパース時にはメッセージなし（`$ZodRawIssue`）で生成され、`finalizeIssue` で初めてメッセージが解決される。解決の優先順序は「スキーマ個別 > パースコンテキスト > グローバルカスタム > ロケール > フォールバック」の4段チェーンであり、各レイヤーが null/undefined を返せば次に委譲される（`packages/zod/src/v4/core/util.ts:838-864`）。

- **continue フラグによる部分的バリデーション継続**: 各 issue に `continue` フラグを持たせ、致命的エラー（型不一致）では即座に中断し、非致命的エラー（フォーマット不一致）ではチェーンを続行する。これにより、一回のバリデーションで可能な限り多くのエラーを収集できる（`packages/zod/src/v4/core/util.ts:804-824`）。

## 実例と分析

### issue の型安全な判別ユニオン

`$ZodIssue` は `code` フィールドを discriminator とする判別ユニオンとして定義されている。各 issue サブタイプは固有のメタデータを持ち、消費者は `switch(issue.code)` で安全に分岐できる。

```ts
// packages/zod/src/v4/core/errors.ts:179-190
export type $ZodIssue =
  | $ZodIssueInvalidType
  | $ZodIssueTooBig
  | $ZodIssueTooSmall
  | $ZodIssueInvalidStringFormat
  | $ZodIssueNotMultipleOf
  | $ZodIssueUnrecognizedKeys
  | $ZodIssueInvalidUnion
  | $ZodIssueInvalidKey
  | $ZodIssueInvalidElement
  | $ZodIssueInvalidValue
  | $ZodIssueCustom;
```

各サブタイプは `readonly` プロパティでメタデータを保持する。例えば `$ZodIssueTooBig` は `maximum`, `inclusive`, `exact`, `origin` を持ち、エラーマップ関数がこれらを使って文脈に応じたメッセージを生成できる。

### safeParse パターン（Result 型）

```ts
// packages/zod/src/v4/core/util.ts:179-184
export type SafeParseResult<T> = SafeParseSuccess<T> | SafeParseError<T>;
export type SafeParseSuccess<T> = { success: true; data: T; error?: never; };
export type SafeParseError<T> = {
  success: false;
  data?: never;
  error: errors.$ZodError<T>;
};
```

`error?: never` / `data?: never` の相互排他パターンにより、`success` フラグに基づく narrowing 後のプロパティアクセスが型安全になる。

### エラーメッセージの4段優先チェーン

`finalizeIssue` は issue にメッセージがない場合、以下の優先順序でメッセージを解決する。

```ts
// packages/zod/src/v4/core/util.ts:838-864
export function finalizeIssue(
  iss: errors.$ZodRawIssue,
  ctx: schemas.ParseContextInternal | undefined,
  config: $ZodConfig,
): errors.$ZodIssue {
  const full = { ...iss, path: iss.path ?? [] } as errors.$ZodIssue;
  if (!iss.message) {
    const message = unwrapMessage(iss.inst?._zod.def?.error?.(iss as never)) // 1. スキーマ個別
      ?? unwrapMessage(ctx?.error?.(iss as never)) // 2. パースコンテキスト
      ?? unwrapMessage(config.customError?.(iss)) // 3. グローバルカスタム
      ?? unwrapMessage(config.localeError?.(iss)) // 4. ロケール
      ?? "Invalid input"; // 5. フォールバック
    (full as any).message = message;
  }
  // ...
}
```

この設計により、同一スキーマを異なるロケールやコンテキストで再利用できる。

### i18n アーキテクチャ: エラーマップ関数

ロケールファイルは `$ZodErrorMap` 型の関数を返すファクトリとして実装されている。

```ts
// packages/zod/src/v4/locales/ja.ts:58-68
return (issue) => {
  switch (issue.code) {
    case "invalid_type": {
      const expected = TypeDictionary[issue.expected] ?? issue.expected;
      const receivedType = util.parsedType(issue.input);
      const received = TypeDictionary[receivedType] ?? receivedType;
      return `無効な入力: ${expected}が期待されましたが、${received}が入力されました`;
    }
      // ...
  }
};
```

40+ 言語のロケールファイルが同一のインターフェースで実装されており、`z.config({ localeError })` 一行で切り替え可能。各ロケールは `Sizable` / `FormatDictionary` / `TypeDictionary` という辞書テーブルを持ち、issue コードに応じたテンプレート生成を行う。

### パラメータ正規化: 文字列ショートハンド

`normalizeParams` がスキーマの `error` パラメータを統一的に扱う。

```ts
// packages/zod/src/v4/core/util.ts:509-521
export function normalizeParams<T>(_params: T): Normalize<T> {
  const params: any = _params;
  if (!params) return {} as any;
  if (typeof params === "string") return { error: () => params } as any;
  if (params?.message !== undefined) {
    if (params?.error !== undefined) throw new Error("Cannot specify both `message` and `error` params");
    params.error = params.message;
  }
  delete params.message;
  if (typeof params.error === "string") return { ...params, error: () => params.error } as any;
  return params;
}
```

`z.string("カスタムメッセージ")` という文字列指定と `z.string({ error: (iss) => ... })` という関数指定を同一パスに正規化している。

### エラー変換パイプライン

`$ZodError` から4つの異なるビューを構築できる。

| 変換関数        | 出力形態                               | 主な用途               |
| --------------- | -------------------------------------- | ---------------------- |
| `flattenError`  | `{ formErrors, fieldErrors }`          | フォームライブラリ連携 |
| `formatError`   | ネストした `{ _errors }` ツリー        | React Hook Form 等     |
| `treeifyError`  | `{ errors, properties, items }` ツリー | 構造化エラー表示       |
| `prettifyError` | 人間可読な文字列                       | CLI / ログ出力         |

## コード例

### issue の蓄積と continue フラグ

```ts
// packages/zod/src/v4/core/checks.ts:79-92
inst._zod.check = (payload) => {
  if (def.inclusive ? payload.value <= def.value : payload.value < def.value) {
    return;
  }
  payload.issues.push({
    origin,
    code: "too_big",
    maximum: typeof def.value === "object" ? def.value.getTime() : def.value,
    input: payload.value,
    inclusive: def.inclusive,
    inst,
    continue: !def.abort,
  });
};
```

`continue: !def.abort` により、`abort: false`（デフォルト）なら後続チェックが続行される。

### パスの伝搬

```ts
// packages/zod/src/v4/core/util.ts:826-832
export function prefixIssues(path: PropertyKey, issues: errors.$ZodRawIssue[]): errors.$ZodRawIssue[] {
  return issues.map((iss) => {
    (iss as any).path ??= [];
    (iss as any).path.unshift(path);
    return iss;
  });
}
```

オブジェクトのプロパティ検証時、子スキーマの issues にプロパティ名をプレフィックスとして付加する。

### $ZodError と $ZodRealError の分離

```ts
// packages/zod/src/v4/core/errors.ts:247-249
export const $ZodError: $constructor<$ZodError> = $constructor("$ZodError", initializer);
export const $ZodRealError: $constructor<$ZodRealError> = $constructor("$ZodError", initializer, { Parent: Error });
```

`$ZodError` は `Error` を継承しないが、`$ZodRealError` は `Error` を継承する。`safeParse` は内部で `$ZodRealError` を生成するが、`instanceof Error` を必要としないコンテキストでは軽量な `$ZodError` が使える。

## パターンカタログ

- **Result Type** (分類: 振る舞い)
  - 解決する問題: 例外による制御フローの暗黙性を排除し、エラーハンドリングを呼び出し側に強制する
  - 適用条件: バリデーション結果を呼び出し側が分岐処理する必要がある場合
  - コード例: `packages/zod/src/v4/core/util.ts:179-184`
  - 注意点: `success` フラグで narrowing するため、`error?: never` / `data?: never` パターンが必要

- **Chain of Responsibility** (分類: 振る舞い)
  - 解決する問題: エラーメッセージの解決を複数のレイヤーに委譲し、各レイヤーが独立にカスタマイズ可能にする
  - 適用条件: メッセージのカスタマイズが複数の粒度（個別・コンテキスト・グローバル・ロケール）で必要な場合
  - コード例: `packages/zod/src/v4/core/util.ts:847-852`
  - 注意点: null/undefined を返すことで次のハンドラに委譲する規約が必要

- **Strategy Pattern** (分類: 振る舞い)
  - 解決する問題: エラーの表示形式をユースケースに応じて切り替える
  - 適用条件: 同一のエラーデータを複数の消費者（フォーム、CLI、ログ、API レスポンス）が異なる形式で必要とする場合
  - コード例: `packages/zod/src/v4/core/errors.ts:262-448` (flatten / format / treeify / prettify)
  - 注意点: 変換関数に mapper パラメータを渡すことで、型レベルでも出力のカスタマイズが可能

## Good Patterns

- **文字列ショートハンドによる人間工学的 API**: `z.string("必須です")` のように、最も多いユースケース（固定メッセージ）をワンライナーで書ける。`normalizeParams` が内部で関数に変換するため、実装側は常に関数を受け取るだけでよい。

```ts
// packages/zod/src/v4/core/util.ts:513
if (typeof params === "string") return { error: () => params } as any;
```

- **readonly プロパティで issue の不変性を保証**: issue サブタイプの全フィールドが `readonly` であり、消費者が issue を改変できない。

```ts
// packages/zod/src/v4/core/errors.ts:44-48
export interface $ZodIssueInvalidType<Input = unknown> extends $ZodIssueBase {
  readonly code: "invalid_type";
  readonly expected: $ZodInvalidTypeExpected;
  readonly input?: Input;
}
```

- **フォールバック辞書パターンで i18n の堅牢性を担保**: ロケール辞書に未登録のキーは `??` で元の値にフォールバックするため、新しい型やフォーマットが追加されてもロケールが壊れない。

```ts
// packages/zod/src/v4/locales/en.ts:64
const expected = TypeDictionary[issue.expected] ?? issue.expected;
```

- **message と error の排他チェック**: `normalizeParams` で `message` と `error` の同時指定を即座に throw する。これにより、曖昧な設定が実行時まで残らない。

```ts
// packages/zod/src/v4/core/util.ts:515
if (params?.error !== undefined) throw new Error("Cannot specify both `message` and `error` params");
```

## Anti-Patterns / 注意点

- **エラーメッセージのハードコード**: issue にメッセージを直接埋め込むと、i18n チェーンを迂回してしまう。

```ts
// Bad: メッセージが固定され、ロケール切り替えが効かない
payload.issues.push({
  code: "custom",
  message: "Name is required",
  input: payload.value,
});

// Better: message を省略し、error map に委譲する
payload.issues.push({
  code: "custom",
  input: payload.value,
  inst,
});
```

- **エラーの木構造を直接構築する**: パース中にネストしたエラーオブジェクトを構築すると、不要な構造がメモリに残り、消費者のニーズに合わない形式になる。

```ts
// Bad: パース中にネスト構造を構築
const errors = { username: { _errors: ["Invalid"] } };

// Better: フラットな issues 配列 + path で管理し、消費時に変換
issues.push({ code: "invalid_type", path: ["username"], ... });
// 消費時: treeifyError(error) / flattenError(error) / formatError(error)
```

- **issue code の自由文字列化**: `code` フィールドに任意文字列を使うと、判別ユニオンによる型安全な分岐が壊れる。Zod は `"custom"` コードに `params` フィールドを設け、カスタムメタデータをそこに格納する設計を採用している。

```ts
// Bad: カスタムコードで判別ユニオンを壊す
{ code: "password_too_weak", ... }

// Better: code は定義済みの値を使い、params でメタデータを渡す
{ code: "custom", params: { reason: "password_too_weak", strength: 2 }, ... }
```

## 導出ルール

- `[MUST]` バリデーションエラーは構造化データ（コード + パス + メタデータ）として表現し、人間可読メッセージは消費時に生成する
  - 根拠: Zod は issue にメッセージを遅延解決する設計で 40+ ロケールの i18n と4種の表示形式を実現している（`util.ts:838-864`）

- `[MUST]` エラーのユニオン型には文字列リテラルの discriminator を持たせ、消費者が `switch` で型安全に分岐できるようにする
  - 根拠: `$ZodIssue` は `code` フィールドの判別ユニオンで、各サブタイプ固有のメタデータ（`maximum`, `expected`, `keys` 等）に型安全にアクセスできる（`errors.ts:179-190`）

- `[SHOULD]` バリデーション結果は Result 型（`{ success, data, error }` の判別ユニオン）で返し、例外を投げる API は別途提供する
  - 根拠: `safeParse` と `parse` を並行提供し、`success` フラグで narrowing する設計が Zod の全パース API の基盤になっている（`parse.ts:59-72`）

- `[SHOULD]` エラーメッセージのカスタマイズは Chain of Responsibility で複数レイヤー（個別・コンテキスト・グローバル・ロケール）に委譲する
  - 根拠: `finalizeIssue` の `??` チェーンにより、各レイヤーが null を返すことで次に委譲する設計がスキーマの再利用性を担保している（`util.ts:847-852`）

- `[SHOULD]` ネストしたバリデーションエラーはフラットリスト + パス配列で蓄積し、ツリー構造は消費時に遅延構築する
  - 根拠: Zod は `issues: $ZodRawIssue[]` というフラットリストでエラーを蓄積し、`flattenError` / `formatError` / `treeifyError` / `prettifyError` の4変換でユースケースに応じた表示を提供している（`errors.ts:262-448`）

- `[SHOULD]` 非致命的バリデーションエラーでは後続チェックを続行し、一回の検証で可能な限り多くのエラーを収集する
  - 根拠: `continue` フラグにより、フォーマットエラー等ではチェーンが続行され、ユーザーが複数の問題を一度に把握できる（`util.ts:804-812`, `checks.ts` の `abort: false` デフォルト）

- `[AVOID]` バリデーション関数内でエラーメッセージを直接文字列として埋め込むこと。i18n やカスタマイズの余地がなくなる
  - 根拠: Zod は issue 生成時に `message` を省略可能とし、`finalizeIssue` でエラーマップチェーンを通じて解決する設計を採用している（`util.ts:846-852`）

## 適用チェックリスト

- [ ] バリデーションエラーを `{ code, path, ...metadata }` の構造化オブジェクトとして定義しているか
- [ ] エラーコードは文字列リテラルユニオンで定義し、判別ユニオンとして型安全に消費できるか
- [ ] `parse`（throw）と `safeParse`（Result 型）の両方の API を提供しているか
- [ ] エラーメッセージの生成をバリデーション実行から分離し、エラーマップ等の仕組みで遅延解決しているか
- [ ] i18n が必要な場合、ロケール関数をプラグイン的に差し替えられる設計になっているか
- [ ] ネストしたオブジェクトのエラーをフラットリスト + パス配列で管理し、消費側の要件に応じた変換（flatten / tree / pretty）を提供しているか
- [ ] 非致命的エラーでバリデーションを続行し、一度の検証で複数のエラーを返せるか
- [ ] カスタムバリデーションのエラー情報を、定義済みのコード + params フィールドで構造化しているか
