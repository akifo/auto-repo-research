# Pattern: Mixin Feature Injection

> 出典: [repos/cloudflare/agents/composition-patterns.md](../repos/cloudflare/agents/composition-patterns.md)
> カテゴリ: pattern

## 概要

TypeScript の mixin パターンを使い、継承チェーンを変更せずにクロスカッティングな機能（永続的ファイバー、ハートビート、キープアライブ等）をクラスに注入する設計技法。構造的サブタイピングで最小限のインターフェースだけを要求し、WeakSet による二重適用防止を組み合わせることで、安全かつ柔軟な機能合成を実現する。cloudflare/agents の `withFibers` 実装に代表されるこのパターンは、横断的関心事を独立したユニットとして管理し、任意の組み合わせで合成できる点で価値がある。

## 背景・文脈

cloudflare/agents は Cloudflare Durable Objects 上で動作する Agent フレームワークである。Agent クラスは状態管理、SQL、WebSocket、スケジューリングなど多くの基盤機能を持ち、その上に McpAgent（MCP プロトコル）や AIChatAgent（AI チャット）が継承で積み重なる。

ここで「永続的ファイバー（長時間実行タスク）」のような横断的関心事を追加したい場合、継承階層にさらにレイヤーを追加すると以下の問題が生じる。

1. **継承の爆発**: McpAgent にもファイバーが欲しい、AIChatAgent にもファイバーが欲しい、となると各サブクラスに対応するファイバー版を作る必要がある
2. **単一継承の制約**: TypeScript/JavaScript は単一継承のため、複数の横断的関心事（ファイバー + ロギング + メトリクス等）を継承だけで合成できない
3. **継承チェーンの硬直化**: 基底クラスに機能を追加すると、不要なサブクラスにも影響が及ぶ

mixin パターンはこれらの問題を解決する。関数がベースクラスを受け取り、そのクラスを拡張した新しいクラスを返すことで、任意のクラスに任意の機能を後付けできる。

## 実装パターン

### 核心: mixin 関数のシグネチャ

mixin 関数は「コンストラクタ型を受け取り、拡張されたコンストラクタ型を返す」高階関数として定義する。

```typescript
// packages/agents/src/experimental/forever.ts:118-124
// 型制約: 最小限のインターフェースだけを要求する
type AgentLike = new(...args: any[]) => {
  sql: SqlStorage;
  scheduleEvery: (interval: number) => void;
  cancelSchedule: () => void;
};

export function withFibers<TBase extends AgentLike>(Base: TBase, options?) {
  class FiberAgent extends Base {
    // keepAlive, spawnFiber, stashFiber, cancelFiber ...
  }
  return FiberAgent;
}
```

ポイントは `TBase extends AgentLike` の制約である。`AgentLike` は Agent クラスそのものではなく、mixin が必要とするメソッド群（`sql`, `scheduleEvery`, `cancelSchedule`）だけを持つ構造的型として定義する。これにより、Agent だけでなく McpAgent や AIChatAgent、あるいはテスト用のモッククラスにも適用できる。

### 使用側: extends の中で関数呼び出し

```typescript
// 使用例（experimental/forever.ts のドキュメントコメントより）
class MyAgent extends withFibers(Agent)<Env, State> {
  async doWork(payload: unknown, fiberCtx: FiberContext) {
    // 永続的ファイバーとして実行される
  }
}
```

`extends withFibers(Agent)` と書くことで、MyAgent は Agent のすべての機能に加えて、ファイバー関連のメソッド（`spawnFiber`, `stashFiber`, `cancelFiber`, `keepAlive`）を持つ。通常の Agent を継承したい場合は `extends Agent` に戻すだけでよい。

### 二重適用防止: WeakSet パターン

mixin やプロトタイプラップが複数回適用されると、メソッドが多重にラップされてバグの原因になる。WeakSet でラップ済みのプロトタイプを追跡し、二重適用を防止する。

```typescript
// packages/agents/src/workflows.ts:52,100-107
const wrappedPrototypes = new WeakSet<object>();

// コンストラクタ内でプロトタイプをラップ
const proto = Object.getPrototypeOf(this);
if (Object.hasOwn(proto, "run") && !wrappedPrototypes.has(proto)) {
  const originalRun = proto.run;
  proto.run = async function(this, event, step) {
    // 初期化ロジックを注入
    return originalRun.call(this, event, step);
  };
  wrappedPrototypes.add(proto);
}
```

WeakSet を使う理由は 2 つある。

1. **GC フレンドリー**: プロトタイプオブジェクトへの弱参照なので、クラスが不要になれば自動的に回収される
2. **プロトタイプ単位の追跡**: 同一クラスの複数インスタンスが生成されても、プロトタイプは共有されるため 1 度だけラップされる

### 型制約の設計: 構造的サブタイピングの活用

mixin の型制約は、具象クラスではなくインターフェース（構造的型）で定義する。

```typescript
// cloudflare/agents での AgentLike 型制約
type Constructor<T = object> = new(...args: any[]) => T;

type AgentLike = Constructor<{
  sql: SqlStorage;
  scheduleEvery: (interval: number) => void;
  cancelSchedule: () => void;
}>;
```

この設計により以下が可能になる。

- Agent, McpAgent, AIChatAgent のいずれにも `withFibers` を適用できる
- テスト時に最小限のモッククラスを作って `withFibers` の振る舞いを検証できる
- 将来的に Agent 以外のベースクラス（例えば別のフレームワーク）にも適用できる

## Good Example

### 最小インターフェースで制約する mixin

```typescript
// Good: 構造的サブタイピングで最小限の要求
type Loggable = new(...args: any[]) => {
  name: string;
};

function withLogging<TBase extends Loggable>(Base: TBase) {
  return class extends Base {
    log(message: string) {
      console.log(`[${this.name}] ${message}`);
    }
  };
}

// Agent にも McpAgent にも適用可能
class MyAgent extends withLogging(Agent) {/* ... */}
class MyMcpAgent extends withLogging(McpAgent) {/* ... */}
```

### 複数 mixin の合成

```typescript
// Good: 複数の mixin を合成（継承チェーンは線形に保たれる）
class MyAgent extends withMetrics(withLogging(withFibers(Agent)))<Env, State> {
  // Agent + Fibers + Logging + Metrics のすべてのメソッドが利用可能
}
```

### WeakSet による安全なプロトタイプ拡張

```typescript
// Good: WeakSet で二重適用を防止
const enhanced = new WeakSet<object>();

function withHeartbeat<TBase extends AgentLike>(Base: TBase) {
  if (enhanced.has(Base.prototype)) {
    return Base; // 既に適用済み
  }

  class HeartbeatAgent extends Base {
    startHeartbeat(intervalMs: number) {
      this.scheduleEvery(intervalMs);
    }
  }

  enhanced.add(HeartbeatAgent.prototype);
  return HeartbeatAgent;
}
```

## Bad Example

### 具象クラスに直接依存する mixin

```typescript
// Bad: Agent クラスに直接依存している
function withFibers<TBase extends typeof Agent>(Base: TBase) {
  class FiberAgent extends Base {
    // Agent のすべてのメソッドに依存可能 → 結合度が高い
    doSomething() {
      this.sql`SELECT ...`; // sql は使う
      this.broadcast("hello"); // broadcast は使わないのに依存
      this.setState({ key: "value" }); // setState も使わないのに依存
    }
  }
  return FiberAgent;
}

// McpAgent に適用したい場合、型が合わない可能性がある
// テスト時に Agent 全体をモックする必要がある
```

### mixin 内での型キャスト多用

```typescript
// Bad: mixin 内で as unknown as でキャストしている
function withFibers<TBase extends MinimalBase>(Base: TBase) {
  class FiberAgent extends Base {
    doSomething() {
      // 型制約に sql を含めていないのにキャストで無理やりアクセス
      (this as unknown as Agent<Cloudflare.Env>).sql`SELECT ...`;
      (this as unknown as Agent<Cloudflare.Env>).scheduleEvery(1000);
    }
  }
  return FiberAgent;
}

// Better: 型制約に必要なメソッドを含める
type AgentLike = Constructor<{
  sql: SqlStorage;
  scheduleEvery: (interval: number) => void;
}>;
```

### 二重適用防止なしのプロトタイプ拡張

```typescript
// Bad: 二重適用のガードがない
function withFeature<TBase extends Constructor>(Base: TBase) {
  const proto = Base.prototype;
  const original = proto.onConnect;
  // 同じクラスに 2 回適用すると、original が既にラップ済みの関数を指す
  proto.onConnect = function(...args: unknown[]) {
    console.log("enhanced connect");
    return original.call(this, ...args);
  };
  return Base;
}

// 2 回呼ぶと "enhanced connect" が 2 回出力される
withFeature(withFeature(Agent));
```

## 適用ガイド

### どのような状況で使うべきか

- **横断的関心事の追加**: ロギング、メトリクス、ヘルスチェック、永続的実行など、本体のビジネスロジックと直交する機能を追加したい場合
- **複数の継承先に同じ機能を提供**: Agent にも McpAgent にも同じ機能を追加したいが、共通の中間クラスを作りたくない場合
- **オプショナルな機能**: すべてのクラスには不要だが、特定のクラスにだけ必要な機能を後付けしたい場合
- **テスタビリティ**: mixin 単体をモッククラスに適用してテストしたい場合

### 導入時の注意点

1. **型制約は最小限に**: mixin の `TBase` 制約には、mixin が実際に使うメソッドだけを含める。具象クラス全体を要求すると結合度が上がり、mixin の利点が失われる
2. **`as unknown as` キャストを避ける**: 型制約に含まれていないメソッドにキャストでアクセスすると、型安全性が崩壊する。必要なメソッドは型制約に追加する
3. **WeakSet で二重適用を防止する**: プロトタイプレベルのメソッドラップを行う場合は必須。mixin 関数自体が冪等であることを保証する
4. **mixin の適用順序に注意**: `withA(withB(Base))` と `withB(withA(Base))` は異なるクラスを生成する。同名メソッドのオーバーライド順序が変わるため、合成順序を文書化する
5. **TypeScript の型推論の限界**: 深くネストした mixin チェーンでは型推論が複雑になる。IDE のサポートが弱くなる場合は、合成結果の型を明示的にエクスポートする

### カスタマイズポイント

- **型制約の粒度**: プロジェクトの規模に応じて、`AgentLike` のような共通型を定義するか、mixin ごとに個別の型制約を定義するかを選択する
- **オプション引数**: `withFibers(Agent, { heartbeatInterval: 5000 })` のように、mixin にオプション引数を渡して振る舞いを設定可能にする
- **合成ヘルパー**: mixin が増えた場合、`compose(withFibers, withLogging, withMetrics)(Agent)` のような合成ユーティリティを用意すると可読性が向上する

## 参考

- [repos/cloudflare/agents/composition-patterns.md](../repos/cloudflare/agents/composition-patterns.md) -- 元の分析（mixin 以外に継承、DO RPC、Workflow 合成も含む）
