# error-handling-idioms

> リポジトリ: cloudflare/partykit
> 分析日: 2026-02-25

## 概要

WebSocket サーバー (partyserver)、自動再接続クライアント (partysocket)、WebRTC リアルタイム通信 (partytracks)、CRDT 同期 (y-partyserver)、Pub/Sub (partysub)、RPC (partyfn/partysync) という多層アーキテクチャにおけるエラーハンドリングイディオムを横断的に分析した。
特に、Durable Object の input gate デッドロック回避、WebSocket エラーの HTTP レスポンスへの変換、RxJS Observable によるリアクティブなリトライ、fire-and-forget パターンでのエラー封じ込めなど、分散リアルタイムシステム特有のプラクティスが体系的に適用されている点が注目に値する。

## 背景にある原則

- **エラー伝播チャネルはトランスポートに合わせる**: WebSocket リクエストに対して HTTP エラーレスポンスを返しても、Chrome DevTools では body が表示されない。そのためエラー情報は WebSocket フレーム経由で送り、開発者が確実にデバッグ情報を得られるようにすべき（`packages/partyserver/src/index.ts:456-464`）。
- **排他ブロック内でエラーを飲み込み、外で再スローする**: Durable Object の `blockConcurrencyWhile` 内で例外が発生すると input gate がデッドロック状態に陥りうる。エラーをキャッチして状態をリセットし、ブロック外で再スローすることで、後続リクエストがリトライ可能な状態を維持すべき（`packages/partyserver/src/index.ts:547-563`）。
- **壊れた接続への送信は黙殺する**: WebSocket 接続は任意のタイミングで切断されうる。`send()` の失敗を致命的エラーとして扱うのではなく、try-catch で握りつぶして処理を継続することで、1 つの壊れた接続がシステム全体に波及するのを防ぐべき（`packages/y-partyserver/src/server/index.ts:125-138`、`packages/partyserver/src/index.ts:629-636`）。
- **リトライ可能なエラーとユーザー起因のエラーを区別する**: ブラウザ API のエラー（`NotFoundError`、`NotAllowedError` 等）はリトライしても改善しないため `complete()` で処理を終了し、それ以外のシステムエラーのみ `error()` として上位に伝播させるべき（`packages/partytracks/src/client/resilientTrack$.ts:222-235`、`packages/partytracks/src/client/screenshare$.ts:17-25`）。

## 実例と分析

### Durable Object input gate デッドロック回避

`Server.#ensureInitialized` は `blockConcurrencyWhile` 内で `onStart` を呼び出す。この排他ブロック内でエラーをスローすると、input gate が永久にブロックされる可能性がある。そこでエラーを一旦変数にキャプチャし、状態を `"zero"` にリセットしてブロックを正常に抜けてから再スローする。

```typescript
// packages/partyserver/src/index.ts:547-563
async #ensureInitialized(): Promise<void> {
  if (this.#status === "started") return;
  await this.#hydrateNameFromStorage();
  let error: unknown;
  await this.ctx.blockConcurrencyWhile(async () => {
    this.#status = "starting";
    try {
      await this.onStart(this.#_props);
      this.#status = "started";
    } catch (e) {
      this.#status = "zero";
      error = e;
    }
  });
  // Re-throw outside blockConcurrencyWhile so the DO's input gate
  // isn't permanently broken, allowing subsequent requests to retry.
  if (error) throw error;
}
```

### WebSocket エラーの WebSocket フレーム経由送信

`Server.fetch` の catch ブロックでは、リクエストが WebSocket アップグレードかどうかを判定し、WebSocket の場合は新しい WebSocketPair を作成してエラーメッセージを WebSocket フレームとして送信してから close する。

```typescript
// packages/partyserver/src/index.ts:450-468
} catch (err) {
  console.error(
    `Error in ${this.#ParentClass.name}:${this.#_name ?? "<unnamed>"} fetch:`,
    err
  );
  if (!(err instanceof Error)) throw err;
  if (request.headers.get("Upgrade") === "websocket") {
    // Annoyingly, if we return an HTTP error in response to a WebSocket request, Chrome devtools
    // won't show us the response body! So... let's send a WebSocket response with an error
    // frame instead.
    const pair = new WebSocketPair();
    pair[1].accept();
    pair[1].send(JSON.stringify({ error: err.stack }));
    pair[1].close(1011, "Uncaught exception during session setup");
    return new Response(null, { status: 101, webSocket: pair[0] });
  } else {
    return new Response(err.stack, { status: 500 });
  }
}
```

### onException フック: ユーザーオーバーライド可能なエラーハンドラ

`Server.sql` メソッドでは SQL 実行エラー時に `this.onException(e)` を呼び出す。`onException` はデフォルトでは `console.error` だけだが、ユーザーがオーバーライドして独自のエラーレポーティングやリカバリロジックを挿入できる。

```typescript
// packages/partyserver/src/index.ts:351-365
sql<T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) {
  let query = "";
  try {
    query = strings.reduce(
      (acc, str, i) => acc + str + (i < values.length ? "?" : ""),
      ""
    );
    return [...this.ctx.storage.sql.exec(query, ...values)] as T[];
  } catch (e) {
    console.error(`failed to execute sql query: ${query}`, e);
    throw this.onException(e);
  }
}
```

### ReconnectingWebSocket: 指数バックオフと接続タイムアウト

`partysocket` の `ReconnectingWebSocket` は、接続失敗時に指数バックオフで自動再接続を試みる。初期遅延にランダムオフセットを加え（thundering herd 対策）、`maxReconnectionDelay` で上限をキャップする。接続タイムアウトは `_handleTimeout` で ErrorEvent に変換して通常のエラーフローに合流させる。

```typescript
// packages/partysocket/src/ws.ts:125-135
const DEFAULT = {
  maxReconnectionDelay: 10000,
  minReconnectionDelay: 1000 + Math.random() * 4000,
  minUptime: 5000,
  reconnectionDelayGrowFactor: 1.3,
  connectionTimeout: 4000,
  maxRetries: Number.POSITIVE_INFINITY,
  maxEnqueuedMessages: Number.POSITIVE_INFINITY,
  startClosed: false,
  debug: false,
};
```

```typescript
// packages/partysocket/src/ws.ts:520-523
private _handleTimeout() {
  this._debug("timeout event");
  this._handleError(new Events.ErrorEvent(Error("TIMEOUT"), this));
}
```

### RxJS retryWithBackoff: 宣言的リトライ

`partytracks` では RxJS の `retry` オペレータを指数バックオフでラップした `retryWithBackoff` を提供する。Observable チェーンに `.pipe(retryWithBackoff())` と追加するだけでリトライロジックが適用される。`resetOnSuccess: true` により成功時にリトライカウンタがリセットされる。

```typescript
// packages/partytracks/src/client/rxjs-helpers.ts:21-51
export function retryWithBackoff<T>(config: BackoffConfig = {}) {
  const mergedConfig = { ...configDefaults, ...config };
  const { maxRetries, initialDelay, maxDelay, backoffFactor, resetOnSuccess } = mergedConfig;

  return (source: Observable<T>): Observable<T> =>
    source.pipe(
      retry({
        count: maxRetries,
        resetOnSuccess,
        delay: (_err, count) => {
          const delay = Math.min(
            initialDelay * backoffFactor ** (count - 1),
            maxDelay,
          );
          return timer(delay);
        },
      }),
    );
}
```

### Fire-and-forget パブリッシュのエラー封じ込め

`partysub` の `broadcastPubSubMessage` では、他ノードへのパブリッシュを `.catch()` でログ出力のみ行い、呼び出し元には伝播させない。1 ノードの障害がパブリッシュ全体を止めないための意図的な設計。

```typescript
// packages/partysub/src/server/index.ts:105-108
stub.publish(topic, data).catch((err: Error) => {
  console.error(`Error publishing to ${name}`);
  console.error(err);
});
```

### 壊れた接続への send() 黙殺パターン

`y-partyserver` の `send` 関数は readyState チェック + try-catch の二段構えで、壊れた接続への送信を安全に無視する。同様のパターンが `partyserver` の `#sendMessageToConnection` でも使われ、失敗時は close(1011) で接続を終了させる。

```typescript
// packages/y-partyserver/src/server/index.ts:125-138
function send(conn: Connection, m: Uint8Array): void {
  if (
    conn.readyState !== undefined
    && conn.readyState !== wsReadyStateConnecting
    && conn.readyState !== wsReadyStateOpen
  ) {
    return;
  }
  try {
    conn.send(m);
  } catch {
    // connection is broken, ignore
  }
}
```

### デバイスエラーの分類と段階的フォールバック

`resilientTrack$` は複数デバイスを `concat` で順番に試し、`NotFoundError` や `NotReadableError` は `complete()` で次のデバイスに進む。全デバイスを試し尽くすと `DevicesExhaustedError` をスローする。ユーザーキャンセル (`NotAllowedError`) はスクリーンシェアで `complete()` として処理する。

```typescript
// packages/partytracks/src/client/resilientTrack$.ts:222-235
.catch((err) => {
  if (
    err instanceof Error &&
    (err.name === "NotFoundError" ||
      err.name === "NotReadableError")
  ) {
    subscriber.complete();
  } else {
    subscriber.error(err);
  }
});
```

### RPC タイムアウトと構造化エラーレスポンス

`partyfn` の `RPCClient` は Promise.withResolvers + setTimeout で RPC タイムアウトを実装する。`partysync` の `SyncServer.onMessage` では JSON パースエラーを `RpcException` として、ビジネスロジックエラーを `RpcResponse` の `error` タイプとして構造化して返す。

```typescript
// packages/partyfn/src/index.ts:72-79
private rpc(id: string, timeout = 10000) {
  const resolver = Promise.withResolvers();
  this.rpcCache.set(id, resolver);
  setTimeout(() => {
    this.rpcCache.delete(id);
    resolver.reject(new Error(`RPC call ${id} timed out`));
  }, timeout);
  return resolver.promise;
}
```

```typescript
// packages/partysync/src/server/index.ts:49-59
try {
  json = JSON.parse(message);
} catch (err) {
  connection.send(
    JSON.stringify(
      {
        type: "exception",
        rpc: true,
        exception: [`Failed to parse message: ${(err as Error).message}`],
      } satisfies RpcException,
    ),
  );
  return;
}
```

## パターンカタログ

- **Circuit Breaker 変種 — Observable Error-Driven Reconnection** (分類: 振る舞い)
  - 解決する問題: WebRTC PeerConnection が `failed`/`closed` 状態になったとき、自動的に新しいセッションを確立する
  - 適用条件: ステートフルなコネクションが外部障害で壊れうるリアルタイム通信
  - コード例: `packages/partytracks/src/client/PartyTracks.ts:779-800` — `subscriber.error()` で Observable チェーンを終了させ、`retryWithBackoff` が新しいセッション作成をトリガーする
  - 注意点: `retryWithBackoff` の `resetOnSuccess: true` がないと、間欠的障害でもリトライ上限に達してしまう

- **Strategy パターン — onException フック** (分類: 振る舞い)
  - 解決する問題: フレームワーク内部のエラーハンドリングをユーザーがカスタマイズしたい
  - 適用条件: ライブラリ/フレームワーク提供者がエラー処理の拡張ポイントを提供する場面
  - コード例: `packages/partyserver/src/index.ts:759-767`、`packages/partyfn/src/index.ts:115-118`
  - 注意点: デフォルト実装が console.error + console.info で「オーバーライドしてください」と案内するのは開発体験として良い

## Good Patterns

- **排他ブロック外再スロー**: `blockConcurrencyWhile` 内のエラーを変数にキャプチャし、ブロック外で再スローすることで input gate デッドロックを防止する。状態マシンを `"zero"` にリセットすることで後続リクエストがリトライ可能になる。

```typescript
// packages/partyserver/src/index.ts:547-563
let error: unknown;
await this.ctx.blockConcurrencyWhile(async () => {
  this.#status = "starting";
  try {
    await this.onStart(this.#_props);
    this.#status = "started";
  } catch (e) {
    this.#status = "zero";
    error = e;
  }
});
if (error) throw error;
```

- **トランスポート適応型エラーレスポンス**: リクエストの Upgrade ヘッダを見て、WebSocket なら WebSocket フレームで、HTTP なら HTTP レスポンスでエラーを返す。ブラウザの DevTools 制約を考慮した実用的なパターン。

```typescript
// packages/partyserver/src/index.ts:456-468
if (request.headers.get("Upgrade") === "websocket") {
  const pair = new WebSocketPair();
  pair[1].accept();
  pair[1].send(JSON.stringify({ error: err.stack }));
  pair[1].close(1011, "Uncaught exception during session setup");
  return new Response(null, { status: 101, webSocket: pair[0] });
} else {
  return new Response(err.stack, { status: 500 });
}
```

- **初期遅延ランダムオフセット**: `minReconnectionDelay: 1000 + Math.random() * 4000` により、大量クライアントの同時再接続 (thundering herd) を回避する。

```typescript
// packages/partysocket/src/ws.ts:127
minReconnectionDelay: 1000 + Math.random() * 4000,
```

- **エラー種別による分岐 (complete vs error)**: デバイスの `NotFoundError` / `NotReadableError` は次のデバイスに進み (`complete`)、未知のエラーは `error` として伝播させる。ユーザー操作キャンセル (`NotAllowedError`) も `complete` で処理する。

## Anti-Patterns / 注意点

- **認証失敗時の alert + location.reload**: `partytracks` の `#fetchWithRecordedHistory` で Access セッション期限切れ時に `alert()` + `location.reload()` を行っている。エラーハンドリングとしては脆弱で、テスト困難。

```typescript
// Bad: packages/partytracks/src/client/PartyTracks.ts:201-204
if (response.status === 0) {
  alert("Access session is expired, reloading page.");
  location.reload();
}
```

```typescript
// Better: コールバックまたは Observable でエラーを通知し、UI 層で処理する
if (response.status === 0) {
  this.sessionError$.next("Access session expired");
  throw new SessionExpiredError();
}
```

- **catch 内での一律 console.error のみ**: `partysub` の fire-and-forget `.catch()` はログ出力のみで、永続的な障害の検知手段がない。メトリクス収集やアラート発火のフックがないと、サイレントなデータロスに気付けない。

```typescript
// Bad: エラーログのみで障害が埋もれる
stub.publish(topic, data).catch((err: Error) => {
  console.error(`Error publishing to ${name}`);
  console.error(err);
});
```

```typescript
// Better: カウンタやメトリクスを加える
stub.publish(topic, data).catch((err: Error) => {
  this.publishFailureCount++;
  console.error(`Error publishing to ${name}`, err);
  if (this.onPublishError) this.onPublishError(name, err);
});
```

## 導出ルール

- `[MUST]` 排他ブロック (mutex / blockConcurrencyWhile) 内でエラーが発生した場合、ブロック内でキャッチして状態をリセットし、ブロック外で再スローする — ブロック内でスローするとロック解放やゲート開放が行われず、後続処理が永久にブロックされる
  - 根拠: `packages/partyserver/src/index.ts:547-563` で input gate デッドロック防止のために実装

- `[MUST]` WebSocket リクエストに対するエラーレスポンスは、HTTP ステータスコードではなく WebSocket フレーム経由で送信する — ブラウザの DevTools は WebSocket アップグレード要求への HTTP エラーレスポンスのボディを表示しないため、デバッグ情報が失われる
  - 根拠: `packages/partyserver/src/index.ts:456-464` のコメントに Chrome DevTools の制約が明記

- `[SHOULD]` クライアント側の自動再接続では、初期遅延にランダムオフセットを加えて thundering herd を回避する — サーバー障害後に大量クライアントが同一タイミングで再接続すると回復を遅延させる
  - 根拠: `packages/partysocket/src/ws.ts:127` の `1000 + Math.random() * 4000` による分散

- `[SHOULD]` WebSocket の `send()` 呼び出しは readyState チェック + try-catch で保護し、失敗を黙殺する — 個別接続の障害がブロードキャストや他の処理全体を停止させてはならない
  - 根拠: `packages/y-partyserver/src/server/index.ts:125-138` と `packages/partyserver/src/index.ts:629-636` で一貫して適用

- `[SHOULD]` リトライ不可能なエラー（ユーザーキャンセル、デバイス不在等）はリトライループに入れず即座に別の処理パスに切り替える — `NotFoundError`/`NotAllowedError` のような確定的失敗をリトライしても改善しない
  - 根拠: `packages/partytracks/src/client/resilientTrack$.ts:222-235` で `NotFoundError` を `complete()` に変換し次のデバイスへフォールバック

- `[SHOULD]` fire-and-forget の非同期処理には `.catch()` を必ず付与し、未処理 Promise rejection を防止する — ログ出力だけでもスタックトレースの消失を防ぎ、障害調査を可能にする
  - 根拠: `packages/partysub/src/server/index.ts:105-108` と `packages/y-partyserver/src/server/index.ts:322-328` で一貫して `.catch()` を付与

- `[AVOID]` RPC / WebSocket メッセージハンドラ内でエラーを飲み込んで黙殺する — エラーは構造化された形式 (`RpcException`/`RpcResponse` の `error` タイプ) で呼び出し元に返し、クライアントが適切にハンドリングできるようにする
  - 根拠: `packages/partysync/src/server/index.ts:49-59` と `packages/partysync/src/server/index.ts:114-124` で JSON パースエラーとビジネスロジックエラーを区別して構造化レスポンスを返却

## 適用チェックリスト

- [ ] 排他ブロック (mutex, lock, transaction) 内のエラーハンドリングで、ブロック内キャッチ→状態リセット→ブロック外再スローのパターンを適用しているか
- [ ] WebSocket エンドポイントのエラーレスポンスが、HTTP ではなく WebSocket フレーム経由で送信されているか
- [ ] 自動再接続の初期遅延にランダムオフセット（ジッター）が含まれているか
- [ ] WebSocket `send()` が readyState チェックと try-catch で保護されているか
- [ ] ブラウザ API エラー（NotFoundError, NotAllowedError 等）がリトライループから除外されているか
- [ ] fire-and-forget の Promise に `.catch()` が付与されているか
- [ ] RPC エラーが構造化された形式でクライアントに返されているか（例外とビジネスエラーの区別）
- [ ] エラーフック（onException, onError）がユーザーにオーバーライド可能なインターフェースとして提供されているか
