# Preset System

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono のプリセットシステムは、抽象基底クラス `HonoBase` を継承しコンストラクタでルーター構成を差し替えるだけで、バンドルサイズ・ルーティング性能・対応パターンの異なる複数のビルドバリアントを提供する仕組みである。`hono`（デフォルト）、`hono/tiny`、`hono/quick` の 3 プリセットが存在し、package.json の `exports` フィールドを通じてサブパスインポートとして公開されている。継承 + コンストラクタ DI という極めてシンプルなパターンでありながら、ルーター 5 種類を自在に組み合わせる柔軟性を実現しており、フレームワーク設計のリファレンスとして注目に値する。

## 設計・実装の詳細

### アーキテクチャ全体像

プリセットシステムは以下の 3 層で構成される。

1. **Router インターフェース** (`src/router.ts`) -- `add()` / `match()` / `name` を定義する共通契約
2. **HonoBase 抽象クラス** (`src/hono-base.ts`) -- ルーティング登録・ディスパッチ・ミドルウェア合成などフレームワークのコアロジックを実装。`router` プロパティは `!` で宣言のみ行い、サブクラスに初期化を委ねる
3. **プリセットクラス** (`src/hono.ts`, `src/preset/tiny.ts`, `src/preset/quick.ts`) -- `HonoBase` を継承し、コンストラクタでルーター構成を確定する

```
Router (interface)
  |
  +-- RegExpRouter    ← 正規表現コンパイル、最速
  +-- TrieRouter      ← Trie 木、フォールバック用
  +-- LinearRouter    ← 線形走査、登録コスト O(1)
  +-- PatternRouter   ← 最小実装、バンドルサイズ最小
  +-- SmartRouter     ← 委譲ルーター、最初の match で最適なルーターを自動選択

HonoBase (abstract-like class)
  |
  +-- Hono (default)  = SmartRouter(RegExpRouter, TrieRouter)
  +-- Hono (tiny)     = PatternRouter
  +-- Hono (quick)    = SmartRouter(LinearRouter, TrieRouter)
```

### ルーターインターフェースによる差し替え可能性

`Router<T>` インターフェースは `add` と `match` の 2 メソッドのみを要求する最小契約である。

```typescript
// src/router.ts:29-52
export interface Router<T> {
  name: string
  add(method: string, path: string, handler: T): void
  match(method: string, path: string): Result<T>
}
```

`Result<T>` 型は 2 つのフォーマットを許容する union 型で設計されている。`ParamIndexMap` + `ParamStash` 方式（RegExpRouter が使用）はメモリ効率を、`Params` 方式（LinearRouter, PatternRouter が使用）はシンプルさを優先する。

```typescript
// src/router.ts:98
export type Result<T> = [[T, ParamIndexMap][], ParamStash] | [[T, Params][]]
```

### HonoBase: ルーター非依存のコアロジック

`HonoBase`（実際のクラス名は `Hono`、`src/hono-base.ts` に定義）はルーターの具象型を知らない。`router` プロパティは `!`（definite assignment assertion）で宣言され、サブクラスのコンストラクタで初期化される。

```typescript
// src/hono-base.ts:118
router!: Router<[H, RouterRoute]>
```

コンストラクタでは `options` から `strict` を除いた残りを `Object.assign(this, optionsWithoutStrict)` でプロパティに展開する。これにより `options.router` が指定されていればそれが `this.router` に代入される。

```typescript
// src/hono-base.ts:170-172
const { strict, ...optionsWithoutStrict } = options
Object.assign(this, optionsWithoutStrict)
this.getPath = (strict ?? true) ? (options.getPath ?? getPath) : getPathNoStrict
```

### 3 つのプリセットの実装

各プリセットは `HonoBase` を継承してコンストラクタでルーター構成を注入するだけのシンプルな実装である。

**デフォルト (`src/hono.ts`)** -- SmartRouter + RegExpRouter + TrieRouter

```typescript
// src/hono.ts:26-33
constructor(options: HonoOptions<E> = {}) {
  super(options)
  this.router =
    options.router ??
    new SmartRouter({
      routers: [new RegExpRouter(), new TrieRouter()],
    })
}
```

`options.router` が渡されればそれを使い、なければ SmartRouter のデフォルト構成を適用する。ユーザーは `new Hono({ router: new RegExpRouter() })` のようにルーターを直接指定することもできる。

**tiny (`src/preset/tiny.ts`)** -- PatternRouter のみ

```typescript
// src/preset/tiny.ts:16-19
constructor(options: HonoOptions<E> = {}) {
  super(options)
  this.router = new PatternRouter()
}
```

`options.router` による上書きを許容しない点が特徴的である。PatternRouter は約 60 行の最小実装で、各ルートを個別の正規表現として保持し線形走査する。

**quick (`src/preset/quick.ts`)** -- SmartRouter + LinearRouter + TrieRouter

```typescript
// src/preset/quick.ts:18-23
constructor(options: HonoOptions<E> = {}) {
  super(options)
  this.router = new SmartRouter({
    routers: [new LinearRouter(), new TrieRouter()],
  })
}
```

### SmartRouter: 遅延選択による自動最適化

SmartRouter はプリセットシステムの中核を担う委譲パターンの実装である。初回の `match()` 呼び出し時に、保持するルーター候補を順番に試し、`UnsupportedPathError` を投げないルーターを「勝者」として選定する。

```typescript
// src/router/smart-router/router.ts:21-60
match(method: string, path: string): Result<T> {
  if (!this.#routes) {
    throw new Error('Fatal error')
  }

  const routers = this.#routers
  const routes = this.#routes

  const len = routers.length
  let i = 0
  let res
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

    this.match = router.match.bind(router)  // match メソッド自体を差し替え
    this.#routers = [router]
    this.#routes = undefined  // ルート定義を GC 対象に
    break
  }
  // ...
}
```

注目すべき最適化:
- **メソッド差し替え**: `this.match = router.match.bind(router)` で 2 回目以降は SmartRouter の `match` を完全にバイパスする
- **メモリ解放**: 選定後に `this.#routes = undefined` で蓄積したルート定義を解放する
- **名前の更新**: `this.name = 'SmartRouter + ${this.activeRouter.name}'` でデバッグ時に選定結果を確認可能

### UnsupportedPathError によるフォールバック機構

各ルーターは自身が対応できないパスパターンに遭遇すると `UnsupportedPathError` を投げる。SmartRouter はこれを捕捉して次のルーターを試行する。

- **RegExpRouter**: 曖昧なパスパターン（例: `/entry/:id` と `/entry/entries` の競合）で投げる
- **LinearRouter**: ラベル(`:param`) とワイルドカード(`*`) を同時に含むパスで投げる
- **PatternRouter**: 正規表現の構築に失敗した場合（例: 重複パラメータ名 `/:id/:id`）で投げる

```typescript
// src/router/linear-router/router.ts:136-138
} else if (hasLabel && hasStar) {
  throw new UnsupportedPathError()
}
```

### package.json exports によるサブパスインポート

各プリセットは package.json の `exports` フィールドで独立したエントリポイントとして公開される。

```json
// package.json:58-67
"./tiny": {
  "types": "./dist/types/preset/tiny.d.ts",
  "import": "./dist/preset/tiny.js",
  "require": "./dist/cjs/preset/tiny.js"
},
"./quick": {
  "types": "./dist/types/preset/quick.d.ts",
  "import": "./dist/preset/quick.js",
  "require": "./dist/cjs/preset/quick.js"
}
```

利用者は `import { Hono } from 'hono/tiny'` のように書くだけでプリセットを切り替えられる。全プリセットが同じ `Hono` クラス名をエクスポートするため、インポートパスの変更だけで済む。

### 各ルーターの特性比較

| ルーター | 登録コスト | マッチコスト | バンドルサイズ | 制限事項 |
|---------|-----------|------------|-------------|---------|
| RegExpRouter | 高（Trie 構築 + 正規表現コンパイル） | O(1)（単一正規表現） | 大 | 曖昧パスで UnsupportedPathError |
| TrieRouter | 中（Trie ノード挿入） | O(パス長) | 中 | なし（全パターン対応） |
| LinearRouter | O(1)（配列 push） | O(n)（全ルート走査） | 小 | `:param` + `*` の併用不可 |
| PatternRouter | 中（RegExp 構築） | O(n)（全ルート走査） | 最小（約 60 行） | 重複パラメータ名不可 |
| SmartRouter | 遅延（初回 match 時） | 選定ルーターに委譲 | ルーター合計 | 候補全滅で Fatal error |

## コード例

### getRouterName でプリセットの確認

```typescript
// src/helper/dev/index.ts:76-79
export const getRouterName = <E extends Env>(app: Hono<E>): string => {
  app.router.match('GET', '/')
  return app.router.name
}
```

`match()` を呼ぶことで SmartRouter の遅延選択をトリガーし、選定後のルーター名を返す。テストで活用されている。

```typescript
// src/preset/quick.test.ts:4-8
describe('hono/quick preset', () => {
  it('Should have SmartRouter + LinearRouter', async () => {
    const app = new Hono()
    expect(getRouterName(app)).toBe('SmartRouter + LinearRouter')
  })
})
```

### RegExpRouter の match メソッド自己書き換え

```typescript
// src/router/reg-exp-router/matcher.ts:10-33
export function match<R extends Router<T>, T>(this: R, method: string, path: string): Result<T> {
  const matchers: MatcherMap<T> = (this as any).buildAllMatchers()

  const match = ((method, path) => {
    const matcher = (matchers[method] || matchers[METHOD_NAME_ALL]) as Matcher<T>
    const staticMatch = matcher[2][path]
    if (staticMatch) {
      return staticMatch
    }
    const match = path.match(matcher[0])
    if (!match) {
      return [[], emptyParam]
    }
    const index = match.indexOf('', 1)
    return [matcher[1][index], match]
  }) as Router<T>['match']

  this.match = match  // 自身の match を最適化版に差し替え
  return match(method, path)
}
```

初回呼び出し時にマッチャーをビルドし、2 回目以降はビルド済みマッチャーを直接使うクロージャに `this.match` を差し替える。SmartRouter と同じ「メソッド自己書き換え」パターンが使われている。

## Good Patterns

- **最小インターフェースによる差し替え可能性**: `Router<T>` インターフェースが `add` と `match` の 2 メソッドだけを要求することで、5 種類のルーターを完全に互換にしている。新しいルーターを追加するコストが極めて低い。インターフェースが小さいほど実装の自由度が高くなるという原則の好例である。

```typescript
// src/router.ts:29-52
export interface Router<T> {
  name: string
  add(method: string, path: string, handler: T): void
  match(method: string, path: string): Result<T>
}
```

- **コンストラクタ DI による宣言的なプリセット定義**: 各プリセットクラスは 20 行未満で、コンストラクタでルーター構成を宣言するだけ。ロジックの重複がゼロで、新しいプリセットの追加が容易である。継承の良い使い方の実例。

```typescript
// src/preset/tiny.ts:11-20 (全体で 20 行)
export class Hono<
  E extends Env = BlankEnv,
  S extends Schema = BlankSchema,
  BasePath extends string = '/',
> extends HonoBase<E, S, BasePath> {
  constructor(options: HonoOptions<E> = {}) {
    super(options)
    this.router = new PatternRouter()
  }
}
```

- **UnsupportedPathError によるグレースフルフォールバック**: ルーターが「自分には処理できない」ことを型付き例外で明示的に宣言し、SmartRouter がそれを捕捉して次のルーターに委譲する。例外を制御フローとして活用するが、初回 match のみで発生するため性能への影響はない。

```typescript
// src/router/smart-router/router.ts:39-42
} catch (e) {
  if (e instanceof UnsupportedPathError) {
    continue
  }
  throw e
}
```

- **メソッド自己書き換えによるゼロコスト抽象化**: SmartRouter と RegExpRouter の両方で、初回 match 後に `this.match` を最適化版に差し替える。2 回目以降は選択ロジックもビルドロジックも実行されない。ランタイムのオーバーヘッドを初回のみに閉じ込める優れた最適化。

```typescript
// src/router/smart-router/router.ts:46-48
this.match = router.match.bind(router)
this.#routers = [router]
this.#routes = undefined
```

## Anti-Patterns / 注意点

- **tiny プリセットで options.router が無視される**: デフォルトの `Hono` は `options.router ??` でユーザー指定ルーターを受け付けるが、`tiny` と `quick` は `super(options)` の後に `this.router` を無条件で上書きしている。`Object.assign` でセットされたルーターが直後に消される。

```typescript
// Bad: tiny プリセットでは options.router が無視される
import { Hono } from 'hono/tiny'
const app = new Hono({ router: new RegExpRouter() })
// this.router は PatternRouter になる（RegExpRouter ではない）

// Better: デフォルトプリセットと同じ ?? パターンを使う
constructor(options: HonoOptions<E> = {}) {
  super(options)
  this.router = options.router ?? new PatternRouter()
}
```

- **SmartRouter の候補全滅時のエラーメッセージが不十分**: 全ルーターが `UnsupportedPathError` を投げた場合、`throw new Error('Fatal error')` という情報量の少ないメッセージになる。どのルーターが何のパスで失敗したかの情報が失われる。

```typescript
// src/router/smart-router/router.ts:52-55
if (i === len) {
  // not found
  throw new Error('Fatal error')
}
```

## 自分のプロジェクトへの適用

- [ ] フレームワークやライブラリで「戦略の差し替え」が必要な場合、最小インターフェース + コンストラクタ DI のパターンを採用する。インターフェースは 2-3 メソッドに抑え、実装の自由度を最大化する
- [ ] バンドルサイズが重要なエッジ環境向けに、package.json `exports` でサブパスインポートを定義し、軽量バリアントを提供する（例: `my-lib/lite`）
- [ ] 初期化コストの高い処理（正規表現コンパイル、データ構造構築など）は「メソッド自己書き換え」パターンで初回のみに閉じ込め、2 回目以降のオーバーヘッドをゼロにする
- [ ] 戦略パターンの自動選択が必要な場合、SmartRouter の「UnsupportedPathError でフォールバック」方式を参考にする。各戦略が「自分にはできない」ことを例外で明示し、コーディネーターが次の候補に委譲する
- [ ] 同じクラス名（`Hono`）で異なるプリセットをエクスポートする手法を参考に、利用者側のコード変更をインポートパスの変更だけに抑える API 設計を目指す
