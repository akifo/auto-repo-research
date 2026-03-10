# メタプログラミング技法

> リポジトリ: biomejs/biome
> 分析日: 2026-03-09

## 概要

Biome は 94 クレート・489 以上の lint ルールを擁する大規模 Rust プロジェクトであり、3 層のメタプログラミング戦略（declarative macro、proc-macro、xtask コード生成）を組み合わせてボイラープレートを劇的に削減している。2,457 行の `.ungram` 文法定義から 54,000 行超の型安全な AST コードを生成し、`declare_lint_rule!` マクロにより各 lint ルールの定型コードをゼロにしている点が特に注目に値する。

## 背景にある原則

- **単一情報源（Single Source of Truth）の徹底**: 文法定義（`.ungram`）・ルール定義（ファイルシステム上の `.rs` ファイル）・設定スキーマをそれぞれ唯一の情報源とし、そこから必要なコードをすべて導出する。手動同期を排除することで不整合を構造的に防止する（`xtask/codegen/src/ast.rs`、`crates/biome_analyze_macros/src/group_macro.rs`）
- **コンパイル時検証の最大化**: proc-macro がコンパイル時にファイルシステムを走査し、`compile_error!` で即座にエラーを報告する。実行時エラーではなくコンパイルエラーとして不整合を検出する（`group_macro.rs:59-64`）
- **段階的抽象化**: 低レベルの `declare_rule!` → 中レベルの `declare_lint_rule!` → 高レベルの `declare_group_from_fs!` と、マクロを段階的に積み重ねることで、各層の責務を明確に分離している（`crates/biome_analyze/src/rule.rs:916-932, 832-860`）
- **ファイルシステム = レジストリ**: ルールの追加・削除をファイルの作成・削除で完結させ、登録コードの手動更新を不要にする。ディレクトリ構造そのものがメタデータとなる（`crates/biome_analyze_macros/src/group_macro.rs:74-117`）

## 実例と分析

### 3 層のコード生成パイプライン

Biome のメタプログラミングは明確に 3 層に分かれている:

**第 1 層: xtask コード生成（ビルド前）**
`.ungram` 文法ファイルから AST ノード型・SyntaxKind・ファクトリ関数・マクロ定義を生成する。`js.ungram`（2,457 行）から `nodes.rs`（45,798 行）、`kind.rs`（893 行）、`macros.rs`（1,484 行）、`nodes_mut.rs`（6,228 行）の計 54,000 行超を生成する。生成ファイルには `//! Generated file, do not edit by hand, see xtask/codegen` ヘッダが付与される。

**第 2 層: proc-macro（コンパイル時）**
5 つの proc-macro クレートが trait 実装を自動導出する:
- `biome_analyze_macros`: ファイルシステムからルールを発見し、グループ登録コードを生成
- `biome_deserialize_macros`: `Deserializable` / `Merge` トレイトを導出
- `biome_diagnostics_macros`: `Diagnostic` トレイトを導出
- `biome_configuration_macros`: 設定グループの構造体を生成
- `biome_js_type_info_macros`: `Resolvable` トレイトを導出

**第 3 層: declarative macro（コンパイル時）**
`declare_rule!` → `declare_lint_rule!` → `declare_lint_group!` のマクロチェーンがルールのメタデータ登録・カテゴリ解決を行う。

### ファイルシステム駆動のルール発見

`declare_group_from_fs!` proc-macro は `CARGO_MANIFEST_DIR` を基点にディレクトリを走査し、`.rs` ファイルを自動的にルールとして登録する。新しいルールの追加は `.rs` ファイルを作成するだけで完了し、`mod.rs` や登録コードの手動更新は不要。

### Serde 属性との相互運用

`biome_deserialize_macros` は独自の `#[deserializable(...)]` 属性と Serde の `#[serde(...)]` 属性の両方を認識する。Serde 属性をフォールバックとして読み取りつつ、独自属性が優先される設計になっている。これにより既存の Serde アノテーションを活用しながら追加のデシリアライゼーション機能を提供している。

### xtask によるルールスキャフォールディング

`cargo codegen new-lintrule` コマンドで言語・カテゴリ・ルール名を指定すると、ルール本体のテンプレート（`declare_lint_rule!` + `Rule` trait 実装）とオプション構造体（`#[derive(Deserializable, Merge)]` 付き）が自動生成される。

## コード例

```rust
// crates/biome_analyze/src/rule.rs:916-931
macro_rules! declare_rule {
    ( $( #[doc = $doc:literal] )+ $vis:vis $id:ident {
        version: $version:literal,
        name: $name:tt,
        language: $language:literal,
        $( $key:ident: $value:expr, )*
    } ) => {
        $( #[doc = $doc] )*
        $vis enum $id {}

        impl $crate::RuleMeta for $id {
            type Group = super::Group;
            const METADATA: $crate::RuleMetadata =
                $crate::RuleMetadata::new($version, $name, concat!( $( $doc, "\n", )* ), $language) $( .$key($value) )*;
        }
    }
}
```

```rust
// crates/biome_analyze_macros/src/group_macro.rs:67-75
fn generate_group_code(category: &str, group: &str) -> Result<TokenStream> {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").context("CARGO_MANIFEST_DIR not set")?;
    let base_path = Utf8PathBuf::from(manifest_dir).join("src").join(category);
    let group_dir = base_path.join(group);
    let mut rules = BTreeMap::new();
    for entry in std::fs::read_dir(&group_dir)
        .with_context(|| format!("Failed to read directory: {}", group_dir))?
    { /* ファイルを走査しルールを収集 */ }
```

```rust
// crates/biome_deserialize_macros/src/deserializable_derive/container_attrs.rs:93-120
// Serde 属性をフォールバックとして認識
} else if attr.path.is_ident("serde") {
    parse_meta_list(&attr.parse_meta()?, |meta| {
        match meta {
            Meta::Path(path) if path.is_ident("deny_unknown_fields") => {
                if opts.unknown_fields.is_none() {
                    opts.unknown_fields = Some(UnknownFields::Deny);
                }
            }
            // Don't fail on unrecognized Serde attrs
            _ => {}
        }
        Ok(())
    }).ok();
}
```

```rust
// crates/biome_deserialize_macros/src/lib.rs:339-341
// proc-macro デバッグ用の dead code パターン
if false {
    panic!("{tokens}");
}
```

## パターンカタログ

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: 各ルールの共通構造（メタデータ登録・グループ帰属・カテゴリ解決）と可変部分（ルールロジック）の分離
  - 適用条件: 同一の構造を持つが細部が異なるコンポーネントが多数（489+ lint ルール）存在する場合
  - コード例: `crates/biome_analyze/src/rule.rs:916-931`（`declare_rule!` が固定部分を生成、`Rule` trait 実装がユーザー定義部分）
  - 注意点: マクロ展開結果が不透明になるため、デバッグ用の `if false { panic!() }` パターンを併用している

- **Abstract Factory パターン** (分類: 生成)
  - 解決する問題: 複数言語の AST ノードを統一的に生成する仕組み
  - 適用条件: 異なる言語（JS/CSS/JSON/GraphQL/HTML/YAML 等）の構文木を同一のインフラで扱う場合
  - コード例: `xtask/codegen/src/generate_node_factory.rs`、`xtask/codegen/src/language_kind.rs`
  - 注意点: `.ungram` から生成されるため、文法変更時は必ず `xtask codegen grammar` を再実行する必要がある

- **Registry パターン** (分類: 構造)
  - 解決する問題: 数百のルールの登録・検索を一元管理する
  - 適用条件: プラグインや拡張ポイントが多数存在し、手動登録がスケールしない場合
  - コード例: `crates/biome_analyze_macros/src/group_macro.rs:74-117`（ファイルシステム走査による自動登録）
  - 注意点: ファイルシステム走査は proc-macro 内で行われるため、IDE のインクリメンタルコンパイルとの相互作用に `build.rs` での `cargo:rerun-if-changed` が必要

## Good Patterns

- **マクロ段階化による関心分離**: `declare_rule!`（基底）→ `declare_lint_rule!`（カテゴリ固有の拡張）→ `declare_lint_group!`（グループ登録）と 3 段階に分離している。各層は下位層のマクロを呼び出すだけで、独自の責務（カテゴリ解決、グループ登録等）を追加する。これにより新カテゴリ（例: `declare_syntax_rule!`）の追加が既存マクロの変更なしに可能。

```rust
// crates/biome_analyze/src/rule.rs:832-860
macro_rules! declare_lint_rule {
    ( ... ) => {
        biome_analyze::declare_rule!( ... );  // 基底マクロに委譲
        macro_rules! rule_category {          // カテゴリ解決を追加
            () => { super::group_category!( $name ) };
        }
    };
}
```

- **proc-macro デバッグ用 dead code**: すべての derive macro に `if false { panic!("{tokens}"); }` パターンが存在する。通常は到達しないが、`if false` を `if true` に変更するとコンパイル時にマクロ展開結果を確認できる。本番コードに影響を与えず、デバッグ手段を常に利用可能にしている。

```rust
// crates/biome_deserialize_macros/src/lib.rs:339-341
if false {
    panic!("{tokens}");
}
```

- **BTreeMap によるコード生成の決定性**: ルール走査結果を `BTreeMap` に格納することで、ファイルシステムの列挙順序に依存せず常に同一のコードを生成する。CI での差分チェック（`Mode::Verify`）と組み合わせることで、生成コードの一貫性を保証している。

```rust
// crates/biome_analyze_macros/src/group_macro.rs:75
let mut rules = BTreeMap::new();
```

## Anti-Patterns / 注意点

- **proc-macro 内でのファイルシステムアクセスの副作用**: `declare_group_from_fs!` はコンパイル時にファイルシステムを走査するため、Cargo のキャッシュ無効化が適切に行われないと新規ルールが認識されない。Biome はこの問題に対し、`build.rs` で `cargo:rerun-if-changed` を各ルールディレクトリに設定し、さらにグループファイルの mtime を更新する `touch_file` 関数を組み合わせている。

```rust
// Bad: proc-macro 内の FS アクセスだけでは再コンパイルが発火しない場合がある
// Better: build.rs でファイル監視を併用する
// xtask/codegen/src/generate_analyzer.rs:56-57
println!("cargo:rerun-if-changed={}", group_dir.display());
// + 各 .rs ファイルも個別に監視
```

- **コード生成ファイルの手動編集**: 生成ファイル（`//! Generated file, do not edit by hand`）を手動で編集すると、次回の codegen 実行時に上書きされる。`update()` 関数が既存内容との差分チェックを行うが、手動変更は保護されない。

```rust
// Bad: nodes.rs を直接編集する
// Better: .ungram ファイルを編集して codegen を再実行する
// xtask/codegen/src/lib.rs:58-78
pub fn update(path: &Path, contents: &str, mode: &Mode) -> Result<UpdateResult> {
    match fs2::read_to_string(path) {
        Ok(old_contents) if old_contents == contents => {
            return Ok(UpdateResult::NotUpdated);
        }
        _ => (),
    }
    // ...
}
```

## 導出ルール

- `[MUST]` proc-macro や xtask でコードを生成する場合、生成ファイルには「生成物であること」と「再生成コマンド」を示すヘッダコメントを必ず付与する
  - 根拠: Biome は全生成ファイルに `//! Generated file, do not edit by hand, see xtask/codegen` を付与しており、手動編集による事故を防止している（`crates/biome_js_syntax/src/generated/nodes.rs:1`）
- `[MUST]` コード生成でコレクションを使う場合は `BTreeMap`/`BTreeSet` など順序保証のある型を使い、生成結果を決定的にする
  - 根拠: `HashMap` を使うと生成コードの順序が実行ごとに変わり、無意味な diff が発生する。Biome は全コード生成で `BTreeMap` を使用している（`group_macro.rs:75`、`generate_analyzer.rs:97` 等）
- `[SHOULD]` 同種のコンポーネントが 10 個以上ある場合、宣言マクロまたはコード生成でボイラープレートを排除する
  - 根拠: Biome は 489+ ルールを `declare_lint_rule!` で定義し、各ルールのメタデータ登録・trait 実装を自動化している。手動実装であれば各ルール数十行の定型コードが必要になる
- `[SHOULD]` derive macro には `if false { panic!("{tokens}"); }` のようなデバッグ出力手段を組み込んでおく
  - 根拠: proc-macro の展開結果は通常のデバッガでは確認困難であり、Biome の 4 つの derive macro クレートすべてにこのパターンが存在する（`biome_deserialize_macros`、`biome_diagnostics_macros`、`biome_js_type_info_macros`）
- `[SHOULD]` proc-macro で属性を読み取る場合、既存のエコシステム属性（Serde 等）をフォールバックとして認識し、独自属性を優先する設計にする
  - 根拠: `biome_deserialize_macros` は `#[serde(deny_unknown_fields)]` を `#[deserializable(unknown_fields = "deny")]` と同等に扱い、既存アノテーションの再利用を可能にしている（`container_attrs.rs:93-120`）
- `[AVOID]` 登録コードの手動メンテナンスが必要なプラグインレジストリの設計
  - 根拠: Biome はファイルシステム走査による自動登録を採用し、`mod.rs` や登録リストの手動更新を排除した。ルール追加時に「ファイルを作成する」だけで登録が完了する設計が 489+ ルールのスケーラビリティを支えている

## 適用チェックリスト

- [ ] プロジェクト内に同一構造のコンポーネントが 10 個以上あるか棚卸しする（ルール、ハンドラ、コマンド等）
- [ ] 繰り返しパターンに対して declarative macro → proc-macro → xtask コード生成のどの層が適切か判断する
- [ ] コード生成の情報源（DSL、設定ファイル、ディレクトリ構造等）を単一に定め、手動同期ポイントを排除する
- [ ] 生成ファイルにヘッダコメントを付与し、`.gitattributes` で `linguist-generated=true` をマークする
- [ ] コード生成のコレクションに順序保証のある型（`BTreeMap` 等）を使い、CI で差分チェック（verify モード）を実施する
- [ ] proc-macro 内でファイルシステムにアクセスする場合、`build.rs` の `cargo:rerun-if-changed` で再コンパイルトリガーを適切に設定する
- [ ] derive macro にデバッグ出力手段（`if false { panic!() }` 等）を組み込む
