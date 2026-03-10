# project-structure

> リポジトリ: biomejs/biome
> 分析日: 2026-03-09

## 概要

94 の Rust クレートから構成される大規模 Cargo workspace の分割戦略・命名規則・依存方向を分析した。Biome は JavaScript/CSS/JSON/GraphQL/HTML/Markdown/YAML/Grit/Tailwind の 9 言語をサポートし、各言語を同一のクレート分割パターンで組織化している。言語間の水平依存を完全に排除しつつ、共通インフラを垂直に積み上げるアーキテクチャが注目に値する。94 クレートという規模にもかかわらず、命名規則の一貫性により新規言語追加時の認知負荷を最小化している。

## 背景にある原則

- **言語直交性の原則**: 各言語の実装は互いに依存してはならない。JS クレートは CSS クレートを参照せず、その逆も同様。これにより言語ごとの独立したコンパイル・テスト・リリースが可能になる。根拠: `biome_js_*` の Cargo.toml に `biome_css_*` への依存が一切存在しない（逆も同様）。

- **共通インフラの垂直積層原則**: 言語非依存の基盤クレート（rowan → parser → formatter → analyze）を垂直に積み上げ、各言語クレートはこの共通レイヤーに依存する。基盤の変更は全言語に波及するが、言語固有の変更は他言語に影響しない。根拠: `biome_parser` は `biome_rowan` に依存し、`biome_js_parser` は `biome_parser` + `biome_js_syntax` に依存する（`Cargo.toml` の依存関係）。

- **コード生成による一貫性の強制**: syntax/factory クレートの大部分は ungrammar 定義からの自動生成であり、手書きコードの不整合を防ぐ。生成コードは `generated/` ディレクトリに隔離される。根拠: `biome_js_syntax/src/generated/nodes.rs` は 45,798 行、`biome_js_factory/src/generated/` 配下は計 17,867 行の自動生成コード。

- **関心ごとの最小単位分割**: 1 つのクレートは 1 つの責務のみを持つ。syntax（AST 型定義）、factory（AST 構築）、parser（構文解析）、formatter（整形）、analyze（静的解析）、semantic（意味解析）を別クレートに分離し、必要な依存のみを宣言する。根拠: `biome_js_factory` の依存は `biome_js_syntax` と `biome_rowan` のみ（`Cargo.toml`）。

## 実例と分析

### 言語ごとのクレート分割パターン

全 9 言語が最大 6 種類のサブクレートで構成される統一パターンを持つ。

| サブクレート | 役割 | JS | CSS | JSON | GraphQL | HTML |
|---|---|---|---|---|---|---|
| `_syntax` | AST ノード型・SyntaxKind 定義 | ○ | ○ | ○ | ○ | ○ |
| `_factory` | AST ノードの構築ユーティリティ | ○ | ○ | ○ | ○ | ○ |
| `_parser` | ソースコード → CST 変換 | ○ | ○ | ○ | ○ | ○ |
| `_formatter` | CST → フォーマット済みテキスト | ○ | ○ | ○ | ○ | ○ |
| `_analyze` | lint ルール・コード解析 | ○ | ○ | ○ | ○ | ○ |
| `_semantic` | スコープ・バインディング解析 | ○ | ○ | - | ○ | - |

JS は追加で `_runtime`, `_transform`, `_type_info`, `_type_info_macros` を持ち、Tailwind は `_syntax`, `_factory`, `_parser` の 3 つのみ。言語の成熟度に応じてサブクレートが段階的に追加される設計。

### 依存方向の階層構造

クレート間の依存は厳密な階層を形成する。

```
biome_text_size          (依存なし — 最下層)
  └─ biome_text_edit
      └─ biome_rowan     (CST の基盤)
          ├─ biome_parser        (共通パーサーインフラ)
          ├─ biome_formatter     (共通フォーマッターインフラ)
          └─ biome_analyze       (共通アナライザーインフラ)

各言語クレート:
  biome_{lang}_syntax  → biome_rowan
  biome_{lang}_factory → biome_{lang}_syntax + biome_rowan
  biome_{lang}_parser  → biome_{lang}_syntax + biome_{lang}_factory + biome_parser
  biome_{lang}_formatter → biome_{lang}_syntax + biome_formatter
  biome_{lang}_analyze → biome_{lang}_syntax + biome_{lang}_semantic + biome_analyze

統合レイヤー:
  biome_service → 全言語の全サブクレート
  biome_cli → biome_service + biome_lsp
```

### publish フラグによるクレートの公開/非公開分類

94 クレートのうち 22 が `publish = false`（非公開）。非公開クレートには以下のカテゴリがある。

- **アプリケーションクレート**: `biome_cli`, `biome_lsp`, `biome_wasm`, `biome_service`
- **内部マクロ**: `biome_analyze_macros`（他は公開）
- **テストユーティリティ**: `biome_test_utils`, `biome_formatter_test`, `tests_macros`
- **未成熟な言語サポート**: `biome_markdown_*`, `biome_yaml_*`（開発中のため非公開）
- **内部ツール**: `biome_flags`, `biome_configuration`, `biome_migrate`, `biome_syntax_codegen`

公開クレートは `version` フィールドを持ち、crates.io への公開を前提とした API 安定性が求められる。

### _macros クレートの分離パターン

proc-macro クレートは対応するクレートから分離され、`_macros` サフィックスで命名される。

```
biome_analyze       ←使用← biome_analyze_macros       (proc-macro)
biome_deserialize   ←使用← biome_deserialize_macros   (proc-macro)
biome_diagnostics   ←使用← biome_diagnostics_macros   (proc-macro)
biome_configuration ←使用← biome_configuration_macros (proc-macro)
biome_js_type_info  ←使用← biome_js_type_info_macros  (proc-macro)
```

Rust の制約上 proc-macro は独立クレートである必要があるが、命名規則により所属関係が即座に判別できる。`biome_diagnostics_macros/Cargo.toml` は `proc-macro2`, `quote`, `syn` のみに依存し、対象クレートへの依存を持たない（循環依存回避）。

### コード生成の分離（xtask パターン）

コード生成は `xtask/` 配下の 4 クレートに分離される。

```
xtask/
├── codegen/      # AST・フォーマッター・アナライザーのコード生成
├── coverage/     # テストカバレッジ
├── glue/         # ファイルシステムユーティリティ
└── rules_check/  # ルール整合性チェック
```

`xtask/codegen` は全言語の `_syntax`, `_factory`, `_analyze` クレートのコードを生成する。Cargo workspace の `members` に含まれるが、本体コードとは分離されている（`crates/biome_syntax_codegen` が新しいコード生成器で、xtask から移行中）。

### biome_service の統合ハブ役割

`biome_service` は全言語の全サブクレートを依存に持つ唯一のクレート。各言語の `file_handlers/` 内に言語ごとのハンドラ（`javascript.rs`, `css.rs`, `json.rs` 等）を配置し、ファイル拡張子に基づいて適切な言語パイプラインにディスパッチする。

```rust
// crates/biome_service/src/file_handlers/mod.rs:1-4
use self::{
    css::CssFileHandler, javascript::JsFileHandler, json::JsonFileHandler,
    unknown::UnknownFileHandler,
};
```

Astro/Svelte/Vue などの埋め込み言語は専用ハンドラで対応し、内部で JS パーサーを呼び出す。

## パターンカタログ

- **Abstract Factory** (生成パターン)
  - 解決する問題: 各言語の AST ノード構築を統一的に行う
  - 適用条件: 同一構造の複数バリアント（言語）が存在する場合
  - コード例: `crates/biome_js_factory/src/generated/syntax_factory.rs` — `JsSyntaxFactory` が `SyntaxKind` に基づいてノードを生成
  - 注意点: factory は syntax のみに依存し、parser の内部実装を知らない

- **Layered Architecture** (構造パターン)
  - 解決する問題: 94 クレートの依存関係の管理
  - 適用条件: 共通基盤と複数のドメイン固有実装がある場合
  - コード例: `biome_text_size` → `biome_rowan` → `biome_parser` → `biome_js_parser` の依存チェーン
  - 注意点: 上位レイヤー（service/cli）のみが全言語を結合する。下位レイヤーは言語非依存

- **Strategy** (振る舞いパターン)
  - 解決する問題: ファイル種別に応じた処理の切り替え
  - 適用条件: 同一インターフェースで異なる振る舞いを選択する場合
  - コード例: `crates/biome_service/src/file_handlers/mod.rs` — ファイル拡張子に基づくハンドラ選択
  - 注意点: 各ハンドラは独立しており、他の言語ハンドラを参照しない

## Good Patterns

- **統一命名規則 `biome_{lang}_{role}`**: 全クレートが `biome_` プレフィックス + 言語名 + 役割名の 3 層命名規則に従う。94 クレートの中から目的のクレートを即座に特定でき、新規言語追加時のクレート構成が自明になる。

```
biome_js_syntax      # JS の AST 型定義
biome_css_parser     # CSS のパーサー
biome_graphql_analyze # GraphQL のアナライザー
```

- **workspace.dependencies による依存バージョン一元管理**: ルート `Cargo.toml` の `[workspace.dependencies]` で全クレートのバージョンと依存パスを一元管理する。個別 Cargo.toml は `{ workspace = true }` で参照するのみ。

```toml
# Cargo.toml:20-21
biome_analyze = { path = "./crates/biome_analyze", version = "0.5.7" }
```

```toml
# crates/biome_js_analyze/Cargo.toml:23
biome_analyze = { workspace = true }
```

- **generated/ ディレクトリの隔離**: 自動生成コードは `src/generated/` に配置し、`#[rustfmt::skip]` アノテーション付きの `generated.rs` で re-export する。手書きコードと生成コードの境界が明確になり、レビュー時に生成ファイルをスキップできる。

```rust
// crates/biome_js_syntax/src/generated.rs:1-5
#[rustfmt::skip]
pub(super) mod nodes;
#[rustfmt::skip]
pub(super) mod nodes_mut;
```

- **workspace.lints による全クレート共通 lint 設定**: ルート `Cargo.toml` の `[workspace.lints.clippy]` で 50 以上の clippy lint を設定し、各クレートは `[lints] workspace = true` で継承する。コーディング規約がワークスペース全体で統一される。

## Anti-Patterns / 注意点

- **巨大な生成ファイル**: `biome_js_syntax/src/generated/nodes.rs` は 45,798 行に達する。IDE のパフォーマンスに影響し、部分的な変更のレビューが困難。

```
# Bad: 1ファイルに全ノード定義を生成
biome_js_syntax/src/generated/nodes.rs  # 45,798 行

# Better: ノード種別ごとにファイル分割して生成
biome_js_syntax/src/generated/expressions.rs
biome_js_syntax/src/generated/statements.rs
biome_js_syntax/src/generated/declarations.rs
```

- **統合クレートへの依存集中**: `biome_service` が全言語の全サブクレートに依存するため、任意の言語クレートの変更で `biome_service` の再コンパイルが発生する。feature flags による条件コンパイルで緩和可能だが、現状は全言語が常にリンクされる。

```toml
# Bad: biome_service/Cargo.toml に全言語が列挙（約40行の依存）
biome_css_analyze = { workspace = true }
biome_css_formatter = { workspace = true }
# ... 全言語の全サブクレート

# Better: feature flags で言語ごとの条件コンパイル
biome_css_analyze = { workspace = true, optional = true }
[features]
css = ["biome_css_analyze", "biome_css_formatter", ...]
```

## 導出ルール

- `[MUST]` 大規模ワークスペースでは `{project}_{domain}_{role}` の 3 層命名規則でクレート/パッケージを命名する
  - 根拠: Biome の 94 クレートは全て `biome_{lang}_{role}` パターンに従い、命名だけで所属と責務が判別可能

- `[MUST]` 同一プロダクト内の複数ドメイン（言語・機能領域）間で水平依存を禁止し、共通基盤への垂直依存のみ許可する
  - 根拠: JS クレート群と CSS クレート群の間に依存が一切なく、各言語を独立してコンパイル・テスト可能

- `[SHOULD]` 自動生成コードは `generated/` ディレクトリに隔離し、手書きコードと同居させない
  - 根拠: 全言語の syntax/factory クレートが `src/generated/` に生成コードを配置し、`#[rustfmt::skip]` で明示的にマーク

- `[SHOULD]` ワークスペースルートで依存バージョン・lint 設定を一元管理し、個別パッケージでは継承のみ行う
  - 根拠: `[workspace.dependencies]` と `[workspace.lints]` で 94 クレート全体の設定を統一（各クレートは `workspace = true` で参照）

- `[SHOULD]` proc-macro クレートは対象クレートから分離し、`_macros` サフィックスで命名する（循環依存回避と命名の一貫性）
  - 根拠: `biome_analyze_macros`, `biome_deserialize_macros` 等 5 つの proc-macro クレートが全て同一パターン

- `[SHOULD]` 統合レイヤー（全ドメインを結合するクレート）は依存グラフの最上位に 1 つだけ配置し、下位クレートが統合レイヤーに依存しない構造を維持する
  - 根拠: `biome_service` のみが全言語クレートを依存に持ち、他のクレートは `biome_service` に依存しない

- `[AVOID]` 共通インフラクレートが特定ドメインのクレートに依存すること（下位→上位の依存逆転）
  - 根拠: `biome_parser` は `biome_js_parser` を知らず、`biome_formatter` のdev-dependencies にのみ `biome_js_*` が含まれる（テスト用）

## 適用チェックリスト

- [ ] ワークスペース内の全パッケージが統一された命名規則（`{project}_{domain}_{role}`）に従っているか
- [ ] ドメイン間（言語間・機能領域間）の水平依存が存在しないか確認する
- [ ] 共通基盤クレートが特定ドメインに依存していないか（依存逆転がないか）確認する
- [ ] 自動生成コードが `generated/` 等の専用ディレクトリに隔離されているか
- [ ] 依存バージョンと lint 設定がワークスペースルートで一元管理されているか
- [ ] proc-macro クレートが対象クレートから分離され、循環依存が発生していないか
- [ ] 統合レイヤーが依存グラフの最上位に位置し、下位クレートから参照されていないか
- [ ] 新規ドメイン追加時にどのサブクレートが必要か、既存パターンから自明に判断できるか
