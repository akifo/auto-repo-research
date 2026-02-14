# Build and Tooling

> リポジトリ: mastra-ai/mastra
> 分析日: 2026-02-14

## 概要

mastra は 80 以上のパッケージを持つ大規模 TypeScript モノレポで、Turborepo + pnpm workspaces + tsup による高度に構造化されたビルドパイプラインを実現している。特筆すべきは、tsup でバンドル生成 → tsc で型宣言生成 → 後処理スクリプトで .d.ts パス修正、という 3 段階のビルドプロセスを `@internal/types-builder` という内部ツールで統一的に管理している点である。加えて、パッケージレベルの `turbo.json` オーバーライドによるビルドステップの細粒度制御、pnpm catalog による依存バージョンの一元管理、changeset の `fixed` グループによるコアパッケージのバージョン同期など、大規模モノレポの運用に特化したプラクティスが多数存在する。

## 背景にある原則

- **ビルドの関心分離**: バンドル（tsup）と型生成（tsc + カスタムツール）を分離することで、各段階を独立に最適化できる。tsup に型生成を任せず `dts: false` とし、`onSuccess` フックで tsc ベースの型生成を実行する設計は、tsup の DTS 生成が大規模プロジェクトで不安定になる問題を回避するための意図的な選択（`packages/core/tsup.config.ts`）。

- **段階的タスク合成**: ルート `turbo.json` は最小限の汎用タスク定義（`build`, `lint`, `clean`, `dev` の 4 つ）のみを持ち、パッケージごとの `turbo.json` で `extends: ["//"]` を使って具体的なタスク依存関係・入出力を定義する。パッケージの複雑度に応じてビルドステップ数が 2（リーフ）から 3（コアパッケージ）に変化する、宣言的なパイプライン分岐を実現している。

- **依存バージョンの単一真実源**: pnpm catalog + `resolutions` で `typescript`, `vitest`, `@types/node` 等の共通依存のバージョンを一元管理する。各パッケージは `"catalog:"` で参照するだけであり、バージョン不整合のリスクを構造的に排除している（`pnpm-workspace.yaml:23-30`）。

- **ビルド成果物の自動検証**: CI パイプラインに `e2e-tests/pkg-outputs` テストスイートを組み込み、全パッケージの `exports` フィールドで宣言されたファイルが実際に `dist/` に存在することを自動検証する。export マップの不整合を publish 前に機械的に検出する仕組みである。

## 実例と分析

### 3 段階ビルドパイプライン

mastra のライブラリパッケージのビルドは以下の 3 段階で構成される。

**Stage 1: tsup バンドル生成** (`build:lib`)
tsup が ESM + CJS の dual format でバンドルを生成する。`dts: false` により型宣言生成をスキップし、ビルド速度を優先。`treeshake: { preset: 'smallest' }` と `splitting: true` で最適なチャンク分割を行う。

**Stage 2: tsc 型宣言生成** (`onSuccess` 内で `generateTypes()`)
tsup の `onSuccess` フックから `@internal/types-builder` の `generateTypes()` を呼び出す。この関数は `tsc -p tsconfig.build.json` を実行して `.d.ts` ファイルを生成し、さらに相対インポートパスに `.js` 拡張子を自動付加する後処理を行う。

**Stage 3: CJS パッチ** (`build:patch-commonjs`、core/server 等の一部パッケージ)
`commonjs-tsc-fixer.js` が `package.json` の `exports` フィールドを解析し、CJS 向けの `.d.ts` エントリポイントファイルを自動生成する。

### Turborepo タスクグラフの二層設計

ルートの `turbo.json` はシンプルな汎用定義のみを持つ。

```json
// turbo.json:1-24
{
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**", "!.next/cache/**"]
    },
    "dev": {
      "dependsOn": ["^build"],
      "cache": false,
      "persistent": true
    }
  }
}
```

パッケージごとの turbo.json で `extends: ["//"]` を使い、複雑度に応じたオーバーライドを行う。`@mastra/core` は三段階パイプラインを定義する。

```json
// packages/core/turbo.json:1-28
{
  "extends": ["//"],
  "tasks": {
    "build": {
      "dependsOn": ["build:patch-commonjs", "build:lib"],
      "inputs": ["package.json"]
    },
    "build:patch-commonjs": {
      "dependsOn": ["build:lib"],
      "outputs": ["./**/*.d.ts"]
    },
    "build:lib": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", "!dist/docs/**"],
      "inputs": [
        "src/**", "tsup.config.ts", "tsconfig.json", "package.json",
        "!**/*.md", "!**/*.test.ts", "!**/*.spec.ts", "!**/__tests__/**"
      ]
    }
  }
}
```

CLI パッケージは `@internal/playground` の build に明示的に依存する cross-package 参照も行う。

```json
// packages/cli/turbo.json:10-12
"build": {
  "dependsOn": ["^build", "build:lib", "@internal/playground#build"]
}
```

リーフパッケージ（stores, observability 等）は最小構成で済ませる。

```json
// stores/pg/turbo.json:1-13
{
  "extends": ["//"],
  "tasks": {
    "build:lib": { "dependsOn": ["^build"], "outputs": ["dist/**", "!dist/docs/**"] },
    "build": { "dependsOn": ["build:lib"] }
  }
}
```

### tsconfig の三層構成

- `tsconfig.node.json` (ルート): パッケージ開発のベース。`module: "Preserve"`, `verbatimModuleSyntax: true`, `noEmit: true`
- `tsconfig.json` (パッケージ): `extends: "../../tsconfig.node.json"` でベースを継承、パッケージ固有の `include`/`exclude` を定義
- `tsconfig.build.json` (パッケージ): `extends: ["./tsconfig.json", "../../tsconfig.build.json"]` で二重継承。`emitDeclarationOnly: true`, `moduleResolution: "bundler"` でビルド専用設定を適用

```json
// tsconfig.build.json (ルート):1-13
{
  "compilerOptions": {
    "noEmit": false,
    "emitDeclarationOnly": true,
    "declaration": true,
    "declarationMap": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "target": "ES2022"
  }
}
```

```json
// packages/core/tsconfig.build.json:1-9
{
  "extends": ["./tsconfig.json", "../../tsconfig.build.json"],
  "compilerOptions": { "outDir": "./dist", "rootDir": "./src" },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "**/*.test.ts", "src/**/*.mock.ts", "**/__tests__/**"]
}
```

### 内部ツールパッケージの活用

`@internal/*` 命名規約 + `private: true` で内部専用パッケージを管理する。

- **`@internal/types-builder`**: 全パッケージの型宣言生成を統一。`generateTypes()` で tsc 実行 + `.d.ts` パス修正。`replaceTypes()` でバンドル対象パッケージの型をインライン化。
- **`@internal/lint`**: ESLint 設定を `createConfig()` ファクトリ関数として共有。`import.meta.resolve()` で依存を動的検出し、React/Vitest/TestingLibrary がある場合のみルールを追加。
- **`@internal/external-types`**: 外部ライブラリの型定義を `api-extractor` でバンドルし、消費者側の型解決を安定化。
- **`@internal/ai-sdk-v4/v5/v6`**: AI SDK の複数メジャーバージョンをベンダリングし、ts-morph で `.d.ts` の AST を修正する高度な後処理を実装。

### Changeset の固定バージョングループ

```json
// .changeset/config.json:8
"fixed": [
  ["@mastra/core", "@mastra/server", "@mastra/deployer", "@mastra/deployer-cloud"],
  ["mastra", "create-mastra", "@internal/playground"]
]
```

コアパッケージ群と CLI パッケージ群をそれぞれ固定グループとし、グループ内のいずれかが変更されると全メンバーが同一バージョンにバンプされる。`bumpVersionsWithWorkspaceProtocolOnly: true` で workspace: 依存のみバンプ対象とし、不要なバージョン変更を防止。

### ビルド出力の E2E 検証

`e2e-tests/pkg-outputs/bundle.test.ts` が全パッケージの `exports` フィールドを走査し、宣言されたファイルの実在を検証する。

```typescript
// e2e-tests/pkg-outputs/bundle.test.ts:27-57
it('should have type="module"', () => {
  expect(pkgJson.type).toBe('module');
});

it('should use .js and .d.ts extensions when using import', async () => {
  const exportConfig = pkgJson.exports[importPath] as any;
  expect(exportConfig.import).toBeDefined();
  expect(extname(exportConfig.import.default)).toMatch(/\.js$/);
  expect(exportConfig.import.types).toMatch(/\.d\.ts$/);
  const pathsOnDisk = await globby(join(__dirname, '..', pkgName, fileOutput[0]));
  for (const pathOnDisk of pathsOnDisk) {
    await expect(stat(pathOnDisk)).resolves.toBeDefined();
  }
});
```

### Vitest ワークスペース自動検出

ルート `vitest.config.ts` が glob パターンで全パッケージの vitest 設定を自動検出し、ネストされたプロジェクト定義を展開する。パッケージ側は `unit:`, `e2e:`, `typecheck:` のプレフィックスで命名規約を統一し、CI のシャーディング (`--shard=1/4`) と `--project 'unit:*'` フィルタリングを可能にしている。

```typescript
// packages/core/vitest.config.ts:3-36
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit:packages/core', include: ['src/**/*.test.ts'], exclude: ['src/**/*.e2e.test.ts'] } },
      { test: { name: 'e2e:packages/core', include: ['src/**/*.e2e.test.ts'] } },
      { test: { name: 'typecheck:packages/core', typecheck: { enabled: true, include: ['src/**/*.test-d.ts'] } } },
    ],
  },
});
```

## コード例

```typescript
// packages/_types-builder/src/index.js:36-109
// tsup の onSuccess から呼ばれる型宣言生成 + パス修正処理
export async function generateTypes(rootDir, bundledPackages = new Set()) {
  const tscProcess = spawn('npx', ['tsc', '-p', 'tsconfig.build.json'], {
    cwd: rootDir, stdio: 'inherit', shell: true, env: getFilteredEnv(),
  });
  // .d.ts ファイルの相対インポートに .js 拡張子を付加
  const dtsFiles = await globby('dist/**/*.d.ts', { cwd: rootDir });
  for (const dtsFile of dtsFiles) {
    code = code.replace(rgxFrom, (_, p) => {
      if (!(p.startsWith('./') || p.startsWith('../')) || p.endsWith('.js')) return `'${p}'`;
      try {
        if (statSync(path.join(path.dirname(fullPath), p)).isDirectory()) return `'${p}/index.js'`;
      } catch {}
      return `'${p}.js'`;
    });
  }
}
```

```javascript
// packages/_config/src/eslint.js:7-18
// 依存検出による条件付きルール適用
const has = pkg => {
  try { import.meta.resolve(pkg, import.meta.url); return true; }
  catch { return false; }
};
const hasTypeScript = has('typescript');
const hasReact = has('react');
```

```javascript
// scripts/commonjs-tsc-fixer.js:14-54
// package.json の exports を解析し、CJS 向け .d.ts エントリポイントを自動生成
async function writeDtsFiles() {
  const packageJson = JSON.parse(await readFile(join(rootPath, 'package.json')));
  for (const [key, value] of Object.entries(packageJson.exports)) {
    if (key !== '.' && value.require?.types) {
      // .d.ts ファイルを dist から re-export するスタブを生成
      await writeFile(targetPath,
        `export * from './${relative(dirname(targetPath), file).replace('/index.d.ts', '')}';`
      );
    }
  }
}
```

## パターンカタログ

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: 80 以上のパッケージで統一されたビルドプロセスを維持しつつ、パッケージ固有のカスタマイズを許容する
  - 適用条件: ビルド手順の骨格（tsup -> 型生成 -> 後処理）が共通で、各ステップの詳細がパッケージごとに異なる場合
  - コード例: `tsup.config.ts` の `onSuccess` フック + `turbo.json` の `extends: ["//"]`
  - 注意点: テンプレート部分（`@internal/types-builder`）の変更が全パッケージに波及するため、慎重なテストが必要

- **Pipeline パターン** (分類: 構造)
  - 解決する問題: ビルドの各段階（バンドル → 型生成 → パッチ）の依存関係を明示的に管理したい
  - 適用条件: Turborepo の `dependsOn` でタスク間の DAG を構築
  - コード例: `packages/core/turbo.json:5-7` の `build → build:patch-commonjs → build:lib`
  - 注意点: ステップ数は 3 以下に留める。デバッグ困難な暗黙の依存を避けるため、タスク名に処理内容を反映させる

## Good Patterns

- **`dts: false` + カスタム型生成**: tsup の内蔵 DTS 生成を無効化し、tsc で `.d.ts` を別途生成することでビルド速度と型の正確性を両立する。全 80+ パッケージで統一的に適用されている。

- **Turborepo `inputs` による精密なキャッシュ制御**: テストファイルやドキュメントの変更でビルドキャッシュが無効化されないよう、除外パターンを明示する。

```json
// packages/core/turbo.json:17-27
"inputs": [
  "src/**", "tsup.config.ts", "tsconfig.json", "package.json",
  "!**/*.md", "!**/*.test.ts", "!**/*.spec.ts", "!**/__tests__/**"
]
```

- **ESLint 設定の共有パッケージ化**: `@internal/lint` パッケージの `createConfig()` ファクトリ関数で設定を生成し、パッケージ側は差分だけを追加する。

```javascript
// packages/core/eslint.config.js:1-11
import { createConfig } from '@internal/lint/eslint';
const config = await createConfig();
export default [...config, { ignores: ['./*.d.ts', '**/*.d.ts', '!src/**/*.d.ts'] }];
```

- **Vitest プロジェクト命名規約**: `unit:`, `e2e:`, `typecheck:` プレフィックスで CI のフィルタリングとシャーディングを可能にする。`--project 'unit:*' --shard=1/4` のように組み合わせられる。

## Anti-Patterns / 注意点

- **tsup の `dts: true` をモノレポでそのまま使う**: tsup 内蔵の DTS 生成は rollup-plugin-dts に依存しており、ワークスペース間の型参照やパス解決で問題が発生しやすい。

```typescript
// Bad: tsup 内蔵 DTS に依存
export default defineConfig({ entry: ['src/index.ts'], dts: true });

// Better: 型生成を分離して制御
export default defineConfig({
  entry: ['src/index.ts'],
  dts: false,
  onSuccess: async () => { await generateTypes(process.cwd()); },
});
```

- **Turborepo `inputs` 未指定でキャッシュ効率を下げる**: `inputs` を指定しないと、テストファイルや Markdown の変更でもビルドキャッシュが無効化される。

```jsonc
// Bad: inputs 未指定
{ "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] } }

// Better: ビルドに影響しないファイルを除外
{ "build": { "dependsOn": ["^build"], "outputs": ["dist/**"],
  "inputs": ["src/**", "tsup.config.ts", "!**/*.test.ts", "!**/*.md"] } }
```

## 導出ルール

- `[MUST]` モノレポでは共通 devDependencies のバージョンを pnpm catalog や resolutions で単一真実源に集約する
  - 根拠: mastra は `pnpm-workspace.yaml` の `catalog` と `package.json` の `resolutions` で typescript, vitest 等のバージョンを一元管理し、80+ パッケージ間のバージョン不整合を構造的に排除している

- `[MUST]` ライブラリパッケージの `exports` フィールドで宣言した全エントリに対し、実ファイルの存在を自動テストで検証する
  - 根拠: `e2e-tests/pkg-outputs/bundle.test.ts` が全パッケージの export マップを走査し `.js`/`.cjs`/`.d.ts` ファイルの存在をテスト。export の追加・削除時の不整合は手動レビューでは見落としやすい

- `[SHOULD]` tsup/esbuild で `dts: false` を設定し、型宣言は tsc で別途生成する（大規模モノレポの場合）
  - 根拠: mastra は全パッケージで `dts: false` を徹底し、`@internal/types-builder` で tsc ベースの型生成を統一。ビルド速度と型の正確性（declarationMap 含む）を両立している

- `[SHOULD]` Turborepo の `inputs` に否定パターン（`!**/*.test.ts`, `!**/*.md`）を指定してキャッシュヒット率を向上させる
  - 根拠: mastra の各パッケージ turbo.json で `.test.ts`, `.spec.ts`, `.md`, `__tests__/` を除外し、ビルドに無関係な変更でのキャッシュ無効化を防いでいる

- `[SHOULD]` 内部共有パッケージは `@internal/*` のような明示的命名規約 + `private: true` で管理し、changeset の `ignore` リストに含める
  - 根拠: mastra は `@internal/types-builder`, `@internal/lint` 等を private パッケージとし、changeset の ignore で公開パイプラインから除外している

- `[SHOULD]` Changeset の `fixed` グループで、API 境界を共有するパッケージのバージョンを同期する
  - 根拠: `@mastra/core`, `@mastra/server`, `@mastra/deployer` を fixed グループにし、いずれかの変更で全パッケージが同一バージョンにバンプされる

- `[SHOULD]` Vitest プロジェクトに `unit:`, `e2e:`, `typecheck:` のようなプレフィックス命名規約を設け、CI でのフィルタリング・シャーディングを可能にする
  - 根拠: mastra は CI で `--project 'unit:*' --shard=1/4` としてユニットテストのみを 4 並列実行し、`--project 'e2e:stores/*'` で特定カテゴリの E2E テストのみを実行している

- `[AVOID]` ルートの Turborepo タスク定義だけでビルドを制御する（パッケージ固有のビルドステップが出たときに破綻する）
  - 根拠: mastra はルート turbo.json を 4 タスクのみに留め、パッケージ固有のステップはパッケージレベルの turbo.json で `extends: ["//"]` を用いて定義している

- `[AVOID]` TypeScript のエディタ用設定（`noEmit: true`）とビルド出力設定（`emitDeclarationOnly: true`）を 1 つの tsconfig に混在させる
  - 根拠: mastra は `tsconfig.json`（エディタ用）と `tsconfig.build.json`（ビルド用）を分離し、用途別に `module`, `moduleResolution` 等を最適化している

## 適用チェックリスト

- [ ] モノレポの共通 devDependencies（typescript, vitest, eslint 等）を pnpm catalog や resolutions で一元管理しているか
- [ ] tsup/esbuild で `dts: false` を設定し、tsc で型宣言を別途生成するパイプラインを構築しているか（大規模プロジェクトの場合）
- [ ] `package.json` の `exports` フィールドの全エントリに対し、ファイル存在を検証する自動テストがあるか
- [ ] Turborepo の `inputs` でテストファイルやドキュメントを除外してキャッシュヒット率を最適化しているか
- [ ] 内部共有パッケージに `private: true` を設定し、changeset の ignore リストに含めているか
- [ ] `tsconfig.json`（エディタ用）と `tsconfig.build.json`（ビルド用）を分離しているか
- [ ] CI で Turbo Remote Cache を使用してビルド時間を短縮しているか
- [ ] `preinstall` スクリプトまたは `packageManager` フィールドでパッケージマネージャを強制しているか
- [ ] Changeset の `fixed` グループで API 境界を共有するパッケージのバージョンを同期しているか
- [ ] Vitest プロジェクトに命名規約を設け、CI でのフィルタリング・シャーディングが可能か
