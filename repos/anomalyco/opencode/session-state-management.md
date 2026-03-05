# session-state-management

> リポジトリ: anomalyco/opencode
> 分析日: 2026-03-05

## 概要

セッション・メッセージ・TODO の状態がどのようにモデル化され、イベントバスを通じてリアクティブに UI へ伝搬されるかを分析した。opencode は SQLite を永続レイヤ、インメモリイベントバスをリアクティブ通知レイヤとし、「DB 書き込み → イベント発行 → クライアント反映」という一方向データフローを厳格に保つ設計を採用している。この設計は Zod による型安全なイベント定義、`Database.effect` によるトランザクション整合性、`AsyncLocalStorage` によるインスタンス分離を組み合わせた実践的なパターンであり、注目に値する。

## 背景にある原則

- **永続化とリアクティブ通知の責務分離**: 状態の真実の源泉は SQLite であり、イベントバスは通知チャネルに徹する。バスはキューイングもリプレイもしない。クライアントが再接続した場合は REST API で全状態を再取得する（`sync.tsx:349-427` の bootstrap パターン）。状態を二重管理せず、復旧を単純にするために、通知を「ベストエフォートのヒント」と割り切るべき。
- **トランザクション境界を超えた副作用の遅延実行**: DB 書き込みとイベント発行を同一トランザクション内で行うと、ロールバック時に発行済みイベントを取り消せない。`Database.effect` は副作用をトランザクション完了後に遅延させることで整合性を担保する（`db.ts:132-138`）。書き込みと通知のタイミングをずらすことで、中間状態の漏洩を防ぐべき。
- **型安全なイベント契約**: `BusEvent.define` は Zod スキーマでイベントペイロードを定義し、publish/subscribe の型安全性をコンパイル時に保証する。イベント名の文字列だけでなくペイロード構造もコンパイル時に検証することで、イベント駆動アーキテクチャの脆弱さ（型の不一致によるランタイムエラー）を解消すべき。
- **インスタンススコープの状態分離**: `Instance.state` + `AsyncLocalStorage` により、同一プロセス内で複数プロジェクトの状態を互いに干渉させずに管理する。グローバル変数を避け、コンテキストベースの状態スコーピングで多テナント安全性を確保すべき。

## 実例と分析

### 三層の状態モデル: Session → Message → Part

状態は Session > Message > Part の親子階層で構成される。SQL スキーマ（`session.sql.ts`）で `onDelete: "cascade"` を設定し、セッション削除時にメッセージとパーツが自動的に連鎖削除される。

```typescript
// packages/opencode/src/session/session.sql.ts:42-53
export const MessageTable = sqliteTable(
  "message",
  {
    id: text().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<InfoData>(),
  },
  (table) => [index("message_session_idx").on(table.session_id)],
);
```

注目すべきは、メッセージとパーツの構造化データが JSON カラム（`data`）に格納される点。ID とリレーション（`session_id`, `message_id`）はリレーショナルに、ドメイン固有のデータ（role、content、tool state 等）は JSON に分離する。これにより、スキーマ変更なしにドメインモデルを拡張でき、かつクエリに必要なフィールドはインデックス対象にできる。

### Database.effect: トランザクション後の副作用遅延

すべての状態変更関数が同じパターンに従う。DB 書き込み → `Database.effect` でイベント発行を登録 → トランザクション完了後に発行。

```typescript
// packages/opencode/src/storage/db.ts:118-138
export function use<T>(callback: (trx: TxOrDb) => T): T {
  try {
    return callback(ctx.use().tx);
  } catch (err) {
    if (err instanceof Context.NotFound) {
      const effects: (() => void | Promise<void>)[] = [];
      const result = ctx.provide({ effects, tx: Client() }, () => callback(Client()));
      for (const effect of effects) effect();
      return result;
    }
    throw err;
  }
}

export function effect(fn: () => any | Promise<any>) {
  try {
    ctx.use().effects.push(fn);
  } catch {
    fn();
  }
}
```

`Database.use` が自動的にコンテキストを作成し、コールバック内で登録されたすべての effect を完了後にフラッシュする。トランザクション版（`Database.transaction`）でも同じ仕組みが使われ、`Todo.update`（`todo.ts:28-43`）のように複数の DB 操作をアトミックに行った後でイベントを発行する。

### イベントバスの二層構造: Instance Bus + GlobalBus

```typescript
// packages/opencode/src/bus/index.ts:41-63
export async function publish<Definition extends BusEvent.Definition>(
  def: Definition,
  properties: z.output<Definition["properties"]>,
) {
  const payload = { type: def.type, properties };
  const pending = [];
  for (const key of [def.type, "*"]) {
    const match = state().subscriptions.get(key);
    for (const sub of match ?? []) {
      pending.push(sub(payload));
    }
  }
  GlobalBus.emit("event", {
    directory: Instance.directory,
    payload,
  });
  return Promise.all(pending);
}
```

`Bus` はインスタンス（プロジェクト）スコープの pub/sub で、`Instance.state` により分離される。同時に `GlobalBus`（Node.js EventEmitter）にも emit し、SSE 経由で外部クライアント（TUI）に伝搬する。この二層構造により、サーバー内部のモジュール間通信と外部クライアントへの通知を単一の `publish` 呼び出しで実現している。

### TUI 側の状態同期: SolidJS Store + イベントリデューサ

TUI（`sync.tsx`）は SolidJS の `createStore` でクライアント状態を管理し、SSE イベントをリデューサパターンで処理する。

```typescript
// packages/opencode/src/cli/cmd/tui/context/sync.tsx:107-118
sdk.event.listen((e) => {
  const event = e.details;
  switch (event.type) {
    case "session.updated": {
      const result = Binary.search(store.session, event.properties.info.id, (s) => s.id);
      if (result.found) {
        setStore("session", result.index, reconcile(event.properties.info));
        break;
      }
      // ...insert at sorted position
    }
  }
});
```

ソート済み配列 + 二分探索（`Binary.search`）で O(log n) のルックアップを行い、SolidJS の `reconcile` で最小限の差分更新を適用する。イベントから受け取ったデータを直接 store にマージすることで、「サーバーの状態 = クライアントの状態」を保つ。初期化は REST API で全状態を取得し（bootstrap）、以降はイベントで差分更新するハイブリッド方式。

### fn ユーティリティ: Zod バリデーション付き関数ラッパ

```typescript
// packages/opencode/src/util/fn.ts:3-11
export function fn<T extends z.ZodType, Result>(schema: T, cb: (input: z.infer<T>) => Result) {
  const result = (input: z.infer<T>) => {
    const parsed = schema.parse(input);
    return cb(parsed);
  };
  result.force = (input: z.infer<T>) => cb(input);
  result.schema = schema;
  return result;
}
```

Session/Message の CRUD 関数はすべてこの `fn` でラップされ、入力が Zod でバリデーションされる。`result.force` でバリデーションスキップも可能（内部呼び出し用）。`result.schema` でスキーマ自体にもアクセスでき、API ルートの自動生成等に利用できる。

### SessionStatus: インメモリのみのエフェメラル状態

```typescript
// packages/opencode/src/session/status.ts:44-75
const state = Instance.state(() => {
  const data: Record<string, Info> = {};
  return data;
});

export function set(sessionID: string, status: Info) {
  Bus.publish(Event.Status, { sessionID, status });
  if (status.type === "idle") {
    delete state()[sessionID];
    return;
  }
  state()[sessionID] = status;
}
```

セッションの稼働状態（idle/busy/retry）は DB に永続化せず、インメモリのみで管理する。プロセス再起動時はすべて idle に戻る。一時的な UI 表示用の状態を永続レイヤから分離する実例。

## パターンカタログ

- **Observer パターン** (分類: 振る舞い)
  - 解決する問題: 状態変更を複数の消費者に通知する必要がある
  - 適用条件: 発行者と購読者の疎結合が求められる場合
  - コード例: `bus/index.ts:41-63`（publish/subscribe）
  - 注意点: 型安全性が失われやすいため、Zod スキーマでペイロードを定義して補完している

- **Unit of Work パターン** (分類: エンタープライズ)
  - 解決する問題: DB 操作と副作用（イベント発行）の一貫性
  - 適用条件: トランザクション内で副作用をバッファリングし、コミット後に実行する必要がある場合
  - コード例: `storage/db.ts:118-138`（`Database.use` + `Database.effect`）
  - 注意点: effect のエラーハンドリングが呼び出し側に委ねられている

- **Discriminated Union パターン** (分類: 型システム)
  - 解決する問題: 複数のバリアント（ToolPart, TextPart, ReasoningPart 等）を型安全に扱う
  - 適用条件: 状態やメッセージが複数の種別を持つ場合
  - コード例: `message-v2.ts:377-394`（Part の discriminatedUnion）、`status.ts:8-22`（SessionStatus.Info）
  - 注意点: Zod の discriminatedUnion は判別フィールドが1つに限られる

## Good Patterns

- **DB 書き込みとイベント発行の分離（Database.effect パターン）**: トランザクション内で `Database.effect(() => Bus.publish(...))` を登録し、トランザクション完了後に実行する。ロールバック時にイベントが発行されることを防ぐ。Session の全 CRUD 関数がこのパターンに従う（`index.ts:276-288` 等、15箇所以上）。

- **Zod スキーマによるイベント契約定義**: `BusEvent.define("event.name", zodSchema)` で型とバリデーションスキーマを一箇所で定義。publish/subscribe の型推論が自動的に効き、レジストリからペイロードの discriminated union を自動生成できる（`bus-event.ts:21-42`）。

- **ソート済み配列 + 二分探索によるクライアント状態管理**: TUI の `sync.tsx` では `Binary.search` でソート済み配列に対して O(log n) のルックアップ・挿入を行い、SolidJS の `reconcile` で最小限の DOM 更新を実現する。Map ではなくソート済み配列を使うことで、SolidJS のリアクティビティシステムとの相性が良い。

- **エフェメラル状態と永続状態の明示的な分離**: `SessionStatus`（idle/busy/retry）はインメモリのみ、`Session.Info` は SQLite。UI に必要だが再起動後に不要な状態を永続化しないことで、DB スキーマの肥大化を防ぐ。

## Anti-Patterns / 注意点

- **イベント配信のベストエフォート性を忘れる**: イベントバスは at-most-once 配信であり、SSE 切断時にイベントを喪失する。opencode は bootstrap で全状態を再取得するが、この「再同期」機構を忘れると UI とサーバーの状態が乖離する。

```typescript
// Bad: イベントだけに依存
sdk.event.listen((e) => {
  // 接続断→再接続でイベントを取りこぼしても気づかない
  updateStore(e);
});

// Better: bootstrap + イベントのハイブリッド（sync.tsx の実装）
async function bootstrap() {
  const sessions = await sdk.client.session.list({ start });
  setStore("session", reconcile(sessions));
}
// + イベントリスナーで差分更新
```

- **Database.effect 内のエラーが握りつぶされるリスク**: `Database.effect` で登録した関数が例外を投げても、`Database.use` は返り値に影響しない。イベント発行の失敗が見えにくい。重要な副作用には明示的なエラーハンドリングを追加すべき。

## 導出ルール

- `[MUST]` DB 書き込みとイベント発行を同一トランザクション内で直接実行せず、副作用遅延機構（Database.effect 相当）でトランザクション完了後に発行する
  - 根拠: opencode の全 CRUD 関数が `Database.use` + `Database.effect` パターンを採用し、ロールバック時の不整合を防止している（`session/index.ts` 内に15箇所以上）

- `[MUST]` イベント駆動のクライアント状態同期では、初期化時に REST API で全状態を取得し、以降はイベントで差分更新するハイブリッド方式を採用する
  - 根拠: `sync.tsx:349-427` の bootstrap がセッション・設定・ステータスをまとめて取得し、以降は SSE イベントで差分反映する設計

- `[SHOULD]` イベントペイロードは Zod 等のスキーマライブラリで型定義し、publish/subscribe 双方の型安全性をコンパイル時に保証する
  - 根拠: `BusEvent.define` が40種以上のイベントすべてに Zod スキーマを適用し、型不整合をコンパイル時に検出している

- `[SHOULD]` UI 表示用の一時的な状態（稼働状態、リトライカウント等）は永続レイヤから分離し、インメモリで管理する
  - 根拠: `SessionStatus`（`status.ts`）は `Instance.state` でインメモリ管理し、プロセス再起動時は自動的に idle に戻る設計

- `[SHOULD]` 階層型エンティティ（親→子→孫）の削除は DB の `CASCADE` に委ね、アプリケーションコードで再実装しない
  - 根拠: `session.sql.ts` で Message・Part・Todo すべてに `onDelete: "cascade"` を設定し、Session 削除時の整合性を DB に委譲

- `[AVOID]` 同一プロセス内で複数テナント（プロジェクト）の状態をグローバル変数で管理する。`AsyncLocalStorage` 等のコンテキストベースのスコーピングを使うこと
  - 根拠: `Instance.state`（`project/state.ts`）が `AsyncLocalStorage` でプロジェクトごとの状態を分離し、グローバル汚染を防止

- `[AVOID]` イベントバスに状態のリプレイやキューイング機能を持たせる。バスは通知に徹し、状態の復旧は永続レイヤから行う
  - 根拠: `Bus` はインメモリの pub/sub のみ、再接続時は bootstrap で DB からリロードする設計（`sync.tsx:434-482` の `session.sync`）

## 適用チェックリスト

- [ ] DB 書き込みとイベント発行が同一トランザクション内で直接行われていないか確認する（副作用遅延の仕組みがあるか）
- [ ] イベントペイロードに型定義（Zod, io-ts, TypeBox 等）が適用されているか確認する
- [ ] クライアントの初期化時に REST API で全状態を取得し、以降はイベントで差分更新するハイブリッド方式になっているか確認する
- [ ] UI 用の一時的な状態（loading, busy 等）が永続レイヤに書き込まれていないか確認する
- [ ] 階層型エンティティの削除が DB の CASCADE で処理されているか確認する
- [ ] 同一プロセスで複数テナントを扱う場合、AsyncLocalStorage 等でコンテキストが分離されているか確認する
- [ ] イベントバスの配信保証レベル（at-most-once / at-least-once）を明示し、喪失時の復旧手段が用意されているか確認する
