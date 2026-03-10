# performance-techniques

> リポジトリ: biomejs/biome
> 分析日: 2026-03-09

## 概要

Biome は JavaScript/TypeScript/CSS/HTML 向けの高速ツールチェーン（パーサー・フォーマッター・リンター）であり、パフォーマンスを最重要設計目標として構築されている。OS ごとに最適なカスタムアロケーターを条件コンパイルで選択し、rayon による並列ファイルトラバーサル、不変構文木のインターニングによるメモリ共有、lock-free 並行ハッシュマップなど、多層的な最適化手法が組み合わされている。これらの手法は単独の CLI ツールに留まらず、パーサー・アナライザー・フォーマッター・LSP サーバーすべてに横断的に適用されている点が注目に値する。

## 背景にある原則

- **アロケーターはプラットフォーム特性に合わせて選択すべき**: 汎用アロケーターは各 OS のメモリ管理特性を考慮しておらず、ワークロードに応じて専用アロケーターを選択することで数十%のスループット改善が得られる。Biome は Windows で mimalloc、macOS/Linux で jemalloc、musl 環境ではシステムアロケーターと、`#[cfg]` で3系統を使い分けている（`crates/biome_cli/src/main.rs:19-33`）。
- **不変データ構造は構造共有でメモリを圧縮すべき**: 構文木のように同一パターンが繰り返し出現するデータでは、不変性を保証した上でインターニング（重複排除）を行うことで、メモリ使用量を大幅に削減できる。Biome は Roslyn の手法を参考に、同一のグリーンノード/トークンを共有し、ベンチマークでグリーンノードのメモリを 17% 削減している（`crates/biome_rowan/src/green/node_cache.rs:246-251`）。
- **並行データ構造は読み取り優位のアクセスパターンに合わせて選ぶべき**: ファイルインデックスやモジュールグラフなど「初回一括書き込み → 大量読み取り」パターンでは、RwLock ベースの HashMap より epoch-based の lock-free HashMap（papaya）が適している。Biome は DashMap から papaya へ移行し、読み取りパスのロック競合を解消している。
- **並列処理はスコープ付きスレッドプールで安全に制御すべき**: rayon の `scope` を用いることで、ディレクトリトラバーサルのような再帰的タスクを安全にワークスティーリングスレッドプールへ投入でき、ライフタイムの安全性も保証される。

## 実例と分析

### カスタムアロケーターのプラットフォーム別選択

Biome はバイナリのエントリポイントとベンチマーク全体で、統一されたパターンでアロケーターを選択している。

```rust
// crates/biome_cli/src/main.rs:19-33
#[cfg(target_os = "windows")]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[cfg(all(
    any(target_os = "macos", target_os = "linux"),
    not(target_env = "musl")
))]
#[global_allocator]
static GLOBAL: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

// musl + aarch64 ではアロケーター互換性問題があるためシステムアロケーターにフォールバック
#[cfg(all(target_env = "musl", target_os = "linux", target_arch = "aarch64"))]
#[global_allocator]
static GLOBAL: std::alloc::System = std::alloc::System;
```

この同一パターンがベンチマーク群（`crates/biome_js_parser/benches/js_parser.rs:11-25` 等）でも一貫して適用されている。ベンチマークで本番と同じアロケーターを使うことで、計測結果の信頼性を確保している。

### rayon スコープによるディレクトリ並列トラバーサル

ファイルシステムの走査は rayon の `scope` を使って再帰的に並列化されている。ディレクトリエントリごとに新しいタスクを `scope.spawn` で投入し、ワークスティーリングにより効率的に負荷分散する。

```rust
// crates/biome_fs/src/fs/os.rs:174-193
#[repr(transparent)]
pub struct OsTraversalScope<'scope> {
    scope: Scope<'scope>,
}

impl<'scope> OsTraversalScope<'scope> {
    pub(crate) fn with<F>(func: F)
    where
        F: FnOnce(&Self) + Send,
    {
        scope(move |scope| func(Self::from_rayon(scope)))
    }

    fn from_rayon<'a>(scope: &'a Scope<'scope>) -> &'a Self {
        // SAFETY: repr(transparent) によりレイアウトが同一
        unsafe { mem::transmute(scope) }
    }
}
```

`repr(transparent)` を用いた newtype トリックにより、rayon の `Scope` を独自の `TraversalScope` トレイトにゼロコスト変換している。サブディレクトリを見つけると `scope.spawn` で並列に再帰する（`os.rs:305-308, 347-349`）。

### 構文木ノードのインターニングと世代管理 GC

`NodeCache` はパーサーが生成するグリーンノード・トークン・トリビアを重複排除するインターナーである。hashbrown の raw API を使い、ハッシュ値を手動で制御することで効率的なキャッシュルックアップを実現している。

```rust
// crates/biome_rowan/src/green/node_cache.rs:214-230
impl NodeCache {
    const UNCACHED_NODE_HASH: u64 = 0;

    pub(crate) fn node(
        &mut self,
        kind: RawSyntaxKind,
        children: &[(u64, GreenElement)],
    ) -> NodeCacheNodeEntryMut<'_> {
        // 子ノードが3個を超えるノードはキャッシュしない（ヒット率低下を回避）
        if children.len() > 3 {
            return NodeCacheNodeEntryMut::NoCache(Self::UNCACHED_NODE_HASH);
        }
        // ...
    }
}
```

さらに、世代ベースの GC（`Generation::A/B`）によりポインタの最下位ビットに世代情報を埋め込み（`GenerationalPointer`）、不要になったキャッシュエントリを効率的に回収する（`node_cache.rs:27-72`）。`TreeBuilder::with_cache` を使えば、同一ファイルの再パース時にキャッシュを再利用でき、ベンチマークで "cached" と "uncached" の比較が行われている（`js_parser.rs:62-88`）。

### lock-free 並行ハッシュマップ（papaya）

モジュールグラフ、プロジェクトレイアウト、パスインターナー、スキャナー、LSP セッションなど、並行アクセスが必要なデータ構造には `papaya::HashMap`/`HashSet` が一貫して使われている。

```rust
// crates/biome_module_graph/src/module_graph.rs:42-49
pub struct ModuleGraph {
    data: HashMap<Utf8PathBuf, ModuleInfo, FxBuildHasher>,
    path_info: HashMap<Utf8PathBuf, Option<PathInfo>>,
}
```

papaya は epoch-based reclamation を使用する lock-free ハッシュマップで、`.pin()` で現在のスレッドをエポックに登録してから操作する。読み取り時にロックが不要なため、ファイルインデックスのように「スキャン時に書き込み → 解析時に大量読み取り」というパターンで高いスケーラビリティを提供する。DashMap は CLI の IPC 層（`crates/biome_cli/src/service/mod.rs:23`）にのみ残っており、ほぼ全面的に papaya に置き換えられている。

### 高速ハッシュと SmallVec

FxHash（rustc-hash）がハッシュマップのハッシャーとして全域で使われている。暗号学的安全性が不要な場面では、FxHash の単純な乗算ベースのハッシュが標準の SipHash より大幅に高速である。

```rust
// crates/biome_rowan/src/green/node_cache.rs:20
type HashMap<K, V> = hashbrown::HashMap<K, V, BuildHasherDefault<FxHasher>>;

// crates/biome_js_semantic/src/semantic_model/binding.rs:13
// 「ほとんどの場合、バインディングは1回しかエクスポートされない」というドメイン知識に基づくサイズ選択
pub(crate) export_by_start: smallvec::SmallVec<[TextSize; 4]>,
```

SmallVec は「要素数が少ない場合はスタック上に配置し、閾値を超えたらヒープにフォールバック」するコレクションで、小さな可変長配列のヒープアロケーションを回避する。

### vendored Arc（triomphe 由来）

標準ライブラリの `Arc` ではなく、triomphe からベンダリングした独自 `Arc` を使っている（`crates/biome_rowan/src/arc.rs`）。weak reference 機能を削除し、`ThinArc`（ヘッダ+可変長スライスを1アロケーションに格納）を実装することで、構文木ノードのメモリオーバーヘッドを最小化している。

```rust
// crates/biome_rowan/src/arc.rs:1
//! Vendored and stripped down version of triomphe

// crates/biome_rowan/src/green/node.rs:60-61
#[cfg(target_pointer_width = "64")]
static_assert!(mem::size_of::<Slot>() == mem::size_of::<usize>() * 2);
```

`static_assert!` で構造体サイズを検証し、意図しないメモリ膨張を防止している。

### WASM 向けの graceful degradation

WASM ビルドでは rayon やスレッドが使えないため、`#[cfg(target_family = "wasm")]` でスレッドプール初期化を no-op にし、スキャン処理をシングルスレッドにフォールバックさせている。

```rust
// crates/biome_service/src/workspace/server.rs:2734-2735
#[cfg(target_family = "wasm")]
fn init_thread_pool(_threads: Option<usize>) {}

// crates/biome_service/src/scanner.rs:391-403
#[cfg(target_family = "wasm")]
let (duration, diagnostics, configuration_files) = {
    let ScanFolderResult { duration, configuration_files, .. } = self.scan_folder(folder, &ctx);
    drop(ctx); // WASM ではデッドロック回避のため先にドロップ
    let diagnostics = collector.run(diagnostics_receiver);
    (duration, diagnostics, configuration_files)
};
```

## パターンカタログ

- **Flyweight パターン** (構造)
  - 解決する問題: 大量の同一構文木ノードによるメモリ消費
  - 適用条件: 不変データで同一パターンが繰り返し出現する場合
  - コード例: `crates/biome_rowan/src/green/node_cache.rs:214-284`
  - 注意点: 子ノードが多い場合（>3）はキャッシュヒット率が低下するため除外

- **Strategy パターン** (振る舞い)
  - 解決する問題: プラットフォームごとに異なるアロケーター・並行処理戦略
  - 適用条件: `#[cfg]` で条件分岐する戦略の切り替え
  - コード例: `crates/biome_cli/src/main.rs:19-33`、`crates/biome_service/src/scanner.rs:354-404`

## Good Patterns

- **プラットフォーム別アロケーター選択の統一パターン**: 本番バイナリとベンチマークで同一のアロケーター選択コードを使う。3系統（Windows/mimalloc、Unix/jemalloc、musl/System）を `#[cfg]` で網羅し、WASM では `#[global_allocator]` を使わない。
  - コード例: `crates/biome_cli/src/main.rs:19-33`

- **`repr(transparent)` によるゼロコスト抽象化**: 外部ライブラリの型を newtype でラップし、`repr(transparent)` で安全に `transmute` する。型安全性を保ちつつランタイムコストをゼロにする。
  - コード例: `crates/biome_fs/src/fs/os.rs:174-193`

- **世代ベースの軽量 GC**: 2世代（A/B）のみでポインタの最下位ビットに世代を埋め込む。フルスキャンの GC ではなく `retain` による選択的削除で、キャッシュのメモリリークを防止する。
  - コード例: `crates/biome_rowan/src/green/node_cache.rs:27-72, 322-356`

- **ドメイン知識に基づく SmallVec サイズ選択**: 「バインディングのエクスポートは通常1回」という知識に基づき `SmallVec<[TextSize; 4]>` を選択。コメントで根拠を明記している。
  - コード例: `crates/biome_js_semantic/src/semantic_model/binding.rs:12-13`

## Anti-Patterns / 注意点

- **lock-free データ構造の不適切な選択**: DashMap はシャードロックベースのため、読み取りが支配的なワークロードでもロック競合が発生する。Biome は大部分を papaya（epoch-based lock-free）に移行し、DashMap は IPC レイヤーにのみ残している。
  - Bad: 読み取り優位のファイルインデックスに `DashMap` を使う
  - Better: epoch-based lock-free HashMap（papaya）を使い、`.pin()` でスレッドを登録して操作する

- **キャッシュの無制限成長**: インターニングキャッシュが無制限に成長するとメモリを圧迫する。Biome の NodeCache は世代ベース GC で使われなくなったエントリを刈り取るが、この仕組みがなければ長時間動作する LSP サーバーでメモリリークする。
  - Bad: キャッシュに `HashMap` を使い、エントリを削除しない
  - Better: 世代管理やサイズ制限付きのキャッシュを使い、定期的に不要エントリを削除する

## 導出ルール

- `[MUST]` ベンチマーク環境のアロケーターは本番バイナリと一致させる — アロケーターの差異がボトルネックを隠蔽するため
  - 根拠: Biome は全ベンチマークファイルで本番と同一の `#[global_allocator]` パターンを適用している（`crates/biome_js_parser/benches/js_parser.rs:11-25`）

- `[MUST]` マルチプラットフォーム対応のパフォーマンスコードでは、サポート外環境に対する明示的なフォールバックを用意する
  - 根拠: Biome は musl/aarch64 で jemalloc が動作しないことを `#[cfg]` で検出しシステムアロケーターにフォールバック、WASM ではスレッドプール初期化を no-op にしている（`main.rs:30-33`、`server.rs:2734-2735`）

- `[SHOULD]` 不変データ構造の繰り返しパターンにはインターニング（Flyweight）を適用してメモリを共有する
  - 根拠: Biome の NodeCache は構文木ノードを重複排除し、グリーンノードのメモリを 17% 削減している（`node_cache.rs:246-251`）

- `[SHOULD]` 読み取り優位の並行マップには epoch-based lock-free 実装を選択し、ロック競合を回避する
  - 根拠: Biome はモジュールグラフ・プロジェクトレイアウト等の読み取り頻度が高いデータに papaya を一貫して採用している

- `[SHOULD]` 要素数が少ないことが分かっている可変長配列には SmallVec を使い、ヒープアロケーションを回避する — サイズ選択の根拠をコメントで明記する
  - 根拠: `SmallVec<[TextSize; 4]>` の使用箇所にドメイン知識による根拠コメントがある（`binding.rs:12`）

- `[SHOULD]` 暗号学的安全性が不要なハッシュマップには FxHash 等の高速ハッシャーを使う
  - 根拠: Biome は内部データ構造全体で `FxHasher` / `FxBuildHasher` を使用し、ハッシュ計算のオーバーヘッドを削減している

- `[AVOID]` 長時間動作するプロセス（LSP サーバー等）でインターニングキャッシュを無制限に成長させる — 世代管理やサイズ制限による回収機構を設ける
  - 根拠: Biome の NodeCache は世代ベース GC で不使用エントリを `retain` 削除している（`node_cache.rs:322-356`）

## 適用チェックリスト

- [ ] プロジェクトのターゲットプラットフォームに応じたカスタムアロケーターの導入を検討したか（mimalloc/jemalloc/System）
- [ ] ベンチマーク環境で本番と同一のアロケーター設定を使用しているか
- [ ] サポート外プラットフォーム（musl、WASM 等）に対する明示的なフォールバックがあるか
- [ ] 大量の同一パターンを生成するデータ構造にインターニング/Flyweight を適用しているか
- [ ] 並行読み取りが多いデータ構造に適切な lock-free 実装を選択しているか（DashMap vs papaya/evmap 等）
- [ ] 要素数が少ない可変長配列に SmallVec 等のスタック最適化を適用しているか
- [ ] ハッシュマップのハッシャーとして、用途に応じた高速ハッシャーを検討したか
- [ ] 長時間動作するプロセスのキャッシュに回収機構（世代 GC、LRU、TTL 等）があるか
- [ ] 構造体サイズの意図しない膨張を `static_assert!` やテストで検証しているか
