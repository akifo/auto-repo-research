# storage-patterns

> リポジトリ: anomalyco/opencode
> 分析日: 2026-03-05

## 概要

opencode の永続化層を分析する。このプロジェクトは JSON ファイルベースのストレージから SQLite（Drizzle ORM）への段階的移行を完遂しており、デュアルストレージ戦略・スキーマ分散配置・ビルド時マイグレーション埋め込み・AsyncLocalStorage によるトランザクション伝播など、CLI ツールの永続化層として注目すべきプラクティスが多数存在する。特に「既存ユーザーのデータを壊さずにストレージエンジンを切り替える」ための JSON→SQLite 一括マイグレーション設計が実践的価値が高い。

## 背景にある原則

- **スキーマはドメインに帰属させる**: スキーマ定義（`*.sql.ts`）を各ドメインモジュール内に配置し、中央の `schema.ts` は re-export のみ行う。スキーマ変更がドメインロジックと同じディレクトリで完結するため、変更の影響範囲が明確になる（`storage/schema.ts:1-6` が全テーブルを re-export）。
- **暗黙的コンテキストでトランザクション境界を宣言的にする**: AsyncLocalStorage を用いてトランザクションを暗黙的に伝播させ、呼び出し側が `tx` パラメータを引き回す必要をなくす。これにより、ビジネスロジック層がストレージの実装詳細から分離される（`storage/db.ts:113-154`）。
- **マイグレーションは実行環境に適応させる**: 開発時はファイルシステムから、本番ビルドではバイナリに埋め込んだマイグレーションを使う。CLI ツールは単一バイナリ配布が理想であり、外部ファイル依存を排除する（`storage/db.ts:88-98`, `script/build.ts:29-50`）。
- **ストレージエンジン移行は段階的かつ冪等に行う**: JSON→SQLite マイグレーションは DB ファイルの存在チェックで一度だけ実行され、`onConflictDoNothing` で冪等性を担保する。ユーザーデータの安全性を最優先にした設計（`index.ts:91-118`, `json-migration.ts:100`）。

## 実例と分析

### スキーマ分散配置パターン

Drizzle ORM のスキーマ定義を各ドメインディレクトリに `*.sql.ts` として配置している。

```typescript
// storage/schema.ts:1-6
export { WorkspaceTable } from "../control-plane/workspace.sql";
export { ControlAccountTable } from "../control/control.sql";
export { ProjectTable } from "../project/project.sql";
export { MessageTable, PartTable, PermissionTable, SessionTable, TodoTable } from "../session/session.sql";
export { SessionShareTable } from "../share/share.sql";
```

`drizzle.config.ts` では `schema: "./src/**/*.sql.ts"` と glob パターンで全スキーマを収集する。この設計により、新しいドメインモジュールを追加する際にスキーマファイルを同じディレクトリに置くだけで自動的にマイグレーション生成の対象になる。

### 共通カラム定義の再利用

`schema.sql.ts` で `Timestamps` オブジェクトを定義し、スプレッド構文で全テーブルに適用している。

```typescript
// storage/schema.sql.ts:1-10
export const Timestamps = {
  time_created: integer()
    .notNull()
    .$default(() => Date.now()),
  time_updated: integer()
    .notNull()
    .$onUpdate(() => Date.now()),
};
```

各テーブルでは `...Timestamps` で展開する（`session/session.sql.ts:49`, `project/project.sql.ts` 等）。Drizzle の `$default` / `$onUpdate` コールバックにより、アプリケーション層でタイムスタンプ管理を意識する必要がない。

### AsyncLocalStorage によるトランザクション伝播

`Database.use` と `Database.transaction` は AsyncLocalStorage コンテキストを使い、トランザクションを暗黙的に伝播させる。

```typescript
// storage/db.ts:118-130
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
```

コンテキスト外で呼ばれた場合は自動的に新しいコネクションを提供し、既存トランザクション内で呼ばれた場合はそのトランザクションを再利用する。呼び出し側のコード（例: `session/index.ts:314`）は `Database.use((db) => { ... })` と書くだけでよく、トランザクションの有無を気にしない。

### Database.effect パターン

トランザクション内でのイベント発行を、コミット後に遅延実行する仕組み。

```typescript
// storage/db.ts:132-138
export function effect(fn: () => any | Promise<any>) {
  try {
    ctx.use().effects.push(fn);
  } catch {
    fn();
  }
}
```

使用例では `Database.effect(() => Bus.publish(Event.Updated, { info }))` のように、DB 書き込みとイベント発行をセットで記述しつつ、イベントはトランザクション完了後に発火する（`session/index.ts:287`）。トランザクションがロールバックされた場合、イベントは発行されない。

### SQLite PRAGMA チューニング

DB 接続時に6つの PRAGMA を設定している。

```typescript
// storage/db.ts:78-83
sqlite.run("PRAGMA journal_mode = WAL");
sqlite.run("PRAGMA synchronous = NORMAL");
sqlite.run("PRAGMA busy_timeout = 5000");
sqlite.run("PRAGMA cache_size = -64000");
sqlite.run("PRAGMA foreign_keys = ON");
sqlite.run("PRAGMA wal_checkpoint(PASSIVE)");
```

WAL モードで読み書きの並行性を確保し、`synchronous = NORMAL` で書き込み性能を向上させている。バルクインサート時（`json-migration.ts:49-51`）はさらに `synchronous = OFF` と `temp_store = MEMORY` を追加設定し、安全性より速度を優先する。

### ビルド時マイグレーション埋め込み

`script/build.ts` でマイグレーション SQL をビルド時に読み込み、`define` で定数としてバイナリに埋め込む。

```typescript
// script/build.ts:189
OPENCODE_MIGRATIONS: JSON.stringify(migrations),
```

ランタイムでは `typeof OPENCODE_MIGRATIONS !== "undefined"` で分岐し、バンドル済みならそれを使い、開発時はファイルシステムから読む（`storage/db.ts:88-91`）。CLI ツールの単一バイナリ配布において、マイグレーションファイルの配置場所を気にする必要がなくなる。

### JSON→SQLite 一括マイグレーション

旧 JSON ストレージから SQLite への移行を、初回起動時に自動実行する。

```typescript
// index.ts:91-102
const marker = path.join(Global.Path.data, "opencode.db")
if (!(await Filesystem.exists(marker))) {
  // ... progress bar 表示
  await JsonMigration.run(Database.Client().$client, {
    progress: (event) => { ... }
  })
}
```

マイグレーション処理自体は単一トランザクション（`json-migration.ts:149`, `403`）で実行し、FK 依存順序（project → session → message → part → todo → permission → share）を守ってバッチ挿入する。`onConflictDoNothing` で冪等性を確保し、エラーは収集するが処理を止めない設計。

### JSON ストレージの Read/Write ロック

旧 JSON ストレージ層は `using` 構文を活用した RWLock で並行アクセスを制御している。

```typescript
// storage/storage.ts:168-172
export async function read<T>(key: string[]) {
  const dir = await state().then((x) => x.dir);
  const target = path.join(dir, ...key) + ".json";
  return withErrorHandling(async () => {
    using _ = await Lock.read(target);
    const result = await Filesystem.readJson<T>(target);
    return result as T;
  });
}
```

`Lock` 実装（`util/lock.ts`）はライター優先の RWLock で、`Symbol.dispose` を使った RAII パターンでロック解放を保証する。

### JSON カラムによる半構造化データの格納

頻繁に検索・フィルタリングされるフィールドは正規カラムに、それ以外は `text({ mode: "json" }).$type<T>()` で JSON カラムに格納する。

```typescript
// session/session.sql.ts:50
data: text({ mode: "json" }).notNull().$type<InfoData>(),
```

`MessageTable` と `PartTable` は `id` / `session_id` / タイムスタンプのみを正規カラムに持ち、残りの可変データは `data` JSON カラムに押し込んでいる。スキーマの安定性を保ちつつ、データ構造の進化に対応できる。

## パターンカタログ

- **Unit of Work** (振る舞い)
  - 解決する問題: トランザクション内の複数の DB 操作とそれに伴う副作用（イベント発行）の整合性
  - 適用条件: DB 書き込みと連動するイベント・通知がある場合
  - コード例: `storage/db.ts:140-154`（`transaction` + `effect`）
  - 注意点: `effect` はトランザクション外で呼ばれると即時実行されるため、呼び出し元がコンテキストを意識する必要がある

- **Repository** (構造)
  - 解決する問題: ストレージ実装の詳細をドメインロジックから隠蔽する
  - 適用条件: 永続化層の差し替え可能性を確保したい場合
  - コード例: `storage/storage.ts` の `read`/`write`/`update`/`list` がキーベース API を提供
  - 注意点: JSON ストレージと SQLite の二重構造が残存しており、一部データ（session_diff）は依然 JSON ストレージに保存される

## Good Patterns

- **スキーマの co-location**: スキーマ定義（`*.sql.ts`）をドメインモジュールと同じディレクトリに配置する。`drizzle.config.ts` の glob パターン `./src/**/*.sql.ts` で自動収集されるため、中央のスキーマファイルを肥大化させない。新機能追加時にスキーマとロジックが同じ PR で完結する。

- **トランザクション後エフェクト**: `Database.effect` でイベント発行をトランザクション完了後に遅延実行する。ロールバック時にイベントが発火しないことを構造的に保証できる。

```typescript
// session/index.ts:314-320
Database.use((db) => {
  db.insert(SessionTable).values(toRow(result)).run();
  Database.effect(() => Bus.publish(Event.Created, { info: result }));
});
```

- **バルクインサート時の PRAGMA 切り替え**: 通常運用時は `synchronous = NORMAL` だが、一括マイグレーション時は `synchronous = OFF` + `temp_store = MEMORY` に切り替えて書き込み速度を最大化する（`json-migration.ts:49-51`）。単一トランザクションで囲むことでデータ整合性は維持する。

- **using 構文による RAII ロック管理**: `Lock.read` / `Lock.write` が `Disposable` を返し、`using` で自動解放する。ロック解放忘れを構造的に防止する（`storage/storage.ts:169`, `util/lock.ts:47-71`）。

## Anti-Patterns / 注意点

- **マイグレーション内の `any` 型の多用**: `json-migration.ts` ではほぼ全てのデータを `any` として扱っている。旧データの形状が不定であるため実用上は仕方ないが、マイグレーション専用の型定義（少なくとも必須フィールドの型ガード）を設けるとランタイムエラーを減らせる。

```typescript
// Bad: json-migration.ts:97
function insert(values: any[], table: any, label: string) { ... }

// Better:
interface MigrationRecord { [key: string]: unknown }
function insert<T extends MigrationRecord>(values: T[], table: SQLiteTable, label: string) { ... }
```

- **デュアルストレージの残存**: SQLite 移行後も `Storage.read` / `Storage.write` が `session_diff` データに使われている（`session/summary.ts:93`, `session/index.ts:511`）。2つの永続化メカニズムが共存すると、バックアップ・リストア・デバッグの複雑さが増す。

## 導出ルール

- `[MUST]` SQLite を使う場合、接続時に WAL モード・busy_timeout・foreign_keys を PRAGMA で設定する
  - 根拠: opencode は6つの PRAGMA を接続直後に設定し、並行読み書き性能と外部キー制約を確保している（`storage/db.ts:78-83`）

- `[MUST]` ストレージエンジンの移行時は FK 依存順序に従ってデータを投入し、`onConflictDoNothing` で冪等性を担保する
  - 根拠: `json-migration.ts` は project → session → message → part の順序を厳守し、再実行可能な設計にしている

- `[SHOULD]` ORM のスキーマ定義はドメインモジュールと co-locate し、glob パターンで収集する
  - 根拠: `*.sql.ts` を各ドメインディレクトリに配置し `drizzle.config.ts` の `schema: "./src/**/*.sql.ts"` で自動収集する設計により、中央スキーマファイルの肥大化を防いでいる

- `[SHOULD]` トランザクション内の副作用（イベント発行・通知等）はコミット後に遅延実行する仕組みを設ける
  - 根拠: `Database.effect` パターンにより、ロールバック時にイベントが発火しないことを構造的に保証している（`storage/db.ts:132-138`）

- `[SHOULD]` CLI ツールのバイナリ配布時は、マイグレーション SQL をビルド時にバンドルして外部ファイル依存を排除する
  - 根拠: `define` による定数埋め込みと `typeof` ガードによる分岐で、開発時とプロダクション時のマイグレーション読み込みを透過的に切り替えている（`storage/db.ts:88-98`）

- `[SHOULD]` 頻繁にクエリされるフィールドは正規カラムに、可変の半構造化データは JSON カラムに分離する
  - 根拠: `MessageTable` は `id` / `session_id` / タイムスタンプを正規カラムに、残りを `data` JSON カラムに格納し、検索性能とスキーマ柔軟性を両立している（`session/session.sql.ts:42-53`）

- `[AVOID]` 永続化メカニズムを複数残存させること。移行が完了したら旧ストレージへの依存を完全に除去する
  - 根拠: `session_diff` データが SQLite 移行後も JSON ストレージ（`Storage.read/write`）に残っており、バックアップ・運用の複雑さが増している

## 適用チェックリスト

- [ ] SQLite 接続時に WAL モード・busy_timeout・foreign_keys・cache_size の PRAGMA を設定しているか
- [ ] バルクインサート処理では通常と異なる PRAGMA（synchronous = OFF 等）を一時的に適用しているか
- [ ] ORM スキーマ定義がドメインモジュールと同じディレクトリに配置されているか
- [ ] 共通カラム（timestamps 等）がスプレッド構文で再利用可能な形に抽出されているか
- [ ] トランザクション内の副作用（イベント発行）がコミット後に実行される仕組みがあるか
- [ ] CLI バイナリにマイグレーション SQL がバンドルされ、外部ファイルに依存していないか
- [ ] ストレージエンジン移行時にデータ投入順序が FK 制約を満たしているか
- [ ] JSON カラムと正規カラムの使い分け基準が明確に定義されているか
