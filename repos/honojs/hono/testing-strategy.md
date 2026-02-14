# testing-strategy

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono は Web Standards ベースのマルチランタイム対応フレームワークであり、そのテスト戦略は「単一コードベースを 7+ ランタイムで検証する」という課題に正面から取り組んでいる。Vitest マルチプロジェクト構成でコアロジック・JSX ランタイム差分を分離しつつ、`runtime-tests/` ディレクトリでランタイム固有のアダプター検証を行う二層構造を採用している。特に注目すべきは、共通テストスイートを関数としてエクスポートし各実装が skip リスト付きで呼び出す「Parameterized Test Suite」パターンと、`app.request()` による HTTP サーバー不要のテスト設計である。

## 設計思想

- **Web Standards を信頼境界とする**: コアテスト（117 ファイル）は Vitest + Node.js 上で `app.request()` を使い、実 HTTP サーバーなしで検証する。これは Hono が `Request`/`Response` という Web Standards API のみに依存しているため成立する。ランタイムテスト（13 ファイル）は各ランタイムのアダプター層と固有 API のみを最小限テストする。根拠: `runtime-tests/deno/hono.test.ts:7-8` のコメント「Test just only minimal patterns. Because others are tested well in Cloudflare Workers environment already.」

- **テスト対象の能力差を skip リストで明示する**: 5 種のルーター実装が共通テストスイートを共有し、各ルーターが対応不能なケースを理由付き skip リストで宣言する。テストが「何をテストしないか」を明示的に管理することで、実装間の能力差をドキュメント化している。根拠: `src/router/reg-exp-router/router.test.ts:8-24` の skip 宣言。

- **JSX コンパイラ差分をプロジェクト分割で吸収する**: 同一テストファイルを異なる `jsxImportSource` で 2 回実行することで、サーバーサイド JSX と DOM JSX のランタイム差分を検出する。Vitest の `projects` 設定で esbuild の JSX 設定を切り替え、ビルド時の差分をテスト時に再現している。根拠: `vitest.config.ts:26-65` の 3 プロジェクト定義。

- **ランタイムごとにテストランナーを使い分ける**: Deno は `Deno.test`、Bun は `bun:test`（一部）、その他は Vitest と、各ランタイムのネイティブテストランナーを使う。Vitest で統一しないのは、Deno/Bun のランタイム固有 API（`Deno.env`、`Bun.build` 等）を正確にテストするため。根拠: CI ワークフロー（`.github/workflows/ci.yml`）の job 分割構成。

## 設計・実装の詳細

### Vitest マルチプロジェクト構成

ルート `vitest.config.ts` は 3 種のインラインプロジェクトと、`runtime-tests/*/vitest.config.ts` へのグロブ参照を組み合わせている。

| プロジェクト名 | 対象 | JSX 設定 |
|---|---|---|
| `main` | `src/**`, `scripts/**`, `build/**` | `jsxImportSource: './src/jsx'` |
| `jsx-runtime-default` | `src/jsx/dom/**` | `jsxImportSource: './src/jsx'` |
| `jsx-runtime-dom` | `src/jsx/dom/**` | `jsxImportSource: './src/jsx/dom'` |
| `node` | `runtime-tests/node/` | なし |
| `workerd` | `runtime-tests/workerd/` | なし |
| `fastly` | `runtime-tests/fastly/` | Vite plugin |
| `lambda` | `runtime-tests/lambda/` | なし |
| `lambda-edge` | `runtime-tests/lambda-edge/` | なし |

`main` プロジェクトは `**/*.case.test.*` を明示的に除外している（`vitest.config.ts:35`）。これは共通テストスイートが直接実行されず、各ルーター実装のテストファイルから import されて呼び出される設計のため。

### 共通テストスイート（Parameterized Test Suite パターン）

`src/router/common.case.test.ts` は `runTest()` 関数をエクスポートし、ルーターのファクトリ関数と skip リストを引数に取る。

```typescript
// src/router/common.case.test.ts:14-23
export const runTest = ({
  skip = [],
  newRouter,
}: {
  skip?: {
    reason: string
    tests: string[]
  }[]
  newRouter: <T>() => Router<T>
}) => {
```

各ルーターはこの関数を呼び出すだけでよい。TrieRouter は skip なし（全テスト通過）、RegExpRouter は 7 テストを skip する:

```typescript
// src/router/trie-router/router.test.ts:1-8
import { runTest } from '../common.case.test'
import { TrieRouter } from './router'

describe('TrieRouter', () => {
  runTest({
    newRouter: () => new TrieRouter(),
  })
})
```

```typescript
// src/router/reg-exp-router/router.test.ts:7-26
runTest({
  skip: [
    {
      reason: 'UnsupportedPath',
      tests: [
        'Duplicate param name > parent',
        'Duplicate param name > child',
        'Capture Group > Complex capturing group > GET request',
        // ...
      ],
    },
  ],
  newRouter: () => new RegExpRouter(),
})
```

同様のパターンが CSS テストにも適用されている。`src/helper/css/common.case.test.tsx` が共通テストを提供し、サーバーサイド（`src/helper/css/index.test.tsx`）と DOM（`src/jsx/dom/css.test.tsx`）の両方から呼び出される。

### ランタイム固有テストの戦略差

ランタイムテストは 3 つのアプローチに分類される:

1. **ネイティブランナー使用（Deno, Bun）**: 各ランタイム固有のテスト API を使い、ランタイム判定・環境変数・JSX 等の基本動作を検証する。Deno は JSX コンパイラ設定違い（`precompile` vs `react-jsx`）でさらに分岐する。

2. **Vitest + グローバルモック（Fastly）**: `vi.stubGlobal('fastly', true)` で Fastly 環境をシミュレートし、`getRuntimeKey()` が `'fastly'` を返すことを検証する（`runtime-tests/fastly/index.test.ts:7-9`）。

3. **Vitest + 実ランタイム起動（workerd）**: `wrangler` の `unstable_dev` で実際の workerd プロセスを起動し、HTTP リクエストで検証する（`runtime-tests/workerd/index.test.ts:8-11`）。

### `app.request()` によるサーバーレステスト

Hono のコアテスト（117 ファイル中の大半）は `app.request()` を使い、HTTP サーバーを起動せずにテストする。これは `hono-base.ts:493-511` で定義され、内部的に `this.fetch()` を呼ぶ。

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

さらに `hono/testing` から提供される `testClient` は RPC クライアント（`hc`）をラップし、型安全なテストを可能にする:

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

### CI パイプラインの並列化

`.github/workflows/ci.yml` では各ランタイムが独立した job として定義され、並列実行される。Node.js はマトリクスビルド（18, 20, 22）で 3 バージョン検証する。coverage job は `main`, `bun`, `deno` の 3 job 完了後にアーティファクトをマージする。

### Vitest セットアップファイルによるポリフィル

`.vitest.config/setup-vitest.ts` で `crypto` と `caches`（Cache API）のグローバルモックを提供している。これにより Cloudflare Workers の Cache API に依存するコードを Node.js 環境でテスト可能にしている。

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 同一インターフェース（`Router<T>`）の複数実装を同一テストスイートで検証する必要がある
  - 適用条件: 共通インターフェースに対して複数の実装が存在し、振る舞いの互換性を保証したい場合
  - コード例: `src/router/common.case.test.ts:14` の `runTest({ newRouter })` + 各ルーターの呼び出し
  - 注意点: skip リストの管理コストが増えるため、実装間の差異が大きすぎる場合は別テストスイートが適切

## Good Patterns

- **Parameterized Test Suite with Declarative Skip**: 共通テストスイートを関数化し、skip リストで各実装の非対応ケースを理由付きで宣言する。テストコードの重複を排除しつつ、実装間の能力差をコードで文書化できる。

```typescript
// src/router/linear-router/router.test.ts:6-19
runTest({
  skip: [
    {
      reason: 'UnsupportedPath',
      tests: [
        'Multi match > `params` per a handler > GET /entry/123/show',
        'Capture regex pattern has trailing wildcard > GET /foo/bar/file.html',
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

- **Built-in Test Method (`app.request()`)**: フレームワーク本体にテスト用メソッドを組み込み、HTTP サーバー起動なしで Request/Response レベルのテストを実行する。テスト速度の向上と環境依存の排除を同時に実現する。

```typescript
// src/hono.test.ts のテストパターン
const app = new Hono()
app.get('/hello', (c) => c.text('Hello!'))
const res = await app.request('/hello')
expect(res.status).toBe(200)
expect(await res.text()).toBe('Hello!')
```

- **Runtime-Specific Minimal Testing**: ランタイム固有テストは「最小限のパターンのみ」を方針とし、コアロジックの重複テストを意図的に避ける。各ランタイムテストは `getRuntimeKey()` の正確性、環境変数アクセス、アダプター固有機能のみに集中する。

```typescript
// runtime-tests/deno/hono.test.ts:7-8
// Test just only minimal patterns.
// Because others are tested well in Cloudflare Workers environment already.
```

- **JSX Compiler Matrix Testing**: Deno の JSX テストを `deno.precompile.json` と `deno.react-jsx.json` の 2 設定で同一テストファイルを実行し、JSX コンパイラの出力差分を吸収するテストを記述する。

```typescript
// runtime-tests/deno-jsx/jsx.test.tsx:163-165
// react-jsx : <div>
// precompile : <div > // Extra whitespace is allowed because it is a specification.
assertEquals(nullHtml.toString().replace(/\s+/g, ''), '<div></div>')
```

## Anti-Patterns / 注意点

- **ランタイム固有テストへのコアロジック重複**: ランタイムテストにルーティングやミドルウェアの網羅的テストを書くと、コアテストとの重複メンテナンスが発生する。Hono は「ランタイムテストは最小限」を徹底しているが、この方針が崩れるとテストスイートの保守コストが急増する。

```typescript
// Bad: ランタイムテストでルーティングを網羅的にテスト
Deno.test('Named params', async () => { ... })
Deno.test('Wildcard', async () => { ... })
Deno.test('Optional params', async () => { ... })

// Better: ランタイム固有の動作のみテスト
Deno.test('runtime detection', () => {
  assertEquals(getRuntimeKey(), 'deno')
})
```

- **`*.case.test.*` の直接実行**: 共通テストスイートファイルが Vitest のテスト発見に含まれると、ファクトリ関数が渡されず失敗する。Hono は `vitest.config.ts:35` の exclude パターン `'**/*.case.test.*'` でこれを防いでいるが、この除外設定を忘れると CI が壊れる。

```typescript
// Bad: vitest.config.ts で case.test を除外し忘れる
test: {
  include: ['src/**/*.test.ts'],  // common.case.test.ts が直接実行されてしまう
}

// Better: 明示的に除外する
test: {
  exclude: [...configDefaults.exclude, '**/*.case.test.*'],
}
```

## 導出ルール

- `[MUST]` マルチランタイム対応ライブラリでは、コアロジックのテストをランタイム非依存な層で実行し、ランタイム固有テストはアダプター層の最小限の検証に留める
  - 根拠: Hono は 117 ファイルのコアテストを Vitest/Node.js で実行し、7 ランタイムの固有テストは合計 13 ファイルに抑えている。これにより、ランタイム追加時のテスト工数を最小化している

- `[MUST]` 共通テストスイートを関数としてエクスポートする場合、テスト発見から除外する命名規則（例: `*.case.test.*`）とビルド設定の除外パターンを組み合わせて、直接実行を防止する
  - 根拠: `vitest.config.ts:35` の `exclude: ['**/*.case.test.*']` がなければ、`common.case.test.ts` が引数なしで実行されテストが失敗する

- `[SHOULD]` 同一インターフェースの複数実装をテストする際は、共通テストスイートに理由付き skip リストを渡す Parameterized Test Suite パターンを採用し、各実装の能力差をコードで文書化する
  - 根拠: `src/router/reg-exp-router/router.test.ts:8-24` では skip の理由（`'UnsupportedPath'`）とテスト名を明示し、実装の制約をテストコード自体がドキュメント化している

- `[SHOULD]` Web Standards API（Request/Response）に基づくフレームワークでは、`app.request()` のような HTTP サーバー不要のテストメソッドをフレームワーク本体に組み込み、テスト速度とポータビリティを確保する
  - 根拠: `src/hono-base.ts:482-511` の `request()` メソッドにより、Hono の全コアテストが HTTP サーバー起動なしで実行されている

- `[SHOULD]` JSX のコンパイラ差分をテストする場合、Vitest マルチプロジェクトや Deno の複数設定ファイルで同一テストコードを異なるコンパイラ設定で実行し、出力の正規化（空白除去等）で差分を吸収する
  - 根拠: `runtime-tests/deno-jsx/jsx.test.tsx:163` では `.replace(/\s+/g, '')` で precompile と react-jsx の空白差分を正規化している

- `[AVOID]` ランタイム固有テストでコアロジックを再テストすること。各ランタイムのテストはアダプター層の変換ロジックとランタイム検出のみに集中すべき
  - 根拠: `runtime-tests/deno/hono.test.ts:7-8` のコメントが示すように、コアロジックは別環境で十分にテスト済みであり、ランタイムテストでの重複はメンテナンスコストを増加させるだけである

- `[AVOID]` マルチプロジェクト構成でグローバルモックのセットアップファイルを共有する際、ランタイム固有プロジェクトに不要なモックを適用すること
  - 根拠: `.vitest.config/setup-vitest.ts` は `main` プロジェクトにのみ適用され（`vitest.config.ts:6`）、ランタイムプロジェクトは各自の `vitest.config.ts` で独立した設定を持つ

## 適用チェックリスト

- [ ] テスト対象の抽象化レイヤーを特定し、ランタイム非依存なコアテストとランタイム固有テストを分離しているか
- [ ] 同一インターフェースの複数実装がある場合、共通テストスイートを関数化し skip リストで能力差を管理しているか
- [ ] 共通テストスイートファイルがテストランナーの自動発見から除外されているか（命名規則 + 設定の両方で）
- [ ] フレームワーク本体に `app.request()` 相当のサーバーレステストメソッドが用意されているか
- [ ] JSX やテンプレートエンジンなどコンパイラ依存の機能を、複数の設定で同一テストを実行して検証しているか
- [ ] CI パイプラインで各ランタイムのテストが独立した job として並列実行されているか
- [ ] ランタイム固有テストが「最小限」に保たれているか（コアロジックの重複テストが混入していないか）
- [ ] グローバルモック（`vi.stubGlobal` 等）のスコープが適切に管理され、プロジェクト間で意図しない干渉がないか
