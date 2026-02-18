# build-and-tooling

> リポジトリ: vitejs/vite
> 分析日: 2026-02-17

## 概要

Vite はビルドツールでありながら自らもバンドラーで「セルフバンドル」するという、ドッグフーディングの極致にあるプロジェクトである。コアパッケージは Rolldown でバンドルし、サブパッケージは tsdown で軽量にビルドするという、パッケージの性質に応じたツール使い分け戦略を採る。さらに `devDependencies` をバンドルに含めることで公開パッケージの依存を極限まで削減し、型バンドリングでは専用の Rolldown 設定で `.d.ts` を生成・検証する二段構えのパイプラインを構築している。このアプローチは「ランタイム依存の最小化」「ビルド時の品質ゲート」「開発体験の高速化」を同時に実現する実践的な手法である。

## 背景にある原則

- **依存は可能な限りバンドルに内包し、ランタイム依存を最小化すべき**: Vite は多くの依存を `devDependencies` に配置し、Rolldown でバンドルに含める。公開時の `dependencies` にはバイナリ依存（rolldown 等）や公開型に露出するパッケージのみを残す。CONTRIBUTING.md に「Most deps should be added to `devDependencies` even if they are needed at runtime」と明記されている（`packages/vite/package.json:74`）。
- **ビルドパイプライン自体に品質ゲートを組み込むべき**: バンドルサイズ上限チェック（`bundleSizeLimit`）、型の import 検証（`validateChunkImports`）、紛らわしい型名の自動修正（`replaceConfusingTypeNames`）をビルドプラグインとして実装し、CI ではなくビルド工程で品質を担保する。
- **Watch モードとプロダクションビルドの振る舞いは明示的に分岐すべき**: `this.meta.watchMode` で開発時には重いプラグイン処理をスキップし、型出力を簡略化する。これにより開発ループを高速に保ちつつ、プロダクションビルドでは全検証が走る。
- **パッケージの性質に応じてビルドツールを選択すべき**: コアの `vite` パッケージは複数エントリ・カスタムプラグイン・型バンドリングが必要なため Rolldown を直接使い、`create-vite` や `plugin-legacy` のような単純なパッケージは tsdown で最小設定でビルドする。

## 実例と分析

### セルフバンドリングによる依存内包戦略

Vite の `package.json` は `dependencies` にわずか 6 パッケージ（rolldown, postcss, lightningcss, picomatch, tinyglobby, @oxc-project/runtime）のみを持ち、残りの約 40 個の依存は `devDependencies` に配置してバンドルに含める。

```typescript
// packages/vite/rolldown.config.ts:79-92
external: [
  /^vite\//,
  'fsevents',
  /^rolldown\//,
  /^tsx\//,
  /^@vitejs\/devtools\//,
  /^#/,
  'sugarss',
  'supports-color',
  'utf-8-validate',
  'bufferutil',
  ...Object.keys(pkg.dependencies),
  ...Object.keys(pkg.peerDependencies),
],
```

`external` に指定するのは `dependencies` と `peerDependencies` のみであり、`devDependencies` はバンドルに取り込まれる。ESLint でも `devDependencies` を `require()` で読み込むことを禁止し、`await import()` によるバンドラー包含を強制している。

```javascript
// eslint.config.js:203-214
'n/no-restricted-require': [
  'error',
  Object.keys(pkgVite.devDependencies).map((d) => ({
    name: d,
    message:
      `devDependencies can only be imported using ESM syntax so ` +
      `that they are included in the rolldown bundle.`,
  })),
],
```

### 複数エントリポイントによるビルド分割

`rolldown.config.ts` は 4 つの設定を配列で export する: `envConfig`（ブラウザ向け環境変数）、`clientConfig`（HMR クライアント）、`nodeConfig`（Node.js メインバンドル）、`moduleRunnerConfig`（軽量モジュールランナー）。各設定はプラットフォーム（`browser` / `node`）やターゲット（`es2020` / `ES2023`）を明示的に分離する。

```typescript
// packages/vite/rolldown.config.ts:161-166
export default defineConfig([
  envConfig,
  clientConfig,
  nodeConfig,
  moduleRunnerConfig,
]);
```

`moduleRunnerConfig` は minify を有効にし、`bundleSizeLimit(54)` で 54kB の上限を設定している。Node.js 以外の環境（エッジランタイム等）での利用を想定し、軽量性を保証する仕組みである。

### 依存のシミング（shimDepsPlugin）

バンドル対象の依存が CJS の `require` や `__filename` を使う場合、ソースコードを MagicString で書き換えてバンドル互換にする。

```typescript
// packages/vite/rolldown.config.ts:94-125
shimDepsPlugin({
  'postcss-load-config/src/req.js': [
    {
      src: "const { pathToFileURL } = require('node:url')",
      replacement: `const { fileURLToPath, pathToFileURL } = require('node:url')`,
    },
    {
      src: '__filename',
      replacement: 'fileURLToPath(import.meta.url)',
    },
  ],
  'postcss-import/index.js': [
    {
      src: 'const resolveId = require("./lib/resolve-id")',
      replacement: 'const resolveId = (id) => id',
    },
    ...
  ],
}),
```

`buildEnd` フックで未適用の shim がないか検証し、依存のアップデートでファイル名が変わった場合にビルドを失敗させる安全策も備える。

### import.meta.url のビルド時解決

`buildTimeImportMetaUrlPlugin` は、`src/` 内の `import.meta.url` をビルド時にプレースホルダへ置換し、`renderChunk` で出力ファイルからの相対パスに再計算する。`/** #__KEEP__ */` コメントで特定の `import.meta.url` を変換対象外にする仕組みもある。

```typescript
// packages/vite/src/node/config.ts:2543
const _require = createRequire(/** #__KEEP__ */ import.meta.url);
```

### 型バンドリングパイプライン

型定義は `rolldown.dts.config.ts` で `rolldown-plugin-dts` を使ってバンドルし、その後 `tsconfig.check.json` で `node16` モジュール解決による消費者視点の型チェックを行う二段構え。

```json
// packages/vite/tsconfig.check.json
{
  "compilerOptions": {
    "target": "ES2020",
    "moduleResolution": "node16",
    "module": "Node16",
    "lib": ["ES2020"],
    "types": [],
    "noEmit": true,
    "strict": true,
    "noUncheckedSideEffectImports": true,
    "exactOptionalPropertyTypes": true
  },
  "include": ["dist/**/*", "types/**/*"]
}
```

この設定は生成済み `dist/` と `types/` を対象とし、**消費者がパッケージを使う際に遭遇する型環境を再現する**ことで、型の整合性を保証する。

### 依存の型インライニング

`packages/vite/src/types/` に `connect.d.ts`, `chokidar.d.ts`, `ws.d.ts` 等のサードパーティ型定義を手動でインラインし、`#dep-types/*` import map で参照する。これにより、ソースを `devDependencies` としてバンドルしつつ、型は公開パッケージから参照可能にする。

```json
// packages/vite/package.json:38-39
"imports": {
  "#dep-types/*": "./src/types/*.d.ts"
}
```

### pnpm overrides による依存の差し替え

`debug` パッケージを `obug` に差し替える設定は、pnpm の `overrides` で実現する。

```yaml
# pnpm-workspace.yaml:17
overrides:
  debug: 'npm:obug@^1.0.2'
```

バンドル対象の全依存ツリーで `debug` が `obug`（軽量互換品）に置換される。パッチ適用が必要な依存は `patchedDependencies` で管理する。

### パッケージ別ビルドツール選択

| パッケージ      | ビルドツール  | 理由                                             |
| --------------- | ------------- | ------------------------------------------------ |
| `vite` (コア)   | Rolldown 直接 | 複数エントリ、カスタムプラグイン、型バンドリング |
| `create-vite`   | tsdown        | 単一エントリ、ライセンスプラグインのみ           |
| `plugin-legacy` | tsdown        | 単一エントリ、DTS 自動生成                       |

tsdown の設定は極めてシンプルである。

```typescript
// packages/plugin-legacy/tsdown.config.ts
export default defineConfig({
  entry: ["src/index.ts"],
  target: "node20",
  inlineOnly: ["picocolors"],
  tsconfig: false,
  dts: true,
  fixedExtension: false,
});
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: Watch モード / プロダクションビルドで異なる処理を実行したい
  - 適用条件: `this.meta.watchMode` で分岐
  - コード例: `rolldown.config.ts:170-213`（3 つのプラグインが watchMode で分岐）
  - 注意点: Watch モードでスキップする処理が増えすぎると、開発時とプロダクション時の差異が大きくなるリスクがある

- **Pipeline パターン** (分類: 構造)
  - 解決する問題: 型生成の正しさを段階的に検証したい
  - 適用条件: 型バンドリング + 消費者視点チェックの二段構え
  - コード例: `package.json:65-67`（build-types-roll -> build-types-check）
  - 注意点: パイプラインの各段階が独立していることが前提。途中段階の出力が壊れると後続が偽陽性を出す可能性がある

## Good Patterns

- **バンドルサイズの自動ガード**: `bundleSizeLimit` プラグインで kB 単位の上限を設定し、超過時にビルドを失敗させる。CI の別ステップではなくビルド工程に組み込むことで、サイズ肥大を即座に検知できる。

```typescript
// packages/vite/rolldown.config.ts:377-405
function bundleSizeLimit(limit: number): Plugin {
  let size = 0;
  return {
    name: "bundle-limit",
    generateBundle(_, bundle) {
      if (this.meta.watchMode) return;
      size = Buffer.byteLength(
        Object.values(bundle)
          .map((i) => ("code" in i ? i.code : ""))
          .join(""),
        "utf-8",
      );
    },
    closeBundle() {
      if (this.meta.watchMode) return;
      const kb = size / 1000;
      if (kb > limit) {
        this.error(`Bundle size exceeded ${limit} kB, current size is ${kb.toFixed(2)}kb.`);
      }
    },
  };
}
```

- **Node.js の条件付きインポートによるランタイム機能検出**: `#module-sync-enabled` を `package.json` の `imports` で `module-sync` 条件に応じて `true.js` / `false.js` に振り分ける。ポリフィルやフォールバックなしに、ランタイムの機能有無をビルド時に解決する。

```json
// packages/vite/package.json:34-37
"#module-sync-enabled": {
  "module-sync": "./misc/true.js",
  "default": "./misc/false.js"
}
```

- **ESLint による `devDependencies` の import 方式強制**: `require()` を禁止し `await import()` のみを許可することで、devDependencies がバンドルに確実に含まれることを lint レベルで担保する。

## Anti-Patterns / 注意点

- **依存の shim が増殖するリスク**: `shimDepsPlugin` は依存のソースコードを文字列ベースで書き換えるため、依存のアップデートで壊れやすい。`buildEnd` での未適用検証は安全策だが、shim の数が増えると保守コストが高くなる。

```typescript
// Bad: shim 対象が際限なく増える
shimDepsPlugin({
  "dep-a/file.js": [{ src: "...", replacement: "..." }],
  "dep-b/file.js": [{ src: "...", replacement: "..." }],
  "dep-c/file.js": [{ src: "...", replacement: "..." }],
  // 10個以上の shim...
});

// Better: shim が必要な依存は ESM 対応の代替パッケージに移行する
// 例: debug -> obug（pnpm overrides で差し替え）
```

- **型インラインの手動管理**: `src/types/` にサードパーティの `.d.ts` を手動でコピーする方法は、上流の型定義が変更された場合に追従が遅れる。自動化された型抽出の仕組みがないため、型の陳腐化リスクがある。

## 導出ルール

- `[MUST]` セルフバンドルする場合、バンドルに含める依存は `devDependencies` に、外部化する依存は `dependencies` に配置し、`external` 設定で明示的に切り分ける
  - 根拠: `rolldown.config.ts:79-92` で `pkg.dependencies` と `pkg.peerDependencies` のみを external に指定し、CONTRIBUTING.md でこの方針を文書化している
- `[MUST]` 型を公開するパッケージでは、生成後の型定義を消費者と同じモジュール解決設定（`node16` 等）で検証する型チェックステップを設ける
  - 根拠: `tsconfig.check.json` で `moduleResolution: "node16"` を使い `dist/` を検証する二段パイプラインにより、開発時の `bundler` 解決では見逃す型エラーを捕捉している
- `[SHOULD]` バンドルサイズの上限チェックをビルドプラグインとして組み込み、CI の別ステップではなくビルド工程で失敗させる
  - 根拠: `bundleSizeLimit` プラグインにより、module-runner の 54kB 上限が即座にガードされる（`rolldown.config.ts:150`）
- `[SHOULD]` モノレポでパッケージの複雑度に応じてビルドツールを使い分ける（フル制御が必要なコアは低レベルバンドラー、単純なパッケージは高レベルラッパー）
  - 根拠: `vite` は Rolldown 直接、`create-vite` / `plugin-legacy` は tsdown を使い、設定の複雑度を適切に分散させている
- `[SHOULD]` Watch モード（開発時）では重い検証プラグインをスキップし、プロダクションビルドでのみ全検証を実行する
  - 根拠: `this.meta.watchMode` による分岐が `rolldown.config.ts` 内の 6 箇所で使われ、開発ループの高速化とビルド品質の両立を実現している
- `[AVOID]` バンドル対象の依存を `require()` で読み込む（ESM バンドルに含まれなくなる）
  - 根拠: ESLint の `n/no-restricted-require` ルールで devDependencies の `require()` を禁止し、`await import()` を強制している（`eslint.config.js:203-214`）

## 適用チェックリスト

- [ ] `dependencies` と `devDependencies` の配置が「公開時に必要か、バンドルに含めるか」で正しく分類されているか確認する
- [ ] ビルド設定の `external` が `dependencies` / `peerDependencies` と一致しているか検証する
- [ ] 型を公開するパッケージで、消費者視点のモジュール解決（`node16` / `nodenext`）による型チェックステップがあるか確認する
- [ ] バンドルサイズの上限をビルド工程またはCIで監視しているか確認する
- [ ] Watch モードと本番ビルドで処理が適切に分岐しているか（開発時に不要な重い処理をスキップしているか）確認する
- [ ] モノレポ内の各パッケージに対し、複雑度に応じた適切なビルドツールが選択されているか見直す
- [ ] ESLint 等で `devDependencies` のインポート方式（ESM のみ等）が強制されているか確認する
