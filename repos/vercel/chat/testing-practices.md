# testing-practices

> リポジトリ: vercel/chat
> 分析日: 2026-02-25

## 概要

vercel/chat は Slack・Teams・Google Chat・Discord など複数のチャットプラットフォームを統合する SDK であり、テスト戦略に際立った特徴がある。ユニットテスト層では Adapter インターフェイスに対する型安全なモックアダプターを提供し、統合テスト層では本番の webhook ペイロードを録画・再生する「Recording & Replay」手法を中心に据えている。モノレポ全体を Vitest Workspace で管理し、turbo の `build -> test` 依存により、ビルド産物に対してテストが実行される構造になっている。

## 背景にある原則

- **Real-World Fidelity（本番忠実度）**: テスト用に作成した合成ペイロードではなく、本番環境から録画した実際の webhook ペイロードを再生することで、プラットフォーム API の微妙な差異やエッジケースを捕捉する。`fixtures/replay/` 配下に JSON ファイルとして保存されるフィクスチャがこれを支える（`packages/integration-tests/fixtures/replay/README.md`）。

- **Adapter Pattern による境界の切り離し**: SDK は `Adapter` インターフェイスを通じてプラットフォーム固有の依存を抽象化する。テスト時には `createMockAdapter()` で全メソッドが `vi.fn()` のモックアダプターを注入し、実際のプラットフォーム API を呼ばずにコアロジックを検証する（`packages/chat/src/mock-adapter.ts`）。

- **Test Context パターンによる Setup 共通化**: プラットフォーム毎のテストセットアップ（アダプター生成、モッククライアント注入、Chat インスタンス構成、イベントハンドラ登録）を `createSlackTestContext()` / `createTeamsTestContext()` / `createGchatTestContext()` / `createDiscordTestContext()` として一元化し、テストファイル側は「何を検証するか」に集中する（`packages/integration-tests/src/replay-test-utils.ts`）。

- **ドキュメントとコードの同期保証**: README.md 内の TypeScript コードブロックを抽出し、実際に `tsc` で型チェックするテストを設け、API ドキュメントとコードの乖離を CI で防止する（`packages/integration-tests/src/readme.test.ts`）。

## 実例と分析

### 1. 三層テスト戦略

コードベースは以下の 3 層でテストを構成する。

**Layer 1: ユニットテスト（パッケージ内 co-located）**
各パッケージの `src/` 配下に `*.test.ts` を配置。ビジネスロジック・パーサー・ユーティリティの単体検証。外部依存はすべて `vi.fn()` でモック化。

**Layer 2: アダプター統合テスト（合成ペイロード）**
`packages/integration-tests/src/{slack,teams,gchat,discord}.test.ts` で、手作りのペイロードを用いてアダプター→コア→レスポンスの一連のフローを検証。

**Layer 3: Replay テスト（本番ペイロード再生）**
`packages/integration-tests/src/replay*.test.ts` で、本番から録画した JSON フィクスチャを再生し、実際のプラットフォーム挙動との整合性を検証。

### 2. Recording & Replay ワークフロー

本番録画→テスト化の流れ:

1. `RECORDING_ENABLED=true` でデプロイ → Redis にセッション記録
2. ボットと実際にやり取り（@mention、ボタンクリック、リアクション、DM）
3. `pnpm recording:list` / `pnpm recording:export <sessionId>` で録画データ抽出
4. `jq` でプラットフォーム別に webhook ペイロードを分離
5. `fixtures/replay/` にフィクスチャ JSON として保存
6. replay テストを記述

セッション ID に `VERCEL_GIT_COMMIT_SHA` を含めることで、特定デプロイの録画を追跡可能にしている。

### 3. プラットフォーム固有モックの注入パターン

各アダプターは内部に API クライアントを保持するが、テスト時には private フィールドを直接上書きすることでモックを注入する:

- Slack: `injectMockSlackClient(adapter, mockClient)` → `(adapter as any).client = mockClient`
- Teams: `injectMockBotAdapter(adapter, mockAdapter)` → `(adapter as any).botAdapter = mockAdapter`
- Google Chat: `injectMockGoogleChatApi(adapter, mockApi)` → `(adapter as any).chatApi = mockApi`
- Discord: `setupDiscordFetchMock(api)` → `globalThis.fetch` をモンキーパッチ

### 4. WaitUntil トラッカーによる非同期処理の追跡

serverless 環境の `waitUntil` パターンをテスト可能にするため、`createWaitUntilTracker()` で非同期タスクを収集し、`waitForAll()` ですべての完了を待機する。

### 5. アサーションヘルパーによる検証の標準化

`expectValidMention()`, `expectValidFollowUp()`, `expectValidAction()`, `expectValidReaction()`, `expectSentMessage()` などの assertion helper で、プラットフォーム横断の検証ロジックを共通化している。

## コード例

### モックアダプターファクトリ

```typescript
// packages/chat/src/mock-adapter.ts:30-95
export function createMockAdapter(name = "slack"): Adapter {
  return {
    name,
    userName: `${name}-bot`,
    initialize: vi.fn().mockResolvedValue(undefined),
    handleWebhook: vi.fn().mockResolvedValue(new Response("ok")),
    postMessage: vi
      .fn()
      .mockResolvedValue({ id: "msg-1", threadId: undefined, raw: {} }),
    editMessage: vi
      .fn()
      .mockResolvedValue({ id: "msg-1", threadId: undefined, raw: {} }),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    // ... 全メソッドが vi.fn() でモック化
  };
}
```

### インメモリ StateAdapter モック

```typescript
// packages/chat/src/mock-adapter.ts:109-155
export function createMockState(): MockStateAdapter {
  const subscriptions = new Set<string>();
  const locks = new Map<string, Lock>();
  const cache = new Map<string, unknown>();

  return {
    cache,
    connect: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockImplementation(async (id: string) => {
      subscriptions.add(id);
    }),
    acquireLock: vi
      .fn()
      .mockImplementation(async (threadId: string, ttlMs: number) => {
        if (locks.has(threadId)) return null;
        const lock: Lock = {
          threadId,
          token: "test-token",
          expiresAt: Date.now() + ttlMs,
        };
        locks.set(threadId, lock);
        return lock;
      }),
    get: vi.fn().mockImplementation(async (key: string) => {
      return cache.get(key) ?? null;
    }),
    // ...
  };
}
```

### Test Context パターン

```typescript
// packages/integration-tests/src/replay-test-utils.ts:161-302
export function createSlackTestContext(
  fixtures: { botName: string; botUserId: string; },
  handlers: {
    onMention?: (thread: Thread, message: Message) => void | Promise<void>;
    onSubscribed?: (thread: Thread, message: Message) => void | Promise<void>;
    onAction?: (event: ActionEvent) => void | Promise<void>;
    onReaction?: (event: ReactionEvent) => void | Promise<void>;
  },
): SlackTestContext {
  const adapter = createSlackAdapter({/* config */});
  const mockClient = createMockSlackClient();
  injectMockSlackClient(adapter, mockClient);
  const chat = new Chat({
    userName: fixtures.botName,
    adapters: { slack: adapter },
    state: createMemoryState(),
    logger: "error",
  });
  // handlers 登録...
  const tracker = createWaitUntilTracker();
  return {
    chat,
    adapter,
    mockClient,
    tracker,
    captured,
    sendWebhook: async (fixture: unknown) => {
      await chat.webhooks.slack(
        createSignedSlackRequest(JSON.stringify(fixture)),
        { waitUntil: tracker.waitUntil },
      );
      await tracker.waitForAll();
    },
  };
}
```

### Replay テスト

```typescript
// packages/integration-tests/src/replay.test.ts:55-73
it("should replay @mention with correct message properties", async () => {
  await ctx.sendWebhook(gchatFixtures.mention);

  expectValidMention(ctx.captured, {
    textContains: "hello",
    authorUserId: "users/100000000000000000001",
    adapterName: "gchat",
  });

  expect(ctx.captured.mentionMessage?.author).toMatchObject({
    userName: "Test User",
    fullName: "Test User",
    isBot: false,
    isMe: false,
  });

  expectSentMessage(ctx.mockChatApi, "Thanks for mentioning me!");
});
```

### WaitUntil トラッカー

```typescript
// packages/integration-tests/src/test-scenarios.ts:13-24
export function createWaitUntilTracker(): WaitUntilTracker {
  const tasks: Promise<unknown>[] = [];
  return {
    waitUntil: (task: Promise<unknown>) => {
      tasks.push(task);
    },
    waitForAll: async () => {
      await Promise.all(tasks);
      tasks.length = 0;
    },
  };
}
```

### README 型チェックテスト

```typescript
// packages/integration-tests/src/readme.test.ts:176-203
it("should contain valid TypeScript that type-checks", () => {
  const readme = readFileSync(mainReadmePath, "utf-8");
  const codeBlocks = extractTypeScriptBlocks(readme);
  expect(codeBlocks.length).toBeGreaterThan(0);

  const tempDir = createTempProject(codeBlocks);
  try {
    execSync(`pnpm exec tsc --project ${tempDir}/tsconfig.json --noEmit`, {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      stdio: "pipe",
    });
  } catch (error) {
    // ... テスト失敗時にコードブロックを表示
    expect.fail(`README.md TypeScript code blocks failed type-checking:\n\n${output}`);
  }
});
```

### Recorder（本番録画インフラ）

```typescript
// examples/nextjs-chat/src/lib/recorder.ts:149-171
async recordWebhook(platform: string, request: Request): Promise<void> {
  if (!(this.isEnabled && this.redis)) return;

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body = await request.clone().text();

  const record: WebhookRecord = {
    type: "webhook",
    timestamp: Date.now(),
    platform,
    method: request.method,
    url: request.url,
    headers,
    body,
  };
  await this.appendRecord(record);
}
```

## パターンカタログ

- **Adapter Pattern** (分類: 構造)
  - 解決する問題: 複数プラットフォーム（Slack, Teams, GChat, Discord）の API 差異をコアロジックから隔離する
  - 適用条件: 同一インターフェイスを実装する複数の外部依存がある場合
  - コード例: `packages/chat/src/types.ts` - `Adapter` インターフェイス, `packages/chat/src/mock-adapter.ts:30` - `createMockAdapter()`
  - 注意点: テスト時にインターフェイスの全メソッドをモック化する必要があるため、ファクトリ関数で一元管理すべき

- **Test Context / Test Fixture Builder** (分類: テスト設計)
  - 解決する問題: 複数テストファイルで繰り返されるセットアップコードの重複
  - 適用条件: アダプター生成・モック注入・インスタンス構成が共通するテスト群
  - コード例: `packages/integration-tests/src/replay-test-utils.ts:161` - `createSlackTestContext()`
  - 注意点: Context が肥大化すると逆に複雑性の原因になる。プラットフォーム毎に分離すること

- **Recording & Replay** (分類: テスト手法)
  - 解決する問題: 合成テストデータでは再現できない、本番プラットフォーム API の挙動やペイロード形式のバリエーション
  - 適用条件: 外部 API の webhook を受信・処理するシステムのテスト
  - コード例: `examples/nextjs-chat/src/lib/recorder.ts:100` - `Recorder` クラス, `packages/integration-tests/fixtures/replay/`
  - 注意点: 機密情報の除去（ヘッダー redaction）が必須。録画データには TTL を設定し自動削除させる

- **Mock Injection via Private Field Override** (分類: テスト手法)
  - 解決する問題: 依存注入ポイントが public API にない場合のモック注入
  - 適用条件: ライブラリの内部実装にアクセスする必要があるテスト
  - コード例: `packages/integration-tests/src/slack-utils.ts:216-222` - `injectMockSlackClient()`
  - 注意点: `(adapter as any).client` のような型安全性を犠牲にする手法。biome-ignore で lint 警告を明示的に抑制している

## Good Patterns

- **インターフェイス準拠の完全モックファクトリ**: `createMockAdapter(name)` は `Adapter` インターフェイスの全メソッドを `vi.fn()` で実装し、テスト側で個別のメソッドだけを `mockImplementation()` で上書きできる。デフォルト値が妥当なため、テストは必要な部分だけをカスタマイズすればよい。

```typescript
// packages/chat/src/mock-adapter.ts:30
export function createMockAdapter(name = "slack"): Adapter {
  return {
    name,
    userName: `${name}-bot`,
    initialize: vi.fn().mockResolvedValue(undefined),
    postMessage: vi.fn().mockResolvedValue({ id: "msg-1", threadId: undefined, raw: {} }),
    // ... 全メソッドにデフォルトのモック戻り値
  };
}
```

- **Captured Messages パターン**: テストコンテキストに `captured` オブジェクトを持たせ、ハンドラ内で受信メッセージをキャプチャする。テスト側は `captured.mentionMessage` にアクセスするだけで検証できる。

```typescript
// packages/integration-tests/src/replay-test-utils.ts:131-139
export interface CapturedMessages {
  followUpMessage: Message | null;
  followUpThread: Thread | null;
  mentionMessage: Message | null;
  mentionThread: Thread | null;
}
```

- **clearMocks メソッドの組み込み**: モッククライアントに `clearMocks()` メソッドを組み込むことで、テストステップ間でモックの呼び出し履歴をリセットし、特定のステップのみの検証を可能にする。

```typescript
// packages/integration-tests/src/slack-utils.ts:185-206
clearMocks: () => {
  client.auth.test.mockClear();
  client.chat.postMessage.mockClear();
  // ... 全モックのクリア
},
```

- **Webhook リクエスト署名の自動生成**: テスト用リクエストファクトリ（`createSignedSlackRequest()`, `createDiscordWebhookRequest()`）が暗号署名を自動計算し、テスト側は署名処理を意識しない。

```typescript
// packages/integration-tests/src/replay-test-utils.ts:84-100
export function createSignedSlackRequest(body: string, contentType = "application/json"): Request {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sigBasestring = `v0:${timestamp}:${body}`;
  const signature = `v0=${createHmac("sha256", SLACK_SIGNING_SECRET).update(sigBasestring).digest("hex")}`;
  return new Request("https://example.com/webhook/slack", {
    method: "POST",
    headers: { "Content-Type": contentType, "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
    body,
  });
}
```

## Anti-Patterns / 注意点

- **Private フィールドの直接上書き**: `(adapter as any).client = mockClient` パターンは型安全性を失い、内部実装の変更に対して脆弱。biome-ignore コメントで lint 警告を抑制しているが、リファクタリング時にテストがコンパイルは通るが実行時に失敗するリスクがある。

```typescript
// Bad: private フィールドの直接上書き
export function injectMockSlackClient(adapter: SlackAdapter, mockClient: MockSlackClient): void {
  // biome-ignore lint/suspicious/noExplicitAny: accessing private field for testing
  (adapter as any).client = mockClient;
}

// Better: 依存注入ポイントをインターフェイスに含める or テスト用サブクラスを用意
export function createSlackAdapter(options: SlackAdapterOptions & { client?: SlackClient; }): SlackAdapter {
  // options.client が渡されればそれを使う（テスト用）
}
```

- **録画データの機密情報管理**: Recorder は `SENSITIVE_HEADERS` セットで一部ヘッダーを redact しているが、リクエストボディ内の認証情報（トークン、キー等）は redact していない。フィクスチャ JSON に含まれるデータがプライベートリポジトリに保存される前提のため問題にはなっていないが、公開リポジトリでは注意が必要。

## 導出ルール

- `[MUST]` 外部 API モックは Adapter インターフェイスの全メソッドを網羅するファクトリ関数で生成し、テストファイル内で個別にモックを構築しない
  - 根拠: vercel/chat では `createMockAdapter()` が 15 以上のメソッドをデフォルトモック付きで提供し、テストファイルのボイラープレートを排除している。各テストが必要な部分だけ `mockImplementation()` で上書きする設計により、インターフェイスの変更が一箇所に集約される

- `[MUST]` 統合テストのセットアップ（依存注入・インスタンス構成・ハンドラ登録）を TestContext ファクトリ関数に集約し、テスト側は「何を送信して何を検証するか」だけを記述する
  - 根拠: `createSlackTestContext()` パターンにより、replay テストファイルは平均 30-50 行に収まり、テストの意図が明確になる。セットアップコードの変更は一箇所で済む

- `[MUST]` `waitUntil` パターン（serverless の deferred execution）をテストする場合、タスク収集関数と待機関数を組み合わせたトラッカーを使い、テスト内で全非同期処理の完了を保証する
  - 根拠: `createWaitUntilTracker()` が `waitUntil` に渡された Promise を配列に蓄積し、`waitForAll()` で `Promise.all()` を呼ぶことで、非同期イベント処理の完了を待たずにアサーションを実行してしまう問題を防いでいる

- `[SHOULD]` 本番 webhook ペイロードを Recording & Replay テスト用に録画する仕組みを用意し、合成テストデータだけに頼らない
  - 根拠: vercel/chat の replay テストは、プラットフォーム API の実際のペイロード構造（Slack の `event_callback` / Teams の `Activity` / GChat の Pub/Sub 形式）を検証対象にすることで、ドキュメントと実際の挙動の乖離を検出している

- `[SHOULD]` README のコードサンプルを CI で型チェックし、ドキュメントと API の乖離を自動検出する
  - 根拠: `readme.test.ts` が Markdown からコードブロックを抽出→一時プロジェクト生成→`tsc --noEmit` で型チェックする手法により、API 変更時にドキュメント更新漏れが CI で発覚する

- `[SHOULD]` プラットフォーム横断のアサーションヘルパーを作成し、共通の検証ロジック（メッセージ構造、author フラグ、スレッド ID 形式）を一箇所に集約する
  - 根拠: `expectValidMention()`, `expectValidAction()`, `expectValidReaction()` などの assertion helper により、各プラットフォームテストで同じ検証コードを書く必要がなくなり、検証漏れが減る

- `[AVOID]` テストフィクスチャ JSON に本番の機密情報（API トークン、ユーザー ID、内部 URL）をそのまま含めること。録画時に自動 redaction し、フィクスチャ保存前にダミー値に置換する
  - 根拠: Recorder は HTTP ヘッダーの sensitive 値を redact するが、ボディ内の情報は未処理。vercel/chat ではフィクスチャ内のユーザー ID やチャネル ID を `U00FAKEUSER1`, `C00FAKECHAN1` のようにダミー値に置換している

- `[AVOID]` テスト内で `globalThis.fetch` をモンキーパッチした後、restore を忘れること。afterEach で必ず元に戻す
  - 根拠: Discord アダプターのテストでは `setupDiscordFetchMock(api)` で `globalThis.fetch` を上書きし、`restoreDiscordFetchMock()` で `afterEach` 内にて復元している。restore 漏れは他のテストに影響を与える

## 適用チェックリスト

- [ ] 外部 API との統合箇所に Adapter インターフェイスを導入し、対応するモックファクトリ関数を作成したか
- [ ] モックファクトリはインターフェイスの全メソッドにデフォルト戻り値を設定しているか
- [ ] 統合テストのセットアップを TestContext ファクトリに集約し、テスト側はフィクスチャ送信と検証のみを記述しているか
- [ ] serverless の `waitUntil` 相当の非同期処理をテストする場合、WaitUntil トラッカーを導入したか
- [ ] 本番 webhook ペイロードを録画し、replay テストとして自動化する仕組みを検討したか
- [ ] テストフィクスチャに機密情報が含まれていないことを確認したか（ダミー値に置換済みか）
- [ ] README や API ドキュメント内のコードサンプルを CI で型チェック・構文チェックしているか
- [ ] `globalThis.fetch` 等のグローバル状態をモックしている場合、afterEach で確実に restore しているか
- [ ] プラットフォーム横断の検証ロジック（メッセージ構造、author フラグ等）をアサーションヘルパーに集約しているか
