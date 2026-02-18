# epicweb-dev/epic-stack

> URL: https://github.com/epicweb-dev/epic-stack
> Stars: 5.5k | 言語: TypeScript | ライセンス: MIT | 分析日: 2026-02-18

## サマリー

Epic Stack はフルスタック React アプリケーションのリファレンス実装であり、47件の ADR に裏付けられた意図的な設計判断の集積から学べる。テスト戦略では Testing Trophy モデルに基づく統合テスト中心主義、MSW による外部 API モックの開発・テスト共用、SQLite ファイルコピーによる並列テスト分離といった実践が体系的に適用されている。セキュリティ・型安全性・開発規約のすべてにおいて「安全なデフォルト + 段階的厳格化」という一貫した哲学が貫かれており、フルスタックアプリの設計判断の教科書として活用できる。

## 技術スタック

- **言語**: TypeScript
- **フレームワーク**: React Router v7 (Remix 後継), Express v5
- **ビルド**: Vite 7
- **テスト**: Vitest 4 (unit/integration), Playwright (E2E), MSW 2 (API mock), Testing Library
- **DB**: Prisma 6 + SQLite
- **UI**: Radix UI, Tailwind CSS v4, shadcn/ui
- **認証**: bcrypt, TOTP, Passkey (SimpleWebAuthn), GitHub OAuth (remix-auth)
- **デプロイ**: Fly.io
- **パッケージマネージャ**: npm

## 分析した視点

| #  | 視点                       | ファイル                  | 概要                                                                                                                        |
| -- | -------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1  | プロジェクト構成           | project-structure.md      | .server.tsサフィックスによるバンドル境界制御、コロケーション優先の配置、Node.js subpath importsによるエイリアス統一         |
| 2  | アーキテクチャ             | architecture.md           | Express+React Router+Prismaの3層構造、一方向依存、ミドルウェアへのインフラ関心事集約、selectによるデータ最小取得            |
| 3  | 設計哲学                   | design-philosophy.md      | 47件のADRによる判断追跡、サービス最小化、段階的サービス導入（Deferred Setup）、Web標準への収束                              |
| 4  | テスト戦略                 | testing-strategy.md       | 統合テスト中心主義、MSWによる外部APIモック共用、DBスナップショットコピー分離、カスタムマッチャーによるドメインアサーション  |
| 5  | テスト基盤                 | test-infrastructure.md    | globalSetup/setupFilesの多層構成、VITEST_POOL_IDによるDB分離、console.error throw化、Viteプラグインによるモジュール差し替え |
| 6  | E2Eテストパターン          | e2e-testing-patterns.md   | test.extendによる宣言的フィクスチャ、Cookie直接注入の認証バイパス、ARIAロールベースセレクタ、型安全ナビゲーション           |
| 7  | モック・スタブパターン     | mock-and-stub-patterns.md | MSWハンドラの開発・テスト・E2E共用、環境変数プレフィックスによるMock/Real切り替え、デフォルト正常系+テスト内異常系上書き    |
| 8  | テストデータ管理           | test-data-management.md   | 3層ファクトリ構造、UniqueEnforcerによる一意性保証、mtime比較によるbase DB再生成スキップ                                     |
| 9  | テストフィクスチャパターン | test-fixture-patterns.md  | Playwrightはuse()コールバックで宣言的リソース管理、Vitestはプロセスレベルの環境構成                                         |
| 10 | 認証テスト                 | authentication-testing.md | DB+Cookie直接注入による認証バイパス、MSW+ファイルフィクスチャによるOAuthモック、フォールセーフ外部APIの異常系テスト         |
| 11 | エラーハンドリング         | error-handling-idioms.md  | invariant/invariantResponseの使い分け、Zod+Conformのフォームバリデーション、GeneralErrorBoundaryのstatusHandlersパターン    |
| 12 | 型システムパターン         | type-system-patterns.md   | Zodスキーマ駆動型定義、z.infer/z.inputの使い分け、Prisma型のIndexed Access、satisfiesによる型整合性検証                     |
| 13 | セキュリティ実装           | security-practices.md     | 階層化レート制限、CSP nonce注入、統一TOTP検証基盤、HIBP漏洩チェック、SameSite=LaxによるCSRFトークン不要化                   |
| 14 | CI/CD                      | ci-cd.md                  | 5ジョブ並列実行、スキーマハッシュベースのDBキャッシュ、Build-then-Deployパターン、SHAベースのイメージタグ                   |
| 15 | 開発規約                   | dev-conventions.md        | @epic-web/configによる設定一元管理、Node.js subpath importsへの段階的移行、.server.tsによるバンドル境界宣言                 |

## 特に注目すべき知見

- **SQLite ファイルコピーによるテスト分離**: `VITEST_POOL_ID` でワーカーごとに独立した DB ファイルを割り当て、`beforeEach` でマイグレーション済みの base DB をコピーする。トランザクションロールバック方式よりも単純で確実な並列テスト分離を実現しており、ファイルベース DB を使うあらゆるプロジェクトに即座に適用できる。

- **MSW モックハンドラの開発・テスト・E2E 三環境共用**: 同一の MSW ハンドラ定義を `MOCKS=true` の開発環境、Vitest のセットアップ、Playwright の E2E テストで再利用する。モック定義の乖離を構造的に防ぎ、「開発では動くがテストで壊れる」問題を排除する。環境変数プレフィックス (`MOCK_`) によるモック/リアル切り替えも実用的。

- **console.error/warn のデフォルト throw 化**: テストセットアップで `console.error` / `console.warn` を例外に変換し、意図的な場合のみ `mockImplementation(() => {})` でオプトアウトする。サイレントに失敗するテストを根絶する仕組みであり、エラーメッセージに解除方法を含めることで開発者の学習コストも最小化している。

- **Zod スキーマ駆動の型定義と環境変数バリデーション**: ランタイムバリデーションスキーマから `z.infer` で型を導出し、`declare global` で `ProcessEnv` を拡張する。起動時バリデーション + ホワイトリスト方式のクライアント公開で、環境変数の型安全性と秘匿情報の漏洩防止を二重に担保する。

- **ADR による技術選定の追跡可能性**: 47件の Architecture Decision Records により、技術選定の「なぜ」と「何を諦めたか」が追跡可能。パスエイリアスの 3 回の変更（tsconfig paths -> package.json imports + paths -> imports のみ）や CSRF トークンの導入・削除といった判断の変遷が完全に記録されている。

## クイックリファレンス

- [導出ルール集](rules.md) — CLAUDE.md に貼れる形式の全ルール
