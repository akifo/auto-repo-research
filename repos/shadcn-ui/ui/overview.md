# shadcn-ui/ui

> URL: https://github.com/shadcn-ui/ui
> Stars: 107.6k | 言語: TypeScript | ライセンス: MIT | 分析日: 2026-03-04

## サマリー

shadcn/ui は「ライブラリではなくコード配布」というパラダイムを、CLI パイプライン・レジストリシステム・AST 変換基盤の三位一体で実現した大規模プロジェクトである。コンポーネントのソースコードをユーザーのプロジェクトにコピーし、Zod スキーマで配布物の契約を保証しつつ、14種の AST トランスフォーマーが環境差異を吸収する設計は、コード配布プラットフォームの実践的なリファレンスアーキテクチャとして極めて価値が高い。特に「スキーマ境界によるレイヤー分離」「統一インターフェースのパイプライン合成」「構造化エラーの suggestion フィールド」は、フレームワークや言語を問わず即座に応用できる汎用的なプラクティスである。

## 技術スタック

- **言語**: TypeScript
- **フレームワーク**: Next.js (ドキュメントサイト), Commander.js (CLI)
- **ビルド**: tsup (CLI パッケージ), Turborepo (モノレポ管理)
- **テスト**: Vitest, MSW (HTTP モック)
- **パッケージマネージャ**: pnpm workspaces
- **AST 操作**: ts-morph, recast + Babel, PostCSS
- **スキーマ**: Zod
- **コンポーネント基盤**: Radix UI, Tailwind CSS, cva (class-variance-authority)
- **リリース**: Changesets

## 分析した視点

| #  | 視点                               | ファイル                              | 概要                                                                                                                            |
| -- | ---------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1  | project-structure                  | project-structure.md                  | pnpm workspaces + Turborepo で CLI・レジストリ・テスト・テンプレートを4層分離し、publish 対象を1パッケージに限定                |
| 2  | architecture                       | architecture.md                       | CLI→Preflight→Registry→Transformer→Updater の単方向パイプラインで、Zod スキーマがレイヤー境界のゲートキーパーとして機能         |
| 3  | design-philosophy                  | design-philosophy.md                  | コードの所有権をユーザーに譲渡するコード配布モデルを AST 変換パイプラインとスキーマ駆動レジストリで実現                         |
| 4  | registry-distribution-architecture | registry-distribution-architecture.md | namespace による連邦型レジストリ、トポロジカルソートによる依存解決、Promise キャッシュによる重複排除を統合した配布基盤          |
| 5  | code-transformation-pipeline       | code-transformation-pipeline.md       | 統一 Transformer 型で14種の AST 変換を合成し、設定駆動の早期リターンとコアロジック再利用エクスポートで拡張性を確保              |
| 6  | schema-validation-patterns         | schema-validation-patterns.md         | discriminatedUnion で12種のアイテム型を3バリアントに集約し、z.infer + Extract で型安全なバリアント操作を実現                    |
| 7  | cli-framework-patterns             | cli-framework-patterns.md             | Commander + Zod オプション検証 + preflight 分離 + Shadow Config で多様なプロジェクト環境に適応する CLI アーキテクチャ           |
| 8  | api-design-practices               | api-design-practices.md               | subpath exports で6エントリポイントを段階的に公開し、data-slot + ComponentProps で安定的なコンポーネント API 契約を提供         |
| 9  | composition-patterns               | composition-patterns.md               | AST トランスフォーマー・PostCSS プラグイン・トポロジカルソートの3層パイプラインと cn()+data-slot のコンポーネント合成           |
| 10 | configuration-patterns             | configuration-patterns.md             | raw→resolved の2層スキーマ設計、フレームワーク自動検出、DeepPartial ファクトリで多様なプロジェクト構成を吸収                    |
| 11 | error-handling-idioms              | error-handling-idioms.md              | 16サブクラスの構造化エラー階層に suggestion フィールドを持たせ、handleError で単一集約する CLI エラー戦略                       |
| 12 | type-system-patterns               | type-system-patterns.md               | z.infer を SSOT とした型導出優先アプローチ、React.ComponentProps によるインターフェースレス Props、Extract によるバリアント抽出 |
| 13 | extensibility-mechanisms           | extensibility-mechanisms.md           | Union 型設定で参入障壁を最小化し、namespace + 環境変数展開 + MCP サーバーで多層の拡張ポイントを提供                             |
| 14 | migration-patterns                 | migration-patterns.md                 | 純粋関数の変換コア、マッピングテーブル駆動設計、非破壊マイグレーション戦略で安全なコード自動書き換えを実現                      |
| 15 | testing-practices                  | testing-practices.md                  | Vitest Workspace で単体/統合テストを分離し、MSW + 実 HTTP サーバー + フレームワーク別フィクスチャで CLI テストを階層化          |
| 16 | build-and-tooling                  | build-and-tooling.md                  | cn-* セマンティッククラスでロジックとスタイルを直交分離し、ベース x スタイルの直積をビルド時に AST 変換で合成                   |
| 17 | preflight-validation-patterns      | preflight-validation-patterns.md      | エラーマップ + 成果物の統一戻り値構造で検証と実行を分離し、エラー種別に応じた回復・案内・中断を実現                             |
| 18 | dev-conventions                    | dev-conventions.md                    | Conventional Commits + Changesets + 3層 CI/CD で107k+ stars 規模の品質とリリースフローを自動化                                  |

## 特に注目すべき知見

- **統一インターフェースのパイプライン合成**: `Transformer<Output = SourceFile>` 型で14種の AST 変換を配列として合成し、呼び出し元が条件付きで変換を追加・除外できる設計。各トランスフォーマーは設定値による早期リターンで自己完結し、パイプライン構築コードがシンプルに保たれる。コード変換に限らず、あらゆるデータ変換パイプラインに応用できる汎用パターン。

- **Zod discriminatedUnion + Extract による型安全なバリアント管理**: 12種のレジストリアイテム型を共通スキーマ `.extend()` で3バリアントに集約し、`z.infer` + `Extract<Union, { type: "value" }>` で特定バリアントの型を導出する。スキーマ変更が型に自動伝播し、手書き型との二重管理が構造的に排除される。

- **構造化エラーの suggestion フィールド**: 全16エラーサブクラスが `code`(enum) + `suggestion`(次のアクション提案) + `context`(デバッグ情報) を持ち、CLI・MCP・プログラマティック利用それぞれで適切にエラーを処理・表示できる。`toJSON()` メソッドによるシリアライズ対応も含め、エラー設計のリファレンスとして秀逸。

- **Preflight チェーンによるエラー駆動の回復フロー**: コマンド実行前の環境検証を preflight 関数に分離し、エラーマップを返すことで呼び出し元が「自動回復」「ガイド付き中断」「即時中断」を選択できる。`add` コマンドが `MISSING_CONFIG` エラーで自動的に `init` を実行する設計は、CLI の UX 向上に直結するパターン。

- **Promise キャッシュによる重複リクエスト排除**: HTTP レスポンスの結果ではなく Promise 自体をキャッシュに格納し、`await` 前に登録することで、同一 URL への同時リクエストを1回の HTTP リクエストに統合する。結果キャッシュでは防げない race condition を解決する実用的なテクニック。

## クイックリファレンス

- [導出ルール集](rules.md) -- CLAUDE.md に貼れる形式の全ルール
