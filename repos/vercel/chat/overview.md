# vercel/chat

> URL: https://github.com/vercel/chat
> Stars: 388 | 言語: TypeScript | ライセンス: MIT | 分析日: 2026-02-25

## サマリー

6つのチャットプラットフォーム(Slack/Teams/Google Chat/Discord/GitHub/Linear)を単一 TypeScript SDK で統一するプロジェクト。mdast AST を正規フォーマットに採用し N:N のプラットフォーム変換を N+N に削減する設計、optional メソッド+ケイパビリティ検出による段階的フォールバック戦略、pnpm モノレポのパッケージ境界で依存方向を物理的に強制するアーキテクチャが三本柱。Adapter パターン・カスタム JSX ランタイム・構造化 Thread ID・Recording & Replay テストなど、クロスプラットフォーム SDK 設計の実践パターンが豊富に詰まっている。

## 技術スタック

- **言語**: TypeScript (ESM)
- **フレームワーク**: 独自 Chat SDK（mdast/unified ベース）
- **ビルド**: Turborepo + tsup
- **テスト**: Vitest (with coverage)
- **パッケージマネージャ**: pnpm (monorepo)
- **リンター/フォーマッター**: Biome (Ultracite preset)
- **リリース**: Changesets
- **未使用検出**: Knip
- **状態管理**: Redis (ioredis) / Cloudflare KV
- **CI**: GitHub Actions

## 分析した視点

| #  | 視点                            | ファイル                           | 概要                                                                                                                                |
| -- | ------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1  | project-structure               | project-structure.md               | pnpm+Turborepo モノレポで14パッケージを4層に分け、一方向依存をパッケージ境界で物理的に強制                                          |
| 2  | architecture                    | architecture.md                    | コアがインターフェースのみ定義し依存逆転を徹底、mdast AST 正規化と optional メソッドによるケイパビリティ分岐が設計の要              |
| 3  | design-philosophy               | design-philosophy.md               | mdast AST を正規フォーマットに採用し N:N 変換を N+N 化、段階的フォールバックで最低共通分母に切り下げない設計思想                    |
| 4  | adapter-implementation-patterns | adapter-implementation-patterns.md | ジェネリクス付き Adapter インターフェース、構造化 Thread ID エンコーディング、webhook 署名検証の統一パターンを6アダプターで一貫適用 |
| 5  | type-system-patterns            | type-system-patterns.md            | 段階的ジェネリクス具体化、Mapped 型による API 自動生成、モジュール拡張による型拡張ポイント、シリアライズ専用型の分離                |
| 6  | streaming-patterns              | streaming-patterns.md              | AsyncIterable を統一入力とし、ネイティブ streaming/post+edit フォールバックの二層戦略を Capability Detection で自動分岐             |
| 7  | cross-platform-normalization    | cross-platform-normalization.md    | AST 正規化・構造化 ThreadID・絵文字双方向変換テーブルの3層正規化で、6プラットフォームの差異をビジネスロジックから完全分離           |
| 8  | api-design-practices            | api-design-practices.md            | post() が7種の入力を受け付ける多態的設計、ファクトリ関数の環境変数フォールバック、SentMessage の Fluent API                         |
| 9  | hook-and-lifecycle-patterns     | hook-and-lifecycle-patterns.md     | 状態駆動ディスパッチ(subscribed 優先)、重複排除→ロック→ハンドラ選択のパイプライン、waitUntil パターンでサーバーレス対応             |
| 10 | error-handling-idioms           | error-handling-idioms.md           | コア層 ChatError/アダプター層 AdapterError の二層エラー階層、レイヤー境界変換、段階的フォールバックと usedFallback フラグ           |
| 11 | testing-practices               | testing-practices.md               | 三層テスト(ユニット/合成統合/Replay)、インターフェース準拠モックファクトリ、本番 webhook の録画再生テスト戦略                       |
| 12 | serialization-patterns          | serialization-patterns.md          | 型タグ付き toJSON/fromJSON 対称ペア、Symbol ベースの外部 serde プロトコル統合、シングルトン遅延解決によるプロセス間受け渡し         |
| 13 | state-management-patterns       | state-management-patterns.md       | StateAdapter に3機能(サブスクリプション/ロック/KV)を集約、TTL-first 設計、Lua アトミックロック解放、Connection Coalescing           |
| 14 | jsx-runtime-patterns            | jsx-runtime-patterns.md            | React 非依存のカスタム JSX ランタイムでドメイン DSL を構築、IntrinsicElements={} で HTML 禁止、6アダプターへの変換を IR 経由で実現  |
| 15 | build-and-tooling               | build-and-tooling.md               | tsup ESM 単一出力+external/noExternal でバンドル境界制御、Turborepo 宣言的タスク依存、validate 段階的ゲート                         |
| 16 | ai-settings                     | ai-settings.md                     | 貢献者向け CLAUDE.md/利用者向け SKILL.md の対象読者別分離、npm 同梱ドキュメント、検証コマンドの強調注入                             |
| 17 | ci-cd                           | ci-cd.md                           | CI 並列3ジョブ+workflow_run リリースチェーン、モック環境変数でのビルド独立性、Preview Branch webhook プロキシ                       |
| 18 | dev-conventions                 | dev-conventions.md                 | Ultracite zero-config ベースライン+最小例外宣言、Knip 未使用コード検出、pnpm validate 単一ゲートで全品質チェック集約                |

## 特に注目すべき知見

- **AST 正規化で O(N+N) 変換**: mdast を canonical format に据え、各プラットフォームは「mdast との往復変換」だけを実装すれば済む。N 対 N の変換行列を N+N に削減する設計パターンとして、チャット以外のクロスプラットフォーム変換にも応用可能
- **optional メソッド + Capability Detection + 段階的フォールバック**: `stream?()`, `openDM?()`, `postEphemeral?()` のように optional メソッドで adapter の能力を宣言し、コア側が自動的にフォールバックチェーンを構築する。「最低共通分母に切り下げない」思想で、対応プラットフォームではリッチな体験を、非対応では graceful degradation を実現
- **connectPromise による Connection Coalescing**: 接続処理中の Promise をキャッシュし、複数の同時呼び出しが同一接続を共有するパターン。分散システムの「thundering herd」問題を簡潔に解決
- **Recording & Replay テスト戦略**: 本番 webhook ペイロードを Redis に録画し、JSON fixture としてエクスポートしてテストに使用。モックでは再現困難なプラットフォーム固有のペイロード構造を正確にテスト可能
- **カスタム JSX ランタイムによるドメイン DSL**: React に依存せず `jsxDEV` / `Fragment` を自前実装し、`IntrinsicElements = {}` で HTML 要素を型レベルで禁止。Card/Modal などの構造化 UI をプラットフォーム非依存な IR として表現し、各アダプターが固有フォーマットに変換

## クイックリファレンス

- [導出ルール集](rules.md) — CLAUDE.md に貼れる形式の全ルール
