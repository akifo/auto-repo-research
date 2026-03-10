# Practice: Nursery Incubation

> 出典: [repos/biomejs/biome](../repos/biomejs/biome/) の rule-system-architecture, design-philosophy, build-and-tooling
> カテゴリ: practice

## 概要

新機能を「nursery（育成）」ステージで試験的に公開し、フィードバックを経て段階的に stable グループへ昇格するリリース戦略。semver の対象外となるインキュベーション空間を設けることで、「早期リリース」と「安定性の保証」を両立する。プラグインシステムやルールエンジンなど、機能が継続的に増加するプロジェクトで特に有効。

## 背景・文脈

Biome（Rust 製の統合リンター/フォーマッタ）は数百の lint ルールを管理しており、新ルールの品質を保ちつつ素早くユーザーに届ける仕組みが必要だった。全ての新ルールを `nursery` グループに配置し、安定するまで semver の対象外とする運用を義務化している。これにより、パッチリリースで nursery ルールの振る舞いを変更しても breaking change にならない。

この戦略は Rust Clippy の lint group（`clippy::nursery`）や TC39 の Stage 制（Stage 0-4）と同じ発想に基づくが、Biome はメタデータ・CI 検証・自動昇格ツールまで含めた包括的な仕組みとして実装している。

## 実装パターン

### 1. プレースホルダバージョンによるステージ表現

nursery ルールは `version: "next"` というプレースホルダを使い、「まだリリースされていない」ことをメタデータで表現する。リリース時にスクリプトで一括置換する。

```rust
// crates/biome_json_analyze/src/lint/nursery/no_empty_object_keys.rs:60-66
pub NoEmptyObjectKeys {
    version: "next",
    name: "noEmptyObjectKeys",
    language: "json",
    recommended: false,
    sources: &[RuleSource::EslintJson("no-empty-keys").same()],
}
```

安定ルールには実際のバージョン番号が入る:

```rust
// crates/biome_js_analyze/src/lint/suspicious/use_await.rs:14-41
pub UseAwait {
    version: "1.4.0",
    name: "useAwait",
    language: "js",
    sources: &[
        RuleSource::Eslint("require-await").same(),
        RuleSource::EslintTypeScript("require-await").same(),
    ],
    recommended: false,
    severity: Severity::Warning,
}
```

### 2. ビルド時フラグによる nursery の推奨制御

`BIOME_VERSION` 環境変数の有無で「安定ビルド」か「開発ビルド」かを判定し、nursery ルールのデフォルト有効/無効を切り替える。

```rust
// crates/biome_flags/src/lib.rs:11-17
/// Returns `true` if this is an unstable build of Biome
pub fn is_unstable() -> bool {
    BIOME_VERSION.deref().is_none()
}

/// The internal version of Biome. This is usually supplied during the CI build
pub static BIOME_VERSION: LazyLock<Option<&str>> =
    LazyLock::new(|| option_env!("BIOME_VERSION"));
```

設定解決時、nursery の推奨ルールは unstable ビルドでのみ自動有効化される:

```rust
// crates/biome_configuration/src/analyzer/linter/rules.rs:2177-2186
if let Some(group) = self.nursery.as_ref() {
    group.collect_preset_rules(
        !self.is_recommended_false() && biome_flags::is_unstable(),
        &mut enabled_rules,
    );
    // ...
} else if !self.is_recommended_false() && biome_flags::is_unstable() {
    enabled_rules.extend(Nursery::recommended_rules_as_filters());
}
```

### 3. リリース時のバージョン一括更新

`scripts/update-next-version.sh` が `version: "next"` を実際のリリースバージョンに sed で一括置換する。`--dry-run` モードで事前確認も可能。

```bash
# scripts/update-next-version.sh:31-32, 161-163
PATTERN='version:[[:space:]]*"next"'
SEARCH_ROOT='crates/biome_*_analyze'

# 置換実行
sed -E -i "s|version:[[:space:]]*\"next\"|version: \"$ESCAPED_REPLACE\"|g" "$f"
```

### 4. 昇格ツールによるグループ移動

`just move-rule <rulename> <group>` コマンドで nursery から安定グループへの昇格を自動化する。ソースファイル、テストディレクトリ、診断カテゴリ定義を一括で移動する。

```rust
// xtask/codegen/src/move_rule.rs:31-41
pub fn move_rule(rule_name: &str, new_group: &str) {
    // ...
    if !KNOWN_GROUPS.contains(&new_group) {
        panic!(
            "The group '{}' doesn't exist. Available groups: {}",
            new_group,
            KNOWN_GROUPS.join(", ")
        )
    }
    // ルールファイル、テスト、カテゴリ定義を新グループへ移動
}
```

```
# justfile:203-206
# Promotes a rule from the nursery group to a new group
move-rule rulename group:
  cargo run -p xtask_codegen -- move-rule --group={{group}} --name={{rulename}}
  cargo run -p xtask_codegen -- analyzer
```

### 5. CI によるステージ整合性の検証

`xtask/rules_check` が「nursery 以外のグループに WIP マーカー（`issue_number`）があるルール」を検出してエラーにする。

```rust
// xtask/rules_check/src/lib.rs:80-85
if let Some(issue_number) = R::METADATA.issue_number
    && group != "nursery"
{
    self.errors.push(Errors::new(format!(
        "The rule '{rule_name}' has an issue number set to '{issue_number}'. \
         Rules that have an issue number must belong to the 'nursery' group."
    )));
}
```

## Good Example

段階的安定化の完全なライフサイクルを仕組みとして整備している:

```
[新ルール追加]
  just new-js-lintrule myRule
  → nursery/ にファイル生成、version: "next"

[開発・テスト期間]
  → nursery グループなので semver 対象外
  → 開発ビルド (is_unstable=true) では推奨ルールとして有効
  → リリースビルド (BIOME_VERSION 設定済み) ではユーザーが明示的に有効化した場合のみ動作
  → issue_number で「WIP」をユーザーに通知

[安定化判断]
  → issue_number を除去
  → version: "next" はリリーススクリプトで実バージョンに置換

[グループ昇格]
  just move-rule myRule correctness
  → ソース・テスト・カテゴリ定義を一括移動
  → CI が重要度とグループの整合性を自動検証
```

この仕組みにより:
- 新ルールを早期にリリースできる（nursery = semver 対象外）
- 安定版ユーザーに破壊的変更が及ばない
- 昇格時の手作業ミス（ファイル移動忘れ、カテゴリ不整合）を自動化で防止

## Bad Example

```
# NG: ステージ管理なしで直接 stable グループに追加
# → ルールの振る舞い変更が全て semver の breaking change になる
# → 品質が不十分なルールがユーザーに影響する

新ルール追加 → correctness/ に直接配置
  version: "1.5.0"  # 初回から正式バージョン
  recommended: true  # 初回から推奨有効

# NG: ステージはあるが手動運用のみ
# → ドキュメントに「nursery は experimental」と書くだけ
# → CI 検証がないため、nursery ルールに安定版メタデータが紛れ込む
# → 昇格時にファイル移動・メタデータ更新を手動で行い、漏れが発生する
```

## 適用ガイド

- **どのような状況で使うべきか**
  - プラグイン/ルール/拡張が継続的に追加されるプロジェクト
  - ユーザーに semver で安定性を保証しつつ、新機能を早期に試せるようにしたい場合
  - コントリビューターが「完璧でなくてもまず出す」文化を作りたい場合

- **導入時の注意点**
  - ステージの定義（nursery / beta / stable 等）と昇格基準を明文化する
  - ステージ情報はコード内のメタデータに埋め込み、ドキュメントだけに頼らない
  - CI でステージとメタデータの整合性を自動検証する仕組みを最初から作る
  - 「nursery に入ったまま放置される」問題を防ぐために、定期的な棚卸しの運用を設ける

- **カスタマイズポイント**
  - ステージ数: Biome は nursery → stable の 2 段階だが、TC39 のように 5 段階にすることも可能
  - プレースホルダの形式: `"next"` の代わりに `"0.0.0-nursery"` のような semver 互換形式も選択肢
  - 有効化の制御: ビルド時フラグ（Biome 方式）、設定ファイルのチャンネル指定、CLI オプションなど
  - 言語非依存: Rust/マクロ固有の実装ではなく、メタデータ + プレースホルダ + 昇格スクリプト + CI 検証というパターン自体はどの言語でも適用可能

## 参考

- [repos/biomejs/biome/rule-system-architecture.md](../repos/biomejs/biome/rule-system-architecture.md) — ルールシステムの階層設計と nursery グループの位置づけ
- [repos/biomejs/biome/design-philosophy.md](../repos/biomejs/biome/design-philosophy.md) — 段階的安定化の設計思想
- [repos/biomejs/biome/build-and-tooling.md](../repos/biomejs/biome/build-and-tooling.md) — リリースフローとバージョン管理
