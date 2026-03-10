# Pattern: IR サイズの静的アサーション

> 出典: [repos/biomejs/biome](../repos/biomejs/biome/)
> カテゴリ: pattern

## 概要

ホットパスで大量にアロケーション・イテレーションされるデータ構造のメモリサイズを、コンパイル時アサーションで固定するパターン。意図しないフィールド追加やレイアウト変更によるパフォーマンス回帰を、CI の段階で検出できる。Biome のフォーマッター IR（`FormatElement` = 24 バイト）や構文木スロット（`Slot` = 16 バイト）で実践されている。

## 背景・文脈

Biome は JavaScript/TypeScript/CSS 等のフォーマッターを提供しており、フォーマット処理の中核に言語非依存の中間表現（IR）を持つ。この IR 要素 `FormatElement` は 1 ファイルのフォーマットで数万個生成され、`Vec<FormatElement>` として線形に走査される。enum のサイズが 1 バイト増えるだけで、数万要素分のメモリ増加とキャッシュライン効率の悪化が発生する。

同様に、構文木の `Slot` も全ノードの全子要素に対して生成されるため、サイズの固定が重要になる。

Biome ではこれらのサイズを `static_assert!` マクロでコンパイル時に検証し、サイズが変わった場合はコンパイルエラーとして即座に検出する仕組みを採っている。

## 実装パターン

### マクロ定義

Biome の `static_assert!` は、定数除算によるコンパイル時検証を行う最小限のマクロである。条件が `false`（= 0）の場合、ゼロ除算のコンパイルエラーが発生する。

```rust
// crates/biome_rowan/src/utility_types.rs:148-154
#[cfg(target_pointer_width = "64")]
#[macro_export]
macro_rules! static_assert {
    ($expr:expr) => {
        const _: i32 = 0 / $expr as i32;
    };
}
```

### FormatElement への適用

フォーマッター IR のサイズを 24 バイトに固定。設計意図を伝えるコメントが添えられている。

```rust
// crates/biome_formatter/src/format_element.rs:492-499

// Increasing the size of FormatElement has serious consequences on runtime performance and memory footprint.
// Is there a more efficient way to encode the data to avoid increasing its size? Can the information
// be recomputed at a later point in time?
// You reduced the size of a format element? Excellent work!

#[cfg(not(debug_assertions))]
#[cfg(target_pointer_width = "64")]
static_assert!(std::mem::size_of::<crate::FormatElement>() == 24usize);
```

### 関連する内部型への適用

`FormatElement` だけでなく、そのサイズに影響する内部型（`Tag`, `VerbatimKind`）や、構文木のスロット型にも同様のアサーションが設けられている。

```rust
// crates/biome_formatter/src/format_element.rs:482-490
#[cfg(target_pointer_width = "64")]
static_assert!(std::mem::size_of::<biome_rowan::TextRange>() == 8usize);

#[cfg(target_pointer_width = "64")]
static_assert!(std::mem::size_of::<crate::format_element::tag::VerbatimKind>() == 8usize);

#[cfg(not(debug_assertions))]
#[cfg(target_pointer_width = "64")]
static_assert!(std::mem::size_of::<crate::format_element::Tag>() == 16usize);
```

```rust
// crates/biome_rowan/src/green/node.rs:60-61
#[cfg(target_pointer_width = "64")]
static_assert!(mem::size_of::<Slot>() == mem::size_of::<usize>() * 2);
```

### サイズ最適化の具体的手法

`FormatElement` が 24 バイトに収まっている背景には、enum バリアントごとの意識的なサイズ最適化がある。

```rust
// crates/biome_formatter/src/format_element.rs:20-66
pub enum FormatElement {
    Space,                    // 0 バイト（ユニットバリアント）
    HardSpace,                // 0 バイト
    Line(LineMode),           // 1 バイト
    ExpandParent,             // 0 バイト
    Token { text: &'static str },          // 16 バイト（fat pointer）
    Text { text: Box<str>, source_position: TextSize },  // 12 バイト (Box<str>=8 + TextSize=4)
    LocatedTokenText { source_position: TextSize, slice: TokenText },
    LineSuffixBoundary,       // 0 バイト
    Interned(Interned),       // 8 バイト (Rc)
    BestFitting(BestFittingVariants),
    Tag(Tag),                 // 16 バイト
}
```

注目すべき最適化:
- `Text` で `String`（24 バイト）ではなく `Box<str>`（16 バイト）を使い、8 バイト節約
- `Token` は `&'static str` で固定文字列のみを扱い、ヒープアロケーションなし
- `LocatedTokenText` はソーストークンのスライスを再利用し、新規アロケーションを回避

## Good Example

```rust
// ホットデータ構造にサイズアサーションを設ける
pub enum FormatElement {
    Space,
    Line(LineMode),
    Token { text: &'static str },
    Text { text: Box<str>, source_position: TextSize },  // Box<str> で 8 バイト節約
    Interned(Interned),
    Tag(Tag),
}

// 設計意図をコメントで明記し、サイズをコンパイル時に固定
// Increasing the size of FormatElement has serious consequences on runtime
// performance and memory footprint.
#[cfg(not(debug_assertions))]
#[cfg(target_pointer_width = "64")]
static_assert!(std::mem::size_of::<FormatElement>() == 24usize);

// 内部型のサイズも連鎖的に固定
#[cfg(target_pointer_width = "64")]
static_assert!(std::mem::size_of::<Tag>() == 16usize);
```

## Bad Example

```rust
// サイズアサーションなしでは、フィールド追加時にサイズ回帰を見落とす
pub enum FormatElement {
    Space,
    Line(LineMode),
    Token { text: String },         // String は 24 バイト — enum 全体を 32 バイトに押し上げる
    Text { text: String, source_position: TextSize, kind: TextKind },  // フィールド追加もフリーパス
    Interned(Interned),
    Tag(Tag),
}
// コンパイルは通るが、数万要素の Vec で数十 KB のメモリ増加 + キャッシュミス増加
```

## 適用ガイド

### どのような状況で使うべきか

- **大量にインスタンス化されるデータ構造**: IR ノード、AST ノード、トークン、イベント型など、1 ファイルの処理で数千〜数万個生成されるもの
- **配列やベクターに格納されて線形走査されるもの**: `Vec<T>` のイテレーションでは要素サイズがキャッシュ効率を直接支配する
- **パフォーマンスクリティカルなホットパス上にあるもの**: プロファイリングでボトルネックと判明した、または潜在的にボトルネックになりうる構造

### 導入時の注意点

- **`#[cfg(target_pointer_width = "64")]`** を付与する。32-bit 環境ではポインタサイズが異なるため、サイズアサーションの値が変わる
- **`#[cfg(not(debug_assertions))]`** が必要な場合がある。debug ビルドでは enum に追加のメタデータが付与されてサイズが変わることがある
- **内部型にも連鎖的にアサーションを設ける**。外側の enum だけ固定しても、内部型のサイズ変化は見落とされる
- **設計意図をコメントで説明する**。サイズを変更したい開発者が「なぜ固定されているか」「代替手段は何か」を理解できるようにする

### 他言語での応用

- **TypeScript**: ランタイムで `sizeof` は使えないが、ベンチマークテストで構造体のプロパティ数やシリアライズ後のバイト数を検証できる
- **Go**: `unsafe.Sizeof` をテスト内で検証する

```go
func TestNodeSize(t *testing.T) {
    if size := unsafe.Sizeof(Node{}); size != 48 {
        t.Errorf("Node size changed: got %d, want 48", size)
    }
}
```

- **C/C++**: `static_assert(sizeof(Node) == 24, "Node size must be 24 bytes")` が標準で利用可能

### カスタマイズポイント

- アサーション値は実測値に合わせて設定する。目標サイズが先にあるのではなく、最適化した結果のサイズを固定する
- キャッシュラインサイズ（通常 64 バイト）を意識し、ホットデータ構造がキャッシュラインに何個入るかを基準にできる（24 バイトなら 2 要素/ライン、32 バイトなら 2 要素/ライン、48 バイトなら 1 要素/ライン）

## 参考

- [repos/biomejs/biome/ir-formatter-design.md](../repos/biomejs/biome/ir-formatter-design.md) -- FormatElement の 24 バイト固定設計
- [repos/biomejs/biome/performance-techniques.md](../repos/biomejs/biome/performance-techniques.md) -- パフォーマンス最適化手法全般
- [repos/biomejs/biome/cst-and-syntax-model.md](../repos/biomejs/biome/cst-and-syntax-model.md) -- CST ノードのサイズ最適化
