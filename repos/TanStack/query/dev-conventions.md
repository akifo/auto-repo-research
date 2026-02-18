# dev-conventions

> リポジトリ: TanStack/query
> 分析日: 2026-02-17

## 概要

TanStack Query のコーディング規約・リンター設定・命名規則・開発ワークフローを横断的に分析した。29 パッケージを擁する大規模モノレポでありながら、シンボリックリンクによる設定共有、ESLint 9 flat config + cspell スペルチェック、Nx によるタスクオーケストレーション、Changesets によるリリース管理を組み合わせ、高い一貫性と開発効率を両立している。特に注目すべきは、TypeScript の strict モードに加え TS 5.0〜5.8 の 9 バージョンでの型テスト、publint + attw によるパッケージ品質検証、knip + sherif による dead code とモノレポ整合性の自動検出という多層的な品質ゲートの設計である。

## 背景にある原則

- **設定は一箇所で定義し、シンボリックリンクで配布する**: 各パッケージの `root.eslint.config.js` や `root.tsup.config.js` はルートへのシンボリックリンクである。設定のドリフトを構造的に不可能にすることで、パッケージ間の一貫性を保証している（`packages/query-core/root.eslint.config.js -> ../../eslint.config.js`）。knip の `ignoreWorkspaces` でサンプル・インテグレーションを除外するなど、検証対象の適切なスコーピングもこの原則の一部。

- **型安全性は「最新だけ」でなく「過去バージョンとの互換」まで保証する**: `test:types` スクリプトが TS 5.0〜5.8 の 9 バージョンで型チェックを実行する。ライブラリの利用者が古い TS を使っていても型が壊れないことを CI で保証している（`packages/query-core/package.json` の `test:types:ts50`〜`test:types:tscurrent`）。

- **パッケージ品質は公開前に機械的に検証する**: `test:build` が `publint --strict && attw --pack` を実行し、package.json の exports フィールドの正しさと型解決の互換性を検証する。これにより「ビルドは通るが import で壊れる」という問題を事前に防ぐ。

- **開発者体験の検証コストを最小化する**: Nx のキャッシュと `affected` コマンドにより、PR では変更に影響するパッケージのみテストを実行する（`test:pr` vs `test:ci`）。CI の全テストは main ブランチでのみ実行し、PR では影響範囲に限定する設計。

## 実例と分析

### ESLint 9 flat config の階層設計

ルートの `eslint.config.js` が全パッケージ共通のベース設定を提供し、各パッケージがそれをインポートして拡張する。

```typescript
// eslint.config.js:1-64 (ルート)
import { tanstackConfig } from '@tanstack/eslint-config'
import pluginCspell from '@cspell/eslint-plugin'
import vitest from '@vitest/eslint-plugin'

export default [
  ...tanstackConfig,
  {
    name: 'tanstack/temp',
    plugins: { cspell: pluginCspell },
    rules: {
      'cspell/spellchecker': ['warn', { cspell: { words: ['tanstack', ...] } }],
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
  {
    files: ['**/*.spec.ts*', '**/*.test.ts*', '**/*.test-d.ts*'],
    plugins: { vitest },
    rules: { ...vitest.configs.recommended.rules },
    settings: { vitest: { typecheck: true } },
  },
]
```

パッケージ固有の設定はルートを拡張する形で追加する。

```typescript
// packages/react-query/eslint.config.js:1-29
import pluginReact from "@eslint-react/eslint-plugin";
import reactHooks from "eslint-plugin-react-hooks";
import rootConfig from "./root.eslint.config.js";

export default [
  ...rootConfig,
  ...reactHooks.configs["recommended-latest"],
  {
    files: ["**/*.{ts,tsx}"],
    ...pluginReact.configs.recommended,
    rules: {
      "react-hooks/exhaustive-deps": "error",
      "react-hooks/rules-of-hooks": "error",
    },
  },
];
```

シンボリックリンクの活用が鍵であり、`root.eslint.config.js -> ../../eslint.config.js` により各パッケージからルート設定を相対パスでインポートできる。

### TypeScript の strict mode + 追加の厳格設定

`tsconfig.json` でベースライン設定を定義し、`noUncheckedIndexedAccess`、`noUnusedLocals`、`noUnusedParameters` を有効化している。

```json
// tsconfig.json:1-33
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "allowUnreachableCode": false,
    "allowUnusedLabels": false,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "customConditions": ["@tanstack/custom-condition"]
  }
}
```

`customConditions` + exports map の `@tanstack/custom-condition` により、テスト時にソースを直接参照しビルド不要で開発可能にしている。

### ファイル内セクションコメントによる構造化

`query-core` のソースファイルは `// TYPES`、`// CLASS`、`// SINGLETON` のコメントでセクションを分離する規約を採用している。

```typescript
// packages/query-core/src/queryClient.ts:47-61
// TYPES
interface QueryDefaults {
  queryKey: QueryKey
  defaultOptions: OmitKeyof<QueryOptions<any, any, any>, 'queryKey'>
}

// CLASS
export class QueryClient {
  #queryCache: QueryCache
  ...
}
```

```typescript
// packages/query-core/src/notifyManager.ts:1,98
// TYPES
type NotifyCallback = () => void
...
// SINGLETON
export const notifyManager = createNotifyManager()
```

### 命名規則

**型パラメータ**: `T` プレフィックス + PascalCase（`TQueryFnData`, `TError`, `TData`, `TQueryKey`）。一貫して 4 つの標準型パラメータを使い回す。

**アンダースコアプレフィックスの使い分け**:

- `_defaulted`、`_optimisticResults`: 内部使用プロパティ（パブリック API には含めるが、ユーザーが直接使わないことを示す）
- `experimental_prefetchInRender`: 実験的 API のプレフィックス
- `#field`: ES private fields を積極的に使用（`#queryCache`, `#client` 等）

**export naming**: `export default` は使用せず、すべて named export。実験的 API は `export { streamedQuery as experimental_streamedQuery }` のようにリネームで export する。

### テスト規約

**ファイル命名**: `*.test.tsx`（ランタイムテスト）と `*.test-d.tsx`（型テスト）を分離。型テストでは `expectTypeOf` と `assertType` を使用。

```typescript
// packages/query-core/src/__tests__/queryClient.test-d.tsx:1-10
import { assertType, describe, expectTypeOf, it } from 'vitest'
...
describe('getQueryData', () => {
  it('should be typed if key is tagged', () => {
    const queryKey = ['key'] as DataTag<Array<string>, number>
    const data = queryClient.getQueryData(queryKey)
    expectTypeOf(data).toEqualTypeOf<number | undefined>()
  })
})
```

**テストユーティリティの共有パッケージ化**: `@tanstack/query-test-utils` として `queryKey()` ファクトリ、`sleep()`、`mockVisibilityState()` を共有。各パッケージの `__tests__/utils.ts` にはパッケージ固有のヘルパーのみ置く。

```typescript
// packages/query-test-utils/src/queryKey.ts:1-6
let queryKeyCount = 0;
export const queryKey = (): Array<string> => {
  queryKeyCount++;
  return [`query_${queryKeyCount}`];
};
```

### ビルド品質ゲートの多層設計

CI のテストターゲットは以下の 7 層で構成される:

1. `test:sherif` -- モノレポのパッケージ整合性検証
2. `test:knip` -- dead code / 未使用 export の検出
3. `test:eslint` -- リンター（cspell スペルチェック含む）
4. `test:lib` -- Vitest による単体テスト
5. `test:types` -- TS 5.0〜5.8 の型互換性検証
6. `test:build` -- publint + attw によるパッケージ品質検証
7. `build` -- 本番ビルド

### autofix.ci による自動フォーマット

PR と main プッシュ時に `prettier --experimental-cli` を実行し、差分があれば自動コミットする。フォーマットの議論をコードレビューから排除する設計。

```yaml
# .github/workflows/autofix.yml:26-30
- name: Fix formatting
  run: pnpm run format
- name: Apply fixes
  uses: autofix-ci/action@635ffb0c9798bd160680f18fd73371e355b85f27
```

### Dual build (modern/legacy) 戦略

`tsup.config.ts` で modern（Chrome 91+ 向け）と legacy（ES2020/Node 16 向け）の 2 つのビルドを出力し、package.json の exports map で適切に振り分ける。

```typescript
// scripts/getTsupConfig.js:10-21
export function modernConfig(opts) {
  return {
    entry: opts.entry,
    format: ["cjs", "esm"],
    target: ["chrome91", "firefox90", "edge91", "safari15", "ios15", "opera77"],
    outDir: "build/modern",
    dts: true,
    sourcemap: true,
    clean: true,
  };
}
```

## パターンカタログ

- **Observer パターン** (分類: 振る舞い)
  - 解決する問題: クエリ状態の変更を UI 層に効率的に伝播する
  - 適用条件: 複数の購読者が同一データソースの状態変化を監視する場面
  - コード例: `packages/query-core/src/subscribable.ts:1-30`、`packages/query-core/src/queryObserver.ts:40-46`
  - 注意点: `subscribe()` が unsubscribe 関数を返すパターンにより、クリーンアップ漏れを防ぐ

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: GC タイムアウト管理のアルゴリズムを共通化しつつ、削除判定をサブクラスに委譲する
  - 適用条件: 共通のライフサイクル処理 + サブクラス固有の判定ロジック
  - コード例: `packages/query-core/src/removable.ts:5-39`（`abstract optionalRemove()` が Template Method）
  - 注意点: TypeScript の `abstract` メソッドにより実装漏れをコンパイル時に検出

## Good Patterns

- **シンボリックリンクによるモノレポ設定共有**: 各パッケージの `root.*.config.js` をルートへのシンボリックリンクにすることで、設定の一箇所管理と IDE の相対パス解決を両立する。コピーやテンプレート生成と異なり、変更が即座に全パッケージに反映される。

```
packages/query-core/root.eslint.config.js -> ../../eslint.config.js
packages/query-core/root.tsup.config.js -> ../../scripts/getTsupConfig.js
```

- **型テストとランタイムテストの分離**: `*.test-d.tsx` に型テストを分離し、vitest の `typecheck: { enabled: true }` と組み合わせることで、型推論の正しさを CI で自動検証する。型の退行を早期発見できる。

```typescript
// packages/query-core/src/__tests__/queryClient.test-d.tsx:19-26
describe("getQueryData", () => {
  it("should be typed if key is tagged", () => {
    const queryKey = ["key"] as DataTag<Array<string>, number>;
    const data = queryClient.getQueryData(queryKey);
    expectTypeOf(data).toEqualTypeOf<number | undefined>();
  });
});
```

- **`process.env.NODE_ENV` ガードによる開発時限定バリデーション**: プロダクションバンドルから除去される開発時限定の警告・エラーを `process.env.NODE_ENV !== 'production'` で囲む。バンドルサイズを増やさずに DX を向上する。

```typescript
// packages/react-query/src/useBaseQuery.ts:44-49
if (process.env.NODE_ENV !== "production") {
  if (typeof options !== "object" || Array.isArray(options)) {
    throw new Error(
      'Bad argument type. Starting with v5, only the "Object" form is allowed...',
    );
  }
}
```

- **`experimental_` プレフィックスによる実験的 API の明示**: 不安定な API に `experimental_` プレフィックスを付け、利用者に breaking change の可能性を明示する。export 時のリネーム (`export { streamedQuery as experimental_streamedQuery }`) で内部名と公開名を分離し、安定化時にリネームだけで済む設計。

## Anti-Patterns / 注意点

- **`export default` の使用**: 全パッケージで named export のみを使用し、`export default` を避けている。default export はリネーム時にツリーシェイキングが効かなくなるリスクがあり、IDE の自動インポート補完も不安定になる。

```typescript
// Bad: default export
export default class QueryClient { ... }

// Better: named export (TanStack Query の方式)
export class QueryClient { ... }
// packages/query-core/src/index.ts:19
export { QueryClient } from './queryClient'
```

- **テストでの直接パッケージ内 `test:lib` 実行**: CONTRIBUTING.md で明示的に「個別パッケージフォルダ内で `pnpm run test:lib` を実行しないこと」と警告している。パッケージ間依存があるため、Nx 経由でルートから実行する必要がある。

```bash
# Bad
cd packages/react-query && pnpm run test:lib

# Better
npx nx run @tanstack/react-query:test:lib
```

## 導出ルール

- `[MUST]` モノレポの共通設定はシンボリックリンクまたは単一ソースから配布し、各パッケージにコピーしない
  - 根拠: TanStack Query は `root.eslint.config.js -> ../../eslint.config.js` でリントル設定の一箇所管理を実現し、29 パッケージ間の設定ドリフトを構造的に防止している

- `[MUST]` ライブラリの型定義は複数の TypeScript バージョンで CI 検証する
  - 根拠: `test:types` が TS 5.0〜5.8 の 9 バージョンで型チェックを実行し、利用者が古い TS を使っても型が壊れないことを保証している

- `[MUST]` npm パッケージの公開前に `publint` + `attw` (Are The Types Wrong) で exports フィールドと型解決を検証する
  - 根拠: `test:build: "publint --strict && attw --pack"` により「ビルドは通るが import で壊れる」問題を CI で事前検出している

- `[SHOULD]` ESLint に cspell プラグインを統合し、コード内のスペルミスをリント段階で検出する
  - 根拠: `eslint.config.js` で `@cspell/eslint-plugin` を統合し、公開 API 名のタイポを防止。プロジェクト固有の用語は `words` 配列にコメント付きで登録する

- `[SHOULD]` 型テスト（`*.test-d.ts`）とランタイムテスト（`*.test.ts`）をファイルレベルで分離する
  - 根拠: vitest の `typecheck: { enabled: true }` と `expectTypeOf` を用いた型テストを専用ファイルに分離することで、型推論の退行を独立して検証できる

- `[SHOULD]` 開発時限定のバリデーションは `process.env.NODE_ENV !== 'production'` で囲み、プロダクションバンドルから除去可能にする
  - 根拠: `useBaseQuery.ts` 等で引数検証を開発モード限定にし、バンドルサイズに影響を与えずに DX を向上させている

- `[SHOULD]` 実験的 API には `experimental_` プレフィックスを付け、安定化時にリネームのみで breaking change を最小化する
  - 根拠: `experimental_streamedQuery`、`experimental_prefetchInRender` で利用者に不安定性を明示し、安定化時は export リネームだけで内部実装を変更せずに移行できる

- `[SHOULD]` PR のフォーマット差分は CI の自動修正（autofix.ci）で解消し、コードレビューからスタイル議論を排除する
  - 根拠: `.github/workflows/autofix.yml` で Prettier を自動実行・自動コミットし、フォーマットの人的レビューコストをゼロにしている

- `[AVOID]` `export default` を使わず named export で統一する
  - 根拠: TanStack Query は全 29 パッケージで `export default` を使用せず、ツリーシェイキングの確実性と IDE 自動インポートの安定性を確保している

- `[AVOID]` CI の全テストを PR ごとに実行する（影響範囲を `nx affected` で限定する）
  - 根拠: `test:pr` は `nx affected` で変更影響パッケージのみ、`test:ci` は `nx run-many` で全パッケージを対象とし、PR の CI 時間を最小化している

## 適用チェックリスト

- [ ] モノレポの ESLint/ビルド設定がシンボリックリンクまたは共有パッケージで一元管理されているか確認する
- [ ] `publint` と `@arethetypeswrong/cli` を `test:build` スクリプトに追加し、パッケージの exports 整合性を CI で検証する
- [ ] サポートする TypeScript バージョン範囲を定義し、CI で複数バージョンの型チェックを実行する
- [ ] ESLint に `@cspell/eslint-plugin` を統合し、公開 API 名やドキュメント内のスペルミスを自動検出する
- [ ] 型推論のテストを `*.test-d.ts` に分離し、vitest の typecheck を有効化する
- [ ] `knip` で未使用 export・dead code を定期的に検出する仕組みを導入する
- [ ] `sherif` でモノレポのパッケージバージョン整合性を検証する
- [ ] autofix.ci 等のフォーマッタ自動修正を CI に導入し、スタイル議論をレビューから排除する
- [ ] Nx の `affected` コマンドで PR の CI 実行範囲を変更影響パッケージに限定する
- [ ] size-limit でバンドルサイズの退行を PR ごとに検出・レポートする
