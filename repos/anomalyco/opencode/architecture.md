# architecture

> リポジトリ: anomalyco/opencode
> 分析日: 2026-03-05

## 概要

opencode は TUI・Web・Desktop（Tauri）という3つの異なるフロントエンドを、単一の Hono HTTP サーバーと型付き SDK を介して統一的に接続するアーキテクチャを採用している。注目すべきは「フロントエンドがどの環境で動いても、同じ SDK で同じ API を叩く」という一貫性と、ローカル実行時に HTTP を経由せず直接 `fetch` 関数を差し替えるインプロセス通信の最適化パターンである。サーバーとクライアントの分離を OpenAPI スキーマ生成 → SDK 自動生成のパイプラインで型安全に保証している点も汎用性が高い。

## 背景にある原則

- **Transport-agnostic SDK**: クライアントは HTTP URL に接続する場合もインプロセス呼び出しの場合も同一の SDK インターフェースを使う。トランスポート層を `fetch` 関数の差し替えで抽象化することで、環境ごとの分岐をアプリケーション層から排除できる。根拠: `run.ts:656-660` でインプロセス用 `fetchFn` を `Server.App().fetch(request)` に差し替え、`thread.ts:178-188` で TUI 起動時にネットワーク/インプロセスを切り替えている。

- **Platform 抽象による UI 環境の統一**: Web と Desktop で異なるネイティブ機能（通知、ファイルダイアログ、fetch、ストレージ等）を `Platform` インターフェースで抽象化し、各環境がその実装を注入する。これにより共有 UI コンポーネント層（`@opencode-ai/ui`, `@opencode-ai/app`）はプラットフォーム詳細を一切知らずに動作する。根拠: `packages/app/src/context/platform.tsx` で `Platform` 型を定義し、`packages/desktop/src/index.tsx` と `packages/app/src/entry.tsx` がそれぞれ異なる実装を注入している。

- **AsyncLocalStorage によるリクエストスコープ隔離**: サーバーサイドで Node.js の `AsyncLocalStorage` を使い、リクエストごとに Instance コンテキスト（プロジェクトディレクトリ、ワークスペース ID 等）をスコープ化する。グローバル変数やシングルトンを避け、複数プロジェクトの同時処理を安全に実現する。根拠: `packages/opencode/src/util/context.ts` と `packages/opencode/src/project/instance.ts:22` の `Instance.provide()`。

- **契約駆動開発（Contract-First）**: Hono ルートに `hono-openapi` で OpenAPI スキーマを付与し、`generate` コマンドで OpenAPI spec を出力、そこから SDK を自動生成する。サーバー実装とクライアント SDK の型が常に同期し、手動の型定義メンテナンスが不要になる。根拠: `packages/opencode/src/cli/cmd/generate.ts` と `packages/sdk/js/src/v2/gen/`。

## 実例と分析

### サーバー・クライアント分離の3層構造

opencode のアーキテクチャは明確な3層に分かれている:

1. **Core 層** (`packages/opencode/src/`): ビジネスロジック（セッション管理、AI エージェント、ツール実行等）。HTTP に依存しない純粋なドメインロジック。
2. **Server 層** (`packages/opencode/src/server/`): Hono で Core 層を HTTP API として公開。OpenAPI スキーマ付きのルート定義。
3. **Client 層** (`packages/sdk/`, `packages/app/`, `packages/desktop/`): 自動生成された SDK を通じて Server 層にアクセス。

この分離により、TUI はインプロセスで Core 層を直接呼び出すことも、HTTP 経由でリモートサーバーに接続することもできる。

### TUI のデュアルモード通信

TUI は2つの通信モードをサポートしている:

**インプロセスモード**: Worker スレッドでサーバーを起動し、`fetch` 関数を RPC ベースの関数に差し替えて HTTP を迂回する。

```typescript
// packages/opencode/src/cli/cmd/tui/thread.ts:178-188
const transport = external
  ? {
    url: (await client.call("server", network)).url,
    fetch: undefined,
    events: undefined,
  }
  : {
    url: "http://opencode.internal",
    fetch: createWorkerFetch(client),
    events: createEventSource(client),
  };
```

**ネットワークモード**: `opencode attach <url>` で既存のリモートサーバーに接続し、通常の HTTP/SSE で通信する。

どちらのモードでも SDK の `createOpencodeClient()` に渡すパラメータが異なるだけで、アプリケーションコードは一切変更不要。

### Platform インターフェースによる環境抽象

`Platform` 型は Web/Desktop 間の差異を吸収する抽象層として機能する:

```typescript
// packages/app/src/context/platform.tsx:11-89
export type Platform = {
  platform: "web" | "desktop"
  os?: "macos" | "windows" | "linux"
  openLink(url: string): void
  restart(): Promise<void>
  notify(title: string, description?: string, href?: string): Promise<void>
  storage?: (name?: string) => SyncStorage | AsyncStorage
  fetch?: typeof fetch
  // ... desktop-only capabilities as optional methods
  openDirectoryPickerDialog?(opts?: ...): Promise<PickerPaths>
  parseMarkdown?(markdown: string): Promise<string>
}
```

Desktop 固有の機能（`openPath`, `readClipboardImage`, `checkUpdate` 等）は optional メソッドとして定義される。共有 UI 層はこれらの有無を `?.` で安全にチェックする。

### Desktop の Sidecar パターン

Tauri Desktop アプリは opencode CLI を「sidecar」として起動し、Rust 側でヘルスチェックを行ってから UI に接続先を渡す:

```rust
// packages/desktop/src-tauri/src/server.rs:104-144
pub fn spawn_local_server(
    app: AppHandle,
    hostname: String,
    port: u32,
    password: String,
) -> (CommandChild, HealthCheck) {
    let (child, exit) = cli::serve(&app, &hostname, port, &password);
    let health_check = HealthCheck(tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if check_health(&url, Some(&password)).await {
                return Ok(());
            }
        }
    }));
    (child, health_check)
}
```

UI 側は `ServerGate` コンポーネントでサーバーの準備完了を待ち、接続情報を受け取ってから `AppInterface` をレンダリングする（`packages/desktop/src/index.tsx:478-495`）。

### イベントバスと SSE による状態同期

サーバーサイドの `Bus` は `AsyncLocalStorage` スコープ内で Pub/Sub を行い、`GlobalBus`（`EventEmitter`）を通じてプロセス全体にイベントを伝播する。クライアントは SSE (`/event` エンドポイント) を通じてリアルタイムにイベントを受信する:

```typescript
// packages/opencode/src/server/server.ts:524-558
return streamSSE(c, async (stream) => {
  const unsub = Bus.subscribeAll(async (event) => {
    await stream.writeSSE({ data: JSON.stringify(event) });
  });
  const heartbeat = setInterval(() => {
    stream.writeSSE({ data: JSON.stringify({ type: "server.heartbeat" }) });
  }, 10_000);
  // ...
});
```

クライアント側では `GlobalSDKProvider`（Web）と `SDKProvider`（TUI）がイベントをバッチ処理し、16ms 間隔でフレーム単位の一括更新を行う（`packages/app/src/context/global-sdk.tsx:67-93`）。

### BusEvent の型安全な定義

イベントは Zod スキーマで定義され、グローバルレジストリに登録される。これにより OpenAPI spec にイベント型が自動的に含まれ、SDK でも型安全に扱える:

```typescript
// packages/opencode/src/bus/bus-event.ts:12-18
export function define<Type extends string, Properties extends ZodType>(type: Type, properties: Properties) {
  const result = { type, properties };
  registry.set(type, result);
  return result;
}
```

## パターンカタログ

- **Sidecar Pattern** (分類: 構造)
  - 解決する問題: デスクトップアプリがバックエンドサーバーをネイティブプロセスとして管理する必要がある
  - 適用条件: フロントエンド（WebView）とバックエンド（CLI/サーバー）が異なるランタイムで動作する場合
  - コード例: `packages/desktop/src-tauri/src/server.rs:104-144`
  - 注意点: ヘルスチェックループと早期終了検知を必ず実装すること。サーバーが起動前に死ぬケースをハンドルしないと UI がハングする

- **Strategy Pattern** (分類: 振る舞い)
  - 解決する問題: 通信トランスポート（インプロセス/HTTP/RPC）を実行時に切り替える
  - 適用条件: 同一のクライアントコードを異なるバックエンド接続方式で動作させたい場合
  - コード例: `packages/opencode/src/cli/cmd/tui/thread.ts:178-188`, `packages/opencode/src/cli/cmd/run.ts:650-662`
  - 注意点: `fetch` シグネチャの互換性を保つこと。カスタム fetch はタイムアウト・ヘッダー・ストリーミングの挙動が標準と異なる可能性がある

- **Provider Pattern / Dependency Injection** (分類: 構造)
  - 解決する問題: プラットフォーム固有の実装を共有 UI 層から分離する
  - 適用条件: 同一の UI コンポーネントを異なる環境（Web/Desktop/TUI）で再利用する場合
  - コード例: `packages/app/src/context/platform.tsx:93-98`（SolidJS Context による DI）
  - 注意点: optional メソッドが増えすぎると Platform 型が肥大化する。環境固有機能が多い場合はサブインターフェースに分割を検討する

## Good Patterns

- **fetch 関数差し替えによるトランスポート抽象化**: SDK の `createOpencodeClient` が `fetch` オプションを受け取り、インプロセス呼び出し・RPC・通常 HTTP を透過的に切り替える。テスト時にもモック fetch を注入でき、E2E テストからユニットテストまで同一の SDK で対応可能。

```typescript
// packages/opencode/src/cli/cmd/run.ts:656-660
const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  return Server.App().fetch(request);
}) as typeof globalThis.fetch;
const sdk = createOpencodeClient({ baseUrl: "http://opencode.internal", fetch: fetchFn });
```

- **ServerGate コンポーネントによる初期化同期**: Desktop アプリで sidecar サーバーの起動完了を待ってから UI をマウントする。Resource ベースの非同期ゲートにより、接続前の不完全な状態で UI が描画されることを防ぐ。

```tsx
// packages/desktop/src/index.tsx:478-495
function ServerGate(props: { children: (data: ServerReadyData) => JSX.Element; }) {
  const [serverData] = createResource(() => commands.awaitInitialization(new Channel<InitStep>() as any));
  return (
    <Show when={serverData.state !== "pending" && serverData()} fallback={<Splash />}>
      {(data) => props.children(data())}
    </Show>
  );
}
```

- **イベントのバッチフラッシュによるレンダリング最適化**: SSE で受信したイベントをキューに溜め、16ms 間隔で `batch()` 内から一括発火する。高頻度のストリーミングイベント（AI のトークン生成等）で不要な再レンダリングを防ぐ。

```typescript
// packages/opencode/src/cli/cmd/tui/context/sdk.tsx:36-62
const flush = () => {
  const events = queue;
  queue = [];
  last = Date.now();
  batch(() => {
    for (const event of events) {
      emitter.emit(event.type, event);
    }
  });
};
```

## Anti-Patterns / 注意点

- **Platform 型の optional メソッド肥大化**: `Platform` インターフェースは現在 20 以上のメソッドを持ち、その半数以上が optional（Desktop 専用）。環境ごとの機能差が大きくなると、呼び出し側で `platform.openPath?.()` のような null チェックが散在する。

```typescript
// Bad: optional だらけの巨大インターフェース
export type Platform = {
  openDirectoryPickerDialog?(opts?: ...): Promise<PickerPaths>
  openFilePickerDialog?(opts?: ...): Promise<PickerPaths>
  saveFilePickerDialog?(opts?: ...): Promise<string | null>
  checkUpdate?(): Promise<UpdateInfo>
  update?(): Promise<void>
  parseMarkdown?(markdown: string): Promise<string>
  // ... さらに増える
}

// Better: Capability ベースのサブインターフェース
type Platform = BasePlatform & Partial<DesktopCapabilities>
interface BasePlatform { platform: "web" | "desktop"; openLink(url: string): void; ... }
interface DesktopCapabilities { filePicker: FilePickerAPI; updater: UpdaterAPI; ... }
```

- **`as unknown as Hono` の型キャスト**: サーバーのルートチェーンが長くなりすぎて TypeScript の型推論が破綻し、`as unknown as Hono` でキャストしている。ルートファイルの分割が不十分な場合に発生する典型的な問題。

```typescript
// packages/opencode/src/server/server.ts:576
// TODO: Break server.ts into smaller route files to fix type inference
) as unknown as Hono,
```

## 導出ルール

- `[MUST]` マルチプラットフォーム対応のクライアント SDK は `fetch` 関数を差し替え可能にし、トランスポート層をアプリケーション層から隔離する
  - 根拠: opencode は `createOpencodeClient({ fetch })` でインプロセス・RPC・HTTP を透過的に切り替え、TUI/Web/Desktop で同一の SDK コードを使い回している（`run.ts:656-660`, `thread.ts:178-188`）

- `[MUST]` サーバーサイドでリクエストスコープの状態を扱う場合は `AsyncLocalStorage` 等のコンテキスト伝播メカニズムを使い、グローバル変数への依存を避ける
  - 根拠: `Instance.provide()` が `AsyncLocalStorage` で各リクエストのプロジェクトコンテキストを隔離し、複数ワークスペースの同時処理を可能にしている（`context.ts:10-25`, `instance.ts:22-44`）

- `[SHOULD]` 高頻度のリアルタイムイベント（SSE/WebSocket）をフロントエンドで処理する場合、フレーム単位でイベントをバッチ化し、一括で状態更新を行う
  - 根拠: `GlobalSDKProvider` が 16ms 間隔のタイマーでイベントキューをフラッシュし、`batch()` 内で一括発火することで不要な再レンダリングを抑制している（`global-sdk.tsx:67-93`）

- `[SHOULD]` OpenAPI スペックをサーバーのルート定義から自動生成し、クライアント SDK もそこから自動生成するパイプラインを構築する
  - 根拠: `hono-openapi` でルートにスキーマを付与 → `generate` コマンドで spec 出力 → SDK 自動生成という流れにより、サーバーとクライアントの型が常に同期している（`generate.ts:1-38`, `sdk/js/src/v2/gen/`）

- `[SHOULD]` Desktop アプリで sidecar サーバーを管理する場合、ヘルスチェック + 早期終了検知のレースを実装し、サーバー起動完了まで UI のマウントをブロックする
  - 根拠: Tauri の `spawn_local_server` が `tokio::select!` で ready と terminated をレースさせ、`ServerGate` が起動完了まで Splash 画面を表示する（`server.rs:112-141`, `desktop/src/index.tsx:478-495`）

- `[AVOID]` プラットフォーム抽象の単一インターフェースに optional メソッドを際限なく追加すること。環境固有の機能群は Capability サブインターフェースに分離する
  - 根拠: `Platform` 型が 20 以上のメソッドを持ち半数以上が optional であり、呼び出し側に `?.` チェックが散在している（`platform.tsx:11-89`）

## 適用チェックリスト

- [ ] クライアント SDK が `fetch` 関数を外部から注入可能になっているか（テスト時のモック、インプロセス呼び出し対応）
- [ ] サーバーの API 定義からクライアント SDK の型が自動生成される仕組みがあるか（OpenAPI, gRPC, tRPC 等）
- [ ] リアルタイムイベントの受信側でバッチ処理を実装しているか（フレーム単位の一括更新、不要な再レンダリング防止）
- [ ] マルチプラットフォーム対応が必要な場合、プラットフォーム固有機能が抽象インターフェースで隔離されているか
- [ ] サーバーサイドのリクエストスコープ状態がグローバル変数ではなくコンテキスト伝播（AsyncLocalStorage 等）で管理されているか
- [ ] Desktop アプリが外部プロセス（sidecar）に依存する場合、起動完了を待つゲート機構とプロセス異常終了のハンドリングがあるか
