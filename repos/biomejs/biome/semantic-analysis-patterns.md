# セマンティック分析パターン

> リポジトリ: biomejs/biome
> 分析日: 2026-03-09

## 概要

Biome は JS/TS・CSS・GraphQL の 3 言語に対してセマンティックモデルを構築し、スコープ・バインディング・参照・型情報・モジュールグラフを統一的な設計パターンで管理している。注目に値するのは、(1) イベント駆動の二段階構築（AST 走査 → イベント → ビルダー → イミュータブルモデル）、(2) `Arc` による所有権分離で API ハンドルをモデルから独立して生存させる設計、(3) 型解決を resolver レベル（Local / Thin / Full / Global）で段階化し推論コストを制御する戦略、(4) 言語横断で同一の Facade + Builder パターンを反復適用している点である。

## 背景にある原則

- **構築と参照の分離**: セマンティックモデルは構築フェーズ（mutable なビルダー）と参照フェーズ（immutable な `Arc` 共有データ）を厳密に分離している。これにより構築後のモデルはスレッドセーフに共有でき、API ハンドル（`Scope`, `Binding`, `Reference`）がモデル本体のライフタイムに依存しない。コンパイラやリンターのようなツールでは、解析結果を複数のルールやフェーズで並行利用する必要があるため、この分離は必然的に求められる。

- **段階的精度向上（Progressive Refinement）**: 型解決を Local → Thin（モジュール内） → Full（モジュール間）→ Global の 4 レベルに分割し、必要な精度だけコストを払う。`TypeResolverLevel` enum でこのレベルを 2 ビットに収め、`ResolvedTypeId` を 8 バイトに抑える設計は、「精度は段階的に上げられるが、常に最大精度で計算しない」という原則の体現である（`crates/biome_js_type_info/src/resolver.rs:230-265`）。

- **イベント駆動によるレイヤー分離**: AST ノードの走査ロジック（`SemanticEventExtractor`）とモデル構築ロジック（`SemanticModelBuilder`）をイベント enum で疎結合にしている。これにより、走査ロジックを変更してもビルダー側への影響を最小化でき、テスト時にイベント列を直接注入してビルダーを検証できる。

- **ハンドルパターンによる間接参照**: `Scope`・`Binding`・`Reference` 等の API 型は実データへのポインタではなく `Arc<Data> + Id` のペアとして実装されている。これにより借用チェッカーとの闘いを回避しつつ、ユーザーがハンドルを自由にコピー・保持できる。

## 実例と分析

### 二段階構築: イベント抽出 → ビルダー → イミュータブルモデル

JS セマンティックモデルの構築は 3 つの明確なフェーズに分かれる:

1. **イベント抽出**: `SemanticEventExtractor` が AST の pre-order 走査中に `SemanticEvent` を発行する
2. **ビルダー蓄積**: `SemanticModelBuilder` がイベントを消費し、内部の `Vec` / `FxHashMap` に蓄積する
3. **モデル確定**: `build()` 呼び出しで `SemanticModelData` を `Arc` で包み、イミュータブルな `SemanticModel` を返す

この同一パターンが CSS（`SemanticEventExtractor` → `SemanticModelBuilder`）と GraphQL でも反復される。

```rust
// crates/biome_js_semantic/src/semantic_model/builder.rs:340-370
pub fn build(self) -> SemanticModel {
    let data = SemanticModelData {
        root: self.root.syntax().as_send().expect("To be a root node"),
        scopes: self.scopes,
        scope_by_range: Lapper::new(
            self.scope_range_by_start
                .iter()
                .flat_map(|(_, scopes)| scopes.iter())
                .cloned()
                .collect(),
        ),
        // ... 他のフィールド
    };
    SemanticModel::new(data)
}
```

### Arc + Id ハンドルパターン

すべての API ハンドル（`Scope`, `Binding`, `Reference`, `Closure` など）が `Arc<SemanticModelData>` と ID のペアで構成されている。これは GraphQL セマンティックモデルでは `Rc` が使われている点で差異がある（`Rc` は `Send` を実装しないため、シングルスレッド前提の文脈で使用）。

```rust
// crates/biome_js_semantic/src/semantic_model/scope.rs:30-33
pub struct Scope {
    pub(crate) data: Arc<SemanticModelData>,
    pub(crate) id: ScopeId,
}
```

```rust
// crates/biome_graphql_semantic/src/semantic_model/model.rs:70-72
pub struct SemanticModel {
    pub(crate) data: Rc<SemanticModelData>,
}
```

### NonZeroU32 によるニッチ最適化

`ScopeId` は `NonZeroU32` を内部表現に使い、`Option<ScopeId>` が追加メモリなしで niche 最適化される。値に +1 のオフセットを適用することで 0 を避けつつ順序を保存している。XOR 方式（nonmax crate）を採用しなかった理由がコメントで明記されている。

```rust
// crates/biome_js_semantic/src/semantic_model/model.rs:42-67
pub struct ScopeId(pub(crate) std::num::NonZeroU32);

impl ScopeId {
    pub const fn new(index: usize) -> Self {
        // Adding 1 ensures that the value is never equal to 0.
        // Instead of adding 1, we could XOR the value with `u32::MAX`.
        // This is what the nonmax crate does.
        // However, this doesn't preserve the order.
        Self(unsafe { std::num::NonZeroU32::new_unchecked(index.unchecked_add(1) as u32) })
    }
}
```

### 区間木によるスコープ検索

スコープの空間的な包含関係の検索に `rust_lapper::Lapper`（区間木）を使用している。ネストしたスコープの中から「最も狭い」スコープを特定するために、`find()` で重なる区間を列挙し、`max()` で最も深いスコープを選択する。

```rust
// crates/biome_js_semantic/src/semantic_model/model.rs:134-151
pub(crate) fn scope(&self, range: TextRange) -> ScopeId {
    let scopes = self.scope_by_range
        .find(start, end)
        .filter(|x| !(start < x.start || end > x.stop));
    match scopes.map(|x| x.val).max() {
        Some(val) => val,
        None => unreachable!("Expected global scope not present"),
    }
}
```

### TypeStore: ハッシュセット + ベクタの二重インデックス

型データの格納に `Vec<Arc<TypeData>>` と `HashTable<usize>` を組み合わせた `TypeStore` を使用。`TypeId`（インデックス）による O(1) ルックアップと、`TypeData` の内容によるハッシュベースの重複検出を両立している。重複排除（`deduplicate`）はオプショナルで、型フラッティング後に呼ばれる。

```rust
// crates/biome_js_type_info/src/type_store.rs:29-32
pub struct TypeStore {
    types: Vec<Arc<TypeData>>,
    table: HashTable<usize>,
}
```

### 型解決の段階化

`TypeResolverLevel` は 4 段階で、2 ビットに収まるように設計されている。`ResolvedTypeId` は `ResolverId`（レベル + モジュール ID、上位 2 ビット + 下位 30 ビット）と `TypeId` の 8 バイト構造体。この設計により、型参照がどのモジュール・どのレベルで解決されたかを単一の 8 バイト値で追跡できる。

```rust
// crates/biome_js_type_info/src/resolver.rs:229-265
pub enum TypeResolverLevel {
    Full,   // モジュール間解決
    Thin,   // モジュール内解決
    Import, // インポート処理用
    Global, // グローバル定義
}
```

### Extension Trait による API 拡張

`SemanticScopeExtensions`, `BindingExtensions`, `ReferencesExtensions`, `ClosureExtensions` など、AST ノード型にセマンティック操作を追加する extension trait が体系的に定義されている。これにより `node.scope(&model)` のような自然な呼び出しが可能になる。

```rust
// crates/biome_js_semantic/src/semantic_model/scope.rs:245-263
pub trait SemanticScopeExtensions {
    fn scope(&self, model: &SemanticModel) -> Scope;
    fn scope_hoisted_to(&self, model: &SemanticModel) -> Option<Scope>;
}

impl<T: AstNode<Language = JsLanguage>> SemanticScopeExtensions for T {
    fn scope(&self, model: &SemanticModel) -> Scope {
        model.scope(self.syntax())
    }
}
```

### SmallVec による局所最適化

バインディングのエクスポート情報に `SmallVec<[TextSize; 4]>` を使用。「ほとんどのバインディングは 1 回しかエクスポートされない」というヒューリスティックに基づき、ヒープ割り当てを回避している。

```rust
// crates/biome_js_semantic/src/semantic_model/binding.rs:12-13
pub(crate) struct SemanticModelBindingData {
    // We use a SmallVec because most of the time a binding is expected once.
    pub(crate) export_by_start: smallvec::SmallVec<[TextSize; 4]>,
}
```

## パターンカタログ

- **Facade パターン** (構造)
  - 解決する問題: 複雑な内部データ構造（スコープ、バインディング、参照の相互関係）を単一の統一インターフェースで隠蔽する
  - 適用条件: 内部に複数の関連データ構造があり、利用者は個別の構造を意識したくない場合
  - コード例: `crates/biome_js_semantic/src/semantic_model/model.rs:180-183` (`SemanticModel`)
  - 注意点: Facade が肥大化しやすい。Biome では `Scope` / `Binding` / `Reference` 各ハンドルに責務を分散させることで緩和している

- **Builder パターン** (生成)
  - 解決する問題: 複雑なオブジェクトの段階的な構築とバリデーション
  - 適用条件: 構築プロセスが複数ステップに分かれ、途中状態と完成状態で型安全性を保ちたい場合
  - コード例: `crates/biome_js_semantic/src/semantic_model/builder.rs:13-30` (`SemanticModelBuilder`)
  - 注意点: `build()` で所有権を消費する（`self` を move する）ため、構築後のビルダー再利用を型レベルで防止している

- **Flyweight パターン** (構造)
  - 解決する問題: 大量の類似オブジェクト（スコープ、バインディング）のメモリ効率
  - 適用条件: 共有可能な内部状態と固有の外部状態（ID）を分離できる場合
  - コード例: `Scope { data: Arc<SemanticModelData>, id: ScopeId }` — 全ハンドルが同一の `Arc` を共有し、ID だけが異なる

- **Strategy パターン** (振る舞い)
  - 解決する問題: 型解決のアルゴリズムをレベル別に差し替える
  - 適用条件: 同じインターフェースで異なる解決戦略（Local / Thin / Full）を実装する必要がある場合
  - コード例: `crates/biome_js_type_info/src/resolver.rs:539` (`trait TypeResolver`)

## Good Patterns

- **イベント駆動の二段階構築**: AST 走査→イベント列→ビルダー→イミュータブルモデルという構築パイプラインにより、走査ロジックとモデル構築ロジックが完全に分離される。テスト時にイベント列を直接注入でき、各フェーズを独立してテスト可能。3 言語すべてで同一パターンが適用されている。

```rust
// crates/biome_js_semantic/src/events.rs:21-46
pub enum SemanticEvent {
    DeclarationFound { range: TextRange, scope_id: ScopeId, hoisted_scope_id: Option<ScopeId> },
    Read { range: TextRange, declaration_at: TextSize, scope_id: ScopeId },
    HoistedRead { range: TextRange, declaration_at: TextSize, scope_id: ScopeId },
    // ...
}
```

- **ビットパッキングによる ID 設計**: `ResolvedTypeId` が resolver レベル（2 ビット）+ モジュール ID（30 ビット）+ 型 ID（32 ビット）を 8 バイトに収める。`Option<ScopeId>` が `NonZeroU32` のニッチ最適化で追加コストゼロ。大量のIDを扱う解析ツールではメモリ効率が直接性能に影響する。

```rust
// crates/biome_js_type_info/src/resolver.rs:122
pub struct ResolverId(u32); // 上位 2 bit: level, 下位 30 bit: module_id
```

- **Extension Trait による AST ノードの機能拡張**: セマンティックモデルの機能を AST ノード型に自然に統合する。`node.scope(&model)` と `model.scope(node)` の両方のアクセスパスを提供し、利用者のコンテキストに合わせた呼び出しを可能にする。

## Anti-Patterns / 注意点

- **Arc クローンの頻発**: 各ハンドル生成時に `Arc::clone()` が発生する。参照カウントの atomic 操作は軽量だが、ホットパスで大量のハンドルを生成する場合はプロファイリングが必要。Biome のケースでは lint ルールごとにモデル参照が必要なため許容されている。

```rust
// Bad: ループ内で大量のハンドルを一時生成
for scope in model.scopes() {
    for binding in scope.bindings() {
        for reference in binding.all_references() {
            // 3 段ネストで毎回 Arc::clone
        }
    }
}

// Better: 必要なデータを ID レベルで収集し、ハンドル生成を最小化
let binding_ids: Vec<BindingId> = /* collect IDs first */;
```

- **`unsafe` による ID 構築の安全性前提**: `ScopeId::new()` は `unchecked_add` と `new_unchecked` を使用し、「ファイルが `u32::MAX` バイトを超えない」という前提に依存している。この前提はコメントで文書化されているが、型レベルでは強制されない。

```rust
// Bad: 前提条件の文書化なしに unsafe を使用
Self(unsafe { std::num::NonZeroU32::new_unchecked(index as u32 + 1) })

// Better: Biome の実装のように SAFETY コメントで前提条件を明記
// SAFETY: We didn't handle files exceeding `u32::MAX` bytes.
// Thus, it isn't possible to exceed `u32::MAX` scopes.
Self(unsafe { std::num::NonZeroU32::new_unchecked(index.unchecked_add(1) as u32) })
```

## 導出ルール

- `[MUST]` セマンティックモデルの構築フェーズと参照フェーズを型レベルで分離する — ビルダーは `build()` で所有権を消費し、構築後のモデルは immutable にする
  - 根拠: Biome の 3 言語すべてで `Builder::build(self) -> Model` パターンが適用され、構築後の不変性が保証されている（`builder.rs:340`）

- `[MUST]` 解析結果のハンドル型は共有データ（`Arc`/`Rc`）+ ID のペアで構成し、借用ライフタイムを含めない
  - 根拠: `Scope`, `Binding`, `Reference` すべてが `Arc<Data> + Id` 構成で、モデル本体よりも長く生存可能（`scope.rs:30-33`）

- `[SHOULD]` AST 走査とセマンティック情報の構築をイベント enum で疎結合にする
  - 根拠: `SemanticEvent` enum が 3 言語で独立に定義され、走査ロジックとビルダーが別モジュールに分離されている（`events.rs`, `builder.rs`）

- `[SHOULD]` 大量に生成される ID 型にはビットパッキングや `NonZero*` ニッチ最適化を適用し、`Option<Id>` のメモリコストをゼロにする
  - 根拠: `ScopeId(NonZeroU32)` により `Option<ScopeId>` が 4 バイトに収まる。`ResolvedTypeId` は 8 バイトにレベル + モジュール ID + 型 ID を収容（`model.rs:42-67`, `resolver.rs:31`）

- `[SHOULD]` 型解決・推論の精度をレベル分けし、必要な精度だけコストを払えるようにする
  - 根拠: `TypeResolverLevel` の 4 段階設計により、単一ファイルの lint では Thin 解決で済み、クロスファイル解析時のみ Full 解決が走る（`resolver.rs:229-265`）

- `[AVOID]` セマンティックモデルのデータ構造に生ポインタやライフタイム付き参照を持たせる — `Arc` + ID のハンドルパターンを使う
  - 根拠: GraphQL モデルの `Rc` 使用、JS/CSS モデルの `Arc` 使用のいずれも、ライフタイム汚染を避けて API の人間工学を確保している

## 適用チェックリスト

- [ ] セマンティックモデルの構築フェーズ（mutable）と参照フェーズ（immutable）が型レベルで分離されているか
- [ ] API ハンドル（Scope, Binding 等）が借用ライフタイムに依存せず、自由にコピー・保持できるか
- [ ] AST 走査ロジックとモデル構築ロジックがイベントまたはメッセージで疎結合になっているか
- [ ] 大量生成される ID 型にニッチ最適化（`NonZero*`）やビットパッキングを適用しているか
- [ ] 型解決・推論に段階的な精度レベルがあり、不要なコストを回避できるか
- [ ] 同種の解析（スコープ、バインディング、参照）が複数言語で統一パターンで実装されているか
- [ ] 頻出するデータ（エクスポート情報等）に `SmallVec` 等のスタック割り当て最適化を適用しているか
