# design-philosophy

> リポジトリ: cloudflare/partykit
> 分析日: 2026-02-25

## 概要

PartyKit (PartyServer) は Cloudflare Durable Objects の上に「リアルタイムアプリを簡単に作れる」抽象層を構築するプロジェクトである。設計思想の核心は「プラットフォームの複雑さを隠蔽し、開発者がビジネスロジックだけを書けばよい状態を作る」こと。Durable Objects の WebSocket Hibernation API、名前空間管理、接続ライフサイクルといった低レベル概念を、ライフサイクルフック・静的オプション・規約ベースルーティングという3つの抽象化手法で包み込んでいる。Erlang/OTP の GenServer を明確にインスピレーション源として挙げつつ、JavaScript/TypeScript の文化に合わせた DX を実現している点が注目に値する。

## 背景にある原則

- **プラットフォーム API を「フック可能な空スロット」に変換すべき。なぜなら、利用者は「何を実装するか」だけに集中でき、「いつ・どう呼ばれるか」を知る必要がなくなる**: Server クラスは `onConnect`/`onMessage`/`onClose`/`onError`/`onRequest`/`onAlarm`/`onStart` というフックを空メソッドとして定義しており、利用者はオーバーライドするだけでよい。内部では `fetch()`/`webSocketMessage()`/`webSocketClose()` 等の Durable Object メソッドが自動的にフックをディスパッチする (`packages/partyserver/src/index.ts:380-468`)。利用者がこれらの低レベルメソッドを直接触る必要はない。

- **設定は「宣言的な静的プロパティ」で表現すべき。なぜなら、設定と振る舞いが分離され、サブクラスごとの差異がひと目でわかる**: `static options = { hibernate: true }` というワンライナーで Hibernation モードが切り替わる。内部では `this.#ParentClass.options.hibernate` を参照して `HibernatingConnectionManager` か `InMemoryConnectionManager` を選択する (`packages/partyserver/src/index.ts:336-338`)。コンストラクタ引数やメソッド呼び出しではなく静的プロパティにすることで、クラス定義を見るだけで動作モードがわかる。

- **規約ベースの自動検出で設定ファイルを不要にすべき。なぜなら、「動くまでの最短パス」が DX の最大の差別化要因になる**: `routePartykitRequest` は env オブジェクトを走査し、`idFromName` メソッドを持つプロパティを自動的に DurableObjectNamespace として検出する。バインディング名の CamelCase→kebab-case 変換も自動で行い、URL パスとのマッピングを規約で解決する (`packages/partyserver/src/index.ts:184-201`)。

- **拡張は継承よりミックスインで行うべき。なぜなら、機能の組み合わせが自由になり、ダイヤモンド継承問題を回避できる**: Yjs サポートは `withYjs(Server)` というミックスイン関数で提供される (`packages/y-partyserver/src/server/index.ts:167-548`)。これにより `withYjs(MyCustomServer)` のように任意の Server サブクラスに機能を合成できる。変更履歴にも「Extract Yjs functionality into a `withYjs` mixin」と明記されている。

## 実例と分析

### ライフサイクルフックによる制御の反転

Server クラスの `fetch()` メソッドは、WebSocket アップグレード判定、接続 ID 生成、WebSocketPair の作成、タグ付け、接続の accept、そして `onConnect` の呼び出しまでを内部で完結させる。利用者コードは `onConnect(connection, ctx)` の中身だけを書けばよい。

```typescript
// packages/partyserver/src/index.ts:407-448
if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
  return await this.onRequest(request);
} else {
  const { 0: clientWebSocket, 1: serverWebSocket } = new WebSocketPair();
  let connectionId = url.searchParams.get("_pk");
  if (!connectionId) {
    connectionId = nanoid();
  }
  // ... Connection オブジェクトの構築 ...
  connection = this.#connectionManager.accept(connection, { tags });
  if (!this.#ParentClass.options.hibernate) {
    this.#attachSocketEventHandlers(connection);
  }
  await this.onConnect(connection, ctx);
  return new Response(null, { status: 101, webSocket: clientWebSocket });
}
```

デフォルト実装は「何もしない」か「ログを出す」だけで、利用者に実装を促すメッセージを出力する設計:

```typescript
// packages/partyserver/src/index.ts:706-713
onMessage(connection: Connection, message: WSMessage): void | Promise<void> {
  console.log(
    `Received message on connection ${this.#ParentClass.name}:${connection.id}`
  );
  console.info(
    `Implement onMessage on ${this.#ParentClass.name} to handle this message.`
  );
}
```

### 規約ベースの名前空間自動検出

`routePartykitRequest` は env オブジェクトのプロパティを反復し、Duck Typing (`idFromName` メソッドの有無) で DurableObjectNamespace を判別する:

```typescript
// packages/partyserver/src/index.ts:184-201
if (!serverMapCache.has(env)) {
  const namespaceMap: Record<string, DurableObjectNamespace> = {};
  const bindingNames: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (
      v
      && typeof v === "object"
      && "idFromName" in v
      && typeof v.idFromName === "function"
    ) {
      const kebab = camelCaseToKebabCase(k);
      namespaceMap[kebab] = v as DurableObjectNamespace;
      bindingNames[kebab] = k;
    }
  }
  serverMapCache.set(env, namespaceMap);
  bindingNameCache.set(env, bindingNames);
}
```

WeakMap によるキャッシュで、同一 env オブジェクトに対する再走査を防いでいる。

### ミックスインパターンによる機能合成

`withYjs` はジェネリクスを使った TypeScript ミックスインとして実装されている:

```typescript
// packages/y-partyserver/src/server/index.ts:167-170
type ServerClass = new (...args: any[]) => Server;

export function withYjs<TBase extends ServerClass>(
  Base: TBase
): TBase & YjsStatic & (new (...args: any[]) => YjsInstance) {
  class YjsMixin extends Base {
    // Yjs 固有のライフサイクル実装
  }
  return YjsMixin as unknown as TBase & YjsStatic & ...;
}

// 利用側
export const YServer = withYjs(Server);
```

### 透過的な Hibernation 抽象化

Hibernation モードの有無でコネクション管理の実装が切り替わるが、利用者コードは一切変更不要。Strategy パターンで `ConnectionManager` インターフェースを抽象化:

```typescript
// packages/partyserver/src/connection.ts:268-273
export interface ConnectionManager {
  getCount(): number;
  getConnection<TState>(id: string): Connection<TState> | undefined;
  getConnections<TState>(tag?: string): IterableIterator<Connection<TState>>;
  accept(connection: Connection, options: { tags: string[]; }): Connection;
}
```

Hibernation 時は platform API (`state.getWebSockets()`) を使い、非 Hibernation 時は `Map<string, Connection>` で in-memory 管理する。遅延評価の `createLazyConnection` で Hibernation 復帰時の attachment デシリアライズコストを必要時まで先送りする。

### configurable プロパティによる下流拡張ポイント

Connection の `state`/`setState`/`serializeAttachment`/`deserializeAttachment` は `configurable: true` で定義されており、Cloudflare Agents SDK のような下流プロジェクトが `Object.defineProperty` で再定義できる:

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

### 一貫した命名体系

すべてのパッケージが `party*` プレフィックスで統一: partyserver, partysocket, partysub, partysync, partywhen, partyfn, partytracks, partyagent, partybase, partysession, partysmart, partyhard, partyflow。これは npm のスコープを使わず、検索性とブランド認知を確保する戦略である。

## パターンカタログ

- **Template Method** (分類: 振る舞い)
  - 解決する問題: フレームワークがアルゴリズムの骨格を定義し、利用者がステップの実装だけを提供する
  - 適用条件: ライフサイクルが固定されており、カスタマイズポイントが明確な場合
  - コード例: `packages/partyserver/src/index.ts:380-468` (fetch が骨格、onConnect/onMessage がフック)
  - 注意点: フックが増えすぎると理解コストが上がる。PartyKit は 7 つのフックに抑えている

- **Strategy** (分類: 振る舞い)
  - 解決する問題: 同一インターフェースで異なるアルゴリズムを切り替える
  - 適用条件: 動作モードが静的に決まり、実行時に切り替える必要がない場合
  - コード例: `packages/partyserver/src/connection.ts:268-385` (ConnectionManager の Hibernating/InMemory 切替)
  - 注意点: 静的プロパティで選択するため、インスタンスごとの切替はできない

- **Mixin** (分類: 構造)
  - 解決する問題: 既存クラスに機能を横断的に追加する
  - 適用条件: 複数の独立した機能を組み合わせたい場合
  - コード例: `packages/y-partyserver/src/server/index.ts:167-548` (withYjs)
  - 注意点: TypeScript の型推論が複雑になりやすく、`as unknown as` キャストが必要になることがある

## Good Patterns

- **空メソッドフック + ガイダンスログ**: デフォルト実装が `console.info("Implement onMessage on ...")` のように実装を促すメッセージを出力する。利用者は実行時に「次に何をすべきか」がわかる。抽象メソッド (`abstract`) ではなくオプショナルなオーバーライドにすることで、段階的な実装が可能。

```typescript
// packages/partyserver/src/index.ts:732-740
onError(connection: Connection, error: unknown): void | Promise<void> {
  console.error(
    `Error on connection ${connection.id} in ${this.#ParentClass.name}:${this.name}:`,
    error
  );
  console.info(
    `Implement onError on ${this.#ParentClass.name} to handle this error.`
  );
}
```

- **Duck Typing による自動検出**: 型チェックではなくメソッドの存在チェック (`"idFromName" in v`) で DurableObjectNamespace を検出する。これにより設定ファイルなしで env バインディングを自動マッピングできる。

```typescript
// packages/partyserver/src/index.ts:189-194
if (
  v && typeof v === "object"
  && "idFromName" in v
  && typeof v.idFromName === "function"
) {
  const kebab = camelCaseToKebabCase(k);
  namespaceMap[kebab] = v as DurableObjectNamespace;
}
```

- **WeakMap キャッシュで env ごとの再計算を防止**: `serverMapCache` と `attachments` (AttachmentCache) は WeakMap を使い、GC と連動した自動クリーンアップを実現。グローバル変数だがメモリリークしない。

```typescript
// packages/partyserver/src/index.ts:28-30
const serverMapCache = new WeakMap<
  object,
  Record<string, DurableObjectNamespace>
>();
```

- **初期化の冪等性保証**: `#ensureInitialized` は `blockConcurrencyWhile` で排他制御し、失敗時には状態を `"zero"` にリセットして再試行可能にする。エラーは `blockConcurrencyWhile` の外で再スローし、DO のインプットゲートをブロックしない。

```typescript
// packages/partyserver/src/index.ts:547-564
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

- **低レベルメソッドの直接オーバーライド**: `fetch`/`webSocketMessage`/`alarm` 等を直接オーバーライドすると、フレームワークのライフサイクル管理が壊れる。README にも「Do not implement any of these methods on your server class」と警告がある。

```typescript
// Bad: ライフサイクルが壊れる
class MyServer extends Server {
  async webSocketMessage(ws: WebSocket, message: WSMessage) {
    // 直接ハンドリング - onStart が呼ばれない可能性がある
  }
}

// Better: フックを使う
class MyServer extends Server {
  onMessage(connection: Connection, message: WSMessage) {
    // フレームワークが初期化・接続管理を保証
  }
}
```

- **継承の多段ネストによる複雑化**: Server → SyncServer → UserServer のような深い継承チェーンは、フック呼び出し順序の理解を困難にする。PartyKit 自身も `withYjs` ミックスインパターンに移行している。

```typescript
// Bad: 3段以上の継承
class MyServer extends SyncServer {
  onMessage(conn, msg) {
    super.onMessage(conn, msg); // どの onMessage が呼ばれる?
  }
}

// Better: ミックスインで合成
const MyServer = withYjs(Server);
```

## 導出ルール

- `[MUST]` フレームワークが提供するライフサイクルフックは「空のデフォルト実装」を持ち、abstract にしない。利用者が段階的に機能を追加できるようにする
  - 根拠: PartyServer の全フック (onConnect, onMessage, onClose, onError, onRequest, onAlarm, onStart) が空メソッドまたはログ出力のデフォルト実装を持つ (`packages/partyserver/src/index.ts:684-778`)

- `[MUST]` 排他的な初期化処理は失敗時にリトライ可能な状態にリセットする。ロック機構の内部でエラーを握りつぶさず、外部で再スローする
  - 根拠: `#ensureInitialized` は `blockConcurrencyWhile` 内で例外をキャッチし status を "zero" にリセット後、外部で再スローしてインプットゲートの永続ブロックを防いでいる (`packages/partyserver/src/index.ts:547-564`)

- `[SHOULD]` フレームワークの動作モード切替は、コンストラクタ引数やメソッド呼び出しではなく静的プロパティで宣言的に表現する
  - 根拠: `static options = { hibernate: true }` のワンライナーで Hibernation モードが切り替わり、クラス定義を見るだけで動作モードがわかる (`packages/partyserver/src/index.ts:328-330`)

- `[SHOULD]` 利用者が拡張する可能性のあるプロパティは `configurable: true` で定義し、下流プロジェクトが `Object.defineProperty` で再定義できるようにする
  - 根拠: Connection の state/setState は `configurable: true` で定義され、Cloudflare Agents SDK がこれを再定義している (`packages/partyserver/src/connection.ts:150-157`)

- `[SHOULD]` 環境バインディングの検出には Duck Typing (特定メソッドの存在チェック) を使い、明示的な設定ファイルなしで動作するようにする
  - 根拠: `routePartykitRequest` が `"idFromName" in v` で DurableObjectNamespace を自動検出し、設定ゼロで動作する (`packages/partyserver/src/index.ts:189-194`)

- `[SHOULD]` 機能の横断的追加にはクラス継承ではなくミックスイン関数パターン (`withXxx(Base)`) を使う
  - 根拠: Yjs サポートが `withYjs(Server)` として実装され、任意の Server サブクラスに合成可能 (`packages/y-partyserver/src/server/index.ts:167`)。changeset にも明示的にミックスインへの移行が記録されている

- `[AVOID]` フレームワーク内部メソッド (ライフサイクルのディスパッチ、初期化制御等) を利用者がオーバーライドできる状態にする。内部メソッドは private フィールド (`#`) で隠蔽する
  - 根拠: Server クラスは `#ensureInitialized`, `#attachSocketEventHandlers`, `#connectionManager` 等をすべて private フィールドで定義し、利用者が誤ってオーバーライドすることを防いでいる (`packages/partyserver/src/index.ts:332-594`)

## 適用チェックリスト

- [ ] フレームワークのライフサイクルフックが「空のデフォルト実装」を持ち、利用者が段階的に実装できるか
- [ ] デフォルト実装が「次に何をすべきか」を示すガイダンス (ログ等) を提供しているか
- [ ] 動作モードの切替が宣言的 (静的プロパティ、設定オブジェクト等) で、クラス定義を見るだけで把握できるか
- [ ] 初期化処理が冪等で、失敗後にリトライ可能な状態にリセットされるか
- [ ] 環境やバインディングの検出が規約ベースで、明示的な設定なしに動作するか
- [ ] 機能の追加がミックスイン/合成パターンで行われ、深い継承チェーンを避けているか
- [ ] フレームワーク内部のメソッド/状態が private フィールドで隠蔽され、誤ったオーバーライドが防がれているか
- [ ] 下流プロジェクトが拡張するプロパティが `configurable: true` で定義されているか
