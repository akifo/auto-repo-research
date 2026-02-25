# Pattern: Resumable Stream Replay

> 出典: [repos/cloudflare/agents/streaming-patterns.md](../repos/cloudflare/agents/streaming-patterns.md)
> カテゴリ: pattern

## 概要

SQLite バッファリングと3フェーズ再開プロトコル（RESUMING 通知 → ACK 確認 → リプレイ）を組み合わせ、切断耐性のあるストリーム永続化・リプレイを実現するパターン。AI ストリーミング応答のような長時間ストリームで、クライアントが切断しても途中から再開可能にする設計であり、切断を「エラー」ではなく「通常フロー」として扱う点に本質的な価値がある。

## 背景・文脈

Cloudflare Agents SDK（`cloudflare/agents`）は、Durable Objects 上で AI チャットアプリケーションを構築するフレームワークである。エッジ環境ではネットワーク切断、Durable Object のハイバネーション、ページリロードが日常的に発生する。AI の応答生成は数秒から数十秒を要するため、応答ストリームの途中で接続が切れることは「例外」ではなく「常態」として設計に組み込む必要がある。

この課題に対して `ResumableStream` クラスが実装された。ストリームチャンクを SQLite にバッファリング・永続化し、再接続時にリプレイする機構を提供する。加えて、サーバーとクライアント間の3フェーズ再開プロトコルにより、ハンドラ登録前のメッセージ喪失というレース条件を解決している。

同様のパターンは以下の場面に応用できる:

- LLM のストリーミング応答を中断なく提供するチャットアプリケーション
- リアルタイムコラボレーションツールでの操作ストリームの永続化
- IoT データストリームの切断復旧
- 長時間実行ジョブの進捗ストリーミング

## 実装パターン

### 1. SQLite バッファリングによるチャンク永続化

ストリームチャンクをメモリバッファに蓄積し、閾値に達するとバッチで SQLite に書き込む。個別書き込みではなくバッチ書き込みにすることで I/O コストを抑えつつ、永続化を保証する。

```typescript
// packages/ai-chat/src/resumable-stream.ts:17-26
/** Number of chunks to buffer before flushing to SQLite */
const CHUNK_BUFFER_SIZE = 10;
/** Maximum buffer size to prevent memory issues on rapid reconnections */
const CHUNK_BUFFER_MAX_SIZE = 100;
/** Maximum age for a "streaming" stream before considering it stale (ms) - 5 minutes */
const STREAM_STALE_THRESHOLD_MS = 5 * 60 * 1000;
/** Default cleanup interval for old streams (ms) - every 10 minutes */
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
/** Default age threshold for cleaning up completed streams (ms) - 24 hours */
const CLEANUP_AGE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
```

バッファ最大サイズ（100チャンク）はバックプレッシャー機構として機能する。急速な再接続でメモリが膨張することを防ぐ。

```typescript
// packages/ai-chat/src/resumable-stream.ts:192-221
storeChunk(streamId: string, body: string) {
  // Guard against chunks that would exceed SQLite row limit.
  const bodyBytes = textEncoder.encode(body).byteLength;
  if (bodyBytes > ResumableStream.CHUNK_MAX_BYTES) {
    console.warn(
      `[ResumableStream] Skipping oversized chunk (${bodyBytes} bytes) ` +
        `to prevent SQLite row limit crash. Live clients still receive it.`
    );
    return;
  }

  // Force flush if buffer is at max to prevent memory issues
  if (this._chunkBuffer.length >= CHUNK_BUFFER_MAX_SIZE) {
    this.flushBuffer();
  }

  this._chunkBuffer.push({
    id: nanoid(),
    streamId,
    body,
    index: this._streamChunkIndex
  });
  this._streamChunkIndex++;

  // Flush when buffer reaches threshold
  if (this._chunkBuffer.length >= CHUNK_BUFFER_SIZE) {
    this.flushBuffer();
  }
}
```

SQLite の行サイズ制限（2MB）に対して 1.8MB を上限とし、超過チャンクは永続化をスキップする。ライブクライアントにはそのまま配信されるが、リプレイ時には欠落する。「完全なリプレイよりクラッシュしないことを優先する」プラグマティックな判断である。

### 2. ストリームライフサイクルの3状態管理

ストリームのメタデータを SQLite に保存し、`streaming` / `completed` / `error` の3状態で管理する。

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

ストリーム開始時に `streaming` で INSERT し、正常完了時に `completed`、エラー時に `error` に UPDATE する。5分以上 `streaming` のままのストリームは stale とみなし、エージェント再起動時の `restore()` で削除する。完了済みストリームは24時間後に定期クリーンアップで除去される。

```typescript
// packages/ai-chat/src/resumable-stream.ts:303-341
restore() {
  const activeStreams = this.sql<StreamMetadata>`
    select * from cf_ai_chat_stream_metadata
    where status = 'streaming'
    order by created_at desc
    limit 1
  `;

  if (activeStreams && activeStreams.length > 0) {
    const stream = activeStreams[0];
    const streamAge = Date.now() - stream.created_at;

    // Check if stream is stale; delete to free storage
    if (streamAge > STREAM_STALE_THRESHOLD_MS) {
      this.sql`delete from cf_ai_chat_stream_chunks where stream_id = ${stream.id}`;
      this.sql`delete from cf_ai_chat_stream_metadata where id = ${stream.id}`;
      return;
    }

    this._activeStreamId = stream.id;
    this._activeRequestId = stream.request_id;

    // Get the last chunk index
    const lastChunk = this.sql<{ max_index: number }>`
      select max(chunk_index) as max_index
      from cf_ai_chat_stream_chunks
      where stream_id = ${this._activeStreamId}
    `;
    this._streamChunkIndex =
      lastChunk && lastChunk[0]?.max_index != null
        ? lastChunk[0].max_index + 1
        : 0;
  }
}
```

### 3. 3フェーズストリーム再開プロトコル

再接続時のプロトコルは3フェーズで構成される:

1. **通知 (RESUMING)**: サーバーが `CF_AGENT_STREAM_RESUMING` を送信
2. **確認 (ACK)**: クライアントが `CF_AGENT_STREAM_RESUME_ACK` を返送
3. **リプレイ**: サーバーが蓄積チャンクをリプレイ

この3フェーズが必要な理由は、`onConnect` 時にクライアントのメッセージハンドラがまだ登録されていない可能性があるためである。サーバー主導の通知のみでは、ハンドラ登録前にメッセージが到着し喪失する。

```typescript
// packages/ai-chat/src/index.ts:493-501
// Handle client-initiated stream resume request.
// The client sends this after its message handler is registered,
// avoiding the race condition where CF_AGENT_STREAM_RESUMING sent
// in onConnect arrives before the client's handler is ready.
if (data.type === MessageType.CF_AGENT_STREAM_RESUME_REQUEST) {
  if (this._resumableStream.hasActiveStream()) {
    this._notifyStreamResuming(connection);
  }
}
```

### 4. リプレイフラグによるクライアント側最適化

リプレイチャンクには `replay: true` フラグが付与される。クライアントはこのフラグでリプレイ中であることを識別し、個別チャンクごとの再描画をバッチ化できる。

```typescript
// packages/ai-chat/src/resumable-stream.ts:257-295
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

### 5. ライブ配信とリプレイの分離

アクティブなクライアントへのリアルタイム配信と、再接続クライアントへのリプレイは明確に分離される。再接続中のクライアントは ACK するまでライブ配信から除外され、リプレイ完了後にライブストリームに合流する。

```typescript
// packages/ai-chat/src/index.ts:820-828
// _broadcastChatMessage による選択的配信:
// _pendingResumeConnections に含まれるクライアントはブロードキャストから除外。
// リプレイ完了 + ACK 受信後にリストから外れ、以降はライブ配信を受信する。
```

この分離により、リプレイ中のクライアントが同じチャンクを二重に受信することを防ぐ。

## Good Example

```typescript
// 汎用 ResumableStream の実装例（cloudflare/agents のパターンを抽出・汎化）

interface StreamChunk {
  id: string;
  streamId: string;
  body: string;
  index: number;
  createdAt: number;
}

interface StreamState {
  id: string;
  status: "streaming" | "completed" | "error";
  createdAt: number;
}

interface ResumableStreamOptions {
  /** バッチ書き込みの閾値（デフォルト: 10） */
  bufferSize?: number;
  /** バッファ最大サイズ（デフォルト: 100） */
  maxBufferSize?: number;
  /** stale 判定閾値（デフォルト: 5分） */
  staleThresholdMs?: number;
  /** チャンク最大バイト数（デフォルト: 1.8MB） */
  chunkMaxBytes?: number;
}

class ResumableStream {
  private buffer: StreamChunk[] = [];
  private activeStreamId: string | null = null;
  private chunkIndex = 0;
  private opts: Required<ResumableStreamOptions>;

  constructor(
    private storage: ChunkStorage, // SQLite, Redis, KV など
    options?: ResumableStreamOptions,
  ) {
    this.opts = {
      bufferSize: options?.bufferSize ?? 10,
      maxBufferSize: options?.maxBufferSize ?? 100,
      staleThresholdMs: options?.staleThresholdMs ?? 5 * 60 * 1000,
      chunkMaxBytes: options?.chunkMaxBytes ?? 1_800_000,
    };
  }

  /** チャンクを受け取り、バッファリング + 永続化 */
  store(streamId: string, body: string): boolean {
    const bytes = new TextEncoder().encode(body).byteLength;
    if (bytes > this.opts.chunkMaxBytes) {
      console.warn(`Skipping oversized chunk (${bytes} bytes)`);
      return false; // ライブ配信は呼び出し側で継続
    }

    if (this.buffer.length >= this.opts.maxBufferSize) {
      this.flush();
    }

    this.buffer.push({
      id: crypto.randomUUID(),
      streamId,
      body,
      index: this.chunkIndex++,
      createdAt: Date.now(),
    });

    if (this.buffer.length >= this.opts.bufferSize) {
      this.flush();
    }
    return true;
  }

  /** バッファを永続ストレージに一括書き込み */
  flush(): void {
    if (this.buffer.length === 0) return;
    const chunks = this.buffer;
    this.buffer = [];
    this.storage.insertBatch(chunks);
  }

  /** 再接続クライアントにチャンクをリプレイ */
  replay(streamId: string, send: (data: string) => void): void {
    this.flush(); // 未永続化チャンクを先にフラッシュ
    const chunks = this.storage.getChunks(streamId);
    for (const chunk of chunks) {
      send(JSON.stringify({ ...JSON.parse(chunk.body), replay: true }));
    }
  }
}
```

## Bad Example

```typescript
// Bad 1: チャンクを個別に SQLite へ書き込む（I/O ボトルネック）
class NaiveResumableStream {
  storeChunk(streamId: string, body: string) {
    // チャンクごとに INSERT → ストリームが高速だと I/O がボトルネックに
    this.sql`INSERT INTO chunks (id, stream_id, body) VALUES (...)`;
  }
}

// Bad 2: メモリ上のみでチャンクを保持（プロセス再起動で消失）
class VolatileStream {
  private chunks: Map<string, string[]> = new Map();

  storeChunk(streamId: string, body: string) {
    const list = this.chunks.get(streamId) ?? [];
    list.push(body);
    this.chunks.set(streamId, list);
    // Durable Object のハイバネーションやエビクションで全チャンク喪失
  }
}

// Bad 3: 再開プロトコルなし（onConnect でいきなりリプレイ開始）
class UnsafeResumeStream {
  onConnect(connection: Connection) {
    // クライアントのメッセージハンドラ登録前にリプレイ開始
    // → ハンドラが未登録のためチャンクが喪失する
    this.replayChunks(connection);
  }
}

// Bad 4: ストリームのクリーンアップなし（ストレージの無限膨張）
class LeakyStream {
  complete(streamId: string) {
    this.sql`UPDATE metadata SET status = 'completed' WHERE id = ${streamId}`;
    // 古いチャンクの削除ロジックがない
    // → 長期運用で SQLite のサイズが際限なく増大
  }
}

// Bad 5: ライブ配信とリプレイの未分離（チャンク重複）
class DuplicatingStream {
  broadcast(message: string) {
    // 再接続中のクライアントもブロードキャスト対象に含まれる
    for (const conn of this.connections) {
      conn.send(message); // リプレイ中のクライアントがライブチャンクも受信 → 重複
    }
  }
}
```

## 適用ガイド

### どのような状況で使うべきか

- AI ストリーミング応答（LLM のトークン生成）を提供するチャットアプリケーションで、ネットワーク切断やページリロード後に応答を途中から再開したい場合
- エッジコンピューティング環境（Durable Objects、Lambda 等）で、プロセスのハイバネーションやエビクションが発生しうる場合
- 1対多のリアルタイム配信で、遅れて参加したクライアントに過去のストリームを再生する必要がある場合
- ストリームの途中状態を永続化し、障害復旧後に再開する必要がある場合

### 導入時の注意点

- **バッファサイズの調整**: デフォルトの閾値（10チャンク）はトレードオフである。小さくすると書き込み頻度が増え I/O コストが上がり、大きくするとクラッシュ時のデータ喪失量が増える。ストリームの速度とチャンクサイズに応じて調整する
- **チャンクサイズの上限ガード**: ストレージの行サイズ制限に対する防御ガードを必ず入れる。上限を超えるチャンクはリプレイから除外しても、ライブ配信は継続する設計にする
- **再開プロトコルのレース条件**: サーバー主導の RESUMING 通知だけでは、クライアントのハンドラ登録前にメッセージが到着する。クライアント主導の RESUME_REQUEST メッセージを追加し、ハンドラ登録完了後にリプレイを開始する設計にする
- **stale ストリームの検知**: 「streaming」状態のまま放置されたストリームを一定時間後に stale と判定し、ストレージから削除する仕組みが必要。これがないとゴーストストリームが永久に残る
- **チャンクパーサーのフォールバック**: リプレイは途中のチャンクから始まる可能性がある。`text-start` のような開始イベントが欠落しても `text-delta` だけで状態を構築できるフォールバックを実装する

### カスタマイズポイント

- **永続ストレージの選択**: cloudflare/agents は SQLite を使用しているが、Redis Streams、DynamoDB、KV ストアなど環境に合ったストレージに差し替え可能。キーは「順序付きチャンクの保存と範囲取得」ができること
- **バッファリング戦略**: 固定閾値だけでなく、時間ベース（100ms ごとにフラッシュ）や、ストリーム完了時の強制フラッシュなど、複数の条件を組み合わせられる
- **リプレイの範囲指定**: クライアントが「最後に受信したチャンクインデックス」を送信し、そこからのデルタリプレイに対応すると、全チャンクリプレイのコストを削減できる
- **バックプレッシャー閾値**: バッファ最大サイズ（100チャンク）はメモリ保護のための安全弁。チャンクサイズが大きい場合はより小さい値に、小さい場合はより大きい値に調整する
- **クリーンアップポリシー**: デフォルトは24時間で古いストリームを削除するが、監査要件がある場合はアーカイブテーブルへの移動や、外部ストレージへのエクスポートに変更できる

## 参考

- [repos/cloudflare/agents/streaming-patterns.md](../repos/cloudflare/agents/streaming-patterns.md) -- 元の分析（ResumableStream、3フェーズプロトコル、トランスポート抽象化）
