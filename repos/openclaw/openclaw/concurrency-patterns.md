# Concurrency Patterns

> リポジトリ: openclaw/openclaw
> 分析日: 2026-02-14

## 概要

OpenClaw はマルチチャネルメッセージングゲートウェイであり、複数のエージェントが同一プロセス内で並行動作する。Node.js のシングルスレッドイベントループ上で、ファイルベースロック、レーン型コマンドキュー、AbortController によるキャンセル伝播、アトミック書き込みなど、多層的な並行処理パターンを実装している。マルチエージェント環境での安全性ルールが AGENTS.md に明文化されており、「ツールとしての安全規約」が並行処理設計と密接に統合されている点が注目に値する。

## 背景にある原則

- **シングルスレッドでの論理的排他制御**: Node.js にはカーネルレベルのスレッドロックがないため、ファイルシステムの `O_EXCL` フラグとインプロセスキューで排他制御を実現すべき。同一プロセス内のリエントラントロックは参照カウントで管理し、プロセス間ロックは PID 検証付きロックファイルで実現している（`src/agents/session-write-lock.ts`, `src/infra/gateway-lock.ts`）。

- **キャンセル伝播の統一**: 長時間実行タスクはすべて AbortSignal を通じてキャンセル可能にすべき。複数のキャンセルソースは `AbortSignal.any()` またはリレーパターンで合成し、リソースリークを防ぐ（`src/agents/pi-tools.abort.ts`, `src/utils/fetch-timeout.ts`）。

- **障害からの自動回復**: プロセス再起動時に中断されたタスクの状態をファイルシステムから復元し、べき等な再試行で回復すべき。書き込み前にディスクに永続化する Write-Ahead パターンで、クラッシュ時のデータロスを最小化している（`src/infra/outbound/delivery-queue.ts`）。

- **並行度の構成可能性**: 並行処理の上限はハードコードせず、設定値から注入すべき。用途ごとにレーン（Main, Cron, Subagent, Nested）を分離し、相互干渉を防ぐ（`src/process/lanes.ts`, `src/gateway/server-lanes.ts`）。

## 実例と分析

### ファイルベースロックと PID 検証

セッション書き込みとゲートウェイ起動の 2 箇所でファイルベースロックが使われている。両者とも共通のパターンを持つ。

1. `fs.open(lockPath, "wx")` で排他的にファイルを作成（`O_CREAT | O_EXCL`）
2. ロックファイルに PID とタイムスタンプを JSON で書き込み
3. 既存ロックの検出時は PID の生存確認（`process.kill(pid, 0)`）とスタイムスタンプのスタレス判定を行い、デッドロックを自動解除
4. プロセス終了時にシグナルハンドラとプロセス exit イベントで同期的にクリーンアップ

```typescript
// src/agents/session-write-lock.ts:51-61
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

セッションロックはインプロセスのリエントラントロックも実装している。同一セッションファイルに対する再帰的ロック取得時は参照カウントを増やすだけで、ファイルシステム操作をスキップする。

```typescript
// src/agents/session-write-lock.ts:166-184
const held = HELD_LOCKS.get(normalizedSessionFile);
if (held) {
  held.count += 1;
  return {
    release: async () => {
      const current = HELD_LOCKS.get(normalizedSessionFile);
      if (!current) return;
      current.count -= 1;
      if (current.count > 0) return;
      HELD_LOCKS.delete(normalizedSessionFile);
      await current.handle.close();
      await fs.rm(current.lockPath, { force: true });
    },
  };
}
```

ゲートウェイロック（`src/infra/gateway-lock.ts`）は Linux 環境では `/proc/{pid}/stat` からプロセスの起動時刻を読み取り、PID リサイクルによる誤判定を防止している。

### レーン型コマンドキュー

`src/process/command-queue.ts` は用途別にレーン（Main, Cron, Subagent, Nested）を分離したインプロセスキューを実装している。各レーンには独立した並行度上限を設定でき、レーン間は干渉しない。

```typescript
// src/process/command-queue.ts:74
while (state.activeTaskIds.size < state.maxConcurrent && state.queue.length > 0) {
```

```typescript
// src/gateway/server-lanes.ts:6-10
export function applyGatewayLaneConcurrency(cfg: ReturnType<typeof loadConfig>) {
  setCommandLaneConcurrency(CommandLane.Cron, cfg.cron?.maxConcurrentRuns ?? 1);
  setCommandLaneConcurrency(CommandLane.Main, resolveAgentMaxConcurrent(cfg));
  setCommandLaneConcurrency(CommandLane.Subagent, resolveSubagentMaxConcurrent(cfg));
}
```

注目すべき設計判断として、SIGUSR1 によるインプロセス再起動後のレーンリカバリがある。再起動時に中断されたタスクの finally ブロックが実行されず、activeTaskIds が残留してレーンが永久にブロックされる問題を「世代番号」で解決している。

```typescript
// src/process/command-queue.ts:207-221
export function resetAllLanes(): void {
  const lanesToDrain: string[] = [];
  for (const state of lanes.values()) {
    state.generation += 1;
    state.activeTaskIds.clear();
    state.draining = false;
    if (state.queue.length > 0) {
      lanesToDrain.push(state.lane);
    }
  }
  for (const lane of lanesToDrain) {
    drainLane(lane);
  }
}
```

### AbortController によるキャンセル伝播

メモリリーク防止のため、アロー関数クロージャの代わりに `.bind()` を使用する独自パターンを採用している。`bindAbortRelay()` はイベントリスナーとして使う際に Event 引数が abort reason として渡されるバグも防止している。

```typescript
// src/utils/fetch-timeout.ts:5-12
function relayAbort(this: AbortController) {
  this.abort();
}

export function bindAbortRelay(controller: AbortController): () => void {
  return relayAbort.bind(controller);
}
```

複数の AbortSignal を合成する `combineAbortSignals()` は、`AbortSignal.any()` が利用可能な環境ではそれを使い、フォールバックとして手動リレーを行う。

```typescript
// src/agents/pi-tools.abort.ts:35-43
if (typeof AbortSignal.any === "function" && isAbortSignal(a) && isAbortSignal(b)) {
  return AbortSignal.any([a, b]);
}
const controller = new AbortController();
const onAbort = bindAbortRelay(controller);
a?.addEventListener("abort", onAbort, { once: true });
b?.addEventListener("abort", onAbort, { once: true });
return controller.signal;
```

### アトミック書き込み（Write-Ahead パターン）

ファイル書き込みは一貫して「一時ファイルに書き込み → rename で差し替え」のパターンを使用する。一時ファイル名には PID と UUID を含め、並行書き込みの衝突を防ぐ。Windows では rename がアトミックでないため、プラットフォーム分岐で copyFile にフォールバックしている。

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

### グレースフルシャットダウンとインプロセス再起動

ゲートウェイの run loop（`src/cli/gateway-cli/run-loop.ts`）は 3 つのシグナルを処理する。SIGTERM/SIGINT は停止、SIGUSR1 は認可済みの場合のみインプロセス再起動を行う。再起動時はアクティブタスクのドレインを待ってからサーバーを閉じる。

```typescript
// src/cli/gateway-cli/run-loop.ts:56-93
if (isRestart) {
  const activeTasks = getActiveTaskCount();
  if (activeTasks > 0) {
    const { drained } = await waitForActiveTasks(DRAIN_TIMEOUT_MS);
    if (drained) {
      gatewayLog.info("all active tasks drained");
    } else {
      gatewayLog.warn("drain timeout reached; proceeding with restart");
    }
  }
}
```

強制終了タイマーを設定し、シャットダウンがハングした場合でもプロセスが確実に終了する。

### 並行度制限付きバッチ実行

`runWithConcurrency()` はワーカープールパターンで並行度を制限する汎用ユーティリティ。`Promise.allSettled()` を使ってすべてのワーカーの完了を待ち、エラー時は早期終了する実装（`src/memory/internal.ts`）とエラーをスキップする実装（`src/media-understanding/concurrency.ts`）の 2 バリアントが存在する。

```typescript
// src/memory/internal.ts:300-336
export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const resolvedLimit = Math.max(1, Math.min(limit, tasks.length));
  const results: T[] = Array.from({ length: tasks.length });
  let next = 0;
  let firstError: unknown = null;
  const workers = Array.from({ length: resolvedLimit }, async () => {
    while (true) {
      if (firstError) return;
      const index = next;
      next += 1;
      if (index >= tasks.length) return;
      try {
        results[index] = await tasks[index]();
      } catch (err) {
        firstError = err;
        return;
      }
    }
  });
  await Promise.allSettled(workers);
  if (firstError) throw firstError;
  return results;
}
```

### リトライとエクスポネンシャルバックオフ

`src/infra/retry.ts` はジッター付きエクスポネンシャルバックオフ、`shouldRetry` による選択的リトライ、`retryAfterMs` によるサーバー指定待機時間のサポートを備えた汎用リトライユーティリティ。配信キュー（`src/infra/outbound/delivery-queue.ts`）ではテーブル定義の固定バックオフ遅延を使い、最大リトライ数を超えたエントリは `failed/` ディレクトリに移動する。

## パターンカタログ

- **Reentrant Lock** (分類: 振る舞い)
  - 解決する問題: 同一プロセス内での再帰的ロック取得によるデッドロック
  - 適用条件: 同一ファイルに対するネストされた操作が発生する場合
  - コード例: `src/agents/session-write-lock.ts:166-184`
  - 注意点: 参照カウントのデクリメント漏れはロックリークにつながる

- **Generation Counter** (分類: 振る舞い)
  - 解決する問題: インプロセス再起動後の古いタスク完了通知による状態破壊
  - 適用条件: タスクキューをリセットする際に実行中タスクが存在しうる場合
  - コード例: `src/process/command-queue.ts:58-64, 207-221`
  - 注意点: 世代番号は単調増加である必要がある

- **Worker Pool** (分類: 振る舞い)
  - 解決する問題: 無制限の並行実行による外部リソースの枯渇
  - 適用条件: 外部 API 呼び出しや I/O 集約的なバッチ処理
  - コード例: `src/memory/internal.ts:300-336`
  - 注意点: エラーポリシー（fail-fast vs skip）は用途に応じて選択する

## Good Patterns

- **PID 検証付きロックファイル**: ロックファイルに PID とタイムスタンプを記録し、`process.kill(pid, 0)` でプロセス生存を確認する。クラッシュ後のスタレロック自動解除と PID リサイクル対策を兼ねる。Linux では `/proc/{pid}/stat` から起動時刻を比較する追加検証がある（`src/infra/gateway-lock.ts:114-140`）。

- **bindAbortRelay() によるメモリリーク防止**: AbortController のキャンセルリレーにアロー関数ではなく `.bind()` を使い、クロージャによるスコープキャプチャを回避する。イベントリスナーとして使う際は Event 引数が abort reason に漏れるバグも防止する（`src/utils/fetch-timeout.ts:5-12`）。テスト `src/infra/abort-pattern.test.ts` で回帰防止している。

- **レーン分離によるキュー干渉防止**: 用途（メイン処理、Cron、サブエージェント）ごとにキューレーンを分離し、Cron ジョブがメインの応答レイテンシに影響しない設計。各レーンの並行度は設定から注入可能（`src/gateway/server-lanes.ts`）。

- **Write-Ahead ディスク永続化**: 送信前にペイロードをディスクに保存し、送信成功後に削除する。クラッシュ回復時にディスクからエントリを読み取り、バックオフ付きで再送する（`src/infra/outbound/delivery-queue.ts:66-109`）。

## Anti-Patterns / 注意点

- **アロー関数によるキャンセルリレーのメモリリーク**: `() => controller.abort()` はクロージャがスコープを保持し、長時間実行プロセスでメモリリークを引き起こす。

```typescript
// Bad: クロージャがスコープをキャプチャ
const timer = setTimeout(() => controller.abort(), timeoutMs);
signal.addEventListener("abort", () => child.abort());

// Better: .bind() でスコープキャプチャを回避
const timer = setTimeout(controller.abort.bind(controller), timeoutMs);
signal.addEventListener("abort", bindAbortRelay(child), { once: true });
```

- **ロックファイルの同期クリーンアップ省略**: プロセス exit ハンドラで非同期のクリーンアップを行うと、イベントループが停止済みで実行されない場合がある。exit 時は同期 API（`fsSync.rmSync`）を使う必要がある（`src/agents/session-write-lock.ts:67-83`）。

- **activeTaskIds の残留によるキューブロック**: インプロセス再起動で中断されたタスクの finally ブロックが実行されず、activeTaskIds が永久に残る。世代番号パターンで古いタスクの完了通知を無視することで対処している。

## 導出ルール

- `[MUST]` ファイルベースロックには PID とタイムスタンプを記録し、`process.kill(pid, 0)` でスタレロックを自動検出・解除する
  - 根拠: PID なしのロックファイルはプロセスクラッシュ後に手動削除が必要になる（`src/agents/session-write-lock.ts:128-142, 217-224`）

- `[MUST]` プロセス exit ハンドラでのリソース解放は同期 API を使う（`fs.rmSync` 等）。非同期 API はイベントループ停止後に実行されない
  - 根拠: `releaseAllLocksSync()` が同期 API のみを使用している設計判断（`src/agents/session-write-lock.ts:67-83`）

- `[SHOULD]` AbortController のリレーにはアロー関数クロージャではなく `.bind()` を使い、長時間プロセスでのメモリリークを防ぐ
  - 根拠: #7174 回帰テストで実証（`src/infra/abort-pattern.test.ts`、`src/utils/fetch-timeout.ts:5-12`）

- `[SHOULD]` 並行度制限が必要なバッチ処理では Worker Pool パターン（固定数のワーカーがタスクキューから取り出す方式）を使い、`Promise.allSettled()` で全ワーカーの終了を待つ
  - 根拠: `runWithConcurrency()` が memory と media-understanding の 2 箇所で同一パターンとして使用（`src/memory/internal.ts:300-336`）

- `[SHOULD]` インプロセス再起動やキュー再初期化時は世代番号（generation counter）を使い、古いタスクの完了通知が現在の状態を破壊しないようにする
  - 根拠: SIGUSR1 再起動後の activeTaskIds 残留問題を解決（`src/process/command-queue.ts:58-64, 207-221`）

- `[SHOULD]` ファイルの永続化書き込みは「一時ファイル + rename」のアトミックパターンを使い、一時ファイル名には PID と UUID を含める
  - 根拠: セッションストア・設定ファイル・配信キューすべてで一貫して使用（`src/config/sessions/store.ts:542`, `src/config/io.ts:1019-1022`）

- `[AVOID]` 並行処理のタイムアウト値をハードコードする。タイムアウトは設定注入可能にし、テスト時にオーバーライドできるようにする
  - 根拠: `acquireSessionWriteLock` の `timeoutMs`, `staleMs` パラメータ、`retryAsync` の設定可能なバックオフパラメータ（`src/agents/session-write-lock.ts:144-148`, `src/infra/retry.ts:70-74`）

## 適用チェックリスト

- [ ] ファイルベースの排他制御が必要な箇所で、ロックファイルに PID とタイムスタンプを記録しているか
- [ ] ロックのクリーンアップが `process.on("exit")` で同期的に行われているか
- [ ] AbortController のリレーでアロー関数クロージャを使っていないか（`.bind()` または `AbortSignal.any()` を使用）
- [ ] 外部 API 呼び出しのバッチ処理に並行度制限があるか
- [ ] ファイル書き込みが「一時ファイル + rename」パターンで行われているか
- [ ] タスクキューのリセット時に、実行中タスクの完了通知が状態を破壊しない仕組み（世代番号等）があるか
- [ ] グレースフルシャットダウン時にアクティブタスクのドレイン待機があるか
- [ ] リトライ機構にバックオフ戦略と最大リトライ数の制限があるか
- [ ] マルチエージェント環境での安全規約（git stash 禁止、ブランチ切替禁止等）がドキュメント化されているか
