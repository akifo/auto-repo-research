# concurrency-patterns

> リポジトリ: cloudflare/partykit
> 分析日: 2026-02-25

## 概要

Durable Objects 上で動作するリアルタイムサーバーフレームワークにおける並行性制御パターンを分析する。partykit は `blockConcurrencyWhile` による初期化の排他制御、Hibernation API を活用した WebSocket のライフサイクル管理、DO Alarm によるスケジューリング、RxJS ベースのクライアントサイド並行制御など、多層にわたる並行性パターンを展開している。単一スレッドだが並行リクエストが発生する Durable Objects 環境で、状態の一貫性を保ちながらリソース効率を最大化する実践が体系的に見られる点が注目に値する。

## 背景にある原則

- **初期化は一度だけ、失敗しても復帰可能に**: 並行リクエストが到達する環境では初期化処理を排他制御しつつ、失敗時にシステムが永続的にブロックされない設計が必要。partykit は `blockConcurrencyWhile` 内でエラーを捕捉し、ステータスをリセットすることで次のリクエストが再初期化を試行できる (`packages/partyserver/src/index.ts:547-563`)。

- **プラットフォーム制約をプラクティスで補う**: Durable Objects の Hibernation は DO のメモリを解放する代わりにインメモリ状態を失う。y-partyserver はウェイクアップ時に既存接続へ sync step 1 を送信して状態を再構築する。プラットフォームの制約を理解し、アプリケーション層の設計で補償する原則 (`packages/y-partyserver/src/server/index.ts:339-349`)。

- **暗黙の副作用を明示的に無効化する**: ライブラリの内部タイマーやポーリングがシステムの省電力機構と干渉する場合、その副作用を積極的に無効化すべき。awareness プロトコルの `_checkInterval` を clearInterval することで Hibernation を妨げないようにしている (`packages/y-partyserver/src/server/index.ts:80-91`)。

- **バッチ化でネットワーク往復を償却する**: 個別の API 呼び出しが頻発する場面では、イベントループの境界でリクエストをバッチ化し、ネットワーク往復コストを償却すべき。partytracks の `BulkRequestDispatcher` は `setTimeout(0)` でマクロタスクの境界に蓄積を遅延させ、まとめて処理する (`packages/partytracks/src/client/Peer.utils.ts:24-81`)。

## 実例と分析

### blockConcurrencyWhile による初期化排他制御

Server クラスの `#ensureInitialized` は、Durable Objects の並行リクエスト環境における初期化の排他制御パターンを実装している。3 段階の状態遷移 (`zero` -> `starting` -> `started`) で管理し、`blockConcurrencyWhile` のコールバック内でエラーを捕捉してステータスを `zero` にリセットする。

重要なのはエラーの再スローを `blockConcurrencyWhile` の**外側**で行っている点。`blockConcurrencyWhile` 内でエラーをスローすると DO の input gate がデッドロック状態になり、後続のリクエストが永久にブロックされる。この実装はエラーを変数に一旦退避し、排他ブロック完了後に再スローすることでこの問題を回避している。

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

テストでは `FailingOnStartServer` がこのリトライ動作を検証している。1 回目の `onStart` は意図的に失敗し、2 回目で成功する設計。

```typescript
// packages/partyserver/src/tests/worker.ts:350-368
export class FailingOnStartServer extends Server {
  counter = 0;
  failCount = 0;

  async onStart() {
    this.counter++;
    if (this.counter === 1) {
      this.failCount++;
      throw new Error("onStart failed on first attempt");
    }
  }

  onRequest(): Response {
    return Response.json({
      counter: this.counter,
      failCount: this.failCount,
    });
  }
}
```

`#ensureInitialized` は全エントリポイント (`fetch`, `webSocketMessage`, `webSocketClose`, `webSocketError`, `alarm`) で呼ばれ、どの経路から DO にアクセスしても初期化が保証される。

### Hibernation / Wake-up サイクル

partyserver は `ConnectionManager` インターフェースの下に 2 つの実装を持つ Strategy パターンを採用している。

**InMemoryConnectionManager**: Hibernation 無効時に使用。`Map<string, Connection>` で接続を管理し、`close`/`error` イベントリスナーで自動削除する。

```typescript
// packages/partyserver/src/connection.ts:309-332
accept(connection: Connection, options: { tags: string[] }) {
  connection.accept();
  const tags = prepareTags(connection.id, options.tags);
  this.#connections.set(connection.id, connection);
  this.tags.set(connection, tags);

  Object.defineProperty(connection, "tags", {
    get: () => tags,
    configurable: true
  });

  const removeConnection = () => {
    this.#connections.delete(connection.id);
    connection.removeEventListener("close", removeConnection);
    connection.removeEventListener("error", removeConnection);
  };
  connection.addEventListener("close", removeConnection);
  connection.addEventListener("error", removeConnection);

  return connection;
}
```

**HibernatingConnectionManager**: Hibernation 有効時に使用。`DurableObjectState.getWebSockets()` / `acceptWebSocket()` を使い、プラットフォームに接続管理を委譲する。`getConnections` はイテレータパターンで遅延評価し、`isPartyServerWebSocket` でフィルタリングして外部から直接 accept された WebSocket を除外する。

```typescript
// packages/partyserver/src/connection.ts:200-236
class HibernatingConnectionIterator<T> implements IterableIterator<Connection<T>> {
  private index = 0;
  private sockets: WebSocket[] | undefined;
  // ...
  next(): IteratorResult<Connection<T>, number | undefined> {
    const sockets = this.sockets ?? (this.sockets = this.state.getWebSockets(this.tag));

    let socket: WebSocket;
    while ((socket = sockets[this.index++])) {
      if (socket.readyState === WebSocket.READY_STATE_OPEN) {
        if (!isPartyServerWebSocket(socket)) {
          continue;
        }
        const value = createLazyConnection(socket) as Connection<T>;
        return { done: false, value };
      }
    }
    return { done: true, value: undefined };
  }
}
```

y-partyserver は Hibernation wake-up 時の状態復元として、`onStart` 内で既存接続に sync step 1 を送信する。初回起動時は接続が 0 なのでノーオペレーションとなり、特別分岐なしで両方のケースに対応する。

```typescript
// packages/y-partyserver/src/server/index.ts:339-349
// After hibernation wake-up, the doc is empty but existing connections
// survive. Re-sync by sending sync step 1 to all connections — they'll
// respond with sync step 2 containing their full state.
// On first start there are no connections, so this is a no-op.
const syncEncoder = encoding.createEncoder();
encoding.writeVarUint(syncEncoder, messageSync);
syncProtocol.writeSyncStep1(syncEncoder, this.document);
const syncMessage = encoding.toUint8Array(syncEncoder);
for (const conn of this.getConnections()) {
  send(conn, syncMessage);
}
```

### awareness _checkInterval の無効化

y-partyserver は awareness プロトコルの内部タイマーを積極的に無効化している。`_checkInterval` は 15 秒ごとにローカルクロックを更新し 30 秒後にピアを除去する仕組みだが、このタイマーが動き続けると DO が Hibernation に入れない。代わりに `onClose` でのピアクリーンアップに依存する設計。

```typescript
// packages/y-partyserver/src/server/index.ts:80-91
// Disable the awareness protocol's built-in check interval.
// It renews the local clock every 15s and removes peers after 30s,
// but we handle peer cleanup via onClose instead. Clearing it here
// prevents it from defeating Durable Object hibernation.
clearInterval(
  (
    this.awareness as unknown as {
      _checkInterval: ReturnType<typeof setInterval>;
    }
  )._checkInterval,
);
```

### DO Alarm スケジューリング

partywhen の `Scheduler` は Alarm API を活用したタスクスケジューラを実装している。アーキテクチャ上の特徴は、SQL テーブルをタスクキューとして使い、`setAlarm` で次の実行時刻のみをスケジュールする点。`alarm()` では期限到来タスクを一括取得・実行し、cron タスクは次回実行時刻を UPDATE、ワンタイムタスクは DELETE する。

```typescript
// packages/partywhen/src/index.ts:274-307
async alarm(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  const { result: tasks } = this.querySql<SqlTask>([
    { sql: "SELECT * FROM tasks WHERE time <= ?", params: [now] }
  ]);

  for (const row of tasks || []) {
    const task = this.rowToTask(row);
    await this.executeTask(task);

    if (task.type === "cron") {
      const nextExecutionTime = this.getNextCronTime(task.cron);
      const nextTimestamp = Math.floor(nextExecutionTime.getTime() / 1000);
      this.querySql([
        {
          sql: "UPDATE tasks SET time = ? WHERE id = ?",
          params: [nextTimestamp, task.id]
        }
      ]);
    } else {
      this.querySql([
        { sql: "DELETE FROM tasks WHERE id = ?", params: [task.id] }
      ]);
    }
  }

  await this.scheduleNextAlarm();
}
```

コンストラクタでは `blockConcurrencyWhile` を使ってテーブル作成とペンディングタスクの実行を排他的に行う。

```typescript
// packages/partywhen/src/index.ts:82-105
constructor(state: DurableObjectState, env: Env) {
  super(state, env);
  void this.ctx.blockConcurrencyWhile(async () => {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS tasks (...)`
    );
    await this.alarm();
  });
}
```

todo-sync フィクスチャではより軽量なパターンとして、データ変更時にアラームを設定して 24 時間後に論理削除済みレコードを物理削除する遅延クリーンアップを実装している。

```typescript
// fixtures/todo-sync/src/server.ts:86-93
async onAlarm() {
  this.sql2(
    "DELETE FROM todos WHERE deleted_at < ?",
    Date.now() - 24 * 60 * 60 * 1000
  );
}
```

### RxJS ベースのクライアントサイド並行制御

partytracks は 3 つの並行制御プリミティブを組み合わせて WebRTC セッション管理を行っている。

**FIFOScheduler**: Promise チェーンでタスクの逐次実行を保証する。WebRTC のオファー/アンサー交換は同時に複数実行できないため、この制約をスケジューラで強制する。

```typescript
// packages/partytracks/src/client/Peer.utils.ts:5-22
export class FIFOScheduler {
  #schedulerChain: Promise<void>;
  constructor() {
    this.#schedulerChain = Promise.resolve();
  }

  schedule<T>(task: Task<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.#schedulerChain = this.#schedulerChain.then(async () => {
        try {
          resolve(await task());
        } catch (error) {
          reject(error as unknown);
        }
      });
    });
  }
}
```

**BulkRequestDispatcher**: イベントループの境界（`setTimeout(0)` のマクロタスク）でリクエストをバッチ化する。同期的に呼ばれた複数の push/pull/close 操作が単一の API 呼び出しにまとめられる。バッチサイズ上限（デフォルト 64、partytracks では 32）に達すると新しいバッチを開始する。

```typescript
// packages/partytracks/src/client/Peer.utils.ts:36-80
doBulkRequest(
  params: RequestEntryParams,
  bulkRequestFunc: (bulkCopy: RequestEntryParams[]) => Promise<BulkResponse>
): Promise<BulkResponse> {
  if (this.#currentBatch.length >= this.#batchSizeLimit) {
    this.#currentBatch = [];
    this.#currentBulkResponse = null;
  }
  this.#currentBatch.push(params);
  if (this.#currentBulkResponse != null) {
    return this.#currentBulkResponse;
  }
  const batch = this.#currentBatch;
  this.#currentBulkResponse = new Promise((resolve, reject) => {
    setTimeout(() => {
      this.#currentBulkResponse = null;
      const batchCopy = batch.splice(0, batch.length);
      const p = bulkRequestFunc(batchCopy);
      p.then((r) => resolve(r)).catch((err) => reject(err));
    }, 0);
  });
  return this.#currentBulkResponse;
}
```

**retryWithBackoff**: RxJS の `retry` オペレータを指数バックオフ付きで構成するヘルパー。`resetOnSuccess: true` により、成功するとリトライカウントがリセットされ、一時的なネットワーク障害からの復旧が自然に処理される。

```typescript
// packages/partytracks/src/client/rxjs-helpers.ts:21-51
export function retryWithBackoff<T>(config: BackoffConfig = {}) {
  // ...
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

### 接続状態の Hibernation 永続化

y-partyserver は awareness のクライアント ID を `connection.setState()` で保存することで、Hibernation を跨いだ状態復元を実現している。インメモリの Map の代わりに WebSocket attachment を使うことで、DO がメモリを解放しても接続ごとの状態が失われない。

```typescript
// packages/y-partyserver/src/server/index.ts:44-70
const AWARENESS_IDS_KEY = "__ypsAwarenessIds";

function getAwarenessIds(conn: Connection): number[] {
  try {
    const state = conn.state as YServerConnectionState | null;
    return state?.[AWARENESS_IDS_KEY] ?? [];
  } catch {
    return [];
  }
}

function setAwarenessIds(conn: Connection, ids: number[]): void {
  try {
    conn.setState((prev: YServerConnectionState | null) => ({
      ...prev,
      [AWARENESS_IDS_KEY]: ids,
    }));
  } catch {
    // ignore — may fail if connection is already closed
  }
}
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: Hibernation の有無でコネクション管理の実装が異なるが、利用側のコードを変えたくない
  - 適用条件: ランタイムの設定や環境に応じて同一インターフェースの実装を切り替える場合
  - コード例: `packages/partyserver/src/connection.ts:268-273` (`ConnectionManager` インターフェース)、`InMemoryConnectionManager` と `HibernatingConnectionManager` の 2 実装
  - 注意点: Strategy の選択は `Server.options.hibernate` の静的プロパティで決定され、インスタンスごとの切り替えは不可

- **Iterator パターン** (分類: 振る舞い)
  - 解決する問題: Hibernation 時の接続一覧は `getWebSockets()` で取得するが、フィルタリング（open 状態のみ、PartyServer 管理のみ）が必要
  - 適用条件: コレクションの走査にフィルタリングやラッピングのロジックを含む場合
  - コード例: `packages/partyserver/src/connection.ts:200-236` (`HibernatingConnectionIterator`)
  - 注意点: 遅延初期化 (`this.sockets ?? ...`) によりイテレータ作成時点ではなく最初の `next()` 呼び出し時にソケット一覧を取得する

## Good Patterns

- **エラーを排他ブロック外で再スロー**: `blockConcurrencyWhile` 内でエラーを捕捉し、変数に退避してからブロック外で再スローする。これにより input gate のデッドロックを防ぎ、後続リクエストのリトライを可能にする。

```typescript
// packages/partyserver/src/index.ts:550-563
let error: unknown;
await this.ctx.blockConcurrencyWhile(async () => {
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

- **初回起動とウェイクアップを同一コードパスで処理**: sync step 1 の送信は初回起動時（接続 0 件 = ノーオペレーション）とウェイクアップ時（既存接続への再同期）の両方を分岐なしで処理する。条件分岐を排除することでコードの単純さとバグの入り込みにくさを確保する。

```typescript
// packages/y-partyserver/src/server/index.ts:339-349
for (const conn of this.getConnections()) {
  send(conn, syncMessage);
}
```

- **イベントループ境界でのバッチ化**: `setTimeout(0)` を利用して同一イベントループ内のリクエストを蓄積し、マクロタスクの境界で一括送信する。これによりネットワーク往復回数を大幅に削減する。

```typescript
// packages/partytracks/src/client/Peer.utils.ts:52-77
this.#currentBulkResponse = new Promise((resolve, reject) => {
  setTimeout(() => {
    this.#currentBulkResponse = null;
    const batchCopy = batch.splice(0, batch.length);
    const p = bulkRequestFunc(batchCopy);
    p.then((r) => resolve(r)).catch((err) => reject(err));
  }, 0);
});
```

## Anti-Patterns / 注意点

- **排他ブロック内でのエラースロー**: `blockConcurrencyWhile` のコールバック内で直接エラーをスローすると、DO の input gate がデッドロックし、後続の全リクエストが永久にブロックされる。

Bad:

```typescript
await this.ctx.blockConcurrencyWhile(async () => {
  await this.onStart(); // ここでスローすると input gate が壊れる
});
```

Better:

```typescript
let error: unknown;
await this.ctx.blockConcurrencyWhile(async () => {
  try {
    await this.onStart();
  } catch (e) {
    this.#status = "zero";
    error = e;
  }
});
if (error) throw error;
```

- **Hibernation 環境でのインメモリ状態依存**: Hibernation が有効な DO でインメモリ Map や変数に接続ごとの状態を保存すると、ウェイクアップ時に失われる。`connection.setState()` (WebSocket attachment) や DO storage を使うべき。

Bad:

```typescript
const connectedClients = new Map<string, number[]>(); // Hibernation で消える
```

Better:

```typescript
// connection.setState() で WebSocket attachment に保存
setAwarenessIds(conn, [...currentIds]);
```

- **ライブラリの内部タイマー放置**: 省電力・Hibernation 環境でライブラリの内部タイマー（ポーリング、ハートビート等）を放置すると、システムが休止状態に入れない。

Bad:

```typescript
const awareness = new awarenessProtocol.Awareness(doc);
// _checkInterval が 15 秒ごとに発火し続ける
```

Better:

```typescript
const awareness = new awarenessProtocol.Awareness(doc);
clearInterval(awareness._checkInterval); // 明示的に無効化
```

## 導出ルール

- `[MUST]` 排他制御ブロック（`blockConcurrencyWhile` 等）内でエラーが発生した場合、ブロック外でエラーを再スローし、初期化状態をリセットして後続リクエストのリトライを可能にする
  - 根拠: partyserver の `#ensureInitialized` はエラーを変数に退避してブロック外で再スローすることで input gate デッドロックを防止している (`packages/partyserver/src/index.ts:550-563`)

- `[MUST]` 全エントリポイント（HTTP リクエスト、WebSocket メッセージ、アラーム等）で初期化保証を呼び出し、どの経路からアクセスされても一貫した状態を保証する
  - 根拠: partyserver は `fetch`, `webSocketMessage`, `webSocketClose`, `webSocketError`, `alarm` の全 5 箇所で `#ensureInitialized()` を呼んでいる

- `[SHOULD]` 初回起動とリカバリ（再起動・ウェイクアップ）を同一コードパスで処理し、条件分岐を排除する
  - 根拠: y-partyserver の `onStart` は sync step 1 の送信を初回（接続 0 件 = ノーオペレーション）とウェイクアップ（既存接続への再同期）で分岐なしに処理する (`packages/y-partyserver/src/server/index.ts:339-349`)

- `[SHOULD]` 同一イベントループ内で発生する複数の API 呼び出しは、マクロタスク境界（`setTimeout(0)`）でバッチ化してネットワーク往復を削減する
  - 根拠: partytracks の `BulkRequestDispatcher` は push/pull/close リクエストをバッチ化し、単一の API 呼び出しにまとめている (`packages/partytracks/src/client/Peer.utils.ts:24-81`)

- `[SHOULD]` 省電力・Hibernation 環境では、サードパーティライブラリの内部タイマーやポーリングを監査し、不要なものを明示的に無効化する
  - 根拠: y-partyserver は awareness プロトコルの `_checkInterval` を `clearInterval` で無効化し、Hibernation を妨げないようにしている (`packages/y-partyserver/src/server/index.ts:80-91`)

- `[SHOULD]` Promise チェーンによる逐次実行スケジューラで、状態変更を伴う非同期操作（WebRTC ネゴシエーション等）の同時実行を防ぐ
  - 根拠: partytracks の `FIFOScheduler` は SDP オファー/アンサー交換を直列化し、シグナリング状態の競合を防止している (`packages/partytracks/src/client/Peer.utils.ts:5-22`)

- `[AVOID]` 休止・再起動可能な環境で、接続ごとの状態をインメモリのコレクション（Map, Set, 配列）に保持する -- WebSocket attachment やプラットフォーム提供の永続ストレージを使う
  - 根拠: y-partyserver は awareness ID をインメモリ Map ではなく `connection.setState()` で WebSocket attachment に保存し、Hibernation を跨いで状態を維持している (`packages/y-partyserver/src/server/index.ts:44-70`)

## 適用チェックリスト

- [ ] 初期化処理が排他制御されているか確認し、エラー時にデッドロックしない設計（エラーのブロック外再スロー + 状態リセット）を適用する
- [ ] 全エントリポイント（HTTP, WebSocket, タイマー, アラーム等）で初期化保証が呼ばれているか監査する
- [ ] Hibernation / プロセス再起動がある環境で、インメモリ状態に依存している箇所を洗い出し、永続化メカニズムに移行する
- [ ] 使用しているサードパーティライブラリの内部タイマー・ポーリングを監査し、省電力 / Hibernation を妨げるものがないか確認する
- [ ] 同一イベントループ内で発生する複数の API 呼び出しをバッチ化できる箇所がないか検討する
- [ ] 状態変更を伴う非同期操作（ネゴシエーション、データベース書き込み等）に逐次実行の制約が必要かを評価する
- [ ] Alarm / cron ベースのスケジューリングで、次回実行時刻のみをスケジュールする最小限のアラーム設計を採用しているか確認する
