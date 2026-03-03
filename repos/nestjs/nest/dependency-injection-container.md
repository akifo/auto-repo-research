# dependency-injection-container

> リポジトリ: nestjs/nest
> 分析日: 2026-03-03

## 概要

NestJS の IoC コンテナは `packages/core/injector/` に集約されており、モジュールベースの依存関係グラフ構築、3 種類のプロバイダスコープ（DEFAULT / REQUEST / TRANSIENT）、二段階インスタンス化（プロトタイプ→実体）、遅延モジュールロード、循環依存の検出・解決など、本格的な DI コンテナに必要な要素を網羅している。特にインスタンスのライフサイクルを `ContextId` と `WeakMap` で管理し、リクエストスコープインスタンスを GC 可能にしている設計は、サーバーサイド DI コンテナのリファレンス実装として注目に値する。

## 背景にある原則

- **間接参照によるモジュール同一性**: モジュールの同一性をクラス参照そのものではなく、不透明キー（opaque key）で管理する。これにより動的モジュール（同一クラスで異なる設定）を個別に識別でき、またスナップショットやテスト用にキー生成戦略を差し替えられる。`ModuleOpaqueKeyFactory` インターフェースと 2 つの実装（`ByReferenceModuleOpaqueKeyFactory`, `DeepHashedModuleOpaqueKeyFactory`）がこれを支える（`container.ts:51-59`）。

- **二段階インスタンス化で循環依存を吸収する**: プロトタイプオブジェクトを先に作成し、依存解決後に実際のコンストラクタ呼び出しで上書きする。`forwardRef` で参照されたクラスは `Object.assign` で既存プロトタイプにマージされる（`injector.ts:844-848`）。これにより循環依存のある 2 クラスを相互に注入できる。

- **スコープの伝播は依存ツリー全体の静的性で判定する**: 個々のプロバイダのスコープだけでなく、その依存ツリー全体が静的かどうかを再帰的に検査する（`isDependencyTreeStatic`）。REQUEST スコープのプロバイダが 1 つでも依存ツリーに含まれれば、そのツリー全体が非静的と判定され、リクエストごとに再生成される（`instance-wrapper.ts:300-319`）。

- **ContextId を WeakMap キーにして GC を活用する**: リクエストスコープのインスタンスを `WeakMap<ContextId, InstancePerContext>` に格納し、リクエスト終了時に ContextId オブジェクトの参照が消えることで自動的にインスタンスが GC される。明示的なクリーンアップが不要な設計（`instance-wrapper.ts:78`）。

## 実例と分析

### プロバイダの 4 つの登録形態

`Module.addProvider` は通常のクラスプロバイダを、`addCustomProvider` は `useClass` / `useValue` / `useFactory` / `useExisting` の 4 形態を処理する。各形態は `InstanceWrapper` の初期化パラメータが異なる:

- **useValue**: `isResolved: true` で即時解決済みとして登録。インスタンス化不要（`module.ts:386-403`）
- **useFactory**: `metatype` にファクトリ関数を、`inject` に依存トークン配列を格納。`Injector` がファクトリの引数を解決して呼び出す（`module.ts:405-433`）
- **useExisting**: エイリアスとして実装。`inject: [useExisting]` でアイデンティティ関数 `(instance => instance)` を metatype に設定（`module.ts:435-455`）
- **useClass**: トークンと実装クラスを分離。インターフェースベース注入の実現手段（`module.ts:349-378`）

### Barrier パターンによる並行依存解決の同期

`Injector.resolveConstructorParams` では全コンストラクタパラメータを `Promise.all` で並行に解決するが、その途中で依存ツリーの静的性を誤判定しないよう `Barrier` で全パラメータの `InstanceWrapper` 解決を同期する:

```typescript
// packages/core/helpers/barrier.ts:1-51
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

全パラメータの wrapper 解決が完了してから `resolveComponentHost` を呼ぶことで、静的性の誤判定を防いでいる（`injector.ts:349`）。

### SettlementSignal による循環依存検出

`SettlementSignal` は Promise ベースの解決シグナルに加え、`_refs` Set でどの wrapper に依存しているかを追跡する。あるプロバイダの解決中に、そのプロバイダ自身が依存先として再度要求された場合、`isCycle` で循環を検出して例外を投げる:

```typescript
// packages/core/injector/settlement-signal.ts:47-58
public insertRef(wrapperId: string) {
  this._refs.add(wrapperId);
}

public isCycle(wrapperId: string) {
  return !this.completed && this._refs.has(wrapperId);
}
```

`Injector.loadInstance` 内で `instanceHost.isPending` の場合にこの検出が走る（`injector.ts:141-151`）。

### TRANSIENT スコープのインスタンス隔離

TRANSIENT プロバイダは注入先ごとに個別インスタンスを生成する。これを実現するため `InstanceWrapper` は `transientMap: Map<inquirerId, WeakMap<ContextId, InstancePerContext>>` の二重マップを持つ。inquirerId（注入先の ID）とコンテキスト ID の組み合わせでインスタンスを隔離する:

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

### LazyModuleLoader による遅延ロード

`LazyModuleLoader.load` はアプリケーション起動後に動的にモジュールを追加する。既にロード済みならキャッシュから返し、未ロードなら `DependenciesScanner` でスキャン → `InstanceLoader` でインスタンス化する一連のパイプラインを実行する（`lazy-module-loader.ts:21-55`）。ロガー無効化オプション（`SilentLogger`）を持ち、遅延ロード時のログノイズを抑制できる。

### TopologyTree によるモジュール初期化順序の決定

`TopologyTree` はモジュールの import 関係をツリーに変換し、深さ（depth）でライフサイクルフックの実行順序を決定する。同じモジュールが複数箇所から import される場合、より深い位置に relink することで、依存先が依存元より先に初期化されることを保証する（`topology-tree.ts:33-41`）。

## パターンカタログ

- **Abstract Factory** (生成パターン)
  - 解決する問題: モジュールの同一性判定アルゴリズムをコンテナから分離する
  - 適用条件: 同一インターフェースで複数のキー生成戦略が必要な場合
  - コード例: `opaque-key-factory/interfaces/module-opaque-key-factory.interface.ts:5-26`、`by-reference-module-opaque-key-factory.ts`、`deep-hashed-module-opaque-key-factory.ts`
  - 注意点: `DeepHashedModuleOpaqueKeyFactory` はシリアライズに 10ms 以上かかると警告ログを出す（パフォーマンス監視付き）

- **Wrapper / Decorator** (構造パターン)
  - 解決する問題: プロバイダのメタ情報（スコープ、依存関係、インスタンス状態）をインスタンスから分離して管理する
  - 適用条件: 単一のオブジェクトに対して複数のコンテキスト別インスタンスを管理する必要がある場合
  - コード例: `instance-wrapper.ts:61-544`（`InstanceWrapper` がプロバイダの全メタデータとインスタンスストアを保持）
  - 注意点: wrapper 自体がメタデータキャッシュ（`isTreeStatic`, `isTreeDurable`）を持ち、再計算を避ける

- **Barrier (同期プリミティブ)** (並行パターン)
  - 解決する問題: 並行に解決される依存パラメータ間で、全 wrapper 解決後まで後続処理を待機させる
  - 適用条件: 複数の非同期処理を並行に走らせつつ、全完了後に一貫した状態で次のステップに進む必要がある場合
  - コード例: `packages/core/helpers/barrier.ts:1-51`、使用箇所 `injector.ts:316,349`

## Good Patterns

- **WeakMap によるコンテキスト別インスタンスの自動 GC**: `InstanceWrapper.values` を `WeakMap<ContextId, InstancePerContext>` として定義し、リクエスト終了時に ContextId 参照が消えるとインスタンスも自動回収される。明示的な dispose/cleanup コードが不要になり、メモリリークのリスクを構造的に排除している（`instance-wrapper.ts:78`）。

```typescript
// packages/core/injector/instance-wrapper.ts:78
private readonly values = new WeakMap<ContextId, InstancePerContext<T>>();
```

- **スコープ伝播の再帰的検査とキャッシュ**: `isDependencyTreeStatic` は依存ツリー全体を再帰走査して静的性を判定するが、結果を `isTreeStatic` フィールドにキャッシュして二度目以降の計算を省く。循環参照は `lookupRegistry` で検出して無限ループを回避する（`instance-wrapper.ts:300-319`）。

```typescript
// packages/core/injector/instance-wrapper.ts:300-319
public isDependencyTreeStatic(lookupRegistry: string[] = []): boolean {
  if (!isUndefined(this.isTreeStatic)) {
    return this.isTreeStatic;  // キャッシュヒット
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

- **useExisting をアイデンティティ関数ファクトリで統一的に処理**: エイリアスプロバイダをファクトリプロバイダの特殊ケースとして実装し、専用の解決パスを作らずに既存のファクトリ解決ロジックを再利用している（`module.ts:435-455`）。

```typescript
// packages/core/injector/module.ts:446-447
metatype: (instance => instance) as any,
inject: [useExisting],
```

## Anti-Patterns / 注意点

- **REQUEST スコープの無自覚な伝播**: REQUEST スコープのプロバイダを 1 つでも依存に含めると、そのプロバイダの全依存元チェーンが非静的になり、リクエストごとに再生成される。パフォーマンスへの影響が大きいが、`NEST_DEBUG` 環境変数を設定しない限りログに表示されない。

```typescript
// Bad: 大規模サービスが REQUEST スコープに引きずられる
@Injectable({ scope: Scope.REQUEST })
export class RequestContext { /* ... */ }

@Injectable() // DEFAULT だが RequestContext に依存
export class HeavyService {
  constructor(private ctx: RequestContext) {} // 暗黙的にリクエストスコープ化
}
```

```typescript
// Better: REQUEST スコープの依存を局所化し、必要な値だけを注入する
@Injectable({ scope: Scope.REQUEST })
export class RequestContext { /* ... */ }

@Injectable() // DEFAULT のまま維持
export class HeavyService {
  constructor(@Inject('REQUEST_USER_ID') private userId: string) {}
}
// ファクトリプロバイダで必要な値だけを抽出
```

- **ContextId の `Math.random()` による生成**: `createContextId` は `{ id: Math.random() }` でコンテキスト ID を生成する（`context-id-factory.ts:14`）。WeakMap のキーはオブジェクト参照で比較されるため数値の一意性は不要だが、デバッグ時に ID が衝突して混乱する可能性がある。コメントでその設計判断を明示的に記述している点は良い実践。

## 導出ルール

- `[MUST]` DI コンテナでスコープ付きインスタンスを管理する場合、コンテキストキーを WeakMap のキーに使い、コンテキスト終了時の GC に任せる設計にする
  - 根拠: NestJS は `WeakMap<ContextId, InstancePerContext>` でリクエストスコープのインスタンスを保持し、明示的 cleanup なしでメモリリークを防いでいる（`instance-wrapper.ts:78`）

- `[MUST]` 依存ツリーの再帰的検査（スコープ伝播・循環検出等）では、訪問済みノードのレジストリを引き回して無限ループを防止する
  - 根拠: `isDependencyTreeStatic` と `isDependencyTreeDurable` は `lookupRegistry: string[]` で訪問済みノードを追跡し、循環参照での無限再帰を回避している（`instance-wrapper.ts:273,300`）

- `[SHOULD]` 複数の非同期依存を並行解決する場合、Barrier パターンで全依存の wrapper 解決を同期してから後続のインスタンス化に進む
  - 根拠: NestJS の `Injector` は `Promise.all` で並行にパラメータを解決するが、`Barrier.signalAndWait()` で全 wrapper 解決を待ってから `resolveComponentHost` を呼ぶことで依存ツリー静的性の誤判定を防いでいる（`injector.ts:316,349`）

- `[SHOULD]` 二段階インスタンス化（プロトタイプ生成→コンストラクタ呼び出し）で循環依存を解決可能にする。プロトタイプを先に注入先に渡し、後からコンストラクタの戻り値で `Object.assign` マージする
  - 根拠: `InstanceLoader.createInstancesOfDependencies` はまず `createPrototypes` で全プロバイダの `Object.create(metatype.prototype)` を生成し、その後 `createInstances` で実体を注入する（`instance-loader.ts:26-37`, `injector.ts:844-848`）

- `[SHOULD]` モジュールの同一性判定ロジックはインターフェースで抽象化し、テスト・スナップショット・本番で戦略を差し替え可能にする
  - 根拠: `ModuleOpaqueKeyFactory` インターフェースの下に `ByReferenceModuleOpaqueKeyFactory`（参照ベース、高速）と `DeepHashedModuleOpaqueKeyFactory`（内容ベース、決定的）の 2 戦略が存在する（`container.ts:51-59`）

- `[AVOID]` DI コンテナでプロバイダの登録形態ごとに完全に異なる解決パスを作る。ファクトリ・エイリアス・クラスの差異は `InstanceWrapper` のメタデータ初期化で吸収し、解決ロジックは統一する
  - 根拠: NestJS は `useExisting` をアイデンティティ関数ファクトリとして扱い（`module.ts:446`）、`useClass` は `inject: null` のクラスとして扱うことで、`Injector.instantiateClass` の分岐を `isNil(inject)` の一箇所に集約している（`injector.ts:843-860`）

## 適用チェックリスト

- [ ] DI コンテナのスコープ付きインスタンス管理に WeakMap を使い、コンテキスト終了時の自動 GC を活用しているか
- [ ] 依存ツリーの再帰的検査に訪問済みレジストリを用いて循環参照での無限ループを防いでいるか
- [ ] プロバイダの登録形態（値・クラス・ファクトリ・エイリアス）を wrapper のメタデータ差異として吸収し、解決ロジックを統一しているか
- [ ] 並行依存解決時に Barrier 等の同期プリミティブで全 wrapper 解決を待ってからインスタンス化しているか
- [ ] REQUEST / TRANSIENT スコープの伝播が意図せず広がっていないかデバッグ手段を用意しているか
- [ ] モジュール同一性の判定ロジックを戦略パターンで差し替え可能にしているか
- [ ] 循環依存を二段階インスタンス化（プロトタイプ→実体）で解決できる構造になっているか
