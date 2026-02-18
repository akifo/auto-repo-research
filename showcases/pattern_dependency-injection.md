# Pattern: dependency-injection

> 出典: [Effect-TS/effect](../repos/Effect-TS/effect/dependency-injection.md), [mastra-ai/mastra](../repos/mastra-ai/mastra/api-design-practices.md), [openclaw/openclaw](../repos/openclaw/openclaw/abstraction-patterns.md), [TanStack/query](../repos/TanStack/query/abstraction-patterns.md), [honojs/hono](../repos/honojs/hono/testing-practices.md)
> カテゴリ: pattern

## 概要

TypeScript プロジェクトにおける依存性注入（DI）パターンを、5 つの OSS リポジトリの実装から横断的に分析する。DI コンテナを使わない関数引数ベースの軽量 DI から、型レベルで依存充足を保証する Effect の Layer/Tag パターンまで、プロジェクト規模と要件に応じた 4 つのアプローチを体系化する。

## 背景・文脈

DI は「構築と利用の分離」を実現する設計原則だが、TypeScript/JavaScript エコシステムでは Java/C# のような DI コンテナフレームワーク（Spring, .NET DI）は主流でない。代わりに、言語の第一級関数やモジュールシステムを活かした軽量な DI パターンが各プロジェクトで独自に発展している。

調査した 5 リポジトリは、DI の重さと型安全性のスペクトラム上で異なる位置に立つ:

| リポジトリ        | DI アプローチ                 | 型安全性         | 適用規模 |
| ----------------- | ----------------------------- | ---------------- | -------- |
| honojs/hono       | DI なし（Web API 境界モック） | -                | 小〜中   |
| TanStack/query    | 関数引数ベース DI             | 静的型付き       | 中       |
| openclaw/openclaw | 遅延プロキシ DI コンテナ      | 静的型付き       | 中〜大   |
| mastra-ai/mastra  | プッシュ型 DI Hub             | 静的型付き       | 大       |
| Effect-TS/effect  | 型レベル DI（Layer/Tag）      | コンパイル時保証 | 大       |

## 実装パターン

### 1. 関数引数ベース DI（TanStack/query）

最も軽量な DI。Observer クラスを関数の引数として渡すだけで、DI コンテナに依存しない。

```typescript
// packages/react-query/src/useQuery.ts:50-52
export function useQuery(options: UseQueryOptions, queryClient?: QueryClient) {
  return useBaseQuery(options, QueryObserver, queryClient);
}

// packages/react-query/src/useInfiniteQuery.ts
export function useInfiniteQuery(options, queryClient) {
  return useBaseQuery(options, InfiniteQueryObserver, queryClient);
}
```

同一の `useBaseQuery` 基盤関数に異なる Observer クラスを注入することで、コードの共有と振る舞いの差し替えを両立する。QueryClient の提供もフレームワークの標準的な DI 機構（React Context, Vue provide/inject, Angular DI Token）に委ねる。

### 2. 遅延プロキシ DI（openclaw/openclaw）

依存を動的 `import()` でラップし、使用時まで実際のモジュールをロードしない DI コンテナ。CLI ツールやゲートウェイなど起動時間が重要なアプリケーションで有効。

```typescript
// src/cli/deps.ts:18-45
export function createDefaultDeps(): CliDeps {
  return {
    sendMessageWhatsApp: async (...args) => {
      const { sendMessageWhatsApp } = await import("../channels/web/index.js");
      return await sendMessageWhatsApp(...args);
    },
    sendMessageTelegram: async (...args) => {
      const { sendMessageTelegram } = await import("../telegram/send.js");
      return await sendMessageTelegram(...args);
    },
    // ... 他のチャネルも同様
  };
}
```

`GatewayRequestContext` が `deps: ReturnType<typeof createDefaultDeps>` を保持し、全ゲートウェイメソッドに注入される。テスト時はモック関数で差し替え可能。

### 3. プッシュ型 DI Hub（mastra-ai/mastra）

中央のレジストリクラスがコンポーネント登録時に依存を「プッシュ」で注入する。コンテナベース DI のオーバーヘッドなしに、横断的関心事を全コンポーネントへ届ける。

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

初期化順序は明示的に制御される（`tools → processors → memory → vectors → scorers → workflows → gateways → mcpServers → agents`）。依存元より先に依存先を登録することで、Agent が Tool や Workflow を参照する際に確実に解決できる。

### 4. 型レベル DI — Layer/Tag（Effect-TS/effect）

依存関係を型パラメータ `R`（Requirements）で追跡し、未提供のサービスをコンパイル時に検出する。

```typescript
// packages/effect/src/Effect.ts:13556-13572
class Prefix extends Effect.Service<Prefix>()("Prefix", {
  sync: () => ({ prefix: "PRE" }),
}) {}

class Logger extends Effect.Service<Logger>()("Logger", {
  accessors: true,
  effect: Effect.gen(function*() {
    const { prefix } = yield* Prefix;
    return {
      info: (message: string) =>
        Effect.sync(() => {
          console.log(`[${prefix}][${message}]`);
        }),
    };
  }),
  dependencies: [Prefix.Default],
}) {}
```

Layer は DAG（有向非巡回グラフ）を形成し、`merge`（並列合成）と `provide`（依存提供）で依存グラフを構築する。MemoMap による自動メモ化で、ダイヤモンド依存でもサービスは一度だけ構築される。

```typescript
// packages/effect/test/Layer.test.ts:77-85
const layer = makeLayer1(ref);
const env = layer.pipe(Layer.merge(layer), Layer.build);
yield * Effect.scoped(env);
const result = yield * Ref.get(ref);
deepStrictEqual(Array.from(result), [acquire1, release1]); // 1回だけ
```

## Good Example

### Tag + Layer の共置（Effect-TS/effect）

サービスの識別子（Tag）と構築方法（Layer）を同一クラスに共置する。利用者はインポート 1 つで両方にアクセスでき、テスト時はモック Layer を差し替えるだけ。

```typescript
// packages/effect/test/Effect/environment.test.ts:37-48
class DateTag extends Effect.Tag("DateTag")<DateTag, Date>() {
  static date = new Date(1970, 1, 1);
  static Live = Layer.succeed(this, this.date);
}

class NumberTag extends Effect.Tag("NumberTag")<NumberTag, number>() {
  static Live = Layer.succeed(this, 100);
}
```

### 遅延プロキシのテスト検証（openclaw/openclaw）

6 チャネルのうち使われない 5 つのモジュールがロードされないことをテストで検証する。DI の遅延性が単なる実装詳細でなく、明示的な不変条件として保護されている。

```typescript
// src/cli/deps.test.ts:57-78（テストの意図を示す構造）
// Telegram を呼ぶまで WhatsApp モジュールは未ロード
```

### Observer クラスの引数注入（TanStack/query）

DI コンテナもデコレータも不要。関数の引数としてクラスを渡すだけで Strategy パターンを実現する、TypeScript らしい最小限の DI。

```typescript
// packages/react-query/src/useQuery.ts:50-52
export function useQuery(options, queryClient?) {
  return useBaseQuery(options, QueryObserver, queryClient);
}
// useInfiniteQuery は InfiniteQueryObserver を注入するだけ
```

## Bad Example

### 文字列キーのみの Service Locator

名目的型付けがないサービスロケータは、同じキーで異なる型のサービスを登録できてしまい、型安全性が崩壊する。

```typescript
// Bad: 同じキーで異なる型 — 実行時に区別できない
const NumberTag = Context.GenericTag<number>("config");
const StringTag = Context.GenericTag<string>("config");

// Better: クラスベースの Tag を使い、型の一意性を保証
class NumberConfig extends Context.Tag("NumberConfig")<NumberConfig, number>() {}
class StringConfig extends Context.Tag("StringConfig")<StringConfig, string>() {}
```

### アプリケーション層へのモック DI 機構の持ち込み

テストのためにアプリケーションコードに DI 機構を追加すると、本番コードにテスト用の分岐が入り込む。

```typescript
// Bad: テストのためにアプリ層に DI 機構を持ち込む
function handleRequest(req, deps = defaultDeps) {
  // deps が本番では使われない分岐の温床に
  if (deps.mockMode) { ... }
}

// Better: Web API 境界でモックする（honojs/hono のアプローチ）
// runtime-tests/fastly/index.test.ts:7-9
beforeAll(() => {
  vi.stubGlobal("fastly", true);
  vi.stubGlobal("navigator", undefined);
});
```

### Layer.fresh の不用意な使用（Effect-TS/effect）

メモ化を無効化すると、リソース付きサービスが複数回構築され、リソースリークを引き起こす。

```typescript
// Bad: fresh で DB 接続プールが2つ作られる
const app = myService.pipe(
  Layer.provide(Layer.fresh(dbLayer)),
  Layer.merge(otherService.pipe(Layer.provide(Layer.fresh(dbLayer)))),
);

// Better: デフォルトのメモ化を活用
const app = myService.pipe(
  Layer.provide(dbLayer),
  Layer.merge(otherService.pipe(Layer.provide(dbLayer))),
);
```

## 適用ガイド

### どのパターンを選ぶか

- **DI なし（hono 方式）**: 依存が少なく、テストは Web API 境界のモックで十分な場合。HTTP フレームワーク、ユーティリティライブラリ向き
- **関数引数ベース（TanStack 方式）**: 差し替えたい依存が 1-2 個で、Strategy パターンで十分な場合。ライブラリの公開 API 設計向き
- **遅延プロキシ（openclaw 方式）**: 起動時間が重要で、多数のモジュールを遅延ロードしたい場合。CLI ツール、ゲートウェイ向き
- **プッシュ型 DI Hub（mastra 方式）**: 多数のコンポーネントが横断的関心事（ロガー、ストレージ）を共有する場合。フレームワークのコア設計向き
- **型レベル DI（Effect 方式）**: 依存関係の充足をコンパイル時に保証したい場合。リソースライフサイクル管理が複雑なシステム向き

### 注意点

- TypeScript では Java/C# 的なデコレータベース DI（`@Inject`）よりも、関数引数・クロージャ・モジュールスコープを活かした軽量な DI が主流
- DI コンテナの導入は「テスタビリティ」「差し替え可能性」の実際のニーズに基づいて判断する。YAGNI に注意
- Effect の Layer/Tag は強力だが学習コストが高い。プロジェクト全体で Effect を採用する場合にのみ検討する

### カスタマイズポイント

- 遅延プロキシ DI は `Proxy` オブジェクトを使えばプロパティアクセスベースの遅延解決に拡張できる
- プッシュ型 DI Hub の初期化順序は、依存グラフのトポロジカルソートで自動化できる
- Effect の `Context.Reference` を使えば、オプショナルな依存にデフォルト値を提供でき、`R` 型パラメータから除外される

## 参考

- [repos/Effect-TS/effect/dependency-injection.md](../repos/Effect-TS/effect/dependency-injection.md) — Layer/Tag/MemoMap の詳細分析
- [repos/mastra-ai/mastra/api-design-practices.md](../repos/mastra-ai/mastra/api-design-practices.md) — DI Hub パターンと初期化順序
- [repos/mastra-ai/mastra/architecture.md](../repos/mastra-ai/mastra/architecture.md) — プッシュ型 DI の伝播メカニズム
- [repos/openclaw/openclaw/abstraction-patterns.md](../repos/openclaw/openclaw/abstraction-patterns.md) — 遅延プロキシ DI と PluginRegistry
- [repos/TanStack/query/abstraction-patterns.md](../repos/TanStack/query/abstraction-patterns.md) — Observer クラス引数注入
- [repos/TanStack/query/framework-adapter-patterns.md](../repos/TanStack/query/framework-adapter-patterns.md) — フレームワーク別 QueryClient DI
- [repos/honojs/hono/testing-practices.md](../repos/honojs/hono/testing-practices.md) — DI を使わない Web API 境界テスト
