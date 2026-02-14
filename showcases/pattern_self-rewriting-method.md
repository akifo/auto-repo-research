# Pattern: Self-Rewriting Method

> 出典: [repos/honojs/hono](../repos/honojs/hono/)
> カテゴリ: pattern

## 概要

初回実行時にメソッドを最適な実装に差し替え、2回目以降の呼び出しで分岐コストを完全にゼロにする遅延最適化パターン。Strategy パターンの変形であり、「一度だけ実行すればよい判定処理」を持つあらゆるシステムに応用できる。構成の柔軟性とランタイムパフォーマンスを両立する JavaScript/TypeScript 固有の強力な技法である。

## 背景・文脈

Hono では SmartRouter が5種のルーター実装（RegExpRouter, TrieRouter, LinearRouter, PatternRouter）を保持し、初回の `match()` 呼び出し時にルート定義の特性に応じて最適なルーターを自動選択する。選択後は `this.match = router.match.bind(router)` でメソッドを直接差し替え、以降のルーティングでは SmartRouter の選択ロジックが一切実行されない。同様のパターンが RegExpRouter のマッチャー構築でも使われている。

## 実装パターン

### SmartRouter -- ルーター選択後のメソッド差し替え

```typescript
// src/router/smart-router/router.ts:21-49
match(method: string, path: string): Result<T> {
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
        continue  // このルーターでは処理できない -- 次を試す
      }
      throw e
    }

    // 選択完了: 自身の match メソッドを差し替え
    this.match = router.match.bind(router)
    this.#routers = [router]     // 選ばれなかったルーターを GC 対象に
    this.#routes = undefined     // 登録データも GC 対象に
    break
  }
  // ...
}
```

### RegExpRouter -- マッチャー構築後の関数差し替え

```typescript
// src/router/reg-exp-router/matcher.ts:10-33
export function match<R extends Router<T>, T>(
  this: R, method: string, path: string
): Result<T> {
  // 初回: 正規表現をビルド
  const matchers: MatcherMap<T> = (this as any).buildAllMatchers()

  // 構築済みクロージャを match に差し替え
  const match = ((method, path) => {
    const matcher = (matchers[method] || matchers[METHOD_NAME_ALL]) as Matcher<T>
    const staticMatch = matcher[2][path]
    if (staticMatch) {
      return staticMatch  // 静的ルートは O(1) で返す
    }
    const match = path.match(matcher[0])
    if (!match) {
      return [[], emptyParam]
    }
    const index = match.indexOf('', 1)
    return [matcher[1][index], match]
  }) as Router<T>['match']

  this.match = match  // 2回目以降は buildAllMatchers を呼ばない
  return match(method, path)
}
```

## Good Example

```typescript
// 汎用的な Self-Rewriting Method パターン
class ConfigLoader {
  #configPath: string
  #rawConfig: RawConfig | undefined

  constructor(configPath: string) {
    this.#configPath = configPath
  }

  // 初回呼び出し時に設定を読み込み、最適化された getter に差し替え
  getConfig(): ResolvedConfig {
    const raw = loadConfigSync(this.#configPath)
    const resolved = resolveConfig(raw)

    // 自身の getConfig を差し替え -- 以降はファイル読み込み・解析をスキップ
    this.getConfig = () => resolved
    this.#rawConfig = undefined  // 中間データを GC 対象に

    return resolved
  }
}

// 使用例 -- 利用側は差し替えを意識する必要がない
const loader = new ConfigLoader('./config.yaml')
loader.getConfig()  // 1回目: ファイル読み込み + 解析 + メソッド差し替え
loader.getConfig()  // 2回目以降: 解析済みオブジェクトを即返却
```

```typescript
// Strategy の自己消去パターン -- 複数の候補から最適な実装を選択
class Serializer {
  #strategies: SerializeStrategy[]

  constructor(strategies: SerializeStrategy[]) {
    this.#strategies = strategies
  }

  serialize(data: unknown): string {
    for (const strategy of this.#strategies) {
      if (strategy.canHandle(data)) {
        // 最適な戦略が見つかったら自身を差し替え
        this.serialize = strategy.serialize.bind(strategy)
        this.#strategies = []  // 他の候補を GC 対象に
        return strategy.serialize(data)
      }
    }
    throw new Error('No suitable serializer found')
  }
}
```

## Bad Example

```typescript
// Bad: 毎回分岐する -- 初回以降も不要な判定コストが発生
class ConfigLoader {
  #config: ResolvedConfig | null = null

  getConfig(): ResolvedConfig {
    if (this.#config === null) {  // 毎回 null チェック
      this.#config = resolveConfig(loadConfigSync('./config.yaml'))
    }
    return this.#config
  }
}

// Bad: フラグで初期化状態を管理 -- 分岐 + フラグ参照のオーバーヘッド
class Router {
  #initialized = false
  #selectedRouter: RouterImpl | null = null

  match(method: string, path: string) {
    if (!this.#initialized) {  // 毎回フラグチェック
      this.#selectedRouter = this.#selectBestRouter()
      this.#initialized = true
    }
    return this.#selectedRouter!.match(method, path)
  }
}
```

## 適用ガイド

### どのような状況で使うべきか

- **初期化コストが高く、結果がイミュータブル**: 設定ファイル解析、正規表現コンパイル、データ構造ビルドなど
- **ホットパスにある関数**: リクエスト処理、ルーティング、イベントディスパッチなど頻繁に呼ばれるパス
- **複数の実装候補から最適なものを選択する場面**: Strategy パターンで選択後に切り替えコストを排除したい場合

### 導入時の注意点

- **JavaScript/TypeScript 固有の技法**: `this.method = ...` によるメソッド差し替えは JavaScript のプロトタイプチェーンの仕組みに依存する。他言語では仮想関数テーブルの書き換えなど異なるアプローチが必要
- **中間データの解放**: 差し替え後に不要になったデータ（候補リスト、中間構造体等）は `undefined` に設定して GC の対象にする
- **テスタビリティ**: メソッドが差し替わるため、差し替え前後の動作を別々にテストする必要がある
- **スレッドセーフティ**: シングルスレッド環境（JavaScript）では問題ないが、マルチスレッド環境に移植する場合は同期が必要

### カスタマイズポイント

- 差し替え先の関数を外部から注入可能にすることで、テスト時にモック差し替えができる
- `UnsupportedPathError` のような能力宣言エラーと組み合わせ、候補の適合判定を構造的に行う
- `??=` による遅延初期化（`this.#req ??= new HonoRequest(...)`)と組み合わせて、プロパティ単位での遅延評価も検討する

## 参考

- [repos/honojs/hono/performance-techniques.md](../repos/honojs/hono/performance-techniques.md) — SmartRouter のメソッド自己書き換え、静的ルート O(1) 直引き、charCodeAt パース
- [repos/honojs/hono/architecture.md](../repos/honojs/hono/architecture.md) — Router<T> インターフェースと Strategy パターンの全体像
- [repos/honojs/hono/abstraction-patterns.md](../repos/honojs/hono/abstraction-patterns.md) — UnsupportedPathError による能力宣言とフォールバック
