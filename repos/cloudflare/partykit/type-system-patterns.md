# type-system-patterns

> リポジトリ: cloudflare/partykit
> 分析日: 2026-02-25

## 概要

ジェネリクス制約、再帰的イミュータブル型、判別共用体、mixin の型パラメータ伝播といった型システムパターンを横断的に分析する。PartyKit は WebSocket サーバーフレームワークとして、`Server<Env, Props>` から `Connection<TState>` に至るまで、型パラメータが階層的に伝播する設計を採用している。特に注目すべきは、`configurable` プロパティディスクリプタによるランタイム拡張ポイントと型安全性の両立、および `satisfies` 演算子を用いた構造的型チェックの一貫した適用である。

## 背景にある原則

- **型パラメータにはデフォルトを与えて段階的な型付けを可能にすべき**: すべての主要クラス (`Server<Env = Cloudflare.Env, Props = Record<string, unknown>>`, `Connection<TState = unknown>`, `Scheduler<Env = Cloudflare.Env>`) が型パラメータにデフォルト値を持つ。これにより、入門者は型引数なしで使い始め、必要に応じて厳密な型付けへ移行できる。`Server` を引数なしで `extends Server` と書いても、`extends Server<MyEnv, MyProps>` と書いても、どちらも正しく動作する (`packages/partyserver/src/index.ts:324-327`)。

- **イミュータブル型は再帰的に適用し、ランタイムではなくコンパイル時に不変性を保証すべき**: `ConnectionState<T>` は `ImmutableObject<T> | null` として定義され、`Immutable<T>` が Array/Map/Set/Object に再帰的に適用される (`packages/partyserver/src/types.ts:1-17`)。`Object.freeze` のようなランタイムコストを避けつつ、型レベルで `.state` プロパティの直接変更を防いでいる。

- **ランタイム拡張ポイントは `configurable` プロパティで宣言し、下流の型安全性を型定義側で保証すべき**: `Connection` の `state` と `setState` は `configurable: true` で定義されており、Cloudflare Agents SDK のような下流消費者が `Object.defineProperty` で再定義できる (`packages/partyserver/src/connection.ts:151-157`)。型定義では JSDoc で明示的にこの意図を文書化している (`packages/partyserver/src/types.ts:33-36`)。

- **判別共用体は `type` フィールドで分岐し、`satisfies` で構造的整合性を検証すべき**: メッセージプロトコル (`BroadcastMessage`, `RpcResponse`, `RawTask`) およびモジュール公開 (`ExportedHandler`) に対して `satisfies` 演算子を一貫して適用し、リテラル型の推論を保ちつつ構造的型チェックを行っている。

## 実例と分析

### 階層的ジェネリクス制約の伝播

`Server<Env, Props>` を頂点として、サブクラスが型パラメータを受け継ぎながら追加の制約を導入する設計が見られる。

`SyncServer` は `Server<Env>` を拡張し、新たに `TChannels` 型パラメータを追加する。`TChannels` は `{ [Channel: string]: { record: RecordType; action: ActionType } }` 構造を制約として持ち、`onAction` メソッドの引数と戻り値がチャネル単位で型安全になる:

```typescript
// packages/partysync/src/server/index.ts:21-24
export class SyncServer<
  Env extends Cloudflare.Env = Cloudflare.Env,
  TChannels extends Channels = Channels
> extends Server<Env> {
```

さらに `Agent` クラスは `SyncServer` を拡張し、同じ `Channels` 制約を伝播する:

```typescript
// packages/partysync/src/agent/index.ts:10-21
export class Agent<
  Env extends Cloudflare.Env = Cloudflare.Env,
  Channels extends {
    [Channel: string]: {
      record: unknown[];
      action: { type: string; payload: unknown };
    };
  } = Record<
    string,
    { record: unknown[]; action: { type: string; payload: unknown } }
  >
> extends SyncServer<Env, Channels> {
```

利用側では具体的なチャネル定義を渡すことで、型安全な CRUD 操作が実現される:

```typescript
// fixtures/todo-sync/src/server.ts:16-19
export class ToDos extends SyncServer<
  Env,
  { todos: { record: TodoRecord; action: TodoAction } }
> {
```

### 再帰的イミュータブル型による Connection State

`Immutable<T>` 型は条件付き型を用いて、プリミティブ / Array / Map / Set / Object それぞれに対応する `Readonly` ラッパーを再帰的に適用する:

```typescript
// packages/partyserver/src/types.ts:1-15
type ImmutablePrimitive = undefined | null | boolean | string | number;
type Immutable<T> = T extends ImmutablePrimitive ? T
  : T extends Array<infer U> ? ImmutableArray<U>
  : T extends Map<infer K, infer V> ? ImmutableMap<K, V>
  : T extends Set<infer M> ? ImmutableSet<M>
  : ImmutableObject<T>;
type ImmutableArray<T> = ReadonlyArray<Immutable<T>>;
type ImmutableMap<K, V> = ReadonlyMap<Immutable<K>, Immutable<V>>;
type ImmutableSet<T> = ReadonlySet<Immutable<T>>;
type ImmutableObject<T> = { readonly [K in keyof T]: Immutable<T[K]>; };
```

`Connection<TState>` の `state` は `ConnectionState<TState>` すなわち `ImmutableObject<TState> | null` となり、読み取りは再帰的に readonly だが、`setState` メソッドを通じた更新は元の `TState` 型で受け付ける:

```typescript
// packages/partyserver/src/types.ts:17-18
export type ConnectionState<T> = ImmutableObject<T> | null;
export type ConnectionSetStateFn<T> = (prevState: ConnectionState<T>) => T;
```

### Mixin パターンの型パラメータ伝播

`withYjs` は `ServerClass` 型制約を受け取り、戻り値で静的プロパティとインスタンスプロパティの型を intersection で合成する:

```typescript
// packages/y-partyserver/src/server/index.ts:146-147
type ServerClass = new (...args: any[]) => Server;

// packages/y-partyserver/src/server/index.ts:167-169
export function withYjs<TBase extends ServerClass>(
  Base: TBase
): TBase & YjsStatic & (new (...args: any[]) => YjsInstance) {
```

インターフェース `YjsInstance` と `YjsStatic` を分離することで、インスタンスメンバーと静的メンバーの型が明確に分かれている。この mixin は `YServer = withYjs(Server)` として使い、さらにユーザーが `withYjs(MyServer)` としてカスタムサーバーに適用することもできる (`packages/y-partyserver/src/server/index.ts:550`)。

### TypedEventTarget による型安全なイベント

`TypedEventTarget<EventMap>` は `EventTarget` を型パラメータ付きで拡張するためのヘルパー型で、`addEventListener` / `removeEventListener` のイベント名とコールバック型を連動させる:

```typescript
// packages/partysocket/src/type-helper.ts:1-34
export type TypedEventTarget<EventMap extends object> = {
  new(): IntermediateEventTarget<EventMap>;
};

interface IntermediateEventTarget<EventMap> extends EventTarget {
  addEventListener<K extends keyof EventMap>(
    type: K,
    callback: (
      event: EventMap[K] extends Event ? EventMap[K] : never,
    ) => EventMap[K] extends Event ? void : never,
    options?: boolean | AddEventListenerOptions,
  ): void;
  // ... string オーバーロードも保持
}
```

これを `extends (EventTarget as TypedEventTarget<WebSocketEventMap>)` のように型アサーション付きで継承に使用する (`packages/partysocket/src/ws.ts:149`)。

### 判別共用体と satisfies の一貫適用

`RawTask` 型は `type` フィールドによる判別共用体で、4 種類のタスクスケジュールを型レベルで区別する:

```typescript
// packages/partywhen/src/index.ts:4-25
export type RawTask =
  & {
    id: string;
    description?: string | undefined;
    payload?: Record<string, unknown> | undefined;
    callback?: Callback | undefined;
  }
  & (
    | { time: Date; type: "scheduled"; }
    | { delayInSeconds: number; type: "delayed"; }
    | { cron: string; type: "cron"; }
    | { type: "no-schedule"; }
  );
```

`Callback` 型も同様に `type` フィールドで分岐し、4 種類のコールバック先を表現する (`packages/partywhen/src/index.ts:58-77`)。`RpcResponse<ResponseType>` は `"success" | "error"` の判別共用体で、`satisfies` と組み合わせてメッセージ送信時に構造的整合性を検証している:

```typescript
// packages/partysync/src/server/index.ts:95-103
connection.send(
  JSON.stringify(
    {
      type: "success",
      rpc: true,
      channel: channel as string,
      id: messageId,
      result: result,
    } satisfies RpcResponse<TChannels[typeof channel]["record"]>,
  ),
);
```

### Extract によるプラットフォーム型の絞り込み

`Lobby<Env>` インターフェースで、`className` を `Extract<keyof Env, string>` として定義し、Env のキーから文字列キーのみを抽出している:

```typescript
// packages/partyserver/src/index.ts:91-102
export interface Lobby<Env = Cloudflare.Env> {
  party: string;
  className: Extract<keyof Env, string>;
  name: string;
}
```

## パターンカタログ

- **Mixin パターン** (分類: 構造)
  - 解決する問題: 単一継承の制約下で、既存クラスに機能を合成する
  - 適用条件: 基底クラスを変更せずにクロスカッティング機能（Yjs 同期）を追加したい場合
  - コード例: `packages/y-partyserver/src/server/index.ts:167-169`
  - 注意点: 戻り値の型を `TBase & YjsStatic & (new (...args: any[]) => YjsInstance)` と intersection で表現する必要がある。`as unknown as` キャストが必要になる点はトレードオフ

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: フレームワークがアルゴリズムの骨格を定義し、ユーザーがステップを実装する
  - 適用条件: `onConnect` / `onMessage` / `onClose` のようなライフサイクルフックを提供する場合
  - コード例: `packages/partyserver/src/index.ts:684-767`
  - 注意点: デフォルト実装は console.log で開発者ヒントを出力し、未実装であることを明示

## Good Patterns

- **型パラメータのデフォルト値による段階的型付け**: `Server<Env extends Cloudflare.Env = Cloudflare.Env>` のように、すべてのジェネリクスにデフォルト値を提供する。入門時は `extends Server` で始め、型安全性が必要になったら `extends Server<MyEnv>` に移行できる。コードベース全体で一貫しており (`Server`, `SyncServer`, `Scheduler`, `Agent`, `Lobby`)、API の学習曲線を緩やかにしている。

```typescript
// packages/partyserver/src/index.ts:324-327
export class Server<
  Env extends Cloudflare.Env = Cloudflare.Env,
  Props extends Record<string, unknown> = Record<string, unknown>
> extends DurableObject<Env> {
```

- **`satisfies` による構造的型検証**: `as` アサーションの代わりに `satisfies` を使い、リテラル型の推論を保ちつつ構造的整合性を保証する。プロトコルメッセージの構築時に頻繁に使われ、フィールドの欠落や型の不一致をコンパイル時に検出する。

```typescript
// packages/partyfn/src/index.ts:88-94
this.socket.send(
  JSON.stringify(
    {
      id,
      channel: this.channel,
      rpc: true,
      action,
    } satisfies RpcAction<RequestType>,
  ),
);
```

- **configurable プロパティディスクリプタによる型安全な拡張ポイント**: `Object.defineProperties` で `configurable: true` を指定し、下流消費者が振る舞いを再定義できるようにする。型定義では JSDoc コメントで拡張契約を文書化している。

```typescript
// packages/partyserver/src/types.ts:30-36
/**
 * This property is configurable, meaning it can be redefined via
 * `Object.defineProperty` by downstream consumers (e.g. the Cloudflare
 * Agents SDK) to namespace or wrap internal state storage.
 */
state: ConnectionState<TState>;
```

- **WeakMap による型安全なメタデータキャッシュ**: `AttachmentCache` は `WeakMap<WebSocket, ConnectionAttachments>` でシリアライズ結果をキャッシュし、GC と連動してメモリリークを防ぐ。型パラメータなしの `WeakMap` で内部実装を隠蔽し、公開 API では `Connection<TState>` でユーザー状態の型を公開する。

```typescript
// packages/partyserver/src/connection.ts:81-106
class AttachmentCache {
  #cache = new WeakMap<WebSocket, ConnectionAttachments>();
  get(ws: WebSocket): ConnectionAttachments {/* ... */}
  set(ws: WebSocket, attachment: ConnectionAttachments) {/* ... */}
}
```

## Anti-Patterns / 注意点

- **`@ts-expect-error` の乱用**: `partywhen/src/index.ts` では `// @ts-expect-error yeah whatever` のようなコメントが複数箇所にあり、Env のキーから動的に DurableObject namespace にアクセスする際に型安全性が放棄されている。動的プロパティアクセスが避けられない場合でも、ヘルパー関数で型ガードを集約すべきである。

```typescript
// Bad: packages/partywhen/src/index.ts:377-384
// @ts-expect-error yeah whatever
const id = this.env[task.callback.namespace as keyof Env].idFromName(
  task.callback.name,
);
// @ts-expect-error yeah whatever
const stub = this.env[task.callback.namespace as keyof Env].get(id);
```

```typescript
// Better: 型安全なヘルパー関数に集約
function getNamespace<Env>(
  env: Env,
  name: string,
): DurableObjectNamespace | undefined {
  const ns = env[name as keyof Env];
  if (ns && typeof ns === "object" && "idFromName" in ns) {
    return ns as DurableObjectNamespace;
  }
  return undefined;
}
```

- **`as` キャストによる判別共用体の分岐バイパス**: `SyncServer.onMessage` で `json.channel as keyof TChannels` のように `as` でキャストし、ランタイム検証なしでチャネル名を信頼している。ユーザー入力由来のデータに対しては型ガードで検証すべきである。

```typescript
// Bad: packages/partysync/src/server/index.ts:62
const channel = json.channel as keyof TChannels;

// Better: ランタイム検証付き
function isValidChannel<T extends Channels>(
  channels: (keyof T)[],
  name: string,
): name is keyof T & string {
  return channels.includes(name as keyof T);
}
```

## 導出ルール

- `[MUST]` ジェネリクスを持つ公開 API の型パラメータにはデフォルト値を設定する
  - 根拠: PartyKit の全主要クラスが `= Cloudflare.Env` / `= unknown` / `= Record<string, unknown>` をデフォルトに持ち、型引数なしでも使用可能にしている (`packages/partyserver/src/index.ts:324-327`)

- `[MUST]` 判別共用体のメッセージ型には `satisfies` を使って構造的整合性を検証する (`as` による型アサーションではなく)
  - 根拠: `partysync` / `partyfn` で `satisfies RpcAction<T>` / `satisfies BroadcastMessage<T>` が一貫して使われ、フィールド欠落をコンパイル時に検出している (`packages/partysync/src/server/index.ts:57-122`)

- `[SHOULD]` 読み取り専用の状態プロパティは再帰的イミュータブル型 (`ImmutableObject<T>`) で公開し、更新は専用のセッター関数を経由させる
  - 根拠: `Connection.state` は `ImmutableObject<TState> | null` で読み取り専用にし、`setState` で更新を強制することで、状態の直接変更を型レベルで防いでいる (`packages/partyserver/src/types.ts:17-53`)

- `[SHOULD]` Mixin 関数の戻り値型は、基底クラス型 / 静的メンバーインターフェース / インスタンスメンバーインターフェースの intersection として表現する
  - 根拠: `withYjs` が `TBase & YjsStatic & (new (...args: any[]) => YjsInstance)` を返すことで、元のクラスの型情報を保持しつつ Yjs 機能の型を追加している (`packages/y-partyserver/src/server/index.ts:545-548`)

- `[SHOULD]` 下流消費者が拡張する可能性のあるプロパティは `configurable: true` で定義し、JSDoc で拡張契約を文書化する
  - 根拠: `Connection.state` / `Connection.setState` が configurable で定義され、Agents SDK が `Object.defineProperty` で再定義できる設計になっている (`packages/partyserver/src/connection.ts:150-157`, `packages/partyserver/src/types.ts:30-36`)

- `[AVOID]` ユーザー入力由来の値を `as keyof T` でキャストして判別共用体の分岐に使うこと (ランタイム検証なしの型キャストはプロトコル不整合を隠蔽する)
  - 根拠: `SyncServer.onMessage` で `json.channel as keyof TChannels` とキャストしており、不正なチャネル名が渡された場合の型安全性が失われている (`packages/partysync/src/server/index.ts:62`)

## 適用チェックリスト

- [ ] 公開 API のジェネリクス型パラメータにすべてデフォルト値が設定されているか
- [ ] 状態オブジェクトの読み取りプロパティが再帰的 Readonly 型で保護されているか (直接変更が型エラーになるか)
- [ ] メッセージやリクエストボディの構築時に `satisfies` で構造的型チェックを行っているか (`as` ではなく)
- [ ] 判別共用体の `type` フィールドがリテラル型になっているか (string 型に広がっていないか)
- [ ] Mixin パターンを使う場合、戻り値型が基底クラス / 静的メンバー / インスタンスメンバーの intersection で正しく表現されているか
- [ ] ランタイム拡張ポイント (`Object.defineProperty` で再定義される可能性があるプロパティ) が `configurable: true` で宣言され、型定義と JSDoc で契約が文書化されているか
- [ ] 外部入力 (WebSocket メッセージ、HTTP リクエスト) を型パラメータにキャストする際にランタイム検証が伴っているか
