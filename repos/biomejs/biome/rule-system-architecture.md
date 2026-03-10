# ルールシステムアーキテクチャ

> リポジトリ: biomejs/biome
> 分析日: 2026-03-09

## 概要

Biome のルールシステムは、Lint/Assist ルールの宣言・登録・ライフサイクル管理を型安全かつ宣言的に実現するフレームワークである。数百のルールを統一的に管理するために、Rust のトレイトシステムとマクロを活用した多層構造（Rule → RuleGroup → GroupCategory → Registry）を採用している。特に注目すべきは、nursery グループによるインキュベーション戦略と、コード生成による登録の自動化である。

## 背景にある原則

- **宣言的メタデータによる一元管理**: ルールの名前・バージョン・推奨フラグ・重要度・出自（source）などをすべて `RuleMetadata` 構造体に集約する。ルールの振る舞い（`Rule` trait の `run` メソッド）とメタデータ（`RuleMeta` trait の `METADATA` 定数）を分離することで、コード生成・ドキュメント生成・設定生成が同一のメタデータソースから派生でき、不整合が起きない（`crates/biome_analyze/src/rule.rs:26-50`）。

- **段階的安定化による破壊的変更の回避**: 新規ルールは必ず `nursery` グループに配置し、semver の対象外とする。安定したらグループを移動（promote）し、`version: "next"` をリリースバージョンに更新する。これにより、実験的ルールを早期にリリースしつつ、安定版ユーザーへの破壊的変更を防ぐ（`crates/biome_analyze/CONTRIBUTING.md:216`）。

- **型システムによる階層的フィルタリング**: `GroupCategory → RuleGroup → Rule` の 3 層トレイト階層を使い、Visitor パターンで再帰的にルールを登録する。各層で `AnalysisFilter` によるフィルタリングが効くため、カテゴリ単位・グループ単位・ルール単位の有効化/無効化を型安全に行える（`crates/biome_analyze/src/registry.rs:39-54`）。

- **マクロによるボイラープレート排除と整合性担保**: `declare_lint_rule!` / `declare_lint_group!` / `declare_category!` マクロがルール型の定義・トレイト実装・グループ登録を一括生成する。手動実装を排除することで、登録忘れや型不一致を構造的に防ぐ（`crates/biome_analyze/src/rule.rs:832-858`）。

## 実例と分析

### ルールの宣言構造

ルールは `declare_lint_rule!` マクロで宣言される。マクロは内部で `declare_rule!` を呼び出し、空の enum 型を定義して `RuleMeta` trait を実装する。ルールの振る舞いは `Rule` trait の `run` メソッドで別途実装する。

```rust
// crates/biome_js_analyze/src/lint/suspicious/use_await.rs:14-67
declare_lint_rule! {
    /// Ensure `async` functions utilize `await`.
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
}
```

nursery ルールは `version: "next"` を使い、リリース時に `scripts/update-next-version.sh` でバージョン番号に一括変換される。

```rust
// crates/biome_json_analyze/src/lint/nursery/no_empty_object_keys.rs:60 付近
pub NoEmptyObjectKeys {
    version: "next",
    name: "noEmptyObjectKeys",
    language: "json",
    // ...
}
```

### 3 層トレイト階層

ルールの登録は `GroupCategory → RuleGroup → Rule` の 3 層で行われる。

1. **GroupCategory**: `Lint`, `Action`, `Syntax` などのカテゴリを定義し、配下のグループを列挙する
2. **RuleGroup**: `nursery`, `suspicious`, `correctness` などのグループを定義し、配下のルールを列挙する
3. **Rule**: 個別のルール実装

```rust
// crates/biome_js_analyze/src/lint.rs:11（codegen 出力）
biome_analyze::declare_category! {
    pub Lint {
        kind: Lint,
        groups: [
            self::a11y::A11y,
            self::complexity::Complexity,
            self::correctness::Correctness,
            self::nursery::Nursery,
            self::performance::Performance,
            self::security::Security,
            self::style::Style,
            self::suspicious::Suspicious,
        ]
    }
}
```

### ファイルシステムベースのルール発見

`declare_group_from_fs!` proc マクロが、コンパイル時にディレクトリをスキャンしてルールファイルを自動発見する。これにより、ルールファイルを追加するだけでグループへの登録が完了する。

```rust
// crates/biome_analyze_macros/src/group_macro.rs:67-117
fn generate_group_code(category: &str, group: &str) -> Result<TokenStream> {
    let group_dir = base_path.join(group);
    let mut rules = BTreeMap::new();
    for entry in std::fs::read_dir(&group_dir)? {
        // .rs ファイルを発見し、PascalCase に変換してルール型として登録
        let rule_type = Case::Pascal.convert(file_name);
        rules.insert(key, (module_decl, rule_path));
    }
    // declare_lint_group! を生成
}
```

### Visitor パターンによるフィルタリング付き登録

`RegistryVisitor` trait の `record_category` → `record_group` → `record_rule` メソッドチェーンで、各段階でフィルタが適用される。

```rust
// crates/biome_analyze/src/registry.rs:148-168
impl<L: Language + Default + 'static> RegistryVisitor<L> for RuleRegistryBuilder<'_, L> {
    fn record_category<C: GroupCategory<Language = L>>(&mut self) {
        if self.filter.match_category::<C>() {
            C::record_groups(self);
        }
    }
    fn record_group<G: RuleGroup<Language = L>>(&mut self) {
        if self.filter.match_group::<G>() {
            G::record_rules(self);
        }
    }
    fn record_rule<R>(&mut self) where R: Rule + 'static {
        if !self.filter.match_rule::<R>() { return; }
        // SyntaxKind ごとにルールを登録
    }
}
```

### グループ・重要度制約の自動検証

`xtask/rules_check` がグループとセバリティの組み合わせを静的にチェックする。例えば `correctness` グループのルールは `Severity::Error` でなければならない。

```rust
// xtask/rules_check/src/lib.rs:88-114
if matches!(group, "a11y" | "correctness" | "security")
    && rule_severity != Severity::Error { /* エラー */ }
else if matches!(group, "complexity" | "style")
    && rule_severity == Severity::Error { /* エラー */ }
else if group == "performance"
    && rule_severity != Severity::Warning { /* エラー */ }
```

### メタデータ駆動のコード生成

`xtask/codegen/src/generate_configuration.rs` は `RegistryVisitor` を実装した `LintRulesVisitor` でルール一覧を収集し、設定ファイルのスキーマやドキュメントを生成する。メタデータが single source of truth として機能する。

## コード例

```rust
// crates/biome_analyze/src/rule.rs:26-50
pub struct RuleMetadata {
    pub deprecated: Option<&'static str>,
    pub version: &'static str,
    pub name: &'static str,
    pub docs: &'static str,
    pub language: &'static str,
    pub recommended: bool,
    pub fix_kind: FixKind,
    pub sources: &'static [RuleSourceWithKind],
    pub severity: Severity,
    pub domains: &'static [RuleDomain],
    pub issue_number: Option<&'static str>,
}
```

```rust
// crates/biome_analyze/src/rule.rs:916-931 — declare_rule! マクロ
macro_rules! declare_rule {
    ( $( #[doc = $doc:literal] )+ $vis:vis $id:ident {
        version: $version:literal, name: $name:tt, language: $language:literal,
        $( $key:ident: $value:expr, )*
    } ) => {
        $vis enum $id {}
        impl $crate::RuleMeta for $id {
            type Group = super::Group;
            const METADATA: $crate::RuleMetadata =
                $crate::RuleMetadata::new($version, $name, concat!($($doc, "\n",)*), $language)
                $( .$key($value) )*;
        }
    }
}
```

```rust
// crates/biome_analyze/src/rule.rs:1190-1212 — Rule trait
pub trait Rule: RuleMeta + Sized {
    type Query: Queryable;
    type State;
    type Signals: IntoIterator<Item = Self::State>;
    type Options: Default + Clone + Debug;

    fn run(ctx: &RuleContext<Self>) -> Self::Signals;
    fn diagnostic(ctx: &RuleContext<Self>, state: &Self::State) -> Option<RuleDiagnostic> { None }
    fn action(ctx: &RuleContext<Self>, state: &Self::State) -> Option<RuleAction<...>> { None }
}
```

## パターンカタログ

- **Registry パターン** (分類: 振る舞い)
  - 解決する問題: 数百のルールを型安全に管理し、フィルタリング可能にする
  - 適用条件: 同一インターフェースを持つ多数のコンポーネントを動的に有効化/無効化する場面
  - コード例: `crates/biome_analyze/src/registry.rs:99-120`（`RuleRegistry`）
  - 注意点: 型消去（`RuleExecutor` 関数ポインタ）でランタイムコストを最小化している

- **Visitor パターン** (分類: 振る舞い)
  - 解決する問題: 階層構造（Category → Group → Rule）のトラバーサルとフィルタリング
  - 適用条件: ツリー状のデータ構造に対して複数の操作を分離して適用する場面
  - コード例: `crates/biome_analyze/src/registry.rs:39-54`（`RegistryVisitor` trait）
  - 注意点: 各段階でフィルタを挟むことで、不要な子要素の走査をスキップできる

- **Builder パターン** (分類: 生成)
  - 解決する問題: `RuleMetadata` の多数のオプションフィールドを段階的に構築する
  - 適用条件: `const` コンテキストで Builder を使いたい場面
  - コード例: `crates/biome_analyze/src/rule.rs:724-764`（`RuleMetadata::new().recommended(true).fix_kind(...)` チェーン）
  - 注意点: `const fn` Builder にすることで、`static` 定数としてメタデータを定義できる

## Good Patterns

- **const fn Builder でメタデータを静的定数化**: `RuleMetadata` のメソッドチェーン（`.recommended()`, `.fix_kind()`, `.sources()` 等）はすべて `const fn` であり、マクロから `const METADATA: RuleMetadata = RuleMetadata::new(...).recommended(true);` のように静的定数として定義できる。ランタイムコストゼロでメタデータを保持できる。

```rust
// crates/biome_analyze/src/rule.rs:724-764
impl RuleMetadata {
    pub const fn new(version: &'static str, name: &'static str, ...) -> Self { ... }
    pub const fn recommended(mut self, recommended: bool) -> Self { self.recommended = recommended; self }
    pub const fn fix_kind(mut self, kind: FixKind) -> Self { self.fix_kind = kind; self }
}
```

- **空 enum によるゼロサイズ型ルール**: ルール型を `pub enum RuleName {}` と値なし enum で定義し、状態を持たせない。ルールのロジックは `Rule` trait の関連型（`State`, `Signals`）で表現する。これによりルール型自体のメモリコストがゼロになる。

```rust
// crates/biome_analyze/src/rule.rs:924（declare_rule! マクロ内）
$vis enum $id {}  // 値なし enum = ゼロサイズ型
```

- **RuleSource による出自のトレーサビリティ**: 各ルールが ESLint / Clippy / Stylelint 等の既存ルールとの対応関係を `RuleSource` enum で宣言する。`SameLogic` / `Inspired` の区別により、完全互換か着想元かを明示する。ドキュメント生成やマイグレーション支援に活用される。

```rust
// crates/biome_js_analyze/src/lint/suspicious/use_await.rs:60-63
sources: &[
    RuleSource::Eslint("require-await").same(),
    RuleSource::EslintTypeScript("require-await").same(),
],
```

## Anti-Patterns / 注意点

- **ルールオプションに `()` を使う**: Biome では `type Options = ()` は禁止され、空でも生成された Options 構造体を使う必要がある。`()` を使うと `xtask/rules_check` でコンパイル時エラーになる。将来の拡張性を確保するための制約。

```rust
// Bad: xtask/rules_check/src/lib.rs:74-78 でエラーになる
impl Rule for MyRule {
    type Options = ();
}

// Better: codegen が生成する空の Options 構造体を使用
impl Rule for MyRule {
    type Options = MyRuleOptions;
}
```

- **nursery 以外のグループに issue_number を設定する**: `issue_number` は「WIP ルール」を示すフィールドであり、nursery 以外のグループに設定するとエラーになる。安定グループに昇格する際は `issue_number` を除去する必要がある。

```rust
// Bad: xtask/rules_check/src/lib.rs:80-86 でエラーになる
// correctness グループのルールに issue_number を設定
pub MyRule {
    version: "1.5.0",
    name: "myRule",
    issue_number: Some("1234"),  // nursery 以外では不可
}
```

## 導出ルール

- `[MUST]` プラグインやルールの宣言的登録システムを構築する際、メタデータ（名前・バージョン・重要度・推奨フラグ等）を振る舞い実装から分離し、single source of truth として管理する
  - 根拠: Biome は `RuleMeta` trait（メタデータ）と `Rule` trait（振る舞い）を分離し、メタデータから設定スキーマ・ドキュメント・マイグレーションコードを自動生成している（`crates/biome_analyze/src/rule.rs:805-808, 1190-1202`）

- `[MUST]` 新機能にインキュベーション段階（nursery / experimental / unstable）を設け、semver の対象外とすることで、早期リリースと安定性を両立する
  - 根拠: Biome は全新規ルールを `nursery` グループに配置し、安定後にグループ移動する運用を義務化している（`crates/biome_analyze/CONTRIBUTING.md:216`）

- `[SHOULD]` マクロやコード生成を用いてコンポーネントの登録ボイラープレートを排除し、「ファイルを置くだけで登録完了」のワークフローを実現する
  - 根拠: `declare_group_from_fs!` マクロがディレクトリスキャンによりルールを自動発見し、手動登録を不要にしている（`crates/biome_analyze_macros/src/group_macro.rs:67-117`）

- `[SHOULD]` コンポーネントのカテゴリとメタデータの整合性を CI レベルで自動検証する
  - 根拠: `xtask/rules_check` がグループと重要度の組み合わせ制約を静的にチェックし、不整合をコンパイル時に検出する（`xtask/rules_check/src/lib.rs:88-160`）

- `[SHOULD]` 段階的安定化プロセスにおいて、プレースホルダバージョン（`"next"` 等）を使い、リリース時に一括変換するスクリプトを用意する
  - 根拠: `scripts/update-next-version.sh` が `version: "next"` を実際のリリースバージョンに sed で一括置換する（`scripts/update-next-version.sh:1-168`）

- `[AVOID]` ルールシステムで重要度やカテゴリの制約をドキュメントだけで管理すること。CI 自動検証のない制約は必ず形骸化する
  - 根拠: Biome は当初ドキュメントベースだった制約を `xtask/rules_check` の静的チェックに移行し、例外リスト（`// TODO: remove these exceptions in Biome 3.0`）で既存違反を管理している（`xtask/rules_check/src/lib.rs:92-111`）

## 適用チェックリスト

- [ ] プラグイン/ルール/拡張の登録にメタデータ構造体を導入し、振る舞い実装と分離しているか
- [ ] メタデータからドキュメント・設定スキーマ・マイグレーションコードを自動生成しているか（single source of truth）
- [ ] 新機能にインキュベーション段階があり、semver 対象外として管理されているか
- [ ] コンポーネントの登録が「ファイルを追加するだけ」で完了するワークフローになっているか
- [ ] カテゴリとメタデータの整合性を CI で自動検証しているか
- [ ] バージョンフィールドにプレースホルダ（`"next"` 等）を使い、リリース時に一括更新するスクリプトがあるか
- [ ] 階層的フィルタリング（カテゴリ → グループ → 個別）が可能な設計になっているか
