# abstraction-patterns

> リポジトリ: modelcontextprotocol/typescript-sdk
> 分析日: 2026-02-24

## 概要

Transport・Protocol・Server/Client の抽象化レイヤー設計とインターフェース境界を評価する。この SDK は Types → Protocol → Client/Server → McpServer という明確な4層アーキテクチャを採用し、各レイヤーが単一の責務を担う。注目すべきは、Transport インターフェースの極小設計、Protocol 抽象クラスによるメッセージルーティングの集約、そして pluggable なバリデーションとプラットフォーム shims による実行環境の差異吸収である。プロトコル SDK の抽象化設計として、責務分離・拡張性・クロスプラットフォーム対応の実践例が豊富に含まれる。

## 背景にある原則

- **インターフェースは最小に、実装は自由に**: Transport インターフェースは `start()`・`send()`・`close()` + コールバック3つのみで構成される。InMemoryTransport（テスト用）、StdioServerTransport（Node.js）、WebStandardStreamableHTTPServerTransport（Web標準）のすべてがこの同じインターフェースを実装する。最小のインターフェースが最大の実装自由度を生む。根拠: `packages/core/src/shared/transport.ts:74-134`
- **層ごとに抽象度を変え、ユーザーの選択肢を残す**: Protocol（低レベル: ハンドラー手動登録）→ Server（中レベル: 初期化フロー自動化）→ McpServer（高レベル: registerTool/registerPrompt）の3段階を提供し、ユーザーは必要な抽象度を選べる。Server クラスには `@deprecated` が付き McpServer への移行を促しつつ、低レベルアクセスは `McpServer.server` プロパティで公開する。根拠: `packages/server/src/server/server.ts:88` の deprecated 注釈と `packages/server/src/server/mcp.ts:67-70` の `public readonly server: Server`
- **プラットフォーム差異はビルド時に解決する**: Node.js vs Cloudflare Workers のバリデータ差異（Ajv vs @cfworker/json-schema）を、package.json の export conditions と shim ファイルで解決する。ランタイムの条件分岐ではなく、バンドラーが正しい実装を選択する。根拠: `packages/server/package.json:29-46` の `./_shims` エクスポート条件
- **Capability-based アクセス制御で安全な拡張を保証する**: リクエスト送信時・ハンドラー登録時の両方で capability チェックを行い、宣言されていない機能へのアクセスをコンパイル時ではなく実行時に制御する。これにより、クライアントとサーバーが異なるバージョンでも安全に通信できる。根拠: `packages/server/src/server/server.ts:246-277` の `assertCapabilityForMethod`

## 実例と分析

### Transport インターフェースの設計と実装バリエーション

Transport インターフェースは、コアの `packages/core/src/shared/transport.ts` で定義される。メソッドは `start()`・`send()`・`close()` の3つ、コールバックは `onclose`・`onerror`・`onmessage` の3つのみ。`send()` の第2引数 `TransportSendOptions` は `relatedRequestId` と `resumptionToken` をオプションで受け、HTTP ストリーミングの再接続をサポートする。

StdioServerTransport（`packages/server/src/server/stdio.ts`）は `ReadBuffer` を使ってバイトストリームを JSON-RPC メッセージに分解する最も単純な実装。InMemoryTransport（`packages/core/src/util/inMemory.ts:13-63`）は `createLinkedPair()` スタティックメソッドで対になるトランスポートを生成し、テスト時にクライアントとサーバーを同一プロセスで接続する。WebStandardStreamableHTTPServerTransport（`packages/server/src/server/streamableHttp.ts:224`）は Web Standard API のみを使い、Node.js・Cloudflare Workers・Deno・Bun で動作する。

注目すべきは、`onmessage` コールバックの型シグネチャが `<T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void` と、メッセージ型をジェネリックにしつつ `extra` で認証情報やリクエスト情報を運べるように設計されている点。これにより HTTP トランスポートの認証コンテキストを Protocol レイヤーに伝搬できる。

### Protocol 抽象クラスの責務集約

`Protocol<ContextT extends BaseContext>` 抽象クラス（`packages/core/src/shared/protocol.ts:392`）は、すべてのメッセージルーティングロジックを集約する。リクエスト/レスポンスの相関管理（`_responseHandlers` Map）、タイムアウト制御、プログレス通知、キャンセル処理をこの1クラスに閉じ込めている。

サブクラスが実装すべき抽象メソッドは5つ:

- `buildContext()`: BaseContext → ContextT への変換
- `assertCapabilityForMethod()`: リモート側の capability チェック
- `assertNotificationCapability()`: ローカル側の notification capability チェック
- `assertRequestHandlerCapability()`: ローカル側の request handler capability チェック
- `assertTaskHandlerCapability()`: タスクハンドラーの capability チェック

Server（`packages/server/src/server/server.ts:89`）と Client（`packages/client/src/client/client.ts:195`）はこの5メソッドを override し、それぞれの capability マッピングを定義する。この設計により、プロトコルのメッセージ処理ロジック（数百行）を重複なく共有しつつ、サーバー/クライアント固有の振る舞いを分離している。

### McpServer の Facade パターン

McpServer（`packages/server/src/server/mcp.ts:66`）は Server を内部に保持し、`registerTool()`・`registerPrompt()`・`registerResource()` といった高レベル API を提供する。内部で `setToolRequestHandlers()` を遅延初期化し、最初のツール登録時に `tools/list` と `tools/call` ハンドラーを一括登録する（`packages/server/src/server/mcp.ts:125-224`）。

```typescript
// packages/server/src/server/mcp.ts:123-128
private _toolHandlersInitialized = false;

private setToolRequestHandlers() {
    if (this._toolHandlersInitialized) {
        return;
    }
    // ... ハンドラー登録
    this._toolHandlersInitialized = true;
}
```

この遅延初期化により、ツールを使わないサーバーでは tools capability が宣言されない。さらに `McpServer.server` プロパティ（public readonly）により、低レベル API への脱出ハッチを常に提供している。

### Pluggable バリデーションプロバイダー

`jsonSchemaValidator` インターフェース（`packages/core/src/validation/types.ts:51-59`）は `getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T>` の1メソッドのみ。2つの実装が提供される:

- `AjvJsonSchemaValidator`（`packages/core/src/validation/ajvProvider.ts:38`）: Node.js 向け。`new Function()` によるコード生成を使うため高速だが、Cloudflare Workers では動作しない
- `CfWorkerJsonSchemaValidator`（`packages/core/src/validation/cfWorkerProvider.ts:35`）: エッジランタイム向け。`@cfworker/json-schema` を使い、eval なしで動作する

デフォルトの選択は package.json の export conditions で行われる:

```typescript
// packages/server/src/shimsNode.ts
export { AjvJsonSchemaValidator as DefaultJsonSchemaValidator } from "@modelcontextprotocol/core";

// packages/server/src/shimsWorkerd.ts
export { CfWorkerJsonSchemaValidator as DefaultJsonSchemaValidator } from "@modelcontextprotocol/core";
```

Server/Client のコンストラクタでは `options?.jsonSchemaValidator ?? new DefaultJsonSchemaValidator()` とデフォルトを適用し、ユーザーによる差し替えも可能にしている。

### Context 型の段階的拡張

`BaseContext` → `ServerContext` → `CreateTaskServerContext` という型の段階的拡張パターンが使われている。

```typescript
// packages/core/src/shared/protocol.ts:265-324
type BaseContext = {
    sessionId?: string;
    mcpReq: { id: RequestId; method: string; signal: AbortSignal; send: ...; notify: ...; };
    http?: { authInfo?: AuthInfo; };
    task?: TaskContext;
};

type ServerContext = BaseContext & {
    mcpReq: { log: ...; elicitInput: ...; requestSampling: ...; };
    http?: { req?: RequestInfo; closeSSE?: () => void; };
};

type ClientContext = BaseContext;
```

`buildContext()` テンプレートメソッドで、Transport から渡される追加情報（HTTP リクエスト情報、認証情報）を Context に注入する。Client 側では `buildContext` は単にベースコンテキストを返すだけだが、Server 側では logging・elicitation・sampling のヘルパーメソッドを追加する。

### Middleware パイプライン

フェッチレイヤーの Middleware パターン（`packages/client/src/client/middleware.ts`）が定義されている:

```typescript
// packages/client/src/client/middleware.ts:10
type Middleware = (next: FetchLike) => FetchLike;
```

`withOAuth`・`withLogging` が組み込みミドルウェアとして提供され、`applyMiddlewares(...middleware)` で合成される。`createMiddleware` ヘルパーにより、クロージャのネストなしでカスタムミドルウェアを書ける。

### Completable パターン（Schema Decorator）

`completable()` 関数（`packages/server/src/server/completable.ts:52-60`）は、Symbol を使って Zod スキーマにメタデータを付与する独自パターン:

```typescript
// packages/server/src/server/completable.ts:52-60
export function completable<T extends AnySchema>(schema: T, complete: CompleteCallback<T>): CompletableSchema<T> {
  Object.defineProperty(schema as object, COMPLETABLE_SYMBOL, {
    value: { complete } as CompletableMeta<T>,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return schema as CompletableSchema<T>;
}
```

非列挙・不変のプロパティとして定義することで、JSON シリアライゼーションに影響せず、型情報を保持しながらランタイムメタデータを付加する。

## パターンカタログ

- **Template Method** (分類: 振る舞い)
  - 解決する問題: Protocol の共通メッセージ処理ロジックを重複なく共有しつつ、Server/Client 固有の capability チェックを分離する
  - 適用条件: アルゴリズムの骨格は共通で、特定のステップだけが異なる場合
  - コード例: `packages/core/src/shared/protocol.ts:392`（Protocol 抽象クラス）、`packages/core/src/shared/protocol.ts:628`（buildContext 抽象メソッド）、`packages/core/src/shared/protocol.ts:1002`（assertCapabilityForMethod 抽象メソッド）
  - 注意点: 抽象メソッドが5つあるため、サブクラスの実装負荷はやや高い

- **Facade** (分類: 構造)
  - 解決する問題: Protocol → Server という低レベル API を隠蔽し、ツール/プロンプト/リソースの登録という高レベル操作を提供する
  - 適用条件: 複雑なサブシステムに対して簡潔なインターフェースを提供したい場合
  - コード例: `packages/server/src/server/mcp.ts:66-70`（McpServer が Server をラップ）
  - 注意点: `McpServer.server` で低レベルアクセスを公開し、Facade が制約にならないよう設計されている

- **Strategy** (分類: 振る舞い)
  - 解決する問題: JSON Schema バリデーションの実装を実行環境に応じて差し替える
  - 適用条件: アルゴリズムのインターフェースは共通だが、実装が環境や要件で異なる場合
  - コード例: `packages/core/src/validation/types.ts:51`（jsonSchemaValidator インターフェース）、`packages/core/src/validation/ajvProvider.ts:38`・`packages/core/src/validation/cfWorkerProvider.ts:35`（2つの実装）
  - 注意点: デフォルト選択をビルド時の export conditions で行うのが独自

- **Chain of Responsibility** (分類: 振る舞い)
  - 解決する問題: HTTP リクエストに対して認証・ログ・カスタム処理を順序付きで適用する
  - 適用条件: リクエスト処理パイプラインに任意のハンドラーを挿入・合成したい場合
  - コード例: `packages/client/src/client/middleware.ts:10`（Middleware 型）、`packages/client/src/client/middleware.ts:249`（applyMiddlewares）

## Good Patterns

- **最小インターフェース + Static Factory による対テスト性**: InMemoryTransport は Transport インターフェースを実装しつつ `createLinkedPair()` で対になるトランスポートを生成する。インターフェースが最小であるがゆえに、テスト用モックの実装コストが極めて低い。

```typescript
// packages/core/src/util/inMemory.ts:25-31
static createLinkedPair(): [InMemoryTransport, InMemoryTransport] {
    const clientTransport = new InMemoryTransport();
    const serverTransport = new InMemoryTransport();
    clientTransport._otherTransport = serverTransport;
    serverTransport._otherTransport = clientTransport;
    return [clientTransport, serverTransport];
}
```

- **Capability ベースの段階的機能有効化**: McpServer はツール/プロンプト/リソースの最初の登録時にのみ対応する capability とハンドラーを登録する。ツールを登録しなければ tools capability は宣言されず、不要なリクエストハンドラーも存在しない。

```typescript
// packages/server/src/server/mcp.ts:836-838
this._registeredTools[name] = registeredTool;
this.setToolRequestHandlers(); // 初回のみ実行される遅延初期化
this.sendToolListChanged();
```

- **Export Conditions による環境別実装切り替え**: ランタイムの `if` 文ではなくバンドラーレベルで実装を切り替えることで、不要な依存関係がバンドルに含まれない。workerd 環境では Ajv（Node.js 依存）が読み込まれず、Node.js 環境では @cfworker/json-schema が読み込まれない。

```json
// packages/server/package.json:29-46
"./_shims": {
    "workerd": { "import": "./dist/shimsWorkerd.mjs" },
    "browser": { "import": "./dist/shimsWorkerd.mjs" },
    "node":    { "import": "./dist/shimsNode.mjs" },
    "default": { "import": "./dist/shimsNode.mjs" }
}
```

- **Escape Hatch 付き Facade**: McpServer は高レベル API を提供しつつ、`public readonly server: Server` で低レベルアクセスを公開する。通知の送信やカスタムリクエストハンドラーの設定など、Facade でカバーしきれない操作に対応できる。

## Anti-Patterns / 注意点

- **Callback 型プロパティの未設定リスク**: Transport のコールバック（`onclose`、`onerror`、`onmessage`）はオプショナルプロパティとして定義されており、Protocol の `connect()` 内で後から設定される。`start()` がコールバック設定前に呼ばれるとメッセージが失われる。ドキュメントで「start() は connect() が内部で呼ぶため手動で呼ばないこと」と注記されているが、コンパイル時には防げない。

```typescript
// Bad: コールバック未設定で start
const transport = new StdioServerTransport();
await transport.start(); // onmessage が未設定のためメッセージが消失する

// Better: Protocol.connect() 経由で使う（コールバック設定 → start の順序が保証される）
const server = new McpServer({ name: "test", version: "1.0" });
await server.connect(transport);
```

- **抽象メソッドの肥大化**: Protocol 抽象クラスが5つの抽象メソッドを要求するため、新しいサブクラスの実装負荷が高い。特に capability チェック系の4メソッドはロジックが似ており、データ駆動にできる可能性がある。

```typescript
// Bad: capability ごとに switch 文を手書き
protected assertCapabilityForMethod(method: RequestMethod): void {
    switch (method) {
        case 'sampling/createMessage': { /* ... */ }
        case 'elicitation/create': { /* ... */ }
        case 'roots/list': { /* ... */ }
        // ...新しいメソッドが追加されるたびに case を追加
    }
}

// Better: capability マッピングをデータとして定義
const CAPABILITY_MAP: Record<string, (caps: ClientCapabilities) => boolean> = {
    'sampling/createMessage': caps => !!caps.sampling,
    'elicitation/create': caps => !!caps.elicitation,
};
```

## 導出ルール

- `[MUST]` Transport やプラグインのインターフェースは、実装が必要とする最小のメソッド/コールバックのみを定義する（3-5メソッドが目安）
  - 根拠: MCP Transport は `start/send/close` + コールバック3つの計6要素で、stdio・HTTP・InMemory の3実装をすべてカバーしている（`packages/core/src/shared/transport.ts:74-134`）
- `[MUST]` プロトコル層の共通ロジック（メッセージルーティング、タイムアウト、相関管理）は抽象クラスに集約し、環境固有の差異は Template Method で解決する
  - 根拠: Protocol クラスが1700行のメッセージ処理ロジックを一元管理し、Server/Client はそれぞれ5つの抽象メソッドを実装するだけで済む（`packages/core/src/shared/protocol.ts:392`）
- `[SHOULD]` 高レベル API（Facade）を提供する場合、低レベル API への脱出ハッチ（public プロパティまたはメソッド）を用意する
  - 根拠: McpServer は `public readonly server: Server` で低レベルアクセスを公開し、通知送信やカスタムハンドラー登録を可能にしている（`packages/server/src/server/mcp.ts:69`）
- `[SHOULD]` プラットフォーム固有の実装差異はランタイム条件分岐ではなく、package.json の export conditions + shim ファイルでビルド時に解決する
  - 根拠: AjvJsonSchemaValidator と CfWorkerJsonSchemaValidator を export conditions で切り替え、不要な依存関係のバンドルを防いでいる（`packages/server/package.json:29-46`）
- `[SHOULD]` Capability/Feature のハンドラーは、最初の使用時に遅延登録する（宣言されていない capability を公開しないため）
  - 根拠: McpServer は最初のツール登録時に tools/list と tools/call のハンドラーを登録する。ツール未登録なら tools capability は宣言されない（`packages/server/src/server/mcp.ts:125-224`）
- `[SHOULD]` フェッチ/リクエスト処理パイプラインには `(next) => handler` 型のミドルウェアパターンを使い、関心事（認証・ログ・キャッシュ）を独立したモジュールに分離する
  - 根拠: `Middleware = (next: FetchLike) => FetchLike` 型と `applyMiddlewares()` 合成関数で、OAuth・ログなどを独立に実装・合成している（`packages/client/src/client/middleware.ts:10,249`）
- `[AVOID]` インターフェースのコールバックをオプショナルプロパティとして定義し、設定順序をドキュメントのみに依存させること。コールバック未設定でメソッドが呼ばれるとメッセージの消失やサイレントな不具合が生じる
  - 根拠: Transport の `onmessage?` はオプショナルであり、`start()` 前に設定する必要があるが、型システムでは強制されない（`packages/core/src/shared/transport.ts:117`）

## 適用チェックリスト

- [ ] プロトコル/通信層のインターフェースが最小か確認する（メソッド5つ以下が目安）
- [ ] 共通のメッセージ処理ロジックが複数の実装に重複していないか確認する（抽象クラスに集約できるか検討）
- [ ] 高レベル API（Facade/Wrapper）が低レベルへの脱出ハッチを提供しているか確認する
- [ ] プラットフォーム固有の実装切り替えがランタイム条件分岐ではなくビルド時解決になっているか確認する
- [ ] Capability や Feature の有効化が宣言的（設定/登録ベース）かつ遅延評価されているか確認する
- [ ] ミドルウェアパイプラインが `(next) => handler` 型で合成可能になっているか確認する
- [ ] オプショナルなコールバックプロパティに対して、設定順序の不整合が型レベルまたは実行時チェックで防がれているか確認する
