# honojs/hono

> URL: https://github.com/honojs/hono
> Stars: 28.8k | 言語: TypeScript | ライセンス: MIT | 分析日: 2026-02-14

## サマリー

Hono は「Web Standards（Request/Response）を唯一の境界契約とし、コアにランタイム固有コードを一切含めない」という設計原則を徹底することで、ゼロ依存・マルチランタイム（9+）・超軽量（tiny プリセット < 12kB）を同時に達成したフレームワークである。このコードベースから学べる核心は、(1) 最小インターフェース（2メソッド）による差し替え可能性と自己書き換えメソッドによるオーバーヘッド排除の両立、(2) TypeScript の型システムを「もうひとつのプログラミング言語」として活用し文字列リテラルからパラメータ型を推論しミドルウェアチェーンで環境型を累積合成する End-to-End 型安全の実現手法、(3) ファクトリ関数パターン・クロージャ封入・名前付き関数式・論理演算合成による統一シグネチャのミドルウェア合成アーキテクチャである。

## 技術スタック

- **言語**: TypeScript (ES2022 target, Bundler moduleResolution)
- **フレームワーク**: 独自 Web フレームワーク（Web Standards ベース）
- **ビルド**: esbuild（ESM/CJS デュアル出力）+ tsc（型定義生成）+ oxc-parser（.d.ts 後処理）
- **テスト**: Vitest（メイン）+ Deno.test / Bun.test（ランタイム固有）
- **パッケージマネージャ**: Bun (bun install)
- **レジストリ**: npm + JSR（双方向エクスポート検証）
- **リンター**: ESLint (@hono/eslint-config、型チェック系ルール OFF)
- **フォーマッター**: Prettier
- **CI**: GitHub Actions（7 ランタイム並列テスト + パフォーマンス計測）

## 分析した視点

| # | 視点 | ファイル | 概要 |
|---|------|---------|------|
| 1 | プロジェクト構成 | project-structure.md | exports とディレクトリ構造の 1:1 対応、Facade 隠蔽、プリセットパターン |
| 2 | アーキテクチャ | architecture.md | Web Standards コア、Router Strategy、関数注入 Template Method、compose CoR |
| 3 | 設計哲学 | design-philosophy.md | 最大公約数としての Web Standards、ゼロ依存、ホットパス最適化、サイズ制御 |
| 4 | 型システムパターン | type-system-patterns.md | Template Literal Types パス推論、any フィルター型合成、ファントム型、Declaration Merging |
| 5 | 合成パターン | composition-patterns.md | onion-ring ミドルウェア、next() ガード、クロージャ事前計算、論理演算合成 |
| 6 | 抽象化パターン | abstraction-patterns.md | 2 メソッド最小インターフェース、コールバック注入、能力宣言エラー型 |
| 7 | プラットフォーム抽象 | platform-abstraction.md | 9 ランタイム対応、handle(app) 統一、EventProcessor、getContent 注入 |
| 8 | エラーハンドリング | error-handling-idioms.md | HTTPException フラット例外、Response 同梱、cause チェーン、設定時/リクエスト時分離 |
| 9 | テスト | testing-practices.md | app.request() サーバーレス、testClient、コア+差分二層構造、型テスト |
| 10 | パフォーマンス | performance-techniques.md | メソッド自己書き換え、O(1) 静的ルート、charCodeAt パース、compose バイパス |
| 11 | API 設計 | api-design-practices.md | Fluent API、ファストパス最適化、遅延初期化、Proxy RPC クライアント |
| 12 | ビルド・ツーリング | build-and-tooling.md | ESM/CJS 並行ビルド、エクスポート相互検証、publint、パフォーマンス計測 |
| 13 | 拡張メカニズム | extensibility-mechanisms.md | 抽象基底+プリセット、ファクトリ統一シグネチャ、declare module 拡張 |
| 14 | 依存管理 | dependency-management.md | ゼロ依存、Web Crypto API、手動パース、TextEncoder シングルトン |
| 15 | セキュリティ | security-practices.md | タイミングセーフ比較、安全デフォルト、JWT アルゴリズム検証、型レベル Cookie 制約 |
| 16 | ストリーミング | streaming-patterns.md | TransformStream ペア、StreamingApi Facade、onAbort Observer、SSE/Suspense |
| 17 | 開発規約 | dev-conventions.md | ESLint/tsc 責務分離、autofix CI、.tool-versions、パフォーマンス退行検出 |
| 18 | メタプログラミング | metaprogramming-techniques.md | 型レベルパス合成、Proxy RPC、カスタム JSX、Symbol プロトコル、AST 後処理 |

## 特に注目すべき知見

- **メソッド自己書き換えによるゼロコスト Strategy**: SmartRouter は初回 `match()` で最適なルーターを選択した後、`this.match = router.match.bind(router)` で自身のメソッドを直接差し替える。2 回目以降は中間層の分岐コストが完全にゼロになる。一度だけ実行すればよい判定処理を持つあらゆるシステムに応用できるパターンである。

- **any フィルター付き型合成 (IntersectNonAnyTypes)**: ミドルウェアチェーンの型を intersection で累積合成する際、型パラメータ未指定のジェネリック関数が `any` を持ち込んでもチェーン全体の型が崩壊しない仕組み。`ProcessHead<T>` が `any` を `{}` に変換してからインターセクションを取ることで、型安全性を構造的に保証する。型合成パイプラインを持つあらゆるライブラリに転用可能な防御パターンである。

- **ファクトリ関数 + 名前付き関数式 + クロージャ事前計算の三位一体**: 全 25 個のミドルウェアが `(options?) => async function middlewareName(c, next) { ... }` という統一パターンに従う。設定値の解析・正規表現コンパイル・関数構築をファクトリ呼び出し時に 1 回だけ実行し、返却する関数に名前を付けてスタックトレースの可読性を確保する。ミドルウェア/プラグインシステムを設計する際の即座に採用できるベストプラクティスである。

- **Web Standards API のみによるゼロ依存セキュリティ実装**: `crypto.subtle` で JWT 署名/検証・Cookie 署名・ETag ハッシュを実装し、`timingSafeEqual` でハッシュ後の定数時間比較を行い、`CompressionStream` でレスポンス圧縮を行う。Node.js 固有の `crypto` モジュールを一切使わないことで 9 ランタイムへの可搬性を実現しつつ、RFC 準拠のセキュリティ品質を維持している。

- **TransformStream ペア + try/finally + WeakMap によるストリーミング安全設計**: `new TransformStream()` で writable/readable ペアを生成し、書き込みと読み取りを分離する。コールバック実行を `try/finally` で囲んで必ず `close()` を呼び、`WeakMap<ReadableStream, Context>` でストリーム生存期間だけコンテキストを保持する。ストリーミング API を設計する際のリソースリーク防止パターンとして汎用的に適用できる。

## クイックリファレンス

- [導出ルール集](rules.md) -- CLAUDE.md に貼れる形式の全ルール
