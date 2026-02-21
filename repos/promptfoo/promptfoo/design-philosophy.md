# design-philosophy

> リポジトリ: promptfoo/promptfoo
> 分析日: 2026-02-21

## 概要

promptfoo の設計思想を「宣言的テスト定義」「プロバイダ中立性」「拡張性」の3軸で分析した。このリポジトリは LLM 評価ツールとして 100 以上のプロバイダをサポートしながら、ユーザが YAML 設定だけでテストを記述できる宣言的インターフェースを実現している。注目すべきは、宣言性と拡張性の両立を「文字列プロトコル + Factory Pattern + file:// エスケープハッチ」の組み合わせで達成している点であり、テストフレームワークに限らず「多様なバックエンドを統一的に扱うツール」の設計に広く応用できる知見が含まれる。

## 背景にある原則

- **設定は宣言的に、実行は手続き的に分離する**: ユーザが「何をテストするか」を YAML で宣言し、「どう実行するか」はフレームワークが担う。`TestSuiteConfigSchema` がユーザ向け宣言的 DSL を Zod で厳密に定義し、`TestSuiteSchema` がランタイム内部表現を別途定義する二層構造になっている（`src/types/index.ts:1059` "TestSuiteConfig = Test Suite, but before everything is parsed and resolved"）。これにより設定の検証とランタイムの関心が明確に分離される。

- **文字列ベースのプロトコルで拡張ポイントを宣言する**: プロバイダ指定は `"openai:gpt-4o"` `"file://custom.py"` `"webhook:https://..."` のように、コロン区切りの文字列プロトコルで行われる。この設計により、YAML の中で型安全性を犠牲にせず（JSON Schema による補完が効く）多様なバックエンドを統一的に参照できる（`src/providers/registry.ts:136` の `providerMap` 配列）。

- **ゼロコスト原則で参入障壁を下げる**: `echo` プロバイダ（`src/providers/echo.ts`）は入力をそのまま返すだけのプロバイダで、LLM API キーなしでテスト設定の構文確認やアサーションのデバッグができる。同様に `providerOutput` フィールド（`src/types/index.ts:786`）はプロバイダ呼び出しをスキップして既存の出力に対してアサーションを実行できる。ユーザの最初の成功体験までのコストを最小化する設計判断。

- **file:// エスケープハッチで宣言性と柔軟性を両立する**: プロンプト、プロバイダ、テストケース、アサーション、トランスフォーム全てに `file://` プロトコルが使える。宣言的 YAML では表現しきれない複雑なロジックを外部ファイル（JS/Python）に委譲する統一的な手法で、宣言性を壊さずに拡張性を確保している（`src/util/file.ts:56` `maybeLoadFromExternalFile`）。

## 実例と分析

### 宣言的設定の二層構造

promptfoo は「ユーザが書く設定」と「ランタイムが使う内部表現」を意図的に分離している。ユーザ向けの `TestSuiteConfigSchema` ではプロバイダを文字列で指定でき、テストケースをファイルパスで指定できる。一方、内部の `TestSuiteSchema` ではプロバイダは解決済みの `ApiProvider` オブジェクト、テストケースは展開済みの配列になる。

この変換は `src/index.ts:41-74` の `evaluate()` 関数で行われる。`loadApiProviders` が文字列をプロバイダオブジェクトに、`readTests` がファイルパスをテストケース配列に、`processPrompts` がファイルパスをプロンプト文字列に変換する。

```typescript
// src/index.ts:63-74
const constructedTestSuite: TestSuite = {
  ...testSuite,
  defaultTest: resolvedDefaultTest as TestSuite['defaultTest'],
  scenarios: testSuite.scenarios as Scenario[],
  providers: loadedProviders,
  tests: await readTests(testSuite.tests),
  nunjucksFilters: await readFilters(testSuite.nunjucksFilters || {}),
  prompts: await processPrompts(testSuite.prompts),
};
```

### プロバイダ登録の Factory Pattern

`src/providers/registry.ts:136-1708` の `providerMap` は `ProviderFactory[]` 型の配列で、各要素が `test()` と `create()` メソッドを持つ。`loadApiProvider()` は配列を走査して最初にマッチした Factory でプロバイダを生成する。

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

この設計は Chain of Responsibility パターンに近いが、いくつかの特徴がある:

1. **順序が意味を持つ**: `anthropic:claude-agent-sdk` は `anthropic:` より先に登録されている（`registry.ts:216-230` vs `registry.ts:232-266`）。より具体的なパターンを先にマッチさせる必要がある。
2. **動的インポート**: 使用頻度の低いプロバイダは `await import()` で遅延ロードされる（例: `registry.ts:789` の `litellm`、`registry.ts:1113` の `docker`）。
3. **OpenAI 互換レイヤー**: Fireworks や F5 など OpenAI 互換 API は `OpenAiChatCompletionProvider` を直接再利用し、`apiBaseUrl` と `apiKeyEnvar` だけ変更する（`registry.ts:674-691`）。

### アサーションの拡張モデル

60 以上の組み込みアサーション型（`src/types/index.ts:514-576` の `BaseAssertionTypesSchema`）に加え、`not-` プレフィックスで全ての型を反転できる（`src/types/index.ts:589-591`）。さらに JavaScript/Python/Webhook による完全カスタムアサーションもサポートする。

```typescript
// src/types/index.ts:593-600
export const AssertionTypeSchema = z.union([
  BaseAssertionTypesSchema,
  NotPrefixedAssertionTypesSchema,
  SpecialAssertionTypesSchema,
  z.custom<RedteamAssertionTypes>(),
]);
```

### デフォルトプロバイダの環境適応

`src/providers/defaults.ts:68-238` の `getDefaultProviders()` は、環境変数から利用可能な API キーを検出し、最適なデフォルトプロバイダセットを自動選択する。OpenAI、Anthropic、Google AI Studio、Vertex、Mistral、Azure、GitHub の順で優先度が定義されている。

```typescript
// src/providers/defaults.ts:68-75
export async function getDefaultProviders(env?: EnvOverrides): Promise<DefaultProviders> {
  const hasAnthropicCredentials = Boolean(
    getEnvString('ANTHROPIC_API_KEY') || env?.ANTHROPIC_API_KEY,
  );
  const hasOpenAiCredentials = Boolean(getEnvString('OPENAI_API_KEY') || env?.OPENAI_API_KEY);
  // ... 環境に応じて最適なプロバイダセットを返す
```

この設計により、ユーザはプロバイダを明示指定しなくても「手元にある API キーで動く」体験を得られる。

### 拡張フック（Extension Hooks）

`src/evaluatorHelpers.ts:564-568` で定義される 4 つのライフサイクルフック（`beforeAll`, `beforeEach`, `afterEach`, `afterAll`）は、YAML の `extensions` フィールドで外部ファイルを指定するだけで有効になる。

```typescript
// src/evaluatorHelpers.ts:564-568
export type ExtensionHookContextMap = {
  beforeAll: BeforeAllExtensionHookContext;
  beforeEach: BeforeEachExtensionHookContext;
  afterEach: AfterEachExtensionHookContext;
  afterAll: AfterAllExtensionHookContext;
};
```

## パターンカタログ

- **Abstract Factory** (分類: 生成)
  - 解決する問題: 100 以上の LLM プロバイダを統一的に生成する
  - 適用条件: 文字列識別子から多様な実装を動的に選択する必要がある場合
  - コード例: `src/providers/registry.ts:127-134` の `ProviderFactory` インターフェース
  - 注意点: Factory 配列の順序がマッチング優先度を決定するため、新規追加時は具体的なパターンを先に配置する必要がある

- **Strategy** (分類: 振る舞い)
  - 解決する問題: アサーションロジックを本体から分離し、60+ の型を個別に実装する
  - 適用条件: 同一インターフェースで多数のアルゴリズムを切り替える場合
  - コード例: `src/assertions/index.ts` が各アサーション型ごとの `handle*` 関数をインポートし、型に基づいてディスパッチする
  - 注意点: `not-` プレフィックスによる反転は型レベルで定義され、個別実装不要

- **Template Method** (分類: 振る舞い)
  - 解決する問題: 評価の実行フローを固定しつつ、Extension Hooks で各ステップをカスタマイズ可能にする
  - 適用条件: フレームワークの実行フローは固定だが、特定ポイントにユーザロジックを挿入したい場合
  - コード例: `src/evaluatorHelpers.ts:610` の `runExtensionHook()` で `beforeAll`/`beforeEach`/`afterEach`/`afterAll` を提供

## Good Patterns

- **文字列プロトコルによる宣言的バックエンド選択**: `"prefix:model"` 形式の文字列でバックエンドを指定し、Factory 配列で解決する。YAML/JSON 設定ファイルと相性が良く、JSON Schema による補完が効く。プロバイダ文字列の例: `"openai:gpt-4o"`, `"anthropic:claude-3-5-sonnet"`, `"file://custom.py"`, `"webhook:https://..."`, `"echo"`。

```yaml
# ユーザが書く設定（宣言的）
providers:
  - openai:gpt-4o
  - anthropic:claude-3-5-sonnet
  - file://my_custom_provider.py
```

- **file:// エスケープハッチの一貫適用**: プロンプト、プロバイダ、テストケース、アサーション値、トランスフォーム、デフォルトテスト設定の全てで `file://` 参照が使える。宣言的 YAML の制約を超える複雑なロジックは常にこの統一的な方法で外部委譲できる。

```yaml
# 全ての構成要素で file:// が使える
prompts:
  - file://prompt.txt
providers:
  - file://custom_provider.py
tests: file://cases.jsonl
defaultTest: file://shared/defaultTest.yaml
```

- **ゼロコストテストプロバイダ**: `EchoProvider` は入力をそのまま返すだけのプロバイダで、API キーなしでアサーションロジックのデバッグや設定構文の検証ができる。新しいテストフレームワークを作る際に「API 不要で動く最小プロバイダ」を用意しておくと、ユーザのオンボーディングが大幅に改善される。

```typescript
// src/providers/echo.ts:28-53
async callApi(input: string): Promise<ProviderResponse> {
  return {
    output: input,
    raw: input,
    cost: 0,
    cached: false,
    tokenUsage: { total: 0, prompt: 0, completion: 0, numRequests: 1 },
  };
}
```

- **環境適応型デフォルト**: 利用可能な API キーから最適なデフォルトプロバイダセットを自動選択する。ユーザは「とりあえず API キーを設定するだけ」で動く。明示的なプロバイダ指定は上級者向けのオプションになる。

## Anti-Patterns / 注意点

- **Factory 配列の順序依存**: `providerMap` は配列の先頭から走査して最初にマッチした Factory を使う。`anthropic:claude-agent-sdk` が `anthropic:` より前に登録されていないと、一般的な Anthropic Factory にマッチしてしまう。新規プロバイダ追加時にこの順序を間違えると、既存プロバイダの動作が壊れるリスクがある。

```typescript
// Bad: 汎用パターンが先にマッチしてしまう
const providerMap = [
  { test: (p) => p.startsWith('anthropic:'), ... },        // これが先にマッチ
  { test: (p) => p.startsWith('anthropic:claude-agent-sdk'), ... }, // 到達しない
];

// Better: 具体的なパターンを先に配置
const providerMap = [
  { test: (p) => p.startsWith('anthropic:claude-agent-sdk'), ... }, // 具体的が先
  { test: (p) => p.startsWith('anthropic:'), ... },        // 汎用が後
];
```

- **config の any 型**: `ProviderOptions.config` が `any` 型で定義されている（`src/types/providers.ts:53`）。プロバイダごとに設定スキーマが異なるため型を統一できないのは理解できるが、設定ミスがランタイムまで検出されない。各プロバイダ内部で Zod バリデーションを行うか、discriminated union で型安全性を確保すべき。

```typescript
// Bad: config が any
export interface ProviderOptions {
  config?: any; // 型安全でない
}

// Better: ジェネリクスか Zod による実行時バリデーション
export interface ProviderOptions<T = unknown> {
  config?: T;
}
```

## 導出ルール

- `[MUST]` 宣言的設定層と内部表現層を明確に分離し、変換ロジックを一箇所に集約する
  - 根拠: promptfoo は `TestSuiteConfig`（ユーザ設定）と `TestSuite`（内部表現）を分離し、`evaluate()` 関数で一括変換している（`src/index.ts:63-74`）。これにより設定バリデーションとランタイムロジックの関心が分離される。

- `[MUST]` 多数のバックエンド実装を統一的に扱う場合、共通インターフェースを定義し、Factory パターンで文字列識別子から実装を解決する
  - 根拠: `ApiProvider` インターフェース（`id()` + `callApi()`）と `ProviderFactory`（`test()` + `create()`）の組み合わせで、100+ プロバイダを 30 行以内のエントリで追加できる構造を実現している（`src/providers/registry.ts`）。

- `[SHOULD]` 宣言的 DSL では表現しきれないロジックのために、統一的なエスケープハッチ機構を提供する
  - 根拠: `file://` プロトコルがプロンプト・プロバイダ・テスト・アサーション・トランスフォーム全てで一貫して使える設計により、宣言性を保ちつつ任意の複雑さに対応している（`src/util/file.ts:56`）。

- `[SHOULD]` API キーや外部依存なしで動作する最小構成（ゼロコストモード）を提供し、ユーザの初回体験のハードルを下げる
  - 根拠: `echo` プロバイダと `providerOutput` フィールドにより、LLM API キーなしで設定構文の検証やアサーションのデバッグが可能（`src/providers/echo.ts`, `src/types/index.ts:786`）。

- `[SHOULD]` 環境変数からユーザの利用可能なバックエンドを自動検出し、合理的なデフォルトを選択する
  - 根拠: `getDefaultProviders()` が API キーの存在を検出して最適なプロバイダセットを自動選択する（`src/providers/defaults.ts:68-238`）。設定の記述量を最小化しつつ、明示的な上書きも許容する。

- `[SHOULD]` Factory 登録の順序を「具体的なパターン → 汎用的なパターン」に保つルールを強制する
  - 根拠: `providerMap` 配列で `anthropic:claude-agent-sdk` が `anthropic:` より先に登録されている（`src/providers/registry.ts:216-266`）。順序を間違えると汎用パターンが先にマッチし、特殊なプロバイダが到達不能になる。

- `[AVOID]` 宣言的設定の型定義にワイルドカード型（`any`）を使う。バックエンド固有の設定であっても、実行時バリデーション（Zod 等）で型安全性を確保する
  - 根拠: `ProviderOptions.config?: any`（`src/types/providers.ts:53`）は設定ミスがランタイムまで検出されない。各プロバイダ内部での Zod バリデーションや discriminated union で補完すべき。

## 適用チェックリスト

- [ ] ユーザ向け設定（YAML/JSON）と内部表現を別の型で定義し、変換レイヤーを一箇所に集約しているか
- [ ] 多数のバックエンド実装を扱う場合、共通インターフェースと Factory パターンで文字列から実装を解決しているか
- [ ] 宣言的 DSL の制約を超えるロジックのために、統一的なエスケープハッチ（`file://` 等）を用意しているか
- [ ] API キーや外部依存なしで基本動作を確認できるゼロコストモード（echo/mock プロバイダ等）を提供しているか
- [ ] 環境変数に基づくデフォルト自動選択で、ユーザの設定記述量を最小化しているか
- [ ] Factory/Registry パターンの登録順序が「具体→汎用」になるよう、ドキュメントまたはテストで保護しているか
- [ ] 設定スキーマの JSON Schema を自動生成し、エディタ補完を有効にしているか
