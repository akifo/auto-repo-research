# Pattern: composition-root

> 出典: [mastra-ai/mastra](../repos/mastra-ai/mastra/architecture.md), [vitejs/vite](../repos/vitejs/vite/abstraction-patterns.md), [unjs/unbuild](../repos/unjs/unbuild/hook-and-lifecycle-patterns.md), [openclaw/openclaw](../repos/openclaw/openclaw/architecture.md)
> カテゴリ: pattern

## 概要

4 リポジトリの「依存の集約・初期化順序管理・横断的関心事の伝播」を比較し、Composition Root（構成集約点）の 4 つの形態を体系化する。DI コンテナを使わない TypeScript プロジェクトにおいて、依存関係の解決をどこに集約し、どのように横断的関心事を伝播するかは設計上の重要な判断である。

## 背景・文脈

Composition Root とは「アプリケーションの全依存関係を構築・結合する単一の場所」であり、DI の原則では可能な限りエントリポイントに近い位置に置くべきとされる。Java/C# では DI コンテナがこの役割を担うが、TypeScript エコシステムではフレームワーク依存のない軽量な実装が主流である。

調査した 4 リポジトリは、それぞれ異なる形態の Composition Root を持つ:

| リポジトリ        | 形態                      | 集約点                              | 横断的関心事の伝播             |
| ----------------- | ------------------------- | ----------------------------------- | ------------------------------ |
| mastra-ai/mastra  | 単一クラス型              | `Mastra` クラス                     | プッシュ型（`__setLogger` 等） |
| vitejs/vite       | 関数+パイプライン型       | `resolveConfig` + `resolvePlugins`  | Proxy + WeakMap                |
| unjs/unbuild      | ビルド関数+コンテキスト型 | `build` + `BuildContext` + hookable | コンテキスト引数               |
| openclaw/openclaw | オーケストレーター関数型  | `startGatewayServer`                | 引数注入                       |

## 実装パターン

### 1. 単一クラス型 — Mastra クラス（mastra-ai/mastra）

`Mastra` クラスが 10 種のジェネリック型パラメータを持つ中央レジストリとして機能し、全コンポーネントの登録・取得・ライフサイクル管理を行う。

```typescript
// packages/core/src/mastra/index.ts:292-306
export class Mastra<
  TAgents extends Record<string, Agent<any>> = Record<string, Agent<any>>,
  TWorkflows extends Record<string, AnyWorkflow> = Record<string, AnyWorkflow>,
  TVectors extends Record<string, MastraVector<any>> = Record<string, MastraVector<any>>,
  // ... 10 種の型パラメータ
> {
```

初期化順序は意図的に制御されている。依存元より先に依存先を登録することで、Agent が Tool や Workflow を参照する際に確実に解決できる:

```
tools → processors → memory → vectors → scorers → workflows → gateways → mcpServers → agents
```

横断的関心事（ロガー、ストレージ）はプッシュ型 DI で全コンポーネントに一括伝播する:

```typescript
// packages/core/src/mastra/index.ts:867-875
mastraAgent.__setLogger(this.#logger);
mastraAgent.__registerMastra(this);
mastraAgent.__registerPrimitives({
  logger: this.getLogger(),
  storage: this.getStorage(),
  agents: agents,
  tts: this.#tts,
  vectors: this.#vectors,
});
```

### 2. 関数+プラグインパイプライン型（vitejs/vite）

`resolveConfig` が設定解決の Composition Root として機能し、プラグインフックのパイプラインで設定を段階的に構築する。

設定は多段パイプラインで構築される:

1. ユーザー入力
2. プラグインの `config` フック
3. `configEnvironment` フック
4. デフォルトマージ
5. `resolveConfig` で最終解決

プラグインの実行順序は `enforce` + `hook.order` の二段階で制御される:

```typescript
// packages/vite/src/node/config.ts:2217-2233
export function sortUserPlugins(
  plugins: (Plugin | Plugin[])[] | undefined,
): [Plugin[], Plugin[], Plugin[]] {
  const prePlugins: Plugin[] = [];
  const postPlugins: Plugin[] = [];
  const normalPlugins: Plugin[] = [];
  if (plugins) {
    plugins.flat().forEach((p) => {
      if (p.enforce === "pre") prePlugins.push(p);
      else if (p.enforce === "post") postPlugins.push(p);
      else normalPlugins.push(p);
    });
  }
  return [prePlugins, normalPlugins, postPlugins];
}
```

環境固有の状態は `perEnvironmentState` で WeakMap + ファクトリ関数により自動管理される:

```typescript
// packages/vite/src/node/environment.ts:20-33
export function perEnvironmentState<State>(
  initial: (environment: Environment) => State,
): (context: PluginContext) => State {
  const stateMap = new WeakMap<Environment, State>();
  return function(context: PluginContext) {
    const { environment } = context;
    let state = stateMap.get(environment);
    if (!state) {
      state = initial(environment);
      stateMap.set(environment, state);
    }
    return state;
  };
}
```

### 3. ビルド関数+コンテキスト型（unjs/unbuild）

`build` 関数 + `BuildContext` + hookable の 3 フェーズ設計。フック登録の 3 層モデル（preset → inputConfig → buildConfig）で拡張性を確保する。

```typescript
// src/build.ts:195-203（フック登録の 3 層モデル）
if (preset.hooks) {
  ctx.hooks.addHooks(preset.hooks);
}
if (inputConfig.hooks) {
  ctx.hooks.addHooks(inputConfig.hooks);
}
if (buildConfig.hooks) {
  ctx.hooks.addHooks(buildConfig.hooks);
}
```

ビルドプロセスは 3 つのグローバルフックで区切られる:

```typescript
// src/build.ts:206-398
await ctx.hooks.callHook("build:prepare", ctx); // コンテキスト拡張
// ... エントリ正規化、依存関係推論 ...
await ctx.hooks.callHook("build:before", ctx); // 設定確定後
// ... ビルダー実行（untyped → mkdist → rollup → copy）...
await ctx.hooks.callHook("build:done", ctx); // 後処理
```

フック型は intersection 合成で統合される:

```typescript
// src/types.ts:197-202
export interface BuildHooks extends CopyHooks, UntypedHooks, MkdistHooks, RollupHooks {
  "build:prepare": (ctx: BuildContext) => void | Promise<void>;
  "build:before": (ctx: BuildContext) => void | Promise<void>;
  "build:done": (ctx: BuildContext) => void | Promise<void>;
}
```

### 4. オーケストレーター関数型（openclaw/openclaw）

`startGatewayServer` が約 480 行のオーケストレーター関数として全サブシステムを順次初期化する。シャットダウンは `createGatewayCloseHandler` が 14 以上のパラメータを受け取り、逆順で停止する。

```typescript
// src/gateway/server.impl.ts:155-638（概要）
export async function startGatewayServer(port, opts) {
  // 1. コンフィグ読み込み・検証・マイグレーション
  // 2. プラグインレジストリのロード
  // 3. チャネルマネージャの生成
  // 4. ノードレジストリ・サブスクリプション管理
  // 5. WebSocket ハンドラの接続
  // 6. サイドカー群の起動
  // 7. コンフィグホットリロード監視
}
```

## Good Example

### mastra: NoOp パターンによるオプショナル機能の null チェック排除

オプショナルな横断的機能（オブザーバビリティ等）に NoOp 実装を提供し、利用側での null チェック散在を防ぐ:

```typescript
// NoOpObservability がすべてのメソッドを空実装で提供
// 利用側は null チェックなしで呼び出せる
this.#observability.getDefaultInstance(); // NoOp なら何もしない
```

### vite: `perEnvironmentState` による環境スコープ状態管理

WeakMap + ファクトリ関数で環境ごとに独立した状態を自動管理。明示的な初期化・破棄コード不要で、環境オブジェクトの GC 時に状態も自動解放される。

### unbuild: フック型の intersection 合成

各ビルダーが独立してフック型を定義し、親型で intersection 合成する。新しいビルダー追加時はフック型定義を追加して intersection に加えるだけ:

```typescript
// 各ビルダーが独立してフック型を定義
interface RollupHooks { "rollup:options": ...; "rollup:done": ...; }
interface MkdistHooks { "mkdist:entries": ...; "mkdist:done": ...; }

// 親型で intersection 合成
interface BuildHooks extends CopyHooks, UntypedHooks, MkdistHooks, RollupHooks { ... }
```

## Bad Example

### コンストラクタの肥大化（mastra）

```typescript
// Bad: Mastra クラスのコンストラクタが 200 行超
// 10 種のコンポーネントの登録ロジックが 1 メソッドに集中
constructor(config: MastraConfig) {
  // tools 登録 (20行) → processors 登録 (15行) → memory 登録 (20行)
  // → vectors 登録 (15行) → ... → agents 登録 (30行)
}

// Better: Phase オブジェクトに分割し、各フェーズを独立テスト可能にする
const phases = [
  new ToolsPhase(config),
  new ProcessorsPhase(config),
  new AgentsPhase(config),
];
for (const phase of phases) await phase.execute(context);
```

### 480 行のオーケストレーター関数（openclaw）

```typescript
// Bad: 1 関数内で 30+ サブシステムを順次初期化
export async function startGatewayServer(port, opts) {
  // 480 行の初期化コード
  // close ハンドラも 14 以上のパラメータを個別に受け取る
}

// Better: Disposable パターンでサブシステムが自身の停止責務を持つ
interface Disposable {
  dispose(): Promise<void>;
  priority: number;
}
const disposables: Disposable[] = [];
// 起動時に登録、停止時に priority 順で dispose
```

### 初期化順序がコメントのみで伝達

```typescript
// Bad: 初期化順序の制約がコメントだけ
// Now add primitives - order matters for auto-registration
// Tools and processors should be added before agents

// Better: 依存グラフを型レベルで表現するか、
// ビルダーパターンで順序を構造的に強制する
```

## 適用ガイド

### どの形態を選ぶか

- **単一クラス型（mastra 方式）**: 横断的関心事を全コンポーネントに一括伝播する必要がある場合。フレームワークのコア設計向き。コンストラクタの肥大化に注意
- **関数+パイプライン型（vite 方式）**: プラグインエコシステムがあり、設定の段階的解決が必要な場合。ビルドツール、設定ドリブンなツール向き
- **ビルド関数+コンテキスト型（unbuild 方式）**: 処理パイプラインに外部コードが介入するフック機構が必要な場合。ビルドツール、CI パイプライン向き
- **オーケストレーター関数型（openclaw 方式）**: 多数のサブシステムを順序付きで起動・停止する場合。サーバー、ゲートウェイ向き。関数の肥大化に注意

### 注意点

- Composition Root はできるだけエントリポイントに近い位置に置き、ビジネスロジック層に依存解決を分散させない
- 初期化順序の制約はコメントだけでなく、型やビルダーパターンで構造的に強制する
- シャットダウン処理は起動の逆順で行い、完了フック（done/close）はすべてのコードパスで発火を保証する

### カスタマイズポイント

- mastra のプッシュ型 DI は、初期化順序をトポロジカルソートで自動化できる
- vite の `perEnvironmentState` パターンは、テナント・リクエストスコープなど他の文脈にも応用可能
- unbuild のフック登録の 3 層モデル（基盤→拡張→ユーザー）は、プラグインの優先度設計に汎用的に使える

## 参考

- [repos/mastra-ai/mastra/architecture.md](../repos/mastra-ai/mastra/architecture.md) — 中央レジストリ、プッシュ型 DI
- [repos/mastra-ai/mastra/api-design-practices.md](../repos/mastra-ai/mastra/api-design-practices.md) — NoOp パターン、コンストラクタ設計
- [repos/vitejs/vite/abstraction-patterns.md](../repos/vitejs/vite/abstraction-patterns.md) — perEnvironmentState、Proxy 合成、プラグイン順序制御
- [repos/vitejs/vite/extensibility-mechanisms.md](../repos/vitejs/vite/extensibility-mechanisms.md) — プラグインパイプライン
- [repos/unjs/unbuild/hook-and-lifecycle-patterns.md](../repos/unjs/unbuild/hook-and-lifecycle-patterns.md) — hookable、フック型 intersection 合成
- [repos/openclaw/openclaw/architecture.md](../repos/openclaw/openclaw/architecture.md) — オーケストレーター関数、シャットダウン
