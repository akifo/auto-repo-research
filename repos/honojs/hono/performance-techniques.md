# performance-techniques

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono のコードベース全体に適用されているパフォーマンス技法を横断的に分析した。ルーティング最適化（5種ルーターの戦略的使い分けとメソッド置換による遅延評価）、ホットパスでのプロトタイプチェーン回避（`Object.create(null)`の徹底使用）、URL パース時の `new URL()` 排除、レスポンス生成のファストパス、プリセットによるバンドルサイズ制御、ビルド済み正規表現のシリアライゼーションなど、ランタイム/バンドルサイズ両面で徹底した最適化が行われている。特筆すべきは、これらの技法がフレームワーク固有ではなく、HTTP 処理やルーティングを行う任意のアプリケーションに転用可能な汎用性を持つ点である。

## 背景にある原則

- **初回実行で最適構造に収束させる**: ルーターやマッチャーの構築コストは初回リクエスト時にのみ支払い、以降はメソッド置換で構築済みの関数に直接委譲する。「コストを払うタイミングは一度だけ」という原則。（`src/router/smart-router/router.ts:46`, `src/router/reg-exp-router/matcher.ts:31`）
- **ホットパスからプロトタイプ探索を排除する**: リクエストごとに触れるオブジェクトは `Object.create(null)` で生成し、`hasOwnProperty` チェックや意図しないプロトタイプ汚染を回避する。V8 などのエンジンでプロパティアクセスが高速化される。（`src/router` 配下全体で 20 箇所以上）
- **API オブジェクトの生成を必要になるまで遅延する**: `new URL()` のような高コスト API を避け、文字列の `indexOf`/`charCodeAt` でパースする。Context の `req` プロパティも getter で遅延生成する。「使わないものは生成しない」原則。（`src/utils/url.ts:106-134`, `src/context.ts:357`）
- **エントリポイントの分割でバンドルに含まれるコードを制御する**: tiny/quick プリセットで含まれるルーター実装を選択可能にし、tree-shaking を活用してバンドルサイズを最小化する。（`src/preset/tiny.ts`, `src/preset/quick.ts`, `package.json` exports）

## 実例と分析

### ルーター選択戦略: SmartRouter による初回自動最適化

SmartRouter は複数のルーター候補を受け取り、初回の `match()` 呼び出し時にルート定義を各ルーターに登録して最適なものを選定する。選定後は `this.match = router.match.bind(router)` でメソッド自体を置き換え、以降の呼び出しでは SmartRouter の分岐ロジックを完全にスキップする。

```typescript
// src/router/smart-router/router.ts:32-49
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
  this.#routes = undefined  // 登録データを GC 対象にする
  break
}
```

同様のパターンが RegExpRouter のマッチャーでも使われている。初回 `match()` で正規表現をビルドし、以降は構築済みのクロージャに置換する:

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

  this.match = match  // 以降は buildAllMatchers を呼ばない
  return match(method, path)
}
```

### 静的ルートのテーブル直引き

RegExpRouter は静的ルート（パラメータもワイルドカードも含まないパス）を `StaticMap` に分離し、正規表現マッチングを迂回して O(1) でハンドラを返す:

```typescript
// src/router/reg-exp-router/matcher.ts:17-19
const staticMatch = matcher[2][path]
if (staticMatch) {
  return staticMatch
}
```

静的ルートの登録時に `Object.create(null)` のマップに格納するため、プロトタイプチェーンのオーバーヘッドもない:

```typescript
// src/router/reg-exp-router/router.ts:51-55
const staticMap: StaticMap<T> = Object.create(null)
for (let i = 0, j = -1, len = routesWithStaticPathFlag.length; i < len; i++) {
  const [pathErrorCheckOnly, path, handlers] = routesWithStaticPathFlag[i]
  if (pathErrorCheckOnly) {
    staticMap[path] = [handlers.map(([h]) => [h, Object.create(null)]), emptyParam]
  }
```

### URL パースの低レベル最適化

`getPath()` は `new URL()` を使わず、文字列操作のみでパスを抽出する。`charCodeAt` による文字コード比較でループを制御し、パーセントエンコーディングが含まれない一般的なケースでは `slice` のみで完結する:

```typescript
// src/utils/url.ts:106-134
export const getPath = (request: Request): string => {
  const url = request.url
  const start = url.indexOf('/', url.indexOf(':') + 4)
  let i = start
  for (; i < url.length; i++) {
    const charCode = url.charCodeAt(i)
    if (charCode === 37) {
      // '%' - パーセントエンコーディングが見つかった場合のみフォールバック
      const queryIndex = url.indexOf('?', i)
      const hashIndex = url.indexOf('#', i)
      // ...省略...
      return tryDecodeURI(path.includes('%25') ? path.replace(/%25/g, '%2525') : path)
    } else if (charCode === 63 || charCode === 35) {
      // '?' or '#'
      break
    }
  }
  return url.slice(start, i)
}
```

クエリパラメータ解析も同様に、`URLSearchParams` を使わず `indexOf` ベースの手動パースで実装されている (`src/utils/url.ts:219-300`)。

### 単一ハンドラのファストパス

リクエストに対してミドルウェアなしの単一ハンドラのみがマッチした場合、`compose()` によるミドルウェアチェーン構築をスキップし、ハンドラを直接呼び出す:

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
    : (res ?? this.#notFoundHandler(c))
}
```

同様にテキストレスポンスでも、ヘッダやステータスが未設定なら `new Response(text)` を直接返すファストパスがある:

```typescript
// src/context.ts:677-684
text: TextRespond = (text, arg, headers) => {
  return !this.#preparedHeaders && !this.#status && !arg && !headers && !this.finalized
    ? (new Response(text) as ReturnType<TextRespond>)
    : (this.#newResponse(text, arg, setDefaultContentType(TEXT_PLAIN, headers)))
}
```

### Context と HonoRequest の遅延初期化

Context の `req` プロパティは getter で実装されており、実際にアクセスされるまで HonoRequest のインスタンスは生成されない。Map やレンダラーも同様:

```typescript
// src/context.ts:356-358
get req(): HonoRequest<P, I['out']> {
  this.#req ??= new HonoRequest(this.#rawRequest, this.#path, this.#matchResult)
  return this.#req
}
```

```typescript
// src/context.ts:544
this.#var ??= new Map()
```

### プリセットによるバンドルサイズ制御

`hono/tiny` は PatternRouter のみ、`hono/quick` は LinearRouter + TrieRouter (SmartRouter経由) を使い、デフォルトの RegExpRouter + TrieRouter よりも含まれるコード量を削減する:

```typescript
// src/preset/tiny.ts:18
this.router = new PatternRouter()

// src/preset/quick.ts:20-22
this.router = new SmartRouter({
  routers: [new LinearRouter(), new TrieRouter()],
})
```

`package.json` の exports フィールドで `./tiny` と `./quick` を独立エントリポイントとして公開し、ツリーシェイキングが効く構造にしている。

### ビルド済みルーターのシリアライゼーション

PreparedRegExpRouter は正規表現のビルド結果をシリアライズし、起動時の正規表現構築コストを排除する。ビルド時に `buildInitParams()` でマッチャーを構築し、`serializeInitParams()` で JavaScript コードとして出力できる:

```typescript
// src/router/reg-exp-router/prepared-router.ts:95-154
export const buildInitParams: (params: { paths: string[] })
  => ConstructorParameters<typeof PreparedRegExpRouter> = ({ paths }) => {
  const router = new RegExpRouterWithMatcherExport<string>()
  for (const path of paths) {
    router.add(METHOD_NAME_ALL, path, path)
  }
  const matchers = router.buildAndExportAllMatchers()
  // ...relocateMap の構築...
  return [matchers, relocateMap]
}
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: ルーティングアルゴリズムの選択を実行時まで遅延する
  - 適用条件: 入力パターン（ルート定義）によって最適なアルゴリズムが変わる場合
  - コード例: `src/router/smart-router/router.ts:4-70`（SmartRouter が Router インターフェースの実装を動的に選択）
  - 注意点: 選択後はメソッド置換で Strategy の切り替えオーバーヘッドを排除している。純粋な Strategy パターンより積極的な最適化

- **Self-Replacing Method パターン** (分類: 最適化)
  - 解決する問題: 初回呼び出し時のみ必要な初期化ロジックを、2回目以降の呼び出しから排除する
  - 適用条件: 初期化コストが高く、結果がイミュータブルで、ホットパスにある関数
  - コード例: `src/router/smart-router/router.ts:46`, `src/router/reg-exp-router/matcher.ts:31`
  - 注意点: `this.method = ...` でのメソッド置換は JavaScript 固有の技法であり、他言語では仮想関数テーブルの書き換えなど異なるアプローチが必要

## Good Patterns

- **emptyParams シングルトン**: 空のパラメータオブジェクトをモジュールレベルで `Object.create(null)` として1つだけ生成し、パラメータなしの全ルートで共有する。GC 圧力を削減しつつ、プロトタイプチェーンのない安全なオブジェクトを保証する。

```typescript
// src/router/linear-router/router.ts:7
const emptyParams = Object.create(null)

// 使用箇所（同ファイル:31, 69 など）
handlers.push([handler, emptyParams])
```

- **charCodeAt による文字コード比較**: 文字列比較 (`===`) の代わりに `charCodeAt` で数値比較を行い、短い文字でも一貫して高速にする。特に単一文字の判定（`/`, `?`, `#`, `*`, `:` など）で効果的。

```typescript
// src/router/linear-router/router.ts:42
const endsWithStar = routePath.charCodeAt(routePath.length - 1) === 42  // '*'

// src/utils/url.ts:111-128
const charCode = url.charCodeAt(i)
if (charCode === 37) { /* '%' */ }
else if (charCode === 63 || charCode === 35) { /* '?' or '#' */ break }
```

- **ビルド後の中間データ解放**: RegExpRouter は正規表現のビルド完了後に `this.#middleware = this.#routes = undefined` で中間データを解放し、GC が回収できるようにする。

```typescript
// src/router/reg-exp-router/router.ts:217-219
// Release cache
this.#middleware = this.#routes = undefined
clearWildcardRegExpCache()
```

## Anti-Patterns / 注意点

- **`new URL()` のホットパス使用**: `new URL()` はフルパース（プロトコル、ホスト、パス、クエリ、フラグメント）を行い、パスだけが必要な場面では不要なオーバーヘッドを持つ。`getPath()` が示す通り、文字列の `indexOf` と `charCodeAt` で十分代替できる。

```typescript
// Bad: リクエストごとにフル URL パース
const path = new URL(request.url).pathname

// Better: 文字列操作でパスだけを抽出（src/utils/url.ts:106-134 の手法）
const url = request.url
const start = url.indexOf('/', url.indexOf(':') + 4)
// charCodeAt で '?' / '#' を検出してスライス
```

- **ミドルウェアチェーンの無条件構築**: ハンドラが1つしかない場合でも `compose()` を呼ぶと、不要なクロージャ生成と Promise チェーンが発生する。Hono は `matchResult[0].length === 1` で条件分岐してこれを回避している。

```typescript
// Bad: 常に compose を経由
const composed = compose(matchResult[0], onError, onNotFound)
return composed(c)

// Better: 単一ハンドラならダイレクトコール（src/hono-base.ts:423-442）
if (matchResult[0].length === 1) {
  res = matchResult[0][0][0][0](c, async () => { /* notFound */ })
  return res instanceof Promise ? res.then(...) : res
}
```

- **`decodeURIComponent` の長い名前によるバンドル膨張**: 組み込み関数名が長いと minify 後も残る。Hono は短い変数に代入して参照を共有することで、minify 後のコードサイズを削減している。

```typescript
// src/utils/url.ts:319
// `decodeURIComponent` is a long name.
// By making it a function, we can use it commonly when minified, reducing the amount of code.
export const decodeURIComponent_ = decodeURIComponent
```

## 導出ルール

- `[MUST]` ホットパスでハッシュマップとして使うオブジェクトは `Object.create(null)` で生成する
  - 根拠: Hono はルーター内部の全マップ（StaticMap, MatcherMap, paramIndexMap, children 等）で `Object.create(null)` を使用し、プロトタイプチェーン探索の排除と `hasOwnProperty` チェックの省略を実現している（`src/router` 配下で 20 箇所以上）

- `[MUST]` 初期化が高コストな処理は初回実行時にのみビルドし、結果をメソッド置換またはキャッシュで後続の呼び出しに引き渡す
  - 根拠: SmartRouter は初回 `match()` で `this.match = router.match.bind(router)` とメソッド自体を置き換え、RegExpRouter も `this.match = match` で構築済みクロージャに差し替えている（`src/router/smart-router/router.ts:46`, `src/router/reg-exp-router/matcher.ts:31`）

- `[SHOULD]` リクエスト処理のホットパスでは `new URL()` や `URLSearchParams` を避け、`indexOf`/`charCodeAt`/`slice` による文字列操作でパスやクエリを抽出する
  - 根拠: `getPath()` は `new URL()` を一切使わず、`charCodeAt` でパーセントエンコーディング・クエリ・フラグメントの境界を検出する実装で高速化を達成している（`src/utils/url.ts:106-134`）

- `[SHOULD]` ミドルウェアチェーンの構築は実際に複数のハンドラが存在する場合にのみ行い、単一ハンドラのケースではダイレクトコールのファストパスを設ける
  - 根拠: `hono-base.ts:424` の `matchResult[0].length === 1` 分岐により、ミドルウェアなしの単純なルートでは `compose()` のオーバーヘッド（クロージャ生成、再帰的 dispatch）を完全にスキップしている

- `[SHOULD]` ライブラリのエントリポイントを用途別に分割し、ユーザーが必要なコードだけをバンドルに含められるようにする
  - 根拠: `hono`, `hono/tiny`, `hono/quick` の3プリセットがそれぞれ異なるルーター構成を持ち、`package.json` の exports で独立エントリポイントとして公開することでツリーシェイキングを有効にしている

- `[SHOULD]` 空オブジェクトや空配列など頻出する不変値はモジュールレベルのシングルトンとして定義し、インスタンス生成ごとのアロケーションを避ける
  - 根拠: `emptyParams`（4ルーター全て）、`emptyParam`（RegExpRouter matcher）がモジュールスコープで定義され、全マッチ結果で共有されている

- `[AVOID]` ビルドフェーズで確定するデータ構造を実行時に毎回再構築すること。正規表現やルーティングテーブルなど、ルート定義が変わらない構造はビルド時にシリアライズして再利用する
  - 根拠: `PreparedRegExpRouter` と `buildInitParams`/`serializeInitParams` により、正規表現とマッチャー構造をビルド時に構築・シリアライズし、起動時のコストを排除している（`src/router/reg-exp-router/prepared-router.ts:95-165`）

## 適用チェックリスト

- [ ] ホットパスで `{}` リテラルや `new Map()` の代わりに `Object.create(null)` を使っているか確認する
- [ ] リクエスト処理で `new URL()` を使っている箇所を洗い出し、パスのみ必要な場合は文字列操作に置き換えを検討する
- [ ] 初期化が重い処理（正規表現コンパイル、設定パースなど）で、初回呼び出し後にメソッド置換またはキャッシュが適用されているか確認する
- [ ] ミドルウェアチェーンや関数パイプラインに、要素数1のケース向けファストパスがあるか確認する
- [ ] ライブラリの `package.json` exports が用途別に分割されており、不要なコードがバンドルに含まれない構造か確認する
- [ ] 頻出する空オブジェクト・空配列がシングルトンとして共有されているか、リクエストごとに新規生成されていないか確認する
- [ ] バンドルサイズの計測スクリプト（esbuild + minify）が CI に組み込まれているか確認する
- [ ] ビルド時に確定するデータ構造（ルーティングテーブル、バリデーションスキーマなど）が実行時に再構築されていないか確認する
