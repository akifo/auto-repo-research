# Pattern: AST Interpreter

> 出典: [repos/Effect-TS/effect](../repos/Effect-TS/effect/) からの知見
> カテゴリ: pattern

## 概要

AST を tagged union で定義し、`Match<A>` 型で全ノードに対するハンドラを強制する拡張可能インタプリタパターン。新しいインタプリタ（コンパイラ）を `Match` オブジェクトの定義と `getCompiler` の1行呼び出しだけで追加でき、AST ノード追加時にはコンパイル時に全インタプリタの網羅性が保証される。Effect Schema はこのパターンで Parser・JSON Schema 生成・Pretty Print・テストデータ生成・等価性判定の5つのインタプリタを同一の AST から導出している。

## 背景・文脈

Effect Schema は「スキーマを一度定義すれば、バリデーション・エンコーディング/デコーディング・JSON Schema 生成・任意値生成・Pretty Print・等価性判定をすべて導出できる」という設計を採用している。この設計の中核にあるのが AST（抽象構文木）ベースのインタプリタパターンである。

従来の手法では、各成果物の生成ロジックに `switch` 文を書き、AST ノードを手動で分岐していた。この方式では新しいノードを追加したとき、全ての `switch` 文を更新する必要があるが、更新漏れをコンパイル時に検出できない。Effect Schema は `Match<A>` というマップ型で全ノードのハンドラを要求することで、この問題を型レベルで解決している。

この手法は Visitor パターンの TypeScript 的な表現であり、オブジェクト指向の `accept`/`visit` メソッドではなく、tagged union + マップ型による関数型アプローチを採用している点が特徴である。

## 実装パターン

### 1. AST の tagged union 定義

AST は `_tag` フィールドで識別される 22 種類のノードの union として定義される。各ノードは `_tag` リテラル型を持つクラスで、TypeScript の discriminated union として扱える。

```typescript
// packages/effect/src/SchemaAST.ts:25-49
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
  | Refinement
  | TupleType
  | TypeLiteral
  | Union
  | Suspend
  | Transformation
```

### 2. Match 型と getCompiler 関数

`Match<A>` はマップ型で、AST の全 `_tag` に対応するハンドラ関数を要求する。ハンドラが1つでも欠けるとコンパイルエラーになるため、網羅性が型レベルで保証される。

```typescript
// SchemaAST.ts:2629-2639
export type Match<A> = {
  [K in AST["_tag"]]: (
    ast: Extract<AST, { _tag: K }>,
    compile: Compiler<A>,
    path: ReadonlyArray<PropertyKey>
  ) => A
}

export const getCompiler = <A>(match: Match<A>): Compiler<A> => {
  const compile = (ast: AST, path: ReadonlyArray<PropertyKey>): A =>
    match[ast._tag](ast as any, compile, path)
  return compile
}
```

`getCompiler` は `match` オブジェクトを受け取り、再帰的にAST を走査する `compile` 関数を返す。`compile` が第2引数として各ハンドラに渡されるため、子ノードの再帰的処理が可能になる。

### 3. インタプリタの実装例

5つのインタプリタが同一の AST を走査し、それぞれ異なる成果物を生成する。

| インタプリタ | 出力型 | ファイル |
|---|---|---|
| Parser | バリデーション結果 | `ParseResult.ts:778` |
| JSONSchema | JSON Schema オブジェクト | `JSONSchema.ts:638` |
| Pretty | Pretty Print 関数 | `Pretty.ts:52` |
| Arbitrary | テストデータ生成器 | `Arbitrary.ts:774` |
| Equivalence | 等価性判定関数 | `Equivalence.ts` |

Pretty Printer の例:

```typescript
// packages/effect/src/Pretty.ts:52, 205
export const match: AST.Match<Pretty<any>> = {
  Declaration: (ast, compile) => ...,
  Literal: (ast) => ...,
  StringKeyword: () => (s) => JSON.stringify(s),
  NumberKeyword: () => (n) => String(n),
  BooleanKeyword: () => (b) => String(b),
  // ... 全22ノードにハンドラが必須（1つでも欠けると型エラー）
}
const compile = AST.getCompiler(match)
```

### 4. Refinement と Transformation の分離

AST には「型を絞り込む」Refinement と「型を変換する」Transformation が明確に区別されたノードとして存在する。この分離により、`encodedSchema` のような走査関数が Refinement を保持しつつ Transformation を除去する、といった選択的な処理が可能になる。

```typescript
// SchemaAST.ts:1805-1818
// Refinement: 入力型は不変、制約だけを追加する
export class Refinement<From extends AST = AST> {
  readonly _tag = "Refinement"
  constructor(
    readonly from: From,
    readonly filter: (input: any, options: ParseOptions, self: Refinement) =>
      Option.Option<ParseIssue>,
    readonly annotations: Annotations = {}
  ) {}
}

// SchemaAST.ts:1927-1937
// Transformation: 入力型と出力型が異なる
export class Transformation {
  readonly _tag = "Transformation"
  constructor(
    readonly from: AST,
    readonly to: AST,
    readonly transformation: TransformationKind,
    readonly annotations: Annotations = {}
  ) {}
}
```

### 5. アノテーションによるメタデータ拡張

各 AST ノードは `Annotated` インターフェースを実装し、Symbol キーのマップでメタデータを保持する。インタプリタはアノテーションを参照して振る舞いを変えることができ、コア AST を変更せずにインタプリタ固有の情報を追加できる。

```typescript
// SchemaAST.ts:335-344
export const getAnnotation: {
  <A>(key: symbol): (annotated: Annotated) => Option.Option<A>
  <A>(annotated: Annotated, key: symbol): Option.Option<A>
} = dual(2, ...)
```

### 6. パフォーマンス最適化

**WeakMap メモ化**: 同一の AST ノードに対するインタプリタ生成は一度だけ行われ、WeakMap でキャッシュされる。AST ノードが GC されるとキャッシュも自動的に解放される。

```typescript
// ParseResult.ts:743-770
const decodeMemoMap = globalValue(
  Symbol.for("effect/ParseResult/decodeMemoMap"),
  () => new WeakMap<AST.AST, Parser>()
)
```

**構造共有 (changeMap)**: AST の再帰的変換で、変更がないサブツリーは元の配列をそのまま返し、不要なオブジェクト生成を回避する。

```typescript
// SchemaAST.ts:2739-2751
function changeMap<A>(as: ReadonlyArray<A>, f: (a: A) => A): ReadonlyArray<A> {
  let changed = false
  const out = Arr.allocate(as.length) as Array<A>
  for (let i = 0; i < as.length; i++) {
    const a = as[i]
    const fa = f(a)
    if (fa !== a) { changed = true }
    out[i] = fa
  }
  return changed ? out : as
}
```

## Good Example

```typescript
// Match 型で全ノードのハンドラを強制するインタプリタ定義
const jsonSchemaMatch: AST.Match<JSONSchema> = {
  Declaration: (ast, compile) => {
    const annotation = ast.annotations[JSONSchemaAnnotationId]
    if (annotation) return annotation as JSONSchema
    throw new Error("Missing JSONSchema annotation for Declaration")
  },
  Literal: (ast) => {
    if (typeof ast.literal === "string") return { const: ast.literal }
    if (typeof ast.literal === "number") return { const: ast.literal }
    if (typeof ast.literal === "boolean") return { const: ast.literal }
    return {} // null
  },
  StringKeyword: () => ({ type: "string" }),
  NumberKeyword: () => ({ type: "number" }),
  BooleanKeyword: () => ({ type: "boolean" }),
  TupleType: (ast, compile) => ({
    type: "array",
    items: ast.elements.map((e) => compile(e.type, [])),
  }),
  TypeLiteral: (ast, compile) => ({
    type: "object",
    properties: Object.fromEntries(
      ast.propertySignatures.map((ps) => [ps.name, compile(ps.type, [])])
    ),
  }),
  Union: (ast, compile) => ({
    anyOf: ast.types.map((t) => compile(t, [])),
  }),
  Refinement: (ast, compile) => compile(ast.from, []),
  Transformation: (ast, compile) => compile(ast.from, []),
  // ... 残りのノードも全て定義が必須
  //     1つでも欠けるとコンパイルエラー
}

// 5行でインタプリタ(コンパイラ)を取得
const compileJSONSchema = AST.getCompiler(jsonSchemaMatch)

// 使用例: スキーマの AST から JSON Schema を生成
const schema = Schema.Struct({ name: Schema.String, age: Schema.Number })
const jsonSchema = compileJSONSchema(schema.ast, [])
```

## Bad Example

```typescript
// Bad: switch 文で分岐（新ノード追加時に全箇所に波及、コンパイル時チェックなし）
function toJSON(ast: AST): JSONSchema {
  switch (ast._tag) {
    case "StringKeyword": return { type: "string" }
    case "NumberKeyword": return { type: "number" }
    case "BooleanKeyword": return { type: "boolean" }
    case "TypeLiteral": return {
      type: "object",
      properties: Object.fromEntries(
        ast.propertySignatures.map((ps) => [ps.name, toJSON(ps.type)])
      ),
    }
    // 新しいノード（例: TemplateLiteral）を追加しても
    // ここにケースを追加し忘れてもコンパイルエラーにならない
    default: return {}
  }
}

// Bad: 各インタプリタが独自の再帰走査ロジックを持つ
function toPretty(ast: AST): string {
  switch (ast._tag) {
    case "StringKeyword": return "string"
    // ... 同じ分岐構造を毎回書き直す
    // toJSON と toPretty で走査ロジックが重複する
  }
}
```

`switch` 方式の問題点:

1. **網羅性が保証されない**: `default` ケースがあると、新ノード追加時にサイレントにフォールスルーする
2. **走査ロジックの重複**: 各インタプリタが独自に再帰走査を実装するため、バグの温床になる
3. **子ノードの再帰呼び出しが暗黙的**: `compile` 関数が引数として渡されないため、再帰の構造が統一されない

## 適用ガイド

### どのような状況で使うべきか

- **単一のデータ定義から複数の成果物を生成する場合**: バリデータ、シリアライザ、ドキュメント、テストデータなど、同じ構造体から異なる出力を導出するシステム
- **DSL 設計**: カスタム DSL のコンパイラ、フォームビルダー、クエリビルダーなど、宣言的な定義から実行可能なコードを生成する場合
- **プラグイン可能な処理パイプライン**: AST 走査のロジックを統一し、新しい処理を型安全に追加したい場合

### 導入時の注意点

1. **AST ノード追加の影響範囲**: 新しい AST ノードを追加すると全てのインタプリタの更新が必要になる。`Match<A>` 型がコンパイル時にこれを強制するのは利点だが、ノード数 x インタプリタ数の更新コストは意識すべき
2. **Refinement と Transformation の区別**: 型を絞り込む操作と型を変換する操作を AST レベルで分離することで、インタプリタごとに適切な処理を選択できる
3. **アノテーションの活用**: コア AST にメタデータを直接追加するのではなく、アノテーション（Symbol キーのマップ）を使うことで、インタプリタ固有の情報を疎結合に追加できる
4. **パフォーマンス**: WeakMap メモ化で同一ノードの再コンパイルを防ぎ、構造共有（`changeMap`）で再帰的走査時の不要なオブジェクト生成を回避する

### カスタマイズポイント

- **`Match<A>` の型パラメータ `A`**: インタプリタの出力型を自由に選択できる。`Pretty<any>`（関数）、`JSONSchema`（オブジェクト）、`Parser`（Effect）など
- **`compile` コールバック**: 各ハンドラの第2引数として再帰コンパイラが渡されるため、子ノードの処理方法をハンドラ側で制御できる
- **`path` 引数**: 現在の走査パスが渡されるため、エラーメッセージやデバッグ情報にコンテキストを含められる
- **アノテーションによる振る舞いのオーバーライド**: 特定のノードに対してインタプリタのデフォルト動作を上書きするカスタムアノテーションを定義できる

## 参考

- [repos/Effect-TS/effect/schema-validation.md](../repos/Effect-TS/effect/schema-validation.md) — AST ベースのスキーマバリデーション、インタプリタパターン、パフォーマンス最適化の包括的分析
