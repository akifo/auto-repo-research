# unjs/unbuild

> URL: https://github.com/unjs/unbuild
> Stars: 2.7k | 言語: TypeScript | ライセンス: MIT | 分析日: 2026-02-16

## サマリー

unbuild は約 2,500 行の小規模コードベースに、ライブラリビルドツール設計の定石を凝縮したリポジトリである。「package.json の出力宣言からビルド入力を逆算する」ゼロコンフィグ思想、BuildContext を唯一の結合点とする疎結合ビルダーアーキテクチャ、hookable による 20 フックポイントの宣言的拡張モデルが三位一体となり、設定ゼロから段階的カスタマイズまでをシームレスに提供する。defu による宣言的設定レイヤリング、`Options | false` パターン、Discriminated Union + Self-filtering による条件分岐の排除、`defineXxx` ヘルパーによるゼロコスト型補完など、ライブラリ API 設計・型設計・プラグインアーキテクチャの汎用プラクティスが豊富に学べる。

## 技術スタック

- **言語**: TypeScript (ESModule)
- **フレームワーク**: 独自ビルドシステム（Rollup, mkdist, untyped, copy の4ビルダー統合）
- **ビルド**: 自身（unbuild によるセルフホスティングビルド）、jiti による JIT 実行
- **テスト**: Vitest + @vitest/coverage-v8
- **パッケージマネージャ**: pnpm
- **リンター**: ESLint (eslint-config-unjs) + Prettier
- **主要依存**: hookable, citty, consola, defu, pathe, pkg-types, mlly, esbuild, rollup

## 分析した視点

| #  | 視点                        | ファイル                       | 概要                                                                                                                 |
| -- | --------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 1  | project-structure           | project-structure.md           | Facade + 水平/垂直分割で25ファイルを構造化し、統一シグネチャのビルダー配列と判別可能ユニオン型で拡張性を確保         |
| 2  | architecture                | architecture.md                | BuildContextを唯一の結合点としてビルダーを疎結合に統合し、defuによる宣言的レイヤリングとフック名前空間で拡張性を実現 |
| 3  | design-philosophy           | design-philosophy.md           | package.jsonから出力を逆算するゼロコンフィグ、安全側デフォルト+脱出口、セルフホスティングによるDX自己検証の設計思想  |
| 4  | abstraction-patterns        | abstraction-patterns.md        | Self-filteringパターンでディスパッチャの条件分岐を排除し、Discriminated Unionとフック型合成で型安全な抽象化を実現    |
| 5  | type-system-patterns        | type-system-patterns.md        | 内部厳密型/外部寛容型の分離、DeepPartial+Omitによる設定型緩和、Options\|falseパターンでライブラリ型設計の定石を凝縮  |
| 6  | hook-and-lifecycle-patterns | hook-and-lifecycle-patterns.md | 20のフックポイントを3層ライフサイクルで設計し、intersection型合成と登録順序による優先度制御で宣言的拡張モデルを構築  |
| 7  | configuration-patterns      | configuration-patterns.md      | ゼロコンフィグ→部分上書き→プリセット共有の3層設定システムをdefuディープマージとdefineヘルパーで型安全に実現          |
| 8  | code-generation-techniques  | code-generation-techniques.md  | JSON.stringifyによる安全なリテラル埋め込み、冪等なコード変換、rollup .write()再利用による効率的な多重出力生成        |
| 9  | dependency-management       | dependency-management.md       | package.jsonを真実源としたexternals自動推論と、ビルド後のunused/implicit依存検出で宣言的な依存管理を実現             |
| 10 | testing-practices           | testing-practices.md           | 純粋変換ロジックのユニットテスト+フィクスチャ統合検証+セルフホスティングの3層で最小コスト・高信頼のテスト戦略を実現  |

## 特に注目すべき知見

- **Self-filtering Strategy パターン**: オーケストレーターが全ビルダーを常に呼び出し、各ビルダーが `entries.filter(e => e.builder === "xxx")` で自己選択する。ディスパッチャ側に switch/if 分岐が一切なく、新しいビルダーの追加が配列への1行追加で完結する。プラグインシステムを持つあらゆるツールに応用できる汎用パターンである。（architecture, abstraction-patterns）

- **defu による宣言的設定レイヤリング**: `defu(buildConfig, pkg.unbuild, inputConfig, preset, defaults)` の引数順序がそのまま優先順位を表現し、命令的な if/switch 分岐なしで 5 層の設定をマージする。`satisfies` でデフォルト値の型を検証し `as` で出力型を確定する二段構えは、ディープマージ関数と TypeScript を組み合わせる際の実践的テクニックである。（configuration-patterns, design-philosophy）

- **`Options | false` パターンによるプラグイン制御**: プラグインの設定型を `PluginOptions | false` とし、`false` で明示的に無効化できる API を提供する。`&&` 短絡評価 + `.filter(Boolean)` で条件付きプラグイン配列を宣言的に構築する手法は、Rollup に限らずあらゆるプラグインシステムに適用できる。（type-system-patterns, configuration-patterns）

- **package.json からの出力逆算によるゼロコンフィグ**: ユーザーが宣言するのは「何をパブリッシュするか」（exports, main, types）であり、「どうビルドするか」はツールが逆算する。この「出力仕様から入力を推論する」アプローチは、既存のメタデータを活用してユーザーの認知負荷を下げる設計の好例である。（design-philosophy, configuration-patterns）

- **フック型の intersection 合成と名前空間化**: 各ビルダーが独立した Hooks interface を定義し、`BuildHooks extends CopyHooks, UntypedHooks, MkdistHooks, RollupHooks` で型安全に統合する。フック名は `scope:phase` のコロン区切り規約でスコープと粒度を明示し、フック名だけでどのビルダーのどのフェーズかが判別できる。（hook-and-lifecycle-patterns, type-system-patterns）

## クイックリファレンス

- [導出ルール集](rules.md) — CLAUDE.md に貼れる形式の全ルール
