# project-structure

> リポジトリ: shadcn-ui/ui
> 分析日: 2026-03-04

## 概要

pnpm workspaces + Turborepo を用いたモノレポ構成を分析する。このリポジトリは「コンポーネントライブラリ」ではなく「コード配布プラットフォーム」という独自の性格を持ち、CLI ツール（packages/shadcn）、ドキュメント兼レジストリサーバ（apps/v4）、統合テスト（packages/tests）、スターターテンプレート（templates/）という 4 層構造を取る。プロダクトの性格がモノレポ設計にどう反映されているかが注目に値する。

## 背景にある原則

- **コンシューマ向けパッケージとインフラの分離**: npm に publish されるのは `packages/shadcn` の 1 パッケージのみ。ドキュメントサイト（apps/v4）やテスト（packages/tests）は private パッケージとして隔離し、publish 対象の表面積を最小化している。`package.json` の `"private": true` 設定と `"files": ["dist"]` で公開範囲を厳密に制御している（`packages/shadcn/package.json:5-6`）。

- **レジストリ駆動アーキテクチャによる責務集約**: コンポーネントの実体は `apps/v4/registry/` に集約し、CLI はそれを取得・変換するクライアントに徹する。これにより「コンポーネント定義」と「コンポーネント配布ロジック」が物理的に分離され、片方の変更がもう片方に波及しにくい。

- **テンプレートは独立リポジトリの写像として管理する**: `templates/` ディレクトリは `scripts/sync-templates.sh` で別リポジトリへ同期される。テンプレートをモノレポ内で管理しつつ、ユーザーがクローンする独立リポジトリとの一貫性を維持する設計（`scripts/sync-templates.sh:26`）。

- **pnpm-workspace.yaml の除外パターンで境界を明示する**: テスト用の一時ディレクトリや fixture を明示的に除外し、ワークスペース解決のノイズを防いでいる（`pnpm-workspace.yaml:4-8`）。

## 実例と分析

### ワークスペース構成と役割分担

モノレポは以下の 3 + 1 層構造を取る。

| 層 | パス | 役割 | private | publish |
|---|---|---|---|---|
| CLI (コア) | `packages/shadcn` | npm パッケージ。コンポーネントの取得・変換・配置 | No | Yes |
| ドキュメント + レジストリ | `apps/v4` | Next.js サイト。コンポーネント実体を JSON API として配信 | Yes | No |
| 統合テスト | `packages/tests` | CLI の E2E テスト。`workspace:*` で CLI に依存 | Yes | No |
| テンプレート | `templates/*` | ユーザー向けスターター。外部リポジトリへ同期 | - | No |

`apps/www` は deprecated として残されており、`.contentlayer` と `.next` のキャッシュのみが存在する。

### tsup による複数エントリポイントの公開

`packages/shadcn` は tsup で 6 つのエントリポイントをビルドし、`package.json` の `exports` フィールドで公開する。これにより、CLI としての利用（`bin`）と、プログラマティックな利用（`shadcn/registry`, `shadcn/schema`, `shadcn/mcp`, `shadcn/utils`）を 1 パッケージで実現している。

### Turborepo パイプラインの設計

`turbo.json` の `pipeline` 定義では、`build` タスクに `dependsOn: ["^build"]` を指定し、依存パッケージの build を先行させている。一方、`dev` と `test` は `cache: false` で常に再実行される。`registry:build` という独自タスクが定義されており、コンポーネントレジストリの JSON 生成パイプラインを Turborepo のタスクグラフに統合している。

### テスト分離の戦略

テストが 2 箇所に分かれている。

1. **ユニットテスト**: `packages/shadcn/src/` 内にコロケーション（例: `registry/api.test.ts`, `registry/resolver.test.ts`）。ルート `vitest.config.ts` が `packages/tests` を除外し、ユニットテストのみ実行。
2. **統合テスト**: `packages/tests/` に分離。独自の `vitest.config.ts` を持ち、`testTimeout: 120000` や `globalSetup` を設定。fixture ディレクトリのコピーと実際の CLI 実行を伴うため、長い実行時間が必要。

### テンプレートのモノレポ同期

`templates/monorepo-next` 自体がモノレポ構造を持つ。`packages/ui`（共有コンポーネント）、`packages/eslint-config`、`packages/typescript-config`、`apps/web` という構成で、`@workspace/ui: "workspace:*"` による内部依存を使用する。このテンプレートは `scripts/sync-templates.sh` で独立リポジトリ（`shadcn/monorepo-next`）に同期される。

### CLI 内部のモジュール分割

`packages/shadcn/src/` は責務ごとに明確なディレクトリ分割がされている。

- `commands/` -- CLI コマンド定義（commander.js ベース）
- `registry/` -- レジストリシステム（API, fetcher, resolver, builder, schema, errors）
- `preflights/` -- コマンド実行前の環境チェック（コマンドごとに 1 ファイル）
- `utils/transformers/` -- AST ベースのコード変換パイプライン
- `utils/updaters/` -- ファイル更新処理（CSS, 依存関係, フォント等）
- `migrations/` -- バージョン間マイグレーション
- `schema/` -- `registry/schema.ts` の再エクスポート（パブリック API 用エイリアス）
- `mcp/` -- MCP サーバー統合

## コード例

```typescript
// pnpm-workspace.yaml:1-8
packages:
  - "apps/*"
  - "packages/*"
  - "!**/test/**"
  - "!**/fixtures/**"
  - "!**/temp/**"
  - "!packages/tests/temp/**"
  - "!deprecated/**"
```

```typescript
// packages/shadcn/tsup.config.ts:6-14
entry: [
  "src/index.ts",
  "src/registry/index.ts",
  "src/schema/index.ts",
  "src/mcp/index.ts",
  "src/utils/index.ts",
  "src/icons/index.ts",
],
```

```typescript
// packages/shadcn/package.json:29-57
"exports": {
  ".": {
    "types": "./dist/index.d.ts",
    "default": "./dist/index.js"
  },
  "./registry": {
    "types": "./dist/registry/index.d.ts",
    "default": "./dist/registry/index.js"
  },
  "./schema": {
    "types": "./dist/schema/index.d.ts",
    "default": "./dist/schema/index.js"
  },
  // ... mcp, utils, icons
}
```

```typescript
// packages/shadcn/src/schema/index.ts:1
export * from "../registry/schema"
```

```typescript
// packages/tests/src/utils/helpers.ts:12
const SHADCN_CLI_PATH = path.join(__dirname, "../../../shadcn/dist/index.js")
```

```typescript
// turbo.json:4-8
"build": {
  "dependsOn": ["^build"],
  "env": ["NEXT_PUBLIC_APP_URL", ...],
  "outputs": ["dist/**", ".next/**"]
}
```

## パターンカタログ

- **Facade パターン** (分類: 構造)
  - 解決する問題: 内部のレジストリモジュール群（api, fetcher, resolver, builder, schema, errors）を外部から利用しやすい単一のインターフェースに集約する
  - 適用条件: 複数の内部モジュールを公開 API として提供する CLI ツール・ライブラリ
  - コード例: `packages/shadcn/src/registry/index.ts:1-23` -- api, search, errors から選択的に再エクスポート
  - 注意点: `schema/index.ts` が `registry/schema.ts` を再エクスポートしているのは、パッケージの `exports` マップで `shadcn/schema` として公開するための Facade 層

- **Pipeline パターン** (分類: 振る舞い)
  - 解決する問題: コンポーネントコードに対する複数の変換処理（import 変換、RSC 対応、CSS 変数、アイコン置換等）を順序付きで適用する
  - 適用条件: 入力データに対して複数の独立した変換を順次適用する必要がある場合
  - コード例: `packages/shadcn/src/utils/transformers/index.ts:42-52` -- `transform()` 関数がデフォルトのトランスフォーマー配列を受け取り、順次適用
  - 注意点: 各トランスフォーマーは `Transformer` 型に準拠し、`sourceFile` を受け取って変換する統一インターフェースを持つ

- **Preflight チェックパターン** (分類: 振る舞い)
  - 解決する問題: CLI コマンド実行前に環境の前提条件（フレームワーク検出、Tailwind 設定、import alias 設定等）を段階的に検証する
  - 適用条件: 複雑な前提条件を持つ CLI コマンドで、失敗原因を個別に特定し、具体的なエラーメッセージを提示したい場合
  - コード例: `packages/shadcn/src/preflights/preflight-init.ts:11-162` -- コマンドごとに専用の preflight 関数を用意
  - 注意点: エラーを `Record<string, boolean>` で集約し、すべてのチェック完了後にまとめてエラー表示する方式

## Good Patterns

- **workspace 除外パターンによるノイズ防止**: `pnpm-workspace.yaml` で `!**/test/**`、`!**/fixtures/**`、`!**/temp/**` を除外し、テスト用の一時ファイルがワークスペースパッケージとして認識されることを防いでいる。統合テストが fixture プロジェクトを作成・削除するモノレポでは必須の設定。

```yaml
# pnpm-workspace.yaml:4-8
  - "!**/test/**"
  - "!**/fixtures/**"
  - "!**/temp/**"
  - "!packages/tests/temp/**"
  - "!deprecated/**"
```

- **統合テストの物理分離と workspace 依存**: 統合テストを `packages/tests` として独立パッケージにし、`"shadcn": "workspace:*"` で CLI パッケージに依存させている。テストが CLI のビルド成果物（`dist/index.js`）を直接参照するため、ビルドパイプライン上の依存関係が明確になる。

```json
// packages/tests/package.json:14
"shadcn": "workspace:*"
```

```typescript
// packages/tests/src/utils/helpers.ts:12
const SHADCN_CLI_PATH = path.join(__dirname, "../../../shadcn/dist/index.js")
```

- **tsup エントリポイント分割によるサブパスエクスポート**: 1 パッケージから複数のサブモジュールを公開する場合、tsup の `entry` 配列と `package.json` の `exports` マップを対応させることで、ツリーシェイキングと明確な API 境界を両立している。

```typescript
// packages/shadcn/tsup.config.ts:7-13
entry: [
  "src/index.ts",
  "src/registry/index.ts",
  "src/schema/index.ts",
  "src/mcp/index.ts",
  "src/utils/index.ts",
  "src/icons/index.ts",
],
```

- **コマンドごとの preflight 分離**: `preflights/preflight-init.ts`、`preflight-add.ts` のように、各 CLI コマンドに対応した preflight ファイルを用意し、コマンド固有の前提条件チェックを分離している。共通のエラー定数（`utils/errors.ts`）を参照しつつ、チェックロジック自体はコマンドごとに独立させている。

## Anti-Patterns / 注意点

- **deprecated パッケージの残置**: `apps/www` は deprecated だが、`.contentlayer` と `.next` ディレクトリが残っている。`pnpm-workspace.yaml` の `!deprecated/**` による除外で問題は起きないが、リポジトリサイズの膨張につながる。

```
# Bad: deprecated ディレクトリにビルド成果物が残っている
apps/www/
  .contentlayer/
  .next/
  node_modules/
```

```
# Better: .gitignore で除外するか、ディレクトリごと削除する
# pnpm-workspace.yaml の除外だけでは不十分
```

- **テストと本体の物理パス依存**: `packages/tests` が `../../../shadcn/dist/index.js` という相対パスで CLI のビルド成果物を参照している。ディレクトリ構成の変更に脆弱。

```typescript
// Bad: 相対パスのハードコード
const SHADCN_CLI_PATH = path.join(__dirname, "../../../shadcn/dist/index.js")
```

```typescript
// Better: package.json の bin フィールドを利用するか、
// workspace protocol で解決された実行パスを使う
import { resolve } from "import-meta-resolve"
const SHADCN_CLI_PATH = await resolve("shadcn", import.meta.url)
```

- **schema の間接再エクスポート**: `src/schema/index.ts` が `export * from "../registry/schema"` だけの 1 行ファイル。これは `package.json` の `exports` で `shadcn/schema` サブパスを提供するための間接層だが、実質的には `registry/schema.ts` との二重管理になる可能性がある。tsup のエントリポイント設定で直接参照する方が明快。

## 導出ルール

- `[MUST]` pnpm-workspace.yaml でテスト用 fixture/temp ディレクトリを除外する -- shadcn-ui/ui は `!**/test/**`, `!**/fixtures/**`, `!**/temp/**` で統合テストの一時ファイルがワークスペースパッケージとして認識されることを防いでいる
  - 根拠: `pnpm-workspace.yaml:4-8` の除外パターン

- `[MUST]` モノレポで npm publish するパッケージを 1 つに限定し、他は `"private": true` にする -- publish 対象が明確になり、意図しない公開を防げる
  - 根拠: `packages/shadcn/package.json` のみ `"private"` フィールドがなく（= publish 可能）、`packages/tests` と `apps/v4` は `"private": true`

- `[SHOULD]` 統合テストはモノレポ内の独立パッケージとして分離し、`workspace:*` で対象パッケージに依存させる -- テスト固有の設定（長いタイムアウト、globalSetup、fixture 管理）が本体パッケージの vitest 設定を汚染しない
  - 根拠: `packages/tests/vitest.config.ts` の `testTimeout: 120000` と `globalSetup`、ルートの `vitest.config.ts` が `packages/tests` を除外

- `[SHOULD]` 1 パッケージで複数の公開 API を提供する場合、tsup のエントリポイント分割と `package.json` の `exports` マップを対応させる -- コンシューマが必要なサブモジュールだけを import でき、ツリーシェイキングが効く
  - 根拠: `packages/shadcn/tsup.config.ts:7-13` の 6 エントリポイントと `package.json:29-57` の exports マップ

- `[SHOULD]` CLI コマンドごとに preflight チェック関数を分離し、エラー定数を共有する -- コマンドごとの前提条件が異なる場合、チェックロジックの見通しが良くなり、エラーメッセージを具体的にできる
  - 根拠: `preflights/preflight-init.ts` と `preflight-add.ts` が `utils/errors.ts` のエラー定数を共有

- `[SHOULD]` Turborepo の `build` タスクに `dependsOn: ["^build"]` を設定し、ワークスペース間のビルド順序を保証する -- apps/v4 の build が packages/shadcn の build 完了を待つことで、型定義やビルド成果物の整合性が保たれる
  - 根拠: `turbo.json:5` の `"dependsOn": ["^build"]`

- `[AVOID]` モノレポ内で deprecated なパッケージのビルド成果物を残置する -- `.next` や `node_modules` がリポジトリサイズを膨張させ、`pnpm install` のパフォーマンスにも影響する
  - 根拠: `apps/www/` に `.contentlayer`、`.next`、`node_modules` が残存

## 適用チェックリスト

- [ ] `pnpm-workspace.yaml` でテスト用の一時ディレクトリ（fixtures, temp, test output）を除外パターンに含めているか
- [ ] npm publish 対象パッケージは最小限に絞り、それ以外のパッケージに `"private": true` を設定しているか
- [ ] 統合テスト（長時間実行、fixture 管理、外部サーバー依存）はユニットテストと物理的に分離しているか
- [ ] `turbo.json` の `build` タスクに `dependsOn: ["^build"]` を設定し、ワークスペース間のビルド順序を保証しているか
- [ ] 複数のエントリポイントを公開するパッケージで `exports` フィールドと bundler のエントリ設定が対応しているか
- [ ] deprecated なパッケージやディレクトリのビルド成果物を `.gitignore` で除外しているか
- [ ] CLI コマンドの前提条件チェックがコマンドごとに分離され、具体的なエラーメッセージを提示しているか
