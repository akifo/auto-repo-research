# dependency-management

> リポジトリ: ryoppippi/ccusage
> 分析日: 2026-02-16

## 概要

ccusage は pnpm v10 の Catalogs 機能を `catalogMode: strict` で運用し、モノレポ全体の依存バージョンを単一ファイル（`pnpm-workspace.yaml`）で一元管理している。加えて、バンドル配布される CLI アプリは「全依存を devDependencies に置く」戦略を採り、`publishConfig` による exports 差し替えと `clean-pkg-json` によるメタデータ最適化を組み合わせている。さらに `strictDepBuilds`・`blockExoticSubdeps`・`trustPolicy`・`minimumReleaseAge` の 4 層でサプライチェーンセキュリティを構成しており、pnpm v10 のセキュリティ機能をフル活用した先進的な事例である。

## 背景にある原則

- **Single Source of Truth（バージョンの一元管理）**: 依存バージョンの定義箇所を 1 ファイルに限定することで、モノレポ内のバージョン不整合を構造的に排除すべき。ccusage では `pnpm-workspace.yaml` の catalogs に 8 カテゴリ（build, docs, lint, llm-docs, release, runtime, testing, types）を定義し、各パッケージからは `"catalog:runtime"` のような参照のみを行う。10 パッケージ合計 153 箇所の `catalog:` 参照すべてがこの一元定義を指す（`pnpm-workspace.yaml:1-92`）。

- **Defense in Depth（多層防御）**: サプライチェーン攻撃に対して単一の防御策に依存せず、複数の独立した防御層を組み合わせるべき。ccusage では `strictDepBuilds`（ビルドスクリプト実行を原則禁止）、`blockExoticSubdeps`（非標準レジストリのサブ依存をブロック）、`trustPolicy: no-downgrade`（バージョンダウングレード禁止）、`minimumReleaseAge: 2880`（新リリースの 48 時間待機）の 4 層で防御している（`pnpm-workspace.yaml:76-89`）。

- **Minimal Attack Surface（公開物の最小化）**: npm に公開するパッケージの `package.json` から不要なフィールドを除去し、攻撃対象面を縮小すべき。`prepack` スクリプトで `clean-pkg-json` を実行し、`devDependencies`・`scripts`・`devEngines` 等のメタデータを公開物から除去している。バンドル CLI では全依存を `devDependencies` に置くことで、インストール時に不要な依存が引き込まれることを防いでいる。

- **Reproducibility（再現性の確保）**: パッケージマネージャのバージョンを SHA-512 ハッシュ付きで固定し、`preinstall` で `only-allow pnpm` を強制することで、ビルド環境の再現性を保証すべき（`package.json:10,18`）。

## 実例と分析

### pnpm Catalogs によるバージョン一元管理

`catalogMode: strict` は、`pnpm-workspace.yaml` の catalogs に定義されていないバージョン指定を一切許さないモードである。これにより「うっかり個別のパッケージで異なるバージョンを指定してしまう」事故を構造的に防ぐ。

カタログは用途別に 8 カテゴリに分類されている:

| カテゴリ   | 用途                                      | 依存数 |
| ---------- | ----------------------------------------- | ------ |
| `build`    | tsdown, unplugin-macros 等のビルドツール  | 4      |
| `docs`     | VitePress, typedoc 等のドキュメントツール | 8      |
| `lint`     | ESLint, publint 等の静的解析ツール        | 5      |
| `llm-docs` | AI ツール向けドキュメントパッケージ       | 2      |
| `release`  | bumpp, changelogithub 等のリリースツール  | 5      |
| `runtime`  | 実行時に必要なライブラリ群                | 26     |
| `testing`  | vitest, fs-fixture 等のテストツール       | 2      |
| `types`    | @types/node, @types/bun 等の型定義        | 4      |

`llm-docs` カテゴリは特筆に値する。`@gunshi/docs` や `@praha/byethrow-docs` は「ライブラリの使い方をまとめた AI 向けドキュメントパッケージ」であり、Claude Code のスキルファイルから参照される。依存管理の仕組みをドキュメント配信にも転用している。

### devDependencies Only 戦略

ccusage の apps（ccusage, amp, codex, opencode, pi）は全て CLI ツールで、tsdown によるバンドル後に配布される。そのため runtime ライブラリも含めて全依存を `devDependencies` に配置している。唯一の例外は `@ccusage/mcp` で、MCP サーバーとして他パッケージから利用されるため `dependencies` を持つ。

```jsonc
// apps/ccusage/package.json:69-104
"devDependencies": {
    "@antfu/utils": "catalog:runtime",
    "@ccusage/internal": "workspace:*",
    "@ccusage/terminal": "workspace:*",
    // ... runtime ライブラリも全て devDependencies
    "gunshi": "catalog:runtime",
    "valibot": "catalog:runtime",
    "tsdown": "catalog:build",
    "vitest": "catalog:testing"
}
```

この戦略を成立させるのが `publishConfig` による exports 差し替えである。開発時は TypeScript ソースを直接参照し、公開時は `publishConfig` でバンドル後の `./dist/index.js` に切り替える:

```jsonc
// apps/ccusage/package.json:18-48
"exports": {
    ".": "./src/index.ts"     // 開発時: TypeScript ソース直接
},
"bin": {
    "ccusage": "./src/index.ts"  // 開発時: TS ソースで実行
},
"publishConfig": {
    "bin": {
        "ccusage": "./dist/index.js"  // 公開時: バンドル済み JS
    },
    "exports": {
        ".": "./dist/index.js"        // 公開時: バンドル済み JS
    }
}
```

### prepack パイプラインによる公開物の最適化

全 apps パッケージで `prepack` スクリプトが統一されている:

```jsonc
// apps/ccusage/package.json:57
"prepack": "pnpm run build && clean-pkg-json"
```

`clean-pkg-json` は公開される `package.json` から `devDependencies`、`scripts`、`devEngines` 等のメタデータを除去する。バンドル後のパッケージにはこれらの情報が不要であり、パッケージサイズ削減とセキュリティ向上の両方に寄与する。

`postrelease` スクリプト（`git checkout ./**/package.json package.json`）で、`clean-pkg-json` が変更した `package.json` を元に戻している。

### サプライチェーンセキュリティの多層構成

```yaml
# pnpm-workspace.yaml:78-89

# Security settings for supply chain attack prevention
strictDepBuilds: true
blockExoticSubdeps: true
trustPolicy: no-downgrade

# Explicitly allow build scripts for packages that require them
allowBuilds:
  esbuild: true
  sharp: true
  sqlite3: true
  workerd: true
```

各設定の役割:

1. **`strictDepBuilds: true`**: 依存パッケージのインストール時ビルドスクリプト（`postinstall` 等）をデフォルトで禁止。悪意あるパッケージがインストール時にコードを実行するリスクを排除する。
2. **`allowBuilds`**: ネイティブモジュール等、ビルドが必須な 4 パッケージのみ明示的に許可する allowlist 方式。
3. **`blockExoticSubdeps: true`**: git URL や tarball URL など非標準のサブ依存をブロック。正規レジストリ以外からの依存混入を防ぐ。
4. **`trustPolicy: no-downgrade`**: パッケージのバージョンダウングレードを禁止。既知のバージョンよりも古い（場合によっては改ざんされた）バージョンへの切り替えを防ぐ。
5. **`minimumReleaseAge: 2880`**: 公開から 48 時間未満のリリースのインストールを禁止。アカウント乗っ取りによる悪意あるリリースが検出・対処される時間的猶予を確保する。

### パッケージマネージャの固定と強制

```jsonc
// package.json:10
"packageManager": "pnpm@10.28.2+sha512.41872f037ad22f7348e3b1debbaf7e867cfd448f2726d9cf74c08f19507c31d2c8e7a11525b983febc2df640b5438dee6023ebb1f84ed43cc2d654d2bc326264"
```

`packageManager` フィールドに SHA-512 ハッシュを付与し、Corepack によるバイナリ検証を有効化している。加えて `preinstall` スクリプトの `npx only-allow pnpm` で、npm や yarn による誤ったインストールを即座にブロックする。

### JSR レジストリの活用

```yaml
# pnpm-workspace.yaml:44-45
'@ryoppippi/limo': jsr:^0.2.2
'@std/async': jsr:^1.0.14
```

npm レジストリに加えて JSR（JavaScript Registry）からもパッケージを取得している。`jsr:` プロトコルは pnpm がネイティブサポートしており、Deno 標準ライブラリ（`@std/async`）を Node.js プロジェクトで利用可能にする。

### shellEmulator と enablePrePostScripts

```yaml
# pnpm-workspace.yaml:74,91
enablePrePostScripts: true
shellEmulator: true
```

`shellEmulator: true` は pnpm 組み込みのシェルエミュレータを使用する設定で、OS 間のシェル差異を吸収する。`enablePrePostScripts: true` は pnpm v10 でデフォルト無効になった `pre/post` ライフサイクルスクリプトを明示的に有効化する。`prepack`・`postrelease`・`preinstall` といったスクリプトがこの設定に依存している。

## パターンカタログ

- **Facade パターン** (分類: 構造)
  - 解決する問題: モノレポ内の全パッケージが個別にバージョンを管理すると不整合が生じる
  - 適用条件: 10 以上のパッケージが共通依存を持つモノレポ
  - コード例: `pnpm-workspace.yaml:6-72`（catalogs がバージョン定義の唯一の窓口として機能）
  - 注意点: `catalogMode: strict` でなければ個別指定が混在し、Facade が崩れる

## Good Patterns

- **用途別カタログ分類**: catalogs を `build`・`runtime`・`testing` 等の用途で分類し、依存の目的を明示化。パッケージの `package.json` を見ただけで「この依存はビルドツールか、ランタイムか」が `catalog:build` / `catalog:runtime` から即座に判別できる。

```yaml
# pnpm-workspace.yaml:8-72
catalogs:
  build:
    tsdown: ^0.16.6
  runtime:
    valibot: ^1.1.0
  testing:
    vitest: ^4.0.15
```

- **allowlist 方式のビルド許可**: `strictDepBuilds: true` で全ビルドスクリプトを禁止した上で、ネイティブモジュール等の必須パッケージのみ `allowBuilds` で明示許可。denylist（禁止リスト）より allowlist（許可リスト）の方が安全で、新たな悪意あるパッケージが自動的にブロックされる。

```yaml
# pnpm-workspace.yaml:85-89
allowBuilds:
  esbuild: true
  sharp: true
  sqlite3: true
  workerd: true
```

- **publishConfig による開発時/公開時の差し替え**: `exports` と `bin` を開発時は TypeScript ソース直接参照、公開時は `publishConfig` でバンドル済み JS に切り替え。ビルドなしで開発できる DX と、最適化されたバンドルの配布を両立する。

```jsonc
// apps/ccusage/package.json:18-48
"exports": { ".": "./src/index.ts" },
"publishConfig": {
    "exports": { ".": "./dist/index.js" }
}
```

## Anti-Patterns / 注意点

- **dependencies への runtime ライブラリ配置（バンドル CLI の場合）**: バンドルされる CLI で runtime ライブラリを `dependencies` に配置すると、エンドユーザーの `npm install` 時に不要な依存がインストールされる。バンドル後は全てが単一ファイルに含まれるため、`dependencies` は空であるべき。

```jsonc
// Bad: バンドル CLI なのに dependencies に配置
{
  "dependencies": {
    "valibot": "^1.1.0",
    "picocolors": "^1.1.1"
  }
}

// Better: devDependencies に配置し、バンドラが解決
{
  "devDependencies": {
    "valibot": "catalog:runtime",
    "picocolors": "catalog:runtime"
  }
}
```

- **セキュリティ設定の部分適用**: `strictDepBuilds` だけ設定して他の防御層を省略すると、ビルドスクリプト以外の攻撃ベクタ（非標準レジストリ、バージョンダウングレード、新規リリースの即時適用）が残る。

```yaml
# Bad: 1層だけの防御
strictDepBuilds: true

# Better: 複数層の組み合わせ
strictDepBuilds: true
blockExoticSubdeps: true
trustPolicy: no-downgrade
minimumReleaseAge: 2880
```

## 導出ルール

- `[MUST]` モノレポでは依存バージョンの定義を単一の場所に集約し、個別パッケージでのバージョン直接指定を禁止する
  - 根拠: ccusage は `catalogMode: strict` で 10 パッケージ 153 箇所の依存参照を `pnpm-workspace.yaml` に一元化し、バージョン不整合を構造的に排除している

- `[MUST]` バンドル配布される CLI/アプリでは runtime ライブラリを `devDependencies` に配置し、`dependencies` を空にする
  - 根拠: ccusage の 5 つの apps は全て tsdown でバンドルし、runtime 依存を含む全パッケージを `devDependencies` に配置。エンドユーザーのインストール時に不要な依存ツリーが展開されない

- `[SHOULD]` 依存パッケージのビルドスクリプト実行は allowlist 方式で制御し、ネイティブモジュール等の必須パッケージのみ明示的に許可する
  - 根拠: `strictDepBuilds: true` + `allowBuilds` で esbuild, sharp, sqlite3, workerd の 4 パッケージのみ許可し、それ以外のビルドスクリプト実行をブロック（`pnpm-workspace.yaml:79,85-89`）

- `[SHOULD]` サプライチェーンセキュリティは単一の設定に頼らず、ビルド制限・レジストリ制限・バージョン制限・時間制限の複数層で構成する
  - 根拠: ccusage は `strictDepBuilds`・`blockExoticSubdeps`・`trustPolicy`・`minimumReleaseAge` の 4 設定を組み合わせて多層防御を実現（`pnpm-workspace.yaml:78-89`）

- `[SHOULD]` パッケージマネージャのバージョンを `packageManager` フィールドでハッシュ付き固定し、`preinstall` で使用を強制する
  - 根拠: SHA-512 ハッシュ付きの `packageManager` フィールドと `npx only-allow pnpm` の併用により、パッケージマネージャの改ざんと誤使用を防止（`package.json:10,18`）

- `[SHOULD]` `prepack` でビルドとメタデータ最適化を行い、公開物に `devDependencies`・`scripts` 等の開発用フィールドを含めない
  - 根拠: 全 apps パッケージで `"prepack": "pnpm run build && clean-pkg-json"` を統一実行し、公開パッケージのサイズ削減とセキュリティ向上を両立

- `[AVOID]` 新規リリースを即座にインストール可能な状態にすること。`minimumReleaseAge` で待機期間を設け、アカウント乗っ取り等による悪意あるリリースの検出時間を確保する
  - 根拠: ccusage は `minimumReleaseAge: 2880`（48 時間）を設定し、新リリースの即時適用リスクを排除（`pnpm-workspace.yaml:76`）

## 適用チェックリスト

- [ ] `pnpm-workspace.yaml` に `catalogMode: strict` を設定し、全依存バージョンを catalogs で一元管理しているか
- [ ] catalogs を用途別（build, runtime, testing 等）に分類し、依存の目的を明示しているか
- [ ] バンドル配布されるパッケージの `dependencies` が空で、runtime ライブラリが `devDependencies` に配置されているか
- [ ] `publishConfig` で開発時と公開時の `exports`/`bin` を適切に切り替えているか
- [ ] `prepack` スクリプトでビルドと `clean-pkg-json` を実行し、公開物を最適化しているか
- [ ] `strictDepBuilds: true` + `allowBuilds` で必須パッケージのみビルドスクリプト実行を許可しているか
- [ ] `blockExoticSubdeps: true` で非標準レジストリからのサブ依存をブロックしているか
- [ ] `trustPolicy: no-downgrade` でバージョンダウングレードを禁止しているか
- [ ] `minimumReleaseAge` で新リリースの待機期間（推奨: 48 時間以上）を設定しているか
- [ ] `packageManager` フィールドに SHA-512 ハッシュを付与し、`preinstall` で `only-allow` を実行しているか
- [ ] `enablePrePostScripts: true` を設定し、`prepack`/`postrelease`/`preinstall` 等のライフサイクルスクリプトが動作するか確認しているか
