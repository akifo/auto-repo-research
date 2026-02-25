# build-and-tooling

> リポジトリ: cloudflare/agents
> 分析日: 2026-02-25

## 概要

Cloudflare Agents SDK のビルド基盤を分析する。tsdown による ESM-only ビルド、Oxide ツールチェーン（oxlint + oxfmt）の採用、カスタムスクリプトによる export 検証・並行 typecheck といった開発インフラが注目に値する。従来の ESLint/Prettier を Rust ベースのツールに置き換え、ビルド成果物と package.json exports の整合性をプログラム的に保証する仕組みは、ライブラリ開発の信頼性を高める実践として汎用的に適用可能である。

## 背景にある原則

- **ビルドスクリプトをプログラマブルにし、宣言的設定ファイルに閉じ込めない**: 全4パッケージの build.ts が tsdown の API を TypeScript から直接呼び出している。設定ファイル（tsdown.config.ts）ではなくスクリプト形式を採用することで、ビルド後に `oxfmt --write ./dist/*.d.ts` を実行するといった後処理パイプラインを自然に表現でき、複合的なビルドステップを1ファイルで完結させている（`packages/agents/scripts/build.ts:1-37`）。

- **公開インターフェースの整合性を自動検証する**: package.json の exports フィールドに宣言されたファイルが実際に存在するかを `check-exports.ts` で検証する。ライブラリの利用者が `import ... from "agents/mcp"` と書いたときに解決先が存在しないという破壊的な問題を CI で早期検出する思想である（`scripts/check-exports.ts:33-65`）。

- **Rust ベースツールで lint/format の速度を桁違いに上げる**: oxlint と oxfmt を採用し、ESLint + Prettier の組み合わせを完全に排除している。高速化により `npm run check` 全体（sherif + check:exports + oxfmt + oxlint + typecheck）をモノレポ全体に対して単一コマンドで実行可能にしている。

- **依存関係の更新を制御可能にする**: `check-updates.ts` で `--reject` フラグを使い、互換性問題のあるパッケージを明示的にピン留めしている。「何を更新しないか」を宣言的に管理することで、自動更新の暴走を防ぐ（`scripts/check-updates.ts:6-14`）。

## 実例と分析

### tsdown ビルドパターンの統一

全4パッケージ（agents, hono-agents, ai-chat, codemode）が同一構造の `scripts/build.ts` を持つ。共通設定は以下の通り:

```typescript
// packages/agents/scripts/build.ts:4-25
async function main() {
  await build({
    clean: true,
    dts: true,
    entry: [
      "src/*.ts",
      "src/*.tsx",
      "src/cli/index.ts",
      "src/mcp/index.ts",
      // ... パッケージ固有のエントリポイント
    ],
    skipNodeModulesBundle: true,
    external: ["cloudflare:workers", "cloudflare:email"],
    format: "esm",
    sourcemap: true,
    fixedExtension: false,
  });

  // then run oxfmt on the generated .d.ts files
  execSync("oxfmt --write ./dist/*.d.ts");

  process.exit(0);
}
```

注目すべき設計判断:

- **`skipNodeModulesBundle: true`**: ライブラリパッケージとして配布するため、依存関係をバンドルに含めない。利用者のバンドラーに解決を委ねる。
- **`external: ["cloudflare:workers", ...]`**: Cloudflare Workers の仮想モジュール（`cloudflare:` プレフィックス）をビルド時に除外。ランタイム固有のモジュール解決を尊重する。
- **`fixedExtension: false`**: `.mjs`/`.cjs` ではなく `.js` 拡張子で出力。package.json の `"type": "module"` と組み合わせて ESM として解決させる。
- **`dts: true` + oxfmt 後処理**: 生成された `.d.ts` ファイルをフォーマットする。機械生成コードの可読性を保証し、diff のノイズを減らす。

### エントリポイントと exports の対応関係

package.json の exports マップとビルドスクリプトの entry 配列が1対1で対応している。agents パッケージの例:

```typescript
// packages/agents/scripts/build.ts:8-18 (entry)
entry: [
  "src/*.ts", // index.ts, client.ts, types.ts, react.tsx 等
  "src/*.tsx",
  "src/cli/index.ts",
  "src/mcp/index.ts",
  "src/mcp/client.ts",
  "src/mcp/do-oauth-client-provider.ts",
  "src/mcp/x402.ts",
  "src/observability/index.ts",
  "src/codemode/ai.ts",
  "src/experimental/forever.ts",
];
```

```json
// packages/agents/package.json:87-177 (exports, 抜粋)
{
  ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
  "./mcp": { "types": "./dist/mcp/index.d.ts", "import": "./dist/mcp/index.js" },
  "./mcp/client": { "types": "./dist/mcp/client.d.ts", "import": "./dist/mcp/client.js" },
  "./observability": { "types": "./dist/observability/index.d.ts", "import": "./dist/observability/index.js" }
}
```

このマッピングの整合性を `check-exports.ts` が検証する。

### export 検証スクリプトの実装

```typescript
// scripts/check-exports.ts:9-28
function extractFilePaths(
  exports: unknown,
  paths: Set<string> = new Set(),
): Set<string> {
  if (typeof exports === "string") {
    paths.add(exports);
  } else if (Array.isArray(exports)) {
    for (const item of exports) {
      extractFilePaths(item, paths);
    }
  } else if (exports && typeof exports === "object") {
    for (const value of Object.values(exports)) {
      extractFilePaths(value, paths);
    }
  }
  return paths;
}
```

再帰的に exports オブジェクトを走査し、条件付きエクスポート（`types`, `import`, `require`）のネストを全て解決する。`"."` で始まるパスのみをファイル存在チェックの対象にし、パッケージ名参照はスキップする（`check-exports.ts:54`）。`@cloudflare/agents-ui` のような内部専用パッケージは `SKIP_PACKAGES` で除外する。

### 並行 typecheck スクリプト

```typescript
// scripts/typecheck.ts:8-13
const tsconfigs: string[] = [];
for await (const file of await fg.glob("**/tsconfig.json")) {
  if (file.includes("node_modules")) continue;
  tsconfigs.push(file);
}

const concurrency = Math.max(os.cpus().length, 2);
```

モノレポ内の全 `tsconfig.json` を発見し、CPU コア数に基づく並行度で `tsc -p` を実行する。TypeScript の Project References を使わず、独立した `tsc` プロセスを並行実行するアプローチは、セットアップの複雑さを避けつつ大規模モノレポでの型チェック速度を確保する。

### Oxide ツールチェーンの設定

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
  }
}
```

```json
// .oxfmtrc.json
{
  "trailingComma": "none",
  "printWidth": 80,
  "ignorePatterns": ["packages/agents/CHANGELOG.md", "site/agents/.astro"]
}
```

`no-explicit-any: error` はライブラリの型安全性を強制する重要なルール。`_` プレフィックスで未使用変数を明示的にマークする慣習を `argsIgnorePattern` で制度化している。

### pre-commit フック

```bash
# .husky/pre-commit
npx lint-staged
```

```json
// package.json:92-96 (lint-staged)
"lint-staged": {
  "*.{js,mjs,cjs,jsx,ts,mts,cts,tsx,vue,astro,svelte,css}": [
    "oxfmt --write"
  ]
}
```

pre-commit ではフォーマットのみを実行し、lint は CI に委ねる。コミット速度を犠牲にしない設計。

### CI パイプラインの構造

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
      - run: npm run build    # テストも build 後に実行
      - run: CI=true npm run test

  publish-preview:
    steps:
      - run: npm ci
      - run: npm run build
      - run: npx pkg-pr-new publish --peerDeps ./packages/*
```

`check` と `test` が独立した job として並行実行される。どちらも `npm run build` を前提としている。PR ごとに `pkg-pr-new` でプレビュー版を自動公開し、レビュアーが実際にインストールして動作確認できるようにしている。

### リリースフローとワークスペースバージョン解決

```typescript
// .github/resolve-workspace-versions.ts:47-78
for (const [packageName, { file, packageJson }] of Object.entries(packageJsons)) {
  for (const field of depFields) {
    const deps = packageJson[field];
    for (const [dependencyName] of Object.entries(deps)) {
      if (dependencyName in packageJsons) {
        let actualVersion = packageJsons[dependencyName].packageJson.version;
        if (!actualVersion.startsWith("0.0.0-")) {
          actualVersion = `^${actualVersion}`;
        }
        deps[dependencyName] = actualVersion;
      }
    }
  }
}
```

npm workspaces はパブリッシュ時にワークスペース参照を自動解決しないため、カスタムスクリプトで `workspace:*` 参照を実際のバージョン（`^x.y.z` 形式）に書き換える。`0.0.0-` プレフィックスのプレリリースバージョンはキャレット（`^`）を付けずにそのまま使う。

### 依存関係のピン留めとパッチ

```typescript
// scripts/check-updates.ts:5-14
execSync(
  `npx npm-check-updates ${update} \
  --reject @a2a-*  \
  --reject vitest \
  --reject @vitest/runner \
  // ...
  --workspaces`,
  { stdio: "inherit" },
);
```

互換性問題のあるパッケージを `--reject` で明示的に除外。vitest 関連の更新を制限しているのは、テスト基盤の安定性を優先するため。さらに `patch-package` で `vitest-browser-react` のバグ修正パッチを適用している（`patches/vitest-browser-react+1.0.1.patch`）。

## Good Patterns

- **ビルド後の成果物フォーマット**: tsdown が生成する `.d.ts` ファイルに `oxfmt --write` を適用し、機械生成コードの可読性と diff の安定性を保証する。ビルドスクリプト内で後処理パイプラインを完結させることで、CI とローカル実行で同じ結果を得る。

```typescript
// packages/agents/scripts/build.ts:27-28
// then run oxfmt on the generated .d.ts files
execSync("oxfmt --write ./dist/*.d.ts");
```

- **export 整合性の自動検証**: package.json の exports に宣言されたパスの実在をプログラム的にチェックする。条件付きエクスポートの再帰的走査により、`types`/`import`/`require` の全条件をカバーする。

```typescript
// scripts/check-exports.ts:50-63
const filePaths = extractFilePaths(packageJson.exports);
for (const filePath of filePaths) {
  if (!filePath.startsWith(".")) continue;
  const fullPath = resolve(packageDir, filePath);
  if (!existsSync(fullPath)) {
    missing.push(filePath);
  }
}
```

- **pre-commit をフォーマットのみに限定**: `lint-staged` で oxfmt のみを実行し、lint と typecheck は CI に委ねる。コミット体験の軽量さとコード品質保証を分離する。

```json
// package.json:92-96
"lint-staged": {
  "*.{js,mjs,cjs,jsx,ts,mts,cts,tsx,vue,astro,svelte,css}": [
    "oxfmt --write"
  ]
}
```

- **統合チェックコマンド**: `npm run check` が sherif, check:exports, oxfmt, oxlint, typecheck を逐次実行する。CI の `check` job と同じ検証をローカルで再現可能にする。

```json
// package.json:23
"check": "sherif && npm run check:exports && oxfmt --check . && oxlint examples/ packages/ guides/ openai-sdk/ site/ && npm run typecheck"
```

## Anti-Patterns / 注意点

- **ビルドスクリプトのコピー&ペースト**: 4パッケージの `scripts/build.ts` がほぼ同一構造で、異なるのは entry 配列と external 配列のみ。共通ロジックの抽出が行われていないため、ビルド設定の変更（例: sourcemap の無効化）が4ファイルに波及する。

```typescript
// Bad: 全パッケージに同じボイラープレート
// packages/agents/scripts/build.ts
await build({ clean: true, dts: true, ..., sourcemap: true, fixedExtension: false });
execSync("oxfmt --write ./dist/*.d.ts");

// packages/hono-agents/scripts/build.ts (ほぼ同じ)
await build({ clean: true, dts: true, ..., sourcemap: true, fixedExtension: false });
execSync("oxfmt --write ./dist/*.d.ts");
```

```typescript
// Better: 共通ビルド関数を抽出
// scripts/shared-build.ts
export async function buildPackage(entry: string[], external?: string[]) {
  await build({
    clean: true,
    dts: true,
    entry,
    skipNodeModulesBundle: true,
    external: ["cloudflare:workers", ...(external || [])],
    format: "esm",
    sourcemap: true,
    fixedExtension: false,
  });
  execSync("oxfmt --write ./dist/*.d.ts");
}
```

- **check コマンドの逐次実行**: `sherif && check:exports && oxfmt && oxlint && typecheck` が全て直列実行される。oxfmt と oxlint は互いに独立しており、並列実行可能だが、シェルの `&&` チェーンでは並列化できない。

```json
// Bad: 全て直列
"check": "sherif && npm run check:exports && oxfmt --check . && oxlint ... && npm run typecheck"

// Better: 独立したチェックを並列実行
"check": "sherif && npm run check:exports && concurrently 'oxfmt --check .' 'oxlint ...' 'npm run typecheck'"
```

## 導出ルール

- `[MUST]` ライブラリパッケージの package.json exports に宣言した全パスの実在を CI で自動検証する
  - 根拠: cloudflare/agents の `check-exports.ts` が条件付きエクスポート（types/import/require）を再帰的に走査し、ビルド成果物の欠落を早期検出している（`scripts/check-exports.ts:33-65`）

- `[MUST]` ビルドとチェック（lint/typecheck/export検証）の実行順序を「build -> check」で固定する
  - 根拠: CI の check job と test job の両方が `npm run build` を先に実行する。check:exports は生成された dist/ の存在を前提としている（`.github/workflows/pullrequest.yml:33-34`）

- `[SHOULD]` ビルドツールを宣言的設定ファイルではなくプログラマブルなスクリプトから呼び出し、後処理パイプラインを統合する
  - 根拠: `build.ts` が tsdown API を直接呼び出した後に `oxfmt --write` で `.d.ts` をフォーマットしており、ビルド + 後処理を1ファイルに凝縮している（`packages/agents/scripts/build.ts:4-31`）

- `[SHOULD]` pre-commit フックではフォーマットのみを実行し、lint と typecheck は CI に委ねる
  - 根拠: `lint-staged` で oxfmt のみを実行し、完全な検証は `npm run check` に集約することで、コミット体験の軽量さを維持している（`package.json:92-96`, `.husky/pre-commit`）

- `[SHOULD]` 依存関係の自動更新から除外するパッケージを明示的に宣言する
  - 根拠: `check-updates.ts` が `--reject` で vitest 関連や SDK バージョンを固定し、互換性問題のある更新を制御している（`scripts/check-updates.ts:7-13`）

- `[SHOULD]` モノレポの typecheck はプロジェクト参照ではなく並行プロセス実行で高速化する
  - 根拠: `typecheck.ts` が全 tsconfig.json を発見して CPU コア数に基づく並行度で `tsc -p` を実行し、Project References の設定コストを回避している（`scripts/typecheck.ts:15-59`）

- `[AVOID]` モノレポ内で同一構造のビルドスクリプトをパッケージごとにコピーする（共通ビルド関数を抽出すべき）
  - 根拠: 4パッケージの build.ts が entry 配列以外ほぼ同一で、共通設定変更時に全ファイルの更新が必要になる

## 適用チェックリスト

- [ ] package.json の exports フィールドに宣言された全パスが `dist/` に存在することを検証するスクリプトを用意しているか
- [ ] ビルドスクリプトが後処理（フォーマット、バナー挿入等）を含む場合、宣言的設定ファイルではなくプログラマブルなスクリプトで記述しているか
- [ ] CI パイプラインで build -> check の実行順序が保証されているか
- [ ] pre-commit フックが軽量な処理（フォーマット等）に限定されているか
- [ ] 依存関係の自動更新で除外すべきパッケージが明示的に管理されているか
- [ ] モノレポの統合チェックコマンド（`npm run check` 等）がローカルと CI で同じ検証を実行できるか
- [ ] 機械生成コード（.d.ts 等）にフォーマッターを適用して diff の安定性を確保しているか
