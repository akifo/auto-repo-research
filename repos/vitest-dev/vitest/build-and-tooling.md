# Build and Tooling

> リポジトリ: vitest-dev/vitest
> 分析日: 2026-03-06

## 概要

vitest は 17 パッケージからなるモノレポで、Rollup ベースのビルドパイプラインを全パッケージで統一している。特筆すべきは、OXC ベースの isolated declarations による高速 DTS 生成と rollup-plugin-dts の 2 段階型生成戦略、pnpm catalog による依存バージョン一元管理、そして patchedDependencies による上流ライブラリの戦略的修正である。ビルド構成の共通化を `scripts/build-utils.js` というシンプルなファクトリに集約し、各パッケージの rollup.config.js では差分のみを記述するアプローチが一貫して適用されている。

## 背景にある原則

- **ビルド構成の共通化と差分記述**: 全 17 パッケージが同じ Rollup + OXC + rollup-plugin-dts パイプラインを使い、共通部分を `scripts/build-utils.js` に抽出している。各パッケージの rollup.config.js は entry point と external の定義だけが異なる。モノレポでビルド設定が散逸すると保守コストが指数的に増えるため、共通化層を薄く保ちつつ差分のみをローカルに記述すべき。

- **型生成とランタイムビルドの分離**: ランタイム JS は OXC（unplugin-oxc）でトランスパイルし、型定義は isolated declarations で中間 `.d.ts` を高速生成した後、rollup-plugin-dts で束ねる。型チェックとビルドを分離することで、ビルド速度を犠牲にせずに型安全性を維持できる。`tsconfig.check.json` が型チェック専用であり、ビルド時には型チェックを行わない設計。

- **依存バージョンの一元管理で整合性を保証する**: pnpm catalog で共有依存のバージョンを一箇所に集約し、overrides で内部パッケージやクリティカルな依存のバージョンを固定する。モノレポにおいて依存バージョンの不整合はビルド破損やランタイムエラーの主要因であるため、宣言的に一元管理すべき。

- **上流の不足はパッチで埋める**: `patchedDependencies` で 5 つの依存にパッチを当てている。fork を作るのではなく、パッチファイルとして管理することで、上流の更新に追従しやすく、変更内容が差分として可視化される。

## 実例と分析

### 2 段階 DTS 生成パイプライン

vitest のビルドで最も特徴的なのは DTS（型定義ファイル）の生成戦略である。従来の `rollup-plugin-dts` 単体では TypeScript コンパイラを通すため遅い。vitest は `unplugin-isolated-decl`（OXC ベース）で中間 `.d.ts` を高速に生成し、それを `rollup-plugin-dts` に渡して最終的な `.d.ts` バンドルを作る。

この 2 段階アプローチは `scripts/build-utils.js` の `createDtsUtils()` に集約されている:

1. **isolatedDecl()** — ビルド時に OXC で `.types/` ディレクトリに中間 `.d.ts` を出力
2. **dtsInput()** — 中間 `.d.ts` を rollup-plugin-dts の入力としてマッピング
3. **dts()** — rollup-plugin-dts で最終 `.d.ts` を生成し、中間ファイルをクリーンアップ

watch モード時は中間ファイルを削除しない配慮もある（再ビルドが不安定になるため）。

### 外部依存の自動推定

全パッケージの rollup.config.js で、`package.json` の `dependencies` と `peerDependencies` から external リストを自動生成している。これにより、依存を追加・削除した際にビルド設定の手動修正が不要になる。

### パッケージごとのビルドカスタマイズ

共通パイプラインを使いつつ、パッケージの特性に応じた差分が存在する:

- **vitest（メインパッケージ）**: CJS 互換出力（`config.cjs`）、ライセンス集約プラグイン、ワーカー別エントリ分割
- **browser パッケージ**: クライアント向けターゲット（`node18`）、IIFE 出力（`state.js`）、複数の dtsUtils インスタンス
- **pretty-format**: `process.env.NODE_ENV` のインライン置換（React 互換のため）
- **spy/expect**: 最小構成（OXC + isolatedDecl のみ、node-resolve 不要）

### pnpm catalog と overrides の使い分け

`pnpm-workspace.yaml` で `catalogMode: prefer` を設定し、各パッケージは `"catalog:"` で共通バージョンを参照する。37 箇所以上で catalog 参照が使われている。一方、`overrides` は内部パッケージ（`workspace:*`）や特定バージョンの固定（`acorn: 8.11.3`、`vite`、`rollup`）に使用される。

### patchedDependencies の戦略的活用

5 つのパッチが管理されており、それぞれ明確な目的を持つ:

- **cac**: CLI オプションパーサーの型修正とドットパス・オプション処理の改善
- **acorn**: `sideEffects: false` の追加（tree-shaking 最適化）
- **@sinonjs/fake-timers**: `require` を `__vitest_required__` に差し替え（VM サンドボックス対応）
- **istanbul-lib-source-maps**: ソースマップの行マッピング改善（upstream PR #837 のバックポート）
- **istanbul-lib-instrument**: `@jridgewell/trace-mapping` 依存追加と ignore-lines パース改善

### tsconfig の 3 分割戦略

- **tsconfig.base.json**: 共通設定（paths マッピング、strict モード、`stripInternal`）
- **tsconfig.build.json**: ビルド用（dist の型定義を参照する paths に差し替え）
- **tsconfig.check.json**: 型チェック用（`exclude` で不要ファイルを除外、`types` で Node/Vite 型を指定）

### ESLint による import 制御

`eslint.config.js` で `no-restricted-imports` を使い、packages 内部からの `vitest` / `path` のインポートを禁止している。`path` の代わりに `pathe` を使い、クロスプラットフォーム互換性を確保する。

## コード例

```js
// scripts/build-utils.js:7-66
export function createDtsUtils({
  isolatedDeclDir = '.types',
  cleanupDir = '.types',
} = {}) {
  return {
    isolatedDecl() {
      return [
        isolatedDecl({
          transformer: 'oxc',
          transformOptions: { stripInternal: true },
          include: path.join(process.cwd(), '**/*.ts'),
          extraOutdir: isolatedDeclDir,
        }),
        // ...
      ]
    },
    dts() {
      return [
        dts({ respectExternal: true }),
        {
          name: 'isolated-decl-dts-extra',
          buildEnd(error) {
            if (!error && !this.meta.watchMode) {
              fs.rmSync(`dist/${cleanupDir}`, { recursive: true, force: true })
            }
          },
        },
      ]
    },
    dtsInput(input, { ext = 'ts' } = {}) {
      // ...中間 .d.ts をエントリとしてマッピング
    },
  }
}
```

```js
// packages/utils/rollup.config.js:28-32
// external リストを package.json から自動生成
const external = [
  ...builtinModules,
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.peerDependencies || {}),
]
```

```js
// packages/vitest/rollup.config.js:36-45
// パフォーマンスのためにワーカーを個別エントリに分割
const entries = {
  // ...
  // for performance reasons we bundle them separately so we don't import everything at once
  'workers/forks': 'src/runtime/workers/forks.ts',
  'workers/threads': 'src/runtime/workers/threads.ts',
  'workers/vmThreads': 'src/runtime/workers/vmThreads.ts',
  'workers/vmForks': 'src/runtime/workers/vmForks.ts',
}
```

```yaml
# pnpm-workspace.yaml:1-2,48-93 (抜粋)
catalogMode: prefer
catalog:
  tinyrainbow: ^3.0.3
  tinyspy: ^4.0.4
  typescript: ^5.9.3
  # ... 40+ entries
```

```js
// packages/pretty-format/rollup.config.js:31-37
// process.env.NODE_ENV のビルド時インライン置換
{
  name: 'process-env',
  transform(code) {
    if (code.includes('process.env.NODE_ENV')) {
      return code.replace(/process\.env\.NODE_ENV/g, '"production"')
    }
  },
},
```

## パターンカタログ

- **Factory Method** (分類: 生成)
  - 解決する問題: 複数パッケージで異なるビルド構成が必要だが、DTS 生成ロジックは共通
  - 適用条件: モノレポで共通ビルドパイプラインを持つが、パッケージごとにカスタマイズが必要な場合
  - コード例: `scripts/build-utils.js:7` の `createDtsUtils()` — オプション（`isolatedDeclDir`, `cleanupDir`）でカスタマイズ可能なプラグインセットを生成する
  - 注意点: ファクトリの抽象度が高すぎるとカスタマイズが困難になる。vitest は意図的にオプションを 2 つに絞っている

- **Facade** (分類: 構造)
  - 解決する問題: `src/public/` ディレクトリでパッケージの公開 API を集約し、内部実装と外部インターフェースを分離する
  - 適用条件: パッケージが複数のエントリポイントを持ち、内部モジュール構造を隠蔽したい場合
  - コード例: `packages/vitest/src/public/index.ts` — 内部モジュールから re-export するだけのファイル群
  - 注意点: `@internal` タグと `stripInternal` で型定義からも内部 API を除外している

## Good Patterns

- **package.json 駆動の external リスト**: `Object.keys(pkg.dependencies)` で external を自動生成することで、依存追加時のビルド設定漏れを防ぐ。手動リストと異なり、package.json が single source of truth になる。

```js
// packages/runner/rollup.config.js:10-15
const external = [
  ...builtinModules,
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.peerDependencies || {}),
  /^@?vitest(\/|$)/,  // 内部パッケージのサブパス一括マッチ
]
```

- **watch: false で DTS バンドルをスキップ**: DTS バンドルは重い処理のため、開発時の watch ビルドでは実行しない。型チェックは別途 `tsc --noEmit` で行う。

```js
// packages/utils/rollup.config.js:69-80
{
  input: dtsUtils.dtsInput(entries),
  output: { dir: 'dist', entryFileNames: '[name].d.ts', format: 'esm' },
  watch: false,  // dev 時は DTS 生成をスキップ
  external,
  plugins: dtsUtils.dts(),
},
```

- **onwarn による安全なサイレンス**: 全パッケージで `EMPTY_BUNDLE` と `CIRCULAR_DEPENDENCY` を明示的に無視し、それ以外は `console.error` に流す。想定内の警告だけを抑制し、予期しない警告は見逃さない。

```js
// packages/spy/rollup.config.js:49-53
function onwarn(message) {
  if (['EMPTY_BUNDLE', 'CIRCULAR_DEPENDENCY'].includes(message.code)) {
    return
  }
  console.error(message)
}
```

- **エントリ分割による初期化コスト削減**: vitest メインパッケージのワーカーを個別エントリに分割し、必要なワーカータイプのみをロードする設計。コメントで意図が明記されている。

## Anti-Patterns / 注意点

- **過度なビルド設定の DRY 化**: ビルドユーティリティを高度に抽象化しすぎると、特殊ケース（browser パッケージの複数 dtsUtils インスタンスなど）で抽象化が漏れる。vitest の `createDtsUtils` は意図的にオプションを最小限（2 つ）に保っているが、browser パッケージでは独自の `dtsUtilsClient` を別途作成している。

```js
// Bad: 全ケースを1つの抽象に押し込む
createDtsUtils({ mode: 'node', target: 'node20', client: true, ... })

// Better: 共通部分だけ抽出し、特殊ケースはローカルで対応
const dtsUtils = createDtsUtils()
const dtsUtilsClient = createDtsUtils({
  isolatedDeclDir: '.types-client/tester',
  cleanupDir: '.types-client',
})
```

- **パッチの放置**: `patchedDependencies` は便利だが、上流で修正された後にパッチを外し忘れると不要な差分が残る。vitest の istanbul パッチにはコメントで PR 番号（`#837`）が記載されており追跡可能だが、全パッチが同じ水準ではない。

```diff
// Good: パッチ内に上流 PR への参照を記載
+// Contains patch from https://github.com/istanbuljs/istanbuljs/pull/837

// Bad: パッチの理由や上流 issue/PR への参照がない
```

## 導出ルール

- `[MUST]` モノレポのビルド設定では、共通ロジックを薄いユーティリティに抽出し、各パッケージは差分（エントリポイント、external、特殊プラグイン）のみを定義する
  - 根拠: vitest の 17 パッケージ全てが `scripts/build-utils.js` の `createDtsUtils()` を共有し、rollup.config.js の構造が統一されている（`scripts/build-utils.js:7`）

- `[MUST]` Rollup の external リストは `package.json` の `dependencies`/`peerDependencies` から自動生成し、手動管理を避ける
  - 根拠: 全パッケージで `Object.keys(pkg.dependencies || {})` パターンが使われており、依存追加時のバンドル漏れを構造的に防いでいる

- `[SHOULD]` 型定義生成とランタイムビルドを分離し、開発時（watch モード）では型バンドルをスキップして高速化する
  - 根拠: vitest は DTS バンドル設定に `watch: false` を指定し、型チェックは `tsc -p tsconfig.check.json --noEmit` で別途実行する

- `[SHOULD]` pnpm catalog で共有依存のバージョンを一箇所に宣言し、`catalogMode: prefer` で全パッケージに適用する
  - 根拠: 37 箇所以上で `"catalog:"` 参照が使われ、バージョンの不整合を構造的に排除している（`pnpm-workspace.yaml:1,48-93`）

- `[SHOULD]` `patchedDependencies` を使う際はパッチファイル内に上流 issue/PR への参照コメントを必ず記載する
  - 根拠: `istanbul-lib-source-maps.patch` は `#837` への参照があり追跡可能だが、他のパッチには参照がないものもある

- `[SHOULD]` `@internal` JSDoc タグと `stripInternal` を組み合わせて、公開型定義から内部 API を自動除外する
  - 根拠: `tsconfig.base.json` の `stripInternal: true` と `build-utils.js` の `transformOptions: { stripInternal: true }` の両方で設定されている

- `[AVOID]` Rollup の警告を全て無差別に抑制する。想定内の警告コード（`EMPTY_BUNDLE`, `CIRCULAR_DEPENDENCY`）のみを明示的にフィルタし、それ以外は `console.error` に流す
  - 根拠: 全パッケージの `onwarn` 関数が同じホワイトリスト方式を採用している

- `[AVOID]` `tsconfig.json` を 1 ファイルで全用途に兼用する。ビルド用・型チェック用・エディタ用で参照パスや除外ルールが異なるため、用途別に分割する
  - 根拠: vitest は `tsconfig.base.json`（共通）、`tsconfig.build.json`（ビルド用 dist パス）、`tsconfig.check.json`（型チェック用 exclude）の 3 分割を採用している

## 適用チェックリスト

- [ ] モノレポのビルド設定に共通ユーティリティを導入し、各パッケージの rollup/vite config は差分のみを記述しているか
- [ ] Rollup の external リストを `package.json` の dependencies から自動生成しているか
- [ ] DTS 生成をランタイムビルドから分離し、watch モードではスキップしているか
- [ ] tsconfig を用途別（エディタ/ビルド/型チェック）に分割しているか
- [ ] pnpm catalog（または同等の仕組み）で共有依存のバージョンを一元管理しているか
- [ ] patchedDependencies のパッチファイルに上流 issue/PR への参照を記載しているか
- [ ] `onlyBuiltDependencies` でインストール時のビルドをホワイトリスト制御しているか
- [ ] `@internal` + `stripInternal` で公開型から内部 API を除外しているか
- [ ] ESLint の `no-restricted-imports` でパッケージ間の不正な import パスを検出しているか
