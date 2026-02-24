# Pattern: Structural Duck Typing

> 出典: [repos/trpc/trpc](../repos/trpc/trpc/) -- schema-validation-patterns, type-system-patterns, api-design-practices, design-philosophy
> カテゴリ: pattern

## 概要

`-Esque` サフィックスの構造型で外部ライブラリのインターフェースを記述し、ランタイムでは Feature Detection（メソッド存在チェック）でディスパッチすることで、import 依存ゼロのまま複数ライブラリを統合するパターン。tRPC はこの手法で zod, valibot, yup, superstruct, myzod, arktype, Standard Schema 等 10 以上のバリデーションライブラリをアダプタークラスなしでサポートしている。バリデータに限らず、ロガー、キャッシュプロバイダ、ストレージドライバなど「ユーザーが選択するプラグイン的依存」の統合に汎用的に応用できる。

## 背景・文脈

ライブラリやフレームワークが外部ライブラリと統合する際、一般的には以下のいずれかのアプローチを取る。

1. **直接依存**: 特定ライブラリを `dependencies` に追加する（ユーザーの選択を制約する）
2. **アダプタークラス**: ライブラリごとにラッパーを作成する（保守コストが増大する）
3. **プラグインパッケージ分離**: `@foo/adapter-zod`, `@foo/adapter-yup` のように分離する（パッケージ爆発が起きる）

tRPC はこれらの問題を、TypeScript の構造的型付け（structural typing）を逆手に取ることで解決した。外部ライブラリの「型」を `-Esque` サフィックスの構造型として宣言し、ランタイムでは渡されたオブジェクトのメソッド存在を Feature Detection する。ライブラリ本体を一切 import しないため、ユーザーがどのライブラリを使っていても tRPC のバンドルサイズに影響しない。

## 実装パターン

### 1. `-Esque` 構造型の定義

外部ライブラリの「使いたいインターフェース部分」だけを構造型として記述する。ライブラリ自体を import する必要はない。

```typescript
// packages/server/src/unstable-core-do-not-import/parser.ts:5-8
export type ParserZodEsque<TInput, TParsedInput> = {
  _input: TInput;
  _output: TParsedInput;
};
```

`-Esque` サフィックスは「〜風の」「〜に似た」を意味し、特定ライブラリへの依存ではなく構造的互換を示す命名規約である。同様に `ParserValibotEsque`, `ParserYupEsque`, `ParserSuperstructEsque`, `ParserMyZodEsque`, `ParserArkTypeEsque` 等が定義されている。

### 2. Union 型による統一 Parser 型

個々の `-Esque` 型を Union で束ねて、どのライブラリのスキーマでも受け入れる統一型を作る。

```typescript
// packages/server/src/unstable-core-do-not-import/parser.ts:62-63
export type Parser = ParserWithInputOutput<any, any> | ParserWithoutInput<any>;
```

`ParserWithInputOutput` は transform 対応（入力型と出力型が異なる）のライブラリ群、`ParserWithoutInput` は入力型と出力型が同一のライブラリ群を表す。

### 3. 型レベルの推論: `inferParser`

各ライブラリのスキーマから `{ in: TInput; out: TOutput }` を統一的に抽出する条件付き型チェーン。

```typescript
// packages/server/src/unstable-core-do-not-import/parser.ts:64-80
export type inferParser<TParser extends Parser> =
  TParser extends ParserStandardSchemaEsque<infer $TIn, infer $TOut>
    ? { in: $TIn; out: $TOut }
    : TParser extends ParserWithInputOutput<infer $TIn, infer $TOut>
      ? { in: $TIn; out: $TOut }
      : TParser extends ParserWithoutInput<infer $InOut>
        ? { in: $InOut; out: $InOut }
        : never;
```

Standard Schema が最優先でチェックされ、将来のバリデータはこの規格に準拠すれば自動サポートされる設計になっている。

### 4. ランタイムの Feature Detection: `getParseFn`

ランタイムではメソッドの存在チェックを優先順位付きで行い、適切なパース関数を抽出する。

```typescript
// packages/server/src/unstable-core-do-not-import/parser.ts:84-140
export function getParseFn<TType>(procedureParser: Parser): ParseFn<TType> {
  const parser = procedureParser as any;
  const isStandardSchema = '~standard' in parser;

  if (typeof parser === 'function' && typeof parser.assert === 'function') {
    // ParserArkTypeEsque: 関数かつ .assert を持つ
    return parser.assert.bind(parser);
  }

  if (typeof parser === 'function' && !isStandardSchema) {
    // ParserCustomValidatorEsque / ParserValibotEsque (>= v0.31.0)
    return parser;
  }

  if (typeof parser.parseAsync === 'function') {
    // ParserZodEsque: 非同期リファインメント対応
    return parser.parseAsync.bind(parser);
  }

  if (typeof parser.parse === 'function') {
    // ParserZodEsque / ParserValibotEsque (< v0.13.0)
    return parser.parse.bind(parser);
  }
  // ... yup, superstruct, scale, standard-schema へのフォールバック続く

  throw new Error('Could not find a validator fn');
}
```

重要な設計判断が 3 つある。

1. **特殊→汎用の順序**: arktype は「関数かつ `.assert` を持つ」という特殊なケースを最初にチェックしなければ、カスタムバリデーター（単なる関数）として誤検出される
2. **非同期優先**: `parseAsync` を `parse` より先にチェックすることで、zod の非同期リファインメントが透過的に動作する
3. **`.bind(parser)` の適用**: バリデーターメソッドが `this` コンテキストに依存するケースに対応する

## Good Example

### 汎用化: ロガープロバイダの統合

tRPC のパターンをロガー統合に応用した例。pino, winston, bunyan 等を import なしで受け入れる。

```typescript
// --- 1. -Esque 構造型で各ロガーのインターフェースを記述 ---
type PinoEsque = {
  info(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  child(bindings: Record<string, unknown>): PinoEsque;
};

type WinstonEsque = {
  log(level: string, message: string): void;
  info(message: string): void;
  error(message: string): void;
};

type ConsoleEsque = {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

// --- 2. Union 型で統一 ---
type LoggerProvider = PinoEsque | WinstonEsque | ConsoleEsque;

// --- 3. Feature Detection でディスパッチ ---
function getLogFn(provider: LoggerProvider): (level: string, msg: string) => void {
  const logger = provider as any;

  if (typeof logger.child === 'function') {
    // pino 風: child メソッドを持つ
    return (level, msg) => logger[level]?.(msg);
  }

  if (typeof logger.log === 'function' && typeof logger.info === 'function') {
    // winston 風: log(level, msg) を持つ
    return (level, msg) => logger.log(level, msg);
  }

  // フォールバック: console 風
  return (level, msg) => {
    const fn = (logger as any)[level] ?? logger.log;
    fn?.call(logger, msg);
  };
}
```

### tRPC の実際のバリデータ統合利用例

ユーザーコード側では、どのバリデーションライブラリを使っても同じ API で tRPC プロシージャを定義できる。

```typescript
// zod を使う場合 -- tRPC は zod を import していない
import { z } from 'zod';
const appRouter = t.router({
  createUser: t.procedure
    .input(z.object({ name: z.string() }))
    .mutation(({ input }) => { /* input は { name: string } と推論される */ }),
});

// valibot を使う場合 -- tRPC は valibot を import していない
import * as v from 'valibot';
const appRouter = t.router({
  createUser: t.procedure
    .input(v.object({ name: v.string() }))
    .mutation(({ input }) => { /* input は { name: string } と推論される */ }),
});
```

## Bad Example

### NG: アダプタークラスを個別に作成する

```typescript
// Bad: ライブラリごとにアダプタークラスを作成
// ライブラリ追加のたびにアダプタの新規作成が必要
// ユーザーは正しいアダプタを選んで import する必要がある
interface ValidatorAdapter<TInput, TOutput> {
  parse(input: unknown): TOutput;
}

class ZodAdapter<T> implements ValidatorAdapter<T, T> {
  constructor(private schema: ZodSchema<T>) {} // zod を直接 import
  parse(input: unknown) { return this.schema.parse(input); }
}

class YupAdapter<T> implements ValidatorAdapter<T, T> {
  constructor(private schema: YupSchema<T>) {} // yup を直接 import
  parse(input: unknown) { return this.schema.validateSync(input); }
}

// ユーザーが手動でラップする必要がある
t.procedure.input(new ZodAdapter(z.object({ name: z.string() })));
```

問題点:
- ライブラリごとに `dependencies` が増える（使わないライブラリのコードもバンドルに含まれる可能性がある）
- 新しいライブラリに対応するたびにアダプタークラスを作成・公開・保守する必要がある
- ユーザーが適切なアダプタを選択して import する手間が発生する

### NG: Feature Detection の順序を意識しない

```typescript
// Bad: 特殊ケースを先にチェックしない
function getParseFn(parser: any) {
  if (typeof parser === 'function') {
    return parser; // arktype も function なのでここで捕捉されてしまう
  }
  if (typeof parser === 'function' && typeof parser.assert === 'function') {
    return parser.assert.bind(parser); // ここには到達しない
  }
  // ...
}

// Good: より特殊な条件を先にチェックする
function getParseFn(parser: any) {
  if (typeof parser === 'function' && typeof parser.assert === 'function') {
    return parser.assert.bind(parser); // arktype 用の特殊ケースが先
  }
  if (typeof parser === 'function') {
    return parser; // カスタムバリデーターはフォールバック
  }
  // ...
}
```

### NG: 構造型を定義せず `any` で受け入れる

```typescript
// Bad: 型情報を完全に放棄
function createProcedure(validator: any) {
  const parse = validator.parse ?? validator.validateSync ?? validator;
  // 型推論が効かないため、input の型が unknown になる
  return { parse };
}

// Good: 構造型で型推論を維持
function createProcedure<T extends Parser>(validator: T) {
  type Input = inferParser<T>['in'];
  type Output = inferParser<T>['out'];
  const parse = getParseFn<Output>(validator);
  return { parse };
}
```

## 適用ガイド

### どのような状況で使うべきか

- **プラグインシステム**: ユーザーが選択する外部ライブラリ（バリデータ、ロガー、キャッシュプロバイダ、ストレージドライバ等）を統合する場合
- **ライブラリ開発**: 特定の依存にロックインせず、複数の同等ライブラリを受け入れたい場合
- **バンドルサイズ最適化**: 使わないライブラリの import を完全に排除したい場合
- **将来のライブラリ対応**: 業界標準インターフェース（Standard Schema 等）への準拠で自動サポートを実現したい場合

### 使わないべき状況

- 統合先のライブラリが 1-2 個しかない場合（オーバーエンジニアリングになる）
- ライブラリの API が頻繁に破壊的変更を受ける場合（構造型の保守コストが高くなる）
- ランタイムのパフォーマンスが極めて重要な場合（Feature Detection のオーバーヘッドが問題になりうる。ただし初期化時に1回だけなら通常は無視できる）

### 導入時の注意点

1. **Feature Detection の順序は特殊→汎用で設計する**: 複数の条件にマッチしうるライブラリ（arktype は関数でありかつ `.assert` を持つ）がある場合、より特殊な条件を先にチェックしなければ誤検出が発生する

2. **`.bind()` でコンテキストを保持する**: 外部ライブラリのメソッドをコールバックとして抽出する際、`this` コンテキストに依存するケース（zod 等）に対応するため `.bind(parser)` を適用する

3. **型レベルの推論とランタイムの検出を分離する**: `inferParser` は型レベルで入出力型を抽出し、`getParseFn` はランタイムで検証関数を取得する。両者は独立しており、片方の変更がもう片方に影響しない設計にする

4. **フォールバック先に業界標準インターフェースを用意する**: tRPC は Standard Schema V1 を最後のフォールバックとして配置し、将来のバリデータが自動的にサポートされる仕組みを持つ

5. **最終手段として `throw new Error` で未対応を明示する**: どの Feature Detection にもマッチしない場合は、明確なエラーメッセージで未対応であることを伝える

### カスタマイズポイント

- **`-Esque` 型の粒度**: 型パラメータの数（入力型のみ／入力+出力型／入力+出力+エラー型）は統合先の要件に合わせて決める
- **Feature Detection の優先順位**: 非同期 API を同期 API より優先する（tRPC の `parseAsync` > `parse`）か、その逆かはユースケースに依存する
- **Standard Schema のような業界標準への対応**: フォールバックチェーンの末尾に配置することで、既存の個別対応を壊さずに標準対応を追加できる

## 導出ルール

- `[MUST]` Feature Detection で複数のメソッドシグネチャを判定する場合、より特殊な条件を先にチェックする -- 汎用条件が先だと特殊なライブラリが誤検出される（tRPC: `parser.ts:88-97` で arktype を custom validator より先にチェック）
- `[MUST]` 外部ライブラリのメソッドをコールバックとして抽出する際に `.bind()` でコンテキストを保持する -- `this` 依存のメソッドが `undefined` コンテキストで呼ばれるとランタイムエラーになる（tRPC: `parser.ts:90,100,104` で `.bind(parser)` を適用）
- `[SHOULD]` 外部ライブラリの統合には構造的型付け（`-Esque` 構造型）とランタイム Feature Detection を組み合わせ、ライブラリ本体への import 依存を排除する -- アダプタークラスの個別作成や直接依存に比べて保守コストが大幅に低く、ユーザーのライブラリ選択を制約しない（tRPC: `parser.ts` 全体で 10 以上のバリデータをゼロ依存で統合）
- `[SHOULD]` 型レベルの推論（`inferParser` 等の条件付き型チェーン）とランタイムの検出ロジック（`getParseFn` 等の Feature Detection）を分離して設計する -- 片方の変更がもう片方に影響しないため、新しいライブラリ対応が型定義の追加だけで済む（tRPC: `parser.ts:64-82` と `parser.ts:84-140` が独立）
- `[AVOID]` 外部ライブラリ統合でライブラリごとのアダプタークラスを個別に作成すること -- 構造的型付け + Feature Detection で代替できる場合、アダプターは保守コストを増大させるだけで価値がない（tRPC: アダプタークラスをゼロ個に抑えて 10 以上のライブラリをサポート）

## 参考

- [repos/trpc/trpc/schema-validation-patterns.md](../repos/trpc/trpc/schema-validation-patterns.md) -- 構造的型付けによるバリデーター検出の詳細分析
- [repos/trpc/trpc/type-system-patterns.md](../repos/trpc/trpc/type-system-patterns.md) -- `-Esque` パターンと `inferParser` 条件付き型の型レベル設計
- [repos/trpc/trpc/api-design-practices.md](../repos/trpc/trpc/api-design-practices.md) -- Duck Typing によるバリデータ非依存設計
- [repos/trpc/trpc/design-philosophy.md](../repos/trpc/trpc/design-philosophy.md) -- マルチバリデータ抽象によるロックイン回避の設計哲学
