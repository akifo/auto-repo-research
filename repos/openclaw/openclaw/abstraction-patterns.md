# 抽象化パターン

> リポジトリ: openclaw/openclaw
> 分析日: 2026-02-14

## 概要

OpenClaw は 30 以上のメッセージングチャネル（Telegram, Discord, Slack, WhatsApp, IRC, Matrix 等）と複数の LLM / メディアプロバイダーを単一のアーキテクチャで統合する大規模 TypeScript プロジェクトである。この視点では、DI（依存性注入）、プラグインレジストリ、アダプタ、ファクトリ、プロバイダーといった共通抽象化パターンがどのように設計・適用されているかを分析する。特筆すべきは、「Channel docking」「Provider docking」と呼ばれる独自のドッキングパターンにより、コアを変更せずに新しいチャネル・プロバイダーを追加できる拡張性を実現している点である。

## 背景にある原則

- **Lazy Loading で起動コストを最小化すべき、なぜなら多チャネル環境では使わないモジュールの読み込みが深刻なボトルネックになるため**: `createDefaultDeps()` は全チャネルの送信関数を動的 `import()` でラップし、実際に呼ばれるまでモジュールを読み込まない。テスト（`src/cli/deps.test.ts`）で「Telegram を呼ぶまで WhatsApp モジュールは未ロード」を明示的に検証している。

- **共通インターフェースで差異を吸収すべき、なぜなら N 個のバリアント（チャネル, プロバイダー）を個別に扱うと組み合わせ爆発が起きるため**: `ChannelPlugin` 型は 20 以上のオプショナルなアダプタスロット（`config`, `setup`, `outbound`, `gateway`, `pairing` 等）を持ち、各チャネルは必要なスロットだけ実装する。コア側はアダプタの存在チェックだけで全チャネルを統一的に扱える。

- **レジストリパターンで登録と解決を分離すべき、なぜならプラグインの発見・ロード・利用を疎結合に保つため**: `PluginRegistry` は tools, hooks, channels, providers, services 等のスロットを持つ集約型レジストリで、`createPluginRegistry()` が返す `createApi()` を通じてプラグインが自己登録する。解決側は `requireActivePluginRegistry()` で現在のレジストリを取得し、登録側のコードに依存しない。

- **軽量メタデータ層と重量実装層を分離すべき、なぜなら共有コードが実装の詳細（puppeteer, SDK 等）を引き込むと全体のバンドルサイズと起動時間が悪化するため**: `ChannelDock`（軽量メタデータ）と `ChannelPlugin`（フル実装）が明確に分離され、共有コードは dock だけを参照する（`src/channels/dock.ts:82-88` のコメントで方針が明文化）。

## 実例と分析

### DI パターン: createDefaultDeps による遅延注入

`src/cli/deps.ts` は DI コンテナの簡易実装である。各チャネルの送信関数を型安全なオブジェクトとして集約し、動的 import のプロキシでラップする。

```typescript
// src/cli/deps.ts:18-45
export function createDefaultDeps(): CliDeps {
  return {
    sendMessageWhatsApp: async (...args) => {
      const { sendMessageWhatsApp } = await import("../channels/web/index.js");
      return await sendMessageWhatsApp(...args);
    },
    sendMessageTelegram: async (...args) => {
      const { sendMessageTelegram } = await import("../telegram/send.js");
      return await sendMessageTelegram(...args);
    },
    // ... 他のチャネルも同様
  };
}
```

これは「Poor Man's DI」とも呼ばれるパターンだが、テスタビリティを確保しつつフレームワーク依存を回避している。`GatewayRequestContext` 型（`src/gateway/server-methods/types.ts:29`）が `deps: ReturnType<typeof createDefaultDeps>` を保持し、全ゲートウェイメソッドに注入される。

### アダプタパターン: ChannelPlugin の多面的インターフェース

`ChannelPlugin` 型（`src/channels/plugins/types.plugin.ts:48-84`）は 20 以上のオプショナルアダプタスロットを持つ。

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
  // ... 他のアダプタ
};
```

各アダプタは細粒度の型で定義されている（`types.adapters.ts` に 14 種の Adapter 型）。アダプタのジェネリクス `<ResolvedAccount>` により、チャネル固有の設定型を型安全に伝播できる。

### レジストリパターン: プラグインの集約と解決

`PluginRegistry`（`src/plugins/registry.ts:124-138`）はプラグインのあらゆる登録物を集約する。

```typescript
// src/plugins/registry.ts:124-138
export type PluginRegistry = {
  plugins: PluginRecord[];
  tools: PluginToolRegistration[];
  hooks: PluginHookRegistration[];
  typedHooks: TypedPluginHookRegistration[];
  channels: PluginChannelRegistration[];
  providers: PluginProviderRegistration[];
  gatewayHandlers: GatewayRequestHandlers;
  httpHandlers: PluginHttpRegistration[];
  httpRoutes: PluginHttpRouteRegistration[];
  cliRegistrars: PluginCliRegistration[];
  services: PluginServiceRegistration[];
  commands: PluginCommandRegistration[];
  diagnostics: PluginDiagnostic[];
};
```

レジストリの取得は `requireActivePluginRegistry()`（`src/plugins/runtime.ts:48-53`）で行われ、グローバル Symbol を使ったシングルトン保証がある。未初期化時は空レジストリを返し、null チェック地獄を回避している。

### プロバイダーパターン: MediaUnderstandingProvider

メディア理解（音声文字起こし、画像/動画説明）は `MediaUnderstandingProvider` インターフェース（`src/media-understanding/types.ts:109-115`）で抽象化されている。

```typescript
// src/media-understanding/types.ts:109-115
export type MediaUnderstandingProvider = {
  id: string;
  capabilities?: MediaUnderstandingCapability[];
  transcribeAudio?: (req: AudioTranscriptionRequest) => Promise<AudioTranscriptionResult>;
  describeVideo?: (req: VideoDescriptionRequest) => Promise<VideoDescriptionResult>;
  describeImage?: (req: ImageDescriptionRequest) => Promise<ImageDescriptionResult>;
};
```

各プロバイダーの実装は極めて薄い。例えば Groq は OpenAI 互換の音声転写関数を再利用し、ベース URL だけ変更する:

```typescript
// src/media-understanding/providers/groq/index.ts:6-14
export const groqProvider: MediaUnderstandingProvider = {
  id: "groq",
  capabilities: ["audio"],
  transcribeAudio: (req) =>
    transcribeOpenAiCompatibleAudio({
      ...req,
      baseUrl: req.baseUrl ?? DEFAULT_GROQ_AUDIO_BASE_URL,
    }),
};
```

レジストリへの登録は `buildMediaUnderstandingRegistry()`（`src/media-understanding/providers/index.ts:29-51`）が `Map<string, MediaUnderstandingProvider>` を構築し、overrides によるマージもサポートする。

### ドッキングパターン: 軽量/重量の二層構造

コードベース全体に「Channel docking」「Provider docking」というコメントが散在している（Grep で 20 箇所以上）。これは新しいチャネル/プロバイダーを追加する際に変更すべき箇所をマーキングする独自の規約である。

`ChannelDock`（`src/channels/dock.ts:44-68`）は `ChannelPlugin` から必要最小限のメタデータだけを抽出した軽量インターフェースで、共有コードのインポートコストを抑える。

```typescript
// src/channels/dock.ts:82-88
// Channel docks: lightweight channel metadata/behavior for shared code paths.
// Rules:
// - keep this module *light* (no monitors, probes, puppeteer/web login, etc)
// - OK: config readers, allowFrom formatting, mention stripping patterns, threading defaults
// - shared code should import from here (and from `src/channels/registry.ts`), not from the plugins registry
```

### プラグイン SDK: 拡張の統一エントリポイント

`src/plugin-sdk/index.ts` は内部モジュールの型を再エクスポートし、外部プラグイン（`extensions/` 配下）が `openclaw/plugin-sdk` として安定した API を参照できるようにしている。全ての extension は同一パターンに従う:

```typescript
// extensions/msteams/index.ts（典型的な extension のエントリポイント）
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { msteamsPlugin } from "./src/channel.js";

const plugin = {
  id: "msteams",
  name: "Microsoft Teams",
  register(api: OpenClawPluginApi) {
    setMSTeamsRuntime(api.runtime);
    api.registerChannel({ plugin: msteamsPlugin });
  },
};
export default plugin;
```

`OpenClawPluginApi`（`src/plugins/types.ts:244-283`）が提供する `registerChannel`, `registerTool`, `registerProvider`, `registerService` 等のメソッドにより、プラグインは自分が提供する機能を宣言的に登録する。

## パターンカタログ

- **Registry パターン** (分類: 構造)
  - 解決する問題: 動的なプラグイン発見と解決の疎結合化
  - 適用条件: 実行時にコンポーネントの種類・数が変動する場合
  - コード例: `src/plugins/registry.ts:146-515`, `src/media-understanding/providers/index.ts:29-51`
  - 注意点: レジストリがグローバルミュータブル状態になるため、テスト時のリセット機構（`resetGlobalHookRunner`）が必要

- **Adapter パターン** (分類: 構造)
  - 解決する問題: 異なるインターフェースを持つ外部サービス（各メッセージングプラットフォーム）を統一インターフェースに適合させる
  - 適用条件: N 個の外部システムを同じワークフローで扱う場合
  - コード例: `src/channels/plugins/types.adapters.ts` の 14 種のアダプタ型
  - 注意点: アダプタスロットを増やしすぎると "God Interface" になるため、オプショナルにして最小契約を維持する

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: メディア処理の実装をプロバイダーごとに切り替える
  - 適用条件: 同じ入出力型で複数の実装アルゴリズムを選択する場合
  - コード例: `src/media-understanding/types.ts:109-115` の `MediaUnderstandingProvider`
  - 注意点: capabilities フィールドで実装可能な操作を明示し、null チェックではなく能力ベースで分岐する

- **Facade パターン** (分類: 構造)
  - 解決する問題: プラグイン SDK の内部モジュール構造をプラグイン開発者から隠蔽する
  - 適用条件: 内部の複雑なモジュール構成を安定した API として公開する場合
  - コード例: `src/plugin-sdk/index.ts`（400 行の再エクスポート）
  - 注意点: 再エクスポートが増えるとバレルファイルのバンドルコストが問題になるが、プラグイン SDK はビルド時に解決されるため許容される

## Good Patterns

- **Capability-based Interface（能力ベースインターフェース）**: `MediaUnderstandingProvider` は `capabilities` フィールドで対応能力を宣言し、メソッドをオプショナルにしている。呼び出し側は capability を確認してからメソッドを呼ぶ。全メソッドを必須にする「Fat Interface」より柔軟で、新しい能力の追加が既存プロバイダーを壊さない。

```typescript
// src/media-understanding/types.ts:109-115
export type MediaUnderstandingProvider = {
  id: string;
  capabilities?: MediaUnderstandingCapability[];  // 宣言的な能力表明
  transcribeAudio?: (...) => Promise<...>;         // オプショナル
  describeVideo?: (...) => Promise<...>;           // オプショナル
  describeImage?: (...) => Promise<...>;           // オプショナル
};
```

- **Lazy Import Proxy（遅延インポートプロキシ）**: `createDefaultDeps()` は関数シグネチャを保ちつつ内部で動的 import を行う。型は静的に解決されるが、モジュールのロードは実行時に遅延される。

```typescript
// src/cli/deps.ts:20-23
sendMessageWhatsApp: async (...args) => {
  const { sendMessageWhatsApp } = await import("../channels/web/index.js");
  return await sendMessageWhatsApp(...args);
},
```

- **Docking Comment Convention（ドッキングコメント規約）**: コードベース全体に `// Channel docking: ...` / `// Provider docking: ...` というコメントを配置し、新しいチャネル/プロバイダー追加時の変更箇所を機械的に発見可能にしている。grep 可能な規約により、ドキュメントに頼らず拡張ポイントを特定できる。

- **Duplicate Registration Guard（重複登録ガード）**: レジストリの各 `register*` メソッドが重複チェックと診断出力を行い、サイレントな上書きを防ぐ。

```typescript
// src/plugins/registry.ts:356-383
const registerProvider = (record: PluginRecord, provider: ProviderPlugin) => {
  const existing = registry.providers.find((entry) => entry.provider.id === id);
  if (existing) {
    pushDiagnostic({
      level: "error",
      message: `provider already registered: ${id} (${existing.pluginId})`,
    });
    return;
  }
  // ...
};
```

## Anti-Patterns / 注意点

- **グローバルシングルトンレジストリの注意点**: `src/plugins/runtime.ts` は `Symbol.for()` でグローバル状態を保持する。テストの並列実行時に状態が干渉するリスクがある。`resetGlobalHookRunner()` のようなテスト用リセット関数が必要になる。

```typescript
// Bad: テスト間で状態が残る
const state = globalThis[REGISTRY_STATE];

// Better: テストごとにスコープ化されたレジストリを注入
function createIsolatedContext() {
  const registry = createEmptyRegistry();
  return { registry, getRegistry: () => registry };
}
```

- **バレルファイルの肥大化**: `src/plugin-sdk/index.ts` は 400 行を超える再エクスポートで構成されている。内部構造の変更が波及しにくいという利点はあるが、ツリーシェイキングが効かない環境ではバンドルサイズに影響する。モジュール分割（`openclaw/plugin-sdk/channels`, `openclaw/plugin-sdk/config` 等）が検討に値する。

## 導出ルール

- `[MUST]` 複数のバリアント（チャネル、プロバイダー等）を統合するインターフェースでは、メソッドをオプショナルにし、capabilities/feature フラグで対応能力を宣言する
  - 根拠: `MediaUnderstandingProvider` と `ChannelPlugin` の両方がこのパターンを採用しており、新バリアント追加時に既存実装への変更がゼロで済む設計を実現している（`src/media-understanding/types.ts:109-115`）

- `[MUST]` DI コンテナ経由で注入される依存は、実際に使用されるまでモジュールをロードしない遅延プロキシとして実装する
  - 根拠: `createDefaultDeps()` の動的 import パターンにより、6 チャネルのうち使われない 5 つのモジュールはロードされず、テストでこの不変条件が検証されている（`src/cli/deps.test.ts:57-78`）

- `[SHOULD]` プラグイン/拡張の追加時に変更すべき箇所を、grep 可能な定型コメント（例: `// Channel docking:`, `// Provider docking:`）でマーキングする
  - 根拠: OpenClaw では 20 箇所以上のドッキングコメントにより、新チャネル追加時の変更箇所を `grep "Channel docking"` で一覧できる（`src/channels/dock.ts:82`, `src/channels/registry.ts:5` 等）

- `[SHOULD]` 共有コードが参照するインターフェースは軽量メタデータ層（Dock）と重量実装層（Plugin）に分離し、共有コードは軽量層だけをインポートする
  - 根拠: `ChannelDock`（設定読み取り、メンション除去等の軽量操作）と `ChannelPlugin`（puppeteer, SDK 接続等の重量操作）の分離により、共有コードが重い依存を引き込むことを防いでいる（`src/channels/dock.ts:82-88`）

- `[SHOULD]` レジストリへの登録時に ID の重複チェックと診断メッセージ出力を行い、サイレントな上書きを防ぐ
  - 根拠: `registerProvider` / `registerGatewayMethod` が既存登録の重複を検出し、`pushDiagnostic()` でエラーレベルの診断を出力する（`src/plugins/registry.ts:265-285, 356-383`）

- `[AVOID]` 統合インターフェースの全メソッドを必須にすること（Fat Interface）。新バリアント追加のたびに不要なスタブ実装を強制することになる
  - 根拠: `ChannelPlugin` は `config` のみ必須で他 20 スロットはオプショナル。IRC のようにシンプルなチャネルは必要なアダプタだけ実装すれば済む（`src/channels/plugins/types.plugin.ts:48-84`）

## 適用チェックリスト

- [ ] プロジェクトに 3 つ以上の同種バリアント（プロバイダー、アダプター等）がある場合、共通インターフェースを定義し capabilities ベースのオプショナルメソッドにしているか
- [ ] DI で注入する依存が、使用時まで実際のモジュールをロードしない遅延プロキシになっているか（特に起動時間が重要なCLIツールやゲートウェイ）
- [ ] 新しいバリアント追加時に変更すべき箇所が、grep 可能なコメント規約でマーキングされているか
- [ ] 共有コードが重い実装モジュールを直接インポートしていないか（軽量メタデータ層を経由しているか）
- [ ] レジストリへの登録が重複検出とエラー報告を行っているか（サイレントな上書きが起きないか）
- [ ] プラグイン SDK のパブリック API が、内部モジュール構造の変更から隔離されているか（Facade / バレルファイルを介しているか）
- [ ] グローバルシングルトンを使用している場合、テスト用のリセット機構が用意されているか
