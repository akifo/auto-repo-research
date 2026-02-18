# unjs/unbuild — 導出ルール集

> 出典: repos/unjs/unbuild/ | 生成日: 2026-02-16
> 用途: CLAUDE.md にそのまま貼り付けて AI コンテキストとして活用

## パイプラインアーキテクチャ

- `[MUST]` パイプラインの各ステージは統一されたシグネチャ `(ctx: Context) => Promise<void>` の関数として実装し、配列で管理して逐次/並列実行を切り替える
  - 根拠: architecture — 4 ビルダーが同一シグネチャで `buildTasks` 配列に格納され、`parallel` オプションで実行方式を 3 行で切り替えている
- `[MUST]` 複数コンポーネントが協調するシステムでは、共有コンテキストオブジェクトを唯一の結合点とし、コンポーネント間の直接参照を排除する
  - 根拠: architecture — 4 つのビルダーは互いを参照せず `BuildContext` のみを介して状態を共有する
- `[SHOULD]` 各ステージは自分が処理すべきデータを self-filtering で取得し、オーケストレーターに振り分けロジック（switch/if）を置かない
  - 根拠: abstraction-patterns — 全ビルダーが `ctx.options.entries.filter(e => e.builder === "xxx")` で自己選別し、オーケストレーターに判定ロジックがない
- `[AVOID]` オーケストレーター関数にオプション構築・実行・レポート・バリデーションなど複数の責務を詰め込んで 300 行超にすること。フェーズごとに関数を分割する
  - 根拠: project-structure — `_build` 関数が 340 行に達しており、分割すればテスタビリティと可読性が向上する

## 設定システム設計

- `[MUST]` 設定オブジェクトのデフォルト値は単一の場所に集約し、ディープマージチェーンの最低優先位置に配置する
  - 根拠: configuration-patterns — `defu` の最終引数にデフォルト値を `satisfies BuildOptions` 付きで一元配置し散在を防止している
- `[MUST]` ツールのデフォルト設定は安全側に倒す（`failOnWarn: true`、`clean: true` 等）。ユーザーが明示的にオプトアウトする設計にする
  - 根拠: design-philosophy — `failOnWarn: true` がデフォルトで、未使用依存・暗黙インライン・出力ファイル欠損を CI で検出する
- `[MUST]` 自動推論やゼロコンフィグ機能を実装する場合、推論結果をログ等で明示的にユーザーに通知する
  - 根拠: configuration-patterns — 推論されたエントリと設定フラグを `consola.info` で出力し暗黙の動作を可視化している
- `[SHOULD]` 設定のマージには宣言的レイヤリング（ディープマージ + 優先順位）を使い、命令的な if/switch による設定上書きを避ける
  - 根拠: architecture — `defu(buildConfig, pkg.unbuild, inputConfig, preset, defaults)` の引数順序で優先順位を表現し複雑な if 文を排除している
- `[SHOULD]` ゼロコンフィグを実現する場合、「出力仕様（マニフェスト）から入力を逆算する」アプローチを採る
  - 根拠: design-philosophy — package.json の exports/main/module/types からエントリポイントとフォーマットを自動推論している
- `[SHOULD]` プラグインや機能モジュールの有効/無効切り替えには `Options | false` ユニオン型を使い、`false` で無効化・`&&` 短絡評価 + `.filter(Boolean)` で条件付き配列を構築する
  - 根拠: configuration-patterns, type-system-patterns — 全 Rollup プラグインオプションが `SpecificOptions | false` 型で統一されている
- `[SHOULD]` プリセット機構はオブジェクト・関数・文字列（モジュールパス）の 3 形式をサポートし、設定の再利用を可能にする
  - 根拠: configuration-patterns — `resolvePreset` が 3 形式を統一的に解決している

## 型設計

- `[MUST]` ライブラリの設定型は「内部用（全フィールド必須）」と「ユーザー向け（DeepPartial）」を分離する
  - 根拠: type-system-patterns — `BuildOptions`（内部）と `BuildConfig`（外部 = `DeepPartial<Omit<BuildOptions, "entries">>`）を分離している
- `[MUST]` ユーザー向け設定に `defineXxxConfig` 形式の型安全ヘルパー関数を提供する。実行時はほぼパススルーで主目的は IDE の型補完
  - 根拠: type-system-patterns, design-philosophy — `defineBuildConfig` は配列化と filter のみで型推論だけで設定ミスを防止している
- `[SHOULD]` サブモジュールの型は各モジュールの `types.ts` で定義し、パッケージのルート型ファイルから `export type` で re-export する
  - 根拠: type-system-patterns — 4 つのビルダーが各自 `types.ts` を持ち `src/types.ts` で一括 re-export している
- `[SHOULD]` 判別可能ユニオン（Discriminated Union）を使い、基底型を拡張して各バリアントを定義する。判別フィールドが省略可能な場合はユーザー入力型と内部処理型を分離する
  - 根拠: type-system-patterns — `BaseBuildEntry.builder?` が optional のため `.filter()` 後に `as` キャストが必要になっている
- `[SHOULD]` ディープマージ関数の戻り値には `satisfies` でデフォルト値の型整合性を検証し、`as` で最終型を確定する二段構えを使う
  - 根拠: type-system-patterns — `defu` の汎用的な戻り値型では型として扱えないため `satisfies` + `as` で安全性と実用性を両立している
- `[AVOID]` `.filter()` のコールバックで判別可能ユニオンを絞り込む際に `as` キャストを使う。代わりに型ガード関数を定義する
  - 根拠: type-system-patterns — 4 つのビルダーで同一の `as XxxBuildEntry[]` キャストが繰り返されている

## ライフサイクルとフック

- `[MUST]` ライフサイクルフックの完了イベント（done/finish/end）はすべてのコードパス（早期リターン・エラー含む）で発火を保証する
  - 根拠: hook-and-lifecycle-patterns — rollup ビルダーは stub モード・空エントリ・通常ビルドの 3 分岐すべてで `rollup:done` を呼ぶ
- `[MUST]` フック名はコロン区切りの名前空間で `<scope>:<phase>` の形式に統一し、スコープとフェーズを名前だけで識別可能にする
  - 根拠: hook-and-lifecycle-patterns — 全 20 フックが `build:prepare`, `rollup:dts:options`, `mkdist:entry:build` のように一貫している
- `[SHOULD]` フック型はサブシステムごとに独立した interface で宣言し、親の型で intersection 合成する
  - 根拠: hook-and-lifecycle-patterns — `BuildHooks extends CopyHooks, UntypedHooks, MkdistHooks, RollupHooks` で各ビルダーのフック定義が独立している
- `[SHOULD]` フック登録の優先順位は「基盤→拡張→ユーザー」の順にし、ユーザーに最も近い層が最後に実行されるようにする
  - 根拠: hook-and-lifecycle-patterns — preset → inputConfig → buildConfig の順で `addHooks` を呼んでいる
- `[SHOULD]` パイプラインのフックにはミュータブルなオブジェクト参照を引数として渡し、ユーザーがインプレースで変更できるようにする（戻り値による置換ではなく追加的変更）
  - 根拠: hook-and-lifecycle-patterns — `rollup:options` フックが `RollupOptions` 参照を渡しユーザーが `plugins.push()` で拡張する
- `[AVOID]` フックのコールバック内でオブジェクトのプロパティを丸ごと置換する操作（他のフックハンドラが追加した変更を消す恐れがある）
  - 根拠: hook-and-lifecycle-patterns — `options.plugins = [...]` とするとコアのプラグインチェーンが消失する

## モジュール構成とエントリポイント

- `[MUST]` ライブラリの公開エントリポイントは re-export のみにし、実装ロジックを含めない
  - 根拠: project-structure — `src/index.ts` は 2 行の re-export で内部モジュール再構成が外部 API に影響しない
- `[SHOULD]` 複雑なサブモジュールは内部をさらに分割しつつ、`index.ts` からの re-export 1 行で外部にはシンプルな Facade を見せる
  - 根拠: project-structure — rollup ビルダーは 8 ファイルの内部構成を持つが外部には `export { rollupBuild }` のみを公開している
- `[SHOULD]` ビルドツール・開発ツールは自身のツールで自身をビルドする（セルフホスティング）
  - 根拠: design-philosophy — unbuild は `build.config.ts` で `defineBuildConfig` を使い `pnpm unbuild` で自身をビルドしている

## コード生成

- `[MUST]` コード生成時にユーザー入力やファイルパスを文字列リテラルに埋め込む場合は `JSON.stringify` を使い、特殊文字のエスケープ漏れを防止する
  - 根拠: code-generation-techniques — スタブ生成の全パス埋め込みで `JSON.stringify` を使用している
- `[MUST]` コード変換関数は冪等にする（既に変換済みのコードに対しては no-op を返す）
  - 根拠: code-generation-techniques — `CJSToESM` は `code.includes(CJSShim)` で二重注入を防止している
- `[SHOULD]` 複数の出力フォーマットを生成する場合、バンドル処理は 1 回で済ませ、出力フェーズのみフォーマットごとに分岐する
  - 根拠: code-generation-techniques — 型宣言生成で `typesBuild` を 1 回作成し `.write()` を 3 回呼んで重複処理を回避している
- `[SHOULD]` コード生成の「何を生成すべきかの検出」と「実際の生成処理」を分離し、検出ロジックを単体テスト可能にする
  - 根拠: code-generation-techniques — `inferEntries` は検出のみ行い 13 個のテストケースで検証されている
- `[AVOID]` サードパーティのプラグインをフォークして修正する。代わりに Decorator パターン（スプレッド + 特定フックのオーバーライド）でラップする
  - 根拠: code-generation-techniques — `JSONPlugin` は `@rollup/plugin-json` をスプレッドでラップし `transform` のみをオーバーライドしている

## 依存関係管理

- `[MUST]` ライブラリビルドでは package.json の dependencies / peerDependencies を externals の真実源とし、自動推論する仕組みを構築する
  - 根拠: dependency-management — `inferPkgExternals` が dependencies, peerDependencies, optionalDependencies, self-reference を一括で external 化している
- `[SHOULD]` ビルド後に「実際に使用された import」と「package.json の宣言」を突き合わせ、unused / implicit dependencies を検出する
  - 根拠: dependency-management — `validateDependencies` がビルド成果物の `usedImports` を追跡し差分を警告する
- `[AVOID]` devDependencies を無差別に external 化する。`@types/` スコープのみに限定すべき
  - 根拠: dependency-management — テストフレームワーク等ビルド成果物と無関係な依存が含まれるため全 external 化は危険
- `[AVOID]` 暗黙のバンドルを無警告で許容する。external にも inline にも該当しない依存にはビルドを通しつつ警告を出す
  - 根拠: dependency-management — `failOnWarn` で CI を止められる設計にしている

## テスト戦略

- `[MUST]` ビルド/変換パイプラインのテストでは、純粋変換ロジック（設定解析・エントリ推論・依存解決）を副作用のある実行ロジック（ファイル書き出し・プロセス呼び出し）から分離し、前者にユニットテストを集中させる
  - 根拠: testing-practices — `inferEntries`, `inferPkgExternals` 等の純粋関数をテストし、ビルダー本体は直接テストしない戦略で最小コスト・高信頼を実現している
- `[SHOULD]` フィクスチャは実際の `package.json` と設定ファイルを持つ「本物のプロジェクト」として構成し、全ビルドパスを単一フィクスチャでカバーする
  - 根拠: testing-practices — `test/fixture/build.config.ts` は 4 ビルダーと 3 設定を 1 ファイルに含みカバレッジを最大化している
- `[SHOULD]` 警告メッセージのテストでは完全一致ではなく部分一致（`include`）で検証し、メッセージフォーマットの軽微な変更に対する耐性を持たせる
  - 根拠: testing-practices — `to.include("Potential missing")` でメッセージの装飾変更に影響されないテストを書いている
- `[AVOID]` テスト用の部分オブジェクト構築で `as any` を多用する。代わりに `Pick<T, K>` や `Partial<T>` で型安全に限定する
  - 根拠: testing-practices — `as any` の多用で `BuildContext` の変更がテストのコンパイルエラーとして検知されない

## ルール優先度の解釈

- `[MUST]`: 違反するとバグ・セキュリティリスク・重大な設計劣化を招くルール
- `[SHOULD]`: 従うことで品質が向上するが、文脈によっては例外を許容するルール
- `[AVOID]`: 意図的に避けるべきアンチパターン・非推奨プラクティス
