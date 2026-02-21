# Extensibility Mechanisms

> リポジトリ: promptfoo/promptfoo
> 分析日: 2026-02-21

## 概要

promptfoo は LLM テストフレームワークとして、カスタムプロバイダ・カスタムアサーション・ライフサイクルフック・多言語スクリプト対応という4層の拡張機構を持つ。注目に値する理由は、YAML 設定ファイルの宣言的記述とプログラマティックな拡張を URI プレフィックス（`python:`, `file://`, `exec:` 等）という統一的なディスパッチ規約で橋渡ししている点にある。この設計は70以上のプロバイダ、40以上のアサーション型、4つの言語ランタイムを単一の `prefix:path` 規約で束ねており、宣言的設定駆動ツールの拡張設計として示唆に富む。

## 背景にある原則

- **URI プレフィックスによる統一ディスパッチ**: あらゆる拡張ポイント（プロバイダ、アサーション、トランスフォーム、フック）が `prefix:path` または `file://path` という共通の文字列規約で指定される。これにより YAML 設定ファイルから任意の言語・プロトコル・モジュールを参照でき、ユーザーは型システムやインタフェースの知識なしに拡張を接続できる。根拠: `src/providers/registry.ts:127-134` の `ProviderFactory` インタフェースと `providerMap` 配列。

- **契約ベースの境界（Interface over Inheritance）**: `ApiProvider` インタフェース（`src/types/providers.ts:102-120`）は `id()` と `callApi()` のみを必須とし、`callEmbeddingApi`, `callClassificationApi`, `cleanup` 等はオプショナルとする。これにより最小の実装コストで拡張を提供でき、機能の段階的追加が可能になる。

- **言語非依存の JSON 契約**: Python/Go/Ruby プロバイダはすべて JSON を入出力の契約とし、ホスト側（TypeScript）が結果の検証・キャッシュ・エラーハンドリングを担う。拡張スクリプトは `{output: string}` または `{error: string}` という最小の構造体を返すだけでよい。根拠: `src/providers/pythonCompletion.ts:281-291` の検証ロジック。

- **変換パイプラインの段階的カスタマイズ**: HTTP プロバイダは `transformRequest` → 本体送信 → `transformResponse` というパイプラインを持ち、各段階でインライン JavaScript 式、関数式、`file://` 参照を受け付ける。カスタマイズの深度をユーザーが選べる設計。根拠: `src/providers/httpTransforms.ts:17-85`。

## 実例と分析

### プロバイダレジストリ: テスト/ファクトリパターン

プロバイダの解決は `providerMap` という `ProviderFactory[]` 配列を先頭から順に走査し、最初にマッチした `test()` が `create()` を呼ぶという線形チェーンで実装される。

```typescript
// src/providers/registry.ts:127-134
interface ProviderFactory {
  test: (providerPath: string) => boolean;
  create: (
    providerPath: string,
    providerOptions: ProviderOptions,
    context: LoadApiProviderContext,
  ) => Promise<ApiProvider>;
}
```

70以上のエントリが `providerMap` に登録されている（`src/providers/registry.ts:136-1708`）。この設計は Chain of Responsibility に近いが、優先順位が配列の順序で暗黙的に決まるため、特殊なプレフィックス（`anthropic:claude-agent-sdk`）は汎用プレフィックス（`anthropic:`）より前に配置する必要がある。

### スクリプトベースプロバイダの共通ファクトリ

`exec:`, `python:`, `golang:`, `ruby:` の4つのスクリプトベースプロバイダは `createScriptBasedProviderFactory` というジェネリックファクトリで生成される。

```typescript
// src/providers/scriptBasedProvider.ts:13-17
export function createScriptBasedProviderFactory(
  prefix: string,
  fileExtension: string | null,
  providerConstructor: new (scriptPath: string, options: ProviderOptions) => ApiProvider,
)
```

```typescript
// src/providers/registry.ts:137-140
createScriptBasedProviderFactory('exec', null, ScriptCompletionProvider),
createScriptBasedProviderFactory('golang', 'go', GolangProvider),
createScriptBasedProviderFactory('python', 'py', PythonProvider),
createScriptBasedProviderFactory('ruby', 'rb', RubyProvider),
```

ファクトリは `prefix:path` と `file://path.ext` の両方のパス形式に対応する。ファイル拡張子によるマッチングにより、ユーザーは `file://my_provider.py` と書くだけで Python プロバイダが自動選択される。

### JavaScript プロバイダ: ESM/CJS 両対応のモジュールローダ

JavaScript ファイルがプロバイダパスとして指定された場合、`importModule`（`src/esm.ts:198-307`）が呼ばれる。この関数は ESM `import()` を試行し、失敗時に `vm.createContext` ベースの CJS フォールバックを実行する。CJS フォールバックでは `require`, `__dirname`, `process` 等の Node.js グローバルを手動で注入する（`src/esm.ts:350-461`）。

```typescript
// src/esm.ts:234-237
if (modulePath.endsWith('.js') && isCjsInEsmError(errorMessage)) {
  // vm-based CJS execution for .js files that use CJS syntax
  const mod = loadCjsModule(resolvedPath);
}
```

### アサーション拡張: 型名ディスパッチと多言語サポート

アサーションは `ASSERTION_HANDLERS` レコードにより型名から handler 関数へディスパッチされる（`src/assertions/index.ts:117-200`）。`javascript` と `python` がビルトインの拡張ポイントとして組み込まれており、YAML 設定内にインラインコードを書くか、`file://` で外部スクリプトを参照できる。

```typescript
// src/assertions/index.ts:117-120
const ASSERTION_HANDLERS: Record<
  BaseAssertionTypes,
  (params: AssertionParams) => GradingResult | Promise<GradingResult>
> = {
  // ... 40以上のハンドラ
  javascript: handleJavascript,
  python: handlePython,
  ruby: handleRuby,
```

JavaScript アサーションはインライン式（`output.includes('hello')`）と `file://` 外部ファイルの両方をサポートし、単一行の場合は `return` を自動挿入、変数宣言を含む場合は最終式の前に `return` を注入する（`src/assertions/javascript.ts:81-103`）。

### ライフサイクルフック（Extension Hooks）

`extensions` 設定で `file://path:hookName` 形式のフックを登録でき、`beforeAll`, `beforeEach`, `afterEach`, `afterAll` の4つのライフサイクルポイントで実行される（`src/evaluatorHelpers.ts:564-568`）。

```typescript
// src/evaluatorHelpers.ts:564-568
export type ExtensionHookContextMap = {
  beforeAll: BeforeAllExtensionHookContext;
  beforeEach: BeforeEachExtensionHookContext;
  afterEach: AfterEachExtensionHookContext;
  afterAll: AfterAllExtensionHookContext;
};
```

フック名による呼び分けは `getExtensionHookName` 関数が担い、known hook name なら「新規約（context, { hookName }）」、カスタム名なら「レガシー規約（hookName, context）」で呼ぶ互換設計になっている（`src/evaluatorHelpers.ts:650-671`）。

### npm パッケージプロバイダ

`package:` プレフィックスにより npm パッケージからプロバイダをロードできる（`src/providers/packageParser.ts`）。`exsolve` ライブラリで ESM-only パッケージの restrictive exports にも対応している。

```typescript
// src/providers/packageParser.ts:53-61
export async function parsePackageProvider(
  providerPath: string, basePath: string, options: ProviderOptions,
): Promise<ApiProvider> {
  const Provider = await loadFromPackage(providerPath, basePath);
  return new Provider(options);
}
```

## パターンカタログ

- **Chain of Responsibility** (振る舞い)
  - 解決する問題: URI 文字列から適切なプロバイダ実装への解決
  - 適用条件: 拡張ポイントが多数あり、マッチング条件が多様な場合
  - コード例: `src/providers/registry.ts:136-1708`（`providerMap` 配列）
  - 注意点: 配列順序が優先順位を暗黙的に決定するため、特殊ケースは汎用ケースより前に配置する必要がある

- **Factory Method** (生成)
  - 解決する問題: 複数のスクリプト言語プロバイダに共通の生成ロジックを適用
  - 適用条件: 共通パターン（prefix + file extension）を持つ複数の具象クラスがある場合
  - コード例: `src/providers/scriptBasedProvider.ts:13-55`
  - 注意点: ファクトリが扱えない言語固有の初期化（Go のビルド、Python のワーカープール）は各 Provider クラス内に残る

- **Strategy** (振る舞い)
  - 解決する問題: HTTP プロバイダのリクエスト/レスポンス変換を差し替え可能にする
  - 適用条件: パイプラインの各段階を独立にカスタマイズしたい場合
  - コード例: `src/providers/httpTransforms.ts:17-85`（インライン式、関数式、file:// の3つの戦略）

## Good Patterns

- **最小インタフェース + オプショナル拡張**: `ApiProvider` は `id()` と `callApi()` のみ必須で、`callEmbeddingApi`, `callClassificationApi`, `cleanup` はオプショナル。新しいプロバイダは2メソッドだけ実装すれば動作し、機能を段階的に追加できる。

```typescript
// src/types/providers.ts:102-120
export interface ApiProvider {
  id: () => string;
  callApi: CallApiFunction;
  callClassificationApi?: (prompt: string) => Promise<ProviderClassificationResponse>;
  callEmbeddingApi?: (input: string) => Promise<ProviderEmbeddingResponse>;
  cleanup?: () => void | Promise<void>;
  // ...
}
```

- **JSON 契約によるプロセス間通信**: Python/Go/Ruby プロバイダはすべて `{output: string}` or `{error: string}` という統一的な JSON 構造で結果を返す。TypeScript 側が検証・キャッシュ・トークン計算を一元管理するため、各言語の実装は最小限で済む。Python のスネークケース結果も `mapSnakeCaseToCamelCase` で自動変換される（`src/assertions/python.ts:77`）。

```typescript
// src/providers/pythonCompletion.ts:281-291
if (!result || typeof result !== 'object' ||
    (!('output' in result) && !('error' in result))) {
  throw new Error(
    `The Python script must return a dict with an 'output' or 'error'`
  );
}
```

- **インライン式の段階的展開**: アサーションとトランスフォームは「インライン式 → 複数行コード → file:// 外部ファイル」という3段階のカスタマイズ深度を提供。単純なケースは YAML 内で完結し、複雑なケースだけ外部ファイルに分離できる。

```yaml
# 最小: インライン式
assert:
  - type: javascript
    value: output.includes('hello')

# 中間: 複数行
assert:
  - type: javascript
    value: |
      const parsed = JSON.parse(output);
      return parsed.score > 0.8;

# 最大: 外部ファイル
assert:
  - type: javascript
    value: file://assertions/custom.js
```

- **プロセスライフサイクル管理**: `ProviderRegistry`（`src/providers/providerRegistry.ts`）が子プロセス（Python ワーカー等）の参照を保持し、`SIGINT`/`SIGTERM`/`beforeExit` で一括シャットダウンする。拡張プロバイダがゾンビプロセスを残さない仕組み。

## Anti-Patterns / 注意点

- **線形走査による暗黙的優先順位**: `providerMap` は配列の順序で優先順位が決まるため、新しいプロバイダを追加する際の配置位置を誤ると既存のマッチングが壊れる。特に `anthropic:claude-agent-sdk` と `anthropic:` のような特殊/汎用の関係が暗黙的。

```typescript
// Bad: 汎用パターンが先にマッチしてしまう
providerMap = [
  { test: (p) => p.startsWith('anthropic:'), create: ... },
  { test: (p) => p.startsWith('anthropic:claude-agent-sdk'), create: ... }, // 到達不能
];

// Better: 特殊パターンを先に配置（現在の実装）
providerMap = [
  { test: (p) => p.startsWith('anthropic:claude-agent-sdk'), create: ... },
  { test: (p) => p.startsWith('anthropic:'), create: ... },
];
```

- **コンテキストの非シリアライズフィールド削除**: Python/Go/Ruby プロバイダはコンテキストを JSON シリアライズするために `getCache`, `logger`, `filters`, `originalProvider` を手動で `delete` する。この削除リストは4つのプロバイダで重複しており、フィールドが追加されるたびに全箇所を更新する必要がある。

```typescript
// Bad: 複数箇所で同じ削除ロジック（現状）
// src/providers/pythonCompletion.ts:237-239
// src/providers/golangCompletion.ts:91-96
// src/providers/rubyCompletion.ts:163-168
// src/providers/scriptCompletion.ts:97-100
delete context.getCache;
delete context.logger;
delete context.filters;
delete context.originalProvider;

// Better: 共通の sanitizeContext() 関数に抽出する
const sanitizedContext = sanitizeCallApiContext(context);
```

## 導出ルール

- `[MUST]` プラグインシステムの拡張ポイントは最小のインタフェース（1-2メソッド必須 + オプショナル拡張）で定義し、段階的な機能追加を可能にする
  - 根拠: `ApiProvider` は `id()` と `callApi()` のみ必須で70以上のプロバイダが統一的に接続されている（`src/types/providers.ts:102-120`）

- `[MUST]` 外部プロセスとの通信契約は言語非依存のシリアライゼーション形式（JSON 等）で定義し、ホスト側で検証・エラーハンドリング・キャッシュを一元管理する
  - 根拠: Python/Go/Ruby プロバイダはすべて `{output}` or `{error}` の JSON 契約で、検証とキャッシュは TypeScript 側に集約されている（`src/providers/pythonCompletion.ts:269-321`）

- `[SHOULD]` 宣言的設定ファイルからプログラマティックな拡張を参照する場合、URI プレフィックス（`python:`, `file://`, `exec:` 等）による統一的なディスパッチ規約を採用する
  - 根拠: promptfoo はプロバイダ・アサーション・トランスフォーム・フックすべてで `prefix:path` 規約を統一し、YAML とコードの境界をシームレスに接続している

- `[SHOULD]` カスタマイズの深度を段階的に提供する（インライン式 → 複数行コード → 外部ファイル参照）。単純なケースは設定ファイル内で完結させ、複雑なケースだけ外部化する
  - 根拠: JavaScript アサーションは `output.includes('hello')` からファイル参照まで3段階をサポートし、return 文の自動挿入等で利便性を確保している（`src/assertions/javascript.ts:81-103`）

- `[SHOULD]` 子プロセスを起動する拡張機構では、グローバルレジストリによるライフサイクル管理（シャットダウンフック）を実装し、ゾンビプロセスを防止する
  - 根拠: `ProviderRegistry` が `SIGINT`/`SIGTERM`/`beforeExit` でワーカープールを一括シャットダウンする（`src/providers/providerRegistry.ts:31-57`）

- `[SHOULD]` 拡張ファクトリの登録順序が暗黙的な優先順位を持つ場合、特殊パターンを汎用パターンより先に配置し、コメントで意図を明示する
  - 根拠: `providerMap` では `anthropic:claude-agent-sdk` が `anthropic:` より前に配置され、意図的な優先順位制御を行っている（`src/providers/registry.ts:216-266`）

- `[AVOID]` コンテキストオブジェクトの非シリアライズフィールドを各拡張ポイントで個別に `delete` する。フィールド追加時に全箇所の更新が必要になり、漏れのリスクが高い
  - 根拠: 4つのスクリプトプロバイダで同一の `delete` リストが重複している（`src/providers/pythonCompletion.ts:237-239`, `golangCompletion.ts:91-96`, `rubyCompletion.ts:163-168`, `scriptCompletion.ts:97-100`）

## 適用チェックリスト

- [ ] 拡張ポイントのインタフェースは必須メソッドを最小限（1-3個）にし、残りをオプショナルにしているか
- [ ] 外部プロセス（Python, Go 等）との通信契約を JSON スキーマ等で明文化し、ホスト側で検証しているか
- [ ] 宣言的設定ファイルからの拡張参照に統一的な URI 規約を採用しているか
- [ ] カスタマイズの深度を段階的に提供しているか（インライン → 外部ファイル）
- [ ] 子プロセスのライフサイクル管理（シグナルハンドラによるクリーンアップ）を実装しているか
- [ ] 拡張ファクトリの登録順序に依存する暗黙的な優先順位をドキュメントまたはコメントで明示しているか
- [ ] 拡張向けのコンテキスト整形ロジック（非シリアライズフィールドの除去等）を共通関数に抽出しているか
- [ ] ESM/CJS 両対応が必要な場合、フォールバック戦略を実装しているか
