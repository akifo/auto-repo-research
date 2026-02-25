# architecture

> リポジトリ: cloudflare/agents
> 分析日: 2026-02-25

## 概要

cloudflare/agents は Cloudflare Durable Objects 上にステートフル AI エージェントを構築するフレームワークである。partyserver の `Server` クラスを継承した `Agent` 基底クラスが中核にあり、その上に状態同期・RPC・スケジューリング・SQL・MCP・Email・Workflow といったサブシステムが積層される。サーバー側（Agent クラス + McpAgent 派生）とクライアント側（AgentClient + useAgent React hook）の二面構造を持ち、WebSocket プロトコルメッセージで自動的に接続・同期される設計が注目に値する。

## 背景にある原則

- **基盤委譲と機能積層の分離**: Agent は partyserver の Server を継承してDO ライフサイクル・WebSocket hibernation・コネクション管理を委譲し、自身は「ドメイン機能の積層」に専念する。基盤の再発明を避けつつ、継承一段で全サブシステムを統合できる。(`packages/agents/src/index.ts:553-557` — `Agent extends Server`)
- **単一オブジェクトへのサブシステム集約**: スケジューリング・キュー・ワークフロー追跡・MCP接続・状態管理をすべて1つの Durable Object インスタンス内の SQLite テーブルとして統合する。外部データベースや別サービスへの依存を排除し、DO の単一ライター保証を活用して整合性を担保する。(`packages/agents/src/index.ts:736-827` — constructor 内テーブル作成)
- **プロトコル層の透過的注入**: onConnect / onMessage をコンストラクタで wrap し、identity 送信・state 同期・RPC ディスパッチ・readonly 制御をユーザーコードに見せずに処理する。開発者はビジネスロジックだけに集中でき、プロトコル層を意識しなくてよい。(`packages/agents/src/index.ts:896-1057` — onRequest/onMessage/onConnect wrap)
- **AsyncLocalStorage による暗黙コンテキスト伝播**: `agentContext` (AsyncLocalStorage) で agent / connection / request / email のコンテキストを伝播させ、`getCurrentAgent()` というグローバルアクセサを提供する。ユーザー定義メソッドは自動ラップされるため、コンテキスト引き回しのボイラープレートが不要になる。(`packages/agents/src/internal_context.ts:33-34`, `packages/agents/src/index.ts:1668-1724`)

## 実例と分析

### partyserver 継承による基盤委譲

Agent クラスの宣言は `class Agent<Env, State, Props> extends Server<Env, Props>` で、partyserver が提供する DO ライフサイクル管理（`onStart`, `onConnect`, `onClose`, `onRequest`）、WebSocket hibernation、`getConnections()` / `broadcast()` といったプリミティブをそのまま利用する。ルーティングも `routeAgentRequest` が内部で `routePartykitRequest` を呼ぶだけの薄いラッパーである。

```ts
// packages/agents/src/index.ts:4278-4287
export async function routeAgentRequest<Env>(
  request: Request,
  env: Env,
  options?: AgentOptions<Env>,
) {
  return routePartykitRequest(request, env as Record<string, unknown>, {
    prefix: "agents",
    ...(options as PartyServerOptions<Record<string, unknown>>),
  });
}
```

この「継承一段 + prefix 差し替え」で Agent 固有のURLスキーム `/agents/<class>/<name>` を実現している。

### SQLite テーブルによるサブシステム積層

Agent コンストラクタ内で5つの SQLite テーブルを `CREATE TABLE IF NOT EXISTS` で宣言的に初期化する:

| テーブル                | 用途                                   |
| ----------------------- | -------------------------------------- |
| `cf_agents_state`       | エージェント状態の永続化               |
| `cf_agents_schedules`   | cron / interval / delayed スケジュール |
| `cf_agents_queues`      | タスクキュー                           |
| `cf_agents_mcp_servers` | MCP サーバー接続情報                   |
| `cf_agents_workflows`   | ワークフロー追跡レコード               |

```ts
// packages/agents/src/index.ts:764-777
this.sql`
  CREATE TABLE IF NOT EXISTS cf_agents_schedules (
    id TEXT PRIMARY KEY NOT NULL DEFAULT (randomblob(9)),
    callback TEXT,
    payload TEXT,
    type TEXT NOT NULL CHECK(type IN ('scheduled', 'delayed', 'cron', 'interval')),
    time INTEGER,
    delayInSeconds INTEGER,
    cron TEXT,
    intervalSeconds INTEGER,
    running INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch())
  )
`;
```

マイグレーションは `ALTER TABLE ... ADD COLUMN` を try-catch で wrap し、`duplicate column` エラーを無視するパターンで処理する（`packages/agents/src/index.ts:781-806`）。

### コンストラクタでのメソッドインターセプト

Agent コンストラクタは partyserver の `onRequest` / `onMessage` / `onConnect` / `onStart` を bind してから再定義し、プロトコル処理を注入する:

```ts
// packages/agents/src/index.ts:896-914
const _onRequest = this.onRequest.bind(this);
this.onRequest = (request: Request) => {
  return agentContext.run(
    { agent: this, connection: undefined, request, email: undefined },
    async () => {
      await this.mcp.ensureJsonSchema();
      const oauthResponse = await this.handleMcpOAuthCallback(request);
      if (oauthResponse) {
        return oauthResponse;
      }
      return this._tryCatch(() => _onRequest(request));
    },
  );
};
```

各フックで `agentContext.run()` を呼ぶことで、ハンドラ内のすべての非同期処理で `getCurrentAgent()` が動作する。

### サーバー/クライアント二面構造

サーバー側の `Agent` クラスとクライアント側の `AgentClient` が WebSocket 上の定型プロトコル（`MessageType` enum で定義される6種のメッセージ型）で通信する:

```ts
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

`AgentClient` は `PartySocket` を継承して自動再接続を得つつ、RPC 呼び出し（`call()` メソッド）、状態同期（`setState()`）、identity 検証（`ready` Promise）を追加する。React 向けには `useAgent` hook が同じプロトコルを内部で処理する。

### MCP の二重構造: サーバー側とクライアント側

MCP 統合は2つの独立した軸を持つ:

1. **McpAgent（MCP サーバーとして振る舞う）**: `Agent` を継承し、`abstract server` と `abstract init()` を持つ。SSE / Streamable HTTP / RPC の3つのトランスポートを `getTransportType()` で切り替える。名前規約 `sse:<sessionId>` で DO インスタンスを分離する。
2. **MCPClientManager（外部 MCP サーバーに接続する）**: Agent が `this.mcp` フィールドとして保持する。`addMcpServer()` で外部 MCP サーバーを登録し、`getAITools()` で AI SDK 互換のツールセットに変換する。

```ts
// packages/agents/src/index.ts:838-842
this.mcp = new MCPClientManager(this._ParentClass.name, "0.0.1", {
  storage: this.ctx.storage,
  createAuthProvider: (callbackUrl) => this.createMcpOAuthProvider(callbackUrl),
});
```

### 接続ステートの隠蔽と readonly 制御

接続の `state` プロパティは `_ensureConnectionWrapped()` で `Object.defineProperty` を使い、内部フラグ（`_cf_readonly`, `_cf_no_protocol`）をユーザーコードから隠蔽する:

```ts
// packages/agents/src/index.ts:1342-1352
Object.defineProperty(connection, "state", {
  configurable: true,
  enumerable: true,
  get() {
    const raw = getRaw();
    if (raw != null && typeof raw === "object" && rawHasInternalKeys(raw)) {
      return stripInternalKeys(raw);
    }
    return raw;
  },
});
```

`setState` もオーバーライドされ、ユーザーが設定した状態と内部フラグが自動的にマージされる。

## パターンカタログ

- **Template Method** (分類: 振る舞い)
  - 解決する問題: 基底クラスがプロトコル処理の骨格を定義し、サブクラスがビジネスロジック（`onConnect`, `onMessage`, `onRequest`）だけをオーバーライドする
  - 適用条件: フレームワーク基底クラスで、共通処理とカスタム処理を分離したい場合
  - コード例: `packages/agents/src/index.ts:896-1147` (constructor での wrap chain)
  - 注意点: bind + 再定義のパターンは、super 呼び出しの順序に注意が必要

- **Mixin** (分類: 構造)
  - 解決する問題: 基底クラスを変更せずに機能を追加する
  - 適用条件: 実験的機能やオプショナルな機能を分離して提供したい場合
  - コード例: `packages/agents/src/experimental/forever.ts:19` (`withFibers(Agent)`)
  - 注意点: TypeScript の mixin 型制約と IDE 補完の整合性を保つ工夫が必要

- **Mediator** (分類: 振る舞い)
  - 解決する問題: Agent が MCP サーバー接続・ワークフロー・スケジューリング間の調停役として機能する
  - 適用条件: 複数の非同期サブシステムが相互に通信する必要がある場合
  - コード例: `packages/agents/src/index.ts:844-856` (MCP 状態変更 → broadcast 連携)

## Good Patterns

- **宣言的テーブル初期化 + 冪等マイグレーション**: コンストラクタで `CREATE TABLE IF NOT EXISTS` と `ALTER TABLE ADD COLUMN`（duplicate 無視）を組み合わせ、どのバージョンの Agent が起動しても正しいスキーマが得られる。外部マイグレーションツール不要で、DO の「いつインスタンスが再作成されるか分からない」特性に適合する。

```ts
// packages/agents/src/index.ts:781-791
const addColumnIfNotExists = (sql: string) => {
  try {
    this.ctx.storage.sql.exec(sql);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (!message.toLowerCase().includes("duplicate column")) {
      throw e;
    }
  }
};
```

- **AsyncLocalStorage による透過的コンテキスト注入 + 自動メソッドラップ**: `_autoWrapCustomMethods()` がユーザー定義メソッドを自動検出し、`withAgentContext()` でラップする。デコレータや明示的引数なしに `getCurrentAgent()` が動作する。base クラスのメソッド・private メソッド・getter はスキップされ、callable メタデータも保持される。

```ts
// packages/agents/src/index.ts:1704-1718
const wrappedFunction = withAgentContext(
  this[methodName as keyof this] as (...args: any[]) => any,
) as any;
if (this._isCallable(methodName)) {
  callableMetadata.set(
    wrappedFunction,
    callableMetadata.get(this[methodName as keyof this] as Function)!,
  );
}
this.constructor.prototype[methodName as keyof this] = wrappedFunction;
```

- **`static options` による設定の段階的オーバーライド**: 基底クラスがデフォルト値を定義し、サブクラスは変更したいフィールドだけを `static options` で宣言する。実行時に一度だけマージ・キャッシュされる。

```ts
// packages/agents/src/index.ts:656-695
static options: AgentStaticOptions = { hibernate: true };
private get _resolvedOptions(): ResolvedAgentOptions {
  if (this._cachedOptions) return this._cachedOptions;
  const ctor = this.constructor as typeof Agent;
  this._cachedOptions = {
    hibernate: ctor.options?.hibernate ?? DEFAULT_AGENT_STATIC_OPTIONS.hibernate,
    // ...
  };
  return this._cachedOptions;
}
```

## Anti-Patterns / 注意点

- **巨大単一ファイル**: `index.ts` が約4500行に達しており、Agent クラス・ルーティング関数・型定義・ヘルパーが混在している。機能の発見性が低く、変更時の影響範囲が把握しにくい。

```ts
// Bad: 1ファイルに Agent クラス + routeAgentRequest + routeAgentEmail +
//      getAgentByName + StreamingResponse + 全型定義
// packages/agents/src/index.ts (4527行)
```

```ts
// Better: 関心ごとにファイル分割
// agent.ts          — Agent クラス本体
// routing.ts        — routeAgentRequest, routeAgentEmail
// streaming.ts      — StreamingResponse
// types/index.ts    — 型定義
```

- **コンストラクタでのメソッド上書き**: `this.onMessage = async (...) => { ... }` パターンはデバッグ時にスタックトレースが不明瞭になり、IDE の定義ジャンプが実際の実装にたどり着けない場合がある。Proxy や middleware chain のような明示的パターンのほうが追跡性が高い。

## 導出ルール

- `[MUST]` ステートフルオブジェクトのスキーマ変更は冪等マイグレーション（CREATE IF NOT EXISTS + ALTER ADD COLUMN with duplicate 無視）で行う — DO やサーバーレスでは「どのバージョンのコードがインスタンスを起動するか」が不確定なため
  - 根拠: `packages/agents/src/index.ts:736-806` でコンストラクタ内に宣言的マイグレーションを配置し、バージョン不整合を防止している
- `[MUST]` フレームワーク基底クラスの内部フラグはユーザーコードから隠蔽し、`setState` 時にも自動保持する — ユーザーが誤って内部状態を上書きすることを構造的に防ぐ
  - 根拠: `packages/agents/src/index.ts:1303-1391` で `Object.defineProperty` により `_cf_readonly` / `_cf_no_protocol` をユーザーから隠蔽している
- `[SHOULD]` 複数のサブシステム（スケジューリング・キュー・状態管理など）を統合する場合、単一ストレージ内のテーブル分離で整合性を保つ — 外部依存を排除しつつ、単一ライター保証の恩恵を受けられる
  - 根拠: Agent は5つの SQLite テーブルを1つの DO Storage 内に共存させ、トランザクション的な整合性を得ている
- `[SHOULD]` 基盤ライブラリの継承は一段に留め、機能追加は composition（フィールド注入）または mixin で行う — 継承チェーンが深くなると理解コストが指数的に増加する
  - 根拠: Agent → Server の一段継承に留め、MCP は `this.mcp` (MCPClientManager) として composition、Fiber は `withFibers()` mixin で提供している
- `[SHOULD]` WebSocket プロトコルメッセージは enum で型安全に定義し、サーバー/クライアント双方で共有する — 文字列リテラルの散在はプロトコル変更時の追従漏れを招く
  - 根拠: `packages/agents/src/types.ts` の `MessageType` enum がサーバー (`index.ts`) とクライアント (`client.ts`, `react.tsx`) の両方で import されている
- `[SHOULD]` AsyncLocalStorage でリクエストコンテキストを伝播する場合、ユーザー定義メソッドを自動ラップして注入漏れを防ぐ — 手動ラップは漏れが発生しやすい
  - 根拠: `_autoWrapCustomMethods()` がプロトタイプチェーンを走査し、base メソッドを除くすべてのカスタムメソッドを自動ラップしている (`packages/agents/src/index.ts:1668-1724`)
- `[AVOID]` 単一ファイルに4000行超のコードを詰め込む — 関心分離の欠如はレビュー・テスト・リファクタリングのすべてを困難にする
  - 根拠: `packages/agents/src/index.ts` は4527行あり、Agent クラス・ルーティング・型定義・ヘルパーが混在している

## 適用チェックリスト

- [ ] 基盤ライブラリを継承する場合、継承は一段に留め、追加機能は composition または mixin で提供しているか
- [ ] ステートフルオブジェクトのスキーマ変更を冪等マイグレーション（IF NOT EXISTS + duplicate 無視）で処理しているか
- [ ] 内部フラグ・メタデータがユーザー向け API から隠蔽されており、`setState` 等で誤って上書きされない構造になっているか
- [ ] サーバー/クライアント間のプロトコルメッセージ型が共有モジュールで定義され、双方から参照されているか
- [ ] AsyncLocalStorage 等のコンテキスト伝播機構を使う場合、ユーザー定義コードへの注入漏れがないか（自動ラップまたは linter ルールで担保）
- [ ] 単一ファイルが肥大化していないか（目安: 400行、上限: 800行）
- [ ] 複数のサブシステムを統合する場合、外部依存を最小化し、単一ストレージ内で整合性を保てる設計になっているか
