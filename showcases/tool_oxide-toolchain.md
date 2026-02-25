# Tool: Oxide Toolchain

> 出典: [repos/cloudflare/agents](../repos/cloudflare/agents/) の研究データ
> カテゴリ: tool

## 概要

ESLint/Prettier を排し、Rust 製の oxlint（リンター）+ oxfmt（フォーマッター）からなる Oxide ツールチェーンを採用するパターン。Rust ベースのツールにより lint/format の速度を桁違いに引き上げ、pre-commit フックでの自動フォーマットをストレスなく実現する。sherif によるモノレポ構造バリデーション、`verbatimModuleSyntax` 強制、`wrangler.jsonc` 統一など、周辺の品質ゲートと組み合わせて「単一コマンドで全チェック完了」の開発体験を構築する手法である。

## 背景・文脈

cloudflare/agents は Cloudflare Workers 上で動作する AI エージェント SDK のモノレポ（40+ プロジェクト）。従来の ESLint + Prettier の組み合わせでは、モノレポ全体への lint/format 実行が数十秒~数分かかり、pre-commit フックでの自動修正が開発体験を損なう問題があった。

Rust 製ツールへの移行により以下を達成している:

- **pre-commit では oxfmt のみ実行** -- コミット速度を犠牲にしない
- **oxlint は CI で完全チェック** -- correctness カテゴリ全体をエラーとし、`any` 禁止も強制
- **sherif でモノレポ構造を検証** -- ワークスペース間の依存バージョン不整合を機械的に検出
- **`npm run check` に全チェックを集約** -- ローカルと CI で同一コマンドを実行

## 実装パターン

### 1. oxlint の設定

correctness カテゴリ全体をエラーとし、`no-explicit-any` でライブラリの型安全性を強制する。未使用変数は `_` プレフィックスで意図的にマークする慣習を lint ルールで制度化している。

```json
// .oxlintrc.json
{
  "plugins": ["react", "jsx-a11y", "typescript"],
  "categories": { "correctness": "error" },
  "rules": {
    "no-explicit-any": "error",
    "no-unused-vars": ["error", {
      "argsIgnorePattern": "^_",
      "varsIgnorePattern": "^_",
      "caughtErrorsIgnorePattern": "^_"
    }]
  },
  "ignorePatterns": ["**/env.d.ts"]
}
```

自動生成ファイル（`env.d.ts` など）は `ignorePatterns` で除外し、lint ルールを適用しない。

### 2. oxfmt の設定

```json
// .oxfmtrc.json
{
  "trailingComma": "none",
  "printWidth": 80,
  "ignorePatterns": ["packages/agents/CHANGELOG.md", "site/agents/.astro"]
}
```

機械生成コンテンツ（CHANGELOG、Astro ビルド出力）を除外し、フォーマット対象を人間が書いたコードに限定する。

### 3. pre-commit フック（husky + lint-staged）

```bash
# .husky/pre-commit
npx lint-staged
```

```json
// package.json (lint-staged 設定)
"lint-staged": {
  "*.{js,mjs,cjs,jsx,ts,mts,cts,tsx,vue,astro,svelte,css}": [
    "oxfmt --write"
  ]
}
```

pre-commit ではフォーマットのみを実行する。lint と typecheck は CI に委ねることで、コミット体験の軽量さを維持する。oxfmt の高速さ（Rust 製）により、ステージされたファイルへのフォーマットは体感的にゼロ秒で完了する。

### 4. 統合チェックコマンド

```json
// package.json (scripts)
"check": "sherif && npm run check:exports && oxfmt --check . && oxlint examples/ packages/ guides/ openai-sdk/ site/ && npm run typecheck"
```

失敗コストの低い順に逐次実行する:

1. **sherif** -- モノレポ構造バリデーション（最速、構造的問題を弾く）
2. **check:exports** -- package.json exports の実在検証
3. **oxfmt --check** -- フォーマットチェック（修正不要、差分検出のみ）
4. **oxlint** -- lint チェック（対象ディレクトリを明示指定）
5. **typecheck** -- 並列 `tsc -p` 実行（最も重い処理を最後に）

### 5. verbatimModuleSyntax の強制

```json
// tsconfig.base.json (抜粋)
{
  "compilerOptions": {
    "verbatimModuleSyntax": true
  }
}
```

`import type` を書かなければコンパイルエラーになるため、型と値のインポートがコード上で明確に分離される。バンドル時に不要なモジュールが含まれる事故を構造的に防ぐ。

```typescript
// 実際のコード例 -- packages/agents/src/index.ts:1-10
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { SSEClientTransportOptions } from "@modelcontextprotocol/sdk/client/sse.js";
```

### 6. ビルド成果物への oxfmt 適用

```typescript
// packages/agents/scripts/build.ts:27-28
// then run oxfmt on the generated .d.ts files
execSync("oxfmt --write ./dist/*.d.ts");
```

tsdown が生成した `.d.ts` ファイルにフォーマッターを適用し、機械生成コードの可読性と diff の安定性を保証する。

### 7. CI パイプライン

```yaml
# .github/workflows/pullrequest.yml
jobs:
  check:    # sherif + check:exports + oxfmt + oxlint + typecheck
    steps:
      - run: npm ci
      - run: npm run build    # build 後に check を実行
      - run: npm run check

  test:
    steps:
      - run: npm ci
      - run: npm run build
      - run: CI=true npm run test
```

`check` と `test` が独立した job として並行実行される。どちらも `npm run build` を前提としており、ビルド成果物の存在が品質チェックの前提条件となっている。

## Good Example

### フォーマットのみの pre-commit + lint は CI で完全チェック

```json
// pre-commit: フォーマットのみ（高速）
"lint-staged": {
  "*.{js,mjs,cjs,jsx,ts,mts,cts,tsx,vue,astro,svelte,css}": [
    "oxfmt --write"
  ]
}
```

```json
// CI: 全チェック（網羅的）
"check": "sherif && npm run check:exports && oxfmt --check . && oxlint examples/ packages/ guides/ openai-sdk/ site/ && npm run typecheck"
```

このように分離することで:

- 開発者のコミット体験を損なわない（oxfmt は Rust 製で高速）
- CI では型安全性・lint ルール・モノレポ整合性を網羅的に検証
- フォーマットの議論をゼロにする（コミット時に自動修正）

### `_` プレフィックスによる未使用変数の意図的マーク

```typescript
// packages/agents/src/index.ts:1407
const { [CF_READONLY_KEY]: _, ...rest } = raw;

// packages/agents/src/index.ts:1436-1437
_connection: Connection,
_ctx: ConnectionContext
```

lint ルールの `argsIgnorePattern: "^_"` と組み合わせ、インターフェース実装で不要な引数を持つ場合も lint エラーにならない。コードを読むだけで「意図的に未使用」と判断できる。

## Bad Example

### ESLint + Prettier をそのまま pre-commit で実行

```json
// Bad: ESLint + Prettier を pre-commit で全実行（遅い）
"lint-staged": {
  "*.{ts,tsx}": [
    "eslint --fix",
    "prettier --write"
  ]
}
```

ESLint の `--fix` はルール数に比例して実行時間が増加する。モノレポ規模ではステージされたファイルだけでも数秒~数十秒かかり、開発者がフックを `--no-verify` で回避する動機を生む。

```json
// Good: oxfmt のみで高速フォーマット（lint は CI に委譲）
"lint-staged": {
  "*.{js,mjs,cjs,jsx,ts,mts,cts,tsx,vue,astro,svelte,css}": [
    "oxfmt --write"
  ]
}
```

### oxlint のディレクトリ指定なし

```bash
# Bad: 全ディレクトリを暗黙的に対象（node_modules や dist を拾うリスク）
oxlint .

# Good: 対象ディレクトリを明示的に列挙
oxlint examples/ packages/ guides/ openai-sdk/ site/
```

oxlint は `.oxlintrc.json` の `ignorePatterns` で除外を指定できるが、対象ディレクトリを明示的に列挙する方が意図が明確で、不要なファイル走査を避けられる。

## 適用ガイド

### どのような状況で使うべきか

- **モノレポで ESLint/Prettier の実行時間がボトルネックになっている場合**: Oxide ツールチェーンへの移行で lint/format 時間を 10 倍以上短縮できる
- **pre-commit フックが重くて `--no-verify` が常態化している場合**: oxfmt のみの pre-commit で軽量化し、遵守率を回復する
- **新規プロジェクトで lint/format の技術選定を行う場合**: ESLint エコシステムのプラグイン依存を避け、Rust 製ツールでシンプルに構成できる

### 導入時の注意点

- **oxlint は ESLint の全ルールをカバーしていない**: `categories: { correctness: "error" }` で基本的な品質を担保しつつ、プロジェクト固有のルールは個別に追加する必要がある。ESLint プラグインに依存した高度なルール（例: import/order の細かいグルーピング）は現時点で oxlint にない場合がある
- **oxfmt は Prettier と 100% 互換ではない**: `trailingComma`, `printWidth` などの主要オプションはサポートされているが、一部の Prettier オプションは未対応。移行時に diff が大量に出る可能性がある -- 一度に全ファイルをフォーマットするコミットを作り、`git blame` の汚染は `git blame --ignore-rev` で対処する
- **sherif はモノレポ専用**: 単一パッケージプロジェクトでは不要。npm workspaces / pnpm workspaces を使うモノレポでのみ導入する

### カスタマイズポイント

- **oxlint のルール追加**: `.oxlintrc.json` の `rules` に ESLint 互換のルール名で追加可能。`categories` でカテゴリ単位の有効化も可能（`correctness`, `suspicious`, `pedantic` 等）
- **oxfmt の対象拡張子**: lint-staged の glob パターンで対象を絞る。`.vue`, `.astro`, `.svelte` もサポート
- **check コマンドの並列化**: 独立したチェック（oxfmt, oxlint, typecheck）を `concurrently` で並列実行すれば、CI の実行時間をさらに短縮可能
- **ビルド成果物フォーマット**: `oxfmt --write ./dist/*.d.ts` のパターンは、任意のコード生成後処理に応用可能（GraphQL codegen、OpenAPI codegen 等）

## 参考

- [repos/cloudflare/agents/build-and-tooling.md](../repos/cloudflare/agents/build-and-tooling.md) -- ビルド基盤と Oxide ツールチェーンの分析
- [repos/cloudflare/agents/dev-conventions.md](../repos/cloudflare/agents/dev-conventions.md) -- 開発規約と品質ゲートの分析
