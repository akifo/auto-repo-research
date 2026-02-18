# unjs/unbuild — 導出ルール集

> 出典: repos/unjs/unbuild/ | 生成日: 2026-02-18
> 用途: CLAUDE.md にそのまま貼り付けて AI コンテキストとして活用

## 型設計

- `[MUST]` ユーザー向け設定型（partial/optional）と内部処理型（required/resolved）を明確に分離する。入力型は `DeepPartial` で受け付け、デフォルト値マージ後に確定型へ変換する
  - 根拠: 型システムパターン / 抽象化パターン — `BuildConfig`（DeepPartial）と `BuildOptions`（確定型）の分離により、ユーザーは最小限の設定で動作しつつ、内部コードはオプショナルチェーン不要で安全に動作する
- `[MUST]` デフォルト値オブジェクトリテラルに `satisfies` を付け、型の全フィールド網羅をコンパイル時に検証する。`as` アサーションよりも `satisfies` を優先する
  - 根拠: 型システムパターン / 設定パターン — `satisfies BuildOptions` により、フィールド追加時にデフォルト値の更新漏れがコンパイルエラーで検出される
- `[SHOULD]` 複数のバリアントを持つ型は discriminated union で表現し、string literal フィールドで判別する
  - 根拠: 型システムパターン — `BuildEntry` union と各ビルダーの `builder: "rollup"` 等のリテラル型により、ランタイムのフィルタ条件がそのまま型ガードとして機能する
- `[SHOULD]` プラグイン/機能の有効・無効は `OptionsType | false` で表現し、`enabled: boolean` の別フィールドを持たない。`undefined`（デフォルト使用）と `false`（明示的無効化）を区別する
  - 根拠: 型システムパターン / 抽象化パターン — Rollup プラグイン設定が `PluginOptions | false` を採用し、条件付き配列 + `filter(Boolean)` で宣言的にプラグインを合成している
- `[SHOULD]` 外部ライブラリの型を内部で利用する際は、interface extends や `Parameters<typeof fn>` で再定義・抽出し、内部の型制約を厳密にする
  - 根拠: 型システムパターン — Rollup の `_RollupOptions` を extends して `plugins: Plugin[]`（nullable 不可）に厳密化している
- `[AVOID]` `Array.filter` の結果を `as SomeType[]` でキャストする。type predicate `(e): e is SomeType => ...` を使って型を絞り込む
  - 根拠: 型システムパターン — `filter` + `as` はフィルタ条件の誤りを型チェッカーが検出できない

## 設定・構成

- `[MUST]` 設定マージの優先順位を「具体性が高い順」で明示的に定め、引数の順序で優先順位を表現する
  - 根拠: 抽象化パターン / 設定パターン — `defu(buildConfig, pkg.unbuild, inputConfig, preset, defaults)` の引数順が優先順位そのものであり、コード上で即座に読み取れる
- `[SHOULD]` 設定ヘルパー関数（`defineXxxConfig`）を提供し、TypeScript の型推論による自動補完を利用者に与える
  - 根拠: 抽象化パターン / 設定パターン — `defineBuildConfig` は実質 identity 関数だが、型推論を通じて設定ファイルでの DX を大幅に向上させる
- `[SHOULD]` ゼロコンフィグの自動推論ロジックはプリセット/フックとして実装し、明示的な設定が与えられた場合は無条件にバイパスする
  - 根拠: アーキテクチャ / 設計思想 — `autoPreset` は `build:prepare` フックで「エントリーが既に存在する場合は即 return」し、明示設定と自動推論の競合を回避する
- `[SHOULD]` 既存のマニフェストファイル（package.json, tsconfig.json 等）から設定を推論し、専用の設定ファイルなしでも動作する Convention over Configuration 設計を採用する
  - 根拠: 設計思想 — `inferEntries` が package.json の `exports` フィールドからビルドエントリ・フォーマット・型生成を自動推論する
- `[SHOULD]` 暗黙的な動作には必ず警告を伴わせ、デフォルトで警告をエラーとして扱うことで、ユーザーに明示的な判断を促す
  - 根拠: 設計思想 / 依存関係管理 — 外部依存の暗黙バンドル時に `warn()` を呼び、`failOnWarn: true` のデフォルトでビルドを失敗させる

## モジュール構造

- `[MUST]` モジュールの公開エントリポイント（`index.ts`）にはロジックを書かず、re-export のみにする
  - 根拠: プロジェクト構造 — `src/index.ts`（2行）と `src/builders/rollup/index.ts`（1行）は、内部ファイル構成の変更を外部に波及させない防壁として機能している
- `[MUST]` プラグイン/ストラテジーの追加で orchestration 層のコード変更が最小になるよう、統一インターフェース（共通の関数シグネチャまたは interface）を設ける
  - 根拠: プロジェクト構造 / アーキテクチャ — 4つのビルダーが `(ctx: BuildContext) => Promise<void>` で統一され、配列走査のみで新規ビルダーに対応できる
- `[SHOULD]` 型定義はその型を「所有」するモジュール内に co-locate し、消費者向けには集約ファイルで re-export する
  - 根拠: プロジェクト構造 — 各ビルダーの `types.ts` が Entry/Hooks 型を所有し、`src/types.ts` で集約。型の追加・変更がビルダーディレクトリ内で完結する
- `[SHOULD]` サブモジュールの複雑度が他と大きく異なる場合でも、外部インターフェース（ディレクトリ名 + index.ts の export）は他と同じ構造に揃える
  - 根拠: プロジェクト構造 — rollup ビルダーは内部 12 ファイルだが、`index.ts` は 1 行の re-export で他ビルダーと同じインポートパスを維持している

## フック・ライフサイクル

- `[MUST]` ライフサイクルの完了フック（done / cleanup 等）は、早期リターン・エラーパスを含むすべてのコードパスで呼び出す
  - 根拠: フック・ライフサイクル — rollup ビルダーはスタブモード・エントリ空・通常モードのいずれでも `rollup:done` を呼んでからリターンする
- `[MUST]` フック型を TypeScript の interface として宣言し、ジェネリクスでフックシステムに渡して、フック名・引数の型安全性をコンパイル時に保証する
  - 根拠: フック・ライフサイクル — `Hookable<BuildHooks>` により存在しないフック名やシグネチャ不一致がコンパイルエラーになる
- `[SHOULD]` フック名は `namespace:action` または `namespace:scope:action` のコロン区切り命名規約に従い、所属と意味を構造的に表現する
  - 根拠: フック・ライフサイクル — 全 17 フック名がこの規約に従い、ビルダー名とフェーズが一目でわかる命名になっている
- `[SHOULD]` すべてのフックハンドラの第1引数に共有コンテキストオブジェクトを渡し、フック間の状態共有を明示的にする
  - 根拠: フック・ライフサイクル — 全フックが `ctx: BuildContext` を第1引数に取り、グローバル変数やクロージャへの依存を排除している
- `[SHOULD]` フック型定義は、そのフックを発火するモジュールとコロケーションし、最終的に intersection（extends）で合成する
  - 根拠: フック・ライフサイクル / プロジェクト構造 — 各ビルダーのフック型がローカル `types.ts` に定義され、`BuildHooks` で合成される構造により、変更箇所が局所化されている
- `[AVOID]` フックシステムにおいてイベント名を文字列リテラルのみで管理し、型による制約を設けないこと
  - 根拠: フック・ライフサイクル — hookable + TypeScript の組み合わせにより、フック名のタイポや引数ミスマッチがコンパイル時に検出される

## コード生成・変換

- `[MUST]` コード変換プラグインは冪等性を保証する — 同じ変換が二重に適用されないよう、変換済みかどうかの検出ロジックを含める
  - 根拠: コード生成技法 — `code.includes(CJSShim)` によるガードで shim の二重挿入を防止している
- `[SHOULD]` 複数の出力フォーマット（ESM/CJS/DTS）は、単一のビルドパスから `write()` のオプションを変えて生成する — ビルドパイプラインの重複を避け、出力間の一貫性を保証する
  - 根拠: コード生成技法 — Rollup の `typesBuild` を3回 `write()` して `.d.cts` / `.d.mts` / `.d.ts` を生成している
- `[SHOULD]` 正規表現で十分な変換（shim 挿入、シバン除去など）には AST パーサではなく MagicString を使い、sourcemap を保持する
  - 根拠: コード生成技法 — `MagicString.appendRight` + `generateMap()` でフルパースなしで sourcemap 付きの変換を実現している
- `[AVOID]` コード生成で JSON.stringify できない値（関数参照、クラスインスタンス）をプレースホルダ文字列の置換で埋め込む
  - 根拠: コード生成技法 — `"__$BABEL_PLUGINS"` の文字列置換はデバッグが困難で破綻リスクがある

## 依存関係管理

- `[MUST]` ライブラリのバンドル境界は package.json の依存宣言から自動導出し、設定ファイルと二重管理しない
  - 根拠: 依存関係管理 — `inferPkgExternals` で `dependencies` / `peerDependencies` を external リストに変換し、`validateDependencies` でビルド後に宣言と実態の乖離を検出する
- `[MUST]` 暗黙的にバンドルされる依存には警告を出し、デフォルトでビルドを失敗させる
  - 根拠: 依存関係管理 — `external` 関数でどのカテゴリにも属さない import に `warn` を発行し、`failOnWarn: true` でプロセスを exit(1) する
- `[SHOULD]` 大型依存やユーザー環境に既存の依存は peerDependencies + optional フラグで宣言する
  - 根拠: 依存関係管理 — TypeScript は `peerDependencies` + `peerDependenciesMeta.optional: true` で宣言されている
- `[SHOULD]` エコシステム内のユーティリティライブラリを一貫して採用し、同一目的の重複依存を排除する
  - 根拠: 依存関係管理 — `path` の代わりに `pathe`、glob に `tinyglobby`、ログに `consola` を全ファイルで統一的に使用している

## テスト

- `[MUST]` ビルドツール・コード生成器のテストでは、決定ロジック（何をビルドするか）と変換ロジック（どうビルドするか）を分離し、決定ロジックを I/O 非依存の純粋関数としてユニットテストする
  - 根拠: テストプラクティス — `inferEntries`, `inferExportType`, `validateDependencies` 等を純粋関数として抽出し、高速にテストしている
- `[MUST]` テスト fixture がプロジェクト構造全体を必要とする場合、実際のプロジェクトと同じ構成を持つミニチュアプロジェクトとして構築する
  - 根拠: テストプラクティス — `test/fixture/` は package.json, build.config.ts, src/ を含む完全なプロジェクト構造で全4ビルダーをカバーしている
- `[SHOULD]` ツールが自分自身を処理できる場合、CI パイプラインで self-build をテスト実行前のゲートとして配置する
  - 根拠: テストプラクティス — CI で `pnpm build`（self-build）を `pnpm vitest run` の前に配置し、ビルドパイプライン全体の回帰をテスト以前に検出している
- `[SHOULD]` テスト用 fixture を開発ワークフロー（dev スクリプト等）からも参照し、fixture の鮮度を自動的に維持する
  - 根拠: テストプラクティス — `"dev": "pnpm unbuild test/fixture"` がテスト fixture を開発時のビルドターゲットとして再利用している
- `[AVOID]` テストコードで `as any` を使って型チェックを全面的に迂回すること。部分モックが必要な場合はテスト用ファクトリ関数や `Partial<T>` + 必須フィールドの組み合わせを検討する
  - 根拠: テストプラクティス — `as any` の多用は `BuildContext` のインターフェース変更時にテストがコンパイルエラーで検出できないリスクがある

## ルール優先度の解釈

- `[MUST]`: 違反するとバグ・セキュリティリスク・重大な設計劣化を招くルール
- `[SHOULD]`: 従うことで品質が向上するが、文脈によっては例外を許容するルール
- `[AVOID]`: 意図的に避けるべきアンチパターン・非推奨プラクティス
