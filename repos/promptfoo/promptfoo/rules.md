# promptfoo/promptfoo — 導出ルール集

> 出典: repos/promptfoo/promptfoo/ | 生成日: 2026-02-21
> 用途: CLAUDE.md にそのまま貼り付けて AI コンテキストとして活用

## プラグイン・抽象化設計

- `[MUST]` プラグインインターフェースの必須メソッドは 1-2 個に抑え、追加機能はオプショナルメソッドで拡張する。新規実装の最小コストを下げることでエコシステムを拡大できる
  - 根拠: architecture / provider-abstraction — `ApiProvider` は `id()` + `callApi()` のみ必須で、100 以上のプロバイダが 20 行の最小実装で統合されている
- `[MUST]` 多数のバックエンド実装を統一的に扱う場合、Factory パターン（`test()` + `create()` の 2 フェーズ）で文字列識別子から実装を解決し、新規追加時に既存コードの変更を不要にする
  - 根拠: design-philosophy / plugin-composition — `ProviderFactory` 配列で 100+ プロバイダを Open-Closed 原則に従い管理
- `[MUST]` 複数の消費面（CLI / ライブラリ / サーバー）を持つツールでは、ビジネスロジックを共有コアに集約し、各面はインターフェース変換のみを担当させる
  - 根拠: architecture — `evaluator.ts` を 3 つのエントリポイントが共有し、ロジック重複ゼロで CLI/Server/Library を提供
- `[SHOULD]` インフラ関心事（レート制限・リトライ・キャッシュ）はプラグイン実装の外側で Decorator パターンにより透過的に注入する。二重ラップ防止には Symbol を使う
  - 根拠: architecture / concurrency-patterns — `providerWrapper.ts` が `Symbol.for` で冪等なラッピングを実現
- `[SHOULD]` プラグインの「生成」と「評価」を独立したコンポーネントとして設計し、同一 ID で疎結合にする。同一ファイルに配置すれば変更の局所性が高まる
  - 根拠: plugin-composition — Plugin + Grader ペアが同一ファイルに共存しつつプラグイン ID で結合
- `[SHOULD]` カテゴリ別プラグインコレクションを `as const` 付き配列で定義し、ユーザーがコレクション名で一括選択できるようにする
  - 根拠: plugin-composition — `FINANCIAL_PLUGINS`, `MEDICAL_PLUGINS` 等で 10+ プラグインを一語で有効化
- `[AVOID]` 100 以上のファクトリやハンドラを単一ファイルの配列リテラルに格納する。ファイルが肥大化し、変更コンフリクトが頻発する
  - 根拠: architecture / project-structure — `registry.ts` が 1,700 行に達しておりアンチパターンとして認識されている

## 設定駆動・バリデーション

- `[MUST]` 設定スキーマを Zod で定義し、TypeScript 型（`z.infer<>`）とランタイムバリデーション（`safeParse`）を同一ソースから導出する
  - 根拠: config-driven-architecture / type-system-patterns — `UnifiedConfigSchema` が型・バリデーション・JSON Schema の Single Source of Truth
- `[MUST]` 宣言的設定層（ユーザ向け）と内部表現層（ランタイム向け）を明確に分離し、変換ロジックを一箇所に集約する
  - 根拠: design-philosophy — `TestSuiteConfig` と `TestSuite` を分離し `evaluate()` で一括変換
- `[MUST]` バリデーションエラーには「何が間違っているか」だけでなく「どう直すか」のヒント（YAML の正しい書き方等）を含める
  - 根拠: config-driven-architecture / assertion-patterns — YAML インデントの例示をエラーメッセージに含め、ユーザーのデバッグ時間を削減
- `[SHOULD]` 設定の読み込みパイプラインを「パース -> 参照解決 -> テンプレート展開 -> バリデーション -> 正規化」のように明確なステップに分割する
  - 根拠: config-driven-architecture — `readConfig` が JSON $ref 解決・環境変数展開・Zod バリデーション・エイリアス正規化を分離
- `[SHOULD]` エイリアス（同義フィールド名）を許容する場合、Zod の `.transform()` で内部表現に正規化し、以降のコードでは正規化後の形式のみを扱う
  - 根拠: config-driven-architecture — `targets` -> `providers` の正規化を `UnifiedConfigSchema.transform()` 内で実施
- `[SHOULD]` Zod スキーマから JSON Schema を自動生成し、YAML 設定ファイルにスキーマ参照コメントを付与してエディタ補完を有効にする
  - 根拠: config-driven-architecture — `z.toJSONSchema()` で生成した JSON Schema を `# yaml-language-server: $schema=...` で利用
- `[SHOULD]` 宣言的 DSL では表現しきれないロジックのために、`file://` 等の統一的なエスケープハッチ機構を全構成要素に提供する
  - 根拠: design-philosophy / extensibility-mechanisms — プロンプト・プロバイダ・アサーション・トランスフォーム全てで `file://` が使える
- `[AVOID]` Zod スキーマ内で `z.any()` を使う。`z.unknown()` + `z.custom<T>()` で型情報を保持し、JSON Schema 生成時の補完を有効にする
  - 根拠: type-system-patterns / config-driven-architecture — `z.any()` はバリデーションをバイパスし `noExplicitAny` lint ルールでも検出されない

## エラーハンドリング・リトライ

- `[MUST]` プロバイダ境界（外部 API 呼び出し）では例外を throw せず、エラー情報を戻り値の `error` フィールドで返す。1 つの失敗が他の並行処理を巻き込まない
  - 根拠: error-handling-idioms — 全 50+ プロバイダが `{ error: string }` パターンで統一
- `[MUST]` リトライ対象を一時的エラー（ECONNRESET, 502 Bad Gateway 等）に厳密に限定し、認証エラー・TLS 設定ミス等の永続的エラーはリトライしない
  - 根拠: error-handling-idioms — `isTransientConnectionError()` が自己署名証明書エラー等を明示的に除外
- `[MUST]` 複数のリトライ層が存在する場合、内側の層でリトライを無効化して二重リトライ（3x3=9 回等）を防止する
  - 根拠: error-handling-idioms — `fetchWithRetries` が `disableTransientRetries: true` で内側のリトライを抑制
- `[SHOULD]` 評価ハンドラの戻り値型は `{pass: boolean, score: number, reason: string}` の統一型にし、重み付き集約やデバッグを汎用ロジックで処理できるようにする
  - 根拠: assertion-patterns — `GradingResult` の 3 フィールド必須設計で 50 種以上のアサーションを統一処理
- `[SHOULD]` リトライ遅延には exponential backoff + ランダムジッタを組み合わせ、サーバ指定の Retry-After を優先する
  - 根拠: error-handling-idioms / concurrency-patterns — `getRetryDelay()` がサーバ指定値を優先しつつジッタで Thundering Herd を防止
- `[AVOID]` HTTP ステータスコードだけでリトライ判定する。statusText やエラーメッセージの内容も検査し、永続的エラーの誤リトライを防ぐ
  - 根拠: error-handling-idioms — `isTransientError()` が status と statusText の両方を検証

## 型システム

- `[MUST]` TypeScript の `enum` を使わず、`as const` オブジェクト + indexed access type で union 型を定義する
  - 根拠: type-system-patterns / build-and-tooling — Biome `noEnum: "error"` で全体に適用し、tree-shaking 阻害を排除
- `[MUST]` Zod スキーマから型を導出する場合は `z.infer<typeof Schema>` を使い、手動で同じ型を二重定義しない。手書き interface と並存する場合は `AssertEqual` 型で静的検証する
  - 根拠: type-system-patterns — `src/validators/prompts.ts` で `AssertEqual` によりスキーマと型の一致をコンパイル時に検証
- `[MUST]` 評価種別の列挙型とハンドラマップを `Record<EnumType, Handler>` で定義し、型の追加時にハンドラ未実装をコンパイルエラーにする
  - 根拠: assertion-patterns — `ASSERTION_HANDLERS` が `Record<BaseAssertionTypes, Handler>` で網羅性を保証
- `[SHOULD]` 文字列リテラルの有限集合は `as const` 配列で定義し、ランタイムルックアップ用に `ReadonlySet` をセットで提供する
  - 根拠: type-system-patterns — 全ストラテジー定義が配列 + Set のペアで型推論と O(1) ルックアップを両立
- `[SHOULD]` 否定・反転は専用ハンドラを作らず、元のハンドラに `inverse` パラメータを渡して結果を反転する。型レベルでは `not-${BaseType}` のテンプレートリテラル型で表現する
  - 根拠: assertion-patterns — `not-` プレフィックスにより 50 種の否定版をゼロ行のコードで提供

## テスト戦略

- `[MUST]` テストスイートで `pool: 'forks'` を使い、各テストファイルにプロセスレベルの分離を提供する。worker threads のメモリリーク蓄積を OS レベルで防止する
  - 根拠: testing-practices — 3 つの Vitest 設定すべてで forks を採用
- `[MUST]` `vi.hoisted()` で作成したモックや `mockReturnValue()` を持つモックには `beforeEach` で `mockReset()` を呼んでから再設定する。`clearAllMocks` だけでは実装がリセットされない
  - 根拠: testing-practices — ランダム順序実行でテスト間の状態漏洩を防止
- `[SHOULD]` unit テストはランダム順序実行をデフォルトにし、テスト間の暗黙の依存を早期検出する
  - 根拠: testing-practices — `sequence.shuffle: true` を unit/integration で適用
- `[SHOULD]` 外部 API に依存するテストでは、入力をそのまま返す Echo プロバイダ相当のスタブを用意し、ゼロコストで決定的にパイプラインを検証する
  - 根拠: testing-practices / design-philosophy — smoke テストの fixture 群がほぼ全て `providers: [echo]` で動作
- `[SHOULD]` テスト層（unit / integration / smoke）ごとに専用の設定ファイルを用意し、タイムアウト・並列度・シャッフル設定を層の特性に合わせて最適化する
  - 根拠: project-structure / testing-practices — 3 つの Vitest 設定で層別にリソース制約を分離
- `[AVOID]` テストの遅延に対してタイムアウト値を延長して対処する。根本原因（不要な待機、非効率なセットアップ、外部依存）を修正する
  - 根拠: testing-practices — `test/AGENTS.md` で "NEVER increase test timeouts" と明記
- `[AVOID]` 状態管理ストアをモックして呼び出し確認のみ行う。実ストアを使い `getState()` で実際の状態変更を検証する
  - 根拠: testing-practices — ストアモックを明示的に Anti-Pattern とし統合テストでの実ストア使用を推奨

## セキュリティ・品質ゲート

- `[MUST]` 外部 HTTP 通信は単一のラッパー関数に集約し、Lint ルール（`noRestrictedGlobals` / `noRestrictedImports`）で直接使用を禁止する
  - 根拠: security-practices / dev-conventions — `fetchWithProxy` に一元化し、プロキシ・TLS・リトライの適用漏れを構造的に防止
- `[MUST]` ログ出力にはフィールド名（76 種）と値パターン（API キー形式等）の両方で秘匿情報を自動サニタイズする仕組みを組み込む
  - 根拠: security-practices — 3 層サニタイズ（フィールド名・値パターン・URL パラメータ）でロガーに内蔵
- `[SHOULD]` 依存関係の自動更新にはリスクレベルに応じた時間遅延（`minimumReleaseAge`）を設定する。ランタイム依存はより長い遅延、LLM SDK は即時更新
  - 根拠: security-practices / ci-cd — ランタイム 5 日、開発 2 日、LLM SDK 0 日の段階的遅延
- `[SHOULD]` 正規表現を使う箇所では ReDoS 耐性を意識し、長い文字列にはスキップ/切り詰め処理を入れる
  - 根拠: security-practices — URL テンプレート検出に文字列検索、テンプレート展開に 50,000 文字制限を適用

## ビルド・CI/CD

- `[MUST]` 複数のビルドターゲットが同一出力ディレクトリを共有する場合、全ターゲットで `clean: false` を設定し、クリーンは専用コマンドで明示的に行う
  - 根拠: build-and-tooling / project-structure — 4 構成が `dist/src` を共有し並列ビルドのレースコンディションを防止
- `[MUST]` ESM/CJS デュアルビルドでモジュール形式に依存するコードパスがある場合、ビルドツールの `define` でコンパイル時定数を注入し、ランタイム検出ではなくコンパイル時分岐で切り替える
  - 根拠: build-and-tooling — CJS 環境では `import.meta` 構文が SyntaxError になるためランタイム分岐は不可能
- `[SHOULD]` ポストビルドスクリプトでビルド成果物の完全性を検証する。必須出力ファイルの欠落をデプロイ前に検出できる
  - 根拠: project-structure / build-and-tooling — `REQUIRED_BUILD_OUTPUTS` で 5 つの必須ファイルを検証
- `[SHOULD]` CI のテストマトリクスは PR 時とメインブランチ push 時で範囲を変える（PR は高速フィードバック優先、main は網羅性優先）
  - 根拠: ci-cd — `ci-config` ジョブがイベント種別に応じてマトリクスを動的に切り替え
- `[SHOULD]` `concurrency` グループの `cancel-in-progress` は PR 実行のみに適用し、メインブランチの push は常に完走させる
  - 根拠: ci-cd — リリース判定に使う CI が中断されるとリリースフローが壊れるため

## 並行制御

- `[MUST]` 並列度制御のスロット割当（容量チェック -> カウンタ更新）は同期的に行い、間に await を挟まない。非同期処理を含むとオーバーコミットが発生する
  - 根拠: concurrency-patterns — `SlotQueue.processQueue()` が「SYNCHRONOUS - no awaits」で競合状態を構造的に排除
- `[SHOULD]` レートリミット対策は「プロアクティブ削減（残量 10% 以下で発動）-> リアクティブバックオフ（429 で半減）-> 段階的回復（5 連続成功で 1.5 倍）」の多層構造にする
  - 根拠: concurrency-patterns — AIMD 風の 3 層制御で単一戦略より安定したスループットを実現
- `[SHOULD]` eval 単位・リクエスト単位のインフラ状態はシングルトンではなくスコープ付きインスタンスで管理し、実行コンテキスト間の状態汚染を防ぐ
  - 根拠: architecture / concurrency-patterns — `RateLimitRegistry` は「NOT a singleton」と明記
- `[SHOULD]` EventEmitter ベースの並列制御コンポーネントは dispose メソッドで全リスナーを解除しタイマーをクリアする
  - 根拠: concurrency-patterns — `RateLimitRegistry.dispose()` と `SlotQueue.dispose()` で確実にクリーンアップ

## データベース・永続化

- `[MUST]` 複数テーブルへの INSERT/DELETE をアトミックに行う場合はトランザクションで囲む。削除時は外部キー制約を持つ子テーブルから先に削除する
  - 根拠: database-patterns — Eval の create/delete/copy 全てでトランザクションを使用
- `[MUST]` ファイルシステムベースのストレージでユーザー入力をパスに含める場合、`path.resolve` 後に `basePath + path.sep` のプレフィクスチェックでディレクトリトラバーサルを防止する
  - 根拠: database-patterns — Blob ストレージとメディアストレージの両方で同一パターンを適用
- `[SHOULD]` バイナリデータは DB に直接格納せず、コンテンツハッシュをキーにファイルシステムに外部化し、DB には参照メタデータのみ保持する
  - 根拠: database-patterns — SHA-256 ハッシュで deduplication しつつ DB にはハッシュ・サイズ・MIME タイプのみ記録
- `[SHOULD]` ファイル書き込みでデータ破損を防ぐには、一時ファイルに書き込んでから `rename` でアトミックに置換し、書き込み後に内容を検証する
  - 根拠: database-patterns — キャッシュマイグレーションで temp ファイル -> rename -> validate の 3 ステップを実装
- `[SHOULD]` データフォーマットのマイグレーションにはサンセット日付を設定し、期限後は新規データで開始する設計にする。マイグレーションコードの長期蓄積を防ぐ
  - 根拠: database-patterns — `MIGRATION_SUNSET_DATE` で削除時期を明示

## AI エージェント設定

- `[MUST]` ルート AI 設定ファイルにプロジェクト構造テーブルを設置し、各ディレクトリと対応するローカルドキュメントのリンクを明示する
  - 根拠: ai-settings — ルート AGENTS.md がディレクトリ -> ローカル AGENTS.md の対応テーブルでコンテキスト探索を構造化
- `[MUST]` エージェントに対する禁止事項は NEVER/CRITICAL キーワードで明示的に宣言し、禁止コマンドの具体例をリスト化する
  - 根拠: ai-settings — Git ワークフローの禁止コマンド明示列挙とテストの「NEVER increase test timeouts」が一貫して適用
- `[MUST]` AI 設定ドキュメントでパターンを示す際は、必ず参照ファイル（Reference file）のパスを添付する。ドキュメントが古くなってもコードが真実の情報源として機能する
  - 根拠: ai-settings — 「Reference files: `path/to/file`」形式で具体的な参照先を提示
- `[SHOULD]` PostToolUse フック等で lint/format を自動強制し、エージェントの指示遵守に依存しない仕組みを構築する
  - 根拠: ai-settings — `.claude/settings.json` の PostToolUse フックで Edit/Write 後に自動実行

## ルール優先度の解釈

- `[MUST]`: 違反するとバグ・セキュリティリスク・重大な設計劣化を招くルール
- `[SHOULD]`: 従うことで品質が向上するが、文脈によっては例外を許容するルール
- `[AVOID]`: 意図的に避けるべきアンチパターン・非推奨プラクティス
