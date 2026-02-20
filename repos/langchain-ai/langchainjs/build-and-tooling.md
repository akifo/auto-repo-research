# Build and Tooling

> リポジトリ: langchain-ai/langchainjs
> 分析日: 2026-02-20

## 概要

langchainjs は 40 以上のパッケージを持つ大規模モノレポで、tsdown (rolldown ベース) によるデュアルフォーマット (ESM/CJS) ビルド、Turborepo によるタスクオーケストレーション、Docker ベースのマルチ環境テスト (ESM, CJS, Cloudflare Workers, Vercel, Vite, esbuild, Bun) を組み合わせた堅牢なビルドパイプラインを構築している。特筆すべきは `@langchain/build` という内部パッケージに全ビルドロジックを集約し、個々のパッケージの `tsdown.config.ts` を極限まで簡素化している点である。

## 背景にある原則

- **ビルド設定の一元化 (Single Source of Truth)**: 40 以上のパッケージがそれぞれ独自のビルド設定を持つと保守が破綻する。`@langchain/build` に `getBuildConfig()` 関数を集約し、各パッケージは 3-10 行の設定で済む設計にすることで、ビルドの一貫性と保守性を両立している。根拠: `libs/providers/langchain-openai/tsdown.config.ts` は 10 行のみ。

- **消費者視点の品質保証 (Consumer-First Validation)**: ライブラリの品質は「作り手のテストが通ること」ではなく「消費者の環境で正しく動くこと」で定義すべきである。9 種類のランタイム環境で実際に import/require して動作検証する仕組みが、exports 設定の不整合を CI レベルで検出する。根拠: `environment_tests/docker-compose.yml` で ESM, CJS, CF Workers, Vercel, Vite, esbuild, Bun, tsc, Node Classic の 9 環境を検証。

- **プラグインによるビルド時コード生成**: import map, secrets map, import constants といった定型的なコードをビルド時に自動生成することで、手動管理の負担とミスを排除する。根拠: `internal/build/src/plugins/` 配下の 4 つのプラグインがすべて `Auto-generated ... Do not edit manually` コメント付きファイルを生成。

- **依存範囲の境界テスト**: semver で指定した依存範囲の「最新」と「最小」の両端で動作することを Docker コンテナ内で検証する。中間バージョンは省略しても、両端が通れば実用上の互換性は高い。根拠: `dependency_range_tests/` の `test-with-latest-deps.sh` と `test-with-lowest-deps.sh`。

## 実例と分析

### 共有ビルドユーティリティ `@langchain/build`

ビルドの中核は `internal/build/src/index.ts` の `getBuildConfig()` 関数である。この関数は以下のデフォルトを提供する:

- デュアルフォーマット出力 (`cjs` + `esm`)
- ES2022 ターゲット
- `unbundle: true` (transpile-only モード、依存は外部のまま保持)
- tsgo による並列 DTS 生成 (`dts.tsgo: true`)
- ATTW (Are The Types Wrong?) による型チェック (`attw.profile: "node16"`)
- publint による package.json 検証
- 未使用エクスポート検出

各パッケージはこの関数を呼び出し、必要に応じて `entry` とプラグインのみをオーバーライドする。

### CJS 互換性レイヤー: cjsCompatPlugin

`type: "module"` パッケージで CJS 消費者を支援するため、`cjsCompatPlugin` がルートレベルにバレルファイルを自動生成する。例えば `@langchain/core/prompts` というサブパスエクスポートに対して、ルートに `prompts.cjs`, `prompts.d.cts`, `prompts.js`, `prompts.d.ts` を生成し、それぞれが `./dist/prompts/index.cjs` などへ re-export する。

このプラグインは `BUILD_MODE` 環境変数で制御され、`prerelease` モードでは生成、通常モードではクリーンアップを行う。また、生成したファイルパスを `package.json` の `files` フィールドに自動追記する。

### Turborepo のタスク依存グラフ

`turbo.json` のルート設定で `build:compile` タスクに `"dependsOn": ["^build:compile"]` を指定し、パッケージ間の依存関係に基づくビルド順序を自動解決する。テストタスクは `"dependsOn": ["build:compile"]` で、自パッケージのビルド完了を待つ。

各パッケージは `turbo.json` を `"extends": ["//"]` で継承し、生成ファイルの除外 (`!src/load/import_map.ts` 等) のみをオーバーライドする。

### Docker ベースのマルチ環境テスト

`environment_tests/` には 9 つの環境テストプロジェクトがあり、それぞれが独立した `package.json` を持つ。Docker コンテナ内で `test-runner.ts` が以下のステップを実行する:

1. テストパッケージファイルをサンドボックスにコピー
2. ワークスペースパッケージをローカルリンクとしてセットアップ
3. 依存関係をインストール
4. ワークスペースリンクが正しいことを検証 (npm レジストリからの意図しないインストールを検出)
5. ビルドを実行
6. テストを実行

この検証ステップ (`verifyLocalPackages`) は特に重要で、pnpm の `.pnpm` ストアを走査して本番版が紛れ込んでいないかを確認する。

### Changesets によるバージョン管理

`.changeset/config.json` で `fixed` グループ (Google 関連 6 パッケージが同期バージョニング) と `updateInternalDependencies: "patch"` を設定。内部依存の更新を patch レベルに抑えることで、頻繁なリリースでもバージョン番号の急増を防ぐ。

## コード例

```ts
// internal/build/src/index.ts:53-130
export function getBuildConfig(options?: Partial<BuildOptions>): BuildOptions {
  return {
    format: ["cjs", "esm"],
    target: "es2022",
    platform: "node",
    fixedExtension: false,
    dts: {
      parallel: true,
      tsgo: true,
      build: true,
    },
    sourcemap: true,
    unbundle: true,
    inlineOnly: false,
    exports: {
      customExports: async (exports) => {
        return Object.entries(exports).reduce(
          (acc, [key, value]) => {
            if (
              typeof value === "object"
              && value !== null
              && "import" in value
            ) {
              const importValue = value.import.replace(/\\/g, "/");
              const dir = path.posix.dirname(importValue);
              const base = path.posix.basename(
                importValue,
                path.posix.extname(importValue),
              );
              const outputPath = path.posix.join(dir, base);
              const inputPath = path.posix.join(
                dir.replace("./dist", "./src"),
                `${base}.ts`,
              );
              acc[key] = {
                input: `./${inputPath}`,
                require: {
                  types: `./${outputPath}.d.cts`,
                  default: `./${outputPath}.cjs`,
                },
                import: {
                  types: `./${outputPath}.d.ts`,
                  default: `./${outputPath}.js`,
                },
              };
            } else {
              acc[key] = value;
            }
            return acc;
          },
          {} as Record<string, PackageJson.ExportConditions>,
        );
      },
    },
    attw: { profile: "node16", level: "error" },
    publint: { level: "error", strict: true },
    unused: { level: "error" },
    ...options,
  };
}
```

```ts
// libs/providers/langchain-openai/tsdown.config.ts:1-10
import { cjsCompatPlugin, getBuildConfig } from "@langchain/build";

export default getBuildConfig({
  entry: ["./src/index.ts"],
  plugins: [
    cjsCompatPlugin({
      files: ["dist/", "CHANGELOG.md", "README.md", "LICENSE"],
    }),
  ],
});
```

```ts
// environment_tests/scripts/test-runner.ts:307-391 (verifyLocalPackages)
private async verifyLocalPackages(): Promise<void> {
  // ... symlink 検証で workspace 依存が正しく解決されたことを確認
  const stats = await fs.lstat(pkgPath);
  if (stats.isSymbolicLink()) {
    const linkTarget = await fs.readlink(pkgPath);
    console.log(`  ✓ ${pkgName} → ${linkTarget} (workspace)`);
  } else {
    errors.push(`${pkgName} is not a workspace dependency!`);
  }
}
```

## パターンカタログ

- **Template Method (振る舞い)** - `getBuildConfig()` + プラグイン
  - 解決する問題: 40 以上のパッケージで一貫したビルド設定を維持しつつ、パッケージ固有のカスタマイズを許可する
  - 適用条件: モノレポで共通ビルドパイプラインを持つ場合
  - コード例: `internal/build/src/index.ts:53`
  - 注意点: デフォルトのスプレッド (`...options`) は浅いマージなので、ネストされたオプション (例: `dts`) は完全に上書きされる

- **Plugin / Strategy (振る舞い)** - ビルド時コード生成プラグイン群
  - 解決する問題: ビルドプロセスの拡張ポイントを型安全に提供する
  - 適用条件: ビルド時に定型コードの生成・変換が必要な場合
  - コード例: `internal/build/src/plugins/cjs-compat.ts:75`, `import-map.ts:78`, `lc-secrets.ts:92`, `import-constants.ts:129`
  - 注意点: プラグインは Rolldown の `Plugin` 型に準拠しており、バンドラー固有のフック (`buildStart`, `buildEnd`) に依存する

## Good Patterns

- **ビルド設定のファクトリ関数パターン**: `getBuildConfig()` が合理的なデフォルトを返し、各パッケージは差分だけを指定する。40 以上のパッケージで同じビルド設定を維持する際に、設定の複製を排除し、変更を一箇所で行える。

```ts
// 各パッケージの tsdown.config.ts は極限まで簡素
import { cjsCompatPlugin, getBuildConfig } from "@langchain/build";
export default getBuildConfig({
  entry: ["./src/index.ts"],
  plugins: [cjsCompatPlugin({ files: ["dist/", "CHANGELOG.md", "README.md", "LICENSE"] })],
});
```

- **ATTW + publint によるビルド出力の自動検証**: ビルド時に型の互換性 (ATTW) と package.json の正当性 (publint) を自動チェックする。壊れた型定義やエクスポートが npm に公開されることを防ぐ。

```ts
// internal/build/src/index.ts:117-123
attw: { profile: "node16", level: "error" },
publint: { level: "error", strict: true },
unused: { level: "error" },
```

- **Turbo の inputs/outputs による精密なキャッシュ制御**: 生成ファイル (`import_map.ts`, `import_type.ts`, `import_constants.ts`) を inputs から除外することで、生成物の変化がキャッシュ無効化を引き起こすループを防止する。

```json
// libs/langchain-core/turbo.json:4-13
"build:compile": {
  "inputs": [
    "src/**",
    "!src/load/import_constants.ts",
    "!src/load/import_map.ts",
    "!src/load/import_type.ts",
    "tsconfig.json", "tsdown.config.ts", "package.json"
  ],
  "outputs": ["dist/**"]
}
```

- **package.json の `files` フィールド自動管理**: `cjsCompatPlugin` がバレルファイル生成時に `package.json` の `files` フィールドを自動更新する。手動で `files` を管理する必要がなく、生成ファイルの追加忘れによる npm パッケージの不完全配布を防ぐ。

## Anti-Patterns / 注意点

- **パッケージごとのエントリポイント手動列挙**: `@langchain/community` の `tsdown.config.ts` は 250 以上のエントリポイントを手動で列挙している。ファイル追加時にエントリリストへの追記を忘れるリスクがある。

```ts
// Bad: 手動列挙 (libs/langchain-community/tsdown.config.ts)
export default getBuildConfig({
  entry: [
    "./src/index.ts",
    "./src/tools/aiplugin.ts",
    "./src/tools/aws_lambda.ts",
    // ... 250+ entries
  ],
});
```

```ts
// Better: glob パターンで自動検出 + 除外リスト
import { glob } from "glob";
const entries = await glob("./src/**/index.ts");
export default getBuildConfig({ entry: entries });
```

ただし、langchainjs では各ファイルが独立エントリポイントであり index.ts パターンに統一されていないため、glob が適用しにくい構造的事情がある。

- **ワークスペース依存の暗黙的バージョンフォールバック**: `test-runner.ts` でワークスペース依存が見つからない場合に `"*"` (最新版) にフォールバックする処理がある。テストの再現性が担保されない可能性がある。

```ts
// environment_tests/scripts/test-runner.ts:148-154
} else {
  // For other workspace dependencies not available locally, use latest
  packageJson[depType]![depName] = "*";
}
```

## 導出ルール

- `[MUST]` デュアルフォーマット (ESM + CJS) パッケージを公開する場合、package.json の exports フィールドで `import` / `require` の両条件に `types` を先に、`default` を後に記述する
  - 根拠: `@langchain/core/package.json` の全エクスポートが `{ require: { types, default }, import: { types, default } }` の順序を厳守しており、ATTW (Are The Types Wrong?) の node16 プロファイルで検証されている

- `[MUST]` モノレポ内の共有ビルド設定は internal パッケージとして切り出し、ファクトリ関数で提供する。各パッケージの設定ファイルには差分のみを記述する
  - 根拠: langchainjs の 40 以上のパッケージが `getBuildConfig()` を呼ぶだけの 3-10 行の設定ファイルで統一されており、ビルドの一貫性を維持している (`libs/providers/langchain-openai/tsdown.config.ts` 参照)

- `[MUST]` Turborepo のキャッシュ inputs からビルド時に自動生成されるファイルを除外する
  - 根拠: `libs/langchain-core/turbo.json` で `!src/load/import_map.ts` 等を除外し、生成物の変化がキャッシュ無効化の無限ループを引き起こすことを防止している

- `[SHOULD]` npm 公開前にビルド出力を ATTW と publint で自動検証する (型の整合性と package.json の正当性)
  - 根拠: `getBuildConfig()` がデフォルトで `attw: { level: "error" }`, `publint: { level: "error", strict: true }` を設定し、壊れた型や不正な exports がリリースされることを防いでいる

- `[SHOULD]` マルチランタイム対応ライブラリでは、Docker コンテナで各環境 (ESM, CJS, Edge, バンドラー) の実際の import/require を自動テストする
  - 根拠: `environment_tests/` が 9 環境 (ESM, CJS, CF Workers, Vercel, Vite, esbuild, Bun, tsc, Node Classic) で exports の動作を検証し、`test-runner.ts` がワークスペースリンクの正当性まで確認している

- `[SHOULD]` 依存の semver 範囲指定では、「最新版」と「最小許容版」の両端でテストを実行する
  - 根拠: `dependency_range_tests/` で `test-with-latest-deps.sh` と `test-with-lowest-deps.sh` を Docker 内で実行し、宣言した依存範囲の実際の互換性を保証している

- `[SHOULD]` ビルドツールのプラグインで定型ファイルを自動生成する場合、`Auto-generated ... Do not edit manually` コメントを冒頭に挿入し、Prettier でフォーマットしてからディスクに書き出す
  - 根拠: 4 つの build プラグインすべてが `formatWithPrettier()` を呼び出し、生成ファイルのフォーマットを統一している (`internal/build/src/utils.ts:28-37`)

- `[AVOID]` モノレポのパッケージごとにビルド設定をフルカスタムで記述する。設定の分岐が多くなり保守コストが急増する
  - 根拠: langchainjs が以前使っていた個別設定方式から `@langchain/build` への集約へ移行した結果、各パッケージの設定が 3-10 行に圧縮された

## 適用チェックリスト

- [ ] モノレポのビルド設定を internal パッケージに集約し、ファクトリ関数 (`getBuildConfig` 相当) を提供しているか
- [ ] デュアルフォーマット出力 (ESM + CJS) の場合、package.json の exports で `types` 条件を `default` より前に配置しているか
- [ ] ATTW または publint でビルド出力の型整合性と package.json の正当性を CI で検証しているか
- [ ] Turborepo (または同等のビルドオーケストレーター) のキャッシュ inputs からビルド生成物を除外しているか
- [ ] マルチランタイム対応ライブラリの場合、対象環境で実際に import/require する E2E テストがあるか
- [ ] 依存の semver 範囲の両端 (最新 + 最小) でテストを実行しているか
- [ ] ビルド時自動生成ファイルに「自動生成」コメントを付与し、フォーマッターを通しているか
- [ ] Changesets 等のバージョン管理ツールで、関連パッケージの同期リリース (`fixed`) を設定しているか
