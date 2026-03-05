# type-system-patterns

> リポジトリ: anomalyco/opencode
> 分析日: 2026-03-05

## 概要

TypeScript の型システムをどのように活用してランタイム安全性とコードの簡潔さを両立させているかを分析する。opencode は Zod v4 をスキーマの唯一の情報源（Single Source of Truth）として徹底活用し、namespace + 同名型エクスポートによるモジュール構造、ジェネリクスによるツールシステムの型安全なパラメータ伝播など、大規模 TypeScript コードベースで実践的に機能するパターンを豊富に持つ。型注釈を最小化しつつもバリデーション境界を厳密に守る設計方針が注目に値する。

## 背景にある原則

- **Schema-first: スキーマが型と検証の両方を駆動すべき**: 型定義と実行時バリデーションを別々に管理すると乖離する。Zod スキーマを定義し `z.infer<typeof Schema>` で型を導出することで、型とバリデーションの一貫性を構造的に保証する（`packages/opencode/src/session/message-v2.ts` 全体で徹底）
- **明示的な型注釈の最小化**: 型推論で十分な箇所に型注釈を書かない。ジェネリクスの制約と Zod スキーマから型が自動的に伝播するため、冗長な型宣言が不要になる（`packages/util/src/fn.ts:3` の `fn` 関数が代表例）
- **名前空間によるドメイン凝集**: TypeScript の `namespace` を使い、スキーマ・型・関数・エラーをひとつの名前空間にまとめることで、ドメインモデルの発見性と凝集度を高める（`MessageV2`, `Provider`, `Config` 等）
- **バリデーション境界の明確化**: 外部入力（ユーザー入力・API レスポンス・ツール引数）は必ず Zod で parse し、内部では検証済みの型として扱う。`fn()` ユーティリティが「境界でバリデーション、内部は信頼」パターンを自動化する

## 実例と分析

### Zod スキーマからの型導出と同名エクスポートパターン

opencode で最も広範に使われるパターンが、Zod スキーマと同名の型を `export` する手法である。namespace 内で `const Schema = z.object(...)` と `type Schema = z.infer<typeof Schema>` を並べ、TypeScript の「値と型は別の名前空間」という特性を利用して衝突なく共存させる。

```typescript
// packages/opencode/src/permission/next.ts:30-39
export const Rule = z
  .object({
    permission: z.string(),
    pattern: z.string(),
    action: Action,
  })
  .meta({
    ref: "PermissionRule",
  });
export type Rule = z.infer<typeof Rule>;
```

このパターンが `message-v2.ts` では 20 箇所以上、`config.ts` では 15 箇所以上で使われ、プロジェクト全体の型定義の基本形になっている。

### discriminatedUnion による型安全なバリアント管理

多態的なデータ構造には `z.discriminatedUnion` を一貫して使用する。`type` や `status` フィールドをディスクリミネータとし、パターンマッチで安全に分岐する。

```typescript
// packages/opencode/src/session/message-v2.ts:328-332
export const ToolState = z
  .discriminatedUnion("status", [ToolStatePending, ToolStateRunning, ToolStateCompleted, ToolStateError])
  .meta({
    ref: "ToolState",
  });
```

```typescript
// packages/opencode/src/session/message-v2.ts:376-394
export const Part = z
  .discriminatedUnion("type", [
    TextPart,
    SubtaskPart,
    ReasoningPart,
    FilePart,
    ToolPart,
    StepStartPart,
    StepFinishPart,
    SnapshotPart,
    PatchPart,
    AgentPart,
    RetryPart,
    CompactionPart,
  ])
  .meta({ ref: "Part" });
export type Part = z.infer<typeof Part>;
```

`Info` メッセージ型も `role` フィールドで `User | Assistant` を区別し、`error` フィールドも `name` で7種のエラーを区別する。ネストした discriminatedUnion の組み合わせで複雑なドメインモデルを型安全に表現している。

### ジェネリクスによるツール定義の型伝播

`Tool.define` はジェネリクスで Zod スキーマ型を受け取り、`execute` のコールバック引数まで型を自動伝播させる。

```typescript
// packages/opencode/src/tool/tool.ts:27-42
export interface Info<Parameters extends z.ZodType = z.ZodType, M extends Metadata = Metadata> {
  id: string
  init: (ctx?: InitContext) => Promise<{
    description: string
    parameters: Parameters
    execute(
      args: z.infer<Parameters>,
      ctx: Context,
    ): Promise<{
      title: string
      metadata: M
      output: string
    }>
  }>
}

export function define<Parameters extends z.ZodType, Result extends Metadata>(
  id: string,
  init: Info<Parameters, Result>["init"] | Awaited<ReturnType<Info<Parameters, Result>["init"]>>,
): Info<Parameters, Result> { ... }
```

`Tool.define` の第2引数はオブジェクトリテラルも関数も受け付ける共用型 `init | Awaited<ReturnType<init>>` であり、用途に応じた柔軟な呼び出しを可能にしている。さらに条件型 `InferParameters` / `InferMetadata` でツール型から逆引きもできる（`tool.ts:45-46`）。

### バリデーション付き関数ラッパー `fn`

```typescript
// packages/util/src/fn.ts:3-11
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

`fn` は「入力スキーマ + コールバック」から「バリデーション付き関数」を生成するユーティリティである。戻り値には `.force`（バリデーションスキップ）と `.schema`（スキーマ参照）が付与される。`message-v2.ts:731`, `permission/next.ts:131` 等、データアクセス関数の大半がこのラッパーを使用する。

### NamedError: Zod で型安全なエラー階層

```typescript
// packages/util/src/error.ts:7-46
static create<Name extends string, Data extends z.core.$ZodType>(name: Name, data: Data) {
  const schema = z.object({ name: z.literal(name), data })
  const result = class extends NamedError {
    public override readonly name = name as Name
    constructor(public readonly data: z.input<Data>, options?: ErrorOptions) {
      super(name, options)
    }
    static isInstance(input: any): input is InstanceType<typeof result> {
      return typeof input === "object" && "name" in input && input.name === name
    }
    // ...
  }
  return result
}
```

リテラル型 `Name` をジェネリクスで受け取り、`isInstance` 型ガードを自動生成する。エラーの `data` フィールドも Zod で型付けされ、`.toObject()` でシリアライズ可能。`message-v2.ts` では 7 種類のエラーがこのファクトリで定義され、`z.discriminatedUnion("name", [...])` でまとめて扱われる。

### Drizzle ORM と `$type<>` による DB 型マッピング

```typescript
// packages/opencode/src/session/session.sql.ts:50
data: text({ mode: "json" }).notNull().$type<InfoData>(),
```

`$type<T>()` で Drizzle カラムに TypeScript 型を付与し、JSON カラムの入出力を型安全にする。`InfoData` は `Omit<MessageV2.Info, "id" | "sessionID">` として定義され、DB 保存時に不要なフィールドを除外する構造的な型変換を行っている。

### Context による型安全な DI（AsyncLocalStorage ラッパー）

```typescript
// packages/opencode/src/util/context.ts:10-24
export function create<T>(name: string) {
  const storage = new AsyncLocalStorage<T>();
  return {
    use() {
      const result = storage.getStore();
      if (!result) throw new NotFound(name);
      return result;
    },
    provide<R>(value: T, fn: () => R) {
      return storage.run(value, fn);
    },
  };
}
```

ジェネリクス `<T>` で格納する値の型を固定し、`use()` の戻り値が常に `T` となる。`Instance` モジュール（`project/instance.ts`）がこれを使って `directory`, `worktree`, `project` をスコープ付きで提供する。

### BusEvent の型安全なイベントシステム

```typescript
// packages/opencode/src/bus/bus-event.ts:12
export function define<Type extends string, Properties extends ZodType>(type: Type, properties: Properties) {
  return { type, properties };
}
```

```typescript
// packages/opencode/src/bus/index.ts:41-44
export async function publish<Definition extends BusEvent.Definition>(
  def: Definition,
  properties: z.output<Definition["properties"]>,
) { ... }
```

イベント定義時にリテラル型 `Type` と Zod スキーマ `Properties` を捕捉し、`publish` / `subscribe` でイベント名とペイロードの型を一致させる。文字列ベースのイベント名でありながらコンパイル時にペイロード型を検証できる。

## パターンカタログ

- **Abstract Factory** (生成)
  - 解決する問題: エラークラスのボイラープレート削減と型安全なインスタンス検査
  - 適用条件: 同一構造のバリアント型を大量に定義する場面
  - コード例: `packages/util/src/error.ts:7` `NamedError.create()`
  - 注意点: ファクトリの戻り値がクラスそのものであるため、`typeof` と `InstanceType` の使い分けに注意

- **Typed Event Channel** (振る舞い)
  - 解決する問題: pub/sub イベントシステムでのペイロード型の保証
  - 適用条件: イベント駆動アーキテクチャで型安全性を維持したい場面
  - コード例: `packages/opencode/src/bus/bus-event.ts:12`, `packages/opencode/src/bus/index.ts:41`
  - 注意点: `z.output` と `z.infer` の使い分けに注意（transform がある場合に差が出る）

## Good Patterns

- **Schema = Type + Validation の統一**: `const X = z.object({...})` と `type X = z.infer<typeof X>` を対にすることで、型定義とバリデーションの乖離を原理的に防止する。opencode では `message-v2.ts` に 20 箇所以上の適用例があり、コードベース全体の標準パターンとなっている。

- **`.meta({ ref: "..." })` による OpenAPI スキーマ生成**: Zod スキーマに `.meta()` で参照名を付与し、API スキーマの自動生成に利用する。型定義とドキュメントの二重管理を排除する。

```typescript
// packages/opencode/src/session/message-v2.ts:86-91
export const SnapshotPart = PartBase.extend({
  type: z.literal("snapshot"),
  snapshot: z.string(),
}).meta({
  ref: "SnapshotPart",
});
```

- **`satisfies` による型検証付きオブジェクトリテラル**: `as` ではなく `satisfies` を使うことで、型の安全な検証と推論の保持を両立する。

```typescript
// packages/opencode/src/agent/agent.ts:319
} satisfies Parameters<typeof generateObject>[0]
```

- **`Omit` による DB 保存用型の導出**: 保存時に不要なフィールドを `Omit` で構造的に除外し、ドメイン型と永続化型の関係を型レベルで明示する。

```typescript
// packages/opencode/src/session/session.sql.ts:8-9
type PartData = Omit<MessageV2.Part, "id" | "sessionID" | "messageID">;
type InfoData = Omit<MessageV2.Info, "id" | "sessionID">;
```

## Anti-Patterns / 注意点

- **`any` の漏出**: プロジェクトスタイルガイドで `any` 回避を推奨しているが、一部で `Metadata` インターフェースの `[key: string]: any` やマイグレーションコード内の `readJson<any>` が残存する。`unknown` + 型ガードに置き換えるべき場面がある。

```typescript
// Bad: packages/opencode/src/tool/tool.ts:9
interface Metadata {
  [key: string]: any;
}

// Better:
interface Metadata {
  [key: string]: unknown;
}
```

- **`as` キャストによる型安全性の迂回**: DB からの読み出し時に `as MessageV2.Part`, `as MessageV2.Info` でキャストしている箇所がある。Zod parse を通していないため、スキーマ変更時にランタイムエラーになるリスクがある。

```typescript
// Bad: packages/opencode/src/session/message-v2.ts:764
const part = { ...row.data, id: row.id, ... } as MessageV2.Part

// Better: Zod parse を挟む、または DB マイグレーションで整合性を保証
const part = MessageV2.Part.parse({ ...row.data, id: row.id, ... })
```

## 導出ルール

- `[MUST]` 外部境界（API 入力・ツール引数・設定ファイル読み込み）では Zod スキーマで parse し、内部では推論された型を信頼する
  - 根拠: `fn()` ラッパーと `Tool.define` が全ツール引数を `schema.parse(args)` で検証している（`packages/opencode/src/tool/tool.ts:59`, `packages/util/src/fn.ts:5`）

- `[MUST]` ドメインモデルの型は Zod スキーマから `z.infer<typeof Schema>` で導出し、手動の型定義と二重管理しない
  - 根拠: `message-v2.ts`, `config.ts`, `provider.ts` 等で 50 箇所以上が一貫してこのパターンを適用し、型とバリデーションの乖離を防止している

- `[SHOULD]` 多態的なデータには `z.discriminatedUnion` を使い、ディスクリミネータフィールドでバリアントを識別する
  - 根拠: `ToolState`（status 分岐）、`Part`（type 分岐）、`Info`（role 分岐）等、15 箇所以上で一貫して使用され、パターンマッチの型安全性を保証している

- `[SHOULD]` ジェネリクスの制約に Zod スキーマ型を使い、スキーマ→引数型→戻り値型の自動伝播チェーンを構築する
  - 根拠: `Tool.Info<Parameters extends z.ZodType>` が `execute(args: z.infer<Parameters>)` まで型を伝播させ、各ツール実装で明示的な型注釈なしに型安全を実現している

- `[SHOULD]` namespace + 同名エクスポート（値と型）を使い、関連する定数・型・関数をドメイン単位で凝集させる
  - 根拠: `MessageV2`, `Provider`, `Config`, `PermissionNext` 等 40 以上の namespace が一貫してこのパターンを採用し、import の簡潔さとドメインの発見性を両立している

- `[AVOID]` DB から読み出した JSON を `as T` でキャストする — Zod parse を通すか、マイグレーションでスキーマ整合性を保証する
  - 根拠: `message-v2.ts:764,772` で `as MessageV2.Part` / `as MessageV2.Info` が使われているが、スキーマ変更時の静的検出が不可能になる

## 適用チェックリスト

- [ ] 外部入力を受け取るすべての関数で Zod スキーマによるバリデーションが行われているか
- [ ] 型定義が Zod スキーマから `z.infer` で導出されており、手動の `interface` / `type` と二重管理になっていないか
- [ ] 多態的なデータ構造に `discriminatedUnion` を使い、ディスクリミネータフィールドを明示しているか
- [ ] ジェネリクスを使う関数で、型パラメータが呼び出し側まで自動伝播するか（明示的な型引数の指定が不要か）
- [ ] DB の JSON カラムに `$type<T>()` で型を付与し、ドメイン型との関係を `Omit` / `Pick` で明示しているか
- [ ] イベントシステムでペイロード型がコンパイル時に検証されるか（`BusEvent.define` + ジェネリクスの活用）
- [ ] `any` 型が境界部分以外に漏出していないか — `unknown` + 型ガードで代替できないか検証する
