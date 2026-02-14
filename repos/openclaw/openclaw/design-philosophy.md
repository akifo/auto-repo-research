# design-philosophy

> リポジトリ: openclaw/openclaw
> 分析日: 2026-02-14

## 概要

マルチプラットフォーム（Node/Bun, macOS, iOS, Android, Docker）かつマルチチャネル（Telegram, Discord, Slack, WhatsApp, Signal, iMessage, Matrix, IRC, MS Teams 他 30+ チャネル）の AI アシスタント基盤における設計思想と技術選定の根拠を分析する。単一の TypeScript コアが WebSocket プロトコルを介してネイティブアプリと通信し、チャネルはプラグインシステムで拡張される「Gateway ハブ + スポーク」アーキテクチャを採用している。特筆すべきは、スキーマ駆動のプロトコル生成パイプライン（TypeBox -> JSON Schema -> Swift/Kotlin モデル自動生成）により、言語境界をまたぐ型安全性を実現している点である。

## 背景にある原則

- **Single Source of Truth for Schema（スキーマの唯一の真実源）**: プロトコル定義を TypeBox（TypeScript）で一元管理し、JSON Schema と Swift モデルをコード生成する。手動同期による不整合を排除し、型安全性を言語境界を越えて保証するため。`scripts/protocol-gen-swift.ts` が `ProtocolSchemas` から Swift の `Codable` 構造体を自動生成し、`pnpm protocol:check` で差分がないことを CI で検証する。

- **Core/Extension 分離による段階的複雑性管理**: チャネルを「コア（src/ 内の 8 チャネル）」と「拡張（extensions/ 内の 30+ workspace パッケージ）」に二分する。コアは monorepo 内でビルド、拡張は独立した npm パッケージとして配布可能にすることで、依存関係の肥大化を防ぎつつ無限のチャネル追加を許容する。

- **Lightweight Dock / Heavy Plugin の二層抽象**: チャネルの軽量メタデータ（`ChannelDock`）と重量実装（`ChannelPlugin`）を分離し、共有コードパスでは Dock のみを import する。これにより、ルーティングやコマンド認可のような高頻度パスが不要なモジュール（WhatsApp のログインフロー等）を遅延ロードできる。

- **Rust 製ツールチェーン優先（Developer Velocity First）**: tsdown（rolldown ベース）、oxlint、oxfmt を採用し、ビルド・lint・フォーマットの速度を最大化する。500 LOC 上限の CI チェック（`check-ts-max-loc.ts`）と合わせ、大規模コードベースでの開発速度を維持する設計判断。

## 実例と分析

### 1. スキーマ駆動のクロスプラットフォームプロトコル

プロトコル定義は `src/gateway/protocol/schema/` 配下で `@sinclair/typebox` の `Type.Object` を使って記述される。これが唯一の真実源として機能する。

生成パイプラインは 2 段階:
1. `scripts/protocol-gen.ts`: TypeBox -> JSON Schema（`dist/protocol.schema.json`）
2. `scripts/protocol-gen-swift.ts`: TypeBox -> Swift `Codable` 構造体（macOS/iOS 共有パッケージへ出力）

Android (Kotlin) 側はプロトコルバージョン定数のみ手動管理し（`GatewayProtocol.kt:2`）、フレームの decode は汎用 JSON パーサーで行う。

CI での整合性保証:

```
// package.json:74
"protocol:check": "pnpm protocol:gen && pnpm protocol:gen:swift && git diff --exit-code -- dist/protocol.schema.json apps/macos/Sources/OpenClawProtocol/GatewayModels.swift",
```

この `git diff --exit-code` パターンにより、スキーマ変更時に生成ファイルの再コミットを強制する。

### 2. チャネルプラグインの Adapter パターン

`ChannelPlugin` 型（`src/channels/plugins/types.plugin.ts:48`）は 20 以上のオプショナルな Adapter インターフェースを集約する:

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
  gateway?: ChannelGatewayAdapter<ResolvedAccount>;
  streaming?: ChannelStreamingAdapter;
  threading?: ChannelThreadingAdapter;
  // ... 他 10+ アダプター
};
```

各チャネルは必要な Adapter だけを実装すればよい。例えば IRC は `streaming` と `groups` を実装するが `pairing` や `auth` は不要。WhatsApp は `polls`・`reactions`・`media` の capability を宣言して対応する Adapter を実装する。

### 3. Dock/Plugin 二層分離

`src/channels/dock.ts` のコメントが設計意図を明確にしている:

```typescript
// src/channels/dock.ts:82-91
// Channel docks: lightweight channel metadata/behavior for shared code paths.
//
// Rules:
// - keep this module *light* (no monitors, probes, puppeteer/web login, etc)
// - OK: config readers, allowFrom formatting, mention stripping patterns, threading defaults
// - shared code should import from here (and from `src/channels/registry.ts`), not from the plugins registry
//
// Adding a channel:
// - add a new entry to `DOCKS`
// - keep it cheap; push heavy logic into `src/channels/plugins/<id>.ts` or channel modules
```

同様に `src/channels/plugins/load.ts` のヘッダーにも:

```typescript
// src/channels/plugins/load.ts:6-11
// Channel plugins registry (runtime).
//
// This module is intentionally "heavy" (plugins may import channel monitors, web login, etc).
// Shared code paths (reply flow, command auth, sandbox explain) should depend on `src/channels/dock.ts`
// instead, and only call `getChannelPlugin()` at execution boundaries.
```

### 4. Plugin SDK と Extension の境界設計

Extension は workspace パッケージとして独立し、`openclaw` を `devDependencies` に配置する（`extensions/matrix/package.json:15`）。ランタイムでは `jiti` による alias 解決で `openclaw/plugin-sdk` を import する。

Extension の登録は `OpenClawPluginApi` を受け取る `register` 関数パターン:

```typescript
// extensions/matrix/index.ts:6-17
const plugin = {
  id: "matrix",
  name: "Matrix",
  description: "Matrix channel plugin (matrix-js-sdk)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setMatrixRuntime(api.runtime);
    api.registerChannel({ plugin: matrixPlugin });
  },
};
export default plugin;
```

`PluginRegistry`（`src/plugins/registry.ts:124`）は channels, tools, hooks, providers, httpHandlers, cliRegistrars, services, commands, diagnostics の 11 カテゴリを管理し、plugin が任意の組み合わせで機能を登録できる。

### 5. 構成検証の多層パイプライン

設定は Zod v4 スキーマ（`src/config/zod-schema.ts`）で定義し、JSON Schema へ変換して UI に配信する（`OpenClawSchema.toJSONSchema()`）。検証は多段:
1. Zod パース（TypeScript 側）
2. Plugin manifest の JSON Schema 検証（`validateJsonSchemaValue`）
3. レガシー設定の自動マイグレーション（`src/config/legacy.migrations.*.ts`）
4. ランタイム妥当性チェック（agent dir 重複検出等）

## パターンカタログ

- **Adapter パターン** (分類: 構造)
  - 解決する問題: 30+ チャネルがそれぞれ異なる機能セットを持ち、共通のインターフェースで扱いたい
  - 適用条件: 統合対象が多数あり、各対象がサポートする機能のサブセットが異なる
  - コード例: `src/channels/plugins/types.plugin.ts:48` — `ChannelPlugin` 型
  - 注意点: Adapter が 20+ になると「どれを実装すべきか」が不明確になる。`capabilities` 宣言で必須/任意を明示している

- **Registry パターン** (分類: 生成/構造)
  - 解決する問題: プラグインの動的登録・発見と、重複やコンフリクトの検出
  - 適用条件: 実行時に拡張を動的に追加し、それらを一元管理したい
  - コード例: `src/plugins/registry.ts:146` — `createPluginRegistry()`
  - 注意点: グローバル状態（`Symbol.for` によるシングルトン）を使用しており、テスト時の分離に注意が必要

- **Code Generation パターン** (分類: 振る舞い/インフラ)
  - 解決する問題: 言語境界を越えた型の整合性保証
  - 適用条件: 複数言語間で共有するプロトコルやスキーマがある
  - コード例: `scripts/protocol-gen-swift.ts:210` — `generate()` 関数
  - 注意点: 生成コードと手書きコードの境界を明確にする（ファイルヘッダーに `do not edit by hand` を記載）

## Good Patterns

- **Capability 宣言による機能ゲーティング**: チャネルが `ChannelCapabilities` オブジェクトで `polls`, `reactions`, `media`, `threads` 等の機能対応を宣言し、ランタイムが機能の有無に基づいてコードパスを分岐する。コード側は `if (capabilities.polls)` のような簡潔な条件分岐で済む。

```typescript
// src/channels/plugins/types.core.ts:169-182
export type ChannelCapabilities = {
  chatTypes: Array<ChatType | "thread">;
  polls?: boolean;
  reactions?: boolean;
  edit?: boolean;
  unsend?: boolean;
  reply?: boolean;
  threads?: boolean;
  media?: boolean;
  nativeCommands?: boolean;
  blockStreaming?: boolean;
};
```

- **CI での生成コード整合性チェック**: `pnpm protocol:check` が生成スクリプトを再実行し、`git diff --exit-code` で差分がないことを確認する。生成コードの手動改変を検出し、スキーマ変更時の再生成漏れを CI で防止する。

- **LOC 上限の自動チェック**: `scripts/check-ts-max-loc.ts` が全 `.ts` ファイルを走査し、500 行超のファイルを報告する。「ガイドラインだが CI で可視化」というソフトな強制で、ファイル肥大化を早期に検出する。

```typescript
// scripts/check-ts-max-loc.ts:55-76
const results = await Promise.all(
  files.map(async (filePath) => ({ filePath, lines: await countLines(filePath) })),
);
const offenders = results
  .filter((result) => result.lines > maxLines)
  .toSorted((a, b) => b.lines - a.lines);
```

- **マルチエージェント安全性ルールの文書化**: `AGENTS.md` に「stash を作成しない」「ブランチを切り替えない」「自分の変更だけコミットする」等のルールを明示し、複数 AI エージェントが並行作業する環境での安全性を担保する。

## Anti-Patterns / 注意点

- **グローバルシングルトンによるプラグインレジストリ**: `Symbol.for("openclaw.pluginRegistryState")` で `globalThis` にレジストリを格納する設計は、テスト間の状態汚染リスクがある。

```typescript
// Bad: グローバル状態に依存
// src/plugins/runtime.ts:19-37
const REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");
const state: RegistryState = (() => {
  const globalState = globalThis as typeof globalThis & {
    [REGISTRY_STATE]?: RegistryState;
  };
  if (!globalState[REGISTRY_STATE]) {
    globalState[REGISTRY_STATE] = { registry: createEmptyRegistry(), key: null };
  }
  return globalState[REGISTRY_STATE];
})();
```

```typescript
// Better: 依存注入でレジストリを渡す
function createGateway(registry: PluginRegistry) {
  // registry を引数として受け取り、グローバル状態を避ける
}
```

ただし、このプロジェクトでは plugin SDK のランタイム解決（`jiti` alias）との互換性のためにこの設計が選択されている。`requireActivePluginRegistry()` が未初期化時にも空レジストリを返すフォールバックで防御している。

- **プロトコル生成の非対称性**: Swift モデルは自動生成されるが、Kotlin（Android）モデルは手動管理。プロジェクト規模の拡大に伴い、Android 側でもコード生成が必要になる可能性がある。

## 導出ルール

- `[MUST]` マルチ言語プロトコルは単一言語でスキーマを定義し、他言語のモデルをコード生成する。手動同期は必ず不整合を生む
  - 根拠: openclaw は TypeBox で定義 -> Swift を自動生成し、`protocol:check` で CI 検証する（`package.json:74`）

- `[MUST]` プラグインシステムでは、チャネル/拡張が「何ができるか」を Capability オブジェクトで宣言する。ランタイムはこの宣言に基づいて機能ゲーティングを行う
  - 根拠: `ChannelCapabilities` 型（`types.core.ts:169`）により、30+ チャネルの機能差異を一貫した方法で扱っている

- `[SHOULD]` 拡張ポイントは「軽量メタデータ層」と「重量実装層」に分離し、共有コードパスでは軽量層のみを import する
  - 根拠: Dock/Plugin の二層分離により、ルーティング処理が WhatsApp ログイン等の重い依存を引き込まないようにしている（`dock.ts:82-91`）

- `[SHOULD]` コード生成されたファイルの整合性は CI で `git diff --exit-code` パターンを使って検証する。生成 -> diff -> fail により、再生成漏れを機械的に防ぐ
  - 根拠: `protocol:check` スクリプトがこのパターンを実装し、スキーマ変更時の Swift モデル更新漏れを検出する（`package.json:74`）

- `[SHOULD]` ファイルサイズの上限を CI で自動チェックし、肥大化を早期に可視化する。ハード制約ではなくソフトガイドラインとして運用することで、合理的な例外を許容しつつ全体の品質を維持する
  - 根拠: `check-ts-max-loc.ts` が 500 行超のファイルを報告するが、exit code 1 でも CI をブロックしない柔軟な運用（`AGENTS.md:74` で「~500 LOC when feasible」）

- `[SHOULD]` Extension/Plugin の依存関係は「Plugin SDK を devDependencies に置き、ランタイムは alias/jiti で解決する」パターンで、循環依存を回避する
  - 根拠: `extensions/matrix/package.json:15` で `"openclaw": "workspace:*"` を `devDependencies` に配置し、`AGENTS.md:12` で明示的にガイドしている

- `[AVOID]` 複数 AI エージェント/開発者が並行作業する環境で、暗黙的なグローバル状態操作（stash, branch 切り替え等）を行うこと。操作ルールを AGENTS.md 等に明文化し、各エージェントのスコープを制限する
  - 根拠: `AGENTS.md:146-151` にマルチエージェント安全性ルールが 6 項目にわたって定義されている

## 適用チェックリスト

- [ ] 複数言語/プラットフォーム間で共有するプロトコルやスキーマがある場合、単一言語での定義 + コード生成パイプラインを構築しているか
- [ ] 生成コードの整合性を CI で自動検証しているか（`git diff --exit-code` パターン等）
- [ ] プラグイン/拡張システムで、各プラグインの機能差異を Capability 宣言で管理しているか
- [ ] 共有コードパスが重量な実装を不必要に import していないか（軽量メタデータ層と重量実装層の分離）
- [ ] ファイルサイズの上限チェックを CI に組み込んでいるか
- [ ] Extension の依存関係が循環しない設計になっているか（SDK を dev/peer dependency にする等）
- [ ] 複数の AI エージェントや開発者が並行作業する場合のルール（git 操作のスコープ制限等）を文書化しているか
- [ ] Adapter/Plugin インターフェースに「必須」と「任意」の区別が明確にあるか
