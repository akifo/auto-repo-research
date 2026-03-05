# agent-orchestration

> リポジトリ: anomalyco/opencode
> 分析日: 2026-03-05

## 概要

AI エージェントの実行フロー・セッション管理・LLM 呼び出しパイプラインの設計を分析した。opencode は Vercel AI SDK v5 の `streamText` を基盤とし、セッション内でループ駆動のエージェント実行を行う。注目に値するのは、エージェントをパーミッションベースのロール定義で分離し、コンパクション・リトライ・doom loop 検出といった自律実行の安全弁を多層に組み込んでいる点である。サブエージェントは親セッションの子として独立セッションを持ち、状態の汚染を防ぐ設計になっている。

## 背景にある原則

- **ループ制御を外部に委譲せず自前で持つべき**: LLM の `finish_reason` だけに依存せず、アプリケーション側で明示的にループ継続・停止・コンパクションの判定を行っている。`processor.process()` が `"continue" | "stop" | "compact"` のいずれかを返し、`prompt.ts` の `loop` 関数がそれに基づいて次のイテレーションを決定する（`session/prompt.ts:658-714`）。これにより、LLM のハルシネーションや不正な finish reason に対する耐性が生まれる。

- **エージェントの差異はパーミッションで表現すべき**: build / plan / explore / compaction など複数のエージェントが存在するが、コア実行ロジック（LLM 呼び出し、ストリーム処理）は共通で、違いはツール権限とシステムプロンプトの組み合わせで表現されている（`agent/agent.ts:76-203`）。コードの重複を排除しつつ、エージェントごとの振る舞いを宣言的に定義できる。

- **コンテキスト管理は受動的ではなく能動的に行うべき**: トークン数が限界に達したら自動でコンパクション（要約）を実行し、古いツール結果をプルーニングする。事前に閾値を計算し（`compaction.ts:32-48`）、溢れる前に対処する設計。これにより、長時間セッションでもコンテキスト窓を有効に使い続けられる。

- **サブエージェントは独立セッションで隔離すべき**: タスクツール（`task.ts`）はサブエージェントを呼び出す際に新しい子セッションを作成し、親セッションの状態を汚染しない。これによりサブエージェントの失敗が親に波及するリスクを制限し、再試行可能性を確保している（`tool/task.ts:66-102`）。

## 実例と分析

### エージェント実行ループの設計

`SessionPrompt.loop()`（`session/prompt.ts:274-726`）がエージェント実行の中核ループである。1 セッションにつき 1 つの AbortController を持ち、同時実行を防ぐ。ループ内では以下を順に処理する:

1. メッセージ履歴から最新の user/assistant メッセージを検索
2. finish reason を検査してループ終了判定
3. コンパクション・サブタスクの pending を処理
4. コンテキストオーバーフロー検知 → 自動コンパクション
5. 通常の LLM ストリーム処理

特筆すべきは、ループが `while(true)` で回り、`processor.process()` の戻り値（`"continue" | "stop" | "compact"`）で制御される点。これは finish reason に直接依存せず、アプリケーション層で明示的に判定を行うパターンである。

### ストリーム処理とパーツ永続化

`SessionProcessor.create()`（`session/processor.ts:26-428`）はストリームのイベントを `switch` 文で処理し、各パーツ（text, reasoning, tool-call, tool-result 等）を即座にデータベースに永続化する。これにより:

- 中断時にも途中までの結果が保存される
- UI はリアルタイムに更新を受け取れる（Bus 経由のイベント伝播）
- ステップごとにスナップショットを記録し、後から差分を取れる

```typescript
// session/processor.ts:233-236
case "start-step":
  snapshot = await Snapshot.track()
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: input.assistantMessage.id,
    sessionID: input.sessionID,
    snapshot,
    type: "step-start",
  })
```

### Doom Loop 検出

同一ツールを同一引数で 3 回連続呼び出すと「doom loop」と判定し、ユーザーに確認を求める（`session/processor.ts:151-177`）。直近のパーツを取得し、ツール名と入力の JSON 文字列を比較するシンプルな手法だが、無限ループの予防として効果的である。

```typescript
// session/processor.ts:20,152-166
const DOOM_LOOP_THRESHOLD = 3
const lastThree = parts.slice(-DOOM_LOOP_THRESHOLD)
if (
  lastThree.length === DOOM_LOOP_THRESHOLD &&
  lastThree.every(
    (p) =>
      p.type === "tool" &&
      p.tool === value.toolName &&
      p.state.status !== "pending" &&
      JSON.stringify(p.state.input) === JSON.stringify(value.input),
  )
) {
  await PermissionNext.ask({ permission: "doom_loop", ... })
}
```

### リトライ戦略

`SessionRetry`（`session/retry.ts`）は API エラーに対して指数バックオフリトライを行う。`retry-after` / `retry-after-ms` ヘッダーを優先的に使用し、ヘッダーがない場合は `2000ms * 2^(attempt-1)` で最大 30 秒までバックオフする。コンテキストオーバーフローは明示的にリトライ対象外としている。

```typescript
// session/retry.ts:28-58
export function delay(attempt: number, error?: MessageV2.APIError) {
  if (error) {
    const headers = error.data.responseHeaders;
    if (headers) {
      const retryAfterMs = headers["retry-after-ms"];
      // ... ヘッダー解析
      return RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1);
    }
  }
  return Math.min(
    RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1),
    RETRY_MAX_DELAY_NO_HEADERS,
  );
}
```

### プロバイダー抽象化と LLM 呼び出し

`LLM.stream()`（`session/llm.ts:46-256`）は Vercel AI SDK の `streamText` をラップし、プロバイダー固有の差異を吸収する。具体的には:

- `experimental_repairToolCall` でツール名の大文字小文字ミスを自動修復（`llm.ts:178-197`）
- LiteLLM プロキシ互換のためのダミーツール注入（`llm.ts:158-170`）
- プロバイダーごとのシステムプロンプト切り替え（`system.ts:19-27`）
- `wrapLanguageModel` でメッセージ変換ミドルウェアを挿入

### イベントバスによる状態伝播

`Bus`（`bus/index.ts`）は型安全なイベントバスで、セッション・メッセージの変更を UI やプラグインに伝播する。`BusEvent.define()` で Zod スキーマ付きイベントを定義し、publish/subscribe パターンで疎結合な通信を実現している。セッション状態（idle/busy/retry）は `SessionStatus` として専用管理される。

### プラグインフック

`Plugin.trigger()`（`plugin/index.ts`）はパイプライン上の複数ポイントにフックを提供する。`chat.params`、`chat.headers`、`tool.execute.before`/`after`、`experimental.chat.system.transform` など、LLM 呼び出しのほぼ全段階に拡張ポイントがある。フックは入力オブジェクトを直接変異させる形式で、チェーン処理される。

## パターンカタログ

- **Chain of Responsibility** (振る舞い)
  - 解決する問題: LLM ストリームの各イベントタイプに対する適切なハンドラの選択
  - 適用条件: ストリームイベントが多種多様で、各イベントに異なる処理が必要な場合
  - コード例: `session/processor.ts:55-351` の `switch (value.type)` 文
  - 注意点: イベントタイプの網羅性を `default` ケースでログ出力して担保している

- **Strategy** (振る舞い)
  - 解決する問題: エージェントごとに異なるツール権限・プロンプト・パラメータの組み合わせ
  - 適用条件: 実行ロジックは共通だが、振る舞いのバリエーションが多い場合
  - コード例: `agent/agent.ts:76-203` のエージェント定義群
  - 注意点: パーミッションを `merge` で段階的に合成し、ユーザー設定が最終的に優先される

## Good Patterns

- **三値の実行結果型**: `processor.process()` が `"continue" | "stop" | "compact"` を返す設計。ループ制御の判断をプロセッサーの外部（ループ側）に委譲し、関心の分離を実現している。boolean ではなく文字列リテラルユニオンを使うことで、新しい制御フローの追加が容易。

- **ストリーム即時永続化**: ストリームの各チャンクを受け取るたびに `Session.updatePart()` でデータベースに書き込む。中断耐性が高く、UI の即時更新も可能にする。テキストデルタは `updatePartDelta()` で差分のみ伝播し、全文書き換えを避けている。

```typescript
// session/processor.ts:304-316
case "text-delta":
  if (currentText) {
    currentText.text += value.text
    await Session.updatePartDelta({
      sessionID: currentText.sessionID,
      messageID: currentText.messageID,
      partID: currentText.id,
      field: "text",
      delta: value.text,
    })
  }
```

- **ツール名の自動修復**: LLM がツール名の大文字小文字を間違えた場合に `toLowerCase()` で修復し、それでも一致しない場合は `invalid` ツールにフォールバックする（`llm.ts:178-197`）。LLM の出力の不正確さに対する実践的な防御。

## Anti-Patterns / 注意点

- **巨大な switch 文によるイベント処理**: `processor.ts` の `process` メソッド内の `switch` 文が 300 行近くに及ぶ。イベントタイプごとにハンドラを分離し、テスト可能性を高めるリファクタリングが考えられる。

```typescript
// Bad: 単一の巨大 switch（processor.ts:55-351）
for await (const value of stream.fullStream) {
  switch (value.type) {
    case "start": /* ... */
    case "reasoning-start": /* 20行 */
    case "reasoning-delta": /* 10行 */
    case "tool-call": /* 30行 */
      // ... 15以上のケース
  }
}

// Better: イベントハンドラをマップで管理
const handlers: Record<string, (value: StreamEvent) => Promise<void>> = {
  "start": handleStart,
  "reasoning-start": handleReasoningStart,
  // ...
};
for await (const value of stream.fullStream) {
  await handlers[value.type]?.(value);
}
```

- **セッション状態の暗黙的な排他制御**: `SessionPrompt.start()` は `state()[sessionID]` の存在チェックで排他制御を行うが、Promise ベースのキューイングに依存しており、競合状態のリスクがある。`BusyError` を投げる `assertNotBusy` が別途存在するが、使用箇所が限定的。

## 導出ルール

- `[MUST]` LLM エージェントのループ制御は finish reason だけに依存せず、アプリケーション層で明示的な継続/停止/コンパクション判定を行う
  - 根拠: opencode は `processor.process()` の三値戻り値（`"continue" | "stop" | "compact"`）で制御し、LLM の不正な finish reason に対する耐性を確保している（`session/prompt.ts:658-714`）

- `[MUST]` 自律エージェントには無限ループ防止機構を組み込む（同一操作の連続検出、最大ステップ数制限）
  - 根拠: doom loop 検出（直近 N 回のツール呼び出しの同一性検査）と `agent.steps` による最大ステップ数制限の二重防御で暴走を防止している（`session/processor.ts:151-177`, `session/prompt.ts:559`）

- `[SHOULD]` サブエージェントは親とは独立したセッション（状態空間）で実行し、結果のみを親に返す
  - 根拠: `TaskTool` は子セッションを作成してサブエージェントを実行し、テキスト結果のみを `<task_result>` タグで親に返すことで状態汚染を防いでいる（`tool/task.ts:66-153`）

- `[SHOULD]` LLM ストリームの各チャンクは受信時に即座に永続化し、中断耐性と UI リアルタイム更新を両立させる
  - 根拠: `SessionProcessor` はストリームイベントごとに `Session.updatePart()` を呼び出し、プロセス中断時でも途中結果が失われない設計を実現している（`session/processor.ts:55-351`）

- `[SHOULD]` API リトライではレスポンスヘッダー（`retry-after` / `retry-after-ms`）を最優先で使用し、ヘッダーがない場合のみ指数バックオフにフォールバックする
  - 根拠: `SessionRetry.delay()` はヘッダー解析を最初に行い、サーバーが指示する待機時間を尊重する実装になっている（`session/retry.ts:28-58`）

- `[SHOULD]` エージェントの差異はパーミッションとプロンプトの組み合わせで宣言的に定義し、実行ロジックの共通化を維持する
  - 根拠: build / plan / explore / compaction の全エージェントが同一の `SessionProcessor` と `LLM.stream()` を共有し、差異は `Agent.Info` の `permission` と `prompt` フィールドのみで表現されている（`agent/agent.ts:76-203`）

- `[AVOID]` LLM のツール名出力の大文字小文字を信頼する（自動修復レイヤーを設けるべき）
  - 根拠: `experimental_repairToolCall` でツール名を `toLowerCase()` して一致を試み、LLM の出力不正確性に対する防御を実装している（`session/llm.ts:178-197`）

## 適用チェックリスト

- [ ] エージェント実行ループが LLM の finish reason だけでなく、アプリケーション層の明示的な判定ロジックで制御されているか
- [ ] 同一ツールの連続呼び出し検出（doom loop 防止）が実装されているか
- [ ] 最大ステップ数の制限が設けられているか
- [ ] サブエージェント実行時に親セッションの状態が汚染されない設計になっているか
- [ ] LLM ストリームの中間結果が永続化され、中断時にも復旧可能か
- [ ] API エラーのリトライが `retry-after` ヘッダーを尊重し、コンテキストオーバーフローを除外しているか
- [ ] コンテキスト窓のオーバーフローを事前検知し、自動コンパクション（要約）を実行する仕組みがあるか
- [ ] ツール名の大文字小文字ミスに対する自動修復が組み込まれているか
- [ ] エージェントの振る舞い差異がコード分岐ではなく宣言的な設定（パーミッション・プロンプト）で表現されているか
