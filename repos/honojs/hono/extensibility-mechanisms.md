# Extensibility Mechanisms

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

プリセット・ファクトリ・ミドルウェア・ルーター差し替えなど、Hono が提供する多層的な拡張メカニズムを横断的に分析した。注目すべきは、フレームワーク本体を「抽象基底クラス + 差し込み可能なコンポーネント」として設計し、プリセットやアダプタが継承ではなく合成で機能を提供する点にある。25 種の組み込みミドルウェアはすべて同一のシグネチャ `(c, next) => Promise<Response | void>` に従い、ファクトリ関数パターンでオプションを閉じ込める一貫した設計が、個別拡張の独立性とエコシステムの拡大を同時に支えている。

## 背景にある原則

- **最小インターフェースによる差し替え可能性**: ルーターインターフェースは `add()` と `match()` の 2 メソッドのみ（`src/router.ts:29-52`）。メソッド数を最小化することで、5 種のルーター実装が同一インターフェースで共存でき、SmartRouter による自動選択も可能になる。拡張ポイントのインターフェースは「これ以上削れない」まで絞るべきである。

- **合成優先、継承は構造固定のみ**: `HonoBase` は抽象基底クラスとして振る舞い（`src/hono-base.ts:117` のコメントで明示）、プリセット（`src/hono.ts`, `src/preset/tiny.ts`, `src/preset/quick.ts`）がコンストラクタでルーターを注入する。機能追加は `.use()` によるミドルウェア合成で行い、継承階層を深くしない。これにより、プリセットの切り替えが 1 行のインポート変更で済む。

- **ファクトリ関数でオプションを閉じ込める**: 全ミドルウェアは `options => (c, next) => ...` のファクトリ関数パターンを採用する（例: `bearerAuth()`, `cors()`, `logger()`）。設定をクロージャに閉じ込めることで、ミドルウェア関数自体は常に `(c, next)` の統一シグネチャを維持し、合成可能性を保つ。

- **宣言的合成でロジック分岐を外部化する**: `combine` モジュールの `some()`, `every()`, `except()` は、条件分岐ロジックをミドルウェア内部ではなくミドルウェアの外側で宣言的に記述させる（`src/middleware/combine/index.ts`）。これにより個々のミドルウェアは単一責任を維持できる。

## 実例と分析

### ルーターの Strategy パターンと自動選択

ルーターインターフェース（`Router<T>`）に対して 5 つの実装が存在する: `RegExpRouter`, `TrieRouter`, `LinearRouter`, `PatternRouter`, `SmartRouter`。SmartRouter は複数のルーターを保持し、最初の `match()` 呼び出し時にルート定義を各ルーターに追加して試行し、成功した最初のルーターに以降の処理を委譲する（`src/router/smart-router/router.ts:32-49`）。特筆すべきは、選択後に `this.match = router.match.bind(router)` でメソッドを直接差し替え、以降のオーバーヘッドを完全に排除する点である。

```typescript
// src/router/smart-router/router.ts:46
this.match = router.match.bind(router)
this.#routers = [router]
this.#routes = undefined
```

この「初回実行時に最適実装を選択し、自身を書き換える」パターンは、起動時の柔軟性とランタイムのパフォーマンスを両立する。

### プリセットシステム: 継承の最小利用

3 つのプリセットはそれぞれ `HonoBase` を継承し、コンストラクタでルーター構成のみを決定する。

```typescript
// src/hono.ts:27-33 (デフォルトプリセット)
constructor(options: HonoOptions<E> = {}) {
  super(options)
  this.router =
    options.router ??
    new SmartRouter({
      routers: [new RegExpRouter(), new TrieRouter()],
    })
}
```

```typescript
// src/preset/tiny.ts:18-23 (最小バンドルプリセット)
constructor(options: HonoOptions<E> = {}) {
  super(options)
  this.router = new PatternRouter()
}
```

継承はルーター構成の固定のみに使い、実際の機能拡張（ミドルウェア追加、ルーティング定義）はすべてインスタンスメソッドの呼び出しで行う。

### ファクトリヘルパーによる型安全な拡張

`createFactory()` は Env 型パラメータを固定した上で `createApp()`, `createMiddleware()`, `createHandlers()` を提供する（`src/helper/factory/index.ts:332-366`）。

```typescript
// src/helper/factory/index.ts:363-366
export const createFactory = <E extends Env = Env, P extends string = string>(init?: {
  initApp?: InitApp<E>
  defaultAppOptions?: HonoOptions<E>
}): Factory<E, P> => new Factory<E, P>(init)
```

`createMiddleware()` は実質的に恒等関数だが（`middleware => middleware`）、型推論を駆動する役割を持つ。実装上の制約（`as` アサーション等）を使わずに型安全を実現する手法として注目に値する。

### ミドルウェアの統一シグネチャと命名規約

全 25 種の組み込みミドルウェアが `(options?) => MiddlewareHandler` パターンに従う。さらに、返されるミドルウェア関数には名前付き関数式が使われる。

```typescript
// src/middleware/bearer-auth/index.ts:153
return async function bearerAuth(c, next) {
```

```typescript
// src/middleware/powered-by/index.ts:31
return async function poweredBy(c, next) {
```

匿名関数ではなく名前付き関数式を使うことで、スタックトレースやデバッグツールでミドルウェアを識別可能にしている。

### アダプタパターン: プラットフォーム差異の吸収

`serveStatic` ミドルウェアは共通ロジックを `src/middleware/serve-static/index.ts` に持ち、プラットフォーム固有のファイル読み取り関数 `getContent` を外部から注入する設計になっている。

```typescript
// src/adapter/deno/serve-static.ts:35-42
return baseServeStatic({
  ...options,
  getContent,
  join,
  isDir,
})(c, next)
```

```typescript
// src/middleware/serve-static/index.ts:36
getContent: (path: string, c: Context<E>) => Promise<Data | Response | null>
```

共通ロジックはフレームワーク側に、プラットフォーム依存部分はアダプタ側に分離することで、Deno, Bun, Cloudflare Workers 等で同一の API を提供している。

### ContextVariableMap によるモジュール宣言マージ

ミドルウェアが `c.set()` で設定する変数の型情報は、TypeScript の `declare module` によるインターフェース拡張で伝播する。

```typescript
// src/middleware/request-id/index.ts:5-7
declare module '../..' {
  interface ContextVariableMap extends RequestIdVariables {}
}
```

```typescript
// src/middleware/request-id/request-id.ts:9-11
export type RequestIdVariables = {
  requestId: string
}
```

この手法により、ミドルウェアをインポートするだけで `c.get('requestId')` の戻り値型が `string` に推論される。

### Combine モジュール: ミドルウェアの論理合成

`some()`, `every()`, `except()` は既存のミドルウェアを論理演算で組み合わせる高階関数として機能する。

```typescript
// src/middleware/combine/index.ts:38-69 (some: OR 論理)
export const some = (...middleware: (MiddlewareHandler | Condition)[]): MiddlewareHandler => {
  return async function some(c, next) {
    // 最初に成功したミドルウェアで処理を確定
  }
}

// src/middleware/combine/index.ts:161 (except: 除外条件付き適用)
const handler = some((c: Context) => conditions.some((cond) => cond(c)), every(...middleware))
```

`except()` の内部実装が `some()` と `every()` を組み合わせて実現されている点は、合成可能なプリミティブの設計指針を示している。

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: ルーティングアルゴリズムの実行時切り替え
  - 適用条件: 同一インターフェースの複数実装が存在し、コンテキストに応じて最適な実装を選びたい場合
  - コード例: `src/router.ts:29-52` (インターフェース), `src/router/smart-router/router.ts:4-70` (コンテキスト)
  - 注意点: SmartRouter は初回実行時に `this.match` を書き換える変形 Strategy。通常の Strategy はコンテキストが戦略を保持するが、ここでは戦略がコンテキストのメソッドを置換する

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: 共通処理フローの固定とプラットフォーム固有ステップの差し替え
  - 適用条件: アルゴリズムの骨格は共通だが、一部ステップが環境に依存する場合
  - コード例: `src/middleware/serve-static/index.ts:34-125` (テンプレート), `src/adapter/deno/serve-static.ts:8-42` (具象ステップ)
  - 注意点: 継承ではなく関数注入（`getContent`, `isDir`, `join`）で実現されており、クラスベースの Template Method より柔軟

- **Chain of Responsibility パターン** (分類: 振る舞い)
  - 解決する問題: リクエスト処理パイプラインの動的構築
  - 適用条件: 処理を複数のハンドラに順番に委譲し、各ハンドラが処理を続行するか中断するかを決定する場合
  - コード例: `src/compose.ts:15-73` (チェーン実行), `src/hono-base.ts:157-168` (`.use()` による登録)
  - 注意点: koa-compose ベースの実装で、`next()` の呼び出しが下流のハンドラを実行する。`next()` の多重呼び出しは明示的にエラーとなる（`src/compose.ts:34`）

## Good Patterns

- **名前付きミドルウェア関数**: ファクトリから返すミドルウェア関数に名前付き関数式を使用する。スタックトレースに `bearerAuth`, `cors`, `poweredBy` 等の名前が表示され、デバッグ効率が向上する。

```typescript
// src/middleware/bearer-auth/index.ts:153
return async function bearerAuth(c, next) {
  // ...
}
```

- **HTTPException による構造化エラー伝播**: ミドルウェアがエラーを報告する際、`throw new HTTPException(status, { res })` を使い、ステータスコードとレスポンスボディを一体化して伝播する。エラーハンドラ側は `err.getResponse()` で完全なレスポンスを取得でき、エラー処理の責務がミドルウェアに閉じる（`src/http-exception.ts:46-78`）。

```typescript
// src/middleware/bearer-auth/index.ts:150
throw new HTTPException(status, { res })
```

- **コンテキスト変数の型安全な共有**: `c.set()` / `c.get()` と `declare module` による ContextVariableMap 拡張を組み合わせ、ミドルウェア間のデータ共有を型安全に行う。変数名の typo がコンパイル時に検出される。

```typescript
// src/middleware/request-id/index.ts:5-7
declare module '../..' {
  interface ContextVariableMap extends RequestIdVariables {}
}
```

- **初回実行時の自己最適化**: SmartRouter が最初の `match()` で最適なルーターを選択し、`this.match` メソッドを直接差し替える。以降の呼び出しでは選択ロジックが一切実行されない。

```typescript
// src/router/smart-router/router.ts:46-48
this.match = router.match.bind(router)
this.#routers = [router]
this.#routes = undefined
```

## Anti-Patterns / 注意点

- **オプション型の肥大化**: `BearerAuthOptions` は `token` ベースと `verifyToken` ベースの判別共用体に加え、deprecated フィールドが 3 つ残存しており、型定義が約 45 行に膨れている（`src/middleware/bearer-auth/index.ts:22-66`）。ミドルウェアオプションは世代を重ねると deprecated フィールドが蓄積する傾向がある。

```typescript
// Bad: deprecated フィールドが型を肥大化させる
type BearerAuthOptions = {
  token: string | string[]
  /** @deprecated */ noAuthenticationHeaderMessage?: string | object | MessageFunction
  noAuthenticationHeader?: CustomizedErrorResponseOptions
  // ... 同様のペアが3組
}
```

```typescript
// Better: deprecated フィールドを別の型に分離し、& で合成する
type DeprecatedBearerAuthFields = {
  /** @deprecated */ noAuthenticationHeaderMessage?: ...
}
type BearerAuthOptions = BaseBearerAuthOptions & Partial<DeprecatedBearerAuthFields>
```

- **ミドルウェア間の暗黙的依存**: `timing` ミドルウェアが `c.set('metric', ...)` で設定した値を `setMetric()`, `startTime()`, `endTime()` がランタイムに読み取る。未初期化の場合は `console.warn` で警告するのみ（`src/middleware/timing/timing.ts:156-158`）。ミドルウェアの登録順序に依存する暗黙的な前提条件が生じる。

```typescript
// Bad: ミドルウェア未登録時にランタイム警告のみ
const metrics = c.get('metric')
if (!metrics) {
  console.warn('Metrics not initialized!')
  return
}
```

```typescript
// Better: 初期化を型レベルで要求する、または初期化関数の呼び出しを必須にするAPIにする
```

## 導出ルール

- `[MUST]` 拡張ポイントのインターフェースはメソッド数を最小化する（理想は 2-3 メソッド）
  - 根拠: Router インターフェースが `add()` と `match()` のみの 2 メソッドで、5 種の実装と SmartRouter による自動選択を実現している（`src/router.ts:29-52`）

- `[MUST]` ミドルウェア/プラグインはファクトリ関数パターン `(options?) => handler` で設計し、ハンドラのシグネチャを統一する
  - 根拠: 全 25 種の組み込みミドルウェアがこのパターンに従い、`some()`, `every()`, `except()` による論理合成を可能にしている（`src/middleware/combine/index.ts`）

- `[SHOULD]` ファクトリ関数から返すハンドラには名前付き関数式を使い、スタックトレースでの識別を可能にする
  - 根拠: 全組み込みミドルウェアが `return async function middlewareName(c, next)` 形式を採用し、デバッグ時の可読性を確保している（例: `src/middleware/bearer-auth/index.ts:153`）

- `[SHOULD]` プラットフォーム依存コードは共通ロジックから関数注入で分離し、アダプタ層に押し出す
  - 根拠: `serveStatic` が `getContent` 関数の注入で Deno/Bun/Cloudflare 対応を実現し、共通ロジックの重複を排除している（`src/middleware/serve-static/index.ts:36`）

- `[SHOULD]` 複数の実装戦略がある場合、初回実行時に最適な実装を自動選択して自身を書き換えるパターンを検討する
  - 根拠: SmartRouter が `this.match = router.match.bind(router)` で初回選択後のオーバーヘッドを完全に排除している（`src/router/smart-router/router.ts:46`）

- `[SHOULD]` プラグインがコンテキストに書き込む変数は、TypeScript の `declare module` によるインターフェース拡張で型情報を伝播させる
  - 根拠: `RequestIdVariables`, `TimingVariables` 等が ContextVariableMap を拡張し、インポートするだけで `c.get()` の戻り値が型推論される（`src/middleware/request-id/index.ts:5-7`）

- `[AVOID]` ミドルウェア間のデータ共有において、初期化の有無をランタイム警告のみで検証する設計
  - 根拠: `timing` の `setMetric()` はミドルウェア未登録時に `console.warn` するのみで処理を中断しない。暗黙的な登録順依存はバグの温床になる（`src/middleware/timing/timing.ts:156-158`）

## 適用チェックリスト

- [ ] フレームワーク/ライブラリの拡張ポイント（ルーター、ストレージ、認証等）のインターフェースが 3 メソッド以下に収まっているか確認する
- [ ] プラグイン/ミドルウェアがファクトリ関数パターンに統一されており、ハンドラのシグネチャが一定かを確認する
- [ ] ファクトリ関数から返されるハンドラが名前付き関数式になっているか（匿名アロー関数ではないか）を確認する
- [ ] プラットフォーム依存コードが共通ロジックから分離され、関数注入またはアダプタ層で提供されているかを確認する
- [ ] プラグインがコンテキストに書き込むデータに TypeScript の型情報が付与されているか（`declare module` 等）を確認する
- [ ] 複数のプラグインが暗黙的な登録順序に依存していないか、依存がある場合はコンパイル時または起動時に検証されるかを確認する
- [ ] プリセット/デフォルト構成の切り替えが 1 行のインポート変更で済む設計になっているかを確認する
