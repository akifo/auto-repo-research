# Effect Model

> リポジトリ: Effect-TS/effect
> 分析日: 2026-02-18

## 概要

`Effect<A, E, R>` の三型パラメータモデルは、成功値(A)・エラー型(E)・依存型(R) を単一の型に統合し、合成時に型安全な自動伝播を実現する仕組みである。TypeScript の型システム上でモナディック合成・DI・エラーハンドリングを静的に保証する点が注目に値する。特に `never` をデフォルト値として使い、未使用の型パラメータを「消す」設計と、`Covariant`/`Contravariant` の分散マーカーによる合成時の自動 union 化が、このモデルの中核をなしている。

## 背景にある原則

- **型パラメータで副作用の全容を宣言する**: 成功・失敗・依存の3軸を型レベルで追跡することで、合成時の漏れをコンパイル時に検出する。`Effect<A, E, R>` は「この計算は R を必要とし、E で失敗するか A で成功する」という契約を型シグネチャだけで表現する。(`packages/effect/src/Effect.ts:111`)
- **never を「なし」の表現に使い、union で合成する**: E と R のデフォルトが `never` であるため、`never | SomeError` は `SomeError` に単純化される。合成関数（`flatMap`, `zip`, `all` 等）が E と R を union で結合するだけで、型の自動伝播が成立する。(`packages/effect/src/Effect.ts:111`, `packages/effect/src/internal/core.ts:746-762`)
- **dual API パターンでデータファースト/ラストを統一する**: すべてのコンビネータが `dual` ヘルパーを通じて data-first と data-last 両方の呼び出しをサポートし、`pipe` チェーンとスタンドアロン呼び出しの双方で同一の型推論を提供する。(`packages/effect/src/Function.ts:95-125`)
- **タグ付きエラーで discriminated union ハンドリングを可能にする**: エラー型に `_tag` フィールドを持たせることで、`catchTag`/`catchTags` が TypeScript の narrowing を活用して特定エラーだけを型安全にハンドリングし、残りのエラーを E から自動除去する。(`packages/effect/src/Effect.ts:3882-3890`)

## 実例と分析

### 三型パラメータの設計と never デフォルト

`Effect<A, E = never, R = never>` は全型パラメータを `out`（共変）で宣言している。E と R のデフォルトが `never` であることにより、エラーも依存もない計算は `Effect<A>` と簡潔に書ける。

```typescript
// packages/effect/src/Effect.ts:111
export interface Effect<out A, out E = never, out R = never>
  extends Effect.Variance<A, E, R>, Pipeable { ... }
```

`succeed` は `Effect<A>` を返す。E も R も `never` なので省略される:

```typescript
// packages/effect/src/Effect.ts:3160
export const succeed: <A>(value: A) => Effect<A> = core.succeed
```

`fail` は `Effect<never, E>` を返す。成功値は `never`（到達しない）、依存もない:

```typescript
// packages/effect/src/Effect.ts:2575
export const fail: <E>(error: E) => Effect<never, E> = core.fail
```

### 合成時の型自動伝播

`flatMap` のシグネチャを見ると、E と R が union（`|`）で結合されることが分かる:

```typescript
// packages/effect/src/internal/core.ts:746-753
export const flatMap = dual<
  <A, B, E1, R1>(
    f: (a: A) => Effect.Effect<B, E1, R1>
  ) => <E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<B, E1 | E, R1 | R>,
  <A, E, R, B, E1, R1>(
    self: Effect.Effect<A, E, R>,
    f: (a: A) => Effect.Effect<B, E1, R1>
  ) => Effect.Effect<B, E | E1, R | R1>
>(...)
```

`never | X` は常に `X` に簡約されるため、エラーや依存が「ない」Effect と「ある」Effect を合成しても余計な型情報が増えない。

`zip` も同様のパターン:

```typescript
// packages/effect/src/Effect.ts:12551-12561
<A2, E2, R2>(
  that: Effect<A2, E2, R2>,
  ...
): <A, E, R>(self: Effect<A, E, R>) => Effect<[A, A2], E2 | E, R2 | R>
```

### Tag と R 型パラメータによる DI

`Context.Tag` は `Effect<Value, never, Id>` を extend しており、Tag 自体が Effect として yield できる:

```typescript
// packages/effect/src/Effect.ts:168-171
declare module "./Context.js" {
  interface Tag<Id, Value> extends Effect<Value, never, Id> {
    [Symbol.iterator](): EffectGenerator<Tag<Id, Value>>
  }
}
```

このため `yield* MyTag` だけでサービスを取得でき、R 型パラメータに `MyTag` の Id が自動で union される。

```typescript
// packages/effect/src/Effect.ts:7453-7459 (ドキュメント内の例)
const program = Effect.gen(function*() {
  const service1 = yield* Service1  // R に Service1 が追加
  const service2 = yield* Service2  // R に Service2 が追加
  return "some result"
})
// program: Effect<string, never, Service1 | Service2>
```

`provide`/`provideService` は `Exclude<R, ProvidedService>` で R から依存を除去する:

```typescript
// packages/effect/src/Effect.ts:7556-7557
<ROut, E2, RIn>(
  layer: Layer.Layer<ROut, E2, RIn>
): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E | E2, RIn | Exclude<R, ROut>>
```

### エラーチャネルの精密な制御

`catchTag` は discriminated union の `_tag` を使い、特定のエラーだけをハンドリングしつつ、ハンドルされたエラーを E から `Exclude` で除去する:

```typescript
// packages/effect/src/Effect.ts:3882-3890
export const catchTag: {
  <E, const K extends ..., A1, E1, R1>(
    ...args: [...tags: K, f: (e: Extract<NoInfer<E>, { _tag: K[number] }>) => Effect<A1, E1, R1>]
  ): <A, R>(self: Effect<A, E, R>) => Effect<A | A1, Exclude<E, { _tag: K[number] }> | E1, R | R1>
  ...
}
```

`either` は E を `Either` に包んで E を `never` に変える（エラーチャネルを消す）:

```typescript
// packages/effect/src/Effect.ts:8180
export const either: <A, E, R>(self: Effect<A, E, R>) => Effect<Either.Either<A, E>, never, R>
```

`orDie` は E を `never` に変えて失敗をデフェクト（回復不能エラー）に変換する:

```typescript
// packages/effect/src/Effect.ts:11265
export const orDie: <A, E, R>(self: Effect<A, E, R>) => Effect<A, never, R>
```

### Option/Either の Effect 統合（Unify）

Option と Either が Effect を extend しており、ジェネレータ構文内で直接 yield できる:

```typescript
// packages/effect/src/Effect.ts:206-220
declare module "./Option.js" {
  interface None<A> extends Effect<A, Cause.NoSuchElementException> { ... }
  interface Some<A> extends Effect<A, Cause.NoSuchElementException> { ... }
}
declare module "./Either.js" {
  interface Left<E, A> extends Effect<A, E> { ... }
  interface Right<E, A> extends Effect<A, E> { ... }
}
```

これにより `yield* Option.some(42)` が Effect コンテキストで直接使え、None の場合は自動的に `NoSuchElementException` が E に伝播する。

## コード例

```typescript
// packages/effect/src/internal/effectable.ts:26-35
// 分散マーカーの実装。実行時に使われる関数だが、型システムに対して共変性を宣言する
export const effectVariance = {
  _R: (_: never) => _,
  _E: (_: never) => _,
  _A: (_: never) => _,
  _V: version.getCurrentVersion()
}
```

```typescript
// packages/effect/src/internal/core.ts:127-161
// Effect の内部表現。すべての Effect は EffectPrimitive として統一される
class EffectPrimitive {
  public effect_instruction_i0 = undefined
  public effect_instruction_i1 = undefined
  public effect_instruction_i2 = undefined
  public trace = undefined;
  [EffectTypeId] = effectVariance
  constructor(readonly _op: Primitive["_op"]) {}
  // ...
  pipe() {
    return pipeArguments(this, arguments)
  }
  [Symbol.iterator]() {
    return new SingleShotGen(new YieldWrap(this))
  }
}
```

```typescript
// packages/effect/src/internal/core.ts:1419-1421
// gen の実装: ジェネレータ関数を受け取り、fromIterator で Effect に変換
export const gen: typeof Effect.gen = function() {
  const f = arguments.length === 1 ? arguments[0] : arguments[1].bind(arguments[0])
  return fromIterator(() => f(pipe))
}
```

```typescript
// packages/effect/src/Data.ts:585-596
// TaggedError: _tag 付きエラークラスを生成するファクトリ
export const TaggedError = <Tag extends string>(tag: Tag):
  new<A extends Record<string, any> = {}>(
    args: ...
  ) => Cause.YieldableError & { readonly _tag: Tag } & Readonly<A> => {
  const O = {
    BaseEffectError: class extends Error<{}> {
      readonly _tag = tag
    }
  }
  ;(O.BaseEffectError.prototype as any).name = tag
  return O.BaseEffectError as any
}
```

## パターンカタログ

- **Phantom Type パターン** (分類: 型レベル)
  - 解決する問題: 実行時には存在しないが型レベルで制約を表現したい
  - 適用条件: 型パラメータが合成時に自動的に union/intersection されるべき場合
  - コード例: `packages/effect/src/Types.ts:301` (`Covariant<A> = (_: never) => A`)
  - 注意点: 分散マーカーの方向を間違えると合成時の型推論が壊れる。A と E は共変（出力）、Layer の ROut は反変（入力として消費される）

- **Discriminated Union + 型レベル除去** (分類: 振る舞い)
  - 解決する問題: union 型の一部だけをハンドリングし、残りをコンパイル時に追跡したい
  - 適用条件: エラー型が `_tag` でタグ付けされている場合
  - コード例: `packages/effect/src/Effect.ts:3882-3890` (`catchTag`)
  - 注意点: `Exclude<E, { _tag: K }>` は E が union 型でないと意味をなさない

- **Dual Function パターン** (分類: API 設計)
  - 解決する問題: data-first（`f(data, arg)`）と data-last（`pipe(data, f(arg))`）の二重定義を避けたい
  - 適用条件: 関数が最低2引数あり、最初の引数がデータ型である場合
  - コード例: `packages/effect/src/Function.ts:95-125` (`dual`)
  - 注意点: arity ベースの判定は引数の数が同じオーバーロードでは使えない。その場合は述語関数を渡す

## Good Patterns

- **never デフォルトによる段階的型付け**: `Effect<A, E = never, R = never>` により、単純な計算は `Effect<number>` と書け、エラーや依存が増えたら型が自動で拡張される。開発者がすべての型パラメータを意識する必要がない。

```typescript
// 単純な場合: Effect<number>
const simple = Effect.succeed(42)

// エラーが追加: Effect<number, Error>
const withError = Effect.flatMap(simple, (n) =>
  n > 0 ? Effect.succeed(n) : Effect.fail(new Error("negative"))
)

// 依存が追加: Effect<number, Error, Database>
const withDep = Effect.flatMap(withError, (n) =>
  Effect.flatMap(Database, (db) => db.query(n))
)
```

- **Either/Option の Effect 統合**: 既存のデータ型を Effect のサブタイプにすることで、ジェネレータ構文内でシームレスに扱える。分岐のためのボイラープレートが不要になる。

```typescript
// packages/effect/src/Effect.ts:206-214
// Option.None は Effect<A, NoSuchElementException> として振る舞う
// ジェネレータ内で yield* するだけで自動的にエラーハンドリングされる
```

- **Cause による損失なしエラーモデル**: `Cause<E>` が `Fail | Die | Interrupt | Sequential | Parallel` の再帰構造を持ち、並行・逐次エラーの全履歴を保持する。エラー情報が握りつぶされない。

```typescript
// packages/effect/src/Cause.ts:254-260
export type Cause<E> =
  | Empty
  | Fail<E>
  | Die
  | Interrupt
  | Sequential<E>
  | Parallel<E>
```

## Anti-Patterns / 注意点

- **orDie の安易な使用**: `orDie` は E を `never` に変えるが、実行時にはエラーが発生し得る。型から消えるだけでエラーが消えるわけではなく、未処理のデフェクトとしてファイバーを殺す。

```typescript
// Bad: エラーを握りつぶして型を綺麗にする
const bad = myEffect.pipe(Effect.orDie)

// Better: 適切にハンドリングしてから型を消す
const better = myEffect.pipe(
  Effect.catchTag("NetworkError", (e) =>
    Effect.succeed(fallbackValue)
  )
)
```

- **R パラメータの provide 忘れ**: `Effect.provide` なしで `Effect.runPromise` に渡そうとすると型エラーになる。これは意図的な設計だが、R が複雑な union になるとどの依存が不足しているか分かりにくくなる。

```typescript
// Bad: R が never でないのに run しようとする
// Effect.runPromise(program) // 型エラー: R = Service1 | Service2

// Better: Layer で全依存を provide してから run
const runnable = program.pipe(
  Effect.provide(Layer.mergeAll(Service1Live, Service2Live))
)
Effect.runPromise(runnable) // OK: R = never
```

- **エラー型に _tag を付け忘れる**: `catchTag` は `_tag` プロパティに依存しているため、素の `Error` や `string` をエラー型に使うと discriminated union ハンドリングが利用できない。

```typescript
// Bad: 素の string をエラーに使う
const bad = Effect.fail("something went wrong")

// Better: Data.TaggedError でタグ付きエラーを定義
class NetworkError extends Data.TaggedError("NetworkError")<{
  readonly url: string
  readonly status: number
}>() {}
```

## 導出ルール

- `[MUST]` 複数の失敗モードを持つ計算のエラー型は discriminated union（`_tag` 付き）で定義する
  - 根拠: Effect-TS の `catchTag`/`catchTags` は `_tag` フィールドを前提に `Exclude` で型を除去する設計であり、素の string/Error ではこの型レベルのハンドリングが利用できない（`Effect.ts:3882-3890`）
- `[MUST]` 合成可能な計算型を設計するとき、未使用の型パラメータのデフォルトは `never` にする
  - 根拠: `never` は union の単位元（`never | X = X`）であるため、合成時に不要な型情報が蓄積しない。Effect-TS は E と R のデフォルトを `never` にすることで段階的な型付けを実現している（`Effect.ts:111`）
- `[SHOULD]` data-first と data-last の両方をサポートする API は、arity ベースの分岐で単一実装から両形式を提供する
  - 根拠: Effect-TS の `dual` は引数の数で data-first/data-last を判定し、一つの実装から二つの呼び出し規約を生成する。API の表面積を半減させつつ pipe チェーンとスタンドアロン呼び出しの両方を型安全に支える（`Function.ts:95-125`）
- `[SHOULD]` 回復可能なエラー（E）と回復不能なデフェクト（Die）を型レベルで区別する
  - 根拠: Cause の `Fail<E>` と `Die` の区別により、ビジネスロジック上のエラーとプログラムバグを別チャネルで扱える。E に載せるのは「呼び出し元が対処すべきエラー」のみとし、プログラムバグは Die に任せる（`Cause.ts:254-260`）
- `[SHOULD]` 依存注入は型パラメータで追跡し、`Exclude` で provide 済みの依存を除去する設計にする
  - 根拠: Effect-TS の `provide` は `Exclude<R, ROut>` で R から提供済みの依存を除去し、未提供の依存をコンパイル時に検出する。全依存が provide されると `R = never` になり runnable になる（`Effect.ts:7556`）
- `[AVOID]` 型パラメータの分散方向（共変/反変）を設計時に検討せずに決める
  - 根拠: Effect-TS は A と E を共変（出力）、Layer の ROut を反変（消費される）として宣言しており、これが合成時の型推論の正確さを担保している。分散方向の誤りは、合成時の型エラーまたは型安全性の欠如につながる（`Types.ts:281-321`, `Layer.ts:75-81`）

## 適用チェックリスト

- [ ] 自前の計算型を設計する際、未使用の型パラメータのデフォルトを `never` に設定しているか
- [ ] エラー型に `_tag` フィールドを持たせ、discriminated union として定義しているか
- [ ] 合成関数（flatMap, zip 等）のシグネチャで E と R を union（`|`）で結合しているか
- [ ] DI 用の型パラメータを `Exclude` で除去する provide/inject メカニズムを設計しているか
- [ ] 回復可能なエラー（ビジネスエラー）と回復不能なデフェクト（バグ）を区別しているか
- [ ] data-first / data-last 両対応の API を検討する際、`dual` パターンの採用を評価したか
- [ ] 型パラメータの分散方向（`Covariant`/`Contravariant`/`Invariant`）を意図的に選択しているか
- [ ] 既存のデータ型（Option, Either 等）を計算型のサブタイプにして統一的に扱えるか検討したか
