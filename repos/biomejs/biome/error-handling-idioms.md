# エラーハンドリングイディオム

> リポジトリ: biomejs/biome
> 分析日: 2026-03-09

## 概要

Biome は大規模な開発者ツールとして、Linter / Formatter / Parser など多数のサブシステムが生成するエラーを統一的に扱う Diagnostics システムを構築している。単なるエラーメッセージではなく、コードフレーム・差分表示・修正提案・ドキュメントリンクを含む「リッチな診断」を設計の中核に据えている点が特徴的。Visitor パターンによる構造化された advice 出力、コンパイル時カテゴリ登録、derive マクロによる宣言的定義など、再利用性の高いプラクティスが多数含まれる。

## 背景にある原則

- **エラーは「状況の説明」であり「修正の提案」を含むべき**: CONTRIBUTING.md で明言されている。単に「何が間違いか」を伝えるだけでなく、「なぜ間違いか」と「どう直すか」を常にセットにすることで、ユーザーがエラーを自力で解決できる確率を最大化する（`crates/biome_diagnostics/CONTRIBUTING.md:18-30`）
- **エラー情報の構造は出力形式から独立させる**: `Diagnostic` trait は出力先を知らない。出力は `Visit` trait を実装した各種 Visitor（ターミナル、GitHub Actions、JSON シリアライズ等）に委ねられる。これにより、エラーの「意味」と「表示」が完全に分離される（`crates/biome_diagnostics/src/advice.rs`, `crates/biome_diagnostics/src/display.rs`, `crates/biome_diagnostics/src/display_github.rs`）
- **エラーカテゴリはコンパイル時に閉じた集合として管理する**: 全カテゴリが `categories.rs` に一元登録され、ビルドスクリプトで静的レジストリを生成する。未登録カテゴリを使うとコンパイルエラーになるため、カテゴリの漏れや打ち間違いがランタイムに到達しない（`crates/biome_diagnostics_categories/build.rs:96-98`）
- **動的ディスパッチのコストを最小化する**: `Error` 型は `Box<Box<dyn Diagnostic>>` による二重間接参照で thin pointer 化し、`Result<T, Error>` を `usize` サイズに収めている。エラーパス以外ではサイズペナルティゼロを達成する（`crates/biome_diagnostics/src/error.rs:1-9`）

## 実例と分析

### Diagnostic trait の宣言的定義

`#[derive(Diagnostic)]` マクロにより、診断型の定義が宣言的になっている。struct 属性でカテゴリ・重大度・メッセージ・タグを指定し、フィールド属性で位置情報・advice を紐付ける。

```rust
// crates/biome_diagnostics/examples/lint.rs:10-27
#[derive(Debug, Diagnostic)]
#[diagnostic(
    category = "lint/style/noShoutyConstants",
    message = "Redundant constant reference",
    tags(FIXABLE)
)]
struct LintDiagnostic {
    #[location(resource)]
    path: String,
    #[location(span)]
    span: TextRange,
    #[location(source_code)]
    source_code: String,
    #[advice]
    advices: LintAdvices,
    #[verbose_advice]
    verbose_advices: LintVerboseAdvices,
}
```

enum に対しても `#[derive(Diagnostic)]` が使え、各バリアントの `Diagnostic` 実装にデリゲートする match 式が自動生成される（`crates/biome_diagnostics_macros/src/generate.rs:267-342`）。

### Visitor パターンによる advice 出力

advice は `Visit` trait の各種 `record_*` メソッドで構造化される。Log、List、CodeFrame、Diff、Backtrace、Command、Group、Table の 8 種類の advice タイプが定義されている。

```rust
// crates/biome_diagnostics/src/advice.rs:23-83
pub trait Visit {
    fn record_log(&mut self, category: LogCategory, text: &dyn fmt::Display) -> io::Result<()>;
    fn record_list(&mut self, list: &[&dyn fmt::Display]) -> io::Result<()>;
    fn record_frame(&mut self, location: Location<'_>) -> io::Result<()>;
    fn record_diff(&mut self, diff: &TextEdit) -> io::Result<()>;
    fn record_backtrace(&mut self, title: &dyn fmt::Display, backtrace: &Backtrace) -> io::Result<()>;
    fn record_command(&mut self, command: &str) -> io::Result<()>;
    fn record_group(&mut self, title: &dyn fmt::Display, advice: &dyn Advices) -> io::Result<()>;
}
```

各メソッドのデフォルト実装は `Ok(())` を返すため、Visitor は関心のある advice タイプだけをオーバーライドすればよい。`CountAdvices`（advice 数を数えるだけの Visitor）や `FrameVisitor`（frame の有無を検出するだけの Visitor）など、用途特化の軽量 Visitor が複数存在する。

### コンパイル時カテゴリ登録

`categories.rs` にカテゴリ文字列とオプションの URL を列挙すると、ビルドスクリプトが `category!` マクロと `FromStr` 実装を生成する。

```rust
// crates/biome_diagnostics_categories/src/categories.rs:15-17 (抜粋)
define_categories! {
    "lint/a11y/noAccessKey": "https://biomejs.dev/linter/rules/no-access-key",
    // ... 数百のカテゴリ
    ;
    "internalError/io",
    "internalError/fs",
    "internalError/panic",
    // ... リンクなしカテゴリ
}
```

未登録カテゴリを使うと `compile_error!` が発火する:

```rust
// crates/biome_diagnostics_categories/build.rs:96-98
( $name:literal ) => {
    compile_error!(concat!("Unregistered diagnostic category \"", $name,
        "\", please add it to \"crates/biome_diagnostics_categories/src/categories.rs\""))
};
```

### Error 型の thin pointer 最適化

`Result<T, Error>` のサイズを最小化するため、`Error` は `Box<Box<dyn Diagnostic>>` で二重 Box 化し thin pointer にしている。テストで `usize` サイズであることを検証している。

```rust
// crates/biome_diagnostics/src/error.rs:24-26
pub struct Error {
    inner: Box<Box<dyn Diagnostic + Send + Sync + 'static>>,
}

// crates/biome_diagnostics/src/error.rs:163-169
#[test]
fn test_error_size() {
    assert_eq!(size_of::<Error>(), size_of::<usize>());
}
#[test]
fn test_result_size() {
    assert_eq!(size_of::<Result<()>>(), size_of::<usize>());
}
```

### コンテキスト付加のチェーン API

`DiagnosticExt` trait により、エラーにファイルパス・スパン・カテゴリ等を後付けで付加できる。各メソッドは元の診断を `source` として保持するラッパー型を返す。

```rust
// crates/biome_diagnostics/src/context.rs:13-56 (抜粋)
pub trait DiagnosticExt: Sized {
    fn context<M>(self, message: M) -> Error;
    fn with_category(self, category: &'static Category) -> Error;
    fn with_file_path(self, path: impl AsResource) -> Error;
    fn with_file_span(self, span: impl AsSpan) -> Error;
    fn with_file_source_code(self, source_code: impl AsSourceCode) -> Error;
    fn with_tags(self, tags: DiagnosticTags) -> Error;
    fn with_severity(self, severity: Severity) -> Error;
}
```

`Result<T, E>` に対しても `Context` trait で同様のチェーンが使える。`anyhow::Context` と似た API だが、リッチなメタデータ（カテゴリ、位置情報、タグ）を型安全に付加できる点が異なる。

### 外部エラー型のアダプタ

`std::io::Error` や `serde_json::Error` など外部のエラー型は、`adapters.rs` でニュータイプラッパーを定義し `Diagnostic` を実装することで統一的に扱う。各アダプタは適切なカテゴリとタグを付与する。

```rust
// crates/biome_diagnostics/src/adapters.rs:51-81
pub struct IoError { error: io::Error }
impl Diagnostic for IoError {
    fn category(&self) -> Option<&'static Category> {
        Some(category!("internalError/io"))
    }
    fn tags(&self) -> crate::DiagnosticTags {
        crate::DiagnosticTags::INTERNAL
    }
    // ...
}
```

### マルチ出力対応

同じ `Diagnostic` データから、ターミナル出力（`PrintDiagnostic`）、GitHub Actions フォーマット（`PrintGitHubDiagnostic`）、JSON シリアライズ（`serde::Diagnostic`）の 3 つの出力形式を生成できる。出力側が `Visit` trait や独自の変換ロジックを持つことで、診断型は出力形式を意識しない。

### ビルダーパターンによる RuleDiagnostic

lint ルールが使う `RuleDiagnostic` はビルダーパターンで構築する。`new()` → `.label()` → `.note()` → `.footer_list()` のようにチェーンし、各メソッドが `self` を消費して返す。

```rust
// crates/biome_analyze/src/rule.rs:1530-1618 (抜粋)
RuleDiagnostic::new(rule_category!(), node.range(), title)
    .note(note)
    .label(span, "This constant is declared here")
    .footer_list("Suggested alternatives:", alternatives)
```

## パターンカタログ

- **Visitor パターン** (分類: 振る舞い)
  - 解決する問題: 診断の内部構造（advice の種類と順序）を、出力形式から分離する
  - 適用条件: 構造化されたデータを複数の異なる方法で処理する必要がある場合
  - コード例: `crates/biome_diagnostics/src/advice.rs:23-83`, `crates/biome_diagnostics/src/display.rs:388-481`
  - 注意点: Visitor メソッドにはデフォルト実装（no-op）を提供し、関心のある操作だけオーバーライドさせる

- **Adapter パターン** (分類: 構造)
  - 解決する問題: 外部ライブラリのエラー型を自前の診断システムに統合する
  - 適用条件: サードパーティのエラー型にカテゴリ・重大度などのメタデータを付与したい場合
  - コード例: `crates/biome_diagnostics/src/adapters.rs:17-81`
  - 注意点: アダプタごとに適切なカテゴリとタグ（`INTERNAL` 等）を明示する

- **Builder パターン** (分類: 生成)
  - 解決する問題: 多数のオプションフィールドを持つ診断オブジェクトの構築を読みやすくする
  - 適用条件: 診断ごとに異なるメタデータの組み合わせが必要な場合
  - コード例: `crates/biome_analyze/src/rule.rs:1530-1618`, `crates/biome_deserialize/src/diagnostics.rs:95-229`
  - 注意点: 各チェーンメソッドは `self` を消費して返す（所有権移動型ビルダー）

## Good Patterns

- **Sealed trait による拡張制限**: `DiagnosticExt` と `Context` trait は private モジュール内の `Sealed` trait を継承し、外部クレートでの実装を防止する。これにより API の安定性が保証される。

```rust
// crates/biome_diagnostics/src/context.rs:244-271
mod internal {
    pub trait Sealed {}
    // ...
}
pub trait DiagnosticExt: internal::Sealed + Sized { ... }
```

- **message と description の二重定義**: `MessageAndDescription` 型により、リッチマークアップ（ターミナル等）とプレーンテキスト（エディタポップオーバー等）の両方を一つのフィールドで扱う。`MarkupBuf` から `String` への変換は自動で行われる。

```rust
// crates/biome_diagnostics/src/display/message.rs:21-27
pub struct MessageAndDescription {
    message: MarkupBuf,
    description: String,
}
```

- **コンパイル時カテゴリ検証**: `category!("lint/style/noShoutyConstants")` は未登録ならコンパイルエラーになる。ランタイム検証よりはるかに安全で、打ち間違いがデプロイに到達しない。

- **prelude モジュールによるトレイト匿名インポート**: `use biome_diagnostics::prelude::*` で trait を匿名インポートし、メソッドを使えるようにしつつ名前空間の汚染を防ぐ。

```rust
// crates/biome_diagnostics/src/lib.rs:55-63
pub mod prelude {
    pub use crate::advice::{Advices as _, Visit as _};
    pub use crate::context::{Context as _, DiagnosticExt as _};
    pub use crate::diagnostic::Diagnostic as _;
}
```

## Anti-Patterns / 注意点

- **エラーメッセージだけ返して文脈情報を省略する**: Biome の設計では、エラーは常にカテゴリ・位置情報・advice を伴うべき。文字列だけを返す `Err("something went wrong".into())` は、ユーザーが問題を特定・修正できない。

```rust
// Bad: 文脈なしのエラー
return Err("Parse error".into());

// Better: カテゴリ・位置・advice 付きの診断
return Err(ParseDiagnostic::new(span, source_code)
    .with_category(category!("parse"))
    .into());
```

- **動的文字列によるカテゴリ指定**: カテゴリを実行時の文字列として扱うと、打ち間違いがランタイムまで検出されない。Biome はこれを `category!` マクロによるコンパイル時検証で排除している。

```rust
// Bad: ランタイムに失敗しうる
let cat = Category::from_str("lint/stlye/noShoutyConstants"); // typo

// Better: コンパイル時に検証される
let cat = category!("lint/style/noShoutyConstants");
```

- **trait object の fat pointer をそのまま使う**: `Box<dyn Diagnostic>` は 16 バイト（64bit 環境）であり、`Result<(), Box<dyn Diagnostic>>` は 16 バイトになる。Biome は `Box<Box<dyn Diagnostic>>` で thin pointer 化し、`Result<(), Error>` を 8 バイトに収めている。ホットパスで `Result` を頻繁に返す場合はサイズを意識すべき。

## 導出ルール

- `[MUST]` エラー型には「カテゴリ」「重大度」「位置情報」を構造化フィールドとして持たせ、文字列メッセージだけに頼らない
  - 根拠: Biome の `Diagnostic` trait は category, severity, location, message, advices を独立したメソッドとして要求し、出力形式に依存しない構造化を強制している（`crates/biome_diagnostics/src/diagnostic.rs:34-114`）
- `[MUST]` エラーコード（カテゴリ）は静的レジストリで一元管理し、コンパイル時または起動時に検証する
  - 根拠: Biome は `categories.rs` + ビルドスクリプト + `category!` マクロでコンパイル時検証を実現し、未登録カテゴリの使用をコンパイルエラーにしている（`crates/biome_diagnostics_categories/build.rs:92-101`）
- `[SHOULD]` エラーの「意味」と「表示」を分離し、Visitor パターン等で複数の出力形式に対応する
  - 根拠: Biome は同じ `Diagnostic` データからターミナル・GitHub Actions・JSON の 3 形式を生成しており、出力形式の追加がデータ層に影響しない設計になっている（`crates/biome_diagnostics/src/display.rs`, `display_github.rs`, `serde.rs`）
- `[SHOULD]` ホットパスで返す `Result` の `Err` 型は、thin pointer 化や `NonZero` 最適化でサイズを最小化する
  - 根拠: Biome は `Box<Box<dyn Diagnostic>>` で `Error` を `usize` サイズに収め、テストでサイズ不変条件を検証している（`crates/biome_diagnostics/src/error.rs:163-169`）
- `[SHOULD]` エラーにはユーザーが問題を修正するための具体的な情報（コードフレーム、差分、推奨コマンド等）を付加する
  - 根拠: CONTRIBUTING.md で「diagnostic should try to provide a way for the user to fix the issue」と明記されており、advice 設計全体がこの原則に基づいている（`crates/biome_diagnostics/CONTRIBUTING.md:22-30`）
- `[AVOID]` 外部ライブラリのエラー型をそのまま伝播させる（自前のエラー型でラップし、カテゴリやコンテキスト情報を付与すべき）
  - 根拠: Biome は `IoError`, `SerdeJsonError` 等のアダプタ型で外部エラーをラップし、カテゴリ（`internalError/io` 等）とタグ（`INTERNAL`）を付与している（`crates/biome_diagnostics/src/adapters.rs:50-81`）

## 適用チェックリスト

- [ ] プロジェクトのエラー型がカテゴリ・重大度・位置情報を構造化フィールドとして持っているか
- [ ] エラーコード/カテゴリの一覧が一元管理され、追加時にコンパイル時または起動時に検証されるか
- [ ] エラーの構造（データ）と出力形式（表示）が分離されているか
- [ ] ユーザー向けエラーに「なぜ問題か」と「どう直すか」の情報が含まれているか
- [ ] 外部ライブラリのエラーを自前のエラー型でラップし、コンテキスト情報を付加しているか
- [ ] `Result` 型のサイズがホットパスで問題にならないか検証しているか
- [ ] derive マクロやビルダーパターンで、診断型の定義が宣言的・読みやすくなっているか
