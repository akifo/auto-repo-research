# hook-and-lifecycle-patterns

> リポジトリ: cloudflare/partykit
> 分析日: 2026-02-25

## 概要

PartyServer の Server クラスが提供するライフサイクルフック（onStart / onConnect / onMessage / onClose / onError / onAlarm / onRequest）と Connection ライフサイクルの設計を分析する。このリポジトリは DurableObject の低レベル API（fetch / webSocketMessage / webSocketClose / webSocketError / alarm）を「意味のあるフック」に変換する抽象レイヤーを提供しており、フレームワーク設計における「プラットフォームプリミティブをドメインフックに昇華させる」手法の好例である。特に、hibernation（休眠）モードと非 hibernation モードで同一のフック API を維持しつつ、内部の接続管理戦略を切り替える Strategy パターンが注目に値する。

## 背景にある原則

- **初期化を排他制御で1回に限定すべき、なぜなら並行リクエストが初期化を複数回走らせると状態不整合が起きる**: `#ensureInitialized` は `blockConcurrencyWhile` で排他ロックを取り、`#status` の三状態遷移（zero → starting → started）により onStart を正確に1回だけ実行する。失敗時は zero にリセットしてリトライ可能にする設計が、永続的なデッドロックを防いでいる（`packages/partyserver/src/index.ts:547-563`）。

- **プラットフォームイベントをドメインフックに変換すべき、なぜなら利用者が関心を持つのは「何が起きたか」であって「どのイベントが発火したか」ではない**: DurableObject の `webSocketMessage` / `webSocketClose` / `webSocketError` は生の WebSocket イベントだが、Server クラスはこれを `onMessage(connection, message)` / `onClose(connection, code, reason, wasClean)` に変換し、Connection オブジェクトに id・tags・state を付与する。利用者はプラットフォーム固有のイベントモデルを知る必要がない。

- **フックは全てオプショナルにすべき、なぜなら利用者は必要なフックだけをオーバーライドすればよい**: 全フックにデフォルト実装（空 or ログ出力）が用意されており、サブクラスは関心のあるフックだけをオーバーライドすればよい。Chat のような最小実装は `onMessage` だけで完結する（`fixtures/chat/src/server.ts:8-11`）。

- **内部メカニズムの差異をフック API で隠蔽すべき、なぜなら利用者コードがインフラの変更に影響されない**: hibernate モードでは DurableObject の `state.acceptWebSocket()` + `state.getWebSockets()` で接続を管理し、非 hibernate モードでは in-memory Map で管理するが、利用者が触る `onConnect` / `onMessage` / `getConnections()` の API は同一。

## 実例と分析

### 三状態マシンによる初期化保証

Server クラスの `#status` フィールドは `"zero" | "starting" | "started"` の三状態を持つ。全てのエントリポイント（`fetch` / `webSocketMessage` / `webSocketClose` / `webSocketError` / `alarm`）が `#ensureInitialized` を呼び、`"started"` でなければ `blockConcurrencyWhile` 内で `onStart` を実行する。

重要なのはエラーハンドリングの設計で、`onStart` が失敗した場合に `#status` を `"zero"` にリセットし、エラーを `blockConcurrencyWhile` の外で再スローする。これにより DurableObject の input gate がブロックされず、後続リクエストがリトライできる。

```typescript
// packages/partyserver/src/index.ts:547-563
async #ensureInitialized(): Promise<void> {
  if (this.#status === "started") return;
  await this.#hydrateNameFromStorage();
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
  // Re-throw outside blockConcurrencyWhile so the DO's input gate
  // isn't permanently broken, allowing subsequent requests to retry.
  if (error) throw error;
}
```

テストではこの回復機構が明示的に検証されている（`packages/partyserver/src/tests/worker.ts:350-368`）。

### ConnectionManager による接続管理の Strategy パターン

接続管理は `ConnectionManager` インターフェースで抽象化され、`InMemoryConnectionManager` と `HibernatingConnectionManager` の2つの実装が存在する。選択は `static options` の `hibernate` フラグで決まる。

```typescript
// packages/partyserver/src/index.ts:336-338
#connectionManager: ConnectionManager = this.#ParentClass.options.hibernate
  ? new HibernatingConnectionManager(this.ctx)
  : new InMemoryConnectionManager();
```

非 hibernate モードでは `addEventListener` でイベントリスナーを直接バインドし、hibernate モードではプラットフォームの `webSocketMessage` / `webSocketClose` / `webSocketError` コールバック経由で `createLazyConnection` による遅延再水和を行う。

### Lazy Connection による遅延再水和

hibernate モードでは、DurableObject が休眠から復帰した際に WebSocket 接続の状態を再構築する必要がある。`createLazyConnection` は `Object.defineProperties` で `id` / `tags` / `state` / `setState` をゲッターとして定義し、アクセスされた時点で初めて `deserializeAttachment` を呼ぶ。

```typescript
// packages/partyserver/src/connection.ts:118-198
export const createLazyConnection = (
  ws: WebSocket | Connection,
): Connection => {
  if (isWrapped(ws)) {
    return ws;
  }
  // ...
  const connection = Object.defineProperties(ws, {
    id: {
      get() {
        return attachments.get(ws).__pk.id;
      },
    },
    tags: {
      get() {
        return attachments.get(ws).__pk.tags ?? [];
      },
    },
    // ...
  }) as Connection;
  // ...
  connections.add(connection);
  return connection;
};
```

WeakMap ベースの `AttachmentCache` が deserialization コストを軽減し、同一 WebSocket への複数回アクセスでも1回だけ deserialize する。

### onBeforeConnect / onBeforeRequest によるルーティング層ミドルウェア

Server 内部のフック（onConnect 等）とは別に、ルーティング層（`routePartykitRequest`）に `onBeforeConnect` / `onBeforeRequest` フックが存在する。これらは Request または Response を返すことで、リクエストの変形やアクセス拒否をサーバーインスタンスに到達する前に行える。

```typescript
// packages/partyserver/src/tests/worker.ts:477-488
onBeforeConnect: async (_request, { className, name }) => {
  if (className === "OnStartServer") {
    if (name === "is-error") {
      return new Response("Error", { status: 503 });
    } else if (name === "is-redirect") {
      return new Response("Redirect", {
        status: 302,
        headers: { Location: "https://example2.com" }
      });
    }
  }
},
```

hono-party パッケージはこのパターンをさらに拡張し、Hono の Context をフックの第3引数として渡すアダプタを提供している（`packages/hono-party/src/index.ts:72-90`）。

### Mixin による機能合成（withYjs）

`y-partyserver` は `withYjs` ミックスインで Server を拡張し、`onStart` / `onConnect` / `onMessage` / `onClose` の4つのフックをオーバーライドする。サブクラスは `super.onStart()` を呼ぶことでミックスインの初期化を維持しつつ、独自の初期化処理を追加できる。

```typescript
// packages/y-partyserver/src/tests/worker.ts:43-48
async onStart() {
  this.ctx.storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, content BLOB)"
  );
  return super.onStart();
}
```

ミックスインは `onLoad` / `onSave` / `isReadOnly` / `onCustomMessage` という追加フックを導入し、利用者にさらに細かい拡張ポイントを提供している。

### onAlarm による非同期スケジュール処理

DurableObject の Alarm API を `onAlarm` フックとして公開している。`alarm()` メソッドは `#ensureInitialized` を呼んでから `onAlarm` を実行するため、休眠からの復帰時でも初期化が保証される。

todo-sync の例では、onAlarm を使って24時間以上前に論理削除されたレコードを物理削除する遅延クリーンアップを実装している（`fixtures/todo-sync/src/server.ts:86-93`）。partywhen の `Scheduler` はさらに進んで、cron/delayed/scheduled の各タスク種別をサポートするジョブスケジューラーを `alarm()` 上に構築している。

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: hibernate / 非 hibernate で接続管理メカニズムが異なるが、利用者 API は統一したい
  - 適用条件: 同一インターフェースで複数の内部実装を切り替える必要がある場合
  - コード例: `packages/partyserver/src/connection.ts:268-273`（ConnectionManager インターフェース）, `packages/partyserver/src/index.ts:336-338`（選択ロジック）
  - 注意点: 設定は `static options` でクラスレベルで固定されるため、インスタンスごとの切り替えはできない

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: ライフサイクルの全体フロー（初期化 → 接続受付 → メッセージ処理 → 切断）は固定しつつ、各ステップの振る舞いをサブクラスに委ねたい
  - 適用条件: フレームワーク的な基底クラスを設計する場合
  - コード例: `packages/partyserver/src/index.ts:380-469`（fetch メソッドが全体フローを定義し、onConnect / onRequest をサブクラスに委譲）
  - 注意点: `fetch` / `alarm` / `webSocketMessage` 等の DO コールバックはオーバーライド禁止（TODO コメントで明記: `index.ts:371-374`）

- **Mixin パターン** (分類: 構造)
  - 解決する問題: 単一継承の制約下で、直交する機能（Yjs同期、PubSub等）を組み合わせたい
  - 適用条件: 基底クラスを変えずに機能を追加したい場合
  - コード例: `packages/y-partyserver/src/server/index.ts:167-169`（`withYjs(Base)` 関数）
  - 注意点: ミックスインが onStart 等をオーバーライドするため、サブクラスは `super.onStart()` を呼ぶ責任がある

## Good Patterns

- **フック失敗時の状態リセットパターン**: onStart が失敗した場合、状態を初期値（"zero"）にリセットして後続リクエストでのリトライを可能にする。プラットフォームの排他制御（blockConcurrencyWhile）の外でエラーを再スローすることで、input gate のデッドロックを防ぐ。

```typescript
// packages/partyserver/src/index.ts:547-563
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
```

- **フック結果による制御フロー分岐パターン**: `onBeforeConnect` / `onBeforeRequest` は `Response | Request | void` を返し、Response ならそれを直接返却（短絡）、Request ならリクエスト変形、void なら続行する。単一のフック型で認証拒否・リクエスト変形・パススルーの3パターンを表現する。

```typescript
// packages/partyserver/src/index.ts:298-306
if (options?.onBeforeConnect) {
  const reqOrRes = await options.onBeforeConnect(req, lobby);
  if (reqOrRes instanceof Request) {
    req = reqOrRes;
  } else if (reqOrRes instanceof Response) {
    return reqOrRes;
  }
}
```

- **WeakMap によるメタデータ名前空間分離パターン**: Connection の内部状態（`__pk`）とユーザー状態（`__user`）を `ConnectionAttachments` 型で名前空間分離し、`configurable: true` で state / setState を再定義可能にすることで、下流の SDK（Agents SDK 等）がストレージを独自にラップできる。

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

## Anti-Patterns / 注意点

- **プラットフォームコールバックの直接オーバーライド**: Server クラスの `fetch` / `webSocketMessage` / `alarm` 等の DO コールバックをサブクラスでオーバーライドすると、`#ensureInitialized` が呼ばれず初期化保証が壊れる。現在は TODO コメントでのみ警告されている。

```typescript
// Bad: DO コールバックを直接オーバーライド
class MyServer extends Server {
  async fetch(request: Request) {
    // #ensureInitialized が呼ばれない！
    return new Response("hello");
  }
}

// Better: 提供されたフックを使う
class MyServer extends Server {
  onRequest(request: Request) {
    return new Response("hello");
  }
}
```

- **super.onStart() の呼び忘れ**: ミックスイン（withYjs 等）が onStart をオーバーライドしているため、そのサブクラスで onStart を再オーバーライドする際に `super.onStart()` を呼ばないとミックスインの初期化が実行されない。

```typescript
// Bad: ミックスインの初期化をスキップ
class MyYServer extends YServer {
  async onStart() {
    // super.onStart() を呼んでいない → Yjs ドキュメント初期化が走らない
    await this.setupDB();
  }
}

// Better: super を呼んでチェーンを維持
class MyYServer extends YServer {
  async onStart() {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS ...");
    return super.onStart(); // Yjs の初期化チェーンを維持
  }
}
```

- **hibernate モードでの in-memory 状態依存**: hibernate モードでは DO が休眠・復帰するため、インスタンス変数はリセットされる。接続に紐づく状態は `connection.setState()` で永続化し、サーバー全体の状態は `ctx.storage` で永続化する必要がある。y-partyserver は awareness ID を `connection.setState` に保存することでこれを解決している。

```typescript
// Bad: hibernate モードで in-memory に状態を持つ
class MyServer extends Server {
  static options = { hibernate: true };
  users = new Map<string, string>(); // 休眠復帰で消える

  onConnect(conn: Connection) {
    this.users.set(conn.id, "active");
  }
}

// Better: connection state または storage に永続化
class MyServer extends Server {
  static options = { hibernate: true };

  onConnect(conn: Connection, ctx: ConnectionContext) {
    conn.setState({ status: "active" });
  }
}
```

## 導出ルール

- `[MUST]` ライフサイクル初期化フックで排他制御を行い、失敗時は状態をリセットしてリトライ可能にする
  - 根拠: PartyServer の `#ensureInitialized` は `blockConcurrencyWhile` + 状態リセットで、並行リクエストでの重複初期化と失敗時のデッドロックを両方防いでいる（`index.ts:547-563`）

- `[MUST]` フレームワークの内部コールバック（初期化保証を含むもの）と利用者向けフックを明確に分離し、利用者は内部コールバックをオーバーライドしない制約を設ける
  - 根拠: Server の `fetch` / `webSocketMessage` / `alarm` は `#ensureInitialized` を呼ぶ内部メソッドであり、利用者が触るのは `onRequest` / `onMessage` / `onAlarm` のみ（`index.ts:371-374` の TODO コメント）

- `[SHOULD]` 利用者向けフックには全てデフォルト実装（no-op またはログ出力）を提供し、必要なフックだけのオーバーライドで動作するようにする
  - 根拠: Chat 実装は `onMessage` だけで完結し、他の全フックはデフォルト実装が使われる（`fixtures/chat/src/server.ts`）

- `[SHOULD]` ミドルウェアフックの戻り値で制御フローを表現する（Response 返却で短絡、Request 返却で変形、void で続行）
  - 根拠: `onBeforeConnect` / `onBeforeRequest` は `Response | Request | void` の3パターンで認証・変形・パススルーを単一フックで表現している（`index.ts:298-316`）

- `[SHOULD]` 同一 API で異なる内部実装を切り替える場合は Strategy パターンでインターフェースを抽象化し、設定値で実装を選択する
  - 根拠: `ConnectionManager` インターフェースが `InMemoryConnectionManager` と `HibernatingConnectionManager` を統一し、`static options.hibernate` で切り替える（`connection.ts:268-273`）

- `[SHOULD]` 休眠・復帰がある環境では、接続に紐づく状態を in-memory ではなく永続化レイヤー（attachment / storage）に保存する
  - 根拠: y-partyserver は awareness ID を `connection.setState()` で永続化し、in-memory Map の代わりに hibernation を生き延びる設計にしている（`y-partyserver/src/server/index.ts:45-69`）

- `[AVOID]` フレームワークのミックスインが提供するフックをオーバーライドする際に super 呼び出しを省略すること
  - 根拠: `YPersistent` は `super.onStart()` を呼んで Yjs ドキュメントの初期化チェーンを維持している（`y-partyserver/src/tests/worker.ts:43-48`）

## 適用チェックリスト

- [ ] サーバー/アクターの初期化処理に排他制御があるか？並行リクエストで初期化が複数回走らないか？
- [ ] 初期化が失敗した場合、状態がリセットされ後続リクエストでリトライ可能か？排他ロック内でエラーを投げてデッドロックしていないか？
- [ ] プラットフォーム固有のイベント（WebSocket event, HTTP handler 等）と利用者向けフックが分離されているか？
- [ ] 全てのフックにデフォルト実装があり、利用者は必要なフックだけオーバーライドすれば動作するか？
- [ ] ミドルウェアフックの戻り値型で制御フロー（短絡 / 変形 / 続行）を表現しているか？
- [ ] 休眠・再起動がある環境で、in-memory 状態を使っていないか？永続化レイヤーに保存しているか？
- [ ] ミックスインやデコレータを使う場合、super 呼び出しのチェーンが途切れていないか？
- [ ] フレームワーク内部のコールバック（初期化保証を含むもの）を利用者が誤ってオーバーライドしない仕組み（private / final / ランタイムチェック等）があるか？
