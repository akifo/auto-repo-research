# testing-practices

> リポジトリ: Effect-TS/effect
> 分析日: 2026-02-18

## 概要

Effect-TS/effect のテスト基盤を分析する。このリポジトリでは、Effect（代数的エフェクトシステム）の非同期・並行処理コードを安全にテストするため、`@effect/vitest` というカスタムテストユーティリティパッケージを自作し、30以上のパッケージで統一的に運用している。`it.effect` / `it.scoped` / `it.live` によるテストランナーの使い分け、Schema からの Arbitrary 自動導出によるプロパティベーステスト、TestClock による決定的な時間制御、そしてドメイン特化アサーションの設計が特に注目に値する。

## 背景にある原則

- **エフェクトフルコードにはエフェクトフルなテストランナーを**: Effect の `Effect.gen(function*() {...})` パターンで記述されたコードを、`Effect.runSync` で手動ラップしてテストするのではなく、テストランナー側で Effect の実行ライフサイクル（リソース管理、ファイバー割り込み、スコープ解放）を自動管理する。これにより、テストコードが「Effect を書く」ことだけに集中できる（`packages/vitest/src/internal/internal.ts:28-56` の `runPromise` 実装）。

- **テスト環境の明示的な選択を強制する**: `it.effect`（TestClock/TestRandom 付き）と `it.live`（実環境）を明確に分離する。これにより「テストが成功したのは TestClock のおかげか、実時間でも再現可能か」が曖昧にならない（`vitest.shared.ts` ではデフォルトで concurrent 実行かつ `fakeTimers: { toFake: undefined }` を設定し、ネイティブタイマーの偽装は行わない方針）。

- **テストインフラ自体もテスト対象にする**: `@effect/vitest` パッケージには `packages/vitest/test/index.test.ts` で `it.effect` / `it.scoped` / `it.live` / `layer()` / `it.prop` のすべての API がテストされており、テストユーティリティの正当性を保証している。

- **スキーマ定義からテストデータ生成を導出する**: `Schema` から `Arbitrary` を自動導出し、プロパティベーステストに渡す仕組み。テストデータの手書きによるバイアスを排除し、スキーマ変更時にテストデータが自動追従する（`packages/vitest/src/internal/internal.ts:121-156`）。

## 実例と分析

### it.effect パターン: Effect 実行のテストランナー統合

`it.effect` は Effect プログラムをテストケースとして登録する。内部では Effect をファイバーとしてフォークし、テスト終了時に割り込み→リソース解放を行う。テスト本体は `Effect.gen(function*() {...})` で記述し、`yield*` で Effect を実行する。

コードベース全体で 1000 件以上の `it.effect` 呼び出しが存在し、統一的なパターンとして徹底されている。`packages/effect/test/` 以下のほぼすべてのテストファイルが `import { describe, it } from "@effect/vitest"` から始まる。

### it.scoped: リソースライフサイクルの自動管理

`it.scoped` は `Effect.acquireRelease` や `Scope` を必要とするテストに使用する。`it.effect` + `Effect.scoped` を手動で組み合わせる必要がなく、テスト終了時にスコープが自動的にクローズされる。`packages/effect/test/Pool.test.ts` ではプール管理テスト全体が `it.scoped` で書かれ、リソースリークの検証が簡潔になっている。

### layer(): テスト間の依存注入と共有

`layer()` はテストスイート全体でサービスレイヤーを共有する仕組みである。`beforeAll` / `afterAll` で Layer のビルドとスコープ解放を自動管理し、ネストも可能。`it.layer()` でテストグループ内にさらに Layer を追加できる。

`packages/sql/test/SqlPersistedQueueTest.ts` では、DB クライアントレイヤーをパラメータとして受け取り、SQLite / LibSQL / PostgreSQL で同一テストスイートを再利用するパターンが使われている。

### assert ユーティリティ: ドメイン特化アサーション

`@effect/vitest/utils` は `Option` / `Either` / `Exit` / `Cause` に特化したアサーション関数群を提供する。`assertSome` / `assertNone` / `assertLeft` / `assertRight` / `assertSuccess` / `assertFailure` などがあり、型ガード（type narrowing）を伴うため、アサーション後の変数が正しい型に絞り込まれる。

加えて、`assertEquals` は Effect 独自の `Equal.equals` トレイトによる構造的等価性を検証する。vitest の `expect` は JavaScript ネイティブの等価性しか理解しないため、Effect の代数的データ型を正しく比較できない。

### addEqualityTesters: vitest 組み込み比較のカスタマイズ

`vitest.setup.ts` で `addEqualityTesters()` を呼ぶことで、vitest の `expect().toEqual()` / `expect().toMatchObject()` が Effect の `Equal.equals` トレイトを理解するようになる。`packages/vitest/test/equality-tester.test.ts` で `Option` / `Either` / `Exit` / `Data.struct` に対する `toStrictEqual` / `toMatchObject` の動作が検証されている。

### it.prop: Schema 統合プロパティベーステスト

`it.prop` および `it.effect.prop` は、fast-check の `fc.assert` / `fc.property` をラップし、Schema や `Arbitrary` を直接渡せる。配列形式とオブジェクト形式の2つのシグネチャがあり、オブジェクト形式では `{ a: Schema.String, b: FastCheck.integer() }` のように名前付きで記述できる。

`packages/vitest/test/advent-of-pbt-2024/day-1.test.ts` では `Schema.Class` からの Arbitrary 導出と `{ fails: true, fastCheck: { seed, path } }` による失敗再現オプションが使われている。

### TestClock による決定的時間テスト

`it.effect` は自動的に `TestContext` を提供し、`TestClock` が利用可能になる。`TestClock.adjust` で時間を進めることで、`Effect.sleep` や `Schedule` に依存するコードを決定的にテストできる。`packages/effect/test/Schedule.test.ts` や `packages/effect/test/RcMap.test.ts` で広範に使用されている。

### flakyTest: 非決定的テストの明示的な扱い

`it.flakyTest` は `Effect.retry` ベースのリトライラッパーで、最大10回リトライかつタイムアウト（デフォルト30秒）を設定する。非決定的なテストを「暗黙的に flaky」として放置するのではなく、明示的に `flakyTest` でマークする規約になっている。`packages/effect/test/Effect/memoization.test.ts` では Random 依存のテストに使用されている。

## コード例

```ts
// packages/effect/test/Deferred.test.ts:1-13
import { describe, it } from "@effect/vitest"
import { assertFalse, assertTrue, deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { Deferred, Effect, Exit, Option, pipe, Ref } from "effect"

describe("Deferred", () => {
  it.effect("complete a deferred using succeed", () =>
    Effect.gen(function*() {
      const deferred = yield* Deferred.make<number>()
      const success = yield* Deferred.succeed(deferred, 32)
      const result = yield* Deferred.await(deferred)
      assertTrue(success)
      strictEqual(result, 32)
    }))
```

```ts
// packages/effect/test/Pool.test.ts:6-17
it.scoped("preallocates pool items", () =>
  Effect.gen(function*() {
    const count = yield* Ref.make(0);
    const get = Effect.acquireRelease(
      Ref.updateAndGet(count, (n) => n + 1),
      () => Ref.update(count, (n) => n - 1),
    );
    yield* Pool.make({ acquire: get, size: 10 });
    yield* Effect.repeat(Ref.get(count), { until: (n) => n === 10 });
    const result = yield* Ref.get(count);
    strictEqual(result, 10);
  }));
```

```ts
// packages/vitest/test/index.test.ts:107-123
layer(Foo.Live)((it) => {
  it.effect("adds context", () =>
    Effect.gen(function*() {
      const foo = yield* Foo;
      expect(foo).toEqual("foo");
    }));

  it.layer(Bar.Live)("nested", (it) => {
    it.effect("adds context", () =>
      Effect.gen(function*() {
        const foo = yield* Foo;
        const bar = yield* Bar;
        expect(foo).toEqual("foo");
        expect(bar).toEqual("bar");
      }));
  });
});
```

```ts
// packages/vitest/test/index.test.ts:213-228
const realNumber = Schema.Finite.pipe(Schema.nonNaN());

it.prop("symmetry", [realNumber, FastCheck.integer()], ([a, b]) => a + b === b + a);

it.effect.prop("symmetry", [realNumber, FastCheck.integer()], ([a, b]) =>
  Effect.gen(function*() {
    yield* Effect.void;
    return a + b === b + a;
  }));
```

```ts
// packages/effect/test/Effect/memoization.test.ts:10-15
it.effect("non-memoized returns new instances on repeated calls", () =>
  it.flakyTest(Effect.gen(function*() {
    const random = Random.nextInt;
    const [first, second] = yield* pipe(random, Effect.zip(random));
    notStrictEqual(first, second);
  })));
```

```ts
// packages/vitest/src/utils.ts:188-203
export function assertNone<A>(option: Option.Option<A>, ..._: Array<never>): asserts option is Option.None<never> {
  deepStrictEqual(option, Option.none());
}

export function assertSome<A>(
  option: Option.Option<A>,
  expected: A,
  ..._: Array<never>
): asserts option is Option.Some<A> {
  deepStrictEqual(option, Option.some(expected));
}
```

## パターンカタログ

- **Adapter パターン** (構造)
  - 解決する問題: vitest のテストランナー API と Effect のエフェクトシステムの間の橋渡し
  - 適用条件: テストフレームワークがエフェクトシステムのライフサイクル管理を直接サポートしない場合
  - コード例: `packages/vitest/src/internal/internal.ts:86-158` (`makeTester`)
  - 注意点: Adapter はテストフレームワークの全機能（skip / only / each / fails）をラップする必要がある

- **Strategy パターン** (振る舞い)
  - 解決する問題: テスト環境（TestClock vs 実時間、TestRandom vs 実ランダム）の切り替え
  - 適用条件: 同一テストコードを異なる実行環境で走らせたい場合
  - コード例: `packages/vitest/src/internal/internal.ts:295-304` (`makeMethods` で `effect` / `live` / `scoped` / `scopedLive` を生成)
  - 注意点: `it.live` と `it.effect` の混在はテストスイート内で意図的に行い、各テストケースで環境が明確であること

- **Factory Method パターン** (生成)
  - 解決する問題: Layer を受け取ってテストスイート全体のサービス依存を構成する
  - 適用条件: DB / HTTP クライアント等の外部サービスをテストスイート間で共有・差し替えたい場合
  - コード例: `packages/sql/test/SqlPersistedQueueTest.ts:7-13` (`suite` 関数が `Layer` を受け取る)
  - 注意点: Layer のメモ化（`memoMap`）を使わないと、テストケースごとに Layer が再ビルドされてパフォーマンスが劣化する

## Good Patterns

- **テストランナーの一元的な拡張**: `@effect/vitest` が vitest の `it` を拡張し、`it.effect` / `it.scoped` / `it.live` / `it.prop` を追加する。テストコード側は `import { it } from "@effect/vitest"` に変更するだけで、既存の vitest API（`it.skip` / `it.only` / `describe`）もそのまま使える。テストフレームワークの選択と Effect の統合が直交している。

```ts
// packages/vitest/src/index.ts:280-283
export const it: Vitest.Methods = Object.assign(V.it, {
  ...methods,
  scopedFixtures: V.it.scoped.bind(V.it),
});
```

- **ドメイン型に対する型安全アサーション**: `assertSome(option, expected)` は `asserts option is Option.Some<A>` を返すため、アサーション後のコードで `option.value` に安全にアクセスできる。vitest の `expect(option).toEqual(Option.some(expected))` では型が絞り込まれない。

```ts
// packages/vitest/src/utils.ts:197-203
export function assertSome<A>(
  option: Option.Option<A>,
  expected: A,
  ..._: Array<never>
): asserts option is Option.Some<A> {
  deepStrictEqual(option, Option.some(expected));
}
```

- **Schema からの Arbitrary 自動導出**: `Schema.String.pipe(Schema.minLength(2), Schema.maxLength(5))` のようなバリデーション付きスキーマから、制約を満たす Arbitrary を自動生成する。テストデータ生成コードとバリデーションルールの二重管理が不要になる。

```ts
// packages/vitest/test/advent-of-pbt-2024/day-1.test.ts:4-14
class Letter extends Schema.Class<Letter>("Letter")({
  name: Schema.String.pipe(
    Schema.minLength(1),
    Schema.filter((s) => s.match(/^[a-z]+$/) !== null),
  ),
  age: Schema.Int.pipe(Schema.between(1, 77)),
}) {
  static Array = Schema.Array(this);
}
```

- **テストスイートの Layer パラメータ化**: DB ドライバ等のインフラ依存を Layer として注入し、同一テストスイートを複数バックエンドで再利用する。

```ts
// packages/sql/test/SqlPersistedQueueTest.ts:7-13
export const suite = <E>(client: Layer.Layer<SqlClient.SqlClient, E>) => {
  const layer = PersistedQueue.layer.pipe(
    Layer.provide(SqlPersistedQueue.layerStore()),
    Layer.provideMerge(client),
  );
  it.layer(layer, { timeout: "30 seconds" })("SqlPersistedQueue", (it) => {
    // tests...
  });
};
```

## Anti-Patterns / 注意点

- **Effect.runSync をテスト内で手動呼び出しする**: `it.effect` を使わず `it("test", () => { Effect.runSync(myEffect) })` と書くと、ファイバーの割り込み・リソース解放が行われず、テスト失敗時にリソースリークが発生する。

```ts
// Bad: ファイバー管理が行われない
it("bad test", () => {
  const result = Effect.runSync(
    Effect.gen(function*() {
      const ref = yield* Ref.make(0);
      return yield* Ref.get(ref);
    }),
  );
  expect(result).toBe(0);
});

// Better: テストランナーが Effect ライフサイクルを管理
it.effect("good test", () =>
  Effect.gen(function*() {
    const ref = yield* Ref.make(0);
    const result = yield* Ref.get(ref);
    strictEqual(result, 0);
  }));
```

- **Effect テストで vitest の expect を使う**: Effect の代数的データ型（`Option` / `Either` / `Exit`）は内部に Symbol ベースのタグを持つため、vitest の `expect().toEqual()` が `addEqualityTesters` 設定なしでは正しく比較できない場合がある。AGENTS.md でも「Never use `expect` from vitest in Effect tests - use `assert` methods instead」と明記されている。

```ts
// Bad: Effect の Equal トレイトが無視される
expect(Option.some(1)).toEqual(Option.some(1)); // addEqualityTesters なしだと失敗の可能性

// Better: ドメイン特化アサーションを使用
assertSome(option, 1);
```

- **時間依存テストで it.live と it.effect を無意識に混在させる**: `it.effect` は TestClock を使うため `Effect.sleep` は即座に解決される。`it.live` は実時間を使うため待機が発生する。意図せず `it.effect` で書いた時間依存テストが「たまたま通る」状態を避けるため、時間に依存するテストでは `it.live` / `it.effect` の選択を意識的に行う必要がある。

## 導出ルール

- `[MUST]` エフェクトフルなコードのテストには、テストランナー側でライフサイクル管理（リソース解放・ファイバー割り込み）を行う仕組みを使う
  - 根拠: `packages/vitest/src/internal/internal.ts:28-56` でテスト終了時のファイバー割り込みとリソース解放を保証しており、手動 `runSync` では Scope の解放漏れが発生する

- `[MUST]` テスト環境（モック時計 vs 実時間、テストランダム vs 実ランダム）は暗黙的に選択せず、各テストケースで明示的に宣言する
  - 根拠: `it.effect` / `it.live` / `it.scoped` / `it.scopedLive` の4種類を使い分けることで、テスト環境が曖昧にならない設計になっている

- `[SHOULD]` ドメイン固有の代数的データ型（Option / Either / Result 等）には型ガード付きのカスタムアサーション関数を提供する
  - 根拠: `packages/vitest/src/utils.ts` の `assertSome` / `assertNone` / `assertRight` / `assertLeft` が `asserts x is T` を返すことで、アサーション後のコードが型安全になる

- `[SHOULD]` バリデーションスキーマが存在する場合、プロパティベーステストの Arbitrary はスキーマから自動導出する
  - 根拠: `packages/vitest/src/internal/internal.ts:121-156` で Schema → Arbitrary の自動変換が行われ、スキーマとテストデータの整合性が保証される

- `[SHOULD]` 非決定的テスト（ランダム依存・タイミング依存）はリトライラッパーで明示的にマークし、暗黙的な flaky テストを許容しない
  - 根拠: `flakyTest` ユーティリティ（`packages/vitest/src/internal/internal.ts:278-292`）がリトライ上限とタイムアウトを設定し、非決定性を制御下に置いている

- `[SHOULD]` テストフレームワークのカスタム等価性比較を setup ファイルで登録し、ドメイン型の比較がネイティブに動作するようにする
  - 根拠: `vitest.setup.ts` で `addEqualityTesters()` を呼ぶことで、`expect().toEqual()` が Effect の `Equal.equals` トレイトを理解する

- `[SHOULD]` 外部依存（DB / HTTP クライアント等）はレイヤーとしてパラメータ化し、同一テストスイートを複数バックエンドで再利用できるようにする
  - 根拠: `packages/sql/test/SqlPersistedQueueTest.ts` で `suite(client)` パターンにより SQLite / LibSQL / PostgreSQL で同一テストを実行

- `[AVOID]` テストフレームワークの標準タイマーモック（fake timers）と、アプリケーションレベルの時間抽象（TestClock 等）を混在させる
  - 根拠: `vitest.shared.ts:14-16` で `fakeTimers: { toFake: undefined }` を設定し、vitest のタイマーモックを無効化。時間制御は Effect の `TestClock` に一元化している

## 適用チェックリスト

- [ ] エフェクトフルなコードのテストランナーがリソース解放・割り込みを自動管理しているか確認する
- [ ] テストケースごとにテスト環境（モック vs 実環境）が明示的に選択されているか確認する
- [ ] ドメイン固有のデータ型に対する型ガード付きアサーション関数を用意しているか確認する
- [ ] バリデーションスキーマとテストデータ生成が二重管理になっていないか確認する（スキーマから Arbitrary を導出できるか検討する）
- [ ] 非決定的テストが `flakyTest` 等のリトライ機構で明示的にマークされているか確認する
- [ ] テストフレームワークの setup ファイルでカスタム等価性比較が登録されているか確認する
- [ ] 外部依存のテストがレイヤー/DI でパラメータ化され、バックエンド差し替えが可能か確認する
- [ ] テストインフラ自体のテストが存在するか確認する
