# エラーハンドリングの慣用パターン

> リポジトリ: cloudflare/agents
> 分析日: 2026-02-25

## 概要

cloudflare/agents は Workers ランタイム（Durable Objects）上で動作する AI エージェント SDK であり、ハイバネーション・再起動を前提としたエラーハンドリング設計を持つ。MCP クライアント接続、スケジュール実行、キュー処理、ワークフロー操作など複数のサブシステムに共通するリトライ基盤 `tryN` を中核に据え、エラーの分類・伝搬・回復を一貫した方式で処理している。特にリトライ設定を SQLite に永続化し、DO のハイバネーション越しに生存させるアーキテクチャは、サーバーレス環境固有の制約に対する実践的な解法として注目に値する。

## 背景にある原則

- **Fail-fast at configuration, retry at execution（設定は即座に検証、実行はリトライ）**: リトライ設定のバリデーションは `schedule()` / `queue()` / `this.retry()` の呼び出し時点で即座に行い、不正な設定が実行時まで潜伏することを防ぐ。`validateRetryOptions` はクロスフィールド制約（`baseDelayMs <= maxDelayMs`）をデフォルト値と解決した後にチェックする。これにより `{ baseDelayMs: 5000 }` がデフォルト `maxDelayMs: 3000` と矛盾する場合も即座に検出される（`src/retries.ts:32-66`）。

- **Error-aware retry predicate（エラー種別に応じたリトライ判断）**: 全エラーを一律にリトライするのではなく、`shouldRetry` プレディケートでエラーの種別に応じた判断を行う。Durable Object の overload エラー（`retryable: true` かつ `overloaded: true`）はリトライすると輻輳を悪化させるため、`isErrorRetryable` で明示的に除外する（`src/retries.ts:148-159`）。一方、ユーザーコードや MCP 接続のエラーは種別が不明なため全リトライがデフォルト。

- **Error containment through layered catch（階層化された catch によるエラー封じ込め）**: 致命的でないエラー（state 変更コールバックの例外、キュー処理のコールバック失敗）は内側の catch で `onError` に委譲し、`onError` 自体の例外も空の catch で飲み込む。これにより一つの処理の失敗が他の処理やシステム全体に波及することを防ぐ（`src/index.ts:1901-1910`, `src/index.ts:1265-1271`）。

- **Persist configuration alongside task（設定をタスクと共に永続化する）**: サーバーレス環境ではインメモリ状態がいつ失われるかわからない。リトライ設定を SQLite の `retry_options TEXT` カラムに JSON として格納し、スケジュールやキューアイテムと一緒に永続化する。これによりハイバネーション越しのリトライ設定の一貫性を保証する（`design/retries.md:96-98`）。

## 実例と分析

### 単一リトライループ tryN への集約

すべてのリトライロジックが `tryN` 関数に集約されている。キュー処理、スケジュール実行、ワークフロー操作、MCP サーバー復元、`this.retry()` のいずれも、独自のリトライループを持たず `tryN` を呼び出す。

```typescript
// src/retries.ts:96-140
export async function tryN<T>(
  n: number,
  fn: (attempt: number) => Promise<T>,
  options?: TryNOptions,
): Promise<T> {
  // ... validation ...
  let attempt = 1;
  while (true) {
    try {
      return await fn(attempt);
    } catch (err) {
      const nextAttempt = attempt + 1;
      if (
        nextAttempt > n
        || (options?.shouldRetry && !options.shouldRetry(err, nextAttempt))
      ) {
        throw err;
      }
      const delay = jitterBackoff(attempt, baseDelayMs, maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
      attempt = nextAttempt;
    }
  }
}
```

この集約により、バックオフ計算やバリデーション、`shouldRetry` の判定といった共通ロジックが一箇所に留まる。`design/retries.md` には `tryWhile`（条件ベースのリトライ）を採用しなかった理由として「バグがあると無限リトライになる」点が挙げられている。

### MCP エラー分類のマルチシグナル判定

MCP クライアント接続では、エラーを HTTP ステータスコードとメッセージ文字列の両方で判定している。MCP SDK のバージョン変更でエラーの表現形式が変わることに対応するためである。

```typescript
// src/mcp/errors.ts:28-39
export function isTransportNotImplemented(error: unknown): boolean {
  const code = getErrorCode(error);
  if (code === 404 || code === 405) return true;

  const msg = toErrorMessage(error);
  return (
    msg.includes("404")
    || msg.includes("405")
    || msg.includes("Not Implemented")
    || msg.includes("not implemented")
  );
}
```

ソースコードのコメント（`src/mcp/errors.ts:25-27`）には SDK v1.24.0 でのフォーマット変更が記録されており、構造化フィールドとフォールバック文字列マッチの両方を持つ防御的アプローチの根拠を示している。

### トランスポート自動フォールバック

MCP クライアント接続の `tryConnect` メソッドは、トランスポート種別が `auto` の場合に `streamable-http` から `sse` へのフォールバックを行う。フォールバック判定には `isTransportNotImplemented` を使い、404/405 エラーの場合のみ次のトランスポートを試行する。

```typescript
// src/mcp/client-connection.ts:639-688
private async tryConnect(
  transportType: TransportType
): Promise<MCPClientConnectionResult> {
  const transports: BaseTransportType[] =
    transportType === "auto" ? ["streamable-http", "sse"] : [transportType];

  for (const currentTransportType of transports) {
    // ...
    try {
      await this.client.connect(transport);
      return { state: MCPConnectionState.CONNECTED, transport: currentTransportType };
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      if (isUnauthorized(error)) {
        return { state: MCPConnectionState.AUTHENTICATING };
      }
      if (isTransportNotImplemented(error) && hasFallback) {
        continue; // Try the next transport
      }
      return { state: MCPConnectionState.FAILED, error };
    }
  }
}
```

このパターンでは、エラーの種別に応じて「認証フロー移行」「フォールバック」「即時失敗」の三つの分岐を明確に分離している。

### onError 階層と「飲み込み」パターン

`Agent` クラスの `onError` はオーバーライド可能なフックで、デフォルトではエラーを再スローする。内部処理（キュー、スケジュール、state 変更）では `onError` 呼び出しを二重の try-catch で囲み、`onError` 自体の例外を飲み込む。

```typescript
// src/index.ts:1901-1910 (_flushQueue 内)
} catch (e) {
  console.error(
    `queue callback "${row.callback}" failed after ${maxAttempts} attempts`,
    e
  );
  try {
    await this.onError(e);
  } catch {
    // swallow onError errors
  }
} finally {
  await this.dequeue(row.id);
}
```

このパターンは `_flushQueue`（1906-1909行）、スケジュールアラームハンドラ（2432-2435行）、state 変更フック（1267-1270行）の3箇所で一貫して使われている。エラーハンドリングフック自体がエラーを生む無限ループを防ぐ。

### SQLite マイグレーションのエラー選別

`addColumnIfNotExists` パターンは、`ALTER TABLE ADD COLUMN` の「duplicate column」エラーのみを無視し、他のエラーは再スローする。

```typescript
// src/index.ts:781-791
const addColumnIfNotExists = (sql: string) => {
  try {
    this.ctx.storage.sql.exec(sql);
  } catch (e) {
    // Only ignore "duplicate column" errors, re-throw unexpected errors
    const message = e instanceof Error ? e.message : String(e);
    if (!message.toLowerCase().includes("duplicate column")) {
      throw e;
    }
  }
};
```

注目すべきは、このメソッドが `this.sql` テンプレートタグを使わず `this.ctx.storage.sql.exec` を直接呼ぶ点である。コメントに「Use raw exec to avoid error logging through onError for expected failures」（780行）とあり、期待されるエラーが `onError` に流れないよう意図的にバイパスしている。

### コネクション状態マシンによるエラー状態管理

MCP クライアント接続は `MCPConnectionState` で状態を管理し、どの状態からも `FAILED` に遷移できる。discovery 失敗時は `CONNECTED` に戻してリトライ可能にし、認証エラー時は `AUTHENTICATING` に遷移して OAuth フローを開始する。

```typescript
// src/mcp/client-connection.ts:56-69
export const MCPConnectionState = {
  AUTHENTICATING: "authenticating",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  DISCOVERING: "discovering",
  READY: "ready",
  FAILED: "failed",
} as const;
```

discovery の失敗後に `CONNECTED` に戻す設計（`client-connection.ts:459`）は、一時的なエラーからの回復パスを明示的に提供している。

## パターンカタログ

- **Retry with Exponential Backoff** (振る舞い)
  - 解決する問題: 外部サービスの一時的な障害からの自動回復
  - 適用条件: ネットワーク呼び出しや DO RPC など、一時的に失敗しうる操作
  - コード例: `src/retries.ts:78-85` (Full Jitter backoff)
  - 注意点: `tryN` は `setTimeout` でブロックするため、長いバックオフは DO のイベントループを占有する

- **Error Classification / Strategy Pattern** (振る舞い)
  - 解決する問題: エラー種別ごとに異なるリカバリ戦略を適用する必要がある
  - 適用条件: MCP 接続時の認証エラー vs トランスポート未実装 vs 一般エラー
  - コード例: `src/mcp/client-connection.ts:662-680`
  - 注意点: 文字列マッチと構造化フィールドの両方を使うことで SDK 変更に強くなるが、偽陽性のリスクがある

- **State Machine** (振る舞い)
  - 解決する問題: 複雑な接続ライフサイクルの状態管理
  - 適用条件: 接続→認証→発見→準備完了という多段階の遷移がある場合
  - コード例: `src/mcp/client-connection.ts:56-69`
  - 注意点: 任意の状態から FAILED に遷移可能だが、FAILED からの回復パスも設計に含める

## Good Patterns

- **設定のイーガーバリデーション**: リトライ設定は `queue()`/`schedule()` 呼び出し時に即座に検証する。`{ baseDelayMs: 5000 }` のような一見正しい設定もデフォルト `maxDelayMs: 3000` との矛盾を即座に検出する。
  ```typescript
  // src/index.ts:1813-1815
  if (options?.retry) {
    validateRetryOptions(options.retry, this._resolvedOptions.retry);
  }
  ```

- **Capability 不整合の graceful degradation**: MCP サーバーが capability をアドバタイズしながら実際には対応メソッドを持たない場合、`-32601` (Method not found) エラーを空の結果に変換し、他の capability の発見を継続する。
  ```typescript
  // src/mcp/client-connection.ts:690-710
  private _capabilityErrorHandler<T>(empty: T, method: string) {
    return (e: { code: number }) => {
      if (e.code === -32601) {
        // server is badly behaved - log and return empty
        this._onObservabilityEvent.fire({ /* ... */ });
        return empty;
      }
      throw e;
    };
  }
  ```

- **リトライの観測可能性**: リトライの各試行で `queue:retry` / `schedule:retry` イベントを発火し、外部からリトライ挙動を監視できる。初回試行（attempt=1）はリトライではないためイベントを発火しない。
  ```typescript
  // src/index.ts:1875-1891 (_flushQueue 内)
  if (attempt > 1) {
    this.observability?.emit({
      type: "queue:retry",
      payload: { callback: row.callback, id: row.id, attempt, maxAttempts },
      // ...
    }, this.ctx);
  }
  ```

- **SqlError による失敗クエリの追跡**: SQL 実行エラーを `SqlError` でラップし、失敗したクエリ文字列を `query` プロパティに保持する。デバッグ時にどのクエリが失敗したかを即座に特定できる。
  ```typescript
  // src/index.ts:147-157
  export class SqlError extends Error {
    readonly query: string;
    constructor(query: string, cause: unknown) {
      const message = cause instanceof Error ? cause.message : String(cause);
      super(`SQL query failed: ${message}`, { cause });
      this.name = "SqlError";
      this.query = query;
    }
  }
  ```

## Anti-Patterns / 注意点

- **リトライ遅延によるイベントループブロッキング**: `tryN` は `setTimeout` でリトライ間隔を待つため、キュー処理中のリトライが後続アイテムの処理を head-of-line blocking する。`design/retries.md:165` にはこの制限が明記されている。
  - Bad: キュータスクにリトライ設定を付け、長いバックオフで後続タスクをブロックする
  - Better: 独立したリトライが必要な場合はコールバック内で `this.retry()` を使い、キューレベルのリトライは短いバックオフに留める

- **文字列ベースのエラー判定の脆弱性**: `isTransportNotImplemented` は `msg.includes("404")` で判定するため、メッセージ中にたまたま "404" を含む無関係なエラーに誤反応するリスクがある。テスト（`errors.test.ts:112-121`）では `"Not Found"` 文字列だけではマッチしないことを確認しているが、構造化コードがある場合は常にそちらを優先すべきである。
  - Bad: `if (msg.includes("404"))` のみでエラー種別を判定する
  - Better: 構造化フィールド（`error.code`）を最初にチェックし、フォールバックとして文字列マッチを使う（この SDK が実際に採用している方式）

## 導出ルール

- `[MUST]` リトライ設定はタスク登録時（enqueue / schedule 時）に即座に検証する。実行時まで遅延させるとデバッグ困難な遅延エラーになる
  - 根拠: `validateRetryOptions` は `queue()`, `schedule()`, `this.retry()` すべてで即座に呼ばれ、デフォルト値との交差検証も行う（`src/retries.ts:32-66`, `src/index.ts:1813-1815`）

- `[MUST]` エラーハンドリングフック（onError 相当）の呼び出しは二重の try-catch で囲み、フック自体の例外がシステム全体に波及しないようにする
  - 根拠: `_flushQueue`, アラームハンドラ, state 変更フックの3箇所すべてで `try { await this.onError(e) } catch { /* swallow */ }` パターンが使われている（`src/index.ts:1906-1909`）

- `[SHOULD]` リトライ基盤を単一の関数に集約し、すべてのサブシステムから共通で呼び出す。リトライループの重複実装を避けることでバックオフ・バリデーション・観測性の一貫性を保つ
  - 根拠: `tryN` が唯一のリトライループであり、キュー、スケジュール、ワークフロー、MCP 接続、`this.retry()` すべてが `tryN` に依存する（`design/retries.md:34`）

- `[SHOULD]` サーバーレス環境でリトライ設定を使う場合は、タスクと一緒にデータストアに永続化する。インメモリ保持のみだとハイバネーション / 再起動で失われる
  - 根拠: リトライ設定は SQLite の `retry_options TEXT` カラムに JSON で格納され、DO ハイバネーション越しに生存する（`design/retries.md:96-98`）

- `[SHOULD]` エラー分類では構造化フィールド（ステータスコード、`retryable` プロパティ等）を最優先し、文字列マッチはフォールバックに留める。依存ライブラリのバージョン変更に対する耐性が上がる
  - 根拠: `isTransportNotImplemented` は `getErrorCode` を先にチェックし、文字列マッチは SDK の旧バージョンとの互換性のためのフォールバックとして使用している（`src/mcp/errors.ts:28-39`）

- `[SHOULD]` 期待されるエラー（DDL のカラム重複等）を処理するパスは、汎用エラーハンドリングフックをバイパスする。期待されるエラーが監視ログに紛れ込むとノイズになる
  - 根拠: `addColumnIfNotExists` は `this.sql` を使わず `this.ctx.storage.sql.exec` を直接呼び、`onError` を回避している（`src/index.ts:780-791`）

- `[AVOID]` バックログがあるキューにリトライ遅延を適用すること。`setTimeout` ベースのリトライはイベントループをブロックし、後続タスクの head-of-line blocking を引き起こす
  - 根拠: `design/retries.md:165` に「Queue retries are head-of-line blocking — one failing item's retries delay all subsequent items」と明記されている

## 適用チェックリスト

- [ ] リトライ基盤が単一の関数/クラスに集約されているか。複数箇所に分散したリトライループがないか確認する
- [ ] リトライ設定（maxAttempts, backoff 等）はタスク登録時にバリデーションされているか。実行時まで遅延していないか
- [ ] エラーの種別に応じたリトライ判定（`shouldRetry` 相当）があるか。特にバックプレッシャー系エラー（429, overload）のリトライ除外
- [ ] `onError` 等のエラーハンドリングフックが二重 try-catch で保護されているか
- [ ] サーバーレス / ステートレス環境でリトライ設定をインメモリだけに保持していないか
- [ ] エラー分類が構造化フィールド優先・文字列マッチフォールバックの順になっているか
- [ ] リトライの各試行が観測可能か（ログ、メトリクス、イベント）。初回試行と再試行を区別しているか
- [ ] 期待されるエラー（マイグレーションの冪等性チェック等）が汎用エラーハンドリングパスを汚染していないか
