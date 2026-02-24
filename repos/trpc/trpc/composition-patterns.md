# composition-patterns

> リポジトリ: trpc/trpc
> 分析日: 2026-02-24

## 概要

tRPC における型安全な合成パターンを分析する。ProcedureBuilder の `.concat()` / `.input()` / `.use()` によるプロシージャ合成、`MiddlewareBuilder.unstable_pipe()` によるミドルウェアチェーン、`mergeRouters()` によるルーター結合、`lazy()` による遅延ロードなど、複数の合成レイヤが存在する。注目に値するのは、ランタイムの合成とコンパイル時の型合成を「同じ操作」として統一的に扱いながら、不整合を型エラーとして検出する仕組みである。

## 背景にある原則

- **合成操作の型的等価性**: ランタイムの合成（ミドルウェア配列の連結、入力オブジェクトのマージ）と型レベルの合成（`Overwrite` / `IntersectIfDefined`）を 1:1 で対応させる。コンテキスト拡張は `Overwrite`（後勝ち上書き）、入力合成は `IntersectIfDefined`（交差型による累積結合）と、合成の意味論ごとに異なる型演算子を使い分けている（`procedureBuilder.ts:37-45`, `types.ts:96-112`）。

- **不変ビルダーチェーン**: 各合成操作は既存のビルダーを変更せず、新しいビルダーを返す。`createNewBuilder()` が `_def` オブジェクトを複製し、ミドルウェアや入力パーサーの配列を新しい配列として連結する（`procedureBuilder.ts:471-484`）。共通のベースプロシージャから分岐して複数の派生プロシージャを安全に作成できる。

- **合成境界での互換性検証**: `concat()` のシグネチャで条件型を使い、合成先のコンテキストとメタが互換でない場合に `TypeError<'Context mismatch'>` / `TypeError<'Meta mismatch'>` を返す（`procedureBuilder.ts:334-347`）。合成を試みた時点で不整合を検出するファストフェイル設計。

- **ミドルウェアを合成の統一プリミティブとする**: `.input()` と `.output()` はパーサーをミドルウェアに変換して合成する。入力検証も出力検証もミドルウェアの一種として扱うことで、合成パイプラインが単一の配列（`_def.middlewares`）に統一される（`procedureBuilder.ts:507-519`, `middleware.ts:186-243`）。

## 実例と分析

### ProcedureBuilder の不変合成チェーン

`createNewBuilder()` はすべての合成操作の共通基盤。配列フィールドは連結、スカラーフィールドは `mergeWithoutOverrides` で重複検出する。

```typescript
// procedureBuilder.ts:471-484
function createNewBuilder(
  def1: AnyProcedureBuilderDef,
  def2: Partial<AnyProcedureBuilderDef>,
): AnyProcedureBuilder {
  const { middlewares = [], inputs, meta, ...rest } = def2;
  return createBuilder({
    ...mergeWithoutOverrides(def1, rest),
    inputs: [...def1.inputs, ...(inputs ?? [])],
    middlewares: [...def1.middlewares, ...middlewares],
    meta: def1.meta && meta ? { ...def1.meta, ...meta } : (meta ?? def1.meta),
  });
}
```

### 入力チェーニング: パーサーをミドルウェアに変換

`.input()` が複数回呼ばれると、各呼び出しが `createInputMiddleware` でミドルウェアに変換される。ミドルウェア内部で前の入力と現在のパース結果をオブジェクトマージする。

```typescript
// middleware.ts:200-210
const combinedInput =
  isObject(opts.input) && isObject(parsedInput)
    ? { ...opts.input, ...parsedInput }
    : parsedInput;
return opts.next({ input: combinedInput });
```

型レベルでは `IntersectIfDefined` が交差型でマージする。オプショナルパーサーを必須パーサーにチェーンすることは `TypeError<'Cannot chain an optional parser to a required parser'>` で防がれる（`procedureBuilder.ts:206-211`）。

### concat(): ビルダー同士の合成

`concat()` は 2 つの ProcedureBuilder の `_def` をマージする。型レベルでコンテキスト/メタの互換性を検証し、ランタイムでは `createNewBuilder` に委譲する。

```typescript
// procedureBuilder.ts:540-542
concat(builder) {
  return createNewBuilder(_def, (builder as AnyProcedureBuilder)._def);
},
```

ライブラリが提供するベースビルダーをアプリ側のビルダーに合成するユースケースがテストで示されている。

```typescript
// procedureBuilder.test.ts:300-341
function createLib() {
  const t = initTRPC.context<{ foo: string }>().meta<{ foo: string }>().create();
  return t.procedure
    .use((opts) => opts.next({ ctx: { __fromLib: true } }))
    .input(z.object({ foo: z.string() }));
}
const libBuilder = createLib();
const t = initTRPC.context<{ foo: string; bar: string }>()
  .meta<{ foo: string; bar: string }>().create();
const libProc = t.procedure.unstable_concat(libBuilder).query((opts) => {
  return { input: opts.input, ctx: opts.ctx };
});
```

### MiddlewareBuilder.unstable_pipe(): ミドルウェア単体の合成

ミドルウェアをプロシージャに紐付ける前にチェーンできる。内部は `_middlewares` 配列の連結。`.use()` がミドルウェア関数とミドルウェアビルダーの両方を受け取れるのは `'_middlewares' in middlewareBuilderOrFn` による判別パターン（`procedureBuilder.ts:526-536`）。

```typescript
// middleware.ts:132-146
function createMiddlewareInner(middlewares: AnyMiddlewareFunction[]): AnyMiddlewareBuilder {
  return {
    _middlewares: middlewares,
    unstable_pipe(middlewareBuilderOrFn) {
      const pipedMiddleware = '_middlewares' in middlewareBuilderOrFn
        ? middlewareBuilderOrFn._middlewares
        : [middlewareBuilderOrFn];
      return createMiddlewareInner([...middlewares, ...pipedMiddleware]);
    },
  };
}
```

### mergeRouters(): ルーターレベルの合成

ルーターのマージは `record` を `mergeWithoutOverrides` で結合し、`errorFormatter` と `transformer` の重複を明示的にチェックする（`router.ts:510-564`）。異なるカスタム formatter が 2 つ以上あれば例外を投げるが、片方が default なら受け入れる。

### lazy() と再帰実行パイプライン

`lazy()` はルーターの動的インポートをラップし初回アクセス時にロード（`router.ts:105-135`）。`once()` で冪等性を保証する。合成されたミドルウェア配列は `callRecursive`（`procedureBuilder.ts:634-672`）で実行される Chain of Responsibility パターン。リゾルバ自体も最後のミドルウェアとしてパイプラインに組み込まれる（`procedureBuilder.ts:572-585`）。

## パターンカタログ

- **Builder パターン** (生成)
  - 解決する問題: 多段階の構成を型安全にチェーンする
  - 適用条件: 各ステップで型パラメータが変化するオブジェクト構築
  - コード例: `procedureBuilder.ts:486-566`
  - 注意点: 不変ビルダーのため毎回新オブジェクト生成。ホットパスでなければ問題なし。

- **Chain of Responsibility** (振る舞い)
  - 解決する問題: ミドルウェア群を順序付きで実行しコンテキストを変換
  - 適用条件: 複数のハンドラを順に通過させたい場合
  - コード例: `procedureBuilder.ts:634-672`
  - 注意点: `next()` 呼び忘れでチェーンが途切れる。`middlewareMarker` で検出。

- **Composite パターン** (構造)
  - 解決する問題: ルーターとプロシージャの再帰的入れ子を統一的に扱う
  - 適用条件: ツリー構造のルーティング
  - コード例: `router.ts:224-229`, `router.ts:306-339`

## Good Patterns

- **合成を検証・結合・変換の 3 層に分離する**: `concat()` は型レベルで互換性を検証（条件型）、ランタイムで `_def` を結合（`createNewBuilder`）、最終的にミドルウェア配列として変換。各層を独立させることで型検証をランタイムオーバーヘッドなしに実現。

```typescript
// procedureBuilder.ts:334-347 (型レベルの検証)
builder: Overwrite<TContext, TContextOverrides> extends $Context
  ? TMeta extends $Meta
    ? ProcedureBuilder<$Context, $Meta, ...>
    : TypeError<'Meta mismatch'>
  : TypeError<'Context mismatch'>,
```

- **センチネル型による初期状態と設定済み状態の区別**: `UnsetMarker` 型をブランド付き文字列として定義し、`.input()` 未呼び出し状態を型レベルで追跡する。`IntersectIfDefined` は `UnsetMarker` を透過的に扱い、合成ロジックを条件分岐する。

```typescript
// utils.ts:1-4 / procedureBuilder.ts:37-45
type UnsetMarker = 'unsetMarker' & { __brand: 'unsetMarker' };
type IntersectIfDefined<TType, TWith> = TType extends UnsetMarker
  ? TWith
  : TWith extends UnsetMarker ? TType : Simplify<TType & TWith>;
```

- **重複キー衝突の即座検出**: `mergeWithoutOverrides` がプロパティ重複を例外として投げ、`Object.assign` のサイレント上書きを防止する（`utils.ts:10-25`）。

## Anti-Patterns / 注意点

- **合成時にコンテキスト型を暗黙に狭める**: `next({ ctx: { init: 'override' } })` で既存プロパティを別の型で上書きすると、後続ミドルウェアから元の型にアクセスできなくなる。`Overwrite` 型が後勝ちで置換するため型的には追跡されるが、意図しない上書きが起きやすい（`middlewares.test.ts:403-467`）。

```typescript
// Bad: 既存プロパティの型を暗黙に変更
return opts.next({ ctx: { init: 'override' as const } });

// Better: 新しいプロパティとして追加
return opts.next({ ctx: { processedInit: opts.ctx.init.foundation } });
```

- **異なる initTRPC インスタンス間の設定衝突**: `mergeRouters` で異なる `errorFormatter` や `transformer` を持つルーターを結合するとランタイム例外が発生するが、型レベルでは検出されない（`router.mergeRouters.test.ts:94-144`）。

```typescript
// Bad: 別インスタンスのルーターをマージ
const t1 = initTRPC.create({ errorFormatter: (fmt) => fmt.shape });
const t2 = initTRPC.create({ errorFormatter: (fmt) => fmt.shape });
t1.mergeRouters(router1, router2); // Error: 'You seem to have several error formatters'

// Better: 単一インスタンスから全ルーターを生成
const t = initTRPC.create({ errorFormatter: (fmt) => fmt.shape });
t.mergeRouters(t.router({...}), t.router({...})); // OK
```

## 導出ルール

- `[MUST]` 合成操作は不変にし、元のオブジェクトを変更しない新しいオブジェクトを返す
  - 根拠: `createNewBuilder` は毎回新しい `_def` を生成し、ベースプロシージャから安全に分岐できる（`procedureBuilder.ts:471-484`）

- `[MUST]` 合成境界で互換性を検証し、不整合をコンパイル時または初期化時に検出する
  - 根拠: `concat()` の条件型と `mergeWithoutOverrides` の重複キーチェックにより、不整合が利用時ではなく合成時に検出される（`procedureBuilder.ts:334-347`, `utils.ts:10-25`）

- `[SHOULD]` 異なる種類の合成操作を、ランタイムでは統一的な内部表現に変換する
  - 根拠: `.input()`, `.output()`, `.use()` はすべてミドルウェア配列に変換され、実行パイプラインが `callRecursive` に統一されている（`procedureBuilder.ts:507-519`）

- `[SHOULD]` センチネル値（ブランド型）で「未設定」状態を型レベルで追跡し、合成時に条件分岐する
  - 根拠: `UnsetMarker` と `IntersectIfDefined` により、未設定をスキップし設定済みのみ交差型で合成する（`procedureBuilder.ts:37-45`）

- `[SHOULD]` オブジェクトマージ時にサイレントな上書きを防ぐユーティリティを用意する
  - 根拠: `mergeWithoutOverrides` はキー重複を即座に例外として報告する（`utils.ts:10-25`）

- `[AVOID]` 合成対象のグローバル設定（フォーマッタ、シリアライザ等）が異なるインスタンス同士をマージする
  - 根拠: `mergeRouters` は設定の不一致をランタイム例外で報告するが、型レベルでは検出できない（`router.ts:517-550`）

## 適用チェックリスト

- [ ] ビルダーパターンの各操作が元のオブジェクトを変更せず、新しいオブジェクトを返しているか
- [ ] 合成時の型パラメータの伝搬方法を定義しているか（上書き `Overwrite` か累積 `Intersection` か）
- [ ] 「未設定」と「設定済み」を型レベルで区別するセンチネル型があるか
- [ ] 合成境界で互換性エラーメッセージを人間が読める形で提供しているか
- [ ] オブジェクトマージ時にサイレントな上書きが発生しないかチェックしているか
- [ ] 複数の合成レイヤが最終的に統一的な内部表現に変換されているか
- [ ] 遅延合成がある場合、初回ロードの冪等性を保証しているか
