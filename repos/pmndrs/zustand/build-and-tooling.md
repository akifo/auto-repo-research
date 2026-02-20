# Build and Tooling

> リポジトリ: pmndrs/zustand
> 分析日: 2026-02-20

## 概要

zustand のビルドパイプラインを分析する。Rollup + rollup-plugin-esbuild によるモジュール別デュアルビルド（CJS/ESM）、postbuild フェーズでの d.ts パッチ群、compressed-size CI によるバンドルサイズ監視、dist ディレクトリからの publish 戦略を対象とする。ライブラリサイズが極めて小さい（数 KB）にもかかわらず、ビルド構成の精度と互換性への配慮が際立っており、ライブラリビルドのベストプラクティスが凝縮されている。

## 背景にある原則

- **モジュールフォーマット完全分離**: CJS と ESM を別ファイル・別拡張子（`.js` / `.mjs`）で出力し、`exports` フィールドで条件分岐する。Node.js/bundler/React Native の各環境が正しいフォーマットを取得できるようにするため。`package.json` の `exports` マップ（`package.json:28-57`）がこの原則の実装。

- **ソースツリーとパッケージツリーの分離**: `dist/` ディレクトリを npm パッケージのルートとして publish し、ソースの `src/` 構造とは無関係なフラットなパッケージ構造を提供する。ユーザーは `zustand/middleware` のようにクリーンなパスでインポートできる。`publishConfig` ではなく `copy` スクリプト（`package.json:85`）でこれを実現している。

- **後方互換性の段階的保証**: TypeScript 4.5 から最新版まで 15 バージョンの互換性を CI で検証する（`test-old-typescript.yml`）。新しい TypeScript 機能（`isolatedDeclarations`, `verbatimModuleSyntax`, `bundler` moduleResolution）を活用しつつ、古いバージョン向けに段階的なフォールバックを提供する。

- **ビルド成果物の検証をビルドプロセスに組み込む**: `test-multiple-builds.yml` で CJS/ESM 双方のビルド成果物に対して同一テストスイートを実行し、ソースコードのテストだけでは検出できないビルド成果物固有の問題を捕捉する。

## 実例と分析

### モジュール別 Rollup ビルド

zustand は単一の `rollup.config.mjs` で全モジュールのビルドを管理する。`--config-xxx` コマンドライン引数でビルド対象を切り替える仕組みが特徴的である。

```javascript
// rollup.config.mjs:93-105
export default function(args) {
  let c = Object.keys(args).find((key) => key.startsWith("config-"));
  if (c) {
    c = c.slice("config-".length).replace(/_/g, "/");
  } else {
    c = "index";
  }
  return [
    ...(c === "index" ? [createDeclarationConfig(`src/${c}.ts`, "dist")] : []),
    createCommonJSConfig(`src/${c}.ts`, `dist/${c}.js`),
    createESMConfig(`src/${c}.ts`, `dist/esm/${c}.mjs`),
  ];
}
```

各 `build:*` スクリプトは独立して呼び出される:

```json
// package.json:66-74
"build:base": "rollup -c",
"build:vanilla": "rollup -c --config-vanilla",
"build:react": "rollup -c --config-react",
"build:middleware": "rollup -c --config-middleware",
"build:middleware:immer": "rollup -c --config-middleware_immer",
"build:shallow": "rollup -c --config-shallow",
"build:vanilla:shallow": "rollup -c --config-vanilla_shallow",
"build:react:shallow": "rollup -c --config-react_shallow",
"build:traditional": "rollup -c --config-traditional",
```

`pnpm run "/^build:.*/"` で正規表現マッチにより全 `build:*` スクリプトを一括実行する。`_` を `/` に変換する規約（`middleware_immer` -> `middleware/immer`）により、npm scripts の制約内でネストパスを扱える。

### 環境変数の条件置換

ESM ビルドと CJS ビルドで環境変数の参照方法を変える:

```javascript
// rollup.config.mjs:47-72 (createESMConfig)
replace({
  ...(output.endsWith(".js")
    ? {
      "import.meta.env?.MODE": "process.env.NODE_ENV",
    }
    : {
      "import.meta.env?.MODE": "(import.meta.env ? import.meta.env.MODE : undefined)",
    }),
  // ...
});
```

```javascript
// rollup.config.mjs:75-91 (createCommonJSConfig)
replace({
  "import.meta.env?.MODE": "process.env.NODE_ENV",
  // ...
});
```

ソースコードでは `import.meta.env?.MODE` を統一的に使い（`src/middleware/devtools.ts:202`, `src/middleware/devtools.ts:287`）、ビルド時にターゲットに応じた形式に置換する。ソースコードが特定のモジュールシステムに依存しない。

### alias による内部インポートパスの変換

```javascript
// rollup.config.mjs:11-16
export const entries = [
  { find: /.*\/vanilla\/shallow\.ts$/, replacement: "zustand/vanilla/shallow" },
  { find: /.*\/react\/shallow\.ts$/, replacement: "zustand/react/shallow" },
  { find: /.*\/vanilla\.ts$/, replacement: "zustand/vanilla" },
  { find: /.*\/react\.ts$/, replacement: "zustand/react" },
];
```

ソースでは相対パス（`./vanilla.ts`）でインポートするが、ビルド成果物では `zustand/vanilla` のようなパッケージパスに変換される。これにより、ソースコードの可読性とビルド成果物の正確性を両立する。

### postbuild パッチチェーン

ビルド後に 4 段階のパッチ処理が走る:

1. **patch-d-ts**: d.ts 内の相対パスを `zustand/*` 形式に変換（alias と同じ変換をd.tsにも適用）
2. **copy**: `dist/src/*` を `dist/esm` と `dist/` にコピーし、`package.json` から `private`/`devDependencies`/`scripts` を削除
3. **patch-old-ts**: TypeScript 4.5 未満向けの空の d.ts ファイルを生成
4. **patch-esm-ts**: `.d.ts` を `.d.mts` にリネームし、import パスに `.mjs` 拡張子を付与

`patch-d-ts` は `rollup.config.mjs` の `entries` を再利用してパス変換する:

```bash
# package.json:84 (patch-d-ts、簡略化)
node --input-type=module -e "
  import { entries } from './rollup.config.mjs';
  import shelljs from 'shelljs';
  const { find, sed } = shelljs;
  find('dist/**/*.d.ts').forEach(f => {
    entries.forEach(({ find, replacement }) => {
      sed('-i', new RegExp(...), ' from \'' + replacement + '\';', f);
    });
    sed('-i', / from '(\.[^']+)\.ts';$/, ' from \'$1\';', f);
  });
"
```

### dist ディレクトリからの publish

```yaml
# .github/workflows/publish.yml:23-25
- run: npm publish
  working-directory: dist
```

`dist/` 自体がパッケージルートになるため、`files` フィールドは `["**"]`（`package.json:58-60`）で全ファイルを含む。`copy` スクリプトで `package.json` を `dist/` にコピーし、`private: false` に変更する。これにより、ルートの `package.json` は `"private": true` のまま維持される。

### TypeScript の厳格な型設定

```json
// tsconfig.json:2-16
"strict": true,
"verbatimModuleSyntax": true,
"isolatedDeclarations": true,
"noUncheckedIndexedAccess": true,
"exactOptionalPropertyTypes": true,
```

`isolatedDeclarations` を有効にすることで、各ファイルが単独で d.ts を生成できることを保証する。これはモジュール別ビルドの前提条件であり、ビルドの並列化にも寄与する。

### CI によるバンドルサイズ監視

```yaml
# .github/workflows/compressed-size.yml:15-17
- uses: preactjs/compressed-size-action@v3
  with:
    pattern: './dist/**/*.{js,mjs}'
```

PR ごとに CJS/ESM 双方のバンドルサイズを計測し、コメントで可視化する。サイズの回帰を早期に検出する。

### ビルド成果物に対するテスト

::: v-pre

```yaml
# .github/workflows/test-multiple-builds.yml:36-44
- name: Patch for CJS
  if: ${{ matrix.build == 'cjs' }}
  run: |
    sed -i~ "s/resolve('\.\/src\(.*\)\.ts')/resolve('\.\/dist\1.js')/" vitest.config.mts
- name: Patch for ESM
  if: ${{ matrix.build == 'esm' }}
  run: |
    sed -i~ "s/resolve('\.\/src\(.*\)\.ts')/resolve('\.\/dist\/esm\1.mjs')/" vitest.config.mts
```

:::

vitest のエイリアス設定を `sed` で書き換え、テストの対象をソースからビルド成果物に切り替える。ソースでは通過するがビルド成果物では失敗するケース（import パスの誤り、tree-shaking による副作用除去等）を検出できる。

### TypeScript バージョン互換性マトリクス

```yaml
# .github/workflows/test-old-typescript.yml:14-30
matrix:
  typescript:
    - 5.9.3
    - 5.8.3
    # ... 省略 ...
    - 4.5.5
```

各バージョンに応じて tsconfig.json を段階的にパッチする。古い TypeScript では `verbatimModuleSyntax` や `bundler` moduleResolution が使えないため、対応する設定を削除し、パスマッピングを `dist/*.d.ts` に切り替える。

### `typesVersions` によるフォールバック

```json
// package.json:9-26
"typesVersions": {
  ">=4.5": {
    "esm/*": ["esm/*"],
    "*": ["*"]
  },
  "*": {
    "esm/*": ["ts_version_4.5_and_above_is_required.d.ts"],
    "*": ["ts_version_4.5_and_above_is_required.d.ts"]
  }
}
```

TypeScript 4.5 未満のユーザーには空の d.ts を返し、型エラーではなく明示的な「バージョンが古い」というメッセージを提供する。`patch-old-ts` スクリプト（`package.json:86`）で空ファイルを生成する。

## コード例

```javascript
// rollup.config.mjs:18-21 — external 関数: 全外部依存をバンドルから除外
function external(id) {
  return !id.startsWith(".") && !id.startsWith(root);
}
```

```javascript
// rollup.config.mjs:22-28 — esbuild トランスパイル設定
function getEsbuild() {
  return esbuild({
    target: "es2018",
    supported: { "import-meta": true },
    tsconfig: path.resolve("./tsconfig.json"),
  });
}
```

```javascript
// rollup.config.mjs:53-55 — alias フィルタリング: 自身のエントリを alias 対象から除外
alias({ entries: entries.filter((entry) => !entry.find.test(input)) }),
```

```javascript
// src/middleware/devtools.ts:201-203 — ソースコードでの統一的な環境変数参照
extensionConnector = (enabled ?? import.meta.env?.MODE !== "production")
  && window.__REDUX_DEVTOOLS_EXTENSION__;
```

```yaml
# .github/workflows/preview-release.yml:17
- run: pnpm dlx pkg-pr-new publish './dist' --compact --template './examples/*'
```

## パターンカタログ

- **Builder パターン** (分類: 生成)
  - 解決する問題: 複数のビルドバリアント（CJS/ESM/d.ts）を同一の設定基盤から生成する
  - 適用条件: ライブラリがマルチフォーマット出力を必要とする場合
  - コード例: `rollup.config.mjs:30-91` — `createDeclarationConfig`, `createESMConfig`, `createCommonJSConfig` の3つのファクトリ関数
  - 注意点: ファクトリ関数間で plugin 設定の一貫性を保つ必要がある（`external` 関数の共有で実現）

- **Pipeline パターン** (分類: 振る舞い)
  - 解決する問題: ビルド成果物を段階的に加工し、最終的なパッケージ構造を構築する
  - 適用条件: ビルドツールの出力がそのまま配布形態にならない場合
  - コード例: `package.json:75` — `postbuild: patch-d-ts && copy && patch-old-ts && patch-esm-ts`
  - 注意点: パッチの順序に依存関係がある（copy が先にファイルを配置し、patch-esm-ts がそれをリネームする）

## Good Patterns

- **ビルド設定の DRY 化**: `rollup.config.mjs` で `external`, `getEsbuild`, `entries` を共通化し、`createESMConfig` / `createCommonJSConfig` / `createDeclarationConfig` の3関数で再利用する。設定の重複を排除しつつ、フォーマットごとの差異（置換ルール）は各関数内に閉じ込める。

```javascript
// rollup.config.mjs:18-21 — 全ビルドバリアントで共有される external 判定
function external(id) {
  return !id.startsWith(".") && !id.startsWith(root);
}
```

- **パッチスクリプトの変換テーブル再利用**: `patch-d-ts` が `rollup.config.mjs` の `entries` をインポートして使う。変換テーブルが一箇所で管理され、ビルドとパッチの整合性が保証される。

- **pkg-pr-new による PR プレビューリリース**: `preview-release.yml` で PR ごとにパッケージをプレビュー公開し、CI/CD パイプラインを経ずに手元で動作確認できる。`--template './examples/*'` でサンプルプロジェクトも自動生成される。

- **sideEffects: false の宣言**: `package.json:61` で明示的に `"sideEffects": false` を宣言し、bundler による tree-shaking を最大限に活用する。zustand の全モジュールが副作用なしで設計されていることの表明でもある。

## Anti-Patterns / 注意点

- **inline スクリプトの可読性限界**: `patch-d-ts` や `patch-esm-ts` のスクリプトは `node -e` で1行にインライン化されており、可読性・保守性が低い。

```json
// Bad: package.json:84 — 1行に詰め込まれた patch-d-ts
"patch-d-ts": "node --input-type=module -e \"import { entries } from './rollup.config.mjs'; import shelljs from 'shelljs'; ...\""
```

```javascript
// Better: scripts/patch-d-ts.mjs として外部ファイルに分離
import { find, sed } from "shelljs";
import { entries } from "../rollup.config.mjs";

find("dist/**/*.d.ts").forEach(f => {
  entries.forEach(({ find: pattern, replacement }) => {
    sed("-i", new RegExp(pattern.source.slice(0, -1)), `'${replacement}';`, f);
  });
  sed("-i", / from '(\.[^']+)\.ts';$/, " from '$1';", f);
});
```

- **shelljs への依存**: Node.js のビルドスクリプトで `shelljs` を使ってファイル操作を行っている。Node.js 標準の `fs` API や `glob` パッケージに置き換えることで、依存を削減できる可能性がある。ただし zustand の場合、`shelljs` の `sed` がストリーム処理的なパターンマッチ置換に便利なため、トレードオフとして許容されている。

## 導出ルール

- `[MUST]` ライブラリの CJS/ESM デュアルビルドでは `package.json` の `exports` フィールドに `import` / `default` の条件分岐を設定し、各条件に `types` キーを含めて型解決を保証する
  - 根拠: zustand の `exports` マップ（`package.json:28-57`）は `types` を各条件の先頭に配置し、TypeScript が正しい d.ts を参照できるようにしている

- `[MUST]` ビルド成果物に対して、ソースコードと同じテストスイートを実行する CI を構築する（ソースのテスト通過はビルド成果物の正常性を保証しない）
  - 根拠: `test-multiple-builds.yml` が CJS/ESM 双方のビルド成果物に対して vitest を実行し、import パスやモジュール解決の問題を検出する

- `[MUST]` ソースコード内の環境判定は単一の記法（`import.meta.env?.MODE` 等）に統一し、CJS/ESM ごとの差異はビルド時の置換で吸収する
  - 根拠: zustand のソースコードは `import.meta.env?.MODE` に統一し、Rollup の `replace` プラグインが ESM では `import.meta.env` を、CJS では `process.env.NODE_ENV` に置換する（`rollup.config.mjs:55-63`, `rollup.config.mjs:83-84`）

- `[SHOULD]` ライブラリの publish は `dist/` ディレクトリをルートとして行い、ユーザーに `dist/` を含まないクリーンなインポートパスを提供する
  - 根拠: zustand は `npm publish` を `working-directory: dist` で実行し（`publish.yml:25`）、`zustand/middleware` のようなパスでインポートできるようにしている

- `[SHOULD]` PR ごとにバンドルサイズを自動計測し、サイズ回帰を可視化する CI を導入する（特に tree-shakeable なライブラリでは、不要な副作用の混入を早期検出できる）
  - 根拠: `compressed-size.yml` が `preactjs/compressed-size-action` で `dist/**/*.{js,mjs}` のサイズを PR コメントに表示する

- `[SHOULD]` ライブラリの `package.json` に `"sideEffects": false` を明示し、bundler が安全に tree-shaking できることを宣言する
  - 根拠: zustand は `package.json:61` で `"sideEffects": false` を宣言し、未使用モジュール（middleware 等）がバンドルに含まれないことを保証する

- `[SHOULD]` TypeScript ライブラリでは `typesVersions` を設定し、サポート外のバージョンに対して明示的なフォールバックを提供する（型エラーの代わりにバージョン要件を伝える）
  - 根拠: zustand は TypeScript 4.5 未満で空の `ts_version_4.5_and_above_is_required.d.ts` を返す（`package.json:18-25`, `package.json:86`）

- `[AVOID]` ビルド後のパッチスクリプトを `package.json` の `scripts` に1行でインライン化する（可読性と保守性が著しく低下する。5行を超えるスクリプトは外部ファイルに分離すべき）
  - 根拠: zustand の `patch-d-ts`（`package.json:84`）と `patch-esm-ts`（`package.json:87`）は1行に詰め込まれた node スクリプトで、読解・修正が困難

## 適用チェックリスト

- [ ] `package.json` の `exports` フィールドに CJS/ESM の条件分岐を設定し、各条件に `types` エントリを含めている
- [ ] ESM 出力には `.mjs` 拡張子、型定義には `.d.mts` 拡張子を使用している
- [ ] ビルド成果物（dist/）に対してテストスイートを実行する CI ジョブがある
- [ ] PR ごとにバンドルサイズを計測・可視化する CI が設定されている
- [ ] `sideEffects` フィールドが正しく設定されている（`false` または副作用ファイルの配列）
- [ ] ソースコードの環境判定が単一の記法に統一されている
- [ ] publish するパッケージのルートがクリーンなインポートパスを提供している（`dist/` からの publish 等）
- [ ] サポート対象の TypeScript バージョン範囲が CI マトリクスで検証されている
- [ ] ビルドスクリプトの変換テーブル（alias, パスマッピング等）がビルドとパッチで一元管理されている
- [ ] `package.json` にインライン化されたスクリプトが長すぎないか確認し、必要に応じて外部ファイルに分離している
