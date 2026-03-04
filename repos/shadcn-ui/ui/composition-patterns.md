# Composition Patterns

> リポジトリ: shadcn-ui/ui
> 分析日: 2026-03-04

## 概要

shadcn/ui は CLI ツール（shadcn）とコンポーネントライブラリの両面で、多層的な合成パターンを駆使している。CLI 側では AST ベースのトランスフォーマーチェーン、PostCSS プラグインパイプライン、依存解決のトポロジカルソートという 3 つの異なる合成手法が協調動作する。コンポーネント側では `cn()` によるクラス合成、`data-slot` による構造マーキング、`React.ComponentProps<>` による型委譲が統一パターンとして適用されている。これらの合成手法は「コード生成時の変換」という特殊な文脈で最適化されており、汎用的な設計原則を多数含んでいる。

## 背景にある原則

- **統一インターフェースによるパイプライン合成**: トランスフォーマーはすべて `Transformer<Output = SourceFile>` 型を満たす関数であり、同じ `(opts) => Promise<Output>` シグネチャに統一されている。これにより、各トランスフォーマーは独立して開発・テストでき、パイプラインへの追加・削除が容易になる。根拠: `packages/shadcn/src/utils/transformers/index.ts:27-31` の型定義。
- **合成の段階的適用（多層パイプライン）**: ファイル変換は AST 変換（ts-morph）と CSS 変換（PostCSS）の 2 層に分かれており、それぞれの層に専用のプラグインシステムがある。1 つのパイプラインに全責務を詰め込むのではなく、表現力の異なるツールを適切なレイヤーで使い分けている。根拠: `update-css-vars.ts` の PostCSS プラグインチェーンと `transformers/index.ts` の ts-morph チェーンが独立して動作する構造。
- **フェールソフトな変換ステップ**: 各トランスフォーマーは対象がない場合でもエラーを投げず、入力をそのまま返す。たとえば `transformRsc` は `config.rsc` が true なら何もせず `sourceFile` を返す。これにより、パイプライン全体が特定の設定に依存せず堅牢に動作する。根拠: `transform-rsc.ts:7-9`, `transform-icons.ts:10-12`。
- **データ駆動の合成（宣言的パイプライン構築）**: PostCSS プラグインの適用順序はランタイムの設定（Tailwind バージョン、CSS 変数の有無等）に基づいて動的に構築される。条件分岐はパイプライン構築時に集約され、各プラグイン内部はシンプルに保たれている。根拠: `update-css-vars.ts:85-117`。

## 実例と分析

### AST トランスフォーマーチェーン

コードベースの中核にある合成パターンは、`transform()` 関数によるトランスフォーマーチェーンである。ts-morph の `SourceFile` を共有状態として、複数のトランスフォーマーが順次適用される。

`transform()` 関数はデフォルトのトランスフォーマーリストを持つが、呼び出し側がリストを上書きできる設計になっている。`update-files.ts:145-159` では、プロジェクトのコンテキストに応じて `transformNext` を条件付きで追加している。これは「デフォルト + コンテキスト依存の拡張」という合成の典型例である。

各トランスフォーマーの責務は明確に分離されている:
- `transformImport`: インポートパスのエイリアス変換
- `transformRsc`: "use client" ディレクティブの除去
- `transformCssVars`: CSS 変数からインラインカラーへの変換
- `transformTwPrefixes`: Tailwind クラスへのプレフィクス付与
- `transformIcons`: アイコンライブラリ間の変換
- `transformCleanup`: マーカークラスの除去

### スタイル変換パイプライン

`styles/` ディレクトリには、コンポーネントのスタイリングに特化した別のトランスフォーマーチェーンがある。`TransformerStyle<Output>` 型は `Transformer<Output>` と似た構造だが、`config` の代わりに `styleMap` を受け取る。

パイプラインは 3 段構成: CSS をパースして `StyleMap` を生成（`createStyleMap`）→ StyleMap をソースコードに適用（`transformStyleMap`）→ テキスト出力（`transformStyle`）。この「入力データの変換 → AST への適用 → 出力」という流れは、データ変換パイプラインの典型パターンである。

### PostCSS プラグインによる CSS 変換

`update-css-vars.ts` では PostCSS プラグインを配列として構築し、`postcss(plugins).process()` で一括適用する。プラグインの構成は Tailwind バージョンに応じて完全に切り替わる:

v3 では `updateCssVarsPlugin` + オプショナルな `cleanupDefaultNextStylesPlugin` の最小構成。v4 では `addCustomVariant` → `cleanupDefaultNextStylesPlugin` → `updateCssVarsPluginV4` → `updateThemePlugin` → `updateTailwindConfigPlugin` → `updateTailwindConfigAnimationPlugin` → `updateTailwindConfigKeyframesPlugin` という最大 7 段のチェーンとなる。

### 依存解決のトポロジカルソート

`resolver.ts` では、レジストリアイテムの依存関係を再帰的に解決し、Kahn のアルゴリズムでトポロジカルソートを適用する。これは「合成順序が重要な場合のグラフベース解決」の実装例である。循環依存が検出された場合はワーニングを出しつつソート済みリストに残りを追加するフォールバック戦略を取っている。

### コンポーネントの合成パターン

UI コンポーネントでは 3 つの合成手法が統一的に適用されている:

1. **`cn()` によるクラス合成**: `clsx` + `tailwind-merge` の合成で、デフォルトクラスとユーザー提供クラスをマージする
2. **`data-slot` による構造マーキング**: 各コンポーネントが `data-slot="component-name"` を付与し、親コンポーネントからの CSS セレクタによるスタイリングを可能にする
3. **`React.ComponentProps<>` による型委譲**: プリミティブ要素や Radix コンポーネントの Props 型をそのまま継承し、拡張する

### addComponents のオーケストレーション

`add-components.ts` の `addProjectComponents` 関数は、上記すべてのパイプラインをオーケストレーションする。処理順序は: レジストリツリー解決 → Tailwind 設定更新 → CSS 変数更新 → CSS 更新 → 環境変数更新 → 依存関係インストール → フォント更新 → ファイル書き出し。各ステップは独立した updater 関数として分離されており、順序を入れ替えても（依存関係を除き）個々のステップが壊れることはない。

## コード例

```typescript
// packages/shadcn/src/utils/transformers/index.ts:27-52
// トランスフォーマーの統一型定義とパイプライン実行
export type Transformer<Output = SourceFile> = (
  opts: TransformOpts & {
    sourceFile: SourceFile
  }
) => Promise<Output>

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
  // ...
}
```

```typescript
// packages/shadcn/src/utils/updaters/update-css-vars.ts:85-117
// 条件分岐によるプラグインチェーンの動的構築
let plugins = [updateCssVarsPlugin(cssVars)]

if (options.cleanupDefaultNextStyles) {
  plugins.push(cleanupDefaultNextStylesPlugin())
}

if (options.tailwindVersion === "v4") {
  plugins = []
  plugins.push(addCustomVariant({ params: "dark (&:is(.dark *))" }))
  if (options.cleanupDefaultNextStyles) {
    plugins.push(cleanupDefaultNextStylesPlugin())
  }
  plugins.push(updateCssVarsPluginV4(cssVars, { overwriteCssVars: options.overwriteCssVars }))
  plugins.push(updateThemePlugin(cssVars))
  if (options.tailwindConfig) {
    plugins.push(updateTailwindConfigPlugin(options.tailwindConfig))
    plugins.push(updateTailwindConfigAnimationPlugin(options.tailwindConfig))
    plugins.push(updateTailwindConfigKeyframesPlugin(options.tailwindConfig))
  }
}

const result = await postcss(plugins).process(input, { from: undefined })
```

```typescript
// packages/shadcn/src/utils/transformers/transform-rsc.ts:6-18
// フェールソフトなトランスフォーマー: 対象がなければ素通しする
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
// packages/shadcn/src/registry/resolver.ts:622-743
// Kahn のアルゴリズムによるトポロジカルソート（抜粋）
function topologicalSortRegistryItems(items, sourceMap) {
  // ... adjacency list とin-degree の構築 ...
  // Implements Kahn's algorithm.
  const queue: string[] = []
  const sorted = []
  inDegree.forEach((degree, hash) => {
    if (degree === 0) queue.push(hash)
  })
  while (queue.length > 0) {
    const currentHash = queue.shift()!
    sorted.push(itemMap.get(currentHash)!)
    adjacencyList.get(currentHash)!.forEach((dependentHash) => {
      const newDegree = inDegree.get(dependentHash)! - 1
      inDegree.set(dependentHash, newDegree)
      if (newDegree === 0) queue.push(dependentHash)
    })
  }
  // 循環依存のフォールバック
  if (sorted.length !== items.length) {
    console.warn("Circular dependency detected in registry items")
    // 未ソートのアイテムも末尾に追加
  }
  return sorted
}
```

```tsx
// apps/v4/registry/new-york-v4/ui/card.tsx:5-16
// コンポーネント合成の統一パターン: cn() + data-slot + ComponentProps
function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "flex flex-col gap-6 rounded-xl border bg-card py-6 text-card-foreground shadow-sm",
        className
      )}
      {...props}
    />
  )
}
```

## パターンカタログ

- **Pipeline パターン** (分類: 振る舞い)
  - 解決する問題: 複数の変換ステップを順序立てて適用する必要がある
  - 適用条件: 各ステップが同じ入力/出力型を共有し、順序に依存関係がある場合
  - コード例: `packages/shadcn/src/utils/transformers/index.ts:42-71`
  - 注意点: 共有状態（SourceFile）の変異に依存するため、並列化が困難

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 同じインターフェースで異なるアルゴリズムを切り替える
  - 適用条件: ランタイム設定（Tailwind バージョン等）に応じて処理を分岐する場合
  - コード例: `packages/shadcn/src/utils/updaters/update-css-vars.ts:85-117` — v3/v4 でプラグインチェーン全体を差し替え
  - 注意点: 条件分岐がパイプライン構築に集約されることで、各プラグインは単純に保たれる

- **Composite パターン** (分類: 構造)
  - 解決する問題: 複数の子コンポーネントを一つの複合コンポーネントとして提供する
  - 適用条件: `Dialog`, `Card`, `Sidebar` のように複数のサブコンポーネントが協調動作する場合
  - コード例: `apps/v4/registry/new-york-v4/ui/dialog.tsx:10-158` — Dialog, DialogTrigger, DialogContent 等
  - 注意点: `data-slot` でマーキングすることで、親コンポーネントからのスタイル制御を実現

- **Visitor パターン** (分類: 振る舞い)
  - 解決する問題: AST ノードの種類に応じた処理を、ノード構造を変更せずに追加する
  - 適用条件: ts-morph や PostCSS の AST を走査して特定ノードを変換する場合
  - コード例: `packages/shadcn/src/styles/transform-style-map.ts:82-147` — cva, className, mergeProps それぞれの走査
  - 注意点: 走査中のノード変更は注意が必要（shadcn は `forEachDescendant` で安全に処理）

## Good Patterns

- **デフォルト付きパイプライン注入**: `transform()` がデフォルトのトランスフォーマーリストを第 2 引数に持ち、呼び出し側が完全に上書きできる設計。`update-files.ts:145-159` では文脈に応じて `transformNext` を条件付きで追加している。これにより、デフォルトの振る舞いを維持しつつ拡張ポイントを提供する。

```typescript
// packages/shadcn/src/utils/updaters/update-files.ts:145-159
const content = await transform(
  { filename: file.path, raw: file.content, config, baseColor, transformJsx: !config.tsx },
  [
    transformImport, transformRsc, transformCssVars, transformTwPrefixes,
    transformIcons, transformMenu, transformAsChild, transformRtl,
    ...(_isNext16Middleware(filePath, projectInfo, config) ? [transformNext] : []),
    transformCleanup,  // cleanup は常に最後
  ]
)
```

- **フェールソフト変換**: 各トランスフォーマーが対象外の入力を静かにパススルーする設計。`transformIcons` はサポートされていないアイコンライブラリに対して `return sourceFile` するだけで、エラーを投げない（`transform-icons.ts:10-12`）。パイプラインの堅牢性が大幅に向上する。

```typescript
// packages/shadcn/src/utils/transformers/transform-icons.ts:5-12
export const transformIcons: Transformer = async ({ sourceFile, config }) => {
  const iconLibrary = config.iconLibrary
  if (!iconLibrary || !(iconLibrary in iconLibraries)) {
    return sourceFile  // 未対応ライブラリは素通し
  }
  // ...
}
```

- **`cn()` による安全なクラス合成**: `clsx` でクラスのフィルタリングと結合を行い、`tailwind-merge` で競合するユーティリティクラスを解決する 2 段階合成。ユーザー提供の `className` を最後の引数にすることで、デフォルトスタイルのオーバーライドを保証する。

```typescript
// apps/v4/registry/new-york-v4/lib/utils.ts:4-6
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

## Anti-Patterns / 注意点

- **共有可変状態への依存**: トランスフォーマーチェーンは `SourceFile` を in-place で変更する。これにより順序依存性が生まれ、テスト時に各トランスフォーマーの独立した検証が難しくなる。shadcn 自体はこの制約を受け入れたうえで、各トランスフォーマーを個別にテストしている。

```typescript
// Bad: 共有状態を変更するため、実行順序が結果に影響する
for (const transformer of transformers) {
  await transformer({ sourceFile, ...opts })  // sourceFile を in-place 変更
}

// Better: 不変変換が可能な場合はイミュータブルに
// ただし AST 操作では現実的でないケースが多い
```

- **パイプライン構築ロジックの条件分岐肥大化**: `transformCssVars` 関数内の v3/v4 分岐は現時点で管理可能だが、バージョンが増えると分岐が線形に増大する。

```typescript
// Bad: バージョンごとに if 分岐が増殖する
if (options.tailwindVersion === "v4") {
  plugins = []
  plugins.push(addCustomVariant(...))
  // ... 7 つのプラグインを条件付きで追加
}
// v5 が来たらさらに分岐が増える

// Better: バージョン別のプラグインセットをレジストリとして外部化
const pluginSets: Record<TailwindVersion, PluginFactory[]> = {
  v3: [updateCssVarsPlugin],
  v4: [addCustomVariant, updateCssVarsPluginV4, updateThemePlugin, ...],
}
const plugins = pluginSets[version].map(factory => factory(cssVars, options))
```

## 導出ルール

- `[MUST]` パイプラインの各ステップは統一されたインターフェース（同じ型シグネチャ）に従うこと
  - 根拠: shadcn の `Transformer<Output>` 型と `TransformerStyle<Output>` 型が示すように、統一インターフェースがパイプラインの拡張性と各ステップの独立テストを保証する（`transformers/index.ts:27-31`）
- `[MUST]` パイプラインの各ステップは、対象外の入力に対してエラーを投げずに入力をそのまま返すこと（フェールソフト設計）
  - 根拠: `transformRsc`, `transformIcons` 等すべてのトランスフォーマーが設定や対象の有無を内部で判断し、該当しない場合は `return sourceFile` で素通しする（`transform-rsc.ts:7-9`）
- `[SHOULD]` パイプラインのステップリストはデフォルト値を持ちつつ、呼び出し側から完全に上書き可能にすること
  - 根拠: `transform()` の第 2 引数がデフォルト配列を持ちながら `update-files.ts` で文脈依存の拡張を許容する設計が、柔軟性と一貫性を両立している
- `[SHOULD]` 複数の合成レイヤー（AST 変換、CSS 変換等）が必要な場合、レイヤーごとに独立したパイプラインを設けること
  - 根拠: shadcn は ts-morph ベースのトランスフォーマーチェーンと PostCSS ベースのプラグインチェーンを分離しており、各レイヤーが最適なツールと抽象レベルで動作する（`transformers/` と `updaters/update-css-vars.ts`）
- `[SHOULD]` 依存関係のある合成順序にはトポロジカルソートを適用し、循環依存にはフォールバック戦略を用意すること
  - 根拠: `resolver.ts:622-743` の Kahn アルゴリズム実装が、循環依存検出時にワーニングを出しつつ残りのアイテムを追加するフォールバック戦略を採用
- `[SHOULD]` React コンポーネントの合成では `data-*` 属性でスロット名をマーキングし、CSS からの構造参照を可能にすること
  - 根拠: shadcn/ui の全コンポーネントが `data-slot="component-name"` を使用し、`has-data-[slot=card-action]:grid-cols-[1fr_auto]` のようなスタイル制御を実現（`card.tsx:23`）
- `[AVOID]` パイプライン構築のバージョン分岐を関数本体にインラインで書くこと — バージョン別のステップ定義はデータ構造として外部化する
  - 根拠: `update-css-vars.ts:85-117` の v3/v4 分岐は現時点で管理可能だが、バージョン増加時にスケールしない構造になっている

## 適用チェックリスト

- [ ] 変換パイプラインの各ステップが統一型に従っているか確認する
- [ ] 各ステップが対象外の入力を素通しするフェールソフト設計になっているか検証する
- [ ] パイプラインのデフォルト構成を持ちつつ、呼び出し側から拡張・上書きできるか確認する
- [ ] 異なる抽象レベルの変換（AST、CSS、テキスト等）を混在させていないか検証する
- [ ] 依存関係のある合成順序にグラフベースの解決（トポロジカルソート）を適用しているか確認する
- [ ] 循環依存やエッジケースに対するフォールバック戦略が存在するか検証する
- [ ] React コンポーネントで `data-slot` 等のマーキングを使い、構造の外部参照を可能にしているか確認する
- [ ] `cn()` のようなクラス合成関数で、ユーザー提供の値が最後（最高優先度）に配置されているか検証する
