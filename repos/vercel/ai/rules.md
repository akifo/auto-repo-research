# vercel/ai -- 導出ルール集

> 出典: repos/vercel/ai/ | 生成日: 2026-02-20
> 用途: CLAUDE.md にそのまま貼り付けて AI コンテキストとして活用

## 型安全性・インターフェース設計

- `[MUST]` パッケージ境界を超えるエラー判定には `instanceof` ではなく `Symbol.for()` ベースのマーカーパターンと `static isInstance()` 型ガードを使う
  - 根拠: error-handling-idioms — AI SDK は 35 以上のエラークラスすべてでこのパターンを採用し、パッケージバージョン不一致問題を構造的に解決している
- `[MUST]` 判別共用体の判別フィールドはリテラル型の union で定義する — `string` 全体を許容すると型絞り込みが機能しない
  - 根拠: type-system-patterns — `LanguageModelV3StreamPart` は `type` フィールドに 15 以上のリテラル型を使い、switch/case で型安全に分岐している
- `[SHOULD]` バージョン付きインターフェースにはリテラル型の `specificationVersion` フィールドを含め、discriminated union として扱えるようにする
  - 根拠: architecture, design-philosophy — v2/v3 をリテラル型で区別し、Proxy ベースのアダプタで透過的に変換。コアは最新バージョンのみを扱う設計
- `[SHOULD]` 複数のスキーマライブラリをサポートする場合、union 型 + 条件付き推論型（`InferSchema<T>`）で統一的な抽象層を作る
  - 根拠: schema-validation-patterns — `FlexibleSchema` が Zod 3/4、Standard Schema、JSON Schema を統合し、一貫した型推論を提供
- `[SHOULD]` テンプレートリテラル型で文字列 ID のフォーマットをコンパイル時に検証する
  - 根拠: type-system-patterns — `ProviderRegistryProvider` が `${KEY}${SEPARATOR}${modelId}` 形式を型レベルで強制
- `[SHOULD]` 排他的パラメータは `never` 型で型レベルの排他制約を設け、加えてランタイムバリデーションで多層防御する
  - 根拠: api-design-practices — `Prompt` 型が `prompt?: never` / `messages?: never` の union で排他性を表現
- `[SHOULD]` ジェネリクスの推論ソースを制御するために `NoInfer<T>` を使い、意図しないパラメータから型が推論されることを防ぐ
  - 根拠: api-design-practices — `generateText` の `toolChoice`, `activeTools` 等が `NoInfer<TOOLS>` を使い、`tools` のみを推論元にしている
- `[SHOULD]` 列挙型のモデル ID にはリテラルユニオン + `(string & {})` を使い、IDE 補完と将来の拡張性を両立する
  - 根拠: adapter-implementation-patterns — 30+ プロバイダーの全モデル ID 型がこのパターンを採用

## エラーハンドリング・バリデーション

- `[MUST]` 外部入力の JSON パースにはプロトタイプ汚染対策済みのラッパーを使用し、`JSON.parse` の直接呼び出しを禁止する
  - 根拠: design-philosophy, schema-validation-patterns — `secureJsonParse` で `__proto__` / `constructor.prototype` を検出・排除し、コードベース全体で `JSON.parse` 直接使用を排除
- `[MUST]` catch ブロックでエラーをラップする際は、既知のエラー型を `isInstance` で判定し再スローしてから、未知のエラーのみをラップする
  - 根拠: error-handling-idioms — `parseJSON`, `download` 等で一貫して使われ、エラーの二重ラップを防止
- `[SHOULD]` 失敗が想定内の操作（パース・バリデーション等）には、例外を投げる版と Result 型を返す safe 版を対で提供する
  - 根拠: error-handling-idioms, schema-validation-patterns — `parseJSON` / `safeParseJSON`、`validateTypes` / `safeValidateTypes` が対で存在
- `[SHOULD]` エラークラスのコンストラクタは名前付きオブジェクト引数を取り、ドメイン固有のコンテキスト情報を `readonly` プロパティで公開する
  - 根拠: error-handling-idioms — `APICallError` の `url`, `statusCode`, `isRetryable` 等により、catch 側がプログラム的にリトライ等の制御を行える
- `[SHOULD]` 外部 API レスポンスの Zod スキーマではフィールドに `.nullish()` を使い、必要最小限のフィールドだけをスキーマに含める
  - 根拠: adapter-implementation-patterns — 30+ プロバイダーが全てこのパターンを採用し、API 仕様変更への耐性を最大化
- `[SHOULD]` 不完全な入力（LLM 出力等）に対してはパース → 自動修復 → 外部修復の多段階パイプラインを設ける
  - 根拠: schema-validation-patterns — `fixJson`（ルールベース修復） → `repairText`（外部コールバック修復）の多段階リカバリーを実装
- `[AVOID]` `JSON.parse` をライブラリコード内で直接呼び出す — セキュアパーサーまたは `safeParseJSON` を経由すべき
  - 根拠: error-handling-idioms — AI SDK の実行コードでは `JSON.parse` の直接呼び出しはゼロ

## ストリーミング・非同期処理

- `[MUST]` ReadableStream に AsyncIterable を実装する際は `pipeThrough(new TransformStream())` で新しいストリームを生成してからイテレータを付与する — 元のストリームに直接 reader を取得するとロック競合が発生する
  - 根拠: streaming-and-async-patterns — `createAsyncIterableStream` で必ず pipeThrough を挟んでいる
- `[MUST]` ストリームの AsyncIterator 実装では `return()` と `throw()` で必ずリーダーの cancel と releaseLock を呼ぶ
  - 根拠: streaming-and-async-patterns — `for await...of` の break やエラーでリソースリークが発生する
- `[MUST]` TransformStream の `flush()` でストリーム完了時のファイナライゼーション（Promise resolve、コールバック呼び出し）を実行する
  - 根拠: streaming-and-async-patterns — flush がないと最終状態の通知が漏れる
- `[SHOULD]` ストリームの最終結果を Promise で公開する場合は Lazy Promise（アクセス時に構築）を使い、未アクセス時の unhandled rejection を防ぐ
  - 根拠: streaming-and-async-patterns, performance-techniques — `DelayedPromise` で Promise 生成を `.promise` アクセスまで遅延
- `[SHOULD]` 複数の AbortSignal を扱う場合は新しい AbortController に集約し、任意のソースからのキャンセルを統一的にハンドリングする
  - 根拠: streaming-and-async-patterns — `mergeAbortSignals` で複数シグナルを一つに統合
- `[SHOULD]` ストリームの変換は単一責務の TransformStream を `.pipeThrough()` で直列に接続し、各変換を独立にテスト・差し替え可能にする
  - 根拠: streaming-and-async-patterns — `stream.pipeThrough(outputTransform).pipeThrough(eventProcessor)` チェーン
- `[AVOID]` ストリームを生成して消費しないまま放置する — バックプレッシャーによりプロデューサー側が停止し、Promise が永久に resolve しない
  - 根拠: streaming-and-async-patterns — get アクセス時に `consumeStream()` を呼ぶ防御策が入っている

## API 設計・拡張性

- `[MUST]` 公開 API に不安定な機能を追加する際は、命名規約によるプレフィックス（`experimental_`）で安定度を明示し、安定化時にはプレフィックスなし版を追加して旧名を `@deprecated` にする
  - 根拠: api-design-practices, extensibility-mechanisms — 全 experimental_ API がこのパターンに従い、ポリシーとして明文化
- `[SHOULD]` プラグイン固有の拡張パラメータは、コアインターフェースに名前空間付きの汎用フィールド（`Record<string, JSONObject>` 型）を設け、プラグイン側でスキーマ検証する
  - 根拠: design-philosophy, architecture — `providerOptions` でプロバイダー名をキーとした名前空間により衝突を防ぎ、各プロバイダーが Zod スキーマで検証
- `[SHOULD]` 同一ドメインの同期/ストリーミング API はオプション構造と結果型のプロパティ名を統一し、モード切り替え時の学習コストを最小化する
  - 根拠: api-design-practices — `generateText` と `streamText` が `CallSettings & Prompt` を共有し、結果型も統一
- `[SHOULD]` ユーザーに直接呼ばれるべきでない低レベルメソッドには、不自然なプレフィクス（`do-`、`_`、`internal-` 等）を付けて誤用を抑止する
  - 根拠: design-philosophy, abstraction-patterns — `doGenerate` / `doStream` の `do` プレフィクスで内部 API であることを命名から明確にしている
- `[SHOULD]` ミドルウェアの戻り値型を元のモデルインターフェースと同一に保ち、ラップが透過的に動作するようにする
  - 根拠: extensibility-mechanisms — `wrapLanguageModel` は `LanguageModelV3` を返すため、利用側はミドルウェアの有無を意識しない
- `[SHOULD]` サポートしない機能は例外ではなく警告で報告し、処理を続行する（グレースフルデグラデーション）。ただし、未サポートのモデルタイプは専用エラー（`NoSuchModelError`）を throw する
  - 根拠: architecture — `warnings` 配列パターンでプロバイダー間の機能差を透過的に伝達。abstraction-patterns — 未サポート機能のサイレント無視は禁止
- `[SHOULD]` 高レベル API 関数には `_internal` パラメータで非決定的要素（ID 生成、現在時刻等）を注入できる接合点を設け、テスト容易性を確保する
  - 根拠: api-design-practices — `generateText`, `generateObject`, `streamText` が全て `_internal` パラメータを持つ
- `[SHOULD]` 仕様インターフェースの戻り値型は `Promise` ではなく `PromiseLike` にして、実装側の自由度を最大化する
  - 根拠: design-philosophy — `LanguageModelV3` の全メソッドが `PromiseLike` を返し、カスタム thenable も受け入れる

## パフォーマンス・バンドル

- `[MUST]` ライブラリの全パッケージの `package.json` に `"sideEffects": false` を設定して tree-shaking を有効化する
  - 根拠: performance-techniques — 全パッケージに一貫して `"sideEffects": false` を設定
- `[MUST]` ストリーミングレスポンスを Node.js の `ServerResponse` に書き込む際は、`write()` の戻り値を確認し、`false` なら `drain` イベントを待つ
  - 根拠: performance-techniques — バックプレッシャー制御がないとメモリが無制限に消費される
- `[SHOULD]` バンドルサイズを CI パイプラインで定量チェックし、閾値超過でビルドを失敗させる
  - 根拠: build-and-tooling, ci-cd — esbuild で minify + tree-shake 後のサイズを Node/Browser 両方で検証し、560KB 上限を強制
- `[SHOULD]` Edge Runtime / ブラウザ / Node.js の全環境で動作させるために、コアロジックでは Web 標準 API を使い、Node.js 固有 API は分離モジュールに閉じ込める
  - 根拠: performance-techniques — `create-text-stream-response.ts`（Web 標準）と `pipe-text-stream-to-response.ts`（Node.js 固有）が並行存在
- `[SHOULD]` 大規模レスポンスのダウンロードにはサイズ上限を設けて、`fetch().arrayBuffer()` の 2 倍メモリオーバーヘッドによる OOM を防止する
  - 根拠: performance-techniques — `readResponseWithSizeLimit` が Content-Length 早期拒否とストリーミング中サイズチェックの 2 段階で防止
- `[SHOULD]` スキーマの JSON Schema 変換は遅延評価（`lazySchema`）し、実際に必要になるまで計算コストを発生させない
  - 根拠: schema-validation-patterns — プロバイダーパッケージ全体で `lazySchema` が広く使用されている

## テスト

- `[MUST]` マルチランタイムをサポートする SDK では、同一テストスイートを各ターゲットランタイム環境で実行する設定を用意する
  - 根拠: testing-practices — 全 40+ パッケージで `vitest.edge.config.js` と `vitest.node.config.js` を分離
- `[SHOULD]` ジェネリクスを多用するライブラリでは `*.test-d.ts` ファイルで型推論の正しさを独立して検証する
  - 根拠: testing-practices — 13 の `test-d.ts` ファイルで `expectTypeOf` を使い、型回帰を検出
- `[SHOULD]` モノレポのテストユーティリティは独立パッケージとして切り出し、テストランナーとの統合は別エントリポイントで提供する
  - 根拠: testing-practices — `@ai-sdk/test-server` はコア（MSW ラッパー）と `with-vitest`（ライフサイクル統合）を分離
- `[SHOULD]` テストフィクスチャは実際の API レスポンスをキャプチャして作成し、手書きで模倣しない
  - 根拠: testing-practices — `saveRawChunks` ヘルパーと `contributing/testing.md` がキャプチャワークフローを標準化

## モノレポ・ビルド

- `[MUST]` モノレポのパッケージ間依存は DAG（有向非巡回グラフ）とし、tsconfig の references や package.json の dependencies で方向制約を表現する
  - 根拠: project-structure, architecture — `@ai-sdk/provider` の tsconfig references が空配列で最下層を保証、循環依存を型レベルで防止
- `[MUST]` モノレポ内のパッケージ間依存は `workspace:*` で統一し、パブリッシュ時にツール（Changesets 等）が実バージョンに置き換える
  - 根拠: dependency-management — 全 53 パッケージが `workspace:*` で内部依存を宣言
- `[MUST]` 同一カテゴリのパッケージ（プロバイダー等）は scripts, exports, dependencies のパターンを統一する
  - 根拠: project-structure — 30+ プロバイダーが同一の package.json 構造を持ち、テンプレート化を実現
- `[SHOULD]` モノレポ内の共有設定（tsconfig, eslint）は private ワークスペースパッケージとして配布し、各パッケージから `workspace:*` で参照する
  - 根拠: project-structure, build-and-tooling — `@vercel/ai-tsconfig` が 3 つのプリセットを提供し、50+ パッケージが extends で参照
- `[SHOULD]` パッケージの公開 API、内部 API、テストユーティリティは `exports` フィールドのサブパス（`.`, `./internal`, `./test`）で分離する
  - 根拠: project-structure — セマンティックバージョニングの対象を公開 API に限定しつつ、パッケージ間の内部共有を可能に
- `[SHOULD]` パッケージバージョンはビルド時に `define` で注入し、ランタイムで package.json を読み込まない。テスト環境用のフォールバック値を用意する
  - 根拠: build-and-tooling, dev-conventions — 40+ パッケージが `__PACKAGE_VERSION__` を tsup の define で注入し、`'0.0.0-test'` にフォールバック
- `[SHOULD]` ユーザー選択ライブラリ（UI フレームワーク、バリデーター等）は peerDependencies に配置し、devDependencies に pinned バージョンを併記する
  - 根拠: dependency-management — 全プロバイダーで zod を peerDependencies に範囲指定、devDependencies に固定バージョン

## CI/CD・品質ゲート

- `[MUST]` パフォーマンス指標（バンドルサイズ、ロード時間等）は CI の品質ゲートとして閾値付きで自動チェックする
  - 根拠: ci-cd — 560KB バンドルサイズ上限と 65-100ms ロード時間上限を CI で強制
- `[MUST]` CI マトリクスの結果を集約するファサードジョブを作り、そのジョブ名を branch protection の required check に指定する
  - 根拠: ci-cd — マトリクスのバリアント名は変動するため、ファサードジョブで安定化。<code v-pre>if: ${{ !cancelled() }}</code> を忘れない
- `[SHOULD]` フォーマッタとリンターの責務を分離し、ESLint config に `prettier`（eslint-config-prettier）を必ず含める
  - 根拠: dev-conventions — `extends: ['next', 'turbo', 'prettier']` で衝突を排除
- `[SHOULD]` changeset のバージョン制約はドキュメントだけでなく CI で機械的に検証する
  - 根拠: dev-conventions, ci-cd — `verify-changesets` ワークフローが changeset の frontmatter を解析し、patch 以外を自動拒否
- `[SHOULD]` pre-commit hook にはバイパス機構を設け、品質保証は CI を信頼源とする二層構造にする
  - 根拠: dev-conventions — `ARTISANAL_MODE` 環境変数でバイパス可能にし、CI で同等チェックを実行
- `[SHOULD]` 依存更新ツールのスケジュールを依存の種類（production / dev / infra）ごとに差分化する
  - 根拠: ci-cd, build-and-tooling — production deps は毎週、devDeps は月次、examples は四半期ごとに更新
- `[AVOID]` タスクランナーのキャッシュキーにビルド出力に影響しない環境変数（API キー等）を含める
  - 根拠: build-and-tooling — `turbo.json` の `build.env` に 60+ の API キーが列挙され、キー変更のたびにキャッシュが無効化される問題

## AI アシスタント設定

- `[MUST]` AI アシスタント設定ファイルに禁止事項を "Do Not" セクションとして明示的に列挙する
  - 根拠: ai-settings — AGENTS.md 末尾の "Do Not" セクションで AI がやりがちな誤りを防止
- `[SHOULD]` 複数の AI ツールを対象にする場合、1 つの正規ファイル（AGENTS.md）を作成し、他のファイル名（CLAUDE.md 等）はシンボリックリンクで対応する
  - 根拠: ai-settings — `CLAUDE.md -> AGENTS.md` のシンボリックリンクでファイル複製の同期問題を回避
- `[SHOULD]` AI アシスタント設定を階層構造（プロジェクト全体 → パッケージ → タスク）にし、ルートファイルは 300 行以下に抑える
  - 根拠: ai-settings — AGENTS.md を 285 行に抑え、詳細を skills/ と contributing/ に分離
- `[SHOULD]` 頻繁に変更される API を扱うプロジェクトでは、AI に内部知識を信用させず、ソースコードまたはドキュメントからの検証を強制する
  - 根拠: ai-settings — `use-ai-sdk/SKILL.md` が "Everything you know is outdated or wrong" と明示し、ドキュメント検索を必須ステップに

## ルール優先度の解釈

- `[MUST]`: 違反するとバグ・セキュリティリスク・重大な設計劣化を招くルール
- `[SHOULD]`: 従うことで品質が向上するが、文脈によっては例外を許容するルール
- `[AVOID]`: 意図的に避けるべきアンチパターン・非推奨プラクティス
