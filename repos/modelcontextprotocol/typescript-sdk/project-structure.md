# project-structure

> リポジトリ: modelcontextprotocol/typescript-sdk
> 分析日: 2026-02-24

## 概要

pnpm ワークスペースによるモノレポの packages 分割戦略と依存グラフを分析した。このリポジトリは「core をビルド時にバンドルして消費者に見せない」という内部パッケージ戦略、pnpm catalogs によるバージョン一元管理、`common/` による開発ツール設定の共有、そして middleware パッケージを peerDependencies で疎結合にするアダプタ層設計を採用している。プロトコル SDK という性質上、複数のランタイム環境（Node.js / Cloudflare Workers / ブラウザ）への対応が必要であり、exports conditions と shims パターンによるランタイム分岐が注目に値する。

## 背景にある原則

- **内部パッケージのバンドル吸収による API 表面の最小化**: core パッケージは `private: true` で npm に公開せず、client/server のビルド時に `noExternal` で物理的にバンドルし、`export * from '@modelcontextprotocol/core'` で再エクスポートする。消費者は `@modelcontextprotocol/client` または `@modelcontextprotocol/server` のみインストールすれば core の機能もすべて使える。公開パッケージ数を減らすことで依存解決の複雑性とバージョン不整合リスクを排除している。

- **依存バージョンの単一情報源（Single Source of Truth）**: `pnpm-workspace.yaml` の `catalogs` で `devTools` と `runtimeShared` / `runtimeClientOnly` / `runtimeServerOnly` のカテゴリ別にバージョンを一元定義し、各パッケージの package.json では `"catalog:devTools"` のように参照する。バージョン更新は1箇所で済み、パッケージ間のバージョン不整合を構造的に防止している。

- **開発ツール設定の DRY 化**: `common/` ディレクトリに tsconfig / vitest-config / eslint-config を独立パッケージとして配置し、各パッケージは `"extends": "@modelcontextprotocol/tsconfig"` や `import baseConfig from '@modelcontextprotocol/vitest-config'` のように1行で継承する。設定の重複を排除しつつ、パッケージ固有のオーバーライドも可能にしている。

- **アダプタ層は peerDependencies で疎結合にする**: middleware パッケージ（express / hono / node）はフレームワークと server パッケージを peerDependencies として宣言し、自身の dependencies を空（または最小限）にする。これにより消費者が使わないフレームワークのインストールを強制しない。

## 実例と分析

### パッケージ階層と依存グラフ

ワークスペースは4つの論理層に分かれている:

```
[common/]  設定パッケージ（private, 開発専用）
  tsconfig, vitest-config, eslint-config

[packages/]  本体パッケージ
  core    (private, バンドルされる)
  client  (public, core をバンドル)
  server  (public, core をバンドル)
  middleware/express  (public, server を peerDep)
  middleware/hono     (public, server を peerDep)
  middleware/node     (public, server を peerDep)

[test/]  テスト専用パッケージ（private）
  helpers       (共有テストユーティリティ)
  conformance   (プロトコル準拠テスト)
  integration   (結合テスト)

[examples/]  サンプルコード（private）
  client, server, shared, client-quickstart, server-quickstart
```

依存グラフは厳密な DAG（有向非循環グラフ）を形成している:

```
common/{tsconfig,vitest-config,eslint-config}
    ^
    |  (devDependencies)
core ──────────────────────────────────────
    ^                                      ^
    | (noExternal bundle)                  | (noExternal bundle)
client                                  server
    ^                                      ^
    |                                      | (peerDependencies)
    |                               middleware/{express,hono,node}
    |                                      ^
    v                                      v
test/{helpers,conformance,integration}, examples/*
```

### core の「消える依存」パターン

`packages/core` は `private: true` で npm に公開されない。client と server の `tsdown.config.ts` で `noExternal: ['@modelcontextprotocol/core']` を指定し、ビルド成果物に core のコードを物理的に含める:

```typescript
// packages/client/tsdown.config.ts:33
noExternal: ['@modelcontextprotocol/core'],
```

```typescript
// packages/server/tsdown.config.ts:33
noExternal: ['@modelcontextprotocol/core'],
```

同時に、DTS 生成時も core の型定義を client/server の dist に含めるため、`dts.compilerOptions.paths` でソースパスを直接指定している:

```typescript
// packages/client/tsdown.config.ts:26-29
dts: {
    resolver: 'tsc',
    compilerOptions: {
        baseUrl: '.',
        paths: {
            '@modelcontextprotocol/core': ['../core/src/index.ts']
        }
    }
},
```

index.ts では core の全エクスポートを再エクスポートし、消費者が core を意識する必要をなくしている:

```typescript
// packages/client/src/index.ts:14
export * from "@modelcontextprotocol/core";
```

```typescript
// packages/server/src/index.ts:12
export * from "@modelcontextprotocol/core";
```

### pnpm catalogs によるバージョン一元管理

`pnpm-workspace.yaml` に4つのカタログカテゴリを定義:

```yaml
# pnpm-workspace.yaml:7-51
catalogs:
    devTools:
        vitest: ^4.0.15
        typescript: ^5.9.3
        tsdown: ^0.18.0
        # ... (開発ツール全般)
    runtimeClientOnly:
        cross-spawn: ^7.0.5
        eventsource: ^3.0.2
        jose: ^6.1.3
    runtimeServerOnly:
        express: ^5.2.1
        hono: ^4.11.4
        # ...
    runtimeShared:
        zod: ^4.0
        ajv: ^8.17.1
        # ...
```

各パッケージの package.json ではカタログ参照を使う:

```json
// packages/server/package.json:67
"dependencies": {
    "zod": "catalog:runtimeShared"
}
```

カテゴリ分けの基準は明確である: devTools はビルド・テスト・リント用、runtimeClientOnly / runtimeServerOnly はそれぞれ片方のみで使う実行時依存、runtimeShared は client と server の両方で使う実行時依存。

### common/ による設定パッケージの共有

3つの設定パッケージはいずれも `private: true` で、ワークスペース内でのみ使用される:

```json
// common/tsconfig/package.json
{
  "name": "@modelcontextprotocol/tsconfig",
  "private": true,
  "main": "tsconfig.json"
}
```

各パッケージの tsconfig.json は1行で継承し、パッケージ固有の paths のみオーバーライドする:

```json
// packages/core/tsconfig.json
{
  "extends": "@modelcontextprotocol/tsconfig",
  "include": ["./"],
  "exclude": ["node_modules", "dist"]
}
```

vitest と eslint も同じパターン:

```javascript
// packages/core/vitest.config.js
import baseConfig from "@modelcontextprotocol/vitest-config";
export default baseConfig;
```

```javascript
// packages/core/eslint.config.mjs
import baseConfig from "@modelcontextprotocol/eslint-config";
export default baseConfig;
```

### exports conditions によるランタイム分岐

client と server は `exports` フィールドの `_shims` サブパスで、ランタイム環境に応じた実装を切り替える:

```json
// packages/client/package.json:29-46
"./_shims": {
    "workerd": {
        "types": "./dist/shimsWorkerd.d.mts",
        "import": "./dist/shimsWorkerd.mjs"
    },
    "browser": {
        "types": "./dist/shimsWorkerd.d.mts",
        "import": "./dist/shimsWorkerd.mjs"
    },
    "node": {
        "types": "./dist/shimsNode.d.mts",
        "import": "./dist/shimsNode.mjs"
    },
    "default": {
        "types": "./dist/shimsNode.d.mts",
        "import": "./dist/shimsNode.mjs"
    }
}
```

shims ファイルの実体は JSON Schema バリデータの切り替え:

```typescript
// packages/client/src/shimsNode.ts
export { AjvJsonSchemaValidator as DefaultJsonSchemaValidator } from "@modelcontextprotocol/core";

// packages/client/src/shimsWorkerd.ts
export { CfWorkerJsonSchemaValidator as DefaultJsonSchemaValidator } from "@modelcontextprotocol/core";
```

### middleware パッケージのアダプタ設計

middleware パッケージは dependencies を最小限にし、core SDK を peerDependencies で宣言する:

```json
// packages/middleware/express/package.json:46-50
"dependencies": {},
"peerDependencies": {
    "@modelcontextprotocol/server": "workspace:^",
    "express": "catalog:runtimeServerOnly"
}
```

middleware/node は唯一 `@hono/node-server` を dependencies に持つが、これは Node.js HTTP と Web Standard API の変換に必要な技術的要件であり、フレームワーク自体ではない:

```json
// packages/middleware/node/package.json:48-54
"dependencies": {
    "@hono/node-server": "catalog:runtimeServerOnly"
},
"peerDependencies": {
    "@modelcontextprotocol/server": "workspace:^",
    "hono": "catalog:runtimeServerOnly"
}
```

### テスト階層の分離

テストは3階層に分離されている:

1. **ユニットテスト**: 各パッケージ内に `test/` として配置（`packages/core/test/`, `packages/client/test/` 等）
2. **テストヘルパー**: `test/helpers/` パッケージとして共有ユーティリティを提供（HTTP, OAuth, Tasks）
3. **結合テスト / 準拠テスト**: `test/integration/` と `test/conformance/` が全パッケージを横断してテスト

```json
// test/integration/package.json（抜粋）
"devDependencies": {
    "@modelcontextprotocol/core": "workspace:^",
    "@modelcontextprotocol/client": "workspace:^",
    "@modelcontextprotocol/server": "workspace:^",
    "@modelcontextprotocol/express": "workspace:^",
    "@modelcontextprotocol/node": "workspace:^",
    "@modelcontextprotocol/test-helpers": "workspace:^"
}
```

### リリース管理: changesets と private の境界

changesets の設定で examples パッケージは明示的に ignore されている:

```json
// .changeset/config.json:10-16
"ignore": [
    "@modelcontextprotocol/examples-client",
    "@modelcontextprotocol/examples-client-quickstart",
    "@modelcontextprotocol/examples-server",
    "@modelcontextprotocol/examples-server-quickstart",
    "@modelcontextprotocol/examples-shared"
]
```

`private: true` のパッケージ群（core, common/_, test/_, examples/_）と `private: false` で公開されるパッケージ群（client, server, middleware/_）の境界が明確に管理されている。

## パターンカタログ

- **Facade パターン** (分類: 構造)
  - 解決する問題: 内部の複雑なパッケージ構造（core + client/server）を消費者に見せたくない
  - 適用条件: 内部パッケージが外部 API として独立して意味をなさない場合
  - コード例: `packages/client/src/index.ts:14` (`export * from '@modelcontextprotocol/core'`)、`packages/client/tsdown.config.ts:33` (`noExternal: ['@modelcontextprotocol/core']`)
  - 注意点: core の型が client/server の dist に含まれるため、DTS 生成時に paths 設定が必要

- **Adapter パターン** (分類: 構造)
  - 解決する問題: 異なるフレームワーク（Express / Hono）や異なるランタイム（Node.js / Cloudflare Workers）の API を統一的に扱いたい
  - 適用条件: SDK のコアロジックを複数のランタイム・フレームワークで動作させる必要がある場合
  - コード例: `packages/middleware/node/src/streamableHttp.ts:67` (`NodeStreamableHTTPServerTransport` が `WebStandardStreamableHTTPServerTransport` をラップ)
  - 注意点: アダプタは「薄く」保ち、ビジネスロジックを含めない

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: ランタイム環境に応じて JSON Schema バリデータの実装を切り替えたい
  - 適用条件: 同一インターフェースに対して環境依存の実装が複数存在する場合
  - コード例: `packages/client/package.json:29-46` (exports conditions)、`packages/client/src/shimsNode.ts:6`、`packages/client/src/shimsWorkerd.ts:6`
  - 注意点: exports conditions はバンドラ / ランタイムによってサポート状況が異なるため、`default` フォールバックを必ず設定する

## Good Patterns

- **カタログによる依存バージョン一元管理**: `pnpm-workspace.yaml` の `catalogs` セクションでカテゴリ別（devTools / runtimeShared / runtimeClientOnly / runtimeServerOnly）にバージョンを定義し、各 package.json では `"catalog:devTools"` で参照する。バージョン更新が1箇所で完結し、パッケージ間の不整合を構造的に防ぐ。

```yaml
# pnpm-workspace.yaml:7-10
catalogs:
    devTools:
        vitest: ^4.0.15
        typescript: ^5.9.3
```

```json
// packages/core/package.json（devDependencies 抜粋）
"vitest": "catalog:devTools"
```

- **private パッケージのバンドル吸収**: 内部実装パッケージ（core）を `private: true` にして npm に公開せず、消費者向けパッケージ（client / server）のビルドで `noExternal` バンドルする。消費者のインストール対象を最小化しながら、開発時はパッケージ分割の恩恵を得る。

```typescript
// packages/client/tsdown.config.ts:31-33
// Vendoring Strategy - Bundle the code for this specific package into the output,
//    but treat all other dependencies as external (require/import).
noExternal: ['@modelcontextprotocol/core'],
```

- **設定パッケージの1行継承**: `common/` ディレクトリに設定パッケージを配置し、各パッケージは `extends` や `import` の1行で継承する。パッケージ固有のオーバーライドが必要な場合のみ追加設定を書く。

```javascript
// packages/core/vitest.config.js（全文）
import baseConfig from "@modelcontextprotocol/vitest-config";
export default baseConfig;
```

- **テストヘルパーの独立パッケージ化**: 複数テストパッケージで共有するユーティリティ（HTTP サーバー起動、OAuth モック、タスクヘルパー）を `test/helpers/` として独立パッケージにし、`workspace:^` で参照する。テストコードの重複を防ぎつつ、本体パッケージの依存を汚染しない。

## Anti-Patterns / 注意点

- **内部パッケージの公開漏れ**: core のような内部パッケージを `private: true` にし忘れると、npm に公開されてしまい、消費者が直接依存する可能性がある。一度公開されると互換性維持の義務が発生し、内部リファクタリングの自由度が著しく低下する。

```json
// Bad: private フラグなし
{
    "name": "@myorg/core",
    "version": "1.0.0"
}

// Better: 明示的に private: true
{
    "name": "@myorg/core",
    "private": true,
    "version": "1.0.0"
}
```

- **カタログなしのバージョン散在**: モノレポで同一パッケージを複数箇所で異なるバージョンで指定すると、ランタイムで複数バージョンが共存し予期しない挙動を招く。

```json
// Bad: パッケージごとにバージョン直書き
// packages/a/package.json
"zod": "^3.22.0"
// packages/b/package.json
"zod": "^3.23.0"

// Better: catalog 参照で一元管理
"zod": "catalog:runtimeShared"
```

- **アダプタ層へのビジネスロジック混入**: middleware パッケージにフレームワーク固有のロジック以外（MCP 機能、認証ロジック等）を入れると、フレームワーク間で機能差が生じる。このリポジトリでは middleware/README.md に「MCP functionality lives in `@modelcontextprotocol/server`」と明記して境界を守っている。

## 導出ルール

- `[MUST]` モノレポの内部専用パッケージには `private: true` を設定し、npm への意図しない公開を防ぐ
  - 根拠: core パッケージを `private: true` にし、client/server にバンドルすることで、消費者に見える API 表面を最小化している (`packages/core/package.json:3`)

- `[MUST]` モノレポ内の共有依存バージョンは pnpm catalogs や Nx/Turborepo の同等機能で1箇所に集約する
  - 根拠: `pnpm-workspace.yaml` の `catalogs` で全パッケージの依存バージョンを一元管理し、各 package.json では `catalog:devTools` のように参照することで不整合を構造的に防止している

- `[SHOULD]` モノレポの開発ツール設定（tsconfig / eslint / test runner）は共有パッケージとして切り出し、各パッケージは1行で継承する
  - 根拠: `common/` ディレクトリの tsconfig / vitest-config / eslint-config パッケージを全パッケージが `extends` / `import` の1行で利用している

- `[SHOULD]` フレームワーク・ランタイム向けアダプタ層は peerDependencies で SDK 本体を参照し、自身の dependencies を最小限にする
  - 根拠: middleware パッケージは `"dependencies": {}` とし、server と フレームワークを peerDependencies に宣言して消費者に選択の自由を与えている (`packages/middleware/express/package.json:46-50`)

- `[SHOULD]` ランタイム環境による実装切り替えは package.json の exports conditions と shims パターンで行う
  - 根拠: client/server パッケージが `_shims` サブパスで workerd / browser / node 条件に応じた JSON Schema バリデータを切り替えている (`packages/client/package.json:29-46`)

- `[SHOULD]` テストを単体・結合・準拠の3階層に分離し、共有ヘルパーは独立パッケージとして提供する
  - 根拠: `test/helpers/` を独立パッケージにして HTTP / OAuth / Tasks ヘルパーを共有し、`test/integration/` と `test/conformance/` がパッケージ横断のテストを担当している

- `[AVOID]` アダプタ層にフレームワーク変換以外のビジネスロジックを実装する
  - 根拠: `packages/middleware/README.md` に「They intentionally do not add new MCP features or business logic」と明記し、アダプタの責務を限定している

## 適用チェックリスト

- [ ] モノレポ内の内部専用パッケージに `private: true` が設定されているか確認する
- [ ] 共有依存のバージョンが1箇所（catalogs / 共有設定ファイル）で管理されているか確認する
- [ ] tsconfig / eslint / test runner 設定が共有パッケージから継承されているか確認する
- [ ] パッケージ間の依存グラフが DAG になっており、循環依存がないか確認する
- [ ] 公開パッケージの `exports` フィールドが正しく設定され、必要に応じて条件付きエクスポートが使われているか確認する
- [ ] フレームワーク・ランタイム向けのアダプタ層が peerDependencies を使い、自身の dependencies を最小限にしているか確認する
- [ ] テスト用の共有ヘルパーが本体パッケージの dependencies を汚染しない構造になっているか確認する
- [ ] changesets の ignore リストに非公開パッケージ（examples, test 等）が含まれているか確認する
