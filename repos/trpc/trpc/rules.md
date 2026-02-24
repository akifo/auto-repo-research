# trpc/trpc — 導出ルール集

> 出典: repos/trpc/trpc/ | 生成日: 2026-02-24
> 用途: CLAUDE.md にそのまま貼り付けて AI コンテキストとして活用

## 型システム設計

- `[MUST]` 型レベルで不正な操作を検出したら `never` ではなく、テンプレートリテラル型を使ったエラーメッセージ型（`TypeError<'Context mismatch'>` 等）を返す — IDE 上で人間が読めるエラーメッセージを表示し、原因特定を即座に可能にする
  - 根拠: type-system-patterns — `TypeError` 型が ProcedureBuilder の 10 箇所以上で使用され、合成時の不整合を具体的に伝達
- `[MUST]` fluent builder の型パラメータに「未設定」状態を表現するセンチネル型を用意し、条件付き型（`DefaultValue`, `IntersectIfDefined` 等）で分岐させる
  - 根拠: type-system-patterns — `UnsetMarker` が 7 箇所以上の型パラメータ初期値として使用され、`.input()` 未呼出時の `void` フォールバックを実現
- `[SHOULD]` 複雑な交差型を `Simplify<TType>` で展開して IDE ツールチップの可読性を改善する
  - 根拠: type-system-patterns — 交差型のまま表示されると実質的に読めない型がフラットなオブジェクト型に変換される
- `[SHOULD]` ユニオン型に対して `Omit` や `Pick` を適用する場合は distributive conditional type（`T extends any ? Omit<T, K> : never`）でラップする
  - 根拠: type-system-patterns — `DistributiveOmit` が 9 ファイルで使用され、ユニオンの崩壊を防止
- `[SHOULD]` ジェネリクスが多い型定義では、構造体レベル（`T` プレフィックス）とメソッドローカル（`$` プレフィックス）の型パラメータを命名規約で視覚的に区別する
  - 根拠: dev-conventions — 10 個超の型パラメータが混在する `ProcedureBuilder` で、スコープの判別を容易にしている
- `[SHOULD]` 複数の外部ライブラリの型を統一的に推論する場合は、ライブラリ固有の型プロパティを構造型（`-Esque` パターン）で定義し、条件付き型チェーンで順番にマッチさせる
  - 根拠: type-system-patterns / schema-validation-patterns — `parser.ts` で 10 以上のバリデータを統一的に推論
- `[AVOID]` 型レベルのみで使う phantom property を `null as any` で初期化する — ランタイムでアクセスすると null 参照エラーになる
  - 根拠: type-system-patterns — `$types: null as any` のランタイムアクセスで NullPointerException が発生する

## エラーハンドリング

- `[MUST]` `catch(cause: unknown)` の直後で正規化関数を呼び、以降の処理は常に正規化済みのエラー型を扱う
  - 根拠: error-handling-idioms — 全アダプタ・全 catch ブロックで `getTRPCErrorFromUnknown(cause)` を最初に呼出
- `[MUST]` エラーの cause チェーンを保全する — ラップ時に元のエラーを `cause` として渡し、スタックトレースを継承する
  - 根拠: error-handling-idioms — `TRPCError` は文字列・オブジェクト・Error すべてを cause に変換し、元スタックを継承
- `[MUST]` バリデーション失敗時のエラーコードを入力（クライアント起因: 4xx）と出力（サーバー起因: 5xx）で区別する
  - 根拠: schema-validation-patterns — 入力バリデーション失敗は `BAD_REQUEST`、出力は `INTERNAL_SERVER_ERROR`
- `[SHOULD]` エラーの「形状変換（シリアライズ）」と「副作用通知（ログ・監視）」を別のフックとして分離する
  - 根拠: error-handling-idioms — `errorFormatter`（形状変換）と `onError`（副作用）の分離でバッチ処理やストリーミングでも正しく動作
- `[SHOULD]` ミドルウェアチェーン内のエラーは Result 型（`{ ok: false, error }` / `{ ok: true, data }`）で伝播し、最終段で必要に応じて再スローする
  - 根拠: error-handling-idioms — `callRecursive` が Result に変換し、エラー情報の欠落を防止
- `[SHOULD]` `instanceof` によるエラー型判定は `name` プロパティによるフォールバックを併用する
  - 根拠: error-handling-idioms — モノレポやバンドラー環境では `instanceof` が失敗するため、`cause.name === 'TRPCError'` をフォールバックとして使用
- `[SHOULD]` ドメインエラーコードは HTTP ステータスコードから独立した列挙型として定義し、変換テーブルでマッピングする
  - 根拠: error-handling-idioms — JSON-RPC 2.0 コード体系を使い、HTTP/WS/SSE で統一的なエラーコードを実現
- `[AVOID]` 既にエラー状態にあるレスポンスに対して追加のバリデーションや変換を適用する — エラーの二重発生を招く
  - 根拠: error-handling-idioms — `createOutputMiddleware` は `result.ok === false` でバリデーションをスキップ

## 合成とパイプライン

- `[MUST]` 合成操作は不変にし、元のオブジェクトを変更しない新しいオブジェクトを返す
  - 根拠: composition-patterns — `createNewBuilder` は毎回新しい `_def` を生成し、ベースプロシージャから安全に分岐
- `[MUST]` 合成境界で互換性を検証し、不整合をコンパイル時または初期化時に検出する（ファストフェイル）
  - 根拠: composition-patterns — `concat()` の条件型と `mergeWithoutOverrides` の重複キーチェック
- `[MUST]` ミドルウェアの戻り値型にブランドマーカーを含め、`next()` 経由の結果のみを許可する
  - 根拠: middleware-composition — `middlewareMarker` がミドルウェアの `next()` 呼び忘れをコンパイル時に防止
- `[SHOULD]` バリデーション（入力・出力）をミドルウェアとして統一的に扱い、実行エンジンを単一化する
  - 根拠: middleware-composition — `createInputMiddleware` / `createOutputMiddleware` でパイプラインが `callRecursive` に統一
- `[SHOULD]` パイプラインビルダーを不変にし、途中段階を変数に束縛して複数箇所で再利用可能にする
  - 根拠: middleware-composition — `authedProcedure` を複数プロシージャで安全に共有
- `[SHOULD]` オブジェクトマージ時にサイレントな上書きを防ぐユーティリティ（`mergeWithoutOverrides` 等）を用意する
  - 根拠: composition-patterns — キー重複を即座に例外として報告し、`Object.assign` のサイレント上書きを防止
- `[AVOID]` ミドルウェアチェーン内で既存コンテキストプロパティを異なる型で暗黙にオーバーライドする
  - 根拠: middleware-composition — `Overwrite` 型は後勝ちで置換するため、後段で型不整合が発生する

## Proxy 設計

- `[MUST]` 再帰 Proxy を作る場合、`then` プロパティへのアクセスで `undefined` を返す — Promise チェーンとの互換性を壊さないために必須
  - 根拠: proxy-based-type-inference — `Promise.resolve(proxy)` で PromiseLike として誤解釈されるのを防止
- `[MUST]` Proxy で `get` と `apply` の両トラップを使う場合、ターゲットを関数にする — オブジェクトターゲットでは `apply` トラップが発火しない
  - 根拠: proxy-based-type-inference — `noop` 関数をターゲットにすることでプロパティアクセスと関数呼び出しの両方を捕捉
- `[SHOULD]` 再帰 Proxy をメモ化してパスごとの再生成を防ぐ — React 再レンダリング等での生成コストを一定に抑える
  - 根拠: proxy-based-type-inference / performance-techniques — `memo[cacheKey] ??= new Proxy(...)` で同一パスの Proxy を再利用
- `[SHOULD]` Proxy コールバックに渡すパスと引数を `Object.freeze` で不変にする — コールバック内での意図しない破壊的操作を防止
  - 根拠: proxy-based-type-inference — `freezeIfAvailable` で freeze し、テストで不変性を検証
- `[SHOULD]` Proxy で名前空間を合成する場合、トップレベル（FlatProxy）とネスト（RecursiveProxy）を分離する
  - 根拠: proxy-based-type-inference — 全統合レイヤーで FlatProxy + RecursiveProxy の 2 層構造を一貫採用
- `[AVOID]` `then`, `call`, `apply` をプロキシ対象オブジェクトのユーザー定義キーとして許可する — JavaScript の言語仕様と衝突する
  - 根拠: proxy-based-type-inference — `router.ts` で予約語チェックと明示的エラーメッセージを実装

## API 設計とモジュール境界

- `[MUST]` コアロジックの入出力を Web Standard API（Request/Response）または言語標準型に正規化し、フレームワーク固有型をアダプタ層に閉じ込める
  - 根拠: architecture / adapter-implementation-patterns — `resolveResponse()` が 8+ アダプタのコアロジックを完全に単一化
- `[MUST]` 不安定な内部 API を公開する場合、パス名に不安定性を示す命名（`unstable-`, `internal-`）を含め、semver 保護対象外であることを明示する
  - 根拠: project-structure — `unstable-core-do-not-import` は名前自体が警告であり、JSDoc でも「ここからインポートするな」と記載
- `[MUST]` 非推奨 API には `@deprecated` JSDoc タグと移行先を明記し、ランタイム互換性を維持したまま段階的に廃止する
  - 根拠: design-philosophy / api-design-practices — `sse` -> `tracked`, `experimental_lazy` -> `lazy` の段階的移行
- `[SHOULD]` 実験的 API には `experimental_` プレフィックスを付与し、安定化後にプレフィックスを除去した別名を追加する
  - 根拠: design-philosophy / api-design-practices — プレフィックスによる API ライフサイクル管理
- `[SHOULD]` 外部ライブラリとの統合ポイントではダックタイピング（メソッド存在チェック）を使い、特定ライブラリへの `import` / `instanceof` 依存を避ける
  - 根拠: architecture / schema-validation-patterns — `getParseFn()` が 10 以上のバリデータをゼロ依存で統合
- `[SHOULD]` 設定オブジェクトには `ValidateShape` のような余分プロパティ検出型を適用し、TypeScript のデフォルト構造的型付けの穴を塞ぐ
  - 根拠: api-design-practices — `initTRPC.create()` でタイポや廃止オプションの混入をコンパイルエラーに
- `[SHOULD]` ライブラリのファーストパーティ adapter/プラグインは公開 API のみを使って実装し（自己消費テスト）、API の十分性を継続的に検証する
  - 根拠: project-structure — adapter コードは公開 API 経由でコアにアクセスし、不足があれば API を拡充
- `[AVOID]` lint ルールの `eslint-disable` が同一パターンで 3 箇所以上蓄積する場合、例外として放置するのではなく公開 API の拡充を検討する
  - 根拠: project-structure / dev-conventions — 例外の常態化はルールへの信頼を毀損する

## テスト

- `[MUST]` 回帰テストのファイル名にはバグトラッカーの issue 番号を含め、テストの存在理由を自明にする
  - 根拠: testing-practices — `issue-{番号}-{説明}.test.ts` の命名を 25 以上の回帰テストで一貫適用
- `[MUST]` テスト内で起動するサーバー・接続などの外部リソースは構造的にクリーンアップを保証する仕組み（`AsyncDisposable` / `afterEach` 等）を使う
  - 根拠: testing-practices — `makeAsyncResource` + `await using` でリソースリークを構造的に防止
- `[SHOULD]` パッケージ横断の統合テストは専用パッケージ/ディレクトリに集約し、エンドユーザーと同じインポートパスでテストする
  - 根拠: testing-practices / project-structure — `packages/tests/` に 76 個の統合テストを集約
- `[SHOULD]` 型推論を重視するライブラリでは `expectTypeOf` 等を使った型レベルの回帰テストを書き、型推論の退行を CI で検出する
  - 根拠: testing-practices — 回帰テストの約半数が `expectTypeOf` による型チェック
- `[SHOULD]` ドキュメントやブログ記事のコード例はテストとして実装し、ドキュメントの陳腐化を防止する
  - 根拠: testing-practices — `packages/tests/showcase/tinyrpc.test.ts` がブログ記事のコード例を保護
- `[AVOID]` テストフレームワーク提供の wait ユーティリティの代わりにサードパーティの wait 関数を使うこと — フェイクタイマーとの非互換が生じうる
  - 根拠: testing-practices — ESLint で `@testing-library/react` の `waitFor` を禁止し `vi.waitFor` を強制

## パフォーマンスとメモリ管理

- `[MUST]` 長寿命 Promise に対する `Promise.race()` をループ内で繰り返す場合、各イテレーションで subscribe を解放する仕組みを導入する
  - 根拠: streaming-patterns / performance-techniques — `Unpromise` が subscribe/unsubscribe パターンでメモリリークを構造的に防止
- `[SHOULD]` 動的にキーが追加されるルックアップ用オブジェクトには `Object.create(null)` を使い、プロトタイプチェーン由来の衝突を防ぐ
  - 根拠: architecture / performance-techniques — `emptyObject()` を 13 箇所以上で一貫使用
- `[SHOULD]` 同一イベントループ内の複数非同期呼び出しは `setTimeout(fn, 0)` + キューで 1 バッチにまとめる（DataLoader パターン）
  - 根拠: performance-techniques — `dataLoader` が同一ティック内の全呼び出しを 1 HTTP リクエストに集約
- `[SHOULD]` 非同期ジェネレータのループでは、yield 後に前イテレーションの参照を `null` で明示的に解放する
  - 根拠: streaming-patterns / performance-techniques — WS・SSE・ping の 4 箇所すべてで `result = null` を実装
- `[SHOULD]` 冪等な初期化関数は `once()` でメモ化し、センチネル値には `Symbol()` を使って `undefined`/`null` と未呼び出しを区別する
  - 根拠: performance-techniques — `once()` のセンチネルに `Symbol()` を使うことで `undefined` 戻り値でも正しく動作

## ビルドと CI/CD

- `[MUST]` モノレポでサブパスエントリポイントを持つパッケージは、エントリポイント定義を単一の場所に集約し、package.json の exports/files/main/types をビルドスクリプトから自動生成する
  - 根拠: build-and-tooling — `tsdown.config.ts` の `input` 配列のみが真実の源、`generateEntrypoints()` で 5 フィールド以上を自動生成
- `[MUST]` 不安定な言語機能やランタイム API を使用する場合、ラッパー関数に隔離して直接使用を ESLint で禁止する
  - 根拠: dev-conventions — `Symbol.dispose` を `makeResource()` でラップし、`no-restricted-syntax` の AST セレクタで直接使用を禁止
- `[MUST]` 自動リリースワークフローのトリガーにパスフィルタと除外パターンを設定し、リリースコミットによる無限ループを防止する
  - 根拠: ci-cd — `!packages/**/package.json` でバージョンバンプの変更を除外
- `[SHOULD]` テストランナーのモジュールエイリアスは package.json の exports フィールドから動的に生成し、エントリポイント追加時のテスト設定更新を不要にする
  - 根拠: build-and-tooling — `vitest.config.ts` が全パッケージの exports をスキャンしてエイリアスを自動構築
- `[SHOULD]` CI ワークフローの共通セットアップは Composite Action に集約し、言語バージョン更新を 1 箇所で管理する
  - 根拠: ci-cd — `.github/setup/action.yml` で全 11 ワークフローのセットアップを統一
- `[SHOULD]` PR ごとにライブラリパッケージを一時公開し（`pkg-pr-new` 等）、利用者が PR の変更を即座に検証できるようにする
  - 根拠: ci-cd — 全 PR で `pkg-pr-new publish` が実行されフィードバックループを短縮
- `[SHOULD]` Lint/フォーマット修正を CI で自動コミットし、スタイルに関するレビューコメントを不要にする
  - 根拠: ci-cd — `autofix-ci/action` が lint --fix / format-fix の結果を自動コミット
- `[AVOID]` E2E テストの `continue-on-error: true` を恒久的に放置する — テスト失敗が見過ごされるリスクがある
  - 根拠: ci-cd — 定期的に失敗率を監視し、安定したテストからフラグを除去する仕組みが必要

## ルール優先度の解釈

- `[MUST]`: 違反するとバグ・セキュリティリスク・重大な設計劣化を招くルール
- `[SHOULD]`: 従うことで品質が向上するが、文脈によっては例外を許容するルール
- `[AVOID]`: 意図的に避けるべきアンチパターン・非推奨プラクティス
