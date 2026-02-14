# Code Organization

> リポジトリ: openclaw/openclaw
> 分析日: 2026-02-14

## 概要

193K stars の大規模 TypeScript CLI プロジェクト（3,328+ ソースファイル）におけるファイル分割規約・バレルパターン・モジュール境界設計を横断的に分析した。AGENTS.md でファイル上限 ~500 LOC（ガイドライン）を明記し、`scripts/check-ts-max-loc.ts` で CI 強制するほど、ファイルサイズ管理を意識的に実践している。特に「ドット区切りファイル名」による論理グルーピングと「多層バレル」による公開 API 制御の組み合わせが、巨大コードベースの可読性維持に効いている。

## 背景にある原則

- **Edit Locality（変更の局所性）**: 型定義ファイル `src/config/types.ts` の冒頭コメントに「Split into focused modules to keep files small and improve edit locality」と明記されている。ファイルを小さく保つ目的は単なる美観ではなく、変更時の影響範囲を局所化し、マルチエージェント環境でのコンフリクトを減らすためである。大規模プロジェクトでは変更頻度の高いファイルを分割することが、マージコストの削減に直結する。

- **Boundary by Weight（重さによる境界分離）**: `src/channels/dock.ts` の冒頭コメントに「This module is intentionally "heavy"... Shared code paths should depend on dock.ts instead」と記載。モジュールの「重さ」（依存の深さ・起動コスト）で境界を決定している。軽量な参照用モジュール（dock）と重量な実行モジュール（plugins/index）を分離し、不必要な import chain を断ち切る。

- **Plugin Isolation（プラグイン隔離）**: extensions/ 配下を独立した workspace package として管理し、コア依存を `devDependencies` / `peerDependencies` に限定。プラグインがコアの内部実装に依存しないよう `plugin-sdk` バレルで公開 API を明示的にゲートしている。依存方向をコア → プラグインの一方向に強制する。

- **Lazy Loading at Boundaries（境界での遅延読み込み）**: `src/cli/deps.ts` の `createDefaultDeps` や `src/cli/program/command-registry.ts` の lazy import パターンが示すように、実行境界でのみ重いモジュールを読み込む。CLI のようなツールでは全コマンドを起動時に読み込むと体感速度が悪化するため、コマンド実行時に初めて import する。

## 実例と分析

### ドット区切りファイル名による論理グルーピング

このリポジトリの最も特徴的なプラクティスは、ディレクトリではなくファイル名のドット（`.`）区切りで論理グループを表現する手法である。

`src/commands/` では `status.ts` を中心に `status.command.ts`, `status.format.ts`, `status.types.ts`, `status.scan.ts` 等がフラットに並ぶ。`doctor.ts` も同様に `doctor-auth.ts`, `doctor-sandbox.ts`, `doctor-config-flow.ts` 等に分割される。`configure.ts` は `configure.channels.ts`, `configure.gateway.ts`, `configure.shared.ts` のように展開される。

```
src/commands/
├── status.ts              # バレル（3行）
├── status.command.ts      # コマンド定義
├── status.format.ts       # 表示フォーマット
├── status.types.ts        # 型定義
├── status.scan.ts         # スキャンロジック
├── status.e2e.test.ts     # E2E テスト
└── status.agent-local.ts  # エージェントローカル処理
```

`src/agents/` ではさらに深い階層が見られる。`pi-embedded-subscribe.ts`（636行）は `pi-embedded-subscribe.handlers.ts`, `pi-embedded-subscribe.handlers.messages.ts`, `pi-embedded-subscribe.handlers.tools.ts`, `pi-embedded-subscribe.types.ts` に分割されている。

```
src/agents/
├── pi-embedded-subscribe.ts                    # メインモジュール（636行）
├── pi-embedded-subscribe.handlers.ts           # ハンドラー集約（66行）
├── pi-embedded-subscribe.handlers.messages.ts  # メッセージハンドラー（372行）
├── pi-embedded-subscribe.handlers.tools.ts     # ツールハンドラー（263行）
├── pi-embedded-subscribe.handlers.lifecycle.ts # ライフサイクル（130行）
├── pi-embedded-subscribe.handlers.types.ts     # 型定義（115行）
└── pi-embedded-subscribe.types.ts              # 公開型（別ファイル）
```

この「ディレクトリ不要のグルーピング」は、ディレクトリを作ると index.ts やパス管理のオーバーヘッドが生じる場面で有効である。ファイルシステム上の並び順でグループが視認でき、grep/glob でも `pi-embedded-subscribe.*` で一括検索できる。

### 型定義のドメイン分割バレル

`src/config/types.ts` は 33 個の `types.*.ts` ファイルを `export *` で再エクスポートするバレルファイルである。

```typescript
// src/config/types.ts:1-2
// Split into focused modules to keep files small and improve edit locality.

export * from "./types.agent-defaults.js";
export * from "./types.agents.js";
export * from "./types.approvals.js";
// ... 30個以上
```

各分割ファイルはドメインごとに 100-460 行の範囲に収まっている（`types.tools.ts`: 461行、`types.gateway.ts`: 315行、`types.base.ts`: 187行 等）。利用者は `import type { ... } from "../config/types.js"` の一つの import で済む一方、編集者は特定ドメインのファイルだけを開けばよい。

同様のパターンが `src/channels/plugins/types.ts` でも採用されている。ここでは `types.adapters.ts`（313行）、`types.core.ts`（337行）、`types.plugin.ts`（84行）に分割し、`types.ts` が再エクスポートする。

### 多層バレルによる公開 API 制御

このリポジトリは3層のバレル構造でモジュール公開範囲を制御している。

1. **`src/index.ts`（CLI エントリ兼ライブラリ公開 API）**: CLI 起動ロジックと共に、外部利用者向けの関数・型を選択的にエクスポート（73行）
2. **`src/extensionAPI.ts`（拡張 API）**: エージェント・セッション関連の関数を選択的にエクスポート（15行）
3. **`src/plugin-sdk/index.ts`（プラグイン SDK）**: extensions/ が利用するすべての型・関数を網羅的にエクスポート（400行超）

```typescript
// src/plugin-sdk/index.ts:1-2 — 選択的 re-export でプラグイン SDK を構成
export { CHANNEL_MESSAGE_ACTION_NAMES } from "../channels/plugins/message-action-names.js";
export type {
  ChannelAccountSnapshot,
  ChannelAccountState,
  // ... 50以上の型
} from "../channels/plugins/types.js";
```

`package.json` の `exports` フィールドでパスマッピングを定義し、`openclaw/plugin-sdk` として外部からアクセス可能にしている。

```json
// package.json:26-31
"exports": {
  ".": "./dist/index.js",
  "./plugin-sdk": {
    "types": "./dist/plugin-sdk/index.d.ts",
    "default": "./dist/plugin-sdk/index.js"
  }
}
```

### Extension のプラグインアーキテクチャ

30 以上の extensions は統一された構造を持つ。

```typescript
// extensions/slack/index.ts — プラグインエントリポイント
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { slackPlugin } from "./src/channel.js";
import { setSlackRuntime } from "./src/runtime.js";

const plugin = {
  id: "slack",
  name: "Slack",
  description: "Slack channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setSlackRuntime(api.runtime);
    api.registerChannel({ plugin: slackPlugin });
  },
};
export default plugin;
```

各 extension は独立した `package.json` を持ち、コアを `devDependencies: { "openclaw": "workspace:*" }` で参照する。`openclaw` フィールドでエントリポイントを宣言する。runtime は module-level singleton パターンで注入される。

```typescript
// extensions/matrix/src/runtime.ts — シングルトン runtime 注入
let runtime: PluginRuntime | null = null;

export function setMatrixRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getMatrixRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Matrix runtime not initialized");
  }
  return runtime;
}
```

### 配列分割による大規模データの管理

`src/config/legacy.migrations.ts` は大量のマイグレーションルールを `part-1`/`part-2`/`part-3` に物理分割し、集約ファイルでスプレッドする。

```typescript
// src/config/legacy.migrations.ts
import { LEGACY_CONFIG_MIGRATIONS_PART_1 } from "./legacy.migrations.part-1.js";
import { LEGACY_CONFIG_MIGRATIONS_PART_2 } from "./legacy.migrations.part-2.js";
import { LEGACY_CONFIG_MIGRATIONS_PART_3 } from "./legacy.migrations.part-3.js";

export const LEGACY_CONFIG_MIGRATIONS = [
  ...LEGACY_CONFIG_MIGRATIONS_PART_1,
  ...LEGACY_CONFIG_MIGRATIONS_PART_2,
  ...LEGACY_CONFIG_MIGRATIONS_PART_3,
];
```

これにより各 part ファイルは 200-420 行に収まり、500 LOC ガイドラインを遵守している。

### テストのコロケーションと命名規約

テストファイルは対応するソースと同じディレクトリに `*.test.ts` / `*.e2e.test.ts` として配置される。特筆すべきは、1テスト1ファイルの極端な分割が行われている点である。

```
src/agents/
├── pi-embedded-subscribe.subscribe-embedded-pi-session.does-not-append-text-end-content-is.e2e.test.ts
├── pi-embedded-subscribe.subscribe-embedded-pi-session.does-not-call-onblockreplyflush-callback-is-not.e2e.test.ts
├── pi-embedded-subscribe.subscribe-embedded-pi-session.emits-block-replies-text-end-does-not.e2e.test.ts
```

ファイル名に `モジュール名.関数名.テスト概要` をドット区切りで含め、テスト内容がファイル名だけで特定できる。大規模プロジェクトでは1ファイルに多くのテストを詰め込むと、変更時に無関係なテストまで実行・レビューの対象になるため、この分割は合理的である。

### CLI コマンドの遅延登録

```typescript
// src/cli/program/command-registry.ts:30-34 — コマンドの遅延登録
const coreEntries: CoreCliEntry[] = [
  {
    commands: [{ name: "setup", description: "Setup helpers" }],
    register: async ({ program }) => {
      const mod = await import("./register.setup.js");
      mod.registerSetupCommand(program);
    },
  },
  // ...
];
```

`registerLazyCoreCommand` はプレースホルダーコマンドを登録し、実行時に初めて対応する `register.*.ts` モジュールを動的 import する。これにより CLI の起動時間を最小化しつつ、コマンドごとのヘルプ表示は即座に利用可能にしている。

## パターンカタログ

- **Facade パターン** (構造)
  - 解決する問題: 内部モジュール構造の複雑さをバレルファイルで隠蔽する
  - 適用条件: サブモジュール数が 5 を超え、利用側が特定のサブモジュールを意識する必要がない場合
  - コード例: `src/channel-web.ts`（6つの内部モジュールを1つのバレルに統合）、`src/config/types.ts`（33個のドメイン型ファイルを統合）
  - 注意点: バレルテスト（`channel-web.barrel.test.ts`）でエクスポートの健全性を検証している

- **Plugin パターン / Strategy パターン** (振る舞い)
  - 解決する問題: チャネル（Slack, Telegram, Discord 等）ごとの振る舞いを統一インターフェースで切り替える
  - 適用条件: 同一インターフェースの実装が 5 個以上あり、独立してデプロイ・開発したい場合
  - コード例: `extensions/*/index.ts` が統一された `ChannelPlugin` インターフェースを実装
  - 注意点: plugin-sdk バレルで公開 API をゲートし、内部実装への依存を防止

- **Service Locator パターン** (生成)
  - 解決する問題: 依存関係の解決を実行時に遅延させ、起動コストを削減する
  - 適用条件: CLI のように全コマンドが同時に必要にならないアプリケーション
  - コード例: `src/cli/deps.ts` の `createDefaultDeps`（動的 import による依存注入）
  - 注意点: テスト時にモックが容易になる利点もある

## Good Patterns

- **バレルのエクスポート健全性テスト**: `src/channel-web.barrel.test.ts` でバレルファイルのエクスポートが壊れていないことを検証する。リファクタリングでエクスポートが消失するリグレッションを防ぐ。

```typescript
// src/channel-web.barrel.test.ts:1-14
describe("channel-web barrel", () => {
  it("exports the expected web helpers", () => {
    expect(mod.createWaSocket).toBeTypeOf("function");
    expect(mod.loginWeb).toBeTypeOf("function");
    expect(mod.monitorWebChannel).toBeTypeOf("function");
    // ...
  });
});
```

- **意図を明記したモジュール境界コメント**: 各モジュールの責務境界と「何を入れてよいか」をソースコード中のコメントで明記する。

```typescript
// src/channels/dock.ts:84-91
// Rules:
// - keep this module *light* (no monitors, probes, puppeteer/web login, etc)
// - OK: config readers, allowFrom formatting, mention stripping patterns
// - shared code should import from here, not from the plugins registry
```

- **CI 強制のファイルサイズチェック**: `scripts/check-ts-max-loc.ts` で 500 LOC 上限を CI レベルで検査する。untracked ファイルも対象にし、ローカルリファクタリングで上限違反が見逃されないようにしている。

```typescript
// scripts/check-ts-max-loc.ts:28-37
function gitLsFilesAll(): string[] {
  // Include untracked files too so local refactors don't "pass" by accident.
  const stdout = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
  });
  // ...
}
```

## Anti-Patterns / 注意点

- **過剰なファイル名長**: テストファイル名が `pi-embedded-subscribe.subscribe-embedded-pi-session.does-not-append-text-end-content-is.e2e.test.ts` のように極端に長くなる場合がある。ファイルシステムの制限（255文字）に近づくリスクがあり、IDE のタブ表示やターミナルでの可読性も低下する。

```
# Bad: ファイルシステム上限に迫る長さ
pi-embedded-subscribe.subscribe-embedded-pi-session.calls-onblockreplyflush-before-tool-execution-start-preserve.e2e.test.ts

# Better: テスト内のdescribe/itで説明し、ファイル名はモジュール+機能に留める
pi-embedded-subscribe.block-reply-flush.e2e.test.ts
```

- **ドット区切りとハイフン区切りの混在**: `src/commands/` 内で `status.command.ts`（ドット区切り）と `doctor-auth.ts`（ハイフン区切り）が混在している。一貫性がないと、新規ファイルを追加する際にどちらの規約に従うべきか判断が難しい。命名規約を統一するか、使い分けの基準を明文化すべきである。

## 導出ルール

- `[MUST]` ファイルサイズ上限（例: 500 LOC）を CI スクリプトで機械的に検査する — 人間のレビューでは行数超過を見逃すが、自動チェックなら確実に検出できる（`scripts/check-ts-max-loc.ts` が untracked ファイルも含めて検査）
  - 根拠: AGENTS.md で ~500 LOC ガイドライン明記、`package.json` の `check:loc` スクリプトで CI 強制

- `[MUST]` バレルファイルで公開 API を明示的にゲートし、内部モジュールへの直接依存を禁止する — プラグイン・拡張機能が内部実装に依存すると、リファクタリング時に破壊的変更が連鎖する
  - 根拠: `src/plugin-sdk/index.ts` が 400 行超の選択的 re-export で SDK 境界を定義し、extensions/ は `openclaw/plugin-sdk` のみを import

- `[SHOULD]` ファイルサイズ上限を超えたモジュールは、ドット区切りファイル名（`module.sub-concern.ts`）でサブディレクトリを作らずに分割する — ディレクトリを作ると index.ts のボイラープレートとパス管理のオーバーヘッドが生じるが、ファイル名だけなら glob/grep で一括検索でき、ファイルシステム上の隣接性も保てる
  - 根拠: `src/commands/status.*.ts`, `src/agents/pi-embedded-subscribe.*.ts` 等でコードベース全体に一貫して適用

- `[SHOULD]` 型定義ファイルが肥大化したらドメイン別に `types.<domain>.ts` に分割し、集約バレル `types.ts` で `export *` する — 変更の局所性が向上し、マルチエージェント・マルチ開発者環境でのマージコンフリクトが減る
  - 根拠: `src/config/types.ts` 冒頭コメント「Split into focused modules to keep files small and improve edit locality」

- `[SHOULD]` モジュール境界（何を入れてよいか・何を入れてはいけないか）をソースコード中のコメントで明記する — ドキュメントは陳腐化するが、ソースコード中のコメントは変更時に目に入るため維持されやすい
  - 根拠: `src/channels/dock.ts:84-91` のルールコメントがモジュールの軽量性を維持

- `[SHOULD]` バレルファイルのエクスポート一覧をユニットテストで検証する — リファクタリングでエクスポートが消失するリグレッションを早期検出できる
  - 根拠: `src/channel-web.barrel.test.ts` が `toBeTypeOf("function")` でエクスポートの存在を検証

- `[AVOID]` プラグイン・拡張のランタイム依存に `workspace:*` を `dependencies` に含める — npm install 時に解決できず壊れる。`devDependencies` または `peerDependencies` に配置し、ランタイムではホスト側のエイリアスで解決する
  - 根拠: AGENTS.md に「Avoid `workspace:*` in `dependencies` (npm install breaks)」と明記

## 適用チェックリスト

- [ ] プロジェクトにファイルサイズ上限（LOC）の CI チェックスクリプトを追加したか
- [ ] 500 行を超えるファイルを洗い出し、分割候補をリストアップしたか
- [ ] 外部向け API にバレルファイルを導入し、内部モジュールへの直接 import を禁止したか
- [ ] バレルファイルのエクスポートを検証するテストを追加したか
- [ ] 型定義ファイルが 300 行を超えている場合、ドメイン別に分割したか
- [ ] モジュール境界のルール（何を入れてよい/いけない）をソースコード中のコメントで明記したか
- [ ] CLI / エントリポイントで遅延 import を活用し、起動時間を最小化しているか
- [ ] プラグイン/拡張の依存方向が一方向（コア → プラグイン）になっているか確認したか
