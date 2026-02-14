# project-structure

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono のディレクトリ構成・モジュール分割・エクスポートマップ設計を分析する。359 ソースファイルを持つ大規模 TypeScript ライブラリでありながら、70 以上のサブパスエクスポートによるきめ細かな tree-shaking を実現し、ESM/CJS デュアル出力と JSR 対応を同時に維持している。Web Standards ベースのマルチランタイムフレームワークとして、ランタイム固有コード（adapter）を完全に分離しつつ、コアを最小限に保つ構造設計が注目に値する。

## 設計思想

- **ゼロ不要依存の原則（Pay-only-for-what-you-use）**: `hono` パッケージは 1 つだが、ユーザーが `import { cors } from 'hono/cors'` のように必要な機能だけをサブパスで取得する。コアの `hono` エントリポイント（`src/index.ts`）は `Hono` クラスと基本型のみをエクスポートし、ミドルウェア・ヘルパー・アダプターは一切含まない。これにより、最小構成のアプリでは不要なコードがバンドルに含まれない。

- **抽象コア + 具象プリセットの分離（Template Method 的構成）**: `HonoBase`（`src/hono-base.ts`）はルーターを持たない抽象的なクラスとして設計され（コメント: "This class is like an abstract class and does not have a router"）、具象の `Hono`（`src/hono.ts`）やプリセット（`src/preset/tiny.ts`, `src/preset/quick.ts`）がコンストラクタでルーターを注入する。これにより、ルーター選択という最もパフォーマンスに影響する部分をユーザーの選択に委ねている。

- **ランタイム固有コードの完全隔離**: `src/adapter/` にランタイム固有の実装（`serveStatic`, `upgradeWebSocket`, `getConnInfo` 等）を閉じ込め、コア（`src/hono-base.ts`, `src/context.ts`, `src/compose.ts` 等）は Web Standards API のみに依存する。アダプターは `hono/cloudflare-workers` のようにサブパスで公開され、コアからは一切参照されない。

- **インターフェースによる戦略パターンの徹底**: `Router<T>` インターフェース（`src/router.ts`）は `add()` と `match()` の 2 メソッドのみを定義し、5 種のルーター実装がこれに準拠する。SmartRouter は初回マッチ時にルーターを自動選択し、以降は `match` メソッドを直接バインドして委譲オーバーヘッドを排除する（`src/router/smart-router/router.ts:46`）。

## 設計・実装の詳細

### ディレクトリ階層とモジュール分類

```
src/
├── index.ts              # メインエントリ（Hono + 基本型のみ）
├── hono.ts               # デフォルトプリセット（SmartRouter = RegExp + Trie）
├── hono-base.ts          # 抽象コア（ルーターなし）
├── context.ts            # リクエスト/レスポンスコンテキスト
├── compose.ts            # ミドルウェア合成（koa-compose 派生）
├── request.ts            # HonoRequest ラッパー
├── router.ts             # Router<T> インターフェース定義
├── http-exception.ts     # HTTP 例外クラス
├── types.ts              # 型定義の集約
├── router/               # ルーター実装群（Strategy Pattern）
│   ├── reg-exp-router/   # 正規表現ベース（高速・制約あり）
│   ├── trie-router/      # Trie ベース（汎用・フォールバック）
│   ├── smart-router/     # 自動選択プロキシ
│   ├── pattern-router/   # 軽量正規表現（tiny プリセット用）
│   └── linear-router/    # 線形走査（quick プリセット用）
├── preset/               # ルーター組み合わせのプリセット
│   ├── tiny.ts           # PatternRouter のみ
│   └── quick.ts          # SmartRouter(Linear + Trie)
├── adapter/              # ランタイム固有アダプター（9 種）
│   ├── cloudflare-workers/
│   ├── bun/
│   ├── deno/
│   ├── aws-lambda/
│   ├── vercel/
│   └── ...
├── middleware/            # ビルトインミドルウェア（25 種）
│   ├── cors/
│   ├── jwt/
│   ├── serve-static/
│   └── ...
├── helper/               # ヘルパーモジュール（14 種）
│   ├── factory/          # createFactory / createMiddleware
│   ├── testing/          # testClient
│   ├── adapter/          # ランタイム検出ユーティリティ
│   └── ...
├── jsx/                  # JSX エンジン（server + dom）
│   ├── dom/              # クライアントサイド JSX
│   └── ...
├── client/               # RPC クライアント（hc）
├── validator/            # バリデーション基盤
└── utils/                # 低レベルユーティリティ
```

モジュール分類は **コア / ルーター / アダプター / ミドルウェア / ヘルパー / JSX / クライアント / バリデーター / ユーティリティ** の 9 層構造。依存方向は `ユーティリティ <- コア <- ミドルウェア/ヘルパー/アダプター` の一方向で、ミドルウェアとアダプター間の依存はない。

### サブパスエクスポートの設計

package.json の `exports` フィールドで 70 以上のサブパスを定義し、各エントリに `types` / `import` / `require` の 3 条件分岐を記述している。

```jsonc
// package.json:38-43 (抜粋)
".": {
  "types": "./dist/types/index.d.ts",
  "import": "./dist/index.js",
  "require": "./dist/cjs/index.js"
},
```

注目すべき設計判断:

1. **フラットなサブパス名**: `hono/cors`, `hono/jwt` のように内部ディレクトリ構造を隠蔽。ユーザーは `hono/middleware/cors` ではなく `hono/cors` でインポートする。ミドルウェアとヘルパーの区別はユーザーに見えない。

2. **ルーターは階層を維持**: `hono/router/reg-exp-router` のように `router/` プレフィックスを付与。ルーターの使い分けは上級者向けの意図的な選択であるため、ディスカバビリティよりも分類の明確性を優先している。

3. **utils はワイルドカードエクスポート**: `"./utils/*"` パターンで全ユーティリティを公開。内部実装の詳細だが、外部ライブラリ（`@hono/*` パッケージ群）からの利用を想定している。

4. **JSX は階層的サブパス**: `hono/jsx`, `hono/jsx/dom`, `hono/jsx/dom/client`, `hono/jsx/dom/css` のようにネストした構造を反映。JSX のサーバー/クライアント/ランタイム区分はユーザーが明示的に選択する必要があるため。

### ESM/CJS デュアル出力とビルドパイプライン

ビルドは `build/build.ts` で esbuild を使い、ESM と CJS を並列ビルドする。

```typescript
// build/build.ts:75-89
const cjsConfig: BuildOptions = {
  ...commonOptions,
  outbase: './src',
  outdir: './dist/cjs',
  format: 'cjs',
}

const esmConfig: BuildOptions = {
  ...commonOptions,
  bundle: true,
  outbase: './src',
  outdir: './dist',
  format: 'esm',
  plugins: [addExtension('.js')],
}
```

CJS 対応の仕組みは `package.cjs.json`（`{ "type": "commonjs" }` のみ）を `dist/cjs/package.json` にコピーすることで実現する。ESM がデフォルト（ルートの `"type": "module"`）で、CJS サブディレクトリだけを CommonJS として扱わせるパターン。

型定義は esbuild ではなく `tsc --emitDeclarationOnly` で別途生成し、`dist/types/` に出力する。ビルド後に `removePrivateFields` でプライベートフィールドの `#` 宣言を .d.ts から除去する後処理が入る（`build/remove-private-fields.ts`）。

### JSR / package.json エクスポートの同期バリデーション

ビルド時に `validateExports()` で package.json と jsr.json のエクスポートキーの一致を検証する（`build/validate-exports.ts`）。どちらか一方にしか存在しないエクスポートがあればビルドが失敗する。これにより npm と JSR の公開内容の乖離を防止している。

```typescript
// build/build.ts:29-32
const [packageJsonExports, jsrJsonExports] = ['./package.json', './jsr.json'].map(readJsonExports)
validateExports(packageJsonExports, jsrJsonExports, 'jsr.json')
validateExports(jsrJsonExports, packageJsonExports, 'package.json')
```

### テストの配置戦略

テストファイルはソースと同階層に co-locate される（例: `src/middleware/cors/index.ts` と `src/middleware/cors/index.test.ts`）。ビルド時に `glob.sync('./src/**/*.ts', { ignore: ['./src/**/*.test.ts', ...] })` で除外し、tsconfig.build.json でも `"src/**/*.test.ts"` を exclude している。

ルーターのテストは特殊で、`src/router/common.case.test.ts` に共通テストケースを定義し、各ルーター実装のテストファイルがこれを呼び出す。Router インターフェースの契約テスト（Contract Testing）パターン。

### マルチランタイムテスト

`runtime-tests/` ディレクトリに各ランタイム固有のテストを分離。Vitest のマルチプロジェクト構成（`--project node`, `--project workerd` 等）で実行環境を切り替える。Deno と Bun はそれぞれのネイティブテストランナーで実行。

## コード例

### コアエントリポイントの最小エクスポート

```typescript
// src/index.ts:17-52
import { Hono } from './hono'

export type {
  Env, ErrorHandler, Handler, MiddlewareHandler, Next,
  NotFoundResponse, NotFoundHandler, ValidationTargets,
  Input, Schema, ToSchema, TypedResponse,
} from './types'
export type { Context, ContextVariableMap, ContextRenderer, ExecutionContext } from './context'
export type { HonoRequest } from './request'
export type { InferRequestType, InferResponseType, ClientRequestOptions } from './client'

export { Hono }
```

値としてのエクスポートは `Hono` クラスのみ。それ以外は全て `export type` であり、ランタイムフットプリントを最小化している。

### プリセットによるルーター注入

```typescript
// src/hono.ts:16-34
export class Hono<E extends Env = BlankEnv, S extends Schema = BlankSchema, BasePath extends string = '/'>
  extends HonoBase<E, S, BasePath> {
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

```typescript
// src/preset/tiny.ts:12-20
export class Hono<E extends Env = BlankEnv, S extends Schema = BlankSchema, BasePath extends string = '/'>
  extends HonoBase<E, S, BasePath> {
  constructor(options: HonoOptions<E> = {}) {
    super(options)
    this.router = new PatternRouter()
  }
}
```

デフォルトの `Hono` と `hono/tiny` の `Hono` は同じ `HonoBase` を継承し、ルーターだけが異なる。ユーザーはインポートパスの変更だけでルーター戦略を切り替えられる。

### SmartRouter の遅延バインディング

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
    this.#routes = undefined  // ルート情報を解放
    break
  }
  // ...
}
```

初回 `match()` 呼び出し時にルーターを試行し、成功したルーターの `match` メソッドで自身の `match` を上書きする。2 回目以降は SmartRouter を経由せず直接選ばれたルーターが呼ばれる。

### アダプターの統一エクスポートパターン

```typescript
// src/adapter/cloudflare-workers/index.ts:1-9
export { serveStatic } from './serve-static-module'
export { upgradeWebSocket } from './websocket'
export { getConnInfo } from './conninfo'

// src/adapter/bun/index.ts:1-11
export { serveStatic } from './serve-static'
export { bunFileSystemModule, toSSG } from './ssg'
export { createBunWebSocket, upgradeWebSocket, websocket } from './websocket'
export type { BunWebSocketData, BunWebSocketHandler } from './websocket'
export { getConnInfo } from './conninfo'
export { getBunServer } from './server'
```

各アダプターは `serveStatic`, `upgradeWebSocket`, `getConnInfo` など共通機能名をエクスポートするが、内部実装はランタイム固有。ユーザーコードはインポートパスの切り替えだけで対応ランタイムを変更できる。

## パターンカタログ

- **Strategy Pattern** (分類: 振る舞い)
  - 解決する問題: 複数のルーティングアルゴリズムをユーザーが選択可能にする
  - 適用条件: 同一インターフェースの複数実装が存在し、実行時に切り替える必要がある場合
  - コード例: `src/router.ts:29-52` (Router インターフェース), `src/router/*/router.ts` (各実装)
  - 注意点: SmartRouter がファーストマッチ後にメソッド置換するのは、Strategy の変形であり Proxy + Strategy のハイブリッド

- **Template Method Pattern** (分類: 振る舞い)
  - 解決する問題: コア処理フローを固定しつつ、ルーター初期化を可変にする
  - 適用条件: 共通ロジック（リクエスト処理、ミドルウェア合成）があり、一部のステップだけ差し替えたい場合
  - コード例: `src/hono-base.ts:98-118` (HonoBase), `src/hono.ts:16-34` / `src/preset/tiny.ts:12-20` (具象クラス)
  - 注意点: TypeScript では abstract class ではなく「ルーターを持たないクラス」として実現。コメントで意図を明示（`src/hono-base.ts:114-117`）

- **Facade Pattern** (分類: 構造)
  - 解決する問題: 各アダプターの複数ファイルを 1 つのサブパスで公開する
  - 適用条件: 内部モジュールの複雑さをユーザーから隠蔽し、統一的なインポートパスを提供したい場合
  - コード例: `src/adapter/cloudflare-workers/index.ts`, `src/adapter/bun/index.ts`
  - 注意点: Barrel ファイル（index.ts による re-export）が Facade として機能

## Good Patterns

- **フラットなサブパスによる DX 最適化**: `hono/cors` のようにディレクトリ階層を隠蔽し、ユーザーが `middleware` か `helper` かを意識しなくてよい設計。内部の分類変更がユーザーの import 文に影響しない。

```typescript
// ユーザーコード: 内部構造を意識しない
import { cors } from 'hono/cors'           // 実体: src/middleware/cors/index.ts
import { cookie } from 'hono/cookie'       // 実体: src/helper/cookie/index.ts
import { testClient } from 'hono/testing'  // 実体: src/helper/testing/index.ts
```

- **エクスポートマップの自動バリデーション**: ビルド時に package.json と jsr.json のエクスポートキーを双方向で検証し、不整合を即座に検出。レジストリが増えても漏れが発生しない。

```typescript
// build/build.ts:31-32
validateExports(packageJsonExports, jsrJsonExports, 'jsr.json')
validateExports(jsrJsonExports, packageJsonExports, 'package.json')
```

- **プライベートフィールドの .d.ts 後処理**: TypeScript の `#private` フィールドが .d.ts に漏出する問題を、AST ベースの後処理（oxc-parser 使用）で除去。型定義の clean さを維持。

```typescript
// build/remove-private-fields.ts:5-25
export async function removePrivateFields(files: string[]) {
  const parsed = await Promise.all(
    files.map(async (file) => {
      const sourceCode = await readFile(file, 'utf-8')
      const ast = parseSync(file, sourceCode)
      return { file, sourceCode, ast }
    })
  )
  // ...
}
```

- **ルーター共通テストケースによる契約テスト**: `src/router/common.case.test.ts` に全ルーターが満たすべき振る舞いを定義し、各ルーターのテストからパラメータ化して呼び出す。新しいルーター実装を追加した際に、同一のテストスイートで互換性を自動検証できる。

## Anti-Patterns / 注意点

- **types.ts の肥大化**: `src/types.ts` が 2,489 行に達しており、型定義の巨大ファイル化が進んでいる。型推論の複雑さ（ハンドラーチェインの型安全性）に起因するため単純な分割は困難だが、ファイルサイズが IDE のパフォーマンスに影響する可能性がある。

```
// Bad: 1ファイルに 2,489 行の型定義
src/types.ts (2,489 lines)

// Better: 関心ごとに分割（ただし Hono の場合は型の相互依存が深く、トレードオフがある）
src/types/handler.ts
src/types/schema.ts
src/types/env.ts
```

- **Barrel ファイルの多層化リスク**: 各サブモジュールの `index.ts` は re-export のみで構成される Barrel ファイルだが、70 以上のサブパスエクスポートとの組み合わせでビルド設定の複雑性が増す。新しいモジュール追加時に package.json exports / jsr.json exports / typesVersions の 3 箇所を同期する必要がある（validateExports で検出はできるが、手動更新のコストは残る）。

```jsonc
// 新しいミドルウェア追加時に更新が必要な箇所:
// 1. package.json "exports"
// 2. package.json "typesVersions"
// 3. jsr.json "exports"
// 4. src/middleware/<name>/index.ts (実装)
```

## 導出ルール

- `[MUST]` マルチレジストリ対応のライブラリでは、エクスポートマップの同期をビルド時に自動バリデーションする
  - 根拠: Hono は `build/validate-exports.ts` で package.json と jsr.json の双方向検証を実施し、エクスポートの不整合を CI で検出している

- `[MUST]` ランタイム固有コードはサブパスエクスポートで隔離し、コアモジュールから参照しない
  - 根拠: Hono の `src/adapter/` は `src/hono-base.ts` や `src/context.ts` から一切 import されず、ユーザーが `hono/cloudflare-workers` 等で明示的にオプトインする設計

- `[SHOULD]` サブパスエクスポートのパス名は内部ディレクトリ構造を隠蔽し、ユーザー視点の機能名で公開する
  - 根拠: Hono は `hono/cors`（内部: `src/middleware/cors/`）のようにフラット化し、内部の `middleware/` vs `helper/` の分類をユーザーに露出させていない

- `[SHOULD]` 同一インターフェースの複数実装がある場合、共通テストケースを抽出して契約テストとして各実装に適用する
  - 根拠: `src/router/common.case.test.ts` が 5 種のルーター実装全てに対して同一のテストスイートを適用し、インターフェース互換性を保証している

- `[SHOULD]` ESM/CJS デュアル出力では、CJS サブディレクトリに `{ "type": "commonjs" }` の package.json を配置するパターンを使う
  - 根拠: Hono は `package.cjs.json` を `dist/cjs/package.json` にコピーし、ルートの `"type": "module"` と共存させている

- `[AVOID]` コアのエントリポイントからオプショナルな機能（ミドルウェア、ヘルパー等）を直接エクスポートすること
  - 根拠: `src/index.ts` は `Hono` クラスと型のみをエクスポートし、25 のミドルウェアや 14 のヘルパーは全てサブパス経由。これにより最小バンドルサイズを保証している

- `[AVOID]` プリセットやバリアント間でロジックを複製すること。共通基盤を抽象クラスとして抽出し、差分だけをサブクラスで定義する
  - 根拠: `HonoBase`（539 行）にコア処理を集約し、`Hono`（34 行）/ `preset/tiny`（20 行）/ `preset/quick`（24 行）はコンストラクタでルーターを注入するだけ

## 適用チェックリスト

- [ ] ライブラリのメインエントリポイントが最小限のエクスポートのみ含んでいるか確認する
- [ ] オプショナルな機能（ミドルウェア、プラグイン等）はサブパスエクスポートで分離されているか確認する
- [ ] package.json の `exports` フィールドに `types` / `import` / `require` の条件分岐が正しく定義されているか確認する
- [ ] 複数レジストリ（npm, JSR 等）に公開する場合、エクスポートマップの同期バリデーションがビルドに組み込まれているか確認する
- [ ] ランタイム固有のコードがコアから分離され、サブパスで隔離されているか確認する
- [ ] 同一インターフェースの複数実装がある場合、共通テストスイート（契約テスト）が存在するか確認する
- [ ] ESM/CJS デュアル出力の場合、CJS 側に `{ "type": "commonjs" }` の package.json が配置されているか確認する
- [ ] 型定義ファイル（.d.ts）にプライベートフィールドが漏出していないか確認する
- [ ] サブパスエクスポートのパス名がユーザー視点で直感的か（内部構造の詳細を露出していないか）レビューする
