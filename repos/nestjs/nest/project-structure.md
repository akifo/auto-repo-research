# project-structure

> リポジトリ: nestjs/nest
> 分析日: 2026-03-03

## 概要

NestJS のモノレポは Lerna + TypeScript Project References による 9 パッケージ構成で、「契約パッケージ (common)」「実装パッケージ (core)」「プラットフォーム差し替えパッケージ (platform-*)」という3層の境界設計を採用している。この構成はフレームワーク利用者が必要な部分だけを選択できるようにしつつ、パッケージ間の依存方向を厳密に制御している。特に「interface は上位パッケージに、実装は下位パッケージに」という一貫した分離原則が、9パッケージ・1667ファイル規模のコードベースを管理可能に保っている点が注目に値する。

## 背景にある原則

- **契約と実装の分離 (Interface Segregation)**: `@nestjs/common` にすべての interface・デコレータ・型定義を集約し、`@nestjs/core` 以下のパッケージが実装を提供する。利用者コードは `@nestjs/common` にのみ依存するため、内部実装の変更から隔離される。根拠: `common/index.ts` が interface のみをエクスポートし、`core/package.json` が `@nestjs/common` を peerDependency として宣言している構造。

- **プラットフォーム差し替え可能性 (Pluggable Platforms)**: HTTP サーバー (Express/Fastify)、WebSocket (Socket.io/ws) というプラットフォーム固有の実装を `platform-*` パッケージに分離し、抽象アダプタクラスを介して差し替え可能にする。利用者はフレームワーク API を変更せずにランタイムを切り替えられる。根拠: `AbstractHttpAdapter` (core) と `ExpressAdapter`/`FastifyAdapter` (platform-*) の継承関係。

- **漸進的採用 (Progressive Adoption)**: WebSocket・Microservices など拡張機能を optional な peerDependency として宣言し、`optionalRequire` による遅延ロードで不在時にも動作させる。最小構成では `common` + `core` + `platform-express` のみで起動でき、必要に応じてパッケージを追加する設計。根拠: `core/nest-application.ts:42-49` の `optionalRequire` パターン。

- **単一バージョン同期 (Lockstep Versioning)**: Lerna の固定バージョンモード (`"version": "11.1.14"`) で全パッケージを同一バージョンで公開し、パッケージ間の互換性問題を構造的に排除する。根拠: `lerna.json` の `version` フィールドと各パッケージの peerDependency 指定 `"^11.0.0"`。

## 実例と分析

### パッケージ依存グラフの方向制御

9パッケージの依存関係は厳密な有向非循環グラフ (DAG) を形成している。TypeScript の Project References (`tsconfig.build.json` の `references` フィールド) がこの DAG をコンパイル時に強制する。

```
common (葉ノード: 依存なし)
  ↑
core (common に依存)
  ↑
├── platform-express (common, core に依存)
├── platform-fastify (common, core に依存)
├── websockets (common, core に依存)
│     ↑
│   ├── platform-socket.io (common, websockets に依存)
│   └── platform-ws (common, websockets に依存)
├── microservices (common, core, websockets に依存)
└── testing (common, core, microservices, platform-express に依存)
```

`common` は他のどのパッケージにも依存しない「契約の頂点」であり、`testing` はすべてのパッケージを参照する「統合の底」に位置する。この DAG は `packages/*/tsconfig.build.json` の `references` で物理的に宣言されている。

### Interface-in-common, Implementation-in-core パターン

`common` パッケージは interface と型だけをエクスポートし、実行可能コードを最小限に抑える。

```typescript
// packages/common/interfaces/http/http-server.interface.ts:17-102
export interface HttpServer<TRequest = any, TResponse = any, ServerInstance = any> {
  use(handler: RequestHandler<TRequest, TResponse> | ErrorHandler<TRequest, TResponse>): any;
  get(handler: RequestHandler<TRequest, TResponse>): any;
  get(path: string, handler: RequestHandler<TRequest, TResponse>): any;
  // ... 30+ メソッドの contract
  getType(): string;
}
```

この interface を `core` の `AbstractHttpAdapter` が抽象クラスとして部分実装し、`platform-express` と `platform-fastify` が具象実装を提供する:

```typescript
// packages/core/adapters/http-adapter.ts:8-12
export abstract class AbstractHttpAdapter<TServer = any, TRequest = any, TResponse = any>
  implements HttpServer<TRequest, TResponse> {
  // 共通メソッドのデフォルト実装 + abstract メソッド宣言
}
```

```typescript
// packages/platform-express/adapters/express-adapter.ts:51-53
export class ExpressAdapter extends AbstractHttpAdapter<http.Server | https.Server> {
  // Express 固有の具象実装
}
```

### Optional Require による疎結合

`core` パッケージは `microservices` と `websockets` をハードに import せず、`optionalRequire` で実行時に動的ロードする:

```typescript
// packages/core/nest-application.ts:42-49
const { SocketModule } = optionalRequire(
  '@nestjs/websockets/socket-module',
  () => require('@nestjs/websockets/socket-module'),
);
const { MicroservicesModule } = optionalRequire(
  '@nestjs/microservices/microservices-module',
  () => require('@nestjs/microservices/microservices-module'),
);
```

対応する `optionalRequire` 実装は失敗時に空オブジェクトを返す:

```typescript
// packages/core/helpers/optional-require.ts:1-7
export function optionalRequire(packageName: string, loaderFn?: Function) {
  try {
    return loaderFn ? loaderFn() : require(packageName);
  } catch (e) {
    return {};
  }
}
```

これとは対照的に、必須依存の `loadPackage` は失敗時に `process.exit(1)` で即座に終了する:

```typescript
// packages/common/utils/load-package.util.ts:8-20
export function loadPackage(packageName: string, context: string, loaderFn?: Function) {
  try {
    return loaderFn ? loaderFn() : require(packageName);
  } catch (e) {
    logger.error(MISSING_REQUIRED_DEPENDENCY(packageName, context));
    Logger.flush();
    process.exit(1);
  }
}
```

### peerDependency + optional meta による選択的依存

各パッケージの `package.json` で `peerDependencies` + `peerDependenciesMeta` を組み合わせ、必須/任意の依存を明示する:

```json
// packages/core/package.json (抜粋)
{
  "peerDependencies": {
    "@nestjs/common": "^11.0.0",
    "@nestjs/microservices": "^11.0.0",
    "@nestjs/platform-express": "^11.0.0",
    "@nestjs/websockets": "^11.0.0"
  },
  "peerDependenciesMeta": {
    "@nestjs/websockets": { "optional": true },
    "@nestjs/microservices": { "optional": true },
    "@nestjs/platform-express": { "optional": true }
  }
}
```

`@nestjs/common` だけが必須で、残りはすべて optional。`microservices` パッケージでは外部トランスポート (Redis, Kafka, NATS, MQTT, RabbitMQ, gRPC) がすべて optional peer として宣言されている。

### Gulp タスクによるモノレポ内の成果物配布

ビルド成果物 (`*.js`, `*.d.ts`) を `node_modules/@nestjs/` にコピーすることで、パッケージ間の相互参照を npm publish なしに実現する:

```typescript
// tools/gulp/tasks/move.ts:11-13
function moveToNodeModules() {
  return distFiles.pipe(dest('node_modules/@nestjs'));
}
```

同様に、`sample/` ディレクトリにも成果物を配布して、サンプルアプリが最新ビルドで動作確認できるようにしている。

### WebSocket の二層アダプタ構造

HTTP アダプタと並行して、WebSocket にも同じ「interface → abstract → concrete」の三層分離が適用されている:

1. **Interface**: `common/interfaces/websockets/web-socket-adapter.interface.ts` — `WebSocketAdapter<TServer, TClient, TOptions>`
2. **Abstract**: `websockets/adapters/ws-adapter.ts` — `AbstractWsAdapter` (共通ロジック)
3. **Concrete**: `platform-socket.io/adapters/io-adapter.ts` — `IoAdapter` / `platform-ws/adapters/ws-adapter.ts` — `WsAdapter`

## パターンカタログ

- **Abstract Factory** (分類: 生成)
  - 解決する問題: プラットフォーム固有のオブジェクト (HTTP サーバー、WebSocket サーバー) を利用者コードから隠蔽する
  - 適用条件: 同一 API で複数の具象実装を切り替える必要がある場合
  - コード例: `packages/core/nest-factory.ts:59-86` — `NestFactory.create()` が `AbstractHttpAdapter` を受け取る
  - 注意点: Factory 自体はプラットフォーム非依存だが、デフォルトの Express アダプタを `loadAdapter` で動的ロードしている

- **Adapter** (分類: 構造)
  - 解決する問題: Express と Fastify という異なるインタフェースを統一的に扱う
  - 適用条件: 既存のライブラリ API をフレームワーク内部の統一 API に変換する場合
  - コード例: `packages/core/adapters/http-adapter.ts:8` — `AbstractHttpAdapter implements HttpServer`
  - 注意点: 抽象クラスで共通メソッドのデフォルト実装を提供しつつ、プラットフォーム固有部分を `abstract` メソッドとして残す

- **Facade** (分類: 構造)
  - 解決する問題: `common` パッケージの `index.ts` が選択的 re-export で公開 API を制御する
  - 適用条件: パッケージの公開サーフェスを制限し、内部実装を隠蔽したい場合
  - コード例: `packages/common/index.ts:13-65` — interface を個別にリストして re-export
  - 注意点: `export *` と個別 export を使い分け、意図的に非公開にするモジュールがある

## Good Patterns

- **契約パッケージの単一責務化**: `@nestjs/common` を interface・デコレータ・ユーティリティ専用にし、実行ランタイムへの依存をゼロに保つ。利用者の `import` 文が常に `@nestjs/common` を起点にするため、バンドルサイズの予測可能性と API の安定性が向上する。

```typescript
// packages/common/index.ts:9-70
export * from './decorators';
export * from './enums';
export * from './exceptions';
export { Abstract, ArgumentMetadata, ArgumentsHost, ... } from './interfaces';
export * from './pipes';
export * from './utils';
// ← ランタイム実装 (NestFactory, DI コンテナ等) は含まない
```

- **共有ユーティリティの軽量化**: `common/utils/shared.utils.ts` の型ガード関数群 (`isUndefined`, `isObject`, `isFunction` 等) を外部ライブラリなしで 52 行に収め、全パッケージで統一的に使用する。

```typescript
// packages/common/utils/shared.utils.ts:1-51
export const isUndefined = (obj: any): obj is undefined => typeof obj === 'undefined';
export const isObject = (fn: any): fn is object => !isNil(fn) && typeof fn === 'object';
export const isFunction = (val: any): val is Function => typeof val === 'function';
// ... すべて1行の純粋関数
```

- **tsconfig Project References による依存方向の強制**: 各パッケージの `tsconfig.build.json` で `references` を明示的に宣言し、許可されていないパッケージからの import をコンパイルエラーにする。

```json
// packages/platform-express/tsconfig.build.json
{
  "references": [
    { "path": "../common/tsconfig.build.json" },
    { "path": "../core/tsconfig.build.json" }
  ]
}
// → platform-express は common と core にのみ依存可能。microservices や websockets を import するとコンパイルエラー
```

## Anti-Patterns / 注意点

- **Optional Require の型安全性の喪失**: `optionalRequire` が返す空オブジェクト `{}` は型チェックを通過するが、実行時にプロパティが `undefined` になる。分割代入で取得した値が falsy かどうかの実行時チェックに頼る設計になっている。

```typescript
// Bad: 型安全性なし — SocketModule が undefined でもコンパイルは通る
const { SocketModule } = optionalRequire('@nestjs/websockets/socket-module', ...);
private readonly socketModule = SocketModule && new SocketModule();

// Better: 型ガード + 明示的な型注釈で意図を表現
const socketModuleExports: { SocketModule?: Type<any> } = optionalRequire(...);
if (socketModuleExports.SocketModule) {
  this.socketModule = new socketModuleExports.SocketModule();
}
```

- **パッケージ数の増殖による認知負荷**: 9パッケージの相互関係を理解する必要があり、新規コントリビュータの参入障壁が高い。特に `websockets` (コアロジック) と `platform-socket.io` / `platform-ws` (具象実装) の分離は、HTTP 側の `core` + `platform-express` / `platform-fastify` と対称的に見えるが、依存方向が微妙に異なる（`platform-socket.io` は `core` に依存しない）。

## 導出ルール

- `[MUST]` モノレポでパッケージ間の依存方向を一方向に強制する仕組み (TypeScript Project References, eslint-plugin-import の no-restricted-paths 等) を導入する
  - 根拠: NestJS は `tsconfig.build.json` の `references` フィールドで DAG を物理的に宣言し、逆方向の import をコンパイル時に検出している (`packages/*/tsconfig.build.json`)

- `[MUST]` 契約 (interface/型定義) と実装を別パッケージに分離する場合、契約パッケージはランタイム依存をゼロに保つ
  - 根拠: `@nestjs/common` は `reflect-metadata` 以外のランタイム依存を持たず、全パッケージの共通基盤として安定した API サーフェスを提供している (`packages/common/package.json`)

- `[SHOULD]` モノレポの全パッケージを Lockstep Versioning (固定バージョン同期) で公開し、パッケージ間の互換性マトリクスを排除する
  - 根拠: `lerna.json` の `"version": "11.1.14"` と peerDependency のメジャーバージョン範囲指定 `"^11.0.0"` の組み合わせで、バージョン不整合を構造的に防止している

- `[SHOULD]` 拡張パッケージは peerDependency + optional メタデータで宣言し、不在時にも基本機能が動作するよう optional require パターンを使う
  - 根拠: `core/nest-application.ts` が `optionalRequire` で `@nestjs/websockets` と `@nestjs/microservices` を遅延ロードし、最小構成 (common + core + platform-express) での起動を保証している

- `[SHOULD]` プラットフォーム差し替え可能な設計では、抽象クラスに共通ロジックのデフォルト実装を持たせ、プラットフォーム固有メソッドのみ abstract にする
  - 根拠: `AbstractHttpAdapter` が `get()`, `post()`, `use()` 等の委譲メソッドをデフォルト実装し、`initHttpServer()`, `reply()`, `getType()` 等のプラットフォーム固有メソッドだけを abstract として宣言している (`packages/core/adapters/http-adapter.ts`)

- `[AVOID]` モノレポ内のパッケージ間で循環依存を作る — peerDependency の optional 指定でも循環は避ける
  - 根拠: NestJS の 9 パッケージは厳密な DAG を形成しており、`core` → `websockets` / `microservices` の参照は peerDependency (optional) + `optionalRequire` で実装し、ビルド時の循環参照を回避している

## 適用チェックリスト

- [ ] モノレポのパッケージ間依存が DAG (有向非循環グラフ) になっているか確認する
- [ ] TypeScript Project References または同等の仕組みで依存方向をコンパイル時に強制しているか確認する
- [ ] 契約パッケージ (interface/型定義) が実装パッケージに依存していないか確認する
- [ ] プラットフォーム差し替えが必要な箇所で interface → abstract class → concrete class の三層構造を適用しているか確認する
- [ ] 拡張パッケージが optional peerDependency として宣言され、不在時にも基本動作するか確認する
- [ ] 全パッケージのバージョン管理戦略 (Lockstep vs Independent) が意図的に選択されているか確認する
- [ ] ビルド成果物の配布方法 (npm workspaces, Gulp コピー, symlink 等) がモノレポ内の相互参照を正しく解決しているか確認する
