# type-system-patterns

> リポジトリ: Effect-TS/effect
> 分析日: 2026-02-18

## 概要

Effect-TS は TypeScript の型システムを極限まで活用し、HKT（Higher-Kinded Types）エミュレーション、ブランド型、ファントム型による分散エンコーディング、型レベル統合（Unify）など、高度な型レベルプログラミング技法を体系的に実装している。これらの技法は「ランタイムの安全性を型レベルで保証する」という一貫した設計哲学のもとに統合されており、TypeScript の型システムの実用的限界を押し広げる事例として注目に値する。

## 背景にある原則

- **ファントム型による意味論的エンコーディング**: 型パラメータを実際の値としては使わず、型レベルのメタデータ（分散、依存関係、エラー型）をエンコードする。これにより、ランタイムコストゼロで型安全性を確保できる。`Effect<A, E, R>` の各パラメータが共変・反変の情報を持つ設計がこの原則の根幹にある（`packages/effect/src/internal/effectable.ts:26-35`）。

- **interface merging による型の拡張性**: TypeScript の `declare module` による interface merging を活用し、既存の型を事後的に拡張する。`Either` を `Effect` のサブタイプにする、`Option` を `Effect` として扱えるようにするなど、型の階層関係を宣言的に構築できる（`packages/effect/src/Effect.ts:168-220`）。

- **unique symbol による名目的型区別**: TypeScript の構造的型付けの限界を `unique symbol` で補い、同じ構造を持つ型を名目的に区別する。`TypeId` パターンとして全モジュールに一貫して適用され、型の安全な識別を実現している。

- **型レベル計算の具象化**: `UnionToIntersection`、`Equals`、`Simplify` など、型レベルでの計算ユーティリティを標準化し、複雑な型変換をプリミティブに分解して再利用可能にしている（`packages/effect/src/Types.ts`）。

## 実例と分析

### HKT エミュレーション: TypeLambda + Kind パターン

TypeScript は HKT をネイティブにサポートしないため、Effect-TS は `TypeLambda` インターフェースと `Kind` 型を組み合わせた独自のエミュレーション手法を実装している。

各データ型（Effect、Either、Option、Stream など）は `TypeLambda` を extends した固有の TypeLambda インターフェースを定義し、`this` 型を活用して型パラメータをマッピングする。

```typescript
// packages/effect/src/HKT.ts:21-26
export interface TypeLambda {
  readonly In: unknown
  readonly Out2: unknown
  readonly Out1: unknown
  readonly Target: unknown
}
```

各データ型が TypeLambda を具体化する:

```typescript
// packages/effect/src/Effect.ts:150-152
export interface EffectTypeLambda extends TypeLambda {
  readonly type: Effect<this["Target"], this["Out1"], this["Out2"]>
}

// packages/effect/src/Either.ts:93-95
export interface EitherTypeLambda extends TypeLambda {
  readonly type: Either<this["Target"], this["Out1"]>
}
```

`Kind` 型が TypeLambda を「適用」する:

```typescript
// packages/effect/src/HKT.ts:31-45
export type Kind<F extends TypeLambda, In, Out2, Out1, Target> = F extends {
  readonly type: unknown
} ? (F & {
    readonly In: In
    readonly Out2: Out2
    readonly Out1: Out1
    readonly Target: Target
  })["type"]
  : { /* fallback for safety */ }
```

この仕組みにより、Do 記法のような高階の操作を型安全に複数のデータ型に対して汎用実装できる（`packages/effect/src/internal/doNotation.ts`）。

### 分散エンコーディング: 関数型ファントムフィールド

Effect-TS は型パラメータの共変性・反変性・不変性を関数型のファントムフィールドとしてエンコードする。これは TypeScript の分散推論メカニズムを巧みに利用した技法である。

```typescript
// packages/effect/src/Types.ts:281-332
export type Invariant<A> = (_: A) => A
export type Covariant<A> = (_: never) => A
export type Contravariant<A> = (_: A) => void
```

これらのヘルパーが `TypeId` 配下の分散フィールドに適用される:

```typescript
// packages/effect/src/Option.ts:58-63 (共変)
export interface None<out A> extends Pipeable, Inspectable {
  readonly [TypeId]: {
    readonly _A: Covariant<A>
  }
}

// packages/effect/src/Layer.ts:75-81 (ROut が反変)
export interface Variance<in ROut, out E, out RIn> {
  readonly [LayerTypeId]: {
    readonly _ROut: Types.Contravariant<ROut>
    readonly _E: Types.Covariant<E>
    readonly _RIn: Types.Covariant<RIn>
  }
}

// packages/effect/src/Schema.ts:324-330 (A と I が不変)
export interface Variance<A, I, R> {
  readonly [TypeId]: {
    readonly _A: Types.Invariant<A>
    readonly _I: Types.Invariant<I>
    readonly _R: Types.Covariant<R>
  }
}
```

ランタイム実装では、これらのファントムフィールドは実際に恒等関数として実装される:

```typescript
// packages/effect/src/internal/effectable.ts:26-35
export const effectVariance = {
  _R: (_: never) => _,
  _E: (_: never) => _,
  _A: (_: never) => _,
  _V: version.getCurrentVersion()
}
```

### ブランド型: 型安全な値の区別

Brand モジュールは `unique symbol` を活用したブランド型システムを提供する。nominal（名目的、検証なし）と refined（検証付き）の 2 つの構築戦略がある。

```typescript
// packages/effect/src/Brand.ts:56-60
export interface Brand<in out K extends string | symbol> {
  readonly [BrandTypeId]: {
    readonly [k in K]: K
  }
}

// packages/effect/src/Brand.ts:165
export type Branded<A, K extends string | symbol> = A & Brand<K>
```

Brand は交差型として実装されるため、元の型の全操作を保持しつつ、型レベルの区別を追加できる。`Brand.all` で複数のブランドを合成する際、`EnsureCommonBase` 型がベース型の一致を型レベルで強制する:

```typescript
// packages/effect/src/Brand.ts:149-158
export type EnsureCommonBase<
  Brands extends readonly [Brand.Constructor<any>, ...Array<Brand.Constructor<any>>]
> = {
  [B in keyof Brands]: Brand.Unbranded<Brand.FromConstructor<Brands[0]>> extends
    Brand.Unbranded<Brand.FromConstructor<Brands[B]>>
    ? /* ... */ Brands[B]
    : "ERROR: All brands should have the same base type"
}
```

### 型レベル統合（Unify）

Unify モジュールは、union 型のメンバーを型レベルで「統合」する仕組みを提供する。`Effect<number, E1, R1> | Effect<string, E2, R2>` を `Effect<number | string, E1 | E2, R1 | R2>` に変換する。

この仕組みは 3 つの symbol に基づく:
- `typeSymbol`: 型を統合可能にマークする
- `unifySymbol`: 統合ロジックを定義する
- `ignoreSymbol`: 統合から除外するキーを指定する

```typescript
// packages/effect/src/Unify.ts:61-68
export type Unify<A> = Values<
  ExtractTypes<
    (
      & FilterIn<A>
      & { [typeSymbol]: A }
    )
  >
> extends infer Z ? Z | Exclude<A, Z> | FilterOut<A> : never
```

各データ型が Unify に参加する方法:

```typescript
// packages/effect/src/Effect.ts:111-115
export interface Effect<out A, out E = never, out R = never>
  extends Effect.Variance<A, E, R>, Pipeable {
  readonly [Unify.typeSymbol]?: unknown
  readonly [Unify.unifySymbol]?: EffectUnify<this>
  readonly [Unify.ignoreSymbol]?: EffectUnifyIgnore
}
```

### TypeId + declare module による型階層の構築

Effect-TS は `declare module` を使い、`Either` と `Option` を `Effect` のサブタイプとして後付けで宣言する。これにより、`Either.right(1)` をそのまま Effect として generator 構文で `yield*` できる。

```typescript
// packages/effect/src/Effect.ts:186-199
declare module "./Either.js" {
  interface Left<E, A> extends Effect<A, E> {
    readonly _tag: "Left"
    [Symbol.iterator](): EffectGenerator<Left<E, A>>
  }
  interface Right<E, A> extends Effect<A, E> {
    readonly _tag: "Right"
    [Symbol.iterator](): EffectGenerator<Right<E, A>>
  }
}
```

### 分配条件型の制御: [T] extends ラッパー

型抽出ユーティリティでは `[T] extends [...]` のタプルラッパーを一貫して使用し、union の分配を防止している:

```typescript
// packages/effect/src/Effect.ts:247
export type Context<T extends Effect<any, any, any>> =
  [T] extends [Effect<infer _A, infer _E, infer _R>] ? _R : never
```

### NoExcessProperties: 余剰プロパティチェックの強制

TypeScript の構造的部分型付けではオブジェクトリテラル以外で余剰プロパティチェックが効かないが、`NoExcessProperties` 型で明示的に禁止する:

```typescript
// packages/effect/src/Types.ts:348
export type NoExcessProperties<T, U> = T & {
  readonly [K in Exclude<keyof U, keyof T>]: never
}
```

## コード例

```typescript
// packages/effect/src/Types.ts:110-111
// UnionToIntersection: 反変ポジションの推論を利用した union → intersection 変換
export type UnionToIntersection<T> = (T extends any ? (x: T) => any : never) extends (x: infer R) => any ? R
  : never

// packages/effect/src/Types.ts:144-147
// 型の同値判定: 条件型の分配特性を利用した正確な比較
export type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends <
  T
>() => T extends Y ? 1 : 2 ? true
  : false

// packages/effect/src/Types.ts:126-128
// Simplify: マップ型による交差型のフラット化
export type Simplify<A> = {
  [K in keyof A]: A[K]
} extends infer B ? B : never

// packages/effect/src/Data.ts:20-25
// Equals を利用した条件付きコンストラクタ: フィールドが空なら引数不要
export interface Constructor<A, Tag extends keyof A = never> {
  (
    args: Types.Equals<Omit<A, Tag>, {}> extends true ? void
      : { readonly [P in keyof A as P extends Tag ? never : P]: A[P] }
  ): A
}
```

## パターンカタログ

- **Phantom Type Pattern** (分類: 構造)
  - 解決する問題: 型パラメータの意味論的情報（分散、依存関係）をランタイムコストなしで型に埋め込む
  - 適用条件: 型パラメータが直接値として使われないが、型レベルの情報を保持する必要がある場合
  - コード例: `packages/effect/src/Types.ts:281-321`（Covariant/Contravariant/Invariant ヘルパー）
  - 注意点: ファントムフィールドの分散が正しくないと型の互換性判定が誤る

- **Type Lambda Pattern** (分類: 構造 / Higher-Kinded)
  - 解決する問題: TypeScript に HKT がないため、型コンストラクタを値のように扱えない
  - 適用条件: 複数のデータ型に対して共通の操作（map, flatMap, Do 記法）を型安全に提供する場合
  - コード例: `packages/effect/src/HKT.ts:21-45`, `packages/effect/src/internal/doNotation.ts:1-80`
  - 注意点: TypeLambda の `this` アクセスは TypeScript の特殊仕様に依存しており、将来の TS バージョンで挙動が変わる可能性がある

- **Nominal Typing via unique symbol** (分類: 構造)
  - 解決する問題: 構造的型付けでは同一構造の異なる型を区別できない
  - 適用条件: モジュール境界を越えて型の同一性を保証する必要がある場合
  - コード例: `packages/effect/src/Effect.ts:81`（`EffectTypeId`）, `packages/effect/src/Brand.ts:30`（`BrandTypeId`）
  - 注意点: `Symbol.for()` を使えばモジュール境界を越えて同一性を保てる（`Symbol()` では不可）

## Good Patterns

- **Variance ヘルパー型の標準化**: `Covariant<A>`, `Contravariant<A>`, `Invariant<A>` を型ユーティリティとして共通化し、全モジュールで一貫した分散エンコーディングを実現している。個別に `(_: never) => A` と書くよりも可読性が高く、変更にも強い。

```typescript
// packages/effect/src/Types.ts:281-321
export type Invariant<A> = (_: A) => A
export type Covariant<A> = (_: never) => A
export type Contravariant<A> = (_: A) => void
```

- **TypeId + Variance の二層構造**: `unique symbol` による名目的区別と、分散情報のエンコーディングを一つのインターフェースフィールドにまとめている。型の識別と分散制御を分離しつつ、単一の `readonly [TypeId]` プロパティで表現する。

```typescript
// packages/effect/src/Option.ts:58-63
export interface None<out A> extends Pipeable, Inspectable {
  readonly _tag: "None"
  readonly [TypeId]: {
    readonly _A: Covariant<A>
  }
}
```

- **型抽出ユーティリティの namespace 格納**: `Effect.Context<T>`, `Effect.Error<T>`, `Effect.Success<T>` のように型抽出ユーティリティを namespace 内に配置し、discoverable かつ命名衝突を避けた設計。

```typescript
// packages/effect/src/Effect.ts:247-257
export type Context<T extends Effect<any, any, any>> =
  [T] extends [Effect<infer _A, infer _E, infer _R>] ? _R : never
export type Error<T extends Effect<any, any, any>> =
  [T] extends [Effect<infer _A, infer _E, infer _R>] ? _E : never
export type Success<T extends Effect<any, any, any>> =
  [T] extends [Effect<infer _A, infer _E, infer _R>] ? _A : never
```

- **型レベルのエラーメッセージ**: `EnsureCommonBase` が型制約違反時にリテラル文字列型 `"ERROR: All brands should have the same base type"` を返し、型エラーの原因を開発者に伝える。

```typescript
// packages/effect/src/Brand.ts:152-158
: "ERROR: All brands should have the same base type"
```

## Anti-Patterns / 注意点

- **分散エンコーディングの不一致**: ファントム型フィールドの分散（共変/反変/不変）をデータ型の実際の意味論と一致させないと、型の互換性判定が誤り、安全でない代入を許すか、正当な代入を拒否する。

```typescript
// Bad: Layer の Output を共変にする（消費側なので反変が正しい）
interface BadLayer<ROut, E, RIn> {
  readonly [LayerTypeId]: {
    readonly _ROut: Types.Covariant<ROut> // 誤: 提供される型は反変
  }
}

// Better: 実際の意味論に合わせる
interface Layer<in ROut, out E, out RIn> {
  readonly [LayerTypeId]: {
    readonly _ROut: Types.Contravariant<ROut>
    readonly _E: Types.Covariant<E>
    readonly _RIn: Types.Covariant<RIn>
  }
}
```

- **union 分配の見落とし**: 条件型で `T extends ...` を直接使うと、`T` が union の場合に分配される。型抽出ユーティリティでは意図しない分配が起きやすい。

```typescript
// Bad: union が分配されてしまう
type Context<T> = T extends Effect<infer _A, infer _E, infer R> ? R : never
// Context<Effect<1, 2, 3> | Effect<4, 5, 6>> は 3 | 6 になるが、
// 分配を防ぎたい場面では意図しない結果になる

// Better: タプルで包んで分配を制御
type Context<T> = [T] extends [Effect<infer _A, infer _E, infer R>] ? R : never
```

## 導出ルール

- `[MUST]` 型パラメータの分散は関数型ファントムフィールドでエンコードする。`out T` アノテーションだけでは TypeScript コンパイラが分散を正しく推論しない場面がある
  - 根拠: Effect-TS の全データ型（Effect, Layer, Option, Either, Schema, Match 等）が `Covariant<A>` / `Contravariant<A>` / `Invariant<A>` ヘルパーで統一的にエンコーディングしている（`packages/effect/src/Types.ts:281-321`）

- `[MUST]` 条件型で union の分配を防ぐ必要がある場面では `[T] extends [...]` のタプルラッパーを使う
  - 根拠: Effect-TS の全型抽出ユーティリティ（`Effect.Context`, `Effect.Error`, `Layer.Success` 等）が一貫してこのパターンを適用している（`packages/effect/src/Effect.ts:247-257`）

- `[MUST]` 構造的型付けで区別すべき型には `unique symbol` を TypeId として付与し、interface のフィールドとして埋め込む
  - 根拠: Effect-TS は Option, Either, Effect, Layer, Schema 等あらゆるデータ型に `TypeId: unique symbol` を持たせ、構造的に同一でも型レベルで区別可能にしている

- `[SHOULD]` HKT が必要な場面では `TypeLambda` + `Kind` パターン（`this` アクセスによる型パラメータ注入）を使い、複数データ型への汎用操作を一箇所に定義する
  - 根拠: Do 記法（bind/bindTo/let）が `Kind<F, R, O, E, A>` を通じて Effect, Either, Array, Option に対して単一実装で提供されている（`packages/effect/src/internal/doNotation.ts`）

- `[SHOULD]` ブランド型は intersection（`A & Brand<K>`）として実装し、元の型の操作を保持しつつ型レベルの区別を追加する
  - 根拠: `Brand.Branded<A, K> = A & Brand<K>` により、ブランド付きの `number` は依然として算術演算が可能であり、型の利便性を損なわない（`packages/effect/src/Brand.ts:165`）

- `[SHOULD]` 型抽出ユーティリティ（`Type<S>`, `Error<S>`, `Context<S>`）はデータ型の `declare namespace` 内に配置し、名前空間を整理する
  - 根拠: Effect-TS は `Effect.Context<T>`, `Schema.Type<S>`, `Layer.Error<T>` のように namespace 内に型ユーティリティを集約し、API の発見容易性を高めている

- `[SHOULD]` 型レベルでエラーを報告する場面ではリテラル文字列型を返し、開発者に原因を伝える
  - 根拠: `Brand.EnsureCommonBase` が `"ERROR: All brands should have the same base type"` を返す設計（`packages/effect/src/Brand.ts:157`）

- `[AVOID]` 型パラメータの分散を `out` / `in` アノテーションのみに依存し、ファントムフィールドでのエンコーディングを省略すること。型の互換性判定が不安定になり、コンパイラバージョン間で挙動が変わるリスクがある
  - 根拠: Effect-TS は `out A` アノテーションと `Covariant<A>` フィールドの両方を必ず併用しており、二重の安全策を取っている

## 適用チェックリスト

- [ ] プロジェクトに `Covariant<A>`, `Contravariant<A>`, `Invariant<A>` に相当する分散ヘルパー型を定義したか
- [ ] 各データ型の `TypeId` は `unique symbol` + `Symbol.for()` で定義し、interface のフィールドとして埋め込んでいるか
- [ ] 条件型での型抽出で union の分配が起きるケースを `[T] extends [...]` で制御しているか
- [ ] ブランド型が必要な場面で intersection パターン（`A & Brand<K>`）を使い、元の型の操作を保持しているか
- [ ] 型抽出ユーティリティは `declare namespace` 内にまとめて配置しているか
- [ ] 複数のデータ型に共通する操作が必要な場合、TypeLambda パターンの導入を検討したか
- [ ] 型レベルのエラーメッセージにリテラル文字列型を使い、開発者に原因が伝わるようにしているか
- [ ] 型テスト（tstyche 等）で型の分散・互換性・推論結果を検証しているか
