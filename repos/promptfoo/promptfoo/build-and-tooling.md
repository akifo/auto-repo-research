# Build and Tooling

> リポジトリ: promptfoo/promptfoo
> 分析日: 2026-02-21

## 概要

promptfoo は大規模 TypeScript CLI/ライブラリプロジェクト（2,327 ソースファイル）において、tsdown による ESM/CJS デュアルビルド、Biome + Prettier の責務分離型ハイブリッドリンティング、knip によるデッドコード検出、そして多層的な品質ゲートを組み合わせた包括的なビルド・ツーリング戦略を採用している。特に、`package.json` の `"type": "module"` を基盤としつつ CJS 互換を維持する実践的なアプローチと、リンターのルールを用いてアーキテクチャ制約（`fetch` の直接使用禁止等）をツールで強制する手法が注目に値する。

## 背景にある原則

- **ビルド構成の関心分離**: 4 つの独立したビルドターゲット（Server ESM / CLI ESM / Library ESM / Library CJS）を単一の `tsdown.config.ts` で定義し、それぞれ異なる目的（サーバー安定パス、CLI バイナリ、ライブラリ互換性）に最適化している。並列ビルド時のレースコンディションを防ぐため全構成で `clean: false` とし、クリーンは専用コマンド `build:clean` に分離している（`tsdown.config.ts:29-30`）。

- **ツールの得意領域に基づく責務分割**: Biome を JS/TS/JSON のリント・フォーマットに、Prettier を CSS/SCSS/HTML/MD/YAML に割り当て、`.prettierignore` で JS/TS ファイルを Prettier の対象から明示的に除外している。各ツールが最も効果的に機能する領域のみを担当させることで、ツール間の競合を排除している（`.prettierignore:19-25`）。

- **ビルド時定数注入による環境適応**: `define` オプションで `__PROMPTFOO_VERSION__`、`__PROMPTFOO_POSTHOG_KEY__`、`BUILD_FORMAT` 等をコンパイル時に注入し、実行時のモジュール形式判定やバージョン取得を分岐なしで実現している。開発時（tsx）には `undefined` として安全にフォールバックする設計（`tsdown.config.ts:22-27`、`src/version.ts:23-26`）。

- **リンターによるアーキテクチャ制約の強制**: `noRestrictedGlobals` と `noRestrictedImports` を用いて `fetch` や `node-fetch` の直接使用を禁止し、プロキシ対応の `fetchWithProxy()` への一元化をコンパイル時に強制している。ドキュメントやコードレビューに頼らず、ツールチェーンでアーキテクチャ制約を担保する思想（`biome.jsonc:131-152`）。

## 実例と分析

### tsdown マルチターゲットビルド構成

`tsdown.config.ts` では `defineConfig` に配列を渡すことで 4 つのビルドターゲットを定義している。

| ターゲット | format | entry | fixedExtension | 用途 |
|---|---|---|---|---|
| Server | ESM | `src/server/index.ts` | false (.js) | ワークフロー安定パス |
| CLI | ESM | `src/entrypoint.ts`, `src/main.ts` | false (.js) | CLI バイナリ |
| Library ESM | ESM | `src/index.ts` | false (.js) | ライブラリ (import) |
| Library CJS | CJS | `src/index.ts` | true (.cjs) | ライブラリ (require) |

`"type": "module"` を持つ `package.json` の下で ESM ビルドには `fixedExtension: false`（= `.js` 出力）、CJS ビルドのみ `fixedExtension: true`（= `.cjs` 出力）とすることで、Node.js のモジュール解決に自然に適合させている。

全ターゲットで `external: [/^[a-z@][^:]*/]` という正規表現により、bare module import を一律外部化している。CLI ビルドではさらにネイティブ依存（`better-sqlite3`、`sharp`、`@swc/core` 等）を明示的に外部化している。

### ESM/CJS デュアル互換のための `BUILD_FORMAT` 定数

`BUILD_FORMAT` はビルド時に `"esm"` または `"cjs"` として注入されるコンパイル時定数で、モジュール形式に依存するコードパスを分岐させる。

`src/esm.ts` の `getDirectory()` 関数は、この定数を使って ESM の `import.meta.url` と CJS の `__dirname` を安全に切り替える。CJS ビルドでは `import.meta` 構文自体が SyntaxError になるため、単純な `if` 分岐ではなく `BUILD_FORMAT` でコンパイル時に不要なコードパスを除去する設計になっている。

### Biome と Prettier の責務分割

`.prettierignore` で `*.js`, `*.ts`, `*.tsx`, `*.json` 等を除外し、Biome に JS/TS のフォーマットとリントを一元化。Prettier は CSS/SCSS/HTML/MD/YAML のみを担当する。

`npm run f`（差分フォーマット）スクリプトがこの分割を体現している:

```bash
# JS/TS/JSON は Biome で処理
git diff --name-only --diff-filter=ACMRTUXB origin/main | grep -E '\.(js|jsx|mjs|cjs|ts|tsx|json)$' | xargs npx @biomejs/biome check --write

# CSS/SCSS/HTML/MD/YAML は Prettier で処理
git diff --name-only --diff-filter=ACMRTUXB origin/main | grep -E '\.(css|scss|html|md|mdc|mdx|yaml|yml)$' | xargs prettier --write
```

### 差分ベースのリント・フォーマット

`npm run l` と `npm run f` は `git diff --name-only --diff-filter=ACMRTUXB origin/main` で変更ファイルのみを対象とする。これにより大規模コードベースでも開発中のフィードバックループを高速に保っている。`--diff-filter=ACMRTUXB` で削除されたファイルを除外し、存在しないファイルへの処理を防いでいる。

### ポストビルドによるアセット管理

`scripts/postbuild.ts` は tsdown ビルド後に実行され、以下を処理する:

1. ビルド出力の完全性検証（`REQUIRED_BUILD_OUTPUTS` で必須ファイルを定義）
2. 非 TypeScript アセット（HTML テンプレート、Python/Ruby/Go ラッパースクリプト、Drizzle マイグレーション、Proto ファイル）の `dist/` へのコピー
3. ESM マーカー `package.json` (`{"type": "module"}`) の `dist/src/` への配置
4. CLI エントリポイントへの実行権限付与

特にラッパースクリプトは `dist/src/` と `dist/src/server/` の 2 箇所にコピーされる。これはバンドルされたサーバーの `import.meta.url` が `dist/src/server/index.js` を指すため、相対パスでのラッパー解決に必要な措置。

### knip によるデッドコード検出

`knip.json` ではエントリポイント（`src/index.ts`、`src/server/index.ts`）とプロジェクト範囲を定義し、ワークスペース（`src/app`、`site`）ごとに独立したエントリ・依存関係設定を持つ。`ignoreExportsUsedInFile: true` により、ファイル内でのみ使われるエクスポートは警告対象から除外している。

### CI の多層品質ゲート

`.github/workflows/main.yml` では以下の品質チェックを並列実行:

1. **Biome CI** (`npm run lint:ci`): JS/TS/JSON のリント + フォーマットチェック
2. **Prettier Check** (`npm run format:check:prettier`): CSS/HTML/MD/YAML のフォーマットチェック
3. **依存バージョン一貫性** (`check-dependency-version-consistency`)
4. **循環依存検出** (`madge --circular`): `git ls-files '*.ts'` で追跡対象の TS ファイルのみを検査
5. **欠損依存検出** (`depcheck`): 使用されているが `package.json` に宣言されていない依存を検出
6. **lockfile 整合性** (`lockfile-lint`): HTTPS 以外のレジストリを拒否

## コード例

```typescript
// tsdown.config.ts:29-53
// All configs use clean: false. Use `npm run build:clean` for explicit cleaning.
// This prevents race conditions when multiple configs share the same outDir.
export default defineConfig([
  // Server (ESM only) - stable path for workflows
  {
    entry: { 'server/index': 'src/server/index.ts' },
    format: ['esm'],
    target: 'node20',
    outDir: 'dist/src',
    splitting: false,
    shims: true,
    sourcemap: true,
    clean: false,
    fixedExtension: false, // Use .js extension for ESM since package.json has type: module
    ...
    external: [
      // Externalize all bare module imports so Node resolves CJS deps natively
      /^[a-z@][^:]*/,
    ],
  },
```

```typescript
// src/esm.ts:161-192
export function getDirectory(): string {
  // In bundled CJS builds, skip the ESM path entirely - import.meta.url will be empty
  if (typeof BUILD_FORMAT !== 'undefined' && BUILD_FORMAT === 'cjs') {
    // @ts-ignore - __dirname exists in CJS builds
    return __dirname;
  }

  try {
    const url = import.meta.url;
    if (url && url !== '') {
      return path.dirname(fileURLToPath(url));
    }
  } catch {
    // Expected in CJS environments where import.meta syntax is invalid
  }

  if (typeof __dirname !== 'undefined') {
    // @ts-ignore
    return __dirname;
  }

  throw new Error(
    'Unable to determine directory: neither import.meta.url nor __dirname available.',
  );
}
```

```typescript
// src/version.ts:23-26
export const VERSION: string =
  typeof __PROMPTFOO_VERSION__ !== 'undefined'
    ? __PROMPTFOO_VERSION__
    : (process.env.npm_package_version ?? '0.0.0-development');
```

```jsonc
// biome.jsonc:131-152
"noRestrictedGlobals": {
  "level": "error",
  "options": {
    "deniedGlobals": {
      "fetch": "Use fetchWithProxy() instead of global fetch()."
    }
  }
},
"noRestrictedImports": {
  "level": "error",
  "options": {
    "paths": {
      "node-fetch": "Use fetchWithProxy() (do not import node-fetch directly).",
      "undici": {
        "importNames": ["fetch", "default"],
        "message": "Use fetchWithProxy() instead of undici.fetch."
      },
      "cross-fetch": "Use fetchWithProxy() instead."
    }
  }
}
```

```typescript
// scripts/postbuild.ts:50-57
const REQUIRED_BUILD_OUTPUTS = [
  'dist/src/entrypoint.js', // CLI entry (Node version check wrapper)
  'dist/src/main.js',       // CLI main module
  'dist/src/index.js',      // ESM library entry
  'dist/src/index.cjs',     // CJS library entry
  'dist/src/server/index.js', // Server entry
];
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: ESM と CJS で異なるモジュール解決メカニズム（`import.meta.url` vs `__dirname`）を透過的に切り替える
  - 適用条件: デュアルフォーマットビルドでモジュール形式に依存する処理がある場合
  - コード例: `src/esm.ts:161-192`（`getDirectory()` が `BUILD_FORMAT` に基づいてコンパイル時に戦略を選択）
  - 注意点: ビルドツールの `define` 機能でコンパイル時に分岐を解決するため、デッドコード除去も期待できる

- **Facade パターン** (分類: 構造)
  - 解決する問題: HTTP クライアントの実装詳細（プロキシ設定、TLS、タイムアウト）を隠蔽し、統一インターフェースを提供する
  - 適用条件: グローバル API の直接使用を制限し、横断的関心事を一元管理したい場合
  - コード例: `src/util/fetch/index.ts:106`（`fetchWithProxy` が `fetch` の Facade として機能）
  - 注意点: リンターの `noRestrictedGlobals`/`noRestrictedImports` と組み合わせることで Facade への一元化をツールで強制できる

## Good Patterns

- **並列ビルド時のレースコンディション防止**: 全ビルドターゲットで `clean: false` を設定し、同一 `outDir` への並列書き込みでのファイル消失を防いでいる。クリーンは `npm run build:clean` で明示的に行う。`concurrently -g --kill-others-on-fail` で tsc 型チェック・tsdown バンドル・フロントエンドビルドを並列実行しつつ、一つでも失敗すれば全体を停止する。

```json
// package.json:44
"build": "concurrently -g --kill-others-on-fail \"tsc --noEmit\" \"NODE_OPTIONS='--max-old-space-size=8192' tsdown\" \"npm run build:app\""
```

- **ビルド出力の完全性検証**: ポストビルドスクリプトがビルド成果物の存在を検証してから後続処理を実行する。ビルドツールのサイレント失敗をキャッチできる。

```typescript
// scripts/postbuild.ts:170-181
function verifyBuildOutputs(): string[] {
  const missing: string[] = [];
  for (const outputPath of REQUIRED_BUILD_OUTPUTS) {
    const fullPath = path.join(ROOT, outputPath);
    if (!fs.existsSync(fullPath)) {
      missing.push(outputPath);
    }
  }
  return missing;
}
```

- **リンターのオーバーライドによる段階的厳格化**: `biome.jsonc` でデフォルトルールを厳格に設定し（`noExplicitAny: "error"`）、テストファイルやレガシー領域（`src/providers/**`、`src/redteam/**`）に限ってオーバーライドで緩和している。新規コードには厳格なルールを適用しつつ、既存コードの段階的移行を可能にする戦略。

```jsonc
// biome.jsonc:266-283 (テストファイル向けオーバーライド)
{
  "includes": ["test/**/*", "**/*.test.ts"],
  "linter": {
    "rules": {
      "suspicious": {
        "noExplicitAny": "off"
      },
      "nursery": {
        "noFloatingPromises": "off"
      }
    }
  }
}
```

- **`noEnum: "error"` によるユニオン型への誘導**: TypeScript の `enum` を禁止し、文字列リテラルのユニオン型を推奨している。tree-shaking との相性、型の互換性、JavaScript との相互運用性で有利。

## Anti-Patterns / 注意点

- **ビルドツールの `clean` オプションに依存したクリーンビルド**: 並列ビルドで同一出力ディレクトリを共有する場合、各ターゲットが `clean: true` を設定すると他のターゲットの出力を削除してしまう。

```typescript
// Bad: 並列ビルドで clean: true
export default defineConfig([
  { entry: ['src/index.ts'], format: ['esm'], outDir: 'dist', clean: true },
  { entry: ['src/index.ts'], format: ['cjs'], outDir: 'dist', clean: true },
]);
```

```typescript
// Better: clean: false + 明示的なクリーンコマンド
// package.json: "build:clean": "shx rm -rf dist"
export default defineConfig([
  { entry: ['src/index.ts'], format: ['esm'], outDir: 'dist', clean: false },
  { entry: ['src/index.ts'], format: ['cjs'], outDir: 'dist', clean: false },
]);
```

- **`import.meta.url` のランタイム検出のみに頼る ESM/CJS 判定**: CJS 環境では `import.meta` 構文自体が SyntaxError になるため、`if (import.meta.url)` のような分岐は動作しない。ビルド時定数を使ったコンパイル時分岐が必要。

```typescript
// Bad: ランタイムで import.meta を条件分岐
function getDir() {
  if (typeof import.meta !== 'undefined' && import.meta.url) {
    return path.dirname(fileURLToPath(import.meta.url));
  }
  return __dirname;
}
```

```typescript
// Better: コンパイル時定数で分岐（デッドコード除去も効く）
declare const BUILD_FORMAT: 'esm' | 'cjs' | undefined;
function getDir() {
  if (typeof BUILD_FORMAT !== 'undefined' && BUILD_FORMAT === 'cjs') {
    return __dirname;
  }
  // ESM path...
}
```

## 導出ルール

- `[MUST]` 複数のビルドターゲットが同一出力ディレクトリを共有する場合、全ターゲットで `clean: false` を設定し、クリーンは専用コマンドで明示的に行う
  - 根拠: promptfoo では 4 つのビルドターゲットが `dist/src` を共有し、並列ビルド時の `clean: true` がレースコンディションを引き起こすことを防止している（`tsdown.config.ts:29-30`）
- `[MUST]` ESM/CJS デュアルビルドでモジュール形式に依存するコードパスがある場合、ビルドツールの `define` 機能でコンパイル時定数を注入し、ランタイム検出ではなくコンパイル時分岐で切り替える
  - 根拠: CJS 環境では `import.meta` 構文が SyntaxError になるため、ランタイム分岐は不可能（`src/esm.ts:161-166`）
- `[SHOULD]` リンターの `noRestrictedGlobals`/`noRestrictedImports` ルールを使い、グローバル API の直接使用を禁止してラッパー関数への一元化をツールで強制する
  - 根拠: promptfoo では `fetch` の直接使用を禁止し `fetchWithProxy()` に一元化することで、プロキシ・TLS 設定の適用漏れを防いでいる（`biome.jsonc:131-152`、40 ファイルで使用）
- `[SHOULD]` Biome と Prettier を併用する場合、ファイル拡張子で責務を厳密に分割し、`.prettierignore` で Biome 担当のファイル種別を Prettier の対象から除外する
  - 根拠: 二重フォーマットによる不整合やパフォーマンス劣化を回避している（`.prettierignore:19-25`）
- `[SHOULD]` ポストビルドスクリプトでビルド成果物の完全性を検証してから後続処理を実行する
  - 根拠: バンドラーのサイレント失敗（一部ファイルの出力漏れ等）をデプロイ前に検出できる（`scripts/postbuild.ts:170-181`）
- `[SHOULD]` 大規模コードベースでは差分ベースのリント・フォーマットコマンド（`git diff --name-only` + ツール実行）を用意し、開発中のフィードバックループを高速に保つ
  - 根拠: 2,327 ファイル規模で全ファイル走査は開発体験を損なうため、`npm run l` / `npm run f` で変更ファイルのみを対象にしている（`package.json:54,60`）
- `[SHOULD]` CI で循環依存チェック（madge）・デッドコード検出（knip）・欠損依存チェック（depcheck）を並列実行し、構造的品質を自動で担保する
  - 根拠: 大規模コードベースでは手動レビューだけでは構造的問題の検出が困難（`.github/workflows/main.yml:217-224`）
- `[AVOID]` TypeScript の `enum` を使用する（`noEnum: "error"` で禁止し、文字列リテラルのユニオン型を使用する）
  - 根拠: `enum` は tree-shaking を阻害し、JavaScript との相互運用性が低い（`biome.jsonc:119`）

## 適用チェックリスト

- [ ] `package.json` に `"type": "module"` を設定し、ESM をデフォルトのモジュール形式にする
- [ ] デュアルビルド時は `exports` フィールドで `import`（`.js`）と `require`（`.cjs`）の両方を宣言する
- [ ] 複数ビルドターゲットが同一 `outDir` を使う場合、`clean: false` + 明示的クリーンコマンドの構成にする
- [ ] ESM/CJS 両対応が必要なコードに `BUILD_FORMAT` 等のコンパイル時定数を注入し、`import.meta` のランタイム検出に頼らない
- [ ] Biome と Prettier を併用する場合、`.prettierignore` で JS/TS/JSON を除外し責務を分離する
- [ ] `noRestrictedGlobals` / `noRestrictedImports` で、アーキテクチャ上直接使用を禁止すべき API をリンターで強制する
- [ ] `git diff --name-only` ベースの差分リント・フォーマットコマンドを `package.json` scripts に用意する
- [ ] ポストビルドスクリプトにビルド成果物の存在検証ステップを追加する
- [ ] CI に循環依存チェック・デッドコード検出・欠損依存チェックを追加する
- [ ] リンターのデフォルトを厳格に設定し、レガシー領域はオーバーライドで段階的に緩和する
