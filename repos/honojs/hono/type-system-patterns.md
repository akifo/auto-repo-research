# 型システムパターン

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono のコードベースは、TypeScript の型システムを極限まで活用し「ランタイムの挙動を型レベルで完全に追跡する」ことに成功した稀有な事例である。文字列リテラルのルートパスからパラメータ型を推論し、ミドルウェアチェーンで環境型を累積的に合成し、RPC クライアントがサーバー定義のスキーマをそのまま利用する End-to-End 型安全を実現している。ここで使われている条件型・ジェネリクス・Template Literal Types・Declaration Merging のプラクティスは、型安全な API 設計の教科書的参照になる。

## 背景にある原則

- **型はランタイムのパイプラインを写像すべき**: ハンドラチェーンの各段階で環境型 `E` と入力型 `I` が `IntersectNonAnyTypes` で累積的に合成され、チェーン上の任意の位置でそれ以前のミドルウェアが注入した変数やバリデーション結果に型安全にアクセスできる。型がランタイムの合成パイプラインの「状態遷移」を写し取っている（`src/types.ts:128-210`）。

- **文字列リテラルは型レベルの構造化データである**: URL パスやレスポンスフォーマットなど、本来は単なる文字列である値を Template Literal Types で分解・合成し、型レベルで構造情報を抽出する。`ParamKeys` 型は `'/user/:id/posts/:postId'` から `'id' | 'postId'` を推論する（`src/types.ts:2409-2423`）。

- **型境界での `any` 汚染は明示的にブロックする**: `IsAny<T>` や `IfAnyThenEmptyObject<T>` などのガードユーティリティを用意し、型合成の過程で `any` が他の型を侵食することを防いでいる（`src/utils/types.ts:21,110`）。

- **Declaration Merging で型の拡張ポイントを設ける**: `ContextVariableMap` や `NotFoundResponse` を空インターフェースとしてエクスポートし、ユーザーやミドルウェアが `declare module` で型を追加できるようにしている。ランタイムの変更なしに型だけを拡張する仕組みである（`src/context.ts:52`, `src/types.ts:106`）。

## 実例と分析

### 1. 型レベルパスパーサーによるルートパラメータ推論

Hono は Template Literal Types の再帰分解で URL パスからパラメータ名を抽出する。`:param` 形式と `{pattern}?` によるオプショナル修飾にも対応する。

```typescript
// src/types.ts:2409-2423
type ParamKey<Component> = Component extends `:${infer NameWithPattern}`
  ? NameWithPattern extends `${infer Name}{${infer Rest}` ? Rest extends `${infer _Pattern}?` ? `${Name}?`
    : Name
  : NameWithPattern
  : never;

export type ParamKeys<Path> = Path extends `${infer Component}/${infer Rest}` ? ParamKey<Component> | ParamKeys<Rest>
  : ParamKey<Path>;

export type ParamKeyToRecord<T extends string> = T extends `${infer R}?` ? Record<R, string | undefined>
  : { [K in T]: string; };
```

この結果を `AddParam` で入力型に合成し、ハンドラの `c.req.param()` が正確な型を返す。`/users/:id` なら `{ id: string }`、`:name{[a-z]+}?` なら `{ name: string | undefined }` になる。

### 2. ミドルウェアチェーンでの環境型の累積合成

`HandlerInterface` では、ハンドラ数ごとにオーバーロードを定義し（1個〜10個）、各ミドルウェアの `Env` 型を `IntersectNonAnyTypes` で累積的にインターセクションする。

```typescript
// src/types.ts:2474-2476
type ProcessHead<T> = IfAnyThenEmptyObject<T extends Env ? (Env extends T ? {} : T) : T>;
export type IntersectNonAnyTypes<T extends any[]> = T extends [infer Head, ...infer Rest]
  ? ProcessHead<Head> & IntersectNonAnyTypes<Rest>
  : {};
```

`ProcessHead` は `any` や基底 `Env` 型をフィルタし、具体的な型パラメータのみをインターセクションに含める。これにより、型パラメータを指定しないミドルウェア（`poweredBy()` 等）がチェーンに混在しても型合成が壊れない。

### 3. TypedResponse によるレスポンス型の追跡

`TypedResponse<T, U, F>` はファントム型（`_data`, `_status`, `_format`）でレスポンスの内容型・ステータスコード・フォーマットを静的に追跡する。ランタイムではこれらのプロパティは存在せず、型情報の運搬専用である。

```typescript
// src/types.ts:2346-2358
export type TypedResponse<
  T = unknown,
  U extends StatusCode = StatusCode,
  F extends ResponseFormat = T extends string ? "text"
    : T extends JSONValue ? "json"
    : ResponseFormat,
> = {
  _data: T;
  _status: U;
  _format: F;
};
```

`c.json()` は `Response & TypedResponse<JSONParsed<T>, U, 'json'>` を返し、`c.text()` は `Response & TypedResponse<T, U, 'text'>` を返す。条件型のデフォルトパラメータにより、フォーマットの明示指定なしでも正しいフォーマット型が推論される。

### 4. Schema 型によるルート定義の蓄積と RPC クライアントの End-to-End 型安全

`ToSchema` 型がハンドラ登録ごとにルート情報を Schema 型に蓄積し、`app.route()` では `MergeSchemaPath` がサブアプリの Schema をプレフィックス付きでマージする。

```typescript
// src/types.ts:2211-2240
export type ToSchema<M extends string, P extends string, I extends Input | Input["in"], RorO> = IsAny<RorO> extends true
  ? {
    [K in P]: {
      [K2 in M as AddDollar<K2>]: {
        input: AddParam<ExtractInput<I>, P>;
        output: {};
        outputFormat: ResponseFormat;
        status: StatusCode;
      };
    };
  }
  : [RorO] extends [never] ? {}
  : [RorO] extends [Promise<void>] ? {}
  : {
    [K in P]: {
      [K2 in M as AddDollar<K2>]: Simplify<{ input: AddParam<ExtractInput<I>, P>; } & ToSchemaOutput<RorO, I>>;
    };
  };
```

RPC クライアント側では `Client<T, Prefix>` が `HonoBase` から Schema `S` を `infer` で抽出し、`PathToChain` で `/users/:id/posts` のようなパスをネストされたオブジェクト型に変換する。

```typescript
// src/client/types.ts:292-299
export type Client<T, Prefix extends string> = T extends HonoBase<any, infer S, any>
  ? S extends Record<infer K, Schema> ? K extends string ? PathToChain<Prefix, K, S>
    : never
  : never
  : never;
```

### 5. Declaration Merging による外部拡張パターン

`ContextVariableMap` は空インターフェースとしてエクスポートされ、ミドルウェアが `declare module` で型を注入する。

```typescript
// src/middleware/jwt/index.ts:5-9
import type {} from "../..";

declare module "../.." {
  interface ContextVariableMap extends JwtVariables {}
}
```

ユーザーは `c.var.jwtPayload` のように型安全にアクセスできる。一方 `Env['Variables']` はジェネリクス経由の型パラメータで、アプリケーション単位の型安全を提供する。二つの拡張メカニズムが共存している。

### 6. 条件型による JSON シリアライズの型精密化

`JSONParsed<T>` は `JSON.stringify` + `JSON.parse` の変換を型レベルで再現し、`Date` → `string`（`toJSON` 経由）、`undefined` → キー省略、`symbol` キー → 省略、`bigint` → `never`（エラー）をモデル化する。

```typescript
// src/utils/types.ts:53-83
export type JSONParsed<T, TError = bigint | ReadonlyArray<bigint>> = T extends { toJSON(): infer J; }
  ? (() => J) extends () => JSONPrimitive ? J
  : (() => J) extends () => { toJSON(): unknown; } ? {}
  : JSONParsed<J, TError>
  : T extends JSONPrimitive ? T
  : T extends InvalidJSONValue ? never
  : T extends ReadonlyArray<unknown> ? { [K in keyof T]: JSONParsed<InvalidToNull<T[K]>, TError>; }
  : T extends Set<unknown> | Map<unknown, unknown> | Record<string, never> ? {}
  : T extends object ? T[keyof T] extends TError ? never
    : {
      [K in keyof OmitSymbolKeys<T> as IsInvalid<T[K]> extends true ? never : K]: boolean extends IsInvalid<T[K]>
        ? JSONParsed<T[K], TError> | undefined
        : JSONParsed<T[K], TError>;
    }
  : T extends unknown ? T extends TError ? never : JSONValue
  : never;
```

### 7. バリデーター統合による入出力型の自動推論

`validator()` 関数はバリデーション対象（`json`, `form`, `query`, `param`, `header`, `cookie`）とバリデーション関数から入出力型を自動推論し、ミドルウェアの `Input` 型に埋め込む。

```typescript
// src/validator/validator.ts:46-82
export const validator = <
  InputType,
  P extends string,
  M extends string,
  U extends ValidationTargetByMethod<M>,
  // ...
  V extends {
    in: { [K in U]: K extends 'json' ? unknown extends InputType ? ExtractValidatorOutput<VF> : InputType
      : InferInput<ExtractValidatorOutput<VF>, K, FormValue> }
    out: { [K in U]: ExtractValidatorOutput<VF> }
  } = { /* same */ },
>(target: U, validationFunc: VF): MiddlewareHandler<E, P, V, ExtractValidationResponse<VF>>
```

`ValidationTargetByMethod<M>` は HTTP メソッドに応じてバリデーション対象を制限する（GET/HEAD では `form`/`json` を除外）。バリデーション関数の戻り値から `Response | TypedResponse` を除外して出力型を抽出する `ExtractValidatorOutput` により、Zod 等の外部バリデーターとも自然に統合できる。

## コード例

```typescript
// src/utils/types.ts:21
// any ガードユーティリティ: 0 extends 1 & T が any のときのみ true になるトリック
export type IfAnyThenEmptyObject<T> = 0 extends 1 & T ? {} : T;
```

```typescript
// src/utils/types.ts:110
// boolean extends (T extends never ? true : false) は any のとき true になる
export type IsAny<T> = boolean extends (T extends never ? true : false) ? true : false;
```

```typescript
// src/utils/types.ts:12-16
// Union → Intersection 変換: 関数パラメータの反変性を利用
export type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (
  k: infer I,
) => void ? I
  : never;
```

```typescript
// src/client/types.ts:275-290
// パスの '/' 区切りを再帰的にネストされたオブジェクト型に変換
type PathToChain<Prefix extends string, Path extends string, E extends Schema, Original extends string = Path> =
  Path extends `/${infer P}` ? PathToChain<Prefix, P, E, Path>
    : Path extends `${infer P}/${infer R}` ? { [K in P]: PathToChain<Prefix, R, E, Original>; }
    : {
      [K in Path extends "" ? "index" : Path]: ClientRequest<
        Prefix,
        Original,
        E extends Record<string, unknown> ? E[Original] : never
      >;
    };
```

```typescript
// src/types.ts:2321-2335
// パスの結合を型レベルで行う（重複 '/' の処理を含む）
export type MergePath<A extends string, B extends string> = B extends "" ? MergePath<A, "/">
  : A extends "" ? B
  : A extends "/" ? B
  : A extends `${infer P}/` ? B extends `/${infer Q}` ? `${P}/${Q}` : `${P}/${B}`
  : B extends `/${infer Q}` ? Q extends "" ? A : `${A}/${Q}`
  : `${A}/${B}`;
```

## パターンカタログ

- **Phantom Type（ファントム型）** (分類: 構造)
  - 解決する問題: ランタイムには存在しないがコンパイル時に区別が必要な情報（レスポンスのデータ型・ステータス・フォーマット）を型レベルで運搬する
  - 適用条件: 値としては不要だが型レベルの識別が必要な場面
  - コード例: `src/types.ts:2346-2358` — `TypedResponse<T, U, F>` の `_data`, `_status`, `_format`
  - 注意点: ファントムプロパティはランタイムに存在しないため、構造的部分型と衝突しないよう接頭辞 `_` 等で命名する

- **Builder Pattern (型レベル)** (分類: 生成)
  - 解決する問題: メソッドチェーン `.get().post().use()` の各段階で蓄積される Schema 型と Env 型を正確に追跡する
  - 適用条件: 流暢インターフェースで段階的に型情報を蓄積するフレームワーク
  - コード例: `src/types.ts:128-148` — `HandlerInterface` が `HonoBase<IntersectNonAnyTypes<[E, E2]>, S & ToSchema<...>, ...>` を返す
  - 注意点: TypeScript のオーバーロード上限やコンパイル時間のトレードオフが発生する

- **Module Augmentation Pattern** (分類: 構造)
  - 解決する問題: ライブラリ利用者やプラグインが、ライブラリの型定義を非侵入的に拡張する
  - 適用条件: プラグインやミドルウェアが共有コンテキストに型を追加する必要がある場面
  - コード例: `src/context.ts:52` + `src/middleware/jwt/index.ts:5-9`
  - 注意点: グローバルスコープで有効なため、テスト間の型汚染に注意が必要

## Good Patterns

- **`any` フィルター付き型合成**: `IntersectNonAnyTypes` は各型パラメータの `any` を `{}` に変換してからインターセクションを取る。型パラメータを指定しないジェネリック関数が混在しても、合成結果が `any` に崩壊しない。
  ```typescript
  // src/types.ts:2473-2476
  type ProcessHead<T> = IfAnyThenEmptyObject<T extends Env ? (Env extends T ? {} : T) : T>;
  export type IntersectNonAnyTypes<T extends any[]> = T extends [infer Head, ...infer Rest]
    ? ProcessHead<Head> & IntersectNonAnyTypes<Rest>
    : {};
  ```

- **条件型デフォルトによる自動分類**: `TypedResponse` のフォーマットパラメータ `F` は、`T extends string ? 'text' : T extends JSONValue ? 'json' : ResponseFormat` というデフォルト値を持つ。ユーザーがフォーマットを明示しなくてもレスポンス型から自動推論される。
  ```typescript
  // src/types.ts:2346-2354
  export type TypedResponse<
    T = unknown,
    U extends StatusCode = StatusCode,
    F extends ResponseFormat = T extends string ? 'text' : T extends JSONValue ? 'json' : ResponseFormat,
  >
  ```

- **二重拡張メカニズムの共存**: 「ジェネリクス型パラメータ (`Env['Variables']`)」と「Declaration Merging (`ContextVariableMap`)」の二つの型拡張経路を用意し、前者はアプリケーション単位、後者はグローバル拡張に使い分ける。`c.get()` と `c.var` の型定義がこの共存を実現している。
  ```typescript
  // src/context.ts:90-93
  interface Get<E extends Env> {
    <Key extends keyof E["Variables"]>(key: Key): E["Variables"][Key];
    <Key extends keyof ContextVariableMap>(key: Key): ContextVariableMap[Key];
  }
  ```

- **HTTP メソッドに応じたバリデーション対象の制限**: `ValidationTargetByMethod<M>` が GET/HEAD リクエストでは `form`/`json` を除外する。RFC に基づく制約を型レベルで強制することで、無効な組み合わせをコンパイル時に排除する。
  ```typescript
  // src/validator/validator.ts:10-12
  type ValidationTargetByMethod<M> = M extends "get" | "head"
    ? Exclude<keyof ValidationTargets, ValidationTargetKeysWithBody>
    : keyof ValidationTargets;
  ```

## Anti-Patterns / 注意点

- **オーバーロード爆発**: `HandlerInterface` はハンドラ数 1〜10 のパターンを `path` の有無で倍化し、約 20 のオーバーロードが存在する。これは TypeScript がタプルの可変長ジェネリクス上でインクリメンタルな型推論を十分にサポートしていないことへの現実的な妥協だが、保守コストが高い。

  Bad: 同じパターンを N 回手動で複製する（現在のアプローチ。必要悪として許容されている）

  Better: TypeScript の Variadic Tuple Types や再帰的条件型が改善された場合、`[...Middlewares, FinalHandler]` のような統一的なシグネチャに集約できる可能性がある。現時点ではコンパイル性能とのトレードオフで現実解を採用している。

- **ファントム型プロパティへの直接アクセス**: `TypedResponse._data` はランタイムには存在しない。型推論のためのプロパティを実行時にアクセスしようとすると `undefined` が返り、型とランタイムの齟齬が生じる。

  Bad:
  ```typescript
  const data = response._data; // undefined at runtime, typed as T
  ```
  Better:
  ```typescript
  const data = await response.json(); // runtime-safe, typed via ClientResponse<T>
  ```

- **`any` の意図的使用と汚染リスク**: `Handler` や `H` 型のデフォルトジェネリクスには `any` が使われている（`E extends Env = any`）。これはユーザーが型パラメータを省略した場合の利便性のためだが、`IntersectNonAnyTypes` のような防御機構なしに使うと型安全性が崩壊する。

  Bad:
  ```typescript
  type Combined = SomeEnv & any; // always any
  ```
  Better:
  ```typescript
  type Combined = IntersectNonAnyTypes<[SomeEnv, MaybeAny]>; // any is filtered to {}
  ```

## 導出ルール

- `[MUST]` 型合成パイプラインでは `any` をフィルタするガードユーティリティ（`IsAny<T>`, `IfAnyThenEmptyObject<T>` 等）を導入し、合成結果が `any` に崩壊することを防ぐ
  - 根拠: Hono の `IntersectNonAnyTypes` は `ProcessHead` で `any` を `{}` に変換してからインターセクションを取り、型パラメータ未指定のジェネリック関数が混在してもチェーン全体の型安全を維持している（`src/types.ts:2473-2476`）

- `[MUST]` ファントム型のプロパティは `_` 接頭辞やブランドプロパティで命名し、ランタイムで直接アクセスされることを防ぐドキュメントまたは型ガードを設ける
  - 根拠: `TypedResponse<T, U, F>` は `_data`, `_status`, `_format` を型運搬専用に使い、ランタイムのレスポンスオブジェクトとはインターセクション (`Response & TypedResponse<...>`) で結合している（`src/types.ts:2346-2358`）

- `[SHOULD]` 文字列リテラルから構造情報を抽出する場面では Template Literal Types の再帰分解を使い、ユーザーが型アノテーションを書かなくても推論だけで型安全を提供する
  - 根拠: `ParamKeys<Path>` は URL パス文字列を再帰的に分解し、`:param` セグメントを Union 型で抽出する。ハンドラ登録時のパス文字列リテラルから自動的にパラメータ型が推論される（`src/types.ts:2409-2423`）

- `[SHOULD]` プラグインやミドルウェアの型拡張には、ジェネリクス型パラメータ（インスタンス単位）と Declaration Merging（グローバル単位）の二つの経路を設け、スコープに応じて使い分ける
  - 根拠: `Env['Variables']` はアプリインスタンス単位の型安全を、`ContextVariableMap` はグローバル拡張を提供し、`c.get()` のオーバーロードが両方の経路を統合している（`src/context.ts:90-93`）

- `[SHOULD]` 条件型のデフォルト型パラメータを活用し、ジェネリクスの明示指定なしでもコンテキストに応じた適切な型が推論されるようにする
  - 根拠: `TypedResponse` のフォーマットパラメータ `F` は `T extends string ? 'text' : T extends JSONValue ? 'json' : ResponseFormat` をデフォルト値とし、ユーザーが `c.json({...})` を呼ぶだけで自動的に `'json'` フォーマットが推論される（`src/types.ts:2349-2353`）

- `[SHOULD]` Union → Intersection 変換が必要な場面では関数パラメータの反変性（contravariance）を利用した `UnionToIntersection<U>` パターンを使う
  - 根拠: `src/utils/types.ts:12-16` で `(U extends any ? (k: U) => void : never) extends (k: infer I) => void ? I : never` として実装され、クライアント型の合成など複数箇所で利用されている

- `[AVOID]` TypeScript のオーバーロードを手動で N 個複製する方式は、保守コストが高いため可能な限り Variadic Tuple Types やヘルパー型で抽象化する。ただし、コンパイル性能との兼ね合いで手動展開が必要な場合は、その理由とハンドラ数上限をコメントで明記する
  - 根拠: `HandlerInterface` はハンドラ1〜10個 x パスの有無で約20オーバーロードを定義しており、型推論の正確性とコンパイル時間のトレードオフとして現実解を採用している（`src/types.ts:128-1073`）

## 適用チェックリスト

- [ ] API のパス定義に文字列リテラル型を使い、Template Literal Types でパラメータ名を自動抽出する仕組みがあるか
- [ ] ミドルウェア / プラグインチェーンの型合成で `any` フィルター（`IsAny` / `IfAnyThenEmptyObject` 相当）を導入しているか
- [ ] ファントム型を使ってランタイムに存在しない型情報（ステータスコード、フォーマット等）を静的に追跡しているか
- [ ] サードパーティ拡張の型注入に Declaration Merging（空インターフェース + `declare module`）を提供しているか
- [ ] JSON シリアライズの型変換（`Date` → `string`、`undefined` 省略、`bigint` 禁止等）を型レベルで再現しているか
- [ ] ジェネリクスのデフォルト型パラメータに条件型を使い、利用者の明示的な型指定を最小化しているか
- [ ] Union → Intersection 変換、型レベル文字列操作など高度な型ユーティリティをテスト（`Expect<Equal<...>>` パターン）でカバーしているか
- [ ] HTTP メソッドやプロトコルの制約（GET にボディなし等）を型レベルで強制しているか
