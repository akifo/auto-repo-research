# project-structure

> リポジトリ: vitejs/vite
> 分析日: 2026-02-17

## 概要

Vite monorepo の構成戦略を分析する。3つの公開パッケージ（`vite`, `create-vite`, `plugin-legacy`）、40以上の playground テストアプリ、ドキュメントサイトを pnpm workspaces で統合管理している。注目すべきは、コアパッケージ内の「実行環境別ソースコード分離」、playground ディレクトリを workspace メンバーとして E2E テストに活用する設計、依存関係の境界を `dependencies` / `devDependencies` の使い分けで厳密に制御するバンドリング戦略である。

## 背景にある原則

- **実行環境ごとのコード分離原則**: `packages/vite/src/` は `node/`（サーバーサイド）、`client/`（ブラウザ）、`module-runner/`（SSR ランタイム）、`shared/`（共有ユーティリティ）、`types/`（型定義）に分離されている。これにより、バンドル時に不要な環境のコードが混入することを構造的に防ぎ、複数のエントリポイントから異なる環境向けの成果物を生成できる。単一パッケージ内でも実行コンテキストが異なるコードは物理的にディレクトリを分けるべきである。
  - 根拠: `packages/vite/package.json` の `exports` フィールドで `.`（node）、`./client`（ブラウザ型のみ）、`./module-runner`（SSR ランタイム）、`./internal`（内部 API）と明確に分離されている

- **Workspace = テストインフラ原則**: `playground/**` を pnpm workspace メンバーに含め、各ディレクトリが独立した Vite アプリケーションとして機能する。これにより E2E テストが「実際のユーザープロジェクト」と同じ構造で動作し、インテグレーションの問題を早期発見できる。テスト用の fixture は workspace メンバーとして管理することで、依存解決も実プロジェクトと同一の仕組みになる。
  - 根拠: `pnpm-workspace.yaml` で `playground/**` と `packages/**/__tests__/**` の両方が workspace メンバーとして登録されている

- **バンドル境界による依存分類原則**: `packages/vite/package.json` のコメント `"//": "READ CONTRIBUTING.md to understand what to put under deps vs. devDeps!"` が示すように、`dependencies` にはバンドルに含めない（ユーザー環境で解決する）パッケージのみを、`devDependencies` にはビルド時にバンドルに取り込むパッケージを配置する。一般的な npm の慣習（開発時のみ使うものが devDeps）とは逆転しており、「成果物に含まれるか否か」が分類基準となっている。
  - 根拠: `dependencies` には `rolldown`, `postcss`, `lightningcss` 等のランタイム必須パッケージのみ、`devDependencies` には `magic-string`, `ws`, `connect` 等のバンドルに取り込まれるパッケージが配置されている

- **パッケージごとのビルドツール最適化原則**: コアの `vite` パッケージは Rolldown でセルフバンドル、`create-vite` と `plugin-legacy` は軽量な `tsdown` を使用している。monorepo 内でもパッケージの性質に応じてビルドツールを使い分け、過剰な統一を避けている。
  - 根拠: `packages/vite/package.json` の `build-bundle` スクリプトが `rolldown --config rolldown.config.ts`、他2パッケージは `tsdown` を使用

## 実例と分析

### Workspace 設計: 多層構造の workspace メンバー

`pnpm-workspace.yaml` は4種類の workspace メンバーを定義している:

```yaml
# pnpm-workspace.yaml
packages:
  - 'packages/*'              # 公開パッケージ群
  - 'playground/**'           # E2E テスト用アプリ群
  - 'packages/**/__tests__/**' # パッケージ内テスト用 fixture
  - docs                      # ドキュメントサイト
```

この4層構造は、workspace の役割を明確に分離している:
1. **packages/\***: npm に公開されるパッケージ（vite, create-vite, plugin-legacy）
2. **playground/\*\***: E2E テストの実行対象となる実アプリケーション（40+）
3. **packages/\*\*/__tests__/\*\***: ユニットテスト内で使う fixture プロジェクト
4. **docs**: VitePress ドキュメントサイト

playground を workspace メンバーにすることで、`vite: "workspace:*"` としてローカルの開発版 Vite を直接参照でき、ビルドなしでの E2E テストが可能になる。

### 依存関係の制御: overrides と patches

```yaml
# pnpm-workspace.yaml
overrides:
  rolldown: $rolldown          # monorepo 全体で rolldown バージョンを統一
  vite: 'workspace:*'          # 全 playground が開発版 vite を使用
  debug: 'npm:obug@^1.0.2'    # debug パッケージを obug に置換

patchedDependencies:
  "sirv@3.0.2": "patches/sirv@3.0.2.patch"
  "chokidar@3.6.0": "patches/chokidar@3.6.0.patch"
  "dotenv-expand@12.0.3": "patches/dotenv-expand@12.0.3.patch"
  "http-proxy-3": patches/http-proxy-3.patch
```

注目すべきプラクティス:
- `$rolldown` 構文でルートの devDependencies のバージョンを参照し、バージョン一元管理を実現
- `debug` パッケージを `obug` に npm alias で置換（軽量化またはバンドル互換性のため）
- `patches/` ディレクトリで外部パッケージの不具合を monorepo 内でローカル修正

### エントリポイントの多重化: exports / imports マップ

```json
// packages/vite/package.json
"exports": {
  ".": "./dist/node/index.js",
  "./client": { "types": "./client.d.ts" },
  "./module-runner": "./dist/node/module-runner.js",
  "./internal": "./dist/node/internal.js",
  "./dist/client/*": "./dist/client/*",
  "./types/*": { "types": "./types/*" },
  "./types/internal/*": null,
  "./package.json": "./package.json"
}
```

```json
// packages/vite/package.json
"imports": {
  "#module-sync-enabled": {
    "module-sync": "./misc/true.js",
    "default": "./misc/false.js"
  },
  "#types/*": "./types/*.d.ts",
  "#dep-types/*": "./src/types/*.d.ts"
}
```

`exports` マップの設計ポイント:
- `"./types/internal/*": null` で内部型の外部公開を明示的にブロック
- `./client` は型定義のみ公開（ランタイムコードはブラウザで別途ロード）
- `./internal` エントリで「公開だが安定性を保証しない」API を分離
- `imports` マップの `#module-sync-enabled` は Node.js の条件付きエクスポートを活用し、`module-sync` 対応環境を検出

### ソースコードの環境別分離

`packages/vite/src/` 配下の5ディレクトリは明確な実行環境に対応:

| ディレクトリ | 実行環境 | 役割 |
|---|---|---|
| `node/` | Node.js (サーバー) | CLI、開発サーバー、ビルドパイプライン |
| `client/` | ブラウザ | HMR クライアント、オーバーレイ |
| `module-runner/` | 汎用 JS ランタイム | SSR モジュール実行環境 |
| `shared/` | 両環境 | 環境非依存のユーティリティ |
| `types/` | コンパイル時のみ | 型定義 |

この分離は `package.json` の `exports` と直接対応しており、バンドラーが環境ごとに適切なエントリポイントを選択できる。

### パッケージ間の独立性と責務分離

monorepo 内の3パッケージは明確に異なる責務を持つ:

| パッケージ | 目的 | ビルドツール | 依存の方向 |
|---|---|---|---|
| `vite` | コアビルドツール | Rolldown (セルフバンドル) | 独立 |
| `create-vite` | プロジェクトスキャフォールド | tsdown | vite に依存しない |
| `plugin-legacy` | レガシーブラウザ対応 | tsdown | vite に peerDependency |

`create-vite` は `vite` への依存が一切なく、完全に独立したパッケージとして設計されている。`plugin-legacy` は `vite` を `peerDependencies` として宣言し、`devDependencies` で `workspace:*` 参照を持つことで開発時のみローカル版を使用する。

### Hoisting の選択的制御

```yaml
# pnpm-workspace.yaml
hoistPattern:
  - postcss          # packages/vite が必要
  - pug              # playground/tailwind 経由で @vue/compiler-sfc が必要
  - eslint-import-resolver-*  # eslint-plugin-import-x が必要
```

pnpm のデフォルトでは厳格な依存分離が行われるが、特定のパッケージのみ `hoistPattern` でホイスティングを許可している。これはツールチェーンの都合（暗黙的な依存解決を期待するパッケージ）に対する最小限の妥協である。

### ルートレベルのテスト設計

```json
// package.json (root)
"scripts": {
  "test": "pnpm test-unit && pnpm test-serve && pnpm test-build",
  "test-serve": "vitest run -c vitest.config.e2e.ts",
  "test-build": "VITE_TEST_BUILD=1 vitest run -c vitest.config.e2e.ts",
  "test-unit": "vitest run"
}
```

テストは3段階に分離:
1. **test-unit**: Vitest によるユニットテスト（`vitest.config.ts`）
2. **test-serve**: 開発サーバーモードでの E2E テスト（`vitest.config.e2e.ts`）
3. **test-build**: ビルドモードでの E2E テスト（同じ config、環境変数で切り替え）

E2E テストは環境変数 `VITE_TEST_BUILD` の有無で serve/build モードを切り替える同一テストコードを使い回す設計で、テストコードの重複を排除している。

### preinstall によるパッケージマネージャ強制

```json
// package.json (root)
"scripts": {
  "preinstall": "npx only-allow pnpm"
},
"packageManager": "pnpm@10.29.2"
```

`preinstall` フックで pnpm 以外のパッケージマネージャを拒否し、`packageManager` フィールドで Corepack 経由のバージョン固定を併用している。これにより、コントリビュータが誤って npm/yarn を使用することを防止する。

## パターンカタログ

- **Facade パターン** (構造)
  - 解決する問題: 複数の内部モジュールを統合した公開 API の提供
  - 適用条件: 内部実装の複雑さをユーザーから隠蔽したい場合
  - コード例: `packages/vite/package.json` の `exports` で `.` エントリが `./dist/node/index.js` 1ファイルに集約
  - 注意点: `./internal` エントリで「使えるが安定保証なし」の API 層を別途用意し、Facade の裏口を制御している

- **Workspace Fixture パターン** (テスト構造)
  - 解決する問題: E2E テストで実際のプロジェクト構造を再現する必要性
  - 適用条件: ビルドツール・フレームワークなど、プロジェクト全体に影響するツールのテスト
  - コード例: `pnpm-workspace.yaml` の `playground/**` 定義
  - 注意点: fixture 数が増えると CI 時間が肥大化する。環境変数での serve/build 切り替えで fixture 重複を防ぐ

## Good Patterns

- **環境変数によるテストモード切り替え**: 同一の E2E テストコードを `VITE_TEST_BUILD=1` の有無で開発サーバーモードとビルドモードの両方で実行する。テストコードの重複を排除しながら、両モードの動作を保証できる。
  ```json
  // package.json (root)
  "test-serve": "vitest run -c vitest.config.e2e.ts",
  "test-build": "VITE_TEST_BUILD=1 vitest run -c vitest.config.e2e.ts"
  ```

- **exports の null マッピングによるアクセス制御**: 内部型を `"./types/internal/*": null` で明示的にブロックし、公開 API の境界を Package.json レベルで強制する。TypeScript の `export` だけでなく、モジュール解決レベルでアクセスを制御する防御的設計。
  ```json
  // packages/vite/package.json
  "exports": {
    "./types/*": { "types": "./types/*" },
    "./types/internal/*": null
  }
  ```

- **npm alias による依存パッケージ置換**: `overrides` で `debug: 'npm:obug@^1.0.2'` のように npm alias を使い、API 互換の軽量代替パッケージに置換する。フォーク管理なしでサプライチェーンの最適化が可能。
  ```yaml
  # pnpm-workspace.yaml
  overrides:
    debug: 'npm:obug@^1.0.2'
  ```

- **`$variable` による monorepo 内バージョン一元管理**: pnpm の `overrides` で `rolldown: $rolldown` のように `$` プレフィクスを使い、ルート `devDependencies` のバージョン定義を参照する。バージョンの二重管理を防止。
  ```yaml
  overrides:
    rolldown: $rolldown  # root devDependencies の rolldown バージョンを参照
  ```

## Anti-Patterns / 注意点

- **deps/devDeps の慣習的な使い方をバンドルツールに適用する**: 通常の npm パッケージでは「開発時のみ使うもの = devDependencies」だが、セルフバンドルするツールでは「バンドルに含めるもの = devDependencies、ランタイムで外部解決するもの = dependencies」となる。この逆転を理解せずに依存を分類すると、バンドルサイズの肥大化やランタイムエラーの原因になる。

  Bad:
  ```json
  // セルフバンドルツールで、バンドルに含めるライブラリを dependencies に
  "dependencies": {
    "magic-string": "^0.30.0",
    "ws": "^8.0.0",
    "connect": "^3.7.0"
  }
  ```

  Better:
  ```json
  // バンドルに含めるものは devDependencies に
  "devDependencies": {
    "magic-string": "^0.30.0",
    "ws": "^8.0.0",
    "connect": "^3.7.0"
  },
  // ユーザー環境で解決が必要なものだけ dependencies に
  "dependencies": {
    "postcss": "^8.5.0",
    "rolldown": "1.0.0-rc.4"
  }
  ```

- **monorepo 内でビルドツールを過剰に統一する**: パッケージの性質が異なるにもかかわらず、統一のために全パッケージに同じビルドツールを強制すると、シンプルなパッケージに不必要な複雑さが生じる。

  Bad:
  ```
  # 全パッケージに同一のビルド設定
  packages/vite/          -> rolldown (大規模バンドル)
  packages/create-vite/   -> rolldown (単純な CLI なのにオーバースペック)
  packages/plugin-legacy/ -> rolldown (単一ファイルなのにオーバースペック)
  ```

  Better:
  ```
  # パッケージの複雑さに応じたビルドツール選択
  packages/vite/          -> rolldown (複雑なマルチエントリ・セルフバンドル)
  packages/create-vite/   -> tsdown (シンプルな CLI バンドル)
  packages/plugin-legacy/ -> tsdown (単一エクスポートのプラグイン)
  ```

## 導出ルール

- `[MUST]` セルフバンドルするツールでは dependencies / devDependencies の分類をバンドル境界に基づいて行う — dependencies にはユーザー環境で解決するパッケージのみ、devDependencies にはバンドルに取り込むパッケージを配置する
  - 根拠: Vite は `magic-string`, `ws`, `connect` 等のバンドル対象を devDependencies に、`postcss`, `rolldown` 等のユーザー環境必須パッケージを dependencies に分類し、この慣習を CONTRIBUTING.md で明文化している

- `[MUST]` 単一パッケージ内で複数の実行環境（ブラウザ / サーバー / 共有）のコードが存在する場合、ソースディレクトリを実行環境ごとに物理的に分離し、`exports` マップで対応するエントリポイントを定義する
  - 根拠: `packages/vite/src/` が `node/`, `client/`, `module-runner/`, `shared/`, `types/` に分離され、`exports` の `.`, `./client`, `./module-runner` と1対1で対応している

- `[SHOULD]` monorepo の E2E テストでは、テスト対象を workspace メンバーとして登録し、実際のユーザープロジェクトと同じ依存解決メカニズムでテストする
  - 根拠: `pnpm-workspace.yaml` で `playground/**` を workspace メンバーに含め、`vite: "workspace:*"` で開発版を直接参照する設計により、パッケージ公開後の依存解決の問題を開発段階で検出できる

- `[SHOULD]` monorepo 内でもパッケージの複雑さに応じてビルドツールを使い分ける — 小規模パッケージにコアと同じ重量級ツールを強制しない
  - 根拠: コアの `vite` は Rolldown でセルフバンドル、`create-vite` と `plugin-legacy` は軽量な `tsdown` を使用している

- `[SHOULD]` 外部パッケージの不具合修正には monorepo ルートの `patches/` ディレクトリと pnpm の `patchedDependencies` を使い、フォークを避ける
  - 根拠: `pnpm-workspace.yaml` で `sirv`, `chokidar`, `dotenv-expand`, `http-proxy-3` の4パッケージにパッチを適用し、上流の修正を待ちながらローカルで問題を解決している

- `[SHOULD]` `exports` マップで内部 API パスに `null` を設定し、モジュール解決レベルでアクセスをブロックする
  - 根拠: `"./types/internal/*": null` により、TypeScript の型定義レベルだけでなくランタイムのモジュール解決でも内部 API へのアクセスを遮断している

- `[AVOID]` workspace 内の依存バージョンを各パッケージで個別管理する — pnpm `overrides` の `$variable` 構文やルート `devDependencies` でバージョンを一元管理する
  - 根拠: `overrides: { rolldown: $rolldown, vite: 'workspace:*' }` でモノレポ全体のバージョン整合性を workspace 設定レベルで保証している

## 適用チェックリスト

- [ ] monorepo のパッケージごとに「公開パッケージ」「テスト fixture」「ドキュメント」「内部ツール」の役割分類を明確にし、workspace 設定に反映しているか
- [ ] セルフバンドルするパッケージの dependencies / devDependencies がバンドル境界に基づいて正しく分類されているか（CONTRIBUTING 等で方針を明文化しているか）
- [ ] 複数の実行環境のコードを含むパッケージで、ソースディレクトリが環境ごとに分離され、`exports` マップと対応しているか
- [ ] E2E テストの fixture が workspace メンバーとして登録され、実プロジェクトと同じ依存解決パスでテストされているか
- [ ] 外部パッケージの修正に `patches/` + `patchedDependencies` を使い、フォーク管理を回避しているか
- [ ] monorepo 内の共有依存バージョンが `overrides` や `$variable` で一元管理されているか
- [ ] パッケージの複雑さに応じたビルドツール選択がされているか（全パッケージに同一ツールを強制していないか）
- [ ] `exports` マップで内部 API パスが `null` でブロックされ、公開 API の境界が明確か
- [ ] `preinstall` フックと `packageManager` フィールドでパッケージマネージャとバージョンが固定されているか
