# Build and Tooling

> リポジトリ: biomejs/biome
> 分析日: 2026-03-09

## 概要

Biome は Rust + TypeScript のモノリポで、justfile タスクランナー・xtask コード生成・30 以上の GitHub Actions ワークフロー・changesets によるリリースフローを組み合わせた高度なビルドパイプラインを構築している。特に注目すべきは、コード生成（AST・アナライザ・設定・スキーマ・バインディング）をビルドプロセスの中核に据え、`just ready` コマンドで CI と同等のチェックをローカルで再現可能にしている点、および 8 プラットフォーム向けクロスコンパイル + WASM ビルド + npm パッケージ自動生成を単一リリースフローで実現している点である。

## 背景にある原則

- **Cargo エイリアスによるコマンド抽象化**: `.cargo/config.toml` で `cargo lint`、`cargo format`、`cargo codegen` 等のエイリアスを定義し、長い clippy/rustfmt/codegen コマンドを短縮名で隠蔽している。これにより justfile・CI ワークフロー・開発者の手動実行のすべてで同じコマンド名を使え、実装詳細の変更が呼び出し側に波及しない（`.cargo/config.toml:1-38`）

- **ローカルとCIの等価性**: `just ready` が `gen-all` → `documentation` → `lint` → `test` → `test-doc` を順に実行し、前後で `git diff --exit-code --quiet` を挟むことで「生成物が最新か」を検証する。CI で実行されるチェックをローカルで一発で再現でき、PR 前の確認コストを最小化する（`justfile:272-281`）

- **Feature フラグによるコード生成の段階的分離**: xtask_codegen は `schema`、`configuration`、`license` 等の Cargo feature でモジュールを条件コンパイルし、不要な依存を排除している。フル生成（`all`）と個別生成（`analyzer`、`schema` 等）を単一バイナリで実現しつつ、ビルド時間を削減する（`xtask/codegen/src/main.rs:1-9`）

- **変更検出による CI 実行の最適化**: PR ワークフローは `paths` フィルタで Rust コード変更時のみ実行し、ベンチマークワークフローはクレート単位の paths で絞り込む。加えて `concurrency` + `cancel-in-progress` で同一 PR の古いジョブを自動キャンセルする（`.github/workflows/pull_request.yml:9-21`）

## 実例と分析

### justfile のタスク階層設計

justfile は 3 層構造でタスクを組織している:

1. **プリミティブタスク**: `format`, `lint`, `test` など単一操作
2. **複合タスク**: `gen-analyzer`（`gen-rules` → `gen-configuration` → `gen-migrate` → `gen-bindings` → `lint-rules` → `format`）のように複数のプリミティブタスクを順序付きで実行
3. **エイリアス**: `f := format`, `t := test`, `r := ready` で頻用コマンドを短縮

特筆すべきは `ready` タスクの設計。先頭と末尾に `git diff --exit-code --quiet` を配置し、コード生成前後でワーキングツリーがクリーンであることを保証する。これにより「生成コードをコミットし忘れた」問題を防止する。

### Cargo エイリアスと justfile の役割分担

Cargo エイリアス（`.cargo/config.toml`）は Rust ツールチェーン固有の操作を抽象化し、justfile はプロジェクト全体のワークフロー（Rust + TypeScript + TOML フォーマット）を統合する。

```
Cargo エイリアス                justfile
├── lint (clippy)          ←── lint (cargo lint を呼ぶ)
├── format (cargo fmt)     ←── format (cargo format + pnpm format)
├── codegen (xtask)        ←── gen-rules (cargo run -p xtask_codegen)
├── biome-cli-dev          ←── (package.json scripts から利用)
└── documentation (doc)    ←── documentation (cargo documentation)
```

### コード生成パイプライン（xtask）

xtask ディレクトリは 4 つのサブプロジェクトで構成される:

- **codegen**: AST ノード・シンタックスファクトリ・フォーマッタ・アナライザルール・設定スキーマ・TypeScript バインディング等を生成
- **coverage**: Test262 適合率テスト
- **glue**: ファイル操作・プロジェクトルート解決等の共通ユーティリティ
- **rules_check**: ルールのドキュメント・テストケースの検証

codegen は `update()` 関数（`xtask/codegen/src/lib.rs:58-78`）で「ファイル内容が変わった場合のみ書き込む」パターンを使用し、不要な再コンパイルを回避する。`Mode::Verify` モードでは書き込みせず差分検出のみ行い、CI で「生成コードが最新か」を検証できる。

### 新ルール追加の自動化

`just new-js-lintrule <name>` は以下を一括実行する:
1. `xtask_codegen` でルールのボイラープレートを生成
2. `gen-analyzer` でアナライザ登録コードを再生成
3. 設定・マイグレーション・バインディング・ドキュメントを更新
4. フォーマット適用

言語ごとに `new-{lang}-lintrule` / `new-{lang}-assistrule` のバリエーションがあり、ルール追加の手順がテンプレート化されている。

### リリースフローの多段化

Biome は 4 種類のリリースチャネルを運用する:

1. **preview**: スケジュール実行（火・土の UTC 0:00）+ 手動トリガー。`pkg-pr-new` で npm に公開し Discord に通知
2. **beta**: 手動 `workflow_dispatch` でバージョン指定。`npm publish --tag beta`
3. **stable (release.yml)**: main への push 時に changesets が PR を作成 → マージで CLI・JS API を別パイプラインで公開 → GitHub Release + Docker イメージ + Web サイト更新を `repository_dispatch` で連鎖
4. **release_cli.yml**: 緊急リリース用の手動ワークフロー

### クロスプラットフォームビルド戦略

8 ターゲットを並列ビルドし、GNU/Linux 向けは Debian bullseye コンテナで古い glibc との互換性を確保する:

- `x86_64-pc-windows-msvc`, `aarch64-pc-windows-msvc`
- `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`（bullseye コンテナ）
- `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl`
- `x86_64-apple-darwin`, `aarch64-apple-darwin`

加えて WASM を bundler / nodejs / web の 3 ターゲットで出力。リリース時に `generate-packages.mjs` がバイナリをプラットフォーム別 npm パッケージにコピーし、バージョンを同期する。

### Clippy カスタムルールによるメモリアロケーション防止

`clippy.toml` で `str::to_ascii_lowercase` 等のメソッドを禁止し、メモリアロケーションを避ける独自の `biome_string_case` クレートの使用を強制している。禁止理由を `reason` フィールドに記載することで、代替手段が自動的にエラーメッセージに表示される。

## コード例

```rust
// .cargo/config.toml:36
lint = "clippy --workspace --all-features --all-targets -- --deny warnings"
```

```rust
// xtask/codegen/src/lib.rs:58-78
pub fn update(path: &Path, contents: &str, mode: &Mode) -> Result<UpdateResult> {
    match fs2::read_to_string(path) {
        Ok(old_contents) if old_contents == contents => {
            return Ok(UpdateResult::NotUpdated);
        }
        _ => (),
    }
    if *mode == Mode::Verify {
        anyhow::bail!("`{}` is not up-to-date", path.display());
    }
    eprintln!("updating {}", path.display());
    if let Some(parent) = path.parent()
        && !parent.exists()
    {
        fs2::create_dir_all(parent)?;
    }
    fs2::write(path, contents)?;
    Ok(UpdateResult::Updated)
}
```

```rust
// crates/biome_cli/src/lib.rs:43-46
pub(crate) const VERSION: &str = match option_env!("BIOME_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};
```

```toml
# clippy.toml:1-6
allow-dbg-in-tests = true
disallowed-methods = [
  { path = "str::to_ascii_lowercase", reason = "Avoid memory allocation. Use `biome_string_case::StrOnlyExtension::to_ascii_lowercase_cow` instead." },
  { path = "std::ffi::OsStr::to_ascii_lowercase", reason = "Avoid memory allocation. Use `biome_string_case::StrLikeExtension::to_ascii_lowercase_cow` instead." },
  { path = "str::to_lowercase", reason = "Avoid memory allocation. Use `biome_string_case::StrOnlyExtension::to_lowercase_cow` instead." },
]
```

```
# justfile:272-281
ready:
  git diff --exit-code --quiet
  just gen-all
  just documentation
  #just format # format is already run in `just gen-all`
  just lint
  just test
  just test-doc
  git diff --exit-code --quiet
```

## パターンカタログ

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: 新しいルール追加時に必要なボイラープレートの一貫性確保
  - 適用条件: 同種の成果物（lint ルール、formatter ルール等）を繰り返し追加するプロジェクト
  - コード例: `xtask/codegen/src/generate_new_analyzer_rule.rs:1-60`
  - 注意点: テンプレートの変更時は既存の生成済みコードとの整合性を `gen-all` で再検証する必要がある

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: codegen の `Mode::Overwrite` / `Mode::Verify` で書き込みと検証を同一コードで切り替え
  - 適用条件: ローカル開発（Overwrite）と CI 検証（Verify）で同じ生成ロジックを共有したい場面
  - コード例: `xtask/codegen/src/lib.rs:58-78`
  - 注意点: Verify モードは差分のみ報告し修正は行わないため、開発者が修正方法を知っている前提

## Good Patterns

- **環境変数によるバージョン注入**: `option_env!("BIOME_VERSION")` でビルド時にバージョンを注入し、未設定時は `CARGO_PKG_VERSION` にフォールバックする。リリースビルドでは CI が環境変数を設定し、開発ビルドでは Cargo.toml のバージョンが使われる。バージョンのシングルソースを npm の `package.json` に統一しつつ、Rust バイナリにも反映できる

```rust
// crates/biome_cli/src/lib.rs:43-46
pub(crate) const VERSION: &str = match option_env!("BIOME_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};
```

- **changesets の fixed グループ**: CLI 本体と全プラットフォームパッケージ・WASM パッケージを fixed グループにまとめ、バージョンを常に同期させる。ユーザーが `@biomejs/biome` をインストールすると optionalDependencies でプラットフォーム別パッケージが解決されるため、バージョン不一致は致命的になる

```json
// .changeset/config.json:5-19
"fixed": [
  [
    "@biomejs/biome",
    "@biomejs/cli-win32-x64",
    "@biomejs/cli-darwin-arm64",
    "@biomejs/wasm-bundler",
    ...
  ]
]
```

- **autofix CI ワークフロー**: PR に対してコード生成 + フォーマットを実行し、差分があれば自動コミットする `autofix-ci/action` を使用。コントリビューターがコード生成を忘れても CI が修正を提案するため、レビュー負荷を軽減する（`.github/workflows/autofix.yml`）

- **開発プロファイルの最適化**: `[profile.dev]` で `debug = "line-tables-only"` を設定し、依存クレートは `debug = false` にすることでデバッグビルドの速度と出力サイズを改善。WASM クレートのみ `opt-level = "s"` で最適化し、開発中も実用的な速度を確保する

```toml
# Cargo.toml:261-269
[profile.dev]
debug = "line-tables-only"

[profile.dev.package."*"]
debug = false

[profile.dev.package.biome_wasm]
opt-level = "s"
debug     = true
```

## Anti-Patterns / 注意点

- **コード生成後のフォーマット忘れ**: コード生成ツールが出力するコードはフォーマット済みとは限らない。`gen-all` は末尾で `just format` を実行するが、個別の `gen-rules` を単独で実行するとフォーマットされない生成コードがコミットされる可能性がある

```
# Bad: 個別生成のみ実行
just gen-rules
git add -A && git commit

# Better: gen-analyzer が後処理を含む、または手動でフォーマット
just gen-analyzer  # gen-rules + gen-configuration + ... + format
```

- **CI ワークフローの paths 漏れ**: ベンチマークワークフローは特定クレートの `.rs` ファイルのみを paths に列挙しているが、共通クレート（`biome_rowan` 等）の変更が見落とされる可能性がある。paths フィルタは保守的（広め）に設定すべき

```yaml
# Bad: 依存クレートの変更を見落とす可能性
paths:
  - 'crates/biome_js_formatter/**/*.rs'

# Better: 共通クレートも含める
paths:
  - 'crates/biome_js_formatter/**/*.rs'
  - 'crates/biome_formatter/**/*.rs'
  - 'crates/biome_rowan/**/*.rs'
```

## 導出ルール

- `[MUST]` コード生成とフォーマットは単一コマンドで連続実行し、生成後のフォーマット漏れを防ぐ
  - 根拠: Biome の `gen-all` は最後に `just format` を実行し、`ready` は前後で `git diff --exit-code` を挟んで生成物の整合性を保証している（`justfile:26-30, 272-281`）

- `[MUST]` リリース対象パッケージ群のバージョンは fixed グループ等で同期し、プラットフォーム別パッケージとのバージョン不一致を防ぐ
  - 根拠: Biome は changesets の `fixed` で CLI + 8 プラットフォームパッケージ + 3 WASM パッケージのバージョンを統一し、optionalDependencies 解決時の互換性を保証している（`.changeset/config.json:5-19`）

- `[SHOULD]` タスクランナーのコマンドを「プリミティブ→複合→エイリアス」の 3 層で構成し、個別実行と一括実行の両方を可能にする
  - 根拠: Biome の justfile は `format`/`lint`/`test` のプリミティブ、`gen-analyzer`/`ready` の複合、`f`/`t`/`r` のエイリアスで構成され、開発フェーズに応じた粒度の操作を提供している（`justfile:1-8, 47-53, 272-281`）

- `[SHOULD]` Rust プロジェクトでは `.cargo/config.toml` のエイリアスでツールチェーン操作を抽象化し、justfile/Makefile/CI から統一的に呼び出す
  - 根拠: Biome は `cargo lint`、`cargo format`、`cargo codegen` 等のエイリアスを定義し、clippy のフラグ詳細を呼び出し側から隠蔽している（`.cargo/config.toml:1-38`）

- `[SHOULD]` コード生成ツールに「書き込み」と「検証のみ」の 2 モードを持たせ、CI では検証モードで生成コードの鮮度をチェックする
  - 根拠: Biome の `update()` 関数は `Mode::Overwrite`（ローカル）と `Mode::Verify`（CI）を切り替え、同一ロジックで生成と検証を行う（`xtask/codegen/src/lib.rs:58-78`）

- `[SHOULD]` CI ワークフローには `concurrency` + `cancel-in-progress` を設定し、同一 PR の古いジョブを自動キャンセルする
  - 根拠: Biome の PR ワークフローは <code v-pre>group: ${{ github.workflow }}-${{ github.event.pull_request.number }}</code> で PR 単位のグループを作り、更新時に前回実行をキャンセルしてリソースを節約している（`.github/workflows/pull_request.yml:19-21`）

- `[SHOULD]` clippy の `disallowed-methods` でパフォーマンス上問題のある標準ライブラリメソッドを禁止し、代替手段を `reason` に記載する
  - 根拠: Biome は `str::to_ascii_lowercase` 等のアロケーションを伴うメソッドを禁止し、Cow を返す独自実装への移行を強制している（`clippy.toml:2-6`）

- `[AVOID]` リリースビルドで `codegen-units = 1` を使用する場合、開発ビルドにまで適用しない。開発ビルドではコンパイル速度を優先する
  - 根拠: Biome はリリース CI でのみ `RUSTFLAGS: "-C strip=symbols -C codegen-units=1"` を設定し、開発プロファイルでは `debug = "line-tables-only"` で速度を優先している（`.github/workflows/release.yml:163-165`, `Cargo.toml:261-262`）

## 適用チェックリスト

- [ ] タスクランナー（just/make）にプリミティブタスクと複合タスクの階層があるか
- [ ] 「ローカルで CI と同等のチェックを実行するコマンド」（`ready` 相当）が定義されているか
- [ ] コード生成後にフォーマットが自動適用される仕組みがあるか
- [ ] コード生成ツールに検証モード（diff のみ検出）があり、CI で使われているか
- [ ] CI ワークフローに `paths` フィルタと `concurrency` + `cancel-in-progress` が設定されているか
- [ ] リリース対象のパッケージ群のバージョンが同期される仕組み（changesets fixed 等）があるか
- [ ] Rust プロジェクトの場合、`.cargo/config.toml` のエイリアスでコマンドが抽象化されているか
- [ ] clippy の `disallowed-methods` でプロジェクト固有の禁止パターンが定義されているか
- [ ] 開発プロファイル（`profile.dev`）のデバッグ情報レベルが適切に調整されているか
- [ ] クロスプラットフォームビルドで古い OS との互換性（glibc バージョン等）が考慮されているか
