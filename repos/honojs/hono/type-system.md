# type-system

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono の型システムは、ルート定義からクライアント型までの End-to-End 型安全性を TypeScript のみで実現する。バリデーター出力・ハンドラー応答・パスパラメータの型情報がメソッドチェーンを通じて `Schema` 型に蓄積され、RPC クライアント (`hc`) がその `Schema` を逆引きして型安全な API クライアントを自動生成する。コード生成なし・ランタイムオーバーヘッドなしで、サーバーとクライアントの型契約を静的に保証する仕組みは、TypeScript の型レベルプログラミングの実践的な到達点として注目に値する。

## 設計思想

- **Phantom Type による型情報の伝搬**: `TypedResponse<T, U, F>` はランタイムでは単なる `Response` だが、型レベルでは `_data`, `_status`, `_format` という phantom フィールドで出力型・ステータスコード・フォーマットを保持する。実行時のペイロードに影響を与えずに型情報を伝搬するための意図的な選択である（`src/types.ts:2346-2358`）。

- **Schema 型への累積的合成**: 各ルート定義の戻り値型 `HonoBase<E, S & ToSchema<...>, BasePath>` において、`S` がインターセクション (`&`) で拡張される。チェーン呼び出しのたびに新しいルート情報が `Schema` に積み上がり、最終的な Hono インスタンスの型パラメータにすべてのエンドポイント情報が集約される。可変長引数やユニオンではなくインターセクションを選んだ理由は、パスをキーとしたオブジェクト型の合成に適しているためである（`src/types.ts:2211-2240`）。

- **オーバーロードによる有限展開で型推論を確保**: TypeScript は可変長ジェネリクスの型推論が弱いため、Hono はハンドラー 1 個〜10 個のオーバーロードを明示的に列挙する。各ミドルウェアの `Env` 型を `IntersectNonAnyTypes` で累積マージし、`Input` 型を `I & I2 & I3...` で段階的にインターセクトする（`src/types.ts:128-900`）。可読性を犠牲にしてでも型推論の精度を優先する設計判断である。

- **型と実装の完全分離**: `HonoBase` クラスの実装（`src/hono-base.ts:129-141`）では `return this as any` を使い、ランタイムの挙動は全メソッドで同一のロジックに委ねている。型安全性はインターフェース側（`HandlerInterface`, `MiddlewareHandlerInterface`）が完全に担い、実装側はそれに依存しない。

## 設計・実装の詳細

### 型推論チェーンの全体像

Hono の型推論は以下の 5 段階で伝搬する:

```
1. パス文字列リテラル → MergePath<BasePath, P> → パスパラメータ抽出
2. バリデーター → Input { in: { json: T }, out: { json: T } } → Context に注入
3. ハンドラー応答 → c.json(obj) → TypedResponse<JSONParsed<T>, U, 'json'>
4. ルート登録 → S & ToSchema<M, P, I, R> → Schema に蓄積
5. クライアント → Client<T, Prefix> → PathToChain → ClientRequest
```

### Stage 1: パスリテラルとパラメータ抽出

パス文字列 `'/users/:id'` から `:id` を抽出する型レベルパーサーが `ExtractParams` と `ParamKeys` で実装されている。

```typescript
// src/types.ts:2264-2270
type ExtractParams<Path extends string> = string extends Path
  ? Record<string, string>
  : Path extends `${infer _Start}:${infer Param}/${infer Rest}`
    ? { [K in Param | keyof ExtractParams<`/${Rest}`>]: string }
    : Path extends `${infer _Start}:${infer Param}`
      ? { [K in Param]: string }
      : never
```

`MergePath` 型（`src/types.ts:2321-2335`）は `basePath` とルートパスを結合し、条件型の分岐でスラッシュの重複を排除する。Template Literal Types を活用した文字列操作の典型例である。

### Stage 2: バリデーターから Input 型への変換

`validator('json', fn)` は `MiddlewareHandler<E, P, V>` を返し、`V` に `{ in: { json: InputType }, out: { json: OutputType } }` を埋め込む。

```typescript
// src/validator/validator.ts:64-82
V extends {
  in: {
    [K in U]: K extends 'json'
      ? unknown extends InputType
        ? ExtractValidatorOutput<VF>
        : InputType
      : InferInput<ExtractValidatorOutput<VF>, K, FormValue>
  }
  out: { [K in U]: ExtractValidatorOutput<VF> }
}
```

`in` がクライアント側の入力型（RPC クライアントが送信すべき型）、`out` がハンドラー側で `c.req.valid('json')` から取得できる検証済み出力型である。`in` と `out` を分離しているのは、フォーム値のような変換を伴うターゲットで入力型と出力型が異なるためである。

### Stage 3: ハンドラー応答と TypedResponse

`c.json(obj)` は `JSONRespondReturn<T, U>` すなわち `Response & TypedResponse<JSONParsed<T>, U, 'json'>` を返す。`JSONParsed<T>` は JSON シリアライズの挙動（`Date` → `string`, `undefined` → 除外, `bigint` → `never` 等）を型レベルでシミュレートする（`src/utils/types.ts:53-83`）。

```typescript
// src/context.ts:200-203
type JSONRespondReturn<
  T extends JSONValue | {} | InvalidJSONValue,
  U extends ContentfulStatusCode,
> = Response & TypedResponse<JSONParsed<T>, U, 'json'>
```

### Stage 4: ToSchema による Schema への蓄積

`ToSchema<M, P, I, RorO>` はメソッド・パス・入力・応答を1つの `Endpoint` 型に構造化し、パスをキー、`$method` をサブキーとするネスト型を生成する。

```typescript
// src/types.ts:2232-2240
{
  [K in P]: {
    [K2 in M as AddDollar<K2>]: Simplify<
      {
        input: AddParam<ExtractInput<I>, P>
      } & ToSchemaOutput<RorO, I>
    >
  }
}
```

`AddParam` はパス文字列からパラメータを抽出し、`input` に `param` フィールドを追加する。`IsAny<RorO>` チェックにより、明示的な型注釈がない場合でも安全にフォールバックする。

### Stage 5: Client 型と PathToChain

`Client<T, Prefix>` が Hono インスタンスの型パラメータ `S` (Schema) を抽出し、`PathToChain` でパス文字列をドットアクセス可能なオブジェクト型に変換する。

```typescript
// src/client/types.ts:292-299
export type Client<T, Prefix extends string> =
  T extends HonoBase<any, infer S, any>
    ? S extends Record<infer K, Schema>
      ? K extends string
        ? PathToChain<Prefix, K, S>
        : never
      : never
    : never
```

`PathToChain` はパス文字列を `/` で再帰的に分割し、ネストされたオブジェクト型に変換する（`src/client/types.ts:275-290`）。最終的に `ClientRequest` 型がメソッド呼び出しの引数と戻り値を規定する。

### route() による Schema のマージ

`app.route('/api', subApp)` は `MergeSchemaPath` で子ルーターの `Schema` のパスキーに親パスをプレフィクスとして付与し、パラメータ型も `MergeEndpointParamsWithPath` で統合する（`src/types.ts:2274-2310`）。

### IntersectNonAnyTypes によるミドルウェア Env の累積

複数ミドルウェアが `Variables` や `Bindings` に独自の型を追加する場合、`IntersectNonAnyTypes` が `any` を `{}` に変換してからインターセクションを取る（`src/types.ts:2473-2476`）。`any & T = any` という TypeScript の挙動を回避するための防御的な型ユーティリティである。

```typescript
// src/types.ts:2473-2476
type ProcessHead<T> = IfAnyThenEmptyObject<T extends Env ? (Env extends T ? {} : T) : T>
export type IntersectNonAnyTypes<T extends any[]> = T extends [infer Head, ...infer Rest]
  ? ProcessHead<Head> & IntersectNonAnyTypes<Rest>
  : {}
```

## パターンカタログ

- **Phantom Type** (構造)
  - 解決する問題: ランタイムには存在しないメタデータ（出力型、ステータスコード、フォーマット）を型レベルで伝搬する
  - 適用条件: 型情報を失わずに異なるレイヤー間でデータを渡す必要がある場合
  - コード例: `src/types.ts:2346-2358` — `TypedResponse<T, U, F>` の `_data`, `_status`, `_format`
  - 注意点: phantom フィールドに実行時にアクセスすると `undefined` になる。型と実装の不一致を防ぐため、フィールド名にアンダースコアプレフィクスを使う慣習を Hono は採用している

- **Builder Pattern（型レベル）** (生成)
  - 解決する問題: メソッドチェーンで段階的にルート定義を積み上げ、最終的な型を構築する
  - 適用条件: 設定の段階的蓄積が必要で、各ステップの型情報を保持したい場合
  - コード例: `src/hono-base.ts:104-110` — `get!: HandlerInterface<E, 'get', S, BasePath>`
  - 注意点: 各メソッド呼び出しで新しい型パラメータを含む `HonoBase` 型を返すため、チェーンが長くなると型チェックが遅くなる可能性がある

- **Proxy Pattern**（構造）
  - 解決する問題: パス文字列のドットアクセスを動的に解決し、型安全な API クライアントを提供する
  - 適用条件: 静的に定義できないプロパティアクセスを型安全に提供したい場合
  - コード例: `src/client/client.ts:15-31` — `createProxy` による動的プロパティチェーン
  - 注意点: ランタイムは Proxy で動的解決するが、型は `PathToChain` で静的に解決される。両者の整合性は型テストで担保する

## Good Patterns

- **any 型の防御的な除去**: `IntersectNonAnyTypes` は `any` が他の型をインターセクションで汚染する問題を解決する。`IsAny<T>` ガード（`0 extends 1 & T`）と `IfAnyThenEmptyObject` で `any` を `{}` に正規化してからインターセクションを取る。

```typescript
// src/utils/types.ts:21,110
export type IfAnyThenEmptyObject<T> = 0 extends 1 & T ? {} : T
export type IsAny<T> = boolean extends (T extends never ? true : false) ? true : false
```

- **JSON シリアライズの型レベルシミュレーション**: `JSONParsed<T>` は `Date` → `.toJSON()` の戻り値、`undefined` → フィールド除外、`Set`/`Map` → `{}`、`bigint` → `never` など、`JSON.stringify` の挙動を網羅的に型で再現する。これによりクライアント側が受け取る型が実際のレスポンスと一致する。

```typescript
// src/utils/types.ts:53-60
export type JSONParsed<T, TError = bigint | ReadonlyArray<bigint>> = T extends {
  toJSON(): infer J
}
  ? (() => J) extends () => JSONPrimitive
    ? J
    : (() => J) extends () => { toJSON(): unknown }
      ? {}
      : JSONParsed<J, TError>
  : T extends JSONPrimitive ? T : /* ... */
```

- **in/out 分離による入力型と出力型の独立制御**: バリデーターの `Input` 型が `in`（クライアントが送信する型）と `out`（ハンドラーが受け取る型）を分離している。フォームデータでは `in` が `string | Blob`、`out` が `string | File` というように変換後の型を正確に表現できる。

```typescript
// src/types.ts:43-47
export type Input = {
  in?: {}
  out?: {}
  outputFormat?: ResponseFormat
}
```

## Anti-Patterns / 注意点

- **オーバーロード爆発**: ハンドラー数ごとに個別のオーバーロードを定義する手法は、1〜10 個で約 900 行のコードを生成している。TypeScript の可変長ジェネリクスの制限に起因するが、新しい組み合わせを追加するたびにすべてのインターフェースを更新する必要がある。

```typescript
// Bad: 各ハンドラー数に対して個別のオーバーロードが必要
// src/types.ts:128-948 — HandlerInterface だけで約 820 行

// Better (将来の TypeScript が対応した場合):
// 可変長タプル型を活用した単一定義
// 現時点では TypeScript の推論限界により実現不可
```

- **`return this as any` による型安全性の放棄**: 実装側では `return this as any` を使い、型チェックをバイパスしている。型とランタイムの整合性は型テスト（`src/types.test.ts`）で保証しているが、実装変更時に型テストの更新を忘れるとサイレントに破綻する。

```typescript
// Bad: 実装側で型安全性を放棄
// src/hono-base.ts:139
return this as any

// Better: 型テストを充実させ、CI で必ず検証する
// src/types.test.ts で expectTypeOf を使用した網羅的な型テスト
```

## 導出ルール

- `[MUST]` 型レベルの API 契約を設計する場合、Phantom Type でランタイムに影響しないメタデータを伝搬させ、型情報の損失を防ぐこと
  - 根拠: Hono の `TypedResponse<T, U, F>` は `_data`, `_status`, `_format` でレスポンス型情報を保持し、RPC クライアントまで型を伝搬している（`src/types.ts:2346-2358`）

- `[MUST]` `any` 型が型パラメータに混入する可能性がある場合、インターセクション前に `IsAny` ガードで `{}` に正規化すること
  - 根拠: `any & T = any` により型情報が消失するため、Hono は `IntersectNonAnyTypes` で全ミドルウェアの `Env` をマージする前に `any` を除去している（`src/types.ts:2473-2476`）

- `[SHOULD]` 型レベルのビルダーパターンでは、メソッドチェーンの戻り値型に蓄積された型パラメータを含め、チェーンの各ステップで型情報を保持すること
  - 根拠: `HandlerInterface` の各オーバーロードが `HonoBase<E, S & ToSchema<...>, BasePath>` を返し、`S` にルート情報を累積する設計がクライアント型の自動導出を可能にしている（`src/types.ts:143-148`）

- `[SHOULD]` 型と実装を分離する場合、型テスト（`expectTypeOf` 等）で型契約の網羅的な検証を行い、実装の `as any` と型定義の整合性を保証すること
  - 根拠: Hono は `src/types.test.ts` と `src/client/types.test.ts` で型レベルの期待値を記述し、`as any` を使う実装側との整合性を型テストで担保している

- `[SHOULD]` JSON レスポンスの型にはシリアライズ後の型（`JSONParsed<T>`）を使い、クライアントが受け取る実際のデータ型と一致させること
  - 根拠: `Date` → `string`、`undefined` → フィールド除外など、`JSON.stringify` の変換を型で再現しないとクライアント側で型不一致が起きる（`src/utils/types.ts:53-83`）

- `[AVOID]` 型レベルの再帰的な文字列パースにおいて、Union 型が膨張するパターンを作ること。パスパラメータ抽出のような再帰型では、条件分岐の各枝が Union に展開されないよう `[T] extends [never]` でラップすること
  - 根拠: `ExtractParams` は条件型の分配を制御し、`string extends Path` ガードで非リテラル型が入った場合のフォールバックを明示している（`src/types.ts:2264-2270`）

## 適用チェックリスト

- [ ] API レスポンスの型が `JSON.stringify` 後の型を正確に反映しているか（`Date` が `string` に、`undefined` フィールドが除外されているか）
- [ ] ミドルウェアが追加する環境変数（`Variables`）の型が、後続ハンドラーの `Context` 型に正しく伝搬しているか
- [ ] `any` 型がジェネリクスパラメータに混入した場合の防御（`IsAny` ガード）が実装されているか
- [ ] 型と実装を分離している箇所（`as any` の使用箇所）に対応する型テストが存在するか
- [ ] パスパラメータの型抽出が Template Literal Types で自動化されており、手動のパラメータ型定義が不要になっているか
- [ ] RPC クライアント的な型導出を行う場合、サーバー側の Schema 型からクライアント型への変換が自動的に行われる仕組みがあるか
- [ ] バリデーション結果の入力型（クライアント送信型）と出力型（ハンドラー受信型）が適切に分離されているか
