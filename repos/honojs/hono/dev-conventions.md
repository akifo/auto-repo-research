# dev-conventions

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono の開発規約を分析する。Web Standards 準拠のフレームワークとして多ランタイム（Deno, Bun, workerd, Node.js, Fastly, Lambda）をサポートするため、コードスタイル・ビルド・テスト・リント設定に独自の工夫が多い。CONTRIBUTING.md が存在しないにもかかわらず、一貫したコーディング規約がコードベース全体で維持されており、設定ファイルから規約を読み解く価値が高い。

## 設計・実装の詳細

### コードスタイル: Prettier + EditorConfig + editorconfig-checker

フォーマットは Prettier で統一され、EditorConfig と editorconfig-checker による多層的な整合性チェックが CI で実行される。

Prettier の特徴的な設定:
- **セミコロンなし** (`semi: false`)
- **シングルクォート** (`singleQuote: true`, JSX でも `jsxSingleQuote: true`)
- **行幅 100** (`printWidth: 100`)
- **ES5 trailing comma** (`trailingComma: "es5"`)
- **LF 改行** (`endOfLine: "lf"`)

EditorConfig では `.lockb` や `.pxm` などバイナリファイルの文字エンコーディング設定を明示的に除外している点が実務的。

### ESLint: 型チェック系ルールの全面 OFF

`@hono/eslint-config` をベースに、**型情報を必要とする TypeScript ルールをほぼ全て無効化**している。これは大規模な型定義（100+ のジェネリクスを持つ HandlerInterface 等）を扱うプロジェクトにおいて、ESLint の型チェック系ルールが実行時間を著しく増大させるためのトレードオフ。

```typescript
// eslint.config.mjs:4-67
const typeCheckedRules = {
  '@typescript-eslint/await-thenable': 'off',
  '@typescript-eslint/no-floating-promises': 'off',
  '@typescript-eslint/no-unsafe-assignment': 'off',
  '@typescript-eslint/no-unsafe-call': 'off',
  '@typescript-eslint/no-unsafe-return': 'off',
  '@typescript-eslint/strict-boolean-expressions': 'off',
  // ... 40+ rules OFF
}
```

一方で `@typescript-eslint/no-explicit-any` は OFF にせず、必要箇所で `eslint-disable` コメントを使い局所的に許可する方針。これにより `any` の使用箇所が明示的にコードレビューの対象になる。

### TypeScript: strict モードと段階的な厳密さ

`tsconfig.json`（開発用）と `tsconfig.build.json`（ビルド用）で厳密さを段階的に制御している:

| 設定 | tsconfig.json | tsconfig.build.json |
|------|:---:|:---:|
| strict | true | true (inherited) |
| noUnusedLocals | false | **true** |
| noUnusedParameters | false | **true** |

開発中はテスト用の変数宣言などで未使用変数を許容し、ビルド時に厳密チェックを適用するという戦略。テスト・型テスト用のファイルはビルド対象から除外されている。

### ミドルウェアの命名付き関数式パターン

全てのミドルウェアは **ファクトリ関数が名前付き関数式を返す** パターンで統一されている。これによりスタックトレースでミドルウェア名が表示され、デバッグが容易になる。

```typescript
// src/middleware/powered-by/index.ts:30-34
export const poweredBy = (options?: PoweredByOptions): MiddlewareHandler => {
  return async function poweredBy(c, next) {
    await next()
    c.res.headers.set('X-Powered-By', options?.serverName ?? 'Hono')
  }
}
```

全 20+ のビルトインミドルウェアがこのパターンに従っており、外側の `const` 名と内側の `function` 名が一致する規約。

### JSDoc: `@module` + `@see` + `@example` の三層構造

公開 API の JSDoc は以下の構造で統一:
1. **`@module`**: ファイル先頭にモジュール説明
2. **`@see`**: ドキュメントサイトへのリンク (`https://hono.dev/docs/...`)
3. **`@example`**: 実行可能なコード例

```typescript
// src/middleware/cors/index.ts:1-4
/**
 * @module
 * CORS Middleware for Hono.
 */
```

```typescript
// src/hono-base.ts:190-207
/**
 * `.route()` allows grouping other Hono instance in routes.
 *
 * @see {@link https://hono.dev/docs/api/routing#grouping}
 *
 * @param {string} path - base Path
 * @param {Hono} app - other Hono instance
 * @returns {Hono} routed Hono instance
 *
 * @example
 * ```ts
 * const app = new Hono()
 * const app2 = new Hono()
 *
 * app2.get("/user", (c) => c.text("user"))
 * app.route("/api", app2) // GET /api/user
 * ```
 */
```

### プライベートフィールド: ES Private Fields (`#`) の積極採用

Context クラスでは JavaScript の ES Private Fields (`#`) を積極的に採用:

```typescript
// src/context.ts:290-334
export class Context<E extends Env = any, P extends string = any, I extends Input = {}> {
  #rawRequest: Request
  #req: HonoRequest<P, I['out']> | undefined
  #var: Map<unknown, unknown> | undefined
  #status: StatusCode | undefined
  #executionCtx: FetchEventLike | ExecutionContext | undefined
  #res: Response | undefined
  // ...
}
```

ただし一部のフィールドはランタイム可視性が必要なため `private` キーワードを使い分けている:

```typescript
// src/hono-base.ts:120-121
// Cannot use `#` because it requires visibility at JavaScript runtime.
private _basePath: string = '/'
```

このコメントで使い分けの理由を明示しているのが特徴的。

### ディレクトリ構成と exports マッピング

`src/` 内の配置が `package.json` の `exports` フィールドに直接マッピングされる設計:

| src パス | import パス |
|----------|------------|
| `src/middleware/cors/index.ts` | `hono/cors` |
| `src/helper/cookie/index.ts` | `hono/cookie` |
| `src/adapter/cloudflare-workers/index.ts` | `hono/cloudflare-workers` |
| `src/router/reg-exp-router/index.ts` | `hono/router/reg-exp-router` |

ミドルウェア・ヘルパー・アダプターは各機能が独立したディレクトリに `index.ts`（本体）+ `index.test.ts`（テスト）の対で配置される。utils はフラットファイル構成（`src/utils/url.ts` + `src/utils/url.test.ts`）。

### Dual CJS/ESM ビルド

`package.json` の `type: "module"` で ESM がデフォルトだが、CJS も並行してビルドされる。`dist/cjs/` ディレクトリに `package.json` (`{"type": "commonjs"}`) を配置することで、Node.js の CJS 解決を正しく動作させている。

```json
// package.json exports (抜粋)
".": {
  "types": "./dist/types/index.d.ts",
  "import": "./dist/index.js",
  "require": "./dist/cjs/index.js"
}
```

### テスト規約

- **Vitest** を `globals: true` で使用（`describe`, `it`, `expect` のインポート不要）
- テストファイルは `*.test.ts` / `*.test.tsx` 命名
- テスト内で `app.request()` メソッドを使い、サーバー起動なしで HTTP テストを実行
- ランタイム別テストは `runtime-tests/` に分離し、Vitest の `projects` 機能でまとめて管理
- 型テスト用に `expectTypeOf` (Vitest) と独自の `Equal`/`Expect` 型ユーティリティを使用
- テストセットアップで `crypto` API と `caches` API をモック（`.vitest.config/setup-vitest.ts`）

### CI パイプライン順序

```
format → lint → editorconfig-checker → build → test
```

`postbuild` で `publint` を実行し、`package.json` の exports 整合性を自動検証。リリースは `np` で管理。

## コード例

### ミドルウェアファクトリのテンプレート

```typescript
// src/middleware/powered-by/index.ts:1-35
/**
 * @module
 * Powered By Middleware for Hono.
 */
import type { MiddlewareHandler } from '../../types'

type PoweredByOptions = {
  serverName?: string
}

export const poweredBy = (options?: PoweredByOptions): MiddlewareHandler => {
  return async function poweredBy(c, next) {
    await next()
    c.res.headers.set('X-Powered-By', options?.serverName ?? 'Hono')
  }
}
```

### テストパターン: app.request() によるサーバーレステスト

```typescript
// src/hono.test.ts:49-80
describe('GET Request', () => {
  describe('without middleware', () => {
    const app = new Hono<Env>()

    app.get('/hello', async () => {
      return new Response('hello', {
        status: 200,
        statusText: 'Hono is OK',
      })
    })

    it('GET http://localhost/hello is ok', async () => {
      const res = await app.request('http://localhost/hello')
      expect(res).not.toBeNull()
      expect(res.status).toBe(200)
      expect(res.statusText).toBe('Hono is OK')
    })
  })
})
```

### 型テスト用ユーティリティ

```typescript
// src/utils/types.ts:7-10
export type Expect<T extends true> = T
export type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false
export type NotEqual<X, Y> = true extends Equal<X, Y> ? false : true
```

## Good Patterns

- **名前付き関数式によるミドルウェア識別**: 全ミドルウェアが `return async function middlewareName(c, next) { ... }` パターンで統一されている。スタックトレースでミドルウェア名が表示されるため、onion 構造のどの層でエラーが発生したか即座に特定できる。匿名アロー関数では `anonymous` としか表示されない問題を根本的に解決している。

```typescript
// src/middleware/cors/index.ts:99
  return async function cors(c, next) {
    // ...
  }
```

- **段階的 TypeScript 厳密さ**: 開発用 tsconfig で `noUnusedLocals: false` としてテスト中の試行錯誤を許容し、ビルド用 tsconfig で `noUnusedLocals: true` に切り替える。DX と品質を両立する実用的なアプローチ。

```json
// tsconfig.build.json:3-8
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noUnusedLocals": true,
    "noUnusedParameters": true
  }
}
```

- **ESLint disable の局所化**: `@typescript-eslint/no-explicit-any` をグローバルに OFF にせず、必要箇所で `/* eslint-disable @typescript-eslint/no-explicit-any */` を使い、`any` 使用をコードレビュー対象にする。型定義ファイル（`types.ts`, `hono-base.ts`）ではファイル先頭で許可し、それ以外では行単位で許可。

```typescript
// src/hono-base.ts:6
/* eslint-disable @typescript-eslint/no-explicit-any */

// src/context.ts:45
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  props: any
```

- **`#` private fields と `private` の使い分けを明示コメント**: ランタイムでの可視性が必要な場合は `private` キーワードを使い、その理由をコメントで明記。意図的な判断であることがコードを読む人に伝わる。

```typescript
// src/hono-base.ts:120-121
  // Cannot use `#` because it requires visibility at JavaScript runtime.
  private _basePath: string = '/'
```

- **`app.request()` によるゼロコストテスト**: Hono はフレームワーク自体に `.request()` メソッドを持ち、HTTP サーバーを起動せずにテストできる。テスト実行速度が極めて高速で、ポート競合の問題も起きない。

```typescript
// src/hono.test.ts:77
  const res = await app.request('http://localhost/hello')
```

## Anti-Patterns / 注意点

- **ESLint 型チェックルールの全面 OFF のリスク**: `no-floating-promises` や `no-misused-promises` の無効化は、Promise の `await` 忘れや非同期処理のバグを見逃す可能性がある。Hono ほどの型複雑度がなければ、これらのルールは有効にしておくべき。

```typescript
// Bad: Hono のように型チェック系を全面 OFF にする（一般プロジェクトでは）
const typeCheckedRules = {
  '@typescript-eslint/no-floating-promises': 'off',
  '@typescript-eslint/no-misused-promises': 'off',
  // ...
}

// Better: パフォーマンスが許容範囲なら型チェック系は ON のまま
// 個別のファイルで必要に応じて disable する
```

- **`globals: true` の暗黙的依存**: Vitest の `globals: true` はテストファイル内で `describe`, `it`, `expect` がインポートなしで使えて便利だが、IDE の補完やエラー検出が不安定になることがある。TypeScript の `types` に `vitest/globals` を含めることで軽減しているが、テストのインポート元が不明確になる。

```typescript
// Bad: globals: true の場合、import 元が不明
describe('test', () => { ... })

// Better: 明示的インポート（好みの問題だが追跡性が上がる）
import { describe, it, expect } from 'vitest'
describe('test', () => { ... })
```

## 自分のプロジェクトへの適用

- [ ] ミドルウェアや Express ハンドラで名前付き関数式を使い、スタックトレースの可読性を向上させる
- [ ] tsconfig を dev 用と build 用に分離し、開発時は `noUnusedLocals: false`、ビルド時は `true` にする
- [ ] `eslint-disable` を局所的に使う方針を定め、`any` 型の使用箇所をレビュー可能にする
- [ ] EditorConfig + editorconfig-checker を CI に導入し、エディタ間のフォーマット差異を防止する
- [ ] `postbuild` で `publint` を実行し、package.json の exports 整合性を自動検証する
- [ ] ES Private Fields (`#`) と `private` の使い分けガイドラインを策定する（ランタイム可視性の有無で判断）
- [ ] フレームワーク提供の `.request()` パターン（サーバーレステスト）を自プロジェクトのテストヘルパーに導入する
