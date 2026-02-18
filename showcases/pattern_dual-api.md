# Pattern: DualAPI

> 出典: [repos/Effect-TS/effect](../repos/Effect-TS/effect/) の複数視点から抽出
> カテゴリ: pattern

## 概要

`dual()` 関数を使い、data-first（直接呼び出し）と data-last（pipe 合成）の両スタイルを単一の実装から自動導出するパターン。Effect-TS では 593 箇所・58 ファイルで適用されており、関数型プログラミングの合成性と直感的な呼び出しの両立を実現している。ライブラリ API の設計において「パイプラインか直接呼び出しか」の二者択一を解消する汎用的な手法である。

## 背景・文脈

Effect-TS（Effect-TS/effect）は 177 モジュールからなる大規模 TypeScript ライブラリで、`Option`, `Either`, `Array`, `Effect` など多数のデータ型に対して `map`, `filter`, `flatMap` 等の操作関数を提供している。

関数型プログラミングでは `pipe` によるデータ変換チェーンが主流だが、単独の関数呼び出しでは data-first（`map(option, f)`）のほうが自然で型推論も効きやすい。一方、パイプラインでは data-last（`map(f)`）のほうが合成しやすい。この二重性を解消するため、Effect-TS はすべてのデータ操作関数に `dual()` を適用し、引数の数で自動的にスタイルを切り替える仕組みを構築した。

## 実装パターン

### dual 関数の核心

`dual` は 2 つのバリアントを持つ。arity（引数の数）で判定する固定長バリアントと、述語関数で判定する可変長バリアント。

```typescript
// packages/effect/src/Function.ts:95-112
export const dual: {
  // バリアント1: arity（固定長引数）で data-first を判定
  <DataLast extends (...args: Array<any>) => any, DataFirst extends (...args: Array<any>) => any>(
    arity: Parameters<DataFirst>["length"],
    body: DataFirst,
  ): DataLast & DataFirst;
  // バリアント2: 述語関数で data-first を判定（可変長引数用）
  <DataLast extends (...args: Array<any>) => any, DataFirst extends (...args: Array<any>) => any>(
    isDataFirst: (args: IArguments) => boolean,
    body: DataFirst,
  ): DataLast & DataFirst;
} = function(arity, body) {
  if (typeof arity === "function") {
    // 述語関数バリアント: isDataFirst(arguments) で判定
    return function() {
      if (arity(arguments)) {
        return body.apply(this, arguments); // data-first: 全引数を渡す
      }
      return ((self: any) => body(self, ...arguments)) as any; // data-last: カリー化
    };
  }
  // arity バリアント: arguments.length で判定（arity 2〜5 は switch で個別最適化）
};
```

### パフォーマンス最適化

arity 2〜5 は switch 文で個別に最適化されており、スプレッド演算子のオーバーヘッドを回避している。

```typescript
// packages/effect/src/Function.ts:115-158 (概略)
switch (arity) {
  case 2:
    return function(a: any, b: any) {
      if (arguments.length >= 2) {
        return body(a, b); // data-first: fn(self, arg)
      }
      return function(self: any) {
        return body(self, a); // data-last: self.pipe(fn(arg))
      };
    };
  case 3:
    return function(a: any, b: any, c: any) {
      if (arguments.length >= 3) {
        return body(a, b, c);
      }
      return function(self: any) {
        return body(self, a, b);
      };
    };
    // case 4, 5 も同様
}
```

### 基本的な使用例: Option.map

最もシンプルな dual パターンの適用例。オーバーロードシグネチャで 2 つのスタイルを宣言し、`dual(2, bodyFn)` で実装を 1 つだけ記述する。

```typescript
// packages/effect/src/Option.ts:923-929
export const map: {
  <A, B>(f: (a: A) => B): (self: Option<A>) => Option<B>; // data-last
  <A, B>(self: Option<A>, f: (a: A) => B): Option<B>; // data-first
} = dual(
  2,
  <A, B>(self: Option<A>, f: (a: A) => B): Option<B> => isNone(self) ? none() : some(f(self.value)),
);

// 使い方: どちらのスタイルでも同じ関数を呼べる
Option.map(Option.some(1), n => n + 1); // data-first: Some(2)
pipe(Option.some(1), Option.map(n => n + 1)); // data-last:  Some(2)
```

### 可変長引数パターン: Struct.pick

引数の数が不定の場合は arity による判定が使えないため、述語関数バリアントで「第 1 引数がオブジェクトかどうか」を判定する。

```typescript
// packages/effect/src/Struct.ts:27-48
export const pick: {
  <Keys extends Array<PropertyKey>>(
    ...keys: Keys
  ): <S extends { [K in Keys[number]]?: any; }>(s: S) => Simplify<Pick<S, Keys[number]>>;
  <S extends object, Keys extends Array<keyof S>>(
    s: S,
    ...keys: Keys
  ): Simplify<Pick<S, Keys[number]>>;
} = dual(
  (args) => Predicate.isObject(args[0]), // 第1引数がオブジェクトなら data-first
  <S extends object, Keys extends Array<keyof S>>(s: S, ...keys: Keys) => {
    const out: any = {};
    for (const k of keys) {
      if (k in s) out[k] = (s as any)[k];
    }
    return out;
  },
);

// 使い方
Struct.pick({ a: 1, b: 2, c: 3 }, "a", "b"); // data-first: { a: 1, b: 2 }
pipe({ a: 1, b: 2, c: 3 }, Struct.pick("a", "b")); // data-last:  { a: 1, b: 2 }
```

### Refinement オーバーロードとの組み合わせ

述語関数を受け取る `filter` 等では、Refinement（型ガード）オーバーロードを Predicate より前に宣言して型絞り込みを優先させる。4 つのオーバーロード（data-last + refinement, data-last + predicate, data-first + refinement, data-first + predicate）が定型パターンとなる。

```typescript
// packages/effect/src/Array.ts:2757-2761
export const filter: {
  <A, B extends A>(refinement: (a: NoInfer<A>, i: number) => a is B): (self: Iterable<A>) => Array<B>;
  <A>(predicate: (a: NoInfer<A>, i: number) => boolean): (self: Iterable<A>) => Array<A>;
  <A, B extends A>(self: Iterable<A>, refinement: (a: A, i: number) => a is B): Array<B>;
  <A>(self: Iterable<A>, predicate: (a: A, i: number) => boolean): Array<A>;
};
```

### NoInfer による型推論の方向制御

data-last シグネチャのコールバック引数には `NoInfer<A>` を適用する。これにより TypeScript がコールバックの引数型からジェネリック型 `A` を推論するのを防ぎ、パイプラインの上流（`self`）からの型推論を強制する。

```typescript
// data-last: NoInfer を使って callback からの逆推論を防止
<A, B extends A>(refinement: (a: NoInfer<A>, i: number) => a is B): (self: Iterable<A>) => Array<B>

// data-first: self から推論するため NoInfer 不要
<A, B extends A>(self: Iterable<A>, refinement: (a: A, i: number) => a is B): Array<B>
```

## Good Example

```typescript
// dual で data-first / data-last 両対応を単一実装から導出
const filter: {
  <A>(pred: (a: A) => boolean): (arr: A[]) => A[];
  <A>(arr: A[], pred: (a: A) => boolean): A[];
} = dual(2, <A>(arr: A[], pred: (a: A) => boolean) => arr.filter(pred));

// どちらのスタイルでも同じ関数を使える
filter([1, 2, 3, 4], n => n % 2 === 0); // data-first: [2, 4]
pipe([1, 2, 3, 4], filter(n => n % 2 === 0)); // data-last:  [2, 4]

// self / that の命名規約に従い、引数の役割を明確にする
const concat: {
  <A>(that: Array<A>): (self: Array<A>) => Array<A>;
  <A>(self: Array<A>, that: Array<A>): Array<A>;
} = dual(2, <A>(self: Array<A>, that: Array<A>) => [...self, ...that]);
```

## Bad Example

```typescript
// Bad: data-last のみ — パイプライン外での呼び出しが不自然
const filter = <A>(pred: (a: A) => boolean) => (arr: A[]): A[] => arr.filter(pred);
// 使用: filter(isEven)([1,2,3]) — 二重呼び出しが直感に反する

// Bad: 2つの実装を別々にメンテナンス — 乖離のリスク
const filterFirst = <A>(arr: A[], pred: (a: A) => boolean): A[] => arr.filter(pred);
const filterLast = <A>(pred: (a: A) => boolean) => (arr: A[]): A[] => arr.filter(pred);
// filterFirst にバグ修正しても filterLast を更新し忘れる可能性

// Bad: Refinement オーバーロードの順序誤り — 型絞り込みが効かない
export const find: {
  <A>(predicate: (a: A) => boolean): (arr: A[]) => A | undefined; // 先にマッチしてしまう
  <A, B extends A>(refinement: (a: A) => a is B): (arr: A[]) => B | undefined; // 到達しない
};
// TypeScript のオーバーロード解決は宣言順。Predicate が先だと型ガードが無視される
```

## 適用ガイド

### どのような状況で使うべきか

- **データ操作ライブラリ**: `map`, `filter`, `flatMap` 等の変換関数を提供するライブラリで、pipe チェーンと直接呼び出しの両方をサポートしたい場合
- **関数型 API を設計するプロジェクト**: ユーザーが「パイプライン派」と「直接呼び出し派」に分かれる場合に、どちらも第一級市民として扱える
- **型安全な合成が求められる場面**: パイプラインでの型推論と、直接呼び出しでの型推論の両方を最適化したい場合

### 導入時の注意点

- **arity 0 と 1 では動作しない**: `dual` は `arguments.length` で data-first/data-last を判定するため、引数が 0 個または 1 個の関数には適用できない（判定不能）
- **可変長引数には述語関数バリアントを使う**: arity が不定の場合は `dual((args) => isObject(args[0]), bodyFn)` のように、第 1 引数の型で判定する述語関数を渡す
- **オーバーロードの宣言順序**: Refinement オーバーロードは必ず Predicate オーバーロードより前に配置する。TypeScript は宣言順で最初にマッチしたオーバーロードを使うため、順序を誤ると型絞り込みが効かなくなる
- **NoInfer の適用**: data-last シグネチャのコールバック引数に `NoInfer<A>` を付けることで、パイプラインでの型推論方向を「データ → コールバック」に固定できる。これを忘れるとコールバックの引数から意図しない型推論が走る

### カスタマイズポイント

- **self / that の命名規約**: data-first の第 1 引数は `self`（操作対象のデータ）、第 2 引数以降のデータ引数は `that` で統一する。パイプラインでカリー化される際にどの引数がデータかが型シグネチャから即座に判別できる
- **`dual` ユーティリティの簡易版**: Effect-TS の `dual` は arity 2〜5 を switch で最適化しているが、小規模プロジェクトではデフォルトケース（スプレッド）のみの簡易実装でも十分機能する
- **pipe ユーティリティとの組み合わせ**: `dual` で作った関数は、任意の `pipe` 実装（Effect-TS の `pipe`, lodash の `flow`, 独自実装）と組み合わせられる。`pipe` の仕様に依存しないのが `dual` の強み

```typescript
// 最小限の dual 実装（自プロジェクトへの導入用）
function dual<F extends (...args: any[]) => any>(
  arity: number,
  body: F,
): F {
  return function(...args: any[]) {
    if (args.length >= arity) {
      return body(...args); // data-first
    }
    return (self: any) => body(self, ...args); // data-last
  } as any;
}
```

## 参考

- [repos/Effect-TS/effect/api-design-practices.md](../repos/Effect-TS/effect/api-design-practices.md) — dual API パターンの設計原則と 593 箇所の適用分析
- [repos/Effect-TS/effect/abstraction-patterns.md](../repos/Effect-TS/effect/abstraction-patterns.md) — dual を含むプロトコル抽象化パターンの体系的分析
