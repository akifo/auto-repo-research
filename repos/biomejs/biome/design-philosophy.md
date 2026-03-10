# design-philosophy

> リポジトリ: biomejs/biome
> 分析日: 2026-03-09

## 概要

Biome は Prettier/ESLint を Rust で再実装し、フォーマッタ・リンター・パーサーを単一ツールチェーンに統合したプロジェクトである。この視点では、なぜ Rust を選んだのか、なぜ Prettier 互換を 97% で止めているのか、なぜ ESLint プラグインシステムを捨てたのか、ゼロ依存バイナリ配布をどう実現しているかなど、技術選定の根拠と設計思想を横断的に分析する。Rome からの fork という経緯を持ちながら、明確な設計原則に基づいて独自の進化を遂げている点が注目に値する。

## 背景にある原則

- **統一ツールチェーン原則**: 別々のツール（Prettier + ESLint + パーサー）を統合することで、共通の AST・設定・エラー表示・並列処理基盤を共有できる。ツール間の不整合（フォーマッタとリンターの競合）を構造的に排除し、ユーザーの設定負荷を下げるべき。根拠: README の "unifies functionalities that have previously been separate tools. Building upon a shared base allows us to provide a cohesive experience" という宣言と、94 クレートが `biome_rowan` を共通基盤として共有している実装。

- **パフォーマンスは機能である**: 開発者ツールの遅延はフィードバックループを壊す。ネイティブ言語（Rust）で書くことで、JS ランタイムのオーバーヘッドを排除し、エディタ内でリアルタイムに動作する速度を確保すべき。根拠: プラットフォーム別アロケータ選択（jemalloc / mimalloc / System）をコンパイル時に行い、WASM ビルドでもブラウザ対応する設計 (`crates/biome_cli/src/main.rs:20-33`)。

- **互換性は手段であり目的ではない**: 既存ツール（Prettier / ESLint）との互換は移行コストを下げるための手段であり、100% 互換を目指すのではなく「97% 互換 + 独自の改善」という戦略を取るべき。根拠: `RuleSource` enum で元ルールとの関係を `SameLogic` / `Inspired` で明示的に区別し、独自改善を許容している (`crates/biome_analyze/src/rule.rs:100-532`)。

- **段階的導入（Nursery パターン）**: 新機能は nursery 段階で出荷し、安定版リリースでは `BIOME_VERSION` 環境変数でコンパイル時に切り替える。壊れる変更を semver で厳密に管理しつつ、実験的機能を早期にユーザーへ届けるべき。根拠: `crates/biome_flags/src/lib.rs:17` の `option_env!("BIOME_VERSION")` と、CONTRIBUTING.md の nursery ルールは `main` ブランチ、新機能は `next` ブランチという分岐戦略。

## 実例と分析

### Rust 選択とプラットフォーム最適化

Biome は「Node.js を必要としない」ことを明示的な設計目標としている。CLI バイナリは Rust で書かれ、OS/アーキテクチャごとに最適なメモリアロケータをコンパイル時に選択する。

```rust
// crates/biome_cli/src/main.rs:20-33
#[cfg(target_os = "windows")]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[cfg(all(
    any(target_os = "macos", target_os = "linux"),
    not(target_env = "musl")
))]
#[global_allocator]
static GLOBAL: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

// Jemallocator does not work on aarch64 with musl, so we'll use the system allocator instead
#[cfg(all(target_env = "musl", target_os = "linux", target_arch = "aarch64"))]
#[global_allocator]
static GLOBAL: std::alloc::System = std::alloc::System;
```

単に「Rust が速い」ではなく、プラットフォームごとのアロケータ特性まで考慮した最適化を行っている。

### npm optional dependencies によるネイティブバイナリ配布

Node.js 不要を実現しつつ、npm エコシステムの利便性を維持するために、`optionalDependencies` パターンを採用している。メインパッケージ `@biomejs/biome` はプラットフォーム別バイナリパッケージを optional dependency として宣言し、薄い Node.js ラッパースクリプトで適切なバイナリを選択・実行する。

```json
// packages/@biomejs/biome/package.json:48-57
"optionalDependencies": {
    "@biomejs/cli-win32-x64": "2.4.6",
    "@biomejs/cli-darwin-x64": "2.4.6",
    "@biomejs/cli-darwin-arm64": "2.4.6",
    "@biomejs/cli-linux-x64": "2.4.6",
    "@biomejs/cli-linux-arm64": "2.4.6",
    "@biomejs/cli-linux-x64-musl": "2.4.6",
    "@biomejs/cli-linux-arm64-musl": "2.4.6"
}
```

各プラットフォームパッケージは `os` と `cpu` フィールドで制約し、npm が自動的に対象プラットフォームのみインストールする（`packages/@biomejs/cli-darwin-arm64/package.json:14-19`）。

### lossless CST (biome_rowan) による言語横断基盤

biome_rowan は rust-analyzer の rowan ライブラリの fork で、全言語共通の Concrete Syntax Tree 基盤を提供する。`Language` トレイトという最小インターフェースを通じて、JS / CSS / JSON / GraphQL / HTML / YAML / Markdown / Tailwind と 11 言語の CST が同一の型システム上に構築されている。

```rust
// crates/biome_rowan/src/syntax.rs:61-64
pub trait Language: Sized + Clone + Copy + fmt::Debug + Eq + Ord + std::hash::Hash {
    type Kind: SyntaxKind;
    type Root: AstNode<Language = Self> + Clone + Eq + fmt::Debug;
}
```

これにより、フォーマッタ・リンター・パーサーが言語を問わず同じ走査・変換インフラを使える。

### 言語別クレート分割パターン

各言語は `biome_{lang}_syntax` / `biome_{lang}_parser` / `biome_{lang}_formatter` / `biome_{lang}_analyze` / `biome_{lang}_factory` という 5 クレート構成で実装されている。94 クレートという巨大ワークスペースだが、各クレートの責務は明確に分離されており、コンパイルの並列化と依存グラフの最小化が実現されている。

### declare_lint_rule! マクロによるルール定義の標準化

リンタールールはマクロで宣言的に定義される。バージョン、名前、元ルールとの関係（`RuleSource`）、推奨度、重大度がメタデータとして構造化されている。

```rust
// crates/biome_js_analyze/src/lint/suspicious/no_debugger.rs:12-37
declare_lint_rule! {
    /// Disallow the use of `debugger`
    pub NoDebugger {
        version: "1.0.0",
        name: "noDebugger",
        language: "js",
        sources: &[RuleSource::Eslint("no-debugger").same()],
        recommended: true,
        severity: Severity::Error,
        fix_kind: FixKind::Unsafe,
    }
}
```

`RuleSource` で ESLint ルールとの対応を明示しつつ、`SameLogic` / `Inspired` でどの程度忠実な再実装かを区別する設計が、互換性と独自進化の両立を支えている。

### コードジェネレーションの広範な活用

ungrammar DSL から構文ノード型・ファクトリ・フォーマッタのボイラープレートを自動生成する。`just gen-grammar` / `just gen-formatter` / `just gen-rules` / `just gen-configuration` とコンテキストに応じたコードジェネレーションコマンドが用意されており、手書きコードと生成コードの境界が明確に管理されている。

### Workspace 抽象による daemon / CLI 統一

`Workspace` トレイトにより、CLI の daemonless モードと LSP daemon モードが同一のインターフェースで動作する。`WorkspaceServer`（状態を自前で保持）と `WorkspaceClient`（daemon と通信）の 2 実装を切り替えるだけで、全機能がどちらのモードでも利用可能になる（`crates/biome_service/CONTRIBUTING.md`）。

## パターンカタログ

- **Strategy パターン** (振る舞い)
  - 解決する問題: プラットフォームごとに異なるアロケータ選択
  - 適用条件: コンパイル時に決定可能なプラットフォーム差異がある場合
  - コード例: `crates/biome_cli/src/main.rs:20-33`（`#[cfg]` による静的ディスパッチ）
  - 注意点: 条件付きコンパイルは Strategy パターンのコンパイル時バリアントであり、ランタイムオーバーヘッドがゼロ

- **Visitor パターン** (振る舞い)
  - 解決する問題: 多様な AST ノードに対する走査と解析の分離
  - 適用条件: 構文木を走査して各ノードで異なる処理を行う必要がある場合
  - コード例: `crates/biome_analyze/src/rule.rs:1190-1212`（`Rule` トレイトの `run` / `diagnostic` / `action`）
  - 注意点: Rust ではトレイトベースの Visitor が自然であり、ダブルディスパッチは不要

- **Bridge パターン** (構造)
  - 解決する問題: 抽象（`Workspace` トレイト）と実装（Server / Client）の分離
  - 適用条件: 同一 API を異なる通信チャネルで提供する必要がある場合
  - コード例: `crates/biome_service/src/workspace.rs`（`WorkspaceServer` / `WorkspaceClient`）

## Good Patterns

- **npm optional dependencies によるネイティブバイナリ配布**: メインパッケージは薄い JS ラッパーのみ含み、プラットフォーム別バイナリを optional dependency として配布する。npm の `os` / `cpu` フィールドで自動選択されるため、ユーザーは `npm install` するだけでネイティブバイナリが使える。WASM フォールバックも別パッケージで提供。

```json
// packages/@biomejs/cli-darwin-arm64/package.json
{ "os": ["darwin"], "cpu": ["arm64"] }
```

- **コンパイル時フィーチャーフラグによるリリース制御**: `BIOME_VERSION` 環境変数でビルド時に nursery ルールの推奨状態を切り替える。開発ビルド (`0.0.0`) では全ルールが有効、リリースビルドでは安定ルールのみ推奨される。ランタイムオーバーヘッドなしで段階的リリースを実現する。

```rust
// crates/biome_flags/src/lib.rs:17
pub static BIOME_VERSION: LazyLock<Option<&str>> = LazyLock::new(|| option_env!("BIOME_VERSION"));
```

- **RuleSource による互換性トレーサビリティ**: 各ルールが元ツール（ESLint / typescript-eslint / Clippy 等）との関係を `SameLogic` か `Inspired` で明示する。これにより移行ガイドの自動生成やカバレッジ測定が可能になる。

```rust
// crates/biome_analyze/src/rule.rs:526-532
pub enum RuleSourceKind {
    #[default]
    SameLogic,
    Inspired,
}
```

## Anti-Patterns / 注意点

- **「100% 互換」への過度な追求**: Prettier との 100% 互換を目指すと、Prettier の設計上の制約やバグまで再現することになる。Biome は意図的に 97% 互換に留め、独自の改善余地を確保している。互換ツールを作る際は、互換度の上限を設計時に決定し、逸脱する箇所をドキュメント化すべき。

```
// Bad: 元ツールのバグも忠実に再現する
fn format_node() { /* Prettier bug #1234 と同じ出力を再現 */ }

// Better: 明示的に逸脱を宣言し改善する
// Biome の方針: RuleSourceKind::Inspired で「元ルールから着想を得たが独自改善あり」と明示
```

- **過度なモノリス化**: 統合ツールチェーンは便利だが、94 クレートのワークスペースは新規コントリビュータの参入障壁になりうる。Biome はクレートの命名規約（`biome_{lang}_{role}`）と各クレートの CONTRIBUTING.md で対処している。統合しつつもモジュール境界は維持すべき。

## 導出ルール

- `[MUST]` ネイティブバイナリを npm 経由で配布する場合、メインパッケージの `optionalDependencies` にプラットフォーム別パッケージを列挙し、各パッケージの `os` / `cpu` フィールドで対象を制約する
  - 根拠: Biome は 8 プラットフォーム向けバイナリをこのパターンで配布し、`npm install` だけでネイティブバイナリが利用可能になっている (`packages/@biomejs/biome/package.json:48-57`)

- `[SHOULD]` パフォーマンスクリティカルな CLI ツールでは、プラットフォームごとに最適なメモリアロケータをコンパイル時に選択する（`#[cfg]` + `#[global_allocator]`）
  - 根拠: Biome は Windows で mimalloc、macOS/Linux で jemalloc、musl ARM64 でシステムアロケータと使い分けている (`crates/biome_cli/src/main.rs:20-33`)

- `[SHOULD]` 既存ツールの再実装を行う場合、各機能が元ツールとどの程度互換かを構造的にメタデータで記録する（`SameLogic` / `Inspired` 等の区分）
  - 根拠: `RuleSource` と `RuleSourceKind` により、450+ ルールの ESLint 等との互換関係が型安全にトラッキングされている (`crates/biome_analyze/src/rule.rs:100-541`)

- `[SHOULD]` 多言語対応ツールでは、共通の構文木トレイト（`Language`）を定義し、言語ごとにそのトレイトを実装するクレートを分離する
  - 根拠: `biome_rowan` の `Language` トレイトを 11 言語が実装し、フォーマッタ・リンター・パーサーが言語非依存のインフラを共有している

- `[SHOULD]` 実験的機能は環境変数やコンパイル時フラグで段階的に有効化し、安定リリースとの切り替えをビルドパイプラインで自動制御する
  - 根拠: `BIOME_VERSION` 環境変数によるコンパイル時分岐で、nursery ルールのデフォルト推奨状態を制御している (`crates/biome_flags/src/lib.rs:12-17`)

- `[AVOID]` 互換ツールにおいて元ツールの設計上のバグや制約を忠実に再現すること。互換度の上限を設計時に決め、改善余地を確保する
  - 根拠: Biome は Prettier 互換 97% を意図的な設計判断とし、残り 3% を独自改善に充てている

## 適用チェックリスト

- [ ] ネイティブバイナリを配布するプロジェクトで、npm optional dependencies パターンを検討したか
- [ ] CLI ツールでデフォルトアロケータ以外のアロケータが有利なプラットフォームを調査したか
- [ ] 既存ツールの再実装において、互換度の上限（例: 95% / 97% / 100%）を設計ドキュメントで明示したか
- [ ] 多言語対応が必要な場合、共通トレイト / インターフェースを定義して言語ごとの実装を分離しているか
- [ ] 実験的機能のリリース戦略（nursery / beta / stable 等の段階）を定義したか
- [ ] コードジェネレーションで生成されるファイルと手書きファイルの境界を明確にしたか
- [ ] Workspace パターン等で daemon モードと CLI モードを統一 API で提供できるか検討したか
