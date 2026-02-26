# Workflow: Recording & Replay Testing

> 出典: [repos/vercel/chat/testing-practices](../repos/vercel/chat/testing-practices.md), [repos/vercel/chat/ci-cd](../repos/vercel/chat/ci-cd.md)
> カテゴリ: workflow

## 概要

本番環境に到達した webhook ペイロードを Redis に録画し、JSON フィクスチャとしてエクスポートし、統合テストで再生するワークフロー。モック作成時に人が想像するペイロード構造ではなく、プラットフォームが実際に送信した構造をそのままテストに使うことで、API ドキュメントと実装の乖離や、プラットフォーム固有のエッジケースを確実に検出する。

## 背景・文脈

vercel/chat は Slack・Teams・Google Chat・Discord の 4 プラットフォームの webhook を統合する SDK である。各プラットフォームの webhook フォーマットは微妙に異なり、ドキュメント通りではないフィールドや、イベントタイプごとの構造差異が存在する。手作りのモックペイロードではこれらの差異を再現できず、本番で初めて発覚するバグが生まれやすい。

この問題に対し、vercel/chat は以下のワークフローを確立している:

1. 本番デプロイ時に `RECORDING_ENABLED=true` を設定し、webhook を Redis に録画
2. CLI ツールで録画セッションをエクスポート
3. `jq` でプラットフォーム別にペイロードを分離・加工
4. `fixtures/replay/` に JSON フィクスチャとして保存
5. replay テストで再生・検証

## 実装パターン

### 1. Recorder クラス（本番録画インフラ）

```typescript
// examples/nextjs-chat/src/lib/recorder.ts:100-121
class Recorder {
  private readonly redis: RedisClientType | null = null;
  private readonly sessionId: string;
  private readonly enabled: boolean;

  constructor() {
    this.enabled = process.env.RECORDING_ENABLED === "true";
    this.sessionId = process.env.RECORDING_SESSION_ID
      || `session-${process.env.VERCEL_GIT_COMMIT_SHA || "local"}`;

    if (this.enabled && process.env.REDIS_URL) {
      this.redis = createClient({ url: process.env.REDIS_URL });
      this.redis.on("error", (err) => console.error("[recorder] Redis error:", err));
    }
  }
}
```

セッション ID に `VERCEL_GIT_COMMIT_SHA` を含めることで、特定のデプロイと録画を紐付けられる。

### 2. Webhook の録画

```typescript
// examples/nextjs-chat/src/lib/recorder.ts:149-172
async recordWebhook(platform: string, request: Request): Promise<void> {
  if (!(this.isEnabled && this.redis)) {
    return;
  }

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

`request.clone()` でリクエストボディを非破壊的に読み取る点がポイント。本番の webhook 処理に影響を与えない。

### 3. Redis への保存と TTL

```typescript
// examples/nextjs-chat/src/lib/recorder.ts:92,229-241
const RECORDING_TTL_SECONDS = 1 * 60 * 60; // 1 hour

private async appendRecord(record: RecordEntry): Promise<void> {
  if (!this.redis) {
    return;
  }
  try {
    await this.ensureConnected();
    await this.redis.rPush(this.redisKey, JSON.stringify(record));
    await this.redis.expire(this.redisKey, RECORDING_TTL_SECONDS);
  } catch (err) {
    console.error("[recorder] Failed to record:", err);
  }
}
```

Redis の List 型にレコードを追加し、TTL で自動削除する。録画データの蓄積によるストレージ圧迫を防ぐ。

### 4. フィクスチャ JSON の構造

```json
// packages/integration-tests/fixtures/replay/slack.json
{
  "botName": "Chat SDK ExampleBot",
  "botUserId": "U00FAKEBOT01",
  "mention": {
    "token": "xAbCdEfGhIjKlMnOpQrStUvW",
    "team_id": "T00FAKE00AA",
    "event": {
      "type": "message",
      "user": "U00FAKEUSER1",
      "ts": "1767224888.280449",
      "text": "<@U00FAKEBOT01> Hey",
      "channel": "C00FAKECHAN1"
    },
    "type": "event_callback",
    "authorizations": [{ "user_id": "U00FAKEBOT01", "is_bot": true }]
  },
  "followUp": {
    "token": "xAbCdEfGhIjKlMnOpQrStUvW",
    "event": {
      "type": "message",
      "user": "U00FAKEUSER1",
      "text": "Hi",
      "thread_ts": "1767224888.280449",
      "channel": "C00FAKECHAN1"
    },
    "type": "event_callback"
  }
}
```

ユーザー ID やチャネル ID は `U00FAKEUSER1`, `C00FAKECHAN1` のようにダミー値に置換されている。

### 5. TestContext パターンによるテストセットアップの集約

```typescript
// packages/integration-tests/src/replay-test-utils.ts:161-302
export function createSlackTestContext(
  fixtures: { botName: string; botUserId: string; },
  handlers: {
    onMention?: (thread: Thread, message: Message) => void | Promise<void>;
    onSubscribed?: (thread: Thread, message: Message) => void | Promise<void>;
  },
): SlackTestContext {
  const adapter = createSlackAdapter({
    botToken: SLACK_BOT_TOKEN,
    signingSecret: SLACK_SIGNING_SECRET,
    botUserId: fixtures.botUserId,
  });
  const mockClient = createMockSlackClient();
  injectMockSlackClient(adapter, mockClient);

  const chat = new Chat({
    userName: fixtures.botName,
    adapters: { slack: adapter },
    state: createMemoryState(),
  });
  // ハンドラ登録・キャプチャ設定...

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

### 6. Replay テスト本体

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

テストは「フィクスチャを送信し、キャプチャされたメッセージを検証する」の 2 ステップのみ。セットアップの複雑さは TestContext に隠蔽されている。

## Good Example

```typescript
// packages/integration-tests/src/replay.test.ts:75-91
// Good: 本番録画フィクスチャでメンション→フォローアップの2段階フローを再生
it("should replay follow-up with correct message properties", async () => {
  // 1. メンションでスレッド購読
  await ctx.sendWebhook(slackFixtures.mention);
  vi.clearAllMocks();

  // 2. 同一スレッドのフォローアップを再生
  await ctx.sendWebhook(slackFixtures.followUp);

  expectValidFollowUp(ctx.captured, {
    text: "Hi",
    adapterName: "slack",
  });
  // スレッド ID が一致することを検証（本番データなので thread_ts が正確）
  expect(ctx.captured.followUpThread?.id).toContain("1767224888.280449");

  expectSentMessage(ctx.mockClient, "Processing...");
  expectUpdatedMessage(ctx.mockClient, "Thanks for your message");
});
```

本番から録画した実際の `thread_ts` でスレッドの連続性を検証できる。手書きフィクスチャでは、こうした ID の整合性を正しく維持するのが困難。

## Bad Example

```typescript
// Bad: テストごとにペイロードを手書きで構築
it("should handle @mention", async () => {
  // プラットフォームのドキュメントを見ながら手で作ったペイロード
  const payload = {
    type: "event_callback",
    event: {
      type: "app_mention", // 実際は "message" + authorizations で判定
      user: "U123",
      text: "<@UBOT> hello",
      channel: "C456",
      ts: "1234567890.123456",
    },
  };
  await handleWebhook(payload);
  // ...
});
// 問題点:
// - event.type が "app_mention" だが、実際の Slack は "message" で送ってくることがある
// - authorizations フィールドが欠落している
// - token, team_id, api_app_id などの付随フィールドが欠落
// - thread_ts の形式が不正確（本番では小数点以下6桁の Slack タイムスタンプ）
```

```typescript
// Good: 本番録画を使う
import slackFixtures from "../fixtures/replay/slack.json";

it("should handle @mention", async () => {
  await ctx.sendWebhook(slackFixtures.mention);

  expectValidMention(ctx.captured, {
    textContains: "Hey",
    authorUserId: "U00FAKEUSER1",
    adapterName: "slack",
  });
});
// 利点:
// - ペイロード構造が本番と完全一致
// - 付随フィールド（token, authorizations 等）がすべて含まれている
// - thread_ts の形式が正しい
```

## 適用ガイド

### どのような状況で使うべきか

- 外部プラットフォームの webhook を受信・処理するシステム（チャットボット、決済、CI/CD、CMS のフック等）
- プラットフォームの API ドキュメントが不完全、または実際の挙動と乖離している場合
- 複数プラットフォームの webhook フォーマット差異をテストする必要がある場合

### 導入手順

1. **Recorder を実装する**: 環境変数で有効化でき、無効時はノーオペレーションになる設計にする。Redis やファイルシステムにレコードを保存する
2. **本番の webhook ハンドラに録画処理を差し込む**: `request.clone()` で非破壊的に読み取る
3. **CLI エクスポートツールを用意する**: `pnpm recording:list` / `pnpm recording:export <sessionId>` のようなコマンドで録画を取得できるようにする
4. **機密情報を除去する**: ユーザー ID、トークン、内部 URL をダミー値に置換する
5. **フィクスチャ JSON として保存する**: イベントタイプ別（mention, followUp, action, reaction 等）に構造化する
6. **TestContext パターンでテスト基盤を整備する**: セットアップコードを集約し、テストは「送信→検証」だけにする

### 注意点

- **機密情報の除去は必須**: Recorder はヘッダーの機密値を redact するが、ボディ内の情報（トークン、実ユーザー ID、メールアドレス等）は手動でダミー値に置換する必要がある
- **録画データの鮮度管理**: プラットフォーム API が変更されるとフィクスチャが古くなる。定期的に再録画し、テストが最新の構造に追従しているか確認する
- **Redis の TTL 設定**: 録画データには短い TTL（vercel/chat では 1 時間）を設定し、不要データの蓄積を防ぐ
- **CI では録画を無効化する**: `RECORDING_ENABLED=false` を設定し、CI ではフィクスチャの再生のみ行う

### カスタマイズポイント

- **保存先**: Redis 以外にもファイルシステムや S3 に保存する選択肢がある。ローカル開発ではファイル保存が手軽
- **withRecording Proxy パターン**: 受信 webhook だけでなく、送信 API コールも録画できる（`examples/nextjs-chat/src/lib/recorder.ts:428-470`）。リクエスト/レスポンスの対を記録することで、より完全な再生テストが書ける
- **WaitUntil トラッカー**: serverless 環境の非同期処理をテスト可能にする `createWaitUntilTracker()` パターンは、replay テスト以外にも汎用的に活用できる（`packages/integration-tests/src/test-scenarios.ts:13-24`）

## 参考

- [repos/vercel/chat/testing-practices.md](../repos/vercel/chat/testing-practices.md) -- テスト戦略の全体像
- [repos/vercel/chat/ci-cd.md](../repos/vercel/chat/ci-cd.md) -- CI/CD パイプラインにおける録画・再生の位置付け
