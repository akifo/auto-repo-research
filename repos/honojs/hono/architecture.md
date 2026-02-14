# Architecture

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Web Standards（Request/Response）の上に構築されたフレームワークのコア抽象・レイヤー構成・依存関係の方向性を分析する。359 ファイル規模のコードベースにおいて、コアが 73 行（compose.ts）に収まり、5 種のルーター実装が同一インターフェースで差し替え可能であり、9 つのランタイムアダプターがコアを一切変更せず動作する構造は、プラットフォーム非依存フレームワークの設計として注目に値する。

## 背景にある原則

- **Web Standards を唯一の契約とする**: コアの入出力は `Request` と `Response`（Web 標準 API）のみに依存する。`fetch` メソッドのシグネチャ `(Request, Env?, ExecutionContext?) => Response | Promise<Response>` がランタイムとの唯一の接点であり、Cloudflare Workers の Module Worker 形式とそのまま一致する。この設計により、ランタイム固有の API への依存がコアから完全に排除され、新しいランタイムへの対応がアダプター追加のみで済む。根拠: `src/hono-base.ts:473-479`（fetch メソッド定義）。

- **インターフェースで差し替え可能にし、コアは実装詳細を知らない**: `Router<T>` インターフェースは `add` と `match` の 2 メソッドだけを定義する。コアクラス `HonoBase` はどのルーター実装が使われるか知らず、サブクラス（`Hono`, `preset/quick`, `preset/tiny`）がコンストラクタでルーターを注入する。これにより、パフォーマンス特性の異なる 5 つのルーター実装を同一コードベースに共存させている。根拠: `src/router.ts:29-52`（Router インターフェース）、`src/hono.ts:26-33`（デフォルト注入）。

- **ミドルウェアをファーストクラスの構成単位とする**: ハンドラーとミドルウェアの型は共通の `(Context, Next) => Response | Promise<Response>` に統一されており、`compose` 関数（koa-compose 由来）で線形に合成される。この統一により、認証・バリデーション・ルーティングが同一の合成メカニズムで処理され、特殊なプラグイン API が不要になっている。根拠: `src/compose.ts:15-73`。

- **アダプターはコアに依存し、コアはアダプターを知らない**: 依存の方向が常に「周辺→コア」であり逆転しない。adapter 層は `src/middleware/serve-static` や `src/helper/conninfo/types` などコアが定義した抽象に対して runtime 固有の実装を提供する。コアコードがランタイム検出や条件分岐を含まない。根拠: `src/adapter/bun/serve-static.ts`、`src/adapter/deno/serve-static.ts`。

## 実例と分析

### コアの薄さとレイヤー分離

コアは驚くほど少ないファイルで構成される: `hono-base.ts`（約 540 行）、`compose.ts`（73 行）、`context.ts`（約 770 行）、`request.ts`（約 490 行）、`router.ts`（約 100 行）。これらのファイル間の依存は一方向で、循環がない。

```
hono-base.ts → compose.ts, context.ts, router.ts (interface)
context.ts   → request.ts
request.ts   → router.ts (型のみ)
```

この構成は「コア層が周辺を知らない」というレイヤー原則を厳密に実現している。`hono-base.ts` は `Router<T>` インターフェースのみに依存し、5 つのルーター実装のいずれにも import を持たない。

### ルーターの Strategy パターンと SmartRouter の遅延選択

5 種のルーターは同一の `Router<T>` インターフェースを実装する:

| ルーター      | 特性                           | バンドルサイズへの影響 |
| ------------- | ------------------------------ | ---------------------- |
| RegExpRouter  | 高速だが一部パス未対応         | 大                     |
| TrieRouter    | 汎用・安定                     | 中                     |
| LinearRouter  | 登録が速い（初回マッチが遅い） | 小                     |
| PatternRouter | 最小サイズ                     | 最小                   |
| SmartRouter   | 実行時に最適なルーターを選択   | メタルーター           |

`SmartRouter` は初回の `match` 呼び出し時にルーター候補を順に試し、成功したルーターに `this.match` を差し替える（`src/router/smart-router/router.ts:46`）。これにより 2 回目以降のマッチングでは間接呼び出しのオーバーヘッドがゼロになる。

### プリセットによるエントリーポイント分岐

`Hono`（デフォルト）、`hono/quick`、`hono/tiny` はいずれも `HonoBase` を継承し、コンストラクタでルーターの組み合わせを変えるだけの薄いサブクラスである。プリセット全体が 10-25 行で完結する。

### アダプターの Template Method 的構造

`serve-static` ミドルウェアはコアに汎用実装があり（`src/middleware/serve-static/index.ts`）、ランタイム固有の `getContent` 関数をアダプターから注入する。Bun アダプターは `Bun.file()` を、Deno アダプターは `Deno.open()` を使い、同一のインターフェースに適合させる。`conninfo` も同様に、コアが `GetConnInfo` 型を定義し、各アダプターが `c.req.header('cf-connecting-ip')`（Cloudflare）や `server.requestIP()`（Bun）などランタイム固有の取得方法を実装する。

### ホットパスの最適化: 単一ハンドラーの高速パス

`hono-base.ts:424-442` で、マッチ結果が単一ハンドラーの場合は `compose` を呼ばず直接実行する。これはリクエスト処理のホットパスで不要な関数呼び出しと Promise 生成を避ける意図的な最適化である。

### Context による Facade パターン

`Context` クラスは Request の解析、Response の構築、環境変数の取得、変数ストアを一つのオブジェクトに集約する。ミドルウェアもハンドラーも `Context` を通じてのみリクエスト/レスポンスを操作し、Web 標準 API の低レベルな詳細を隠蔽する。

## コード例

```typescript
// src/router.ts:29-52 — コアが定義するルーターインターフェース（2メソッドのみ）
export interface Router<T> {
  name: string;
  add(method: string, path: string, handler: T): void;
  match(method: string, path: string): Result<T>;
}
```

```typescript
// src/hono.ts:16-33 — デフォルトプリセットはコンストラクタでルーターを注入するだけ
export class Hono<
  E extends Env = BlankEnv,
  S extends Schema = BlankSchema,
  BasePath extends string = "/",
> extends HonoBase<E, S, BasePath> {
  constructor(options: HonoOptions<E> = {}) {
    super(options);
    this.router = options.router
      ?? new SmartRouter({
        routers: [new RegExpRouter(), new TrieRouter()],
      });
  }
}
```

```typescript
// src/router/smart-router/router.ts:38-49 — 初回マッチ時にメソッドを差し替え、以後は直接呼び出し
res = router.match(method, path);
// ...
this.match = router.match.bind(router);
this.#routers = [router];
this.#routes = undefined;
```

```typescript
// src/hono-base.ts:424-442 — 単一ハンドラーの高速パス（compose をバイパス）
if (matchResult[0].length === 1) {
  let res: ReturnType<H>;
  try {
    res = matchResult[0][0][0][0](c, async () => {
      c.res = await this.#notFoundHandler(c);
    });
  } catch (err) {
    return this.#handleError(err, c);
  }
  return res instanceof Promise
    ? res
      .then(
        (resolved: Response | undefined) => resolved || (c.finalized ? c.res : this.#notFoundHandler(c)),
      )
      .catch((err: Error) => this.#handleError(err, c))
    : (res ?? this.#notFoundHandler(c));
}
```

```typescript
// src/adapter/bun/serve-static.ts:4-31 — アダプターはコアの汎用実装に runtime 固有の関数を注入
import { serveStatic as baseServeStatic } from "../../middleware/serve-static";

export const serveStatic = <E extends Env = Env>(
  options: ServeStaticOptions<E>,
): MiddlewareHandler => {
  return async function serveStatic(c, next) {
    const getContent = async (path: string) => {
      const file = Bun.file(path);
      return (await file.exists()) ? file : null;
    };
    return baseServeStatic({ ...options, getContent, join, isDir })(c, next);
  };
};
```

## パターンカタログ

- **Strategy** (分類: 振る舞い)
  - 解決する問題: パフォーマンス特性・制約が異なる複数のルーティングアルゴリズムの共存
  - 適用条件: 同一インターフェースを満たす複数の実装が存在し、利用者またはシステムが選択する必要がある場合
  - コード例: `src/router.ts:29-52`（Router インターフェース）、`src/router/*/router.ts`（5 実装）
  - 注意点: SmartRouter による実行時選択は初回コストがある。パフォーマンスクリティカルなシステムでは、ウォームアップリクエストを送るか明示的にルーターを指定する

- **Template Method** (分類: 振る舞い / 変形: 関数注入型)
  - 解決する問題: ランタイム依存のファイルシステムアクセスをコア実装から分離
  - 適用条件: アルゴリズムの骨格は共通だが、特定のステップだけランタイムごとに異なる場合
  - コード例: `src/middleware/serve-static/index.ts:34-125`（骨格）、`src/adapter/bun/serve-static.ts`（Bun 実装）
  - 注意点: クラス継承ではなく関数注入（`getContent`, `join`, `isDir`）で実現しており、古典的 Template Method より柔軟

- **Chain of Responsibility** (分類: 振る舞い)
  - 解決する問題: 認証・バリデーション・ロギングなど複数の横断関心事の順序付き処理
  - 適用条件: リクエスト処理パイプラインに可変数のプロセッサを挿入する必要がある場合
  - コード例: `src/compose.ts:15-73`（koa-compose ベース）
  - 注意点: `next()` を複数回呼ぶとエラーになるガード（compose.ts:34）がある。これにより処理の二重実行を防止

- **Facade** (分類: 構造)
  - 解決する問題: Request/Response の低レベル操作をミドルウェア開発者から隠蔽
  - 適用条件: 複数の API を統合した簡易インターフェースをクライアントに提供したい場合
  - コード例: `src/context.ts:283-770`（Context クラス）
  - 注意点: Facade が肥大化するリスクがある。Context は約 770 行あり、これ以上の機能追加は分割を検討すべき

## Good Patterns

- **最小インターフェースによる差し替え可能性**: `Router<T>` は `add` と `match` の 2 メソッドのみ。この最小さがバリエーション（5 実装 + SmartRouter）の爆発的増加を可能にしている。インターフェースのメソッド数が少ないほど、実装のバリエーションを増やしやすい。

```typescript
// src/router.ts:29-52
export interface Router<T> {
  name: string;
  add(method: string, path: string, handler: T): void;
  match(method: string, path: string): Result<T>;
}
```

- **実行時メソッド差し替えによるオーバーヘッド除去**: SmartRouter が初回マッチ後に `this.match = router.match.bind(router)` でメソッドを直接差し替える。2 回目以降は中間層が消え、選択されたルーターが直接呼ばれる。

```typescript
// src/router/smart-router/router.ts:46-48
this.match = router.match.bind(router);
this.#routers = [router];
this.#routes = undefined;
```

- **Object.create(null) の一貫した使用**: ルーター実装全体で `Object.create(null)` をプロトタイプなしオブジェクト生成に使用し、プロトタイプチェーン走査を回避している。パラメータマップ・静的ルートマップ・キャッシュすべてでこのパターンを徹底している。

```typescript
// src/router/reg-exp-router/router.ts:51
const staticMap: StaticMap<T> = Object.create(null);
// src/router/trie-router/node.ts:16
const emptyParams = Object.create(null);
// src/router/linear-router/router.ts:7
const emptyParams = Object.create(null);
```

- **サブクラスではなく関数注入による拡張点の提供**: `serveStatic` がクラス継承ではなく `getContent` 関数の注入でランタイム差異を吸収する。これによりアダプターは 10-30 行で完結する。

```typescript
// src/adapter/deno/serve-static.ts:8-42
export const serveStatic = <E extends Env = Env>(
  options: ServeStaticOptions<E>,
): MiddlewareHandler => {
  return async function serveStatic(c, next) {
    const getContent = async (path: string) => {
      const file = await open(path);
      return file.readable;
    };
    return baseServeStatic({ ...options, getContent, join, isDir })(c, next);
  };
};
```

## Anti-Patterns / 注意点

- **コア型定義の肥大化**: `src/types.ts` は 800 行超の巨大ファイルであり、型レベルプログラミングが多用されている。`HandlerInterface` は HTTP メソッドごとに 10 個以上のオーバーロードを持ち、可読性と TypeScript コンパイル速度に影響する。

```typescript
// Bad: 1 ファイルに全型定義を集約
// src/types.ts — 800行超、HandlerInterface だけで数百行のオーバーロード

// Better: 関心ごとにファイル分割
// src/types/env.ts
// src/types/handler.ts
// src/types/schema.ts
```

- **Context クラスの責務集中**: Context は Request ラッパー、Response ビルダー、変数ストア、レンダラー管理を一つのクラスに持つ。現在約 770 行で、新機能追加のたびに肥大化するリスクがある。

```typescript
// Bad: 一つのクラスに多数の責務
class Context {
  req, res, env, var, render, setLayout, getLayout, setRenderer,
  header, status, set, get, body, text, json, html, redirect, notFound
}

// Better: 責務ごとに委譲
// Context が ResponseBuilder を内部で持ち、c.response.json() のように委譲する
```

## 導出ルール

- `[MUST]` フレームワークコアの入出力はプラットフォーム標準 API（Web Standards の Request/Response 等）のみに依存させ、ランタイム固有の API はアダプター層に隔離する
  - 根拠: Hono のコア（hono-base.ts, compose.ts, context.ts）はランタイム固有の import を一切含まず、9 つのランタイム対応をアダプター追加のみで実現している（src/adapter/*/）

- `[MUST]` 差し替え可能にしたいコンポーネントのインターフェースは、必要最小限のメソッドに絞る（目安: 3 メソッド以内）
  - 根拠: Router インターフェースが `add` と `match` の 2 メソッドだけであることが、5 種のルーター実装と SmartRouter による動的選択を成立させている（src/router.ts:29-52）

- `[SHOULD]` ホットパスでは頻出のケースを特別扱いする早期リターンを設ける（例: 単一ハンドラーなら合成処理をスキップ）
  - 根拠: hono-base.ts:424 で matchResult が単一の場合に compose をバイパスし、不要な async/Promise 生成を回避している

- `[SHOULD]` ホットパスで参照されるオブジェクトリテラルは `Object.create(null)` で生成し、プロトタイプチェーン走査を回避する
  - 根拠: 全 5 ルーター実装で params マップ・キャッシュに `Object.create(null)` を徹底使用している（src/router/*/router.ts）

- `[SHOULD]` クラス継承による拡張点提供より、関数注入（コールバック / 高階関数）を優先する。特にランタイム差異の吸収やテスト容易性の確保に有効
  - 根拠: serveStatic がクラス継承ではなく `getContent` 関数注入でランタイム差異を吸収し、各アダプターが 10-30 行で完結している（src/middleware/serve-static/index.ts, src/adapter/*/serve-static.ts）

- `[SHOULD]` 一度だけ実行すればよい判定処理は、初回実行時にメソッドやクロージャを差し替えて 2 回目以降のオーバーヘッドをゼロにする
  - 根拠: SmartRouter が初回 match 時にルーターを決定し、this.match を直接差し替えることで以後の間接呼び出しコストを除去している（src/router/smart-router/router.ts:46）

- `[AVOID]` 単一の型定義ファイルに 500 行以上の型を集約すること。コンパイル速度低下と可読性悪化を招く
  - 根拠: src/types.ts は 800 行超で、HandlerInterface のオーバーロードだけで数百行を占め、IDE のパフォーマンスにも影響する

## 適用チェックリスト

- [ ] フレームワーク/ライブラリのコアが特定のランタイム API に直接依存していないか確認する
- [ ] 差し替え可能にしたいコンポーネントに対して、最小限のインターフェース（3 メソッド以内）を定義しているか確認する
- [ ] ミドルウェア/プラグインのシグネチャが統一されており、共通の合成メカニズムで処理できるか確認する
- [ ] ホットパスで頻出のケース（例: 単一ハンドラー、キャッシュヒット）に対する早期リターンを設けているか確認する
- [ ] ランタイム差異をアダプター層に隔離し、コアコードに条件分岐（`if (runtime === 'bun')`）が混入していないか確認する
- [ ] 拡張点がクラス継承ではなく関数注入で提供されており、利用者が薄いアダプターで済むか確認する
- [ ] 型定義ファイルが肥大化していないか（500 行以上なら分割を検討）確認する
