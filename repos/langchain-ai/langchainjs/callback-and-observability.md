# Callback and Observability

> リポジトリ: langchain-ai/langchainjs
> 分析日: 2026-02-20

## 概要

langchainjs のコールバック・オブザーバビリティ基盤を分析した。LLM・チェーン・ツール・リトリーバーなど異種コンポーネントの実行を、統一的なイベントハンドラインターフェースと階層的な Run 管理を通じて横断的に監視・トレーシングする仕組みが構築されている。特に、バックグラウンド実行とフォアグラウンド実行の切り替え、AsyncLocalStorage を用いた暗黙的コンテキスト伝播、ストリーミング対応のためのコールバックとトレーサーの二層構造が注目に値する。

## 背景にある原則

- **コールバックはホットパスを阻害してはならない**: ハンドラの `awaitHandlers` フラグと `consumeCallback` 関数により、コールバック処理をバックグラウンドキューで実行するかフォアグラウンドで await するかを制御する。デフォルトはバックグラウンド実行であり、トレーシングが本番のレスポンスタイムに影響しない設計。(`libs/langchain-core/src/singletons/callbacks.ts:34-58`, `libs/langchain-core/src/callbacks/base.ts:372-373`)

- **コンテキスト伝播は明示と暗黙の両方をサポートすべき**: `RunnableConfig` による明示的な `callbacks`/`tags`/`metadata` 伝播に加え、`AsyncLocalStorage` を用いた暗黙的なコンテキスト伝播を提供する。明示的な値は暗黙的な値より優先される。これにより API の使いやすさ（暗黙）と制御の正確性（明示）を両立している。(`libs/langchain-core/src/runnables/config.ts:125-213`)

- **ハンドラのエラーは監視対象の処理を中断させてはならない**: すべてのハンドラ呼び出しは try-catch で囲まれ、デフォルトでは `console.warn` に留める。`raiseError: true` を明示した場合のみ例外を再 throw する。コールバック基盤の障害が本来の処理フローに波及しないための防御的設計。(`libs/langchain-core/src/callbacks/manager.ts:119-143`)

- **階層的実行は親子関係で自然に表現すべき**: `getChild()` パターンにより、親の Run Manager から子の CallbackManager を生成し、継承可能なハンドラ・タグ・メタデータだけを引き継ぐ。これにより深くネストした実行でもトレースツリーが自然に構築される。(`libs/langchain-core/src/callbacks/manager.ts:190-200`)

## 実例と分析

### 二層構造: CallbackHandler と BaseTracer

コールバック基盤は 2 つのレイヤーで構成される。

**第1層: BaseCallbackHandler** — 個別イベントのハンドリングを行う薄いインターフェース。`handleLLMStart`, `handleLLMEnd`, `handleLLMError` など Start/End/Error の三つ組でライフサイクルイベントを定義する。すべてのメソッドは optional であり、必要なイベントだけを実装できる。

**第2層: BaseTracer** — BaseCallbackHandler を継承し、Run オブジェクト（実行ツリー）の組み立てを担当する。各 handle メソッドを内部で Run の生成・更新・終了に変換し、`onLLMStart`, `onLLMEnd` など簡潔なフック群を公開する。LangChainTracer（LangSmith 送信）、ConsoleCallbackHandler（コンソール出力）、EventStreamCallbackHandler（streamEvents 用）はすべて BaseTracer を継承している。

この分離により、単純なログ出力には BaseCallbackHandler、完全なトレースツリーが必要な場合は BaseTracer と、目的に応じた拡張ポイントを使い分けられる。

### 同期的 Run 登録によるレースコンディション回避

`CallbackManager.handleLLMStart` で、BaseTracer 型ハンドラに対しては `_createRunForLLMStart` を **同期的に** 呼び出してから、非同期コールバック処理を `consumeCallback` 経由で実行する。

```typescript
// libs/langchain-core/src/callbacks/manager.ts:689-727
if (isBaseTracer(handler)) {
  // Create and add run to the run map.
  // We do this synchronously to avoid race conditions
  // when callbacks are backgrounded.
  handler._createRunForLLMStart(
    llm,
    [prompt],
    runId_,
    this._parentRunId,
    extraParams,
    this.tags,
    this.metadata,
    runName,
  );
}
return consumeCallback(async () => {
  // ... async handler call
}, handler.awaitHandlers);
```

コールバックがバックグラウンド実行される場合、Run の登録を非同期にすると後続の `handleLLMNewToken` が到着した時点で Run がまだ存在しないリスクがある。同期登録はこれを防ぐ。

### inheritableHandlers と handlers の分離

CallbackManager は `handlers`（現在のスコープにのみ適用）と `inheritableHandlers`（子にも継承される）を分離管理する。`addHandler(handler, inherit = true)` のデフォルトは継承可能だが、`copy()` 経由で追加されるローカルハンドラは `inherit = false` で追加される。

```typescript
// libs/langchain-core/src/callbacks/manager.ts:1214-1219
callbackManager = callbackManager.copy(
  Array.isArray(localHandlers)
    ? localHandlers.map(ensureHandler)
    : localHandlers?.handlers,
  false, // ローカルハンドラは子に継承されない
);
```

これにより、リクエストスコープのデバッグ用ハンドラが意図せず子の実行全体に伝播することを防いでいる。

### consumeCallback によるバックグラウンド/フォアグラウンド切り替え

`consumeCallback` は `wait` パラメータに応じて 2 つの実行モードを提供する。

```typescript
// libs/langchain-core/src/singletons/callbacks.ts:34-58
export async function consumeCallback<T>(
  promiseFn: () => Promise<T> | T | void,
  wait: boolean,
): Promise<void> {
  if (wait === true) {
    const asyncLocalStorageInstance = getGlobalAsyncLocalStorageInstance();
    if (asyncLocalStorageInstance !== undefined) {
      await asyncLocalStorageInstance.run(undefined, async () => promiseFn());
    } else {
      await promiseFn();
    }
  } else {
    queue = getQueue();
    void queue.add(async () => {
      // ... バックグラウンドキューに追加
    });
  }
}
```

重要な点は、コールバック実行時に AsyncLocalStorage のコンテキストを `undefined` にクリアすることで、コールバック内から `ensureConfig` が呼ばれた際に親 Run のコンテキストを誤って継承しないようにしている。

### registerConfigureHook による動的ハンドラ注入

`registerConfigureHook` は環境変数またはコンテキスト変数に基づいて、すべての Run に自動的にハンドラを注入する仕組み。

```typescript
// libs/langchain-core/src/singletons/async_local_storage/context.ts:188-195
export const registerConfigureHook = (config: ConfigureHook) => {
  if (config.envVar && !config.handlerClass) {
    throw new Error(
      "If envVar is set, handlerClass must also be set to a non-None value.",
    );
  }
  setContextVariable(LC_CONFIGURE_HOOKS_KEY, [..._getConfigureHooks(), config]);
};
```

これは AOP（Aspect-Oriented Programming）的なアプローチであり、アプリケーションコードを変更せずにオブザーバビリティレイヤーを差し込める。

### streamEvents による統一ストリーミング

`streamEvents` は `EventStreamCallbackHandler`（BaseTracer 拡張）をコールバックとして注入し、全実行ステップのイベントを `TransformStream` 経由でストリーミングする。`_includeRun` メソッドでタグ・名前・タイプによるフィルタリングを提供し、`tapOutputIterable` で出力ストリームをインターセプトする。

## コード例

```typescript
// libs/langchain-core/src/callbacks/base.ts:372-373
// バックグラウンド実行のデフォルト値。環境変数で反転可能
awaitHandlers = getEnvironmentVariable("LANGCHAIN_CALLBACKS_BACKGROUND") === "false";
```

```typescript
// libs/langchain-core/src/runnables/base.ts:359-392
// _callWithConfig: Runnable 実行のコールバック統合パターン
protected async _callWithConfig<T extends RunInput>(
  func: ((input: T, config?: Partial<CallOptions>,
          runManager?: CallbackManagerForChainRun) => Promise<RunOutput>),
  input: T,
  options?: Partial<CallOptions> & { runType?: string }
) {
  const config = ensureConfig(options);
  const callbackManager_ = await getCallbackManagerForConfig(config);
  const runManager = await callbackManager_?.handleChainStart(
    this.toJSON(), _coerceToDict(input, "input"),
    config.runId, config?.runType, undefined, undefined,
    config?.runName ?? this.getName()
  );
  delete config.runId;
  let output;
  try {
    const promise = func.call(this, input, config, runManager);
    output = await raceWithSignal(promise, options?.signal);
  } catch (e) {
    await runManager?.handleChainError(e);
    throw e;
  }
  await runManager?.handleChainEnd(_coerceToDict(output, "output"));
  return output;
}
```

```typescript
// libs/langchain-core/src/tracers/root_listener.ts:4-69
// RootListenersTracer: onStart/onEnd/onError のシンプルなフック
export class RootListenersTracer extends BaseTracer {
  name = "RootListenersTracer";
  rootId?: string;
  // ...
  async onRunCreate(run: Run) {
    if (this.rootId) return; // ルート Run のみをキャプチャ
    this.rootId = run.id;
    if (this.argOnStart) await this.argOnStart(run, this.config);
  }
  async onRunUpdate(run: Run) {
    if (run.id !== this.rootId) return; // ルート以外は無視
    if (!run.error) {
      if (this.argOnEnd) await this.argOnEnd(run, this.config);
    } else if (this.argOnError) {
      await this.argOnError(run, this.config);
    }
  }
}
```

## パターンカタログ

- **Observer パターン** (分類: 振る舞い)
  - 解決する問題: 実行コンポーネントとオブザーバビリティ層の結合を排除する
  - 適用条件: 複数の異なる監視手段（コンソール、外部サービス、ストリーミング）を同時にサポートする必要がある場合
  - コード例: `libs/langchain-core/src/callbacks/manager.ts:261-301` — CallbackManagerForLLMRun が全ハンドラに通知
  - 注意点: ハンドラ数が増えると `Promise.all` のオーバーヘッドが発生。バックグラウンド実行で緩和

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: トレーサーの共通ロジック（Run の組み立て、親子関係管理）を基底クラスに集約する
  - 適用条件: Run ツリーの構築ロジックを統一しつつ、永続化（persistRun）やイベントフック（onLLMStart 等）を実装ごとに変えたい場合
  - コード例: `libs/langchain-core/src/tracers/base.ts:90-824` — BaseTracer が handle* を実装し、on* をサブクラスに委譲
  - 注意点: `persistRun` は legacy メソッドとして残存し、新しいトレーサーでは空実装にする必要がある

- **Chain of Responsibility パターン** (分類: 振る舞い)
  - 解決する問題: 階層的な実行において、コールバックコンテキストを自動伝播する
  - 適用条件: 親 Runnable が子 Runnable を呼び出す際に `getChild()` で子用の CallbackManager を生成
  - コード例: `libs/langchain-core/src/callbacks/manager.ts:380-390` — getChild による継承チェーン
  - 注意点: `inherit = false` で追加されたハンドラは子に伝播しない点に注意

## Good Patterns

- **Start/End/Error の三つ組ライフサイクル**: すべてのコンポーネントタイプ（LLM, Chain, Tool, Retriever）で `handleXStart` / `handleXEnd` / `handleXError` を一貫して定義している。これにより、あらゆるコンポーネントに対して同一のオブザーバビリティ手法が適用できる。

```typescript
// libs/langchain-core/src/callbacks/base.ts:62-116
handleLLMStart?(...): Promise<any> | any;
handleLLMNewToken?(...): Promise<any> | any;
handleLLMError?(...): Promise<any> | any;
handleLLMEnd?(...): Promise<any> | any;
```

- **ignoreX フィルタによる選択的監視**: `BaseCallbackHandlerInput` で `ignoreLLM`, `ignoreChain`, `ignoreAgent`, `ignoreRetriever` を提供し、ハンドラごとに関心のあるイベントだけを受信できる。不要なイベント処理を事前にスキップし、パフォーマンスと可読性を両立する。

```typescript
// libs/langchain-core/src/callbacks/base.ts:28-36
export interface BaseCallbackHandlerInput {
  ignoreLLM?: boolean;
  ignoreChain?: boolean;
  ignoreAgent?: boolean;
  ignoreRetriever?: boolean;
  ignoreCustomEvent?: boolean;
  _awaitHandler?: boolean;
  raiseError?: boolean;
}
```

- **fromMethods による軽量ハンドラ生成**: クラスを定義せずにオブジェクトリテラルからハンドラを生成できる `BaseCallbackHandler.fromMethods()` と `CallbackManager.fromHandlers()` を提供。プロトタイピングやテスト時に便利。

```typescript
// libs/langchain-core/src/callbacks/base.ts:405-415
static fromMethods(methods: CallbackHandlerMethods) {
  class Handler extends BaseCallbackHandler {
    name = uuid.v7();
    constructor() {
      super();
      Object.assign(this, methods);
    }
  }
  return new Handler();
}
```

## Anti-Patterns / 注意点

- **AsyncLocalStorage 依存によるプラットフォーム制約**: Node.js の `AsyncLocalStorage` に依存する暗黙的コンテキスト伝播は、ブラウザ環境では利用できない。Web 環境では明示的に config を渡す必要がある。

```typescript
// Bad: ブラウザ環境で暗黙的コンテキストに依存
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
await dispatchCustomEvent("my_event", data); // AsyncLocalStorage 必須

// Better: 明示的に config を渡す
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch/web";
await dispatchCustomEvent("my_event", data, config);
```

- **runId の暗黙的消費**: `_callWithConfig` 内で `delete config.runId` が行われるため、同じ config オブジェクトを再利用すると意図しない挙動になる。config は呼び出しごとに新規生成するか、`ensureConfig` で正規化すべき。

```typescript
// Bad: config を使い回す
const config = { runId: "my-id", callbacks: [...] };
await chain1.invoke(input, config);
await chain2.invoke(input, config);  // runId が消えている

// Better: 呼び出しごとにスプレッドする
await chain1.invoke(input, { ...config });
await chain2.invoke(input, { ...config });
```

- **バックグラウンドコールバックのテスト時の罠**: デフォルトのバックグラウンド実行モードでは、テスト終了時にコールバックが未完了の可能性がある。テストでは `awaitAllCallbacks()` を明示的に呼ぶか、`LANGCHAIN_CALLBACKS_BACKGROUND=false` を設定する必要がある。

```typescript
// Bad: テストでバックグラウンドコールバックを待たない
await chain.invoke(input, { callbacks: [handler] });
expect(handler.calls).toBe(1); // まだ実行されていない可能性

// Better: awaitAllCallbacks で待機
await chain.invoke(input, { callbacks: [handler] });
await awaitAllCallbacks();
expect(handler.calls).toBe(1);
```

## 導出ルール

- `[MUST]` コールバック/オブザーバビリティ層は本体処理のエラーを黙殺し、本体の例外フローに介入しない — ハンドラ内の例外がアプリケーションロジックを中断させないために、try-catch + warn ログがデフォルト動作であるべき
  - 根拠: `libs/langchain-core/src/callbacks/manager.ts:119-143` ですべてのハンドラ呼び出しが try-catch で囲まれ、`raiseError` フラグが明示されない限り warn に留めている

- `[MUST]` バックグラウンド実行されるコールバックから共有ミュータブル状態を参照する場合、登録処理は同期的に行う — 非同期コールバックがキューに入る前に状態（Run Map 等）が初期化されていないとレースコンディションが発生する
  - 根拠: `libs/langchain-core/src/callbacks/manager.ts:689-703` で BaseTracer の `_createRunForLLMStart` を同期呼び出しし、Run 登録をバックグラウンド処理より先に完了させている

- `[SHOULD]` イベントハンドラインターフェースは Start/End/Error の三つ組で定義し、すべてのコンポーネントタイプに一貫して適用する — ライフサイクルの開始・正常終了・異常終了を統一的に捕捉できれば、監視ツールの実装コストが大幅に下がる
  - 根拠: `libs/langchain-core/src/callbacks/base.ts:57-278` で LLM/Chain/Tool/Retriever すべてが同一の三つ組パターンで定義されている

- `[SHOULD]` オブザーバビリティのコンテキスト（トレース ID、タグ、メタデータ）は「継承可能」と「ローカル」を明確に区別して管理する — リクエストスコープのデバッグ用ハンドラが子コンポーネントに意図せず伝播すると、トレースノイズやパフォーマンス低下を招く
  - 根拠: `libs/langchain-core/src/callbacks/manager.ts:621-624` で `handlers` と `inheritableHandlers` を分離し、`addHandler` の `inherit` パラメータでスコープを制御している

- `[SHOULD]` コールバック実行時は親のコンテキスト（AsyncLocalStorage 等）をクリアして実行する — コールバック内でコンテキスト参照関数が呼ばれた場合、親 Run のコンテキストを誤って継承し、無限ループや二重登録を引き起こすリスクがある
  - 根拠: `libs/langchain-core/src/singletons/callbacks.ts:40-43` で `asyncLocalStorageInstance.run(undefined, ...)` によりコンテキストをクリアしている

- `[AVOID]` 同一の設定オブジェクトを複数の呼び出しで使い回す — 内部処理（`delete config.runId`, `delete config.timeout`）がオブジェクトをミューテートするため、予期しない状態変化が起きる
  - 根拠: `libs/langchain-core/src/runnables/base.ts:381`, `libs/langchain-core/src/runnables/config.ts:211` で config のプロパティが delete される

## 適用チェックリスト

- [ ] イベントハンドラ基底クラスに Start/End/Error の三つ組が定義されているか
- [ ] ハンドラ内の例外がアプリケーションロジックに伝播しない防御的 try-catch があるか
- [ ] バックグラウンド実行とフォアグラウンド実行を切り替える仕組みがあるか（環境変数やフラグ）
- [ ] 継承可能なコンテキスト（タグ、メタデータ）とローカルスコープのコンテキストが分離されているか
- [ ] コールバック実行時に親のコンテキスト（スレッドローカル等）を汚染しない仕組みがあるか
- [ ] 共有状態（Run Map 等）へのバックグラウンド書き込み前に同期的な初期化ステップがあるか
- [ ] テストコードで非同期コールバックの完了を明示的に待機しているか（`awaitAllCallbacks` 相当）
- [ ] 設定オブジェクトの再利用による意図しないミューテーションを避けているか
