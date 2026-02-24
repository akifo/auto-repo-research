# type-system-patterns

> リポジトリ: trpc/trpc
> 分析日: 2026-02-24

## 概要

tRPC は TypeScript の型システムを極限まで活用し、サーバーとクライアント間の完全な型安全性をゼロコード生成で実現している。ProcedureBuilder の8型パラメータによるステップバイステップの型蓄積、phantom type による型レベルエラーメッセージ、sentinel type による「未設定」状態の表現、条件付き型による多態的な戻り値型など、高度な型レベルプログラミングのパターンが体系的に適用されている。これらのパターンは fluent builder API を型安全に設計するための汎用的なプラクティスとして参考価値が高い。

## 背景にある原則

- **型パラメータは状態マシンである**: ProcedureBuilder の8つの型パラメータ（TContext, TMeta, TContextOverrides, TInputIn, TInputOut, TOutputIn, TOutputOut, TCaller）は、ビルダーの「現在の構成状態」を型レベルで表現する。`.input()` や `.use()` を呼ぶたびに該当する型パラメータだけが更新され、他は保持される。これにより、チェーン内の任意の時点で型の整合性が保証される（`procedureBuilder.ts:187-465`）。

- **コンパイル時エラーは実行時エラーより安い**: `TypeError<TMessage>` phantom type を使い、不正な操作に対してユーザーが理解可能なエラーメッセージを型レベルで提示する。通常の `never` ではなく `"Context mismatch"` のような文字列メッセージが IDE に表示されるため、開発者のデバッグコストを大幅に削減する（`types.ts:170-174`, `procedureBuilder.ts:209-212,309-310,346-347`）。

- **sentinel type で「未設定」と「設定済み」を区別する**: `UnsetMarker` という branded string type を「まだ設定されていない型パラメータ」のデフォルト値として使う。`DefaultValue<TValue, TFallback>` や `IntersectIfDefined<TType, TWith>` などの条件付き型が `UnsetMarker` を検知し、未設定時のフォールバック処理を型レベルで分岐させる（`utils.ts:1-4`, `procedureBuilder.ts:37-45`）。

- **型の簡約で IDE 体験を改善する**: `Simplify<TType>` は複雑な交差型を展開してフラットなオブジェクト型に変換する。ユーザーが hover したときに `{ a: string } & { b: number }` ではなく `{ a: string; b: number }` と表示される。型の正確性ではなく、可読性のための型変換である（`types.ts:16-18`）。

## 実例と分析

### ProcedureBuilder の型パラメータ蓄積パターン

ProcedureBuilder は8つの型パラメータを持ち、各メソッド呼び出しが特定のパラメータのみを更新する。`createBuilder` の初期状態では `UnsetMarker` と `object` と `false` がデフォルト値として設定される。

```typescript
// procedureBuilder.ts:486-496
export function createBuilder<TContext, TMeta>(
  initDef: Partial<AnyProcedureBuilderDef> = {},
): ProcedureBuilder<
  TContext,
  TMeta,
  object,          // TContextOverrides: 初期状態は空オブジェクト
  UnsetMarker,     // TInputIn: 未設定
  UnsetMarker,     // TInputOut: 未設定
  UnsetMarker,     // TOutputIn: 未設定
  UnsetMarker,     // TOutputOut: 未設定
  false            // TCaller: デフォルトは無効
>
```

`.input()` を呼ぶと `TInputIn` と `TInputOut` のみが `IntersectIfDefined` を通じて更新され、他の6パラメータは変更されない。

```typescript
// procedureBuilder.ts:201-222
input<$Parser extends Parser>(
  schema: ...,
): ProcedureBuilder<
  TContext,         // 変更なし
  TMeta,            // 変更なし
  TContextOverrides,// 変更なし
  IntersectIfDefined<TInputIn, inferParser<$Parser>['in']>,   // 更新
  IntersectIfDefined<TInputOut, inferParser<$Parser>['out']>, // 更新
  TOutputIn,        // 変更なし
  TOutputOut,       // 変更なし
  TCaller           // 変更なし
>;
```

### TypeError phantom type によるコンパイル時エラーメッセージ

tRPC は `never` の代わりに `TypeError<TMessage>` 型を使って、型エラーに人間が読めるメッセージを付与する。

```typescript
// types.ts:170-174
const _errorSymbol = Symbol();
export type ErrorSymbol = typeof _errorSymbol;
export type TypeError<TMessage extends string> = TMessage & {
  _: typeof _errorSymbol;
};
```

この phantom type は `string & { _: symbol }` という交差型であり、通常の文字列に代入することはできない。主な使用箇所:

1. **パーサーチェーンの不整合検出** (`procedureBuilder.ts:206-212`): optional パーサーを required パーサーの後にチェーンしようとすると `TypeError<'Cannot chain an optional parser to a required parser'>` が発生する。
2. **ビルダー合成の型不整合** (`procedureBuilder.ts:309-310,346-347`): `concat()` でコンテキストやメタが合わないビルダーを渡すと `TypeError<'Context mismatch'>` や `TypeError<'Meta mismatch'>` となる。
3. **未実装機能のブロック** (`procedureBuilder.ts:418,439`): `TCaller extends true` 時の subscription は `TypeError<'Not implemented'>` を返す。
4. **プロパティ名衝突の検出** (`types.ts:153-162`): `ProtectedIntersection` がルーターと組み込みメソッドの名前衝突を `IntersectionError<TKey>` テンプレートリテラル型で報告する。

### 多段パーサー推論（inferParser）

`inferParser` 型は、Zod, Valibot, ArkType, Standard Schema, Yup, Superstruct など異なるバリデーションライブラリのスキーマ型から `{ in: TInput; out: TOutput }` を統一的に抽出する。

```typescript
// parser.ts:64-80
export type inferParser<TParser extends Parser> =
  TParser extends ParserStandardSchemaEsque<infer $TIn, infer $TOut>
    ? { in: $TIn; out: $TOut }
    : TParser extends ParserWithInputOutput<infer $TIn, infer $TOut>
      ? { in: $TIn; out: $TOut }
      : TParser extends ParserWithoutInput<infer $InOut>
        ? { in: $InOut; out: $InOut }
        : never;
```

各バリデーションライブラリの型を「-Esque」サフィックスの構造的型として表現し、`_input`/`_output` や `inferIn`/`infer` などライブラリ固有の型プロパティからダックタイピングで型情報を抽出している。

### ProtectedIntersection によるキー衝突防止

`ProtectedIntersection<TType, TWith>` は2つの型のキーが衝突する場合にテンプレートリテラル型でエラーメッセージを生成する。

```typescript
// types.ts:153-162
export type IntersectionError<TKey extends string> =
  `The property '${TKey}' in your router collides with a built-in method, rename this router or procedure on your backend.`;

export type ProtectedIntersection<TType, TWith> = keyof TType &
  keyof TWith extends never
  ? TType & TWith
  : IntersectionError<string & keyof TType & keyof TWith>;
```

React Query の `createTRPCReact` (`createTRPCReact.tsx:466`) や Next.js アダプタ (`createTRPCNext.tsx:52`) でルーターレコードと組み込みプロパティ（`useContext`, `Provider`, `queryClient` 等）の名前衝突を検出するために横断的に使用される。回帰テスト (`issue-3461-reserved-properties.test.tsx`) で実際の衝突シナリオが検証されている。

### Branded type による型安全なマーカー

tRPC では4つの branded type をランタイムマーカーとして使い分けている。

```typescript
// utils.ts:1-4
export type UnsetMarker = 'unsetMarker' & { __brand: 'unsetMarker' };

// middleware.ts:8-10
export const middlewareMarker = 'middlewareMarker' as 'middlewareMarker' & {
  __brand: 'middlewareMarker';
};

// router.ts:80-81
const lazyMarker = 'lazyMarker' as 'lazyMarker' & { __brand: 'lazyMarker' };

// stream/tracked.ts:3-5
type TrackedId = string & { __brand: 'TrackedId' };
```

`string & { __brand: string }` パターンにより、構造的に同じ文字列型でも名目的に区別される。`middlewareMarker` はミドルウェアの戻り値が正しいプロトコルに従っているかの検証、`lazyMarker` は遅延ロードされたルーターの識別に使われる。

### 条件付き戻り値型による API の多態性

`.query()` の戻り値型は `TCaller extends true` で分岐する。

```typescript
// procedureBuilder.ts:362-379
query<$Output>(
  resolver: ProcedureResolver<...>,
): TCaller extends true
  ? (input: DefaultValue<TInputIn, void>) => Promise<DefaultValue<TOutputOut, $Output>>
  : QueryProcedure<{
      input: DefaultValue<TInputIn, void>;
      output: DefaultValue<TOutputOut, $Output>;
      meta: TMeta;
    }>;
```

`experimental_caller()` を呼ぶと `TCaller` が `true` になり、`.query()` がプロシージャオブジェクトではなく直接呼び出し可能な関数を返す。同じメソッドが2つの全く異なるインターフェースを型安全に提供する。

### $-prefix 命名規則

tRPC では、メソッドのスコープ内で新たに推論される型パラメータに `$` プレフィックスを付ける規則を採用している。

```typescript
// procedureBuilder.ts:201,259,289-295,362
input<$Parser extends Parser>(...)
use<$ContextOverridesOut>(...)
concat<$Context, $Meta, $ContextOverrides, $InputIn, $InputOut, $OutputIn, $OutputOut>(...)
query<$Output>(...)
```

`T` プレフィックスはビルダー自体の型パラメータ（TContext, TMeta 等）、`$` プレフィックスはメソッド呼び出しごとに推論されるローカルな型変数に使われる。`infer` キーワードで抽出される型にも同じ規則が適用される（`infer $Yield`, `infer $TIn`, `infer $Data` 等）。

## コード例

```typescript
// packages/server/src/unstable-core-do-not-import/types.ts:82-88
// index signature を除去して明示的に定義されたキーだけを残す
export type WithoutIndexSignature<TObj> = {
  [K in keyof TObj as string extends K
    ? never
    : number extends K
      ? never
      : K]: TObj[K];
};
```

```typescript
// packages/server/src/unstable-core-do-not-import/types.ts:96-112
// index signature を考慮した安全なプロパティ上書き
export type Overwrite<TType, TWith> = TWith extends any
  ? TType extends object
    ? {
        [K in
          | keyof WithoutIndexSignature<TType>
          | keyof WithoutIndexSignature<TWith>]: K extends keyof TWith
          ? TWith[K]
          : K extends keyof TType
            ? TType[K]
            : never;
      } & (string extends keyof TWith
        ? { [key: string]: TWith[string] }
        : number extends keyof TWith
          ? { [key: number]: TWith[number] }
          : {})
    : TWith
  : never;
```

```typescript
// packages/server/src/unstable-core-do-not-import/types.ts:117-122
// 余分なプロパティの存在をコンパイル時に検出する
export type ValidateShape<TActualShape, TExpectedShape> =
  TActualShape extends TExpectedShape
    ? Exclude<keyof TActualShape, keyof TExpectedShape> extends never
      ? TActualShape
      : TExpectedShape
    : never;
```

```typescript
// packages/server/src/unstable-core-do-not-import/procedureBuilder.ts:37-45
// sentinel type によるデフォルト値の分岐
type IntersectIfDefined<TType, TWith> = TType extends UnsetMarker
  ? TWith
  : TWith extends UnsetMarker
    ? TType
    : Simplify<TType & TWith>;

type DefaultValue<TValue, TFallback> = TValue extends UnsetMarker
  ? TFallback
  : TValue;
```

```typescript
// packages/server/src/unstable-core-do-not-import/rootConfig.ts:104-123
// コンテキストが空 (object) なら createContext を省略可能にする
type PartialIf<TCondition extends boolean, TType> = TCondition extends true
  ? Partial<TType>
  : TType;

export type CreateContextCallback<
  TContext,
  TFunction extends (...args: any[]) => any,
> = PartialIf<
  object extends TContext ? true : false,
  { createContext: TFunction }
>;
```

## パターンカタログ

- **Builder パターン** (分類: 生成)
  - 解決する問題: 多数のオプションを持つオブジェクトの段階的構築
  - 適用条件: 各ステップが型情報を蓄積し、最終ステップで型安全な成果物を生成する必要がある場合
  - コード例: `procedureBuilder.ts:187-465`（ProcedureBuilder インターフェース）
  - 注意点: tRPC は GoF の Builder とは異なり、各メソッド呼び出しが新しいビルダーインスタンスを返す（イミュータブルビルダー）。型パラメータの数が多くなるとコンパイル時間に影響する。

- **Phantom Type パターン** (分類: 構造)
  - 解決する問題: ランタイムには存在しないが、型レベルで区別が必要な情報の表現
  - 適用条件: 型レベルの状態追跡、エラーメッセージの埋め込み、nominal typing が必要な場合
  - コード例: `types.ts:170-174`（TypeError）、`procedure.ts:30-33`（$types）
  - 注意点: `$types: null as any` のようにランタイム値を犠牲にするため、ランタイムでのアクセスを防止する仕組みが必要。

- **Strategy パターン（型レベル版）** (分類: 振る舞い)
  - 解決する問題: 同一のインターフェースから異なる型の成果物を生成
  - 適用条件: 条件付き型の分岐により、入力の型状態に応じて出力型を切り替える場合
  - コード例: `procedureBuilder.ts:371-379`（TCaller による戻り値型の分岐）
  - 注意点: 分岐が深くなると推論エラー時のデバッグが困難になる。

## Good Patterns

- **Sentinel type + 条件付き型でビルダーの「未設定」状態を型安全に表現する**: `UnsetMarker` を未設定のデフォルト値に使い、`DefaultValue` / `IntersectIfDefined` で分岐する。これにより `.input()` を呼ばなければ input は `void` になり、呼べば指定した型になる。二重に `.input()` を呼べば型が交差で合成される。
  ```typescript
  // procedureBuilder.ts:37-45
  type IntersectIfDefined<TType, TWith> = TType extends UnsetMarker
    ? TWith
    : TWith extends UnsetMarker
      ? TType
      : Simplify<TType & TWith>;
  ```

- **DistributiveOmit でユニオン型を保持する**: 標準の `Omit` はユニオン型を崩壊させるが、`TObj extends any ? Omit<TObj, TKey> : never` の distributive conditional type パターンを使えばユニオンの各メンバーに個別に適用される。
  ```typescript
  // types.ts:71-73
  export type DistributiveOmit<TObj, TKey extends keyof any> = TObj extends any
    ? Omit<TObj, TKey>
    : never;
  ```

- **構造的型マッチングで複数のバリデーションライブラリを統一的に推論する**: 各ライブラリの型を `-Esque` サフィックスの structural type として定義し、 `inferParser` 型が優先順位付きの条件付き型でダックタイピング推論を行う。新しいライブラリへの対応はインターフェースの追加だけで済む。
  ```typescript
  // parser.ts:5-8,64-80
  export type ParserZodEsque<TInput, TParsedInput> = {
    _input: TInput;
    _output: TParsedInput;
  };
  // ... (他のライブラリの -Esque 型)
  export type inferParser<TParser extends Parser> =
    TParser extends ParserStandardSchemaEsque<infer $TIn, infer $TOut>
      ? { in: $TIn; out: $TOut }
      : TParser extends ParserWithInputOutput<infer $TIn, infer $TOut>
        ? { in: $TIn; out: $TOut }
        : TParser extends ParserWithoutInput<infer $InOut>
          ? { in: $InOut; out: $InOut }
          : never;
  ```

## Anti-Patterns / 注意点

- **`null as any` による phantom type の初期化**: `$types: null as any` はランタイムでのアクセスが型安全でない。ランタイムアクセスを試みると `null` に対するプロパティアクセスで例外が起きる。
  ```typescript
  // Bad: ランタイムでアクセスすると null 参照エラー
  const config = t._config;
  config.$types.ctx; // 実行時に null.ctx でクラッシュ

  // Better: Proxy でアクセスを検出してわかりやすいエラーを投げる（tRPC でも検討されていた形跡あり: initTRPC.test.ts:71-79 のコメントアウトされたテスト）
  ```

- **型パラメータの過剰増殖**: ProcedureBuilder は8個の型パラメータを持つ。`AnyProcedureBuilder` の定義（`procedureBuilder.ts:139-148`）は `any` が8個並び、可読性が低い。型パラメータが増えすぎる場合は、関連するパラメータをオブジェクト型にまとめることで管理しやすくなる。
  ```typescript
  // Bad: 型パラメータが8個以上
  interface Builder<T1, T2, T3, T4, T5, T6, T7, T8> { ... }
  type AnyBuilder = Builder<any, any, any, any, any, any, any, any>;

  // Better: 関連パラメータをグループ化
  interface BuilderTypes { context: T1; meta: T2; input: { in: T3; out: T4 }; ... }
  interface Builder<TTypes extends BuilderTypes> { ... }
  ```

- **条件付き型の深いネストによるエラーメッセージの難読化**: `input()` のスキーマ引数の型制約（`procedureBuilder.ts:201-212`）は4段階の条件付き型のネストで構成されており、型エラーが発生した場合に IDE のエラーメッセージが非常に長くなる。`TypeError<TMessage>` で対処しているが、すべてのパスに適用されているわけではない。

## 導出ルール

- `[MUST]` fluent builder の型パラメータに「未設定」状態を表現する sentinel type を用意し、`DefaultValue` や `IntersectIfDefined` 等の条件付き型で分岐させる — `UnsetMarker` なしでは `.input()` 未呼出時の型フォールバック（`void` への変換）が表現できず、すべてのビルダーメソッドが暗黙に `unknown` を扱うことになる
  - 根拠: `utils.ts:1-4` の `UnsetMarker` が `procedureBuilder.ts:37-45` の `IntersectIfDefined` / `DefaultValue` と組み合わさり、7箇所以上の型パラメータ初期値として使用されている

- `[MUST]` 型レベルで不正な操作を検出したら `never` ではなく、テンプレートリテラル型を使ったエラーメッセージ型を返す — `never` は IDE でホバーしても理由がわからないが、`TypeError<'Context mismatch'>` なら開発者が即座に原因を特定できる
  - 根拠: `types.ts:170-174` の `TypeError` が `procedureBuilder.ts` の10箇所で使用され、`ProtectedIntersection` (`types.ts:159-162`) はパッケージ横断で6箇所以上で使用されている

- `[SHOULD]` 複雑な交差型を `Simplify<TType>` で展開して IDE ツールチップの可読性を改善する — 交差型のまま表示されると `{ a: string } & { b: number } & { c: boolean }` のような長い型が IDE に表示され、実質的に読めなくなる
  - 根拠: `types.ts:16-18` の `Simplify` がコンテキストのオーバーレイ (`procedureBuilder.ts:104`) やパーサー推論結果 (`procedureBuilder.ts:41`) 等で使用されている

- `[SHOULD]` ユニオン型に対して `Omit` や `Pick` を適用する場合は distributive conditional type（`T extends any ? Omit<T, K> : never`）でラップする — 標準の `Omit` はユニオンを崩壊させ、意図しない型になる
  - 根拠: `types.ts:71-73` の `DistributiveOmit` が9つのパッケージファイルで使用されている

- `[SHOULD]` 複数の外部ライブラリの型を統一的に推論する場合は、ライブラリ固有の型プロパティを structural type（-Esque パターン）で定義し、優先順位付きの条件付き型チェーンで順番にマッチさせる — ライブラリに直接依存せずにダックタイピングで型推論でき、新しいライブラリの追加が型定義の追加だけで済む
  - 根拠: `parser.ts:5-80` で Zod, Valibot, ArkType, Standard Schema, MyZod, Superstruct, Yup, Scale の8ライブラリを統一的に推論している

- `[SHOULD]` ビルダーのメソッドスコープで推論される型パラメータには `$` プレフィックスを付け、ビルダー自体の型パラメータ（`T` プレフィックス）と視覚的に区別する — 型パラメータが10個以上あるジェネリック型で、どれがビルダーの状態でどれがメソッドローカルかの判別が容易になる
  - 根拠: `procedureBuilder.ts` 全体で `$Parser`, `$Output`, `$ContextOverridesOut` 等が一貫して使用されている

- `[AVOID]` 型レベルのみで使う phantom property を `null as any` で初期化する — ランタイムでアクセスすると null 参照エラーになり、デバッグが困難になる。Proxy でトラップするか、型レベル専用であることをドキュメントで明示する
  - 根拠: `procedureBuilder.ts:591` と `initTRPC.ts:167` で `$types: null as any` が使われており、`initTRPC.test.ts:71-79` にコメントアウトされた Proxy ベースのガードが残されている

## 適用チェックリスト

- [ ] fluent builder API を設計する際に、各ステップで蓄積すべき型情報を型パラメータとして列挙し、未設定状態を sentinel type で表現しているか
- [ ] 型レベルのエラー分岐で `never` ではなくテンプレートリテラル型のエラーメッセージを返しているか
- [ ] 交差型が IDE ツールチップに表示される箇所で `Simplify` 相当の型展開を適用しているか
- [ ] ユニオン型に `Omit` / `Pick` を適用する際に distributive conditional type でラップしているか
- [ ] 外部ライブラリの型をハードコードせず、構造的型（ダックタイピング）で推論しているか
- [ ] 型パラメータの命名規則（ビルダー状態: `T` prefix, メソッドローカル: `$` prefix）が一貫しているか
- [ ] phantom type のランタイム値に対する安全策（Proxy, ドキュメント, `@internal` アノテーション）があるか
