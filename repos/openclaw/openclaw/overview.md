# openclaw/openclaw

> URL: https://github.com/openclaw/openclaw
> Stars: 193.3k | 言語: TypeScript | ライセンス: MIT | 分析日: 2026-02-14

## サマリー

30以上のメッセージングチャネルとマルチプラットフォームネイティブアプリを単一のTypeScriptコアで統合する大規模AIゲートウェイから学べる核心は、「契約ベースの拡張設計」「スキーマ駆動のクロスプラットフォーム型安全性」「マルチエージェント開発を前提とした安全規約」の3軸にある。Fat Core + Thin Extensionsのmonorepo構成でコアのリファクタリング自由度を保ちながら、Plugin SDKのFacadeパターンで34以上の拡張との契約を安定させる手法は、プラグインシステムを持つあらゆるプロジェクトに応用可能である。TypeBoxスキーマからTypeScript型・AJVバリデータ・JSON Schema・Swiftモデルを自動生成し、CIで`git diff --exit-code`による整合性検証を行うパイプラインは、マルチ言語プロジェクトの型同期の模範的実装である。

## 技術スタック

- **言語**: TypeScript (ESM, strict mode), Swift (macOS/iOS), Kotlin (Android)
- **フレームワーク**: Express 5, Lit (Web Components), grammy, Slack Bolt, Carbon (Discord)
- **ビルド**: tsdown (rolldown-based), tsc (.d.ts生成), tsgo (型チェック)
- **テスト**: Vitest (6設定ファイル, vmForks/forks動的切替, V8 coverage 70% thresholds)
- **リント/フォーマット**: oxlint (型情報付き), oxfmt (Rust製)
- **パッケージマネージャ**: pnpm 10 (workspace, overrides, minimumReleaseAge)
- **バリデーション**: TypeBox (プロトコル), Zod v4 (設定), AJV (ランタイム検証)
- **データベース**: SQLite + sqlite-vec
- **ネイティブアプリ**: macOS (Swift/AppKit), iOS (SwiftUI), Android (Kotlin/Compose)

## 分析した視点

| #  | 視点                     | ファイル                          | 概要                                                                                                            |
| -- | ------------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1  | Project Structure        | project-structure.md              | Fat Core + Thin Extensions構成で40以上の内部ドメインを単一パッケージに集約し、Plugin SDKで公開API面を制御       |
| 2  | Architecture             | architecture.md                   | Gateway Mediatorが全チャネル・エージェント間を仲介し、Dock/Plugin二層抽象化でN+M疎結合を実現                    |
| 3  | Design Philosophy        | design-philosophy.md              | TypeBoxスキーマをSingle Source of Truthとしクロスプラットフォーム型生成、Rust製ツールチェーンで開発速度を最大化 |
| 4  | Extensibility Mechanisms | extensibility-mechanisms.md       | OpenClawPluginApi Facadeで11種のregisterメソッドを提供し、34+拡張がコア内部を知らず動作                         |
| 5  | Type System Patterns     | type-system-patterns.md           | TypeBox・Zod・AJVを境界ごとに使い分け、LLM互換stringEnumヘルパーで外部制約に適応                                |
| 6  | Code Organization        | code-organization.md              | ドット区切りファイル名で論理グルーピング、多層バレルで公開API制御、500LOC上限をCI強制                           |
| 7  | Abstraction Patterns     | abstraction-patterns.md           | Capability-basedオプショナルインターフェースと遅延importプロキシDIで多チャネル統合を実現                        |
| 8  | Error Handling Idioms    | error-handling-idioms.md          | 構造化コード付きカスタムエラー型、BFSによるcauseチェーン走査、致命度3段階の未処理rejection分類                  |
| 9  | Testing Practices        | testing-practices.md              | unit/e2e/liveの3層分類を6設定ファイルで制御、決定論的ポートブロック割り当てで並列テスト安定化                   |
| 10 | Build and Tooling        | build-and-tooling.md              | Rust製ツール(tsdown/oxlint/oxfmt/tsgo)で全フェーズ高速化、スマート再ビルドで不要なビルドをスキップ              |
| 11 | Performance Techniques   | performance-techniques.md         | 適応的コンテキストウィンドウ管理、レーンベース並列化、サーキットブレーカー付きバッチフォールバック              |
| 12 | Security Practices       | security-practices.md             | 多層プロンプトインジェクション防御、宣言的秘匿フィールド管理、タイミング安全な秘密比較の徹底                    |
| 13 | API Design Practices     | api-design-practices.md           | TypeBox一元定義から4形態を自動生成、冪等性キー必須、ハンドラ冒頭バリデーション+構造化エラー                     |
| 14 | Dependency Management    | dependency-management.md          | overrides+minimumReleaseAge+onlyBuiltDependenciesの三層サプライチェーン防御、workspace:*はdevDeps限定           |
| 15 | AI Settings              | ai-settings.md                    | AGENTS.md正式名+CLAUDE.mdシンボリックリンク、6項目のマルチエージェント安全性ルール、3段階PRスキル               |
| 16 | Multi-Platform Patterns  | multi-platform-patterns.md        | TypeBox->JSON Schema->Swiftコード生成パイプライン、CI diff検証、共有パッケージ3層分割                           |
| 17 | Dev Conventions          | dev-conventions.md                | スコープドコミッターでgit add .禁止、3段階PRパイプライン、AI生成PR歓迎+透明性チェックリスト                     |
| 18 | Concurrency Patterns     | concurrency-patterns.md           | PID検証付きファイルロック、世代番号付きレーンキュー、bindAbortRelayでメモリリーク防止                           |
| 19 | Messaging Integration    | messaging-integration-patterns.md | Registry/Dock/Pluginの三層チャネル抽象化、Capabilitiesフラグによる機能ネゴシエーション                          |
| 20 | Media Processing         | media-processing-patterns.md      | 多段MIME検出、環境適応型バックエンド切替、withTempDirスコープ付きクリーンアップの徹底                           |

## 特に注目すべき知見

- **Dock/Plugin 二層抽象化による Import コスト制御**: 共有コードパスが参照する軽量メタデータ層（Dock）と、実行境界でのみロードされる重量実装層（Plugin）を分離するパターン。30以上のチャネル統合でルーティングやコマンド認可が不要な依存を引き込まず、起動時間と循環依存を構造的に抑制する。このパターンはマルチプロバイダ統合一般に即座に適用可能であり、project-structure / architecture / design-philosophy / abstraction-patterns / messaging-integration-patterns の5つの視点から一貫して観察された。

- **スキーマ駆動のクロスプラットフォーム型安全パイプライン**: TypeBoxでプロトコルを一元定義し、`Static<typeof>`でTypeScript型を導出、AJVでバリデータをコンパイル、JSON Schemaを生成、Swift Codable構造体を自動生成する。CIで`git diff --exit-code`を実行し再生成漏れを検出するパターンは、手書きの型同期が破綻する規模のプロジェクトで不可欠である。LLMプロバイダが`anyOf`を拒否する実運用制約に対し、`stringEnum`ヘルパーでJSON Schemaレベルの出力を制御する手法は、AIツール統合特有の知見として価値が高い。

- **マルチエージェント安全性の具体的ルール設計**: 複数のAIエージェントが同一リポジトリを並行操作する環境で、`git stash`禁止・ブランチ切り替え禁止・`git add .`禁止を具体的なコマンドレベルで列挙し、`scripts/committer`ラッパーで構造的に強制する手法。曖昧なガイドラインではなくツールによる強制を組み合わせることで、AIエージェントの安全性を実用レベルで担保している。

- **Capability-based オプショナルインターフェースによる段階的拡張**: `ChannelPlugin`型の20以上のアダプタスロットをすべてオプショナルにし、必須は4フィールドのみとする設計。新しいチャネルは最小実装で参加でき、`ChannelCapabilities`のbooleanフラグで機能の有無を宣言する。共有コードはフラグを確認してから機能を呼び出すため、新機能追加が既存実装を壊さない。この「最小契約 + 段階的な機能宣言」の組み合わせは、プラグインシステム設計の模範パターンである。

- **構造化エラー型と致命度分類による堅牢なエラー処理**: カスタムエラークラスに文字列リテラルunion型の`code`/`reason`フィールドを持たせ、`instanceof`で型安全に判別する。未処理rejectionハンドラがエラーを致命的/設定/一時的ネットワーク/その他に4段階で分類し、一時的障害ではプロセスを落とさない設計は、長時間稼働するゲートウェイプロセスの可用性確保として即座に応用可能である。

## クイックリファレンス

- [導出ルール集](rules.md) -- CLAUDE.md に貼れる形式の全ルール
