# proxy-based-type-inference

> リポジトリ: trpc/trpc
> 分析日: 2026-02-24

## 概要

tRPC は `Proxy` を使って、ランタイムにはパス文字列とメソッド呼び出しを動的に解決しつつ、TypeScript の型システム上では完全に型安全な API 表面を提供している。核となるのは `createRecursiveProxy<TFaux>` と `createFlatProxy<TFaux>` の 2 つのプリミティブで、わずか 87 行の実装からクライアント・サーバー・React Query・Next.js App Router の全統合レイヤーが構築されている。この「型はファサード、ランタイムは Proxy」という二重構造パターンは、型安全なルーティング・RPC・ORM など幅広い設計に応用できる。

## 背景にある原則

- **ファサード型による型安全性の外付け**: ランタイム実装（Proxy）と型シグネチャ（`TFaux` ジェネリクス）を完全に分離することで、実装を一切変えずに型だけで API 表面を制御できる。`createRecursiveProxy<TFaux>(callback)` の `TFaux` はコンパイル時にしか存在せず、ランタイムコストはゼロである（`createProxy.ts:65-67`）。

- **パス蓄積による遅延解決**: プロパティアクセスのたびに新しい Proxy を返してパスを蓄積し、関数呼び出し時にはじめてコールバックを実行する。これにより `trpc.user.byId.query(input)` のようなチェインが、実際には `callback({ path: ['user', 'byId', 'query'], args: [input] })` という単一の関数呼び出しに変換される。ルーターの深さやプロシージャの数に関係なく、Proxy の振る舞いは一定である。

- **関心の階層化（FlatProxy + RecursiveProxy）**: `createFlatProxy` は最上位の名前空間分離（`useUtils`, `Provider`, `client` 等のトップレベルプロパティ）を担当し、`createRecursiveProxy` はプロシージャのパス解決を担当する。この 2 層構造によって、Proxy の複雑さを分割統治している（`createTRPCReact.tsx:489-506`, `ssgProxy.ts:220-224`）。

- **末尾セグメントによるディスパッチ**: パスの最後のセグメント（`query`, `mutate`, `useQuery`, `fetch` 等）をメソッド種別として `pop()` で取り出し、残りのパスをプロシージャのドットパスとして結合する。このパターンにより、同一の Proxy 構造で異なるコンテキスト（クライアント・React Query・SSG）に対応できる。

## 実例と分析

### 2 つのプロキシプリミティブの設計

`createRecursiveProxy` は内部で `createInnerProxy` を再帰的に呼び出し、パスをイミュータブルな配列として蓄積する。プロキシのターゲットは `noop` 関数であり、`get` トラップと `apply` トラップの両方を捕捉できるようにしている。`createFlatProxy` は 1 階層のプロパティアクセスのみを処理し、ルーターのトップレベルプロパティ（ユーティリティメソッドやコンテキスト）と再帰プロキシを合成する。

この 2 つは独立して使えるが、tRPC では常に `createFlatProxy` が `createRecursiveProxy` をラップする形で組み合わせて使われる。これにより「トップレベルのメソッド群」と「深いプロシージャパス」を同一のオブジェクト上に共存させている。

### メモ化による Proxy 再生成の抑制

`createInnerProxy` は `memo` オブジェクト（`Object.create(null)` で生成）をキャッシュとして使い、同一パスへの再アクセス時に新しい Proxy を生成しない。キャッシュキーはパスの `.join('.')` であり、`memo[cacheKey] ??= new Proxy(...)` というヌル合体代入で遅延初期化される。この仕組みにより、同じプロシージャに繰り返しアクセスするコンポーネントでも Proxy の生成コストが一定に抑えられる。

### 末尾セグメント pop パターンの横断利用

パス配列の最後の要素を `pop()` で取り出してメソッド種別を判定するパターンが、7 つ以上のファイルで一貫して使われている。

- **クライアント**: `pathCopy.pop()` → `clientCallTypeToProcedureType` でメソッド名を `ProcedureType` に変換（`createTRPCClient.ts:143-144`）
- **サーバー caller**: パス全体を `.join('.')` してプロシージャ解決（`router.ts:454`）
- **React Query decoration**: `pathCopy.pop()` → `useQuery`, `useMutation` 等の React フック名として使用（`decorationProxy.ts:19`）
- **React Query utils**: `path.pop()` → `fetch`, `invalidate` 等のユーティリティ名として使用（`utilsProxy.ts:470`）
- **SSG helpers**: `arrayPath.pop()` → `fetch`, `prefetch` 等の SSG 操作名として使用（`ssgProxy.ts:166`）
- **Next.js App Router**: `pathCopy.pop()` → `clientCallTypeToProcedureType` で変換（`client.ts:38`, `server.ts:60`）

### reservedWords による Proxy 互換性の保護

`then`, `call`, `apply` の 3 つが予約語として定義され、ルーター/プロシージャ名に使用するとエラーが投げられる（`router.ts:210-221`）。これは Proxy の技術的制約に起因する:

- `then`: JavaScript は `.then` プロパティが存在するオブジェクトを PromiseLike として扱うため、`Promise.resolve(proxy)` が意図しない挙動になる
- `call` / `apply`: `Function.prototype` のメソッドと衝突し、Proxy の `apply` トラップで特別処理が必要になる

### 再帰的型マッピングによるファサード型の構築

`DecorateRouterRecord` / `DecoratedProcedureRecord` 型は、サーバー側のルーター定義を再帰的に走査し、各プロシージャの型を文脈に応じた API 表面に変換する。同じルーター定義 `TRecord` に対して、クライアント・React Query・SSG・utils それぞれが異なる `Decorate*` 型を適用している。

- クライアント: `{ query: Resolver<TDef> }` / `{ mutate: Resolver<TDef> }` / `{ subscribe: ... }`（`createTRPCClient.ts:76-91`）
- React Query: `{ useQuery: ..., useMutation: ..., useSubscription: ... }`（`createTRPCReact.tsx:403-417`）
- Utils: `{ fetch: ..., invalidate: ..., setData: ..., getData: ... }`（`utilsProxy.ts:64-409`）
- SSG: Utils のサブセット `Pick<DecorateQueryProcedure, SSGFns>`（`ssgProxy.ts:63-74`）

### ProtectedIntersection による名前衝突の静的検出

`createFlatProxy` で合成されるトップレベルプロパティとルーターの名前が衝突すると、`ProtectedIntersection` 型がコンパイルエラーメッセージ `"The property '...' in your router collides with a built-in method"` を返す（`types.ts:153-162`）。これはランタイムエラーではなく型エラーとして検出されるため、開発者が IDE 上で即座に気づける。

## コード例

```typescript
// packages/server/src/unstable-core-do-not-import/createProxy.ts:19-57
// パス蓄積型再帰 Proxy の核心実装
function createInnerProxy(
  callback: ProxyCallback,
  path: readonly string[],
  memo: Record<string, unknown>,
) {
  const cacheKey = path.join(".");

  memo[cacheKey] ??= new Proxy(noop, {
    get(_obj, key) {
      if (typeof key !== "string" || key === "then") {
        return undefined;
      }
      return createInnerProxy(callback, [...path, key], memo);
    },
    apply(_1, _2, args) {
      const lastOfPath = path[path.length - 1];
      let opts = { args, path };
      if (lastOfPath === "call") {
        opts = {
          args: args.length >= 2 ? [args[1]] : [],
          path: path.slice(0, -1),
        };
      } else if (lastOfPath === "apply") {
        opts = {
          args: args.length >= 2 ? args[1] : [],
          path: path.slice(0, -1),
        };
      }
      freezeIfAvailable(opts.args);
      freezeIfAvailable(opts.path);
      return callback(opts);
    },
  });

  return memo[cacheKey];
}
```

```typescript
// packages/client/src/createTRPCClient.ts:139-156
// FlatProxy + RecursiveProxy の合成パターン
export function createTRPCClientProxy<TRouter extends AnyRouter>(
  client: TRPCUntypedClient<TRouter>,
): TRPCClient<TRouter> {
  const proxy = createRecursiveProxy<TRPCClient<TRouter>>(({ path, args }) => {
    const pathCopy = [...path];
    const procedureType = clientCallTypeToProcedureType(pathCopy.pop()!);
    const fullPath = pathCopy.join(".");
    return (client[procedureType] as any)(fullPath, ...(args as any));
  });
  return createFlatProxy<TRPCClient<TRouter>>((key) => {
    if (key === untypedClientSymbol) {
      return client;
    }
    return proxy[key];
  });
}
```

```typescript
// packages/react-query/src/createTRPCReact.tsx:489-506
// React 統合での FlatProxy 合成 — トップレベルフック + プロシージャプロキシ
return createFlatProxy<CreateHooksInternal>((key) => {
  if (key === "useContext" || key === "useUtils") {
    return () => {
      const context = trpc.useUtils();
      return React.useMemo(() => {
        return (createReactQueryUtils as any)(context);
      }, [context]);
    };
  }
  if (trpc.hasOwnProperty(key)) {
    return (trpc as any)[key];
  }
  return proxy[key];
});
```

```typescript
// packages/tests/showcase/tinyrpc.ts:76-109
// 最小実装による Proxy パターンの教育的デモ
export const createTinyRPCClient = <TRouter extends AnyTRPCRouter>(
  baseUrl: string,
) =>
  createRecursiveProxy(async (opts) => {
    const path = [...opts.path];
    const method = path.pop()! as "mutate" | "query";
    const dotPath = path.join(".");
    // ... fetch ロジック
  }, []) as DecorateRouterRecord<TRouter["_def"]["record"]>;
```

## パターンカタログ

- **Proxy パターン** (分類: 構造)
  - 解決する問題: ランタイムの動的振る舞いに型安全なインターフェースを被せる
  - 適用条件: API の構造がサーバー側の定義から静的に推論でき、クライアント側では実体のないオブジェクトとして操作したい場合
  - コード例: `packages/server/src/unstable-core-do-not-import/createProxy.ts:65-67`
  - 注意点: `TFaux` キャストにより型安全性の責任がライブラリ実装者に移る。テストで振る舞いの一致を保証する必要がある

- **Facade パターン** (分類: 構造)
  - 解決する問題: 複雑なサブシステム（Untyped Client, QueryClient, Context）を統一的なインターフェースで隠蔽する
  - 適用条件: 複数の内部モジュールを単一の型安全な API 表面に統合したい場合
  - コード例: `packages/react-query/src/createTRPCReact.tsx:489-506`（`createFlatProxy` で hooks + proxy を合成）
  - 注意点: `ProtectedIntersection` で名前衝突を型レベルで検出しないと、ランタイムで予期せぬ上書きが起きる

- **Interpreter パターン** (分類: 振る舞い)
  - 解決する問題: `['user', 'byId', 'query']` のようなパスを言語として解釈し、末尾セグメントでディスパッチする
  - 適用条件: チェイン呼び出しを単一のコールバックに変換し、文脈ごとに異なる解釈をしたい場合
  - コード例: `packages/client/src/createTRPCClient.ts:142-148`, `packages/react-query/src/shared/proxy/utilsProxy.ts:468-517`
  - 注意点: 末尾セグメントのマッピング表（`clientCallTypeMap` 等）の網羅性を静的にチェックする仕組みが必要

## Good Patterns

- **noop 関数を Proxy ターゲットにする**: Proxy は `get` と `apply` の両トラップを捕捉する必要があるため、ターゲットを関数にする必要がある。空関数 `noop` をモジュールスコープで定義し全 Proxy で共有することで、ターゲットオブジェクトの生成コストをゼロにしている。

```typescript
// packages/server/src/unstable-core-do-not-import/createProxy.ts:9-11
const noop = () => {
  // noop
};
```

- **Object.freeze による引数の不変性保証**: コールバックに渡す `path` と `args` を `Object.freeze` することで、コールバック内での意図しない変更を防止している。テストでもこの不変性が検証されている。

```typescript
// packages/server/src/unstable-core-do-not-import/createProxy.ts:51-52
freezeIfAvailable(opts.args);
freezeIfAvailable(opts.path);
```

- **emptyObject() (Object.create(null)) によるプロトタイプ汚染の回避**: メモ化キャッシュや RouterRecord に `Object.create(null)` を使い、`Object.prototype` のプロパティ（`toString`, `hasOwnProperty` 等）がキーとして衝突するのを防止している。

```typescript
// packages/server/src/unstable-core-do-not-import/utils.ts:44-46
export function emptyObject<TObj extends Record<string, unknown>>(): TObj {
  return Object.create(null);
}
```

- **ProtectedIntersection によるコンパイル時名前衝突検出**: FlatProxy で合成されるトップレベルプロパティとルーター名が衝突した場合、型エラーメッセージで具体的なプロパティ名を報告する。

```typescript
// packages/server/src/unstable-core-do-not-import/types.ts:159-162
export type ProtectedIntersection<TType, TWith> =
  & keyof TType
  & keyof TWith extends never ? TType & TWith
  : IntersectionError<string & keyof TType & keyof TWith>;
```

## Anti-Patterns / 注意点

- **Proxy から `then` を返してしまう**: Proxy が `then` プロパティを持つと、`await proxy` や `Promise.resolve(proxy)` で PromiseLike として扱われ、無限再帰やハングが発生する。tRPC は全 Proxy で `then` アクセス時に `undefined` を返す防御を入れている。

```typescript
// Bad: then をそのまま再帰に回す
get(_obj, key) {
  return createInnerProxy(callback, [...path, key], memo);
}

// Better: then を明示的に除外する
get(_obj, key) {
  if (typeof key !== 'string' || key === 'then') {
    return undefined;
  }
  return createInnerProxy(callback, [...path, key], memo);
}
```

- **Proxy メモ化なしでの再帰生成**: パスが深い場合や React コンポーネントの再レンダリングごとに新しい Proxy を生成すると、GC 負荷が増大する。tRPC はパスをキーにしたメモ化辞書 `memo` でこれを防いでいる。

```typescript
// Bad: メモ化なし — 毎回新規 Proxy を生成
function createInnerProxy(callback, path) {
  return new Proxy(noop, {
    get(_obj, key) {
      return createInnerProxy(callback, [...path, key]);
    },
  });
}

// Better: ドットパスをキーにメモ化
function createInnerProxy(callback, path, memo) {
  const cacheKey = path.join(".");
  memo[cacheKey] ??= new Proxy(noop, {/* ... */});
  return memo[cacheKey];
}
```

- **Proxy ファサード型の検証不足**: `as TFaux` キャストは型チェッカーを完全にバイパスするため、ランタイムの振る舞いと型が乖離するリスクがある。tRPC は `tinyrpc.ts` のような最小実装や統合テストでこの乖離を検出している。

## 導出ルール

- `[MUST]` Proxy で `get` と `apply` の両トラップを使う場合、ターゲットを関数にする — オブジェクトをターゲットにすると `apply` トラップが発火しない
  - 根拠: `createProxy.ts:26` で `noop` 関数をターゲットにすることで、プロパティアクセスと関数呼び出しの両方を捕捉している

- `[MUST]` 再帰 Proxy を作る場合、`then` プロパティへのアクセスで `undefined` を返す — Promise チェーンとの互換性を壊さないために必須
  - 根拠: `createProxy.ts:28-32` と `createProxy.ts:79-83` の両方で、`then` が PromiseLike として誤解釈されるのを防止している

- `[SHOULD]` ランタイム Proxy にファサード型をキャストする場合、最小実装テストと統合テストで型とランタイムの一致を検証する — `as TFaux` は型チェッカーをバイパスするため、テストが唯一の安全網になる
  - 根拠: `tinyrpc.ts` が 109 行の最小実装でパターン全体の振る舞いを検証し、`createProxy.test.ts` がプリミティブの不変性を保証している

- `[SHOULD]` 再帰 Proxy をメモ化してパスごとの再生成を防ぐ — 同一パスへの繰り返しアクセス（React 再レンダリング等）でのオブジェクト生成コストを一定に抑える
  - 根拠: `createProxy.ts:24-26` のメモ化辞書パターンにより、同一パスの Proxy は 1 度しか生成されない

- `[SHOULD]` Proxy コールバックに渡すパスと引数を `Object.freeze` で不変にする — コールバック内での意図しない破壊的操作を防止し、デバッグ時の原因特定を容易にする
  - 根拠: `createProxy.ts:51-52` で freeze し、`createProxy.test.ts:23-43` で不変性をテスト検証している

- `[SHOULD]` Proxy で名前空間を合成する場合、トップレベル（FlatProxy）とネスト（RecursiveProxy）を分離する — 単一の Proxy に全責務を持たせると、トップレベルプロパティの特別処理が再帰ロジックに混入して複雑化する
  - 根拠: tRPC の全統合レイヤー（client, react-query, next, ssg）で FlatProxy + RecursiveProxy の 2 層構造が一貫して採用されている

- `[AVOID]` `then`, `call`, `apply` をプロキシ対象オブジェクトのユーザー定義キーとして許可する — JavaScript の言語仕様と衝突し、予測不能な挙動を引き起こす
  - 根拠: `router.ts:210-221` で予約語チェックと明示的なエラーメッセージを実装している

- `[AVOID]` Proxy のメモ化キャッシュに通常のオブジェクトリテラル `{}` を使う — `Object.prototype` のプロパティ（`constructor`, `toString` 等）がキャッシュキーとして衝突するリスクがある
  - 根拠: `utils.ts:44-46` の `emptyObject()` （`Object.create(null)`）がプロトタイプチェーンのない純粋マップとして使われている

## 適用チェックリスト

- [ ] Proxy を使って型安全 API を構築する場合、ファサード型 (`TFaux`) とランタイム実装を分離する設計になっているか
- [ ] 再帰 Proxy の `get` トラップで `then` を `undefined` にしているか（Promise 互換性）
- [ ] Proxy ターゲットは関数か（`get` + `apply` 両トラップが必要な場合）
- [ ] 同一パスへの繰り返しアクセスに対するメモ化が実装されているか
- [ ] コールバックに渡す path / args を freeze してイミュータビリティを保証しているか
- [ ] 予約語（`then`, `call`, `apply`）のバリデーションが入っているか
- [ ] FlatProxy（トップレベル）と RecursiveProxy（ネスト）の責務が分離されているか
- [ ] ファサード型とランタイムの一致を検証するテストが存在するか
- [ ] Proxy のメモ化キャッシュに `Object.create(null)` を使ってプロトタイプ汚染を防いでいるか
- [ ] `ProtectedIntersection` 等でトップレベルプロパティとユーザー定義名の衝突を型レベルで検出しているか
