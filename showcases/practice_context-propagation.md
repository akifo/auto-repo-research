# Practice: context-propagation

> 出典: [honojs/hono](../repos/honojs/hono/type-system-patterns.md), [TanStack/query](../repos/TanStack/query/framework-adapter-patterns.md), [Effect-TS/effect](../repos/Effect-TS/effect/dependency-injection.md), [vitejs/vite](../repos/vitejs/vite/abstraction-patterns.md), [openclaw/openclaw](../repos/openclaw/openclaw/messaging-integration-patterns.md), [mastra-ai/mastra](../repos/mastra-ai/mastra/architecture.md)
> カテゴリ: practice

## 概要

6 リポジトリのコンテキスト伝播パターンを「明示的引数渡し」「暗黙的コンテキスト」「型パラメータによる静的追跡」の 3 分類で体系化する。コンテキスト（認証情報、設定、環境変数、ロガー等）をコールスタック全体にどう伝播するかは、コードの可読性・テスタビリティ・型安全性に直結する設計判断である。

## 背景・文脈

コンテキスト伝播の方法は、大きく 3 つのカテゴリに分けられる:

| カテゴリ                   | 伝播メカニズム           | 代表リポ                  | トレードオフ               |
| -------------------------- | ------------------------ | ------------------------- | -------------------------- |
| 明示的引数渡し             | 関数引数、コールバック   | mastra, openclaw, unbuild | 可読性○、ボイラープレート△ |
| 暗黙的コンテキスト         | フレームワーク DI、Proxy | vite, TanStack            | 利便性○、追跡性△           |
| 型パラメータによる静的追跡 | 型レベル合成・消去       | hono, Effect-TS           | 型安全性◎、学習コスト△     |

## 実装パターン

### 1. 型パラメータ累積合成（honojs/hono）

ミドルウェアチェーンで `Env` 型を `IntersectNonAnyTypes` で累積的に合成する。`any` フィルタ付きで、型パラメータを指定しないミドルウェアがチェーンに混在しても型合成が壊れない。

```typescript
// src/types.ts:2474-2476
type ProcessHead<T> = IfAnyThenEmptyObject<T extends Env ? (Env extends T ? {} : T) : T>;
export type IntersectNonAnyTypes<T extends any[]> = T extends [infer Head, ...infer Rest]
  ? ProcessHead<Head> & IntersectNonAnyTypes<Rest>
  : {};
```

ミドルウェアが `c.set("user", user)` で設定した変数は、後続ハンドラで `c.get("user")` として型安全にアクセスできる。`HandlerInterface` のオーバーロード（1〜10 個のミドルウェア対応）が型の累積合成を駆動する。

`Declaration Merging` による外部拡張も併用:

```typescript
// src/middleware/jwt/index.ts:5-9
import type {} from "../..";
declare module "../.." {
  interface ContextVariableMap extends JwtVariables {}
}
// → c.var.jwtPayload が型安全にアクセス可能
```

### 2. フレームワーク固有 DI + 最小購読契約（TanStack/query）

`subscribe(listener): unsubscribe` の最小契約で 6 フレームワークに対応する。各アダプターがフレームワーク固有のリアクティブシステムに橋渡しし、QueryClient の提供はフレームワーク標準の DI に委ねる。

```typescript
// packages/react-query/src/useBaseQuery.ts:103-120
React.useSyncExternalStore(
  React.useCallback(
    (onStoreChange) => {
      const unsubscribe = shouldSubscribe
        ? observer.subscribe(notifyManager.batchCalls(onStoreChange))
        : noop;
      observer.updateResult();
      return unsubscribe;
    },
    [observer, shouldSubscribe],
  ),
  () => observer.getCurrentResult(),
  () => observer.getCurrentResult(),
);
```

QueryClient の DI はフレームワークの慣習に合わせる:

| フレームワーク | 提供方法                         | 取得方法              |
| -------------- | -------------------------------- | --------------------- |
| React          | `React.createContext` + Provider | `useContext`          |
| Vue            | `app.provide()`                  | `inject()`            |
| Solid          | `createContext` + Provider       | `useContext`          |
| Angular        | DI Token                         | `inject(QueryClient)` |

`queryOptions()` identity function により型推論を活用:

```typescript
// queryOptions は値をそのまま返すが、型推論のヒントになる
const options = queryOptions({
  queryKey: ["users", userId],
  queryFn: () => fetchUser(userId),
});
// options の型が正確に推論され、useQuery に渡すときに型チェックが効く
```

### 3. 型パラメータ `R` による依存追跡（Effect-TS/effect）

`Effect<A, E, R>` の型パラメータ `R`（Requirements）が合成時に自動 union される。`provide` で `Exclude<R, Provided>` して全依存充足で `R = never` になる。

```typescript
// packages/effect/src/Layer.ts:899-926 — provide の型
export const provide: {
  <RIn, E, ROut>(
    that: Layer<ROut, E, RIn>,
  ): <RIn2, E2, ROut2>(
    self: Layer<ROut2, E2, RIn2>,
  ) => Layer<ROut2, E | E2, RIn | Exclude<RIn2, ROut>>;
};
```

依存を段階的に満たしていく例:

```typescript
// packages/effect/test/Layer.test.ts:364-372
const NumberTag = Context.GenericTag<number>("number");
const StringTag = Context.GenericTag<string>("string");
const needsNumberAndString = Effect.all([NumberTag, StringTag]);
// R = NumberTag | StringTag

const providesNumber = Layer.succeed(NumberTag, 10);
const needsString = needsNumberAndString.pipe(Effect.provide(providesNumber));
// R = StringTag（NumberTag は消去された）

const result = yield * pipe(needsString, Effect.provide(providesString));
// R = never（全依存充足）
```

`never` がデフォルト値（union の単位元）として機能するため、依存のない Effect は `Effect<A, E, never>` と表現され、他の Effect と合成しても `R` に影響しない。

## Good Example

### Effect: `never` デフォルトと union 単位元

```typescript
// never は union の単位元: never | Foo = Foo
// 依存のない Effect は R = never
const pure = Effect.succeed(42); // Effect<number, never, never>
const needsFoo = Foo.pipe(Effect.map(f => f.value)); // Effect<string, never, Foo>

// 合成時に R が自動 union
const combined = Effect.all([pure, needsFoo]);
// Effect<[number, string], never, never | Foo> = Effect<[number, string], never, Foo>
```

### hono: `IfAnyThenEmptyObject` で any 汚染防止

```typescript
// src/utils/types.ts:110
type IfAnyThenEmptyObject<T> = 0 extends 1 & T ? {} : T;

// any がインターセクションに混入しても {} に変換される
// IntersectNonAnyTypes<[{ user: User }, any, { session: Session }]>
// = { user: User } & {} & { session: Session }
// = { user: User; session: Session }  ← any に汚染されない
```

### TanStack: `queryOptions()` identity function による型推論

```typescript
// queryOptions は値をそのまま返すが、TypeScript の型推論を助ける
const userOptions = queryOptions({
  queryKey: ["user", id] as const,
  queryFn: () => fetchUser(id),
});
// useQuery(userOptions) で queryKey と queryFn の型が完全に推論される
```

### vite: Proxy による環境設定の透過的マージ

```typescript
// packages/vite/src/node/baseEnvironment.ts:47-58
this.config = new Proxy(options, {
  get: (target, prop) => {
    if (prop in target) {
      return this._options[prop]; // 環境固有設定を優先
    }
    return this._topLevelConfig[prop]; // フォールバック
  },
});
// プラグインは environment.config.xxx で環境固有/共通設定を透過的にアクセス
```

## Bad Example

### vite: Proxy 設定合成による型安全性の犠牲

```typescript
// Bad: Proxy のフォールバックでどのプロパティがどこから来るか不明
this.config = new Proxy(options, {
  get: (target, prop) => {
    if (prop in target) return target[prop];
    return this._topLevelConfig[prop]; // フォールバック先が型から読み取れない
  },
});

// 利便性は高いが、デバッグ時に「この設定値はどこで設定されたか」の追跡が困難
// Vite は型定義 (ResolvedConfig & ResolvedEnvironmentOptions) で補完している
```

### Effect: `R` が複雑な union になり不足依存が分かりにくい

```typescript
// Bad: 多数のサービスに依存する Effect の R が肥大化
type MyEffect = Effect<
  Result,
  MyError,
  DbClient | CacheClient | Logger | Config | AuthService | NotificationService
>;
// 未提供の依存が union のどれかを見落としやすい

// Better: Layer を段階的に合成し、各段階で R が縮小されることを確認
const withInfra = myEffect.pipe(Effect.provide(InfraLayer));
// R = AuthService | NotificationService（インフラ依存は解消）
```

### mastra: プッシュ型 DI による暗黙的な伝播

```typescript
// Bad: __setLogger が呼ばれたかどうかがコンパイル時に検証できない
mastraAgent.__setLogger(this.#logger);
mastraAgent.__registerMastra(this);
// 登録順序ミスでロガーが未設定のまま Agent が動作する可能性

// Better: コンストラクタ引数として必須依存を受け取る
class Agent {
  constructor(config: { logger: Logger; storage: Storage }) { ... }
}
```

## 適用ガイド

### どのカテゴリを選ぶか

- **明示的引数渡し**: コールスタックが浅く、伝播する文脈が 1-2 個の場合。可読性を最優先するプロジェクト向き
- **暗黙的コンテキスト（フレームワーク DI / Proxy）**: フレームワークの DI 機構が利用可能で、プラグインエコシステムが存在する場合。vite のようなツールチェーン向き
- **型パラメータによる静的追跡**: 依存関係の充足をコンパイル時に保証したい場合。hono のようなミドルウェアチェーン、Effect のような代数的エフェクトシステム向き

### 注意点

- 型パラメータ累積合成は強力だが、TypeScript のコンパイル時間に影響する。hono は 10 ミドルウェアまでのオーバーロードで制限している
- Proxy ベースのコンテキスト合成はデバッグが困難。開発ツールやログで設定値の出所を追跡できる仕組みを併用する
- `R` 型パラメータの union が肥大化する場合は、Layer の段階的合成で中間型を確認する

### カスタマイズポイント

- hono の `Declaration Merging` パターンは、ミドルウェアが提供するコンテキストの型を自動拡張する仕組みとして他のフレームワークにも応用可能
- TanStack の `subscribe/unsubscribe` 契約は、フレームワーク非依存のコア設計における最小のコンテキスト伝播 API として参考になる
- Effect の `Context.Reference` でデフォルト値付きのオプショナルコンテキストを提供できる（`R` から除外されるため provide 不要）

## 参考

- [repos/honojs/hono/type-system-patterns.md](../repos/honojs/hono/type-system-patterns.md) — IntersectNonAnyTypes、Declaration Merging
- [repos/TanStack/query/framework-adapter-patterns.md](../repos/TanStack/query/framework-adapter-patterns.md) — 6 フレームワーク対応アダプター
- [repos/TanStack/query/abstraction-patterns.md](../repos/TanStack/query/abstraction-patterns.md) — Subscribable、Observer 注入
- [repos/Effect-TS/effect/dependency-injection.md](../repos/Effect-TS/effect/dependency-injection.md) — R 型パラメータ、Layer、Context.Reference
- [repos/vitejs/vite/abstraction-patterns.md](../repos/vitejs/vite/abstraction-patterns.md) — Proxy 設定合成、perEnvironmentState
- [repos/openclaw/openclaw/messaging-integration-patterns.md](../repos/openclaw/openclaw/messaging-integration-patterns.md) — MsgContext 正規化
- [repos/mastra-ai/mastra/architecture.md](../repos/mastra-ai/mastra/architecture.md) — プッシュ型 DI 伝播
