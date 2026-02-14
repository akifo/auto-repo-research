# testing-strategy

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono のテスト戦略は、マルチランタイムフレームワークとしての特性を最大限に活かした多層構造になっている。Vitest をメインテストランナーとし、`app.request()` による HTTP レベルの統合テストを主軸としながら、Deno・Bun・workerd・Lambda など各ランタイム固有のテストを `runtime-tests/` に分離している。特にルーター共通テストケースのパラメータ化パターンと、型レベルテストの充実度が注目に値する。

## 設計・実装の詳細

### テストアーキテクチャの全体像

テストは以下の 4 層で構成される。

1. **ユニットテスト（src/ 内コロケーション）**: `compose.test.ts`, `context.test.ts`, `request.test.ts` など、コアモジュール単位のテスト
2. **統合テスト（src/ 内コロケーション）**: `hono.test.ts`（3,673行）がフレームワーク全体の振る舞いを検証。ルーティング、ミドルウェア連携、エラーハンドリングを網羅
3. **型テスト**: `types.test.ts`（3,684行）と `client/types.test.ts` で `expectTypeOf` を用いた型レベルの検証
4. **ランタイムテスト**: `runtime-tests/` 配下で各ランタイム固有の挙動を最小限のパターンで検証

### `app.request()` — テスト用ビルトインメソッド

Hono はテスト用に `app.request()` メソッドをフレームワーク本体に組み込んでいる。HTTP サーバーを起動せずに、直接 `Request` オブジェクトを渡してルーティングからレスポンス生成まで一気通貫でテストできる。

```typescript
// src/hono-base.ts:493-511
request = (
  input: RequestInfo | URL,
  requestInit?: RequestInit,
  Env?: E['Bindings'] | {},
  executionCtx?: ExecutionContext
): Response | Promise<Response> => {
  if (input instanceof Request) {
    return this.fetch(requestInit ? new Request(input, requestInit) : input, Env, executionCtx)
  }
  input = input.toString()
  return this.fetch(
    new Request(
      /^https?:\/\//.test(input) ? input : `http://localhost${mergePath('/', input)}`,
      requestInit
    ),
    Env,
    executionCtx
  )
}
```

パスだけ渡せば `http://localhost` が自動補完されるため、テストコードが簡潔になる。

### testClient — 型安全なテストヘルパー

`hono/testing` から提供される `testClient` は、RPC クライアント（`hc`）のテスト版で、`app.request()` をカスタム fetch として注入することで、型安全な API テストを実現する。

```typescript
// src/helper/testing/index.ts:16-27
export const testClient = <T extends Hono<any, Schema, string>>(
  app: T,
  Env?: ExtractEnv<T>['Bindings'] | {},
  executionCtx?: ExecutionContext,
  options?: Omit<ClientRequestOptions, 'fetch'>
): UnionToIntersection<Client<T, 'http://localhost'>> => {
  const customFetch = (input: RequestInfo | URL, init?: RequestInit) => {
    return app.request(input, init, Env, executionCtx)
  }
  return hc<typeof app, 'http://localhost'>('http://localhost', { ...options, fetch: customFetch })
}
```

使用側はルート定義から推論された型で補完が効く。

```typescript
// src/helper/testing/index.test.ts:5-9
it('Should return the correct search result', async () => {
  const app = new Hono().get('/search', (c) => c.json({ hello: 'world' }))
  const res = await testClient(app).search.$get()
  expect(await res.json()).toEqual({ hello: 'world' })
})
```

### ルーター共通テストケースのパラメータ化

`src/router/common.case.test.ts` が全ルーター実装（RegExpRouter, TrieRouter, LinearRouter, SmartRouter）の共通テストスイートを定義する。各ルーターは `runTest()` に自身のファクトリと skip 条件を渡すだけで 800 行超の共通テストを適用できる。

```typescript
// src/router/smart-router/router.test.ts:1-13
import { runTest } from '../common.case.test'
import { RegExpRouter } from '../reg-exp-router'
import { TrieRouter } from '../trie-router'
import { SmartRouter } from './router'

describe('SmartRouter', () => {
  runTest({
    newRouter: () =>
      new SmartRouter({
        routers: [new RegExpRouter(), new TrieRouter()],
      }),
  })
})
```

ルーター固有の制約は `skip` パラメータで明示的に除外する。

```typescript
// src/router/linear-router/router.test.ts:6-22
runTest({
  skip: [
    {
      reason: 'UnsupportedPath',
      tests: [
        'Multi match > `params` per a handler > GET /entry/123/show',
        'Capture regex pattern has trailing wildcard > GET /foo/bar/file.html',
        'Complex > Parameter with {.*} regexp',
      ],
    },
    {
      reason: 'LinearRouter allows trailing slashes',
      tests: ['Trailing slash > GET /book/'],
    },
  ],
  newRouter: () => new LinearRouter(),
})
```

### Vitest プロジェクト構成

`vitest.config.ts` で複数プロジェクトを定義し、JSX ランタイムの違いや各ランタイムテストを単一設定で管理している。

- **main**: `src/` 内の標準テスト（JSX import source は `./src/jsx`）
- **jsx-runtime-default**: `src/jsx/dom/` のテストを `./src/jsx` import source で実行
- **jsx-runtime-dom**: 同テストを `./src/jsx/dom` import source で実行（同一テストを異なる JSX ランタイムで二重実行）
- **runtime-tests**: `runtime-tests/*/vitest.config.ts` を自動収集（fastly, lambda, lambda-edge, node, workerd）

```typescript
// vitest.config.ts:26-27
projects: [
  './runtime-tests/*/vitest.config.ts',
```

### セットアップファイルによるグローバルモック

`.vitest.config/setup-vitest.ts` で、Node.js 環境に不足する Web API をモックしている。

```typescript
// .vitest.config/setup-vitest.ts:7-10
if (!globalThis.crypto) {
  vi.stubGlobal('crypto', nodeCrypto)
  vi.stubGlobal('CryptoKey', nodeCrypto.webcrypto.CryptoKey)
}
```

Cache API のモック実装も同ファイルに含まれ、Cloudflare Workers 向けミドルウェア（cache middleware 等）をNode.js 上でテスト可能にしている。

### ランタイムテストの設計方針

各ランタイムテストは「最小限のパターンのみ検証」という明確な方針を持つ。コードコメントで繰り返し表明されている。

```typescript
// runtime-tests/bun/index.test.tsx:17-18
// Test just only minimal patterns.
// Because others are tested well in Cloudflare Workers environment already.
```

```typescript
// runtime-tests/node/index.test.ts:14
// Test only minimal patterns.
// See <https://github.com/honojs/node-server> for more tests and information.
```

メインの網羅的テストは Vitest（Node.js）で実行し、各ランタイムではランタイム固有の挙動（環境変数アクセス、serve-static、WebSocket、ストリーミング等）のみを検証する。Deno テストは `Deno.test()` + `@std/assert` を使い、Bun テストは `bun test` を直接使う。

### Lambda 固有のモック戦略

Lambda テストでは、AWS 固有の `awslambda.streamifyResponse` をグローバルモックとして注入し、Lambda Response Streaming のテストを実現している。

```typescript
// runtime-tests/lambda/mock.ts:38-42
const awslambda = {
  streamifyResponse: mockStreamifyResponse,
}
vi.stubGlobal('awslambda', awslambda)
```

### CI パイプライン

CI は以下のジョブで構成される。

| ジョブ | ランナー | 内容 |
|--------|----------|------|
| Main | Vitest | tsc --noEmit + vitest --run（全 src テスト） |
| Deno | deno test | runtime-tests/deno + deno-jsx |
| Bun | bun test | runtime-tests/bun（Windows 含む） |
| Fastly/Node/workerd/Lambda/Lambda@Edge | Vitest projects | 各 runtime-tests を vitest --project で実行 |
| Coverage | codecov | 全ジョブのカバレッジをマージして Codecov に送信 |
| perf-measures | PR only | 型チェック + バンドルサイズの回帰検知 |
| http-benchmark | PR only | bombardier による HTTP ベンチマーク、結果を PR コメントに投稿 |

カバレッジは v8 provider で JSON/HTML/text 形式で生成し、Deno の `deno coverage --lcov` 出力とマージして Codecov に統合される。

### 型レベルテスト

`src/types.test.ts`（3,684行）では `expectTypeOf` を用いて、ルート定義からの型推論が正しいことを大量に検証している。

```typescript
// src/types.test.ts:30-48
describe('Env', () => {
  test('Env', () => {
    type E = {
      Variables: { foo: string }
      Bindings: { FLAG: boolean }
    }
    const app = new Hono<E>()
    app.use('*', poweredBy())
    app.get('/', (c) => {
      const foo = c.get('foo')
      expectTypeOf(foo).toEqualTypeOf<string>()
      const FLAG = c.env.FLAG
      expectTypeOf(FLAG).toEqualTypeOf<boolean>()
      return c.text('foo')
    })
  })
})
```

## コード例

ミドルウェアテストの典型パターン。`app.request()` でリクエストを送り、レスポンスのステータスとヘッダーを検証する。

```typescript
// src/middleware/cors/index.test.ts:4-18
describe('CORS by Middleware', () => {
  const app = new Hono()

  app.use('/api/*', cors())
  app.use(
    '/api2/*',
    cors({
      origin: 'http://example.com',
      allowHeaders: ['X-Custom-Header', 'Upgrade-Insecure-Requests'],
      allowMethods: ['POST', 'GET', 'OPTIONS'],
      exposeHeaders: ['Content-Length', 'X-Kuma-Revision'],
      maxAge: 600,
      credentials: true,
    })
  )
```

workerd ランタイムテストでは `wrangler` の `unstable_dev` を使って実際の workerd 上でテストする。

```typescript
// runtime-tests/workerd/index.test.ts:5-18
describe('workerd', () => {
  let worker: Unstable_DevWorker

  beforeAll(async () => {
    worker = await unstable_dev('./runtime-tests/workerd/index.ts', {
      vars: { NAME: 'Hono' },
      experimental: { disableExperimentalWarning: true },
    })
  })

  afterAll(async () => {
    await worker.stop()
  })

  it('Should return 200 response with the runtime key', async () => {
    const res = await worker.fetch('/')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('Hello from workerd')
  })
})
```

## Good Patterns

- **`app.request()` によるサーバーレステスト**: HTTP サーバーを起動せずにフレームワーク全体を通すテストができる。テストの起動が速く、ポート競合もない。Hono 自体がこのメソッドを公式 API として提供している点が秀逸。

```typescript
// src/hono.test.ts:76-82
it('GET http://localhost/hello is ok', async () => {
  const res = await app.request('http://localhost/hello')
  expect(res).not.toBeNull()
  expect(res.status).toBe(200)
  expect(res.statusText).toBe('Hono is OK')
  expect(await res.text()).toBe('hello')
})
```

- **共通テストケースの `runTest()` パターン**: ルーターのように同一インターフェースの複数実装がある場合、共通テストスイートを関数化し、実装固有の skip 条件を明示的に管理する。テストの重複を排除しつつ、各実装の制約を文書化する効果もある。

```typescript
// src/router/linear-router/router.test.ts:6-9
runTest({
  skip: [{ reason: 'UnsupportedPath', tests: [...] }],
  newRouter: () => new LinearRouter(),
})
```

- **ランタイムテストの「最小限のみ」方針**: メインテストで網羅的に検証し、ランタイムテストはそのランタイム固有の差異だけに絞る。テストの保守コストを抑えつつ、クロスランタイム互換性を担保している。

```typescript
// runtime-tests/bun/index.test.tsx:17-18
// Test just only minimal patterns.
// Because others are tested well in Cloudflare Workers environment already.
```

- **型テストの独立ファイル化**: `types.test.ts` に `expectTypeOf` ベースの型テストを集約。型推論の回帰を CI で自動検知できる。

```typescript
// src/types.test.ts:42-44
const foo = c.get('foo')
expectTypeOf(foo).toEqualTypeOf<string>()
```

## Anti-Patterns / 注意点

- **テストファイルの巨大化**: `hono.test.ts`（3,673行）と `types.test.ts`（3,684行）は単一ファイルとしては非常に大きい。機能領域ごとにファイルを分割したほうが、変更時の影響範囲の特定やテストの並列実行効率が向上する。ただし Hono では意図的にフレームワーク全体の統合テストとして維持している可能性がある。

```
// Bad: 1ファイルに3,600行超のテスト
src/hono.test.ts      — 3,673 lines
src/types.test.ts     — 3,684 lines

// Better: 機能ごとに分割
src/__tests__/routing.test.ts
src/__tests__/middleware-chain.test.ts
src/__tests__/error-handling.test.ts
src/__tests__/type-inference.test.ts
```

- **ランタイム間のテストフレームワーク混在**: Vitest、Deno.test（`@std/assert`）、bun test の 3 つのテストランナーが混在する。これはマルチランタイム対応の宿命だが、アサーションスタイルが統一されない（`expect` vs `assertEquals` vs `expect`）ため、テストの書き方にコンテキストスイッチが必要になる。

```typescript
// Vitest (src/ と runtime-tests/node 等)
expect(res.status).toBe(200)

// Deno (runtime-tests/deno/)
assertEquals(res.status, 200)
```

## 自分のプロジェクトへの適用

- [ ] Web フレームワークを開発する場合、`app.request()` のような HTTP サーバーレスなテスト用メソッドを提供し、テストの起動速度とシンプルさを向上させる
- [ ] 同一インターフェースの複数実装（Strategy パターン等）がある場合、`runTest({ newInstance, skip })` パターンで共通テストスイートを構築する
- [ ] 型安全性が重要な API では `expectTypeOf` を用いた型レベルテストを CI に組み込み、型推論の回帰を防ぐ
- [ ] マルチ環境対応が必要な場合、メイン環境で網羅テスト、他環境は差分のみという方針を明文化してテスト保守コストを制御する
- [ ] Vitest の projects 機能を活用して、同一テストを異なる設定（JSX ランタイム等）で二重実行し、設定違いによるバグを検知する
- [ ] CI に型チェック・バンドルサイズ・HTTP ベンチマークを組み込み、PR 単位でパフォーマンス回帰を検知する仕組みを構築する
