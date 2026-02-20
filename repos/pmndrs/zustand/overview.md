# pmndrs/zustand

> URL: https://github.com/pmndrs/zustand
> Stars: 57k | 言語: TypeScript | ライセンス: MIT | 分析日: 2026-02-20

## サマリー

zustand は「状態管理に本当に必要なものは何か」を問い直し、Set + Object.is + クロージャだけで成立する約100行のフレームワーク非依存コアに、薄い React バインディングと高階関数ミドルウェアを積層するミニマリスト設計を貫いている。特に、TypeScript の declaration merging と再帰型 `Mutate` を活用した型安全なプラグインシステム、カリー化オーバーロードによる型推論限界の迂回、CJS/ESM デュアルビルドの精緻なパッケージング戦略は、状態管理に限らずあらゆるライブラリ設計に応用可能なプラクティスの宝庫である。

## 技術スタック

- **言語**: TypeScript (strict + isolatedDeclarations + exactOptionalPropertyTypes)
- **フレームワーク**: React（peerDependency、optional）
- **ビルド**: Rollup + rollup-plugin-esbuild (CJS/ESM デュアルビルド)
- **テスト**: Vitest + jsdom + @testing-library/react
- **リンター/フォーマッター**: ESLint (flat config) + Prettier
- **パッケージマネージャ**: pnpm 10 (minimumReleaseAge: 1440)
- **CI**: GitHub Actions (TS 4.5-5.9 マトリクス、React 18-19 マトリクス、compressed-size)

## 分析した視点

| # | 視点 | ファイル | 概要 |
| - | ---- | -------- | ---- |
| 1 | プロジェクト構造 | project-structure.md | サブパスエクスポートごとの独立ビルド、dist publish、CJS/ESM デュアルパッケージの多層パッケージング戦略 |
| 2 | アーキテクチャ | architecture.md | vanilla コア→React アダプタ→ミドルウェアの3層分離と、declare module + Mutate 再帰型による型安全な合成 |
| 3 | 設計哲学 | design-philosophy.md | Set+Object.is+クロージャによる極限ミニマリズムと、opt-in 段階的複雑化の設計哲学 |
| 4 | 型システムパターン | type-system-patterns.md | 空インターフェース+declaration merging による型レジストリと、再帰型・ファントム型を駆使したプラグイン型合成 |
| 5 | ミドルウェア合成 | middleware-composition.md | 統一シグネチャの高階関数による api メソッドラップと、グレースフルデグラデーション付きミドルウェア合成 |
| 6 | テスト戦略 | testing-practices.md | テスト内ストア生成による完全分離、型テスト二刀流、TS15版×React9版×CJS/ESM の CI マトリクス戦略 |
| 7 | API 設計 | api-design-practices.md | カリー化オーバーロードで型推論限界を迂回し、selector + equality fn の3段階で変更検知を最適化する API 設計 |
| 8 | ビルドとツーリング | build-and-tooling.md | Rollup モジュール別ビルド、postbuild d.ts パッチチェーン、compressed-size CI、dist からの publish 戦略 |
| 9 | 永続化パターン | persistence-patterns.md | toThenable による同期/非同期透過統一、hydrationVersion カウンタのレース条件防止、SSR 対応の永続化設計 |
| 10 | 開発規約 | dev-conventions.md | ESLint flat config レイヤー設計、品質ゲート直列 CI、Actions ハッシュピン留め、minimumReleaseAge による安全策 |

## 特に注目すべき知見

- **declaration merging + 再帰型によるプラグイン型合成**: 空の `StoreMutators` インターフェースを各ミドルウェアが `declare module` で拡張し、`Mutate<S, Ms>` 再帰型がミドルウェアチェーンを型レベルで順次変換する。コア側のコード変更なしにサードパーティが型安全なプラグインを追加できる、汎用的なプラグインシステム設計パターン。

- **toThenable による同期/非同期の透過的統一**: `Promise.resolve()` で統一すると同期ストレージでもマイクロタスク遅延が発生する問題を、カスタム Thenable で解決。同期パスでは同一ティック内でチェーンが完了し、非同期パスでは Promise をそのまま返す。同期/非同期の両方をサポートする API 設計全般に応用できる。

- **カリー化オーバーロードによる部分的型パラメータ推論**: TypeScript が部分的な型パラメータ推論をサポートしない制約に対し、`create<T>()(initializer)` という2段呼び出しで `T` をユーザーが指定し残りを推論させる。ランタイムコストゼロの型レベルワークアラウンドとして、ジェネリクスが複雑なファクトリ関数全般に適用可能。

- **インクリメンタルカウンタによるレース条件防止**: 並行する非同期操作の制御に `AbortController` やロック機構ではなく、単一の数値カウンタで Last-Write-Wins を実現。各 `then` チェーン内でバージョン比較するだけの最小実装で、persist ミドルウェアの concurrent rehydrate 問題を解決している。

- **ビルド成果物に対する同一テストスイートの再実行**: ソースコードのテスト通過はビルド成果物の正常性を保証しない。zustand は vitest のエイリアスを差し替え、CJS/ESM 各ビルド出力に対して同一テストスイートを実行する CI を構築し、import パス変換やモジュール解決の問題を検出している。

## クイックリファレンス

- [導出ルール集](rules.md) — CLAUDE.md に貼れる形式の全ルール
