# Pattern: Recursive Proxy API

> 出典: [repos/trpc/trpc](../repos/trpc/trpc/) からの知見
> カテゴリ: pattern

## 概要

`Proxy` の `get`/`apply` トラップでプロパティアクセスをパス配列として蓄積し、関数呼び出し時にコールバックへ一括転送する再帰 Proxy パターン。ランタイム実装はわずか 40 行程度の汎用 Proxy だが、ファサード型（`TFaux` ジェネリクス）をキャストすることでコンパイル時には完全に型安全な API 表面を提供できる。tRPC ではこのパターン 1 つからクライアント・React Query・Next.js App Router・SSG の全統合レイヤーが構築されている。

## 背景・文脈

API クライアントやフレームワーク統合では、サーバー側の定義に基づいた「実体のないオブジェクト」を型安全に操作したいという需要がある。`trpc.user.byId.query(input)` のようなドットチェーン呼び出しは、実際にはサーバー側にしかルーターオブジェクトが存在せず、クライアント側では Proxy が動的にパスを蓄積して RPC 呼び出しに変換している。

tRPC はこれを `createRecursiveProxy<TFaux>` と `createFlatProxy<TFaux>` の 2 つのプリミティブで実現している。`createRecursiveProxy` がネストしたプロシージャパスを処理し、`createFlatProxy` がトップレベルのユーティリティ（`useContext`, `Provider` 等）と再帰 Proxy を合成する。この 2 層構造により、7 つ以上の統合レイヤーが同一の Proxy プリミティブから構築されている。

ただし、このパターンには Proxy 固有の 3 つの落とし穴がある。`then` プロパティによる PromiseLike 誤判定、Proxy 再生成によるメモリ圧迫、プロトタイプ汚染によるキャッシュ衝突である。tRPC はこれら全てに対する防御策を実装しており、本 showcase ではこの「3 防御策込みの再帰 Proxy パターン」を汎用化して紹介する。

## 実装パターン

### 1. 再帰 Proxy のコア: パス蓄積 + コールバック転送

プロパティアクセスのたびに新しい Proxy を返してパスを蓄積し、関数呼び出し（`apply` トラップ）ではじめてコールバックを実行する。

```typescript
// packages/server/src/unstable-core-do-not-import/createProxy.ts:9-67
// tRPC の実装をもとにした再帰 Proxy のコア構造

const noop = () => {
  // noop -- apply トラップを有効にするための関数ターゲット
};

type ProxyCallbackOptions = {
  path: readonly string[];
  args: readonly unknown[];
};
type ProxyCallback = (opts: ProxyCallbackOptions) => unknown;

function createInnerProxy(
  callback: ProxyCallback,
  path: readonly string[],
  memo: Record<string, unknown>,
) {
  const cacheKey = path.join(".");

  // 防御策 2: メモ化辞書で同一パスの Proxy 再生成を抑制
  memo[cacheKey] ??= new Proxy(noop, {
    get(_obj, key) {
      if (typeof key !== "string" || key === "then") {
        // 防御策 1: then ガードで PromiseLike 誤判定を防止
        return undefined;
      }
      return createInnerProxy(callback, [...path, key], memo);
    },
    apply(_1, _2, args) {
      return callback({ path, args });
    },
  });

  return memo[cacheKey];
}

function createRecursiveProxy<TFaux>(callback: ProxyCallback): TFaux {
  // 防御策 3: Object.create(null) でプロトタイプ汚染を回避
  return createInnerProxy(callback, [], Object.create(null)) as TFaux;
}
```

### 2. FlatProxy: トップレベル名前空間の合成

`createFlatProxy` は 1 階層のプロパティアクセスのみを処理し、トップレベルのユーティリティメソッドと再帰 Proxy を合成する。

```typescript
// packages/server/src/unstable-core-do-not-import/createProxy.ts:69-87
function createFlatProxy<TFaux>(
  callback: (path: string & keyof TFaux) => unknown,
): TFaux {
  return new Proxy(noop, {
    get(_obj, name) {
      if (typeof name !== "string" || name === "then") {
        return undefined;
      }
      return callback(name as string & keyof TFaux);
    },
  }) as TFaux;
}
```

### 3. 末尾セグメント pop によるディスパッチ

パス配列の最後の要素を `pop()` で取り出してメソッド種別を判定し、残りのパスをプロシージャの識別子として使う。同一の Proxy 構造でクライアント・React Query・SSG 等の異なるコンテキストに対応できる。

```typescript
// packages/client/src/createTRPCClient.ts:139-156
// クライアント側での FlatProxy + RecursiveProxy の合成
const proxy = createRecursiveProxy<TRPCClient<TRouter>>(({ path, args }) => {
  const pathCopy = [...path];
  // 末尾要素 ("query" | "mutate" | "subscribe") を取り出す
  const procedureType = clientCallTypeToProcedureType(pathCopy.pop()!);
  const fullPath = pathCopy.join(".");
  return client[procedureType](fullPath, ...(args as unknown[]));
});

return createFlatProxy<TRPCClient<TRouter>>((key) => {
  if (key === untypedClientSymbol) {
    return client;
  }
  return (proxy as Record<string, unknown>)[key];
});
```

### 4. ファサード型による API 表面の制御

ランタイム Proxy は汎用的だが、ファサード型（`TFaux`）をキャストすることで、コンテキストごとに異なる API 表面を型レベルで提供する。同じルーター定義に対して、用途ごとに異なる `Decorate*` 型を適用する。

```typescript
// クライアント: query/mutate/subscribe
type DecoratedClient = {
  user: {
    byId: { query: (input: string) => Promise<User>; };
    list: { query: () => Promise<User[]>; };
    create: { mutate: (input: CreateUserInput) => Promise<User>; };
  };
};

// React Query: useQuery/useMutation/useSuspenseQuery
type DecoratedReactQuery = {
  user: {
    byId: { useQuery: (input: string) => UseQueryResult<User>; };
    list: { useSuspenseQuery: () => UseSuspenseQueryResult<User[]>; };
    create: { useMutation: () => UseMutationResult<User>; };
  };
};

// Utils: fetch/invalidate/setData/getData
type DecoratedUtils = {
  user: {
    byId: { fetch: (input: string) => Promise<User>; invalidate: () => void; };
  };
};
```

## Good Example

### 汎用的な型安全 Proxy クライアントの実装

tRPC のコードを参考にした、他のプロジェクトでもそのまま使える汎用実装。

```typescript
// --- 再帰 Proxy プリミティブ ---

const noop = () => {};

interface ProxyCallbackOptions {
  path: readonly string[];
  args: readonly unknown[];
}

function createRecursiveProxy<TFaux>(
  callback: (opts: ProxyCallbackOptions) => unknown,
): TFaux {
  const memo: Record<string, unknown> = Object.create(null);

  function createInnerProxy(path: readonly string[]): unknown {
    const cacheKey = path.join(".");
    memo[cacheKey] ??= new Proxy(noop, {
      get(_obj, key) {
        if (typeof key !== "string" || key === "then") {
          return undefined;
        }
        return createInnerProxy([...path, key]);
      },
      apply(_1, _2, args) {
        Object.freeze(args);
        Object.freeze(path);
        return callback({ path, args });
      },
    });
    return memo[cacheKey];
  }

  return createInnerProxy([]) as TFaux;
}

// --- 使用例: API クライアント ---

// サーバー側の API 定義から導出された型
interface ApiRoutes {
  users: {
    list: { get: () => Promise<User[]>; };
    byId: { get: (id: string) => Promise<User>; };
    create: { post: (data: CreateUser) => Promise<User>; };
  };
  posts: {
    list: { get: () => Promise<Post[]>; };
  };
}

function createApiClient<TRoutes>(baseUrl: string): TRoutes {
  return createRecursiveProxy<TRoutes>(({ path, args }) => {
    const pathCopy = [...path];
    const method = pathCopy.pop()!; // "get" | "post" | "put" | "delete"
    const endpoint = pathCopy.join("/");

    return fetch(`${baseUrl}/${endpoint}`, {
      method: method.toUpperCase(),
      body: args[0] ? JSON.stringify(args[0]) : undefined,
    }).then((r) => r.json());
  });
}

const api = createApiClient<ApiRoutes>("https://api.example.com");

// 型安全: api.users.byId.get(id) は Promise<User> を返す
const user = await api.users.byId.get("123");
// 型エラー: api.users.unknown はコンパイルエラー
```

### FlatProxy でトップレベルユーティリティを合成

```typescript
function createFlatProxy<TFaux>(
  callback: (key: string & keyof TFaux) => unknown,
): TFaux {
  return new Proxy(noop, {
    get(_obj, name) {
      if (typeof name !== "string" || name === "then") {
        return undefined;
      }
      return callback(name as string & keyof TFaux);
    },
  }) as TFaux;
}

// トップレベル: ユーティリティ + 再帰 Proxy を合成
interface ClientWithUtils extends ApiRoutes {
  $url: (path: string[]) => string;
  $raw: (method: string, path: string, body?: unknown) => Promise<Response>;
}

function createClientWithUtils<TRoutes extends Record<string, unknown>>(
  baseUrl: string,
): ClientWithUtils {
  const proxy = createRecursiveProxy<TRoutes>(/* ... */);

  return createFlatProxy<ClientWithUtils>((key) => {
    if (key === "$url") {
      return (path: string[]) => `${baseUrl}/${path.join("/")}`;
    }
    if (key === "$raw") {
      return (method: string, path: string, body?: unknown) =>
        fetch(`${baseUrl}/${path}`, { method, body: body ? JSON.stringify(body) : undefined });
    }
    return (proxy as Record<string, unknown>)[key];
  });
}
```

## Bad Example

### NG: then ガードなしの再帰 Proxy

```typescript
// Bad: then を除外しない -- await や Promise.resolve で無限再帰/ハングが発生する
function createBadProxy<TFaux>(callback: (opts: ProxyCallbackOptions) => unknown): TFaux {
  function inner(path: string[]): unknown {
    return new Proxy(noop, {
      get(_obj, key) {
        if (typeof key !== "string") return undefined;
        // then がそのまま再帰に回る
        // -> await proxy で PromiseLike と判定され .then() が呼ばれる
        // -> .then() が新しい Proxy を返し、再び PromiseLike と判定される
        // -> 無限ループまたはハング
        return inner([...path, key]);
      },
      apply(_1, _2, args) {
        return callback({ path, args });
      },
    });
  }
  return inner([]) as TFaux;
}

// Better: then を明示的に除外する
get(_obj, key) {
  if (typeof key !== "string" || key === "then") {
    return undefined;
  }
  return inner([...path, key]);
}
```

### NG: メモ化なしの再帰 Proxy

```typescript
// Bad: 毎回新規 Proxy を生成 -- React の再レンダリングで GC 負荷が増大
function createBadProxy<TFaux>(callback: (opts: ProxyCallbackOptions) => unknown): TFaux {
  function inner(path: string[]): unknown {
    // アクセスのたびに new Proxy が呼ばれる
    return new Proxy(noop, {
      get(_obj, key) {
        return inner([...path, String(key)]);
      },
      apply(_1, _2, args) {
        return callback({ path, args });
      },
    });
  }
  return inner([]) as TFaux;
}

// Better: パスをキーにしたメモ化辞書で再利用する
const memo: Record<string, unknown> = Object.create(null);
const cacheKey = path.join(".");
memo[cacheKey] ??= new Proxy(noop, {/* ... */});
return memo[cacheKey];
```

### NG: 通常のオブジェクトリテラルでメモ化キャッシュを作る

```typescript
// Bad: {} はプロトタイプチェーンを持つ
const memo = {};
// "toString" や "constructor" がパスに含まれるとキャッシュが汚染される
memo["toString"]; // Object.prototype.toString がヒットする

// Better: Object.create(null) でプロトタイプのないオブジェクトを使う
const memo: Record<string, unknown> = Object.create(null);
memo["toString"]; // undefined -- プロトタイプ汚染なし
```

## 適用ガイド

### どのような状況で使うべきか

- **型安全な RPC / API クライアント**: サーバー側の定義から型を導出し、クライアント側では Proxy で動的にパスを解決する。tRPC, Hono RPC, Remult 等が採用
- **型安全なルーティング**: パスセグメントをドットチェーンで組み立て、最終的に URL やパス文字列に変換する
- **CLI フレームワーク**: サブコマンドのネストを Proxy で表現し、型安全なコマンド定義を提供する
- **ORM / クエリビルダー**: テーブル名・カラム名のドットチェーンを Proxy で捕捉し、SQL クエリに変換する

### 導入時の注意点

1. **3 つの防御策は必須**: then ガード、メモ化辞書、`Object.create(null)` の 3 つを省略すると、Promise 互換性の破壊・メモリ圧迫・プロトタイプ汚染のいずれかが発生する
2. **`as TFaux` は型チェッカーをバイパスする**: ファサード型キャストはランタイムの振る舞いと型の一致を保証しない。最小実装テスト（tRPC の `tinyrpc.ts` に相当）と統合テストで乖離を検出する仕組みが必須
3. **Proxy ターゲットは関数にする**: `get` と `apply` の両トラップを使うには、ターゲットが `typeof target === 'function'` である必要がある。空関数 `noop` をモジュールスコープで共有し、生成コストをゼロにする
4. **予約語のバリデーション**: `then`, `call`, `apply` をユーザー定義のパスキーとして使うと JavaScript の言語仕様と衝突する。tRPC は `reservedWords` チェックでランタイムエラーを投げて防御している（`router.ts:210-221`）
5. **FlatProxy と RecursiveProxy を分離する**: 単一の Proxy に全責務を持たせると、トップレベルプロパティの特別処理が再帰ロジックに混入して複雑化する。2 層に分けることで、それぞれの責務を明確にする

### カスタマイズポイント

- **コールバックに渡す情報**: tRPC は `{ path, args }` だが、HTTP メソッドやヘッダ情報など追加のメタデータを渡すことも可能
- **末尾セグメントのディスパッチマップ**: `query`, `mutate` の代わりに `get`, `post`, `put`, `delete` など、用途に応じたメソッドマップに変更する
- **`Object.freeze` による引数の不変性保証**: コールバックに渡す `path` と `args` を freeze することで、下流での意図しない破壊的操作を防止できる（tRPC が実践）
- **ProtectedIntersection での名前衝突検出**: FlatProxy のトップレベルプロパティとユーザー定義パスの衝突を、`keyof A & keyof B extends never` の条件付き型でコンパイル時に検出する

## 導出ルール

- `[MUST]` 再帰 Proxy の `get` トラップで `then` プロパティへのアクセスに `undefined` を返す -- `then` が存在すると `await proxy` や `Promise.resolve(proxy)` で PromiseLike と誤判定され、無限再帰やハングが発生する
  - 根拠: `createProxy.ts:28-32` と `createProxy.ts:79-83` の両方で then ガードが実装されている

- `[MUST]` Proxy の `get` + `apply` 両トラップを使う場合、ターゲットを関数にする -- オブジェクトをターゲットにすると `apply` トラップが発火せず `TypeError` になる
  - 根拠: `createProxy.ts:9-11` の `noop` 関数がモジュールスコープで定義され、全 Proxy で共有されている

- `[MUST]` `as TFaux` ファサード型キャストを使う場合、最小実装テストで型とランタイムの一致を検証する -- キャストは型チェッカーを完全にバイパスするため、テストが唯一の安全網になる
  - 根拠: `packages/tests/showcase/tinyrpc.ts` が 109 行の最小実装でパターン全体の振る舞いを検証している

- `[SHOULD]` 再帰 Proxy をパスキーでメモ化して同一パスの再生成を防ぐ -- React の再レンダリング等で同一パスに繰り返しアクセスする場合、メモ化なしでは毎回 `new Proxy` のコストが発生する
  - 根拠: `createProxy.ts:24-26` の `memo[cacheKey] ??= new Proxy(...)` パターン

- `[SHOULD]` Proxy のメモ化キャッシュには `Object.create(null)` を使う -- 通常の `{}` は `Object.prototype` のプロパティ（`toString`, `constructor` 等）がキャッシュキーとして衝突するリスクがある
  - 根拠: `utils.ts:44-46` の `emptyObject()` がコードベース全体で 13 箇所以上使用されている

- `[SHOULD]` Proxy で名前空間を合成する場合、FlatProxy（トップレベル）と RecursiveProxy（ネスト）を分離する -- 単一の Proxy に全責務を持たせると、トップレベルの特別処理が再帰ロジックに混入して複雑化する
  - 根拠: tRPC の全統合レイヤー（client, react-query, next, ssg）で 2 層構造が一貫して採用されている

- `[AVOID]` `then`, `call`, `apply` を Proxy 対象オブジェクトのユーザー定義キーとして許可する -- JavaScript の言語仕様と衝突し、予測不能な挙動を引き起こす
  - 根拠: `router.ts:210-221` で予約語チェックと明示的なエラーメッセージが実装されている

## 参考

- [repos/trpc/trpc/proxy-based-type-inference.md](../repos/trpc/trpc/proxy-based-type-inference.md) -- Proxy + ファサード型の二重構造パターンの包括的分析
- [repos/trpc/trpc/performance-techniques.md](../repos/trpc/trpc/performance-techniques.md) -- Proxy メモ化、Object.create(null)、freeze による防御
- [repos/trpc/trpc/type-system-patterns.md](../repos/trpc/trpc/type-system-patterns.md) -- ProtectedIntersection、再帰的型マッピングによるファサード型構築
