# API Design Practices

> リポジトリ: shadcn-ui/ui
> 分析日: 2026-03-04

## 概要

shadcn/ui の Registry API は、コンポーネント配信プラットフォームとしての公開インターフェース設計を分析する視点として注目に値する。CLI パッケージ `shadcn` は npm の subpath exports で 6 つのエントリポイント（`.`, `./registry`, `./schema`, `./mcp`, `./utils`, `./icons`）を提供し、ユーザー・サードパーティレジストリ作者・MCP クライアントという異なる消費者に対して段階的な API サーフェスを形成している。UI コンポーネント側では `React.ComponentProps<>` + `data-slot` + named export only という一貫した規約が 53 コンポーネントに厳密に適用されており、コード配信型ライブラリにおける API 設計の実例として体系的に分析できる。

## 背景にある原則

- **段階的公開（Progressive Disclosure of Complexity）**: パッケージの exports は消費者の関心レベルに応じて分離されている。CLI ユーザーは `.` のみ、プログラマティック利用者は `./registry`、型定義が必要なレジストリ作者は `./schema` を使う。全てを 1 エントリポイントに集約せず、必要な深さだけ掘り下げられる設計。根拠: `tsup.config.ts` で 6 つの独立エントリポイントがビルドされている。

- **スキーマ駆動の境界防御（Schema-First Boundary Defense）**: 外部から受け取るデータはすべて Zod スキーマで `parse()` し、型安全性をランタイムで保証する。API 関数の戻り値は例外なくスキーマバリデーションを通過する。これにより型と実行時の整合性が保たれ、不正なレジストリアイテムがシステム内部に侵入することを防ぐ。根拠: `api.ts` の全関数が `registrySchema.parse(result)` 等を呼んでいる。

- **名前付きエクスポートによる消費者保護**: UI コンポーネント（53 ファイル）で `export default` は一切使わず、全て named export に統一。これにより import 時の名前の不一致を防ぎ、IDE の自動補完・リファクタリング・tree shaking の信頼性を高めている。根拠: 53 コンポーネント中 `export default` は 0 件、`forwardRef` も 0 件（React 19 の `ref` as prop を採用）。

- **エラーの構造化と自己文書化**: エラーは単なるメッセージ文字列ではなく、`code`・`statusCode`・`context`・`suggestion` フィールドを持つ構造化オブジェクト。消費者（CLI・MCP・プログラマティック利用）がエラーを判定・表示する方法を選べる。根拠: `errors.ts` の `RegistryError` 基底クラスと 11 個のサブクラス。

## 実例と分析

### Subpath Exports によるパッケージの多面的公開

`package.json` の `exports` フィールドで 6 つのサブパスを定義し、単一パッケージから複数の関心領域を公開している。

```jsonc
// packages/shadcn/package.json:29-57
{
  "exports": {
    ".":          { "types": "./dist/index.d.ts",          "default": "./dist/index.js" },
    "./registry": { "types": "./dist/registry/index.d.ts", "default": "./dist/registry/index.js" },
    "./schema":   { "types": "./dist/schema/index.d.ts",   "default": "./dist/schema/index.js" },
    "./mcp":      { "types": "./dist/mcp/index.d.ts",      "default": "./dist/mcp/index.js" },
    "./utils":    { "types": "./dist/utils/index.d.ts",     "default": "./dist/utils/index.js" },
    "./icons":    { "types": "./dist/icons/index.d.ts",     "default": "./dist/icons/index.js" }
  }
}
```

各サブパスの index ファイルは「再エクスポートのみ」に徹し、実装を内部モジュールに委譲している。

```typescript
// packages/shadcn/src/schema/index.ts:1
export * from "../registry/schema"
```

```typescript
// packages/shadcn/src/registry/index.ts:1-23
export { getRegistries, getRegistryItems, resolveRegistryItems, getRegistry, getRegistriesIndex } from "./api"
export { searchRegistries } from "./search"
export { RegistryError, RegistryNotFoundError, /* ... 8 more */ } from "./errors"
```

この設計の重要な点は、内部モジュール（`builder.ts`, `fetcher.ts`, `resolver.ts`, `context.ts`）を意図的にエクスポートから除外していることである。これにより公開 API サーフェスを制御し、内部実装の変更を破壊的変更にしない自由度を確保している。

### Zod スキーマのレイヤード構成

スキーマは以下のように段階的に構成されている。

1. **基本スキーマ**: `registryItemTypeSchema`（enum）、`registryItemFileSchema`（discriminated union）
2. **部品スキーマ**: `registryItemTailwindSchema`, `registryItemCssVarsSchema`, `registryItemFontSchema`
3. **共通フィールドスキーマ**: `registryItemCommonSchema`（全アイテム共通の 15 フィールド）
4. **最終スキーマ**: `registryItemSchema`（discriminated union で `type` フィールドにより `registry:base`/`registry:font`/その他を分岐）

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

また、レジストリ設定の `registryConfigItemSchema` は `z.union()` で「簡易文字列フォーマット」と「詳細オブジェクトフォーマット」を同時にサポートする。

```typescript
// packages/shadcn/src/registry/schema.ts:6-19
export const registryConfigItemSchema = z.union([
  z.string().refine((s) => s.includes("{name}"), {
    message: "Registry URL must include {name} placeholder",
  }),
  z.object({
    url: z.string().refine((s) => s.includes("{name}"), { /* ... */ }),
    params: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
])
```

### コンポーネントの API 規約パターン

53 の UI コンポーネントが以下の規約に100% 準拠している。

**Props 型は `React.ComponentProps<>` で推論**: カスタム interface を定義せず、ラップ元の型を直接利用する。追加 props がある場合のみ交差型で拡張する。

```tsx
// apps/v4/registry/new-york-v4/ui/button.tsx:41-50
function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
```

**`data-slot` 属性の付与**: 全コンポーネントの全サブパーツに `data-slot="component-name"` を付与。CSS セレクタでの外部スタイリングを可能にする。329 箇所で使用されており、例外なく適用されている。

```tsx
// apps/v4/registry/new-york-v4/ui/card.tsx:8
<div data-slot="card" className={cn(/* ... */)} {...props} />
```

**関数宣言 + 末尾の named export**: `React.forwardRef` は一切使わず（React 19 対応）、通常の `function` 宣言で定義し、ファイル末尾で `export { }` する。

```tsx
// apps/v4/registry/new-york-v4/ui/card.tsx:84-92
export { Card, CardHeader, CardFooter, CardTitle, CardAction, CardDescription, CardContent }
```

### 後方互換性の維持戦略

`@deprecated` JSDoc アノテーションで非推奨関数を明示し、新 API への移行パスを示す。旧関数は内部で新関数を呼び出すアダプタとして実装される。

```typescript
// packages/shadcn/src/registry/api.ts:306-316
/**
 * @deprecated Use getRegistries() instead.
 */
export async function getRegistriesIndex(options?: { useCache?: boolean }) {
  const registries = await getRegistries(options)
  if (!registries) return null
  return Object.fromEntries(registries.map((r) => [r.name, r.url])) as z.infer<typeof registriesIndexSchema>
}
```

### エラー階層と構造化メタデータ

基底クラス `RegistryError` が `code`（enum 定数）、`statusCode`、`context`、`suggestion`、`timestamp` を持ち、11 個のサブクラスがドメイン固有のメッセージとサジェスチョンを提供する。`toJSON()` メソッドにより、MCP やログシステムでのシリアライズにも対応。

```typescript
// packages/shadcn/src/registry/errors.ts:4-27
export const RegistryErrorCode = {
  NETWORK_ERROR: "NETWORK_ERROR",
  NOT_FOUND: "NOT_FOUND",
  UNAUTHORIZED: "UNAUTHORIZED",
  // ...
} as const
```

```typescript
// packages/shadcn/src/registry/errors.ts:78-92
export class RegistryNotFoundError extends RegistryError {
  constructor(public readonly url: string, cause?: unknown) {
    super(message, {
      code: RegistryErrorCode.NOT_FOUND,
      statusCode: 404,
      cause,
      context: { url },
      suggestion: "Check if the item name is correct and the registry URL is accessible.",
    })
  }
}
```

## コード例

```typescript
// packages/shadcn/src/registry/fetcher.ts:61-109
// HTTP レスポンスのステータスコードに応じて型付きエラーに変換
if (response.status === 401) {
  throw new RegistryUnauthorizedError(url, messageFromServer)
}
if (response.status === 404) {
  throw new RegistryNotFoundError(url, messageFromServer)
}
if (response.status === 403) {
  throw new RegistryForbiddenError(url, messageFromServer)
}
throw new RegistryFetchError(url, response.status, messageFromServer)
```

```typescript
// packages/shadcn/src/registry/builder.ts:52-76
// registryConfigItemSchema の union 型を活用した URL 構築
export function buildUrlFromRegistryConfig(
  item: string,
  registryConfig: z.infer<typeof registryConfigItemSchema>,
  config?: Config
) {
  if (typeof registryConfig === "string") {
    let url = registryConfig.replace(NAME_PLACEHOLDER, item)
    // ...
    return expandEnvVars(url)
  }
  let baseUrl = registryConfig.url.replace(NAME_PLACEHOLDER, item)
  // ...
}
```

```tsx
// apps/v4/registry/new-york-v4/ui/dialog.tsx:50-82
// Radix プリミティブをラップし、data-slot + className マージで拡張する標準パターン
function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
}) {
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn("fixed top-[50%] ...", className)}
        {...props}
      >
        {children}
        {showCloseButton && (/* close button */)}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}
```

## パターンカタログ

- **Facade パターン** (分類: 構造)
  - 解決する問題: 内部の複雑なレジストリ解決・フェッチ・バリデーション処理を単純な API で隠蔽する
  - 適用条件: 内部モジュールが 10 以上あり、消費者に公開すべきは 5-6 関数のみという場合
  - コード例: `packages/shadcn/src/registry/index.ts` が `api.ts`, `search.ts`, `errors.ts` から選択的に再エクスポート
  - 注意点: Facade 経由でのみ利用を想定するなら、内部モジュールをサブパスエクスポートに含めないこと

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: レジストリ設定が「簡易文字列」か「詳細オブジェクト」かで URL 構築ロジックを切り替える
  - 適用条件: 同じ操作に対して複数の入力形式をサポートしたい場合
  - コード例: `packages/shadcn/src/registry/builder.ts:52-76` の `typeof registryConfig === "string"` による分岐
  - 注意点: Zod の union スキーマでバリデーション済みなので、ランタイムの型判定は安全に行える

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: エラーの共通フィールド（code, context, suggestion）は基底クラスで定義し、具体的なメッセージ生成はサブクラスに委譲する
  - 適用条件: エラーのカテゴリが 5 種以上あり、各カテゴリで異なるコンテキスト情報を持つ場合
  - コード例: `packages/shadcn/src/registry/errors.ts` の `RegistryError` と 11 サブクラス
  - 注意点: サブクラスが多くなりすぎると管理コストが上がるので、エラーコード enum との併用が効果的

## Good Patterns

- **Union スキーマによる段階的 API**: `registryConfigItemSchema` で簡易形式（文字列）と詳細形式（オブジェクト）を同一スキーマで受け入れる設計。初心者は文字列だけで始められ、認証が必要になったらオブジェクト形式に移行できる。

```typescript
// packages/shadcn/src/registry/schema.ts:6-19
export const registryConfigItemSchema = z.union([
  z.string().refine((s) => s.includes("{name}"), { /* ... */ }),
  z.object({
    url: z.string().refine((s) => s.includes("{name}"), { /* ... */ }),
    params: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
])
```

- **`data-slot` による安定的なセレクタ契約**: クラス名はユーティリティ CSS の都合で頻繁に変わるが、`data-slot` は意味的な識別子として安定させている。外部の消費者（テスト、スタイリング）が `[data-slot="card-header"]` で安定的に要素を特定できる。

```tsx
// apps/v4/registry/new-york-v4/ui/card.tsx:8
<div data-slot="card" className={cn("flex flex-col ...", className)} {...props} />
```

- **`React.ComponentProps<>` による Props 型の導出**: ラップ元コンポーネントの型を直接利用することで、型定義の重複を排除し、上流の型変更に自動追従する。53 コンポーネント・289 箇所で一貫して使用。

```tsx
// apps/v4/registry/new-york-v4/ui/tooltip.tsx:8-11
function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
```

- **エラーの `suggestion` フィールド**: エラーメッセージに加えて、ユーザーが次に何をすべきかの提案を構造化フィールドとして持たせる。CLI・MCP・プログラマティック利用それぞれが適切なフォーマットで表示できる。

```typescript
// packages/shadcn/src/registry/errors.ts:87-89
suggestion: "Check if the item name is correct and the registry URL is accessible.",
```

## Anti-Patterns / 注意点

- **index.ts からの `export *` 連鎖**: `src/schema/index.ts` → `../registry/schema` のように `export *` で再エクスポートすると、意図しないシンボルが公開 API に漏れるリスクがある。

```typescript
// Bad: 意図しないエクスポートの漏洩
export * from "../registry/schema"

// Better: 明示的な named re-export
export {
  registryItemSchema,
  registryConfigSchema,
  type RegistryItem,
  type Registry,
} from "../registry/schema"
```

- **`handleError` での `process.exit(1)` ハードコード**: CLI 用のエラーハンドラが `process.exit()` を呼ぶため、ライブラリとして利用する場合にプロセスが終了してしまう。CLI 専用のコードパスとライブラリ用のコードパスを分離すべき。

```typescript
// Bad: packages/shadcn/src/utils/handle-error.ts:17
process.exit(1)

// Better: エラーを throw して呼び出し元に制御を返す
throw error
```

## 導出ルール

- `[MUST]` 公開 API のエントリポイントでは、内部モジュールから選択的に re-export し、意図しないシンボルの漏洩を防ぐ
  - 根拠: `registry/index.ts` が `api.ts`, `search.ts`, `errors.ts` から必要な関数・クラスのみを明示的にエクスポートし、`builder.ts`, `fetcher.ts`, `resolver.ts`, `context.ts` 等の内部モジュールを隠蔽している

- `[MUST]` 外部入力（HTTP レスポンス・ファイル読み込み・ユーザー設定）は、API 境界で Zod 等のスキーマバリデーションを通してから内部処理に渡す
  - 根拠: `api.ts` の全 API 関数が `registrySchema.parse(result)` 等でランタイムバリデーションを行い、不正データの侵入を一律に防いでいる

- `[MUST]` ライブラリの構造化エラーには、マシンリーダブルなエラーコード（enum/const）と、ユーザー向けの `suggestion` フィールドを含める
  - 根拠: `RegistryError` の `code` + `suggestion` 設計により、CLI・MCP・プログラマティック利用がそれぞれ適切にエラーを処理・表示できている

- `[SHOULD]` 同一操作に対して複数の入力形式をサポートする場合、Zod の union/discriminated union で「簡易形式」と「詳細形式」を同一スキーマに統合する
  - 根拠: `registryConfigItemSchema` が文字列とオブジェクトの union で段階的な設定を実現し、初心者から上級者まで同じ API で対応している

- `[SHOULD]` React コンポーネントの Props 型は、ラップ元の `React.ComponentProps<>` から導出し、追加 props のみ交差型で拡張する（カスタム interface の独自定義を避ける）
  - 根拠: 53 コンポーネント・289 箇所で `React.ComponentProps<>` を一貫して使用し、上流の型変更への自動追従と型定義の重複排除を実現している

- `[SHOULD]` 非推奨 API は `@deprecated` JSDoc + 新 API を内部で呼び出すアダプタとして実装し、戻り値の型を旧 API に合わせた変換レイヤーを挟む
  - 根拠: `getRegistriesIndex()` が内部で `getRegistries()` を呼び出し、戻り値を `Record<string, string>` に変換して後方互換性を維持している

- `[SHOULD]` コンポーネントの各サブパーツに意味的な `data-*` 属性（例: `data-slot`）を付与し、クラス名とは独立した安定的なセレクタ契約を提供する
  - 根拠: 53 コンポーネント・329 箇所で `data-slot` を一貫して使用し、テスト・外部スタイリングの安定的な対象を提供している

- `[AVOID]` `export *` による再エクスポートで公開 API 境界を構成すること（内部シンボルの意図しない漏洩リスクがある）
  - 根拠: `schema/index.ts` の `export * from "../registry/schema"` は便利だが、スキーマファイルに内部用のヘルパーを追加した瞬間に公開 API に漏洩する

## 適用チェックリスト

- [ ] パッケージの `exports` フィールドで、消費者の関心レベルに応じたサブパスを定義しているか
- [ ] 公開 API のエントリポイント（index.ts）が明示的な named re-export のみで構成されているか（`export *` の連鎖がないか）
- [ ] 外部から受け取るデータに対して、API 境界でスキーマバリデーションを行っているか
- [ ] エラークラスにマシンリーダブルなコード（enum）と、ユーザー向けの次のアクション提案（suggestion）が含まれているか
- [ ] React コンポーネントの Props 型が `React.ComponentProps<>` からの導出になっているか（不要なカスタム interface がないか）
- [ ] コンポーネントのサブパーツに `data-slot` 等の安定的なセレクタ用属性が付与されているか
- [ ] 非推奨 API に `@deprecated` アノテーションと移行先の明示があるか
- [ ] 段階的な設定をサポートする場合、簡易形式と詳細形式を union スキーマで統合しているか
