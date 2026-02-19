# Practice: Error Normalization Pipeline

> 出典: [repos/vitejs/vite](../repos/vitejs/vite/), [repos/openclaw/openclaw](../repos/openclaw/openclaw/), [repos/mastra-ai/mastra](../repos/mastra-ai/mastra/), [repos/Effect-TS/effect](../repos/Effect-TS/effect/)
> カテゴリ: practice

## 概要

外部境界（API 呼び出し、ファイル I/O、サードパーティライブラリ等）で catch した `unknown` エラーを内部型に変換するパイプラインパターン。4つのリポジトリが独立に実装しており、`catch → 構造チェック → wrap → 内部型として返却/再throw` という共通フローが浮かび上がる。このパターンにより、内部ロジックは統一されたエラー型だけを扱えるようになり、エラーハンドリングの分岐が大幅に単純化される。

## 背景・文脈

TypeScript/JavaScript の `catch` 節で受け取る値は `unknown` 型である。外部ライブラリは独自のエラー形式を返し、ネットワーク層は文字列を throw し、LLM プロバイダは非 Error オブジェクトを投げることもある。各リポジトリは異なるドメインで同じ課題に直面し、それぞれの解法を発展させた:

- **vitejs/vite** -- PostCSS, esbuild, LightningCSS, Less, Sass など多様なビルドツールが投げるエラーを `RollupError` 互換の `{ message, loc, frame, plugin }` 構造に正規化
- **openclaw/openclaw** -- Telegram, Discord, AI プロバイダ等の外部サービスエラーを `FailoverError` に変換する `coerceToFailoverError` 関数
- **mastra-ai/mastra** -- コードベース全体で 40 箇所以上使われる `getErrorFromUnknown` が `unknown` を `SerializableError` に正規化
- **Effect-TS/effect** -- `Effect.try` の `catch` コールバックと `mapError` で例外を型付きエラーに変換し、`Cause` ツリーで情報を保持

## 実装パターン

### パターン 1: 直接正規化（Vite 方式）

catch ブロック内で外部ツールのエラーを共通構造に変換し、プロパティを手動でマッピングする。軽量で依存が少ない。

```typescript
// packages/vite/src/node/plugins/css.ts:2929-2940
const normalizedError: RollupError = new Error(
  `[less] ${error.message || error.type}`,
) as RollupError;
normalizedError.loc = {
  file: error.filename || options.filename,
  line: error.line,
  column: error.column,
};
```

シリアライズ境界では `prepareError` が巨大なエラーオブジェクトから必要最小限のプロパティだけを抽出する:

```typescript
// packages/vite/src/node/server/middlewares/error.ts:11-23
export function prepareError(err: Error | RollupError): ErrorPayload["err"] {
  return {
    message: strip(err.message),
    stack: strip(cleanStack(err.stack || "")),
    id: (err as RollupError).id,
    frame: strip((err as RollupError).frame || ""),
    plugin: (err as RollupError).plugin,
    pluginCode: (err as RollupError).pluginCode?.toString(),
    loc: (err as RollupError).loc,
  };
}
```

### パターン 2: Coercion ファクトリ（OpenClaw 方式）

`unknown` を受け取り、構造チェック（instanceof → ステータスコード → エラーコード → メッセージ）の連鎖で内部エラー型に変換する。変換不能なら `null` を返す。

```typescript
// src/agents/failover-error.ts:205-234
export function coerceToFailoverError(
  err: unknown,
  context?: { provider?: string; model?: string; profileId?: string; },
): FailoverError | null {
  if (isFailoverError(err)) return err; // 既に変換済み → そのまま返す
  const reason = resolveFailoverReasonFromError(err); // 構造チェック連鎖
  if (!reason) return null; // 変換不能 → null
  const message = getErrorMessage(err) || String(err);
  const status = getStatusCode(err) ?? resolveFailoverStatus(reason);
  const code = getErrorCode(err);
  return new FailoverError(message, {
    reason,
    provider: context?.provider,
    model: context?.model,
    profileId: context?.profileId,
    status,
    code,
    cause: err instanceof Error ? err : undefined, // 元エラーを保持
  });
}
```

### パターン 3: 中央正規化ユーティリティ（Mastra 方式）

コードベース共通の正規化関数を基盤が提供し、Error インスタンス・オブジェクト・文字列・null すべてを安全に Error に変換する。cause チェーンの再帰的シリアライズ（深さ制限付き）まで行う。

```typescript
// packages/core/src/error/utils.ts:45-122
export function getErrorFromUnknown<SERIALIZABLE extends boolean = true>(
  unknown: unknown,
  options: {
    fallbackMessage?: string;
    maxDepth?: number; // cause チェーンの深度制限（デフォルト 5）
    supportSerialization?: SERIALIZABLE;
    serializeStack?: boolean;
  } = {},
): SERIALIZABLE extends true ? SerializableError : Error {
  // Error インスタンス → そのまま使用
  // オブジェクト → message プロパティを抽出して Error に変換
  // 文字列 → new Error(string)
  // null/undefined → new Error(fallbackMessage)
  // ...
}
```

正規化後、ドメインコンテキストを付加して再ラップする。二重ラップ防止のガードが重要:

```typescript
// stores/upstash/src/vector/index.ts:364-379
} catch (error) {
  if (error instanceof MastraError) throw error;  // 二重ラップ防止
  throw new MastraError({
    id: createVectorErrorId('UPSTASH', 'UPDATE_VECTOR', 'FAILED'),
    domain: ErrorDomain.STORAGE,
    category: ErrorCategory.THIRD_PARTY,
    details: { namespace },
  }, error);  // 元エラーは cause に自動保持
}
```

### パターン 4: 型レベルの境界変換（Effect 方式）

`Effect.try` の `catch` コールバックと `mapError` で例外を型付きエラーに変換する。型チャネル `E` にエラー型が刻まれるため、コンパイル時に未処理エラーを検出できる。

```typescript
// packages/platform/src/MsgPack.ts:70-72
Effect.try({
  try: () => Chunk.of(packr.pack(Chunk.toReadonlyArray(input))),
  catch: (cause) => new MsgPackError({ reason: "Pack", cause }),
}),
```

モジュール境界では `mapError` で低レベルエラーを高レベルのドメインエラーに翻訳する:

```typescript
// packages/sql/src/SqlEventJournal.ts:158-161
entries: sql`SELECT * FROM ${sql(entryTable)} ORDER BY timestamp ASC`
  .withoutTransform.pipe(
    Effect.flatMap(decodeEntrySqlArray),
    Effect.mapError((cause) =>
      new EventJournal.EventJournalError({ cause, method: "entries" })
    ),
  ),
```

## Good Example

**統一された正規化パイプライン: catch → 型チェック → wrap → 内部型**

```typescript
// 汎用的な正規化パイプラインの実装例（4リポの手法を統合）

// 1. 内部エラー型を定義（構造化フィールド付き）
type ErrorReason = "network" | "validation" | "timeout" | "unknown";

class AppError extends Error {
  readonly reason: ErrorReason;
  constructor(message: string, reason: ErrorReason, options?: { cause?: unknown; }) {
    super(message, options);
    this.name = "AppError";
    this.reason = reason;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// 2. 正規化関数（unknown → AppError）
function normalizeError(err: unknown, context?: string): AppError {
  // 既に変換済みなら二重ラップしない（Mastra パターン）
  if (err instanceof AppError) return err;

  // instanceof で既知のエラー型を判定（OpenClaw パターン）
  if (err instanceof TypeError) {
    return new AppError(err.message, "validation", { cause: err });
  }

  // 構造チェックでステータスコードを検査
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = (err as { status: number; }).status;
    if (status === 408 || status === 504) {
      return new AppError(`Timeout from ${context ?? "unknown"}`, "timeout", { cause: err });
    }
  }

  // Error インスタンスならメッセージを保持してラップ
  if (err instanceof Error) {
    return new AppError(
      context ? `[${context}] ${err.message}` : err.message,
      "unknown",
      { cause: err },
    );
  }

  // 非 Error（文字列、null 等）のフォールバック（Mastra パターン）
  return new AppError(
    context ? `[${context}] ${String(err)}` : String(err),
    "unknown",
  );
}

// 3. 境界での使用
async function fetchExternalApi(url: string): Promise<Data> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw { status: res.status, body: await res.text() };
    return await res.json();
  } catch (err) {
    throw normalizeError(err, "external-api");
  }
}
```

## Bad Example

```typescript
// Bad 1: unknown をそのまま伝播 -- 内部ロジックが型安全にハンドルできない
async function fetchData(url: string): Promise<Data> {
  try {
    return await fetch(url).then((r) => r.json());
  } catch (err) {
    // err は unknown のまま。呼び出し側で何をチェックすればよいか不明
    throw err;
  }
}

// Bad 2: エラーメッセージの文字列マッチに依存 -- メッセージ変更で壊れる
} catch (err) {
  if (err instanceof Error && err.message.includes("status: 4")) {
    throw err; // メッセージ文言が変わったらリトライ対象外にできなくなる
  }
  // retry...
}

// Bad 3: 元エラー情報を捨てる -- デバッグ時に原因を追えなくなる
} catch (err) {
  throw new AppError("Something went wrong"); // cause がない、元のスタック消失
}

// Bad 4: 二重ラップを防止しない -- エラーが際限なくネストする
} catch (err) {
  // err が既に AppError でも無条件にラップしてしまう
  throw new AppError(`Wrapper: ${err}`, "unknown", { cause: err });
}
```

## 適用ガイド

### どのような状況で使うべきか

- **外部サービス統合が2つ以上ある場合**: 各サービスが異なるエラー形式を返すため、内部ロジックでの統一的なハンドリングが困難になる。正規化レイヤーを設けることで catch 側の分岐を大幅に減らせる
- **エラーがシリアライズ境界を超える場合**: サーバーからクライアントへの送信、ログ集約、API レスポンスなど。Vite の `prepareError` のように必要最小限のプロパティだけを抽出する正規化が必要になる
- **チームで統一的なエラーハンドリング規約を確立したい場合**: Mastra の `getErrorFromUnknown` のように、基盤が正規化関数を提供することで個別の catch ブロックでの不統一を防げる

### 導入時の注意点

1. **二重ラップ防止ガードを必ず入れる**: `if (err instanceof MyError) throw err;` のチェックがないと、catch-rethrow の連鎖でエラーが際限なくネストする（Mastra の全ストレージアダプターで適用されているパターン）
2. **元エラーを `cause` フィールドに保持する**: ES2022 の `Error` コンストラクタの `cause` オプションを使い、エラーチェーンを途切れさせない。4リポすべてがこの原則を守っている
3. **cause チェーンの深度制限を設ける**: 再帰的なシリアライズで無限ループに陥らないよう、Mastra は `maxDepth`（デフォルト 5）で制限している
4. **`Object.setPrototypeOf(this, new.target.prototype)` を忘れない**: TypeScript で `Error` を拡張する際、トランスパイル後に `instanceof` が正しく動作しなくなる問題がある。Mastra と Effect がこの対策を実装している

### カスタマイズポイント

| 手法                            | 特徴                           | 適したケース                       |
| ------------------------------- | ------------------------------ | ---------------------------------- |
| 直接正規化（Vite）              | catch 内で手動マッピング       | エラーソースが少なく構造が明確     |
| Coercion ファクトリ（OpenClaw） | 段階的な構造チェック連鎖       | 外部サービスが多くエラー形式が多様 |
| 中央ユーティリティ（Mastra）    | 基盤が共通関数を提供           | チーム開発で統一規約が必要         |
| 型レベル境界変換（Effect）      | 型チャネルでコンパイル時に検出 | 型安全性を最優先する場合           |

### 共通のパイプライン構造

4リポに共通するフローを抽象化すると、以下の3段階になる:

```
catch (unknown)
  |
  v
[1] 既知チェック -- instanceof / _tag / code で自ドメインのエラーか判定
  |                → 二重ラップ防止: そのまま return/throw
  v
[2] 構造解析 -- ステータスコード / エラーコード / reason を抽出
  |            → 変換不能なら汎用エラーとしてラップ
  v
[3] 内部型生成 -- cause に元エラーを保持し、コンテキスト情報を付加
               → メッセージにソースプレフィックスを付与（[postcss], [external-api] 等）
```

## 参考

- [repos/vitejs/vite/error-handling-idioms.md](../repos/vitejs/vite/error-handling-idioms.md) -- 多様なビルドツールエラーの RollupError 互換構造への正規化
- [repos/openclaw/openclaw/error-handling-idioms.md](../repos/openclaw/openclaw/error-handling-idioms.md) -- coerceToFailoverError による段階的構造チェック
- [repos/mastra-ai/mastra/error-handling-idioms.md](../repos/mastra-ai/mastra/error-handling-idioms.md) -- getErrorFromUnknown 中央正規化ユーティリティ
- [repos/Effect-TS/effect/error-handling-idioms.md](../repos/Effect-TS/effect/error-handling-idioms.md) -- 型レベルのエラー境界変換と Cause ツリー
