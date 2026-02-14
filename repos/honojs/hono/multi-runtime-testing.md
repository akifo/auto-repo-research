# Multi-Runtime Testing

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono は Bun, Deno, Node.js, Cloudflare Workers (workerd), Fastly Compute, AWS Lambda, Lambda@Edge の 7 つのランタイムで動作するマルチランタイムフレームワークである。`runtime-tests/` ディレクトリに各ランタイム専用のテストスイートを持ち、ランタイム固有の API（サーバ起動、静的ファイル配信、WebSocket、ストリーミング等）を個別に検証する構成を採用している。特筆すべきは、テストランナー自体もランタイムごとに使い分けている点（Deno は `deno test`、Bun は `bun test`、その他は vitest の projects 機能で統合）と、複数ランタイムのカバレッジを CI で統合して Codecov に送信する仕組みである。

## 設計・実装の詳細

### テストアーキテクチャの全体像

Hono のテスト戦略は 2 層に分かれている。

1. **メインテスト (`src/` 配下)**: vitest で実行。ランタイム非依存のコアロジック（ルーティング、ミドルウェア、JSX 等）を検証する。`vitest.config.ts` のルートに `main`, `jsx-runtime-default`, `jsx-runtime-dom` の 3 プロジェクトとして定義されている。
2. **ランタイムテスト (`runtime-tests/` 配下)**: ランタイム固有のアダプタ・API を各ランタイムのネイティブ環境で検証する。vitest の `projects` 設定で `'./runtime-tests/*/vitest.config.ts'` をワイルドカードで参照し、vitest 系のランタイムテストを自動検出している。

テストファイル冒頭に繰り返し書かれている方針が設計思想を端的に表している:

> "Test just only minimal patterns. Because others are tested well in Cloudflare Workers environment already."

つまり、コアロジックの網羅的テストはメインテストに委ね、ランタイムテストではそのランタイム固有の振る舞いだけを最小限検証するという分業である。

### ランタイムごとのテストランナーの使い分け

| ランタイム | テストランナー | 実行コマンド | 設定ファイル |
|---|---|---|---|
| メイン | vitest | `bun run test` | `vitest.config.ts` (root) |
| Bun | bun test / vitest | `bun test --jsx-import-source ../../src/jsx runtime-tests/bun/*` | なし (bun ネイティブ) |
| Deno | deno test | `deno test -c runtime-tests/deno/deno.json` | `deno.json` |
| Deno JSX | deno test | `deno test -c runtime-tests/deno-jsx/deno.{precompile,react-jsx}.json` | 2つの `deno.*.json` |
| Node.js | vitest | `vitest --run --project node` | `runtime-tests/node/vitest.config.ts` |
| workerd | vitest | `vitest --run --project workerd` | `runtime-tests/workerd/vitest.config.ts` |
| Fastly | vitest | `vitest --run --project fastly` | `runtime-tests/fastly/vitest.config.ts` |
| Lambda | vitest | `vitest --run --project lambda` | `runtime-tests/lambda/vitest.config.ts` |
| Lambda@Edge | vitest | `vitest --run --project lambda-edge` | `runtime-tests/lambda-edge/vitest.config.ts` |

Bun テストは興味深い混合構成を持つ。`index.test.tsx` は vitest の `describe/it/expect` を使い、`color.test.ts` は `bun:test` ネイティブの `test/expect` を使っている。Bun ランタイムは vitest と bun:test の両方と互換性があるため、このような混在が可能になっている。

### vitest projects によるランタイムテスト統合

ルートの `vitest.config.ts` がランタイムテストを含む全プロジェクトを一元管理している。

```ts
// vitest.config.ts:26-28
projects: [
  './runtime-tests/*/vitest.config.ts',
  // ... メインプロジェクト定義
```

各ランタイムの vitest 設定は `defineProject` で最小限の設定だけを記述する。

```ts
// runtime-tests/node/vitest.config.ts:1-11
import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    env: {
      NAME: 'Node',
    },
    globals: true,
    name: 'node',
  },
})
```

Fastly は Vite プラグインによるランタイムポリフィルが必要で、`vite-plugin-fastly-js-compute` を使って Fastly Compute のランタイム環境をエミュレートしている。

```ts
// runtime-tests/fastly/vitest.config.ts:1-10
import fastlyCompute from 'vite-plugin-fastly-js-compute'
import { defineProject } from 'vitest/config'

export default defineProject({
  plugins: [fastlyCompute()],
  test: {
    globals: true,
    name: 'fastly',
  },
})
```

### ランタイム検出メカニズム (`getRuntimeKey`)

各ランタイムテストが正しい環境で動作しているかの検証に使われる `getRuntimeKey()` は、`navigator.userAgent` と各種グローバルオブジェクトの存在を段階的にチェックする。

```ts
// src/helper/adapter/index.ts:50-84
export const getRuntimeKey = (): Runtime => {
  const global = globalThis as any

  const userAgentSupported =
    typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'

  if (userAgentSupported) {
    for (const [runtimeKey, userAgent] of Object.entries(knownUserAgents)) {
      if (checkUserAgentEquals(userAgent)) {
        return runtimeKey as Runtime
      }
    }
  }

  if (typeof global?.EdgeRuntime === 'string') {
    return 'edge-light'
  }

  if (global?.fastly !== undefined) {
    return 'fastly'
  }

  if (global?.process?.release?.name === 'node') {
    return 'node'
  }

  return 'other'
}
```

Fastly テストではこの検出を成立させるために `vi.stubGlobal` でグローバルを書き換えている。

```ts
// runtime-tests/fastly/index.test.ts:7-10
beforeAll(() => {
  vi.stubGlobal('fastly', true)
  vi.stubGlobal('navigator', undefined)
})
```

### ランタイム固有のモック戦略

**AWS Lambda**: `awslambda.streamifyResponse` をグローバルにモックして Lambda Streaming Response を再現している。2 つの異なるモックファイル (`mock.ts` と `stream-mock.ts`) が用途別に分離されている。

```ts
// runtime-tests/lambda/mock.ts:38-42
const awslambda = {
  streamifyResponse: mockStreamifyResponse,
}

vi.stubGlobal('awslambda', awslambda)
```

```ts
// runtime-tests/lambda/stream-mock.ts:35-43
const awslambda = {
  streamifyResponse: mockStreamifyResponse,
  HttpResponseStream: {
    from: (stream: Writable, httpResponseMetadata: unknown): Writable => {
      stream.write(Buffer.from(JSON.stringify(httpResponseMetadata)))
      return stream
    },
  },
}

vi.stubGlobal('awslambda', awslambda)
```

**workerd**: wrangler の `unstable_dev` API を使ってローカルに workerd プロセスを起動し、実際の HTTP リクエストを送信して検証する。これはモックではなく実環境に近いインテグレーションテストである。

```ts
// runtime-tests/workerd/index.test.ts:8-14
beforeAll(async () => {
  worker = await unstable_dev('./runtime-tests/workerd/index.ts', {
    vars: {
      NAME: 'Hono',
    },
    experimental: { disableExperimentalWarning: true },
  })
})
```

**Deno / Bun**: ネイティブの `Deno.serve` / `Bun.serve` で実サーバを立ち上げてストリーミングテストを実行する。モックを使わず、実ランタイムの振る舞いを直接検証している。

### CI でのランタイム並列テストとカバレッジ統合

GitHub Actions CI (`.github/workflows/ci.yml`) では、各ランタイムテストが独立したジョブとして並列実行される。

- `main`: vitest (メインテスト + ランタイムテスト) + カバレッジ収集
- `bun`: bun test + カバレッジ収集
- `deno`: deno test + `deno coverage --lcov` でカバレッジ収集
- `node`: Node.js 18.18.2 / 20.x / 22.x のマトリクスビルド (ビルド必須)
- `workerd`, `fastly`, `lambda`, `lambda-edge`: vitest (ビルド必須)
- `bun-windows`: Windows 環境での Bun テスト (カバレッジなし)

カバレッジの統合は `coverage` ジョブが `main`, `bun`, `deno` の 3 ジョブ完了後に `actions/download-artifact` でアーティファクトを集約し、Codecov に送信する。

```yaml
# .github/workflows/ci.yml:15-32
coverage:
  name: 'Coverage'
  runs-on: ubuntu-latest
  needs:
    - main
    - bun
    - deno
  steps:
    - uses: actions/checkout@v6
    - uses: actions/download-artifact@v6
      with:
        pattern: coverage-*
        merge-multiple: true
        path: ./coverage
    - uses: codecov/codecov-action@v5
      with:
        fail_ci_if_error: true
        directory: ./coverage
```

### Deno JSX のデュアルコンパイル戦略

Deno 環境では JSX のコンパイル方式が 2 種類テストされている。`deno.precompile.json` は `"jsx": "precompile"` で Deno 独自の最適化済み JSX 変換を使い、`deno.react-jsx.json` は `"jsx": "react-jsx"` で標準的な React JSX Transform を使う。同一のテストファイル (`jsx.test.tsx`) を異なるコンパイラ設定で 2 回実行することで、両方の JSX Transform で同じ出力が得られることを保証している。

テストコード内でも出力の差異を許容する書き方がされている:

```tsx
// runtime-tests/deno-jsx/jsx.test.tsx:161-166
Deno.test('JSX: null or undefined', async () => {
  const nullHtml = <div className={null}></div>
  const undefinedHtml = <div className={undefined}></div>

  // react-jsx : <div>
  // precompile : <div > // Extra whitespace is allowed because it is a specification.

  assertEquals(nullHtml.toString().replace(/\s+/g, ''), '<div></div>')
  assertEquals(undefinedHtml.toString().replace(/\s+/g, ''), '<div></div>')
})
```

## コード例

### Node.js テストでの HTTP エージェントパターン

Node.js テストでは `@hono/node-server` の `createAdaptorServer` で実際の HTTP サーバを起動し、`undici.fetch` でリクエストを送るヘルパーを自作している。

```ts
// runtime-tests/node/index.test.ts:280-301
function createAgent(app: Hono) {
  const server = createAdaptorServer(app)
  const listening = once(server.listen(), 'listening')

  return {
    async get(path: string, init?: undici.RequestInit) {
      await listening
      const url = new URL(path, getOrigin())
      return undici.fetch(url, init)
    },
  }

  function getOrigin(): string {
    let address = server.address()

    if (typeof address === 'object') {
      address = address?.port ? `http://localhost:${address.port}` : 'http://localhost'
    }

    return address
  }
}
```

### Fastly の WebCrypto ポリフィル検出テスト

Fastly 環境では WebCrypto API の互換性が不完全であることをテストで明示的に検証している。

```ts
// runtime-tests/fastly/index.test.ts:93-105
describe('JWT Auth Middleware does not work', () => {
  const app = new Hono()

  // Since nodejs 20 or later, global WebCrypto object becomes stable (experimental on nodejs 18)
  // but WebCrypto does not have compatibility with Fastly Compute runtime (lacking some objects/methods in Fastly)
  // so following test should run only be polyfill-ed via vite-plugin-fastly-js-compute plugin.
  // To confirm polyfill-ed or not, check __fastlyComputeNodeDefaultCrypto field is true.
  it.runIf(!globalThis.__fastlyComputeNodeDefaultCrypto)('Should throw error', () => {
    expect(() => {
      app.use('/jwt/*', jwt({ secret: 'secret' }))
    }).toThrow(/`crypto.subtle.importKey` is undefined/)
  })
})
```

### Bun の cross-platform パス検証

Bun テストでは Windows 環境でのパス区切り文字の違いを考慮した検証が含まれている。

```ts
// runtime-tests/bun/index.test.tsx:126-131
expect(onNotFound).toHaveBeenCalledWith(
  process.platform === 'win32'
    ? 'runtime-tests\\bun\\favicon-notfound.ico'
    : 'runtime-tests/bun/favicon-notfound.ico',
  expect.anything()
)
```

## Good Patterns

- **最小限のランタイムテスト + コアテストの分離**: コアロジックはメインの vitest で網羅的にテストし、ランタイムテストではアダプタ固有の振る舞いだけを最小限検証する。テストの重複を避けつつ、ランタイム固有のエッジケースを確実にカバーできる。

```
src/                     # コアロジック -> vitest (main project) で網羅テスト
runtime-tests/
  bun/index.test.tsx     # Bun アダプタ固有: serveStatic, WebSocket, streaming
  deno/hono.test.ts      # Deno アダプタ固有: env, getRuntimeKey
  node/index.test.ts     # Node.js アダプタ固有: createAdaptorServer, compress
  workerd/index.test.ts  # workerd 固有: unstable_dev によるインテグレーションテスト
```

- **vitest projects によるランタイムテスト統合**: ルートの `vitest.config.ts` でワイルドカード `'./runtime-tests/*/vitest.config.ts'` を使い、新しいランタイムテストの追加がディレクトリ作成と `vitest.config.ts` 配置だけで完結する。

```ts
// vitest.config.ts:26-27
projects: [
  './runtime-tests/*/vitest.config.ts',
```

- **ランタイムネイティブのテストランナー活用**: Deno は `Deno.test` + `@std/assert`、Bun は `bun:test` をそれぞれネイティブに使う。ランタイム固有の API（`Deno.serve`, `Bun.serve`）を直接テストできるため、モックによる偽陽性を回避できる。

```ts
// runtime-tests/deno/stream.test.ts:21-23
const server = Deno.serve({ port: 0 }, app.fetch)
const ac = new AbortController()
const req = new Request(`http://localhost:${server.addr.port}/stream`, { signal: ac.signal })
```

- **CI カバレッジの多ランタイム統合**: 各ランタイムのカバレッジを artifacts としてアップロードし、最後にマージして Codecov に送信する。ランタイムが異なっても同一ソースコードのカバレッジとして統合される。

## Anti-Patterns / 注意点

- **グローバル汚染によるランタイムエミュレーション**: Fastly テストでは `vi.stubGlobal('fastly', true)` でランタイム検出をハックしている。グローバルの stub 忘れや、テスト順序依存のバグを引き起こすリスクがある。

```ts
// Bad: グローバル直接書き換え
beforeAll(() => {
  vi.stubGlobal('fastly', true)
  vi.stubGlobal('navigator', undefined)
})

// Better: vitest の environment カスタム設定やランタイムプール設定を使う
// (ただし Hono の規模では現行方式で十分機能している)
```

- **テストランナーの混在による認知コストの増大**: Bun テスト内で `vitest` と `bun:test` が混在している (`index.test.tsx` は vitest、`color.test.ts` は bun:test)。テストの書き方やアサーション API が異なるため、コントリビューターが混乱する可能性がある。

```ts
// runtime-tests/bun/index.test.tsx
import { describe, expect, it, vi } from 'vitest'  // vitest API

// runtime-tests/bun/color.test.ts
import { expect, test } from 'bun:test'              // bun:test API
```

- **ビルド依存のテスト実行**: Node.js, workerd, Fastly, Lambda テストは `bun run build` の完了が前提となる。CI ではジョブのステップ順序で保証されるが、ローカル開発では忘れやすい。

## 自分のプロジェクトへの適用

- [ ] マルチランタイム対応のライブラリを作る場合、`runtime-tests/<runtime>/` のディレクトリ構成を採用し、コアテストとランタイムテストを明確に分離する
- [ ] vitest の `projects` 機能を使い、ルート設定ファイルからワイルドカードで各ランタイムテスト設定を自動検出する構成にする
- [ ] Deno / Bun など独自テストランナーを持つランタイムはネイティブランナーを使い、モックではなく実環境テストを優先する
- [ ] CI で各ランタイムのカバレッジを artifacts 経由で統合し、単一の Codecov レポートにまとめる仕組みを構築する
- [ ] ランタイム検出ヘルパー (`getRuntimeKey` 相当) を実装し、ランタイムテストの第一テストケースで正しいランタイムで動作していることを検証する
- [ ] ランタイム固有の API 制限（例: Fastly の WebCrypto 非対応）は条件付きテスト (`it.runIf`) で明示的にドキュメント化する
