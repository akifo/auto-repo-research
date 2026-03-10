# CST and Syntax Model

> リポジトリ: biomejs/biome
> 分析日: 2026-03-09

## 概要

Biome の CST（Concrete Syntax Tree）は rust-analyzer の Rowan ライブラリをフォークした `biome_rowan` を基盤とし、JS/TS/CSS/JSON/GraphQL/HTML/Markdown/YAML/Tailwind/GritQL の10言語を統一的に扱う。注目すべきは、`.ungram` ファイルから型安全なノードアクセサ・ファクトリ・ミューテーションメソッドをすべてコード生成する設計と、構文エラーを Bogus ノードで吸収して常に完全な木を維持する「ロスレス CST」のアプローチである。Green/Red ツリー分離による不変性とメモリ効率、スロットベースの子ノードアクセスによるエラー耐性がコードベース全体を貫く設計原則となっている。

## 背景にある原則

- **ロスレス性の保証**: CST は空白・コメント・構文エラーを含むすべての情報を保持すべきである。AST（Abstract Syntax Tree）のように情報を捨てると、フォーマッタやリファクタリングツールが元のソースを忠実に再現できない。Biome は trivia（空白・コメント）をトークンに付随させることでこれを実現している（`crates/biome_rowan/src/syntax/trivia.rs`）。

- **Green/Red 分離による不変共有**: 構文木を不変の Green Tree（データ所有）と遅延構築の Red Tree（親ポインタ・位置情報）に分離すべきである。Green ノードが不変であれば、同一構造のサブツリーを参照共有でき、`NodeCache` によるインターニングでメモリ使用量を大幅に削減できる（`crates/biome_rowan/src/green/node_cache.rs`）。

- **スロットベースのアクセスでエラー耐性を確保**: ノードの子要素を位置（スロットインデックス）でアクセスし、欠損スロットを `None`/`SyntaxResult::Err` として表現すべきである。これにより、パーサーがエラー回復した不完全なノードでも型安全にアクセスでき、すべてのフィールドが `Option` または `SyntaxResult` になることでエラー処理が呼び出し側に強制される（`crates/biome_rowan/src/ast/mod.rs:956-1003`）。

- **文法駆動コード生成で一貫性を担保**: ノード定義・アクセサ・ファクトリ・ミューテーションを手書きせず、単一の文法定義（`.ungram`）から生成すべきである。手書きはノード構造とアクセサの不整合を招く。Biome は `biome_syntax_codegen` クレートで nodes.rs / nodes_mut.rs / node_factory.rs / syntax_factory.rs / kind.rs / macros.rs の6種類のファイルを言語ごとに生成している（`crates/biome_syntax_codegen/src/lib.rs`）。

## 実例と分析

### 三層アーキテクチャ: Green Tree → Red Tree (SyntaxNode) → Typed AST

Biome の CST は3つの抽象レベルで構成される。最下層の **Green Tree** は不変のデータ構造で、`GreenNode` と `GreenToken` から成る。中間層の **SyntaxNode/SyntaxToken**（Red Tree）は Green Tree のラッパーで、親ポインタとテキスト位置を遅延計算する。最上層の **Typed AST**（例: `JsIfStatement`）は SyntaxNode の newtype ラッパーで、`can_cast` による型チェックでゼロコスト変換する。

```rust
// crates/biome_rowan/src/syntax/node.rs:18-21
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct SyntaxNode<L: Language> {
    raw: cursor::SyntaxNode,
    _p: PhantomData<L>,
}
```

```rust
// crates/biome_js_syntax/src/generated/nodes.rs:23-25
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct JsAccessorModifier {
    pub(crate) syntax: SyntaxNode,
}
```

変換コストがゼロである理由は、Typed AST ノードが内部に `SyntaxNode` をそのまま保持し、`can_cast` によるランタイム型チェックのみで切り替えるためである。

### Language トレイトによる言語パラメタライズ

各言語は `Language` トレイトを実装する marker type として定義される。これにより `SyntaxNode<L>` という単一の型で全言語をカバーしつつ、型レベルで言語間の混同を防ぐ。

```rust
// crates/biome_rowan/src/syntax.rs:61-64
pub trait Language: Sized + Clone + Copy + fmt::Debug + Eq + Ord + std::hash::Hash {
    type Kind: SyntaxKind;
    type Root: AstNode<Language = Self> + Clone + Eq + fmt::Debug;
}
```

```rust
// crates/biome_js_syntax/src/syntax_node.rs:13-20
pub struct JsLanguage;
impl Language for JsLanguage {
    type Kind = JsSyntaxKind;
    type Root = AnyJsRoot;
}
pub type JsSyntaxNode = biome_rowan::SyntaxNode<JsLanguage>;
```

CSS、JSON、GraphQL など全言語が同じパターンで定義されている（`crates/biome_css_syntax/src/syntax_node.rs` 等）。

### スロットベースアクセスと support モジュール

生成されたノードのフィールドアクセスは、スロットインデックスを指定して `support::required_token` / `support::node` / `support::list` を呼ぶ形になる。必須フィールドは `SyntaxResult<T>`、省略可能フィールドは `Option<T>` を返す。

```rust
// crates/biome_rowan/src/ast/mod.rs:956-973
pub fn node<L: Language, N: AstNode<Language = L>>(
    parent: &SyntaxNode<L>,
    slot_index: usize,
) -> Option<N> {
    match parent.slots().nth(slot_index)? {
        SyntaxSlot::Empty { .. } => None,
        SyntaxSlot::Node(node) => Some(N::unwrap_cast(node)),
        SyntaxSlot::Token(token) => {
            panic!("expected a node in the slot {slot_index} but found token {token:?}")
        }
    }
}

pub fn required_node<L: Language, N: AstNode<Language = L>>(
    parent: &SyntaxNode<L>,
    slot_index: usize,
) -> SyntaxResult<N> {
    self::node(parent, slot_index).ok_or(SyntaxError::MissingRequiredChild)
}
```

### Bogus ノードによるエラー回復

構文エラーが発生した箇所は `JsBogus` / `JsBogusStatement` / `JsBogusExpression` 等のカテゴリ別 Bogus ノードに変換される。`SyntaxKind::to_bogus()` がノードの文法的な位置に応じた適切な Bogus kind を返す設計により、エラー回復後も型安全な走査が可能。

```rust
// crates/biome_js_syntax/src/lib.rs:116-132
fn to_bogus(&self) -> Self {
    match self {
        kind if AnyJsModuleItem::can_cast(*kind) => JS_BOGUS_STATEMENT,
        kind if AnyJsExpression::can_cast(*kind) => JS_BOGUS_EXPRESSION,
        kind if AnyJsBinding::can_cast(*kind) => JS_BOGUS_BINDING,
        // ...
        _ => JS_BOGUS,
    }
}
```

### SyntaxFactory と RawNodeSlots による構文検証

パーサーが構築したノードは `SyntaxFactory::make_syntax` を通して検証される。`RawNodeSlots<N>` は const generic でスロット数を固定し、各スロットに正しい kind の子が入っているかを検査する。検証に失敗するとノードは自動的に Bogus に降格する。

```rust
// crates/biome_rowan/src/syntax_factory.rs:197-210
pub struct RawNodeSlots<const COUNT: usize> {
    slots: [SlotContent; COUNT],
    current_slot: usize,
}
```

```rust
// crates/biome_js_factory/src/generated/syntax_factory.rs:27-45
JS_ACCESSOR_MODIFIER => {
    let mut elements = (&children).into_iter();
    let mut slots: RawNodeSlots<1usize> = RawNodeSlots::default();
    let mut current_element = elements.next();
    if let Some(element) = &current_element
        && element.kind() == T![accessor]
    {
        slots.mark_present();
        current_element = elements.next();
    }
    slots.next_slot();
    if current_element.is_some() {
        return RawSyntaxNode::new(
            JS_ACCESSOR_MODIFIER.to_bogus(),
            children.into_iter().map(Some),
        );
    }
    slots.into_node(JS_ACCESSOR_MODIFIER, children)
}
```

### _ext パターンによるセマンティック拡張

生成コードに手書きのセマンティックメソッドを追加する場合、`*_ext.rs` ファイル（例: `expr_ext.rs`, `stmt_ext.rs`）を別モジュールとして定義する。これにより生成ファイルと手書きファイルが競合せず、再生成しても手書きコードが失われない。

```rust
// crates/biome_js_syntax/src/expr_ext.rs:65-78
impl JsReferenceIdentifier {
    pub fn is_undefined(&self) -> bool {
        self.has_name(UNDEFINED)
    }
}
```

### declare_node_union! マクロによるアドホックユニオン型

生成された文法上のユニオン（`AnyJsExpression` 等）に加え、特定のルールやユーティリティで必要なアドホックなユニオン型を `declare_node_union!` マクロで宣言できる。このマクロは `AstNode` trait の実装を自動生成し、`KIND_SET` の合成も行う。

```rust
// crates/biome_js_syntax/src/expr_ext.rs:28-30
declare_node_union! {
    pub JsNewOrCallExpression = JsNewExpression | JsCallExpression
}
```

### ノードファクトリの二重構造: node_factory と make

コード生成された `node_factory.rs` は必須フィールドを引数に取る関数と、省略可能フィールドを `with_*` メソッドで追加する Builder パターンを提供する。手書きの `make.rs` はトークン生成ヘルパー（`ident()`, `token()` 等）や便利ファクトリ（`parenthesized()` 等）を追加する。

```rust
// crates/biome_js_factory/src/generated/node_factory.rs:28-55
pub fn js_array_assignment_pattern_element(
    pattern: AnyJsAssignmentPattern,
) -> JsArrayAssignmentPatternElementBuilder {
    JsArrayAssignmentPatternElementBuilder { pattern, init: None }
}
pub struct JsArrayAssignmentPatternElementBuilder {
    pattern: AnyJsAssignmentPattern,
    init: Option<JsInitializerClause>,
}
impl JsArrayAssignmentPatternElementBuilder {
    pub fn with_init(mut self, init: JsInitializerClause) -> Self {
        self.init = Some(init);
        self
    }
    pub fn build(self) -> JsArrayAssignmentPatternElement { /* ... */ }
}
```

### nodes_mut.rs による不変的ミューテーション

各ノードに `with_*` メソッドが生成され、`splice_slots` を使ってスロットを置換した新しいノードを返す。元のノードは変更されない（不変データ構造）。

```rust
// crates/biome_js_syntax/src/generated/nodes_mut.rs:14-32
impl JsArrayAssignmentPattern {
    pub fn with_l_brack_token(self, element: SyntaxToken) -> Self {
        Self::unwrap_cast(
            self.syntax.splice_slots(0usize..=0usize, once(Some(element.into()))),
        )
    }
}
```

## パターンカタログ

- **Flyweight パターン** (構造)
  - 解決する問題: 数万ノードの構文木でメモリを浪費する
  - 適用条件: 同一構造のサブツリーが頻出する場合
  - コード例: `crates/biome_rowan/src/green/node_cache.rs` — `NodeCache` が同一の Green ノードをインターニングして参照共有
  - 注意点: キャッシュのライフサイクル管理が必要（世代管理で解決）

- **Newtype / Phantom Type パターン** (構造)
  - 解決する問題: 異なる言語の SyntaxNode を混同する
  - 適用条件: 単一の汎用型を言語ごとに型安全に分離したい場合
  - コード例: `crates/biome_rowan/src/syntax/node.rs:18-21` — `PhantomData<L>` で言語をパラメタライズ
  - 注意点: ゼロコストだが、型パラメータの伝播がコード全体に及ぶ

- **Builder パターン** (生成)
  - 解決する問題: 必須/省略可能フィールドが混在するノードの構築
  - 適用条件: コンストラクタの引数が多く、一部がオプショナルな場合
  - コード例: `crates/biome_js_factory/src/generated/node_factory.rs:36-55` — 必須引数で Builder を生成し `with_*` でオプション追加
  - 注意点: 必須引数は関数引数、省略引数は `with_*` と明確に分離する

## Good Patterns

- **文法定義とコードの単一ソース化**: `.ungram` ファイルから6種類のコードを生成することで、ノード定義・アクセサ・ファクトリ・ミューテーション・マクロ間の不整合を構造的に防いでいる。手書きの拡張は `_ext.rs` / `make.rs` に分離されるため、生成と手書きが衝突しない。

- **カテゴリ別 Bogus ノード**: `JsBogus` だけでなく `JsBogusStatement` / `JsBogusExpression` 等のカテゴリ別 Bogus を用意することで、エラー回復後もユニオン型（`AnyJsStatement` 等）の型安全性を維持している。`to_bogus()` の実装（`crates/biome_js_syntax/src/lib.rs:116-132`）が文法カテゴリに応じた Bogus kind を自動選択する。

- **SyntaxResult による段階的エラー処理**: 必須フィールドのアクセスが `SyntaxResult<T>` を返すことで、構文エラーの有無に関わらず同じコードパスでノードを処理できる。呼び出し側は `?` 演算子で早期リターンするか、個別にハンドリングするかを選べる。

## Anti-Patterns / 注意点

- **スロットインデックスのハードコーディング**: スロットインデックスを手書きでマジックナンバーとして使うと、文法変更時にサイレントに壊れる。Biome ではコード生成でインデックスを管理しているが、手書きの `_ext.rs` でスロットに直接アクセスする場合は注意が必要。

```rust
// Bad: マジックナンバーで直接アクセス
let name = parent.element_in_slot(2);

// Better: 生成されたアクセサメソッドを使う
let name = node.name();
```

- **Bogus ノードの無視**: Bogus ノードを考慮せずに木を走査すると、構文エラーのあるファイルで予期しないパニックやスキップが発生する。リントルールやフォーマッタは必ず Bogus ノードの存在を前提に設計する必要がある。

```rust
// Bad: Bogus を考慮しない
fn analyze(expr: AnyJsExpression) {
    match expr {
        AnyJsExpression::JsBinaryExpression(bin) => { /* ... */ }
        // Bogus 系バリアントが未処理
        _ => unreachable!(), // パニックする
    }
}

// Better: Bogus を明示的にハンドリング
fn analyze(expr: AnyJsExpression) -> Option<Result> {
    match expr {
        AnyJsExpression::JsBinaryExpression(bin) => { /* ... */ }
        AnyJsExpression::JsBogusExpression(_) => None, // エラーノードはスキップ
        _ => None,
    }
}
```

## 導出ルール

- `[MUST]` 構文木ライブラリでは、ノードの子要素アクセスを位置ベースのスロットで管理し、欠損スロットを型レベルで表現する（`Option` / `Result`）
  - 根拠: Biome の `support::required_node` / `support::node` は全フィールドのアクセスをスロットインデックス + `SyntaxResult`/`Option` で統一し、エラー回復した不完全ノードでもパニックせずに処理できる（`crates/biome_rowan/src/ast/mod.rs:956-1003`）

- `[MUST]` コード生成で生成されるファイルと手書きの拡張ファイルを物理的に分離し、生成ファイルには "Generated file, do not edit by hand" ヘッダを付与する
  - 根拠: Biome は `generated/nodes.rs`（生成）と `expr_ext.rs`（手書き）を明確に分離し、10言語 x 6種類のファイルを安全に再生成している（`crates/biome_syntax_codegen/src/lib.rs`）

- `[SHOULD]` 構文木の不変性を維持し、変更操作は新しいノードを返す関数（`with_*` / `replace_node`）として提供する
  - 根拠: `nodes_mut.rs` の `with_*` メソッドは `splice_slots` で新ノードを生成して返し、元のノードを変更しない。これにより Green Tree のインターニングとキャッシュが安全に機能する（`crates/biome_js_syntax/src/generated/nodes_mut.rs`）

- `[SHOULD]` 多言語対応のツリーライブラリでは、言語を型パラメータ（Phantom Type）として表現し、異なる言語のノードの混同をコンパイル時に防ぐ
  - 根拠: `SyntaxNode<L: Language>` の `PhantomData<L>` により `JsSyntaxNode` と `CssSyntaxNode` は異なる型になり、言語間の混同がコンパイルエラーになる（`crates/biome_rowan/src/syntax/node.rs:18-21`）

- `[SHOULD]` エラー回復用のノード型（Bogus）は文法カテゴリごとに細分化し、ユニオン型の型安全性を維持する
  - 根拠: `JsBogusStatement` は `AnyJsStatement` のバリアントとして有効だが `AnyJsExpression` のバリアントではない。カテゴリ別にすることで、エラーノードが不適切な文脈に混入しない（`crates/biome_js_syntax/src/lib.rs:116-132`）

- `[AVOID]` 生成されたアクセサを迂回してスロットインデックスに直接アクセスすること — 文法変更時にサイレントバグを招く
  - 根拠: `support::node(parent, slot_index)` はインデックスミスで型違いの子を取得するとパニックするが、文法変更でインデックスがずれた場合は別のフィールドを黙って返す可能性がある

## 適用チェックリスト

- [ ] 構文木の設計で Green/Red 分離（不変データ + 遅延計算ラッパー）を検討したか
- [ ] ノードの子要素アクセスで、欠損を `Option`/`Result` として型レベルで表現しているか
- [ ] 文法定義から複数種類のコード（ノード型・アクセサ・ファクトリ・ミューテーション）を一括生成しているか
- [ ] 生成コードと手書き拡張コードが物理的に分離されているか
- [ ] エラー回復用のノード型を文法カテゴリごとに細分化しているか
- [ ] ノードの変更操作が不変的（新しいノードを返す）であるか
- [ ] 多言語対応の場合、言語を Phantom Type でパラメタライズして型安全性を確保しているか
- [ ] `declare_node_union!` のようなアドホックユニオン生成の仕組みが必要か検討したか
