# 拡張性メカニズム (Extensibility Mechanisms)

> リポジトリ: Effect-TS/effect
> 分析日: 2026-02-18

## 概要

Effect-TS/effect は、プラットフォームアダプター（Node/Bun/Browser）、SQL ドライバ抽象化（PostgreSQL/MySQL/SQLite/MSSQL 等 10+ バックエンド）、RPC トランスポート、OpenTelemetry 統合など、大規模な拡張ポイントを持つモノレポである。これらすべてが `Context.Tag` + `Layer` による依存性注入と `interface` ベースのサービス契約に基づいて設計されている。従来のプラグインレジストリや抽象クラスではなく、型レベルで依存関係を追跡する関数型 DI が拡張の根幹をなす点が注目に値する。

## 背景にある原則

- **サービスインターフェースと実装の分離を型レベルで強制すべき、なぜならコンパイル時に未提供の依存を検出できるから**: `Context.Tag<Id, Service>` でサービス識別子を定義し、`Effect<A, E, R>` の `R` 型パラメータで必要なサービスを型レベルで追跡する。実装は `Layer` で提供し、型が合わなければコンパイルエラーになる（`packages/effect/src/Context.ts:36-51`、`packages/effect/src/Layer.ts:1-18`）。

- **抽象インターフェースはプラットフォーム非依存パッケージに置き、具象実装はプラットフォーム固有パッケージに分離すべき、なぜなら利用者コードがプラットフォーム詳細に依存しなくなるから**: `@effect/platform` が `FileSystem`, `HttpClient`, `HttpServer`, `CommandExecutor` 等のインターフェースを定義し、`@effect/platform-node`, `@effect/platform-bun`, `@effect/platform-browser` がそれぞれの実装を提供する。利用者は抽象 Tag に対してプログラムを書き、起動時にプラットフォーム Layer を差し替えるだけでよい。

- **ドライバ層はベースインターフェースと専用インターフェースの両方を同時に提供すべき、なぜなら汎用コードと専用機能の両立が可能になるから**: 全 SQL ドライバが `SqlClient` Tag と専用 Tag（`PgClient`, `MysqlClient` 等）の両方を Context に登録する。汎用的な CRUD ロジックは `SqlClient` に、PostgreSQL 固有の `LISTEN/NOTIFY` は `PgClient` に依存する。

- **拡張ポイントはコンパイラ・パーサー等の戦略オブジェクトとして注入すべき、なぜならバックエンド固有のロジックを差し替え可能な単位に分解できるから**: SQL の `Compiler` インターフェースは `placeholder`, `onIdentifier`, `onCustom` 等の戦略関数を受け取る `makeCompiler` で構成される。各ドライバは自身の SQL 方言に合わせた戦略を渡すだけでよい。

## 実例と分析

### プラットフォームアダプターの階層構造

`@effect/platform` パッケージが抽象サービスのインターフェースと Tag を定義し、プラットフォーム固有パッケージが実装を Layer として提供する。各プラットフォームは「Context」型（`NodeContext`, `BunContext`）でプラットフォーム全体の Layer をバンドルする。

`NodeContext` と `BunContext` は同じ型を提供する:

```
CommandExecutor | FileSystem | Path | Terminal | Worker.WorkerManager
```

しかし実装は完全に異なる。`NodeContext.layer` は `NodeFileSystem.layer`, `NodeCommandExecutor.layer` 等を合成し、`BunContext.layer` は対応する Bun 実装を合成する。利用者コードは `FileSystem` や `CommandExecutor` の Tag にのみ依存するため、起動時の Layer 差し替えで完全にプラットフォームを切り替えられる。

### SQL ドライバの dual-tag パターン

全 SQL ドライバの `layer` 関数が、汎用 `SqlClient` と具象クライアントの **両方** を Context に登録する:

```typescript
// packages/sql-pg/src/PgClient.ts:550-558
export const layer = (
  config: PgClientConfig
): Layer.Layer<PgClient | Client.SqlClient, SqlError> =>
  Layer.scopedContext(
    Effect.map(make(config), (client) =>
      Context.make(PgClient, client).pipe(
        Context.add(Client.SqlClient, client)
      ))
  ).pipe(Layer.provide(Reactivity.layer))
```

この同一パターンは `MysqlClient`, `SqliteClient`, `MssqlClient`, `ClickhouseClient`, `LibsqlClient`, `D1Client` 等の全ドライバで一貫して適用されている。

### SQL Compiler の Strategy パターン

`Statement.makeCompiler` は方言固有のロジックを戦略関数として受け取る:

```typescript
// packages/sql/src/Statement.ts:426-455
export const makeCompiler: <C extends Custom<any, any, any, any> = any>(
  options: {
    readonly dialect: Dialect
    readonly placeholder: (index: number, value: unknown) => string
    readonly onIdentifier: (value: string, withoutTransform: boolean) => string
    readonly onRecordUpdate: (...) => readonly [sql: string, params: ...]
    readonly onCustom: (type: C, placeholder: ..., withoutTransform: boolean) => ...
    readonly onInsert?: (...) => ...
  }
) => Compiler
```

各ドライバが自身の方言に合わせた戦略を渡す:

```typescript
// packages/sql-pg/src/PgClient.ts:586-618
Statement.makeCompiler<PgCustom>({
  dialect: "pg",
  placeholder(_) { return `$${_}` },
  onIdentifier: transform ? ... : escape,
  onRecordUpdate(...) { ... },
  onCustom(type, placeholder, withoutTransform) {
    switch (type.kind) {
      case "PgJson": { ... }
    }
  }
})
```

一方 MySQL は異なるプレースホルダー構文を使う:

```typescript
// packages/sql-mysql2/src/MysqlClient.ts:307-324
Statement.makeCompiler({
  dialect: "mysql",
  placeholder(_) { return `?` },
  onIdentifier: transform ? ... : escape,
  onCustom() { return ["", []] },
  onRecordUpdate() { return ["", []] }
})
```

### RPC のトランスポート抽象化

RPC は `Protocol` Tag でトランスポートを抽象化する。`RpcClient.Protocol` は `run`, `send`, `supportsAck`, `supportsTransferables` の 4 プロパティからなるサービスインターフェースで、具体的なプロトコル実装（HTTP, WebSocket, Worker）を差し替え可能にする:

```typescript
// packages/rpc/src/RpcClient.ts:816-831
export class Protocol extends Context.Tag("@effect/rpc/RpcClient/Protocol")<Protocol, {
  readonly run: (f: (data: FromServerEncoded) => Effect.Effect<void>) => Effect.Effect<never>
  readonly send: (request: FromClientEncoded, ...) => Effect.Effect<void, RpcClientError>
  readonly supportsAck: boolean
  readonly supportsTransferables: boolean
}>() { ... }
```

同様にシリアライゼーションも `RpcSerialization` Tag で抽象化され、JSON, NDJSON, MessagePack を差し替え可能にしている。

### HttpPlatform のファクトリーパターン

`HttpPlatform.make` はプラットフォーム固有の file response ロジックを受け取り、共通の HttpPlatform サービスを構築する:

```typescript
// packages/platform-node/src/internal/httpPlatform.ts:13-39
export const make = Platform.make({
  fileResponse(path, status, statusText, headers, start, end, contentLength) {
    const stream = Fs.createReadStream(path, { start, end })
    return ServerResponse.raw(stream, { ... })
  },
  fileWebResponse(file, status, statusText, headers, _options) {
    return ServerResponse.raw(Readable.fromWeb(file.stream() as any), { ... })
  }
})
```

Bun 版は同じインターフェースに対して `Bun.file()` を使う:

```typescript
// packages/platform-bun/src/internal/httpPlatform.ts:8-19
export const make = Platform.make({
  fileResponse(path, status, statusText, headers, start, end, _contentLength) {
    let file = Bun.file(path)
    if (start > 0 || end !== undefined) { file = file.slice(start, end) }
    return ServerResponse.raw(file, { headers, status, statusText })
  },
  ...
})
```

### OpenTelemetry のブリッジパターン

Effect コアが定義する `Tracer` インターフェース（`packages/effect/src/Tracer.ts:26-38`）を、`@effect/opentelemetry` パッケージの `OtelSpan` クラスが実装する。Effect の `Span` を OpenTelemetry の `Span` にブリッジし、両方の API を自然に使えるようにしている:

```typescript
// packages/opentelemetry/src/internal/tracer.ts:42-65
export class OtelSpan implements EffectTracer.Span {
  readonly span: OtelApi.Span
  readonly spanId: string
  readonly traceId: string
  ...
}
```

### 第三者 ORM 統合（sql-drizzle, sql-kysely）

既存の ORM を Effect SQL 抽象化に統合するアダプターパッケージも、同じ Tag/Layer パターンに従う:

```typescript
// packages/sql-drizzle/src/Pg.ts:20-47
export const make = <TSchema extends Record<string, unknown>>(
  config?: Omit<DrizzleConfig<TSchema>, "logger">
): Effect.Effect<PgRemoteDatabase<TSchema>, never, Client.SqlClient> =>
  Effect.gen(function*() {
    const db = drizzle(yield* makeRemoteCallback, config)
    return db
  })

export class PgDrizzle extends Context.Tag("@effect/sql-drizzle/Pg")<
  PgDrizzle, PgRemoteDatabase
>() {}

export const layer: Layer.Layer<PgDrizzle, never, Client.SqlClient> =
  Layer.effect(PgDrizzle, make())
```

`SqlClient` を要求する Layer として定義されているため、どの SQL ドライバとも組み合わせ可能である。

## コード例

```typescript
// packages/platform-node/src/NodeContext.ts:32-40
// NodeContext: プラットフォーム固有の Layer バンドル
export const layer: Layer.Layer<NodeContext> = pipe(
  Layer.mergeAll(
    NodePath.layer,
    NodeCommandExecutor.layer,
    NodeTerminal.layer,
    NodeWorker.layerManager
  ),
  Layer.provideMerge(NodeFileSystem.layer)
)
```

```typescript
// packages/sql/src/SqlClient.ts:78
// SqlClient Tag: 全ドライバの共通インターフェース
export const SqlClient: Tag<SqlClient, SqlClient> = internal.clientTag
```

```typescript
// packages/sql-pg/src/PgClient.ts:52-58
// PgClient: 汎用 SqlClient を拡張した専用インターフェース
export interface PgClient extends Client.SqlClient {
  readonly [TypeId]: TypeId
  readonly config: PgClientConfig
  readonly json: (_: unknown) => Fragment
  readonly listen: (channel: string) => Stream.Stream<string, SqlError>
  readonly notify: (channel: string, payload: string) => Effect.Effect<void, SqlError>
}
```

```typescript
// packages/rpc/src/RpcSerialization.ts:14-18
// RpcSerialization: シリアライゼーション戦略の Tag
export class RpcSerialization extends Context.Tag("@effect/rpc/RpcSerialization")<RpcSerialization, {
  unsafeMake(): Parser
  readonly contentType: string
  readonly includesFraming: boolean
}>() {}
```

```typescript
// packages/sql/src/Statement.ts:340-356
// SQL の方言分岐: コンパイラが提供する onDialect メソッド
readonly onDialect: <A, B, C, D, E>(options: {
  readonly sqlite: () => A
  readonly pg: () => B
  readonly mysql: () => C
  readonly mssql: () => D
  readonly clickhouse: () => E
}) => A | B | C | D | E
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: SQL 方言ごとに異なるプレースホルダー構文・エスケープ・カスタム型の処理
  - 適用条件: 同一アルゴリズムの一部ステップがバリエーション間で異なる場合
  - コード例: `packages/sql/src/Statement.ts:426-455`（`makeCompiler`）
  - 注意点: 戦略インターフェースを小さく保つこと。Effect では関数の集合として表現される

- **Abstract Factory パターン** (分類: 生成)
  - 解決する問題: プラットフォーム固有のサービス群（FileSystem, HttpServer 等）を一括生成
  - 適用条件: 複数の関連サービスをプラットフォームごとにまとめて切り替える場合
  - コード例: `packages/platform-node/src/NodeContext.ts:32-40`（`NodeContext.layer`）
  - 注意点: Effect では Layer の合成（`Layer.mergeAll`, `Layer.provideMerge`）がファクトリーの役割を果たす

- **Adapter パターン** (分類: 構造)
  - 解決する問題: 外部ライブラリ（Drizzle, Kysely, OpenTelemetry API）を Effect の Tag/Layer システムに統合
  - 適用条件: 既存のサードパーティ API を Effect のサービス抽象化に組み込む場合
  - コード例: `packages/sql-drizzle/src/Pg.ts:20-47`、`packages/opentelemetry/src/internal/tracer.ts:42-65`
  - 注意点: アダプターは薄いラッパーにとどめ、元の API のセマンティクスを変えない

- **Bridge パターン** (分類: 構造)
  - 解決する問題: 抽象化（`SqlClient`）と実装（`PgClient`, `MysqlClient`）を独立に拡張可能にする
  - 適用条件: 抽象化と実装の直交するバリエーションがある場合（N 個のインターフェース x M 個のバックエンド）
  - コード例: `packages/sql/src/SqlClient.ts` + `packages/sql-pg/src/PgClient.ts`
  - 注意点: dual-tag パターンで汎用 Tag と具象 Tag の両方を提供することで、汎用コードと具象コードの共存を実現

## Good Patterns

- **dual-tag 登録**: ドライバ Layer が汎用 Tag と具象 Tag の両方を Context に登録することで、利用者は抽象レベルでも具象レベルでもサービスにアクセスできる。全 10+ SQL ドライバで一貫して適用されている。

```typescript
// packages/sql-pg/src/PgClient.ts:554-558
Context.make(PgClient, client).pipe(
  Context.add(Client.SqlClient, client)
)
```

- **ファクトリー関数による実装注入**: `HttpPlatform.make` のように、プラットフォーム固有のロジックだけを関数オブジェクトとして渡し、共通処理はファクトリー内で行う。これにより実装側のコードが最小限になる。

```typescript
// packages/platform-bun/src/internal/httpPlatform.ts:8-19
export const make = Platform.make({
  fileResponse(path, status, statusText, headers, start, end, _contentLength) {
    let file = Bun.file(path)
    if (start > 0 || end !== undefined) { file = file.slice(start, end) }
    return ServerResponse.raw(file, { headers, status, statusText })
  },
  fileWebResponse(file, status, statusText, headers, _options) {
    return ServerResponse.raw(file, { headers, status, statusText })
  }
})
```

- **Statement Transformer による横断的関心事の注入**: `FiberRef` ベースの `Statement.Transformer` で、SQL 文の実行前にアクセス制御やロギング等のクロスカッティングな処理を注入できる。Layer として設定可能なため、テスト時の差し替えも容易。

```typescript
// packages/sql/src/Statement.ts:80-107
export const currentTransformer: FiberRef<Option<Statement.Transformer>> = internal.currentTransformer
export const setTransformer: (f: Statement.Transformer) => Layer<never> = internal.setTransformer
```

## Anti-Patterns / 注意点

- **具象 Tag のみ登録して汎用 Tag を忘れる**: SQL ドライバの Layer で `PgClient` のみ登録し `SqlClient` を登録しないと、汎用コード（Migrator 等）が `SqlClient` を要求した際にコンパイルエラーにならず実行時エラーとなる可能性がある。

```typescript
// Bad: 汎用 Tag を登録していない
Layer.scopedContext(
  Effect.map(make(config), (client) =>
    Context.make(PgClient, client)  // SqlClient が欠落
  )
)

// Better: 両方登録する
Layer.scopedContext(
  Effect.map(make(config), (client) =>
    Context.make(PgClient, client).pipe(
      Context.add(Client.SqlClient, client)
    ))
)
```

- **インターフェースにプラットフォーム固有の型を含める**: 抽象インターフェース（`@effect/platform` 側）に `node:fs` や `Bun.file` 等の型を含めると、プラットフォーム非依存性が壊れる。Effect では抽象レベルのインターフェースは Effect 固有の型（`Effect`, `Stream`, `Scope` 等）のみで構成されている。

```typescript
// Bad: 抽象インターフェースに Node 固有型
interface FileSystem {
  readonly readFile: (path: string) => fs.ReadStream  // Node 依存
}

// Better: Effect 型で統一
interface FileSystem {
  readonly readFile: (path: string) => Stream<Uint8Array, PlatformError>
}
```

- **戦略関数を巨大なオブジェクトにまとめすぎる**: `makeCompiler` は 6 つの戦略関数を受け取るが、うち `onInsert` と `onRecordUpdateSingle` はオプショナルでデフォルト実装を持つ。必須の戦略を最小限にし、カスタマイズポイントをオプショナルにすることで、新しいドライバの実装コストを下げている。

## 導出ルール

- `[MUST]` マルチバックエンドのサービス抽象化では、汎用 Tag と具象 Tag の両方を同時に提供する Layer を作成する
  - 根拠: Effect-TS の全 SQL ドライバ（10+パッケージ）が `Context.make(SpecificClient, client).pipe(Context.add(SqlClient, client))` パターンを一貫して適用しており、これにより汎用コードと具象コードの共存が型安全に実現されている

- `[MUST]` プラットフォーム抽象化のインターフェースにはランタイム固有の型（`node:fs`, `Bun.*` 等）を含めず、フレームワーク自身の型のみで構成する
  - 根拠: `@effect/platform` の `FileSystem`, `HttpClient`, `CommandExecutor` 等のインターフェースは全て Effect の `Effect`/`Stream`/`Scope` 型のみで定義されており、プラットフォーム固有型は `platform-node`/`platform-bun` の内部実装にのみ出現する

- `[SHOULD]` バックエンド固有のロジックは、抽象クラスの継承ではなく、戦略関数の集合（Strategy パターン）としてファクトリーに渡す
  - 根拠: `Statement.makeCompiler` は `placeholder`, `onIdentifier`, `onCustom` 等の関数集合を受け取り、各 SQL 方言の差異を吸収している。クラス継承と比べ、個別の戦略だけ差し替えたり合成したりする柔軟性が高い

- `[SHOULD]` サードパーティライブラリの統合は、元の API を薄くラップするアダプター Layer として実装し、元のセマンティクスを変更しない
  - 根拠: `sql-drizzle` は Drizzle ORM の `drizzle()` をそのまま呼び出し、`SqlClient` から接続を取得するコールバックだけを注入する。ORM 自体のクエリビルダーや型推論はそのまま利用者に公開される

- `[SHOULD]` プラットフォーム全体のサービス群は、個別 Layer を合成した「Context バンドル Layer」として提供する
  - 根拠: `NodeContext.layer` と `BunContext.layer` は同じサービス型のユニオンを提供する Layer であり、利用者は1行の Layer 差し替えでプラットフォームを切り替えられる

- `[AVOID]` 拡張ポイントの戦略インターフェースに必須メソッドを増やしすぎる。オプショナルにできるメソッドはデフォルト実装を持たせる
  - 根拠: `makeCompiler` の `onInsert` と `onRecordUpdateSingle` はオプショナルで、大半のドライバは指定しない。新しいバックエンドを追加する際の実装コストが最小化されている

## 適用チェックリスト

- [ ] サービスのインターフェース（Tag）とプラットフォーム固有の実装（Layer）が別パッケージ・別モジュールに分離されているか
- [ ] マルチバックエンド構成で、汎用 Tag と具象 Tag の dual-tag 登録パターンを適用しているか
- [ ] 抽象インターフェースにプラットフォーム固有の型が漏れていないか（`node:*`, `Bun.*` 等）
- [ ] バックエンド固有のロジックが戦略関数として注入可能になっているか（クラス継承ではなく関数合成）
- [ ] 戦略インターフェースの必須メソッドが最小限に抑えられ、オプショナルなカスタマイズポイントにはデフォルト実装があるか
- [ ] サードパーティ統合が薄いアダプター Layer として実装され、元ライブラリの API セマンティクスを保持しているか
- [ ] プラットフォーム全体のサービス群を「Context バンドル Layer」として1つにまとめ、利用者が1行で切り替えられるようになっているか
- [ ] 横断的関心事（ロギング、アクセス制御等）が FiberRef やミドルウェア Layer で注入可能になっているか
