# openclaw/openclaw — 導出ルール集

> 出典: repos/openclaw/openclaw/ | 生成日: 2026-02-14
> 用途: CLAUDE.md にそのまま貼り付けて AI コンテキストとして活用

## 型安全性とスキーマ設計

- `[MUST]` ランタイムバリデーションスキーマと TypeScript 型は同一の定義から導出する（`Static<typeof>` / `z.infer<typeof>` を使う）。手動で型を定義してスキーマと別管理すると、乖離がランタイムエラーの温床になる
  - 根拠: type-system-patterns — 241行にわたり全プロトコル型を `Static<typeof Schema>` で導出し、型とバリデーションの乖離をゼロにしている
- `[MUST]` 外部システム（LLM API、モバイルクライアント等）に渡すスキーマの制約は、ヘルパー関数に封じ込めてプロジェクト全体で共有する。制約の個別対応はコードベース全体に不整合を生む
  - 根拠: type-system-patterns — `stringEnum` ヘルパーが 17 以上のツール定義ファイルで一貫して使用されている
- `[SHOULD]` バリデーションライブラリは用途（外部プロトコル / 内部設定 / コード生成）ごとに選択し、1 つのライブラリに統一しようとしない
  - 根拠: type-system-patterns — TypeBox（JSON Schema 互換）と Zod（TypeScript ネイティブ高度バリデーション）を明確に使い分けている
- `[SHOULD]` 設定スキーマに機密フィールドのメタデータを宣言的に付与し、公開時のリダクトを自動化する
  - 根拠: type-system-patterns / security-practices — `.register(sensitive)` パターンで秘匿対象の追加がスキーマ変更 1 箇所で完結する
- `[AVOID]` LLM に渡すツールスキーマで JSON Schema の `anyOf` / `oneOf` / `allOf` を使うこと。プロバイダーによって拒否される
  - 根拠: type-system-patterns / ai-settings — Claude API（Vertex AI）と OpenAI が実際に拒否するケースが確認されている

## API 設計

- `[MUST]` API ハンドラはロジック実行前の最初の処理としてスキーマバリデーションを実行し、失敗時はエラーコード付きの構造化エラーを返す
  - 根拠: api-design-practices — 全 30 以上のハンドラが冒頭バリデーション + `errorShape(ErrorCodes.INVALID_REQUEST, ...)` パターンを一貫して実装している
- `[MUST]` 副作用を持つ API エンドポイントには冪等性キーを必須パラメータとして設計し、重複実行を防ぐ
  - 根拠: api-design-practices — 全副作用メソッドに `idempotencyKey` が必須で、dedupe Map によるインフライト共有を実現している
- `[SHOULD]` WebSocket 等のストリーム通信プロトコルでは、全メッセージを discriminator フィールドで判別可能なフレーム構造に統一する
  - 根拠: api-design-practices — `GatewayFrameSchema` は `type` discriminator で req/res/event を判別し、コード生成が正確な型を出力できる
- `[SHOULD]` 複数の外部 API プロトコルをサポートする場合、内部プロトコルを安定させてプロトコル変換レイヤー（Adapter）を介して接続する
  - 根拠: api-design-practices — Gateway WebSocket を内部プロトコルとし、OpenAI 互換 HTTP・ACP をそれぞれ Adapter で接続している
- `[AVOID]` スキーマバリデーション通過後に `as` による手動型キャストを行うこと。バリデータの型パラメータを正しく設定し、通過後は推論された型を使う
  - 根拠: api-design-practices — 手動キャストが散見されバリデーション済みの型安全性が形骸化している箇所が実例として存在する

## エラーハンドリング

- `[MUST]` カスタムエラークラスには構造化されたコード/理由フィールドを文字列リテラル union 型で持たせる。`switch` 文の網羅性チェックが有効になる
  - 根拠: error-handling-idioms — `MediaFetchError.code`、`FailoverError.reason` がすべてリテラル union 型で、catch 側が文字列解析なしにエラーを判別できている
- `[MUST]` catch ブロックでは `instanceof` で処理対象のエラーだけを扱い、それ以外は即座に再 throw する。エラーの「握りつぶし」を防ぐ
  - 根拠: error-handling-idioms — コードベース全体で「処理できないエラーは素通り」が徹底されている
- `[SHOULD]` 外部サービスのエラーはアプリケーション境界で自ドメインのエラー型に変換（coerce）する。内部ロジックは統一されたエラー型だけで分岐する
  - 根拠: error-handling-idioms — `coerceToFailoverError` が任意の API エラーを統一的な `FailoverError` に変換している
- `[SHOULD]` リトライ関数は `shouldRetry` コールバックでリトライ対象を制御し、`retryAfterMs` でバックオフを外部から注入する
  - 根拠: error-handling-idioms — 汎用 `retryAsync` に Discord・Telegram がそれぞれカスタムの `shouldRetry`/`retryAfterMs` を注入している
- `[SHOULD]` 長時間稼働プロセスの未処理 rejection ハンドラでは、エラーを致命度で分類し、一時的障害ではプロセスを落とさない
  - 根拠: error-handling-idioms — 致命的/設定/一時的ネットワーク/その他に分類し、一時的ネットワークエラーは `console.warn` で継続する
- `[AVOID]` エラーメッセージの文字列マッチだけでリカバリ判定を行うこと。エラーコード・型名を優先し、メッセージマッチはフォールバック + コンテキスト制御付きに限定する
  - 根拠: error-handling-idioms — コンテキスト `"send"` ではメッセージマッチを無効にし、偽陽性を防いでいる
- `[AVOID]` ビジネスロジック内で `catch {}` によるエラーの無言握りつぶしを行うこと。リソースクリーンアップ（`reader.releaseLock()` 等）のみ許容する
  - 根拠: error-handling-idioms — コードベースの `catch {}` はすべてリソース解放に限定されている

## プラグイン・拡張設計

- `[MUST]` プラグインシステムでは、拡張が利用できる操作を単一の API オブジェクト（Facade）として明示的に定義する。プラグインがコア内部を直接参照すると、コア変更時に全プラグインが壊れる
  - 根拠: extensibility-mechanisms — `OpenClawPluginApi` が唯一の契約として機能し、34+ の拡張がコアの内部構造を知らずに動作している
- `[MUST]` イベントフックのハンドラーは個別に try/catch で隔離し、一つのハンドラーの例外が他のハンドラーやコアのフローを停止させない
  - 根拠: extensibility-mechanisms — `triggerInternalHook` の実装で全ハンドラーが隔離されている
- `[SHOULD]` プラグインのメタデータ（ID、設定スキーマ、能力宣言）はコードとは別のマニフェストファイルに分離し、コードをロード・実行せずにバリデーションやカタログ生成を可能にする
  - 根拠: extensibility-mechanisms — `openclaw.plugin.json` によりコードロード前に設定バリデーションと重複検出が行われている
- `[SHOULD]` 拡張インターフェースのフィールドは大部分をオプショナルにし、必須は最小限（ID + メタデータ + 基本機能）にとどめることで、段階的な実装を可能にする
  - 根拠: extensibility-mechanisms / abstraction-patterns — `ChannelPlugin` 型は 20 以上のアダプタを持つが必須は 4 つのみ
- `[SHOULD]` レジストリへの登録時に ID の重複チェックと診断メッセージ出力を行い、サイレントな上書きを防ぐ
  - 根拠: abstraction-patterns — `registerProvider` / `registerGatewayMethod` が既存登録の重複を検出し、エラーレベルの診断を出力する
- `[AVOID]` 統合インターフェースの全メソッドを必須にすること（Fat Interface）。新バリアント追加のたびに不要なスタブ実装を強制することになる
  - 根拠: abstraction-patterns — `ChannelPlugin` は `config` のみ必須で他 20 スロットはオプショナル

## アーキテクチャと抽象化

- `[MUST]` マルチプロトコル統合ではゲートウェイ/メディエーターパターンを採用し、チャネルとコアロジック間の直接依存を排除する
  - 根拠: architecture — Gateway が全チャネル・エージェント間の仲介を担うことで、30 以上のチャネルの追加をコア改変なしで実現している
- `[MUST]` 複数のバリアント（チャネル、プロバイダー等）を統合するインターフェースでは、メソッドをオプショナルにし、capabilities フラグで対応能力を宣言する
  - 根拠: abstraction-patterns / messaging-integration-patterns — `ChannelCapabilities` の boolean フラグで 20+ チャネルの機能差異を一貫した方法で扱っている
- `[SHOULD]` 重量実装と軽量メタデータを分離し、共有コードパスでは軽量層のみ参照する。Import コストの高い実装層は実行境界でのみ呼ぶ
  - 根拠: architecture / design-philosophy — Dock（宣言的メタデータ）と Plugin（起動ロジック・外部 SDK 依存）を分離している
- `[SHOULD]` ルーティングやポリシーの解決結果に「マッチ理由」ラベルを付与し、デバッグ時の可観測性を確保する
  - 根拠: architecture / messaging-integration-patterns — `matchedBy` フィールドで「binding.peer」「default」等のマッチ理由を返却し、トラブルシューティングを容易にしている
- `[SHOULD]` DI コンテナ経由で注入される依存は、実際に使用されるまでモジュールをロードしない遅延プロキシとして実装する
  - 根拠: abstraction-patterns — `createDefaultDeps()` の動的 import パターンにより、使われないモジュールはロードされずテストで検証されている
- `[SHOULD]` プラグイン/拡張の追加時に変更すべき箇所を、grep 可能な定型コメント（例: `// Channel docking:`）でマーキングする
  - 根拠: abstraction-patterns — 20 箇所以上のドッキングコメントにより、新チャネル追加時の変更箇所を一括検索できる
- `[AVOID]` オーケストレーション関数を 1 つの巨大関数にまとめること。サブシステムが増えるにつれ、初期化順序の把握と停止ハンドラの保守が困難になる
  - 根拠: architecture — `startGatewayServer` は約 480 行・30+ サブシステムの初期化を 1 関数に集約している（Anti-Pattern として記録）
- `[AVOID]` 共有ロジック内でプロバイダ名による `if/switch` 条件分岐を書く。代わりにアダプタスロットまたは capabilities フラグで表現する
  - 根拠: messaging-integration-patterns — `if (channel === "discord")` はプロバイダ追加時に共有コードの変更を要求する

## コード構成とファイル管理

- `[MUST]` ファイルサイズ上限（例: 500 LOC）を CI スクリプトで機械的に検査する。人間のレビューでは行数超過を見逃すが、自動チェックなら確実に検出できる
  - 根拠: code-organization / build-and-tooling — `scripts/check-ts-max-loc.ts` が untracked ファイルも含めて検査
- `[MUST]` バレルファイルで公開 API を明示的にゲートし、内部モジュールへの直接依存を禁止する。プラグイン・拡張が内部実装に依存すると、リファクタリング時に破壊的変更が連鎖する
  - 根拠: code-organization / project-structure — `src/plugin-sdk/index.ts` が 400 行超の選択的 re-export で SDK 境界を定義
- `[MUST]` monorepo でパッケージを分割する際は「配布境界」で切る（機能ドメインではなくデプロイ/公開単位で分割する）
  - 根拠: project-structure — 40 以上のドメインを持つが workspace パッケージは 4 カテゴリのみ
- `[SHOULD]` ファイルサイズ上限を超えたモジュールは、ドット区切りファイル名（`module.sub-concern.ts`）でサブディレクトリを作らずに分割する
  - 根拠: code-organization — `status.command.ts`, `status.format.ts`, `status.types.ts` 等で一貫して適用されている
- `[SHOULD]` 型定義ファイルが肥大化したらドメイン別に `types.<domain>.ts` に分割し、集約バレル `types.ts` で `export *` する
  - 根拠: code-organization — `src/config/types.ts` 冒頭コメント「Split into focused modules to keep files small and improve edit locality」
- `[SHOULD]` モジュール境界（何を入れてよいか・何を入れてはいけないか）をソースコード中のコメントで明記する
  - 根拠: code-organization — `src/channels/dock.ts:84-91` のルールコメントがモジュールの軽量性を維持
- `[SHOULD]` バレルファイルのエクスポート一覧をユニットテストで検証する。リファクタリングでエクスポートが消失するリグレッションを早期検出できる
  - 根拠: code-organization — `src/channel-web.barrel.test.ts` が `toBeTypeOf("function")` でエクスポートの存在を検証

## セキュリティ

- `[MUST]` 秘密値の比較には必ずタイミング安全な関数（`crypto.timingSafeEqual` 等）を使い、素の `===` を使わない
  - 根拠: security-practices — 全秘密比較箇所で `safeEqualSecret` を使いタイミングサイドチャネルを構造的に排除している
- `[MUST]` 外部から受け取ったコンテンツを LLM に渡す際は、信頼境界マーカーとセキュリティ警告で包み、命令とデータを明示的に分離する
  - 根拠: security-practices / ai-settings — `wrapExternalContent()` + Unicode ホモグリフ正規化でプロンプトインジェクション攻撃面を縮小
- `[MUST]` サンドボックスのパス解決では、論理的な `..` チェックだけでなくシンボリックリンクの追跡も検証する
  - 根拠: security-practices — `assertNoSymlink()` が各パスセグメントを `lstat` で検査しサンドボックス脱出を防止
- `[SHOULD]` セキュリティ上重要な定数（危険なツール名、デフォルト拒否リスト等）は 1 箇所に集約し、監査・ポリシー・UI から同じ定義を参照する
  - 根拠: security-practices — `dangerous-tools.ts` がドリフト防止の意図とともに一元管理されている
- `[SHOULD]` ユーザー設定から渡される実行可能ファイル名には、シェルメタ文字・制御文字・NUL バイトの排除を設定解析段階で行う
  - 根拠: security-practices — `isSafeExecutableValue()` が Zod の `refine` と組み合わされ、設定ロード時にコマンドインジェクションを阻止
- `[AVOID]` 信頼境界マーカーの文字列一致だけに依存する防御。Unicode ホモグリフ（全角文字、CJK 角括弧等）による回避を考慮しないとマーカーの偽装が可能になる
  - 根拠: security-practices — 10 種以上の角括弧ホモグリフを ASCII に正規化してからマーカー検出を行っている

## パフォーマンスと並行処理

- `[MUST]` トークン推定値には安全マージン（10-20%）を乗算してから閾値比較する。推定の不正確性を前提とした設計でなければコンテキストオーバーフローが発生する
  - 根拠: performance-techniques — `SAFETY_MARGIN = 1.2` が compaction 全体で一貫して適用されている
- `[MUST]` 外部 API のバッチ処理にはフォールバック付きのリトライ戦略を実装する。バッチ API 障害時に全機能が停止する設計は許容できない
  - 根拠: performance-techniques — バッチ → タイムアウトリトライ → 個別処理の 3 段フォールバックチェーン
- `[MUST]` ファイルベースロックには PID とタイムスタンプを記録し、`process.kill(pid, 0)` でスタレロックを自動検出・解除する
  - 根拠: concurrency-patterns — PID なしのロックファイルはプロセスクラッシュ後に手動削除が必要になる
- `[SHOULD]` 並列タスクの実行にはドメイン別のキュー（レーン）を分離し、カテゴリごとに同時実行数を設定可能にする
  - 根拠: performance-techniques / concurrency-patterns — `CommandLane` enum で Main/Cron/Subagent/Nested を分離し、各レーンに独立した `maxConcurrent` を設定
- `[SHOULD]` 繰り返し失敗する外部呼び出しにはサーキットブレーカーを導入し、自動回復パスを用意する
  - 根拠: performance-techniques — `recordBatchFailure` + `resetBatchFailureCount` による動的なバッチ有効/無効切り替え
- `[SHOULD]` AbortController のリレーにはアロー関数クロージャではなく `.bind()` を使い、長時間プロセスでのメモリリークを防ぐ
  - 根拠: concurrency-patterns — 回帰テストで実証。クロージャがスコープを保持しリークを引き起こす
- `[SHOULD]` ファイルの永続化書き込みは「一時ファイル + rename」のアトミックパターンを使い、一時ファイル名には PID と UUID を含める
  - 根拠: concurrency-patterns — セッションストア・設定ファイル・配信キューすべてで一貫して使用
- `[SHOULD]` コンカレンシー制御ユーティリティはエラー伝搬ポリシーを明示的に選択可能にする。データ整合性が求められるケース（fail-fast）と可用性優先のケース（best-effort）で戦略が異なる
  - 根拠: performance-techniques — 同名 `runWithConcurrency` が memory（fail-fast）と media（best-effort）で異なるエラー処理を実装

## テスト戦略

- `[MUST]` テスト分類をファイル命名規約（`*.test.ts` / `*.e2e.test.ts` / `*.live.test.ts`）で機械的に表現し、テストランナーの config で実行スコープを制御する
  - 根拠: testing-practices — 3 層分類により `pnpm test` が unit のみを実行し、e2e/live は専用コマンドで明示実行する構成
- `[MUST]` テストのグローバルセットアップで HOME・認証トークン・状態ディレクトリを一時領域に隔離し、本番環境に一切触れない構成にする
  - 根拠: testing-practices — HOME, XDG ディレクトリ, 全チャネルトークンを隔離し、開発者の実環境を破壊するリスクを排除
- `[SHOULD]` カバレッジ除外リストの各エントリに、代替の検証手段をコメントで明記する
  - 根拠: testing-practices — 「Entrypoints and wiring (covered by CI smoke + manual/e2e flows)」のように除外理由を文書化
- `[SHOULD]` 並列テストでサーバポートを使用する場合、OS フリーポートではなくワーカー ID ベースの決定論的ポートブロック割り当てを採用する
  - 根拠: testing-practices — ブロック割り当て方式で派生ポートの衝突を防ぎ EADDRINUSE フレーク問題を解消
- `[SHOULD]` Live テスト（外部 API 呼び出し）は `const describeLive = CONDITION ? describe : describe.skip` パターンで環境変数ゲートし、通常の test コマンドでスキップされるようにする
  - 根拠: testing-practices — 全 10 件の live テストファイルで統一的にこのパターンが使われている

## ビルドとツールチェーン

- `[MUST]` リント・フォーマット・型チェックは CI と同じコマンドを pre-commit / ローカルで実行できるようにする
  - 根拠: build-and-tooling — pre-commit hooks が CI と同一コマンドで実行され乖離を防止している
- `[SHOULD]` 開発サーバー起動時にビルドキャッシュの有効性を多段階で検証し、不要な再ビルドをスキップする
  - 根拠: build-and-tooling — ビルドスタンプ・git HEAD・mtime・dirty 状態を組み合わせて判定
- `[SHOULD]` コード生成されたファイルの整合性は CI で `git diff --exit-code` パターンを使って検証する。生成 → diff → fail により、再生成漏れを機械的に防ぐ
  - 根拠: design-philosophy / multi-platform-patterns — `protocol:check` スクリプトがこのパターンを実装
- `[SHOULD]` リリース前チェックは `npm pack --dry-run` で実際のパッケージ内容を検証し、必須ファイルの欠落と不要ファイルの混入を自動検出する
  - 根拠: build-and-tooling — `release-check.ts` が dist ファイルの存在を検証し禁止パスの混入を検出する

## 依存関係管理

- `[MUST]` monorepo のプラグイン/extension パッケージでは、ホストパッケージへの `workspace:*` 参照を `devDependencies` に限定し、`dependencies` には含めない（npm install 時に解決できず壊れるため）
  - 根拠: dependency-management — 実際に壊れた事例が CHANGELOG に記録されている
- `[SHOULD]` ネイティブバイナリを含む optional 依存は `peerDependencies` として宣言し、コード上では動的 `import()` + 遅延ロードで参照する。失敗時には具体的なインストール手順を含むエラーメッセージを返す
  - 根拠: dependency-management — `@napi-rs/canvas` と `node-llama-cpp` を遅延ロードし、存在しなくてもアプリ起動を妨げない設計
- `[SHOULD]` pnpm の `minimumReleaseAge` を設定し、新パッケージバージョンの即時採用を避ける（48 時間以上を推奨）
  - 根拠: dependency-management — 2880 分（48 時間）に設定してサプライチェーン攻撃の発覚猶予期間を確保
- `[SHOULD]` ビルドスクリプト実行を許可するパッケージは `onlyBuiltDependencies` で明示的にホワイトリスト管理する
  - 根拠: dependency-management — 9 パッケージのみビルドスクリプト実行を許可し、任意パッケージのポストインストールスクリプト実行を防止
- `[AVOID]` AI エージェントに依存関係のパッチ適用・overrides 変更を自律的に行わせること。人間の承認を必須とする
  - 根拠: dependency-management — AGENTS.md で「Patching dependencies requires explicit approval」と明文化されている

## クロスプラットフォーム

- `[MUST]` クロスプラットフォームプロトコルは単一言語のスキーマを Source of Truth とし、他言語のモデルはコード生成で導出する。手動同期は必ず不整合を生む
  - 根拠: multi-platform-patterns / design-philosophy — TypeBox スキーマから Swift モデルを生成し、CI で差分検出
- `[MUST]` コード生成物はリポジトリにコミットし、CI で「再生成 + diff なし」を検証する
  - 根拠: multi-platform-patterns — 生成物をコミットすることで IDE 補完が生成ステップなしに動作する
- `[SHOULD]` プラットフォーム間で共有するリソースファイルは物理的に単一ファイルとし、ビルドシステムの参照で配信する
  - 根拠: multi-platform-patterns — Android が Gradle の `assets.srcDir` で Swift パッケージ内のリソースを直接参照
- `[AVOID]` コード生成の対象プラットフォームを一部に限定したまま放置する。生成対象外のプラットフォームで同期漏れが発生する
  - 根拠: multi-platform-patterns — Swift は自動生成だが Kotlin は手動管理のためコマンド追加時に更新忘れのリスクがある

## メディア処理

- `[MUST]` メディアダウンロードではストリーミング中にサイズ上限を検証し、超過時に即座にリクエストを破棄する（全データ受信後の検証ではリソースを浪費する）
  - 根拠: media-processing-patterns — チャンク受信中に `total > MAX_BYTES` で `req.destroy()` を呼び帯域とメモリの浪費を防止
- `[MUST]` 一時ファイルを使う処理は `try/finally` またはスコープ付きヘルパーで確実にクリーンアップする
  - 根拠: media-processing-patterns — `withTempDir` パターンが全画像操作で一貫して使用。`finally` 内のエラーは `.catch(() => {})` で許容
- `[SHOULD]` MIME 検出はバイナリスニッフィング → 拡張子 → HTTP ヘッダの優先順で多段フォールバックし、汎用 MIME（`application/octet-stream`）が具体的な判定を上書きしないようガードする
  - 根拠: media-processing-patterns — ZIP として検出された XLSX が正しく処理されるよう `isGenericMime` ガードを導入

## AI エージェント規約

- `[MUST]` AGENTS.md に記載する禁止行動は、具体的なコマンド名・操作名を列挙する形式にする。曖昧な表現は AI エージェントには効果が薄い
  - 根拠: ai-settings — `git stash` / `git worktree` / `git checkout` など具体的なコマンドを列挙し曖昧さを排除
- `[SHOULD]` AI エージェントの git 操作は `git add .` / `git add -A` を禁止し、変更ファイルを個別に指定するラッパースクリプトを通じて行う
  - 根拠: ai-settings / dev-conventions — `scripts/committer` は `.` と `node_modules` を明示的にブロックし、ステージングリセット後にファイルを個別追加
- `[SHOULD]` マルチステップの AI ワークフローは段階ごとにスキルを分離し、アーティファクトファイルの存在チェックで前段階の完了を強制する
  - 根拠: ai-settings — PR ワークフローは review → prepare → merge の 3 段階に分離し、各段階でアーティファクトの存在を検証
- `[SHOULD]` AI に提供するコンテキスト情報は Progressive Disclosure で階層化する。常時ロードは要約のみ、詳細はトリガー後にロード
  - 根拠: ai-settings — Skill システムは metadata → SKILL.md body → bundled resources の 3 層ローディング
- `[AVOID]` マルチエージェント環境で `git stash` の作成・適用・削除を行わない。他のエージェントの WIP を破壊するリスクがある
  - 根拠: ai-settings / dev-conventions — AGENTS.md が `git stash` / `git worktree` / ブランチ切り替えを明示的に禁止

## ルール優先度の解釈

- `[MUST]`: 違反するとバグ・セキュリティリスク・重大な設計劣化を招くルール
- `[SHOULD]`: 従うことで品質が向上するが、文脈によっては例外を許容するルール
- `[AVOID]`: 意図的に避けるべきアンチパターン・非推奨プラクティス
