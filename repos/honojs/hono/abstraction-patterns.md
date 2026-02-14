# 抽象化パターン

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Web フレームワーク Hono のコードベースにおけるインターフェース設計、責務分離、拡張ポイント設計を横断的に分析した。このリポジトリは「Web Standards の上に構築された軽量フレームワーク」でありながら、9 つのランタイム・5 つのルーター実装・25 以上のミドルウェアを統一的に扱う高い抽象力を持つ。注目に値するのは、抽象化の多くが TypeScript の型システムに深く依存しており、ランタイムコストをほぼゼロに保ちながら開発者体験（型安全性・自動補完）を最大化している点である。

## 背景にある原則

- **薄いインターフェース原則**: インターフェースのメソッド数を最小限（2-3 個）にし、実装の自由度を最大化する。`Router<T>` は `add` と `match` のたった 2 メソッドであり、この薄さが 5 種類の異なるアルゴリズム（トライ木、正規表現、線形探索、パターン、スマート選択）による実装を可能にしている（`src/router.ts:29-52`）。
- **注入による抽象と実装の分離**: プラットフォーム固有の振る舞いをインターフェースで抽象し、コールバック関数として注入することで、コアロジックをランタイム非依存にする。`serveStatic` ミドルウェアは `getContent`・`join`・`isDir` を注入パラメータとして受け取り、Bun/Deno/Cloudflare Workers がそれぞれの実装を渡す（`src/middleware/serve-static/index.ts:34-47`）。
- **型レベルの状態蓄積**: ミドルウェアチェーンで追加される環境変数やスキーマ情報を TypeScript の型パラメータとして蓄積し、チェーン全体を通じた型安全性を実現する。`IntersectNonAnyTypes` によるミドルウェア型の合成（`src/types.ts:2474`）と `ToSchema` による API スキーマの蓄積（`src/types.ts:2211`）がこれを支える。
- **遅延決定とフォールバック**: 実行時に最適な戦略を自動選択し、失敗した場合はより汎用的な戦略にフォールバックする。SmartRouter は初回マッチ時にルート定義を各ルーターに試し、成功したルーターに以降のマッチを委譲する（`src/router/smart-router/router.ts:32-49`）。

## 実例と分析

### 1. Router インターフェースと Strategy パターン

5 つのルーター実装はすべて同一の `Router<T>` インターフェースを実装する。

```typescript
// src/router.ts:29-52
export interface Router<T> {
  name: string
  add(method: string, path: string, handler: T): void
  match(method: string, path: string): Result<T>
}
```

各実装の特性:
- **RegExpRouter**: 全ルートを単一正規表現にコンパイル。高速だが一部パスパターンを非サポート
- **TrieRouter**: トライ木ベース。全パスパターン対応だが RegExpRouter より低速
- **LinearRouter**: 配列の線形探索。ルート追加が最速（SSR/SSG 向き）
- **PatternRouter**: 最小サイズ（60 行）。機能限定だがバンドルサイズ最小
- **SmartRouter**: メタルーター。初回マッチで最適なルーターを自動選択

重要な設計判断として、サポートできないパスパターンに遭遇したルーターは `UnsupportedPathError` を投げることで「できないこと」を表明し、SmartRouter がフォールバック先を探す仕組みになっている。

### 2. HonoBase とプリセットによる構成の分離

`HonoBase` はルーターを持たない「抽象クラス的」な基底クラスであり、コメントで明示的にそう宣言している:

```typescript
// src/hono-base.ts:114-118
/*
  This class is like an abstract class and does not have a router.
  To use it, inherit the class and implement router in the constructor.
*/
router!: Router<[H, RouterRoute]>
```

プリセットは `HonoBase` を継承し、コンストラクタでルーター組み合わせを固定する:

```typescript
// src/hono.ts:20-33 (デフォルト)
export class Hono<...> extends HonoBase<E, S, BasePath> {
  constructor(options: HonoOptions<E> = {}) {
    super(options)
    this.router =
      options.router ??
      new SmartRouter({
        routers: [new RegExpRouter(), new TrieRouter()],
      })
  }
}

// src/preset/tiny.ts:15-20 (軽量プリセット)
export class Hono<...> extends HonoBase<E, S, BasePath> {
  constructor(options: HonoOptions<E> = {}) {
    super(options)
    this.router = new PatternRouter()
  }
}
```

この設計により、同一のコアロジック（ルーティング・ミドルウェア実行・エラーハンドリング）を共有しつつ、ユースケースに応じたルーター構成を提供する。

### 3. Adapter パターンによるランタイム抽象

ランタイム固有の機能（静的ファイル配信、WebSocket、接続情報取得）は、共通インターフェースを定義し、各アダプタが実装を提供する構造を取る。

**ConnInfo の例**: 型 `GetConnInfo = (c: Context) => ConnInfo` を定義し、各ランタイムが実装:

```typescript
// src/adapter/cloudflare-workers/conninfo.ts:3-7
export const getConnInfo: GetConnInfo = (c) => ({
  remote: {
    address: c.req.header('cf-connecting-ip'),
  },
})

// src/adapter/deno/conninfo.ts:8-16
export const getConnInfo: GetConnInfo = (c) => {
  const { remoteAddr } = c.env
  return {
    remote: {
      address: remoteAddr.hostname,
      port: remoteAddr.port,
      transport: remoteAddr.transport,
    },
  }
}
```

**ServeStatic の例**: コアミドルウェアは `getContent`・`join`・`isDir` の 3 つのコールバックを受け取り、プラットフォーム非依存なロジック（パストラバーサル防止、MIME タイプ判定、事前圧縮対応）を実装する。各アダプタはこれらのコールバックをプラットフォーム固有の API で埋める:

```typescript
// src/adapter/bun/serve-static.ts:11-31
return async function serveStatic(c, next) {
  const getContent = async (path: string) => {
    const file = Bun.file(path)
    return (await file.exists()) ? file : null
  }
  const isDir = async (path: string) => {
    const stats = await stat(path)
    return stats.isDirectory()
  }
  return baseServeStatic({ ...options, getContent, join, isDir })(c, next)
}
```

### 4. defineWebSocketHelper によるアダプタ生成の抽象化

WebSocket サポートでは `defineWebSocketHelper` というファクトリ関数を提供し、各ランタイムのアダプタ作成を定型化する:

```typescript
// src/helper/websocket/index.ts:111-113
export const defineWebSocketHelper = <T = unknown, U = any>(
  handler: WebSocketHelperDefineHandler<T, U>
): UpgradeWebSocket<T, U> => { ... }
```

各アダプタはこの関数にランタイム固有のハンドラを渡すだけでよい:

```typescript
// src/adapter/cloudflare-workers/websocket.ts:10
export const upgradeWebSocket: UpgradeWebSocket<WebSocket, any, ...> =
  defineWebSocketHelper(async (c, events) => { /* CF Workers 固有の実装 */ })
```

### 5. ContextVariableMap による Declaration Merging 拡張

ミドルウェアが追加するコンテキスト変数の型を、TypeScript の Declaration Merging で拡張可能にしている:

```typescript
// src/context.ts:52
export interface ContextVariableMap {}

// src/middleware/jwt/index.ts:7-9
declare module '../..' {
  interface ContextVariableMap extends JwtVariables {}
}
```

これにより、JWT ミドルウェアをインポートした時点で `c.get('jwtPayload')` の型が自動的に利用可能になる。

## コード例

```typescript
// src/router/smart-router/router.ts:21-49
// SmartRouter の遅延決定パターン。初回 match 時に最適なルーターを選択し、
// 以降のマッチを直接委譲する（this.match を上書き）
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
        continue
      }
      throw e
    }
    this.match = router.match.bind(router)  // メソッド上書きによる最適化
    this.#routers = [router]
    this.#routes = undefined
    break
  }
  return res as Result<T>
}
```

```typescript
// src/hono-base.ts:423-427
// ハンドラが1つだけの場合は compose をスキップする最適化
if (matchResult[0].length === 1) {
  let res: ReturnType<H>
  try {
    res = matchResult[0][0][0][0](c, async () => {
      c.res = await this.#notFoundHandler(c)
    })
  } catch (err) {
    return this.#handleError(err, c)
  }
  // ...
}
```

```typescript
// src/types.ts:2473-2476
// ミドルウェアチェーンの型を合成するユーティリティ型
type ProcessHead<T> = IfAnyThenEmptyObject<T extends Env ? (Env extends T ? {} : T) : T>
export type IntersectNonAnyTypes<T extends any[]> = T extends [infer Head, ...infer Rest]
  ? ProcessHead<Head> & IntersectNonAnyTypes<Rest>
  : {}
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 同一のルーティングタスクに対し、異なるアルゴリズム（正規表現、トライ木、線形探索等）を交換可能にする
  - 適用条件: 同一インターフェースで複数の実装戦略があり、ユースケースによって最適解が異なる場合
  - コード例: `src/router.ts:29-52` (Router interface), `src/router/reg-exp-router/router.ts`, `src/router/trie-router/router.ts`
  - 注意点: SmartRouter がメタ Strategy として機能し、実行時に最適な Strategy を自動選択する独自の変形

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: ミドルウェアの共通アルゴリズム骨格を固定し、ランタイム固有の処理のみを差し替え可能にする
  - 適用条件: アルゴリズムの骨格は共通だが、一部のステップがプラットフォームによって異なる場合
  - コード例: `src/middleware/serve-static/index.ts:34-47` (getContent/join/isDir をコールバックで注入)
  - 注意点: 古典的な継承ベースではなく、コールバック注入による関数型の Template Method として実現

- **Composite パターン** (分類: 構造)
  - 解決する問題: 個別のミドルウェアと合成ミドルウェア（some/every/except）を同一の `MiddlewareHandler` 型で扱う
  - 適用条件: 個別要素と複合要素を同一インターフェースで扱いたい場合
  - コード例: `src/middleware/combine/index.ts:38-69` (some), `src/middleware/combine/index.ts:99-117` (every)
  - 注意点: `MiddlewareHandler` と `Condition` のユニオン型を受け入れることで、条件分岐もミドルウェア合成に組み込める

- **Factory Method パターン** (分類: 生成)
  - 解決する問題: アプリケーションインスタンスとミドルウェアの生成を統一的な API で提供する
  - 適用条件: 生成時に共通の初期化処理（initApp）を適用したい場合
  - コード例: `src/helper/factory/index.ts:332-366` (Factory クラスと createFactory/createMiddleware)

## Good Patterns

- **2 メソッドインターフェース**: `Router<T>` は `add` と `match` の 2 メソッドのみ。この最小さが 5 種類のルーター実装を可能にし、利用者も独自ルーターを容易に実装できる。

```typescript
// src/router.ts:29-52
export interface Router<T> {
  name: string
  add(method: string, path: string, handler: T): void
  match(method: string, path: string): Result<T>
}
```

- **メソッド上書きによるワンショット最適化**: SmartRouter は初回マッチ後に `this.match` を選択されたルーターのメソッドで上書きし、以降のオーバーヘッドをゼロにする。

```typescript
// src/router/smart-router/router.ts:46
this.match = router.match.bind(router)
```

- **Object.create(null) の一貫使用**: パラメータマップやキャッシュなどの辞書オブジェクトに `Object.create(null)` を一貫して使用し、プロトタイプチェーンの不要な探索を回避する。コードベース全体で 20 箇所以上。

```typescript
// src/router/linear-router/router.ts:7
const emptyParams = Object.create(null)
// src/router/reg-exp-router/router.ts:19
let wildcardRegExpCache: Record<string, RegExp> = Object.create(null)
```

- **エラー型による能力宣言**: `UnsupportedPathError` を専用のエラー型として定義し、ルーターが「サポートできないパスパターン」を構造的に表明できるようにしている。これにより SmartRouter のフォールバックロジックが `instanceof` で安全に分岐できる。

```typescript
// src/router.ts:103
export class UnsupportedPathError extends Error {}
```

## Anti-Patterns / 注意点

- **型のためのオーバーロード爆発**: `HandlerInterface` や `CreateHandlersInterface` は、ハンドラ数ごとに型オーバーロードが定義されており（1 個から 10 個まで）、型定義が数百行に及ぶ。型安全性とのトレードオフだが、メンテナンスコストが高い。

```typescript
// Bad: src/types.ts:128-... (HandlerInterface のオーバーロードが 100+ 行)
// app.get(handler) のシグネチャ
// app.get(handler x2) のシグネチャ
// app.get(handler x3) のシグネチャ
// ... x10 まで続く

// Better: TypeScript 5.x 以降では可変長タプル型や条件付き型の改善により、
// 再帰的な型定義で同等の型安全性を実現できる可能性がある
```

- **抽象クラスの代わりにコメントと非初期化プロパティ**: `HonoBase` は TypeScript の `abstract class` を使わず、コメントと `!` (definite assignment assertion) で「サブクラスで初期化すること」を表現している。これはランタイムでの `abstract` チェック回避のためだが、コンパイル時の安全性が低下する。

```typescript
// Bad: src/hono-base.ts:114-118
/*
  This class is like an abstract class and does not have a router.
  To use it, inherit the class and implement router in the constructor.
*/
router!: Router<[H, RouterRoute]>

// Better: abstract class + abstract router プロパティ
// （ただしバンドルサイズ・ランタイムコストとのトレードオフが存在する）
```

## 導出ルール

- `[MUST]` インターフェースのメソッド数は 3 個以下に抑え、各実装が独自の内部戦略を持てる自由度を確保する
  - 根拠: `Router<T>` は `add`/`match` の 2 メソッドで 5 種類の実装を支え、SmartRouter による自動選択まで可能にしている（`src/router.ts:29-52`）
- `[MUST]` プラットフォーム固有の処理はコールバック関数として注入し、共通ロジックをランタイム非依存に保つ
  - 根拠: `serveStatic` は `getContent`/`join`/`isDir` の注入により、コア 125 行を 9 ランタイムで共有している（`src/middleware/serve-static/index.ts:34-47`）
- `[SHOULD]` 辞書用途のオブジェクトには `Object.create(null)` を使い、プロトタイプチェーンの意図しない参照を防ぐ
  - 根拠: Hono は全ルーター実装のパラメータマップ・キャッシュで一貫してこのパターンを使用し、`hasOwnProperty` チェック不要でキー探索が安全かつ高速になっている（`src/router/` 配下で 20 箇所以上）
- `[SHOULD]` 複数の戦略を持つ場合、実行時に最適な戦略を自動選択するメタ戦略層を設け、初回決定後はメソッド上書き等でオーバーヘッドを除去する
  - 根拠: SmartRouter は初回 `match` で最適ルーターを選択後、`this.match = router.match.bind(router)` で以降のディスパッチコストをゼロにする（`src/router/smart-router/router.ts:46`）
- `[SHOULD]` TypeScript の Declaration Merging（`declare module` + `interface`）を使い、プラグイン/ミドルウェアが型定義を自動拡張できる拡張ポイントを設計する
  - 根拠: `ContextVariableMap` に対する `declare module` で、JWT・RequestID 等のミドルウェアがインポートだけで型を拡張する（`src/middleware/jwt/index.ts:7-9`）
- `[SHOULD]` 「できないこと」を専用のエラー型で表明し、呼び出し側が `instanceof` で構造的にフォールバックできるようにする
  - 根拠: `UnsupportedPathError` により SmartRouter は各ルーターの能力境界を安全に判定し、フォールバック先を選択する（`src/router.ts:103`, `src/router/smart-router/router.ts:40-43`）
- `[AVOID]` インターフェースの実装数が 1 つしか存在しない段階でインターフェースを切り出す（YAGNI 違反）
  - 根拠: Hono の `Router<T>` は 5 実装、`GetConnInfo` は 5 実装と、実際に複数の具象が存在する場合にのみインターフェースを導入している

## 適用チェックリスト

- [ ] プロジェクト内でインターフェースのメソッド数が 5 個を超えるものがないか確認し、分割を検討する
- [ ] プラットフォーム固有の処理がコアロジックに直接埋め込まれていないか確認し、コールバック注入に置き換える
- [ ] 辞書用途の `{}` リテラルを `Object.create(null)` に置き換え、プロトタイプ汚染リスクを排除する
- [ ] 複数の戦略（アルゴリズム、バックエンド等）を持つ場合、共通インターフェースで Strategy パターンを適用し、切り替え可能にする
- [ ] 実行時に最適な戦略を選択できるメタ戦略層（SmartRouter 相当）の必要性を検討する
- [ ] プラグイン・ミドルウェアが型を拡張できる拡張ポイント（空 interface + Declaration Merging）を設計する
- [ ] 「できないこと」を表明する専用エラー型を定義し、フォールバック制御に活用する
- [ ] 型オーバーロードが 5 個を超える場合、可変長タプル型や条件付き型での代替を検討する
