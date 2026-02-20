# build-and-tooling

> リポジトリ: vercel/ai
> 分析日: 2026-02-20

## 概要

50 以上のパッケージを擁する大規模 TypeScript モノレポにおいて、Turborepo によるタスクオーケストレーション、tsup による Dual CJS/ESM ビルド、publint によるパッケージ品質ゲート、CI でのバンドルサイズ・ロード時間の自動検証がどのように組み合わされているかを分析した。特筆すべきは「パッケージ構造のテンプレート化」と「ビルド成果物の品質を CI で定量的にゲートする」という二重の仕組みにより、50 以上のプロバイダーパッケージを一貫した品質で維持している点にある。

## 背景にある原則

- **構造の標準化による認知負荷の最小化**: 50 以上のパッケージが同一の package.json 構造・tsup 設定・tsconfig 継承パターンを踏襲することで、新規パッケージ追加のコストを限りなくゼロに近づけるべき。各パッケージの `build` スクリプトは例外なく `pnpm clean && tsup --tsconfig tsconfig.build.json` であり、tsconfig は共有 `@vercel/ai-tsconfig` を extends する。テンプレートからの逸脱を不要にすることで、パッケージごとの独自設定によるバグを防いでいる。

- **ビルド成果物の品質を自動検証で保証する**: ソースコードの品質（lint, type-check）だけでなく、ビルド後のアーティファクトの品質（バンドルサイズ、モジュールロード時間、publint によるパッケージメタデータ整合性）を CI でゲートすべき。ソースが正しくてもパッケージングが壊れれば消費者には届かない。

- **依存グラフの明示的宣言による再現可能なビルド**: Turborepo の `dependsOn: ["^build"]` と TypeScript の `references` を二重に管理することで、ビルド順序の正確性を保証すべき。暗黙の依存に頼ると、ローカルではキャッシュで通るが CI で壊れる問題が起きる。

- **リリース品質はパイプラインで担保し、人間の注意力に依存しない**: changeset による宣言的バージョニング、`verify-changesets` による patch/minor の自動検証、`cleanup-examples-changesets` によるサンプルアプリのバージョンリセットなど、リリースプロセスの各段階に自動化されたゲートを設けるべき。

## 実例と分析

### 共有 tsconfig による設定の一元化

`tools/tsconfig/` に 3 種類の tsconfig プリセットを配置し、全パッケージがこれを継承する:

- `base.json`: 全パッケージ共通の基盤設定（strict mode, ESNext module, Bundler moduleResolution）
- `ts-library.json`: 純粋な TypeScript ライブラリ用（base を extends、target ES2018、`stripInternal: true`）
- `react-library.json`: React ライブラリ用（base を extends、jsx: react-jsx）

50 以上のパッケージのうち、大半が `ts-library.json` を extends し、`@ai-sdk/react` のみが `react-library.json` を使用する。コアの `ai` パッケージだけが `base.json` を直接 extends しており、独自の lib 設定を加えている。

注目すべきは、ビルド用に別途 `tsconfig.build.json` を設ける二重構成である。`tsconfig.json` は `composite: true` で TypeScript のプロジェクト参照を有効にし、`tsconfig.build.json` は `composite: false` に上書きして tsup ビルドに渡す。これにより IDE の型チェック（composite あり）とバンドルビルド（composite なし）を両立している。

### tsup による Dual Format ビルドの標準化

全パッケージが `format: ['cjs', 'esm']` で CJS/ESM の両方を出力する。`package.json` の exports フィールドでは条件分岐で適切なフォーマットを返す:

```jsonc
// packages/openai/package.json の exports
".": {
  "types": "./dist/index.d.ts",
  "import": "./dist/index.mjs",
  "require": "./dist/index.js"
}
```

サブパス export（`./internal`）を持つパッケージでは、tsup.config.ts に複数のエントリを定義し、`outDir` を分けて出力先を制御している。

### ビルド時バージョン注入パターン

全プロバイダーパッケージに `src/version.ts` ファイルが存在し、tsup の `define` オプションでビルド時にバージョン文字列を注入する:

```typescript
// packages/openai/src/version.ts:1-6
declare const __PACKAGE_VERSION__: string | undefined;
export const VERSION: string = typeof __PACKAGE_VERSION__ !== "undefined"
  ? __PACKAGE_VERSION__
  : "0.0.0-test";
```

```typescript
// packages/openai/tsup.config.ts:9-13
define: {
  __PACKAGE_VERSION__: JSON.stringify(
    (await import('./package.json', { with: { type: 'json' } })).default
      .version,
  ),
},
```

`typeof` チェック付きのフォールバック（`'0.0.0-test'`）により、ビルドせずにテスト実行する場合でもランタイムエラーを回避している。この 40 ファイル以上に渡る一貫したパターンは、ランタイムでのバージョン識別（API リクエストヘッダ等）を安全に実現するための設計判断である。

### Turborepo のタスク依存グラフ設計

`turbo.json` のタスク定義に明確な依存関係が宣言されている:

| タスク       | dependsOn         | 意図                                   |
| ------------ | ----------------- | -------------------------------------- |
| `build`      | `^build`          | 依存先パッケージを先にビルド           |
| `test`       | `^build`, `build` | 依存先 + 自身のビルド完了後にテスト    |
| `publint`    | `^build`, `build` | ビルド成果物の存在を前提に品質チェック |
| `type-check` | `^build`, `build` | 型チェックにはビルド済み d.ts が必要   |
| `dev`        | (なし)            | `cache: false`, `persistent: true`     |
| `lint`       | `^lint`           | リントは依存先のリント完了後           |

`dev` タスクのみキャッシュ無効・永続モードにし、その他のタスクはすべてキャッシュ対象とする設計が見て取れる。`build` の `outputs` フィールドでは `.next/cache/**` を除外し、フレームワーク固有のキャッシュがTurboキャッシュを汚染しないようにしている。

並行度の制御も注目に値する: `build` は `--concurrency 16`、`dev` は `--concurrency 25` と、タスク特性に応じた値が設定されている。

### CI パイプラインの多層ゲート構造

`.github/workflows/ci.yml` では以下のジョブが並列実行される:

1. **Build Examples** - サンプルアプリのビルド検証
2. **Prettier** - フォーマットチェック
3. **ESLint** - 静的解析
4. **TypeScript** - `type-check:full`（examples 含む）
5. **Bundle Size Check** - esbuild でバンドルし 560KB 上限を検証
6. **Test Matrix** - Node.js 20/22 でテスト
7. **Load Time Check** - 主要パッケージの `import` 時間を閾値と比較

特にバンドルサイズチェックとロード時間チェックは、ビルド成果物の「ランタイム品質」を CI で保証する先進的なプラクティスである:

```yaml
# ci.yml:197-206 ロード時間の閾値マトリクス
matrix:
  include:
    - module: 'ai'
      max-load-time: 100
    - module: '@ai-sdk/openai'
      max-load-time: 65
    - module: '@ai-sdk/anthropic'
      max-load-time: 65
```

### Changeset によるリリース管理の自動化

changeset は `"updateInternalDependencies": "patch"` で内部依存を自動更新する。特筆すべきは以下の工夫:

1. **verify-changesets ワークフロー**: changeset ファイルが `patch` 以外（`minor`）を使用していないかを自動検証。`minor-release` ラベルがない限り `patch` のみ許可するゲートを設けている。
2. **cleanup-examples-changesets スクリプト**: `changeset version` が examples にも CHANGELOG とバージョン更新を適用するが、examples は公開しないため、バージョンを `0.0.0` にリセットし CHANGELOG を削除するスクリプトを `ci:version` に組み込んでいる。
3. **snapshot リリース**: PR のコードを実際に npm で試したい場合に使う仕組み。`changeset version --snapshot` で commit hash + timestamp 付きバージョンを生成し、`snapshot` dist-tag で公開する。

### prepack/postpack によるドキュメント同梱

プロバイダーパッケージの `prepack` スクリプトで、monorepo 内の `content/` ディレクトリからドキュメントファイルを `docs/` にコピーし、`postpack` で削除する:

```json
"prepack": "mkdir -p docs && cp ../../content/providers/01-ai-sdk-providers/03-openai.mdx ./docs/",
"postpack": "del-cli docs"
```

これにより、npm パッケージにドキュメントを含めつつ、リポジトリ内ではドキュメントの一元管理を維持している。`files` フィールドに `docs/**/*` を含め、npm パッケージの `directories.doc` にも `./docs` を指定している。

### Renovate による差分化された依存更新戦略

`.github/renovate.json5` で依存の種類とファイルパスに応じて更新頻度を変えている:

- `packages/*/package.json` の production deps: 毎週金曜
- `packages/*/package.json` の devDeps: 月初の金曜
- `examples/*`, `tools/*`, ルート: 四半期ごと
- GitHub Actions ワークフロー: 月の第3金曜

公開パッケージの production 依存を最優先で更新し、開発ツールやサンプルは更新頻度を下げることでノイズを制御している。

## コード例

```typescript
// packages/ai/tsup.config.ts:1-19
// Dual format (CJS + ESM) + 複数エントリポイントの標準パターン
export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["cjs", "esm"],
    external: ["react", "svelte", "vue", "chai", "chai/*"],
    dts: true,
    sourcemap: true,
    target: "es2018",
    platform: "node",
    define: {
      __PACKAGE_VERSION__: JSON.stringify(
        (await import("./package.json", { with: { type: "json" } })).default
          .version,
      ),
    },
  },
  // ... Internal APIs, Test utilities
]);
```

```typescript
// packages/ai/scripts/check-bundle-size.ts:6
// バンドルサイズ上限の宣言
const LIMIT = 560 * 1024;
```

::: v-pre

```yaml
# .github/workflows/ci.yml:231-234
# ロード時間ベンチマーク: 別プロセスで50回計測し平均を閾値と比較
pnpm tsx src/benchmark/load-time.ts "${{ matrix.module }}" | tee load-time-output.txt
```

:::

```bash
# .husky/pre-commit:7-15
# package.json 変更を検出して pnpm install を自動実行するフック
if git diff --cached --name-only | grep -q 'package\.json$'; then
  echo "package.json changes detected, running pnpm install..."
  pnpm install
  git add pnpm-lock.yaml
fi
```

## パターンカタログ

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: 50 以上のパッケージに統一されたビルド手順を適用しつつ、パッケージ固有のカスタマイズを許容する
  - 適用条件: 同じ構造のパッケージが多数あり、共通の手順（build, test, clean, lint）を持つ場合
  - コード例: 全パッケージの `build` スクリプトが `pnpm clean && tsup --tsconfig tsconfig.build.json` で統一され、差異は `tsup.config.ts` のエントリポイント定義のみ
  - 注意点: テンプレートからの逸脱を許容しすぎると統一性が崩れる。`@ai-sdk/svelte` のように固有のビルドツール（svelte-package）を使うパッケージは例外として明確に扱う

## Good Patterns

- **tsconfig の二重構成（IDE 用 + ビルド用）**: `tsconfig.json` で `composite: true` を設定して TypeScript プロジェクト参照と IDE サポートを有効にしつつ、`tsconfig.build.json` で `composite: false` に上書きして tsup に渡す。これにより IDE の型解決とバンドラーのビルドを両立できる。

```json
// packages/openai/tsconfig.build.json:1-6
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "composite": false
  }
}
```

- **ビルド時定数注入 + ランタイムフォールバック**: `tsup.define` でビルド時にバージョンを注入し、`typeof` チェックでテスト環境のフォールバックを確保する。ビルド前提のランタイム値をハードコードせず、ビルドツールの `define` 機能で注入するため、バージョン不整合が起きない。

```typescript
// packages/openai/src/version.ts:1-6
declare const __PACKAGE_VERSION__: string | undefined;
export const VERSION: string = typeof __PACKAGE_VERSION__ !== "undefined"
  ? __PACKAGE_VERSION__
  : "0.0.0-test";
```

- **pre-commit での lockfile 自動同期**: `package.json` の変更を検知して `pnpm install` を自動実行し、`pnpm-lock.yaml` をステージングに追加する。lockfile の更新忘れによる CI 失敗を防ぐ。さらに `ARTISANAL_MODE` 環境変数でフックをスキップ可能にし、緊急時の柔軟性を確保している。

- **CI マトリクスの集約ジョブパターン**: Node.js バージョンのマトリクスビルド結果を別の `test` ジョブで集約し、ブランチ保護ルールの `required check` として設定する。マトリクスのバリエーション（Node 20, 22）が変わってもブランチ保護の設定変更が不要になる。

::: v-pre

```yaml
# .github/workflows/ci.yml:179-189
test:
  runs-on: ubuntu-latest
  needs: test_matrix
  if: ${{ !cancelled() }}
  steps:
    - name: All matrix versions passed
      if: ${{ !(contains(needs.*.result, 'failure')) }}
      run: exit 0
```

:::

## Anti-Patterns / 注意点

- **Turbo の `env` フィールドに全 API キーを列挙**: `turbo.json` の `build.env` に 60 以上の環境変数が列挙されている。これは Turbo のキャッシュキーに影響する変数を宣言するためだが、API キーの変更でビルドキャッシュが無効化される。本来ビルド出力に影響しない環境変数はキャッシュキーから除外すべきだが、examples がこれらの変数を使ってビルドされるため、安全側に倒してすべて宣言している。

```jsonc
// turbo.json:7-63 (Bad: 60以上の環境変数をビルドキャッシュキーに含める)
"build": {
  "dependsOn": ["^build"],
  "env": [
    "AI_GATEWAY_API_KEY",
    "ANTHROPIC_API_KEY",
    // ... 60+ keys
  ]
}
```

```jsonc
// Better: パッケージごとにturbo.jsonで env を制限する
// turbo.json
"build": {
  "dependsOn": ["^build"],
  "env": ["NODE_ENV", "CI"]
},
// package.json (パッケージ固有) の turbo 設定で追加 env を宣言
```

- **examples をワークスペースに含めることによる依存グラフの肥大化**: `pnpm-workspace.yaml` に `examples/*` を含めているため、`pnpm install` で全 examples の依存がインストールされる。テストの `--filter=!@example/*` で除外しているが、インストール時間は増大する。パッケージ数が多い場合は examples を別ワークスペースにすることも検討すべき。

## 導出ルール

- `[MUST]` モノレポの全パッケージで共有するビルド設定（tsconfig, bundler config）はワークスペース内の専用パッケージに集約し、各パッケージは extends で継承する
  - 根拠: vercel/ai は `tools/tsconfig` に 3 種の tsconfig プリセットを配置し、50 以上のパッケージが `@vercel/ai-tsconfig` を extends することで設定の一貫性を保っている

- `[MUST]` ビルド依存関係をタスクランナー（Turborepo 等）と TypeScript プロジェクト参照の両方で明示的に宣言する
  - 根拠: `turbo.json` の `dependsOn: ["^build"]` と `tsconfig.json` の `references` を二重に管理することで、ビルド順序の正確性とキャッシュの整合性を保証している

- `[SHOULD]` CI でソースコード品質（lint, type-check）に加え、ビルド成果物の品質（バンドルサイズ、モジュールロード時間）を定量的な閾値で自動検証する
  - 根拠: vercel/ai は esbuild によるバンドルサイズチェック（560KB 上限）と、モジュール別ロード時間ベンチマーク（65-100ms 閾値）を CI で実行し、パフォーマンス劣化を早期検出している

- `[SHOULD]` ビルド時にバージョン文字列を `define` で注入し、ソースコード側はフォールバック付きで参照する
  - 根拠: 40 以上のパッケージが `tsup.define` で `__PACKAGE_VERSION__` を注入し、`version.ts` で `typeof` チェック付きフォールバックを持つパターンを採用。ビルドなしのテスト実行でもランタイムエラーを回避している

- `[SHOULD]` changeset のバージョン範囲（patch/minor/major）を CI で自動検証し、意図しないバージョンバンプを防ぐ
  - 根拠: `verify-changesets` ワークフローが `minor-release` ラベルなしの minor changeset を拒否するゲートを設けている

- `[SHOULD]` 依存更新ツール（Renovate/Dependabot）のスケジュールを依存の種類・ファイルパスごとに差分化する
  - 根拠: production deps は毎週、devDeps は月次、examples は四半期ごとに更新することで、重要な更新を優先しつつノイズを制御している

- `[AVOID]` タスクランナーのキャッシュキーにビルド出力に影響しない環境変数を含める
  - 根拠: `turbo.json` の `build.env` に 60 以上の API キーが列挙されており、キー変更のたびにキャッシュが無効化される。ビルド出力に直接影響する変数のみを宣言すべき

## 適用チェックリスト

- [ ] モノレポの tsconfig を共有パッケージに集約し、各パッケージが extends で継承する構造にしているか
- [ ] ビルド用 tsconfig（`composite: false`）と IDE 用 tsconfig（`composite: true`）を分離しているか
- [ ] `turbo.json`（または同等のタスクランナー設定）でビルド依存関係を明示的に宣言しているか
- [ ] TypeScript のプロジェクト参照（`references`）がパッケージ間の依存関係を正確に反映しているか
- [ ] CI でバンドルサイズ・ロード時間などのビルド成果物品質を閾値付きで検証しているか
- [ ] ビルド時定数の注入にフォールバック値が設定されているか（テスト環境での動作保証）
- [ ] changeset（または同等のツール）のバージョン範囲を CI で自動検証しているか
- [ ] pre-commit フックで lockfile の同期を自動化しているか
- [ ] 依存更新ツールのスケジュールが依存の重要度に応じて差分化されているか
- [ ] `package.json` の `sideEffects: false` を設定して tree-shaking を有効にしているか
