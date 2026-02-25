# Showcases

研究結果から抽出された実用的な知見を、テーマ別にまとめたドキュメント集です。

## Pattern

| Showcase                                                               | 概要                                                                                           |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [middleware-composition](./pattern_middleware-composition)             | ファクトリ関数+名前付き関数式+クロージャ事前計算によるミドルウェア合成                         |
| [self-rewriting-method](./pattern_self-rewriting-method)               | 初回実行でメソッドを差し替え、2回目以降の分岐コストをゼロにする遅延最適化                      |
| [dynamic-argument](./pattern_dynamic-argument)                         | `T \| ((ctx) => T)` で静的値と動的関数を統一する設定API設計パターン                            |
| [self-filtering-strategy](./pattern_self-filtering-strategy)           | 全ハンドラを常に呼び出し各自が自己選別する、switch/if 不要のプラグイン設計                     |
| [options-or-false](./pattern_options-or-false)                         | `Options \| false` + filter(Boolean) で宣言的にプラグイン配列を構築                            |
| [phantom-type](./pattern_phantom-type)                                 | optional プロパティへの型情報埋め込みでランタイムコストゼロの型推論を実現                      |
| [escalating-escape-hatches](./pattern_escalating-escape-hatches)       | 段階的抽象度の拡張ポイントで安全性と柔軟性を両立するライブラリ設計                             |
| [subscribable-observer](./pattern_subscribable-observer)               | 30行のSubscribable基底クラスで6フレームワーク対応の最小購読パターン                            |
| [consume-aware-resource](./pattern_consume-aware-resource)             | AbortSignalのgetter検出で消費有無を判定し適応的にキャンセルするリソース管理                    |
| [register-declaration-merging](./pattern_register-declaration-merging) | 空Registerインターフェース+declaration mergingでライブラリ型をグローバルカスタマイズ           |
| [promise-coalescing](./pattern_promise-coalescing)                     | 並行リクエストの重複排除+無効化タイムスタンプ検証でキャッシュ整合性を保証                      |
| [weakmap-scoped-state](./pattern_weakmap-scoped-state)                 | WeakMap+ファクトリ関数による環境スコープ状態管理でメモリリークを防止                           |
| [dependency-injection](./pattern_dependency-injection)                 | 関数引数DI→遅延プロキシ→プッシュ型Hub→型レベルLayer/Tagの4段階DIパターン体系                   |
| [dual-api](./pattern_dual-api)                                         | dual()でdata-first/data-last両スタイルを単一実装から自動導出する二重APIパターン                |
| [symbol-type-identity](./pattern_symbol-type-identity)                 | Symbol.for()+hasProperty型ガードでinstanceof代替の堅牢な型判定を実現                           |
| [ast-interpreter](./pattern_ast-interpreter)                           | AST tagged union+Match型でコンパイル時網羅性チェック付き拡張可能インタプリタ                   |
| [composition-root](./pattern_composition-root)                         | 単一クラス→関数+パイプライン→ビルド関数+コンテキスト→オーケストレーターの4形態Composition Root |
| [scoped-resource-di](./pattern_scoped-resource-di)                     | Layer.scoped→using/Disposable→WeakMap→Observer連動→AbortControllerの5段階リソースDI            |
| [e2e-fixture-composition](./pattern_e2e-fixture-composition)           | Playwright test.extendによる宣言的フィクスチャ設計と認証バイパス・自動クリーンアップ           |
| [capabilities-flag](./pattern_capabilities-flag)                       | booleanフラグでバリアント機能を宣言するインターフェース設計パターン                            |
| [circuit-breaker](./pattern_circuit-breaker)                           | 外部サービスの連続失敗検知+自動遮断+復旧によるCircuit Breakerパターン                          |
| [trait-composition](./pattern_trait-composition)                       | $constructor+init()チェーンでクラス継承を排除しtree-shake可能なトレイト合成                    |
| [adaptive-rate-limiter](./pattern_adaptive-rate-limiter)               | AIMD風3層適応的並列度制御でAPIレートリミットにゼロコンフィグ自動適応                           |
| [zod-enum-handler-map](./pattern_zod-enum-handler-map)                 | Zod enum+Record型ハンドラマップで50種以上の処理分岐の網羅性をコンパイル時保証                  |
| [type-state-builder](./pattern_type-state-builder)                     | センチネル型+条件付き型+TypeError phantomによる型パラメータ状態マシンfluent builder            |
| [recursive-proxy-api](./pattern_recursive-proxy-api)                   | Proxy+ファサード型キャストで型安全な動的APIを構築する二重構造パターン（3防御策込み）           |
| [structural-duck-typing](./pattern_structural-duck-typing)             | -Esque構造型+ランタイムFeature Detectionで外部ライブラリをゼロ依存統合                         |
| [idempotent-schema-migration](./pattern_idempotent-schema-migration)   | CREATE TABLE IF NOT EXISTS+ALTER TABLE ADD COLUMN duplicate無視による無停止スキーマ進化        |
| [resumable-stream-replay](./pattern_resumable-stream-replay)           | SQLiteバッファリング+3フェーズ再開プロトコルによる切断耐性ストリームリプレイ                   |
| [single-alarm-multiplexing](./pattern_single-alarm-multiplexing)       | 単一アラーム制約をSQLiteテーブルで多重化し任意数のスケジュールを統一管理                       |
| [object-augmentation](./pattern_object-augmentation)                   | Object.defineProperty+交差型で継承なしに型安全な機能注入                                       |
| [bidirectional-state-sync](./pattern_bidirectional-state-sync)         | 対称メッセージ型+送信元除外ブロードキャスト+Serializable型制約の双方向ステート同期             |
| [transport-auto-fallback](./pattern_transport-auto-fallback)           | autoモードでstreamable-httpを先に試行し404/405ならSSEにフォールバック                          |
| [subsystem-stacking](./pattern_subsystem-stacking)                     | 単一基盤クラスに独立サブシステムをSQLiteテーブルとして冪等に積層                               |
| [disposable-event-hierarchy](./pattern_disposable-event-hierarchy)     | emit()単一メソッド+DisposableStore+3層バブルアップの階層的イベント伝搬                         |
| [mixin-feature-injection](./pattern_mixin-feature-injection)           | TypeScript mixinで継承チェーン変更なしにクロスカッティング機能を注入                           |
| [exclusive-block-safe-rethrow](./pattern_exclusive-block-safe-rethrow) | 排他制御ブロック内エラーを変数退避+状態リセット+ブロック外再スローでデッドロック防止           |
| [tri-value-hook-control](./pattern_tri-value-hook-control)             | Response\|Request\|voidの三値フック返却で拒否・変形・続行を単一型表現                          |
| [mixin-preset-dual-api](./pattern_mixin-preset-dual-api)               | withFeature(Base) mixin+プリセットexportの二層APIで入門者と上級者を両立                        |

## Practice

| Showcase                                                                | 概要                                                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [type-safe-pipeline](./practice_type-safe-pipeline)                     | any フィルター付き型合成でチェーン全体の型崩壊を防ぐ防御的型設計                     |
| [zero-dep-security](./practice_zero-dep-security)                       | Web Crypto API のみによるゼロ依存・マルチランタイム対応セキュリティ                  |
| [test-suite-factory](./practice_test-suite-factory)                     | createTestSuite() + Capability フラグで20超実装に統一契約テストを適用                |
| [defensive-validation](./practice_defensive-validation)                 | LLM出力の5段階フォールバック検証と制約ダウングレードによる防御的バリデーション       |
| [declarative-config-layering](./practice_declarative-config-layering)   | defu/ディープマージの引数順序で優先順位を表現する宣言的設定マージ                    |
| [define-helper-pattern](./practice_define-helper-pattern)               | defineXxxConfig ヘルパーによるゼロコスト型補完パターン（横断的）                     |
| [tree-shaking-library](./practice_tree-shaking-library)                 | ファクトリ関数+@\_\_NO_SIDE_EFFECTS\_\_+sideEffects:falseによる完全tree-shaking      |
| [dual-layer-testing](./practice_dual-layer-testing)                     | ランタイムテスト+型テストの1:1対応とドメイン固有ヘルパーによる統一テスト戦略         |
| [branded-domain-primitives](./practice_branded-domain-primitives)       | Valibot brand()+ファクトリ関数+InferOutputでドメインプリミティブを型安全に構築       |
| [result-error-pipeline](./practice_result-error-pipeline)               | byethrow Result.try/pipe/unwrapの3イディオムで関数型エラーハンドリングを統一         |
| [in-source-testing](./practice_in-source-testing)                       | import.meta.vitest+await using+createFixtureによるin-source testingパターン          |
| [supply-chain-defense](./practice_supply-chain-defense)                 | pnpmの4層設定によるサプライチェーン多層防御（strictDepBuilds等）                     |
| [structural-sharing](./practice_structural-sharing)                     | 構造的共有+Proxy追跡+バッチ通知の三重レンダリング最適化                              |
| [monorepo-quality-gates](./practice_monorepo-quality-gates)             | publint/attw/size-limit/sherif/knipの5ツールによる多層CI品質検証                     |
| [devdeps-bundling](./practice_devdeps-bundling)                         | devDepsバンドルでランタイムdependenciesを6個に極小化する配布軽量化戦略               |
| [api-lifecycle](./practice_api-lifecycle)                               | experimental/future/legacy三層+getter trap非推奨警告によるAPI進化管理                |
| [tagged-error-hierarchy](./practice_tagged-error-hierarchy)             | _tag+reason二層分類とcatchTagによる型安全エラーディスパッチ                          |
| [test-di-strategies](./practice_test-di-strategies)                     | 境界モック→環境変数スタブ→引数注入→コンテキスト注入→Layer差し替えの5段階テストDI     |
| [context-propagation](./practice_context-propagation)                   | 明示的引数渡し・暗黙的コンテキスト・型パラメータ静的追跡の3分類コンテキスト伝播      |
| [test-db-isolation](./practice_test-db-isolation)                       | SQLiteファイルコピー+VITEST_POOL_IDによる並列テストDB分離パターン                    |
| [msw-multi-env-mock](./practice_msw-multi-env-mock)                     | MSWハンドラの開発・テスト・E2E三環境共用と環境変数によるMock/Real切り替え            |
| [test-guardrails](./practice_test-guardrails)                           | console.error throw化+カスタムマッチャーによるテスト品質ガードレール                 |
| [error-normalization-pipeline](./practice_error-normalization-pipeline) | 4リポが独立実装したcatch→構造チェック→wrap→内部型変換のエラー正規化パイプライン      |
| [exhaustive-switch-guard](./practice_exhaustive-switch-guard)           | satisfies never/unreachable(never)によるswitch文の網羅性コンパイル時検査             |
| [subpath-exports-boundary](./practice_subpath-exports-boundary)         | package.json exportsによるAPI境界制御と内部モジュール隠蔽                            |
| [atomic-file-write](./practice_atomic-file-write)                       | 一時ファイル+fsync+renameによるアトミックファイル書き込みでデータ破損防止            |
| [explicit-resource-management](./practice_explicit-resource-management) | using/await using+Symbol.disposeによるスコープ束縛型リソース管理                     |
| [llm-mock-design](./practice_llm-mock-design)                           | 3モード入力MockLanguageModel+忠実度別FakeChatModel+呼び出し記録によるLLMテスト設計   |
| [ai-fixture-management](./practice_ai-fixture-management)               | 実APIレスポンスキャプチャ+SSEチャンクフィクスチャ+型安全テストサーバーによるAIテスト |
| [provider-conformance-testing](./practice_provider-conformance-testing) | ファクトリ関数vsクラス継承の2アプローチによるAIプロバイダー横断適合テスト            |
| [llm-test-optimization](./practice_llm-test-optimization)               | AIエージェント向けテスト出力最適化+バージョン横断テスト+統合テストキャッシュ戦略     |
| [streaming-leak-prevention](./practice_streaming-leak-prevention)       | subscribe/unsubscribeペア+null解放+WeakMap+bind()による長寿命Promiseメモリリーク防止 |
| [exports-trinity-verification](./practice_exports-trinity-verification) | package.json exports/ビルドエントリ/CIスクリプトの三位一体によるAPI整合性自動検証    |
| [eager-retry-validation](./practice_eager-retry-validation)             | リトライ設定の登録時即座バリデーション+tryN単一リトライ基盤+二重try-catch            |
| [multi-runtime-test-isolation](./practice_multi-runtime-test-isolation) | vitest projectsによるWorkers/ブラウザ/Node.js/型テストの4層ランタイム分離            |
| [single-point-access-control](./practice_single-point-access-control)   | アクセス制御を共通パスの単一ポイントに集約しチェック漏れを構造的に排除               |
| [stability-tier-workspaces](./practice_stability-tier-workspaces)       | 安定度ティアによるワークスペース分類とchangeset/CI/依存方向のティア別制御            |
| [hibernation-safe-state](./practice_hibernation-safe-state)             | WebSocket attachment+ネームスペース分離によるHibernation/eviction対応状態管理        |
| [peer-deps-dual-declaration](./practice_peer-deps-dual-declaration)     | peerDependencies広レンジ+devDependencies具体バージョン二重宣言+sherif一貫性検証      |

## Claude

| Showcase                                                            | 概要                                                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [multi-ai-tool-config](./claude_multi-ai-tool-config)               | Claude Code/Cursor/Copilot 3ツール並行管理とカスタムMCPサーバーの実践パターン         |
| [progressive-context-loading](./claude_progressive-context-loading) | CLAUDE.md/AGENTS.md/.claude/の階層設計によるAIへの段階的コンテキストロード            |
| [agent-command-guardrails](./claude_agent-command-guardrails)       | 禁止コマンド列挙+scratchpadサンドボックス+ホワイトリスト権限によるAIガードレール      |
| [prompt-injection-defense](./claude_prompt-injection-defense)       | 外部データ処理時のプロンプトインジェクション防御の多層設計                            |
| [llms-txt-mcp-integration](./claude_llms-txt-mcp-integration)       | llms.txt/llms-full.txt/MCPサーバー3段階のAI向けドキュメント提供パターン               |
| [hierarchical-agents-md](./claude_hierarchical-agents-md)           | CLAUDE.md委任+ディレクトリ別AGENTS.md+PostToolUseフックによる階層的AIコンテキスト管理 |
| [always-ask-never-boundaries](./claude_always-ask-never-boundaries) | Always/Ask first/Neverの3段階行動境界でAIツールの行動を明示的に制御                   |

## Tool

| Showcase                                                  | 概要                                                                        |
| --------------------------------------------------------- | --------------------------------------------------------------------------- |
| [pnpm-catalogs](./tool_pnpm-catalogs)                     | catalog:プロトコル+catalogMode:strictによるモノレポ依存バージョン一元管理   |
| [publint-attw-validation](./tool_publint-attw-validation) | publint+attwによるnpmパッケージexports/types設定の自動検証                  |
| [oxide-toolchain](./tool_oxide-toolchain)                 | oxlint+oxfmt Oxideツールチェーンによる高速lint/format+単一checkコマンド集約 |

## Workflow

| Showcase                                                            | 概要                                                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [codegen-diff-ci](./workflow_codegen-diff-ci)                       | コード生成→git diff --exit-codeによる生成コード一貫性のCI検証                         |
| [loc-limit-enforcement](./workflow_loc-limit-enforcement)           | CIスクリプト+AIルール二層でファイル行数上限を強制し巨大ファイル化を防止               |
| [e2e-parallel-isolation](./workflow_e2e-parallel-isolation)         | リソース複製によるE2Eテスト並列実行時のテスト間干渉排除                               |
| [lint-enforced-architecture](./workflow_lint-enforced-architecture) | Biome/ESLintのnoRestrictedGlobals等でアーキテクチャ制約を機械的に強制するワークフロー |
| [self-consuming-api](./workflow_self-consuming-api)                 | 公開APIのみでファーストパーティadapterを実装しlintで境界強制する自己消費テスト運用    |
| [pkg-pr-new-preview](./workflow_pkg-pr-new-preview)                 | pkg-pr-newによるPRプレビューパッケージ公開+changesets+Playwright3層キャッシュCI/CD    |
