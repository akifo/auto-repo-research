# 拡張性メカニズム (Extensibility Mechanisms)

> リポジトリ: shadcn-ui/ui
> 分析日: 2026-03-04

## 概要

shadcn/ui は「コンポーネントライブラリ」ではなく「コンポーネントレジストリ」として設計されている。その拡張性メカニズムは、`@`-prefixed namespace によるサードパーティレジストリ、URL テンプレート展開、環境変数による認証、プラグイン可能なアイコンライブラリ、スタイル継承、MCP サーバーを通じた AI エージェント連携など多層に渡る。注目すべきは、これらが単一の `components.json` 設定ファイルと Zod スキーマによる厳密な契約を中心に統合されている点である。

## 背景にある原則

- **Union 型で互換性を保ちつつ段階的に複雑さを導入する**: レジストリ設定は `string | { url, params?, headers? }` の Union 型で、単純なケースは文字列1つで完結し、認証が必要なケースのみオブジェクト形式を使う。これにより初期導入コストを最小化しつつ高度なユースケースにも対応する（`registryConfigItemSchema` の設計、`schema.ts:6-19`）。

- **Namespace で衝突を防ぎ、発見可能性を高める**: `@`-prefix を必須とすることで npm のスコープドパッケージと同じ直感で扱え、名前衝突を防ぎ、組み込みレジストリとサードパーティを明確に分離する（`schema.ts:21-26`、`parser.ts:2`）。

- **遅延バインディングで拡張ポイントを確保する**: URL テンプレート（`{name}`, `{style}`）と環境変数展開（`${VAR}`）を組み合わせ、レジストリ URL の解決を実行時まで遅延させる。これにより、同一設定で異なるスタイルや認証情報に対応できる（`builder.ts:11-13`、`env.ts:1-3`）。

- **エラーを型で分類し、リカバリー可能にする**: レジストリ操作のエラーを `RegistryError` 基底クラスから派生した専用クラスで分類し、各エラーに `code`、`suggestion`、`context` を付与する。これにより、呼び出し側が `instanceof` で分岐しつつ、ユーザーに具体的な修正手順を提示できる（`errors.ts:32-76`）。

## 実例と分析

### Namespace レジストリシステム

レジストリシステムの中核は `parseRegistryAndItemFromString` 関数で、`@namespace/item` 形式の文字列を解析する。正規表現 `^(@[a-zA-Z0-9](?:[a-zA-Z0-9-_]*[a-zA-Z0-9])?)\/(.+)$` により、namespace の先頭と末尾に英数字を強制し、中間にハイフン・アンダースコアを許容する。

この関数は codebase 全体で一貫して使用され、parser → builder → resolver → namespaces → search と伝播する。単一の解析関数を共有することで、namespace の解釈が分散しない設計になっている。

組み込みレジストリ `@shadcn` は `BUILTIN_REGISTRIES` 定数として定義され、ユーザーが上書きできないよう `configWithDefaults` でマージ時に先に展開される（`config.ts:34`）。

### URL テンプレート展開と認証

`buildUrlAndHeadersForRegistryItem` が展開の起点となる。名前付きプレースホルダー `{name}` と `{style}` を単純な文字列置換で展開し、環境変数 `${VAR}` は `expandEnvVars` で `process.env` から解決する。

認証ヘッダーの処理では、環境変数が未定義の場合にヘッダーを無視する `shouldIncludeHeader` 関数が巧妙に働く。テンプレート `"Bearer ${AUTH_TOKEN}"` に対して `AUTH_TOKEN` が未定義なら `"Bearer "` となるが、元のテンプレートから環境変数を除去した `"Bearer "` と一致するため、ヘッダー自体が送信されない。これにより認証情報の部分的な漏洩を防いでいる。

### リクエストスコープの認証コンテキスト

`context.ts` はモジュールレベルの変数でリクエストスコープの認証情報を管理する。`setRegistryHeaders` で URL ごとのヘッダーを設定し、`getRegistryHeadersFromContext` で fetcher が取得する。これにより、異なるレジストリが異なる認証情報を持てる。

### 依存関係の再帰的解決

`resolver.ts` の `resolveDependenciesRecursively` は、レジストリアイテム間の依存関係をクロスレジストリで再帰的に解決する。`@foo/dialog` が `@bar/button` に依存し、`@bar/button` が `@shadcn/tooltip` に依存するケースを正しく処理する。循環依存は `visited` Set で検出し、Kahn のアルゴリズムによるトポロジカルソートで安全な順序を保証する。

### Namespace の自動発見

`resolveRegistryNamespaces` は、指定されたコンポーネントとその依存ツリーを走査し、未設定の namespace を発見する。`ensureRegistriesInConfig`（`registries.ts`）はこの結果を中央レジストリインデックスと照合し、`components.json` に自動的に追加する。エラー時も発見は続行し（`catch` で `continue`）、最大限の情報を収集する設計。

### プラグイン可能なアイコンライブラリ

`iconLibraries`（`icons/libraries.ts`）は、各アイコンライブラリを `{ name, import, usage, packages, export }` の構造体で定義する。`transform-icons.ts` のトランスフォーマーは、`<IconPlaceholder lucide="ChevronRight" tabler="IconChevronRight" />` のような JSX を、設定されたアイコンライブラリに応じて実体に置換する。

これは AST レベルの変換パイプラインで、`transformers/index.ts` が一連のトランスフォーマーを順次適用する Chain of Responsibility パターンとして構成されている。

### MCP サーバーによる AI エージェント連携

`mcp/index.ts` は `@modelcontextprotocol/sdk` を使い、レジストリシステムを AI エージェントに公開する。`search_items_in_registries`、`view_items_in_registries`、`get_item_examples_from_registries` などのツールを定義し、AI がコンポーネントを検索・閲覧・インストールできる。入力スキーマは Zod → JSON Schema 変換で自動生成される。

## コード例

```typescript
// packages/shadcn/src/registry/parser.ts:2-14
const REGISTRY_PATTERN = /^(@[a-zA-Z0-9](?:[a-zA-Z0-9-_]*[a-zA-Z0-9])?)\/(.+)$/

export function parseRegistryAndItemFromString(name: string) {
  if (!name.startsWith("@")) {
    return { registry: null, item: name }
  }
  const match = name.match(REGISTRY_PATTERN)
  if (match) {
    return { registry: match[1], item: match[2] }
  }
  return { registry: null, item: name }
}
```

```typescript
// packages/shadcn/src/registry/schema.ts:6-26
export const registryConfigItemSchema = z.union([
  z.string().refine((s) => s.includes("{name}"), {
    message: "Registry URL must include {name} placeholder",
  }),
  z.object({
    url: z.string().refine((s) => s.includes("{name}"), {
      message: "Registry URL must include {name} placeholder",
    }),
    params: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
])

export const registryConfigSchema = z.record(
  z.string().refine((key) => key.startsWith("@"), {
    message: "Registry names must start with @ (e.g., @v0, @acme)",
  }),
  registryConfigItemSchema
)
```

```typescript
// packages/shadcn/src/registry/builder.ts:120-139
function shouldIncludeHeader(originalValue: string, expandedValue: string) {
  const trimmedExpanded = expandedValue.trim()
  if (!trimmedExpanded) { return false }
  if (originalValue.includes("${")) {
    const envVars = originalValue.match(ENV_VAR_PATTERN)
    if (envVars) {
      const templateWithoutVars = originalValue
        .replace(ENV_VAR_PATTERN, "")
        .trim()
      return trimmedExpanded !== templateWithoutVars
    }
  }
  return true
}
```

```typescript
// packages/shadcn/src/registry/config.ts:20-37
export function configWithDefaults(config?: DeepPartial<Config>) {
  const baseConfig = createConfig({
    style: FALLBACK_STYLE,
    registries: BUILTIN_REGISTRIES,
  })
  if (!config) { return baseConfig }
  return configSchema.parse(
    deepmerge(baseConfig, {
      ...config,
      style: resolveStyleFromConfig(config),
      registries: { ...BUILTIN_REGISTRIES, ...config.registries },
    })
  )
}
```

```typescript
// packages/shadcn/src/icons/libraries.ts:1-9
export const iconLibraries = {
  lucide: {
    name: "lucide",
    title: "Lucide",
    packages: ["lucide-react"],
    import: "import { ICON } from 'lucide-react'",
    usage: "<ICON />",
    export: "lucide-react",
  },
  // ... tabler, hugeicons, phosphor, remixicon
} as const
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: アイコンライブラリの差し替え
  - 適用条件: 同一インターフェース（`import`, `usage`）で複数の実装を切り替えたい場合
  - コード例: `icons/libraries.ts:1-43`、`transformers/transform-icons.ts:5-204`
  - 注意点: `iconLibraries` はコンパイル時定数（`as const`）であり、実行時に動的追加はできない。新しいライブラリの追加にはソースコード変更が必要

- **Chain of Responsibility パターン** (分類: 振る舞い)
  - 解決する問題: ファイル変換の段階的適用
  - 適用条件: 複数の独立した変換を順次適用する必要がある場合
  - コード例: `transformers/index.ts:42-71`
  - 注意点: トランスフォーマーの順序が重要（import 解決 → RSC 変換 → CSS 変数 → アイコン → クリーンアップ）

- **Registry パターン** (分類: 生成/構造)
  - 解決する問題: サードパーティによるコンポーネント配布
  - 適用条件: 分散した提供者からの成果物を統一的にインストール・管理したい場合
  - コード例: `registry/resolver.ts:37-109`、`registry/builder.ts:21-50`
  - 注意点: URL テンプレートに `{name}` プレースホルダーが必須。これが型レベルで `refine` により強制されている

## Good Patterns

- **Union 型による段階的な設定の複雑化**: `registryConfigItemSchema` は文字列とオブジェクトの Union 型で、簡単なケースは `"https://example.com/{name}.json"` の1行で済み、認証が必要なケースのみ `{ url, params, headers }` オブジェクトに切り替える。設定の 80% が文字列で済むため、エコシステム参入障壁が極めて低い。

```typescript
// packages/shadcn/src/registry/schema.ts:6-19
export const registryConfigItemSchema = z.union([
  z.string().refine((s) => s.includes("{name}"), { ... }),
  z.object({
    url: z.string().refine((s) => s.includes("{name}"), { ... }),
    params: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
])
```

- **エラーに修正提案を埋め込む**: 各 `RegistryError` サブクラスが `suggestion` フィールドを持ち、ユーザーに次のアクションを提示する。`RegistryNotConfiguredError` は `components.json` に追加すべき JSON スニペットをそのまま表示する。

```typescript
// packages/shadcn/src/registry/errors.ts:180-199
export class RegistryNotConfiguredError extends RegistryError {
  constructor(public readonly registryName: string | null) {
    const message = registryName
      ? `Unknown registry "${registryName}". Make sure it is defined in components.json as follows:
{
  "registries": {
    "${registryName}": "[URL_TO_REGISTRY]"
  }
}`
      : `Unknown registry. Make sure it is defined in components.json under "registries".`
    super(message, { code: RegistryErrorCode.NOT_CONFIGURED, suggestion: "Add the registry configuration to your components.json file." })
  }
}
```

- **認証情報の安全なフォールバック**: `shouldIncludeHeader` は環境変数が未定義の場合にヘッダーを静かにスキップする。これにより、`components.json` を共有しても認証なしのレジストリは正常動作し、認証が必要なレジストリだけが失敗する。

```typescript
// packages/shadcn/src/registry/builder.ts:120-139
function shouldIncludeHeader(originalValue: string, expandedValue: string) {
  const trimmedExpanded = expandedValue.trim()
  if (!trimmedExpanded) { return false }
  if (originalValue.includes("${")) {
    const envVars = originalValue.match(ENV_VAR_PATTERN)
    if (envVars) {
      const templateWithoutVars = originalValue.replace(ENV_VAR_PATTERN, "").trim()
      return trimmedExpanded !== templateWithoutVars
    }
  }
  return true
}
```

## Anti-Patterns / 注意点

- **モジュールスコープのミュータブルコンテキスト**: `context.ts` のリクエストヘッダーはモジュールレベル変数で管理されており、同時実行時にレースコンディションの可能性がある。CLI ツールとしては問題ないが、サーバー環境やテスト並列実行では注意が必要。

```typescript
// Bad: packages/shadcn/src/registry/context.ts:1-7
let context: RegistryContext = { headers: {} }
export function setRegistryHeaders(headers: Record<string, Record<string, string>>) {
  context.headers = { ...context.headers, ...headers }
}
```

```typescript
// Better: AsyncLocalStorage や引数渡しでスコープを明示する
import { AsyncLocalStorage } from "node:async_hooks"
const registryStorage = new AsyncLocalStorage<RegistryContext>()
export function withRegistryContext<T>(context: RegistryContext, fn: () => T) {
  return registryStorage.run(context, fn)
}
```

- **アイコンライブラリのハードコード**: `iconLibraries` は `as const` で定義されており、サードパーティがアイコンライブラリを追加するには本体のソースコードを変更する必要がある。レジストリシステムの柔軟性と対照的に、アイコンは閉じた拡張ポイントとなっている。

```typescript
// Bad: 拡張不可の定数
export const iconLibraries = { lucide: { ... }, tabler: { ... } } as const
```

```typescript
// Better: レジストリ同様に設定から読み込む
const iconLibrarySchema = z.object({
  name: z.string(), import: z.string(), usage: z.string(), packages: z.array(z.string()),
})
// components.json の iconLibraries フィールドから動的に読み込む
```

## 導出ルール

- `[MUST]` 拡張ポイントの設定スキーマは Union 型（`string | object`）で「シンプルモード」と「詳細モード」を提供し、段階的に複雑さを導入する
  - 根拠: `registryConfigItemSchema` が文字列とオブジェクトの Union 型を採用し、サードパーティの参入障壁を最小化している（`schema.ts:6-19`）

- `[MUST]` サードパーティが提供するリソースの識別子には namespace プレフィックスを必須とし、名前衝突と組み込みリソースの区別を保証する
  - 根拠: `@`-prefix と `REGISTRY_PATTERN` により、`@shadcn/button` と `@acme/button` が衝突しない設計が実現されている（`parser.ts:2`、`schema.ts:21-26`）

- `[SHOULD]` エラーオブジェクトに `suggestion` フィールドを含め、ユーザーが次に取るべきアクションを具体的に提示する
  - 根拠: 全ての `RegistryError` サブクラスが `suggestion` を持ち、`RegistryNotConfiguredError` は修正用の JSON スニペットをそのまま提示する（`errors.ts:180-199`）

- `[SHOULD]` URL や設定値に含まれる環境変数は遅延展開し、未定義の変数は安全にフォールバックさせる（エラーではなくスキップ）
  - 根拠: `shouldIncludeHeader` が未設定の環境変数を含むヘッダーを静かにスキップし、認証情報の部分漏洩を防いでいる（`builder.ts:120-139`）

- `[SHOULD]` 依存関係の再帰的解決では、エラーが発生しても走査を継続し、発見可能な情報を最大化する
  - 根拠: `resolveRegistryNamespaces` が `RegistryNotConfiguredError` を catch して namespace を記録しつつ走査を継続する（`namespaces.ts:46-58`）

- `[AVOID]` 拡張ポイントを `as const` 定数や列挙型でハードコードする — レジストリや設定ファイルから動的に読み込む設計にする
  - 根拠: `iconLibraries` が `as const` で定義されているため、サードパーティがアイコンライブラリを追加するにはソースコード変更が必要になっている（`icons/libraries.ts:1-43`）

- `[AVOID]` 認証コンテキストをモジュールスコープのミュータブル変数で管理する — 関数引数または AsyncLocalStorage を使い、スコープを明示する
  - 根拠: `context.ts` のモジュールレベル変数は CLI では問題ないが、テスト並列実行やサーバー環境でレースコンディションのリスクがある（`context.ts:1-7`）

## 適用チェックリスト

- [ ] 拡張ポイントの設定スキーマが「シンプルモード」（文字列）と「詳細モード」（オブジェクト）の Union 型になっているか
- [ ] サードパーティリソースの識別子に namespace プレフィックスまたはスコープが付与されているか
- [ ] エラーメッセージに修正手順（`suggestion`）が含まれているか
- [ ] 設定値内の環境変数が遅延展開され、未定義時に安全にフォールバックするか
- [ ] 依存関係の再帰的解決で、部分的なエラーが全体を停止させないか
- [ ] 拡張ポイントが定数ではなく設定から動的に読み込まれるか
- [ ] 認証コンテキストが適切なスコープ（リクエスト単位・関数引数）で管理されているか
- [ ] Zod スキーマが拡張ポイントの契約として定義され、型安全性が保証されているか
