# assertion-patterns

> リポジトリ: promptfoo/promptfoo
> 分析日: 2026-02-21

## 概要

promptfoo は LLM 出力の品質評価フレームワークであり、50 種以上のアサーション型を型安全に管理し、決定論的チェックから LLM-as-judge までを統一パイプラインで実行する。この視点では、アサーション型の定義・ディスパッチ・合成パイプラインの設計パターンを分析し、「多種多様な評価基準を一貫した型とインターフェースでどう管理するか」という普遍的課題に対するプラクティスを抽出する。特に、Zod スキーマによる型定義、Handler Map パターンによるディスパッチ、`not-` プレフィックスでの反転、`GradingResult` という統一戻り値型が注目に値する。

## 背景にある原則

- **統一結果型の原則**: すべてのアサーションハンドラは `GradingResult`（`{pass, score, reason}` の 3 フィールド必須）を返す。決定論的チェック（文字列含有）も非決定論的チェック（LLM-as-judge）も同一型に収束させることで、スコア集約・重み付け・閾値判定をアサーション種別に依存しない汎用ロジックとして実装できる。根拠: `src/assertions/assertionsResult.ts:70` の `addResult` は `GradingResult` の `score` と `weight` のみで重み付き平均を計算しており、個別型を意識しない。

- **型による網羅性保証の原則**: アサーション型を Zod enum で閉じた集合として定義し、`Record<BaseAssertionTypes, Handler>` でハンドラマップを構成することで、型の追加時にハンドラ未実装をコンパイル時に検出する。根拠: `src/assertions/index.ts:117-200` の `ASSERTION_HANDLERS` は `Record<BaseAssertionTypes, ...>` 型で、Zod enum に追加されたがハンドラが未定義の型はコンパイルエラーになる。

- **合成によるプレフィックス拡張の原則**: `not-` プレフィックスで既存の全アサーション型を反転版として自動生成する。各ハンドラは `inverse` パラメータを受け取り、自身のロジック内で結果を反転する。型定義側では `NotPrefixed<T>` テンプレートリテラル型で型安全性を維持する。根拠: `src/types/index.ts:578-591` の型定義と `src/assertions/index.ts:237-250` の `isAssertionInverse` / `getAssertionBaseType`。

- **段階的複雑性の原則**: 同一の `value` フィールドが文字列・数値・配列・オブジェクト・関数・`file://` 参照と多形的に解釈される。シンプルなユースケースでは文字列一つで済み、高度なケースでは Python/JavaScript 関数やスキーマ定義にスケールする。根拠: `src/types/index.ts:679` の `AssertionValue` 型と `src/assertions/index.ts:321-402` の値解決ロジック。

## 実例と分析

### 型安全なアサーション型の定義戦略

promptfoo は Zod の `z.enum` で基本型を定義し、そこから TypeScript 型を `z.infer` で導出する。さらに `not-` プレフィックス版をテンプレートリテラル型で自動生成し、特殊型（`select-best`, `human`, `max-score`）やレッドチーム型を union で合成する。これにより「定義は Zod に一元化、TypeScript 型は導出」という Single Source of Truth が成立する。

ランタイムバリデーションも同じスキーマを使い、`validateAssertions.ts` で設定ファイル読み込み時に `AssertionOrSetSchema.safeParse()` でバリデーションする。エラーメッセージには YAML 記法のヒントを含め、ユーザーフレンドリーに設計されている。

### ハンドラマップによるディスパッチ

`ASSERTION_HANDLERS` は `Record<BaseAssertionTypes, Handler>` として定義され、型と関数の対応を宣言的に表現する。ディスパッチは `runAssertion` 関数の末尾で `handler = ASSERTION_HANDLERS[baseType]` と O(1) で解決する。レッドチーム型のみ `startsWith('promptfoo:redteam:')` で事前フィルタされる。

特筆すべきは `meteor` 型のハンドラで、オプショナル依存（`natural` パッケージ）を dynamic import で遅延読み込みし、未インストール時にはインストール手順を `reason` に含めたグレースフルエラーを返す。

### LLM-as-judge 統合パターン

LLM-as-judge 系のアサーション（`llm-rubric`, `g-eval`, `factuality` 等）は 2 層構造を取る。薄いアサーションハンドラ（`src/assertions/llmRubric.ts` 等）が入力バリデーションと前処理を担い、実際の LLM 呼び出しは `src/matchers.ts` の共有関数（`matchesLlmRubric` 等）に委譲する。この分離により、マッチャー関数はアサーションフレームワーク外からも呼び出し可能になる。

`matchesLlmRubric` は LLM の応答を JSON として解析し、`pass` フィールドの真偽判定を柔軟に行う（`true/yes/pass/y` をすべて受容）。スコアも `number` 変換に失敗した場合は `Number(pass)` にフォールバックする。

### 階層的アサーションセット

`assert-set` 型により、アサーションをグループ化して独自の閾値を設定できる。`runAssertions` 関数は `AssertionsResult` クラスの階層構造でこれを実現する。メインのアサーション群と `assert-set` 内のサブアサーション群それぞれに `AssertionsResult` インスタンスを持ち、サブ結果を集約してメインに追加する。

### スクリプト値の安全な解決

`runAssertion` 内の値解決ロジックは、`file://` 参照からスクリプトを実行した結果をどのアサーション型に渡すかを厳密に制御する。`javascript/python/ruby` 型のみがスクリプト結果をそのまま評価でき、他の型では `boolean` や `GradingResult` の返却を明示的にエラーとする。これにより型の混同を防ぐ。

### 自動合成パイプライン

`synthesis.ts` は既存のテストケースとプロンプトから LLM を使って新しいアサーションを自動生成する。生成された質問が決定論的に評価可能なら Python コードに変換し、そうでなければ `llm-rubric` や `g-eval` として出力する。

## コード例

```typescript
// src/types/index.ts:514-576 — Zod enum による型定義と自動導出
export const BaseAssertionTypesSchema = z.enum([
  "answer-relevance",
  "bleu",
  "classifier",
  "contains",
  // ... 50+ types
  "word-count",
]);

export type BaseAssertionTypes = z.infer<typeof BaseAssertionTypesSchema>;

type NotPrefixed<T extends string> = `not-${T}`;

export const NotPrefixedAssertionTypesSchema = BaseAssertionTypesSchema.transform(
  (baseType) => `not-${baseType}` as NotPrefixed<BaseAssertionTypes>,
);

export const AssertionTypeSchema = z.union([
  BaseAssertionTypesSchema,
  NotPrefixedAssertionTypesSchema,
  SpecialAssertionTypesSchema,
  z.custom<RedteamAssertionTypes>(),
]);
```

```typescript
// src/assertions/index.ts:117-200 — Record 型によるハンドラマップ
const ASSERTION_HANDLERS: Record<
  BaseAssertionTypes,
  (params: AssertionParams) => GradingResult | Promise<GradingResult>
> = {
  "answer-relevance": handleAnswerRelevance,
  bleu: handleBleuScore,
  contains: handleContains,
  // ... 全型に対応するハンドラ
  "word-count": handleWordCount,
};
```

```typescript
// src/assertions/assertionsResult.ts:59-110 — 重み付きスコア集約
addResult({ index, result, metric, weight = 1 }: { ... }) {
  this.totalScore += result.score * weight;
  this.totalWeight += weight;
  this.componentResults[index] = result;
  // ...
  if (result.pass) { return; }
  this.failedReason = result.reason;
  if (getEnvBool('PROMPTFOO_SHORT_CIRCUIT_TEST_FAILURES')) {
    throw new Error(result.reason);
  }
}
```

```typescript
// src/assertions/index.ts:404-447 — スクリプト値の型安全な解決
const SCRIPT_RESULT_ASSERTIONS = new Set(["javascript", "python", "ruby"]);
const baseType = getAssertionBaseType(assertion);

if (valueFromScript !== undefined && !SCRIPT_RESULT_ASSERTIONS.has(baseType)) {
  if (typeof valueFromScript === "function") {
    throw new Error(
      `Script for "${assertion.type}" assertion returned a function. `
        + `Only javascript/python/ruby assertion types can return functions.`,
    );
  }
  if (typeof valueFromScript === "boolean") {
    throw new Error(
      `Script for "${assertion.type}" assertion returned a boolean. `
        + `Only javascript/python/ruby assertion types can return boolean values.`,
    );
  }
  renderedValue = valueFromScript as AssertionValue;
}
```

```typescript
// src/assertions/validateAssertions.ts:21-72 — Zod スキーマによるバリデーションと親切なエラー
function parseAssertion(assertion: unknown, context: string): Assertion | AssertionSet {
  if (!("type" in assertionObj) || assertionObj.type === undefined) {
    throw new AssertValidationError(
      `Invalid assertion at ${context}:\n`
        + `Missing required 'type' property\n\n`
        + `Hint: In YAML, ensure all assertion properties are under the same list item:\n`
        + `  assert:\n`
        + `    - type: python\n`
        + `      value: file://script.py   # No '-' before 'value'`,
    );
  }
  const result = AssertionOrSetSchema.safeParse(assertion);
  // ...
}
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 50 種以上のアサーション評価ロジックを統一インターフェースで切り替える
  - 適用条件: 同一のシグネチャで複数のアルゴリズムを交換可能にしたい場合
  - コード例: `src/assertions/index.ts:117-200` — `ASSERTION_HANDLERS` マップと `AssertionParams => GradingResult` の統一シグネチャ
  - 注意点: GoF の Strategy は通常クラスベースだが、ここでは関数マップで実現しており、より軽量。型によるマップキーの網羅性チェックがクラスベースより強力。

- **Composite パターン** (分類: 構造)
  - 解決する問題: 個別アサーションとアサーションセットを透過的に扱う
  - 適用条件: ツリー状に評価を構成し、サブグループごとに閾値を設定したい場合
  - コード例: `src/assertions/index.ts:546-569` — `assert-set` のフラット展開と `AssertionsResult` の階層構造
  - 注意点: 深いネストは閾値計算を複雑にするため、promptfoo では 2 階層に制限している

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: 値解決・変換・バリデーション・ディスパッチという共通フローの中で、個別ハンドラのみを差し替える
  - 適用条件: パイプラインの骨格が共通で、特定ステップのみカスタマイズしたい場合
  - コード例: `src/assertions/index.ts:252-512` — `runAssertion` が共通フロー（transform, Nunjucks render, script resolve, dispatch, weight=0 handling）を制御し、個別ハンドラを呼び出す
  - 注意点: `runAssertion` が肥大化するリスクがある。promptfoo では値解決ロジックの一部を `utils.ts` に分離して対処

## Good Patterns

- **Zod enum + Record 型による網羅性保証**: 型の追加は Zod enum に 1 行追加するだけでよく、ハンドラマップの未実装はコンパイルエラーになる。ランタイムバリデーションも同一スキーマを使うため、型定義とバリデーションの乖離が発生しない。
  ```typescript
  // src/assertions/index.ts:117-119
  const ASSERTION_HANDLERS: Record<
    BaseAssertionTypes,
    (params: AssertionParams) => GradingResult | Promise<GradingResult>
  > = {/* 全型のハンドラが必須 */};
  ```

- **統一パラメータオブジェクトによるハンドラの選択的分解**: `AssertionParams` という大きなパラメータオブジェクトをハンドラに渡し、各ハンドラは必要なプロパティのみを分割代入で取り出す。将来のパラメータ追加時に既存ハンドラの変更が不要。
  ```typescript
  // src/assertions/cost.ts:3 — 必要なフィールドのみ取り出す
  export const handleCost = ({ cost, assertion }: AssertionParams): GradingResult => { ... };

  // src/assertions/contextFaithfulness.ts:17 — より多くのフィールドを使うハンドラ
  export async function handleContextFaithfulness({
    assertion, test, output, prompt, providerResponse, providerCallContext,
  }: AssertionParams): Promise<GradingResult> { ... }
  ```

- **`not-` プレフィックスによる宣言的否定**: アサーション型の反転を型レベルで表現し、各ハンドラは `inverse` フラグで分岐するだけ。否定専用のハンドラを書く必要がなく、50 種すべてが自動的に否定可能。
  ```typescript
  // src/assertions/contains.ts:18 — inverse パラメータで結果を XOR
  const pass = outputString.includes(String(value)) !== inverse;
  ```

- **グレースフルなオプショナル依存ハンドリング**: `meteor` 型ハンドラは dynamic import の失敗をキャッチし、インストール手順を `reason` に含めた `GradingResult` を返す。プロセスクラッシュではなくフレームワーク内で完結するエラーハンドリング。
  ```typescript
  // src/assertions/index.ts:157-177
  meteor: async (params: AssertionParams) => {
    try {
      const { handleMeteorAssertion } = await import('./meteor.js');
      return handleMeteorAssertion(params);
    } catch (error) {
      if (error instanceof Error && error.message.includes('Cannot find module')) {
        return { pass: false, score: 0,
          reason: 'METEOR assertion requires the natural package. Please install it using: npm install natural@^8.1.0',
          assertion: params.assertion };
      }
      throw error;
    }
  },
  ```

## Anti-Patterns / 注意点

- **パラメータオブジェクトの肥大化**: `AssertionParams` は 15 個以上のフィールドを持ち、`runAssertion` で構築される。シンプルなハンドラ（`handleCost` は 2 フィールドのみ使用）にも全フィールドが渡される。直接の害はないが、新規開発者がどのフィールドを使うべきか判断しにくい。
  ```typescript
  // Bad: 使わないフィールドが多い
  export const handleCost = ({ cost, assertion }: AssertionParams): GradingResult => { ... };
  // 実際には AssertionParams の他 13 フィールドは未使用
  ```
  ```typescript
  // Better: ハンドラごとに Pick で必要型を明示する（equals.ts の実例）
  export const handleEquals = async ({
    assertion, renderedValue, outputString, inverse,
  }: Pick<AssertionParams, 'assertion' | 'renderedValue' | 'outputString' | 'inverse'>
  ): Promise<GradingResult> => { ... };
  ```

- **値解決ロジックの集中**: `runAssertion` 関数は値の解決（`file://` 参照、Nunjucks テンプレート、スクリプト実行、配列処理）を約 80 行にわたって処理しており、単一関数としては複雑度が高い。テスト対象として独立抽出が望ましい。
  ```typescript
  // Bad: runAssertion 内に 80 行の値解決ロジックが直書き
  // src/assertions/index.ts:317-447
  ```
  ```typescript
  // Better: resolveAssertionValue(assertion, vars, context) として関数抽出する
  ```

## 導出ルール

- `[MUST]` 評価ハンドラの戻り値型は `{pass: boolean, score: number, reason: string}` の 3 フィールドを必須とする統一型にする
  - 根拠: promptfoo の `GradingResult` はこの設計により、50 種以上のアサーションの結果を重み付き平均・閾値判定・名前付きメトリクスといった共通ロジックで処理可能にしている（`src/assertions/assertionsResult.ts:70`）

- `[MUST]` 評価種別の列挙型とハンドラマップを `Record<EnumType, Handler>` で定義し、型の追加時にハンドラ未実装をコンパイルエラーにする
  - 根拠: `ASSERTION_HANDLERS` が `Record<BaseAssertionTypes, Handler>` で型付けされており、Zod enum に型を追加するとハンドラ未定義がビルド時に検出される（`src/assertions/index.ts:117`）

- `[SHOULD]` 共有パラメータオブジェクトを定義し、各ハンドラは分割代入で必要なフィールドのみ取り出す。可能なら `Pick<Params, ...>` で使用フィールドを型レベルで明示する
  - 根拠: `AssertionParams` は 15 フィールドを持つが、`handleEquals` は `Pick<AssertionParams, ...>` で 4 フィールドのみを型明示しており、ハンドラの依存が明確になっている（`src/assertions/equals.ts:10-13`）

- `[SHOULD]` 否定・反転は専用ハンドラを作らず、元のハンドラに `inverse` パラメータを渡して結果を反転する。型レベルでは `not-${BaseType}` のようなテンプレートリテラル型で表現する
  - 根拠: promptfoo は `not-` プレフィックスにより 50 種の否定版を 0 行の追加コードで提供している（`src/types/index.ts:578-591`）

- `[SHOULD]` オプショナル依存が必要なハンドラは dynamic import + catch でグレースフルに処理し、エラーメッセージにインストール手順を含める
  - 根拠: `meteor` ハンドラは `natural` パッケージ未インストール時にインストールコマンドを `reason` に含めた `GradingResult` を返し、プロセスクラッシュを回避している（`src/assertions/index.ts:157-177`）

- `[SHOULD]` 設定バリデーション時のエラーメッセージには、設定フォーマットのヒント（YAML インデントの例示等）を含める
  - 根拠: `validateAssertions.ts:38-42` では YAML の `assert` セクションの正しい書き方をエラーメッセージに含めており、設定ミスの修正コストを大幅に下げている

- `[AVOID]` 評価ハンドラの戻り値を `boolean` のみにすること。スコア（連続値）と理由文を失い、重み付き集約やデバッグが不可能になる
  - 根拠: `isGradingResult` の型ガードは `pass`, `score`, `reason` の 3 フィールドを必須としており、boolean 単独では処理パイプラインに乗らない（`src/types/index.ts:497-512`）

## 適用チェックリスト

- [ ] 評価ハンドラの戻り値型に `pass`, `score`, `reason` の 3 フィールドを必須にしているか
- [ ] 評価種別を Zod enum（または同等の列挙型）で定義し、`Record` 型でハンドラマップの網羅性を保証しているか
- [ ] 新しい評価種別を追加するとき、ハンドラ未実装がコンパイル時に検出される構造か
- [ ] 否定・反転ロジックはハンドラごとに重複実装せず、共通の `inverse` パラメータで処理しているか
- [ ] `assert-set` のようなグループ化メカニズムで、サブグループごとの閾値設定に対応しているか
- [ ] オプショナル依存（外部パッケージ等）の未インストール時にグレースフルエラーを返しているか
- [ ] 設定バリデーションエラーにフォーマットのヒントを含めているか
- [ ] LLM-as-judge 系の評価は、アサーションハンドラ（入力バリデーション）とマッチャー（LLM 呼び出し）を分離し、マッチャーを独立して再利用可能にしているか
