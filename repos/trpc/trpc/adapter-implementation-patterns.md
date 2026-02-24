# adapter-implementation-patterns

> リポジトリ: trpc/trpc
> 分析日: 2026-02-24

## 概要

tRPC は 8 以上のフレームワーク向けアダプター（Express, Fastify, Fetch, Next.js, Next App Dir, Standalone, AWS Lambda, WebSocket）を提供しつつ、プロトコル処理の核心は `resolveResponse()` という単一関数に集約している。各アダプターの責務は「フレームワーク固有のリクエストを Web Standard `Request` に変換し、`resolveResponse()` に委譲し、得られた `Response` をフレームワークの応答に書き戻す」ことだけであり、最も単純な Fetch アダプターは実質 20 行程度で完結する。この設計により、サードパーティが独自アダプターを作成可能な拡張モデルを実現している。

## 背景にある原則

- **Web Standard を正準表現とする**: フレームワーク固有の型（`express.Request`, `FastifyRequest`, `APIGatewayProxyEvent` 等）を最初に Web Standard `Request`/`Response` に正規化し、以降の処理は一切フレームワークを意識しない。これにより「N 個のフレームワーク x M 個の機能」の組み合わせ爆発を回避している（`resolveResponse.ts:218-220`）

- **アダプターは「薄い翻訳層」に徹する**: アダプターにはビジネスロジック・プロトコル解析・エラーハンドリングを一切書かせない。Express アダプター全体が 48 行、Fetch アダプターが 80 行であることからも分かるように、アダプターコードが小さいほどバグの入り込む余地が減り、メンテナンスコストも低い

- **lint ルールによるアーキテクチャ境界の強制**: ESLint の `no-restricted-imports` で `packages/server/src/adapters/**/*` から `unstable-core-do-not-import` への直接 import を禁止し、代わりに `src/@trpc/server/` と `src/@trpc/server/http` というエイリアスディレクトリ経由の import を強制している。これはサードパーティアダプター作者が `@trpc/server` と `@trpc/server/http` からのみ import すれば済む状態を内部コードでも再現するための設計判断である（`eslint.config.js:173-191`）

- **レイヤード・アダプター合成**: Node.js HTTP 系のフレームワーク（Express, Next.js Pages, Standalone）は `nodeHTTPRequestHandler` を共通の中間レイヤーとして共有し、その中で `incomingMessageToRequest` による変換と `writeResponse` による応答書き戻しを行う。つまりアダプターの階層が「フレームワーク固有層 -> Node HTTP 共通層 -> resolveResponse」の 3 層構造になっており、コードの重複を排除している

## 実例と分析

### アダプター構造の比較

すべての HTTP アダプターは同一のパターンに従う:

1. **リクエスト変換**: フレームワーク固有のリクエストオブジェクトを Web Standard `Request` に変換
2. **コンテキスト生成関数の作成**: `ResolveHTTPRequestOptionsContextFn` を実装して `createContext` をラップ
3. **`resolveResponse()` への委譲**: 変換済み `Request` とコンテキスト生成関数を渡す
4. **レスポンス書き戻し**: 得られた `Response` をフレームワーク固有の応答に変換

| アダプター | 変換方式 | resolveResponse 呼び出し | 応答処理 |
|---|---|---|---|
| Fetch | 不要（既に `Request`） | 直接呼び出し | `Response` をそのまま返却 |
| Node HTTP | `incomingMessageToRequest()` | `nodeHTTPRequestHandler` 経由 | `writeResponse()` |
| Express | Node HTTP に委譲 | `nodeHTTPRequestHandler` 経由 | `writeResponse()` |
| Next.js Pages | Node HTTP に委譲 | `nodeHTTPRequestHandler` 経由 | `writeResponse()` |
| Standalone | Node HTTP に委譲 | `nodeHTTPRequestHandler` 経由 | `writeResponse()` |
| Fastify | `incomingMessageToRequest(req.raw)` | 直接呼び出し | `res.send(response)` |
| AWS Lambda | `getPlanner()` で `Request` 構築 | 直接呼び出し | `planner.toResult()` |
| WebSocket | 別アーキテクチャ | `callTRPCProcedure` 直接 | `client.send()` |

### `@trpc/server` エイリアスによるアーキテクチャ境界

`packages/server/src/@trpc/server/` ディレクトリは、npm パッケージ `@trpc/server` の公開 API をソースコード内部で再現するエイリアスである。内部的には `../../unstable-core-do-not-import` から re-export しているだけだが、アダプターコードにはこのエイリアス経由の import を強制することで、「サードパーティアダプターと同じ制約下でコードを書く」ことを保証している。

```ts
// packages/server/src/@trpc/server/http.ts:1-6
export {
  getHTTPStatusCode,
  getHTTPStatusCodeFromError,
  resolveResponse,
} from '../../unstable-core-do-not-import';
```

各アダプターファイルの冒頭にはサードパーティ向けの案内コメントが統一的に記載されている:

```ts
// packages/server/src/adapters/fetch/fetchRequestHandler.ts:1-9
/**
 * If you're making an adapter for tRPC and looking at this file for reference,
 * you should import types and functions from `@trpc/server` and `@trpc/server/http`
 */
```

### Node HTTP 共通レイヤー

Express, Next.js Pages, Standalone の 3 アダプターは、直接 `resolveResponse` を呼ぶ代わりに `nodeHTTPRequestHandler` という共通レイヤーを経由する。この関数が `IncomingMessage` から `Request` への変換（`incomingMessageToRequest`）と `Response` から Node.js の `res` への書き戻し（`writeResponse`）を担う。

```ts
// packages/server/src/adapters/node-http/nodeHTTPRequestHandler.ts:86-118
const request = incomingMessageToRequest(opts.req, opts.res, {
  maxBodySize: opts.maxBodySize ?? null,
});

const response = await resolveResponse({
  ...opts,
  req: request,
  error: err ? getTRPCErrorFromUnknown(err) : null,
  createContext,
  onError(o) {
    opts?.onError?.({
      ...o,
      req: opts.req,
    });
  },
});

await writeResponse({
  request,
  response,
  rawResponse: opts.res,
});
```

### AWS Lambda の Planner パターン

AWS Lambda は API Gateway v1 と v2 の 2 つの異なるイベント形式をサポートする必要がある。`getPlanner()` 関数がイベントのバージョンを判定し、適切な `Processor` を選択して `Request` の構築とレスポンスの変換を行う。Strategy パターンの適用例である。

```ts
// packages/server/src/adapters/aws-lambda/getPlanner.ts:38-45
interface Processor<TEvent extends LambdaEvent> {
  getTRPCPath: (event: TEvent) => string;
  url(event: TEvent): Pick<URL, 'hostname' | 'pathname' | 'search'>;
  getHeaders: (event: TEvent) => Headers;
  getMethod: (event: TEvent) => string;
  toResult: (response: Response) => Promise<inferAPIGWReturn<TEvent>>;
  toStream: (response: Response, stream: Writable) => Promise<void>;
}
```

### WebSocket アダプターの例外的設計

WebSocket アダプターは `resolveResponse` を使わず、`callTRPCProcedure` を直接呼び出す独自のメッセージループを実装している。これは HTTP の リクエスト-レスポンス モデルと WebSocket の双方向ストリームモデルの根本的な差異に起因する。ただし、エラーシェイプの生成（`getErrorShape`）やレスポンスの変換（`transformTRPCResponse`）は共通関数を使用しており、動作の一貫性は維持されている。

## パターンカタログ

- **Adapter パターン** (分類: 構造)
  - 解決する問題: フレームワーク固有のインターフェースをコアロジックが期待する統一インターフェースに変換する
  - 適用条件: 複数の外部システム/フレームワークに対応しつつ、コアロジックを単一に保ちたい場合
  - コード例: `fetchRequestHandler.ts:24-80`, `nodeHTTPRequestHandler.ts:72-121`
  - 注意点: 変換対象が Web Standard に近いほどアダプター層は薄くなる。Fetch アダプターはほぼパススルーだが、AWS Lambda アダプターは Processor インターフェースが必要

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 同一アダプター内で複数のプロトコルバリアント（API Gateway v1/v2）を扱う
  - 適用条件: 入力の形式がランタイムで決まり、変換ロジックがバリアントごとに異なる場合
  - コード例: `aws-lambda/getPlanner.ts:217-254`（`Processor` インターフェースと `v1Processor`/`v2Processor`）
  - 注意点: バリアント数が少ない場合は switch 文で十分だが、変換ロジックが複雑化する場合は Strategy に切り出すと各バリアントを独立してテスト可能になる

- **Facade パターン** (分類: 構造)
  - 解決する問題: `@trpc/server` エイリアスが内部モジュール（`unstable-core-do-not-import`）の複雑さを隠蔽し、アダプター作者に対して安定した最小 API を提供する
  - 適用条件: 内部 API が不安定で変更頻度が高いが、外部消費者には安定した契約を提供したい場合
  - コード例: `src/@trpc/server/http.ts:1-28`
  - 注意点: Facade の粒度が粗すぎると必要な機能にアクセスできず `eslint-disable` が増える。tRPC でも `nextAppDirCaller.ts` に `FIXME: fix lint rule` コメントが複数ある

## Good Patterns

- **最薄アダプターの模範としての Fetch アダプター**: Fetch アダプターはリクエストが既に Web Standard `Request` であるため、URL からパスを抽出して `resolveResponse` に渡すだけの最小実装になっている。新規アダプター作成時の出発点として最適。

```ts
// packages/server/src/adapters/fetch/fetchRequestHandler.ts:24-80
export async function fetchRequestHandler<TRouter extends AnyRouter>(
  opts: FetchHandlerRequestOptions<TRouter>,
): Promise<Response> {
  const resHeaders = new Headers();
  const createContext: ResolveHTTPRequestOptionsContextFn<TRouter> = async (
    innerOpts,
  ) => {
    return opts.createContext?.({ req: opts.req, resHeaders, ...innerOpts });
  };
  const url = new URL(opts.req.url);
  const pathname = trimSlashes(url.pathname);
  const endpoint = trimSlashes(opts.endpoint);
  const path = trimSlashes(pathname.slice(endpoint.length));

  return await resolveResponse({
    ...opts,
    req: opts.req,
    createContext,
    path,
    error: null,
    onError(o) { opts?.onError?.({ ...o, req: opts.req }); },
    responseMeta(data) { /* ... */ },
  });
}
```

- **onError コールバックでのリクエスト型差し替え**: すべてのアダプターは `onError` コールバック内で `req` をフレームワーク固有の元のリクエストオブジェクトに差し替えている。これにより、ユーザーの `onError` ハンドラーはフレームワーク固有の情報（Express の `req.cookies` など）にアクセスできる。

```ts
// packages/server/src/adapters/node-http/nodeHTTPRequestHandler.ts:105-109
onError(o) {
  opts?.onError?.({
    ...o,
    req: opts.req,  // Node.js IncomingMessage を渡す（Web Standard Request ではなく）
  });
},
```

- **`incomingMessageToRequest` の堅牢なボディ変換**: Node.js の `IncomingMessage` を `Request` に変換する際、プリパースされたボディ（Fastify がパースした JSON 等）とストリームボディの両方を透過的に処理している。`ReadableStream` でバックプレッシャー制御と `maxBodySize` 制限も組み込まれている。

```ts
// packages/server/src/adapters/node-http/incomingMessageToRequest.ts:6-72
function createBody(req: NodeHTTPRequest, opts: { maxBodySize: number | null }): RequestInit['body'] {
  if ('body' in req) {
    if (typeof req.body === 'string') return req.body;
    if (req.body instanceof IncomingMessage) return req.body as any;
    return JSON.stringify(req.body);
  }
  // ストリームとして ReadableStream を構築
  return new ReadableStream({ /* ... maxBodySize 制限付き */ });
}
```

## Anti-Patterns / 注意点

- **アダプター内にプロトコル判定ロジックを埋め込む**: アダプター内でバッチ処理やストリーミングの分岐を書くと、全アダプターで同じロジックを重複させることになる。tRPC ではこれを `resolveResponse` 内部に集約し、アダプターからは完全に隠蔽している。

```ts
// Bad: アダプター内でストリーム判定
async function myAdapter(req, res) {
  if (req.headers['trpc-accept'] === 'application/jsonl') {
    // ストリーム処理...
  } else {
    // 通常処理...
  }
}

// Better: コアに委譲
async function myAdapter(req, res) {
  const response = await resolveResponse({ req, /* ... */ });
  // コアがストリーム/通常の分岐を内部で処理する
}
```

- **Facade 層の粒度不足による `eslint-disable` の蔓延**: `@trpc/server` エイリアスが公開する API が不足していると、アダプターコード内で `// eslint-disable-next-line no-restricted-imports` を使って `unstable-core-do-not-import` から直接 import せざるを得なくなる。`nextAppDirCaller.ts` では 4 箇所の eslint-disable があり、`FIXME: fix lint rule` コメントも残されている。Facade を設計する際は、初期段階で全消費者のユースケースを洗い出す必要がある。

```ts
// Bad: packages/server/src/adapters/next-app-dir/nextAppDirCaller.ts:3-16
// eslint-disable-next-line no-restricted-imports
import { formDataToObject } from '../../unstable-core-do-not-import';
// FIXME: fix lint rule, this is ok
// eslint-disable-next-line no-restricted-imports
import type { ErrorHandlerOptions } from '../../unstable-core-do-not-import/procedure';
```

## 導出ルール

- `[MUST]` マルチフレームワーク対応のコアロジックは Web Standard（Request/Response）を正準インターフェースとして設計し、フレームワーク固有の型への依存を排除する
  - 根拠: tRPC の `resolveResponse` は `Request` のみを受け取り `Response` を返す設計により、8+ アダプターのコアロジックを完全に単一化している

- `[MUST]` アダプター層のアーキテクチャ境界は lint ルール（`no-restricted-imports` 等）で機械的に強制し、内部 API への直接依存を防止する
  - 根拠: tRPC は ESLint で `adapters/**/*` から `unstable-core-do-not-import` への直接 import を禁止し、サードパーティと同一の公開 API 制約をファーストパーティにも適用している

- `[SHOULD]` 同一ランタイム系列のアダプター間で共通する変換ロジックは中間レイヤーに抽出し、個別アダプターは「パス抽出 + 中間レイヤー呼び出し」のみに留める
  - 根拠: Express, Next.js Pages, Standalone の 3 アダプターは `nodeHTTPRequestHandler` を共有し、各自は 10-30 行のパス抽出コードのみを持つ

- `[SHOULD]` 新規アダプター作成者向けに、最も薄い実装（Fetch アダプター相当）をリファレンス実装として明示し、ファイル冒頭にサードパーティ向けの import ガイダンスをコメントで記載する
  - 根拠: tRPC の全アダプターファイルの冒頭には「`@trpc/server` と `@trpc/server/http` からインポートすべき」という統一コメントがある

- `[SHOULD]` フレームワーク固有のイベント形式に複数バリアントがある場合（API Gateway v1/v2 等）は、Processor/Planner インターフェースで Strategy パターンを適用し、各バリアントの変換ロジックを独立してテスト可能にする
  - 根拠: AWS Lambda アダプターの `getPlanner` は v1/v2 の差異を `Processor` インターフェースに隠蔽し、共通の `resolveResponse` 呼び出しコードの重複を排除している

- `[AVOID]` アダプター層にプロトコル処理（バッチ、ストリーミング、エラーシリアライゼーション）を実装すること。これらはコアの `resolveResponse` に集約し、アダプターは「変換 -> 委譲 -> 書き戻し」のみを行うべき
  - 根拠: tRPC の HTTP アダプターは全て `resolveResponse` にプロトコル処理を委譲しており、アダプター側でバッチやストリームの分岐を持つものは 1 つもない（WebSocket は通信モデルが根本的に異なるため例外）

## 適用チェックリスト

- [ ] コアロジックのインターフェースが Web Standard（Request/Response）に基づいているか確認する
- [ ] アダプター層の責務が「リクエスト変換 -> コア委譲 -> レスポンス書き戻し」に限定されているか確認する
- [ ] 同一ランタイム系列（Node.js HTTP 等）のアダプター間で共通の中間レイヤーを抽出できるか検討する
- [ ] lint ルールまたはアーキテクチャテストでアダプター -> コア内部 API への直接依存を禁止しているか確認する
- [ ] 最も薄いアダプター（Fetch 相当）をリファレンス実装として用意し、サードパーティ向けの import ガイダンスを記載する
- [ ] フレームワーク固有のバリアント（プロトコルバージョン差異等）がある場合、Strategy パターンで分離する
- [ ] `onError` 等のユーザー向けコールバックでは、変換前のフレームワーク固有リクエストを渡してデバッグ情報を維持する
