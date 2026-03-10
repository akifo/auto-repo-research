# cli-framework-patterns

> リポジトリ: biomejs/biome
> 分析日: 2026-03-09

## 概要

bpaf を基盤とした CLI フレームワーク設計、サブコマンド構造、daemon モードによる LSP 統合、そして CLI/LSP 間で共通バックエンドを透過的に使い分ける Workspace 抽象を分析する。Biome は CLI・LSP・daemon の 3 モードを単一バイナリで提供しつつ、コア処理を `Workspace` trait で共有するアーキテクチャを採用しており、マルチモード CLI 設計の参考事例として注目に値する。

## 背景にある原則

- **単一バイナリ・マルチモード原則**: CLI・daemon・LSP プロキシを 1 つのバイナリに統合し、`biome start`/`biome lsp-proxy`/`biome __run_server` で動作モードを切り替える。配布の単純化とバージョン整合性の保証が目的。隠しコマンド `__run_server` で daemon を起動し、`setsid()` でプロセスをデタッチする設計からこの意図が読み取れる（`crates/biome_cli/src/service/unix.rs:86-106`）。

- **Workspace trait による透過的バックエンド切替**: `Workspace` trait を介して、in-process サーバー（`WorkspaceServer`）と socket 経由のリモートクライアント（`WorkspaceClient`）を同じインターフェースで扱う。`--use-server` フラグ 1 つで切り替わり、呼び出し側コードは変更不要（`crates/biome_cli/src/main.rs:59-76`）。

- **宣言的 CLI 定義と構造的検証**: bpaf の derive マクロで CLI 構造を宣言的に定義し、`check_invariants()` テストで全サブコマンドの整合性を自動検証する。手動パース不要で型安全性を確保しつつ、CI でオプション矛盾を検出できる（`crates/biome_cli/src/commands/mod.rs:1037-1039`）。

- **コマンド実行のフレームワーク化**: `CommandRunner` trait と関連 trait 群（`Crawler`, `Handler`, `Finalizer` 等）でファイル走査型コマンドの共通パイプラインを抽象化し、コマンド固有ロジックだけをプラグインする構造にしている（`crates/biome_cli/src/runner/mod.rs:1-122`）。

## 実例と分析

### bpaf による宣言的サブコマンド定義

Biome は `#[derive(Bpaf)]` で CLI 全体を enum として宣言する。各サブコマンドは `#[bpaf(command)]` 属性で定義され、共通オプション（`CliOptions`, `LogOptions`）は `#[bpaf(external)]` で分離・再利用される。

```rust
// crates/biome_cli/src/commands/mod.rs:58-64
#[derive(Debug, Clone, Bpaf)]
#[bpaf(options, version(VERSION))]
pub enum BiomeCommand {
    #[bpaf(command)]
    Version(#[bpaf(external(cli_options), hide_usage)] CliOptions),
    // ...
}
```

`external` による分離は、`CliOptions` のような横断的オプションを複数コマンドで共有するパターンを可能にする。`cli_options` 関数（bpaf が自動生成）を参照する形式で、型安全にオプショングループを合成できる。

### 隠しコマンドによる daemon 起動

daemon プロセスは `__run_server` という隠しコマンドで起動される。`#[bpaf(command("__run_server"), hide)]` により、ユーザー向けヘルプには表示されないが、内部的に自プロセスを `Command::new(env::current_exe())` で再起動する際に使われる。

```rust
// crates/biome_cli/src/commands/mod.rs:625-635
#[bpaf(command("__run_server"), hide)]
RunServer {
    #[bpaf(external(log_options))]
    log_options: LogOptions,
    #[bpaf(long("stop-on-disconnect"), hide_usage)]
    stop_on_disconnect: bool,
    #[bpaf(external(watcher_options))]
    watcher_options: WatcherOptions,
},
```

この設計により、ユーザーに見えるインターフェースは `biome start`/`biome stop` だけで、内部メカニズムを隠蔽している。

### Workspace trait による CLI/daemon 透過アクセス

`main.rs` の `run_workspace` 関数が、`--use-server` の有無で `workspace::server()` または `workspace::client()` を呼び分ける。どちらも `Box<dyn Workspace>` を返すため、後続の `CliSession::run()` は接続先を意識しない。

```rust
// crates/biome_cli/src/main.rs:59-76
fn run_workspace(console: &mut EnvConsole, command: BiomeCommand) -> Result<(), CliDiagnostic> {
    let fs = OsFileSystem::default();
    let workspace = if command.should_use_server() {
        let runtime = Runtime::new()?;
        match open_transport(runtime)? {
            Some(transport) => workspace::client(transport, Box::new(fs))?,
            None => return Err(CliDiagnostic::server_not_running()),
        }
    } else {
        let threads = command.get_threads();
        workspace::server(Arc::new(fs), threads)
    };
    let session = CliSession::new(&*workspace, console)?;
    session.run(command)
}
```

`WorkspaceClient` は JSON-RPC over Unix domain socket（Windows では named pipe）でリモートの `WorkspaceServer` と通信する。LSP プロトコルの Content-Length ヘッダ形式を再利用しており、独自プロトコルの実装コストを低減している。

### CommandRunner trait による実行パイプラインの抽象化

ファイル走査型コマンド（`check`, `lint`, `format`, `search`）は `TraversalCommand` trait を実装し、`TraversalCommandImpl` ラッパーで自動的に `CommandRunner` 実装を得る。非走査型コマンド（`migrate`）は `CustomExecutionCmd` trait を使う。

```rust
// crates/biome_cli/src/lib.rs:99-124
BiomeCommand::Check { .. } => run_command(
    self,
    &log_options,
    &cli_options,
    TraversalCommandImpl(CheckCommandPayload { .. }),
),
```

パイプラインは `configure_workspace → crawl → finalize` の 3 段階で、各段階の具体実装を associated type で差し替え可能にしている。

### daemon の接続リトライとプロセスライフサイクル

`ensure_daemon` 関数は最大 10 回のリトライでソケット接続を試み、接続できない場合に子プロセスを spawn する。`setsid()` で完全にデタッチし、親プロセスの終了後も動作を継続する。

```rust
// crates/biome_cli/src/service/unix.rs:131-189
pub(crate) async fn ensure_daemon(
    stop_on_disconnect: bool,
    watcher_configuration: WatcherOptions,
    log_options: LogOptions,
) -> io::Result<bool> {
    let mut current_child: Option<Child> = None;
    for _ in 0..10 {
        match try_connect().await {
            Ok(_) => return Ok(current_child.is_some()),
            Err(err) if matches!(err.kind(), ErrorKind::NotFound | ErrorKind::ConnectionRefused) => {
                // spawn or retry...
            }
            Err(err) => return Err(err),
        }
    }
    // ...
}
```

ソケット名にバージョンを含め（`biome-socket-{VERSION}`）、異なるバージョンの daemon が共存しないようにしている。

### ServerFactory による多クライアント対応

daemon モードでは `ServerFactory` が共有の `WorkspaceServer` インスタンスを保持し、新しい接続ごとに LSP `ServerConnection` を生成する。`Arc<WorkspaceServer>` を通じて複数のエディタ接続が同一の workspace 状態を共有できる。

```rust
// crates/biome_lsp/src/server.rs:582-600
impl ServerFactory {
    pub fn new(stop_on_disconnect: bool, instruction_tx: Sender<WatcherInstruction>) -> Self {
        Self {
            workspace: Arc::new(WorkspaceServer::new(
                Arc::new(OsFileSystem::default()),
                instruction_tx, service_tx, None,
            )),
            // ...
        }
    }
}
```

## パターンカタログ

- **Proxy パターン** (構造)
  - 解決する問題: CLI の直接実行とリモート daemon 経由の実行を同一インターフェースで扱う
  - 適用条件: 同一操作をローカルとリモートで透過的に切り替える必要がある場合
  - コード例: `crates/biome_service/src/workspace/client.rs:27-39`（`WorkspaceClient` が `Workspace` trait を実装し、内部で JSON-RPC transport にデリゲート）
  - 注意点: transport 層のシリアライズコストと 15 秒タイムアウトの存在（`crates/biome_cli/src/service/mod.rs:227`）

- **Template Method パターン** (振る舞い)
  - 解決する問題: ファイル走査型コマンドの共通フローを定義しつつ、個別ステップを差し替え可能にする
  - 適用条件: 複数コマンドが同じ「設定読込→走査→結果出力」のパイプラインを共有する場合
  - コード例: `crates/biome_cli/src/runner/mod.rs:250-325`（`CommandRunner::run()` がアルゴリズムの骨格を定義）
  - 注意点: associated type が 6 つあり複雑度が高い。ラッパー型（`TraversalCommandImpl`）でデフォルト実装を提供し複雑度を軽減している

- **Abstract Factory パターン** (生成)
  - 解決する問題: daemon が複数クライアント接続に対して LSP サービスインスタンスを生成する
  - 適用条件: 共有リソースへの参照を持つオブジェクトを動的に複数生成する場合
  - コード例: `crates/biome_lsp/src/server.rs:547-600`（`ServerFactory::create()` が `ServerConnection` を生成）

## Good Patterns

- **共通オプションの `external` 分離**: bpaf の `#[bpaf(external)]` でグローバルオプション（`CliOptions`, `LogOptions`）を独立した構造体に分離し、複数サブコマンドで再利用する。オプション追加時の修正箇所が 1 箇所で済み、一貫性が保たれる。

```rust
// crates/biome_cli/src/cli_options.rs:9-66
#[derive(Debug, Default, Clone, Bpaf)]
pub struct CliOptions {
    #[bpaf(long("colors"), argument("off|force"))]
    pub colors: Option<ColorsArg>,
    #[bpaf(long("use-server"), switch, fallback(false))]
    pub use_server: bool,
    // ...
}
```

- **Payload struct によるコマンド引数の構造化**: bpaf の enum バリアントから展開した引数を、コマンドごとの Payload 構造体（`CheckCommandPayload` 等）に詰め替えてから `run_command` に渡す。これにより、コマンド実行ロジックが CLI パーサーの構造に依存しない。

```rust
// crates/biome_cli/src/commands/check.rs:28-48
pub(crate) struct CheckCommandPayload {
    pub(crate) write: bool,
    pub(crate) fix: bool,
    pub(crate) unsafe_: bool,
    pub(crate) configuration: Option<Configuration>,
    pub(crate) paths: Vec<OsString>,
    // ...
}
```

- **非互換引数の明示的バリデーション**: `--write` と `--fix`、`--staged` と `--changed` のような相互排他オプションを `CliDiagnostic::incompatible_arguments` で検出し、ユーザーに解決方法を含むエラーメッセージを提示する。

```rust
// crates/biome_cli/src/commands/mod.rs:853-876
if since.is_some() {
    if !changed {
        return Err(CliDiagnostic::incompatible_arguments(
            "--since", "--changed",
            "In order to use --since, you must also use --changed.",
        ));
    }
}
```

- **`check_invariants` テスト**: bpaf の `check_invariants(false)` を単体テストで呼び出し、オプション定義のフラグ重複・型不整合等を CI で自動検出する。

```rust
// crates/biome_cli/src/commands/mod.rs:1036-1039
#[test]
fn check_options() {
    biome_command().check_invariants(false);
}
```

## Anti-Patterns / 注意点

- **巨大 enum バリアントによるオプション爆発**: `BiomeCommand::Check` バリアントは 18 個のフィールドを持ち、`BiomeCommand::Lint` も同様に多い。enum バリアントに直接フィールドを並べると、パターンマッチが煩雑になり、新しいオプション追加時に `cli_options()`/`log_options()` のような抽出メソッドのマッチ分岐も更新が必要になる。

```rust
// Bad: enum バリアントに 18 個のフィールドを直接持つ
BiomeCommand::Check {
    write, fix, unsafe_, cli_options, configuration, paths,
    stdin_file_path, linter_enabled, formatter_enabled,
    assist_enabled, enforce_assist, staged, changed, since,
    format_with_errors, json_parser, css_parser, log_options,
    only, skip, profile_rules,
} => run_command(self, &log_options, &cli_options, TraversalCommandImpl(CheckCommandPayload { .. })),
```

```rust
// Better: サブコマンドのオプションを最初から構造体にグループ化する
#[bpaf(command)]
Check(#[bpaf(external)] CheckOptions),
```

実際に Biome は `CheckCommandPayload` で再構造化しているが、bpaf の enum 定義段階では展開されたままであり、二重定義のメンテナンスコストが発生している。

- **プラットフォーム固有コードの `unsafe` 使用**: daemon 生成時の `pre_exec` 内で `libc::setsid()` を呼ぶ箇所は `unsafe` ブロックが必要。コメントで安全性の根拠を説明しているのは良い慣行だが、プラットフォーム抽象化レイヤーへの分離が望ましい。

## 導出ルール

- `[MUST]` CLI ツールが daemon/server モードを持つ場合、コアロジックを trait で抽象化し、in-process 実行とリモート呼び出しを同一インターフェースで切り替え可能にする
  - 根拠: Biome は `Workspace` trait の `server()`/`client()` ファクトリで、`--use-server` フラグだけで透過的に切り替えており、コマンド実装コードの重複を排除している（`crates/biome_cli/src/main.rs:59-76`）

- `[MUST]` CLI パーサーの構造テスト（`check_invariants` 相当）を CI に組み込み、オプション定義の矛盾を自動検出する
  - 根拠: bpaf の `check_invariants(false)` テストにより、フラグ名の重複や型不整合がコンパイル後・実行前に検出される（`crates/biome_cli/src/commands/mod.rs:1037-1039`）

- `[SHOULD]` 複数サブコマンドで共有するオプション群は独立した構造体に分離し、サブコマンド定義から参照する形にする
  - 根拠: `CliOptions` と `LogOptions` を `#[bpaf(external)]` で分離することで、10 個以上のサブコマンドが同一のグローバルオプションを一貫して提供している（`crates/biome_cli/src/cli_options.rs:9-66`）

- `[SHOULD]` daemon プロセスのソケット名にバージョンを含め、異なるバージョン間の接続事故を防止する
  - 根拠: `biome-socket-{VERSION}` 形式でバージョンごとにソケットを分離し、旧バージョンの daemon にプロトコル非互換のリクエストが送られることを防いでいる（`crates/biome_cli/src/service/unix.rs:24-26`）

- `[SHOULD]` 相互排他的な CLI オプションの組み合わせを、解決方法を含むエラーメッセージで早期に拒否する
  - 根拠: `--write` と `--suppress`、`--staged` と `--changed` の非互換を検出し、どちらを使うべきかを具体的に案内するメッセージを返している（`crates/biome_cli/src/commands/mod.rs:925-958`）

- `[SHOULD]` ファイル走査型の複数コマンドが共通するパイプラインを trait で抽象化し、コマンド固有部分だけをプラグインする構造にする
  - 根拠: `CommandRunner` trait の Template Method パターンにより、`check`/`lint`/`format`/`search` が設定読込→走査→出力の共通フローを共有しつつ、`ProcessFile` の差し替えだけで個別動作を定義している（`crates/biome_cli/src/runner/mod.rs:181-564`）

- `[AVOID]` daemon の内部起動コマンドをユーザー向けヘルプに露出させること。隠しコマンド（`hide` 属性）で内部メカニズムを隠蔽し、`start`/`stop` のような意図ベースのコマンドだけを公開する
  - 根拠: `__run_server` は `#[bpaf(command("__run_server"), hide)]` で隠蔽され、ユーザーは `biome start`/`biome stop` のみを操作する（`crates/biome_cli/src/commands/mod.rs:625-641`）

## 適用チェックリスト

- [ ] CLI が daemon/server モードを持つ場合、コアロジックを trait 化して in-process とリモートの両方で使えるようにしているか
- [ ] CLI パーサーの構造テスト（オプション矛盾の自動検出）を CI に組み込んでいるか
- [ ] 複数サブコマンドで共有するオプションを独立構造体に分離しているか
- [ ] daemon のソケット/パイプ名にバージョン情報を含めているか
- [ ] 相互排他的なオプションの組み合わせを、解決方法付きのエラーメッセージで拒否しているか
- [ ] ファイル走査型コマンドが共通パイプラインを trait で共有し、個別ロジックだけを差し替えているか
- [ ] daemon の内部コマンドが `--help` に露出していないか
- [ ] panic ハンドラがユーザーフレンドリーなエラーメッセージとバグレポート URL を表示しているか
