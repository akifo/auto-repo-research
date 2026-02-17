# abstraction-patterns

> リポジトリ: Effect-TS/effect
> 分析日: 2026-02-18

## 概要

Effect-TS のコアライブラリは、Pipeable / Inspectable / Equal / Hash という小さなプロトコルインターフェースを定義し、それらをプロトタイプオブジェクトの合成で全データ型に横断適用している。TypeScript の言語制約（HKT 非対応、ランタイム mixin 不在）を Symbol ベースの型タグと `dual()` による data-first/data-last 両用 API で乗り越え、177 以上のモジュールに一貫した操作体系を提供している点が注目に値する。

## 背景にある原則

- **Protocol-over-Inheritance（プロトコルが継承に優先する）**: 共通の振る舞いを基底クラスの継承ではなく、Symbol キー付きプロトコルインターフェース（`Equal.symbol`, `Hash.symbol` 等）で定義すべき。なぜなら、TypeScript ではクラス多重継承が不可能であり、プロトコルなら任意の型が複数を同時に実装できるため。`Equal.ts:13`, `Hash.ts:19` でそれぞれ `Symbol.for("effect/Equal")`, `Symbol.for("effect/Hash")` をプロトコル識別子として定義している。

- **Prototype Composition（プロトタイプの合成による横断的関心事の付与）**: 共通プロトコルの実装を個々のクラスに重複して書くのではなく、プロトタイプオブジェクトを `Object.assign` / `Object.create` で層状に合成して一箇所に集約すべき。なぜなら、プロトコル実装の変更が全データ型に自動伝播し、保守コストが激減するため。`internal/effectable.ts:68-85` の `EffectPrototype` に `Equal`, `Hash`, `pipe`, `Symbol.iterator` が集約され、`internal/option.ts:14-25` の `CommonProto` が `...EffectPrototype` で展開される。

- **Phantom Type による型安全な変性エンコード**: ランタイムコストなしでジェネリクスの共変性・反変性を型レベルで表現すべき。`Types.ts:301` の `Covariant<A> = (_: never) => A` と `Types.ts:321` の `Contravariant<A> = (_: A) => void` を型パラメータに埋め込み、TypeScript の関数型の変性規則を利用して安全な代入を実現する。

- **Symbol.for による跨境識別**: TypeId を `Symbol.for("effect/...")` で定義すべき。ローカル Symbol ではなく `Symbol.for` を使うことで、CJS/ESM 混在環境やホットリロード環境でも同一のプロトコル識別が保証される。`GlobalValue.ts:42-53` も同様の原則に基づき、グローバルシングルトンの再生成を防止する。

## 実例と分析

### プロトコルの階層構造

Effect-TS のプロトコルは以下の依存関係で層をなしている:

1. **Hash** — 値のハッシュ値を返す `[Hash.symbol](): number`
2. **Equal** (extends Hash) — 値の等価性を判定する `[Equal.symbol](that: Equal): boolean`
3. **Pipeable** — 関数合成チェーンを可能にする `pipe()` メソッド
4. **Inspectable** — `toString()`, `toJSON()`, `[NodeInspectSymbol]()` のデバッグ表現
5. **Effectable** — Effect ワークフローとして扱える `[EffectTypeId]`, `[Symbol.iterator]()`

これらが `EffectPrototype` に集約され、`Option`, `Either`, `Chunk`, `List`, `Context.Tag` など全データ型の基盤となる。

### プロトタイプ合成の実装パターン

Option の実装に見る 3 層構造:

```typescript
// packages/effect/src/internal/effectable.ts:68-85
export const EffectPrototype: Effect.Effect<never> & Equal.Equal = {
  [EffectTypeId]: effectVariance,
  [StreamTypeId]: effectVariance,
  [SinkTypeId]: sinkVariance,
  [ChannelTypeId]: channelVariance,
  [Equal.symbol](that: any) {
    return this === that
  },
  [Hash.symbol]() {
    return Hash.cached(this, Hash.random(this))
  },
  [Symbol.iterator]() {
    return new SingleShotGen(new YieldWrap(this)) as any
  },
  pipe() {
    return pipeArguments(this, arguments)
  }
}
```

```typescript
// packages/effect/src/internal/option.ts:14-25
const CommonProto = {
  ...EffectPrototype,           // 第1層: pipe, Equal, Hash, iterator
  [TypeId]: { _A: (_: never) => _ },  // 第2層: Option 固有の TypeId
  [NodeInspectSymbol]() { return this.toJSON() },
  toString() { return format(this.toJSON()) }
}

// packages/effect/src/internal/option.ts:27-43
const SomeProto = Object.assign(Object.create(CommonProto), {
  _tag: "Some",                 // 第3層: バリアント固有
  [Equal.symbol](that) {       // Equal のオーバーライド
    return isOption(that) && isSome(that) && Equal.equals(this.value, that.value)
  },
  [Hash.symbol]() {
    return Hash.cached(this, Hash.combine(Hash.hash(this._tag))(Hash.hash(this.value)))
  },
  toJSON() {
    return { _id: "Option", _tag: this._tag, value: toJSON(this.value) }
  }
})
```

同一パターンが `Either`（`internal/either.ts:20-67`）、`Chunk`（`Chunk.ts:125-163`）、`List`（`List.ts:100-152`）、`MutableRef`（`MutableRef.ts:27-44`）など全データ型で一貫して使われている。

### dual() による data-first / data-last 両用 API

```typescript
// packages/effect/src/Function.ts:95-128
export const dual: {
  <DataLast extends (...args: Array<any>) => any, DataFirst extends (...args: Array<any>) => any>(
    arity: Parameters<DataFirst>["length"],
    body: DataFirst
  ): DataLast & DataFirst
} = function(arity, body) {
  switch (arity) {
    case 2:
      return function(a, b) {
        if (arguments.length >= 2) {
          return body(a, b)    // data-first: fn(self, arg)
        }
        return function(self: any) {
          return body(self, a)  // data-last: self.pipe(fn(arg))
        }
      }
    // case 3, 4, 5 も同様...
  }
}
```

コードベース全体で 254 箇所以上で使用されている（`Chunk.ts` 43 箇所、`Effect.ts` 3 箇所以上、`Readable.ts` 2 箇所など）。引数の数で data-first/data-last を自動判定するため、同一関数を `pipe` チェーンでもスタンドアロンでも使える。

### TypeId + hasProperty による型ガード

```typescript
// packages/effect/src/internal/option.ts:64
export const isOption = (input: unknown): input is Option.Option<unknown> =>
  hasProperty(input, TypeId)

// packages/effect/src/Readable.ts:36
export const isReadable = (u: unknown): u is Readable<unknown, unknown, unknown> =>
  hasProperty(u, TypeId)
```

`instanceof` ではなく `Symbol.for` ベースの TypeId の存在チェックで型判定する。これにより CJS/ESM の境界やバージョン違いでも正しく型判定できる。

### declare module による型の後付け拡張

```typescript
// packages/effect/src/Effect.ts:168-213
declare module "./Context.js" {
  interface Tag<Id, Value> extends Effect<Value, never, Id> {}
}
declare module "./Either.js" {
  interface Left<E, A> extends Effect<A, E> {}
  interface Right<E, A> extends Effect<A, E> {}
}
declare module "./Option.js" {
  interface None<A> extends Effect<A, Cause.NoSuchElementException> {}
  interface Some<A> extends Effect<A, Cause.NoSuchElementException> {}
}
```

`Option`, `Either`, `Tag` が `Effect` を extends する宣言を、`Effect.ts` 側から `declare module` で後付けする。ランタイムでは `EffectPrototype` のスプレッドで既にプロトコルが付与されているため、型レベルのみの拡張。循環依存を型レベルで解決する手法。

## パターンカタログ

- **Protocol パターン** (分類: 構造)
  - 解決する問題: 多重継承できない言語で複数の横断的振る舞いを型に付与する
  - 適用条件: 複数の独立した振る舞い（等価性、ハッシュ、パイプ等）を多数の型で共有する場合
  - コード例: `Equal.ts:13`, `Hash.ts:19`, `Pipeable.ts:11`
  - 注意点: Symbol キーの衝突を避けるため `Symbol.for("namespace/Name")` の命名規則が必要

- **Prototype Chain Composition** (分類: 生成)
  - 解決する問題: プロトコル実装のボイラープレートを排除し、変更の一括伝播を実現する
  - 適用条件: 共通プロトコルを持つデータ型が多数存在する場合
  - コード例: `internal/effectable.ts:68-131`, `internal/option.ts:14-61`
  - 注意点: `Object.create` でプロトタイプチェーンが深くなりすぎるとプロパティルックアップが遅くなる

- **Dual API パターン** (分類: 振る舞い / Adapter の変形)
  - 解決する問題: パイプスタイル（data-last）と直接呼び出し（data-first）の両方をサポートする
  - 適用条件: 関数型スタイル（pipe）とメソッドチェーンスタイルの両方を提供したい API
  - コード例: `Function.ts:95-128`, `Readable.ts:60-65`
  - 注意点: arity が 0 または 1 の関数には適用できない（`Function.ts:117-118`）

## Good Patterns

- **Symbol.for による跨境 TypeId**: `Symbol.for("effect/Option")` のようにグローバルシンボルレジストリを使い、CJS/ESM 混在・ホットリロード環境でも型識別が壊れない。

```typescript
// packages/effect/src/internal/option.ts:12
const TypeId: Option.TypeId = Symbol.for("effect/Option") as Option.TypeId

// packages/effect/src/internal/option.ts:64
export const isOption = (input: unknown): input is Option.Option<unknown> =>
  hasProperty(input, TypeId)
```

- **Hash のキャッシュ**: `Hash.cached()` でハッシュ値を `Object.defineProperty` で不変プロパティとしてオブジェクトに焼き込み、再計算を防ぐ。`enumerable: false` にすることで JSON シリアライズに影響しない。

```typescript
// packages/effect/src/Hash.ts:169-195
export const cached = function() {
  const self = arguments[0] as object
  const hash = arguments[1] as number
  Object.defineProperty(self, symbol, {
    value() { return hash },
    enumerable: false
  })
  return hash
}
```

- **Inspectable の toJSON → toString → NodeInspect の統一チェーン**: `toJSON()` を唯一の真のソースとし、`toString()` は `format(this.toJSON())` を、`[NodeInspectSymbol]()` は `this.toJSON()` を返す。デバッグ表現が全データ型で一貫する。

```typescript
// packages/effect/src/Inspectable.ts:170-180
export const BaseProto: Inspectable = {
  toJSON() { return toJSON(this) },
  [NodeInspectSymbol]() { return this.toJSON() },
  toString() { return format(this.toJSON()) }
}
```

- **Variance の Phantom Type エンコード**: ランタイムの関数 `(_: never) => _` をダミー値として型パラメータに埋め込み、TypeScript の型推論で共変性を正しく扱わせる。

```typescript
// packages/effect/src/internal/effectable.ts:26-35
export const effectVariance = {
  _R: (_: never) => _,
  _E: (_: never) => _,
  _A: (_: never) => _,
  _V: version.getCurrentVersion()
}
```

## Anti-Patterns / 注意点

- **プロトコル未実装の生オブジェクト混在**: `Data.struct()` を使わずプレーンオブジェクトを作ると `Equal.equals` が `===` にフォールバックし、構造的等価性が失われる。

```typescript
// Bad: プロトコルなしの生オブジェクト
const a = { name: "Alice", age: 30 }
const b = { name: "Alice", age: 30 }
Equal.equals(a, b) // false（参照比較になる）

// Better: Data.struct でプロトコルを付与
const a = Data.struct({ name: "Alice", age: 30 })
const b = Data.struct({ name: "Alice", age: 30 })
Equal.equals(a, b) // true（構造的等価性）
```

- **instanceof による型判定**: バンドラーの tree-shaking やモジュール重複で `instanceof` が壊れるため、`hasProperty(u, TypeId)` パターンを使うべき。

```typescript
// Bad: instanceof は CJS/ESM 混在で壊れうる
if (value instanceof Option) { ... }

// Better: Symbol ベースの TypeId チェック
if (hasProperty(value, TypeId)) { ... }
```

- **プロトタイプの直接変更**: `Object.create(Proto)` で生成したオブジェクトに対して後から `Object.setPrototypeOf` でチェーンを差し替えると、V8 のインラインキャッシュが無効化されパフォーマンスが劣化する。Effect-TS では `Object.create` 時点でプロトタイプを確定し、後から変更しない。

## 導出ルール

- `[MUST]` 複数の型が共有する横断的振る舞いは、基底クラスの継承ではなく Symbol キー付きプロトコルインターフェースで定義する
  - 根拠: Effect-TS では Equal/Hash/Pipeable/Inspectable の 4 プロトコルが 177 以上のモジュールで使われており、多重継承の制約を完全に回避している（`Equal.ts:13`, `Hash.ts:19`）

- `[MUST]` 型の識別には `instanceof` ではなく `Symbol.for()` ベースの TypeId + `hasProperty` 型ガードを使う
  - 根拠: CJS/ESM 混在・ホットリロード・バンドラー重複で `instanceof` が壊れるのに対し、`Symbol.for` はプロセス内でグローバルに一意（`internal/option.ts:12,64`）

- `[SHOULD]` プロトコル実装をプロトタイプオブジェクトに集約し、`Object.create` + `Object.assign` で層状に合成する
  - 根拠: 実装変更が全データ型に自動伝播する。Option/Either/Chunk/List/MutableRef の全てが `EffectPrototype` を起点に合成されている（`internal/effectable.ts:68-85`）

- `[SHOULD]` data-first と data-last の両方をサポートする API は `dual()` パターンで実装し、引数の arity で自動判定する
  - 根拠: コードベース全体で 254 箇所以上使われ、`pipe` チェーンとスタンドアロン呼び出しの両方を単一実装で提供している（`Function.ts:95-128`）

- `[SHOULD]` デバッグ表現は `toJSON()` を唯一のソースとし、`toString()` と Node.js inspect をそこから導出する
  - 根拠: 全データ型が `Inspectable.BaseProto` の 3 メソッドチェーン（toJSON → toString → NodeInspect）で統一され、デバッグ体験が一貫する（`Inspectable.ts:170-180`）

- `[SHOULD]` 不変データのハッシュ値は初回計算後に `Object.defineProperty(enumerable: false)` でキャッシュする
  - 根拠: `Hash.cached` がこのパターンで実装され、HashMap/HashSet での繰り返しルックアップのコストを排除している（`Hash.ts:169-195`）

- `[AVOID]` プロトコルを実装していないプレーンオブジェクトとプロトコル付きオブジェクトを混在させる
  - 根拠: `Equal.equals` がプロトコル非実装オブジェクトに対して参照比較にフォールバックし、意図しない不等価判定が起きる（`Equal.ts:36-86`）

## 適用チェックリスト

- [ ] プロジェクトのデータ型が共有する横断的振る舞い（等価性、シリアライズ、パイプ等）を洗い出し、Symbol キー付きプロトコルとして定義したか
- [ ] 型識別に `instanceof` ではなく `Symbol.for` ベースの TypeId + 型ガード関数を使っているか
- [ ] 共通プロトコルの実装を Proto オブジェクトに集約し、各データ型が `Object.create` で継承しているか
- [ ] API 関数が pipe チェーンとスタンドアロン呼び出しの両方で使えるか（dual パターンの適用検討）
- [ ] `toJSON()` を唯一のデバッグ表現ソースとし、`toString()` と inspect がそこから導出されているか
- [ ] 頻繁にアクセスされるハッシュ値や計算結果を `Object.defineProperty(enumerable: false)` でキャッシュしているか
- [ ] CJS/ESM 混在環境やホットリロード環境でシングルトンやグローバル状態が破壊されないか確認したか
