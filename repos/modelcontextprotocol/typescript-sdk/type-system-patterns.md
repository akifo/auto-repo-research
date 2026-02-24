# type-system-patterns

> リポジトリ: modelcontextprotocol/typescript-sdk
> 分析日: 2026-02-24

## 概要

MCP TypeScript SDK は Zod v4 スキーマを単一の信頼できる情報源（Single Source of Truth）として採用し、ランタイムバリデーションと静的型の両方をスキーマから導出する設計を徹底している。JSON-RPC プロトコルの全メッセージ型をスキーマとして定義し、`z.infer` で TypeScript 型を自動導出することで、型定義の二重管理を排除している。プロトコル仕様の正確な型表現と、ユーザー向け API の型推論の快適さを両立するために複数の抽象化層を設けている点が注目に値する。

## 背景にある原則

- **スキーマファースト原則**: 型を手書きせずスキーマから導出すべき。手書き型とバリデーションロジックの乖離はプロトコル違反を見逃す原因になる。MCP SDK では約120の型エイリアスすべてが `Infer<typeof XxxSchema>` パターンで定義されている（`types.ts:2401-2608`）。根拠: JSON-RPC のようなワイヤープロトコルでは、バリデーションなしにデータを信頼することは致命的であり、型とバリデーションの一致を構造的に保証する必要がある。

- **型レベルのプロトコル安全性**: メソッド名文字列とリクエスト/レスポンス型をコンパイル時に関連付けるべき。文字列リテラル型とマップ型を組み合わせることで、存在しないメソッドへのリクエストや型の不一致がコンパイルエラーになる。根拠: `MethodToTypeMap` 型（`types.ts:2611-2613`）と `RequestTypeMap`/`NotificationTypeMap` がこれを実現しており、ランタイムディスパッチと型システムの整合性を保証している。

- **抽象化によるスキーマライブラリ非依存性**: ユーザーコードがスキーマライブラリの内部 API に直接依存すべきではない。`AnySchema` / `SchemaOutput` のような抽象型を介在させることで、スキーマライブラリのバージョン変更（Zod v3 から v4 への移行など）の影響を局所化できる。根拠: `util/schema.ts` の `AnySchema = z.core.$ZodType` と各種ヘルパー関数がこのレイヤーを構成している。

- **仕様と実装の型分離**: プロトコル仕様の型（ワイヤー上の構造）と SDK 実装の型（内部ロジック）を分離すべき。仕様変更と実装変更の影響範囲を独立させられる。根拠: `spec.types.ts`（自動生成の純粋な TypeScript interface）と `types.ts`（Zod スキーマ + 導出型）の二層構造がこれを実現している。

## 実例と分析

### Zod スキーマからの一括型導出

ファイル末尾で `Infer` ユーティリティ型を使って約120のスキーマから対応する TypeScript 型を一括導出する。`Infer` は `z.infer` に `Flatten` ユーティリティを適用し、型の可読性を向上させている。

### JSON-RPC メッセージの型安全なディスパッチ

`MethodToTypeMap` 条件型が、union 型のメンバーから `method` リテラルをキーとするマップ型を自動生成する。これにより `setRequestHandler('tools/call', handler)` のように書くと、handler の引数型が `CallToolRequest` に自動推論される。

### スキーマ合成による階層的メッセージ定義

基底スキーマ（`RequestSchema`, `NotificationSchema`, `ResultSchema`）を `.extend()` で拡張して各メッセージ型を定義する。例えば `CallToolRequestSchema = RequestSchema.extend({ method: z.literal('tools/call'), params: ... })`。これにより共通フィールド（`jsonrpc`, `id`, `_meta`）の重複定義を排除している。

### スキーマアブストラクション層

`util/schema.ts` が `AnySchema`, `AnyObjectSchema`, `SchemaInput`, `SchemaOutput` を定義し、`parseSchema`, `schemaToJson`, `getSchemaShape` などのヘルパー関数を提供する。SDK 全体がこれらのヘルパーを通じてスキーマ操作を行い、`z.` 名前空間への直接参照を最小化している。

### Capability ベースの型制約

`ClientCapabilities` / `ServerCapabilities` インターフェースがオプショナルなネストオブジェクトで機能宣言を表現する。キーの有無が機能サポートを示す「Presence as Declaration」パターン。`assertCapabilityForMethod` / `assertRequestHandlerCapability` メソッドがランタイムでこれを検証する。

## コード例

```typescript
// packages/core/src/types/types.ts:2349-2362
// Flatten ユーティリティ: z.infer の出力を可読な型に変換
type Primitive = string | number | boolean | bigint | null | undefined;
type Flatten<T> = T extends Primitive
    ? T
    : T extends Array<infer U>
      ? Array<Flatten<U>>
      : T extends Set<infer U>
        ? Set<Flatten<U>>
        : T extends Map<infer K, infer V>
          ? Map<Flatten<K>, Flatten<V>>
          : T extends object
            ? { [K in keyof T]: Flatten<T[K]> }
            : T;

type Infer<Schema extends z.ZodTypeAny> = Flatten<z.infer<Schema>>;
```

```typescript
// packages/core/src/types/types.ts:2610-2617
// メソッド名 -> 型のマップを union 型から自動生成
type MethodToTypeMap<U> = {
    [T in U as T extends { method: infer M extends string } ? M : never]: T;
};
export type RequestMethod = ClientRequest['method'] | ServerRequest['method'];
export type NotificationMethod = ClientNotification['method'] | ServerNotification['method'];
export type RequestTypeMap = MethodToTypeMap<ClientRequest | ServerRequest>;
export type NotificationTypeMap = MethodToTypeMap<ClientNotification | ServerNotification>;
```

```typescript
// packages/core/src/types/types.ts:2645-2674
// ランタイムスキーマルックアップ: メソッド名からスキーマを取得
function buildSchemaMap<T extends { shape: { method: { value: string } } }>(
    schemas: readonly T[]
): Record<string, T> {
    const map: Record<string, T> = {};
    for (const schema of schemas) {
        const method = schema.shape.method.value;
        map[method] = schema;
    }
    return map;
}

export function getRequestSchema<M extends RequestMethod>(
    method: M
): z.ZodType<RequestTypeMap[M]> {
    return requestSchemas[method] as unknown as z.ZodType<RequestTypeMap[M]>;
}
```

```typescript
// packages/core/src/util/schema.ts:1-23
// スキーマ抽象化層: Zod v4 内部型を抽象名でエクスポート
export type AnySchema = z.core.$ZodType;
export type AnyObjectSchema = z.core.$ZodObject;
export type SchemaInput<T extends AnySchema> = z.input<T>;
export type SchemaOutput<T extends AnySchema> = z.output<T>;

export function schemaToJson(
    schema: AnySchema,
    options?: { io?: 'input' | 'output' }
): Record<string, unknown> {
    return z.toJSONSchema(schema, options) as Record<string, unknown>;
}
```

```typescript
// packages/server/src/server/mcp.ts:1067-1074
// ツールコールバックの条件型: スキーマの有無で引数シグネチャが変わる
export type BaseToolCallback<
    ResultT extends Result,
    Ctx extends ServerContext,
    Args extends AnySchema | undefined
> = Args extends AnySchema
    ? (args: SchemaOutput<Args>, ctx: Ctx) => ResultT | Promise<ResultT>
    : (ctx: Ctx) => ResultT | Promise<ResultT>;

export type ToolCallback<Args extends AnySchema | undefined = undefined> =
    BaseToolCallback<CallToolResult, ServerContext, Args>;
```

```typescript
// packages/core/src/shared/protocol.ts:1454-1465
// 型安全なリクエストハンドラ登録: メソッド名から型を推論
setRequestHandler<M extends RequestMethod>(
    method: M,
    handler: (request: RequestTypeMap[M], ctx: ContextT) => Result | Promise<Result>
): void {
    this.assertRequestHandlerCapability(method);
    const schema = getRequestSchema(method);
    this._requestHandlers.set(method, (request, ctx) => {
        const parsed = schema.parse(request) as RequestTypeMap[M];
        return Promise.resolve(handler(parsed, ctx));
    });
}
```

## パターンカタログ

- **Schema-First Type Derivation** (分類: 生成)
  - 解決する問題: バリデーションロジックと TypeScript 型の二重定義・乖離
  - 適用条件: ワイヤープロトコルや外部入力の型定義が必要な場合
  - コード例: `types.ts:2401-2608`（約120の `Infer<typeof XxxSchema>` 定義）
  - 注意点: スキーマが複雑になると推論型が読みにくくなるため、`Flatten` のような展開ユーティリティが必要

- **Discriminated Method Map** (分類: 構造)
  - 解決する問題: 文字列リテラルによるメソッドディスパッチの型安全性
  - 適用条件: RPC やイベントシステムなど、文字列キーで処理を分岐する場合
  - コード例: `types.ts:2611-2617`（`MethodToTypeMap` 条件型）
  - 注意点: union 型のメンバーに `method` リテラルが必須。動的なメソッド追加には対応不可

- **Schema Abstraction Layer** (分類: 構造 / Adapter)
  - 解決する問題: スキーマライブラリへの直接依存によるロックイン
  - 適用条件: スキーマライブラリのバージョン変更が見込まれる場合、または複数ライブラリのサポートが必要な場合
  - コード例: `util/schema.ts:1-94`（`AnySchema`, `parseSchema`, `schemaToJson` 等）
  - 注意点: 抽象化のコストとして、スキーマライブラリ固有の高度な機能（`z.transform` 等）へのアクセスが制限される場合がある

- **Conditional Signature Pattern** (分類: 振る舞い)
  - 解決する問題: オプショナルなスキーマの有無でコールバックのシグネチャを変える
  - 適用条件: 設定の有無によって関数のインターフェースが変わるビルダー API
  - コード例: `mcp.ts:1067-1074`（`BaseToolCallback` 条件型）
  - 注意点: `undefined` との条件分岐のため、呼び出し側で `as` キャストが必要な箇所がある（`mcp.ts:896`）

## Good Patterns

- **単一ファイルでのスキーマ+型集約**: `types.ts` にすべてのプロトコルスキーマと導出型を集約している。スキーマ定義と型エイリアスが同一ファイルにあるため、新しいメッセージ型の追加時にスキーマを定義すれば型が自動的に得られる。union 型（`ClientRequestSchema`, `ServerRequestSchema` 等）にメンバーを追加すれば `RequestTypeMap` も自動更新される。

```typescript
// packages/core/src/types/types.ts:2401-2410
export type ProgressToken = Infer<typeof ProgressTokenSchema>;
export type Request = Infer<typeof RequestSchema>;
export type JSONRPCRequest = Infer<typeof JSONRPCRequestSchema>;
// ... 約120の型がすべてこのパターン
```

- **型ガード関数のスキーマ活用**: `isJSONRPCRequest`, `isJSONRPCNotification` 等の型ガードを `schema.safeParse(value).success` で実装している。型ガードのロジックをスキーマに委譲することで、型ガードとバリデーションの不一致を構造的に防止している。

```typescript
// packages/core/src/types/types.ts:184
export const isJSONRPCRequest = (value: unknown): value is JSONRPCRequest =>
    JSONRPCRequestSchema.safeParse(value).success;
```

- **`z.looseObject` と `.strict()` の使い分け**: JSON-RPC メッセージスキーマ（`JSONRPCRequestSchema` 等）は `.strict()` で未知フィールドを拒否し、結果型（`ResultSchema`）は `z.looseObject` で拡張フィールドを許容する。プロトコルの厳密性と拡張性を型レベルで表現している。

```typescript
// packages/core/src/types/types.ts:176-182 (strict)
export const JSONRPCRequestSchema = z
    .object({ jsonrpc: z.literal(JSONRPC_VERSION), id: RequestIdSchema, ...RequestSchema.shape })
    .strict();

// packages/core/src/types/types.ts:160 (loose)
export const ResultSchema = z.looseObject({ _meta: RequestMetaSchema.optional() });
```

- **ランタイムスキーマルックアップとジェネリクスの統合**: `getRequestSchema<M>` がジェネリクスで戻り値型を `z.ZodType<RequestTypeMap[M]>` として返すため、ハンドラ登録時に `.parse()` の結果が正しい型に推論される。

```typescript
// packages/core/src/shared/protocol.ts:1459-1463
const schema = getRequestSchema(method);
this._requestHandlers.set(method, (request, ctx) => {
    const parsed = schema.parse(request) as RequestTypeMap[M];
    return Promise.resolve(handler(parsed, ctx));
});
```

## Anti-Patterns / 注意点

- **スキーマと手書き interface の二重管理**: `spec.types.ts` は仕様リポジトリから自動生成された interface 群で、`types.ts` の Zod スキーマとは独立して存在する。これは意図的な設計（仕様の正確な再現 + ランタイムバリデーション）だが、二つの定義が乖離するリスクがある。

```typescript
// Bad: spec.types.ts と types.ts で同じ概念を二つの方法で定義
// spec.types.ts (interface)
export interface CallToolRequest extends JSONRPCRequest { method: 'tools/call'; ... }
// types.ts (Zod schema + Infer)
export const CallToolRequestSchema = RequestSchema.extend({ method: z.literal('tools/call'), ... });
export type CallToolRequest = Infer<typeof CallToolRequestSchema>;

// Better: 一方を信頼できる情報源とし、もう一方を自動テストで検証する
// MCP SDK では spec.types.ts は参照用、types.ts が実際の信頼できる情報源
```

- **条件型コールバックでの型アサーション**: `registerTool` の内部で `cb as ToolCallback<AnySchema | undefined>` のようなアサーションが発生する。条件型（`Args extends AnySchema ? ... : ...`）のエッジでは TypeScript の推論が限界に達するため。

```typescript
// Bad: 内部で as キャストが必要
return this._createRegisteredTool(name, ..., cb as ToolCallback<AnySchema | undefined>);

// Better の代替案は存在するが、この SDK ではユーザー向け API の型推論を優先し、
// 内部の as キャストを許容する設計判断をしている
```

## 導出ルール

- `[MUST]` ワイヤープロトコルのメッセージ型は、ランタイムバリデーションスキーマ（Zod 等）を定義し、TypeScript 型は `z.infer` で導出する。手書き型とスキーマの二重管理は型とバリデーションの乖離を招く
  - 根拠: MCP SDK は約120のプロトコル型すべてを `Infer<typeof XxxSchema>` で導出し、スキーマとの一致を構造的に保証している（`types.ts:2401-2608`）

- `[MUST]` 型ガード関数は手書きの条件分岐ではなく、対応するスキーマの `safeParse` を使って実装する。型ガードの判定条件とスキーマの不一致をコンパイル時に防止できる
  - 根拠: `isJSONRPCRequest`, `isJSONRPCNotification` 等のすべての型ガードが `XxxSchema.safeParse(value).success` で実装されている（`types.ts:184, 196, 215, 264`）

- `[SHOULD]` RPC やイベントシステムでは、メソッド名リテラル型をキーとするマップ型（`MethodToTypeMap`）を定義し、ハンドラ登録 API でメソッド名からリクエスト/レスポンス型を自動推論させる
  - 根拠: `MethodToTypeMap` 条件型と `setRequestHandler<M extends RequestMethod>` のジェネリクスにより、メソッド名の typo や型の不一致がコンパイルエラーになる（`types.ts:2611-2617`, `protocol.ts:1454-1465`）

- `[SHOULD]` スキーマライブラリへの直接依存は抽象型（`AnySchema`, `SchemaOutput` 等）とヘルパー関数（`parseSchema`, `schemaToJson`）で遮蔽する。ライブラリのバージョンアップや移行時の影響範囲を局所化できる
  - 根拠: `util/schema.ts` が Zod v4 の内部型 `z.core.$ZodType` を `AnySchema` としてラップし、SDK 全体がこの抽象層を通じてスキーマ操作を行っている

- `[SHOULD]` JSON-RPC のようなプロトコルメッセージスキーマでは、リクエスト/レスポンスのエンベロープには `.strict()` を、結果のペイロードには `looseObject` / `.loose()` を使い分ける。エンベロープの厳密性とペイロードの拡張性を型レベルで表現できる
  - 根拠: `JSONRPCRequestSchema.strict()` が未知フィールドを拒否する一方、`ResultSchema = z.looseObject(...)` が拡張フィールドを許容している（`types.ts:160, 176-182`）

- `[SHOULD]` コールバックのシグネチャがオプショナルな設定（スキーマの有無など）によって変わる場合は、条件型（`Args extends AnySchema ? (args, ctx) => R : (ctx) => R`）で型推論を提供する
  - 根拠: `BaseToolCallback` 条件型により、`registerTool` でスキーマを渡すとコールバックの第一引数にスキーマ由来の型が推論され、スキーマなしならコンテキストのみのシグネチャになる（`mcp.ts:1067-1074`）

- `[AVOID]` `z.infer` の出力をそのまま公開 API の型として使うこと。Zod の推論結果はネストが深くなりがちで、IDE のホバー情報やエラーメッセージが読みにくくなる。`Flatten` のような再帰的展開ユーティリティを通す
  - 根拠: MCP SDK は `Flatten` 型（`types.ts:2350-2360`）を `z.infer` に適用した `Infer` ヘルパーを定義し、すべての公開型で使用している

## 適用チェックリスト

- [ ] プロトコルメッセージ型が Zod（または同等のスキーマライブラリ）で定義されており、TypeScript 型が `z.infer` で導出されているか
- [ ] 型ガード関数がスキーマの `safeParse` を使って実装されているか（手書きの条件分岐ではなく）
- [ ] RPC / イベントハンドラの登録 API で、メソッド名からリクエスト/レスポンス型が自動推論されるか
- [ ] スキーマライブラリへの依存が抽象型とヘルパー関数で遮蔽されているか
- [ ] `z.infer` の出力が `Flatten` 等で展開され、公開 API の型が可読か
- [ ] プロトコルエンベロープと拡張可能ペイロードで strict / loose の使い分けがされているか
- [ ] コールバックの条件型シグネチャが、スキーマの有無に応じた正しい引数型を推論するか
