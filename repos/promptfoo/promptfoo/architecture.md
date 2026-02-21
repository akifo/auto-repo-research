# Architecture

> リポジトリ: promptfoo/promptfoo
> 分析日: 2026-02-21

## 概要

promptfoo は LLM の評価・レッドチームテストを行う大規模 TypeScript プロジェクト（2,300+ ソースファイル）で、CLI・Express サーバー・npm ライブラリの三面を単一コードベースから提供している。100 以上の LLM プロバイダを統一インターフェースで抽象化し、設定駆動の eval パイプラインで並行実行・レート制限・リトライを自動管理する。この分析では、プロバイダ抽象化・eval パイプライン・三面構成のレイヤー設計を横断的に明らかにし、大規模ツールの設計プラクティスを抽出する。

## 背景にある原則

- **最小インターフェース原則**: 100 以上のプロバイダを `ApiProvider` インターフェース（`id()` と `callApi()` の 2 メソッド）で統一する。インターフェースが小さいほど実装コストが下がり、エコシステムが拡大する。根拠: `src/types/providers.ts:102-120` で `ApiProvider` は必須メソッドが 2 つだけ、残りはすべてオプショナル。
- **段階的解決（Progressive Resolution）**: 設定文字列 → プロバイダインスタンスの解決を段階的に行い、各レイヤーが独立して動作する。ユーザーが YAML で `openai:gpt-4o` と書くだけで、レジストリがパース → ファクトリがインスタンス化 → 評価器が呼び出しを行う。根拠: `src/providers/registry.ts` の `ProviderFactory[]` が `test()` → `create()` の 2 段階で解決。
- **コア共有・表面分離**: CLI (`src/main.ts`)、ライブラリ (`src/index.ts`)、サーバー (`src/server/`) の 3 つの表面が、同一の evaluator コア (`src/evaluator.ts`) を共有する。表面ごとに入出力の形式だけを変え、ビジネスロジックの重複を排除する。根拠: CLI の `evalCommand` もライブラリの `evaluate()` も、最終的に `src/evaluator.ts` の `evaluate()` を呼ぶ。
- **透過的インフラ注入**: レート制限・リトライ・キャッシュなどのインフラ関心事を、プロバイダ実装に影響を与えずに外部から注入する。プロバイダは自身がラップされていることを知らない。根拠: `src/scheduler/providerWrapper.ts` が Symbol ベースの二重ラップ防止付きで透過的にプロバイダをラップする。

## 実例と分析

### プロバイダ抽象化レイヤー

プロバイダの解決は「文字列 ID → ファクトリマッチング → インスタンス化」の 3 段階で行われる。

`src/providers/registry.ts` に `ProviderFactory[]` 配列が定義され、各要素は `test(path): boolean` と `create(path, options, context): Promise<ApiProvider>` を持つ。`loadApiProvider()` は配列を先頭から走査し、最初に `test()` が `true` を返したファクトリの `create()` を呼ぶ。

このパターンの特徴は、新規プロバイダの追加が「配列に要素を追加する」だけで完結する点にある。既存コードの変更は不要で、Open-Closed 原則に従う。一方で配列が 1,700 行を超えており、巨大な単一ファイルになっているトレードオフがある。

プロバイダの能力拡張（embedding、classification、moderation）は、基本インターフェースを拡張する追加インターフェースで表現される:

```typescript
// src/types/providers.ts:122-136
export interface ApiEmbeddingProvider extends ApiProvider {
  callEmbeddingApi: (input: string) => Promise<ProviderEmbeddingResponse>;
}

export interface ApiClassificationProvider extends ApiProvider {
  callClassificationApi: (prompt: string) => Promise<ProviderClassificationResponse>;
}

export interface ApiModerationProvider extends ApiProvider {
  callModerationApi: (prompt: string, response: string) => Promise<ProviderModerationResponse>;
}
```

### eval パイプラインの構成

eval パイプラインは以下の順序で実行される:

1. **Config 解決**: `src/util/config/load.ts` の `resolveConfigs()` が YAML/JSON 設定を `UnifiedConfig` に正規化
2. **プロバイダ解決**: `loadApiProviders()` が文字列 ID をインスタンスに変換
3. **Extension beforeAll**: `runExtensionHook('beforeAll', { suite })` で TestSuite を事前変更
4. **テストケース組み立て**: defaultTest + scenarios + tests のマージ
5. **並行実行**: `async.forEachOfLimit()` で concurrency 制御された並行評価
6. **個別テスト実行**: `runEval()` がプロンプトレンダリング → プロバイダ呼び出し → アサーション評価
7. **Extension afterAll**: `runExtensionHook('afterAll', { results, suite })` で後処理
8. **結果永続化**: `Eval` モデル経由で SQLite（Drizzle ORM）に保存

重要なのは、ステップ 6 の `runEval()` 内部でレート制限レジストリが透過的に動作する点:

```typescript
// src/evaluator.ts:436-453
if (rateLimitRegistry) {
  response = await rateLimitRegistry.execute(
    activeProvider,
    () => activeProvider.callApi(renderedPrompt, callApiContext, ...),
    createProviderRateLimitOptions(),
  );
} else {
  response = await activeProvider.callApi(renderedPrompt, callApiContext, ...);
}
```

### 三面構成（CLI / Server / Library）

3 つのエントリポイントが異なるユーザーインターフェースを提供しながら、同一コアを共有する:

**CLI (`src/main.ts`)**: Commander.js でコマンドツリーを構築し、`evalCommand` が `resolveConfigs()` → `evaluate()` を呼ぶ。共通オプション（`--verbose`, `--env-file`）は `addCommonOptionsRecursively()` で全コマンドに再帰注入される。

**ライブラリ (`src/index.ts`)**: `evaluate()` 関数を公開し、`EvaluateTestSuite` を受け取る。内部で `loadApiProviders()` → `processPrompts()` → `doEvaluate()` のパイプラインを実行。CLI との違いは設定ファイル解決をスキップし、プログラム的に構築された TestSuite を直接受け取る点。

**サーバー (`src/server/server.ts`)**: Express + Socket.IO で Web UI を提供。REST API で eval 結果の CRUD を公開し、React フロントエンド (`src/app/`) がこれを消費する。`createApp()` が Express ミドルウェアスタックを組み立て、各ドメインの router を `/api/*` にマウントする。

### アダプティブスケジューラ

`src/scheduler/` モジュールはプロバイダごとのレート制限を自動学習する:

- `RateLimitRegistry`: eval ごとに 1 つ作成（シングルトンではない）。プロバイダ ID をキーにして `ProviderRateLimitState` を管理
- `AdaptiveConcurrency`: レート制限ヒット時に並行度を半減（backoff 0.5）、5 連続成功で 1.5 倍に回復。初期値にキャップ
- `SlotQueue`: セマフォ方式でスロットを管理し、キュータイムアウト付き
- `providerWrapper.ts`: Symbol ベースの二重ラップ防止で、既にラップ済みのプロバイダを再ラップしない

### データベースレイヤー

`src/database/` で better-sqlite3 + Drizzle ORM を使用。WAL モードを自動設定し、ネットワークファイルシステムでの失敗に対する graceful degradation を備える。`src/models/eval.ts` がリポジトリパターンで eval データの読み書きを抽象化する。

## コード例

```typescript
// src/types/providers.ts:102-119
// プロバイダの最小インターフェース。必須は id() と callApi() のみ。
export interface ApiProvider {
  id: () => string;
  callApi: CallApiFunction;
  callClassificationApi?: (prompt: string) => Promise<ProviderClassificationResponse>;
  callEmbeddingApi?: (input: string) => Promise<ProviderEmbeddingResponse>;
  config?: any;
  delay?: number;
  getSessionId?: () => string;
  inputs?: Inputs;
  label?: ProviderLabel;
  transform?: string;
  toJSON?: () => any;
  cleanup?: () => void | Promise<void>;
}
```

```typescript
// src/providers/registry.ts:127-134
// ProviderFactory インターフェース。test() でマッチング、create() でインスタンス化。
interface ProviderFactory {
  test: (providerPath: string) => boolean;
  create: (
    providerPath: string,
    providerOptions: ProviderOptions,
    context: LoadApiProviderContext,
  ) => Promise<ApiProvider>;
}
```

```typescript
// src/scheduler/providerWrapper.ts:27-39
// Symbol ベースの二重ラップ防止。プロバイダが既にラップされているかを Symbol で判定。
const WRAPPED_SYMBOL = Symbol.for('promptfoo.rateLimitWrapped');

type WrappedApiProvider = ApiProvider & { [WRAPPED_SYMBOL]: boolean };

export function isRateLimitWrapped(provider: ApiProvider): boolean {
  return (provider as WrappedApiProvider)[WRAPPED_SYMBOL] === true;
}
```

```typescript
// src/evaluatorHelpers.ts:610-614
// 拡張フック。beforeAll/beforeEach/afterEach/afterAll の 4 ポイントで TestSuite を変更可能。
export async function runExtensionHook<HookName extends keyof ExtensionHookContextMap>(
  extensions: string[] | null | undefined,
  hookName: HookName,
  context: ExtensionHookContextMap[HookName],
): Promise<ExtensionHookContextMap[HookName]> {
```

```typescript
// src/entrypoint.ts:14-19
// ビルド時定数注入。tsdown が package.json の engines フィールドから最小 Node バージョンを注入。
declare const __PROMPTFOO_MIN_NODE_VERSION__: number | undefined;
const minNodeVersion =
  typeof __PROMPTFOO_MIN_NODE_VERSION__ !== 'undefined' ? __PROMPTFOO_MIN_NODE_VERSION__ : 20;
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 100 以上の LLM プロバイダを統一的に扱う
  - 適用条件: 同一操作（API 呼び出し）を異なるアルゴリズム（プロバイダ実装）で実行する必要がある場面
  - コード例: `src/types/providers.ts:102-120` の `ApiProvider` インターフェース
  - 注意点: インターフェースを最小に保つことで実装コストを下げる。メソッドが増えると Strategy の追加が難しくなる

- **Abstract Factory パターン** (分類: 生成)
  - 解決する問題: 文字列 ID からプロバイダインスタンスを生成する
  - 適用条件: 設定ファイルなどの宣言的な記述からオブジェクトを生成する必要がある場面
  - コード例: `src/providers/registry.ts:136` の `providerMap: ProviderFactory[]`
  - 注意点: ファクトリ配列が巨大化する場合は、ファクトリ登録を分散ファイルに分けることを検討する

- **Decorator パターン** (分類: 構造)
  - 解決する問題: レート制限・リトライをプロバイダに透過的に追加する
  - 適用条件: 既存オブジェクトの振る舞いを変更せずに機能を追加する場面
  - コード例: `src/scheduler/providerWrapper.ts:27-39`
  - 注意点: Symbol ベースの二重ラップ防止を入れないと、無限ラップや性能劣化が起きる

- **Observer パターン** (分類: 振る舞い)
  - 解決する問題: スケジューラ内のイベント（レート制限ヒット、リクエスト完了等）を通知する
  - 適用条件: コンポーネント間の疎結合な通知が必要な場面
  - コード例: `src/scheduler/rateLimitRegistry.ts:19` の `RateLimitRegistry extends EventEmitter`
  - 注意点: イベント名を型安全にするために TypeScript の型定義を活用する

## Good Patterns

- **最小コアインターフェース + オプショナル拡張**: `ApiProvider` は `id()` と `callApi()` のみ必須で、`callEmbeddingApi`、`callClassificationApi`、`cleanup` などは全てオプショナル。これにより新規プロバイダの最小実装コストが極めて低い。100 以上のプロバイダがこのパターンで統合されている。

```typescript
// src/types/providers.ts:102-120
// 必須は id() と callApi() のみ。残りは全てオプショナル。
export interface ApiProvider {
  id: () => string;
  callApi: CallApiFunction;
  // 以下すべて optional
  callClassificationApi?: ...;
  callEmbeddingApi?: ...;
  cleanup?: () => void | Promise<void>;
}
```

- **非シングルトンのインフラレジストリ**: `RateLimitRegistry` は eval ごとに新規作成され、シングルトンではない。これにより eval 間の状態汚染を防ぎ、テストも容易になる。コメントで明示的に「NOT a singleton」と記載されている。

```typescript
// src/scheduler/rateLimitRegistry.ts:18
/**
 * Per-eval registry that manages rate limit state for all providers.
 * NOT a singleton - create one per evaluation context.
 */
export class RateLimitRegistry extends EventEmitter {
```

- **ビルド時定数注入による早期検証**: `entrypoint.ts` でビルド時に `__PROMPTFOO_MIN_NODE_VERSION__` を注入し、依存モジュールの import 前に Node.js バージョンチェックを行う。これにより ES2024 機能の構文エラーよりも先に分かりやすいエラーメッセージを表示できる。

```typescript
// src/entrypoint.ts:1-9
// Entry point for the promptfoo CLI.
// This file intentionally has NO dependencies to ensure the Node.js version
// check runs before any module loading that might fail on older versions.
```

- **段階的 graceful shutdown**: `shutdownGracefully()` は個別操作ごとのタイムアウト（1 秒）と全体のフォースイグジットタイムアウト（3 秒）を持つ二層構造。`withTimeout()` ヘルパーで各クリーンアップを `Promise.race` でラップし、個別のハングを許容しつつ全体のプロセス終了を保証する。

```typescript
// src/main.ts:262-299
const FORCE_EXIT_TIMEOUT_MS = 3000;
const CLEANUP_OP_TIMEOUT_MS = 1000;

const withTimeout = async <T>(promise: Promise<T>, name: string): Promise<T | undefined> => {
  // ...Promise.race([promise, timeoutPromise])...
};
```

## Anti-Patterns / 注意点

- **巨大ファクトリ配列**: `src/providers/registry.ts` は 1,700 行を超え、100 以上のプロバイダファクトリが単一の配列リテラルに格納されている。新規追加は容易だが、可読性と変更のコンフリクト率が高い。

```typescript
// Bad: 1,700+ 行の単一配列
export const providerMap: ProviderFactory[] = [
  // 100+ entries...
];
```

```typescript
// Better: ドメインごとにファクトリを分離して登録
// providers/openai/factory.ts
export const openaiFactories: ProviderFactory[] = [...];

// providers/registry.ts
export const providerMap = [
  ...openaiFactories,
  ...anthropicFactories,
  ...bedrockFactories,
];
```

- **cliState グローバルミュータブル**: `src/cliState.ts` はモジュールレベルのミュータブルオブジェクトで、CLI とライブラリの両面から暗黙的に参照される。テスト時の状態リセット漏れやレースコンディションのリスクがある。

```typescript
// Bad: グローバルミュータブル状態
// src/cliState.ts
const state: CliState = {};
export default state;
```

```typescript
// Better: Context オブジェクトを引数で渡す（依存性注入）
function evaluate(testSuite: TestSuite, context: EvalContext) {
  const { basePath, config } = context;
}
```

## 導出ルール

- `[MUST]` 複数の消費面（CLI / ライブラリ / サーバー）を持つツールでは、ビジネスロジックを共有コアに集約し、各面はインターフェース変換のみを担当させる
  - 根拠: promptfoo は `src/evaluator.ts` を 3 つのエントリポイントが共有し、ロジック重複ゼロで 3 面を提供している (`src/main.ts`, `src/index.ts`, `src/server/`)

- `[MUST]` プラグインインターフェースの必須メソッドは最小限に抑え、追加機能はオプショナルメソッドで拡張する
  - 根拠: `ApiProvider` は必須 2 メソッド + オプショナル 10 プロパティの構成で、100 以上のプロバイダ実装を低コストで統合している (`src/types/providers.ts:102-120`)

- `[SHOULD]` インフラ関心事（レート制限・リトライ・キャッシュ）はプラグイン実装の外側で透過的に注入し、プラグインコードからインフラ依存を排除する
  - 根拠: `RateLimitRegistry.execute()` がプロバイダの `callApi` をラップし、プロバイダ側はレート制限の存在を知らない (`src/scheduler/rateLimitRegistry.ts:42-53`, `src/evaluator.ts:436-453`)

- `[SHOULD]` eval 単位・リクエスト単位のインフラ状態はシングルトンではなくスコープ付きインスタンスで管理し、実行コンテキスト間の状態汚染を防ぐ
  - 根拠: `RateLimitRegistry` はコメントで明示的に「NOT a singleton - create one per evaluation context」と宣言している (`src/scheduler/rateLimitRegistry.ts:18`)

- `[SHOULD]` 設定文字列からオブジェクトへの解決は、ファクトリ配列の線形走査（test → create パターン）で実装し、新規追加時に既存コードの変更を不要にする
  - 根拠: `providerMap: ProviderFactory[]` は `test()` でマッチング → `create()` でインスタンス化の 2 段階で、新プロバイダの追加が配列に 1 要素追加するだけで完結する (`src/providers/registry.ts:136`)

- `[SHOULD]` Decorator で外部機能を透過注入する場合、Symbol ベースの二重ラップ防止を入れる
  - 根拠: `WRAPPED_SYMBOL = Symbol.for('promptfoo.rateLimitWrapped')` で既にラップ済みのプロバイダを検出し、二重ラップによる性能劣化や無限再帰を防止している (`src/scheduler/providerWrapper.ts:27-39`)

- `[AVOID]` 100 以上のファクトリやハンドラを単一ファイルの配列リテラルに格納すること — ファイルが肥大化し、変更コンフリクトが頻発する
  - 根拠: `src/providers/registry.ts` は 1,700 行超の単一ファイルで、全プロバイダの import 文だけで 120 行を占める

## 適用チェックリスト

- [ ] プロジェクトが CLI / ライブラリ / Web の複数面を持つ場合、共有コアモジュールを特定し、各面がそのコアのみを呼び出す構成になっているか
- [ ] プラグインインターフェースの必須メソッドは 3 個以下に抑えられているか。4 個以上あるなら、一部をオプショナルに移動できないか検討する
- [ ] レート制限・リトライ・ログなどのインフラ関心事がプラグイン実装の中に混入していないか。Decorator やラッパーで外部注入する設計になっているか
- [ ] プラグインレジストリがシングルトンになっていないか。実行コンテキストごとにスコープ付きインスタンスを作成しているか
- [ ] 新しいプラグインの追加が既存コードの変更を必要としない構造（Open-Closed）になっているか
- [ ] Decorator で二重ラップ防止の仕組みが入っているか（Symbol / WeakSet / フラグ等）
- [ ] プロセスの graceful shutdown で、個別クリーンアップのタイムアウトと全体のフォースイグジットの二層保護があるか
