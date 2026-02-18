# epicweb-dev/epic-stack — 導出ルール集

> 出典: repos/epicweb-dev/epic-stack/ | 生成日: 2026-02-18
> 用途: CLAUDE.md にそのまま貼り付けて AI コンテキストとして活用

## 型安全性とバリデーション

- `[MUST]` ランタイムバリデーションスキーマ（Zod 等）から `z.infer` で型を導出し、手書きの型定義との二重管理を避ける
  - 根拠: type-system-patterns — 全フォーム・環境変数・API レスポンスで一貫してスキーマ駆動型定義が適用されている
- `[MUST]` 外部入力（API レスポンス・フォームデータ・環境変数・Cookie）はシステム境界で必ず Zod `parse()` / `safeParse()` を通し、境界の内側では型安全な値として扱う
  - 根拠: type-system-patterns — GitHub API レスポンスを `GitHubUserResponseSchema.parse()` で検証してから使用
- `[MUST]` 環境変数はアプリケーション起動時にスキーマバリデーション（Zod 等）で検証し、不正な状態での起動を即座に失敗させる。クライアントへの公開はホワイトリスト方式で選別する
  - 根拠: project-structure, architecture — `env.server.ts` の `init()` で Zod バリデーション実行、`getEnv()` で公開変数のみ返却
- `[MUST]` `unknown` 型のエラーは型ガードで安全にメッセージを取り出す — `error.message` への直接アクセスや `String(error)` は避ける
  - 根拠: error-handling-idioms — `getErrorMessage` が段階的チェックでどのケースでも安全な文字列を返す
- `[SHOULD]` Zod スキーマに `.default()` や `.transform()` がある場合、`z.infer`（出力型）と `z.input`（入力型）を区別して使い分ける
  - 根拠: type-system-patterns — `Toast`（出力型）と `ToastInput`（入力型）を明確に分離
- `[SHOULD]` ORM 生成型はフィールド単位の Indexed Access（`Model['field']`）で部分参照し、関数シグネチャをモデル全体の型に依存させない
  - 根拠: type-system-patterns — `User['username']`, `Connection['providerId']` のように Prisma 型をフィールド単位で参照
- `[SHOULD]` 外部ライブラリの型に合わせて Zod スキーマを書く場合、`satisfies z.ZodType<ExternalType>` でスキーマと型の整合性をコンパイル時に検証する
  - 根拠: type-system-patterns — `RegistrationResponseJSON` に対する `satisfies` による整合性保証
- `[SHOULD]` バリデーションスキーマの基本単位をフィールドレベルで定義し、各ユースケースで合成（`.object()`, `.and()`, `.merge()`）する
  - 根拠: type-system-patterns — `UsernameSchema`, `PasswordSchema` を定義し 6 箇所以上で合成再利用
- `[AVOID]` 型アサーション (`as`) を使ってランタイムで検証されていない構造を型付けすること — 代わりに Zod バリデーションや型ガードを使う
  - 根拠: type-system-patterns — プロジェクト全体で `as` の使用は最小限、外部入力には一貫して Zod を使用

## テスト設計

- `[MUST]` テスト中の `console.error` / `console.warn` をデフォルトで例外に変換し、意図的な呼び出しのみ `mockImplementation(() => {})` で明示的にオプトアウトする
  - 根拠: testing-strategy, test-infrastructure — `setup-test-env.ts` でグローバルに設定、エラーメッセージに解除方法を含める
- `[MUST]` 外部 HTTP API のモックは MSW のようなネットワーク層インターセプトで行い、アプリ内モジュールの mock/stub は最小限にする
  - 根拠: testing-strategy — 全 MSW ハンドラが外部 API エンドポイントに対するもので、`vi.mock` は技術的制約のケースのみ
- `[MUST]` テストごとに独立した DB 状態を保証する仕組みを導入する（ファイルコピー、トランザクションロールバック、テンプレート DB 等）
  - 根拠: test-data-management — `beforeEach` で base DB をコピーし、テスト間のデータ汚染を物理的に防止
- `[MUST]` 並列テスト実行時はワーカー ID（`VITEST_POOL_ID` 等）をリソース名に組み込み、共有リソースの衝突を防ぐ
  - 根拠: test-infrastructure — DB ファイルとモック状態ファイルの両方にプール ID を埋め込み
- `[MUST]` テストデータの生成ロジックはテストファイル内にハードコードせず、共有ファクトリ関数に集約する
  - 根拠: test-data-management — `createUser()` がシード、Vitest テスト、Playwright テストの全てで共有
- `[MUST]` faker でユニーク制約のあるフィールドを生成する場合は、一意性保証の仕組み（`UniqueEnforcer` 等）を組み合わせる
  - 根拠: test-data-management — `UniqueEnforcer` により並列テスト実行でも username 重複が発生しない
- `[SHOULD]` ビジネスロジックのテストは純粋関数の入出力テストよりも、実際の依存（DB, セッション, HTTP）と統合した状態でのテストを優先する
  - 根拠: testing-strategy — OAuth コールバックテストが Prisma + セッション Cookie + loader 直接呼び出しの統合テスト
- `[SHOULD]` テスト対象のドメインに特化したカスタムマッチャーを作成し、テストの意図を宣言的に表現する。TypeScript の module augmentation で型安全にする
  - 根拠: test-infrastructure — `toHaveRedirect`, `toHaveSessionForUser`, `toSendToast` が `Assertion` と `AsymmetricMatchersContaining` の両方を拡張
- `[SHOULD]` テストデータのファクトリ関数は「データ生成」と「DB 書き込み」を分離し、純粋なデータ生成関数として設計する
  - 根拠: test-data-management — `createUser()` は DB に書き込まず `{ username, name, email }` を返すだけ
- `[SHOULD]` テストデータのクリーンアップはフレームワーク機構（フィクスチャ、afterAll）に委ね、セットアップとティアダウンを対で宣言する
  - 根拠: test-fixture-patterns — Playwright の `use()` 前後で setup/teardown を対にし、クリーンアップ漏れを構造的に防止
- `[SHOULD]` グローバルセットアップで生成コストの高いリソース（DB スキーマ等）はソースファイルの mtime を比較し、変更時のみ再生成する
  - 根拠: test-infrastructure — `global-setup.ts` でスキーマと DB の mtime 比較によるスキップ最適化
- `[SHOULD]` MSW モックハンドラを開発環境とテスト環境で共用し、モック定義の重複・乖離を防ぐ
  - 根拠: mock-and-stub-patterns — `tests/mocks/` に全ハンドラ集約、`MOCKS=true` と Vitest setupFiles から同一コード参照
- `[SHOULD]` モックハンドラのデフォルトは正常系レスポンスとし、異常系は個別テストの `server.use()` で上書きする
  - 根拠: mock-and-stub-patterns — `pwned-passwords.ts` で正常系デフォルト、`auth.server.test.ts` で異常系上書き
- `[AVOID]` シードデータの特定レコードに依存するテストを書く — テスト自身がデータを生成すべき
  - 根拠: test-data-management — base DB は `--skip-seed` で作成、テストがシードデータに依存しない設計
- `[AVOID]` E2E テストでユニットテストが適切な範囲の検証を行う — 純粋関数は Vitest で高速にカバーし、E2E はユーザージャーニーに限定する
  - 根拠: testing-strategy — `getErrorMessage` のパターン網羅は Vitest、「ノートを作成できる」は E2E

## E2E テスト

- `[MUST]` E2E テストの認証フィクスチャでは、プロダクションコードのセッション生成ロジックを再利用して Cookie を作成する
  - 根拠: e2e-testing-patterns — `authSessionStorage` と `sessionKey` をアプリ本体からインポートし Cookie 生成
- `[MUST]` テストデータを作成するフィクスチャは、同じフィクスチャ内にティアダウンを持ち、`use()` の前がセットアップ、後がティアダウンとして対称的に記述する
  - 根拠: e2e-testing-patterns — `insertNewUser`, `login`, `prepareGitHubUser` すべてが `use()` 後に削除処理を実装
- `[SHOULD]` 認証が前提条件に過ぎないテストでは UI ログインをバイパスし、DB + Cookie 注入で認証状態を構築する
  - 根拠: authentication-testing — `notes.test.ts` 等は `login` フィクスチャで即座に認証済み状態を得る
- `[SHOULD]` E2E テストのセレクタは CSS クラスや `data-testid` ではなく ARIA ロール（`getByRole`）を優先する
  - 根拠: e2e-testing-patterns — 8つの E2E テストすべてで `getByRole`, `getByLabel`, `getByText` が一貫使用
- `[SHOULD]` テスト共通のフィクスチャは `test.extend` で定義し、テスト固有のフィクスチャは同パターンで拡張する。フィクスチャ階層は2段階までに抑える
  - 根拠: e2e-testing-patterns — 共通フィクスチャ + テスト固有フィクスチャの2層で全テストを構成
- `[AVOID]` `page.waitForLoadState('networkidle')` を E2E テストのタイミング制御に使う — 特定の要素の状態を待機する
  - 根拠: e2e-testing-patterns — SPA のバックグラウンドリクエストで idle にならないケースがある

## エラーハンドリング

- `[MUST]` フォームバリデーション失敗はフォームにエラーを返し、throw しない — ユーザー入力エラーは通常フローとして処理しフォーム状態を保持する
  - 根拠: error-handling-idioms — 全 action で `submission.reply()` を返しており、throw は使わない
- `[SHOULD]` HTTP レスポンスを生成する事前条件チェックには `invariantResponse`（Response を throw）を使い、内部ロジックのアサーションには `invariant`（Error を throw）を使い分ける
  - 根拠: error-handling-idioms — loader/action の 16 箇所以上で `invariantResponse` が HTTP ステータスコード付きで使用
- `[SHOULD]` Error Boundary はステータスコード別ハンドラを受け取る汎用コンポーネントとして実装し、各ルートでカスタマイズする
  - 根拠: error-handling-idioms — `GeneralErrorBoundary` が `statusHandlers` を props で受け取り、10 以上のルートで利用
- `[AVOID]` 予期された HTTP エラー（404, 403 等）を外部エラー監視サービスに送信する — Sentry 等には予期しないエラーのみを報告する
  - 根拠: error-handling-idioms — `isRouteErrorResponse` で判定し、予期されたエラーは `captureException` をスキップ

## セキュリティ

- `[MUST]` セッション Cookie には `httpOnly`, `secure` (本番), `sameSite: 'lax'` を必ず設定する
  - 根拠: security-practices — 全 Cookie 設定で一貫して適用
- `[MUST]` ユーザー入力由来のリダイレクト先には安全なリダイレクト検証（`safeRedirect()` 相当）を適用し、オープンリダイレクト攻撃を防止する
  - 根拠: security-practices — `safeRedirect()` が全てのリダイレクト箇所で使用
- `[MUST]` レート制限はエンドポイントの機密度に応じて段階化する — 認証エンドポイントに最も厳しい制限を適用する
  - 根拠: security-practices — `/login`, `/signup`, `/verify` に一般の 1/10 の制限を適用
- `[MUST]` フォールセーフな外部 API（パスワード漏洩チェック等）は、タイムアウト・サーバーエラー・不正レスポンスの全異常系で安全側にフォールバックすることをテストする
  - 根拠: authentication-testing — 正常系2件 + 異常系3件を全て検証し、全異常系で `false` を期待
- `[SHOULD]` 外部サービスへの依存は「未設定でもアプリが起動・動作する」ようにフォールバックを実装する
  - 根拠: design-philosophy — Sentry・Resend・GitHub OAuth すべて optional、未設定時はコンソール出力やモックで代替
- `[SHOULD]` CSP nonce はリクエストごとに暗号学的に安全な方法で生成し、アプリケーション全体に一貫して伝播させる
  - 根拠: security-practices — `crypto.randomBytes(16).toString('hex')` で生成、`NonceProvider` で全コンポーネントに供給
- `[SHOULD]` レート制限の IP 識別には CDN/PaaS が付与する信頼できるヘッダーを優先し、`X-Forwarded-For` や `req.ip` への直接依存を避ける
  - 根拠: security-practices — `fly-client-ip` を優先、IP スプーフィング耐性を確保
- `[AVOID]` GET リクエストで状態変更を行うこと — `SameSite=Lax` Cookie に依存する CSRF 保護が無効化される
  - 根拠: security-practices — CSRF トークン削除の前提条件として GET mutation が存在しないことが明記
- `[AVOID]` フォームバリデーションのエラーレスポンスにパスワード等の機密フィールドを含めること
  - 根拠: security-practices — `submission.reply({ hideFields: ['password'] })` で機密情報を除外

## プロジェクト構成と規約

- `[MUST]` サーバー専用コードはファイル命名規約（`.server.ts`）でクライアントバンドルから物理的に排除し、ビルドツールの設定と合わせて二重のガードを設ける
  - 根拠: project-structure, architecture — `app/routes.ts` で `*.server.*` を除外、`vite-env-only` プラグインでも保護
- `[MUST]` import エイリアスはビルドツール固有の設定（tsconfig paths 等）ではなく、ランタイムがネイティブにサポートする仕組み（Node.js subpath imports 等）を優先する
  - 根拠: dev-conventions — `package.json` の `imports` に一元化し、TypeScript・Vitest・Playwright のいずれからも解決可能
- `[MUST]` コード品質ツール（ESLint・Prettier・TypeScript）の設定は共有設定パッケージまたはプリセットを使い、プロジェクト側は差分のみカスタマイズする
  - 根拠: dev-conventions — `@epic-web/config` で3ツールの設定を集約、プロジェクト側の設定ファイルは最小限
- `[SHOULD]` テストファイルはテスト対象モジュールと同一ディレクトリにコロケートする
  - 根拠: project-structure — `app/routes/users/$username/index.test.tsx` が対象ファイルの隣に配置
- `[SHOULD]` インフラ横断的関心事（セキュリティヘッダー、レートリミット、ログ、圧縮）はアプリケーションのルートハンドラの外側（ミドルウェア層）に集約する
  - 根拠: architecture — `server/index.ts` に全インフラミドルウェアが集約、`server/app.ts` は 23 行で純粋なリクエストハンドリング
- `[SHOULD]` ORM クエリでは `select` を明示的に指定し、必要なフィールドのみを取得する
  - 根拠: architecture — 全ルートが `select` 使用、唯一の `include` 使用箇所はコメントで理由明示
- `[SHOULD]` 認証・認可ガードは段階的な関数チェーン（`getOptionalUser` → `requireUser` → `requireUserWithPermission`）で構成する
  - 根拠: architecture — nullable 返却、リダイレクト throw、403 throw が段階的に構成
- `[SHOULD]` 設計上の意思決定は ADR（Architecture Decision Records）として記録し、「なぜその選択をしたか」を追跡可能にする
  - 根拠: design-philosophy — 47 件の ADR で判断の撤回・変更も追跡可能
- `[AVOID]` アプリケーションの本質に関係しないファイル（Dockerfile、アイコン原本、ツール設定等）をプロジェクトルートに放置すること
  - 根拠: project-structure — `other/` ディレクトリに集約し、ルートのノイズを削減
- `[AVOID]` ツール固有のパス解決設定（TypeScript `paths`, Vitest `resolve.alias` 等）を複数の設定ファイルに重複定義すること
  - 根拠: dev-conventions — `tsconfig.json` の `paths` を廃止し `package.json` `imports` に一元化

## CI/CD

- `[MUST]` CI のキャッシュキーにはファイル内容のハッシュ（`hashFiles`）を使い、ブランチ名やタイムスタンプに依存させない
  - 根拠: ci-cd — `schema.prisma` と `migration.sql` のハッシュ組み合わせで決定論的キャッシュ
- `[MUST]` テストジョブとデプロイジョブを分離し、`needs` でテスト全通過をデプロイの前提条件にする
  - 根拠: ci-cd — `deploy` ジョブが全ジョブの成功を `needs` で要求
- `[SHOULD]` E2E テストの並列度とリトライ回数は環境変数で切り替え、テストコード自体は環境を意識しない設計にする
  - 根拠: ci-cd — `process.env.CI` による分岐を設定レイヤーに限定
- `[SHOULD]` コンテナイメージのビルドとデプロイを分離し、Git SHA でイメージを一意に特定する
  - 根拠: ci-cd — <code v-pre>--image-label ${{ github.sha }}</code> でビルド、同一 SHA でデプロイ
- `[AVOID]` テストの重いセットアップ処理（DB 構築、シード等）を毎回のテスト実行で繰り返す — 変更検知でスキップ可能にする
  - 根拠: ci-cd — スキーマ mtime 比較で不要な再構築をスキップ

## ルール優先度の解釈

- `[MUST]`: 違反するとバグ・セキュリティリスク・重大な設計劣化を招くルール
- `[SHOULD]`: 従うことで品質が向上するが、文脈によっては例外を許容するルール
- `[AVOID]`: 意図的に避けるべきアンチパターン・非推奨プラクティス
