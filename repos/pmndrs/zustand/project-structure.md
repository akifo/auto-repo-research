# project-structure

> リポジトリ: pmndrs/zustand
> 分析日: 2026-02-20

## 概要

zustand のプロジェクト構造を、ソースとビルド成果物の分離、サブパスエクスポート設計、CJS/ESM デュアルパッケージ戦略の観点から分析する。小規模（ソース 16 ファイル）でありながら、フレームワーク非依存コアと React バインディングの分離、ミドルウェアの独立エントリポイント化、CJS/ESM デュアルビルド + React Native 対応という多層的なパッケージング戦略を実現している。特に「ソースでは相対パスで参照し、ビルド時にパッケージ名エイリアスへ書き換える」手法と、`dist/` ディレクトリをそのまま npm パッケージルートとして publish するアプローチが注目に値する。

## 背景にある原則

- **関心の層ごとにエントリポイントを分離すべき。消費者が不要な依存を引き込まないために**: zustand は `vanilla`（コア）、`react`（React バインディング）、`middleware`（拡張）、`shallow`（ユーティリティ）をそれぞれ独立したサブパスエクスポートとして公開している。React を使わないプロジェクトは `zustand/vanilla` だけを import でき、`react` への依存が発生しない。peerDependencies がすべて optional であることがこの設計を裏付ける（`package.json:166-179`）。

- **ビルド成果物をパッケージルートとして publish すべき。消費者の import パスを簡潔に保つために**: ソースの `src/` から `dist/` へビルドし、`dist/` 内に `package.json` をコピーして `npm publish` を `dist/` から実行する。これにより消費者は `zustand/dist/vanilla` ではなく `zustand/vanilla` と書ける。`publish.yml:25` で `working-directory: dist` が指定されている。

- **ソース内の相対パスをビルド時にパッケージ名へ書き換えるべき。サブパスエクスポート間の独立性を保つために**: `src/react.ts` は `./vanilla.ts` を相対 import しているが、ビルド後の `dist/react.js` は `zustand/vanilla` を import する。各サブパスが独立したバンドルエントリとして機能するため、バンドラーの tree-shaking が正しく動作する（`rollup.config.mjs:11-16`）。

- **環境変数のアクセス方法をビルドフォーマットに応じて切り替えるべき。CJS と ESM の実行環境差異を吸収するために**: CJS ビルドでは `import.meta.env?.MODE` を `process.env.NODE_ENV` に置換し、ESM ビルドでは `import.meta.env` を条件付きで参照する。同一ソースから両フォーマットを生成しつつ、各環境で正しく動作させている（`rollup.config.mjs:55-63, 83-84`）。

## 実例と分析

### ソースツリーの階層設計

ソースは 3 層構造になっている。

```
src/
├── vanilla.ts          # Layer 0: フレームワーク非依存コア
├── react.ts            # Layer 1: React バインディング（vanilla に依存）
├── traditional.ts      # Layer 1: 旧来 React バインディング
├── index.ts            # Facade: vanilla + react を re-export
├── middleware/          # Extension: コアを拡張するミドルウェア群
├── middleware.ts        # Barrel: ミドルウェアの re-export
├── shallow.ts          # Utility Barrel: vanilla/shallow + react/shallow
├── vanilla/shallow.ts  # Layer 0 Utility
└── react/shallow.ts    # Layer 1 Utility
```

依存の方向は常に上位層から下位層への一方通行。`vanilla.ts` は他のソースファイルを一切 import せず、`react.ts` は `vanilla.ts` のみを import する。ミドルウェアは `../vanilla.ts` のみに依存する。この制約が、各サブパスを独立してビルド可能にしている。

### サブパスエクスポートとビルドの 1:1 対応

`package.json` の `exports` フィールドで定義された各サブパスが、`build:*` スクリプトのそれぞれに対応する。

| サブパス       | ビルドスクリプト   | ソース              | CJS 出力             | ESM 出力                  |
| -------------- | ------------------ | ------------------- | -------------------- | ------------------------- |
| `.`            | `build:base`       | `src/index.ts`      | `dist/index.js`      | `dist/esm/index.mjs`      |
| `./vanilla`    | `build:vanilla`    | `src/vanilla.ts`    | `dist/vanilla.js`    | `dist/esm/vanilla.mjs`    |
| `./react`      | `build:react`      | `src/react.ts`      | `dist/react.js`      | `dist/esm/react.mjs`      |
| `./middleware` | `build:middleware` | `src/middleware.ts` | `dist/middleware.js` | `dist/esm/middleware.mjs` |
| `./shallow`    | `build:shallow`    | `src/shallow.ts`    | `dist/shallow.js`    | `dist/esm/shallow.mjs`    |

各ビルドは Rollup の `--config-*` フラグで制御される。`rollup.config.mjs:93-104` で `args` からフラグ名を抽出し、対応する `src/*.ts` をエントリとする。

### dist ディレクトリを publish ルートにする仕組み

postbuild の `copy` スクリプト（`package.json:85`）で以下を実行する:

1. `dist/src/*` を `dist/esm` と `dist/` にコピー（型定義の配置）
2. `dist/src` と `dist/tests` を削除（不要ディレクトリの除去）
3. `package.json`, `README.md`, `LICENSE` を `dist/` にコピー
4. `dist/package.json` から `private`, `devDependencies`, `optionalDependencies`, `scripts`, `prettier` フィールドを削除

結果として `dist/` がそのまま npm パッケージとして publish 可能になる。`publish.yml:25` で `working-directory: dist` が指定されているため、`npm publish` は `dist/package.json` を参照する。

### CJS/ESM デュアルビルドの詳細

Rollup の設定で、同一ソースから CJS（`.js`）と ESM（`.mjs`）の両方を生成する。

**CJS 生成** (`rollup.config.mjs:75-91`): `format: 'cjs'`、`import.meta.env?.MODE` を `process.env.NODE_ENV` に一律置換。

**ESM 生成** (`rollup.config.mjs:47-73`): `format: 'esm'`、出力が `.js` か `.mjs` かで `import.meta.env` の置換方法を切り替え。`.mjs` の場合は `import.meta.env` をそのまま活かす条件式に変換する。

**型定義の二重生成**: postbuild の `patch-esm-ts` スクリプト（`package.json:87`）で `dist/esm/*.d.ts` を `.d.mts` にリネームし、import パスの拡張子を `.mjs` に書き換える。これにより ESM の `exports` 条件で `.d.mts` が正しく解決される。

### Rollup エイリアスによるパッケージ内相対パスの書き換え

`rollup.config.mjs:11-16` で定義された `entries` 配列が、ビルド時にソース内の相対パスをパッケージ名に書き換える。

```
./vanilla.ts → zustand/vanilla
./react.ts   → zustand/react
./vanilla/shallow.ts → zustand/vanilla/shallow
./react/shallow.ts   → zustand/react/shallow
```

ただし、自分自身のエントリと一致するエイリアスは除外される（`entries.filter((entry) => !entry.find.test(input))`）。例えば `src/react.ts` をビルドする際、`./vanilla.ts → zustand/vanilla` は適用されるが、`./react.ts → zustand/react` は除外される。

### TypeScript バージョン互換の防御策

`typesVersions` フィールド（`package.json:9-26`）で TS 4.5 未満を明示的にブロックしている。`>=4.5` 条件に一致しない場合、`ts_version_4.5_and_above_is_required.d.ts` という空ファイル（`patch-old-ts` スクリプトで生成）が参照され、型エラーとなる。

CI では TS 4.5 から 5.9 まで 15 バージョンのマトリクスで型チェックを実行し、古い TS では `isolatedDeclarations`、`verbatimModuleSyntax`、`moduleResolution: "bundler"` などのフラグを `sed` で除去して互換性を確保している（`.github/workflows/test-old-typescript.yml`）。

### React Native 対応

`exports` の各サブパスで `react-native` 条件を最上位に配置している（`package.json:30-33, 44-47`）。React Native のバンドラー（Metro）は ESM の `import` 条件よりも `react-native` 条件を優先するため、CJS 形式の `.js` ファイルが使用される。

### ビルド成果物の品質ゲート

CI で以下の多段階検証を実施している:

1. **ソーステスト**: `test:spec` でソースに対して Vitest を実行（`.github/workflows/test.yml`）
2. **ビルド成果物テスト**: CJS/ESM それぞれのビルド出力に対してテストを実行（`.github/workflows/test-multiple-builds.yml`）。vitest.config.mts のエイリアスを `sed` で書き換えて `dist/*.js` や `dist/esm/*.mjs` を直接テストする
3. **バンドルサイズ監視**: `compressed-size-action` で `dist/**/*.{js,mjs}` の圧縮サイズを PR ごとに比較（`.github/workflows/compressed-size.yml`）
4. **React バージョンマトリクス**: React 18.0 から 19.x、canary、experimental まで 9 バージョンでテスト（`.github/workflows/test-multiple-versions.yml`）

## コード例

```typescript
// rollup.config.mjs:11-16 — ソース相対パスからパッケージ名エイリアスへの変換テーブル
export const entries = [
  { find: /.*\/vanilla\/shallow\.ts$/, replacement: "zustand/vanilla/shallow" },
  { find: /.*\/react\/shallow\.ts$/, replacement: "zustand/react/shallow" },
  { find: /.*\/vanilla\.ts$/, replacement: "zustand/vanilla" },
  { find: /.*\/react\.ts$/, replacement: "zustand/react" },
];
```

```typescript
// rollup.config.mjs:47-73 — ESM ビルドでの環境変数置換（フォーマット依存の分岐）
function createESMConfig(input, output) {
  return {
    input,
    output: { file: output, format: "esm" },
    external,
    plugins: [
      alias({ entries: entries.filter((entry) => !entry.find.test(input)) }),
      resolve({ extensions }),
      replace({
        ...(output.endsWith(".js")
          ? {
            "import.meta.env?.MODE": "process.env.NODE_ENV",
          }
          : {
            "import.meta.env?.MODE": "(import.meta.env ? import.meta.env.MODE : undefined)",
          }),
        // ...
      }),
      getEsbuild(),
    ],
  };
}
```

```typescript
// src/index.ts:1-2 — Facade パターン: vanilla + react を統合 re-export
export * from "./react.ts";
export * from "./vanilla.ts";
```

```typescript
// src/middleware.ts:1-17 — Barrel エクスポート: 個別ミドルウェアの集約
export { combine } from "./middleware/combine.ts";
export { devtools, type DevtoolsOptions, type NamedSet } from "./middleware/devtools.ts";
export {
  createJSONStorage,
  persist,
  type PersistOptions,
  type PersistStorage,
  type StateStorage,
  type StorageValue,
} from "./middleware/persist.ts";
export { redux } from "./middleware/redux.ts";
export { ssrSafe as unstable_ssrSafe } from "./middleware/ssrSafe.ts";
export { subscribeWithSelector } from "./middleware/subscribeWithSelector.ts";
```

```json
// package.json:29-56 — 3 条件対応のサブパスエクスポート
"exports": {
  ".": {
    "react-native": { "types": "./index.d.ts", "default": "./index.js" },
    "import": { "types": "./esm/index.d.mts", "default": "./esm/index.mjs" },
    "default": { "types": "./index.d.ts", "default": "./index.js" }
  },
  "./*": {
    "react-native": { "types": "./*.d.ts", "default": "./*.js" },
    "import": { "types": "./esm/*.d.mts", "default": "./esm/*.mjs" },
    "default": { "types": "./*.d.ts", "default": "./*.js" }
  }
}
```

## パターンカタログ

- **Facade パターン** (分類: 構造)
  - 解決する問題: 消費者が内部モジュール構造を意識せずに主要 API にアクセスできるようにする
  - 適用条件: 複数の内部モジュールを統合して単一のインターフェースを提供したい場合
  - コード例: `src/index.ts:1-2` — `vanilla` と `react` を re-export
  - 注意点: Facade 経由の import では tree-shaking が効きにくい場合がある。zustand では `sideEffects: false` で緩和

- **Layered Architecture** (分類: アーキテクチャ)
  - 解決する問題: フレームワーク依存部とフレームワーク非依存部の混在を防ぐ
  - 適用条件: ライブラリが複数のランタイム環境（Node.js、ブラウザ、React Native）で動作する必要がある場合
  - コード例: `src/vanilla.ts`（Layer 0）→ `src/react.ts`（Layer 1）。依存は常に上位から下位への一方通行
  - 注意点: 層をまたぐ型の共有は `declare module` によるモジュール拡張で実現（`src/middleware/immer.ts:14-19`）

## Good Patterns

- **ワイルドカードサブパスエクスポート `"./*"`**: 個別のサブパスを列挙する代わりに `"./*"` パターンで一括定義している（`package.json:43-55`）。新しいサブパスを追加してもエクスポートマップの変更が不要で、ビルドスクリプトを追加するだけで済む。

```json
// package.json:43-55
"./*": {
  "react-native": { "types": "./*.d.ts", "default": "./*.js" },
  "import": { "types": "./esm/*.d.mts", "default": "./esm/*.mjs" },
  "default": { "types": "./*.d.ts", "default": "./*.js" }
}
```

- **ビルド成果物に対するテスト実行**: ソースだけでなく、CJS/ESM のビルド成果物に対してもテストを実行している（`.github/workflows/test-multiple-builds.yml`）。vitest.config.mts のエイリアスを `sed` で差し替えることで、同一テストスイートを異なるビルド出力に適用する。

::: v-pre

```yaml
# .github/workflows/test-multiple-builds.yml:37-43
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

- **全 peerDependencies を optional 化**: `react`、`immer`、`use-sync-external-store` をすべて optional peerDependencies として宣言（`package.json:166-179`）。コアの `vanilla.ts` は外部依存ゼロで動作し、React バインディングは `react` がある場合のみ機能する。

- **`sideEffects: false` 宣言**: パッケージ全体に副作用がないことを宣言し（`package.json:61`）、バンドラーが未使用のサブパスを安全に除去できるようにしている。

## Anti-Patterns / 注意点

- **postbuild シェルスクリプトの複雑性**: `patch-d-ts`、`copy`、`patch-esm-ts` が package.json の `scripts` フィールド内にインライン Node.js コードとして記述されている。`sed` 相当の処理を shelljs で実行しており、可読性が低く、デバッグが困難。

```json
// package.json:84 — Bad: インラインの postbuild スクリプト
"patch-d-ts": "node --input-type=module -e \"import { entries } from './rollup.config.mjs'; ...\""
```

```javascript
// Better: 独立したスクリプトファイル scripts/patch-d-ts.mjs
import { find, sed } from "shelljs";
import { entries } from "../rollup.config.mjs";

find("dist/**/*.d.ts").forEach(f => {
  entries.forEach(({ find: pattern, replacement }) => {
    sed("-i", new RegExp(/* ... */), ` from '${replacement}';`, f);
  });
});
```

- **CI での `sed` による設定書き換え**: `test-old-typescript.yml` と `test-multiple-builds.yml` で tsconfig.json や vitest.config.mts を `sed` で動的に書き換えている。正規表現が壊れやすく、設定変更時に CI が意図せず壊れるリスクがある。

```yaml
# Bad: sed による tsconfig.json の動的パッチ
sed -i~ 's/"moduleResolution": "bundler",/"moduleResolution": "node",/' tsconfig.json
```

```yaml
# Better: 環境ごとの tsconfig を extends で分離
# tsconfig.node-resolution.json
{ "extends": "./tsconfig.json", "compilerOptions": { "moduleResolution": "node" } }
```

## 導出ルール

- `[MUST]` CJS/ESM デュアルパッケージでは、各サブパスエクスポートの `import` 条件に `types` フィールドを `default` より前に配置する
  - 根拠: TypeScript は `exports` 内の条件を上から順に評価する。`types` が `default` の後にあると `.mjs` に対して `.d.ts`（CJS 用）が解決される場合がある（`package.json:35-36` で `types` → `default` の順序を遵守）

- `[MUST]` サブパスエクスポートを持つパッケージでは、ビルド成果物のディレクトリをパッケージルートとして publish する（ソースルートから publish しない）
  - 根拠: `exports` のパスは publish されたパッケージルートからの相対パスで解決される。ソースルートから publish すると `dist/` プレフィックスがエクスポートパスに露出し、消費者の import パスが冗長になる（`publish.yml:25` で `working-directory: dist` を指定）

- `[MUST]` 独立してビルドされるサブパスエクスポート間の import は、ビルド時にパッケージ名（自己参照）に書き換える
  - 根拠: 相対パスのままビルドすると、バンドラーがサブパス間の依存をインライン化し、同一コードが複数チャンクに重複する。パッケージ名に書き換えることで external 扱いとなり、tree-shaking が正しく動作する（`rollup.config.mjs:11-16`）

- `[SHOULD]` ESM 用の型定義ファイルは `.d.mts` 拡張子で提供し、内部 import パスの拡張子も `.mjs` に統一する
  - 根拠: TypeScript の `moduleResolution: "bundler"` や `"node16"` では、`.mjs` ファイルに対して `.d.mts` を探索する。`.d.ts` のみだと ESM 条件で型解決に失敗する場合がある（`package.json:87` の `patch-esm-ts` で `.d.ts` → `.d.mts` リネーム + import パス書き換え）

- `[SHOULD]` フレームワーク非依存のコアロジックとフレームワーク固有のバインディングは別のサブパスエクスポートに分離し、フレームワークを optional peerDependency にする
  - 根拠: zustand では `vanilla`（コア）と `react`（バインディング）を分離し、React を optional peerDependency にしている。これにより Node.js の CLI ツールやVue/Svelte からコアを直接使用でき、不要な `react` 依存を強制しない（`src/vanilla.ts` は外部依存ゼロ）

- `[SHOULD]` ソースに対するテストだけでなく、CJS/ESM の各ビルド成果物に対しても同一テストスイートを実行する
  - 根拠: ビルド時のエイリアス置換、`import.meta.env` の変換、`.mjs` 拡張子処理などでビルド成果物がソースと異なる挙動を示す可能性がある。zustand は CI でビルド出力を差し替えてテストを再実行している（`.github/workflows/test-multiple-builds.yml`）

- `[AVOID]` package.json の `scripts` フィールドにインラインの複雑なシェルコマンドや Node.js ワンライナーを記述する
  - 根拠: zustand の `patch-d-ts`、`patch-esm-ts` は 1 行に圧縮されたスクリプトで、可読性・保守性が低い。独立したスクリプトファイルに分離すべき（`package.json:84,87`）

## 適用チェックリスト

- [ ] `package.json` の `exports` フィールドで、各条件の `types` が `default` より前に配置されているか
- [ ] サブパスエクスポートごとに CJS（`.js` + `.d.ts`）と ESM（`.mjs` + `.d.mts`）の両方のファイルが生成されているか
- [ ] ビルド成果物のディレクトリを publish ルートにしているか（`npm publish` を `dist/` から実行）
- [ ] サブパスエクスポート間の import がビルド後にパッケージ名（自己参照）に解決されているか確認したか
- [ ] `sideEffects: false` が設定されているか（すべてのエクスポートが副作用なしの場合）
- [ ] フレームワーク固有の依存が optional peerDependency として宣言されているか
- [ ] CI でビルド成果物（CJS/ESM 両方）に対するテストを実行しているか
- [ ] React Native を対象とする場合、`exports` の条件順序で `react-native` が `import` より前にあるか
- [ ] 複数の TypeScript バージョンで型チェックが通ることを CI で検証しているか
