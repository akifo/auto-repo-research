# modelcontextprotocol/typescript-sdk -- 導出ルール集

> 出典: repos/modelcontextprotocol/typescript-sdk/ | 生成日: 2026-02-24
> 用途: CLAUDE.md にそのまま貼り付けて AI コンテキストとして活用

## 型システムとスキーマ設計

- `[MUST]` ワイヤープロトコルのメッセージ型は、ランタイムバリデーションスキーマ（Zod 等）を定義し、TypeScript 型は `z.infer` で導出する。手書き型とスキーマの二重管理は乖離を招く
  - 根拠: type-system-patterns / schema-validation-patterns -- 約120のプロトコル型すべてを `Infer<typeof XxxSchema>` で導出
- `[MUST]` 型ガード関数は手書きの条件分岐ではなく、対応するスキーマの `safeParse` を使って実装する
  - 根拠: type-system-patterns -- `isJSONRPCRequest` 等がすべて `schema.safeParse(value).success` で実装
- `[MUST]` バリデーション結果は discriminated union（`{ success: true; data: T } | { success: false; error: E }`）で返す。例外ベースでは呼び出し側がバリデーション失敗を握りつぶしやすい
  - 根拠: schema-validation-patterns -- `parseSchema` / `JsonSchemaValidatorResult` の両方が discriminated union
- `[SHOULD]` RPC やイベントシステムでは、メソッド名リテラル型をキーとするマップ型を定義し、ハンドラ登録 API でメソッド名からリクエスト/レスポンス型を自動推論させる
  - 根拠: type-system-patterns -- `MethodToTypeMap` 条件型と `setRequestHandler<M>` のジェネリクス
- `[SHOULD]` スキーマライブラリへの直接依存は抽象型（`AnySchema`, `SchemaOutput` 等）とヘルパー関数で遮蔽する。バージョンアップ時の影響範囲を局所化できる
  - 根拠: type-system-patterns / schema-validation-patterns -- `util/schema.ts` が Zod v4 内部型をラップ
- `[SHOULD]` プロトコルメッセージの strictness を層ごとに段階的に設定する。エンベロープは `.strict()`（仕様準拠）、ペイロードは `z.looseObject()`（前方互換性）
  - 根拠: type-system-patterns / schema-validation-patterns -- JSON-RPC エンベロープと Result で使い分け
- `[SHOULD]` コールバックのシグネチャがオプショナルな設定によって変わる場合は、条件型で型推論を提供する
  - 根拠: type-system-patterns -- `BaseToolCallback` 条件型でスキーマ有無に応じた引数型を推論
- `[AVOID]` `z.infer` の出力をそのまま公開 API の型として使う。`Flatten` のような再帰的展開ユーティリティを通して IDE の可読性を確保する
  - 根拠: type-system-patterns -- `Flatten` 型を適用した `Infer` ヘルパーを全公開型で使用

## エラーハンドリング

- `[MUST]` ネットワーク境界を越えるエラーとローカル専用エラーは別のクラス・別のコード体系で定義する
  - 根拠: error-handling-idioms / architecture -- `ProtocolError`（数値コード）と `SdkError`（文字列コード）の分離
- `[MUST]` ハンドラから throw された任意のエラーを安全にワイヤーフォーマットに変換するフォールバック機構を設ける
  - 根拠: error-handling-idioms -- `Number.isSafeInteger(error['code'])` チェックで不正なコードは `InternalError` にフォールバック
- `[MUST]` キャンセル済みリクエストに対するレスポンス（成功・エラー両方）を抑制する
  - 根拠: error-handling-idioms -- `abortController.signal.aborted` チェックでゴーストレスポンスを防止
- `[SHOULD]` エラーコードは準拠する仕様のフォーマットに合わせる（JSON-RPC には数値、OAuth には snake_case 文字列など）
  - 根拠: error-handling-idioms -- 3種のコード体系がそれぞれ異なる仕様に準拠
- `[SHOULD]` シリアライズされたエラーから適切なサブクラスを復元するファクトリメソッドを提供する
  - 根拠: error-handling-idioms -- `ProtocolError.fromError()` でエラーコードに基づくサブクラス復元
- `[SHOULD]` プロトコルエラー（処理の異常）とアプリケーションエラー（処理の結果）は異なる伝達チャネルを使う
  - 根拠: error-handling-idioms -- ツール実行で `ProtocolError` は JSON-RPC エラー、それ以外は `{ isError: true }` の結果値
- `[AVOID]` ローカル専用エラー（SDK エラー）をリモートハンドラ内で throw する。文字列コードはワイヤー上で意味を失い `InternalError` にフォールバックされる
  - 根拠: error-handling-idioms -- `SdkError` の文字列コードは `Number.isSafeInteger()` を通過しない

## API 設計

- `[MUST]` 能力未宣言の機能呼び出しはサイレントに失敗させず、即座に明確なエラーメッセージで拒否する
  - 根拠: architecture / api-design-practices -- `assertCapabilityForMethod` 等で未対応機能の呼び出しを早期検出
- `[SHOULD]` 高レベル API（Facade）は低レベル実装を継承ではなく委譲（composition）で包み、`escape hatch` として低レベルインスタンスを `public readonly` で公開する
  - 根拠: architecture / api-design-practices / abstraction-patterns -- McpServer が `public readonly server: Server` を公開
- `[SHOULD]` ハンドラー登録を契機として能力を自動宣言する（Registration-Driven Capabilities）。能力の宣言と実装の乖離を構造的に防ぐ
  - 根拠: api-design-practices -- `registerTool()` 内で `registerCapabilities()` が自動実行
- `[SHOULD]` 入出力バリデーションをハンドラーの外側（フレームワーク層）で自動実行する。ユーザーコードにバリデーションロジックを書かせない
  - 根拠: api-design-practices -- `Server.setRequestHandler` のオーバーライドで `tools/call` のリクエスト・レスポンスを自動検証
- `[SHOULD]` 実験的 API は `experimental/` ディレクトリとプロパティアクセスで隔離し、安定 API と明確に分離する
  - 根拠: design-philosophy -- `client.experimental.tasks` のパスで実験的機能を構造的に隔離

## インターフェース設計と抽象化

- `[MUST]` Transport やプラグインのインターフェースは、実装が必要とする最小のメソッド/コールバックのみを定義する（3-5メソッドが目安）
  - 根拠: abstraction-patterns -- Transport は `start/send/close` + コールバック3つで4種の実装をカバー
- `[SHOULD]` Capability/Feature のハンドラーは、最初の使用時に遅延登録する（宣言されていない capability を公開しないため）
  - 根拠: abstraction-patterns / api-design-practices -- McpServer の `_toolHandlersInitialized` による遅延初期化
- `[SHOULD]` フェッチ/リクエスト処理パイプラインには `(next) => handler` 型のミドルウェアパターンを使い、関心事を独立モジュールに分離する
  - 根拠: abstraction-patterns / middleware-composition -- `Middleware = (next: FetchLike) => FetchLike` 型
- `[AVOID]` 単一クラスに 10 個以上の Map/Set フィールドを持たせない。責務分離の指標として監視する
  - 根拠: architecture -- Protocol クラスが 13 個の private Map/Set を持ち God Class 化

## ミドルウェアとアダプター

- `[MUST]` ミドルウェアの合成単位はプラットフォーム標準のインターフェースにする（fetch シグネチャ、HTTP Request/Response 等）
  - 根拠: middleware-composition -- `FetchLike` をミドルウェア型に採用し、任意の fetch 実装と互換
- `[MUST]` フレームワークアダプター層にドメインロジックを入れない。アダプターは型変換とデフォルト設定のみを担う
  - 根拠: middleware-composition / adapter-implementation-patterns -- README で「intentionally do not add new MCP features or business logic」と明記
- `[SHOULD]` パイプライン合成関数には空のパイプラインに対するアイデンティティ（恒等射）を保証する
  - 根拠: middleware-composition -- `applyMiddlewares()` に引数がない場合、元のハンドラの参照をそのまま返す
- `[SHOULD]` セキュリティミドルウェアは安全側にデフォルトを倒し、危険な設定には明示的警告を出す
  - 根拠: middleware-composition / adapter-implementation-patterns -- localhost バインド時に DNS リバインディング防御を自動有効化
- `[SHOULD]` 横断的関心事（バリデーション、認証等）のロジックはフレームワーク非依存な純粋関数として実装し、各アダプターではフレームワーク形式にラップするだけにする
  - 根拠: adapter-implementation-patterns -- `validateHostHeader()` をコアに一元化、Express/Hono はラッピングのみ
- `[SHOULD]` フレームワーク依存パッケージは `peerDependencies` で宣言し、利用者がバージョンを制御できるようにする
  - 根拠: adapter-implementation-patterns / project-structure -- middleware パッケージは `dependencies: {}` でフレームワークを peerDependencies に宣言
- `[SHOULD]` 高階関数のネストが深いミドルウェア型には、フラット化ヘルパーを提供する
  - 根拠: middleware-composition -- `createMiddleware()` が二重カリー化をフラットなシグネチャに変換
- `[AVOID]` ミドルウェアの合成順序に暗黙の優先順位や自動ソートを導入する。引数の順序をそのまま合成順序とし、予測可能性を確保する
  - 根拠: middleware-composition -- `applyMiddlewares` は引数順を合成順序とし、暗黙の依存解決を行わない

## マルチランタイム対応

- `[MUST]` マルチランタイム対応のプラットフォーム差異は package.json の条件付きエクスポートで静的に解決し、実行時のランタイム検出分岐を避ける
  - 根拠: platform-abstraction / design-philosophy -- `_shims` サブパスで `workerd`/`node` 条件に応じた実装を切替
- `[MUST]` shim ファイルは re-export またはスタブの提供のみに徹し、ビジネスロジックを含めない
  - 根拠: platform-abstraction -- 4つの shim ファイルはすべて 2-23 行で re-export か最小スタブのみ
- `[SHOULD]` マルチランタイムライブラリのコアは Web Standard API（`Request`/`Response`/`ReadableStream`/`fetch`）で実装し、ランタイム固有 API はアダプター層に隔離する
  - 根拠: design-philosophy / platform-abstraction / adapter-implementation-patterns -- `WebStandardStreamableHTTPServerTransport` が核
- `[SHOULD]` 非サポート機能のスタブには、代替手段を案内する明確なエラーメッセージを含める
  - 根拠: platform-abstraction -- workerd 用 shim が `'Use StreamableHTTPServerTransport instead.'` と案内
- `[SHOULD]` サードパーティの API 変換ライブラリを使用する際は、グローバルオブジェクトの上書きを明示的に無効化する
  - 根拠: adapter-implementation-patterns / middleware-composition -- `overrideGlobalObjects: false` で Next.js との互換性問題を防止
- `[AVOID]` コアパッケージから `node:` プレフィックス付きモジュールを実行時インポートする（`import type` による型のみのインポートは許容）
  - 根拠: platform-abstraction -- Node.js 依存は server パッケージの `stdio.ts` に限定、`node:stream` は `import type` のみ

## ストリーミングと非同期処理

- `[MUST]` ストリーム書き込み時にバックプレッシャーを処理する。`write()` の戻り値が `false` なら `drain` イベントを待つ
  - 根拠: streaming-patterns -- stdio トランスポートの `send` メソッドがこのパターンを一貫して実装
- `[MUST]` 長時間接続のキャンセレーションを `AbortSignal` で伝播する。リクエストハンドラに渡すコンテキストに `signal` を含める
  - 根拠: streaming-patterns -- `Protocol._oncancel` が `notifications/cancelled` を受け取り AbortController を abort
- `[SHOULD]` 高頻度通知をマイクロタスクベースでデバウンスする。`Promise.resolve().then()` で同一ティック内の重複を1回にまとめる
  - 根拠: streaming-patterns / architecture -- `list_changed` 通知の microtask デバウンス実装
- `[SHOULD]` 再接続ロジックにサーバー提供の retry 値と指数バックオフの両方をサポートする
  - 根拠: streaming-patterns -- サーバー側 retry を優先し、なければ指数バックオフにフォールバック
- `[SHOULD]` プロセスの段階的シャットダウンを実装する。stdin 終了 -> 待機 -> SIGTERM -> 待機 -> SIGKILL の順で各段階で終了を確認する
  - 根拠: streaming-patterns -- `StdioClientTransport.close()` の段階的シャットダウン
- `[AVOID]` 認証リトライで再帰呼び出しをサーキットブレーカーなしに行う。成功後に再度 401 が返るケースに対するガードが必要
  - 根拠: streaming-patterns -- `_hasCompletedAuthFlow` フラグによる保護の有無の差

## セキュリティ

- `[MUST]` 外部由来の URL には、スキーマレベルで `javascript:`, `data:`, `vbscript:` スキームを拒否するバリデーションを適用する
  - 根拠: security-practices -- `SafeUrlSchema` が全 URL フィールドに一律適用
- `[MUST]` OAuth 認可コードフローでは PKCE (S256) を無条件に使用し、`plain` メソッドはサポートしない
  - 根拠: security-practices -- `AUTHORIZATION_CODE_CHALLENGE_METHOD` が `'S256'` に固定
- `[SHOULD]` 認証エラーからの自動回復では、エラーコードに応じて無効化スコープを分け、最小限の資格情報のみを無効化して再試行する
  - 根拠: security-practices -- `InvalidClient` で `'all'`、`InvalidGrant` で `'tokens'` のみを無効化
- `[SHOULD]` 外部 API レスポンスは Zod スキーマの `.strip()` で未知フィールドを除去し、信頼境界を超えたデータの伝播を防ぐ
  - 根拠: security-practices -- `OAuthTokensSchema` 等が `.strip()` を使用
- `[AVOID]` URL のパスプレフィックスマッチで末尾スラッシュを正規化せずに比較すること（`/api` が `/api123` にマッチする偽陽性が発生する）
  - 根拠: security-practices -- `checkResourceAllowed()` が末尾スラッシュを付加してから比較

## テスト

- `[MUST]` バグ修正の回帰テストには Issue 番号を含むファイル名を使い、冒頭に Issue URL と問題の説明を記載する
  - 根拠: testing-practices -- `test/integration/test/issues/` 配下の全ファイルが Issue URL 付き JSDoc を持つ
- `[SHOULD]` プロトコルやインターフェースのテストでは、ネットワーク層をバイパスするインメモリトランスポートを用意して高速かつ決定論的なテストを実現する
  - 根拠: testing-practices -- `InMemoryTransport.createLinkedPair()` でインプロセス統合テスト
- `[SHOULD]` 同一ロジックの実装バリアント（バリデーター、ストレージバックエンド等）は `describe.each` / パラメタライズテストで横断的に検証する
  - 根拠: testing-practices -- AJV と CfWorker の2プロバイダーを同一テストスイートで検証
- `[SHOULD]` テスト間で繰り返されるセットアップ手順はファクトリ関数に抽出し、オプション引数でカスタマイズ可能にする
  - 根拠: testing-practices -- `createInMemoryTaskEnvironment()` がセットアップを一括実行

## モノレポとリリース管理

- `[MUST]` モノレポの内部専用パッケージには `private: true` を設定し、npm への意図しない公開を防ぐ
  - 根拠: project-structure -- core パッケージを `private: true` にし、client/server にバンドル
- `[MUST]` モノレポ内の共有依存バージョンは pnpm catalogs や同等機能で1箇所に集約する
  - 根拠: project-structure / dev-conventions -- `pnpm-workspace.yaml` の `catalogs` でカテゴリ別にバージョンを一元管理
- `[MUST]` モノレポの共有設定（lint, tsconfig, test）はワークスペースパッケージとして切り出し、各パッケージは extends/import で利用する
  - 根拠: project-structure / dev-conventions -- `common/` ディレクトリの設定パッケージを全パッケージが1行で継承
- `[MUST]` ドキュメント内のコード例は実際にコンパイル可能なソースファイルから自動同期し、CI で同期状態を検証する
  - 根拠: dev-conventions -- `.examples.ts` ファイルが型チェック対象、`sync:snippets --check` で CI 検証
- `[SHOULD]` ESLint ルールはファイル種別（ソース / テスト / 例示 / 自動生成）ごとに適用範囲を分け、目的に合わせた例外を設計する
  - 根拠: dev-conventions -- `.examples.ts` で `no-unused-vars` OFF、`spec.types.ts` は完全 ignore
- `[SHOULD]` PR ごとにプレビューパッケージを公開し、下流プロジェクトからの早期フィードバックを可能にする
  - 根拠: dev-conventions -- `pkg-pr-new` で全 PR のプレビューパッケージを自動公開
- `[AVOID]` アダプタ層にフレームワーク変換以外のビジネスロジックを実装する
  - 根拠: project-structure -- middleware パッケージの README に責務限定を明記

## ルール優先度の解釈

- `[MUST]`: 違反するとバグ・セキュリティリスク・重大な設計劣化を招くルール
- `[SHOULD]`: 従うことで品質が向上するが、文脈によっては例外を許容するルール
- `[AVOID]`: 意図的に避けるべきアンチパターン・非推奨プラクティス
