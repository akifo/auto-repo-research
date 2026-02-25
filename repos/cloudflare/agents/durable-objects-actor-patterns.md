# Durable Objects Actor パターン

> リポジトリ: cloudflare/agents
> 分析日: 2026-02-25

## 概要

cloudflare/agents は Cloudflare Durable Objects 上に Actor モデルを構築するフレームワークである。partyserver の `Server` クラスを継承した `Agent` クラスが、WebSocket Hibernation API を前提としたステートフルアクターの実装パターンを体系化している。特に注目に値するのは、SQLite をステート永続化とスケジューリングの唯一の真実源とし、Hibernation サイクルを超えた一貫性を確保する設計と、`AsyncLocalStorage` を使った暗黙的コンテキスト伝播による Actor 内メソッド呼び出しの透過性である。

## 背景にある原則

- **Hibernation-first 設計**: インメモリ状態は一時的なキャッシュであり、SQLite が常に真実源であるべき。Agent のデフォルトは `hibernate: true` であり（`src/index.ts:409`）、すべての永続データ（ステート、スケジュール、キュー、MCP 接続）は SQLite テーブルに書き込まれる。Hibernation 後のウェイクアップ時にインメモリ状態を再構築するのではなく、SQLite から読み直す設計により、ステート復元のバグを構造的に排除している。

- **境界での強制、内部での自由**: アクセス制御（readonly チェック）やコンテキスト伝播は、個別メソッドではなくフレームワーク境界（`setState()`, `onMessage`, `onConnect`）で強制すべき。`design/readonly-connections.md` に詳述されている通り、readonly チェックを `setState()` 内に置くことで、開発者がメソッドごとにチェックを書く必要をなくしている。

- **Single Writer 原則**: Actor インスタンスは単一の Durable Object に対応し、そのインスタンスだけがステートを変更できる。Cloudflare Workers ランタイムが DO インスタンスの一意性を保証し、`this.setState()` → SQLite 永続化 → WebSocket ブロードキャストという単方向フローで整合性を維持している。

- **透過的コンテキスト伝播**: `AsyncLocalStorage` でリクエスト・接続コンテキストを暗黙的に伝播させることで、ユーザーコードがコンテキストを引き回す必要をなくすべき。`_autoWrapCustomMethods`（`src/index.ts:1668-1724`）がユーザー定義メソッドを自動ラップし、`getCurrentAgent()` がどこからでもコンテキストを取得可能にしている。

## 実例と分析

### SQLite を Actor の永続化レイヤーとして活用する

Agent クラスのコンストラクタ（`src/index.ts:727-848`）で5つの SQLite テーブルを `CREATE TABLE IF NOT EXISTS` で初期化する。テーブル構成は以下の通り:

| テーブル                | 役割                   |
| ----------------------- | ---------------------- |
| `cf_agents_state`       | Actor のステート永続化 |
| `cf_agents_schedules`   | スケジュールタスク管理 |
| `cf_agents_queues`      | キュータスク管理       |
| `cf_agents_mcp_servers` | MCP サーバー接続情報   |
| `cf_agents_workflows`   | ワークフロー追跡       |

スキーマ変更は `ALTER TABLE ... ADD COLUMN` を `addColumnIfNotExists` パターンで安全に適用する（`src/index.ts:781-807`）。duplicate column エラーのみ無視し、予期しないエラーは再スローする。これにより、既存の DO インスタンスが新しいコードに更新されても、テーブルスキーマがインクリメンタルにマイグレーションされる。

### Hibernation を超えた接続状態の保持

WebSocket Hibernation では、DO がスリープ中も WebSocket 接続は維持される。ウェイクアップ時に新しい JavaScript オブジェクトが生成されるため、インメモリの `WeakMap` は失われる。この問題に対し、Agent は `_ensureConnectionWrapped` メソッド（`src/index.ts:1303-1391`）をべき等に設計している。

`_rawStateAccessors` WeakMap が空の場合（Hibernation 後）、最初の `onMessage` または `isConnectionReadonly` 呼び出しで自動的に再ラップが行われる。readonly フラグ自体は partyserver の `connection.setState()` で WebSocket アタッチメントとして永続化されるため、Hibernation を超えて保持される。

### Alarm API によるスケジューリングの抽象化

DO の Alarm API は「次の1回のアラーム」しか設定できない制約がある。Agent はこの制約を SQLite テーブルで抽象化し、複数のスケジュール（one-shot, delayed, cron, interval）を管理する:

1. スケジュール作成時: SQLite に行を挿入 → 最も近い実行時刻で `ctx.storage.setAlarm` を設定
2. Alarm 発火時: `time <= now` の全行を取得 → 各行のコールバックを実行 → cron/interval は次回時刻を更新、one-shot は削除 → 次のアラームを再設定

interval スケジュールでは、コールバックの重複実行を防ぐ `running` フラグと `execution_started_at` タイムスタンプで hung 検出を行う（`src/index.ts:2339-2357`）。

### connection.state の透過的ラッピング

フレームワーク内部のフラグ（`_cf_readonly`, `_cf_no_protocol`）をユーザーコードから隠蔽するため、`Object.defineProperty` で `connection.state` のゲッターと `connection.setState` を上書きする（`src/index.ts:1342-1391`）。`_cf_` プレフィクスで名前空間を分離し、ユーザーが偶然同名のキーを使うリスクを最小化している。

accessor プロパティ（partyserver の getter）とデータプロパティの両方に対応するため、`Object.getOwnPropertyDescriptor` で判定を行う。これにより `hibernate: false` や将来の接続実装でも安全に動作する。

## コード例

```typescript
// src/index.ts:596-651 — Lazy state initialization with SQLite fallback
get state(): State {
    if (this._state !== DEFAULT_STATE) {
      return this._state;
    }
    // check if the state was set in a previous life
    const wasChanged = this.sql<{ state: "true" | undefined }>`
        SELECT state FROM cf_agents_state WHERE id = ${STATE_WAS_CHANGED}
      `;
    const result = this.sql<{ state: State | undefined }>`
      SELECT state FROM cf_agents_state WHERE id = ${STATE_ROW_ID}
    `;
    if (wasChanged[0]?.state === "true" || result[0]?.state) {
      const state = result[0]?.state as string;
      try {
        this._state = JSON.parse(state);
      } catch (e) {
        console.error("Failed to parse stored state, falling back to initialState:", e);
        if (this.initialState !== DEFAULT_STATE) {
          this._state = this.initialState;
          this._setStateInternal(this.initialState);
        } else {
          this.sql`DELETE FROM cf_agents_state WHERE id = ${STATE_ROW_ID}`;
          this.sql`DELETE FROM cf_agents_state WHERE id = ${STATE_WAS_CHANGED}`;
          return undefined as State;
        }
      }
      return this._state;
    }
    // first time: persist initialState
    if (this.initialState === DEFAULT_STATE) {
      return undefined as State;
    }
    this._setStateInternal(this.initialState);
    return this.initialState;
  }
```

```typescript
// src/index.ts:2320-2471 — Alarm handler with schedule type dispatching
public readonly alarm = async () => {
    const now = Math.floor(Date.now() / 1000);
    const result = this.sql<Schedule<string> & { running?: number }>`
      SELECT * FROM cf_agents_schedules WHERE time <= ${now}
    `;
    if (result && Array.isArray(result)) {
      for (const row of result) {
        // Overlap prevention for interval schedules
        if (row.type === "interval" && row.running === 1) {
          const elapsedSeconds = now - (row.execution_started_at ?? 0);
          if (elapsedSeconds < this._resolvedOptions.hungScheduleTimeoutSeconds) {
            console.warn(`Skipping interval schedule ${row.id}: still running`);
            continue;
          }
        }
        // ... execute callback with retry ...
        if (row.type === "cron") {
          // Update next execution time
          const nextTimestamp = Math.floor(getNextCronTime(row.cron).getTime() / 1000);
          this.sql`UPDATE cf_agents_schedules SET time = ${nextTimestamp} WHERE id = ${row.id}`;
        } else if (row.type === "interval") {
          const nextTimestamp = Math.floor(Date.now() / 1000) + (row.intervalSeconds ?? 0);
          this.sql`UPDATE cf_agents_schedules SET running = 0, time = ${nextTimestamp} WHERE id = ${row.id}`;
        } else {
          this.sql`DELETE FROM cf_agents_schedules WHERE id = ${row.id}`;
        }
      }
    }
    await this._scheduleNextAlarm();
  };
```

```typescript
// src/index.ts:512-531 — AsyncLocalStorage context wrapping
function withAgentContext<T extends (...args: any[]) => any>(
  method: T,
): (...args: Parameters<T>) => ReturnType<T> {
  return function(...args: Parameters<T>): ReturnType<T> {
    const { connection, request, email, agent } = getCurrentAgent();
    if (agent === this) {
      return method.apply(this, args);
    }
    return agentContext.run({ agent: this, connection, request, email }, () => {
      return method.apply(this, args);
    });
  };
}
```

## パターンカタログ

- **Actor パターン** (分類: 並行性)
  - 解決する問題: 共有ステートへの並行アクセスの整合性確保
  - 適用条件: ステートフルなリアルタイム通信（ゲーム、チャット、コラボレーションツール）
  - コード例: `src/index.ts:553` — `Agent` クラスが Durable Object = Actor として振る舞う
  - 注意点: Actor の粒度設計が重要。粒度が粗すぎるとボトルネック、細かすぎると Actor 間通信のオーバーヘッド

- **Decorator パターン / Proxy パターン** (分類: 構造)
  - 解決する問題: フレームワーク内部フラグをユーザーコードから隠蔽しつつ、同じインターフェースを維持
  - 適用条件: ユーザーが直接操作するオブジェクトに、フレームワークレベルのメタデータを付加する場合
  - コード例: `src/index.ts:1303-1391` — `_ensureConnectionWrapped` が `connection.state` / `connection.setState` を透過的にラップ
  - 注意点: `Object.defineProperty` の `configurable: true` が前提。上流ライブラリの変更に依存する

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: ライフサイクルの骨格をフレームワークが定義し、個別ステップをユーザーが差し替え
  - 適用条件: `onConnect`, `onMessage`, `onStateChanged`, `shouldConnectionBeReadonly` 等のフック
  - コード例: `src/index.ts:1059-1123` — `onConnect` のラップで identity 送信 → ステート同期 → ユーザーコールバックの順序を保証
  - 注意点: フレームワークのラップ順序を理解せずにフックを実装すると、予期しない動作になる可能性がある

## Good Patterns

- **べき等な再初期化 (`_ensureConnectionWrapped`)**: Hibernation でインメモリキャッシュが消えた後の再構築を、「呼び出し側が再初期化の必要性を判断する」のではなく「初期化メソッド自体がべき等」にすることで安全性を担保している。WeakMap に既にエントリがあれば即座に返る。

```typescript
// src/index.ts:1303-1304
private _ensureConnectionWrapped(connection: Connection) {
    if (this._rawStateAccessors.has(connection)) return;
    // ... wrapping logic ...
}
```

- **Lazy state initialization with corruption recovery**: ステートの初回アクセス時に SQLite から読み込み、JSON パースに失敗した場合は `initialState` にフォールバックする。破損データを放置せず、修復して再永続化する。`initialState` が未定義の場合は破損データを削除して `undefined` を返す。

```typescript
// src/index.ts:620-637
try {
  this._state = JSON.parse(state);
} catch (e) {
  console.error("Failed to parse stored state, falling back to initialState:", e);
  if (this.initialState !== DEFAULT_STATE) {
    this._state = this.initialState;
    this._setStateInternal(this.initialState); // 修復して永続化
  } else {
    this.sql`DELETE FROM cf_agents_state WHERE id = ${STATE_ROW_ID}`;
    return undefined as State;
  }
}
```

- **Validation と Notification の分離**: `validateStateChange`（同期・ゲーティング）と `onStateChanged`（非同期・通知）を分離することで、バリデーション失敗時はステート変更を完全にブロックし、通知フックの失敗はステート永続化やブロードキャストに影響しない設計。

```typescript
// src/index.ts:1216-1275 — _setStateInternal
this.validateStateChange(nextState, source);   // throws to reject
this._state = nextState;
this.sql`INSERT OR REPLACE INTO cf_agents_state ...`; // persist
this._broadcastProtocol(...);                   // broadcast
this.ctx.waitUntil((async () => {
    await this._callStatePersistenceHook(nextState, source); // non-gating notification
})());
```

## Anti-Patterns / 注意点

- **Readonly 接続での副作用先行**: `setState()` でのチェックという設計上、callable メソッド内で `setState()` より前に副作用（外部 API 呼び出し、メール送信等）を実行すると、readonly 接続でも副作用が実行されてしまう。

```typescript
// Bad: 副作用が先に実行される
@callable()
async processOrder(orderId: string) {
  await sendEmail(orderId);      // runs even for readonly
  this.setState({ ... });        // throws — but damage is done
}

// Better: ステート変更を先に行う
@callable()
async processOrder(orderId: string) {
  this.setState({ ... });        // throws immediately for readonly
  await sendEmail(orderId);      // only runs if setState succeeded
}
```

- **インメモリ状態への依存**: Hibernation で失われるインメモリ変数にビジネスロジック上重要なデータを保持すると、ウェイクアップ後に不整合が発生する。テストエージェント（`tests/agents/schedule.ts`）の `intervalCallbackCount` のようなカウンタはテスト用途では許容されるが、本番コードでは SQLite に永続化すべきである。

```typescript
// Bad: Hibernation で消える
intervalCallbackCount = 0;
intervalCallback() {
    this.intervalCallbackCount++;  // lost after hibernation
}

// Better: SQLite で永続化
intervalCallback() {
    this.sql`UPDATE cf_agents_counters SET count = count + 1 WHERE key = 'interval'`;
}
```

## 導出ルール

- `[MUST]` Hibernation 環境のステートフルサービスでは、すべてのビジネスデータを永続ストレージ（SQLite/KV）に書き込み、インメモリ状態はキャッシュとして扱う
  - 根拠: Agent の `state` getter は常に SQLite から読み直す設計（`src/index.ts:596-651`）。Hibernation でインメモリ状態が消えても、SQLite が真実源であるため整合性が保たれる

- `[MUST]` フレームワークレベルのアクセス制御は、個別ハンドラではなく共通の境界点（ミドルウェア、基底クラスの公開メソッド）で強制する
  - 根拠: readonly チェックを `setState()` 内に集約することで、開発者がメソッドごとにチェックを忘れるリスクを排除している（`design/readonly-connections.md` "Why D"）

- `[SHOULD]` 再初期化が必要なメソッドはべき等に設計し、呼び出し側が「初期化済みかどうか」を判断する責務を持たないようにする
  - 根拠: `_ensureConnectionWrapped` は WeakMap チェックで二重初期化を防止し、Hibernation 後の最初のメッセージで透過的に再ラップを行う（`src/index.ts:1303-1304`）

- `[SHOULD]` 単一のタイマー/アラーム API で複数のスケジュールを管理する場合、永続ストレージにスケジュール一覧を保持し、「最も近い次回実行時刻」だけを実際のタイマーに設定する
  - 根拠: DO Alarm API は1つしかアラームを設定できないが、`cf_agents_schedules` テーブルと `_scheduleNextAlarm()` の組み合わせで任意数のスケジュールを管理している（`src/index.ts:2296-2310`）

- `[SHOULD]` バリデーション（ゲーティング）と通知（ノンブロッキング）のフックを分離し、通知フックの失敗がコアフローに影響しないようにする
  - 根拠: `validateStateChange` の例外はステート変更を完全にブロックするが、`onStateChanged` の例外は `waitUntil` 内で捕捉されステートやブロードキャストに影響しない（`src/index.ts:1216-1275`）

- `[SHOULD]` フレームワーク内部のメタデータをユーザーが操作するオブジェクトに格納する場合、名前空間付きプレフィクス（例: `_cf_`）を使い、ゲッター/セッターのラップでユーザーから隠蔽する
  - 根拠: `_cf_readonly` は `_ensureConnectionWrapped` で透過的にフィルタされ、ユーザーが `connection.state` を読んでも見えない。`_readonly` ではなく `_cf_` プレフィクスにすることで偶然の衝突を回避している（`design/readonly-connections.md`）

- `[AVOID]` ステートフルアクターでステート変更を伴うメソッドの前に、取り消し不能な副作用（外部 API 呼び出し、メール送信等）を配置すること
  - 根拠: readonly チェックが `setState()` 時点で行われるため、それ以前の副作用はチェックをすり抜ける（`design/readonly-connections.md` "Caveats"）

- `[AVOID]` スキーママイグレーションでテーブルの再作成や `DROP COLUMN` を使うこと。`ADD COLUMN IF NOT EXISTS` のインクリメンタルなマイグレーションを使う
  - 根拠: 既存 DO インスタンスのデータを破壊せずにスキーマを進化させるため、`addColumnIfNotExists` パターンで duplicate column エラーのみ無視する設計を採用している（`src/index.ts:781-807`）

## 適用チェックリスト

- [ ] ステートフルサービスの全ビジネスデータが永続ストレージに書き込まれているか（インメモリ変数に依存していないか）
- [ ] インメモリキャッシュは常に永続ストレージから再構築可能か
- [ ] 再初期化メソッド（接続ラップ、セッション復元等）がべき等に設計されているか
- [ ] アクセス制御チェックが個別ハンドラではなく共通境界に集約されているか
- [ ] バリデーションフック（ゲーティング）と通知フック（ノンブロッキング）が分離されているか
- [ ] ステート変更メソッド内で、変更の前に取り消し不能な副作用が配置されていないか
- [ ] スキーママイグレーションがインクリメンタルで、既存データを破壊しないか
- [ ] タイマー/スケジューラが永続ストレージでスケジュール一覧を管理し、プラットフォーム制約（単一アラーム等）を抽象化しているか
- [ ] フレームワーク内部メタデータがユーザー操作するオブジェクトと名前空間で分離されているか
