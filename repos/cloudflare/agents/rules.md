# cloudflare/agents — 導出ルール集

> 出典: repos/cloudflare/agents/ | 生成日: 2026-02-25
> 用途: CLAUDE.md にそのまま貼り付けて AI コンテキストとして活用

## ステート管理と永続化

- `[MUST]` ステートフルなサーバーレス環境では、すべてのフレームワーク状態を永続ストレージ（SQLite/KV）に格納し、インメモリ変数を信頼しない — Hibernation/eviction でインメモリ状態が消えても整合性が保たれる設計にする
  - 根拠: design-philosophy — スケジュール・キュー・リトライ設定・MCP 接続・状態すべてを SQLite テーブルに永続化している
- `[MUST]` スキーママイグレーションは冪等に行う — `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN` の duplicate 無視パターンで、どのバージョンのコードが起動しても正しいスキーマが得られるようにする
  - 根拠: architecture — コンストラクタ内に宣言的マイグレーションを配置し、バージョン不整合を防止
- `[SHOULD]` ブロードキャスト対象の共有状態（リアルタイム UI 状態）と、クエリ対象の履歴データを明確に分離する — broadcast される state に大量データを含めるとネットワーク帯域を圧迫する
  - 根拠: design-philosophy — `this.state` は変更時に全クライアントへ broadcast されるため、大量データは SQL に保持し state はメタデータのみにすべき
- `[SHOULD]` 再初期化が必要なメソッドはべき等に設計し、呼び出し側が「初期化済みかどうか」を判断する責務を持たないようにする
  - 根拠: durable-objects-actor-patterns — `_ensureConnectionWrapped` は WeakMap チェックで二重初期化を防止し、Hibernation 後の最初のメッセージで透過的に再ラップ
- `[AVOID]` 副作用を伴う処理で、アクセス制御チェックの前に不可逆な操作（外部 API 呼び出し、課金等）を実行する — 状態変更を先に行い、成功後に副作用を実行する
  - 根拠: design-philosophy — readonly チェックが `setState()` 内部で行われるため、それ以前の副作用はチェックをすり抜ける

## エラーハンドリングとリトライ

- `[MUST]` パラメータのバリデーションはタスク実行時ではなく登録時に行う（Eager Validation） — 数分後の実行時に初めて失敗する事態を防ぐ
  - 根拠: error-handling-idioms — `validateRetryOptions` は `schedule()`/`queue()` 呼び出し時に即座にエラーを投げる
- `[MUST]` エラーハンドリングフック（onError 相当）の呼び出しは二重の try-catch で囲み、フック自体の例外がシステム全体に波及しないようにする
  - 根拠: error-handling-idioms — キュー・スケジュール・state 変更の3箇所すべてで `try { await this.onError(e) } catch { /* swallow */ }` パターン
- `[SHOULD]` リトライ基盤を単一の関数に集約し、すべてのサブシステムから共通で呼び出す — バックオフ・バリデーション・観測性の一貫性を保つ
  - 根拠: error-handling-idioms — `tryN` が唯一のリトライループであり、キュー、スケジュール、ワークフロー、MCP 接続すべてが依存
- `[SHOULD]` エラー分類では構造化フィールド（ステータスコード等）を最優先し、文字列マッチはフォールバックに留める — 依存ライブラリのバージョン変更に対する耐性が上がる
  - 根拠: error-handling-idioms — `isTransportNotImplemented` は `getErrorCode` を先にチェックし、文字列マッチはフォールバック
- `[SHOULD]` 期待されるエラー（DDL のカラム重複等）を処理するパスは、汎用エラーハンドリングフックをバイパスする — 期待されるエラーが監視ログに紛れ込むとノイズになる
  - 根拠: error-handling-idioms — `addColumnIfNotExists` は `this.sql` を使わず raw exec を直接呼び、`onError` を回避
- `[AVOID]` バックログがあるキューにリトライ遅延を適用する — `setTimeout` ベースのリトライはイベントループをブロックし、後続タスクの head-of-line blocking を引き起こす
  - 根拠: error-handling-idioms — 設計ドキュメントに明記

## API 設計と公開制御

- `[MUST]` パッケージの exports フィールドに記載した全ファイルの存在を CI で自動検証する
  - 根拠: api-design-practices — `check-exports.ts` が条件付きエクスポートを再帰的に走査し、ビルド成果物の欠落を早期検出
- `[MUST]` 非推奨 API は即座に削除せず、新 API への委譲ラッパーを提供し runtime warning を1回だけ出す
  - 根拠: api-design-practices — `didWarn` フラグ + `console.warn` + 新関数呼び出しの一貫したパターンを6箇所以上で適用
- `[MUST]` RPC やリモート呼び出しで公開するメソッドはオプトイン（明示的なマーキング）で制御し、デフォルト非公開にする
  - 根拠: extensibility-mechanisms — `@callable()` デコレーターで明示的にマークされたメソッドのみ RPC 経由で呼び出し可能
- `[MUST]` RPC のパラメータと戻り値にはシリアライズ可能性を型レベルで強制する — Date, Map, Function はラウンドトリップしないため、コンパイル時にエラーとする
  - 根拠: state-sync-and-rpc — `Serializable` 型が再帰的に JSON シリアライズ可能性をチェック
- `[SHOULD]` optional peer dependency を持つ機能は専用のサブパスエントリポイントに分離し、コアインポートで不要な依存を引き込まない
  - 根拠: api-design-practices — `agents/react`, `agents/x402` 等、peer dependency が必要な機能ごとにエントリポイント分離
- `[SHOULD]` 不安定な API は import パス（`experimental/`）または関数名プレフィックス（`unstable_`）に安定性レベルを明示する
  - 根拠: api-design-practices — パスと命名で安定性シグナルを埋め込み、コードレビュー時にリスク判断可能に

## プロトコルとストリーミング

- `[MUST]` 双方向ステート同期では送信元を除外してブロードキャストする — クライアントが自分の変更を二重に受け取ることを防ぐ
  - 根拠: state-sync-and-rpc — `_broadcastProtocol` が送信元の connection ID を除外リストに含める
- `[MUST]` WebSocket プロトコルメッセージは enum で型安全に定義し、サーバー/クライアント双方で共有する — 文字列リテラルの散在はプロトコル変更時の追従漏れを招く
  - 根拠: architecture — `MessageType` enum がサーバーとクライアントの両方で import
- `[SHOULD]` resumable なストリームでは、チャンクを永続ストレージにバッファリングし、再接続時にリプレイ可能にする — ライブ配信とリプレイの経路を分離する
  - 根拠: streaming-patterns — `ResumableStream` は SQLite にチャンクをバッチ永続化し、再接続中クライアントをライブ broadcast から除外
- `[SHOULD]` ストリームチャンクのパーサーは「開始イベントの欠落」を許容するフォールバックを持つ — 再開時に途中のチャンクから処理を開始しても壊れない設計にする
  - 根拠: streaming-patterns — `text-start` なしで `text-delta` を受信した場合にも新しいテキストパーツを自動生成
- `[SHOULD]` Proxy ベースの RPC stub では、JS の内部メソッド（`toJSON`, `then`, `Symbol` 系等）をフィルタして RPC 呼び出しから除外する
  - 根拠: state-sync-and-rpc — `createStubProxy` が12個の内部メソッド名を明示的に除外
- `[AVOID]` ストリーム完了の待機にハードコードされたタイムアウトを使う — Promise ベースの完了通知を常に設定し、タイムアウトは最終防御としてのみ使う
  - 根拠: streaming-patterns — 500ms 固定タイムアウトは TODO コメント付きの暫定策

## フレームワーク設計と拡張性

- `[MUST]` フレームワーク基底クラスの内部フラグはユーザーコードから隠蔽し、`setState` 時にも自動保持する — フレームワーク固有プレフィックス（`_cf_` 等）で名前空間を分離
  - 根拠: architecture — `Object.defineProperty` により内部フラグをユーザーから隠蔽
- `[MUST]` フレームワーク統合コードはコアパッケージから分離し、最小限のアダプターレイヤーとして実装する
  - 根拠: extensibility-mechanisms — `hono-agents` パッケージは85行の薄いミドルウェアで、コアの `agents` パッケージは Hono に一切依存しない
- `[SHOULD]` フレームワークのアクセス制御は、開発者が個別メソッドでチェックする方式ではなく、共通パスの単一ポイントで強制する
  - 根拠: design-philosophy — readonly 強制を `setState()` 内部に配置することで、メソッドごとの権限チェック漏れを構造的に排除
- `[SHOULD]` ライフサイクルフックは「検証（同期・throw で拒否）」と「通知（非同期・エラーは onError 経由）」の2段階に分離する
  - 根拠: extensibility-mechanisms — `validateStateChange` は同期で throw、`onStateChanged` は非同期で通知のみ
- `[SHOULD]` 基盤ライブラリの継承は一段に留め、機能追加は composition（フィールド注入）または mixin で行う
  - 根拠: architecture — Agent → Server の一段継承に留め、MCP は composition、Fiber は mixin
- `[SHOULD]` Lazy initialization で外部サービスへの接続を遅延させ、失敗時にはキャッシュをリセットしてリトライ可能にする
  - 根拠: extensibility-mechanisms — `withX402` の facilitator 接続は `ensureInitialized()` で遅延、`catch` で `initPromise = null` にリセット
- `[AVOID]` 抽象クラスの必須メンバー（abstract property/method）を3つ以上にする — 必須設定が多すぎると「ボイラープレート地獄」に陥る
  - 根拠: extensibility-mechanisms — `McpAgent` は `server` と `init()` の2つだけを abstract に

## 観測性

- `[MUST]` 観測性インターフェースは単一メソッド（`emit` 等）に限定し、discriminated union で型安全なイベント分岐を実現する
  - 根拠: observability — `Observability` を `emit()` 1メソッドに限定し、利用者が1メソッド実装で全イベントを捕捉
- `[MUST]` イベントリスナーの登録は `Disposable` を返し、所有者のライフサイクルに紐づく `DisposableStore` で集約管理する
  - 根拠: observability — 接続ごとに `DisposableStore` を持ち、接続削除時に一括解除
- `[SHOULD]` 観測性レイヤーは optional chaining（`?.emit()`）でゼロコスト無効化できる設計にする
  - 根拠: observability — `undefined` 設定だけで全イベント発行を無効化でき、テスト環境の出力汚染を排除
- `[SHOULD]` イベント発行（`fire`）時は各リスナーを `try-catch` で囲み、1つの例外が他のリスナーの実行を妨げないようにする
  - 根拠: observability — `Emitter.fire()` がリスナーごとに例外を隔離

## スケジューリングとワークフロー

- `[MUST]` スケジューリングデータは揮発性ストレージではなく永続ストアに保存し、プロセス再起動後も確実に実行されるようにする
  - 根拠: scheduling-and-workflow — SQLite テーブルに全スケジュールを永続化し、alarm 起動時に未実行タスクを一括取得
- `[MUST]` ワークフローのステップで、べき等な操作と非べき等な操作の境界を API レベルで明確に分離する
  - 根拠: scheduling-and-workflow — `step` メソッド（耐久、リトライセーフ）と `this` メソッド（非耐久）の区別
- `[SHOULD]` プラットフォームの単一リソース制約に対しては、永続ストアによる多重化レイヤーで複数の論理リソースをエミュレートする
  - 根拠: scheduling-and-workflow — 単一アラーム制約に対して SQLite テーブル + `MIN(time)` で任意数のスケジュールを実現
- `[SHOULD]` 定期実行タスクには重複実行防止（`running` フラグ + ハング検知タイムアウト）を組み込む
  - 根拠: scheduling-and-workflow — running フラグとタイムスタンプベースのハング検知で、コールバック遅延時のスキップとハング時のフォースリセットを区別
- `[AVOID]` ワークフロー追跡テーブルを自動クリーンアップなしで運用する — 完了・エラーレコードの保持ポリシーを必ず設計する
  - 根拠: scheduling-and-workflow — テーブルが無制限に増加する問題を警告

## テスト

- `[MUST]` テスト環境が異なるランタイム（エッジ、ブラウザ、Node.js）を跨ぐ場合、vitest の projects 機能でプロジェクトを分離し、各プロジェクトに独自の config を持たせる
  - 根拠: testing-practices — Workers テスト、React テスト、CLI テスト、x402 テストが独立した vitest config に分離
- `[SHOULD]` 共有リソースを使うテストでは、各テストケースがユニークな識別子を生成して名前空間を分離する
  - 根拠: testing-practices — `crypto.randomUUID()` やテスト名をインスタンス名に含めることで `isolatedStorage: false` でもテスト間干渉を防止
- `[SHOULD]` 公開 API の型推論（特にジェネリクスや条件型）は `.test-d.ts` ファイルで `satisfies` と `@ts-expect-error` を使いコンパイル時に検証する
  - 根拠: testing-practices — 型レベルのリグレッションはランタイムテストでは検出できない
- `[AVOID]` 非同期処理の完了待ちに固定 sleep を使う — 条件ポーリングまたは `vi.waitFor` を使う
  - 根拠: testing-practices — `setTimeout(resolve, 100)` より `vi.waitFor` や `while` ループによるポーリングの方が CI 安定性が高い

## ビルドと CI/CD

- `[MUST]` ビルドとチェック（lint/typecheck/export 検証）の実行順序を「build -> check」で固定する
  - 根拠: build-and-tooling — check:exports は生成された dist/ の存在を前提としている
- `[SHOULD]` CI のチェックコマンドは失敗コスト（実行時間）の昇順で直列実行し、低コストなチェックで早期失敗させる
  - 根拠: ci-cd — sherif(最軽量) -> exports -> format -> lint -> typecheck(最重量) の順
- `[SHOULD]` pre-commit フックではフォーマットのみを実行し、lint と typecheck は CI に委ねる
  - 根拠: build-and-tooling — `lint-staged` で oxfmt のみを実行し、コミット体験の軽量さを維持
- `[SHOULD]` npm パッケージの公開時は provenance（`NPM_CONFIG_PROVENANCE`）を有効化して、パッケージの来歴を保証する
  - 根拠: ci-cd — trusted publishing でサプライチェーンの透明性を確保

## 開発規約とモノレポ運用

- `[MUST]` モノレポでは `verbatimModuleSyntax: true` を基底 tsconfig に設定し、型インポートと値インポートの区別を強制する
  - 根拠: dev-conventions — バンドル時の不要モジュール混入を防止
- `[MUST]` 自動生成ファイルは lint/format の対象から除外し、再生成コマンドを `package.json` の scripts に定義する
  - 根拠: dev-conventions — `env.d.ts` が oxlint の `ignorePatterns` で除外
- `[SHOULD]` npm 公開しない内部共有パッケージは `private: true` + source-level export（`./src/` を直接指す）とし、ビルドパイプラインを省略する
  - 根拠: project-structure — `agents-ui` パッケージが `./src/index.tsx` を直接 export し、Vite のトランスパイルに委ねている
- `[SHOULD]` モノレポの tsconfig は共通ベース設定を `extends` で継承し、個別設定のカスタマイズは最小限にする
  - 根拠: project-structure — 40以上のワークスペースが `tsconfig.base.json` を `extends` し、基盤設定を一元管理
- `[SHOULD]` インフラ設定ファイルには JSON Schema の `$schema` フィールドを設定し、IDE のバリデーションと補完を有効化する
  - 根拠: dev-conventions — 全 `wrangler.jsonc` に `$schema` が設定され、設定ミスが編集時に検出

## AI 設定

- `[MUST]` AI 設定ファイルをディレクトリ固有のスコープで配置する場合、ルートファイルにサブファイルの一覧テーブル（パスとスコープの1行要約）を設ける
  - 根拠: ai-settings — ルート AGENTS.md のナビゲーションテーブルで AI が全体構造を即座に把握
- `[MUST]` AI 設定ファイルの行動制約は「Always（必須）」「Never（禁止）」に加え、「Ask first（確認必要）」の中間レベルを設ける
  - 根拠: ai-settings — 影響範囲の広い操作を完全に禁止すると有用性が低下し、許可すると危険
- `[SHOULD]` 設計判断の記録は「生きたドキュメント（現状を反映）」と「スナップショット（決定時の記録）」の2種類に分離する
  - 根拠: ai-settings — design doc は常に最新の実装を反映し、RFC は変更せず保存
- `[AVOID]` 1つの AI 設定ファイルに200行を超える指示を詰め込む — コンテキストウィンドウの圧迫と重要指示の埋没リスク
  - 根拠: ai-settings — examples/AGENTS.md は225行に達し、分割の余地がある

## ルール優先度の解釈

- `[MUST]`: 違反するとバグ・セキュリティリスク・重大な設計劣化を招くルール
- `[SHOULD]`: 従うことで品質が向上するが、文脈によっては例外を許容するルール
- `[AVOID]`: 意図的に避けるべきアンチパターン・非推奨プラクティス
