# state-management-patterns

> リポジトリ: cloudflare/partykit
> 分析日: 2026-02-25

## 概要

WebSocket ベースのリアルタイムアプリケーションにおける状態管理パターンを分析する。PartyKit は Durable Objects の Hibernation API を活用し、接続ごとの状態（Connection.state）、プラットフォーム/ユーザーのネームスペース分離（WebSocket Attachment）、永続ストレージ（DO Storage / SQL）という 3 層の状態管理を実装している。特に、Hibernation による DO のメモリ解放後も接続状態を維持する戦略と、`configurable: true` による下流 SDK への拡張点設計が注目に値する。

## 背景にある原則

- **ネームスペース分離による安全な共存**: プラットフォーム内部状態（`__pk`）とユーザー状態（`__user`）を同一 WebSocket Attachment 内で名前空間で分離することで、ユーザーコードがプラットフォームの不変条件を破壊するリスクを排除すべき。根拠: `connection.ts` の `ConnectionAttachments` 型と `createLazyConnection` の実装で、`__pk`（id, tags）と `__user` を独立管理している。
- **遅延復元でデシリアライズコストを償却する**: Hibernation 復帰時に全接続の状態を一括デシリアライズするのではなく、アクセス時に遅延復元し WeakMap でキャッシュすべき。根拠: `AttachmentCache` クラスが WeakMap で WebSocket→Attachment のマッピングをキャッシュし、`createLazyConnection` が `Object.defineProperties` の getter で遅延評価する（`connection.ts:81-106`, `connection.ts:118-198`）。
- **拡張点は `configurable: true` で宣言する**: ライブラリが定義するプロパティを下流 SDK が再定義できるよう、`Object.defineProperty` に `configurable: true` を設定すべき。根拠: CHANGELOG v0.1.3 で明示的に追加され、Agents SDK がこのメカニズムで内部状態のネームスペーシングを行うことを意図している。
- **状態の生存期間をストレージ層で使い分ける**: 接続単位の揮発状態は WebSocket Attachment、インスタンス名のような半永続データは KV Storage、構造化データは SQL Storage と、生存期間に応じてストレージを選択すべき。根拠: `Server.name` は `ctx.storage.put/get`、`partywhen` のタスクは `ctx.storage.sql`、接続状態は `serializeAttachment` とそれぞれ異なるストレージを使い分けている。

## 実例と分析

### WebSocket Attachment のネームスペース分離

PartyKit は WebSocket の Attachment 機構を 2 つのネームスペースに分割する。`__pk` にはプラットフォームが管理する接続 ID とタグを格納し、`__user` にはユーザーが `connection.setState()` で設定する任意の状態を格納する。

```typescript
// packages/partyserver/src/connection.ts:31-37
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
// packages/partyserver/src/connection.ts:179-189
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

### 遅延復元と WeakMap キャッシュ

`AttachmentCache` は WeakMap を使い、WebSocket がガベージコレクションされると自動的にキャッシュからも除去される。Hibernation 復帰後、最初のプロパティアクセスで `deserializeAttachment` が呼ばれ、結果がキャッシュされる。

```typescript
// packages/partyserver/src/connection.ts:81-106
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

同様のパターンは `serverMapCache` / `bindingNameCache` にも見られる。`env` オブジェクトをキーにした WeakMap で DurableObject ネームスペースのマッピングをキャッシュし、リクエストごとの再計算を避けている。

```typescript
// packages/partyserver/src/index.ts:27-33
const serverMapCache = new WeakMap<
  object,
  Record<string, DurableObjectNamespace>
>();
const bindingNameCache = new WeakMap<object, Record<string, string>>();
```

### Connection.state / setState の関数型アップデート

`ConnectionState<T>` は `ImmutableObject<T> | null` として定義され、`setState` は値だけでなく関数（前の状態を受け取り新しい状態を返す）も受け付ける。React の `useState` と同じインターフェースである。

```typescript
// packages/partyserver/src/types.ts:17-18
export type ConnectionState<T> = ImmutableObject<T> | null;
export type ConnectionSetStateFn<T> = (prevState: ConnectionState<T>) => T;
```

y-partyserver はこの関数型アップデートを活用し、awareness ID の追加・削除をアトミックに行う。

```typescript
// packages/y-partyserver/src/server/index.ts:61-70
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

### Hibernation サバイバル戦略

y-partyserver は「Hibernation 中にインメモリ状態は消失するが、WebSocket Attachment は生存する」という性質を利用し、awareness ID を `connection.setState` に保存する。`onClose` で接続の awareness を適切にクリーンアップするために、この情報が必須となる。

```typescript
// packages/y-partyserver/src/server/index.ts:40-46
/**
 * Internal key used in connection.setState() to track which awareness
 * client IDs are controlled by each connection. This survives hibernation
 * because connection state is persisted to WebSocket attachments.
 */
const AWARENESS_IDS_KEY = "__ypsAwarenessIds";
```

また、Hibernation 復帰時にドキュメントを復元するため、onStart で全接続に sync step 1 を送信し、クライアントからの応答で状態を再構築する。

```typescript
// packages/y-partyserver/src/server/index.ts:339-349
// After hibernation wake-up, the doc is empty but existing connections
// survive. Re-sync by sending sync step 1 to all connections — they'll
// respond with sync step 2 containing their full state.
const syncEncoder = encoding.createEncoder();
encoding.writeVarUint(syncEncoder, messageSync);
syncProtocol.writeSyncStep1(syncEncoder, this.document);
const syncMessage = encoding.toUint8Array(syncEncoder);
for (const conn of this.getConnections()) {
  send(conn, syncMessage);
}
```

### Write-Once-Only パターン（Server.name）

`Server.name` は一度設定されたら変更不可。DO Storage に永続化され、Hibernation 復帰後も `#hydrateNameFromStorage` で復元される。

```typescript
// packages/partyserver/src/index.ts:614-627
async setName(name: string) {
  if (!name) {
    throw new Error("A name is required.");
  }
  if (this.#_name && this.#_name !== name) {
    throw new Error(
      `This server already has a name: ${this.#_name}, attempting to set to: ${name}`
    );
  }
  this.#_name = name;
  await this.ctx.storage.put(NAME_STORAGE_KEY, name);
  await this.#ensureInitialized();
}
```

### デバウンス付き永続化

y-partyserver はドキュメント更新を即座に永続化せず、`lodash.debounce` で遅延実行する。デフォルトは 2000ms wait / 10000ms maxWait。これにより、高頻度の編集操作でストレージ書き込みが爆発することを防ぐ。

```typescript
// packages/y-partyserver/src/server/index.ts:316-337
this.document.on(
  "update",
  debounce(
    (_update: Uint8Array, _origin: Connection, _doc: YDoc) => {
      try {
        this.onSave().catch((err) => {
          console.error("failed to persist:", err);
        });
      } catch (err) {
        console.error("failed to persist:", err);
      }
    },
    ctor.callbackOptions.debounceWait || CALLBACK_DEFAULTS.debounceWait,
    {
      maxWait: ctor.callbackOptions.debounceMaxWait
        || CALLBACK_DEFAULTS.debounceMaxWait,
    },
  ),
);
```

### バッチリクエストディスパッチャ

partytracks の `BulkRequestDispatcher` は、同一イベントループ内に発生した複数のリクエストをバッチ化する。`setTimeout(0)` でマクロタスクに遅延させ、その間に蓄積された要素を一括処理する。

```typescript
// packages/partytracks/src/client/Peer.utils.ts:24-81
export class BulkRequestDispatcher<RequestEntryParams, BulkResponse> {
  #currentBatch: RequestEntryParams[];
  #currentBulkResponse: Promise<BulkResponse> | null;
  #batchSizeLimit: number;

  doBulkRequest(
    params: RequestEntryParams,
    bulkRequestFunc: (bulkCopy: RequestEntryParams[]) => Promise<BulkResponse>,
  ): Promise<BulkResponse> {
    // ... バッチに追加し、setTimeout(0) で一括送信
  }
}
```

### 接続状態による購読管理

partysub は `connection.setState({ topics })` で各接続のトピック購読状態を管理する。Hibernation モードが有効なので、この状態は WebSocket Attachment に永続化され、DO がスリープしても購読情報が維持される。

```typescript
// packages/partysub/src/server/index.ts:51-61
onConnect(
  connection: Connection<ConnectionState>,
  ctx: ConnectionContext
): void | Promise<void> {
  const url = new URL(ctx.request.url);
  const initialTopics = url.searchParams.get("topics")?.split(",") || ["*"];
  connection.setState({ topics: initialTopics });
}
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: Hibernation の有無で接続管理の実装が異なる
  - 適用条件: 同一インターフェースで異なるバックエンドを使い分ける場合
  - コード例: `ConnectionManager` インターフェースと `InMemoryConnectionManager` / `HibernatingConnectionManager`（`connection.ts:268-385`）
  - 注意点: `options.hibernate` はビルド時に決定されるため、実行時切り替えではない

- **Lazy Initialization + Cache** (分類: 生成)
  - 解決する問題: Hibernation 復帰後のデシリアライズコストを初回アクセスに分散する
  - 適用条件: オブジェクト復元にコストがかかり、全オブジェクトが毎回参照されるとは限らない場合
  - コード例: `AttachmentCache`（`connection.ts:81-106`）、`createLazyConnection`（`connection.ts:118-198`）
  - 注意点: WeakMap のキーが GC されると復元済みデータも消える — 再取得のパスが必須

## Good Patterns

- **ネームスペースプレフィックスによるメタデータ共存**: `__pk` と `__user` のように予約済みプレフィックスで内部メタデータとユーザーデータを同一ストレージ内に共存させる。型レベルでも `ConnectionAttachments` で構造を定義し、実行時にプレフィックスで分離する。

```typescript
// packages/partyserver/src/connection.ts:31-37
type ConnectionAttachments = {
  __pk: { id: string; tags: string[]; };
  __user?: unknown;
};
```

- **関数型アップデートによるアトミックな状態変更**: `setState` が `(prev) => next` 形式を受け付けることで、read-modify-write をアトミックに行える。複数の状態キーを持つオブジェクトでスプレッド演算子と組み合わせる際に特に有用。

```typescript
// packages/y-partyserver/src/server/index.ts:62-69
conn.setState((prev: YServerConnectionState | null) => ({
  ...prev,
  [AWARENESS_IDS_KEY]: ids,
}));
```

- **WeakMap による自動クリーンアップ付きキャッシュ**: オーナーオブジェクト（WebSocket, env）の寿命に紐づくキャッシュは WeakMap で管理し、明示的な invalidation ロジックを不要にする。

```typescript
// packages/partyserver/src/connection.ts:82
#cache = new WeakMap<WebSocket, ConnectionAttachments>();

// packages/partyserver/src/index.ts:27-28
const serverMapCache = new WeakMap<object, Record<string, DurableObjectNamespace>>();
```

## Anti-Patterns / 注意点

- **Hibernation 下でのインメモリ状態への依存**: Hibernation が有効な DO でインスタンス変数にのみ状態を保持すると、スリープ後に消失する。y-partyserver が awareness ID の管理で `Map<Connection, Set<number>>` から `connection.setState` に移行した経緯が示すように、Hibernation 対応では Connection Attachment または DO Storage に永続化する必要がある。

```typescript
// Bad: インメモリ Map は Hibernation で消失する
const awarenessMap = new Map<Connection, number[]>();

// Better: connection.setState で WebSocket Attachment に永続化
conn.setState((prev) => ({
  ...prev,
  [AWARENESS_IDS_KEY]: ids,
}));
```

- **タイマーによる Hibernation 阻害**: `setInterval` はイベントループを維持し、DO の Hibernation を妨げる。y-partyserver は awareness プロトコルの内蔵チェックインターバルを明示的に `clearInterval` で無効化している。

```typescript
// Bad: awareness の内蔵 setInterval が Hibernation を妨げる
// (何もしない場合のデフォルト動作)

// Better: 明示的にタイマーを無効化
// packages/y-partyserver/src/server/index.ts:83-91
clearInterval(
  (this.awareness as unknown as {
    _checkInterval: ReturnType<typeof setInterval>;
  })._checkInterval,
);
```

## 導出ルール

- `[MUST]` Hibernation 対応サーバーでは、接続ごとの状態をインメモリ変数ではなく WebSocket Attachment（`connection.setState`）に保存する
  - 根拠: y-partyserver と partysub が awareness ID やトピック購読をすべて `connection.setState` に保存し、Hibernation サバイバルを保証している（`y-partyserver/src/server/index.ts:61-70`, `partysub/src/server/index.ts:60`）
- `[MUST]` ライブラリが共有ストレージ（WebSocket Attachment 等）にメタデータを格納する場合、予約済みプレフィックス（`__pk`, `__user` 等）でネームスペースを分離する
  - 根拠: `ConnectionAttachments` 型が `__pk` / `__user` を分離し、ユーザーコードがプラットフォーム不変条件を破壊しないよう保護している（`connection.ts:31-37`）
- `[SHOULD]` 高頻度イベントの永続化にはデバウンス（wait + maxWait）を適用し、ストレージ書き込みを集約する
  - 根拠: y-partyserver が `lodash.debounce` で 2000ms wait / 10000ms maxWait を設定し、編集ごとの書き込みを防いでいる（`y-partyserver/src/server/index.ts:316-337`）
- `[SHOULD]` 復元コストの高いオブジェクトは遅延復元 + WeakMap キャッシュで管理し、オーナーの GC に連動して自動解放する
  - 根拠: `AttachmentCache` がアクセス時のみデシリアライズし WeakMap で保持する設計により、未参照の接続の復元コストをゼロにしている（`connection.ts:81-106`）
- `[SHOULD]` 下流の SDK やフレームワークが拡張する可能性のあるプロパティには `configurable: true` を設定する
  - 根拠: Agents SDK が `connection.state` / `connection.setState` を `Object.defineProperty` で再定義するために、v0.1.3 で明示的に追加された（`connection.ts:151-189`, CHANGELOG v0.1.3）
- `[AVOID]` Hibernation 対応 DO 内で `setInterval` や再帰的 `setTimeout` を使用する — DO のスリープを阻害し、リソースを浪費する
  - 根拠: y-partyserver が awareness プロトコルの `_checkInterval` を `clearInterval` で無効化している（`y-partyserver/src/server/index.ts:83-91`）

## 適用チェックリスト

- [ ] WebSocket 接続に紐づく状態が Hibernation/プロセス再起動後も必要か確認し、必要なら Attachment やストレージに永続化しているか
- [ ] プラットフォーム内部データとユーザーデータが同一ストレージに共存する場合、ネームスペースプレフィックスで分離しているか
- [ ] 高頻度の状態変更イベントに対し、永続化をデバウンスしているか（wait と maxWait の両方を設定しているか）
- [ ] 復元コストの高いキャッシュに WeakMap を使い、明示的な invalidation ロジックなしで GC 連動クリーンアップを実現しているか
- [ ] `setState` が関数型アップデート（`(prev) => next`）をサポートし、read-modify-write の競合を防いでいるか
- [ ] ライブラリ公開のプロパティで、下流で再定義される可能性があるものに `configurable: true` を付与しているか
- [ ] DO 内で `setInterval` を使用していないか（使用している場合、Hibernation 阻害の影響を評価しているか）
