# concurrency-patterns

> リポジトリ: nestjs/nest
> 分析日: 2026-03-03

## 概要

NestJS の DI コンテナは、シングルトン・リクエストスコープ・トランジェントという3つのライフサイクルスコープを単一の WeakMap ベースのインスタンスストアで統一的に管理する。リクエストごとにコンテキスト ID オブジェクトを生成し、そのオブジェクト参照を WeakMap のキーとして使うことで、手動でのクリーンアップなしに GC ベースの自動メモリ解放を実現している。並行する依存解決には Barrier 同期プリミティブと SettlementSignal による循環検知を組み合わせ、非同期 DI グラフの安全な並行解決を可能にしている。

## 背景にある原則

- **オブジェクト参照によるスコーピング**: リクエストコンテキストの識別にはユニークな数値 ID ではなく「オブジェクト参照」を使うべき。WeakMap はオブジェクト参照で比較するため、ID の衝突を気にする必要がなくなり、かつ参照が消えれば自動的にエントリが GC される。`context-id-factory.ts` のコメントで「identifier does not have to be neither unique nor unpredictable because WeakMap uses objects as keys (reference comparison)」と明示されている（`packages/core/helpers/context-id-factory.ts:7-14`）。

- **スコープの伝播は暗黙的に**: 依存ツリー全体の静的性（staticness）を再帰的にイントロスペクションし、1つでも REQUEST スコープの依存があれば、その親も自動的にリクエストスコープとして扱うべき。開発者が各プロバイダに明示的にスコープを指定する負担を排除する設計判断。`isDependencyTreeStatic()` が依存ツリー全体を走査して判定する（`packages/core/injector/instance-wrapper.ts:300-319`）。

- **並行解決は Barrier で同期し、評価順序を保証する**: DI コンテナが複数の依存を `Promise.all` で並行解決する場合、全依存の InstanceWrapper が揃ってから staticity 評価を行わないと、不正な null インジェクションが発生する。Barrier パターンで「全参加者が到達するまで待つ」同期点を設けることで、並行性を維持しつつ評価順序を保証する（`packages/core/injector/injector.ts:316-387`）。

- **シグナルベースの完了通知で循環依存を検出する**: 非同期 DI 解決において、Promise の pending 状態と依存参照の Set を組み合わせることで、実行時の循環依存を検出できる。静的解析では検出できない動的な循環をランタイムで捕捉する（`packages/core/injector/settlement-signal.ts:1-59`）。

## 実例と分析

### WeakMap による自動スコーピングとメモリ管理

`InstanceWrapper` はインスタンスの格納に `WeakMap<ContextId, InstancePerContext<T>>` を使う。ContextId はただの `{ id: number }` オブジェクトだが、WeakMap のキーとして使われるため、リクエスト処理が完了して ContextId への参照が消えると、関連するインスタンスも自動的に GC される。

```typescript
// packages/core/injector/instance-wrapper.ts:78
private readonly values = new WeakMap<ContextId, InstancePerContext<T>>();
```

シングルトンには凍結された `STATIC_CONTEXT` オブジェクトを使い、リクエストスコープには毎回新しい ContextId オブジェクトを生成する。この設計により、同一の WeakMap でシングルトンとリクエストスコープを統一的に扱える。

```typescript
// packages/core/injector/constants.ts:5-8
const STATIC_CONTEXT_ID = 1;
export const STATIC_CONTEXT: ContextId = Object.freeze({
  id: STATIC_CONTEXT_ID,
});
```

```typescript
// packages/core/helpers/context-id-factory.ts:5-15
export function createContextId(): ContextId {
  // WeakMap uses objects as keys (reference comparison).
  // Thus, even though identifier number might be equal,
  // WeakMap would properly associate asynchronous context.
  return { id: Math.random() };
}
```

### トランジェントプロバイダの二重キーマップ

トランジェントスコープのプロバイダは、同じリクエスト内でも注入先ごとに異なるインスタンスを提供する必要がある。これを `Map<inquirerId, WeakMap<ContextId, InstancePerContext>>` という二重構造で実現している。

```typescript
// packages/core/injector/instance-wrapper.ts:81-83
private transientMap?:
  | Map<string, WeakMap<ContextId, InstancePerContext<T>>>
  | undefined;
```

```typescript
// packages/core/injector/instance-wrapper.ts:144-157
public getInstanceByInquirerId(
  contextId: ContextId,
  inquirerId: string,
): InstancePerContext<T> {
  let collectionPerContext = this.transientMap!.get(inquirerId);
  if (!collectionPerContext) {
    collectionPerContext = new WeakMap();
    this.transientMap!.set(inquirerId, collectionPerContext);
  }
  const instancePerContext = collectionPerContext.get(contextId);
  return instancePerContext
    ? instancePerContext
    : this.cloneTransientInstance(contextId, inquirerId);
}
```

### Barrier による並行 DI 解決の同期

`Injector.resolveConstructorParams` は全コンストラクタ引数を `Promise.all` で並行解決する。しかし、依存ツリーの staticity 判定は全 InstanceWrapper が解決されてから行わないと、未解決の依存を「静的」と誤判定して null を注入してしまう。これを Barrier で防いでいる。

```typescript
// packages/core/helpers/barrier.ts:4-51
export class Barrier {
  private currentCount: number;
  private targetCount: number;
  private promise: Promise<void>;
  private resolve: () => void;

  constructor(targetCount: number) {
    this.currentCount = 0;
    this.targetCount = targetCount;
    this.promise = new Promise<void>(resolve => {
      this.resolve = resolve;
    });
  }

  public signal(): void {
    this.currentCount += 1;
    if (this.currentCount === this.targetCount) {
      this.resolve();
    }
  }

  public async signalAndWait(): Promise<void> {
    this.signal();
    return this.wait();
  }
}
```

Injector での使用箇所では、正常パスで `signalAndWait()` を呼び、エラーパスでは `signal()` のみ呼ぶことで、他の依存解決をデッドロックさせない。

```typescript
// packages/core/injector/injector.ts:316-387
const paramBarrier = new Barrier(dependencies.length);
const resolveParam = async (param: unknown, index: number) => {
  try {
    // ... 依存解決 ...
    await paramBarrier.signalAndWait();
    // ... staticity 評価とインスタンス取得 ...
  } catch (err) {
    paramBarrier.signal(); // エラー時もバリアを解放
    // ...
  }
};
const instances = await Promise.all(dependencies.map(resolveParam));
```

### SettlementSignal による循環依存の実行時検出

`SettlementSignal` は Promise ベースの完了通知と依存参照の Set を組み合わせたプリミティブ。`isPending` 状態のインスタンスに対して、依存チェーンが自分自身に戻っているかを `isCycle()` で検出する。

```typescript
// packages/core/injector/settlement-signal.ts:47-58
public insertRef(wrapperId: string) {
  this._refs.add(wrapperId);
}

public isCycle(wrapperId: string) {
  return !this.completed && this._refs.has(wrapperId);
}
```

```typescript
// packages/core/injector/injector.ts:141-151
if (instanceHost.isPending) {
  const settlementSignal = wrapper.settlementSignal;
  if (inquirer && settlementSignal?.isCycle(inquirer.id)) {
    throw new CircularDependencyException(`"${wrapper.name}"`);
  }
  return instanceHost.donePromise!.then((err?: unknown) => {
    if (err) { throw err; }
  });
}
```

### リクエストコンテキストの伝播

ルーター層では、リクエストオブジェクトに `REQUEST_CONTEXT_ID` Symbol を非列挙プロパティとして付与し、同一リクエスト内の後続処理で同じ ContextId を再利用する。

```typescript
// packages/core/router/router-explorer.ts:430-448
private getContextId<T extends Record<any, unknown> = any>(
  request: T,
  isTreeDurable: boolean,
): ContextId {
  const contextId = ContextIdFactory.getByRequest(request);
  if (!request[REQUEST_CONTEXT_ID as any]) {
    Object.defineProperty(request, REQUEST_CONTEXT_ID, {
      value: contextId,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    const requestProviderValue = isTreeDurable
      ? contextId.payload
      : Object.assign(request, contextId.payload);
    this.container.registerRequestProvider(requestProviderValue, contextId);
  }
  return contextId;
}
```

### AsyncResource による非同期コンテキスト保持

インターセプタチェーンでは `AsyncResource.bind` を使い、rxjs の Observable チェーン内で Node.js の非同期コンテキスト（AsyncLocalStorage 等）を正しく伝播させている。

```typescript
// packages/core/interceptors/interceptors-consumer.ts:28-38
const nextFn = async (i = 0) => {
  if (i >= interceptors.length) {
    return defer(AsyncResource.bind(() => this.transformDeferred(next)));
  }
  const handler: CallHandler = {
    handle: () =>
      defer(AsyncResource.bind(() => nextFn(i + 1))).pipe(mergeAll()),
  };
  return interceptors[i].intercept(context, handler);
};
```

### ライフサイクルフックのスコープ分離

ライフサイクルフック（`onModuleInit` 等）の呼び出しでは、非トランジェントインスタンスとトランジェントインスタンスを分離して処理する。トランジェントは複数インスタンスが存在するため、`getStaticTransientInstances()` で実際にコンストラクタが呼ばれたインスタンスのみを収集する。

```typescript
// packages/core/hooks/on-module-init.hook.ts:49-53
const nonTransientInstances = getNonTransientInstances(instances);
await Promise.all(callOperator(nonTransientInstances));

const transientInstances = getTransientInstances(instances);
await Promise.all(callOperator(transientInstances));
```

## パターンカタログ

- **Barrier パターン** (分類: 同期プリミティブ / 振る舞い)
  - 解決する問題: 複数の非同期操作を `Promise.all` で並行実行しつつ、全操作が完了するまで後続処理を待機させる
  - 適用条件: 並行解決した結果を使って何かを評価する前に、全結果が揃っている必要がある場合
  - コード例: `packages/core/helpers/barrier.ts:4-51`
  - 注意点: エラーパスでも必ず `signal()` を呼ばないとデッドロックする

- **Multiton パターン** (分類: 生成)
  - 解決する問題: キー（ContextId）ごとに異なるインスタンスを管理する必要がある
  - 適用条件: シングルトンでは不十分だが、完全に無制限なインスタンス生成も不適切な場合
  - コード例: `packages/core/injector/instance-wrapper.ts:78` (WeakMap による ContextId -> Instance マッピング)
  - 注意点: WeakMap をストアに使うため、キーはオブジェクト参照でなければならない

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: コンテキスト ID の生成・解決ロジックをカスタマイズ可能にする
  - 適用条件: デフォルトの1リクエスト=1コンテキストではなく、テナントや認証情報でコンテキストを共有・分割したい場合
  - コード例: `packages/core/helpers/context-id-factory.ts:30-41` (ContextIdStrategy インターフェース)

## Good Patterns

- **WeakMap をスコープ付きインスタンスストアとして使う**: キーにオブジェクト参照を使い、参照消失時に自動 GC させる。明示的なクリーンアップ処理が不要になり、メモリリークのリスクを軽減する。

```typescript
// packages/core/injector/instance-wrapper.ts:78
private readonly values = new WeakMap<ContextId, InstancePerContext<T>>();
```

- **凍結オブジェクトでシングルトンコンテキストを表現する**: `Object.freeze` したコンテキスト ID を使い、シングルトンとリクエストスコープを同一の WeakMap で統一管理する。分岐ロジックを最小化し、コードパスを統一できる。

```typescript
// packages/core/injector/constants.ts:5-8
export const STATIC_CONTEXT: ContextId = Object.freeze({
  id: STATIC_CONTEXT_ID,
});
```

- **Barrier のエラーパスでも必ず signal する**: `Promise.all` + Barrier パターンでは、例外が発生した参加者も `signal()` を呼ぶことで、他の参加者がデッドロックしない。

```typescript
// packages/core/injector/injector.ts:371-384
} catch (err) {
  paramBarrier.signal(); // エラー時もバリアを解放
  const isOptional = optionalDependenciesIds.includes(index);
  if (!isOptional) {
    throw err;
  }
  return undefined;
}
```

- **Symbol を非列挙プロパティとしてオブジェクトに付与する**: リクエストオブジェクトにメタデータを付与する際、Symbol + `enumerable: false` を使うことで、シリアライズやログ出力に影響を与えない。

```typescript
// packages/core/router/router-explorer.ts:435-441
Object.defineProperty(request, REQUEST_CONTEXT_ID, {
  value: contextId,
  enumerable: false,
  writable: false,
  configurable: false,
});
```

## Anti-Patterns / 注意点

- **Barrier なしの並行依存解決**: `Promise.all` で依存を並行解決した直後に、依存ツリーの属性（staticity 等）を評価すると、未解決の依存が残っている可能性がある。

```typescript
// Bad: 各依存解決が独立して進み、staticity 評価のタイミングが不定
const instances = await Promise.all(deps.map(async dep => {
  const wrapper = await resolve(dep);
  // この時点で他の依存がまだ解決していない可能性
  const isStatic = wrapper.isDependencyTreeStatic(); // 不正確な結果
  return getInstance(wrapper, isStatic);
}));

// Better: Barrier で全依存の解決を同期してから評価
const barrier = new Barrier(deps.length);
const instances = await Promise.all(deps.map(async dep => {
  const wrapper = await resolve(dep);
  await barrier.signalAndWait(); // 全依存が揃うまで待機
  const isStatic = wrapper.isDependencyTreeStatic(); // 正確な結果
  return getInstance(wrapper, isStatic);
}));
```

- **手動タイマーによるスコープ付きインスタンスのクリーンアップ**: TTL ベースや手動 `delete` によるインスタンス破棄は、タイミングミスやメモリリークの温床になる。WeakMap + オブジェクト参照キーを使えば GC に任せられる。

```typescript
// Bad: 手動クリーンアップ
const scopedInstances = new Map<string, Instance>();
setTimeout(() => scopedInstances.delete(requestId), 30000);

// Better: WeakMap + オブジェクト参照
const scopedInstances = new WeakMap<ContextId, Instance>();
// ContextId への参照が消えれば自動的に GC される
```

## 導出ルール

- `[MUST]` Barrier やカウントダウンラッチのエラーパスでも必ず signal/countDown を呼び、他の参加者をデッドロックさせない
  - 根拠: NestJS の Injector は try/catch の両方で `paramBarrier.signal()` を呼び、1つの依存解決失敗が他の依存をブロックしない設計になっている（`packages/core/injector/injector.ts:371-384`）

- `[MUST]` リクエストスコープのインスタンスストアには WeakMap を使い、コンテキストオブジェクトの参照消失で自動 GC されるようにする
  - 根拠: NestJS は `WeakMap<ContextId, InstancePerContext>` により、リクエスト終了後のインスタンスクリーンアップを GC に委任し、明示的な破棄処理を不要にしている（`packages/core/injector/instance-wrapper.ts:78`）

- `[SHOULD]` 複数の非同期依存を並行解決する場合、全依存が揃ってから依存グラフの属性評価を行う同期点を設ける
  - 根拠: NestJS は Barrier パターンで全コンストラクタ引数の解決を同期し、`isDependencyTreeStatic()` の評価が不完全な状態で実行されることを防いでいる（`packages/core/injector/injector.ts:316-349`）

- `[SHOULD]` スコープ付きプロバイダの依存ツリー全体を再帰的に走査し、スコープの伝播を暗黙的に行う（開発者に明示的なスコープ指定を要求しない）
  - 根拠: `isDependencyTreeStatic()` が依存ツリーを再帰的に検査し、1つでも REQUEST スコープの依存があれば親も自動的にリクエストスコープとして扱う。開発者のスコープ指定ミスを防ぐ（`packages/core/injector/instance-wrapper.ts:300-319`）

- `[SHOULD]` rxjs の Observable チェーンや `setTimeout`/`setImmediate` を跨ぐ処理では `AsyncResource.bind` で非同期コンテキストを明示的に伝播する
  - 根拠: NestJS のインターセプタチェーンは `AsyncResource.bind` でラップすることで、AsyncLocalStorage 等のコンテキストが rxjs の `defer`/`mergeAll` チェーン内でも正しく維持される（`packages/core/interceptors/interceptors-consumer.ts:30-34`）

- `[AVOID]` コンテキスト ID にプリミティブ値（数値・文字列）を使う -- WeakMap のキーにできず、手動クリーンアップが必要になる
  - 根拠: NestJS は `{ id: Math.random() }` というオブジェクトを ContextId として使い、「ID の一意性は不要、オブジェクト参照で十分」とコメントで明示している（`packages/core/helpers/context-id-factory.ts:7-14`）

## 適用チェックリスト

- [ ] リクエストスコープのインスタンス管理に Map を使っていないか確認する。WeakMap + オブジェクト参照キーに置き換えられないか検討する
- [ ] 複数の非同期依存を並行解決している箇所で、全依存が揃う前に依存グラフの属性を評価していないか確認する
- [ ] Barrier/CountDownLatch/Semaphore 等の同期プリミティブのエラーパスで signal/release が呼ばれているか確認する
- [ ] rxjs の Observable チェーンや非同期コールバック内で AsyncLocalStorage のコンテキストが消失していないか確認する
- [ ] トランジェントプロバイダが注入先ごとに独立したインスタンスを持てる設計になっているか（inquirer ID 等の二次キーがあるか）確認する
- [ ] ライフサイクルフックの呼び出しで、トランジェントインスタンスと非トランジェントインスタンスを分離して処理しているか確認する
