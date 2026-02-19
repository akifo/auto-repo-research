# Practice: Atomic File Write

> 出典: [repos/openclaw/openclaw](../repos/openclaw/openclaw/), [repos/ryoppippi/ccusage](../repos/ryoppippi/ccusage/)
> カテゴリ: practice

## 概要

一時ファイルへの書き込み + fsync + rename の 3 ステップで、ファイルの永続化をアトミックに行うパターン。POSIX の rename(2) が同一ファイルシステム上でアトミックであることを利用し、プロセスクラッシュや電源断が起きても「書き込み途中の破損ファイル」が残らないことを保証する。長時間稼働するサーバーや追記ログを扱う CLI ツールなど、データ整合性が重要なあらゆる場面で適用できる基本プラクティスである。

## 背景・文脈

### openclaw/openclaw -- マルチチャネル AI ゲートウェイ

OpenClaw は複数のエージェントが同一プロセス内で並行動作するマルチチャネルメッセージングゲートウェイである。セッションストア、設定ファイル、配信キューなど、複数のコンポーネントがファイルシステムに永続データを書き込む。プロセスの異常終了やシグナルによる強制停止が発生しうる環境で、データ破損を防ぐためにアトミック書き込みパターンがコードベース全体で一貫して適用されている。

### ryoppippi/ccusage -- AI ツール使用量の集計 CLI

ccusage は JSONL（JSON Lines）形式の追記ログを読み取るツール群である。JSONL は追記ログであり、書き込み途中のプロセスクラッシュで末尾の行が壊れることが日常的に起こる。ccusage は書き込み側のアトミック性よりも、**読み取り側の耐障害性**（壊れた行をスキップして処理を継続する）でこの問題に対処している。この「書き込み側の防御」と「読み取り側の防御」は互いに補完的であり、両方を組み合わせることでデータパイプラインの堅牢性が大幅に向上する。

## 実装パターン

### 3 ステップの基本フロー

アトミックなファイル書き込みは以下の 3 ステップで構成される。

1. **一時ファイルに書き込む**: 最終的な保存先とは別の一時ファイルにデータを書き込む
2. **fsync でディスクに確実にフラッシュする**: OS のバッファに残ったデータをディスクに書き出す
3. **rename で差し替える**: 一時ファイルを最終的なパスに rename する。POSIX では rename(2) は同一ファイルシステム上でアトミックな操作であり、読み取り側は常に「旧ファイル」か「新ファイル」のどちらかを見る

### OpenClaw のセッションストア実装

OpenClaw のセッションストアは、このパターンの実践的な実装例である。一時ファイル名に PID と UUID を含めることで、複数プロセスが同時に書き込む場合の衝突も防止している。

```typescript
// src/config/sessions/store.ts:542-577
const tmp = `${storePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
try {
  await fs.promises.writeFile(tmp, json, { mode: 0o600, encoding: "utf-8" });
  await fs.promises.rename(tmp, storePath);
  await fs.promises.chmod(storePath, 0o600);
} catch (err) {
  // ... ENOENT fallback ...
} finally {
  await fs.promises.rm(tmp, { force: true });
}
```

注目すべき設計判断:

- **`process.pid` + `crypto.randomUUID()`**: 同一プロセス内の並行書き込みと、異なるプロセスからの並行書き込みの両方を安全に分離する
- **`mode: 0o600`**: 機密データ（セッション情報）を含むファイルのパーミッションを制限する
- **`finally` ブロックでの一時ファイル削除**: 書き込みが成功しても失敗しても、一時ファイルが残留しないことを保証する。`{ force: true }` により、既に rename で消えている場合もエラーにならない

### ccusage の読み取り側の防御

書き込み側がアトミックでない場合（あるいはアトミック書き込みが OS レベルで保証されない追記ログの場合）、読み取り側で壊れたデータをスキップする戦略が補完的に機能する。

```typescript
// apps/ccusage/src/data-loader.ts:793-801
try {
  const parsed = JSON.parse(line) as unknown;
  const result = v.safeParse(usageDataSchema, parsed);
  if (!result.success) {
    return;
  }
  const data = result.output;
  // ... 正常処理 ...
} catch {
  // 不正な JSON 行をサイレントスキップ
}
```

この設計は「JSONL が追記ログであり途中で壊れる可能性がある（プロセスの異常終了、書き込み途中のクラッシュ等）」という現実を反映している。全行の完全性を前提にしない設計がデータパイプラインの堅牢性を支えている。

### ロックファイルとの組み合わせ

複数のプロセスが同一ファイルを更新する場合、アトミック書き込み単体では「最後の書き込みが勝つ」問題が残る。OpenClaw はファイルベースロックとアトミック書き込みを組み合わせて、この問題を解決している。

```typescript
// src/agents/session-write-lock.ts:51-61
// ステップ 1: ファイルベースロックを取得（PID 検証付き）
function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
```

ロックファイルの取得フロー:

1. `fs.open(lockPath, "wx")` で排他的にファイルを作成（`O_CREAT | O_EXCL`）
2. ロックファイルに PID とタイムスタンプを JSON で書き込み
3. 既存ロックの検出時は PID の生存確認 + タイムスタンプのスタレス判定でデッドロックを自動解除
4. ロック取得後にアトミック書き込みを実行
5. 書き込み完了後にロックを解放

プロセス終了時のロック解放は同期 API を使う必要がある。`process.on("exit")` ハンドラではイベントループが停止済みのため、非同期 API は実行されない。

```typescript
// src/agents/session-write-lock.ts:67-83 の設計判断
// exit ハンドラでは fs.rmSync (同期) を使い、確実にクリーンアップする
```

## Good Example

### 一時ファイル + rename の完全な実装

```typescript
import { randomUUID } from "node:crypto";
import { open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

async function atomicWriteFile(
  filePath: string,
  data: string,
  options?: { mode?: number; },
): Promise<void> {
  // 一時ファイルは最終パスと同じディレクトリに作成する
  // (同一ファイルシステムでないと rename がアトミックにならない)
  const dir = dirname(filePath);
  const tmp = join(dir, `.${process.pid}.${randomUUID()}.tmp`);

  try {
    // 1. 一時ファイルに書き込み
    await writeFile(tmp, data, {
      encoding: "utf-8",
      mode: options?.mode ?? 0o644,
    });

    // 2. fsync でディスクにフラッシュ
    const fd = await open(tmp, "r");
    await fd.sync();
    await fd.close();

    // 3. rename でアトミックに差し替え
    await rename(tmp, filePath);
  } finally {
    // 失敗時の一時ファイル残留を防止
    await rm(tmp, { force: true });
  }
}
```

### 読み取り側の防御との組み合わせ

```typescript
// 書き込み側: アトミック書き込みで破損を防止
async function appendUsageLog(
  logPath: string,
  entry: UsageEntry,
): Promise<void> {
  const line = JSON.stringify(entry) + "\n";
  // 追記の場合、appendFile はアトミックでないことに注意
  // 行単位の追記は十分に短いため実際には壊れにくいが、
  // 万一壊れた場合に備えて読み取り側でも防御する
  await appendFile(logPath, line, "utf-8");
}

// 読み取り側: 壊れた行をスキップして処理を継続
async function readUsageLog(logPath: string): Promise<UsageEntry[]> {
  const entries: UsageEntry[] = [];
  for await (const line of createLineStream(logPath)) {
    try {
      const parsed = JSON.parse(line);
      const result = schema.safeParse(parsed);
      if (result.success) {
        entries.push(result.data);
      }
      // バリデーション失敗はスキップ（ログのみ）
    } catch {
      // JSON パース失敗もスキップ
    }
  }
  return entries;
}
```

## Bad Example

### 直接上書き -- クラッシュ時にファイルが破損する

```typescript
// Bad: 書き込み途中にクラッシュすると、中途半端なデータがファイルに残る
async function saveConfig(filePath: string, config: Config): Promise<void> {
  const json = JSON.stringify(config, null, 2);
  await writeFile(filePath, json, "utf-8");
  // -> writeFile の途中でプロセスが死ぬと、
  //    ファイルには部分的な JSON だけが残り、次回起動時にパースエラーになる
}
```

### 一時ファイルを別のファイルシステムに作成する

```typescript
// Bad: /tmp は別のファイルシステムの場合がある
// rename はファイルシステムをまたぐとアトミックにならず、
// 内部的に copy + delete にフォールバックされる
import { tmpdir } from "node:os";

const tmp = join(tmpdir(), `${randomUUID()}.tmp`);
await writeFile(tmp, data, "utf-8");
await rename(tmp, "/var/data/config.json");
// -> /tmp と /var/data が別パーティションなら rename は EXDEV エラーになる

// Good: 最終パスと同じディレクトリに一時ファイルを作成する
const tmp = join(dirname("/var/data/config.json"), `.${randomUUID()}.tmp`);
await writeFile(tmp, data, "utf-8");
await rename(tmp, "/var/data/config.json");
```

### finally ブロックでの一時ファイル削除漏れ

```typescript
// Bad: エラー時に一時ファイルが残留する
const tmp = `${filePath}.tmp`;
await writeFile(tmp, data, "utf-8");
await rename(tmp, filePath);
// -> writeFile が失敗すると一時ファイルが残り、ディスクを圧迫する

// Good: finally で確実に削除する
const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
try {
  await writeFile(tmp, data, "utf-8");
  await rename(tmp, filePath);
} finally {
  await rm(tmp, { force: true });
}
```

### 一時ファイル名の衝突

```typescript
// Bad: 固定の一時ファイル名 -- 並行実行で競合する
const tmp = `${filePath}.tmp`;
await writeFile(tmp, data);
await rename(tmp, filePath);
// -> 2つのプロセスが同時に .tmp に書き込むと、一方のデータが失われる

// Good: PID + UUID で一意性を保証する（OpenClaw のパターン）
const tmp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
await writeFile(tmp, data);
await rename(tmp, filePath);
```

## 適用ガイド

### どのような状況で使うべきか

- **設定ファイルの保存**: アプリケーションの設定を JSON/YAML で永続化する場合。起動時に設定ファイルが壊れていると致命的になる
- **セッションデータの永続化**: ユーザーセッションやキャッシュの書き出し。長時間稼働サーバーでは特に重要
- **配信キューの永続化**: メッセージの送信前にディスクに保存し、クラッシュ後に再送する Write-Ahead パターン
- **追記ログ以外のファイル更新全般**: JSONL のような追記ログは行単位で壊れても読み取り側でスキップできるが、設定ファイルやセッションファイルは全体が壊れると復旧できない

### 導入時の注意点

- **一時ファイルは最終パスと同じディレクトリに作る**: `rename(2)` が同一ファイルシステム上でのみアトミックであるため、`os.tmpdir()` ではなく対象ファイルと同じディレクトリを使う
- **Windows では rename がアトミックでない**: OpenClaw はこの問題を認識しており、Windows 環境ではプラットフォーム分岐で `copyFile` にフォールバックする設計を取っている。クロスプラットフォーム対応が必要な場合は注意が必要
- **一時ファイル名に PID + UUID を含める**: 同一ファイルへの並行書き込みで一時ファイルが衝突するリスクを排除する
- **finally ブロックで一時ファイルを削除する**: `{ force: true }` オプションを付けて、既に rename で消えている場合もエラーにしない
- **fsync を忘れない**: `writeFile` が返っても OS のバッファにデータが残っている可能性がある。`fd.sync()` でディスクへの書き込みを確定させてから rename する。ただしパフォーマンスとのトレードオフがあるため、データの重要度に応じて判断する

### カスタマイズポイント

- **ロックファイルの併用**: 複数プロセスが同一ファイルを更新する場合は、`fs.open(lockPath, "wx")` によるファイルベースロックを組み合わせる。ロックファイルには PID とタイムスタンプを記録し、スタレロックの自動解除を実装する
- **fsync の省略**: 一時的なキャッシュファイルなど、データ損失が許容できる場合は fsync を省略してパフォーマンスを優先できる
- **読み取り側の防御との組み合わせ**: 追記ログ（JSONL 等）の場合は、書き込み側のアトミック性に加えて、読み取り側で `safeParse` + サイレントスキップを実装し、二重の防御を構築する
- **パーミッション設定**: 機密データを含むファイルは `mode: 0o600` で書き込み、`chmod` で確認する（OpenClaw のセッションストアが実践している）

## 参考

- [repos/openclaw/openclaw/concurrency-patterns.md](../repos/openclaw/openclaw/concurrency-patterns.md) -- アトミック書き込み、ファイルベースロック、Write-Ahead パターンの詳細分析
- [repos/openclaw/openclaw/error-handling-idioms.md](../repos/openclaw/openclaw/error-handling-idioms.md) -- クリーンアップ処理での `catch {}` の正当な使用例
- [repos/ryoppippi/ccusage/data-processing-patterns.md](../repos/ryoppippi/ccusage/data-processing-patterns.md) -- JSONL ストリーミング解析とサイレントスキップによる読み取り側の耐障害性
