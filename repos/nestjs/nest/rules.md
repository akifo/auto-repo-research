# nestjs/nest — 導出ルール集

> 出典: repos/nestjs/nest/ | 生成日: 2026-03-03
> 用途: CLAUDE.md にそのまま貼り付けて AI コンテキストとして活用

## アーキテクチャと依存方向

- `[MUST]` パッケージ/モジュール間の依存方向を一方向に強制する仕組み（TypeScript Project References, eslint-plugin-import 等）を導入する
  - 根拠: project-structure — tsconfig.build.json の references フィールドで DAG を物理的に宣言し、逆方向の import をコンパイルエラーにしている
- `[MUST]` 契約（interface/型定義）と実装を別パッケージに分離する場合、契約パッケージはランタイム依存をゼロに保つ
  - 根拠: project-structure — `@nestjs/common` は reflect-metadata 以外のランタイム依存を持たず、全パッケージの安定した API サーフェスとして機能
- `[MUST]` ライフサイクルフック（初期化・破棄）の実行順序を依存グラフのトポロジカルソートで決定する。初期化は依存先から、破棄は依存元から
  - 根拠: architecture, hook-and-lifecycle-patterns — TopologyTree がモジュール依存グラフを DAG に変換し、distance ベースで初期化順序を自動制御
- `[SHOULD]` モジュール（機能単位）は「何を所有し、何を公開し、何に依存するか」を宣言的に表現する仕組みを設け、暗黙的なグローバル依存を排除する
  - 根拠: design-philosophy — `@Module()` の imports/controllers/providers/exports 4 プロパティ制約と validateModuleKeys による厳密なバリデーション
- `[SHOULD]` モノレポの全パッケージを lockstep versioning で公開し、パッケージ間の互換性マトリクスを排除する
  - 根拠: dependency-management — lerna.json の固定バージョンと `--force-publish --exact` で全パッケージを同一バージョンでリリース
- `[AVOID]` `@Global()` / グローバルスコープのモジュールの多用。依存関係が暗黙化し追跡不能になる
  - 根拠: architecture, extensibility-mechanisms — グローバルモジュールはインフラ層（設定・ロギング・コア機能）に限定すべき
- `[AVOID]` 循環依存を `forwardRef` で解消する設計。依存グラフの DAG 性が崩れ、初期化順序の保証が困難になる
  - 根拠: architecture — SettlementSignal.isCycle() で循環検出して例外を投げる実装があり、循環は設計上の問題として扱われている

## デコレータとメタプログラミング

- `[MUST]` デコレータ駆動アーキテクチャでは、全メタデータキーを単一ファイルに定数として集約し、書き込み側（デコレータ）と読み取り側（スキャナ）の両方がその定数を参照する
  - 根拠: decorator-driven-architecture, metaprogramming-techniques — constants.ts に約 30 のメタデータキーを集約し、パッケージ横断で同じ定数をインポート
- `[MUST]` デコレータはメタデータの格納のみに責務を限定し、副作用（実行時ロジック）を持たせない。実際の振る舞いはランタイムのスキャナやコンテキストビルダーが解釈する
  - 根拠: design-philosophy, metaprogramming-techniques — 全デコレータが Reflect.defineMetadata の呼び出しのみで構成され、宣言とロジックが完全に分離
- `[MUST]` デコレータに渡される引数は適用時にバリデーションする。ランタイムまでエラーの検出を遅延させない
  - 根拠: decorator-driven-architecture — validateEach() が @UseGuards, @UseInterceptors 等で呼ばれ、不正な引数をデコレータ適用時に即座に検出
- `[SHOULD]` 類似デコレータが複数必要な場合は、ファクトリ関数で生成することで実装の重複を排除する
  - 根拠: design-philosophy, api-design-practices — createMappingDecorator で 16 種の HTTP メソッドデコレータを統一的に生成
- `[SHOULD]` デコレータで書き込むメタデータは累積型（配列マージ）にし、階層ごとの宣言が合成されるようにする
  - 根拠: decorator-driven-architecture — extendArrayMetadata() によりグローバル→クラス→メソッドの 3 階層を自然に合成
- `[SHOULD]` 累積型メタデータには read-merge-write ユーティリティを用意し、デコレータから直接 defineMetadata しない
  - 根拠: metaprogramming-techniques — extendArrayMetadata が Guards, Interceptors, Pipes, Headers の 4 箇所で共通利用
- `[SHOULD]` メタデータスキャン結果はキャッシュし、同一プロトタイプの再走査を避ける
  - 根拠: metaprogramming-techniques — MetadataScanner が cachedScannedPrototypes Map でプロトタイプごとの走査結果をキャッシュ
- `[AVOID]` デコレータ内で descriptor.value を別の関数に差し替えること。メタデータの手動コピーが必要になり、コピー漏れによるバグが発生する
  - 根拠: decorator-driven-architecture — GrpcStreamMethod が全メタデータを手動コピーしており、このパターンは脆弱
- `[AVOID]` メタデータキーに生の文字列リテラルを使う（定数化せずにハードコードする）
  - 根拠: metaprogramming-techniques — NestJS はすべてのメタデータキーを constants.ts の名前付き定数として管理

## 型システム

- `[MUST]` 複数バリアントのユニオン型で特定バリアントにのみ許可されるプロパティがある場合、他のバリアントでは `prop?: never` を指定して型レベルで排他性を保証する
  - 根拠: type-system-patterns — Provider 型で inject?: never により ClassProvider/ValueProvider への inject 誤用をコンパイル時に検出
- `[MUST]` ランタイム定数とその型を同時に管理する場合、`as const` で定数を定義し indexed access type で型を導出する（enum ではなく）
  - 根拠: type-system-patterns — ENHANCER_KEY_TO_SUBTYPE_MAP + EnhancerSubtype の設計で Single Source of Truth を維持
- `[SHOULD]` ジェネリック Builder Pattern では各メソッドが更新された型パラメータを持つ新しいインスタンスを返し、中間状態でも正確な型補完を提供する
  - 根拠: type-system-patterns, extensibility-mechanisms — ConfigurableModuleBuilder の setClassMethodName, setExtras が型パラメータを段階的に確定
- `[SHOULD]` メタデータのセットと取得が対になる API では、条件型の `infer` を使って戻り値型をデコレータの型パラメータから自動導出し、型の一貫性を保証する
  - 根拠: type-system-patterns — Reflector.get() が ReflectableDecorator<any, infer R> で R を推論
- `[AVOID]` ジェネリック型パラメータのデフォルトを `any` にすることで型安全性を暗黙に放棄させる設計。可能な場合は `unknown` をデフォルトにする
  - 根拠: type-system-patterns — Type<T = any>, InjectionToken<T = any> は後方互換性のためだが、新規設計では unknown が安全

## プラットフォーム抽象化

- `[MUST]` プラットフォームアダプターの契約はインターフェースで定義し、共通実装は抽象クラスで提供する（三層構造: Interface → Abstract Class → Concrete）
  - 根拠: adapter-implementation-patterns — HttpServer インターフェース + AbstractHttpAdapter + ExpressAdapter/FastifyAdapter
- `[MUST]` アダプター間の差異はアダプター内部で吸収し、コア層にプラットフォーム条件分岐を持ち込まない
  - 根拠: adapter-implementation-patterns — NestApplication, BaseExceptionFilter 等のコア層は HttpServer インターフェースのみを参照
- `[SHOULD]` プラットフォーム固有 API へのアクセスは型付きの脱出口（platform-specific interface）で提供する
  - 根拠: adapter-implementation-patterns — NestExpressApplication / NestFastifyApplication がプラットフォーム固有メソッドを型安全に公開
- `[SHOULD]` 横断的関心事（認証・ログ・変換等）は単一のコンテキストインターフェースに対して実装し、プロトコル切り替えはコンテキスト側で吸収する
  - 根拠: architecture, request-pipeline-orchestration — ExecutionContext の switchToHttp() / switchToWs() / switchToRpc() により Guard/Interceptor が全プロトコルで共通実装
- `[AVOID]` 抽象クラスのデフォルト実装を特定プラットフォームの API に偏らせること
  - 根拠: adapter-implementation-patterns — AbstractHttpAdapter のデフォルト実装が Express 寄りで、Fastify では大半のメソッドをオーバーライドする必要がある

## リクエストパイプラインと実行順序

- `[MUST]` リクエストパイプラインの実行順序はフレームワーク側で固定し、利用者が順序を変更できないようにする
  - 根拠: request-pipeline-orchestration — Guards → Interceptors → Pipes → Handler → Exception Filters の順序を構造的に強制
- `[MUST]` パイプラインコンポーネントが空の場合、呼び出し自体をスキップする短絡パスを設ける
  - 根拠: request-pipeline-orchestration — createGuardsFn が空配列に対して null を返し、呼び出し側で fn && (await fn(...)) と短絡評価
- `[SHOULD]` パイプラインの各ステージに共通するメタデータ収集・合成ロジックは Template Method で基底クラスに一元化する
  - 根拠: request-pipeline-orchestration — ContextCreator 基底クラスが 3 層メタデータ合成を定義し、4 つのサブクラスは createConcreteContext のみを差し替え
- `[SHOULD]` Interceptor チェーンは遅延評価（defer/lazy）で構築し、チェーン内の各 Interceptor が実行タイミングを制御できるようにする
  - 根拠: request-pipeline-orchestration — rxjs の defer() で各ステップを遅延評価し、CallHandler.handle() が呼ばれるまで後続は実行されない

## エラーハンドリング

- `[MUST]` 例外クラス階層はトランスポートごとに独立した基底を持たせ、異なるプロトコル間での instanceof 誤マッチを防止する
  - 根拠: error-handling-idioms — HttpException, RpcException, WsException を互いに独立した継承ツリーにし、トランスポートをまたいだ誤用を型レベルで排除
- `[MUST]` 例外処理チェーンの終端に「全例外キャッチ」のフォールバックハンドラを設け、未処理例外によるプロセスクラッシュを構造的に防止する
  - 根拠: error-handling-idioms — BaseExceptionFilter.handleUnknownError() が HttpException 以外のあらゆる例外を 500 レスポンスに変換
- `[SHOULD]` HTTP ステータスコードごとの具象例外クラスを用意し、生のステータスコード数値をビジネスロジック内で扱わせない
  - 根拠: error-handling-idioms — 22 個の具象例外クラスが同一パターンのコンストラクタでステータスコードを束縛
- `[SHOULD]` 例外の再ラップ時に `cause` プロパティで元のエラーを保持し、エラーチェーンを追跡可能にする
  - 根拠: error-handling-idioms — HttpException が options.cause を受け取り、Node.js Error Cause 仕様に準拠
- `[SHOULD]` フレームワーク内部で意図的に投げる例外にはマーカー基底クラスを設け、ログ出力対象から除外する
  - 根拠: error-handling-idioms — IntrinsicException がマーカーとして機能し、想定外のエラーのみログに記録

## DI コンテナとスコープ管理

- `[MUST]` DI コンテナでスコープ付きインスタンスを管理する場合、コンテキストキーを WeakMap のキーに使い、コンテキスト終了時の GC に任せる設計にする
  - 根拠: dependency-injection-container, concurrency-patterns — WeakMap<ContextId, InstancePerContext> で明示的 cleanup なしでメモリリークを防止
- `[MUST]` 依存ツリーの再帰的検査（スコープ伝播・循環検出等）では、訪問済みノードのレジストリを引き回して無限ループを防止する
  - 根拠: dependency-injection-container — isDependencyTreeStatic が lookupRegistry: string[] で訪問済みノードを追跡
- `[MUST]` Barrier やカウントダウンラッチのエラーパスでも必ず signal/countDown を呼び、他の参加者をデッドロックさせない
  - 根拠: concurrency-patterns — Injector は try/catch の両方で paramBarrier.signal() を呼ぶ
- `[SHOULD]` 複数の非同期依存を並行解決する場合、Barrier パターンで全依存の wrapper 解決を同期してから後続のインスタンス化に進む
  - 根拠: dependency-injection-container, concurrency-patterns — Promise.all で並行にパラメータを解決しつつ Barrier.signalAndWait() で全解決を待つ
- `[SHOULD]` rxjs の Observable チェーンや非同期コールバックを跨ぐ処理では AsyncResource.bind で非同期コンテキストを明示的に伝播する
  - 根拠: concurrency-patterns — インターセプタチェーンが AsyncResource.bind で AsyncLocalStorage コンテキストを維持
- `[AVOID]` コンテキスト ID にプリミティブ値（数値・文字列）を使う。WeakMap のキーにできず、手動クリーンアップが必要になる
  - 根拠: concurrency-patterns — NestJS は `{ id: Math.random() }` というオブジェクトを ContextId として使用

## ライフサイクルとシャットダウン

- `[MUST]` シャットダウンシグナルハンドラには再入防止ガードを設ける。最初のシグナルでフラグを立て、後続のシグナルを無視する
  - 根拠: hook-and-lifecycle-patterns — receivedSignal フラグで二重シャットダウンを防止
- `[SHOULD]` フック検出には duck typing（メソッド存在チェック）を使い、ランタイムに消える型情報に依存しない
  - 根拠: hook-and-lifecycle-patterns — isFunction(instance.hookMethod) による duck typing が全 5 フックで統一パターン
- `[SHOULD]` グレースフルシャットダウン時は「初期化完了の待機 → 依存元からの破棄 → リソース解放 → 最終通知」の段階を順序保証付きで逐次実行する
  - 根拠: hook-and-lifecycle-patterns — close() が initializationPromise を await してから destroy → beforeShutdown → dispose → shutdown の順で逐次実行
- `[SHOULD]` プロセスシグナルリスナーの登録はデフォルト無効の opt-in にする
  - 根拠: hook-and-lifecycle-patterns — enableShutdownHooks() が明示的に呼ばれない限りシグナルリスナーは登録されない
- `[AVOID]` リクエストスコープ（非静的ライフサイクル）のコンポーネントにモジュールレベルのライフサイクルフックを実装すること
  - 根拠: hook-and-lifecycle-patterns — isDependencyTreeStatic() が false のインスタンスはフック実行対象から除外される

## API 設計

- `[MUST]` デコレータ API は「引数なし / 単一プリミティブ / オプションオブジェクト」の段階的オーバーロードで設計する
  - 根拠: api-design-practices — 全デコレータがこのパターンに統一され、一般的ケースの簡潔さと上級ケースの柔軟性を両立
- `[MUST]` パッケージの公開 API 面は barrel ファイルで明示管理し、内部型が漏洩しないよう名前付きエクスポートでフィルタする
  - 根拠: api-design-practices — packages/common/index.ts で interfaces を個別にピックし、export * による内部型漏洩を防止
- `[SHOULD]` ユーザー拡張ポイントのインターフェースは単一メソッドを優先する（実装コストの最小化）
  - 根拠: api-design-practices — PipeTransform(transform), CanActivate(canActivate), NestInterceptor(intercept) は全て単一メソッド
- `[SHOULD]` 複数の戦略を受け入れる設定型は判別共用体（discriminated union）で定義し、`type` フィールドで分岐させる
  - 根拠: api-design-practices — VersioningOptions が type フィールドで URI/Header/MediaType/Custom を判別

## テスト

- `[MUST]` 統合テストでアプリケーションを起動した場合、afterEach/afterAll で必ず close() を呼びリソースを解放する
  - 根拠: testing-practices — 全統合テストで afterEach(() => app.close()) が一貫して実装
- `[MUST]` テストで使用したスタブ・スパイ・モックは afterEach で必ずリストアし、テスト間の副作用を防ぐ
  - 根拠: testing-practices — sinon.restore() または sandbox.restore() がリストア漏れなく呼ばれている
- `[SHOULD]` 単体テストでは DI コンテナを使わず対象クラスを直接インスタンス化し、統合テストでは DI コンテナ経由でモジュールグラフを組み立てる二層構造を採用する
  - 根拠: testing-practices — packages/**/test/ で DI なしの直接テスト、integration/**/e2e/ で TestingModule 経由のテストに分離
- `[SHOULD]` テスト用ロガーはデフォルトでログ出力を抑制し、エラーのみ出力する設計にする
  - 根拠: testing-practices — TestingLogger は log/warn/debug/verbose を no-op にし error だけ通す

## 依存管理とオプショナル依存

- `[MUST]` オプショナル依存を遅延ロードする場合、ロード関数を 1 箇所に集約し、エラーメッセージに「どのパッケージを」「なぜインストールすべきか」を含める
  - 根拠: dependency-management — loadPackage が 30 箇所以上で一貫したエラー形式を提供
- `[SHOULD]` peerDependencies + peerDependenciesMeta(optional: true) の組み合わせで「使わないならインストール不要」を npm の仕組みで表現する
  - 根拠: dependency-management — @nestjs/microservices は 7 種のトランスポートライブラリを全て optional peer で宣言
- `[SHOULD]` オプショナル依存の型を any にフォールバックさせる際、コメントで正しい型定義を残し「なぜ any か」の理由を明記する
  - 根拠: dependency-management — 全トランスポート実装で `// type Redis = import('ioredis').Redis` の形式が統一使用
- `[SHOULD]` 外部パッケージに依存する機能には自前のインターフェースを定義し、代替実装の注入を可能にする
  - 根拠: dependency-management — ValidatorPackage / TransformerPackage インターフェースにより class-validator 以外への差し替えが可能
- `[AVOID]` `require(dynamicString)` を直接使わず、`() => require('package-name')` のクロージャ形式で渡してバンドラーの静的解析による誤検出を防ぐ
  - 根拠: dependency-management — 全ての loadPackage 呼び出しが第 3 引数に loaderFn を渡す形式を採用

## ルール優先度の解釈

- `[MUST]`: 違反するとバグ・セキュリティリスク・重大な設計劣化を招くルール
- `[SHOULD]`: 従うことで品質が向上するが、文脈によっては例外を許容するルール
- `[AVOID]`: 意図的に避けるべきアンチパターン・非推奨プラクティス
