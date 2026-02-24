# modelcontextprotocol/typescript-sdk

> URL: https://github.com/modelcontextprotocol/typescript-sdk
> Stars: 11.7k | 言語: TypeScript | ライセンス: Apache-2.0 | 分析日: 2026-02-24

## サマリー

MCP TypeScript SDK は、Web Standard API を核に据えた3層アーキテクチャ（Transport→Protocol→High-Level API）と Zod スキーマを Single Source of Truth とする型設計により、マルチランタイム対応・双方向プロトコル・型安全性を同時に実現している。特に「export conditions + 最小 shim による静的ランタイム分岐」「Capability Negotiation による安全な機能拡張」「fetch シグネチャをミドルウェアの合成単位にする設計」は、プロトコル SDK に限らず広く応用できるプラクティスである。プロダクションレベルのストリーミング処理（バックプレッシャー対応・再開可能ストリーム・段階的シャットダウン）やセキュリティの構造的強制（SafeUrlSchema・PKCE S256 必須化・DNS リバインディング保護の自動適用）も、実務に直結する知見が豊富に含まれている。

## 技術スタック

- **言語**: TypeScript (ES modules, strict mode)
- **フレームワーク**: なし（プロトコル SDK）
- **ビルド**: tsdown, pnpm workspace
- **テスト**: Vitest (workspace 構成、conformance テスト含む)
- **パッケージマネージャ**: pnpm 10.x (monorepo)
- **スキーマ**: Zod v4
- **バリデーション**: Ajv / @cfworker/json-schema (pluggable)
- **ドキュメント**: TypeDoc
- **リリース**: Changesets

## 分析した視点

| # | 視点 | ファイル | 概要 |
| - | ---- | -------- | ---- |
| 1 | project-structure | project-structure.md | 内部パッケージのバンドル吸収、pnpm catalogs による依存一元管理、アダプタ層の peerDependencies 疎結合設計 |
| 2 | architecture | architecture.md | Transport→Protocol→High-Level API の3層アーキテクチャと Capability Gate による安全な機能制御 |
| 3 | design-philosophy | design-philosophy.md | Web Standard API を核に据え、Platform Shim と Thin Adapter で多ランタイム対応を実現する設計思想 |
| 4 | type-system-patterns | type-system-patterns.md | Zod スキーマを Single Source of Truth とし、約120型を z.infer で導出する Schema-First 型設計 |
| 5 | abstraction-patterns | abstraction-patterns.md | 最小 Transport インターフェース、Protocol Template Method、McpServer Facade の4層抽象化設計 |
| 6 | streaming-patterns | streaming-patterns.md | バックプレッシャー対応、再開可能ストリーム、段階的シャットダウン等のプロダクション級ストリーミング実装 |
| 7 | api-design-practices | api-design-practices.md | Progressive Disclosure の3層 API、Registration-Driven Capabilities、入出力自動バリデーション |
| 8 | middleware-composition | middleware-composition.md | fetch シグネチャを合成単位とするミドルウェアパイプラインとフレームワーク非依存のバリデーション共有 |
| 9 | adapter-implementation-patterns | adapter-implementation-patterns.md | Web Standard コア + 薄いアダプター層の分離、セキュリティデフォルト自動適用、WeakMap コンテキスト伝搬 |
| 10 | platform-abstraction | platform-abstraction.md | export conditions + 最小 shim による静的ランタイム分岐と Web Standard API ファーストのコア設計 |
| 11 | error-handling-idioms | error-handling-idioms.md | ProtocolError/SdkError のワイヤー境界分離、安全なフォールバック変換、段階的な資格情報無効化 |
| 12 | testing-practices | testing-practices.md | InMemoryTransport による高速テスト、Issue 番号付き回帰テスト、3層テスト分離と共有設定パッケージ化 |
| 13 | security-practices | security-practices.md | SafeUrlSchema による構造的 URL 検証、PKCE S256 必須化、エラーコード別の段階的資格情報回復 |
| 14 | schema-validation-patterns | schema-validation-patterns.md | Zod→型→JSON Schema の一方向導出チェーン、strict/loose の段階的厳密度、プラガブルバリデーター戦略 |
| 15 | dev-conventions | dev-conventions.md | 共有 ESLint/TSConfig パッケージ、JSDoc コード例の型チェック同期、changesets + PR プレビュー公開 |

## 特に注目すべき知見

- **Schema-First Type Derivation + Flatten ユーティリティ**: Zod スキーマを唯一の型情報源とし、約120型を `Infer<typeof XxxSchema>` で一括導出する。`Flatten` 型で `z.infer` の出力を再帰的に展開し IDE の可読性を向上させる技法は、Zod を使うあらゆるプロジェクトに即座に適用できる。型ガード関数も `schema.safeParse` で実装し、スキーマとの乖離を構造的に防止している。

- **export conditions + 最小 shim によるマルチランタイム対応**: package.json の `exports` 条件（`workerd`/`browser`/`node`/`default`）と 2-23 行の shim ファイルで、JSON Schema バリデーターを Node.js（Ajv）と Edge Runtime（@cfworker/json-schema）で自動切替する。ランタイム検出の `if` 文を排除し、tree-shaking との両立を実現。shim は re-export のみに徹し、ロジックを含まない原則が鍵。

- **fetch シグネチャをミドルウェアの合成単位にする設計**: `Middleware = (next: FetchLike) => FetchLike` という1行の型定義で、認証・ログ等の横断的関心事を Web Standard 互換の関数合成として表現する。`applyMiddlewares()` は空パイプラインでアイデンティティを保証し、`createMiddleware` ヘルパーで高階関数のネストを軽減する。独自コンテキスト型を避け、テスト用 mock との互換性を維持している。

- **Capability Negotiation + Registration-Driven Capabilities**: 初期化時にクライアント/サーバーが能力を交換し、未対応機能の呼び出しを即座にエラーにする。さらに McpServer は `registerTool()` 等のハンドラ登録時に能力を自動宣言し、宣言と実装の乖離を構造的に防止。遅延初期化により、未使用の能力は公開されない。

- **ProtocolError / SdkError のワイヤー境界分離**: ネットワークを越えるエラー（数値コード、JSON-RPC 準拠）とローカル専用エラー（文字列コード、開発者体験重視）を型レベルで分離。ハンドラの任意の例外を `Number.isSafeInteger` チェックで安全にワイヤーフォーマットに変換し、キャンセル済みリクエストへのレスポンスを抑制する設計は、RPC システム全般に応用できる。

## クイックリファレンス

- [導出ルール集](rules.md) -- CLAUDE.md に貼れる形式の全ルール
