# composition-patterns

> リポジトリ: cloudflare/partykit
> 分析日: 2026-02-25

## 概要

PartyKit は Durable Objects ベースのリアルタイムサーバーフレームワークであり、`Server` 基底クラスに対して 3 つの異なる合成パターン（Mixin / Factory / Middleware）を使い分けている。注目すべきは、各パターンが「ライフサイクルフックの拡張方法」と「状態のスコープ」の違いによって適切に選択されている点である。TypeScript のクラス合成における型安全性の確保手法と、Cloudflare Workers の制約（hibernation、DurableObject namespace の自動検出）に適応した設計が横断的に観察できる。

## 背景にある原則

- **フック合成による関心の分離**: 基底クラスのライフサイクルフック（`onStart`, `onConnect`, `onMessage`, `onClose`）を合成単位とし、各拡張が必要なフックだけをオーバーライドする。これにより、Yjs の同期ロジックや PubSub のトピック管理を、本体の Server 実装から独立して追加・除去できる。根拠: `withYjs` は `onStart`, `onConnect`, `onMessage`, `onClose` のみをオーバーライドし、`onRequest` や `onAlarm` には手を触れない（`packages/y-partyserver/src/server/index.ts:246-543`）。

- **クロージャによる環境キャプチャ**: Factory パターンで生成されたクラスと関数は、生成時のオプションをクロージャでキャプチャする。これにより設定値をインスタンスごとに渡す必要がなく、DurableObject バインディング名やノード分散設定を一箇所で管理できる。根拠: `createPubSubServer` は `nodeIDs` と `options` をクロージャで保持し、`PubSubServer` クラスと `routePubSubRequest` 関数の両方から参照する（`packages/partysub/src/server/index.ts:37-206`）。

- **環境の自動検出による Convention over Configuration**: `routePartykitRequest` は env オブジェクトから `idFromName` メソッドを持つプロパティを自動検出し、kebab-case 変換した名前で URL ルーティングに紐付ける。明示的な登録を不要にすることで、新しい DurableObject クラスを追加するだけでルーティングが自動的に機能する。根拠: `packages/partyserver/src/index.ts:184-201`。

- **短絡・変形・続行の三値フック**: `onBeforeConnect` / `onBeforeRequest` は `Response | Request | void` を返す設計で、Response 返却で短絡（認証拒否）、Request 返却で変形（ヘッダ注入）、void で続行という三つの制御フローを単一のフック型で表現する。根拠: `packages/partyserver/src/index.ts:298-316`。

## 実例と分析

### Mixin パターン: withYjs

`withYjs<TBase extends ServerClass>(Base: TBase)` は TypeScript の Mixin パターンを用いて、任意の `Server` サブクラスに Yjs 協調編集機能を付与する。

設計上の特徴:

1. **型の交差による能力の合成**: 戻り値型は `TBase & YjsStatic & (new (...args: any[]) => YjsInstance)` であり、元のクラスの型を保持しつつ新しいインスタンスメンバ（`document`, `onLoad`, `onSave` 等）とスタティックメンバ（`callbackOptions`）を追加する。
2. **ユーザーフックのスタブ化**: `onLoad()`, `onSave()`, `isReadOnly()`, `onCustomMessage()` はデフォルト実装（no-op）を持ち、ユーザーがサブクラスでオーバーライドする設計。テンプレートメソッドパターンの適用。
3. **プリセットとしての `YServer`**: `withYjs(Server)` をエクスポートすることで、Mixin を意識しない利用者にも簡易な API を提供する。

```typescript
// packages/y-partyserver/src/server/index.ts:167-169
export function withYjs<TBase extends ServerClass>(
  Base: TBase
): TBase & YjsStatic & (new (...args: any[]) => YjsInstance) {
```

```typescript
// packages/y-partyserver/src/server/index.ts:550
export const YServer = withYjs(Server);
```

テストコードでの利用が Mixin の柔軟性を示している。`YServer`（= `withYjs(Server)`）を直接継承し、`static options` や `static callbackOptions` をオーバーライドする:

```typescript
// packages/y-partyserver/src/tests/worker.ts:33-38
export class YPersistent extends YServer {
  static options = {
    hibernate: true
  };
  static callbackOptions: CallbackOptions = {
    debounceWait: 50,
    debounceMaxWait: 100
  };
```

### Factory パターン: createPubSubServer

`createPubSubServer(options)` はクラスとルーティング関数のペアを返す Factory である。

設計上の特徴:

1. **返却値がクラスと関数のペア**: `{ PubSubServer, routePubSubRequest }` という構造で、サーバーロジックとルーティングロジックを同じクロージャスコープで結合する。地理分散の設定（`nodeIDs`）は両方から参照される。
2. **ジェネリクスによる Env 型の伝搬**: `createPubSubServer<Env>` がジェネリクスを受け取り、生成される `PubSubServer` と `routePubSubRequest` の両方に型を伝搬する。

```typescript
// packages/partysub/src/server/index.ts:26-36
export function createPubSubServer<
  Env extends Cloudflare.Env = Cloudflare.Env
>(options: {
  binding: string;
  nodes?: number;
  locations?: Partial<Record<DurableObjectLocationHint, number>>;
  jurisdiction?: DurableObjectJurisdiction;
}): {
  PubSubServer: typeof Server<Env>;
  routePubSubRequest: (request: Request, env: Env) => Promise<Response | null>;
} {
```

`routePubSubRequest` 内では地理ベースのルーティングが行われ、リクエスト元の国から最適な DurableObject ロケーションを選択する:

```typescript
// packages/partysub/src/server/index.ts:167-196
let countryOfOrigin: Iso3166Alpha2Code | "T1" | undefined = request.cf
  ?.country as Iso3166Alpha2Code | "T1" | undefined;
// ...
const id = Math.floor(Math.random() * nodeIDs[foundLocation].length);
const newPath = `/parties/${party}/${room}-${nodeIDs[foundLocation][id]}`;
```

### Middleware パターン: partyserverMiddleware

`partyserverMiddleware` は Hono のミドルウェアとして PartyServer を統合する。

設計上の特徴:

1. **コンテキストブリッジ**: `wrapOptionsWithContext` が Hono の `Context` を PartyServer の `onBeforeConnect`/`onBeforeRequest` コールバックの第三引数として注入する。異なるフレームワーク間のコンテキスト伝搬を実現する。
2. **WebSocket / HTTP の分岐**: `isWebSocketUpgrade` で判定し、WebSocket なら `handleWebSocketUpgrade`、HTTP なら `handleHttpRequest` に委譲。どちらも最終的に `routePartykitRequest` を呼ぶが、WebSocket の場合は `response.webSocket` の存在チェックが追加される。
3. **null による next() 委譲**: `routePartykitRequest` が `null` を返した場合（パスが一致しない場合）は Hono の `next()` を呼ぶ。

```typescript
// packages/hono-party/src/index.ts:72-90
function wrapOptionsWithContext<E extends Env>(
  options: HonoPartyServerOptions<E> | undefined,
  c: Context<E>,
): PartyServerOptions | undefined {
  if (!options) return undefined;
  const { onBeforeConnect, onBeforeRequest, ...rest } = options;
  return {
    ...rest,
    ...(onBeforeConnect && {
      onBeforeConnect: (req: Request, lobby: Lobby) => onBeforeConnect(req, lobby, c),
    }),
    ...(onBeforeRequest && {
      onBeforeRequest: (req: Request, lobby: Lobby) => onBeforeRequest(req, lobby, c),
    }),
  };
}
```

### 自動検出ルーター: routePartykitRequest

`routePartykitRequest` はルーティングそのものを合成パターンとして提供する。env オブジェクトを走査し、`idFromName` メソッドを持つプロパティ（= DurableObjectNamespace）を自動検出する:

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

`WeakMap` による env ベースのキャッシュにより、リクエストごとの走査コストを回避している。

### 継承チェーンの深度パターン

パッケージ横断で、合成の深度に複数のレイヤーが存在する:

- **1段**: `extends Server` -- `Scheduler`（partywhen）、テストの `Stateful` 等
- **2段**: `extends SyncServer extends Server` -- `Agent`（partysync）
- **Mixin + 継承**: `extends YServer`（= `withYjs(Server)`）-- `YPersistent`, `YReadOnly` 等

`Agent` は `SyncServer` を継承しつつ、さらに RPC クライアントを内包する。これは Mixin ではなく古典的継承を選択した例であり、`SyncServer` が `onMessage` を完全に制御する必要があるため:

```typescript
// packages/partysync/src/server/index.ts:21-24
export class SyncServer<
  Env extends Cloudflare.Env = Cloudflare.Env,
  TChannels extends Channels = Channels
> extends Server<Env> {
```

## パターンカタログ

- **Mixin パターン** (分類: 構造)
  - 解決する問題: 基底クラスに対して複数の独立した機能（Yjs, PubSub 等）を組み合わせ可能にする
  - 適用条件: 拡張する機能が基底クラスのライフサイクルフックの一部のみをオーバーライドし、他の機能と衝突しない場合
  - コード例: `packages/y-partyserver/src/server/index.ts:167-548`
  - 注意点: TypeScript の Mixin は戻り値型に `as unknown as` キャストが必要になることが多い（`index.ts:545-547`）。複数 Mixin の適用順序によるフック衝突に注意

- **Factory Method パターン** (分類: 生成)
  - 解決する問題: 設定値をクロージャでキャプチャし、クラスとユーティリティ関数のペアを一貫した設定で生成する
  - 適用条件: 生成されるクラスが設定に依存する外部リソース（DurableObject バインディング名、ノード分散設定）を参照する場合
  - コード例: `packages/partysub/src/server/index.ts:26-207`
  - 注意点: クロージャ内のクラス定義は外部からの拡張が難しい。利用側が PubSubServer を更にサブクラス化したい場合の API 設計に注意

- **Adapter / Bridge パターン** (分類: 構造)
  - 解決する問題: 異なるフレームワーク（Hono）のコンテキストモデルを PartyServer のフックモデルに変換する
  - 適用条件: 二つのフレームワーク間でコンテキスト情報（env, 認証情報等）を橋渡しする場合
  - コード例: `packages/hono-party/src/index.ts:72-90`
  - 注意点: ブリッジ層が薄いほど保守性が高い。`wrapOptionsWithContext` は 15 行で Hono Context の注入を完結させている

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: アルゴリズムの骨格（Yjs の同期プロトコル処理）を固定し、ユーザーがカスタマイズ可能なステップ（`onLoad`, `onSave`, `isReadOnly`）だけを公開する
  - 適用条件: プロトコル処理など変更不可の処理フローの中に、ユーザー定義のステップを埋め込む場合
  - コード例: `packages/y-partyserver/src/server/index.ts:175-177`（`onLoad` のデフォルト実装）
  - 注意点: デフォルト実装を no-op にするか例外にするかで API の安全性が変わる。`onLoad` は no-op（安全側）、`SyncServer.onAction` は throw（実装必須を強制）

## Good Patterns

- **Mixin + プリセットエクスポートの二層 API**: `withYjs` 関数で柔軟な Mixin 合成を提供しつつ、`export const YServer = withYjs(Server)` でシンプルなプリセットも公開する。利用者のスキルレベルに応じた API レイヤーを提供できる。

```typescript
// packages/y-partyserver/src/server/index.ts:167-169, 550
export function withYjs<TBase extends ServerClass>(Base: TBase) { ... }
export const YServer = withYjs(Server);
```

- **三値フック（Response | Request | void）による制御フロー表現**: 認証チェック→短絡、ヘッダ注入→変形、何もしない→続行を単一のフック型で表現する。if-else チェーンよりも宣言的で、型によって返却値の意味が自明になる。

```typescript
// packages/partyserver/src/index.ts:298-306
if (isWebSocket) {
  if (options?.onBeforeConnect) {
    const reqOrRes = await options.onBeforeConnect(req, lobby);
    if (reqOrRes instanceof Request) {
      req = reqOrRes; // 変形
    } else if (reqOrRes instanceof Response) {
      return reqOrRes; // 短絡
    }
    // void → 続行
  }
}
```

- **WeakMap による env ベースのキャッシュ**: `serverMapCache` と `bindingNameCache` は `WeakMap<object, ...>` で env オブジェクトをキーとする。env が GC されればキャッシュも自動解放される。Worker のリクエスト駆動ライフサイクルに適合した設計。

```typescript
// packages/partyserver/src/index.ts:27-33
const serverMapCache = new WeakMap<
  object,
  Record<string, DurableObjectNamespace>
>();
const bindingNameCache = new WeakMap<object, Record<string, string>>();
```

- **クロージャによるクラス + 関数ペアの共有スコープ**: Factory の返却値としてクラスと関数をペアにすることで、設定値を一箇所で管理する。利用者は destructuring で必要なものだけ取り出せる。

```typescript
// packages/partysub/README.md の利用例
const { PubSubServer, routePubSubRequest } = createPubSubServer({
  binding: "PubSub",
  nodes: 100,
  locations: { eu: 1, wnam: 3 },
});
```

## Anti-Patterns / 注意点

- **Mixin の型キャストの不透明さ**: `withYjs` の戻り値で `as unknown as TBase & YjsStatic & (new (...args: any[]) => YjsInstance)` というダブルキャストが必要になる。TypeScript の Mixin パターンの構造的な制約であり、型安全性の穴が生じる可能性がある。

```typescript
// Bad: 型の安全性が検証されない
return YjsMixin as unknown as
  & TBase
  & YjsStatic
  & (new(...args: any[]) => YjsInstance);
// packages/y-partyserver/src/server/index.ts:545-547
```

```typescript
// Better: interface 制約と satisfies を併用して型の整合性を部分的に検証する
// （ただし TypeScript の Mixin パターンではキャストが事実上不可避であり、
//   テストカバレッジで型の整合性を補完するのが現実的）
```

- **Factory 内クラスの拡張性の制限**: `createPubSubServer` で生成される `PubSubServer` はクロージャ内で定義されるため、利用者がさらにサブクラス化しても `nodeIDs` や `options` にアクセスできない。拡張ポイントを設けるか、設定を別途アクセス可能にする設計が望ましい。

```typescript
// Bad: クロージャ内のクラスを返すだけだと拡張性が低い
const { PubSubServer } = createPubSubServer({ binding: "PubSub" });
class MyPubSub extends PubSubServer {
  // nodeIDs にアクセスできない
}
```

```typescript
// Better: 設定オブジェクトをスタティックプロパティで公開する
class PubSubServer extends Server<Env> {
  static config = { nodeIDs, options };
  // ...
}
```

## 導出ルール

- `[MUST]` Mixin 関数は基底クラスの型パラメータを交差型で保持し、元の型情報を失わないようにする
  - 根拠: `withYjs` は `TBase & YjsStatic & (new (...args) => YjsInstance)` を返し、Base の型を保持する（`packages/y-partyserver/src/server/index.ts:168-169`）

- `[MUST]` ライフサイクルフックを合成する際、Mixin がオーバーライドしないフックは元のクラスの実装がそのまま利用できる状態を維持する
  - 根拠: `withYjs` は `onStart`, `onConnect`, `onMessage`, `onClose` のみオーバーライドし、`onRequest`, `onAlarm` 等は基底クラスに委譲している

- `[SHOULD]` Mixin 関数を提供する場合、Mixin 適用済みのプリセットクラスも併せてエクスポートする（二層 API）
  - 根拠: `YServer = withYjs(Server)` により、Mixin を意識しない利用者にもシンプルな API を提供している（`index.ts:550`）

- `[SHOULD]` Factory パターンで関連するクラスと関数を生成する場合、同一クロージャスコープで設定を共有し、destructuring で取り出せる形にする
  - 根拠: `createPubSubServer` は `{ PubSubServer, routePubSubRequest }` をペアで返し、`nodeIDs` を共有する（`packages/partysub/src/server/index.ts:203-206`）

- `[SHOULD]` 前処理フックは `Response | Request | void` の三値返却型にして、短絡（拒否）・変形（ヘッダ注入等）・続行を単一のフックで表現する
  - 根拠: `onBeforeConnect`/`onBeforeRequest` がこの設計で認証・リクエスト変形・パススルーを簡潔に表現している（`packages/partyserver/src/index.ts:136-148`）

- `[SHOULD]` 環境オブジェクトのランタイム走査でサービスを自動検出する場合、結果を WeakMap でキャッシュしてリクエストごとの走査コストを回避する
  - 根拠: `routePartykitRequest` は `serverMapCache = new WeakMap` で env オブジェクトに紐づけたキャッシュを維持する（`packages/partyserver/src/index.ts:27-30, 184-201`）

- `[SHOULD]` 異なるフレームワーク間のコンテキストブリッジは、元のコールバックシグネチャを変換する薄いラッパー関数で実装し、ブリッジ層を最小限に保つ
  - 根拠: `wrapOptionsWithContext` は 15 行で Hono Context を PartyServer フックに注入している（`packages/hono-party/src/index.ts:72-90`）

- `[AVOID]` Template Method パターンでユーザーが必ず実装すべきメソッドをデフォルト no-op にすること。実装忘れをランタイムまで検出できなくなる
  - 根拠: `SyncServer.onAction` は `throw new Error("onAction not implemented")` で実装を強制するが、`withYjs` の `onLoad`/`onSave` は no-op であり、永続化が暗黙的に無効化されるリスクがある（`packages/partysync/src/server/index.ts:33-38` vs `packages/y-partyserver/src/server/index.ts:175-177`）

- `[AVOID]` Factory 内でクラスを定義する際に、クロージャ変数への外部からのアクセス手段を一切設けないこと。生成されたクラスの拡張性を著しく制限する
  - 根拠: `createPubSubServer` の `PubSubServer` は `nodeIDs` や `options` にアクセスする手段がなく、サブクラス化時に地理分散ロジックをカスタマイズできない

## 適用チェックリスト

- [ ] 基底クラスに複数の独立した拡張機能を追加する場合、Mixin パターンの適用を検討したか（継承チェーンの深度を抑えるため）
- [ ] Mixin を提供する場合、Mixin 関数とプリセットクラスの二層 API を設計したか
- [ ] Mixin の戻り値型が元のクラスの型パラメータを交差型で保持しているか確認したか
- [ ] Factory パターンで返却する場合、クラスと関連関数のペアを同一スコープで生成し、設定の一貫性を保っているか
- [ ] Factory 内のクラスに外部からカスタマイズ可能な拡張ポイント（static プロパティ、protected メソッド等）を設けたか
- [ ] 前処理フックに `Response | Request | void` の三値パターンを適用し、短絡・変形・続行を宣言的に表現できているか
- [ ] ランタイムでのサービス自動検出結果を WeakMap 等でキャッシュし、リクエストごとの走査コストを回避しているか
- [ ] 異なるフレームワーク間のコンテキストブリッジが薄いラッパー関数で完結しているか（ブリッジ層の肥大化を防ぐ）
- [ ] Template Method パターンで必須フックと任意フックを明確に区別しているか（throw vs no-op）
