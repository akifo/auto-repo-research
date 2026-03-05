# project-structure

> リポジトリ: anomalyco/opencode
> 分析日: 2026-03-05

## 概要

opencode は TypeScript モノレポで、CLI コーディングエージェント（core）を中心に、Web UI・デスクトップ・SDK・プラグイン・エンタープライズコンソール・インフラ定義までを一つのリポジトリに収める構成を取っている。Bun Workspaces + Turborepo を基盤とし、パッケージ間の依存方向を厳密に制御することで、コアロジックと UI・配信チャネルを完全に分離している点が注目に値する。特に「SDK を契約層として core と全 UI を接続する」アーキテクチャは、マルチプラットフォーム対応のモノレポ設計として参考になる。

## 背景にある原則

- **SDK-first アーキテクチャ**: core（`opencode`）は Hono HTTP サーバーとして API を公開し、OpenAPI スペックから `@opencode-ai/sdk` のクライアントコードを自動生成する。UI パッケージは core を直接 import せず、必ず SDK 経由で通信する。これにより、core と UI の型安全性を OpenAPI スキーマで保証しつつ、両者のデプロイ・テストサイクルを独立させている（`packages/opencode/src/cli/cmd/generate.ts`, `packages/sdk/js/src/v2/gen/`）。

- **一方向依存の階層化**: 依存グラフは `util` (0依存) → `sdk` (0内部依存) → `plugin` (sdk) → `opencode` (util, sdk, plugin, script) → `ui` (sdk, util) → `app` (sdk, ui, util) → `desktop`/`desktop-electron` (app, ui) の順に流れる。下位パッケージが上位を import することは構造上不可能にしており、循環参照を防止している（各 `package.json` の `dependencies` フィールドで検証可能）。

- **配信チャネルの分離**: TUI（opentui/SolidJS ベース、core 内蔵）、Web UI（`packages/app`）、Tauri デスクトップ（`packages/desktop`）、Electron（`packages/desktop-electron`）の4つの配信チャネルがあるが、いずれも同じ SDK クライアントを通じて core と通信する。UI コンポーネントは `packages/ui` に共通化されている。

- **機能境界としてのディレクトリ = パッケージ**: 「パッケージに分けるかどうか」の判断基準が明確で、npm 公開・外部消費されるもの（sdk, plugin）、独立した配信単位（app, desktop, web）、内部共有ユーティリティ（util, ui）で切り分けている。

## 実例と分析

### パッケージ依存グラフの全体像

モノレポ全体の依存方向を整理すると以下の階層になる:

**Tier 0（依存なし）**: `util`, `sdk`, `script`, `function`, `console/mail`, `console/resource`, `identity`
**Tier 1（Tier 0 のみ依存）**: `plugin` → sdk, `ui` → sdk + util, `console/core` → console/mail + console/resource
**Tier 2**: `opencode` → util + sdk + plugin + script, `app` → sdk + ui + util, `slack` → sdk, `enterprise` → util + ui
**Tier 3**: `desktop` → app + ui, `desktop-electron` → app + ui, `console/app` → console/core + console/mail + console/resource + ui
**Tier 4**: `web` → opencode (公開サイト / Astro)

`web` パッケージのみ `opencode` を直接参照するが、これはドキュメントサイトが CLI のバージョン情報を参照するためで、ランタイム依存ではない。

### SDK による契約層の実装

core の Hono サーバーは `hono-openapi` で OpenAPI スペックを自動生成する:

```typescript
// packages/opencode/src/server/server.ts:4
import { describeRoute, generateSpecs, openAPIRouteHandler, resolver, validator } from "hono-openapi";
```

`opencode generate` コマンドでスペックを JSON 出力し、`@hey-api/openapi-ts` で SDK クライアントを生成する:

```typescript
// packages/opencode/src/cli/cmd/generate.ts:7-8
const specs = await Server.openapi();
// ... JSON 出力 → @hey-api/openapi-ts で gen/ ディレクトリに型 + クライアント生成
```

生成結果は `packages/sdk/js/src/v2/gen/` に配置され、手書きの薄いラッパーがエクスポートする:

```typescript
// packages/sdk/js/src/v2/client.ts:3-6
import { createClient } from "./gen/client/client.gen.js";
import { type Config } from "./gen/client/types.gen.js";
import { OpencodeClient } from "./gen/sdk.gen.js";
```

### Bun Catalog によるバージョン一元管理

root `package.json` の `workspaces.catalog` で主要ライブラリのバージョンを一箇所に定義し、各パッケージは `"catalog:"` で参照する:

```json
// package.json:26-67 (抜粋)
"catalog": {
  "zod": "4.1.8",
  "hono": "4.10.7",
  "ai": "5.0.124",
  "solid-js": "1.9.10",
  "typescript": "5.8.2"
}

// packages/util/package.json:13
"dependencies": {
  "zod": "catalog:"
}
```

これにより、30以上のカタログエントリで全パッケージのバージョンを同期し、ロックファイルの不整合を防いでいる。

### Instance.state による per-project ステート管理

core パッケージ内では `Instance.state()` パターンが横断的に使われ、プロジェクトディレクトリをキーとしたシングルトン状態を管理する:

```typescript
// packages/opencode/src/project/state.ts:12-29
export function create<S>(root: () => string, init: () => S, dispose?: (state: Awaited<S>) => Promise<void>) {
  return () => {
    const key = root();
    let entries = recordsByKey.get(key);
    if (!entries) {
      entries = new Map<string, Entry>();
      recordsByKey.set(key, entries);
    }
    const exists = entries.get(init);
    if (exists) return exists.state as S;
    const state = init();
    entries.set(init, { state, dispose });
    return state;
  };
}
```

Bus, Plugin, ToolRegistry, Server など 10 以上のモジュールがこのパターンで初期化される。init 関数自体をキーに使うことで、同一プロジェクト内で同じ初期化を二度走らせない。

### core 内部の機能分割

`packages/opencode/src/` は 40 以上のサブディレクトリに分かれ、各ディレクトリが1つの機能ドメインを担う。パス別名 `@/` を `tsconfig.json` の `paths` で定義し、内部モジュール間の import を簡潔にしている:

```json
// packages/opencode/tsconfig.json:11-14
"paths": {
  "@/*": ["./src/*"],
  "@tui/*": ["./src/cli/cmd/tui/*"]
}
```

TUI は core パッケージ内に同梱されている（`src/cli/cmd/tui/`）が、Web UI は別パッケージ（`packages/app`）。これは TUI が CLI プロセスと同一プロセスで動作する必要があるためで、Web UI はサーバーとは別プロセスで動く。

### console サブワークスペース

`packages/console/` は5つのサブパッケージ（app, core, function, mail, resource）を持つネストされたワークスペースで、SaaS 管理画面を構成する。root の `workspaces.packages` に `"packages/console/*"` が含まれており、Bun がフラット + ネスト両方のワークスペースを解決する。

## パターンカタログ

- **Facade パターン** (構造)
  - 解決する問題: core の複雑な内部モジュール構成を外部パッケージから隠蔽する
  - 適用条件: 複数配信チャネルが同一バックエンドを消費するシステム
  - コード例: `packages/sdk/js/src/v2/client.ts:8-31` — 生成コードを薄いラッパーで包む
  - 注意点: SDK とサーバーの API バージョンを同期する運用が必要（OpenAPI 生成で自動化）

- **Registry パターン** (振る舞い)
  - 解決する問題: ツール・プラグイン・イベントなどの拡張ポイントを動的に登録する
  - 適用条件: プラグインシステムや拡張可能なツールセットを持つアプリケーション
  - コード例: `packages/opencode/src/bus/bus-event.ts:10-19` — `Map` ベースのイベント登録, `packages/opencode/src/tool/registry.ts:34-59` — ツール登録
  - 注意点: Registry は per-instance で管理し、グローバル汚染を避ける（Instance.state で実現）

## Good Patterns

- **OpenAPI スキーマからの SDK 自動生成**: サーバーの Zod スキーマ → hono-openapi → OpenAPI JSON → @hey-api/openapi-ts → 型付き SDK クライアントという一気通貫のパイプラインにより、API 契約の手動同期が不要。core の API 変更がそのまま SDK の型エラーとして全 UI パッケージに伝播する。

```typescript
// packages/opencode/src/cli/cmd/generate.ts:7
const specs = await Server.openapi();
// → packages/sdk/js/src/v2/gen/ に型 + クライアントが生成される
```

- **util パッケージの最小設計**: `@opencode-ai/util` は error, retry, slug, path など 11 ファイルで構成され、外部依存は zod のみ。core と UI の両方から参照される共通基盤を最小限に保つことで、依存グラフの底辺を安定させている。

```json
// packages/util/package.json:13-15
"dependencies": {
  "zod": "catalog:"
}
```

- **namespace パターンによるモジュール公開**: core 内の各機能は TypeScript の `namespace` で公開され、関連する型・関数・状態を一つの名前空間にまとめている。`export namespace Bus`, `export namespace Plugin`, `export namespace Agent` などがこのパターンを使い、IDE でのオートコンプリートを効かせつつモジュールの凝集度を高めている。

```typescript
// packages/opencode/src/bus/index.ts:7
export namespace Bus {
  const log = Log.create({ service: "bus" });
  // ... publish, subscribe 等のメソッド
}
```

## Anti-Patterns / 注意点

- **config.ts の肥大化**: `packages/opencode/src/config/config.ts` が 1403 行と突出して大きい。設定スキーマ定義・デフォルト値・マイグレーション・ファイル読み込みロジックが混在しており、モノレポ設計の良さを core 内部で活かしきれていない例。

```
Bad: 1ファイルに全設定ロジックを集約（1403 行）
Better: schema, defaults, loader, migration を分割し、各々 200-400 行に収める
```

- **TUI の core 同梱**: TUI コード（`src/cli/cmd/tui/`）が core パッケージ内にあるため、CLI のみ使うユーザーも SolidJS + opentui の依存を引き込む。プロセス共有の制約があるとはいえ、条件付き dynamic import や別パッケージ化で依存を軽減できる余地がある。

```
Bad: core パッケージの dependencies に @opentui/solid, solid-js が含まれる
Better: TUI 関連依存を optionalDependencies にするか、別パッケージに切り出して dynamic import
```

## 導出ルール

- `[MUST]` モノレポ内のパッケージ間依存は一方向のみ許可し、依存グラフに循環を作らない
  - 根拠: opencode では util → sdk → plugin → core → ui → app → desktop と依存が厳密に一方向に流れ、各 package.json で強制されている

- `[MUST]` マルチクライアント構成では API スキーマから SDK を自動生成し、サーバーとクライアントの型整合性を機械的に保証する
  - 根拠: hono-openapi → OpenAPI JSON → @hey-api/openapi-ts のパイプラインにより、API 変更が SDK の型エラーとして全 UI パッケージに即座に伝播する

- `[SHOULD]` モノレポの共通ユーティリティパッケージは外部依存を最小限（1-2 個）に抑え、依存グラフの底辺を安定させる
  - 根拠: `@opencode-ai/util` は zod のみに依存する 11 ファイル構成で、core・UI・enterprise の 5 パッケージから安全に参照されている

- `[SHOULD]` Bun/pnpm の catalog 機能を使い、モノレポ全体で共有するライブラリのバージョンを root package.json で一元管理する
  - 根拠: opencode は 30 以上の catalog エントリ（zod, hono, solid-js, typescript 等）で全パッケージのバージョンを同期している

- `[SHOULD]` 同一プロセスで動作する必要がある UI（TUI 等）はコアに同梱し、別プロセスで動作する UI（Web, Desktop）は独立パッケージにする
  - 根拠: TUI は `packages/opencode/src/cli/cmd/tui/` にコア同梱、Web UI は `packages/app` に分離されている。プロセス境界がパッケージ境界の判断基準になっている

- `[AVOID]` 複数の配信チャネル（CLI, Web, Desktop）から core のコードを直接 import する構成
  - 根拠: opencode では全 UI が `@opencode-ai/sdk` 経由で通信し、core の内部構造変更が UI に影響しない設計を実現している

## 適用チェックリスト

- [ ] パッケージ間の依存方向を図示し、循環参照がないことを確認する
- [ ] 複数クライアントが存在する場合、API スキーマからの SDK 自動生成パイプラインを導入しているか
- [ ] 共通ユーティリティパッケージの外部依存が最小限か（3 個以下が目安）
- [ ] モノレポ全体で共有するライブラリバージョンを catalog/カタログで一元管理しているか
- [ ] 「同一プロセスで動くか / 別プロセスで動くか」を基準にパッケージ境界を決めているか
- [ ] 各パッケージの責務が「npm 公開単位」「配信チャネル」「共有ライブラリ」のいずれかに該当するか
- [ ] SDK パッケージが core の内部型を直接 re-export していないか（生成コードのみを公開しているか）
