# IR ベースフォーマッター設計

> リポジトリ: biomejs/biome
> 分析日: 2026-03-09

## 概要

Biome のフォーマッターは、言語非依存の中間表現（IR: Intermediate Representation）を中心に設計されている。AST から IR（`FormatElement`）への変換と、IR からテキストへの印刷（Printer）を明確に分離することで、JavaScript/TypeScript/CSS/JSON/GraphQL/HTML/YAML/Markdown など多数の言語に対して共通のレイアウトアルゴリズムを適用できる。Prettier の「wadler-lindig アルゴリズム」に基づく group/line/indent モデルを採用しつつ、`BestFitting`（複数バリアント最適選択）、`Fill`（行幅充填）、`Interned`（IR 共有による重複排除）といった独自拡張で性能と表現力を両立している。

## 背景にある原則

- **関心の分離による多言語対応**: フォーマッターを「IR 生成（言語固有）」と「IR 印刷（言語非依存）」に分離すべき。これにより新しい言語のサポートは IR 生成部分だけの実装で済み、レイアウトアルゴリズムの再実装が不要になる。Biome は `biome_formatter`（共通基盤）と `biome_js_formatter` 等（言語固有）の crate 分離でこれを実現している。
- **IR サイズが性能を支配する**: フォーマッターの IR はホットデータ構造であり、そのメモリサイズがランタイム性能を直接支配する。`FormatElement` を 24 バイトに収める `static_assert!` が設けられており（`format_element.rs:499`）、サイズ増加には「より効率的なエンコーディングがないか」「後から再計算できないか」を検討する設計指針がコメントに明記されている。
- **先読み計測による最適レイアウト**: 「このグループが 1 行に収まるか」をプリンターが先読み計測（`fits`）し、収まるなら flat モード、収まらなければ expanded モードで印刷する。これにより、IR 生成時にレイアウト判断を行う必要がなく、IR は宣言的にレイアウト意図を記述するだけでよい。

## 実例と分析

### IR 要素の設計: フラットな enum による表現

`FormatElement` は `Space`, `Line`, `Token`, `Text`, `Interned`, `BestFitting`, `Tag` などのバリアントを持つフラットな enum として定義されている。ネスト構造（indent, group 等）は `Tag::StartXxx` / `Tag::EndXxx` ペアで表現される。

```rust
// crates/biome_formatter/src/format_element.rs:20-66
pub enum FormatElement {
    Space,
    HardSpace,
    Line(LineMode),
    ExpandParent,
    Token { text: &'static str },
    Text { text: Box<str>, source_position: TextSize },
    LocatedTokenText { source_position: TextSize, slice: TokenText },
    LineSuffixBoundary,
    Interned(Interned),
    BestFitting(BestFittingVariants),
    Tag(Tag),
}
```

ツリー構造ではなくフラット配列 + タグペアを選択した理由は、メモリ効率とイテレーション性能の最適化にある。ツリーにすると各ノードにポインタが必要になり、キャッシュ局所性も悪化する。

### Token の 3 段階最適化

テキスト表現を 3 種類に分けることで、アロケーションを最小化している:

1. **`Token`**: `&'static str` — 括弧やカンマなど固定文字列。ゼロアロケーション。
2. **`LocatedTokenText`**: `TokenText`（ソーストークンのスライス） — ソースと同一テキストの場合、新規 String を割り当てない。
3. **`Text`**: `Box<str>` — ソースから変換されたテキスト。`String` より 8 バイト節約（コメントに明記: `format_element.rs:38`）。

```rust
// crates/biome_formatter/src/builders.rs:251-258
pub fn token(text: &'static str) -> Token {
    debug_assert!(text.is_ascii(), "Token must be ASCII text only");
    debug_assert!(
        !text.contains(['\n', '\r', '\t']),
        "A token should not contain any newlines or tab characters"
    );
    Token { text }
}
```

### Group + Line モデル: Prettier 互換の宣言的レイアウト

`group` は内部の soft line break をどう扱うかを制御する論理単位。Printer が `fits` で 1 行に収まるか計測し、収まれば `Flat`（soft line break を無視/スペース化）、収まらなければ `Expanded`（改行として出力）で印刷する。

```rust
// crates/biome_formatter/src/format_element.rs:89-99
pub enum LineMode {
    SoftOrSpace,  // flat: space, expanded: newline
    Soft,         // flat: nothing, expanded: newline
    Hard,         // always newline (forces group to expand)
    Empty,        // empty line (double newline)
}
```

この設計により、IR 生成側は「ここにソフト改行を入れたい」と宣言するだけで、実際の改行判断は Printer に委ねられる。

### BestFitting: 複数バリアント最適選択

Prettier にない Biome 独自の拡張。同じ内容に対して複数のレイアウトバリアント（最も flat なものから最も expanded なものまで）を用意し、Printer が行幅に収まる最も flat なバリアントを選択する。

```rust
// crates/biome_formatter/src/printer/mod.rs:445-500
fn print_best_fitting(&mut self, variants: &'a BestFittingVariants, ...) -> PrintResult<()> {
    // 各バリアントを順にテストし、fits なら採用
    for next in variants_iter {
        let variant_fits = self.fits(queue, stack, indent_stack)?;
        if variant_fits {
            queue.extend_back(current);
            return self.print_entry(...);
        }
        current = next;
    }
    // 全バリアントが収まらない場合は最も expanded を使用
    queue.extend_back(current);
}
```

JSX の子要素リスト（`jsx/lists/child_list.rs`）やメンバーチェーン（`utils/member_chain/mod.rs`）など、2 パターン以上のレイアウトが必要な箇所で使用される。

### Interned: IR 共有による重複排除

`Interned` は `Rc<[FormatElement]>` で IR サブツリーを共有する仕組み。`best_fitting!` マクロや `if_group_breaks` / `if_group_fits_on_line` で同じ内容を複数バリアントに含める際、deep clone を回避する。

```rust
// crates/biome_formatter/src/format_element.rs:125-131
pub struct Interned(Rc<[FormatElement]>);

impl PartialEq for Interned {
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)  // ポインタ比較で O(1) 等価判定
    }
}
```

関数ボディのキャッシュ（`utils/function_body.rs`）では、`Interned` を使ってフォーマット結果を保存・再利用し、call arguments の複数レイアウトバリアント生成時の再フォーマットを回避している。

### propagate_expand: ボトムアップの展開伝播

`Document::propagate_expand()` は IR ドキュメント全体を走査し、hard line break や `ExpandParent` を含む子グループの展開状態を親グループに伝播する。`BestFitting` は展開の境界として機能し、内部の展開が外部に漏れないようにする。

```rust
// crates/biome_formatter/src/format_element/document.rs:37-137
pub(crate) fn propagate_expand(&mut self) {
    // BestFitting は境界として機能 — 展開を外部に伝播しない
    // ただし Interned のキャッシュ整合性のため、expands = false は設定しない
}
```

### FormatNodeRule trait: 言語固有の責務分離

各言語の formatter crate は `FormatNodeRule<N>` trait を定義し、AST ノードごとに `fmt_fields` を実装する。trait のデフォルト実装がコメント処理（leading/trailing/dangling）、括弧挿入、suppression チェック、embedded node 処理を統一的に行う。

```rust
// crates/biome_js_formatter/src/lib.rs:357-404
pub(crate) trait FormatNodeRule<N> {
    fn fmt(&self, node: &N, f: &mut JsFormatter) -> FormatResult<()> {
        // suppression check → leading comments → fmt_node → dangling → trailing
    }
    fn fmt_node(&self, node: &N, f: &mut JsFormatter) -> FormatResult<()> {
        // needs_parentheses check → embedded_node_range or fmt_fields
    }
    fn fmt_fields(&self, item: &N, f: &mut JsFormatter) -> FormatResult<()>;
}
```

### Buffer パターン: IR 変換パイプライン

`Buffer` trait を介した IR 書き込みにより、変換フィルタをパイプライン的に適用できる。`RemoveSoftLinesBuffer` は書き込まれる IR から soft line break を除去し、flat バリアントの生成に利用される。`VecBuffer` で一時的に IR を蓄積し、`Interned` として共有する用途にも使われる。

```rust
// crates/biome_formatter/src/buffer.rs:481-495
pub struct RemoveSoftLinesBuffer<'a, Context> {
    inner: &'a mut dyn Buffer<Context = Context>,
    interned_cache: FxHashMap<Interned, Interned>,
    conditional_content_stack: Vec<Condition>,
}
```

## パターンカタログ

- **Interpreter パターン** (分類: 振る舞い)
  - 解決する問題: 言語の文法要素をどうフォーマットするかの知識を各ノードに分散させる
  - 適用条件: AST の各ノード型に対して異なるフォーマット規則が必要な場合
  - コード例: `FormatNodeRule::fmt_fields` の各実装（例: `js/expressions/array_expression.rs`）
  - 注意点: ノード型の数に比例して実装が増えるが、trait のデフォルト実装で共通処理を吸収

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 同じ内容に対して複数のレイアウト戦略を切り替える
  - 適用条件: 行幅に応じて異なるレイアウトを選択する必要がある場合
  - コード例: `BestFittingVariants`（`format_element.rs:297`）、`GroupMode`（`tag.rs:151`）
  - 注意点: バリアント数が多すぎると計測コストが増加する

- **Flyweight パターン** (分類: 構造)
  - 解決する問題: 同一 IR サブツリーの重複によるメモリ浪費
  - 適用条件: 同じフォーマット結果を複数箇所で参照する場合
  - コード例: `Interned`（`format_element.rs:125`）、`FunctionBodyCacheMode`（`utils/function_body.rs:6`）

## Good Patterns

- **IR サイズの静的保証**: `static_assert!(std::mem::size_of::<FormatElement>() == 24usize)` でコンパイル時に IR 要素のサイズを強制する。パフォーマンスクリティカルなデータ構造のサイズ回帰を防ぐ手法として汎用的に適用できる。

```rust
// crates/biome_formatter/src/format_element.rs:497-499
#[cfg(not(debug_assertions))]
#[cfg(target_pointer_width = "64")]
static_assert!(std::mem::size_of::<crate::FormatElement>() == 24usize);
```

- **Token の静的/動的分離**: 固定文字列（括弧、演算子等）は `&'static str` の `Token` として表現し、ソース由来のテキストのみ動的割り当てを行う。フォーマッターが生成するトークンの大半は固定文字列なので、この最適化の効果は大きい。

```rust
// crates/biome_formatter/src/builders.rs:251
pub fn token(text: &'static str) -> Token {
    // debug_assert で ASCII-only + 改行/タブ禁止を保証
}
// crates/biome_formatter/src/builders.rs:279
pub fn text(text: &str, position: TextSize) -> Text<'_> {
    // 動的テキスト用 — ソース位置を追跡
}
```

- **フラット配列 + タグペアによるツリー表現**: ネスト構造を `StartTag`/`EndTag` ペアでフラット配列に埋め込むことで、メモリアロケーションを減らし、線形走査の効率を高めている。XML/HTML パーサーのイベントストリームと同様の発想。

## Anti-Patterns / 注意点

- **IR 生成時のレイアウト判断**: IR 生成フェーズで「1 行に収まるか」を判断してレイアウトを決定すると、ネスト状況や設定変更に対応できなくなる。IR は宣言的にレイアウト意図（group, soft_line_break 等）を記述し、具体的な判断は Printer に委ねるべき。

```rust
// Bad: IR 生成時にレイアウトを決め打ち
if text.len() < 80 {
    write!(f, [token(a), space(), token(b)])
} else {
    write!(f, [token(a), hard_line_break(), token(b)])
}

// Better: 宣言的に記述し、Printer に判断を委ねる
write!(f, [group(&format_args![
    token(a), soft_line_break_or_space(), token(b)
])])
```

- **IR サブツリーの不必要な deep clone**: 同じ内容を複数バリアントで使い回す際に clone すると、メモリ使用量が爆発する。`Interned` で共有するか、`RemoveSoftLinesBuffer` で派生バリアントを効率的に生成すべき。

```rust
// Bad: 同じボディを複数回フォーマット
let variant1 = format!(f, [body.format()]);
let variant2 = format!(f, [body.format()]);

// Better: Interned でキャッシュ・共有
let interned = f.intern(&body.format())?;
// interned を複数バリアントで参照
```

## 導出ルール

- `[MUST]` ホットパスのデータ構造サイズはコンパイル時アサーションで固定する
  - 根拠: Biome は `static_assert!(size_of::<FormatElement>() == 24)` で IR 要素のサイズ回帰を防止している（`format_element.rs:499`）。意図しないフィールド追加によるキャッシュライン浪費を防ぐ。

- `[MUST]` IR 設計では「レイアウト意図の宣言」と「レイアウト判断の実行」を分離する
  - 根拠: Biome の全 formatter は group/line/indent という宣言的 IR を生成するだけで、行幅に基づくレイアウト決定は Printer の `fits` 計測が一元的に行う。この分離により、新しい言語追加時にレイアウトアルゴリズムの再実装が不要になる。

- `[SHOULD]` 固定文字列と動的文字列で異なる表現型を使い分け、不要なアロケーションを避ける
  - 根拠: Biome は `Token`（`&'static str`）と `Text`（`Box<str>`）/ `LocatedTokenText`（ソーストークンスライス）を分離し、括弧・カンマ等の固定トークンではゼロアロケーションを達成している。

- `[SHOULD]` 複数のレイアウトバリアントを持つ場合、IR サブツリーを参照カウントで共有する
  - 根拠: `Interned(Rc<[FormatElement]>)` により、`best_fitting!` マクロや関数ボディキャッシュでの deep clone を回避し、メモリ使用量を抑制している（`format_element.rs:126`, `utils/function_body.rs`）。

- `[SHOULD]` ネスト構造をツリーではなくフラット配列 + 開始/終了タグで表現することを検討する
  - 根拠: Biome は `Tag::StartIndent` / `Tag::EndIndent` ペアでフラット `Vec<FormatElement>` にネスト構造を埋め込み、ポインタ間接参照を排除してキャッシュ効率を高めている。

- `[AVOID]` 変換パイプラインで IR を直接変更する — 代わりに Buffer フィルタで書き込み時に変換する
  - 根拠: `RemoveSoftLinesBuffer` は IR を受け取りながら soft line break を除去する Buffer ラッパーで、完成した IR ツリーを後から書き換えるより効率的かつ安全に派生バリアントを生成できる（`buffer.rs:481`）。

## 適用チェックリスト

- [ ] フォーマッター/コード生成器のホットデータ構造に `static_assert!` 等のサイズアサーションを設けているか
- [ ] IR（または AST）の設計で、レイアウト意図の宣言とレイアウト判断の実行が分離されているか
- [ ] 固定文字列（キーワード、演算子、区切り文字）を `&'static str` 等のゼロコスト表現で扱っているか
- [ ] 同じ IR サブツリーを複数箇所で使い回す場合に、参照共有（Rc/Arc）を使って deep clone を回避しているか
- [ ] ネスト構造の表現方法として、フラット配列 + タグペアが適切かツリー構造が適切か検討したか
- [ ] IR 変換が必要な場合、完成後の書き換えではなく書き込み時のフィルタリングを検討したか
- [ ] Prettier 互換を目指す場合、group/line/indent モデルをベースとし、独自拡張（BestFitting 等）は互換性テストスイートで検証しているか
