# Validator System

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono のバリデーションシステムは、ミドルウェアとして動作するライブラリ非依存のバリデーション基盤である。`validator()` 関数が 6 種類のリクエストデータソース（json, form, query, param, header, cookie）を統一的に扱い、バリデーション結果を TypeScript の型システムに反映させる。特筆すべきは、Zod・Valibot 等の外部バリデーションライブラリを「プラグイン」として接続する設計と、バリデーション結果の Input/Output 型がルート定義から hc（RPC クライアント）まで一気通貫で伝搬する型推論アーキテクチャである。

## 設計・実装の詳細

### コアアーキテクチャ: バリデーションライブラリ非依存の抽象化

Hono のバリデーターは特定のバリデーションライブラリに依存しない。`validator()` 関数は「ターゲット」と「バリデーション関数」の 2 引数を受け取り、バリデーションロジックの実装をユーザーに委譲する。

```typescript
// src/validator/validator.ts:46-88
export const validator = <
  InputType,
  P extends string,
  M extends string,
  U extends ValidationTargetByMethod<M>,
  // ... 型パラメータ省略
>(
  target: U,
  validationFunc: VF
): MiddlewareHandler<E, P, V, ExtractValidationResponse<VF>> => {
```

この設計により、Hono 本体はバリデーションの「データ取得」と「結果の格納」のみを担当し、「どうバリデートするか」は完全にユーザー（またはサードパーティアダプタ）に任せている。

### ValidationTargets: 6 つのリクエストデータソース

バリデーション対象は `ValidationTargets` 型で定義されており、各ターゲットごとに適切な型が付けられている。

```typescript
// src/types.ts:2394-2401
export type ValidationTargets<T extends FormValue = ParsedFormValue, P extends string = string> = {
  json: any
  form: Record<string, T | T[]>
  query: Record<string, string | string[]>
  param: Record<P, P extends `${infer _}?` ? string | undefined : string>
  header: Record<RequestHeader | CustomHeader, string>
  cookie: Record<string, string>
}
```

注目点として、`json` のみ `any` 型になっている。これは JSON ボディの構造が事前に不明であり、バリデーション関数の戻り値で型が決まるためである。一方、`query` は `string | string[]`、`param` は `string` といった HTTP プロトコルに忠実な型付けがされている。

### HTTP メソッドによるターゲット制限

GET/HEAD リクエストはボディを持たないという HTTP 仕様を型レベルで強制している。

```typescript
// src/validator/validator.ts:9-12
type ValidationTargetKeysWithBody = 'form' | 'json'
type ValidationTargetByMethod<M> = M extends 'get' | 'head'
  ? Exclude<keyof ValidationTargets, ValidationTargetKeysWithBody>
  : keyof ValidationTargets
```

これにより `app.get('/path', validator('json', ...))` はコンパイルエラーとなり、不正な API 設計を型レベルで防止できる。

### データ抽出のスイッチ処理

`validator()` のランタイム実装は、ターゲットに応じた switch 文でリクエストからデータを抽出する。

```typescript
// src/validator/validator.ts:89-160
return async (c, next) => {
    let value = {}
    const contentType = c.req.header('Content-Type')

    switch (target) {
      case 'json':
        if (!contentType || !jsonRegex.test(contentType)) {
          break  // Content-Type が不正なら空オブジェクトのまま
        }
        try {
          value = await c.req.json()
        } catch {
          const message = 'Malformed JSON in request body'
          throw new HTTPException(400, { message })
        }
        break
      case 'form': {
        // multipart/form-data と x-www-form-urlencoded の両方に対応
        // ...
      }
      case 'query':
        value = Object.fromEntries(
          Object.entries(c.req.queries()).map(([k, v]) => {
            return v.length === 1 ? [k, v[0]] : [k, v]
          })
        )
        break
      // param, header, cookie ...
    }
```

重要な設計判断として、Content-Type が不正な場合は例外を投げるのではなく、**空オブジェクトを渡してバリデーション関数に判断を委ねている**（json と form の場合）。ただし、Content-Type が正しいにもかかわらずパースに失敗した場合は `HTTPException(400)` を投げる。

### FormData の配列処理

FormData の値が同じキーで複数送信される場合の処理が丁寧に実装されている。

```typescript
// src/validator/validator.ts:129-141
const form: BodyData<{ all: true }> = {}
formData.forEach((value, key) => {
  if (key.endsWith('[]')) {
    ;((form[key] ??= []) as unknown[]).push(value)
  } else if (Array.isArray(form[key])) {
    ;(form[key] as unknown[]).push(value)
  } else if (key in form) {
    form[key] = [form[key] as string | File, value]
  } else {
    form[key] = value
  }
})
```

`foo[]` のように `[]` サフィックスを持つキーは常に配列として扱い、同じキーが複数回出現する場合は自動的に配列に変換する。Rails/PHP のフォーム規約と互換性がある。

### バリデーション結果の格納と取得

バリデーション関数の戻り値は `HonoRequest` の内部ストアに格納され、ハンドラーから型安全に取得できる。

```typescript
// src/validator/validator.ts:162-170
const res = await validationFunc(value as never, c as never)

if (res instanceof Response) {
  return res as ExtractValidationResponse<VF>  // エラーレスポンスを即座に返却
}

c.req.addValidatedData(target, res as never)  // 結果を格納
return (await next()) as ExtractValidationResponse<VF>
```

```typescript
// src/request.ts:321-335
addValidatedData(target: keyof ValidationTargets, data: {}) {
  this.#validatedData[target] = data
}

valid<T extends keyof I & keyof ValidationTargets>(target: T): InputToDataByTarget<I, T>
valid(target: keyof ValidationTargets) {
  return this.#validatedData[target] as unknown
}
```

バリデーション関数が `Response` を返した場合はミドルウェアチェーンを中断し、そのレスポンスを返す。成功時はデータを格納して `next()` でチェーンを続行する。

### Input/Output の型分離と InferInput

バリデーションの型システムで最も洗練された部分は、Input 型（クライアントが送信するデータの型）と Output 型（バリデーション後にハンドラーが受け取る型）の分離である。

```typescript
// src/validator/utils.ts:59-69
export type InferInput<
  Output,
  Target extends keyof ValidationTargets,
  T extends FormValue = ParsedFormValue,
> = [Exclude<Output, undefined>] extends [never]
  ? {}
  : [Exclude<Output, undefined>] extends [object]
    ? undefined extends Output
      ? SimplifyDeep<InferInputInner<Exclude<Output, undefined>, Target, T>> | undefined
      : SimplifyDeep<InferInputInner<Output, Target, T>>
    : {}
```

例えば、Zod の `z.string().transform(Number)` を使った query バリデーションでは、Output は `number` だが Input は `string | string[]`（HTTP クエリパラメータの実際の型）になる。リテラルユニオン型（`'asc' | 'desc'`）は `IsLiteralUnion` で判別し、Input 側でもそのまま保持される。

### Content-Type 判定の正規表現

JSON と FormData の Content-Type 判定には、サブタイプまで考慮した正規表現が使われている。

```typescript
// src/validator/validator.ts:24-26
const jsonRegex = /^application\/([a-z-\.]+\+)?json(;\s*[a-zA-Z0-9\-]+\=([^;]+))*$/
const multipartRegex = /^multipart\/form-data(;\s?boundary=[a-zA-Z0-9'"()+_,\-./:=?]+)?$/
const urlencodedRegex = /^application\/x-www-form-urlencoded(;\s*[a-zA-Z0-9\-]+\=([^;]+))*$/
```

`application/merge-patch+json` や `application/vnd.api+json` のような JSON サブタイプも正しく認識する。テストケースでも明確にカバーされている（`validator.test.ts:182-204`）。

## コード例

### 基本的な使い方: カスタムバリデーション

```typescript
// src/validator/validator.test.ts:66-80
const route = app.get(
  '/search',
  validator('query', (value, c) => {
    // value の型は Record<string, string | string[]>
    if (!value.q) {
      return c.text('Invalid!', 400)  // エラーレスポンスを直接返却
    }
    // undefined を返す（バリデーション成功だが変換なし）
  }),
  (c) => {
    return c.text('Valid!', 200)
  }
)
```

### Zod との統合パターン（テスト内リファレンス実装）

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

### 複数バリデーターのスタック

```typescript
// src/validator/validator.test.ts:835-865
const route = app.post(
  '/posts',
  zodValidator('query', z.object({
    page: z.string().refine((v) => !isNaN(Number(v))).transform(Number),
  })),
  zodValidator('form', z.object({
    title: z.string(),
  })),
  (c) => {
    const { page } = c.req.valid('query')   // number 型
    const { title } = c.req.valid('form')    // string 型
    return c.json({ page, title })
  }
)
// 型: input は { query: { page: string } } & { form: { title: string } }
```

## Good Patterns

- **バリデーションライブラリ非依存の抽象化**: `validator()` はバリデーション関数を引数に取るだけで、Zod・Valibot・ArkType 等のライブラリ選択をユーザーに委ねている。フレームワーク側のロックインがなく、ライブラリの移行コストが低い。

```typescript
// src/validator/validator.ts:86-88
// target と validationFunc の2引数だけ。バリデーションロジックは完全に外部化
>(
  target: U,
  validationFunc: VF
): MiddlewareHandler<E, P, V, ExtractValidationResponse<VF>> => {
```

- **エラーレスポンスの即座返却パターン**: バリデーション関数が `Response` を返した場合、ミドルウェアチェーンを中断して即座にレスポンスを返す。これにより、バリデーションエラーのハンドリングが直感的で、try-catch のネストが不要になる。

```typescript
// src/validator/validator.ts:164-166
if (res instanceof Response) {
  return res as ExtractValidationResponse<VF>
}
```

- **HTTP メソッドによる型レベルの制約**: GET/HEAD で json/form バリデーションを使おうとするとコンパイルエラーになる。ランタイムではなく型レベルで不正な使い方を防止する。

```typescript
// src/validator/validator.ts:10-12
type ValidationTargetByMethod<M> = M extends 'get' | 'head'
  ? Exclude<keyof ValidationTargets, ValidationTargetKeysWithBody>
  : keyof ValidationTargets
```

- **Content-Type の安全なフォールバック**: Content-Type が想定外の場合、例外を投げるのではなく空オブジェクトを渡してバリデーション関数に判断を委ねる。一方、パースエラー（Malformed JSON 等）は `HTTPException(400)` で明確にエラーとする。防御的プログラミングと適切なエラー報告のバランスが取れている。

```typescript
// src/validator/validator.ts:94-103
case 'json':
  if (!contentType || !jsonRegex.test(contentType)) {
    break  // 空オブジェクトのまま → バリデーション関数に委ねる
  }
  try {
    value = await c.req.json()
  } catch {
    const message = 'Malformed JSON in request body'
    throw new HTTPException(400, { message })  // パースエラーは明確に400
  }
```

- **Input/Output 型分離による正確な型推論**: バリデーション前の「クライアントが送るべき型」（Input）とバリデーション後の「ハンドラーが受け取る型」（Output）を分離し、transform 付きスキーマでも正しい型が推論される。

```typescript
// src/validator/validator.test.ts:1261-1298
// query の transform で string → number への変換
// Input: { query: { page: string | string[] } }  ← クライアント側
// Output: { query: { page: number } }              ← ハンドラー側
```

## Anti-Patterns / 注意点

- **バリデーション関数で undefined を返すことによる型の曖昧さ**: バリデーション関数が明示的に値を返さない場合、`c.req.valid()` の戻り値型が不安定になりうる。テストコード中でも `void` を返すケースがあるが、型推論上は `undefined` がバリデーション結果として格納される。

```typescript
// Bad: 明示的な戻り値なし
validator('query', (value, c) => {
  if (!value.q) {
    return c.text('Invalid!', 400)
  }
  // 暗黙の undefined が返る → c.req.valid('query') の型が不明確
})

// Better: 明示的にバリデーション済みデータを返す
validator('query', (value, c) => {
  if (!value.q) {
    return c.text('Invalid!', 400)
  }
  return { q: value.q as string }  // 型が明確
})
```

- **サードパーティアダプタでの型キャスト**: `zodValidator` のリファレンス実装では `as MiddlewareHandler<...>` による型キャストが必要になっている。Hono 本体の `validator()` が返す型は複雑なジェネリクスで構成されており、外部ライブラリが正確な型を保持するためにはキャストが避けられない。

```typescript
// src/validator/validator.test.ts:55-61
// as による型キャストが必要
return validator(target, validationFunc) as MiddlewareHandler<
  E, P,
  { in: { [K in Target]: z.input<T> }; out: { [K in Target]: z.output<T> } },
  ResponseType
>
```

- **FormData のキャッシュに注意**: FormData の取得に `bufferToFormData` を使った独自キャッシュ機構がある。先行するミドルウェアが `c.req.formData()` を呼んでいた場合はキャッシュを使い回すが、`c.req.raw` 経由で直接ボディを消費した場合はバリデーターがデータを取得できない可能性がある。

```typescript
// src/validator/validator.ts:115-127
if (c.req.bodyCache.formData) {
  formData = await c.req.bodyCache.formData
} else {
  try {
    const arrayBuffer = await c.req.arrayBuffer()
    formData = await bufferToFormData(arrayBuffer, contentType)
    c.req.bodyCache.formData = formData
  } catch (e) {
    // ...
  }
}
```

## 自分のプロジェクトへの適用

- [ ] バリデーション関数を「ターゲット + ロジック関数」で抽象化する設計を採用し、特定のバリデーションライブラリへの依存を避ける
- [ ] バリデーション結果の Input/Output 型分離パターンを導入し、transform（文字列 → 数値変換等）があっても API クライアントに正しい入力型を伝搬させる
- [ ] HTTP メソッドに応じたバリデーションターゲットの制約を型レベルで実装し、GET リクエストに body バリデーションを適用するようなミスを防ぐ
- [ ] Content-Type の不一致とパースエラーを区別するエラーハンドリング戦略を採用する（不一致は寛容に、パースエラーは厳格に）
- [ ] バリデーション関数がエラーレスポンスを直接返却できるパターンを導入し、throw ベースではなく戻り値ベースのエラーハンドリングで可読性を向上させる
