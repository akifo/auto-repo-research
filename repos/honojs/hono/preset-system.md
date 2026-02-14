# preset-system

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono は単一の `HonoBase` 抽象基盤クラスの上に、ルーター構成だけを差し替えた複数のプリセット（`Hono`, `Hono/tiny`, `Hono/quick`）を提供している。各プリセットは独立した `package.json` exports エントリポイントを持ち、使わないルーターのコードがバンドルに含まれない tree-shaking 設計を実現している。この「基盤は共通、戦略だけ差し替え」のアーキテクチャは、バンドルサイズ・ルーティング性能・機能網羅性のトレードオフをユーザーに委ねるライブラリ設計の好例である。

## 設計思想

- **ルーターは戦略であり、フレームワークのコアではない**: HonoBase はルーティングアルゴリズムを一切知らない。`Router<T>` インターフェースに依存し、コンストラクタで注入されたルーターに委譲するだけである（`src/hono-base.ts:118`, `src/hono-base.ts:413`）。これによりルーターの追加・差し替えがフレームワーク本体に影響しない。

- **デフォルトは最強、選択肢は軽量**: デフォルトの `Hono` クラスは SmartRouter + RegExpRouter + TrieRouter という最も機能が充実した構成を採用する（`src/hono.ts:28-32`）。一方、`hono/tiny` は PatternRouter のみ（`src/preset/tiny.ts:18`）、`hono/quick` は SmartRouter + LinearRouter + TrieRouter（`src/preset/quick.ts:20-22`）と、それぞれ特化した軽量構成を提供する。ユーザーが明示的に選ばない限り、最も安全な選択が自動適用される。

- **遅延決定による性能最適化**: SmartRouter は初回の `match()` 呼び出し時に、配下ルーターを順に試し、成功したルーターに `this.match` を差し替える（`src/router/smart-router/router.ts:46`）。RegExpRouter も初回 `match()` 時に正規表現をビルドし、以降は `this.match` をビルド済み関数で上書きする（`src/router/reg-exp-router/matcher.ts:31`）。起動時コストを実行時の最初のリクエストまで先送りする設計。

- **エントリポイント分離による tree-shaking 保証**: 各プリセットは `package.json` の `exports` フィールドで独立したエントリポイントを持つ（`"./tiny"`, `"./quick"`）。`import { Hono } from 'hono/tiny'` と書くと `src/preset/tiny.ts` だけが解決され、RegExpRouter や SmartRouter のコードはバンドラーの tree-shaking によって除外される。

## 設計・実装の詳細

### プリセット構成の比較

| プリセット | import パス | ルーター構成 | 特徴 |
|---|---|---|---|
| Hono (デフォルト) | `hono` | SmartRouter(RegExpRouter, TrieRouter) | 最高性能、全パスパターン対応 |
| Quick | `hono/quick` | SmartRouter(LinearRouter, TrieRouter) | 起動が速い、短寿命向け |
| Tiny | `hono/tiny` | PatternRouter のみ | 最小バンドル、単純ルート向け |

### HonoBase: ルーターに依存しない基盤設計

`HonoBase`（`src/hono-base.ts`）は `class Hono` として定義されているが、コンストラクタ内でルーターを生成しない。`router` プロパティは `!` アサーション付きで宣言されており（`src/hono-base.ts:118`）、サブクラスのコンストラクタで設定される前提の設計である。

```typescript
// src/hono-base.ts:116-118
/*
  This class is like an abstract class and does not have a router.
  To use it, inherit the class and implement router in the constructor.
*/
router!: Router<[H, RouterRoute]>
```

この設計により、HonoBase のコードはどのルーター実装にも import 依存を持たない。TypeScript では `abstract class` を使う方法もあるが、HonoBase は敢えて通常クラスにしている。これは `export { Hono as HonoBase }` のエイリアスから推測するに、型の互換性とプリセット間の差し替え容易性を優先した判断と思われる（推測）。

### SmartRouter: 自己書き換えによるルーター選択

SmartRouter は初回 `match()` 時に、コンストラクタで受け取った候補ルーターを順に試す。各ルーターに全ルートを `add()` し、`match()` を試み、`UnsupportedPathError` がスローされたら次のルーターにフォールバックする。

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

  this.match = router.match.bind(router)
  this.#routers = [router]
  this.#routes = undefined
  break
}
```

注目すべきは `this.match = router.match.bind(router)`（46行目）で、SmartRouter 自身の `match` メソッドを選択されたルーターの `match` で上書きしている。2回目以降の `match()` 呼び出しでは SmartRouter のルーター選択ロジックは完全にバイパスされ、選択済みルーターが直接呼ばれる。`this.#routes = undefined` で蓄積したルート情報もGC対象にしている。

### RegExpRouter: 二段階の遅延コンパイル

RegExpRouter の `match` プロパティは `matcher.ts` の `match` 関数で初期化されている（`src/router/reg-exp-router/router.ts:206`）。この関数は初回呼び出し時に `this.buildAllMatchers()` で全ルートを単一の正規表現にコンパイルし、コンパイル結果を使うクロージャで `this.match` を上書きする。

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

  this.match = match
  return match(method, path)
}
```

SmartRouter と RegExpRouter の二段階で自己書き換えが起こる。デフォルトプリセットでは: (1) 初回リクエストで SmartRouter が RegExpRouter を選択し `match` を差し替え → (2) RegExpRouter の `match` が正規表現をビルドし、ビルド済みの高速 `match` で自身を差し替え。

### UnsupportedPathError: ルーター間の能力差の表現

各ルーターは対応できないパスパターンに遭遇すると `UnsupportedPathError` をスローする。これが SmartRouter のフォールバック機構を駆動する。

- `RegExpRouter`: 特定の正規表現パターンの組み合わせで Trie 構築に失敗した場合（`src/router/reg-exp-router/router.ts:64`）
- `LinearRouter`: ラベル付きパラメータとワイルドカードの同時使用（`src/router/linear-router/router.ts:137`）
- `PatternRouter`: 無効な正規表現パターン（`src/router/pattern-router/router.ts:40`）

### package.json exports による依存グラフの分離

```jsonc
// package.json (抜粋)
{
  "exports": {
    ".": { "import": "./dist/index.js" },        // SmartRouter + RegExpRouter + TrieRouter
    "./tiny": { "import": "./dist/preset/tiny.js" },  // PatternRouter のみ
    "./quick": { "import": "./dist/preset/quick.js" }, // SmartRouter + LinearRouter + TrieRouter
    "./hono-base": { "import": "./dist/hono-base.js" } // 基盤のみ（ルーターなし）
  }
}
```

`hono/tiny` をインポートすると、依存グラフは `preset/tiny.ts` → `hono-base.ts` + `pattern-router/router.ts` のみで完結する。RegExpRouter（Trie, Node, Matcher を含む複数ファイル構成）や SmartRouter のコードは一切読み込まれない。esbuild によるビルド（`build/build.ts`）では各 `.ts` ファイルが独立した `.js` にトランスパイルされるため、バンドラー側の tree-shaking が確実に機能する。

### ルーターの性能特性

各ルーターのマッチングアルゴリズムは根本的に異なる:

- **RegExpRouter**: 全ルートを単一の正規表現にコンパイル。マッチングは O(1) に近い（正規表現エンジン依存）。静的パスはハッシュマップ参照。初期ビルドコストが高い。
- **TrieRouter**: Trie 木による前方一致。すべてのパスパターンに対応可能なフォールバック用。
- **LinearRouter**: ルートを登録順に線形探索。マッチングは O(n) だが、`add()` が O(1) で起動が最速。Cloudflare Workers のような短寿命環境向け。
- **PatternRouter**: 各ルートを個別の正規表現に変換し線形探索。最小実装だが O(n) マッチング。

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: ルーティングアルゴリズムをフレームワーク本体から分離し、交換可能にする
  - 適用条件: アルゴリズムの選択がユーザーの環境・要件に依存する場合
  - コード例: `src/router.ts:29-52`（`Router<T>` インターフェース）、`src/hono-base.ts:118`（Context が Strategy を保持）
  - 注意点: Hono では GoF の Strategy と異なり、コンストラクタでの注入ではなくクラス継承で Strategy を固定している。これはプリセットという「推奨構成」を型安全に提供するため。

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: リクエスト処理の骨格（dispatch）は共通化しつつ、ルーティング部分だけをサブクラスに委ねる
  - 適用条件: 処理フローの大部分が共通で、一部ステップだけが変動する場合
  - コード例: `src/hono-base.ts:400-460`（`#dispatch` が骨格、`this.router.match` が可変ステップ）
  - 注意点: TypeScript の `abstract` を使わず `!` アサーションで実現。ランタイムの保護がないため、ルーター未設定での使用はエラーになる。

- **Self-Modifying Method パターン** (分類: パフォーマンス最適化、既知パターン外)
  - 解決する問題: 初回のみ必要な処理（ルーター選択、正規表現コンパイル）を後続呼び出しから排除する
  - 適用条件: 高頻度呼び出しメソッドの初回にのみ重いセットアップが必要な場合
  - コード例: `src/router/smart-router/router.ts:46`、`src/router/reg-exp-router/matcher.ts:31`
  - 注意点: メソッドの上書きはデバッグを困難にする。呼び出しのたびに異なる関数が実行されるため、プロファイリング時に注意が必要。

## Good Patterns

- **プリセットによる段階的構成の提供**: ユーザーに「デフォルト / 高速起動 / 最小バンドル」の3択を提供し、import パスを変えるだけで切り替えられる設計。各プリセットは十数行のクラスで、コンストラクタにルーター構成を書くだけ。

```typescript
// src/preset/tiny.ts:11-20 (全体で20行)
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

- **UnsupportedPathError による graceful degradation**: ルーターが対応できないパスパターンをエラーとしてではなく、フォールバックの契機として使用。SmartRouter は `catch (e) { if (e instanceof UnsupportedPathError) continue }` で次候補に切り替える（`src/router/smart-router/router.ts:39-43`）。

- **exports フィールドによる物理的なコード分離**: 論理的なモジュール分割だけでなく、`package.json` の `exports` で物理的なエントリポイントを分離。`hono/tiny` が `hono` のルーターコードを含まないことを、インフラレベルで保証している。

## Anti-Patterns / 注意点

- **プリセットの暗黙的なルーター制限を見落とす**: `hono/tiny` で `PatternRouter` が `UnsupportedPathError` をスローするパスパターン（特定の正規表現構文）を使うと、SmartRouter によるフォールバックがないためランタイムエラーになる。Tiny プリセットには SmartRouter が含まれないため。

```typescript
// Bad: tiny プリセットで複雑なパスパターンを使う
import { Hono } from 'hono/tiny'
const app = new Hono()
app.get('/user/:id{[0-9]+}', handler)  // PatternRouter でも動くが、
// 非対応パターンに遭遇するとフォールバックなしでクラッシュ

// Better: 複雑なルーティングが必要ならデフォルトプリセットを使う
import { Hono } from 'hono'
const app = new Hono()
app.get('/user/:id{[0-9]+}', handler)  // SmartRouter が適切なルーターを自動選択
```

- **自己書き換えメソッドのデバッグ困難性**: SmartRouter と RegExpRouter の `match` メソッドは初回呼び出し後に別の関数に差し替わる。ブレークポイントを SmartRouter の `match` に設定しても、2回目以降のリクエストではヒットしない。パフォーマンス上の利点は大きいが、問題調査時に混乱を招く可能性がある。

## 導出ルール

- `[MUST]` ライブラリのコアとアルゴリズムは interface で分離し、コアがアルゴリズムの具象クラスを直接 import しない構造にする
  - 根拠: HonoBase は `Router<T>` インターフェースにのみ依存し、5種類のルーター実装を一切 import していない（`src/hono-base.ts:10`）。これにより tree-shaking とプリセット分離が成立している。

- `[MUST]` 複数の構成プリセットを提供する場合、各プリセットを独立した `package.json` exports エントリポイントとして公開し、使用しないコードがバンドルに含まれないことを物理的に保証する
  - 根拠: `"./tiny"`, `"./quick"` の各エントリポイントが独立した依存グラフを形成し、バンドラーに頼らず未使用ルーターの除外を保証している（`package.json:58-67`）。

- `[SHOULD]` デフォルト構成は最も安全で高機能なものにし、軽量構成は明示的なオプトインとする
  - 根拠: `import { Hono } from 'hono'` は SmartRouter + RegExpRouter + TrieRouter の最も堅牢な構成。Tiny/Quick は明示的に `hono/tiny`, `hono/quick` と書かないと選択されない（`src/hono.ts:27-33`）。

- `[SHOULD]` 高頻度呼び出しメソッドの初回セットアップは遅延実行とし、メソッド自体をビルド済み関数で差し替えて後続呼び出しのオーバーヘッドを排除する
  - 根拠: SmartRouter のルーター選択（`src/router/smart-router/router.ts:46`）と RegExpRouter の正規表現コンパイル（`src/router/reg-exp-router/matcher.ts:31`）が初回のみ実行され、以降は差し替え後の高速パスが使われる。

- `[SHOULD]` アルゴリズム実装が対応できない入力には専用のエラー型（例: `UnsupportedPathError`）を定義し、上位レイヤーがフォールバック判断に利用できるようにする
  - 根拠: SmartRouter は `UnsupportedPathError` を catch して次のルーターに切り替える。通常の `Error` では意図的な「非対応」と予期せぬ「バグ」を区別できない（`src/router/smart-router/router.ts:39-43`）。

- `[AVOID]` 軽量プリセットに SmartRouter（フォールバック機構）なしのルーターを組み込む場合、対応パスパターンの制約をドキュメントで明示しないまま公開すること
  - 根拠: `hono/tiny` は PatternRouter 単体であり、非対応パターンで `UnsupportedPathError` が直接ユーザーに到達する。SmartRouter のようなフォールバック層がないため、制約の明示が必要（`src/preset/tiny.ts:18`）。

## 適用チェックリスト

- [ ] ライブラリのコアロジックと交換可能なアルゴリズム部分を interface で分離しているか
- [ ] 複数のビルド構成（フル / 軽量 / 最小）がある場合、`package.json` exports で独立したエントリポイントを定義しているか
- [ ] デフォルトの構成が「最も安全で機能が充実したもの」になっているか（軽量構成がデフォルトになっていないか）
- [ ] 初回のみ必要な重いセットアップ処理を、遅延実行や自己書き換えで後続呼び出しから排除しているか
- [ ] アルゴリズムの「非対応」と「バグ」を区別するための専用エラー型を定義しているか
- [ ] 軽量プリセットの機能制限・対応範囲をドキュメントに明記しているか
- [ ] 各エントリポイントからの依存グラフが意図通りに分離されているか（バンドルサイズの測定で検証）
