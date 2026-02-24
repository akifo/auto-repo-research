# middleware-composition

> リポジトリ: trpc/trpc
> 分析日: 2026-02-24

## 概要

tRPC のミドルウェアシステムは、再帰的チェーン実行、ブランド型によるプロトコル強制、コンテキスト拡張の型レベル追跡、バリデーションのミドルウェア統一という4つの技法を組み合わせて構築されている。特にコンテキストの型が `Overwrite<TContext, TContextOverrides>` で自動マージされる仕組みは、ミドルウェアチェーンが深くなっても型安全性を保証する設計として注目に値する。この分析では、tRPC のミドルウェア実装から汎用的なプラクティスを抽出し、任意のミドルウェアパイプライン設計に応用可能な知見を体系化する。

## 背景にある原則

- **ミドルウェアは「関心の単位」であり「実行の単位」でもある**: tRPC では入力バリデーション、出力バリデーション、認証チェック、リゾルバのすべてが同一の `MiddlewareFunction` シグネチャに統一されている。`createInputMiddleware`、`createOutputMiddleware`、`createResolver` はそれぞれバリデータやリゾルバをミドルウェアにラップする。この統一により、実行エンジン（`callRecursive`）は一つの再帰関数で済む（`packages/server/src/unstable-core-do-not-import/procedureBuilder.ts:634-672`）。

- **型レベルでの不変条件をランタイムブランドで強制する**: `middlewareMarker` はブランド型付き文字列で、ミドルウェアの戻り値が必ず `next()` 経由であることをコンパイル時・ランタイム両方で保証する。ミドルウェアが `next()` を呼ばずに独自のオブジェクトを返すことは型エラーになる（`packages/server/src/unstable-core-do-not-import/middleware.ts:8-11`）。

- **コンテキスト拡張は累積的合成である**: `next({ ctx: { ... } })` で渡されたコンテキストは既存コンテキストにマージされる。型レベルでは `Overwrite<TContextOverridesIn, $ContextOverridesOut>` で追跡され、ランタイムでは `{ ...opts.ctx, ...nextOpts.ctx }` でシャローマージされる。ミドルウェアは自身の前段までのコンテキストを受け取り、後段に拡張を伝搬する（`packages/server/src/unstable-core-do-not-import/procedureBuilder.ts:655-658`）。

- **ビルダーパターンで宣言的にパイプラインを構築する**: `.use()` / `.input()` / `.output()` は不変の `ProcedureBuilder` を返すメソッドチェーン。各呼び出しは `createNewBuilder` で新しい定義を生成し、ミドルウェア配列を結合する。これにより途中の段階を変数に束縛して再利用できる（`packages/server/src/unstable-core-do-not-import/procedureBuilder.ts:471-484`）。

## 実例と分析

### 再帰的チェーン実行

ミドルウェアの実行は `callRecursive` 関数で行われる。配列のインデックスをインクリメントしながら各ミドルウェアを呼び出し、`next()` が呼ばれると `index + 1` で再帰する。リゾルバは最後のミドルウェアとして配列末尾に配置される。

この設計の利点は、ミドルウェアが `next()` の前後に処理を挟める点（before/after パターン）にある。出力バリデーションミドルウェアは `next()` の後に結果を検証するし、ロギングミドルウェアは前後両方に処理を入れられる。

```typescript
// packages/server/src/unstable-core-do-not-import/procedureBuilder.ts:634-672
async function callRecursive(
  index: number,
  _def: AnyProcedureBuilderDef,
  opts: ProcedureCallOptions<any>,
): Promise<MiddlewareResult<any>> {
  try {
    const middleware = _def.middlewares[index]!;
    const result = await middleware({
      ...opts,
      meta: _def.meta,
      input: opts.input,
      next(_nextOpts?: any) {
        const nextOpts = _nextOpts as
          | { ctx?: Record<string, unknown>; input?: unknown; getRawInput?: GetRawInputFn; }
          | undefined;
        return callRecursive(index + 1, _def, {
          ...opts,
          ctx: nextOpts?.ctx ? { ...opts.ctx, ...nextOpts.ctx } : opts.ctx,
          input: nextOpts && "input" in nextOpts ? nextOpts.input : opts.input,
          getRawInput: nextOpts?.getRawInput ?? opts.getRawInput,
        });
      },
    });
    return result;
  } catch (cause) {
    return {
      ok: false,
      error: getTRPCErrorFromUnknown(cause),
      marker: middlewareMarker,
    };
  }
}
```

### ブランド型による戻り値プロトコルの強制

`middlewareMarker` は `'middlewareMarker' & { __brand: 'middlewareMarker' }` というブランド型で定義されている。`MiddlewareResultBase` の `marker` フィールドにこの型が要求されるため、ミドルウェアの戻り値は必ず `next()` の結果か、`middlewareMarker` を含むオブジェクトでなければならない。

この手法は「ミドルウェアが `next()` を呼び忘れる」「独自のレスポンスを不正に返す」といったバグをコンパイル時に防止する。ランタイムでも `createProcedureCaller` で `result` の存在チェックとエラーメッセージを出している。

```typescript
// packages/server/src/unstable-core-do-not-import/middleware.ts:8-19
export const middlewareMarker = "middlewareMarker" as "middlewareMarker" & {
  __brand: "middlewareMarker";
};

interface MiddlewareResultBase {
  /**
   * All middlewares should pass through their `next()`'s output.
   * Requiring this marker makes sure that can't be forgotten at compile-time.
   */
  readonly marker: MiddlewareMarker;
}
```

### コンテキスト拡張の型追跡

`MiddlewareFunction` のジェネリクスは `TContext`（初期コンテキスト）、`TContextOverridesIn`（前段からの累積オーバーライド）、`$ContextOverridesOut`（当該ミドルウェアが追加する拡張）の3つを分離している。`ProcedureBuilder.use()` を呼ぶと `Overwrite<TContextOverrides, $ContextOverridesOut>` で合成され、次のミドルウェアに伝搬する。

テストコードが示すように、チェーン内の各ステップで `expectTypeOf(opts.ctx)` によりコンテキスト型が正確に追跡されていることが検証されている。

```typescript
// packages/tests/server/middlewares.test.ts:36-68
const barMiddleware = fooMiddleware.unstable_pipe((opts) => {
  expectTypeOf(opts.ctx).toEqualTypeOf<{
    user: User;
    foo: "foo";
  }>();
  return opts.next({ ctx: { bar: "bar" as const } });
});

const bazMiddleware = barMiddleware.unstable_pipe((opts) => {
  expectTypeOf(opts.ctx).toEqualTypeOf<{
    user: User;
    foo: "foo";
    bar: "bar";
  }>();
  return opts.next({ ctx: { baz: "baz" as const } });
});
```

### 入出力バリデーションのミドルウェア統一

`ProcedureBuilder.input()` は内部的に `createInputMiddleware(parser)` を呼び、スキーマバリデータをミドルウェアに変換する。このミドルウェアは `opts.getRawInput()` で生の入力を取得し、パースして `next({ input: combinedInput })` で次段に渡す。複数回 `.input()` を呼ぶと、オブジェクト同士がマージされる。

出力バリデーションも同様に `.output()` が `createOutputMiddleware(parser)` を呼び、`next()` の結果に対してパースを実行する。入力エラーは `BAD_REQUEST`、出力エラーは `INTERNAL_SERVER_ERROR` と、エラーコードが意味的に使い分けられている。

```typescript
// packages/server/src/unstable-core-do-not-import/middleware.ts:186-213
export function createInputMiddleware<TInput>(parse: ParseFn<TInput>) {
  const inputMiddleware: AnyMiddlewareFunction = async function inputValidatorMiddleware(opts) {
    let parsedInput: ReturnType<typeof parse>;
    const rawInput = await opts.getRawInput();
    try {
      parsedInput = await parse(rawInput);
    } catch (cause) {
      throw new TRPCError({ code: "BAD_REQUEST", cause });
    }
    // Multiple input parsers
    const combinedInput = isObject(opts.input) && isObject(parsedInput)
      ? { ...opts.input, ...parsedInput }
      : parsedInput;
    return opts.next({ input: combinedInput });
  };
  inputMiddleware._type = "input";
  return inputMiddleware;
}
```

### ビルダー合成とライブラリ間相互運用

`ProcedureBuilder.concat()` は別の `ProcedureBuilder` のミドルウェア・入力・出力・メタをすべてマージする。これにより、ライブラリが公開する基本プロシージャをアプリケーション側で拡張できる。型レベルでは `Overwrite<TContext, TContextOverrides> extends $Context` の制約でコンテキスト互換性がチェックされ、不整合は `TypeError<'Context mismatch'>` として報告される。

```typescript
// packages/server/src/unstable-core-do-not-import/procedureBuilder.ts:325-357
concat<$Context, $Meta, $ContextOverrides, $InputIn, $InputOut, $OutputIn, $OutputOut>(
  builder: Overwrite<TContext, TContextOverrides> extends $Context
    ? TMeta extends $Meta
      ? ProcedureBuilder<$Context, $Meta, $ContextOverrides, ...>
      : TypeError<'Meta mismatch'>
    : TypeError<'Context mismatch'>,
): ProcedureBuilder<
  TContext, TMeta,
  Overwrite<TContextOverrides, $ContextOverrides>,
  IntersectIfDefined<TInputIn, $InputIn>,
  IntersectIfDefined<TInputOut, $InputOut>,
  ...
>;
```

### エラー境界としてのミドルウェアチェーン

`callRecursive` の try-catch はチェーン全体のエラー境界として機能する。ミドルウェアやリゾルバが投げた任意の例外は `getTRPCErrorFromUnknown` で `TRPCError` にラップされ、`MiddlewareResult` の `ok: false` として伝搬する。これにより、ミドルウェアチェーンの呼び出し元は常に構造化された結果を受け取れる。

## コード例

```typescript
// packages/server/src/unstable-core-do-not-import/middleware.ts:219-243
// 出力バリデーションミドルウェア: next() の結果を後処理する before/after パターン
export function createOutputMiddleware<TOutput>(parse: ParseFn<TOutput>) {
  const outputMiddleware: AnyMiddlewareFunction = async function outputValidatorMiddleware({ next }) {
    const result = await next();
    if (!result.ok) {
      // pass through failures without validating
      return result;
    }
    try {
      const data = await parse(result.data);
      return { ...result, data };
    } catch (cause) {
      throw new TRPCError({
        message: "Output validation failed",
        code: "INTERNAL_SERVER_ERROR",
        cause,
      });
    }
  };
  outputMiddleware._type = "output";
  return outputMiddleware;
}
```

```typescript
// packages/server/src/unstable-core-do-not-import/procedureBuilder.ts:506-519
// .input() と .output() がミドルウェアに変換される箇所
input(input) {
  const parser = getParseFn(input as Parser);
  return createNewBuilder(_def, {
    inputs: [input as Parser],
    middlewares: [createInputMiddleware(parser)],
  });
},
output(output: Parser) {
  const parser = getParseFn(output);
  return createNewBuilder(_def, {
    output,
    middlewares: [createOutputMiddleware(parser)],
  });
},
```

```typescript
// packages/server/src/unstable-core-do-not-import/procedureBuilder.ts:568-584
// リゾルバも最後のミドルウェアとしてラップされる
function createResolver(
  _defIn: AnyProcedureBuilderDef & { type: ProcedureType; },
  resolver: AnyResolver,
) {
  const finalBuilder = createNewBuilder(_defIn, {
    resolver,
    middlewares: [
      async function resolveMiddleware(opts) {
        const data = await resolver(opts);
        return {
          marker: middlewareMarker,
          ok: true,
          data,
          ctx: opts.ctx,
        } as const;
      },
    ],
  });
  // ...
}
```

```typescript
// packages/server/src/unstable-core-do-not-import/middleware.ts:127-161
// MiddlewareBuilder の unstable_pipe: ミドルウェア配列のフラット結合
function createMiddlewareInner(
  middlewares: AnyMiddlewareFunction[],
): AnyMiddlewareBuilder {
  return {
    _middlewares: middlewares,
    unstable_pipe(middlewareBuilderOrFn) {
      const pipedMiddleware = "_middlewares" in middlewareBuilderOrFn
        ? middlewareBuilderOrFn._middlewares
        : [middlewareBuilderOrFn];
      return createMiddlewareInner([...middlewares, ...pipedMiddleware]);
    },
  };
}
```

## パターンカタログ

- **Chain of Responsibility** (分類: 振る舞い)
  - 解決する問題: リクエスト処理パイプラインの各段階を独立したハンドラとして分離し、動的に構成する
  - 適用条件: リクエストの処理が複数の直交する関心事（認証・バリデーション・ロギング等）を持つ場合
  - コード例: `packages/server/src/unstable-core-do-not-import/procedureBuilder.ts:634-672` (`callRecursive`)
  - 注意点: tRPC の実装は純粋な Chain of Responsibility とは異なり、すべてのミドルウェアが `next()` で後続を明示的に呼ぶ必要がある。チェーンの中断はエラー throw で行う

- **Builder** (分類: 生成)
  - 解決する問題: ミドルウェア・バリデータ・リゾルバという異なる種類のコンポーネントを一貫したインターフェースで段階的に組み立てる
  - 適用条件: パイプラインの構成要素が多く、組み合わせの自由度が高い場合
  - コード例: `packages/server/src/unstable-core-do-not-import/procedureBuilder.ts:486-566` (`createBuilder`)
  - 注意点: 各 `.use()` / `.input()` は新しいビルダーを返す不変操作。同じビルダーを複数箇所で使い回せる利点がある

- **Branded Type (Phantom Marker)** (分類: 型安全パターン)
  - 解決する問題: 構造的に同一だが意味的に異なる値を型レベルで区別する
  - 適用条件: ミドルウェアの戻り値が特定のプロトコル（`next()` 経由）に従っていることを保証したい場合
  - コード例: `packages/server/src/unstable-core-do-not-import/middleware.ts:8-11` (`middlewareMarker`)
  - 注意点: ランタイムの追加コストはほぼゼロだが、ブランド型の定義パターンが TypeScript 固有であり、他言語への移植性はない

## Good Patterns

- **すべてをミドルウェアに統一する**: 入力バリデーション、出力バリデーション、リゾルバを全て `MiddlewareFunction` シグネチャにラップすることで、実行エンジンが単一の `callRecursive` ループで済む。新しい種類の処理（キャッシュ、レートリミット等）を追加する際もミドルウェアとして実装すれば自動的にパイプラインに統合される。

```typescript
// Good: すべてが同一シグネチャのミドルウェアになる
// 入力バリデーション → ミドルウェア
middlewares: [createInputMiddleware(parser)]
// 出力バリデーション → ミドルウェア
middlewares: [createOutputMiddleware(parser)]
// リゾルバ → 最後のミドルウェア
middlewares: [async function resolveMiddleware(opts) { ... }]
```

- **コンテキスト拡張を差分のみで記述する**: `next({ ctx: { user } })` は既存コンテキストに `user` をマージする。ミドルウェアは「自分が追加する分」だけを記述すればよく、前段のコンテキスト構造を知る必要がない。型レベルでも `$ContextOverridesOut` として差分だけが追跡される。

```typescript
// Good: 差分のみを渡す
const authMiddleware = t.middleware((opts) => {
  if (!opts.ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });
  return opts.next({
    ctx: { user: opts.ctx.user }, // non-nullable に絞る
  });
});
```

- **ビルダーの途中段階を変数に束縛して再利用する**: `const authedProcedure = t.procedure.use(authMiddleware)` のように、パイプラインの途中状態を名前付きの変数にできる。これはビルダーが不変であるために安全に動作する。

```typescript
// Good: 再利用可能な基本プロシージャ
const authedProcedure = t.procedure.use(authMiddleware);
const orgProcedure = authedProcedure
  .input(z.object({ organizationId: z.string() }))
  .use(orgMiddleware);
// authedProcedure は変更されない
```

- **`TypeError<'...'>`による型レベルエラーメッセージ**: `concat()` でコンテキストやメタが不整合の場合、`TypeError<'Context mismatch'>` というカスタム型が返される。開発者は IDE のエラーメッセージで何が問題かを即座に理解できる。

```typescript
// Good: 型レベルでの明確なエラーメッセージ
export type TypeError<TMessage extends string> = TMessage & {
  _: typeof _errorSymbol;
};
// 使用例: TypeError<'Context mismatch'>, TypeError<'Meta mismatch'>
```

## Anti-Patterns / 注意点

- **`next()` の呼び忘れ**: ミドルウェアが `next()` を呼ばずに何らかの値を返そうとすると、`middlewareMarker` が含まれないため型エラーになる。ランタイムでも `callRecursive` の呼び出し元で `!result` チェックが行われ、`'No result from middlewares - did you forget to return next()?'` というエラーが出る。

```typescript
// Bad: next() を呼ばずに独自値を返そうとする
const badMiddleware = t.middleware((opts) => {
  return { ok: true, data: "shortcut" };
  // 型エラー: marker プロパティが不足
});

// Better: 必ず next() 経由で結果を返す
const goodMiddleware = t.middleware((opts) => {
  return opts.next();
});
```

- **コンテキストオーバーライドによる型の不整合**: `next({ ctx: { init: 'override' } })` のように既存プロパティを別の型で上書きすると、後段のミドルウェアは上書き後の型を見る。前段と後段で同じプロパティ名に異なる意味を持たせるとバグの温床になる。テスト `issue-4527` では、このオーバーライド挙動が意図的にテストされている。

```typescript
// Bad: 既存プロパティを異なる型で暗黙にオーバーライド
const overrideMiddleware = t.middleware((opts) => {
  return opts.next({
    ctx: { init: "override" as const }, // init の型が変わる
  });
});

// Better: 別のプロパティ名を使うか、型互換性を保つ
const safeMiddleware = t.middleware((opts) => {
  return opts.next({
    ctx: { parsedInit: parseInit(opts.ctx.init) },
  });
});
```

- **`unstable_pipe` でコンテキスト要件が不整合のミドルウェアを結合する**: テスト `pipe middlewares - failure` が示すように、あるミドルウェアがコンテキストの型を変更した後、元のルートコンテキストを前提とする別のミドルウェアを `unstable_pipe` すると `@ts-expect-error` が必要になる。`pipe` は `use` と異なり、合成元ミドルウェアのコンテキスト変更を前提に結合されるため、元の初期コンテキストに依存するミドルウェアとは互換性がない。

```typescript
// Bad: fooMiddleware が init を上書きした後、barMiddleware が元の init を期待する
const fooMiddleware = t.middleware((opts) => {
  return opts.next({ ctx: { init: { a: "a" as const }, foo: "foo" as const } });
});
const barMiddleware = t.middleware((opts) => {
  // opts.ctx.init は { a: 'a'; b: 'b'; c: { d: 'd'; e: 'e' } } を期待するが
  // foo の後では { a: 'a' } になっている
  return opts.next({ ctx: { bar: "bar" as const } });
});
// @ts-expect-error barMiddleware accessing invalid property
const combined = fooMiddleware.unstable_pipe(barMiddleware);
```

## 導出ルール

- `[MUST]` ミドルウェアの戻り値型にブランドマーカーを含め、`next()` 経由の結果のみを許可する
  - 根拠: tRPC の `middlewareMarker` はミドルウェアが `next()` を呼び忘れるバグをコンパイル時に防止している（`middleware.ts:8-19`）

- `[MUST]` ミドルウェアチェーンの実行エンジンはエラーを catch し、構造化された Result 型（ok/error 判別共用体）で呼び出し元に返す
  - 根拠: `callRecursive` の try-catch が全ての例外を `MiddlewareResult` に変換し、チェーン外への例外リークを防止している（`procedureBuilder.ts:665-671`）

- `[MUST]` コンテキスト拡張は差分オブジェクトのマージで行い、型パラメータで累積的に追跡する
  - 根拠: `Overwrite<TContextOverrides, $ContextOverridesOut>` により、チェーンの各段階でコンテキスト型が正確に推論される（`middleware.ts:89-120`, `procedureBuilder.ts:259-283`）

- `[SHOULD]` バリデーション（入力・出力）をミドルウェアとして統一的に扱い、実行エンジンを単一化する
  - 根拠: `createInputMiddleware` と `createOutputMiddleware` がパーサをミドルウェアにラップすることで、`callRecursive` だけでパイプライン全体を実行できている（`middleware.ts:186-243`）

- `[SHOULD]` パイプラインビルダーを不変にし、途中段階を変数に束縛して複数プロシージャで再利用可能にする
  - 根拠: `createNewBuilder` は常に新しいビルダーを生成するため、`authedProcedure` を複数箇所で安全に共有できる（`procedureBuilder.ts:471-484`）

- `[SHOULD]` ミドルウェアの合成で型の不整合がある場合、`TypeError<'...'>`のようなカスタム型でコンパイル時にわかりやすいエラーメッセージを提供する
  - 根拠: `concat()` の `TypeError<'Context mismatch'>` / `TypeError<'Meta mismatch'>` が、IDE 上で原因を即座に特定できるようにしている（`procedureBuilder.ts:325-357`）

- `[AVOID]` ミドルウェアチェーン内で既存コンテキストプロパティを異なる型で暗黙にオーバーライドする
  - 根拠: `Overwrite` は既存キーを新しい型で上書きするため、後段のミドルウェアが元の型を期待している場合に型不整合が発生する（テスト `issue-4527`, `middlewares.test.ts:390-401`）

- `[AVOID]` ミドルウェアの `next()` を条件分岐で呼んだり呼ばなかったりする設計（認証ガードなどでのショートサーキットは例外 throw で行うべき）
  - 根拠: tRPC は認証失敗を `throw new TRPCError({ code: 'UNAUTHORIZED' })` で処理し、`next()` を呼ばないパスでは常に例外を投げる設計にしている（`procedureBuilder.test.ts:62-73`）

## 適用チェックリスト

- [ ] ミドルウェアの戻り値型にブランドマーカーや判別共用体を定義し、`next()` 経由のみを許可する型制約を導入したか
- [ ] 実行エンジン（ランナー）を単一の再帰/ループ関数に統一し、入力バリデーション・出力バリデーション・リゾルバを同一シグネチャのミドルウェアとして扱っているか
- [ ] コンテキスト拡張が差分マージで行われ、型パラメータが累積的に追跡されるか（`Overwrite`/`Merge` 型ユーティリティの実装）
- [ ] ビルダーの各メソッドが不変（新しいインスタンスを返す）で、途中段階を安全に再利用できるか
- [ ] エラーが構造化された Result 型で返され、ミドルウェアチェーンの外側に未処理例外がリークしないか
- [ ] ミドルウェアの合成で型不整合がある場合、開発者にわかりやすいコンパイルエラーが出るか
- [ ] コンテキストプロパティの命名規則を定め、暗黙のオーバーライドを防いでいるか
