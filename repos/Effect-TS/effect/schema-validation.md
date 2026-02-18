# Schema Validation

> リポジトリ: Effect-TS/effect
> 分析日: 2026-02-18

## 概要

Effect Schema モジュールの宣言的バリデーション、型導出、AST ベース変換パターンを分析する。
Effect Schema は「スキーマを一度定義すれば、バリデーション・エンコーディング/デコーディング・JSON Schema 生成・任意値生成・Pretty Print・等価性判定をすべて導出できる」という設計を採用している。
その中核にある AST（抽象構文木）ベースのスキーマ表現は、バリデーションライブラリの設計における高度なプラクティスを体系的に示しており、他のドメインにも応用可能な汎用パターンが豊富に含まれている。

## 背景にある原則

- **Schema = AST + 型パラメータの三つ組**: スキーマを `Schema<Type, Encoded, Context>` の三つ組として表現することで、入力（Encoded）と出力（Type）の型を分離し、双方向変換を型安全に表現できる。これにより「バリデーション」と「変換」を同一の抽象で統一している。根拠: `Schema.ts:84-94` の `Schema` インターフェース定義。

- **AST を単一の真実の源泉とする**: スキーマの意味的情報を AST ノードに集約し、バリデータ・JSON Schema 生成器・Pretty Printer・Arbitrary 生成器といった複数の「インタプリタ」が同一の AST を走査する。新機能を追加する際にスキーマ定義を変更する必要がない。根拠: `Pretty.ts:52` の `match` オブジェクト、`Arbitrary.ts:384` の `getDescription`、`JSONSchema.ts:638` の `go` 関数がすべて `SchemaAST.AST` を入力とする。

- **合成可能性を最優先する**: `pipe`、`filter`、`transform`、`compose`、`extend` といったコンビネータにより、小さなスキーマを組み合わせて複雑なスキーマを構築する。各コンビネータは型レベルでも合成され、推論結果がユーザーに見える形で伝播する。根拠: `Schema.ts:3506-3512` の `extend`、`Schema.ts:3518-3560` の `compose`。

- **アノテーションによる関心の分離**: バリデーションロジック（AST ノード）とメタデータ（タイトル、説明、JSON Schema ヒント、カスタムエラーメッセージなど）をアノテーションという拡張可能な仕組みで分離する。各インタプリタは必要なアノテーションだけを参照する。根拠: `SchemaAST.ts:318-344` の `Annotations` インターフェースと `getAnnotation` 関数。

## 実例と分析

### AST ノードの tagged union 設計

AST は 17 種類のノード型を `_tag` フィールドで識別する tagged union として定義されている。これにより `switch` 文による網羅的パターンマッチが可能になり、新しいインタプリタの追加が容易になる。

```typescript
// SchemaAST.ts:25-49
export type AST =
  | Declaration
  | Literal
  | UniqueSymbol
  | UndefinedKeyword
  | VoidKeyword
  | NeverKeyword
  | UnknownKeyword
  | AnyKeyword
  | StringKeyword
  | NumberKeyword
  | BooleanKeyword
  | BigIntKeyword
  | SymbolKeyword
  | ObjectKeyword
  | Enums
  | TemplateLiteral
  // possible transformations
  | Refinement
  | TupleType
  | TypeLiteral
  | Union
  | Suspend
  // transformations
  | Transformation;
```

`SchemaAST.ts:2629-2639` で `Match` 型と `getCompiler` 関数が提供され、各 AST タグに対するハンドラを定義するだけで新しいインタプリタを構築できる。

```typescript
// SchemaAST.ts:2629-2639
export type Match<A> = {
  [K in AST["_tag"]]: (ast: Extract<AST, { _tag: K; }>, compile: Compiler<A>, path: ReadonlyArray<PropertyKey>) => A;
};

export const getCompiler = <A>(match: Match<A>): Compiler<A> => {
  const compile = (ast: AST, path: ReadonlyArray<PropertyKey>): A => match[ast._tag](ast as any, compile, path);
  return compile;
};
```

Pretty モジュールはこの `Match` を使って5行でコンパイラを取得している。

```typescript
// Pretty.ts:52, 205
export const match: AST.Match<Pretty<any>> = { ... }
const compile = AST.getCompiler(match)
```

### Refinement と Transformation の分離

AST には「Refinement（型を絞り込む）」と「Transformation（型を変換する）」が明確に区別されている。Refinement は入力型を変えずに制約を追加し、Transformation は入力型と出力型を異なる型に変換する。

```typescript
// SchemaAST.ts:1805-1818
export class Refinement<From extends AST = AST> implements Annotated {
  readonly _tag = "Refinement";
  constructor(
    readonly from: From,
    readonly filter: (
      input: any,
      options: ParseOptions,
      self: Refinement,
    ) => Option.Option<ParseIssue>,
    readonly annotations: Annotations = {},
  ) {}
}

// SchemaAST.ts:1927-1937
export class Transformation implements Annotated {
  readonly _tag = "Transformation";
  constructor(
    readonly from: AST,
    readonly to: AST,
    readonly transformation: TransformationKind,
    readonly annotations: Annotations = {},
  ) {}
}
```

この分離により、`encodedSchema` や `typeSchema` のような AST 走査関数が Refinement を保持しつつ Transformation を除去する、といった操作が可能になる。

### フィルタの宣言的構築パターン

組み込みフィルタ（`minLength`、`maxLength`、`greaterThan` など）は、`filter` コンビネータにアノテーション（`schemaId`、`title`、`description`、`jsonSchema`）を付与するパターンで統一されている。

```typescript
// Schema.ts:4291-4305
export const maxLength =
  <S extends Schema.Any>(maxLength: number, annotations?: Annotations.Filter<Schema.Type<S>>) =>
  <A extends string>(self: S & Schema<A, Schema.Encoded<S>, Schema.Context<S>>): filter<S> =>
    self.pipe(
      filter(
        (a) => a.length <= maxLength,
        {
          schemaId: MaxLengthSchemaId,
          title: `maxLength(${maxLength})`,
          description: `a string at most ${maxLength} character(s) long`,
          jsonSchema: { maxLength },
          ...annotations,
        },
      ),
    );
```

このパターンにより、バリデーション述語とメタデータ（JSON Schema プロパティ、エラーメッセージ）を一箇所で定義でき、複数のインタプリタが一貫した情報を利用できる。

### 同期/非同期の透過的切り替え（Either 短絡最適化）

`ParseResult` モジュールは、同期パスでは `Either` を使い、非同期パスでのみ `Effect` に切り替える最適化を行っている。`flatMap`、`map`、`mapError` などの演算子が `isEither` でディスパッチし、同期処理の場合は Effect ランタイムのオーバーヘッドを回避する。

```typescript
// ParseResult.ts:308-323
export const flatMap = dual(2, <A, E, R, B, E1, R1>(
  self: Effect.Effect<A, E, R>,
  f: (a: A) => Effect.Effect<B, E1, R1>,
): Effect.Effect<B, E | E1, R | R1> => {
  return isEither(self)
    ? Either.match(self, { onLeft: Either.left, onRight: f })
    : Effect.flatMap(self, f);
});
```

### パーサーのメモ化

`ParseResult.ts:743-770` では、AST ノードをキーとする `WeakMap` でパーサーをメモ化している。同一の AST ノードに対するパーサー生成は一度だけ行われ、再利用される。

```typescript
// ParseResult.ts:743-770
const decodeMemoMap = globalValue(
  Symbol.for("effect/ParseResult/decodeMemoMap"),
  () => new WeakMap<AST.AST, Parser>(),
);
const encodeMemoMap = globalValue(
  Symbol.for("effect/ParseResult/encodeMemoMap"),
  () => new WeakMap<AST.AST, Parser>(),
);

const goMemo = (ast: AST.AST, isDecoding: boolean): Parser => {
  const memoMap = isDecoding ? decodeMemoMap : encodeMemoMap;
  const memo = memoMap.get(ast);
  if (memo) {
    return memo;
  }
  const raw = go(ast, isDecoding);
  // ...
  memoMap.set(ast, parser);
  return parser;
};
```

### AST 走査での構造共有（changeMap）

AST の再帰的変換で、変更がなかった場合は元の配列をそのまま返す `changeMap` を使い、不要なオブジェクト生成を回避している。

```typescript
// SchemaAST.ts:2739-2751
function changeMap<A>(as: ReadonlyArray<A>, f: (a: A) => A): ReadonlyArray<A> {
  let changed = false;
  const out = Arr.allocate(as.length) as Array<A>;
  for (let i = 0; i < as.length; i++) {
    const a = as[i];
    const fa = f(a);
    if (fa !== a) {
      changed = true;
    }
    out[i] = fa;
  }
  return changed ? out : as;
}
```

### 構造化エラーモデル

`ParseResult.ts` のエラー型は、葉ノード（`Type`、`Missing`、`Unexpected`、`Forbidden`）と複合ノード（`Pointer`、`Refinement`、`Transformation`、`Composite`）の tagged union で、エラーツリーを構成する。これにより TreeFormatter と ArrayFormatter という2つのフォーマッタが同じエラーツリーから異なる表現を生成できる。

```typescript
// ParseResult.ts:29-39
export type ParseIssue =
  // leaf
  | Type
  | Missing
  | Unexpected
  | Forbidden
  // composite
  | Pointer
  | Refinement
  | Transformation
  | Composite;
```

## パターンカタログ

- **Interpreter パターン** (分類: 振る舞い)
  - 解決する問題: 同一のデータ構造（AST）から複数の異なる処理（バリデーション、JSON Schema、Pretty Print、Arbitrary 生成）を導出する
  - 適用条件: 単一のデータ定義から複数の成果物を生成する必要がある場合
  - コード例: `Pretty.ts:52`（`match` オブジェクト）、`Arbitrary.ts:774`（`go` 関数）、`JSONSchema.ts:638`（`go` 関数）、`ParseResult.ts:778`（`go` 関数）
  - 注意点: AST ノードの追加時にすべてのインタプリタの更新が必要（`Match` 型がコンパイル時に強制する）

- **Composite パターン** (分類: 構造)
  - 解決する問題: 再帰的なスキーマ構造（ネストされた Struct、Array、Union）を統一的に扱う
  - 適用条件: ツリー構造のデータを再帰的に処理する場合
  - コード例: `SchemaAST.ts:25-49`（AST union 型）、`Suspend` ノードによる再帰スキーマ
  - 注意点: 無限再帰を防ぐために `Suspend`（遅延評価）が必須

- **Builder パターン** (分類: 生成)
  - 解決する問題: 複雑なスキーマを段階的に構築する
  - 適用条件: 多数のオプショナルな設定・制約を持つオブジェクトを構築する場合
  - コード例: `Schema.ts` の `pipe` + `filter` + `brand` の組み合わせ
  - 注意点: 型推論のチェーンが深くなりすぎると TypeScript のコンパイル時間に影響する

## Good Patterns

- **アノテーションによるインタプリタ拡張**: 各 AST ノードにアノテーション（`Symbol` キーのマップ）を付与し、インタプリタがアノテーションを参照して振る舞いを変える。これによりコア AST を変更せずにインタプリタ固有の情報を追加できる。`SchemaAST.ts:318-329` の `Annotations` / `Annotated` インターフェース。

```typescript
// SchemaAST.ts:335-344
export const getAnnotation: {
  <A>(key: symbol): (annotated: Annotated) => Option.Option<A>;
  <A>(annotated: Annotated, key: symbol): Option.Option<A>;
} = dual(
  2,
  <A>(annotated: Annotated, key: symbol): Option.Option<A> =>
    Object.prototype.hasOwnProperty.call(annotated.annotations, key)
      ? Option.some(annotated.annotations[key] as any)
      : Option.none(),
);
```

- **フィルタにメタデータを同梱する**: バリデーション述語だけでなく、`schemaId`、`title`、`description`、`jsonSchema` を一緒に定義することで、JSON Schema 生成やエラーメッセージ生成が自動的に正しく動作する。

```typescript
// Schema.ts:5012-5025
export const greaterThan = <S extends Schema.Any>(
  exclusiveMinimum: number,
  annotations?: Annotations.Filter<Schema.Type<S>>,
) =>
<A extends number>(self: S & Schema<A, Schema.Encoded<S>, Schema.Context<S>>): filter<S> =>
  self.pipe(
    filter((a) => a > exclusiveMinimum, {
      schemaId: GreaterThanSchemaId,
      title: `greaterThan(${exclusiveMinimum})`,
      description: exclusiveMinimum === 0
        ? "a positive number"
        : `a number greater than ${exclusiveMinimum}`,
      jsonSchema: { exclusiveMinimum },
      ...annotations,
    }),
  );
```

- **api interface パターンによる型安全なメソッドチェーン**: 各コンビネータの戻り値に専用の interface（`@category api interface`）を定義し、`.annotations()` 等のメソッドが正しい型を返すようにしている。

```typescript
// Schema.ts:670-677
export interface Literal<Literals extends array_.NonEmptyReadonlyArray<AST.LiteralValue>>
  extends AnnotableClass<Literal<Literals>, Literals[number]>
{
  readonly literals: Readonly<Literals>;
}
```

## Anti-Patterns / 注意点

- **バリデーション述語とメタデータの分離**: フィルタを定義する際に述語だけを書いてアノテーションを省略すると、JSON Schema 生成やエラーメッセージが汎用的なフォールバックになり、ユーザー体験が低下する。

```typescript
// Bad: アノテーションなしのフィルタ
const Positive = Schema.Number.pipe(
  Schema.filter((n) => n > 0),
);
// JSON Schema: 制約情報なし、エラーメッセージ: 汎用的な "Expected ..." メッセージ

// Better: アノテーション付きのフィルタ
const Positive = Schema.Number.pipe(
  Schema.filter((n) => n > 0, {
    schemaId: Symbol.for("Positive"),
    title: "Positive",
    description: "a positive number",
    jsonSchema: { exclusiveMinimum: 0 },
    message: () => "Expected a positive number",
  }),
);
```

- **同期インタプリタで非同期スキーマを実行**: `decodeUnknownSync` を非同期コンポーネント（Effect ベースのフィルタなど）を含むスキーマに対して使うと `Forbidden` エラーが発生する。Effect ベースのバリデーションを使う場合は `decodeUnknown`（Effect 版）を使用する。

```typescript
// Bad: filterEffect を含むスキーマを sync で実行
const schema = Schema.String.pipe(
  Schema.filterEffect((s) => Effect.succeed(s.length > 0)),
);
Schema.decodeUnknownSync(schema)("test"); // Forbidden エラー

// Better: Effect 版を使用
const result = await Effect.runPromise(
  Schema.decodeUnknown(schema)("test"),
);
```

## 導出ルール

- `[MUST]` スキーマやバリデーションルールを定義する際は、バリデーション述語とメタデータ（エラーメッセージ、JSON Schema ヒント、説明文）を同じ定義に同梱する
  - 根拠: Effect Schema の全組み込みフィルタ（`minLength`、`greaterThan` 等）は `schemaId`、`title`、`description`、`jsonSchema` を述語と一緒に定義しており、これにより JSON Schema 生成やエラーメッセージが自動的に正確になる（`Schema.ts:4291-4305`）

- `[MUST]` 構造化エラーは tagged union のツリーとして表現し、複数のフォーマッタ（人間向け、機械向け）で変換可能にする
  - 根拠: `ParseResult.ts:29-39` の `ParseIssue` が葉ノード/複合ノードの tagged union で、`TreeFormatter`（人間向け）と `ArrayFormatter`（API レスポンス向け）が同一ツリーから異なる出力を生成している

- `[SHOULD]` 単一のデータ定義から複数の成果物を導出する場合は、中間表現（AST/IR）を定義し、各成果物を AST のインタプリタとして実装する
  - 根拠: Effect Schema は `SchemaAST.AST` を中間表現とし、Parser・JSONSchema・Pretty・Arbitrary・Equivalence を独立したインタプリタとして実装している。`SchemaAST.ts:2629-2639` の `Match`/`getCompiler` がインタプリタ追加を型安全に支援する

- `[SHOULD]` AST の再帰的走査で構造共有（structural sharing）を使い、変更がないサブツリーのオブジェクト生成を回避する
  - 根拠: `SchemaAST.ts:2739-2751` の `changeMap` は変更がなければ元の配列を返し、不要な GC 負荷を削減する

- `[SHOULD]` 同期処理と非同期処理が混在するパイプラインでは、同期パスを `Either` で短絡し、非同期パスでのみランタイムのオーバーヘッドを払う
  - 根拠: `ParseResult.ts:308-323` の `flatMap` が `isEither` で同期/非同期を判別し、同期パスでは Effect ランタイムを迂回する最適化を実装している

- `[SHOULD]` コンパイル済みのインタプリタ（パーサー等）は AST ノードをキーとして `WeakMap` でメモ化し、同一定義の再コンパイルを防ぐ
  - 根拠: `ParseResult.ts:743-770` の `decodeMemoMap`/`encodeMemoMap` が `WeakMap<AST, Parser>` でパーサーをキャッシュしている

- `[AVOID]` バリデーションと型変換を同一のプリミティブで混同する。型を絞り込む操作（Refinement）と型を変換する操作（Transformation）は AST レベルで分離すべき
  - 根拠: `SchemaAST.ts` では `Refinement`（`from` のみ保持、型は不変）と `Transformation`（`from` + `to` を保持、型が変化）を別のノードとして定義し、`typeAST`/`encodedAST` による走査で異なる扱いを可能にしている

## 適用チェックリスト

- [ ] バリデーションルール定義にメタデータ（エラーメッセージ、説明文、シリアライズヒント）を同梱しているか
- [ ] エラー型が構造化されており、複数のフォーマッタで異なる表現に変換可能か
- [ ] 単一のスキーマ定義から複数の成果物（バリデータ、型定義、ドキュメント、テストデータ）を導出しているか
- [ ] AST を走査するインタプリタを追加する際、型レベルで全ノードの網羅が強制されているか
- [ ] 再帰的データ構造の走査で構造共有を使い、不要なオブジェクト生成を回避しているか
- [ ] 同期/非同期が混在するバリデーションパイプラインで、同期パスの最適化が行われているか
- [ ] パーサーやコンパイル結果がメモ化され、同一スキーマに対する重複コンパイルが防がれているか
- [ ] Refinement（型の絞り込み）と Transformation（型の変換）が概念レベルで分離されているか
