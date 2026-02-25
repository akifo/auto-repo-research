# ストリーミングパターン

> リポジトリ: cloudflare/agents
> 分析日: 2026-02-25

## 概要

cloudflare/agents は AI チャット、MCP (Model Context Protocol)、WebSocket の3つの通信レイヤーにまたがるストリーミング基盤を持つ。特に注目すべきは、Durable Object のハイバネーション・再起動を前提にした resumable stream の設計と、SSE/WebSocket のトランスポート抽象化が同一の `Transport` インターフェースで統一されている点である。単なるストリーミング配信ではなく「切断耐性のあるストリーミング」をアーキテクチャレベルで実現しており、エッジコンピューティング環境でのリアルタイム AI 応答という課題に対する実践的なパターンが豊富に含まれている。

## 背景にある原則

- **切断は例外ではなく常態**: エッジ環境ではネットワーク切断、DO ハイバネーション、ページリロードが日常的に発生する。そのため、ストリームの再開を「エラーリカバリ」ではなく「通常フロー」として設計している。`ResumableStream` クラスがチャンクを SQLite にバッファリング・永続化し、再接続時にリプレイする機構がこの原則の中核にある（`packages/ai-chat/src/resumable-stream.ts:1-11`）。

- **トランスポート透過性**: ストリーミングのプロトコル（SSE、WebSocket、Streamable HTTP）が変わっても、上位ロジックは同じ `Transport` インターフェースを通じてメッセージを送受信する。これにより、新しいトランスポートの追加が既存コードに影響を与えない。MCP の `McpSSETransport` と `StreamableHTTPServerTransport` が同じ `Transport` を実装しているのがその証左（`packages/agents/src/mcp/transport.ts:25,93`）。

- **チャンク単位の冪等性**: ストリームの各チャンクは独立してパース可能な JSON であり、再生順序さえ保てば任意のチャンクから再開できる。`applyChunkToParts` はチャンクタイプごとに冪等な更新を行い、`text-start` が欠落しても `text-delta` だけでフォールバック生成できる設計になっている（`packages/ai-chat/src/message-builder.ts:92-98`）。

- **ライブ配信と再生の分離**: アクティブなクライアントへのリアルタイム配信と、再接続クライアントへのリプレイは明確に分離されている。再接続中のクライアントは ACK するまでライブ配信から除外され、リプレイ完了後にライブストリームに合流する（`packages/ai-chat/src/index.ts:820-828`）。

## 実例と分析

### 1. ResumableStream: SQLite バッファリングによる永続ストリーム

`ResumableStream` クラスはストリームチャンクを SQLite に永続化し、切断後の再接続時にリプレイする。チャンクはメモリバッファに一時蓄積され、閾値（デフォルト10チャンク）に達するか、ストリーム完了時にバッチで SQLite に書き込まれる。

重要な設計判断として、バッファの最大サイズ（100チャンク）が設定されている。これは急速な再接続でメモリが膨張することを防ぐためのバックプレッシャー機構である。

```
// packages/ai-chat/src/resumable-stream.ts:17-26
const CHUNK_BUFFER_SIZE = 10;
const CHUNK_BUFFER_MAX_SIZE = 100;
const STREAM_STALE_THRESHOLD_MS = 5 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const CLEANUP_AGE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
```

また、SQLite の行サイズ制限（2MB）に対する防御として、1.8MB を超えるチャンクは永続化をスキップする。ライブクライアントにはそのまま配信されるが、リプレイ時には欠落する。これは「完全なリプレイより、クラッシュしないことを優先する」というプラグマティックな判断である。

```
// packages/ai-chat/src/resumable-stream.ts:181-201
private static CHUNK_MAX_BYTES = 1_800_000;

storeChunk(streamId: string, body: string) {
  const bodyBytes = textEncoder.encode(body).byteLength;
  if (bodyBytes > ResumableStream.CHUNK_MAX_BYTES) {
    console.warn(
      `[ResumableStream] Skipping oversized chunk (${bodyBytes} bytes) ` +
        `to prevent SQLite row limit crash. Live clients still receive it.`
    );
    return;
  }
```

### 2. 3フェーズストリーム再開プロトコル

クライアントの再接続時、以下の3フェーズプロトコルでストリームが再開される。

1. **通知 (RESUMING)**: サーバーが `CF_AGENT_STREAM_RESUMING` を送信
2. **確認 (ACK)**: クライアントが `CF_AGENT_STREAM_RESUME_ACK` を返送
3. **リプレイ**: サーバーが蓄積チャンクをリプレイ

この3フェーズが必要な理由は、`onConnect` 時にクライアントのメッセージハンドラがまだ登録されていない可能性があるためである。クライアント主導の `CF_AGENT_STREAM_RESUME_REQUEST` メッセージが追加されたのも同じ理由で、これにより onConnect のタイミング競合を回避している。

```
// packages/ai-chat/src/index.ts:493-501
// Handle client-initiated stream resume request.
// The client sends this after its message handler is registered,
// avoiding the race condition where CF_AGENT_STREAM_RESUMING sent
// in onConnect arrives before the client's handler is ready.
if (data.type === MessageType.CF_AGENT_STREAM_RESUME_REQUEST) {
  if (this._resumableStream.hasActiveStream()) {
    this._notifyStreamResuming(connection);
```

### 3. WebSocket 上の SSE エミュレーション（MCP Streamable HTTP）

`StreamableHTTPServerTransport` は MCP の Streamable HTTP 仕様を Durable Object の WebSocket 上で実装している。SSE イベントを JSON メッセージにラップして WebSocket で送信し、Worker 側で SSE に変換してクライアントに返す二段構え構造を取っている。

```
// packages/agents/src/mcp/transport.ts:193-213
private writeSSEEvent(
  connection: Connection,
  message: JSONRPCMessage,
  eventId?: string,
  close?: boolean
) {
  let eventData = "event: message\n";
  if (eventId) {
    eventData += `id: ${eventId}\n`;
  }
  eventData += `data: ${JSON.stringify(message)}\n\n`;

  return connection.send(
    JSON.stringify({
      type: MessageType.CF_MCP_AGENT_EVENT,
      event: eventData,
      close
    })
  );
}
```

### 4. WorkerTransport: ステートレス環境での SSE ストリーム管理

`WorkerTransport` は Cloudflare Workers のステートレスな `fetch` ハンドラ内で SSE ストリームを管理する。`TransformStream` でリクエストごとにストリームを生成し、`streamMapping` でリクエスト ID とストリームの対応を追跡する。30 秒間隔の keepalive ping で接続を維持し、`EventStore` による resumability もサポートしている。

```
// packages/agents/src/mcp/worker-transport.ts:350-356
const keepAlive = setInterval(() => {
  try {
    writer.write(encoder.encode("event: ping\ndata: \n\n"));
  } catch {
    clearInterval(keepAlive);
  }
}, 30000);
```

### 5. WebSocketChatTransport: フェイク fetch の排除

AI SDK の `useChat` はもともと HTTP fetch ベースの設計だが、cloudflare/agents は WebSocket をネイティブトランスポートとして使う。初期実装では WebSocket メッセージを偽の `Response` オブジェクトに変換して fetch を模倣していたが、`WebSocketChatTransport` でこの間接層を排除した。

```
// packages/ai-chat/src/ws-chat-transport.ts:6-8
// Data flow (old): WS → aiFetch fake Response → DefaultChatTransport → useChat
// Data flow (new): WS → WebSocketChatTransport → useChat
```

WebSocket メッセージを直接 `ReadableStream<UIMessageChunk>` に変換し、AI SDK の `ChatTransport` インターフェースに適合させている。

## コード例

```typescript
// packages/ai-chat/src/resumable-stream.ts:257-295
// リプレイ: 蓄積チャンクを再接続クライアントに送信
replayChunks(connection: Connection, requestId: string) {
  const streamId = this._activeStreamId;
  if (!streamId) return;

  this.flushBuffer();

  const chunks = this.sql<StreamChunk>`
    select * from cf_ai_chat_stream_chunks
    where stream_id = ${streamId}
    order by chunk_index asc
  `;

  for (const chunk of chunks || []) {
    connection.send(
      JSON.stringify({
        body: chunk.body,
        done: false,
        id: requestId,
        type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
        replay: true  // クライアントがバッチ適用できるフラグ
      })
    );
  }
}
```

```typescript
// packages/ai-chat/src/index.ts:2064-2081
// _reply: ストリーム開始からメッセージ構築・永続化までの一貫フロー
const streamId = this._startStream(id);
const reader = response.body.getReader();

const message: ChatMessage = {
  id: `assistant_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
  role: "assistant",
  parts: [],
};
this._streamingMessage = message;
this._streamCompletionPromise = new Promise((resolve) => {
  this._streamCompletionResolve = resolve;
});
```

```typescript
// packages/ai-chat/src/message-builder.ts:88-98
// text-delta のフォールバック: text-start が欠落してもパーツを生成
case "text-delta": {
  const lastTextPart = findLastPartByType(parts, "text");
  if (lastTextPart && lastTextPart.type === "text") {
    (lastTextPart as { text: string }).text += chunk.delta ?? "";
  } else {
    // No text-start received — create a new text part (stream resumption fallback)
    parts.push({
      type: "text",
      text: chunk.delta ?? "",
      state: "streaming"
    } as MessagePart);
  }
  return true;
}
```

## パターンカタログ

- **Event Sourcing** (分類: アーキテクチャ)
  - 解決する問題: ストリーム切断後の状態復元
  - 適用条件: チャンク単位で永続化可能なストリームデータ
  - コード例: `packages/ai-chat/src/resumable-stream.ts:80-97` （SQLite へのチャンク蓄積とメタデータ管理）
  - 注意点: 永続化コストと再生コストのトレードオフ。バッファリングで書き込み頻度を下げている

- **Observer / Pub-Sub** (分類: 振る舞い)
  - 解決する問題: 複数クライアントへのストリーム配信と、接続状態に応じた配信制御
  - 適用条件: 1:N のリアルタイム配信
  - コード例: `packages/ai-chat/src/index.ts:820-828` （`_broadcastChatMessage` による選択的配信）
  - 注意点: 再接続中クライアントの除外リスト管理が必要

- **Adapter** (分類: 構造)
  - 解決する問題: 異なるトランスポート（WebSocket、SSE、HTTP）を統一インターフェースで扱う
  - 適用条件: 複数のプロトコルを同じ上位ロジックで処理したい場合
  - コード例: `packages/agents/src/mcp/transport.ts:25,93` （`McpSSETransport`, `StreamableHTTPServerTransport` が同じ `Transport` を実装）
  - 注意点: トランスポート固有の制約（WebSocket はバイナリ対応、SSE は一方向）を抽象化しきれないケースがある

## Good Patterns

- **リプレイフラグによるクライアント側の最適化**: リプレイチャンクには `replay: true` フラグが付与され、クライアントはリプレイ中であることを認識して UI 更新をバッチ化できる。個別チャンクごとに再描画するのではなく、リプレイ完了後にまとめて描画する余地を残している。

```typescript
// packages/ai-chat/src/resumable-stream.ts:270-279
connection.send(
  JSON.stringify({
    body: chunk.body,
    done: false,
    id: requestId,
    type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
    replay: true,
  }),
);
```

- **ストリーム状態の3値管理 (streaming/completed/error)**: ストリームのライフサイクルが明確に3状態で管理されており、古いストリームの判定（5分で stale）と定期的なクリーンアップ（24時間経過で削除）により、ストレージの無限膨張を防いでいる。

```typescript
// packages/ai-chat/src/resumable-stream.ts:44-50
type StreamMetadata = {
  id: string;
  request_id: string;
  status: "streaming" | "completed" | "error";
  created_at: number;
  completed_at: number | null;
};
```

- **チャンクパーサーのフォールバック設計**: `applyChunkToParts` は `text-start` チャンクが欠落しても `text-delta` だけで新しいテキストパーツを生成する。ストリーム再開時に「開始イベントを見逃した」場合にも壊れない耐障害性を持つ。

```typescript
// packages/ai-chat/src/message-builder.ts:92-98
} else {
  // No text-start received — create a new text part (stream resumption fallback)
  parts.push({
    type: "text",
    text: chunk.delta ?? "",
    state: "streaming"
  } as MessagePart);
}
```

## Anti-Patterns / 注意点

- **ストリーム完了待ちの固定タイムアウト**: ツール継続時にストリーム完了を待つ箇所で、完了 Promise が null の場合に 500ms の固定タイムアウトでフォールバックしている。これはレース条件の回避策だが、ネットワーク遅延が大きい環境では不十分な可能性がある。

```typescript
// Bad: 固定タイムアウトによるフォールバック
// packages/ai-chat/src/index.ts:559-564
if (this._streamCompletionPromise) {
  await this._streamCompletionPromise;
} else {
  // TODO: ...consider a more deterministic signal
  await new Promise((resolve) => setTimeout(resolve, 500));
}
```

```typescript
// Better: 常に完了 Promise を設定し、タイムアウトは安全マージンとして併用
const streamDone = this._streamCompletionPromise ?? Promise.resolve();
await Promise.race([
  streamDone,
  new Promise((_, reject) => setTimeout(() => reject(new Error("Stream completion timeout")), 5000)),
]);
```

- **keepalive ping の無条件 30 秒間隔**: `WorkerTransport` の keepalive は 30 秒固定で、設定変更ができない。プロキシやロードバランサーのタイムアウト設定によっては不適切な間隔になる。

```typescript
// Bad: ハードコードされた keepalive 間隔
// packages/agents/src/mcp/worker-transport.ts:350-356
const keepAlive = setInterval(() => {
  writer.write(encoder.encode("event: ping\ndata: \n\n"));
}, 30000);
```

```typescript
// Better: オプションで間隔を設定可能にする
const intervalMs = options?.keepAliveIntervalMs ?? 30000;
const keepAlive = setInterval(() => {
  writer.write(encoder.encode("event: ping\ndata: \n\n"));
}, intervalMs);
```

## 導出ルール

- `[MUST]` resumable なストリームでは、チャンクを永続ストレージにバッファリングし、再接続時にリプレイ可能にする。ライブ配信とリプレイの経路を分離し、再接続中のクライアントをライブ配信から除外する
  - 根拠: `ResumableStream` は SQLite にチャンクをバッチ永続化し、`_pendingResumeConnections` で再接続中クライアントをライブ broadcast から除外してチャンク欠損・重複を防いでいる（`resumable-stream.ts:192-221`, `index.ts:820-828`）

- `[MUST]` SSE ストリームには定期的な keepalive ping を送信し、プロキシやインフラによるアイドル接続切断を防ぐ
  - 根拠: `WorkerTransport` は 30 秒間隔で `event: ping` を送信し、Cloudflare のインフラストラクチャやプロキシによる接続切断を防止している（`worker-transport.ts:350-356`）

- `[SHOULD]` ストリームチャンクのパーサーは「開始イベントの欠落」を許容するフォールバックを持つべき。再開時に途中のチャンクから処理を開始しても壊れない設計にする
  - 根拠: `applyChunkToParts` は `text-start` なしで `text-delta` を受信した場合にも新しいテキストパーツを自動生成する。コメントに "stream resumption fallback" と明記されている（`message-builder.ts:92-98`）

- `[SHOULD]` ストリームの永続化では、ストレージの行サイズ制限に対する防御ガードを入れる。上限を超えるチャンクはリプレイ対象から除外しても、ライブ配信は継続する
  - 根拠: `ResumableStream.CHUNK_MAX_BYTES` (1.8MB) を超えるチャンクは SQLite 永続化をスキップしつつライブ配信は継続する。SQLite 2MB 行制限によるクラッシュを防ぐプラグマティックな判断（`resumable-stream.ts:181-201`）

- `[SHOULD]` クライアントとサーバー間のストリーム再開プロトコルは、クライアント主導のリクエストメッセージを含む3フェーズ（通知→確認→リプレイ）とする。サーバー主導の通知のみではハンドラ登録前のメッセージ喪失が発生する
  - 根拠: `CF_AGENT_STREAM_RESUME_REQUEST` は onConnect の RESUMING 通知がクライアントのメッセージハンドラ登録前に到着する競合条件を解決するために追加された（`index.ts:493-501`, Issue #896 への対応）

- `[AVOID]` ストリーム完了の待機にハードコードされたタイムアウトを使うこと。Promise ベースの完了通知を常に設定し、タイムアウトは最終防御としてのみ使う
  - 根拠: ツール継続時の 500ms 固定タイムアウトは TODO コメント付きの暫定策であり、完了 Promise が null になるレース条件の根本解決が推奨されている（`index.ts:559-564`）

## 適用チェックリスト

- [ ] ストリーミング応答が切断された場合に、再接続後にストリームを再開できる仕組みがあるか
- [ ] ストリームチャンクが永続ストレージにバッファリングされ、リプレイ可能か
- [ ] 再接続中のクライアントがライブ配信から除外され、リプレイ完了後に合流する設計か
- [ ] チャンクパーサーが「開始イベント欠落」に対するフォールバックを持っているか
- [ ] SSE 接続に keepalive ping が設定されており、アイドルタイムアウトを防いでいるか
- [ ] ストレージの行サイズ制限に対する防御ガードがあるか（上限超過チャンクの graceful degradation）
- [ ] ストリームのライフサイクル状態（streaming/completed/error）が管理されているか
- [ ] 古いストリームデータの定期クリーンアップ機構があるか
- [ ] ストリーム完了の待機が Promise ベースであり、固定タイムアウトに依存していないか
