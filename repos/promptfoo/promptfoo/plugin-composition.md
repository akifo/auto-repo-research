# plugin-composition

> リポジトリ: promptfoo/promptfoo
> 分析日: 2026-02-21

## 概要

promptfoo のプラグイン・プロバイダ・アサーション合成パターンを分析した。100以上の LLM プロバイダ、60以上の Red Team プラグイン、50以上のアサーションハンドラがそれぞれ独立したレジストリによって管理されている。これら3つのサブシステムが共通のインターフェースと Factory パターンで統合され、設定ファイルの文字列1つから動的にコンポーネントが解決・合成される仕組みは、大規模プラグインアーキテクチャの実践例として注目に値する。

## 背景にある原則

- **文字列プレフィックスによる統一的な解決**: すべてのプロバイダ・プラグインを `prefix:type:name` 形式の文字列で一意に識別し、設定ファイルから動的にインスタンス化できるようにしている。YAML/JSON の宣言的設定だけで複雑なコンポーネント合成を実現するには、人間が読める識別子から実装への変換が一貫している必要があるため。`src/providers/index.ts:153-165` のループが全プロバイダをこのパターンで解決する。

- **生成と評価の対称的分離**: 各プラグインは必ず「テストケース生成器（Plugin）」と「評価器（Grader）」のペアとして実装される。これにより、生成ロジックを変更せずに評価基準だけを差し替える、またはその逆が可能になる。`src/redteam/plugins/hallucination.ts` では `HallucinationPlugin` と `HallucinationGrader` が同一ファイルに共存しつつ完全に独立している。

- **Template Method による拡張ポイントの固定化**: 基底クラス `RedteamPluginBase` が生成フロー全体を制御し、サブクラスは `getTemplate()` と `getAssertions()` のみオーバーライドする。フレームワークが「何を」「どの順序で」実行するかを決め、プラグイン作者は「何を生成し、何を検証するか」だけに集中できる。

- **コレクション定義による宣言的な合成**: 個々のプラグインを直接列挙するのではなく、`FOUNDATION_PLUGINS`, `MEDICAL_PLUGINS`, `ECOMMERCE_PLUGINS` のようなコレクション定数で論理グループを定義する。ユーザーは `collections: [medical, financial]` と書くだけで数十のプラグインが一括適用される。`src/redteam/constants/plugins.ts:38-83`

## 実例と分析

### プロバイダレジストリ: test/create ペアによる動的ルーティング

プロバイダレジストリ (`src/providers/registry.ts`) は `ProviderFactory` インターフェースを中心に構成される。各 factory は `test` メソッドで文字列パスを判定し、`create` メソッドでインスタンスを生成する。

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

100以上のプロバイダが1つの配列 `providerMap` に登録され、`loadApiProvider` が先頭から順にマッチングする（`src/providers/index.ts:153-165`）。この Chain of Responsibility 的な構造により、新しいプロバイダの追加は配列への要素追加だけで完結する。

特筆すべきは、スクリプトベースプロバイダの共通化パターンである。Python/Go/Ruby/Exec の4言語が `createScriptBasedProviderFactory` 1つの関数で統一的に扱われている。

```typescript
// src/providers/scriptBasedProvider.ts:13-17
export function createScriptBasedProviderFactory(
  prefix: string,
  fileExtension: string | null,
  providerConstructor: new (scriptPath: string, options: ProviderOptions) => ApiProvider,
)
```

### プラグインの3層構造: Base → Specialized Base → Concrete

Red Team プラグインは明確な3層の継承階層を持つ。

**第1層: `RedteamPluginBase`** — 全プラグイン共通のテストケース生成ロジック。バッチ生成、重複排除、リトライ、モディファイア適用を担う（`src/redteam/plugins/base.ts:33-296`）。

**第2層: 特化型基底クラス** — ドメイン固有の共通処理を担う。
- `ImageDatasetPluginBase` — HuggingFace データセットからのテストケース生成（`src/redteam/plugins/imageDatasetPluginBase.ts:19-146`）
- `AlignedHarmfulPlugin` — harm カテゴリごとの動的プロンプト切り替え（`src/redteam/plugins/harmful/aligned.ts:11-72`）

**第3層: 具象プラグイン** — ドメイン固有のテンプレートとアサーションのみ定義。`HallucinationPlugin`, `EcommerceOrderFraudPlugin` など60以上。

### Factory 関数によるプラグイン→TestCase 変換の統一

`createPluginFactory` がクラスコンストラクタを受け取り、ローカル/リモート生成の分岐を隠蔽する。

```typescript
// src/redteam/plugins/index.ts:160-190
function createPluginFactory<T extends PluginConfig>(
  PluginClass: PluginClass<T>,
  key: string,
  validate?: (config: T) => void,
): PluginFactory {
  return {
    key,
    validate: validate as ((config: PluginConfig) => void) | undefined,
    action: async ({ provider, purpose, injectVar, n, delayMs, config }: PluginActionParams) => {
      if ((PluginClass as any).canGenerateRemote === false || !shouldGenerateRemote()) {
        return new PluginClass(provider, purpose, injectVar, config as T).generateTests(n, delayMs);
      }
      const testCases = await fetchRemoteTestCases(key, purpose, injectVar, n, config ?? {});
      // ...
    },
  };
}
```

`validate` をオプショナルに渡すことで、設定バリデーションをプラグイン登録時に宣言的に組み込んでいる（例: `IntentPlugin` は `config.intent` 必須、`PolicyPlugin` は `config.policy` の構造検証）。

### アサーションハンドラの型安全な静的ディスパッチ

アサーションシステムは `ASSERTION_HANDLERS` オブジェクトで型名→ハンドラ関数のマッピングを静的に定義する。

```typescript
// src/assertions/index.ts:117-200
const ASSERTION_HANDLERS: Record<
  BaseAssertionTypes,
  (params: AssertionParams) => GradingResult | Promise<GradingResult>
> = {
  'answer-relevance': handleAnswerRelevance,
  bleu: handleBleuScore,
  classifier: handleClassifier,
  // ... 50以上のハンドラ
};
```

Red Team アサーション（`promptfoo:redteam:*` プレフィックス）は特別扱いで、`ASSERTION_HANDLERS` ではなく `getGraderById` による動的解決が行われる（`src/assertions/index.ts:481-483`）。この2段階ディスパッチにより、組み込みアサーションの高速な静的ルックアップと、プラグイン由来アサーションの柔軟な動的解決を両立している。

### Grader レジストリ: プラグインIDによる暗黙的結合

`src/redteam/graders.ts` の `GRADERS` レコードは、プラグインID文字列をキーとして Grader インスタンスを保持する。`getGraderById` はまず完全一致を試み、マッチしなければ `promptfoo:redteam:harmful` プレフィックスへのフォールバックを行う。

```typescript
// src/redteam/graders.ts:271-286
export function getGraderById(id: string): RedteamGraderBase | undefined {
  if (!id) return undefined;
  const grader = id in GRADERS ? GRADERS[id as keyof typeof GRADERS] : undefined;
  if (!grader && id.startsWith('promptfoo:redteam:harmful')) {
    return GRADERS['promptfoo:redteam:harmful'];
  }
  return grader;
}
```

このフォールバック機構により、`harmful:*` カテゴリの新規追加時に専用 Grader が不要な場合は汎用 `HarmfulGrader` が自動適用される。

### カスタムプラグインの合成: generator + grader の宣言的定義

`CustomPlugin` はユーザーが YAML で `generator`（テンプレート）と `grader`（ルーブリック）を定義するだけでプラグインを作成できる仕組みである。Zod スキーマによるバリデーション付き。

```typescript
// src/redteam/plugins/custom.ts:10-16
const CustomPluginDefinitionSchema = z.strictObject({
  generator: z.string().min(1, 'Generator must not be empty').trim(),
  grader: z.string().min(1, 'Grader must not be empty').trim(),
  threshold: z.number().optional(),
  metric: z.string().optional(),
  id: z.string().optional(),
});
```

## パターンカタログ

- **Template Method** (分類: 振る舞い)
  - 解決する問題: プラグインごとに異なるテスト生成ロジックのカスタマイズポイントを制御する
  - 適用条件: 生成フロー（バッチ処理、リトライ、重複排除）は共通で、テンプレートとアサーション定義だけが異なる場合
  - コード例: `src/redteam/plugins/base.ts:33-296` — `generateTests` が骨格、`getTemplate`/`getAssertions` が拡張ポイント
  - 注意点: 拡張ポイントが `abstract` で強制されるため、不要なメソッドも実装が必要になる

- **Abstract Factory** (分類: 生成)
  - 解決する問題: プラグインクラスからテストケースへの変換を統一的に扱い、ローカル/リモート生成を透過的に切り替える
  - 適用条件: 同一インターフェースのオブジェクトを異なるコンテキスト（ローカル/リモート）で生成する場合
  - コード例: `src/redteam/plugins/index.ts:160-190` — `createPluginFactory`
  - 注意点: factory 内で静的プロパティ `canGenerateRemote` を `(PluginClass as any)` でアクセスしており、型安全性を犠牲にしている

- **Chain of Responsibility** (分類: 振る舞い)
  - 解決する問題: 100以上のプロバイダから文字列パスに基づいて適切なものを選択する
  - 適用条件: 判定ロジックが各ハンドラに分散しており、順序付きで最初にマッチしたものを使う場合
  - コード例: `src/providers/registry.ts:136-1708` — `providerMap` 配列を先頭から走査
  - 注意点: 配列の順序が重要。`anthropic:claude-agent-sdk` が `anthropic:` より先に登録されないと正しくルーティングされない

- **Strategy** (分類: 振る舞い)
  - 解決する問題: アサーション評価のアルゴリズムを型名に基づいて動的に差し替える
  - 適用条件: 同一シグネチャの評価関数が多数存在し、実行時に選択する場合
  - コード例: `src/assertions/index.ts:117-200` — `ASSERTION_HANDLERS` による静的マップ

## Good Patterns

- **Plugin + Grader ペアのコロケーション**: プラグイン（テスト生成）と Grader（テスト評価）を同一ファイルに配置し、プラグインIDで暗黙的に結合する。変更の局所性が高く、新しいプラグイン追加時に触るファイルは1つ（+レジストリ登録）で済む。

```typescript
// src/redteam/plugins/hallucination.ts:20-97
export class HallucinationPlugin extends RedteamPluginBase {
  readonly id = PLUGIN_ID;
  protected async getTemplate(): Promise<string> { /* ... */ }
  protected getAssertions(_prompt: string): Assertion[] {
    return [{ type: PLUGIN_ID, metric: 'Hallucination' }];
  }
}
export class HallucinationGrader extends RedteamGraderBase {
  readonly id = PLUGIN_ID;
  rubric = `...`;
}
```

- **コレクション定数による宣言的グループ化**: 業界別プラグインセットを `as const` 付き配列で定義し、ユーザーがコレクション名を指定するだけで複数プラグインを一括有効化できる。追加・削除が配列操作だけで完結する。

```typescript
// src/redteam/constants/plugins.ts:242-254
export const FINANCIAL_PLUGINS = [
  'financial:calculation-error',
  'financial:compliance-violation',
  // ... 11プラグイン
] as const;
```

- **Zod スキーマによるカスタムプラグイン入力検証**: ユーザー定義プラグインの設定を Zod `strictObject` で検証し、不正な設定を早期にエラーとして報告する。`z.prettifyError` で人間が読めるエラーメッセージを生成している。

```typescript
// src/redteam/plugins/custom.ts:10-16, 23-37
const CustomPluginDefinitionSchema = z.strictObject({
  generator: z.string().min(1, 'Generator must not be empty').trim(),
  grader: z.string().min(1, 'Grader must not be empty').trim(),
  // ...
});
const result = CustomPluginDefinitionSchema.safeParse(maybeLoadFromExternalFile(filePath));
```

## Anti-Patterns / 注意点

- **Grader レジストリの手動同期**: プラグインを追加するたびに `src/redteam/graders.ts` の `GRADERS` レコードに手動でエントリを追加する必要がある。プラグインと Grader が同一ファイルに定義されていても、レジストリ登録は別ファイルで行われるため、登録忘れが起きやすい。

```typescript
// Bad: 手動で120以上のエントリを管理
export const GRADERS: Record<RedteamAssertionTypes, RedteamGraderBase> = {
  'promptfoo:redteam:aegis': new AegisGrader(),
  'promptfoo:redteam:beavertails': new BeavertailsGrader(),
  // ... 120行以上続く
};
```

```typescript
// Better: デコレータや自動登録でプラグインファイルから Grader を収集
// @RegisterGrader('promptfoo:redteam:hallucination')
// export class HallucinationGrader extends RedteamGraderBase { ... }
```

- **Provider レジストリの順序依存性**: `providerMap` 配列では、より具体的なプレフィックス（`anthropic:claude-agent-sdk`）が汎用プレフィックス（`anthropic:`）より先に登録される必要がある。この暗黙の順序制約はコメントで説明されておらず、プロバイダ追加時に順序を誤るとルーティングバグになる。

```typescript
// Bad: 順序を間違えると claude-agent-sdk が anthropic: にマッチしてしまう
// registry.ts の配列順序に暗黙の依存がある

// Better: 最長一致やプレフィックスツリーで自動的に具体的なマッチを優先する
```

## 導出ルール

- `[MUST]` プラグインシステムでは「生成」と「評価」を独立したコンポーネントとして設計し、同一IDで結合する
  - 根拠: promptfoo は Plugin（生成）と Grader（評価）を分離しつつプラグインIDで結合することで、生成ロジックを変えずに評価基準だけ差し替えられる柔軟性を実現している（`src/redteam/plugins/hallucination.ts`）

- `[MUST]` 拡張ポイントが3つ以上あるプラグイン基底クラスでは、Template Method パターンで骨格を固定し、サブクラスのオーバーライド対象を `abstract` で明示する
  - 根拠: `RedteamPluginBase` は `getTemplate`/`getAssertions` のみ abstract とし、バッチ処理・リトライ・モディファイア適用は基底クラスに閉じ込めることで、60以上のプラグインが一貫した生成フローを保っている（`src/redteam/plugins/base.ts:33-296`）

- `[SHOULD]` 文字列ベースのコンポーネント解決では、プレフィックス判定を `test` / インスタンス生成を `create` とする2フェーズの Factory を採用する
  - 根拠: `ProviderFactory` の `test`/`create` 分離により、100以上のプロバイダを1つの配列で管理しつつ、マッチング判定と生成ロジックを明確に分離している（`src/providers/registry.ts:127-134`）

- `[SHOULD]` プラグインのカテゴリ別コレクションを `as const` 付き配列で定義し、ユーザーがコレクション名で一括選択できるようにする
  - 根拠: `FINANCIAL_PLUGINS`, `MEDICAL_PLUGINS` 等の定数配列により、11〜12個のプラグインを `financial` の一語で有効化でき、個別列挙のミスを防いでいる（`src/redteam/constants/plugins.ts:242-298`）

- `[SHOULD]` カスタムプラグイン定義には Zod 等のスキーマバリデーションを適用し、不正な設定をインスタンス化前に検出する
  - 根拠: `CustomPluginDefinitionSchema` が `z.strictObject` で未知フィールドを拒否し、`z.prettifyError` で人間が読めるエラーを出力している（`src/redteam/plugins/custom.ts:10-37`）

- `[AVOID]` プラグインと評価器のレジストリを別ファイルで手動管理する構造（登録忘れの温床になる）
  - 根拠: `src/redteam/graders.ts` には120以上のエントリが手動で列挙されており、新プラグイン追加時にこのファイルの更新を忘れると実行時エラーになる

- `[AVOID]` 配列型レジストリで暗黙の順序依存を作ること（より具体的なプレフィックスが先に来る必要がある等）
  - 根拠: `providerMap` では `anthropic:claude-agent-sdk` が `anthropic:` より前に登録される必要があるが、この制約はコードコメントにも型にも表現されていない（`src/providers/registry.ts:216-266`）

## 適用チェックリスト

- [ ] プラグインシステムに「生成」と「評価」の分離があるか。両者が密結合している場合、共通IDによる疎結合に分離できないか検討する
- [ ] プラグイン基底クラスの拡張ポイントが `abstract` メソッドとして明示されているか。暗黙のオーバーライド対象がないか確認する
- [ ] コンポーネントの動的解決に文字列プレフィックスを使っている場合、`test`/`create` の2フェーズ Factory になっているか
- [ ] 業界別・カテゴリ別のプラグインセットが宣言的なコレクション定数として定義されているか
- [ ] カスタムプラグインの入力にスキーマバリデーションが適用されているか
- [ ] レジストリの登録がプラグイン定義と同じファイルまたは自動収集で行われているか（手動同期の必要がないか）
- [ ] 配列型レジストリに暗黙の順序依存がないか。ある場合、最長一致や優先度属性で明示化できないか
