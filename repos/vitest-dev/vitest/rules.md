# vitest-dev/vitest — 導出ルール集

> 出典: repos/vitest-dev/vitest/ | 生成日: 2026-03-06
> 用途: CLAUDE.md にそのまま貼り付けて AI コンテキストとして活用

## アーキテクチャ・モジュール設計

- `[MUST]` モノレポのパッケージ間依存は DAG（有向非巡回グラフ）を維持し、leaf パッケージ（外部依存ゼロ）を依存グラフの底に配置する
  - 根拠: project-structure — 17パッケージで `@vitest/pretty-format` と `@vitest/spy` を依存ゼロの leaf として3層構造を形成
- `[MUST]` 統合テストはプロダクトパッケージのソースを直接 import せず、公開パッケージとして（`workspace:*` や公開 API 経由で）依存する
  - 根拠: project-structure — `test/*` が全て `"vitest": "workspace:*"` で依存し、エンドユーザーと同じ解決パスでテスト
- `[MUST]` 互換 API を提供する場合、既存ライブラリのプラグイン/拡張機構を活用しコアロジックの再実装を避ける
  - 根拠: api-design-practices — Chai プラグインシステムで Jest API を構築し、アサーションエンジン自体は再実装していない
- `[MUST]` 公開 API の拡張ポイントはインターフェース（プロトコル）で定義し、デフォルト実装と分離する
  - 根拠: api-design-practices — `SnapshotEnvironment` で Node.js 実装をデフォルト提供しつつ環境差し替えを可能にしている
- `[SHOULD]` 公開 API を `src/public/` のような専用ディレクトリに集約し、ビルド設定のエントリポイントと一致させて内部実装の漏洩を物理的に防ぐ
  - 根拠: project-structure — `packages/vitest/src/public/` に 12 エントリファイルを配置し `rollup.config.js` と対応
- `[SHOULD]` CLI エントリポイントは薄く保ち、コア機能はプログラマティック API として独立させる
  - 根拠: architecture — `cli.ts` は3行でパーサーに委譲し `startVitest()` / `createVitest()` が独立 API
- `[SHOULD]` 単一の巨大プラグインではなく責務ごとに分離したプラグイン配列を返す構成にする
  - 根拠: vite-integration-patterns — MetaEnvReplacer, CSSEnabler, Coverage, Mocks 等を個別プラグインとして実装
- `[SHOULD]` ユーティリティパッケージはサブパスエクスポートで機能を分離し、メインエントリからの一括インポートを禁止する
  - 根拠: design-philosophy — `@vitest/utils` は `/helpers`, `/error`, `/timers` 等12個のサブパスに分離

## プロセス間通信・ワーカー管理

- `[MUST]` メインプロセスとワーカーの境界には型付きメッセージプロトコル（タグ付きユニオン + 識別フラグ）を定義する
  - 根拠: architecture — `WorkerRequest` / `WorkerResponse` に `__vitest_worker_request__` フラグを付与
- `[MUST]` テストコードが上書きしうるグローバル関数（タイマー、`process.exit` 等）は、初期化時に bind で事前キャプチャする
  - 根拠: architecture, worker-isolation-patterns — `process.exit.bind(process)` + `withSafeTimers()` でフレームワーク通信を保護
- `[SHOULD]` ワーカーのライフサイクルを明示的な状態マシン（IDLE/STARTING/STARTED/STOPPING/STOPPED）で管理し、操作ロックで並行遷移を防止する
  - 根拠: architecture — `PoolRunner` の `RunnerState` enum と `_operationLock` で start/stop の競合を排除
- `[SHOULD]` ワーカーの停止処理はグレースフル停止 → タイムアウト → フォースキル（SIGKILL）の段階設計にする
  - 根拠: worker-isolation-patterns — forks プールが SIGTERM → 500ms 後 SIGKILL のエスカレーションを実装
- `[SHOULD]` ワーカープールの再利用判定には、タスクの実行コンテキスト（環境名・設定）の等価性チェックを含める
  - 根拠: worker-isolation-patterns — `isEqualRunner()` が環境名・オプションの深い比較を実行
- `[SHOULD]` プロセス間で設定を転送する際は、直列化可能なフィールドのみを含む別の型を定義する
  - 根拠: configuration-patterns — `SerializedConfig` 型で `ResolvedConfig` から関数・クラスインスタンスを除外
- `[AVOID]` ワーカープロセス内でメインプロセスの状態に直接アクセスする設計。RPC 経由で必要最小限のデータのみ受け渡す
  - 根拠: architecture — `RuntimeRPC` は必要最小限のメソッドのみ公開しワーカーが内部状態に触れない設計

## テスト戦略

- `[MUST]` テストフレームワークやCLIツールの統合テストでは、実際のプロセス/APIを実行して stdout/stderr を検証する — モックで代替しない
  - 根拠: testing-practices — `startVitest` で実際に起動し stdout/stderr をキャプチャ、AGENTS.md で No-mock ポリシーを明文化
- `[MUST]` テストでは部分一致（`toContain`）より完全一致（`toMatchInlineSnapshot`）を優先し、期待値の変化をコードレビューで可視化する
  - 根拠: design-philosophy — `toContain` を禁止し `toMatchInlineSnapshot` を標準とすることで出力変更の見逃しを防止
- `[MUST]` テストが作成・変更したリソース（ファイル、プロセス、グローバル状態）は、テスト終了時のフックで自動クリーンアップする
  - 根拠: testing-practices — `createFile`, `editFile`, `useFS`, `runVitest` の全てが `onTestFinished` でクリーンアップを登録
- `[SHOULD]` テストに必要なファイル構造は、テスト本体にインラインで宣言的に定義する
  - 根拠: testing-practices — `runInlineTests` の `TestFsStructure` パターンで前提条件が一箇所にまとまる
- `[SHOULD]` テストはモックではなく実際のシステムを起動して振る舞いを検証し、リファクタリング耐性を高める
  - 根拠: design-philosophy — 全統合テストが `runInlineTests` で実際に Vitest を起動しモック使用率ゼロ
- `[SHOULD]` テスト実行順序は「失敗優先・長時間優先」でソートし、CI フィードバックループを最小化する
  - 根拠: worker-isolation-patterns — `BaseSequencer.sort()` が過去の実行結果キャッシュを参照して並べ替え
- `[SHOULD]` テストワークスペースは機能単位ではなくテスト手法・実行特性（単体/CLI統合/E2E等）で分類する
  - 根拠: project-structure — カテゴリごとに実行戦略が異なる（単一インスタンス / 毎回プロセス起動 / Playwright E2E）
- `[AVOID]` テストでの内部実装のモック化 — 内部構造への結合度が高まりリファクタリングのたびにテストが壊れる
  - 根拠: design-philosophy — AGENTS.md "No mocking policy -- You must never mock anything in tests"

## エラーハンドリング

- `[MUST]` エラー表示パイプラインでは各変換段階にフォールバックを設ける — シリアライズ失敗時のマーカー置換、pretty-print 失敗時のリトライなど
  - 根拠: error-handling-idioms — プロパティ単位の `try/catch`、`maxDepth` 半減リトライ、`callToJSON` 無効化リトライの三重フォールバック
- `[MUST]` エラー処理関数の入り口で非 Error オブジェクト（文字列、null、undefined）を統一フォーマットに正規化する
  - 根拠: error-handling-idioms — `isPrimitive` + null チェックで全入力を正規化し後続処理の型安全を保証
- `[MUST]` プロセス間でエラーを転送する際は plain object にシリアライズする — Error インスタンスは構造化複製で問題を起こす
  - 根拠: error-handling-idioms — `Object.create(null)` で再構築しプロトタイプチェーンを走査して全プロパティをコピー
- `[SHOULD]` エラーメッセージには「何が起きたか」「どう直すか」「一時的なワークアラウンド」の3層を含め、コピペ可能なコード例を添える
  - 根拠: error-handling-idioms — ESM/CJS エラー時に設定コード付きの解決策を提示
- `[SHOULD]` 差分表示・stringify に出力サイズ上限を設け、巨大オブジェクトがターミナルや RPC 通信をフリーズさせないようにする
  - 根拠: error-handling-idioms — `MAX_DIFF_STRING_LENGTH`（20,000字）、prettyFormat 截断（100,000字）等の多段上限
- `[SHOULD]` スタックトレースは内部フレームをフィルタリングし、ユーザーコードに最も近いフレームをハイライトする
  - 根拠: error-handling-idioms — `__VITEST_HELPER__` 検出 + `defaultStackIgnorePatterns` で最近傍フレーム特定
- `[AVOID]` エラー表示処理内で例外を投げること — 「エラーの表示に失敗してエラー」はユーザーにとって最悪の体験
  - 根拠: error-handling-idioms — パイプラインのあらゆる箇所で `try/catch` + フォールバック

## 型システム

- `[MUST]` ライブラリの拡張ポイントとなる型は空 interface として宣言し、ユーザーが declaration merging で型を追加できるようにする
  - 根拠: type-system-patterns — `Matchers`, `TaskMeta`, `TestContext`, `ProvidedContext` が全て空 interface
- `[MUST]` 空 interface の型パラメータが拡張時に必要な場合、未使用でも削除せずコメントで理由を明記する
  - 根拠: type-system-patterns — `Matchers<T>` の `T` は eslint-disable + コメントで保持
- `[SHOULD]` `ThisType<T>` を使ってコールバック定義オブジェクトの `this` コンテキストを型安全にする
  - 根拠: type-system-patterns — `MatchersObject` は `ThisType<MatcherState>` でマッチャー関数内の `this` を型安全に
- `[SHOULD]` リテラルユニオンで候補を提示しつつ任意の文字列も許容する場合は `LiteralUnion | (string & Record<never, never>)` パターンを使う
  - 根拠: type-system-patterns — `VitestEnvironment` 型がビルトイン環境名の補完を維持しつつカスタム環境名を許容
- `[SHOULD]` 空 interface + `Registry[keyof Registry]` パターンでプラグインが型を自動登録できるユニオンを構築する
  - 根拠: type-system-patterns — `TestArtifactRegistry` に型を追加するだけで `TestArtifact` ユニオンが自動拡張

## 設定管理

- `[MUST]` 設定オブジェクトのデフォルト値は `Object.freeze` で保護し、マージ処理で変更されないことを保証する
  - 根拠: configuration-patterns — `configDefaults` は `Object.freeze` で保護
- `[MUST]` 互いに排他的な設定オプションの組み合わせは設定解決フェーズで早期に検出してエラーを投げる
  - 根拠: configuration-patterns — `--shard` + `--watch`、`--inspect` + 並列実行など 10 以上の矛盾を早期検出
- `[SHOULD]` 設定の優先順位（defaults < config file < CLI）を明示的なマージ順序で表現する
  - 根拠: configuration-patterns — `deepMerge({}, configDefaults, viteConfig.test, options)` の順序で優先順位を直接表現
- `[SHOULD]` サブプロジェクトへの CLI オプション伝播はホワイトリスト方式で制御する
  - 根拠: configuration-patterns — `overridesOptions` のホワイトリストで安全なオプションのみ伝播
- `[SHOULD]` 環境依存のデフォルト値（CI/ローカル、TTY/非TTY）は設定ファイルではなくデフォルト定義箇所で条件分岐させる
  - 根拠: configuration-patterns — `isCI` により `watch`, `allowOnly`, `open` のデフォルトを動的切り替え

## コード変換・AST 操作

- `[MUST]` AST ベースのコード変換では元コードの位置情報を保持する差分パッチ（MagicString 等）を使い、ソースマップを生成する
  - 根拠: module-mocking-architecture — 全変換で `MagicString` + `generateMap({ hires: 'boundary' })` を使用
- `[MUST]` 再帰的オブジェクト走査では循環参照を検出・追跡する仕組みを設ける
  - 根拠: module-mocking-architecture — `RefTracker` が ID ベースの参照追跡と遅延解決で無限再帰を防止
- `[MUST]` キーに任意の文字列を使うデータストアには `Object.create(null)` を使いプロトタイプチェーン汚染を防止する
  - 根拠: snapshot-design — プロトタイプなしオブジェクトでスナップショットキー汚染を防止
- `[MUST]` ファイル書き込み前に旧コンテンツとの同一性を検証し、不要な I/O を省略する
  - 根拠: snapshot-design — CI のタイムスタンプ変化、git diff の誤検出、ウォッチモードの無限ループを防止
- `[SHOULD]` 重い AST 解析の前に正規表現で対象ファイルを事前フィルタリングする
  - 根拠: module-mocking-architecture — `hoistMocks.ts` と `dynamicImportPlugin.ts` で正規表現テストによる早期リターン
- `[SHOULD]` ソースコードの部分書き換えには MagicString などのオフセット追跡ライブラリを使い、複数箇所の同時変更でもインデックスがずれない仕組みを確保する
  - 根拠: snapshot-design — 素の文字列置換では前方の変更が後方のオフセットを狂わせるが MagicString は内部で差分管理

## ビルド・依存管理

- `[MUST]` モノレポのビルド設定では共通ロジックを薄いユーティリティに抽出し、各パッケージは差分のみを定義する
  - 根拠: build-and-tooling — 17パッケージが `scripts/build-utils.js` の `createDtsUtils()` を共有
- `[MUST]` Rollup の external リストは `package.json` の `dependencies`/`peerDependencies` から自動生成し手動管理を避ける
  - 根拠: build-and-tooling — 全パッケージで `Object.keys(pkg.dependencies || {})` パターンを使用
- `[SHOULD]` 共有外部依存のバージョンは単一ソース（pnpm catalog 等）で管理し、各パッケージから参照する
  - 根拠: project-structure — pnpm catalog に 48 依存のバージョンを集約し `"catalog:"` で参照
- `[SHOULD]` 型定義生成とランタイムビルドを分離し、watch モードでは型バンドルをスキップして高速化する
  - 根拠: build-and-tooling — DTS バンドル設定に `watch: false` を指定
- `[SHOULD]` `patchedDependencies` を使う際はパッチファイル内に上流 issue/PR への参照コメントを記載する
  - 根拠: build-and-tooling — istanbul パッチに PR 番号への参照があり追跡可能
- `[SHOULD]` 依存追加はトランジティブ依存を含むサイズ対価値で判断し、要件を満たさない場合はフォークを検討する
  - 根拠: design-philosophy — CONTRIBUTING.md "Avoid deps that has large transitive dependencies" + tiny-* ライブラリ群の採用

## CI/CD

- `[MUST]` CI ワークフロー冒頭で `permissions: {}` を宣言し、ジョブレベルで必要最小限の権限のみ付与する
  - 根拠: ci-cd — 全7ワークフローで一貫してこのパターンを適用
- `[MUST]` サードパーティ GitHub Action は commit SHA でピン留めし、コメントにバージョン番号を併記する
  - 根拠: ci-cd — 全サードパーティ Action を SHA 固定
- `[SHOULD]` マルチ OS/ランタイム マトリクスは非対称に構成し、主要プラットフォームで全バージョン、副次プラットフォームは最新のみテストする
  - 根拠: ci-cd — Ubuntu で Node 20/22/24、macOS/Windows は Node 24 のみとしジョブ数を 9 から 5 に削減
- `[SHOULD]` CI に変更検出ジョブを設け、コード変更を伴わない PR（docs 等）ではテストをスキップする
  - 根拠: ci-cd — `changed` ジョブが docs/.github/.md のみの変更を検出し全テストジョブをスキップ
- `[SHOULD]` `concurrency` グループを PR 番号ベースで設定し、同一 PR の古い CI 実行を自動キャンセルする
  - 根拠: ci-cd — `cancel-in-progress: true` で不要な並走を排除
- `[AVOID]` マトリクスの `fail-fast` をデフォルト（`true`）のまま使う — 1環境の失敗で他の環境の結果が隠れる
  - 根拠: ci-cd — 全マトリクスジョブで `fail-fast: false` を明示

## AI エージェントガイド

- `[MUST]` AI エージェント向けガイドでは禁止事項を「must never」「AVOID」等の断定的表現で記述する
  - 根拠: ai-settings — 曖昧な推奨（"try to"）は AI に判断余地を残し品質が不安定になる
- `[MUST]` 複数の AI ツールを併用する場合、共通ガイドを単一ファイルに集約しツール固有ファイルからはリンクのみとする（Hub-Spoke 構造）
  - 根拠: ai-settings — CLAUDE.md(11行) と copilot-instructions.md(11行) が AGENTS.md(150行) を参照
- `[SHOULD]` AI ガイドにはプロジェクト固有のユーティリティ名・インポートパス・使い分け基準を明示する
  - 根拠: ai-settings — `runInlineTests` と `runVitest` を具体パス付きで列挙し選択基準を添える

## ルール優先度の解釈

- `[MUST]`: 違反するとバグ・セキュリティリスク・重大な設計劣化を招くルール
- `[SHOULD]`: 従うことで品質が向上するが、文脈によっては例外を許容するルール
- `[AVOID]`: 意図的に避けるべきアンチパターン・非推奨プラクティス
