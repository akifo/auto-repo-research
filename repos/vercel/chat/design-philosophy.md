# Design Philosophy

> リポジトリ: vercel/chat
> 分析日: 2026-02-25

## 概要

vercel/chat は「Write once, deploy everywhere」を実現するための統一チャットボット SDK であり、Slack / Teams / Google Chat / Discord / GitHub / Linear の6プラットフォームに単一のボットロジックで対応する。この視点では、mdast（Markdown AST）を正規フォーマットとして選んだ技術選定の根拠、プラグイン型アーキテクチャが依存逆転をどう実現しているか、そして「共通化できるもの」と「プラットフォーム固有に残すべきもの」の境界設計を分析する。

## 背景にある原則

- **AST 正規化によるセマンティック保存の原則**: テキストフォーマットの変換において、文字列レベルの正規表現変換ではなく AST を中間表現にすることで、書式の「意味」（太字、リンク、引用など）をロスなく保持できる。各プラットフォームの独自フォーマット（Slack mrkdwn の `*bold*`、Teams HTML の `<b>bold</b>`、標準 Markdown の `**bold**`）を AST ノード `{ type: "strong" }` として統一的に扱えるため、N:N 変換が N:1 + 1:N に分解される。根拠: `packages/chat/src/markdown.ts` の `FormatConverter` インターフェースが `toAst()` / `fromAst()` の双方向変換のみを要求し、プラットフォーム間の直接変換を排除している。

- **依存逆転によるコア安定化の原則**: コアパッケージ `chat` は全てのインターフェース（`Adapter`, `StateAdapter`, `FormatConverter`）を定義し、各アダプターパッケージがコアに依存する単方向の依存構造をとる。コアは個別のプラットフォーム SDK（`@slack/web-api`, `googleapis`, `botbuilder`）を一切知らない。これにより、新しいプラットフォームの追加がコアの変更なしに行える。根拠: `packages/chat/package.json` はプラットフォーム SDK への依存を持たず、各 adapter パッケージが `"chat"` を peerDependency として参照する構造。

- **段階的フォールバック戦略の原則**: プラットフォーム間の機能差を「最低共通分母」に合わせるのではなく、高機能なプラットフォームではネイティブ機能を使い、非対応プラットフォームでは次善の方法にフォールバックする。これにより各プラットフォームのユーザー体験を最大化しつつ、ボットロジック側は統一 API で書ける。根拠: ストリーミング（Slack はネイティブ、他は post+edit フォールバック）、エフェメラルメッセージ（非対応なら DM フォールバック）、カード（非対応なら plaintext フォールバック）。

- **宣言的 UI とプラットフォームマッピングの分離**: カードやモーダルの定義を JSX/ビルダーで宣言的に記述し、プラットフォーム固有のフォーマット変換（Block Kit, Adaptive Cards, Google Chat Cards v2, Discord Embeds）をアダプター側に閉じ込める。ボットロジックは「何を表示するか」だけを記述し、「どう表示するか」はアダプターが決定する。根拠: `packages/chat/src/cards.ts` の `CardElement` 型が platform-agnostic で定義され、各アダプターの `cards.ts` が独立に変換を実装。

## 実例と分析

### mdast を正規フォーマットに選んだ技術選定

mdast は unified エコシステム（remark/rehype）の Markdown AST 仕様であり、GFM（GitHub Flavored Markdown）をネイティブにサポートする。チャットプラットフォームのテキストフォーマットは本質的に Markdown の方言であるため、mdast は自然な中間表現となる。

各アダプターの `FormatConverter` は2つのメソッドだけを実装する:

- `toAst(platformText)`: プラットフォーム固有フォーマット → mdast
- `fromAst(ast)`: mdast → プラットフォーム固有フォーマット

GitHub アダプターは mdast がそのまま GFM であるため、`toAst` / `fromAst` がほぼパススルーとなる。これは mdast を正規フォーマットに選んだ妥当性を裏付ける。

### アダプター間でのノード変換コストの非対称性

Slack mrkdwn は `*bold*`（single asterisk で太字）、標準 Markdown は `**bold**` である。Slack アダプターの `toAst()` はまず文字列レベルで `*text*` → `**text**` に変換してから `parseMarkdown()` に渡す。これは mdast パーサーが標準 Markdown を前提としているためである。

一方 `fromAst()` は AST ノードを直接走査して Slack mrkdwn を生成するため、文字列レベルの前処理が不要。この非対称性は、パース側（入力）では既存ライブラリ（remark）を活用し、シリアライズ側（出力）ではプラットフォーム固有の最適化を行うという設計判断を反映している。

### カード抽象の粒度設計

`CardElement` は6種類の子要素型（Text, Image, Divider, Actions, Section, Fields）を持つ。これは Slack Block Kit、Teams Adaptive Cards、Google Chat Cards v2 の「共通部分集合」ではなく「意味的な共通概念」を抽出したものである。

例えば Slack の `context` ブロック（灰色の補足テキスト）は CardElement では `Text({ style: "muted" })` として表現し、Slack アダプターがこれを `context` ブロックに変換する。一方 Discord はこの概念がないため、通常テキストとして描画する。

### StateAdapter のプラグイン設計

`StateAdapter` インターフェースは5つの機能グループを統合する:

1. サブスクリプション管理（`subscribe` / `unsubscribe` / `isSubscribed`）
2. 分散ロック（`acquireLock` / `releaseLock` / `extendLock`）
3. 汎用キャッシュ（`get` / `set` / `delete`）
4. ライフサイクル（`connect` / `disconnect`）

`MemoryStateAdapter` は開発用、`RedisStateAdapter` は本番用として提供される。ステート管理をコアのクラスではなく外部アダプターに委譲することで、ステートレスな環境（Vercel Functions）でもステートフルな振る舞い（スレッドのサブスクリプション追跡）を実現できる。

### ストリーミングの二層戦略

`ThreadImpl.handleStream()` は以下の分岐を持つ:

1. アダプターが `stream()` メソッドを持つ → ネイティブストリーミング（Slack）
2. 持たない → `fallbackStream()` で post + edit（Teams, Google Chat, Discord）

フォールバック実装では `setTimeout` による再帰的な編集スケジューリングを使い、前回の edit が完了してから次の update をスケジュールする。これにより遅いプラットフォーム API に対してリクエストが累積することを防いでいる。

## コード例

```typescript
// packages/chat/src/markdown.ts:291-308
// FormatConverter: AST を正規フォーマットとする双方向変換インターフェース
export interface FormatConverter {
  extractPlainText(platformText: string): string;
  fromAst(ast: Root): string;
  toAst(platformText: string): Root;
}
```

```typescript
// packages/adapter-slack/src/markdown.ts:34-69
// Slack アダプターの FormatConverter 実装
export class SlackFormatConverter extends BaseFormatConverter {
  fromAst(ast: Root): string {
    return this.fromAstWithNodeConverter(ast, (node) => this.nodeToMrkdwn(node));
  }
  toAst(mrkdwn: string): Root {
    let markdown = mrkdwn;
    // Slack mrkdwn → 標準 Markdown への正規化
    markdown = markdown.replace(/<@([^|>]+)\|([^>]+)>/g, "@$2");
    markdown = markdown.replace(/(?<![_*\\])\*([^*\n]+)\*(?![_*])/g, "**$1**");
    markdown = markdown.replace(/(?<!~)~([^~\n]+)~(?!~)/g, "~~$1~~");
    return parseMarkdown(markdown);
  }
}
```

```typescript
// packages/adapter-github/src/markdown.ts:19-36
// GitHub アダプターは GFM がそのまま mdast と対応するため、ほぼパススルー
export class GitHubFormatConverter extends BaseFormatConverter {
  fromAst(ast: Root): string {
    return stringifyMarkdown(ast).trim();
  }
  toAst(markdown: string): Root {
    return parseMarkdown(markdown);
  }
}
```

```typescript
// packages/chat/src/thread.ts:404-443
// ストリーミング: ネイティブ対応の分岐とフォールバック
private async handleStream(
  textStream: AsyncIterable<string>
): Promise<SentMessage> {
  // ...options setup...
  if (this.adapter.stream) {
    // ネイティブストリーミング（Slack）
    const raw = await this.adapter.stream(this.id, wrappedStream, options);
    return this.createSentMessage(raw.id, accumulated, raw.threadId);
  }
  // フォールバック: post + edit with throttling
  return this.fallbackStream(textStream, options);
}
```

```typescript
// packages/chat/src/cards.ts:1-45
// カード定義: platform-agnostic な宣言的 API（function + JSX 両対応）
// Function API
await thread.post(
  Card({
    title: "Order #1234",
    children: [
      Text("Total: $50.00"),
      Actions([
        Button({ id: "approve", label: "Approve", style: "primary" }),
      ]),
    ],
  }),
);
```

```typescript
// packages/chat/src/message.ts:95-108
// Message クラス: mdast を canonical representation として保持
export class Message<TRawMessage = unknown> {
  text: string; // プレーンテキスト（検索・ログ用）
  formatted: FormattedContent; // mdast Root（正規表現）
  raw: TRawMessage; // プラットフォーム固有ペイロード（エスケープハッチ）
}
```

## パターンカタログ

- **Adapter パターン** (分類: 構造)
  - 解決する問題: 互換性のないプラットフォーム API を統一インターフェースで扱う
  - 適用条件: 同じ概念（メッセージ送信、フォーマット変換）を持つが API が異なる複数の外部サービスを統合する場合
  - コード例: `packages/chat/src/types.ts:90-314`（`Adapter` インターフェース）
  - 注意点: アダプターインターフェースは「最小公倍数」ではなく「意味的な共通概念」で設計する。optional メソッド（`stream?`, `openDM?`, `postEphemeral?`）で機能差を表現し、コアが段階的フォールバックを提供

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: フォーマット変換アルゴリズムをプラットフォームごとに差し替える
  - 適用条件: 同じインターフェース（`FormatConverter`）で振る舞いだけが異なる実装を切り替える場合
  - コード例: `packages/chat/src/markdown.ts:291-308`（`FormatConverter`）、各アダプターの `markdown.ts`
  - 注意点: `BaseFormatConverter` でテンプレートメソッド（`fromAstWithNodeConverter`）を提供し、共通の走査ロジックを再利用可能にしている

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: AST 走査の共通ロジックを基底クラスに持ち、ノード変換だけをサブクラスに委譲する
  - 適用条件: アルゴリズムの骨格は同じだが、個別ステップの実装がバリアントごとに異なる場合
  - コード例: `packages/chat/src/markdown.ts:323-345`（`BaseFormatConverter.fromAstWithNodeConverter`）
  - 注意点: 基底クラスの `renderPostable()` メソッドもテンプレートメソッドであり、メッセージ形式の判定ロジックを共通化

## Good Patterns

- **三層メッセージ表現（text / formatted / raw）**: `Message` クラスが `text`（プレーンテキスト）、`formatted`（mdast AST）、`raw`（プラットフォーム固有ペイロード）の3層を常に保持する。ボットロジックは `text` で簡易判定、`formatted` で構造的処理、`raw` でプラットフォーム固有の操作を行える。エスケープハッチとしての `raw` フィールドが抽象化の「漏れ」を安全に提供する。

```typescript
// packages/chat/src/message.ts:100-110
text: string; // 検索・パターンマッチ用
formatted: FormattedContent; // AST ベースの構造的処理用
raw: TRawMessage; // プラットフォーム固有操作用（escape hatch）
```

- **Optional メソッドによる段階的フォールバック**: `Adapter` インターフェースは必須メソッド（`postMessage`, `handleWebhook`）と optional メソッド（`stream?`, `openDM?`, `postEphemeral?`）を分離する。コアが optional メソッドの有無をランタイムで判定し、フォールバック戦略を自動適用する。これにより最小限のアダプター実装でも動作し、機能追加が漸進的に行える。

```typescript
// packages/chat/src/thread.ts:375-397
// postEphemeral: ネイティブ → DM フォールバック → null の段階的フォールバック
if (this.adapter.postEphemeral) {
  return this.adapter.postEphemeral(this.id, userId, postable);
}
if (!fallbackToDM) return null;
if (this.adapter.openDM) {
  const dmThreadId = await this.adapter.openDM(userId);
  const result = await this.adapter.postMessage(dmThreadId, postable);
  return { id: result.id, threadId: dmThreadId, usedFallback: true, raw: result.raw };
}
return null;
```

- **ワークフローエンジン連携のためのシリアライゼーション設計**: `Message` と `ThreadImpl` が `@workflow/serde` の `WORKFLOW_SERIALIZE` / `WORKFLOW_DESERIALIZE` シンボルを実装し、外部ワークフローエンジンとのシームレスな連携を可能にする。`ThreadImpl.fromJSON()` は lazy resolution（Chat シングルトン経由でアダプターを遅延解決）を使い、デシリアライズ時に完全な依存注入が不要。

```typescript
// packages/chat/src/message.ts:219-229
static [WORKFLOW_SERIALIZE](instance: Message): SerializedMessage {
  return instance.toJSON();
}
static [WORKFLOW_DESERIALIZE](data: SerializedMessage): Message {
  return Message.fromJSON(data);
}
```

## Anti-Patterns / 注意点

- **文字列レベルの正規表現変換への過度な依存**: Slack アダプターの `toAst()` は `*text*` → `**text**` の正規表現変換を行ってから mdast パーサーに渡す。この方式はネストしたフォーマット（`*bold _and italic_*`）やエスケープされた文字で誤変換のリスクがある。

```typescript
// Bad: 文字列正規表現で Slack mrkdwn → 標準 Markdown に変換
markdown = markdown.replace(/(?<![_*\\])\*([^*\n]+)\*(?![_*])/g, "**$1**");

// Better: Slack mrkdwn 専用のパーサーを実装し、直接 mdast に変換する
// ただし、工数との兼ね合いで正規表現が「十分に良い」判断は妥当
```

- **アダプター共通パッケージの中途半端な抽象化**: `@chat-adapter/shared` は `extractCard`, `extractFiles`, `cardToFallbackText` など便利ユーティリティを提供するが、各アダプターの `cards.ts` には依然として大量の重複コード（ノード走査ロジック）が存在する。共通化の粒度が「ユーティリティ関数」に留まっており、「変換パイプライン」レベルの共通化が行われていない。

```typescript
// 各アダプターの markdown.ts で同じ構造のノード走査が繰り返される
// Slack: nodeToMrkdwn(node), Discord: nodeToDiscordMarkdown(node),
// Teams: nodeToTeams(node), GChat: nodeToGChat(node)
// いずれも isParagraphNode → isTextNode → isStrongNode ... の同一分岐構造

// Better: ノード走査の共通フレームワークを提供し、ノード型ごとの変換関数のみ差し替え可能にする
```

## 導出ルール

- `[MUST]` マルチプラットフォーム対応では、プラットフォーム固有フォーマット間の直接変換（N:N）を避け、正規化された中間表現（AST 等）を介した N:1 + 1:N 変換にする
  - 根拠: vercel/chat は mdast を正規フォーマットとし、6プラットフォームの FormatConverter が toAst/fromAst の2メソッドのみ実装する設計で、変換パスの爆発を防いでいる（`packages/chat/src/markdown.ts:291-308`）

- `[MUST]` アダプターインターフェースにプラットフォーム間の機能差がある場合、optional メソッド + コア側のフォールバックロジックで吸収し、最低共通分母に機能を削らない
  - 根拠: `Adapter` インターフェースの `stream?`, `openDM?`, `postEphemeral?` が optional で、`ThreadImpl` がランタイムで有無を判定してフォールバック戦略を自動適用する（`packages/chat/src/thread.ts:375-443`）

- `[SHOULD]` 抽象化レイヤーを設けるとき、「エスケープハッチ」として下位レイヤーへの直接アクセスを提供する（ただしプライマリ API とは別のフィールドとして）
  - 根拠: `Message.raw` フィールドがプラットフォーム固有のペイロードを保持し、抽象化では表現しきれないプラットフォーム固有の操作を可能にしている（`packages/chat/src/message.ts:109`）

- `[SHOULD]` コアパッケージはインターフェース定義と共通ロジックのみを持ち、外部サービスの SDK は全てアダプターパッケージに閉じ込める（依存逆転）
  - 根拠: `chat` パッケージは `@slack/web-api`, `googleapis`, `botbuilder` 等のプラットフォーム SDK を一切参照せず、各アダプターパッケージが `chat` を peerDependency として参照する単方向依存

- `[SHOULD]` プラグインアーキテクチャでは開発用の軽量実装（in-memory）と本番用の実装（Redis 等）を同じインターフェースで提供し、環境切り替えを設定変更のみで行えるようにする
  - 根拠: `StateAdapter` インターフェースに対して `MemoryStateAdapter`（開発用）と `RedisStateAdapter`（本番用）が同じ API で提供され、`createMemoryState()` / `createRedisState()` のファクトリ関数で切り替え

- `[AVOID]` 共通アダプターの抽象化を「ユーティリティ関数の詰め合わせ」に留めず、変換パイプラインの構造自体を共通化する
  - 根拠: `@chat-adapter/shared` はユーティリティのみ提供するが、各アダプターの `markdown.ts` で同一構造の AST ノード走査が重複している。`BaseFormatConverter.fromAstWithNodeConverter()` は部分的な共通化だが、走査+分岐の全体構造は各アダプターで重複

## 適用チェックリスト

- [ ] マルチプラットフォーム対応で、正規化された中間表現（AST, IR, 共通型）を定義し、各プラットフォーム固有のフォーマットはアダプター側で変換しているか
- [ ] アダプターインターフェースの設計で、プラットフォーム間の機能差を optional メソッド + フォールバックで吸収しているか（最低共通分母への切り下げをしていないか）
- [ ] 抽象化レイヤーに「エスケープハッチ」（raw フィールド、platform-specific payload）を用意し、予期しないユースケースに対応できるか
- [ ] コアパッケージが外部サービス SDK に直接依存せず、依存逆転（DIP）が守られているか
- [ ] 開発環境と本番環境で同じインターフェースの別実装を提供し、設定のみで切り替え可能か
- [ ] 宣言的 UI 定義（カード、モーダル等）がプラットフォーム非依存で、レンダリングロジックがアダプター側に閉じているか
