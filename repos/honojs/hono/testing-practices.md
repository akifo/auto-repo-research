# testing-practices

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono は 7 つ以上のランタイム（Cloudflare Workers, Deno, Bun, Node.js, Fastly, AWS Lambda, Lambda@Edge）で動作する Web フレームワークであり、テスト戦略そのものがマルチランタイム対応の設計課題を解決する実践の宝庫である。特筆すべきは、`app.request()` による「HTTP サーバーを起動しない」テストパターンを基盤とし、主要テストを Vitest 上で集約しつつ、ランタイム固有の差異のみを各ランタイムのネイティブテストに分離する二層構造を採用している点である。117 個以上のテストファイルにわたる 785 箇所以上の `app.request()` 呼び出しが、この戦略の徹底度を物語る。

## 背景にある原則

- **Web Standards を共通基盤としたテスト可搬性**: テストの入出力を `Request`/`Response` の Web 標準 API に統一することで、ランタイム間の差異をテスト対象から排除できる。Hono のほぼ全テストが `new Request()` と `Response` の検証で完結しており、テストコード自体がランタイム非依存になっている（`src/hono.test.ts` 全体、各 middleware のテスト）。

- **テスト速度は本番忠実性とトレードオフではなく階層で解決する**: 高速な単体テスト（`app.request()` でサーバーなし）と低速だが本番忠実なランタイムテスト（実際のサーバー起動）を分離することで、両立を図る。runtime-tests/ 内の各ファイルは冒頭で `// Test just only minimal patterns. Because others are tested well in Cloudflare Workers environment already.` と明記し、重複テストを意図的に回避している（`runtime-tests/bun/index.test.tsx:17-18`, `runtime-tests/deno/hono.test.ts:7-8`）。

- **モックは境界にのみ適用し、ビジネスロジック層を汚染しない**: `vi.stubGlobal()` は Web API のポリフィル（`crypto`, `caches`, `awslambda`）や環境検出（`fastly`, `navigator`）に限定される。ミドルウェアのテストでは外部通信が必要な場合のみ `msw` を使い、それ以外は `app.request()` で実際のミドルウェアチェーンを通すことで、モックによる偽陽性を最小化している。

- **型テストはランタイムテストと同格の一級市民である**: `expectTypeOf()` が 16 ファイル・640 箇所以上で使われ、型推論の正確性をテストとして検証している（`src/types.test.ts`, `src/hono.test.ts`）。型安全性がフレームワークの中核価値であるため、型の回帰を CI で検知する仕組みが必要という判断。

## 実例と分析

### app.request() — サーバーレステストの基盤

Hono は `HonoBase` クラスに `request()` メソッドを組み込み、テスト専用の軽量リクエスト実行を実現している。パス文字列を渡すだけで内部的に `http://localhost` のプレフィックスを付与し `fetch()` を呼ぶため、テストコードが極めて簡潔になる。

```typescript
// src/hono-base.ts:493-511
request = (
  input: RequestInfo | URL,
  requestInit?: RequestInit,
  Env?: E["Bindings"] | {},
  executionCtx?: ExecutionContext,
): Response | Promise<Response> => {
  if (input instanceof Request) {
    return this.fetch(requestInit ? new Request(input, requestInit) : input, Env, executionCtx);
  }
  input = input.toString();
  return this.fetch(
    new Request(
      /^https?:\/\//.test(input) ? input : `http://localhost${mergePath("/", input)}`,
      requestInit,
    ),
    Env,
    executionCtx,
  );
};
```

これにより、テストはサーバー起動・ポート確保・ソケットクローズのオーバーヘッドなしで動作する。

```typescript
// src/middleware/cors/index.test.ts:4-7
const app = new Hono();
app.use("/api/*", cors());
// ...
const res = await app.request("http://localhost/api/foo");
expect(res.status).toBe(200);
```

### testClient — 型安全な RPC スタイルテスト

`hono/testing` は `testClient` ユーティリティを提供し、`hc`（Hono Client）のカスタム `fetch` を `app.request` に差し替えることで、型安全なテストクライアントを実現している。

```typescript
// src/helper/testing/index.ts:16-27
export const testClient = <T extends Hono<any, Schema, string>>(
  app: T,
  Env?: ExtractEnv<T>["Bindings"] | {},
  executionCtx?: ExecutionContext,
  options?: Omit<ClientRequestOptions, "fetch">,
): UnionToIntersection<Client<T, "http://localhost">> => {
  const customFetch = (input: RequestInfo | URL, init?: RequestInit) => {
    return app.request(input, init, Env, executionCtx);
  };
  return hc<typeof app, "http://localhost">("http://localhost", { ...options, fetch: customFetch });
};
```

```typescript
// src/helper/testing/index.test.ts:5-8
const app = new Hono().get("/search", (c) => c.json({ hello: "world" }));
const res = await testClient(app).search.$get();
expect(await res.json()).toEqual({ hello: "world" });
```

### ランタイム分離テストの二層構造

主テスト（`src/` 配下、Vitest）がロジックの網羅的テストを担い、ランタイムテスト（`runtime-tests/` 配下）がランタイム固有の動作検証に特化する。

**Vitest multi-project 構成**: ルートの `vitest.config.ts` が `runtime-tests/*/vitest.config.ts` を project として取り込み、単一の `vitest --run` で全プロジェクトを実行する。

```typescript
// vitest.config.ts:26-27
projects: [
  "./runtime-tests/*/vitest.config.ts",
  // ... main project, jsx-runtime-default, jsx-runtime-dom
];
```

**ランタイム別の戦略差異**:

- **workerd**: `wrangler` の `unstable_dev` で実際の Worker インスタンスを起動しテスト（`runtime-tests/workerd/index.test.ts:8-14`）
- **Deno**: `Deno.test()` + `@std/assert` でネイティブテストランナーを使用（`runtime-tests/deno/hono.test.ts`）
- **Bun**: Vitest 互換 API で `Bun.serve()` を使った実サーバーテスト（`runtime-tests/bun/index.test.tsx:386-392`）
- **Node.js**: `@hono/node-server` の `createAdaptorServer` で実サーバーを起動（`runtime-tests/node/index.test.ts:280-301`）
- **Lambda**: `vi.stubGlobal('awslambda', ...)` でグローバルをモックし、ハンドラを直接呼び出し（`runtime-tests/lambda/mock.ts:38-42`）
- **Fastly**: `vi.stubGlobal('fastly', true)` + Vite プラグインで環境を再現（`runtime-tests/fastly/vitest.config.ts:4`, `runtime-tests/fastly/index.test.ts:7-9`）

### セットアップファイルによる Web API ポリフィル

`.vitest.config/setup-vitest.ts` で `crypto` と `caches` のグローバルモックを注入し、Node.js 環境で Cloudflare Workers 互換の API を利用可能にしている。

```typescript
// .vitest.config/setup-vitest.ts:7-10
if (!globalThis.crypto) {
  vi.stubGlobal("crypto", nodeCrypto);
  vi.stubGlobal("CryptoKey", nodeCrypto.webcrypto.CryptoKey);
}
```

Cache API のモックも最小限の実装で、`match`/`put`/`keys` のみを提供する（`.vitest.config/setup-vitest.ts:17-47`）。

### 共有テストケースによるルーター横断テスト

5 つの異なるルーター実装（RegExpRouter, TrieRouter, PatternRouter, LinearRouter, SmartRouter）に対して、`common.case.test.ts` が共通テストスイートを提供する。各ルーターは `runTest({ newRouter: () => new XxxRouter() })` で共通ケースを実行し、対応不可能なケースを `skip` で宣言する。

```typescript
// src/router/reg-exp-router/router.test.ts:3-26
runTest({
  skip: [
    {
      reason: "UnsupportedPath",
      tests: [
        "Duplicate param name > parent",
        "Duplicate param name > child",
        // ...
      ],
    },
  ],
  newRouter: () => new RegExpRouter(),
});
```

### カバレッジの多ランタイム統合

CI は各ランタイムのカバレッジを別々のアーティファクトとして収集し、`coverage` ジョブで統合して Codecov に送信する。Deno は `--coverage` フラグでネイティブカバレッジを取得し lcov に変換、Vitest は V8 プロバイダで JSON 出力する。

```yaml
# .github/workflows/ci.yml:15-32
coverage:
  needs: [main, bun, deno]
  steps:
    - uses: actions/download-artifact@v6
      with:
        pattern: coverage-*
        merge-multiple: true
        path: ./coverage
    - uses: codecov/codecov-action@v5
```

型定義ファイルやベンチマークなど、カバレッジ計測が無意味なファイルは明示的に除外されている（`vitest.config.ts:22-24`）。

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 複数のルーター実装を統一インターフェースでテストする
  - 適用条件: 同一インターフェースを持つ複数の実装が存在する場合
  - コード例: `src/router/common.case.test.ts:14-57` — `runTest({ newRouter })` が Router インターフェースに対してテストを実行
  - 注意点: `skip` 機構で実装ごとの制約を宣言的に管理する必要がある

- **Adapter パターン** (分類: 構造)
  - 解決する問題: テストクライアントが本番クライアントと同じ型安全性を提供する
  - 適用条件: 本番用クライアント（`hc`）のインターフェースをテストでも活用したい場合
  - コード例: `src/helper/testing/index.ts:22-26` — `customFetch` を `app.request` に差し替え

## Good Patterns

- **フレームワーク組み込みのテストメソッド**: `app.request()` をフレームワーク本体に含めることで、ユーザーが別途テストユーティリティを導入する必要がなくなり、テストの書きやすさがフレームワークの設計品質に直結する。

```typescript
// src/hono.test.ts:77-82
const res = await app.request("http://localhost/hello");
expect(res).not.toBeNull();
expect(res.status).toBe(200);
expect(await res.text()).toBe("hello");
```

- **ランタイムテストの「最小パターン」原則**: 各ランタイムテストは基本動作・環境変数・ランタイム固有機能（WebSocket, ServeStatic 等）のみを検証し、ミドルウェアのロジックテストはメインテストに委譲する。これにより、ランタイムテスト追加のコストが低く保たれる。

```typescript
// runtime-tests/deno/hono.test.ts:7-8
// Test just only minimal patterns.
// Because others are tested well in Cloudflare Workers environment already.
```

- **Web API 境界でのモック注入**: モックは `vi.stubGlobal` でグローバル API 層に限定し、アプリケーションコード内にモック用の分岐や DI 機構を持ち込まない。

```typescript
// runtime-tests/fastly/index.test.ts:7-9
beforeAll(() => {
  vi.stubGlobal("fastly", true);
  vi.stubGlobal("navigator", undefined);
});
```

- **宣言的スキップによる共通テストの柔軟な適用**: 共通テストスイートに `skip` 配列を渡すことで、各実装の制約をテストコード内に文書化しつつ、対応可能なケースは自動的に全実装で検証される。

```typescript
// src/router/reg-exp-router/router.test.ts:8-19
skip: [
  {
    reason: 'UnsupportedPath',
    tests: ['Duplicate param name > parent', ...],
  },
],
```

## Anti-Patterns / 注意点

- **ランタイムテストの肥大化**: ランタイム固有テストにロジックテストを混入させると、テストの重複とメンテナンスコストが増大する。Hono はこれを「最小パターン原則」のコメントで抑制しているが、Bun テスト（455 行）は他ランタイム（Deno 36 行, Node.js 302 行）と比べて膨張傾向にある。

```typescript
// Bad: ランタイムテストにミドルウェアロジックの詳細テストを含める
// runtime-tests/bun/index.test.tsx — JWT/BasicAuth テストがメインテストと重複
describe("JWT Auth Middleware", () => {/* ... 同じテストがメインにも存在 */});

// Better: ランタイム固有の動作のみテスト
describe("Bun-specific", () => {
  it("returns correct runtime key", () => {
    expect(getRuntimeKey()).toBe("bun");
  });
});
```

- **セットアップファイルへの暗黙的な依存**: `.vitest.config/setup-vitest.ts` で `crypto` と `caches` をグローバルに注入するため、テストファイル単体を読んでも依存関係が見えない。これはテストの可読性を損なうリスクがある。

```typescript
// Bad: テストファイル内で crypto が使えることが暗黙的
// src/middleware/jwt/index.test.ts — crypto の import なしで動作

// Better: セットアップファイルの存在をテストファイルの冒頭コメントで明示する
// NOTE: This test relies on crypto polyfill from .vitest.config/setup-vitest.ts
```

## 導出ルール

- `[MUST]` マルチランタイム対応ライブラリでは、テストの入出力を Web 標準 API（Request/Response）に統一し、ランタイム固有の API をテストの境界に限定する
  - 根拠: Hono の 785 箇所以上の `app.request()` 呼び出しがすべて `Request`/`Response` で完結しており、これにより同一テストが Node.js/Bun/Deno で再利用可能になっている

- `[MUST]` 共通テストスイートを複数の実装に対して実行する場合、対応不可能なケースは理由付きの宣言的スキップ機構で管理する（テストコード内 `if` 分岐ではなく）
  - 根拠: `src/router/common.case.test.ts` の `skip: [{ reason, tests }]` 構造により、各ルーターの制約が自己文書化されている

- `[SHOULD]` HTTP フレームワークのテストでは、サーバーを起動せず `app.request()` 相当の軽量実行パスを用意し、ランタイム統合テストはランタイム固有の動作検証のみに絞る
  - 根拠: Hono の main テスト（3,673 行）は全てサーバーレスで実行され、ランタイムテスト（Deno 36 行, Node 302 行）はランタイム固有の動作のみを検証する二層構造で高速性と本番忠実性を両立している

- `[SHOULD]` テスト用のモックは Web API 境界（`vi.stubGlobal`）に限定し、アプリケーション層にモック用の DI 機構を持ち込まない
  - 根拠: `.vitest.config/setup-vitest.ts` と `runtime-tests/lambda/mock.ts` のモックは全て `vi.stubGlobal` でグローバル API 層に注入され、プロダクションコードにテスト用分岐が存在しない

- `[SHOULD]` 複数ランタイムのカバレッジは各ランタイムで個別取得し、CI の最終ステップでアーティファクトとして統合する
  - 根拠: `.github/workflows/ci.yml` の `coverage` ジョブが main/bun/deno の 3 ジョブからカバレッジアーティファクトを収集・統合して Codecov に送信している

- `[SHOULD]` 型推論の正確性を `expectTypeOf()` 等でテストし、型の回帰を CI で検知する（特に型安全性がライブラリの価値である場合）
  - 根拠: 16 ファイル・640 箇所以上の `expectTypeOf()` が型推論の正しさを検証し、TypeScript 型システムの回帰を実行時テストと同等に扱っている

- `[AVOID]` ランタイム固有テストにランタイム非依存のロジックテストを含める（テストの重複とメンテナンスコスト増大を招く）
  - 根拠: 各 runtime-tests のファイル冒頭に「Test just only minimal patterns」と明記し、重複テストを意図的に回避する方針を宣言している

## 適用チェックリスト

- [ ] フレームワーク/ライブラリにサーバー起動不要のテスト実行パス（`app.request()` 相当）を提供しているか
- [ ] テストの入出力が Web 標準 API またはランタイム非依存のインターフェースで統一されているか
- [ ] ランタイム固有テストが「最小パターン原則」に従い、共通ロジックの検証を重複していないか
- [ ] テスト用モックがグローバル API 境界に限定され、プロダクションコードにテスト用の分岐が混入していないか
- [ ] 同一インターフェースの複数実装に対する共通テストスイートが存在し、スキップ理由が文書化されているか
- [ ] 型安全性が重要なライブラリでは、型推論テスト（`expectTypeOf` 等）が CI に組み込まれているか
- [ ] マルチランタイムのカバレッジが統合されて、一元的に可視化されているか
- [ ] テストセットアップファイルの暗黙的なグローバル注入が文書化またはコメントで明示されているか
