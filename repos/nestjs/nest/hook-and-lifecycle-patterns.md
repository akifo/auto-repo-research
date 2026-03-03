# hook-and-lifecycle-patterns

> リポジトリ: nestjs/nest
> 分析日: 2026-03-03

## 概要

NestJS のライフサイクルフックシステムは、DI コンテナに登録された全インスタンスに対して統一的な初期化・破棄の機会を提供する。5 つのフックインターフェースをモジュールの依存グラフに基づくトポロジカル順序で実行し、初期化時は依存先（深いモジュール）を先に、破棄時は依存元（浅いモジュール）を先に処理する。注目すべきは、フック発見をインターフェース実装ではなく「メソッド存在チェック」で行う duck typing アプローチと、非同期初期化の同期制御に専用の SettlementSignal クラスを用いている点である。

## 背景にある原則

- **依存順序に沿ったフック実行**: ライフサイクルフックの実行順序をモジュールの依存グラフのトポロジカルソートで決定する。初期化は依存先から、破棄はその逆順。これにより、あるモジュールの `onModuleInit` が呼ばれる時点でその依存先は既に初期化済みであることが保証される。（根拠: `nest-application-context.ts:490-503` の distance ソートと `callDestroyHook` / `callShutdownHook` の `.reverse()`）

- **Duck Typing によるフック検出**: TypeScript のインターフェースはランタイムに消えるため、フック実装の検出は `typeof instance.onModuleInit === 'function'` という duck typing で行う。これにより、インターフェースを明示的に implements しなくてもフックが呼ばれ、DI コンテナ内のあらゆるオブジェクト（プレーンな値プロバイダ含む）に対して安全にフック検出を行える。（根拠: 各 hook ファイルの `hasXxxHook` 関数）

- **Opt-in シャットダウンシグナル**: プロセスシグナルリスナーの登録はデフォルトでは無効で、`enableShutdownHooks()` を明示的に呼ぶ必要がある。これは Node.js のデフォルトのシグナル処理を上書きすることの副作用（テスト実行を妨げる、他のシグナルハンドラと競合する等）を避けるための意図的な設計。（根拠: `nest-application-context.ts:324-346`）

- **Transient / Non-Transient の分離処理**: フック実行時に transient インスタンスと singleton インスタンスを明確に分離し、それぞれ独立して `Promise.all` で並行処理する。transient インスタンスはコンストラクタが実際に呼ばれたものだけをフィルタリングし、未初期化のインスタンスに対するフック呼び出しを防ぐ。（根拠: `transient-instances.ts:9-18` の `isConstructorCalled` チェック）

## 実例と分析

### フック実行の統一パターン

5 つのフック（`onModuleInit`, `onApplicationBootstrap`, `onModuleDestroy`, `beforeApplicationShutdown`, `onApplicationShutdown`）はすべて同一のテンプレートで実装されている。各フックファイルは以下の 3 関数で構成される:

1. **型ガード関数** (`hasXxxHook`): `isFunction` による duck typing チェック
2. **オペレータ関数** (`callOperator`): インスタンス配列をフィルタしてフック呼び出し
3. **エントリ関数** (`callModuleXxxHook`): プロバイダ・コントローラ・インジェクタブル・ミドルウェアを集約し、non-transient → transient → モジュールクラス自身の順で実行

```typescript
// packages/core/hooks/on-module-init.hook.ts:16-18
function hasOnModuleInitHook(instance: unknown): instance is OnModuleInit {
  return isFunction((instance as OnModuleInit).onModuleInit);
}
```

```typescript
// packages/core/hooks/on-module-init.hook.ts:37-64
export async function callModuleInitHook(module: Module): Promise<void> {
  const providers = module.getNonAliasProviders();
  const [_, moduleClassHost] = providers.shift()!;
  const instances = [
    ...module.controllers,
    ...providers,
    ...module.injectables,
    ...module.middlewares,
  ];

  const nonTransientInstances = getNonTransientInstances(instances);
  await Promise.all(callOperator(nonTransientInstances));

  const transientInstances = getTransientInstances(instances);
  await Promise.all(callOperator(transientInstances));

  // モジュールクラス自身は最後に呼ぶ
  const moduleClassInstance = moduleClassHost.instance;
  if (
    moduleClassInstance &&
    hasOnModuleInitHook(moduleClassInstance) &&
    moduleClassHost.isDependencyTreeStatic()
  ) {
    await moduleClassInstance.onModuleInit();
  }
}
```

### トポロジカルソートによる実行順序制御

モジュールの依存グラフを `TopologyTree` で木構造に変換し、各モジュールに `distance`（深さ）を割り当てる。`distance` の降順ソート（深いモジュールが先）で初期化フックを実行し、破棄フックでは逆順にする。

```typescript
// packages/core/scanner.ts:397-416
public calculateModulesDistance() {
  const modulesGenerator = this.container.getModules().values();
  modulesGenerator.next(); // Skip "InternalCoreModule"
  const rootModule = modulesGenerator.next().value!;
  if (!rootModule) {
    return;
  }
  // Convert modules to an acyclic connected graph
  const tree = new TopologyTree(rootModule);
  tree.walk((moduleRef, depth) => {
    if (moduleRef.isGlobal) {
      return; // グローバルモジュールは MAX_VALUE のまま
    }
    moduleRef.distance = depth;
  });
}
```

グローバルモジュールは `distance = Number.MAX_VALUE` に設定されるため、常に最初に初期化される。

```typescript
// packages/core/injector/container.ts:178-180
// Set global module distance to MAX_VALUE to ensure their lifecycle hooks
// are always executed first (when initializing the application)
moduleRef.distance = Number.MAX_VALUE;
```

### シャットダウンフローの設計

`close()` メソッドのシャットダウンシーケンスは厳密な 4 段階で構成される:

```typescript
// packages/core/nest-application-context.ts:277-284
public async close(signal?: string): Promise<void> {
  await this.initializationPromise;    // 1. 初期化完了を待機
  await this.callDestroyHook();        // 2. onModuleDestroy（逆順）
  await this.callBeforeShutdownHook(signal); // 3. beforeApplicationShutdown（逆順）
  await this.dispose();                // 4. サーバー停止（Template Method）
  await this.callShutdownHook(signal); // 5. onApplicationShutdown（逆順）
  this.unsubscribeFromProcessSignals();
}
```

`dispose()` は Template Method パターンで `NestApplication` がオーバーライドし、HTTP サーバー・WebSocket・マイクロサービスの停止を行う。

```typescript
// packages/core/nest-application.ts:97-107
protected async dispose(): Promise<void> {
  this.socketModule && (await this.socketModule.close());
  this.microservicesModule && (await this.microservicesModule.close());
  this.httpAdapter && (await this.httpAdapter.close());
  // ...
}
```

### シグナルの再入防止

シャットダウンシグナルハンドラは `receivedSignal` フラグで再入を防止する。一度シグナルを受けたら後続のシグナルを無視し、グレースフルシャットダウンが二重実行されることを防ぐ。

```typescript
// packages/core/nest-application-context.ts:365-372
let receivedSignal = false;
const cleanup = async (signal: string) => {
  try {
    if (receivedSignal) {
      return; // 二重シグナルを無視
    }
    receivedSignal = true;
    await this.initializationPromise;
    // ... shutdown sequence
```

### SettlementSignal による非同期初期化の同期

`SettlementSignal` はプロバイダの非同期初期化を追跡する Promise ラッパーで、循環依存の検出にも使われる。依存元が依存先の初期化完了を待機し、循環参照が検出された場合は即座にエラーをスローする。

```typescript
// packages/core/injector/settlement-signal.ts:6-59
export class SettlementSignal {
  private readonly _refs = new Set();
  private readonly settledPromise: Promise<unknown>;
  private completed = false;

  public insertRef(wrapperId: string) {
    this._refs.add(wrapperId);
  }

  public isCycle(wrapperId: string) {
    return !this.completed && this._refs.has(wrapperId);
  }
}
```

### 静的依存ツリーによるフック実行のフィルタリング

`isDependencyTreeStatic()` は、そのインスタンスの依存ツリーに REQUEST スコープのプロバイダが含まれていないかを再帰的に検査する。静的でないインスタンス（リクエストスコープに依存するもの）はライフサイクルフックの対象から除外される。

```typescript
// packages/core/injector/instance-wrapper.ts:300-320
public isDependencyTreeStatic(lookupRegistry: string[] = []): boolean {
  if (!isUndefined(this.isTreeStatic)) {
    return this.isTreeStatic;
  }
  if (this.scope === Scope.REQUEST) {
    this.isTreeStatic = false;
    return this.isTreeStatic;
  }
  this.isTreeStatic = !this.introspectDepsAttribute(
    (collection, registry) =>
      collection.some(
        (item: InstanceWrapper) => !item.isDependencyTreeStatic(registry),
      ),
    lookupRegistry,
  );
  return this.isTreeStatic;
}
```

## パターンカタログ

- **Template Method** (分類: 振る舞い)
  - 解決する問題: シャットダウンシーケンスの共通フロー（フック呼び出し順序）を固定しつつ、リソース解放処理をサブクラスに委譲する
  - 適用条件: 基底クラスでアルゴリズムの骨格を定義し、特定ステップの実装をサブクラスに任せたい場合
  - コード例: `nest-application-context.ts:348-352` の `dispose()` を `nest-application.ts:97` でオーバーライド
  - 注意点: `dispose()` が `beforeApplicationShutdown` と `onApplicationShutdown` の間に呼ばれるため、順序の理解が必要

- **Observer / Hook Pattern** (分類: 振る舞い)
  - 解決する問題: コンテナ管理下のインスタンスにライフサイクルイベントを通知する
  - 適用条件: 多数のコンポーネントがフレームワークのライフサイクルイベントに反応する必要がある場合
  - コード例: `packages/core/hooks/on-module-init.hook.ts:37-64`
  - 注意点: duck typing で検出するため、メソッド名の衝突に注意（偶然同名のメソッドがあるとフックとして呼ばれる）

## Good Patterns

- **統一テンプレートによるフック実装**: 5 つのフックすべてが同一の 3 関数構造（型ガード / オペレータ / エントリ関数）で実装されている。新しいフックを追加する際のコストが極めて低く、各フックの振る舞いの一貫性が保証される。

```typescript
// 全フックに共通するパターン（on-module-init.hook.ts を例に）
function hasOnModuleInitHook(instance: unknown): instance is OnModuleInit {
  return isFunction((instance as OnModuleInit).onModuleInit);
}

function callOperator(instances: InstanceWrapper[]): Promise<any>[] {
  return iterate(instances)
    .filter(instance => !isNil(instance))
    .filter(hasOnModuleInitHook)
    .map(async instance => (instance as any as OnModuleInit).onModuleInit())
    .toArray();
}
```

- **初期化完了待機によるシャットダウンの安全性**: `close()` および `listenToShutdownSignals` のクリーンアップ関数が `await this.initializationPromise` を最初に呼び、初期化途中でシグナルを受けても安全にシャットダウンできる。

```typescript
// packages/core/nest-application-context.ts:277-278
public async close(signal?: string): Promise<void> {
  await this.initializationPromise;
  // ...
}
```

- **グローバルモジュールの distance = MAX_VALUE**: グローバルモジュールは全モジュールから参照される可能性があるため、常に最初に初期化される。トポロジカルソート中に特別扱いせず、distance 値で自然に順序を制御する。

## Anti-Patterns / 注意点

- **フックメソッド名の衝突**: duck typing でフックを検出するため、ライフサイクルと無関係な `onModuleInit` メソッドを持つオブジェクトが値プロバイダとして登録されると、意図せずフックが呼ばれる。

```typescript
// Bad: 偶然フック名と同名のメソッドを持つ外部ライブラリオブジェクト
{ provide: 'EXTERNAL', useValue: externalLib } // externalLib.onModuleInit が存在する場合

// Better: インターフェースを明示的に implements する規約を設け、
// 値プロバイダにはフック名と衝突しないオブジェクトを使う
```

- **非同期フック内での無制限待機**: `onModuleInit` 等が返す Promise を `Promise.all` で待つため、一つのフックがハングするとアプリケーション全体の起動がブロックされる。タイムアウト機構はフレームワーク側にないため、アプリケーション側で対処が必要。

```typescript
// Bad: 外部サービスへの接続をタイムアウトなしで待機
async onModuleInit() {
  await this.externalService.connect(); // 永遠にハングする可能性
}

// Better: タイムアウト付きで接続を試行
async onModuleInit() {
  await Promise.race([
    this.externalService.connect(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Connection timeout')), 5000)
    ),
  ]);
}
```

- **リクエストスコープのプロバイダとフックの非互換**: REQUEST スコープのプロバイダは `isDependencyTreeStatic()` が false を返すため、ライフサイクルフックが呼ばれない。このことを知らずにリクエストスコープのプロバイダに `onModuleInit` を実装すると、暗黙的に無視される。

## 導出ルール

- `[MUST]` ライフサイクルフックの実行順序をモジュール（コンポーネント）の依存グラフに基づくトポロジカルソートで決定する。初期化は依存先から、破棄は依存元から実行する
  - 根拠: NestJS は `TopologyTree` で依存グラフを木構造に変換し、`distance` 降順で初期化、逆順で破棄を行うことで、フック内で依存先が初期化済みであることを保証している（`scanner.ts:409-415`, `nest-application-context.ts:422-480`）

- `[MUST]` シャットダウンシグナルハンドラには再入防止ガードを設ける。最初のシグナルでフラグを立て、後続のシグナルを無視する
  - 根拠: NestJS の `listenToShutdownSignals` は `receivedSignal` フラグで二重シャットダウンを防止し、クリーンアップが中途半端に複数回実行されることを防いでいる（`nest-application-context.ts:365-372`）

- `[SHOULD]` フック検出には duck typing（メソッド存在チェック）を使い、ランタイムに消える型情報に依存しない。型ガード関数を一箇所に集約して検出ロジックを統一する
  - 根拠: TypeScript インターフェースはコンパイル後に消えるため、`isFunction(instance.hookMethod)` による duck typing が唯一の信頼できる検出手段。全 5 フックで同一パターンの型ガード関数を使っている（`on-module-init.hook.ts:16-18` 等）

- `[SHOULD]` グレースフルシャットダウン時は「初期化完了の待機 → 依存元からの破棄 → リソース解放 → 最終通知」の 4 段階を順序保証付きで逐次実行する
  - 根拠: `close()` は `initializationPromise` を await してから destroy → beforeShutdown → dispose → shutdown の順で逐次実行し、各段階が完了してから次に進む（`nest-application-context.ts:277-284`）

- `[SHOULD]` プロセスシグナルリスナーの登録はデフォルト無効の opt-in にする。テスト環境やコンテナ環境でのシグナル処理の副作用を避けるため
  - 根拠: `enableShutdownHooks()` が明示的に呼ばれない限りシグナルリスナーは登録されない。この設計により、テスト時に SIGTERM でプロセスが終了する問題を回避している（`nest-application-context.ts:324-346`）

- `[AVOID]` リクエストスコープ（非静的ライフサイクル）のコンポーネントにモジュールレベルのライフサイクルフックを実装すること。静的でないインスタンスのフックは暗黙的にスキップされる
  - 根拠: `isDependencyTreeStatic()` が false のインスタンスはフック実行対象から除外される。REQUEST スコープのプロバイダに `onModuleInit` を実装しても呼ばれない（`instance-wrapper.ts:300-320`, `transient-instances.ts:29-31`）

## 適用チェックリスト

- [ ] アプリケーションのライフサイクルフックが依存グラフの順序に従って実行されるか確認する
- [ ] シャットダウンハンドラに再入防止ガード（フラグまたは once パターン）を実装しているか確認する
- [ ] フック検出がランタイムに消える型情報に依存していないか確認する（duck typing を使用しているか）
- [ ] ライフサイクルフック内の非同期処理にタイムアウトを設定しているか確認する
- [ ] プロセスシグナルリスナーの登録が opt-in になっているか確認する（テスト時に副作用がないか）
- [ ] 破棄フックの実行順序が初期化の逆順になっているか確認する
- [ ] 非静的スコープ（リクエストスコープ等）のコンポーネントにモジュールレベルのフックを実装していないか確認する
