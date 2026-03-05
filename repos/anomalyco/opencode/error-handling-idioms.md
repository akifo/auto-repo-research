# error-handling-idioms

> リポジトリ: anomalyco/opencode
> 分析日: 2026-03-05

## 概要

opencode は AGENTS.md に「Avoid try/catch where possible」と明示し、try/catch 回避を設計方針として掲げている。代替として `.catch()` チェーン、`NamedError` ファクトリパターン、`isInstance` による型安全な判別を一貫して採用している。これは TypeScript の構造的型付けと async/await の特性を活かした、エラー処理のイディオム集として注目に値する。try/catch が残るのは JSON パース等の同期的かつ避けられない箇所に限定されており、意図的な使い分けが明確に読み取れる。

## 背景にある原則

- **エラーは値として扱うべき**: try/catch はスコープを分断し、制御フローを不透明にする。`.catch()` チェーンならエラー処理が式の一部として読み下せる。Haskell の `Either` や Go の多値返却に近い思想を Promise チェーンで実現している（`packages/opencode/src/session/prompt.ts:205` の `.catch(() => undefined)` 等、コードベース全体で 85 箇所以上の `.catch()` 使用が確認できる）。

- **エラー型はスキーマで定義し、構造で判別すべき**: `NamedError.create()` は名前と Zod スキーマを受け取り、`.isInstance()` で構造的に判別可能なエラークラスを動的に生成する。instanceof に依存せず、シリアライズ後の plain object でも判別できるため、プロセス境界・ネットワーク境界をまたぐエラー伝播に耐える設計となっている（`packages/util/src/error.ts:29` の `isInstance` は `name` プロパティの一致で判定）。

- **エラー伝播はドメイン境界で変換すべき**: `MessageV2.fromError()` のように、キャッチしたエラーをドメイン固有の NamedError に変換するゲートウェイ関数を設ける。これにより、上位レイヤーは下位の実装詳細（SDK 固有の例外型等）に依存しない。

- **回復不能なエラーは即座にフォールバック値を返すべき**: `.catch(() => [])` や `.catch(() => undefined)` で、失敗しても処理を継続する意図を呼び出し側に明示する。try/catch + 変数宣言のパターンより簡潔で、フォールバック値が式の末尾に現れるため可読性が高い。

## 実例と分析

### NamedError ファクトリパターン

コードベース全体で 38 箇所の `NamedError.create()` 呼び出しが確認できる。各ドメインモジュールが自身の名前空間内にエラー型を定義し、Zod スキーマでデータ構造を保証している。

```typescript
// packages/util/src/error.ts:7-46
export abstract class NamedError extends Error {
  abstract schema(): z.core.$ZodType;
  abstract toObject(): { name: string; data: any; };

  static create<Name extends string, Data extends z.core.$ZodType>(name: Name, data: Data) {
    const schema = z
      .object({
        name: z.literal(name),
        data,
      })
      .meta({
        ref: name,
      });
    const result = class extends NamedError {
      public static readonly Schema = schema;

      constructor(
        public readonly data: z.input<Data>,
        options?: ErrorOptions,
      ) {
        super(name, options);
        this.name = name;
      }

      static isInstance(input: any): input is InstanceType<typeof result> {
        return typeof input === "object" && "name" in input && input.name === name;
      }
      // ...
    };
    Object.defineProperty(result, "name", { value: name });
    return result;
  }
}
```

このファクトリは以下の 3 つの能力を同時に提供する:

1. **Zod スキーマ統合**: `Schema` 静的プロパティにより OpenAPI 仕様や API レスポンスにそのまま利用可能（`packages/opencode/src/server/error.ts:28` で `NotFoundError.Schema` を API レスポンス定義に使用）
2. **構造的判別**: `isInstance()` は `name` プロパティで判定するため、`.toObject()` でシリアライズされた plain object にも適用可能
3. **型推論**: `data` フィールドに Zod スキーマの型が推論されるため、キャッチ後に型安全にデータへアクセスできる

### ドメイン別エラー定義

各モジュールは自身の名前空間内にエラーを定義し、責務を明確にしている:

```typescript
// packages/opencode/src/worktree/index.ts:82-122
export const NotGitError = NamedError.create(
  "WorktreeNotGitError",
  z.object({ message: z.string() }),
);
export const CreateFailedError = NamedError.create(
  "WorktreeCreateFailedError",
  z.object({ message: z.string() }),
);
// 同名前空間内に RemoveFailedError, ResetFailedError 等も定義
```

```typescript
// packages/opencode/src/session/message-v2.ts:24-55
export const OutputLengthError = NamedError.create("MessageOutputLengthError", z.object({}));
export const AbortedError = NamedError.create("MessageAbortedError", z.object({ message: z.string() }));
export const APIError = NamedError.create(
  "APIError",
  z.object({
    message: z.string(),
    statusCode: z.number().optional(),
    isRetryable: z.boolean(),
    responseHeaders: z.record(z.string(), z.string()).optional(),
    responseBody: z.string().optional(),
  }),
);
```

### .catch() チェーンによる try/catch 回避

非同期処理のエラーハンドリングは一貫して `.catch()` チェーンで行われている:

```typescript
// packages/opencode/src/session/prompt.ts:205
const stats = await fs.stat(filepath).catch(() => undefined);

// packages/opencode/src/session/instruction.ts:122
const content = await Filesystem.readText(p).catch(() => "");

// packages/opencode/src/mcp/index.ts:205
const result = await create(key, mcp).catch(() => undefined);
```

ファイル読み込みでは `.catch()` 内でエラー種別に応じた変換を行う:

```typescript
// packages/opencode/src/config/paths.ts:67-71
export async function readFile(filepath: string) {
  return Filesystem.readText(filepath).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return;
    throw new JsonError({ path: filepath }, { cause: err });
  });
}
```

Storage レイヤーでは `.catch()` でエラー変換ユーティリティを構成している:

```typescript
// packages/opencode/src/storage/storage.ts:196-205
async function withErrorHandling<T>(body: () => Promise<T>) {
  return body().catch((e) => {
    if (!(e instanceof Error)) throw e;
    const errnoException = e as NodeJS.ErrnoException;
    if (errnoException.code === "ENOENT") {
      throw new NotFoundError({ message: `Resource not found: ${errnoException.path}` });
    }
    throw e;
  });
}
```

### エラー変換ゲートウェイ

`MessageV2.fromError()` は `switch (true)` パターンでエラーの分類と変換を一箇所に集約する:

```typescript
// packages/opencode/src/session/message-v2.ts:827-913
export function fromError(e: unknown, ctx: { providerID: string; }) {
  switch (true) {
    case e instanceof DOMException && e.name === "AbortError":
      return new MessageV2.AbortedError({ message: e.message }, { cause: e }).toObject();
    case MessageV2.OutputLengthError.isInstance(e):
      return e;
    case LoadAPIKeyError.isInstance(e):
      return new MessageV2.AuthError({ providerID: ctx.providerID, message: e.message }, { cause: e }).toObject();
    case APICallError.isInstance(e):
      const parsed = ProviderError.parseAPICallError({ providerID: ctx.providerID, error: e });
      // ... 分類に応じた NamedError への変換
    case e instanceof Error:
      return new NamedError.Unknown({ message: e.toString() }, { cause: e }).toObject();
    default:
      return new NamedError.Unknown({ message: JSON.stringify(e) }, { cause: e }).toObject();
  }
}
```

### isInstance チェーンによるエラーフォーマット

CLI 層では `isInstance` を連鎖させてエラー種別ごとのユーザー向けメッセージを生成する:

```typescript
// packages/opencode/src/cli/error.ts:7-41
export function FormatError(input: unknown) {
  if (MCP.Failed.isInstance(input))
    return `MCP server "${input.data.name}" failed. ...`
  if (Provider.ModelNotFoundError.isInstance(input)) {
    const { providerID, modelID, suggestions } = input.data
    return [ /* ユーザー向けメッセージ組み立て */ ].join("\n")
  }
  if (Config.JsonError.isInstance(input))
    return `Config file at ${input.data.path} is not valid JSON(C)` + ...
  // ...
}
```

### try/catch が許容されるケース

try/catch は JSON パースや同期処理の境界など、`.catch()` が使えない場面に限定されている:

```typescript
// packages/opencode/src/provider/error.ts:71-78 (JSON パース)
try {
  const body = JSON.parse(e.responseBody);
  const errMsg = body.message || body.error || body.error?.message;
  if (errMsg && typeof errMsg === "string") {
    return `${msg}: ${errMsg}`;
  }
} catch {}

// packages/opencode/src/storage/db.ts:119-130 (Context 境界の例外フロー)
try {
  return callback(ctx.use().tx);
} catch (err) {
  if (err instanceof Context.NotFound) {
    // フォールバック処理
  }
  throw err;
}
```

## パターンカタログ

- **Abstract Factory** (分類: 生成)
  - 解決する問題: エラークラスの重複定義とボイラープレート
  - 適用条件: 複数のドメインモジュールがそれぞれ固有のエラー型を必要とする場合
  - コード例: `packages/util/src/error.ts:7` の `NamedError.create()`
  - 注意点: ファクトリの返す型は抽象クラスの派生型であり、TypeScript の型推論に依存するため、エクスポート時に型を明示する必要がある場合がある

- **Gateway / Anti-Corruption Layer** (分類: 構造)
  - 解決する問題: 外部 SDK のエラー型が上位レイヤーに漏洩する問題
  - 適用条件: 外部ライブラリのエラーをドメインモデルに変換する必要がある場合
  - コード例: `packages/opencode/src/session/message-v2.ts:827` の `fromError()`
  - 注意点: `switch (true)` と `isInstance` の組み合わせは `if` チェーンと等価だが、case 節ごとの型絞り込みが効く

## Good Patterns

- **`.catch()` によるインラインフォールバック**: `await fn().catch(() => fallback)` で、失敗時のデフォルト値を式の末尾に配置する。try/catch + let 変数より行数が少なく、フォールバック値が明示的。

```typescript
// packages/opencode/src/session/prompt.ts:205
const stats = await fs.stat(filepath).catch(() => undefined);
```

- **NamedError + Zod スキーマ統合**: エラーの構造を Zod で定義することで、API レスポンススキーマと型定義を一元管理。`.toObject()` でシリアライズ、`.isInstance()` でデシリアライズ後の判別が可能。

```typescript
// packages/opencode/src/storage/db.ts:18-23
export const NotFoundError = NamedError.create(
  "NotFoundError",
  z.object({ message: z.string() }),
);
```

- **エラー変換ユーティリティ関数**: `.catch()` 内でエラー種別に応じた変換を行い、ドメイン固有のエラーに統一する。下位レイヤーの詳細（`ENOENT` 等）を上位に漏らさない。

```typescript
// packages/opencode/src/storage/storage.ts:196-205
async function withErrorHandling<T>(body: () => Promise<T>) {
  return body().catch((e) => {
    if (!(e instanceof Error)) throw e;
    const errnoException = e as NodeJS.ErrnoException;
    if (errnoException.code === "ENOENT") {
      throw new NotFoundError({ message: `Resource not found: ${errnoException.path}` });
    }
    throw e;
  });
}
```

## Anti-Patterns / 注意点

- **空の catch ブロックによるエラー握りつぶし**: `.catch(() => {})` は「このエラーは無視して良い」意図を表すが、ログもなく頻出すると本来対処すべきエラーを見逃すリスクがある。opencode ではファイル削除 (`.unlink().catch(() => {})`) やクリーンアップ処理に限定して使用している。

```typescript
// Bad: 重要な処理のエラーを握りつぶす
await criticalOperation().catch(() => {});

// Better: ログを残すか、フォールバック値を返す
await criticalOperation().catch((e) => {
  log.error("critical operation failed", { error: e });
  return fallback;
});
```

- **try/catch でスコープを分断する変数宣言**: try ブロック内で宣言した変数を外で使うために `let` を使うパターンは、変数のライフタイムを不必要に広げる。

```typescript
// Bad: let + try/catch
let result;
try {
  result = await fetchData();
} catch {
  result = fallback;
}

// Better: .catch() でインライン化
const result = await fetchData().catch(() => fallback);
```

## 導出ルール

- `[MUST]` エラー型は名前（文字列リテラル）とスキーマで定義し、`instanceof` ではなく構造的判別を使う
  - 根拠: opencode の `isInstance()` は `name` プロパティで判定するため、シリアライズ/デシリアライズをまたいでも判別可能（`packages/util/src/error.ts:29`）

- `[MUST]` ドメイン境界にはエラー変換関数を配置し、外部ライブラリの例外型を内部のエラー型に変換する
  - 根拠: `MessageV2.fromError()` が `APICallError`, `LoadAPIKeyError` 等の SDK 固有例外をドメインエラーに一元変換している（`packages/opencode/src/session/message-v2.ts:827`）

- `[SHOULD]` 非同期処理のエラーハンドリングは `.catch()` チェーンで行い、try/catch より優先する
  - 根拠: AGENTS.md に「Avoid try/catch where possible」「Prefer .catch(...) instead of try/catch」と明記。コードベース全体で 85 箇所以上の `.catch()` 使用に対し、try/catch はパッケージ本体で 48 箇所未満

- `[SHOULD]` `.catch(() => fallback)` でフォールバック値を式のインラインに記述し、let 変数 + try/catch を避ける
  - 根拠: `fs.stat(filepath).catch(() => undefined)` のように、フォールバック値が呼び出しの末尾に現れることで、エラー時の挙動が一目でわかる（`packages/opencode/src/session/prompt.ts:205`）

- `[SHOULD]` エラーデータに Zod スキーマを使い、API レスポンス定義と型定義を一元管理する
  - 根拠: `NotFoundError.Schema` がそのまま OpenAPI レスポンススキーマとして使用されている（`packages/opencode/src/server/error.ts:28`）

- `[AVOID]` 空の `.catch(() => {})` はクリーンアップ・副作用処理に限定し、データ取得やビジネスロジックでは使わない
  - 根拠: opencode でも `unlink().catch(() => {})` や `close().catch(() => {})` 等、失敗しても問題ない処理にのみ使用されている

- `[AVOID]` try/catch を非同期処理の主要なエラーハンドリング手段として使う。同期 JSON パースやコンテキスト境界の例外フローなど、`.catch()` が使えない場面に限定する
  - 根拠: try/catch の使用が `JSON.parse` と `Context.NotFound` の判定に集中している（`packages/opencode/src/provider/error.ts:71`, `packages/opencode/src/storage/db.ts:119`）

## 適用チェックリスト

- [ ] エラークラスが `instanceof` に依存していないか確認する。プロセス境界をまたぐ場合は構造的判別（名前フィールド等）に切り替える
- [ ] 外部ライブラリのエラーが上位レイヤーに直接漏洩していないか確認する。ドメイン境界にエラー変換関数を配置する
- [ ] `let result; try { result = ... } catch { result = fallback }` パターンを `await fn().catch(() => fallback)` に置き換えられないか検討する
- [ ] `.catch(() => {})` の使用箇所を棚卸しし、クリーンアップ以外で使われていないか確認する
- [ ] エラー型の定義にバリデーションスキーマ（Zod 等）を統合し、API レスポンス定義と型定義の二重管理を解消する
- [ ] try/catch が残っている箇所を列挙し、`.catch()` に置き換え可能かどうか判定する（同期 JSON パース等は除外）
