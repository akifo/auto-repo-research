# streaming-patterns

> リポジトリ: vercel/chat
> 分析日: 2026-02-25

## 概要

vercel/chat は複数のチャットプラットフォーム（Slack、Teams、Discord、Google Chat）へ統一的にストリーミング応答を配信する SDK である。プラットフォームごとにネイティブストリーミング対応の有無が異なるため、`AsyncIterable<string>` を統一インターフェースとし、ネイティブストリーミング（Slack）とフォールバック（post+edit）の二層戦略で吸収している。この設計は「プラットフォーム差異の吸収」「レート制限への防御的対処」「AI SDK とのゼロボイラープレート統合」の三つの課題を同時に解決しており、マルチバックエンド配信の汎用パターンとして注目に値する。

## 背景にある原則

- **最小公約数ではなく最大公約数で統一する**: 統一インターフェースを「全プラットフォームが共通にサポートする機能」（最小公約数）に制限せず、`AsyncIterable<string>` という抽象レベルの高い型で統一し、各プラットフォームの最適な配信方法は内部で分岐させる。これにより呼び出し側のコードはプラットフォームを意識しない（`thread.ts:321-327`）。

- **Capability Detection で分岐する**: アダプターが `stream` メソッドを持つかどうかを実行時に判定し、持つ場合はネイティブ API を使い、持たない場合はフォールバックに切り替える。TypeScript の optional method (`stream?`) で静的にも表現され、アダプター実装者は自分のプラットフォームに該当しないメソッドを実装する必要がない（`types.ts:307-311`）。

- **バックプレッシャーを尊重する非同期イテレーション**: `for await...of` と recursive `setTimeout` の組み合わせにより、プロデューサー（AI モデル）とコンシューマー（プラットフォーム API）の速度差を自然に吸収する。setInterval ではなく setTimeout を再帰的に使うことで、前の編集が完了するまで次のスケジューリングを遅延させ、遅いサービスへの過負荷を防ぐ（`thread.ts:456-524`）。

- **プレースホルダー先行で UX を担保する**: フォールバック時は最初に `"..."` プレースホルダーを投稿し、その後テキストが蓄積されるたびに編集で更新する。ユーザーにはストリーミングが始まった時点で即座にフィードバックが返り、テキスト生成の完了を待つ必要がない（`thread.ts:462`）。

## 実例と分析

### 二層ストリーミングアーキテクチャ

コアの分岐ロジックは `ThreadImpl.handleStream()` に集約される。アダプターの `stream` メソッドの有無で分岐し、呼び出し側（`post()` メソッド）は `isAsyncIterable()` 型ガードで自動検出する。

`post()` メソッドは `string | PostableMessage | CardJSXElement` を受け取るが、`PostableMessage` に `AsyncIterable<string>` が含まれているため、ストリームも文字列も同じ `post()` で受け付けられる。この設計により、AI SDK の `textStream` をそのまま渡せる:

```
await thread.post(result.textStream);
```

### AsyncIterable の型ガード

`isAsyncIterable()` は `thread.ts` と `channel.ts` の両方で定義されている。`Symbol.asyncIterator` の存在チェックで判定し、`AsyncIterable<string>` に型を絞り込む:

```typescript
// packages/chat/src/thread.ts:87-91
function isAsyncIterable(value: unknown): value is AsyncIterable<string> {
  return (
    value !== null && typeof value === "object" && Symbol.asyncIterator in value
  );
}
```

### Slack ネイティブストリーミング

Slack アダプターは `chatStream` API を使い、チャンクごとに `streamer.append()` を呼び出す。初回のみ認証トークンを渡し、最終的に `streamer.stop()` で完了する。`recipientUserId` と `recipientTeamId` が必須であり、不足時には明示的なエラーを投げる:

```typescript
// packages/adapter-slack/src/index.ts:2123-2169
async stream(
  threadId: string,
  textStream: AsyncIterable<string>,
  options?: StreamOptions
): Promise<RawMessage<unknown>> {
  if (!(options?.recipientUserId && options?.recipientTeamId)) {
    throw new ChatError(
      "Slack streaming requires recipientUserId and recipientTeamId in options",
      "MISSING_STREAM_OPTIONS"
    );
  }
  // ...
  const streamer = this.client.chatStream({ channel, thread_ts, ... });
  let first = true;
  for await (const chunk of textStream) {
    if (first) {
      await streamer.append({ markdown_text: chunk, token } as any);
      first = false;
    } else {
      await streamer.append({ markdown_text: chunk });
    }
  }
  const result = await streamer.stop(
    options?.stopBlocks ? { blocks: options.stopBlocks as any[] } : undefined
  );
  // ...
}
```

### フォールバック post+edit 実装

ネイティブストリーミングを持たないプラットフォーム（Teams、Discord、Google Chat）では `fallbackStream()` が使われる。`"..."` をまず投稿し、`setTimeout` の再帰呼び出しで定期的に蓄積テキストを `editMessage` で反映する:

```typescript
// packages/chat/src/thread.ts:456-524
private async fallbackStream(
  textStream: AsyncIterable<string>,
  options?: StreamOptions
): Promise<SentMessage> {
  const intervalMs =
    options?.updateIntervalMs ?? this._streamingUpdateIntervalMs;
  const msg = await this.adapter.postMessage(this.id, "...");
  // ...
  let accumulated = "";
  let lastEditContent = "...";
  let stopped = false;

  const doEditAndReschedule = async (): Promise<void> => {
    if (stopped) return;
    if (accumulated !== lastEditContent) {
      const content = accumulated;
      try {
        await this.adapter.editMessage(threadIdForEdits, msg.id, content);
        lastEditContent = content;
      } catch { /* Ignore errors, continue */ }
    }
    if (!stopped) {
      timerId = setTimeout(() => {
        pendingEdit = doEditAndReschedule();
      }, intervalMs);
    }
  };
  // ...
}
```

### ストリーム中のテキスト蓄積とラッピング

ネイティブストリーミング時、`handleStream()` は入力ストリームをラップして蓄積テキストを収集しつつ、チャンクはそのまま通過させる。これにより `SentMessage` の `text` フィールドに完了後のテキスト全体を持たせられる:

```typescript
// packages/chat/src/thread.ts:421-440
let accumulated = "";
const wrappedStream: AsyncIterable<string> = {
  [Symbol.asyncIterator]: () => {
    const iterator = textStream[Symbol.asyncIterator]();
    return {
      async next() {
        const result = await iterator.next();
        if (!result.done) {
          accumulated += result.value;
        }
        return result;
      },
    };
  },
};
const raw = await this.adapter.stream(this.id, wrappedStream, options);
return this.createSentMessage(raw.id, accumulated, raw.threadId);
```

### Channel レベルでの非ストリーミング降格

`ChannelImpl.post()` は `AsyncIterable<string>` を受け付けるが、チャネルレベルではストリーミング表示をサポートしない。全チャンクを蓄積してから単一メッセージとして投稿する:

```typescript
// packages/chat/src/channel.ts:242-254
async post(message: string | PostableMessage | CardJSXElement): Promise<SentMessage> {
  if (isAsyncIterable(message)) {
    let accumulated = "";
    for await (const chunk of message) {
      accumulated += chunk;
    }
    return this.postSingleMessage(accumulated);
  }
  // ...
}
```

### 設定の伝搬チェーン

`streamingUpdateIntervalMs` は `ChatConfig` → `Chat` コンストラクタ → `ThreadImpl` コンストラクタと伝搬し、`StreamOptions.updateIntervalMs` でリクエストごとの上書きも可能:

```typescript
// packages/chat/src/types.ts:55
streamingUpdateIntervalMs?: number;

// packages/chat/src/chat.ts:215
this._streamingUpdateIntervalMs = config.streamingUpdateIntervalMs ?? 500;

// packages/chat/src/chat.ts:1590
streamingUpdateIntervalMs: this._streamingUpdateIntervalMs,

// packages/chat/src/thread.ts:460-461
const intervalMs =
  options?.updateIntervalMs ?? this._streamingUpdateIntervalMs;
```

## コード例

```typescript
// packages/chat/src/thread.ts:321-327 — post() でのストリーム自動検出
async post(
  message: string | PostableMessage | CardJSXElement
): Promise<SentMessage> {
  if (isAsyncIterable(message)) {
    return this.handleStream(message);
  }
  // ...
}
```

```typescript
// packages/chat/src/thread.ts:404-444 — handleStream() の二層分岐
private async handleStream(
  textStream: AsyncIterable<string>
): Promise<SentMessage> {
  const options: StreamOptions = {};
  if (this._currentMessage) {
    options.recipientUserId = this._currentMessage.author.userId;
    const raw = this._currentMessage.raw as { team_id?: string; team?: string };
    options.recipientTeamId = raw?.team_id ?? raw?.team;
  }

  if (this.adapter.stream) {
    // Native streaming path
    let accumulated = "";
    const wrappedStream: AsyncIterable<string> = { /* ... */ };
    const raw = await this.adapter.stream(this.id, wrappedStream, options);
    return this.createSentMessage(raw.id, accumulated, raw.threadId);
  }

  // Fallback path
  return this.fallbackStream(textStream, options);
}
```

```typescript
// packages/chat/src/types.ts:307-311 — アダプターの optional stream メソッド
stream?(
  threadId: string,
  textStream: AsyncIterable<string>,
  options?: StreamOptions
): Promise<RawMessage<TRawMessage>>;
```

```typescript
// packages/chat/src/types.ts:1001-1003 — PostableMessage ユニオン型
export type PostableMessage = AdapterPostableMessage | AsyncIterable<string>;
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: プラットフォームごとに異なるストリーミング配信方法を、呼び出し側に意識させずに切り替える
  - 適用条件: 同一インターフェースの背後に複数の実装戦略が存在し、実行時に選択する必要がある場合
  - コード例: `thread.ts:404-444` — `adapter.stream` の有無で native/fallback を動的に選択
  - 注意点: 戦略の選択がコンストラクタ時ではなく呼び出し時に行われる（Capability Detection 型）

- **Decorator パターン** (分類: 構造)
  - 解決する問題: ネイティブストリーミング時にアダプターへ渡すストリームを透過的にラップし、蓄積テキストを収集する
  - 適用条件: 既存のデータフローを変更せずに付加的な処理（計測、ログ、蓄積等）を追加したい場合
  - コード例: `thread.ts:422-436` — `wrappedStream` が元の `textStream` をラップして `accumulated` を収集
  - 注意点: ラッパーは元のイテレーターのプロトコル（`next`/`done`）を完全に透過する必要がある

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: ストリーミングの全体フロー（開始 → チャンク処理 → 完了）は共通だが、配信方法の詳細はプラットフォームに依存する
  - 適用条件: アルゴリズムの骨格を固定し、一部のステップだけを差し替えたい場合
  - コード例: `thread.ts:321-327` (`post`) → `thread.ts:404-444` (`handleStream`) → native or `fallbackStream`
  - 注意点: 本実装は継承ではなく Capability Detection で実現しており、古典的な Template Method よりも疎結合

## Good Patterns

- **AsyncIterable を統一インターフェースとして採用**: `PostableMessage` 型に `AsyncIterable<string>` を含めることで、静的な文字列とストリームを同じ `post()` メソッドで処理できる。AI SDK の `textStream` をそのまま渡せるため、呼び出し側のボイラープレートがゼロになる。

```typescript
// packages/chat/src/types.ts:1001-1003
export type PostableMessage = AdapterPostableMessage | AsyncIterable<string>;

// 利用側: ストリームも文字列も同じ API
await thread.post(result.textStream); // ストリーム
await thread.post("Hello!"); // 文字列
```

- **recursive setTimeout によるバックプレッシャー対応スロットリング**: `setInterval` ではなく `setTimeout` の再帰呼び出しを使い、前の編集完了後にのみ次のタイマーをスケジュールする。遅いプラットフォーム API に対する自然なバックプレッシャーとなり、編集リクエストの積み上がりを防ぐ。

```typescript
// packages/chat/src/thread.ts:488-494
// Schedule next check after intervalMs (only after edit completes)
if (!stopped) {
  timerId = setTimeout(() => {
    pendingEdit = doEditAndReschedule();
  }, intervalMs);
}
```

- **変更検出による不要な API 呼び出しの省略**: `lastEditContent` と `accumulated` を比較し、テキストが変わっていない場合は `editMessage` をスキップする。同じ内容での無駄な API 呼び出しを防ぎ、レート制限の消費を抑える。

```typescript
// packages/chat/src/thread.ts:478-485
if (accumulated !== lastEditContent) {
  const content = accumulated;
  try {
    await this.adapter.editMessage(threadIdForEdits, msg.id, content);
    lastEditContent = content;
  } catch { /* Ignore errors, continue */ }
}
```

- **Optional Method による Capability Detection**: アダプターインターフェースの `stream?` を optional にすることで、実装者はネイティブストリーミングをサポートしない場合にメソッド自体を省略できる。呼び出し側は `if (this.adapter.stream)` で分岐し、型安全に処理を選択する。

```typescript
// packages/chat/src/types.ts:307
stream?(threadId: string, textStream: AsyncIterable<string>, options?: StreamOptions): Promise<RawMessage<TRawMessage>>;

// packages/chat/src/thread.ts:420
if (this.adapter.stream) { /* native */ } else { /* fallback */ }
```

## Anti-Patterns / 注意点

- **isAsyncIterable の重複定義**: `thread.ts:87` と `channel.ts:71` で同一の `isAsyncIterable()` 関数が独立に定義されている。共有ユーティリティに抽出すれば一元管理できる。

```typescript
// Bad: 同一関数が2ファイルに重複
// packages/chat/src/thread.ts:87-91
function isAsyncIterable(value: unknown): value is AsyncIterable<string> { ... }
// packages/chat/src/channel.ts:71-75
function isAsyncIterable(value: unknown): value is AsyncIterable<string> { ... }

// Better: 共有ユーティリティに抽出
// packages/chat/src/utils.ts
export function isAsyncIterable(value: unknown): value is AsyncIterable<string> { ... }
```

- **フォールバック時のエラー黙殺**: `fallbackStream()` の `doEditAndReschedule()` 内で `editMessage` のエラーを空の `catch` で握りつぶしている。一時的なネットワークエラーには有効だが、認証エラーや恒久的な障害も無視してしまい、デバッグが困難になりうる。

```typescript
// Bad: 全エラーを黙殺
// packages/chat/src/thread.ts:483-485
try {
  await this.adapter.editMessage(threadIdForEdits, msg.id, content);
  lastEditContent = content;
} catch { /* Ignore errors, continue */ }

// Better: ログを出しつつ続行、致命的エラーは例外として伝搬
try {
  await this.adapter.editMessage(threadIdForEdits, msg.id, content);
  lastEditContent = content;
} catch (error) {
  this.logger?.warn("Streaming edit failed", { error });
  if (isAuthError(error)) throw error;
}
```

- **StreamOptions のプラットフォーム固有フィールド混在**: `StreamOptions` に `recipientUserId`（Slack 固有）と `updateIntervalMs`（フォールバック固有）が同居している。ジェネリクスや判別ユニオン型で分離すると、プラットフォーム追加時の型安全性が向上する。

```typescript
// 現状: フラットな optional プロパティ
// packages/chat/src/types.ts:320-329
export interface StreamOptions {
  recipientTeamId?: string; // Slack only
  recipientUserId?: string; // Slack only
  stopBlocks?: unknown[]; // Slack only
  updateIntervalMs?: number; // Fallback only
}

// Better: 判別ユニオンで分離
type StreamOptions =
  | { mode: "native"; recipientUserId: string; recipientTeamId: string; stopBlocks?: unknown[]; }
  | { mode: "fallback"; updateIntervalMs?: number; };
```

## 導出ルール

- `[MUST]` マルチバックエンド配信でストリーミングを統一する場合、入力を `AsyncIterable<T>` に統一し、バックエンド固有の配信方法はインターフェース内部で切り替える
  - 根拠: `PostableMessage` 型が `AsyncIterable<string>` を含み、`post()` 内の `isAsyncIterable()` 判定で自動分岐することで、呼び出し側はバックエンドを意識しない（`thread.ts:321-327`）

- `[MUST]` フォールバック（post+edit）方式で定期更新する場合、`setInterval` ではなく recursive `setTimeout` を使い、前の更新完了後にのみ次のタイマーをスケジュールする
  - 根拠: `setInterval` では API 応答が遅い場合にリクエストが積み上がりレート制限に到達するが、recursive `setTimeout` は前回完了を待つため自然なバックプレッシャーとなる（`thread.ts:488-494`）

- `[SHOULD]` アダプター/プラグインインターフェースのオプショナル機能は optional method (`method?`) で定義し、呼び出し側で Capability Detection（`if (adapter.method)`）して分岐する
  - 根拠: `Adapter.stream?` を optional にすることで、ネイティブストリーミング非対応プラットフォームはメソッド自体を実装不要になり、新しいプラットフォーム追加の障壁を下げている（`types.ts:307-311`）

- `[SHOULD]` スロットリングされた更新ループでは、前回送信した内容と現在の蓄積内容を比較し、変化がない場合は API 呼び出しをスキップする
  - 根拠: `lastEditContent !== accumulated` チェックにより、テキストが変化していないインターバルでの不要な `editMessage` 呼び出しを省略し、レート制限の消費を抑えている（`thread.ts:478`）

- `[SHOULD]` ストリーミング開始時にプレースホルダーメッセージを先行投稿し、ユーザーに即座のフィードバックを提供する
  - 根拠: `"..."` を先に投稿してから蓄積テキストで逐次更新することで、AI 応答生成の遅延を体感的に短縮している（`thread.ts:462`）

- `[AVOID]` ストリーミング中のエラーを完全に黙殺する — 少なくともログ出力し、認証エラー等の致命的エラーは伝搬させる
  - 根拠: `fallbackStream()` の空 `catch` はデバッグを困難にする。一時的なネットワークエラーは握りつぶしても良いが、恒久的エラーの識別が必要（`thread.ts:483-485`）

## 適用チェックリスト

- [ ] ストリーミング対応と非対応のバックエンドが混在するか確認し、混在する場合は `AsyncIterable<T>` を統一入力型に採用する
- [ ] バックエンドごとのストリーミング能力を optional method で表現し、Capability Detection で分岐するようにする
- [ ] フォールバック方式（post+edit）を使う場合、`setInterval` ではなく recursive `setTimeout` でバックプレッシャーを実装する
- [ ] 更新スロットリングに変更検出を組み込み、内容が変化していない場合の不要な API 呼び出しをスキップする
- [ ] ストリーミング更新間隔をグローバル設定とリクエストごとの上書きの両方で制御できるようにする
- [ ] ストリーム開始時にプレースホルダーを先行表示し、最終更新で確定内容に置き換えるフローを実装する
- [ ] ストリーミング中のエラーハンドリングで、致命的エラー（認証、権限）と一時的エラー（ネットワーク、レート制限）を区別する
- [ ] テストでネイティブストリーミングとフォールバックの両方のパスを検証する（`adapter.stream` の有無で分岐するテスト）
