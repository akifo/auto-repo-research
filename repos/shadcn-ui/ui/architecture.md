# architecture

> リポジトリ: shadcn-ui/ui
> 分析日: 2026-03-04

## 概要

shadcn/ui の CLI (`packages/shadcn`) は、リモートレジストリからコンポーネント定義を取得し、ユーザーのプロジェクトに合わせてコード変換を施した上でファイルとして書き出す「コード配布パイプライン」を実装している。CLI → Preflight → Registry (Fetch/Resolve) → Transformer → Updater という明確なレイヤー分離があり、各レイヤーが単方向の依存で接続されている点が注目に値する。特に、Registry 層が JSON スキーマでデータ境界を定義し、Transformer 層が AST ベースの直列パイプラインでコードを適応させるアーキテクチャは、「外部ソースから取得したコードをローカル環境に適応させる」汎用的なパターンとして応用できる。

## 背景にある原則

- **Boundary-Driven Layer Isolation（スキーマ境界によるレイヤー分離）**: 各レイヤー間のデータ受け渡しに Zod スキーマを挟むことで、実行時型安全性とレイヤーの独立性を同時に確保すべき。Registry から返るデータは `registryItemSchema` で検証され、解決後の依存ツリーは `registryResolvedItemsTreeSchema` で再検証される。これにより、上流の変更が下流に伝播する前に必ずバリデーションを通過する（`packages/shadcn/src/registry/schema.ts`、`resolver.ts:346`）。

- **Fail-Fast with Preflight Checks（プリフライトチェックによる早期失敗）**: パイプラインの本質的な処理（ネットワーク通信、ファイル書き込み）を開始する前に、環境前提条件を独立したフェーズで検証すべき。`preflights/` モジュールがこの責務を担い、`components.json` の存在・プロジェクトディレクトリの有効性・フレームワーク検出を事前に行う（`preflights/preflight-add.ts`）。

- **Adapter over Abstraction（抽象化より適応変換）**: コンポーネントコードの互換性問題を抽象レイヤーで隠蔽するのではなく、具体的な AST 変換で解決すべき。Transformer 層は各変換を個別の関数として実装し、順序付きパイプラインで合成する。これにより、変換ロジックの追加・削除が他の変換に影響しない（`utils/transformers/index.ts:44-51`）。

- **Context as Ambient State, Config as Explicit Parameter（コンテキストは暗黙、設定は明示）**: 認証ヘッダーのようなリクエストスコープの横断的関心事はモジュールスコープの状態で管理し、ビジネスロジックに必要な設定は明示的パラメータとして渡すべき。`registry/context.ts` がヘッダー管理を担い、`Config` 型はすべての関数に明示的に渡される（`registry/context.ts:1-24`）。

## 実例と分析

### パイプラインの全体像と依存方向

`add` コマンドを起点として、データの流れは以下の単方向パイプラインを形成する:

```
CLI Command (add.ts)
  → Preflight (preflight-add.ts)
  → Registry Resolve (resolver.ts → fetcher.ts → builder.ts)
  → add-components.ts (オーケストレーション)
    → Transformer Pipeline (transformers/index.ts)
    → Updaters (update-files.ts, update-css-vars.ts, update-dependencies.ts, ...)
```

重要な点は、下流のレイヤーが上流を参照しないこと。Transformer は Registry のことを知らず、Updater は Transformer のことを知らない。各レイヤーは入力データの型（Zod スキーマ）のみに依存する。

### Registry 層の多重解決メカニズム

Registry 層は単なるフェッチャーではなく、名前空間解決・依存解決・トポロジカルソートを含む複合的な解決エンジンとして機能する。

1. **名前空間パーサー**: `@registry/item` 形式の文字列を分解する（`parser.ts`）
2. **URL ビルダー**: 名前空間 + 設定からフェッチ URL とヘッダーを構築する（`builder.ts`）
3. **フェッチャー**: Promise ベースのキャッシュ付き HTTP クライアント（`fetcher.ts`）
4. **リゾルバー**: 再帰的依存解決 + Kahn のアルゴリズムによるトポロジカルソート（`resolver.ts`）

各段階で Zod によるスキーマ検証が入り、不正なレジストリアイテムが下流に到達することを防いでいる。

### Transformer パイプラインの合成モデル

`transform()` 関数はデフォルトの変換チェーンを持ちつつ、呼び出し元が変換リストを上書きできる設計になっている。

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

`update-files.ts` では、コンテキストに応じてデフォルトとは異なる変換チェーンを渡している。例えば `transformMenu`、`transformAsChild`、`transformNext` が条件付きで追加される:

```typescript
// packages/shadcn/src/utils/updaters/update-files.ts:145-158
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
```

各 Transformer は `(opts: TransformOpts & { sourceFile: SourceFile }) => Promise<SourceFile>` という統一シグネチャを持ち、ts-morph の SourceFile を in-place で変換する。

### Updater 層のオーケストレーション

`add-components.ts` が Updater のオーケストレーターとして機能し、解決済みツリーの各フィールドを対応する Updater に振り分ける:

```typescript
// packages/shadcn/src/utils/add-components.ts:105-141
await updateTailwindConfig(tree.tailwind?.config, config, {...})
await updateCssVars(tree.cssVars, config, {...})
await updateCss(tree.css, config, {...})
await updateEnvVars(tree.envVars, config, {...})
await updateDependencies(tree.dependencies, tree.devDependencies, config, {...})
await updateFonts(tree.fonts, config, {...})
await updateFiles(tree.files, config, {...})
```

各 Updater は独立しており、特定のファイル種別（CSS、依存関係、設定ファイル、ソースコード）のみを扱う。`updateFiles` だけが内部で Transformer パイプラインを呼び出し、ソースコードの変換を行う。

### エラー階層の設計

Registry 層は `RegistryError` 基底クラスから派生した特化エラークラス群を持ち、各エラーが `code`（列挙値）、`statusCode`（HTTP）、`context`（デバッグ情報）、`suggestion`（ユーザー向けガイド）を持つ:

```typescript
// packages/shadcn/src/registry/errors.ts:32-76
export class RegistryError extends Error {
  public readonly code: RegistryErrorCode
  public readonly statusCode?: number
  public readonly context?: Record<string, unknown>
  public readonly suggestion?: string
  public readonly timestamp: Date
  public readonly cause?: unknown
}
```

これにより、エラーハンドリング側が `code` でプログラム的に分岐し、`suggestion` でユーザーにアクション可能なメッセージを出せる。

## コード例

```typescript
// packages/shadcn/src/registry/resolver.ts:124-137
// 依存解決のエントリポイント: 名前の一意化 → フェッチ → ソースマップ付きペイロード構築
export async function resolveRegistryTree(
  names: z.infer<typeof registryItemSchema>["name"][],
  config: Config,
  options: { useCache?: boolean } = {}
) {
  // ...
  const uniqueNames = Array.from(new Set(names))
  const results = await fetchRegistryItems(uniqueNames, config, options)
  // ...
}
```

```typescript
// packages/shadcn/src/registry/fetcher.ts:24-50
// Promise キャッシュ: 同一 URL の重複リクエストを防ぐ（Promise 自体をキャッシュ）
const registryCache = new Map<string, Promise<any>>()

export async function fetchRegistry(paths: string[], options: { useCache?: boolean } = {}) {
  // ...
  const results = await Promise.all(
    paths.map(async (path) => {
      const url = resolveRegistryUrl(path)
      if (options.useCache && registryCache.has(url)) {
        return registryCache.get(url)
      }
      const fetchPromise = (async () => {
        const headers = getRegistryHeadersFromContext(url)
        const response = await fetch(url, { agent, headers: { ...headers } })
        // ...
      })()
      if (options.useCache) {
        registryCache.set(url, fetchPromise)
      }
      return fetchPromise
    })
  )
}
```

```typescript
// packages/shadcn/src/utils/is-safe-target.ts:3-98
// パストラバーサル対策: URL エンコード、null バイト、Windows ドライブレター等を多段階で検証
export function isSafeTarget(targetPath: string, cwd: string): boolean {
  if (targetPath.includes("\0")) return false
  let decodedPath = targetPath
  let prevPath = ""
  while (decodedPath !== prevPath && decodedPath.includes("%")) {
    prevPath = decodedPath
    decodedPath = decodeURIComponent(decodedPath)
  }
  // ...多段階の検証が続く
}
```

## パターンカタログ

- **Pipeline / Pipes and Filters** (分類: アーキテクチャ)
  - 解決する問題: 外部から取得したコードをローカル環境に合わせて段階的に適応させる必要がある
  - 適用条件: 各変換が独立しており、順序を制御したい場合
  - コード例: `packages/shadcn/src/utils/transformers/index.ts:42-71`
  - 注意点: 変換の順序が意味を持つ（import 解決は先、cleanup は最後）。順序依存がドキュメント化されていないと保守が困難になる

- **Resolver / Dependency Graph** (分類: 構造)
  - 解決する問題: レジストリアイテム間の依存関係を再帰的に解決し、循環参照を検知する
  - 適用条件: アイテムが他のアイテムに依存し、インストール順序が重要な場合
  - コード例: `packages/shadcn/src/registry/resolver.ts:622-743`（Kahn のアルゴリズム）
  - 注意点: 循環依存が検出された場合、警告を出しつつ全アイテムを返すフォールバック戦略を取っている

- **Strategy** (分類: 振る舞い)
  - 解決する問題: パッケージマネージャ（npm, pnpm, yarn, deno, expo）ごとに依存インストール方法が異なる
  - 適用条件: 同一操作に対して環境ごとの具体的な実装が必要な場合
  - コード例: `packages/shadcn/src/utils/updaters/update-dependencies.ts:105-195`
  - 注意点: Strategy パターンだがインターフェースではなく関数分岐で実装されている。パッケージマネージャの種類が増える場合はインターフェースベースに移行する方が安全

- **Promise Cache** (分類: 振る舞い/最適化)
  - 解決する問題: 同一 URL への重複リクエストを防ぐ
  - 適用条件: 同一リクエストが複数箇所から呼ばれうるネットワーク層
  - コード例: `packages/shadcn/src/registry/fetcher.ts:24-50`
  - 注意点: Promise 自体をキャッシュすることで、結果が返る前の重複リクエストも防げる（結果キャッシュでは防げない）

## Good Patterns

- **Zod スキーマをレイヤー境界のゲートキーパーとして使う**: Registry の各段階（fetch 後、resolve 後）で Zod の `parse()` を呼び出し、型安全性をランタイムで担保している。特に `registryResolvedItemsTreeSchema` は、resolver が上流の複数アイテムを `deepmerge` で統合した結果を再検証するため、マージによる型崩れを防ぐ。

```typescript
// packages/shadcn/src/registry/resolver.ts:346-357
const parsed = registryResolvedItemsTreeSchema.parse({
  dependencies: deepmerge.all(payload.map((item) => item.dependencies ?? [])),
  devDependencies: deepmerge.all(payload.map((item) => item.devDependencies ?? [])),
  files: deduplicatedFiles,
  tailwind, cssVars, css, docs,
  fonts: fonts.length > 0 ? fonts : undefined,
})
```

- **Transformer の統一シグネチャによる合成可能性**: すべての Transformer が `(opts) => Promise<SourceFile>` という同一の型を持つため、配列として合成し、条件に応じた追加・除外が自然に行える。

```typescript
// packages/shadcn/src/utils/transformers/index.ts:27-28
export type Transformer<Output = SourceFile> = (
  opts: TransformOpts & { sourceFile: SourceFile }
) => Promise<Output>
```

- **セキュリティ検証の多段階実装**: `isSafeTarget()` は null バイト、URL エンコード（多重デコード対応）、パストラバーサル、Windows ドライブレター、制御文字を網羅的にチェックする。外部レジストリからのファイルパスを信頼しない防御的設計。

```typescript
// packages/shadcn/src/utils/is-safe-target.ts:12-22
let decodedPath = targetPath
let prevPath = ""
while (decodedPath !== prevPath && decodedPath.includes("%")) {
  prevPath = decodedPath
  decodedPath = decodeURIComponent(decodedPath)
}
```

- **エラーに `suggestion` フィールドを持たせる**: `RegistryError` の各サブクラスがユーザー向けの対処法を含むため、CLI のエラーメッセージが具体的かつアクション可能になる。

```typescript
// packages/shadcn/src/registry/errors.ts:78-92
export class RegistryNotFoundError extends RegistryError {
  constructor(public readonly url: string, cause?: unknown) {
    super(message, {
      code: RegistryErrorCode.NOT_FOUND,
      suggestion: "Check if the item name is correct and the registry URL is accessible.",
    })
  }
}
```

## Anti-Patterns / 注意点

- **モジュールスコープの可変状態（Registry Context）**: `registry/context.ts` はモジュールスコープの `let context` に認証ヘッダーを蓄積する。テストの並行実行や、同一プロセスでの複数コマンド実行時に状態が残留する可能性がある。実際にコマンド終了時に `clearRegistryContext()` を `finally` ブロックで呼ぶ必要がある。

```typescript
// Bad: モジュールスコープの可変状態
let context: RegistryContext = { headers: {} }
export function setRegistryHeaders(headers: Record<string, Record<string, string>>) {
  context.headers = { ...context.headers, ...headers }
}

// Better: リクエストスコープのコンテキストを関数パラメータで渡す
interface RequestContext { headers: Record<string, Record<string, string>> }
export async function fetchRegistry(paths: string[], ctx: RequestContext) { ... }
```

- **Transformer の順序依存が暗黙的**: `transformCleanup` は最後に実行される必要があり、`transformImport` は他の変換がインポートを追加する前に実行される必要があるが、この順序制約がコード上のコメントや型で表現されていない。変換チェーンを編集する開発者は暗黙の知識に頼る必要がある。

```typescript
// Bad: 順序制約が暗黙
transformers: Transformer[] = [transformImport, transformRsc, ..., transformCleanup]

// Better: 順序制約を型で表現するか、フェーズ分離する
const phases = {
  pre: [transformImport],
  main: [transformRsc, transformCssVars, transformTwPrefixes, transformRtl, transformIcons],
  post: [transformCleanup],
}
```

## 導出ルール

- `[MUST]` 外部データソースからの入力は、レイヤー境界ごとにスキーマバリデーション（Zod 等）を通す。特にデータ統合（merge/aggregate）後の再検証を怠らない
  - 根拠: `resolver.ts:346` で `deepmerge.all()` 後に `registryResolvedItemsTreeSchema.parse()` を行い、統合による型崩れを防止している

- `[MUST]` 外部入力由来のファイルパスは多段階で検証する（null バイト、URL 多重エンコード、パストラバーサル、OS 固有パス形式）。信頼境界を超えたパスを直接使わない
  - 根拠: `is-safe-target.ts` が 7 種類の攻撃ベクトルを網羅的にチェックし、registry からの不正パスがファイルシステムに到達することを防いでいる

- `[SHOULD]` コード変換パイプラインでは、各変換を同一シグネチャの関数として実装し、配列で合成する。これにより変換の追加・条件付き適用・順序変更が宣言的に行える
  - 根拠: `transformers/index.ts:27-28` の `Transformer` 型と、`update-files.ts:145-158` での条件付きチェーン構築

- `[SHOULD]` CLI ツールにおける副作用の大きい操作（ネットワーク通信、ファイル書き込み）の前に、独立した preflight フェーズで環境前提条件を検証する。preflight は副作用を持たず、エラー辞書を返す
  - 根拠: `preflight-add.ts` が `Record<string, boolean>` 形式のエラー辞書を返し、コマンド層が分岐制御する

- `[SHOULD]` エラークラスに `suggestion` フィールドを含め、ユーザーが次に取るべきアクションを具体的に示す。エラーコード（列挙値）はプログラム的な分岐に使い、メッセージは人間向けにする
  - 根拠: `registry/errors.ts` の `RegistryError` が `code`, `suggestion`, `context` を構造化し、CLI 表示とプログラム的ハンドリングの両方に対応している

- `[AVOID]` モジュールスコープの可変状態を横断的関心事（認証、設定）の管理に使う。テスト分離やプロセス内での複数実行に問題を起こしやすい。関数パラメータまたはリクエストスコープのコンテキストオブジェクトを優先する
  - 根拠: `registry/context.ts` のモジュール変数が `clearRegistryContext()` の呼び忘れで状態残留を起こしうる設計になっている

## 適用チェックリスト

- [ ] パイプラインの各レイヤー境界にスキーマバリデーションが入っているか？特にデータの結合・集約後に再検証しているか？
- [ ] 外部入力由来のファイルパスに対するセキュリティ検証が多段階で実装されているか？
- [ ] コード変換・データ変換が統一シグネチャの関数として実装され、合成可能な設計になっているか？
- [ ] 副作用の大きい操作の前に、独立した preflight チェックフェーズが存在するか？
- [ ] エラーにユーザー向けの `suggestion`（次に取るべきアクション）が含まれているか？
- [ ] モジュールスコープの可変状態が最小限に抑えられ、テスト分離を妨げていないか？
- [ ] 依存方向が単方向（上流→下流）になっており、下流レイヤーが上流を import していないか？
