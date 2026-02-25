# cloudflare/partykit

> URL: https://github.com/cloudflare/partykit
> Stars: 997 | 言語: TypeScript | ライセンス: ISC | 分析日: 2026-02-25

## サマリー

Cloudflare Durable Objects の低レベル API を「薄い基底クラス + ライフサイクルフック」で抽象化し、リアルタイムサーバーフレームワークを構築するプロジェクト。プラットフォーム制約の隠蔽手法（Template Method + Strategy パターンで Hibernation 差異を透過化）、モノレポにおけるパッケージ境界設計（peerDependencies + subpath exports による環境別分離）、そして TypeScript の Mixin パターンを軸とした拡張性設計が、他のフレームワーク開発やモノレポ構築に直接応用できるプラクティスの宝庫である。

## 技術スタック

- **言語**: TypeScript (ESNext, strict, Bundler resolution)
- **ランタイム**: Cloudflare Workers / Durable Objects
- **ビルド**: tsdown, tsx
- **テスト**: Vitest + @cloudflare/vitest-pool-workers
- **フォーマット/リント**: Oxfmt, Oxlint
- **パッケージマネージャ**: npm workspaces
- **バージョニング**: Changesets
- **モノレポ品質管理**: Sherif

## 分析した視点

| #  | 視点                        | ファイル                       | 概要                                                                                                                |
| -- | --------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| 1  | project-structure           | project-structure.md           | peerDependencies による疎結合な依存グラフと subpath exports による環境別エントリポイント分離の一貫した適用          |
| 2  | architecture                | architecture.md                | 薄い基底クラス + ライフサイクルフックで DO を抽象化し、mixin/継承/factory の3手法で拡張する開放閉鎖設計             |
| 3  | design-philosophy           | design-philosophy.md           | プラットフォーム制約をフック可能な空スロットに変換し、規約ベース自動検出で設定ゼロ DX を実現する思想                |
| 4  | hook-and-lifecycle-patterns | hook-and-lifecycle-patterns.md | 排他的初期化 + 状態リセットによるリトライ保証と、Strategy パターンで Hibernation 差異を隠蔽するフック設計           |
| 5  | type-system-patterns        | type-system-patterns.md        | デフォルト付きジェネリクスによる段階的型付けと、再帰的イミュータブル型 + satisfies による型安全性の確保             |
| 6  | abstraction-patterns        | abstraction-patterns.md        | Mixin/Strategy/Factory/継承を問題の性質に応じて使い分け、configurable: true で下流拡張点を提供する抽象化設計        |
| 7  | api-design-practices        | api-design-practices.md        | subpath exports で環境分離し、ESM/CJS デュアルはクライアントのみに限定する最小コスト API 設計                       |
| 8  | composition-patterns        | composition-patterns.md        | Mixin + プリセットの二層 API、Factory のクロージャキャプチャ、三値フックによる宣言的制御フロー合成                  |
| 9  | concurrency-patterns        | concurrency-patterns.md        | 排他ブロック外再スローによるデッドロック回避と、Hibernation/Wake-up を同一コードパスで処理する並行性制御            |
| 10 | state-management-patterns   | state-management-patterns.md   | __pk/__user ネームスペース分離と遅延復元 + WeakMap キャッシュによる Hibernation 対応状態管理                        |
| 11 | error-handling-idioms       | error-handling-idioms.md       | トランスポート適応型エラー返却、排他ブロック外再スロー、ランダムジッター付き指数バックオフの多層エラー戦略          |
| 12 | testing-practices           | testing-practices.md           | テストシナリオごとに DO サブクラスを分離し、workerd/jsdom/Node の3環境を設定ファイル分割で管理するテスト戦略        |
| 13 | build-and-tooling           | build-and-tooling.md           | tsdown のプログラマティック API でビルドし、成果物にもフォーマッター適用、check-exports で exports 整合性を自動検証 |
| 14 | ai-settings                 | ai-settings.md                 | コマンド中心主義の単一ファイル AGENTS.md で、設定の意図補足と Common Patterns による AI 向けガイドライン設計        |
| 15 | streaming-patterns          | streaming-patterns.md          | Observable チェーンでリカバリーロジックを隠蔽し、FIFOScheduler + BulkRequestDispatcher で並行制御する設計           |
| 16 | dependency-management       | dependency-management.md       | peerDependencies 二重宣言 + sherif 一貫性検証 + changesets の慎重なバージョニングによるモノレポ依存管理             |

## 特に注目すべき知見

- **排他ブロック外再スローパターン**: `blockConcurrencyWhile` 内でエラーを変数に退避し、ブロック外で再スローすることで input gate デッドロックを防止しつつリトライを可能にする。排他制御を伴う初期化処理なら Durable Objects に限らず広く応用できる設計パターン（hook-and-lifecycle-patterns, concurrency-patterns, error-handling-idioms で横断的に確認）

- **Mixin + プリセットの二層 API 設計**: `withYjs(Base)` 関数で柔軟な Mixin 合成を提供しつつ、`export const YServer = withYjs(Server)` でシンプルなプリセットも公開する。上級者には合成の自由度を、入門者にはゼロ設定の簡便さを同時に提供するパターン（architecture, composition-patterns, abstraction-patterns で横断的に確認）

- **WebSocket Attachment の __pk/__user ネームスペース分離**: プラットフォーム内部メタデータとユーザーデータを同一ストレージ内で名前空間で分離し、互いの干渉を構造的に防止する。共有ストレージを複数レイヤーが使う場面に汎用的に適用できる（architecture, state-management-patterns, abstraction-patterns で横断的に確認）

- **check-exports によるビルド後 exports 整合性自動検証**: `package.json` の `exports` フィールドを再帰的に走査し、記載されたファイルの実在をビルド直後に検証する。モノレポでパッケージを公開するプロジェクトなら即座に導入できる品質ゲート（project-structure, build-and-tooling, api-design-practices で横断的に確認）

- **三値フック（Response | Request | void）による宣言的制御フロー**: 前処理フックの戻り値型で短絡（拒否）/ 変形（ヘッダ注入等）/ 続行を表現し、単一のフック型で認証・変形・パススルーの3パターンを網羅する。ミドルウェア設計に直接応用できるパターン（composition-patterns, hook-and-lifecycle-patterns で確認）

## クイックリファレンス

- [導出ルール集](rules.md) — CLAUDE.md に貼れる形式の全ルール
