# error-handling-idioms

> リポジトリ: Effect-TS/effect
> 分析日: 2026-02-18

## 概要

Effect-TS は「ロスレスなエラーモデル」を設計原則とし、エラー情報を一切捨てない型安全なエラーチャネルを構築している。`Effect<A, E, R>` の `E` パラメータにより、発生しうるエラーの型が関数シグネチャに刻まれ、`Cause` データ型が期待エラー（Fail）・予期せぬ欠陥（Die）・中断（Interrupt）・並列/逐次合成を構造化して保持する。この視点では、エラーの分類体系、タグベースのディスパッチ、エラー境界の設計パターン、そしてリカバリ戦略を横断的に分析し、他の型安全言語・フレームワークに応用可能なプラクティスを抽出する。

## 背景にある原則

- **エラー情報は決して捨てない（Lossless Error Model）**: 複数のエラーが並列・逐次に発生した場合でも、`Cause` のツリー構造（`Parallel`, `Sequential`）で全情報を保持する。一般的な `try-catch` では最初の例外だけが残り後続が失われるが、Effect-TS は全経路のエラーを構造化して保存する。根拠: `Cause.ts:1-22` のモジュールドキュメントに「lossless error model」と明記されている。

- **期待エラーと欠陥を型レベルで分離する**: `Fail<E>` は回復可能なドメインエラー、`Die` は回復不能なバグや予期せぬ例外として分離される。`Die.defect` は `unknown` 型で型追跡されず、`Fail.error` は `E` 型で追跡される。この分離により「何が回復可能で何がバグか」がコンパイル時に判別できる。根拠: `Cause.ts:460-497` の `Fail` と `Die` の型定義。

- **エラー型はタグで識別し、型レベルで絞り込む**: エラー型に `_tag` リテラル型を持たせることで、`catchTag` が型安全にエラーをディスパッチし、ハンドル済みのエラーを型から除去する。これはパターンマッチの TypeScript 実装であり、エラーの網羅性チェックを型システムに委ねる。根拠: `Effect.ts:3882-3890` の `catchTag` 型シグネチャで `Exclude<E, { _tag: K }>` によりハンドル済みエラーが型から消える。

- **エラー境界は明示的に宣言する**: `orDie` で期待エラーを欠陥に変換する操作、`sandbox` で欠陥を期待エラーに引き上げる操作が対称的に提供されている。境界の位置を開発者が意図的に選ぶことで、「ここから先は回復しない」という設計判断がコードに表現される。根拠: `Effect.ts:11265` の `orDie` と `Effect.ts:4246` の `sandbox`。

## 実例と分析

### Cause のツリー構造による並列エラー保持

`Cause` は6つのバリアントから成る再帰的なデータ型で、エラーの発生パターンを構造として保持する:

```typescript
// packages/effect/src/Cause.ts:254-260
export type Cause<E> =
  | Empty
  | Fail<E>
  | Die
  | Interrupt
  | Sequential<E>
  | Parallel<E>
```

`Parallel` は並行実行で複数エラーが同時発生した場合に両方を保持し、`Sequential` はメイン処理の失敗とファイナライザの失敗を連鎖保持する。`CauseReducer` インタフェース（`Cause.ts:296-303`）により、この再帰構造を任意の型に畳み込める。

### TaggedError による型安全なエラー定義

`Data.TaggedError` と `Schema.TaggedError` の2つのエラー定義パターンがコードベース全体で一貫して使われている:

```typescript
// packages/sql/src/Migrator.ts:57-67
export class MigrationError extends Data.TaggedError("MigrationError")<{
  readonly _tag: "MigrationError"
  readonly cause?: unknown
  readonly reason:
    | "bad-state"
    | "import-error"
    | "failed"
    | "duplicates"
    | "locked"
  readonly message: string
}> {}
```

```typescript
// packages/platform/src/Multipart.ts:145-160
export class MultipartError extends Schema.TaggedError<MultipartError>()("MultipartError", {
  reason: Schema.Literal("FileTooLarge", "FieldTooLarge", "BodyTooLarge",
    "TooManyParts", "InternalError", "Parse"),
  cause: Schema.Defect
}) {
  readonly [ErrorTypeId]: ErrorTypeId = ErrorTypeId
  get message(): string {
    return this.reason
  }
}
```

`Data.TaggedError` は軽量な定義向け、`Schema.TaggedError` はシリアライズ境界を超える場合（RPC、永続化）に使われる。どちらも `_tag` フィールドを自動付与し、`YieldableError` を継承するため `yield*` でそのまま Effect に変換できる。

### reason フィールドによるサブ分類パターン

エラー型に `reason` フィールドを持たせ、同一 `_tag` 内でエラーの原因を文字列リテラルユニオンで細分化するパターンがコードベース全体で統一されている:

```typescript
// packages/platform/src/HttpClientError.ts:38-43
export class RequestError extends Error.TypeIdError(TypeId, "RequestError")<{
  readonly request: ClientRequest.HttpClientRequest
  readonly reason: "Transport" | "Encode" | "InvalidUrl"
  readonly cause?: unknown
  readonly description?: string
}> { ... }
```

```typescript
// packages/platform/src/Socket.ts:140-143
export class SocketGenericError extends TypeIdError(SocketErrorTypeId, "SocketError")<{
  readonly reason: "Write" | "Read" | "Open" | "OpenTimeout"
  readonly cause: unknown
}> { ... }
```

`_tag` がエラーの「種類」、`reason` がエラーの「原因」を表す二層分類。`_tag` は `catchTag` でディスパッチし、`reason` は `catchTag` 後のハンドラ内で分岐する。

### catchTag による型安全エラーディスパッチ

```typescript
// packages/platform/src/Multipart.ts:551-554
}).pipe(
  Effect.catchTags({
    SystemError: (cause) => Effect.fail(new MultipartError({ reason: "InternalError", cause })),
    BadArgument: (cause) => Effect.fail(new MultipartError({ reason: "InternalError", cause }))
  })
)
```

`catchTags` は複数のエラー型を一括でハンドルし、型レベルで処理済みエラーを除去する。上記では `SystemError | BadArgument` が `MultipartError` に変換され、呼び出し側のエラー型から消える。

### エラー境界パターン: catchTag + die による不正状態の昇格

```typescript
// packages/workflow/src/DurableQueue.ts:204-208
    } as any, { id }).pipe(
      Effect.tapErrorCause(Effect.logWarning),
      Effect.catchTag("ParseError", Effect.die),
      Effect.retry(options?.retrySchedule ?? defaultRetrySchedule),
      Effect.orDie,
```

`ParseError` はデータ不整合を示すためリトライしても意味がなく、即座に `die` で欠陥に昇格させる。その後の `retry` は `ParseError` 以外のエラー（ネットワーク障害等）に対してのみ適用される。最終的に `orDie` で残りのエラーも欠陥化し、型を `Effect<A, never, R>` にする。

### エラー翻訳パターン: mapError による境界変換

```typescript
// packages/sql/src/SqlEventJournal.ts:158-161
    entries: sql`SELECT * FROM ${sql(entryTable)} ORDER BY timestamp ASC`.withoutTransform.pipe(
      Effect.flatMap(decodeEntrySqlArray),
      Effect.mapError((cause) => new EventJournal.EventJournalError({ cause, method: "entries" }))
    ),
```

低レベルの `SqlError` を高レベルの `EventJournalError` にラップする。`cause` フィールドに元のエラーを保持することで情報のロスレス性を維持しつつ、呼び出し側には抽象化されたエラー型のみを公開する。このパターンは `SqlEventJournal.ts` 全体で7箇所に適用されている。

### Effect.try による同期例外のキャプチャ

```typescript
// packages/platform/src/MsgPack.ts:70-72
                Effect.try({
                  try: () => Chunk.of(packr.pack(Chunk.toReadonlyArray(input))),
                  catch: (cause) => new MsgPackError({ reason: "Pack", cause })
                }),
```

`Effect.try` は同期的な例外をキャッチして型付きエラーに変換する。`catch` コールバックで具体的なエラー型を生成するため、`unknown` が型チャネルに漏れることを防ぐ。

### message getter パターン

エラークラスに `get message()` を定義し、構造化されたフィールドから人間向けメッセージを生成するパターンが統一されている:

```typescript
// packages/platform/src/HttpClientError.ts:48-52
  get message() {
    return this.description ?
      `${this.reason}: ${this.description} (${this.methodAndUrl})` :
      `${this.reason} error (${this.methodAndUrl})`
  }
```

## パターンカタログ

- **Discriminated Union** (分類: 構造)
  - 解決する問題: エラー型のパターンマッチと網羅性チェック
  - 適用条件: 複数のエラー型を統一的にハンドルする場合
  - コード例: `Cause.ts:254-260`（Cause 型）、`HttpServerError.ts:31`（HttpServerError 型）
  - 注意点: `_tag` フィールドは文字列リテラル型でなければならない

- **Composite パターン** (分類: 構造)
  - 解決する問題: 並列・逐次で発生する複数エラーの情報保持
  - 適用条件: 並行処理やファイナライザでエラーが複合発生する場合
  - コード例: `Cause.ts:535-560`（`Parallel`, `Sequential`）
  - 注意点: ツリーの深さが増すため、`reduceWithContext` で畳み込む仕組みが必要

- **Adapter パターン** (分類: 構造)
  - 解決する問題: 低レベルエラーを高レベルのドメインエラーに変換
  - 適用条件: モジュール境界でエラーの抽象度を揃える場合
  - コード例: `SqlEventJournal.ts:160`、`Multipart.ts:551-554`
  - 注意点: 元のエラーを `cause` フィールドに保持しないと情報が失われる

## Good Patterns

- **Tag + Reason 二層分類**: `_tag` でエラーの種類を識別し、`reason` で原因を細分化する。`_tag` は型レベルのディスパッチに使い、`reason` はハンドラ内のロジック分岐に使う。エラー型の増殖を防ぎつつ十分な表現力を維持する。

```typescript
// packages/platform/src/HttpClientError.ts:38-43
class RequestError extends Error.TypeIdError(TypeId, "RequestError")<{
  readonly reason: "Transport" | "Encode" | "InvalidUrl"
  readonly cause?: unknown
  readonly description?: string
}>
```

- **YieldableError による generator 統合**: `YieldableError` を継承したエラーは `commit()` メソッドで `Effect.fail(this)` を返すため、`yield*` でそのまま失敗 Effect として使える。エラーの生成と発出が一体化し、ボイラープレートが減る。

```typescript
// packages/effect/src/internal/core.ts:2230-2234
class YieldableError extends globalThis.Error {
  commit() {
    return fail(this)
  }
}
```

- **tapErrorCause + catchTag + retry の組み合わせ**: エラーをログに記録（`tapErrorCause`）→ 回復不能なエラーを欠陥に昇格（`catchTag` + `die`）→ 残りをリトライ（`retry`）→ 最終的に欠陥化（`orDie`）という段階的エラーハンドリングチェーン。

```typescript
// packages/workflow/src/DurableQueue.ts:205-208
Effect.tapErrorCause(Effect.logWarning),
Effect.catchTag("ParseError", Effect.die),
Effect.retry(options?.retrySchedule ?? defaultRetrySchedule),
Effect.orDie,
```

## Anti-Patterns / 注意点

- **catch なしの Effect.try**: `Effect.try` に `catch` を渡さないと `UnknownException` が返り、型チャネルが `unknown` 相当になる。エラーの型安全性が失われる。

```typescript
// Bad: 型が Effect<A, UnknownException>
const bad = Effect.try(() => JSON.parse(input))

// Better: 具体的なエラー型を生成
const better = Effect.try({
  try: () => JSON.parse(input),
  catch: (cause) => new ParseError({ cause })
})
```

- **安易な orDie の多用**: `orDie` は期待エラーを欠陥に変換し型から消すが、エラー情報自体はスタックトレースに残るだけで構造的にアクセスできなくなる。モジュール内部ではなくモジュール境界で意図的に使うべき。

```typescript
// Bad: ドメインロジック内で orDie
const bad = fetchUser(id).pipe(Effect.orDie)

// Better: 境界で mapError してから必要なら orDie
const better = fetchUser(id).pipe(
  Effect.mapError((e) => new AppError({ cause: e }))
)
```

- **reason フィールドの文字列リテラル型を省略**: `reason` を `string` 型にすると型安全なパターンマッチができない。リテラルユニオンにすべき。

```typescript
// Bad
class MyError { readonly reason: string }

// Better
class MyError { readonly reason: "NotFound" | "Timeout" | "Unauthorized" }
```

## 導出ルール

- `[MUST]` エラー型には `_tag` フィールドをリテラル型で定義し、discriminated union として型安全にパターンマッチできるようにする
  - 根拠: Effect-TS の全エラー型（`MigrationError`, `HttpClientError`, `MultipartError` 等 20+ クラス）が `_tag` をリテラル型で持ち、`catchTag` / `catchTags` による型安全ディスパッチを実現している

- `[MUST]` エラーを変換・ラップする際は元のエラーを `cause` フィールドに保持し、エラーチェーンを途切れさせない
  - 根拠: `SqlEventJournal.ts` の全エラー変換箇所（7箇所）で `new EventJournalError({ cause, method })` として元エラーを保持しており、`Multipart.ts:552` でも同様

- `[SHOULD]` 回復可能なエラー（ドメインエラー）と回復不能なエラー（バグ・不正状態）を型レベルで分離し、回復不能エラーは明示的に `die` / `throw` で別チャネルに移す
  - 根拠: `DurableQueue.ts:206` で `ParseError`（データ不整合）を `die` で欠陥に昇格させ、リトライ対象から除外している。`Cause` の `Fail` / `Die` 分離が型レベルでこの設計を強制している

- `[SHOULD]` エラー型に `reason` フィールドをリテラルユニオン型で持たせ、同一エラー種別内の原因を構造的に分類する
  - 根拠: `HttpClientError.RequestError`（`"Transport" | "Encode" | "InvalidUrl"`）、`MultipartError`（6 種類の reason）など、コードベース全体で `_tag` + `reason` の二層分類が統一されている

- `[SHOULD]` モジュール境界でエラー型を変換し、内部実装のエラー型を呼び出し側に漏洩させない
  - 根拠: `SqlEventJournal` は内部の `SqlError` を `EventJournalError` にラップし、`Multipart` は `SystemError | BadArgument` を `MultipartError` に変換して公開 API のエラー型を制御している

- `[SHOULD]` エラークラスに `get message()` getter を定義し、構造化フィールド（`reason`, `method`, `description`）から人間向けメッセージを合成する
  - 根拠: `HttpClientError.ts:48-52`、`Error.ts:133-137`、`AiError.ts:247-278` など全パッケージのエラークラスが統一的にこのパターンを実装している

- `[AVOID]` 例外をキャッチして `unknown` 型のまま型チャネルに流す。必ず具体的なエラー型に変換してから失敗させる
  - 根拠: `Effect.try` の `catch` なし呼び出しは `UnknownException` を返すが、コードベースでは `MsgPack.ts:70-72`、`httpClient.ts:211` など全箇所で `catch` を指定して具体型に変換している

## 適用チェックリスト

- [ ] プロジェクトのエラー型に `_tag` リテラル型フィールドが定義されているか
- [ ] エラー型が discriminated union として定義され、網羅的なパターンマッチが可能か
- [ ] エラーをラップ・変換する箇所で元のエラーが `cause` フィールドに保持されているか
- [ ] 回復可能なエラーと回復不能なエラー（バグ）が明確に分離されているか
- [ ] モジュール境界で内部エラー型が外部に漏洩していないか（エラー翻訳が行われているか）
- [ ] 外部 API やパーサーの例外キャッチ時に、`unknown` のまま放置せず具体的なエラー型に変換しているか
- [ ] エラークラスに `message` getter があり、構造化フィールドから人間向けメッセージを生成しているか
- [ ] 同一エラー型内で原因のバリエーションがある場合、`reason` フィールドでリテラルユニオンにより分類されているか
