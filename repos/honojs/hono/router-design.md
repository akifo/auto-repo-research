# Router Design

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono のルーターは「Strategy パターンによる差し替え可能な Router インターフェース」と「5 つの異なるアルゴリズムによる実装」から構成される。最速の正規表現ベース（RegExpRouter）から最軽量のパターンマッチ（PatternRouter）まで、特性の異なるルーターを提供し、SmartRouter が自動的に最適なものを選択する設計は、パフォーマンスと互換性のトレードオフを見事に解決している。ルーターの内部アーキテクチャは Web フレームワークの設計として非常に参考になる。

## 設計・実装の詳細

### Router<T> インターフェース — 最小限の契約

ルーターの共通インターフェースは驚くほどシンプルで、`add`、`match`、`name` の 3 メンバだけで構成される。

```typescript
// src/router.ts:29-52
export interface Router<T> {
  name: string
  add(method: string, path: string, handler: T): void
  match(method: string, path: string): Result<T>
}
```

ジェネリクス `<T>` によりハンドラの型がルーターから分離されている。Hono 本体では `[H, RouterRoute]` というタプルを `T` に渡して使用する（`src/hono-base.ts:65`）。

### Result<T> の二重表現 — パフォーマンスの工夫

`match` の返却型 `Result<T>` は 2 種類の形式を union 型で許容する。

```typescript
// src/router.ts:98
export type Result<T> = [[T, ParamIndexMap][], ParamStash] | [[T, Params][]]
```

- **形式 1**: `[[handler, paramIndexMap][], paramStash]` — パラメータを「インデックスマップ + 共有配列」で表現。RegExpRouter が使用。正規表現のキャプチャグループから直接取得できるため、パラメータごとのオブジェクト生成を回避し、GC 圧力を削減する。
- **形式 2**: `[[handler, params][]]` — パラメータを直接 `Record<string, string>` で返す。TrieRouter、PatternRouter、LinearRouter が使用。

この設計により、高速ルーター（RegExpRouter）はメモリ効率の良い形式を使い、シンプルなルーター群は素直なオブジェクト形式を使う。消費側（`common.case.test.ts:40-57`）で `stash` の有無を判定して統一的にパラメータを取得する。

### 5 つのルーター実装と特性

#### RegExpRouter — 全ルートを 1 つの正規表現に統合

最も高速なルーター。全ルートを Trie 木に挿入し、その Trie を 1 つの巨大な正規表現にコンパイルする。`match` 呼び出し時に単一の `RegExp.exec` でルーティングが完了する。

```typescript
// src/router/reg-exp-router/trie.ts:49-73
buildRegExp(): [RegExp, ReplacementMap, ReplacementMap] {
  let regexp = this.#root.buildRegExpStr()
  // ... 正規表現文字列をキャプチャグループインデックスにマッピング
  return [new RegExp(`^${regexp}`), indexReplacementMap, paramReplacementMap]
}
```

ビルド時に静的パスを `StaticMap` としてハッシュマップに分離するため、静的ルートは正規表現を経由せずO(1) でマッチする（`src/router/reg-exp-router/router.ts:51-55`）。

制限: 同じ階層で動的パラメータとリテラルが競合するパス（例: `/:user/entries` と `/entry/:name`）は `UnsupportedPathError` をスローする。

#### TrieRouter — 万能な Trie 木ルーター

パスの各セグメントをノードとして Trie 木を構築する。RegExpRouter がサポートしないパスパターンにも対応可能。マッチ時はノードを逐次探索し、ワイルドカードや正規表現パターンも各ノードで評価する。結果はスコア（登録順序）でソートされる（`src/router/trie-router/node.ts:205-209`）。

#### SmartRouter — ルーター自動選択のオーケストレータ

自身はルーティングロジックを持たず、初回 `match` 呼び出し時に内部ルーターを順番に試行する。

```typescript
// src/router/smart-router/router.ts:21-60
match(method: string, path: string): Result<T> {
  const routers = this.#routers
  const routes = this.#routes
  for (; i < len; i++) {
    const router = routers[i]
    try {
      for (let i = 0, len = routes.length; i < len; i++) {
        router.add(...routes[i])
      }
      res = router.match(method, path)
    } catch (e) {
      if (e instanceof UnsupportedPathError) {
        continue  // 次のルーターを試行
      }
      throw e
    }
    this.match = router.match.bind(router)  // 自身の match を選択されたルーターに差し替え
    break
  }
}
```

核心的な設計: `UnsupportedPathError` を「このルーターでは扱えない」というシグナルとして利用し、フォールバックの仕組みを実現している。選択後は `this.match` を差し替えるため、2 回目以降のオーバーヘッドはゼロ。

#### PatternRouter — 最小実装のルーター

各ルートを個別の `RegExp` として保持し、`match` 時に全ルートを線形スキャンする。コードは約 60 行。

```typescript
// src/router/pattern-router/router.ts:44-58
match(method: string, path: string): Result<T> {
  const handlers: [T, Params][] = []
  for (let i = 0, len = this.#routes.length; i < len; i++) {
    const [pattern, routeMethod, handler] = this.#routes[i]
    if (routeMethod === method || routeMethod === METHOD_NAME_ALL) {
      const match = pattern.exec(path)
      if (match) {
        handlers.push([handler, match.groups || emptyParams])
      }
    }
  }
  return [handlers]
}
```

バンドルサイズが極めて小さく、`preset/tiny.ts` で採用されている。

#### LinearRouter — 遅延コンパイル型

`add` 時は文字列をそのまま配列に保存するだけで、正規表現のコンパイルは行わない。`match` 時に文字列比較・`indexOf` ベースのマッチングを手動で実装している。`hasLabel && hasStar` の組み合わせは `UnsupportedPathError` をスローする（`src/router/linear-router/router.ts:136-138`）。`preset/quick.ts` で SmartRouter + TrieRouter と組み合わせて使われる。

### プリセットによる構成

| プリセット | ルーター構成 | 用途 |
|:---|:---|:---|
| デフォルト (`hono.ts`) | SmartRouter [RegExpRouter, TrieRouter] | 高パフォーマンス + フルパス対応 |
| `preset/quick.ts` | SmartRouter [LinearRouter, TrieRouter] | 起動高速 + フルパス対応 |
| `preset/tiny.ts` | PatternRouter | 最小バンドルサイズ |

### メソッド自己差し替えによる遅延ビルド

RegExpRouter と SmartRouter は、初回 `match` 呼び出し時に自身の `match` メソッドを置き換える。

```typescript
// src/router/reg-exp-router/matcher.ts:10-33
export function match<R extends Router<T>, T>(this: R, method: string, path: string): Result<T> {
  const matchers: MatcherMap<T> = (this as any).buildAllMatchers()
  const match = ((method, path) => {
    // ... 実際のマッチングロジック
  }) as Router<T>['match']
  this.match = match  // 自身の match を最適化版に差し替え
  return match(method, path)
}
```

初回呼び出しで正規表現をビルドし、2 回目以降はビルド済みの正規表現を直接使う。ビルド後は `this.#middleware` と `this.#routes` を `undefined` に設定してメモリを解放する（`src/router/reg-exp-router/router.ts:218`）。この時点以降にルートを追加しようとすると `MESSAGE_MATCHER_IS_ALREADY_BUILT` エラーがスローされる。

### 共通テストスイートによる動作保証

`src/router/common.case.test.ts` に全ルーター共通のテストケースが定義されている。各ルーターは `runTest({ newRouter, skip })` を呼び出し、サポートしないパターンだけを `skip` で除外する。

```typescript
// src/router/reg-exp-router/router.test.ts:6-26
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

SmartRouter（RegExpRouter + TrieRouter）はスキップなしで全テストをパスする（`src/router/smart-router/router.test.ts`）。これにより SmartRouter の組み合わせが全パスパターンをカバーすることが保証されている。

## コード例

### 静的パスの O(1) ルックアップ（RegExpRouter）

```typescript
// src/router/reg-exp-router/matcher.ts:17-19
const staticMatch = matcher[2][path]
if (staticMatch) {
  return staticMatch
}
```

静的パスは `StaticMap` というハッシュマップに事前格納されるため、正規表現マッチを完全にバイパスする。

### emptyParams の共有による GC 最適化

```typescript
// src/router/pattern-router/router.ts:6
const emptyParams = Object.create(null)

// src/router/reg-exp-router/matcher.ts:9
export const emptyParam: string[] = []
```

パラメータなしのルート（`/api/health` など）は共有済みの空オブジェクトを返す。リクエストごとに新しいオブジェクトを生成しない。

### ハンドラが 1 つの場合の compose 省略

```typescript
// src/hono-base.ts:424-442
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
    ? res.then(...)
    : (res ?? this.#notFoundHandler(c))
}
```

マッチしたハンドラが 1 つだけの場合、ミドルウェアチェーンの compose を省略して直接呼び出す。ミドルウェアのない単純なルートで不要なオーバーヘッドを排除している。

## Good Patterns

- **Strategy パターンによるルーター差し替え**: 3 メンバの最小インターフェース（`name`, `add`, `match`）でルーターを抽象化し、アルゴリズムを完全に差し替え可能にしている。ユーザーは `new Hono({ router: new RegExpRouter() })` のように 1 行で切り替えられる。

```typescript
// src/hono-base.ts:65
router?: Router<[H, RouterRoute]>
```

- **UnsupportedPathError によるケイパビリティ通知**: 各ルーターがサポートしないパスパターンを例外で通知し、SmartRouter がフォールバック先を自動選択する。エラーをフロー制御に使う稀な正当例。

```typescript
// src/router/smart-router/router.ts:39-43
} catch (e) {
  if (e instanceof UnsupportedPathError) {
    continue
  }
  throw e
}
```

- **共通テストスイート + skip リスト**: 全ルーター共通のテストを 1 ファイルに集約し、各ルーターは理由付きの skip リストで非対応ケースを明示。SmartRouter が skip なしで全通過することで、フォールバックの正しさを保証。

- **メソッド自己差し替えによる遅延ビルド**: 初回 `match` で正規表現をコンパイルし、`this.match` を最適化版に差し替える。起動時のコストをゼロにし、不要なビルドフェーズの呼び出しを構造的に排除する。

```typescript
// src/router/reg-exp-router/matcher.ts:31-32
this.match = match
return match(method, path)
```

- **Result<T> の union 型による最適化余地の提供**: 高速ルーターはインデックスベースの軽量形式を、シンプルなルーターは直感的なオブジェクト形式を返す。インターフェースの柔軟性が実装固有の最適化を許容している。

## Anti-Patterns / 注意点

- **ビルド後のルート追加は実行時エラー**: RegExpRouter は初回 `match` 後に内部状態を破棄するため、以降の `add` は実行時エラーになる。静的型では防げない。

```typescript
// Bad: 初回マッチ後にルートを追加
const router = new RegExpRouter()
router.add('GET', '/a', handler)
router.match('GET', '/a')      // ビルド実行、内部状態破棄
router.add('GET', '/b', handler) // Error: Can not add a route since the matcher is already built.
```

```typescript
// Better: 全ルートを match 前に登録完了する
const router = new RegExpRouter()
router.add('GET', '/a', handlerA)
router.add('GET', '/b', handlerB)
router.match('GET', '/a') // ここでビルド
```

- **RegExpRouter の曖昧パスの制限**: 同じ階層でリテラルと動的パラメータが競合するパスは `UnsupportedPathError` になる。開発者が意識せず踏みやすい。

```typescript
// Bad: RegExpRouter 単体では UnsupportedPathError
router.add('GET', '/:user/entries', handler1)
router.add('GET', '/entry/:name', handler2)
```

```typescript
// Better: SmartRouter 経由で使用し、自動的に TrieRouter にフォールバックさせる
const app = new Hono() // デフォルトで SmartRouter [RegExpRouter, TrieRouter]
```

- **`this.match` の差し替えは TypeScript の型安全性を弱める**: `(this as any).buildAllMatchers()` のように `any` を経由しており、リファクタリング時に型チェックが効かない箇所がある。パフォーマンス最適化と型安全性のトレードオフ。

## 自分のプロジェクトへの適用

- [ ] Strategy パターンで差し替え可能なコアインターフェースを設計する際は、Hono のように 2-3 メソッドの最小インターフェースにとどめる
- [ ] 複数の実装戦略を持つシステムでは、SmartRouter のようなオーケストレータを用意し、UnsupportedPathError 相当の「対応不可シグナル」でフォールバックを自動化する
- [ ] 共通テストスイート + skip リストのパターンを、プラグインや戦略パターンのテストに採用する
- [ ] パフォーマンスクリティカルなパスでは、メソッド自己差し替えによる遅延ビルドを検討する（初回コストを初回呼び出し時に移動）
- [ ] Result の union 型のように、インターフェースの返却型に実装固有の最適化余地を設ける設計を検討する
- [ ] `Object.create(null)` による空パラメータの共有パターンを、頻繁に生成される小さなオブジェクトに適用する
