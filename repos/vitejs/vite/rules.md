# vitejs/vite — 導出ルール集

> 出典: repos/vitejs/vite/ | 生成日: 2026-02-17
> 用途: CLAUDE.md にそのまま貼り付けて AI コンテキストとして活用

## パッケージ設計・依存管理

- `[MUST]` セルフバンドルするツールでは dependencies / devDependencies の分類をバンドル境界に基づいて行う — dependencies にはユーザー環境で解決するパッケージのみ、devDependencies にはバンドルに取り込むパッケージを配置する
  - 根拠: project-structure / dependency-management — Vite は connect, ws 等のランタイム依存を devDependencies に置き Rolldown でバンドル、dependencies を6パッケージに抑制
- `[MUST]` パッケージの公開 API は `index.ts`（バレルファイル）で明示的に列挙し、`package.json` の `exports` フィールドと一致させる。内部パスは `null` でブロックする
  - 根拠: code-organization / project-structure — `"./types/internal/*": null` でモジュール解決レベルでアクセスを遮断
- `[MUST]` バンドルされた devDependencies の型をユーザーに公開する場合は、型定義をインライン化してビルド時にバリデーションする
  - 根拠: dependency-management / type-system-patterns — `src/types/` に型をインライン化し `validateChunkImports` で型リークを CI で検出
- `[SHOULD]` CLI ツールでは各サブコマンドの実行コードを `await import()` で遅延ロードし、未使用コードパスのロードコストをゼロにする
  - 根拠: performance-techniques / dependency-management — CLI は dev/build/preview 各コマンドで必要なモジュールのみを動的インポート
- `[SHOULD]` monorepo 内でもパッケージの複雑さに応じてビルドツールを使い分ける — 小規模パッケージにコアと同じ重量級ツールを強制しない
  - 根拠: project-structure / build-and-tooling — コアは Rolldown、create-vite / plugin-legacy は軽量な tsdown を使用
- `[SHOULD]` 外部パッケージの不具合修正には pnpm patches を使い、フォークを避ける
  - 根拠: project-structure — sirv, chokidar 等4パッケージにパッチ適用
- `[AVOID]` 薄いラッパーのために推移的依存が大きいパッケージを追加すること — 直接 API を使って数行のコードで済むなら、その方がサイズ・保守の両面で優れる
  - 根拠: design-philosophy / dependency-management — http-proxy-middleware（3MB）の代わりに http-proxy（380kB）+ 数行のカスタムコード

## 型システム

- `[MUST]` 公開型と内部型を物理的に分離し、内部型は公開 API に漏洩させない。`@internal` タグ付きメンバーがビルド成果物に残らないことを CI で検証する
  - 根拠: type-system-patterns — `types/`（公開）、`src/types/`（devDeps インライン）、`src/node/`（ソース型）の3層に分離
- `[MUST]` ユーザー入力型と解決済み型を分離する — 入力型は全フィールド optional、解決済み型は `Required<>` ベースとし、デフォルト注入と型変換を行う
  - 根拠: api-design-practices / type-system-patterns — UserConfig（optional）と ResolvedConfig（required）の明確な分離
- `[SHOULD]` switch 文の網羅性チェックに `satisfies never` を使い、列挙値追加時の分岐漏れをコンパイル時に検出する
  - 根拠: type-system-patterns — build.ts, config.ts, css.ts 等4箇所以上で使用
- `[SHOULD]` デフォルト値オブジェクトには `satisfies InterfaceName` を付与し、インターフェースとの乖離をコンパイル時に検出する
  - 根拠: type-system-patterns — configDefaults, buildEnvironmentOptionsDefaults 等で一貫使用
- `[SHOULD]` 型のみのインポートは `import type` を使い、ESLint の `consistent-type-imports` ルールで強制する
  - 根拠: code-organization / dev-conventions — バンドルサイズの意図しない増加を防止
- `[SHOULD]` 文字列リテラルの自動補完と任意文字列の受容を両立するには `'known' | (string & {})` パターンを使う
  - 根拠: type-system-patterns — CustomEventName や environments の Record キー型で採用
- `[AVOID]` `Omit` のキーを10個以上列挙する型定義 — 可読性が著しく低下し、キーの追加漏れリスクが増す
  - 根拠: type-system-patterns — ResolvedConfig は13個のキーを Omit しており見通しが悪い

## コード構成・モジュール設計

- `[MUST]` ランタイムが異なるコード（ブラウザ/Node.js/ユニバーサル）は物理的にディレクトリを分離し、tsconfig で依存方向を強制する
  - 根拠: code-organization / project-structure — client/, node/, shared/, module-runner/ を別ディレクトリとし各 tsconfig の include で制限
- `[SHOULD]` import 順序を ESLint ルールで強制し、依存の方向性を可読性に反映させる（builtin → external → internal → parent → sibling → index）
  - 根拠: code-organization / dev-conventions — import-x/order と sort-imports の組み合わせ
- `[SHOULD]` 共有レイヤーに実行環境固有の依存を混入させない — shared に置くユーティリティは純粋関数か環境非依存のロジックに限定する
  - 根拠: architecture — shared/utils.ts は純粋関数のみ、Node.js API は node/utils.ts に分離
- `[AVOID]` 1ファイルに複数の関心事を詰め込んで巨大化させること（目安: 500行超で分割を検討）
  - 根拠: code-organization — css.ts（3539行）や utils.ts（1793行）は関心事が混在

## エラーハンドリング

- `[MUST]` エラーメッセージには「何が起きたか」だけでなく「どうすればよいか」のヒントを含める
  - 根拠: error-handling-idioms — `Try adding it to optimizeDeps.exclude` のように解決策を提示
- `[MUST]` ユーザー向けのエラー表示では、表示機構自体の失敗に備えたフォールバックを用意する
  - 根拠: error-handling-idioms — エラーオーバーレイのロード失敗時に素の HTML でフォールバック表示
- `[SHOULD]` 複数の外部ツールからのエラーは共通の構造に正規化してから伝播させる
  - 根拠: error-handling-idioms — PostCSS, esbuild, LightningCSS 等のエラーを `{ message, loc, frame }` に統一
- `[SHOULD]` エラーメッセージにはソースツールのプレフィックスを付与する（例: `[postcss]`, `[lightningcss]`）
  - 根拠: error-handling-idioms — パイプライン上のどのステージでエラーが発生したかを即座に特定
- `[SHOULD]` 正常フローの一部として期待されるエラーはログ出力を抑制する
  - 根拠: error-handling-idioms — ERR_OUTDATED_OPTIMIZED_DEP はログを出さず 504 を返すだけ
- `[AVOID]` シリアライズ時にエラーオブジェクトをそのまま JSON 化する — 必要最小限のプロパティだけを抽出する
  - 根拠: error-handling-idioms — prepareError で巨大な参照を持つエラーから必要情報のみ抽出

## パフォーマンス

- `[MUST]` 並行リクエストの重複排除（Promise Coalescing）を行う場合、キャッシュされた結果の有効性を検証する仕組みを組み合わせること
  - 根拠: performance-techniques / concurrency-patterns — `_pendingRequests` の結果を返す前に lastInvalidationTimestamp と比較
- `[MUST]` 投機的先行処理（プリフェッチ・プリウォーム等）のエラーは呼び出し元に伝搬せず、サイレントに処理するか警告レベルのログに留めること
  - 根拠: performance-techniques — warmupRequest は期待されるエラーを catch し予期しないエラーはログのみ
- `[SHOULD]` ホットパスのデバッグ・計測コードは条件付き実行で完全にゼロコスト化する — `const start = debug ? performance.now() : 0` + `debug?.()` パターン
  - 根拠: performance-techniques — 全 transform/resolve/load パスで計測呼び出しを条件付き回避
- `[SHOULD]` パフォーマンスに影響するバンドルサイズには CI で自動ガードレールを設ける — 閾値超過をビルドエラーにする
  - 根拠: design-philosophy / build-and-tooling — module-runner に 54kB 上限を bundleSizeLimit プラグインで設定
- `[SHOULD]` 短時間に連続する同種の操作は debounce で batch 化し、処理回数を最小化する
  - 根拠: performance-techniques / concurrency-patterns — 依存オプティマイザは100ms の debounce で新依存の発見を待つ
- `[SHOULD]` HTTP レスポンスのキャッシュ戦略は、不変コンテンツには `immutable`、変更可能コンテンツには `no-cache` + ETag の二分法を適用する
  - 根拠: performance-techniques — プリバンドル済み依存に immutable、ユーザーコードに no-cache + ETag
- `[AVOID]` 変更検出時にモジュールグラフ全体を一括無効化すること — 影響範囲を追跡し、変更が波及しないモジュールの結果を保持する
  - 根拠: performance-techniques — ソフト無効化でインポートタイムスタンプのみ更新し完全な再変換を回避

## 並行処理

- `[MUST]` 複数リソースのクリーンアップ処理では `Promise.all` ではなく `Promise.allSettled` を使う — 一部の失敗が他のクリーンアップを妨げてはならない
  - 根拠: concurrency-patterns — サーバーシャットダウンで watcher, WebSocket, 環境, HTTP サーバーを並行クローズ
- `[SHOULD]` 長時間実行される非同期処理には `{ cancel, result }` 構造でキャンセル機能を持たせる
  - 根拠: concurrency-patterns — 依存スキャン・最適化に cancel() メソッドを装備
- `[SHOULD]` 同一イベントループターン内の複数更新は、マイクロタスクバッファリングで1回の処理にまとめる
  - 根拠: concurrency-patterns — HMR クライアントの queueUpdate で `await Promise.resolve()` によるバッチ境界
- `[AVOID]` ファイル監視イベント直後のファイル読み取りを無条件に信頼すること — 空結果に対するリトライ戦略が必要
  - 根拠: concurrency-patterns — readModifiedFile は空バッファ時に mtime ポーリングでリトライ

## プラグイン・拡張設計

- `[MUST]` プラグインパイプラインで「全プラグインが順次処理する」フックと「最初の非 null 結果で停止する」フックを明確に区別する
  - 根拠: architecture / extensibility-mechanisms — resolveId（hookFirst）と transform（hookSequential）で実装を明確に分離
- `[MUST]` フックが関数形式とオブジェクト形式の両方をとりうる場合、ハンドラ取得を統一するユーティリティを用意する
  - 根拠: abstraction-patterns / extensibility-mechanisms — getHookHandler が全フック呼び出し箇所で共通利用
- `[MUST]` マルチ環境・マルチテナントで共有されるプラグインの状態は、WeakMap で環境ごとに分離する
  - 根拠: architecture / abstraction-patterns — perEnvironmentState が6箇所以上の内部プラグインで使用
- `[SHOULD]` プラグインの実行順序制御を「大分類（enforce）」と「フック単位（order）」の2層で設計する
  - 根拠: architecture / extensibility-mechanisms — enforce でプラグイン全体の位置、order で個別フックの順序を制御
- `[SHOULD]` プラグインのフィルタリング機構を提供し、不要なフック呼び出しを早期スキップする
  - 根拠: extensibility-mechanisms / performance-techniques — filter オプションと getCachedFilterForPlugin で WeakMap キャッシュ
- `[SHOULD]` プラグイン配列の型定義で falsy 値と Promise とネストを許容し、条件分岐を宣言的に記述可能にする
  - 根拠: extensibility-mechanisms / api-design-practices — PluginOption 型が false | null | undefined | PluginOption[] を含む
- `[SHOULD]` 設定マージ関数は「プラグイン間の合成」と「デフォルト値の適用」を別関数として提供する
  - 根拠: abstraction-patterns — mergeConfig（結合型）と mergeWithDefaults（フォールバック型）の明示的分離

## API 設計・後方互換

- `[MUST]` 非推奨 API は削除せず動作を維持しつつ、実行時に警告を発行する — 警告には移行先のドキュメント URL を含める
  - 根拠: api-design-practices / migration-patterns — warnFutureDeprecation で警告メッセージ、ドキュメント URL、スタックトレースを提供
- `[MUST]` 破壊的変更にはマイグレーションパスを必ず用意する（自動変換レイヤー、互換 Proxy、移行ガイドのいずれか）
  - 根拠: migration-patterns — convertEsbuildConfigToOxcConfig と setupRollupOptionCompat で自動変換を提供
- `[SHOULD]` 型安全なアイデンティティ関数（defineConfig パターン）を設定 API に提供する — 実行時コストゼロで IDE 補完が得られる
  - 根拠: api-design-practices — defineConfig は return config するだけで6つのオーバーロードで正確な型推論
- `[SHOULD]` API のライフサイクルを experimental → 安定 → future → legacy → 削除の段階で管理し、設定オブジェクトの名前空間として構造化する
  - 根拠: api-design-practices / migration-patterns — ExperimentalOptions, FutureOptions, LegacyOptions で型レベル管理
- `[SHOULD]` 新しいオプションを追加する前に「スマートデフォルトで解決できないか」「プラグインで対処できないか」を検証する
  - 根拠: design-philosophy — CONTRIBUTING.md の "Think Before Adding Yet Another Option"
- `[AVOID]` 旧 API と新 API を独立した実行パスとして維持すること — 旧設定を新設定に変換し実行パスを一本化する
  - 根拠: migration-patterns — esbuild 設定を oxc に変換後、oxc のみを参照する設計

## テスト

- `[MUST]` E2E テストの非同期アサーションにはポーリングベースの検証（`expect.poll` 等）を使い、固定 sleep に依存しない
  - 根拠: testing-practices — expect.poll() を全 playground テストで一貫使用
- `[MUST]` ファイル編集を伴うテストではソースの隔離コピー上で操作し、テスト完了後に元のソースが汚染されない設計にする
  - 根拠: testing-practices — vitestGlobalSetup.ts が playground を playground-temp/ にコピー
- `[SHOULD]` 同一テストスイートを複数のモード（dev/build 等）で実行する場合、環境変数によるモード切り替え + テスト内条件分岐で実現しテストコードの重複を最小化する
  - 根拠: testing-practices — VITE_TEST_BUILD 1つで serve/build を切り替え
- `[SHOULD]` テスト用ポート番号は集中管理ファイルで一元定義し、並列実行時の衝突を防ぐ
  - 根拠: testing-practices — test-utils.ts で全 playground のポートを一箇所で管理
- `[SHOULD]` サーバーのログ出力はインメモリロガーで捕捉し、テストから警告・エラーの発生有無を検証する
  - 根拠: testing-practices — createInMemoryLogger でサーバーログを配列に蓄積しアサーション可能に

## セキュリティ

- `[MUST]` 開発サーバーの CORS デフォルトは localhost 系オリジンのみ許可する正規表現にする（全許可にしない）
  - 根拠: security-practices — defaultAllowedOrigins で localhost/127.0.0.1/[::1] のみ許可
- `[MUST]` セキュリティトークンの比較には `crypto.timingSafeEqual` を使用する（`===` で比較しない）
  - 根拠: security-practices — WebSocket トークン検証でタイミング攻撃を防止
- `[MUST]` セキュリティ系ミドルウェアの登録順序は「入力バリデーション → アクセス制御 → レスポンスヘッダー付与」の順にする
  - 根拠: security-practices — rejectInvalid → rejectNoCors → cors → hostValidation の順で登録
- `[SHOULD]` 開発サーバーでもファイルアクセスの deny リストをデフォルトで設定する（`.env`、秘密鍵、`.git` 等）
  - 根拠: security-practices — server.fs.deny のデフォルトで .env, *.{crt,pem}, **/.git/** をブロック

## 開発規約・CI/CD

- `[MUST]` ESLint の `eslint-disable` コメントには禁止理由を添える（`-- reason` 形式）
  - 根拠: dev-conventions — `// eslint-disable-next-line no-console -- logger cannot be used here`
- `[MUST]` publish ワークフローでは GITHUB_TOKEN の権限を最小限に設定し、GitHub Environment による承認ゲートを設ける
  - 根拠: ci-cd — permissions: { contents: read, id-token: write } と environment: Release の組み合わせ
- `[MUST]` サードパーティ GitHub Action はコミット SHA でピン留めし、自動更新する
  - 根拠: ci-cd — 全サードパーティ Action を SHA ピン留めし Renovate の pinDigests: true で更新
- `[SHOULD]` ESLint の flat config で名前付きブロック（name プロパティ）を使い、ルールの適用範囲ごとにレイヤーを分離する
  - 根拠: dev-conventions — 'vite/globals', 'disables/playground' 等の命名規則で15+ のブロックを管理
- `[SHOULD]` プロダクションコードでは `console.*` を ESLint で禁止し、ロギングを専用の Logger モジュールに集約する
  - 根拠: dev-conventions — no-console: error で禁止し logger.ts に集約
- `[SHOULD]` マトリクステストの結果を集約するゲートジョブを定義し、branch protection はゲートジョブのみを必須にする
  - 根拠: ci-cd — test-passed / test-failed パターンでマトリクスサイズ変動に対応
- `[SHOULD]` publish/release 系ワークフローでは依存パッケージのインストールスクリプトを無効化する
  - 根拠: ci-cd — onlyBuiltDependencies = [] で全 postinstall を無効化しサプライチェーン攻撃面を最小化
- `[AVOID]` テスト・playground に本番コード同等の ESLint 厳格度を適用する — 役割に応じて段階的に緩和する
  - 根拠: dev-conventions — playground では explicit-module-boundary-types, no-unused-vars 等を全て off
- `[AVOID]` publish ワークフローで依存パッケージのキャッシュを有効にする
  - 根拠: ci-cd — publish と preview-release で明示的にキャッシュを無効化し cache poisoning を防止

## ルール優先度の解釈

- `[MUST]`: 違反するとバグ・セキュリティリスク・重大な設計劣化を招くルール
- `[SHOULD]`: 従うことで品質が向上するが、文脈によっては例外を許容するルール
- `[AVOID]`: 意図的に避けるべきアンチパターン・非推奨プラクティス
