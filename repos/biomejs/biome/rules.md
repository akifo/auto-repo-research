# biomejs/biome — 導出ルール集

> 出典: repos/biomejs/biome/ | 生成日: 2026-03-09
> 用途: CLAUDE.md にそのまま貼り付けて AI コンテキストとして活用

## コード生成・メタプログラミング

- `[MUST]` DSL・スキーマ・文法定義を唯一の真実の源（Single Source of Truth）とし、派生コード（AST 型、ファクトリ、バリデータ等）はコード生成で導出する
  - 根拠: metaprogramming-techniques / architecture — `.ungram` から 10 言語分の syntax/factory クレートを自動生成し、手動定義による不整合を構造的に防止
- `[MUST]` 生成ファイルには「生成物であること」と「再生成コマンド」を示すヘッダコメントを付与し、手書きの拡張ファイルと物理的に分離する
  - 根拠: metaprogramming-techniques / cst-and-syntax-model — `generated/nodes.rs`（生成）と `expr_ext.rs`（手書き）の分離パターンが全言語で適用
- `[MUST]` コード生成でコレクションを使う場合は `BTreeMap`/`BTreeSet` など順序保証のある型を使い、生成結果を決定的にする
  - 根拠: metaprogramming-techniques — `HashMap` を使うと生成コードの順序が実行ごとに変わり、無意味な diff が発生する
- `[SHOULD]` 同種のコンポーネントが 10 個以上ある場合、マクロまたはコード生成でボイラープレートを排除する
  - 根拠: metaprogramming-techniques / rule-system-architecture — 489+ ルールを `declare_lint_rule!` で定義し、各ルールのメタデータ登録・trait 実装を自動化
- `[SHOULD]` コード生成ツールに「書き込み」と「検証のみ」の 2 モードを持たせ、CI では検証モードで生成コードの鮮度をチェックする
  - 根拠: build-and-tooling — `Mode::Overwrite`（ローカル）と `Mode::Verify`（CI）で同一ロジックを共有

## プロジェクト構造・モジュール設計

- `[MUST]` 大規模ワークスペースでは `{project}_{domain}_{role}` の統一命名規則でパッケージを命名し、命名だけで所属と責務を判別可能にする
  - 根拠: project-structure — 94 クレートが全て `biome_{lang}_{role}` パターンに従う
- `[MUST]` 同一プロダクト内の複数ドメイン間で水平依存を禁止し、共通基盤への垂直依存のみ許可する
  - 根拠: project-structure / architecture — JS と CSS クレート群の間に依存が一切なく、各ドメインを独立してコンパイル・テスト可能
- `[SHOULD]` ワークスペースルートで依存バージョン・lint 設定を一元管理し、個別パッケージでは継承のみ行う
  - 根拠: project-structure — `[workspace.dependencies]` と `[workspace.lints]` で 94 クレート全体の設定を統一
- `[SHOULD]` 統合レイヤー（全ドメインを結合するモジュール）は依存グラフの最上位に 1 つだけ配置し、下位モジュールから参照しない構造を維持する
  - 根拠: project-structure / architecture — `biome_service` のみが全言語クレートを依存に持ち、他のクレートは `biome_service` に依存しない
- `[AVOID]` 共通基盤モジュールが特定ドメインのモジュールに依存すること。ドメイン間の結合が必要な場合は上位レイヤーに局所化する
  - 根拠: architecture — 言語間の結合は `biome_service/file_handlers` に集約し、共通基盤レイヤーには持ち込まない

## エラーハンドリング・診断

- `[MUST]` エラー型には「カテゴリ」「重大度」「位置情報」を構造化フィールドとして持たせ、文字列メッセージだけに頼らない
  - 根拠: error-handling-idioms — `Diagnostic` trait が category, severity, location, message, advices を独立メソッドとして要求
- `[MUST]` エラーコード/カテゴリは静的レジストリで一元管理し、コンパイル時または起動時に検証する
  - 根拠: error-handling-idioms — `category!` マクロでコンパイル時検証を実現し、未登録カテゴリの使用をコンパイルエラーにしている
- `[SHOULD]` エラーの「意味」と「表示」を分離し、Visitor パターン等で複数の出力形式（ターミナル、CI、JSON 等）に対応する
  - 根拠: error-handling-idioms — 同じ `Diagnostic` データからターミナル・GitHub Actions・JSON の 3 形式を生成
- `[SHOULD]` エラーにはユーザーが問題を修正するための具体的な情報（コードフレーム、差分、推奨コマンド等）を付加する
  - 根拠: error-handling-idioms — CONTRIBUTING.md で「diagnostic should try to provide a way for the user to fix the issue」と明記
- `[AVOID]` 外部ライブラリのエラー型をそのまま伝播させる。自前のエラー型でラップし、カテゴリやコンテキスト情報を付与する
  - 根拠: error-handling-idioms — `IoError`, `SerdeJsonError` 等のアダプタ型で外部エラーをラップしカテゴリ付与

## テスト

- `[MUST]` テスト追加にテストランナーコードの変更を要求しない仕組みを構築する。ファイル配置やアノテーションだけでテストが登録される設計にする
  - 根拠: testing-practices — `gen_tests!` マクロにより 27 以上の crate でテストファイルの追加だけでテスト関数が自動生成
- `[MUST]` コード変換（自動修正・フォーマット）のテストでは、出力の構文的正しさを再パースで検証する
  - 根拠: testing-practices — `check_code_action` がテキスト編集結果を再パースし、エラーがないことを検証
- `[SHOULD]` スナップショットテストの出力は人間が読める構造化テキスト（マークダウン等）にする
  - 根拠: testing-practices — 入力コード・診断メッセージ・コードフィックスの diff をマークダウン風に構造化
- `[SHOULD]` 外部仕様テストスイート（言語仕様の公式テスト等）を取り込み、適合率を定量的に測定・追跡する
  - 根拠: testing-practices — Test262、TypeScript、Prettier、CommonMark の各テストスイートを実行し適合率比較
- `[SHOULD]` フォーマッターやコード変換のテストでは冪等性（2 回適用しても結果が変わらないこと）を検証する
  - 根拠: testing-practices — ファジングテストがフォーマット結果の再フォーマットで同一出力を確認
- `[AVOID]` テストのメタデータ（対象ルール、期待結果等）をテストコードに埋め込む。ディレクトリ構造やファイル名規約で表現できるなら、そちらを優先する
  - 根拠: testing-practices — `parse_test_path` でパスからルールを解決し、`ok`/`error` ディレクトリで期待結果を表現

## パフォーマンス

- `[MUST]` ホットパスのデータ構造サイズはコンパイル時アサーション（`static_assert!` 等）で固定し、意図しない膨張を防ぐ
  - 根拠: ir-formatter-design / performance-techniques — `static_assert!(size_of::<FormatElement>() == 24)` で IR 要素のサイズ回帰を防止
- `[MUST]` ベンチマーク環境のアロケーター・設定は本番バイナリと一致させる
  - 根拠: performance-techniques — 全ベンチマークファイルで本番と同一の `#[global_allocator]` パターンを適用
- `[SHOULD]` 不変データ構造の繰り返しパターンにはインターニング（Flyweight）を適用してメモリを共有する
  - 根拠: performance-techniques — NodeCache が構文木ノードを重複排除し、グリーンノードのメモリを 17% 削減
- `[SHOULD]` 固定文字列と動的文字列で異なる表現型を使い分け、不要なアロケーションを避ける
  - 根拠: ir-formatter-design — `Token`（`&'static str`）と `Text`（`Box<str>`）を分離し、固定トークンではゼロアロケーション
- `[SHOULD]` 暗号学的安全性が不要なハッシュマップには FxHash 等の高速ハッシャーを使う
  - 根拠: performance-techniques — 内部データ構造全体で `FxHasher` / `FxBuildHasher` を使用
- `[SHOULD]` 要素数が少ないことが分かっている可変長配列には SmallVec を使い、ヒープアロケーションを回避する。サイズ選択の根拠をコメントで明記する
  - 根拠: performance-techniques / semantic-analysis-patterns — `SmallVec<[TextSize; 4]>` の使用箇所にドメイン知識による根拠コメント
- `[AVOID]` 長時間動作するプロセス（LSP サーバー等）でキャッシュを無制限に成長させる。世代管理やサイズ制限による回収機構を設ける
  - 根拠: performance-techniques — NodeCache は世代ベース GC で不使用エントリを回収

## 設定・シリアライズ

- `[MUST]` 設定フィールドは `Option<T>` で「未設定」を明示的に表現し、「未設定」と「デフォルト値」を区別する
  - 根拠: configuration-patterns — 全フィールドを `Option` にすることで extends チェーンのマージを型安全に実現
- `[MUST]` 設定の継承（extends）を実装する場合、マージのセマンティクスを型ごとに明示的に定義する（プリミティブは上書き、Option は再帰マージ、コレクションは結合/上書き）
  - 根拠: configuration-patterns — `Merge` trait の `Option<T>` 実装が「None なら other を採用、Some 同士なら再帰マージ」を型レベルで保証
- `[SHOULD]` 設定のデシリアライズではfail-fast ではなくフォールトトレラント戦略を採り、可能な限り多くの診断を一度に報告する
  - 根拠: configuration-patterns — `biome_deserialize` は serde の fail-fast を意図的に避け、複数エラーの同時報告を実現
- `[SHOULD]` 設定モデルの定義から JSON Schema・CLI 引数パーサ・シリアライズ/デシリアライズを単一ソースで生成し、仕様の不整合を防ぐ
  - 根拠: configuration-patterns — `Configuration` 構造体は `Deserializable, Merge, schemars::JsonSchema, Bpaf` を一つの定義から derive

## コンポーネント管理・ライフサイクル

- `[MUST]` プラグイン・ルール等の宣言的登録システムでは、メタデータ（名前・バージョン・重要度等）を振る舞い実装から分離し、single source of truth として管理する
  - 根拠: rule-system-architecture — `RuleMeta` trait（メタデータ）と `Rule` trait（振る舞い）を分離し、メタデータから設定・ドキュメント・マイグレーションを自動生成
- `[MUST]` 新機能にインキュベーション段階（nursery / experimental / unstable）を設け、semver の対象外とすることで、早期リリースと安定性を両立する
  - 根拠: rule-system-architecture / design-philosophy — 全新規ルールを `nursery` に配置し、安定後にグループ移動する運用を義務化
- `[SHOULD]` コンポーネントのカテゴリとメタデータの整合性を CI レベルで自動検証する
  - 根拠: rule-system-architecture — `xtask/rules_check` がグループと重要度の組み合わせ制約を静的にチェック
- `[AVOID]` 登録コードの手動メンテナンスが必要なプラグインレジストリの設計。ファイル配置やディレクトリ走査で自動登録する
  - 根拠: metaprogramming-techniques / rule-system-architecture — ファイルシステム走査による自動登録で `mod.rs` や登録リストの手動更新を排除

## CLI・プラットフォーム

- `[MUST]` CLI ツールが daemon/server モードを持つ場合、コアロジックを trait で抽象化し、in-process 実行とリモート呼び出しを同一インターフェースで切り替え可能にする
  - 根拠: cli-framework-patterns — `Workspace` trait の `server()`/`client()` ファクトリで `--use-server` フラグだけで透過的に切り替え
- `[MUST]` プラットフォーム依存コードは trait/interface を通じて注入し、コアロジックからプラットフォーム固有の import を排除する
  - 根拠: platform-abstraction — `FileSystem` trait の差し替えだけでネイティブ/WASM 両対応を実現
- `[MUST]` npm でネイティブバイナリを配布する場合、`optionalDependencies` + プラットフォーム別パッケージの `os`/`cpu` フィールドで配布対象を宣言する
  - 根拠: design-philosophy / platform-abstraction — 8 プラットフォーム分のバイナリをこの方式で配布
- `[SHOULD]` 複数サブコマンドで共有するオプション群は独立した構造体に分離し、サブコマンド定義から参照する
  - 根拠: cli-framework-patterns — `CliOptions` を `#[bpaf(external)]` で分離し 10 個以上のサブコマンドで共有
- `[SHOULD]` 相互排他的な CLI オプションの組み合わせを、解決方法を含むエラーメッセージで早期に拒否する
  - 根拠: cli-framework-patterns — `--write` と `--suppress` の非互換を検出し、具体的な案内を返す
- `[SHOULD]` daemon プロセスのソケット名にバージョンを含め、異なるバージョン間の接続事故を防止する
  - 根拠: cli-framework-patterns — `biome-socket-{VERSION}` 形式でバージョンごとにソケットを分離

## ビルド・CI

- `[MUST]` コード生成とフォーマットは単一コマンドで連続実行し、生成後のフォーマット漏れを防ぐ
  - 根拠: build-and-tooling — `gen-all` は最後に `just format` を実行し、`ready` は前後で `git diff --exit-code` を挟んで整合性保証
- `[MUST]` リリース対象パッケージ群のバージョンは fixed グループ等で同期し、プラットフォーム別パッケージとの不一致を防ぐ
  - 根拠: build-and-tooling — changesets の `fixed` で CLI + 8 プラットフォーム + 3 WASM のバージョンを統一
- `[SHOULD]` タスクランナーのコマンドを「プリミティブ→複合→エイリアス」の 3 層で構成し、個別実行と一括実行の両方を可能にする
  - 根拠: build-and-tooling — justfile が `format`/`lint`/`test` → `gen-analyzer`/`ready` → `f`/`t`/`r` の 3 層で構成
- `[SHOULD]` CI ワークフローには `concurrency` + `cancel-in-progress` を設定し、同一 PR の古いジョブを自動キャンセルする
  - 根拠: build-and-tooling — PR 単位のグループで更新時に前回実行をキャンセルしリソース節約

## AI エージェント統合

- `[MUST]` AI エージェント向けガイドライン（AGENTS.md 相当）と人間向け貢献ガイド（CONTRIBUTING.md）を分離し、AI 固有の制約を独立ファイルに記述する
  - 根拠: ai-settings — AGENTS.md で冗長サマリー拒否、changeset 決定木、AI 開示テンプレートを分離
- `[MUST]` AI エージェントが実行できるコマンドを settings の allow/deny リストで明示的に制限し、破壊的操作を deny に含める
  - 根拠: ai-settings — `cargo biome-cli-dev` を deny し、テスト・チェック・コード生成のみを allow
- `[SHOULD]` 手続き的知識（スキル）と判断基準（エージェント）を分離し、組み合わせカタログで対応関係を明示する
  - 根拠: ai-settings — 8 スキルと 3 エージェントを分離し README にカタログとして組み合わせを明示
- `[AVOID]` AI エージェントにプロジェクトの品質基準を超える冗長さを許容すること。エージェントがユーザーの要求よりプロジェクト基準を優先するルールを明記する
  - 根拠: ai-settings — AGENTS.md が冗長サマリー要求の拒否を明示的に指示

## ルール優先度の解釈

- `[MUST]`: 違反するとバグ・セキュリティリスク・重大な設計劣化を招くルール
- `[SHOULD]`: 従うことで品質が向上するが、文脈によっては例外を許容するルール
- `[AVOID]`: 意図的に避けるべきアンチパターン・非推奨プラクティス
