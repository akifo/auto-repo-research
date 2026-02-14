# testing-practices

> リポジトリ: openclaw/openclaw
> 分析日: 2026-02-14

## 概要

大規模 TypeScript モノリポ（src 約 700 ユニットテスト + 363 E2E テスト + 10 ライブテスト）における Vitest ベースのテスト戦略を分析した。テストを「unit / e2e / live」の 3 層に明確に分類し、6 つの Vitest 設定ファイルで実行スコープを制御する構成が特徴的である。カスタム並列実行スクリプト（`scripts/test-parallel.mjs`）で vmForks プールと forks プールを動的に使い分け、CI/ローカル環境の差異を吸収している点、環境分離を徹底するセットアップ基盤（`test/test-env.ts`）の設計が注目に値する。

## 背景にある原則

- **テスト分類による実行コスト制御**: テストを unit（外部依存なし）、e2e（ビルド成果物とサーバ起動を伴う）、live（実 API キーが必要）の 3 層に分け、ファイル命名で分類を表現する（`*.test.ts`, `*.e2e.test.ts`, `*.live.test.ts`）。これにより、開発者は `pnpm test`（unit のみ）で高速フィードバックを得つつ、CI でのみ e2e を実行するワークフローが成立する。根拠: `vitest.config.ts:37-39` の exclude パターンで live/e2e を除外し、`vitest.e2e.config.ts` と `vitest.live.config.ts` が専用 include を定義している。

- **環境汚染ゼロの原則**: テストは本番の設定・認証情報・状態ディレクトリに一切触れてはならない。グローバルセットアップで HOME を一時ディレクトリに差し替え、API トークンやポートを削除する。根拠: `test/test-env.ts:94-121` で HOME, XDG ディレクトリ, 全チャネルトークンを隔離している。

- **カバレッジ除外は意図の文書化**: カバレッジ閾値（70%/55%）を設けつつ、除外対象にはコメントで理由を付記する。CLI エントリポイント・インタラクティブ UI・チャネル統合層は「e2e/手動で検証」と明記し、カバレッジ対象から外す。根拠: `vitest.config.ts:51-106` の exclude リストに付随するコメント群。

- **並列実行の安全限界を経験則で管理**: ワーカー数の上限を 16 に固定し、CI/ローカル/OS 別に動的調整する。根拠: `AGENTS.md:89`「Do not set test workers above 16; tried already」および `scripts/test-parallel.mjs:41-44` の vmForks 判定ロジック。

## 実例と分析

### 3 層テスト分類とファイル命名規約

テスト分類をファイル名サフィックスで表現する:

| 分類 | サフィックス | 実行タイミング | 外部依存 |
|------|------------|-------------|---------|
| Unit | `*.test.ts` | 常時（`pnpm test`） | なし |
| E2E | `*.e2e.test.ts` | CI / 手動（`pnpm test:e2e`） | ビルド成果物・サーバ |
| Live | `*.live.test.ts` | 手動のみ（`LIVE=1 pnpm test:live`） | 実 API キー |

この分類は Vitest の config include/exclude で実行スコープを機械的に制御できる。

### 6 設定ファイルによるスコープ分割

ベース設定（`vitest.config.ts`）を他の 5 設定が継承する:

```typescript
// vitest.unit.config.ts:1-17
import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

const baseTest = (baseConfig as { test?: { include?: string[]; exclude?: string[] } }).test ?? {};
const include = (
  baseTest.include ?? ["src/**/*.test.ts", "extensions/**/*.test.ts", "test/format-error.test.ts"]
).filter((pattern) => !pattern.includes("extensions/"));

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseTest,
    include,
    exclude: [...exclude, "src/gateway/**", "extensions/**"],
  },
});
```

`vitest.gateway.config.ts` は gateway 系テストのみ、`vitest.extensions.config.ts` は拡張のみを対象とし、ドメイン単位の独立実行を可能にしている。

### カスタム並列実行スクリプト

`scripts/test-parallel.mjs` は Vitest の単一プロセス実行では得られない制御を実現している:

- **vmForks と forks の使い分け**: Node 24 の regressions を避けるため、Node バージョンと OS で vmForks を動的に切り替える（`test-parallel.mjs:41-44`）
- **isolation-sensitive なテストの分離**: 特定ファイルを `unitIsolatedFiles` リストで管理し、`--pool=forks` で個別実行する（`test-parallel.mjs:8-30`）
- **ドメイン別並列度の制御**: unit / extensions / gateway に異なるワーカー数を割り当てる（`test-parallel.mjs:130-150`）

```javascript
// scripts/test-parallel.mjs:130-150
const maxWorkersForRun = (name) => {
  if (resolvedOverride) return resolvedOverride;
  if (isCI && !isMacOS) return null;
  if (isCI && isMacOS) return 1;
  if (name === "unit-isolated") return 1;
  if (name === "extensions") return defaultExtensionsWorkers;
  if (name === "gateway") return defaultGatewayWorkers;
  return defaultUnitWorkers;
};
```

### 環境分離の 3 層アーキテクチャ

1. **グローバルセットアップ**（`test/setup.ts`）: プラグインレジストリのスタブ注入、フェイクタイマーの漏洩検知、env unstub を有効化
2. **テスト環境隔離**（`test/test-env.ts`）: HOME を一時ディレクトリに差し替え、全トークン・設定パスを削除
3. **テストごとの temp-home**（`test/helpers/temp-home.ts`）: `withTempHome()` で個別テストに隔離ホームを提供

```typescript
// test/setup.ts:171-180
beforeEach(() => {
  setActivePluginRegistry(DEFAULT_PLUGIN_REGISTRY);
});

afterEach(() => {
  // Guard against leaked fake timers across test files/workers.
  if (vi.isFakeTimers()) {
    vi.useRealTimers();
  }
});
```

### ポート衝突回避の決定論的割り当て

並列テストでサーバを起動する際、OS フリーポートだけでは派生ポート（+1, +2, +3）の衝突が起きる。`src/test-utils/ports.ts` はワーカー ID ベースのブロック割り当てで解決している:

```typescript
// src/test-utils/ports.ts:43-78
export async function getDeterministicFreePortBlock(params?: {
  offsets?: number[];
}): Promise<number> {
  const offsets = params?.offsets ?? [0, 1, 2, 3, 4];
  const workerIdRaw = process.env.VITEST_WORKER_ID ?? process.env.VITEST_POOL_ID ?? "";
  const workerId = Number.parseInt(workerIdRaw, 10);
  const rangeSize = 1000;
  const shardCount = 30;
  const base = 30_000 + (Math.abs(shard) % shardCount) * rangeSize;
  // ...ブロック単位でプローブし、派生ポートの衝突を回避
}
```

### Live テストの条件付きスキップパターン

Live テストは環境変数と API キーの有無で `describe.skip` に切り替える統一パターンを使う:

```typescript
// src/agents/anthropic.setup-token.live.test.ts:31-32
const ENABLED = LIVE && Boolean(SETUP_TOKEN_RAW || SETUP_TOKEN_VALUE || SETUP_TOKEN_PROFILE);
const describeLive = ENABLED ? describe : describe.skip;
```

この `const describeLive = CONDITION ? describe : describe.skip` パターンは全 10 件の live テストで一貫している。

### 粒度の細かいテストファイル分割

E2E テストではテストケースの説明をファイル名に埋め込む命名規約を採用している:

```
src/auto-reply/reply.directive.directive-behavior.applies-inline-reasoning-mixed-messages-acks-immediately.e2e.test.ts
src/agents/models-config.falls-back-default-baseurl-token-exchange-fails.e2e.test.ts
```

この「モジュール.コンテキスト.振る舞い.e2e.test.ts」形式により、テストファイル一覧がそのままテスト仕様書として機能する。ファイルレベルの分離は vmForks プールでの相互干渉も防ぐ。

## パターンカタログ

- **Test Double Registry**（分類: 振る舞い / Registry パターンの変形）
  - 解決する問題: チャネルプラグインの依存をテストで差し替える必要があるが、毎テストの生成コストが高い
  - 適用条件: プラグインレジストリのようなグローバル状態を持つシステム
  - コード例: `test/setup.ts:166-173` -- immutable なデフォルトレジストリを beforeEach で再設定
  - 注意点: 「Creating a fresh registry before every single test was measurable overhead」とコメントにあり、パフォーマンス計測の結果としてキャッシュを導入している

- **Builder Pattern for Mocks**（分類: 生成）
  - 解決する問題: 外部ライブラリ（Baileys）のモック構築が複雑
  - 適用条件: 複数のテストで同じモック構造が必要な場合
  - コード例: `test/mocks/baileys.ts:24-66` -- `createMockBaileys()` ファクトリが型安全なモックを生成

## Good Patterns

- **カバレッジ除外にコメントで意図を明記**: カバレッジ対象外ファイルに必ず理由コメントを付ける。「Entrypoints and wiring (covered by CI smoke + manual/e2e flows)」のように、どの検証手段でカバーされるかを記述する（`vitest.config.ts:52-106`）。これにより、除外の妥当性が後から検証可能になる。

- **unstubEnvs/unstubGlobals の明示的有効化**: Vitest の `unstubEnvs: true` と `unstubGlobals: true` をベース設定で有効にし、`vi.stubEnv()` のスコープ漏洩を防止する（`vitest.config.ts:23-24`）。コメントで「especially important under pool=vmForks where env leaks cross-file」と理由を記述している。

- **フェイクタイマー漏洩の afterEach ガード**: テスト後にフェイクタイマーが残っていないか自動チェックし、残っていればリアルタイマーに戻す（`test/setup.ts:176-179`）。

- **決定論的ポートブロック割り当て**: ワーカー ID に基づくポート範囲の事前割り当てにより、OS のフリーポート探索に依存せず並列テストのポート衝突を防ぐ（`src/test-utils/ports.ts:43-78`）。

## Anti-Patterns / 注意点

- **テストファイル内での手動 env 復元**: 一部のテストファイルで `const previousHome = process.env.HOME` + `afterEach` による手動復元が散見される。グローバルセットアップの `withIsolatedTestHome()` があるにもかかわらず、個別テストで独自の HOME 差し替えが必要になるケースが存在する。

```typescript
// Bad: 手動 env スナップショット/リストア（src/agents/agent-paths.e2e.test.ts:8-33）
const previousStateDir = process.env.OPENCLAW_STATE_DIR;
afterEach(async () => {
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
});

// Better: vi.stubEnv() を利用（unstubEnvs: true で自動復元される）
beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempStateDir);
});
```

- **超長テストファイル名**: ファイル名にテストケースの説明を詰め込みすぎると、ファイルシステムの制約に近づき、ツールの表示が崩れる。`reply.triggers.trigger-handling.ignores-inline-elevated-directive-unapproved-sender.e2e.test.ts`（89 文字）のようなケースは限界に近い。セグメント名の粒度を 3-4 レベルに留める運用ルールが必要。

## 導出ルール

- `[MUST]` テスト分類をファイル命名規約で機械的に表現し、Vitest config の include/exclude で実行スコープを制御する
  - 根拠: `*.test.ts` / `*.e2e.test.ts` / `*.live.test.ts` の 3 層分類により、`pnpm test` が unit のみを実行し、e2e/live は専用コマンドで明示実行する構成が実現されている（`vitest.config.ts:37-39`）

- `[MUST]` テストのグローバルセットアップで HOME・認証トークン・状態ディレクトリを一時領域に隔離し、本番環境に一切触れない構成にする
  - 根拠: `test/test-env.ts` が HOME, XDG 各ディレクトリ, 全チャネルトークン, NODE_OPTIONS を隔離しており、開発者の実環境を破壊するリスクを排除している

- `[SHOULD]` カバレッジ除外リストの各エントリに、代替の検証手段をコメントで明記する
  - 根拠: `vitest.config.ts:52` の「Entrypoints and wiring (covered by CI smoke + manual/e2e flows)」のように除外理由を文書化し、カバレッジの穴が意図的であることを後から検証可能にしている

- `[SHOULD]` 並列テストでサーバポートを使用する場合、OS フリーポートではなくワーカー ID ベースの決定論的ポートブロック割り当てを採用する
  - 根拠: `src/test-utils/ports.ts` で派生ポート（base+1, base+2 等）の衝突を防ぐブロック割り当て方式を実装しており、フリーポートのみでは発生する EADDRINUSE フレーク問題を解消している

- `[SHOULD]` Vitest の `unstubEnvs: true` と `unstubGlobals: true` をベース設定で有効化し、`vi.stubEnv()` のスコープ漏洩を防ぐ
  - 根拠: `vitest.config.ts:23-24` のコメント「especially important under pool=vmForks where env leaks cross-file」で明示されている通り、vmForks プールでの cross-file 汚染を防止する

- `[SHOULD]` Live テスト（外部 API 呼び出し）は `const describeLive = CONDITION ? describe : describe.skip` パターンで環境変数ゲートし、通常の test コマンドでスキップされるようにする
  - 根拠: 全 10 件の live テストファイルで統一的にこのパターンが使われており、API キーなしの環境でのテスト失敗を防いでいる

- `[AVOID]` テストのワーカー数を環境に合わせた上限なしに増やすこと -- 経験的に 16 を超えると安定性が低下する
  - 根拠: `AGENTS.md:89`「Do not set test workers above 16; tried already」および `scripts/test-parallel.mjs` での CI/ローカル/OS 別の動的制御

## 適用チェックリスト

- [ ] テスト分類（unit / integration / e2e / live）をファイル命名規約で定義し、Vitest config で include/exclude を設定する
- [ ] グローバルセットアップで HOME・認証情報・状態ディレクトリを一時領域に隔離する
- [ ] `unstubEnvs: true` と `unstubGlobals: true` を Vitest ベース設定に追加する
- [ ] カバレッジ除外リストの各エントリに代替検証手段のコメントを付記する
- [ ] 並列テストでポートを使う場合、決定論的ポートブロック割り当てユーティリティを導入する
- [ ] フェイクタイマーの漏洩を afterEach ガードで自動検知・復元する
- [ ] Live テスト用の `describeLive` パターンを標準化し、API キーなし環境でのスキップを保証する
- [ ] CI ワークフローで遅いテストのレポートを自動生成し、パフォーマンス回帰を可視化する
- [ ] テスト並列度を CI / ローカル / OS 別に調整するスクリプトを用意する
