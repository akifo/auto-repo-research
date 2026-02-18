# vitejs/vite

> URL: https://github.com/vitejs/vite
> Stars: 78.2k | 言語: TypeScript | ライセンス: MIT | 分析日: 2026-02-17

## サマリー

Vite は「速度と DX の両立」を実現するために、Lean Extendable Core・ネイティブツールの段階的導入・devDependencies バンドル戦略という3本柱で設計されている。プラグインシステム・型設計・エラーハンドリング・セキュリティに至るまで、78k stars のエコシステムを支えるプラクティスが凝縮されており、大規模 OSS の API 設計・後方互換管理・パフォーマンス最適化・CI/CD パイプライン構築の実践的リファレンスとして極めて有用である。

## 技術スタック

- **言語**: TypeScript (isolatedDeclarations, strict モード)
- **フレームワーク**: Node.js (ESM)
- **ビルド**: Rolldown (コアのセルフバンドル), tsdown (サブパッケージ)
- **テスト**: Vitest (ユニット), Vitest + Playwright (E2E)
- **パッケージマネージャ**: pnpm (workspaces, patches, overrides)
- **リンター**: ESLint (flat config) + Prettier
- **Git Hooks**: simple-git-hooks + lint-staged

## 分析した視点

| #  | 視点                     | ファイル                    | 概要                                                                                                                                          |
| -- | ------------------------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1  | project-structure        | project-structure.md        | pnpm workspaces で3公開パッケージ・40+ playground・docsを統合し、実行環境別のソース分離とバンドル境界に基づく依存分類を徹底                   |
| 2  | architecture             | architecture.md             | Environment API による多環境抽象化、enforce+hook.order の二段階プラグイン順序制御、Proxy ベースの設定合成を実装                               |
| 3  | design-philosophy        | design-philosophy.md        | Lean Extendable Core・ブラウザ委譲・Pragmatic Performance の3原則で速度とDXを両立し、devDeps バンドル戦略で配布を軽量化                       |
| 4  | abstraction-patterns     | abstraction-patterns.md     | ObjectHook パターンでフック関数とメタデータを共存させ、mergeConfig/mergeWithDefaults の分離と宣言的フィルタで拡張性を確保                     |
| 5  | performance-techniques   | performance-techniques.md   | ETag 多層キャッシュ・リクエスト重複排除・ソフト無効化・プラグインフィルタリング・計測コードのゼロコスト化を体系的に実装                       |
| 6  | type-system-patterns     | type-system-patterns.md     | 公開型/内部型/ソース型の3層分離、satisfies never による網羅性チェック、string & {} パターン、isolatedDeclarations を活用                      |
| 7  | code-organization        | code-organization.md        | ランタイム境界をモジュール境界として厳密に分離し、exports の null マッピングと tsconfig の include 制限で依存方向を構造的に保証               |
| 8  | error-handling-idioms    | error-handling-idioms.md    | エラーコード定数による分岐、コードフレーム生成、prepareError による正規化、多段フォールバックのオーバーレイ表示を実装                         |
| 9  | testing-practices        | testing-practices.md        | playground-temp 隔離コピーでの E2E テスト、環境変数による serve/build デュアルモード実行、expect.poll によるポーリング検証を採用              |
| 10 | api-design-practices     | api-design-practices.md     | UserConfig(optional)→ResolvedConfig(required) 変換、experimental/future/legacy の三層 API ライフサイクル、getter trap 非推奨警告を体系化      |
| 11 | dependency-management    | dependency-management.md    | devDeps を Rolldown でバンドルし dependencies を6個に抑制、遅延 import()・npm alias・pnpm patches・bundleSizeLimit で軽量化を徹底             |
| 12 | build-and-tooling        | build-and-tooling.md        | Rolldown セルフバンドル+tsdown のパッケージ別ツール選択、型バンドリング+消費者視点チェックの二段パイプライン、shimDepsPlugin で依存書き換え   |
| 13 | extensibility-mechanisms | extensibility-mechanisms.md | Rollup 互換のスーパーセット設計、hookFirst/Sequential/Parallel の実行戦略使い分け、applyToEnvironment による環境分岐を実現                    |
| 14 | dev-conventions          | dev-conventions.md          | レイヤード ESLint flat config で役割別に厳格度を調整、Prettier+lint-staged+simple-git-hooks の自動化、セマンティック PR タイトル検証を構築    |
| 15 | ci-cd                    | ci-cd.md                    | 変更検知による CI スキップ、ゲートジョブパターン、tag トリガー+Environment 承認の2段階リリース、エコシステム CI で下流影響を事前検知          |
| 16 | migration-patterns       | migration-patterns.md       | 自動変換レイヤー(esbuild→oxc)、Property Proxy(rollup→rolldown)、future/legacy フラグ、中間パッケージで段階的移行を実現                        |
| 17 | security-practices       | security-practices.md       | DNS rebinding・WebSocket hijacking・XSSI に対する多層ミドルウェア防御、Secure by Default の CORS/ホスト設定、timingSafeEqual トークン検証     |
| 18 | concurrency-patterns     | concurrency-patterns.md     | Promise 重複排除・デバウンス付き排他制御・キャンセル可能な非同期処理・マイクロタスクバッファリング・Promise.allSettled シャットダウンを体系化 |

## 特に注目すべき知見

- **WeakMap + ファクトリ関数による環境スコープ状態管理（`perEnvironmentState`）**: マルチ環境で動作するプラグインの状態を WeakMap で分離し、明示的な初期化・破棄コードを不要にするパターン。GC と連動するためメモリリークも防げる。プラグインシステムに限らず、マルチテナントやリクエストスコープの状態管理に広く応用できる。

- **devDependencies バンドル戦略によるランタイム依存の極小化**: ランタイムで使うパッケージを devDependencies に配置し、ビルド時にバンドルして dependencies を6パッケージまで削減する逆転戦略。npm alias（debug→obug）、shimDepsPlugin による依存コード書き換え、bundleSizeLimit による自動ガードレールを組み合わせ、配布パッケージの軽量性を構造的に保証する。

- **UserConfig（optional）→ ResolvedConfig（required）の型状態分離と三層 API ライフサイクル**: ユーザー入力は全フィールド optional、解決後は Required で内部コードの null チェックを排除する型設計。さらに experimental→安定→future→legacy→削除の API ライフサイクルを型名前空間で構造化し、getter trap で非推奨アクセスを検知して移行ドキュメント URL 付き警告を出す仕組みは、大規模エコシステムの API 進化管理の模範。

- **Promise 重複排除（Coalescing）+ 無効化タイムスタンプ検証**: 同一 URL への並行リクエストを `_pendingRequests` Map で合流させつつ、`lastInvalidationTimestamp` と比較して古い結果の再利用を防止する。キャッシュの高速化と整合性保証を両立する汎用的な並行処理パターン。

- **playground-temp 隔離 + 環境変数デュアルモード E2E テスト**: playground を workspace メンバーとして実ユーザープロジェクト同様の構造でテストし、playground-temp へのコピーでソース汚染を防止。`VITE_TEST_BUILD` 1つで serve/build モードを切り替え、テストコードの重複を排除する。ビルドツール・フレームワークの E2E テスト設計として即座に転用可能。

## クイックリファレンス

- [導出ルール集](rules.md) — CLAUDE.md に貼れる形式の全ルール
