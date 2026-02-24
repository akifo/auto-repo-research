# database-patterns

> リポジトリ: promptfoo/promptfoo
> 分析日: 2026-02-21

## 概要

CLI ツール向けの SQLite ローカルストレージ設計を分析する。promptfoo は Drizzle ORM + better-sqlite3 によるシングルファイル DB、ファイルシステムベースのキャッシュ、コンテンツアドレス方式の Blob ストレージという三層の永続化アーキテクチャを採用している。ユーザーのホームディレクトリ (`~/.promptfoo/`) に全データを集約し、サーバーレスで動作するローカルファーストの CLI に適した設計パターンが随所に見られる。特に WAL モード設定、グレースフルシャットダウン、キャッシュマイグレーション、バイナリデータの外部化戦略が注目に値する。

## 背景にある原則

- **ローカルファースト・ゼロ設定**: ユーザーに DB サーバーの構築を要求せず、`~/.promptfoo/promptfoo.db` に SQLite ファイルを自動生成する。テスト時は `:memory:` に切り替えることで環境依存を排除する。CLI ツールにおいて初回実行のハードルを下げることが採用率に直結するため。(`src/database/index.ts:31-32`)
- **構造化データと Blob の分離**: 評価結果のメタデータは SQLite に、バイナリデータ（音声・画像）はファイルシステムに保存し、SHA-256 ハッシュで紐付ける。SQLite に大きな BLOB を格納するとパフォーマンスとバックアップ性が劣化するため、参照テーブル (`blob_references`) で関連を管理する。(`src/blobs/index.ts:57-104`)
- **環境変数によるフォールバック設計**: WAL モード無効化 (`PROMPTFOO_DISABLE_WAL_MODE`)、キャッシュ無効化 (`PROMPTFOO_CACHE_ENABLED`)、インラインメディア (`PROMPTFOO_INLINE_MEDIA`) など、主要機能に環境変数の脱出口を設ける。ネットワークファイルシステムやコンテナ環境で WAL が使えないケースを想定している。(`src/database/index.ts:40-69`)
- **マイグレーションの自動実行とサンセット**: アプリ起動時に Drizzle のマイグレーションを自動実行し、キャッシュフォーマットの移行にはサンセット日付を設けて、一定期間後にマイグレーションコード自体を削除可能にする。長期メンテナンスコストの抑制と、クリーンスタートの許容。(`src/cacheMigration.ts:16-24`)

## 実例と分析

### シングルトン DB 接続と WAL モード設定

DB 接続はモジュールレベルの変数で Singleton として管理される。初回 `getDb()` 呼び出し時にのみ接続を確立し、WAL モード・foreign_keys・synchronous 設定を行う。

```typescript
// src/database/index.ts:18-77
let dbInstance: ReturnType<typeof drizzle> | null = null;
let sqliteInstance: Database.Database | null = null;

export function getDb() {
  if (!dbInstance) {
    const isMemoryDb = getEnvBool("IS_TESTING");
    const dbPath = isMemoryDb ? ":memory:" : getDbPath();
    sqliteInstance = new Database(dbPath);
    sqliteInstance.pragma("foreign_keys = ON");

    if (!isMemoryDb && !getEnvBool("PROMPTFOO_DISABLE_WAL_MODE", false)) {
      sqliteInstance.pragma("journal_mode = WAL");
      // WAL 設定の検証と追加チューニング
      sqliteInstance.pragma("wal_autocheckpoint = 1000");
      sqliteInstance.pragma("synchronous = NORMAL");
    }
    // ...
  }
  return dbInstance;
}
```

WAL 設定後にその結果を検証し、失敗時には具体的な環境（ネットワーク FS、コンテナ）を示す警告メッセージを出す点が実践的。

### グレースフルシャットダウンと WAL チェックポイント

DB クローズ時に WAL ファイルを TRUNCATE モードでチェックポイントし、`.db-wal` ファイルにデータが残らないようにする。`finally` ブロックでインスタンス参照を null にリセットすることで、エラー時でも壊れた接続の再利用を防ぐ。

```typescript
// src/database/index.ts:79-103
export function closeDb() {
  if (sqliteInstance) {
    try {
      if (!getEnvBool("IS_TESTING") && !getEnvBool("PROMPTFOO_DISABLE_WAL_MODE", false)) {
        sqliteInstance.pragma("wal_checkpoint(TRUNCATE)");
      }
      sqliteInstance.close();
    } catch (err) {
      logger.error(`Error closing database connection: ${err}`);
    } finally {
      sqliteInstance = null;
      dbInstance = null;
    }
  }
}
```

CLI 全体のシャットダウンでは、3 秒のハードタイムアウト付きで各リソースを解放する (`src/main.ts:262-337`)。

### トランザクションによるアトミックな複数テーブル操作

Eval の作成・削除では Drizzle の `db.transaction()` で複数テーブルへの INSERT/DELETE をアトミックに実行する。特に削除時は外部キーの制約を考慮し、関連テーブルから先に削除する。

```typescript
// src/models/eval.ts:1340-1347
async delete() {
  const db = getDb();
  db.transaction(() => {
    db.delete(evalsToDatasetsTable).where(eq(evalsToDatasetsTable.evalId, this.id)).run();
    db.delete(evalsToPromptsTable).where(eq(evalsToPromptsTable.evalId, this.id)).run();
    db.delete(evalsToTagsTable).where(eq(evalsToTagsTable.evalId, this.id)).run();
    db.delete(evalResultsTable).where(eq(evalResultsTable.evalId, this.id)).run();
    db.delete(evalsTable).where(eq(evalsTable.id, this.id)).run();
  });
}
```

### JSON カラムの型安全な定義と json_extract インデックス

Drizzle の `text('column', { mode: 'json' }).$type<T>()` でカラムレベルの型安全性を確保しつつ、SQLite の `json_extract` 関数を使ったインデックスを定義して JSON 内部のクエリを高速化する。

```typescript
// src/database/tables.ts:131-154
gradingResultReasonIdx: index('eval_result_grading_result_reason_idx').on(
  sql`json_extract(${table.gradingResult}, '$.reason')`,
),
testCaseVarsIdx: index('eval_result_test_case_vars_idx').on(
  sql`json_extract(${table.testCase}, '$.vars')`,
),
metadataPluginIdIdx: index('eval_result_metadata_plugin_id_idx').on(
  sql`json_extract(${table.metadata}, '$.pluginId')`,
),
```

### コンテンツアドレス方式の Blob ストレージ

バイナリデータは SHA-256 ハッシュをキーとしてファイルシステムに保存する。同一コンテンツの重複保存を防ぎ（deduplication）、DB にはハッシュ・サイズ・MIME タイプのメタデータのみを記録する。Git のオブジェクトストレージと同様に、ハッシュの先頭 2+2 文字でサブディレクトリを分割する。

```typescript
// src/blobs/filesystemProvider.ts:68-74
private hashToPath(hash: string): string {
  this.assertValidHash(hash);
  const dirRelative = path.join(hash.slice(0, 2), hash.slice(2, 4));
  const fileRelative = path.join(dirRelative, hash);
  return this.resolvePathInBase(fileRelative);
}
```

DB 書き込みとファイルシステム書き込みの一貫性は、トランザクション内で DB 挿入を行い、失敗時にはファイルをロールバック削除する手法で担保される。

```typescript
// src/blobs/index.ts:59-102
db.transaction(() => {
  db.insert(blobAssetsTable).values({...}).onConflictDoNothing().run();
  refContext?.evalId && db.insert(blobReferencesTable).values({...}).run();
  return refInsert ?? assetInsert;
});
// catch: provider.deleteByHash(result.ref.hash) でロールバック
```

### キャッシュマイグレーションの堅牢なパターン

キャッシュライブラリの更新（cache-manager v4 -> v7）に伴うデータ形式の移行を、ファイルロック・バックアップ・アトミック書き込み・検証・サンセット日付の 5 層で保護する。

```typescript
// src/cacheMigration.ts:16-17
const MIGRATION_SUNSET_DATE = new Date("2026-04-01T00:00:00Z");
// TODO(2026-04-01): Remove this migration code after sunset date.
```

アトミック書き込みでは一時ファイルに書き込んでから `rename` する。`rename` はファイルシステムレベルでアトミックなため、書き込み途中のファイルが読み取られることがない。

```typescript
// src/cacheMigration.ts:437-453
const tempFile = path.join(dir, `.cache.${randomBytes(8).toString("hex")}.tmp`);
fs.writeFileSync(tempFile, serialized, "utf-8");
fs.renameSync(tempFile, newCachePath); // アトミックリネーム
validateCacheFile(newCachePath, entries.size); // 書き込み後の検証
```

### ファイルベースのシグナル通知

DB の変更を WebSocket 等を使わずにプロセス間で通知するため、`evalLastWritten` というシグナルファイルを `fs.watch` で監視する。デバウンス付きで過剰な通知を抑制する。

```typescript
// src/database/signal.ts:70-84
export function setupSignalWatcher(onChange: () => void): fs.FSWatcher {
  ensureSignalFile();
  const watcher = fs.watch(filePath);
  watcher.on("change", debounce(onChange, 250));
  return watcher;
}
```

### パスのトラバーサル防御

ファイルシステムベースのストレージでは、`path.resolve` で正規化した後に `basePath + sep` のプレフィクスチェックを行い、ディレクトリトラバーサルを防止する。

```typescript
// src/storage/localFileSystemProvider.ts:114-125
private getFilePath(key: string): string {
  const targetPath = path.resolve(this.basePath, key);
  const safeBase = path.resolve(this.basePath) + path.sep;
  if (!targetPath.startsWith(safeBase)) {
    throw new Error(`Invalid media key: path traversal attempt detected ("${key}")`);
  }
  return targetPath;
}
```

## パターンカタログ

- **Singleton** (生成)
  - 解決する問題: DB 接続の多重生成によるリソース浪費と WAL 設定の不整合
  - 適用条件: プロセス内で単一の DB 接続を共有する CLI / サーバーアプリ
  - コード例: `src/database/index.ts:18-77`
  - 注意点: テスト時はインスタンスのリセット (`closeDb` で null 化) が必要

- **Content-Addressable Storage** (構造)
  - 解決する問題: バイナリデータの重複保存とデータ整合性の検証
  - 適用条件: 同一コンテンツが繰り返し保存される可能性がある場合
  - コード例: `src/blobs/filesystemProvider.ts:88-123`
  - 注意点: ハッシュ衝突（SHA-256 では事実上ゼロ）とガベージコレクション

- **Strategy / Provider** (振る舞い)
  - 解決する問題: ストレージバックエンド（ローカル FS / S3 / GCS）の切り替え
  - 適用条件: OSS 版とクラウド版で実装を差し替える必要がある場合
  - コード例: `src/storage/types.ts:85-131`, `src/blobs/types.ts:33-40`
  - 注意点: OSS ではデフォルトプロバイダをハードコードし、クラウド側で `setProvider` を呼ぶ設計

## Good Patterns

- **環境に応じた段階的フォールバック**: WAL モード設定で「試行 -> 検証 -> 失敗時警告 + デフォルトモード継続」の 3 段階フォールバック。ユーザーに問題を通知しつつ、アプリは動作を継続する。`src/database/index.ts:41-70`

- **サンセット日付付きマイグレーション**: マイグレーションコードに期限を設け、期限後はスキップする設計。レガシーコードの自然削除を可能にし、新規ユーザーにはクリーンスタートを提供する。`src/cacheMigration.ts:16-24`

- **バッチ処理によるメモリ制御**: 大量の結果コピーを 1000 件ずつバッチ処理し、メモリ枯渇を防止する。`src/models/eval.ts:1460-1502`

- **SQL インジェクション防御と JSON パス安全化**: `sql.raw()` を使わざるを得ない `json_extract` のパス引数に対して、JSON パスエスケープ + SQL シングルクォートエスケープの二重防御を適用する。`src/models/eval.ts:128-146`

## Anti-Patterns / 注意点

- **トランザクションなしの複数テーブル操作**: `src/util/database.ts:33-166` の `writeResultsToDatabase` では `Promise.all` で複数テーブルへの INSERT を並列実行しているが、トランザクションで囲っていない。途中で失敗すると部分的な書き込みが残る。

```typescript
// Bad: src/util/database.ts:42-163
const promises = [];
promises.push(db.insert(evalsTable).values({...}).run());
// ... 複数の INSERT を push
await Promise.all(promises);
```

```typescript
// Better: トランザクションで囲む（src/models/eval.ts:511-599 のように）
db.transaction(() => {
  db.insert(evalsTable).values({...}).run();
  db.insert(promptsTable).values({...}).onConflictDoNothing().run();
  // ...
});
```

- **循環参照のランタイム検出**: `sanitizeForDb` で `safeJsonStringify` を使って循環参照を実行時に除去している。根本的には、DB に保存するオブジェクトに非シリアライズ可能な値（AbortSignal、Timeout）が混入しないよう型レベルで制約すべき。`src/models/evalResult.ts:74-96`

## 導出ルール

- `[MUST]` SQLite で WAL モードを有効にする場合、PRAGMA の結果を検証し、失敗時はデフォルトモードにフォールバックしてアプリケーションを継続させる
  - 根拠: ネットワーク FS やコンテナ環境では WAL が有効にならないケースがあり、promptfoo は検証 + 警告 + 継続のパターンで対処している (`src/database/index.ts:46-58`)

- `[MUST]` ファイルシステムベースのストレージでユーザー入力をパスに含める場合、`path.resolve` 後に `basePath + path.sep` のプレフィクスチェックでディレクトリトラバーサルを防止する
  - 根拠: Blob ストレージとメディアストレージの両方で同一パターンが適用されている (`src/blobs/filesystemProvider.ts:55-66`, `src/storage/localFileSystemProvider.ts:114-125`)

- `[MUST]` 複数テーブルへの INSERT/DELETE をアトミックに行う場合はトランザクションで囲む。特に削除時は外部キー制約を持つ子テーブルから先に削除する
  - 根拠: Eval の create/delete/copy 全てでトランザクションが使われている (`src/models/eval.ts:511-599, 1340-1347, 1380-1503`)

- `[SHOULD]` ローカルファースト CLI のデータベース接続は Singleton で管理し、クローズ時に `finally` ブロックで参照を null リセットして壊れた接続の再利用を防ぐ
  - 根拠: `closeDb` の `finally` ブロックが接続障害時のリカバリを保証している (`src/database/index.ts:98-101`)

- `[SHOULD]` バイナリデータはリレーショナル DB に直接格納せず、コンテンツハッシュをキーにファイルシステムに外部化し、DB には参照メタデータのみ保持する
  - 根拠: Blob ストレージは SHA-256 ハッシュで deduplication しつつ、DB にはハッシュ・サイズ・MIME タイプのみ記録している (`src/blobs/filesystemProvider.ts:88-123`)

- `[SHOULD]` SQLite の JSON カラムに頻繁にクエリするフィールドがある場合、`json_extract` を使った計算インデックスを定義する
  - 根拠: `eval_results` テーブルで `pluginId`, `strategyId`, `reason`, `comment`, `vars` など多数の JSON 抽出インデックスが定義されている (`src/database/tables.ts:131-154`)

- `[SHOULD]` データフォーマットのマイグレーションにはサンセット日付を設定し、期限後は新規キャッシュで開始する設計にする。マイグレーションコードの長期蓄積を防ぐ
  - 根拠: キャッシュマイグレーションに `MIGRATION_SUNSET_DATE` が設定され、TODO コメントで削除時期が明示されている (`src/cacheMigration.ts:16-17`)

- `[SHOULD]` ファイル書き込みでデータ破損を防ぐには、一時ファイルに書き込んでから `rename` でアトミックに置換し、書き込み後にファイル内容を検証する
  - 根拠: キャッシュマイグレーションで temp ファイル -> rename -> validate の 3 ステップが実装されている (`src/cacheMigration.ts:437-458`)

- `[AVOID]` 複数テーブルへの書き込みを `Promise.all` で並列実行してトランザクションで囲まない。部分的な書き込みが残り、データの整合性が壊れる
  - 根拠: `writeResultsToDatabase` ではトランザクションなしの `Promise.all` が使われているが、新しい `Eval.create` ではトランザクションに修正されている (`src/util/database.ts:42-163` vs `src/models/eval.ts:511-599`)

## 適用チェックリスト

- [ ] SQLite を使うプロジェクトで WAL モードを有効にし、設定後の検証とフォールバックを実装しているか
- [ ] DB 接続を Singleton で管理し、クローズ時に参照を null リセットしているか
- [ ] アプリ終了時に WAL チェックポイントと DB クローズを含むグレースフルシャットダウンを実装しているか
- [ ] バイナリデータを DB に直接格納していないか。格納している場合、外部化を検討しているか
- [ ] ファイルシステムストレージでユーザー入力をパスに使う箇所にトラバーサル防御があるか
- [ ] 複数テーブルへの書き込み・削除がトランザクションで囲まれているか
- [ ] JSON カラムに対する頻出クエリに `json_extract` インデックスが定義されているか
- [ ] マイグレーションコードにサンセット日付または自動削除の仕組みがあるか
- [ ] ファイル書き込みでアトミックリネーム（temp -> rename）パターンを使っているか
- [ ] テスト環境で `:memory:` DB や環境変数による切り替えが可能か
