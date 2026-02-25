# abstraction-patterns

> リポジトリ: cloudflare/partykit
> 分析日: 2026-02-25

## 概要

PartyKit（PartyServer）は Cloudflare Durable Objects の上に構築されたリアルタイムサーバーフレームワークであり、Server 基底クラスを中心に多層的な抽象化を展開している。注目すべきは、単一の基底クラスから Mixin（withYjs）、ファクトリ関数（createPubSubServer）、クラス継承（Scheduler, SyncServer）、インターフェースによる Strategy パターン（ConnectionManager）、プロパティの `configurable: true` による下流ライブラリへの拡張ポイント提供と、5 種類以上の抽象化パターンが目的別に使い分けられている点である。これらの設計判断は「どこを固定し、どこを開放するか」という拡張性設計の教科書的な実例を提供する。

## 背景にある原則

- **プラットフォーム境界の吸収**: Durable Objects の低レベル API（fetch, webSocketMessage, alarm 等）を Server クラスが吸収し、開発者には lifecycle hook（onConnect, onMessage, onClose 等）のみを公開する。プラットフォームの制約と開発者体験の間にアダプタ層を置くことで、下流のコードがプラットフォーム詳細から隔離される（`packages/partyserver/src/index.ts:380-469`）
- **抽象化手法の目的別選択**: 「何を拡張したいか」に応じて最適な抽象化メカニズムを選ぶ。振る舞いの追加には Mixin、状態管理戦略の切り替えには Strategy/インターフェース、生成物の構成には Factory を適用する。一つの手法に統一するのではなく、問題の性質に合わせて選択する
- **configurable: true による下流拡張契約**: Object.defineProperty のプロパティを `configurable: true` にすることで、下流ライブラリ（Agents SDK 等）がプロパティを再定義できる拡張ポイントを明示的に提供する。これは TypeScript の型レベルでは表現しにくい「ランタイム拡張契約」であり、ドキュメントとテストで担保する設計判断（`packages/partyserver/src/types.ts:37-49`）
- **Lazy Hydration による遅延コスト回避**: Hibernate 復帰時に全 WebSocket の状態を即座に復元するのではなく、アクセス時に初めてデシリアライズする。コストを実際の使用時に遅延させることで、大量の接続がある場合のウェイクアップ時間を最小化する（`packages/partyserver/src/connection.ts:118-198`）

## 実例と分析

### Server 基底クラス: プラットフォーム API の Template Method 化

Server クラスは DurableObject を継承し、Durable Objects の API エントリポイント（`fetch`, `webSocketMessage`, `webSocketClose`, `webSocketError`, `alarm`）を内部で処理した上で、開発者がオーバーライドすべき hook メソッド（`onStart`, `onConnect`, `onMessage`, `onClose`, `onError`, `onRequest`, `onAlarm`）に委譲する。

```typescript
// packages/partyserver/src/index.ts:380-449
async fetch(request: Request): Promise<Response> {
  try {
    // ... name hydration, initialization ...
    await this.#ensureInitialized();

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return await this.onRequest(request);
    } else {
      // WebSocket pair creation, connection tagging
      const tags = await this.getConnectionTags(connection, ctx);
      connection = this.#connectionManager.accept(connection, { tags });
      await this.onConnect(connection, ctx);
      return new Response(null, { status: 101, webSocket: clientWebSocket });
    }
  } catch (err) {
    // error handling with WebSocket-aware fallback
  }
}
```

各 hook はデフォルト実装（ログ出力 + 404 レスポンス）を持ち、ユーザーが必要な部分だけをオーバーライドする。初期化は `#ensureInitialized()` で `blockConcurrencyWhile` を使い、一度だけ実行されることを保証する。

### ConnectionManager: Strategy パターンによる接続管理

接続管理は `ConnectionManager` インターフェースで抽象化され、2 つの実装を持つ。

```typescript
// packages/partyserver/src/connection.ts:268-273
export interface ConnectionManager {
  getCount(): number;
  getConnection<TState>(id: string): Connection<TState> | undefined;
  getConnections<TState>(tag?: string): IterableIterator<Connection<TState>>;
  accept(connection: Connection, options: { tags: string[]; }): Connection;
}
```

`InMemoryConnectionManager` は Map ベースで接続を追跡し、`HibernatingConnectionManager` は Durable Objects の `getWebSockets()` API に委譲する。選択は `static options.hibernate` フラグに基づいて構築時に決定される。

```typescript
// packages/partyserver/src/index.ts:336-338
#connectionManager: ConnectionManager = this.#ParentClass.options.hibernate
  ? new HibernatingConnectionManager(this.ctx)
  : new InMemoryConnectionManager();
```

### withYjs Mixin: 横断的関心事の合成

`withYjs` は TypeScript の Mixin パターンで Server に Yjs CRDT サポートを追加する。クラス継承ではなく関数によるクラス合成を用いることで、「任意の Server サブクラスに Yjs を追加できる」柔軟性を実現する。

```typescript
// packages/y-partyserver/src/server/index.ts:167-170
type ServerClass = new(...args: any[]) => Server;

export function withYjs<TBase extends ServerClass>(
  Base: TBase,
): TBase & YjsStatic & (new(...args: any[]) => YjsInstance) {
  class YjsMixin extends Base {
    // onStart, onConnect, onMessage, onClose をオーバーライド
    // document, handleMessage 等の新しいメンバーを追加
  }
  return YjsMixin as unknown as TBase & YjsStatic & (new(...args: any[]) => YjsInstance);
}

// 使用側: 任意の Server サブクラスに適用可能
export const YServer = withYjs(Server);
```

Mixin 内部では `onStart` で Yjs ドキュメントのセットアップ、`onConnect` で Sync Step 1 の送信、`onMessage` でバイナリプロトコル処理、`onClose` で awareness の cleanup を行う。静的プロパティ `callbackOptions` も Mixin 側で定義され、デバウンス間隔の設定を可能にする。

### createPubSubServer: Factory パターンによるクラス+ルーター生成

`createPubSubServer` は、設定を受け取って PubSubServer クラスと対応するルーティング関数を同時に生成するファクトリ関数である。

```typescript
// packages/partysub/src/server/index.ts:26-36
export function createPubSubServer<Env extends Cloudflare.Env = Cloudflare.Env>(
  options: {
    binding: string;
    nodes?: number;
    locations?: Partial<Record<DurableObjectLocationHint, number>>;
    jurisdiction?: DurableObjectJurisdiction;
  },
): {
  PubSubServer: typeof Server<Env>;
  routePubSubRequest: (request: Request, env: Env) => Promise<Response | null>;
};
```

このパターンは「クラス定義とルーティングロジックが密結合している」場合に有効で、設定のクロージャキャプチャにより、地理分散ノードの ID 生成やリクエストのリライトロジックが内部に閉じ込められる。

### Scheduler / SyncServer: ドメイン特化の直接継承

特定ドメインに特化した Server 拡張は素直なクラス継承を使う。

```typescript
// packages/partywhen/src/index.ts:79-81
export class Scheduler<Env extends Cloudflare.Env = Cloudflare.Env> extends Server<Env> {
  // SQL テーブル作成、タスクスケジューリング、alarm 処理
}

// packages/partysync/src/server/index.ts:21-24
export class SyncServer<
  Env extends Cloudflare.Env = Cloudflare.Env,
  TChannels extends Channels = Channels,
> extends Server<Env> {
  // チャネルベースの同期、RPC ディスパッチ
}
```

Mixin ではなく継承を選んだ理由は、これらが「Server の機能を再合成する」のではなく「Server を特定ドメインに特殊化する」用途だからである。

### Connection 型: WebSocket のインターフェース拡張と Namespaced Attachment

`Connection` 型は `WebSocket & { id, state, setState, tags, ... }` として定義され、既存の WebSocket を直接拡張する。

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

Platform 内部データ（`__pk`）とユーザーデータ（`__user`）を名前空間で分離することで、同一ストレージ上での衝突を防ぐ。`isPartyServerWebSocket` は `__pk` の存在をチェックし、PartyServer が管理する WebSocket とユーザーが `state.acceptWebSocket()` で直接作成した WebSocket を区別する。

### ReconnectingWebSocket: Decorator パターンによる透過的拡張

`partysocket` の `ReconnectingWebSocket` は標準 WebSocket の API を維持しながら、自動再接続、メッセージキューイング、指数バックオフを追加する。

```typescript
// packages/partysocket/src/ws.ts:149
export default class ReconnectingWebSocket extends (EventTarget as TypedEventTarget<WebSocketEventMap>) {
  // WebSocket と同じプロパティ（readyState, bufferedAmount, etc.）を公開
  // send() はキューイング付き、close() は再接続停止
}
```

## パターンカタログ

- **Template Method** (分類: 振る舞い)
  - 解決する問題: プラットフォーム API のボイラープレートを隠蔽しつつ、ビジネスロジックの注入ポイントを提供する
  - 適用条件: フレームワーク内部の処理フローが固定で、一部のステップだけカスタマイズしたい場合
  - コード例: `packages/partyserver/src/index.ts:380-469`（fetch -> onRequest/onConnect）
  - 注意点: hook が多すぎるとフレームワークの理解コストが上がる。PartyKit は 7 つの hook に抑えている

- **Strategy** (分類: 振る舞い)
  - 解決する問題: 同じ機能（接続管理）の異なる実装を実行時に切り替える
  - 適用条件: 実装の選択がコンパイル時に決定でき、インターフェースが安定している場合
  - コード例: `packages/partyserver/src/connection.ts:268-273`（ConnectionManager インターフェース）
  - 注意点: `static options` で構築時に決定しているため、実行時の切り替えはない

- **Mixin** (分類: 構造)
  - 解決する問題: 多重継承なしに横断的関心事を既存クラスに合成する
  - 適用条件: 「任意のサブクラスに機能を追加したい」場合。単一の基底クラスへの追加では不十分な場合
  - コード例: `packages/y-partyserver/src/server/index.ts:167-548`（withYjs）
  - 注意点: TypeScript の型推論が複雑になる。戻り値型にキャストが必要

- **Factory Method** (分類: 生成)
  - 解決する問題: 設定に基づいてクラスと関連コンポーネントをまとめて生成する
  - 適用条件: クラス定義が設定に依存し、関連する付随コンポーネント（ルーター等）も同時に必要な場合
  - コード例: `packages/partysub/src/server/index.ts:26-207`（createPubSubServer）

- **Lazy Initialization / Virtual Proxy** (分類: 構造)
  - 解決する問題: 大量オブジェクトの初期化コストを遅延させる
  - 適用条件: オブジェクトの一部のプロパティしか使われない可能性がある場合
  - コード例: `packages/partyserver/src/connection.ts:118-198`（createLazyConnection）

## Good Patterns

- **Namespaced Attachment Storage**: WebSocket の attachment ストレージをプラットフォーム内部用（`__pk`）とユーザー用（`__user`）に名前空間で分離する。ユーザーが `setState` で任意のデータを保存しても内部メタデータと衝突しない。

```typescript
// packages/partyserver/src/connection.ts:31-37
type ConnectionAttachments = {
  __pk: { id: string; tags: string[]; };
  __user?: unknown;
};
```

- **configurable: true による拡張契約**: Object.defineProperty で定義したプロパティに `configurable: true` を設定し、下流ライブラリがプロパティを再定義できるようにする。テストコードで拡張シナリオを明示的に検証し、契約をコードで担保する。

```typescript
// packages/partyserver/src/connection.ts:150-157
state: {
  configurable: true,
  get() {
    return ws.deserializeAttachment() as ConnectionState<unknown>;
  }
},
setState: {
  configurable: true,
  value: function setState<T>(setState: T | ConnectionSetStateFn<T>) { ... }
}
```

```typescript
// packages/partyserver/src/tests/worker.ts:257-285 (テストでの契約検証)
export class ConfigurableState extends Server {
  onConnect(connection: Connection): void {
    let _customState: unknown = { custom: true };
    Object.defineProperty(connection, "state", {
      configurable: true,
      get() {
        return _customState;
      },
    });
    // ...
  }
}
```

- **isPartyServerWebSocket による防御的フィルタリング**: Hibernate 復帰時に `getWebSockets()` で返される全 WebSocket の中から、PartyServer が管理するものだけを `__pk` の存在チェックでフィルタリングする。外部で作成された WebSocket を安全に無視できる。

```typescript
// packages/partyserver/src/connection.ts:39-76
function tryGetPartyServerMeta(ws: WebSocket): ConnectionAttachments["__pk"] | null {
  try {
    const attachment = WebSocket.prototype.deserializeAttachment.call(ws) as unknown;
    if (!attachment || typeof attachment !== "object") return null;
    if (!("__pk" in attachment)) return null;
    // ...
  } catch {
    return null;
  }
}
```

- **blockConcurrencyWhile + エラー再スロー**: `#ensureInitialized()` で `blockConcurrencyWhile` を使いつつ、内部で発生したエラーを外部で再スローすることで、Durable Object の input gate が壊れることを防ぐ。

```typescript
// packages/partyserver/src/index.ts:547-563
async #ensureInitialized(): Promise<void> {
  if (this.#status === "started") return;
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
  if (error) throw error;
}
```

## Anti-Patterns / 注意点

- **Mixin の型キャストの複雑化**: withYjs の戻り値は `TBase & YjsStatic & (new (...args: any[]) => YjsInstance)` という複雑な交差型で、内部で `as unknown as` キャストを使っている。Mixin パターンを多段に重ねると型推論が破綻する。

```typescript
// Bad: Mixin を 3 段以上重ねると型が追跡不能に
const TripleMixin = withC(withB(withA(Server)));

// Better: 2 段以内に抑え、それ以上はクラス継承やコンポジションに切り替える
class MyServer extends withYjs(Server) {
  // 追加の機能はここでオーバーライド
}
```

- **static options による暗黙の振る舞い切り替え**: `Server` クラスは `static options.hibernate` で ConnectionManager の実装を切り替えるが、このフラグの影響範囲が広い（接続のライフサイクル全体に影響）にもかかわらず、型レベルでは区別されない。

```typescript
// Bad: hibernate フラグの影響が暗黙的
class MyServer extends Server {
  static options = { hibernate: true };
  // この設定により onMessage の connection 引数の state が
  // deserialization を経由するようになるが、型は同じ
}

// Better: フラグの影響を型やドキュメントで明示し、
// モード固有の注意点をエラーメッセージで伝える
```

## 導出ルール

- `[MUST]` プラットフォーム固有の API を直接公開せず、lifecycle hook パターン（Template Method）でラップして開発者に提供する
  - 根拠: PartyKit は DurableObject の fetch/webSocketMessage/alarm を Server が吸収し、onConnect/onMessage/onAlarm に変換することで、プラットフォームの制約（WebSocketPair の作成、blockConcurrencyWhile の管理等）を開発者から隠蔽している（`packages/partyserver/src/index.ts:380-469`）

- `[MUST]` 共有ストレージ（WebSocket attachment 等）に複数レイヤーがデータを保存する場合、名前空間プレフィックスで衝突を防ぐ
  - 根拠: ConnectionAttachments の `__pk`（プラットフォーム内部）と `__user`（ユーザーデータ）の分離により、setState で任意のデータを保存してもメタデータが破壊されない（`packages/partyserver/src/connection.ts:31-37`）

- `[SHOULD]` 下流ライブラリによるプロパティ再定義を許可する場合、`configurable: true` を設定し、テストコードで再定義シナリオを検証する
  - 根拠: Agents SDK が Connection の state/setState を再定義できるよう `configurable: true` を設定し、テスト（ConfigurableState, ConfigurableStateInMemory）で契約を検証している（`packages/partyserver/src/tests/worker.ts:252-343`）

- `[SHOULD]` 抽象化手法は問題の性質に応じて選択する: 横断的関心事の合成には Mixin、振る舞いの切り替えには Strategy/インターフェース、設定依存の生成には Factory、ドメイン特化には直接継承
  - 根拠: PartyKit では withYjs（Mixin）、ConnectionManager（Strategy）、createPubSubServer（Factory）、Scheduler/SyncServer（継承）と、目的ごとに最適な手法を使い分けている

- `[SHOULD]` Hibernate/スリープ復帰がある環境では、状態の復元をアクセス時まで遅延させる（Lazy Hydration）
  - 根拠: createLazyConnection は Object.defineProperty のゲッターで WebSocket attachment のデシリアライズを遅延し、実際にプロパティが参照されるまでコストを発生させない（`packages/partyserver/src/connection.ts:118-198`）

- `[SHOULD]` 初期化処理で排他制御を使う場合、排他ブロック内でエラーを捕捉し、ブロック外で再スローしてロック機構の破壊を防ぐ
  - 根拠: `#ensureInitialized()` は blockConcurrencyWhile 内のエラーを変数にキャプチャし、ブロック外で throw することで input gate の永続的なブロックを回避している（`packages/partyserver/src/index.ts:547-563`）

- `[AVOID]` Mixin を 3 段以上重ねて型推論を破綻させること。2 段を超える場合はクラス継承やコンポジションへの切り替えを検討する
  - 根拠: withYjs の戻り値型は `as unknown as` キャストを必要とし（`packages/y-partyserver/src/server/index.ts:545-547`）、これを多段に重ねると型安全性が実質的に失われる

## 適用チェックリスト

- [ ] プラットフォーム固有 API（AWS SDK, Cloudflare Workers API 等）を直接クラスに公開していないか? lifecycle hook パターンでラップできないか検討する
- [ ] 共有ストレージに複数レイヤーがデータを書き込む場合、名前空間プレフィックスで衝突を防いでいるか?
- [ ] Object.defineProperty で設定したプロパティのうち、下流で再定義される可能性があるものに `configurable: true` を付けているか?
- [ ] 拡張ポイント（configurable プロパティ、hook メソッド等）の契約をテストコードで検証しているか?
- [ ] 抽象化の手法（Mixin, Strategy, Factory, 継承）は問題の性質に合っているか? 「何を拡張可能にしたいか」で選択を見直す
- [ ] Hibernate やプロセス再起動後の状態復元にコストがかかる箇所で、Lazy Hydration を適用できないか?
- [ ] 排他制御（mutex, lock, blockConcurrencyWhile 等）内のエラーがロック機構を破壊しないよう、ブロック外で再スローしているか?
