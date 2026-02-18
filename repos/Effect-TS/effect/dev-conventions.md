# 開発規約とワークフロー

> リポジトリ: Effect-TS/effect
> 分析日: 2026-02-18

## 概要

Effect-TS/effect は 30 以上のパッケージを擁する大規模 TypeScript モノレポであり、ESLint + dprint 統合によるフォーマッティング、changeset によるバージョニング、循環依存検出、JSDoc コード例の自動コンパイルチェック、型テスト（tstyche）、jscodeshift によるコードモッドなど、多層的な品質ゲートを CI に組み込んでいる。AGENTS.md による AI エージェント向け開発ガイドの整備も特徴的で、自動化と一貫性のバランスが高い水準で実現されている。

## 背景にある原則

- **フォーマッティングは lint に統合し、ツール数を最小化する**: dprint を ESLint プラグイン（`@effect/eslint-plugin`）経由で実行することで、フォーマッターと lint を `pnpm lint-fix` の単一コマンドに統合している。Prettier を別途実行する必要がなく、CI でも lint ジョブだけでフォーマットチェックが完了する（`eslint.config.mjs:128-141`）。

- **barrel ファイルはコード生成物として扱い、手動編集を禁止する**: `index.ts`（barrel ファイル）を `build-utils prepare-v3` で自動生成し、CI の lint ジョブで `pnpm codegen && git diff --exit-code` を実行して差分が無いことを検証する。これにより、エクスポートの追加漏れや不整合を防止している（`.github/workflows/check.yml:36-39`）。

- **型の正しさを多層で保証する**: 通常の `tsc -b` による型チェック（`pnpm check`）に加え、tstyche による型テスト（`dtslint/*.tst.ts`）、TypeScript nightly ビルドによる日次型チェック（`ts-nightly.yml`）の 3 層構成で型安全性を担保している。

- **パッケージ内部は直接モジュールインポート、barrel インポートを禁止する**: `@effect/no-import-from-barrel-package` ESLint ルールにより、`src/` 内のコードが自パッケージの barrel（例: `from "effect"`）からインポートすることを禁止し、`from "./Module.js"` の直接パスを強制する。これはツリーシェイキングの確実性と循環依存防止のためである（`eslint.config.mjs:151-159`）。

## 実例と分析

### ESLint 設定: dprint 統合とカスタムルール

ESLint flat config で `@effect/eslint-plugin` の `configs.dprint` を展開し、dprint をフォーマッターとして ESLint 経由で実行している。dprint の設定は ESLint ルール `@effect/dprint` のオプションとしてインラインで記述されている。

主要な設定値:

- `semiColons: "asi"` — セミコロンなし
- `quoteStyle: "alwaysDouble"` — ダブルクォート
- `trailingCommas: "never"` — 末尾カンマなし
- `lineWidth: 120`
- `arrowFunction.useParentheses: "force"` — アロー関数の括弧を強制

カスタムルールとして注目すべきもの:

- `no-restricted-syntax` で `Array.push` にスプレッド引数を禁止（パフォーマンス上の理由）
- `@typescript-eslint/array-type` で `Array<T>` の generic 記法を強制（`T[]` を禁止）
- `sort-destructure-keys` で分割代入のキーをソート強制
- `@typescript-eslint/consistent-type-imports` で型インポートを `type` 修飾子付きに統一
- `no-console` を `src/` と `test/` に限定適用

### Changeset 運用と pnpm パッチ

changeset は `@changesets/changelog-github` で GitHub PR リンク付きの CHANGELOG を生成する。注目すべきは `@changesets/assemble-release-plan` にパッチを当て、peer dependency の破壊的変更時の自動バージョンバンプを `major` から `minor` に変更している点。これはモノレポ内のパッケージ間依存で不要な major バンプの連鎖を防止する実践的な工夫である。

リリースフローは `changeset-version`（バージョン更新 + `scripts/version.mjs` で内部バージョン定数を同期）と `changeset-publish`（codemod → build → test → publish）の 2 段階で構成される。

### CI/CD パイプライン

6 つの GitHub Actions ワークフローが連携する:

1. **check.yml** — PR/push で型チェック + 型テスト + lint + 循環依存チェック + codegen 差分検証 + テスト（4 シャードで並列実行）
2. **release.yml** — main push で changesets/action による Release PR 作成またはパブリッシュ
3. **snapshot.yml** — PR ごとに `pkg-pr-new` でスナップショットパッケージを公開し、PR からインストール可能にする
4. **pages.yml** — docgen による API ドキュメント生成と GitHub Pages デプロイ
5. **ts-nightly.yml** — 日次 cron で TypeScript nightly に対する型テストを実行、失敗時に Issue を自動作成
6. **release-queue.yml** — `next-release-action` によるリリースキュー管理

共通セットアップは `.github/actions/setup` composite action に集約し、Node.js バージョン・pnpm キャッシュを一元管理している。

### Nix による開発環境の宣言的管理

`flake.nix` で Node.js 24、Bun、Deno、Python3、corepack などの開発ツールを宣言的に管理している。`direnv allow` と組み合わせることで、ディレクトリに入るだけで正しい開発環境がセットアップされる。

### AGENTS.md と scratchpad パターン

AGENTS.md は AI コーディングエージェント向けの指示書として機能し、以下の規約を明文化している:

- `pnpm lint-fix` → `pnpm test run <file>` → `pnpm check` → `pnpm build` → `pnpm docgen` の検証フロー
- barrel ファイル手動編集禁止、`pnpm codegen` で再生成
- `it.effect` テストパターンの使用指示
- `scratchpad/` ディレクトリでの実験用コード配置（workspace メンバーとして全パッケージを依存に持つ）

### ビルドパイプライン: ESM + CJS デュアル出力

各パッケージのビルドは以下の 4 段階:

1. `build-esm` — `tsc -b` で ESM 出力
2. `build-annotate` — babel で `annotate-pure-calls` プラグインにより純粋関数呼び出しに `/*#__PURE__*/` アノテーション付与
3. `build-cjs` — babel で ESM → CJS 変換
4. `build-utils pack-v3` — `dist/` ディレクトリへのパッケージング

### 循環依存の自動検出

`scripts/circular.mjs` で `madge` を使い、`packages/*/src/**/*.ts` を対象に循環依存を検出する。型インポート（`import type`）はスキップする設定で、値レベルの循環のみを検出する。CI の lint ジョブで実行され、循環が見つかると exit code 1 で失敗する。

### コードモッドによる大規模リファクタリング

`scripts/codemods/` に jscodeshift ベースのコードモッドを配置:

- `jsdoc.ts` — エクスポートされた変数宣言の JSDoc コメントを型シグネチャにコピーする（`dual` 関数の型パラメータにも対応）
- `ts-fence.ts` — JSDoc の `@example` に TypeScript コードフェンスを自動追加

これらは `pnpm codemod` で実行され、リリース前パイプライン（`changeset-publish`）にも組み込まれている。

## コード例

```typescript
// eslint.config.mjs:72-79
"no-restricted-syntax": [
  "error",
  {
    selector:
      "CallExpression[callee.property.name='push'] > SpreadElement.arguments",
    message: "Do not use spread arguments in Array.push"
  }
]
```

```typescript
// eslint.config.mjs:148-159
{
  files: ["packages/*/src/**/*"],
  rules: {
    "@effect/no-import-from-barrel-package": [
      "error",
      {
        packageNames: ["effect", "@effect/platform", "@effect/sql"]
      }
    ]
  }
}
```

```typescript
// vitest.shared.ts:1-23
import * as path from "node:path";
import type { ViteUserConfig } from "vitest/config";

const config: ViteUserConfig = {
  esbuild: {
    target: "es2020",
  },
  test: {
    setupFiles: [path.join(__dirname, "vitest.setup.ts")],
    fakeTimers: {
      toFake: undefined,
    },
    sequence: {
      concurrent: true,
    },
    include: ["test/**/*.test.ts"],
  },
};

export default config;
```

```yaml
# .github/workflows/check.yml:36-39
- run: pnpm codegen
- name: Check for codegen changes
  run: git diff --exit-code
```

```typescript
// packages/effect/test/Array.test.ts:1-14
import { describe, it } from "@effect/vitest";
import { assertNone, assertSome, deepStrictEqual, strictEqual, throws } from "@effect/vitest/utils";
import {
  Array as Arr,
  Either,
  FastCheck as fc,
  identity,
  Number as Num,
  Option,
  Order,
  pipe,
  type Predicate,
  String as Str,
} from "effect";
```

```typescript
// packages/effect/dtslint/Effect.tst.ts:6
import { describe, expect, it, when } from "tstyche";
// ...
it("array", () => {
  expect(Effect.forEach(strings, (a, i) => {
    expect(a).type.toBe<string>();
    return string;
  })).type.toBe<Effect.Effect<Array<string>, "err-1", "dep-1">>();
});
```

## パターンカタログ

- **Composite Action パターン** (分類: 構造)
  - 解決する問題: CI ワークフロー間でのセットアップ手順の重複
  - 適用条件: 複数のワークフローが同一の環境セットアップを必要とする場合
  - コード例: `.github/actions/setup/action.yml`
  - 注意点: composite action 内ではシェルの指定が必須（`shell: bash`）

- **Codegen Guard パターン** (分類: 振る舞い)
  - 解決する問題: 自動生成ファイルの手動編集による不整合
  - 適用条件: コード生成物がリポジトリにコミットされている場合
  - コード例: `.github/workflows/check.yml:36-39`（`pnpm codegen && git diff --exit-code`）
  - 注意点: 生成コマンドが冪等であることが前提

## Good Patterns

- **dprint を ESLint プラグインとして統合**: フォーマッターと lint を単一の `pnpm lint-fix` に集約。開発者が覚えるコマンドが 1 つで済み、CI パイプラインも簡素化される。Prettier + ESLint の競合問題も回避できる。

- **TypeScript nightly に対する日次型テスト**: `ts-nightly.yml` で TypeScript の次期バージョンに対して型テストを毎日実行し、失敗時に Issue を自動作成する。TypeScript のアップデートで型推論が壊れるリスクを早期に検出できる。

```yaml
# .github/workflows/ts-nightly.yml:20-21
- name: Run type tests
  run: pnpm test-types --target next
```

- **scratchpad ワークスペース**: `scratchpad/` をモノレポの workspace メンバーとし、全パッケージを依存に持たせることで、手動テストやデバッグ用のスクリプトをすべてのパッケージに対して即座に書ける。使い終わったら削除するルールにより、リポジトリの汚染を防ぐ。

- **changeset パッチによるバージョンバンプ制御**: `@changesets/assemble-release-plan` にパッチを当て、peer dependency の破壊的変更による自動 major バンプを minor に変更。モノレポで不要なバージョンバンプの連鎖を抑制する実用的手法。

```diff
# patches/@changesets__assemble-release-plan.patch
-            type = "major";
+            type = "minor";
```

- **`annotate-pure-calls` による tree-shaking 最適化**: ビルド時に babel プラグインで純粋関数呼び出しに `/*#__PURE__*/` を付与し、バンドラーが副作用の無い呼び出しを除去できるようにする。ライブラリのバンドルサイズ削減に直結する。

## Anti-Patterns / 注意点

- **`Array.push(...spread)` の使用**: スプレッド引数を `Array.push` に渡すと、大きな配列で `Maximum call stack size exceeded` エラーが発生する可能性がある。ESLint の `no-restricted-syntax` で CI レベルで禁止している。

```typescript
// Bad
arr.push(...otherArray);

// Better
for (const item of otherArray) {
  arr.push(item);
}
// or
Array.prototype.push.apply(arr, otherArray);
```

- **barrel ファイル経由の内部インポート**: ライブラリの `src/` 内から自パッケージの barrel（`from "effect"`）をインポートすると、循環依存やバンドルサイズの肥大化を招く。`@effect/no-import-from-barrel-package` で禁止し、直接パス（`from "./Module.js"`）を強制する。

```typescript
// Bad (src/ 内)
import { Effect } from "effect";

// Better (src/ 内)
import * as Effect from "./Effect.js";
```

## 導出ルール

- `[MUST]` CI でコード生成物の差分チェック（`codegen && git diff --exit-code`）を実行し、自動生成ファイルの手動編集を検出する
  - 根拠: Effect-TS は barrel ファイルを自動生成し、CI で差分がないことを検証することで、エクスポートの不整合を防止している（`.github/workflows/check.yml:36-39`）

- `[MUST]` ライブラリの `src/` 内では自パッケージの barrel（index.ts）からインポートせず、直接モジュールパスを使用する
  - 根拠: `@effect/no-import-from-barrel-package` ESLint ルールで強制されており、循環依存防止とツリーシェイキングの確実性を保証している（`eslint.config.mjs:151-159`）

- `[MUST]` モノレポの全 PR に changeset ファイルを含め、バージョニングと CHANGELOG 生成を自動化する
  - 根拠: AGENTS.md で全 PR に changeset を要求しており、`changeset-version` → `changeset-publish` のパイプラインで一貫したリリースフローを実現している

- `[SHOULD]` フォーマッターを ESLint プラグインとして統合し、lint とフォーマットを単一コマンドで完結させる
  - 根拠: dprint を `@effect/eslint-plugin` 経由で ESLint ルールとして実行し、`pnpm lint-fix` だけで全スタイル修正が完了する設計（`eslint.config.mjs:128-141`）

- `[SHOULD]` 型テストを tstyche 等の専用ツールで記述し、型推論の正しさを回帰テストとして維持する
  - 根拠: Effect-TS は `dtslint/*.tst.ts` で `expect(expr).type.toBe<Type>()` 形式の型テストを 60 以上のファイルで運用し、TypeScript nightly に対しても日次で検証している

- `[SHOULD]` テスト実行を CI で並列シャーディングし、フィードバックループを短縮する
  - 根拠: <code v-pre>`pnpm vitest --shard ${{ matrix.shard }}`</code> で 4 シャード並列実行し、10 分のタイムアウト内で完了させている（`.github/workflows/check.yml:47-61`）

- `[SHOULD]` 循環依存の検出を CI に組み込み、値レベルの循環のみを対象とする（型インポートは除外）
  - 根拠: `madge` で `skipTypeImports: true` を設定し、TypeScript の `import type` は循環依存検出から除外している（`scripts/circular.mjs:13-15`）

- `[SHOULD]` ライブラリビルド時に純粋関数呼び出しへの `/*#__PURE__*/` アノテーションを自動付与し、tree-shaking を最適化する
  - 根拠: `babel-plugin-annotate-pure-calls` を全パッケージの `build-annotate` ステップで使用している

- `[AVOID]` `Array.push` にスプレッド引数を使用すること — 大きな配列でスタックオーバーフローの原因となる
  - 根拠: ESLint の `no-restricted-syntax` で AST セレクタ `CallExpression[callee.property.name='push'] > SpreadElement.arguments` により CI で禁止している（`eslint.config.mjs:72-79`）

- `[AVOID]` barrel ファイル（index.ts）の手動編集 — 自動生成との不整合を招く
  - 根拠: AGENTS.md で明示的に禁止され、CI で `git diff --exit-code` により差分チェックされている

## 適用チェックリスト

- [ ] フォーマッターと lint を単一コマンドに統合しているか（dprint + ESLint プラグイン、または Prettier + eslint-plugin-prettier 等）
- [ ] コード生成物（barrel ファイル、型定義等）の手動編集を CI で検出する仕組みがあるか
- [ ] モノレポの場合、changeset 等でバージョニングと CHANGELOG 生成を自動化しているか
- [ ] ライブラリの `src/` 内で barrel インポートを禁止する ESLint ルールを設定しているか
- [ ] 循環依存の検出ツール（madge 等）を CI に組み込んでいるか
- [ ] 型テスト（tstyche, tsd 等）で型推論の回帰テストを実施しているか
- [ ] TypeScript の次期バージョンに対する定期的な型チェックを実施しているか
- [ ] テストの並列シャーディングで CI フィードバックを短縮しているか
- [ ] ビルド時に `/*#__PURE__*/` アノテーションでツリーシェイキングを最適化しているか
- [ ] AI エージェント向けの開発ガイド（AGENTS.md 等）で検証フローとコード規約を明文化しているか
- [ ] 実験用の scratchpad ディレクトリ等、一時的なコード実行環境を用意しているか
- [ ] Nix flake 等で開発環境を宣言的に管理しているか
