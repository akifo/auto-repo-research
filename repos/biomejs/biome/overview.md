# biomejs/biome

> URL: https://github.com/biomejs/biome
> Stars: 24k | 言語: Rust | ライセンス: Apache-2.0 | 分析日: 2026-03-09

## サマリー

Biome は Prettier/ESLint を Rust で統合再実装した多言語ツールチェーンであり、94 クレートのワークスペースを `Language` trait による型パラメータ化と 6 クレートパターンの反復適用で組織化している。このコードベースから学べる核心は、(1) 文法定義（`.ungram`）を唯一の真実の源としたコード生成駆動開発、(2) 共通基盤 trait + 言語別具象型による多言語パイプラインの設計、(3) マクロ・ファイルシステム駆動登録・段階的安定化（nursery）を組み合わせた数百コンポーネントのスケーラブルな管理手法である。

## 技術スタック

- **言語**: Rust（Edition 2024、コア）、TypeScript（JS API・npm 配布スクリプト）
- **フレームワーク**: biome_rowan（CST 基盤、rust-analyzer rowan fork）、bpaf（CLI パーサー）、Boa（JS プラグインエンジン）
- **ビルド**: Cargo workspace（94 クレート）、justfile タスクランナー、xtask コード生成、wasm-bindgen + wasm-opt
- **テスト**: insta（スナップショット）、gen_tests! proc macro、Test262/Prettier conformance、cargo-fuzz
- **パッケージマネージャ**: Cargo + pnpm（npm 配布用）、changesets（リリース管理）
- **タスクランナー**: Just
- **コード生成**: xtask（codegen/coverage/glue/rules_check）

## 分析した視点

| # | 視点 | ファイル | 概要 |
| - | ---- | -------- | ---- |
| 1 | プロジェクト構造 | project-structure.md | 94クレートを biome_{lang}_{role} の3層命名で統一し、言語間水平依存を排除した垂直積層アーキテクチャ |
| 2 | アーキテクチャ | architecture.md | Language traitで言語を型パラメータ化し、共通基盤+6クレートパターンの反復適用で多言語対応を実現 |
| 3 | 設計思想 | design-philosophy.md | Prettier 97%互換+独自改善、npm optional dependenciesによるネイティブ配布、nursery段階的安定化 |
| 4 | CST・構文モデル | cst-and-syntax-model.md | Green/Red分離の不変CST、スロットベースアクセス、Bogusノードによるエラー回復、ungram駆動コード生成 |
| 5 | 多言語パイプライン | multi-language-pipeline.md | FormatLanguage/Parser/Rule traitの関連型で言語を注入し、Capabilitiesで段階的機能公開を実現 |
| 6 | ルールシステム | rule-system-architecture.md | declare_lint_rule!マクロで489+ルールを宣言的登録、3層階層フィルタリング、nurseryインキュベーション |
| 7 | メタプログラミング | metaprogramming-techniques.md | xtask/proc-macro/declarative macroの3層で.ungramから54,000行超を生成、FS駆動のルール自動登録 |
| 8 | IRフォーマッター設計 | ir-formatter-design.md | 24バイトFormatElement IRをフラット配列+タグペアで表現、BestFitting複数バリアント選択、Interned共有 |
| 9 | エラーハンドリング | error-handling-idioms.md | 構造化Diagnostics+Visitor出力分離、コンパイル時カテゴリ検証、Box\<Box\<dyn\>\>でResult\<T\>をusize化 |
| 10 | テスト戦略 | testing-practices.md | gen_tests!マクロでファイル配置=テスト登録、コードアクション多段階検証、Test262/Prettier適合率測定 |
| 11 | パフォーマンス | performance-techniques.md | OS別アロケータ選択、rayon並列走査、NodeCacheインターニング+世代GC、papaya lock-freeマップ |
| 12 | 設定パターン | configuration-patterns.md | Option\<T\>+Merge traitで設定継承、フォールトトレラントデシリアライズ、単一定義から多面的生成 |
| 13 | CLIフレームワーク | cli-framework-patterns.md | bpaf宣言的CLI+Workspace trait透過バックエンド、daemon隠しコマンド、CommandRunner共通パイプライン |
| 14 | プラットフォーム抽象 | platform-abstraction.md | FileSystem traitでプラットフォーム差異を吸収、npm os/cpuパターンで8環境+WASM3ターゲット配布 |
| 15 | 拡張メカニズム | extensibility-mechanisms.md | AnalyzerPlugin traitで GritQL/Boa JS 二重バックエンド統一、合成モジュールでAPI境界を制御 |
| 16 | AI設定 | ai-settings.md | エージェント3つ+スキル8つの組み合わせカタログ、settings.jsonコマンド権限制御、AI開示ポリシー |
| 17 | ビルド・ツーリング | build-and-tooling.md | just readyでCI等価ローカルチェック、Overwrite/Verifyモード、changesets fixed群バージョン同期 |
| 18 | セマンティック分析 | semantic-analysis-patterns.md | イベント駆動二段階構築、Arc+IDハンドルパターン、NonZeroニッチ最適化、型解決4段階レベル制御 |

## 特に注目すべき知見

- **コード生成駆動開発**: `.ungram` 文法定義 2,457 行から 54,000 行超の型安全コードを自動生成し、10 言語の AST ノード型・ファクトリ・フォーマッタスキャフォールドを統一管理。手書きの拡張は `_ext.rs` に分離して再生成と共存させる設計は、大規模コードベースのボイラープレート管理に即座に応用できる。

- **ファイル配置 = コンポーネント登録**: `declare_group_from_fs!` proc macro がディレクトリ走査でルールを自動発見し、489+ のルールを「ファイルを置くだけで登録完了」にしている。テストも `gen_tests!` マクロで同様にファイル配置だけで自動生成。この「ファイルシステムをレジストリとして使う」パターンは、プラグインやハンドラが多数あるプロジェクト全般に適用できる。

- **IR サイズの静的保証と多段最適化**: `static_assert!(size_of::<FormatElement>() == 24)` でホットデータ構造のサイズ回帰を防止。Token を `&'static str` / `TokenText` / `Box<str>` の 3 段階に分けてアロケーションを最小化し、`Interned(Rc<[FormatElement]>)` で IR サブツリーを参照共有する。パフォーマンスクリティカルなデータ構造設計の教科書的実装。

- **構造化 Diagnostics とコンパイル時カテゴリ検証**: エラーをカテゴリ・重大度・位置情報・advice（修正提案）の構造体として表現し、`category!` マクロで未登録カテゴリの使用をコンパイルエラーにする。Visitor パターンで同一データからターミナル・GitHub Actions・JSON の 3 形式を出力する設計は、開発者ツールのエラーハンドリング全般に応用可能。

- **Option + Merge trait による設定継承**: 全設定フィールドを `Option<T>` にし、`Merge` trait の型別セマンティクス（プリミティブは上書き、Option は再帰マージ）で extends チェーンを実現。デシリアライズは serde の fail-fast を避けフォールトトレラントに複数エラーを報告する独自フレームワークを構築。設定ファイルを持つツール全般に参考になる。

## クイックリファレンス

- [導出ルール集](rules.md) — CLAUDE.md に貼れる形式の全ルール
