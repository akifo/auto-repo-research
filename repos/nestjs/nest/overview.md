# nestjs/nest

> URL: https://github.com/nestjs/nest
> Stars: 74.8k | 言語: TypeScript | ライセンス: MIT | 分析日: 2026-03-03

## サマリー

NestJS は「デコレータでメタデータを格納し、ランタイムが解釈する」という一貫した分離原則のもと、DI コンテナ・リクエストパイプライン・プラットフォームアダプター・マイクロサービストランスポートの全レイヤーを統一的に構造化した大規模フレームワークである。このリポジトリから学べる核心は、(1) メタデータ駆動アーキテクチャによる宣言的コードと実行時振る舞いの完全分離、(2) Interface → Abstract Class → Concrete Class の三層抽象化によるプラットフォーム交換可能性の実現手法、(3) WeakMap/Barrier/TopologyTree を駆使した DI コンテナのスコープ管理・並行制御・ライフサイクル順序保証の実装パターンである。

## 技術スタック

- **言語**: TypeScript (ES2021 target, experimentalDecorators + emitDecoratorMetadata)
- **フレームワーク**: Express 5 / Fastify (platform adapters)、Socket.IO / WS (WebSocket)
- **ビルド**: tsc (TypeScript Project References) + Gulp (成果物配布) + Lerna (monorepo)
- **テスト**: Mocha + Chai + Sinon (単体)、Supertest (統合)、Docker Compose (外部サービス)
- **パッケージマネージャ**: npm + Lerna (lockstep versioning)
- **リンター**: ESLint + Prettier
- **CI**: Husky + lint-staged (pre-commit)

## 分析した視点

| #  | 視点                            | ファイル                           | 概要                                                                                                                        |
| -- | ------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1  | project-structure               | project-structure.md               | 契約(common)・実装(core)・プラットフォーム(platform-*)の3層分離とtsconfig Project Referencesによる依存方向の強制            |
| 2  | architecture                    | architecture.md                    | TopologyTreeによるモジュール初期化順序の自動決定、3フェーズブートストラップ、Barrierベースの並行依存解決                    |
| 3  | design-philosophy               | design-philosophy.md               | デコレータはメタデータ格納のみに徹し、ランタイムが解釈する分離設計。横断的関心事をパイプラインで合成                        |
| 4  | decorator-driven-architecture   | decorator-driven-architecture.md   | Watermark・構成・累積・パラメータの4種デコレータパターンと3層メタデータマージ(Global→Class→Method)                          |
| 5  | dependency-injection-container  | dependency-injection-container.md  | WeakMapベースのスコープ管理、二段階インスタンス化による循環依存解決、SettlementSignalによる循環検出                         |
| 6  | request-pipeline-orchestration  | request-pipeline-orchestration.md  | 固定順序パイプライン+ContextCreator基底クラスによる3層メタデータ合成+null短絡最適化                                         |
| 7  | adapter-implementation-patterns | adapter-implementation-patterns.md | Interface→AbstractClass→Concreteの三層抽象化、Proxyによるメソッド委譲、型付き脱出口の提供                                   |
| 8  | type-system-patterns            | type-system-patterns.md            | inject?:neverによる排他的プロパティ制約、as const+indexed access typeでの型導出、Builder型パラメータの段階的確定            |
| 9  | metaprogramming-techniques      | metaprogramming-techniques.md      | 3層デコレータファクトリ、design:paramtypesによるDI自動解決、MetadataScannerのキャッシュ付きプロトタイプ走査                 |
| 10 | middleware-composition          | middleware-composition.md          | Fluent APIによる宣言的登録、モジュール依存グラフに基づく実行順序決定、関数→クラスの正規化変換                               |
| 11 | hook-and-lifecycle-patterns     | hook-and-lifecycle-patterns.md     | トポロジカルソートによるフック実行順序制御、duck typingによるフック検出、再入防止付きシャットダウン                         |
| 12 | extensibility-mechanisms        | extensibility-mechanisms.md        | ConfigurableModuleBuilderによるregister/registerAsyncの自動生成、setExtrasでのメタ設定とビジネス設定の分離                  |
| 13 | error-handling-idioms           | error-handling-idioms.md           | トランスポート独立の例外階層、instanceofベースのフィルタ選択、IntrinsicExceptionによるログ抑制マーカー                      |
| 14 | testing-practices               | testing-practices.md               | 単体テスト(DI不使用)と統合テスト(TestingModule)の二層構造、useMockerによる自動モック、Noop実装パターン                      |
| 15 | transport-layer-abstraction     | transport-layer-abstraction.md     | ReadPacket/WritePacketによる統一メッセージ契約、Strategyパターンのシリアライザ差し替え、7トランスポートの抽象化             |
| 16 | api-design-practices            | api-design-practices.md            | 段階的開示オーバーロード(引数なし→文字列→オプションオブジェクト)、barrel管理による公開面の明示的制御                        |
| 17 | concurrency-patterns            | concurrency-patterns.md            | WeakMap+オブジェクト参照キーによる自動GCスコーピング、Barrier同期プリミティブ、AsyncResource.bindでの非同期コンテキスト伝播 |
| 18 | dependency-management           | dependency-management.md           | lockstepバージョニング、loadPackageによる統一遅延ロード、peerDependenciesMeta(optional)でのinstall-what-you-use             |

## 特に注目すべき知見

- **メタデータ駆動アーキテクチャ**: デコレータは `Reflect.defineMetadata` によるメタデータ格納のみを行い、実行時のスキャナやルーターがメタデータを読み取って振る舞いを構築する。この「Write/Read 分離」により、デコレータ自体はテスト容易で副作用がなく、フレームワーク内部の実装を利用者コードから完全に隔離している。全メタデータキーを `constants.ts` に集約し、デコレータとスキャナが同一定数を参照する契約管理も優れている。

- **WeakMap + オブジェクト参照キーによるスコープ管理**: リクエストスコープのインスタンスを `WeakMap<ContextId, InstancePerContext>` で保持し、リクエスト終了時に ContextId の参照が消えることで自動的に GC される設計。明示的なクリーンアップコードが不要になり、メモリリークを構造的に排除している。シングルトンは `Object.freeze` した STATIC_CONTEXT を使い、同一の WeakMap で統一管理する。

- **Barrier 同期プリミティブによる並行依存解決**: DI コンテナが `Promise.all` で複数の依存を並行解決する際、Barrier で全パラメータの InstanceWrapper 解決を同期してから後続のインスタンス化に進む。エラーパスでも必ず `signal()` を呼んでデッドロックを防止する設計は、非同期並行処理の汎用的なベストプラクティスとして即座に活用できる。

- **三層抽象化パターン (Interface → Abstract Class → Concrete)**: HTTP アダプター (`HttpServer` → `AbstractHttpAdapter` → `ExpressAdapter`/`FastifyAdapter`) と WebSocket アダプターの両方で一貫して適用されている。インターフェースで契約を安定させ、抽象クラスで共通実装を提供し、具象クラスでプラットフォーム固有の実装を閉じ込める。新しいプラットフォームの追加時にコア層の変更が不要な Open-Closed Principle の実践例。

- **段階的開示 API 設計**: `@Controller()`, `@Body()`, `@Get()` などの全デコレータが「引数なし → 単一文字列 → オプションオブジェクト」の段階的オーバーロードで設計されている。一般的なケースを最小のコードで実現しつつ、高度なユースケースにも対応する。ファクトリ関数 (`createMappingDecorator`) で 16 種の HTTP メソッドデコレータを統一生成する手法も、API の一貫性維持に効果的である。

## クイックリファレンス

- [導出ルール集](rules.md) — CLAUDE.md に貼れる形式の全ルール
