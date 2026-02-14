# validator-system

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono のバリデーターシステムは、HTTP リクエストの 6 種類のデータソース（json, form, query, param, header, cookie）を統一インターフェースで検証するミドルウェア機構である。注目すべき点は、バリデーション関数の戻り値型がそのまま `c.req.valid()` の型とルートスキーマの `input`/`output` 型に伝搬する設計にあり、フレームワーク本体が特定のバリデーションライブラリに依存しない「プロトコル指向」の統合パターンを採用していることである。外部ライブラリ（Zod, Valibot 等）との統合は、Hono 本体が提供する `validator()` 関数の「コールバック関数の型シグネチャ」を契約として成立する。

## 設計思想

- **バリデーションライブラリ非依存の原則**: Hono は特定のバリデーションライブラリをコアに取り込まず、`validator(target, fn)` というコールバックベースの API を提供する。外部ライブラリとの統合は薄いラッパー関数（`@hono/zod-validator` 等）が担い、コアのバリデーターは「データ取得 + コールバック呼び出し + 結果格納」のみに責務を限定する。テストファイル内の `zodValidator` リファレンス実装（`src/validator/validator.test.ts:36-61`）が示すように、統合コードは 20 行程度で完結する。

- **型推論の双方向伝搬**: バリデーション関数の戻り値型が `out` として後続ハンドラーの `c.req.valid()` に伝搬し、同時に入力側の型（`in`）もバリデーションターゲットに応じた適切な型（`string | string[]` for query 等）に自動変換される。この二重マッピングにより、スキーマ定義一箇所の変更がハンドラーとクライアント（hc）の両方に波及する（`src/validator/validator.ts:64-82`）。

- **Content-Type による防御的スキップ**: JSON/Form バリデーションは Content-Type ヘッダーが適切でない場合、バリデーション自体をスキップして空オブジェクトを返す。これは不正な Content-Type で 400 エラーを返すのではなく、「Content-Type が正しい場合のみバリデーションする」という寛容な設計である（`src/validator/validator.ts:94-98`）。Malformed JSON のみ HTTPException(400) を投げる。

- **HTTPメソッドによるターゲット制約**: `ValidationTargetByMethod` 型により、GET/HEAD リクエストでは `json` と `form` のバリデーションが型レベルで禁止される（`src/validator/validator.ts:10-12`）。HTTP 仕様（GET/HEAD はボディを持たない）を型システムで強制する。

## 設計・実装の詳細

### コアバリデーターの構造

`validator()` 関数はミドルウェアハンドラーを返す高階関数である。実行時の処理は 3 段階に分かれる。

1. **データ抽出**: `target` に基づく switch 文でリクエストからデータを取得
2. **コールバック呼び出し**: ユーザー定義のバリデーション関数を実行
3. **結果の分岐**: Response が返された場合はそのまま返却（早期リターン）、それ以外は `addValidatedData()` で格納して `next()` を呼ぶ

```typescript
// src/validator/validator.ts:89-171
return async (c, next) => {
  let value = {}
  // ... switch による target 別データ抽出 ...

  const res = await validationFunc(value as never, c as never)

  if (res instanceof Response) {
    return res as ExtractValidationResponse<VF>
  }

  c.req.addValidatedData(target, res as never)
  return (await next()) as ExtractValidationResponse<VF>
}
```

### バリデーション結果の格納と取得

`HonoRequest` クラスは private フィールド `#validatedData` にターゲットごとのバリデーション結果を保持する。`addValidatedData()` と `valid()` が対になるシンプルな setter/getter パターンである。

```typescript
// src/request.ts:53
#validatedData: { [K in keyof ValidationTargets]?: {} }

// src/request.ts:321-322
addValidatedData(target: keyof ValidationTargets, data: {}) {
  this.#validatedData[target] = data
}

// src/request.ts:333-336
valid<T extends keyof I & keyof ValidationTargets>(target: T): InputToDataByTarget<I, T>
valid(target: keyof ValidationTargets) {
  return this.#validatedData[target] as unknown
}
```

`valid()` メソッドはオーバーロードにより、型レベルでは `InputToDataByTarget<I, T>` を返し、ランタイムでは単純な辞書参照を行う。型情報は `validator()` ミドルウェアの `V` ジェネリクスから `Input` 型を経由してハンドラーに伝搬する。

### ValidationTargets の設計

6 つのバリデーションターゲットはそれぞれ異なる型を持つ。

```typescript
// src/types.ts:2394-2401
export type ValidationTargets<T extends FormValue = ParsedFormValue, P extends string = string> = {
  json: any          // 任意の JSON 構造
  form: Record<string, T | T[]>   // フォームは値 or 配列
  query: Record<string, string | string[]>  // クエリは文字列 or 配列
  param: Record<P, P extends `${infer _}?` ? string | undefined : string>  // パスパラメータ
  header: Record<RequestHeader | CustomHeader, string>  // ヘッダー
  cookie: Record<string, string>  // Cookie
}
```

`json` のみ `any` 型で、他のターゲットは HTTP の仕様に基づいた具体的な型を持つ。

### 外部バリデーターとの統合パターン

Hono 本体のテストファイルに含まれるリファレンス実装が統合の契約を示す。

```typescript
// src/validator/validator.test.ts:36-61
const zodValidator = <
  T extends z.ZodSchema,
  E extends {},
  P extends string,
  Target extends keyof ValidationTargets,
>(
  target: Target,
  schema: T
) => {
  const validationFunc = (value: unknown, c: Context<E, P>) => {
    const result = schema.safeParse(value)
    if (!result.success) {
      return c.text('Invalid!', 400)
    }
    return result.data as z.output<T>
  }

  return validator(target, validationFunc) as MiddlewareHandler<
    E, P,
    { in: { [K in Target]: z.input<T> }; out: { [K in Target]: z.output<T> } },
    ResponseType
  >
}
```

統合のポイントは、`validator()` の戻り値を `MiddlewareHandler` にキャストする際に `in`（スキーマの入力型）と `out`（スキーマの出力型）を明示的に指定することである。これにより Zod の `z.input<T>` / `z.output<T>` の区別（transform 前後の型差異）が正しくハンドラーに伝搬する。

### InferInput 型ユーティリティ

`InferInput` は、バリデーション結果の出力型からターゲットに応じた入力型を逆算する型ユーティリティである。

```typescript
// src/validator/utils.ts:25-45
type InferInputInner<Output, Target extends keyof ValidationTargets, T extends FormValue> =
  SimplifyDeep<{
    [K in keyof Output]: IsLiteralUnion<Output[K], string> extends true
      ? Output[K]       // リテラルユニオン ('asc' | 'desc') はそのまま保持
      : IsOptionalUnion<Output[K]> extends true
        ? Output[K]     // T | undefined もそのまま保持
        : Target extends 'form'
          ? T | T[]     // form は FormValue
          : Target extends 'query'
            ? string | string[]  // query は string
            : // ... 他のターゲットも同様
```

リテラルユニオン型（`'asc' | 'desc'`）とオプショナルユニオン型（`T | undefined`）を検出してそのまま保持し、それ以外はターゲット固有のデフォルト型に変換する。これにより、`z.enum(['asc', 'desc'])` のようなスキーマ定義がクライアント側の入力型にも正しく反映される。

### 複数バリデーターのチェーン

同一ルートに複数のバリデーターを連結できる。各バリデーターは異なるターゲットに対してデータを格納し、ハンドラーでは `c.req.valid('query')` と `c.req.valid('form')` のように別々に取得する。型レベルでは `I & I2` のインターセクション型によって複数バリデーターの入出力が合成される。

```typescript
// src/validator/validator.test.ts:835-865
const route = app.post(
  '/posts',
  zodValidator('query', z.object({ page: z.string().transform(Number) })),
  zodValidator('form', z.object({ title: z.string() })),
  (c) => {
    const { page } = c.req.valid('query')   // number
    const { title } = c.req.valid('form')   // string
    return c.json({ page, title })
  }
)
```

### Body キャッシュとの協調

バリデーター内で body を消費した後もハンドラーで再度 body を読めるよう、`c.req.bodyCache` を活用したキャッシュ機構が組み込まれている（`src/validator/validator.ts:115-127`）。FormData は `arrayBuffer` から `bufferToFormData` で再変換し、キャッシュに保存する。

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: バリデーションロジックを呼び出し元から分離し、実行時に差し替え可能にする
  - 適用条件: 検証ロジックが多様で、フレームワーク側が特定の実装に依存すべきでない場合
  - コード例: `src/validator/validator.ts:46-88` -- `validationFunc` パラメータが Strategy に相当
  - 注意点: 通常の Strategy パターンはインターフェースを定義するが、Hono は関数シグネチャ（コールバック）で契約を表現する。TypeScript の型推論と相性が良い

- **Mediator パターン** (分類: 振る舞い)
  - 解決する問題: バリデーション結果を複数のミドルウェア間で共有する
  - 適用条件: リクエスト処理パイプラインで前段の結果を後段が参照する必要がある場合
  - コード例: `src/request.ts:321-336` -- `addValidatedData` / `valid` が Mediator 的な役割を果たす
  - 注意点: `HonoRequest` が Mediator として機能し、バリデーター間の直接的な依存を排除している

## Good Patterns

- **コールバックベースのライブラリ統合**: `validator(target, fn)` のシグネチャにより、任意のバリデーションライブラリを 20 行程度のラッパーで統合できる。フレームワーク本体の依存関係が増えず、ユーザーはバリデーションライブラリを自由に選択できる。

```typescript
// src/validator/validator.test.ts:44-61 (リファレンス実装)
const zodValidator = <T extends z.ZodSchema, ...>(target: Target, schema: T) => {
  const validationFunc = (value: unknown, c: Context<E, P>) => {
    const result = schema.safeParse(value)
    if (!result.success) {
      return c.text('Invalid!', 400) // Response を返すと早期リターン
    }
    return result.data as z.output<T>  // データを返すと格納 + next()
  }
  return validator(target, validationFunc) as MiddlewareHandler<...>
}
```

- **戻り値型による制御フロー分岐**: バリデーション関数が `Response` を返せばエラーレスポンス、データオブジェクトを返せば成功として格納する。`if/else` や例外ではなく戻り値の型で制御フローが決まるため、型安全にエラーハンドリングの種類（テキスト、JSON、カスタム Response）をユーザーが選択できる。

```typescript
// src/validator/validator.ts:162-170
const res = await validationFunc(value as never, c as never)

if (res instanceof Response) {
  return res  // エラーレスポンスを直接返却
}

c.req.addValidatedData(target, res as never)  // 成功データを格納
return (await next())
```

- **HTTP 仕様の型レベル強制**: `ValidationTargetByMethod` により GET/HEAD で body 系バリデーション（json, form）を型エラーにする。ランタイムエラーではなく、コンパイル時に HTTP 仕様違反を検出できる。

```typescript
// src/validator/validator.ts:9-12
type ValidationTargetKeysWithBody = 'form' | 'json'
type ValidationTargetByMethod<M> = M extends 'get' | 'head'
  ? Exclude<keyof ValidationTargets, ValidationTargetKeysWithBody>
  : keyof ValidationTargets
```

## Anti-Patterns / 注意点

- **Content-Type 不一致時のサイレントスキップ**: Content-Type が不正な場合にバリデーションがスキップされ空オブジェクトが返る。開発者が Content-Type の設定を忘れた場合、バリデーションが効いていないことに気づきにくい。

```typescript
// Bad: Content-Type を設定し忘れると validator がスキップされる
const res = await app.request('http://localhost/post', {
  method: 'POST',
  body: JSON.stringify({ foo: 'bar' }),
  // Content-Type: 'application/json' が無い → バリデーションスキップ
})
// res.status は 200 だが、c.req.valid('json') は {}
```

```typescript
// Better: バリデーションラッパー側で Content-Type チェックを追加する
const strictJsonValidator = <T extends z.ZodSchema>(schema: T) =>
  validator('json', (value, c) => {
    if (Object.keys(value).length === 0) {
      return c.json({ error: 'Missing or invalid Content-Type' }, 400)
    }
    const result = schema.safeParse(value)
    if (!result.success) return c.json({ errors: result.error.flatten() }, 400)
    return result.data
  })
```

- **MiddlewareHandler へのキャストによる型安全性の穴**: 外部バリデーターの統合では `as MiddlewareHandler<...>` によるキャストが必要になる。`in` と `out` の型を手動で指定するため、スキーマ定義と不整合が生じるリスクがある。

```typescript
// Bad: in/out の型を間違えてキャスト
return validator(target, validationFunc) as MiddlewareHandler<
  E, P,
  { in: { [K in Target]: string }; out: { [K in Target]: number } } // 手動指定ミス
>

// Better: z.input<T> / z.output<T> を使って型を自動導出
return validator(target, validationFunc) as MiddlewareHandler<
  E, P,
  { in: { [K in Target]: z.input<T> }; out: { [K in Target]: z.output<T> } }
>
```

## 導出ルール

> このセクションは必須。最低 3 個のルールを記載すること。synthesis-writer が rules.md 生成時に参照する。

- `[MUST]` フレームワークのバリデーション層は特定のバリデーションライブラリに依存せず、コールバック関数の型シグネチャを統合契約として設計する
  - 根拠: Hono は `validator(target, fn)` のコールバックパターンにより、コア 186 行で Zod/Valibot/TypeBox 等あらゆるバリデーションライブラリとの統合を可能にしている（`src/validator/validator.ts`）

- `[MUST]` バリデーション結果の型を `in`（入力型）と `out`（出力型）に分離し、transform（型変換）前後の型を正確にハンドラーとクライアントに伝搬させる
  - 根拠: `InferInput` 型ユーティリティ（`src/validator/utils.ts:59-69`）がリテラルユニオンやオプショナル型を保持しつつ、ターゲット固有のデフォルト型に変換する設計により、`z.transform()` の前後で型が正確に伝搬する

- `[SHOULD]` バリデーション関数の「戻り値型」で成功/失敗の制御フローを表現する（Response 返却 = エラー、データ返却 = 成功）
  - 根拠: `src/validator/validator.ts:164-170` で `res instanceof Response` による分岐を行い、例外に頼らないエラーハンドリングを実現。型レベルで `ExtractValidationResponse` と `ExtractValidatorOutput` が Response 型とデータ型を分離する

- `[SHOULD]` HTTP メソッドの制約（GET/HEAD はボディを持たない等）を型システムで強制する
  - 根拠: `ValidationTargetByMethod<M>` 型（`src/validator/validator.ts:10-12`）により、GET リクエストに `validator('json', ...)` を指定するとコンパイルエラーになる

- `[AVOID]` バリデーション時に Content-Type の不一致をサイレントにスキップする設計を無批判に採用すること
  - 根拠: Hono は互換性と柔軟性のためにスキップを選択しているが（`src/validator/validator.ts:95-97`）、厳格なバリデーションが必要な API ではユーザー側でラッパーによる追加チェックが必要になる

- `[AVOID]` 外部バリデーター統合で `in`/`out` の型を手動で指定する際に、スキーマの `input`/`output` 型と不整合なキャストを行うこと
  - 根拠: `zodValidator` のリファレンス実装（`src/validator/validator.test.ts:55-60`）は `z.input<T>` / `z.output<T>` を使って型を自動導出しており、手動指定は型安全性を損なう

## 適用チェックリスト

- [ ] バリデーション層がコールバック/プラグイン形式で設計されており、特定のバリデーションライブラリにロックインしていないか
- [ ] バリデーション結果の型がハンドラー（サーバー側）とクライアント側の両方に正しく伝搬しているか
- [ ] transform を伴うバリデーション（文字列 -> 数値変換等）で、入力型と出力型が区別されているか
- [ ] HTTP メソッドに応じたバリデーションターゲットの制約が型レベルで強制されているか
- [ ] 複数のバリデーターを同一ルートにチェーンした際に、各バリデーション結果が独立して取得できるか
- [ ] Body を消費するバリデーション（JSON, FormData）後に、ハンドラーで再度 body を読めるキャッシュ機構があるか
- [ ] Content-Type の不一致時の挙動（スキップ vs エラー）がプロジェクトの要件に合致しているか
