# Showcases

研究結果から抽出された実用的な知見を、テーマ別にまとめたドキュメント集です。

## Pattern

| Showcase                                                     | 概要                                                                       |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| [middleware-composition](./pattern_middleware-composition)   | ファクトリ関数+名前付き関数式+クロージャ事前計算によるミドルウェア合成     |
| [self-rewriting-method](./pattern_self-rewriting-method)     | 初回実行でメソッドを差し替え、2回目以降の分岐コストをゼロにする遅延最適化  |
| [dynamic-argument](./pattern_dynamic-argument)               | `T \| ((ctx) => T)` で静的値と動的関数を統一する設定API設計パターン        |
| [self-filtering-strategy](./pattern_self-filtering-strategy) | 全ハンドラを常に呼び出し各自が自己選別する、switch/if 不要のプラグイン設計 |
| [options-or-false](./pattern_options-or-false)               | `Options \| false` + filter(Boolean) で宣言的にプラグイン配列を構築        |
| [phantom-type](./pattern_phantom-type)                       | optional プロパティへの型情報埋め込みでランタイムコストゼロの型推論を実現   |
| [escalating-escape-hatches](./pattern_escalating-escape-hatches) | 段階的抽象度の拡張ポイントで安全性と柔軟性を両立するライブラリ設計     |
| [subscribable-observer](./pattern_subscribable-observer)         | 30行のSubscribable基底クラスで6フレームワーク対応の最小購読パターン     |
| [consume-aware-resource](./pattern_consume-aware-resource)       | AbortSignalのgetter検出で消費有無を判定し適応的にキャンセルするリソース管理 |
| [register-declaration-merging](./pattern_register-declaration-merging) | 空Registerインターフェース+declaration mergingでライブラリ型をグローバルカスタマイズ |

## Practice

| Showcase                                                              | 概要                                                                           |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [type-safe-pipeline](./practice_type-safe-pipeline)                   | any フィルター付き型合成でチェーン全体の型崩壊を防ぐ防御的型設計               |
| [zero-dep-security](./practice_zero-dep-security)                     | Web Crypto API のみによるゼロ依存・マルチランタイム対応セキュリティ            |
| [test-suite-factory](./practice_test-suite-factory)                   | createTestSuite() + Capability フラグで20超実装に統一契約テストを適用          |
| [defensive-validation](./practice_defensive-validation)               | LLM出力の5段階フォールバック検証と制約ダウングレードによる防御的バリデーション |
| [declarative-config-layering](./practice_declarative-config-layering) | defu/ディープマージの引数順序で優先順位を表現する宣言的設定マージ              |
| [define-helper-pattern](./practice_define-helper-pattern)             | defineXxxConfig ヘルパーによるゼロコスト型補完パターン（横断的）               |
| [tree-shaking-library](./practice_tree-shaking-library)               | ファクトリ関数+@\_\_NO_SIDE_EFFECTS\_\_+sideEffects:falseによる完全tree-shaking |
| [dual-layer-testing](./practice_dual-layer-testing)                   | ランタイムテスト+型テストの1:1対応とドメイン固有ヘルパーによる統一テスト戦略   |
| [branded-domain-primitives](./practice_branded-domain-primitives)     | Valibot brand()+ファクトリ関数+InferOutputでドメインプリミティブを型安全に構築 |
| [result-error-pipeline](./practice_result-error-pipeline)             | byethrow Result.try/pipe/unwrapの3イディオムで関数型エラーハンドリングを統一   |
| [in-source-testing](./practice_in-source-testing)                     | import.meta.vitest+await using+createFixtureによるin-source testingパターン   |
| [supply-chain-defense](./practice_supply-chain-defense)               | pnpmの4層設定によるサプライチェーン多層防御（strictDepBuilds等）               |
| [structural-sharing](./practice_structural-sharing)                   | 構造的共有+Proxy追跡+バッチ通知の三重レンダリング最適化                        |
| [monorepo-quality-gates](./practice_monorepo-quality-gates)           | publint/attw/size-limit/sherif/knipの5ツールによる多層CI品質検証               |

## Claude

| Showcase                                              | 概要                                                                          |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| [multi-ai-tool-config](./claude_multi-ai-tool-config) | Claude Code/Cursor/Copilot 3ツール並行管理とカスタムMCPサーバーの実践パターン |
