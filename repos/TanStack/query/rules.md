# TanStack/query — 導出ルール集

> 出典: repos/TanStack/query/ | 生成日: 2026-02-17
> 用途: CLAUDE.md にそのまま貼り付けて AI コンテキストとして活用

## 状態管理・状態遷移

- `[MUST]` 非同期データの状態は「データの有無」(`status`: pending/success/error) と「通信の進行状態」(`fetchStatus`: idle/fetching/paused) を直交する 2 軸で管理する。boolean フラグ (`isLoading`, `isRefetching`) は 2 軸からの派生値として算出する
  - 根拠: state-management-patterns — status/fetchStatus の 2 軸設計が stale-while-revalidate を自然に表現し、単一 `isLoading` フラグでは不可能な 8 状態を管理
- `[MUST]` 複雑な状態遷移を持つクラスでは、状態変更を discriminated union の Action 型と reducer 関数で一元管理し、dispatch 後に一括通知する
  - 根拠: architecture, design-philosophy — `Query.#dispatch` と `Mutation.#dispatch` が 7-8 種類の Action を switch 文で網羅処理し、DevTools によるアクション履歴の追跡と予測可能性を両立
- `[MUST]` 非同期操作の結果型は discriminated union で状態を表現し、各バリアントで `data`/`error` の型を narrowing する。判別プロパティにはリテラル型を使う
  - 根拠: type-system-patterns, api-design-practices — `QueryObserverResult` の 5 状態 union で `status === 'success'` 時に `data: TData`（非 undefined）を保証

## 購読・通知・レンダリング最適化

- `[MUST]` subscribe 関数は unsubscribe 関数を返す設計にする。これにより React の `useEffect` return、Vue の `onScopeDispose`、Angular の `onCleanup` 等あらゆるフレームワークのクリーンアップ機構に直接接続できる
  - 根拠: observer-pattern-techniques, abstraction-patterns — `Subscribable.subscribe` が返す `() => void` が全 6 フレームワークで統一的に利用されている
- `[MUST]` 複数の Observer へ通知する際はバッチングで 1 回の更新サイクルにまとめる。フレームワーク固有のバッチ更新 API を注入可能にする
  - 根拠: observer-pattern-techniques, performance-techniques — `notifyManager.batch` のトランザクションカウンタと `setBatchNotifyFunction` による React `unstable_batchedUpdates` 注入
- `[MUST]` 外部ストアから UI への通知は、変更の有無を事前判定し、差分がない場合は通知自体をスキップする
  - 根拠: performance-techniques — shallow equal 比較 + Proxy プロパティ追跡の二段階フィルタで不要な再レンダリングを排除
- `[SHOULD]` キャッシュデータの更新時は深い比較で旧参照を最大限再利用する（構造的共有）。参照同一性に依存するフレームワークの無駄な再レンダリングを防ぐ
  - 根拠: performance-techniques, design-philosophy — `replaceEqualDeep` がデフォルトで全 Query データに適用され、変更のないサブツリーは旧参照を返す
- `[SHOULD]` Observer 層で結果のプロパティアクセスを Proxy で追跡し、使用されたプロパティの変更時のみ通知する
  - 根拠: observer-pattern-techniques, performance-techniques — `trackResult` の Proxy ベース追跡で `data` しか使わないコンポーネントが `fetchStatus` 変更で再レンダリングされない
- `[SHOULD]` 購読数がゼロになったタイミングでリソース（イベントリスナー、タイマー、ネットワーク接続）を解放する
  - 根拠: observer-pattern-techniques — `FocusManager` は最後の購読者離脱時にイベントリスナーを解除し、`Query` は全 Observer 離脱時に GC をスケジュール

## エラーハンドリング・リトライ

- `[MUST]` リトライの指数バックオフには上限時間を設ける（例: 30 秒）。サーバー環境ではリトライをデフォルト無効にする
  - 根拠: error-handling-idioms — `Math.min(1000 * 2 ** failureCount, 30000)` で上限。SSR では `isServer ? 0 : 3`
- `[MUST]` Error Boundary と自動リフェッチを組み合わせる場合、リセットプロトコルを実装する。リセットなしの再マウントでリフェッチを許可すると throw-catch-throw の無限ループが発生する
  - 根拠: error-handling-idioms — `QueryErrorResetBoundary` の `isReset()` フラグで retryOnMount を制御
- `[SHOULD]` リトライ中の途中経過 (`failureCount`) と最終的なエラー状態を別フィールドで管理する
  - 根拠: error-handling-idioms — `failed` アクション（途中経過）と `error` アクション（最終確定）の分離
- `[SHOULD]` エラーの伝播方法（throw vs 状態として保持）は `throwOnError` のようなオプションで消費者が選択できるようにする
  - 根拠: error-handling-idioms — `boolean | function` のユニオンでエラー単位の伝播制御を実現
- `[SHOULD]` エラーコールバックチェーンでは各コールバックを独立した try-catch で囲み、`void Promise.reject(e)` でグローバルに通知しつつ後続の実行を保証する
  - 根拠: error-handling-idioms — Mutation のエラーパスで例外を黙殺せず、フローも壊さない
- `[AVOID]` コールバック内の例外を `catch {}` や `catch(noop)` で完全に黙殺する。`void Promise.reject(e)` で `unhandledrejection` イベント検知を可能にする
  - 根拠: error-handling-idioms — 完全黙殺はデバッグ困難の原因

## 並行制御・キャンセル

- `[MUST]` 同一リソースへの並行リクエストは Promise を共有して重複排除する。進行中の Promise 自体を返すことで全呼び出し元に同じ結果を保証する
  - 根拠: concurrency-patterns — `Query#fetch` は進行中のフェッチに `this.#retryer.promise` を返す
- `[MUST]` キャンセル処理は AbortSignal を下位のネットワーク呼び出しまで伝播する。signal にアクセスするだけでは実際の中断は起きない
  - 根拠: concurrency-patterns — signal 消費検出とリクエスト中断は別の仕組み
- `[SHOULD]` キャッシュのライフサイクルは購読者の有無に連動させ、購読者ゼロで GC をスケジュール・購読者追加で GC をキャンセルする
  - 根拠: state-management-patterns, performance-techniques — `Removable` + `addObserver`/`removeObserver` で自動的なキャッシュ管理
- `[SHOULD]` 副作用を伴う並行操作にはスコープベースの直列化を導入し、スコープ間は並列に保つ。スコープ粒度はリソース単位で設計する
  - 根拠: concurrency-patterns — `MutationCache#canRun` がスコープ内 FIFO を実現
- `[SHOULD]` キャンセル可能な操作では、エラーオブジェクトにロールバック指示 (`revert` フラグ) を含めて楽観的更新の復元を自動化する
  - 根拠: concurrency-patterns — `CancelledError` の `revert` フラグで `#revertState` への自動復元
- `[AVOID]` リソース（AbortSignal 等）を消費側が使うかどうか不明な段階で即座に副作用を登録する。遅延評価で実際にアクセスされた時点で副作用を有効にする
  - 根拠: performance-techniques, concurrency-patterns — `addConsumeAwareSignal` で signal アクセスを検知し、未消費なら abort イベントを登録しない

## TypeScript 型設計

- `[MUST]` 複雑なオプションオブジェクトの型推論には identity 関数（ビルダー関数）を提供する。ユーザーに手動の型引数指定を強制しない
  - 根拠: type-system-patterns, api-design-practices — `queryOptions()` はランタイム no-op だが型推論の起点として不可欠
- `[SHOULD]` ライブラリのデフォルト型をユーザーがグローバルにカスタマイズできるよう、空の `Register` インターフェース + declaration merging パターンを採用する
  - 根拠: type-system-patterns, design-philosophy — `Register` インターフェースで `DefaultError`/`QueryMeta` を 1 箇所の宣言で全体に反映
- `[SHOULD]` 型推論が出力位置から入力位置に逆流するのを防ぐため、出力位置に `NoInfer` を適用する
  - 根拠: type-system-patterns — `useQuery` の戻り値型に `NoInfer<TData>` を適用し推論の汚染を防止
- `[SHOULD]` 再帰的な条件型にはタプル長カウンタによる深さ制限を設け、フォールバック型を定義する
  - 根拠: type-system-patterns — `useQueries` の `QueriesOptions` が深さ 20 で再帰を打ち切り
- `[SHOULD]` `never` チェックには `[T] extends [never]` を使い、distributive conditional type を回避する
  - 根拠: type-system-patterns — `QueryFunctionContext` で通常クエリと InfiniteQuery の型を安全に切替
- `[AVOID]` 標準の `Omit<T, K>` を union 型やライブラリ API の公開型で使用する。`DistributiveOmit` と `OmitKeyof` で問題を回避する
  - 根拠: type-system-patterns — 存在しないキーの静かな受け入れと union 非分配問題

## API 設計

- `[MUST]` パブリック API の引数は単一オプションオブジェクトにする（位置引数の列挙を避ける）
  - 根拠: api-design-practices — v5 で位置引数を廃止。オプション追加が非破壊的変更になる
- `[SHOULD]` オプションが「静的な値」と「動的な関数」の両方を受け付ける設計にし、解決関数 (`resolveXxx`) で統一的に処理する
  - 根拠: api-design-practices — `StaleTimeFunction`, `Enabled` が値 | 関数のユニオン
- `[SHOULD]` 不安定な機能は `experimental_` プレフィックスで公開し、安定後にプレフィックスを除去して正式 API に昇格する
  - 根拠: api-design-practices, project-structure — パッケージ名 (`-experimental`)、エクスポート名、オプション名の 3 段階で成熟度を明示
- `[SHOULD]` API の変種（Suspense 版等）では矛盾するオプションを `OmitKeyof` / `Exclude` で型レベルで除外する
  - 根拠: api-design-practices — `UseSuspenseQueryOptions` が `enabled`, `throwOnError`, `placeholderData` を除外
- `[SHOULD]` メジャーバージョン間のマイグレーション用 codemods を提供し、ユーザーの移行コストを低減する
  - 根拠: api-design-practices — `query-codemods` パッケージに v4-v5 変換器を用意
- `[AVOID]` 非推奨 API を `@deprecated` JSDoc なしに削除する。代替手段の提示 + 少なくとも 1 メジャーバージョンの猶予期間を設ける
  - 根拠: api-design-practices — `isInitialLoading` は `@deprecated` で移行を案内しつつ次メジャーまで残す

## 拡張性・環境抽象

- `[MUST]` 拡張ポイントを設計する際は、プラグインレジストリではなく最小のインターフェース（3-5 メソッド以下）を契約として定義する
  - 根拠: extensibility-mechanisms — `Persister` (3 メソッド)、`AsyncStorage` (3+1 メソッド) で永続化層全体を抽象化
- `[SHOULD]` 環境依存の処理（タイマー・フォーカス検出・ネットワーク状態）はシングルトンマネージャーに隔離し、`setEventListener` / `setProvider` で差し替え可能にする
  - 根拠: architecture, extensibility-mechanisms — `FocusManager.setEventListener` で React Native/テスト/ブラウザ環境を切替
- `[SHOULD]` ライブラリ内部の状態変更通知は、型付き discriminated union イベントを持つ単一の subscribe メカニズムに統一する
  - 根拠: extensibility-mechanisms — `QueryCache.subscribe` が DevTools・永続化・タブ間同期の唯一の統合ポイント
- `[SHOULD]` コアロジックの拡張が必要な場合、クラス継承ではなく Strategy/Behavior オブジェクトの注入を優先する
  - 根拠: abstraction-patterns — `QueryBehavior` で `infiniteQueryBehavior` が Query クラスを継承せずにフェッチ戦略を差替
- `[AVOID]` シングルトンマネージャーの状態を使用開始後に切り替えること。初期化フェーズで一度だけ設定する
  - 根拠: extensibility-mechanisms — `TimeoutManager` はプロバイダー切替後に既存タイマーの `clearTimeout` が機能しなくなる

## テスト

- `[MUST]` マルチフレームワークライブラリでは、フレームワーク非依存のコアロジックとフレームワーク固有のバインディングを別パッケージに分離し、コアのテストは UI フレームワーク無しで実行できるようにする
  - 根拠: testing-practices — `query-core` は純粋な TypeScript テストで検証、アダプターは薄い統合テスト
- `[MUST]` 共有キャッシュやグローバル状態を使うライブラリのテストでは、テストごとにユニークな識別子を自動生成するヘルパーを用意し、テスト間の状態衝突を防ぐ
  - 根拠: testing-practices — `queryKey()` のグローバルカウンター方式で数千テストがキャッシュキー衝突なく実行
- `[SHOULD]` 型推論が API の中核をなすライブラリでは、`.test-d.ts` で `expectTypeOf` を使った型テストを記述し、ランタイムテストと同じランナーで実行する
  - 根拠: testing-practices — Vitest `typecheck: { enabled: true }` で型テストとランタイムテストを統合
- `[SHOULD]` フレームワークの状態更新をラップする必要がある場合、テスト本体ではなくグローバルな test-setup で一括設定する
  - 根拠: testing-practices — `notifyManager.setNotifyFunction(act)` を test-setup に 1 回書くだけで全テストから `act()` が不要
- `[AVOID]` CI リトライ (`retry: N`) をテストの不安定さの主な対策とすること。fake timer やモックで制御可能な場合はそちらを優先する
  - 根拠: testing-practices — コア層にリトライなし、フレームワーク統合テストのみに限定

## モノレポ・ビルド・CI

- `[MUST]` モノレポで公開するパッケージの `test:build` には publint と @arethetypeswrong/cli を含め、`exports` と実際のビルド成果物の整合性を CI で検証する
  - 根拠: build-and-tooling, ci-cd — 全パッケージで `publint --strict && attw --pack` を実行
- `[MUST]` バンドルサイズに上限値を設定し、CI で自動的に検証する
  - 根拠: performance-techniques, build-and-tooling — `.size-limit.json` で最小構成と全体構成に閾値を設定
- `[MUST]` ライブラリの型定義は複数の TypeScript バージョンで CI 検証する
  - 根拠: dev-conventions, dependency-management — TS 5.0-5.8 の 9 バージョンで型チェック実行
- `[MUST]` CI ワークフローに concurrency グループと `cancel-in-progress: true` を設定し、同一 PR の重複実行を排除する
  - 根拠: ci-cd — 全ワークフローで `group: workflow-event.number` を設定
- `[SHOULD]` モノレポの共有設定（ESLint, ビルド, tsconfig）は symlink またはファイル参照で単一ソースから配布し、パッケージ固有の差分のみローカルでオーバーライドする
  - 根拠: project-structure, dev-conventions — `root.tsup.config.js -> ../../scripts/getTsupConfig.js` で 24 パッケージの設定を 1 ファイル管理
- `[SHOULD]` 公開ライブラリの dual build（modern/legacy）は、共通のビルド関数にターゲット差分をパラメータとして渡す構造にする
  - 根拠: project-structure, build-and-tooling — `modernConfig()` と `legacyConfig()` で各パッケージは 2 行で両ビルドを定義
- `[SHOULD]` モノレポ内の非公開共有コード（テストユーティリティ等）は `"private": true` の内部パッケージとして切り出し、`workspace:*` で参照する
  - 根拠: project-structure, dependency-management — `query-test-utils` はビルドなしでソースを直接参照
- `[SHOULD]` 内部パッケージを peerDependencies として参照する場合は `workspace:^` を使い、dependencies は `workspace:*` を使う
  - 根拠: dependency-management — 公開後のバージョン柔軟性と開発時の即時反映を両立
- `[SHOULD]` 依存バージョンの整合性を検証するリンター（sherif 等）を CI に組み込む
  - 根拠: dependency-management — 24 パッケージ間のバージョン不整合を PR 時に自動検出
- `[SHOULD]` PR では変更影響範囲のみテスト (`nx affected`)、リリースブランチでは全範囲をテスト (`nx run-many`) の二段構えにする
  - 根拠: ci-cd — `test:pr` vs `test:ci` で高速フィードバックと網羅的検証を両立
- `[SHOULD]` フォーマット修正のような機械的な問題は自動修正ワークフローで処理し、検証ワークフローとは分離する
  - 根拠: ci-cd, dev-conventions — autofix.ci が Prettier 修正を自動コミットし、レビューからスタイル議論を排除
- `[SHOULD]` 開発時限定のバリデーションは `process.env.NODE_ENV !== 'production'` で囲み、プロダクションバンドルから除去可能にする
  - 根拠: dev-conventions — `useBaseQuery.ts` で引数検証を開発モード限定にしバンドルサイズ影響ゼロ
- `[AVOID]` `export default` を使わず named export で統一する。default export はツリーシェイキングと IDE 自動インポートに不利
  - 根拠: dev-conventions — 全 29 パッケージで `export default` 不使用
- `[AVOID]` モノレポの examples や integrations を通常のビルド・テストタスクに含める。日常の開発サイクルが遅くなる
  - 根拠: project-structure, ci-cd — Nx で `--exclude=examples/** --exclude=integrations/**` し CI 専用ステップでのみ検証

## ルール優先度の解釈

- `[MUST]`: 違反するとバグ・セキュリティリスク・重大な設計劣化を招くルール
- `[SHOULD]`: 従うことで品質が向上するが、文脈によっては例外を許容するルール
- `[AVOID]`: 意図的に避けるべきアンチパターン・非推奨プラクティス
