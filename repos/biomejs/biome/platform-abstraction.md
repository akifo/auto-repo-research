# platform-abstraction

> リポジトリ: biomejs/biome
> 分析日: 2026-03-09

## 概要

ネイティブバイナリ（8 プラットフォーム）と WASM（bundler/nodejs/web の 3 ターゲット）を単一の Rust コードベースから配布する Biome の多プラットフォーム戦略を分析した。注目に値するのは、コアロジックを一切分岐させずにプラットフォーム差異を吸収する「抽象化レイヤーの境界設計」と、npm の `optionalDependencies` + `os`/`cpu` フィールドを活用してユーザーに最適なバイナリだけをインストールさせる配布パターンである。

## 背景にある原則

- **コアロジックのプラットフォーム不可知性**: パーサー・フォーマッター・リンター等のビジネスロジックはプラットフォームに一切依存しない。プラットフォーム依存コードはファイルシステム・時間 API・メモリアロケータの 3 箇所に限定されている。これにより、ネイティブでも WASM でも同一のコードが実行される保証がある（`biome_service` の `Workspace` trait が統一インターフェースを提供）。

- **トレイトによる注入ポイントの最小化**: `FileSystem` trait を唯一のプラットフォーム分岐点とし、ネイティブ向け `OsFileSystem` と WASM 向け `MemoryFileSystem` を差し替えるだけでプラットフォーム対応が完結する。分岐ポイントを 1 つのトレイトに集約することで、`#[cfg(target_arch)]` の散在を防いでいる。

- **npm パッケージトポロジーによるゼロコスト配布**: メインパッケージ `@biomejs/biome` は `optionalDependencies` でプラットフォーム別バイナリパッケージを参照し、各バイナリパッケージは `os`/`cpu` フィールドで自身の対象を宣言する。npm がインストール時に適切なバイナリだけをダウンロードするため、ユーザーは配布の複雑さを意識しない。

- **WASM は「フォールバック」ではなく「別チャネル」**: ネイティブバイナリが使えない環境（ブラウザ、Cloudflare Workers 等）向けに、WASM を独立した配布チャネルとして位置づけている。JS API (`@biomejs/js-api`) が `Distribution` enum で 3 つの WASM ターゲットを選択可能にし、各ターゲットは `peerDependencies`（optional）として宣言されている。

## 実例と分析

### ファイルシステム抽象化（Strategy パターン）

`biome_fs` クレートは `FileSystem` trait を定義し、ネイティブ (`OsFileSystem`) と WASM/テスト用 (`MemoryFileSystem`) の 2 つの実装を提供する。WASM 環境ではファイルシステムアクセスが不可能なため、`MemoryFileSystem` がインメモリで全ファイルを保持する。

```rust
// crates/biome_fs/src/fs.rs:63-76
pub trait FileSystem: Send + Sync + RefUnwindSafe {
    fn open_with_options(&self, path: &Utf8Path, options: OpenOptions) -> io::Result<Box<dyn File>>;
    fn traversal<'scope>(&'scope self, func: BoxedTraversal<'_, 'scope>);
    fn working_directory(&self) -> Option<Utf8PathBuf>;
    fn path_exists(&self, path: &Utf8Path) -> bool;
    // ...
}
```

WASM エントリポイントではこの trait を `MemoryFileSystem` で具象化する:

```rust
// crates/biome_wasm/src/lib.rs:67-71
pub fn new() -> Self {
    Self {
        inner: workspace::server(Arc::new(biome_fs::MemoryFileSystem::default()), None),
    }
}
```

### 条件付きコンパイルの限定的使用

`#[cfg(target_arch = "wasm32")]` の使用は最小限に抑えられている。代表的な使用箇所はプロファイリングモジュールで、WASM 環境では `std::time::Instant` が使えないため、タイマー機能を no-op にしている:

```rust
// crates/biome_analyze/src/profiling.rs:221-236
#[cfg(not(target_arch = "wasm32"))]
static PROFILER: Mutex<Option<RuleProfiler>> = Mutex::new(None);
#[cfg(not(target_arch = "wasm32"))]
fn with_profiler<R>(f: impl FnOnce(&mut RuleProfiler) -> R) -> Option<R> {
    // 実際のプロファイリング実装
}

#[cfg(target_arch = "wasm32")]
fn with_profiler<R>(_f: impl FnOnce(&mut RuleProfiler) -> R) -> Option<R> {
    None  // WASM では常に no-op
}
```

また `biome_service` では `web-time` クレートを使用して `std::time::Instant` の代わりにクロスプラットフォームな時間 API を利用している:

```rust
// crates/biome_service/src/scanner.rs:422
let start = web_time::Instant::now();
```

### プラットフォーム別メモリアロケータ

ネイティブバイナリでは OS ごとに最適なアロケータを選択する:

```rust
// crates/biome_cli/src/main.rs:19-33
#[cfg(target_os = "windows")]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[cfg(all(any(target_os = "macos", target_os = "linux"), not(target_env = "musl")))]
#[global_allocator]
static GLOBAL: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

#[cfg(all(target_env = "musl", target_os = "linux", target_arch = "aarch64"))]
#[global_allocator]
static GLOBAL: std::alloc::System = std::alloc::System;
```

この分岐はバイナリのエントリポイント（`main.rs`）にのみ存在し、ライブラリクレートには漏れていない。

### npm 配布アーキテクチャ

8 つのプラットフォーム別パッケージが `os`/`cpu` で自身の対象を宣言する:

```json
// packages/@biomejs/cli-darwin-arm64/package.json:14-19
{
  "os": ["darwin"],
  "cpu": ["arm64"]
}
```

メインパッケージの bin スクリプトはランタイムでプラットフォームを検出し、対応するバイナリを `require.resolve` で取得する:

```javascript
// packages/@biomejs/biome/bin/biome:20-37
const PLATFORMS = {
    win32: {
        x64: "@biomejs/cli-win32-x64/biome.exe",
        arm64: "@biomejs/cli-win32-arm64/biome.exe",
    },
    darwin: {
        x64: "@biomejs/cli-darwin-x64/biome",
        arm64: "@biomejs/cli-darwin-arm64/biome",
    },
    linux: {
        x64: "@biomejs/cli-linux-x64/biome",
        arm64: "@biomejs/cli-linux-arm64/biome",
    },
    "linux-musl": {
        x64: "@biomejs/cli-linux-x64-musl/biome",
        arm64: "@biomejs/cli-linux-arm64-musl/biome",
    },
};
```

musl/glibc の判定は `ldd --version` の stderr を検査する実装で、追加依存なしに実現している。

### WASM 3 ターゲットと JS API の抽象化

JS API は `BiomeCommon<Configuration, Diagnostic>` ジェネリッククラスでコアロジックを共有し、ターゲット別エントリポイント（`bundler.ts`, `nodejs.ts`, `web.ts`）は WASM モジュールの注入のみを行う:

```typescript
// packages/@biomejs/js-api/src/nodejs.ts:1-12
import * as moduleNodeJs from "@biomejs/wasm-nodejs";
import { BiomeCommon } from "./common";

export class Biome extends BiomeCommon<Configuration, Diagnostic> {
    constructor() {
        super(moduleNodeJs);
    }
}
```

動的選択が必要な場合は `Distribution` enum + `import()` で遅延ロードする:

```typescript
// packages/@biomejs/js-api/src/index.ts:51-62
static async create({ distribution }: BiomeCreate): Promise<Biome> {
    switch (distribution) {
        case Distribution.BUNDLER:
            return new Biome(await import("@biomejs/wasm-bundler"));
        case Distribution.NODE:
            return new Biome(await import("@biomejs/wasm-nodejs"));
        case Distribution.WEB:
            return new Biome(await import("@biomejs/wasm-web"));
    }
}
```

### ビルド時型生成

WASM バインディングの TypeScript 型定義は `build.rs` で Rust の型情報から自動生成され、Biome 自身のフォーマッターで整形される:

```rust
// crates/biome_wasm/build.rs:69-76
let formatted = format_node(
    JsFormatOptions::new(JsFileSource::ts()),
    module.syntax(),
    false,
)
.unwrap();
```

これにより、Rust 側の API 変更が TypeScript の型定義に自動反映される。

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: プラットフォームごとのファイルシステム操作の差異を吸収する
  - 適用条件: 実行環境によって同一インターフェースの実装を切り替える必要がある場合
  - コード例: `crates/biome_fs/src/fs.rs:63` (`FileSystem` trait) + `crates/biome_fs/src/fs/os.rs:28` (`OsFileSystem`) + `crates/biome_fs/src/fs/memory.rs:28` (`MemoryFileSystem`)
  - 注意点: trait に `Send + Sync + RefUnwindSafe` を要求し、並行安全性をコンパイル時に保証している

- **Facade パターン** (分類: 構造)
  - 解決する問題: WASM モジュールの初期化・型変換の複雑さを隠蔽する
  - 適用条件: 低レベル FFI バインディングにユーザーフレンドリーな API を被せたい場合
  - コード例: `packages/@biomejs/js-api/src/common.ts:89` (`BiomeCommon` クラス)
  - 注意点: `WeakSet` で初期化済みモジュールを追跡し、二重初期化を防止している

## Good Patterns

- **optionalDependencies + os/cpu によるプラットフォーム別バイナリ配布**: npm の仕組みだけで、ユーザーに適切なバイナリのみをインストールさせる。追加のポストインストールスクリプトやダウンローダーが不要で、セキュリティ上も安全。bin スクリプトの `BIOME_BINARY` 環境変数によるオーバーライド機構も用意されている。

```javascript
// packages/@biomejs/biome/bin/biome:39
const binPath = env.BIOME_BINARY ||
    (platform === "linux" && isMusl()
        ? PLATFORMS?.["linux-musl"]?.[arch]
        : PLATFORMS?.[platform]?.[arch]
    );
```

- **ジェネリッククラスによる WASM ターゲット共通化**: `BiomeCommon<Configuration, Diagnostic>` が型パラメータで WASM ターゲット間の型差異を吸収し、全ターゲットで同一のビジネスロジックを共有する。各ターゲットのエントリポイントは 12 行以下。

```typescript
// packages/@biomejs/js-api/src/common.ts:89-99
export class BiomeCommon<Configuration, Diagnostic> {
    private readonly workspace: Workspace<Configuration, Diagnostic>;
    constructor(private readonly module: Module<Configuration, Diagnostic>) {
        if (!initialized.has(module)) {
            module.main();
            initialized.add(module);
        }
        this.workspace = new module.Workspace();
    }
}
```

- **cfg 分岐をエントリポイントに封じ込める**: アロケータ選択の `#[cfg]` は `main.rs` のみ、プロファイリングの `#[cfg(target_arch)]` は専用モジュールのみに限定。ライブラリクレートの大部分はプラットフォーム非依存。

## Anti-Patterns / 注意点

- **cfg 分岐の散在**: プラットフォーム分岐を各モジュールに散在させると、新しいプラットフォーム追加時に変更箇所が増える。Biome はこれを避けるためにトレイトで抽象化しているが、`profiling.rs` のように trait 化しにくい箇所では `#[cfg]` が残っている。

```rust
// Bad: cfg を各関数に個別に書く
#[cfg(not(target_arch = "wasm32"))]
fn measure_time() -> Duration { /* ... */ }
#[cfg(target_arch = "wasm32")]
fn measure_time() -> Duration { Duration::ZERO }

// Better: クロスプラットフォームなクレートを使う
// biome_service は web-time クレートで統一
let start = web_time::Instant::now(); // ネイティブでもWASMでも同一コード
```

- **WASM ランタイム制約の見落とし**: `MemoryFileSystem` は `read_link` を `Unsupported` エラーで返す。WASM 環境での機能制限を明示的にエラーとして返すことは良い設計だが、この制約がドキュメントに記載されていないと利用者が混乱する。

## 導出ルール

- `[MUST]` プラットフォーム依存コードは trait/interface を通じて注入し、コアロジックからプラットフォーム固有の import/呼び出しを排除する
  - 根拠: Biome は `FileSystem` trait の差し替えだけでネイティブ/WASM 両対応を実現し、パーサー・フォーマッター・リンターのコードにプラットフォーム分岐が一切ない（`crates/biome_fs/src/fs.rs:63`）

- `[MUST]` npm でネイティブバイナリを配布する場合、`optionalDependencies` + プラットフォーム別パッケージの `os`/`cpu` フィールドで配布対象を宣言する
  - 根拠: Biome は 8 プラットフォーム分のバイナリをこの方式で配布し、ポストインストールスクリプトなしにユーザーの環境に適切なバイナリだけをインストールさせている（`packages/@biomejs/biome/package.json:48-57`）

- `[SHOULD]` WASM で利用不可な標準ライブラリ API（`std::time::Instant`, `std::fs` 等）はクロスプラットフォームなクレート/ポリフィルで置き換え、`#[cfg]` 分岐を最小化する
  - 根拠: `biome_service` は `web-time` クレートで `Instant` を統一し、`biome_analyze` の `profiling.rs` で残る `#[cfg]` 分岐を不要にできるパターンを示している（`crates/biome_service/src/scanner.rs:422`）

- `[SHOULD]` WASM バインディングの TypeScript 型定義は Rust の型情報から自動生成し、手動同期を排除する
  - 根拠: `biome_wasm` の `build.rs` が Rust の型定義から TypeScript 型を生成し、API 変更時の型不整合を防いでいる（`crates/biome_wasm/build.rs:12-112`）

- `[SHOULD]` 複数の WASM ターゲット（bundler/nodejs/web）を提供する場合、ジェネリクスで共通ロジックを共有し、ターゲット別エントリポイントはモジュール注入のみとする
  - 根拠: `BiomeCommon<Configuration, Diagnostic>` が 3 ターゲット共通のロジックを 200 行で実装し、各ターゲットのエントリポイントは 12 行以下に収まっている（`packages/@biomejs/js-api/src/common.ts`）

- `[AVOID]` bin スクリプトでプラットフォーム検出が失敗した場合にサイレントに失敗する。明確なエラーメッセージと代替手段を提示する
  - 根拠: Biome の bin スクリプトは未対応プラットフォームで具体的なエラーメッセージを表示し、`BIOME_BINARY` 環境変数によるオーバーライドも提供している（`packages/@biomejs/biome/bin/biome:69-76`）

## 適用チェックリスト

- [ ] コアロジック（パーサー、変換器、ビジネスルール等）がプラットフォーム依存の import を持っていないか確認する
- [ ] ファイルシステム・ネットワーク・時間 API 等のプラットフォーム依存操作が trait/interface で抽象化されているか確認する
- [ ] ネイティブバイナリの npm 配布で `optionalDependencies` + `os`/`cpu` パターンを採用しているか確認する
- [ ] WASM ビルドで `wasm-bindgen` + `wasm-opt` のパイプラインが整備されているか確認する
- [ ] `#[cfg(target_arch)]` や `process.platform` 等の条件分岐がエントリポイント付近に限定されているか確認する
- [ ] WASM 環境で利用不可な API に対するクロスプラットフォームな代替（`web-time` 等）を導入しているか確認する
- [ ] TypeScript 型定義が Rust/ネイティブ側の型から自動生成される仕組みがあるか確認する
- [ ] musl/glibc の判定ロジックがある場合、追加依存なしに実現できているか確認する
