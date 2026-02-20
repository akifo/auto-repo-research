# langchain-ai/langchainjs — 導出ルール集

> 出典: repos/langchain-ai/langchainjs/ | 生成日: 2026-02-20
> 用途: CLAUDE.md にそのまま貼り付けて AI コンテキストとして活用

## 抽象化と拡張ポイント

- `[MUST]` フレームワークの基盤クラスでは abstract メソッドを最小化し（理想は 1-2 個）、他のメソッドにはデフォルト実装を提供する — 実装者の負担を最小化しつつ段階的な最適化を可能にする
  - 根拠: architecture — `Runnable` は `invoke()` のみ abstract にし、`stream()`/`batch()` はデフォルト実装で 34 プロバイダーが最小コードで全機能を提供
- `[MUST]` 拡張ポイントとなるメソッドは公開 API と命名規約で区別する（例: `invoke` が公開、`_generate` が拡張点） — 利用者と拡張者のインターフェースを分離し、横断的関心事の破壊を防ぐ
  - 根拠: abstraction-patterns — `_` 接頭辞 + `protected`/`abstract` でフレームワーク利用者と拡張者を分離
- `[SHOULD]` 横断的関心事（リトライ、フォールバック、設定注入等）は継承ではなくデコレータ的合成（`with*()` メソッドが同じインターフェースを返す）で追加する
  - 根拠: architecture — `withRetry()`, `withFallbacks()`, `withConfig()` が新しい Runnable を返す設計で既存コンポーネントを変更しない
- `[SHOULD]` パイプラインの合成 API では、ユーザーが渡す値を暗黙的に内部型へ変換する coerce 関数を用意し、関数・オブジェクト・型付きインスタンスを統一的に扱えるようにする
  - 根拠: architecture — `_coerceToRunnable()` が関数を `RunnableLambda` に、オブジェクトを `RunnableMap` に自動変換
- `[SHOULD]` 拡張ポイントには「簡易版」と「高度版」の二段階抽象を提供し、最小限の実装で動作するエントリポイントを用意する
  - 根拠: extensibility-mechanisms — `SimpleChatModel._call()` (文字列返却のみ) と `BaseChatModel._generate()` (完全な ChatResult) の二段構成
- `[SHOULD]` クラス階層とは別に interface を定義し、abstract class がそれを `implements` する構造にする — パッケージバージョン間の互換性チェックに利用できる
  - 根拠: abstraction-patterns — `RunnableInterface`, `EmbeddingsInterface` が interface として独立
- `[AVOID]` 継承階層を 4 層以上に深くすること — 各層に明確な単一責務がない場合は合成に切り替える
  - 根拠: abstraction-patterns — langchainjs は 6 層だが各層に明確な責務があるため成立

## 型システム

- `[MUST]` 複数バージョンのライブラリをサポートする場合、Union 型・型ガード関数・条件型の 3 つを同じ分岐構造で定義し、型レベルとランタイムの分岐を 1:1 対応させる
  - 根拠: type-system-patterns — `InteropZodType` / `isZodSchemaV3` / `InferInteropZodOutput` が同じ v3/v4 分岐構造を共有
- `[MUST]` ファクトリ関数が入力の型に応じて異なる型の値を返す場合、実装シグネチャではなくオーバーロードシグネチャで戻り値型を制約する
  - 根拠: type-system-patterns — `tool()` は 12 以上のオーバーロードで入力スキーマの型ごとに正確な戻り値型を返す
- `[SHOULD]` 基底クラスのメソッドシグネチャがサブクラスの型パラメータに依存する場合、`declare` フィールド + `this["T"]` で型のみのプロパティを定義する
  - 根拠: type-system-patterns — `BaseChatModel` の `declare ParsedCallOptions` で全サブクラスに自動的に適切な型が得られる
- `[SHOULD]` パイプライン型の API では、入力側を Union 型（柔軟性）、出力側をジェネリクス（型安全）で設計する
  - 根拠: type-system-patterns — `pipe()` は `RunnableLike` (Union) を受け取り `Runnable<RunInput, Exclude<NewRunOutput, Error>>` を返す
- `[SHOULD]` 文字列リテラル型を保持したい箇所で `T extends string` 制約のパラメータを使い、呼び出し側でリテラル型推論を有効にする
  - 根拠: type-system-patterns — `tool()` の `NameT extends string` により discriminated union パターンが可能
- `[SHOULD]` 型の振る舞いを検証する専用テストファイル (`*.test-d.ts`) を作成し、`expectTypeOf` で型推論の正しさを CI で回帰テストする
  - 根拠: type-system-patterns — langchainjs は 17 個の `.test-d.ts` で型推論の正しさを検証
- `[AVOID]` ジェネリクスの全パラメータを `any` デフォルトにすること — 型パラメータを省略した際に型チェックが無効化される
  - 根拠: type-system-patterns — `Runnable<RunInput = any>` のデフォルト any により 47 箇所の eslint-disable が必要に
- `[AVOID]` 条件型を 4 段以上ネストすること — 型エラーメッセージが難解になる。中間型に名前をつけて分割すべき
  - 根拠: type-system-patterns — `ToolReturnType` (5 段) は正しく動作するが型エラー発生時の理解が困難

## エラーハンドリング

- `[MUST]` npm パッケージとして配布するライブラリでは、`instanceof` の代わりに `Symbol.for()` ベースの branding + 静的 `isInstance` メソッドを使い、パッケージ重複時の型判定を安全にする
  - 根拠: design-philosophy, error-handling-idioms — ESLint `no-instanceof` ルールで全面禁止し、`createNamespace` + `brand()` で代替
- `[MUST]` 制御フロー用のエラー（中断・キャンセル等）は通常エラーのラップ処理から除外する
  - 根拠: error-handling-idioms — `MiddlewareError.wrap()` が `isGraphBubbleUp` で制御フロー信号を透過
- `[SHOULD]` リトライ可否の判定ロジックはエラー型自身に `isRetryable()` メソッドとして内包する
  - 根拠: error-handling-idioms — Google プロバイダの `RequestError.isRetryable()` がステータスコード判定を型に凝集
- `[SHOULD]` 外部 API エラーはプロバイダ境界で正規化し、内部で統一的なエラーコードに変換する
  - 根拠: error-handling-idioms — `wrapOpenAIClientError` / `wrapAnthropicClientError` が HTTP ステータスを統一コードに変換
- `[SHOULD]` リカバリー戦略（throw / メッセージ注入 / カスタム関数）は呼び出し側が選択できるように設計する
  - 根拠: error-handling-idioms — `modelRetryMiddleware` の `onFailure` が `"error"` / `"continue"` / 関数を受け取る
- `[SHOULD]` エラーメッセージにトラブルシューティング URL やエラーコードを付与し、デバッグを支援する
  - 根拠: error-handling-idioms — `addLangChainErrorFields` が全エラーにドキュメント URL を自動付与

## ストリーミング

- `[MUST]` ストリーミングチャンク型には `.concat()` メソッドを実装し、任意の 2 チャンクを合成して最終出力と等価な結果を得られるようにする
  - 根拠: streaming-patterns — `GenerationChunk`, `AIMessageChunk`, `ChatGenerationChunk` がすべて `concat()` を持つ
- `[MUST]` AsyncGenerator ベースのストリーミングループでは、各イテレーションで AbortSignal の状態をチェックし、中断時はリソースを明示的にクリーンアップする
  - 根拠: streaming-patterns — 全プロバイダ実装で `options.signal?.aborted` を毎チャンクチェック
- `[MUST]` AsyncGenerator を ReadableStream に変換する際、falsy な値（空文字列、0、null）でも `enqueue` する — truthy チェックはストリームのハングを引き起こす
  - 根拠: streaming-patterns — `IterableReadableStream.fromAsyncGenerator` のバグ修正で確認済み
- `[SHOULD]` ストリーミング未対応のコンポーネントは `invoke` 結果を単一チャンクとして yield するフォールバックを持たせ、パイプラインを壊さない
  - 根拠: streaming-patterns — `Runnable._streamIterator` のデフォルト実装が `yield this.invoke()` で 1 チャンク yield
- `[SHOULD]` AsyncGenerator パイプラインでは各ステップの `transform(generator)` メソッドでジェネレータをチェーンし、バッファリングは最小限にする
  - 根拠: streaming-patterns — `RunnableSequence._streamIterator` が transform チェーンで pull-based パイプラインを構成
- `[AVOID]` ストリーミングチャンクの yield 後にコールバック通知を忘れること — イベントストリーミングやトレーシングがチャンクを捕捉できなくなる
  - 根拠: streaming-patterns — 全プロバイダで `yield` 直後に `runManager?.handleLLMNewToken()` を呼ぶ規約

## テスト

- `[MUST]` テストファイルの種別（unit / integration / type）をファイル拡張子で区別する（`.test.ts` / `.int.test.ts` / `.test-d.ts`） — 設定ファイルの include/exclude パターンだけで種別ごとの実行制御が完結する
  - 根拠: testing-practices — 全パッケージの `vitest.config.ts` がこの規約に統一
- `[MUST]` 外部サービスに依存するテスト（統合テスト）はビルドツールのキャッシュ対象から除外する
  - 根拠: testing-practices — `turbo.json` で `test:int` に `cache: false` が設定
- `[SHOULD]` 同一インターフェースの複数実装をテストする場合、テストロジックを抽象クラスに集約し、各実装はコンストラクタ引数（対象クラス・capability flag）だけを差し替える
  - 根拠: testing-practices — `@langchain/standard-tests` が 20 以上のプロバイダーに同一テストを提供
- `[SHOULD]` テストダブルは忠実度別に複数バリエーションを用意し、テストの目的に応じて使い分ける
  - 根拠: testing-practices — `FakeChatModel` / `FakeListChatModel` / `FakeStreamingChatModel` の 3 段階
- `[AVOID]` 非対応テストを空メソッドで override して暗黙的に skip する — テストフレームワークの `skip` 機能または理由付きの skip メソッドを使う
  - 根拠: testing-practices — 空 override と `skipTestMessage` が混在しており前者は意図が不明

## 並行制御

- `[MUST]` 外部 API 呼び出しには並行数制限（maxConcurrency）とリトライ（maxRetries + 指数バックオフ）を必ず設定する
  - 根拠: concurrency-patterns — 全プロバイダーが `AsyncCaller` を通じて統一的に設定
- `[MUST]` リトライ判定では 4xx クライアントエラーをリトライ対象から除外し、即座に throw する
  - 根拠: concurrency-patterns — `STATUS_NO_RETRY` リストで 400/401/403/404 等を明示的に除外
- `[SHOULD]` 並行制御・リトライ・キャンセルのロジックはインフラ層のユーティリティに集約し、ビジネスロジック側は薄いラッパーで呼び出す
  - 根拠: concurrency-patterns — `AsyncCaller` が p-queue と p-retry を内部に隠蔽し、30 以上のモジュールから統一利用
- `[SHOULD]` バッチ処理は「チャンク分割 -> 各チャンクの並列実行 -> 並行数制限」の 3 段階で構成する
  - 根拠: concurrency-patterns — Pinecone VectorStore (chunkSize: 100)、OpenAI Embeddings (batchSize: 512) で一貫
- `[SHOULD]` タイムアウトと外部キャンセルは `AbortSignal` に統一し、`Promise.race` で協調的に伝播させる。リスナーは `.finally()` で必ず解除する
  - 根拠: concurrency-patterns — `raceWithSignal` および `ensureConfig` の timeout->signal 変換で統一
- `[AVOID]` デフォルトの maxConcurrency を `Infinity` のまま外部 API に接続しない — API の特性に応じた具体的なデフォルト値を設定する
  - 根拠: concurrency-patterns — 全プロバイダーが基底クラスのデフォルトを上書きしている事実が危険性を示す

## コード組織とモジュール設計

- `[MUST]` パッケージのルート `index.ts` で公開 API を明示的に制御し、内部実装の詳細が外部に漏れないようにする
  - 根拠: code-organization — `runnables/index.ts` は選択的再エクスポート、`messages/index.ts` の `export *` は方針違反
- `[SHOULD]` 大規模パッケージではルートエクスポートを空にし、サブパスエクスポートを強制することでバンドルサイズを制御する
  - 根拠: code-organization — `@langchain/core` の `index.ts` は `export {}` のみで 50+ サブパスに分割
- `[SHOULD]` 型定義を `types.ts` に分離し、実装ファイルから型ファイルへの一方向依存を維持して循環依存を構造的に防ぐ
  - 根拠: code-organization — `tools/types.ts` と `tools/index.ts` の分離パターンが全体で適用
- `[AVOID]` `export *` をバレルファイルで多用し、内部シンボルが公開 API に漏れる状態を作ること
  - 根拠: code-organization — `messages/index.ts` の 14 個の `export *` は API 表面の意図しない拡大リスク
- `[AVOID]` 循環依存チェックを手動レビューのみに頼ること — `dpdm` や `madge` 等のツールを lint ステップに組み込み CI で自動検出する
  - 根拠: code-organization — 全パッケージの lint スクリプトに `dpdm` が統合

## ビルドと品質保証

- `[MUST]` モノレポ内の共有ビルド設定は internal パッケージとして切り出し、ファクトリ関数で提供する — 各パッケージの設定ファイルには差分のみを記述する
  - 根拠: build-and-tooling — 40 以上のパッケージが `getBuildConfig()` を呼ぶだけの 3-10 行の設定ファイルで統一
- `[MUST]` 設計上の制約（禁止事項・必須事項）は ESLint カスタムルールで機械的に強制し、コードレビューやドキュメントのみに頼らない
  - 根拠: design-philosophy — `no-instanceof` プラグインで instanceof 禁止、`no-process-env` で直接参照禁止を CI 自動検出
- `[MUST]` マルチランタイム対応ライブラリでは、ランタイム固有 API へのアクセスをユーティリティ関数に一元化し、プロダクションコードでの直接参照を ESLint ルールで禁止する
  - 根拠: design-philosophy — `getEnvironmentVariable()` に一元化し `no-process-env: error` で強制
- `[SHOULD]` npm 公開前にビルド出力を ATTW と publint で自動検証する（型の整合性と package.json の正当性）
  - 根拠: build-and-tooling — `getBuildConfig()` がデフォルトで `attw: { level: "error" }`, `publint: { level: "error" }` を設定
- `[SHOULD]` マルチランタイム対応ライブラリでは、Docker コンテナで各環境（ESM, CJS, Edge, バンドラー）の実際の import/require を自動テストする
  - 根拠: build-and-tooling — 9 環境で exports の動作を検証
- `[SHOULD]` CI ワークフローに `concurrency` + `cancel-in-progress` を設定し、同一ブランチへの連続 push で古い実行を自動キャンセルする
  - 根拠: dev-conventions — 全 20 以上のワークフローに設定

## 依存管理

- `[MUST]` モノレポでコアパッケージが singleton であることを要求する場合、ルートの package manager overrides でコアを workspace 参照に固定する
  - 根拠: dependency-management — `"@langchain/core": "workspace:^"` を overrides に設定し重複インスタンスを防止
- `[MUST]` 公開パッケージ間の依存には `workspace:^` を、非公開内部ツールには `workspace:*` を使い分ける
  - 根拠: dependency-management — 全 provider は `workspace:^` で semver 互換、`@langchain/tsconfig` 等は `workspace:*` で exact
- `[MUST]` 密結合パッケージ群を独立パッケージとしてリリースする場合、changesets の fixed グループ等で同一バージョンでの同時リリースを保証する
  - 根拠: dependency-management — Google 系 6 パッケージは fixed グループで同一バージョンを維持
- `[SHOULD]` 依存ライブラリのメジャーバージョン移行時は Interop 型を導入し、新旧バージョンの共存期間を設ける
  - 根拠: api-design-practices — `InteropZodType` が Zod v3/v4 両方を受け付け、`"^3.25.76 || ^4"` の OR 範囲で段階的移行
- `[SHOULD]` semver 範囲の上限と下限の両方で自動テストを実施し、依存バージョン範囲の互換性を検証する
  - 根拠: dependency-management — `dependency_range_tests/` で latest と lowest の両パターンを Docker 内でテスト
- `[AVOID]` changesets で `onlyUpdatePeerDependentsWhenOutOfRange` を設定せずにコアパッケージを頻繁にリリースすること — core の patch ごとに全 consumer パッケージの不要なリリースが連鎖する
  - 根拠: dependency-management — このオプションで 30 以上の provider パッケージの不要バンプを防止

## オブザーバビリティとコールバック

- `[MUST]` コールバック/オブザーバビリティ層は本体処理のエラーを黙殺し、本体の例外フローに介入しない — try-catch + warn ログがデフォルト動作
  - 根拠: callback-and-observability — 全ハンドラ呼び出しが try-catch で囲まれ `raiseError` フラグがない限り warn に留める
- `[SHOULD]` イベントハンドラインターフェースは Start/End/Error の三つ組で定義し、すべてのコンポーネントタイプに一貫して適用する
  - 根拠: callback-and-observability — LLM/Chain/Tool/Retriever すべてが同一の三つ組パターンで定義
- `[SHOULD]` オブザーバビリティのコンテキスト（トレース ID、タグ、メタデータ）は「継承可能」と「ローカル」を明確に区別して管理する
  - 根拠: callback-and-observability — `handlers` と `inheritableHandlers` を分離し `addHandler` の `inherit` パラメータでスコープ制御
- `[AVOID]` 同一の設定オブジェクトを複数の呼び出しで使い回す — 内部処理がオブジェクトをミューテートする場合、予期しない状態変化が起きる
  - 根拠: callback-and-observability — `delete config.runId` により同一 config の再利用で不具合

## シリアライゼーション

- `[MUST]` シリアライズ対象クラスでは、シークレットフィールドをシリアライズデータから除外し、復元時に別経路から注入する仕組みを設ける
  - 根拠: serialization-patterns — 全プロバイダーが `lc_secrets` でシークレットをセンチネル値に置換
- `[MUST]` デシリアライズ時にインスタンス化可能なクラスを許可リスト（レジストリ/インポートマップ）で制限する
  - 根拠: serialization-patterns — `importMap` による静的レジストリのみからインスタンス化を許可
- `[SHOULD]` シリアライズの振る舞いは基底クラスの宣言的プロトコル（ゲッターやメタデータ）で定義し、サブクラスでは `toJSON()` を直接オーバーライドしない
  - 根拠: serialization-patterns — 100+ のクラスが 5 つの宣言的ゲッターのみで挙動を制御
- `[SHOULD]` シリアライズ対象フィールドをホワイトリストで明示的に制限し、コンストラクタ引数の全フィールドを暗黙的にシリアライズしない
  - 根拠: serialization-patterns — OpenAI プロバイダーは `lc_serializable_keys` で 25 フィールドを明示

## AI 設定ファイル

- `[MUST]` AI 設定ファイルでルールを禁止する場合、代替手段をコード例付きで必ず併記する
  - 根拠: ai-settings — `instanceof` 禁止に `isInstance` メソッド、`process.env` 禁止に `getEnvironmentVariable` を対で提示
- `[SHOULD]` AI 設定ファイルは人間向けドキュメント（CONTRIBUTING.md 等）とは別ファイルにし、AI エージェントが必要とする情報密度に最適化する
  - 根拠: ai-settings — AGENTS.md（コード例 35%、指示的トーン）と CONTRIBUTING.md を分離
- `[SHOULD]` AI 設定ファイルのコード例は import 文を含め完結させ、省略記号を使わない
  - 根拠: ai-settings — 全コード例が import 文から始まり、ファイルにコピーしてそのまま動作する粒度

## ルール優先度の解釈

- `[MUST]`: 違反するとバグ・セキュリティリスク・重大な設計劣化を招くルール
- `[SHOULD]`: 従うことで品質が向上するが、文脈によっては例外を許容するルール
- `[AVOID]`: 意図的に避けるべきアンチパターン・非推奨プラクティス
