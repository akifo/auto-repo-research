# Pattern: FS-Driven Registration

> 出典: [repos/biomejs/biome](../repos/biomejs/biome/)
> カテゴリ: pattern

## 概要

ファイルシステムのディレクトリ構造をコンポーネントのレジストリとして扱い、ファイルの配置だけで自動登録を完結させるパターン。手動の登録コード更新を排除することで、数百規模のコンポーネントを破綻なく管理でき、新規追加時の摩擦をゼロに近づける。

## 背景・文脈

Biome は 489 以上の lint ルールを持つ多言語対応ツールチェインであり、ルールの追加・削除が頻繁に発生する。従来の「ファイル作成 + 登録コードへの手動追記」ワークフローでは、登録忘れ・登録順の不整合・merge conflict が日常的に発生する。

Biome はこの問題を 2 つの proc macro で解決している:

1. **`declare_group_from_fs!`** -- コンパイル時にディレクトリを走査し、`.rs` ファイルを自動発見してルールグループに登録する
2. **`gen_tests!`** -- glob パターンでテストファイルを収集し、各ファイルに対応する `#[test]` 関数を自動生成する

いずれも「ファイルを所定のディレクトリに置くだけ」で登録が完了する設計であり、27 以上の crate で横断的に利用されている。

## 実装パターン

### 1. コンパイル時ディレクトリスキャンによるコンポーネント登録

proc macro がビルド時にディレクトリを走査し、ファイル名からコンポーネント型を導出して登録コードを生成する。

```rust
// crates/biome_analyze_macros/src/group_macro.rs:67-117
fn generate_group_code(category: &str, group: &str) -> Result<TokenStream> {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR")
        .context("CARGO_MANIFEST_DIR not set")?;
    let base_path = Utf8PathBuf::from(manifest_dir).join("src").join(category);
    let group_dir = base_path.join(group);
    let mut rules = BTreeMap::new();  // 順序保証で決定的なコード生成

    for entry in std::fs::read_dir(&group_dir)? {
        let entry = entry?.path();
        if !entry.is_file() || entry.extension() != Some("rs".as_ref()) {
            continue;
        }
        let file_name = entry.file_stem().unwrap().to_str().unwrap();
        if file_name == "mod" { continue; }

        // ファイル名 → PascalCase 型名に変換（例: no_alert.rs → NoAlert）
        let rule_type = Case::Pascal.convert(file_name);
        let module_name = format_ident!("{}", file_name);
        let rule_type = format_ident!("{}", rule_type);
        rules.insert(rule_type.to_string(), (
            quote! { pub mod #module_name; },
            quote! { self::#module_name::#rule_type },
        ));
    }
    // declare_lint_group! マクロ呼び出しを生成
}
```

呼び出し側は 1 行で済む:

```rust
// crates/biome_css_analyze/src/lint/nursery.rs:8-9
use biome_analyze_macros::declare_group_from_fs;
declare_group_from_fs! { category: "lint", group: "nursery" }
```

ルールファイルを `src/lint/nursery/` に追加するだけでグループに自動登録される。`mod.rs` や登録リストの更新は不要。

### 2. glob パターンによるテスト関数の自動生成

テストファイルを所定のディレクトリに配置するだけで、対応する `#[test]` 関数が自動生成される。

```rust
// crates/biome_js_analyze/tests/spec_tests.rs:27-29
tests_macros::gen_tests! {
    "tests/specs/**/*.{cjs,cts,js,mjs,jsx,tsx,ts,json,jsonc,svelte,vue}",
    crate::run_test,
    "module"
}
```

proc macro の内部では glob でファイルを収集し、パスからモジュール階層を構築する:

```rust
// crates/tests_macros/src/lib.rs:267-279（生成されるテスト関数）
#[test]
pub fn test_name() {
    let test_file = "tests/specs/complexity/noForEach/invalid.js";
    let test_expected_file = "tests/specs/complexity/noForEach/invalid.expected.js";
    let file_type = "module";
    let test_directory = "tests/specs/complexity/noForEach";
    crate::run_test(test_file, test_expected_file, test_directory, file_type);
}
```

### 3. ディレクトリパスからメタデータを導出

テストファイルのパス構造がそのままメタデータとして機能する。設定ファイルやアノテーションが不要。

```rust
// crates/biome_test_utils/src/lib.rs:532-546
pub fn parse_test_path(file: &Utf8Path) -> (&str, &str) {
    let mut group_name = "";
    let mut rule_name = "";
    for component in file.iter().rev() {
        if component == "specs" || component == "suppression" || component == "plugin" {
            break;
        }
        rule_name = group_name;
        group_name = DiffableStr::as_str(component).unwrap_or_default();
    }
    (group_name, rule_name)
}
// tests/specs/complexity/noForEach/invalid.js → group="complexity", rule="noForEach"
```

## Good Example

ファイル追加だけで登録が完了するワークフロー:

```
# ルールの追加: ファイルを置くだけ
src/lint/suspicious/
  no_alert.rs           # ← 新規ファイルを追加
  no_catch_assign.rs
  use_await.rs
  ...

# テストの追加: ファイルを置くだけ
tests/specs/suspicious/noAlert/
  invalid.js            # ← テストケースを追加
  valid.js
  invalid.options.json  # オプションテスト（任意）
```

- 登録リストの手動更新なし
- merge conflict のリスクなし（全員が同じリストファイルを編集する必要がない）
- `BTreeMap` で走査結果をソートし、ファイルシステムの列挙順序に依存しない決定的なコード生成

## Bad Example

手動登録リストによる管理:

```rust
// Bad: 中央の登録リストを手動メンテナンス
// 新規追加のたびにこのファイルを編集する必要がある
mod no_alert;
mod no_catch_assign;
mod use_await;
// ... 489 行のルールを手動管理

declare_lint_group! {
    pub Suspicious {
        rules: [
            no_alert::NoAlert,         // ← 追加忘れが起きる
            no_catch_assign::NoCatchAssign,
            use_await::UseAwait,
            // ... merge conflict の温床
        ]
    }
}
```

問題点:
- ルール追加時に登録リストの更新を忘れるリスク
- 複数人が同時にルールを追加すると merge conflict が発生
- 登録順序の一貫性を人手で維持する必要がある

## 適用ガイド

### どのような状況で使うべきか

- 同一インターフェースを持つコンポーネントが **20 個以上** あり、今後も増え続ける場合
- プラグイン、ルール、ハンドラ、コマンド、テストケースなど、追加頻度が高いもの
- 複数人が並行して新規コンポーネントを追加する開発体制

### 言語別の実現手段

| 言語 | 手段 | 例 |
|------|------|-----|
| Rust | proc macro + `std::fs::read_dir` | Biome の `declare_group_from_fs!` |
| TypeScript/Node.js | `fs.readdirSync` + dynamic import | Nuxt/Next.js のファイルベースルーティング |
| Python | `importlib` + `pkgutil.walk_packages` | pytest のテスト自動発見 |
| Go | `go generate` + `embed.FS` | コード生成スクリプト |
| Java/Kotlin | classpath scanning / annotation processing | Spring の `@ComponentScan` |

### 導入時の注意点

- **キャッシュ無効化**: ビルドツールのキャッシュがファイル追加を検知しない場合がある。Biome は `build.rs` の `cargo:rerun-if-changed` でディレクトリを監視している
- **命名規約の厳格化**: ファイル名がそのまま型名やテスト名に変換されるため、命名規約（ケバブケース、スネークケースなど）を明文化する
- **エラー報告**: ファイルが規約に合わない場合はコンパイル時エラーとして報告する。サイレントに無視すると発見が遅れる

### カスタマイズポイント

- ファイル名 → 型名の変換ルール（PascalCase、camelCase など）
- 対象ファイルの拡張子フィルタ（`.rs`, `.ts`, `.py` など）
- 除外パターン（`mod.rs`, `index.ts`, `__init__.py` など）
- サブディレクトリの扱い（フラット vs 再帰的スキャン）

## 参考

- [repos/biomejs/biome/rule-system-architecture.md](../repos/biomejs/biome/rule-system-architecture.md) -- ルールシステムの全体設計と `declare_group_from_fs!` の位置付け
- [repos/biomejs/biome/metaprogramming-techniques.md](../repos/biomejs/biome/metaprogramming-techniques.md) -- proc macro によるコード生成の詳細分析
- [repos/biomejs/biome/testing-practices.md](../repos/biomejs/biome/testing-practices.md) -- `gen_tests!` によるテスト自動生成の分析
