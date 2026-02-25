# architecture

> リポジトリ: cloudflare/partykit
> 分析日: 2026-02-25

## 概要

Durable Object ベースのリアルタイムプリミティブを「薄い基底クラス + ライフサイクルフック」で構成し、Server/Client を完全に分離した上で、mixin・継承・factory パターンで機能レイヤーを積み重ねるアーキテクチャを分析する。注目に値するのは、プラットフォーム固有の制約（Durable Object の Hibernation API、WebSocket Pair、Alarm）を抽象化しつつ、ユーザーが触れる API 面は「フックをオーバーライドするだけ」という極めて薄い設計に留めている点である。

## 背景にある原則

- **プラットフォーム制約を基底クラスで吸収し、ユーザーにはフックだけを露出させる**: Durable Object の `fetch`/`webSocketMessage`/`webSocketClose`/`alarm` はプラットフォームのエントリポイントであり、ユーザーが直接触ると初期化順序やエラーハンドリングのバグが生まれる。Server 基底クラスがこれらを封じ（private `#` で隠蔽）、`onConnect`/`onMessage`/`onClose` のみを公開することで、プラットフォーム知識なしでリアルタイムサーバーを書ける。根拠: `packages/partyserver/src/index.ts:380-469` で `fetch` が完全に内部実装であり、ユーザーは `onRequest` のみをオーバーライドする。

- **接続管理戦略を Strategy パターンで切り替える**: Hibernate モードと非 Hibernate モードで接続の追跡方法が根本的に異なる（プラットフォーム管理 vs インメモリ Map）。この違いを `ConnectionManager` インターフェースで抽象化し、`static options = { hibernate: true }` というワンフラグで切り替え可能にしている。根拠: `packages/partyserver/src/connection.ts:268-273` の `ConnectionManager` インターフェースと、`packages/partyserver/src/index.ts:336-338` での動的選択。

- **Server と Client を独立パッケージとして分離し、片方だけでも使える設計にする**: `partyserver` は Cloudflare Workers 専用だが `partysocket` はブラウザ・Node.js・React Native で動作する汎用 WebSocket クライアントである。依存関係が逆方向に流れないため、`partysocket` は任意の WebSocket サーバーに接続でき、`partyserver` は任意のクライアントを受け入れる。根拠: `packages/partysocket/package.json` の `peerDependencies` に `partyserver` が含まれていない。

- **拡張は継承・mixin・factory の階層で行い、基底クラスは改変しない**: `Server` を直接変更せず、`SyncServer extends Server`（継承）、`withYjs(Server)`（mixin）、`createPubSubServer()`（factory）の3手法で機能を積み重ねる。基底クラスの安定性を保ちつつ多様なユースケースに対応する開放閉鎖原則の実践。根拠: コードベース横断で `Server` クラス自体が変更されることなく、6つ以上の拡張パッケージが構築されている。

## 実例と分析

### 1. レイヤー構成: 基底 → 拡張 → アプリケーション

パッケージ間の依存関係は明確な3層構造を形成する。

**Layer 0 — プラットフォーム抽象化層**

- `partyserver`: `DurableObject` を extends した `Server` 基底クラス。ルーティング（`routePartykitRequest`）、接続管理（`ConnectionManager`）、ライフサイクルフック（`onStart`/`onConnect`/`onMessage`/`onClose`/`onError`/`onRequest`/`onAlarm`）を提供。
- `partysocket`: `EventTarget` を extends した `ReconnectingWebSocket`。指数バックオフ再接続、メッセージキュー、環境検出（Node/Browser/ReactNative）を内包。

**Layer 1 — ドメイン拡張層**

- `y-partyserver`: `withYjs(Server)` mixin で CRDT（Yjs）サポートを追加。`onLoad`/`onSave` フックで永続化を抽象化。
- `partysub`: `createPubSubServer()` factory で地理分散 pub/sub を生成。内部で `Server` を extends し、`onConnect`/`onMessage` をオーバーライド。
- `partysync`: `SyncServer extends Server` で SQL ベースの状態同期を実装。RPC メッセージプロトコルを内包。
- `partywhen`: `Scheduler extends Server` で DO Alarm + SQL ストレージによるタスクスケジューリング。
- `partyfn`: `RPCClient` クラスで WebSocket 上の request-response パターンを実装。`partysocket` の `WebSocket` に依存。

**Layer 2 — フレームワーク統合層**

- `hono-party`: `partyserverMiddleware()` で Hono の middleware チェーンに `routePartykitRequest` を統合。Hono Context を `onBeforeConnect`/`onBeforeRequest` に注入。
- `partytracks`: Cloudflare Realtime SFU の HTTP API をプロキシ。`Server` を extends せず独自のルーティング関数 `routePartyTracksRequest` を提供。

```
DurableObject (CF Platform)
  └─ Server (partyserver)         ← Layer 0
       ├─ withYjs(Server)          ← Layer 1 (mixin)
       ├─ SyncServer extends Server ← Layer 1 (inheritance)
       │    └─ Agent extends SyncServer ← Layer 1 (deeper inheritance)
       ├─ Scheduler extends Server  ← Layer 1 (inheritance)
       └─ PubSubServer extends Server ← Layer 1 (factory-generated class)

EventTarget (Web Standard)
  └─ ReconnectingWebSocket (partysocket) ← Layer 0
       └─ PartySocket extends RWS        ← Layer 0 (URL convention)
```

### 2. Server/Client 分離と URL 規約による接続

Server と Client はパッケージとして完全に分離されているが、URL パス規約 `/parties/{namespace}/{room}` で暗黙的に結合される。

```typescript
// packages/partyserver/src/index.ts:208-224
const prefix = options?.prefix || "parties";
// ...
const namespace = parts[prefixParts.length];
const name = parts[prefixParts.length + 1];
```

```typescript
// packages/partysocket/src/index.ts:106
const baseUrl = `${protocol}://${host}/${basePath || `${prefix || "parties"}/${name}/${room}`}${path}`;
```

サーバー側は env バインディングの camelCase 名を kebab-case に変換して namespace とマッチングし、クライアント側は `party` オプションから同じ kebab-case パスを生成する。この「型ではなく規約で結合する」設計により、サーバーとクライアントが独立してデプロイ・進化できる。

### 3. Hibernation 対応の Strategy パターン

`ConnectionManager` インターフェースの2実装が、hibernate フラグ1つで切り替わる。

```typescript
// packages/partyserver/src/index.ts:336-338
#connectionManager: ConnectionManager = this.#ParentClass.options.hibernate
  ? new HibernatingConnectionManager(this.ctx)
  : new InMemoryConnectionManager();
```

`InMemoryConnectionManager`（`connection.ts:278-333`）は `Map<string, Connection>` で接続を追跡し、`close`/`error` イベントで自動削除する。`HibernatingConnectionManager`（`connection.ts:338-385`）は `DurableObjectState.getWebSockets()` に委譲し、WebSocket attachment の `__pk` 名前空間でメタデータを永続化する。この分離により、ユーザーコードは `this.getConnections()` という同じ API で接続にアクセスでき、hibernate の有無を意識しない。

### 4. 遅延初期化とコンカレンシー制御

```typescript
// packages/partyserver/src/index.ts:547-564
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
  if (error) throw error;
}
```

`blockConcurrencyWhile` で初期化をアトミックにし、`#status` の3状態遷移（"zero" → "starting" → "started"）でべき等性を保証する。エラー時に `#status` を `"zero"` に戻すことで、次のリクエストが再試行可能になる。エラーを `blockConcurrencyWhile` の外で再 throw するのは、input gate を壊さないための意図的な設計。

### 5. WebSocket attachment の名前空間分離

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

Hibernate 時に WebSocket attachment（`serializeAttachment`/`deserializeAttachment`）に保存するデータを `__pk`（プラットフォーム）と `__user`（ユーザー）の名前空間に分離している。これにより、フレームワーク内部のメタデータとユーザーが `connection.setState()` で保存するデータが干渉しない。`y-partyserver` はさらに `AWARENESS_IDS_KEY = "__ypsAwarenessIds"` でユーザー名前空間内に自身のキーを追加する（`y-partyserver/src/server/index.ts:46`）。

## コード例

```typescript
// packages/partyserver/src/connection.ts:118-198
// Lazy Connection: Hibernate 復帰時に attachment を遅延復元する Proxy 的ラッパー
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
  return connection;
};
```

```typescript
// packages/y-partyserver/src/server/index.ts:167-170
// Mixin パターン: Server の機能を横断的に拡張する
export function withYjs<TBase extends ServerClass>(
  Base: TBase,
): TBase & YjsStatic & (new(...args: any[]) => YjsInstance) {
  class YjsMixin extends Base {
    // onStart, onConnect, onMessage, onClose をオーバーライド
  }
  return YjsMixin as unknown as TBase & YjsStatic & (new(...args: any[]) => YjsInstance);
}
```

```typescript
// packages/partysub/src/server/index.ts:26-36
// Factory パターン: 設定を閉じ込めた Server サブクラスを動的に生成する
export function createPubSubServer<Env extends Cloudflare.Env = Cloudflare.Env>(
  options: { binding: string; nodes?: number; /* ... */ },
): {
  PubSubServer: typeof Server<Env>;
  routePubSubRequest: (request: Request, env: Env) => Promise<Response | null>;
} {
  class PubSubServer extends Server<Env> {
    static options = { hibernate: true };
    // ...
  }
  return { PubSubServer, routePubSubRequest };
}
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: Hibernate/非 Hibernate で接続管理の実装が根本的に異なる
  - 適用条件: 同一インターフェースで動作が異なる実装を切り替える必要がある場面
  - コード例: `packages/partyserver/src/connection.ts:268-273`（`ConnectionManager` インターフェース）、`index.ts:336-338`（静的フラグでの選択）
  - 注意点: Strategy の選択が `static options` で決まるため、インスタンスごとの切り替えは不可

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: リクエスト処理の骨格（初期化チェック、WebSocket ペア生成、エラーハンドリング）を固定しつつ、各ステップをユーザーがカスタマイズしたい
  - 適用条件: アルゴリズムの骨格が固定で、特定ステップだけが可変な場面
  - コード例: `packages/partyserver/src/index.ts:380-469`（`fetch` が骨格、`onConnect`/`onRequest` が可変ステップ）
  - 注意点: `fetch` メソッド自体を override すると骨格が壊れる。`#` private で防止している

- **Mixin パターン** (分類: 構造)
  - 解決する問題: 単一継承の制約下で、直交する機能（Yjs CRDT）を任意のサブクラスに付加したい
  - 適用条件: 機能が直交的で、多重継承が必要だが言語がサポートしない場面
  - コード例: `packages/y-partyserver/src/server/index.ts:167-548`（`withYjs` 関数）
  - 注意点: TypeScript の型推論が複雑になる（`as unknown as` が必要、`index.ts:545`）

- **Factory パターン** (分類: 生成)
  - 解決する問題: 設定（ノード数、地理分散、バインディング名）をクラス定義時に閉じ込めたい
  - 適用条件: 同じ基底クラスから設定の異なるサブクラスを複数生成する場面
  - コード例: `packages/partysub/src/server/index.ts:26-207`（`createPubSubServer`）

## Good Patterns

- **Lazy Rehydration で Hibernate 復帰コストを最小化**: `createLazyConnection` は `Object.defineProperties` の getter で attachment のデシリアライズを遅延実行する。Hibernate 復帰時に全接続を一括デシリアライズするのではなく、実際にアクセスされた接続だけをデシリアライズする。加えて `AttachmentCache`（WeakMap ベース）で同一接続の二重デシリアライズを防ぐ。（`packages/partyserver/src/connection.ts:81-108, 118-198`）

- **onBeforeConnect/onBeforeRequest ミドルウェアフック**: ルーティング関数 `routePartykitRequest` は DO にリクエストを転送する前に `onBeforeConnect`/`onBeforeRequest` コールバックを呼ぶ。戻り値が `Response` ならそこで短絡し、`Request` なら変換してから転送する。認証・レート制限等の横断的関心事を DO の外で処理できる。（`packages/partyserver/src/index.ts:298-316`）

- **WebSocket エラー時の WebSocket レスポンス返却**: WebSocket upgrade リクエスト処理中にエラーが発生した場合、HTTP 500 ではなく WebSocket ペアを作成してエラーフレームを送信する。Chrome DevTools が WebSocket リクエストの HTTP エラーレスポンスボディを表示しないという実用上の問題を回避する設計。（`packages/partyserver/src/index.ts:456-465`）

- **環境検出による EventTarget clone 戦略の切り替え**: `partysocket` は Node.js / React Native / ブラウザで異なるイベントクローン方式を使い分ける。React Native は `process` が存在するが `process.versions.node` がないという特殊なケースも正しくハンドルしている。（`packages/partysocket/src/ws.ts:96-107`）

## Anti-Patterns / 注意点

- **基底クラスの protected メソッドを上位レイヤーで直接オーバーライドする際のフック衝突**: `y-partyserver` の `withYjs` mixin は `onStart`、`onConnect`、`onMessage`、`onClose` をすべてオーバーライドする。ユーザーがさらにサブクラスでこれらをオーバーライドすると、mixin の処理が失われる。`handleMessage` を別メソッドとして分離して対策しているが（`server/index.ts:422-491`）、`onStart` 等は `super.onStart()` を呼び忘れると壊れる。

```typescript
// Bad: mixin のフックを上書きして CRDT 同期が壊れる
class MyServer extends withYjs(Server) {
  onMessage(conn, msg) {
    // Yjs の handleMessage が呼ばれない
    this.broadcast(msg);
  }
}

// Better: handleMessage を明示的に呼ぶ
class MyServer extends withYjs(Server) {
  onMessage(conn, msg) {
    this.handleMessage(conn, msg); // Yjs の処理を維持
    // 追加のロジック
  }
}
```

- **URL 規約による暗黙結合の脆弱性**: Server と Client は URL パス規約 `/parties/{namespace}/{room}` で結合されている。namespace の camelCase → kebab-case 変換が双方で独立して実装されており（`partyserver/src/index.ts:76-90` と `partysub/src/server/index.ts:16-24`）、変換ロジックの不一致がルーティング障害を引き起こすリスクがある。

```typescript
// Bad: 変換ロジックが分散している
// partyserver の camelCaseToKebabCase は全大文字ケース対応
if (str === str.toUpperCase() && str !== str.toLowerCase()) {
  return str.toLowerCase().replace(/_/g, "-");
}

// partysub は簡易版（全大文字ケース未対応）
let kebabified = str.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

// Better: 共有ユーティリティとして単一の変換関数をエクスポートする
```

## 導出ルール

- `[MUST]` リアルタイムフレームワークでプラットフォームのエントリポイント（fetch/alarm 等）をユーザーに直接公開せず、ライフサイクルフックに変換して提供する
  - 根拠: `Server.fetch` は `#` private で隠蔽され、ユーザーは `onRequest`/`onConnect` のみオーバーライドする設計により、初期化順序やエラーハンドリングのバグを構造的に防止している（`index.ts:380-469`）

- `[MUST]` Hibernate/永続化を伴う接続管理では、フレームワーク内部メタデータとユーザーデータの名前空間を分離する
  - 根拠: WebSocket attachment の `__pk`/`__user` 分離により、フレームワーク更新時にユーザーデータが破壊されず、逆にユーザーが内部状態を上書きすることも防いでいる（`connection.ts:31-37`）

- `[SHOULD]` 同一インターフェースで動作が根本的に異なる実装を切り替える場合、Strategy パターンを使い、選択を宣言的な静的設定（`static options`）で行う
  - 根拠: `{ hibernate: true }` の1フラグで `ConnectionManager` の実装が切り替わり、ユーザーコードは `getConnections()` だけで済む（`index.ts:336-338`）

- `[SHOULD]` mixin でライフサイクルフックをオーバーライドする場合、ユーザーが安全に追加ロジックを挟めるよう処理の核心を別名のメソッドとして分離する
  - 根拠: `y-partyserver` は `onMessage` を内部で使いつつ `handleMessage` を公開メソッドとして分離し、ユーザーが `onMessage` 内で `this.handleMessage()` を呼ぶ設計を促している（`y-partyserver/src/server/index.ts:422-495`）

- `[SHOULD]` サーバーとクライアントをパッケージレベルで分離し、片方だけでも他のエコシステムで使える設計にする
  - 根拠: `partysocket` は `partyserver` に依存せず、任意の WebSocket サーバーに接続可能。逆に `partyserver` も任意のクライアントを受け入れる（`partysocket/package.json` に partyserver への依存なし）

- `[AVOID]` URL パス規約のような暗黙結合に必要な文字列変換ロジックを複数箇所に分散させる
  - 根拠: `camelCaseToKebabCase` が `partyserver` と `partysub` で独立実装されており、全大文字ケースの処理に差異がある（`index.ts:76-90` vs `partysub/src/server/index.ts:16-24`）

## 適用チェックリスト

- [ ] プラットフォーム固有のエントリポイントを基底クラスで封じ、ユーザーにはライフサイクルフックのみを公開しているか
- [ ] 永続化層のメタデータとユーザーデータが名前空間で分離されているか
- [ ] 動作モードの切り替え（hibernate/非 hibernate 等）が宣言的な設定で完結し、ユーザーコードに分岐が漏れていないか
- [ ] 拡張パッケージが基底クラスを改変せず、継承・mixin・factory のいずれかで構築されているか
- [ ] サーバーパッケージとクライアントパッケージが相互に依存せず、片方だけでも独立して動作するか
- [ ] mixin がオーバーライドするフックに対して、ユーザーが安全に処理を追加できるエスケープハッチ（別名メソッド等）が提供されているか
- [ ] 暗黙的な規約（URL パス、ヘッダー名等）で結合している箇所の変換ロジックが共有ユーティリティとして一箇所に集約されているか
