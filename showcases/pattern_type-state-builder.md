# Pattern: Type-State Builder

> 出典: [repos/trpc/trpc](../repos/trpc/trpc/) からの知見
> カテゴリ: pattern

## 概要

型パラメータをセンチネル型（`UnsetMarker`）で初期化し、メソッド呼び出しごとに該当パラメータだけを更新することで、ビルダーの「現在の構成状態」を型レベルで追跡する設計パターン。未設定状態の検出には条件付き型（`DefaultValue`, `IntersectIfDefined`）を使い、不正な操作には `TypeError<TMessage>` phantom 型で人間が読めるコンパイルエラーを返す。fluent builder API に型安全な状態マシンの意味論を与え、設定忘れ・順序違反・型不整合をすべてコンパイル時に検出できる。

## 背景・文脈

tRPC の `ProcedureBuilder` は、`.input()`, `.output()`, `.use()`, `.query()` などのメソッドチェーンでプロシージャを段階的に構築する fluent builder API を提供する。このビルダーは8つの型パラメータ（`TContext`, `TMeta`, `TContextOverrides`, `TInputIn`, `TInputOut`, `TOutputIn`, `TOutputOut`, `TCaller`）を持ち、各メソッド呼び出しが特定のパラメータのみを更新し、他は保持する。

このパターンの核心は3つの要素にある:

1. **センチネル型 `UnsetMarker`**: 「まだ設定されていない」状態をブランド型で表現する
2. **条件付き型 `DefaultValue` / `IntersectIfDefined`**: `UnsetMarker` を検知してフォールバック処理を型レベルで分岐する
3. **`TypeError<TMessage>` phantom 型**: 不正操作を `never` ではなく人間が読めるエラーメッセージで拒否する

この設計は tRPC 固有のものではなく、ORM のクエリビルダー、CLI 引数パーサ、設定オブジェクトの段階的構築など、fluent builder API を型安全に設計するあらゆる場面に適用できる。

## 実装パターン

### 1. センチネル型による未設定状態の表現

ブランド付き文字列型で「未設定」を表現する。通常の `undefined` や `unknown` ではなく専用のマーカー型を使うことで、「ユーザーが意図的に `undefined` を設定した」ケースと「まだ何も設定していない」ケースを型レベルで区別できる。

```typescript
// packages/server/src/unstable-core-do-not-import/utils.ts:1-4
export type UnsetMarker = "unsetMarker" & { __brand: "unsetMarker"; };
```

### 2. 条件付き型による状態分岐

`UnsetMarker` を検知し、未設定時はフォールバック値を、設定済み時は実際の値を返す。`IntersectIfDefined` は2つの型のうち片方が未設定ならもう片方を、両方設定済みなら交差型を返す。

```typescript
// packages/server/src/unstable-core-do-not-import/procedureBuilder.ts:37-45
type IntersectIfDefined<TType, TWith> = TType extends UnsetMarker ? TWith
  : TWith extends UnsetMarker ? TType
  : Simplify<TType & TWith>;

type DefaultValue<TValue, TFallback> = TValue extends UnsetMarker ? TFallback
  : TValue;
```

### 3. ビルダーの初期化とメソッドごとの状態遷移

`createBuilder` で未設定パラメータを `UnsetMarker` に初期化する。`.input()` を呼ぶと `TInputIn` と `TInputOut` だけが更新され、他の6パラメータは変更されない。

```typescript
// packages/server/src/unstable-core-do-not-import/procedureBuilder.ts:486-496
export function createBuilder<TContext, TMeta>(
  initDef: Partial<AnyProcedureBuilderDef> = {},
): ProcedureBuilder<
  TContext,
  TMeta,
  object, // TContextOverrides: 初期状態は空
  UnsetMarker, // TInputIn: 未設定
  UnsetMarker, // TInputOut: 未設定
  UnsetMarker, // TOutputIn: 未設定
  UnsetMarker, // TOutputOut: 未設定
  false // TCaller: デフォルト無効
>;
```

```typescript
// packages/server/src/unstable-core-do-not-import/procedureBuilder.ts:201-222
input<$Parser extends Parser>(
  schema: ...,
): ProcedureBuilder<
  TContext,         // 変更なし
  TMeta,            // 変更なし
  TContextOverrides,// 変更なし
  IntersectIfDefined<TInputIn, inferParser<$Parser>['in']>,   // 更新
  IntersectIfDefined<TInputOut, inferParser<$Parser>['out']>, // 更新
  TOutputIn,        // 変更なし
  TOutputOut,       // 変更なし
  TCaller           // 変更なし
>;
```

### 4. TypeError phantom 型による型レベルエラーメッセージ

`never` の代わりに `string & { _: symbol }` の交差型でエラーメッセージを型に埋め込む。IDE のホバーで「Context mismatch」のような具体的なメッセージが表示される。

```typescript
// packages/server/src/unstable-core-do-not-import/types.ts:170-174
const _errorSymbol = Symbol();
export type ErrorSymbol = typeof _errorSymbol;
export type TypeError<TMessage extends string> = TMessage & {
  _: typeof _errorSymbol;
};
```

使用例: ビルダー合成時のコンテキスト不整合検出。

```typescript
// packages/server/src/unstable-core-do-not-import/procedureBuilder.ts:334-347
concat<$Context, $Meta, ...>(
  builder: Overwrite<TContext, TContextOverrides> extends $Context
    ? TMeta extends $Meta
      ? ProcedureBuilder<$Context, $Meta, ...>
      : TypeError<'Meta mismatch'>
    : TypeError<'Context mismatch'>,
): ...
```

### 5. 条件付き戻り値型による API の多態性

型パラメータの状態に応じて戻り値型を切り替える。`.query()` は `TCaller` が `true` なら直接呼び出し可能な関数を、`false` ならプロシージャオブジェクトを返す。

```typescript
// packages/server/src/unstable-core-do-not-import/procedureBuilder.ts:362-379
query<$Output>(
  resolver: ProcedureResolver<...>,
): TCaller extends true
  ? (input: DefaultValue<TInputIn, void>) => Promise<DefaultValue<TOutputOut, $Output>>
  : QueryProcedure<{
      input: DefaultValue<TInputIn, void>;
      output: DefaultValue<TOutputOut, $Output>;
    }>;
```

`DefaultValue<TInputIn, void>` により、`.input()` 未呼び出しなら引数は `void`（省略可能）、呼び出し済みなら指定した型になる。

## Good Example

型パラメータ状態マシンによる fluent builder の汎用実装例。

```typescript
// --- 1. センチネル型とユーティリティ型 ---
type UnsetMarker = "unset" & { __brand: "unset"; };

type DefaultValue<TValue, TFallback> = TValue extends UnsetMarker ? TFallback
  : TValue;

type TypeError<TMessage extends string> = TMessage & { __error: true; };

// --- 2. ビルダーインターフェース ---
interface RequestBuilder<
  TUrl extends string | UnsetMarker,
  TBody,
  THeaders extends Record<string, string>,
> {
  url<U extends string>(url: U): RequestBuilder<U, TBody, THeaders>;

  body<B>(data: B): RequestBuilder<TUrl, B, THeaders>;

  header<K extends string, V extends string>(
    key: K,
    value: V,
  ): RequestBuilder<TUrl, TBody, THeaders & Record<K, V>>;

  // URL 未設定なら TypeError で拒否
  send(): TUrl extends UnsetMarker ? TypeError<"URL must be set before calling send()">
    : Promise<Response>;
}

// --- 3. 初期化は UnsetMarker で ---
function createRequest(): RequestBuilder<UnsetMarker, undefined, {}> {
  // 実装省略 -- 型の観点に集中
}

// --- 4. 使用例 ---
const req = createRequest()
  .url("https://api.example.com/users")
  .header("Authorization", "Bearer token")
  .body({ name: "Alice" });

await req.send(); // OK: URL が設定済み

const bad = createRequest()
  .body({ name: "Alice" });

// bad.send() は TypeError<'URL must be set before calling send()'> を返す
// IDE に "URL must be set before calling send()" と表示される
```

### $ プレフィックスによる型パラメータの視覚的区別

```typescript
// ビルダー自体の型パラメータ: T プレフィックス
// メソッドスコープで推論される型パラメータ: $ プレフィックス
interface Builder<TContext, TInput extends unknown | UnsetMarker> {
  use<$ContextOut>(
    middleware: (ctx: TContext) => $ContextOut,
  ): Builder<$ContextOut, TInput>;

  input<$Parser extends Parser>(
    schema: $Parser,
  ): Builder<TContext, inferParser<$Parser>>;
}
```

## Bad Example

### NG: `never` でエラーを表現する

```typescript
// Bad: never は IDE で「なぜエラーか」がわからない
interface Builder<TUrl extends string | undefined> {
  send(): TUrl extends undefined ? never : Promise<Response>;
  //                                ^^^^^
  // IDE: "Type 'never' is not assignable to ..."
  // 開発者: なぜ never? 何が足りない?
}

// Good: TypeError<TMessage> でメッセージを伝達
interface Builder<TUrl extends string | UnsetMarker> {
  send(): TUrl extends UnsetMarker ? TypeError<"URL must be set before calling send()">
    : Promise<Response>;
  // IDE: "Type 'TypeError<"URL must be set before calling send()">' ..."
  // 開発者: URL を設定していないからだ
}
```

### NG: `undefined` をセンチネル型の代わりに使う

```typescript
// Bad: undefined はユーザーが意図的に設定した値と区別できない
interface Builder<TInput = undefined> {
  input<T>(schema: Schema<T>): Builder<T>;
  query(resolver: (input: TInput) => unknown): void;
}

// createBuilder().query((input) => ...)
// input の型は undefined -- 「未設定」なのか「void 入力」なのか判別不能

// Good: UnsetMarker で「未設定」と「void/undefined」を区別
interface Builder<TInput = UnsetMarker> {
  input<T>(schema: Schema<T>): Builder<T>;
  query(resolver: (input: DefaultValue<TInput, void>) => unknown): void;
}
// .input() 未呼び出し → DefaultValue<UnsetMarker, void> → void
// .input(z.undefined()) → DefaultValue<undefined, void> → undefined
```

### NG: 型パラメータを1つのオブジェクト型にまとめすぎる

```typescript
// Bad: 個別メソッドで部分更新ができない
interface Builder<TConfig extends { url?: string; body?: unknown; headers?: Record<string, string>; }> {
  url(u: string): Builder<TConfig & { url: string; }>;
  // TConfig 全体に & をかけるため、他のプロパティの型が交差型で汚染される
}

// Good: 独立した型パラメータで関心を分離
interface Builder<TUrl, TBody, THeaders> {
  url<U extends string>(u: U): Builder<U, TBody, THeaders>;
  // TUrl だけが更新され、TBody と THeaders は変更されない
}
```

## 適用ガイド

### どのような状況で使うべきか

- **fluent builder API**: メソッドチェーンで段階的にオブジェクトを構築し、最終操作時に構成の整合性をコンパイル時に検証したい場合
- **型安全な設定オブジェクト**: 必須フィールドの設定忘れを型レベルで防止したい場合
- **プロトコルの段階的構築**: 各ステップが前ステップの結果に依存し、不正な順序をコンパイル時に排除したい場合
- **条件分岐する API**: 設定状態に応じて戻り値型やメソッドの利用可否を切り替えたい場合

### 導入時の注意点

1. **型パラメータは5個程度に抑える**: tRPC の8個は必要性から生じたものだが、可読性とコンパイル時間にコストがかかる。関連するパラメータはオブジェクト型にグループ化して管理しやすくする。

2. **`Simplify<T>` で交差型を展開する**: `IntersectIfDefined` が返す `A & B & C` のような交差型は IDE のツールチップで読みにくい。`{ [K in keyof T]: T[K] }` で展開してフラットなオブジェクト型に変換する。

3. **すべてのエラーパスに `TypeError<TMessage>` を配置する**: 条件付き型の末尾に `never` を置くとデバッグが困難になる。すべての不正パスに具体的なメッセージを付与する。

4. **不変ビルダーにする**: 各メソッドは既存のビルダーを変更せず、新しいビルダーを返す。共通のベースビルダーから安全に分岐して派生ビルダーを作成できる。

### カスタマイズポイント

- **センチネル型の粒度**: 単一の `UnsetMarker` で十分な場合が多いが、`Required` / `Optional` / `Unset` の3状態が必要なら複数のセンチネル型を定義する
- **交差型 vs 上書き型**: 設定の累積に `&`（交差型）を使うか `Overwrite`（後勝ち上書き）を使うかは、API のセマンティクスに合わせて選択する。tRPC ではコンテキスト拡張に `Overwrite`、入力合成に `IntersectIfDefined` を使い分けている
- **`$` プレフィックス規約**: ビルダーの状態パラメータ（`T` プレフィックス）とメソッドローカルの推論パラメータ（`$` プレフィックス）を視覚的に区別することで、10個以上の型パラメータがあっても見通しがよくなる

## 導出ルール

- `[MUST]` fluent builder の型パラメータに「未設定」状態を表現するセンチネル型を用意し、`DefaultValue` / `IntersectIfDefined` 等の条件付き型で分岐させる -- `undefined` や `unknown` では「未設定」と「意図的な値」を区別できず、型フォールバックが正しく機能しない
- `[MUST]` 型レベルで不正操作を検出したら `never` ではなく `TypeError<TMessage>` phantom 型で人間が読めるエラーメッセージを返す -- `never` は IDE でホバーしても原因がわからないが、`TypeError<'Context mismatch'>` なら即座に原因を特定できる
- `[MUST]` 各ビルダーメソッドは既存インスタンスを変更せず新しいインスタンスを返す（不変ビルダー） -- 共通ベースからの安全な分岐を保証し、ミュータブルな状態変更による型の不整合を防止する
- `[SHOULD]` 複雑な交差型を `Simplify<T>` で展開し、IDE ツールチップの可読性を改善する -- `{ a: string } & { b: number } & { c: boolean }` ではなく `{ a: string; b: number; c: boolean }` と表示される
- `[SHOULD]` ビルダーの状態パラメータ（`T` プレフィックス）とメソッドスコープの推論パラメータ（`$` プレフィックス）を命名規則で区別する -- 型パラメータが多いジェネリック型で、どれがビルダー状態でどれがメソッドローカルかの判別が容易になる
- `[AVOID]` 型パラメータを1つのオブジェクト型にまとめて部分更新を交差型で行うこと -- 意図しないプロパティの型汚染が発生し、個別メソッドの型パラメータ更新の独立性が失われる

## 参考

- [repos/trpc/trpc/type-system-patterns.md](../repos/trpc/trpc/type-system-patterns.md) -- ProcedureBuilder の型パラメータ蓄積、TypeError phantom type、センチネル型の包括的分析
- [repos/trpc/trpc/composition-patterns.md](../repos/trpc/trpc/composition-patterns.md) -- 不変ビルダーチェーン、合成境界での互換性検証
- [repos/trpc/trpc/design-philosophy.md](../repos/trpc/trpc/design-philosophy.md) -- 型レベル安全ガード、API 安定性スペクトラムの設計哲学
