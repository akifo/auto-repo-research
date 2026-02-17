# dependency-injection

> リポジトリ: Effect-TS/effect
> 分析日: 2026-02-18

## 概要

Effect-TS の依存性注入（DI）パターンを分析する。Effect は型パラメータ `R`（Requirements）を通じて依存関係を型レベルで追跡し、`Context.Tag` をサービスロケータのキー、`Layer` をサービスの構築レシピとして用いる独自の DI メカニズムを持つ。従来の DI コンテナと異なり、依存関係の充足が型システムで保証され、Layer の自動メモ化やリソースのライフサイクル管理が組み込みで提供される点が注目に値する。

## 背景にある原則

- **型レベルでの依存追跡**: 依存関係を型パラメータ `R` に集約し、未提供のサービスをコンパイル時に検出すべき。Effect の `Effect<A, E, R>` は「成功時の値 A」「エラー E」「必要な依存 R」を型で表現し、`Effect.provide` で `R` を消去する。これにより実行時の「サービスが見つからない」エラーが構造的に排除される（`packages/effect/src/Effect.ts`、`packages/effect/src/Context.ts`）。

- **構築と利用の分離**: サービスの「定義（Tag）」「構築方法（Layer）」「利用（Effect.service / yield*）」を分離すべき。利用側はサービスの具体的な構築方法を知る必要がなく、Tag だけに依存する。これにより、テスト時にモック Layer を差し替えるだけで振る舞いを変更できる（`packages/effect/src/Layer.ts:1-18`）。

- **リソースライフサイクルの自動管理**: サービスの acquire/release をスコープに紐づけて自動管理すべき。手動でのリソース解放は漏れやすいため、`Layer.scoped` と `Scope` の組み合わせでリソースのライフサイクルを宣言的に記述する（`packages/effect/src/Scope.ts`）。

- **依存グラフの自動メモ化**: 同一サービスの重複構築を防ぐため、Layer は参照同一性に基づき自動的にメモ化されるべき。MemoMap がこの役割を担い、ダイヤモンド依存でもサービスは一度だけ構築される（`packages/effect/src/internal/layer.ts:194-316`）。

## 実例と分析

### Tag によるサービス識別

サービスの識別子として `Context.Tag` を使う。Tag はブランド型として機能し、同じ構造のサービスでも異なる Tag を持てば別サービスとして扱われる。

```typescript
// packages/effect/src/Context.ts:507-524
// クラスベースの Tag 定義: Self 型パラメータで名目的型付けを実現
export const Tag: <const Id extends string>(id: Id) => <Self, Shape>() => TagClass<Self, Id, Shape>
```

リポジトリ全体で3つの Tag 定義パターンが使い分けられている:

1. **クラスベース Tag（推奨）**: 名目的型付けを自然に実現し、static メンバーに Layer を配置できる
2. **`Effect.Tag`**: クラスベース Tag に加えてサービスメソッドへの静的アクセサを自動生成
3. **`GenericTag`**: 後方互換のための低レベル API

### クラスベース Tag と Layer の同居

`Context.Tag` を class で拡張し、static プロパティに `Layer.succeed(this, ...)` を配置するパターンがコードベース全体で一貫して使われている。

```typescript
// packages/effect/test/Effect/environment.test.ts:37-48
class DateTag extends Effect.Tag("DateTag")<DateTag, Date>() {
  static date = new Date(1970, 1, 1)
  static Live = Layer.succeed(this, this.date)
}

class MapTag extends Effect.Tag("MapTag")<MapTag, Map<string, string>>() {
  static Live = Layer.effect(this, Effect.sync(() => new Map()))
}

class NumberTag extends Effect.Tag("NumberTag")<NumberTag, number>() {
  static Live = Layer.succeed(this, 100)
}
```

`Effect.Service` はこのパターンをさらに進め、Tag + Layer + dependencies を一括定義する:

```typescript
// packages/effect/src/Effect.ts:13556-13572
class Prefix extends Effect.Service<Prefix>()("Prefix", {
  sync: () => ({ prefix: "PRE" })
}) {}

class Logger extends Effect.Service<Logger>()("Logger", {
  accessors: true,
  effect: Effect.gen(function* () {
    const { prefix } = yield* Prefix
    return {
      info: (message: string) =>
        Effect.sync(() => { console.log(`[${prefix}][${message}]`) })
    }
  }),
  dependencies: [Prefix.Default]
}) {}
```

### Layer の合成パターン

Layer は DAG（有向非巡回グラフ）を形成し、以下の合成演算子で依存グラフを構築する:

```typescript
// packages/effect/src/Layer.ts:567-575 — 並列マージ
export const merge: {
  <RIn2, E2, ROut2>(
    that: Layer<ROut2, E2, RIn2>
  ): <RIn, E1, ROut>(self: Layer<ROut, E1, RIn>) => Layer<ROut2 | ROut, E2 | E1, RIn2 | RIn>
}

// packages/effect/src/Layer.ts:899-926 — 依存の提供
export const provide: {
  <RIn, E, ROut>(
    that: Layer<ROut, E, RIn>
  ): <RIn2, E2, ROut2>(self: Layer<ROut2, E2, RIn2>) => Layer<ROut2, E | E2, RIn | Exclude<RIn2, ROut>>
}
```

実際の合成例（テストコードより）:

```typescript
// packages/effect/test/Layer.test.ts:364-372
const NumberTag = Context.GenericTag<number>("number")
const StringTag = Context.GenericTag<string>("string")
const needsNumberAndString = Effect.all([NumberTag, StringTag])
const providesNumber = Layer.succeed(NumberTag, 10)
const providesString = Layer.succeed(StringTag, "hi")
// 段階的に依存を満たしていく
const needsString = needsNumberAndString.pipe(Effect.provide(providesNumber))
const result = yield* pipe(needsString, Effect.provide(providesString))
```

### MemoMap による自動メモ化と Layer.fresh

Layer はデフォルトで自動メモ化される。同一 Layer 参照が複数箇所で使われても構築は1回のみ:

```typescript
// packages/effect/test/Layer.test.ts:77-85
// layer を2回 merge しても構築は1回
const layer = makeLayer1(ref)
const env = layer.pipe(Layer.merge(layer), Layer.build)
yield* Effect.scoped(env)
const result = yield* Ref.get(ref)
deepStrictEqual(Array.from(result), [acquire1, release1]) // 1回だけ
```

`Layer.fresh` でメモ化を回避し、個別のインスタンスを強制的に構築できる:

```typescript
// packages/effect/test/Layer.test.ts:192-199
const layer = makeLayer1(ref)
const env = layer.pipe(Layer.merge(Layer.fresh(layer)), Layer.build)
yield* Effect.scoped(env)
const result = yield* Ref.get(ref)
deepStrictEqual(Array.from(result), [acquire1, acquire1, release1, release1]) // 2回
```

### Context.Reference によるデフォルト値付きサービス

必須でないサービスには `Context.Reference` でデフォルト値を提供できる。`R` 型パラメータから除外されるため、provide なしでも利用可能:

```typescript
// packages/effect/src/Context.ts:542-555
class SpecialNumber extends Context.Reference<SpecialNumber>()(
  "SpecialNumber",
  { defaultValue: () => 2048 }
) {}

// R が never になる — provide 不要
const program = Effect.gen(function* () {
  const specialNumber = yield* SpecialNumber
})
Effect.runPromise(program) // デフォルト値 2048 が使われる
```

内部でも設定用途で活用されている:

```typescript
// packages/effect/src/internal/layer.ts:73
export const CurrentMemoMap = Context.Reference<Layer.CurrentMemoMap>()(
  "effect/Layer/CurrentMemoMap",
  { defaultValue: () => unsafeMakeMemoMap() }
)
```

### 多層出力の Layer: 抽象 + 具象タグの同時提供

SQL パッケージでは、1つの Layer が汎用タグ（`SqlClient`）と具象タグ（`PgClient`）の両方を提供するパターンが使われている:

```typescript
// packages/sql-pg/src/PgClient.ts:550-558
export const layer = (
  config: PgClientConfig
): Layer.Layer<PgClient | Client.SqlClient, SqlError> =>
  Layer.scopedContext(
    Effect.map(make(config), (client) =>
      Context.make(PgClient, client).pipe(
        Context.add(Client.SqlClient, client)
      ))
  ).pipe(Layer.provide(Reactivity.layer))
```

### LayerMap: 動的なキーベース DI

`LayerMap` は実行時のキーに基づいてサービスのバリエーションを動的に解決するパターンを提供する:

```typescript
// packages/effect/src/LayerMap.ts:73-111
class GreeterMap extends LayerMap.Service<GreeterMap>()("GreeterMap", {
  lookup: (name: string) =>
    Layer.succeed(Greeter, {
      greet: Effect.succeed(`Hello, ${name}!`)
    }),
  idleTimeToLive: "5 seconds",
  dependencies: []
}) {}

// 利用時にキーを指定してサービスのバリアントを取得
const program = Effect.gen(function*() {
  const greeter = yield* Greeter
  yield* Effect.log(yield* greeter.greet)
}).pipe(
  Effect.provide(GreeterMap.get("John"))
)
```

### テスト時の DI: Layer.mock

テスト用にサービスの部分的な実装を提供する `Layer.mock` がある。未実装メソッドは呼び出し時に `UnimplementedError` を投げる:

```typescript
// packages/effect/src/Layer.ts:424-453
// テスト用の部分実装レイヤー
const MyServiceTest = Layer.mock(MyService, {
  two: () => Effect.succeed(2)
  // one は未提供 → 呼び出すと UnimplementedError
})
```

## パターンカタログ

- **Service Locator** (構造)
  - 解決する問題: 依存サービスの動的解決
  - 適用条件: Context が Tag → Service のマッピングテーブルとして機能
  - コード例: `packages/effect/src/internal/context.ts:166-170` — `unsafeMap: Map<string, any>` によるサービス格納
  - 注意点: 従来の Service Locator と異なり、型パラメータ `R` により型安全性が保証される

- **Builder** (生成)
  - 解決する問題: 依存関係を持つサービスの段階的構築
  - 適用条件: Layer が `provide` / `merge` で合成され、最終的に `build` でサービス群を構築
  - コード例: `packages/effect/src/Layer.ts:899-926` — `Layer.provide` による依存注入
  - 注意点: Layer は値であり、合成結果も Layer 型なので、合成をどこまでも重ねられる

- **Flyweight** (構造)
  - 解決する問題: 同一サービスの重複構築を防ぐ
  - 適用条件: MemoMap が参照同一性に基づき Layer の構築結果をキャッシュ
  - コード例: `packages/effect/src/internal/layer.ts:194-316` — MemoMapImpl
  - 注意点: `Layer.fresh` で意図的にメモ化を回避できる

## Good Patterns

- **Tag + Layer の共置**: サービスの Tag 定義と Layer（構築方法）を同じクラスの static メンバーとして共置する。利用者はインポート1つで Tag と Layer の両方にアクセスできる。

```typescript
// packages/effect/test/Effect/environment.test.ts:37-39
class DateTag extends Effect.Tag("DateTag")<DateTag, Date>() {
  static date = new Date(1970, 1, 1)
  static Live = Layer.succeed(this, this.date)
}
```

- **抽象 + 具象タグの多層提供**: 汎用インターフェースのタグと具体実装のタグを1つの Layer で同時に提供する。利用側は抽象タグに依存し、必要に応じて具象タグを通じて実装固有の機能にアクセスできる。

```typescript
// packages/sql-pg/src/PgClient.ts:550-558
export const layer = (config: PgClientConfig): Layer.Layer<PgClient | Client.SqlClient, SqlError> =>
  Layer.scopedContext(
    Effect.map(make(config), (client) =>
      Context.make(PgClient, client).pipe(Context.add(Client.SqlClient, client))
    )
  ).pipe(Layer.provide(Reactivity.layer))
```

- **Effect.Service による Tag + Layer + 依存の一括定義**: `dependencies` オプションで依存 Layer を宣言すると、`Default` レイヤーに自動で組み込まれる。ボイラープレートが削減され、依存関係が明示的になる。

```typescript
// packages/effect/src/Effect.ts:13560-13572
class Logger extends Effect.Service<Logger>()("Logger", {
  effect: Effect.gen(function* () {
    const { prefix } = yield* Prefix
    return { info: (message: string) => Effect.sync(() => console.log(`[${prefix}][${message}]`)) }
  }),
  dependencies: [Prefix.Default]
}) {}
```

## Anti-Patterns / 注意点

- **GenericTag の重複キー**: `GenericTag` は文字列キーで識別されるため、同じキーで異なる型のタグを作ると実行時に型安全性が崩壊する。クラスベースの `Context.Tag` はクラス自体が名目的型を提供するためこの問題がない。

```typescript
// Bad: 同じキーで異なる型のタグ — 実行時に区別できない
const NumberTag = Context.GenericTag<number>("config")
const StringTag = Context.GenericTag<string>("config")

// Better: クラスベースの Tag を使う
class NumberConfig extends Context.Tag("NumberConfig")<NumberConfig, number>() {}
class StringConfig extends Context.Tag("StringConfig")<StringConfig, string>() {}
```

- **Layer.fresh の不用意な使用**: `Layer.fresh` を使うとメモ化が無効化され、依存グラフ内で同一サービスが複数回構築される。リソースを持つサービスで使うとリソースリークや状態の不整合を引き起こす可能性がある。

```typescript
// Bad: fresh で DB 接続プールが2つ作られる
const app = myService.pipe(
  Layer.provide(Layer.fresh(dbLayer)),
  Layer.merge(otherService.pipe(Layer.provide(Layer.fresh(dbLayer))))
)

// Better: デフォルトのメモ化を活用
const app = myService.pipe(
  Layer.provide(dbLayer),
  Layer.merge(otherService.pipe(Layer.provide(dbLayer)))
)
```

- **Effect.provideService の乱用**: テストや一時的なオーバーライドには有用だが、本番コードの依存注入には Layer を使うべき。`provideService` はリソースのライフサイクル管理やメモ化を提供しないため、スコープ管理が必要なサービスには不適切。

```typescript
// Bad: リソース管理が必要なサービスを provideService で提供
const program = myEffect.pipe(
  Effect.provideService(DbClient, await createConnection())
  // 接続の close が管理されない
)

// Better: Layer.scoped でリソースライフサイクルを管理
const DbClientLive = Layer.scoped(
  DbClient,
  Effect.acquireRelease(createConnection(), (conn) => conn.close())
)
```

## 導出ルール

- `[MUST]` サービスの依存関係は型パラメータで表現し、コンパイル時に充足を保証する
  - 根拠: Effect の `R` 型パラメータにより、未提供の依存は `Effect.provide` なしではコンパイルエラーになる（`packages/effect/src/Effect.ts`）

- `[MUST]` リソースのライフサイクルを持つサービスは、スコープ付き構築関数（`Layer.scoped` / `acquireRelease` 相当）で定義し、手動解放を避ける
  - 根拠: `Layer.scoped` と `Scope` の組み合わせにより、リソースは使用スコープ終了時に確実に解放される（`packages/effect/src/Scope.ts`、`packages/effect/test/Layer.test.ts:48-76`）

- `[SHOULD]` サービスの Tag 定義と構築 Layer は同一モジュール（できれば同一クラス）に共置する
  - 根拠: Effect-TS のコードベース全体で Tag クラスの static プロパティに `Live`/`Default` Layer を配置するパターンが一貫して使われている（`packages/effect/test/Effect/environment.test.ts:37-48`、`packages/platform/src` 全般）

- `[SHOULD]` 同一サービスを複数箇所で利用する場合は、Layer のデフォルトメモ化を活用して構築回数を1回に抑える
  - 根拠: MemoMap が参照同一性に基づき Layer 構築結果をキャッシュし、ダイヤモンド依存でもサービスは一度だけ構築される（`packages/effect/src/internal/layer.ts:194-316`）

- `[SHOULD]` 汎用インターフェースの抽象タグと具体実装の具象タグを1つの Layer で同時に提供し、利用側の依存先を抽象タグに限定する
  - 根拠: `@effect/sql-pg` の `layer` 関数は `PgClient | SqlClient` を同時に提供し、利用側は `SqlClient` のみに依存できる（`packages/sql-pg/src/PgClient.ts:550-558`）

- `[SHOULD]` オプショナルな設定やデフォルト値を持つ依存にはデフォルト値付きの参照（`Context.Reference` 相当）を使い、必須依存と区別する
  - 根拠: `Context.Reference` は `R` 型に含まれないため provide 不要で利用でき、必要時にのみオーバーライドできる（`packages/effect/src/Context.ts:530-585`）

- `[AVOID]` サービス識別子に文字列キーのみを使う（名目的型付けのないサービスロケータ）
  - 根拠: `GenericTag` は同一キーで異なる型のタグを作成でき、実行時に型安全性が崩壊する。クラスベースの Tag はクラス自体が型の一意性を保証する（`packages/effect/src/internal/context.ts:85-100`）

- `[AVOID]` 本番コードで `Layer.fresh` を無計画に使用し、同一サービスの複数インスタンスを構築する
  - 根拠: `Layer.fresh` はメモ化を無効化し、リソース付きサービスの重複構築によりリソースリークや状態不整合を引き起こす（`packages/effect/test/Layer.test.ts:192-199`）

## 適用チェックリスト

- [ ] サービスの依存関係が型レベルで追跡されており、未提供の依存がコンパイル時に検出できるか
- [ ] リソース（DB 接続、ファイルハンドル等）を持つサービスの構築にスコープ付きライフサイクル管理を使っているか
- [ ] サービスの Tag 定義と構築 Layer が同一モジュールに共置されているか
- [ ] 依存グラフでダイヤモンド依存が発生する場合、メモ化により重複構築が防がれているか
- [ ] 汎用インターフェースと具体実装で抽象/具象タグを分離し、利用側が抽象タグのみに依存しているか
- [ ] テスト時にモック Layer を差し替えるだけで振る舞いを変更できる構造になっているか
- [ ] オプショナルな依存にデフォルト値が設定されており、必須依存と明確に区別されているか
