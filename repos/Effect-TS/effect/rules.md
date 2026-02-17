# Effect-TS/effect — 導出ルール集

> 出典: repos/Effect-TS/effect/ | 生成日: 2026-02-18
> 用途: CLAUDE.md にそのまま貼り付けて AI コンテキストとして活用

## 型安全性

- `[MUST]` エラー型には `_tag` フィールドをリテラル型で定義し、discriminated union として型安全にパターンマッチできるようにする
  - 根拠: error-handling-idioms — 全エラー型が `_tag` リテラル型で `catchTag`/`catchTags` による型安全ディスパッチを実現
- `[MUST]` 構造的型付けで区別すべき型には `unique symbol` を TypeId として付与し、interface のフィールドとして埋め込む
  - 根拠: type-system-patterns — Option, Either, Effect, Layer 等すべてのデータ型に `TypeId: unique symbol` を持たせ型レベルで区別
- `[MUST]` 型パラメータの分散（共変/反変/不変）は関数型ファントムフィールド（`Covariant<A>`, `Contravariant<A>`, `Invariant<A>`）でエンコードする
  - 根拠: type-system-patterns — 全データ型が `out` アノテーションとファントムフィールドを併用し、型互換性の正確な制御を実現
- `[MUST]` 条件型で union の分配を防ぐ必要がある場面では `[T] extends [...]` のタプルラッパーを使う
  - 根拠: type-system-patterns — 全型抽出ユーティリティ（`Effect.Context`, `Effect.Error` 等）が一貫してこのパターンを適用
- `[SHOULD]` 型の識別には `instanceof` ではなく `Symbol.for()` ベースの TypeId + `hasProperty` 型ガードを使う
  - 根拠: abstraction-patterns — CJS/ESM 混在・ホットリロード・バンドラー重複で `instanceof` が壊れるのを回避
- `[SHOULD]` ブランド型は intersection（`A & Brand<K>`）として実装し、元の型の操作を保持しつつ型レベルの区別を追加する
  - 根拠: type-system-patterns — `Brand.Branded<A, K> = A & Brand<K>` でブランド付きの number が算術演算可能なまま型区別を実現
- `[SHOULD]` 型抽出ユーティリティ（`Type<S>`, `Error<S>` 等）はデータ型の `declare namespace` 内に配置し、名前空間を整理する
  - 根拠: type-system-patterns — `Effect.Context<T>`, `Schema.Type<S>` 等で namespace 内に型ユーティリティを集約し API の発見容易性を向上
- `[SHOULD]` 型レベルでエラーを報告する場面ではリテラル文字列型を返し、開発者に原因を伝える
  - 根拠: type-system-patterns — `Brand.EnsureCommonBase` が `"ERROR: All brands should have the same base type"` を返す設計
- `[AVOID]` 型パラメータの分散を `out` / `in` アノテーションのみに依存しファントムフィールドでのエンコーディングを省略すること
  - 根拠: type-system-patterns — コンパイラバージョン間で挙動が変わるリスクがあり、Effect-TS は二重の安全策を取っている

## エラーハンドリング

- `[MUST]` エラーを変換・ラップする際は元のエラーを `cause` フィールドに保持し、エラーチェーンを途切れさせない
  - 根拠: error-handling-idioms — 全エラー変換箇所で `new XxxError({ cause, method })` として元エラーを保持
- `[MUST]` 複数の失敗モードを持つ計算のエラー型は discriminated union（`_tag` 付き）で定義する
  - 根拠: effect-model — `catchTag`/`catchTags` は `_tag` フィールドを前提に `Exclude` で型を除去する設計
- `[SHOULD]` 回復可能なエラー（ドメインエラー）と回復不能なエラー（バグ）を型レベルで分離し、回復不能エラーは明示的に別チャネルに移す
  - 根拠: error-handling-idioms — `ParseError` を `die` で欠陥に昇格させリトライ対象から除外するパターン
- `[SHOULD]` エラー型に `reason` フィールドをリテラルユニオン型で持たせ、同一エラー種別内の原因を構造的に分類する
  - 根拠: error-handling-idioms — `RequestError` の `"Transport" | "Encode" | "InvalidUrl"` 等で `_tag` + `reason` の二層分類を統一
- `[SHOULD]` モジュール境界でエラー型を変換し、内部実装のエラー型を呼び出し側に漏洩させない
  - 根拠: error-handling-idioms — `SqlEventJournal` が内部 `SqlError` を `EventJournalError` にラップして公開 API のエラー型を制御
- `[SHOULD]` エラークラスに `get message()` getter を定義し、構造化フィールドから人間向けメッセージを合成する
  - 根拠: error-handling-idioms — 全パッケージのエラークラスが統一的にこのパターンを実装
- `[SHOULD]` 構造化エラーは tagged union のツリーとして表現し、複数のフォーマッタ（人間向け、機械向け）で変換可能にする
  - 根拠: schema-validation — `ParseIssue` が葉ノード/複合ノードの tagged union で TreeFormatter と ArrayFormatter が同一ツリーから異なる出力を生成
- `[AVOID]` 例外をキャッチして `unknown` 型のまま型チャネルに流す — 必ず具体的なエラー型に変換してから失敗させる
  - 根拠: error-handling-idioms — コードベースの全箇所で `catch` を指定して具体型に変換

## API 設計

- `[MUST]` dual API を提供する関数では、data-first の実装を 1 つ書き `dual(arity, body)` で data-last バリアントを自動導出する
  - 根拠: api-design-practices — 593 箇所の `dual` 使用すべてがこのパターンに従い実装の一元管理を実現
- `[MUST]` Refinement（型ガード）オーバーロードは、同じシグネチャの Predicate オーバーロードより前に宣言する
  - 根拠: api-design-practices — TypeScript のオーバーロード解決は宣言順であり、順序を誤ると型絞り込みが効かない
- `[SHOULD]` 同名の操作（`map`, `filter` 等）を複数のデータ型に提供する場合は、名前空間 re-export で衝突を回避し `Type.operation` 形式で提供する
  - 根拠: api-design-practices — 175 個の `export * as X from` により `Array.map`, `Option.map` が衝突せず共存
- `[SHOULD]` data-first スタイルの第 1 引数は `self`、第 2 引数以降のデータ引数は `that` と命名する
  - 根拠: api-design-practices — 全モジュールで統一されパイプライン中のデータフロー把握を容易にしている
- `[SHOULD]` data-last オーバーロードのコールバック型引数には `NoInfer<A>` を適用し、コールバックからのジェネリック型逆推論を防止する
  - 根拠: api-design-practices — `Array.ts` で 31 箇所の `NoInfer` 使用によりパイプライン中の型推論が安定
- `[AVOID]` ライブラリ API で data-last のみの関数を提供すること — パイプライン外での直接呼び出しが不自然になる
  - 根拠: api-design-practices — Effect は全操作関数を `dual` で両対応させておりdata-last 専用関数は存在しない

## モジュール設計とパッケージ構造

- `[MUST]` 公開 API（`src/*.ts`）と内部実装（`src/internal/*.ts`）を物理的に分離し、公開モジュールにはロジックを書かず re-export に徹する
  - 根拠: architecture — 177 公開モジュールすべてが `= internal.*` 形式で export し API 安定性とリファクタリング自由度を両立
- `[MUST]` `package.json` の `exports` フィールドで `"./internal/*": null` を設定し、内部モジュールへの外部アクセスをブロックする
  - 根拠: project-structure — 全 30+ パッケージが宣言し Node.js のモジュール解決レベルで内部実装のインポートを拒否
- `[MUST]` モノレポのパッケージ間依存は DAG を維持し、循環依存検出を CI で自動実行する
  - 根拠: project-structure — `madge` で全パッケージの循環依存を検出し CI で exit(1)
- `[SHOULD]` 抽象インターフェースパッケージと具象実装パッケージを分離し、依存の方向を「具象 → 抽象 → コア」に統一する
  - 根拠: project-structure — platform, sql, ai の全ファミリーがこのパターンに従っている
- `[SHOULD]` 大規模パッケージではバレルファイル（index.ts）からの import を禁止し、サブモジュール単位の import を ESLint ルールで強制する
  - 根拠: project-structure — `@effect/no-import-from-barrel-package` でサブモジュール import を強制しツリーシェイキングを保証
- `[SHOULD]` マルチバックエンドのサービス抽象化では、汎用 Tag と具象 Tag の両方を同時に提供する Layer を作成する
  - 根拠: extensibility-mechanisms — 全 SQL ドライバ（10+ パッケージ）が dual-tag パターンを一貫して適用
- `[SHOULD]` プラットフォーム抽象化のインターフェースにはランタイム固有の型を含めず、フレームワーク自身の型のみで構成する
  - 根拠: extensibility-mechanisms — `@effect/platform` のインターフェースは全て Effect/Stream/Scope 型のみで定義
- `[AVOID]` モノレポ内のパッケージ間で型 import 以外の循環参照を作ること（型 import は `skipTypeImports: true` で許容）
  - 根拠: project-structure — `madge` で値レベル循環を厳格に禁止しつつ型相互参照は許容

## リソース管理と並行処理

- `[MUST]` リソースの acquire-release ペアは不可分操作（uninterruptible 領域）で囲み、acquire 完了後のファイナライザ登録を割り込みから保護する
  - 根拠: concurrency-patterns — `acquireRelease` が `core.uninterruptible(core.tap(acquire, addFinalizer))` で実装
- `[MUST]` 並行タスクの寿命は親タスクまたは明示的なスコープの寿命に束縛する（構造的並行処理）
  - 根拠: concurrency-patterns — `fork` はデフォルトで親の FiberScope に子を登録し親終了時に `interruptAllChildren()` を呼ぶ
- `[MUST]` リソースのライフサイクルを持つサービスは、スコープ付き構築関数で定義し手動解放を避ける
  - 根拠: dependency-injection — `Layer.scoped` と `Scope` の組み合わせでリソースはスコープ終了時に確実に解放
- `[SHOULD]` ファイナライザは登録の逆順（LIFO）で実行し、リソースの依存順序を尊重する
  - 根拠: concurrency-patterns — Scope の `close` がファイナライザを `reverse()` で逆順実行
- `[SHOULD]` 並行度は個別 API に埋め込まず、統一的な concurrency パラメータとして抽象化する
  - 根拠: concurrency-patterns — `Concurrency` 型で sequential/parallel/parallelN を統一的にディスパッチ
- `[AVOID]` グローバルスコープへのフォーク（`forkDaemon` 相当）を安易に使わない — 明示的なライフサイクル管理が不要なケースのみに限定する
  - 根拠: concurrency-patterns — `forkDaemon` は親の終了で interrupt されないためタスクリークを起こしうる

## パフォーマンス

- `[MUST]` ホットパスでは `array.push(...spread)` を避け、for ループで個別に push する
  - 根拠: performance-techniques — ESLint ルールでプロジェクト全体から排除。大きな配列でスタックオーバーフロー発生
- `[MUST]` イミュータブルコレクションにバッチ更新する際は transient/mutable セッションで囲み、完了後にイミュータブルに戻す
  - 根拠: performance-techniques — HashMap の `beginMutation/endMutation` で in-place 更新を可能にし全ファクトリメソッドが使用
- `[SHOULD]` 頻繁にハッシュ比較されるオブジェクトには、初回計算時にハッシュ値をキャッシュする仕組みを設ける
  - 根拠: performance-techniques — `Hash.cached` で 20 以上のデータ構造にハッシュメモ化を適用
- `[SHOULD]` ランタイムの中核で大量生成されるオブジェクトは、プロパティの名前と数を固定して Monomorphic Shape を維持する
  - 根拠: performance-techniques — EffectPrimitive の 3 スロット固定で V8 の hidden class 分裂を防止
- `[SHOULD]` コレクションの concat/slice 操作は実際のコピーを遅延し、ロープ構造などの論理的な表現で O(1) にする
  - 根拠: performance-techniques — Chunk の `IConcat`/`ISlice` タグが物理的な配列コピーを `toReadonlyArray` まで遅延
- `[SHOULD]` CJS/ESM 混在環境でシングルトンを保証するには `globalThis` 上のバージョン付きストアを使う
  - 根拠: performance-techniques — `globalValue` が `Symbol.for` でグローバルキーを共有しランタイム基盤の重複生成を防止
- `[AVOID]` 同種オブジェクトにオペレーションごとの異なるプロパティセットを持たせること（Polymorphic Shape）
  - 根拠: performance-techniques — V8 の hidden class 分裂によりプロパティアクセスが 10-100x の性能劣化を招く

## テスト

- `[MUST]` エフェクトフルなコードのテストには、テストランナー側でライフサイクル管理（リソース解放・ファイバー割り込み）を行う仕組みを使う
  - 根拠: testing-practices — テスト終了時のファイバー割り込みとリソース解放を保証し手動 `runSync` のリーク防止
- `[MUST]` テスト環境（モック時計 vs 実時間、テストランダム vs 実ランダム）は暗黙的に選択せず、各テストケースで明示的に宣言する
  - 根拠: testing-practices — `it.effect`/`it.live`/`it.scoped`/`it.scopedLive` の 4 種類を使い分けテスト環境を明確化
- `[SHOULD]` ドメイン固有の代数的データ型には型ガード付きのカスタムアサーション関数を提供する
  - 根拠: testing-practices — `assertSome`/`assertNone` 等が `asserts x is T` でアサーション後の型安全を保証
- `[SHOULD]` バリデーションスキーマが存在する場合、プロパティベーステストの Arbitrary はスキーマから自動導出する
  - 根拠: testing-practices — Schema → Arbitrary の自動変換でスキーマとテストデータの整合性を保証
- `[SHOULD]` 非決定的テスト（ランダム依存・タイミング依存）はリトライラッパーで明示的にマークし、暗黙的な flaky テストを許容しない
  - 根拠: testing-practices — `flakyTest` ユーティリティでリトライ上限とタイムアウトを設定し非決定性を制御
- `[SHOULD]` 外部依存（DB / HTTP クライアント等）はレイヤーとしてパラメータ化し、同一テストスイートを複数バックエンドで再利用する
  - 根拠: testing-practices — `suite(client)` パターンで SQLite/LibSQL/PostgreSQL で同一テストを実行
- `[AVOID]` テストフレームワークの標準タイマーモックと、アプリケーションレベルの時間抽象を混在させる
  - 根拠: testing-practices — vitest のタイマーモックを無効化し時間制御を Effect の TestClock に一元化

## コード生成と開発ワークフロー

- `[MUST]` 自動生成ファイルは生成元を編集して再生成する — 生成ファイルの直接編集を禁止し CI で差分チェック（`codegen && git diff --exit-code`）を実行する
  - 根拠: code-generation — CI で差分がないことを検証しエクスポートの不整合を防止
- `[MUST]` ライブラリの `src/` 内では自パッケージの barrel からインポートせず、直接モジュールパスを使用する
  - 根拠: dev-conventions — ESLint ルールで強制し循環依存防止とツリーシェイキングの確実性を保証
- `[SHOULD]` barrel file を自動生成する場合、エントリポイントの定義を `package.json` の `exports` やファイルシステム構造から導出する
  - 根拠: code-generation — `build-utils prepare-v3` が exports と generateIndex 設定から barrel file を生成しモジュール追加時の更新漏れを防止
- `[SHOULD]` フォーマッターを ESLint プラグインとして統合し、lint とフォーマットを単一コマンドで完結させる
  - 根拠: dev-conventions — dprint を ESLint ルールとして実行し `pnpm lint-fix` だけで全スタイル修正が完了
- `[SHOULD]` 型テストを tstyche 等の専用ツールで記述し、型推論の正しさを回帰テストとして維持する
  - 根拠: dev-conventions — `dtslint/*.tst.ts` で型テストを 60 以上のファイルで運用し TypeScript nightly でも日次検証
- `[SHOULD]` ビルド時に純粋関数呼び出しへの `/*#__PURE__*/` アノテーションを自動付与し tree-shaking を最適化する
  - 根拠: dev-conventions — `babel-plugin-annotate-pure-calls` を全パッケージのビルドステップで使用
- `[SHOULD]` AST ベースの codemod には入出力ペアのインラインテストを記述し、変換の正確性を保証する
  - 根拠: code-generation — jscodeshift の `defineInlineTest` で変換前後のコードをテスト
- `[AVOID]` コード変換に正規表現を使う — AST パーサー（jscodeshift, ts-morph 等）で構文構造を意識した変換を行う
  - 根拠: code-generation — JSDoc コメントの伝播やフェンス追加は jscodeshift で AST 操作し正確に動作

## スキーマとバリデーション

- `[MUST]` スキーマやバリデーションルールを定義する際は、バリデーション述語とメタデータ（エラーメッセージ、JSON Schema ヒント、説明文）を同じ定義に同梱する
  - 根拠: schema-validation — 全組み込みフィルタが `schemaId`, `title`, `description`, `jsonSchema` を述語と一緒に定義
- `[SHOULD]` 単一のデータ定義から複数の成果物を導出する場合は、中間表現（AST/IR）を定義し各成果物を AST のインタプリタとして実装する
  - 根拠: schema-validation — Parser/JSONSchema/Pretty/Arbitrary を独立インタプリタとして実装し `Match`/`getCompiler` で型安全に追加
- `[SHOULD]` AST の再帰的走査で構造共有を使い、変更がないサブツリーのオブジェクト生成を回避する
  - 根拠: schema-validation — `changeMap` が変更なしなら元の配列を返し不要な GC 負荷を削減
- `[SHOULD]` コンパイル済みのインタプリタ（パーサー等）は AST ノードをキーとして `WeakMap` でメモ化し、同一定義の再コンパイルを防ぐ
  - 根拠: schema-validation — `decodeMemoMap`/`encodeMemoMap` が `WeakMap<AST, Parser>` でパーサーをキャッシュ
- `[AVOID]` バリデーションと型変換を同一のプリミティブで混同する — 型の絞り込み（Refinement）と型の変換（Transformation）は AST レベルで分離すべき
  - 根拠: schema-validation — `Refinement`（型不変）と `Transformation`（型変化）を別のノードとして定義し走査で異なる扱いを実現

## AI エージェント設定

- `[MUST]` AGENTS.md にはコマンドベースのバリデーション手順を記載し、各手順は実際にシェルで実行可能な形式にする
  - 根拠: ai-settings — 具体的コマンドを列挙し AI が解釈なしに実行できるようにしている
- `[MUST]` 自動生成ファイルを明示し、手動編集禁止と再生成コマンドをセットで記述する
  - 根拠: ai-settings — barrel file が自動生成であることを明記し `pnpm codegen` を案内
- `[SHOULD]` AI がコードを試行するための git 追跡外のサンドボックスディレクトリを用意する
  - 根拠: ai-settings — scratchpad/ が workspace に含まれつつ `.gitignore` と changeset の ignore で隔離
- `[SHOULD]` コードスタイルは「既存コードを見て学べ」と指示し、フォーマッタに任せられる部分は「完璧にしようとするな」と明示する
  - 根拠: ai-settings — AI のフォーマット浪費を防ぎ意味のある変更に集中させている
- `[SHOULD]` バリデーション手順にはエラー時のリカバリ手順を含め、AI がエラーループに陥ることを防ぐ
  - 根拠: ai-settings — `pnpm check` 失敗時に `pnpm clean` でキャッシュクリア後再実行のリカバリ手順を記載
- `[AVOID]` AGENTS.md に曖昧な品質基準（「きれいなコードを書け」等）を書くこと — 機械的に検証不可能な指示は AI の行動を制御できない
  - 根拠: ai-settings — 全指示がコマンド実行・具体的パターン・禁止事項の形式で記述

## ルール優先度の解釈

- `[MUST]`: 違反するとバグ・セキュリティリスク・重大な設計劣化を招くルール
- `[SHOULD]`: 従うことで品質が向上するが、文脈によっては例外を許容するルール
- `[AVOID]`: 意図的に避けるべきアンチパターン・非推奨プラクティス
