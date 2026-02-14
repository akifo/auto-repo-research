# design-philosophy

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Web Standards 準拠の設計哲学と技術選定の判断基準を分析する。Hono は「Web Standards を唯一の抽象化レイヤーとして採用し、ランタイム固有 API を Adapter パターンで隔離する」という一貫した設計判断を貫いている。この判断により、ゼロ依存・マルチランタイム・超軽量という3つの目標を同時に達成している。フレームワーク設計における「何を標準とし、何をオプションにするか」の判断基準として、あらゆる規模のライブラリ設計に応用可能な知見を含む。

## 背景にある原則

- **最小公倍数ではなく最大公約数を基盤にすべき**: マルチランタイム対応において、各ランタイムの機能を全て包含する抽象レイヤー（最小公倍数）ではなく、全ランタイムが共通で持つ Web Standards API（最大公約数）をコアに据えている。`fetch()` のシグネチャ `(request: Request, env?, executionCtx?) => Response | Promise<Response>` がその象徴で、Cloudflare Workers の `export default { fetch }` と同じ形式。コアは `Request` in / `Response` out に徹し、ランタイム固有の情報は `env` 経由で受け取る（`src/hono-base.ts:473-479`）。

- **依存を追加する前に標準 API で実装できないか確認すべき**: `package.json` の `dependencies` は空。暗号処理は `crypto.subtle`（`src/utils/crypto.ts:45-46`）、ストリーミングは `ReadableStream` / `WritableStream` / `TransformStream`（`src/utils/stream.ts`）、エンコーディングは `TextEncoder`（`src/utils/crypto.ts:42`）で実装している。Node.js 固有の `crypto` モジュールや `Buffer` を一切使わないことで、全ランタイムで動作する。

- **パフォーマンスのために標準 API の使用を避けるべき場面を見極めよ**: Web Standards に準拠しつつも、ホットパスでは標準 API のオーバーヘッドを回避している。`getPath()` は `new URL()` を使わず文字列の charCode 比較でパスを抽出し（`src/utils/url.ts:106-134`）、`getQueryParam()` も `URLSearchParams` を使わず手動パースしている（`src/utils/url.ts:219-300`）。標準 API は「正しいが遅い」場面が存在する。

- **選択肢はユーザーに委ね、デフォルトは最適解を提供すべき**: ルーター実装を5種類用意し（RegExpRouter, TrieRouter, LinearRouter, PatternRouter, SmartRouter）、プリセットで使い分ける。デフォルトの `Hono` クラスは `SmartRouter` で最初のリクエスト時に最適なルーターを自動選択する（`src/router/smart-router/router.ts:21-60`）。`hono/tiny` は最小サイズの PatternRouter を使い、`hono/quick` は起動が速い LinearRouter を使う。

## 実例と分析

### Web Standards を境界契約として使う

Hono のコア API は `fetch()` シグネチャそのものである。エントリポイントは `app.fetch(request, env, executionCtx)` で、入力は `Request`、出力は `Response`。この設計により、どのランタイムでも `export default app` だけで動作する。

```typescript
// src/hono-base.ts:473-479
fetch: (
  request: Request,
  Env?: E['Bindings'] | {},
  executionCtx?: ExecutionContext
) => Response | Promise<Response> = (request, ...rest) => {
  return this.#dispatch(request, rest[1], rest[0], request.method)
}
```

ミドルウェアも同様に `Response` を返す関数として統一されている。CORS ミドルウェアの preflight 処理は `new Response(null, { headers, status: 204 })` を直接返す（`src/middleware/cors/index.ts:146-151`）。HTTPException も `getResponse()` で `new Response()` を返す（`src/http-exception.ts:67-77`）。

### Adapter パターンによるランタイム固有 API の隔離

ランタイムごとに異なる API（接続情報の取得、ファイルシステムアクセス、WebSocket）は `src/adapter/` に隔離され、共通インターフェースで抽象化される。

```typescript
// src/helper/conninfo/types.ts:45
export type GetConnInfo = (c: Context) => ConnInfo

// src/adapter/cloudflare-workers/conninfo.ts:3-7
export const getConnInfo: GetConnInfo = (c) => ({
  remote: {
    address: c.req.header('cf-connecting-ip'),
  },
})

// src/adapter/bun/conninfo.ts:10-43
export const getConnInfo: GetConnInfo = (c: Context) => {
  const server = getBunServer<{...}>(c)
  const info = server.requestIP(c.req.raw)
  return { remote: { address: info.address, ... } }
}

// src/adapter/deno/conninfo.ts:8-17
export const getConnInfo: GetConnInfo = (c) => {
  const { remoteAddr } = c.env
  return { remote: { address: remoteAddr.hostname, ... } }
}
```

同じ `GetConnInfo` 型を満たしつつ、Cloudflare は HTTP ヘッダから、Bun は `server.requestIP()` から、Deno は `c.env.remoteAddr` から取得する。ユーザーコードは `import { getConnInfo } from 'hono/cloudflare-workers'` のように、ランタイムに応じたアダプタを import するだけでよい。

### ホットパスでの標準 API 回避

`getPath()` は URL パースの最頻出処理であり、`new URL()` の代わりに文字列操作で実装している。

```typescript
// src/utils/url.ts:106-134
export const getPath = (request: Request): string => {
  const url = request.url;
  const start = url.indexOf("/", url.indexOf(":") + 4);
  let i = start;
  for (; i < url.length; i++) {
    const charCode = url.charCodeAt(i);
    if (charCode === 37) { // '%'
      // percent encoding がある場合のみ indexOf にフォールバック
      const queryIndex = url.indexOf("?", i);
      const hashIndex = url.indexOf("#", i);
      // ...
    } else if (charCode === 63 || charCode === 35) { // '?' or '#'
      break;
    }
  }
  return url.slice(start, i);
};
```

`charCode` 比較によるバイト単位の走査、percent encoding がない場合（大多数のケース）は `indexOf` すら呼ばない最適化が施されている。同様に `context.ts` の `text()` メソッドもヘッダやステータスが未設定の場合は `new Response(text)` を直接返す fast path を持つ（`src/context.ts:677-684`）。

### Object.create(null) による辞書の高速化

全ルーター実装で params や children の格納に `Object.create(null)` を使用している。

```typescript
// src/router/reg-exp-router/router.ts:17
const nullMatcher: Matcher<any> = [/^$/, [], Object.create(null)];

// src/router/trie-router/node.ts:16
const emptyParams = Object.create(null);

// src/router/linear-router/router.ts:7
const emptyParams = Object.create(null);

// src/router/pattern-router/router.ts:6
const emptyParams = Object.create(null);
```

通常のオブジェクトリテラル `{}` はプロトタイプチェーンを持つため、`hasOwnProperty` チェックが必要になり、V8 の hidden class 最適化にも影響する。`Object.create(null)` はプロトタイプを持たない純粋なハッシュマップとして機能する。

### SmartRouter: 遅延評価と自己書き換えによる最適化

SmartRouter は最初の `match()` 呼び出し時に複数のルーター候補を試し、成功したルーターに自身の `match` メソッドを書き換える。

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
        continue  // 次のルーターを試す
      }
      throw e
    }
    this.match = router.match.bind(router)  // 自己書き換え
    this.#routers = [router]
    this.#routes = undefined  // ルート定義を GC 可能に
    break
  }
  // ...
}
```

`this.match = router.match.bind(router)` で2回目以降は直接選択されたルーターの match を呼ぶ。Strategy パターンの動的選択だが、一度選択したら委譲コストもゼロになる点が特徴的。

### プリセットによるバンドルサイズ制御

コアクラス `HonoBase` を共有しつつ、ルーターの組み合わせだけが異なるプリセットを提供する。

```typescript
// src/hono.ts (default: 高速ルーティング重視)
export class Hono<...> extends HonoBase<...> {
  constructor(options = {}) {
    super(options)
    this.router = options.router ??
      new SmartRouter({ routers: [new RegExpRouter(), new TrieRouter()] })
  }
}

// src/preset/tiny.ts (最小バンドルサイズ重視: < 12kB)
export class Hono<...> extends HonoBase<...> {
  constructor(options = {}) {
    super(options)
    this.router = new PatternRouter()
  }
}
```

これにより、同じ API を維持したまま、エッジ環境（サイズ重視）とサーバー環境（速度重視）で最適な構成を選択できる。

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: ルーティングアルゴリズムの交換可能性
  - 適用条件: 同じインターフェース (`Router<T>`) を満たす複数の実装が存在し、使用場面で最適な実装が異なる場合
  - コード例: `src/router.ts:29-52` (Router インターフェース), `src/hono.ts:27-33` (Strategy の注入)
  - 注意点: SmartRouter が初回リクエスト時に自動選択する変形で、一度選択されたら変更されない（Strategy の動的切り替えではなく、遅延バインディング）

- **Adapter パターン** (分類: 構造)
  - 解決する問題: ランタイム固有 API を共通インターフェースに変換
  - 適用条件: 同じ概念（接続情報、ファイルアクセス等）がランタイムごとに異なる API で提供される場合
  - コード例: `src/helper/conninfo/types.ts:45` (共通型), `src/adapter/*/conninfo.ts` (各実装)
  - 注意点: Adapter は `src/adapter/` に配置し、ユーザーが明示的に import する設計。自動検出ではない

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: Lambda イベント処理の共通フローと差分の分離
  - 適用条件: 処理フローは共通だが、各ステップの実装がイベント種別ごとに異なる場合
  - コード例: `src/adapter/aws-lambda/handler.ts:268-328` (EventProcessor 抽象クラス)

## Good Patterns

- **fetch シグネチャをフレームワークの境界契約にする**: `(Request, env?, ctx?) => Response | Promise<Response>` という Web Standards ベースのシグネチャをフレームワークのエントリポイントにすることで、どのランタイムでも `export default app` で動作する。テストも `app.request('/path')` で標準 Request/Response を使って実行できる（`src/helper/testing/index.ts:16-27`）。

```typescript
// src/hono-base.ts:493-511
request = (
  input: RequestInfo | URL,
  requestInit?: RequestInit,
  Env?: E["Bindings"] | {},
  executionCtx?: ExecutionContext,
): Response | Promise<Response> => {
  if (input instanceof Request) {
    return this.fetch(requestInit ? new Request(input, requestInit) : input, Env, executionCtx);
  }
  input = input.toString();
  return this.fetch(
    new Request(
      /^https?:\/\//.test(input) ? input : `http://localhost${mergePath("/", input)}`,
      requestInit,
    ),
    Env,
    executionCtx,
  );
};
```

- **ランタイム固有のコードを Adapter としてサブパスに分離する**: `hono/cloudflare-workers`, `hono/bun`, `hono/deno` など、ランタイム固有のコードは package.json の `exports` でサブパスとして公開する。コア (`hono`) はランタイム非依存を保ち、ユーザーは必要なアダプタだけを import する。ツリーシェイキングにも有利。

```jsonc
// package.json (抜粋)
"exports": {
  ".": { "import": "./dist/index.js" },          // コア (ランタイム非依存)
  "./cloudflare-workers": { "import": "..." },    // CF Workers アダプタ
  "./bun": { "import": "..." },                   // Bun アダプタ
  "./deno": { "import": "..." },                  // Deno アダプタ
}
```

- **単一ハンドラの場合に compose をスキップする最適化**: ミドルウェアチェーンが1つしかない場合、`compose()` を呼ばず直接ハンドラを実行する（`src/hono-base.ts:424-442`）。大多数のルートはミドルウェアなしか少数であるため、この最適化は全体のスループットに大きく寄与する。

## Anti-Patterns / 注意点

- **ホットパスでの new URL() 依存**: URL パースに `new URL()` を使うと、オブジェクト生成・プロトコル検証・ホスト解析などの不要な処理が毎リクエスト発生する。パスだけが必要な場面では文字列操作の方が桁違いに速い。

```typescript
// Bad: 毎リクエストで URL オブジェクトを生成
const getPath = (request: Request): string => {
  return new URL(request.url).pathname;
};

// Better: 文字列操作でパスだけを抽出 (Hono の実装)
const getPath = (request: Request): string => {
  const url = request.url;
  const start = url.indexOf("/", url.indexOf(":") + 4);
  // charCode 比較で '?' や '#' を検出し slice で返す
};
```

- **共通辞書での {} リテラル使用**: ルートパラメータなどの頻繁にアクセスされるオブジェクトに `{}` を使うと、プロトタイプチェーンの走査コストが発生し、`__proto__` や `constructor` がキーとして衝突するリスクもある。

```typescript
// Bad: プロトタイプチェーン付きオブジェクト
const params: Record<string, string> = {};

// Better: プロトタイプなしの純粋辞書
const params: Record<string, string> = Object.create(null);
```

## 導出ルール

- `[MUST]` マルチランタイム対応ライブラリでは、コアのエントリポイントを Web Standards API（Request/Response）で定義し、ランタイム固有 API はアダプタに隔離する
  - 根拠: Hono は `fetch(Request) => Response` を境界契約とし、`src/adapter/` に CF Workers / Bun / Deno / AWS Lambda 等の固有処理を隔離することで、コアコードの変更なしに9つ以上のランタイムをサポートしている

- `[MUST]` フレームワークやライブラリのコアモジュールは外部ランタイム依存（`node:crypto`, `node:fs` 等）を含めず、Web Standards API（`crypto.subtle`, `ReadableStream`, `TextEncoder` 等）のみを使用する
  - 根拠: Hono は `dependencies` がゼロで、暗号処理を `crypto.subtle`（`src/utils/crypto.ts:45-46`）、ストリーミングを `TransformStream`（`src/helper/streaming/stream.ts:12`）で実装し、全ランタイムで動作を保証している

- `[SHOULD]` リクエスト処理のホットパスでは `new URL()` や `URLSearchParams` を避け、文字列操作でパース処理を実装する
  - 根拠: Hono の `getPath()` は `charCode` 比較による文字列走査で URL パスを抽出し（`src/utils/url.ts:106-134`）、`getQueryParam()` も手動パースしている（`src/utils/url.ts:219-300`）。percent encoding がないケース（大多数）では `indexOf` すら呼ばない最適化が施されている

- `[SHOULD]` ホットパスでオブジェクトを辞書として使う場合は `Object.create(null)` でプロトタイプチェーンを排除する
  - 根拠: Hono の全ルーター実装（RegExpRouter, TrieRouter, LinearRouter, PatternRouter）で params, children, cache に `Object.create(null)` を使用している（該当箇所 25 件以上）

- `[SHOULD]` 同じインターフェースの複数実装がある場合、デフォルトは自動選択（SmartRouter パターン）にし、上級ユーザーには明示的な選択を許可する
  - 根拠: SmartRouter は初回リクエスト時に最適なルーターを自動選択し、`this.match` を書き換えて以降のオーバーヘッドをゼロにする（`src/router/smart-router/router.ts:46`）。プリセット（`hono/tiny`, `hono/quick`）で明示的な選択も可能

- `[SHOULD]` バンドルサイズが異なる複数のプリセットを提供する場合、コアクラスを共有し、差分（ルーター等）だけを差し替える構成にする
  - 根拠: `HonoBase` を共有し、`Hono`（デフォルト）, `hono/tiny`（< 12kB）, `hono/quick`（起動高速）がルーターの組み合わせだけ異なる（`src/hono.ts`, `src/preset/tiny.ts`, `src/preset/quick.ts`）

- `[AVOID]` ランタイム検出による分岐をコアコードに埋め込むこと。代わりに、ユーザーが import パスでランタイムを選択する設計にする
  - 根拠: Hono は `if (typeof Deno !== 'undefined')` のようなランタイム検出をコアに持たず、`hono/cloudflare-workers` / `hono/bun` / `hono/deno` のサブパス import でアダプタを選択させる。これにより dead code elimination が効き、バンドルサイズが最小化される

## 適用チェックリスト

- [ ] ライブラリのコアモジュールが `node:` プレフィックス付きモジュールに依存していないか確認する
- [ ] エントリポイントのシグネチャが Web Standards の `Request` / `Response` ベースになっているか確認する
- [ ] ランタイム固有のコードが `adapter/` や専用サブパスに隔離されているか確認する
- [ ] ホットパスで `new URL()`, `URLSearchParams`, `JSON.parse()` を不必要に使用していないか確認する
- [ ] 頻繁にアクセスされるオブジェクト辞書が `Object.create(null)` で生成されているか確認する
- [ ] `package.json` の `exports` でサブパスを定義し、ツリーシェイキングを有効にしているか確認する
- [ ] デフォルト構成がほとんどのユーザーにとって最適か、上級ユーザー向けのカスタマイズ手段があるか確認する
- [ ] 単一ハンドラのような頻出ケースに fast path を用意しているか確認する
