# Performance Techniques

> リポジトリ: openclaw/openclaw
> 分析日: 2026-02-14

## 概要

OpenClaw は多チャネル AI ゲートウェイであり、LLM トークン消費・エンベディング処理・メディア変換・WebSocket 通信・プロセス管理など、多層にわたるパフォーマンス最適化が求められる。特に「トークン使用量の最適化とコンパクションロジック」が CONTRIBUTING.md に優先事項として明記されており、コンテキストウィンドウ制約下での効率的なメッセージ管理がプロジェクトの中心課題となっている。コードベース全体を横断すると、適応的チャンキング・レーンベース並列化・段階的フォールバック・キャッシュ階層化という4つの最適化軸が浮かび上がる。

## 背景にある原則

- **制約駆動のリソース配分**: コンテキストウィンドウやAPIレート制限など「外部制約」を起点にリソース配分を決定すべき。OpenClaw はモデルのコンテキストウィンドウサイズに応じてチャンクの割合・サマリー戦略を動的に切り替えている（`src/agents/compaction.ts:131-150`）。固定パラメータではなく実行時の制約から逆算することで、異なるモデル・状況に自動適応できる。

- **段階的劣化（Graceful Degradation）**: 最適手段が失敗した場合、次善の手段に自動移行すべき。エンベディング処理でバッチ API が失敗すると個別処理にフォールバックし（`src/memory/manager-embedding-ops.ts:660-691`）、コンパクションで全文要約が失敗するとオーバーサイズメッセージを除外した部分要約に切り替える（`src/agents/compaction.ts:199-264`）。エラーがユーザー体験を阻害しない設計が徹底されている。

- **直列化による安全性と並列化による速度の両立**: 競合の可能性があるリソースはレーンで直列化し、独立した処理はレーン間で並列化すべき。コマンドキュー（`src/process/command-queue.ts`）はレーン別に同時実行数を制御し、メインワークフローの一貫性を保ちつつ cron やサブエージェントを並行処理する。

- **再計算回避の階層化**: 計算コストの高い結果は適切な粒度でキャッシュすべき。エンベディングキャッシュ（SQLite テーブル）、メモリインデックスのインスタンスキャッシュ（`INDEX_CACHE`）、セッションストアの TTL 付きキャッシュなど、複数階層でキャッシュを適用している。

## 実例と分析

### 1. 適応的コンテキストウィンドウ管理

コンパクション（会話履歴の要約圧縮）は、LLM のコンテキストウィンドウ制約を効率的に活用するための中核機構である。

`computeAdaptiveChunkRatio` はメッセージの平均トークン数とコンテキストウィンドウの比率に応じてチャンクサイズを動的に調整する。メッセージが大きいほどチャンクを小さくし、モデルの上限超過を防ぐ。

```typescript
// src/agents/compaction.ts:131-150
export function computeAdaptiveChunkRatio(messages: AgentMessage[], contextWindow: number): number {
  if (messages.length === 0) {
    return BASE_CHUNK_RATIO;
  }
  const totalTokens = estimateMessagesTokens(messages);
  const avgTokens = totalTokens / messages.length;
  const safeAvgTokens = avgTokens * SAFETY_MARGIN;
  const avgRatio = safeAvgTokens / contextWindow;
  if (avgRatio > 0.1) {
    const reduction = Math.min(avgRatio * 2, BASE_CHUNK_RATIO - MIN_CHUNK_RATIO);
    return Math.max(MIN_CHUNK_RATIO, BASE_CHUNK_RATIO - reduction);
  }
  return BASE_CHUNK_RATIO;
}
```

セキュリティ面でも `stripToolResultDetails` が `toolResult.details`（未信頼/冗長ペイロード）をトークン推定とサマリー生成から除外し、不要データによるトークン浪費とインジェクションリスクを同時に排除している。

### 2. レーンベース並列化

コマンドキューはレーンごとに独立したキューと同時実行数制限を持つ。メインワークフロー（`CommandLane.Main`）は直列実行（デフォルト `maxConcurrent: 1`）で一貫性を保ちつつ、cron・サブエージェント・ネストタスクは別レーンで並行処理される。

```typescript
// src/process/lanes.ts:1-6
export const enum CommandLane {
  Main = "main",
  Cron = "cron",
  Subagent = "subagent",
  Nested = "nested",
}
```

```typescript
// src/config/agent-limits.ts:3-11
export const DEFAULT_AGENT_MAX_CONCURRENT = 4;
export const DEFAULT_SUBAGENT_MAX_CONCURRENT = 8;

export function resolveAgentMaxConcurrent(cfg?: OpenClawConfig): number {
  const raw = cfg?.agents?.defaults?.maxConcurrent;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  return DEFAULT_AGENT_MAX_CONCURRENT;
}
```

ゲートウェイ起動時にレーンの同時実行数が設定から解決され、`setCommandLaneConcurrency` で反映される（`src/gateway/server-lanes.ts:8`）。設定リロード時にも再適用される。

### 3. コンカレンシー制御付きバッチ処理

エンベディング処理とメディア理解で同一パターンの `runWithConcurrency` ユーティリティが使われている。Worker Pool パターンの軽量実装で、Promise の並列実行数を上限付きで制御する。

```typescript
// src/media-understanding/concurrency.ts:3-33
export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  if (tasks.length === 0) {
    return [];
  }
  const resolvedLimit = Math.max(1, Math.min(limit, tasks.length));
  const results: T[] = Array.from({ length: tasks.length });
  let next = 0;
  const workers = Array.from({ length: resolvedLimit }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= tasks.length) {
        return;
      }
      try {
        results[index] = await tasks[index]();
      } catch (err) {
        // error handling
      }
    }
  });
  await Promise.allSettled(workers);
  return results;
}
```

注目すべき点として、メモリ側（`src/memory/internal.ts:300`）の実装はエラー発生時に全 worker を停止する（fail-fast）のに対し、メディア側（`src/media-understanding/concurrency.ts`）はエラーをログして続行する。データの整合性が求められるか否かで戦略が異なる。

### 4. 多層フォールバックによるエンベディング処理

バッチ API → タイムアウトリトライ → 個別処理へのフォールバックチェーンが構築されている。さらに失敗回数をトラッキングし、閾値（`BATCH_FAILURE_LIMIT = 2`）を超えるとバッチ API 自体を動的に無効化する。

```typescript
// src/memory/manager-embedding-ops.ts:660-691
private async runBatchWithFallback<T>(params: {
  provider: string;
  run: () => Promise<T>;
  fallback: () => Promise<number[][]>;
}): Promise<T | number[][]> {
  if (!this.batch.enabled) {
    return await params.fallback();
  }
  try {
    const result = await this.runBatchWithTimeoutRetry({
      provider: params.provider,
      run: params.run,
    });
    await this.resetBatchFailureCount();
    return result;
  } catch (err) {
    // ... record failure, disable batch if threshold exceeded
    return await params.fallback();
  }
}
```

### 5. テスト並列化戦略

テストスクリプト（`scripts/test-parallel.mjs`）は、vmForks プール（高速だが Node 24 で不安定）と forks プール（安定だが低速）を環境に応じて切り替え、互換性問題のあるテストを分離して実行する。OS・CI 環境・メモリ制約を検出してワーカー数を自動調整する設計で、ローカル実行時は CPU コア数に連動し、macOS CI では OOM 回避のため 1 ワーカーに制限される。

```javascript
// scripts/test-parallel.mjs:123-149
const localWorkers = Math.max(4, Math.min(16, os.cpus().length));
const maxWorkersForRun = (name) => {
  if (resolvedOverride) return resolvedOverride;
  if (isCI && !isMacOS) return null;
  if (isCI && isMacOS) return 1;
  if (name === "unit-isolated") return 1;
  // ...
  return defaultUnitWorkers;
};
```

### 6. 画像処理のバックエンド選択

画像処理は sharp と macOS ネイティブの sips を動的に切り替える。Bun ランタイムでの sharp 互換性問題を回避しつつ、環境変数 `OPENCLAW_IMAGE_BACKEND` でオーバーライド可能にしている。

```typescript
// src/media/image-ops.ts:17-22
function prefersSips(): boolean {
  return (
    process.env.OPENCLAW_IMAGE_BACKEND === "sips"
    || (process.env.OPENCLAW_IMAGE_BACKEND !== "sharp" && isBun() && process.platform === "darwin")
  );
}
```

### 7. セッション書き込みロックと再入可能性

セッション書き込みロック（`src/agents/session-write-lock.ts`）はファイルベースのロックにプロセス内参照カウントを組み合わせ、同一プロセス内での再入を許容しつつ、プロセス間の排他制御を実現する。stale ロックの検出（PID 生存チェック + 30 分のタイムアウト）とシグナルハンドラによるクリーンアップも備える。

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

## パターンカタログ

- **Worker Pool** (分類: 並行処理)
  - 解決する問題: 大量の非同期タスクを制限付き並列度で実行し、リソース枯渇を防ぐ
  - 適用条件: 独立した非同期タスクが多数存在し、同時実行数を制限する必要がある場合
  - コード例: `src/media-understanding/concurrency.ts:3-33`, `src/memory/internal.ts:300-329`
  - 注意点: エラー伝搬ポリシー（fail-fast vs best-effort）をユースケースに応じて選択する

- **Circuit Breaker** (分類: 振る舞い/安定性)
  - 解決する問題: 繰り返し失敗するリモート API 呼び出しを早期に回路遮断し、リソースの浪費を防ぐ
  - 適用条件: 外部依存の失敗が一時的でない可能性がある場合
  - コード例: `src/memory/manager-embedding-ops.ts:611-633`（`recordBatchFailure` で閾値超過時にバッチを無効化）
  - 注意点: 回復パス（`resetBatchFailureCount`）を用意し、一時障害後の自動復旧を保証する

- **Strategy** (分類: 振る舞い)
  - 解決する問題: 実行環境に応じて画像処理バックエンドを切り替える
  - 適用条件: 同一インターフェースの複数実装が存在し、ランタイム条件で選択する場合
  - コード例: `src/media/image-ops.ts:17-22`（sips vs sharp の動的選択）

## Good Patterns

- **適応的パラメータ調整**: コンテキストウィンドウサイズと実際のメッセージサイズの比率からチャンク割合を動的に計算する。固定値ではなく実行時データに基づくため、モデルやセッションの特性に自動適応する。`src/agents/compaction.ts:131-150` の `computeAdaptiveChunkRatio` が典型例。

- **レーン分離によるドメイン別スループット制御**: 処理カテゴリ（メイン・cron・サブエージェント）ごとにキューを分離し、異なる同時実行数を設定する。メインの一貫性を損なわずに補助タスクの並列度を上げられる。

```typescript
// src/gateway/server-lanes.ts:8 (概略)
setCommandLaneConcurrency(CommandLane.Main, resolveAgentMaxConcurrent(cfg));
setCommandLaneConcurrency(CommandLane.Subagent, resolveSubagentMaxConcurrent(cfg));
```

- **安全マージン付きトークン推定**: トークン推定の不正確性を前提に 20% のバッファ（`SAFETY_MARGIN = 1.2`）を設けている。推定値に過度に依存せず、オーバーフローによる致命的エラーを防ぐ実用的なアプローチ。

- **debounce + 再試行ガードによる設定ホットリロード**: ファイル変更監視に debounce（300ms）を適用し、リロード処理中の新規変更は `pending` フラグで次回に繰り越す。変更差分を計算して最小限のリスタートで済ませる。`src/gateway/config-reload.ts:269-348`。

## Anti-Patterns / 注意点

- **トークン推定値の直接比較**: トークン数は推定値であり、常に誤差を含む。安全マージンなしで閾値と比較すると、わずかな過小推定でコンテキストオーバーフローが発生する。

```typescript
// Bad: 推定値を直接使う
if (estimatedTokens > contextWindow) compact();

// Better: 安全マージンを適用する
const safeEstimate = estimatedTokens * SAFETY_MARGIN;
if (safeEstimate > contextWindow * maxHistoryShare) compact();
```

- **並列タスクの一律エラー無視**: `runWithConcurrency` のメディア版はエラーをログして続行するが、致命的エラー（認証失敗など）も飲み込んでしまう。エラー種別を判別し、回復可能なものだけを無視すべき。

```typescript
// Bad: 全エラーを無視
try {
  results[index] = await tasks[index]();
} catch (err) { /* log only */ }

// Better: 回復不能なエラーは伝搬する
try {
  results[index] = await tasks[index]();
} catch (err) {
  if (isRetryableError(err)) log.warn(err);
  else {
    firstError = err;
    return;
  }
}
```

- **コンカレンシー制御なしのバッチ処理**: 大量のエンベディング要求を同時発行すると API レート制限に抵触する。OpenClaw はこれを避けるため `EMBEDDING_INDEX_CONCURRENCY = 4` で制限し、リトライにはエクスポネンシャルバックオフ + jitter を適用している（`src/memory/manager-embedding-ops.ts:505-539`）。

## 導出ルール

- `[MUST]` トークン推定値には安全マージン（10-20%）を乗算してから閾値比較する — 推定の不正確性を前提とした設計でなければコンテキストオーバーフローが発生する
  - 根拠: `SAFETY_MARGIN = 1.2` が compaction 全体で一貫して適用されている（`src/agents/compaction.ts:9`）

- `[MUST]` 外部 API のバッチ処理にはフォールバック付きのリトライ戦略を実装する — バッチ API 障害時に全機能が停止する設計は許容できない
  - 根拠: バッチ → タイムアウトリトライ → 個別処理の 3 段フォールバックチェーン（`src/memory/manager-embedding-ops.ts:660-691`）

- `[SHOULD]` 並列タスクの実行にはドメイン別のキューを分離し、カテゴリごとに同時実行数を設定可能にする — メインワークフローの一貫性を保ちつつ補助タスクのスループットを最大化できる
  - 根拠: `CommandLane` enum で Main/Cron/Subagent/Nested を分離し、各レーンに独立した `maxConcurrent` を設定（`src/process/command-queue.ts:74`）

- `[SHOULD]` 繰り返し失敗する外部呼び出しにはサーキットブレーカーを導入し、自動回復パスを用意する — 一時障害でフォールバックに切り替えたまま戻らない設計は長期的なパフォーマンス劣化を招く
  - 根拠: `recordBatchFailure` + `resetBatchFailureCount` による動的なバッチ有効/無効切り替え（`src/memory/manager-embedding-ops.ts:600-633`）

- `[SHOULD]` コンカレンシー制御ユーティリティはエラー伝搬ポリシーを明示的に選択可能にする — データ整合性が求められるケース（fail-fast）と可用性優先のケース（best-effort）で戦略が異なる
  - 根拠: 同名 `runWithConcurrency` が memory（fail-fast）と media-understanding（best-effort）で異なるエラー処理を実装（`src/memory/internal.ts:314` vs `src/media-understanding/concurrency.ts:23`）

- `[SHOULD]` テストの並列実行はランタイム環境（OS・CI 有無・メモリ量）に応じてワーカー数を自動調整する — 固定ワーカー数は特定環境で OOM やリソース競合を引き起こす
  - 根拠: `scripts/test-parallel.mjs:123-149` で OS・CI フラグ・CPU コア数を組み合わせてワーカー数を決定

- `[AVOID]` セキュリティ境界を越えるデータ（ユーザー入力、ツール実行結果）をトークン推定やサマリー生成にそのまま投入する — トークン浪費とプロンプトインジェクションの両方のリスクがある
  - 根拠: `stripToolResultDetails` が untrusted な `toolResult.details` をサマリー・トークン推定の両方から除外（`src/agents/compaction.ts:16-33, 36-38`）

## 適用チェックリスト

- [ ] LLM 呼び出しにコンテキストウィンドウ制約がある場合、トークン推定に安全マージンを設けているか
- [ ] 外部 API 呼び出し（エンベディング、TTS、画像処理など）にフォールバック戦略が実装されているか
- [ ] 並列実行が必要な箇所で、同時実行数の上限が設定可能になっているか
- [ ] 計算コストの高い処理（エンベディング生成、画像変換）にキャッシュ層が設けられているか
- [ ] テストの並列化設定が CI 環境と開発者マシンの両方で適切に動作するか
- [ ] 設定変更時のリロードに debounce が適用され、不要な再起動が抑制されているか
- [ ] セッションファイルなど共有リソースへの書き込みに排他制御（ロック）が実装されているか
- [ ] 並列タスクのエラー処理ポリシー（fail-fast vs best-effort）がユースケースに応じて明示的に選択されているか
- [ ] ユーザー由来のデータが LLM コンテキストに入る前にサニタイズされているか
