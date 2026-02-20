# pmndrs/zustand — 導出ルール集

> 出典: repos/pmndrs/zustand/ | 生成日: 2026-02-20
> 用途: CLAUDE.md にそのまま貼り付けて AI コンテキストとして活用

## API 設計

- `[MUST]` subscribe/observe 系の API は cleanup 関数（unsubscribe）を戻り値として返す。コールバック登録解除の責任を呼び出し元に委譲し、`useEffect` や `useSyncExternalStore` との統合を自然にする
  - 根拠: api-design-practices / architecture — `subscribe` が `() => void` を返す設計は React のライフサイクル API と形が一致し、リソースリークを防ぐ
- `[MUST]` 状態変更の等価比較にはデフォルトで最も安価な手段（`Object.is` 等の参照比較）を採用し、shallow/deep/custom 比較は明示的な opt-in で提供する
  - 根拠: design-philosophy / api-design-practices — デフォルトを最も安価にし、`shallow` や `equalityFn` は段階的にオプトインさせる設計が、1,459行で57k stars の要因の一つ
- `[SHOULD]` 拡張機能は高階関数（ミドルウェア/デコレータ）として実装し、コアの API サーフェスを増やさない
  - 根拠: design-philosophy — persist, devtools, immer, subscribeWithSelector はすべて `StateCreator -> StateCreator` の高階関数で、コアの `setState/getState/subscribe` API は一切変更されていない
- `[SHOULD]` API の戻り値を callable + properties のインターセクション型にすることで、関数呼び出しとプロパティアクセスを同時に提供できる
  - 根拠: api-design-practices — `UseBoundStore` は `() => T` と `StoreApi` の交差型で、`useStore()` と `useStore.getState()` を1つのオブジェクトで実現
- `[AVOID]` ライブラリ利用者に型パラメータの全指定を強制する API 設計。カリー化オーバーロードで必要最小限の型指定にとどめる
  - 根拠: api-design-practices — `create<T, Mos>` の全パラメータ指定を避け、`create<T>()(initializer)` で `T` のみ指定し残りを推論させる
- `[AVOID]` デフォルトの動作を複雑にして利便性を高める smart defaults の過剰適用。デフォルトは最も単純・安価な動作にし、高度な機能は明示的 opt-in にする
  - 根拠: design-philosophy — `setState` のデフォルトは shallow merge + `Object.is` 比較。deep merge、deep equality、selector 購読はそれぞれ別途 import が必要

## TypeScript 型設計

- `[MUST]` プラグインシステムの型レジストリには空インターフェース + declaration merging を使い、各プラグインが `declare module` で型変換を登録する
  - 根拠: type-system-patterns / middleware-composition — `StoreMutators` がこのパターンで 6 つのミドルウェア + サードパーティ拡張を型安全に実現
- `[MUST]` タプル型を再帰処理する条件型には、非タプル入力（`number extends T['length']`）を検出して再帰を停止する安全弁を設ける
  - 根拠: type-system-patterns — `Mutate` 型がこのガードを持つことで、ジェネリクス未解決時にも型エラーにならない
- `[MUST]` TypeScript のジェネリクスが不変（invariant）で推論不能な場合、カリー化オーバーロードで「ユーザー指定型」と「推論型」を分離する
  - 根拠: api-design-practices / architecture — `create<T>()(initializer)` は TypeScript#10571 の制約を回避するランタイムコストゼロの手法
- `[SHOULD]` 複雑なジェネリクスを持つ関数は、実装用の簡素な型（`XxxImpl`）と公開用のフルジェネリクス型を分離し、`as unknown as PublicType` でキャストする
  - 根拠: type-system-patterns / middleware-composition — 全ミドルウェアがこの二重構造を採用し、実装の型推論安定性と公開 API の型安全性を両立
- `[SHOULD]` オブジェクト型のプロパティを上書きする場合は `type Write<T, U> = Omit<T, keyof U> & U` を使い、交差型 `T & U` を避ける
  - 根拠: type-system-patterns — 交差型では同名プロパティが intersection になるが、`Write` なら完全な上書きが保証される
- `[SHOULD]` オーバーロード関数型はインターフェースのメソッドとして定義し、インデックスアクセス `['methodName']` で抽出する
  - 根拠: type-system-patterns — `SetStateInternal` が `{ _(...): void; _(...): void }['_']` パターンを使用し、安定した推論を実現
- `[SHOULD]` 型推論にのみ必要で実行時に不要な情報は、ファントムプロパティ（optional + 未使用の型パラメータ）として保持する
  - 根拠: type-system-patterns — `StateCreator` の `$$storeMutators?: Mos` が出力ミドルウェア型リストを型レベルでのみ伝播
- `[SHOULD]` ライブラリの最低 TypeScript バージョン要件は `typesVersions` でゲートし、非対応バージョンには意味のあるエラーメッセージを返す
  - 根拠: type-system-patterns / build-and-tooling — TS 4.5 未満で空の d.ts にリダイレクトし、CI で 15 バージョンのマトリクステスト実施
- `[AVOID]` 型ユーティリティを共通モジュールに集約してプラグイン間の依存を作ること。各プラグインが同一の小さな型ユーティリティを独立して定義する方が、モジュールの自己完結性と tree-shaking 効率が向上する
  - 根拠: type-system-patterns — `Write` 型が 6 ファイルで独立定義されており、ミドルウェア間に import 依存がない

## ミドルウェア / プラグイン設計

- `[MUST]` すべてのミドルウェアが同一のシグネチャ（入力型と出力型の変換関数）に従うよう統一する
  - 根拠: middleware-composition — 全 7 ミドルウェアが `(config, options?) => (set, get, api) => result` を遵守し、任意の組み合わせ・順序での合成が可能
- `[MUST]` 外部依存（ブラウザ API、DevTools、ストレージ等）に依存するミドルウェアは、依存が利用不可の場合に元の処理をそのまま返すフォールバックパスを必ず用意する
  - 根拠: middleware-composition — devtools は `if (!extensionConnector) return fn(set, get, api)`、persist は `if (!storage) return config(...)` でグレースフルデグラデーション
- `[SHOULD]` API メソッドをラップする際は、元のメソッドを局所変数に保存してからラップ関数内で呼び出す（save-and-restore パターン）
  - 根拠: middleware-composition / persistence-patterns — `const savedSetState = api.setState` パターンが persist/devtools/immer/subscribeWithSelector で一貫
- `[AVOID]` ミドルウェアの内部で他のミドルウェアの存在を前提としたコードを書くこと。各ミドルウェアは公開 API 面のみに依存し、単独でも動作すべき
  - 根拠: middleware-composition — 各ミドルウェアは互いに import せず、単独利用・組み合わせ利用の両方をテストしている

## 非同期処理とレース条件

- `[MUST]` 同期/非同期両方をサポートする永続化層では、同期パスでマイクロタスク遅延を発生させないラッパーを使う（`Promise.resolve()` で統一しない）
  - 根拠: persistence-patterns — `toThenable` は同期ストレージ使用時に同一ティックで処理完了させ、初期レンダリングで正しい値を返す
- `[SHOULD]` 並行して発生しうる非同期操作の制御には、インクリメンタルカウンタによる Last-Write-Wins を検討する
  - 根拠: persistence-patterns — `hydrationVersion` は 1 変数で並行 rehydrate のレース条件を防止。AbortController やロック機構より実装コストが低い
- `[SHOULD]` SSR 環境で参照不可能なブラウザ API（localStorage 等）はファクトリ関数で遅延評価し、例外時は機能を無効化して graceful に動作させる
  - 根拠: persistence-patterns — `createJSONStorage(() => window.localStorage)` と `try-catch` による `undefined` 返却

## パッケージングとビルド

- `[MUST]` CJS/ESM デュアルパッケージでは、`exports` の各条件に `types` フィールドを `default` より前に配置する
  - 根拠: project-structure — TypeScript は `exports` 内の条件を上から順に評価する。`types` が後にあると型解決が誤る場合がある
- `[MUST]` 独立してビルドされるサブパスエクスポート間の import は、ビルド時にパッケージ名（自己参照）に書き換える
  - 根拠: project-structure — 相対パスのままビルドするとバンドラーが依存をインライン化し、同一コードが複数チャンクに重複する
- `[MUST]` ソースコード内の環境判定は単一の記法に統一し、CJS/ESM ごとの差異はビルド時の置換で吸収する
  - 根拠: build-and-tooling — ソースは `import.meta.env?.MODE` に統一し、Rollup の replace プラグインが環境ごとに置換
- `[MUST]` ビルド成果物に対して、ソースコードと同じテストスイートを実行する CI を構築する
  - 根拠: build-and-tooling / project-structure — ソースのテスト通過はビルド成果物の正常性を保証しない。CJS/ESM 双方に対してテスト実行
- `[SHOULD]` ライブラリの publish は `dist/` ディレクトリをルートとして行い、クリーンなインポートパスを提供する
  - 根拠: project-structure / build-and-tooling — `npm publish` を `working-directory: dist` で実行し、`zustand/middleware` のようなパスを実現
- `[SHOULD]` フレームワーク非依存のコアとフレームワーク固有のバインディングは別サブパスに分離し、フレームワークを optional peerDependency にする
  - 根拠: project-structure / architecture — `vanilla`（コア）と `react`（バインディング）を分離し、React なし環境でもコアを利用可能に
- `[SHOULD]` `package.json` に `"sideEffects": false` を明示し、bundler が安全に tree-shaking できることを宣言する
  - 根拠: build-and-tooling / design-philosophy — 未使用モジュール（middleware 等）がバンドルに含まれないことを保証
- `[SHOULD]` PR ごとにバンドルサイズを自動計測し、サイズ回帰を可視化する CI を導入する
  - 根拠: build-and-tooling / dev-conventions — `compressed-size-action` で `dist/**/*.{js,mjs}` のサイズを PR コメントに表示
- `[SHOULD]` ESM 用の型定義ファイルは `.d.mts` 拡張子で提供し、内部 import パスの拡張子も `.mjs` に統一する
  - 根拠: project-structure — `.mjs` ファイルに対して `.d.mts` を探索するため、`.d.ts` のみだと ESM 条件で型解決に失敗する場合がある
- `[AVOID]` `package.json` の `scripts` フィールドにインラインの複雑なシェルコマンドや Node.js ワンライナーを記述する。5行を超えるスクリプトは外部ファイルに分離すべき
  - 根拠: project-structure / build-and-tooling — `patch-d-ts` 等が 1 行に圧縮されたスクリプトで、可読性・保守性が低い

## テスト戦略

- `[MUST]` 状態管理のテストでは、各テストケース内でストアを新規生成してテスト間の状態汚染を防ぐ
  - 根拠: testing-practices — 全テストファイルでストアをテスト内またはファクトリ関数で生成し、フレーキーテストを排除
- `[MUST]` 非同期ストレージのテストでは fake timer を使い、テスト側からタイミングを制御する
  - 根拠: testing-practices — `vi.useFakeTimers()` + `sleep(10)` + `vi.advanceTimersByTimeAsync(10)` で非同期処理を決定的にテスト
- `[SHOULD]` ライブラリの公開型テストは `expectTypeOf` と `@ts-expect-error` を組み合わせて、「正しい型が推論される」と「不正な型が拒否される」の両面を検証する
  - 根拠: testing-practices — `middlewareTypes.test.tsx` と `types.test.tsx` で型安全性を多角的に保証
- `[SHOULD]` CI でのマルチバージョン互換テストは `fail-fast: false` を設定し、1 つの失敗が他のバージョンの結果を隠さないようにする
  - 根拠: testing-practices / dev-conventions — TS 15 版、React 9 版、CJS/ESM 2 形式の全マトリクスで適用
- `[SHOULD]` テストファイルの import はパッケージ名（公開 API）で行い、vitest alias でソースにマッピングする
  - 根拠: dev-conventions — テストが利用者と同じ import パスを使う設計にすることで、公開 API のテストになる
- `[AVOID]` `console.error` の手動退避・復元パターン。代わりに `vi.spyOn(console, 'error')` を使い、テストフレームワークの自動復元機構に頼る
  - 根拠: testing-practices — 手動退避は復元忘れのリスクがある。`vi.spyOn` の方が安全

## CI と開発規約

- `[MUST]` CI の品質ゲートは「軽いチェックから順に直列実行」する（format → types → lint → test → build）
  - 根拠: dev-conventions — 最も軽いチェックから失敗させることで CI 時間を最小化
- `[MUST]` GitHub Actions のサードパーティ Action はコミットハッシュでピン留めし、バージョンをコメントで付記する
  - 根拠: dev-conventions — 全 8 ワークフローで `@<commit-hash> # v<version>` 形式を一貫して使用し、サプライチェーン攻撃を防止
- `[MUST]` ESLint flat config ではテストファイル用ルールを `files` グロブで分離し、ソースコードの lint ルールと混在させない
  - 根拠: dev-conventions — testing-library / jest-dom / vitest プラグインと import ルールのオーバーライドをテストファイル限定で適用
- `[SHOULD]` pnpm の `minimumReleaseAge` を設定し、新規公開パッケージの即時利用を防ぐ（推奨: 1440 = 24 時間）
  - 根拠: dev-conventions — malicious package が公開直後にインストールされるリスクを低減
- `[SHOULD]` ライブラリの CI には対応バージョンのマトリクステストを含め、互換性を自動証明する
  - 根拠: dev-conventions / testing-practices — TS 15 版、React 9 版、CJS/ESM 2 形式の互換性を CI マトリクスで検証
- `[AVOID]` アプリケーションコードで `@typescript-eslint/no-explicit-any: 'off'` をプロジェクト全体に適用する。必要な場合はファイル単位で緩和すべき
  - 根拠: dev-conventions — ライブラリ特有の高度な型操作のためにオフにしているが、一般のアプリケーションでは型安全性の低下につながる

## 永続化設計

- `[MUST]` 永続化対象の状態スキーマを変更する場合は、バージョン番号のインクリメントとマイグレーション関数をセットで提供する
  - 根拠: persistence-patterns — マイグレーション関数なしにバージョンが不一致だと保存データを無視し、ユーザーデータが事実上消失する
- `[SHOULD]` ネストされたオブジェクトを永続化する場合はカスタム merge 関数で deep merge を使う。デフォルトの shallow merge はネストされたフィールドを消失させる
  - 根拠: persistence-patterns — zustand ドキュメントが `@fastify/deepmerge` の使用例を明示的に示している
- `[AVOID]` 永続化対象に関数やシリアライズ不可能な値を含める。`partialize` で明示的にフィルタするか、`replacer`/`reviver` でカスタムシリアライズする
  - 根拠: persistence-patterns — テストで `partialize` や `merge` で関数を除外するパターンが繰り返し使われている

## ルール優先度の解釈

- `[MUST]`: 違反するとバグ・セキュリティリスク・重大な設計劣化を招くルール
- `[SHOULD]`: 従うことで品質が向上するが、文脈によっては例外を許容するルール
- `[AVOID]`: 意図的に避けるべきアンチパターン・非推奨プラクティス
