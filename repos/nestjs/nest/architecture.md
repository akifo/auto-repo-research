# architecture

> リポジトリ: nestjs/nest
> 分析日: 2026-03-03

## 概要

NestJS のモノレポ全体を横断し、モジュールシステム、レイヤー構成、パッケージ間の依存方向制約、アプリケーションライフサイクルの設計を分析した。NestJS は 9 パッケージによる厳格なレイヤー分離、reflect-metadata を基盤とした DI コンテナ、トポロジーツリーに基づくライフサイクル実行順序管理を特徴とする。フレームワーク規模のアプリケーションにおける「プラットフォーム非依存な抽象化」と「明示的な依存方向制約」の実践例として注目に値する。

## 背景にある原則

- **契約（interface）をインフラ実装から完全に分離すべき。なぜなら、プラットフォーム交換可能性とテスタビリティを同時に達成できるから**: `@nestjs/common` にはすべてのインタフェース（`HttpServer`, `CanActivate`, `NestInterceptor`, `PipeTransform` 等）が定義され、`@nestjs/core` や `@nestjs/platform-*` はこれらに依存する。逆方向の依存は存在しない（`packages/common/package.json` に `@nestjs/core` への参照がない）。

- **依存グラフをランタイムで構築し、トポロジカル順序で初期化すべき。なぜなら、モジュール間の初期化順序の不整合によるバグを構造的に防げるから**: `TopologyTree` がモジュールの import グラフから DAG を構築し、各モジュールに `distance` を割り当てる。ライフサイクルフック（`onModuleInit` → `onApplicationBootstrap`）は distance 降順で実行される（`nest-application-context.ts:496`）。

- **横断的関心事を合成可能な単一インタフェースで表現すべき。なぜなら、Guard/Interceptor/Pipe/Filter を同一の `ExecutionContext` で操作できれば、プロトコル非依存な処理パイプラインが構築できるから**: `ArgumentsHost.switchToHttp()` / `switchToWs()` / `switchToRpc()` により、同じ Guard や Interceptor のコードが HTTP/WebSocket/RPC で再利用できる。

- **オプショナルなプラットフォーム拡張は、失敗しない動的インポートで統合すべき。なぜなら、不要な依存をインストールせずにコアを軽量に保てるから**: `optionalRequire` パターンにより `@nestjs/websockets` や `@nestjs/microservices` が存在しなくてもアプリケーションが正常起動する（`nest-application.ts:42-49`）。

## 実例と分析

### パッケージ間の依存方向制約

NestJS は 9 パッケージのモノレポだが、依存方向は厳密に一方向に制御されている。

```
common ← core ← platform-express / platform-fastify
              ← platform-socket.io / platform-ws
              ← microservices
              ← websockets
              ← testing
```

`@nestjs/common` の `package.json` には `@nestjs/core` への依存がなく、`@nestjs/core` は `@nestjs/common` を peerDependency として宣言する。platform パッケージは `@nestjs/common` と `@nestjs/core` 両方を peerDependency とする。この設計により、common → core → platform の一方向依存が package.json レベルで強制される。

`packages/core/package.json:44-62` では `@nestjs/microservices`, `@nestjs/websockets`, `@nestjs/platform-express` はすべて optional な peerDependency として宣言されている。

### ブートストラップシーケンス

`NestFactory.create()` の初期化フローは明確な 3 フェーズに分離されている。

```
// packages/core/nest-factory.ts:201-248
Phase 1: スキャン (DependenciesScanner.scan)
  → モジュールツリーの再帰走査 → メタデータ解析 → コンテナへの登録

Phase 2: インスタンス生成 (InstanceLoader.createInstancesOfDependencies)
  → プロトタイプ生成 → 依存解決 → コンストラクタ呼び出し

Phase 3: エンハンサー適用 (DependenciesScanner.applyApplicationProviders)
  → グローバル Guard/Pipe/Interceptor/Filter の ApplicationConfig への登録
```

この 3 フェーズはそれぞれ独立しており、Phase 1 完了後にモジュールの distance 計算が行われ、Phase 2 ではすべての依存関係が解決された状態でインスタンスが生成される。

### DI コンテナの階層構造

DI コンテナは 3 層で構成される。

```
NestContainer (最上位: 全モジュールの管理)
  └── Module (モジュール単位: providers/controllers/injectables/exports の管理)
       └── InstanceWrapper (インスタンス単位: スコープ・ライフサイクル・メタデータの管理)
```

`NestContainer` は `ModulesContainer`（`Map<string, Module>`）を保持し、各 `Module` は内部に providers / controllers / injectables / middlewares / exports の各 Map を持つ（`packages/core/injector/module.ts:44-64`）。`InstanceWrapper` は `WeakMap<ContextId, InstancePerContext>` でスコープ別インスタンスを管理する。

### モジュールの可視性制御

依存の解決は「ローカルモジュール → imports されたモジュールの exports」の順で行われる（`packages/core/injector/injector.ts:575-636`）。

```typescript
// packages/core/injector/injector.ts:594-608
public async lookupComponent<T = any>(
  providers: Map<Function | string | symbol, InstanceWrapper>,
  moduleRef: Module,
  dependencyContext: InjectorDependencyContext,
  wrapper: InstanceWrapper<T>,
  ...
): Promise<InstanceWrapper<T>> {
  // 1. まず自モジュールの providers を検索
  if (name && providers.has(name)) {
    return providers.get(name)!;
  }
  // 2. 見つからなければ imports チェーンを辿る
  return this.lookupComponentInParentModules(...);
}
```

`lookupComponentInImports` では、imports 先の `exports` に含まれるプロバイダのみが解決対象となる（`injector.ts:654-657`）。これにより、モジュール間の依存は明示的な exports 宣言がないと成立しない。

### ライフサイクルフックの実行順序制御

`TopologyTree`（`packages/core/injector/topology-tree/topology-tree.ts`）がモジュール依存グラフを DAG に変換し、各モジュールに depth ベースの `distance` を設定する。

```typescript
// packages/core/nest-application-context.ts:490-504
private getModulesToTriggerHooksOn(): Module[] {
  const compareFn = (a: Module, b: Module) => b.distance - a.distance;
  const modulesSortedByDistance = Array.from(modulesContainer.values()).sort(compareFn);
  return modulesSortedByDistance;
}
```

初期化フック（`onModuleInit`, `onApplicationBootstrap`）は distance 降順（依存元が先）、破棄フック（`onModuleDestroy`, `beforeApplicationShutdown`）は逆順（依存先が先）で実行される。グローバルモジュールの distance は `Number.MAX_VALUE` に設定され、常に最初に初期化される（`container.ts:179-181`）。

### 非同期依存解決の並行制御

`Barrier` クラス（`packages/core/helpers/barrier.ts`）が、同一モジュール内の依存解決を同期するゲートとして機能する。

```typescript
// packages/core/injector/injector.ts:316-350
const paramBarrier = new Barrier(dependencies.length);
const resolveParam = async (param, index) => {
  const paramWrapper = await this.resolveSingleParam(...);
  // 全パラメータの InstanceWrapper が解決されるまで待つ
  await paramBarrier.signalAndWait();
  // ここで初めてインスタンス取得
  const paramWrapperWithInstance = await this.resolveComponentHost(...);
};
const instances = await Promise.all(dependencies.map(resolveParam));
```

`SettlementSignal` は個別の provider 解決完了を通知し、循環依存検出にも使われる（`settlement-signal.ts:47-58`）。

## パターンカタログ

- **Abstract Factory** (生成)
  - 解決する問題: HTTP サーバー実装の交換可能性
  - 適用条件: 複数のプラットフォーム（Express/Fastify）を同一インタフェースで扱う必要がある場合
  - コード例: `packages/core/adapters/http-adapter.ts:8-193` (`AbstractHttpAdapter`) → `packages/platform-express/adapters/express-adapter.ts:51` / `packages/platform-fastify/adapters/fastify-adapter.ts`
  - 注意点: `NestFactory` がデフォルトで ExpressAdapter を生成し、明示指定時のみ Fastify に切り替わる。アダプタ切り替えはファクトリ呼び出し時のみ許可される

- **Composite + Mediator** (構造/振る舞い)
  - 解決する問題: 横断的関心事（Guard/Interceptor/Pipe/Filter）の合成と実行順序制御
  - 適用条件: リクエスト処理パイプラインに複数の関心事を直交的に追加する場合
  - コード例: `packages/core/router/router-execution-context.ts:62-78` が Pipes/Guards/Interceptors の各 ContextCreator と Consumer を合成
  - 注意点: Interceptor は RxJS Observable ベースの Chain of Responsibility パターンで実装されている（`interceptors-consumer.ts:28-37`）

- **Service Locator → Dependency Injection** (振る舞い)
  - 解決する問題: reflect-metadata によるコンストラクタパラメータ型の自動解決
  - 適用条件: TypeScript のデコレータとメタデータリフレクションが使える環境
  - コード例: `packages/core/injector/injector.ts:440-448` で `Reflect.getMetadata(PARAMTYPES_METADATA, type)` からコンストラクタ依存を自動解決
  - 注意点: `emitDecoratorMetadata: true` が必須。インタフェースは型消去されるため、`@Inject()` トークンが必要

## Good Patterns

- **Optional Platform Loading**: プラットフォーム固有モジュールを `optionalRequire` でガードし、未インストール時は空オブジェクトを返す。コアの機能を損なわずに拡張モジュールを選択的に利用できる。

```typescript
// packages/core/helpers/optional-require.ts:1-7
export function optionalRequire(packageName: string, loaderFn?: Function) {
  try {
    return loaderFn ? loaderFn() : require(packageName);
  } catch (e) {
    return {};
  }
}

// packages/core/nest-application.ts:42-49
const { SocketModule } = optionalRequire(
  '@nestjs/websockets/socket-module',
  () => require('@nestjs/websockets/socket-module'),
);
```

- **Topology-Aware Lifecycle**: モジュール依存グラフから TopologyTree を構築し、初期化と破棄の順序を自動決定する。手動での順序指定が不要になり、モジュール追加時のバグを防ぐ。

```typescript
// packages/core/scanner.ts:397-416
public calculateModulesDistance() {
  const rootModule = modulesGenerator.next().value!;
  const tree = new TopologyTree(rootModule);
  tree.walk((moduleRef, depth) => {
    if (moduleRef.isGlobal) return;
    moduleRef.distance = depth;
  });
}
```

- **Barrier-Based Parallel Resolution**: コンストラクタの全依存パラメータを並行解決しつつ、Barrier で全パラメータの InstanceWrapper 解決を同期する。依存ツリーの静的性判定が正しく行われ、undefined injection を防ぐ。

```typescript
// packages/core/helpers/barrier.ts:4-51
export class Barrier {
  public async signalAndWait(): Promise<void> {
    this.signal();
    return this.wait();
  }
}
```

## Anti-Patterns / 注意点

- **暗黙のモジュール可視性（Global Module の多用）**: `@Global()` デコレータを付けたモジュールは全モジュールから import なしでアクセスできるが、依存関係が暗黙化し追跡が困難になる。

```typescript
// Bad: すべてのサービスを Global にする
@Global()
@Module({ providers: [UserService, AuthService, LogService], exports: [...] })
export class SharedModule {}

// Better: 必要なモジュールでのみ明示的に import する
@Module({ imports: [UserModule], providers: [...] })
export class OrderModule {}
```

- **循環依存を forwardRef で隠蔽する**: `forwardRef(() => SomeModule)` は循環依存を解消するが、設計上の問題を隠す。NestJS 自体が `SettlementSignal.isCycle()` で循環検出を行っている（`injector.ts:143-145`）ことからも、循環は例外的にしか許容すべきでない。

```typescript
// Bad: 双方向 import を forwardRef で解決
@Module({ imports: [forwardRef(() => ModuleB)] })
export class ModuleA {}

// Better: 共通部分を第3のモジュールに抽出して依存を一方向にする
@Module({ imports: [SharedModule] })
export class ModuleA {}
@Module({ imports: [SharedModule] })
export class ModuleB {}
```

## 導出ルール

- `[MUST]` パッケージ間の依存方向を一方向に制約し、package.json の peerDependencies で明示する
  - 根拠: NestJS は common → core → platform の方向のみ許可し、逆方向依存を package.json レベルで排除している（common に core への参照がない）

- `[MUST]` ライフサイクルフック（初期化・破棄）の実行順序を依存グラフのトポロジカル順序で決定する
  - 根拠: `TopologyTree` がモジュールの dependency graph を DAG に変換し、distance ベースで初期化順序を自動制御している（`scanner.ts:397-416`, `nest-application-context.ts:490-504`）

- `[SHOULD]` 横断的関心事（認証・ログ・変換等）は単一のコンテキストインタフェースに対して実装し、プロトコル切り替えはコンテキスト側で吸収する
  - 根拠: `ExecutionContext` / `ArgumentsHost` の `switchToHttp()` / `switchToWs()` / `switchToRpc()` により、Guard/Interceptor/Pipe が HTTP/WS/RPC で共通実装になっている

- `[SHOULD]` 並行に解決される依存関係は、Barrier パターンで全依存の解決完了を同期してからインスタンスを取得する
  - 根拠: `Injector.resolveConstructorParams` が `Barrier.signalAndWait()` で全パラメータの InstanceWrapper 解決を待ち、依存ツリーの静的性判定エラーによる null injection を防いでいる（`injector.ts:316-387`）

- `[SHOULD]` オプショナルなプラットフォーム拡張は、try-catch ベースの動的インポートで失敗を握りつぶし、空オブジェクトを返す
  - 根拠: `optionalRequire` パターンにより、`@nestjs/websockets` 未インストールでもコアが正常動作する（`nest-application.ts:42-49`）

- `[AVOID]` `@Global()` / グローバルモジュールの多用。依存関係を暗黙化し、モジュール間の結合度を追跡不能にする
  - 根拠: NestJS 自身もグローバルモジュールの distance を `Number.MAX_VALUE` にして特殊扱いしており（`container.ts:179-181`）、通常のトポロジカル順序から外れた例外的な存在として設計されている

- `[AVOID]` 循環依存を `forwardRef` で解消する設計。依存グラフの DAG 性が崩れ、初期化順序の保証が困難になる
  - 根拠: `SettlementSignal.isCycle()` で循環検出して例外を投げる実装があり（`injector.ts:143-145`）、循環は設計上の問題として扱われている

## 適用チェックリスト

- [ ] パッケージ/モジュール間の依存方向が一方向になっているか（package.json / import 文を確認）
- [ ] 契約（interface）と実装が異なるパッケージ/レイヤーに分離されているか
- [ ] ライフサイクルフック（初期化・破棄・シャットダウン）の実行順序が依存グラフに基づいて自動決定されているか
- [ ] オプショナルな拡張モジュールが未インストール時にアプリケーション起動を妨げないか
- [ ] 横断的関心事（認証・ログ・バリデーション等）がプロトコル非依存なインタフェースで実装されているか
- [ ] 並行に解決される依存関係に、全依存の解決完了を待つ同期ポイントがあるか
- [ ] グローバルスコープの依存が最小限に抑えられ、明示的な import が優先されているか
- [ ] 循環依存が存在しないか（存在する場合、共通モジュール抽出で解消可能か検討したか）
