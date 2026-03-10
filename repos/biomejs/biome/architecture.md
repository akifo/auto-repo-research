# architecture

> リポジトリ: biomejs/biome
> 分析日: 2026-03-09

## 概要

Biome は Parser / Formatter / Analyzer (Linter) / CLI / LSP の5層を持つ多言語対応開発ツールチェーンである。94 クレートで構成される大規模 Rust ワークスペースだが、言語ごとに `syntax` / `factory` / `parser` / `formatter` / `analyze` / `semantic` の6クレートパターンを徹底的に反復適用し、言語追加のコストを最小化している。注目すべきは、**言語非依存の共通基盤レイヤー**（biome_rowan, biome_parser, biome_formatter, biome_analyze）が型パラメータで言語を抽象化し、各言語クレートがその具象実装を提供するという「共通 trait + 言語別具象型」のアーキテクチャである。

## 背景にある原則

- **レイヤー間の一方向依存で循環を防ぐ**: `syntax` → `factory` → `parser` → `formatter` / `analyze` → `service` → `cli` / `lsp` という依存方向が厳格に守られている。`syntax` クレートが `parser` に依存しないよう分離されている理由は、lexer と parser の両方が syntax 定義を参照するため（`crates/biome_js_syntax/src/lib.rs:1-4`）。循環依存は Cargo workspace では許容されないため、この分離は構造的に強制される。

- **型パラメータによる言語横断の共通化**: `biome_rowan::Language` trait（`crates/biome_rowan/src/syntax.rs:61`）を起点に、Parser / Formatter / Analyzer の各基盤クレートが `L: Language` で抽象化される。これにより、フォーマットの IR 構築ロジック、lint ルールの実行エンジン、diagnostic 出力など**言語に依存しない処理を1箇所に集約**できる。新言語追加時に触るのは具象型の実装だけになる。

- **コード生成でボイラープレートを排除する**: `.ungram` ファイルから `syntax` / `factory` クレートのコードを自動生成し（`crates/biome_syntax_codegen`、`xtask/codegen`）、AST ノード型・ファクトリ関数・SyntaxKind 列挙型の手書きを不要にしている。formatter のスキャフォールドも `just gen-formatter` で自動生成される。これは「文法定義を唯一の真実の源（Single Source of Truth）とし、派生コードは機械的に生成する」という原則に基づく。

- **Workspace 抽象による CLI / LSP の統合**: `Workspace` trait（`crates/biome_service/src/workspace.rs:1449`）が CLI と LSP の共通インターフェースを提供する。CLI はバッチ処理、LSP はインクリメンタル処理という異なるアクセスパターンを、同一の trait メソッド群（`open_file`, `pull_diagnostics`, `format_file` 等）で統一している。daemon モードではソケット越しに `WorkspaceClient` → `WorkspaceServer` として通信する。

## 実例と分析

### 6クレートパターンの反復適用

各言語（JS, CSS, JSON, GraphQL, HTML, Markdown, YAML, GritQL, Tailwind）に対して、以下の6クレートが機械的に作られる:

| クレート | 役割 | 例 |
|---------|------|-----|
| `biome_{lang}_syntax` | SyntaxKind 列挙、AstNode 定義 | `biome_js_syntax` |
| `biome_{lang}_factory` | ノードファクトリ、TreeBuilder | `biome_js_factory` |
| `biome_{lang}_parser` | Lexer, Parser | `biome_js_parser` |
| `biome_{lang}_formatter` | FormatRule 実装 | `biome_js_formatter` |
| `biome_{lang}_analyze` | Lint/Assist ルール群 | `biome_js_analyze` |
| `biome_{lang}_semantic` | 意味解析（スコープ、型情報等） | `biome_js_semantic` |

この構造は `crates/` ディレクトリに一貫して現れる。新言語を追加する開発者は既存言語のクレート群をテンプレートとしてコピーし、`.ungram` を書いてコード生成を実行すればよい。

### 共通基盤 trait の連鎖

言語横断の共通化は trait の連鎖で実現される:

```rust
// crates/biome_rowan/src/syntax.rs:61
pub trait Language: Sized + Clone + Copy + fmt::Debug + Eq + Ord + std::hash::Hash {
    type Kind: SyntaxKind;
    type Root: AstNode<Language = Self> + Clone + Eq + fmt::Debug;
}
```

この `Language` trait を起点に:

1. **Parser 基盤**: `ParserContext<K: SyntaxKind>` がイベントベースのパーサーフレームワークを提供（`crates/biome_parser/src/lib.rs:39`）
2. **Formatter 基盤**: `FormatLanguage` trait が言語ごとのフォーマットコンテキスト・ルールの型を束縛（`crates/biome_formatter/src/lib.rs:1583`）
3. **Analyzer 基盤**: `Rule` trait の `Query: Queryable` が言語型を持ち、ルール実行エンジンが言語非依存に動作（`crates/biome_analyze/src/rule.rs:1190`）

### Workspace による CLI / LSP 統一

```rust
// crates/biome_service/src/workspace.rs:1449
pub trait Workspace: Send + Sync + RefUnwindSafe {
    fn open_project(&self, params: OpenProjectParams) -> Result<OpenProjectResult, WorkspaceError>;
    fn open_file(&self, params: OpenFileParams) -> Result<OpenFileResult, WorkspaceError>;
    fn pull_diagnostics(&self, params: PullDiagnosticsParams) -> Result<PullDiagnosticsResult, WorkspaceError>;
    // ...
}
```

`WorkspaceServer`（インプロセス実行）と `WorkspaceClient`（daemon 経由のリモート実行）が同一 trait を実装する。CLI の `App` 構造体は `WorkspaceRef` を受け取り、実行モードを意識しない（`crates/biome_service/src/lib.rs:34-58`）。

### file_handlers による Capability ベースのディスパッチ

`ExtensionHandler` trait と `Capabilities` 構造体で、各言語が提供する機能（parse, format, lint, search）を宣言的に定義する（`crates/biome_service/src/file_handlers/mod.rs:512-519, 1065-1070`）。`Features` 構造体がファイル拡張子ごとに適切なハンドラーを選択する。これにより、「CSS にはフォーマッタがあるが semantic analysis はない」といった言語ごとの能力差を安全に表現できる。

### ServiceLanguage trait による設定の型安全な集約

```rust
// crates/biome_service/src/settings.rs:843
pub trait ServiceLanguage: biome_rowan::Language {
    type FormatterSettings: Default;
    type LinterSettings: Default;
    type ParserSettings: Default;
    type FormatOptions: biome_formatter::FormatOptions + Clone + std::fmt::Display + Default;
    // ...
}
```

各言語の設定型（`JsFormatterSettings`, `CssParserOptions` 等）を associated type で束縛し、型安全に言語ごとの設定を管理する。

## パターンカタログ

- **Abstract Factory** (生成)
  - 解決する問題: 言語ごとの AST ノード生成を統一インターフェースで行う
  - 適用条件: 複数の言語が同じ構造（SyntaxNode, SyntaxToken）を共有する場合
  - コード例: `crates/biome_js_factory/src/lib.rs:7` (`JsSyntaxFactory`)、`crates/biome_rowan/src/syntax_factory.rs`
  - 注意点: ファクトリコードはコード生成で自動的に作られるため手書きしない

- **Visitor** (振る舞い)
  - 解決する問題: 構文木走査と各ルールの関心事を分離する
  - 適用条件: 多数のルールが同じ構文木を走査し、それぞれ異なるノードに関心を持つ場合
  - コード例: `crates/biome_analyze/src/visitor.rs:45` (`Visitor` trait)
  - 注意点: `WalkEvent<SyntaxNode>` で Enter/Leave を区別し、スコープ管理等の状態保持が可能

- **Strategy** (振る舞い)
  - 解決する問題: 言語ごとに異なるフォーマット/パース戦略を共通フレームワークに差し込む
  - 適用条件: アルゴリズムの骨格は共通だが、具体的な処理が型ごとに異なる場合
  - コード例: `crates/biome_formatter/src/lib.rs:1583` (`FormatLanguage` trait)

- **Proxy / Remote Proxy** (構造)
  - 解決する問題: daemon プロセスとの通信を透過的に行う
  - 適用条件: 同一インターフェースでインプロセス実行とリモート実行を切り替えたい場合
  - コード例: `crates/biome_service/src/workspace/client.rs:27` (`WorkspaceClient`)

## Good Patterns

- **文法定義からの一貫したコード生成**: `.ungram` ファイルを唯一の真実の源として、SyntaxKind / AstNode / Factory / Formatter スキャフォールドを自動生成する。新しい構文ノードを追加する際は `.ungram` を編集して `just gen-grammar <lang>` を実行するだけでよい。手書きのボイラープレートが不要になり、文法定義と実装の乖離を防ぐ。

```rust
// crates/biome_syntax_codegen/src/lib.rs:29-42
pub struct GrammarOptions {
    pub syntax_dir_path: PathBuf,
    pub factory_dir_path: PathBuf,
    pub syntax_crate_name: String,
    // ungram_file: PathBuf ...
}
```

- **Capability ベースの機能公開**: 各言語ハンドラーが `Capabilities` を返し、対応する機能だけを公開する。存在しない機能の呼び出しは `WorkspaceError::SourceFileNotSupported` として静的に弾かれる（`crates/biome_service/src/workspace.rs:49-52`）。

```rust
// crates/biome_service/src/file_handlers/mod.rs:512-519
pub struct Capabilities {
    pub(crate) parser: ParserCapabilities,
    pub(crate) debug: DebugCapabilities,
    pub(crate) analyzer: AnalyzerCapabilities,
    pub(crate) formatter: FormatterCapabilities,
    pub(crate) search: SearchCapabilities,
    pub(crate) enabled_for_path: EnabledForPath,
}
```

- **declare_lint_rule! マクロによるルール定義の標準化**: ルールのメタデータ（version, name, severity, sources 等）を宣言的に記述し、`RuleMeta` trait 実装を自動導出する。ルール本体は `Rule` trait の `run` / `diagnostic` / `action` メソッドの実装に集中できる（`crates/biome_js_analyze/src/lint/suspicious/no_debugger.rs:12-37`）。

## Anti-Patterns / 注意点

- **言語クレート間の横断的依存**: JS ファイルハンドラーが CSS/GraphQL パーサーをインポートして埋め込みスニペットを処理している（`crates/biome_service/src/file_handlers/javascript.rs:32-41`）。これは言語間の埋め込み（template literal 内の CSS 等）をサポートするためだが、言語クレート間に意図しない結合を生む。Biome はこれを `file_handlers` レイヤーに局所化し、共通基盤レイヤーには持ち込まないことで対処している。

```rust
// Bad: 共通基盤クレートで特定言語に依存する
// biome_formatter/src/lib.rs が biome_js_syntax に依存

// Better: 言語間の結合は service レイヤーに局所化
// crates/biome_service/src/file_handlers/javascript.rs:32
use biome_css_parser::parse_css_with_offset_and_cache;
```

- **Capability の空実装によるデフォルト**: `ExtensionHandler` trait のデフォルト実装は空の `Capabilities` を返す（`crates/biome_service/src/file_handlers/mod.rs:1067-1069`）。新しい言語ハンドラーを追加した際に `capabilities()` のオーバーライドを忘れると、全機能が無効になり、エラーなく動作しないという状態になる。Builder パターンやコンパイル時チェックで強制する方がより安全である。

## 導出ルール

- `[MUST]` 多言語対応ツールチェーンでは、言語非依存の共通基盤と言語固有の実装を trait の型パラメータで分離する
  - 根拠: Biome は `Language` trait を起点に Parser / Formatter / Analyzer の全基盤を言語非依存にし、94 クレートの大半を言語固有コードに集中させている（`biome_rowan/src/syntax.rs:61`）

- `[MUST]` 文法定義（DSL）を唯一の真実の源とし、AST ノード型・ファクトリ・構文種別の列挙型はコード生成で導出する
  - 根拠: Biome は `.ungram` ファイルから syntax / factory クレートを生成し、10 言語分の膨大なボイラープレートを自動化している（`xtask/codegen/`, `crates/biome_syntax_codegen`）

- `[SHOULD]` CLI と LSP で同一の Workspace trait を共有し、バッチ実行とインクリメンタル実行を同一インターフェースで提供する
  - 根拠: `Workspace` trait により CLI (`CliSession`) と LSP (`LSPServer`) が同一の `WorkspaceServer` を利用し、ロジックの重複を排除している（`crates/biome_service/src/workspace.rs:1449`）

- `[SHOULD]` 言語ごとに一貫した N クレート構成（syntax / factory / parser / formatter / analyze / semantic）を採用し、新言語追加をテンプレート化する
  - 根拠: JS / CSS / JSON / GraphQL / HTML / Markdown / YAML / GritQL / Tailwind の全てが同一のクレート分割パターンに従い、開発者が新言語の構造を予測可能にしている

- `[SHOULD]` 各言語が提供する機能を Capability オブジェクトで宣言的に公開し、未対応機能の呼び出しをディスパッチ時に安全にフィルタする
  - 根拠: `Capabilities` 構造体で parser / formatter / analyzer / search の有無を言語ごとに管理し、存在しない機能への呼び出しを `SourceFileNotSupported` エラーで弾いている（`crates/biome_service/src/file_handlers/mod.rs:512`）

- `[AVOID]` 共通基盤クレートから特定の言語クレートへの依存を持つこと。言語間の結合が必要な場合（埋め込みスニペット等）は service レイヤーに局所化する
  - 根拠: Biome は共通基盤（`biome_rowan`, `biome_parser`, `biome_formatter`, `biome_analyze`）を完全に言語非依存に保ち、言語間の結合は `biome_service/file_handlers` に集約している

## 適用チェックリスト

- [ ] プロジェクトに複数の言語/フォーマットを扱うツールがある場合、共通処理を言語非依存 trait で抽象化しているか
- [ ] 文法やスキーマの定義から派生するコード（AST 型、バリデータ、シリアライザ等）をコード生成で自動化しているか
- [ ] CLI と IDE プラグイン（LSP）で同一の処理ロジックを共有する仕組みがあるか（Workspace パターン）
- [ ] 新しい対象（言語、ファイル形式等）を追加する際のクレート/モジュール構成がテンプレート化されているか
- [ ] 各対象が提供する機能（parse, format, lint 等）を Capability として宣言的に管理し、未対応呼び出しを安全に処理しているか
- [ ] 対象間の横断的依存（埋め込みスニペット等）が共通基盤ではなく上位レイヤーに局所化されているか
