# build-and-tooling

> リポジトリ: cloudflare/partykit
> 分析日: 2026-02-25

## 概要

cloudflare/partykit は npm workspaces モノレポで 9 つのパッケージを管理し、tsdown（tsup 後継）をプログラマティック API で呼び出すビルドスクリプト、oxfmt/oxlint による Rust ベースのフォーマット・リント、check-exports による exports フィールドの実在検証、sherif によるモノレポ一貫性チェックという多層的な品質ゲートを構築している。注目すべきは「ビルド成果物にもフォーマッターを適用する」という一貫性への徹底と、パッケージごとに異なるビルド要件（ESM-only vs デュアルフォーマット）をスクリプトレベルで制御するアプローチである。

## 背景にある原則

- **ビルド設定はコードとして表現すべき**: tsdown の設定を `tsdown.config.ts` のような宣言的ファイルではなく `scripts/build.ts` としてプログラマティック API で記述することで、パッケージ固有の前後処理（oxfmt 適用、ファイル移動）を自然に統合できる。宣言的設定だけでは表現しきれないビルドパイプラインの柔軟性を担保する手段である。
- **品質ゲートは段階的に積み上げるべき**: `npm run check` は `check:repo && check:format && check:lint && check:type && check:test` の 5 段階で構成される。速い検査（フォーマット）から遅い検査（テスト）へ順に実行し、早期に失敗させることでフィードバックループを最短化する。
- **成果物も開発コードと同じルールに従うべき**: tsdown が生成した `.d.ts`、`.js`、`.cjs` ファイルにも oxfmt を適用する。生成されたコード（型定義など）が読みやすいことは、ライブラリ利用者がエディタ上で型を参照する際の体験を向上させる。
- **環境差異は tsconfig の分割で隔離すべき**: サーバーコード（`@cloudflare/workers-types`）、クライアントコード（`lib: ["DOM"]`）、テストコード（`@cloudflare/vitest-pool-workers`）それぞれに専用の tsconfig.json を配置し、型の汚染を防ぐ。1 パッケージに 3-4 個の tsconfig.json が存在するのはこの設計判断による。

## 実例と分析

### tsdown のプログラマティック API 活用

全 9 パッケージが `scripts/build.ts` を持ち、`tsx scripts/build.ts` で実行される。共通のベース設定（`sourcemap: true`, `clean: true`, `dts: true`, `skipNodeModulesBundle: true`, `fixedExtension: false`）を各スクリプト内で明示的に記述しつつ、パッケージ固有の差異（エントリポイント、`external`、`format`）を個別に設定する。

```typescript
// packages/partyserver/scripts/build.ts:4-13
await build({
  entry: ["src/index.ts"],
  external: ["cloudflare:workers"],
  sourcemap: true,
  clean: true,
  format: "esm",
  dts: true,
  skipNodeModulesBundle: true,
  fixedExtension: false,
});
```

共有設定ファイルを作らず各パッケージで同じオプションを繰り返す設計は一見 DRY 原則に反するが、パッケージごとの独立性を優先している。ビルド設定の変更が他パッケージに波及しないため、段階的な移行やパッケージ固有の最適化が容易になる。

### デュアルフォーマットビルド（ESM + CJS）

9 パッケージ中、`partysocket` のみが `format: ["esm", "cjs"]` でデュアルフォーマットビルドを行う。他のパッケージは `format: "esm"` のみ。

```typescript
// packages/partysocket/scripts/build.ts:4-28
async function run() {
  await build({
    entry: [
      "src/index.ts",
      "src/react.ts",
      "src/ws.ts",
      "src/use-ws.ts",
      "src/event-target-polyfill.ts",
    ],
    sourcemap: true,
    clean: true,
    format: ["esm", "cjs"],
    dts: true,
    skipNodeModulesBundle: true,
    fixedExtension: false,
  });

  // then run oxfmt on the generated files
  execSync("oxfmt ./dist/**/*.d.cts");
  execSync("oxfmt ./dist/**/*.d.ts");
  execSync("oxfmt ./dist/**/*.cjs");
  execSync("oxfmt ./dist/**/*.js");

  process.exit(0);
}
```

partysocket はブラウザ・Node.js 両方から使われるクライアントライブラリであり、CJS 環境（既存の Node.js プロジェクト）との互換性が必要。サーバーサイド専用パッケージ（partyserver, partywhen など）は Cloudflare Workers 上で動作するため ESM のみで十分。この判断は「最小限の互換性コスト」の原則に従っている。

partysocket の `exports` フィールドは条件付きエクスポートで ESM/CJS を分岐させている:

```json
// packages/partysocket/package.json:10-56
"exports": {
  ".": {
    "types": {
      "import": "./index.d.ts",
      "require": "./index.d.cts",
      "default": "./index.d.ts"
    },
    "import": "./dist/index.js",
    "require": "./dist/index.cjs"
  }
}
```

`types` 条件を `import`/`require`/`default` で分岐させ、`.d.ts`（ESM 用）と `.d.cts`（CJS 用）を使い分ける。`post-build` スクリプトで型定義ファイルをパッケージルートに移動する:

```json
// packages/partysocket/package.json:58-59
"clean": "shx rm -rf dist *.d.ts *.d.cts event-target-polyfill.*",
"post-build": "shx mv dist/*.d.cts dist/*.d.ts* . && shx mv dist/event-target-polyfill.* .",
```

### ビルド成果物へのフォーマッター適用

8/9 パッケージのビルドスクリプトが、ビルド後に `execSync("oxfmt ./dist/**/*.d.ts")` を実行する。partysocket はさらに `.d.cts`、`.cjs`、`.js` にも適用する。唯一 partytracks はビルドスクリプト内ではなく `postbuild` npm スクリプトで実行している:

```json
// packages/partytracks/package.json:6-8
"prebuild": "rm -rf dist",
"build": "tsx scripts/build.ts",
"postbuild": "oxfmt ./dist/*/**.d.ts"
```

### check-exports によるエクスポート検証

`scripts/check-exports.ts` はビルド後に `npm run build` の末尾で自動実行される（`package.json:14`）。全パッケージの `package.json` の `exports` フィールドから再帰的にファイルパスを抽出し、実在を検証する。

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

`exports` の値はネストされたオブジェクト（条件付きエクスポート）・配列・文字列のいずれかになりうるため、再帰的に走査して全パスを収集する。相対パス（`.` で始まるもの）のみを検証対象とし、パッケージ名などの非ファイルパスはスキップする。

### 細分化された tsconfig.json

モノレポ全体で 40 個以上の tsconfig.json が存在する。共通設定は `tsconfig.base.json` に集約し、各サブディレクトリが `extends` で継承しつつ環境固有の `types` や `lib` を上書きする。

```json
// packages/partysub/src/server/tsconfig.json
{
  "extends": "../../../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["@cloudflare/workers-types"]
  },
  "exclude": ["tests/**/*.ts"]
}
```

```json
// packages/partysub/src/client/tsconfig.json
{
  "extends": "../../../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["DOM"]
  }
}
```

同一パッケージ内でもサーバー（Workers 型）とクライアント（DOM 型）で tsconfig を分離することで、`document` や `window` がサーバーコードで使えてしまう型汚染を防いでいる。

### typecheck スクリプトによるモノレポ横断型チェック

`scripts/typecheck.ts` は `fast-glob` で全 `tsconfig.json` を検出し、逐次 `tsc -p` で型チェックする。

```typescript
// scripts/typecheck.ts:20-38
for (const tsconfig of tsconfigs) {
  console.log(`Checking ${tsconfig}...`);
  try {
    const output = execSync(`tsc -p ${tsconfig}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    results.push({ tsconfig, success: true, output });
  } catch (rawError: unknown) {
    const error = rawError as ExecException;
    const output = error.stdout?.toString() || `${error.stderr?.toString()}` || "";
    results.push({ tsconfig, success: false, output });
  }
}
```

全結果を収集してから最後にサマリーを表示するため、1 つの型エラーで中断せず全体像が把握できる。

### CI パイプラインの構成

PR 時（`pullrequest.yml`）は `npm ci && npm run build && npm run check` を実行し、ビルドと全品質チェックを一括で走らせる。並行して `pkg-pr-new.yml` が各パッケージのプレリリースを発行する。

```yaml
# .github/workflows/pullrequest.yml:24-28
- run: npm ci
- run: npm run build
- run: npm run check
```

リリース時（`release.yml`）は `npm ci && npm run build` の後、Changesets Action がバージョニングと npm publish を実行する。`changeset-version.sh` で `changeset version` 後に `npm install` を実行し、`package-lock.json` の同期を保証している。

### sherif によるモノレポ一貫性チェック

`check:repo` で `sherif` を実行し、モノレポ全体の依存関係の一貫性（同一パッケージのバージョンの揃い、不正な依存宣言など）を検証する。ルート `package.json` の `overrides` フィールドで `esbuild`, `react`, `react-dom`, `@types/node` 等のバージョンを固定し、ワークスペース間の不整合を防止する。

### oxlint の実用的な設定

`.oxlintrc.json` では `correctness` カテゴリを `error` に設定しつつ、実用上障害となるルールを選択的に無効化している:

```json
// .oxlintrc.json:6-23
"rules": {
  "no-explicit-any": "off",
  "no-non-null-assertion": "off",
  "no-redeclare": "off",
  "no-unused-vars": [
    "error",
    {
      "argsIgnorePattern": "^_",
      "varsIgnorePattern": "^_",
      "caughtErrorsIgnorePattern": "^_"
    }
  ]
}
```

`ignorePatterns` で `**/dist`、`**/*.d.ts`、`**/*.d.cts` を除外し、ビルド成果物がリント対象にならないようにしている。

## コード例

ビルドスクリプトの共通パターンとパッケージ固有差異を並べて示す:

```typescript
// packages/partyfn/scripts/build.ts:4-15（ESM-only, 単一エントリ）
await build({
  entry: ["src/index.ts"],
  sourcemap: true,
  clean: true,
  format: "esm",
  dts: true,
  skipNodeModulesBundle: true,
  fixedExtension: false,
});
execSync("oxfmt ./dist/**/*.d.ts");
```

```typescript
// packages/partysocket/scripts/build.ts:6-25（デュアルフォーマット, 複数エントリ）
await build({
  entry: ["src/index.ts", "src/react.ts", "src/ws.ts", "src/use-ws.ts", "src/event-target-polyfill.ts"],
  sourcemap: true,
  clean: true,
  format: ["esm", "cjs"],
  dts: true,
  skipNodeModulesBundle: true,
  fixedExtension: false,
});
execSync("oxfmt ./dist/**/*.d.cts");
execSync("oxfmt ./dist/**/*.d.ts");
execSync("oxfmt ./dist/**/*.cjs");
execSync("oxfmt ./dist/**/*.js");
```

## パターンカタログ

- **Template Method** (分類: 振る舞い)
  - 解決する問題: 全パッケージで共通のビルドフロー（設定 -> ビルド -> 後処理）を維持しつつ、パッケージ固有の差異を許容する
  - 適用条件: モノレポで複数パッケージが類似だが同一ではないビルド要件を持つ場合
  - コード例: 各 `packages/*/scripts/build.ts` — `build()` 呼び出し -> `execSync("oxfmt ...")` の流れが全パッケージで共通
  - 注意点: 共通部分を抽象化した共有モジュールにしていないのは意図的。独立性を優先し、変更の波及を防いでいる

## Good Patterns

- **ビルドスクリプトを TypeScript で記述し tsx で実行**: ビルド設定をプログラマティック API で書くことで、条件分岐・前後処理・エラーハンドリングを自然に統合できる。`tsdown.config.ts` のような宣言的設定では `execSync` による後処理を記述できない。

```typescript
// packages/partyserver/scripts/build.ts:1-18（全体）
import { execSync } from "node:child_process";
import { build } from "tsdown";

await build({/* ... */});
execSync("oxfmt ./dist/*.d.ts");
process.exit(0);
```

- **check-exports でビルド成果物の整合性を自動検証**: `package.json` の `exports` に記載されたパスが実際に存在するかを検証するスクリプトを `npm run build` の末尾で自動実行する。手動確認に頼らず、CI で確実にキャッチできる。

```typescript
// scripts/check-exports.ts:52-63
for (const filePath of filePaths) {
  if (!filePath.startsWith(".")) {
    continue;
  }
  const fullPath = resolve(packageDir, filePath);
  if (!existsSync(fullPath)) {
    missing.push(filePath);
  }
}
```

- **品質チェックの直列合成**: `check:repo && check:format && check:lint && check:type && check:test` の順に実行し、軽量な検査から重量な検査へ段階的に進む。先行ステップの失敗で後続をスキップすることで CI 時間を節約する。

```json
// package.json:16
"check": "npm run check:repo && npm run check:format && npm run check:lint && npm run check:type && npm run check:test"
```

- **環境ごとの tsconfig 分離**: 同一パッケージ内でもサーバー・クライアント・テストで別の tsconfig.json を配置し、型の汚染を防ぐ。`extends` で共通ベースを継承しつつ、`types` と `lib` のみを環境ごとに差し替える。

## Anti-Patterns / 注意点

- **ビルド設定の暗黙的重複**: 全パッケージで `sourcemap: true, clean: true, dts: true, skipNodeModulesBundle: true, fixedExtension: false` を繰り返している。現時点では 9 パッケージで管理可能だが、パッケージ数が増えた場合に設定の不整合リスクが高まる。

```typescript
// Bad: 全パッケージで同一オプションを手動コピー
await build({
  sourcemap: true,
  clean: true,
  dts: true,
  skipNodeModulesBundle: true,
  fixedExtension: false,
});
```

```typescript
// Better: 共通デフォルトを関数で提供しつつ個別上書きを許容
import { baseConfig } from "../../build-utils";
await build({
  ...baseConfig(),
  entry: ["src/index.ts"],
  external: ["cloudflare:workers"],
});
```

ただし、このリポジトリでは意図的に独立性を優先している可能性があり、9 パッケージ程度なら重複のコストは低い。パッケージ数が 20 を超える場合に検討すべきトレードオフ。

- **typecheck スクリプトの逐次実行**: `scripts/typecheck.ts` は全 tsconfig.json を逐次 `tsc -p` で型チェックする。40 個以上の tsconfig が存在するため、並列実行にすればチェック時間を短縮できる可能性がある。

## 導出ルール

- `[MUST]` モノレポでは `npm run build` の末尾で `exports` フィールドに記載された全ファイルの実在を自動検証するスクリプトを実行する
  - 根拠: cloudflare/partykit の `scripts/check-exports.ts` がビルド直後に実行され、exports の不整合を CI で即座に検出している（`package.json:14`）
- `[MUST]` 品質チェックは軽量（フォーマット・リント）から重量（型チェック・テスト）の順に `&&` で直列合成し、先行失敗で後続をスキップさせる
  - 根拠: `check:repo && check:format && check:lint && check:type && check:test` の構成により、フォーマットエラーの段階でテスト実行をスキップし CI 時間を最小化している（`package.json:16`）
- `[SHOULD]` ビルドツールの設定は宣言的設定ファイルではなくプログラマティック API で TypeScript スクリプトとして記述し、前後処理を自然に統合する
  - 根拠: 全 9 パッケージが `scripts/build.ts` でビルド後の oxfmt 適用やファイル移動を一体のスクリプトとして管理している
- `[SHOULD]` ビルド成果物（特に `.d.ts` 型定義ファイル）にもフォーマッターを適用し、ライブラリ利用者が参照する型定義の可読性を担保する
  - 根拠: 8/9 パッケージのビルドスクリプトが `execSync("oxfmt ./dist/**/*.d.ts")` を実行している
- `[SHOULD]` 同一パッケージ内でサーバーコード・クライアントコード・テストコードが異なる型環境を必要とする場合、サブディレクトリごとに tsconfig.json を分離して型の汚染を防ぐ
  - 根拠: `partysub/src/server/tsconfig.json`（`types: ["@cloudflare/workers-types"]`）と `partysub/src/client/tsconfig.json`（`lib: ["DOM"]`）で同一パッケージ内の環境差異を隔離している
- `[SHOULD]` デュアルフォーマット（ESM + CJS）はクライアントライブラリなど本当に必要なパッケージのみに適用し、サーバーサイド専用パッケージは ESM-only にする
  - 根拠: 9 パッケージ中 partysocket のみが `format: ["esm", "cjs"]` でビルドし、他のサーバーサイドパッケージは `format: "esm"` のみ
- `[AVOID]` Changesets でバージョニング後に `npm install` を実行せずに package-lock.json を不整合のまま放置すること
  - 根拠: `.github/changeset-version.sh` で `changeset version` 後に `npm install` を実行し、lock ファイルの同期を保証している

## 適用チェックリスト

- [ ] `package.json` の `exports` フィールドに記載した全パスがビルド後に実在するか検証するスクリプトを用意し、ビルドコマンドの末尾で自動実行する
- [ ] 品質チェックコマンドを軽量順（format -> lint -> type -> test）に `&&` で直列合成し、`npm run check` 一発で全検査を実行できるようにする
- [ ] ビルドツールのプログラマティック API を使い、`scripts/build.ts` に前後処理を含めたビルドパイプラインを記述する
- [ ] ビルド成果物の `.d.ts` ファイルにフォーマッターを適用するステップをビルドスクリプトに追加する
- [ ] サーバーコードとクライアントコードが混在するパッケージでは、サブディレクトリごとに tsconfig.json を分離し、`types` と `lib` を環境に合わせて設定する
- [ ] デュアルフォーマットが必要なパッケージを特定し、不要なパッケージは ESM-only でビルドする
- [ ] モノレポの場合、sherif 等の一貫性チェックツールを CI に組み込み、依存関係バージョンの不整合を自動検出する
- [ ] Changesets 利用時は `changeset version` 後に `npm install` を実行して lock ファイルの同期を保証するスクリプトを用意する
