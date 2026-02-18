# API デザインプラクティス

> リポジトリ: Effect-TS/effect
> 分析日: 2026-02-18

## 概要

Effect は 177 モジュールからなる大規模 TypeScript ライブラリであり、名前空間ベースの API 設計、`dual` 関数によるデータファースト/データラスト両対応、TypeScript の型システムを限界まで活用したオーバーロード設計を体系的に実践している。これらのパターンは関数型プログラミングの合成性と IDE 支援の両立を実現しており、大規模ライブラリの API 設計における参考例として注目に値する。

## 背景にある原則

- **合成の対称性**: すべてのデータ操作関数を data-first（直接呼び出し）と data-last（`pipe` 合成）の両スタイルで利用可能にすべき。なぜなら、単独の関数呼び出しでは data-first が自然で型推論が効きやすく、パイプラインでは data-last が合成しやすいため。`dual` 関数がこの二重性を 1 つの実装から自動的に導出する（`packages/effect/src/Function.ts:95-172`）。

- **名前空間による発見可能性**: モジュールごとに名前空間 re-export し、`Effect.map`, `Array.filter`, `Option.match` のように「型名.操作名」の形で API を提供すべき。なぜなら、フラットなエクスポートは名前衝突を起こし、IDE の自動補完で関連操作を一覧できないため。`index.ts` の `export * as Array from "./Array.js"` パターンで統一的に実現している。

- **型レベルの正確性による安全性**: API シグネチャで `Refinement` オーバーロードと `Predicate` オーバーロードを分離し、型ガードを呼び出し側に自動伝播させるべき。なぜなら、実行時の安全性だけでなくコンパイル時の型絞り込みを提供することで、後続コードの `as` キャストや型ガードの重複を排除できるため（`Array.ts` の `filter`, `takeWhile`, `span` 等の全関数で一貫）。

- **実装の隠蔽と型の公開の分離**: 型定義（interface）は公開モジュールに、実装は `internal/` ディレクトリに配置すべき。なぜなら、公開 API の型シグネチャを安定させつつ、内部実装を自由にリファクタリングできるため。`Option.ts` は型とシグネチャのみ、`internal/option.ts` が `Object.create` による実装を担う。

## 実例と分析

### dual 関数によるデュアル API パターン

`dual` は Effect のほぼ全操作関数で使用されており、593 箇所（58 ファイル）で適用されている。引数の数（arity）を判定基準として、data-first と data-last を自動的に切り替える。

基本構造は以下の通り:

1. オーバーロードシグネチャで data-last（引数なし → カリー化関数を返す）と data-first（全引数渡し）を宣言
2. `dual(arity, bodyFn)` で実装を 1 つだけ記述
3. `dual` が `arguments.length` を判定し、arity 未満なら data-last として部分適用関数を返す

パフォーマンス最適化として、arity 2〜5 は switch 文で個別最適化されている（`Function.ts:115-158`）。arity が不定の場合（可変長引数）は述語関数 `isDataFirst` を渡すバリアントも用意されている。

### 名前空間 re-export パターン

`index.ts` で 175 モジュールを名前空間として一括 re-export している。特徴的なのは、`pipe`, `identity`, `flow` 等のごく少数の汎用関数だけが名前付きエクスポートされ、残りはすべて名前空間エクスポートである点。

```
// packages/effect/src/index.ts
export { pipe, identity, flow, ... } from "./Function.js"  // 例外的にフラット
export * as Array from "./Array.js"      // 名前空間
export * as Option from "./Option.js"    // 名前空間
export * as Effect from "./Effect.js"    // 名前空間
```

これにより `import { Array, Option, pipe } from "effect"` の 1 行で全モジュールにアクセスでき、`Array.map` と `Option.map` が衝突しない。

### Refinement オーバーロードの階層構造

`filter`, `takeWhile`, `span`, `find`, `findFirst` 等の述語関数は 4 つのオーバーロードシグネチャを持つ:

```
// packages/effect/src/Array.ts:2757-2761
export const filter: {
  <A, B extends A>(refinement: (a: NoInfer<A>, i: number) => a is B): (self: Iterable<A>) => Array<B>
  <A>(predicate: (a: NoInfer<A>, i: number) => boolean): (self: Iterable<A>) => Array<A>
  <A, B extends A>(self: Iterable<A>, refinement: (a: A, i: number) => a is B): Array<B>
  <A>(self: Iterable<A>, predicate: (a: A, i: number) => boolean): Array<A>
}
```

順序のルール: (1) data-last + refinement, (2) data-last + predicate, (3) data-first + refinement, (4) data-first + predicate。Refinement を predicate より先に置くことで、TypeScript が型ガード付きのオーバーロードを優先的にマッチさせる。

### TypeId によるブランド型パターン

すべてのデータ型（Option, Either, HashMap, Chunk 等、41 モジュール以上）が `Symbol.for("effect/<TypeName>")` で生成した一意の TypeId を持つ。

```
// packages/effect/src/Option.ts:46
export const TypeId: unique symbol = Symbol.for("effect/Option")

// packages/effect/src/HashMap.ts:14
const TypeId: unique symbol = HM.HashMapTypeId as TypeId
```

`Symbol.for` を使うことでプロセス間・バンドル間で同一性を保証し、`hasProperty(input, TypeId)` による型ガードで安全な型判定を実現している。

### self / that の引数命名規約

data-first スタイルでは一貫して第 1 引数を `self`、第 2 引数を `that` と命名する。String モジュールでは `self` が 67 箇所、`that` が 2 箇所使用されている。この規約により、パイプラインでカリー化される際にどの引数がデータで、どの引数がパラメータかが型シグネチャから明確になる。

### NoInfer による型推論の制御

`Array.ts` では 31 箇所で `NoInfer<A>` が使用されている。data-last シグネチャの callback 引数に `NoInfer` を適用することで、TypeScript がコールバックの引数型からジェネリック型 `A` を推論することを防ぎ、`self` パラメータからの推論を強制する。

```
// data-last: NoInfer を使って callback からの逆推論を防止
<A, B extends A>(refinement: (a: NoInfer<A>, i: number) => a is B): (self: Iterable<A>) => Array<B>
// data-first: self から推論するため NoInfer 不要
<A, B extends A>(self: Iterable<A>, refinement: (a: A, i: number) => a is B): Array<B>
```

## コード例

```typescript
// packages/effect/src/Function.ts:95-112
// dual 関数の型定義と実装の核心部
export const dual: {
  <DataLast extends (...args: Array<any>) => any, DataFirst extends (...args: Array<any>) => any>(
    arity: Parameters<DataFirst>["length"],
    body: DataFirst,
  ): DataLast & DataFirst;
  <DataLast extends (...args: Array<any>) => any, DataFirst extends (...args: Array<any>) => any>(
    isDataFirst: (args: IArguments) => boolean,
    body: DataFirst,
  ): DataLast & DataFirst;
} = function(arity, body) {
  if (typeof arity === "function") {
    return function() {
      if (arity(arguments)) {
        return body.apply(this, arguments);
      }
      return ((self: any) => body(self, ...arguments)) as any;
    };
  }
  // arity 2〜5 は switch で最適化（省略）
};
```

```typescript
// packages/effect/src/Struct.ts:27-48
// 可変長引数での dual: 述語関数で data-first を判定
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
```

```typescript
// packages/effect/src/Option.ts:923-929
// 最もシンプルな dual パターンの実例
export const map: {
  <A, B>(f: (a: A) => B): (self: Option<A>) => Option<B>;
  <A, B>(self: Option<A>, f: (a: A) => B): Option<B>;
} = dual(
  2,
  <A, B>(self: Option<A>, f: (a: A) => B): Option<B> => isNone(self) ? none() : some(f(self.value)),
);
```

```typescript
// packages/effect/src/internal/option.ts:27-43
// 実装の隠蔽: Object.create + プロトタイプチェーンでデータ型を構築
const SomeProto = Object.assign(Object.create(CommonProto), {
  _tag: "Some",
  _op: "Some",
  [Equal.symbol]<A>(this: Option.Some<A>, that: unknown): boolean {
    return isOption(that) && isSome(that) && Equal.equals(this.value, that.value);
  },
  [Hash.symbol]<A>(this: Option.Some<A>) {
    return Hash.cached(this, Hash.combine(Hash.hash(this._tag))(Hash.hash(this.value)));
  },
  toJSON<A>(this: Option.Some<A>) {
    return { _id: "Option", _tag: this._tag, value: toJSON(this.value) };
  },
});

export const some = <A>(value: A): Option.Option<A> => {
  const a = Object.create(SomeProto);
  a.value = value;
  return a;
};
```

```typescript
// packages/effect/src/Effect.ts:4677-4685
// options オブジェクト vs 単一関数のオーバーロード
export const tryPromise: {
  <A, E>(
    options: {
      readonly try: (signal: AbortSignal) => PromiseLike<A>;
      readonly catch: (error: unknown) => E;
    },
  ): Effect<A, E>;
  <A>(evaluate: (signal: AbortSignal) => PromiseLike<A>): Effect<A, Cause.UnknownException>;
} = effect.tryPromise;
```

## パターンカタログ

- **Dual API パターン** (分類: 構造)
  - 解決する問題: 関数合成（パイプライン）と直接呼び出しの両方で同じ関数を使いたい
  - 適用条件: データ操作関数で、第 1 引数が「操作対象のデータ」であるもの
  - コード例: `packages/effect/src/Function.ts:95-172`
  - 注意点: arity 0〜1 では動作しない（RangeError）。可変長引数では述語関数バリアントを使う

- **Namespace Module パターン** (分類: 構造)
  - 解決する問題: 大量の関数エクスポートによる名前衝突と発見困難性
  - 適用条件: 複数のデータ型に対して同名の操作（map, filter, flatMap 等）を提供するライブラリ
  - コード例: `packages/effect/src/index.ts:42` (`export * as Array from "./Array.js"`)
  - 注意点: tree-shaking の効率に影響し得る。バンドラの設定確認が必要

- **TypeId Brand パターン** (分類: 構造/型安全)
  - 解決する問題: `instanceof` が使えない環境（バンドル分割、モジュール重複）での型判定
  - 適用条件: カスタムデータ型を提供し、`is` 型ガードが必要な場合
  - コード例: `packages/effect/src/Option.ts:46`, `packages/effect/src/internal/option.ts:64`
  - 注意点: `Symbol.for` を使えばグローバルレジストリで一意性が保証される。ローカル `Symbol()` だとバンドル間で不一致が起きる

- **Refinement-first Overload パターン** (分類: 型安全)
  - 解決する問題: 型ガード関数を渡したとき、戻り値型に絞り込み結果が反映されない
  - 適用条件: predicate を受け取る関数で、Refinement（型ガード）も受け付けたい場合
  - コード例: `packages/effect/src/Array.ts:2757-2761`
  - 注意点: Refinement オーバーロードは必ず Predicate オーバーロードより前に配置する

## Good Patterns

- **オプションオブジェクトによるオーバーロード分岐**: `Effect.tryPromise` は単一関数を渡す簡易版と、`{ try, catch }` オブジェクトを渡す詳細版の 2 つのオーバーロードを持つ。これにより、シンプルなケースでは最小限のコード、エラーハンドリングが必要なケースでは型安全な構造化オプションを提供する。

```typescript
// 簡易版: エラー型は UnknownException
Effect.tryPromise(() => fetch("/api"));
// 詳細版: エラー型を明示的に制御
Effect.tryPromise({
  try: (signal) => fetch("/api", { signal }),
  catch: (error) => new NetworkError(String(error)),
});
```

- **JSDoc `@category` タグによる API のセマンティック分類**: Array.ts では `constructors`, `conversions`, `pattern matching`, `concatenating`, `folding`, `guards`, `getters`, `filtering`, `splitting`, `mapping` 等のカテゴリで 142 以上の関数を分類。ドキュメント生成ツールがこの情報を使ってグループ化した API リファレンスを生成できる。

- **Pipeable インターフェースの統一実装**: すべてのデータ型が `Pipeable` インターフェースを実装し、`pipe` メソッドを持つ。実装は `pipeArguments` ユーティリティに委譲され、switch 文で arity 0〜9 を最適化している。これにより `Option.some(1).pipe(Option.map(n => n + 1))` のようなメソッドチェーン風の記述が可能。

```typescript
// packages/effect/src/internal/effectable.ts:82-84
pipe() {
  return pipeArguments(this, arguments)
}
```

## Anti-Patterns / 注意点

- **data-last 専用関数の設計**: dual を使わず data-last のみの関数を作ると、パイプライン外での単独使用時に不自然な記述 `filter(predicate)(array)` を強いることになる。

```typescript
// Bad: data-last のみ
const filter = <A>(pred: (a: A) => boolean) => (arr: A[]): A[] => arr.filter(pred);
// 使用: filter(isEven)([1,2,3]) — 不自然

// Better: dual で両対応
const filter: {
  <A>(pred: (a: A) => boolean): (arr: A[]) => A[];
  <A>(arr: A[], pred: (a: A) => boolean): A[];
} = dual(2, <A>(arr: A[], pred: (a: A) => boolean) => arr.filter(pred));
// 使用: filter([1,2,3], isEven) も pipe([1,2,3], filter(isEven)) も可
```

- **Refinement オーバーロードの順序誤り**: TypeScript のオーバーロード解決は宣言順で最初にマッチしたものが使われる。Predicate オーバーロードを Refinement より先に書くと、型ガード関数を渡しても型絞り込みが効かなくなる。

```typescript
// Bad: predicate が先
export const find: {
  <A>(predicate: (a: A) => boolean): (arr: A[]) => A | undefined; // こちらが先にマッチ
  <A, B extends A>(refinement: (a: A) => a is B): (arr: A[]) => B | undefined;
};

// Better: refinement が先
export const find: {
  <A, B extends A>(refinement: (a: A) => a is B): (arr: A[]) => B | undefined; // 先にマッチ
  <A>(predicate: (a: A) => boolean): (arr: A[]) => A | undefined;
};
```

- **instanceof に依存した型判定**: Effect は `Symbol.for` ベースの TypeId で型判定を行い、`instanceof` を一切使わない。`instanceof` はプロトタイプチェーンに依存するため、異なるバンドルやモジュール重複環境で偽陰性を返す。

```typescript
// Bad: instanceof に依存
function isOption(value: unknown): value is Option<unknown> {
  return value instanceof OptionImpl;
}

// Better: Symbol.for + hasProperty
const TypeId = Symbol.for("effect/Option");
function isOption(value: unknown): value is Option<unknown> {
  return hasProperty(value, TypeId);
}
```

## 導出ルール

- `[MUST]` dual API を提供する関数では、data-first の実装を 1 つ書き、`dual(arity, body)` で data-last バリアントを自動導出する。2 つの実装を別々にメンテナンスすると乖離のリスクがある
  - 根拠: Effect の 593 箇所の `dual` 使用すべてがこのパターンに従い、実装の一元管理を実現している（`packages/effect/src/Function.ts:95-172`）

- `[MUST]` Refinement（型ガード）オーバーロードは、同じシグネチャの Predicate オーバーロードより前に宣言する。TypeScript のオーバーロード解決は宣言順であり、順序を誤ると型絞り込みが効かなくなる
  - 根拠: `Array.filter`, `Array.takeWhile`, `Array.span` 等すべての述語系関数で refinement → predicate の順序が一貫している（`packages/effect/src/Array.ts:2757-2761`）

- `[MUST]` ライブラリの公開データ型には `Symbol.for("scope/TypeName")` で生成した TypeId を付与し、`instanceof` ではなく TypeId の存在チェックで型判定を行う
  - 根拠: 41 モジュール以上で TypeId パターンが適用され、バンドル分割環境でも型判定が安定して動作する（`packages/effect/src/Option.ts:46`, `packages/effect/src/internal/option.ts:64`）

- `[SHOULD]` 同名の操作（`map`, `filter`, `flatMap` 等）を複数のデータ型に提供する場合は、名前空間 re-export を使って衝突を回避し、`Type.operation` 形式で API を提供する
  - 根拠: `index.ts` の 175 個の `export * as X from` により、`Array.map`, `Option.map`, `Effect.map` が衝突せず共存している

- `[SHOULD]` data-first スタイルの第 1 引数は `self`、第 2 引数以降のデータ引数は `that` と命名する。パイプラインで「どの引数がデータか」が型シグネチャから即座に判別できる
  - 根拠: String モジュールで `self` 67 箇所、Option/Array/Effect 等すべてのモジュールで統一されている

- `[SHOULD]` data-last オーバーロードのコールバック型引数には `NoInfer<A>` を適用し、コールバックからのジェネリック型逆推論を防止する。型推論の方向を「データ → コールバック」に固定することで予測可能な型推論を実現する
  - 根拠: `Array.ts` で 31 箇所の `NoInfer` 使用により、パイプライン中の型推論が安定している

- `[AVOID]` ライブラリ API で data-last のみの関数を提供すること。パイプライン外での直接呼び出しが不自然になり、学習コストが上がる
  - 根拠: Effect は全操作関数を `dual` で両対応させており、data-last 専用関数は存在しない

## 適用チェックリスト

- [ ] 自プロジェクトのデータ操作関数が data-first と data-last の両方で使えるか確認する
- [ ] `dual` 相当のユーティリティを導入し、2 つのスタイルを 1 つの実装から導出しているか
- [ ] Predicate を受け取る関数で Refinement オーバーロードを提供しているか、かつ Refinement が Predicate より先に宣言されているか
- [ ] 公開データ型が `instanceof` ではなく `Symbol.for` ベースの TypeId で型判定されているか
- [ ] 複数の型に同名の操作を提供する場合、名前空間パターンで衝突を回避しているか
- [ ] data-first の第 1 引数が一貫して `self` と命名されているか
- [ ] data-last シグネチャのコールバック引数に `NoInfer` を適用して型推論の方向を制御しているか
- [ ] JSDoc の `@category` タグで関数をセマンティックに分類し、ドキュメント生成で活用しているか
