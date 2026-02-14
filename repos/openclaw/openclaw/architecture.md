# Architecture

> リポジトリ: openclaw/openclaw
> 分析日: 2026-02-14

## 概要

openclaw は「マルチチャネル AI アシスタント」を実現するために、Gateway サーバーを中心としたレイヤー構成を採用している。Telegram・Discord・Slack・WhatsApp 等のメッセージングチャネルと AI エージェントの間にゲートウェイが仲介層として立ち、チャネル抽象化・ルーティング・セッション管理を統一的に処理する。注目すべきは、チャネル実装が Plugin SDK を介した完全なプラグインとして分離されており、新チャネルの追加がコア改変なしで可能になっている点である。また、コンフィグ駆動のバインディング/ルーティング機構が、実装コードに触れずにチャネル→エージェントの振り分けを宣言的に制御する設計となっている。

## 背景にある原則

- **Mediator 集約による疎結合化**: チャネルとエージェントが互いを直接知らず、ゲートウェイが全ての仲介を担うことで N x M の結合を N + M に削減している。これにより新しいチャネル追加がエージェント側に影響しない。根拠: `src/gateway/server.impl.ts` 全体の構成 ― channelManager・nodeRegistry・agentEvent がすべてゲートウェイに集約される。

- **重量実装と軽量メタデータの分離**: チャネルの「何ができるか」(capabilities/dock) と「どう動くか」(plugin implementation) を明確に分離し、共有コードパスでは軽量メタデータのみ参照する。これにより、チャネル実装の import による不要な依存ツリーの読み込みを防ぐ。根拠: `src/channels/dock.ts:86-92` のコメント「keep this module *light*」および `src/channels/plugins/index.ts:8` の「Shared code paths should depend on dock.ts, not from the plugins registry」。

- **設定ファイルによる振る舞い制御**: ルーティング・バインディング・セキュリティポリシーをすべて Zod スキーマで検証されたコンフィグファイルで宣言的に管理する。コードデプロイなしにチャネル→エージェントのマッピングを変更可能にするため。根拠: `src/routing/resolve-route.ts` ではバインディング設定のみからルート解決を行い、ハードコードされたルーティングロジックが存在しない。

- **プラグインのアダプター契約による拡張**: 各チャネルは `ChannelPlugin` 型が定める多数のアダプターインターフェース（config・gateway・outbound・security・threading 等）に対して選択的に実装を提供する。これにより拡張側が必要な機能だけを実装すればよい。根拠: `src/channels/plugins/types.plugin.ts:48-84` の `ChannelPlugin` 型定義。

## 実例と分析

### 1. ゲートウェイ中心のレイヤー構成

`startGatewayServer` (`src/gateway/server.impl.ts:155-638`) がシステム全体の起動オーケストレーションを担う。この関数内で以下のサブシステムが順に初期化される:

1. コンフィグ読み込み・検証・マイグレーション (L170-218)
2. プラグインレジストリのロード (L230-244)
3. チャネルマネージャの生成 (L382-388)
4. ノードレジストリ・サブスクリプション管理 (L355-368)
5. WebSocket ハンドラの接続 (L472-529)
6. サイドカー群の起動 (L549-559)
7. コンフィグホットリロード監視 (L587-598)

依存の方向は一貫して「チャネル → ゲートウェイ → エージェント」である。チャネル実装はゲートウェイに登録されるが、ゲートウェイは特定のチャネルを import しない。

### 2. チャネル抽象化の二層構造

チャネルは「Dock（軽量メタデータ）」と「Plugin（重量実装）」の二層で抽象化されている。

**Dock 層** (`src/channels/dock.ts`): capabilities・outbound chunk limit・streaming defaults・threading 設定など、実装を伴わない宣言的メタデータを保持する。コア処理（メッセージ送信フロー、コマンド認可、サンドボックス説明）はこの層のみを参照する。

**Plugin 層** (`src/channels/plugins/index.ts`): 実際のチャネル起動・停止・メッセージ送受信のロジックを含む。この層は `getChannelPlugin()` を通じてのみアクセスされ、「実行境界」でのみ呼ばれるよう設計されている。

### 3. 宣言的ルーティングとバインディング

ルート解決 (`src/routing/resolve-route.ts:171-264`) は設定ベースのバインディングマッチングで行われる。優先度は明確に階層化されている:

1. `binding.peer` — 特定ピア（DM相手やチャンネルID）
2. `binding.peer.parent` — スレッドの親ピア（継承）
3. `binding.guild` — サーバー/ギルド単位
4. `binding.team` — チーム単位
5. `binding.account` — アカウント単位
6. `binding.channel` — チャネル全体
7. `default` — デフォルトエージェント

### 4. プラグインシステムによるチャネル登録

外部チャネルは `extensions/` ディレクトリに独立パッケージとして配置され、`openclaw.plugin.json` マニフェストで宣言される。

```typescript
// extensions/telegram/index.ts:1-17
import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { telegramPlugin } from "./src/channel.js";
import { setTelegramRuntime } from "./src/runtime.js";

const plugin = {
  id: "telegram",
  name: "Telegram",
  description: "Telegram channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setTelegramRuntime(api.runtime);
    api.registerChannel({ plugin: telegramPlugin as ChannelPlugin });
  },
};

export default plugin;
```

`api.registerChannel()` が呼ばれると、プラグインレジストリ (`src/plugins/registry.ts:328-354`) に登録され、ゲートウェイから利用可能になる。Discord も全く同じ構造を持つ (`extensions/discord/index.ts`)。

### 5. チャネルライフサイクル管理

`createChannelManager` (`src/gateway/server-channels.ts:64-308`) がチャネルの起動・停止・状態管理を一元的に行う。各チャネルアカウントに対して:

- `AbortController` による停止シグナル伝搬
- `ChannelAccountSnapshot` による状態追跡（running・lastError・connected）
- `Promise` ベースのタスク追跡と重複起動防止

## コード例

```typescript
// src/channels/dock.ts:86-92 — 軽量Dock層の設計意図コメント
// Channel docks: lightweight channel metadata/behavior for shared code paths.
//
// Rules:
// - keep this module *light* (no monitors, probes, puppeteer/web login, etc)
// - OK: config readers, allowFrom formatting, mention stripping patterns, threading defaults
// - shared code should import from here (and from `src/channels/registry.ts`), not from the plugins registry
```

```typescript
// src/routing/resolve-route.ts:191-213 — バインディングマッチング結果の構築
const choose = (agentId: string, matchedBy: ResolvedAgentRoute["matchedBy"]) => {
  const resolvedAgentId = pickFirstExistingAgentId(input.cfg, agentId);
  const sessionKey = buildAgentSessionKey({
    agentId: resolvedAgentId,
    channel,
    accountId,
    peer,
    dmScope,
    identityLinks,
  }).toLowerCase();
  const mainSessionKey = buildAgentMainSessionKey({
    agentId: resolvedAgentId,
    mainKey: DEFAULT_MAIN_KEY,
  }).toLowerCase();
  return { agentId: resolvedAgentId, channel, accountId, sessionKey, mainSessionKey, matchedBy };
};
```

```typescript
// src/gateway/server-close.ts:9-128 — 全サブシステムの順序付きシャットダウン
export function createGatewayCloseHandler(params: {
  bonjourStop: (() => Promise<void>) | null;
  tailscaleCleanup: (() => Promise<void>) | null;
  canvasHost: CanvasHostHandler | null;
  stopChannel: (name: ChannelId, accountId?: string) => Promise<void>;
  pluginServices: PluginServicesHandle | null;
  cron: { stop: () => void };
  heartbeatRunner: HeartbeatRunner;
  // ... (14 dependencies injected)
}) {
  return async (opts?) => {
    // discovery → canvas → channels → plugins → cron → heartbeat → ws → http の順で停止
  };
}
```

## パターンカタログ

- **Mediator パターン** (分類: 振る舞い)
  - 解決する問題: N 個のチャネル × M 個のエージェント間の直接通信を排除する
  - 適用条件: 複数の独立コンポーネントが協調動作し、結合の爆発を防ぎたい場面
  - コード例: `src/gateway/server.impl.ts` ― Gateway がすべてのチャネル・エージェント・ノード間の仲介を担う
  - 注意点: Mediator が肥大化しやすい。openclaw では server-channels.ts、server-chat.ts、server-methods.ts 等にサブ責務を分離して対処している

- **Adapter パターン** (分類: 構造)
  - 解決する問題: 異なるメッセージングプラットフォーム API を統一インターフェースで扱う
  - 適用条件: 外部システムの API が多様で、内部的に統一処理したい場面
  - コード例: `src/channels/plugins/types.plugin.ts:48-84` ― `ChannelPlugin` 型の各アダプターフィールド（config・gateway・outbound・security 等）
  - 注意点: アダプター契約を Optional フィールドで設計しているため、チャネルは必要な能力だけ実装すればよい（全実装を強制しない）

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: ルーティング解決をコードの分岐ではなく設定データで切り替える
  - 適用条件: 振る舞いの選択を実行時の設定で動的に変更したい場面
  - コード例: `src/routing/resolve-route.ts:171-264` ― バインディング設定に基づく優先度付きルート解決

## Good Patterns

- **二層抽象化（Dock / Plugin 分離）**: チャネルの「能力宣言」と「実装詳細」を分離し、共有コードパスでは軽量な Dock 層のみ参照する。モジュールの遅延ロードと不要な依存ツリーの排除を実現する。

```typescript
// src/channels/plugins/index.ts:8-9
// This module is intentionally "heavy" (plugins may import channel monitors, web login, etc).
// Shared code paths should depend on `src/channels/dock.ts` instead, and only call
// `getChannelPlugin()` at execution boundaries.
```

- **matchedBy ラベルによるルート解決の可観測性**: ルーティングの結果に「なぜこのルートが選ばれたか」をラベルとして付与する。デバッグやログで解決理由が即座に分かる。

```typescript
// src/routing/resolve-route.ts:43-51
matchedBy:
  | "binding.peer"
  | "binding.peer.parent"
  | "binding.guild"
  | "binding.team"
  | "binding.account"
  | "binding.channel"
  | "default";
```

- **AbortController によるチャネルライフサイクル制御**: 各チャネルアカウントに独立した AbortController を割り当て、停止シグナルを伝搬する。タスクの重複起動防止と確実なクリーンアップを両立する。

```typescript
// src/gateway/server-channels.ts:141-176
const abort = new AbortController();
store.aborts.set(id, abort);
setRuntime(channelId, id, { accountId: id, running: true, lastStartAt: Date.now(), lastError: null });
const task = startAccount({ cfg, accountId: id, account, runtime: channelRuntimeEnvs[channelId],
  abortSignal: abort.signal, log, getStatus: () => getRuntime(channelId, id),
  setStatus: (next) => setRuntime(channelId, id, next) });
```

## Anti-Patterns / 注意点

- **God Function 化するオーケストレーター**: `startGatewayServer` は約 480 行で、30 以上のサブシステムを初期化する。責務分離は進んでいるものの、初期化の全体像を把握するにはこの 1 関数を通読する必要がある。

```typescript
// Bad: 1 関数内で全サブシステムを順次初期化
export async function startGatewayServer(port, opts) {
  // config → plugins → channels → discovery → ws → http → reload → sidecars ...
  // 480 行の初期化コード
}

// Better: Phase オブジェクトに分割し、各フェーズを独立テスト可能にする
const phases = [
  new ConfigPhase(port, opts),
  new PluginPhase(config),
  new ChannelPhase(pluginRegistry),
  new TransportPhase(channels),
];
for (const phase of phases) await phase.execute(context);
```

- **Close ハンドラの依存爆発**: `createGatewayCloseHandler` が 14 以上のパラメータを受け取り、停止順序がハードコードされている。サブシステム追加時に close ハンドラの修正を忘れるリスクがある。

```typescript
// Bad: 停止対象をすべてパラメータとして個別に渡す
export function createGatewayCloseHandler(params: {
  bonjourStop, tailscaleCleanup, canvasHost, canvasHostServer,
  stopChannel, pluginServices, cron, heartbeatRunner, nodePresenceTimers,
  broadcast, tickInterval, healthInterval, dedupeCleanup, agentUnsub, ...
})

// Better: Disposable パターンでサブシステムが自身の停止責務を持つ
interface Disposable { dispose(): Promise<void>; priority: number; }
const disposables: Disposable[] = [];
// 起動時に登録、停止時に priority 順で dispose
```

## 導出ルール

- `[MUST]` マルチプロトコル統合ではゲートウェイ/メディエーターパターンを採用し、チャネルとコアロジック間の直接依存を排除する
  - 根拠: openclaw は Gateway が全チャネル・エージェント間の仲介を担うことで、30 以上のチャネルの追加をコア改変なしで実現している（`src/gateway/server.impl.ts`）

- `[MUST]` プラグイン/アダプターの契約型は Optional フィールドで設計し、実装側が必要な能力だけを提供できるようにする
  - 根拠: `ChannelPlugin` 型は 20 以上のアダプターフィールドを持つが、すべて Optional であり、最小限の実装（`id` + `meta` + `capabilities` + `config`）で新チャネルを登録可能（`src/channels/plugins/types.plugin.ts:48-84`）

- `[SHOULD]` 重量実装と軽量メタデータを分離し、共有コードパスでは軽量層のみ参照する
  - 根拠: openclaw は Dock（宣言的メタデータ）と Plugin（起動ロジック・外部 SDK 依存）を分離し、import コストの高い Plugin 層は実行境界でのみ呼ぶ設計を採用（`src/channels/dock.ts:86-92`）

- `[SHOULD]` ルーティングやポリシーの解決結果に「マッチ理由」ラベルを付与し、デバッグ時の可観測性を確保する
  - 根拠: `resolveAgentRoute` が `matchedBy` フィールドで「binding.peer」「binding.guild」「default」等のマッチ理由を返却し、ログやトラブルシューティングを容易にしている（`src/routing/resolve-route.ts:43-51`）

- `[SHOULD]` コンフィグ駆動のバインディングでルーティングを宣言的に制御し、コード変更なしに振る舞いを変更可能にする
  - 根拠: チャネル→エージェントのマッピングはすべて `bindings` 設定で宣言され、Zod スキーマで検証された設定ファイルから解決される（`src/routing/resolve-route.ts`、`src/routing/bindings.ts`）

- `[SHOULD]` 長寿命プロセス（チャネル接続等）には個別の AbortController を割り当て、停止シグナルの伝搬と重複起動防止を組み込む
  - 根拠: `createChannelManager` が各アカウントごとに AbortController + Promise タスクを管理し、確実な停止と状態追跡を実現（`src/gateway/server-channels.ts:96-179`）

- `[AVOID]` オーケストレーション関数を 1 つの巨大関数にまとめること。サブシステムが増えるにつれ、初期化順序の把握と停止ハンドラの保守が困難になる
  - 根拠: `startGatewayServer` は約 480 行・30+ サブシステムの初期化を 1 関数に集約しており、close ハンドラも 14 以上のパラメータを個別に受け取っている（`src/gateway/server.impl.ts`、`src/gateway/server-close.ts`）

## 適用チェックリスト

- [ ] 複数の外部プロトコル/チャネルを統合するシステムで、Mediator（ゲートウェイ）パターンによる疎結合化を検討したか
- [ ] プラグイン/アダプターの契約インターフェースを Optional フィールドで設計し、最小実装で登録可能にしているか
- [ ] 共有コードパスで参照するのは軽量メタデータ層のみか（重量実装の遅延ロードが機能しているか）
- [ ] ルーティング/ポリシー解決の結果にデバッグ用の「マッチ理由」ラベルが含まれているか
- [ ] 振る舞いの変更（ルーティング・セキュリティポリシー等）がコードデプロイなしに設定ファイルで完結するか
- [ ] 長寿命プロセスに AbortController を割り当て、グレースフルシャットダウンが確実に動作するか
- [ ] オーケストレーション関数が肥大化していないか（フェーズ分割や Disposable パターンの導入を検討）
