# Registry Distribution Architecture

> リポジトリ: shadcn-ui/ui
> 分析日: 2026-03-04

## 概要

shadcn/ui のレジストリシステムは、コンポーネントを npm パッケージとしてではなく JSON マニフェストとして配布する「コード配布プラットフォーム」を実現している。namespace によるマルチレジストリ、Zod スキーマによる厳密なバリデーション、依存関係のトポロジカルソートによるインストール順序保証、環境変数展開による認証付きプライベートレジストリなど、パッケージマネージャに匹敵するアーキテクチャを独自に構築している点が注目に値する。

## 背景にある原則

- **所有権のあるコード配布 (Code Ownership Distribution)**: npm パッケージのようにブラックボックスな依存関係としてではなく、ソースコードをユーザーのプロジェクトにコピーすることで、完全な所有権と改変の自由を提供する。レジストリアイテムの JSON には `content` フィールドにソースコードそのものが格納される（`packages/shadcn/src/commands/registry/build.ts:126-133`）。

- **スキーマ駆動のプロトコル設計 (Schema-Driven Protocol)**: レジストリアイテムの構造を Zod の `discriminatedUnion` で厳密に定義し、型によって必須フィールドを変える。`registry:file` と `registry:page` は `target` が必須、`registry:base` は `config` フィールドを持ち、`registry:font` は `font` フィールドを持つ（`packages/shadcn/src/registry/schema.ts:92-181`）。この設計により、サードパーティレジストリも同一プロトコルで相互運用できる。

- **Namespace による連邦型レジストリ (Federated Registry via Namespace)**: `@shadcn`, `@v0`, `@acme` のような namespace で複数のレジストリを統一的に扱う。各 namespace は独立した URL テンプレートを持ち、`{name}` プレースホルダで個別アイテムを解決する（`packages/shadcn/src/registry/builder.ts:52-76`）。

- **段階的フォールバックの解決戦略 (Progressive Resolution)**: アイテム指定子をローカルファイル → URL → namespace → デフォルトレジストリの順で解決する。この優先順位により、開発中のローカルアイテム、外部 URL、組織内レジストリ、公式レジストリが共存できる（`packages/shadcn/src/registry/resolver.ts:68-109`）。

## 実例と分析

### Namespace とレジストリ解決

レジストリシステムの中核は `parseRegistryAndItemFromString` による namespace 分離と `buildUrlAndHeadersForRegistryItem` による URL 構築である。

`@acme/button` のような文字列は正規表現 `^(@[a-zA-Z0-9](?:[a-zA-Z0-9-_]*[a-zA-Z0-9])?)\/(.+)$` でパースされ、registry=`@acme`, item=`button` に分離される（`packages/shadcn/src/registry/parser.ts:2-24`）。

builder は namespace を受け取り、ビルトインレジストリ（`@shadcn`）とユーザー定義レジストリ（`components.json` の `registries` フィールド）をマージして URL テンプレートを解決する。namespace が未指定の場合はデフォルトで `@shadcn` にフォールバックする（`packages/shadcn/src/registry/builder.ts:29-34`）。

```
// packages/shadcn/src/registry/builder.ts:29-34
if (!registry) {
  if (isUrl(name) || isLocalFile(name) || isLocalPath(name)) {
    return null
  }
  registry = "@shadcn"
}
```

### 依存関係の再帰的解決とトポロジカルソート

`resolveRegistryTree` はレジストリアイテムとそのすべての依存関係を再帰的に取得し、インストールバンドルを構築する。特筆すべきは Kahn's algorithm によるトポロジカルソートで、依存関係が依存元より先に処理されることを保証している（`packages/shadcn/src/registry/resolver.ts:622-743`）。

循環依存を検出した場合は警告を出力しつつ、ソートされなかったアイテムを末尾に追加して処理を続行する。致命的エラーにせず graceful に対処する設計である。

```
// packages/shadcn/src/registry/resolver.ts:722-739
if (sorted.length !== items.length) {
  console.warn("Circular dependency detected in registry items")
  const sortedHashes = new Set(
    sorted.map((item) => {
      const source = sourceMap.get(item) || item.name
      return computeItemHash(item, source)
    })
  )
  items.forEach((item) => {
    const source = sourceMap.get(item) || item.name
    const hash = computeItemHash(item, source)
    if (!sortedHashes.has(hash)) {
      sorted.push(item)
    }
  })
}
```

### 認証付きプライベートレジストリ

レジストリ設定は単純な URL 文字列と、ヘッダー・パラメータ付きのオブジェクト形式の2パターンをサポートする（`packages/shadcn/src/registry/schema.ts:6-19`）。

```
// packages/shadcn/src/registry/schema.ts:6-19
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
```

環境変数は `${VAR_NAME}` 構文で埋め込まれ、`expandEnvVars` で実行時に展開される（`packages/shadcn/src/registry/env.ts:1-3`）。validator はレジストリ設定から必要な環境変数を抽出し、未設定のものがあれば `RegistryMissingEnvironmentVariablesError` をスローする（`packages/shadcn/src/registry/validator.ts:36-46`）。

### Request Context によるヘッダー伝播

認証ヘッダーは `RegistryContext` というモジュールレベルのシングルトンで管理される（`packages/shadcn/src/registry/context.ts`）。URL ごとにヘッダーをマッピングし、`fetchRegistry` が適切なヘッダーを付与する。ネストした依存関係の解決時にもヘッダーがマージされ、異なるレジストリの認証情報が混在しない仕組みになっている。

```
// packages/shadcn/src/registry/context.ts:9-14
export function setRegistryHeaders(
  headers: Record<string, Record<string, string>>
) {
  context.headers = { ...context.headers, ...headers }
}
```

### Promise-based キャッシュ

fetcher は Promise そのものをキャッシュに格納する設計を採用している（`packages/shadcn/src/registry/fetcher.ts:50-51`）。同一 URL に対する同時リクエストが発生した場合、最初の Promise を共有することで重複リクエストを防止する。これは単純な結果キャッシュよりも race condition に強い。

```
// packages/shadcn/src/registry/fetcher.ts:44-51
if (options.useCache && registryCache.has(url)) {
  return registryCache.get(url)
}
const fetchPromise = (async () => {
  // ...
})()
if (options.useCache) {
  registryCache.set(url, fetchPromise)
}
```

### Build コマンドによるレジストリ公開

`registry:build` コマンドは `registry.json` マニフェストからソースファイルのインポートを再帰的に解析し、各アイテムの依存関係と関連ファイルを自動解決して JSON ファイルを生成する（`packages/shadcn/src/commands/registry/build.ts:185-219`）。ファイルの `content` フィールドにソースコードが埋め込まれ、`./public/r/` に出力される。サードパーティ開発者は自分のレジストリを同じ形式で公開できる。

### discriminatedUnion による型ごとのファイル配置

レジストリアイテムの `type` フィールドがインストール先ディレクトリを決定する。`registry:ui` は `ui/` ディレクトリ、`registry:lib` は `lib/`、`registry:hook` は `hooks/`、`registry:page` と `registry:file` は `target` で指定した任意のパスに配置される（`packages/shadcn/src/registry/utils.ts:233-252`）。

ブロック（`registry:block`）のような複合アイテムは、1つのレジストリアイテムに複数の型のファイルを含めることで、ページ・コンポーネント・データファイルを一括インストールできる（`apps/v4/registry/new-york-v4/blocks/_registry.ts:38-60`）。

### 自動レジストリ発見

`ensureRegistriesInConfig` は、ユーザーが `@acme/button` を指定した際に `@acme` レジストリが `components.json` に未登録であれば、中央の `registries.json` からそのレジストリの URL を自動取得し、設定ファイルに書き込む（`packages/shadcn/src/utils/registries.ts:10-101`）。パッケージマネージャにおけるレジストリ自動解決に相当する仕組みである。

## コード例

```typescript
// packages/shadcn/src/registry/resolver.ts:68-109
// 4段階のフォールバック解決: ローカル → URL → namespace → デフォルト
export async function fetchRegistryItems(
  items: string[],
  config: Config,
  options: { useCache?: boolean; } = {},
) {
  const results = await Promise.all(
    items.map(async (item) => {
      if (isLocalFile(item)) {
        return fetchRegistryLocal(item);
      }
      if (isUrl(item)) {
        const [result] = await fetchRegistry([item], options);
        return registryItemSchema.parse(result);
      }
      if (item.startsWith("@") && config?.registries) {
        const paths = resolveRegistryItemsFromRegistries([item], config);
        const [result] = await fetchRegistry(paths, options);
        return registryItemSchema.parse(result);
      }
      // デフォルト: @shadcn レジストリ
      const path = `styles/${config?.style ?? "new-york-v4"}/${item}.json`;
      const [result] = await fetchRegistry([path], options);
      return registryItemSchema.parse(result);
    }),
  );
  return results;
}
```

```typescript
// packages/shadcn/src/registry/schema.ts:168-181
// discriminatedUnion でアイテム型ごとに異なるフィールドを要求
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
]);
```

```typescript
// packages/shadcn/src/registry/constants.ts:33-35
// ビルトインレジストリ: 常に利用可能で上書き不可
export const BUILTIN_REGISTRIES: z.infer<typeof registryConfigSchema> = {
  "@shadcn": `${REGISTRY_URL}/styles/{style}/{name}.json`,
};
```

```typescript
// packages/shadcn/src/registry/errors.ts:32-76
// エラー階層: RegistryError 基底クラスに code, statusCode, suggestion を持たせる
export class RegistryError extends Error {
  public readonly code: RegistryErrorCode;
  public readonly statusCode?: number;
  public readonly suggestion?: string;
  public readonly timestamp: Date;

  constructor(message: string, options: {
    code?: RegistryErrorCode;
    statusCode?: number;
    cause?: unknown;
    context?: Record<string, unknown>;
    suggestion?: string;
  } = {}) {
    super(message);
    this.code = options.code || RegistryErrorCode.UNKNOWN_ERROR;
    this.statusCode = options.statusCode;
    this.suggestion = options.suggestion;
    this.timestamp = new Date();
  }
}
```

## パターンカタログ

- **Chain of Responsibility** (分類: 振る舞い)
  - 解決する問題: アイテム指定子（ローカルファイル、URL、namespace、プレーン名）に応じて異なる取得方法を適用する必要がある
  - 適用条件: 入力形式が多様で、それぞれ異なる処理パイプラインが必要な場合
  - コード例: `packages/shadcn/src/registry/resolver.ts:68-109`
  - 注意点: フォールバック順序の変更が挙動に大きく影響する。デフォルト（最後のフォールバック）を明示的に定義すること

- **Registry パターン** (分類: 生成)
  - 解決する問題: 分散したコンポーネント定義を統一的なインターフェースで検索・取得する
  - 適用条件: プラグインやモジュールの動的な登録・発見が必要な場合
  - コード例: `packages/shadcn/src/registry/api.ts:43-92`（`getRegistry`）
  - 注意点: レジストリの中央インデックスがボトルネックにならないよう、キャッシュと分散を考慮する

- **Builder パターン** (分類: 生成)
  - 解決する問題: URL テンプレート、認証ヘッダー、クエリパラメータの組み立てを段階的に行う
  - 適用条件: 多数のオプショナルな構成要素から複雑なオブジェクトを構築する場合
  - コード例: `packages/shadcn/src/registry/builder.ts:21-49`（`buildUrlAndHeadersForRegistryItem`）
  - 注意点: 環境変数展開のタイミングに注意。ビルド時ではなく実行時に展開する必要がある

- **Topological Sort** (分類: グラフアルゴリズム)
  - 解決する問題: 依存関係のあるアイテム群を、依存先が先に処理される順序で並べる
  - 適用条件: DAG（有向非巡回グラフ）構造の依存関係を持つリソースのインストール順序が重要な場合
  - コード例: `packages/shadcn/src/registry/resolver.ts:622-743`（Kahn's algorithm）
  - 注意点: 循環依存の検出と graceful な回復が必須。silent failure にしない

## Good Patterns

- **Promise キャッシュによる重複リクエスト排除**: 結果ではなく Promise そのものをキャッシュに格納することで、同一 URL への同時リクエストを1つの HTTP リクエストに統合する。`await` の前にキャッシュに登録するのがポイント。

```typescript
// packages/shadcn/src/registry/fetcher.ts:44-51
if (options.useCache && registryCache.has(url)) {
  return registryCache.get(url); // 既に実行中の Promise を返す
}
const fetchPromise = (async () => {/* fetch logic */})();
if (options.useCache) {
  registryCache.set(url, fetchPromise); // 完了を待たずにキャッシュ
}
return fetchPromise;
```

- **エラーに suggestion フィールドを持たせる**: 各エラークラスが `suggestion` プロパティで具体的な解決策を提示する。CLI ツールやエディタ統合がユーザーに actionable なガイダンスを表示できる。

```typescript
// packages/shadcn/src/registry/errors.ts:86-89
suggestion:
  "Check if the item name is correct and the registry URL is accessible.",
```

- **discriminatedUnion で型に応じた必須フィールドを制御**: Zod の `discriminatedUnion` を使い、`type` フィールドの値によって `target`（`registry:file`）、`config`（`registry:base`）、`font`（`registry:font`）の必須/任意を切り替える。型安全性とバリデーションを同時に実現する。

```typescript
// packages/shadcn/src/registry/schema.ts:92-106
export const registryItemFileSchema = z.discriminatedUnion("type", [
  z.object({
    path: z.string(),
    type: z.enum(["registry:file", "registry:page"]),
    target: z.string(), // 必須
  }),
  z.object({
    path: z.string(),
    type: registryItemTypeSchema.exclude(["registry:file", "registry:page"]),
    target: z.string().optional(), // 任意
  }),
]);
```

- **ビルトインレジストリの上書き保護**: `BUILTIN_REGISTRIES` を `const` 定義し、ユーザー設定とマージする際にビルトインを先に展開する（`{ ...BUILTIN_REGISTRIES, ...config?.registries }`）。`registry:add` コマンドではビルトイン namespace の追加を明示的にスキップする（`packages/shadcn/src/commands/registry/add.ts:105-109`）。

- **Universal Registry Item によるフレームワーク非依存インストール**: `isUniversalRegistryItem` で `registry:item` / `registry:file` 型かつ全ファイルに `target` が設定されているアイテムを判定し、`components.json` やフレームワーク検出をスキップしてインストールする（`packages/shadcn/src/registry/utils.ts:274-300`、`packages/shadcn/src/commands/add.ts:104-107`）。

## Anti-Patterns / 注意点

- **モジュールレベルのミュータブルシングルトン**: `RegistryContext` はモジュールスコープの `let context` で状態を管理しており、`clearRegistryContext()` で手動クリーンアップが必要。`add` コマンドの `finally` ブロックでクリアしているが、クリア漏れは異なるオペレーション間でヘッダーが漏洩するリスクがある。

```typescript
// Bad: モジュールレベルの状態に依存
let context: RegistryContext = { headers: {} }

// Better: 関数パラメータでコンテキストを渡す
async function fetchRegistryItems(
  items: string[],
  config: Config,
  context: RegistryContext,  // 明示的に渡す
) { ... }
```

- **Cache invalidation なしの永続キャッシュ**: `registryCache` は `Map` で、TTL やサイズ制限がない。長時間実行するプロセス（MCP サーバーなど）ではメモリリークの原因になりうる。`clearRegistryCache()` は公開されているが、呼び出しはユーザーの責任。

```typescript
// Bad: 際限なく成長する Map キャッシュ
const registryCache = new Map<string, Promise<any>>();

// Better: TTL 付きキャッシュまたは LRU キャッシュ
const registryCache = new LRUCache<string, Promise<any>>({
  max: 500,
  ttl: 1000 * 60 * 5, // 5 minutes
});
```

## 導出ルール

- `[MUST]` コード配布レジストリのアイテムスキーマは Zod の discriminatedUnion で型ごとに必須フィールドを定義し、parse 時に構造的バリデーションを行うこと
  - 根拠: shadcn/ui は `registryItemSchema` と `registryItemFileSchema` で 12 種類のアイテム型を discriminatedUnion で管理し、`registry:file` は `target` 必須、`registry:font` は `font` 必須とする等の制約をスキーマレベルで保証している。型に応じたフィールド差異を if/else でバリデーションするとスキーマの進化に追従できない

- `[MUST]` 複数のリソースソース（ローカル、URL、namespace、デフォルト）をフォールバックチェーンとして設計する場合、解決関数の冒頭で入力形式を判定し、最も具体的なソースから順に試行すること
  - 根拠: `fetchRegistryItems` はローカルファイル → URL → namespace → デフォルトの順で解決し、各段階で `return` して早期脱出する。順序を逆にするとローカルの上書きが効かなくなる

- `[MUST]` エラークラスにマシンリーダブルなエラーコード（enum）とユーザー向け suggestion を持たせること
  - 根拠: `RegistryError` 階層は `RegistryErrorCode` enum でプログラム的なエラーハンドリングを可能にし、`suggestion` フィールドで CLI 出力やエディタ統合に具体的な修正方法を提示する。13 種類のエラーすべてがこのパターンに従っている

- `[SHOULD]` HTTP リクエストのキャッシュは結果ではなく Promise をキャッシュすることで、同一リソースへの同時リクエストを統合すること
  - 根拠: `fetchRegistry` は `fetchPromise` を `await` 前にキャッシュに登録し、複数の `resolveRegistryTree` 呼び出しが同一 URL をフェッチする際に HTTP リクエストを1回に削減している

- `[SHOULD]` レジストリの namespace 設計では、ビルトイン namespace をハードコードし、ユーザー定義 namespace とのマージ時にビルトインが上書きされない保護を設けること
  - 根拠: `BUILTIN_REGISTRIES` は `@shadcn` のみを定義し、マージは `{ ...BUILTIN_REGISTRIES, ...config?.registries }` の順序で行う。`registry:add` コマンドではビルトイン namespace の追加をブロックする

- `[SHOULD]` 依存関係のトポロジカルソートで循環依存を検出した場合、致命的エラーではなく警告を出力し、未ソートのアイテムを末尾に追加して処理を続行すること
  - 根拠: `topologicalSortRegistryItems` は `sorted.length !== items.length` で循環を検出し、`console.warn` の後にソートされなかったアイテムを追加する。コンポーネント追加が循環依存で完全に失敗するよりも、不完全でもインストールできる方がユーザー体験が良い

- `[AVOID]` モジュールレベルのミュータブル状態でリクエストコンテキスト（認証ヘッダー等）を管理すること。手動クリーンアップの漏れにより、セキュリティ上の問題（ヘッダー漏洩）が起こりうる
  - 根拠: `RegistryContext` はモジュールスコープの `let` 変数で、`clearRegistryContext()` の呼び忘れでヘッダーが次のオペレーションに漏洩するリスクがある。関数パラメータまたはリクエストスコープのコンテキストオブジェクトで渡す方が安全

## 適用チェックリスト

- [ ] レジストリアイテムのスキーマを Zod で定義し、`discriminatedUnion` で型ごとの必須フィールドを区別しているか
- [ ] アイテム解決時に複数ソース（ローカル → URL → namespace → デフォルト）のフォールバックチェーンを設計しているか
- [ ] レジストリの namespace を `@` プレフィックスで統一し、パーサーが `@namespace/item` を分離できるか
- [ ] URL テンプレートに `{name}` プレースホルダを使い、アイテム名で動的に URL を構築しているか
- [ ] 環境変数展開（`${VAR_NAME}`）をサポートし、未設定時に具体的なエラーメッセージを出しているか
- [ ] HTTP フェッチに Promise キャッシュを導入し、同一 URL への並行リクエストを統合しているか
- [ ] 依存関係のトポロジカルソートを実装し、循環依存を検出してもプロセスを停止しない回復策があるか
- [ ] エラークラスに `code`（プログラム的ハンドリング用）と `suggestion`（ユーザー向けガイダンス）を持たせているか
- [ ] ビルトインレジストリ（デフォルトソース）がユーザー設定で上書きされない保護を設けているか
- [ ] `registry:build` のような公開コマンドで、ソースコードからレジストリ JSON を自動生成できるか
