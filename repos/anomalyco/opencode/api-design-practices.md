# api-design-practices

> リポジトリ: anomalyco/opencode
> 分析日: 2026-03-05

## 概要

opencode のサーバー API 設計を分析する。このプロジェクトは Hono + hono-openapi + Zod v4 でサーバーを構築し、OpenAPI 3.1 スペックを自動生成し、@hey-api/openapi-ts で型安全な SDK を自動生成するパイプラインを持つ。ドメインモジュールで定義した Zod スキーマがバリデーション・OpenAPI ドキュメント・SDK 型生成の単一ソースとなっている点が注目に値する。サーバー/クライアント間の型共有を手動同期なしに実現する実用的なアーキテクチャである。

## 背景にある原則

- **スキーマ単一ソース原則**: バリデーションスキーマ（Zod）を API ドキュメント（OpenAPI）と SDK 型の唯一の真実の源泉にすべき。なぜなら手動で OpenAPI スペックを書くとサーバー実装と乖離し、型定義を手動同期するとバグの温床になるため。opencode では Zod スキーマ → hono-openapi が OpenAPI JSON を生成 → @hey-api/openapi-ts が SDK を生成、という一方向パイプラインでこれを実現している（`script/generate.ts`, `packages/sdk/js/script/build.ts`）。

- **ドメインスキーマの API 層再利用原則**: API のリクエスト/レスポンス型はドメインモジュールが所有すべき。ルート定義で独自にスキーマを作るのではなく、ドメインモジュールの `Info` スキーマや `fn()` で束縛されたスキーマを `resolver()` / `validator()` に直接渡すことで、ドメイン変更が自動的に API スペックに反映される（`Session.Info`, `Session.create.schema` 等）。

- **operationId 駆動の SDK 構造化原則**: operationId に `<resource>.<action>` という命名規則を適用し、SDK クライアントのメソッド階層を自動的に構造化すべき。これにより SDK 利用者は `client.session.create()` のような直感的な API を得る（`server/routes/session.ts` の operationId 定義 → `sdk/js/src/gen/sdk.gen.ts` のクラス階層）。

- **エラー型の構造化原則**: エラーレスポンスも Zod スキーマで定義し、OpenAPI スペックに含めるべき。opencode では `NamedError.create()` で型安全なエラーを定義し、`errors()` ヘルパーで各ルートに一貫したエラースキーマを付与している（`server/error.ts:34`）。

## 実例と分析

### Zod → OpenAPI → SDK の自動生成パイプライン

パイプラインの全体像は以下の通り:

1. **ドメインモジュール**が Zod スキーマを定義（`.meta({ ref: "..." })` で OpenAPI の `$ref` 名を指定）
2. **ルート定義**が `describeRoute()` + `validator()` + `resolver()` でスキーマをルートに結合
3. **CLI の `generate` コマンド**が `Server.openapi()` → `generateSpecs()` で OpenAPI JSON を出力
4. **SDK ビルドスクリプト**が `@hey-api/openapi-ts` で TypeScript SDK を自動生成

```typescript
// packages/opencode/src/session/index.ts:119-161
export const Info = z
  .object({
    id: Identifier.schema("session"),
    slug: z.string(),
    projectID: z.string(),
    // ...
    title: z.string(),
    version: z.string(),
    time: z.object({
      created: z.number(),
      updated: z.number(),
      compacting: z.number().optional(),
      archived: z.number().optional(),
    }),
  })
  .meta({
    ref: "Session",
  });
export type Info = z.output<typeof Info>;
```

`.meta({ ref: "Session" })` がキーポイントで、OpenAPI スペックの `#/components/schemas/Session` として `$ref` 化される。これにより SDK 側で `Session` 型が独立した名前付き型として生成される。

### fn() ユーティリティによるスキーマとビジネスロジックの共置

```typescript
// packages/opencode/src/util/fn.ts:1-11
export function fn<T extends z.ZodType, Result>(schema: T, cb: (input: z.infer<T>) => Result) {
  const result = (input: z.infer<T>) => {
    const parsed = schema.parse(input);
    return cb(parsed);
  };
  result.force = (input: z.infer<T>) => cb(input);
  result.schema = schema;
  return result;
}
```

`fn()` はスキーマとコールバックを束ねた関数を返し、`.schema` プロパティでスキーマに外部からアクセスできる。ルート定義側で `Session.create.schema` や `Session.fork.schema.omit({ sessionID: true })` のように参照することで、ドメインロジックとAPI定義のスキーマが自動的に同期する。

### ルート定義パターン: describeRoute + validator + resolver

全ルートが以下の一貫した構造を持つ:

```typescript
// packages/opencode/src/server/routes/session.ts:24-67
.get(
  "/",
  describeRoute({
    summary: "List sessions",
    description: "Get a list of all OpenCode sessions...",
    operationId: "session.list",
    responses: {
      200: {
        description: "List of sessions",
        content: {
          "application/json": {
            schema: resolver(Session.Info.array()),
          },
        },
      },
    },
  }),
  validator("query", z.object({
    directory: z.string().optional().meta({ description: "Filter sessions by project directory" }),
    roots: z.coerce.boolean().optional().meta({ description: "Only return root sessions" }),
    // ...
  })),
  async (c) => {
    const query = c.req.valid("query")
    // ...
  },
)
```

`describeRoute` が OpenAPI メタデータ、`validator` がリクエストバリデーション、`resolver` がレスポンススキーマを担う。三者すべてが Zod スキーマを入力とする。

### エラーレスポンスの構造化と再利用

```typescript
// packages/opencode/src/server/error.ts:1-36
export const ERRORS = {
  400: {
    description: "Bad request",
    content: {
      "application/json": {
        schema: resolver(
          z.object({
            data: z.any(),
            errors: z.array(z.record(z.string(), z.any())),
            success: z.literal(false),
          }).meta({ ref: "BadRequestError" }),
        ),
      },
    },
  },
  404: {/* ... NotFoundError.Schema ... */},
} as const;

export function errors(...codes: number[]) {
  return Object.fromEntries(codes.map((code) => [code, ERRORS[code as keyof typeof ERRORS]]));
}
```

`errors(400, 404)` のようにスプレッドするだけでエラーレスポンスを各ルートに追加できる。全ルートでエラー形式が統一され、SDK 側でもエラー型が型安全に扱える。

### SDK 自動生成とクライアントファクトリ

```typescript
// packages/sdk/js/script/build.ts:14-39
await createClient({
  input: "./openapi.json",
  output: { path: "./src/v2/gen", clean: true },
  plugins: [
    { name: "@hey-api/typescript", exportFromIndex: false },
    {
      name: "@hey-api/sdk",
      instance: "OpencodeClient",
      paramsStructure: "flat",
    },
    { name: "@hey-api/client-fetch", baseUrl: "http://localhost:4096" },
  ],
});
```

生成された SDK は階層化されたクラス構造を持ち、`OpencodeClient` がドメインリソースごとのサブクライアントを公開する:

```typescript
// packages/sdk/js/src/gen/sdk.gen.ts:1157-1197
export class OpencodeClient extends _HeyApiClient {
  session = new Session({ client: this._client });
  project = new Project({ client: this._client });
  config = new Config({ client: this._client });
  // ...
}
```

### lazy() によるルート初期化の遅延

```typescript
// packages/opencode/src/server/routes/session.ts:22
export const SessionRoutes = lazy(() => new Hono().get(...).post(...))
```

全ルートファイルが `lazy()` でラップされている。これにより import 時にルート定義が即座に実行されず、実際に `App()` が呼ばれるまで初期化が遅延する。テスト時やCLI の `generate` コマンドで OpenAPI スペックだけ取得する場合に不要な副作用を防ぐ。

### SSE イベントストリームの型安全な定義

```typescript
// packages/opencode/src/bus/bus-event.ts:12-42
export function define<Type extends string, Properties extends ZodType>(type: Type, properties: Properties) {
  const result = { type, properties };
  registry.set(type, result);
  return result;
}

export function payloads() {
  return z.discriminatedUnion(
    "type",
    registry.entries().map(([type, def]) =>
      z.object({
        type: z.literal(type),
        properties: def.properties,
      }).meta({ ref: "Event" + "." + def.type })
    ).toArray() as any,
  ).meta({ ref: "Event" });
}
```

`BusEvent.define()` でイベントを登録し、`BusEvent.payloads()` で全イベントの discriminated union を動的に構築する。この union が SSE エンドポイントのレスポンススキーマに渡され、OpenAPI スペックに全イベント型が含まれる。

## パターンカタログ

- **Registry パターン** (分類: 振る舞い)
  - 解決する問題: 分散定義されたイベント型を一箇所に集約して OpenAPI スキーマとして出力する
  - 適用条件: 多数のモジュールが独立にイベントやエラーを定義し、それらを API スキーマに反映する必要がある場合
  - コード例: `packages/opencode/src/bus/bus-event.ts:10-42`
  - 注意点: `as any` キャストが必要になるため、登録漏れは型チェックでは検出できない

- **Facade パターン** (分類: 構造)
  - 解決する問題: 生成された低レベルの HTTP クライアントを、ドメイン指向の API で包む
  - 適用条件: 自動生成 SDK にカスタム初期化ロジック（ヘッダー注入、タイムアウト設定等）を追加する場合
  - コード例: `packages/sdk/js/src/client.ts:8-30`（`createOpencodeClient` が `OpencodeClient` をラップ）

## Good Patterns

- **ドメインスキーマの直接参照**: ルート定義で `resolver(Session.Info.array())` のようにドメインモジュールのスキーマを直接使う。スキーマのコピーが存在しないため、ドメイン変更が即座に API に反映される。

```typescript
// packages/opencode/src/server/routes/session.ts:34-36
content: {
  "application/json": {
    schema: resolver(Session.Info.array()),
  },
},
```

- **fn().schema によるバリデーションスキーマの外部公開**: ビジネスロジック関数にスキーマを添付し、ルート側で `.schema.omit()` 等の変換を適用する。URL パラメータとボディの分離が宣言的に行える。

```typescript
// packages/opencode/src/server/routes/session.ts:315
validator("json", Session.initialize.schema.omit({ sessionID: true })),
```

- **errors() スプレッドヘルパー**: エラーレスポンス定義をワンライナーで追加できる。`...errors(400, 404)` だけで済み、エラー形式の一貫性が保証される。

```typescript
// packages/opencode/src/server/routes/session.ts:108
...errors(400, 404),
```

- **operationId の命名規約**: `<resource>.<action>` 形式（`session.list`, `session.create`, `mcp.auth.start`）により、SDK のクラス階層が自動的に意味のある構造になる。

## Anti-Patterns / 注意点

- **ルートチェーンの型推論爆発**: Hono のルートチェーンが長くなると TypeScript の型推論が破綻する。opencode では `as unknown as Hono` キャストで対処している。

```typescript
// Bad: 型推論が失敗する長大なチェーン
// packages/opencode/src/server/server.ts:576
// ...
// ) as unknown as Hono,

// Better: ルートをドメインごとに分割し、.route() でマウントする
app.route("/session", SessionRoutes());
app.route("/project", ProjectRoutes());
```

opencode はルート分割を進めているが、server.ts にまだ多数のルートが残っている。ドメイン単位の分割を徹底すれば型推論問題を回避できる。

- **validator 未使用のパラメータ参照**: 一部のルートで `c.req.param("name")` を直接使い、`validator("param", ...)` を経由していない箇所がある。これだとバリデーションが行われず、OpenAPI スペックにパラメータ定義が出力されない。

```typescript
// Bad: packages/opencode/src/server/routes/mcp.ts:86
const name = c.req.param("name");

// Better: validator 経由でパラメータを取得する
validator("param", z.object({ name: z.string() })), async (c) => {
  const { name } = c.req.valid("param");
};
```

## 導出ルール

- `[MUST]` API のリクエスト/レスポンス型はバリデーションスキーマ（Zod 等）を単一ソースとし、OpenAPI スペックと SDK 型はそこから自動生成する
  - 根拠: opencode では全ルートが `resolver(DomainSchema)` + `validator("json", DomainSchema)` で Zod スキーマを直接参照し、手動の型同期を排除している（`server/routes/*.ts` 全体）

- `[MUST]` ドメインモジュールがスキーマを所有し、API 層はそれを参照するだけにする（API 層で独自にスキーマを定義しない）
  - 根拠: `Session.Info`, `Session.create.schema`, `Config.Info` 等のドメインスキーマがルート定義から直接参照されており、スキーマの重複が存在しない

- `[SHOULD]` operationId に `<resource>.<action>` 形式の命名規約を適用し、SDK クライアントの階層構造を自動的に導出する
  - 根拠: `session.list`, `mcp.auth.start` 等の operationId が @hey-api/openapi-ts により `OpencodeClient.session.list()`, `OpencodeClient.mcp.auth.start()` のメソッド階層に変換されている

- `[SHOULD]` エラーレスポンスのスキーマを一箇所で定義し、ヘルパー関数で全ルートにスプレッドする
  - 根拠: `errors()` ヘルパー（`server/error.ts:34`）により、全ルートで `...errors(400, 404)` と一行で統一エラー定義を追加している

- `[SHOULD]` ビジネスロジック関数にバリデーションスキーマを添付し（`fn()` パターン）、API 層で `.schema.omit()` 等の変換を適用してリクエストスキーマを導出する
  - 根拠: `Session.create.schema`, `Session.fork.schema.omit({ sessionID: true })` 等の利用パターン（`server/routes/session.ts`）

- `[SHOULD]` Zod スキーマに `.meta({ ref: "TypeName" })` を付与して、OpenAPI スペックで `$ref` として名前付き型を生成する
  - 根拠: `Session.Info.meta({ ref: "Session" })` により、SDK 側で `Session` 型が独立した名前付き型として利用可能になっている

- `[AVOID]` ルート定義内で `c.req.param()` や `c.req.query()` を直接使う（`validator()` を経由しない参照）
  - 根拠: `mcp.ts:86` で `c.req.param("name")` を直接使っている箇所があり、バリデーション未適用かつ OpenAPI パラメータ定義が欠落する

## 適用チェックリスト

- [ ] バリデーションライブラリ（Zod 等）のスキーマを API ドキュメントと SDK 型の単一ソースにしているか
- [ ] ドメインモジュールにスキーマを定義し、API 層はそれを `import` して参照するだけにしているか
- [ ] OpenAPI スペック生成がサーバーコードから自動化されているか（手書き OpenAPI YAML を排除）
- [ ] SDK がスペックから自動生成されるパイプラインが CI に組み込まれているか
- [ ] operationId に一貫した命名規約（`resource.action`）を適用しているか
- [ ] エラーレスポンスのスキーマが一箇所で定義され、全ルートに統一的に適用されているか
- [ ] スキーマに `$ref` 名（Zod なら `.meta({ ref })`, 他なら相当する機構）を付与し、生成される型名を制御しているか
- [ ] ルートハンドラ内のパラメータ取得がすべて validator 経由か（直接の `req.param()` 参照がないか）
