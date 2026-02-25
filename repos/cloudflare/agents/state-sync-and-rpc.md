# State Sync and RPC

> リポジトリ: cloudflare/agents
> 分析日: 2026-02-25

## 概要

Cloudflare Agents SDK は、WebSocket 上で双方向のステート同期と reflection-based RPC を実現するフレームワークである。サーバ側の `setState()` が全クライアントにブロードキャストされ、クライアント側の `setState()` がサーバに送信されるという対称的なプロトコルを、共通のメッセージ型 `CF_AGENT_STATE` で統一している。RPC はデコレータ `@callable()` で公開されたメソッドをクライアントから名前で呼び出す仕組みであり、型安全性は `Serializable` 型システムによってコンパイル時に強制される。この設計は「状態管理・永続化・同期・アクセス制御」を単一の抽象に凝縮しており、リアルタイムマルチプレイヤーアプリケーションの構築パターンとして注目に値する。

## 背景にある原則

- **単一権威源泉 + 双方向パイプ**: サーバ（Durable Object）が状態の権威的な保存先であり、SQLite に永続化される。クライアントもサーバも同じメッセージ型 `CF_AGENT_STATE` を使って状態を送受信するが、永続化とブロードキャストは常にサーバが行う。これにより「誰が変更したか」の追跡（`source` パラメータ）が容易になり、無限ループ防止パターンが自然に導かれる（`packages/agents/src/index.ts:1216-1275`）。

- **アクセス制御は境界で強制する**: readonly 制約は個々の callable メソッドではなく `setState()` 内部で一箇所チェックされる。これにより開発者がメソッドごとにパーミッションチェックを書く必要がなくなり、漏れのリスクを排除する（`design/readonly-connections.md:38-66`）。

- **型で不正を防ぐ、ランタイムで不正を捕捉する**: RPC のパラメータと戻り値は `Serializable` 型によってコンパイル時に JSON シリアライズ可能性が保証される。一方、ランタイムでは `isRPCRequest` 型ガードと `_isCallable` チェックが二重のゲートとなる（`packages/agents/src/serializable.ts`, `packages/agents/src/index.ts:104-117, 965-977`）。

- **プロトコルの対称性で認知負荷を下げる**: クライアント（`AgentClient`, `useAgent`）とサーバ（`Agent`）が同一の `MessageType` enum と JSON 構造を共有する。これにより「送信側で JSON.stringify、受信側で JSON.parse」というワンパスのプロトコルが成立し、カスタムシリアライザやバイナリエンコーディングが不要になる（`packages/agents/src/types.ts:1-11`）。

## 実例と分析

### 双方向ステート同期プロトコル

状態同期の流れは 3 つのパスに分かれる:

1. **サーバ発 (setState)**: `this.setState()` → `_setStateInternal()` → SQLite 永続化 → `_broadcastProtocol()` で全接続にブロードキャスト → `onStateChanged` フック実行
2. **クライアント発 (setState)**: クライアントが `CF_AGENT_STATE` メッセージ送信 → サーバの `onMessage` が `isStateUpdateMessage` で検出 → readonly チェック → `_setStateInternal(state, connection)` → 送信元以外にブロードキャスト
3. **接続時の初期同期**: `onConnect` で現在の `this.state` を接続先に送信（`packages/agents/src/index.ts:1089-1096`）

ブロードキャスト時に送信元の接続を除外する設計（`_broadcastProtocol` の `excludeIds`）は、クライアントが自分の変更を二重に受け取ることを防ぐ。クライアント側でも `onStateUpdate` の `source` パラメータ（`"server"` or `"client"`）で発信元を区別できる。

### Reflection-based RPC

RPC は以下のステップで動作する:

1. クライアントが `{ type: "rpc", id: UUID, method: "methodName", args: [...] }` を送信
2. サーバが `isRPCRequest` 型ガードで構造検証
3. `this[method]` でメソッドを動的参照し、`_isCallable` で `WeakMap<Function, CallableMetadata>` を参照して公開可否を確認
4. ストリーミング対応メソッドの場合は `StreamingResponse` オブジェクトを注入
5. 結果を `RPCResponse` として返送

メソッドの公開は `@callable()` デコレータ経由で `WeakMap` に登録する方式である。これは `callableMetadata` という WeakMap をメソッド→メタデータのレジストリとして使うことで、プロトタイプチェーンの走査なしにO(1)で公開可否を判定できる。

### Serializable 型制約

`serializable.ts` は再帰的な条件型 `CanSerialize<T>` によって、任意の型が JSON シリアライズ可能かどうかをコンパイル時に判定する。特筆すべき設計判断:

- **Date を NonSerializable に分類**: `Date` は `JSON.stringify` で文字列になるが、`JSON.parse` で Date に戻らない（ラウンドトリップしない）。このため明示的に拒否する
- **再帰深度制限**: `MaxDepth`（10 レベル）を超えたらシリアライズ可能と仮定する。AI SDK の `CoreMessage[]` のような深くネストした判別共用体で TypeScript の再帰制限エラーを防ぐための現実的な妥協
- **`unknown` の許容**: `unknown extends T` の場合は true を返す。ジェネリックな戻り値型を持つメソッドを RPC として公開可能にするため

### Proxy-based Stub パターン

`useAgent` フックは `createStubProxy` で Proxy オブジェクトを生成し、`agent.stub.methodName(args)` のように自然な呼び出し構文を提供する。Proxy の `get` トラップは `toJSON`, `then`, `Symbol` 系などの内部メソッドを除外し、`console.log` や `JSON.stringify` 時の意図しない RPC 呼び出しを防止する。

## コード例

```typescript
// packages/agents/src/index.ts:1216-1241
// サーバ側の状態更新: 永続化 → ブロードキャスト → フック呼び出し
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

```typescript
// packages/agents/src/serializable.ts:57-88
// 再帰的シリアライズ可能性チェック（深度制限付き）
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

```typescript
// packages/agents/src/react.tsx:61-93
// Proxy stub: 内部メソッドを除外して RPC のみを透過させる
function createStubProxy<T = Record<string, Method>>(
  call: (method: string, args: unknown[]) => unknown,
): T {
  return new Proxy<any>({}, {
    get: (_target, method) => {
      if (
        typeof method === "symbol"
        || method === "toJSON" || method === "then"
        || method === "catch" || method === "finally"
        || method === "valueOf" || method === "toString"
        || method === "constructor" || method === "prototype"
        || method === "$$typeof" || method === "@@toStringTag"
        || method === "asymmetricMatch" || method === "nodeType"
      ) {
        return undefined;
      }
      return (...args: unknown[]) => call(method as string, args);
    },
  });
}
```

```typescript
// packages/agents/src/client.ts:311-314
// クライアント側の setState: 同一メッセージ型でサーバに送信
setState(state: State) {
  this.send(JSON.stringify({ state, type: MessageType.CF_AGENT_STATE }));
  this.options.onStateUpdate?.(state, "client");
}
```

## パターンカタログ

- **Observer パターン** (分類: 振る舞い)
  - 解決する問題: 状態変更を複数のクライアントにリアルタイム通知する
  - 適用条件: WebSocket で接続された複数クライアントが同一状態を共有するとき
  - コード例: `packages/agents/src/index.ts:1234-1241`（`_broadcastProtocol` による全接続への通知）
  - 注意点: 送信元を除外しないと変更の二重適用が起きる

- **Proxy パターン** (分類: 構造)
  - 解決する問題: RPC 呼び出しを通常のメソッド呼び出しに見せかけ、DX を向上する
  - 適用条件: リモートオブジェクトのメソッドをローカルに呼び出したいとき
  - コード例: `packages/agents/src/react.tsx:61-93`（`createStubProxy`）
  - 注意点: `toJSON`, `then` などの JS 内部メソッドをフィルタしないと、`console.log` や Promise chain で意図しない RPC が発生する

- **Decorator パターン** (分類: 構造)
  - 解決する問題: メソッドの RPC 公開を宣言的に制御する
  - 適用条件: クラスメソッドの一部だけを外部に公開したいとき
  - コード例: `packages/agents/src/index.ts:163-174`（`@callable` デコレータ）
  - 注意点: TC39 標準デコレータを使用しており、TypeScript の `experimentalDecorators` と互換性がない

## Good Patterns

- **メッセージ型 enum による型安全なプロトコル**: `MessageType` enum を `types.ts` に集約し、クライアント・サーバ双方が同一の定数を参照する。文字列リテラルの散在を防ぎ、IDE 補完と型チェックを効かせる。

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

- **WeakMap によるメタデータレジストリ**: `callableMetadata` を `WeakMap<Function, CallableMetadata>` として実装し、デコレータで登録、RPC ハンドラで参照する。WeakMap のため GC を妨げず、O(1) ルックアップが可能。

```typescript
// packages/agents/src/index.ts:142
const callableMetadata = new WeakMap<Function, CallableMetadata>();

// packages/agents/src/index.ts:2517-2518
private _isCallable(method: string): boolean {
  return callableMetadata.has(this[method as keyof this] as Function);
}
```

- **validateStateChange による同期ゲーティング**: 状態変更の前段に同期的なバリデーションフックを置き、非同期の `onStateChanged` とは明確に分離している。これにより「不正な状態がブロードキャストされてから拒否される」事態を防ぐ。

```typescript
// packages/agents/src/index.ts:1220-1221
// _setStateInternal の冒頭で同期バリデーション
this.validateStateChange(nextState, source);
```

- **接続状態の透過的ラッピング**: `_ensureConnectionWrapped` で `connection.state` の getter/setter をオーバーライドし、`_cf_readonly` などの内部フラグをユーザーコードから隠蔽する。`Object.getOwnPropertyDescriptor` でアクセサ/データプロパティを判別し、両方のケースを安全に処理する。

```typescript
// packages/agents/src/index.ts:1303-1391
private _ensureConnectionWrapped(connection: Connection) {
  if (this._rawStateAccessors.has(connection)) return;
  const descriptor = Object.getOwnPropertyDescriptor(connection, "state");
  // ... accessor vs data property handling
}
```

## Anti-Patterns / 注意点

- **副作用を setState より先に実行する**: readonly 制約は `setState()` の時点でチェックされるため、その前に実行される副作用（メール送信、決済処理など）は止められない。

```typescript
// Bad: 副作用が先に実行される
@callable()
async processOrder(orderId: string) {
  await sendEmail(orderId);      // 実行される
  await chargePayment(orderId);  // 実行される
  this.setState({ ... });        // ここで readonly エラー
}

// Better: setState を先に呼び、アクセス制御を早期に効かせる
@callable()
async processOrder(orderId: string) {
  this.setState({ status: "processing" }); // readonly なら即座に例外
  await sendEmail(orderId);
  await chargePayment(orderId);
}
```

- **onStateChanged 内での無条件 setState**: `source` をチェックせずに `setState` を呼ぶと、自分の変更に反応して無限ループが発生する。

```typescript
// Bad: 無限ループ
onStateChanged(state: State) {
  this.setState({ ...state, lastUpdated: Date.now() });
}

// Better: source チェックで自己トリガーを除外
onStateChanged(state: State, source: Connection | "server") {
  if (source === "server") return;
  this.setState({ ...state, lastUpdated: Date.now() });
}
```

- **Date をステートに直接格納する**: `Serializable` 型は `Date` をコンパイル時に拒否するが、実行時に `new Date()` を state に入れると JSON.stringify で文字列化され、parse 時に Date に戻らない（ラウンドトリップの破壊）。

```typescript
// Bad: Date はラウンドトリップしない
this.setState({ createdAt: new Date() });

// Better: ISO 文字列として保存
this.setState({ createdAt: new Date().toISOString() });
```

## 導出ルール

- `[MUST]` 双方向ステート同期では送信元を除外してブロードキャストする。そうしないとクライアントが自分の変更を二重に受け取り、不整合や無限ループを引き起こす
  - 根拠: `_broadcastProtocol` が `source !== "server" ? [source.id] : []` で送信元を除外する（`packages/agents/src/index.ts:1234-1241`）

- `[MUST]` WebSocket 上の RPC では、メソッド公開可否をデコレータ等で宣言的に管理し、未登録メソッドの呼び出しをランタイムで拒否する。リフレクションベースの RPC は全 public メソッドが呼び出し候補になるため、ホワイトリスト制御がなければ内部メソッドの意図しない実行を許す
  - 根拠: `_isCallable` が `WeakMap` でデコレータ登録済みメソッドのみ許可する（`packages/agents/src/index.ts:2517-2518`）

- `[MUST]` RPC のパラメータと戻り値にはシリアライズ可能性を型レベルで強制する。Date, Map, Set, Function などはラウンドトリップしないため、コンパイル時にエラーとすることでランタイムのデータ破損を防ぐ
  - 根拠: `NonSerializable` 型が Date, Map, Function 等を明示的に列挙し、`RPCMethod` 型が `CanSerialize` / `AllSerializableValues` で引数・戻り値を検証する（`packages/agents/src/serializable.ts:8-32, 153-163`）

- `[SHOULD]` 状態バリデーションは永続化・ブロードキャストの前段に同期フックとして配置する。非同期バリデーションでは不正な状態が一時的にクライアントに伝搬するリスクがある
  - 根拠: `validateStateChange` は `_setStateInternal` の冒頭で同期的に呼ばれ、例外で更新を中断する（`packages/agents/src/index.ts:1221`）

- `[SHOULD]` Proxy ベースの RPC stub では、JS の内部メソッド（`toJSON`, `then`, `Symbol` 系等）をフィルタして RPC 呼び出しから除外する。そうしないと `console.log(stub)` や `await stub` で意図しない RPC が発火する
  - 根拠: `createStubProxy` が 12 個の内部メソッド名を明示的に除外する（`packages/agents/src/react.tsx:69-88`）

- `[SHOULD]` 再帰的な型チェックには深度制限を設ける。深くネストした型（AI SDK の `CoreMessage[]` 等）で TypeScript の "Type instantiation is excessively deep" エラーを避けるための現実的な安全弁として機能する
  - 根拠: `MaxDepth = [0,0,0,0,0,0,0,0,0,0]`（10 レベル）で打ち切り、未到達型はシリアライズ可能と仮定する（`packages/agents/src/serializable.ts:38-42`）

- `[AVOID]` アクセス制御を個々のビジネスロジックメソッド内に分散させる。単一の制御ポイント（`setState` 内など）で集約することで、チェック漏れのリスクを排除できる
  - 根拠: readonly チェックを各 callable に書くと漏れの温床になるため、`setState()` に一箇所集約する設計が選択された（`design/readonly-connections.md:38-66`）

## 適用チェックリスト

- [ ] 双方向同期プロトコルで、送信元クライアントをブロードキャスト対象から除外しているか
- [ ] 状態変更フック（`onStateChanged` 相当）で `source` を確認し、自己トリガーの無限ループを防いでいるか
- [ ] RPC で公開するメソッドをホワイトリスト制御しているか（全 public メソッドが呼び出し可能になっていないか）
- [ ] RPC のパラメータ・戻り値の型が JSON ラウンドトリップ可能か（Date, Map, Set, Function を含んでいないか）
- [ ] 状態バリデーションが永続化・ブロードキャストの前に同期的に実行されているか
- [ ] Proxy stub を使う場合、`toJSON`, `then` 等の内部メソッドを RPC 呼び出しから除外しているか
- [ ] 再帰的な型チェックに深度制限を設けているか（深くネストした型での TypeScript エラーを回避）
- [ ] 状態オブジェクトに `Date` 等のラウンドトリップしない型を含めず、ISO 文字列等のシリアライズ可能な表現を使っているか
