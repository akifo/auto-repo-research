# honojs/hono

> URL: https://github.com/honojs/hono
> Stars: 28.8k | 言語: TypeScript | ライセンス: MIT | 分析日: 2026-02-14

## サマリー

Hono は Fetch API の Request/Response を唯一の入出力境界とし、ゼロ外部依存・マルチランタイム対応を同時に達成した Web フレームワークである。5種ルーターの Strategy パターンと SmartRouter による自動選択、73行の compose 関数による onion 型ミドルウェア合成、Phantom Type と Schema 累積によるコード生成なしの End-to-End 型安全性など、フレームワーク設計における「制約を自由に変える」原則を体系的に学べる。アダプター層の厚みをランタイムの API 乖離度に比例させる実用的な設計判断、エクスポートマップの自動バリデーションによるパッケージ品質保証、Web Crypto API による暗号処理の自前実装戦略も、他プロジェクトに応用可能な知見として価値が高い。

## 技術スタック

- **言語**: TypeScript (strict mode)
- **フレームワーク**: 独自フレームワーク (Web Standards ベース)
- **ビルド**: esbuild (トランスパイル) + tsc (型定義生成) + publint (パッケージ検証)
- **テスト**: Vitest (マルチプロジェクト構成) + Deno.test + bun:test
- **パッケージマネージャ**: Bun (タスクランナー兼用)
- **リント/フォーマット**: ESLint (@hono/eslint-config) + Prettier
- **CI**: GitHub Actions (Node.js 18/20/22, Bun, Deno, workerd, Fastly, Lambda)
- **レジストリ**: npm + JSR (デュアルパブリッシュ)

## 分析した視点

| # | 視点 | ファイル | 概要 |
|---|------|---------|------|
| 1 | project-structure | [project-structure.md](project-structure.md) | 70以上のサブパスエクスポートでtree-shakingを実現し、ランタイム固有コードをアダプター層に完全隔離する構造設計 |
| 2 | architecture | [architecture.md](architecture.md) | 5層レイヤー構成で依存方向を内側→外側に統一し、薄いコア層と交換可能なルーターで9ランタイムに対応 |
| 3 | design-philosophy | [design-philosophy.md](design-philosophy.md) | Fetch API を唯一の境界とし、ゼロ外部依存とプリセットによるトレードオフ選択でマルチランタイムを実現 |
| 4 | router-design | [router-design.md](router-design.md) | 最小インターフェース Router\<T\> で5種ルーターを統一し、SmartRouter がメソッド自己置換で最適ルーターに委譲 |
| 5 | middleware-system | [middleware-system.md](middleware-system.md) | 73行のcompose関数でonion型合成を実現し、単一ハンドラ最適化でホットパスのオーバーヘッドを排除 |
| 6 | context-design | [context-design.md](context-design.md) | 遅延初期化とEnv型+ContextVariableMapの二重レイヤーでランタイムコストゼロの型安全な変数ストアを実現 |
| 7 | type-system | [type-system.md](type-system.md) | Phantom TypeとSchema累積合成でルート定義からRPCクライアントまでEnd-to-End型安全性をコード生成なしで実現 |
| 8 | adapter-pattern | [adapter-pattern.md](adapter-pattern.md) | アダプターの厚みをランタイムのAPI乖離度に比例させ、3行から680行まで変換責務のみに徹する設計 |
| 9 | web-standards | [web-standards.md](web-standards.md) | 標準APIをラップしつつescape hatchで直接アクセスを保証し、Responseをデータ変換器として活用する実践手法 |
| 10 | client-rpc | [client-rpc.md](client-rpc.md) | Proxyでパスを蓄積しPathToChainで型変換する約220行のランタイムで、コード生成なしの型安全RPCを実現 |
| 11 | jsx-engine | [jsx-engine.md](jsx-engine.md) | SSR用文字列レンダラーとDOM用クライアントレンダラーをSymbolベースのディスパッチで切り替える独自JSXエンジン |
| 12 | validator-system | [validator-system.md](validator-system.md) | コールバック関数の型シグネチャを統合契約としin/out分離で任意のバリデーションライブラリを20行で統合可能にする設計 |
| 13 | error-handling | [error-handling.md](error-handling.md) | Response同梱throwパターンとダックタイピング判定でエラーの意味と表現を一体運搬する二層構造のエラー設計 |
| 14 | testing-strategy | [testing-strategy.md](testing-strategy.md) | app.request()によるサーバーレステストと共通テストスイートのskipリスト管理で7+ランタイムを効率的に検証 |
| 15 | performance | [performance.md](performance.md) | 全ルートを単一正規表現にコンパイルしO(1)マッチングを実現、静的ルートのハッシュマップ参照で更に高速化 |
| 16 | build-system | [build-system.md](build-system.md) | esbuild/tsc/publintの責務分離と並列実行で70+エクスポートのESM/CJSデュアル出力とJSR対応を自動保証 |
| 17 | streaming | [streaming.md](streaming.md) | TransformStreamを仲介したPush型抽象化でSSE/ストリーミングをWeb Standards APIのみで統一的に実装 |
| 18 | preset-system | [preset-system.md](preset-system.md) | HonoBase基盤にルーターだけ差し替えた3プリセットをexports分離で提供し、バンドルサイズの段階的選択を実現 |
| 19 | helper-utilities | [helper-utilities.md](helper-utilities.md) | Context-first引数規約とHelper/Utils二層分離で14ヘルパーをサブパスエクスポートとして独立公開する設計 |
| 20 | dependency-management | [dependency-management.md](dependency-management.md) | Web Crypto APIによるJWT等の自前実装でproduction dependencies完全ゼロを達成し、publintで品質を自動保証 |

## 特に注目すべき知見

- **Self-Modifying Method パターン**: SmartRouter と RegExpRouter が初回 `match()` 呼び出し後に `this.match` を最適化された関数で差し替え、2回目以降のルーティングオーバーヘッドをゼロにする。通常の lazy initialization（フラグチェック）よりもランタイムコストが低く、ホットパス最適化の汎用パターンとして他プロジェクトに応用可能。

- **Phantom Type + Schema 累積による End-to-End 型安全性**: `TypedResponse<T, U, F>` でレスポンスの型情報をランタイムに影響を与えずに伝搬し、メソッドチェーンの `S & ToSchema<...>` でルート定義を累積的に型パラメータに蓄積する。コード生成やIDLなしで、サーバーのルート定義から RPC クライアントの型を自動導出する仕組みは、TypeScript の型レベルプログラミングの実践的な到達点。

- **アダプター厚みの比例原則**: Vercel アダプター 3行、AWS Lambda アダプター 680行というように、アダプターの複雑さをランタイムの Web Standards API からの乖離度に正確に比例させる。全アダプター共通の抽象基底クラスを作らず、各ランタイムの慣習に合わせることで過剰な抽象化を回避する判断は、マルチプラットフォーム対応の設計原則として価値が高い。

- **コールバックベースのバリデーター統合**: `validator(target, fn)` というコールバックパターンで、フレームワーク本体が特定のバリデーションライブラリに依存せず、Zod/Valibot/TypeBox 等を約20行のラッパーで統合可能にする。`in`（入力型）/ `out`（出力型）の分離により transform 前後の型差異も正確に伝搬する設計は、プラグインアーキテクチャの模範例。

- **Parameterized Test Suite + Declarative Skip**: 5種のルーター実装が共通テストスイート `common.case.test.ts` を共有し、各ルーターの非対応ケースを理由付き skip リストで宣言する。テストコードが「何をテストしないか」を明示的に文書化することで、Strategy パターンの各実装間の能力差を可視化するアプローチ。

## クイックリファレンス

- [導出ルール集](rules.md) -- CLAUDE.md に貼れる形式の全ルール
