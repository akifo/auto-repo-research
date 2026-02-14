# Pattern: DynamicArgument

> 出典: [repos/mastra-ai/mastra](../repos/mastra-ai/mastra/) の複数視点から抽出
> カテゴリ: pattern

## 概要

`T | ((ctx) => T | Promise<T>)` というユニオン型で、設定値を「リテラル値」と「リクエストコンテキストに応じた関数」の両方で受け付ける DynamicArgument パターン。テスト時はハードコード、本番ではマルチテナント対応の動的解決を、API を一切変えずに実現する。設定値の「リフティング」とも呼べるこのパターンは、フレームワークの拡張性と使いやすさを両立させる汎用的な手法である。

## 背景・文脈

Mastra（mastra-ai/mastra）は TypeScript 製の AI エージェントフレームワークで、Agent の `instructions`・`tools`・`model`・`memory`・`workflows`・`scorers`・`workspace`・`processors` など、ほぼすべての設定項目に DynamicArgument パターンを適用している。

このパターンが必要になった背景には、マルチテナント SaaS でのエージェント運用がある。テナントごとにモデルやツールセットを切り替えたいが、Agent の定義自体を複数持つのは管理コストが高い。DynamicArgument により、単一の Agent 定義でリクエストごとに異なる構成を動的に解決できるようになった。

## 実装パターン

### 型定義

```typescript
// packages/core/src/types/dynamic-argument.ts:4-12
export type DynamicArgument<T, TRequestContext extends Record<string, any> | unknown = unknown> =
  | T
  | (({
    requestContext,
    mastra,
  }: {
    requestContext: RequestContext<TRequestContext>;
    mastra?: Mastra;
  }) => Promise<T> | T);
```

ポイントは3つ:

1. **`T` との Union**: 静的な値をそのまま渡せるため、シンプルなケースでの使い勝手を損なわない
2. **`Promise<T> | T`**: 関数の戻り値が同期・非同期どちらでもよいため、DB アクセスや API コールを含む動的解決にも対応
3. **`TRequestContext` ジェネリクス**: リクエストコンテキストの値に型制約を持たせ、`get`/`set` の型安全性を確保

### 解決ロジック

DynamicArgument の値を解決する側では `typeof value === 'function'` で分岐し、`resolveMaybePromise` ヘルパーで同期・非同期を統一的に処理する。

```typescript
// packages/core/src/agent/agent.ts:101-106
function resolveMaybePromise<T, R = void>(
  value: T | Promise<T> | PromiseLike<T>,
  cb: (value: T) => R,
): R | Promise<R> {
  if (value instanceof Promise || (value != null && typeof (value as PromiseLike<T>).then === "function")) {
    return Promise.resolve(value).then(cb);
  }
  return cb(value as T);
}
```

```typescript
// packages/core/src/agent/agent.ts:1284-1313 (listTools の例)
public listTools({ requestContext = new RequestContext() } = {}):
  | TTools
  | Promise<TTools> {
  if (typeof this.#tools !== 'function') {
    return ensureToolProperties(this.#tools) as TTools;
  }

  const result = this.#tools({
    requestContext: requestContext as RequestContext<TRequestContext>,
    mastra: this.#mastra,
  });

  return resolveMaybePromise(result, tools => {
    if (!tools) {
      throw new MastraError({ /* ... */ });
    }
    return ensureToolProperties(tools) as TTools;
  });
}
```

### 適用箇所の広がり

Agent だけでも以下のプロパティに DynamicArgument が使われている:

```typescript
// packages/core/src/agent/types.ts:155-252 (抜粋)
instructions: DynamicArgument<AgentInstructions, TRequestContext>;
tools?: DynamicArgument<TTools, TRequestContext>;
workflows?: DynamicArgument<Record<string, Workflow<...>>>;
defaultGenerateOptionsLegacy?: DynamicArgument<AgentGenerateOptions>;
defaultStreamOptionsLegacy?: DynamicArgument<AgentStreamOptions>;
defaultOptions?: DynamicArgument<AgentExecutionOptions<TOutput>>;
defaultNetworkOptions?: DynamicArgument<NetworkOptions>;
agents?: DynamicArgument<Record<string, Agent>>;
scorers?: DynamicArgument<MastraScorers>;
memory?: DynamicArgument<MastraMemory>;
workspace?: DynamicArgument<Workspace | undefined>;
inputProcessors?: DynamicArgument<InputProcessorOrWorkflow[]>;
outputProcessors?: DynamicArgument<OutputProcessorOrWorkflow[]>;
```

Memory の title 生成設定 (`packages/core/src/memory/types.ts:841-846`) や Workflow ステップの scorers (`packages/core/src/workflows/types.ts:558`) でも同様に使われており、パターンがフレームワーク全体で一貫している。

## Good Example

```typescript
// 静的な設定 — テストやプロトタイプに最適
const agent = new Agent({
  id: "my-agent",
  instructions: "You are a helpful assistant.",
  model: "openai/gpt-4o",
  tools: { calculator, weather },
});

// 動的な設定 — マルチテナント本番環境
const agent = new Agent({
  id: "my-agent",
  instructions: ({ requestContext }) => {
    const tenant = requestContext.get("tenantId");
    return `You are an assistant for ${tenant}. Follow their guidelines.`;
  },
  model: ({ requestContext }) => {
    const tier = requestContext.get("tier");
    return tier === "premium" ? "openai/gpt-4o" : "openai/gpt-4o-mini";
  },
  tools: async ({ requestContext, mastra }) => {
    const tenantId = requestContext.get("tenantId");
    const tenantTools = await loadToolsForTenant(tenantId);
    return { ...baseTools, ...tenantTools };
  },
});
```

API シグネチャは両者で完全に同一。利用者は最初は静的な値で始め、要件が複雑になったら関数に切り替えるだけでよい。フレームワーク側のコードや呼び出し元のコードを変更する必要がない。

## Bad Example

```typescript
// Bad: 静的と動的で別の API を用意してしまう
class Agent {
  constructor(config: {
    instructions: string; // 静的専用
    tools: Record<string, Tool>; // 静的専用
  }) {}

  // 動的が必要になったら別メソッドを追加...
  setDynamicInstructions(fn: (ctx: Context) => string) {/* ... */}
  setDynamicTools(fn: (ctx: Context) => Record<string, Tool>) {/* ... */}
}

// 問題点:
// 1. API の表面積が2倍に膨れる
// 2. 静的 → 動的の切り替えで呼び出し側のコードも変更が必要
// 3. setter の呼び忘れやコンストラクタとの競合で不整合が起きやすい
// 4. 型定義が冗長になる
```

```typescript
// Bad: 常に関数を要求してしまう
class Agent {
  constructor(config: {
    instructions: (ctx: Context) => string | Promise<string>;
    tools: (ctx: Context) => Record<string, Tool> | Promise<Record<string, Tool>>;
  }) {}
}

// 問題点:
// 1. シンプルなケースでも () => 'You are helpful.' とラップが必要
// 2. テスト時の記述量が増え、DX が低下
// 3. 初学者にとっての認知負荷が高い
```

## 適用ガイド

### どのような状況で使うべきか

- **マルチテナント対応**: リクエストごとに設定値が変わる可能性がある全プロパティ
- **段階的な複雑さの開示**: 最初は静的値で始め、後から動的解決に移行する可能性がある設定
- **テスト容易性**: テスト時はハードコード、本番では外部依存を含む動的解決にしたい場合
- **フレームワーク / ライブラリの公開 API**: 利用者の多様なユースケースに対応しつつ、API の表面積を抑えたい場合

### 導入時の注意点

- **解決側のコストを意識する**: `typeof value === 'function'` の分岐と `resolveMaybePromise` の処理は各呼び出しで発生する。ホットパスで頻繁に呼ばれる設定には、解決結果のキャッシュを検討する
- **関数が `null`/`undefined` を返すケースのハンドリング**: Mastra では関数が空値を返した場合に `MastraError` を投げてデバッグを容易にしている。Silent failure を防ぐためエラーハンドリングは必須
- **戻り値の型が `T | Promise<T>` になる**: DynamicArgument を解決する関数の戻り値は、静的値の場合は `T`、動的値の場合は `Promise<T>` になりうる。呼び出し側は `await` またはユーティリティ関数で統一的に処理する必要がある

### カスタマイズポイント

- **コンテキストの型を制約する**: `TRequestContext` ジェネリクスで、動的解決関数が受け取るコンテキストの型を制限できる。`RequestContext<{ tenantId: string; tier: 'free' | 'premium' }>` のように定義すれば、`get('tenantId')` の戻り値型が `string` になる
- **`mastra` 引数の活用**: 動的解決関数は `mastra` インスタンスも受け取るため、他のコンポーネント（ストレージ、他のエージェント等）にアクセスできる。ただし循環依存に注意
- **自プロジェクトへの導入**: `DynamicArgument` 型とその解決ユーティリティ（`resolveMaybePromise`）は汎用的であり、Mastra 以外のプロジェクトでもそのまま再利用できる。設定オブジェクトのプロパティ型を `T` から `DynamicArgument<T>` に変更するだけで段階的に導入可能

## 参考

- [repos/mastra-ai/mastra/design-philosophy.md](../repos/mastra-ai/mastra/design-philosophy.md) — DynamicArgument を設計哲学として位置づけた分析
- [repos/mastra-ai/mastra/type-system-patterns.md](../repos/mastra-ai/mastra/type-system-patterns.md) — 型システム視点での DynamicArgument の分析
- [repos/mastra-ai/mastra/api-design-practices.md](../repos/mastra-ai/mastra/api-design-practices.md) — API 設計における遅延解決パターンの分析
- [repos/mastra-ai/mastra/composability-patterns.md](../repos/mastra-ai/mastra/composability-patterns.md) — 合成パターンとしての DynamicArgument の分析
