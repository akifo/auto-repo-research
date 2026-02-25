# Observability

> リポジトリ: cloudflare/agents
> 分析日: 2026-02-25

## 概要

cloudflare/agents の観測性設計を分析する。このリポジトリでは Agent クラスとその MCP サブシステムに対して、統一的なイベント発行インターフェースを持つ観測性レイヤーが組み込まれている。注目に値するのは、(1) 単一メソッド `emit()` のみの Strategy パターンによる実装差し替え、(2) `Emitter` / `DisposableStore` による階層的イベント伝搬とリソース管理、(3) optional chaining（`?.emit()`）によるゼロコスト無効化の3点が一貫して適用されている点である。

## 背景にある原則

- **Strategy パターンによるインターフェース最小化**: 観測性の実装を `emit()` 1メソッドの `Observability` インターフェースに抽象化し、`override` で差し替え可能にしている。ロギング、メトリクス、外部送信の判断をフレームワーク側が行わず、利用者に委譲する設計。こうすることで SDK が特定のロギングライブラリやバックエンドに依存しない（`src/observability/index.ts:12-18`）。
- **階層的イベント伝搬（Event Bubbling）**: MCP クライアント接続 → MCP クライアントマネージャ → Agent という3層でイベントが伝搬する。各層は `Emitter` を持ち、下位層のイベントを `fire()` で上位に中継する。これにより利用者は Agent 1箇所で全イベントを受け取れる一方、内部ではレイヤーごとに独立したテストが可能（`src/mcp/client.ts:516-518`、`src/index.ts:852-856`）。
- **Disposable パターンによるリソースリーク防止**: イベントリスナーの登録は必ず `Disposable` を返し、`DisposableStore` で集約管理する。破棄時には `dispose()` で一括解除される。これにより Durable Object のライフサイクルに合わせた確実なクリーンアップが保証される（`src/core/events.ts:9-26`）。
- **ゼロコスト無効化**: `this.observability?.emit(...)` の optional chaining により、`observability = undefined` を設定するだけでイベント発行コードのオーバーヘッドがゼロになる。条件分岐やフラグ管理が不要（`docs/observability.md:38-44`）。

## 実例と分析

### 統一的なイベント構造: BaseEvent 型

すべての観測性イベントは `BaseEvent<T, Payload>` という共通の型で統一されている。`type` フィールドは discriminated union の判別子として機能し、利用者側でイベント種別に応じた型安全な処理分岐が可能。

```ts
// src/observability/base.ts:4-26
export type BaseEvent<
  T extends string,
  Payload extends Record<string, unknown> = {},
> = {
  type: T;
  id: string;
  displayMessage: string;
  payload: Payload & Record<string, unknown>;
  timestamp: number;
};
```

`displayMessage` フィールドは人間可読なログ出力用、`payload` は構造化データ用と役割が分離されている。デフォルトの `genericObservability` は `isLocalMode()` に応じて `displayMessage` のみか全体をログ出力する（`src/observability/index.ts:24-33`）。

### ドメイン分割: Agent イベントと MCP イベント

イベント型は Agent ライフサイクル（`AgentObservabilityEvent`）と MCP クライアント（`MCPObservabilityEvent`）の2ドメインに分かれ、union 型 `ObservabilityEvent` で統合される。

```ts
// src/observability/index.ts:8-10
export type ObservabilityEvent =
  | AgentObservabilityEvent
  | MCPObservabilityEvent;
```

Agent イベントは `state:update`, `rpc`, `connect`, `destroy`, `schedule:*`, `queue:retry`, `workflow:*` など広範なライフサイクルをカバーする。MCP イベントは `mcp:client:preconnect`, `mcp:client:connect`, `mcp:client:authorize`, `mcp:client:discover` の4種（`src/observability/agent.ts`, `src/observability/mcp.ts`）。

なお、`message:request`, `message:response`, `message:clear` は型定義には存在するが、コードベース内のどこからも emit されていない。将来の拡張ポイントとして予約されたスロットである。

### 階層的イベント伝搬のメカニズム

MCP サブシステムでは3層のイベント伝搬が実装されている。

**第1層: MCPClientConnection**（個別の MCP サーバー接続）

```ts
// src/mcp/client-connection.ts:121-123
private readonly _onObservabilityEvent = new Emitter<MCPObservabilityEvent>();
public readonly onObservabilityEvent: Event<MCPObservabilityEvent> =
  this._onObservabilityEvent.event;
```

接続・切断・ディスカバリの各フェーズで `this._onObservabilityEvent.fire(...)` を呼ぶ（`src/mcp/client-connection.ts:173-183`, `343-352`, `376-385`, `441-449`, `695-705`）。

**第2層: MCPClientManager**（複数接続を管理）

```ts
// src/mcp/client.ts:508-518
// Pipe connection-level observability events to the manager-level emitter
const store = new DisposableStore();
const existing = this._connectionDisposables.get(id);
if (existing) existing.dispose();
this._connectionDisposables.set(id, store);
store.add(
  this.mcpConnections[id].onObservabilityEvent((event) => {
    this._onObservabilityEvent.fire(event);
  }),
);
```

接続ごとの `DisposableStore` でリスナー登録を追跡し、接続が閉じられたときに確実に解除する。

**第3層: Agent**（最上位）

```ts
// src/index.ts:851-856
// Emit MCP observability events
this._disposables.add(
  this.mcp.onObservabilityEvent((event) => {
    this.observability?.emit(event);
  }),
);
```

Agent レベルで MCP マネージャのイベントを受け取り、ユーザー定義の `observability` 実装に委譲する。

### Emitter と Disposable の設計

`Emitter` クラスは VS Code のイベントシステムに着想を得た設計で、リスナーの隔離と確実な解除を実現する。

```ts
// src/core/events.ts:30-52
export class Emitter<T> implements Disposable {
  private _listeners: Set<(e: T) => void> = new Set();

  readonly event: Event<T> = (listener) => {
    this._listeners.add(listener);
    return toDisposable(() => this._listeners.delete(listener));
  };

  fire(data: T): void {
    for (const listener of [...this._listeners]) {
      try {
        listener(data);
      } catch (err) {
        console.error("Emitter listener error:", err);
      }
    }
  }

  dispose(): void {
    this._listeners.clear();
  }
}
```

重要な設計判断が2つある。(1) `fire()` でリスナーをスプレッドコピーしてから反復する（反復中にリスナーが追加・削除されても安全）。(2) リスナーの例外を `catch` して他のリスナーに波及させない（`src/core/events.ts:42-44`）。

`DisposableStore` は複数の `Disposable` をまとめて管理し、`dispose()` で逆順に一括解除する。`while + pop()` による LIFO 順の解除と、例外を握りつぶす best-effort クリーンアップが特徴（`src/core/events.ts:9-26`）。

### テストにおける観測性の無効化

テスト用 Agent はすべて `observability = undefined` を設定してイベント発行を無効化している。これにより `console.log` によるテスト出力の汚染を防ぎつつ、観測性イベント自体のテストは MCP レイヤーで `onObservabilityEvent` を直接購読して検証する。

```ts
// src/tests/agents/state.ts:11
export class TestStateAgent extends Agent<Record<string, unknown>, TestState> {
  observability = undefined;
  // ...
```

```ts
// src/tests/mcp/client-connection.test.ts:349-352
// Set up event listener before init
newConnection.onObservabilityEvent((event) => {
  observabilityEvents.push(event);
});
```

### ローカルモード検知による出力切り替え

`genericObservability` はリクエスト URL のホスト名が `localhost` かどうかを検知し、ローカル開発時には `displayMessage` のみを表示する。`isLocalMode()` は結果をキャッシュし、リクエストごとの URL パースを回避する（`src/observability/index.ts:36-50`）。

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: フレームワーク内部の観測性イベントの出力先・フォーマットを利用者が自由に選択できるようにする
  - 適用条件: イベントの発行箇所は多いが、消費方法は利用者ごとに異なる場合
  - コード例: `src/observability/index.ts:12-18`（`Observability` インターフェース）、`src/index.ts:700`（デフォルト実装の注入）
  - 注意点: メソッドが増えるとインターフェースの実装負担が上がるため、単一メソッドに抑えている

- **Observer パターン** (分類: 振る舞い)
  - 解決する問題: 内部状態の変化を外部に通知する際の疎結合を確保する
  - 適用条件: イベント発行者がリスナーの数や種類を知る必要がない場合
  - コード例: `src/core/events.ts:30-52`（`Emitter` クラス）
  - 注意点: リスナーの登録解除を忘れるとメモリリークになるため、`Disposable` パターンと組み合わせる

- **Composite パターン変形 — DisposableStore** (分類: 構造)
  - 解決する問題: 複数のリソース解除を統一的に管理する
  - 適用条件: リソース（イベントリスナー、タイマー等）のライフサイクルが親オブジェクトに紐づく場合
  - コード例: `src/core/events.ts:9-26`、`src/mcp/client.ts:130`（`_connectionDisposables`）
  - 注意点: `dispose()` は複数回呼ばれても安全であるべき（この実装は `pop()` で空にするため冪等）

## Good Patterns

- **単一メソッドインターフェース + optional chaining による無効化**: `Observability` インターフェースを `emit()` 1メソッドに限定し、`this.observability?.emit(...)` パターンで呼び出す。利用者は `undefined` を設定するだけで全観測性を無効化でき、条件分岐が不要。

```ts
// src/index.ts:700
observability?: Observability = genericObservability;

// src/index.ts:985-997（発行側）
this.observability?.emit(
  {
    displayMessage: `RPC streaming call to ${method}`,
    id: nanoid(),
    payload: { method, streaming: true },
    timestamp: Date.now(),
    type: "rpc"
  },
  this.ctx
);
```

- **DisposableStore によるリスナー管理の局所化**: MCP クライアントマネージャは接続ごとに `DisposableStore` を持ち、接続削除時に対応するストアを `dispose()` する。接続の追加・削除が頻繁に起きても、リスナーのリーク追跡が容易。

```ts
// src/mcp/client.ts:510-519
const store = new DisposableStore();
const existing = this._connectionDisposables.get(id);
if (existing) existing.dispose();
this._connectionDisposables.set(id, store);
store.add(
  this.mcpConnections[id].onObservabilityEvent((event) => {
    this._onObservabilityEvent.fire(event);
  }),
);
```

- **リスナー例外の隔離**: `Emitter.fire()` が各リスナーを `try-catch` で囲むことで、1つのリスナーの例外が他のリスナーの実行を妨げない。

```ts
// src/core/events.ts:38-47
fire(data: T): void {
  for (const listener of [...this._listeners]) {
    try {
      listener(data);
    } catch (err) {
      console.error("Emitter listener error:", err);
    }
  }
}
```

## Anti-Patterns / 注意点

- **イベント構築の定型コード散在**: Agent クラス内の20箇所以上で同じ構造の `{ displayMessage, id: nanoid(), payload, timestamp: Date.now(), type }` オブジェクトをインラインで構築している。フィールドの追加・変更時に全箇所を修正する必要があり、DRY 原則に反する。

Bad:

```ts
// src/index.ts の各所に同じパターンが20回以上繰り返される
this.observability?.emit(
  {
    displayMessage: `Schedule ${schedule.id} created`,
    id: nanoid(),
    payload: { callback: callback as string, id: id },
    timestamp: Date.now(),
    type: "schedule:create",
  },
  this.ctx,
);
```

Better:

```ts
// ヘルパー関数でイベント構築を一元化する
function createEvent<T extends string>(
  type: T,
  displayMessage: string,
  payload: Record<string, unknown>,
): BaseEvent<T> {
  return { type, displayMessage, id: nanoid(), payload, timestamp: Date.now() };
}

this.observability?.emit(
  createEvent("schedule:create", `Schedule ${id} created`, { callback, id }),
  this.ctx,
);
```

- **型定義と実装の乖離**: `message:request`, `message:response`, `message:clear` が `AgentObservabilityEvent` 型に定義されているが、どこからも emit されていない。型だけが先行し、実装が追いついていない状態は利用者を混乱させる。

## 導出ルール

- `[MUST]` 観測性インターフェースは単一メソッド（`emit` 等）に限定し、利用者がメソッドを1つ実装するだけで全イベントを捕捉できるようにする
  - 根拠: cloudflare/agents は `Observability` を `emit()` 1メソッドに限定し、discriminated union で型安全なイベント分岐を実現している（`src/observability/index.ts:12-18`）
- `[MUST]` イベントリスナーの登録は `Disposable` を返し、所有者のライフサイクルに紐づく `DisposableStore` で集約管理する
  - 根拠: MCP クライアントマネージャが接続ごとに `DisposableStore` を持ち、接続削除時に一括解除することでリスナーリークを防止している（`src/mcp/client.ts:510-519`, `1165-1169`）
- `[SHOULD]` 観測性レイヤーは optional chaining（`?.emit()`）または null チェックでゼロコスト無効化できる設計にする
  - 根拠: `this.observability?.emit(...)` により `undefined` 設定だけで全イベント発行を無効化でき、テスト環境での出力汚染を完全に排除している（`src/tests/agents/state.ts:11`）
- `[SHOULD]` 階層的なシステムでは、下位層のイベントを上位層に自動的にバブルアップさせ、最上位で一括購読できるようにする
  - 根拠: MCPClientConnection → MCPClientManager → Agent の3層でイベントを伝搬させ、利用者は Agent レベルの `observability` 1箇所で全イベントを受け取れる（`src/index.ts:851-856`）
- `[SHOULD]` イベント発行（`fire`）時は各リスナーを `try-catch` で囲み、1つの例外が他のリスナーの実行を妨げないようにする
  - 根拠: `Emitter.fire()` がリスナーごとに例外を隔離し、best-effort で全リスナーに通知する設計（`src/core/events.ts:40-45`）
- `[AVOID]` イベント型定義に emit 箇所のない「予約スロット」を追加すること。型と実装の乖離は利用者の混乱を招く
  - 根拠: `message:request`, `message:response`, `message:clear` が型に定義されているが実際には emit されておらず、利用者が購読しても何も受け取れない（`src/observability/agent.ts:16-17`）

## 適用チェックリスト

- [ ] 観測性インターフェースを1メソッドに限定し、discriminated union でイベント型を分岐させているか
- [ ] イベントリスナーの登録が `Disposable` を返し、親オブジェクトの `dispose()` で確実に解除されるか
- [ ] 観測性を `undefined` に設定するだけで全イベント発行を無効化できるか（テスト時のノイズ排除）
- [ ] 多層構造でイベントがバブルアップし、最上位で一括購読可能か
- [ ] `Emitter.fire()` 相当の処理でリスナー例外が他のリスナーに波及しないようになっているか
- [ ] イベント構築のボイラープレートがヘルパー関数で集約されているか（20箇所以上のインライン構築は保守リスク）
- [ ] 型定義に含まれるイベント種別がすべて実際に emit されているか（型と実装の同期確認）
