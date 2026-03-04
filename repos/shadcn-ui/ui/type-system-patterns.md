# type-system-patterns

> リポジトリ: shadcn-ui/ui
> 分析日: 2026-03-04

## 概要

shadcn/ui における型システムの設計パターンを分析する。このリポジトリでは Zod スキーマを Single Source of Truth（SSOT）として活用し、`z.infer` による型導出、`discriminatedUnion` によるバリアント分岐、`React.ComponentProps` によるインターフェースレスなコンポーネント Props 型付けなど、一貫した型戦略が 2730 ファイルの大規模コードベース全体に適用されている。特筆すべきは、別途 `interface` を定義するのではなく、既存のスキーマ・コンポーネント・定数から型を機械的に導出する「型導出優先」のアプローチが徹底されている点である。

## 背景にある原則

- **Schema-First Typing（スキーマ起点の型設計）**: 型定義を手書きするのではなく、Zod スキーマから `z.infer` で導出することで、ランタイムバリデーションと静的型検査を単一の定義で両立させる。手書きの型とバリデーションロジックの乖離を構造的に排除するため。根拠: `schema.ts` の全 export 型が `z.infer<typeof ...>` で導出されている（`schema.ts:183,197,296,302`）。

- **Props Interface 不要の原則**: React コンポーネントの Props 型に `interface` を定義せず、`React.ComponentProps<"element">` や `Primitive.Props` から直接導出する。コンポーネントと DOM/プリミティブの Props が常に同期し、ラッパー層で Props の脱落が起きない。根拠: 全 UI コンポーネント（40+ ファイル）で `interface` による Props 定義が存在せず、インライン型注釈のみ。

- **Composable Schema（スキーマの合成可能性）**: `.extend()`, `.pick()`, `.partial()`, `.deepPartial()` を使って既存スキーマから派生スキーマを宣言的に作る。スキーマ間の関係がコードで表現され、フィールド追加・削除時に影響範囲が自動的に伝播する。根拠: `rawConfigSchema` → `configSchema`（`.extend()`）、`registryItemCommonSchema` → `registryItemSchema` の各バリアント（`.extend()`）、`registryResolvedItemsTreeSchema`（`.pick().extend()`）。

- **型の導出チェーン最小化**: 型は可能な限り元の定義（スキーマ、定数配列、ライブラリ型）から1段階で導出する。中間型を挟まず、変更が直接伝播するようにする。根拠: `type CarouselOptions = UseCarouselParameters[0]` のように `Parameters<>` で直接抽出（`carousel.tsx:14`）、`type BaseName = Base["name"]` のようにインデックスアクセス型で直接取得（`config.ts:23`）。

## 実例と分析

### Zod discriminatedUnion による型安全なバリアント分岐

`registryItemSchema` は `type` フィールドをディスクリミネータとして3つのバリアントを定義している。各バリアントは `registryItemCommonSchema.extend()` で共通フィールドを継承し、バリアント固有のフィールドだけを追加する。

```typescript
// packages/shadcn/src/registry/schema.ts:169-181
export const registryItemSchema = z.discriminatedUnion("type", [
  registryItemCommonSchema.extend({
    type: z.literal("registry:base"),
    config: rawConfigSchema.deepPartial().optional(),
  }),
  registryItemCommonSchema.extend({
    type: z.literal("registry:font"),
    font: registryItemFontSchema,
  }),
  registryItemCommonSchema.extend({
    type: registryItemTypeSchema.exclude(["registry:base", "registry:font"]),
  }),
])
```

ここでは `.exclude()` を使って「それ以外の全タイプ」を1つのバリアントで捕捉するパターンが使われている。新しいタイプを `registryItemTypeSchema` に追加しても、`discriminatedUnion` の各ブランチを手動で更新する必要がない。

`registryItemFileSchema` でも同様のパターンで「`target` が必須のタイプ」と「`target` がオプショナルなタイプ」を分けている:

```typescript
// packages/shadcn/src/registry/schema.ts:92-106
export const registryItemFileSchema = z.discriminatedUnion("type", [
  z.object({
    path: z.string(),
    content: z.string().optional(),
    type: z.enum(["registry:file", "registry:page"]),
    target: z.string(),  // required
  }),
  z.object({
    path: z.string(),
    content: z.string().optional(),
    type: registryItemTypeSchema.exclude(["registry:file", "registry:page"]),
    target: z.string().optional(),  // optional
  }),
])
```

### Extract<> による discriminatedUnion からのバリアント型抽出

`z.infer` で得たユニオン型から特定のバリアントだけを取り出すために `Extract<>` を組み合わせる:

```typescript
// packages/shadcn/src/registry/schema.ts:183-189
export type RegistryItem = z.infer<typeof registryItemSchema>
export type RegistryBaseItem = Extract<RegistryItem, { type: "registry:base" }>
export type RegistryFontItem = Extract<RegistryItem, { type: "registry:font" }>
```

このパターンは UI 層でも使われている。ページツリーのノード型から特定のノード種を取り出す:

```typescript
// apps/v4/lib/page-tree.ts:1-5
export type PageTreeNode = (typeof source.pageTree)["children"][number]
export type PageTreeFolder = Extract<PageTreeNode, { type: "folder" }>
export type PageTreePage = Extract<PageTreeNode, { type: "page" }>
```

ジェネリクスと組み合わせた高度な例として、iframe メッセージングの型安全なディスパッチがある:

```typescript
// apps/v4/app/(create)/hooks/use-iframe-sync.tsx:19-24
export function useIframeMessageListener<
  Message extends ParentToIframeMessage,
  MessageType extends Message["type"],
>(
  messageType: MessageType,
  onMessage: (data: Extract<Message, { type: MessageType }>["data"]) => void
)
```

### React.ComponentProps による Props 型のインライン定義

コンポーネント Props を別途定義せず、パラメータ型注釈で直接記述するパターンがコードベース全体の標準:

```typescript
// apps/v4/registry/bases/base/ui/input.tsx:6
function Input({ className, type, ...props }: React.ComponentProps<"input">) {

// apps/v4/registry/bases/base/ui/carousel.tsx:53
function Carousel({
  ...props
}: React.ComponentProps<"div"> & CarouselProps) {

// apps/v4/registry/bases/base/ui/carousel.tsx:179
function CarouselPrevious({
  ...props
}: React.ComponentProps<typeof Button>) {
```

カスタム Props が必要な場合はインラインの交差型で追加:

```typescript
// apps/v4/registry/bases/base/ui/sidebar.tsx:56-68
function SidebarProvider({
  defaultOpen = true,
  open: openProp,
  onOpenChange: setOpenProp,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
```

### VariantProps<typeof cvaFn> による variant 型の自動導出

cva（class-variance-authority）で定義したバリアント設定から型を自動導出し、Props と結合する:

```typescript
// apps/v4/registry/bases/base/ui/button.tsx:38-43
function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
```

### スキーマの段階的拡張パターン

基底スキーマから `.extend()` で段階的にフィールドを追加する:

```typescript
// packages/shadcn/src/registry/schema.ts:28-67
export const rawConfigSchema = z
  .object({
    style: z.string(),
    rsc: z.coerce.boolean().default(false),
    // ... base fields
  })
  .strict()

export const configSchema = rawConfigSchema.extend({
  resolvedPaths: z.object({
    cwd: z.string(),
    tailwindConfig: z.string(),
    // ... resolved fields
  }),
})
```

内部で一時的に使うスキーマも `.extend().passthrough()` で柔軟に構成する:

```typescript
// packages/shadcn/src/registry/resolver.ts:112-120
const registryItemWithSourceSchema = registryItemCommonSchema
  .extend({
    type: registryItemTypeSchema,
    _source: z.string().optional(),
    font: registryItemFontSchema.optional(),
    config: z.any().optional(),
  })
  .passthrough()
```

### .pick().extend() による View 固有スキーマの導出

共通スキーマから必要なフィールドだけを選択し、ビュー固有のフィールドを追加する:

```typescript
// packages/shadcn/src/registry/schema.ts:224-244
export const registryResolvedItemsTreeSchema = registryItemCommonSchema
  .pick({
    dependencies: true,
    devDependencies: true,
    files: true,
    tailwind: true,
    cssVars: true,
    css: true,
    envVars: true,
    docs: true,
  })
  .extend({
    fonts: z.array(
      registryItemCommonSchema.extend({
        type: z.literal("registry:font"),
        font: registryItemFontSchema,
      })
    ).optional(),
  })
```

### z.lazy() による再帰型の定義

CSS プロパティの再帰構造を `z.lazy()` で定義する:

```typescript
// packages/shadcn/src/registry/schema.ts:125-131
const cssValueSchema: z.ZodType<any> = z.lazy(() =>
  z.union([
    z.string(),
    z.array(z.union([z.string(), z.record(z.string(), z.string())])),
    z.record(z.string(), cssValueSchema),
  ])
)
```

`z.lazy()` の戻り値には型推論が効かないため、明示的に `z.ZodType<any>` と型注釈している。

### CLI オプションの Zod スキーマ化

CLI コマンドのオプションを Zod スキーマで定義し、パース結果に型安全にアクセスする:

```typescript
// packages/shadcn/src/commands/add.ts:24-34
export const addOptionsSchema = z.object({
  components: z.array(z.string()).optional(),
  yes: z.boolean(),
  overwrite: z.boolean(),
  cwd: z.string(),
  all: z.boolean(),
  path: z.string().optional(),
  silent: z.boolean(),
  srcDir: z.boolean().optional(),
  cssVariables: z.boolean(),
})

// packages/shadcn/src/commands/add.ts:61-67
.action(async (components, opts) => {
  const options = addOptionsSchema.parse({
    components,
    cwd: path.resolve(opts.cwd),
    ...opts,
  })
```

### 定数配列からの型導出

`as const` で定義した定数配列からインデックスアクセス型で型を取り出す:

```typescript
// apps/v4/registry/config.ts:23-26
export type BaseName = Base["name"]
export type StyleName = Style["name"]
export type ThemeName = Theme["name"]
export type BaseColorName = BaseColor["name"]

// apps/v4/registry/config.ts:29-34
const fontValues = fonts.map((f) => f.name.replace("font-", "")) as [
  string,
  ...string[],
]
export type FontValue = (typeof fontValues)[number]
```

### FormState の型構成パターン

フォームの状態型を Zod スキーマから構造的に導出する:

```typescript
// apps/v4/registry/new-york-v4/examples/form-next-complex-schema.ts:30-34
export type FormState = {
  values: z.infer<typeof formSchema>
  errors: null | Partial<Record<keyof z.infer<typeof formSchema>, string[]>>
  success: boolean
}
```

`keyof z.infer<typeof formSchema>` でフィールド名の型を取得し、`Partial<Record<...>>` でエラー辞書を構成している。フォームスキーマにフィールドを追加すると、エラー型にも自動的に反映される。

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: ソースコード変換パイプラインで、変換の種類を動的に差し替える
  - 適用条件: 同じインターフェースで複数の処理を切り替える場面
  - コード例: `packages/shadcn/src/utils/transformers/index.ts:27-31`
  - 注意点: `Transformer<Output = SourceFile>` のようにデフォルト型パラメータを持たせると、既存の呼び出しを壊さずに出力型を変更できる

```typescript
// packages/shadcn/src/utils/transformers/index.ts:27-31
export type Transformer<Output = SourceFile> = (
  opts: TransformOpts & {
    sourceFile: SourceFile
  }
) => Promise<Output>
```

## Good Patterns

- **スキーマからの型導出 + satisfies による型チェック**: `z.infer` で型を導出しつつ、オブジェクトリテラルに `satisfies` を付けて構造的整合性を検証する。ランタイムパースなしでも型安全が確保される場面で有効。

```typescript
// packages/shadcn/src/registry/resolver.ts:512-536
const theme = {
  name,
  type: "registry:theme",
  tailwind: { ... },
  cssVars: { ... },
} satisfies z.infer<typeof registryItemSchema>
```

- **Omit + カスタムフィールドによる名前衝突の解決**: ライブラリの Props 型でフィールド名が衝突する場合、`Omit` で除外してから独自定義する。

```typescript
// apps/v4/registry/bases/base/ui/native-select.tsx:6-8
type NativeSelectProps = Omit<React.ComponentProps<"select">, "size"> & {
  size?: "sm" | "default"
}
```

- **type-fest の活用**: 複雑な型変換に `type-fest` のユーティリティ型（`PackageJson` 等）を使い、自前で型を再発明しない。

```typescript
// packages/shadcn/src/utils/get-package-info.ts:3
import { type PackageJson } from "type-fest"
```

- **z.enum に as [T, ...T[]] キャストを使う動的 enum 構築**: 実行時の配列から `z.enum()` を構成する際、非空タプル型にキャストして Zod の型要件を満たす。

```typescript
// apps/v4/registry/config.ts:67-68
base: z.enum(BASES.map((b) => b.name) as [BaseName, ...BaseName[]]),
```

## Anti-Patterns / 注意点

- **z.lazy() に型注釈なしで使う**: `z.lazy()` は再帰参照を遅延させるが、TypeScript の型推論が循環参照で失敗するため、明示的な型注釈が必須。

```typescript
// Bad: 型推論が any に崩壊する
const schema = z.lazy(() =>
  z.object({ children: z.array(schema) })
)

// Better: 明示的な ZodType 注釈
const schema: z.ZodType<TreeNode> = z.lazy(() =>
  z.object({ children: z.array(schema) })
)
```

shadcn/ui では `z.ZodType<any>` を使っている（`schema.ts:125`）が、可能なら具体的な型を指定すべき。

- **discriminatedUnion のバリアント数爆発**: `registryItemTypeSchema` に 14 のタイプがあるが、`discriminatedUnion` では3バリアントに集約し `.exclude()` で「その他」を処理している。バリアントごとに個別ブランチを作ると保守コストが急増する。

```typescript
// Bad: 14バリアント全てを個別定義
z.discriminatedUnion("type", [
  schema.extend({ type: z.literal("registry:lib") }),
  schema.extend({ type: z.literal("registry:block") }),
  // ... 12 more
])

// Better: 固有フィールドがあるものだけ分離し、残りは .exclude() で一括
z.discriminatedUnion("type", [
  schema.extend({ type: z.literal("registry:base"), config: ... }),
  schema.extend({ type: z.literal("registry:font"), font: ... }),
  schema.extend({ type: typeSchema.exclude(["registry:base", "registry:font"]) }),
])
```

## 導出ルール

- `[MUST]` Zod スキーマを定義したら、型は `z.infer<typeof schema>` で導出する。手書きの型とスキーマを並存させない
  - 根拠: shadcn/ui の全 export 型（`RegistryItem`, `Config`, `Preset`, `Event` 等）が例外なく `z.infer` で導出されており、型とバリデーションの不整合がゼロ

- `[MUST]` `z.lazy()` を使う再帰スキーマには `z.ZodType<T>` の型注釈を付ける
  - 根拠: 型注釈なしでは TypeScript が型推論を諦めて `any` に崩壊する（`schema.ts:125` で明示的に `z.ZodType<any>` を付与）

- `[SHOULD]` React コンポーネントの Props 型は `React.ComponentProps<"element">` または `PrimitiveComponent.Props` から導出し、カスタム Props はインラインの交差型（`& { ... }`）で追加する。別途 `interface` を定義しない
  - 根拠: shadcn/ui の 40+ UI コンポーネントで一貫してこのパターンが使われ、Props インターフェースの定義が不要になっている

- `[SHOULD]` discriminatedUnion のバリアントが多い場合は、固有フィールドを持つバリアントのみ個別定義し、残りは `.exclude()` で1つのバリアントにまとめる
  - 根拠: 14 種の registry item type を3バリアントに集約し、新タイプ追加時の変更箇所を最小化している（`schema.ts:169-181`）

- `[SHOULD]` CLI オプションやフォーム入力など外部データの境界には Zod スキーマを配置し、パース結果の型を後続処理で使う
  - 根拠: `addOptionsSchema`, `initOptionsSchema`, `designSystemConfigSchema` 等、全 CLI コマンドでこのパターンが適用されている

- `[SHOULD]` 基底スキーマから `.extend()` / `.pick()` / `.partial()` で派生スキーマを作り、フィールドの重複定義を避ける
  - 根拠: `rawConfigSchema` → `configSchema`（`.extend()`）、`registryItemCommonSchema` → 各バリアント（`.extend()`）、`registryResolvedItemsTreeSchema`（`.pick().extend()`）

- `[SHOULD]` discriminatedUnion から特定バリアントの型を取り出す場合は `Extract<Union, { discriminator: value }>` を使う
  - 根拠: `RegistryBaseItem`, `RegistryFontItem`, `PageTreeFolder` 等で一貫して使用（`schema.ts:186-189`, `page-tree.ts:4-5`）

- `[AVOID]` Zod スキーマの隣に同じ構造の `interface` や `type` を手書きで定義すること。型の二重管理は不整合の温床になる
  - 根拠: コードベース全体で `z.infer` 以外の型定義が存在しないことで、スキーマ変更時の型更新漏れが構造的に排除されている

## 適用チェックリスト

- [ ] プロジェクトの全 Zod スキーマに対応する型が `z.infer<typeof schema>` で導出されているか確認する
- [ ] 手書きの型とスキーマが並存している箇所を洗い出し、`z.infer` への一本化を検討する
- [ ] React コンポーネントの Props 型が `interface` で定義されている場合、`React.ComponentProps` ベースに移行する余地がないか検討する
- [ ] `z.lazy()` を使っている箇所に `z.ZodType<T>` の型注釈があるか確認する
- [ ] CLI ツールや API エンドポイントの入力バリデーションに Zod スキーマを導入し、型を自動導出する
- [ ] discriminatedUnion を使っている箇所で、バリアント数が多い場合に `.exclude()` で集約できないか検討する
- [ ] フォームの状態型（値・エラー）がスキーマから導出されているか確認する
