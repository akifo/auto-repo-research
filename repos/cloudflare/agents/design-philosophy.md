# design-philosophy

> リポジトリ: cloudflare/agents
> 分析日: 2026-02-25

## 概要

Cloudflare Agents SDK の設計哲学を分析する。このリポジトリは Durable Objects をファーストクラスのプリミティブとして採用し、「ステートフルなエッジコンピューティング」を AI エージェントの実行基盤にするという独自のポジションを取っている。従来のステートレス FaaS の制約を Durable Objects の永続化能力で克服しつつ、WebSocket Hibernation によるコスト最適化、SQLite によるスケジュール/キュー/状態の永続化、そしてレイヤードアーキテクチャ（DurableObject -> Server -> Agent）による関心の分離が、コードベース全体を貫く設計原則として機能している。

## 背景にある原則

- **プラットフォームプリミティブの活用を最大化し、抽象の層を最小化する**: Agent クラスは DurableObject を直接拡張するのではなく partyserver の Server を経由するが、Cloudflare の KV/D1/R2/DO 等のプラットフォーム API をサードパーティの代替より優先する方針を明示している（`AGENTS.md`: "Use Cloudflare Workers APIs (KV, D1, R2, Durable Objects, etc.) over third-party equivalents"）。独自の抽象レイヤーを極力避け、プラットフォームの能力を薄いラッパーで開発者に渡す思想。

- **Hibernation を前提としたステート設計**: すべての重要な状態は SQLite に永続化し、インメモリ変数は信頼しない。スケジュール、キュー、MCP 接続設定、リトライ設定がすべて SQLite テーブルに格納される。`hibernate: true` がデフォルトであり（`src/index.ts:409`）、DO がいつ evict されても復元できることが暗黙の前提として全設計に影響している。

- **宣言的な API 設計と暗黙的な安全性**: readonly 接続の強制は `setState()` 内部で自動的に行われ、開発者がメソッドごとに権限チェックを書く必要がない（`design/readonly-connections.md`）。`@callable()` デコレータも TC39 標準に基づき、マーキングだけで RPC 公開が完了する。「安全なデフォルト + 必要時のオプトアウト」パターンが一貫している。

- **構造的安全性 > 振る舞い的安全性**: Gadgets 設計文書が明示するように、セキュリティを「モデルへの指示（振る舞い）」ではなく「アーキテクチャ上の制約（構造）」で担保する思想がある（`experimental/gadgets.md`: "make it impossible for the agent to do harmful things, regardless of what the LLM decides"）。Facet によるストレージ分離、Worker Loader による `globalOutbound: null`（ネットワーク遮断）など、能力ベースのセキュリティモデルを志向している。

## 実例と分析

### レイヤードアーキテクチャ: マトリョーシカ構造

Agent クラスは三層のマトリョーシカ構造で設計されている。各層は明確な責務を持ち、下位層のプリミティブを活用しつつ独自の付加価値を提供する。

- **Layer 0: DurableObject** — グローバルアドレッシング、WebSocket、alarm、SQLite ストレージ
- **Layer 1: partyserver Server** — WebSocket ライフサイクルコールバック（`onConnect`/`onMessage`/`onClose`）、URL ルーティング、`onStart` フック
- **Layer 2: Agent** — 状態永続化・同期、RPC（`@callable`）、スケジューリング、キュー、MCP クライアント、Email、Workflow

この構造により、Agent は DurableObject の低レベル API（`this.ctx.storage.sql`、`alarm()`）を直接隠蔽せず、開発者が必要時にアクセスできる。同時に `this.sql` テンプレートタグや `this.schedule()` のような高レベル API を提供し、一般的なユースケースを簡潔に書けるようにしている。

### SQLite を永続化の単一ソースにする

コンストラクタでの 5 つのテーブル作成（`src/index.ts:736-827`）が象徴するように、すべてのフレームワーク状態が SQLite に集約される。

```typescript
// src/index.ts:748-753
this.sql`
  CREATE TABLE IF NOT EXISTS cf_agents_state (
    id TEXT PRIMARY KEY NOT NULL,
    state TEXT
  )
`;
```

状態（`cf_agents_state`）、スケジュール（`cf_agents_schedules`）、キュー（`cf_agents_queues`）、MCP サーバー設定（`cf_agents_mcp_servers`）、Workflow 追跡（`cf_agents_workflows`）がすべて同一の SQLite データベースに存在する。これにより Hibernation 後の復元が統一的に処理でき、KV と SQL の使い分けに迷うことがない。

マイグレーション戦略も注目に値する。`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` パターンを `addColumnIfNotExists` ヘルパーで実装し、既存エージェントの無停止アップグレードを可能にしている（`src/index.ts:781-806`）。

### Hibernation ファーストの設計判断

Hibernation を前提とすることで、いくつかの重要な設計判断が導かれている。

1. **リトライ設定の DB 永続化**: `design/retries.md` で明示されているように、リトライオプションを SQLite の `retry_options TEXT` カラムに JSON として保存する。メモリに保持すると Hibernation で失われるため。
2. **接続状態のラッピング**: readonly フラグは `connection.state` の WebSocket attachment に `_cf_readonly` として保存し、Hibernation を越えて永続化する（`design/readonly-connections.md`）。
3. **keepAlive の schedule ベース実装**: `experimental/forever.md` で、`keepAlive()` が raw `alarm()` ではなく既存の `scheduleEvery()` API を使う理由として「スケジュールは SQLite に永続化されるため、eviction を自然に生き残る」を挙げている。
4. **`static options` のキャッシュ**: `_resolvedOptions` を初回アクセスで計算・キャッシュする（`src/index.ts:670-694`）。static options は DO ライフタイム中に変化しないため、毎回のマージを避ける。

### 双方向の状態同期プロトコル

状態更新はサーバー/クライアント間で同一のメッセージフォーマット（`MessageType.CF_AGENT_STATE`）を使用する。`_setStateInternal` は SQLite への永続化、全接続への broadcast、通知フック呼び出しを一箇所で行う（`src/index.ts:1216-1275`）。

```typescript
// src/index.ts:1282-1289
setState(state: State): void {
  const store = agentContext.getStore();
  if (store?.connection && this.isConnectionReadonly(store.connection)) {
    throw new Error("Connection is readonly");
  }
  this._setStateInternal(state, "server");
}
```

`setState()` と `_setStateInternal()` の分離は意図的で、アクセス制御（readonly チェック）とデータ整合性（`validateStateChange`）を異なるレイヤーに配置する設計判断を反映している。

### AsyncLocalStorage による透過的なコンテキスト伝搬

`getCurrentAgent()` を任意の場所から呼べるよう、`_autoWrapCustomMethods()` がユーザー定義メソッドを `AsyncLocalStorage` のコンテキスト内で自動実行する（`src/index.ts:1668`）。開発者はデコレータやパラメータ渡しなしで、現在の agent/connection/request にアクセスできる。

```typescript
// src/index.ts:478-503
export function getCurrentAgent<T extends Agent<Cloudflare.Env>>(): {
  agent: T | undefined;
  connection: Connection | undefined;
  request: Request | undefined;
  email: AgentEmail | undefined;
} { ... }
```

## パターンカタログ

- **Template Method** (分類: 振る舞い)
  - 解決する問題: フレームワークのライフサイクル管理と開発者コードのカスタマイズポイントの両立
  - 適用条件: Agent の `onStart`/`onConnect`/`onMessage`/`onStateChanged`/`validateStateChange` 等のフック群
  - コード例: `src/index.ts:1502`（`validateStateChange`）、`src/index.ts:1515`（`onStateChanged`）
  - 注意点: `validateStateChange` は同期必須、`onStateChanged` は非同期可だが broadcast 後に実行されるため gating には使えない

- **Decorator** (分類: 構造)
  - 解決する問題: メソッドのメタデータ付与と横断的関心事の宣言的適用
  - 適用条件: `@callable()` で WebSocket RPC 公開を宣言（TC39 standard decorators）
  - コード例: `src/index.ts:163-174`
  - 注意点: TypeScript の `experimentalDecorators` を有効にすると互換性が壊れる（TC39 標準とレガシーは別物）

- **Mixin** (分類: 構造)
  - 解決する問題: 基底クラスの機能を破壊せず横断的な機能を追加する
  - 適用条件: `withFibers(Agent)`, `withDurableChat(AIChatAgent)` 等の experimental 機能
  - コード例: `experimental/forever.md` のレイヤー設計
  - 注意点: Mixin は TypeScript の型推論と相性が悪い場合がある。SDK では experimental 段階でのみ使用

- **Capability-Based Security** (分類: アーキテクチャ)
  - 解決する問題: 信頼できないコードの実行環境におけるアクセス制御
  - 適用条件: Facets + Worker Loader による sandbox パターン（`experimental/gadgets.md`）
  - コード例: `experimental/gadgets.md` の `globalOutbound: null` + loopback binding パターン
  - 注意点: Cloudflare 実験的 API 依存。安定版 SDK には未統合

## Good Patterns

- **状態の二層分離（State vs SQL）**: ブロードキャスト対象のリアルタイム UI 状態は `this.state` に、大量データや履歴は `this.sql` に分離する。状態変更が全クライアントに broadcast されるため、state を小さく保つことでネットワーク帯域を節約する。

```typescript
// docs/state.md のベストプラクティス例
// State: リアルタイム UI 状態（小さく保つ）
initialState = {
  typing: [],
  unreadCount: 0,
  activeUsers: []
};

// SQL: 履歴データ（必要時にクエリ）
async getMessages(limit = 100) {
  return this.sql`
    SELECT * FROM messages
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
}
```

- **Eager Validation + Fail Fast**: リトライオプション等のパラメータを実行時ではなく登録時に検証する。`validateRetryOptions()` が `schedule()`/`queue()` 呼び出し時に即座にエラーを投げるため、数分後のアラーム実行時に初めて失敗する事態を防ぐ（`design/retries.md`）。

```typescript
// src/retries.ts の設計方針
// { baseDelayMs: 5000 } against default maxDelayMs: 3000 は
// schedule 登録時に即座に throw される（実行時ではない）
```

- **プロトコルメッセージの選択的送信**: `shouldSendProtocolMessages()` フックにより、バイナリ専用クライアント（MQTT デバイス等）に対してテキストフレームの送信を抑制できる。接続の種類に応じてプロトコルレベルの振る舞いを制御する（`src/index.ts:1076`）。

## Anti-Patterns / 注意点

- **Hibernation を考慮しないインメモリ状態**: クラスプロパティに重要な状態を保持すると、Hibernation で消失する。

```typescript
// Bad: Hibernation で失われる
class MyAgent extends Agent {
  private localCounter = 0;
  onMessage(connection: Connection, message: WSMessage) {
    this.localCounter++;
  }
}

// Better: SQLite に永続化される
class MyAgent extends Agent<Env, { counter: number; }> {
  initialState = { counter: 0 };
  onMessage(connection: Connection, message: WSMessage) {
    this.setState({ counter: this.state.counter + 1 });
  }
}
```

- **setState 前の副作用実行**: readonly チェックは `setState()` 内部で行われるため、それ以前の副作用（メール送信、課金処理）は readonly 接続でも実行されてしまう。

```typescript
// Bad: 副作用が先に実行される
@callable()
async processOrder(orderId: string) {
  await sendEmail(orderId);     // readonly でも実行される
  this.setState({ ... });       // ここで初めて throw
}

// Better: 状態変更を先に行い、副作用は成功後に実行
@callable()
async processOrder(orderId: string) {
  this.setState({ ... });       // readonly なら即座に throw
  await sendEmail(orderId);     // setState 成功時のみ実行
}
```

- **State への巨大データ格納**: `this.state` は変更のたびに全クライアントに broadcast されるため、メッセージ履歴のような成長するデータを格納すると帯域を圧迫する。大量データは SQL に保持し、state はメタデータ（件数、最終 ID 等）のみにすべき。

## 導出ルール

- `[MUST]` ステートフルなサーバーレス環境では、すべてのフレームワーク状態を永続ストレージ（SQLite/KV）に格納し、インメモリ変数を信頼しない
  - 根拠: Agents SDK はスケジュール・キュー・リトライ設定・MCP 接続・状態すべてを SQLite テーブルに永続化し、Hibernation/eviction からの復元を保証している（`src/index.ts:736-827`）

- `[MUST]` パラメータのバリデーションはタスク実行時ではなく登録時に行う（Eager Validation）
  - 根拠: `validateRetryOptions()` は `schedule()`/`queue()` 呼び出し時に即座にエラーを投げ、数分後の実行時に初めて失敗する事態を防いでいる（`design/retries.md`）

- `[SHOULD]` フレームワークのアクセス制御は、開発者が個別メソッドでチェックする方式ではなく、共通パスの単一ポイントで強制する
  - 根拠: readonly 強制を `setState()` 内部に配置することで、`@callable()` メソッドごとの権限チェック漏れを構造的に排除している（`design/readonly-connections.md`）

- `[SHOULD]` ブロードキャスト対象の共有状態と、クエリ対象の履歴データを明確に分離する（State vs SQL パターン）
  - 根拠: `this.state` は変更時に全 WebSocket クライアントへ broadcast されるため、大量データを含めるとネットワーク帯域を圧迫する（`docs/state.md` "Keep State Small"）

- `[SHOULD]` 内部フラグ用のキー名にはフレームワーク固有のプレフィックスを付け、ユーザーデータとの衝突を回避する
  - 根拠: `_cf_readonly` のように `_cf_` プレフィックスで名前空間を分離し、ユーザーが `{ _readonly: false }` を保存しても機能が壊れないようにしている（`design/readonly-connections.md`）

- `[SHOULD]` セキュリティを「モデルの振る舞い」ではなく「アーキテクチャの構造的制約」で担保する
  - 根拠: Gadgets 設計では `globalOutbound: null`（ネットワーク遮断）や Facet のストレージ分離で、LLM の判断に関わらず有害な操作を不可能にする設計を志向している（`experimental/gadgets.md`）

- `[AVOID]` 副作用を伴う処理で、アクセス制御チェックの前に不可逆な操作（外部 API 呼び出し、課金等）を実行する
  - 根拠: readonly チェックが `setState()` 内部で行われるため、それ以前の副作用は readonly 接続でも実行されてしまう。状態変更を先に行い失敗時に副作用をスキップする設計が推奨される（`design/readonly-connections.md` "Side effects in callables still run"）

- `[AVOID]` スキーママイグレーションで既存データを破壊する DDL を使う。`ADD COLUMN IF NOT EXISTS` パターンで既存エージェントの無停止アップグレードを保証する
  - 根拠: Agents SDK は `addColumnIfNotExists` ヘルパーで `ALTER TABLE` の失敗を `duplicate column` エラーのみ無視し、予期しないエラーは再 throw する安全なマイグレーション戦略を採用している（`src/index.ts:781-806`）

## 適用チェックリスト

- [ ] ステートフルサーバーレス環境で、フレームワーク/アプリの全重要状態が永続ストレージに格納されているか（インメモリ変数に依存していないか）
- [ ] タスク登録パラメータ（スケジュール、リトライ等）のバリデーションが登録時に行われているか（実行時に初めて失敗しないか）
- [ ] アクセス制御が個別メソッドの手動チェックではなく、共通パスの単一ポイントで強制されているか
- [ ] ブロードキャスト対象の状態とクエリ対象のデータが分離されているか（broadcast される state に大量データが含まれていないか）
- [ ] 内部フラグやメタデータのキー名がユーザーデータと衝突しない命名規則（プレフィックス等）を採用しているか
- [ ] 副作用を伴う処理で、権限チェックが不可逆な操作の前に実行されているか
- [ ] スキーママイグレーションが既存データを破壊せず、無停止で適用可能か
- [ ] セキュリティ上の制約がプロンプトや設定値ではなく、アーキテクチャレベル（ネットワーク遮断、ストレージ分離等）で担保されているか
