# project-structure

> リポジトリ: Effect-TS/effect
> 分析日: 2026-02-18

## 概要

Effect-TS/effect は 30+ パッケージを擁する大規模 TypeScript モノレポで、pnpm workspace を基盤に厳密な階層的依存関係を構築している。コアパッケージ `effect` を頂点に、抽象インターフェース層（platform, sql, ai）と具象実装層（platform-node, sql-pg, ai-openai）が明確に分離されており、パッケージ間の依存は常にコア方向（具象 → 抽象 → コア）に流れる。この構造は、循環依存の自動検出、`internal/*` エクスポート無効化、ESLint によるバレル import 禁止など複数のガードレールで保護されている。

## 背景にある原則

- **依存の方向性は常にコアへ向かうべき（Dependency Inversion at Package Level）**: 具象実装パッケージ（sql-pg, platform-node）は抽象パッケージ（sql, platform）に依存し、その逆は発生しない。これにより、新しいアダプタ（sql-sqlite-bun, ai-google 等）を追加してもコアの変更が不要になる。`peerDependencies` でこの方向性が宣言的に表現されている（例: `packages/sql-pg/package.json` の `peerDependencies` は `@effect/sql` と `effect` を参照）。

- **公開 API と内部実装は物理的に分離すべき**: 全パッケージが `"./internal/*": null` を `exports` フィールドで宣言し、`src/internal/` ディレクトリの直接参照を Node.js の module resolution レベルでブロックしている。公開モジュール（`src/Effect.ts`）は型定義とドキュメントを持ち、実装は `internal/` にデリゲートする。これにより semver 上のブレイキングチェンジ管理が容易になる。

- **モノレポ内でもパッケージ間は疎結合であるべき**: `workspace:^` によるバージョン管理で、各パッケージは独立してバージョニング・リリースされる。`@changesets/cli` により、変更が影響するパッケージだけを正確にバージョンアップできる。

- **構造的制約はツーリングで強制すべき**: ESLint ルール `@effect/no-import-from-barrel-package`、`madge` による循環依存検出、TypeScript の Project References による型チェック境界など、アーキテクチャ上の制約がコードレビューではなく自動化されたツールで強制されている。

## 実例と分析

### パッケージ階層と依存グラフ

依存グラフは 4 層に分かれる:

**Layer 0 (コア)**: `effect` -- 外部パッケージへの依存なし（`fast-check` と `@standard-schema/spec` のみ）
**Layer 1 (抽象)**: `@effect/platform`, `@effect/typeclass`, `@effect/experimental`, `@effect/rpc` -- `effect` のみに依存
**Layer 2 (高レベル抽象)**: `@effect/sql`, `@effect/ai`, `@effect/cluster`, `@effect/cli`, `@effect/workflow` -- Layer 0-1 に依存
**Layer 3 (具象実装)**: `@effect/sql-pg`, `@effect/platform-node`, `@effect/ai-openai` 等 -- Layer 0-2 に依存 + 外部ドライバ

```
effect (Layer 0)
  |
  +-- @effect/typeclass
  +-- @effect/platform
  |     +-- @effect/platform-node-shared
  |     |     +-- @effect/platform-node
  |     |     +-- @effect/platform-bun
  |     +-- @effect/platform-browser
  +-- @effect/experimental
  +-- @effect/rpc
  +-- @effect/sql
  |     +-- @effect/sql-pg, sql-mysql2, sql-sqlite-node, ...
  |     +-- @effect/sql-drizzle, sql-kysely (ブリッジ層)
  +-- @effect/ai
  |     +-- @effect/ai-openai, ai-anthropic, ai-google, ...
  +-- @effect/cluster
  +-- @effect/workflow
```

### 抽象/具象分離パターン（Platform ファミリー）

Platform パッケージ群は「抽象インターフェース + 実装レイヤー」の 3 層構造を採用している。

1. `@effect/platform` -- `FileSystem`, `HttpClient` 等のインターフェース定義
2. `@effect/platform-node-shared` -- Node.js / Bun 共通の内部実装
3. `@effect/platform-node`, `@effect/platform-bun` -- ランタイム固有の Layer 提供

```typescript
// packages/platform/src/FileSystem.ts:1-16
// 抽象インターフェース: 型定義のみ、実装は internal/ にデリゲート
import * as internal from "./internal/fileSystem.js";
export interface FileSystem {
  readonly access: (path: string, options?: AccessFileOptions) => Effect.Effect<void, PlatformError>;
  // ...
}
```

```typescript
// packages/platform-node/src/NodeFileSystem.ts:1-12
// 具象パッケージ: shared 実装から Layer を re-export するだけ
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import type { FileSystem } from "@effect/platform/FileSystem";
import type { Layer } from "effect/Layer";
export const layer: Layer<FileSystem> = NodeFileSystem.layer;
```

```typescript
// packages/platform-node/src/NodeContext.ts:21-40
// 複数サービスの Layer を合成して一括提供
export type NodeContext =
  | CommandExecutor.CommandExecutor
  | FileSystem.FileSystem
  | Path.Path
  | Terminal.Terminal
  | Worker.WorkerManager;

export const layer: Layer.Layer<NodeContext> = pipe(
  Layer.mergeAll(NodePath.layer, NodeCommandExecutor.layer, NodeTerminal.layer, NodeWorker.layerManager),
  Layer.provideMerge(NodeFileSystem.layer),
);
```

### 公開 API / Internal 分離の強制メカニズム

全パッケージの `package.json` に統一された exports フィールドが定義されている:

```json
// packages/effect/package.json:34-39
{
  "exports": {
    "./package.json": "./package.json",
    ".": "./src/index.ts",
    "./*": "./src/*.ts",
    "./internal/*": null
  }
}
```

`"./internal/*": null` により、`import ... from "effect/internal/core"` のようなパスは Node.js のモジュール解決で拒否される。公開ファイル（例: `src/Option.ts`）は型定義・JSDoc・関数シグネチャを担い、実装は `src/internal/option.ts` にデリゲートする。

ビルド時にも `tsconfig.build.json` の `"stripInternal": true` で `@internal` タグ付きの型が `.d.ts` から除去される。

### ESLint によるバレル import 禁止

```javascript
// eslint.config.mjs:151-159
{
  files: ["packages/*/src/**/*"],
  rules: {
    "@effect/no-import-from-barrel-package": [
      "error",
      { packageNames: ["effect", "@effect/platform", "@effect/sql"] }
    ]
  }
}
```

パッケージ内のソースコードでは `import * as Effect from "effect"` ではなく `import * as Effect from "effect/Effect"` のようにサブモジュール単位での import が強制される。これによりツリーシェイキングの効率が保証され、バンドルサイズが最適化される。

### 循環依存の自動検出

```javascript
// scripts/circular.mjs:1-26
madge(
  glob.globSync(["packages/*/src/**/*.ts", "packages/ai/*/src/**/*.ts"], {
    ignore: ["packages/sql-sqlite-bun/**", "packages/experimental/src/EventLogServer/Cloudflare.ts"],
  }),
  { detectiveOptions: { ts: { skipTypeImports: true } } },
).then((res) => {
  const circular = res.circular();
  if (circular.length) {
    console.error("Circular dependencies found");
    process.exit(1);
  }
});
```

`madge` を使ってモノレポ全体の循環依存をチェックし、型 import は `skipTypeImports: true` で除外する。これにより型レベルの相互参照は許容しつつ、実行時の循環依存を防止している。

### ビルドスクリプトの均一化

全パッケージが同一のビルドパイプラインを共有する:

```
build-esm (tsc) → build-annotate (babel: annotate-pure-calls) → build-cjs (babel: transform-modules-commonjs) → pack (build-utils)
```

```json
// packages/effect/package.json:43-45
{
  "build": "pnpm build-esm && pnpm build-annotate && pnpm build-cjs && build-utils pack-v3",
  "build-esm": "tsc -b tsconfig.build.json",
  "build-cjs": "babel build/esm --plugins @babel/transform-export-namespace-from --plugins @babel/transform-modules-commonjs --out-dir build/cjs --source-maps"
}
```

`babel-plugin-annotate-pure-calls` により、副作用のない関数呼び出しに `/*#__PURE__*/` アノテーションが付与され、バンドラーのデッドコード除去が最適化される。

### pnpm-workspace.yaml のサブグルーピング

```yaml
# pnpm-workspace.yaml
packages:
  - scratchpad
  - packages/*
  - packages/ai/*
```

AI 関連パッケージは `packages/ai/` 配下にネストされ、ドメイン単位でサブグループ化されている。AI パッケージ群が増加しても `packages/` 直下が肥大化しない。

### TypeScript Project References による型チェック境界

```json
// packages/platform/tsconfig.src.json
{
  "references": [
    { "path": "../effect/tsconfig.src.json" }
  ]
}
```

TypeScript の Project References で依存関係を宣言し、`tsc -b` によるインクリメンタルビルドを実現している。依存グラフと tsconfig の references が一致することで、型チェックがパッケージ境界を尊重する。

## パターンカタログ

- **Abstract Factory / Strategy (振る舞い)**
  - 解決する問題: 同一インターフェースに対する複数の実装（Node.js / Bun / ブラウザ）を切り替え可能にする
  - 適用条件: ランタイムや外部ドライバに依存するサービスが複数のバリエーションを持つ場合
  - コード例: `packages/platform/src/FileSystem.ts` (インターフェース) → `packages/platform-node/src/NodeFileSystem.ts` (Layer)
  - 注意点: 抽象パッケージの依存に具象パッケージを含めてはならない（依存の逆転を避ける）

- **Facade (構造)**
  - 解決する問題: 複数の細粒度サービスを一括で提供する便利なエントリポイントが必要
  - 適用条件: ユーザーが個別に Layer を組み立てる手間を省きたい場合
  - コード例: `packages/platform-node/src/NodeContext.ts:32-40` -- `NodeContext.layer` が FileSystem, Path, Terminal 等を統合

## Good Patterns

- **`internal/*: null` による API 境界の物理的封鎖**: `package.json` の `exports` フィールドで内部モジュールへのアクセスを Node.js レベルでブロックする。手動のコードレビューに頼らず、モジュール解決の仕組みそのもので制約を強制できる。

```json
// packages/effect/package.json:34-39
{
  "exports": {
    "./*": "./src/*.ts",
    "./internal/*": null
  }
}
```

- **Adapter ファミリーの命名規約統一**: SQL アダプタ群は `sql-{driver}` の命名規約（sql-pg, sql-mysql2, sql-sqlite-node, sql-sqlite-bun, sql-d1 等）で統一され、パッケージの役割が名前から推測できる。AI プロバイダも `ai-{provider}` で統一。

- **共有実装の中間パッケージ化**: `platform-node-shared` は Node.js と Bun で共通のファイルシステム・ソケット実装を提供する中間パッケージ。`platform-node` と `platform-bun` の両方がこれに依存し、コード重複を排除している。

```typescript
// packages/platform-bun/package.json:58 (dependencies)
{
  "@effect/platform-node-shared": "workspace:^"
}
```

## Anti-Patterns / 注意点

- **抽象パッケージから具象パッケージへの依存**: 抽象層（platform）が具象層（platform-node）を import すると、Layer 0-1 に Layer 3 の依存が混入し、ブラウザ環境でも Node.js のポリフィルが要求される事態になる。Effect では `peerDependencies` の方向性と ESLint ルールでこれを防止している。

```typescript
// Bad: 抽象パッケージが具象実装に依存
// @effect/platform/src/FileSystem.ts
import { NodeFileSystem } from "@effect/platform-node"; // 依存の逆転

// Better: 具象パッケージが抽象を実装
// @effect/platform-node/src/NodeFileSystem.ts
import type { FileSystem } from "@effect/platform/FileSystem";
export const layer: Layer<FileSystem> = internal.layer;
```

- **バレルファイルからの一括 import**: 大規模パッケージでバレルファイル（index.ts）から import すると、未使用モジュールもバンドルに含まれるリスクがある。Effect では ESLint ルール `@effect/no-import-from-barrel-package` でサブモジュール単位の import を強制している。

```typescript
// Bad: バレル import（ツリーシェイキング非効率）
import { Array, Effect, Option } from "effect";

// Better: サブモジュール import
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
```

## 導出ルール

- `[MUST]` モノレポのパッケージ間依存は DAG（有向非巡回グラフ）を維持し、循環依存検出を CI で自動実行する
  - 根拠: `scripts/circular.mjs` で `madge` を使い、全パッケージのソースファイルを横断して循環依存を検出し、発見時に `process.exit(1)` で CI を失敗させている

- `[MUST]` 公開 API と内部実装を物理的に分離し、`package.json` の `exports` フィールドで内部モジュールへの外部アクセスをブロックする
  - 根拠: 全 30+ パッケージが `"./internal/*": null` を exports に宣言し、Node.js のモジュール解決レベルで内部実装のインポートを拒否している

- `[SHOULD]` 抽象インターフェースパッケージと具象実装パッケージを分離し、依存の方向を「具象 → 抽象 → コア」に統一する
  - 根拠: platform ファミリー（platform → platform-node/bun/browser）、SQL ファミリー（sql → sql-pg/mysql2/sqlite-*）、AI ファミリー（ai → ai-openai/anthropic/google）の全てがこのパターンに従っている

- `[SHOULD]` モノレポ内のビルドスクリプト・tsconfig・exports 構造を全パッケージで統一テンプレート化する
  - 根拠: 全パッケージが同一の build パイプライン（tsc → babel annotate → babel cjs → pack）と同一の exports 構造を共有しており、新パッケージ追加時のボイラープレートが最小化されている

- `[SHOULD]` 大規模パッケージではバレルファイル（index.ts）からの import を禁止し、サブモジュール単位の import を ESLint ルールで強制する
  - 根拠: `eslint.config.mjs` の `@effect/no-import-from-barrel-package` ルールが `effect`, `@effect/platform`, `@effect/sql` に対してサブモジュール import を強制している

- `[SHOULD]` 関連するアダプタパッケージ群が増える場合、pnpm-workspace のサブディレクトリでグルーピングし、ルートの `packages/` が肥大化しないようにする
  - 根拠: AI 関連 6 パッケージが `packages/ai/*` としてネストされ、`pnpm-workspace.yaml` に `packages/ai/*` が追加されている

- `[AVOID]` モノレポ内のパッケージ間で型 import 以外の循環参照を作ること（型 import は `skipTypeImports: true` で許容し、実行時の循環は禁止する）
  - 根拠: `scripts/circular.mjs` で `detectiveOptions.ts.skipTypeImports: true` を設定し、型レベルの相互参照は許容しつつ実行時の循環を厳格に禁止している

## 適用チェックリスト

- [ ] モノレポの依存グラフが DAG になっているか確認し、循環依存検出ツール（madge 等）を CI に組み込んでいるか
- [ ] 全パッケージの `package.json` に `"./internal/*": null` を設定し、内部モジュールへの外部アクセスをブロックしているか
- [ ] 抽象インターフェースパッケージと具象実装パッケージが分離され、依存の方向が「具象 → 抽象 → コア」になっているか
- [ ] ビルドスクリプト・tsconfig・exports の構造が全パッケージで統一されているか
- [ ] バレルファイルからの import を禁止する ESLint ルールを導入しているか（大規模パッケージの場合）
- [ ] TypeScript の Project References がパッケージ間の依存グラフと一致しているか
- [ ] 関連パッケージ群が増加した際にサブディレクトリでグルーピングする運用ルールがあるか
- [ ] 複数ランタイムで共通のコードがある場合、shared パッケージとして切り出しているか
