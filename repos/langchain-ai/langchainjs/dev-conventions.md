# 開発規約・リンティング・CI

> リポジトリ: langchain-ai/langchainjs
> 分析日: 2026-02-20

## 概要

langchainjs は 40 以上のパッケージを擁する大規模 TypeScript monorepo であり、pnpm workspaces + Turborepo で管理されている。開発規約は「共有 ESLint パッケージ (`@langchain/eslint`)」「共有 tsconfig (`@langchain/tsconfig`)」「共有ビルドツール (`@langchain/build`)」の内部パッケージに集約されている。特筆すべきは、`instanceof` の全面禁止とそれを代替する Symbol ベースのブランディングシステム、および `process.env` 直接参照の禁止と環境抽象化ユーティリティの徹底である。CI は機能別に分離された 20 以上のワークフローで構成され、変更ファイルに基づく動的マトリクスで実行範囲を最小化している。

## 背景にある原則

- **マルチランタイム互換性の最優先**: Node.js (ESM/CJS)、Deno、Bun、Cloudflare Workers、ブラウザの全てで動作する必要があるため、`instanceof`（モジュール境界を超えると壊れる）や `process.env`（ブラウザに存在しない）のような環境依存コードを構造的に排除している。根拠: `internal/eslint/src/configs/base.ts` の `no-instanceof/no-instanceof: error` と `no-process-env: error`、`libs/langchain-core/src/utils/env.ts` の `getEnvironmentVariable` 関数。

- **設定の中央集権と一貫性**: 40 以上のパッケージ間で lint ルール・TypeScript 設定・ビルド設定を統一するため、`internal/` 配下の共有パッケージに設定を集約し、各パッケージは 1-3 行の設定ファイルで再利用している。根拠: `libs/providers/langchain-anthropic/eslint.config.ts` が `import { langchainConfig } from "@langchain/eslint"; export default langchainConfig;` の 1 行で済んでいる。

- **変更影響範囲の局所化**: monorepo 内の CI は `paths` フィルタと動的マトリクスを使い、変更されたパッケージのみテストする。Turborepo のタスク依存 (`dependsOn: ["^build:compile"]`) でビルド順序を自動解決し、不要なビルドを省く。根拠: `.github/workflows/unit-tests-integrations.yml` の `prepare-matrix` ジョブ。

- **pre-commit での品質ゲート**: `lint-staged` により、コミット時に prettier フォーマットと ESLint の自動修正が走る。CI ではフォーマットチェックと lint が独立ワークフローとして実行される。根拠: `package.json` の `lint-staged` 設定。

## 実例と分析

### 共有 ESLint 設定の階層構造

`@langchain/eslint` パッケージは設定を `base` / `node` / `browser` / `full` に階層化している。`full` は `base + node` の合成であり、ブラウザ向けパッケージは `base + browser` を使うことができる。各パッケージの `eslint.config.ts` は共有設定をインポートし、必要に応じてパッケージ固有の `ignores` のみを追加する。

テストファイル (`*.test.ts`, `*.test-d.ts`, `*.spec.ts`) には専用のオーバーライドブロックがあり、`no-floating-promises`、`no-misused-promises`、`no-process-env` が緩和されている。これにより、テストコードの記述負荷を下げつつ、プロダクションコードの厳格さを維持している。

### instanceof の禁止と Symbol ブランディング

`eslint-plugin-no-instanceof` で `instanceof` を全面禁止し、代替として `Symbol.for()` ベースのブランディングシステムを `libs/langchain-core/src/utils/namespace.ts` に実装している。`createNamespace` 関数が名前空間を作り、`.brand(BaseClass, marker?)` でシンボルをプロトタイプに刻印し、`static isInstance()` で判定する。これにより、異なるバージョンの同じパッケージが混在する環境（monorepo の依存解決、CDN からの重複ロード等）でも正しく型判定が機能する。

### process.env のラッピング

`no-process-env: error` ルールにより `process.env` の直接参照が禁止される。唯一の例外は `libs/langchain-core/src/utils/env.ts` 内の `getEnvironmentVariable` 関数で、`// eslint-disable-next-line no-process-env` コメントで明示的にオプトアウトしている。この関数は Node.js の `process.env` と Deno の `Deno.env.get` の両方をハンドリングし、try-catch で環境差異を吸収する。

### テスト分類の命名規約

テストは命名パターンで 4 カテゴリに分類され、vitest 設定で include/exclude が自動管理される:

- `*.test.ts` -- ユニットテスト（外部 API 不要）
- `*.int.test.ts` -- 統合テスト（外部 API 必須）
- `*.test-d.ts` -- 型テスト（`expectTypeOf` による型推論検証）
- `*.standard.test.ts` / `*.standard.int.test.ts` -- 標準テストスイート（プロバイダ適合性検証）

vitest 設定ではユニットテスト実行時に `*.int.test.ts` を自動除外し、`--mode int` で統合テストのみ実行するモード切替が行われる。

### CI ワークフローの分離パターン

CI は機能ごとに独立したワークフローファイルに分離されている:

- `ci.yml` -- lint チェック（全 PR）
- `format.yml` -- フォーマットチェック（全 PR）
- `unit-tests-langchain-core.yml` -- core パッケージのユニットテスト（`libs/langchain-core/**` 変更時のみ）
- `unit-tests-langchain.yml` -- langchain パッケージのユニットテスト
- `unit-tests-integrations.yml` -- プロバイダパッケージのユニットテスト（変更パッケージの動的検出）
- `test-exports.yml` -- 環境テスト（ESM/CJS/CF/Vercel/Vite/Bun）
- `platform-compatibility.yml` -- OS 互換性テスト（ubuntu/windows/macos）
- `standard-tests.yml` -- 標準テストスイート（cron スケジュール + 手動）

全ワークフローに `concurrency` 設定があり、同一 PR への連続 push で前の実行がキャンセルされる。

## コード例

```typescript
// internal/eslint/src/configs/base.ts:59-103
// ESLint の中核ルール定義（抜粋）
rules: {
  "@typescript-eslint/no-floating-promises": "error",
  "@typescript-eslint/no-misused-promises": "error",
  "@typescript-eslint/no-explicit-any": "error",
  "no-instanceof/no-instanceof": "error",
  "no-process-env": "error",
  "import/extensions": ["error", "ignorePackages"],
  "no-param-reassign": "error",
  "prefer-template": "error",
  "no-constructor-return": "error",
  "default-case": "error",
}
```

```typescript
// libs/langchain-core/src/utils/namespace.ts:114-163
// Symbol ベースの名前空間ブランディングシステム
export function createNamespace(path: string): Namespace {
  const symbol: symbol = Symbol.for(path);

  return {
    brand<TBase extends Constructor>(Base: TBase, marker?: string) {
      const brandSymbol: symbol = marker
        ? Symbol.for(`${path}.${marker}`)
        : symbol;

      class _Branded extends (Base as any) {
        readonly [brandSymbol] = true as const;

        static isInstance(obj: unknown): boolean {
          return (
            typeof obj === "object"
            && obj !== null
            && brandSymbol in obj
            && (obj as Record<symbol, unknown>)[brandSymbol] === true
          );
        }
      }
      return _Branded as unknown as BrandedClass<TBase>;
    },
    // ...
  };
}
```

```typescript
// libs/langchain-core/src/utils/env.ts:78-93
// 環境変数アクセスのラッパー
export function getEnvironmentVariable(name: string): string | undefined {
  try {
    if (typeof process !== "undefined") {
      // eslint-disable-next-line no-process-env
      return process.env?.[name];
    } else if (isDeno()) {
      return Deno?.env.get(name);
    } else {
      return undefined;
    }
  } catch {
    return undefined;
  }
}
```

```typescript
// libs/langchain-core/src/errors/index.ts:48-57
// Symbol ブランディングを使ったエラークラス定義
export class LangChainError extends ns.brand(Error) {
  readonly name: string = "LangChainError";

  constructor(message?: string) {
    super(message);
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}
```

```yaml
# .github/workflows/unit-tests-integrations.yml:44-46 (抜粋)
# 変更パッケージの動的マトリクス生成
env:
  PACKAGES: "anthropic,aws,azure-cosmosdb,...,yandex"
# changed_files と PACKAGES を照合し、変更があるパッケージのみマトリクスに含める
```

```typescript
// libs/providers/langchain-anthropic/eslint.config.ts:1-3
// プロバイダパッケージの ESLint 設定（共有設定の再利用）
import { langchainConfig } from "@langchain/eslint";

export default langchainConfig;
```

## パターンカタログ

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: プロバイダごとに異なる API 仕様を持つが、テストの構造は共通にしたい
  - 適用条件: 複数の実装が共通のインターフェースを満たす必要がある場合
  - コード例: `internal/standard-tests/README.md` の `ChatModelUnitTests` 基底クラス。各プロバイダが `extends ChatModelUnitTests` してコンストラクタで設定を注入する
  - 注意点: テストメソッドのオーバーライド時に `super` 呼び出しを忘れると標準テストが実行されない

- **Namespace / Symbol Branding パターン** (分類: 構造)
  - 解決する問題: `instanceof` がモジュール境界を越えると失敗する（重複パッケージ、ESM/CJS 混在等）
  - 適用条件: ライブラリが複数バージョン同居するリスクがある場合、または複数ランタイムで動作する場合
  - コード例: `libs/langchain-core/src/utils/namespace.ts:114-163`
  - 注意点: `Symbol.for()` はグローバルレジストリを使うため、名前空間パスの衝突に注意が必要

## Good Patterns

- **共有設定パッケージによる monorepo 一貫性**: `@langchain/eslint`, `@langchain/tsconfig`, `@langchain/build` の 3 パッケージに全パッケージ共通の設定を集約し、各パッケージは 1-3 行のファイルで参照する。設定変更が 1 箇所の修正で全パッケージに波及する。

```typescript
// libs/providers/langchain-anthropic/eslint.config.ts
import { langchainConfig } from "@langchain/eslint";
export default langchainConfig;
```

- **テスト種別の命名規約による自動分類**: ファイル名サフィックスだけでテスト種別を判別し、vitest 設定の include/exclude で自動管理する。CI ワークフローは種別ごとに独立実行できる。

```typescript
// libs/langchain-core/vitest.config.ts:15 (ユニットテスト時に統合テストを除外)
exclude: ["**/*.int.test.ts", ...configDefaults.exclude],
```

- **concurrency + cancel-in-progress による CI 効率化**: 全ワークフローに `concurrency` グループと `cancel-in-progress: true` を設定し、同一ブランチへの連続 push で古い実行を自動キャンセルする。

::: v-pre

```yaml
# .github/workflows/ci.yml:22-24
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

:::

- **lint:dpdm による循環依存検出**: ESLint とは別に `dpdm` (dependency path detector) を lint パイプラインに組み込み、循環依存をビルド前に検出する。

```json
// libs/langchain-core/package.json:21
"lint:dpdm": "dpdm --skip-dynamic-imports circular --exit-code circular:1 --no-warning --no-tree src/*.ts src/**/*.ts"
```

## Anti-Patterns / 注意点

- **eslint-disable の過剰使用**: `process.env` 禁止ルールに対して `// eslint-disable-next-line no-process-env` が 7 箇所にあり、一部はテストユーティリティではなく本番コードに存在する。環境変数アクセスが必要な箇所は `getEnvironmentVariable` に集約すべきだが、レガシーコードに残存している。

```typescript
// Bad: 各所で eslint-disable して process.env を直接参照
// eslint-disable-next-line no-process-env
const key = process.env.MY_KEY;

// Better: 環境変数ユーティリティに一元化
import { getEnvironmentVariable } from "@langchain/core/utils/env";
const key = getEnvironmentVariable("MY_KEY");
```

- **no-param-reassign の eslint-disable 散在**: `no-param-reassign` ルールが error に設定されているにもかかわらず、レガシーパッケージ (`langchain-classic`) を中心に `eslint-disable-next-line no-param-reassign` が複数箇所で使われている。引数のミューテーションは意図せぬ副作用を生むため、新規コードでは避けるべき。

```typescript
// Bad: 関数引数を直接変更
// eslint-disable-next-line no-param-reassign
input = input.trim();

// Better: ローカル変数に代入
const trimmedInput = input.trim();
```

## 導出ルール

- `[MUST]` マルチランタイム対応ライブラリでは `instanceof` を使わず、Symbol ベースの型判定メソッド (`isInstance`) を提供する
  - 根拠: langchainjs は `eslint-plugin-no-instanceof` で全面禁止し、`Symbol.for()` ベースのブランディングで代替している（`internal/eslint/src/configs/base.ts:102`, `libs/langchain-core/src/utils/namespace.ts`）

- `[MUST]` monorepo の共有設定（lint, tsconfig, ビルド）は内部パッケージとして独立管理し、各パッケージは 1-3 行の設定ファイルで参照する
  - 根拠: 40 以上のパッケージが `@langchain/eslint`, `@langchain/tsconfig`, `@langchain/build` を参照し、設定の一貫性を保っている

- `[MUST]` テストファイルは命名規約でカテゴリを区別し（`*.test.ts` / `*.int.test.ts` / `*.test-d.ts`）、テストランナー設定で include/exclude を自動管理する
  - 根拠: vitest 設定でユニットテスト時に `**/*.int.test.ts` を自動除外し、`--mode int` で統合テストのみ実行する仕組みが全パッケージに適用されている

- `[SHOULD]` `process.env` へのアクセスは単一のユーティリティ関数に集約し、lint ルールで直接参照を禁止する
  - 根拠: `no-process-env: error` と `getEnvironmentVariable()` 関数により、Deno / ブラウザなど `process` が存在しない環境でも安全に動作する

- `[SHOULD]` CI ワークフローに `concurrency` + `cancel-in-progress` を設定し、同一ブランチへの連続 push で古い実行を自動キャンセルする
  - 根拠: 全 20 以上のワークフローに <code v-pre>concurrency: { group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true }</code> が設定されている

- `[SHOULD]` monorepo の CI は変更ファイルに基づく動的マトリクスでテスト対象パッケージを絞り込み、不要なビルド・テストを省く
  - 根拠: `unit-tests-integrations.yml` が `git diff` で変更ファイルを検出し、影響パッケージのみマトリクスに含める

- `[SHOULD]` lint パイプラインに循環依存検出ツール（dpdm 等）を組み込み、ビルド前に検出する
  - 根拠: 全パッケージの `lint` スクリプトが `lint:eslint && lint:dpdm` の 2 段構成で循環依存を CI レベルで防いでいる

- `[AVOID]` ESLint の `eslint-disable` コメントを増殖させる -- ルール違反が必要な場合はユーティリティに集約するか、ルール自体を見直す
  - 根拠: `no-process-env` と `no-param-reassign` の disable コメントがレガシーコードに散在しており、技術的負債となっている

## 適用チェックリスト

- [ ] monorepo の場合、ESLint / tsconfig / ビルド設定を内部共有パッケージに集約しているか
- [ ] `instanceof` を使っている箇所がないか確認し、ライブラリ公開コードでは Symbol ベースの型判定に置き換えたか
- [ ] 環境変数アクセスを単一ユーティリティに集約し、lint ルールで `process.env` 直接参照を禁止したか
- [ ] テストファイルの命名規約を定め（unit / integration / type）、テストランナー設定で自動分類しているか
- [ ] CI ワークフローに `concurrency` + `cancel-in-progress` を設定したか
- [ ] monorepo の CI で変更ファイルに基づくテスト対象の絞り込みを実装したか
- [ ] lint パイプラインに循環依存検出を組み込んだか
- [ ] pre-commit フック（lint-staged 等）でフォーマッタと linter を自動実行しているか
- [ ] `eslint-disable` コメントが増殖していないか定期的にレビューしているか
