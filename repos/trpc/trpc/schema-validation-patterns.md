# schema-validation-patterns

> リポジトリ: trpc/trpc
> 分析日: 2026-02-24

## 概要

tRPC はバリデーションライブラリに一切依存しない Parser 抽象を持ち、zod・valibot・yup・superstruct・myzod・arktype・effect 等 10 以上のライブラリをゼロコンフィグで受け入れる。この設計は「構造的型付け（duck typing）によるアダプター不要化」「バリデーションのミドルウェア変換」「入力の合成的チェーン」という 3 つの技法で成り立っており、バリデーターに依存しない入出力検証レイヤーの設計として注目に値する。

## 背景にある原則

- **構造的互換で依存を排除すべき、なぜなら利用者のライブラリ選択を制約しないため**: tRPC は各バリデーションライブラリの型を `ParserZodEsque`・`ParserValibotEsque` 等の構造型として定義し、import や依存関係を一切持たない。ライブラリが `.parse()` や `.validateSync()` を持つかどうかをランタイムで判別するだけで統合が完了する（`parser.ts:84-140`）。
- **バリデーションはミドルウェアとして実装すべき、なぜなら検証ロジックをパイプラインに自然に組み込めるため**: `.input()` や `.output()` は内部で `createInputMiddleware` / `createOutputMiddleware` を生成し、ミドルウェアチェーンに追加する。検証は特別な仕組みではなく、他のミドルウェアと同列に扱われる（`procedureBuilder.ts:507-519`）。
- **型情報と実行ロジックを分離すべき、なぜなら型推論とランタイム検証は異なる要件を持つため**: `inferParser<$Parser>` は純粋に型レベルで入出力の型を抽出し、`getParseFn()` はランタイムで検証関数を取り出す。この分離により、型推論の精度を犠牲にせずランタイム挙動を柔軟に変えられる（`parser.ts:64-82`）。

## 実例と分析

### 構造的型付けによるバリデーター検出

`getParseFn()` は引数のバリデーターオブジェクトに対し、メソッドの存在チェックを決まった優先順位で行う。特定ライブラリの import は一切行わず、「`.parseAsync` を持つならそれを使う」「`.parse` を持つならそれを使う」という判定を繰り返す。

```typescript
// packages/server/src/unstable-core-do-not-import/parser.ts:84-140
export function getParseFn<TType>(procedureParser: Parser): ParseFn<TType> {
  const parser = procedureParser as any;
  const isStandardSchema = "~standard" in parser;

  if (typeof parser === "function" && typeof parser.assert === "function") {
    // ParserArkTypeEsque
    return parser.assert.bind(parser);
  }

  if (typeof parser === "function" && !isStandardSchema) {
    // ParserCustomValidatorEsque / ParserValibotEsque (>= v0.31.0)
    return parser;
  }

  if (typeof parser.parseAsync === "function") {
    // ParserZodEsque
    return parser.parseAsync.bind(parser);
  }

  if (typeof parser.parse === "function") {
    // ParserZodEsque / ParserValibotEsque (< v0.13.0)
    return parser.parse.bind(parser);
  }
  // ... yup, superstruct, scale, standard-schema へのフォールバック続く
}
```

注目すべき設計判断が 2 つある。まず、`parseAsync` が `parse` より先にチェックされる。これにより zod の非同期リファインメント（`.refine(async ...)` 等）が透過的にサポートされる。次に、各メソッドで `.bind(parser)` が使われている。これはバリデーターメソッドが `this` コンテキストに依存するケース（zod 等）に対応するためである。

### 型レベルの Parser 統一と inferParser

型レベルでは `Parser` ユニオン型がすべてのバリデーターを包含し、`inferParser` 条件型が入力型（`in`）と出力型（`out`）を抽出する。

```typescript
// packages/server/src/unstable-core-do-not-import/parser.ts:62-80
export type Parser = ParserWithInputOutput<any, any> | ParserWithoutInput<any>;

export type inferParser<TParser extends Parser> = TParser extends ParserStandardSchemaEsque<infer $TIn, infer $TOut>
  ? { in: $TIn; out: $TOut; }
  : TParser extends ParserWithInputOutput<infer $TIn, infer $TOut> ? { in: $TIn; out: $TOut; }
  : TParser extends ParserWithoutInput<infer $InOut> ? { in: $InOut; out: $InOut; }
  : never;
```

`ParserWithInputOutput` は transform 対応（入力型と出力型が異なる）のライブラリ群、`ParserWithoutInput` は入力型と出力型が同一のライブラリ群を表す。Standard Schema は最優先でチェックされ、将来のバリデーターはこの規格に準拠すれば自動的にサポートされる。

### バリデーションのミドルウェア化

`.input()` 呼び出しは内部で `createInputMiddleware` を生成し、ミドルウェアチェーンに追加する。

```typescript
// packages/server/src/unstable-core-do-not-import/procedureBuilder.ts:507-513
input(input) {
  const parser = getParseFn(input as Parser);
  return createNewBuilder(_def, {
    inputs: [input as Parser],
    middlewares: [createInputMiddleware(parser)],
  });
},
```

`createInputMiddleware` は `getRawInput()` でリクエストの生データを取得し、パースして後続に渡す。

```typescript
// packages/server/src/unstable-core-do-not-import/middleware.ts:186-214
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

入力バリデーション失敗は `BAD_REQUEST`（クライアント起因）、出力バリデーション失敗は `INTERNAL_SERVER_ERROR`（サーバー起因）として扱われる。この非対称性は、入力エラーはクライアントが修正可能だが出力エラーはサーバーのバグであるという意味論に基づく。

### 複数 .input() のチェーンと IntersectIfDefined

`.input()` を複数回呼ぶと、型レベルでは `IntersectIfDefined` で交差型が構築され、ランタイムでは各ミドルウェアの結果がオブジェクトスプレッド（`{ ...opts.input, ...parsedInput }`）でマージされる。

```typescript
// packages/server/src/unstable-core-do-not-import/procedureBuilder.ts:37-41
type IntersectIfDefined<TType, TWith> = TType extends UnsetMarker ? TWith
  : TWith extends UnsetMarker ? TType
  : Simplify<TType & TWith>;
```

この仕組みにより、基盤プロシージャで共通入力を定義し、派生プロシージャで追加フィールドを足す「段階的入力構築」が実現する。テストコード（`input.test.ts:18-59`）で `roomProcedure` が `roomId` を要求し、`sendMessage` が `text` を追加する例がこのパターンの典型である。

ただし、チェーンは両方がオブジェクト型である場合のみ許可される。非オブジェクト型（`z.literal('hello')` 等）のチェーンは型レベルでエラーになる（`input.test.ts:117-144`）。optional チェーンの制約もあり、required の後に optional をチェーンすることはできない（`input.test.ts:268-277`）。

### Standard Schema V1 のベンダリング

tRPC は Standard Schema の仕様を `vendor/standard-schema-v1/` にコピーして保持している。npm パッケージへの依存ではなくベンダリングを選択しているのは、仕様が安定しており頻繁な更新が不要であること、および `@standard-schema/spec` パッケージへの依存を増やさないためと推測される。

```typescript
// packages/server/src/vendor/standard-schema-v1/spec.ts:10-13
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}
```

## パターンカタログ

- **Adapter パターン** (分類: 構造)
  - 解決する問題: 異なるバリデーションライブラリの API を統一的に扱う
  - 適用条件: 複数の外部ライブラリが同等の機能を異なるインターフェースで提供している場面
  - コード例: `parser.ts:84-140`（`getParseFn` が各ライブラリの差異を吸収）
  - 注意点: 典型的な GoF Adapter はラッパークラスを作るが、tRPC は構造的型付け + ランタイム duck typing で実現しており、アダプタークラスが不要。「暗黙的アダプター」とも呼べる変形。

- **Chain of Responsibility パターン** (分類: 振る舞い)
  - 解決する問題: 入力バリデーション、認証、ビジネスロジック等の横断的関心事を順序付けて実行する
  - 適用条件: リクエスト処理パイプラインに複数の検証・変換ステップがある場面
  - コード例: `procedureBuilder.ts:634-672`（`callRecursive` がミドルウェアを順次呼び出す）
  - 注意点: バリデーションミドルウェアも通常のミドルウェアも同じチェーンで処理されるため、順序が意味を持つ（`.input()` と `.use()` の呼び出し順がチェーン順になる）

## Good Patterns

- **構造型で外部ライブラリを記述する**: 各バリデーターの型を `ParserZodEsque`、`ParserYupEsque` 等の構造型として定義する。import が不要なため、利用者がどのライブラリを使っていても tRPC のコアパッケージサイズに影響しない。

```typescript
// packages/server/src/unstable-core-do-not-import/parser.ts:5-8
export type ParserZodEsque<TInput, TParsedInput> = {
  _input: TInput;
  _output: TParsedInput;
};
```

- **入出力で異なるエラーコードを返す**: 入力バリデーション失敗は `BAD_REQUEST`（400 系）、出力バリデーション失敗は `INTERNAL_SERVER_ERROR`（500 系）を使い分ける。クライアントが修正可能なエラーとサーバー内部のバグを明確に区別できる。

```typescript
// packages/server/src/unstable-core-do-not-import/middleware.ts:195-198 (入力)
throw new TRPCError({ code: "BAD_REQUEST", cause });

// packages/server/src/unstable-core-do-not-import/middleware.ts:234-237 (出力)
throw new TRPCError({
  message: "Output validation failed",
  code: "INTERNAL_SERVER_ERROR",
  cause,
});
```

- **非同期パースを優先的にチェックする**: `getParseFn` で `parseAsync` を `parse` より先にチェックすることで、非同期リファインメントを持つスキーマも透過的に動作する。同期 parse しかないライブラリでも Promise ラップにより統一的に扱える。

```typescript
// packages/server/src/unstable-core-do-not-import/parser.ts:99-108
if (typeof parser.parseAsync === "function") {
  return parser.parseAsync.bind(parser);
}
if (typeof parser.parse === "function") {
  return parser.parse.bind(parser);
}
```

## Anti-Patterns / 注意点

- **バリデーター検出順序の暗黙的優先度**: `getParseFn` の if 文の並び順がバリデーター検出の優先度を決定する。arktype は「関数でありかつ `.assert` を持つ」ケースを最初にチェックしなければ、カスタムバリデーター（単なる関数）として扱われてしまう。この暗黙的な順序依存は新しいライブラリ追加時にバグを生みやすい。

```typescript
// Bad: 順序を意識せずにチェックを追加する
if (typeof parser === "function") {
  return parser; // arktype も function なのでここで捕捉されてしまう
}

// Better: より特殊な条件を先にチェックする
if (typeof parser === "function" && typeof parser.assert === "function") {
  return parser.assert.bind(parser); // arktype 用の特殊ケースが先
}
if (typeof parser === "function" && !isStandardSchema) {
  return parser; // カスタムバリデーターはフォールバック
}
```

- **非オブジェクト型の .input() チェーンが型エラーのみでランタイム保護がない**: `.input(z.literal('hello')).input(z.object({...}))` は TypeScript の型エラーになるが、ランタイムでは `isObject` チェックにより後者の結果だけが使われ、最初のバリデーションが無視される可能性がある。型エラーを無視した場合のランタイム挙動が不明確になる。

```typescript
// Bad: 非オブジェクト型をチェーンする（型エラーが出るが無視した場合）
t.procedure
  .input(z.literal("hello"))
  .input(z.object({ foo: z.string() })); // 型エラー

// Better: チェーンが必要なら最初からオブジェクト型を使う
t.procedure
  .input(z.object({ greeting: z.literal("hello") }))
  .input(z.object({ foo: z.string() }));
```

## 導出ルール

- `[MUST]` バリデーション失敗時のエラーコードを入力（クライアント起因）と出力（サーバー起因）で区別する
  - 根拠: tRPC は入力バリデーション失敗を `BAD_REQUEST`、出力バリデーション失敗を `INTERNAL_SERVER_ERROR` として明確に分離している（`middleware.ts:196, 236`）
- `[SHOULD]` 外部ライブラリの統合には構造的型付け（duck typing）を使い、ライブラリ本体への import 依存を避ける
  - 根拠: tRPC は zod・valibot 等を一切 import せず、メソッドの存在チェックだけで 10 以上のライブラリをサポートしている（`parser.ts:84-140`）
- `[SHOULD]` バリデーションをミドルウェア/パイプラインステップとして実装し、認証や変換と同列に扱えるようにする
  - 根拠: `createInputMiddleware` / `createOutputMiddleware` により、バリデーションは通常のミドルウェアと同じチェーンで実行され、順序の制御や組み合わせが容易になっている（`middleware.ts:186-243`）
- `[SHOULD]` 型推論（コンパイルタイム）と実行ロジック（ランタイム）を別の仕組みで実装し、それぞれ最適化する
  - 根拠: `inferParser` は型レベルの条件分岐で入出力型を抽出し、`getParseFn` はランタイムの duck typing で検証関数を取得する。両者は独立しており、片方の変更がもう片方に影響しない（`parser.ts:64-82, 84-140`）
- `[SHOULD]` duck typing で複数のメソッドシグネチャを判定する場合、より特殊な条件を先にチェックする
  - 根拠: `getParseFn` は arktype（関数かつ `.assert` を持つ）をカスタムバリデーター（単なる関数）より先にチェックすることで、誤検出を防いでいる（`parser.ts:88-97`）
- `[AVOID]` バリデーション統合で各ライブラリ用のアダプタークラスを個別に作成すること。構造的型付けで代替できる場合はアダプターは不要
  - 根拠: tRPC は Adapter クラスを一つも持たず、構造型の定義 + ランタイム duck typing だけで多ライブラリ対応を実現し、保守コストを最小化している（`parser.ts` 全体）

## 適用チェックリスト

- [ ] プロジェクトでバリデーションライブラリを直接 import しているか確認し、構造的型付けで置き換え可能か検討する
- [ ] 入力バリデーションエラーと出力バリデーションエラーで異なる HTTP ステータスコード / エラー種別を返しているか確認する
- [ ] バリデーションが専用の仕組みではなくミドルウェアパイプラインの一部として実装できるか検討する
- [ ] 複数のバリデーションスキーマを合成する必要がある場合、オブジェクト型同士の交差として設計されているか確認する
- [ ] 外部ライブラリのメソッドをコールバックとして抽出する際に `.bind()` でコンテキストを保持しているか確認する
- [ ] Standard Schema などの業界標準インターフェースへの準拠を検討し、将来のライブラリ追加に備える
