# Messaging Integration Patterns

> リポジトリ: openclaw/openclaw
> 分析日: 2026-02-14

## 概要

20 以上のメッセージングチャネル（Telegram, WhatsApp, Discord, Slack, Signal, iMessage, Matrix, MS Teams, IRC 等）を単一のコードベースで統合するアーキテクチャを分析する。各チャネルはプロトコル・API・制約が大きく異なるにもかかわらず、共通の型契約とプラグインシステムを介してルーティング・認可・送信を統一的に処理している。チャネル数がスケールしても共有ロジックの変更が最小限で済む設計は、マルチプロバイダ統合一般に適用可能な知見を含む。

## 背景にある原則

- **軽量メタデータと重量実装の分離**: 共有コードパス（ルーティング、認可、コマンド判定）はチャネルの「軽量メタデータ」（`dock.ts` の `ChannelDock`）のみに依存し、チャネル固有の重い実装（モニタ、WebSocket 接続、QR ログイン等）をロードしない。`dock.ts:82-87` のコメント「keep this module _light_」「shared code should import from here, not from the plugins registry」がこの判断を明示している。これにより起動時間と循環依存を抑制できる。

- **契約による拡張、条件分岐による拡張の排除**: 新チャネル追加時に `if (channel === "xxx")` の条件分岐を共有ロジックに追加しない。代わりに `ChannelPlugin` 型（`types.plugin.ts`）が 20 以上のアダプタスロットを定義し、チャネルはスロットを実装するだけで機能を宣言する。`ChannelCapabilities` の `chatTypes`, `polls`, `reactions`, `threads` 等のフラグが機能の有無を表現し、共有コードはこのフラグに基づいて振る舞いを切り替える。

- **正規化による多様性の吸収**: チャネルごとに異なる ID 体系（WhatsApp の JID、Discord のスノーフレーク ID、Matrix の `@user:server`）を `normalizeAccountId`, `normalizeChannelId`, `normalizeWhatsAppTarget` 等の正規化関数群で統一的に処理する。`session-key.ts` の `normalizeAgentId` は `[^a-z0-9_-]` を `-` に置換して 64 文字に切り詰める統一ルールを適用している（`session-key.ts:80-92`）。

- **セキュリティ境界の共有と特化の階層化**: 許可リスト（`allowFrom`）、メンション要求（`requireMention`）、コマンド認可（`commandGating`）はチャネル横断の共通フレームワークとして存在し、各チャネルはフォーマット関数（`formatAllowFrom`）だけを提供する。共通ルールをチャネル固有の知識で上書きする「共通デフォルト + チャネル特化オーバーライド」パターンを採用している。

## 実例と分析

### 三層のチャネル抽象化

コードベースはチャネル統合を三層に分離している。

**第1層: Registry（メタデータ）** — `src/channels/registry.ts` は ID、ラベル、エイリアス、表示順のみを保持する。`CHAT_CHANNEL_ORDER` 配列がチャネルの正規順序を定義し、`CHAT_CHANNEL_ALIASES`（`imsg` -> `imessage` 等）で入力の揺れを吸収する。

**第2層: Dock（軽量行動定義）** — `src/channels/dock.ts` は各チャネルの capabilities、outbound chunk limit、streaming coalesce 設定、allowFrom 解決ロジック、threading 設定を保持するが、重い依存を import しない。共有コードパス（reply flow、コマンド認可、サンドボックス説明）はこの層のみに依存する。

**第3層: Plugin（完全実装）** — `src/channels/plugins/*.ts` と `extensions/*/src/channel.ts` が `ChannelPlugin` 型を実装する。gateway 起動、onboarding ウィザード、status probe 等の重い処理はここに集約される。`src/channels/plugins/index.ts:8-9` のコメント「This module is intentionally "heavy"」「Shared code paths should depend on dock.ts instead」がこの分離を明文化している。

### プラグインシステムによる拡張

拡張チャネルは `extensions/*/index.ts` でエントリポイントを定義し、`api.registerChannel({ plugin })` で登録する。例えば Matrix 拡張（`extensions/matrix/index.ts:11-14`）:

```typescript
// extensions/matrix/index.ts:11-14
register(api: OpenClawPluginApi) {
    setMatrixRuntime(api.runtime);
    api.registerChannel({ plugin: matrixPlugin });
},
```

`createPluginRegistry`（`src/plugins/registry.ts:328-354`）の `registerChannel` は ID の重複チェックと診断ログを行い、登録された plugin は `PluginChannelRegistration` として `registry.channels` に追加される。全てのチャネルが同じ `ChannelPlugin` 型契約を満たすため、コアの共有ロジックは拡張チャネルとビルトインチャネルを区別しない。

### Capabilities ベースの機能宣言

各チャネルは `ChannelCapabilities`（`types.core.ts:169-182`）で機能を宣言する:

```typescript
// src/channels/plugins/types.core.ts:169-182
export type ChannelCapabilities = {
  chatTypes: Array<ChatType | "thread">;
  polls?: boolean;
  reactions?: boolean;
  edit?: boolean;
  unsend?: boolean;
  reply?: boolean;
  effects?: boolean;
  groupManagement?: boolean;
  threads?: boolean;
  media?: boolean;
  nativeCommands?: boolean;
  blockStreaming?: boolean;
};
```

Discord は `polls: true, reactions: true, media: true, threads: true`、IRC は `media: true, blockStreaming: true` のみ。共有コードは capabilities を確認してから機能を利用するため、非対応機能の呼び出しが構造的に防止される。

### Adapter Slot パターン

`ChannelPlugin`（`types.plugin.ts:48-84`）は 20 以上の optional なアダプタスロットを定義する:

```typescript
// src/channels/plugins/types.plugin.ts:48-84
export type ChannelPlugin<ResolvedAccount = any, Probe = unknown, Audit = unknown> = {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  config: ChannelConfigAdapter<ResolvedAccount>;
  setup?: ChannelSetupAdapter;
  pairing?: ChannelPairingAdapter;
  security?: ChannelSecurityAdapter<ResolvedAccount>;
  groups?: ChannelGroupAdapter;
  mentions?: ChannelMentionAdapter;
  outbound?: ChannelOutboundAdapter;
  gateway?: ChannelGatewayAdapter<ResolvedAccount>;
  threading?: ChannelThreadingAdapter;
  messaging?: ChannelMessagingAdapter;
  directory?: ChannelDirectoryAdapter;
  actions?: ChannelMessageActionAdapter;
  heartbeat?: ChannelHeartbeatAdapter;
  // ...
};
```

各アダプタは小さい型（例: `ChannelPairingAdapter` は `idLabel` + `normalizeAllowEntry` + `notifyApproval` の 3 フィールド）に分割されている。チャネルは必要なスロットだけを実装すればよい。

### メッセージコンテキストの正規化

`MsgContext`（`src/auto-reply/templating.ts:13-140+`）は全チャネルの受信メッセージを共通構造に正規化する。`Body`, `From`, `To`, `SenderId`, `SenderName`, `ChatType`, `Provider` 等の 60 以上のフィールドを持ち、チャネル固有の情報（`MessageThreadId`, `IsForum`, `Sticker` 等）も optional フィールドとして吸収する。

### ルーティングの階層的バインディング解決

`resolveAgentRoute`（`src/routing/resolve-route.ts:287-405`）はメッセージのルーティング先エージェントを 7 段階の優先度で解決する:

```typescript
// src/routing/resolve-route.ts:335-385
const tiers: Array<{...}> = [
    { matchedBy: "binding.peer", ... },
    { matchedBy: "binding.peer.parent", ... },
    { matchedBy: "binding.guild+roles", ... },
    { matchedBy: "binding.guild", ... },
    { matchedBy: "binding.team", ... },
    { matchedBy: "binding.account", ... },
    { matchedBy: "binding.channel", ... },
];
```

最も具体的なバインディング（peer 単位）から最も汎用的なもの（channel 単位）へフォールバックし、どれもマッチしなければデフォルトエージェントを返す。この段階的解決により、チャネル固有のルーティング要件を汎用フレームワーク内で表現できる。

### 送信制約のチャネル別キャリブレーション

`ChannelDock` の `outbound.textChunkLimit` は各チャネルの制約を反映する:

- Discord: 2000 文字（`dock.ts:189`）
- IRC: 350 文字（`dock.ts:226`）
- Telegram / WhatsApp / Slack / Signal: 4000 文字

ストリーミング設定も同様にチャネル別に調整されている。Discord は `minChars: 1500, idleMs: 1000`（`dock.ts:191`）、IRC は `minChars: 300, idleMs: 1000`（`dock.ts:228`）。AGENTS.md は「Never send streaming/partial replies to external messaging surfaces」と明記しており、`blockStreaming` capability がこれを構造的に実現する。

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: チャネルごとに異なるメッセージ送信、認可、正規化のアルゴリズムを統一的に扱う
  - 適用条件: 同一インターフェースの下で振る舞いがプロバイダごとに異なる場合
  - コード例: `ChannelOutboundAdapter`（`types.adapters.ts:90-107`）の `sendText` / `sendMedia` / `sendPayload` スロット
  - 注意点: スロット数が増えすぎると型定義が肥大化する。optional スロットで緩和しているが、必須スロット（`config`）と任意スロットの区別が重要

- **Registry パターン** (分類: 構造)
  - 解決する問題: チャネルの動的な追加・発見・解決を中央集約的に管理する
  - 適用条件: 実行時にプラグインが登録され、ID ベースで検索される場合
  - コード例: `PluginRegistry`（`src/plugins/registry.ts:124-138`）の `channels` 配列と `registerChannel` 関数
  - 注意点: キャッシュ無効化の管理が必要（`src/channels/plugins/load.ts:8-14` の `ensureCacheForRegistry`）

- **Chain of Responsibility パターン** (分類: 振る舞い)
  - 解決する問題: 複数の解決戦略（direct match, parent match, wildcard）を優先度順に試行する
  - 適用条件: 段階的フォールバックでリクエストを処理する場合
  - コード例: `resolveChannelEntryMatchWithFallback`（`channel-config.ts:82-163`）の direct -> parent -> wildcard フォールバック
  - 注意点: フォールバック段階が増えると挙動の予測が困難になる。`matchSource` フィールドでデバッグ支援を提供している

## Good Patterns

- **Dock / Plugin 分離による Import コスト制御**: 共有コードは軽量な `dock.ts` のみに依存し、重い `plugins/index.ts` は実行境界でのみロードする。`loadChannelPlugin`（`plugins/load.ts:16-29`）はキャッシュ付き遅延ロードを実装し、同一プラグインの重複ロードを防止する。これにより起動時間が短縮され、循環依存のリスクが低下する。

```typescript
// src/channels/plugins/outbound/load.ts:5-9
// Channel docking: outbound sends should stay cheap to import.
// The full channel plugins pull in status, onboarding, gateway monitors, etc.
// Outbound delivery only needs chunking + send primitives,
// so we keep a dedicated, lightweight loader here.
const cache = new Map<ChannelId, ChannelOutboundAdapter>();
```

- **Capabilities フラグによる機能ネゴシエーション**: `ChannelCapabilities` の boolean フラグで機能の有無を宣言し、共有コードはフラグを確認してから機能を呼び出す。新機能追加時はフラグを追加するだけで、既存チャネルは `undefined`（= 非対応）として安全にフォールバックする。

```typescript
// src/channels/dock.ts:93-100 (Telegram)
capabilities: {
  chatTypes: ["direct", "group", "channel", "thread"],
  nativeCommands: true,
  blockStreaming: true,
},
// src/channels/dock.ts:379-380 (Signal)
capabilities: {
  chatTypes: ["direct", "group"],
  reactions: true, media: true,
},
```

- **エイリアス + 正規化による入力の揺れ吸収**: `CHAT_CHANNEL_ALIASES`（`registry.ts:114-119`）と `normalizeChannelKey`（`registry.ts:121-124`）の組み合わせで、ユーザー入力の多様性を内部の正規 ID に集約する。`imsg` -> `imessage`、`gchat` -> `googlechat` 等のマッピングにより、設定ファイルやコマンドラインでの表記揺れを吸収する。

- **matchSource による解決経路のトレーサビリティ**: `ChannelMatchSource`（`channel-config.ts:1`）の `"direct" | "parent" | "wildcard"` と `resolvedAgentRoute` の `matchedBy` フィールドにより、どのルールがマッチしたかをデバッグ・ログで追跡できる。

## Anti-Patterns / 注意点

- **チャネル固有条件分岐の混入**: `src/infra/outbound/channel-adapters.ts` で `if (channel === "discord")` の条件分岐が存在する。チャネルが少数の場合は許容範囲だが、チャネル数がスケールすると保守コストが増大する。

```typescript
// Bad: src/infra/outbound/channel-adapters.ts:21-26
export function getChannelMessageAdapter(channel: ChannelId): ChannelMessageAdapter {
  if (channel === "discord") {
    return DISCORD_ADAPTER;
  }
  return DEFAULT_ADAPTER;
}

// Better: ChannelPlugin にアダプタスロットとして統合する
export type ChannelPlugin = {
  // ...
  messageAdapter?: ChannelMessageAdapter;
};
```

- **Dock への直接的なチャネル固有 import**: `dock.ts` は `resolveDiscordAccount`, `resolveSlackAccount` 等のチャネル固有 import を直接行っている（`dock.ts:17-41`）。Dock が「軽量」であるべき設計原則と矛盾し、新チャネル追加時に dock.ts の変更が必要になる。プラグインシステムの `buildDockFromPlugin`（`dock.ts:447-470`）はこの問題を緩和しているが、ビルトインチャネルには適用されていない。

## 導出ルール

- `[MUST]` マルチプロバイダ統合では、共有ロジックがプロバイダの「軽量メタデータ」のみに依存するよう層を分離し、重い実装（接続管理、認証フロー等）は実行境界でのみロードする
  - 根拠: `dock.ts` と `plugins/index.ts` の分離により、共有コードが不要な依存を引き込まず、起動時間と循環依存を抑制している（`dock.ts:82-87`, `plugins/index.ts:8-9`）

- `[MUST]` 各プロバイダの機能差異は boolean 型の capabilities フラグで宣言し、共有コードはフラグを確認してから機能を呼び出す。新機能追加時は optional フラグの追加で対応し、既存プロバイダのコード変更を不要にする
  - 根拠: `ChannelCapabilities`（`types.core.ts:169-182`）の optional boolean フィールドにより、20 以上のチャネルが機能の有無を安全に宣言している

- `[SHOULD]` プロバイダごとに異なる制約値（文字数上限、レート制限、ストリーミング設定等）はプロバイダのメタデータ構造体にキャリブレーション値として宣言し、共有ロジックはメタデータから値を読み取って動的に調整する
  - 根拠: `ChannelDock.outbound.textChunkLimit`（IRC: 350、Discord: 2000、Telegram: 4000）と `streaming.blockStreamingCoalesceDefaults` がチャネルごとの制約を宣言的に表現している

- `[SHOULD]` 外部入力の ID 正規化を必ず入口で行い、正規化済み ID のみを内部で流通させる。エイリアスマッピングも正規化レイヤーに集約する
  - 根拠: `normalizeAccountId`（`session-key.ts:112-128`）、`normalizeChatChannelId`（`registry.ts:138-145`）、`CHAT_CHANNEL_ALIASES`（`registry.ts:114-119`）が入力の揺れを入口で吸収し、内部ロジックの条件分岐を削減している

- `[SHOULD]` フォールバック解決（direct -> parent -> wildcard 等）の結果に解決経路メタデータ（`matchSource`, `matchedBy`）を付与し、デバッグ・ログで「なぜこのルールがマッチしたか」を追跡可能にする
  - 根拠: `ChannelMatchSource`（`channel-config.ts:1`）と `ResolvedAgentRoute.matchedBy`（`resolve-route.ts:45-53`）がマッチ経路を記録し、複雑なフォールバックチェーンのデバッグを支援している

- `[AVOID]` 共有ロジック内でプロバイダ名による `if/switch` 条件分岐を書く。代わりにアダプタスロットまたは capabilities フラグで表現する
  - 根拠: `channel-adapters.ts:21-26` の `if (channel === "discord")` はプロバイダ追加時に共有コードの変更を要求するが、`ChannelPlugin` のアダプタスロットパターンならプラグイン側の実装追加だけで済む

- `[AVOID]` 軽量メタデータ層からプロバイダ固有の重い依存を直接 import する。プロバイダ固有ロジックが必要な場合は、遅延ロード（dynamic import）またはプラグインレジストリ経由でアクセスする
  - 根拠: `dock.ts` のビルトインチャネルは `resolveDiscordAccount` 等を直接 import しており（`dock.ts:17-41`）、拡張チャネルの `buildDockFromPlugin`（`dock.ts:447-470`）パターンと非対称になっている

## 適用チェックリスト

- [ ] プロバイダ統合の共有ロジックが、プロバイダの軽量メタデータ（capabilities + 設定値）のみに依存しているか確認する
- [ ] 各プロバイダの機能差異を boolean capabilities フラグで宣言し、共有コードが `if (provider === "xxx")` を使っていないか検証する
- [ ] プロバイダごとの制約値（文字数上限、タイムアウト、レート制限）をメタデータ構造体に宣言的に定義しているか確認する
- [ ] 外部入力の ID をプロバイダ境界で正規化し、エイリアスマッピングを正規化レイヤーに集約しているか確認する
- [ ] フォールバック解決の結果に解決経路メタデータを付与し、デバッグ時に「なぜこのルールが選ばれたか」を追跡可能にしているか確認する
- [ ] プロバイダ追加時に共有ロジックの変更が不要（またはメタデータ追加のみ）であることを検証する
- [ ] 重い依存（接続管理、認証等）が遅延ロードされ、起動時間に影響しないことを確認する
