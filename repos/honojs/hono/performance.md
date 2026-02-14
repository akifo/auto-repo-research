# Performance

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono はルーティング速度、バンドルサイズ、型チェック速度の3軸でパフォーマンスを設計・計測している。5種のルーターを目的別に使い分ける戦略、ミドルウェアチェーンの最適化、遅延初期化による不要コスト回避など、多層的なパフォーマンス戦略が注目に値する。CI でバンドルサイズと HTTP スループットの回帰を PR ごとに自動検出する仕組みも実用的。

## 設計・実装の詳細

### 5種ルーターによるトレードオフの明示的分離

Hono は単一の「最適解」を提供するのではなく、ルーティングアルゴリズムごとに独立したルーターを実装し、ユースケースに応じた選択を可能にしている。

| ルーター | 戦略 | 特徴 |
|---|---|---|
| RegExpRouter | 全ルートを1つの正規表現に合成 | マッチング最速、初期化コスト高 |
| TrieRouter | Trie 木による逐次マッチング | バランス型、RegExpRouter の fallback |
| LinearRouter | 線形探索（正規表現なし） | 初期化最速、少ルート向き |
| PatternRouter | ルートごとに正規表現を生成 | 最小バンドルサイズ |
| SmartRouter | 複数ルーターを試行し最適を自動選択 | ユーザーが意識不要 |

デフォルトの `Hono` クラスは `SmartRouter + RegExpRouter + TrieRouter` の組み合わせ。RegExpRouter が対応できないパスパターン（同一セグメントに複数パラメータ等）は `UnsupportedPathError` で fallback する。

```typescript
// src/hono.ts:28-33
this.router =
  options.router ??
  new SmartRouter({
    routers: [new RegExpRouter(), new TrieRouter()],
  })
```

プリセットによりバンドルサイズを最適化するエントリポイントも提供される。

```typescript
// src/preset/tiny.ts:17-19 — バンドルサイズ最小構成
constructor(options: HonoOptions<E> = {}) {
  super(options)
  this.router = new PatternRouter()
}
```

### RegExpRouter: 全ルートを1つの正規表現に合成

RegExpRouter の核心は Trie 構造でルートパスをマージし、単一の正規表現を生成する点にある。`match()` の初回呼び出し時に `buildAllMatchers()` が発火し、以後は `this.match` を直接置き換えることで初期化コストを1回に抑えている。

```typescript
// src/router/reg-exp-router/matcher.ts:10-33
export function match<R extends Router<T>, T>(this: R, method: string, path: string): Result<T> {
  const matchers: MatcherMap<T> = (this as any).buildAllMatchers()

  const match = ((method, path) => {
    const matcher = (matchers[method] || matchers[METHOD_NAME_ALL]) as Matcher<T>

    const staticMatch = matcher[2][path]
    if (staticMatch) {
      return staticMatch  // 静的ルートは O(1) ハッシュマップ参照
    }

    const match = path.match(matcher[0])  // 単一正規表現でマッチ
    if (!match) {
      return [[], emptyParam]
    }

    const index = match.indexOf('', 1)  // 空キャプチャの位置でルートを特定
    return [matcher[1][index], match]
  }) as Router<T>['match']

  this.match = match  // 関数自身を置き換え、以降は初期化不要
  return match(method, path)
}
```

静的ルートは `StaticMap`（ハッシュマップ）で O(1) マッチ、動的ルートは1回の `RegExp.exec()` で O(1) マッチ。ルート数が増えても計算量が増加しないのが最大の強み。

### SmartRouter: 初回マッチでルーター決定、以後バイパス

SmartRouter は初回の `match()` 呼び出し時にルーター候補を順に試し、成功したルーターの `match` を直接バインドする。2回目以降はSmartRouter の分岐ロジックを完全にスキップする。

```typescript
// src/router/smart-router/router.ts:46
this.match = router.match.bind(router)  // 以降の呼び出しを直接ルーターに委譲
this.#routers = [router]
this.#routes = undefined  // ルート定義を GC 可能にする
```

### 単一ハンドラ最適化: compose をスキップ

ミドルウェアなしのルートでは `compose()` を呼ばず、ハンドラを直接実行する。async/await のオーバーヘッドも回避し、同期的に返せる場合は Promise を生成しない。

```typescript
// src/hono-base.ts:423-442
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
    : (res ?? this.#notFoundHandler(c))  // 同期レスポンスは Promise を生成しない
}
```

### 遅延初期化パターン

Context と HonoRequest は `??=` による遅延初期化を多用し、使われないプロパティのコストをゼロにしている。

```typescript
// src/context.ts:357 — HonoRequest はアクセスされるまで生成しない
get req(): HonoRequest<P, I['out']> {
  this.#req ??= new HonoRequest(this.#rawRequest, this.#path, this.#matchResult)
  return this.#req
}

// src/context.ts:544 — 変数ストアは初回 set() まで Map を生成しない
set: Set<...> = (key: string, value: unknown) => {
  this.#var ??= new Map()
  this.#var.set(key, value)
}
```

### URL パース最適化

`getPath()` は `new URL()` を使わず、文字コードベースの手動パースで高速化している。パーセントエンコーディングが含まれない（大多数の）ケースで `decodeURI` を回避するファストパスを持つ。

```typescript
// src/utils/url.ts:106-134
export const getPath = (request: Request): string => {
  const url = request.url
  const start = url.indexOf('/', url.indexOf(':') + 4)
  let i = start
  for (; i < url.length; i++) {
    const charCode = url.charCodeAt(i)
    if (charCode === 37) {  // '%' — エンコーディングあり: 遅いパスに分岐
      const queryIndex = url.indexOf('?', i)
      const hashIndex = url.indexOf('#', i)
      // ...
      return tryDecodeURI(path)
    } else if (charCode === 63 || charCode === 35) {  // '?' or '#'
      break
    }
  }
  return url.slice(start, i)  // エンコーディングなし: slice のみ
}
```

クエリパラメータの取得も同様に、キーにエンコーディングが含まれない場合は `URLSearchParams` を使わず手動で走査する最適化がある (`src/utils/url.ts:219-253`)。

### Context.text() のファストパス

ヘッダー未設定・ステータス未設定の最も一般的なケースでは、`new Response(text)` のみで返し、ヘッダーマージのオーバーヘッドを回避する。

```typescript
// src/context.ts:672-684
text: TextRespond = (text, arg, headers) => {
  return !this.#preparedHeaders && !this.#status && !arg && !headers && !this.finalized
    ? (new Response(text) as ReturnType<TextRespond>)          // ファストパス
    : (this.#newResponse(text, arg, setDefaultContentType(TEXT_PLAIN, headers)) as ReturnType<TextRespond>)
}
```

### PreparedRegExpRouter: ビルドタイム最適化

`PreparedRegExpRouter` はルートの正規表現をビルドタイムに事前合成し、`serializeInitParams()` で JavaScript コードとしてシリアライズできる。ランタイムの Trie 構築・正規表現コンパイルを完全にスキップでき、サーバーレス環境のコールドスタートを大幅に短縮する。

```typescript
// src/router/reg-exp-router/prepared-router.ts:95-97
export const buildInitParams: (params: {
  paths: string[]
}) => ConstructorParameters<typeof PreparedRegExpRouter> = ({ paths }) => {
```

### CI によるパフォーマンス回帰検出

PR ごとに3つの自動チェックが走る:

1. **バンドルサイズ**: esbuild で minify 後のサイズを計測し、octocov で main ブランチと比較表示
2. **型チェック速度**: 200 ルートのアプリを自動生成し、tsc と typescript-go の `--diagnostics` を計測
3. **HTTP スループット**: bombardier で GET/POST の req/sec を計測し、main ブランチとの差分を PR コメントに投稿

```yaml
# .github/workflows/ci.yml:181-210
perf-measures-check-on-pr:
  name: 'Type & Bundle size Check on PR'
  runs-on: ubuntu-latest
  if: github.event_name == 'pull_request'
  steps:
    - uses: actions/checkout@v6
    - uses: ./.github/actions/perf-measures
      with:
        target-ref: 'auto'

http-benchmark-on-pr:
  name: 'HTTP Speed Check on PR'
  # ... bombardier を使った HTTP ベンチマーク
```

### Object.create(null) の一貫使用

プロトタイプチェーン参照を排除するため、全ルーターのマップ構造に `Object.create(null)` を使用している。`src/` 配下で26箇所使用されており、`hasOwnProperty` チェック不要で微小ながら一貫した最適化。

## Good Patterns

- **関数置き換えによるワンタイム初期化**: SmartRouter と RegExpRouter の `match()` は初回呼び出し後に自身を最適化された関数で置き換える。初期化判定の分岐コストが以降ゼロになる。Proxy や flag チェックよりシンプルで高速。

```typescript
// src/router/reg-exp-router/matcher.ts:31-32
this.match = match  // 初回以降は buildAllMatchers() を経由しない
return match(method, path)
```

- **静的ルートの O(1) ハッシュマップルックアップ**: RegExpRouter はマッチャー構築時に静的ルートを `StaticMap` に分離し、正規表現マッチより前にハッシュマップ参照する。多くの API では静的ルート（`/health`, `/api/users` 等）がリクエストの大部分を占めるため、効果が大きい。

```typescript
// src/router/reg-exp-router/matcher.ts:17-19
const staticMatch = matcher[2][path]
if (staticMatch) {
  return staticMatch
}
```

- **同期レスポンスでの Promise 回避**: `#dispatch` はハンドラの戻り値が Promise でない場合、`async/await` を経由せず直接返す。Web フレームワークで頻出する `c.text('OK')` のような単純なレスポンスで、不要な microtask を生成しない。

```typescript
// src/hono-base.ts:434-441
return res instanceof Promise
  ? res.then(...)
  : (res ?? this.#notFoundHandler(c))
```

- **バンドルサイズを意識したプリセット分離**: `hono/tiny` (PatternRouter のみ) と `hono/quick` (SmartRouter + LinearRouter) を別エントリポイントにすることで、ツリーシェイキングで不要なルーターを除外可能。ユーザーにトレードオフを明示した上で選択させる設計。

## Anti-Patterns / 注意点

- **デフォルト Hono での不要な TrieRouter バンドル**: SmartRouter が RegExpRouter を選択した場合、TrieRouter のコードはバンドルに含まれるが実行されない。サイズが重要な環境では `new Hono({ router: new RegExpRouter() })` を明示するか、`hono/tiny` プリセットを使うべき。

```typescript
// Bad: デフォルトは TrieRouter も含む
import { Hono } from 'hono'
const app = new Hono()

// Better: バンドルサイズが重要なら明示的にルーターを選択
import { Hono } from 'hono'
import { RegExpRouter } from 'hono/router/reg-exp-router'
const app = new Hono({ router: new RegExpRouter() })
```

- **SmartRouter の初回リクエストレイテンシ**: SmartRouter は初回 `match()` で全ルーターを順次試すため、コールドスタートが重要な環境（サーバーレス）では初回リクエストのレイテンシが増加する。`PreparedRegExpRouter` を使うか、ルーターを直接指定することで回避可能。

```typescript
// Bad: サーバーレスでデフォルト SmartRouter
const app = new Hono()

// Better: コールドスタートを最小化
import { PreparedRegExpRouter, buildInitParams } from 'hono/router/reg-exp-router'
const params = buildInitParams({ paths: ['/api/users', '/api/users/:id'] })
const app = new Hono({ router: new PreparedRegExpRouter(...params) })
```

- **compose のオーバーヘッド認識不足**: ミドルウェアを多数適用すると `compose()` の再帰的 `dispatch()` チェーンが深くなる。各 `dispatch` が `async` 関数であるため、ミドルウェア数に比例して microtask が生成される。パフォーマンスが重要なルートではミドルウェアの適用範囲を限定すべき。

```typescript
// Bad: 全ルートに不要なミドルウェアを適用
app.use('*', logger())
app.use('*', cors())
app.use('*', compress())
app.get('/health', (c) => c.text('OK'))  // 3つのミドルウェア + compose

// Better: パスベースで必要なルートにのみ適用
app.get('/health', (c) => c.text('OK'))  // 単一ハンドラ最適化が効く
app.use('/api/*', logger(), cors())
```

## 自分のプロジェクトへの適用

- [ ] ルーター選択の指針を確立する: デフォルト(SmartRouter)、サイズ重視(PatternRouter)、速度重視(RegExpRouter)、サーバーレス(PreparedRegExpRouter)
- [ ] 関数置き換えパターンを、初期化コストが高い処理（DB接続、設定ロードなど）に適用する
- [ ] CI にバンドルサイズチェックを導入し、PR ごとにサイズ回帰を検出する（esbuild + octocov の構成を参考にする）
- [ ] HTTP ベンチマーク（bombardier 等）を CI に組み込み、パフォーマンス回帰をコメントで可視化する
- [ ] 遅延初期化 (`??=`) を Context 相当のリクエストスコープオブジェクトに適用し、不要なオブジェクト生成を回避する
- [ ] URL パースで `new URL()` を避け、文字コードベースの手動パースでホットパスを最適化する
- [ ] プリセットパターン（tiny/quick）を参考に、ユーザーに最適化トレードオフを選択させるエントリポイント設計を検討する
