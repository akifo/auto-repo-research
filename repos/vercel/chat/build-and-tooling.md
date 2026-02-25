# Build and Tooling

> リポジトリ: vercel/chat
> 分析日: 2026-02-25

## 概要

Turborepo + tsup + pnpm によるモノレポのビルドパイプラインとツールチェーン設計を分析した。12 パッケージ（コアSDK、7アダプター、3ステートアダプター、統合テスト）+ ドキュメントサイト + サンプルアプリで構成されるモノレポで、tsup による ESM 単一フォーマット出力、Turborepo によるタスク依存グラフ、モック環境変数を使ったビルド検証（build:validate）、Knip による未使用コード検出を組み合わせた堅牢なパイプラインを構築している。特筆すべきは「validate スクリプトによるゲート」と「tsup の external/noExternal による意図的なバンドル境界制御」のプラクティスである。

## 背景にある原則

- **ビルドは依存グラフの宣言であり、手続きではない**: Turborepo の `dependsOn` で `build → ^build`（上流パッケージを先にビルド）、`test → build`（テスト前にビルド）、`typecheck → ^build`（型チェック前に上流ビルド）という依存関係を宣言的に定義している。ビルド順序を手続き的に記述せず、グラフとして宣言することで、並列実行・キャッシュが自動で適用される（`turbo.json:17-36`）

- **パッケージ境界はバンドルの外部化で表現する**: tsup の `external` オプションで各アダプターが自身のプラットフォーム SDK（`@slack/web-api`, `discord-api-types`, `botbuilder` 等）を外部化している。これにより利用者が使わないプラットフォームの依存をバンドルに含めない設計になっている。逆に `noExternal` で意図的にバンドルに含める判断もしている（Teams アダプターの `@microsoft/microsoft-graph-client`）

- **検証ゲートは段階的かつ順序付きであるべし**: validate スクリプトが `knip && check && typecheck && test && build:validate` の順で実行され、軽量なチェックから重い検証へと段階的に進む。早期に失敗させることでフィードバックループを短縮している（`package.json:22`）

- **CI でのビルドには環境変数のモックが必要**: 外部サービス連携を前提とするアプリケーションでは、ビルド時にも環境変数が必要になる。`build:validate` スクリプトでモック値を注入することで、シークレットなしでもビルドの健全性を検証できる設計（`package.json:16`）

## 実例と分析

### tsup 設定の統一パターンと意図的な差異

11 パッケージすべてで tsup を使用しており、共通の基本設定がある:

- `format: ["esm"]` — ESM 単一出力（CJS を出さない）
- `dts: true` — 型定義を同時生成
- `clean: true` — ビルド前にクリーン
- `sourcemap: true` — ソースマップ出力

差異はエントリポイントと外部化設定にのみ現れる:

| パッケージ      | entry                                    | external                                                      | noExternal                              |
| --------------- | ---------------------------------------- | ------------------------------------------------------------- | --------------------------------------- |
| chat            | `["src/index.ts", "src/jsx-runtime.ts"]` | なし                                                          | なし                                    |
| adapter-slack   | `["src/index.ts"]`                       | `["@slack/web-api"]`                                          | なし                                    |
| adapter-discord | `["src/index.ts"]`                       | `["discord-api-types"]`                                       | なし                                    |
| adapter-teams   | `["src/index.ts"]`                       | `["botbuilder"]`                                              | `["@microsoft/microsoft-graph-client"]` |
| adapter-gchat   | `["src/index.ts"]`                       | `["googleapis"]`                                              | なし                                    |
| adapter-github  | `["src/index.ts"]`                       | `["@octokit/rest", "@octokit/webhooks", "@octokit/auth-app"]` | なし                                    |
| adapter-linear  | `["src/index.ts"]`                       | `["@linear/sdk"]`                                             | なし                                    |
| adapter-shared  | `["src/index.ts"]`                       | なし                                                          | なし                                    |
| state-redis     | `["src/index.ts"]`                       | `["redis"]`                                                   | なし                                    |
| state-ioredis   | `["src/index.ts"]`                       | `["ioredis"]`                                                 | なし                                    |
| state-memory    | `["src/index.ts"]`                       | なし                                                          | なし                                    |

adapter-teams だけが `noExternal` を使い `@microsoft/microsoft-graph-client` をバンドルに含めている。これは `devDependencies` に宣言されたパッケージをビルド成果物にインライン化する手法で、利用者が明示的にインストールする必要がなくなる。

### Turborepo タスク依存グラフの設計

```
build → ^build          （上流の build 完了後に自身を build）
test → build            （自身の build 完了後にテスト）
typecheck → ^build      （上流の build 完了後に型チェック）
dev → (cache: false)    （キャッシュ無効、永続タスク）
clean → (cache: false)  （キャッシュ無効）
```

`test` が `build` に依存（`^build` ではなく `build`）している点が重要。これにより自分自身のビルドが完了してからテストが走る。統合テストパッケージ（integration-tests）はビルドスクリプトを持たないが、依存先のアダプターパッケージのビルドは `build → ^build` により保証される。

`turbo.json` の `outputs` 定義も注目に値する。`build` タスクは `["dist/**", "docs/**", ".next/**", "!.next/cache/**"]` を出力として宣言し、Next.js のキャッシュディレクトリを明示的に除外している。

### tsconfig.base.json による共有設定と継承パターン

コアの TypeScript 設定を `tsconfig.base.json` で一元管理し、各パッケージの `tsconfig.json` が `extends` で継承する:

```
tsconfig.base.json (共有)
  ├── packages/chat/tsconfig.json
  ├── packages/adapter-slack/tsconfig.json
  ├── packages/adapter-discord/tsconfig.json
  ├── packages/adapter-teams/tsconfig.json
  ├── packages/adapter-gchat/tsconfig.json
  ├── packages/adapter-github/tsconfig.json
  ├── packages/adapter-linear/tsconfig.json
  ├── packages/adapter-shared/tsconfig.json
  ├── packages/state-redis/tsconfig.json
  ├── packages/state-ioredis/tsconfig.json
  └── packages/state-memory/tsconfig.json
```

各パッケージは `outDir`, `rootDir`, `strictNullChecks` のみをオーバーライドする。一方で `apps/docs`, `examples/nextjs-chat`, `packages/integration-tests` は `extends` を使わず独自の tsconfig を持つ。これは Next.js やテスト環境では `dom` lib、`jsx: react-jsx` など異なる設定が必要なためである。

共有設定のキーポイント:

- `verbatimModuleSyntax: true` — `import type` と `import` を厳密に区別
- `moduleResolution: "bundler"` — バンドラー前提の解決
- `isolatedModules: true` — ファイル単位のトランスパイル互換性を保証
- `declaration: true` + `declarationMap: true` — 型定義とソースへのマッピングを生成

### workspace:* による依存管理とバージョン同期

全パッケージ間の依存は `"workspace:*"` で宣言され、常にローカルの最新コードを参照する。公開パッケージは全て同一バージョン（4.14.0）に揃えられ、Changesets で一括バージョニングされる。非公開パッケージ（integration-tests: 4.0.0）だけが異なるバージョンを持つ。

依存グラフの構造:

```
chat (コア)
  ← adapter-shared ← adapter-slack, adapter-discord, adapter-teams, adapter-gchat, adapter-github, adapter-linear
  ← state-memory, state-redis, state-ioredis
  ← integration-tests (adapter-discord, adapter-gchat, adapter-slack, adapter-teams, state-memory に依存)
  ← examples/nextjs-chat (全アダプター + state-redis に依存)
```

### validate スクリプトのゲート設計

```bash
pnpm knip && pnpm check && turbo typecheck && turbo test && pnpm build:validate
```

この順序は意図的に設計されている:

1. `knip` — 未使用エクスポート・依存関係の検出（最も軽量）
2. `check` — Biome/Ultracite によるリント・フォーマットチェック
3. `typecheck` — TypeScript の型チェック（`^build` に依存するため上流ビルドを含む）
4. `test` — テスト実行（`build` に依存するためビルドを含む）
5. `build:validate` — モック環境変数付きフルビルド（最も重い）

`test` が `--filter='!example-nextjs-chat'` でサンプルアプリを除外している点も重要。サンプルアプリはライブラリの動作検証には不要であり、環境変数やインフラ依存を持つため CI で安定的に実行できない。

### Vitest ワークスペース構成

`vitest.workspace.ts` で 11 パッケージを明示的に列挙し、各パッケージが独自の `vitest.config.ts` を持つ。integration-tests は workspace に含まれず、独立して実行される。chat パッケージの vitest.config.ts だけが特殊で、カスタム JSX ランタイムを esbuild の JSX トランスフォームにマッピングしている。

### example アプリの TypeScript paths による開発体験

`examples/nextjs-chat/tsconfig.json` で `paths` を使い、workspace パッケージのソースコードを直接参照している:

```json
"paths": {
  "chat": ["../../packages/chat/src/index.ts"],
  "@chat-adapter/slack": ["../../packages/adapter-slack/src/index.ts"]
}
```

これにより開発中は dist ディレクトリではなくソースコードを直接参照でき、ビルドなしで型チェックが通る。

## コード例

```typescript
// turbo.json:17-36
"tasks": {
  "build": {
    "dependsOn": ["^build"],
    "outputs": ["dist/**", "docs/**", ".next/**", "!.next/cache/**"]
  },
  "test": {
    "dependsOn": ["build"],
    "outputs": []
  },
  "typecheck": {
    "dependsOn": ["^build"],
    "outputs": []
  }
}
```

```typescript
// packages/adapter-teams/tsup.config.ts:1-11
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ["botbuilder"],
  noExternal: ["@microsoft/microsoft-graph-client"],
});
```

```typescript
// packages/chat/tsup.config.ts:1-9
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/jsx-runtime.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
```

```json
// tsconfig.base.json:1-18
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "lib": ["ES2022"],
    "types": ["node"]
  }
}
```

```json
// package.json:14-25 (scripts)
"scripts": {
  "build": "turbo build",
  "build:validate": "SLACK_BOT_TOKEN=xoxb-mock SLACK_SIGNING_SECRET=mock ... turbo build",
  "test": "turbo test --filter='!example-nextjs-chat'",
  "validate": "pnpm knip && pnpm check && turbo typecheck && turbo test && pnpm build:validate",
  "check": "ultracite check",
  "fix": "ultracite fix"
}
```

```yaml
# .github/workflows/ci.yml:13-91
jobs:
  lint:          # check + knip (並列)
  typecheck:     # turbo typecheck (並列)
  build-and-test: # build → test (直列、モック環境変数付き)
```

## パターンカタログ

- **Facade パターン** (分類: 構造)
  - 解決する問題: 各パッケージの tsup 設定が共通部分を持ちつつアダプター固有の差異（external/noExternal）のみ異なる
  - 適用条件: 複数パッケージで同一バンドラーを使い、設定の大部分が共通の場合
  - コード例: 全 `tsup.config.ts` が `defineConfig` で統一された形式
  - 注意点: 共有設定を抽象化しすぎると個別カスタマイズが困難になるため、このリポジトリでは各ファイルに全設定を記述し「規約による統一」を選択している

- **Pipeline パターン** (分類: 振る舞い)
  - 解決する問題: 複数の検証ステップを順序付きで実行し、早期失敗を実現する
  - 適用条件: ビルド前に複数の品質ゲートを通す必要がある場合
  - コード例: `package.json:22` の validate スクリプト
  - 注意点: `&&` による直列実行で、前段の失敗が後段をスキップする

## Good Patterns

- **ESM 単一フォーマット出力**: 全パッケージで `format: ["esm"]` のみを出力している。CJS との互換性を切り捨てることでビルド設定がシンプルになり、Tree Shaking の効果も最大化される。`"type": "module"` と `verbatimModuleSyntax: true` で ESM が第一級市民であることを宣言している

```typescript
// packages/adapter-slack/tsup.config.ts:1-10
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"], // CJS なし
  dts: true,
  clean: true,
  sourcemap: true,
  external: ["@slack/web-api"],
});
```

- **モック環境変数によるビルド検証**: 外部サービスのシークレットが必要なアプリケーションビルドを、モック値を注入することで CI で検証可能にしている。`build:validate` と通常の `build` を分離することで、開発時は環境変数なしでライブラリビルドが完了する

```bash
# package.json:16
"build:validate": "SLACK_BOT_TOKEN=xoxb-mock SLACK_SIGNING_SECRET=mock ... turbo build"
```

- **テスト対象の明示的フィルタリング**: `turbo test --filter='!example-nextjs-chat'` でサンプルアプリをテスト対象から除外。Vitest workspace にも integration-tests を含めず独立実行とし、ライブラリのユニットテストとインフラ依存の統合テストを分離している

- **tsup external による選択的バンドル境界**: プラットフォーム SDK を `external` に指定することで、利用者が必要なアダプターのみ依存をインストールする設計を実現。逆に `noExternal` で devDependencies をバンドルに含めることで、利用者の依存管理を簡略化する判断もしている

```typescript
// packages/adapter-teams/tsup.config.ts:9-10
external: ["botbuilder"],           // 利用者がインストール
noExternal: ["@microsoft/microsoft-graph-client"],  // バンドルに含む
```

## Anti-Patterns / 注意点

- **tsconfig 継承の不統一**: ライブラリパッケージは `tsconfig.base.json` を `extends` で継承するが、apps/examples は独自設定を持つ。これは正当な理由（Next.js の要件）があるが、base 設定の変更が一部パッケージに反映されないリスクがある

```json
// Bad: apps/docs/tsconfig.json - base を継承せず独自設定
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "esnext",
    "moduleResolution": "bundler"
    // ... base と重複する設定が多数
  }
}
```

```json
// Better: 共通設定を継承しつつ、必要な差分のみオーバーライド
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["dom", "dom.iterable", "esnext"],
    "jsx": "react-jsx",
    "noEmit": true,
    "incremental": true
  }
}
```

- **tsup 設定の暗黙的な規約依存**: 11 パッケージの tsup 設定が「暗黙の規約」で統一されているが、共有設定（プリセット）やバリデーションがない。新パッケージ追加時に CJS を含めたり sourcemap を忘れたりするリスクがある

```typescript
// Bad: パッケージごとにすべての設定を再記述
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
```

```typescript
// Better: 共有プリセットを作成して差分のみ記述
import { baseConfig } from "../../tsup.base";
export default defineConfig({
  ...baseConfig,
  external: ["@slack/web-api"],
});
```

## 導出ルール

- `[MUST]` Turborepo のタスク依存に `test → build` を含め、テストがビルド成果物に対して実行されることを保証する
  - 根拠: `turbo.json` で `test` が `build` に依存し、integration-tests がビルド済みパッケージの dist を参照する設計で再現性を担保している

- `[MUST]` モノレポの validate/CI スクリプトでは軽量チェック（lint、未使用コード検出）を重いチェック（テスト、ビルド）より先に実行し、`&&` で連結して早期失敗させる
  - 根拠: `validate` スクリプトが `knip && check && typecheck && test && build:validate` の順で、フィードバックループを最短にしている

- `[SHOULD]` tsup（またはバンドラー）の `external` でプラットフォーム固有の SDK を外部化し、利用者が必要な依存のみインストールする設計にする
  - 根拠: 各アダプターがプラットフォーム SDK を external に指定し、不要なプラットフォームの依存がバンドルに含まれない構造を実現している

- `[SHOULD]` 外部サービス連携を持つアプリケーションのビルド検証には、モック環境変数を注入する専用スクリプト（`build:validate`）を用意する
  - 根拠: `build:validate` で `SLACK_BOT_TOKEN=xoxb-mock` 等を注入し、CI でシークレットなしにビルドの健全性を検証している

- `[SHOULD]` モノレポで TypeScript の共有設定（tsconfig.base.json）を定義し、各パッケージは差分のみオーバーライドする。フレームワーク固有の要件がある場合（Next.js の `dom` lib 等）のみ独自設定を許容する
  - 根拠: `tsconfig.base.json` に `target`, `module`, `moduleResolution`, `strict`, `verbatimModuleSyntax` 等を集約し、10 パッケージが `extends` で継承している

- `[SHOULD]` パッケージの出力フォーマットを ESM に統一し、`"type": "module"` と `verbatimModuleSyntax: true` で ESM ファーストを徹底する
  - 根拠: 全パッケージが `format: ["esm"]` のみ出力し、CJS 互換の複雑さを排除している

- `[AVOID]` サンプルアプリやインフラ依存テストを通常のテストスイートに含めない。`--filter` で除外するか、別の CI ジョブに分離する
  - 根拠: `turbo test --filter='!example-nextjs-chat'` でサンプルアプリを除外し、vitest.workspace.ts でも integration-tests を含めていない

## 適用チェックリスト

- [ ] turbo.json で `test → build` の依存を定義し、テストがビルド成果物に対して実行されるか確認する
- [ ] validate スクリプトで軽量チェック → 重いチェックの順序が守られているか確認する
- [ ] tsconfig.base.json を作成し、各パッケージが `extends` で継承しているか確認する
- [ ] 全パッケージの tsup 設定で `format`, `dts`, `sourcemap` が統一されているか確認する
- [ ] アダプターやプラグインパッケージでプラットフォーム SDK が `external` に指定されているか確認する
- [ ] 外部サービス連携を持つアプリのビルドが、モック環境変数で CI 上でも検証可能か確認する
- [ ] CI のジョブ分割で lint/typecheck/build+test が並列化されているか確認する
- [ ] サンプルアプリやインフラ依存テストが通常のテストスイートから除外されているか確認する
- [ ] Knip による未使用エクスポート・依存関係検出が validate に含まれているか確認する
