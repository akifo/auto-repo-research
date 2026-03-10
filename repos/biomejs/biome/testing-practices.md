# testing-practices

> リポジトリ: biomejs/biome
> 分析日: 2026-03-09

## 概要

Biome は多言語対応のリンター・フォーマッター・パーサーであり、テスト戦略においても「言語横断で統一されたパターン」を追求している。特に注目すべきは、(1) proc macro によるテストファイルからのテスト関数自動生成（`gen_tests!`）、(2) insta を活用したスナップショットテストの徹底、(3) 外部仕様テストスイート（Test262、TypeScript、Prettier、CommonMark）による conformance テストの3層構造である。これらが組み合わさることで、数百のルールと複数言語のパーサーに対し、テスト追加の摩擦を最小化しつつ回帰検出を高精度に行う仕組みを実現している。

## 背景にある原則

- **テスト追加の摩擦を限りなくゼロにする**: 新しいルールやパーサーのテストケースを追加する際、テストファイルを所定のディレクトリに配置するだけで自動的にテスト関数が生成される。テストランナーのコードに手を加える必要がない。これにより、コントリビューターの参入障壁を下げている。根拠: `tests_macros::gen_tests!` が 27 以上の crate で利用されている。

- **スナップショットは人間が読める形式で管理する**: スナップショットファイルには入力コード、AST/CST のダンプ、診断メッセージ、コードフィックスの diff がマークダウン風に構造化されて記録される。バイナリやハッシュではなく可読なテキストとすることで、PR レビューで変更の意図が伝わりやすくなる。根拠: `write_analyzer_snapshot` が入力・診断・コードフィックスを構造化テキストとして出力している (`biome_test_utils/src/lib.rs:605`)。

- **コード変換の正しさを多段階で検証する**: コードアクション（自動修正）が生成するコードに対し、(a) テキスト編集と構文木の一致、(b) bogus ノードの不在、(c) 再パースしてエラーがないこと、の3段階で検証する。フォーマッターのファジングでは「再フォーマットしても冪等であること」を確認する。根拠: `check_code_action` 関数 (`biome_js_analyze/tests/spec_tests.rs:313-358`)。

- **外部仕様テストスイートで客観的な適合度を測定する**: 自分たちのテストケースだけでなく、Test262・TypeScript テストスイート・Prettier テストスイート・CommonMark 仕様テストなど、言語仕様の公式テストスイートを取り込み、パーサーの適合率を定量的に測定する。根拠: `xtask/coverage` が Test262、TypeScript (Microsoft/Babel)、JSX (Babel)、CommonMark の 5 スイートをサポートしている。

## 実例と分析

### proc macro によるテスト自動生成 (`gen_tests!`)

`tests_macros::gen_tests!` は、glob パターンでテストファイルを収集し、各ファイルに対応する `#[test]` 関数を自動生成する proc macro である。ファイルパスからモジュール階層を構築し、テスト名をスネークケースに変換する。

```rust
// crates/biome_js_analyze/tests/spec_tests.rs:27-30
tests_macros::gen_tests! {"tests/specs/**/*.{cjs,cts,js,mjs,jsx,tsx,ts,json,jsonc,svelte,vue}", crate::run_test, "module"}
tests_macros::gen_tests! {"tests/suppression/**/*.{cjs,cts,js,jsx,tsx,ts,json,jsonc,svelte,vue}", crate::run_suppression_test, "module"}
tests_macros::gen_tests! {"tests/multiple_rules/**/*.{cjs,cts,js,jsx,tsx,ts,json,jsonc,svelte,vue}", crate::run_multi_rule_test, "module"}
```

このマクロは3つの引数を受け取る: (1) glob パターン、(2) テスト実行関数のパス、(3) ファイルタイプ（ok/error/module 等）。実行関数は統一されたシグネチャ `fn(input: &str, expected: &str, directory: &str, file_type: &str)` を持つ。

この仕組みは 27 以上の crate（パーサー・フォーマッター・アナライザー）で横断的に使われており、テストの追加はファイルを配置するだけで完了する。

### ディレクトリ構造によるテストのルーティング

アナライザーのテストでは、ファイルのディレクトリパスからテスト対象のルールを自動決定する:

```rust
// crates/biome_test_utils/src/lib.rs:532-546
pub fn parse_test_path(file: &Utf8Path) -> (&str, &str) {
    let mut group_name = "";
    let mut rule_name = "";
    for component in file.iter().rev() {
        if component == "specs" || component == "suppression" || component == "plugin" {
            break;
        }
        rule_name = group_name;
        group_name = DiffableStr::as_str(component).unwrap_or_default();
    }
    (group_name, rule_name)
}
```

例えば `tests/specs/complexity/noForEach/invalid.js` なら、`complexity` グループの `noForEach` ルールとして解釈される。テストファイルの配置場所がそのままテストのメタデータとなるため、設定ファイルやアノテーションが不要になる。

### テスト内コメントによる期待値宣言

テストファイル内のコメントでテストの期待動作を宣言できる:

```rust
// crates/biome_test_utils/src/lib.rs:727-728
let no_diagnostics_comment_text = "should not generate diagnostics";
let diagnostics_comment_text = "should generate diagnostics";
```

`valid.js` ファイルに `// should not generate diagnostics` と書くと、テストランナーが診断が0件であることを自動検証する。ファイル名の `valid`/`invalid` 規約とコメント宣言の二重チェックで誤配置を防いでいる。

### `.options.json` によるルールオプションのテスト

テストファイルと同名の `.options.json` ファイルを配置すると、そのテストケースに対してカスタム設定が適用される:

```
tests/specs/complexity/noForEach/
  invalid.js
  invalid.js.snap
  invalidConfig.js
  invalidConfig.js.snap
  invalidConfig.options.json    # このファイルで invalidConfig.js の設定をカスタマイズ
```

`biome_test_utils/src/lib.rs:122-135` の `load_configuration_for_test_file` が `.options.json` を自動検出してロードする。これにより、ルールオプションの組み合わせテストを簡潔に書ける。

### `quick_test` パターン — 開発中の高速フィードバック

各 crate に `quick_test.rs` が存在し、`#[ignore]` 付きの `quick_test` 関数が定義されている。開発者はここに一時的なコードを書いて `cargo t quick_test -- --show-output --ignored` で高速に動作確認できる:

```rust
// crates/biome_js_analyze/tests/quick_test.rs:29-31
#[ignore]
#[test]
fn quick_test() {
```

`just test-quick <package>` コマンドで呼び出せる。スナップショット更新のサイクルを回す前に、ロジックの正しさを素早く確認するための仕組みである。

### Conformance テスト（`xtask/coverage`）

外部言語仕様のテストスイートを取り込み、パーサーの適合率を測定する:

```rust
// xtask/coverage/src/js/test262.rs:15
const BASE_PATH: &str = "xtask/coverage/test262/test";
```

`cargo coverage` コマンドで実行でき、`--json` オプションで結果を JSON 出力し、`compare` サブコマンドで main ブランチとの適合率差分を算出できる。CI で回帰を検出する仕組みとして使われている。

### ファジングテスト

`fuzz/` ディレクトリに各言語・各機能のファジングターゲットが定義されている。パーサーの fuzzer は「パースして再出力したコードが元と一致すること（ラウンドトリップ）」を検証し、フォーマッターの fuzzer は「フォーマットが冪等であること」と「フォーマットがリンターエラーを導入しないこと」を検証する:

```rust
// fuzz/fuzz_targets/rome_common.rs:22-35
pub fn fuzz_js_parser_with_source_type(data: &[u8], source: JsFileSource) -> Corpus {
    let Ok(code1) = std::str::from_utf8(data) else {
        return Corpus::Reject;
    };
    let parse1 = parse(code1, source);
    if !parse1.has_errors() {
        let syntax1 = parse1.syntax();
        let code2 = syntax1.to_string();
        assert_eq!(code1, code2, "unparse output differed");
    }
    Corpus::Keep
}
```

### Prettier テストスイートとの互換性テスト

フォーマッター crate は Prettier のテストスイートを取り込み、差分をスナップショットとして管理する:

```rust
// crates/biome_js_formatter/tests/prettier_tests.rs:10
tests_macros::gen_tests! {"tests/specs/prettier/{js,typescript,jsx}/**/*.{js,ts,jsx,tsx}", crate::test_snapshot, "script"}
```

`SnapshotBuilder` の `with_prettier_diff` メソッド (`biome_formatter_test/src/snapshot_builder.rs:69`) が Prettier との差分を可視化する。これにより、Prettier との互換性の進捗を定量的に追跡できる。

### メモリリークの自動検出

テスト実行時に `register_leak_checker()` を呼び出し、プロセス終了時にシンタックスノードのリーク（解放漏れ）を自動検出する:

```rust
// crates/biome_test_utils/src/lib.rs:494-512
unsafe extern "C" fn check_leaks() {
    if let Some(report) = biome_rowan::check_live() {
        panic!("\n{report}")
    }
}
pub fn register_leak_checker() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| unsafe {
        countme::enable(true);
        atexit(check_leaks);
    });
}
```

## パターンカタログ

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: 各言語・各機能のテストで共通の検証ステップ（パース→分析→スナップショット→アサーション）を統一しつつ、言語固有の部分を差し替え可能にする
  - 適用条件: テストの骨格が同一で、入力パーサーやオプションだけが異なる場合
  - コード例: `run_test` が `analyze_and_snap` を呼び、言語ごとの `parse` と `analyze` を差し替える（`biome_js_analyze/tests/spec_tests.rs:70-156`）
  - 注意点: テスト共通ロジックを `biome_test_utils` crate に集約し、各テスト crate から参照する形で DRY を実現している

- **Convention over Configuration パターン** (分類: アーキテクチャ)
  - 解決する問題: テストケースごとの設定を最小化し、ディレクトリ構造とファイル名の規約でテストのメタデータを表現する
  - 適用条件: テストケースが大量にあり、個々に設定を書くとメンテナンスコストが爆発する場合
  - コード例: `parse_test_path` がパスから group/rule を抽出（`biome_test_utils/src/lib.rs:532-546`）、ok/error ディレクトリで期待結果を表現（`biome_js_parser/tests/spec_tests.rs:3-8`）

## Good Patterns

- **ファイル配置 = テスト登録**: テストファイルを `tests/specs/<group>/<rule>/` に置くだけでテストが自動生成される。テストランナーの変更やテスト関数の手書きが不要。これにより、数百のルールのテスト管理が現実的になる。

```rust
// crates/biome_js_parser/tests/spec_tests.rs:3-8
mod ok {
    tests_macros::gen_tests! {"tests/js_test_suite/ok/**/*.{js,cjs,mjs,jsx,ts,tsx,d.ts}", crate::spec_test::run, "ok"}
}
mod err {
    tests_macros::gen_tests! {"tests/js_test_suite/error/**/*.{js,cjs,mjs,jsx,ts,tsx,d.ts}", crate::spec_test::run, "error"}
}
```

- **コードアクションの多段階検証**: 自動修正が生成するコードを3段階で検証する。(1) テキスト編集結果と構文木の文字列表現が一致、(2) bogus ノードや空スロットが存在しない、(3) 再パースしてエラーがない。いずれかが失敗すれば即座にパニックする。

```rust
// crates/biome_js_analyze/tests/spec_tests.rs:336-357
assert_eq!(new_tree.to_string(), output, "Code action and syntax tree differ");
if has_bogus_nodes_or_empty_slots(&new_tree) && !has_bogus_nodes_or_empty_slots(root.syntax()) {
    panic!("modified tree has bogus nodes or empty slots:\n{new_tree:#?} \n\n {new_tree}")
}
let re_parse = parse(&output, source_type, options);
assert_errors_are_absent(re_parse.tree().syntax(), re_parse.diagnostics(), path);
```

- **共通テストインフラの crate 分離**: テストユーティリティを `biome_test_utils` crate に集約し、27 以上の crate から依存させることで、検証ロジックの重複を排除している。スナップショット出力・設定ローカル・リークチェック・期待値コメント検証がすべてここに集約されている。

## Anti-Patterns / 注意点

- **スナップショットの盲目的承認**: `cargo insta review` で大量のスナップショットを一括承認すると、意図しない回帰を見逃す。Biome はスナップショットを可読なマークダウン形式にすることでレビューしやすくしているが、変更量が多い場合は個別確認が必要。

```
# Bad: 内容を確認せずに一括承認
cargo insta accept --all

# Better: 変更内容をレビューしてから承認
cargo insta review
```

- **テストファイルの配置ミスによるサイレント不検出**: ディレクトリ構造でルールを決定するため、ファイルを間違ったディレクトリに置くと診断が出ずにテストがパスしてしまう。Biome はこの問題に対し `assert_diagnostics_expectation_comment` で `valid` ファイルに「should not generate diagnostics」コメントを義務付け、さらにパスの妥当性チェック (`biome_js_analyze/tests/spec_tests.rs:77-89`) で検出する。

```rust
// Bad: テストファイルが直下に配置され、ルール名が解決できない
// tests/specs/invalid.js → group="specs", rule="invalid" → パニック

// Better: 正しいパスに配置
// tests/specs/complexity/noForEach/invalid.js → group="complexity", rule="noForEach"
```

## 導出ルール

- `[MUST]` テスト追加にテストランナーコードの変更を要求しない仕組みを構築する — ファイル配置やアノテーションだけでテストが登録される設計にする
  - 根拠: Biome は `gen_tests!` マクロにより、27 以上の crate でテストファイルの追加だけでテスト関数が自動生成される仕組みを実現しており、数百のルールのテスト管理を可能にしている

- `[MUST]` コード変換（自動修正・フォーマット）のテストでは、出力の構文的正しさを再パースで検証する — 文字列比較だけでは構文エラーの混入を見逃す
  - 根拠: `check_code_action` がテキスト編集結果を再パースし、エラーがないことを検証している (`biome_js_analyze/tests/spec_tests.rs:354-357`)

- `[SHOULD]` スナップショットテストの出力は人間が読める構造化テキスト（マークダウン等）にする — バイナリやハッシュ比較ではレビュー時に変更の意図が伝わらない
  - 根拠: Biome のスナップショットは入力コード・診断メッセージ・コードフィックスの diff をマークダウン風に構造化しており、PR レビューで差分が可読

- `[SHOULD]` 外部仕様テストスイート（言語仕様の公式テスト等）を取り込み、適合率を定量的に測定・追跡する — 自作テストだけでは網羅性に限界がある
  - 根拠: `xtask/coverage` が Test262、TypeScript、Prettier、CommonMark の各テストスイートを実行し、ブランチ間の適合率比較機能まで提供している

- `[SHOULD]` フォーマッターやコード変換のテストでは冪等性（2回適用しても結果が変わらないこと）を検証する
  - 根拠: ファジングテスト (`fuzz/fuzz_targets/rome_common.rs:145-158`) がフォーマット結果の再フォーマットで同一出力を確認している

- `[SHOULD]` 開発中のルールを素早く試せる `#[ignore]` 付き quick_test 関数を各テスト crate に用意する — スナップショット更新サイクルを回す前に、ロジックの正しさを高速に確認できる
  - 根拠: 31 の crate に `quick_test` パターンが存在し、CONTRIBUTING.md でも公式に推奨されている

- `[AVOID]` テストのメタデータ（対象ルール、期待結果等）をテストコードに埋め込む — ディレクトリ構造やファイル名規約で表現できるなら、そちらを優先する
  - 根拠: Biome は `parse_test_path` でパスからルールを解決し、`ok`/`error` ディレクトリで期待結果を表現することで、個別テストの設定コードを排除している

## 適用チェックリスト

- [ ] テストの追加がテストランナーコードの変更を必要としない仕組みになっているか（ファイル配置 or 設定ファイルで登録）
- [ ] スナップショットテストの出力形式は PR レビューで差分を理解できる可読性を持っているか
- [ ] コード変換（リファクタリング・自動修正・フォーマット）のテストで、出力を再パースして構文的正しさを検証しているか
- [ ] フォーマッターやコード生成ツールのテストで冪等性を検証しているか
- [ ] 言語仕様やエコシステムの公式テストスイートを取り込んで適合率を測定しているか
- [ ] 開発中の機能を素早く試せる `#[ignore]` 付きの quick_test パターンを用意しているか
- [ ] テストケースの配置ミスを検出する仕組み（パスの妥当性チェック、期待値コメント等）があるか
- [ ] テスト共通ロジックを共有ユーティリティに集約し、各テスト間の重複を排除しているか
