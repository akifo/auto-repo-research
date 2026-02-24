# Build and Tooling

> リポジトリ: trpc/trpc
> 分析日: 2026-02-24

## 概要

trpc/trpc は pnpm ワークスペース + Turborepo + tsdown + Vitest + Lerna という構成で、6 つのパッケージ（server, client, react-query, tanstack-react-query, next, upgrade）を管理するモノレポである。特に注目すべきは、tsdown の `onSuccess` フックでエントリポイント・`package.json` exports・barrel ファイルを自動生成する仕組みと、Vitest config で全パッケージの `package.json` exports をスキャンして動的にエイリアスを生成するテスト基盤である。ビルド成果物の正しさを保証するために、`monotest-*` という疑似モノレポで宣言ファイルを検証する CI ジョブも設けている。

## 背景にある原則

- **Single Source of Truth for Entrypoints**: エントリポイント定義は `tsdown.config.ts` の `input` 配列のみに記述し、`package.json` の `exports`・`files`・`main`・`types` はすべてビルド時に自動生成する。手動で 2 箇所を同期する必要がなくなり、不整合バグを構造的に排除している（`scripts/entrypoints.ts:37-150`）。

- **開発時はソースを直接参照し、テスト・公開時はビルド成果物を参照する**: `tsconfig.json` の `paths` で `@trpc/*` を `./packages/*/src` にマッピングし、IDE やタイプチェックは常にソースを見る。一方 Vitest は `package.json` の `exports` フィールドを動的にパースしてエイリアスを生成し、公開時と同じモジュール解決パスでテストを実行する（`vitest.config.ts:14-37`）。

- **ESLint ルールで公開 API 境界を強制する**: アダプタ（`packages/server/src/adapters/`）は `@trpc/server` や `unstable-core-do-not-import` を直接インポートすることを ESLint で禁止し、代わりに `src/@trpc/server/` という内部 facade ディレクトリを経由させている。これにより、サードパーティがアダプタを作る際に同じ公開 API だけで実装できることを保証している（`eslint.config.js:173-191`）。

- **ビルド成果物を消費者視点でテストする**: `monotest-*` パッケージ群はビルドされた `.d.ts` ファイルを `npm:@trpc/*` として参照し、実際の利用者と同じ条件で型チェックを行う。ソースレベルで型が通っていても宣言ファイル生成で壊れるケースを CI で検知できる（`.github/workflows/main.yml:296-306`）。

## 実例と分析

### tsdown による Dual Format ビルドとエントリポイント自動生成

各パッケージの `tsdown.config.ts` は共通パターンを持つ。`input` 配列にエントリポイントを列挙し、`format: ['cjs', 'esm']` でデュアルフォーマット出力、`outExtensions` で `.cjs`/`.mjs` と `.d.cts`/`.d.mts` を明示的に設定する。

ビルド完了後の `onSuccess` フックで `scripts/entrypoints.ts` の `generateEntrypoints()` を呼び出し、以下を自動生成する:

1. `package.json` の `exports` フィールド全体
2. `package.json` の `main`/`module`/`types` フィールド
3. `package.json` の `files` フィールド
4. サブパスエントリポイント用の barrel `package.json`（例: `adapters/express/package.json`）
5. `peerDependencies` に `typescript >= 5.7.2` を自動追加

```typescript
// packages/server/tsdown.config.ts:21-43
export default defineConfig({
  target: ['node18', 'es2017'],
  entry: input,
  dts: {
    sourcemap: true,
    tsconfig: './tsconfig.build.json',
  },
  format: ['cjs', 'esm'],
  outExtensions: (ctx) => ({
    dts: ctx.format === 'cjs' ? '.d.cts' : '.d.mts',
    js: ctx.format === 'cjs' ? '.cjs' : '.mjs',
  }),
  onSuccess: async () => {
    const start = Date.now();
    const { generateEntrypoints } = await import(
      '../../scripts/entrypoints.js'
    );
    await generateEntrypoints(input);
    console.log(`Generated entrypoints in ${Date.now() - start}ms`);
  },
});
```

### Vitest 動的エイリアス生成

`vitest.config.ts` はルートに1つだけ存在し、全パッケージの `package.json` をスキャンして `resolve.alias` を動的に構築する。各パッケージの `exports` キーを走査し、`@trpc/<pkg><export-path>` を `packages/<pkg>/src/<export-path>` にマッピングする。

```typescript
// vitest.config.ts:14-37
const dirs = readdirSync(packagesDir)
  .filter((it) => it !== 'tests' && !it.startsWith('.'))
  .filter((it) => existsSync(join(packagesDir, it, 'package.json')));

for (const pkg of dirs.sort()) {
  const pkgJson = join(packagesDir, pkg, 'package.json');
  const json = JSON.parse(readFileSync(pkgJson, 'utf-8').toString());
  const exports = json.exports;

  for (const key of Object.keys(exports).sort()) {
    if (key.includes('.json')) {
      continue;
    }
    const trimmed = key.slice(1);
    aliases[`@trpc/${pkg}${trimmed}`] = join(
      packagesDir, pkg, 'src', key.slice(1),
    ).replace(/\\/g, '/');
  }
}
```

これにより、テストコードは `import { initTRPC } from '@trpc/server'` のように公開パッケージ名で記述でき、かつソースファイルを直接参照するためビルドなしで動作する。`packages/tests/vitest.config.ts` はルート設定を再エクスポートするだけの1行で済む。

### Turborepo タスクグラフの設計

`turbo.json` のタスクグラフは以下の依存関係を持つ:

- `prebuild` はキャッシュ無効（Prisma マイグレーション等、副作用のある前処理を想定）
- `build` は `^build`（依存パッケージのビルド）と `prebuild` に依存
- `lint`/`typecheck`/`test-dev`/`test-start` は `^build` に依存（ビルド済み宣言ファイルが必要）
- `dev` はキャッシュ無効 + persistent

```json
// turbo.json:21-29
"build": {
  "dependsOn": ["^build", "prebuild"],
  "outputs": [".next/**", "!.next/cache/**", "dist/**", "build/**", "docs/typedoc/**"]
},
```

ルートの `pnpm build` は `turbo --filter=./packages/*` で packages のみをビルドし、examples はフィルタリングで除外される。CI の E2E テストだけが個別の example を `turbo --filter` でビルドする。

### ESLint によるモジュール境界の強制

複数のレイヤーで import 制約を設けている:

1. **パッケージ自己参照の禁止**: 各パッケージの `package.json` 内 `eslintConfig` で自パッケージ名からの import を禁止（例: `@trpc/client` パッケージ内で `from '@trpc/client'` は不可）
2. **`/src` サフィックスの禁止**: `@trpc/*/src` パターンを禁止し、パッケージの公開 API 経由のインポートを強制
3. **アダプタのコア直接参照禁止**: `packages/server/src/adapters/` 内では `@trpc/server` と `unstable-core-do-not-import` からの直接 import を禁止

```javascript
// eslint.config.js:173-191
{
  files: ['packages/server/src/adapters/**/*'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          { group: ['@trpc/server'] },
          {
            group: ['unstable-core-do-not-import'],
            message: 'Use e.g. `../@trpc/server/http` instead',
          },
        ],
      },
    ],
  },
},
```

### 内部 facade ディレクトリ `src/@trpc/server/`

`packages/server/src/@trpc/server/` はディレクトリ名にスコープ名を含む特殊な構造で、公開 API の facade として機能する。アダプタは相対パスで `../@trpc/server` から import し、内部実装の `unstable-core-do-not-import` には直接アクセスしない。これにより、サードパーティのアダプタ作者が同じ公開 API で実装できることをソースレベルで保証している。

```typescript
// packages/server/src/adapters/express.ts:1-2
// アダプタ作者向けのガイドコメント
/**
 * If you're making an adapter for tRPC and looking at this file for reference,
 * you should import types and functions from `@trpc/server` and `@trpc/server/http`
 */
```

### バージョン同期スクリプト

`scripts/version.ts` は `prepack` / `version` フックで実行され、全パッケージの `@trpc/*` 依存を現在のバージョンに自動ピン留めする。regex ベースの置換で、peerDependencies と devDependencies の両方を同期する。

```typescript
// scripts/version.ts:29-33
const newContent = content.replace(
  /\"@trpc\/((\w|-)+)\": "([^"]|\\")*"/g,
  `"@trpc/$1": "${version}"`,
);
```

### CI テスト環境の最適化

Vitest の設定では CI 環境に応じた最適化を行っている:
- `poolOptions.threads.useAtomics` を CI のみ有効化（ローカルでは不要なオーバーヘッドを避ける）
- `poolOptions.forks.execArgv` に `--expose-gc` を渡し、メモリリークテストで `global.gc()` を使用可能にする
- `retry` を CI で 2 回、ローカルで 0 回に設定（フレークテスト対策と開発速度のバランス）

## パターンカタログ

- **Facade パターン** (構造)
  - 解決する問題: 内部モジュール構造の複雑さを消費者から隠蔽する
  - 適用条件: パッケージ内部の実装詳細を公開 API から分離したい場合
  - コード例: `packages/server/src/@trpc/server/index.ts` が `unstable-core-do-not-import` を再エクスポート
  - 注意点: facade と内部モジュールの乖離を ESLint ルールで強制しないと形骸化する

## Good Patterns

- **エントリポイント定義の一元管理**: `tsdown.config.ts` の `input` 配列を唯一の真実の源とし、`package.json` の `exports`/`files`/`main`/`types` をビルド後フックで自動生成する。サブパスエントリポイントの追加時に `input` 配列に1行追加するだけで、package.json の5箇所以上のフィールドが自動更新される。

```typescript
// packages/client/tsdown.config.ts:3-11
export const input = [
  'src/index.ts',
  'src/links/httpBatchLink.ts',
  'src/links/httpLink.ts',
  // ...
];
// onSuccess で generateEntrypoints(input) を呼び出し
```

- **package.json exports からの動的テストエイリアス生成**: テストエイリアスをハードコードせず、公開 exports フィールドから自動生成することで、エントリポイント追加時にテスト設定の更新が不要になる。

```typescript
// vitest.config.ts:24-36
for (const key of Object.keys(exports).sort()) {
  if (key.includes('.json')) continue;
  const trimmed = key.slice(1);
  aliases[`@trpc/${pkg}${trimmed}`] = join(packagesDir, pkg, 'src', key.slice(1));
}
```

- **ビルド成果物の消費者テスト**: `monotest-*` パッケージが `npm:@trpc/*` で published 版と同じ解決パスを使い、宣言ファイルの健全性を CI で検証する。`diagnostics-big-router` は 100 個のルーターを codegen して大規模プロジェクトでの型パフォーマンスを計測する。

## Anti-Patterns / 注意点

- **手動で package.json exports を管理する**: モノレポで複数のサブパスエントリポイントを持つパッケージの `exports` を手動管理すると、CJS/ESM/型定義の 6 パス（import.types, import.default, require.types, require.default それぞれ）を更新し忘れるリスクが高い。

```json
// Bad: 手動で管理し同期漏れが発生
{
  "exports": {
    "./foo": {
      "import": { "types": "./dist/foo.d.mts", "default": "./dist/foo.mjs" }
      // require を書き忘れ
    }
  }
}
```

```typescript
// Better: input 配列から自動生成
export const input = ['src/index.ts', 'src/foo.ts'];
// onSuccess で generateEntrypoints(input) を実行
```

- **テストエイリアスと tsconfig paths の二重管理**: tsconfig の `paths` とテストランナーの `resolve.alias` を別々に手動管理すると不整合が起きやすい。trpc では Vitest 側は package.json exports から動的生成し、tsconfig 側のみ手動管理（パッケージ単位で固定的）とすることで管理コストを最小化している。

## 導出ルール

- `[MUST]` モノレポでサブパスエントリポイントを持つパッケージは、エントリポイント定義を単一の場所に集約し、package.json の exports/files/main/types をビルドスクリプトから自動生成する
  - 根拠: trpc では `tsdown.config.ts` の `input` 配列のみがエントリポイントの真実の源であり、`scripts/entrypoints.ts` が package.json の 5 つ以上のフィールドを自動生成している。手動同期では CJS/ESM/型定義の組み合わせ爆発で不整合が不可避になる

- `[SHOULD]` テストランナーのモジュールエイリアスは package.json の exports フィールドから動的に生成し、エントリポイント追加時のテスト設定更新を不要にする
  - 根拠: `vitest.config.ts` が全パッケージの package.json をスキャンしてエイリアスを自動構築しており、新規エントリポイント追加時にテスト設定の変更が不要

- `[SHOULD]` パッケージ内部のモジュール境界は ESLint の `no-restricted-imports` で強制し、公開 API facade 経由のアクセスのみを許可する
  - 根拠: `eslint.config.js` のアダプタ向けルールが `@trpc/server` と `unstable-core-do-not-import` の直接参照を禁止し、サードパーティが同じ公開 API でアダプタを実装できることを保証している

- `[SHOULD]` モノレポのビルド成果物は、消費者視点のテストプロジェクトで宣言ファイルの健全性を CI で検証する
  - 根拠: `monotest-*` パッケージが `npm:@trpc/*` としてビルド済みパッケージを参照し、ソースレベルでは型が通るがビルド成果物では壊れるケースを検出している

- `[SHOULD]` Vitest の CI 最適化では `useAtomics` を CI のみ有効化し、メモリテスト用に forks の `execArgv` で `--expose-gc` を渡す。ローカル実行では不要なオーバーヘッドを避ける
  - 根拠: `vitest.config.ts:63-68` で CI 環境変数に基づいて設定を分岐している

- `[AVOID]` モノレポ内のパッケージが自分自身のパッケージ名でインポートすること（循環依存の原因になる）
  - 根拠: `@trpc/client`、`@trpc/next` 等の各 `package.json` で `no-restricted-imports` に自パッケージ名を設定し、自己参照を禁止している

## 適用チェックリスト

- [ ] モノレポのエントリポイント定義が単一の場所に集約されているか確認する（tsdown/tsup/rollup の config 等）
- [ ] package.json の `exports`/`files`/`main`/`types` がビルドスクリプトから自動生成されているか確認する
- [ ] テストランナーのモジュールエイリアスが package.json の exports と同期しているか確認する（手動管理なら動的生成への移行を検討）
- [ ] ESLint の `no-restricted-imports` でパッケージ間の import 境界を強制しているか確認する
- [ ] ビルド成果物の宣言ファイル（.d.ts/.d.cts/.d.mts）を消費者視点でテストする CI ジョブがあるか確認する
- [ ] CI 環境固有の Vitest 最適化（useAtomics、retry、expose-gc）をローカルと分離しているか確認する
- [ ] モノレポ内の内部パッケージ間バージョンを自動同期するスクリプトがあるか確認する
