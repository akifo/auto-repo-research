# Performance

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono のルーター性能最適化・正規表現コンパイル戦略・ベンチマーク基盤を分析する。Hono は 5 種類のルーターを持ち、それぞれ登録時コスト・マッチ時コスト・対応パターンの制約が異なる。中核の `RegExpRouter` は全ルートを単一の正規表現にコンパイルし、O(1) に近いマッチング性能を実現する。ルーター選択を自動化する `SmartRouter` や、リクエストディスパッチ時の単一ハンドラ最適化など、フレームワーク全体で多層的な性能チューニングが施されている。

## 設計思想

- **「ルーティングのコストをビルド時に移す」原則**: `RegExpRouter` は全ルートを Trie 構造に挿入し、最終的に単一の正規表現にコンパイルする。マッチング時は 1 回の `RegExp.exec()` でルート特定とパラメータ抽出を同時に行う。ランタイムコストを初回ビルド時に前払いし、リクエストごとの計算を最小化する設計。根拠: `src/router/reg-exp-router/trie.ts:49-73` の `buildRegExp()` が単一の RegExp を生成する。

- **「静的ルートはハッシュマップで O(1) にする」原則**: 動的パラメータを含まないルートは `StaticMap`（`Object.create(null)` で生成したプロトタイプなしオブジェクト）に格納し、正規表現マッチの前にハッシュマップ参照で即座に返す。全ルートが静的の場合、正規表現は一切実行されない。根拠: `src/router/reg-exp-router/matcher.ts:17-19` で `staticMatch` を先に確認する。

- **「ルーター選択は自動化し、ユーザーに判断させない」原則**: `SmartRouter` は初回マッチ時に登録済みルーターを優先度順に試行し、成功したルーターに `match` メソッドをバインドする。以降のリクエストはフォールバック不要。ユーザーがルーターの特性を理解する必要なく最適なルーターが選ばれる。根拠: `src/router/smart-router/router.ts:46` で `this.match = router.match.bind(router)` と置換する。

- **「プロトタイプチェーンを排除する」原則**: ルーター全体で `Object.create(null)` を一貫して使用し、プロトタイプチェーン探索のオーバーヘッドを排除する。ルーター内部のハッシュマップ、パラメータオブジェクト、静的マップすべてで適用されている。根拠: `src/router` 配下で 19 箇所使用されている。

## 設計・実装の詳細

### 5 つのルーターの性能特性

| ルーター | 登録コスト | マッチコスト | 制約 | 用途 |
|---|---|---|---|---|
| RegExpRouter | O(n) ビルド | O(1) 相当 | パスパターンの競合で UnsupportedPathError | デフォルト・高性能 |
| TrieRouter | O(k) | O(k) | 制約なし | RegExpRouter のフォールバック |
| LinearRouter | O(1) | O(n) | ラベル+ワイルドカード混在不可 | 起動速度重視（quick プリセット） |
| PatternRouter | O(1) | O(n) | 制約なし | 最小バンドルサイズ（tiny プリセット） |
| PreparedRegExpRouter | O(1) | O(1) 相当 | ビルド済み正規表現が必要 | AOT コンパイル |

### RegExpRouter の正規表現コンパイル戦略

RegExpRouter は以下の 3 段階で単一正規表現を構築する:

1. **トークン化** (`trie.ts:33`): パスを文字単位・パラメータ単位・ワイルドカード単位のトークンに分解する
2. **Trie 構築** (`node.ts:50-133`): トークンを Trie に挿入し、共通接頭辞を共有する。ノードの子キーはリテラル > カスタムパターン > `:label` > ワイルドカードの優先度でソートされる
3. **正規表現生成** (`node.ts:135-162`, `trie.ts:49-73`): Trie を再帰的に走査し、ハンドラインデックスを `#N` マーカー、パラメータキャプチャを `@N` マーカーとして埋め込んだ正規表現文字列を構築する。最後にマーカーを空キャプチャグループ `$()` に置換し、`match.indexOf('', 1)` でマッチしたルートを O(1) で特定する

### マッチ時の空文字列インデックス技法

`matcher.ts:27` の `match.indexOf('', 1)` は、正規表現マッチ結果の中で最初に空文字列が出現するキャプチャグループのインデックスを返す。各ルートに対応するキャプチャグループが 1 つだけ空文字列をキャプチャするよう正規表現が設計されており、ルートの識別を `indexOf` 一発で実現する。

### SmartRouter の遅延選択メカニズム

`SmartRouter` はコンストラクタで複数のルーターを受け取り、`add()` ではルート情報を配列に蓄積するだけで実際のルーター構築を行わない。初回 `match()` 呼び出し時に各ルーターへの登録を試行し、`UnsupportedPathError` を投げないルーターを選択する。選択後は `this.match` を選択されたルーターの `match` に直接バインドし、以降の呼び出しで SmartRouter のコードは一切実行されない。

### リクエストディスパッチの単一ハンドラ最適化

`hono-base.ts:424-442` で、マッチ結果にハンドラが 1 つしかない場合は `compose()` を呼ばず直接ハンドラを実行する。ミドルウェアなしの単純なルートでは async 関数のラッピングオーバーヘッドを回避する。

### URL パースの charCode 最適化

`utils/url.ts:106-134` の `getPath()` は、URL からパスを抽出する際に `charCodeAt()` を使った文字単位のループで `%`（パーセントエンコーディング）と `?`（クエリ文字列）を検出する。`indexOf()` + `slice()` やRegExp より高速であることがベンチマーク (`benchmarks/utils/src/get-path.ts`) で確認されており、パーセントエンコーディングを含まない（大多数の）リクエストでは `decodeURI` の呼び出しを完全にスキップする。

### バンドルサイズ計測基盤

`perf-measures/bundle-check/` で esbuild によるミニファイ済みバンドルサイズを CI で計測している。ゼロ依存ポリシーと合わせて、バンドルサイズのリグレッションを検知する仕組みが整っている。

## コード例

### 単一正規表現の生成（Trie から RegExp へ）

```typescript
// src/router/reg-exp-router/trie.ts:49-73
buildRegExp(): [RegExp, ReplacementMap, ReplacementMap] {
  let regexp = this.#root.buildRegExpStr()
  if (regexp === '') {
    return [/^$/, [], []] // never match
  }

  let captureIndex = 0
  const indexReplacementMap: ReplacementMap = []
  const paramReplacementMap: ReplacementMap = []

  regexp = regexp.replace(/#(\d+)|@(\d+)|\.\*\$/g, (_, handlerIndex, paramIndex) => {
    if (handlerIndex !== undefined) {
      indexReplacementMap[++captureIndex] = Number(handlerIndex)
      return '$()'  // 空文字列をキャプチャするグループ
    }
    if (paramIndex !== undefined) {
      paramReplacementMap[Number(paramIndex)] = ++captureIndex
      return ''
    }
    return ''
  })

  return [new RegExp(`^${regexp}`), indexReplacementMap, paramReplacementMap]
}
```

### 静的ルートの O(1) 参照とフォールバック

```typescript
// src/router/reg-exp-router/matcher.ts:10-33
export function match<R extends Router<T>, T>(this: R, method: string, path: string): Result<T> {
  const matchers: MatcherMap<T> = (this as any).buildAllMatchers()

  const match = ((method, path) => {
    const matcher = (matchers[method] || matchers[METHOD_NAME_ALL]) as Matcher<T>

    const staticMatch = matcher[2][path]  // ハッシュマップで O(1) 参照
    if (staticMatch) {
      return staticMatch
    }

    const match = path.match(matcher[0])  // 正規表現にフォールバック
    if (!match) {
      return [[], emptyParam]
    }

    const index = match.indexOf('', 1)  // 空文字列インデックスでルート特定
    return [matcher[1][index], match]
  }) as Router<T>['match']

  this.match = match  // 初回以降は buildAllMatchers をスキップ
  return match(method, path)
}
```

### SmartRouter の遅延ルーター選択

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
        continue  // 次のルーターを試行
      }
      throw e
    }

    this.match = router.match.bind(router)  // 直接バインドで以降のオーバーヘッド除去
    this.#routers = [router]
    this.#routes = undefined  // ルート情報を GC 対象に
    break
  }
  // ...
}
```

### 単一ハンドラ最適化

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

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: ルーティングアルゴリズムの切り替えを透過的に行う
  - 適用条件: 共通インターフェース `Router<T>` を満たす複数のルーター実装が存在する
  - コード例: `src/router/smart-router/router.ts:4-70`
  - 注意点: SmartRouter は Strategy の選択を自動化し、かつ選択後に `this.match` を直接バインドすることで Strategy パターンの間接呼び出しオーバーヘッドを除去している。通常の Strategy パターンとは異なり、選択は不可逆

- **Flyweight パターン** (分類: 構造)
  - 解決する問題: 静的ルート・空パラメータ等の共有可能オブジェクトの重複生成を防ぐ
  - 適用条件: 同一内容のオブジェクトが繰り返し必要になる場合
  - コード例: `src/router/reg-exp-router/matcher.ts:9` の `emptyParam`、`src/router/linear-router/router.ts:8` の `emptyParams`
  - 注意点: 共有オブジェクトは不変でなければならない

## Good Patterns

- **自己書き換え関数（Self-modifying Function）**: `matcher.ts:31` で `this.match = match` とすることで、初回呼び出し後は `buildAllMatchers()` の分岐を完全に除去する。SmartRouter でも同じ手法を用いている。初期化コストとランタイムコストを明確に分離する優れたパターン。

```typescript
// src/router/reg-exp-router/matcher.ts:31
this.match = match  // 2 回目以降は直接 match() が呼ばれる
```

- **静的ルートのファストパス**: 正規表現マッチの前にハッシュマップ参照で静的ルートを即座に返す。多くの Web アプリケーションで大半のルートが静的であるため、正規表現エンジンの起動コストを回避する実用的な最適化。

```typescript
// src/router/reg-exp-router/matcher.ts:17-19
const staticMatch = matcher[2][path]
if (staticMatch) {
  return staticMatch
}
```

- **空文字列インデックスによるルート識別**: 正規表現のキャプチャグループに空文字列 `$()` を埋め込み、`indexOf('', 1)` でマッチしたルートを特定する。ルート数に関係なく 1 回の正規表現マッチで完結するため、従来の「各ルートに正規表現を持つ」アプローチに対して劇的に高速。

```typescript
// src/router/reg-exp-router/matcher.ts:27
const index = match.indexOf('', 1)
return [matcher[1][index], match]
```

- **charCode ベースの URL パース**: `charCodeAt()` によるバイト比較で文字列操作を最小化し、パーセントエンコーディングを含まない（一般的な）ケースでは `decodeURI` を完全にスキップする。

```typescript
// src/utils/url.ts:110-133
for (; i < url.length; i++) {
  const charCode = url.charCodeAt(i)
  if (charCode === 37) {  // '%' - パーセントエンコーディング検出
    // ...即座にフォールバック
  } else if (charCode === 63 || charCode === 35) {  // '?' or '#'
    break
  }
}
return url.slice(start, i)
```

## Anti-Patterns / 注意点

- **ルートごとに個別の正規表現を持つ**: PatternRouter (`src/router/pattern-router/router.ts:34-36`) はルート追加時に個別の `new RegExp()` を生成し、マッチ時に全ルートを線形走査する。ルート数が増えると性能が劣化する。バンドルサイズ最小化のトレードオフとして意図的に採用されているが、ルート数の多いアプリケーションでは避けるべき。

```typescript
// Bad: ルートごとに正規表現を生成して線形走査（PatternRouter）
this.#routes.push([
  new RegExp(`^${parts.join('')}${endsWithWildcard ? '' : '/?$'}`),
  method,
  handler,
])

// Better: 全ルートを単一正規表現にコンパイル（RegExpRouter）
const [regexp, indexReplacementMap, paramReplacementMap] = trie.buildRegExp()
```

- **正規表現キャッシュの無制限蓄積**: `wildcardRegExpCache` (`src/router/reg-exp-router/router.ts:19-28`) はワイルドカードパスの正規表現をキャッシュするが、`buildAllMatchers()` 完了後に `clearWildcardRegExpCache()` で明示的にクリアしている。キャッシュをクリアせずに放置するとメモリリークにつながる。

```typescript
// Bad: キャッシュを生成するだけでクリアしない
let cache: Record<string, RegExp> = {}
function buildRegExp(path: string): RegExp {
  return (cache[path] ??= new RegExp(...))
}

// Better: ビルド完了後にキャッシュを解放する
protected buildAllMatchers(): MatcherMap<T> {
  const matchers = // ... build
  this.#middleware = this.#routes = undefined  // ルート情報解放
  clearWildcardRegExpCache()  // キャッシュ解放
  return matchers
}
```

## 導出ルール

> このセクションは必須。最低 3 個のルールを記載すること。synthesis-writer が rules.md 生成時に参照する。

- `[MUST]` ルーティングライブラリでは、静的ルートをハッシュマップで O(1) 参照するファストパスを設ける
  - 根拠: Hono の RegExpRouter は `staticMap[path]` で正規表現を経由せずに即座に返しており、大半の Web アプリで静的ルートが多数を占めるため効果が大きい (`src/router/reg-exp-router/matcher.ts:17-19`)

- `[MUST]` 初期化コストの高い処理は初回呼び出し時に遅延実行し、結果をキャッシュまたは自己書き換えで以降の呼び出しから除去する
  - 根拠: RegExpRouter の `match()` は初回で `buildAllMatchers()` を実行した後 `this.match` を上書きし、SmartRouter も同じ手法でルーター選択を 1 回限りにしている (`src/router/reg-exp-router/matcher.ts:31`, `src/router/smart-router/router.ts:46`)

- `[SHOULD]` 性能特性の異なる複数のアルゴリズムを提供し、自動選択メカニズムでユーザーの選択負荷を排除する
  - 根拠: SmartRouter は RegExpRouter を優先試行し、UnsupportedPathError 時に TrieRouter にフォールバックすることで、ユーザーがルーターの制約を意識せずに最適な性能を得られる (`src/router/smart-router/router.ts:32-49`)

- `[SHOULD]` ホットパスでのオブジェクト生成では `Object.create(null)` を使い、プロトタイプチェーン探索を排除する
  - 根拠: Hono のルーター実装全体で 19 箇所 `Object.create(null)` を使用し、`{}` によるプロトタイプ付きオブジェクトを避けている

- `[SHOULD]` URL パースなどリクエストごとに実行される処理では、一般的なケース（パーセントエンコーディングなし等）を先に検出して高コストな変換をスキップする
  - 根拠: `getPath()` は `charCodeAt()` ループで `%` を検出し、含まれない場合は `decodeURI` を完全にスキップする。ベンチマークで他手法より高速であることが確認されている (`benchmarks/utils/src/get-path.ts`)

- `[AVOID]` ルーティングで各ルートに個別の正規表現を持たせ、リクエストごとに線形走査する設計
  - 根拠: PatternRouter はバンドルサイズ最小化のために意図的にこの設計を選んでいるが、ルート数増加に伴い O(n) で性能劣化する。RegExpRouter の単一正規表現方式なら O(1) 相当

- `[AVOID]` ビルドフェーズで生成した一時キャッシュをランタイムに持ち越す
  - 根拠: RegExpRouter は `buildAllMatchers()` 完了後に `this.#middleware`、`this.#routes`、`wildcardRegExpCache` をすべて解放し、不要なメモリ消費を防いでいる (`src/router/reg-exp-router/router.ts:218-219`)

## 適用チェックリスト

- [ ] ルーティングで静的パスと動的パスを区別し、静的パスにはハッシュマップによるファストパスを設けているか
- [ ] 初期化処理（正規表現コンパイル、設定パース等）を遅延実行し、結果を自己書き換えまたはキャッシュで固定化しているか
- [ ] ホットパスで `Object.create(null)` を使い、プロトタイプチェーン探索のオーバーヘッドを排除しているか
- [ ] リクエストごとに実行される文字列操作で、一般的なケースを先に検出して高コスト処理をスキップしているか
- [ ] ビルドフェーズの一時データ（中間キャッシュ、構築用ツリー等）をビルド完了後に解放しているか
- [ ] ミドルウェアなしの単純なルートで、compose/dispatch のオーバーヘッドを回避する最適化があるか
- [ ] バンドルサイズの計測を CI に組み込み、リグレッションを検知できるか
- [ ] 性能特性の異なる実装を Strategy パターンで切り替え可能にし、自動選択メカニズムを提供しているか
