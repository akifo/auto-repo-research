# architecture

> リポジトリ: trpc/trpc
> 分析日: 2026-02-24

## 概要

tRPC の 3 層アーキテクチャ（server / client / React 統合）を横断的に分析した。
注目に値するのは、ランタイム実装をフレームワーク非依存のコア（`unstable-core-do-not-import/`）に集約し、アダプタ・クライアント・UI 統合の各層を「型のみの依存」と「Proxy による透過 API」の 2 つの仕組みで結合している点である。
この設計により、8 種類のサーバーアダプタと 3 つの UI 統合パッケージを、コアコードの重複なく維持している。

## 背景にある原則

- **公開 API を最小化し、内部を自由に変更可能にする**: コアモジュールは `unstable-core-do-not-import/` というディレクトリ名で「直接インポートしてはならない」ことを明示し、公開 API は `@trpc/server` パッケージルートと `@trpc/server/http` サブパスに限定している。ESLint ルールでアダプタから `unstable-core-do-not-import` への直接インポートを禁止し（`eslint.config.js:173-189`）、エイリアスモジュール `src/@trpc/server/` 経由でのみ参照させることで、内部リファクタリング時の影響範囲を制限している。

- **依存は型レベルで結合し、ランタイム結合を最小化する**: `@trpc/client` は `@trpc/server` から `import type` で型のみをインポートし、ランタイム依存は `observable` と `transformResult` など最小限に抑えている。React 統合層もクライアント層を薄くラップするだけで、サーバー型を直接参照する。この型レベル結合により、クライアントバンドルにサーバーコードが含まれない。

- **フレームワーク固有処理をコアから排除する**: HTTP リクエスト処理の核である `resolveResponse()` は Web 標準の `Request`/`Response` のみを扱い、Express の `req`/`res` や AWS Lambda のイベント型はアダプタ層で変換する。コアが特定のフレームワーク型を知らないことで、新しいアダプタの追加がコア変更なしで可能になっている。

- **Proxy で API の形状を宣言的に構築する**: `createRecursiveProxy` と `createFlatProxy` の 2 種類の Proxy を使い、サーバー側のルーター構造をクライアント側で透過的に再現する。プロパティアクセスのパスを蓄積し、最終的な関数呼び出し時にそのパスを RPC コールに変換する。これにより、型安全なクライアント API をコード生成なしで実現している。

## 実例と分析

### 3 層の依存方向と境界設計

tRPC のパッケージ間依存は厳密に一方向に制御されている。

| 層 | パッケージ | 依存先 |
|---|---|---|
| Core | `@trpc/server` (unstable-core) | 外部依存なし |
| Adapter | `@trpc/server/adapters/*` | Core（エイリアス `@trpc/server` 経由） |
| Client | `@trpc/client` | Core の型 + observable/rpc のランタイム |
| UI Integration | `@trpc/react-query`, `@trpc/tanstack-react-query` | Client + Core の型 |

依存方向の強制は ESLint の `no-restricted-imports` ルールで実現している。`eslint.config.js` でアダプタファイルからの `@trpc/server` 直接インポートと `unstable-core-do-not-import` 直接インポートの両方を禁止し、代わりにパッケージ内のエイリアスモジュール（`src/@trpc/server/index.ts` 等）経由のインポートを強制している。

### エイリアスモジュールによる公開 API の制御

`packages/server/src/@trpc/server/index.ts` は `unstable-core-do-not-import` のすべてではなく、選択的にエクスポートし、さらに命名規則を統一している（例: `AnyRouter` を `AnyTRPCRouter` として再エクスポート）。このパターンにより:

1. アダプタ作者が参照すべき API が明確になる
2. 内部型の名前変更がパブリック API に影響しない
3. 各ファイル冒頭のコメントで外部アダプタ作者向けのインポートガイドを提供できる

### resolveResponse: フレームワーク非依存コアの設計

`resolveResponse()` は Web 標準 `Request` を受け取り `Response` を返す純粋な関数である。各アダプタの役割は「フレームワーク固有のリクエスト型を `Request` に変換する」ことに限定される:

- **Fetch アダプタ**: `Request` をそのまま渡す（変換不要）
- **Node HTTP アダプタ**: `incomingMessageToRequest()` で `IncomingMessage` を `Request` に変換
- **AWS Lambda アダプタ**: Lambda イベントを `Request` に変換
- **Express アダプタ**: Node HTTP アダプタに委譲

### Proxy による透過的 API の実現

`createRecursiveProxy` はプロパティアクセスのパスを配列として蓄積し、関数呼び出し時にコールバックへ渡す。この仕組みが 3 箇所で活用されている:

1. **クライアント** (`createTRPCClient.ts`): `client.user.getById.query(...)` のアクセスパスを `["user", "getById", "query"]` として蓄積し、最後の要素 `query` をプロシージャタイプに変換
2. **サーバーサイドコーラー** (`router.ts` の `createCallerFactory`): 同じ Proxy 構造でサーバー内からプロシージャを呼び出す
3. **React 統合** (`decorationProxy.ts`): `.useQuery()` / `.useMutation()` を最終呼び出しとして検出し、React Query のフックに変換

### InferrableClientTypes: 柔軟な型推論の設計

`InferrableClientTypes` 型は `RouterLike | InitLike | RootConfigLike | AnyClientTypes` のユニオンで、異なるオブジェクト形状から一貫して `errorShape` と `transformer` を抽出する。これにより、クライアント API の型パラメータとして「ルーター」「initTRPC の戻り値」「設定オブジェクト」のいずれも受け入れられる。

### パーサー抽象: バリデーションライブラリ非依存

`parser.ts` の `getParseFn()` は Zod, Valibot, ArkType, Yup, Superstruct, Standard Schema v1 など 8 種類以上のバリデータ形状をダックタイピングで検出し、統一的な `ParseFn<T>` に変換する。特定のバリデーションライブラリへの依存を回避しつつ、型推論を維持している。

## コード例

```typescript
// packages/server/src/unstable-core-do-not-import/createProxy.ts:19-57
// Proxy パス蓄積の仕組み: プロパティアクセスを path 配列に蓄積し、
// 関数呼び出し時にコールバックへ渡す
function createInnerProxy(
  callback: ProxyCallback,
  path: readonly string[],
  memo: Record<string, unknown>,
) {
  const cacheKey = path.join('.');
  memo[cacheKey] ??= new Proxy(noop, {
    get(_obj, key) {
      if (typeof key !== 'string' || key === 'then') {
        return undefined;
      }
      return createInnerProxy(callback, [...path, key], memo);
    },
    apply(_1, _2, args) {
      // ... call/apply の特殊処理
      freezeIfAvailable(opts.args);
      freezeIfAvailable(opts.path);
      return callback(opts);
    },
  });
  return memo[cacheKey];
}
```

```typescript
// packages/server/src/@trpc/server/http.ts:1-27
// エイリアスモジュール: コア内部の API を選択的に再エクスポート
export {
  getHTTPStatusCode,
  getHTTPStatusCodeFromError,
  resolveResponse,
} from '../../unstable-core-do-not-import';
export type {
  BaseHandlerOptions,
  HTTPBaseHandlerOptions,
  // ...
} from '../../unstable-core-do-not-import';
```

```typescript
// eslint.config.js:173-189
// アダプタからのコアへの直接インポートを ESLint で禁止
{
  files: ['packages/server/src/adapters/**/*'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          { group: ['@trpc/server'] },
          {
            group: ['unstable-core-do-not-import'],
            message: 'Use e.g. `../@trpc/server/http` instead',
          },
        ],
      },
    ],
  },
},
```

```typescript
// packages/server/src/adapters/fetch/fetchRequestHandler.ts:24-80
// Fetch アダプタ: resolveResponse への薄い委譲
export async function fetchRequestHandler<TRouter extends AnyRouter>(
  opts: FetchHandlerRequestOptions<TRouter>,
): Promise<Response> {
  const resHeaders = new Headers();
  const createContext = async (innerOpts) => {
    return opts.createContext?.({ req: opts.req, resHeaders, ...innerOpts });
  };
  const path = trimSlashes(pathname.slice(endpoint.length));
  return await resolveResponse({
    ...opts,
    req: opts.req,
    createContext,
    path,
    error: null,
    // ...
  });
}
```

```typescript
// packages/server/src/unstable-core-do-not-import/utils.ts:44-46
// プロトタイプなしオブジェクト生成: __proto__ 汚染を防ぐ
export function emptyObject<TObj extends Record<string, unknown>>(): TObj {
  return Object.create(null);
}
```

## パターンカタログ

- **Builder パターン** (生成)
  - 解決する問題: 複雑な設定（コンテキスト型、メタデータ型、トランスフォーマー、エラーフォーマッタ）を段階的に型安全に構築する
  - 適用条件: 設定項目が多く、各ステップで型パラメータを狭めていく必要がある場合
  - コード例: `packages/server/src/unstable-core-do-not-import/initTRPC.ts:117-215` の `TRPCBuilder` クラス。`.context<T>()` で新しい Builder を返し、`.create()` で最終オブジェクトを生成
  - 注意点: Builder の各メソッドは新しいインスタンスを返す（イミュータブル）。既存インスタンスを変異させない

- **Chain of Responsibility パターン** (振る舞い)
  - 解決する問題: ミドルウェア、入力バリデーション、出力バリデーション、リゾルバを統一的に連鎖実行する
  - 適用条件: リクエスト処理に複数の横断的関心事を挟み込む必要がある場合
  - コード例: `packages/server/src/unstable-core-do-not-import/procedureBuilder.ts:634-672` の `callRecursive()`。ミドルウェア配列を再帰的に呼び出し、`next()` で次に進む
  - 注意点: 入力バリデーションも出力バリデーションもミドルウェアとして実装されており（`createInputMiddleware`, `createOutputMiddleware`）、統一的なパイプラインを形成する

- **Proxy パターン** (構造)
  - 解決する問題: サーバー側のルーター構造をクライアント側で型安全に再現する（コード生成なし）
  - 適用条件: オブジェクトのプロパティアクセスパターンを別の操作に変換したい場合
  - コード例: `packages/server/src/unstable-core-do-not-import/createProxy.ts:19-57`
  - 注意点: `then` プロパティへのアクセスは `undefined` を返す（`Promise.resolve(proxy)` でプロキシが thenable と誤認されるのを防ぐ）

- **Adapter パターン** (構造)
  - 解決する問題: Express, Fastify, AWS Lambda など異なるフレームワークの入出力を統一的なインターフェースに変換する
  - 適用条件: コアロジックをフレームワーク非依存に保ちたい場合
  - コード例: `packages/server/src/adapters/node-http/nodeHTTPRequestHandler.ts:72-121`（Node.js HTTP → Web 標準 Request への変換）
  - 注意点: コアは Web 標準 API（`Request`/`Response`）を正規化ターゲットとしている。Web 標準への収束を前提にした設計

## Good Patterns

- **エイリアスモジュールによる API 境界の明示**: `src/@trpc/server/` ディレクトリにエイリアスファイルを配置し、内部エクスポートをフィルタリング・リネームして公開する。ESLint ルールと組み合わせて「このパスからしかインポートできない」ことを強制する。

```typescript
// packages/server/src/@trpc/server/index.ts:12-13
// 内部名 → 公開名のリネーム
export {
  createFlatProxy as createTRPCFlatProxy,
  createRecursiveProxy as createTRPCRecursiveProxy,
  type AnyRouter as AnyTRPCRouter,
  // ...
} from '../../unstable-core-do-not-import';
```

- **`Object.create(null)` によるプロトタイプなしオブジェクト**: ルーターのプロシージャマップなど、動的にキーが追加されるオブジェクトには `Object.create(null)` を使い、プロトタイプチェーン汚染と `hasOwnProperty` チェック漏れを防止する。

```typescript
// packages/server/src/unstable-core-do-not-import/utils.ts:44-46
export function emptyObject<TObj extends Record<string, unknown>>(): TObj {
  return Object.create(null);
}
// router.ts:268 での使用例
const procedures: Record<string, AnyProcedure> = emptyObject();
```

- **`then` ガードによる Proxy の安全性**: `createRecursiveProxy` と `createFlatProxy` の両方で、`key === 'then'` のアクセスに `undefined` を返す。JavaScript の `Promise.resolve()` がオブジェクトの `.then` メソッドを検査する仕様への対策。

```typescript
// packages/server/src/unstable-core-do-not-import/createProxy.ts:28-32
get(_obj, key) {
  if (typeof key !== 'string' || key === 'then') {
    return undefined;
  }
  return createInnerProxy(callback, [...path, key], memo);
},
```

- **ダックタイピングによるバリデータ統合**: `getParseFn()` は `parseAsync` / `parse` / `validateSync` / `create` / `assert` / `~standard` の存在をチェックし、適切なパース関数を返す。特定ライブラリへの `instanceof` チェックや `import` を避け、ユーザーが任意のバリデータを使える柔軟性を提供する。

```typescript
// packages/server/src/unstable-core-do-not-import/parser.ts:84-140
export function getParseFn<TType>(procedureParser: Parser): ParseFn<TType> {
  const parser = procedureParser as any;
  if (typeof parser.parseAsync === 'function') return parser.parseAsync.bind(parser);
  if (typeof parser.parse === 'function') return parser.parse.bind(parser);
  // ... 8種類のバリデータ形状を検出
}
```

## Anti-Patterns / 注意点

- **アダプタから内部モジュールへの直接インポート**: ESLint で禁止されているにもかかわらず、Node HTTP アダプタや Express アダプタなど一部のファイルで `// eslint-disable-next-line no-restricted-imports` コメントによる例外が存在する。これは `run` や `getErrorShape` など、エイリアスモジュールで公開されていないユーティリティへのアクセスが必要な場合に発生している。

```typescript
// Bad: eslint-disable によるルール回避が散在
// packages/server/src/adapters/node-http/nodeHTTPRequestHandler.ts:20-21
// eslint-disable-next-line no-restricted-imports
import { getErrorShape, run } from '../../unstable-core-do-not-import';

// Better: エイリアスモジュールに必要な API を追加してから使用する
// packages/server/src/@trpc/server/index.ts に追加
export { run, getErrorShape } from '../../unstable-core-do-not-import';
```

- **`any` の多用による型安全性の穴**: Builder パターンの内部実装（`createNewBuilder`, `createResolver`）で `as any` キャストが頻出する。パブリック API は型安全だが、内部ではジェネリクスの複雑さを `any` で吸収しており、内部コード変更時に型による保護が効かない。

```typescript
// Bad: 内部の any キャスト
// packages/server/src/unstable-core-do-not-import/procedureBuilder.ts:547
return createResolver(
  { ..._def, type: 'query' },
  resolver,
) as AnyQueryProcedure;

// Better: 内部型を正確に定義するか、ブランド型で安全性を保つ
```

## 導出ルール

- `[MUST]` コアロジックの入出力を Web 標準 API（Request/Response）または言語標準型に正規化し、フレームワーク固有型をアダプタ層に閉じ込める
  - 根拠: tRPC の `resolveResponse()` は `Request`→`Response` の純粋関数であり、Express・Fastify・Lambda 等 8 種のアダプタをコア変更なしで提供している（`packages/server/src/adapters/` 全ファイル）

- `[MUST]` パッケージ内部のモジュールへの直接インポートをリンターで禁止し、公開 API を明示的なエイリアスモジュール経由に制限する
  - 根拠: tRPC は `eslint.config.js:173-189` で `no-restricted-imports` ルールにより `unstable-core-do-not-import` への直接アクセスをアダプタから禁止し、エイリアス `@trpc/server/http` 等を経由させることで内部リファクタリングの影響を局所化している

- `[SHOULD]` 外部ライブラリとの統合ポイントではインターフェースチェック（ダックタイピング）を使い、特定ライブラリへの `import` / `instanceof` 依存を避ける
  - 根拠: tRPC の `getParseFn()` は `parseAsync`/`parse`/`validateSync` 等のメソッド存在チェックで 8 種以上のバリデータを統合しており、ユーザーのバリデータ選択を制約しない（`parser.ts:84-140`）

- `[SHOULD]` 動的にキーが追加されるルックアップ用オブジェクトには `Object.create(null)` を使い、プロトタイプチェーン由来の衝突を防ぐ
  - 根拠: tRPC のプロシージャマップ・Proxy メモ等で `emptyObject()`（= `Object.create(null)`）を一貫使用し、`toString` や `constructor` などの予約キーとの衝突を防止している（`utils.ts:44-46`）

- `[SHOULD]` Proxy ベースの API では `then` プロパティアクセスに `undefined` を返し、オブジェクトが thenable と誤認されるのを防ぐ
  - 根拠: JavaScript の `Promise.resolve(obj)` は `obj.then` が関数なら thenable として扱うため、Proxy が `then` に応答すると予期しない挙動を起こす。tRPC は `createRecursiveProxy` と `createFlatProxy` の両方でこのガードを実装している（`createProxy.ts:28-32, 79-83`）

- `[AVOID]` パッケージ間の依存で `import type` ではなくランタイム `import` を使い、クライアントバンドルにサーバーコードを混入させること
  - 根拠: `@trpc/client` は `@trpc/server/unstable-core-do-not-import` から主に `import type` で型のみを取得し、ランタイム依存は `observable` と `transformResult` 等の最小限に抑えている。これによりクライアントバンドルサイズを最適化している

## 適用チェックリスト

- [ ] パッケージ内部にフレームワーク非依存のコアモジュールを定義し、フレームワーク固有処理をアダプタ層に分離しているか
- [ ] 公開 API と内部 API の境界をエイリアスモジュール（barrel export の選択的サブセット）で明示し、リンターで直接インポートを禁止しているか
- [ ] パッケージ間の依存で型のみの参照には `import type` を使い、ランタイム依存を最小化しているか
- [ ] Proxy を使う場合、`then` プロパティへのアクセスで `undefined` を返すガードを実装しているか
- [ ] 外部ライブラリ統合ではダックタイピングを使い、特定ライブラリへのハードコード依存を避けているか
- [ ] 動的なキーバリューストアには `Object.create(null)` を使い、プロトタイプ汚染を防いでいるか
- [ ] モノレポの依存方向が一方向であることをリンタールールで強制しているか
