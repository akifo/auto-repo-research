# mastra-ai/mastra -- 導出ルール集

> 出典: repos/mastra-ai/mastra/ | 生成日: 2026-02-14
> 用途: CLAUDE.md にそのまま貼り付けて AI コンテキストとして活用

## 型システムとスキーマ設計

- `[MUST]` Zod スキーマを定義したら `z.infer<typeof schema>` で型を導出し、手書きの型定義と二重管理しない
  - 根拠: type-system-patterns -- コードベース全体でスキーマから型を導出し、定義の乖離を防止している
- `[MUST]` 判別共用体（Discriminated Unions）の判別子にはリテラル型を使い、`switch`/`if` による型の絞り込みを可能にする
  - 根拠: type-system-patterns -- `StepResult` 型は `status` リテラルで 6 バリアントを判別し型安全にアクセスできる
- `[MUST]` スキーマライブラリのバージョン検出には `instanceof` ではなく構造的プロパティチェック（duck typing）を使う
  - 根拠: schema-validation-patterns -- `instanceof` は dual-package hazard で失敗する。`_def`/`_zod` の存在と `parse`/`safeParse` の有無で判定
- `[SHOULD]` 外部ライブラリの複数バージョンを扱う場合、nominal 型ではなく構造的部分型（特定メソッドの有無）で互換性レイヤーを作る
  - 根拠: type-system-patterns -- `ZodLikeSchema` は Zod v3/v4 両方を構造的判定で受け入れている
- `[SHOULD]` 設定値が「静的な値」と「実行時に解決する関数」の両方を取りうる場合、`T | ((ctx) => T | Promise<T>)` のユニオン型（DynamicArgument パターン）で表現する
  - 根拠: type-system-patterns, design-philosophy -- Agent の instructions/tools/model 全てでこのパターンを使い、テスト時は静的値、本番では動的解決を同一 API で扱える
- `[SHOULD]` ブランド型（`unique symbol` + intersection）を使って、特定の関数からのみ生成可能な値を型レベルで強制する
  - 根拠: type-system-patterns -- `InnerOutput` 型は `suspend()` の戻り値専用のブランド型で、不正な void 値をコンパイル時に防止
- `[SHOULD]` チェーンメソッド（Builder パターン）では `this` の型を更新して返し、前ステップの出力型を次ステップの入力型に伝播させる
  - 根拠: type-system-patterns, composability-patterns -- `Workflow.then()` が型パラメータを伝播し、ステップ間の型互換性をコンパイル時に検証
- `[SHOULD]` 関数オーバーロードを使う場合、最後にフォールバックオーバーロードを置いてエラーメッセージを改善する
  - 根拠: type-system-patterns -- `createStep` は意図的にフォールバックオーバーロードを配置し、マッチしなかった場合のエラー品質を向上
- `[AVOID]` ジェネリクスを 5 つ以上持つ public API を作る。型エラーが難読化し IDE の補完品質も低下する
  - 根拠: type-system-patterns, abstraction-patterns -- `Workflow` の 8 ジェネリクスは強力だが型エラーが数百行に膨れ、関連する型をインターフェースにグループ化して削減すべき

## エラーハンドリング

- `[MUST]` `catch (e)` で受け取ったエラーを直接操作せず、中央の正規化関数（`getErrorFromUnknown` 相当）を通してから使用する
  - 根拠: error-handling-idioms -- `e` は `unknown` 型であり、全コンポーネント共通の正規化で cause チェーンの深度制限やシリアライズまで一元化
- `[MUST]` エラーの catch-rethrow では、既にドメインエラーでラップ済みかどうかを `instanceof` でチェックしてから再ラップする
  - 根拠: error-handling-idioms -- 23 のストレージアダプター全てで `if (error instanceof MastraError) throw error;` を適用し、二重ラップを防止
- `[SHOULD]` 構造化エラーには、エラーの発生源を示すドメインと責任者を示すカテゴリ（USER / SYSTEM / THIRD_PARTY）を付与する
  - 根拠: error-handling-idioms, design-philosophy -- `MastraError` は `ErrorDomain`(17種) と `ErrorCategory`(4種) の組み合わせでエラーを分類
- `[SHOULD]` リトライロジックを高階関数として切り出し、リトライ対象の判定・バックオフ計算・ロギングを呼び出し元から分離する
  - 根拠: error-handling-idioms -- LibSQL/MongoDB のアダプターが `createExecuteWriteOperationWithRetry` でリトライの詳細を隠蔽
- `[SHOULD]` リトライ対象エラーの判定は、エラーメッセージの文字列検索ではなくエラーコード（`error.code`）やエラー型（`instanceof`）で行う
  - 根拠: error-handling-idioms -- 文字列マッチは誤判定のリスクがある。コードベース判定を主軸とし、メッセージ判定はフォールバック
- `[SHOULD]` ワークフロー等の長時間処理では、ステップ実行結果を例外ではなく判別共用体（`{ ok: true, result } | { ok: false, error }`）で返す
  - 根拠: error-handling-idioms -- リトライ消尽後も例外を投げず Result 型で返すことで、全体の実行フローが予測可能になる
- `[SHOULD]` エラーメッセージに「なぜこのエラーが起きやすいか」と「典型的な解決策」を含める
  - 根拠: api-design-practices -- `createUndefinedPrimitiveError` は `{ ...config }` スプレッドによるゲッター消失という具体的原因を指摘
- `[AVOID]` ライフサイクルコールバック（`onFinish` / `onError`）の例外を本体の制御フローに伝播させない
  - 根拠: error-handling-idioms, concurrency-patterns -- コールバック例外は `try/catch` で吸収しログに記録するだけにとどめる

## テスト戦略

- `[MUST]` 同一インターフェースの複数実装をテストする場合、テストスイートファクトリを作成して共通テストを集約する。各実装の差異は capability フラグで宣言的に表現する
  - 根拠: testing-practices -- 20 超のストレージアダプターに対し 90+ のテストケースを共有し、各テストファイルは 1-5 行のファクトリ呼び出しで済んでいる
- `[MUST]` モノレポの CI ではテスト実行範囲を変更差分に限定する仕組みを導入する（`--changed` フラグ、`paths-filter` 等）
  - 根拠: testing-practices, ci-cd -- `vitest --changed` と `dorny/paths-filter` の組み合わせで PR ごとに変更関連テストのみ実行
- `[SHOULD]` テストユーティリティやテストスイートファクトリはワークスペース内の独立パッケージとして管理する
  - 根拠: testing-practices -- `stores/_test-utils`, `server-adapters/_test-utils` がそれぞれ独自の `package.json` を持ちバージョン管理
- `[SHOULD]` Vitest のプロジェクト名に `unit:` / `e2e:` / `typecheck:` のプレフィックスを付与し、CI で glob フィルタリングできるようにする
  - 根拠: testing-practices, dev-conventions -- `--project 'unit:*'` で単体テストのみ実行し、4 シャード並列化で CI 時間を短縮
- `[SHOULD]` テストデータのクリーンアップメソッドには `dangerously` プレフィックスを付与し、プロダクションコードでの誤用を防止する
  - 根拠: testing-practices -- 全ドメインストレージに `dangerouslyClearAll()` を実装し、テストの afterAll でのみ使用
- `[AVOID]` テストファイル冒頭での `vi.setConfig({ testTimeout: ... })` によるタイムアウト一律延長。遅いテストの根本原因を調査する
  - 根拠: testing-practices -- インフラセットアップのみ `beforeAll` の第 2 引数で長いタイムアウトを指定するのが適切

## 抽象化と拡張性

- `[MUST]` プラグインインターフェースでは、コア機能を abstract メソッドとし、オプショナル機能はデフォルト実装（warn ログ or no-op）を提供する
  - 根拠: abstraction-patterns, extensibility-mechanisms -- 全 abstract class がこのパターンを採用し、50 超のアダプター実装コストを最小化
- `[MUST]` 複数バックエンドを統一する抽象レイヤーでは、バリデーションと共通ロジックを基底クラスの protected メソッドに集約する
  - 根拠: abstraction-patterns -- `MastraVector.validateExistingIndex()` が 18 のベクトル DB アダプター全てで一貫したバリデーションを保証
- `[MUST]` フレームワークのオプショナル機能には NoOp 実装を用意し、未設定時に例外ではなく安全な無動作を提供する
  - 根拠: architecture, design-philosophy -- `NoOpObservability`, `noopLogger` により最小構成でもフレームワーク全体が動作
- `[MUST]` 合成対象のコンポーネントが異なる型を持つ場合、統一インターフェースを定義し、各コンポーネント型からの変換関数を型ガード付きで提供する
  - 根拠: composability-patterns -- `createStep` が Agent/Tool/Processor/StepParams を Step に統一変換
- `[SHOULD]` 異なるバックエンドが同一機能に対して異なる制約を持つ場合、共通 DSL + Translator パターンで抽象化する
  - 根拠: abstraction-patterns -- `BaseFilterTranslator` とその 14 のベンダー実装が MongoDB-like フィルタ文法を統一 API として提供
- `[SHOULD]` 複数プロバイダーの機能を組み合わせる場合、Composite パターンで委譲する（継承ではなく合成）
  - 根拠: abstraction-patterns, composability-patterns -- `CompositeVoice` が入力/出力/リアルタイムを個別プロバイダーに委譲
- `[SHOULD]` インフラ層は機能ドメインごとに独立したインターフェースに分割し、異なるバックエンドの合成を可能にする
  - 根拠: architecture, design-philosophy -- `StorageDomains` が 10 個のドメインを独立定義し、`MastraCompositeStore` で異種バックエンド混合が可能
- `[SHOULD]` 非同期初期化が必要なリソースには Proxy ベースの遅延初期化を適用し、利用側が初期化タイミングを意識しなくてよい API を提供する
  - 根拠: architecture, extensibility-mechanisms -- `augmentWithInit` が Proxy で全メソッドの前に `ensureInit()` を挿入

## API 設計

- `[MUST]` パブリック API のコンストラクタ引数は単一の設定オブジェクトにし、3 個以上の位置引数を避ける
  - 根拠: api-design-practices -- 全主要クラスが設定オブジェクトパターンを一貫して採用し、後方互換を保ちながら段階的にオプションを追加
- `[SHOULD]` クラスコンストラクタの代わりに `createXxx` ファクトリ関数をパブリック API として公開し、型推論をファクトリに任せる
  - 根拠: api-design-practices -- `createTool`/`createStep`/`createWorkflow`/`createScorer` が一貫してジェネリクスの明示的指定なしで正確な型推論を実現
- `[SHOULD]` 破壊的リネーム時は旧名を `@deprecated` エイリアスとして同一ファイルに残し、段階的移行を支援する
  - 根拠: code-organization -- `MastraStorage extends MastraCompositeStore` のように旧クラスを空の派生クラスとして残し即時破壊を防止
- `[SHOULD]` 大規模パッケージのメインエントリポイント（`index.ts`）は最小限に保ち、モジュール別のインポートはサブパスエクスポートで提供する
  - 根拠: code-organization -- `@mastra/core` のメインエントリは 1 行のみで、20 超のサブパスエクスポートで機能を公開
- `[SHOULD]` LLM から受け取ったツール入力は、検証前に正規化パイプラインを通す（null/undefined 正規化、型強制、文字列化 JSON の復元）
  - 根拠: schema-validation-patterns -- LLM プロバイダごとの癖を 5 段階パイプラインで吸収
- `[AVOID]` `index.ts` で `export *` だけを連鎖させて公開 API を暗黙的にする。名前衝突リスクが高まり API 境界が曖昧になる
  - 根拠: code-organization -- 名前付きエクスポートで API を明示する方が境界が明確

## モノレポ管理

- `[MUST]` パッケージ数が 15-20 を超える場合、機能カテゴリ別のトップレベルディレクトリに分割する
  - 根拠: project-structure, code-organization -- `stores/`(23), `voice/`(13), `auth/`(6) 等 11 のトップレベルカテゴリで 90 超のパッケージを管理
- `[MUST]` 公開パッケージと非公開パッケージは npm スコープで明確に分離し、非公開パッケージには `private: true` を設定する
  - 根拠: project-structure -- `@mastra/*`(公開) と `@internal/*`(非公開) で changesets の ignore が 1 パターンで完結
- `[MUST]` モノレポの開発ツール（テストランナー、型チェッカー、リンター）のバージョンは pnpm catalog 等の一元管理機構で統一する
  - 根拠: project-structure, dependency-management -- catalog で vitest/typescript/zod を一元管理し、120 超パッケージ間のバージョン不整合を防止
- `[SHOULD]` アダプターパッケージはコアを `peerDependencies` として宣言し、semver 範囲にプレリリースを含める `>=X.Y.Z-0 <(X+1).0.0-0` 形式を使う
  - 根拠: project-structure, dependency-management -- 全パッケージで統一形式を使用し、prerelease での依存解決エラーを防止
- `[SHOULD]` 非公開パッケージのディレクトリ名にアンダースコアプレフィックス（`_`）を付与し、ファイルシステム上で公開パッケージと視覚的に区別する
  - 根拠: project-structure, code-organization -- `_test-utils/`, `_config/`, `_vendored/` が一貫してアンダースコアプレフィックスを使用
- `[SHOULD]` Changesets の ignore 設定ではホワイトリスト方式（デフォルト全無視 + 公開パッケージのみ有効化）を採用する
  - 根拠: dependency-management -- `"ignore": ["*", "@internal/*", "!mastra", "!@mastra/*"]` で internal パッケージ追加時の設定漏れを構造的に防止
- `[SHOULD]` 密結合パッケージは changeset の `fixed` グループで同一バージョンリリースを保証する
  - 根拠: dev-conventions, dependency-management -- core/server/deployer を固定グループにして常に同一バージョンでリリース

## ビルドと CI/CD

- `[MUST]` monorepo のバンドラーで型生成する場合、バンドラー組み込みの DTS 生成を避け、tsc を別ステップで実行する
  - 根拠: build-and-tooling -- 全 80+ パッケージで `dts: false` + `onSuccess` での tsc 実行を採用し、型パス解決の問題を回避
- `[MUST]` Turborepo のタスク `inputs` にテストファイルやドキュメントの除外パターンを明示し、不要なキャッシュ無効化を防ぐ
  - 根拠: build-and-tooling -- `!**/*.md`, `!**/*.test.ts` を明示的に除外
- `[MUST]` モノレポの CI では変更のないパッケージのテストをスキップし、スキップ時にも明示的に success ステータスを返す
  - 根拠: ci-cd -- `turbo-changed` アクションで推移的依存を含む変更検出を行い、`skip-tests` ジョブで required check をパス
- `[SHOULD]` CI のセットアップ手順は composite action に集約し、全ワークフローで再利用する
  - 根拠: ci-cd -- `setup-pnpm-node` アクションが 20 超のワークフローで使われ、バージョン一元管理を実現
- `[SHOULD]` ワークフローレベルで `permissions: {}` を宣言し、ジョブごとに必要最小限の権限のみを付与する
  - 根拠: ci-cd -- ワークフロー全体の権限を空にし、各ジョブで `contents: read` のみ付与
- `[SHOULD]` ビルドキャッシュの読み書き権限を役割で分離する（ビルド: rw、テスト: r のみ）
  - 根拠: ci-cd -- テスト結果のキャッシュは誤キャッシュを招くため読み取り専用にする
- `[AVOID]` コミットメッセージの文字列マッチでワークフロー間を連携させること。`workflow_call` や `repository_dispatch` を使う
  - 根拠: ci-cd -- コミットメッセージ変更で連携が壊れるリスクがある

## 開発規約

- `[MUST]` モノレポのリンター設定は内部パッケージとして集約し、各パッケージは 1 行のインポートで取り込む
  - 根拠: dev-conventions -- `@internal/lint` で 80 超パッケージの ESLint 設定を一元管理
- `[MUST]` TypeScript プロジェクトでは `no-floating-promises` と `consistent-type-imports` を有効にする
  - 根拠: dev-conventions -- Promise ハンドリング漏れの防止と型インポートの明示的分離をエラーレベルで強制
- `[SHOULD]` 共有リント設定は依存パッケージの存在を動的検出し、フレームワーク固有ルールを条件付きで適用する
  - 根拠: dev-conventions -- `import.meta.resolve` で React/Vitest 等の存在を検出し、1 つの設定で全パッケージに対応
- `[SHOULD]` リンターで無効にしたルールには、無効にした理由をコメントで記録する
  - 根拠: dev-conventions -- 無効にした各 `@typescript-eslint` ルールの理由が詳細にコメントされている
- `[SHOULD]` pre-commit hook では変更ファイルのみ lint + format し、全体チェックは CI に委ねる
  - 根拠: dev-conventions -- `.husky/pre-commit` で `lint-staged` のみ実行し、全体チェックは CI で行う
- `[AVOID]` FIXME コメントをコードベースに残す（TODO は許容するが FIXME はエラーとして扱う）
  - 根拠: dev-conventions -- `no-warning-comments` で FIXME をエラーレベルに設定し、緊急の未解決問題のコミットを防止

## 並行処理

- `[MUST]` 長時間中断が想定される非同期処理では、中断と再開を第一級の概念として設計し、状態をシリアライズ可能にする
  - 根拠: concurrency-patterns -- ワークフローは suspend 時にスナップショットを永続化し、プロセス再起動後も再開できる
- `[MUST]` 並列実行する操作に副作用の競合がある場合、並行度を自動的に 1 に降格させる仕組みを持つ
  - 根拠: concurrency-patterns -- 承認や suspend が必要な tool call では明示的な concurrency 設定よりも安全性制約が優先
- `[SHOULD]` 高頻度の書き込みには debounce + staleness 上限のハイブリッド戦略を適用する
  - 根拠: concurrency-patterns -- `SaveQueueManager` は debounce でバッチ化しつつ MAX_STALENESS_MS を超えたら即座に flush
- `[AVOID]` バッチ並列実行で `Promise.all` を使う場合に、失敗時の他タスクのキャンセル戦略を持たないこと
  - 根拠: concurrency-patterns -- AbortController と組み合わせるか `Promise.allSettled` + abort signal を検討すべき

## ルール優先度の解釈

- `[MUST]`: 違反するとバグ・セキュリティリスク・重大な設計劣化を招くルール
- `[SHOULD]`: 従うことで品質が向上するが、文脈によっては例外を許容するルール
- `[AVOID]`: 意図的に避けるべきアンチパターン・非推奨プラクティス
