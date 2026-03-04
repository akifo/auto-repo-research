# Code Transformation Pipeline

> リポジトリ: shadcn-ui/ui
> 分析日: 2026-03-04

## 概要

shadcn/ui の CLI はレジストリからダウンロードしたコンポーネントソースを、ユーザーのプロジェクト設定に合わせて AST レベルで書き換えるコード変換パイプラインを備えている。ts-morph（TypeScript AST）、recast + Babel（JSX 除去）、PostCSS（CSS マッピング）を使い分けながら、14 種以上の独立したトランスフォーマーを順次合成する設計は、コード配布プラットフォームならではの実践的知見に満ちている。特に注目すべきは、各トランスフォーマーが統一インターフェースに従い、設定値による早期リターンで自己完結している点と、同じ変換ロジックを CLI とビルドスクリプトの両方で再利用するための抽出パターンである。

## 背景にある原則

- **変換の直交分解**: 各トランスフォーマーは 1 つの関心事（インポートパス、RSC ディレクティブ、アイコン、CSS 変数、RTL、Tailwind プレフィックス等）だけを扱う。`transform-import.ts` はパス書き換えのみ、`transform-rsc.ts` は `"use client"` の除去のみ。こうすることで任意の組み合わせで合成でき、呼び出し元によって異なるトランスフォーマーセットを渡せる。
- **設定駆動の早期リターン**: すべてのトランスフォーマーが冒頭で `config` を検査し、自分の処理が不要なら即座に `sourceFile` をそのまま返す。これにより呼び出し側で条件分岐する必要がなく、パイプラインの組み立てがシンプルになる（例: `transform-rsc.ts:7-9` の `if (config.rsc) { return sourceFile }`）。
- **AST ツールの使い分け**: ts-morph は TypeScript/JSX の構造操作に、recast + Babel は TypeScript 除去（TSX→JSX 変換）に、PostCSS は CSS のセレクタ解析とクラス抽出にそれぞれ最適化して使われている。1 つのツールですべてを賄わず、各 AST ツールの得意領域に応じて選択している。
- **コアロジックの文脈非依存な抽出**: `transformDirection`（RTL）や `cleanupMarkers`（マーカー除去）のように、CLI トランスフォーマーから純粋関数を切り出して `export` し、ビルドスクリプトやマイグレーションツールからも呼び出せるようにしている。

## 実例と分析

### パイプライン・オーケストレーション

`transform()` 関数（`packages/shadcn/src/utils/transformers/index.ts:42-71`）がパイプラインの中核。デフォルトのトランスフォーマー配列を引数として受け取り、`for...of` で順次実行する。この設計により、呼び出し元が配列をカスタマイズすることでパイプラインの構成を変更できる。

`update-files.ts:136-159` では、デフォルトとは異なるトランスフォーマー配列を明示的に渡している。`transformMenu` や `transformAsChild` はデフォルトには含まれないが、ファイル更新時には追加され、`transformNext` は条件付き（Next.js 16+ のミドルウェアのみ）でスプレッド演算子を使って挿入される。

### 統一トランスフォーマーインターフェース

`Transformer` 型（`index.ts:27-31`）は `(opts: TransformOpts & { sourceFile: SourceFile }) => Promise<Output>` のシグネチャで統一。ジェネリクス `Output` のデフォルトは `SourceFile` だが、`transformJsx` のように `string` を返すトランスフォーマーも `Transformer<string>` として型安全に宣言できる。

### 共有 SourceFile の逐次変換

すべてのトランスフォーマーが同一の `SourceFile` インスタンスを in-place で変更し、それを返す。ts-morph の `SourceFile` はミュータブルな AST ラッパーなので、各トランスフォーマーが前段の変更結果を自然に引き継ぐ。一時ファイルパスを `createTempSourceFile` で生成し、ts-morph の `Project` に仮想ファイルとして登録する手法もポイントである（`index.ts:37-39`）。

### 2 つの変換パイプライン

コードベースには実質的に 2 つの異なるパイプラインが存在する:

1. **CLI パイプライン**（`transformers/index.ts` の `transform`）: ユーザーの `Config` に基づき、インポートパス・RSC・CSS 変数・アイコン・RTL 等を変換。対象はレジストリからダウンロードしたコンポーネントソース。
2. **スタイルパイプライン**（`styles/transform.ts` の `transformStyle`）: `StyleMap`（CSS から抽出した `cn-*` クラスと Tailwind クラスのマッピング）に基づき、`cn-*` マーカークラスを実際の Tailwind クラスに置換。対象はビルド時のベースコンポーネント。

両者は同じ「ts-morph SourceFile に対するトランスフォーマー配列の逐次適用」パターンを踏襲しているが、`TransformOpts` と `TransformerStyle` という別々の型を持ち、それぞれの文脈に必要なデータのみを受け渡す。

### AST 変更時の逆順適用パターン

`transform-aschild.ts:129` と `transform-render.ts:119` では、AST ノードの変更を「収集してから逆順に適用」するパターンが使われている。ツリー構造を前方から変更するとノードの位置がずれて後続の変更が壊れるため、後方から適用して位置の安定性を保つ。`transform-aschild.ts` はさらに「リーフから内側へ」の反復処理を行い、ネストされた `asChild` を段階的に解決する。

### PostCSS によるスタイルマップ生成

`create-style-map.ts` は PostCSS で CSS をパースし、`cn-*` プレフィックスのセレクタから `@apply` ディレクティブの Tailwind クラスを抽出して `Record<string, string>` のマッピングを構築する。このマッピングは Zod スキーマ（`styleMapSchema`）で `cn-` プレフィックスを持つキーのみに制約されている。CSS → マッピング → AST 変換という 3 段構成で、スタイルの定義と適用を完全に分離している。

## コード例

```typescript
// packages/shadcn/src/utils/transformers/index.ts:42-71
// パイプラインオーケストレーション — デフォルト配列 + for...of ループ
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
) {
  const tempFile = await createTempSourceFile(opts.filename)
  const sourceFile = project.createSourceFile(tempFile, opts.raw, {
    scriptKind: ScriptKind.TSX,
  })

  for (const transformer of transformers) {
    await transformer({ sourceFile, ...opts })
  }

  if (opts.transformJsx) {
    return await transformJsx({ sourceFile, ...opts })
  }

  return sourceFile.getText()
}
```

```typescript
// packages/shadcn/src/utils/transformers/transform-rsc.ts:6-18
// 設定駆動の早期リターン — rsc=true なら何もしない
export const transformRsc: Transformer = async ({ sourceFile, config }) => {
  if (config.rsc) {
    return sourceFile
  }

  const first = sourceFile.getFirstChildByKind(SyntaxKind.ExpressionStatement)
  if (first && directiveRegex.test(first.getText())) {
    first.remove()
  }

  return sourceFile
}
```

```typescript
// packages/shadcn/src/utils/transformers/transform-rtl.ts:109-126
// コアロジックの文脈非依存な抽出 — CLI とビルドスクリプト両方で使える
export async function transformDirection(source: string, rtl: boolean) {
  if (!rtl) {
    return source
  }

  const project = new Project({ useInMemoryFileSystem: true })
  const sourceFile = project.createSourceFile("component.tsx", source, {
    scriptKind: ScriptKind.TSX,
    overwrite: true,
  })

  applyRtlTransformToSourceFile(sourceFile)
  return sourceFile.getText()
}
```

```typescript
// packages/shadcn/src/utils/updaters/update-files.ts:136-159
// 呼び出し元によるパイプラインのカスタマイズ — 条件付きトランスフォーマー挿入
const content = await transform(
  {
    filename: file.path,
    raw: file.content,
    config,
    baseColor,
    transformJsx: !config.tsx,
    isRemote: options.isRemote,
  },
  [
    transformImport,
    transformRsc,
    transformCssVars,
    transformTwPrefixes,
    transformIcons,
    transformMenu,
    transformAsChild,
    transformRtl,
    ...(_isNext16Middleware(filePath, projectInfo, config)
      ? [transformNext]
      : []),
    transformCleanup,
  ]
)
```

## パターンカタログ

- **Pipeline パターン** (分類: 振る舞い)
  - 解決する問題: 複数の独立した変換を順序立てて適用し、各変換の追加・削除・並べ替えを容易にする
  - 適用条件: 入力データに対して複数の逐次変換が必要で、変換の組み合わせが文脈によって異なる場合
  - コード例: `packages/shadcn/src/utils/transformers/index.ts:42-71`
  - 注意点: 変換の順序依存性に注意。cleanup は必ず最後に配置する必要がある

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 同一インターフェースで異なるアルゴリズムを差し替え可能にする
  - 適用条件: 変換ロジックが複数あり、実行時の設定によって使い分ける場合
  - コード例: `packages/shadcn/src/utils/updaters/update-files.ts:136-159` — 呼び出し元がトランスフォーマー配列を組み替え
  - 注意点: 各 Strategy（トランスフォーマー）が同じ `TransformOpts` を受け取るため、不要なプロパティが渡されることがある

- **Null Object パターンの変形** (分類: 振る舞い)
  - 解決する問題: 条件分岐をパイプライン外部ではなく各トランスフォーマー内部に閉じ込める
  - 適用条件: パイプラインに常にすべてのステップを含めたいが、設定によって一部をスキップする場合
  - コード例: `packages/shadcn/src/utils/transformers/transform-rsc.ts:7-9` — 設定が `rsc: true` なら入力をそのまま返す
  - 注意点: 早期リターンのコストが無視できる場合にのみ有効。重い初期化がある場合はパイプライン構築時にフィルタすべき

## Good Patterns

- **統一インターフェースのトランスフォーマー型**: `Transformer<Output = SourceFile>` というジェネリック型でほぼすべてのトランスフォーマーを統一しつつ、`transformJsx` のように出力型が異なるものにも対応。型安全性と柔軟性を両立している。

```typescript
// packages/shadcn/src/utils/transformers/index.ts:27-31
export type Transformer<Output = SourceFile> = (
  opts: TransformOpts & { sourceFile: SourceFile }
) => Promise<Output>
```

- **コアロジックの再利用エクスポート**: `transformDirection`（RTL）と `cleanupMarkers`（マーカー除去）は、Transformer インターフェースに依存しないスタンドアロン関数として別途エクスポートされ、ビルドスクリプト（`build-registry.mts:652`）やマイグレーションツール（`migrate-rtl.ts:129`）から直接呼び出される。`utils/index.ts` でこれらを公開 API として再エクスポートしている。

```typescript
// packages/shadcn/src/utils/transformers/transform-cleanup.ts:133-146
// Standalone function to clean up cn-* markers from source code.
// This is used by the build script and doesn't require a config object.
export async function cleanupMarkers(source: string) {
  const project = new Project({ useInMemoryFileSystem: true })
  const sourceFile = project.createSourceFile("component.tsx", source, {
    scriptKind: ScriptKind.TSX,
    overwrite: true,
  })
  applyCleanup(sourceFile)
  return sourceFile.getText()
}
```

- **逆順適用による AST 安全性**: `transform-aschild.ts` と `transform-render.ts` は変更を配列に収集し、逆順で適用することで、ノード位置のずれを防いでいる。さらに `transform-aschild.ts` はリーフ優先の反復ループ（最大 10 回）でネスト構造を段階的に処理する。

```typescript
// packages/shadcn/src/utils/transformers/transform-aschild.ts:129
// Apply transformations in reverse order to preserve node validity.
for (const info of transformations.reverse()) {
```

- **既存コードスタイルの自動検出と尊重**: `transform-icons.ts:206-210` と `transform-legacy-icons.ts:83-87` は、既存のインポート宣言がセミコロンを使っているかを検出し、追加するインポートのスタイルを合わせる。

```typescript
// packages/shadcn/src/utils/transformers/transform-icons.ts:206-210
function _useSemicolon(sourceFile: SourceFile) {
  return (
    sourceFile.getImportDeclarations()?.[0]?.getText().endsWith(";") ?? false
  )
}
```

## Anti-Patterns / 注意点

- **マッピングテーブルの肥大化**: `transform-rtl.ts` は 50 行以上の定数マッピングテーブル（`RTL_MAPPINGS`, `RTL_TRANSLATE_X_MAPPINGS` 等）を持ち、マッピングの順序にも依存する（部分一致を避けるため負のプレフィックスが先）。テーブルが増えると保守コストが高くなる。

```typescript
// Bad: 順序依存のマッピングテーブルが暗黙の制約を持つ
const RTL_MAPPINGS: [string, string][] = [
  ["-ml-", "-ms-"],  // 負のプレフィックスが先（順序重要）
  ["-mr-", "-me-"],
  ["ml-", "ms-"],
  // ...50行以上
]
```

```typescript
// Better: マッピングに優先度を明示し、テスト可能な形にする
const RTL_MAPPINGS = [
  { from: "ml-", to: "ms-", negated: "-ms-" },
  { from: "mr-", to: "me-", negated: "-me-" },
  // ...
].sort((a, b) => b.from.length - a.from.length) // 長い方を優先
```

- **トランスフォーマー間の暗黙の順序依存**: `transformCleanup` は `cn-*` マーカークラスを除去するため、必ずパイプラインの最後に配置する必要がある。しかしこの制約はコード上のコメントでしか表現されておらず、型システムでは強制されない。順序を入れ替えると RTL や Tailwind プレフィックスの変換がマーカーに対して動作しなくなる。

```typescript
// Bad: 順序制約が暗黙的
transformers: Transformer[] = [
  transformCleanup,  // ここに置くと他のトランスフォーマーが壊れる
  transformRtl,
]
```

```typescript
// Better: cleanup を最後に強制する構造
function transform(opts, transformers) {
  const [regular, cleanup] = partition(transformers, t => t !== transformCleanup)
  for (const t of [...regular, ...cleanup]) { await t(opts) }
}
```

## 導出ルール

- `[MUST]` AST 変換パイプラインの各ステップは統一インターフェースに従い、入力と同じ型を返す関数として実装する
  - 根拠: shadcn/ui の `Transformer` 型は全 14 トランスフォーマーで統一され、パイプラインの組み替えや新規追加が呼び出し元の配列変更だけで完結する（`index.ts:27-31`, `update-files.ts:136-159`）
- `[MUST]` 複数の AST ノードを書き換える場合、変更を収集してから逆順（末尾→先頭）に適用する
  - 根拠: 前方から変更するとノード位置がずれて後続の変更が壊れる。`transform-aschild.ts:129` と `transform-render.ts:119` が一貫してこのパターンを使用
- `[SHOULD]` 設定値による変換の有効/無効は、呼び出し側の条件分岐ではなくトランスフォーマー内部の早期リターンで制御する
  - 根拠: 全トランスフォーマー（`transform-rsc.ts:7`, `transform-css-vars.ts:12`, `transform-icons.ts:8` 等）が冒頭で config を検査し、不要なら `sourceFile` をそのまま返す。パイプライン構築コードがシンプルに保たれる
- `[SHOULD]` パイプライン内のトランスフォーマーから、文脈非依存な純粋関数（`string → string`）を抽出して別途エクスポートする
  - 根拠: `transformDirection` と `cleanupMarkers` は CLI・ビルドスクリプト・マイグレーションツールの 3 箇所で再利用されている（`transform-rtl.ts:109`, `transform-cleanup.ts:133`, `build-registry.mts:652`, `migrate-rtl.ts:129`）
- `[SHOULD]` AST 操作に複数のツールを使う場合、各ツールの責務を明確に分離し、変換パイプラインの境界で文字列として受け渡す
  - 根拠: ts-morph で構造変換した後、recast + Babel で TSX→JSX 変換する設計（`transform-jsx.ts:64-95`）。`sourceFile.getFullText()` で文字列化してから recast に渡すことで、ツール間の AST 非互換性を回避
- `[AVOID]` パイプラインの順序制約を暗黙にしない — cleanup・正規化ステップの実行位置はコードレベルで保証する
  - 根拠: `transformCleanup` が最後でないとマーカークラスが残り他のトランスフォーマーが誤動作するが、この制約は型では表現されていない。`update-files.ts` ではすべての呼び出し元で手動で最後に配置している

## 適用チェックリスト

- [ ] コード変換パイプラインの各ステップが統一されたインターフェース（同じ入出力型）を持っているか
- [ ] 各トランスフォーマーが設定値を冒頭で検査し、不要時は入力をそのまま返しているか
- [ ] パイプラインのデフォルト構成を関数引数のデフォルト値として定義し、呼び出し元がカスタマイズ可能にしているか
- [ ] 複数の AST ノード変更を行う場合、逆順適用パターンを使ってノード位置のずれを防いでいるか
- [ ] パイプライン内のロジックから、ビルドスクリプトやマイグレーションでも使えるスタンドアロン関数を切り出しているか
- [ ] 複数の AST ツールを使う場合、ツール間の境界が文字列（テキスト）で明確に区切られているか
- [ ] cleanup や正規化のような最後に実行すべきステップの順序がコードレベルで保証されているか
- [ ] 新しいトランスフォーマーを追加する際に、変更するのがトランスフォーマーファイルの作成とパイプライン配列への追加だけで済む構造になっているか
