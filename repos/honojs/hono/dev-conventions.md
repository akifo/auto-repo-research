# 開発規約とCI/CD

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono のコーディング規約・CI/CD・コントリビューション体制を横断的に分析した。マルチランタイム（Node.js / Deno / Bun / Cloudflare Workers / Fastly / AWS Lambda）をサポートするライブラリとして、「全ランタイムで常にテストを通す」ことを CI の中核に据えている。ESLint は型チェック系ルールを全面的に無効化し、TypeScript コンパイラ自体の strict モードに型安全性を委ねるという明確な役割分担を実践している。また、PR ごとにバンドルサイズと型チェック速度を計測・比較する仕組みを CI に組み込み、パフォーマンス退行を機械的に検出する体制を構築している。

## 背景にある原則

- **ツールの責務分離**: ESLint と TypeScript コンパイラの責務を明確に分離している。ESLint は `@typescript-eslint` の型情報依存ルールを全て無効化し（`eslint.config.mjs` で 47 ルール OFF）、型安全性は `tsc --noEmit`（`tsconfig.json` の `strict: true`）に任せている。これにより ESLint の実行速度が向上し、型チェックの二重管理を回避している。
- **CI はフォーマッタの自動修正をコミットする**: autofix.ci ワークフローが PR に対して `format:fix` と `lint:fix` を実行し、修正があればコミットを自動生成する（`autofix.yml`）。コントリビューターにフォーマット修正を要求せず、CI が代行することで参入障壁を下げている。
- **リリースの品質ゲートとしてのマルチランタイムテスト**: `prerelease` スクリプトが `test:deno && build` を実行し、npm リリース前にデフォルトテスト以外のランタイムでも必ず検証する。CI でも Node.js / Deno / Bun / workerd / Fastly / Lambda / Lambda@Edge の 7 環境でテストを並列実行している。
- **パフォーマンスを定量的に監視する**: PR ごとにバンドルサイズ（esbuild minify 後）と型チェック速度（tsc / typescript-go 両方）を計測し、octocov で差分レポートを生成する。HTTP ベンチマークも bombardier で実行し、結果を PR コメントに投稿する。

## 実例と分析

### ESLint: 型チェック系ルールの全面無効化

`eslint.config.mjs` では `@hono/eslint-config` をベースに、型情報を必要とする全ルール（47 個）を明示的に OFF にしている。通常、`@typescript-eslint` の recommended-type-checked を有効にするプロジェクトが多いが、Hono は巨大なコードベース（359 ソースファイル）で ESLint に型情報を渡すコストを避け、型安全性は `tsc --noEmit` に一本化している。

テストスクリプト `"test": "tsc --noEmit && vitest --run"` が `tsc` を先に実行する点に注目すべきで、型チェックがテストのゲートになっている。

### Prettier: セミコロンレス + シングルクォート

`.prettierrc` で `"semi": false` と `"singleQuote": true` を設定している。これは Hono のコード全体に一貫して適用され、EditorConfig（`.editorconfig`）でインデントサイズ 2 スペース、LF 改行を強制している。さらに CI で `editorconfig-checker` を実行し、EditorConfig の遵守を機械的に検証している。

### テストのコロケーション

テストファイルはソースと同ディレクトリに配置する（例: `src/middleware/cors/index.ts` と `src/middleware/cors/index.test.ts`）。117 個のテストファイルが `src/` 内にコロケーションされている。ビルド時は `tsconfig.build.json` の `exclude` でテストファイルを除外し、成果物に混入しない。

### ツールバージョン管理: .tool-versions

`.tool-versions` で Node.js / Bun / Deno のバージョンを一元管理し、CI の `setup-node`、`setup-bun`、`setup-deno` がすべてこのファイルを参照する（`node-version-file`、`bun-version-file`、`deno-version-file`）。これにより、ローカル開発と CI でのランタイムバージョンの乖離を防いでいる。

### デュアルモジュール出力（ESM + CJS）

ビルドスクリプト `build/build.ts` が ESM と CJS を並列ビルドし、`package.cjs.json`（`{"type": "commonjs"}`）を `dist/cjs/` にコピーすることで、ESM パッケージ内に CJS サブディレクトリを共存させている。`package.json` の `exports` フィールドで `import` / `require` の条件付きエクスポートを全サブパスに定義し、publint でパッケージ構造を検証する。

### CI パイプラインの構造

CI は機能別に明確にジョブを分離している:

1. **Main ジョブ**: format → lint → editorconfig → build → test（型チェック含む）
2. **ランタイム別ジョブ**: Deno / Bun / Bun-Windows / Fastly / Node.js(3バージョン) / workerd / Lambda / Lambda@Edge
3. **品質ゲート**: JSR dry-run（Deno レジストリ互換性検証）
4. **パフォーマンス計測**: バンドルサイズ + 型チェック速度 + HTTP ベンチマーク（PR のみ）
5. **カバレッジ集約**: Main / Deno / Bun のカバレッジを artifacts で収集し、Codecov にアップロード

### pkg-pr-new によるプレビューリリース

`cr.yml` ワークフローが `cr-tracked` ラベル付き PR と main ブランチのプッシュで `pkg-pr-new publish --compact` を実行し、PR 単位で npm インストール可能なプレビューパッケージを StackBlitz 上に公開する。

### autofix.ci によるフォーマット自動修正

PR に対して format と lint の自動修正を行い、修正コミットを自動プッシュする。ドラフト PR はスキップする（<code v-pre>if: ${{ !github.event.pull_request.draft }}</code>）。concurrency 制御で同一ブランチへの並行実行を防止している。

## コード例

```typescript
// eslint.config.mjs:1-75
// 型情報依存ルールの全面無効化パターン
import baseConfig from "@hono/eslint-config";

const typeCheckedRules = {
  "@typescript-eslint/await-thenable": "off",
  "@typescript-eslint/no-floating-promises": "off",
  "@typescript-eslint/no-unsafe-assignment": "off",
  // ... 合計 47 ルールを OFF
};

export default [
  ...baseConfig,
  {
    rules: typeCheckedRules,
  },
];
```

```json
// .prettierrc:1-9
{
  "printWidth": 100,
  "trailingComma": "es5",
  "tabWidth": 2,
  "semi": false,
  "singleQuote": true,
  "jsxSingleQuote": true,
  "endOfLine": "lf"
}
```

```yaml
# .github/workflows/ci.yml:34-51
# Main ジョブ: format → lint → editorconfig → build → test の順序実行
main:
  name: 'Main'
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v6
    - uses: actions/setup-node@v6
      with:
        node-version-file: '.tool-versions'
    - uses: oven-sh/setup-bun@v2
      with:
        bun-version-file: '.tool-versions'
    - run: bun install --frozen-lockfile
    - run: bun run format
    - run: bun run lint
    - run: bun run editorconfig-checker -format github-actions
    - run: bun run build
    - run: bun run test
```

```typescript
// build/validate-exports.ts:1-37
// package.json と jsr.json のエクスポート整合性を検証
export const validateExports = (
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  fileName: string,
) => {
  // 双方向で検証: package.json → jsr.json、jsr.json → package.json
  Object.keys(source).forEach((sourceEntry) => {
    if (!isEntryInTarget(sourceEntry)) {
      throw new Error(`Missing "${sourceEntry}" in '${fileName}'`);
    }
  });
};
```

```json
// package.json:13-14
// テストスクリプト: tsc を先に実行して型チェックをゲートにする
"test": "tsc --noEmit && vitest --run",
```

```typescript
// .vitest.config/setup-vitest.ts:1-47
// Web API のポリフィルをテストセットアップで注入
if (!globalThis.crypto) {
  vi.stubGlobal("crypto", nodeCrypto);
  vi.stubGlobal("CryptoKey", nodeCrypto.webcrypto.CryptoKey);
}
vi.stubGlobal("caches", caches);
```

## Good Patterns

- **ESLint と TypeScript の責務分離**: ESLint からは型情報依存ルールを全て外し、コードスタイルとシンプルなエラー検出に専念させる。型安全性は `tsc --strict` に一本化する。これにより ESLint の実行が高速になり、型チェックの二重管理（ESLint の型ルールと tsc の重複）を回避できる。大規模コードベースで ESLint に型情報を渡すと、プロジェクト全体のパースが必要になり CI が遅くなるため、この分離は実用的。

```javascript
// eslint.config.mjs — 型チェック系ルールを一括 OFF
const typeCheckedRules = {
  "@typescript-eslint/no-floating-promises": "off",
  "@typescript-eslint/no-unsafe-assignment": "off",
  // ...
};
```

- **ビルド成果物のパッケージ整合性を自動検証**: `build/validate-exports.ts` が `package.json` と `jsr.json` のエクスポート定義を双方向で検証し、`publint` がパッケージ構造全体を検証する。エクスポートの追加忘れや不整合をビルド時に即座に検出する。

```typescript
// build/build.ts:31
validateExports(packageJsonExports, jsrJsonExports, "jsr.json");
validateExports(jsrJsonExports, packageJsonExports, "package.json");
```

- **PR 単位のパフォーマンス退行検出**: バンドルサイズ、型チェック速度、HTTP ベンチマークを PR ごとに計測し、ベースラインとの差分をコメントで報告する。パフォーマンス退行が「マージ後に気づく」のではなく「PR レビュー中に分かる」。

- **autofix.ci でフォーマットの自動修正**: コントリビューターにフォーマット修正を手動で要求せず、CI が自動的にコミットする。コントリビューション体験を改善し、レビューでのフォーマット指摘を排除する。

- **.tool-versions による全ランタイムバージョン一元管理**: Node.js / Bun / Deno のバージョンを 1 ファイルで管理し、CI の `*-version-file` パラメータで参照する。バージョン更新が 1 箇所の変更で完結する。

## Anti-Patterns / 注意点

- **noUnusedLocals/noUnusedParameters を開発用 tsconfig で OFF にしている**: `tsconfig.json` では `noUnusedLocals: false`、`noUnusedParameters: false` だが、`tsconfig.build.json` では `true` に上書きしている。これにより開発中は未使用変数の警告が出ず、ビルド時に初めてエラーになる。

```json
// tsconfig.json (Bad: 開発中は未使用変数を許容)
{
  "noUnusedLocals": false,
  "noUnusedParameters": false
}

// tsconfig.build.json (Better: ビルド時に厳格化)
{
  "noUnusedLocals": true,
  "noUnusedParameters": true
}
```

開発体験と CI 品質のバランスとして意図的な設計だが、ビルド時に初めてエラーが出ると手戻りが発生する。エディタの設定で `tsconfig.build.json` を参照するか、`test` スクリプトの `tsc --noEmit` で `tsconfig.build.json` を使うのがより良い。

- **カバレッジ閾値を informational にしている**: `codecov.yml` で `informational: true` を設定し、カバレッジが閾値（patch 80%, project 75%）を下回っても CI を失敗させない。品質の目安として計測しつつ、カバレッジのためだけの無意味なテストを強制しない判断。ただし、カバレッジの緩やかな低下に気づきにくいリスクがある。

## 導出ルール

- `[MUST]` テストスクリプトでは型チェック（`tsc --noEmit`）をテスト実行の前に配置する
  - 根拠: Hono の `"test": "tsc --noEmit && vitest --run"` は型エラーがある状態でテストを実行する無駄を排除し、型エラーをテスト失敗より先に報告する（`package.json:13`）
- `[MUST]` CI のインストールコマンドには lockfile 固定オプション（`--frozen-lockfile` / `--ci`）を使用する
  - 根拠: 全 CI ジョブで `bun install --frozen-lockfile` を使用し、CI 環境での依存関係の暗黙的な更新を防止している（`ci.yml` 全ジョブ共通）
- `[SHOULD]` ESLint の型情報依存ルールと TypeScript コンパイラの型チェックは責務を分離し、二重管理を避ける
  - 根拠: 大規模コードベースで ESLint に型情報を渡すとパース時間が増大する。Hono は 47 ルールを OFF にし、型安全性を `tsc --strict` に一本化している（`eslint.config.mjs:4-68`）
- `[SHOULD]` マルチランタイム対応ライブラリでは、ランタイムごとのテストをCIジョブとして分離し、カバレッジを統合する
  - 根拠: Hono は 7 つのランタイムテストジョブと 1 つのカバレッジ統合ジョブで構成され、各ランタイムの artifacts を Codecov に集約している（`ci.yml:15-30`）
- `[SHOULD]` PR ごとにバンドルサイズ・型チェック速度を計測し、ベースラインとの差分を自動コメントする
  - 根拠: `perf-measures` アクションが octocov でバンドルサイズと型チェック速度の差分レポートを生成し、パフォーマンス退行を PR レビュー時に検出する（`.github/actions/perf-measures/action.yml`）
- `[SHOULD]` ランタイムバージョンは `.tool-versions` 等の単一ファイルで管理し、CI の `*-version-file` パラメータで参照する
  - 根拠: Hono は `.tool-versions` に Node.js / Bun / Deno を集約し、CI の全ジョブがこのファイルを参照することでバージョン更新を 1 箇所に集約している（`.tool-versions`, `ci.yml`）
- `[SHOULD]` パッケージのエクスポート定義は複数のマニフェスト間（package.json / jsr.json 等）で自動検証する
  - 根拠: `build/validate-exports.ts` が双方向の整合性チェックを行い、エクスポートの追加漏れをビルド時に検出する（`build/build.ts:31-32`）
- `[SHOULD]` autofix 系の CI ワークフローでフォーマット・lint の自動修正をコミットし、コントリビューターの負担を減らす
  - 根拠: `autofix.yml` が `format:fix` と `lint:fix` を実行し、修正を自動コミットすることで、フォーマット関連のレビュー指摘を排除している
- `[AVOID]` ESLint に型情報を渡して型チェック系ルールを有効にすることで CI を遅くする
  - 根拠: Hono は ESLint の型チェック系ルールを全て OFF にし、`tsc` に型チェックを委ねることで ESLint の実行速度を維持している（`eslint.config.mjs`）

## 適用チェックリスト

- [ ] `test` スクリプトで `tsc --noEmit` をテスト実行の前に配置しているか
- [ ] CI の `install` コマンドに `--frozen-lockfile` / `--ci` を付けているか
- [ ] ESLint と TypeScript コンパイラの型チェックが二重管理になっていないか（型情報依存ルールの有効/無効を明確に判断したか）
- [ ] `.tool-versions` や `.nvmrc` でランタイムバージョンを一元管理し、CI がそのファイルを参照しているか
- [ ] パッケージの `exports` フィールドを publint 等で検証しているか
- [ ] PR ごとにバンドルサイズや型チェック速度の退行を検出する仕組みがあるか
- [ ] フォーマッタの自動修正を CI で行い、コントリビューターにフォーマット修正を手動で要求していないか
- [ ] テストファイルがソースと同ディレクトリにコロケーションされ、ビルド成果物から除外されているか
- [ ] カバレッジの閾値と失敗ポリシー（informational vs blocking）を意図的に設定しているか
