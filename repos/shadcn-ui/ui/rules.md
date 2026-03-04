# shadcn-ui/ui — 導出ルール集

> 出典: repos/shadcn-ui/ui/ | 生成日: 2026-03-04
> 用途: CLAUDE.md にそのまま貼り付けて AI コンテキストとして活用

## パイプライン設計と変換

- `[MUST]` データ変換パイプラインの各ステップは統一インターフェース（同じ入出力型シグネチャ）に従う関数として実装し、配列で合成する。変換の追加・条件付き適用・順序変更が宣言的に行える
  - 根拠: code-transformation-pipeline — `Transformer<Output = SourceFile>` 型で14種の AST 変換を統一し、呼び出し元が配列を差し替えるだけでパイプラインを構成変更できる
- `[MUST]` 複数の AST ノードを書き換える場合、変更を収集してから逆順（末尾→先頭）に適用する。前方から変更するとノード位置がずれて後続の変更が壊れる
  - 根拠: code-transformation-pipeline — `transform-aschild.ts:129` と `transform-render.ts:119` が一貫してこのパターンを使用
- `[MUST]` コード変換（import パス書き換え、JSX 構造変更等）にはテキスト置換（正規表現）ではなく AST 操作を使う。正規表現ではエッジケースでコードが壊れる
  - 根拠: design-philosophy / migration-patterns — ts-morph による AST 操作が構造的に安全な変換を実現。正規表現ベースの `migrate-radix.ts` は450行超の複雑なエッジケース処理が必要になっている
- `[SHOULD]` パイプラインの各ステップは、対象外の入力に対してエラーを投げずに入力をそのまま返す（フェールソフト設計）。有効/無効の判断はステップ内部の早期リターンで制御する
  - 根拠: composition-patterns — 全トランスフォーマーが設定値を冒頭で検査し、不要なら `sourceFile` をそのまま返す。パイプライン構築コードがシンプルに保たれる
- `[SHOULD]` パイプライン内のトランスフォーマーから、文脈非依存な純粋関数（`string → string`）を抽出して別途エクスポートする。CLI・ビルドスクリプト・マイグレーションツール等で再利用できる
  - 根拠: code-transformation-pipeline — `transformDirection` と `cleanupMarkers` が CLI・ビルド・マイグレーションの3箇所で再利用されている
- `[AVOID]` パイプラインの順序制約を暗黙にしない。cleanup・正規化ステップの実行位置はコードレベルで保証する
  - 根拠: code-transformation-pipeline — `transformCleanup` が最後でないとマーカークラスが残り他のトランスフォーマーが誤動作するが、型では表現されていない

## スキーマバリデーションと型システム

- `[MUST]` 外部データ（HTTP レスポンス・ファイル読み込み・CLI 引数・設定ファイル）はシステム境界で Zod 等のスキーマバリデーションを通す。特にデータ統合（merge/aggregate）後の再検証を怠らない
  - 根拠: architecture / schema-validation-patterns — `resolver.ts:346` で `deepmerge.all()` 後に `registryResolvedItemsTreeSchema.parse()` を行い、統合による型崩れを防止
- `[MUST]` Zod スキーマを定義したら、型は `z.infer<typeof schema>` で導出する。手書きの型とスキーマを並存させない
  - 根拠: type-system-patterns — コードベース全体で60箇所以上が `z.infer` で型注釈。スキーマ変更時の型定義の同期漏れを構造的に防止
- `[MUST]` discriminatedUnion のバリアントで共通フィールドがある場合、共通スキーマを定義して `.extend()` で差分だけを追加する
  - 根拠: schema-validation-patterns — 15以上の共通フィールドを `registryItemCommonSchema` に集約し、3バリアントが `.extend()` で固有フィールドだけを追加。変更が1箇所で完結
- `[SHOULD]` discriminatedUnion から特定バリアントの型を取り出す場合、`Extract<UnionType, { discriminator: "value" }>` を使う
  - 根拠: type-system-patterns — `RegistryBaseItem`, `RegistryFontItem` がこのパターンで定義され、バリアント固有フィールドへの型安全なアクセスを実現
- `[SHOULD]` ユーザー向けの設定スキーマには `.strict()` を適用し、タイポや非推奨フィールドの混入を拒否する。内部中間データは `.passthrough()` で柔軟に拡張する
  - 根拠: schema-validation-patterns — `rawConfigSchema` に `.strict()` が適用され、内部の `registryItemWithSourceSchema` は `.passthrough()` で `_source` フィールドを許容
- `[SHOULD]` discriminatedUnion のバリアントが多い場合は、固有フィールドを持つバリアントのみ個別定義し、残りは `.exclude()` で1つのバリアントにまとめる
  - 根拠: type-system-patterns — 14種の registry item type を3バリアントに集約し、新タイプ追加時の変更箇所を最小化
- `[SHOULD]` 同一操作に対して複数の入力形式をサポートする場合、Zod の union で「簡易形式」と「詳細形式」を同一スキーマに統合する
  - 根拠: api-design-practices — `registryConfigItemSchema` が文字列とオブジェクトの union で段階的な設定を実現
- `[AVOID]` Zod スキーマの隣に同じ構造の `interface` や `type` を手書きで定義すること。型の二重管理は不整合の温床になる
  - 根拠: type-system-patterns — コードベース全体で `z.infer` 以外の型定義が存在しないことで、型更新漏れが構造的に排除されている

## エラーハンドリング

- `[MUST]` カスタムエラークラスには `code`（enum）・`context`（デバッグ情報）・`suggestion`（ユーザーが次に取るべきアクション）を必須フィールドとする
  - 根拠: error-handling-idioms — 全16エラーサブクラスが suggestion を持ち、CLI と MCP レスポンスの両方でユーザーに表示される
- `[MUST]` エラーの表示ロジックは単一のハンドラ関数に集約し、コマンド側の catch 節は `handleError(error)` の1行のみにする
  - 根拠: error-handling-idioms — 全コマンドが同一パターンの `catch (error) { handleError(error) }` を使い、エラー表示ロジックの重複を排除
- `[MUST]` HTTP ステータスコードに対応するエラークラスを個別に定義し、catch-all の汎用 HTTP エラーを最後に配置する
  - 根拠: error-handling-idioms — `fetcher.ts` で 401→404→410→403→汎用の順に throw し、ステータスごとの suggestion を差別化
- `[SHOULD]` エラーコードを `as const` オブジェクトで定数化し、`instanceof` と併用して型安全なエラー分岐を実現する
  - 根拠: error-handling-idioms — `RegistryErrorCode` の定数化により、テスト時に `error.code === RegistryErrorCode.NOT_FOUND` のような厳密なアサーションが可能
- `[SHOULD]` エラークラスに `toJSON()` を実装し、ログ・API レスポンス・デバッグ出力でシリアライズ可能にする
  - 根拠: error-handling-idioms — `RegistryError.toJSON()` が MCP サーバー・CLI・テストのスナップショットに統一された形式を提供
- `[AVOID]` ライブラリ関数の内部で `process.exit` を呼ぶこと。CLI のエントリポイント（コマンドハンドラ）でのみ終了すべき
  - 根拠: error-handling-idioms — `getShadcnRegistryIndex` 内の `handleError` → `process.exit` は、MCP サーバーから再利用する際にプロセスが予期せず終了するリスクを生む
- `[AVOID]` 空の catch 節でエラーを握り潰すこと。少なくともコメントに加えてデバッグログを出力する
  - 根拠: error-handling-idioms — `resolver.ts:464` の空 catch は、レジストリサーバーの障害時にサイレントに依存を欠落させる

## Preflight 検証と CLI 設計

- `[MUST]` CLI コマンドの前提条件検証は専用の preflight 関数に分離し、コマンド本体のロジックと混在させない
  - 根拠: preflight-validation-patterns — 5つのコマンドすべてが `preFlightXxx` を最初に呼び、検証ロジックとビジネスロジックを明確に分離
- `[MUST]` preflight 関数はエラーを例外ではなくデータ（エラーマップまたは Result 型）として返し、呼び出し元がエラー種別に応じた応答（自動回復・ガイド付き中断・即時中断）を選択できるようにする
  - 根拠: preflight-validation-patterns — `add.ts` では `MISSING_CONFIG` エラーに対して init 自動実行、`MISSING_DIR_OR_EMPTY_PROJECT` に対してプロジェクト新規作成と、エラー種別ごとに異なる回復戦略を実装
- `[MUST]` CLI のコマンドオプションは Zod スキーマでバリデーションし、action ハンドラの先頭で `parse()` してから後続処理に渡す
  - 根拠: cli-framework-patterns — 全10コマンドがこのパターンを採用し、CLI 入力と内部ロジックの型安全な境界を実現
- `[SHOULD]` 段階的検証では致命的な前提条件（ディレクトリ不在等）を先に検証し、失敗時は早期リターンして後続の無意味な検証を回避する
  - 根拠: preflight-validation-patterns — 全 preflight 関数が「ディレクトリ存在→設定ファイル存在→設定パース」の順で検証し、前段の失敗で即 return
- `[SHOULD]` 設定ファイルが不完全でも CLI が動作するよう、デフォルト値でマージした Shadow Config を用意する
  - 根拠: cli-framework-patterns — `view` と `search` コマンドが `configWithDefaults({})` でフォールバックし、`components.json` がなくてもレジストリの閲覧が可能
- `[AVOID]` preflight 関数内で `process.exit` を直接呼ぶことで、呼び出し元の回復機会を奪うこと
  - 根拠: preflight-validation-patterns — `preflight-init.ts:49` は設定衝突時に `process.exit(1)` するが、エラーマップを返す方が柔軟性が高い

## 設定管理

- `[MUST]` CLI ツールの設定スキーマは「ユーザー入力用（raw）」と「実行時用（resolved）」を分離し、Zod の `.extend()` で型安全に接続する
  - 根拠: configuration-patterns — `rawConfigSchema` と `configSchema` を分離し、物理パス解決を実行時にのみ行うことで、設定のポータビリティとテスタビリティを両立
- `[MUST]` 設定ファイルにシリアライズする際は実行時のみ必要なフィールド（解決済みパス、キャッシュ等）を除外する
  - 根拠: configuration-patterns — `resolvedPaths` を含んだまま `components.json` に書き込むとポータビリティが壊れる
- `[SHOULD]` 設定オブジェクトの生成には DeepPartial を受け取るファクトリ関数を提供し、テストや中間状態でも型安全な完全オブジェクトを返す
  - 根拠: configuration-patterns — `createConfig()` は任意の部分オーバーライドから完全な Config を生成し、テストで検証されている
- `[SHOULD]` 設定ファイルの書き込み前にバックアップを作成し、プロセス異常終了時に復元する
  - 根拠: configuration-patterns — `init` コマンドは `process.on("exit")` でバックアップの復元/削除を行い、途中失敗時の設定ファイル破損を防止
- `[AVOID]` 組み込み設定とユーザー設定を同じ名前空間で無制限にマージする（組み込みキーの上書きガードを設けること）
  - 根拠: configuration-patterns — `getRawConfig` はユーザーが `BUILTIN_REGISTRIES` のキーを上書きしようとした場合にエラーを投げる

## セキュリティ

- `[MUST]` 外部入力由来のファイルパスは多段階で検証する（null バイト、URL 多重エンコード、パストラバーサル、OS 固有パス形式）。信頼境界を超えたパスを直接使わない
  - 根拠: architecture / preflight-validation-patterns — `is-safe-target.ts` が15種類以上の攻撃ベクトルを網羅的にチェックし、registry からの不正パスがファイルシステムに到達することを防止

## API 設計とコンポーネント設計

- `[MUST]` 公開 API のエントリポイントでは、内部モジュールから選択的に re-export し、意図しないシンボルの漏洩を防ぐ
  - 根拠: api-design-practices — `registry/index.ts` が `builder.ts`, `fetcher.ts`, `resolver.ts`, `context.ts` 等の内部モジュールを隠蔽
- `[SHOULD]` React コンポーネントの Props 型は `React.ComponentProps<"element">` から導出し、追加 props のみ交差型（`& { ... }`）で拡張する。カスタム interface の独自定義を避ける
  - 根拠: api-design-practices / type-system-patterns — 53コンポーネント・289箇所で一貫して使用。上流の型変更への自動追従と型定義の重複排除を実現
- `[SHOULD]` コンポーネントの各サブパーツに意味的な `data-*` 属性（例: `data-slot`）を付与し、クラス名とは独立した安定的なセレクタ契約を提供する
  - 根拠: api-design-practices — 53コンポーネント・329箇所で `data-slot` を一貫して使用し、テスト・外部スタイリングの安定的な対象を提供
- `[SHOULD]` 非推奨 API は `@deprecated` JSDoc + 新 API を内部で呼び出すアダプタとして実装し、後方互換性を維持する
  - 根拠: api-design-practices — `getRegistriesIndex()` が内部で `getRegistries()` を呼び出し、戻り値を旧 API 型に変換
- `[AVOID]` `export *` による再エクスポートで公開 API 境界を構成すること（内部シンボルの意図しない漏洩リスクがある）
  - 根拠: api-design-practices — `schema/index.ts` の `export * from "../registry/schema"` は、スキーマファイルに内部ヘルパーを追加した瞬間に公開 API に漏洩する

## テスト

- `[MUST]` MSW サーバーのライフサイクルは `beforeAll/listen`, `afterEach/resetHandlers`, `afterAll/close` の3点セットで管理する
  - 根拠: testing-practices — 全 MSW テストファイルが統一的にこのパターンを使用し、テスト間のハンドラ汚染を防止
- `[MUST]` ファイルシステムを操作するテストは一時ディレクトリを作成し、`try/finally` または `afterAll` でクリーンアップする
  - 根拠: testing-practices — ローカルファイルテストと統合テストの `globalSetup` が `rimraf` で一時ディレクトリを破棄
- `[SHOULD]` 単体テストと統合テストは Vitest Workspace で別の設定ファイルに分離し、タイムアウトや並列度を独立して調整する
  - 根拠: testing-practices — ルートの vitest.config.ts（デフォルトタイムアウト）と packages/tests/vitest.config.ts（120秒タイムアウト、maxConcurrency:4）が異なるテスト要件に対応
- `[SHOULD]` AST 変換や文字列変換のテストには `toMatchInlineSnapshot()` を使い、テストファイル内で入出力を可視化する
  - 根拠: testing-practices — 全変換テスト（20+ケース）が一貫して `toMatchInlineSnapshot()` を使用
- `[SHOULD]` 入力パターンが多い純粋関数のテストには `it.each` でパラメタライズドテストを使い、各パターンを独立してレポートする
  - 根拠: testing-practices — `parser.test.ts` が60以上のパースパターンを `it.each` で網羅的にカバー
- `[AVOID]` テストで `sleep` を使ってサーバー起動を待つ。ポーリングまたはイベント駆動で ready 状態を確認すべき
  - 根拠: testing-practices — `init.test.ts:14` の `setTimeout(resolve, 2000)` は環境依存で不安定

## マイグレーションとコード生成

- `[MUST]` マイグレーションスクリプトでは変換コアを純粋関数として分離し、ファイル I/O やユーザーインタラクションから独立させる
  - 根拠: migration-patterns — `migrateRadixFile(content)` のように内容を受け取り結果を返す純粋関数を export し、テストではモック不要で直接検証
- `[MUST]` 自動生成ファイルには「生成元スクリプト名」「編集禁止」の注釈を先頭に付与する
  - 根拠: build-and-tooling — `__index__.tsx` に `// This file is autogenerated` と `// Do not edit this file directly.` を付与
- `[MUST]` コード自動書き換えツールは変換後のコードスタイル（クォート種別・セミコロン・インデント）を元コードに合わせて保存する
  - 根拠: migration-patterns — `migrateRadixFile` は最初の import からクォートスタイルとセミコロンの有無を検出し、生成コードに反映
- `[SHOULD]` 変換規則が多数ある場合はマッピングテーブル（データ）と適用関数（ロジック）を分離し、テーブルの追加だけで新しい変換を追加可能にする
  - 根拠: migration-patterns — RTL 変換は40近いクラス名マッピングをテーブルで管理し、`applyRtlMapping` が一律に適用
- `[AVOID]` 変換の中間状態をマジック文字列プレースホルダで管理する方式。コード中にプレースホルダと同名の文字列が存在すると誤動作する
  - 根拠: migration-patterns — `__SLOT_PLACEHOLDER__` を使った二重置換回避は、プレースホルダがコード中に存在しないという脆い仮定に依存

## モノレポとビルド

- `[MUST]` pnpm-workspace.yaml でテスト用 fixture/temp ディレクトリを除外する
  - 根拠: project-structure / dev-conventions — `!**/test/**`, `!**/fixtures/**`, `!**/temp/**` で統合テストの一時ファイルがワークスペースパッケージとして認識されることを防止
- `[MUST]` Turborepo 等のビルドシステムで、lint とテストのキャッシュを明示的に無効化する
  - 根拠: dev-conventions — `turbo.json` で `lint`、`test`、`format:check` はすべて `cache: false` に設定。環境依存の偽陰性を防止
- `[SHOULD]` 1パッケージで複数の公開 API を提供する場合、tsup のエントリポイント分割と `package.json` の `exports` マップを1:1で対応させる
  - 根拠: project-structure / build-and-tooling — 6エントリポイントと6 exports が正確に対応し、パッケージの公開 API を明確に制御
- `[SHOULD]` コード生成パイプラインでは、生成データを次工程に渡す前にスキーマバリデーション（`safeParse`）を挟む
  - 根拠: build-and-tooling — `registrySchema.safeParse()` を全ビルドステップで実行し、不正データの伝播を防止
- `[AVOID]` モジュールスコープの可変状態を横断的関心事（認証、設定）の管理に使う。関数パラメータまたはリクエストスコープのコンテキストオブジェクトを優先する
  - 根拠: architecture / extensibility-mechanisms — `registry/context.ts` のモジュール変数が `clearRegistryContext()` の呼び忘れで状態残留を起こしうる

## ルール優先度の解釈

- `[MUST]`: 違反するとバグ・セキュリティリスク・重大な設計劣化を招くルール
- `[SHOULD]`: 従うことで品質が向上するが、文脈によっては例外を許容するルール
- `[AVOID]`: 意図的に避けるべきアンチパターン・非推奨プラクティス
