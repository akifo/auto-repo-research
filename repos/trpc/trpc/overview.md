# trpc/trpc

> URL: https://github.com/trpc/trpc
> Stars: 39.6k | 言語: TypeScript | ライセンス: MIT | 分析日: 2026-02-24

## サマリー

tRPC は「型をランタイムの代わりにする」という哲学のもと、Proxy によるパス蓄積 + ファサード型キャストという二重構造で、コード生成なしのエンドツーエンド型安全 RPC を実現している。このリポジトリから学べる核心は、(1) 型パラメータを状態マシンとして扱う fluent builder の設計技法、(2) ESLint + 命名規約 + subpath exports の三層で内部/公開 API 境界を機械的に強制するモノレポ管理手法、(3) ミドルウェア・バリデーション・リゾルバを統一パイプラインに変換する合成アーキテクチャの 3 点に集約される。これらは tRPC 固有の知識ではなく、TypeScript ライブラリ設計・モノレポ運用・拡張可能なフレームワーク構築に広く応用できるプラクティスである。

## 技術スタック

- **言語**: TypeScript 5.9.2
- **ビルド**: tsdown (per-package), Turborepo (orchestration), Lerna (publishing)
- **テスト**: Vitest 3.1 (jsdom, istanbul coverage, `await using` リソース管理)
- **リント**: ESLint 9 (typescript-eslint, unicorn, react-hooks, flat config)
- **フォーマット**: Prettier
- **パッケージマネージャ**: pnpm 9.12 (workspace)

## 分析した視点

| #  | 視点                            | ファイル                           | 概要                                                                                                    |
| -- | ------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1  | project-structure               | project-structure.md               | pnpm+Turborepo+Lerna三層モノレポで、unstable-core命名とESLintによるAPI境界の機械的強制を実現            |
| 2  | architecture                    | architecture.md                    | Web Standard正規化のコア+Proxy透過API+import type結合で8アダプタをコア変更なしに維持                    |
| 3  | design-philosophy               | design-philosophy.md               | 型推論によるコンパイル時保証、段階的移行のAPI安定性スペクトラム、ランタイム防御の三層で哲学を具現化     |
| 4  | type-system-patterns            | type-system-patterns.md            | 8型パラメータBuilder、TypeError phantom型、UnsetMarkerセンチネル等の型レベルプログラミング体系          |
| 5  | composition-patterns            | composition-patterns.md            | 不変ビルダーチェーン、IntersectIfDefined型合成、mergeWithoutOverridesによる型安全な合成体系             |
| 6  | proxy-based-type-inference      | proxy-based-type-inference.md      | 87行の2種Proxyプリミティブからクライアント・React・SSG全統合レイヤーを構築する二重構造パターン          |
| 7  | middleware-composition          | middleware-composition.md          | 再帰チェーン実行、middlewareMarkerブランド型、コンテキスト差分マージの型追跡で統一パイプラインを実現    |
| 8  | api-design-practices            | api-design-practices.md            | 3層エクスポート戦略、experimental_プレフィックス、ValidateShape型によるAPI境界とライフサイクル管理      |
| 9  | adapter-implementation-patterns | adapter-implementation-patterns.md | resolveResponse単一関数にプロトコル処理を集約し、アダプタは変換・委譲・書き戻しの薄い翻訳層に徹する設計 |
| 10 | error-handling-idioms           | error-handling-idioms.md           | catch直後の正規化関数、Result型伝播、ErrorFormatter/onError分離によるエラー処理の体系的設計             |
| 11 | testing-practices               | testing-practices.md               | 集約テストパッケージ、issue番号命名の回帰テスト、await using自動クリーンアップ、expectTypeOf型テスト    |
| 12 | streaming-patterns              | streaming-patterns.md              | producer/consumerペアによるプロトコル分離、Unpromiseメモリリーク防止、tracked再接続復旧の設計体系       |
| 13 | schema-validation-patterns      | schema-validation-patterns.md      | 構造的型付け+ランタイムduck typingで10以上のバリデータをゼロ依存で統合するParser抽象                    |
| 14 | extensibility-mechanisms        | extensibility-mechanisms.md        | 3層クロージャのリンクチェーン、lazy router遅延ロード、experimental_callerによる多層拡張機構             |
| 15 | dev-conventions                 | dev-conventions.md                 | T/$二重プレフィックス型命名、Symbol.dispose隔離、ASTセレクタ禁止等の多層的開発規約                      |
| 16 | build-and-tooling               | build-and-tooling.md               | tsdown onSuccessによるエントリポイント自動生成とpackage.json exports起点の動的テストエイリアス          |
| 17 | ci-cd                           | ci-cd.md                           | 4段階リリースチャネル、pkg-pr-new即時PR公開、Semantic PRスコープ動的生成のCI/CD戦略                     |
| 18 | performance-techniques          | performance-techniques.md          | Proxyメモ化、DataLoaderバッチ、Unpromise参照管理、明示的null解放によるパフォーマンス最適化体系          |

## 特に注目すべき知見

- **Proxy + ファサード型による型安全 API の動的構築**: `createRecursiveProxy<TFaux>` はわずか 87 行でパス蓄積 Proxy を実装し、ファサード型 `TFaux` でコンパイル時の型安全性を外付けする。この「ランタイムは Proxy、型はキャスト」という二重構造は、コード生成なしで型安全なルーティング・RPC・ORM を構築する汎用パターンとして即座に応用可能。`then` ガード、noop ターゲット、メモ化辞書の 3 つの防御策がセットで必要になる点も実践的。

- **すべてをミドルウェアに統一するパイプライン設計**: 入力バリデーション (`createInputMiddleware`)、出力バリデーション (`createOutputMiddleware`)、リゾルバすべてを同一の `MiddlewareFunction` シグネチャにラップし、`callRecursive` 単一関数で実行する。新しい横断的関心事（キャッシュ、レートリミット等）もミドルウェアとして追加するだけでパイプラインに統合される。この「関心事の統一的な合成」は任意のリクエスト処理フレームワークに応用できる。

- **構造的型付け（duck typing）による外部ライブラリ非依存統合**: `getParseFn()` は zod/valibot/yup/arktype 等 10 以上のバリデータを、メソッド存在チェックだけで統合する。アダプタークラスを一切作らず、`-Esque` サフィックスの構造型定義 + ランタイム Feature Detection で対応する手法は、プラグインシステムや外部ライブラリ統合の設計に広く適用可能。

- **ESLint `no-restricted-imports` によるアーキテクチャ境界の機械的強制**: アダプタ層から `unstable-core-do-not-import` への直接インポートを ESLint で禁止し、ファーストパーティアダプタがサードパーティと同じ公開 API で実装されることを保証する「自己消費テスト」パターン。lint ルール違反の蓄積を「公開 API の不足」のシグナルとして活用する運用知見も含む。

- **`TypeError<'Context mismatch'>` による人間が読める型レベルエラー**: `never` の代わりにブランド型 `TypeError<TMessage>` を使い、IDE のエラーメッセージで「何が間違っているか」を具体的に伝達する。ProcedureBuilder の `concat()` で 10 箇所以上使用されており、fluent API の型安全設計で即座に活用できるパターン。

## クイックリファレンス

- [導出ルール集](rules.md) — CLAUDE.md に貼れる形式の全ルール
