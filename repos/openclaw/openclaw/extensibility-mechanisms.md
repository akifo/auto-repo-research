# Extensibility Mechanisms

> リポジトリ: openclaw/openclaw
> 分析日: 2026-02-14

## 概要

OpenClaw は AI エージェント基盤として、プラグイン・チャネル・フック・スキルという4つの拡張軸を持つ。193k+ Stars の大規模プロジェクトでありながら、34+ の拡張チャネルと 60+ のスキルを「契約ベース」で統合している点が注目に値する。プラグイン SDK は型付きインターフェースを公開し、jiti による動的ローディングで TypeScript ソースを直接実行する。拡張の各層（discovery -> manifest -> load -> register -> runtime）が明確に分離されており、拡張ポイントごとに登録 API を提供する「Registrar パターン」が一貫して適用されている。

## 背景にある原則

- **契約ファーストの拡張設計**: プラグインはコアの内部実装を直接参照せず、`OpenClawPluginApi` という明示的な API 契約を通じてのみ機能を登録する。プラグインが何をできるか（ツール、フック、チャネル、CLI、HTTP ルート等）は API の型定義で網羅的に宣言されており、コアの変更がプラグインに波及しにくい（`src/plugins/types.ts` 全体）。拡張ポイントが増えても API に `register*` メソッドを追加するだけで済む設計は、Open-Closed Principle の実践。

- **多層ディスカバリによる疎結合**: プラグインは bundled / global / workspace / config の4つの origin から自動検出される（`src/plugins/discovery.ts:301-364`）。検出、マニフェスト読み取り、ロード、登録が別々のフェーズに分離されているため、各フェーズを独立にテスト・拡張できる。拡張を追加するのにコアのコード変更が不要であるべき、という原則が徹底されている。

- **アダプターの細粒度分割**: チャネルプラグイン（`ChannelPlugin`）は20以上のオプショナルアダプター（`config`, `setup`, `pairing`, `security`, `groups`, `outbound`, `status`, `gateway`, `auth`, `streaming`, `threading` 等）で構成される（`src/channels/plugins/types.plugin.ts`）。全てをオプショナルにすることで、最小限の実装で参加でき、段階的に機能を追加できる。

- **マニフェスト駆動のメタデータ分離**: プラグインの静的情報（ID、設定スキーマ、UI ヒント、チャネル定義）は `openclaw.plugin.json` と `package.json` に宣言的に記述される。コードをロード・実行せずにプラグイン一覧や設定バリデーションを行えるため、起動時間とエラー分離が改善される。

## 実例と分析

### プラグイン API: 統一された登録インターフェース

`OpenClawPluginApi` は11種類の `register*` メソッドを持つ統一 API であり、全ての拡張ポイントへの唯一のエントリポイントとなっている。

```typescript
// src/plugins/types.ts:244-283
export type OpenClawPluginApi = {
  id: string;
  name: string;
  config: OpenClawConfig;
  pluginConfig?: Record<string, unknown>;
  runtime: PluginRuntime;
  logger: PluginLogger;
  registerTool: (tool: AnyAgentTool | OpenClawPluginToolFactory, opts?) => void;
  registerHook: (events: string | string[], handler: InternalHookHandler, opts?) => void;
  registerHttpHandler: (handler: OpenClawPluginHttpHandler) => void;
  registerHttpRoute: (params: { path: string; handler: OpenClawPluginHttpRouteHandler }) => void;
  registerChannel: (registration: OpenClawPluginChannelRegistration | ChannelPlugin) => void;
  registerGatewayMethod: (method: string, handler: GatewayRequestHandler) => void;
  registerCli: (registrar: OpenClawPluginCliRegistrar, opts?) => void;
  registerService: (service: OpenClawPluginService) => void;
  registerProvider: (provider: ProviderPlugin) => void;
  registerCommand: (command: OpenClawPluginCommandDefinition) => void;
  on: <K extends PluginHookName>(hookName: K, handler: PluginHookHandlerMap[K], opts?) => void;
};
```

各プラグインは `register(api)` 関数でこの API を受け取り、必要な機能のみ登録する。voice-call プラグインは同一の `register` 関数内で `registerGatewayMethod`（6回）、`registerTool`、`registerCli`、`registerService` を呼び出す（`extensions/voice-call/index.ts:148-508`）。一方、msteams はチャネル登録のみ（`extensions/msteams/index.ts:11-14`）。

### チャネルプラグインのアダプターパターン

`ChannelPlugin` 型は約20のオプショナルアダプターフィールドを持つ。各アダプターは独立した型として定義されている。

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
  outbound?: ChannelOutboundAdapter;
  status?: ChannelStatusAdapter<ResolvedAccount, Probe, Audit>;
  gateway?: ChannelGatewayAdapter<ResolvedAccount>;
  auth?: ChannelAuthAdapter;
  streaming?: ChannelStreamingAdapter;
  threading?: ChannelThreadingAdapter;
  messaging?: ChannelMessagingAdapter;
  directory?: ChannelDirectoryAdapter;
  resolver?: ChannelResolverAdapter;
  actions?: ChannelMessageActionAdapter;
  heartbeat?: ChannelHeartbeatAdapter;
  agentTools?: ChannelAgentToolFactory | ChannelAgentTool[];
  // ...
};
```

必須は `id`, `meta`, `capabilities`, `config` のみ。残りは全てオプショナルであり、チャネルの能力に応じて段階的に実装する設計。

### フックシステム: イベント駆動の二重レイヤー

フックは内部イベントシステム（`InternalHook`）と型付きプラグインフック（`PluginHookHandlerMap`）の二重構造を持つ。

内部フックは文字列キー `type:action`（例: `command:new`）で登録される Observer パターン。

```typescript
// src/hooks/internal-hooks.ts:123-143
export async function triggerInternalHook(event: InternalHookEvent): Promise<void> {
  const typeHandlers = handlers.get(event.type) ?? [];
  const specificHandlers = handlers.get(`${event.type}:${event.action}`) ?? [];
  const allHandlers = [...typeHandlers, ...specificHandlers];
  for (const handler of allHandlers) {
    try {
      await handler(event);
    } catch (err) {
      console.error(`Hook error [${event.type}:${event.action}]:`, ...);
    }
  }
}
```

一方、プラグインフックは15種類のライフサイクルイベント（`before_agent_start`, `message_sending`, `before_tool_call` 等）に型安全なハンドラーを登録する。`message_sending` や `before_tool_call` のような一部のフックは結果を返すことでイベントを変更・ブロックできる（`src/plugins/types.ts:496-554`）。

### ディスカバリ: 4層の優先度による解決

プラグインは4つの origin から検出され、`config > workspace > global > bundled` の優先度で解決される。

```typescript
// src/plugins/discovery.ts:301-364
export function discoverOpenClawPlugins(params) {
  // 1. config: extraPaths で明示指定されたパス
  for (const extraPath of extra) {
    discoverFromPath({ rawPath: trimmed, origin: "config", ... });
  }
  // 2. workspace: .openclaw/extensions/
  if (workspaceDir) {
    discoverInDirectory({ dir: workspaceExtDirs, origin: "workspace", ... });
  }
  // 3. global: ~/.openclaw/extensions/
  discoverInDirectory({ dir: globalDir, origin: "global", ... });
  // 4. bundled: 同梱プラグイン
  discoverInDirectory({ dir: bundledDir, origin: "bundled", ... });
}
```

フックも同様に `extra < bundled < managed < workspace` の優先度で、後のソースが前のソースを上書きする（`src/hooks/workspace.ts:230-243`）。

### jiti による動的ロード + SDK エイリアス

プラグインは `jiti`（JIT TypeScript loader）でロードされ、`openclaw/plugin-sdk` を実際のソースパスにエイリアスすることで、ビルドなしに TypeScript 拡張を直接実行できる。

```typescript
// src/plugins/loader.ts:214-222
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  extensions: [".ts", ".tsx", ".mts", ".cts", ...],
  ...(pluginSdkAlias
    ? { alias: { "openclaw/plugin-sdk": pluginSdkAlias } }
    : {}),
});
```

プラグインは `devDependencies` に `openclaw: "workspace:*"` を配置し、本番では jiti のエイリアスで解決される（`extensions/msteams/package.json:14-16`）。

### HOOK.md + frontmatter によるスキル宣言

フックはディレクトリベースの慣習（`HOOK.md` + `handler.ts`）で宣言される。`HOOK.md` の YAML frontmatter がメタデータ（イベント、要件、プラットフォーム制約）を記述する。

```yaml
# src/hooks/bundled/session-memory/HOOK.md
---
name: session-memory
description: "Save session context to memory when /new command is issued"
metadata:
  openclaw:
    emoji: "\U0001F4BE"
    events: ["command:new"]
    requires: { config: ["workspace.dir"] }
    install: [{ id: "bundled", kind: "bundled", label: "Bundled with OpenClaw" }]
---
```

`requires` フィールドで bins / env / config の前提条件を宣言でき、条件を満たさないフックは自動的にスキップされる（`src/hooks/config.ts:89-170`）。

## パターンカタログ

- **Registry パターン** (構造)
  - 解決する問題: 拡張ポイントの型安全な集約と重複検出
  - 適用条件: 複数のプラグインが同種の機能を登録し、ランタイムで一括参照する必要がある場合
  - コード例: `src/plugins/registry.ts:146-515` — `createPluginRegistry` が tools / hooks / channels / providers 等のレジストリを一元管理
  - 注意点: 重複登録（同一 gateway method 等）は診断メッセージで報告し、先勝ちで解決

- **Adapter パターン** (構造)
  - 解決する問題: チャネルごとに異なる能力を統一インターフェースで扱う
  - 適用条件: 同一ドメインの拡張が機能の部分集合を実装する場合
  - コード例: `src/channels/plugins/types.plugin.ts:48-84` — 20+ のオプショナルアダプター
  - 注意点: 必須フィールドを最小限にすることが段階的採用の鍵

- **Observer パターン** (振る舞い)
  - 解決する問題: ライフサイクルイベントへの拡張ポイント提供
  - 適用条件: コアのフローを変更せず、外部からの監視・介入を許可する場合
  - コード例: `src/hooks/internal-hooks.ts:67-72` — `registerInternalHook` によるイベント購読
  - 注意点: エラーハンドリングを各ハンドラーで隔離し、一つの失敗が他を止めない

- **Service Locator / Module Discovery パターン** (生成)
  - 解決する問題: プラグインをコードに列挙せず、ファイルシステムから自動検出する
  - 適用条件: プラグインの追加・削除をコアのコード変更なしに行いたい場合
  - コード例: `src/plugins/discovery.ts:115-201` — ディレクトリ走査 + package.json 解析
  - 注意点: 検出順序が優先度を決めるため、ドキュメントで明示する

## Good Patterns

- **Facade API で拡張の複雑さを隠蔽**: `OpenClawPluginApi` はプラグインにとっての唯一のインターフェース。11種類の `register*` メソッドが内部の複雑な登録ロジック（重複チェック、診断生成、型正規化）を完全に隠蔽している。プラグイン作者はレジストリ構造やイベントシステムの内部を知る必要がない。

```typescript
// extensions/msteams/index.ts:11-14 — 最小のプラグイン実装
register(api: OpenClawPluginApi) {
  setMSTeamsRuntime(api.runtime);
  api.registerChannel({ plugin: msteamsPlugin });
},
```

- **オプショナルアダプターによる段階的採用**: `ChannelPlugin` の必須フィールドは4つのみ。新しいチャネルを追加する開発者は最低限の実装で動作を確認し、`pairing`, `threading`, `directory` 等を後から追加できる。全アダプターが独立した型として定義されているため、IDE の補完で何が実装可能か即座にわかる。

- **マニフェストによるコードロード前のバリデーション**: `openclaw.plugin.json` で `configSchema` を JSON Schema として宣言することで、プラグインコードをロード・実行せずに設定バリデーションを完了できる。不正な設定のプラグインはロードされずにエラー状態になり、他のプラグインに影響しない（`src/plugins/loader.ts:367-386`）。

- **フック個別のエラー隔離**: `triggerInternalHook` は各ハンドラーを try/catch で囲み、一つのフックの失敗が他のフックやコアフローを止めない（`src/hooks/internal-hooks.ts:133-142`）。

## Anti-Patterns / 注意点

- **PluginRuntime の肥大化**: `PluginRuntime` 型は350行以上にわたり、チャネル固有のメソッド（`discord.*`, `slack.*`, `telegram.*` 等）を大量に含む（`src/plugins/runtime/types.ts`）。プラグイン API が特定チャネルの実装詳細に依存する形になっており、新チャネル追加のたびに PluginRuntime を拡張する必要がある。

```typescript
// Bad: コアランタイムに全チャネルの実装が露出
export type PluginRuntime = {
  channel: {
    discord: { sendMessageDiscord: ...; probeDiscord: ...; /* 12+ methods */ };
    slack: { sendMessageSlack: ...; /* 10+ methods */ };
    // ... 全チャネル分
  };
};
```

```typescript
// Better: チャネル固有のメソッドはチャネルプラグインが自前で管理
// PluginRuntime には共通ユーティリティのみ公開
export type PluginRuntime = {
  channel: {
    text: { /* 共通テキスト処理 */ };
    reply: { /* 共通返信ロジック */ };
    routing: { /* 共通ルーティング */ };
  };
};
```

- **同期 register で非同期を無視**: プラグインの `register` 関数が Promise を返した場合、実行結果を待たずに警告のみ出す（`src/plugins/loader.ts:416-419`）。非同期初期化が必要なプラグインは `registerService` + lazy runtime パターンで対処しているが、この制約がドキュメントで明示されていないと、プラグイン作者が非同期 register を書いて暗黙的に失敗するリスクがある。

## 導出ルール

- `[MUST]` プラグインシステムでは、拡張が利用できる操作を単一の API オブジェクト（Facade）として明示的に定義する。プラグインがコア内部を直接参照すると、コア変更時に全プラグインが壊れる
  - 根拠: `OpenClawPluginApi` が唯一の契約として機能し、34+ の拡張がコアの内部構造を知らずに動作している（`src/plugins/types.ts:244-283`）

- `[MUST]` イベントフックのハンドラーは個別に try/catch で隔離し、一つのハンドラーの例外が他のハンドラーやコアのフローを停止させない
  - 根拠: `triggerInternalHook` の実装で全ハンドラーが隔離されている（`src/hooks/internal-hooks.ts:133-142`）

- `[SHOULD]` プラグインのメタデータ（ID、設定スキーマ、能力宣言）はコードとは別のマニフェストファイルに分離し、コードをロード・実行せずにバリデーションやカタログ生成を可能にする
  - 根拠: `openclaw.plugin.json` によりコードロード前に設定バリデーションと重複検出が行われている（`src/plugins/manifest-registry.ts`）

- `[SHOULD]` 複数の拡張ソース（bundled / global / workspace / config）を持つ場合、検出順序と優先度を明確に定義し、後勝ち・先勝ちのルールをドキュメント化する
  - 根拠: ディスカバリとフック解決の両方で `workspace > managed > bundled > extra` の一貫した優先度が適用されている（`src/plugins/discovery.ts:301-364`, `src/hooks/workspace.ts:230-243`）

- `[SHOULD]` 拡張インターフェースのフィールドは大部分をオプショナルにし、必須は最小限（ID + メタデータ + 基本機能）にとどめることで、段階的な実装を可能にする
  - 根拠: `ChannelPlugin` 型は20以上のアダプターを持つが必須は4つのみ。msteams は最小実装、voice-call は豊富な実装と、同一インターフェースで段階的に機能を追加している

- `[SHOULD]` プラグインの登録は同期的に行い、非同期の初期化が必要な場合はサービスやファクトリーの lazy 初期化パターンで遅延させる
  - 根拠: voice-call プラグインの `ensureRuntime` パターン — `register` は同期的にファクトリーを登録し、実際のランタイム生成は初回呼び出し時に遅延実行される（`extensions/voice-call/index.ts:166-186`）

- `[AVOID]` 拡張のランタイムオブジェクトに特定の拡張実装のメソッドを直接露出すること。共通ランタイムが肥大化し、新しい拡張追加のたびにコアの型定義変更が必要になる
  - 根拠: `PluginRuntime` が全チャネルの送信・監視メソッドを含み350行超に肥大化している（`src/plugins/runtime/types.ts`）

## 適用チェックリスト

- [ ] プラグインが利用できる操作を単一のインターフェース（Plugin API / Facade）として定義しているか
- [ ] プラグインのメタデータ（ID、設定スキーマ、能力宣言）をマニフェストファイルに分離しているか
- [ ] プラグイン検出の優先度（bundled < global < workspace 等）を定義・ドキュメント化しているか
- [ ] 拡張インターフェースの必須フィールドが最小限で、段階的な実装が可能か
- [ ] イベントフックのハンドラーが個別にエラー隔離されているか
- [ ] プラグイン登録は同期的で、重い初期化は lazy パターンに分離されているか
- [ ] 共通ランタイムが特定の拡張実装に依存せず、汎用的な共通ユーティリティのみ公開しているか
- [ ] プラグインの設定バリデーションがコードロード前に実行されるか
- [ ] 重複登録（同一 ID、同一ルート等）が検出・報告される仕組みがあるか
