# Build and Tooling

> リポジトリ: shadcn-ui/ui
> 分析日: 2026-03-04

## 概要

shadcn/ui のビルドパイプラインは、Turborepo によるモノレポ管理、tsup による CLI パッケージビルド、そして独自の「registry:build」コード生成フローの 3 層で構成される。特に注目すべきは、CSS の `cn-*` プレフィックス付きセマンティッククラスをスタイルバリアント（vega, nova, maia 等）ごとの Tailwind クラスに変換する AST ベースのコード生成パイプラインである。コンポーネントソースを「ベース × スタイル」のマトリクスで組み合わせて生成する仕組みは、UI ライブラリのマルチスタイル配信における実践的なアーキテクチャを示している。

## 背景にある原則

- **コンポーネントソースと視覚スタイルの直交分離**: コンポーネントのロジック（ベース: radix, base）とスタイル（vega, nova, maia 等）を独立した軸として管理し、組み合わせをビルド時に生成する。これにより N×M の手動メンテナンスを回避する。根拠: `buildBases()` が `BASES × STYLES` の直積で全バリアントを並列生成している（`apps/v4/scripts/build-registry.mts:246-320`）
- **Zod スキーマによるビルドパイプラインのバリデーションゲート**: コード生成の各ステップで `registrySchema.safeParse()` を呼び、不正なデータが後続工程に流れることを防ぐ。ビルドスクリプトとランタイム（CLI）の両方で同一スキーマを共有する。根拠: `build-registry.mts:138-142`、`packages/shadcn/src/commands/build.ts:43-52`
- **AST 変換による確実なコード書き換え**: 正規表現ではなく `ts-morph` を使った AST レベルの変換で、`cn-*` クラスの置換、アイコンの変換、RTL 対応を行う。文字列操作では壊れやすい JSX/TSX の構造的変換を安全に実行する。根拠: `packages/shadcn/src/styles/transform-style-map.ts` が `cva()` 呼び出し・`className` 属性・`mergeProps` 呼び出しの3パターンを個別にハンドルしている
- **ビルド成果物の自動フォーマット統合**: コード生成後に Prettier を一括適用し、生成コードと手書きコードのスタイル差異を排除する。レビュー差分のノイズを減らし、生成コードの可読性を担保する。根拠: `build-registry.mts:100-104` でバッチ処理、`package.json:17` で `registry:build` 後に `lint:fix && format:write` を連鎖実行

## 実例と分析

### Turborepo によるモノレポパイプライン管理

ルート `turbo.json` で `build`、`lint`、`test`、`dev`、`registry:build` 等のタスクを定義している。`build` タスクは `dependsOn: ["^build"]` で依存パッケージの先行ビルドを保証する。

特徴的なのは `registry:build` と `lint` を `cache: false` にしている点。registry:build はファイル生成を伴うため、キャッシュヒットによるスキップが危険。一方 `build` タスクは `outputs: ["dist/**", ".next/**"]` を指定してキャッシュ可能にしている。

ルートの `package.json` では `pnpm --filter=v4` で特定ワークスペースに絞った実行と、`turbo run` によるパイプライン実行を使い分けている。

```typescript
// turbo.json:54-58
"registry:build": {
  "cache": false,
  "outputs": []
}
```

```jsonc
// package.json:17
"registry:build": "pnpm --filter=v4 registry:build && pnpm lint:fix && pnpm format:write -- --loglevel silent"
```

### tsup による CLI パッケージビルド

`packages/shadcn/tsup.config.ts` は複数のエントリポイントをサブパスエクスポートに対応させている。`package.json` の `exports` フィールドと 1:1 で対応し、ユーザーが `import { registrySchema } from "shadcn/schema"` のように使える。

```typescript
// packages/shadcn/tsup.config.ts:4-24
export default defineConfig({
  clean: true,
  dts: true,
  entry: [
    "src/index.ts",
    "src/registry/index.ts",
    "src/schema/index.ts",
    "src/mcp/index.ts",
    "src/utils/index.ts",
    "src/icons/index.ts",
  ],
  format: ["esm"],
  sourcemap: true,
  minify: true,
  target: "esnext",
  outDir: "dist",
  treeshake: true,
  onSuccess: async () => {
    copyFileSync("src/tailwind.css", "dist/tailwind.css")
  },
})
```

`onSuccess` コールバックで CSS ファイルをコピーするパターンは、tsup のビルドパイプラインに非 TS アセットの処理を統合する方法として参考になる。

### registry:build のコード生成フロー

`apps/v4/scripts/build-registry.mts` が全体のオーケストレーションを担う。フローは以下の通り:

1. **ベースインデックス生成** (`buildBasesIndex`): 各ベースの `registry.ts` を動的 import し、スキーマバリデーション後に `__index__.tsx` を生成
2. **ベース × スタイル生成** (`buildBases`): CSS スタイルマップを作成し、全組み合わせを並列でファイル生成
3. **中間成果物フォーマット**: 生成されたベースファイルを Prettier で整形（JSON 出力に正規化済みコードを含めるため）
4. **レジストリ JSON 生成** (`buildRegistryJsonFile` + `buildRegistry`): スタイルごとの JSON を生成し、CLI `build` コマンドで個別アイテム JSON を生成
5. **RTL バリアント生成** (`buildRtlExamples`): `transformDirection` で LTR→RTL 変換
6. **クリーンアップ** (`cleanUp`): ホワイトリスト外の中間ディレクトリを削除

```typescript
// apps/v4/scripts/build-registry.mts:74-81
// Build all styles in parallel.
await Promise.all(
  stylesToBuild.map(async (style) => {
    await buildRegistryJsonFile(style.name)
    await buildRegistry(style.name)
    console.log(`   ✅ ${style.name}`)
  })
)
```

### cn-* セマンティッククラスによるスタイル抽象化

コンポーネントソースは `cn-button-variant-default` のようなセマンティッククラスを使用し、スタイル定義 CSS（`style-nova.css` 等）が `@apply` で実際の Tailwind クラスにマッピングする。`createStyleMap()` が PostCSS で CSS を解析し、`cn-*` クラス→Tailwind クラスのマップを構築する。

```tsx
// apps/v4/registry/bases/radix/ui/button.tsx:7-35
const buttonVariants = cva(
  "cn-button group/button inline-flex shrink-0 ...",
  {
    variants: {
      variant: {
        default: "cn-button-variant-default",
        outline: "cn-button-variant-outline",
        // ...
      },
    },
  }
)
```

```css
/* apps/v4/registry/styles/style-nova.css (例) */
.style-nova {
  .cn-button-variant-default {
    @apply bg-primary text-primary-foreground shadow-xs ...;
  }
}
```

`transformStyleMap` がビルド時に `cn-*` クラスを実際の Tailwind クラスに置換し、最終出力には `cn-*` クラスが残らない。

### Transformer パイプラインの構成

`packages/shadcn/src/utils/transformers/index.ts` で定義される変換パイプラインは、デフォルトで 7 つのトランスフォーマーを順次適用する:

```typescript
// packages/shadcn/src/utils/transformers/index.ts:42-52
export async function transform(
  opts: TransformOpts,
  transformers: Transformer[] = [
    transformImport,
    transformRsc,
    transformCssVars,
    transformTwPrefixes,
    transformRtl,
    transformIcons,
    transformCleanup,
  ]
)
```

各トランスフォーマーは `(opts & { sourceFile }) => Promise<SourceFile>` のシグネチャを持ち、同一の `SourceFile` を順次変異させる。この設計により、新しい変換を追加する際はトランスフォーマーを 1 つ追加するだけでよい。

### CLI が自分自身を利用するセルフホスティングパターン

`buildRegistry()` 関数内で、ビルド済みの CLI（`../../packages/shadcn/dist/index.js`）を `spawn` で実行し、レジストリ JSON からアイテム JSON を生成している。CLI の `build` コマンドを内部ツールとしても活用するセルフホスティングの好例。

```typescript
// apps/v4/scripts/build-registry.mts:453-478
async function buildRegistry(styleName: string) {
  const outputPath = `public/r/styles/${styleName}`
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      "node",
      [
        "../../packages/shadcn/dist/index.js",
        "build",
        `registry-${styleName}.json`,
        "--output",
        outputPath,
      ],
      { cwd: process.cwd(), stdio: "pipe" }
    )
    // ...
  })
}
```

## パターンカタログ

- **Builder パターン** (生成)
  - 解決する問題: コンポーネントの「ベース」「スタイル」「方向（LTR/RTL）」「アイコンライブラリ」の組み合わせが多い
  - 適用条件: N 個の独立した軸の直積で成果物を生成する場合
  - コード例: `apps/v4/scripts/build-registry.mts:246-320` — BASES × STYLES の全組み合わせを並列生成
  - 注意点: 組み合わせ爆発に注意。ホワイトリストで本番配信対象を絞っている（`WHITELISTED_STYLES`）

- **Pipeline / Chain of Responsibility パターン** (振る舞い)
  - 解決する問題: コードに対する複数の変換を順序付きで適用する
  - 適用条件: 各変換が独立していて、順序に意味がある場合
  - コード例: `packages/shadcn/src/utils/transformers/index.ts:42-52` — 7 つのトランスフォーマーを順次適用
  - 注意点: 同一 SourceFile を変異させるため、トランスフォーマー間の副作用に注意

## Good Patterns

- **Zod スキーマを生産者・消費者の両側で共有する**: `registrySchema` を `packages/shadcn/src/registry/schema.ts` で定義し、ビルドスクリプト（`build-registry.mts`）と CLI コマンド（`commands/build.ts`、`commands/registry/build.ts`）の両方で `safeParse` する。スキーマの重複定義がなく、型安全なデータ受け渡しが保証される。

```typescript
// apps/v4/scripts/build-registry.mts:138-142
const parseResult = registrySchema.safeParse(importedRegistry)
if (!parseResult.success) {
  console.error(`❌ Registry validation failed for ${base.name}:`)
  throw new Error(`Invalid registry schema for ${base.name}`)
}
```

- **並列処理と逐次処理の意図的な使い分け**: `Promise.all` で独立したスタイルビルドを並列化する一方、フォーマット→JSON生成→クリーンアップは依存関係があるため逐次実行。`performance.now()` でビルド全体の時間を計測している。

```typescript
// apps/v4/scripts/build-registry.mts:47-111
const totalStart = performance.now()
// ... 逐次: buildBasesIndex → buildBases → batchPrettier
// ... 並列: stylesToBuild.map(style => buildRegistryJsonFile + buildRegistry)
const elapsed = ((performance.now() - totalStart) / 1000).toFixed(2)
```

- **自動生成ファイルに `@ts-nocheck` + 「Do not edit」コメントを付与**: 生成された `__index__.tsx` には型チェック無効化と編集禁止の注意書きが含まれる。手書きコードと自動生成コードの境界を明確にする。

```typescript
// apps/v4/scripts/build-registry.mts:128-131
let index = `// @ts-nocheck
// This file is autogenerated by scripts/build-registry.ts
// Do not edit this file directly.
import "server-only"
```

## Anti-Patterns / 注意点

- **ビルドスクリプト内での `bun run` と `tsx` の混在**: `registry:build` は `bun run` で実行されるが、`icons:dev` や `registry:capture` は `tsx` を使用している。ランタイムの違いにより、片方では動作するが他方ではエラーになるリスクがある。

```jsonc
// Bad: 同一プロジェクトで異なるスクリプトランナーを混在
"registry:build": "bun run ./scripts/build-registry.mts",
"icons:dev": "tsx --tsconfig ./tsconfig.scripts.json ./scripts/build-icons.ts --watch",
"registry:capture": "tsx --tsconfig ./tsconfig.scripts.json ./scripts/capture-registry.mts",
```

```jsonc
// Better: スクリプトランナーを統一するか、使い分けの理由をドキュメント化
"registry:build": "tsx --tsconfig ./tsconfig.scripts.json ./scripts/build-registry.mts",
"icons:dev": "tsx --tsconfig ./tsconfig.scripts.json ./scripts/build-icons.ts --watch",
```

- **ビルドスクリプト内でのフォーマッター直接呼び出し**: `build-registry.mts` 内で `batchPrettier()` を直接 `spawn` しており、Prettier のバージョンや設定がビルドスクリプトに暗黙的に結合している。

```typescript
// Bad: ビルドスクリプト内で prettier を直接 spawn
async function batchPrettier(paths: string[]) {
  const prettierBin = path.join(process.cwd(), "node_modules/.bin/prettier")
  const proc = spawn(prettierBin, ["--write", ...paths], { ... })
}
```

```typescript
// Better: npm script 経由で呼び出し、設定を一元管理
// package.json: "format:generated": "prettier --write"
// ビルドスクリプトでは生成パスリストを出力し、後工程で一括フォーマット
```

## 導出ルール

- `[MUST]` コード生成パイプラインでは、生成データを次工程に渡す前にスキーマバリデーション（`safeParse`）を挟む
  - 根拠: shadcn/ui は `registrySchema.safeParse()` を `buildBasesIndex`、`buildBases`、`buildRegistryJsonFile` の全段階で実行し、不正データの伝播を防いでいる（`build-registry.mts:138-142`）
- `[MUST]` 自動生成ファイルには「生成元スクリプト名」「編集禁止」の注釈を先頭に付与する
  - 根拠: `__index__.tsx` に `// This file is autogenerated by scripts/build-registry.ts` と `// Do not edit this file directly.` を付与し、手書き/生成の境界を明確化している
- `[SHOULD]` コンポーネントのロジックと視覚スタイルを直交する軸として分離し、ビルド時に合成する
  - 根拠: shadcn/ui は `cn-*` セマンティッククラスでロジック（ベース）とスタイル（CSS バリアント）を分離し、AST 変換で合成することで N×M のメンテナンスコストを回避している
- `[SHOULD]` tsup の `entry` 配列と `package.json` の `exports` フィールドを 1:1 で対応させ、サブパスエクスポートを明示的に管理する
  - 根拠: `packages/shadcn/tsup.config.ts` の 6 エントリが `package.json` の 6 exports と正確に対応し、パッケージの公開 API を明確に制御している
- `[SHOULD]` AST ベースのコード変換では、変換対象パターン（`cva()` 呼び出し、JSX `className` 属性等）を個別のハンドラとして分離する
  - 根拠: `transformStyleMap` が `applyToCvaCalls`、`applyToClassNameAttributes`、`applyToMergePropsCalls` を個別関数で実装し、パターンの追加・修正を局所化している（`transform-style-map.ts`）
- `[AVOID]` 同一プロジェクトのビルドスクリプトで複数のスクリプトランナー（`bun`、`tsx`、`node`）を理由なく混在させる
  - 根拠: `apps/v4/package.json` で `bun run`（registry:build）と `tsx`（icons:dev, registry:capture）が混在しており、環境依存のデバッグコストが発生しうる

## 適用チェックリスト

- [ ] モノレポでコード生成タスクを持つ場合、Turborepo の `cache: false` を設定しているか
- [ ] 生成データのパイプラインで、各ステップ間にスキーマバリデーションを挟んでいるか
- [ ] 自動生成ファイルに「生成元」「編集禁止」のコメントヘッダーを付与しているか
- [ ] tsup/Rollup 等でビルドする npm パッケージのエントリポイントと `exports` フィールドが 1:1 対応しているか
- [ ] コード変換にテキスト置換（正規表現）を使っている箇所を AST 変換に置き換えられないか検討したか
- [ ] ビルドスクリプト内でフォーマッターや linter を直接呼び出す代わりに、npm script 経由で一元管理できないか確認したか
- [ ] 組み合わせ爆発が発生する生成物に対して、ホワイトリスト/フィルタで配信対象を制限しているか
