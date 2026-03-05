# configuration-patterns

> リポジトリ: shadcn-ui/ui
> 分析日: 2026-03-04

## 概要

shadcn/ui の CLI は、ユーザープロジェクトごとに異なるフレームワーク・ディレクトリ構造・エイリアス設定に適応するために、多層の設定ロード・解決・マージの仕組みを持つ。単一の `components.json` ファイルから cosmiconfig でロードし、Zod で段階的にバリデーションし、tsconfig のパスエイリアスを使って物理パスに解決する設計は、「CLI ツールが多様なプロジェクト構成をどう吸収するか」という課題に対する実践的なアーキテクチャを示している。特に「raw 設定 → resolved 設定」の二層スキーマ設計と、フレームワーク自動検出による暗黙のデフォルト生成は、汎用 CLI ツール開発において参考になる。

## 背景にある原則

- **設定は段階的に解決すべき（Raw → Resolved の分離）**: ユーザーが記述する設定（エイリアス文字列）と実行時に必要な設定（物理パス）は本質的に異なる。これを単一スキーマで扱うと、バリデーション時点で環境依存の解決が必要になり、テストやポータビリティが損なわれる。shadcn/ui は `rawConfigSchema` と `configSchema`（resolvedPaths 付き）を分離することで、ロード時と実行時の責務を明確に分けている（`packages/shadcn/src/registry/schema.ts:28-67`）。

- **環境検出はルックアップテーブルで宣言的に行うべき**: フレームワーク判定のロジックを if/else の連鎖で書くと、新しいフレームワーク追加のたびにロジックが複雑化する。shadcn/ui は `FRAMEWORKS` 定数オブジェクトでフレームワーク情報を宣言的に管理し、検出ロジック（`getProjectInfo`）と分離している（`packages/shadcn/src/utils/frameworks.ts:1-93`）。

- **組み込み設定はユーザー設定と名前空間で区別し、上書きを制御すべき**: 組み込みレジストリ（`@shadcn`）をユーザーが意図せず上書きすると、CLI の動作が壊れる。shadcn/ui は `BUILTIN_REGISTRIES` を定数として管理し、ユーザーが同名のレジストリを定義しようとした場合にエラーを投げるガードを設けている（`packages/shadcn/src/utils/get-config.ts:117-125`）。

- **デフォルト値は明示的なファクトリ関数で生成すべき**: 設定オブジェクトのデフォルト値をスキーマの `.default()` だけに頼ると、部分的なオーバーライドやテスト時のモック生成が困難になる。`createConfig()` ファクトリ関数は DeepPartial を受け取り、常に完全な Config オブジェクトを返すことで、テストや中間状態での安全な利用を保証している（`packages/shadcn/src/utils/get-config.ts:230-285`）。

## 実例と分析

### 二層スキーマによるバリデーションパイプライン

設定のロードは `getRawConfig` → `getConfig` → `resolveConfigPaths` の3段階で行われる。`getRawConfig` は cosmiconfig で JSON をロードし `rawConfigSchema` でバリデーションする。`getConfig` はデフォルト値を補完し、`resolveConfigPaths` で tsconfig のパスエイリアスを物理パスに解決して `configSchema` でパースする。

```typescript
// packages/shadcn/src/utils/get-config.ts:31-44
export async function getConfig(cwd: string) {
  const config = await getRawConfig(cwd);

  if (!config) {
    return null;
  }

  // Set default icon library if not provided.
  if (!config.iconLibrary) {
    config.iconLibrary = config.style === "new-york" ? "radix" : "lucide";
  }

  return await resolveConfigPaths(cwd, config);
}
```

`resolveConfigPaths` では、tsconfig-paths の `loadConfig` を使って tsconfig.json のパスマッピングを読み込み、`resolveImport` でエイリアス（`@/components`）を物理パス（`/project/src/components`）に変換する。必須でないエイリアス（`ui`, `lib`, `hooks`）は存在しない場合に他のエイリアスから相対的に推論される。

```typescript
// packages/shadcn/src/utils/get-config.ts:76-101
ui: config.aliases["ui"]
  ? await resolveImport(config.aliases["ui"], tsConfig)
  : path.resolve(
      (await resolveImport(config.aliases["components"], tsConfig)) ?? cwd,
      "ui"
    ),
lib: config.aliases["lib"]
  ? await resolveImport(config.aliases["lib"], tsConfig)
  : path.resolve(
      (await resolveImport(config.aliases["utils"], tsConfig)) ?? cwd,
      ".."
    ),
```

### フレームワーク自動検出と設定生成

`getProjectInfo` は設定ファイルの存在確認、package.json の依存関係チェック、ディレクトリ構造の検出を `Promise.all` で並列実行し、フレームワークを判定する。判定結果に基づいて `getProjectConfig` が `rawConfigSchema` 準拠の設定を自動生成する。

```typescript
// packages/shadcn/src/utils/get-project-info.ts:39-65
export async function getProjectInfo(cwd: string): Promise<ProjectInfo | null> {
  const [
    configFiles,
    isSrcDir,
    isTsx,
    tailwindConfigFile,
    tailwindCssFile,
    tailwindVersion,
    aliasPrefix,
    packageJson,
  ] = await Promise.all([
    fg.glob("**/{next,vite,astro,app}.config.*|gatsby-config.*|composer.json|react-router.config.*", {
      cwd,
      deep: 3,
      ignore: PROJECT_SHARED_IGNORE,
    }),
    fs.pathExists(path.resolve(cwd, "src")),
    isTypeScriptProject(cwd),
    getTailwindConfigFile(cwd),
    getTailwindCssFile(cwd),
    getTailwindVersion(cwd),
    getTsConfigAliasPrefix(cwd),
    getPackageInfo(cwd, false),
  ]);
  // ... framework detection logic
}
```

フレームワーク固有の設定テンプレートは `getProjectConfig` に集約され、検出された `aliasPrefix` を使ってエイリアスを自動生成する。

```typescript
// packages/shadcn/src/utils/get-project-info.ts:373-394
aliases: {
  components: `${projectInfo.aliasPrefix}/components`,
  ui: `${projectInfo.aliasPrefix}/components/ui`,
  hooks: `${projectInfo.aliasPrefix}/hooks`,
  lib: `${projectInfo.aliasPrefix}/lib`,
  utils: `${projectInfo.aliasPrefix}/lib/utils`,
},
```

### レジストリ設定のユニオン型と環境変数展開

レジストリ設定は文字列（シンプル）とオブジェクト（認証付き）の2つの形式を `z.union` で受け入れる。URL 内の `${VAR}` 構文は `expandEnvVars` で展開される。ヘッダーに含まれる環境変数が未設定の場合、そのヘッダーを省略する（エラーにしない）柔軟な設計になっている。

```typescript
// packages/shadcn/src/registry/schema.ts:6-19
export const registryConfigItemSchema = z.union([
  z.string().refine((s) => s.includes("{name}"), {
    message: "Registry URL must include {name} placeholder",
  }),
  z.object({
    url: z.string().refine((s) => s.includes("{name}"), {
      message: "Registry URL must include {name} placeholder",
    }),
    params: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
]);
```

```typescript
// packages/shadcn/src/registry/builder.ts:120-137
function shouldIncludeHeader(originalValue: string, expandedValue: string) {
  const trimmedExpanded = expandedValue.trim();
  if (!trimmedExpanded) {
    return false;
  }
  if (originalValue.includes("${")) {
    const envVars = originalValue.match(ENV_VAR_PATTERN);
    if (envVars) {
      const templateWithoutVars = originalValue
        .replace(ENV_VAR_PATTERN, "")
        .trim();
      return trimmedExpanded !== templateWithoutVars;
    }
  }
  return true;
}
```

### マルチワークスペース対応

`getWorkspaceConfig` は各エイリアスの解決先パスが現在の `cwd` と異なるパッケージルートに属するかを検出し、そのパッケージルートで別の `getConfig` を実行する。これにより、monorepo で `@workspace/ui/components` のようなクロスパッケージエイリアスを持つ設定が正しく解決される。

```typescript
// packages/shadcn/src/utils/get-config.ts:142-170
export async function getWorkspaceConfig(config: Config) {
  let resolvedAliases: any = {};
  for (const key of Object.keys(config.aliases)) {
    if (!isAliasKey(key, config)) continue;
    const resolvedPath = config.resolvedPaths[key];
    const packageRoot = await findPackageRoot(
      config.resolvedPaths.cwd,
      resolvedPath,
    );
    if (!packageRoot) {
      resolvedAliases[key] = config;
      continue;
    }
    resolvedAliases[key] = await getConfig(packageRoot);
  }
  const result = workspaceConfigSchema.safeParse(resolvedAliases);
  if (!result.success) return null;
  return result.data;
}
```

### 設定のバックアップとアトミック書き込み

`init` コマンドは `components.json` の書き込み前にバックアップを作成し、プロセス終了時にエラーコードに応じてバックアップの復元または削除を行う。

```typescript
// packages/shadcn/src/commands/init.ts:51-61
process.on("exit", (code) => {
  const filePath = path.resolve(process.cwd(), "components.json");
  if (code === 0) {
    return deleteFileBackup(filePath);
  }
  return restoreFileBackup(filePath);
});
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: フレームワークごとに異なるデフォルト設定やファイル配置ルールを統一的に扱う
  - 適用条件: CLI ツールが複数のフレームワーク/プロジェクト構成をサポートする場合
  - コード例: `packages/shadcn/src/utils/frameworks.ts:1-93` の FRAMEWORKS 定数、`packages/shadcn/src/utils/updaters/update-files.ts:394-415` の `resolveFileTargetDirectory`
  - 注意点: フレームワーク検出の優先順位が重要。Remix は Vite ベースのため、先に判定する必要がある

- **Builder パターン** (分類: 生成)
  - 解決する問題: 設定オブジェクトの段階的構築（raw → defaults → resolved → merged）
  - 適用条件: 設定が複数のソースからマージされ、段階的に完成する場合
  - コード例: `packages/shadcn/src/registry/config.ts:20-37` の `configWithDefaults`、`packages/shadcn/src/utils/get-config.ts:230-285` の `createConfig`
  - 注意点: deep merge は参照共有によるバグを招く。`createConfig` は毎回新しいオブジェクトを返すことをテストで検証している

## Good Patterns

- **Zod スキーマの段階的拡張（rawConfigSchema → configSchema）**: `rawConfigSchema` をベースに `.extend()` で `resolvedPaths` を追加して `configSchema` を定義する。ユーザー入力のバリデーションと実行時バリデーションで同じベーススキーマを共有しつつ、実行時のみ必要なフィールドを型安全に追加できる。

```typescript
// packages/shadcn/src/registry/schema.ts:56-67
export const configSchema = rawConfigSchema.extend({
  resolvedPaths: z.object({
    cwd: z.string(),
    tailwindConfig: z.string(),
    tailwindCss: z.string(),
    utils: z.string(),
    components: z.string(),
    lib: z.string(),
    hooks: z.string(),
    ui: z.string(),
  }),
});
```

- **DeepPartial + ファクトリ関数によるテスタブルな設定生成**: `createConfig` は `DeepPartial<Config>` を受け取り、明示的なスプレッドで各ネストレベルをマージする。これにより、テストで任意のプロパティだけをオーバーライドしつつ、常に型安全な完全オブジェクトが得られる。

```typescript
// packages/shadcn/src/utils/get-config.ts:219-285
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export function createConfig(partial?: DeepPartial<Config>): Config {
  const defaultConfig: Config = {/* all fields with defaults */};
  if (partial) {
    return {
      ...defaultConfig,
      ...partial,
      resolvedPaths: { ...defaultConfig.resolvedPaths, ...(partial.resolvedPaths || {}) },
      tailwind: { ...defaultConfig.tailwind, ...(partial.tailwind || {}) },
      aliases: { ...defaultConfig.aliases, ...(partial.aliases || {}) },
      registries: { ...defaultConfig.registries, ...(partial.registries || {}) },
    };
  }
  return defaultConfig;
}
```

- **環境変数の段階的展開（テンプレート保持 → 実行時展開）**: レジストリ URL やヘッダーの `${VAR}` は設定ファイルにテンプレートとして保持され、実際の API コール時に `expandEnvVars` で展開される。未設定の環境変数を持つヘッダーはスキップされ、エラーにならない。

```typescript
// packages/shadcn/src/registry/env.ts:1-4
export function expandEnvVars(value: string) {
  return value.replace(/\${(\w+)}/g, (_match, key) => process.env[key] || "");
}
```

## Anti-Patterns / 注意点

- **設定マージ時の resolvedPaths リーク**: `components.json` にシリアライズする際に `resolvedPaths`（物理パス）を含めてしまうと、ポータビリティが失われる。shadcn/ui では `registries.ts:83` で明示的にデストラクチャリングして除外しているが、マージ処理の各所で注意が必要。

```typescript
// Bad: resolvedPaths を含んだまま JSON にシリアライズ
await fs.writeFile(configPath, JSON.stringify(config, null, 2));

// Better: resolvedPaths を除外してからシリアライズ
const { resolvedPaths, ...configWithoutResolvedPaths } = config;
const updatedConfig = rawConfigSchema.parse(configWithoutResolvedPaths);
await fs.writeFile(configPath, JSON.stringify(updatedConfig, null, 2));
```

- **検出ロジックの順序依存**: `getProjectInfo` ではフレームワーク検出が if/else チェーンで行われ、順序が意味を持つ（例: Remix は Vite より先に判定される必要がある）。新規フレームワーク追加時に順序を誤ると既存の検出が壊れる。

```typescript
// Bad: 順序を考慮せず追加
if (configFiles.find((file) => file.startsWith("vite.config."))?.length) { ... }
if (configFiles.find((file) => file.startsWith("remix.config."))?.length) { ... }

// Better: Remix は Vite ベースのため先に判定
// Some Remix templates also have a vite.config.* file.
// We'll assume that it got caught by the Remix check above.
if (isRemixProject) { ... }
if (configFiles.find((file) => file.startsWith("vite.config."))?.length) { ... }
```

## 導出ルール

- `[MUST]` CLI ツールの設定スキーマは「ユーザー入力用（raw）」と「実行時用（resolved）」を分離し、Zod の `.extend()` で型安全に接続する
  - 根拠: shadcn/ui は `rawConfigSchema` と `configSchema` を分離し、物理パス解決を実行時にのみ行うことで、設定のポータビリティとテスタビリティを両立している（`schema.ts:28-67`）

- `[MUST]` 設定ファイルにシリアライズする際は実行時のみ必要なフィールド（解決済みパス、キャッシュなど）を除外する
  - 根拠: `resolvedPaths` を含んだまま `components.json` に書き込むとポータビリティが壊れるため、`rawConfigSchema.parse()` でフィルタリングしている（`registries.ts:83-88`）

- `[SHOULD]` 設定オブジェクトの生成には DeepPartial を受け取るファクトリ関数を提供し、テストや中間状態でも型安全な完全オブジェクトを返す
  - 根拠: `createConfig()` は任意の部分オーバーライドから完全な Config を生成し、テストで各プロパティの独立性と新規インスタンスの生成を検証している（`get-config.test.ts:200-324`）

- `[SHOULD]` 環境変数のテンプレート展開は設定ロード時ではなく実行時（API コール時）に行い、未設定の変数はエラーではなくスキップで処理する
  - 根拠: `expandEnvVars` は URL 構築時に呼ばれ、未設定のヘッダーは `shouldIncludeHeader` でスキップされる。これにより、オプショナルな認証設定を持つレジストリが環境変数なしでも部分的に動作する（`builder.ts:120-137`）

- `[SHOULD]` 設定ファイルの書き込み前にバックアップを作成し、プロセス異常終了時に復元する
  - 根拠: `init` コマンドは `process.on("exit")` でバックアップの復元/削除を行い、途中失敗時の設定ファイル破損を防止している（`init.ts:51-61`）

- `[SHOULD]` フレームワーク検出のメタデータ（名前、ラベル、リンク等）は検出ロジックから分離した宣言的な定数オブジェクトで管理する
  - 根拠: `FRAMEWORKS` 定数は検出ロジック（`getProjectInfo`）から独立しており、新フレームワーク追加時にメタデータの変更が検出ロジックに影響しない（`frameworks.ts:1-93`）

- `[AVOID]` 組み込み設定とユーザー設定を同じ名前空間で無制限にマージする（組み込みキーの上書きガードを設けること）
  - 根拠: `getRawConfig` はユーザーが `BUILTIN_REGISTRIES` のキーを上書きしようとした場合にエラーを投げ、CLI の基本動作が壊れることを防止している（`get-config.ts:117-125`）

## 適用チェックリスト

- [ ] 設定スキーマを「ユーザー入力用」と「実行時用」の2層に分離しているか
- [ ] 設定ファイルへの書き戻し時に実行時専用フィールドを除外しているか
- [ ] 設定のデフォルト値生成に DeepPartial ファクトリ関数を用意し、テストで部分オーバーライドを検証しているか
- [ ] 環境変数のテンプレート展開タイミングは実行時か（ロード時に展開していないか）
- [ ] 設定ファイルの書き込みにバックアップ/復元の仕組みがあるか
- [ ] フレームワーク検出ロジックとメタデータが分離されているか
- [ ] 組み込み設定キーのユーザー上書きを禁止するガードがあるか
- [ ] 複数フレームワークの検出順序が正しいか（親子関係にあるフレームワークの優先順位）
- [ ] monorepo 環境でクロスパッケージのエイリアスが正しく解決されるか
