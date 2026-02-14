# honojs/hono — 導出ルール集

> 出典: repos/honojs/hono/ | 生成日: 2026-02-14
> 用途: CLAUDE.md にそのまま貼り付けて AI コンテキストとして活用

## アーキテクチャ・レイヤー分離

- `[MUST]` フレームワークのコア層は Web Standards（Fetch API: Request/Response）のみに依存し、ランタイム固有 API を直接参照しない
  - 根拠: architecture — `Request`/`Response` を唯一の境界とし、9 つのランタイムアダプターを 3-6 行の re-export で実現
  - 根拠: design-philosophy — `fetch: (Request) => Response | Promise<Response>` を契約とし、9 つのランタイムで同一コードが動作
- `[MUST]` ランタイム固有コードはサブパスエクスポートで隔離し、コアモジュールから参照しない
  - 根拠: project-structure — `src/adapter/` は `hono-base.ts` や `context.ts` から一切 import されない設計
  - 根拠: adapter-pattern — コアはランタイム固有の型を一切 import せず、`fetch(Request): Response` のみを公開
- `[MUST]` アダプターの責務は「外部インターフェースから内部インターフェースへの変換」に限定し、ビジネスロジックやルーティング判断を含めない
  - 根拠: adapter-pattern — Vercel/Netlify アダプターが各 3-4 行で済むのは、変換以外の責務を持たないため
- `[MUST]` プラグイン/ミドルウェアのインターフェースは最小限のメソッドで定義し、実装詳細を漏洩させない
  - 根拠: architecture — `Router<T>` は `add`/`match` の 2 メソッドのみで 5 つの異なるアルゴリズムを統一
  - 根拠: router-design — 2 メソッドで Trie ベース・正規表現ベース・線形走査ベースの全アルゴリズムが実装可能
- `[MUST]` ライブラリのコアとアルゴリズムは interface で分離し、コアがアルゴリズムの具象クラスを直接 import しない構造にする
  - 根拠: preset-system — HonoBase は `Router<T>` インターフェースにのみ依存し、5 種のルーター実装を一切 import していない。これにより tree-shaking とプリセット分離が成立
- `[MUST]` ライブラリのコアモジュールは production dependencies ゼロを維持し、外部依存が必要な機能は別パッケージとして分離する
  - 根拠: dependency-management — 182 ソースファイル・多数のミドルウェアを擁しつつ production dependencies ゼロを達成
  - 根拠: design-philosophy — `btoa`/`atob` や `Response.formData()` 等の Web Standards API で全ユーティリティを自前実装
- `[SHOULD]` 依存関係の方向は常に「外側（具体）から内側（抽象）」へ向かわせ、内側の層が外側を参照しない
  - 根拠: architecture — アダプター/ミドルウェア/ヘルパーはすべてコアに依存するが、コアからこれらへの参照は存在しない
- `[SHOULD]` ランタイム固有の操作を Strategy として注入可能にし、共通ロジックは高階関数またはベースクラスで提供する
  - 根拠: adapter-pattern — `serveStatic` は `getContent`/`join`/`isDir` を注入する高階関数パターンで 3 ランタイムのファイルアクセス差異を吸収
  - 根拠: dependency-management — コアはコールバック/DI で受け取り、ランタイム固有コードはアダプター内に封じ込め
- `[SHOULD]` アダプターの複雑さはターゲットプラットフォームの API 乖離度に比例させ、不要な抽象化層を導入しない
  - 根拠: adapter-pattern — Vercel は 3 行、Lambda は 680 行。統一インターフェースを強制するよりも各ランタイムの慣習に合わせる方が実用的
- `[SHOULD]` デフォルト構成は最も安全で高機能なものにし、軽量構成は明示的なオプトインとする
  - 根拠: preset-system — `import { Hono } from 'hono'` は SmartRouter + RegExpRouter + TrieRouter の最も堅牢な構成。Tiny/Quick は明示的に選択しないと適用されない
- `[SHOULD]` サブパスエクスポートのパス名は内部ディレクトリ構造を隠蔽し、ユーザー視点の機能名で公開する
  - 根拠: project-structure — `hono/cors`（内部: `src/middleware/cors/`）のようにフラット化し、内部分類をユーザーに露出させない
- `[AVOID]` コアフレームワーク内で特定のルーティングアルゴリズムやミドルウェア実装にハードコードする
  - 根拠: architecture — `HonoBase` は `router` を `!` (definite assignment) で宣言し、Preset がサブクラスとして構成を注入する
- `[AVOID]` 全アダプターに共通の抽象基底クラスを作ること。各ランタイムの入出力が根本的に異なる場合、共通インターフェースの強制はアダプターを不自然に複雑にする
  - 根拠: adapter-pattern — Vercel と Lambda はシグネチャが異なり、統一する意味がない
- `[AVOID]` コアのエントリポイントからオプショナルな機能（ミドルウェア、ヘルパー等）を直接エクスポートすること
  - 根拠: project-structure — `src/index.ts` は `Hono` クラスと型のみをエクスポートし、25 のミドルウェアや 14 のヘルパーは全てサブパス経由
- `[AVOID]` プリセットやバリアント間でロジックを複製すること。共通基盤を抽象クラスとして抽出し、差分だけをサブクラスで定義する
  - 根拠: project-structure — `HonoBase`（539 行）にコア処理を集約し、各プリセットはコンストラクタでルーターを注入するだけ
- `[AVOID]` フレームワークのコア部分に外部依存を追加してマルチランタイム互換性を損なうこと
  - 根拠: design-philosophy — dependencies ゼロを維持し、Web Standards API で全ユーティリティを自前実装

## ミドルウェア・バリデーション・ヘルパー設計

- `[MUST]` onion 型ミドルウェアでは `next()` の戻り値を必ず `await` すること
  - 根拠: middleware-system — `await` なしでは後続ミドルウェアの完了を待たず後処理が実行され、レスポンスの変更やエラーハンドリングが正しく動作しない
- `[MUST]` ミドルウェア合成関数（compose）は `next()` の二重呼び出しを検出して例外を投げること
  - 根拠: middleware-system — `compose.ts:33-35` は `index` の単調増加をチェックし、二重呼び出しで即座にエラーを投げる
- `[MUST]` フレームワークのバリデーション層は特定のバリデーションライブラリに依存せず、コールバック関数の型シグネチャを統合契約として設計する
  - 根拠: validator-system — `validator(target, fn)` のコールバックパターンにより、コア 186 行で Zod/Valibot/TypeBox 等あらゆるライブラリとの統合を可能にしている
- `[MUST]` バリデーション結果の型を `in`（入力型）と `out`（出力型）に分離し、transform 前後の型を正確にハンドラーとクライアントに伝搬させる
  - 根拠: validator-system — `InferInput` 型ユーティリティがリテラルユニオンやオプショナル型を保持しつつ、ターゲット固有のデフォルト型に変換する設計
- `[SHOULD]` ミドルウェアファクトリは設定をクロージャにキャプチャし、リクエストごとの再計算を避けること
  - 根拠: middleware-system — 全組み込みミドルウェアがこのパターンを採用し、正規表現のコンパイルやオプションのマージを初期化時に一度だけ行っている
- `[SHOULD]` ミドルウェアの返却関数には名前付き関数式を使い、スタックトレースでの識別を容易にすること
  - 根拠: middleware-system — 全ミドルウェアが `return async function middlewareName(c, next) { ... }` パターンを採用
- `[SHOULD]` バリデーション関数の「戻り値型」で成功/失敗の制御フローを表現する（Response 返却 = エラー、データ返却 = 成功）
  - 根拠: validator-system — `res instanceof Response` による分岐で、例外に頼らないエラーハンドリングを実現
- `[SHOULD]` HTTP メソッドの制約（GET/HEAD はボディを持たない等）を型システムで強制する
  - 根拠: validator-system — `ValidationTargetByMethod<M>` 型により、GET リクエストに `validator('json', ...)` を指定するとコンパイルエラーになる
- `[SHOULD]` ヘルパー関数はフレームワークコンテキストを第一引数に受け取り、ロジック本体は Context 非依存の utils 層に委譲すること
  - 根拠: helper-utilities — 全 14 ヘルパーが Context-first パターンに従い、utils 層の単体テスト容易性とヘルパーの薄さを両立
- `[SHOULD]` 副作用のある操作（Context への書き込み）と純粋な生成処理を別関数として公開すること
  - 根拠: helper-utilities — cookie ヘルパーの `generateCookie` / `setCookie` 分離により、SSG やテスト等の非リクエスト文脈でも利用可能
- `[SHOULD]` ランタイム固有の差異吸収は、ヘルパー本体ではなく専用の検出関数に局所化すること
  - 根拠: helper-utilities — `isOldBunVersion()` や `getRuntimeKey()` が分離されているため、ランタイム対応の変更がビジネスロジックに波及しない
- `[SHOULD]` サブパスエクスポートでヘルパーを個別公開し、メインエントリポイントには含めないこと
  - 根拠: helper-utilities — `hono/cookie`, `hono/html` 等で exports を個別定義し、未使用ヘルパーがバンドルに含まれないツリーシェイキングを保証
- `[AVOID]` ミドルウェア内で `context.res` を無条件に上書きすること。ヘッダ追加は安全だが、body やステータスの変更は `finalized` 状態を確認すべき
  - 根拠: middleware-system — `set res` が `finalized = true` を設定するため、先行ミドルウェアの結果を意図せず破壊するリスクがある
- `[AVOID]` ミドルウェアチェーンの中断を暗黙的に行うこと。中断する場合は `HTTPException` を throw するか Response を return して意図を明示すべき
  - 根拠: middleware-system — `next()` を呼ばないだけの暗黙的中断は、後続ハンドラの未実行が検出しづらい
- `[AVOID]` ミドルウェア間に暗黙の依存関係を作る（実行順序への暗黙の期待）
  - 根拠: architecture — 各ミドルウェアは独立したモジュールとして配置され、相互 import がない。`compose` が順序を制御し、各ミドルウェアは `next()` でのみ連携
- `[AVOID]` バリデーション時に Content-Type の不一致をサイレントにスキップする設計を無批判に採用すること
  - 根拠: validator-system — Hono は互換性のためにスキップを選択しているが、厳格なバリデーションが必要な API ではラッパーによる追加チェックが必要
- `[AVOID]` モジュールスコープに可変状態を持つこと。処理のスコープ内で状態を管理する方がリーク防止に有効
  - 根拠: helper-utilities — SSG ヘルパーの `createdDirs` がモジュールスコープで定義されており、複数回呼び出し時に前回の状態が残る潜在的バグを含む
- `[AVOID]` ヘルパー内に HTTP ヘッダー値をハードコードすること。デフォルト値は提供しつつ、オプションでの上書きを許容する
  - 根拠: helper-utilities — `streamSSE` の SSE ヘッダーのハードコードは、カスタムヘッダー追加や CDN 固有のヘッダー調整を困難にしている

## 型システム・型安全性

- `[MUST]` 型レベルの API 契約を設計する場合、Phantom Type でランタイムに影響しないメタデータを伝搬させ、型情報の損失を防ぐこと
  - 根拠: type-system — `TypedResponse<T, U, F>` は `_data`, `_status`, `_format` でレスポンス型情報を保持し、RPC クライアントまで伝搬
- `[MUST]` `any` 型が型パラメータに混入する可能性がある場合、インターセクション前に `IsAny` ガードで `{}` に正規化すること
  - 根拠: type-system — `any & T = any` により型情報が消失するため、`IntersectNonAnyTypes` で全ミドルウェアの `Env` をマージする前に `any` を除去
- `[MUST]` 型安全 RPC を実現する際、サーバー側の型情報は一方向に流し、共有スキーマファイルへの依存を避ける
  - 根拠: client-rpc — `typeof app` だけでクライアント型を導出しており、IDL やコード生成が不要
- `[MUST]` メソッドチェインで型を累積する API では、チェインの戻り値型を `S & NewSchema` のように intersection で拡張し、途中結果の型情報を保持する
  - 根拠: client-rpc — `HandlerInterface` がすべてのオーバーロードで `S & ToSchema<...>` を返すことで、ルート定義の型情報が欠落しない
- `[MUST]` ミドルウェアが共有コンテキストに書き込む変数は、型レベルでキーと値の型を宣言する
  - 根拠: context-design — `Env['Variables']` と `ContextVariableMap` の二重レイヤーで型安全性を確保
- `[SHOULD]` 型レベルのビルダーパターンでは、メソッドチェーンの戻り値型に蓄積された型パラメータを含め、チェーンの各ステップで型情報を保持すること
  - 根拠: type-system — `HandlerInterface` の各オーバーロードが `HonoBase<E, S & ToSchema<...>, BasePath>` を返す設計
- `[SHOULD]` 型と実装を分離する場合、型テスト（`expectTypeOf` 等）で型契約の網羅的な検証を行い、実装の `as any` と型定義の整合性を保証すること
  - 根拠: type-system — `src/types.test.ts` で型レベルの期待値を記述し、`as any` を使う実装側との整合性を型テストで担保
- `[SHOULD]` JSON レスポンスの型にはシリアライズ後の型（`JSONParsed<T>`）を使い、クライアントが受け取る実際のデータ型と一致させること
  - 根拠: type-system — `Date` → `string`、`undefined` → フィールド除外など、`JSON.stringify` の変換を型で再現しないとクライアント側で型不一致が起きる
- `[SHOULD]` プラグイン/ミドルウェアの型拡張ポイントには空インタフェースと Declaration Merging を使う
  - 根拠: context-design — `ContextVariableMap` は空インタフェースとして定義され、ミドルウェアが `declare module` で型を追加する仕組みを実現
- `[SHOULD]` コンテキストの変数ストアには読み取り専用ビューと書き込み API を分離して提供する
  - 根拠: context-design — `c.var` は `Readonly<>` でラップされた参照専用、`c.set()`/`c.get()` はミドルウェアでの読み書き用
- `[SHOULD]` レスポンス型はステータスコードで絞り込み可能にし、エラーハンドリングの型安全性を確保する
  - 根拠: client-rpc — `InferResponseType<T, 200>` により成功時のレスポンス型のみを抽出可能
- `[SHOULD]` URL パスをオブジェクトのネスト構造に変換する際、テンプレートリテラル型の再帰的分割を使い、パスセグメントごとにプロパティ化する
  - 根拠: client-rpc — `PathToChain` がスラッシュ区切りでパスを再帰分割し、末端に `ClientRequest` を配置する設計
- `[SHOULD]` 判別型ユニオンに対する型ガードは、プロパティの存在チェック（`Object.hasOwn` / `in`）で実装し、TypeScript の型ナローイングと連携させる
  - 根拠: adapter-pattern — AWS Lambda アダプターの `isProxyEventALB` 等は `Object.hasOwn` で判別し、`event is ALBProxyEvent` で型を絞り込む
- `[SHOULD]` マッチング結果のデータ表現を union 型で柔軟にし、高速な実装が最適なメモリレイアウトを使えるようにする
  - 根拠: router-design — `Result<T>` は ParamIndexMap + ParamStash 形式と Params 形式の union で、RegExpRouter は正規表現の match 結果をそのまま stash として流用できる
- `[AVOID]` グローバルな型空間（Declaration Merging）で汎用的なキー名を使う
  - 根拠: context-design — `user` や `data` のような汎用名はキー衝突による intersection 型の問題を引き起こす。公式ミドルウェアは `jwtPayload`, `requestId` のように具体的な名前を使用
- `[AVOID]` メソッドチェインの結果を変数に保持せず、後から型を取得しようとすること（型情報が蓄積されない）
  - 根拠: client-rpc — `app.get(...)` の戻り値を捨てると `Schema` 型パラメータが更新されず、`typeof app` が空のスキーマになる
- `[AVOID]` 型レベルの再帰的な文字列パースにおいて、Union 型が膨張するパターンを作ること
  - 根拠: type-system — `ExtractParams` は条件型の分配を制御し、非リテラル型のフォールバックを明示
- `[AVOID]` Proxy ベースの動的クライアントで `then` プロパティを通常のパスセグメントとして処理すること
  - 根拠: client-rpc — `await` 演算子が `.then` を呼ぶため、`undefined` を返さないと無限ループになる
- `[AVOID]` 外部バリデーター統合で `in`/`out` の型を手動で指定する際に、スキーマの `input`/`output` 型と不整合なキャストを行うこと
  - 根拠: validator-system — リファレンス実装は `z.input<T>` / `z.output<T>` を使って型を自動導出しており、手動指定は型安全性を損なう

## パフォーマンス最適化

- `[MUST]` ルーティングライブラリでは、静的ルートをハッシュマップで O(1) 参照するファストパスを設ける
  - 根拠: performance — RegExpRouter は `staticMap[path]` で正規表現を経由せずに即座に返す
- `[MUST]` 初期化コストの高い処理は初回呼び出し時に遅延実行し、結果をキャッシュまたは自己書き換えで以降の呼び出しから除去する
  - 根拠: performance — RegExpRouter の `match()` は初回で `buildAllMatchers()` を実行した後 `this.match` を上書きし、2 回目以降は構築判定が不要
  - 根拠: router-design — メソッド自己置換で 2 回目以降のオーバーヘッドを排除
  - 根拠: preset-system — SmartRouter のルーター選択と RegExpRouter の正規表現コンパイルが初回のみ実行
- `[MUST]` リクエストスコープのコンテキストオブジェクトでは、使用頻度の低いフィールドを遅延初期化（`??=`）する
  - 根拠: context-design — `#req`, `#var`, `#preparedHeaders` をすべて遅延初期化し、使われないフィールドのアロケーションコストをゼロにしている
- `[SHOULD]` Hot Path（最頻実行パス）では抽象化レイヤーをバイパスする最適化を実装する
  - 根拠: architecture — シングルハンドラー最適化は `compose` をスキップし、同期レスポンスでは Promise のオーバーヘッドも回避
  - 根拠: middleware-system — `matchResult[0].length === 1` の場合に `compose` をスキップし、同期ハンドラでは Promise 生成すら回避
- `[SHOULD]` 性能特性の異なる複数のアルゴリズムを提供し、自動選択メカニズムでユーザーの選択負荷を排除する
  - 根拠: performance — SmartRouter は RegExpRouter を優先試行し、UnsupportedPathError 時に TrieRouter にフォールバック
  - 根拠: router-design — ユーザーがルーターの制約を意識せずに最適な性能を得られる
- `[SHOULD]` ホットパスでのオブジェクト生成では `Object.create(null)` を使い、プロトタイプチェーン探索を排除する
  - 根拠: performance — ルーター実装全体で 19 箇所 `Object.create(null)` を使用
- `[SHOULD]` リクエスト処理のホットパスでは `new URL()` の代わりに文字列操作でパスを抽出し、オブジェクト生成コストを避けること
  - 根拠: web-standards — `getPath()` が `indexOf`/`charCodeAt` で高速抽出し、URL パースのオーバーヘッドを排除
  - 根拠: performance — `charCodeAt()` ループで `%` を検出し、含まれない場合は `decodeURI` を完全にスキップ
- `[SHOULD]` ホットパスのレスポンスメソッドには条件分岐によるファストパスを設ける
  - 根拠: context-design — `c.text()` はヘッダー/ステータスが未設定の場合に直接 `new Response(text)` を返すファストパスを持つ
  - 根拠: design-philosophy — エッジランタイムの CPU 時間制約に対応するため、単一ハンドラ最適化や直接 Response 生成を実装
- `[SHOULD]` ランタイム差異の検出結果はメモ化（Self-Replacing Function 等）してホットパスのコストをゼロにする
  - 根拠: streaming — `isOldBunVersion()` は初回呼び出し後に関数自体を結果で上書きし、以降のオーバーヘッドを排除
- `[AVOID]` ルーティングで各ルートに個別の正規表現を持たせ、リクエストごとに線形走査する設計
  - 根拠: performance — 単一正規表現方式なら O(1) 相当で、ルート数増加に伴う O(n) 劣化を回避
- `[AVOID]` ビルドフェーズで生成した一時キャッシュをランタイムに持ち越す
  - 根拠: performance — RegExpRouter は `buildAllMatchers()` 完了後に `this.#middleware`、`this.#routes`、`wildcardRegExpCache` をすべて解放
- `[AVOID]` `c.var` のような変換コストを伴う getter をループ内で繰り返し呼ぶ
  - 根拠: context-design — `c.var` は `Object.fromEntries(this.#var)` を毎回実行するため、アクセスごとに新しいオブジェクトが生成される
- `[AVOID]` 最速のアルゴリズムだけを提供してエッジケースを「非サポート」として放置する設計
  - 根拠: router-design — RegExpRouter 単体では一部パターンを処理できないが、SmartRouter + TrieRouter のフォールバックで全パターンをカバー

## エラーハンドリング・セキュリティ

- `[MUST]` カスタムエラークラスは標準の `Error` を継承し、`throw` で利用する。非 Error オブジェクトの throw はエラーハンドリングパイプラインをバイパスする
  - 根拠: error-handling — `compose.ts:53` で `err instanceof Error` チェックがあり、Error でなければ `onError` が呼ばれず再 throw される
- `[MUST]` HTTP エラーレスポンスにカスタムヘッダーやボディが必要な場合、レスポンスオブジェクトをエラーに同梱して throw する
  - 根拠: error-handling — 全認証ミドルウェアが `new HTTPException(status, { res })` パターンを統一的に採用
- `[MUST]` カスタム `onError` ハンドラを設定する場合、`HTTPException`（または `getResponse()` を持つエラー）を明示的に処理する分岐を含める
  - 根拠: error-handling — デフォルトハンドラが `'getResponse' in err` で分岐しており、カスタムハンドラはこの処理を自前で行う必要がある
- `[MUST]` `crypto.subtle` を使用する前に存在チェックを行い、利用不可環境での振る舞いを明示的に決定すること
  - 根拠: web-standards — ユーティリティ層で `null` 返却、ミドルウェア層で起動時エラーという二段構えで対処
- `[MUST]` セキュリティに関わるデフォルト値は安全側に倒し、危険な動作はオプトインにすること
  - 根拠: helper-utilities — proxy ヘルパーの `strictConnectionProcessing: false` や cookie の prefix 指定時の `secure: true` 強制が、設定漏れを構造的に防止
- `[SHOULD]` エラーの原因チェーンを `cause` オプションで維持する。低レベルのエラーを握りつぶさず、`Error.cause` の標準メカニズムで伝播させる
  - 根拠: error-handling — JWT/JWK が catch したエラーを `cause` として HTTPException に渡しトレーサビリティを確保
- `[SHOULD]` エラーのプロトコル判定にはダックタイピング（`'method' in obj`）を使い、`instanceof` への依存を避ける
  - 根拠: error-handling — `'getResponse' in err` で判定し、異なるパッケージバージョンやバンドラー環境での互換性が向上
- `[SHOULD]` エラーレスポンスのステータスコード型にボディなしステータス（204, 304 等）を除外する型制約を設ける
  - 根拠: error-handling — `HTTPException` が `ContentfulStatusCode` を使い、コンパイル時に不正なステータスコードを防止
- `[SHOULD]` アルゴリズム実装が対応できない入力には専用のエラー型を定義し、上位レイヤーがフォールバック判断に利用できるようにする
  - 根拠: preset-system — SmartRouter は `UnsupportedPathError` を catch して次のルーターに切り替える。通常の `Error` では「非対応」と「バグ」を区別できない
  - 根拠: router-design — 例外（ケイパビリティエラー）で「非対応」を通知し、フォールバック先に処理を委譲
- `[SHOULD]` 暗号・ハッシュ処理は Web Crypto API (`crypto.subtle`) を使い、ランタイム固有の crypto モジュールに依存しない
  - 根拠: design-philosophy — JWT 実装とハッシュ実装は全て `crypto.subtle` で統一
  - 根拠: dependency-management — `crypto.subtle.sign`/`verify`/`importKey` のみを使用し、低レベル演算は一切自前実装していない
- `[AVOID]` グローバルエラーハンドラ内での `console.error` をデフォルト動作とすること。本番環境では構造化ログや外部サービスへの送信が必要
  - 根拠: error-handling — デフォルトハンドラの `console.error(err)` は開発時のフォールバックに留めるべき
- `[AVOID]` 軽量プリセットに SmartRouter なしのルーターを組み込む場合、対応パスパターンの制約をドキュメントで明示しないまま公開すること
  - 根拠: preset-system — `hono/tiny` は PatternRouter 単体であり、非対応パターンで `UnsupportedPathError` が直接ユーザーに到達する

## ビルド・パッケージング・テスト

- `[MUST]` ESM/CJS デュアルパッケージでは `exports` フィールドに `types` → `import` → `require` の順序で条件を定義し、各条件が指すファイルの存在を publint 等で自動検証する
  - 根拠: build-system — 70 以上のエクスポートで `types` を最優先に配置し、`postbuild` で publint を実行
- `[MUST]` 複数のパッケージレジストリ（npm + JSR 等）にパブリッシュする場合、エクスポートマップの整合性をビルド時に自動検証する仕組みを設ける
  - 根拠: build-system — `validateExports` で `package.json` と `jsr.json` を双方向にクロスチェック
  - 根拠: project-structure — `build/validate-exports.ts` で双方向検証を実施し、エクスポートの不整合を CI で検出
  - 根拠: dependency-management — 片方だけにエクスポートが追加される事故を構造的に防止
- `[MUST]` 複数の構成プリセットを提供する場合、各プリセットを独立した exports エントリポイントとして公開し、使用しないコードがバンドルに含まれないことを物理的に保証する
  - 根拠: preset-system — `"./tiny"`, `"./quick"` の各エントリポイントが独立した依存グラフを形成
- `[MUST]` マルチランタイム対応ライブラリでは、コアロジックのテストをランタイム非依存な層で実行し、ランタイム固有テストはアダプター層の最小限の検証に留める
  - 根拠: testing-strategy — 117 ファイルのコアテストを Vitest/Node.js で実行し、7 ランタイムの固有テストは合計 13 ファイルに抑制
- `[MUST]` Strategy パターンで複数実装を切り替える場合、全実装が共有するテストスイートを用意し、非対応ケースは理由付きで明示的にスキップする
  - 根拠: router-design — `common.case.test.ts` で 5 種ルーターの行動互換を保証し、各ルーターの `skip` 配列で非対応パターンを可視化
  - 根拠: project-structure — 同一のテストスイートを全実装に適用しインターフェース互換性を保証
- `[MUST]` 共通テストスイートを関数としてエクスポートする場合、テスト発見から除外する命名規則と設定の除外パターンを組み合わせて直接実行を防止する
  - 根拠: testing-strategy — `vitest.config.ts` の `exclude: ['**/*.case.test.*']` がなければテストが引数なしで実行され失敗する
- `[SHOULD]` ビルドパイプラインではツールごとの責務を分離し、トランスパイル・型定義生成・パッケージ検証を独立したステップとして並列実行する
  - 根拠: build-system — `Promise.all` で ESM ビルド・CJS ビルド・tsc を並列実行し、ビルド速度と正確性を両立
- `[SHOULD]` エントリポイントは glob パターンで自動収集し、除外リストで制御する。手動列挙はモジュール追加時の設定変更漏れリスクがある
  - 根拠: build-system — `glob.sync('./src/**/*.ts', { ignore: [...] })` で全ソースファイルを自動収集
- `[SHOULD]` CJS 互換が必要な場合、ルートの `"type": "module"` と `dist/cjs/package.json` の `"type": "commonjs"` で Node.js のモジュール解決規則を利用する
  - 根拠: project-structure — 3 行の `package.cjs.json` をコピーするだけで CJS サブディレクトリを成立
  - 根拠: build-system — ファイル拡張子を変更しない透明なデュアル出力を実現
- `[SHOULD]` ビルドの postbuild フックで publint を実行し、パッケージ品質を自動検証する
  - 根拠: dependency-management — `"postbuild": "publint"` により、壊れたパッケージの公開を開発時点で防止
- `[SHOULD]` Web Standards API に基づくフレームワークでは、`app.request()` のような HTTP サーバー不要のテストメソッドをフレームワーク本体に組み込む
  - 根拠: testing-strategy — `hono-base.ts:482-511` の `request()` メソッドにより、全コアテストが HTTP サーバー起動なしで実行
- `[SHOULD]` JSX のコンパイラ差分をテストする場合、マルチプロジェクト構成で同一テストコードを異なるコンパイラ設定で実行し、出力の正規化で差分を吸収する
  - 根拠: testing-strategy — `.replace(/\s+/g, '')` で precompile と react-jsx の空白差分を正規化
- `[AVOID]` ソースコードのインポートパスにビルド出力用の拡張子（`.js`）をハードコードすること
  - 根拠: build-system — `addExtension` プラグインでビルド時に拡張子を付与し、ソースコードはランタイムの都合から独立
- `[AVOID]` devDependencies にテスト対象のバリデーションライブラリ（zod 等）を含めるだけで、production dependencies に追加してしまうこと
  - 根拠: dependency-management — zod を devDependencies に配置しテスト内でのみ使用。バリデーション機能自体は独自の仕組みを持つ
- `[AVOID]` ランタイム固有テストでコアロジックを再テストすること。各ランタイムのテストはアダプター層の変換ロジックとランタイム検出のみに集中すべき
  - 根拠: testing-strategy — コアロジックは別環境で十分にテスト済みであり、ランタイムテストでの重複はメンテナンスコストを増加させるだけ

## Web Standards・ストリーミング・JSX

- `[MUST]` ストリーミング応答は Web Standard API（ReadableStream / TransformStream）のみで実装し、ランタイム固有の Stream API に依存しない
  - 根拠: streaming — 全ストリーミング実装を Web Standards で統一し、Cloudflare Workers・Deno・Bun・Node.js で同一コードを動作
- `[MUST]` SSE レスポンスには `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `Transfer-Encoding: chunked` の 4 ヘッダーを設定する
  - 根拠: streaming — `streamSSE()` が毎回これら 4 ヘッダーを明示的に設定
- `[MUST]` SSE の data フィールド内の改行は `\r\n` / `\r` / `\n` のすべてを `data:` プレフィックス付き複数行に変換する
  - 根拠: streaming — SSE 仕様では改行はメッセージ区切りと解釈されるため、data 内の改行は `data:` を繰り返す必要がある
- `[MUST]` SSR 用 JSX エンジンでは、文字列結合の同期パスと非同期パスを明確に分離し、同期パスでは Promise を一切生成しないこと
  - 根拠: jsx-engine — `StringBuffer` 設計では `buffer.length === 1` チェックで同期パスを分岐し、不要なメモリアロケーションを回避
- `[MUST]` HTML 文字列を生成する JSX エンジンでは、エスケープ済みフラグ（`isEscaped`）を型レベルで管理し、二重エスケープを防止すること
  - 根拠: jsx-engine — `HtmlEscaped` インターフェースで `isEscaped: true` を強制し、`raw()` で明示的にフラグを設定
- `[MUST]` Web Standards ベースのフレームワークでは、ラッパークラスに標準 API への直接アクセス手段（escape hatch）を必ず設けること
  - 根拠: web-standards — `HonoRequest.raw` により Cloudflare Workers の `cf` プロパティ等にアクセスできる
- `[SHOULD]` `Request`/`Response` コンストラクタをデータ変換ユーティリティとして活用し、自前パーサーの実装を避けること
  - 根拠: web-standards — `bufferToFormData()` が `new Response(buf, { headers }).formData()` でブラウザネイティブ実装を再利用
- `[SHOULD]` ストリーミングレスポンスには `TransformStream` でペアを生成し、書き込み側と読み取り側の関心を分離すること
  - 根拠: web-standards — `stream()` ヘルパーが `TransformStream` ベースで統一的にストリーミングを実装
  - 根拠: streaming — ReadableStream の pull モデルよりも TransformStream の writable 側に write する方がサーバーサイドのユースケースに自然
- `[SHOULD]` ストリーミング API の `write()` / `close()` は例外を内部で吸収し、エラーハンドリングは専用のコールバック経路で提供する
  - 根拠: streaming — クライアント切断は正常系の一部であり、`write()` が例外を投げるとアプリケーションコードに不要な try-catch が必要になる
- `[SHOULD]` GC されるべきオブジェクトへの一時的な参照保持には `WeakMap` を使い、ストリーム完了後の自動解放を保証する
  - 根拠: streaming — `contextStash` が `WeakMap<ReadableStream, Context>` で実装され、メモリリークを防止
- `[SHOULD]` 複数のレンダリングバックエンド（SSR / DOM）を持つ JSX エンジンでは、Symbol ベースのディスパッチでコンポーネントに環境別ロジックをアタッチすること
  - 根拠: jsx-engine — `DOM_RENDERER` Symbol でコンポーネント関数にクライアント用レンダラーを付与
- `[SHOULD]` ストリーミング SSR の Suspense 実装では、各チャンクにインラインスクリプトを含めて自己完結的な DOM 更新を実現し、外部ランタイムスクリプトへの依存を排除すること
  - 根拠: jsx-engine — `<template>` + コメントノードをマーカーとし、解決後のチャンクに DOM 書き換えスクリプトを埋め込む
- `[SHOULD]` Context の実装は値スタック（配列の push/pop）で管理し、useContext は常にスタックの末尾を参照するだけにすること
  - 根拠: jsx-engine — `createContext` は `values` 配列に Provider の値を push し、レンダリング完了後に pop する。`useContext` は `values.at(-1)` を返すだけの O(1) 操作
- `[AVOID]` `Request.body` を標準メソッド（`.json()`, `.text()` 等）とラッパーメソッドの両方で消費すること。ボディキャッシュの一貫性が崩れる
  - 根拠: web-standards — `cloneRawRequest()` は `bodyCache` からの復元に依存しており、`raw` 経由の直接消費では復元に失敗
- `[AVOID]` ストリーミング応答に ETag・圧縮などボディ全体を必要とするミドルウェアを適用する
  - 根拠: streaming — 圧縮正規表現は `text/event-stream` を明示的に除外しており、ストリーミングとバッファリング系ミドルウェアの非互換性が設計レベルで認識されている
- `[AVOID]` アダプター層でランタイムの動的検出を行うこと。アダプターはビルド時にランタイムが確定しているべきで、実行時分岐はヘルパー層に隔離する
  - 根拠: adapter-pattern — `getRuntimeKey()` は `src/helper/adapter/` に隔離されており、`src/adapter/` 内のコードはランタイム検出を行わない
- `[AVOID]` JSX エンジンの仮想 DOM ノード型に通常の文字列キーを使うこと。短縮プロパティ名は内部ノード型でのみ使い、公開 API 型では意味のある名前を保つこと
  - 根拠: jsx-engine — `NodeObject` は `pP`、`nN`、`vC` 等の短縮名でメモリ効率を最適化しているが、コードの可読性は低下しておりコメントでの補足が必須

## ルール優先度の解釈

- `[MUST]`: 違反するとバグ・セキュリティリスク・重大な設計劣化を招くルール
- `[SHOULD]`: 従うことで品質が向上するが、文脈によっては例外を許容するルール
- `[AVOID]`: 意図的に避けるべきアンチパターン・非推奨プラクティス
