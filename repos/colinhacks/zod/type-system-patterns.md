# 型システムパターン

> リポジトリ: colinhacks/zod
> 分析日: 2026-02-19

## 概要

Zod は「スキーマ定義から TypeScript の型を自動推論する」ことを中核価値とするバリデーションライブラリである。この視点では、型推論チェーン（スキーマ合成時に input/output 型が正しく伝播する仕組み）、条件型の戦略的活用、ブランド型による名義的型安全、そして内部実装における `any` の意図的使用パターンを体系化する。4,500 行超の `schemas.ts` には、TypeScript の型システムを限界まで活用するプラクティスが凝縮されており、スキーマライブラリに限らず型駆動 API 設計全般に応用可能な知見が含まれる。

## 背景にある原則

- **Phantom Property による型状態エンコーディング**: ランタイムには存在しない `_zod` プロパティに `output`/`input` フィールドを持たせ、TypeScript の構造的部分型を活用して型推論の「配線」を行う。`$ZodTypeInternals<O, I>` が `output: O; input: I` を宣言し、`core.output<T>` が `T["_zod"]["output"]` を条件型で取り出すことで、スキーマの合成が型レベルでも自動的に伝播する。これにより、ユーザーは型を一切書かなくても正確な型推論を得られる（`packages/zod/src/v4/core/core.ts:117-118`）。

- **型安全境界の明確な分離**: 内部実装では `any` を積極的に使い、公開 API では厳密な型を提供する。biome 設定で `noExplicitAny: "off"` としつつ（コメント: "any is amazing"）、ユーザー向けインターフェースでは条件型とジェネリクスで完全な型安全を実現する。これは「型安全のコストは API 境界で支払い、内部実装にまで強制しない」という実用的判断である（`biome.jsonc:24`）。

- **型レベル計算のインクリメンタル合成**: 各スキーマ型（`$ZodOptional`, `$ZodPipe`, `$ZodNullable` 等）が `output`/`input` を1段階ずつ変換する。パイプラインの入力型は左辺の `input` から、出力型は右辺の `output` から取る。この「1ステップずつの型変換」により、任意の深さのスキーマ合成でも TypeScript コンパイラが型推論を追跡できる。

- **構造的部分型 + ブランド型のハイブリッド**: TypeScript の構造的型付けを基本としつつ、`$brand` で名義的型安全を上乗せする設計。ブランド型は出力のみ（デフォルト）・入力のみ・両方の3方向をサポートし、ユニークシンボル `[$brand]` をキーに使うことでプロパティ衝突を完全に回避している（`core.ts:80-94`）。

## 実例と分析

### 型推論チェーンの伝播メカニズム

Zod の型推論の核心は `core.output<T>` と `core.input<T>` という2つの条件型ヘルパーにある。

```typescript
// packages/zod/src/v4/core/core.ts:117-120
export type input<T> = T extends { _zod: { input: any; }; } ? T["_zod"]["input"] : unknown;
export type output<T> = T extends { _zod: { output: any; }; } ? T["_zod"]["output"] : unknown;
export type { output as infer };
```

各スキーマの Internals インターフェースが `output` と `input` を宣言し、ラッパー型がそれを変換する。例えば `$ZodOptional` は内部型に `| undefined` を付加する:

```typescript
// packages/zod/src/v4/core/schemas.ts:3322-3330
export interface $ZodOptionalInternals<T extends SomeType = $ZodType>
  extends $ZodTypeInternals<core.output<T> | undefined, core.input<T> | undefined>
{
  def: $ZodOptionalDef<T>;
  optin: "optional";
  optout: "optional";
  isst: never;
  values: T["_zod"]["values"];
  pattern: T["_zod"]["pattern"];
}
```

`$ZodPipe` は左辺の `input` と右辺の `output` を組み合わせる:

```typescript
// packages/zod/src/v4/core/schemas.ts:3855-3858
export interface $ZodPipeInternals<A extends SomeType = $ZodType, B extends SomeType = $ZodType>
  extends $ZodTypeInternals<core.output<B>, core.input<A>>
{
  def: $ZodPipeDef<A, B>;
  // ...
}
```

この設計により、`z.string().optional().pipe(z.number())` のような合成で、入力型が `string | undefined`、出力型が `number` と正しく推論される。

### オブジェクト型推論 — optionality のオブジェクトレベル反映

オブジェクトスキーマの型推論は、フィールドの optionality をオブジェクトのプロパティレベルに反映する複雑な条件型で実現されている:

```typescript
// packages/zod/src/v4/core/schemas.ts:1664-1679
type OptionalOutSchema = { _zod: { optout: "optional"; }; };

export type $InferObjectOutput<T extends $ZodLooseShape, Extra extends Record<string, unknown>> =
  // ... (index signature check)
  util.Prettify<
    & {
      -readonly [k in keyof T as T[k] extends OptionalOutSchema ? never : k]: T[k]["_zod"]["output"];
    }
    & {
      -readonly [k in keyof T as T[k] extends OptionalOutSchema ? k : never]?: T[k]["_zod"]["output"];
    }
    & Extra
  >;
```

キーの分配（`as ... ? never : k`）でフィールドを required と optional に振り分け、`&` で合成する。`Prettify` で交差型をフラット化し、IDE でのホバー表示を改善している。

### ブランド型 — 方向付き名義的型安全

ブランド型は unique symbol をキーとすることでプロパティ衝突を回避し、方向パラメータで input/output のどちらにブランドを付けるか制御する:

```typescript
// packages/zod/src/v4/core/core.ts:80-94
export const $brand: unique symbol = Symbol("zod_brand");
export type $brand<T extends string | number | symbol = string | number | symbol> = {
  [$brand]: { [k in T]: true; };
};

export type $ZodBranded<
  T extends schemas.SomeType,
  Brand extends string | number | symbol,
  Dir extends "in" | "out" | "inout" = "out",
> =
  & T
  & (Dir extends "inout" ? { _zod: { input: input<T> & $brand<Brand>; output: output<T> & $brand<Brand>; }; }
    : Dir extends "in" ? { _zod: { input: input<T> & $brand<Brand>; }; }
    : { _zod: { output: output<T> & $brand<Brand>; }; });
```

デフォルトは `"out"`（出力のみブランド付き）で、`parse()` の戻り値だけがブランド型になる。入力側にはブランドが付かないため、ユーザーは生の値を渡せる。

### 再帰型 — getter によるネイティブ遅延参照

Zod v4 は `z.lazy()` に加え、JavaScript の getter を使った再帰型定義をサポートする:

```typescript
// packages/zod/src/v4/classic/tests/recursive-types.test.ts:25-37
const Category = z.object({
  name: z.string(),
  get subcategories() {
    return z.array(Category).optional().nullable();
  },
});
type Category = z.infer<typeof Category>;
// => { name: string; subcategories?: Category[] | undefined | null }
```

getter は TypeScript の型推論を破壊しないため、`z.infer` が再帰型を正しく推論できる。`z.lazy()` は型アノテーションが必要だが、getter 方式ではそれが不要になる。

### `& {}` による型の正規化

`& {}` イディオムが2つの目的で使われている:

1. **`undefined` の除去**: `T[keyof T] & {}` で enum 推論時に `undefined` を除外する
2. **型のフラット化**: `{ -readonly [P in keyof T]: T[P] } & {}` で交差型を単一のオブジェクト型に正規化する

```typescript
// packages/zod/src/v4/core/schemas.ts:3055
export type $InferEnumOutput<T extends util.EnumLike> = T[keyof T] & {};

// packages/zod/src/v4/core/util.ts:129-132
export type Prettify<T> =
  & {
    // @ts-ignore
    [K in keyof T]: T[K];
  }
  & {};
```

### `_$ZodTypeInternals` と `$ZodTypeInternals` の二重インターフェース

型安全性と実装の柔軟性を両立するため、Internals インターフェースが2層に分かれている:

```typescript
// packages/zod/src/v4/core/schemas.ts:91-168
export interface _$ZodTypeInternals {
  // output/input を含まない — ランタイム情報のみ
  def: $ZodTypeDef;
  run(payload: ParsePayload<any>, ctx: ParseContextInternal): MaybeAsync<ParsePayload>;
  // ...
}

export interface $ZodTypeInternals<out O = unknown, out I = unknown> extends _$ZodTypeInternals {
  output: O; // phantom 型
  input: I; // phantom 型
}
```

`_$ZodTypeInternals`（アンダースコア付き）は output/input を持たないため、型パラメータ不要でランタイムロジック内の型制約が緩い。配列・オブジェクト・ユニオン等の Internals は `_$ZodTypeInternals` を直接拡張し、`output`/`input` を自前で宣言する。これにより、複雑な条件型推論を `$ZodTypeInternals<O, I>` の型パラメータに押し込まず、各スキーマが独自の推論ロジックを持てる。

## コード例

```typescript
// packages/zod/src/v4/core/schemas.ts:1595-1601
// 配列の型推論チェーン: 要素型から配列型を導出
export interface $ZodArrayInternals<T extends SomeType = $ZodType> extends _$ZodTypeInternals {
  def: $ZodArrayDef<T>;
  isst: errors.$ZodIssueInvalidType;
  output: core.output<T>[];
  input: core.input<T>[];
}
```

```typescript
// packages/zod/src/v4/core/schemas.ts:2543-2557
// タプルの条件型推論: 末尾 optional 要素の検出
type TupleInputTypeWithOptionals<T extends util.TupleItems> = T extends readonly [
  ...infer Prefix extends SomeType[],
  infer Tail extends SomeType,
] ? Tail["_zod"]["optin"] extends "optional" ? [...TupleInputTypeWithOptionals<Prefix>, core.input<Tail>?]
  : TupleInputTypeNoOptionals<T>
  : [];
```

```typescript
// packages/zod/src/v4/core/schemas.ts:4075-4082
// テンプレートリテラルの再帰的型合成
type AppendToTemplateLiteral<
  Template extends string,
  Suffix extends LiteralPart | $ZodType,
> = Suffix extends LiteralPart ? `${Template}${UndefinedToEmptyString<Suffix>}`
  : Suffix extends $ZodType
    ? `${Template}${core.output<Suffix> extends infer T extends LiteralPart ? UndefinedToEmptyString<T> : never}`
  : never;
```

```typescript
// packages/zod/src/v4/core/util.ts:84-88
// 型レベル等価性テスト（Zod 独自実装）
export type AssertEqual<T, U> = (<V>() => V extends T ? 1 : 2) extends <V>() => V extends U ? 1 : 2 ? true : false;
```

## パターンカタログ

- **Phantom Type Pattern** (構造)
  - 解決する問題: ランタイムには存在しないが、型レベルで情報を伝播する必要がある
  - 適用条件: スキーマやバリデータ等、定義から型を導出するライブラリ
  - コード例: `packages/zod/src/v4/core/schemas.ts:163-168` — `$ZodTypeInternals<O, I>` の `output: O; input: I`
  - 注意点: phantom property のアクセスはランタイムエラーになるため、型レベルでのみ使用する

- **Type State Pattern** (振る舞い)
  - 解決する問題: オブジェクトの状態（optional/required）を型レベルで追跡し、合成時に反映する
  - 適用条件: スキーマのフィールドレベルの optionality をオブジェクト型に反映する場合
  - コード例: `packages/zod/src/v4/core/schemas.ts:1664-1679` — `optin`/`optout` による optional 追跡
  - 注意点: TypeScript の mapped type の `?` 修飾子とのマッピングが必要

- **Trait-based Composition** (構造)
  - 解決する問題: クラス継承の制約（単一継承）を回避して機能を合成する
  - 適用条件: 複数の振る舞いを動的に組み合わせる必要がある場合
  - コード例: `packages/zod/src/v4/core/core.ts:17-77` — `$constructor` が `traits` Set で多重継承をシミュレート
  - 注意点: `instanceof` を `Symbol.hasInstance` でオーバーライドして traits ベースの判定に変換している

## Good Patterns

- **Bidirectional Type Inference（input/output 分離）**: スキーマの input 型（バリデーション前）と output 型（バリデーション後）を分離し、`transform` や `default` でそれぞれが独立に変化する設計。`z.string().transform(Number)` は `input: string, output: number` になる。

```typescript
// packages/zod/src/v4/classic/schemas.ts:114-116
transform<NewOut>(
  transform: (arg: core.output<this>, ctx: core.$RefinementCtx<core.output<this>>) => NewOut | Promise<NewOut>
): ZodPipe<this, ZodTransform<Awaited<NewOut>, core.output<this>>>;
```

- **`(string & {})` による開放的リテラル型ユニオン**: 既知の値を列挙しつつ、任意の文字列も許容する。IDE の自動補完が効きながら拡張性も保たれる。

```typescript
// packages/zod/src/v4/core/util.ts:20-22
export type JWTAlgorithm = "HS256" | "HS384" | "HS512" | "RS256" | "RS384" | "RS512" | (string & {});
```

- **`out` variance annotation による共変性の明示**: TypeScript 4.7+ の variance annotation を使い、ジェネリクスの共変性を明示する。型チェッカーの不必要な反変性チェックを抑制し、コンパイル速度を改善する。

```typescript
// packages/zod/src/v4/core/schemas.ts:1777-1780
export interface $ZodObjectInternals<
  /** @ts-ignore Cast variance */
  out Shape extends $ZodShape = $ZodShape,
  out Config extends $ZodObjectConfig = $ZodObjectConfig,
> extends _$ZodTypeInternals {
```

## Anti-Patterns / 注意点

- **`@ts-ignore` による variance キャスト**: `out` キーワードと `@ts-ignore` を組み合わせて variance を強制している箇所がある。TypeScript コンパイラが正しくない variance を受け入れるため、型の健全性が局所的に失われるリスクがある。

```typescript
// Bad: @ts-ignore で variance チェックを無視
/** @ts-ignore Cast variance */
out Shape extends $ZodShape = $ZodShape,

// Better: 型が本当に共変であることを構造的に証明できる設計にする
// ただし、パフォーマンスと型安全のトレードオフが発生するため Zod のようなケースでは許容される判断
```

- **Phantom Property への直接アクセス**: `_zod` はランタイムオブジェクトでもあるが、`output`/`input` は phantom（ランタイムには存在しない）。内部コードで `inst._zod.output` にアクセスするとランタイムエラーの可能性がある。

```typescript
// Bad: phantom property をランタイムで参照
const type = schema._zod.output; // undefined at runtime

// Better: 型レベルでのみ使用
type Output = typeof schema["_zod"]["output"]; // compile-time only
```

## 導出ルール

- `[MUST]` 型駆動 API では input 型と output 型を分離し、変換チェーンで独立に型が変化できるようにする
  - 根拠: Zod は全スキーマで `$ZodTypeInternals<O, I>` を通じて input/output を分離し、`transform`、`pipe`、`default` 等のラッパーが片方だけを変更できる設計を実現している（`schemas.ts:163-168`）

- `[MUST]` ライブラリの型推論チェーンでは、各ステップが1段階だけ型を変換する設計にする（ステップごとに `output`/`input` を明示的に宣言）
  - 根拠: `$ZodOptional` は `output<T> | undefined` を、`$ZodPipe` は `output<B>` と `input<A>` を、それぞれ1段階だけ変換する。これにより TypeScript コンパイラが推論を追跡でき、複雑な合成でも型エラーメッセージが理解可能になる（`schemas.ts:3322-3330, 3855-3858`）

- `[SHOULD]` 公開 API では厳密な型を提供し、内部実装では `any` を許容する境界を意識的に設計する
  - 根拠: Zod は `noExplicitAny: "off"` で内部に `any` を多用しつつ、公開インターフェースでは条件型・ジェネリクスで完全な型安全を提供している。型安全のコストを API 境界に集中させることで、実装の保守性を損なわずにユーザー体験を最大化している（`biome.jsonc:24`）

- `[SHOULD]` 既知の値の列挙と任意の値を両方許容したい場合は `"known" | (string & {})` パターンを使う
  - 根拠: `JWTAlgorithm`, `MimeTypes`, `HashFormat` 等で一貫して使用され、IDE 自動補完と拡張性を両立している（`util.ts:8-22`）

- `[SHOULD]` ブランド型を導入する際は、unique symbol をキーとし、入力/出力の方向を制御可能にする
  - 根拠: Zod の `$brand` は unique symbol でプロパティ衝突を回避し、`Dir` パラメータで output-only（デフォルト）、input-only、bidirectional を選択可能にしている（`core.ts:80-94`）

- `[SHOULD]` 交差型をユーザーに表示する際は `Prettify<T>` （`{ [K in keyof T]: T[K] } & {}`）でフラット化する
  - 根拠: Zod は `$InferObjectOutput` で `Prettify` を適用し、IDE ホバー時に `A & B & C` ではなく展開されたオブジェクト型を表示する（`util.ts:129-132`）

- `[AVOID]` 型推論が依存するジェネリクスの制約を `@ts-ignore` で黙らせる運用を常態化しない
  - 根拠: Zod では `out` variance annotation と `@ts-ignore` の組み合わせが限定的に使われているが、これは型システムの限界に対する回避策であり、TypeScript の将来バージョンで改善される可能性がある。安易に `@ts-ignore` を使うと型の健全性が失われる（`schemas.ts:1778-1794`）

## 適用チェックリスト

- [ ] スキーマやバリデータを設計する際、input 型と output 型を分離しているか
- [ ] 型推論チェーンの各ステップが1段階の型変換に収まっているか（多段階の条件型を1つの型に押し込んでいないか）
- [ ] 公開 API と内部実装の型安全境界が明確に定義されているか
- [ ] 交差型が IDE でフラットに表示されるよう `Prettify` 相当の正規化を適用しているか
- [ ] ブランド型を使う場合、ユニークシンボルでキー衝突を回避しているか
- [ ] リテラル型ユニオンに `(string & {})` を追加して自動補完と拡張性を両立しているか
- [ ] 再帰型定義で getter パターンを検討したか（`z.lazy()` より型推論が優れる場合がある）
- [ ] phantom property がランタイムでアクセスされないことを保証しているか
