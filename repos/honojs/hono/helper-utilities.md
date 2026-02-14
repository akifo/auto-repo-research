# helper-utilities

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono の `src/helper/` には 14 個の独立したヘルパーモジュールが格納されている。各ヘルパーは `hono/cookie`, `hono/html` のようにトップレベルのサブパスインポートとして公開され、コアフレームワークから完全に分離されている。この設計は「Web 標準 API の薄いラッパーとして、必要な機能だけを選択的にインポートさせる」というアーキテクチャ思想を体現しており、マルチランタイム対応フレームワークにおけるユーティリティ設計の模範例として注目に値する。

## 設計思想

- **Context-first パラメータ規約**: すべてのヘルパー関数は第一引数に `Context` を受け取る（`getCookie(c, key)`, `accepts(c, options)`, `stream(c, cb)` 等）。ヘルパーをミドルウェアやクラスに閉じ込めず、純粋関数として設計することで、テスタビリティとコンポーザビリティを両立している。`src/helper/cookie/index.ts:27`, `src/helper/accepts/accepts.ts:40`, `src/helper/streaming/stream.ts:7`

- **Helper = Facade, Utils = Implementation の分離**: ヘルパーは「Context を受け取り、Web 標準 API に橋渡しする薄い Facade」に徹し、実際のロジック（パース、シリアライズ、暗号化等）は `src/utils/` に委譲する。cookie ヘルパーは `utils/cookie` の `parse`/`serialize` を呼ぶだけであり、html ヘルパーは `utils/html` の `escapeToBuffer` を使う。これにより、utils は Context 非依存で単体テスト可能になる。`src/helper/cookie/index.ts:7-8`, `src/helper/html/index.ts:6`

- **サブパスエクスポートによるツリーシェイキング保証**: 各ヘルパーは `package.json` の `exports` フィールドで `"./cookie"`, `"./html"` 等のサブパスとして個別エクスポートされる。ユーザーは `import { getCookie } from 'hono/cookie'` のように使い、使わないヘルパーはバンドルに含まれない。`package.json:103-106`

- **ランタイム差異の吸収は最小限のポイントに局所化**: マルチランタイム対応で避けられないランタイム固有の挙動差は、`adapter` ヘルパーの `getRuntimeKey()` や `streaming/utils.ts` の `isOldBunVersion()` のようなピンポイントな検出関数に閉じ込める。ヘルパー本体のロジックは Web 標準 API のみに依存する。`src/helper/adapter/index.ts:50-84`, `src/helper/streaming/utils.ts:1-11`

## 設計・実装の詳細

### ヘルパーの分類と責務マッピング

14 個のヘルパーは責務に応じて以下のように分類できる:

| 分類 | ヘルパー | 責務 |
|------|---------|------|
| HTTP プリミティブ操作 | cookie, html, css, accepts | リクエスト/レスポンスのヘッダー・ボディ操作 |
| 通信パターン | streaming, websocket, proxy | 非標準的な通信フロー（SSE, WS, リバースプロキシ） |
| ビルド・静的生成 | ssg | ルート走査によるプリレンダリング |
| 開発・テスト | dev, testing | デバッグ用ルート表示、テストクライアント生成 |
| インフラ抽象化 | adapter, conninfo, factory | ランタイム検出、接続情報、アプリ生成 |
| ルーティング情報 | route | マッチしたルートの取得 |

### Helper-Utils 二層アーキテクチャ

ヘルパーは一貫して「Context 依存の薄い Facade」として設計されている。

```
src/helper/cookie/index.ts  (Facade: Context → headers → parse)
        ↓ delegates to
src/utils/cookie.ts          (Pure Logic: parse, serialize, sign, verify)
```

cookie ヘルパーの `getCookie` は、`c.req.raw.headers.get('Cookie')` で生ヘッダーを取得し、`utils/cookie.parse()` に渡すだけである（`src/helper/cookie/index.ts:28-48`）。html ヘルパーも同様に `utils/html.escapeToBuffer()` に実処理を委譲する（`src/helper/html/index.ts:6`）。

この分離の利点は、utils 層が Context に依存しないため、ヘルパー経由でなくても直接利用できることである。例えば SSG のように、実際のリクエストが存在しない文脈でも utils の関数を活用できる。

### 関数オーバーロードによる柔軟な API

cookie ヘルパーは TypeScript の関数オーバーロードで 3 つの呼び出しパターンを提供する:

```typescript
// src/helper/cookie/index.ts:10-14
interface GetCookie {
  (c: Context, key: string): string | undefined       // 単一 Cookie 取得
  (c: Context): Cookie                                 // 全 Cookie 取得
  (c: Context, key: string, prefixOptions?: CookiePrefixOptions): string | undefined  // プレフィックス付き
}
```

WebSocket ヘルパーの `defineWebSocketHelper` も、ミドルウェアモードとダイレクトモードの 2 パターンをオーバーロードで統合している（`src/helper/websocket/index.ts:114-139`）。引数の型で分岐する実装パターンは、1 つのエクスポートで複数ユースケースをカバーする際に有効である。

### Proxy ヘルパーのセキュリティ設計

proxy ヘルパーは RFC 2616/9110 に準拠し、Hop-by-Hop ヘッダーの除去をデフォルトで行う:

```typescript
// src/helper/proxy/index.ts:10-19
const hopByHopHeaders = [
  'connection', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade',
]
```

`strictConnectionProcessing` オプション（デフォルト `false`）は、Connection ヘッダーのインジェクション攻撃を防ぐためにデフォルトでは Connection ヘッダーを無視し、信頼環境でのみ RFC 準拠の処理を有効にする設計である（`src/helper/proxy/index.ts:33-43`）。セキュリティ上の安全側をデフォルトとし、厳密準拠をオプトインにするという判断が見られる。

### SSG ヘルパーのプラグインアーキテクチャ

SSG ヘルパーは `BeforeRequestHook` / `AfterResponseHook` / `AfterGenerateHook` の 3 つのフックポイントを持つプラグインシステムを実装している:

```typescript
// src/helper/ssg/ssg.ts:163-167
export interface SSGPlugin {
  beforeRequestHook?: BeforeRequestHook | BeforeRequestHook[]
  afterResponseHook?: AfterResponseHook | AfterResponseHook[]
  afterGenerateHook?: AfterGenerateHook | AfterGenerateHook[]
}
```

フック合成関数 `combineBeforeRequestHooks` / `combineAfterResponseHooks` は、配列の各フックを直列実行し、いずれかが `false` を返すと処理を中断する Pipeline パターンを採用している（`src/helper/ssg/ssg.ts:106-125`）。`false` を返すことで「このルートをスキップ」という制御フローを簡潔に表現できる。

### テストヘルパーの最小設計

`testClient` はわずか 7 行で、Hono の RPC クライアント（`hc`）に `app.request` ベースのカスタム `fetch` を注入するだけである:

```typescript
// src/helper/testing/index.ts:16-27
export const testClient = <T extends Hono<any, Schema, string>>(
  app: T,
  Env?: ExtractEnv<T>['Bindings'] | {},
  executionCtx?: ExecutionContext,
  options?: Omit<ClientRequestOptions, 'fetch'>
): UnionToIntersection<Client<T, 'http://localhost'>> => {
  const customFetch = (input: RequestInfo | URL, init?: RequestInit) => {
    return app.request(input, init, Env, executionCtx)
  }
  return hc<typeof app, 'http://localhost'>('http://localhost', { ...options, fetch: customFetch })
}
```

HTTP サーバーを起動せず、型安全な API テストが可能になる。既存のクライアントライブラリ（`hc`）を再利用し、`fetch` の差し替えだけで実現している点が秀逸である。

### ランタイム検出の自己メモ化

streaming ヘルパーの `isOldBunVersion()` は、初回呼び出し後に関数自体を結果を返すだけの関数に置換する自己メモ化パターンを使用する:

```typescript
// src/helper/streaming/utils.ts:1-11
export let isOldBunVersion = (): boolean => {
  const version: string = typeof Bun !== 'undefined' ? Bun.version : undefined
  if (version === undefined) { return false }
  const result = version.startsWith('1.1') || version.startsWith('1.0') || version.startsWith('0.')
  isOldBunVersion = () => result  // 関数自体を置換
  return result
}
```

## パターンカタログ

- **Facade パターン** (構造)
  - 解決する問題: Context 依存の API と Context 非依存のロジックの結合
  - 適用条件: フレームワーク固有のコンテキストオブジェクトが存在し、内部ロジックを再利用可能に保ちたい場合
  - コード例: `src/helper/cookie/index.ts:27-48` (getCookie が utils/cookie.parse に委譲)
  - 注意点: Facade 層が厚くなるとメンテナンスコストが増大する。委譲のみに徹すること

- **Strategy パターン** (振る舞い)
  - 解決する問題: Content Negotiation のマッチングアルゴリズムを差し替え可能にする
  - 適用条件: デフォルト動作は提供するが、高度なユースケースでカスタマイズが必要な場合
  - コード例: `src/helper/accepts/accepts.ts:17-19` (acceptsOptions.match で defaultMatch を差し替え可能)
  - 注意点: デフォルト実装を必ず提供し、カスタマイズはオプショナルにする

- **Pipeline パターン** (振る舞い)
  - 解決する問題: SSG プロセスの各段階にフックポイントを提供し、拡張可能にする
  - 適用条件: 処理の前後でカスタムロジックを挿入したいが、本体ロジックは変更したくない場合
  - コード例: `src/helper/ssg/ssg.ts:106-125` (combineBeforeRequestHooks の直列合成)
  - 注意点: `false` 返却による中断は便利だが、エラーとスキップの区別がつきにくい

## Good Patterns

- **generate + set の分離**: cookie ヘルパーは `generateCookie`（Cookie 文字列の生成）と `setCookie`（Context への設定）を分離している。`generateCookie` は Context 非依存で、テストや SSG 等の非リクエスト文脈でも利用可能。

```typescript
// src/helper/cookie/index.ts:78-101
export const generateCookie = (name: string, value: string, opt?: CookieOptions): string => {
  // ... Cookie 文字列を生成して返す
}

export const setCookie = (c: Context, name: string, value: string, opt?: CookieOptions): void => {
  const cookie = generateCookie(name, value, opt)
  c.header('Set-Cookie', cookie, { append: true })
}
```

- **WeakMap によるコンテキスト外部ストレージ**: streaming ヘルパーと route ヘルパーは、`WeakMap` を使って Context やストリームにメタデータを関連付ける。Context オブジェクトのプロパティを汚染せず、GC も自然に行われる。

```typescript
// src/helper/streaming/stream.ts:5
const contextStash: WeakMap<ReadableStream, Context> = new WeakMap()

// src/helper/route/index.ts:106
const basePathCacheMap: WeakMap<Context, Record<number, string>> = new WeakMap()
```

- **Secure-by-default の設計**: proxy ヘルパーの `strictConnectionProcessing` はデフォルト `false`（安全側）であり、Cookie ヘルパーの `__Secure-` / `__Host-` プレフィックス使用時は自動的に `secure: true` と `path: '/'` を強制する。セキュリティ属性の設定漏れを構造的に防止している。

```typescript
// src/helper/cookie/index.ts:84-95
if (opt?.prefix === 'secure') {
  cookie = serialize('__Secure-' + name, value, { path: '/', ...opt, secure: true })
} else if (opt?.prefix === 'host') {
  cookie = serialize('__Host-' + name, value, {
    ...opt, path: '/', secure: true, domain: undefined,
  })
}
```

## Anti-Patterns / 注意点

- **SSE ヘッダーのハードコード**: `streamSSE` は SSE 用ヘッダー（`Content-Type: text/event-stream`, `Cache-Control: no-cache`）をすべてハードコードしている。カスタムヘッダーの追加や既存ヘッダーの上書きが難しい。

```typescript
// Bad: ヘッダーがハードコードされ変更不可
// src/helper/streaming/sse.ts:86-89
c.header('Transfer-Encoding', 'chunked')
c.header('Content-Type', 'text/event-stream')
c.header('Cache-Control', 'no-cache')
c.header('Connection', 'keep-alive')

// Better: オプションでヘッダーカスタマイズを許容する
export const streamSSE = (
  c: Context,
  cb: (stream: SSEStreamingApi) => Promise<void>,
  options?: { headers?: Record<string, string>; onError?: ... }
): Response => {
  c.header('Content-Type', options?.headers?.['Content-Type'] ?? 'text/event-stream')
  // ...
}
```

- **SSG の createdDirs がモジュールスコープ Set**: `saveContentToFile` で使われる `createdDirs` がモジュールスコープの `Set` として定義されており、複数回の `toSSG` 呼び出し間で状態がリークする可能性がある。

```typescript
// Bad: モジュールスコープの状態
// src/helper/ssg/ssg.ts:297
const createdDirs: Set<string> = new Set()

// Better: toSSG のスコープ内で管理する
export const toSSG: ToSSGInterface = async (app, fs, options) => {
  const createdDirs = new Set<string>()
  // ...
}
```

## 導出ルール

- `[MUST]` ヘルパー関数はフレームワークコンテキストを第一引数に受け取り、ロジック本体は Context 非依存の utils 層に委譲すること
  - 根拠: Hono の全 14 ヘルパーがこのパターンに従い、utils 層の単体テスト容易性とヘルパーの薄さを両立している（`src/helper/cookie/index.ts` が `src/utils/cookie.ts` に委譲する構造）

- `[MUST]` セキュリティに関わるデフォルト値は安全側に倒し、危険な動作はオプトインにすること
  - 根拠: proxy ヘルパーの `strictConnectionProcessing: false` や cookie の prefix 指定時の `secure: true` 強制が、設定漏れによるセキュリティホールを構造的に防いでいる（`src/helper/proxy/index.ts:35-43`）

- `[SHOULD]` 副作用のある操作（Context への書き込み）と純粋な生成処理を別関数として公開すること
  - 根拠: cookie ヘルパーの `generateCookie` / `setCookie` 分離により、SSG やテスト等の非リクエスト文脈でも Cookie 文字列の生成が可能になっている（`src/helper/cookie/index.ts:78-101`）

- `[SHOULD]` ランタイム固有の差異吸収は、ヘルパー本体ではなく専用の検出関数に局所化すること
  - 根拠: `isOldBunVersion()` や `getRuntimeKey()` が分離されているため、ランタイム対応の追加・変更がヘルパーのビジネスロジックに波及しない（`src/helper/streaming/utils.ts:1-11`, `src/helper/adapter/index.ts:50-84`）

- `[SHOULD]` サブパスエクスポートでヘルパーを個別公開し、メインエントリポイントには含めないこと
  - 根拠: Hono は `hono/cookie`, `hono/html` 等で package.json の exports を個別定義し、未使用ヘルパーがバンドルに含まれないツリーシェイキングを保証している（`package.json:103-412`）

- `[AVOID]` モジュールスコープに可変状態を持つこと。処理のスコープ内で状態を管理する方がリーク防止に有効
  - 根拠: SSG ヘルパーの `createdDirs: Set<string>` がモジュールスコープで定義されており、複数回呼び出し時に前回の状態が残る潜在的バグを含む（`src/helper/ssg/ssg.ts:297`）

- `[AVOID]` ヘルパー内に HTTP ヘッダー値をハードコードすること。デフォルト値は提供しつつ、オプションでの上書きを許容する
  - 根拠: `streamSSE` の SSE ヘッダーのハードコードは、カスタムヘッダー追加や CDN 固有のヘッダー調整を困難にしている（`src/helper/streaming/sse.ts:86-89`）

## 適用チェックリスト

- [ ] ヘルパー関数の第一引数がフレームワークコンテキストになっているか（Context-first 規約）
- [ ] ヘルパーとユーティリティが分離されているか（Facade 層は薄いか、ロジック本体は Context 非依存か）
- [ ] 副作用のある操作と純粋な生成処理が分離されているか（generate と set の分離）
- [ ] セキュリティ関連のデフォルト値が安全側に設定されているか（secure-by-default）
- [ ] ランタイム固有の差異が検出関数に局所化されているか（ヘルパー本体に if-else で散在していないか）
- [ ] 各ヘルパーがサブパスエクスポートとして個別公開されているか（ツリーシェイキング可能か）
- [ ] モジュールスコープに可変状態が存在しないか（WeakMap は許容、可変 Set/Map/変数は要注意）
- [ ] ヘッダー値やマジックナンバーがハードコードされていないか（オプションで上書き可能か）
