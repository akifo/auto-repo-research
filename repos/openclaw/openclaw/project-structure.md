# Project Structure

> リポジトリ: openclaw/openclaw
> 分析日: 2026-02-14

## 概要

193k Stars を持つマルチチャネル AI ゲートウェイのプロジェクト構造を分析する。pnpm workspace による monorepo 構成だが、一般的な "packages 分割" とは異なり、コアロジックを単一の `src/` に集約し、拡張ポイントのみを workspace パッケージとして外出しする「Fat Core + Thin Extensions」アーキテクチャを採用している。加えて Swift / Kotlin のネイティブアプリ、60 以上のスキル定義、35 以上のプラグインを一つのリポジトリに収容しつつ、明確な境界規約で管理する手法は大規模プロジェクトの構造設計として注目に値する。

## 背景にある原則

- **拡張の境界で切る、機能の境界では切らない**: monorepo 内の workspace パッケージ分割は「別パッケージとして配布する必要があるもの」に限定し、コア内部の機能ドメイン（channels, agents, gateway など）はディレクトリで分離する。パッケージ境界を増やすと依存グラフの管理コストが増大し、リファクタリングの摩擦が高まる。根拠: `src/` 配下に 40 以上のドメインディレクトリがあるが、全て単一パッケージの内部モジュールとして扱われている（`pnpm-workspace.yaml:1` は `.` をルートワークスペースとして宣言）。
- **Plugin SDK を契約の境界とする**: 拡張プラグインがコアに依存する際、`openclaw/plugin-sdk` という公開 API 面のみを参照させることで、内部実装の変更が拡張側に波及しないようにする。根拠: 全 extension は `devDependencies` で `openclaw: "workspace:*"` を宣言し、ランタイムでは `import ... from "openclaw/plugin-sdk"` 経由でのみコアにアクセスする（`extensions/slack/index.ts:1-2`）。
- **LOC 上限で構造的複雑性を抑制する**: ファイルあたりの行数上限を CI で強制することで、モジュール肥大化を構造的に防ぐ。根拠: `scripts/check-ts-max-loc.ts` がデフォルト 500 行、`check:loc` スクリプトは `--max 500` で実行される。`AGENTS.md:74` にも「500 LOC 目安、split/refactor as needed」と明記。
- **テスト同居 + 多段 Vitest 設定で粒度別にテストを分離する**: テストファイルをソースと同じディレクトリに置き（co-located tests）、Vitest の設定ファイルを目的別に複数用意して実行スコープを制御する。根拠: `vitest.config.ts` はユニット全体、`vitest.extensions.config.ts` は拡張のみ、`vitest.gateway.config.ts` はゲートウェイのみ、`vitest.e2e.config.ts` / `vitest.live.config.ts` で統合テストを分離。

## 実例と分析

### Workspace 構成: 4 層のパッケージ階層

`pnpm-workspace.yaml` は 4 つのワークスペースを宣言する:

```yaml
# pnpm-workspace.yaml:1-4
packages:
  - .
  - ui
  - packages/*
  - extensions/*
```

各層の役割は明確に分離されている:

- **`.` (ルート)**: CLI + Gateway + 全コアロジック。`src/` 配下に 40 以上のドメインディレクトリを持つが、全て単一の `openclaw` パッケージ内
- **`ui`**: Web UI（Lit Web Components）。独立した `vite.config.ts` と `vitest.config.ts` を持つ
- **`packages/*`**: 互換性 shim（`clawdbot`, `moltbot`）。旧名称からの移行用
- **`extensions/*`**: 35 以上のプラグイン。チャネル統合、メモリバックエンド、認証プロバイダなど

### Fat Core パターン: src/ の内部ドメイン分割

`src/` 直下に 40 以上のディレクトリがあるが、これらは npm パッケージとしては分割されていない。代わりに各ディレクトリが「ドメイン」として機能し、`tsdown.config.ts` で複数のエントリポイントからビルドされる:

```typescript
// tsdown.config.ts:7-45
export default defineConfig([
  { entry: "src/index.ts", ... },      // メインパッケージ export
  { entry: "src/entry.ts", ... },      // CLI エントリ
  { entry: "src/plugin-sdk/index.ts",  // Plugin SDK (別 outDir)
    outDir: "dist/plugin-sdk", ... },
  { entry: "src/extensionAPI.ts", ... }, // Extension API 面
  { entry: ["src/hooks/bundled/*/handler.ts", ...], ... }, // Hooks
]);
```

単一パッケージ内で複数のビルドエントリを持つことで、パッケージ分割のオーバーヘッドなしに公開 API 面を制御している。

### Plugin SDK: 公開 API 面の明示的制御

`src/plugin-sdk/index.ts` が拡張プラグイン向けの唯一の公開契約であり、`src/extensionAPI.ts` （392 行）が内部モジュールからの re-export を集約する。拡張側は内部パスを直接参照できない:

```typescript
// extensions/slack/index.ts:1-2
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
```

これは `jiti` のエイリアス機能で実現されている。ローダーは開発時に `src/plugin-sdk/index.ts` を、本番時に `dist/plugin-sdk/index.js` を自動解決する:

```typescript
// src/plugins/loader.ts:46-75
const resolvePluginSdkAlias = (): string | null => {
  // ...
  const orderedCandidates = isProduction
    ? isTest ? [distCandidate, srcCandidate] : [distCandidate]
    : [srcCandidate, distCandidate];
  // ...
};
```

### Extension の構造規約: 宣言的メタデータ + 登録エントリ

各 extension は統一されたファイル構成を持つ:

```
extensions/<name>/
  ├── package.json           # workspace パッケージ宣言 + openclaw メタデータ
  ├── openclaw.plugin.json   # プラグイン設定スキーマ
  ├── index.ts               # エントリポイント（register 関数）
  └── src/                   # 実装
```

`package.json` 内の `openclaw` キーでプラグインのメタデータとチャネル情報を宣言的に定義する:

```json
// extensions/matrix/package.json:16-35 (抜粋)
{
  "openclaw": {
    "extensions": ["./index.ts"],
    "channel": {
      "id": "matrix",
      "label": "Matrix",
      "docsPath": "/channels/matrix",
      "order": 70
    },
    "install": { "npmSpec": "@openclaw/matrix" }
  }
}
```

依存方向は一方向: extension は `openclaw` を `devDependencies` に置き、ランタイムでは `jiti` のエイリアス解決で `openclaw/plugin-sdk` を参照する。`dependencies` に `workspace:*` を置くことは禁じられている（`AGENTS.md:12`）。

### 多言語ネイティブアプリの統合

`apps/` 配下に Swift（macOS/iOS）と Kotlin（Android）のネイティブアプリが同居する。`apps/shared/OpenClawKit/` が iOS/macOS 間で共有する Swift パッケージとして機能する:

```
apps/
  ├── macos/Sources/
  │   ├── OpenClaw/            # macOS アプリ本体
  │   ├── OpenClawProtocol/    # Gateway との通信プロトコル
  │   ├── OpenClawIPC/         # プロセス間通信
  │   └── OpenClawDiscovery/   # サービス発見
  ├── ios/Sources/             # iOS アプリ（SwiftUI）
  ├── android/                 # Android アプリ（Kotlin）
  └── shared/OpenClawKit/      # iOS/macOS 共有 Swift パッケージ
```

TypeScript のプロトコル定義から Swift の型を自動生成するスクリプト（`scripts/protocol-gen-swift.ts`）で言語間の型安全性を担保している。`protocol:check` スクリプトが CI で TypeScript 定義と Swift 生成コードの同期を検証する:

```json
// package.json:74
"protocol:check": "pnpm protocol:gen && pnpm protocol:gen:swift && git diff --exit-code -- dist/protocol.schema.json apps/macos/Sources/OpenClawProtocol/GatewayModels.swift"
```

### Skills: 宣言的 Markdown による能力定義

52 の skill が `skills/` 配下にフラットに配置される。各 skill は実行コードを持たず、`SKILL.md` というマークダウンファイルのみで構成される:

```markdown
# skills/github/SKILL.md (frontmatter)

---
name: github
description: "Interact with GitHub using the `gh` CLI..."
metadata:
  { "openclaw": { "emoji": "...", "requires": { "bins": ["gh"] }, ... } }
---
```

skill はコードではなく「AI エージェントへの指示書」として機能する。メタデータで依存バイナリやインストール方法を宣言し、本文で使い方を記述する。

## パターンカタログ

- **Facade パターン** (構造)
  - 解決する問題: 拡張プラグインがコア内部の複雑な依存グラフに直接結合することを防ぐ
  - 適用条件: コアの内部モジュールが頻繁にリファクタリングされる一方、外部 API 面は安定させたい場合
  - コード例: `src/plugin-sdk/index.ts` が `src/extensionAPI.ts` 経由で内部モジュールを re-export
  - 注意点: re-export ファイルが肥大化しやすい（`extensionAPI.ts` は 392 行）。定期的な棚卸しが必要

- **Service Locator パターン** (振る舞い)
  - 解決する問題: プラグインが多数のコアサービスに依存する際、コンストラクタ引数の爆発を防ぐ
  - 適用条件: プラグインシステムのように登録と利用のタイミングが分離している場合
  - コード例: `PluginRuntime` 型（`src/plugins/runtime/types.ts:178-362`）がチャネル別・機能別にネストされたサービスカタログを提供
  - 注意点: 型安全な Service Locator として `typeof import(...)` を多用（80 以上の型エイリアス）し、実行時エラーを型検査時に検出可能にしている

## Good Patterns

- **依存方向の一方向性を package.json で強制する**: extension が `openclaw` を `devDependencies` に配置し、ランタイムでは `jiti` エイリアスで SDK パスを解決する設計。これにより `npm install --omit=dev` で extension を独立インストールでき、循環依存を構造的に防ぐ。

```json
// extensions/slack/package.json:7-9
{
  "devDependencies": {
    "openclaw": "workspace:*"
  }
}
```

```typescript
// src/plugins/loader.ts:214-222
const jiti = createJiti(import.meta.url, {
  alias: { "openclaw/plugin-sdk": pluginSdkAlias },
});
```

- **宣言的プラグインメタデータによるゼロコード発見**: プラグインの ID、チャネル情報、インストール方法を `package.json` の `openclaw` キーに宣言することで、プラグインコードをロードせずにカタログを構築できる。`src/plugins/discovery.ts` がファイルシステムを走査し、`package.json` のメタデータだけで候補リストを生成する。

```typescript
// src/plugins/discovery.ts:53-59
function resolvePackageExtensions(manifest: PackageManifest): string[] {
  const raw = getPackageManifestMetadata(manifest)?.extensions;
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
}
```

- **LOC 上限の CI 強制**: `scripts/check-ts-max-loc.ts` が全 `.ts` ファイルの行数をチェックし、閾値超過を CI で検出する。git 追跡外のファイルも含めることで、ローカルのリファクタリング中の「一時的な巨大ファイル」も検出する。

```typescript
// scripts/check-ts-max-loc.ts:28-37
function gitLsFilesAll(): string[] {
  const stdout = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
  });
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}
```

## Anti-Patterns / 注意点

- **Re-export ファイルの肥大化**: `src/extensionAPI.ts` は 392 行の re-export で構成されている。Plugin SDK の公開 API 面を一箇所で管理する利点はあるが、ファイルが大きくなると「何が公開 API で何がそうでないか」の判断が難しくなる。

```typescript
// Bad: 392 行の flat re-export（extensionAPI.ts）
export { functionA } from "../moduleA.js";
export { functionB } from "../moduleB.js";
// ... 300 行以上続く
```

```typescript
// Better: ドメイン別のバレルファイルに分割し、SDK エントリがそれらを集約
// plugin-sdk/channels.ts
export { ... } from "./channels/index.js";
// plugin-sdk/agents.ts
export { ... } from "./agents/index.js";
// plugin-sdk/index.ts
export * from "./channels.js";
export * from "./agents.js";
```

- **PluginRuntime の型定義における typeof import の大量使用**: `src/plugins/runtime/types.ts` は 80 以上の `typeof import(...)` 型エイリアスを持ち、362 行に達している。型安全性は確保されるが、可読性とメンテナンス性のトレードオフがある。

```typescript
// src/plugins/runtime/types.ts:3-6 (パターンの例)
type DispatchReplyWithBufferedBlockDispatcher =
  typeof import("../../auto-reply/reply/provider-dispatcher.js").dispatchReplyWithBufferedBlockDispatcher;
type CreateReplyDispatcherWithTyping =
  typeof import("../../auto-reply/reply/reply-dispatcher.js").createReplyDispatcherWithTyping;
```

## 導出ルール

- `[MUST]` monorepo でパッケージを分割する際は「配布境界」で切る（機能ドメインではなくデプロイ/公開単位で分割する）
  - 根拠: openclaw は 40 以上のドメインを持つが workspace パッケージは 4 カテゴリのみ。内部ドメインをパッケージに分割しないことで、リファクタリング時の cross-package 変更コストを排除している

- `[MUST]` プラグイン/拡張が参照できる公開 API 面を専用モジュール（SDK/Facade）として明示的に定義し、内部モジュールへの直接アクセスを構造的に遮断する
  - 根拠: `openclaw/plugin-sdk` エイリアスと `jiti` のエイリアス解決により、extension は内部パスを `import` できず、公開 API の変更のみが破壊的変更となる（`src/plugins/loader.ts:214-222`）

- `[SHOULD]` ファイルあたりの LOC 上限を CI で自動検査する（目安 500 行、上限を超えたら分割を強制）
  - 根拠: `scripts/check-ts-max-loc.ts` + `pnpm check:loc` が 500 行超のファイルを CI で検出。大規模プロジェクトではファイル肥大化が最大のメンテナンスリスクであり、人間のコードレビューだけでは防げない

- `[SHOULD]` 多言語プロジェクトでは TypeScript のスキーマ定義を Single Source of Truth とし、他言語の型定義をコード生成 + CI diff チェックで同期する
  - 根拠: `protocol:check` スクリプトが TypeScript プロトコル定義から Swift コードを生成し、`git diff --exit-code` で差分がないことを CI で検証する（`package.json:74`）

- `[SHOULD]` テストファイルはソースファイルと同じディレクトリに同居させ、テスト種別（unit / e2e / live）は Vitest 設定ファイルの `include` パターンで分離する
  - 根拠: `vitest.config.ts` / `vitest.extensions.config.ts` / `vitest.gateway.config.ts` / `vitest.e2e.config.ts` / `vitest.live.config.ts` の 5 設定でテスト粒度を制御。テストの同居により「テストのないコード」を発見しやすくなる

- `[AVOID]` workspace の `dependencies` に `workspace:*` プロトコルを使って循環依存を作る。拡張パッケージがコアに依存する場合は `devDependencies` + ランタイムエイリアス解決にする
  - 根拠: `AGENTS.md:12` に「Avoid `workspace:*` in `dependencies` (npm install breaks)」と明記。extension は `devDependencies` でコアを参照し、本番インストール時は `npm install --omit=dev` で独立動作する

## 適用チェックリスト

- [ ] monorepo のパッケージ分割が「配布境界」に沿っているか確認する（内部ドメイン分割のためだけにパッケージを作っていないか）
- [ ] プラグイン/拡張向けの公開 API 面が明示的に定義されているか（内部モジュールへの直接 import が構造的に遮断されているか）
- [ ] ファイル LOC 上限を CI で自動検査するスクリプトを導入しているか
- [ ] テストファイルの配置戦略が統一されているか（同居 vs 分離、Vitest 設定による種別分離）
- [ ] 多言語プロジェクトの場合、型定義の同期を自動化し CI で検証しているか
- [ ] extension/plugin の依存方向が一方向であることを package.json レベルで強制しているか
- [ ] 宣言的メタデータ（package.json のカスタムキーなど）でプラグイン発見をコードロード前に実行できるようになっているか
