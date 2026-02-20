# dev-conventions

> リポジトリ: pmndrs/zustand
> 分析日: 2026-02-20

## 概要

zustand の開発規約を、ESLint flat config 設計、Conventional Commits 運用、CI パイプライン戦略（compressed-size action、TypeScript/React バージョンマトリクス）、pnpm の minimumReleaseAge によるリリース安全策の観点から分析する。57k stars のライブラリとして、バンドルサイズ・型互換性・コード品質を CI で自動保証する仕組みが注目に値する。

## 背景にある原則

- **互換性の証明は自動化する**: TypeScript 4.5--5.9 の 15 バージョン、React 18.0--19.x の 9 バージョン、CJS/ESM 両ビルドを CI マトリクスで網羅する。「動くはず」ではなく「CI が証明した」状態をリリース条件とする（`.github/workflows/test-old-typescript.yml`, `test-multiple-versions.yml`, `test-multiple-builds.yml`）
- **サイズ増加は PR 単位で可視化する**: `preactjs/compressed-size-action` で全 PR にバンドルサイズ差分をコメントし、意図しない肥大化をマージ前に検知する（`.github/workflows/compressed-size.yml`）
- **品質ゲートは直列で段階的に失敗させる**: format → types → lint → spec → build の順にステップを直列実行し、最も軽いチェックから失敗させることで CI 時間を節約する（`.github/workflows/test.yml`）
- **リリースの衝動を制度で抑制する**: pnpm の `minimumReleaseAge: 1440`（24 時間）で、新パッケージバージョンの即時利用を防ぎ、サプライチェーン攻撃リスクを低減する（`pnpm-workspace.yaml`）

## 実例と分析

### ESLint flat config の設計戦略

zustand の `eslint.config.mjs` は、ESLint flat config の実践例として以下の特徴を持つ。

**レイヤー構造**: recommended プリセットを基盤に、プロジェクト固有ルールを 1 つのオブジェクトで上書きし、テストファイル用の設定を `files` グロブで分離する。全体で 6 レイヤー構成。

```
globalIgnores → eslint.recommended → import.recommended → tseslint.recommended
→ react.recommended + jsx-runtime + reactHooks → プロジェクト固有ルール
→ tests/**用オーバーライド(×4)
```

**import 管理の厳格化**: `import/extensions: 'always'`（パッケージは除外）でソースコード内の相対 import に `.ts` 拡張子を強制する一方、テストファイルでは `import/extensions: 'never'` に切り替える。これは `allowImportingTsExtensions: true` + `verbatimModuleSyntax` との組み合わせで、ソースは明示的拡張子、テストは vitest alias 経由のパッケージ名 import という棲み分けを実現する。

**意図的な緩和**: `@typescript-eslint/no-explicit-any: 'off'` は、状態管理ライブラリ特有の高度な型操作（`StoreMutators` 等の conditional type チェーン）で `any` が不可避なため明示的にオフにしている。

**テスト固有ルール**: `vitest/consistent-test-it` で `it` に統一し、testing-library と jest-dom プラグインはテストファイル限定で適用する。

### Conventional Commits の運用

`CONTRIBUTING.md` で 6 つの type（feat, fix, refactor, chore, docs, test）を定義。scope はオプション。開発ワークフローでは「PR 作成前に `pnpm run fix:format` を実行」を明記しており、フォーマットを開発者責任としている。

### CI パイプラインの多層構造

zustand の CI は 8 つのワークフローで構成され、それぞれ異なる品質側面をカバーする。

| ワークフロー | トリガー | 検証内容 |
|---|---|---|
| `test.yml` | push/PR | format → types → lint → spec → build（直列） |
| `test-old-typescript.yml` | push/PR | TS 4.5--5.9 の 15 バージョンで型チェック |
| `test-multiple-versions.yml` | push/PR | React 18.0--19.x の 9 バージョンでテスト実行 |
| `test-multiple-builds.yml` | push/PR | CJS/ESM × dev/prod 環境での動作検証 |
| `compressed-size.yml` | PR | バンドルサイズ差分の可視化 |
| `preview-release.yml` | push/PR | `pkg-pr-new` で PR ごとのプレビューリリース |
| `publish.yml` | release | dist ディレクトリから npm publish |
| `docs.yml` | push(main) | ドキュメントの GitHub Pages デプロイ |

### tsconfig パッチによるバージョン互換テスト

`test-old-typescript.yml` では、古い TypeScript バージョンで非対応のオプションを `sed` で動的に除去する。

- 全バージョン共通: `isolatedDeclarations` を除去
- v4.x: `verbatimModuleSyntax` を追加で除去
- v5.3 以前: `moduleResolution: "bundler"` → `"node"` へ変更し、`allowImportingTsExtensions` を除去、パスマッピングを `dist/` に切り替え

この段階的パッチ戦略により、最新機能を活用しつつ後方互換性を維持する。

### ビルド環境別テストの DEV-ONLY/PRD-ONLY パターン

`test-multiple-builds.yml` では、テスト名に `[DEV-ONLY]`/`[PRD-ONLY]` プレフィックスを付け、CI で `sed` によりマッチするテストのみを有効化する。環境依存のコード（`import.meta.env?.MODE` による分岐）を確実にテストする仕組み。

### GitHub Actions のセキュリティ対策

全ワークフローで Actions をコミットハッシュでピン留めし、バージョンコメントを付記する。

```
uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
```

## コード例

### ESLint flat config: import ルールのソース/テスト分離

```typescript
// eslint.config.mjs:33-77 (ソースコード用)
rules: {
  'import/extensions': ['error', 'always', { ignorePackages: true }],
  'import/order': [
    'error',
    {
      alphabetize: { order: 'asc', caseInsensitive: true },
      groups: [
        'builtin',
        'external',
        'internal',
        'parent',
        'sibling',
        'index',
        'object',
      ],
      'newlines-between': 'never',
      pathGroups: [
        {
          pattern: 'react',
          group: 'builtin',
          position: 'before',
        },
      ],
      pathGroupsExcludedImportTypes: ['builtin'],
    },
  ],
}

// eslint.config.mjs:93-101 (テストファイル用オーバーライド)
{
  files: ['tests/**/*.{ts,tsx}'],
  rules: {
    'import/extensions': ['error', 'never'],
    'vitest/consistent-test-it': [
      'error',
      { fn: 'it', withinDescribe: 'it' },
    ],
  },
}
```

### ソースコードでの明示的 .ts 拡張子 import

```typescript
// src/react.ts:1-9
import React from 'react'
import { createStore } from './vanilla.ts'
import type {
  ExtractState,
  Mutate,
  StateCreator,
  StoreApi,
  StoreMutatorIdentifier,
} from './vanilla.ts'
```

### テストでのパッケージ名 import（拡張子なし）

```typescript
// tests/basic.test.tsx:12-14
import { create } from 'zustand'
import type { StoreApi } from 'zustand'
import { createWithEqualityFn } from 'zustand/traditional'
```

### CI: 品質ゲートの直列実行

```yaml
# .github/workflows/test.yml:20-24
- run: pnpm run test:format
- run: pnpm run test:types
- run: pnpm run test:lint
- run: pnpm run test:spec
- run: pnpm run build # we don't have any other workflows to test build
```

### CI: TypeScript バージョンマトリクスと段階的 tsconfig パッチ

::: v-pre
```yaml
# .github/workflows/test-old-typescript.yml:40-53
- name: Patch for all TS
  run: |
    sed -i~ 's/"isolatedDeclarations": true,//' tsconfig.json
- name: Patch for v4/v3 TS
  if: ${{ startsWith(matrix.typescript, '4.') || startsWith(matrix.typescript, '3.') }}
  run: |
    sed -i~ 's/"verbatimModuleSyntax": true,//' tsconfig.json
- name: Patch for Old TS
  if: ${{ matrix.typescript == '5.3.3' || ... }}
  run: |
    sed -i~ 's/"moduleResolution": "bundler",/"moduleResolution": "node",/' tsconfig.json
    sed -i~ 's/"allowImportingTsExtensions": true,//' tsconfig.json
    ...
```
:::

### pnpm minimumReleaseAge

```yaml
# pnpm-workspace.yaml:1-3
packages:
  - .
minimumReleaseAge: 1440
```

### DEV-ONLY テストパターン

```typescript
// tests/devtools.test.tsx:648
it('[DEV-ONLY] warns about misusage', () => {
  const originalConsoleWarn = console.warn
  console.warn = vi.fn()
  ;(api as any).dispatch({ type: '__setState' as any })
  expect(console.warn).toHaveBeenLastCalledWith(
    '[zustand devtools middleware] "__setState" action type is reserved ' +
      'to set state from the devtools. Avoid using it.',
  )
  console.warn = originalConsoleWarn
})
```

## Good Patterns

- **ESLint flat config のレイヤー分離**: recommended プリセットを基盤とし、プロジェクト固有ルールは 1 オブジェクトにまとめ、テスト用設定は `files` グロブで分離する。設定の意図が読みやすく、拡張も容易。

```javascript
// eslint.config.mjs:11-101
export default defineConfig(
  globalIgnores(['dist/', 'examples/', 'website/', 'coverage/']),
  eslint.configs.recommended,
  importPlugin.flatConfigs.recommended,
  tseslint.configs.recommended,
  // ... プロジェクト固有ルール ...
  {
    files: ['tests/**/*.{ts,tsx}'],
    // テスト専用設定
  },
)
```

- **Actions コミットハッシュピン留め + バージョンコメント**: サプライチェーン攻撃を防ぎつつ、コメントで人間が読めるバージョンを維持する。

```yaml
- uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
```

- **vitest.config の環境適応型レポーター**: `process.env.GITHUB_ACTIONS` を検知して `github-actions` レポーターを追加し、CI 上でアノテーションを自動出力する。

```typescript
// vitest.config.mts:18-19
reporters: process.env.GITHUB_ACTIONS
  ? ['default', 'github-actions']
  : ['default'],
```

- **テスト内の import は拡張子なし、ソースは拡張子あり**: `vitest.config.mts` の alias でパッケージ名 → ソースへのマッピングを行い、テストではパッケージ利用者と同じ import パスを使う。これにより公開 API のテストになる。

```typescript
// vitest.config.mts:6-9
alias: [
  { find: /^zustand$/, replacement: resolve('./src/index.ts') },
  { find: /^zustand(.*)$/, replacement: resolve('./src/$1.ts') },
],
```

## Anti-Patterns / 注意点

- **tsconfig パッチの sed 依存**: CI で `sed` を使って tsconfig.json を動的に書き換えるアプローチは、tsconfig のフォーマットが変わると壊れる脆弱性がある。条件分岐ごとに別 tsconfig ファイルを用意する方が保守性は高いが、zustand は 15 バージョン対応のため tsconfig の組み合わせ爆発を避ける実用的な選択をしている。

```yaml
# Bad: sed でJSON を直接編集（フォーマット依存）
sed -i~ 's/"isolatedDeclarations": true,//' tsconfig.json

# Better: バージョン別 tsconfig を用意
# tsconfig.ts45.json, tsconfig.ts50.json, ...
# ただしバージョン数が多い場合は管理コストが爆発する
```

- **`@typescript-eslint/no-explicit-any: 'off'` の無条件適用**: ライブラリの型操作のために全体でオフにしているが、一般のアプリケーションでこれを真似ると型安全性が低下する。ライブラリ固有の事情であることを理解すべき。

```javascript
// Bad: プロジェクト全体で any を許可
'@typescript-eslint/no-explicit-any': 'off',

// Better: 型操作ファイルのみ overrides で緩和
{
  files: ['src/types/**/*.ts'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
  },
}
```

## 導出ルール

- `[MUST]` CI の品質ゲートは「軽いチェックから順に直列実行」する（format → types → lint → test → build）
  - 根拠: zustand の `test.yml` はこの順序で直列実行し、フォーマット違反で即座に失敗させることで CI 時間を最小化している
- `[MUST]` GitHub Actions のサードパーティ Action はコミットハッシュでピン留めし、バージョンをコメントで付記する
  - 根拠: zustand の全 8 ワークフローで `@<commit-hash> # v<version>` 形式を一貫して使用し、サプライチェーン攻撃を防止している
- `[MUST]` ESLint flat config ではテストファイル用ルールを `files` グロブで分離し、ソースコードの lint ルールと混在させない
  - 根拠: zustand は `tests/**/*.{ts,tsx}` で testing-library / jest-dom / vitest プラグインと import ルールのオーバーライドを分離している
- `[SHOULD]` ライブラリの CI には対応バージョンのマトリクステストを含め、互換性を自動証明する
  - 根拠: zustand は TypeScript 15 バージョン、React 9 バージョン、CJS/ESM 2 ビルド形式の互換性を CI マトリクスで検証している
- `[SHOULD]` PR ごとにバンドルサイズ差分を自動計測し、意図しないサイズ増加をマージ前に検知する
  - 根拠: zustand は `preactjs/compressed-size-action` で `dist/**/*.{js,mjs}` のサイズを全 PR で計測している
- `[SHOULD]` pnpm の `minimumReleaseAge` を設定し、新規公開パッケージの即時利用を防ぐ
  - 根拠: zustand は `minimumReleaseAge: 1440`（24 時間）を設定し、malicious package が公開直後にインストールされるリスクを低減している
- `[SHOULD]` テストファイルの import はパッケージ名（公開 API）で行い、vitest alias でソースにマッピングする
  - 根拠: zustand は `vitest.config.mts` で `zustand` → `./src/index.ts` の alias を設定し、テストが利用者と同じ import パスを使う設計にしている
- `[SHOULD]` Conventional Commits の type を CONTRIBUTING.md で明文化し、feat/fix/refactor/chore/docs/test の 6 種に制限する
  - 根拠: zustand は CONTRIBUTING.md で各 type の定義と使用例を示し、コミット履歴の一貫性を保っている
- `[AVOID]` アプリケーションコードで `@typescript-eslint/no-explicit-any: 'off'` をプロジェクト全体に適用する
  - 根拠: zustand はライブラリ特有の高度な型操作のためにオフにしているが、一般のアプリケーションでは型安全性の低下につながる。必要な場合はファイル単位で緩和すべき
- `[AVOID]` CI で tsconfig.json を `sed` で動的に書き換える（バージョン数が少ない場合）
  - 根拠: zustand は 15 バージョン対応のために実用的な選択をしているが、テキスト置換は JSON フォーマット変更に脆弱であり、バージョン数が少なければ専用ファイルの方が安全

## 適用チェックリスト

- [ ] ESLint を flat config (`eslint.config.mjs`) に移行し、recommended プリセット → プロジェクト固有ルール → テスト用オーバーライドのレイヤー構成にする
- [ ] `import/order` で alphabetize + グループ分けを設定し、import 順序を自動強制する
- [ ] CI の品質ゲートを format → types → lint → test → build の順に直列化し、軽いチェックから失敗させる
- [ ] GitHub Actions のサードパーティ Action をコミットハッシュピン留め + バージョンコメント形式に統一する
- [ ] PR ごとのバンドルサイズ計測（`compressed-size-action` 等）を CI に追加する
- [ ] `pnpm-workspace.yaml` に `minimumReleaseAge` を設定する（推奨: 1440 = 24 時間）
- [ ] ライブラリの場合、対応するランタイム/型システムのバージョンマトリクステストを CI に追加する
- [ ] Conventional Commits の type 定義を CONTRIBUTING.md に明文化する
- [ ] vitest の alias 設定で、テストがパッケージ名 import（公開 API）を使うようにする
- [ ] vitest.config に `process.env.GITHUB_ACTIONS` による条件分岐レポーターを設定する
