# cloudflare/partykit — 導出ルール集

> 出典: repos/cloudflare/partykit/ | 生成日: 2026-02-25
> 用途: CLAUDE.md にそのまま貼り付けて AI コンテキストとして活用

## 初期化と排他制御

- `[MUST]` 排他制御ブロック（mutex / blockConcurrencyWhile 等）内でエラーが発生した場合、ブロック内でキャッチして状態をリセットし、ブロック外で再スローする -- ブロック内で直接スローするとロック解放やゲート開放が行われず、後続処理が永久にブロックされる
  - 根拠: concurrency-patterns / error-handling-idioms / hook-and-lifecycle-patterns — `#ensureInitialized` はエラーを変数に退避してブロック外で再スローし、status を "zero" にリセットして input gate デッドロックを防止
- `[MUST]` 全エントリポイント（HTTP リクエスト、WebSocket メッセージ、アラーム等）で初期化保証を呼び出し、どの経路からアクセスされても一貫した状態を保証する
  - 根拠: concurrency-patterns — partyserver は fetch, webSocketMessage, webSocketClose, webSocketError, alarm の全5箇所で `#ensureInitialized()` を呼出
- `[SHOULD]` 初回起動とリカバリ（再起動・ウェイクアップ）を同一コードパスで処理し、条件分岐を排除する
  - 根拠: concurrency-patterns — y-partyserver の onStart は sync step 1 の送信を初回（接続0件 = ノーオペレーション）とウェイクアップで分岐なしに処理

## フレームワーク設計とライフサイクル

- `[MUST]` プラットフォーム固有のエントリポイント（fetch/alarm 等）を直接公開せず、ライフサイクルフック（Template Method パターン）でラップして開発者に提供する
  - 根拠: architecture / abstraction-patterns / design-philosophy — Server.fetch は `#` private で隠蔽され、ユーザーは onRequest/onConnect のみオーバーライドする設計
- `[MUST]` フレームワークのライフサイクルフックは「空のデフォルト実装」を持ち、abstract にしない -- 利用者が段階的に機能を追加できるようにする
  - 根拠: design-philosophy — 全フック (onConnect, onMessage, onClose 等) が空メソッドまたはログ出力のデフォルト実装を持つ
- `[MUST]` フレームワークの内部コールバック（初期化保証を含むもの）と利用者向けフックを明確に分離し、内部メソッドは private フィールド (`#`) で隠蔽する
  - 根拠: hook-and-lifecycle-patterns / design-philosophy — `#ensureInitialized`, `#attachSocketEventHandlers` 等はすべて private フィールドで定義
- `[SHOULD]` mixin でライフサイクルフックをオーバーライドする場合、ユーザーが安全に追加ロジックを挟めるよう処理の核心を別名のメソッドとして分離する
  - 根拠: architecture — y-partyserver は onMessage を内部で使いつつ handleMessage を公開メソッドとして分離
- `[SHOULD]` 前処理フックは `Response | Request | void` の三値返却型にして、短絡（拒否）・変形（ヘッダ注入等）・続行を単一のフックで表現する
  - 根拠: composition-patterns / hook-and-lifecycle-patterns — onBeforeConnect/onBeforeRequest がこの設計で認証・変形・パススルーを簡潔に表現
- `[SHOULD]` フレームワークの動作モード切替は、コンストラクタ引数やメソッド呼び出しではなく静的プロパティで宣言的に表現する
  - 根拠: design-philosophy — `static options = { hibernate: true }` のワンライナーで Hibernation モードが切り替わる
- `[SHOULD]` 利用者が拡張する可能性のあるプロパティは `configurable: true` で定義し、JSDoc で拡張契約を文書化する
  - 根拠: design-philosophy / abstraction-patterns / type-system-patterns — Connection の state/setState は configurable で定義され、Agents SDK が再定義可能
- `[AVOID]` フレームワークのミックスインが提供するフックをオーバーライドする際に super 呼び出しを省略すること
  - 根拠: hook-and-lifecycle-patterns — YPersistent は super.onStart() を呼んで Yjs ドキュメントの初期化チェーンを維持

## 型システム

- `[MUST]` ジェネリクスを持つ公開 API の型パラメータにはデフォルト値を設定し、型引数なしでも使用可能にする
  - 根拠: type-system-patterns — 全主要クラスが `= Cloudflare.Env` / `= unknown` 等のデフォルトを持ち、段階的な型付けを実現
- `[MUST]` 判別共用体のメッセージ型には `satisfies` を使って構造的整合性を検証する（`as` による型アサーションではなく）
  - 根拠: type-system-patterns — partysync/partyfn で `satisfies RpcAction<T>` が一貫して使われ、フィールド欠落をコンパイル時に検出
- `[SHOULD]` 読み取り専用の状態プロパティは再帰的イミュータブル型で公開し、更新は専用のセッター関数を経由させる
  - 根拠: type-system-patterns — Connection.state は `ImmutableObject<TState> | null` で読み取り専用にし、setState で更新を強制
- `[SHOULD]` Mixin 関数の戻り値型は、基底クラス型 / 静的メンバーインターフェース / インスタンスメンバーインターフェースの intersection として表現する
  - 根拠: type-system-patterns / composition-patterns — withYjs が `TBase & YjsStatic & (new (...args: any[]) => YjsInstance)` を返す
- `[AVOID]` ユーザー入力由来の値を `as keyof T` でキャストして判別共用体の分岐に使うこと -- ランタイム検証なしの型キャストはプロトコル不整合を隠蔽する
  - 根拠: type-system-patterns — SyncServer.onMessage で `json.channel as keyof TChannels` とキャストしており型安全性が失われている

## 状態管理と永続化

- `[MUST]` 共有ストレージ（WebSocket attachment 等）に複数レイヤーがデータを保存する場合、名前空間プレフィックスで衝突を防ぐ
  - 根拠: architecture / state-management-patterns — ConnectionAttachments の `__pk`（プラットフォーム内部）と `__user`（ユーザーデータ）の分離
- `[SHOULD]` 復元コストの高いオブジェクトは遅延復元（Lazy Hydration）+ WeakMap キャッシュで管理し、オーナーの GC に連動して自動解放する
  - 根拠: state-management-patterns / abstraction-patterns — AttachmentCache がアクセス時のみデシリアライズし WeakMap で保持
- `[SHOULD]` 高頻度イベントの永続化にはデバウンス（wait + maxWait）を適用し、ストレージ書き込みを集約する
  - 根拠: state-management-patterns — y-partyserver が lodash.debounce で 2000ms wait / 10000ms maxWait を設定
- `[SHOULD]` `setState` は関数型アップデート `(prev) => next` もサポートし、read-modify-write をアトミックに行えるようにする
  - 根拠: state-management-patterns — y-partyserver は setState の関数型アップデートで awareness ID の追加・削除をアトミックに実行
- `[AVOID]` 休止・再起動可能な環境で、接続ごとの状態をインメモリのコレクション（Map, Set, 配列）に保持する -- WebSocket attachment やプラットフォーム提供の永続ストレージを使う
  - 根拠: concurrency-patterns / state-management-patterns — y-partyserver は awareness ID を connection.setState() で WebSocket attachment に保存
- `[AVOID]` Hibernation 対応環境で `setInterval` や再帰的 `setTimeout` を使用する -- DO のスリープを阻害しリソースを浪費する
  - 根拠: concurrency-patterns / state-management-patterns — y-partyserver が awareness プロトコルの _checkInterval を clearInterval で無効化

## エラーハンドリング

- `[MUST]` WebSocket リクエストに対するエラーレスポンスは、HTTP ステータスコードではなく WebSocket フレーム経由で送信する -- ブラウザの DevTools は WebSocket アップグレード要求への HTTP エラーレスポンスのボディを表示しない
  - 根拠: error-handling-idioms — partyserver は WebSocket リクエストのエラー時に WebSocketPair を作成しエラーフレームを送信
- `[SHOULD]` WebSocket の send() 呼び出しは readyState チェック + try-catch で保護し、失敗を黙殺する -- 個別接続の障害がブロードキャストや他の処理全体を停止させてはならない
  - 根拠: error-handling-idioms — y-partyserver と partyserver で一貫して readyState チェック + try-catch が適用
- `[SHOULD]` クライアント側の自動再接続では、初期遅延にランダムオフセット（ジッター）を加えて thundering herd を回避する
  - 根拠: error-handling-idioms — partysocket の `1000 + Math.random() * 4000` によるランダム分散
- `[SHOULD]` リトライ不可能なエラー（ユーザーキャンセル、デバイス不在等）はリトライループに入れず即座に別の処理パスに切り替える
  - 根拠: error-handling-idioms — resilientTrack$ で NotFoundError を complete() に変換し次のデバイスへフォールバック
- `[SHOULD]` fire-and-forget の非同期処理には `.catch()` を必ず付与し、未処理 Promise rejection を防止する
  - 根拠: error-handling-idioms — partysub と y-partyserver で一貫して .catch() を付与
- `[AVOID]` RPC / WebSocket メッセージハンドラ内でエラーを飲み込んで黙殺する -- エラーは構造化された形式で呼び出し元に返す
  - 根拠: error-handling-idioms — partysync の SyncServer.onMessage で JSON パースエラーとビジネスロジックエラーを区別して構造化レスポンスを返却

## パッケージ設計とモノレポ

- `[MUST]` モノレポの拡張パッケージがコアを使う場合、peerDependencies で広いレンジ + devDependencies で具体バージョンを二重宣言する
  - 根拠: project-structure / dependency-management — 4パッケージすべてがこのパターンを採用し、消費者のバージョン重複を防止
- `[MUST]` package.json の `exports` フィールドに記載したファイルパスの実在をビルド後に自動検証するスクリプトを CI に組み込む
  - 根拠: project-structure / build-and-tooling / api-design-practices — check-exports.ts がビルド後に全パッケージの exports を検証
- `[MUST]` 品質チェックは軽量（フォーマット・リント）から重量（型チェック・テスト）の順に `&&` で直列合成し、先行失敗で後続をスキップさせる
  - 根拠: build-and-tooling — `check:repo && check:format && check:lint && check:type && check:test` の構成で CI 時間を最小化
- `[SHOULD]` サーバー / クライアント / フレームワークバインディングを同一パッケージ内で提供する場合、subpath exports（`./server`, `./client`, `./react`）で分離し、ソースディレクトリ構造と 1:1 で対応させる
  - 根拠: project-structure / api-design-practices — partysub, partysync, partytracks が一貫してこのパターンを適用
- `[SHOULD]` ESM/CJS デュアルフォーマット出力はクライアントライブラリにのみ適用し、サーバー専用パッケージは ESM 単独とする
  - 根拠: project-structure / build-and-tooling — 9パッケージ中 partysocket のみが CJS を出力
- `[SHOULD]` コアパッケージのランタイム依存を最小化し、機能拡張は mixin やアダプターとして別パッケージに分離する
  - 根拠: project-structure / dependency-management — partyserver の dependencies は nanoid のみ
- `[SHOULD]` ビルドツールの設定はプログラマティック API で TypeScript スクリプトとして記述し、前後処理を自然に統合する
  - 根拠: build-and-tooling — 全9パッケージが scripts/build.ts でビルド後の oxfmt 適用やファイル移動を一体のスクリプトとして管理
- `[SHOULD]` ビルド成果物（特に `.d.ts` 型定義ファイル）にもフォーマッターを適用し、ライブラリ利用者が参照する型定義の可読性を担保する
  - 根拠: build-and-tooling — 8/9パッケージのビルドスクリプトが `execSync("oxfmt ./dist/**/*.d.ts")` を実行
- `[SHOULD]` 同一パッケージ内でサーバー・クライアント・テストが異なる型環境を必要とする場合、サブディレクトリごとに tsconfig.json を分離して型の汚染を防ぐ
  - 根拠: build-and-tooling — partysub/src/server/tsconfig.json と partysub/src/client/tsconfig.json で環境差異を隔離
- `[SHOULD]` テスト・サンプル用の内部パッケージは `private: true` + スコープ付き命名にし、changesets の ignore で publish 対象から除外する
  - 根拠: dependency-management — `@partyserver/fixture-*` 命名 + ignore パターンで完全に分離
- `[AVOID]` モノレポのビルド順序をシェルスクリプトや npm scripts のハードコードで管理する -- 依存グラフベースのビルドオーケストレーション（turborepo 等）を使う
  - 根拠: project-structure — root build スクリプトは -w フラグで9パッケージを手動列挙しており、追加時にメンテナンスコストが発生
- `[AVOID]` `export *` でモジュール全体を re-export すること -- 意図しない内部型がパブリック API に漏洩する
  - 根拠: api-design-practices — partyserver の `export * from "./types"` は types.ts への追加が自動的にパブリック API となるリスク

## テスト

- `[MUST]` WebSocket テストではコールバック内のアサーション失敗を Promise の reject で伝搬する -- コールバック内の例外は Vitest のテストランナーに捕捉されないため、テストが意図せず成功する
  - 根拠: testing-practices — 全 WebSocket テストで `Promise.withResolvers` + try/catch/reject パターンが一貫して使用
- `[SHOULD]` テスト階層ごとに Vitest 設定ファイルを分割する（ユニット / インテグレーション / E2E）-- CI の高速フィードバックループと信頼性検証を両立する
  - 根拠: testing-practices — y-partyserver は3つの vitest 設定で軽量テストと重量テストを分離
- `[SHOULD]` プロトコル操作やインフラ操作をテストヘルパーに抽出し、テストケース本体はビジネスロジックの検証に集中させる
  - 根拠: testing-practices — y-partyserver のテストでは9つのヘルパー関数が Yjs プロトコルの複雑さを吸収
- `[AVOID]` 固定待機時間（`setTimeout` + 固定ms）によるテスト同期 -- イベント駆動の待機（ポーリング + タイムアウト）に置き換えてフレーキーテストを減らす
  - 根拠: testing-practices — 多くのテストで `await new Promise((r) => setTimeout(r, 300))` が使われているがフレーキーテストの原因になりうる

## 並行処理とバッチ化

- `[SHOULD]` 同一イベントループ内で発生する複数の API 呼び出しは、マクロタスク境界（`setTimeout(0)`）でバッチ化してネットワーク往復を削減する
  - 根拠: concurrency-patterns / streaming-patterns — BulkRequestDispatcher が push/pull/close リクエストをバッチ化
- `[SHOULD]` 排他的に実行すべき非同期処理（SDP ネゴシエーション等）には Promise チェーン型スケジューラを使い、複数の同時実行を防ぐ
  - 根拠: streaming-patterns / concurrency-patterns — FIFOScheduler が WebRTC のシグナリング状態の競合を防止
- `[SHOULD]` 不安定なリソース（ネットワーク接続、ハードウェアデバイス等）の管理には、Promise ではなく Observable を使い、状態遷移の自動伝播でリカバリーロジックを利用側から隠蔽する
  - 根拠: streaming-patterns — session$ が接続断時に error → retryWithBackoff で再接続し、push()/pull() で自動的にトラックが再プッシュされる

## AI 向けドキュメント

- `[MUST]` AGENTS.md / CLAUDE.md にはコピペ可能なコマンド例をビルド・テスト・リントの3カテゴリで含める
  - 根拠: ai-settings — partykit の AGENTS.md はコマンドセクションを冒頭近くに配置し、AI が最初に必要とする情報に即応
- `[MUST]` リンター/フォーマッターの suppress コメントには理由を1文添付する
  - 根拠: ai-settings — `oxlint-disable-next-line rule-name -- 理由` のように理由付き抑制が守られている箇所と、`@ts-expect-error yeah whatever` のような低品質な抑制が混在
- `[SHOULD]` AI 向けドキュメントの Code Style セクションでは、設定ファイルの全転記ではなく「AI が判断に迷うルール」のみを選択的に記載し、意図を添える
  - 根拠: ai-settings — .oxlintrc.json の12ルールのうち5つだけを記載し、^_ パターンの意図を添えている
- `[SHOULD]` AI 向けドキュメントにはリポジトリ横断の「Common Patterns」セクションを設け、好まれるイディオムを5個以内で列挙する
  - 根拠: ai-settings — EventTarget、イベントクローン、指数バックオフ、dual API、string/function 設定の5パターンを明示

## ルール優先度の解釈

- `[MUST]`: 違反するとバグ・セキュリティリスク・重大な設計劣化を招くルール
- `[SHOULD]`: 従うことで品質が向上するが、文脈によっては例外を許容するルール
- `[AVOID]`: 意図的に避けるべきアンチパターン・非推奨プラクティス
