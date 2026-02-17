# design-philosophy

> リポジトリ: Effect-TS/effect
> 分析日: 2026-02-18

## 概要

Effect-TS/effect は TypeScript に関数型エフェクトシステムを持ち込むライブラリであり、その設計思想は「TypeScript の型システムの限界内で、Scala ZIO / Haskell IO のような型安全なエフェクト管理を実現する」ことにある。成功値・エラー・依存の 3 つの型パラメータ `Effect<A, E, R>` を軸とし、副作用の記述と実行を完全に分離する。このアプローチは「計算の記述をデータとして扱う」という関数型の中核原則を、ジェネレータ構文や `pipe`/`dual` パターンで TypeScript 開発者にとって自然な形に翻訳した点に注目に値する。177 のモジュールにわたって一貫したパターンが適用されており、大規模ライブラリにおける設計の一貫性維持の事例としても学びが多い。

## 背景にある原則

- **計算の記述と実行の分離 (Description-Execution Separation)**: `Effect<A, E, R>` は「実行すべき計算の記述」であり、値そのものではない。`Effect.gen`、`Effect.map`、`Effect.flatMap` で計算を組み立て、`Runtime.runPromise` 等で初めて実行する。この分離により、同じ計算記述に対して異なる実行戦略（テスト用モック、本番環境）を適用できる。根拠: `EffectPrimitive` クラスが `_op` タグで命令を表現するインタプリタパターン (`packages/effect/src/internal/core.ts:127-161`)。

- **エラーの型レベル追跡 (Type-Level Error Tracking)**: 通常の TypeScript では `throw` されるエラーの型情報が失われるが、Effect は `E` 型パラメータでエラーを追跡する。さらに `Cause<E>` で「予期されたエラー」「予期しないエラー (Defect)」「中断」を構造的に分離し、エラー情報を一切捨てない。根拠: `Cause.ts` の冒頭コメント「Effect-TS is very strict about preserving the full information related to a failure. It captures all type of errors into the Cause data type」(`packages/effect/src/Cause.ts:1-22`)。

- **依存性の型レベル管理 (Type-Level Dependency Management)**: `R` 型パラメータで必要な依存を型に刻み、`Context.Tag` / `Layer` でコンパイル時に依存の充足を保証する。依存が未提供なら型エラーになるため、実行時のヌルポインタや未注入エラーを原理的に排除する。根拠: `Layer.ts` のモジュールコメント「recipes for producing bundles of services, given their dependencies」(`packages/effect/src/Layer.ts:1-17`)。

- **API の二重性原則 (Data-First / Data-Last Duality)**: すべてのモジュール操作を `dual` 関数で data-first と data-last の両方のスタイルで呼び出せるようにする。pipe チェーンの可読性と、直接呼び出しの利便性を両立する。根拠: `dual` が 121 ファイルで使用されており、`Array.map`、`Effect.map` など主要 API すべてに適用されている (`packages/effect/src/Function.ts:31-168`)。

## 実例と分析

### インタプリタパターンによるエフェクト表現

Effect の内部実装は、計算を AST (抽象構文木) として構築し、ファイバーランタイムがそれを解釈・実行するインタプリタパターンに基づく。`EffectPrimitive` クラスは `_op` フィールドで命令の種類を識別し、`effect_instruction_i0` ~ `i2` で引数を保持する。

```typescript
// packages/effect/src/internal/core.ts:127-161
class EffectPrimitive {
  public effect_instruction_i0 = undefined
  public effect_instruction_i1 = undefined
  public effect_instruction_i2 = undefined
  public trace = undefined;
  [EffectTypeId] = effectVariance
  constructor(readonly _op: Primitive["_op"]) {}
  // Equal, Hash, pipe, Symbol.iterator を実装
}
```

命令の種類は OpCode として定義される:

```typescript
// packages/effect/src/internal/opCodes/effect.ts:5-83
export const OP_ASYNC = "Async" as const
export const OP_FAILURE = "Failure" as const
export const OP_ON_SUCCESS = "OnSuccess" as const
export const OP_SUCCESS = "Success" as const
export const OP_SYNC = "Sync" as const
export const OP_WHILE = "While" as const
export const OP_ITERATOR = "Iterator" as const
// ...
```

この設計により、計算の組み立て (EffectPrimitive の生成) と実行 (FiberRuntime での解釈) が完全に分離される。

### dual 関数による API 二重性

`dual` は Effect ライブラリ全体の API スタイルの基盤となるパターンで、arity (引数の数) に基づいて data-first と data-last を自動判別する:

```typescript
// packages/effect/src/Function.ts:95-138
export const dual: {
  <DataLast, DataFirst>(arity: Parameters<DataFirst>["length"], body: DataFirst): DataLast & DataFirst
  <DataLast, DataFirst>(isDataFirst: (args: IArguments) => boolean, body: DataFirst): DataLast & DataFirst
} = function(arity, body) {
  if (typeof arity === "function") {
    return function() {
      if (arity(arguments)) { return body.apply(this, arguments) }
      return ((self: any) => body(self, ...arguments)) as any
    }
  }
  switch (arity) {
    case 2:
      return function(a, b) {
        if (arguments.length >= 2) { return body(a, b) }
        return function(self: any) { return body(self, a) }
      }
    // case 3, 4, 5 も同様にインライン展開
  }
}
```

これにより同一関数が 2 つのスタイルで利用できる:

```typescript
// packages/effect/src/Array.ts:2498-2503
export const map: {
  <S extends ReadonlyArray<any>, B>(f: (a: ReadonlyArray.Infer<S>, i: number) => B): (self: S) => ReadonlyArray.With<S, B>
  <S extends ReadonlyArray<any>, B>(self: S, f: (a: ReadonlyArray.Infer<S>, i: number) => B): ReadonlyArray.With<S, B>
} = dual(2, <A, B>(self: ReadonlyArray<A>, f: (a: A, i: number) => B): Array<B> => self.map(f))
```

### ジェネレータ構文によるモナディック合成の平坦化

`Effect.gen` は TypeScript のジェネレータ構文を活用して、`flatMap` チェーンをフラットな手続き的コードとして書けるようにする:

```typescript
// packages/effect/src/internal/core.ts:1419-1422
export const gen: typeof Effect.gen = function() {
  const f = arguments.length === 1 ? arguments[0] : arguments[1].bind(arguments[0])
  return fromIterator(() => f(pipe))
}
```

内部では `SingleShotGen` が `yield*` による値の取り出しを 1 回限りのイテレータとして実装する:

```typescript
// packages/effect/src/internal/singleShotGen.ts:1-35
export class SingleShotGen<T, A> implements Generator<T, A> {
  called = false
  constructor(readonly self: T) {}
  next(a: A): IteratorResult<T, A> {
    return this.called
      ? ({ value: a, done: true })
      : (this.called = true, ({ value: this.self, done: false }))
  }
}
```

### Opaque Type (ブランド型) と TypeId パターン

Effect は `unique symbol` を TypeId として使い、型の同一性を `Symbol.for()` で保証する。これにより CJS/ESM 混在環境やホットリロード時も型の一致判定が安定する:

```typescript
// packages/effect/src/internal/effectable.ts:14
export const EffectTypeId: Effect.EffectTypeId = Symbol.for("effect/Effect") as Effect.EffectTypeId
```

```typescript
// packages/effect/src/GlobalValue.ts:42-53
export const globalValue = <A>(id: unknown, compute: () => A): A => {
  if (!globalStore) {
    globalThis[globalStoreId] ??= new Map()
    globalStore = globalThis[globalStoreId] as Map<unknown, any>
  }
  if (!globalStore.has(id)) { globalStore.set(id, compute()) }
  return globalStore.get(id)!
}
```

### Variance Annotation による型安全性

Effect は TypeScript の構造的型付けの意図しない型の互換性を防ぐため、phantom type として分散 (Variance) を明示的にエンコードする:

```typescript
// packages/effect/src/Types.ts:301-333
export type Covariant<A> = (_: never) => A       // 共変
export type Contravariant<A> = (_: A) => void     // 反変
export type Invariant<A> = (_: A) => A            // 不変
```

```typescript
// packages/effect/src/Effect.ts:111
export interface Effect<out A, out E = never, out R = never>
  extends Effect.Variance<A, E, R>, Pipeable { ... }
```

### 公開 API と内部実装の分離

型定義は `src/*.ts` に置き、実装は `src/internal/` に隠蔽する。公開モジュールは型と re-export のみで構成され、内部実装の変更が公開 API に影響しない:

```typescript
// packages/effect/src/Scope.ts (公開API: 型定義のみ)
export const ScopeTypeId: unique symbol = core.ScopeTypeId
export interface Scope extends Pipeable { readonly [ScopeTypeId]: ScopeTypeId; ... }

// packages/effect/src/internal/core.ts (内部実装)
// 実際の ScopeImpl クラスが定義される
```

## パターンカタログ

- **Interpreter パターン** (分類: 振る舞い)
  - 解決する問題: 計算の記述と実行の分離。テスト容易性、合成可能性の確保
  - 適用条件: 複数の実行戦略が必要な場合、計算を合成・変換したい場合
  - コード例: `packages/effect/src/internal/core.ts:86-100` (Primitive 型定義), `packages/effect/src/internal/fiberRuntime.ts` (解釈ループ)
  - 注意点: 単純な処理には過剰設計になりうる。中間表現のオーバーヘッドを許容できる場面で使う

- **Tagged Union / Discriminated Union** (分類: 構造)
  - 解決する問題: 型安全な分岐処理。`_tag` フィールドによる網羅的パターンマッチング
  - 適用条件: 複数のバリアントを持つデータ型
  - コード例: `Option` (`_tag: "None" | "Some"`)、`Either` (`_tag: "Left" | "Right"`)、`Exit` (`_tag: "Success" | "Failure"`)
  - 注意点: `_tag` フィールド名を統一すること。Effect では `_op` も並用

- **Newtype / Opaque Type** (分類: 構造)
  - 解決する問題: 構造的に同一だが意味的に異なる型を区別する
  - 適用条件: `string` や `number` の意味論的区別が必要な場面
  - コード例: `packages/effect/src/Brand.ts:56-60` (`Brand` インタフェース), TypeId パターン
  - 注意点: TypeScript の構造的型付けを名目的にするため `unique symbol` を使う

## Good Patterns

- **dual による API 二重性**: 同一関数を data-first (`Array.map(arr, fn)`) と data-last (`pipe(arr, Array.map(fn))`) の両方で使えるようにする。arity ベースの分岐でオーバーヘッドを最小化し、switch 文でインライン展開することで hot path の性能を維持している。

```typescript
// packages/effect/src/Array.ts:2498-2503
export const map = dual(2, (self, f) => self.map(f))
// 使い方: Array.map([1,2,3], n => n * 2) or pipe([1,2,3], Array.map(n => n * 2))
```

- **Symbol.for() による TypeId の安定化**: CJS/ESM 混在環境やバンドラーによる重複読み込みでも `Symbol.for("effect/Effect")` は常に同一値を返すため、`instanceof` に頼らない型判定が可能になる。

```typescript
// packages/effect/src/internal/effectable.ts:14
export const EffectTypeId = Symbol.for("effect/Effect") as Effect.EffectTypeId
```

- **GlobalValue による singleton の安定管理**: ホットリロードやモジュール重複時にもグローバル状態を安全に共有する。WeakMap キャッシュやデフォルトサービスの一意性保証に使われる。

```typescript
// packages/effect/src/GlobalValue.ts:42-53
export const globalValue = <A>(id: unknown, compute: () => A): A => {
  globalThis[globalStoreId] ??= new Map()
  // ...compute は初回のみ実行
}
```

- **ジェネレータ構文でモナディック合成を手続き的に記述**: `yield*` で Effect の成功値を取り出す記法により、`flatMap` のネストを回避。TypeScript の既存構文を活用するため追加のコンパイラプラグインが不要。

```typescript
// Effect.gen の利用例 (packages/effect/src/Effect.ts:2745-2755)
const program = Effect.gen(function* () {
  const amount = yield* fetchTransactionAmount
  const rate = yield* fetchDiscountRate
  const discounted = yield* applyDiscount(amount, rate)
  return `Final: ${addServiceCharge(discounted)}`
})
```

## Anti-Patterns / 注意点

- **エラーの型情報を捨てる `as any` キャスト**: Effect はエラーを `E` 型パラメータで追跡するが、`catchAll` で握りつぶしたり `as any` でキャストすると型追跡の恩恵が失われる。

```typescript
// Bad: エラー型を any で消す
const result = Effect.runSync(program as Effect.Effect<string, any>)

// Better: 型を保持し、明示的にハンドリングする
const result = program.pipe(
  Effect.catchTag("NetworkError", (e) => Effect.succeed(fallback)),
  Effect.runSync
)
```

- **Effect 外でのスロー**: `Effect.gen` 内で `throw` を使うと Cause のトラッキングを迂回し、エラーが `Die` (予期しないエラー) として処理される。エフェクトシステム内では `Effect.fail` を使う。

```typescript
// Bad: throw で Cause トラッキングを迂回
const program = Effect.gen(function* () {
  throw new Error("something went wrong")
})

// Better: Effect.fail でエラー型を追跡
const program = Effect.gen(function* () {
  return yield* Effect.fail(new MyError("something went wrong"))
})
```

- **Layer を使わず直接サービスを注入する**: `Effect.provideService` のみで依存を注入するとサービスのライフサイクル管理が手動になる。`Layer` を使えばリソースの自動解放・共有が保証される。

```typescript
// Bad: 手動でリソース管理
const db = await createDbConnection()
const program = myEffect.pipe(Effect.provideService(DbTag, db))
// db の解放を忘れるリスク

// Better: Layer でライフサイクルを宣言的に管理
const DbLive = Layer.scoped(DbTag,
  Effect.acquireRelease(createDbConnection, (db) => db.close())
)
```

## 導出ルール

- `[MUST]` 副作用を含む計算は「記述」と「実行」を分離し、記述を純粋なデータ構造として扱う
  - 根拠: Effect のすべての計算は EffectPrimitive として記述され、FiberRuntime が解釈する。この分離により合成・テスト・再実行が容易になる (`packages/effect/src/internal/core.ts:127-161`)

- `[MUST]` 公開 API と内部実装を物理的に分離し、公開モジュールは型定義と re-export のみにする
  - 根拠: Effect は `src/*.ts` (型 + re-export) と `src/internal/*.ts` (実装) を厳密に分離しており、177 モジュールの内部リファクタリングが公開 API に影響しない構造を実現している

- `[MUST]` エラーを型パラメータで追跡し、未処理のエラーをコンパイル時に検出可能にする
  - 根拠: `Effect<A, E, R>` の `E` 型パラメータにより、すべてのエラーが型レベルで可視化される。`Cause<E>` がさらに expected/unexpected/interrupt を区別する (`packages/effect/src/Cause.ts:1-22`)

- `[SHOULD]` 関数 API を data-first と data-last の両方のスタイルで提供し、呼び出し元が文脈に応じて選択できるようにする
  - 根拠: `dual` 関数が 121 ファイルで使用されており、pipe チェーンと直接呼び出しの両方を統一的にサポートしている (`packages/effect/src/Function.ts:95-168`)

- `[SHOULD]` TypeScript でモジュールの型同一性が必要な場合、`Symbol.for()` で TypeId を定義し、`instanceof` に依存しない型判定を行う
  - 根拠: CJS/ESM 混在環境やバンドラーの重複解決で `instanceof` が偽陰性を返す問題を回避するため、Effect は全型に `Symbol.for("effect/...")` の TypeId を付与している (`packages/effect/src/internal/effectable.ts:14-23`)

- `[SHOULD]` TypeScript の構造的型付けで意図しない互換性が生じる場面では、phantom type で分散 (Variance) を明示的にエンコードする
  - 根拠: `Covariant<A> = (_: never) => A`、`Contravariant<A> = (_: A) => void` の型レベルエンコードにより、Effect/Layer/Context の型パラメータの分散が正確に制御されている (`packages/effect/src/Types.ts:281-333`)

- `[SHOULD]` ジェネレータ構文を活用してモナディックな計算チェーンを手続き的に記述し、ネストの深い `flatMap` チェーンを回避する
  - 根拠: `Effect.gen(function* () { const x = yield* ... })` により、コンパイラプラグイン不要で `do` 記法相当の平坦な記述が可能 (`packages/effect/src/internal/core.ts:1419-1422`)

- `[AVOID]` グローバルな singleton が必要な場面で通常のモジュールスコープ変数を使い、ホットリロードやバンドラーの重複解決で状態が壊れるリスクを放置する
  - 根拠: Effect は `globalValue` で `globalThis` 上にバージョン付きストアを持ち、HMR やモジュール重複時にも singleton の安定性を保証している (`packages/effect/src/GlobalValue.ts:42-53`)

## 適用チェックリスト

- [ ] 副作用を含む処理を「記述」と「実行」に分離できているか。特にテスト時にモックランタイムを差し替え可能か
- [ ] エラーが型レベルで追跡されているか。`catch` ブロックの `unknown` 型に頼っていないか
- [ ] 依存性が型パラメータに反映されており、未注入がコンパイル時に検出されるか
- [ ] ライブラリの公開 API と内部実装が物理的に分離されているか。内部リファクタリングが利用者に影響しない構造か
- [ ] `Symbol.for()` を使った TypeId パターンで、CJS/ESM 混在環境での型判定が安定しているか
- [ ] `pipe` チェーンと直接呼び出しの両方をサポートする `dual` パターンが検討されているか
- [ ] 構造的型付けで意図しない型の互換性が生じる箇所に、phantom type や branded type が適用されているか
- [ ] グローバル状態が必要な場合、ホットリロード耐性のある保存メカニズム (`globalValue` 等) を使っているか
