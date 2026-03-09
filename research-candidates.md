# 研究候補リポジトリ 100選

> 多様な言語・ドメイン・設計パターンを持つリポジトリから、汎用的なコーディングプラクティスを抽出するための候補リスト。

## Web Framework (JS/TS)

| # | リポジトリ                                                | 抽出できそうなプラクティス                                                   | Status |
| - | --------------------------------------------------------- | ---------------------------------------------------------------------------- | ------ |
| 1 | [expressjs/express](https://github.com/expressjs/express) | ミドルウェアパターン、後方互換性を保つ API 設計、プラグインアーキテクチャ    |        |
| 2 | [fastify/fastify](https://github.com/fastify/fastify)     | スキーマベースバリデーション、プラグインカプセル化、パフォーマンス最適化     |        |
| 3 | [koajs/koa](https://github.com/koajs/koa)                 | async/await ミドルウェア設計、コンテキストオブジェクトパターン、薄いコア設計 |        |
| 4 | [elysiajs/elysia](https://github.com/elysiajs/elysia)     | 型安全ルーティング、エンドツーエンド型推論、Bun ランタイム最適化             |        |
| 5 | [nitrojs/nitro](https://github.com/nitrojs/nitro)         | ユニバーサルデプロイ抽象化、自動インポート、ストレージレイヤー設計           |        |
| 6 | [tinyhttp/tinyhttp](https://github.com/tinyhttp/tinyhttp) | Express 互換を保ちつつのモダン化、ESM 移行戦略、ゼロレガシー設計             |        |

## Meta-Framework

| #  | リポジトリ                                                    | 抽出できそうなプラクティス                                                         | Status |
| -- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------ |
| 7  | [vercel/next.js](https://github.com/vercel/next.js)           | ファイルベースルーティング、ISR/SSR/SSG 戦略、大規模モノレポ管理                   |        |
| 8  | [nuxt/nuxt](https://github.com/nuxt/nuxt)                     | モジュールシステム設計、自動インポート、Nitro 統合アーキテクチャ                   |        |
| 9  | [remix-run/remix](https://github.com/remix-run/remix)         | Web 標準準拠 API 設計、ローダー/アクションパターン、プログレッシブエンハンスメント |        |
| 10 | [sveltejs/kit](https://github.com/sveltejs/kit)               | アダプターパターン、フォームアクション、ストリーミング設計                         |        |
| 11 | [withastro/astro](https://github.com/withastro/astro)         | アイランドアーキテクチャ、マルチフレームワーク統合、コンテンツコレクション設計     |        |
| 12 | [solidjs/solid-start](https://github.com/solidjs/solid-start) | ファイングレイン・リアクティビティの SSR、Vinxi 統合、RPC パターン                 |        |

## React Ecosystem

| #  | リポジトリ                                                    | 抽出できそうなプラクティス                                                 | Status |
| -- | ------------------------------------------------------------- | -------------------------------------------------------------------------- | ------ |
| 13 | [facebook/react](https://github.com/facebook/react)           | Fiber アーキテクチャ、協調スケジューリング、大規模コードベースの段階的移行 |        |
| 14 | [TanStack/query](https://github.com/TanStack/query)           | フレームワーク非依存コア設計、キャッシュ無効化戦略、楽観的更新パターン     | 済     |
| 15 | [TanStack/router](https://github.com/TanStack/router)         | 型安全ルーティング、サーチパラメータバリデーション、コード分割戦略         |        |
| 16 | [pmndrs/zustand](https://github.com/pmndrs/zustand)           | 最小 API 設計、ミドルウェアパターン、React 外からのストア操作              | 済     |
| 17 | [pmndrs/jotai](https://github.com/pmndrs/jotai)               | アトミック状態管理、ボトムアップ設計、Suspense 統合                        |        |
| 18 | [dai-shi/waku](https://github.com/dai-shi/waku)               | React Server Components の最小実装、ストリーミング SSR                     |        |
| 19 | [radix-ui/primitives](https://github.com/radix-ui/primitives) | アクセシブルコンポーネント設計、コンポジション API、headless パターン      |        |
| 20 | [shadcn-ui/ui](https://github.com/shadcn-ui/ui)               | コピー&ペースト配布モデル、CLI によるコンポーネント生成、カスタマイズ戦略  | 済     |

## Type System / Validation

| #  | リポジトリ                                                      | 抽出できそうなプラクティス                                       | Status |
| -- | --------------------------------------------------------------- | ---------------------------------------------------------------- | ------ |
| 21 | [colinhacks/zod](https://github.com/colinhacks/zod)             | ビルダーパターン、型推論チェーン、エラーメッセージ設計           | 済     |
| 22 | [sinclairzx81/typebox](https://github.com/sinclairzx81/typebox) | JSON Schema と TypeScript 型の双方向マッピング、コンパイラ設計   |        |
| 23 | [Effect-TS/effect](https://github.com/Effect-TS/effect)         | 関数型エフェクトシステム、依存性注入、構造的並行処理             | 済     |
| 24 | [trpc/trpc](https://github.com/trpc/trpc)                       | エンドツーエンド型安全、プロシージャビルダー、アダプターパターン | 済     |
| 25 | [arktypeio/arktype](https://github.com/arktypeio/arktype)       | テンプレートリテラル型パーサー、ランタイムバリデーション最適化   |        |
| 26 | [fakerjs/faker](https://github.com/fakerjs/faker)               | ロケール対応設計、モジュール式データ生成、シード管理             |        |

## ORM / Database

| #  | リポジトリ                                                              | 抽出できそうなプラクティス                                                   | Status |
| -- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------ |
| 27 | [drizzle-team/drizzle-orm](https://github.com/drizzle-team/drizzle-orm) | SQL ファースト ORM 設計、マイグレーション生成、マルチ DB ドライバ対応        | 済     |
| 28 | [prisma/prisma](https://github.com/prisma/prisma)                       | スキーマファースト設計、コード生成パイプライン、クエリエンジンアーキテクチャ |        |
| 29 | [kysely-org/kysely](https://github.com/kysely-org/kysely)               | 型安全クエリビルダー、プラグインシステム、方言抽象化                         |        |
| 30 | [tursodatabase/libsql](https://github.com/tursodatabase/libsql)         | SQLite フォーク戦略、レプリケーション設計、エッジ DB アーキテクチャ          |        |
| 31 | [supabase/supabase](https://github.com/supabase/supabase)               | マルチサービス統合、リアルタイム設計、SDK 自動生成                           |        |

## Build / Dev Tools

| #  | リポジトリ                                                | 抽出できそうなプラクティス                                                         | Status |
| -- | --------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------ |
| 32 | [vitejs/vite](https://github.com/vitejs/vite)             | プラグインアーキテクチャ、ESM ベース開発サーバー、Rollup 統合                      | 済     |
| 33 | [biomejs/biome](https://github.com/biomejs/biome)         | Rust で JS ツール構築、Linter/Formatter 統合設計、パフォーマンス重視アーキテクチャ |        |
| 34 | [oxc-project/oxc](https://github.com/oxc-project/oxc)     | Rust 製 JS パーサー、AST 設計、アリーナアロケーション                              |        |
| 35 | [evanw/esbuild](https://github.com/evanw/esbuild)         | Go で JS バンドラ構築、並列処理設計、ゼロ依存ポリシー                              |        |
| 36 | [rolldown/rolldown](https://github.com/rolldown/rolldown) | Rust 製 Rollup 互換、NAPI ブリッジ設計、プラグイン互換レイヤー                     |        |
| 37 | [vercel/turbo](https://github.com/vercel/turbo)           | タスクグラフベースビルド、リモートキャッシュ、Rust/Node ハイブリッド               |        |
| 38 | [unjs/unbuild](https://github.com/unjs/unbuild)           | ゼロコンフィグビルド、スタブモード、パッシブ設定推論                               | 済     |
| 39 | [privatenumber/tsx](https://github.com/privatenumber/tsx) | TypeScript 直接実行、esbuild 統合、Node.js ローダーフック                          |        |

## Testing

| #  | リポジトリ                                                                                        | 抽出できそうなプラクティス                                                | Status |
| -- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------ |
| 40 | [vitest-dev/vitest](https://github.com/vitest-dev/vitest)                                         | Vite ベーステストランナー、ワーカー並列化、スナップショット設計           | 済     |
| 41 | [microsoft/playwright](https://github.com/microsoft/playwright)                                   | ブラウザ自動化 API 設計、テスト分離、コード生成                           |        |
| 42 | [testing-library/react-testing-library](https://github.com/testing-library/react-testing-library) | ユーザー中心テスト哲学、アクセシビリティクエリ、テストユーティリティ設計  |        |
| 43 | [storybook-js/storybook](https://github.com/storybookjs/storybook)                                | アドオンシステム、CSF フォーマット設計、マルチフレームワーク対応          |        |
| 44 | [mswjs/msw](https://github.com/mswjs/msw)                                                         | Service Worker ベースモック、リクエストハンドラ設計、ネットワーク層抽象化 |        |

## CLI Tools

| #  | リポジトリ                                                        | 抽出できそうなプラクティス                                                 | Status |
| -- | ----------------------------------------------------------------- | -------------------------------------------------------------------------- | ------ |
| 45 | [oven-sh/bun](https://github.com/oven-sh/bun)                     | Zig ランタイム実装、JavaScriptCore 統合、オールインワン設計                |        |
| 46 | [denoland/deno](https://github.com/denoland/deno)                 | セキュリティサンドボックス、Web 標準 API 実装、Rust/V8 統合                |        |
| 47 | [sindresorhus/execa](https://github.com/sindresorhus/execa)       | プロセス管理 API 設計、ストリーム処理、エラーハンドリング                  |        |
| 48 | [google/zx](https://github.com/google/zx)                         | シェルスクリプト代替設計、テンプレートリテラル活用、組み込みユーティリティ |        |
| 49 | [tj/commander.js](https://github.com/tj/commander.js)             | CLI フレームワーク設計、サブコマンドパターン、ヘルプ自動生成               |        |
| 50 | [terkelg/prompts](https://github.com/terkelg/prompts)             | インタラクティブプロンプト設計、入力バリデーション、キーボードハンドリング |        |
| 51 | [changesets/changesets](https://github.com/changesets/changesets) | バージョニングワークフロー、チェンジセット管理、モノレポリリース           |        |

## UI Libraries

| #  | リポジトリ                                                              | 抽出できそうなプラクティス                                                | Status |
| -- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------ |
| 52 | [tailwindlabs/tailwindcss](https://github.com/tailwindlabs/tailwindcss) | ユーティリティファースト CSS 設計、プラグインシステム、JIT コンパイル     |        |
| 53 | [unocss/unocss](https://github.com/unocss/unocss)                       | アトミック CSS エンジン設計、プリセットシステム、オンデマンド生成         |        |
| 54 | [mantine-dev/mantine](https://github.com/mantinedev/mantine)            | コンポーネントライブラリ設計、テーマシステム、フック分離                  |        |
| 55 | [vuetifyjs/vuetify](https://github.com/vuetifyjs/vuetify)               | Material Design 実装、コンポーザブル設計、SASS テーマエンジン             |        |
| 56 | [chakra-ui/ark](https://github.com/chakra-ui/ark)                       | ステートマシンベースコンポーネント、マルチフレームワーク対応、Zag.js 統合 |        |

## AI / ML

| #  | リポジトリ                                                                                    | 抽出できそうなプラクティス                                           | Status |
| -- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------ |
| 57 | [vercel/ai](https://github.com/vercel/ai)                                                     | ストリーミング AI レスポンス設計、プロバイダ抽象化、React フック統合 | 済     |
| 58 | [langchain-ai/langchainjs](https://github.com/langchain-ai/langchainjs)                       | LLM チェーン設計、ドキュメントローダー抽象化、メモリ管理パターン     | 済     |
| 59 | [huggingface/transformers.js](https://github.com/huggingface/transformers.js)                 | ONNX ランタイム統合、モデルキャッシュ設計、Web ML パイプライン       |        |
| 60 | [mlc-ai/web-llm](https://github.com/mlc-ai/web-llm)                                           | WebGPU 推論設計、モデルコンパイル、ブラウザ内 LLM アーキテクチャ     |        |
| 61 | [anthropics/anthropic-sdk-typescript](https://github.com/anthropics/anthropic-sdk-typescript) | SDK 設計パターン、ストリーミング API、自動リトライ設計               |        |
| 62 | [openai/openai-node](https://github.com/openai/openai-node)                                   | API クライアント設計、Stainless コード生成、型安全イベントストリーム |        |

## Rust Projects

| #  | リポジトリ                                                  | 抽出できそうなプラクティス                                                     | Status |
| -- | ----------------------------------------------------------- | ------------------------------------------------------------------------------ | ------ |
| 63 | [denoland/rusty_v8](https://github.com/niclas-ANC/rusty_v8) | FFI バインディング設計、C++ ラッパー、メモリ安全性保証                         |        |
| 64 | [tokio-rs/tokio](https://github.com/tokio-rs/tokio)         | 非同期ランタイム設計、タスクスケジューリング、IO ドライバアーキテクチャ        |        |
| 65 | [tokio-rs/axum](https://github.com/tokio-rs/axum)           | Tower ミドルウェア統合、エクストラクターパターン、型安全ルーティング           |        |
| 66 | [serde-rs/serde](https://github.com/serde-rs/serde)         | シリアライズ/デシリアライズフレームワーク、derive マクロ設計、Visitor パターン |        |
| 67 | [BurntSushi/ripgrep](https://github.com/BurntSushi/ripgrep) | CLI ツール設計、正規表現エンジン、メモリマップ IO、並列ディレクトリ走査        |        |
| 68 | [sharkdp/fd](https://github.com/sharkdp/fd)                 | ユーザーフレンドリー CLI 設計、ignore ファイル処理、カラー出力                 |        |
| 69 | [astral-sh/ruff](https://github.com/astral-sh/ruff)         | Rust 製 Python Linter、AST ベースルール設計、パフォーマンス最適化              |        |
| 70 | [astral-sh/uv](https://github.com/astral-sh/uv)             | Rust 製 Python パッケージマネージャ、依存解決アルゴリズム、キャッシュ戦略      |        |
| 71 | [tauri-apps/tauri](https://github.com/tauri-apps/tauri)     | Rust/Web ハイブリッドアプリ、IPC 設計、セキュリティモデル                      |        |
| 72 | [nushell/nushell](https://github.com/nushell/nushell)       | 構造化データシェル、パイプライン設計、プラグインアーキテクチャ                 |        |

## Go Projects

| #  | リポジトリ                                                            | 抽出できそうなプラクティス                                                     | Status |
| -- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------ |
| 73 | [gofiber/fiber](https://github.com/gofiber/fiber)                     | Express ライク Go フレームワーク、ゼロアロケーション設計、ミドルウェアパターン |        |
| 74 | [labstack/echo](https://github.com/labstack/echo)                     | ルーターツリー設計、コンテキストプーリング、バインダーパターン                 |        |
| 75 | [gin-gonic/gin](https://github.com/gin-gonic/gin)                     | Radix tree ルーティング、ミドルウェアチェーン、パフォーマンスベンチマーク文化  |        |
| 76 | [charmbracelet/bubbletea](https://github.com/charmbracelet/bubbletea) | Elm アーキテクチャ in Go、TUI フレームワーク設計、コンポーネントモデル         |        |
| 77 | [containerd/containerd](https://github.com/containerd/containerd)     | コンテナランタイム設計、gRPC API、プラグインシステム                           |        |
| 78 | [hashicorp/terraform](https://github.com/hashicorp/terraform)         | プロバイダプラグイン設計、状態管理、HCL パーサー                               |        |
| 79 | [cli/cli](https://github.com/cli/cli)                                 | GitHub CLI 設計、コマンド構造、API クライアントパターン                        |        |
| 80 | [junegunn/fzf](https://github.com/junegunn/fzf)                       | ファジーマッチアルゴリズム、TUI 設計、UNIX パイプライン統合                    |        |

## Python Projects

| #  | リポジトリ                                                      | 抽出できそうなプラクティス                                    | Status |
| -- | --------------------------------------------------------------- | ------------------------------------------------------------- | ------ |
| 81 | [tiangolo/fastapi](https://github.com/tiangolo/fastapi)         | Pydantic 統合、OpenAPI 自動生成、依存性注入システム           |        |
| 82 | [pydantic/pydantic](https://github.com/pydantic/pydantic)       | データバリデーション設計、Rust コア統合、モデル設計パターン   |        |
| 83 | [encode/httpx](https://github.com/encode/httpx)                 | async/sync デュアル API、HTTP/2 対応、トランスポート抽象化    |        |
| 84 | [pallets/flask](https://github.com/pallets/flask)               | マイクロフレームワーク設計、Werkzeug 統合、拡張システム       |        |
| 85 | [psf/black](https://github.com/psf/black)                       | コードフォーマッター設計、AST ベース変換、ゼロコンフィグ哲学  |        |
| 86 | [python-poetry/poetry](https://github.com/python-poetry/poetry) | パッケージマネージャ設計、依存解決、lockfile 戦略             |        |
| 87 | [django/django](https://github.com/django/django)               | バッテリー同梱哲学、ORM 設計、マイグレーションフレームワーク  |        |
| 88 | [encode/starlette](https://github.com/encode/starlette)         | ASGI フレームワーク設計、ミドルウェアスタック、WebSocket 処理 |        |

## Infrastructure / DevOps

| #  | リポジトリ                                                        | 抽出できそうなプラクティス                                              | Status |
| -- | ----------------------------------------------------------------- | ----------------------------------------------------------------------- | ------ |
| 89 | [pulumi/pulumi](https://github.com/pulumi/pulumi)                 | IaC のマルチ言語 SDK 設計、プロバイダシステム、状態管理                 |        |
| 90 | [docker/compose](https://github.com/docker/compose)               | YAML 宣言的設定、サービスオーケストレーション、プラグインアーキテクチャ |        |
| 91 | [grafana/grafana](https://github.com/grafana/grafana)             | ダッシュボード設計、プラグインシステム、データソース抽象化              |        |
| 92 | [kubernetes/kubernetes](https://github.com/kubernetes/kubernetes) | コントローラパターン、Reconciliation ループ、CRD 設計                   |        |
| 93 | [traefik/traefik](https://github.com/traefik/traefik)             | 動的設定、プロバイダ抽象化、ミドルウェアチェーン                        |        |

## Monorepo / Package Management

| #  | リポジトリ                                    | 抽出できそうなプラクティス                                             | Status |
| -- | --------------------------------------------- | ---------------------------------------------------------------------- | ------ |
| 94 | [pnpm/pnpm](https://github.com/pnpm/pnpm)     | コンテンツアドレッサブルストレージ、ワークスペース管理、厳格な依存解決 |        |
| 95 | [NixOS/nix](https://github.com/NixOS/nix)     | 再現可能ビルド、関数型パッケージ管理、Flake 設計                       |        |
| 96 | [lerna/lerna](https://github.com/lerna/lerna) | モノレポバージョニング、変更検出、パブリッシュパイプライン             |        |

## その他

| #   | リポジトリ                                                        | 抽出できそうなプラクティス                                             | Status |
| --- | ----------------------------------------------------------------- | ---------------------------------------------------------------------- | ------ |
| 97  | [socketio/socket.io](https://github.com/socketio/socket.io)       | リアルタイム通信設計、名前空間/ルーム概念、トランスport フォールバック |        |
| 98  | [date-fns/date-fns](https://github.com/date-fns/date-fns)         | ツリーシェイク可能ライブラリ設計、純粋関数、ロケールシステム           |        |
| 99  | [lodash/lodash](https://github.com/lodash/lodash)                 | ユーティリティライブラリ設計、遅延評価チェーン、モジュール分割戦略     |        |
| 100 | [excalidraw/excalidraw](https://github.com/excalidraw/excalidraw) | Canvas ベース描画設計、コラボレーション、状態管理、オフライン対応      |        |

## 最近話題のプロジェクト（2025後半〜2026年初頭）

| #   | リポジトリ                                                            | 抽出できそうなプラクティス                                                                                   | Status |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------ |
| 101 | [openclaw/openclaw](https://github.com/openclaw/openclaw)             | マルチチャネル統合アーキテクチャ（13+ プラットフォーム）、ローカルファーストゲートウェイ、セッション分離設計 | 済     |
| 102 | [deepseek-ai/DeepSeek-R1](https://github.com/deepseek-ai/DeepSeek-R1) | MoE アーキテクチャ（671B 中 37B 活性化）、知識蒸留パイプライン、強化学習ベース学習戦略                       |        |
| 103 | [langgenius/dify](https://github.com/langgenius/dify)                 | エージェントワークフロー設計、マルチテナント Kubernetes アーキテクチャ、50+ ツールのプラグイン統合           |        |
| 104 | [open-webui/open-webui](https://github.com/open-webui/open-webui)     | Svelte + FastAPI スタック、ベクター DB 抽象化（9種対応）、エンタープライズ認証層（LDAP/OAuth）               |        |
| 105 | [zed-industries/zed](https://github.com/zed-industries/zed)           | カスタム GPU UI フレームワーク（GPUI）、大規模 Rust crates 構成、Tree-sitter 統合                            |        |
| 106 | [mendableai/firecrawl](https://github.com/mendableai/firecrawl)       | AI ファースト Web スクレイピング設計、自然言語ベース抽出（ゼロセレクター）、バッチ非同期パイプライン         |        |
| 107 | [All-Hands-AI/OpenHands](https://github.com/All-Hands-AI/OpenHands)   | モノリスから SDK へのリファクタリング、オプトインサンドボックス、ベンチマーク駆動開発（SWE-bench）           |        |
| 108 | [vllm-project/vllm](https://github.com/vllm-project/vllm)             | テンソル/パイプライン/データ並列化戦略、ハードウェア抽象化プラグイン、高スループット推論最適化               |        |
| 109 | [lapce/lapce](https://github.com/lapce/lapce)                         | Rope データ構造による大規模テキスト編集、OpenGL レンダリング、WASI プラグインシステム                        |        |
| 110 | [mastra-ai/mastra](https://github.com/mastra-ai/mastra)               | TypeScript AI エージェントフレームワーク、ワークフローグラフ設計、ツール統合抽象化                           | 済     |

## AI Automation

| #   | リポジトリ                                                              | 抽出できそうなプラクティス                                                                                  | Status |
| --- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------ |
| 111 | [n8n-io/n8n](https://github.com/n8n-io/n8n)                             | ノードベースワークフローアーキテクチャ、400+ 統合のプラグイン設計、型安全なワークフロー定義                 |        |
| 112 | [infiniflow/ragflow](https://github.com/infiniflow/ragflow)             | Deep Document Understanding、ハイブリッド検索（ベクトル+全文）、RAG パイプラインのモジュール化              |        |
| 113 | [FoundationAgents/MetaGPT](https://github.com/FoundationAgents/MetaGPT) | SOP（標準作業手順）のコード化、ロールベースマルチエージェント設計、中間結果検証機構                         |        |
| 114 | [pathwaycom/pathway](https://github.com/pathwaycom/pathway)             | リアルタイムストリーム処理アーキテクチャ、増分更新メカニズム、Python + Rust バックエンド連携                |        |
| 115 | [microsoft/autogen](https://github.com/microsoft/autogen)               | 会話型マルチエージェント設計、LLM ツール/関数呼び出しインターフェース、フレームワーク移行戦略               |        |
| 116 | [crewAIInc/crewAI](https://github.com/crewAIInc/crewAI)                 | 軽量エージェント協調設計、タスク委譲と結果統合パターン、YAML ベース宣言的定義                               |        |
| 117 | [Aider-AI/aider](https://github.com/Aider-AI/aider)                     | コードベースマッピングによるコンテキスト構築、Git ワークフロー統合、ベンチマーク駆動開発                    |        |
| 118 | [BerriAI/litellm](https://github.com/BerriAI/litellm)                   | 100+ LLM の統一インターフェース（プロバイダ抽象化）、コスト追跡/ガードレール、負荷分散/フォールバック       |        |
| 119 | [stanfordnlp/dspy](https://github.com/stanfordnlp/dspy)                 | シグネチャ・モジュール・オプティマイザの3層アーキテクチャ、プロンプト自動最適化、モジュラー AI パイプライン |        |
| 120 | [continuedev/continue](https://github.com/continuedev/continue)         | IDE 拡張アーキテクチャ（VS Code/JetBrains）、ローカル LLM 対応のプライバシー設計、カスタムモデル統合        |        |

## Cloudflare Ecosystem

| #   | リポジトリ                                                                                | 抽出できそうなプラクティス                                                               | Status |
| --- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------ |
| 121 | [cloudflare/agents](https://github.com/cloudflare/agents)                                 | DO 上の Actor パターン、SQLite 永続化、双方向ステート同期、MCP 二面設計、6階層 AGENTS.md | 済     |
| 122 | [cloudflare/workers-sdk](https://github.com/cloudflare/workers-sdk)                       | 大規模モノレポ CLI 設計、Miniflare シミュレータ、vitest-pool-workers、Vite 統合          |        |
| 123 | [cloudflare/partykit](https://github.com/cloudflare/partykit)                             | リアルタイム協調、WebSocket Hibernation、Yjs CRDT 統合、分散 pub/sub                     |        |
| 124 | [cloudflare/workers-oauth-provider](https://github.com/cloudflare/workers-oauth-provider) | OAuth 2.1 の Workers 実装、MCP 認可統合、KV トークンストレージ                           |        |
| 125 | [cloudflare/chanfana](https://github.com/cloudflare/chanfana)                             | OpenAPI 自動生成、Zod スキーマ変換、ルーター非依存の抽象化                               |        |

---

## 選定基準

1. **プラクティスの多様性** — 異なる設計パターン・アーキテクチャ・技法を網羅
2. **コード品質** — コミュニティで評価されているプロジェクト
3. **言語の多様性** — JS/TS を軸に Rust, Go, Python もカバー
4. **ドメインの多様性** — Web, CLI, インフラ, AI, UI など幅広い領域
5. **実用性** — 抽出したプラクティスが他プロジェクトに応用可能

## 優先度の考え方

- **高**: 複数の視点から分析でき、応用範囲が広いリポジトリ（例: Vite, Zod, Effect-TS）
- **中**: 特定の分野で優れたプラクティスを持つリポジトリ（例: MSW, Playwright）
- **低**: 補完的・比較分析向けのリポジトリ（例: Express vs Fastify の設計比較）
