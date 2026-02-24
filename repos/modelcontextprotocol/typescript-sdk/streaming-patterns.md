# streaming-patterns

> リポジトリ: modelcontextprotocol/typescript-sdk
> 分析日: 2026-02-24

## 概要

MCP TypeScript SDK は SSE (Server-Sent Events)・Streamable HTTP・stdio・WebSocket の 4 つのトランスポートを実装し、JSON-RPC メッセージをストリーミングする。共通の `Transport` インターフェースによってプロトコル層とトランスポート層を分離し、各トランスポートが固有のストリーム特性（再開可能性、バックプレッシャー、接続管理）を内部に閉じ込めている。さらに `AsyncGenerator` を用いた長時間タスクのストリーミング API や、SSE プライミングイベントによる再開可能ストリームなど、プロダクションレベルのストリーミングプラクティスが体系的に実装されている点で注目に値する。

## 背景にある原則

- **トランスポート不可知なプロトコル設計**: ストリームの確立・維持・再開はトランスポートの責務であり、プロトコル層は `send` / `onmessage` の契約のみに依存すべき。根拠: `Protocol` クラスは `Transport` インターフェース（`packages/core/src/shared/transport.ts:74-134`）だけを通じて通信し、SSE や stdio の詳細を一切知らない。これにより新しいトランスポート（WebSocket 等）を追加する際にプロトコル層を変更する必要がない。

- **ストリームの中断と再開を一級市民として扱う**: ネットワーク切断は例外ではなく通常の動作モードであり、再開可能性を設計時点で組み込むべき。根拠: `EventStore` インターフェース（`packages/server/src/server/streamableHttp.ts:27-54`）と SSE の `Last-Event-ID` ヘッダーによる再開メカニズムが、オプトイン可能な形で組み込まれている。

- **書き込みバックプレッシャーを明示的に処理する**: ストリーム書き込みが詰まった場合にブロックではなく drain イベントを待つべき。根拠: stdio トランスポートの `send` メソッド（`packages/server/src/server/stdio.ts:89-98`）が `write()` の戻り値を確認し、`false` なら `drain` を待つ実装になっている。

- **キャンセレーションを協調的に伝播する**: リクエストのキャンセルはクライアントからサーバーまで JSON-RPC 通知として伝播し、サーバー側は `AbortSignal` で handler に伝えるべき。根拠: `Protocol._oncancel`（`packages/core/src/shared/protocol.ts:630-637`）が `notifications/cancelled` を受け取り、対応する `AbortController` を abort する設計。

## 実例と分析

### 1. Transport インターフェースによる抽象化

全てのトランスポートは共通の `Transport` インターフェースを実装する。このインターフェースは最小限の契約（`start`, `send`, `close`, コールバック群）で構成される。

```typescript
// packages/core/src/shared/transport.ts:74-134
export interface Transport {
    start(): Promise<void>;
    send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void>;
    close(): Promise<void>;
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
    sessionId?: string;
}
```

注目すべきは `TransportSendOptions` に含まれる `relatedRequestId` と `resumptionToken`。これにより、プロトコル層がストリームの文脈情報をトランスポートに渡せる。トランスポートは自身がこれを活用できなければ無視すればよい。

### 2. stdio のストリーム処理: ReadBuffer パターン

stdio トランスポートは改行区切りの JSON-RPC メッセージを扱うため、`ReadBuffer` クラスでバッファリングを行う。

```typescript
// packages/core/src/shared/stdio.ts:7-32
export class ReadBuffer {
    private _buffer?: Buffer;

    append(chunk: Buffer): void {
        this._buffer = this._buffer ? Buffer.concat([this._buffer, chunk]) : chunk;
    }

    readMessage(): JSONRPCMessage | null {
        if (!this._buffer) { return null; }
        const index = this._buffer.indexOf('\n');
        if (index === -1) { return null; }
        const line = this._buffer.toString('utf8', 0, index).replace(/\r$/, '');
        this._buffer = this._buffer.subarray(index + 1);
        return deserializeMessage(line);
    }
}
```

`subarray` を使い、不要なコピーを避けている。`processReadBuffer` のループ（`packages/server/src/server/stdio.ts:56-69`）は1回の `data` イベントで複数メッセージが到着するケースに対応している。

### 3. Streamable HTTP: SSE ストリームの生成と管理

サーバー側の Streamable HTTP トランスポートは、POST リクエストに対して `ReadableStream` + `ReadableStreamDefaultController` で SSE ストリームを生成する。

```typescript
// packages/server/src/server/streamableHttp.ts:740-749
const readable = new ReadableStream<Uint8Array>({
    start: controller => {
        streamController = controller;
    },
    cancel: () => {
        // Stream was cancelled by client
        this._streamMapping.delete(streamId);
    }
});
```

SSE イベントのフォーマットは `writeSSEEvent` メソッドに集約されている。

```typescript
// packages/server/src/server/streamableHttp.ts:565-583
private writeSSEEvent(
    controller: ReadableStreamDefaultController<Uint8Array>,
    encoder: InstanceType<typeof TextEncoder>,
    message: JSONRPCMessage,
    eventId?: string
): boolean {
    try {
        let eventData = `event: message\n`;
        if (eventId) { eventData += `id: ${eventId}\n`; }
        eventData += `data: ${JSON.stringify(message)}\n\n`;
        controller.enqueue(encoder.encode(eventData));
        return true;
    } catch { return false; }
}
```

### 4. クライアント側の SSE パイプライン処理

クライアント側は Web Streams API の `pipeThrough` でストリームを変換パイプラインとして構成する。

```typescript
// packages/client/src/client/streamableHttp.ts:325-336
const reader = stream
    .pipeThrough(new TextDecoderStream() as ReadableWritablePair<string, Uint8Array>)
    .pipeThrough(
        new EventSourceParserStream({
            onRetry: (retryMs: number) => {
                this._serverRetryMs = retryMs;
            }
        })
    )
    .getReader();
```

バイナリストリーム -> テキストデコード -> SSE パースという変換チェーンを宣言的に構成している。`onRetry` コールバックでサーバーが指示する再接続間隔をキャプチャしている点も重要。

### 5. 再開可能ストリームとプライミングイベント

サーバーは `EventStore` が設定されている場合にプライミングイベント（空の data を持つ SSE イベント）を送信し、クライアントに再開能力を通知する。

```typescript
// packages/server/src/server/streamableHttp.ts:374-398
private async writePrimingEvent(...): Promise<void> {
    if (!this._eventStore) { return; }
    // Only send priming events to clients with protocol version >= 2025-11-25
    if (protocolVersion < '2025-11-25') { return; }
    const primingEventId = await this._eventStore.storeEvent(streamId, {} as JSONRPCMessage);
    let primingEvent = `id: ${primingEventId}\ndata: \n\n`;
    if (this._retryInterval !== undefined) {
        primingEvent = `id: ${primingEventId}\nretry: ${this._retryInterval}\ndata: \n\n`;
    }
    controller.enqueue(encoder.encode(primingEvent));
}
```

クライアント側はプライミングイベントの受信を追跡し、切断時の再接続判断に使う。

```typescript
// packages/client/src/client/streamableHttp.ts:314-389
let hasPrimingEvent = false;
let receivedResponse = false;
// ...
if (event.id) {
    lastEventId = event.id;
    hasPrimingEvent = true;
    onresumptiontoken?.(event.id);
}
if (!event.data) { continue; } // Skip priming events
// ...
const canResume = isReconnectable || hasPrimingEvent;
const needsReconnect = canResume && !receivedResponse;
```

### 6. 指数バックオフによる再接続

クライアントの再接続はサーバー提供の retry 値を優先し、なければ指数バックオフを使う。

```typescript
// packages/client/src/client/streamableHttp.ts:263-276
private _getNextReconnectionDelay(attempt: number): number {
    if (this._serverRetryMs !== undefined) {
        return this._serverRetryMs;
    }
    const initialDelay = this._reconnectionOptions.initialReconnectionDelay;
    const growFactor = this._reconnectionOptions.reconnectionDelayGrowFactor;
    const maxDelay = this._reconnectionOptions.maxReconnectionDelay;
    return Math.min(initialDelay * Math.pow(growFactor, attempt), maxDelay);
}
```

### 7. AsyncGenerator による長時間タスクのストリーミング

`requestStream` メソッドは `AsyncGenerator` でタスクの状態遷移をストリームとして公開する。

```typescript
// packages/core/src/shared/protocol.ts:1038-1132
protected async *requestStream<T extends AnyObjectSchema>(
    request: Request, resultSchema: T, options?: RequestOptions
): AsyncGenerator<ResponseMessage<SchemaOutput<T>>, void, void> {
    // ...
    yield { type: 'taskCreated', task: createResult.task };
    while (true) {
        const task = await this.getTask({ taskId }, options);
        yield { type: 'taskStatus', task };
        if (isTerminal(task.status)) { /* yield result or error, return */ }
        const pollInterval = task.pollInterval ?? this._options?.defaultTaskPollInterval ?? 1000;
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        options?.signal?.throwIfAborted();
    }
}
```

### 8. 通知のデバウンス

同一ティック内に複数発生する通知を1つにまとめるマイクロタスクベースのデバウンス。

```typescript
// packages/core/src/shared/protocol.ts:1379-1425
if (canDebounce) {
    if (this._pendingDebouncedNotifications.has(notification.method)) { return; }
    this._pendingDebouncedNotifications.add(notification.method);
    Promise.resolve().then(() => {
        this._pendingDebouncedNotifications.delete(notification.method);
        if (!this._transport) { return; }
        // send notification
    });
    return;
}
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 複数のトランスポート実装を統一的に扱う
  - 適用条件: 通信方式をランタイムで切り替えたい場合
  - コード例: `Transport` インターフェース（`packages/core/src/shared/transport.ts:74-134`）と `StdioServerTransport`、`WebStandardStreamableHTTPServerTransport`、`WebSocketClientTransport` の各実装
  - 注意点: インターフェースに含めるオプショナル機能（`resumptionToken` 等）が増えると、実装側の負担が増える

- **Adapter パターン** (分類: 構造)
  - 解決する問題: Node.js HTTP API と Web Standard API の橋渡し
  - 適用条件: ランタイム固有の API を抽象化したい場合
  - コード例: `NodeStreamableHTTPServerTransport`（`packages/middleware/node/src/streamableHttp.ts:67-204`）が `WebStandardStreamableHTTPServerTransport` をラップし、`@hono/node-server` の `getRequestListener` で変換
  - 注意点: `overrideGlobalObjects: false` を明示しないと Next.js 等のフレームワークの Response クラスが上書きされる

- **Pipeline パターン** (分類: 振る舞い)
  - 解決する問題: バイナリストリームから構造化メッセージへの段階的変換
  - 適用条件: データフォーマットの変換が複数段にわたる場合
  - コード例: `pipeThrough(TextDecoderStream).pipeThrough(EventSourceParserStream)`（`packages/client/src/client/streamableHttp.ts:327-328`）

## Good Patterns

- **バックプレッシャー対応の書き込み**: stdio トランスポートで `write()` の戻り値を確認し、バッファが詰まっていれば `drain` を待つ。ストリーム書き込みで「火を放って忘れる」ことを避けている。

```typescript
// packages/server/src/server/stdio.ts:89-98
send(message: JSONRPCMessage): Promise<void> {
    return new Promise(resolve => {
        const json = serializeMessage(message);
        if (this._stdout.write(json)) {
            resolve();
        } else {
            this._stdout.once('drain', resolve);
        }
    });
}
```

- **プライミングイベントによるプロトコルバージョン互換**: 古いクライアントが空データの SSE イベントを処理できない場合を考慮し、プロトコルバージョンをチェックしてからプライミングイベントを送信する。

```typescript
// packages/server/src/server/streamableHttp.ts:385-388
// Only send priming events to clients with protocol version >= 2025-11-25
if (protocolVersion < '2025-11-25') { return; }
```

- **段階的シャットダウン**: stdio クライアントの `close()` は stdin を閉じ、2秒待ち、SIGTERM を送り、さらに2秒待ち、最後に SIGKILL を送る。各段階でプロセスの終了を確認する。

```typescript
// packages/client/src/client/stdio.ts:205-243
processToClose.stdin?.end();
await Promise.race([closePromise, new Promise(resolve => setTimeout(resolve, 2000).unref())]);
if (processToClose.exitCode === null) {
    processToClose.kill('SIGTERM');
    await Promise.race([closePromise, new Promise(resolve => setTimeout(resolve, 2000).unref())]);
}
if (processToClose.exitCode === null) {
    processToClose.kill('SIGKILL');
}
```

- **再接続判断の分離**: レスポンスを受信済みなら再接続不要、プライミングイベント受信済みなら再開可能という2つの条件を明確に分離して再接続判断を行う。

```typescript
// packages/client/src/client/streamableHttp.ts:378-380
const canResume = isReconnectable || hasPrimingEvent;
const needsReconnect = canResume && !receivedResponse;
```

## Anti-Patterns / 注意点

- **ReadableStream を controller 参照保持で使うときの早すぎるクローズ**: SSE ストリームで `controller.close()` が既にクローズ済みの controller に対して呼ばれるケースがある。SDK はこれを空の `catch` ブロックで吸収しているが、これはストリームの状態管理が controller の外部に漏れていることを示す。

```typescript
// Bad: controller がクローズ済みか確認せず close を呼ぶ
cleanup: () => {
    this._streamMapping.delete(streamId);
    try {
        streamController!.close();
    } catch {
        // Controller might already be closed
    }
}

// Better: ストリームの状態を明示的に管理する
cleanup: () => {
    this._streamMapping.delete(streamId);
    if (!streamClosed) {
        streamClosed = true;
        streamController!.close();
    }
}
```

- **認証リトライの無限ループリスク**: SSE クライアントの `send` メソッドで 401 レスポンス時に再帰的に `this.send(message)` を呼ぶ。Streamable HTTP クライアントは `_hasCompletedAuthFlow` フラグでサーキットブレーカーを実装しているが、レガシー SSE クライアントにはこの保護がない。

```typescript
// packages/client/src/client/sse.ts:283 — サーキットブレーカーなし
return this.send(message);

// packages/client/src/client/streamableHttp.ts:498-503 — サーキットブレーカーあり
if (this._hasCompletedAuthFlow) {
    throw new SdkError(SdkErrorCode.ClientHttpAuthentication,
        'Server returned 401 after successful authentication', { status: 401, text });
}
```

## 導出ルール

- `[MUST]` ストリーム書き込み時にバックプレッシャーを処理する ── `write()` の戻り値が `false` なら `drain` イベントを待ってから次の書き込みを行う
  - 根拠: stdio トランスポートの `send` メソッド（`packages/server/src/server/stdio.ts:89-98`）がこのパターンを一貫して実装している。無視するとメモリリークやメッセージ欠損の原因になる。

- `[MUST]` 長時間接続のキャンセレーションを `AbortSignal` で伝播する ── リクエストハンドラに渡す context に `signal` を含め、クライアントからのキャンセル通知を `AbortController.abort()` で反映する
  - 根拠: `Protocol._oncancel`（`packages/core/src/shared/protocol.ts:630-637`）が `notifications/cancelled` を受け取り AbortController を abort する設計。ハンドラが signal を無視すると、キャンセル済みリクエストのリソースが解放されない。

- `[SHOULD]` SSE ストリームの再開可能性をオプトインで提供する ── `EventStore` のようなイベント永続化インターフェースを分離し、設定された場合のみプライミングイベントと `Last-Event-ID` による再開をサポートする
  - 根拠: `WebStandardStreamableHTTPServerTransport` は `eventStore` オプションが提供された場合のみ再開機能を有効にする（`packages/server/src/server/streamableHttp.ts:113-114`）。再開が不要な用途では不要な複雑性を持ち込まない。

- `[SHOULD]` 再接続ロジックにサーバー提供の retry 値と指数バックオフの両方をサポートする ── サーバーが retry を指示すればそれを優先し、なければ指数バックオフにフォールバックする
  - 根拠: `_getNextReconnectionDelay`（`packages/client/src/client/streamableHttp.ts:263-276`）がサーバー側の retry フィールドを優先しつつ指数バックオフをフォールバックとして使う設計。

- `[SHOULD]` 高頻度通知をマイクロタスクベースでデバウンスする ── 同一イベントループティック内の同一メソッド通知を1回にまとめ、パラメータ付き通知やリクエスト関連通知はデバウンスしない
  - 根拠: `Protocol.notification`（`packages/core/src/shared/protocol.ts:1373-1425`）の `Promise.resolve().then()` によるデバウンス実装。`list_changed` のような通知が大量に発生するケースでネットワーク負荷を軽減する。

- `[SHOULD]` プロセスの段階的シャットダウンを実装する ── stdin 終了 -> 待機 -> SIGTERM -> 待機 -> SIGKILL の順で、各段階で終了を確認する
  - 根拠: `StdioClientTransport.close()`（`packages/client/src/client/stdio.ts:205-243`）がこの段階的シャットダウンを実装。即座の SIGKILL はデータ破損のリスクがある。

- `[AVOID]` 認証リトライで再帰呼び出しをサーキットブレーカーなしに行う ── 401 レスポンス時に再認証後に同じメソッドを再帰的に呼ぶ場合、成功後に再度 401 が返るケースに対するガードが必要
  - 根拠: `StreamableHTTPClientTransport` は `_hasCompletedAuthFlow` フラグで保護しているが（`packages/client/src/client/streamableHttp.ts:498-503`）、レガシー `SSEClientTransport` にはこの保護がない（`packages/client/src/client/sse.ts:283`）。

## 適用チェックリスト

- [ ] ストリーミングプロトコルとトランスポートが分離されているか（プロトコル層がトランスポート固有の API に依存していないか）
- [ ] ストリーム書き込み時にバックプレッシャー（`drain` イベントまたは同等のメカニズム）を処理しているか
- [ ] リクエストのキャンセレーションが `AbortSignal` でハンドラまで伝播しているか
- [ ] SSE ストリームの切断・再接続の際に、`Last-Event-ID` による再開をサポートしているか（必要な場合）
- [ ] 再接続に指数バックオフとサーバー提供の retry 値の両方を考慮しているか
- [ ] 認証リトライに無限ループ防止のサーキットブレーカーがあるか
- [ ] プロセス終了時に段階的シャットダウン（正常終了待ち -> SIGTERM -> SIGKILL）を実装しているか
- [ ] 高頻度の同一通知をデバウンスしてネットワーク負荷を軽減しているか
- [ ] ストリームのクローズ時にリソース（マッピング、タイマー、コントローラー）が適切にクリーンアップされているか
