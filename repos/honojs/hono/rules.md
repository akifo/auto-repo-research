# honojs/hono -- 導出ルール集

> 出典: repos/honojs/hono/ | 生成日: 2026-02-14
> 用途: CLAUDE.md にそのまま貼り付けて AI コンテキストとして活用

## インターフェース設計と抽象化

- `[MUST]` 差し替え可能にしたいコンポーネントのインターフェースは必要最小限のメソッドに絞る（目安: 3 メソッド以内）
  - 根拠: architecture, abstraction-patterns, extensibility-mechanisms -- Router<T> が `add`/`match` の 2 メソッドで 5 種の実装と SmartRouter による自動選択を成立させている
- `[MUST]` ミドルウェア合成関数の入力と出力を同一のシグネチャに統一し、合成結果をさらに合成可能にする（代数的閉包性）
  - 根拠: composition-patterns -- `compose` の出力が `(context, next) => Promise<Context>` であり再帰的合成が可能
- `[SHOULD]` クラス継承による拡張点提供より、関数注入（コールバック / 高階関数）を優先する
  - 根拠: architecture, abstraction-patterns -- serveStatic が `getContent` 関数注入でランタイム差異を吸収し、各アダプターが 10-30 行で完結
- `[SHOULD]` 「できないこと」を専用のエラー型で表明し、呼び出し側が `instanceof` で構造的にフォールバックできるようにする
  - 根拠: abstraction-patterns -- `UnsupportedPathError` により SmartRouter が各ルーターの能力境界を安全に判定
- `[SHOULD]` プラグインやミドルウェアの型拡張には、ジェネリクス型パラメータ（インスタンス単位）と Declaration Merging（グローバル単位）の二つの経路を用意する
  - 根拠: type-system-patterns, extensibility-mechanisms -- `Env['Variables']` と `ContextVariableMap` の二重拡張メカニズム
- `[AVOID]` インターフェースの実装数が 1 つしかない段階でインターフェースを切り出す（YAGNI 違反）
  - 根拠: abstraction-patterns -- Hono は `Router<T>` に 5 実装、`GetConnInfo` に 5 実装と、複数の具象が存在する場合にのみインターフェースを導入

## ミドルウェア・プラグイン設計

- `[MUST]` ミドルウェア/プラグインはファクトリ関数パターン `(options?) => handler` で設計し、ハンドラのシグネチャを統一する
  - 根拠: extensibility-mechanisms, composition-patterns -- 全 25 種の組み込みミドルウェアがこのパターンに従い、`some()`/`every()`/`except()` による論理合成を実現
- `[MUST]` ファクトリ関数から返すミドルウェア/ハンドラには名前付き関数式を使い、スタックトレースでの識別を可能にする
  - 根拠: composition-patterns, project-structure, api-design-practices -- 全ミドルウェアが `return async function cors(c, next)` 形式で統一
- `[MUST]` パイプライン中の `next()` の多重呼び出しを検出してエラーにする不変量ガードを設ける
  - 根拠: composition-patterns -- `compose.ts` でインデックス比較による多重呼び出し検知
- `[SHOULD]` ファクトリ関数では、設定値の解析・バリデーション・前計算をファクトリ呼び出し時に実行し、リクエストハンドラ本体では事前計算済みの値のみを参照する
  - 根拠: composition-patterns -- CORS ミドルウェアの `findAllowOrigin` を IIFE で 1 回だけ構築、Bearer Auth の正規表現をファクトリ時にコンパイル
- `[SHOULD]` 合成プリミティブ（AND/OR/NOT 等）を小さく定義し、複雑な合成をプリミティブの組み合わせで構築する
  - 根拠: composition-patterns -- `except` が `some` と `every` の合成で実現されている
- `[SHOULD]` オプション引数はオブジェクト形式で受け取り、すべてのフィールドに合理的なデフォルト値を設定して引数なし呼び出しを可能にする
  - 根拠: api-design-practices -- `cors()`, `logger()`, `prettyJSON()` がすべて引数なしで動作
- `[AVOID]` 合成ラッパーで元のハンドラへの参照を失わせる -- 合成が不透明な箱になるとデバッグ・テスト・検査が困難になる
  - 根拠: composition-patterns -- `COMPOSED_HANDLER` で元ハンドラへの参照を保持し再帰的アンラップ可能

## パフォーマンス最適化

- `[MUST]` ホットパスでハッシュマップとして使うオブジェクトは `Object.create(null)` で生成する
  - 根拠: performance-techniques, design-philosophy, abstraction-patterns -- 全ルーター実装で 20 箇所以上で徹底使用
- `[MUST]` 初期化が高コストな処理は初回実行時にのみビルドし、結果をメソッド置換またはキャッシュで後続の呼び出しに引き渡す
  - 根拠: performance-techniques, architecture -- SmartRouter と RegExpRouter のメソッド自己書き換えパターン
- `[SHOULD]` リクエスト処理のホットパスでは `new URL()` や `URLSearchParams` を避け、`indexOf`/`charCodeAt`/`slice` による文字列操作でパスやクエリを抽出する
  - 根拠: performance-techniques, design-philosophy, dependency-management -- `getPath()` の charCodeAt ベースパース
- `[SHOULD]` ホットパスでは頻出ケースを特別扱いする早期リターンを設ける（例: 単一ハンドラなら合成処理をスキップ）
  - 根拠: performance-techniques, architecture, composition-patterns -- `matchResult[0].length === 1` で compose をバイパス
- `[SHOULD]` 頻繁にアクセスされるがすべてのリクエストで必要とは限らないオブジェクトは、`??=` による遅延初期化で生成コストを先送りする
  - 根拠: api-design-practices, performance-techniques -- `Context.req`, `bodyCache`, `#var` Map などで一貫して適用
- `[SHOULD]` 空オブジェクトや空配列など頻出する不変値はモジュールレベルのシングルトンとして定義し、インスタンス生成ごとのアロケーションを避ける
  - 根拠: performance-techniques, dependency-management -- `emptyParams` が 4 ルーターで共有
- `[SHOULD]` 頻繁にインスタンス化される Web API オブジェクト（`TextEncoder`, `TextDecoder`）はモジュールスコープでシングルトン化する
  - 根拠: dependency-management -- `utf8Encoder`/`utf8Decoder` をモジュールレベルで共有
- `[AVOID]` ビルドフェーズで確定するデータ構造を実行時に毎回再構築する
  - 根拠: performance-techniques -- `PreparedRegExpRouter` が正規表現をビルド時にシリアライズ

## 型安全性

- `[MUST]` 型合成パイプラインでは `any` をフィルタするガードユーティリティ（`IsAny<T>`, `IfAnyThenEmptyObject<T>` 等）を導入し、合成結果が `any` に崩壊することを防ぐ
  - 根拠: type-system-patterns -- `IntersectNonAnyTypes` が `ProcessHead` で `any` を `{}` に変換
- `[MUST]` ファントム型のプロパティは `_` 接頭辞やブランドプロパティで命名し、ランタイムで直接アクセスされることを防ぐ
  - 根拠: type-system-patterns -- `TypedResponse<T, U, F>` の `_data`, `_status`, `_format`
- `[MUST]` ブランド型のランタイム付与は専用のファクトリ関数に集約し、他の箇所では型アサーションなしで利用できるようにする
  - 根拠: metaprogramming-techniques -- `raw()` 関数が `HtmlEscapedString` を作る唯一のエントリポイント
- `[SHOULD]` 文字列リテラルから構造情報を抽出する場面では Template Literal Types の再帰分解を使い、ユーザーが型アノテーションなしでも型安全を享受できるようにする
  - 根拠: type-system-patterns -- `ParamKeys<Path>` が URL パスからパラメータ名を自動抽出
- `[SHOULD]` 条件型のデフォルト型パラメータを活用し、ジェネリクスの明示指定なしでもコンテキストに応じた適切な型が推論されるようにする
  - 根拠: type-system-patterns -- `TypedResponse` のフォーマットパラメータがレスポンス型から自動推論
- `[SHOULD]` 型推論の正確性を `expectTypeOf()` 等でテストし、型の回帰を CI で検知する
  - 根拠: testing-practices -- 16 ファイル・640 箇所以上の `expectTypeOf()` が型推論を検証
- `[AVOID]` TypeScript のオーバーロードを手動で N 個複製する方式を最初の選択肢にしない。まず Variadic Tuple Types やヘルパー型で抽象化可能か検討する
  - 根拠: type-system-patterns, metaprogramming-techniques -- `HandlerInterface` の約 20 オーバーロードは保守コストが高い

## エラーハンドリング

- `[MUST]` HTTP レイヤーのエラーは専用の HTTP 例外クラスで throw し、ステータスコードを必ず含める
  - 根拠: error-handling-idioms -- 全ミドルウェアが `HTTPException(status, options)` を使用
- `[MUST]` ミドルウェアチェーン内で throw するオブジェクトは必ず `Error` のインスタンスにする
  - 根拠: error-handling-idioms -- `compose` は `err instanceof Error` で判定し、非 Error は再 throw
- `[SHOULD]` 例外オブジェクトにクライアント向けのレスポンスを同梱し、エラーハンドラが Response の詳細を知らなくても済むようにする
  - 根拠: error-handling-idioms -- 認証ミドルウェア群が `HTTPException` の `res` に `WWW-Authenticate` ヘッダ付き Response を渡す
- `[SHOULD]` 例外の `cause` にオリジナルのエラーを保持し、エラーチェーンのトレーサビリティを確保する
  - 根拠: error-handling-idioms -- JWT ミドルウェアが検証ライブラリの例外を `cause` として保持
- `[SHOULD]` 設定時エラー（必須オプション未指定等）とリクエスト時エラー（認証失敗等）を異なるエラー型で分離する
  - 根拠: error-handling-idioms -- 設定不備は通常の `Error`、リクエスト処理中の失敗は `HTTPException`
- `[AVOID]` エラー型の深い継承階層を作る。HTTP エラーはステータスコード + オプションの組み合わせで十分に分類できる
  - 根拠: error-handling-idioms -- 21 ファイルで `HTTPException` 使用、サブクラスはゼロ

## セキュリティ

- `[MUST]` 認証トークン・パスワード等の秘密情報の比較にはタイミングセーフな比較関数を使う
  - 根拠: security-practices -- Basic Auth / Bearer Auth でハッシュ後の `timingSafeEqual` を使用
- `[MUST]` JWT 検証時はサーバー側で許可するアルゴリズムを明示的に指定し、トークンヘッダーの `alg` をそのまま信頼しない
  - 根拠: security-practices -- `jwt()` が `alg` を必須オプションとし、JWK 検証では対称アルゴリズムを拒否
- `[MUST]` セキュリティヘッダーはデフォルトで有効にし、無効化を明示的な選択にする
  - 根拠: security-practices -- `secureHeaders()` が引数なしで 11 個のヘッダー + `X-Powered-By` 削除を有効化
- `[SHOULD]` 暗号処理には Web Crypto API（`crypto.subtle`）を使い、ランタイム可搬性を確保する
  - 根拠: security-practices, dependency-management -- ハッシュ・署名・検証のすべてが `crypto.subtle` 経由
- `[SHOULD]` CORS でオリジンを動的に返す場合は `Vary: Origin` をレスポンスに含め、CDN キャッシュ汚染を防ぐ
  - 根拠: security-practices -- `cors()` が `origin !== '*'` の場合に `Vary: Origin` を自動付与
- `[AVOID]` Origin ヘッダーや `Sec-Fetch-Site` ヘッダーが未設定の場合にリクエストを許可する -- 未設定は「不明」であり「安全」ではない
  - 根拠: security-practices -- CSRF ミドルウェアが Origin 未設定で一律 `false`

## ストリーミング

- `[MUST]` ストリーミングレスポンスの生成には TransformStream でペアを作り、writable 側を書き込み用、readable 側をレスポンスボディ用に分離する
  - 根拠: streaming-patterns -- `stream()`, `streamSSE()`, `streamText()` の全てがこの構造を採用
- `[MUST]` ストリームのコールバック実行は try/finally で囲み、finally で必ず close() を呼ぶ
  - 根拠: streaming-patterns -- 全ストリームヘルパーが `try { await cb(stream) } finally { stream.close() }` を採用
- `[SHOULD]` ストリームに関連する外部リソースの参照が WeakMap で管理されているか確認する（メモリリーク防止）
  - 根拠: streaming-patterns -- `WeakMap<ReadableStream, Context>` でストリーム GC 時に自然解放
- `[SHOULD]` SSE レスポンスでは必須 4 ヘッダー（`Transfer-Encoding: chunked`, `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`）をセットで設定する
  - 根拠: streaming-patterns -- `streamSSE()` がこの 4 ヘッダーを常にセット
- `[AVOID]` SSE ストリームに標準以外の Content-Type を設定する（圧縮ミドルウェアによりバッファリングが発生し段階的送信が壊れる）
  - 根拠: streaming-patterns -- compress ミドルウェアが `text/event-stream` のみを否定先読みで除外

## ビルド・パッケージング

- `[MUST]` ESM/CJS デュアル出力時、各エクスポートエントリに `types` / `import` / `require` の 3 条件を全て定義する
  - 根拠: build-and-tooling -- 60 以上のエントリで 3 条件トリプレットを徹底
- `[MUST]` ビルドパイプラインに公開前検証ステップ（`publint` 等）を組み込み、`exports` フィールドと実ファイルの整合性を機械チェックする
  - 根拠: build-and-tooling -- `postbuild` フックで `publint` を自動実行
- `[SHOULD]` 複数レジストリに公開する場合、ビルド時にエクスポート定義を相互検証して片方だけに存在するエントリを検出する
  - 根拠: build-and-tooling, project-structure -- `validateExports` を双方向に呼び出し
- `[SHOULD]` ビルドスクリプト自体にユニットテストを書き、ビルドロジックの正しさをテストスイートで保証する
  - 根拠: build-and-tooling -- `validate-exports.test.ts` と `remove-private-fields.test.ts`
- `[SHOULD]` 開発用とビルド用の tsconfig を分離し、ビルド時のみ `noUnusedLocals` / `noUnusedParameters` を有効化する
  - 根拠: build-and-tooling, dev-conventions -- `tsconfig.build.json` が `tsconfig.json` を extends して厳格化
- `[AVOID]` ESM パッケージで CJS 出力が必要な場合に拡張子を `.cjs` に変更する。代わりにサブディレクトリに `{"type": "commonjs"}` の `package.json` を配置する
  - 根拠: build-and-tooling -- `dist/cjs/package.json` に 3 行の JSON を置くだけで CJS 解決を実現

## テスト

- `[MUST]` テストの入出力を Web 標準 API（Request/Response）に統一し、ランタイム固有の API をテスト境界に限定する
  - 根拠: testing-practices -- 785 箇所以上の `app.request()` が `Request`/`Response` で完結
- `[MUST]` 共通テストスイートを複数の実装に対して実行する場合、対応不可能なケースは理由付きの宣言的スキップ機構で管理する
  - 根拠: testing-practices -- `skip: [{ reason, tests }]` 構造で各ルーターの制約を自己文書化
- `[SHOULD]` HTTP フレームワークのテストではサーバーを起動せず `app.request()` 相当の軽量実行パスを用意し、ランタイムテストはランタイム固有の動作検証のみに絞る
  - 根拠: testing-practices -- メインテスト 3,673 行はサーバーレス、ランタイムテストは差分のみ
- `[SHOULD]` テスト用のモックは Web API 境界（`vi.stubGlobal`）に限定し、アプリケーション層にモック用の DI 機構を持ち込まない
  - 根拠: testing-practices -- グローバル API 層でモック注入、プロダクションコードにテスト用分岐なし
- `[SHOULD]` テストスクリプトでは型チェック（`tsc --noEmit`）をテスト実行の前に配置する
  - 根拠: dev-conventions -- `"test": "tsc --noEmit && vitest --run"` で型エラーを先に報告
- `[AVOID]` ランタイム固有テストにランタイム非依存のロジックテストを含める
  - 根拠: testing-practices -- 「Test just only minimal patterns」の方針で重複テストを回避

## ルール優先度の解釈

- `[MUST]`: 違反するとバグ・セキュリティリスク・重大な設計劣化を招くルール
- `[SHOULD]`: 従うことで品質が向上するが、文脈によっては例外を許容するルール
- `[AVOID]`: 意図的に避けるべきアンチパターン・非推奨プラクティス
