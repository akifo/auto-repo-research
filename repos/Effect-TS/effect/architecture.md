# architecture

> リポジトリ: Effect-TS/effect
> 分析日: 2026-02-18

## 概要

Effect-TS のモノレポは 30 以上のパッケージを「コア / プラットフォーム抽象 / プラットフォーム実装 / エコシステム」の 4 層に分離し、依存の方向を厳密に一方向に制御している。公開 API と内部実装を `src/` と `src/internal/` の 2 階層に分け、モジュール境界を TypeScript の import 構造だけで強制する点が特徴的である。この構造は Tag（サービス識別子）、Layer（依存の合成レシピ）、Context（依存の実行時マップ）の 3 要素による DI パターンと結びつき、プラットフォーム間の実装差し替えを型レベルで保証している。

## 背景にある原則

- **依存の方向は常にコアに向かうべき**: すべてのエコシステムパッケージは `effect`（コア）に依存し、逆方向の依存は存在しない。`@effect/platform` は `effect` のみに依存し、`@effect/platform-node` は `@effect/platform` と `effect` に依存する。この一方向性により、コアの変更がプラットフォーム固有コードに波及しにくい。根拠: 各 `package.json` の peerDependencies 構造。

- **インターフェースと実装は別パッケージに分離すべき**: `@effect/platform` が FileSystem・HttpClient・HttpServer 等の抽象インターフェースを定義し、`@effect/platform-node`・`@effect/platform-bun`・`@effect/platform-browser` がそれぞれの実装を提供する。消費側は抽象パッケージのみに依存し、実装はアプリケーションのエントリポイントで Layer として注入する。根拠: `packages/platform/src/FileSystem.ts`（interface 定義）と `packages/platform-node-shared/src/internal/fileSystem.ts`（Node.js 実装）。

- **内部実装の隠蔽は言語機能ではなくモジュール構造で強制すべき**: TypeScript には `internal` アクセス修飾子がないため、Effect は `src/internal/` ディレクトリに実装を配置し、公開モジュール（`src/*.ts`）が `internal` から re-export するパターンで API 境界を制御している。公開ファイルは型シグネチャとドキュメントの定義に集中し、ロジックは `internal` に委譲する。根拠: `packages/effect/src/Layer.ts` の全 export が `= internal.*` の形式。

- **循環依存はファイル分割で解消すべき**: コア内部で Effect と Layer、Fiber と Scope など相互に参照が必要なモジュール間の循環依存を、`internal/effect/circular.ts`・`internal/layer/circular.ts` のような専用ファイルに分離して解消している。根拠: `internal/` 配下の `// circular` コメント（20 箇所以上）。

## 実例と分析

### 4 層のパッケージ階層

Effect モノレポは以下の依存階層を持つ。

1. **コア層** (`effect`): 177 の公開モジュール。Effect, Layer, Context, Stream, Schema, Fiber 等のプリミティブ。外部依存ゼロ。
2. **プラットフォーム抽象層** (`@effect/platform`): FileSystem, HttpClient, HttpServer, Socket 等のインターフェース。`effect` のみに依存。
3. **プラットフォーム実装層** (`@effect/platform-node`, `@effect/platform-bun`, `@effect/platform-browser`): 各ランタイムの具象実装。`@effect/platform` + `effect` に依存。
4. **エコシステム層** (`@effect/sql`, `@effect/rpc`, `@effect/cluster`, `@effect/opentelemetry` 等): 高レベルの機能。必要に応じてプラットフォーム抽象層に依存。

SQL パッケージ群はさらに細分化されており、`@effect/sql`（抽象 SqlClient）を中心に `@effect/sql-pg`, `@effect/sql-mysql2`, `@effect/sql-sqlite-node` 等のドライバ固有パッケージが実装を提供する。この構造はプラットフォーム層と同型であり、「抽象 + 複数実装」のパターンが一貫して適用されている。

### Tag / Layer / Context による DI 三角形

サービスの定義・合成・解決を 3 つのプリミティブで分離している。

- **Tag**: サービスの識別子（型レベルの鍵）。`Context.Tag` または `Context.GenericTag` で作成。
- **Layer**: サービスの構築レシピ。依存するサービスを入力、生成するサービスを出力とした有向グラフのノード。
- **Context**: 実行時のサービスマップ。Tag をキーとして実装を保持する。

この 3 要素を組み合わせることで、サービス間の依存関係が型レベルで追跡され、未提供のサービスはコンパイルエラーとして検出される。

### public / internal の 2 層構造

コアパッケージ `effect` は 177 の公開モジュール（`src/*.ts`）と 101 の内部モジュール（`src/internal/*.ts`）を持つ。公開モジュールは以下の役割に特化する:

1. インターフェース（型）の定義
2. JSDoc によるドキュメント
3. `internal` からの re-export

ロジック、クラス定義、データ構造の実装はすべて `internal` に配置される。この分離により、公開 API の変更は `src/*.ts` のシグネチャ変更のみで済み、内部リファクタリングが API 互換性を破壊しない。

### 循環依存の解消パターン

内部モジュール間で相互参照が必要な場合、Effect は以下のパターンで循環を解消している:

- `internal/core.ts` に最も低レベルな Effect プリミティブを配置
- `internal/core-effect.ts` に core に依存する Effect ユーティリティを配置
- `internal/fiberRuntime.ts` にランタイム実装を配置
- 相互参照が必要な機能は `internal/effect/circular.ts`, `internal/layer/circular.ts` に分離

各循環ファイルには `// circular with X` のコメントが付き、どのモジュールとの循環を解消しているかが明示されている。

## コード例

```typescript
// packages/platform/src/FileSystem.ts:21-30
// プラットフォーム抽象: インターフェースのみ定義
export interface FileSystem {
  readonly access: (
    path: string,
    options?: AccessFileOptions,
  ) => Effect.Effect<void, PlatformError>;
  readonly copy: (
    fromPath: string,
    toPath: string,
    options?: CopyOptions,
  ) => Effect.Effect<void, PlatformError>;
  // ...
}
```

```typescript
// packages/platform-node-shared/src/internal/fileSystem.ts:648
// プラットフォーム実装: Layer.effect で Tag にバインド
export const layer = Layer.effect(FileSystem.FileSystem, makeFileSystem);
```

```typescript
// packages/platform-node/src/NodeContext.ts:32-40
// Layer の合成: mergeAll + provideMerge で複数サービスを束ねる
export const layer: Layer.Layer<NodeContext> = pipe(
  Layer.mergeAll(
    NodePath.layer,
    NodeCommandExecutor.layer,
    NodeTerminal.layer,
    NodeWorker.layerManager,
  ),
  Layer.provideMerge(NodeFileSystem.layer),
);
```

```typescript
// packages/effect/src/Layer.ts:53 (公開モジュール)
export const LayerTypeId: unique symbol = internal.LayerTypeId;

// packages/effect/src/internal/layer.ts:43-45 (内部モジュール)
export const LayerTypeId: Layer.LayerTypeId = Symbol.for(
  LayerSymbolKey,
) as Layer.LayerTypeId;
```

```typescript
// packages/sql-pg/src/PgClient.ts:550-558
// SQL ドライバの Layer: 抽象 SqlClient と具象 PgClient の両方を提供
export const layer = (
  config: PgClientConfig,
): Layer.Layer<PgClient | Client.SqlClient, SqlError> =>
  Layer.scopedContext(
    Effect.map(make(config), (client) =>
      Context.make(PgClient, client).pipe(
        Context.add(Client.SqlClient, client),
      )),
  ).pipe(Layer.provide(Reactivity.layer));
```

```typescript
// packages/effect/src/GlobalValue.ts:42-53
// グローバルシングルトンの安全な管理
export const globalValue = <A>(id: unknown, compute: () => A): A => {
  if (!globalStore) {
    // @ts-expect-error
    globalThis[globalStoreId] ??= new Map();
    // @ts-expect-error
    globalStore = globalThis[globalStoreId] as Map<unknown, any>;
  }
  if (!globalStore.has(id)) {
    globalStore.set(id, compute());
  }
  return globalStore.get(id)!;
};
```

## パターンカタログ

- **Abstract Factory** (分類: 生成)
  - 解決する問題: プラットフォーム固有の実装を、消費側コードから分離する
  - 適用条件: 同一インターフェースに対して複数の実装（Node.js / Bun / Browser）が必要な場合
  - コード例: `packages/platform/src/FileSystem.ts`（抽象）→ `packages/platform-node-shared/src/internal/fileSystem.ts:648`（具象 Layer）
  - 注意点: Effect では Factory オブジェクトではなく Layer の合成で実現。GoF の Abstract Factory と異なり、生成ロジック自体が Effect（副作用を表現する値）として扱われるため、リソース管理（Scope）と自然に統合される

- **Facade** (分類: 構造)
  - 解決する問題: 内部の複雑な実装を単純な公開 API の背後に隠す
  - 適用条件: 内部モジュールが多数存在し、利用者に安定したインターフェースを提供したい場合
  - コード例: `packages/effect/src/Layer.ts` の全 export が `= internal.*` 形式
  - 注意点: 公開モジュールにロジックを書かないルールが前提。違反すると Facade としての境界が崩壊する

- **Service Locator → Dependency Injection** (分類: 振る舞い)
  - 解決する問題: サービスの取得を実行時のルックアップではなく、型レベルの依存として表現する
  - 適用条件: サービス間の依存グラフを静的に検証したい場合
  - コード例: `Context.Tag` + `Layer.effect` + `Effect.provideLayer` の組み合わせ
  - 注意点: Tag は `Symbol.for` で一意性を保証しており、異なるバンドルから同じサービスを参照可能（`GlobalValue` パターン）

## Good Patterns

- **Layer の二重提供パターン**: SQL ドライバ（`PgClient.layer`）が抽象 Tag (`SqlClient`) と具象 Tag (`PgClient`) の両方を同時に Context に登録する。消費側は汎用コードでは `SqlClient` を、PG 固有機能が必要な場合は `PgClient` を要求できる。

```typescript
// packages/sql-pg/src/PgClient.ts:550-558
export const layer = (config: PgClientConfig): Layer.Layer<PgClient | Client.SqlClient, SqlError> =>
  Layer.scopedContext(
    Effect.map(make(config), (client) =>
      Context.make(PgClient, client).pipe(
        Context.add(Client.SqlClient, client),
      )),
  ).pipe(Layer.provide(Reactivity.layer));
```

- **NodeContext による複合サービスの束ね**: 複数のプラットフォームサービスを 1 つの Layer に合成し、型エイリアスで「このランタイムで使える全サービス」を表現する。利用者は `NodeContext.layer` を 1 行で提供するだけで Node.js 固有の全サービスが注入される。

```typescript
// packages/platform-node/src/NodeContext.ts:21-40
export type NodeContext =
  | CommandExecutor.CommandExecutor
  | FileSystem.FileSystem
  | Path.Path
  | Terminal.Terminal
  | Worker.WorkerManager;

export const layer: Layer.Layer<NodeContext> = pipe(
  Layer.mergeAll(NodePath.layer, NodeCommandExecutor.layer, NodeTerminal.layer, NodeWorker.layerManager),
  Layer.provideMerge(NodeFileSystem.layer),
);
```

- **GlobalValue によるシングルトン保証**: `Symbol.for` ベースのグローバルストアにより、CJS/ESM 混在環境やホットリロード環境でもシングルトンインスタンスの一意性を保証する。TypeId や FiberRef の登録に一貫して使用されている。

```typescript
// packages/effect/src/GlobalValue.ts:42-53
export const globalValue = <A>(id: unknown, compute: () => A): A => {
  if (!globalStore) {
    globalThis[globalStoreId] ??= new Map();
    globalStore = globalThis[globalStoreId] as Map<unknown, any>;
  }
  if (!globalStore.has(id)) {
    globalStore.set(id, compute());
  }
  return globalStore.get(id)!;
};
```

## Anti-Patterns / 注意点

- **公開モジュールにロジックを書く**: `src/Layer.ts` のような公開モジュールにロジックを直接実装すると、API 境界と実装の分離が崩壊する。公開モジュールの変更は API 互換性に直結するため、リファクタリングの自由度が失われる。

```typescript
// Bad: 公開モジュールにロジックを直接実装
// src/Layer.ts
export const mergeAll = (...layers) => {
  // 実装ロジック...
};

// Better: 公開モジュールは internal から re-export のみ
// src/Layer.ts
export const mergeAll = internal.mergeAll;
// src/internal/layer.ts
export const mergeAll = (...layers) => {
  // 実装ロジック...
};
```

- **循環依存を放置する**: Effect のコア内部では Effect ↔ Layer、Fiber ↔ Scope など相互参照が不可避だが、これを単一ファイルに詰め込むとファイルが肥大化しビルドが不安定になる。Effect は `circular.ts` ファイルに分離して対処している。

```typescript
// Bad: core.ts に Layer 依存のコードを直接書く（循環発生）

// Better: internal/layer/circular.ts に分離し、コメントで循環元を明示
// circular with Logger
export const minimumLogLevel = (level: LogLevel.LogLevel): Layer.Layer<never> =>
  layer.scopedDiscard(fiberRuntime.fiberRefLocallyScoped(fiberRuntime.currentMinimumLogLevel, level));
```

## 導出ルール

- `[MUST]` 公開 API（`src/*.ts`）と内部実装（`src/internal/*.ts`）を分離し、公開モジュールにはロジックを書かず re-export に徹する
  - 根拠: Effect コアの 177 公開モジュールすべてが `= internal.*` 形式で export しており、この一貫性が API 安定性とリファクタリング自由度の両立を実現している

- `[MUST]` パッケージ間の依存方向を「コア ← 抽象 ← 実装 ← エコシステム」の一方向に制限する
  - 根拠: Effect の 30+ パッケージすべてが `effect`（コア）を peerDependency として参照し、逆方向の依存が存在しない構造により、コア変更の影響範囲が制御されている

- `[SHOULD]` プラットフォーム固有の機能は「抽象インターフェース（パッケージ A）+ 具象実装（パッケージ B）」に分離し、消費側は抽象のみに依存させる
  - 根拠: `@effect/platform`（抽象）と `@effect/platform-node`（実装）の分離により、Node.js / Bun / Browser の 3 実装が同一インターフェースを共有し、アプリケーションコードの変更なしにランタイムを切り替えられる

- `[SHOULD]` 具象実装の Layer は抽象 Tag と具象 Tag の両方を Context に登録し、消費側が汎用/固有を選択できるようにする
  - 根拠: `PgClient.layer` が `SqlClient`（汎用）と `PgClient`（PG 固有）の両方を提供しており、共通ロジックとドライバ固有ロジックを同一アプリケーション内で使い分けられる

- `[SHOULD]` モジュール間の循環依存は専用の `circular` ファイルに分離し、循環の相手をコメントで明示する
  - 根拠: `internal/` 配下に 20 箇所以上の `// circular with X` コメントがあり、循環の意図と範囲が文書化されている

- `[SHOULD]` CJS/ESM 混在環境やホットリロード環境では `Symbol.for` + グローバルストアでシングルトンの一意性を保証する
  - 根拠: `GlobalValue.ts` が `globalThis` 上のバージョン付きストアを使い、モジュールの多重ロードによるインスタンス重複を防いでいる

- `[AVOID]` 実装パッケージ（`platform-node` 等）をライブラリコードの依存に含める。ランタイム実装はアプリケーションのエントリポイントでのみ Layer として提供する
  - 根拠: Effect のすべてのライブラリパッケージは `@effect/platform`（抽象）にのみ依存し、`@effect/platform-node`（実装）は peerDependency として利用者に委ねている

## 適用チェックリスト

- [ ] パッケージの依存方向が一方向（コア → 抽象 → 実装）になっているか
- [ ] 公開 API とロジック実装がディレクトリレベルで分離されているか
- [ ] プラットフォーム固有コードが抽象インターフェースの背後に隠れているか
- [ ] サービスの依存関係が型レベルで追跡可能か（未提供サービスがコンパイルエラーになるか）
- [ ] 循環依存が発生している箇所を特定し、分離ファイルで対処しているか
- [ ] シングルトンが CJS/ESM 混在やホットリロードで壊れないか（`Symbol.for` 等の対策があるか）
- [ ] 具象実装の Layer が抽象 Tag にもバインドされているか（消費側の柔軟性）
- [ ] 複数のプラットフォームサービスを 1 つの複合 Layer に束ねて提供しているか
