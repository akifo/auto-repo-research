# colinhacks/zod — 導出ルール集

> 出典: repos/colinhacks/zod/ | 生成日: 2026-02-19
> 用途: CLAUDE.md にそのまま貼り付けて AI コンテキストとして活用

## API 設計

- `[MUST]` ライブラリ API は不変に設計し、メソッドチェーンの各メソッドが常に新しいインスタンスを返すようにする。内部最適化はミュータブルで行ってよいが、公開 API 契約は不変であること
  - 根拠: design-philosophy, builder-pattern-and-fluent-api — Zod の全メソッド（`.check()`, `.optional()`, `.pick()` 等）は `clone()` で新インスタンスを返し、元のスキーマは不変に保たれる
- `[MUST]` 失敗しうる操作には「例外を投げるバージョン」と「Result 型を返すバージョン」の両方を提供する。Result 型には判別フィールド（`success`）と相互排他的な `never` フィールドを設定する
  - 根拠: api-design-practices, error-handling-idioms — `parse`/`safeParse` デュアル API で `ZodSafeParseSuccess.error?: never` により TypeScript の narrowing を完全にする
- `[MUST]` パブリック API のパラメータが単一文字列で済む頻度が高い場合、`params?: string | ParamsObject` のユニオン型を採用し、内部で正規化する
  - 根拠: api-design-practices — `normalizeParams` で文字列/オブジェクト/undefined を統一処理し、80% のケースを1引数で完結させている
- `[SHOULD]` fluent メソッドの返り値型に `this` を使い、サブタイプでのチェーン時に型がダウンキャストされないようにする
  - 根拠: builder-pattern-and-fluent-api — `ZodEmail extends _ZodString` でも `.min(5)` の返り値が `ZodEmail` のまま保たれる
- `[SHOULD]` 非推奨 API は `@deprecated` JSDoc に移行先を明記し、型エイリアス + 実装委譲で動作を維持する。互換レイヤーは独立ファイルに分離する
  - 根拠: api-design-practices, versioning-strategy — `compat.ts` で旧型名を非推奨付きで維持し、IDE のストライクスルー表示で段階的移行を促進
- `[SHOULD]` 関連する API をサブ名前空間にグルーピングし（`z.coerce.*`, `z.iso.*`）、トップレベルの名前空間汚染を防ぐ
  - 根拠: api-design-practices — 頻用 API はトップレベルにも重複エクスポートして発見性を確保
- `[SHOULD]` 拡張 API は段階的抽象度で設計する（簡易 API → フルコントロール API → カスタム型定義）。80% のケースが最も簡易な API で解決できる構造にする
  - 根拠: extensibility-mechanisms — `refine`（1行）→ `superRefine`（ctx 付き）→ `check`（再利用可能）→ `$constructor`（新型定義）の4段階
- `[AVOID]` メソッドチェーン API で元のインスタンスを変更（mutate）する設計。参照共有時に予期しない副作用が発生する
  - 根拠: builder-pattern-and-fluent-api — 可変ビルダーでは `const base = ...; const a = base.min(5); const b = base.min(10)` で a にも min(10) が混入する

## 型システム

- `[MUST]` 型駆動 API では input 型と output 型を分離し、変換チェーンで独立に型が変化できるようにする
  - 根拠: type-system-patterns — `$ZodTypeInternals<O, I>` で input/output を分離し、`transform`/`pipe`/`default` が片方だけを変更可能
- `[MUST]` 型推論チェーンでは、各ステップが1段階だけ型を変換する設計にする
  - 根拠: type-system-patterns — `$ZodOptional` は `output<T> | undefined` を、`$ZodPipe` は `output<B>` と `input<A>` を1段階変換。深い合成でも型エラーメッセージが理解可能
- `[SHOULD]` 公開 API では厳密な型を提供し、内部実装では `any` を許容する境界を意識的に設計する
  - 根拠: type-system-patterns, design-philosophy — Zod は内部に `any` を多用しつつ、公開インターフェースでは条件型・ジェネリクスで完全な型安全を提供
- `[SHOULD]` 既知の値の列挙と任意の値を両方許容したい場合は `"known" | (string & {})` パターンを使う
  - 根拠: type-system-patterns — `JWTAlgorithm` 等で IDE 自動補完と拡張性を両立
- `[SHOULD]` 交差型をユーザーに表示する際は `Prettify<T>`（`{ [K in keyof T]: T[K] } & {}`）でフラット化する
  - 根拠: type-system-patterns — IDE ホバー時に `A & B & C` ではなく展開されたオブジェクト型を表示
- `[SHOULD]` ブランド型を導入する際は unique symbol をキーとし、入力/出力の方向を制御可能にする
  - 根拠: type-system-patterns — `$brand` は unique symbol でプロパティ衝突を回避し、`Dir` パラメータで方向を選択可能
- `[AVOID]` 型推論が依存するジェネリクスの制約を `@ts-ignore` で黙らせる運用を常態化する
  - 根拠: type-system-patterns — 安易な `@ts-ignore` は型の健全性を損なう。TypeScript の将来バージョンで改善される可能性がある

## エラーハンドリング

- `[MUST]` バリデーションエラーは構造化データ（コード + パス + メタデータ）として表現し、人間可読メッセージは消費時に生成する
  - 根拠: error-handling-idioms — issue にメッセージを遅延解決する設計で 40+ ロケールの i18n と4種の表示形式を実現
- `[MUST]` エラーのユニオン型には文字列リテラルの discriminator を持たせ、消費者が `switch` で型安全に分岐できるようにする
  - 根拠: error-handling-idioms — `$ZodIssue` は `code` フィールドの判別ユニオンで各サブタイプ固有のメタデータに型安全にアクセス可能
- `[SHOULD]` ネストしたバリデーションエラーはフラットリスト + パス配列で蓄積し、ツリー構造は消費時に遅延構築する
  - 根拠: error-handling-idioms — `flattenError`/`formatError`/`treeifyError`/`prettifyError` の4変換でユースケースに応じた表示を提供
- `[SHOULD]` エラーメッセージのカスタマイズは Chain of Responsibility で複数レイヤー（個別・コンテキスト・グローバル・ロケール）に委譲する
  - 根拠: error-handling-idioms, internationalization-patterns — `??` チェーンで各レイヤーが `undefined` を返すことで次に委譲する設計
- `[SHOULD]` 非致命的バリデーションエラーでは後続チェックを続行し、一回の検証で可能な限り多くのエラーを収集する
  - 根拠: error-handling-idioms — `continue` フラグにより、フォーマットエラー等ではチェーンが続行される
- `[AVOID]` バリデーション関数内でエラーメッセージを直接文字列として埋め込む。i18n やカスタマイズの余地がなくなる
  - 根拠: error-handling-idioms — issue 生成時に `message` を省略可能とし、エラーマップチェーンを通じて解決する設計

## パフォーマンス

- `[MUST]` ホットパスでリンタールールを緩和する場合は、理由をコメントまたは設定ファイルに明記する
  - 根拠: performance-techniques, dev-conventions — `biome.jsonc` で `noParameterAssign: "off"` に "required for performant coercion in _parse" とコメント
- `[SHOULD]` ホットパスのバリデーション結果は単一オブジェクトの in-place 変更で伝搬し、中間オブジェクトのアロケーションを避ける
  - 根拠: performance-techniques — `payload` パターンで `{ value, issues }` を各段階で使い回す
- `[SHOULD]` 初期化コストが高いメタデータは遅延評価にし、初回アクセスで値に置換する自己キャッシュパターンを使う
  - 根拠: performance-techniques, dependency-management — `defineLazy()` が 40+ 箇所、self-caching getter が 7 箇所で使用
- `[SHOULD]` 判別可能なユニオン型は判別キーによる定数時間ルックアップを実装し、全選択肢の試行を避ける
  - 根拠: performance-techniques — `$ZodDiscriminatedUnion` は `Map` で O(1) ルックアップを実現
- `[SHOULD]` パフォーマンス判断にはマイクロベンチマークを作成し、実装の選択根拠を残す
  - 根拠: performance-techniques — `packages/bench/` に 30+ のベンチマークファイル
- `[AVOID]` パフォーマンスのためにリントルールを off にする判断をライブラリ固有の文脈からアプリケーションに一般化する
  - 根拠: design-philosophy — `noExplicitAny: "off"` は型推論インフラのための例外であり、アプリケーションコードでは型安全性を優先すべき

## Tree-shaking とバンドルサイズ

- `[MUST]` ライブラリの `package.json` に `"sideEffects": false` を設定し、サブパスがある場合はサブディレクトリにも伝播する
  - 根拠: tree-shaking-optimization, project-structure — `write-stub-package-jsons.ts` で全サブディレクトリへ自動伝播
- `[MUST]` 副作用のない関数呼び出し式には `/*@__PURE__*/` を、副作用のない関数宣言には `// @__NO_SIDE_EFFECTS__` を付与する
  - 根拠: tree-shaking-optimization — core だけで 126+、mini で 168+ のアノテーションを体系的に適用
- `[SHOULD]` バンドルサイズが重要なライブラリでは、ES6 クラス継承（`extends`）を避け、関数ベースのコンストラクタパターンを使う
  - 根拠: tree-shaking-optimization, architecture — `$constructor` パターンはクラス継承の副作用判定問題を回避し、使われないコンストラクタの完全除去を可能にする
- `[SHOULD]` メソッドチェーン API とスタンドアロン関数 API の両方を提供し、共通 core 層で実装を共有する
  - 根拠: tree-shaking-optimization — classic（DX 重視）と mini（サイズ重視）で同一 core を共有しつつ、API レイヤーだけを分離
- `[SHOULD]` tree-shaking の回帰を防ぐため、典型ユースケースを Rollup/esbuild でバンドルしサイズを計測するテスト環境を用意する
  - 根拠: tree-shaking-optimization — `packages/treeshake/` で各バリアントのバンドルサイズを継続的に監視
- `[AVOID]` モジュールトップレベルでグローバル状態を変更する副作用コード（ロケール設定、ポリフィル注入等）をデフォルトエントリポイントに含める
  - 根拠: tree-shaking-optimization — classic の `config(en())` はモジュール import 時に自動実行され、bundler がそのモジュール全体を除去できなくなる

## パッケージ配信と品質保証

- `[MUST]` npm パッケージのサブパスエクスポートを定義する場合、ESM (`import`), CJS (`require`), 型定義 (`types`) の 3 条件を全サブパスで一貫して提供する
  - 根拠: project-structure, build-and-tooling — 全 10 サブパスで 3 フォーマットを揃え、attw テストで全解決戦略を検証
- `[MUST]` CJS/ESM デュアルパッケージでは、複数の moduleResolution 設定（bundler, nodenext, node16）でビルド後の型解決をテストする
  - 根拠: build-and-tooling — `skipLibCheck: false` で型解決の正しさを保証
- `[MUST]` バージョン番号が複数箇所に存在する場合、整合性を検証する自動チェックスクリプトを git hook と CI の両方で実行する
  - 根拠: versioning-strategy, dev-conventions — `check-versions.ts` が 3 箇所を検証し、pre-commit/pre-push/prepublishOnly で実行
- `[SHOULD]` monorepo のパッケージ間参照ではカスタム条件（conditional exports）を使い、開発時はソースを直接参照してビルドステップを省略する
  - 根拠: build-and-tooling, project-structure — `@zod/source` 条件が vitest/tsx/tsconfig/IDE の全てで一貫使用
- `[SHOULD]` パッケージの型解決を `@arethetypeswrong/cli` 等のツールで CI に組み込み、回帰テストとして snapshot で固定する
  - 根拠: build-and-tooling — inline snapshot で全サブパスの型解決結果を固定し退行を検出
- `[SHOULD]` メジャーバージョン移行時、旧 API をサブパスエクスポート（`pkg/v{N}`）で同一パッケージ内に維持し、段階的移行パスを提供する
  - 根拠: versioning-strategy — `zod/v3` サブパスで完全な v3 実装を維持
- `[SHOULD]` CJS/ESM の Dual Package Hazard が発生するシングルトンは `globalThis` に格納して `??=` で初期化する
  - 根拠: architecture, design-philosophy — `globalRegistry` が `globalThis.__zod_globalRegistry` に格納され、混在環境でも単一インスタンスを保証
- `[AVOID]` 公開パッケージの同一機能に対して、意味的に重複するサブパスエイリアスを作成する（移行期の一時的なエイリアスは除く）
  - 根拠: project-structure — `zod/mini`, `zod/v4-mini`, `zod/v4/mini` が同一モジュールを指し混乱を招く

## 循環依存管理

- `[MUST]` 循環依存が不可避なモジュール間では、遅延初期化（`Object.defineProperty` getter + センチネル値による循環検出）でプロパティアクセスを初期化時点から切り離す
  - 根拠: dependency-management, architecture — `defineLazy` は `EVALUATING` センチネルで循環検出を行い、40 箇所以上で使用
- `[MUST]` CI に静的循環依存チェックツール（madge 等）を組み込み、既知の例外は `--exclude` で最小限に管理する
  - 根拠: dependency-management — PR ごとに `check-circular` ジョブが実行され、除外は 3 パターンに限定
- `[SHOULD]` 型のみが必要な import は `import type` を使い、ランタイム依存グラフから除外する
  - 根拠: dependency-management — `v4/core/util.ts` は 4 import すべて `import type` でランタイム依存ゼロのリーフモジュール
- `[SHOULD]` 内部モジュールは barrel export（index.ts）を経由せず、必要なモジュールを直接 import する
  - 根拠: dependency-management — `from-json-schema.ts` で明示的に barrel 回避し、ローカル `z` オブジェクトを組み立て
- `[AVOID]` 循環依存チェックの除外範囲を安易に拡大する。新規モジュールの追加時に循環が検出されなくなる
  - 根拠: dependency-management — 除外を `v4/core`（設計上不可避）、`v3`（レガシー）、`iso.ts`（特殊）の 3 つのみに限定

## テスト

- `[MUST]` 型推論がユーザー API に含まれるライブラリでは、ランタイムテストと型テストを同一ファイルで実行する
  - 根拠: testing-practices — 全テストで `expect` と `expectTypeOf` が共存し、型とランタイムの乖離を構造的に防止
- `[MUST]` テストにおいて成功ケースと失敗ケースを必ず対で記述する
  - 根拠: testing-practices — AGENTS.md に "Test both success and failure cases with edge cases" と明記
- `[SHOULD]` エラーオブジェクトやシリアライズ結果の検証にはインラインスナップショットを使い、外部 `.snap` ファイルを避ける
  - 根拠: testing-practices — レビュー時の視認性と意図しない更新の防止を優先
- `[SHOULD]` テストコードからの console 出力を setupFiles で自動禁止する
  - 根拠: testing-practices, dev-conventions — `fail-on-console.ts` が全テストに適用され、残留デバッグログを構造的に排除
- `[SHOULD]` TypeScript ライブラリでは最低サポートバージョンと最新版の両方で CI テストを実行する
  - 根拠: testing-practices — CI マトリクスで `typescript: ["5.5", "latest"]` を指定
- `[AVOID]` 型エラーを `@ts-ignore` やテストスキップで回避する。型を修正するか `@ts-expect-error` で意図を文書化する
  - 根拠: testing-practices — AGENTS.md に "Don't skip tests due to type issues - fix the types instead" と明記

## 開発規約

- `[MUST]` リンターの recommended ルールを off にする場合、設定ファイルにインラインコメントで理由を付与する
  - 根拠: dev-conventions — `biome.jsonc` の各 off ルールにコメントで根拠を明記し、設定ファイルがアーキテクチャ判断のドキュメントとして機能
- `[SHOULD]` 未使用コードの lint 検出と自動修正を分離する（検出は error、自動修正は none）
  - 根拠: dev-conventions — lint-staged でのコミット時に意図しないコード削除が起きない設計
- `[SHOULD]` pre-commit は高速チェック（フォーマット、リント、バージョン整合性）に絞り、テスト実行は pre-push に分離する
  - 根拠: dev-conventions — 開発速度と品質保証を両立する2段構えのフック
- `[AVOID]` リンター抑制コメント（`biome-ignore`, `eslint-disable` 等）を理由なし、またはダミーテキストで記述する
  - 根拠: dev-conventions — 将来のメンテナビリティを損なう

## i18n

- `[MUST]` i18n 対応のエラーメッセージシステムでは、メッセージ解決に優先度チェーンを設け、各層が「処理しない」を返せるようにする
  - 根拠: internationalization-patterns — 4 層チェーンで部分的カスタマイズとデフォルトロケールを共存
- `[MUST]` ロケールファイルはファクトリ関数として遅延評価可能にし、インポート時に副作用を発生させない
  - 根拠: internationalization-patterns — `export default function()` 形式で tree-shaking と動的ロケール切り替えを両立
- `[SHOULD]` ロケールファイルは個別サブパスエクスポートを提供し、バレルファイルに依存しないインポートパスを用意する
  - 根拠: internationalization-patterns — ワイルドカードサブパスで単一ロケールの直接インポートが可能
- `[SHOULD]` i18n の共通インターフェースは関数シグネチャで定義し、内部辞書構造はロケールごとに自由に設計できるようにする
  - 根拠: internationalization-patterns — 英語は `{ unit }` 、ロシア語は `{ one, few, many }`、ヘブライ語は `{ label, gender }` と言語に応じて異なる

## AI ツール統合

- `[MUST]` CLAUDE.md / AGENTS.md には「開発コマンド一覧」と「行動ルール」の 2 セクションを最低限含める
  - 根拠: ai-settings — 38 行で 2 セクション構成。AI エージェントが迷わず作業を開始できる
- `[MUST]` 複数の AI ツールが異なるファイル名を参照する場合、内容を複製せずシンボリックリンクで統一する
  - 根拠: ai-settings — `CLAUDE.md -> AGENTS.md` で Claude Code と Codex が同一ソースを参照
- `[SHOULD]` AGENTS.md にプロジェクト固有のユーティリティや通常のリンター推奨に反するルールを明示し、AI が不適切な変更を行うことを防ぐ
  - 根拠: ai-settings — `defineLazy()` 使用指示やパラメータ再代入許可を明示
- `[SHOULD]` ライブラリの package.json に `llms`/`llmsFull`/`mcpServer` フィールドを追加し、AI 向けドキュメントエンドポイントを機械発見可能にする
  - 根拠: ai-settings — npm レジストリ経由で AI ツールがドキュメントを自動発見できるメタデータ
- `[AVOID]` AGENTS.md に抽象的・曖昧な指示を書く。AI は具体的で検証可能な指示に最もよく従う
  - 根拠: ai-settings — すべての指示が具体的（`"No log statements"`, `"Use gh CLI"` 等）

## ルール優先度の解釈

- `[MUST]`: 違反するとバグ・セキュリティリスク・重大な設計劣化を招くルール
- `[SHOULD]`: 従うことで品質が向上するが、文脈によっては例外を許容するルール
- `[AVOID]`: 意図的に避けるべきアンチパターン・非推奨プラクティス
