# vercel/chat — 導出ルール集

> 出典: repos/vercel/chat/ | 生成日: 2026-02-25
> 用途: CLAUDE.md にそのまま貼り付けて AI コンテキストとして活用

## 抽象化とインターフェース設計

- `[MUST]` 複数の外部サービスを統合する場合、コアパッケージはインターフェースのみ定義し、サービス固有の実装が依存逆転でコアに依存する方向にする
  - 根拠: architecture — コアがインターフェースのみ定義することで、新しいサービス追加時にコアの変更が不要になる
- `[MUST]` 異なるフォーマット間の変換が N 対 N になる場合、正規化された中間表現（AST、IR）を導入して変換器を O(N+N) に抑える
  - 根拠: design-philosophy, cross-platform-normalization — 各プラットフォームは「中間表現との往復変換」だけを実装すれば済む設計
- `[MUST]` アダプターインターフェースの共通部分は必須メソッド、差がある機能は optional メソッド（`method?`）で定義し、コア側で Capability Detection + フォールバックロジックを持つ
  - 根拠: architecture, streaming-patterns — optional メソッドの有無でランタイム分岐し、段階的フォールバックを実現
- `[MUST]` 双方向マッピングテーブルでは正引きテーブルのみを定義し、逆引きテーブルは正引きから自動構築する
  - 根拠: cross-platform-normalization — 手動で両方管理すると不整合が発生する
- `[SHOULD]` 抽象化レイヤーを設ける場合、「エスケープハッチ」として下位レイヤーの生データへの直接アクセスを別フィールド（`raw` 等）で提供する
  - 根拠: design-philosophy — 抽象化では表現しきれないケースに対応し、利用者のブロッカーを防ぐ
- `[SHOULD]` 開発用の軽量実装（in-memory）と本番用の実装（Redis 等）を同じインターフェースで提供し、環境切り替えを設定変更のみで行えるようにする
  - 根拠: design-philosophy, state-management-patterns — ファクトリ関数の差し替えだけで開発/本番を切り替え可能にする

## 型安全性

- `[MUST]` 公開 API が複数の入力形式を受け付ける場合、Discriminated Union 型を定義し、各バリアントに排他的な判別キーを持たせる
  - 根拠: api-design-practices — `in` 演算子だけで型安全に分岐でき、利用者はプレーンオブジェクトを渡すだけでよい
- `[MUST]` シリアライズ境界では、ランタイムオブジェクトとは別にシリアライズ専用の型（`Serialized*`）を定義し、Date/Buffer/Function 等の非 JSON-safe 値の変換ルールを型で表現する
  - 根拠: type-system-patterns, serialization-patterns — `toJSON()` の戻り値と `fromJSON()` の引数で同一の型を共有し、フォーマット不一致をコンパイル時に検出
- `[SHOULD]` ジェネリクス付きインターフェースにはデフォルト型引数を設定し、利用者側で型引数の指定を不要にする
  - 根拠: type-system-patterns — コア層は抽象的に、アダプター層は具体的に、利用者層は推論任せで動作させる
- `[SHOULD]` タグ付きユニオンの各メンバーにリテラル型の `type` フィールドを持たせ、switch 文による exhaustive パターンマッチングを活用する
  - 根拠: type-system-patterns, jsx-runtime-patterns — 新しいメンバー追加時にコンパイラが未処理分岐を検出できる
- `[SHOULD]` 利用者向けの型拡張ポイントには空の interface を公開し、`declare module` によるモジュール拡張で型を追加できるようにする
  - 根拠: type-system-patterns — 利用者の拡張が上流の型全体に自動反映される
- `[SHOULD]` エラー変換関数の戻り値型を `never` にして、catch ブロック内の変換漏れをコンパイラに検出させる
  - 根拠: error-handling-idioms — catch 内で throw を忘れると即座にコンパイルエラーになる
- `[AVOID]` コンポーネントや関数の識別で関数名の文字列比較を使うこと。minification で関数名が消えるため、関数参照の同一性比較（`type === Component`）を使う
  - 根拠: jsx-runtime-patterns — minification 耐性のある識別手法

## エラーハンドリング

- `[MUST]` エラーに構造化フィールド（`code`、発生元 `adapter` 等）を持たせ、メッセージ文字列の解析でエラー種別を判別しない
  - 根拠: error-handling-idioms — `instanceof` とプロパティ参照だけでエラーの種別と発生元を特定できる
- `[MUST]` 外部 API エラーはレイヤー境界で自ドメインのエラー型に変換し、プラットフォーム固有のエラーオブジェクトを上位層に漏洩させない
  - 根拠: error-handling-idioms, architecture — アダプター固有のエラー情報がコアのインターフェースに漏れない
- `[MUST]` ファクトリ関数のエラーメッセージには「環境変数名」と「config オプション名」の両方を明記する
  - 根拠: api-design-practices — 利用者がどちらの方法で設定できるかを即座に理解できる
- `[SHOULD]` 段階的フォールバックの発生を呼び出し元に通知するフラグ（`usedFallback` 等）を返り値に含める
  - 根拠: error-handling-idioms — フォールバックが発生したことを検知し、UX を調整できる
- `[AVOID]` `catch {}` での無条件エラー抑制。最低限ログに記録し、認証エラー等の致命的エラーは伝搬させる
  - 根拠: error-handling-idioms, streaming-patterns — 空 catch はデバッグを困難にし、恒久的エラーの識別を妨げる

## 分散システム・非同期処理・状態管理

- `[MUST]` 分散ロックには必ず TTL を設定し、`finally` ブロックでロック解放を行う。Redis ではトークン検証と解放を Lua スクリプトでアトミックに実行する
  - 根拠: state-management-patterns, hook-and-lifecycle-patterns — TTL + finally の二重保護でデッドロック防止、Lua で TOCTOU 問題を回避
- `[MUST]` webhook 駆動のイベント処理では、重複排除（TTL 付き KV チェック）をロック取得より先に行い、不要なロック操作を回避する
  - 根拠: hook-and-lifecycle-patterns — ロックは高コストな分散操作のため、安価な KV チェックで先にフィルタする
- `[MUST]` フォールバック方式（post+edit）で定期更新する場合、`setInterval` ではなく recursive `setTimeout` を使い、前の更新完了後にのみ次のタイマーをスケジュールする
  - 根拠: streaming-patterns — `setInterval` では API 応答が遅い場合にリクエストが積み上がる。recursive `setTimeout` は自然なバックプレッシャーとなる
- `[MUST]` webhook 署名検証では常にタイミングセーフ比較（`timingSafeEqual`）を使い、HMAC 結果を通常の文字列比較しない
  - 根拠: adapter-implementation-patterns — タイミング攻撃を防止する
- `[SHOULD]` 外部リソースへの同時接続リクエストは、接続 Promise を保持して単一の接続に集約する（Connection Coalescing パターン）
  - 根拠: architecture, state-management-patterns — サーバーレス cold start 時の thundering herd を防止
- `[SHOULD]` 外部から注入されたクライアントと内部で作成したクライアントを区別し、`ownsClient` フラグでリソース解放の責任を明確にする
  - 根拠: state-management-patterns — 外部クライアントの意図しない切断を防止
- `[SHOULD]` KV ストアのキーは `{prefix}:{type}:{id}` 形式で構造化し、名前空間衝突を防止する。プレフィックスは設定可能にする
  - 根拠: state-management-patterns — 同一インスタンスの共有を許容しつつ衝突を防ぐ
- `[SHOULD]` サーバーレス環境では `waitUntil` パターンで非同期処理を分離し、webhook レスポンスの即時返却を保証する
  - 根拠: hook-and-lifecycle-patterns — エラーを呼び出し元に伝播させると webhook の 200 応答が崩れる
- `[SHOULD]` スロットリングされた更新ループでは、前回送信内容と現在の蓄積内容を比較し、変化がない場合は API 呼び出しをスキップする
  - 根拠: streaming-patterns — 不要な API 呼び出しを省略し、レート制限の消費を抑える
- `[AVOID]` ロックで保護されていないコンテキストで read-modify-write パターンの状態更新を行うこと。並行書き込みでデータが消失する
  - 根拠: state-management-patterns — シャローマージはアトミックでない

## シリアライズ

- `[MUST]` シリアライズ形式に名前空間付き型タグ（`_type: "package:TypeName"`）を含め、デシリアライズ時のディスパッチに使う
  - 根拠: serialization-patterns — reviver での安全なディスパッチを可能にする
- `[MUST]` `toJSON()` と `fromJSON()` は対称的に実装し、中間形式の型を共有する
  - 根拠: serialization-patterns — フォーマット不一致がコンパイル時に検出される
- `[MUST]` 複合識別子を単一文字列にエンコードする場合、区切り文字と衝突しうる値は base64url 等でエスケープする
  - 根拠: adapter-implementation-patterns, cross-platform-normalization — URL やシステム境界を安全に通過させる
- `[SHOULD]` デシリアライズ時にランタイム依存が必要な場合、名前（文字列）をシリアライズし、getter で遅延解決してキャッシュする
  - 根拠: serialization-patterns — プロセス間で安全に受け渡し可能にしつつ、ランタイム依存を復元する
- `[AVOID]` シリアライズ形式に関数、クラスインスタンス、環境依存オブジェクトを含めること。文字列化された参照名のみを保存する
  - 根拠: serialization-patterns — プロセス間受け渡しの安全性を保証する

## テスト

- `[MUST]` 外部 API モックはインターフェースの全メソッドを網羅するファクトリ関数（`createMockAdapter()` 等）で生成し、テストファイル内で個別にモックを構築しない
  - 根拠: testing-practices — インターフェイス変更時の修正箇所が一箇所に集約される
- `[MUST]` 統合テストのセットアップを TestContext ファクトリ関数に集約し、テスト側は「何を送信して何を検証するか」だけを記述する
  - 根拠: testing-practices — テストの意図が明確になり、セットアップ変更が一箇所で済む
- `[SHOULD]` README やドキュメント内のコードサンプルを CI で型チェックし、API とドキュメントの乖離を自動検出する
  - 根拠: testing-practices — API 変更時にドキュメント更新漏れが CI で発覚する
- `[SHOULD]` `globalThis.fetch` 等のグローバル状態をモックした場合、`afterEach` で必ず元に戻す
  - 根拠: testing-practices — restore 漏れは他のテストに影響を与える
- `[AVOID]` テストフィクスチャに本番の機密情報（API トークン、ユーザー ID、内部 URL）をそのまま含めること。録画時にダミー値に置換する
  - 根拠: testing-practices — セキュリティリスクの防止

## ビルドと CI

- `[MUST]` CI の依存インストールには `--frozen-lockfile`（pnpm）または `npm ci` を使い、ロックファイルとの不一致でビルドを失敗させる
  - 根拠: ci-cd — CI とローカルの依存バージョンの一致を保証する
- `[MUST]` validate/CI スクリプトでは軽量チェック（lint、未使用コード検出）を重いチェック（テスト、ビルド）より先に実行し、早期失敗させる
  - 根拠: build-and-tooling, dev-conventions — フィードバックループを最短にする
- `[MUST]` lint/format ツールの設定は外部プリセットを extends し、例外は理由付きで最小限に宣言する
  - 根拠: dev-conventions — ベースラインの厳格さを維持しつつプロジェクト固有の事情に対応する
- `[SHOULD]` 全品質ゲート（lint, typecheck, test, build）を単一コマンド（`validate` 等）で実行できるようにし、CI とローカルの検証内容を同期させる
  - 根拠: dev-conventions, ci-cd — タスク完了の判定基準を一元化する
- `[SHOULD]` 外部サービス連携を持つアプリのビルド検証にはモック環境変数を注入する専用スクリプトを用意し、CI でシークレットなしにビルドの健全性を検証する
  - 根拠: build-and-tooling, ci-cd — 外部サービスへの接続なしにテストを実行可能にする
- `[SHOULD]` Knip 等の未使用コード検出ツールを CI に組み込み、未使用の依存関係・エクスポート・ファイルを検出する
  - 根拠: dev-conventions — 不要なコードの蓄積を防ぐ
- `[AVOID]` lint ツール移行後に旧ツールの suppress コメント（`// eslint-disable-*` 等）を残すこと
  - 根拠: dev-conventions — 移行先のツールはこれを解釈しないためデッドコメントになる

## AI エージェント向けコンテキスト設計

- `[MUST]` AI エージェント向けコンテキストファイルは対象読者（貢献者/利用者）ごとに分離し、混在させない
  - 根拠: ai-settings — 各ファイルの S/N 比を維持し、コンテキストウィンドウの効率を上げる
- `[MUST]` AI エージェントに完了判断させるタスクには、検証コマンドを強調表現（ALWAYS/NEVER 等）で明示的に指示する
  - 根拠: ai-settings — AI の早期完了宣言を防ぐ
- `[SHOULD]` CLAUDE.md ではビルド・テスト・検証コマンドを最上位セクションに配置し、AI が最初に必要とする情報へのアクセスを最速にする
  - 根拠: ai-settings — エージェントのタスク開始効率を上げる
- `[SHOULD]` テストユーティリティ（モックファクトリ等）の使い方はコンテキストファイル内にコード例付きで記載し、AI がソースを読みに行く手間を省く
  - 根拠: ai-settings — エージェントのコンテキスト収集コストを削減する
- `[AVOID]` ツールで自動適用可能なコーディング規約（フォーマット、リントルール等）を AI コンテキストファイルに大量に埋め込むこと
  - 根拠: ai-settings — コンテキストウィンドウを圧迫し、重要な情報の S/N 比が下がる

## ルール優先度の解釈

- `[MUST]`: 違反するとバグ・セキュリティリスク・重大な設計劣化を招くルール
- `[SHOULD]`: 従うことで品質が向上するが、文脈によっては例外を許容するルール
- `[AVOID]`: 意図的に避けるべきアンチパターン・非推奨プラクティス
