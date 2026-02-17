# practice: supply-chain-defense

> 出典: [repos/ryoppippi/ccusage](../repos/ryoppippi/ccusage/) からの知見
> カテゴリ: practice

## 概要

pnpm v10 が提供する `strictDepBuilds`、`blockExoticSubdeps`、`trustPolicy`、`minimumReleaseAge` の 4 つのセキュリティ設定を組み合わせ、npm サプライチェーン攻撃に対する多層防御を構築するプラクティス。単一の防御策に頼らず、攻撃ベクタごとに独立した防御層を設けることで、1 つの層が突破されても他の層が機能する Defense in Depth を実現する。

## 背景・文脈

npm エコシステムでは、悪意あるパッケージの `postinstall` スクリプトによるコード実行、アカウント乗っ取りによる改ざんリリース、非標準レジストリからの依存注入など、多様な攻撃ベクタが報告されている。ryoppippi/ccusage は pnpm v10 のセキュリティ機能をフル活用し、`pnpm-workspace.yaml` の数行の設定で 4 層の防御を実現している。加えて、`packageManager` フィールドのハッシュ固定と `preinstall` によるパッケージマネージャ強制で、ビルド環境の改ざんも防いでいる。

## 4 層防御の構成

各層が防ぐ攻撃ベクタを明確にする:

| 層      | 設定                                    | 防ぐ攻撃                                                                 |
| ------- | --------------------------------------- | ------------------------------------------------------------------------ |
| 第 1 層 | `strictDepBuilds: true` + `allowBuilds` | `postinstall` 等のビルドスクリプトによる任意コード実行                   |
| 第 2 層 | `blockExoticSubdeps: true`              | git URL / tarball URL による非正規パッケージの混入                       |
| 第 3 層 | `trustPolicy: no-downgrade`             | 既知バージョンより古い（改ざんされた可能性のある）バージョンへの切り替え |
| 第 4 層 | `minimumReleaseAge: 2880`               | アカウント乗っ取り直後の悪意あるリリースの即時適用                       |

## 実装パターン

### 4 層セキュリティ設定

```yaml
# pnpm-workspace.yaml:76-89 (ryoppippi/ccusage)

minimumReleaseAge: 2880

# Security settings for supply chain attack prevention
strictDepBuilds: true
blockExoticSubdeps: true
trustPolicy: no-downgrade

# Explicitly allow build scripts for packages that require them
# (replaces onlyBuiltDependencies)
allowBuilds:
  esbuild: true
  sharp: true
  sqlite3: true
  workerd: true
```

### パッケージマネージャのハッシュ固定と強制

```jsonc
// package.json:10,18 (ryoppippi/ccusage)
{
  "packageManager": "pnpm@10.28.2+sha512.41872f037ad22f7348e3b1debbaf7e867cfd448f2726d9cf74c08f19507c31d2c8e7a11525b983febc2df640b5438dee6023ebb1f84ed43cc2d654d2bc326264",
  "scripts": {
    "preinstall": "npx only-allow pnpm",
  },
}
```

`packageManager` フィールドの SHA-512 ハッシュにより Corepack がバイナリを検証する。`preinstall` の `only-allow pnpm` で npm/yarn による誤ったインストールをブロックする。

### enablePrePostScripts の明示的有効化

```yaml
# pnpm-workspace.yaml:74,91 (ryoppippi/ccusage)
enablePrePostScripts: true
shellEmulator: true
```

pnpm v10 では `pre/post` ライフサイクルスクリプトがデフォルト無効になった。`preinstall`（パッケージマネージャ強制）や `prepack`（ビルド + メタデータ最適化）が動作するためにこの設定が必須となる。`shellEmulator: true` は OS 間のシェル差異を吸収する。

### 公開物の最小化（攻撃対象面の縮小）

```jsonc
// apps/ccusage/package.json:57 (ryoppippi/ccusage)
{
  "scripts": {
    "prepack": "pnpm run build && clean-pkg-json",
  },
}
```

`clean-pkg-json` が公開パッケージから `devDependencies`、`scripts`、`devEngines` を除去する。バンドル CLI では全依存を `devDependencies` に配置しているため、エンドユーザーのインストール時に不要な依存ツリーが展開されない:

```jsonc
// apps/ccusage/package.json:69-104 (ryoppippi/ccusage)
{
  "devDependencies": {
    "@antfu/utils": "catalog:runtime",
    "gunshi": "catalog:runtime",
    "valibot": "catalog:runtime",
    "picocolors": "catalog:runtime",
    "tsdown": "catalog:build",
    "vitest": "catalog:testing",
    // ... runtime ライブラリも全て devDependencies
  },
}
```

## Good Example

```yaml
# pnpm-workspace.yaml - 4層防御のフル設定

# 第4層: 新リリースの48時間待機
minimumReleaseAge: 2880

# 第1層: ビルドスクリプト実行をデフォルト禁止
strictDepBuilds: true

# 第2層: 非標準レジストリからのサブ依存をブロック
blockExoticSubdeps: true

# 第3層: バージョンダウングレードを禁止
trustPolicy: no-downgrade

# 第1層の例外: ネイティブモジュール等の必須パッケージのみ許可（allowlist方式）
allowBuilds:
  esbuild: true
  sharp: true
```

allowlist 方式の利点: 新たに追加された悪意あるパッケージのビルドスクリプトは自動的にブロックされる。明示的に許可しない限り実行されない。

## Bad Example

```yaml
# Bad: 1層だけの防御（他の攻撃ベクタが残る）
strictDepBuilds: true
# blockExoticSubdeps, trustPolicy, minimumReleaseAge が未設定
# → git URL からの依存注入、バージョンダウングレード、新規リリースの即時適用が可能
```

```yaml
# Bad: denylist方式のビルド許可（新しい悪意あるパッケージを見逃す）
strictDepBuilds: false
onlyBuiltDependencies:
  - esbuild
  - sharp
# → 明示的にリストしたもの「だけ」実行するのではなく、
#    リスト外の全パッケージがビルドスクリプトを実行できてしまう
```

```jsonc
// Bad: バンドルCLIなのに dependencies に runtime ライブラリを配置
{
  "dependencies": {
    "valibot": "^1.1.0",
    "picocolors": "^1.1.1"
  }
}
// → エンドユーザーの npm install 時に不要な依存がインストールされる
// → サプライチェーン攻撃の対象面が拡大する

// Good: devDependencies に配置し、バンドラが解決
{
  "devDependencies": {
    "valibot": "catalog:runtime",
    "picocolors": "catalog:runtime"
  }
}
```

## 適用ガイド

### 段階的な導入

全設定を一度に導入するとビルドが壊れるリスクがある。以下の順序で段階的に導入する:

**Step 1: 最低限（5 分で導入可能）**

```yaml
# pnpm-workspace.yaml
strictDepBuilds: true
allowBuilds:
  esbuild: true  # プロジェクトで必要なパッケージを追加
```

まず `strictDepBuilds` でビルドスクリプト実行を止め、`pnpm install` 時にエラーになるパッケージを `allowBuilds` に追加する。これだけで最も危険な攻撃ベクタ（任意コード実行）を塞げる。

**Step 2: レジストリ制限を追加**

```yaml
strictDepBuilds: true
blockExoticSubdeps: true  # 追加
allowBuilds:
  esbuild: true
```

非標準レジストリからのサブ依存をブロック。通常のプロジェクトでは影響が少ない。

**Step 3: バージョン信頼性を追加**

```yaml
strictDepBuilds: true
blockExoticSubdeps: true
trustPolicy: no-downgrade  # 追加
allowBuilds:
  esbuild: true
```

バージョンダウングレードを禁止。ロックファイルの意図しない巻き戻しを防ぐ。

**Step 4: フル設定（時間制限を追加）**

```yaml
minimumReleaseAge: 2880  # 追加（48時間 = 2880分）
strictDepBuilds: true
blockExoticSubdeps: true
trustPolicy: no-downgrade
allowBuilds:
  esbuild: true
```

新リリースの待機期間を設定。**注意**: 緊急のセキュリティパッチを即座に適用できなくなるトレードオフがある。`minimumReleaseAge` の値はプロジェクトのリスク許容度に応じて調整する（1440 = 24 時間、2880 = 48 時間、4320 = 72 時間）。

### 注意点

- `enablePrePostScripts: true` を設定しないと `preinstall` の `only-allow` が動作しない（pnpm v10 のデフォルトが無効）
- `minimumReleaseAge` はゼロデイ脆弱性への即時パッチ適用を遅延させる。セキュリティ緊急時には一時的に値を下げるか、該当パッケージのバージョンを直接ロックファイルで指定する運用が必要
- `allowBuilds` はプロジェクトごとに必要なパッケージが異なる。`pnpm install` 実行時のエラーメッセージから必要なパッケージを特定して追加する

### カスタマイズポイント

- `minimumReleaseAge` の値: リスク許容度とパッチ速度のバランスで決定。ccusage は 48 時間を採用
- `allowBuilds` のリスト: ネイティブバイナリを持つパッケージ（esbuild, sharp, sqlite3 等）がビルドスクリプトを必要とするため、プロジェクトの依存に応じて追加する
- `packageManager` のハッシュ固定: `corepack use pnpm@latest` で自動生成される

## 参考

- [repos/ryoppippi/ccusage/dependency-management.md](../repos/ryoppippi/ccusage/dependency-management.md) -- サプライチェーンセキュリティの多層構成、devDependencies Only 戦略の詳細分析
- [repos/ryoppippi/ccusage/build-and-tooling.md](../repos/ryoppippi/ccusage/build-and-tooling.md) -- サプライチェーンの防衛的設定、prepack パイプラインの分析
