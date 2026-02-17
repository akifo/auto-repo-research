# TanStack/query

> URL: https://github.com/TanStack/query
> Stars: 48.5k | 言語: TypeScript | ライセンス: MIT | 分析日: 2026-02-17

## サマリー

TanStack Query は「フレームワーク非依存のコアに全ビジネスロジックを集約し、Observer パターンで 6 つの UI フレームワークに薄いアダプターで接続する」という設計を徹底した非同期状態管理ライブラリである。このコードベースからは、マルチフレームワーク対応のコア/アダプター分離、Action-Reducer による予測可能な状態遷移、構造的共有・Proxy 追跡・バッチ通知を組み合わせたレンダリング最適化、そして TypeScript の型推論を極限まで活用した DX 設計（DataTag、Register パターン、NoInfer）が体系的に学べる。24 パッケージ規模のモノレポ運用（symlink 設定共有、dual build、publint/attw 品質ゲート、マルチ TS バージョン検証）も大規模ライブラリ開発の実践的リファレンスとなる。

## 技術スタック

- **言語**: TypeScript 5.8 (strict mode, noUncheckedIndexedAccess)
- **フレームワーク**: React, Vue, Solid, Svelte, Angular, Preact（6 フレームワーク対応）
- **ビルド**: tsup (modern/legacy dual build), svelte-package, Vite (Angular) + Nx タスクオーケストレーション
- **テスト**: Vitest + jsdom, @testing-library/*, expectTypeOf (型テスト)
- **パッケージマネージャ**: pnpm 10 (workspace)
- **リンター**: ESLint 9 (flat config) + @tanstack/eslint-config + cspell
- **フォーマッター**: Prettier (autofix.ci 自動修正)
- **リリース**: Changesets + pkg-pr-new (PR プレビュー公開)
- **品質ツール**: publint, @arethetypeswrong/cli, size-limit, sherif, knip

## 分析した視点

| # | 視点 | ファイル | 概要 |
| - | ---- | -------- | ---- |
| 1 | プロジェクト構造 | project-structure.md | 24パッケージ4層構造のpnpmモノレポで、symlink設定共有とdual build出力を実現 |
| 2 | アーキテクチャ | architecture.md | query-coreにビジネスロジックを集約し、Observer/Strategy/Facadeで6フレームワークに対応 |
| 3 | 設計思想 | design-philosophy.md | フレームワーク非依存コア・Reducer-in-Class・構造的共有・Register型拡張の設計判断 |
| 4 | 型システムパターン | type-system-patterns.md | DataTagによるQueryKey型伝播、NoInfer・再帰型深度制限・Register宣言マージの型技法 |
| 5 | 抽象化パターン | abstraction-patterns.md | 30行のSubscribableから7派生クラス、QueryBehavior Strategyで拡張性を確保 |
| 6 | 状態管理パターン | state-management-patterns.md | status/fetchStatusの2軸直交設計、Action-Reducer状態遷移、Observer連動GC |
| 7 | エラーハンドリング | error-handling-idioms.md | 指数バックオフリトライ・throwOnError選択制・Error Boundaryリセットプロトコル |
| 8 | テストプラクティス | testing-practices.md | コア純粋テスト+アダプター統合テストの二層構造、型テスト・マルチTSバージョン検証 |
| 9 | API設計 | api-design-practices.md | 単一オブジェクト引数・queryOptionsビルダー・skipToken・experimental_プレフィクス |
| 10 | パフォーマンス技法 | performance-techniques.md | 構造的共有・Proxyプロパティ追跡・NotifyManagerバッチ通知・遅延AbortSignal |
| 11 | 拡張性メカニズム | extensibility-mechanisms.md | 最小契約インターフェース・Observable Cache・差し替え可能シングルトンの拡張設計 |
| 12 | ビルド・ツーリング | build-and-tooling.md | tsup dual build・symlink設定共有・publint/attw/size-limit多層品質ゲート |
| 13 | Observerパターン技法 | observer-pattern-techniques.md | Subscribable基盤・購読数連動リソース管理・バッチ通知・Proxy追跡の通知最適化 |
| 14 | 並行パターン | concurrency-patterns.md | Promise重複排除・スコープ直列化・AbortSignal消費検出・CancelledErrorロールバック |
| 15 | 開発規約 | dev-conventions.md | symlink設定DRY・ESLint flat config・cspell・knip/sherifの多層品質検証 |
| 16 | 依存管理 | dependency-management.md | workspace:*/^使い分け・pnpm overrides型統一・sherif整合性検証・Changesets制御 |
| 17 | フレームワークアダプター | framework-adapter-patterns.md | 3層分離(API/Base/Observer)・Observer注入Strategy・フレームワーク慣習準拠の命名 |
| 18 | CI/CD | ci-cd.md | nx affected/run-many二段構え・Changesets自動リリース・pkg-pr-newプレビュー公開 |

## 特に注目すべき知見

- **30行の Subscribable 基底クラスで 7 つの購読可能エンティティを統一**: `subscribe` が返す unsubscribe 関数が React/Vue/Solid/Svelte/Angular 全てのクリーンアップ機構に直接接続でき、マルチフレームワーク対応の鍵となっている。購読数に連動した GC タイマー管理・イベントリスナー制御も、この最小抽象の上で統一的に実装されている。

- **構造的共有 + Proxy 追跡 + バッチ通知の三重レンダリング最適化**: `replaceEqualDeep` が変更のないサブツリーの参照を維持し、`trackResult` の Proxy がコンポーネントが実際にアクセスしたプロパティのみを追跡し、`notifyManager.batch` が複数の状態変更を 1 回の更新にまとめる。この 3 層の最適化がデフォルトで有効であり、利用者が意識せずとも高パフォーマンスが得られる設計。

- **DataTag + Register パターンによるゼロコスト型安全**: `queryOptions()` が QueryKey に Symbol ベースの phantom type で型情報を埋め込み、`getQueryData` まで型が自動伝播する。さらに `Register` インターフェースの declaration merging で、1 行の宣言でプロジェクト全体のデフォルト型を変更可能。ランタイムコストゼロで end-to-end の型安全を実現。

- **AbortSignal の消費検出による適応的キャンセル**: `Object.defineProperty` の getter で signal のアクセスを検出し、queryFn が signal を使っていればアンマウント時にリクエストをキャンセル、使っていなければ結果をキャッシュに残す。キャンセル対応の有無を事前宣言させず、実行時に適応的に振る舞うプラグマティックな設計。

- **publint + attw + size-limit + sherif + knip の多層品質ゲート**: パッケージの exports 整合性、CJS/ESM 型解決、バンドルサイズ回帰、依存バージョン整合性、未使用コードを 5 つの独立したツールで CI 検証する。単一ツールでは捕捉できない問題を包括的に防ぐモノレポ品質管理の模範。

## クイックリファレンス

- [導出ルール集](rules.md) — CLAUDE.md に貼れる形式の全ルール
