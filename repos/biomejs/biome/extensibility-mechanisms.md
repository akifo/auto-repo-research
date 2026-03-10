# Extensibility Mechanisms

> リポジトリ: biomejs/biome
> 分析日: 2026-03-09

## 概要

Biome のプラグインシステムは、GritQL パターンマッチングと Boa JavaScript エンジンという2つの異なるプラグインバックエンドを、共通の `AnalyzerPlugin` トレイトの背後に統合する設計を採用している。さらに、Cargo feature flag による条件付きコンパイルで重量級の JS エンジン依存を opt-in にし、`generate_target_language!` マクロで複数言語サポートを型安全に拡張可能にしている。プラグイン拡張ポイントの設計パターンと、ホスト-ゲスト間の安全な境界設計が注目に値する。

## 背景にある原則

- **統一インターフェースの背後で実装戦略を分離すべき**: 異なる実行モデル（パターンマッチング vs. スクリプト実行）を持つプラグインを同一のトレイト（`AnalyzerPlugin`）で抽象化することで、分析エンジン側のコードはプラグインの種類を意識しない。`crates/biome_analyze/src/analyzer_plugin.rs` の `AnalyzerPlugin` トレイトが3つのメソッド（`language`, `query`, `evaluate`）だけで構成されている点がこれを示す。

- **重量級の依存は opt-in にすべき**: Boa JS エンジンのような大きな依存は feature flag（`js_plugin`）で条件付きコンパイルとし、不要な環境ではビルドサイズ・コンパイル時間を削減する（`crates/biome_plugin_loader/Cargo.toml:50-52`）。

- **ホスト提供 API はサンドボックス化された合成モジュールとして注入すべき**: プラグインが利用できる機能を制御するために、`@biomejs/plugin-api` を Boa の合成モジュールとして登録し、ホスト側が提供する関数だけを公開する（`crates/biome_js_runtime/src/plugin_api.rs`）。

- **マクロによるボイラープレート生成で言語拡張の摩擦を下げるべき**: `generate_target_language!` マクロにより、新しい言語サポートの追加は1行のマクロ引数追加で済む（`crates/biome_grit_patterns/src/grit_target_language.rs:210-214`）。

## 実例と分析

### 二重プラグインバックエンドの拡張子ベースディスパッチ

`BiomePlugin::load` は拡張子に基づいてプラグインバックエンドを選択する。`.grit` ファイルなら GritQL、`.js`/`.mjs` ファイルなら Boa JS エンジンへディスパッチされる。この設計は、ファイル拡張子という既存の慣習をプラグイン種別の判別に再利用し、ユーザーが明示的に「プラグインの種類」を宣言する必要をなくしている。

マニフェスト（`biome-manifest.jsonc`）を用いた複数ルールのバンドルもサポートされているが、現時点ではマニフェスト経由では GritQL ルールのみが許可されており、JS ルールは単一ファイルモードに限定されている。この段階的な機能開放は、API の安定性を保ちながら拡張を進める戦略として参考になる。

### GritQL のカスタムビルトイン関数注入

GritQL プラグインロード時、`AnalyzerGritPlugin::load` は `CompilePatternOptions::with_extra_built_ins` を通じて `register_diagnostic` 関数を GritQL ランタイムに注入する。これにより、GritQL パターン内からホストの診断システムへ直接アクセスできる。

この仕組みは `BuiltInFunction` 構造体と `BuiltIns` コレクションで管理され、`debug_assert!` で名前の重複を防止している。パターン位置（Pattern）とプレディケート位置（Predicate）を `as_predicate()` メソッドで切り替えられる点も、DSL の文法上の位置に応じた関数の使い分けを可能にしている。

### スレッドセーフなプラグイン実行のための ThreadLocalCell

Boa JS エンジンはシングルスレッド前提のため、`AnalyzerJsPlugin` は `ThreadLocalCell` を用いてスレッドごとにエンジンインスタンスを遅延初期化する。`ThreadLocalCell` は OS レベルの TLS API（Unix: `pthread_key_create`、Windows: FLS）を直接使用し、`std::thread_local!` の制約（他の TLS と破棄順序が衝突する可能性）を回避している。

### BatchPluginVisitor による O(1) ディスパッチ

複数プラグインの登録時、個別の `PluginVisitor` を N 個作る代わりに `BatchPluginVisitor` が kind-to-plugin のルックアップマップを構築し、ノードごとの走査を O(1) にしている。さらに `applies_to_file` の結果をファイル単位でキャッシュし、同一ファイル内で何度も判定関数を呼ばない最適化を行っている。

### 合成モジュールによるプラグイン API の境界設計

JS プラグインの API サーフェスは `@biomejs/plugin-api` パッケージとして定義されるが、その実体は2つに分かれている:

1. **npm パッケージ側** (`packages/@biomejs/plugin-api/index.js`): `throw new Error(...)` で実行時エラーを投げる。これはプラグインをホスト外で誤って実行した場合のガードになる。
2. **ランタイム側** (`crates/biome_js_runtime/src/plugin_api.rs`): Boa の `Module::synthetic` で同じモジュール名を登録し、実際の関数実装を提供する。

型定義は `index.d.ts` で提供され、プラグイン開発者はエディタ上で型補完を受けられる。

## コード例

```rust
// crates/biome_analyze/src/analyzer_plugin.rs:20-34
pub trait AnalyzerPlugin: Debug + Send + Sync {
    fn language(&self) -> PluginTargetLanguage;
    fn query(&self) -> Vec<RawSyntaxKind>;
    fn evaluate(&self, node: AnySyntaxNode, path: Arc<Utf8PathBuf>) -> Vec<RuleDiagnostic>;
    fn applies_to_file(&self, _path: &Utf8Path) -> bool {
        true
    }
}
```

```rust
// crates/biome_plugin_loader/src/lib.rs:52-78
// 拡張子ベースのプラグインバックエンド選択
if plugin_path.extension().is_some_and(|extension| extension == "grit") {
    let plugin = AnalyzerGritPlugin::load(fs.as_ref(), &plugin_path)?;
    return Ok(( /* ... */ ));
}
#[cfg(feature = "js_plugin")]
if plugin_path.extension().is_some_and(|extension| extension == "js" || extension == "mjs") {
    let plugin = AnalyzerJsPlugin::load(fs.clone(), &plugin_path)?;
    return Ok(( /* ... */ ));
}
```

```rust
// crates/biome_grit_patterns/src/grit_target_language.rs:210-214
// マクロ1行で言語を追加
generate_target_language! {
    [CssTargetLanguage, GritCssParser, "CSS"],
    [JsTargetLanguage, GritJsParser, "JavaScript"],
    [JsonTargetLanguage, GritJsonParser, "JSON"]
}
```

```rust
// crates/biome_js_runtime/src/plugin_api.rs:23-79
// Boa 合成モジュールによる API 注入
pub(crate) fn create_module(&self, context: &mut Context) -> Module {
    let diagnostics = self.diagnostics.clone();
    let register_diagnostic = FunctionObjectBuilder::new(context.realm(), unsafe {
        NativeFunction::from_closure(move |_this, args, context| {
            // ... severity/message の解析と RuleDiagnostic 生成
            diagnostics.borrow_mut().push(diagnostic);
            Ok(JsValue::undefined())
        })
    }).length(2).name("registerDiagnostic").build();

    Module::synthetic(
        &[js_string!("registerDiagnostic")],
        /* initializer */,
        None, None, context,
    )
}
```

```grit
// plugins/no-object-assign.grit:1-7
// GritQL プラグインの実例：register_diagnostic の使用
`$fn($args)` where {
    $fn <: `Object.assign`,
    register_diagnostic(
        span = $fn,
        message = "Prefer object spread instead of `Object.assign()`"
    )
}
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 異なるプラグイン実行戦略（GritQL パターンマッチ vs. JS スクリプト実行）を統一的に扱う
  - 適用条件: 同一のインターフェースで異なるアルゴリズムや実行モデルを切り替える必要がある場合
  - コード例: `crates/biome_analyze/src/analyzer_plugin.rs:20` の `AnalyzerPlugin` トレイトと、`analyzer_grit_plugin.rs` / `analyzer_js_plugin.rs` の2つの実装
  - 注意点: 実装間で能力が非対称な場合（JS プラグインは AST アクセス未実装、GritQL はマルチファイル未対応）、トレイトのメソッドが最小公約数になりがち

- **Synthetic Module パターン** (分類: 構造)
  - 解決する問題: ホスト環境からゲスト（プラグイン）へ安全に機能を注入する
  - 適用条件: 組み込みスクリプトエンジンにホスト API を公開したい場合
  - コード例: `crates/biome_js_runtime/src/context.rs:31-33` で `@biomejs/plugin-api` を合成モジュールとして登録
  - 注意点: npm パッケージ側の `index.js` がガードとして機能する二重構造が必要

- **Thread-Local Lazy Init パターン** (分類: 生成)
  - 解決する問題: シングルスレッド前提のランタイム（Boa）をマルチスレッド環境で安全に使う
  - 適用条件: `Send + Sync` を要求されるトレイトを実装しつつ、内部でスレッド非安全なリソースを使う場合
  - コード例: `crates/biome_plugin_loader/src/thread_local.rs:98-145` の `ThreadLocalCell`
  - 注意点: スレッド終了時のデストラクタが実行されない設計になっており、メモリリークと引き換えに二重解放を防止している

## Good Patterns

- **Feature flag による重量級依存の隔離**: `js_plugin` feature が無効なビルドでは Boa エンジン関連のコードが完全に除外される。`#[cfg(feature = "js_plugin")]` が `mod` 宣言、`pub use`、関数内の分岐の3箇所で一貫して使用されている。

```rust
// crates/biome_plugin_loader/src/lib.rs:8-11
#[cfg(feature = "js_plugin")]
mod analyzer_js_plugin;
#[cfg(feature = "js_plugin")]
mod thread_local;
```

- **Builder パターンによるオプション構成**: `CompilePatternOptions` はメソッドチェーンで構成でき、デフォルト値を持つ。新しいオプション追加時に既存コードが壊れない。

```rust
// crates/biome_grit_patterns/src/lib.rs:80-101
pub struct CompilePatternOptions<'a> {
    default_language: GritTargetLanguage,
    extra_built_ins: Vec<BuiltInFunction>,
    path: Option<&'a Utf8Path>,
}

impl<'a> CompilePatternOptions<'a> {
    pub fn with_default_language(mut self, default_language: GritTargetLanguage) -> Self { /* ... */ }
    pub fn with_extra_built_ins(mut self, built_ins: Vec<BuiltInFunction>) -> Self { /* ... */ }
    pub fn with_path(mut self, path: &'a Utf8Path) -> Self { /* ... */ }
}
```

- **ガード付き npm パッケージ**: プラグイン API の `index.js` がホスト外での実行を即座にエラーにする。型定義（`index.d.ts`）は別ファイルで提供し、開発時の型安全性は維持。

```js
// packages/@biomejs/plugin-api/index.js:1-3
throw new Error(
	"This package is intended to be used in Biome JS plugins, did you mean `@biomejs/js-api`?",
);
```

## Anti-Patterns / 注意点

- **トレイトの最小公約数問題**: `AnalyzerPlugin::evaluate` は `AnySyntaxNode` を受け取るが、JS プラグインは現時点で AST を利用せずファイルパスのみを使用する（`// TODO: pass the AST to the plugin` というコメントが残る）。プラグイン種別間で能力差がある場合、トレイトメソッドのシグネチャが一方の実装にとって不自然になる。

```rust
// Bad: JS プラグインでは node を無視
fn evaluate(&self, _node: AnySyntaxNode, path: Arc<Utf8PathBuf>) -> Vec<RuleDiagnostic> {
    // node は使われない
}
```

```rust
// Better: 能力の非対称性が大きい場合は、トレイトメソッドにデフォルト実装を追加するか、
// 入力を enum にして必要なデータだけ渡す設計を検討する
fn evaluate(&self, input: PluginInput) -> Vec<RuleDiagnostic>;
enum PluginInput { Ast(AnySyntaxNode), FilePath(Arc<Utf8PathBuf>) }
```

- **マニフェスト内での JS ルール未対応**: `biome-manifest.jsonc` からロードされるルールは `.grit` のみ対応し、それ以外は `unsupported_rule_format` エラーになる。JS プラグインはマニフェスト経由では使えないが、エラーメッセージがその理由を十分に説明しない。拡張ポイントの制限は明確にドキュメント化すべき。

## 導出ルール

- `[MUST]` プラグインシステムで複数の実行バックエンドをサポートする場合、共通トレイト/インターフェースを最小限のメソッドで定義し、バックエンド固有のロジックは実装側に閉じ込める
  - 根拠: Biome の `AnalyzerPlugin` トレイトは `language()`, `query()`, `evaluate()` の3メソッドで GritQL と Boa JS の2つの異なる実行モデルを統一している（`crates/biome_analyze/src/analyzer_plugin.rs:20-34`）

- `[MUST]` 組み込みスクリプトエンジンにホスト API を公開する場合、合成モジュール/仮想モジュールとして登録し、利用可能な関数をホスト側で明示的に制御する
  - 根拠: `@biomejs/plugin-api` を Boa の合成モジュールとして登録し、`registerDiagnostic` のみを公開することで、プラグインがホスト内部に不正アクセスする経路を遮断している（`crates/biome_js_runtime/src/context.rs:31-33`）

- `[SHOULD]` 重量級のオプショナル依存は feature flag（Cargo features、webpack の条件付きインポート等）で隔離し、不要な環境でのビルドコスト増加を防ぐ
  - 根拠: Boa JS エンジンとプラットフォーム固有 TLS 依存が `js_plugin` feature flag で完全に隔離されており、GritQL のみ使うビルドではコンパイル対象外になる（`crates/biome_plugin_loader/Cargo.toml:50-52`）

- `[SHOULD]` 複数のプラグイン/ハンドラを走査する場合、kind-to-handler のルックアップマップを事前構築して O(1) ディスパッチを実現する。走査対象のファイル単位で `applies_to_file` のような判定結果をキャッシュする
  - 根拠: `BatchPluginVisitor` が `kind_to_plugins: FxHashMap` で O(1) マッチングを行い、`applicable: Option<Vec<bool>>` でファイル単位の判定をキャッシュしている（`crates/biome_analyze/src/analyzer_plugin.rs:152-200`）

- `[SHOULD]` 言語やバリアントの追加が頻繁に発生する箇所では、宣言的マクロで enum 定義・トレイト実装・シリアライズを一括生成し、追加時のボイラープレートを最小化する
  - 根拠: `generate_target_language!` マクロにより CSS/JS/JSON の3言語サポートが3行の宣言で完結し、`FromStr`、`Serialize`、`Deserialize`、`JsonSchema` が自動導出される（`crates/biome_grit_patterns/src/grit_target_language.rs:33-214`）

- `[AVOID]` プラグインのホスト外実行を許すパッケージ配布をしない。API パッケージの実体（`index.js`）はガードとしてエラーを投げ、型定義（`.d.ts`）は開発補助としてのみ提供する
  - 根拠: `packages/@biomejs/plugin-api/index.js` が即座に `throw new Error(...)` を実行し、ホスト（Boa ランタイム）外での誤使用を防いでいる

## 適用チェックリスト

- [ ] プラグイン/拡張のトレイト/インターフェースが3-5メソッド以内に収まっているか
- [ ] 重量級の依存（スクリプトエンジン、WASM ランタイム等）は feature flag や条件付きインポートで隔離されているか
- [ ] ゲスト（プラグイン）に公開する API サーフェスが明示的に定義・制限されているか
- [ ] 複数プラグインの走査時に O(N) のプラグインイテレーションが発生していないか（ルックアップマップの検討）
- [ ] シングルスレッド前提のランタイムをマルチスレッド環境で使う場合、スレッドローカル戦略が適用されているか
- [ ] 新しい言語/バリアント追加のコストが最小限になるよう、マクロやコード生成で定型コードを自動化しているか
- [ ] プラグインマニフェストのバージョニング戦略が定義されているか（`version: 1` のような前方互換設計）
