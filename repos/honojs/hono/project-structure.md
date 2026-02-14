# Project Structure

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono は Web Standards ベースのマルチランタイム対応 Web フレームワークであり、そのプロジェクト構造は「コアを小さく保ちながら 60 以上のエントリーポイントを提供する」という設計思想を体現している。`HonoBase` 抽象クラスを軸に、Router/Adapter/Middleware/Helper/Preset を独立したサブモジュールとして配置し、package.json の `exports` フィールドでツリーシェイキング可能なサブパスを公開する構成は、大規模ライブラリのモジュール設計として参考になる。

## 設計・実装の詳細

### ルートディレクトリ構成

```
honojs/hono/
├── src/                    # ソースコード（全て TypeScript）
├── build/                  # esbuild カスタムビルドスクリプト
├── runtime-tests/          # ランタイム別テスト（bun, deno, workerd, node 等）
├── benchmarks/             # パフォーマンスベンチマーク
├── perf-measures/          # パフォーマンス計測
├── docs/                   # ドキュメント
├── .vitest.config/         # Vitest セットアップ
├── package.json            # npm 用設定（60+ exports）
├── jsr.json                # JSR (Deno) 用設定
├── tsconfig.json           # 開発用 TypeScript 設定
├── tsconfig.build.json     # ビルド用 TypeScript 設定（テスト除外）
└── vitest.config.ts        # マルチプロジェクト Vitest 設定
```

特筆すべきは `package.json` と `jsr.json` の 2 系統のパッケージ定義を持ち、ビルド時に `validateExports()` で両者の exports を相互検証している点である。

### src/ 配下のレイヤー構造

```
src/
├── index.ts              # 公開 API のエントリーポイント
├── hono.ts               # Hono クラス（HonoBase + デフォルト Router）
├── hono-base.ts          # HonoBase 抽象クラス（フレームワークコア）
├── context.ts            # Context クラス（リクエスト/レスポンスの抽象化）
├── compose.ts            # ミドルウェア合成（koa-compose ベース）
├── router.ts             # Router インターフェース定義
├── request.ts            # HonoRequest クラス
├── http-exception.ts     # HTTPException クラス
├── types.ts              # 型定義（79KB、型推論の中核）
│
├── router/               # ルーター実装群（Strategy パターン）
│   ├── reg-exp-router/   # 正規表現ベース（高速）
│   ├── trie-router/      # Trie ベース（汎用）
│   ├── smart-router/     # 自動選択ルーター
│   ├── pattern-router/   # パターンマッチ（最小サイズ）
│   ├── linear-router/    # 線形探索（登録高速）
│   └── common.case.test.ts  # 全ルーター共通テスト
│
├── adapter/              # ランタイム固有の実装
│   ├── aws-lambda/       # handler, types
│   ├── bun/              # serve-static, websocket, ssg, conninfo
│   ├── cloudflare-workers/
│   ├── cloudflare-pages/
│   ├── deno/
│   ├── lambda-edge/
│   ├── netlify/
│   ├── service-worker/
│   └── vercel/
│
├── middleware/            # ビルトインミドルウェア（25個）
│   ├── cors/             # index.ts + index.test.ts
│   ├── jwt/
│   ├── logger/
│   └── ...
│
├── helper/               # ヘルパーユーティリティ（14個）
│   ├── factory/          # createFactory, createMiddleware
│   ├── testing/          # テスト用ヘルパー
│   ├── streaming/
│   └── ...
│
├── preset/               # プリセット（Router の組み合わせ）
│   ├── tiny.ts           # PatternRouter のみ
│   └── quick.ts          # SmartRouter(LinearRouter + TrieRouter)
│
├── client/               # RPC クライアント（hc）
├── jsx/                  # JSX エンジン（サーバー/DOM）
├── validator/            # バリデーション基盤
└── utils/                # 内部ユーティリティ（20+ ファイル）
```

### コア設計: HonoBase の継承パターン

`HonoBase` はルーターを持たない抽象クラスとして設計され、具象クラス（`Hono`、プリセット）がコンストラクタでルーターを注入する。これにより、ルーター選択をユーザーに委ねつつ、デフォルトでは最適な組み合わせを提供する。

```typescript
// src/hono-base.ts:98-103
class Hono<
  E extends Env = Env,
  S extends Schema = {},
  BasePath extends string = '/',
  CurrentPath extends string = BasePath,
> {
  /*
    This class is like an abstract class and does not have a router.
    To use it, inherit the class and implement router in the constructor.
  */
  router!: Router<[H, RouterRoute]>
```

```typescript
// src/hono.ts:16-34
export class Hono<...> extends HonoBase<E, S, BasePath> {
  constructor(options: HonoOptions<E> = {}) {
    super(options)
    this.router =
      options.router ??
      new SmartRouter({
        routers: [new RegExpRouter(), new TrieRouter()],
      })
  }
}
```

### SmartRouter: 遅延決定による最適化

SmartRouter は初回の `match()` 呼び出し時にルーターを自動選択し、以降は選ばれたルーターに `match` メソッドを委譲する。`this.match = router.match.bind(router)` による動的メソッド置換が特徴的である。

```typescript
// src/router/smart-router/router.ts:21-49
match(method: string, path: string): Result<T> {
    // ...
    for (; i < len; i++) {
      const router = routers[i]
      try {
        for (let i = 0, len = routes.length; i < len; i++) {
          router.add(...routes[i])
        }
        res = router.match(method, path)
      } catch (e) {
        if (e instanceof UnsupportedPathError) {
          continue
        }
        throw e
      }
      this.match = router.match.bind(router)  // メソッド置換
      this.#routers = [router]
      this.#routes = undefined  // ルート配列を GC 対象にする
      break
    }
```

### デュアルビルド戦略

esbuild で ESM/CJS の 2 形式を同時ビルドし、`tsc` で型定義のみ出力する。ビルド後に `removePrivateFields` で `.d.ts` から `#private` フィールドを除去するポストプロセスが組み込まれている。

```typescript
// build/build.ts:100-110
await Promise.all([
  runBuild(esmConfig),         // ESM → dist/
  runBuild(cjsConfig),         // CJS → dist/cjs/
  $`tsc ... --emitDeclarationOnly --declaration --project tsconfig.build.json`.nothrow(),
])

// .d.ts から #private フィールドを除去
const dtsEntries = glob.globSync('./dist/types/**/*.d.ts')
await removePrivateFields(dtsEntries)
```

### exports マップとパッケージ境界

package.json の `exports` フィールドで 60 以上のサブパスインポートを定義し、各エントリーに `types`/`import`/`require` の 3 条件を設定している。さらに `typesVersions` で古い TypeScript との互換性も確保している。

```json
// package.json:38-42
".": {
  "types": "./dist/types/index.d.ts",
  "import": "./dist/index.js",
  "require": "./dist/cjs/index.js"
}
```

`jsr.json` は同じ exports をソース TypeScript に直接マッピングし、ビルド時に `validateExports()` で package.json と jsr.json の exports の整合性を検証する。

```typescript
// build/validate-exports.ts:1-5
export const validateExports = (
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  fileName: string
) => {
```

### テスト構成: コロケーション + ランタイム別テスト

テストファイルはソースコードと同じディレクトリにコロケーションされている。`hono.test.ts`(107KB) のような大規模テストがルートに、ミドルウェアやアダプターの個別テストが各サブディレクトリに配置される。

```
src/compose.test.ts           # コアのテスト
src/hono.test.ts              # メインの結合テスト
src/middleware/cors/index.test.ts  # ミドルウェア個別テスト
src/adapter/aws-lambda/handler.test.ts  # アダプターテスト
runtime-tests/bun/            # Bun 固有のランタイムテスト
runtime-tests/deno/           # Deno 固有のランタイムテスト
runtime-tests/workerd/        # Cloudflare Workers ランタイムテスト
```

Vitest のマルチプロジェクト設定で、メインテスト・JSX ランタイムテスト・ランタイム別テストを分離している。

```typescript
// vitest.config.ts:26-27
projects: [
  './runtime-tests/*/vitest.config.ts',  // 各ランタイムの設定
  { ... name: 'main' },                  // メインテスト
  { ... name: 'jsx-runtime-default' },   // JSX テスト
  { ... name: 'jsx-runtime-dom' },       // JSX DOM テスト
],
```

### Middleware / Helper / Adapter の統一的なモジュール構造

3 つのサブモジュールカテゴリが一貫した構造を持つ。各機能は独立したディレクトリに `index.ts`（公開 API の re-export）と実装ファイルを配置する。

```
src/middleware/cors/
├── index.ts          # export { cors } from './cors' 的な re-export
└── index.test.ts     # テスト

src/adapter/aws-lambda/
├── index.ts          # 公開 API の re-export
├── handler.ts        # 実装
├── handler.test.ts   # テスト
└── types.ts          # 型定義
```

## コード例

### Preset パターンによるバンドルサイズ制御

```typescript
// src/preset/tiny.ts:11-20
export class Hono<
  E extends Env = BlankEnv,
  S extends Schema = BlankSchema,
  BasePath extends string = '/',
> extends HonoBase<E, S, BasePath> {
  constructor(options: HonoOptions<E> = {}) {
    super(options)
    this.router = new PatternRouter()  // 最小サイズのルーター
  }
}
```

ユーザーは `import { Hono } from 'hono/tiny'` のように preset を選ぶことで、不要なルーター実装をバンドルから除外できる。

### ミドルウェアの実装パターン

```typescript
// src/middleware/logger/index.ts:81-95
export const logger = (fn: PrintFunc = console.log): MiddlewareHandler => {
  return async function logger(c, next) {
    const { method, url } = c.req
    const path = url.slice(url.indexOf('/', 8))
    await log(fn, LogPrefix.Incoming, method, path)
    const start = Date.now()
    await next()
    await log(fn, LogPrefix.Outgoing, method, path, c.res.status, time(start))
  }
}
```

ファクトリ関数がオプションを受け取り、`MiddlewareHandler` を返す。`await next()` の前後でリクエスト/レスポンスの処理を分離する Koa スタイルの onion model。

### ディスパッチの最適化: 単一ハンドラの高速パス

```typescript
// src/hono-base.ts:424-442
// Do not `compose` if it has only one handler
if (matchResult[0].length === 1) {
  let res: ReturnType<H>
  try {
    res = matchResult[0][0][0][0](c, async () => {
      c.res = await this.#notFoundHandler(c)
    })
  } catch (err) {
    return this.#handleError(err, c)
  }

  return res instanceof Promise
    ? res
        .then(
          (resolved: Response | undefined) =>
            resolved || (c.finalized ? c.res : this.#notFoundHandler(c))
        )
        .catch((err: Error) => this.#handleError(err, c))
    : (res ?? this.#notFoundHandler(c))
}
```

ミドルウェアが 1 つだけの場合は `compose()` を呼ばずに直接実行する。Promise のオーバーヘッドも、同期的に返せる場合は回避している。

## Good Patterns

- **Router Interface による Strategy パターン**: `Router<T>` インターフェース（`add` + `match`）を定義し、5 つの異なるルーター実装を交換可能にしている。`SmartRouter` が初回リクエスト時に最適なルーターを自動選択する仕組みにより、ユーザーはルーター選択を意識せずとも高いパフォーマンスを得られる。

```typescript
// src/router.ts:29-52
export interface Router<T> {
  name: string
  add(method: string, path: string, handler: T): void
  match(method: string, path: string): Result<T>
}
```

- **exports マップによるサブパスインポート**: `hono/cors`, `hono/jwt`, `hono/bun` のようにサブパスを公開することで、ツリーシェイキングが効かない環境でも必要な機能だけを import できる。60 以上のエントリーポイントを `types`/`import`/`require` の条件付きで定義し、ESM/CJS の両方をサポートしている。

```json
"./cors": {
  "types": "./dist/types/middleware/cors/index.d.ts",
  "import": "./dist/middleware/cors/index.js",
  "require": "./dist/cjs/middleware/cors/index.js"
}
```

- **デュアルパッケージレジストリの整合性検証**: `validateExports()` でビルド時に package.json と jsr.json の exports を相互チェックし、片方にしかないエントリーを検出する。npm と JSR の 2 レジストリで公開するライブラリにおいて、exports の不整合を防止する実用的な仕組み。

```typescript
// build/build.ts:30-31
validateExports(packageJsonExports, jsrJsonExports, 'jsr.json')
validateExports(jsrJsonExports, packageJsonExports, 'package.json')
```

- **テストのコロケーション + 共通テストケース**: ソースファイルと同一ディレクトリにテストを配置しつつ、全ルーター実装の動作保証には `router/common.case.test.ts` を共有テストスイートとして使用している。実装固有のテストと横断テストの両方を効率よく管理している。

## Anti-Patterns / 注意点

- **巨大な型定義ファイル**: `src/types.ts` は 79KB（約 2,000 行）に達しており、ハンドラーオーバーロードの列挙的な型定義が大部分を占める。型推論のパフォーマンスに影響する可能性があり、IDE の補完が遅くなるケースが報告されている。

```typescript
// Bad: 1 ファイルに全ハンドラー型を列挙
// src/types.ts (79KB, ~2000 行)
export interface HandlerInterface<...> {
  // get(path, handler) のオーバーロードが数十個
}
```

```typescript
// Better: 型をカテゴリごとに分割
// src/types/handler.ts
// src/types/middleware.ts
// src/types/schema.ts
```

ただし、Hono の場合は型推論の精度を最大化するためにあえて 1 ファイルに集約している可能性がある。`types.test.ts`（112KB）が型テストとして機能しており、型の正しさは担保されている。

- **テストファイルサイズの肥大化**: `src/hono.test.ts` は 107KB に達しており、テストの見通しが悪くなっている。機能カテゴリごとにファイルを分割する方がメンテナンス性は向上する。

```
// Bad: 1 ファイルに全テスト
src/hono.test.ts (107KB)

// Better: 機能ごとに分割
src/__tests__/routing.test.ts
src/__tests__/middleware.test.ts
src/__tests__/error-handling.test.ts
```

## 自分のプロジェクトへの適用

- [ ] package.json `exports` でサブパスインポートを定義し、モジュール境界を明確にする
- [ ] 複数のレジストリ（npm + JSR）に公開する場合、ビルド時に exports の整合性を検証するスクリプトを導入する
- [ ] コア機能を抽象クラス（or インターフェース）として設計し、戦略の交換を可能にする（Router パターン参考）
- [ ] ESM/CJS デュアルビルドを esbuild + tsc（型のみ）の構成で実現する
- [ ] テストファイルはソースとコロケーションしつつ、共通テストケースで横断的な動作保証を行う
- [ ] `tsconfig.build.json` でテストファイルを除外し、ビルド成果物をクリーンに保つ
