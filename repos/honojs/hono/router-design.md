# router-design

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono は 5 種類のルーター実装（RegExpRouter, TrieRouter, LinearRouter, PatternRouter, SmartRouter）を持ち、すべてが同一の `Router<T>` インターフェースを実装する Strategy パターンを採用している。SmartRouter は初回マッチ時に最適なルーターを自動選択するメタルーターとして機能し、`UnsupportedPathError` を用いたフォールバック機構によって「最速のルーターを試し、失敗したら次善のルーターへ」という段階的劣化戦略を実現している。この設計は「パフォーマンスと互換性のトレードオフをユーザーに強いない」というフレームワーク設計の指針として注目に値する。

## 設計思想

- **性能と互換性を二項対立にしない**: RegExpRouter は全ルートを単一正規表現にコンパイルして O(1) マッチを実現するが、一部のルートパターン（同一パスセグメントで異なるラベル名、キャプチャグループ等）を処理できず `UnsupportedPathError` を投げる。これを「制限」として終わらせず、SmartRouter による自動フォールバックで解決している。ユーザーはルーターの制約を意識する必要がない（`src/hono.ts:28-33`）。

- **インターフェースの最小化による交換可能性**: `Router<T>` インターフェースは `name`, `add(method, path, handler)`, `match(method, path)` の 3 メンバーのみで構成される（`src/router.ts:29-52`）。この最小インターフェースが 5 種ルーターの交換可能性を保証し、Strategy パターンの成立条件を満たしている。

- **遅延構築 + メソッド置換による初回コスト吸収**: RegExpRouter と SmartRouter は初回 `match()` 呼び出し時にデータ構造を構築し、構築後は `this.match` を最適化された関数に差し替える（`src/router/reg-exp-router/matcher.ts:31`, `src/router/smart-router/router.ts:46`）。2 回目以降の呼び出しは構築フェーズをスキップし、ルーティングのホットパスが最小コストになる。

- **共通テストスイートによる行動互換の保証**: 5 種のルーターは `common.case.test.ts` を共有し、`skip` 配列で各ルーターの既知の非対応ケースを明示的にスキップする（`src/router/common.case.test.ts:14-23`）。これにより「どのルーターがどのパスパターンを非サポートか」がテストコードから一目で分かる。

## 設計・実装の詳細

### Router インターフェースと Result 型の二重表現

`Router<T>` の `match()` が返す `Result<T>` 型は 2 つのフォーマットを許容する union 型になっている:

```typescript
// src/router.ts:98
export type Result<T> = [[T, ParamIndexMap][], ParamStash] | [[T, Params][]]
```

- **ParamIndexMap + ParamStash 形式**: RegExpRouter が使用。パラメータ値を共有配列（stash）に格納し、ハンドラごとにはインデックスマップのみ持つ。正規表現の `match()` 結果配列をそのまま stash として使えるため、パラメータ抽出のオーバーヘッドがゼロに近い。
- **Params 形式**: TrieRouter, LinearRouter, PatternRouter が使用。ハンドラごとに `Record<string, string>` のパラメータマップを返す。

呼び出し側（`common.case.test.ts:41-54`）は stash の有無で分岐し、どちらの形式でも統一的に扱う。この設計により、高速ルーターは最適なデータ表現を使いつつ、インターフェースの互換性を維持できる。

### 5 種ルーターの特性マトリクス

| ルーター | アルゴリズム | add() コスト | match() コスト | 制限 |
|---|---|---|---|---|
| RegExpRouter | 全ルートを単一正規表現にコンパイル | 蓄積（遅延構築） | O(1)（正規表現マッチ 1 回） | 同一セグメントで異なるラベル名不可等 |
| TrieRouter | Trie 木探索 | O(パスセグメント数) | O(パスセグメント数) | なし（全パターン対応） |
| LinearRouter | ルート配列の線形走査 | O(1) | O(n)（n = ルート数） | ラベル+ワイルドカード混在不可 |
| PatternRouter | ルートごとに正規表現生成 + 線形走査 | O(1) | O(n) | 重複パラメータ名不可 |
| SmartRouter | メタルーター（内部ルーターに委譲） | O(1)（蓄積） | 初回: 試行錯誤、2回目以降: 委譲先と同等 | なし |

### SmartRouter の自動選択メカニズム

SmartRouter の核心は初回 `match()` での試行錯誤ループにある:

```typescript
// src/router/smart-router/router.ts:21-60
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
        continue  // このルーターはダメ → 次を試す
      }
      throw e
    }

    this.match = router.match.bind(router)  // メソッド置換
    this.#routers = [router]                // 選択されたルーターのみ保持
    this.#routes = undefined                // ルート蓄積を解放
    break
  }

  this.name = `SmartRouter + ${this.activeRouter.name}`
  return res as Result<T>
}
```

動作フロー:
1. `add()` 呼び出し時はルート情報を `#routes` 配列に蓄積するだけ
2. 初回 `match()` で `#routers` 配列の先頭から順に全ルートを `add()` して `match()` を試行
3. `UnsupportedPathError` が発生したら次のルーターを試行（`continue`）
4. 成功したら `this.match = router.match.bind(router)` でメソッドを直接差し替え
5. `#routes = undefined` でルート蓄積データを GC 対象にする

デフォルト構成（`src/hono.ts:30-32`）では `[RegExpRouter, TrieRouter]` の順で、RegExpRouter で対応不可なパターンがあれば TrieRouter にフォールバックする。`quick` プリセット（`src/preset/quick.ts:20-22`）では `[LinearRouter, TrieRouter]` で、`add()` の高速性を優先しつつ互換性を確保する。

### RegExpRouter の単一正規表現コンパイル

RegExpRouter は全ルートを Trie に挿入し、その Trie から単一の正規表現を構築する:

```typescript
// src/router/reg-exp-router/trie.ts:49-73
buildRegExp(): [RegExp, ReplacementMap, ReplacementMap] {
  let regexp = this.#root.buildRegExpStr()
  // ...
  regexp = regexp.replace(/#(\d+)|@(\d+)|\.\*\$/g, (_, handlerIndex, paramIndex) => {
    if (handlerIndex !== undefined) {
      indexReplacementMap[++captureIndex] = Number(handlerIndex)
      return '$()'  // 空キャプチャグループ（ハンドラインデックス特定用）
    }
    if (paramIndex !== undefined) {
      paramReplacementMap[Number(paramIndex)] = ++captureIndex
      return ''  // パラメータキャプチャグループ
    }
    return ''
  })
  return [new RegExp(`^${regexp}`), indexReplacementMap, paramReplacementMap]
}
```

マッチ時は空文字列のキャプチャグループ `$()` のインデックスでハンドラを特定する:

```typescript
// src/router/reg-exp-router/matcher.ts:22-28
const match = path.match(matcher[0])
if (!match) {
  return [[], emptyParam]
}
const index = match.indexOf('', 1)
return [matcher[1][index], match]
```

`match.indexOf('', 1)` はマッチした分岐の空キャプチャグループの位置を見つけ、その位置からハンドラ配列を引く。正規表現マッチ 1 回 + indexOf 1 回でルーティングが完了するため、ルート数に依存しない O(1) のマッチングを実現している。

### RegExpRouter の静的ルート最適化

RegExpRouter はパラメータを含まない静的ルートを正規表現とは別の `StaticMap` にも格納する:

```typescript
// src/router/reg-exp-router/router.ts:51-55
const staticMap: StaticMap<T> = Object.create(null)
for (let i = 0, j = -1, len = routesWithStaticPathFlag.length; i < len; i++) {
  const [pathErrorCheckOnly, path, handlers] = routesWithStaticPathFlag[i]
  if (pathErrorCheckOnly) {
    staticMap[path] = [handlers.map(([h]) => [h, Object.create(null)]), emptyParam]
  }
```

マッチング時は静的マップを先にチェックし、ヒットすれば正規表現を実行しない（`matcher.ts:17-19`）。多くの Web アプリケーションでは静的ルート（`/api/users`, `/health` 等）へのアクセスが大半を占めるため、この最適化は実効性が高い。

### UnsupportedPathError によるケイパビリティ交渉

各ルーターは自身が処理できないルートパターンに対して `UnsupportedPathError` を投げる。RegExpRouter は最も多くの制約を持つ:

```typescript
// src/router/reg-exp-router/node.ts:96-102
if (
  Object.keys(this.#children).some(
    (k) => k !== ONLY_WILDCARD_REG_EXP_STR && k !== TAIL_WILDCARD_REG_EXP_STR
  )
) {
  throw PATH_ERROR  // 同一ノードに異なるパターンの子が存在 → 非対応
}
```

この `PATH_ERROR` は `router.ts:64` で `UnsupportedPathError` に変換される。SmartRouter はこの例外を `catch` して次のルーターへフォールバックする。これは例外を「エラー」ではなく「ケイパビリティの不足」のシグナルとして使う設計であり、Strategy パターンの選択ロジックを簡潔に実現している。

### メソッド置換パターン（Self-Optimizing Method）

RegExpRouter と SmartRouter の両方で、初回実行後に `this.match` を別の関数に差し替えるパターンが使われている:

```typescript
// src/router/reg-exp-router/matcher.ts:10-32
export function match<R extends Router<T>, T>(this: R, method: string, path: string): Result<T> {
  const matchers: MatcherMap<T> = (this as any).buildAllMatchers()

  const match = ((method, path) => {
    const matcher = (matchers[method] || matchers[METHOD_NAME_ALL]) as Matcher<T>
    const staticMatch = matcher[2][path]
    if (staticMatch) { return staticMatch }
    const match = path.match(matcher[0])
    if (!match) { return [[], emptyParam] }
    const index = match.indexOf('', 1)
    return [matcher[1][index], match]
  }) as Router<T>['match']

  this.match = match  // 次回以降は buildAllMatchers() をスキップ
  return match(method, path)
}
```

この自己最適化パターンは、初期化コストを初回呼び出し時に遅延させつつ、2 回目以降のコールパスからは初期化分岐が完全に消える。通常の lazy initialization（フラグチェック）よりもオーバーヘッドが小さい。

## コード例

### Router インターフェース定義

```typescript
// src/router.ts:29-52
export interface Router<T> {
  name: string
  add(method: string, path: string, handler: T): void
  match(method: string, path: string): Result<T>
}
```

### デフォルトの SmartRouter 構成

```typescript
// src/hono.ts:28-32
this.router =
  options.router ??
  new SmartRouter({
    routers: [new RegExpRouter(), new TrieRouter()],
  })
```

### quick プリセットの構成

```typescript
// src/preset/quick.ts:20-22
this.router = new SmartRouter({
  routers: [new LinearRouter(), new TrieRouter()],
})
```

### 共通テストスイートの skip パターン

```typescript
// src/router/reg-exp-router/router.test.ts:7-24
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

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 複数のルーティングアルゴリズムをアプリケーションコードの変更なしに切り替える
  - 適用条件: 同一インターフェースで複数の実装が存在し、それぞれに異なる性能特性・制約がある
  - コード例: `src/router.ts:29-52`（Strategy インターフェース）、各 `router.ts`（Concrete Strategy）
  - 注意点: Hono ではコンストラクタで Strategy を注入する Constructor Injection 形式

- **Template Method パターンの変形** (分類: 振る舞い)
  - 解決する問題: RegExpRouter の `match()` は `buildAllMatchers()` を呼び出すが、この構築ロジックはサブクラス（PreparedRegExpRouter）でオーバーライド可能
  - 適用条件: アルゴリズムの骨格は共通だが、一部のステップだけ変えたい
  - コード例: `src/router/reg-exp-router/matcher.ts:12`（`buildAllMatchers` 呼び出し）、`src/router/reg-exp-router/prepared-router.ts:88-90`（オーバーライド）
  - 注意点: `protected` メソッドと `match` 関数を別ファイルに分離して再利用している

- **Composite / Chain of Responsibility の変形** (分類: 構造/振る舞い)
  - 解決する問題: 複数のルーターを優先順位付きで試行し、対応可能なルーターに処理を委譲
  - 適用条件: 処理対象の性質（ルートパターンの複雑さ）に応じて最適なハンドラを動的に選択したい
  - コード例: `src/router/smart-router/router.ts:32-49`
  - 注意点: `UnsupportedPathError` を Chain of Responsibility の「次に回す」シグナルとして利用

## Good Patterns

- **最小インターフェースによる交換可能性の確保**: `Router<T>` は `add` と `match` の 2 メソッドのみ。ルーティングに必要な最小限の契約だけを定義することで、内部実装のアルゴリズムが大きく異なる 5 種のルーターが同一インターフェースを実装できる。

```typescript
// src/router.ts:29-52
export interface Router<T> {
  name: string
  add(method: string, path: string, handler: T): void
  match(method: string, path: string): Result<T>
}
```

- **Self-Optimizing Method（メソッド自己置換）**: 初回実行時にデータ構造を構築し、`this.match` を最適化された関数に差し替える。lazy initialization のフラグチェックすら不要にするゼロコスト抽象。

```typescript
// src/router/reg-exp-router/matcher.ts:31
this.match = match  // 2回目以降は構築をスキップする最適化された関数

// src/router/smart-router/router.ts:46
this.match = router.match.bind(router)  // 選択されたルーターに直接委譲
```

- **共通テストスイート + skip 宣言による互換性管理**: 全ルーターが同一テストスイートを共有し、非対応ケースを理由付きで `skip` 配列に宣言する。新しいルーターの追加時に互換性の差分が即座に可視化される。

```typescript
// src/router/trie-router/router.test.ts:4-7
describe('TrieRouter', () => {
  runTest({
    newRouter: () => new TrieRouter(),  // skip なし = 全テスト通過
  })
})
```

- **例外を「ケイパビリティ不足」シグナルとして活用**: `UnsupportedPathError` はランタイムエラーではなく、ルーターの機能境界を示すシグナル。SmartRouter はこれを `catch` してフォールバックする。通常の例外処理とは異なる、型安全な能力交渉メカニズム。

```typescript
// src/router/smart-router/router.ts:39-42
} catch (e) {
  if (e instanceof UnsupportedPathError) {
    continue  // 次のルーターを試す
  }
  throw e  // 本当のエラーは再throw
}
```

## Anti-Patterns / 注意点

- **メソッド置換の追跡困難性**: `this.match = router.match.bind(router)` によるメソッド差し替えは、デバッグ時に「現在どの関数が実行されているか」が分かりにくい。スタックトレースに元の関数名が出ない可能性がある。

```typescript
// Bad: デバッガでの追跡が困難
this.match = router.match.bind(router)

// Better: ラッパーを残して可視性を確保（ただしオーバーヘッドあり）
this.match = (method, path) => router.match(method, path)
// Hono はパフォーマンスを優先して Bad 側を選択しており、その判断は妥当
```

- **`as any` による型安全性の回避**: `matcher.ts:12` で `(this as any).buildAllMatchers()` を使用。`match` 関数が `Router<T>` 型の `this` を受け取るが、`buildAllMatchers` は `RegExpRouter` 固有メソッドであるため型が合わない。

```typescript
// Bad: 型安全性を破壊
const matchers: MatcherMap<T> = (this as any).buildAllMatchers()

// Better: match 関数を RegExpRouter のメソッドとして定義するか、
// buildAllMatchers を持つインターフェースを定義する
interface MatcherBuilder<T> {
  buildAllMatchers(): MatcherMap<T>
}
// Hono ではコード共有（RegExpRouter と PreparedRegExpRouter）のためにこの形式を採用
```

## 導出ルール

- `[MUST]` Strategy パターンで複数実装を切り替える場合、全実装が共有するテストスイートを用意し、非対応ケースは理由付きで明示的にスキップする
  - 根拠: Hono は `common.case.test.ts` で 5 種ルーターの行動互換を保証し、各ルーターの `skip` 配列で非対応パターンを可視化している（`src/router/reg-exp-router/router.test.ts:8-24`）

- `[MUST]` Strategy インターフェースは実装アルゴリズムに依存しない最小限のメソッドで構成する
  - 根拠: `Router<T>` は `add` と `match` の 2 メソッドのみで、Trie ベース・正規表現ベース・線形走査ベースの全アルゴリズムが実装可能（`src/router.ts:29-52`）

- `[SHOULD]` パフォーマンス最適化が適用不可能なケースでは、例外（ケイパビリティエラー）を使って「非対応」を通知し、フォールバック先に処理を委譲する
  - 根拠: SmartRouter は `UnsupportedPathError` を catch して RegExpRouter から TrieRouter へフォールバックし、ユーザーに制約を意識させない（`src/router/smart-router/router.ts:39-42`）

- `[SHOULD]` 初期化コストが高い処理は初回呼び出し時に遅延実行し、メソッド自己置換で 2 回目以降のオーバーヘッドを排除する
  - 根拠: RegExpRouter の `match` 関数は初回で正規表現をコンパイル後に `this.match` を差し替え、2 回目以降はコンパイル判定が不要（`src/router/reg-exp-router/matcher.ts:10-32`）

- `[SHOULD]` マッチング結果のデータ表現を union 型で柔軟にし、高速な実装が最適なメモリレイアウトを使えるようにする
  - 根拠: `Result<T>` は ParamIndexMap + ParamStash 形式と Params 形式の union で、RegExpRouter は正規表現の match 結果をそのまま stash として流用できる（`src/router.ts:98`）

- `[AVOID]` 最速のアルゴリズムだけを提供してエッジケースを「非サポート」として放置する設計
  - 根拠: RegExpRouter 単体では同一セグメントの異なるラベル名等を処理できないが、SmartRouter + TrieRouter のフォールバックで全パターンをカバーしている（`src/hono.ts:30-32`）

## 適用チェックリスト

- [ ] 複数の実装戦略（アルゴリズム、バックエンド等）を切り替える必要がある箇所で、最小限の Strategy インターフェースを定義しているか
- [ ] Strategy の各実装に対して共通テストスイートを用意し、非対応ケースを skip 配列等で明示的に管理しているか
- [ ] 高速だが制約のある実装と、低速だが汎用的な実装をフォールバック構成で組み合わせているか（ユーザーに制約を意識させない設計）
- [ ] 初期化コストの高い処理を遅延実行し、ホットパスに不要な分岐を残していないか
- [ ] 「対応不可」を通知する専用の例外型を定義し、通常のエラーと区別して扱っているか
- [ ] インターフェースの戻り値型が、各実装の最適なデータ表現を許容する柔軟性を持っているか
