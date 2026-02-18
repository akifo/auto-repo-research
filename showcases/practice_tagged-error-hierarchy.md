# practice: tagged-error-hierarchy

> 出典: [repos/Effect-TS/effect](../repos/Effect-TS/effect/) からの知見
> カテゴリ: practice

## 概要

`_tag` リテラル型と `reason` リテラルユニオンの二層構造でエラーを分類し、`catchTag` による型安全ディスパッチと `Exclude` による処理済みエラーの型除去を組み合わせるプラクティス。エラーの網羅性チェックを型システムに委ね、ハンドリング漏れをコンパイル時に検出する。Effect-TS のコードベース全体（20+ クラス）で統一的に適用されており、エラー型の増殖を防ぎつつ十分な表現力を維持する実績ある手法である。

## 背景・文脈

Effect-TS は「ロスレスなエラーモデル」を設計原則とし、`Effect<A, E, R>` の `E` パラメータでエラー型を関数シグネチャに刻む。エラーは `Cause` データ型で構造化され、期待エラー（`Fail`）・予期せぬ欠陥（`Die`）・中断（`Interrupt`）を型レベルで区別する。

この設計において、エラー型の定義パターンが重要になる。単一の `_tag` だけでは、同一種別内の原因バリエーション（ネットワーク障害・エンコードエラー・不正 URL など）を表現できず、エラー型が爆発する。逆に `reason` だけでは、`catchTag` による型レベルのディスパッチが利用できない。Effect-TS は `_tag`（種類） + `reason`（原因）の二層分類を採用し、この問題を解決している。

HTTP クライアント（`HttpClientError`）、SQL マイグレーション（`Migrator`）、マルチパート処理（`Multipart`）、ソケット通信（`Socket`）、メッセージパック（`MsgPack`）など、I/O 境界のあるモジュールで一貫してこのパターンが使われている。

## 実装パターン

### 二層分類の構造

```
_tag（種類）──── catchTag でディスパッチ、型レベルで Exclude
  └── reason（原因）──── ハンドラ内で分岐、ログ・メッセージ構築に使用
```

- `_tag`: discriminated union のキー。1 エラークラスにつき 1 つのリテラル型。`catchTag` / `catchTags` で型安全にパターンマッチされ、処理済みのエラーが `Exclude<E, { _tag: K }>` で型から除去される。
- `reason`: 同一 `_tag` 内の原因を細分化するリテラルユニオン。`catchTag` 後のハンドラ内でロジック分岐やエラーメッセージの構築に使う。

### パターン 1: Data.TaggedError による定義

軽量な定義向け。シリアライズ境界を超えない内部エラーに適する。

```typescript
// packages/sql/src/Migrator.ts:57-67
export class MigrationError extends Data.TaggedError("MigrationError")<{
  readonly _tag: "MigrationError";
  readonly cause?: unknown;
  readonly reason: "bad-state" | "import-error" | "failed" | "duplicates" | "locked";
  readonly message: string;
}> {}
```

### パターン 2: Schema.TaggedError による定義

RPC やイベントソーシングなど、シリアライズ境界を超えるエラーに使う。`Schema.Literal` で reason を定義することで、エンコード/デコード時のバリデーションも型安全に行える。

```typescript
// packages/platform/src/Multipart.ts:145-160
export class MultipartError extends Schema.TaggedError<MultipartError>()("MultipartError", {
  reason: Schema.Literal("FileTooLarge", "FieldTooLarge", "BodyTooLarge", "TooManyParts", "InternalError", "Parse"),
  cause: Schema.Defect,
}) {
  get message(): string {
    return this.reason;
  }
}
```

### パターン 3: TypeIdError による定義

TypeId によるブランド型付きエラー。外部に公開する API のエラー型で、`instanceof` チェックの代わりに TypeId で識別する場合に使う。

```typescript
// packages/platform/src/HttpClientError.ts:38-43
export class RequestError extends Error.TypeIdError(TypeId, "RequestError")<{
  readonly request: ClientRequest.HttpClientRequest;
  readonly reason: "Transport" | "Encode" | "InvalidUrl";
  readonly cause?: unknown;
  readonly description?: string;
}> {
  get message() {
    return this.description
      ? `${this.reason}: ${this.description} (${this.methodAndUrl})`
      : `${this.reason} error (${this.methodAndUrl})`;
  }
}
```

```typescript
// packages/platform/src/Socket.ts:140-143
export class SocketGenericError extends TypeIdError(SocketErrorTypeId, "SocketError")<{
  readonly reason: "Write" | "Read" | "Open" | "OpenTimeout"
  readonly cause: unknown
}> { ... }
```

### catchTag による型安全ディスパッチ

`catchTag` / `catchTags` は `_tag` フィールドで特定のエラーだけをハンドリングし、処理済みエラーを `Exclude` で型から除去する。

```typescript
// Effect.ts:3882-3890 の catchTag 型シグネチャ（簡略化）
export const catchTag: {
  <E, const K extends ..., A1, E1, R1>(
    ...args: [...tags: K, f: (e: Extract<E, { _tag: K[number] }>) => Effect<A1, E1, R1>]
  ): <A, R>(self: Effect<A, E, R>) => Effect<A | A1, Exclude<E, { _tag: K[number] }> | E1, R | R1>
}
```

実際の使用例。`SystemError | BadArgument` を `MultipartError` に変換し、呼び出し側のエラー型から消える:

```typescript
// packages/platform/src/Multipart.ts:551-554
}).pipe(
  Effect.catchTags({
    SystemError: (cause) => Effect.fail(new MultipartError({ reason: "InternalError", cause })),
    BadArgument: (cause) => Effect.fail(new MultipartError({ reason: "InternalError", cause }))
  })
)
```

### 段階的エラーハンドリングチェーン

エラーの種類に応じて異なる戦略を段階的に適用する:

```typescript
// packages/workflow/src/DurableQueue.ts:204-208
Effect.tapErrorCause(Effect.logWarning),          // 1. 全エラーをログに記録
Effect.catchTag("ParseError", Effect.die),         // 2. データ不整合 → 欠陥に昇格（リトライ不要）
Effect.retry(options?.retrySchedule ?? defaultRetrySchedule),  // 3. 残り（ネットワーク障害等）をリトライ
Effect.orDie,                                       // 4. 最終境界で残存エラーを欠陥化
```

`ParseError` はリトライしても回復しないため、`die` で欠陥に昇格させてリトライ対象から除外する。この判断が `catchTag` の型除去によって自然に表現される。

### エラー翻訳パターン

モジュール境界で低レベルのエラーを高レベルのドメインエラーにラップし、内部実装を漏洩させない:

```typescript
// packages/sql/src/SqlEventJournal.ts:158-161
Effect.mapError((cause) => new EventJournal.EventJournalError({ cause, method: "entries" }));
```

`cause` フィールドに元のエラーを保持することで、ロスレス性を維持しつつ抽象化されたエラー型のみを外部に公開する。

### message getter パターン

構造化フィールドから人間向けメッセージを動的に合成する:

```typescript
// packages/platform/src/HttpClientError.ts:48-52
get message() {
  return this.description ?
    `${this.reason}: ${this.description} (${this.methodAndUrl})` :
    `${this.reason} error (${this.methodAndUrl})`
}
```

`reason` や `description` といった型付きフィールドからメッセージを構築するため、コンストラクタに文字列を渡す必要がない。ログ出力時には構造化フィールドを直接参照でき、人間向け表示には `message` getter を使うという二重活用が可能になる。

### YieldableError による generator 統合

`TaggedError` が継承する `YieldableError` は `commit()` メソッドで `Effect.fail(this)` を返すため、`yield*` でそのまま失敗 Effect として使える:

```typescript
// packages/effect/src/internal/core.ts:2230-2234
class YieldableError extends globalThis.Error {
  commit() {
    return fail(this);
  }
}

// 使い方: yield* で直接 Effect に変換
const program = Effect.gen(function*() {
  if (!isValid(input)) {
    yield* new ValidationError({ reason: "InvalidFormat", cause: input });
  }
  // ...
});
```

## Good Example

### リテラルユニオンの reason で型安全なサブ分類

```typescript
// Good: reason がリテラルユニオンで、型安全なマッチと exhaustive check が可能
class HttpError extends Data.TaggedError("HttpError")<{
  readonly reason: "NotFound" | "Timeout" | "Unauthorized" | "ServerError";
  readonly cause?: unknown;
  readonly url: string;
}> {
  get message() {
    return `${this.reason}: ${this.url}`;
  }
}

// ハンドラ内で reason を switch で分岐
Effect.catchTag("HttpError", (e) => {
  switch (e.reason) {
    case "NotFound":
      return Effect.succeed(defaultValue);
    case "Timeout":
      return Effect.retry(schedule);
    case "Unauthorized":
      return Effect.fail(new AuthError({ cause: e }));
    case "ServerError":
      return Effect.fail(e); // そのまま伝播
  }
});
```

### Effect.try で同期例外を具体的なエラー型に変換

```typescript
// Good: catch で具体的なエラー型を生成し、unknown を型チャネルに漏らさない
// packages/platform/src/MsgPack.ts:70-72
Effect.try({
  try: () => Chunk.of(packr.pack(Chunk.toReadonlyArray(input))),
  catch: (cause) => new MsgPackError({ reason: "Pack", cause }),
});
```

### cause を保持してエラーチェーンを維持

```typescript
// Good: 元エラーを cause に保持し、ロスレスな変換
Effect.mapError((cause) => new AppError({ cause, method: "fetch" }));

// Good: catchTags で複数エラーをドメインエラーに翻訳
Effect.catchTags({
  SystemError: (cause) => Effect.fail(new DomainError({ reason: "Internal", cause })),
  NetworkError: (cause) => Effect.fail(new DomainError({ reason: "Network", cause })),
});
```

## Bad Example

### reason を string 型にする

```typescript
// Bad: string 型では型安全なマッチができない
class MyError extends Data.TaggedError("MyError")<{
  readonly reason: string; // 任意の文字列が入り得る
}> {}

// switch で分岐しても exhaustive check が効かない
// タイポしても検出されない
```

```typescript
// Good: リテラルユニオンにする
class MyError extends Data.TaggedError("MyError")<{
  readonly reason: "NotFound" | "Timeout" | "Unauthorized";
}> {}
```

### unknown 型のまま型チャネルに流す

```typescript
// Bad: catch なしの Effect.try は UnknownException を返す
const bad = Effect.try(() => JSON.parse(input));
// 型: Effect<unknown, UnknownException>
// UnknownException は _tag を持たず catchTag でディスパッチできない

// Good: 具体的なエラー型に変換する
const good = Effect.try({
  try: () => JSON.parse(input),
  catch: (cause) => new ParseError({ cause }),
});
// 型: Effect<unknown, ParseError>
```

### cause を保持しない

```typescript
// Bad: 元エラーが消失し、デバッグ不能
Effect.mapError(() => new AppError({ message: "Something went wrong" }));

// Good: cause を保持してエラーチェーンを維持
Effect.mapError((cause) => new AppError({ cause, method: "fetch" }));
```

### orDie の安易な多用

```typescript
// Bad: ドメインロジック内で orDie するとエラー情報が構造的にアクセス不能になる
const bad = fetchUser(id).pipe(Effect.orDie);

// Good: catchTag で回復可能なものを処理し、モジュール境界でのみ orDie を使う
const good = fetchUser(id).pipe(
  Effect.catchTag("NotFound", () => Effect.succeed(defaultUser)),
  Effect.catchTag("Timeout", () => Effect.retry(schedule)),
  // モジュール境界でのみ残存エラーを欠陥化
);
```

## 適用ガイド

### どのような状況で使うべきか

- **Result/Either ベースのエラーハンドリング**を採用するプロジェクトで、複数のエラー種類を構造的に管理したい場合
- **discriminated union によるパターンマッチ**でエラーの網羅性をコンパイル時に保証したい場合
- **モジュール境界が明確なアーキテクチャ**で、内部エラーの外部漏洩を防ぎたい場合
- エラーの種類は少ないが、各種類内に**複数の原因バリエーション**がある場合（HTTP エラーの Transport / Encode / InvalidUrl など）

### 二層分類の設計指針

| 層               | 役割             | 使い方                                            | 設計原則                              |
| ---------------- | ---------------- | ------------------------------------------------- | ------------------------------------- |
| `_tag`           | エラーの「種類」 | `catchTag` / discriminated union のパターンマッチ | 1 エラークラスにつき 1 つのリテラル型 |
| `reason`         | エラーの「原因」 | ハンドラ内の分岐、ログ、メッセージ構築            | リテラルユニオンで網羅的に定義        |
| `cause`          | エラーチェーン   | 元エラーの保持（ロスレス性）                      | 変換時には必ず保持する                |
| `message` getter | 人間向け表示     | ログ出力、デバッグ                                | 構造化フィールドから動的に合成        |

### 導入時の注意点

- **reason は必ずリテラルユニオンにする**: `string` 型にすると型安全なマッチができず、このパターンの価値が失われる
- **cause フィールドを省略しない**: エラー変換時に元エラーを保持しないと、デバッグ時にエラーの原因を追跡できなくなる
- **orDie はモジュール境界でのみ使う**: ドメインロジック内で安易に使うと、型からエラーが消えるだけで実行時のエラーは残る
- **catchTag と retry の順序に注意**: 回復不能エラーを `catchTag` + `die` で先に除外し、残りに対して `retry` を適用する。順序を逆にすると無意味なリトライが発生する

### Effect-TS 以外への適用

このパターンの核心は Effect-TS 固有ではなく、TypeScript の discriminated union と `Exclude` ユーティリティ型を使えば素の TypeScript でも適用できる:

```typescript
// Effect-TS なしでの適用例
type AppError =
  | { readonly _tag: "HttpError"; readonly reason: "NotFound" | "Timeout"; readonly cause?: unknown; }
  | { readonly _tag: "ParseError"; readonly reason: "InvalidJson" | "InvalidSchema"; readonly cause?: unknown; };

// Exclude で処理済みエラーを除去する型レベルのハンドリング
type RemainingErrors = Exclude<AppError, { _tag: "HttpError"; }>;
// => { readonly _tag: "ParseError"; ... }
```

## 参考

- [repos/Effect-TS/effect/error-handling-idioms.md](../repos/Effect-TS/effect/error-handling-idioms.md) -- エラーハンドリングの詳細分析（Cause 構造、境界パターン、段階的ハンドリング）
- [repos/Effect-TS/effect/effect-model.md](../repos/Effect-TS/effect/effect-model.md) -- Effect<A, E, R> の三型パラメータモデルと catchTag の型シグネチャ
