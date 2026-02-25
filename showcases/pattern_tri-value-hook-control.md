# Pattern: Tri-Value Hook Control

> 出典: [repos/cloudflare/partykit](../repos/cloudflare/partykit/)
> カテゴリ: pattern

## 概要

前処理フックの戻り値を `Response | Request | void` の三値で設計し、**拒否**（短絡レスポンス返却）・**変形**（リクエスト書き換え）・**続行**（何もしない）を単一のフック型で表現するパターン。if-else チェーンや boolean フラグに頼らず、戻り値の型そのもので制御フローの意図を宣言的に示せる。ミドルウェア、プラグインフック、ゲートウェイなど、リクエスト前処理が発生するあらゆる場面に汎用的に適用できる。

## 背景・文脈

PartyKit (PartyServer) は Cloudflare Durable Objects 上のリアルタイムサーバーフレームワークである。WebSocket 接続や HTTP リクエストが Durable Object インスタンスに到達する前に、ルーティング層で認証チェックやヘッダ注入などの前処理を行う必要がある。

PartyServer はこの前処理を `onBeforeConnect` / `onBeforeRequest` という2つのフックで提供している。これらのフックは `Response | Request | void` を返す設計であり、戻り値の型によって後続の制御フローが自動的に決定される。

| 戻り値     | 意味                             | 制御フロー                                         |
| ---------- | -------------------------------- | -------------------------------------------------- |
| `Response` | 拒否（認証失敗、リダイレクト等） | フックの戻り値をそのままクライアントに返却（短絡） |
| `Request`  | 変形（ヘッダ注入、パス書き換え） | 書き換えたリクエストで後続処理を続行               |
| `void`     | 続行（何もしない）               | 元のリクエストのまま後続処理を続行                 |

この設計の本質は「新しい概念を導入しない」ことにある。Response と Request はプラットフォーム標準の Web API オブジェクトであり、利用者が既に知っている型だけで3つの制御パスを表現できる。

## 実装パターン

### 1. フック呼び出しと三値判定

フックの戻り値を `instanceof` で判定し、型に応じて制御フローを分岐する。

```typescript
// packages/partyserver/src/index.ts:298-306
if (isWebSocket) {
  if (options?.onBeforeConnect) {
    const reqOrRes = await options.onBeforeConnect(req, lobby);
    if (reqOrRes instanceof Request) {
      req = reqOrRes; // 変形: 書き換えたリクエストで続行
    } else if (reqOrRes instanceof Response) {
      return reqOrRes; // 拒否: 短絡レスポンスを返却
    }
    // void → 元のリクエストのまま続行
  }
}
```

HTTP リクエストに対する `onBeforeRequest` も同じパターンで実装されている。

```typescript
// packages/partyserver/src/index.ts:308-316
if (options?.onBeforeRequest) {
  const reqOrRes = await options.onBeforeRequest(req, lobby);
  if (reqOrRes instanceof Request) {
    req = reqOrRes; // 変形
  } else if (reqOrRes instanceof Response) {
    return reqOrRes; // 拒否
  }
}
```

2つのフック（WebSocket 用 / HTTP 用）が完全に同じ判定ロジックを使っている点に注目すべきである。三値パターンが制御フローの標準プロトコルとして機能しているため、フックの種類が増えても判定ロジックは変わらない。

### 2. フックの型定義

フックのシグネチャは `Response | Request | void` を返す非同期関数として定義される。

```typescript
// packages/partyserver/src/index.ts:136-148
export interface PartyServerOptions {
  onBeforeConnect?(
    req: Request,
    lobby: Lobby,
  ): Response | Request | void | Promise<Response | Request | void>;
  onBeforeRequest?(
    req: Request,
    lobby: Lobby,
  ): Response | Request | void | Promise<Response | Request | void>;
}
```

同期・非同期の両方を受け付ける `T | Promise<T>` のユニオンにより、シンプルなバリデーションは同期で、外部サービス呼び出しを伴う認証は非同期で実装できる。

### 3. 異なるフレームワークとのブリッジ

hono-party パッケージは、Hono の Context を第3引数として注入する薄いラッパーでこのパターンを拡張している。三値フックのシグネチャを変えずに、フレームワーク間のコンテキスト伝搬を実現している。

```typescript
// packages/hono-party/src/index.ts:72-90
function wrapOptionsWithContext<E extends Env>(
  options: HonoPartyServerOptions<E> | undefined,
  c: Context<E>,
): PartyServerOptions | undefined {
  if (!options) return undefined;
  const { onBeforeConnect, onBeforeRequest, ...rest } = options;
  return {
    ...rest,
    ...(onBeforeConnect && {
      onBeforeConnect: (req: Request, lobby: Lobby) => onBeforeConnect(req, lobby, c),
    }),
    ...(onBeforeRequest && {
      onBeforeRequest: (req: Request, lobby: Lobby) => onBeforeRequest(req, lobby, c),
    }),
  };
}
```

## Good Example

### 認証チェック（拒否パターン）

```typescript
// packages/partyserver/src/tests/worker.ts:477-488
onBeforeConnect: async (_request, { className, name }) => {
  if (className === "OnStartServer") {
    if (name === "is-error") {
      return new Response("Error", { status: 503 });
    } else if (name === "is-redirect") {
      return new Response("Redirect", {
        status: 302,
        headers: { Location: "https://example2.com" },
      });
    }
  }
  // void: 条件に該当しない場合は続行
},
```

### 汎用的な適用例: API ゲートウェイの前処理フック

三値パターンを自前のミドルウェアシステムに適用する場合の実装例。

```typescript
// 三値フックの型定義
type BeforeRequestHook = (
  req: Request,
  ctx: GatewayContext,
) => Response | Request | void | Promise<Response | Request | void>;

// フック実行エンジン（再利用可能）
async function executeBeforeHook(
  hook: BeforeRequestHook | undefined,
  req: Request,
  ctx: GatewayContext,
): Promise<{ request: Request; response?: Response; }> {
  if (!hook) return { request: req };

  const result = await hook(req, ctx);
  if (result instanceof Response) {
    return { request: req, response: result }; // 短絡
  }
  if (result instanceof Request) {
    return { request: result }; // 変形
  }
  return { request: req }; // 続行
}

// フックの利用例
const authHook: BeforeRequestHook = async (req, ctx) => {
  const token = req.headers.get("Authorization");
  if (!token) {
    return new Response("Unauthorized", { status: 401 }); // 拒否
  }
  const user = await verifyToken(token);
  // ヘッダにユーザー情報を注入して変形
  const headers = new Headers(req.headers);
  headers.set("X-User-Id", user.id);
  return new Request(req.url, { ...req, headers }); // 変形
};

const passthroughHook: BeforeRequestHook = (_req, _ctx) => {
  // void: 何もせず続行
};
```

### 複数フックのチェーン実行

```typescript
async function executeHookChain(
  hooks: BeforeRequestHook[],
  req: Request,
  ctx: GatewayContext,
): Promise<Response | Request> {
  let current = req;
  for (const hook of hooks) {
    const result = await hook(current, ctx);
    if (result instanceof Response) {
      return result; // いずれかのフックが拒否したら即座に短絡
    }
    if (result instanceof Request) {
      current = result; // 変形を累積
    }
  }
  return current; // 全フックが続行 or 変形のみ
}
```

## Bad Example

### boolean フラグと副作用の分離

```typescript
// Bad: フックが boolean を返し、副作用でリクエストを変形する
type BeforeRequestHook = (
  req: Request,
  ctx: { setRequest: (r: Request) => void; },
) => boolean | Promise<boolean>;

const authHook: BeforeRequestHook = async (req, ctx) => {
  const token = req.headers.get("Authorization");
  if (!token) {
    return false; // 拒否...だが Response を返す手段がない
  }
  const user = await verifyToken(token);
  const headers = new Headers(req.headers);
  headers.set("X-User-Id", user.id);
  ctx.setRequest(new Request(req.url, { ...req, headers })); // 副作用で変形
  return true;
};

// 問題点:
// - false の場合に返すべき Response（ステータスコード、ヘッダ等）を表現できない
// - 変形が副作用に依存し、フックの実行順序に敏感になる
// - boolean では「何もしなかった」と「チェックして通した」の区別がつかない
```

### 専用の結果オブジェクトによる過剰抽象化

```typescript
// Bad: 戻り値専用の結果型を定義する
type HookResult =
  | { action: "reject"; response: Response; }
  | { action: "transform"; request: Request; }
  | { action: "continue"; };

const authHook = async (req: Request): Promise<HookResult> => {
  const token = req.headers.get("Authorization");
  if (!token) {
    return { action: "reject", response: new Response("Unauthorized", { status: 401 }) };
  }
  return { action: "continue" };
};

// 問題点:
// - Response と Request はプラットフォーム標準の型なのに、独自の判別共用体で包む冗長さ
// - フック利用者は { action: "reject", response: ... } のボイラープレートを毎回書く
// - instanceof による判定と比べて、文字列リテラル比較は typo リスクがある
// - 三値パターンなら `return new Response(...)` の1行で済む
```

### 例外による拒否の表現

```typescript
// Bad: 例外を制御フローに使う
const authHook = async (req: Request): Promise<Request | void> => {
  const token = req.headers.get("Authorization");
  if (!token) {
    throw new UnauthorizedError("Missing token"); // 例外で拒否
  }
};

// 呼び出し側で catch が必要
try {
  const result = await hook(req, ctx);
  // ...
} catch (e) {
  if (e instanceof UnauthorizedError) {
    return new Response(e.message, { status: 401 });
  }
  throw e; // 想定外のエラーは再スロー
}

// 問題点:
// - 例外は「異常系」であり、認証拒否のような「正常な分岐」に使うべきでない
// - catch 内でエラー型の判別が必要になり、判定ロジックが分散する
// - Response のステータスコードやヘッダをフック側で制御できない
```

## 適用ガイド

### どのような状況で使うべきか

- **API ゲートウェイ / リバースプロキシの前処理**: 認証、レート制限、リクエスト変形をフックで差し込む場面
- **WebSocket 接続のハンドシェイク前処理**: 接続を受け入れる前のバリデーションやヘッダ注入
- **プラグインシステムのリクエストインターセプト**: プラグインがリクエストを検査し、拒否・変形・パススルーを選択する場面
- **テスト用のリクエストモック**: テストフックでリクエストを書き換えたり、特定条件でモックレスポンスを返す場面

### 導入時の注意点

- **判定順序は `Response` を先に**: `instanceof Response` を先にチェックし、短絡パスを最優先にする。Response が返された場合は後続処理を一切行わないことを保証する
- **`instanceof` が動作する環境を確認する**: Web Workers や Node.js では `Request` / `Response` がグローバルに存在するが、環境によっては polyfill が必要。`instanceof` が正しく動作しない場合は Duck Typing（`response.ok !== undefined` 等）にフォールバックする
- **同期・非同期の両方を受け付ける型にする**: `T | Promise<T>` のユニオンにより、単純な検証は同期で、外部サービス呼び出しは非同期で実装できる柔軟性を保つ
- **チェーン実行時の変形の累積**: 複数フックを直列実行する場合、前のフックが返した Request を次のフックに渡すことで変形を累積する。ただし、Response（短絡）が返された時点でチェーンを即座に中断する

### カスタマイズポイント

- **三値の拡張**: `Response | Request | void` の基本形に加え、環境に応じて戻り値型を拡張できる。例えば `Response | Request | null | void` として `null` を「明示的なスキップ」に割り当てるなど
- **コンテキスト引数の拡張**: PartyKit の hono-party のように、薄いラッパーでフレームワーク固有のコンテキストを追加引数として注入できる。フックのシグネチャ本体は変えずに拡張する
- **フック実行エンジンの汎用化**: 三値判定ロジックをヘルパー関数として抽出し、異なる種類のフック（beforeConnect, beforeRequest, beforeClose 等）で再利用する

## 参考

- [repos/cloudflare/partykit/composition-patterns.md](../repos/cloudflare/partykit/composition-patterns.md) -- 三値フック、Mixin パターン、Factory パターンの詳細分析
- [repos/cloudflare/partykit/hook-and-lifecycle-patterns.md](../repos/cloudflare/partykit/hook-and-lifecycle-patterns.md) -- ライフサイクルフック設計、Strategy パターン、初期化保証の分析
- [repos/cloudflare/partykit/design-philosophy.md](../repos/cloudflare/partykit/design-philosophy.md) -- フック設計思想、規約ベース自動検出、configurable プロパティの分析
