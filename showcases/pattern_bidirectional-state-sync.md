# Pattern: Bidirectional State Sync

> 出典: [repos/cloudflare/agents/state-sync-and-rpc.md](../repos/cloudflare/agents/state-sync-and-rpc.md)
> カテゴリ: pattern

## 概要

サーバとクライアントが同一のメッセージ型（`CF_AGENT_STATE`）で対称的に状態を送受信する双方向ステート同期プロトコル。サーバが権威的に永続化しブロードキャスト（送信元除外）する一方、クライアントは楽観的に即座にローカル更新する。`Serializable` 型制約によってシリアライズ不可能な値をコンパイル時に拒否し、ランタイムのデータ破損を防ぐ。

このパターンは WebSocket ベースのリアルタイムマルチプレイヤーアプリケーション（共同編集、ゲーム、ダッシュボード等）で広く応用できる。

## 背景・文脈

Cloudflare Agents SDK（`cloudflare/agents`）は Durable Object 上で動作するリアルタイムエージェントフレームワークである。複数クライアントが単一のサーバインスタンスに WebSocket で接続し、状態を共有する必要がある。

従来の WebSocket アプリケーションでは、状態同期プロトコルの設計で以下の問題が頻発する:

- クライアント→サーバとサーバ→クライアントで異なるメッセージ形式を使い、プロトコルが複雑化する
- 送信元クライアントが自分の変更をブロードキャストで二重に受け取る
- 状態変更フック内で再度 `setState` を呼び、無限ループが発生する
- `Date`, `Map`, `Set` などラウンドトリップしない型がステートに混入し、デシリアライズ後にデータが壊れる

Cloudflare Agents SDK はこれらの問題を「プロトコルの対称性」「送信元除外ブロードキャスト」「型レベルのシリアライズ検証」という 3 つの設計判断で体系的に解決している。

## 実装パターン

### 1. 対称的なメッセージプロトコル

サーバとクライアントが同一の enum 値 `CF_AGENT_STATE` を使って状態を送受信する。これにより送信側・受信側で別のパーサを書く必要がなくなり、プロトコルのメンテナンスコストが大幅に下がる。

```typescript
// packages/agents/src/types.ts:4-11
export enum MessageType {
  CF_AGENT_MCP_SERVERS = "cf_agent_mcp_servers",
  CF_MCP_AGENT_EVENT = "cf_mcp_agent_event",
  CF_AGENT_STATE = "cf_agent_state",
  CF_AGENT_STATE_ERROR = "cf_agent_state_error",
  CF_AGENT_IDENTITY = "cf_agent_identity",
  RPC = "rpc",
}
```

### 2. サーバ側: 永続化 → ブロードキャスト → フック呼び出し

サーバの `_setStateInternal` は以下を一連の流れで実行する:

1. `validateStateChange` で同期バリデーション（不正なら例外で中断）
2. SQLite に永続化
3. 全接続にブロードキャスト（送信元を除外）
4. `onStateChanged` フック呼び出し

```typescript
// packages/agents/src/index.ts:1216-1241
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

**設計のポイント**: `source !== "server" ? [source.id] : []` で送信元を除外リストに追加している。サーバ自身が発信元のときは除外なし（全員に送信）、クライアントが発信元のときはそのクライアントを除外する。

### 3. クライアント側: 楽観的ローカル更新 + サーバ送信

クライアントは同じ `CF_AGENT_STATE` メッセージ型でサーバに送信し、即座にローカルの状態更新コールバックを呼ぶ。サーバからの応答を待たない楽観的更新パターンにより、UI のレスポンスが良くなる。

```typescript
// packages/agents/src/client.ts:311-314
setState(state: State) {
  this.send(JSON.stringify({ state, type: MessageType.CF_AGENT_STATE }));
  this.options.onStateUpdate?.(state, "client");
}
```

`onStateUpdate` の第二引数 `"client"` は発信元を示す。サーバから受信した状態更新では `"server"` が渡される。これにより受信側で発信元を区別し、UI の挙動を分けることができる。

### 4. Serializable 型制約

再帰的な条件型 `CanSerialize<T>` によって、任意の型が JSON ラウンドトリップ可能かどうかをコンパイル時に判定する。

```typescript
// packages/agents/src/serializable.ts:57-88
type CanSerialize<T, Seen = never, Depth extends unknown[] = []> =
  IsMaxDepth<Depth> extends true ? true
  : T extends Seen ? true
  : T extends SerializablePrimitive ? true
  : T extends NonSerializable ? false
  : T extends readonly (infer U)[]
    ? CanSerialize<U, Seen | T, Increment<Depth>>
  : T extends object
    ? unknown extends T ? true
    : { [K in keyof T]: CanSerialize<T[K], Seen | T, Increment<Depth>> }
      extends { [K in keyof T]: true } ? true : false
  : true;
```

**設計判断**:

- **Date を明示的に拒否**: `JSON.stringify(new Date())` は文字列になるが、`JSON.parse` で Date に戻らない
- **深度制限 (MaxDepth = 10)**: AI SDK の `CoreMessage[]` のような深くネストした判別共用体で TypeScript の再帰制限エラーを回避
- **`unknown` を許容**: ジェネリックな戻り値型を持つメソッドを RPC として公開可能にするため

## Good Example

### 対称プロトコルによるシンプルな状態同期

サーバもクライアントも同じメッセージ構造を使い、`source` パラメータで発信元を追跡する。

```typescript
// サーバ側
class GameRoom extends Agent<Env, GameState> {
  onStateChanged(state: GameState, source: Connection | "server") {
    // source をチェックして処理を分岐
    if (source !== "server") {
      console.log(`Player ${source.id} updated state`);
    }
  }
}

// クライアント側
const agent = new AgentClient<GameState>({
  agent: "game-room",
  name: "room-1",
  onStateUpdate: (state, source) => {
    if (source === "client") {
      // 自分が送信した楽観的更新
      renderOptimistic(state);
    } else {
      // サーバから受信した確定状態
      renderConfirmed(state);
    }
  },
});

// クライアントの setState はサーバと同じメッセージ型を使う
agent.setState({ players: updatedPlayers });
```

### 同期バリデーションによる不正状態の早期拒否

永続化・ブロードキャストの前段でバリデーションを実行し、不正な状態がクライアントに伝搬することを防ぐ。

```typescript
class GameRoom extends Agent<Env, GameState> {
  // 同期バリデーション: 不正なら例外で即中断
  validateStateChange(
    nextState: GameState,
    source: Connection | "server",
  ) {
    if (nextState.players.length > 4) {
      throw new Error("Maximum 4 players allowed");
    }
    if (source !== "server" && nextState.isLocked) {
      throw new Error("Room is locked");
    }
  }
}
```

## Bad Example

### 送信元を除外しないブロードキャスト

```typescript
// Bad: 送信元にもブロードキャストしてしまう
private broadcast(message: string): void {
  for (const conn of this.connections) {
    conn.send(message);
  }
}
// クライアントが自分の変更を二重に受け取り、
// UI が意図しない状態になる
```

```typescript
// Good: 送信元を除外リストで管理する
private broadcast(message: string, excludeIds: string[] = []): void {
  for (const conn of this.connections) {
    if (!excludeIds.includes(conn.id)) {
      conn.send(message);
    }
  }
}
```

### onStateChanged 内での無条件 setState

```typescript
// Bad: source をチェックしないため無限ループが発生
onStateChanged(state: GameState) {
  this.setState({ ...state, lastUpdated: Date.now() });
  // setState → onStateChanged → setState → ...
}
```

```typescript
// Good: source で自己トリガーを除外
onStateChanged(state: GameState, source: Connection | "server") {
  if (source === "server") return; // 自分が setState した場合はスキップ
  this.setState({ ...state, lastUpdated: Date.now() });
}
```

### ラウンドトリップしない型をステートに格納

```typescript
// Bad: Date は JSON.parse で文字列のまま戻ってくる
interface BadState {
  createdAt: Date; // コンパイルエラー（Serializable 型制約）
  metadata: Map<string, string>; // コンパイルエラー
}

// Good: シリアライズ可能な表現を使う
interface GoodState {
  createdAt: string; // ISO 8601 文字列
  metadata: Record<string, string>; // プレーンオブジェクト
}
```

## 適用ガイド

### どのような状況で使うべきか

- **複数クライアントがリアルタイムに状態を共有する**アプリケーション（共同編集、チャット、ゲーム、ダッシュボード）
- **サーバが権威的な状態を持ち**、クライアントは楽観的に更新する構成
- **型安全性が重要**で、シリアライズ不可能な値がステートに混入するリスクを排除したいとき

### 導入時の注意点

- **送信元除外は必須**: ブロードキャスト時に送信元を除外しないと、クライアントが自分の変更を二重に受け取る。これは「なぜか状態が 2 回更新される」という再現困難なバグの典型的原因
- **バリデーションは同期で**: 非同期バリデーションでは不正な状態が一時的にクライアントに伝搬するリスクがある。永続化の前段に同期フックを置くこと
- **`onStateChanged` 内の `setState` に注意**: 必ず `source` を確認し、自己トリガーの無限ループを防ぐこと
- **アクセス制御は境界で集約**: readonly や権限チェックを個々のメソッドに分散させず、`setState` のような単一ポイントで強制する。チェック漏れのリスクを排除できる
- **副作用の順序**: `setState` の前に副作用（メール送信、決済処理等）を実行すると、アクセス制御チェックを通過する前に副作用が完了してしまう。`setState` を先に呼ぶことで、権限がない場合は即座に例外となる

### カスタマイズポイント

- **メッセージ型の拡張**: `MessageType` enum に独自のメッセージ型を追加し、状態同期以外のプロトコル（カーソル位置の共有、タイピングインジケータ等）を同じ WebSocket 上で多重化できる
- **楽観的更新の戦略**: クライアント側の `onStateUpdate` で `source` を使い、楽観的更新と確定更新を異なる UI フィードバックで表示する（例: 楽観的更新はフェードイン、確定更新は即座に反映）
- **バリデーションロジック**: `validateStateChange` をオーバーライドして、ゲームルールやビジネスルールに応じたドメイン固有のバリデーションを追加できる
- **Serializable 型の深度制限**: デフォルトの 10 レベルで不足する場合は `MaxDepth` のタプル長を調整できるが、TypeScript の再帰制限に注意

## 参考

- [repos/cloudflare/agents/state-sync-and-rpc.md](../repos/cloudflare/agents/state-sync-and-rpc.md) -- 元の分析
