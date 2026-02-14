# honojs/hono -- 導出ルール集

> 出典: repos/honojs/hono/ | 生成日: 2026-02-14
> 用途: CLAUDE.md にそのまま貼り付けて AI コンテキストとして活用

## アーキテクチャ・モジュール設計

- `[MUST]` フレームワークのコア層は Web Standards（Fetch API 等）のみに依存し、ランタイム固有 API を直接参照しない
  - 根拠: architecture — Hono は `Request`/`Response` を唯一の境界とし、9 つのランタイムアダプターを 3-6 行の re-export で実現している
- `[MUST]` ランタイム固有コードはサブパスエクスポートで隔離し、コアモジュールから参照しない
  - 根拠: project-structure — `src/adapter/` は `hono-base.ts` や `context.ts` から一切 import されず、ユーザーが明示的にオプトインする設計
- `[MUST]` ライブラリのコアとアルゴリズムは interface で分離し、コアがアルゴリズムの具象クラスを直接 import しない構造にする
  - 根拠: preset-system — HonoBase は `Router<T>` インターフェースにのみ依存し、5 種類のルーター実装を一切 import していない。これにより tree-shaking とプリセット分離が成立
- `[MUST]` アダプターの責務は「外部インターフェースから内部インターフェースへの変換」に限定し、ビジネスロジックやルーティング判断を含めない
  - 根拠: adapter-pattern — Vercel/Netlify アダプターが各 3-4 行で済むのは、変換以外の責務を持たないため
- `[MUST]` プラグイン/ミドルウェアのインターフェースは最小限のメソッドで定義し、実装詳細を漏洩させない
  - 根拠: architecture — `Router<T>` は `add`/`match` の 2 メソッドのみで 5 つの全く異なるアルゴリズムを統一
- `[MUST]` ライブラリのコアモジュールは production dependencies ゼロを維持し、外部依存が必要な機能は別パッケージとして分離する
  - 根拠: dependency-management — Hono は 182 ソースファイルを擁しつつ production dependencies ゼロを達成
- `[SHOULD]` 依存関係の方向は常に「外側（具体）から内側（抽象）」へ向かわせ、内側の層が外側を参照しない
  - 根拠: architecture — アダプター/ミドルウェア/ヘルパーはすべてコアに依存するが、コアからこれらへの参照は存在しない
- `[SHOULD]` サブパスエクスポートのパス名は内部ディレクトリ構造を隠蔽し、ユーザー視点の機能名で公開する
  - 根拠: project-structure — `hono/cors`（内部: `src/middleware/cors/`）のようにフラット化し、内部の分類をユーザーに露出させていない
- `[SHOULD]` アダプターの複雑さはターゲットプラットフォームの API 乖離度に比例させ、不要な抽象化層を導入しない
  - 根拠: adapter-pattern — 9 アダプター共通の AbstractAdapter クラスを作らず、Vercel は 3 行、Lambda は 680 行と実態に即した設計
- `[SHOULD]` デフォルト構成は最も安全で高機能なものにし、軽量構成は明示的なオプトインとする
  - 根拠: preset-system — `import { Hono } from 'hono'` は最も堅牢な構成。Tiny/Quick は明示的に選択しないと適用されない
- `[SHOULD]` ヘルパー関数はフレームワークコンテキストを第一引数に受け取り、ロジック本体は Context 非依存の utils 層に委譲すること
  - 根拠: helper-utilities — 全 14 ヘルパーが Context-first パターンに従い、utils 層の単体テスト容易性とヘルパーの薄さを両立
- `[SHOULD]` 副作用のある操作（Context への書き込み）と純粋な生成処理を別関数として公開すること
  - 根拠: helper-utilities — cookie ヘルパーの `generateCookie` / `setCookie` 分離により、非リクエスト文脈でも利用可能
- `[AVOID]` コアのエントリポイントからオプショナルな機能を直接エクスポートすること
  - 根拠: project-structure — `src/index.ts` は `Hono` クラスと型のみをエクスポートし、25 のミドルウェアや 14 のヘルパーは全てサブパス経由
- `[AVOID]` プリセットやバリアント間でロジックを複製すること。共通基盤を抽象クラスとして抽出し、差分だけをサブクラスで定義する
  - 根拠: project-structure — `HonoBase`（539 行）にコア処理を集約し、各プリセットはコンストラクタでルーターを注入するだけ
- `[AVOID]` 全アダプターに共通の抽象基底クラスを作ること。各ランタイムの入出力が根本的に異なる場合、共通インターフェースの強制はアダプターを不自然に複雑にする
  - 根拠: adapter-pattern — Vercel の `handle` と Lambda の `handle` はシグネチャが異なり、統一する意味がない
- `[AVOID]` モジュールスコープに可変状態を持つこと。処理のスコープ内で状態を管理する方がリーク防止に有効
  - 根拠: helper-utilities — SSG ヘルパーの `createdDirs` がモジュールスコープで定義されており、複数回呼び出し時に前回の状態が残る潜在的バグを含む

## Web Standards・マルチランタイム

- `[MUST]` マルチランタイム対応ライブラリでは、コアの入出力境界を Web Standards API（Request/Response）で定義する
  - 根拠: design-philosophy — Hono は `fetch: (Request) => Response | Promise<Response>` を契約とし、9 つのランタイムで同一コードが動作する
- `[MUST]` Web Standards ベースのフレームワークでは、ラッパークラスに標準 API への直接アクセス手段（escape hatch）を必ず設けること
  - 根拠: web-standards — `HonoRequest.raw` により Cloudflare Workers の `cf` プロパティ等にアクセスできる
- `[MUST]` `crypto.subtle` を使用する前に存在チェックを行い、利用不可環境での振る舞いを明示的に決定すること
  - 根拠: web-standards — ユーティリティ層で `null` 返却、ミドルウェア層で起動時エラーという二段構えで対処
- `[MUST]` ストリーミング応答は Web Standard API（ReadableStream / TransformStream）のみで実装し、ランタイム固有の Stream API に依存しない
  - 根拠: streaming — Hono は全ストリーミング実装を Web Standards で統一し、複数ランタイムで同一コードを動作させている
- `[SHOULD]` 暗号・ハッシュ処理は Web Crypto API (`crypto.subtle`) を使い、ランタイム固有の crypto モジュールに依存しない
  - 根拠: design-philosophy — JWT 実装とハッシュ実装は全て `crypto.subtle` で統一
- `[SHOULD]` `Request`/`Response` コンストラクタをデータ変換ユーティリティとして活用し、自前パーサーの実装を避けること
  - 根拠: web-standards — `bufferToFormData()` が `new Response(buf, { headers }).formData()` で multipart パースを実現
- `[SHOULD]` ストリーミングレスポンスには `TransformStream` でペアを生成し、書き込み側と読み取り側の関心を分離すること
  - 根拠: web-standards — `stream()` ヘルパーが `TransformStream` ベースで統一的にストリーミングを実装
- `[SHOULD]` Push 型ストリーミングが必要な場合、TransformStream を仲介して WritableStream 側に書き込む設計にする
  - 根拠: streaming — ReadableStream の pull モデルよりも TransformStream の writable 側に write する方がサーバーサイドのユースケースに自然
- `[SHOULD]` ランタイム固有の差異吸収は、ヘルパー本体ではなく専用の検出関数に局所化すること
  - 根拠: helper-utilities — `isOldBunVersion()` や `getRuntimeKey()` が分離されているため、ランタイム対応の変更がビジネスロジックに波及しない
- `[AVOID]` フレームワークのコア部分に外部依存を追加してマルチランタイム互換性を損なうこと
  - 根拠: design-philosophy — Hono は dependencies ゼロを維持し、Web Standards API で全ユーティリティを自前実装
- `[AVOID]` `Request.body` を標準メソッド（`.json()`, `.text()` 等）とラッパーメソッドの両方で消費すること。ボディキャッシュの一貫性が崩れる
  - 根拠: web-standards — `cloneRawRequest()` は `bodyCache` からの復元に依存しており、`raw` 経由の直接消費では復元に失敗する
- `[AVOID]` アダプター層でランタイムの動的検出を行うこと。アダプターはビルド時にランタイムが確定しているべきで、実行時分岐はヘルパー層に隔離する
  - 根拠: adapter-pattern — `getRuntimeKey()` は `src/helper/adapter/` に隔離されており、`src/adapter/` 内のコードはランタイム検出を行わない

## 型システム・型安全性

- `[MUST]` 型レベルの API 契約を設計する場合、Phantom Type でランタイムに影響しないメタデータを伝搬させ、型情報の損失を防ぐこと
  - 根拠: type-system — `TypedResponse<T, U, F>` は `_data`, `_status`, `_format` でレスポンス型情報を保持し、RPC クライアントまで型を伝搬
- `[MUST]` `any` 型が型パラメータに混入する可能性がある場合、インターセクション前に `IsAny` ガードで `{}` に正規化すること
  - 根拠: type-system — `any & T = any` により型情報が消失するため、`IntersectNonAnyTypes` で `any` を除去
- `[MUST]` ミドルウェアが共有コンテキストに書き込む変数は、型レベルでキーと値の型を宣言する
  - 根拠: context-design — `Env['Variables']` と `ContextVariableMap` の二重レイヤーで型安全性を確保
- `[MUST]` フレームワークのバリデーション層は特定のバリデーションライブラリに依存せず、コールバック関数の型シグネチャを統合契約として設計する
  - 根拠: validator-system — `validator(target, fn)` のコールバックパターンにより、Zod/Valibot 等あらゆるライブラリとの統合を可能にしている
- `[MUST]` バリデーション結果の型を `in`（入力型）と `out`（出力型）に分離し、transform 前後の型を正確にハンドラーとクライアントに伝搬させる
  - 根拠: validator-system — `InferInput` 型ユーティリティがリテラルユニオンやオプショナル型を保持しつつ、ターゲット固有のデフォルト型に変換
- `[MUST]` 型安全 RPC を実現する際、サーバー側の型情報は一方向に流し、共有スキーマファイルへの依存を避ける
  - 根拠: client-rpc — `typeof app` だけでクライアント型を導出しており、IDL やコード生成が不要
- `[MUST]` メソッドチェインで型を累積する API では、チェインの戻り値型を `S & NewSchema` のように intersection で拡張し、途中結果の型情報を保持する
  - 根拠: client-rpc — `HandlerInterface` がすべてのオーバーロードで `S & ToSchema<...>` を返すことで、ルート定義の型情報が欠落しない
- `[SHOULD]` プラグイン/ミドルウェアの型拡張ポイントには空インタフェースと Declaration Merging を使う
  - 根拠: context-design — `ContextVariableMap` は空インタフェースとして定義され、ミドルウェアが `declare module` で型を追加する仕組みを実現
- `[SHOULD]` コンテキストの変数ストアには読み取り専用ビューと書き込み API を分離して提供する
  - 根拠: context-design — `c.var` は `Readonly<>` でラップされた参照専用、`c.set()`/`c.get()` はミドルウェアでの読み書き用
- `[SHOULD]` JSON レスポンスの型にはシリアライズ後の型（`JSONParsed<T>`）を使い、クライアントが受け取る実際のデータ型と一致させること
  - 根拠: type-system — `Date` → `string`、`undefined` → フィールド除外など、`JSON.stringify` の変換を型で再現しないとクライアント側で型不一致が起きる
- `[SHOULD]` 型と実装を分離する場合、型テスト（`expectTypeOf` 等）で型契約の網羅的な検証を行い、実装の `as any` と型定義の整合性を保証すること
  - 根拠: type-system — `src/types.test.ts` で型レベルの期待値を記述し、`as any` を使う実装側との整合性を型テストで担保
- `[SHOULD]` HTTP メソッドの制約（GET/HEAD はボディを持たない等）を型システムで強制する
  - 根拠: validator-system — `ValidationTargetByMethod<M>` 型により、GET リクエストに `validator('json', ...)` を指定するとコンパイルエラーになる
- `[SHOULD]` レスポンス型はステータスコードで絞り込み可能にし、エラーハンドリングの型安全性を確保する
  - 根拠: client-rpc — `InferResponseType<T, 200>` により成功時のレスポンス型のみを抽出可能
- `[AVOID]` グローバルな型空間（Declaration Merging）で汎用的なキー名を使う
  - 根拠: context-design — `ContextVariableMap` は全ミドルウェアが共有するグローバル型空間であり、汎用名はキー衝突による intersection 型の問題を引き起こす
- `[AVOID]` メソッドチェインの結果を変数に保持せず、後から型を取得しようとすること（型情報が蓄積されない）
  - 根拠: client-rpc — `app.get(...)` の戻り値を捨てると `Schema` 型パラメータが更新されず、`typeof app` が空のスキーマになる
- `[AVOID]` 型レベルの再帰的な文字列パースにおいて、Union 型が膨張するパターンを作ること
  - 根拠: type-system — `ExtractParams` は条件型の分配を制御し、非リテラル型が入った場合のフォールバックを明示

## パフォーマンス最適化

- `[MUST]` ルーティングライブラリでは、静的ルートをハッシュマップで O(1) 参照するファストパスを設ける
  - 根拠: performance — RegExpRouter は `staticMap[path]` で正規表現を経由せずに即座に返す
- `[MUST]` 初期化コストの高い処理は初回呼び出し時に遅延実行し、結果をキャッシュまたは自己書き換えで以降の呼び出しから除去する
  - 根拠: performance — RegExpRouter の `match()` は初回で `buildAllMatchers()` を実行した後 `this.match` を上書きし、2 回目以降は構築判定が不要
- `[MUST]` リクエストスコープのコンテキストオブジェクトでは、使用頻度の低いフィールドを遅延初期化（`??=`）する
  - 根拠: context-design — `#req`, `#var`, `#preparedHeaders` をすべて遅延初期化しており、使われないフィールドのアロケーションコストをゼロにしている
- `[SHOULD]` Hot Path（最頻実行パス）では抽象化レイヤーをバイパスする最適化を実装する
  - 根拠: architecture — シングルハンドラー最適化は `compose` をスキップし、同期レスポンスでは Promise のオーバーヘッドも回避
- `[SHOULD]` 単一ハンドラのケースでは合成をバイパスし、直接実行する最適化を実装すること
  - 根拠: middleware-system — `matchResult[0].length === 1` の場合に `compose` をスキップし、同期ハンドラでは Promise 生成すら回避
- `[SHOULD]` 性能特性の異なる複数のアルゴリズムを提供し、自動選択メカニズムでユーザーの選択負荷を排除する
  - 根拠: performance — SmartRouter は RegExpRouter を優先試行し、UnsupportedPathError 時に TrieRouter にフォールバック
- `[SHOULD]` ホットパスでのオブジェクト生成では `Object.create(null)` を使い、プロトタイプチェーン探索を排除する
  - 根拠: performance — ルーター実装全体で 19 箇所 `Object.create(null)` を使用
- `[SHOULD]` URL パースなどリクエストごとに実行される処理では、一般的なケースを先に検出して高コストな変換をスキップする
  - 根拠: performance — `getPath()` は `charCodeAt()` ループで `%` を検出し、含まれない場合は `decodeURI` を完全にスキップ
- `[SHOULD]` ホットパスのレスポンスメソッドには条件分岐によるファストパスを設ける
  - 根拠: context-design — `c.text()` はヘッダー/ステータスが未設定の場合に直接 `new Response(text)` を返すファストパスを持つ
- `[SHOULD]` ランタイム差異の検出結果はメモ化（Self-Replacing Function 等）してホットパスのコストをゼロにする
  - 根拠: streaming — `isOldBunVersion()` は初回呼び出し後に関数自体を結果で上書きし、以降のオーバーヘッドを排除
- `[AVOID]` ルーティングで各ルートに個別の正規表現を持たせ、リクエストごとに線形走査する設計
  - 根拠: performance — PatternRouter はバンドルサイズ最小化のために意図的にこの設計を選んでいるが、ルート数増加に伴い O(n) で劣化
- `[AVOID]` ビルドフェーズで生成した一時キャッシュをランタイムに持ち越す
  - 根拠: performance — RegExpRouter は `buildAllMatchers()` 完了後に `this.#middleware`、`this.#routes`、`wildcardRegExpCache` をすべて解放
- `[AVOID]` `c.var` のような変換コストを伴う getter をループ内で繰り返し呼ぶ
  - 根拠: context-design — `c.var` は `Object.fromEntries(this.#var)` を毎回実行するため、アクセスごとに新しいオブジェクトが生成される

## ミドルウェア・エラーハンドリング

- `[MUST]` onion 型ミドルウェアでは `next()` の戻り値を必ず `await` すること
  - 根拠: middleware-system — `await` なしでは後続ミドルウェアの完了を待たず後処理が実行され、レスポンスの変更やエラーハンドリングが正しく動作しない
- `[MUST]` ミドルウェア合成関数（compose）は `next()` の二重呼び出しを検出して例外を投げること
  - 根拠: middleware-system — `compose.ts` は `index` の単調増加をチェックし、二重呼び出しで即座にエラーを投げる
- `[MUST]` カスタムエラークラスは標準の `Error` を継承し、`throw` で利用する。非 Error オブジェクトの throw はエラーハンドリングパイプラインをバイパスする
  - 根拠: error-handling — `compose.ts` で `err instanceof Error` チェックがあり、Error でなければ `onError` が呼ばれず再 throw される
- `[MUST]` HTTP エラーレスポンスにカスタムヘッダーやボディが必要な場合、レスポンスオブジェクトをエラーに同梱して throw する
  - 根拠: error-handling — 全認証ミドルウェアが `new HTTPException(status, { res })` パターンを統一的に採用
- `[MUST]` カスタム `onError` ハンドラを設定する場合、`HTTPException`（または `getResponse()` を持つエラー）を明示的に処理する分岐を含める
  - 根拠: error-handling — デフォルトハンドラの `'getResponse' in err` 分岐がカスタムハンドラでは自動適用されない
- `[SHOULD]` ミドルウェアファクトリは設定をクロージャにキャプチャし、リクエストごとの再計算を避けること
  - 根拠: middleware-system — 全組み込みミドルウェアがこのパターンを採用し、正規表現のコンパイルやオプションのマージを初期化時に一度だけ行っている
- `[SHOULD]` ミドルウェアの返却関数には名前付き関数式を使い、スタックトレースでの識別を容易にすること
  - 根拠: middleware-system — 全ミドルウェアが `return async function middlewareName(c, next) { ... }` パターンを採用
- `[SHOULD]` エラーの原因チェーンを `cause` オプションで維持する。低レベルのエラーを握りつぶさず、`Error.cause` で伝播させる
  - 根拠: error-handling — JWT ミドルウェアが catch したエラーを `cause` として HTTPException に渡しトレーサビリティを確保
- `[SHOULD]` エラーのプロトコル判定にはダックタイピング（`'method' in obj`）を使い、`instanceof` への依存を避ける
  - 根拠: error-handling — `'getResponse' in err` で判定し、異なるパッケージバージョンやバンドラー環境での互換性が向上
- `[SHOULD]` バリデーション関数の「戻り値型」で成功/失敗の制御フローを表現する（Response 返却 = エラー、データ返却 = 成功）
  - 根拠: validator-system — `res instanceof Response` による分岐で、例外に頼らないエラーハンドリングを実現
- `[SHOULD]` セキュリティに関わるデフォルト値は安全側に倒し、危険な動作はオプトインにすること
  - 根拠: helper-utilities — proxy ヘルパーの `strictConnectionProcessing: false` や cookie の prefix 指定時の `secure: true` 強制
- `[AVOID]` ミドルウェア内で `context.res` を無条件に上書きすること。ヘッダ追加は安全だが、body やステータスの変更は `finalized` 状態を確認すべき
  - 根拠: middleware-system — `set res` が `finalized = true` を設定するため、先行ミドルウェアの結果を意図せず破壊するリスクがある
- `[AVOID]` ミドルウェアチェーンの中断を暗黙的に行うこと。中断する場合は `HTTPException` を throw するか Response を return して意図を明示すべき
  - 根拠: middleware-system — `next()` を呼ばないだけの暗黙的中断は、後続ハンドラの未実行が検出しづらい
- `[AVOID]` ストリーミング応答に ETag・圧縮などボディ全体を必要とするミドルウェアを適用する
  - 根拠: streaming — Hono の圧縮正規表現は `text/event-stream` を明示的に除外しており、ストリーミングとバッファリング系ミドルウェアの非互換性が設計レベルで認識されている

## テスト戦略

- `[MUST]` マルチランタイム対応ライブラリでは、コアロジックのテストをランタイム非依存な層で実行し、ランタイム固有テストはアダプター層の最小限の検証に留める
  - 根拠: testing-strategy — 117 ファイルのコアテストを Vitest/Node.js で実行し、7 ランタイムの固有テストは合計 13 ファイルに抑えている
- `[MUST]` Strategy パターンで複数実装を切り替える場合、全実装が共有するテストスイートを用意し、非対応ケースは理由付きで明示的にスキップする
  - 根拠: router-design — `common.case.test.ts` で 5 種ルーターの行動互換を保証し、各ルーターの `skip` 配列で非対応パターンを可視化
- `[MUST]` 共通テストスイートを関数としてエクスポートする場合、テスト発見から除外する命名規則と設定の除外パターンを組み合わせて直接実行を防止する
  - 根拠: testing-strategy — `vitest.config.ts` の `exclude: ['**/*.case.test.*']` がなければテストが引数なしで実行され失敗する
- `[SHOULD]` Web Standards API に基づくフレームワークでは、`app.request()` のような HTTP サーバー不要のテストメソッドをフレームワーク本体に組み込む
  - 根拠: testing-strategy — `src/hono-base.ts` の `request()` メソッドにより、全コアテストが HTTP サーバー起動なしで実行
- `[AVOID]` ランタイム固有テストでコアロジックを再テストすること。各ランタイムのテストはアダプター層の変換ロジックとランタイム検出のみに集中すべき
  - 根拠: testing-strategy — コアロジックは別環境で十分にテスト済みであり、重複はメンテナンスコストを増加させるだけ

## ビルド・パッケージ品質

- `[MUST]` ESM/CJS デュアルパッケージでは `exports` フィールドに `types` → `import` → `require` の順序で条件を定義し、各条件が指すファイルの存在を publint 等で自動検証する
  - 根拠: build-system — 70 以上のエクスポートで `types` を最優先に配置し、`postbuild` で publint を実行してファイル参照の正当性を保証
- `[MUST]` 複数のパッケージレジストリ（npm + JSR 等）にパブリッシュする場合、エクスポートマップの整合性をビルド時に自動検証する仕組みを設ける
  - 根拠: build-system — `validateExports` で `package.json` と `jsr.json` を双方向にクロスチェック
- `[MUST]` 複数の構成プリセットを提供する場合、各プリセットを独立した exports エントリポイントとして公開し、使用しないコードがバンドルに含まれないことを物理的に保証する
  - 根拠: preset-system — `"./tiny"`, `"./quick"` の各エントリポイントが独立した依存グラフを形成
- `[SHOULD]` ビルドパイプラインではツールごとの責務を分離し、トランスパイル・型定義生成・パッケージ検証を独立したステップとして並列実行する
  - 根拠: build-system — `Promise.all` で ESM ビルド・CJS ビルド・tsc を並列実行し、ビルド速度と正確性を両立
- `[SHOULD]` エントリポイントは glob パターンで自動収集し、除外リストで制御する。手動列挙はモジュール追加時の設定変更漏れリスクがある
  - 根拠: build-system — `glob.sync('./src/**/*.ts', { ignore: [...] })` で全ソースファイルを自動収集
- `[SHOULD]` CJS 互換が必要な場合、ルートの `"type": "module"` と `dist/cjs/package.json` の `"type": "commonjs"` で Node.js のモジュール解決規則を利用する
  - 根拠: build-system — 3 行の `package.cjs.json` をコピーするだけで CJS サブディレクトリを成立させている
- `[SHOULD]` ビルドの postbuild フックで publint を実行し、パッケージ品質を自動検証する
  - 根拠: dependency-management — `"postbuild": "publint"` により、壊れたパッケージの公開を開発時点で防止
- `[AVOID]` ソースコードのインポートパスにビルド出力用の拡張子（`.js`）をハードコードすること
  - 根拠: build-system — `addExtension` プラグインでビルド時に `.js` 拡張子を付与し、ソースコードは拡張子なしインポートのまま

## ストリーミング・リアルタイム通信

- `[MUST]` SSE レスポンスには `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `Transfer-Encoding: chunked` の 4 ヘッダーを設定する
  - 根拠: streaming — `streamSSE()` が毎回これら 4 ヘッダーを明示的に設定しており、テストでも検証されている
- `[MUST]` SSE の data フィールド内の改行は `\r\n` / `\r` / `\n` のすべてを `data:` プレフィックス付き複数行に変換する
  - 根拠: streaming — SSE 仕様では改行はメッセージ区切りと解釈されるため、data 内の改行は `data:` を繰り返す必要がある
- `[MUST]` SSR 用 JSX エンジンでは、文字列結合の同期パスと非同期パスを明確に分離し、同期パスでは Promise を一切生成しないこと
  - 根拠: jsx-engine — `StringBuffer` 設計では `buffer.length === 1` チェックで同期パスを分岐し、不要なメモリアロケーションを回避
- `[MUST]` HTML 文字列を生成する JSX エンジンでは、エスケープ済みフラグ（`isEscaped`）を型レベルで管理し、二重エスケープを防止すること
  - 根拠: jsx-engine — `HtmlEscaped` インターフェースで `isEscaped: true` を強制し、セキュリティと正確性を両立
- `[SHOULD]` ストリーミング API の `write()` / `close()` は例外を内部で吸収し、エラーハンドリングは専用のコールバック経路で提供する
  - 根拠: streaming — クライアント切断は正常系の一部であり、`write()` が例外を投げるとアプリケーションコードに不要な try-catch が必要になる
- `[SHOULD]` GC されるべきオブジェクトへの一時的な参照保持には `WeakMap` を使い、ストリーム完了後の自動解放を保証する
  - 根拠: streaming — `contextStash` が `WeakMap<ReadableStream, Context>` で実装され、メモリリークを防止
- `[SHOULD]` 複数のレンダリングバックエンド（SSR / DOM）を持つ JSX エンジンでは、Symbol ベースのディスパッチでコンポーネントに環境別ロジックをアタッチすること
  - 根拠: jsx-engine — `DOM_RENDERER` Symbol でコンポーネント関数にクライアント用レンダラーを付与

## ルール優先度の解釈

- `[MUST]`: 違反するとバグ・セキュリティリスク・重大な設計劣化を招くルール
- `[SHOULD]`: 従うことで品質が向上するが、文脈によっては例外を許容するルール
- `[AVOID]`: 意図的に避けるべきアンチパターン・非推奨プラクティス
