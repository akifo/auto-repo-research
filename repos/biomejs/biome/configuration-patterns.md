# configuration-patterns

> リポジトリ: biomejs/biome
> 分析日: 2026-03-09

## 概要

Biome の設定システム（`biome.json`）は、カスタムデシリアライザー・derive マクロ・Merge トレイト・条件付き JSON Schema 生成を組み合わせた多層アーキテクチャで構築されている。serde のfail-fast 戦略を意図的に避け、フォールトトレラントなデシリアライズと豊富な診断メッセージを両立させている点が注目に値する。設定の継承（`extends`）とオーバーライド（`overrides`）を型安全なマージ戦略で実現しており、汎用的な設定システム設計のプラクティスが多数含まれる。

## 背景にある原則

- **フォールトトレラント優先**: serde の fail-fast ではなく「可能な限りデシリアライズし、複数の診断を報告する」戦略を採る。設定ファイルのエラーが1箇所あっても、他の部分は正常にパースされるべき、という UX 原則に基づく（`crates/biome_deserialize/src/lib.rs:7-9`）
- **derive マクロによる宣言的定義**: 設定構造体は `#[derive(Deserializable, Merge)]` で宣言的に定義し、デシリアライズとマージの実装を自動生成する。手書きのボイラープレートを排除しつつ、カスタマイズポイント（`with_validator`, `deprecated`, `bail_on_error` 等）を属性で提供する
- **Option 型による未設定の明示的表現**: 全設定フィールドを `Option<T>` で包み、「未設定」と「デフォルト値」を明確に区別する。これにより extends/overrides のマージ時に「設定されていないフィールドは親の値を引き継ぐ」セマンティクスが自然に実現される
- **単一ソースからの多面的生成**: 同一の Rust 構造体定義から JSON Schema（`schemars`）、CLI 引数パーサ（`bpaf`）、シリアライズ/デシリアライズ（`serde` + 独自）を生成する。設定の仕様が一箇所に集約されることで不整合を防ぐ

## 実例と分析

### カスタムデシリアライザーフレームワーク

`biome_deserialize` クレートは serde にインスパイアされつつ、フォールトトレラントな独自フレームワークを構築している。コアは `Deserializable` トレイト（データ構造側）と `DeserializableValue` トレイト（データフォーマット側）の分離にある。

```rust
// crates/biome_deserialize/src/lib.rs:80-88
pub trait Deserializable: Sized {
    fn deserialize(
        ctx: &mut impl DeserializationContext,
        value: &impl DeserializableValue,
        name: &str,
    ) -> Option<Self>;
}
```

`Option<Self>` を返すことで部分的な失敗を許容し、`DeserializationContext::report()` で診断を蓄積する。serde の `Result<T, E>` ベースの即時失敗とは対照的なアプローチ。

### Merge トレイトによる設定マージ戦略

`Merge` トレイトは型ごとにマージのセマンティクスを定義する。プリミティブ型は上書き、`Option<T>` は再帰マージ、コレクション型は結合という階層的な戦略をとる。

```rust
// crates/biome_deserialize/src/merge.rs:19-28
impl<T: Merge> Merge for Option<T> {
    fn merge_with(&mut self, other: Self) {
        if let Some(other) = other {
            match self.as_mut() {
                Some(this) => this.merge_with(other),
                None => *self = Some(other),
            }
        }
    }
}
```

`Option<T>` の `Merge` 実装がこのシステムの核心で、「`self` が `None` なら `other` で埋め、両方 `Some` なら再帰マージ」というセマンティクスにより、extends チェーンでの設定の継承が実現される。

構造体の `Merge` derive は全フィールドに対して再帰的に `merge_with` を呼ぶコードを生成する。

```rust
// crates/biome_deserialize_macros/src/merge_derive.rs:66-75
fn generate_merge_struct(ident: Ident, fields: Fields) -> TokenStream {
    let field_idents = fields.into_iter().filter_map(|field| field.ident);
    quote! {
        impl biome_deserialize::Merge for #ident {
            fn merge_with(&mut self, other: Self) {
                #( biome_deserialize::Merge::merge_with(&mut self.#field_idents, other.#field_idents); )*
            }
        }
    }
}
```

### extends チェーンのマージ順序

設定の継承では、extends リスト内の設定を左から右に reduce し、最後にカレント設定をマージする。swap テクニックでクローンを回避している点も注目。

```rust
// crates/biome_service/src/configuration.rs:593-606
let extended_configuration = configurations.into_iter().flatten().reduce(
    |mut previous_configuration, current_configuration| {
        previous_configuration.merge_with(current_configuration);
        previous_configuration
    },
);
if let Some(mut extended_configuration) = extended_configuration {
    self.root = Some(self.is_root().into());
    // swap で clone を避ける
    std::mem::swap(self, &mut extended_configuration);
    self.merge_with(extended_configuration)
}
```

### const ジェネリクスによるデフォルト値の型エンコード

`Bool<const D: bool>` 型は、ブール値のデフォルトを型パラメータとして表現する。これにより `FormatterEnabled = Bool<true>`（デフォルト有効）と `UseEditorconfigEnabled = Bool<false>`（デフォルト無効）が型レベルで区別される。

```rust
// crates/biome_configuration/src/bool.rs:12
pub struct Bool<const D: bool>(pub bool);

// crates/biome_configuration/src/formatter.rs:10-11
pub type FormatterEnabled = Bool<true>;
pub type UseEditorconfigEnabled = Bool<false>;
```

### 条件付き JSON Schema 生成

`#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]` で JSON Schema の生成を feature flag で制御し、通常のビルドではスキーマ生成のオーバーヘッドを避けつつ、xtask で必要時にのみスキーマを生成する。

```rust
// crates/biome_configuration/src/lib.rs:99-103
#[derive(
    Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, Bpaf, Deserializable, Merge,
)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields, default, rename_all = "camelCase")]
pub struct Configuration { /* ... */ }
```

カスタムの型（`Extends`, `OverrideGlobs` 等）では `schemars::JsonSchema` を手動実装して、内部表現と JSON Schema 表現を分離している。

```rust
// crates/biome_configuration/src/extends.rs:64-78
#[cfg(feature = "schema")]
impl schemars::JsonSchema for Extends {
    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
        #[derive(serde::Deserialize, schemars::JsonSchema)]
        #[serde(untagged)]
        enum ExtendsSchema {
            List(Vec<String>),
            String(String),
        }
        ExtendsSchema::json_schema(generator)
    }
}
```

### ルールグループのコード生成マクロ

`biome_configuration_macros` は lint ルールレジストリから設定構造体を自動生成する proc-macro を提供する。ルールのメタデータ（名前、推奨フラグ、fix 種別）から、対応するフィールド・フィルタ定数・有効/無効チェックメソッドを一括生成する（`crates/biome_configuration_macros/src/group_struct.rs:11-344`）。

### DeserializableValidator によるバリデーション

`with_validator` 属性で、デシリアライズ後のバリデーションロジックを注入する。`Configuration` 構造体では `root` と `extends` の矛盾をチェックしている。

```rust
// crates/biome_configuration/src/lib.rs:195-219
impl DeserializableValidator for Configuration {
    fn validate(
        &mut self,
        ctx: &mut impl DeserializationContext,
        _name: &str,
        range: TextRange,
    ) -> bool {
        if self.root.is_some_and(|root| root.value())
            && self.extends.as_ref().is_some_and(|extends| extends.extends_root())
        {
            ctx.report(/* ... */);
        }
        true
    }
}
```

### EditorConfig からの設定変換

`.editorconfig` ファイルを Biome の設定モデルに変換する際、global セクション (`*`) は `formatter` に、個別セクションは `overrides` にマッピングする（`crates/biome_configuration/src/editorconfig.rs:318-348`）。既存の設定モデルへの変換をアダプターパターンで実現している。

## パターンカタログ

- **Visitor パターン** (分類: 振る舞い)
  - 解決する問題: データフォーマット（JSON）とデータ構造（設定型）の独立性確保
  - 適用条件: 複数のデータフォーマットを同じデータ構造にデシリアライズしたい場合
  - コード例: `crates/biome_deserialize/src/lib.rs:291-443` の `DeserializationVisitor`
  - 注意点: serde の Visitor と同構造だが、`Option` 返却で部分失敗を許容する点が異なる

- **Adapter パターン** (分類: 構造)
  - 解決する問題: 外部設定フォーマット（.editorconfig）を内部設定モデルへ変換
  - 適用条件: 複数の設定ソース（biome.json, .editorconfig, CLI 引数）を統一モデルに集約する場合
  - コード例: `crates/biome_configuration/src/editorconfig.rs:318-348`

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: デシリアライズの基本フローを固定し、型ごとの振る舞いだけをカスタマイズ
  - 適用条件: derive マクロで基本実装を生成し、`with_validator` でフックポイントを提供
  - コード例: `crates/biome_deserialize_macros/src/lib.rs:80-113`

## Good Patterns

- **Option 型 + Merge による設定継承**: 全フィールドを `Option<T>` にし、`Merge` トレイトで再帰マージすることで、extends チェーンの設定継承を型安全に実現。マージのセマンティクスが型ごとに明確に定義されるため、予測不能な挙動が生まれにくい。

```rust
// crates/biome_configuration/src/formatter.rs:20-21
pub struct FormatterConfiguration {
    pub enabled: Option<FormatterEnabled>,   // None = 未設定（親を継承）
    pub indent_style: Option<IndentStyle>,   // Some = 明示的設定
    // ...
}
```

- **Feature flag による条件付き derive**: スキーマ生成を `#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]` で制御し、通常ビルドのコンパイル時間・バイナリサイズに影響を与えない。

- **Deprecated フィールドの宣言的管理**: `#[deserializable(deprecated(use_instead = "formatter.indentWidth"))]` 属性でフィールドの廃止を宣言的に表現し、自動で警告診断を生成する。マイグレーションの段階的移行を設定レベルで支援する。

```rust
// crates/biome_configuration/src/overrides.rs:134-136
#[deserializable(deprecated(use_instead = "formatter.indentWidth"))]
#[bpaf(long("indent-size"), argument("NUMBER"))]
pub indent_size: Option<IndentWidth>,
```

## Anti-Patterns / 注意点

- **設定フィールドの直接アクセスとデフォルト解決の分散**: `unwrap_or_default()` による解決が各アクセサメソッドに分散しており、デフォルト値の定義箇所が型の `Default` 実装に暗黙的に依存する。

```rust
// Bad: デフォルト解決がアクセサに分散
pub fn indent_style_resolved(&self) -> IndentStyle {
    self.indent_style.unwrap_or_default()
}
pub fn indent_width_resolved(&self) -> IndentWidth {
    self.indent_width.unwrap_or_default()
}
```

```rust
// Better: デフォルト値の一元管理
struct FormatterDefaults {
    indent_style: IndentStyle,
    indent_width: IndentWidth,
}
impl FormatterConfiguration {
    pub fn resolve(self, defaults: &FormatterDefaults) -> ResolvedFormatterConfiguration { /* ... */ }
}
```

- **手動デシリアライズと derive の混在**: `FilesConfiguration` は `Deserializable` を手動実装しているが、同じモジュール内の他の構造体は derive を使っている。手動実装が必要なケース（deprecated フィールドのカスタム診断）とそうでないケースの判断基準が暗黙的。deprecated 属性の機能拡張で derive に統一できるか検討すべき。

## 導出ルール

- `[MUST]` 設定フィールドは `Option<T>` で「未設定」を明示的に表現し、「未設定」と「デフォルト値」を区別する
  - 根拠: Biome は全フィールドを `Option` にすることで extends チェーンのマージを型安全に実現している（`crates/biome_configuration/src/lib.rs:105-193`）

- `[MUST]` 設定の継承（extends）を実装する場合、マージのセマンティクスを型ごとに明示的に定義する（プリミティブは上書き、`Option` は再帰マージ、コレクションは結合/上書き）
  - 根拠: `Merge` トレイトの `Option<T>` 実装が「None なら other を採用、Some 同士なら再帰マージ」を型レベルで保証している（`crates/biome_deserialize/src/merge.rs:19-28`）

- `[SHOULD]` 設定のデシリアライズではfail-fast ではなくフォールトトレラント戦略を採り、可能な限り多くの診断を一度に報告する
  - 根拠: `biome_deserialize` は serde の fail-fast を意図的に避け、複数エラーの同時報告を実現している（`crates/biome_deserialize/src/lib.rs:7-9`）

- `[SHOULD]` 設定モデルの定義から JSON Schema・CLI 引数パーサ・シリアライズ/デシリアライズを単一ソースで生成し、仕様の不整合を防ぐ
  - 根拠: `Configuration` 構造体は `Deserializable, Merge, schemars::JsonSchema, Bpaf, Serialize, Deserialize` を一つの定義から derive している（`crates/biome_configuration/src/lib.rs:99-103`）

- `[SHOULD]` deprecated フィールドのマイグレーションは属性マクロで宣言的に管理し、廃止時の警告・代替候補を自動生成する
  - 根拠: `#[deserializable(deprecated(use_instead = "..."))]` が自動でマイグレーション診断を生成する（`crates/biome_deserialize_macros/src/lib.rs:210-227`）

- `[AVOID]` 設定継承の実装で、マージ順序に依存する暗黙的な優先順位を作らない。左から右、子が親を上書きといった規則を文書化しコードで強制する
  - 根拠: Biome は extends リストを左から右に reduce し、最後にカレント設定で上書きする明確な順序を `apply_extends` で実装している（`crates/biome_service/src/configuration.rs:593-606`）

## 適用チェックリスト

- [ ] 設定モデルの全フィールドが `Option<T>` で定義されており、「未設定」と「デフォルト値」が区別されているか
- [ ] 設定の継承・マージのセマンティクスが型ごとに定義されているか（プリミティブ/Option/コレクション）
- [ ] デシリアライズエラーが1箇所で止まらず、可能な限り多くのエラーを一度に報告できるか
- [ ] JSON Schema が設定モデルの定義から自動生成されているか（手書きスキーマとの乖離リスク）
- [ ] deprecated フィールドに対して、廃止警告と代替手段の提示が自動化されているか
- [ ] 複数の設定ソース（ファイル、CLI、外部フォーマット）が統一モデルにマージされる際の優先順位が明確か
- [ ] 設定のバリデーション（相互排他チェック等）がデシリアライズ後に実行される仕組みがあるか
