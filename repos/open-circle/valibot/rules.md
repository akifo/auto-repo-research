# open-circle/valibot — 導出ルール集

> 出典: repos/open-circle/valibot/ | 生成日: 2026-02-16
> 用途: CLAUDE.md にそのまま貼り付けて AI コンテキストとして活用

## Tree-shaking とバンドルサイズ

- `[MUST]` tree-shakeable ライブラリでは `package.json` に `"sideEffects": false` を設定し、全ファクトリ関数・純粋関数に `// @__NO_SIDE_EFFECTS__` アノテーションを付与する。副作用を持つ関数（ストレージ書き込み等）には付与しない
  - 根拠: 設計思想 / パフォーマンス — 250以上のファクトリ関数に一貫して適用し、`set*` 関数には付与せず `get*` 関数にのみ付与する正確な使い分け
- `[MUST]` tree-shakeable ライブラリでは、クラスではなくファクトリ関数 + プレーンオブジェクトで公開 API を構成する。クラスの prototype チェーンはバンドラの dead code elimination を阻害する
  - 根拠: 設計思想 / 抽象化パターン — 全 schema/action/method をファクトリ関数で実装し、クラスを一切使用しない設計
- `[SHOULD]` `sideEffects: false` を宣言するパッケージでは、モジュールのトップレベルに副作用コード（`new Map()`, `addEventListener` 等）を置かず、遅延初期化パターンを使う
  - 根拠: パフォーマンス / 依存管理 — ストレージモジュールは全て `let store` の宣言のみをトップレベルに置き、初回利用時に初期化
- `[SHOULD]` ライブラリのコアパッケージはランタイム `dependencies` をゼロに保ち、必要な機能は自前実装するか peerDependencies で委譲する
  - 根拠: 依存管理 — 正規表現・Luhn アルゴリズム・バイト数カウント等もすべて自前実装し外部依存ゼロを達成

## TypeScript 型設計

- `[MUST]` オブジェクト形状の型定義には `interface` を使い、`type` はユニオン・交差・マップ型に限定する。`interface` は TypeScript コンパイラの内部キャッシュが効きやすく、大規模な型定義でパフォーマンスが向上する
  - 根拠: 型システム / 設計思想 — 全基底型（`BaseSchema`, `BaseValidation` 等）を `interface` で定義し ESLint `consistent-type-definitions` で強制
- `[MUST]` Discriminated Union のディスクリミナントには文字列リテラル型を使い、全バリアントで同名の `readonly` プロパティとして定義する
  - 根拠: 型システム / アーキテクチャ — `kind` + `type` の2段ディスクリミナントで型ナローイングとランタイム分岐を統一
- `[SHOULD]` ランタイムに不要だが型推論に必要な情報は、optional な Phantom Type プロパティ（`'~types'?: { ... } | undefined`）に格納し、`NonNullable<T[prop]>` で取り出す
  - 根拠: 型システム / メタプログラミング — `'~types'?` がランタイムコストゼロで `InferInput`/`InferOutput`/`InferIssue` の推論を実現
- `[SHOULD]` 型レベルで「少なくとも1つの要素がある配列」を表現する場合は `[T, ...T[]]` タプル型を使う
  - 根拠: 型システム / エラーハンドリング — `issues`, `path` など安全性が求められる配列で非空タプルを一貫して使用
- `[SHOULD]` 構造的に同一だが意味的に異なるプリミティブ型を区別したい場合は、`unique symbol` を使った Branded Type パターンを適用する。必須にすると強い区別（Brand）、optional にすると弱い区別（Flavor）になる
  - 根拠: 型システム — `Brand`（必須）と `Flavor`（optional）の2種類の名目的型を提供
- `[SHOULD]` ジェネリック関数の引数でリテラル型を保持する必要がある箇所に `const` type parameter を使う
  - 根拠: 型システム — 全スキーマファクトリ関数で `const TEntries`, `const TMessage` を使用しリテラル型情報を保持
- `[SHOULD]` IDE での型表示が intersection や条件型の入れ子のまま展開されない場合、`Prettify<T>`（`{ [K in keyof T]: T[K] } & {}`）を適用して展開済みの型を表示させる
  - 根拠: 型システム / メタプログラミング — `InferObjectInput`, `InferObjectOutput` に適用し DX を向上
- `[AVOID]` ジェネリック関数で `const` type parameter を使わずに引数のリテラル型を失う設計
  - 根拠: 型システム — リテラル型情報の喪失は型推論の正確性を損なう

## API 設計

- `[MUST]` ライブラリの公開関数でオプショナルパラメータの型情報を保持する必要がある場合は、optional パラメータではなく関数オーバーロードを使い、省略時のジェネリクス型を `undefined` リテラルに確定させる
  - 根拠: API 設計 — 全スキーマ・アクション関数（100+）がこのパターンで `TMessage` の有無を型レベルで追跡
- `[MUST]` 同一カテゴリに属する公開関数群には、同一の構造プロパティセット（`kind`/`type`/`reference` 等）を持たせ、実行時の判別と静的型推論を両方サポートする
  - 根拠: API 設計 / アーキテクチャ — schema/validation/transformation/metadata の4カテゴリすべてで統一
- `[SHOULD]` 同一概念の動作バリアントは options オブジェクトではなく独立した関数に分離し、各関数のシグネチャを単純に保ちつつ tree-shaking を最大化する
  - 根拠: API 設計 — `object`/`looseObject`/`strictObject`/`objectWithRest` の4分離により未使用バリアントを完全にバンドルから除外
- `[SHOULD]` ユーザー向け拡張ポイントを複数の抽象度レベルで提供し、単純なケースほど制約の強い API を使わせる（Escalating Escape Hatches）
  - 根拠: 拡張性 — `check()` → `rawCheck()` → `rawTransform()` の3段階で抽象度を下げる設計
- `[SHOULD]` parse/safeParse のような「同一ロジック・異なるエラーハンドリング」のペアは、内部実装を共有しつつ戻り値型で使い分けを型レベルで表現する
  - 根拠: API 設計 / エラーハンドリング — `parse()` は throw、`safeParse()` は Discriminated Union の結果オブジェクト

## エラーハンドリング

- `[MUST]` バリデーション結果を返す関数は、内部処理を常に result object で行い、throw は最外層のラッパーでのみ行う
  - 根拠: エラーハンドリング — `parse()` と `safeParse()` は同一の内部処理を共有し、throw は `parse()` の1行のみ
- `[MUST]` エラー配列を持つ型では `undefined | [T, ...T[]]`（非空タプル or undefined）を使い、空配列状態を排除する。存在チェック (`if (issues)`) だけで「エラーあり = 必ず1件以上」を保証できる
  - 根拠: エラーハンドリング — 全 dataset 型で `issues?: [TIssue, ...TIssue[]] | undefined` を使用
- `[SHOULD]` エラーメッセージは具体→抽象の優先度でフォールバック解決する（個別指定 > 種別別グローバル > 全体グローバル）
  - 根拠: エラーハンドリング / 拡張性 — `_addIssue` の6段階 `??` チェーンでメッセージを解決し i18n とカスタマイズを両立
- `[SHOULD]` 内部のエラーデータ構造（木構造）と消費者向けのエラー表現（フラットマップ）を分離し、変換関数を提供する
  - 根拠: エラーハンドリング — `flatten()` が issue の path から dot-path を導出し `root`/`nested`/`other` の3層に分類
- `[AVOID]` エラー配列を空配列 `[]` で初期化すること。undefined を使い、最初のエラー追加時にのみ配列を作成する遅延初期化が望ましい
  - 根拠: エラーハンドリング / パフォーマンス — 正常系（エラーなし）のメモリ割り当てを回避

## テスト

- `[MUST]` 型安全なライブラリでは、ランタイムテスト（`.test.ts`）と型テスト（`.test-d.ts`）を 1:1 で対応させ、`vitest --typecheck` で同一コマンドで実行する
  - 根拠: テスト — 258個のランタイムテストに対し234個の型テストで型と値の整合性を常に保証
- `[MUST]` 同一カテゴリのユニットが多数ある場合、ドメイン固有のテストヘルパーを作成し、アサーションロジックを一元化する
  - 根拠: テスト / コード組織 — 8つのテストヘルパーで数百のテストファイルを統一し、修正箇所を1ファイルに集約
- `[SHOULD]` テストデータに `satisfies` キーワードを付与し、テストデータ自体の型安全性をコンパイル時に検証する
  - 根拠: テスト — 期待値の型を `satisfies` で明示しテストデータと実装の型定義の乖離をコンパイルエラーで検出
- `[SHOULD]` 型テストでは「一致すること」だけでなく「一致しないこと」も検証する（`not.toMatchTypeOf` / `@ts-expect-error`）
  - 根拠: テスト — Brand/Flavor の型テストで異なるブランド名の型が互換でないことを明示的に検証
- `[SHOULD]` 型の推論テストでは Input / Output / Issue（またはプロジェクト固有の型推論軸）を個別のテストケースで検証する
  - 根拠: テスト — パイプラインで transform を挟むと Input と Output の型が異なるため独立して検証が必要

## パフォーマンス

- `[SHOULD]` バリデーションやシリアライゼーションなど繰り返し実行されるホットパスでは、spread 演算子の代わりにプロパティの明示的列挙でオブジェクトを構築する
  - 根拠: パフォーマンス / 設計思想 — `_addIssue` と `getGlobalConfig` が「deliberately not constructed with the spread operator for performance reasons」とコメント
- `[SHOULD]` パイプライン実行のホットパスでは、中間結果オブジェクトを immutable にコピーせずインプレースで更新する
  - 根拠: 抽象化パターン / パフォーマンス — dataset をパイプライン全体でミュータブルに使い回しアロケーションを最小化
- `[SHOULD]` 正規表現の安全性・パフォーマンスを ESLint ルールで自動検証する: `regexp/require-unicode-regexp`（/u フラグ強制）、`regexp/prefer-regexp-exec`（exec 優先）、`redos-detector/no-unsafe-regex`（ReDoS 防止）
  - 根拠: パフォーマンス / セキュリティ — 3ルールを error レベルで有効化しパフォーマンスとセキュリティを同時に保証
- `[AVOID]` 繰り返し使用される正規表現を関数内でリテラルとして定義すること。モジュールレベルの定数として定義し、再コンパイルを防止する
  - 根拠: パフォーマンス / セキュリティ — 30以上の正規表現を `regex.ts` にモジュールレベル定数として集約

## セキュリティ

- `[MUST]` ユーザー入力を含む正規表現には ReDoS 検出ツール（`eslint-plugin-redos-detector` 等）を CI で適用する
  - 根拠: セキュリティ — `redos-detector/no-unsafe-regex: error` で全正規表現を自動検査
- `[MUST]` 動的キーでオブジェクトを操作する際は `__proto__`・`prototype`・`constructor` を明示的にブロックする
  - 根拠: セキュリティ — `_isValidObjectKey` が全オブジェクト系スキーマで使用されテストで攻撃ペイロードの遮断を検証
- `[SHOULD]` 外部入力のオブジェクトはそのまま返さず、ホワイトリスト方式で必要なキーのみを新しいオブジェクトにコピーして再構築する
  - 根拠: セキュリティ — `object` スキーマは空オブジェクトに定義済みキーだけをコピーする再構築パターン
- `[SHOULD]` バリデーションのエラー報告にはリソース上限を設け、デフォルトで早期打ち切りを行う
  - 根拠: セキュリティ — `strictObject` の未知キー検出は最初の1件でループを打ち切り攻撃者のリソース枯渇を防止
- `[AVOID]` 偽陽性の多いセキュリティルールを「念のため」有効にしたまま運用すること。精度の低いルールは無効化し、精度の高い代替ツールに委譲する
  - 根拠: セキュリティ / 開発規約 — `security/detect-unsafe-regex: off` とし `redos-detector` に一本化

## プロジェクト構造と規約

- `[MUST]` 大量の同種モジュールを持つライブラリでは、1機能 = 1フォルダの固定ファイル構成（実装 + テスト + 型テスト + barrel export）を採用し、例外を許容しない
  - 根拠: プロジェクト構造 / コード組織 — 200以上のモジュールすべてが同一の4ファイル構成を遵守
- `[SHOULD]` 内部ユーティリティには命名規約（`_` プレフィックス等）で可視性を表現し、パブリック API との境界を明確にする
  - 根拠: プロジェクト構造 / コード組織 — `_addIssue`, `_stringify` 等と `ValiError`, `isOfKind` 等をプレフィックスで区別
- `[SHOULD]` 型定義のエクスポートは `export *` ではなく名前付き `export type` で公開する型を明示的に選択し、内部型の漏洩を防ぐ
  - 根拠: プロジェクト構造 — 52型を明示的に列挙し `export *` を使うカテゴリと `export type` を使うカテゴリを使い分け
- `[SHOULD]` ESLint の厳格さをパッケージのリスクレベルに応じて段階的に変える（ライブラリコア > サブパッケージ > 内部ツール/ウェブサイト）
  - 根拠: 開発規約 — コアライブラリに7プラグイン、ウェブサイトに2プラグインという段階的構成

## ビルドと CI/CD

- `[MUST]` ライブラリの `package.json` `exports` フィールドでは、各条件（import/require）内で `types` エントリを `default` より前に配置する
  - 根拠: ビルド — TypeScript は `exports` の条件を上から順に評価するため `types` が後だと型解決に失敗する場合がある
- `[MUST]` パブリッシュワークフローでは CI ワークフロー全体の成功を前提条件にする
  - 根拠: CI/CD — `workflow_call` で CI を publish の前段に組み込みテスト未通過でのリリースを防止
- `[SHOULD]` NPM パブリッシュには `--provenance` フラグを付与し、OIDC トークンによるサプライチェーン証明を実装する
  - 根拠: CI/CD — 全NPMパブリッシュジョブが `--provenance --access public` を使用
- `[SHOULD]` npm と JSR の両方に配信するライブラリでは、ソースコードの `.ts` 拡張子付きインポートを採用し、`allowImportingTsExtensions: true` を設定する
  - 根拠: ビルド — JSR はソースの `.ts` ファイルをそのまま配信するため拡張子なしインポートは動作しない
- `[SHOULD]` モノレポの CI 環境セットアップは composite action に集約し、ランタイムセットアップからビルドまでを一括で行う
  - 根拠: CI/CD — 10以上のジョブで再利用しランタイム追加やバージョン変更を一箇所の変更で完結
- `[SHOULD]` CI ワークフローに `workflow_call` トリガーを追加し、他ワークフローから再利用可能にする
  - 根拠: CI/CD — CI の定義を一元化し PR と publish で同一の品質チェックを保証
- `[AVOID]` ライブラリの `package.json` で `main` と `types` のみを指定し `exports` を省略する。Dual Package Hazard を防ぐため `exports` で ESM/CJS を明示的に分離する
  - 根拠: ビルド — `exports` なしでは CJS/ESM の条件分岐ができない

## AI 支援開発

- `[MUST]` AI エージェント向けの指示ファイル（AGENTS.md / CLAUDE.md）は 100 行以内に収める。詳細な手順はタスク別のスキルファイルに分離する
  - 根拠: AI 設定 — AGENTS.md は約60行で6セクションを網羅しタスク別詳細は `skills/` 配下に委譲
- `[MUST]` AI 向けコーディング規約は、対応する Linter ルールで機械的にも強制する。AI が規約に違反するコードを生成した場合のフェイルセーフとなる
  - 根拠: AI 設定 — AGENTS.md の4つの Code Conventions はすべて ESLint ルールで `'error'` レベルで強制

## ルール優先度の解釈

- `[MUST]`: 違反するとバグ・セキュリティリスク・重大な設計劣化を招くルール
- `[SHOULD]`: 従うことで品質が向上するが、文脈によっては例外を許容するルール
- `[AVOID]`: 意図的に避けるべきアンチパターン・非推奨プラクティス
