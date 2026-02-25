# Pattern: Disposable Event Hierarchy

> 出典: [repos/cloudflare/agents/observability.md](../repos/cloudflare/agents/observability.md)
> カテゴリ: pattern

## 概要

`emit()` 単一メソッドの Strategy パターンで観測性インターフェースを最小化し、DisposableStore でリスナー登録を一括解除可能にする階層的イベント伝搬パターン。MCPClientConnection -> MCPClientManager -> Agent の3層バブルアップにより、最上位で全イベントを一括購読できる。optional chaining によるゼロコスト無効化も組み合わせることで、テスト時のノイズ排除や本番の条件分岐削減を実現する。

## 背景・文脈

cloudflare/agents は Cloudflare Workers 上で動作する AI エージェントフレームワークである。Agent クラスは MCP (Model Context Protocol) クライアントを内包し、複数の MCP サーバーへの接続を管理する。このような多層構造では、下位層（個別接続）で発生するイベントを上位層（Agent）で集約して監視したいという要求が自然に生まれる。

一方で、フレームワークとして観測性の実装詳細（ログライブラリ、メトリクスバックエンド等）に依存するわけにはいかない。利用者がイベントの消費方法を自由に決められる設計が必要である。

この2つの要求 -- 「階層的な集約」と「消費方法の自由」 -- を同時に満たすのが、本パターンの組み合わせである。

## 実装パターン

### 1. Disposable と DisposableStore -- リソースリーク防止の基盤

すべてのリスナー登録は `Disposable` を返す。複数の Disposable を `DisposableStore` で集約し、親オブジェクトの破棄時に一括解除する。

```ts
// packages/agents/src/core/events.ts:1-26
export interface Disposable {
  dispose(): void;
}

export function toDisposable(fn: () => void): Disposable {
  return { dispose: fn };
}

export class DisposableStore implements Disposable {
  private disposables: Disposable[] = [];

  add<T extends Disposable>(disposable: T): T {
    this.disposables.push(disposable);
    return disposable;
  }

  dispose(): void {
    while (this.disposables.length > 0) {
      const d = this.disposables.pop();
      try {
        d?.dispose();
      } catch {
        // best-effort cleanup
      }
    }
  }
}
```

`pop()` による LIFO 順の解除で、後から登録されたリソースが先に解放される。例外を握りつぶす best-effort 方式により、1つの解除失敗が他のリソースの解除を妨げない。

### 2. Emitter -- 型安全なイベント発行

VS Code のイベントシステムに着想を得た `Emitter` クラス。リスナーの登録・発行・解除を一元管理する。

```ts
// packages/agents/src/core/events.ts:30-52
export type Event<T> = (listener: (e: T) => void) => Disposable;

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

設計上の2つの要点:

- `fire()` でリスナーをスプレッドコピーしてから反復する（反復中のリスナー追加・削除に安全）
- 各リスナーを `try-catch` で囲み、1つの例外が他のリスナーの実行を妨げない

### 3. 単一メソッドの観測性インターフェース

```ts
// packages/agents/src/observability/index.ts:12-18
export interface Observability {
  emit(event: ObservabilityEvent, ctx: DurableObjectState): void;
}
```

`emit()` 1メソッドのみ。イベント種別の分岐は discriminated union の `type` フィールドで行う。

```ts
// packages/agents/src/observability/base.ts:4-12
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

### 4. 3層イベントバブルアップ

```
MCPClientConnection (Layer 1)
  |  _onObservabilityEvent.fire(event)
  v
MCPClientManager (Layer 2)
  |  _onObservabilityEvent.fire(event)  -- DisposableStore で管理
  v
Agent (Layer 3)
  |  observability?.emit(event)  -- ユーザー定義の実装に委譲
  v
利用者のハンドラ
```

**Layer 1: MCPClientConnection** -- 個別の MCP サーバー接続がイベントを発行する。

```ts
// packages/agents/src/mcp/client-connection.ts:121-123
private readonly _onObservabilityEvent = new Emitter<MCPObservabilityEvent>();
public readonly onObservabilityEvent: Event<MCPObservabilityEvent> =
  this._onObservabilityEvent.event;
```

**Layer 2: MCPClientManager** -- 接続ごとに DisposableStore を持ち、接続のイベントを上位に中継する。

```ts
// packages/agents/src/mcp/client.ts:508-518
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

**Layer 3: Agent** -- MCP マネージャのイベントをユーザー定義の observability に委譲する。

```ts
// packages/agents/src/index.ts:851-856
this._disposables.add(
  this.mcp.onObservabilityEvent((event) => {
    this.observability?.emit(event);
  }),
);
```

## Good Example

**optional chaining によるゼロコスト無効化**

`observability` プロパティを optional にし、`?.emit()` で呼び出す。`undefined` を設定するだけで全イベント発行が無効化される。条件分岐やフラグ管理が不要。

```ts
// packages/agents/src/index.ts:700
observability?: Observability = genericObservability;

// packages/agents/src/index.ts:985-997（発行側 -- 20箇所以上で同じパターン）
this.observability?.emit(
  {
    displayMessage: `RPC streaming call to ${method}`,
    id: nanoid(),
    payload: { method, streaming: true },
    timestamp: Date.now(),
    type: "rpc",
  },
  this.ctx,
);
```

**DisposableStore による接続単位のリスナー管理**

接続の追加・削除が頻繁に起きる環境で、接続ごとの DisposableStore がリスナーリークを確実に防ぐ。

```ts
// packages/agents/src/mcp/client.ts:510-519
const store = new DisposableStore();
const existing = this._connectionDisposables.get(id);
if (existing) existing.dispose(); // 既存の接続があれば先に解除
this._connectionDisposables.set(id, store);
store.add(
  this.mcpConnections[id].onObservabilityEvent((event) => {
    this._onObservabilityEvent.fire(event);
  }),
);
```

**テスト環境での無効化**

テスト用 Agent では `observability = undefined` を設定し、`console.log` によるテスト出力の汚染を防ぐ。イベント自体のテストは MCP レイヤーで `onObservabilityEvent` を直接購読して検証する。

```ts
// packages/agents/src/tests/agents/state.ts:11
export class TestStateAgent extends Agent<Record<string, unknown>, TestState> {
  observability = undefined;
  // ...
}

// packages/agents/src/tests/mcp/client-connection.test.ts:349-352
newConnection.onObservabilityEvent((event) => {
  observabilityEvents.push(event);
});
```

## Bad Example

**イベント構築のボイラープレート散在**

Agent クラス内の20箇所以上で同一構造のイベントオブジェクトをインラインで構築している。フィールド追加時に全箇所を修正する必要がある。

```ts
// Bad: 同じパターンが20回以上繰り返される
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

ヘルパー関数でイベント構築を一元化すべき。

```ts
// Better: ファクトリ関数で共通フィールドを集約
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

## 適用ガイド

### どのような状況で使うべきか

- **多層構造のシステム**で、下位コンポーネントのイベントを上位で集約して監視したい場合
- **フレームワーク/SDK 開発**で、イベントの消費方法を利用者に委ねたい場合（ログ出力先、メトリクスバックエンドの選択）
- **動的なリソース管理**が必要な場合（接続の追加・削除が頻繁に起きる環境）
- **テスト時のノイズ排除**を簡潔に実現したい場合

### 導入時の注意点

- `Emitter.fire()` はリスナーを同期的に呼び出す。リスナー内で重い処理を行うとイベント発行のレイテンシに影響する。非同期処理が必要な場合は `queueMicrotask()` 等でリスナー側がデタッチすること
- `DisposableStore.dispose()` は例外を握りつぶす best-effort 方式。クリーンアップの失敗を検知したい場合は、個別に `dispose()` を呼んでエラーハンドリングする
- イベント型定義に emit 箇所のない「予約スロット」を追加しない。型と実装の乖離は利用者の混乱を招く

### カスタマイズポイント

- **イベント型の拡張**: `BaseEvent<T, Payload>` の型パラメータで discriminated union を拡張し、ドメイン固有のイベントを追加できる
- **デフォルト実装の差し替え**: `observability` プロパティを `override` することで、ロギングライブラリやメトリクスバックエンドを自由に選択できる
- **バブルアップ層の追加**: 新しい中間レイヤーが増えても、`Emitter` + `DisposableStore` の組み合わせで同じパターンを適用可能

## 参考

- [repos/cloudflare/agents/observability.md](../repos/cloudflare/agents/observability.md) -- 元の分析
