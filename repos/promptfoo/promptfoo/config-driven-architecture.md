# Config-Driven Architecture

> リポジトリ: promptfoo/promptfoo
> 分析日: 2026-02-21

## 概要

promptfoo は YAML/JSON/JS ファイルから設定を読み込み、バリデーション・正規化・テンプレート展開・JSON Reference 解決を経てランタイム構造（TestSuite）に変換する、多段パイプライン型の config-driven アーキテクチャを採用している。Zod スキーマが「設定の型定義」「ランタイムバリデーション」「JSON Schema 自動生成」の三役を一元的に担い、設定の正しさを複数レイヤーで保証する点が注目に値する。

## 背景にある原則

- **Single Source of Truth としての Zod スキーマ**: TypeScript 型・ランタイムバリデーション・JSON Schema（エディタ補完用）をすべて1つの Zod スキーマから導出することで、定義のズレを構造的に排除する。`UnifiedConfigSchema` から `z.infer<>` で型を、`z.toJSONSchema()` で JSON Schema を生成する設計がこれを具現化している（`src/types/index.ts:1203`, `scripts/generateJsonSchema.ts:52`）。

- **段階的バリデーションと正規化の分離**: 生の YAML 入力をいきなりランタイム構造に変換するのではなく、「読み込み → JSON $ref 解決 → 環境変数テンプレート展開 → スキーマバリデーション → エイリアス正規化 → ファイル参照解決 → セマンティックバリデーション」と各段階に責務を分離する。各ステップが明確な入出力を持つため、デバッグ容易性と拡張性を確保している（`src/util/config/load.ts:253-351`）。

- **寛容な入力、厳密な内部表現**: 設定ファイルでは `providers` と `targets`、`plugins` と `redteam.plugins` を同義に受け付けつつ、内部ではすべて正規化された形式に統一する。ユーザーの認知負荷を下げながら、コードベース内部では一貫した構造で扱うことを両立する（`src/util/config/load.ts:313-329`）。

- **バリデーションは警告優先、クラッシュは最小限**: `safeParse` で検証し、不正な設定に対しては `logger.warn` で警告を出すがプロセスを止めない。明示的な `validate` コマンド実行時のみ厳密にエラーを出す。ユーザー体験を損なわずに安全性を提供する設計判断（`src/util/config/load.ts:287-292`）。

## 実例と分析

### 多段パイプライン: YAML からランタイム構造への変換

`readConfig` 関数は設定ファイルの読み込みから正規化までの全段階を担う。パイプラインは以下の順序で処理される。

1. **ファイル読み込みとパース**: 拡張子に基づき YAML/JSON/JS を判定（`src/util/config/extensions.ts` で 9 種類の拡張子をサポート）
2. **JSON Reference 解決**: `@apidevtools/json-schema-ref-parser` による `$ref` の展開
3. **環境変数テンプレート展開**: Nunjucks テンプレートで `{{ env.VAR }}` を解決（2パスレンダリング）
4. **スキーマバリデーション**: Zod の `safeParse` による構造チェック
5. **エイリアス正規化**: `targets` → `providers`、`plugins` → `redteam.plugins` 等の変換
6. **デフォルト値注入**: `prompts` 未指定時に `['{{prompt}}']` をフォールバック設定

### 環境変数テンプレートの2パスレンダリング

`renderConfigEnvTemplates` は config.env 自体が `{{ env.VAR }}` を含む問題を解決するため2パスで展開する。Pass 1 で `config.env` を `process.env` のみから展開し、Pass 2 で展開済みの `config.env` をオーバーライドとして全体を展開する。この設計により、`config.env` 内の循環参照や watch/reload 時の stale state 問題を回避している。

### 複数設定ファイルのマージ戦略

`combineConfigs` は glob パターンを含む複数の設定ファイルを1つの `UnifiedConfig` に統合する。providers はデデュプ（JSON.stringify ベース）、tests は単純連結、defaultTest はオブジェクトのディープマージ、sharing は `false` が優先（any-false-wins）という異なるマージ戦略を要素ごとに使い分けている。

### JSON Schema の自動生成パイプライン

`scripts/generateJsonSchema.ts` は Zod v4 の `z.toJSONSchema()` を使い、`UnifiedConfigSchema` から JSON Schema (Draft-07) を自動生成する。`.pipe()` / `.transform()` でラップされた Zod スキーマは標準の変換では失われるため、`getBaseSchema` で内部スキーマを再帰的にアンラップする独自ロジックを実装している。生成されたスキーマは `site/static/config-schema.json` に配置され、YAML ファイルの `# yaml-language-server: $schema=...` コメントでエディタ補完に利用される。

### セマンティックバリデーション層

構造的なスキーマバリデーション（Zod）とは別に、ドメイン固有のセマンティックバリデーションを専用関数で実施している。`validateAssertions` はアサーション構造の整合性を、`validateTestProviderReferences` はテストケースが参照する provider が実際に存在するかを、`validateTestPromptReferences` はプロンプト参照の妥当性を検証する。これらはスキーマでは表現できない「参照整合性」を実行時に保証する。

## コード例

```typescript
// src/util/config/load.ts:253-311
// 設定ファイル読み込みの多段パイプライン
export async function readConfig(configPath: string): Promise<UnifiedConfig> {
  let ret: UnifiedConfig & {
    targets?: UnifiedConfig['providers'];
    plugins?: RedteamPluginObject[];
    strategies?: RedteamStrategyObject[];
  };
  const ext = path.parse(configPath).ext;
  if (ext === '.json' || ext === '.yaml' || ext === '.yml') {
    const rawConfig = yaml.load(await fsPromises.readFile(configPath, 'utf-8')) ?? {};
    const dereferencedConfig = await dereferenceConfig(rawConfig as UnifiedConfig);
    const renderedConfig = renderConfigEnvTemplates(dereferencedConfig as UnifiedConfig);

    const UnifiedConfigSchemaWithoutPrompts = TestSuiteConfigSchema.extend({
      evaluateOptions: EvaluateOptionsSchema.optional(),
      commandLineOptions: CommandLineOptionsSchema.partial().optional(),
      providers: ProvidersSchema.optional(),
      targets: ProvidersSchema.optional(),
      prompts: TestSuiteConfigSchema.shape.prompts.optional(),
    }).refine(/* ... */);
    const validationResult = UnifiedConfigSchemaWithoutPrompts.safeParse(renderedConfig);
    if (!validationResult.success) {
      logger.warn(
        `Invalid configuration file ${configPath}:\n${z.prettifyError(validationResult.error)}`,
      );
    }
    ret = renderedConfig;
  }
  // ...
}
```

```typescript
// src/types/index.ts:1203-1235
// UnifiedConfig スキーマ: extend + refine + transform で入力の正規化を宣言的に表現
export const UnifiedConfigSchema = TestSuiteConfigSchema.extend({
  evaluateOptions: EvaluateOptionsSchema.optional(),
  commandLineOptions: CommandLineOptionsSchema.partial().optional(),
  providers: ProvidersSchema.optional(),
  targets: ProvidersSchema.optional(),
})
  .refine(
    (data) => {
      const hasTargets = data.targets !== undefined;
      const hasProviders = data.providers !== undefined;
      return (hasTargets && !hasProviders) || (!hasTargets && hasProviders);
    },
    {
      message: "Exactly one of 'targets' or 'providers' must be provided, but not both",
    },
  )
  .transform((data) => {
    if (data.targets && !data.providers) {
      data.providers = data.targets;
      delete data.targets;
    }
    if (data.extensions === null || data.extensions === undefined ||
        (Array.isArray(data.extensions) && data.extensions.length === 0)) {
      delete data.extensions;
    }
    return data;
  });
```

```typescript
// scripts/generateJsonSchema.ts:39-54
// Zod スキーマから JSON Schema を自動生成（pipe/transform のアンラップ処理付き）
const innerSchema = getInnerSchema(UnifiedConfigSchema);

const schemaContent = z.toJSONSchema(innerSchema, {
  ...nestedOptions,
  reused: 'ref' as const,
  override: (ctx: any) => {
    const zodSchema = ctx.zodSchema as ZodType;
    const def = zodSchema._def as { type?: string; in?: ZodType; innerType?: ZodType };
    if ((def?.type === 'optional' || def?.type === 'nullable') && def?.innerType) {
      const innerDef = def.innerType._def as { type?: string };
      if (innerDef?.type === 'pipe' || innerDef?.type === 'transform') {
        if (Object.keys(ctx.jsonSchema).length === 0) {
          const baseSchema = getBaseSchema(zodSchema);
          const result = z.toJSONSchema(baseSchema, nestedOptions);
          const { $schema: _, ...rest } = result as Record<string, unknown>;
          Object.assign(ctx.jsonSchema, rest);
        }
      }
    }
    // ...
  },
});
```

```typescript
// src/util/config/writer.ts:8-36
// 設定書き出し時のキー順序制御と JSON Schema コメント自動付与
export function writePromptfooConfig(
  config: Partial<UnifiedConfig>,
  outputPath: string,
  headerComments?: string[],
): Partial<UnifiedConfig> {
  const orderedConfig = orderKeys(config, [
    'description', 'targets', 'prompts', 'providers',
    'redteam', 'defaultTest', 'tests', 'scenarios',
  ]);
  const yamlContent = yaml.dump(orderedConfig, { skipInvalid: true });
  const schemaComment = `# yaml-language-server: $schema=https://promptfoo.dev/config-schema.json`;
  fs.writeFileSync(outputPath, `${schemaComment}\n${headerCommentLines}${yamlContent}`);
  return orderedConfig;
}
```

## パターンカタログ

- **Builder / Pipeline パターン** (分類: 生成)
  - 解決する問題: 生の設定データを段階的に変換・検証してランタイム構造に組み立てる
  - 適用条件: 設定の読み込みが複数の独立したステップ（解析、展開、検証、正規化）に分割できる場合
  - コード例: `src/util/config/load.ts:253-351` (`readConfig`) と `src/util/config/load.ts:609-935` (`resolveConfigs`)
  - 注意点: ステップの順序依存があるため、順序変更は慎重に行う必要がある（例: テンプレート展開はバリデーション前に必要）

- **Adapter パターン** (分類: 構造)
  - 解決する問題: ユーザー向けの複数の入力形式（`targets`/`providers`、string/array/function）を内部の統一表現に変換する
  - 適用条件: 外部インターフェースの互換性を維持しつつ内部表現を統一したい場合
  - コード例: `src/types/index.ts:1219-1234` (transform による正規化)、`src/validators/providers.ts:79-90` (ProvidersSchema の union 型)
  - 注意点: エイリアスの増加はドキュメント負荷を増やすため、導入は慎重に

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 設定フィールドごとに異なるマージ戦略（デデュプ、連結、ディープマージ、any-false-wins）を使い分ける
  - 適用条件: 複数ソースの設定を統合する際に、フィールドの性質に応じた統合ロジックが必要な場合
  - コード例: `src/util/config/load.ts:372-603` (`combineConfigs`)
  - 注意点: マージ戦略が暗黙的だとデバッグが困難になるため、戦略の選択理由をコメントで明示すべき

## Good Patterns

- **safeParse + warn（寛容バリデーション）**: `readConfig` では `safeParse` を使い、設定が不正でも `logger.warn` で警告するだけでプロセスを止めない。明示的に `validate` コマンドを実行したときのみ `process.exitCode = 1` を設定する。これにより「設定を少しずつ書きながら実行→修正」のイテレーションが妨げられない。

```typescript
// src/util/config/load.ts:287-292
const validationResult = UnifiedConfigSchemaWithoutPrompts.safeParse(renderedConfig);
if (!validationResult.success) {
  logger.warn(
    `Invalid configuration file ${configPath}:\n${z.prettifyError(validationResult.error)}`,
  );
}
```

- **Zod の extend + refine + transform チェーン**: `UnifiedConfigSchema` は `TestSuiteConfigSchema.extend()` でフィールドを追加し、`.refine()` で相互排他制約を表現し、`.transform()` でエイリアス正規化を行う。型安全性とランタイムの入力正規化を1つの宣言で実現している。

```typescript
// src/types/index.ts:1203-1235
export const UnifiedConfigSchema = TestSuiteConfigSchema.extend({
  evaluateOptions: EvaluateOptionsSchema.optional(),
  targets: ProvidersSchema.optional(),
})
  .refine((data) => {
    return (data.targets !== undefined) !== (data.providers !== undefined);
  }, { message: "Exactly one of 'targets' or 'providers'..." })
  .transform((data) => {
    if (data.targets && !data.providers) {
      data.providers = data.targets;
      delete data.targets;
    }
    return data;
  });
```

- **ドメイン特化の YAML ヒントを含むエラーメッセージ**: アサーションバリデーションのエラーメッセージに YAML の正しい書き方のヒントを含めている。設定駆動ツールでは「なぜ壊れたか」だけでなく「どう直すか」をエラーに含めることがユーザー体験を大幅に改善する。

```typescript
// src/assertions/validateAssertions.ts:35-42
throw new AssertValidationError(
  `Invalid assertion at ${context}:\n` +
    `Missing required 'type' property\n\n` +
    `Hint: In YAML, ensure all assertion properties are under the same list item:\n` +
    `  assert:\n` +
    `    - type: python\n` +
    `      value: file://script.py   # No '-' before 'value'`,
);
```

- **YAML 出力時のキー順序制御**: `writePromptfooConfig` は `orderKeys` で人間にとって読みやすい順序（description → providers → prompts → tests）にキーを並べ替えてから YAML を出力する。設定ファイルの可読性を自動的に保つ。

```typescript
// src/util/config/writer.ts:13-16
const orderedConfig = orderKeys(config, [
  'description', 'targets', 'prompts', 'providers',
  'redteam', 'defaultTest', 'tests', 'scenarios',
]);
```

## Anti-Patterns / 注意点

- **スキーマの `z.any()` / `z.custom()` の過剰使用**: `ProviderOptionsSchema` の `config: z.any()` や各所の `z.custom<T>()` は型安全性を実質的に無効化する。スキーマの一部が「何でも受け入れる」状態になると、JSON Schema 生成時に `{}` になり、エディタ補完が機能しない。

```typescript
// Bad: 型情報が失われ、バリデーションが機能しない
config: z.any().optional(),

// Better: 既知のフィールドを定義し、catchall で拡張を許容する
config: z.object({
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
}).catchall(z.unknown()).optional(),
```

- **readConfig 内でのバリデーション用スキーマの動的生成**: `readConfig` 関数内で `TestSuiteConfigSchema.extend()` を呼び出し、呼び出しのたびに新しいスキーマオブジェクトを生成している。スキーマはイミュータブルな定義なので、モジュールスコープに定数として定義すべき。

```typescript
// Bad: 関数呼び出しごとにスキーマを再生成
export async function readConfig(configPath: string) {
  const UnifiedConfigSchemaWithoutPrompts = TestSuiteConfigSchema.extend({ /* ... */ });
}

// Better: モジュールスコープで一度だけ定義
const ConfigValidationSchema = TestSuiteConfigSchema.extend({ /* ... */ });
export async function readConfig(configPath: string) {
  const result = ConfigValidationSchema.safeParse(renderedConfig);
}
```

- **マージ戦略の暗黙性**: `combineConfigs` では providers はデデュプ、tests は連結、sharing は any-false-wins と異なるマージ戦略を使うが、その理由がコード中に十分に説明されていない。後からフィールドを追加する開発者がマージ戦略を誤選択するリスクがある。

```typescript
// Bad: マージ戦略が暗黙的
const providers = []; // dedup by JSON.stringify
const tests = []; // concatenation
const sharing = configs.some(c => c.sharing === false) ? false : /* ... */; // any-false-wins

// Better: マージ戦略を型レベルで明示する
type MergeStrategy = 'dedup' | 'concat' | 'deepMerge' | 'anyFalseWins';
const fieldMergeStrategies: Record<string, MergeStrategy> = {
  providers: 'dedup',
  tests: 'concat',
  sharing: 'anyFalseWins',
};
```

## 導出ルール

- `[MUST]` 設定スキーマを Zod で定義し、TypeScript 型（`z.infer<>`）とランタイムバリデーション（`safeParse`）を同一ソースから導出する
  - 根拠: promptfoo では `UnifiedConfigSchema` が型・バリデーション・JSON Schema の単一ソースとなり、定義のズレを構造的に排除している（`src/types/index.ts:1203-1237`）

- `[MUST]` 設定ファイルのバリデーションエラーには「何が間違っているか」だけでなく「どう直すか」のヒントを含める
  - 根拠: promptfoo のアサーションバリデーションは YAML の正しい書き方をヒントとして表示し、ユーザーのデバッグ時間を大幅に削減している（`src/assertions/validateAssertions.ts:35-42`）

- `[SHOULD]` 設定の読み込みパイプラインを「パース → 参照解決 → テンプレート展開 → バリデーション → 正規化」のように明確なステップに分割し、各ステップの責務を1つに限定する
  - 根拠: promptfoo の `readConfig` は JSON $ref 解決・環境変数展開・Zod バリデーション・エイリアス正規化を分離した段階として実装し、各段階を独立にテスト・デバッグ可能にしている（`src/util/config/load.ts:253-351`）

- `[SHOULD]` ユーザー向けの設定フィールドにエイリアス（同義語）を許容する場合、Zod の `.transform()` で内部表現に正規化し、以降のコードでは正規化後の形式のみを扱う
  - 根拠: promptfoo は `targets` → `providers` の正規化を `UnifiedConfigSchema.transform()` 内で行い、内部コードが常に `providers` だけを参照すれば済むようにしている（`src/types/index.ts:1219-1224`）

- `[SHOULD]` 設定ファイルの書き出し時にキーの順序を制御し、人間にとって読みやすい順序を保証する
  - 根拠: `writePromptfooConfig` は `orderKeys` で description → providers → tests の順に並べ替え、生成された設定ファイルの可読性を自動的に担保している（`src/util/config/writer.ts:13-16`）

- `[SHOULD]` Zod スキーマから JSON Schema を自動生成し、YAML/JSON 設定ファイルにスキーマ参照コメントを付与してエディタ補完を有効にする
  - 根拠: promptfoo は `z.toJSONSchema()` で生成した JSON Schema を公開 URL に配置し、全設定ファイルに `# yaml-language-server: $schema=...` を付与して IDE 支援を実現している（`scripts/generateJsonSchema.ts`, `src/util/config/writer.ts:29`）

- `[AVOID]` スキーマ定義内での `z.any()` の多用。型安全性が失われるだけでなく、JSON Schema 生成時に `{}` になりエディタ補完が機能しなくなる
  - 根拠: `ProviderOptionsSchema` の `config: z.any()` は実質的にバリデーションを無効化しており、代わりに `z.object({}).catchall(z.unknown())` のように既知フィールドを定義したうえで拡張を許容するアプローチが望ましい（`src/validators/providers.ts:17`）

- `[AVOID]` 構造バリデーション（Zod）だけに頼り、参照整合性のセマンティックバリデーションを省略すること
  - 根拠: promptfoo はスキーマバリデーションに加えて `validateTestProviderReferences` / `validateTestPromptReferences` / `validateAssertions` で参照先の存在確認を行い、実行時エラーを未然に防いでいる（`src/util/config/load.ts:889-907`）

## 適用チェックリスト

- [ ] 設定型を Zod スキーマで定義し、`z.infer<>` で TypeScript 型を導出しているか
- [ ] 設定ファイルの読み込みパイプラインが「パース → 検証 → 正規化」の段階に分離されているか
- [ ] バリデーションに `safeParse` を使い、一般利用時は警告に留め、`validate` コマンドで厳密チェックする二段構えになっているか
- [ ] エイリアス（同義フィールド名）がある場合、正規化ステップで統一され、以降のコードが1つの名前だけを参照しているか
- [ ] バリデーションエラーメッセージに修正のヒント（正しい YAML の書き方等）が含まれているか
- [ ] 設定ファイルの書き出し時にキー順序が制御され、可読性が担保されているか
- [ ] Zod スキーマから JSON Schema を自動生成し、エディタ補完（yaml-language-server 等）が有効化されているか
- [ ] `z.any()` の使用箇所を最小限にし、既知フィールドの型情報が保持されているか
- [ ] スキーマでは表現できない参照整合性（テストが参照する provider が存在するか等）を専用のセマンティックバリデーション関数で検証しているか
- [ ] 複数設定ファイルのマージ時に、各フィールドのマージ戦略（デデュプ/連結/ディープマージ）が明文化されているか
