# anomalyco/opencode — 導出ルール集

> 出典: repos/anomalyco/opencode/ | 生成日: 2026-03-05
> 用途: CLAUDE.md にそのまま貼り付けて AI コンテキストとして活用

## スキーマ駆動設計

- `[MUST]` ドメインモデルの型は Zod スキーマから `z.infer<typeof Schema>` で導出し、手動の型定義と二重管理しない
  - 根拠: type-system-patterns — 50箇所以上で一貫して適用され、型とバリデーションの乖離を構造的に防止
- `[MUST]` 外部境界（API 入力・ツール引数・設定ファイル）では Zod スキーマで parse し、内部では推論された型を信頼する
  - 根拠: type-system-patterns — `fn()` ラッパーと `Tool.define` が全入力を `schema.parse()` で検証
- `[MUST]` API のリクエスト/レスポンス型はバリデーションスキーマを単一ソースとし、OpenAPI スペックと SDK 型はそこから自動生成する
  - 根拠: api-design-practices — Zod → hono-openapi → @hey-api/openapi-ts の一方向パイプラインで手動同期を排除
- `[SHOULD]` 多態的なデータには `z.discriminatedUnion` を使い、ディスクリミネータフィールドでバリアントを識別する
  - 根拠: type-system-patterns — ToolState, Part, Info 等15箇所以上で一貫使用
- `[SHOULD]` Zod スキーマに `.meta({ ref: "TypeName" })` を付与して、OpenAPI スペックで名前付き `$ref` 型を生成する
  - 根拠: api-design-practices — SDK 側で独立した名前付き型として利用可能になる
- `[SHOULD]` ビジネスロジック関数にバリデーションスキーマを添付し（`fn()` パターン）、API 層で `.schema.omit()` 等の変換を適用する
  - 根拠: api-design-practices — `Session.create.schema` 等のパターンでドメインと API の型が自動同期

## エラーハンドリング

- `[MUST]` エラー型は名前（文字列リテラル）とスキーマで定義し、`instanceof` ではなく構造的判別（`isInstance`）を使う
  - 根拠: error-handling-idioms — シリアライズ/デシリアライズをまたいでも判別可能
- `[MUST]` ドメイン境界にはエラー変換関数を配置し、外部ライブラリの例外型を内部エラー型に変換する
  - 根拠: error-handling-idioms — `MessageV2.fromError()` が SDK 固有例外をドメインエラーに一元変換
- `[SHOULD]` 非同期処理のエラーハンドリングは `.catch(() => defaultValue)` で行い、try/catch より優先する
  - 根拠: design-philosophy, error-handling-idioms — 85箇所以上の `.catch()` 使用に対し try/catch は48箇所未満
- `[SHOULD]` エラーデータに Zod スキーマを使い、API レスポンス定義と型定義を一元管理する
  - 根拠: error-handling-idioms — `NotFoundError.Schema` がそのまま OpenAPI レスポンススキーマとして使用
- `[SHOULD]` 権限拒否は単一エラーではなく、拒否理由別のエラークラスで表現し後続処理を分岐させる
  - 根拠: permission-and-security — Rejected/Corrected/Denied の3クラスで異なる UX を提供
- `[AVOID]` 空の `.catch(() => {})` はクリーンアップ処理に限定し、データ取得やビジネスロジックでは使わない
  - 根拠: error-handling-idioms — `unlink().catch(() => {})` 等、失敗しても問題ない処理にのみ使用

## 状態管理とデータフロー

- `[MUST]` DB 書き込みとイベント発行を同一トランザクション内で直接実行せず、副作用遅延機構でトランザクション完了後に発行する
  - 根拠: session-state-management, storage-patterns — Database.effect パターンで15箇所以上のCRUD関数が一貫適用
- `[MUST]` イベント駆動のクライアント状態同期では、初期化時に REST API で全状態を取得し以降はイベントで差分更新するハイブリッド方式を採用する
  - 根拠: session-state-management — bootstrap + SSE イベントのハイブリッド同期
- `[MUST]` サーバーサイドでリクエストスコープの状態を扱う場合は AsyncLocalStorage 等のコンテキスト伝播メカニズムを使い、グローバル変数への依存を避ける
  - 根拠: architecture, session-state-management — Instance.provide() で複数ワークスペースの同時処理を安全に実現
- `[SHOULD]` 高頻度のリアルタイムイベントをフロントエンドで処理する場合、フレーム単位（16ms）でバッチ化し一括状態更新を行う
  - 根拠: architecture, tui-rendering-patterns — 16ms 間隔のバッチングで不要な再レンダリングを抑制
- `[SHOULD]` イベントペイロードは Zod 等のスキーマライブラリで型定義し、publish/subscribe 双方の型安全性をコンパイル時に保証する
  - 根拠: session-state-management — BusEvent.define が40種以上のイベントに Zod スキーマを適用
- `[SHOULD]` UI 表示用の一時的な状態（稼働状態・リトライカウント等）は永続レイヤから分離しインメモリで管理する
  - 根拠: session-state-management — SessionStatus は Instance.state でインメモリ管理
- `[AVOID]` イベントバスに状態のリプレイやキューイング機能を持たせる。バスは通知に徹し、状態の復旧は永続レイヤから行う
  - 根拠: session-state-management — Bus はインメモリ pub/sub のみ、再接続時は bootstrap で DB からリロード

## ストレージとマイグレーション

- `[MUST]` SQLite を使う場合、接続時に WAL モード・busy_timeout・foreign_keys を PRAGMA で設定する
  - 根拠: storage-patterns — 6つの PRAGMA で並行読み書き性能と外部キー制約を確保
- `[SHOULD]` ORM のスキーマ定義はドメインモジュールと co-locate し、glob パターンで収集する
  - 根拠: storage-patterns — `*.sql.ts` を各ドメインディレクトリに配置し自動収集
- `[SHOULD]` 頻繁にクエリされるフィールドは正規カラムに、可変の半構造化データは JSON カラムに分離する
  - 根拠: storage-patterns — id/session_id/タイムスタンプを正規カラム、残りを JSON カラムに格納
- `[SHOULD]` 階層型エンティティの削除は DB の CASCADE に委ね、アプリケーションコードで再実装しない
  - 根拠: session-state-management — Session/Message/Part/Todo すべてに onDelete: "cascade" を設定
- `[SHOULD]` CLI ツールのバイナリ配布時は、マイグレーション SQL をビルド時にバンドルして外部ファイル依存を排除する
  - 根拠: storage-patterns, build-and-tooling — define による定数埋め込みと typeof ガードで分岐

## AI エージェント制御

- `[MUST]` LLM エージェントのループ制御は finish reason だけに依存せず、アプリケーション層で明示的な継続/停止/コンパクション判定を行う
  - 根拠: agent-orchestration — processor.process() の三値戻り値で LLM の不正な finish reason に対する耐性を確保
- `[MUST]` 自律エージェントには無限ループ防止機構を組み込む（同一操作の連続検出、最大ステップ数制限）
  - 根拠: agent-orchestration — doom loop 検出と agent.steps による二重防御
- `[MUST]` AI エージェントにツールアクセスを許可する場合、デフォルトを全無効にし必要なツールだけをホワイトリストで有効化する
  - 根拠: ai-settings — triage/duplicate-pr エージェントは全ツール無効から必要な1つだけを許可
- `[MUST]` AI エージェントの自然言語プロンプトで指示したルールは、ツール実装内でもプログラム的にバリデーションする（多重防御）
  - 根拠: ai-settings — プロンプトのルールと同じ条件を throw new Error() で強制
- `[SHOULD]` サブエージェントは親とは独立したセッションで実行し、結果のみを親に返す
  - 根拠: agent-orchestration — TaskTool は子セッションで実行しテキスト結果のみを返却
- `[SHOULD]` LLM ストリームの各チャンクは受信時に即座に永続化し、中断耐性と UI リアルタイム更新を両立させる
  - 根拠: agent-orchestration — ストリームイベントごとに Session.updatePart() を呼び出し
- `[SHOULD]` エージェントの差異はパーミッションとプロンプトの組み合わせで宣言的に定義し、実行ロジックの共通化を維持する
  - 根拠: agent-orchestration — 全エージェントが同一の SessionProcessor と LLM.stream() を共有
- `[SHOULD]` API リトライではレスポンスヘッダー（retry-after）を最優先で使用し、ヘッダーがない場合のみ指数バックオフにフォールバックする
  - 根拠: agent-orchestration — SessionRetry.delay() はヘッダー解析を最初に実行
- `[SHOULD]` AGENTS.md 等のスタイルガイドに「AI エージェントが従うべきルール」を明示的に記述する
  - 根拠: design-philosophy — AGENTS.md が AI の冗長な命名傾向を直接抑制

## ツール・プラグインシステム

- `[MUST]` ツールの定義インターフェースを統一し、組み込み・プラグイン・ユーザ定義すべてが同一の型に準拠するようにする
  - 根拠: tool-system-design — Tool.Info インターフェースに統一しレジストリが出自を区別しない
- `[MUST]` ツール実行の前処理・後処理（バリデーション・出力制限等）はファクトリまたはミドルウェアで一元化する
  - 根拠: tool-system-design — Tool.define が Zod バリデーションとトランケーションを自動ラップ
- `[SHOULD]` ツールの説明文（LLM 向けプロンプト）はコードから分離し、テンプレート変数で実行時情報を埋め込む
  - 根拠: tool-system-design — .txt ファイルに description を分離し ${directory} 等で動的注入
- `[SHOULD]` LLM がツールを不正に呼び出した場合のフォールバックツールを用意し、構造化エラーメッセージで LLM にリカバリを促す
  - 根拠: tool-system-design — InvalidTool が不正呼び出しを捕捉し再試行可能なメッセージを返す
- `[SHOULD]` プラグイン拡張点ではフックの入力（read-only context）と出力（mutable result）を明確に分離する
  - 根拠: composition-patterns, plugin-extensibility — Plugin.trigger(name, input, output) の設計
- `[SHOULD]` 拡張の参入障壁を段階的に設計する — ファイル配置だけで動く簡易拡張と API を介した高度な拡張を分離する
  - 根拠: plugin-extensibility — カスタムツール(ファイル配置) → プラグイン(Hooks) → MCP(外部プロセス) の3段階
- `[AVOID]` ツール出力をそのままコンテキストウィンドウに流す。大きな出力はファイル保存+参照誘導で処理する
  - 根拠: tool-system-design — Truncate.output が行数・バイト数制限を超えた出力をファイルに保存

## コーディングスタイル

- `[SHOULD]` 変数名は単語数を最小化し、一度しか使わない中間変数はインライン化する
  - 根拠: design-philosophy — AGENTS.md が pid, cfg, err 等の短縮名を提示し複合語を禁止
- `[SHOULD]` Zod スキーマと同名の型を `z.infer<typeof Schema>` で導出し、namespace 内で値と型を共存させる
  - 根拠: design-philosophy, type-system-patterns — export const Info / export type Info の並置パターン
- `[SHOULD]` 多段の設定マージには pipe + mergeDeep の宣言的パイプラインを使い、命令的な if/else を避ける
  - 根拠: composition-patterns — LLM オプション構築で4段マージを1式で表現
- `[SHOULD]` 配列の条件付き合成には `...(condition ? [item] : [])` スプレッドパターンを使う
  - 根拠: composition-patterns — ToolRegistry でフィーチャーフラグによるツール追加を宣言的に表現
- `[AVOID]` 分割代入を多用してオブジェクトの出自情報を消す。ドットアクセスで値の所属を明示する
  - 根拠: design-philosophy — AGENTS.md が分割代入を禁止しドットアクセスを推奨
- `[AVOID]` else 文を使う。早期リターンとガード節で条件分岐を平坦化しネスト深度を1段に保つ
  - 根拠: design-philosophy — 1273ファイル規模に対して else が83箇所にとどまる

## テスト

- `[MUST]` テスト用の一時リソース（ディレクトリ・DB）には確定的なクリーンアップ機構を組み込む（Symbol.asyncDispose、try/finally 等）
  - 根拠: testing-practices — fixture.ts の Symbol.asyncDispose でリソースリークを構造的に防止
- `[SHOULD]` モックの代わりに一時ディレクトリ + コンテキスト注入で実装のコードパスをそのまま通すテストを書く
  - 根拠: testing-practices — 100以上のテストファイル中モック使用は16ファイルに限定
- `[SHOULD]` E2E テストでは CSS クラスや ID ではなく data-* 属性をセレクタに使う
  - 根拠: testing-practices — 全セレクタが data-component / data-action ベースで定義
- `[SHOULD]` E2E テストのデータセットアップは UI 操作ではなく API/SDK 経由で行い、UI 操作は検証対象のインタラクションのみに絞る
  - 根拠: testing-practices — withSession, seedSessionQuestion 等は全て SDK 経由
- `[AVOID]` テスト対象モジュールに5個以上のモジュールモックが必要な場合、テスト手法ではなくモジュール設計を見直す
  - 根拠: testing-practices — 12モック依存は密結合を示唆、純粋ロジックの抽出で改善可能

## ビルドと配布

- `[MUST]` コンパイル時定数を define で埋め込む場合、アプリケーション側で typeof ガード付きフォールバックを必ず用意する
  - 根拠: build-and-tooling — typeof OPENCODE_VERSION === "string" ? ... : "local" でビルドなし開発時も動作
- `[SHOULD]` モノレポのビルドオーケストレーションでは、タスク間依存を最小限に宣言しテスト以外のビルドは独立並列実行可能にする
  - 根拠: build-and-tooling — build.dependsOn: [] とし test のみ ^build に依存
- `[SHOULD]` バイナリに必要なランタイムデータ（マイグレーション・API スナップショット等）はビルド時にフェッチ・埋め込みし実行時のネットワーク依存を排除する
  - 根拠: build-and-tooling — モデル API プリフェッチとマイグレーション SQL のバイナリ埋め込み
- `[AVOID]` ビルドスクリプト内で process.chdir() を使ってグローバルな CWD を変更する
  - 根拠: build-and-tooling — コマンド単位の CWD 指定を使いグローバル状態変更を回避

## セキュリティと権限

- `[MUST]` ツール実行の権限チェックは実行直前に同期的に行い、事前キャッシュした結果を信頼しない
  - 根拠: permission-and-security — 各ツールの execute 内で ctx.ask() を呼び Promise resolve まで実行をブロック
- `[MUST]` 認証情報ファイルは OS レベルのファイルパーミッション（0o600）で保護する
  - 根拠: permission-and-security — auth/index.ts と mcp/auth.ts で一貫して 0o600 を使用
- `[SHOULD]` AI エージェントの権限は「最小権限デフォルト + エージェント種別ごとのオーバーライド」で構成する
  - 根拠: permission-and-security — plan は edit deny、explore は read 系のみ allow
- `[SHOULD]` bash/shell 実行では文字列マッチングではなく AST レベルの構文解析でコマンドを識別する
  - 根拠: permission-and-security — tree-sitter で bash AST を解析しコマンドノード単位で権限チェック

## ルール優先度の解釈

- `[MUST]`: 違反するとバグ・セキュリティリスク・重大な設計劣化を招くルール
- `[SHOULD]`: 従うことで品質が向上するが、文脈によっては例外を許容するルール
- `[AVOID]`: 意図的に避けるべきアンチパターン・非推奨プラクティス
