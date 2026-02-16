# ryoppippi/ccusage — 導出ルール集

> 出典: repos/ryoppippi/ccusage/ | 生成日: 2026-02-16
> 用途: CLAUDE.md にそのまま貼り付けて AI コンテキストとして活用

## 型安全・スキーマ設計

- `[MUST]` 外部データ（ファイル・API レスポンス・ユーザー入力）は信頼境界で safeParse し、失敗時は例外ではなくスキップまたは Result で伝播する
  - 根拠: type-system-patterns — JSONL パース時に `v.safeParse` + 早期 return で不正行をスキップし、数千行の処理を1行の不正データで止めない
- `[MUST]` ドメインプリミティブ（ID・日付・パスなど）にブランド型を使う場合、対応するファクトリ関数を必ず提供し、`as` キャストによるバイパスを防ぐ
  - 根拠: type-system-patterns — 12 種のブランド型すべてに `create*` ファクトリを提供し、検証なしのブランド型生成を構造的に排除
- `[SHOULD]` スキーマ検証ライブラリの型導出（`z.infer` / `v.InferOutput`）を使い、スキーマと型定義を単一ソースから生成する
  - 根拠: type-system-patterns — UsageData, ModelBreakdown 等すべての集約型をスキーマから導出し、型とバリデーションの乖離を構造的に防止
- `[SHOULD]` union 型の分岐には exhaustiveness check（`unreachable(value: never)`）を配置し、分岐の追加漏れをコンパイル時に検出する
  - 根拠: data-processing-patterns — CostMode の3分岐後に `unreachable(mode)` を置くことで新モード追加時にコンパイルエラーで検知
- `[SHOULD]` `as const satisfies Type` パターンでリテラル定数を定義し、値の配列から union 型を自動導出する（単一情報源の原則）
  - 根拠: dev-conventions — `CostModes`, `SortOrders` 等で配列定義 → 型導出の一貫したパターン
- `[AVOID]` テストコードであってもブランド型を `as` キャストで生成する。ファクトリ関数を経由させることで、検証ロジック変更時にテストも壊れるようにする
  - 根拠: type-system-patterns — キャストによるバイパスは検証ルール変更がテストに反映されないリスクを生む

## エラーハンドリング

- `[MUST]` throw する可能性のある操作は Result.try() でラップし、戻り値を Result 型にする。ただしプロセス境界（子プロセス呼び出し、ストリーム I/O）は try-catch を許容する
  - 根拠: error-handling-idioms — JSON パース・ファイル読み込み・API フェッチを一律 Result.try() でラップし、MCP サーバーのプロセス間通信のみ try-catch
- `[MUST]` Result.unwrap() でデフォルト値を使う場合は Result.inspectError() でエラーログを残し、サイレント失敗を防止する
  - 根拠: error-handling-idioms — ログなしの `unwrap(0)` はコスト計算エラーの追跡が困難になる
- `[SHOULD]` ループ内で失敗しうるパース処理は `if (Result.isFailure(result)) continue;` の早期スキップパターンを使い、正常パスのネストを浅く保つ
  - 根拠: error-handling-idioms — 3つの data-loader で同一パターンが実装され、正常パスのインデントが1段浅い
- `[SHOULD]` 複数の失敗しうる操作を連鎖させる場合は Result.pipe() で合成し、エラーの伝播と変換を宣言的に記述する
  - 根拠: error-handling-idioms — 7段階の操作チェーンを一つの式として記述し、各段階のエラーハンドリングが明示的
- `[AVOID]` Result.unwrap() をログなしで使いデフォルト値でエラーを握りつぶすこと。デフォルト値が業務的に妥当かどうかの判断なしに使うと計算結果の信頼性が損なわれる
  - 根拠: error-handling-idioms — inspectError なしの `unwrap(0)` でコスト計算エラーが検知不可能になる事例

## モジュール設計・API 境界

- `[MUST]` パッケージの公開 API は package.json の `exports` フィールドで明示的に列挙し、内部モジュールへの直接アクセスを禁止する
  - 根拠: code-organization — 5 エントリのみ公開し、14 の内部ファイルへのアクセスを構造的に防止
- `[MUST]` 内部ファイルを示す命名規則を採用したら、ビルド設定でもその規則を強制する（命名規則だけでは紳士協定に過ぎない）
  - 根拠: code-organization — tsdown の entry 設定で `!./src/_*.ts` を指定し、ビルド成果物への混入を機械的に防止
- `[MUST]` monorepo で共有するコードは表現層（フォーマット・UI）とインフラ層（ロガー・設定）に限定し、ドメイン固有のデータ変換・スキーマはアプリ側に保持する
  - 根拠: abstraction-patterns — データソースが異なるアプリで data-loader を共有すると過度な抽象化になる
- `[SHOULD]` 共有パッケージは単一エントリポイントではなく、機能別の subpath exports で公開する
  - 根拠: code-organization — `./pricing`, `./logger` 等のサブパスで消費者が必要な機能だけを import 可能
- `[SHOULD]` エクスポートは「実際に他モジュールから使われているもの」のみに限定し、公開 API 表面積を最小化する
  - 根拠: code-organization — 未使用エクスポートの蓄積は内部リファクタリングの自由度を損なう
- `[AVOID]` monorepo 内の共有パッケージ間に相互依存を作ること。依存の方向は apps -> packages の一方向に保つ
  - 根拠: architecture — 全 apps が一方向に packages を参照する構造で循環依存を防止

## 依存管理・サプライチェーン

- `[MUST]` monorepo の依存バージョンは一元管理する仕組み（pnpm catalogs, Renovate config 等）で統一し、パッケージごとの個別バージョン指定を禁止する
  - 根拠: dependency-management — `catalogMode: strict` で 153 箇所の依存参照を一元化し、バージョン不整合を構造的に排除
- `[MUST]` バンドル配布される CLI/アプリでは runtime ライブラリを `devDependencies` に配置し、`dependencies` を空にする
  - 根拠: dependency-management — バンドラが依存を内包するため `dependencies` は不要。消費者のインストールサイズ最小化
- `[SHOULD]` 依存パッケージのビルドスクリプト実行は allowlist 方式で制御し、ネイティブモジュール等の必須パッケージのみ明示的に許可する
  - 根拠: dependency-management — `strictDepBuilds: true` + `allowBuilds` で 4 パッケージのみ許可
- `[SHOULD]` サプライチェーンセキュリティは単一の設定に頼らず、ビルド制限・レジストリ制限・バージョン制限・時間制限の複数層で構成する
  - 根拠: dependency-management — 4 設定を組み合わせた多層防御
- `[SHOULD]` `prepack` でビルドとメタデータ最適化を行い、公開物に `devDependencies`・`scripts` 等の開発用フィールドを含めない
  - 根拠: dependency-management — `clean-pkg-json` で公開パッケージのサイズ削減とセキュリティ向上
- `[AVOID]` 新規リリースを即座にインストール可能な状態にすること。`minimumReleaseAge` で待機期間を設け、悪意あるリリースの検出時間を確保する
  - 根拠: dependency-management — 48 時間の待機期間で即時適用リスクを排除

## ビルド・ツールチェイン

- `[MUST]` npm パッケージのビルド設定に publint（パッケージ互換性チェック）を統合し、ビルド時点で exports/types/main の不整合を検出する
  - 根拠: build-and-tooling — 全 6 アプリで `publint: true` が設定されCIの前段階で品質ゲートが機能
- `[SHOULD]` TypeScript パッケージで開発時の `.ts` 直接実行と publish 時の `.js` 配布を両立するには、`exports` と `publishConfig.exports` の二重定義を使う
  - 根拠: build-and-tooling — 開発 DX と公開品質の両立
- `[SHOULD]` CLI ツールのバンドルでは完全な minify ではなく DCE（Dead Code Elimination）のみを適用し、エラー時のスタックトレースの可読性を維持する
  - 根拠: build-and-tooling — `minify: 'dce-only'` でバンドルサイズ削減とデバッグのバランス
- `[SHOULD]` ビルド時に外部データを埋め込む場合、フェッチ失敗時のフォールバックを必ず実装し、オフライン環境でもビルドが成功するようにする
  - 根拠: build-and-tooling — 全マクロファイルで try/catch + 空データ返却のフォールバック
- `[AVOID]` monorepo 内の tsconfig.json に共通設定を重複して記述すること。共通オプションは `tsconfig.base.json` に抽出し `extends` で参照する
  - 根拠: build-and-tooling — 9 つの tsconfig.json に同一設定が重複し設定変更時のメンテナンスコストが高い

## テスト

- `[MUST]` in-source testing を採用する場合、ビルドツールの `define` オプションで `import.meta.vitest` を `undefined` に置き換え、テストコードがプロダクションバンドルに含まれないことを保証する
  - 根拠: testing-practices — tsdown の `define` と vitest の `includeSource` の 2 層で保証
- `[MUST]` ファイルシステムに依存するテストでは、一時ディレクトリのクリーンアップを `await using`（Explicit Resource Management）に委ねる -- 手動の `afterEach` は漏れのリスクがある
  - 根拠: testing-practices — 120 以上の `await using fixture` 呼び出しすべてで自動破棄、手動 `afterEach` は一切なし
- `[SHOULD]` テストのファイルシステムセットアップは宣言的記法（オブジェクトリテラル → ディレクトリ構造）で記述し、手続き的チェーンを避ける
  - 根拠: testing-practices — `createFixture({ ... })` の宣言的記法でテストの Arrange セクションの意図が明確
- `[AVOID]` in-source testing で動的インポート（`await import()`）を使用すること -- バンドラーの静的解析を阻害し、テスト専用依存がプロダクションバンドルに残るリスクがある
  - 根拠: testing-practices — tree-shaking の信頼性確保のため明示的に禁止

## CLI 設計

- `[MUST]` CLI のサブコマンド定義は宣言的に一箇所で完結させ、名前・引数・説明・実行関数を同じオブジェクトに凝集させる
  - 根拠: cli-framework-patterns — 20 以上のコマンドが `define({ name, description, args, run })` で統一
- `[MUST]` enum 的な CLI 引数の選択肢は `as const` 配列で一度だけ定義し、型とランタイム値の両方をその配列から導出する（単一情報源の原則）
  - 根拠: cli-framework-patterns — 選択肢の不整合を型レベルで防止
- `[SHOULD]` 複数サブコマンドで共通する引数はオブジェクトリテラルとして分離し、スプレッド構文で継承・拡張する。不要な引数は destructuring で除外する
  - 根拠: cli-framework-patterns — 引数定義の重複を排除しつつ柔軟性を維持
- `[SHOULD]` CLI に設定ファイルを導入する場合、「CLI 明示引数 > コマンド固有設定 > グローバルデフォルト > フレームワークデフォルト」の優先度階層を設け、CLI パーサーの tokens から「明示的に渡された引数」を判定する
  - 根拠: cli-framework-patterns — tokens 解析で明示引数と暗黙デフォルトを区別する手法

## データ処理

- `[MUST]` JSONL/CSV など行指向ログファイルの解析では、不正行をサイレントスキップし、パイプライン全体を停止させない
  - 根拠: data-processing-patterns — 追記ログは途中破損が日常的に起こるため、全解析で safeParse + continue
- `[SHOULD]` 時系列データの多段集約は「下位粒度を先に確定 → 上位粒度で再集約」の階層パターンで実装する
  - 根拠: data-processing-patterns — 日次データを先に構築し月次・週次は日次を入力として再集約。各階層が独立テスト可能
- `[SHOULD]` 外部データソース（API 価格、為替レート等）にはキャッシュ + オフラインフォールバック + Disposable によるライフサイクル管理を適用する
  - 根拠: data-processing-patterns — メモリキャッシュ → ネットワーク → ビルド時プリフェッチの3段フォールバック
- `[SHOULD]` 複合グルーピングキーには NUL 文字（`\x00`）など通常データに出現しない文字をセパレータに使う
  - 根拠: data-processing-patterns — `date\x00project` で日付やプロジェクト名に含まれる `-` や `/` との衝突を回避

## AI 開発支援

- `[MUST]` monorepo では ルート CLAUDE.md に横断的ルールを集約し、各パッケージの CLAUDE.md にはそのパッケージ固有の知識のみを記述する
  - 根拠: ai-settings — 10 個の CLAUDE.md でルート 310 行に全体方針、各パッケージは 40-120 行の固有情報に限定
- `[MUST]` AI エージェントが過去に繰り返したミスは `CRITICAL`/`NEVER`/`ALWAYS` のマーカー付きで CLAUDE.md に明示的に禁止事項として記載する
  - 根拠: ai-settings — 動的 import 禁止・console.log 禁止をマーカー付きでガードレール化
- `[MUST]` 複数の AI エージェントを併用する場合、`AGENTS.md -> CLAUDE.md` のシンボリックリンクで単一ソースを共有する
  - 根拠: ai-settings — 4 つの apps で AGENTS.md シンボリックリンクを採用しマルチエージェント対応を単一ファイルで実現
- `[SHOULD]` AI が頻繁に参照するライブラリのドキュメントは npm パッケージ化し、専用カテゴリ（例: `llm-docs`）として管理する
  - 根拠: ai-settings — `@gunshi/docs`・`@praha/byethrow-docs` を `catalog:llm-docs` で管理
- `[SHOULD]` CLAUDE.md の末尾に AI 専用の「Tips」セクションを設け、利用可能な MCP サーバー・skills・重要な禁止事項を簡潔にまとめる
  - 根拠: ai-settings — AI が最後に読むコンテキストとして行動指針を強化
- `[SHOULD]` コード変更後に実行すべき検証コマンド（lint, typecheck, test）を CLAUDE.md に明記し、並列実行可能かどうかも指定する
  - 根拠: ai-settings — AI エージェントの変更後ワークフローを標準化

## コード規約・スタイル

- `[MUST]` `verbatimModuleSyntax` を有効にし、`import type` と `import` を構文レベルで分離する
  - 根拠: dev-conventions — tree-shaking の正確性とバンドルサイズの最適化に寄与
- `[MUST]` ESLint で `no-console` ルールを有効にし、ログ出力は構造化ロガー経由に統一する
  - 根拠: dev-conventions — consola ベースのタグ付きロガーで LOG_LEVEL 環境変数によるランタイム制御
- `[SHOULD]` monorepo の commit scope はディレクトリ構造と 1:1 で対応させる
  - 根拠: dev-conventions — commit 履歴からどのパッケージが変更されたかを機械的に追跡可能
- `[AVOID]` リンタにフォーマッティングルールを混在させる。フォーマットは専用ツールに委譲し、ESLint は `stylistic: false` で論理ルールに集中させる
  - 根拠: dev-conventions — ESLint と oxfmt の関心分離で設定の肥大化を防止

## ルール優先度の解釈

- `[MUST]`: 違反するとバグ・セキュリティリスク・重大な設計劣化を招くルール
- `[SHOULD]`: 従うことで品質が向上するが、文脈によっては例外を許容するルール
- `[AVOID]`: 意図的に避けるべきアンチパターン・非推奨プラクティス
