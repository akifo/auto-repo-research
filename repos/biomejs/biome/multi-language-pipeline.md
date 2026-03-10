# 多言語パイプライン設計

> リポジトリ: biomejs/biome
> 分析日: 2026-03-09

## 概要

Biome は JS/TS/CSS/JSON/GraphQL/HTML/Markdown/YAML の 8 言語を単一コードベースで解析・フォーマット・リントする。各言語は `parser/syntax/factory/formatter/analyze/semantic` の 6 クレートパターンで構成され、共通フレームワーク（`biome_parser`, `biome_formatter`, `biome_analyze`）がパイプライン全体を言語非依存に駆動する。この設計は「新言語追加時にフレームワークコードに一切触れず、型パラメータの実装だけで全機能が動く」ことを実現しており、多言語ツールチェーンの設計パターンとして注目に値する。

## 背景にある原則

- **型パラメータによる多態性（Type-Parameterized Polymorphism）**: 言語固有ロジックをトレイトの型パラメータで抽象化し、共通フレームワークがジェネリック関数として全言語を駆動する。ランタイムディスパッチではなく静的ディスパッチを使うことで、パフォーマンスと型安全性を両立する。根拠: `FormatLanguage` トレイト（`biome_formatter/src/lib.rs:1583`）は `SyntaxLanguage`, `Context`, `FormatRule` の 3 つの関連型で言語を抽象化し、`format_node<L: FormatLanguage>()` が全言語のフォーマットを実行する。

- **Grammar-Driven Code Generation（文法駆動コード生成）**: 各言語の AST ノード・SyntaxKind・ファクトリを `.ungram` ファイルから自動生成する。手書きのボイラープレートを排除し、文法変更を単一ファイルに集約する。根拠: `xtask/codegen/` に 9 言語分の `.ungram` ファイルが存在し、`biome_syntax_codegen` クレートが `LanguageSrc` トレイトを通じて各言語の syntax/factory クレートを生成する。

- **Capabilities-Based Dispatch（能力ベースディスパッチ）**: サービス層が言語ごとの「できること」を関数ポインタの有無で表現し、統一インターフェースで操作する。全言語が同じ Workspace API を通過するが、未実装の機能は `None` として安全にスキップされる。根拠: `Capabilities` 構造体（`biome_service/src/file_handlers/mod.rs:512`）が `parser`, `analyzer`, `formatter`, `search` 各フィールドを `Option<fn(...)>` で保持する。

- **Lossless Syntax Tree（ロスレス構文木）**: `biome_rowan` が全言語共通のロスレス CST を提供し、コメント・空白を含む完全な往復変換を保証する。これにより、フォーマッタが元のトリビアを保持しつつ再配置でき、リンタが正確なスパン情報で診断を出せる。根拠: `biome_rowan/src/lib.rs` の `Language` トレイトと `SyntaxKind` トレイト。

## 実例と分析

### 6 クレートパターンの構成

各言語は以下の 6 クレートで構成される（CSS の例）:

| クレート | 役割 | 共通フレームワークとの関係 |
|---|---|---|
| `biome_css_syntax` | SyntaxKind, Language 型, AST ノード定義 | `biome_rowan::Language` を実装 |
| `biome_css_factory` | AST ノードのビルダー | codegen で自動生成 |
| `biome_css_parser` | 字句解析・構文解析 | `biome_parser::Parser` トレイトを実装 |
| `biome_css_formatter` | フォーマットルール | `biome_formatter::FormatLanguage` を実装 |
| `biome_css_analyze` | リントルール | `biome_analyze::Rule` トレイトを実装 |
| `biome_css_semantic` | 意味解析モデル | `biome_analyze::ServiceBag` に提供 |

この構成は JS, JSON, GraphQL, HTML, Markdown, YAML, Grit, Tailwind すべてで同一パターンを踏襲している。

### パーサーフレームワークのトレイト階層

パーサーフレームワーク（`biome_parser`）は 3 層のトレイト階層で構成される:

1. **`Lexer<'src>`** — トークン生成の最小インターフェース（`current()`, `next_token()`, `position()`）
2. **`TokenSource`** — 字句ストリームの抽象化（`current()`, `bump()`, `has_preceding_line_break()`）
3. **`Parser`** — 構文解析の共通メソッド群（`bump()`, `eat()`, `expect()`, `start()`, `error()`）

各言語のパーサーは `Parser` トレイトを実装し、関連型 `Kind` と `Source` で言語固有の `SyntaxKind` と `TokenSource` を指定する。

### フォーマッタフレームワークの委譲構造

`format_node<L: FormatLanguage>()` が全言語のエントリポイントとなり、以下のパイプラインを実行する:

1. `language.transform(root)` — 言語固有の前処理（JS のみ実装、他言語は `None` を返す）
2. `language.create_context()` — 言語固有のフォーマットコンテキスト生成
3. IR（`FormatElement`）への変換 — 言語固有の `FormatRule` が各ノードを IR に変換
4. `Printer` による出力 — 言語非依存の共通プリンタ

各言語は同じ IR（`FormatElement`）に変換するため、`Printer` は言語を意識しない。

### アナライザーフレームワークのルール登録

`biome_analyze` の `Rule` トレイトは `Query`, `State`, `Signals`, `Options` の 4 つの関連型で構成される。各言語は `declare_lint_rule!` マクロでルールを宣言し、`run()` と `diagnostic()` を実装するだけで共通のアナライザーパイプラインに組み込まれる。

### サービス層の統合

`biome_service` の `Features` 構造体が全言語のハンドラを保持し、`DocumentFileSource` enum のマッチングで適切なハンドラにディスパッチする。`Workspace` トレイトが CLI/LSP 両方に言語非依存な API を提供する。

## コード例

```rust
// crates/biome_formatter/src/lib.rs:1583-1622
// FormatLanguage トレイト — 各言語がこれを実装するだけでフォーマッタが動く
pub trait FormatLanguage {
    type SyntaxLanguage: Language;
    type Context: CstFormatContext<Language = Self::SyntaxLanguage>;
    type FormatRule: FormatRule<SyntaxNode<Self::SyntaxLanguage>, Context = Self::Context> + Default;

    fn transform(
        &self,
        _root: &SyntaxNode<Self::SyntaxLanguage>,
    ) -> Option<(SyntaxNode<Self::SyntaxLanguage>, TransformSourceMap)> {
        None
    }

    fn is_range_formatting_node(&self, _node: &SyntaxNode<Self::SyntaxLanguage>) -> bool {
        true
    }

    fn options(&self) -> &<Self::Context as FormatContext>::Options;

    fn create_context(
        self,
        root: &SyntaxNode<Self::SyntaxLanguage>,
        source_map: Option<TransformSourceMap>,
        delegate_fmt_embedded_nodes: bool,
    ) -> Self::Context;
}
```

```rust
// crates/biome_parser/src/lib.rs:150-165
// Parser トレイト — 全言語共通のパーサーインターフェース
pub trait Parser: Sized {
    type Kind: SyntaxKind;
    type Source: TokenSource<Kind = Self::Kind>;

    fn context(&self) -> &ParserContext<Self::Kind>;
    fn context_mut(&mut self) -> &mut ParserContext<Self::Kind>;
    fn source(&self) -> &Self::Source;
    fn source_mut(&mut self) -> &mut Self::Source;

    fn is_speculative_parsing(&self) -> bool {
        false
    }
    // ... 50+ 共通メソッド（bump, eat, expect, start, error 等）
}
```

```rust
// crates/biome_service/src/file_handlers/mod.rs:512-519
// Capabilities 構造体 — 言語ごとの機能を関数ポインタの有無で表現
pub struct Capabilities {
    pub(crate) parser: ParserCapabilities,
    pub(crate) debug: DebugCapabilities,
    pub(crate) analyzer: AnalyzerCapabilities,
    pub(crate) formatter: FormatterCapabilities,
    pub(crate) search: SearchCapabilities,
    pub(crate) enabled_for_path: EnabledForPath,
}
```

```rust
// crates/biome_service/src/file_handlers/mod.rs:1107-1125
// DocumentFileSource による言語ディスパッチ
pub(crate) fn get_capabilities(&self, language_hint: DocumentFileSource) -> Capabilities {
    match language_hint {
        DocumentFileSource::Js(source) => match source.as_embedding_kind() {
            EmbeddingKind::Astro { .. } => self.astro.capabilities(),
            EmbeddingKind::Vue { .. } => self.vue.capabilities(),
            EmbeddingKind::Svelte { .. } => self.svelte.capabilities(),
            EmbeddingKind::None => self.js.capabilities(),
        },
        DocumentFileSource::Json(_) => self.json.capabilities(),
        DocumentFileSource::Css(_) => self.css.capabilities(),
        DocumentFileSource::Graphql(_) => self.graphql.capabilities(),
        DocumentFileSource::Html(_) => self.html.capabilities(),
        DocumentFileSource::Grit(_) => self.grit.capabilities(),
        DocumentFileSource::Markdown(_) => self.markdown.capabilities(),
        DocumentFileSource::Ignore => self.ignore.capabilities(),
        DocumentFileSource::Unknown => self.unknown.capabilities(),
    }
}
```

```rust
// crates/biome_yaml_formatter/src/lib.rs:350-355
// 言語固有の format_node は共通関数への薄いラッパー
pub fn format_node(
    options: YamlFormatOptions,
    root: &YamlSyntaxNode,
) -> FormatResult<Formatted<YamlFormatContext>> {
    biome_formatter::format_node(root, YamlFormatLanguage::new(options), false)
}
```

## パターンカタログ

- **Abstract Factory** (分類: 生成)
  - 解決する問題: 各言語の構文ノードを統一的に生成する
  - 適用条件: 複数の言語/バリアントに対して同構造のオブジェクト群が必要な場合
  - コード例: `biome_syntax_codegen` が `LanguageSrc` トレイトを通じて各言語の factory クレートを生成
  - 注意点: codegen の入力文法（`.ungram`）の設計が品質を左右する

- **Template Method** (分類: 振る舞い)
  - 解決する問題: パイプラインの全体フローを固定し、言語固有のステップだけをオーバーライド可能にする
  - 適用条件: 処理フローが共通で、個別ステップだけが異なる場合
  - コード例: `format_node<L>()` が transform → create_context → format → print のフローを固定。`FormatLanguage::transform()` はデフォルト実装 `None` で JS のみオーバーライド
  - 注意点: デフォルト実装を「何もしない」にすることで、新言語追加時の実装負荷を最小化

- **Strategy** (分類: 振る舞い)
  - 解決する問題: 同一アルゴリズムフレームワーク内で言語固有の判断ロジックを差し替える
  - 適用条件: アルゴリズムの骨格は同じだが、言語ごとに判定基準が異なる場合
  - コード例: `FormatLanguage::is_range_formatting_node()` — CSS は特定ノード種別をチェック、JSON は `AnyJsonValue` をチェック、GraphQL は常に `true`

## Good Patterns

- **関連型（Associated Types）で型安全な言語パラメータ化**: `FormatLanguage` の `SyntaxLanguage`, `Context`, `FormatRule` は互いに整合性が型レベルで保証される。`Context` の `Language` が `SyntaxLanguage` と一致しなければコンパイルエラーになるため、言語間の型の取り違えがあり得ない。

```rust
// crates/biome_formatter/src/lib.rs:1583-1590
pub trait FormatLanguage {
    type SyntaxLanguage: Language;
    type Context: CstFormatContext<Language = Self::SyntaxLanguage>;
    type FormatRule: FormatRule<SyntaxNode<Self::SyntaxLanguage>, Context = Self::Context> + Default;
}
```

- **`ParsedSyntax` による Absent/Present の明示**: パーサーの返り値を `Option` ではなく専用の `#[must_use]` enum にすることで、「構文が存在しなかった」ケースの処理漏れをコンパイル時に検出する。

```rust
// crates/biome_parser/src/parsed_syntax.rs:30-38
#[must_use = "this `ParsedSyntax` may be an `Absent` variant, which should be handled"]
pub enum ParsedSyntax {
    Absent,
    Present(CompletedMarker),
}
```

- **`ParserProgress` による無限ループ防止**: パーサーのループ内で進捗をアサートし、パーサーが同じ位置で停滞した場合にパニックする。全言語のリストパース（`ParseNodeList::parse_list`）で使われている。

```rust
// crates/biome_parser/src/lib.rs:556-568
pub fn assert_progressing<P>(&mut self, p: &P)
where
    P: Parser,
{
    assert!(
        self.has_progressed(p),
        "The parser is no longer progressing. Stuck at '{}' {:?}:{:?}",
        p.cur_text(), p.cur(), p.cur_range(),
    );
}
```

- **Capabilities の Option パターンによる段階的言語サポート**: 新言語はまず `parse` だけを `Some(...)` にして構文解析のみ対応し、後から `formatter`, `analyzer` を追加できる。未実装の機能は型安全に `None` として表現される。

```rust
// crates/biome_service/src/file_handlers/css.rs:360-398
fn capabilities(&self) -> Capabilities {
    Capabilities {
        parser: ParserCapabilities { parse: Some(parse), .. },
        analyzer: AnalyzerCapabilities { lint: Some(lint), code_actions: Some(code_actions), .. },
        formatter: FormatterCapabilities { format: Some(format), .. },
        // ...
    }
}
```

## Anti-Patterns / 注意点

- **Capabilities の関数ポインタ型が冗長**: `Parse`, `Lint`, `Format` 等が型エイリアスとして定義されているが、シグネチャが長く複雑で、変更時の影響範囲が大きい。トレイトオブジェクトにすれば個別のメソッドシグネチャ変更が容易になるが、パフォーマンスとのトレードオフがある。

```rust
// Bad: 関数ポインタの型エイリアスが長大
type Parse =
    fn(&BiomePath, DocumentFileSource, &str, &SettingsWithEditor, &mut NodeCache) -> ParseResult;
```

```rust
// Better: トレイトオブジェクト化（パフォーマンスが許容される場合）
trait LanguageParser {
    fn parse(&self, path: &BiomePath, source: &str, ...) -> ParseResult;
}
```

- **DocumentFileSource の match 文が新言語追加時に散在**: `DocumentFileSource` enum に新バリアントを追加すると、`get_capabilities`, `try_from_extension`, `try_from_language_id` 等の複数箇所を更新する必要がある。exhaustive match により漏れは検出されるが、変更箇所の多さは認知負荷を高める。

## 導出ルール

- `[MUST]` 多言語パイプラインでは、共通フレームワーク（フォーマッタ・リンタ・パーサー）を言語非依存なジェネリック関数として実装し、言語固有ロジックはトレイトの関連型で注入する
  - 根拠: Biome の `format_node<L: FormatLanguage>()` は 9 言語に対して単一実装で動作し、共通バグ修正が全言語に即座に波及する

- `[MUST]` パーサーのループ処理には進捗チェック（現在位置の前進を検証するアサーション）を必ず組み込む
  - 根拠: `ParserProgress::assert_progressing()` が `ParseNodeList::parse_list()` の全言語で使われており、無限ループによるハングアップを防止している（`biome_parser/src/lib.rs:576`）

- `[SHOULD]` 新バリアント（言語・フォーマット等）を追加可能な設計では、機能の有無を `Option<fn(...)>` や `Option<Box<dyn Trait>>` で表現し、段階的な機能追加を可能にする
  - 根拠: Biome の `Capabilities` 構造体は各言語が対応する機能だけを `Some(...)` で宣言し、未対応機能は型安全に `None` としてスキップされる

- `[SHOULD]` 複数の言語やバリアントで同構造のボイラープレートが生じる場合、文法定義ファイルからのコード生成で一貫性を保つ
  - 根拠: 9 つの `.ungram` ファイルから syntax/factory クレートが自動生成され、手動定義によるノード名の不整合やメソッド漏れを根絶している

- `[SHOULD]` パーサーの「構文が見つからなかった」状態を `Option::None` ではなく `#[must_use]` 付きの専用型で表現し、ハンドリング漏れをコンパイル時に検出する
  - 根拠: `ParsedSyntax` enum の `Absent` バリアントは `#[must_use]` により未処理時に警告が出る（`biome_parser/src/parsed_syntax.rs:30`）

- `[AVOID]` フレームワークのパイプラインステップにデフォルト実装なしの必須メソッドを多数定義する — 新言語追加時の初期実装コストが高くなる
  - 根拠: `FormatLanguage::transform()` は `None` を返すデフォルト実装を持ち、9 言語中 JS のみがオーバーライドしている。デフォルトがなければ 8 言語で空実装を書く必要があった

## 適用チェックリスト

- [ ] 共通パイプラインのステップ（parse → analyze → format → output）をジェネリック関数として実装しているか
- [ ] 言語固有ロジックはトレイトの関連型で注入し、ランタイムダウンキャストを避けているか
- [ ] パーサーのループ処理に進捗チェック（無限ループ防止）が組み込まれているか
- [ ] 新バリアント追加時の作業リストが明確か（exhaustive match による漏れ検出があるか）
- [ ] ボイラープレートコードを文法定義やスキーマから自動生成しているか
- [ ] 共通フレームワークのトレイトメソッドに適切なデフォルト実装があり、新言語の最小実装コストが低いか
- [ ] 段階的な機能追加を可能にする `Option` ベースの能力宣言パターンを採用しているか
