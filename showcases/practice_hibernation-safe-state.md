# practice: hibernation-safe-state

> 出典: [repos/cloudflare/partykit](../repos/cloudflare/partykit/), [repos/cloudflare/agents](../repos/cloudflare/agents/)
> カテゴリ: practice

## 概要

Hibernation やプロセス再起動が発生する環境では、インメモリの Map/Set/変数に保持した接続ごとの状態が消失する。WebSocket attachment やプラットフォーム提供の永続ストレージ（SQLite, KV）に状態を保存し、ネームスペースプレフィックスで複数レイヤーの衝突を防ぐことで、休止サイクルを跨いだ状態の一貫性を確保する。cloudflare/partykit と cloudflare/agents の両リポジトリで確認された横断パターンであり、Durable Objects に限らずサーバーレス環境全般に応用できる。

## 背景・文脈

Cloudflare Durable Objects の Hibernation API は、WebSocket 接続を維持したまま DO のメモリを解放する。ウェイクアップ時には新しい JavaScript コンテキストが生成されるため、インスタンス変数・Map・WeakMap はすべて空になる。一方、WebSocket attachment（`serializeAttachment`/`deserializeAttachment`）と DO Storage（KV/SQL）はプラットフォームが管理するため、Hibernation を跨いで生存する。

この問題は Durable Objects に固有ではない。AWS Lambda のコールドスタート、Cloud Run のスケールイン/アウト、Kubernetes の Pod 再起動など、「プロセスが透過的に再起動される」環境すべてに共通する。要点は「インメモリ状態を一時キャッシュとして扱い、永続ストレージを真実源にする」設計原則にある。

partykit はこのパターンを WebSocket attachment レイヤーで、agents は SQLite レイヤーで実装しており、状態の生存期間に応じてストレージを使い分ける多層設計の実例となっている。

## 実装パターン

### 1. ネームスペースプレフィックスによるメタデータ分離

プラットフォーム内部の状態とユーザーの状態を同一ストレージに保存する場合、予約済みプレフィックスで名前空間を分離する。partykit は `__pk`/`__user`、agents は `_cf_` プレフィックスを使用する。

```typescript
// cloudflare/partykit — packages/partyserver/src/connection.ts:31-37
type ConnectionAttachments = {
  __pk: {
    id: string;
    tags: string[];
  };
  __user?: unknown;
};
```

`serializeAttachment` のラッパーが `__user` だけを書き換え、`__pk` を保護する。

```typescript
// cloudflare/partykit — packages/partyserver/src/connection.ts:179-189
serializeAttachment: {
  configurable: true,
  value: function serializeAttachment<T = unknown>(attachment: T) {
    const setting = {
      ...attachments.get(ws),
      __user: attachment ?? null
    };
    attachments.set(ws, setting);
  }
}
```

agents は `_cf_readonly` など `_cf_` プレフィックス付きの内部フラグを `connection.state` に格納し、getter/setter のラップでユーザーから隠蔽する。

```typescript
// cloudflare/agents — src/index.ts:1303-1304
// べき等な再ラップ: WeakMap にエントリがあれば即座に返る
private _ensureConnectionWrapped(connection: Connection) {
    if (this._rawStateAccessors.has(connection)) return;
    // ... _cf_ プレフィックス付きフラグを透過的にフィルタ
}
```

### 2. WebSocket attachment による接続状態の永続化

Hibernation で消失するインメモリ Map の代わりに、`connection.setState()` で WebSocket attachment に状態を永続化する。

```typescript
// cloudflare/partykit — packages/y-partyserver/src/server/index.ts:40-70
/**
 * Internal key used in connection.setState() to track which awareness
 * client IDs are controlled by each connection. This survives hibernation
 * because connection state is persisted to WebSocket attachments.
 */
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
    // ignore -- may fail if connection is already closed
  }
}
```

関数型アップデート `(prev) => next` により、既存のキーを保持しつつ特定キーだけを安全に更新できる。

### 3. 遅延復元と WeakMap キャッシュ

Hibernation 復帰後の全接続一括デシリアライズを避け、アクセス時に遅延復元して WeakMap でキャッシュする。

```typescript
// cloudflare/partykit — packages/partyserver/src/connection.ts:81-106
class AttachmentCache {
  #cache = new WeakMap<WebSocket, ConnectionAttachments>();

  get(ws: WebSocket): ConnectionAttachments {
    let attachment = this.#cache.get(ws);
    if (!attachment) {
      attachment = WebSocket.prototype.deserializeAttachment.call(
        ws,
      ) as ConnectionAttachments;
      if (attachment !== undefined) {
        this.#cache.set(ws, attachment);
      } else {
        throw new Error(
          "Missing websocket attachment. This is most likely an issue in PartyServer, ...",
        );
      }
    }
    return attachment;
  }
}
```

WeakMap のキーが GC されるとエントリも自動解放されるため、明示的な invalidation ロジックが不要になる。

### 4. SQLite を真実源とする永続化（agents パターン）

agents は WebSocket attachment より上位のレイヤーとして SQLite を真実源に採用している。`state` getter は常に SQLite から読み直し、インメモリ値はキャッシュとして扱う。

```typescript
// cloudflare/agents — src/index.ts:596-651
get state(): State {
    if (this._state !== DEFAULT_STATE) {
      return this._state;
    }
    // check if the state was set in a previous life
    const wasChanged = this.sql<{ state: "true" | undefined }>`
        SELECT state FROM cf_agents_state WHERE id = ${STATE_WAS_CHANGED}
      `;
    const result = this.sql<{ state: State | undefined }>`
      SELECT state FROM cf_agents_state WHERE id = ${STATE_ROW_ID}
    `;
    if (wasChanged[0]?.state === "true" || result[0]?.state) {
      const state = result[0]?.state as string;
      try {
        this._state = JSON.parse(state);
      } catch (e) {
        console.error("Failed to parse stored state, falling back to initialState:", e);
        if (this.initialState !== DEFAULT_STATE) {
          this._state = this.initialState;
          this._setStateInternal(this.initialState);
        } else {
          this.sql`DELETE FROM cf_agents_state WHERE id = ${STATE_ROW_ID}`;
          this.sql`DELETE FROM cf_agents_state WHERE id = ${STATE_WAS_CHANGED}`;
          return undefined as State;
        }
      }
      return this._state;
    }
    // first time: persist initialState
    if (this.initialState === DEFAULT_STATE) {
      return undefined as State;
    }
    this._setStateInternal(this.initialState);
    return this.initialState;
  }
```

JSON パース失敗時は `initialState` にフォールバックし、破損データを修復して再永続化する。「読めない状態は安全なデフォルトに戻す」防御的パターンが組み込まれている。

### 5. タイマー無効化による Hibernation 阻害防止

ライブラリ内部のタイマーが Hibernation を妨げる場合、明示的に無効化する。

```typescript
// cloudflare/partykit — packages/y-partyserver/src/server/index.ts:80-91
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

## Good Example

接続ごとのトピック購読状態を WebSocket attachment に保存し、Hibernation を跨いで維持する。

```typescript
// cloudflare/partykit — packages/partysub/src/server/index.ts:51-61
onConnect(
  connection: Connection<ConnectionState>,
  ctx: ConnectionContext
): void | Promise<void> {
  const url = new URL(ctx.request.url);
  const initialTopics = url.searchParams.get("topics")?.split(",") || ["*"];
  connection.setState({ topics: initialTopics });
}
```

Hibernation 復帰時に `connection.state.topics` を読み出せば、購読情報が復元される。初回起動とウェイクアップで同じコードパスが使える。

agents のステート管理も同様に、SQLite への永続化とブロードキャストを `_setStateInternal` に一本化している。

```typescript
// cloudflare/agents — src/index.ts:1216-1241
private _setStateInternal(
  nextState: State,
  source: Connection | "server" = "server"
): void {
  this.validateStateChange(nextState, source);
  this._state = nextState;
  this.sql`
    INSERT OR REPLACE INTO cf_agents_state (id, state)
    VALUES (${STATE_ROW_ID}, ${JSON.stringify(nextState)})
  `;
  this._broadcastProtocol(
    JSON.stringify({
      state: nextState,
      type: MessageType.CF_AGENT_STATE
    }),
    source !== "server" ? [source.id] : []
  );
}
```

## Bad Example

インメモリ Map に接続ごとの状態を保持すると、Hibernation/プロセス再起動で消失する。

```typescript
// Bad: インメモリ Map は Hibernation で消失する
const awarenessMap = new Map<Connection, number[]>();

function onMessage(conn: Connection, msg: Uint8Array) {
  const ids = parseAwarenessIds(msg);
  awarenessMap.set(conn, ids); // Hibernation で消える
}

function onClose(conn: Connection) {
  const ids = awarenessMap.get(conn); // undefined -- クリーンアップ不可能
  if (ids) removeAwareness(ids);
}
```

```typescript
// Better: connection.setState で WebSocket attachment に永続化
function onMessage(conn: Connection, msg: Uint8Array) {
  const ids = parseAwarenessIds(msg);
  conn.setState((prev) => ({
    ...prev,
    awarenessIds: ids, // Hibernation を跨いで生存
  }));
}

function onClose(conn: Connection) {
  const ids = (conn.state as any)?.awarenessIds ?? [];
  removeAwareness(ids); // 正しくクリーンアップできる
}
```

同様に、`setInterval` を放置すると Hibernation に入れなくなる。

```typescript
// Bad: ライブラリの内部タイマーが Hibernation を妨げる
const awareness = new awarenessProtocol.Awareness(doc);
// _checkInterval が 15 秒ごとに発火し続ける -> DO がスリープできない

// Better: 明示的にタイマーを無効化し、onClose でクリーンアップする設計に切り替える
const awareness = new awarenessProtocol.Awareness(doc);
clearInterval(awareness._checkInterval);
```

## 適用ガイド

### どのような状況で使うべきか

- Durable Objects の Hibernation API を使用する WebSocket サーバー
- AWS Lambda, Cloud Run, Kubernetes など、プロセスが透過的に再起動されるサーバーレス環境
- WebSocket 接続に紐づく状態（認証情報、購読トピック、カーソル位置など）が、接続の生存期間中に維持される必要がある場合

### 状態の生存期間に応じたストレージ選択

| 生存期間                 | ストレージ           | 用途例                                           |
| ------------------------ | -------------------- | ------------------------------------------------ |
| 接続単位（揮発OK）       | インメモリ変数       | 一時的なバッファ、送信キュー                     |
| 接続単位（休止を跨ぐ）   | WebSocket attachment | 購読トピック、awareness ID、readonly フラグ      |
| インスタンス単位（永続） | KV Storage / SQLite  | Actor ステート、スケジュール、ドキュメントデータ |

### 導入時の注意点

- **ネームスペースプレフィックスの衝突回避**: `__pk`, `__user`, `_cf_`, `__yps` のようにレイヤーごとに一意なプレフィックスを選ぶ。ユーザーが偶然使う可能性のある名前（`id`, `state`, `type`）は避ける
- **遅延復元のエラーパス**: WeakMap キャッシュがミスした場合のフォールバック（デシリアライズ再実行）が必須。partykit の `AttachmentCache` はデシリアライズ失敗時に明示的にエラーをスローする
- **関数型アップデートの提供**: `setState((prev) => next)` 形式をサポートすることで、複数レイヤーが同一 attachment にキーを追加する際の上書き事故を防ぐ
- **タイマーの監査**: Hibernation/省電力環境に導入する際は、使用するライブラリの内部タイマー・ポーリングを監査し、不要なものを無効化する

### カスタマイズポイント

- **永続化のデバウンス**: 高頻度の状態変更では、y-partyserver のように `debounce`（wait + maxWait）で永続化を集約できる
- **`configurable: true`**: ライブラリが `Object.defineProperty` で設定するプロパティに `configurable: true` を付与することで、下流の SDK が再定義して独自のネームスペースを追加できる
- **べき等な再初期化**: agents の `_ensureConnectionWrapped` のように、再初期化メソッドをべき等に設計することで、呼び出し側が「初期化済みかどうか」を判断する責務を負わなくて済む

## 参考

- [repos/cloudflare/partykit/state-management-patterns.md](../repos/cloudflare/partykit/state-management-patterns.md) -- WebSocket attachment のネームスペース分離、遅延復元、関数型アップデート
- [repos/cloudflare/partykit/concurrency-patterns.md](../repos/cloudflare/partykit/concurrency-patterns.md) -- Hibernation/Wake-up サイクル、タイマー無効化
- [repos/cloudflare/partykit/architecture.md](../repos/cloudflare/partykit/architecture.md) -- Strategy パターンによる接続管理の切り替え
- [repos/cloudflare/agents/durable-objects-actor-patterns.md](../repos/cloudflare/agents/durable-objects-actor-patterns.md) -- SQLite を真実源とする Hibernation-first 設計、べき等な再初期化
- [repos/cloudflare/agents/state-sync-and-rpc.md](../repos/cloudflare/agents/state-sync-and-rpc.md) -- ステート永続化とブロードキャストの統合
