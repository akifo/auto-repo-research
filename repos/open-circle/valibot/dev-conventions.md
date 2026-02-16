# dev-conventions

> リポジトリ: open-circle/valibot
> 分析日: 2026-02-16

## 概要

valibot は ESLint 9 flat config、Prettier、JSDoc、TypeScript strict mode を組み合わせた多層的なコーディング規約統制システムを持つ。特筆すべきは、正規表現の安全性検証（ReDoS 防止）を ESLint レベルで強制している点、`interface` over `type` を TypeScript パフォーマンスの観点から ESLint ルールで強制している点、そしてツリーシェイキングのために `// @__NO_SIDE_EFFECTS__` アノテーションを全ファクトリ関数に付与している点である。モノレポ内でパッケージごとに ESLint 設定の厳しさを変えている戦略も、規約統制の設計として参考になる。

## 背景にある原則

- **段階的厳格化**: コアライブラリ（`library/`）では regexp/security/redos-detector プラグインを含む最も厳格な ESLint 設定を適用し、サブパッケージ（`packages/to-json-schema/`）ではセキュリティプラグインのみ、ウェブサイト（`website/`）では最低限のルールに留めている。リスクの高いコードほど厳しい規約を課すべき、なぜなら品質要求はコードの用途に比例するからである。（`library/eslint.config.js` vs `website/eslint.config.js` の比較から）

- **ツール強制による一貫性**: コーディング規約を「ドキュメントに書いて守ってもらう」のではなく「ツールで強制する」方針を徹底している。`interface` over `type` は `@typescript-eslint/consistent-type-definitions: 'error'` で自動検出し、import の `.ts` 拡張子は `import/extensions: ['error', 'always']` で強制する。人間の注意力に依存しない仕組みを作るべき、なぜなら規約違反の大半は意図的ではなく無意識に発生するからである。

- **バンドルサイズの防衛的設計**: `package.json` の `"sideEffects": false` 宣言に加え、全ファクトリ関数に `// @__NO_SIDE_EFFECTS__` コメントを付与している。これはバンドラが副作用の有無を正確に判定できない場合の保険であり、ライブラリ作者がツリーシェイキングの責任を能動的に引き受けるべき、なぜなら「バンドラ任せ」ではユーザーのバンドルサイズが予測不能になるからである。（`library/src/schemas/string/string.ts:69`、`library/package.json:37`）

- **セキュリティの左シフト**: 正規表現の安全性検証を CI ではなくエディタ上のリアルタイムフィードバック（ESLint）で行う。`eslint-plugin-regexp`、`eslint-plugin-redos-detector`、`eslint-plugin-security` を三重に導入し、`regexp/require-unicode-regexp` で `/u` フラグを強制する（パフォーマンスと strict mode の両立）。脆弱性はコードを書いている瞬間に検出すべき、なぜなら後工程での修正コストは指数関数的に増大するからである。（`library/eslint.config.js:86-98`）

## 実例と分析

### ESLint 9 flat config によるモノレポ規約の段階的適用

valibot のモノレポは 3 つの独立した ESLint 設定ファイルを持ち、パッケージごとに規約の厳しさを変えている。

| パッケージ                 | プラグイン構成                                                                                | 特記事項                                           |
| -------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `library/`                 | eslint, typescript-eslint (strict+stylistic), jsdoc, security, regexp, import, redos-detector | 全7プラグイン、最も厳格                            |
| `packages/to-json-schema/` | eslint, typescript-eslint (strict+stylistic), jsdoc, security, import                         | regexp/redos-detector なし                         |
| `website/`                 | eslint, typescript-eslint (recommended), qwik                                                 | jsdoc/security/import なし、`no-explicit-any: off` |

コアライブラリはユーザーの本番環境で動くため最も厳格であり、ウェブサイトは開発チーム内のみで消費されるため緩い。この段階的適用は、共有 ESLint 設定を作って `extends` するのではなく、各パッケージが独立した設定ファイルを持つことで実現している。

### JSDoc の戦略的な強制ルール

JSDoc の `require-jsdoc` ルールは、高度な AST セレクタを使ってオーバーロード関数の「最初の宣言のみ」に JSDoc を要求する。

```ts
// library/eslint.config.js:66-77
'jsdoc/require-jsdoc': [
  'error',
  {
    contexts: [
      'ExportNamedDeclaration[declaration.type="TSDeclareFunction"]:not(ExportNamedDeclaration[declaration.type="TSDeclareFunction"] + ExportNamedDeclaration[declaration.type="TSDeclareFunction"])',
      'ExportNamedDeclaration[declaration.type="FunctionDeclaration"]:not(ExportNamedDeclaration[declaration.type="TSDeclareFunction"] + ExportNamedDeclaration[declaration.type="FunctionDeclaration"])',
    ],
    require: {
      FunctionDeclaration: false,
    },
  },
],
```

このセレクタは「連続する `TSDeclareFunction` の2番目以降」と「`TSDeclareFunction` 直後の `FunctionDeclaration`（実装本体）」を除外する。実際のコードでは以下のように適用される。

```ts
// library/src/schemas/string/string.ts:52-70
/**                          ← JSDoc はここだけ（最初のオーバーロード）
 * Creates a string schema.
 *
 * @returns A string schema.
 */
export function string(): StringSchema<undefined>;

/**                          ← 2番目のオーバーロードにも JSDoc がある（任意）
 * Creates a string schema.
 *
 * @param message The error message.
 *
 * @returns A string schema.
 */
export function string<
  const TMessage extends ErrorMessage<StringIssue> | undefined,
>(message: TMessage): StringSchema<TMessage>;

// @__NO_SIDE_EFFECTS__      ← 実装本体には JSDoc なし
export function string(
```

JSDoc タグの並び順も強制されている: `@deprecated` -> `@param` -> `@returns` の順で、タグ間に1行の空行を入れる（`jsdoc/sort-tags`, `jsdoc/tag-lines`）。カスタムタグとして `@alpha`, `@beta`, `@__NO_SIDE_EFFECTS__` が定義されている。

### `@__NO_SIDE_EFFECTS__` による能動的ツリーシェイキング支援

コードベース全体で、エクスポートされるファクトリ関数すべてに `// @__NO_SIDE_EFFECTS__` アノテーションが付与されている。このコメントは Rollup/esbuild 等のバンドラに「この関数呼び出しは副作用がない」と明示するもので、`package.json` の `"sideEffects": false` と二重の防御層を形成する。

```ts
// library/src/utils/isOfKind/isOfKind.ts:9-15
// @__NO_SIDE_EFFECTS__
export function isOfKind<
  const TKind extends TObject["kind"],
  const TObject extends { kind: string; },
>(kind: TKind, object: TObject): object is Extract<TObject, { kind: TKind; }> {
  return object.kind === kind;
}
```

JSDoc の `check-tag-names` で `@__NO_SIDE_EFFECTS__` をカスタムタグとして登録しているため、このアノテーションに対して「不明なタグ」警告が出ない（`library/eslint.config.js:81`）。

### `interface` over `type` の徹底と例外

ESLint ルール `@typescript-eslint/consistent-type-definitions: 'error'` によって、オブジェクト型の定義には `interface` を強制している。コメントに「for better TS performance」と明記されており、TypeScript コンパイラが `interface` をより効率的に処理するという根拠に基づく。

```ts
// library/src/types/schema.ts:9-69 — interface を使用
export interface BaseSchema<TInput, TOutput, TIssue extends BaseIssue<unknown>> {
  readonly kind: "schema";
  readonly type: string;
  // ...
}

// library/src/types/other.ts:11-13 — ユニオン型は type を使用（interface では表現不可）
export type ErrorMessage<TIssue extends BaseIssue<unknown>> =
  | ((issue: TIssue) => string)
  | string;
```

テストファイル内ではこのルールを `eslint-disable` で例外的に無効化する場面もある（`library/src/actions/findItem/findItem.test-d.ts:1`）。型テストでは `type` が自然な場合があるためだが、プロダクションコードでは厳格に守られている。

### 正規表現の三重防御

正規表現に関して、3つの ESLint プラグインを組み合わせた多層防御を行っている。

1. **eslint-plugin-regexp**: パターンの最適化・正規化（`sort-alternatives`, `prefer-quantifier`, `hexadecimal-escape` 等）と `/u` フラグの強制（`require-unicode-regexp`）
2. **eslint-plugin-redos-detector**: ReDoS 脆弱性の検出（`no-unsafe-regex: error`）
3. **eslint-plugin-security**: 汎用セキュリティ検査（ただし `detect-unsafe-regex` は false positive が多いため `off` にし、redos-detector に委譲）

```ts
// library/eslint.config.js:119-120
'security/detect-unsafe-regex': 'off',
// Too many false positives, see https://github.com/eslint-community/eslint-plugin-security/issues/28
// - we use the redos-detector plugin instead
```

正規表現が中核ロジックであるバリデーションライブラリならではの防御だが、この「重複するツールの得意分野を使い分ける」戦略は汎用的に適用できる。

### consistent-type-imports による import の分離

`@typescript-eslint/consistent-type-imports: 'warn'` により、型のみの import は `import type` を使うことが推奨されている。これによりバンドル時に型情報が確実に除去される。

```ts
// library/src/schemas/string/string.ts:1-6
import type { BaseIssue, BaseSchema, ErrorMessage, OutputDataset } from "../../types/index.ts";
import { _addIssue, _getStandardProps } from "../../utils/index.ts";
```

`import type` と通常の `import` が明確に分離されており、コードレビューで「この import はランタイムに残るのか」が一目でわかる。

### 内部ヘルパーのアンダースコアプレフィックス規約

公開 API と内部ヘルパーを命名規則で区別している。アンダースコアプレフィックス（`_`）付きの関数・ディレクトリは内部専用であり、`@internal` JSDoc タグと併用される。

```ts
// library/src/utils/_stringify/_stringify.ts:1-11
/**
 * Stringifies an unknown input to a literal or type string.
 *
 * @param input The unknown input.
 *
 * @returns A literal or type string.
 *
 * @internal
 */
// @__NO_SIDE_EFFECTS__
export function _stringify(input: unknown): string {
```

一方、公開 API（`isOfKind`, `getDotPath` 等）にはアンダースコアがなく `@internal` タグもない。`library/src/utils/index.ts` を見ると、内部ヘルパーも `export *` で re-export されているが、命名規則と JSDoc タグで「使わないでください」を表明している。

### CI の並列パイプライン構成

CI ワークフロー（`.github/workflows/ci.yml`）では、パッケージごとに Prettier / ESLint / Vitest を独立した job として並列実行している。全8 job（library: 3、to-json-schema: 3、website: 2）が `install` job への依存のみで並列化される。lint コマンド自体も `eslint && tsc --noEmit && deno check` と3つのチェッカーを直列に実行しており、Deno 互換性まで検証している。

### テストヘルパーによる assertion の標準化

`library/src/vitest/` にテスト専用ヘルパー（`expectSchemaIssue`, `expectNoSchemaIssue` 等）を用意し、スキーマの成功・失敗テストのパターンを統一している。

```ts
// library/src/vitest/expectNoSchemaIssue.ts:10-19
export function expectNoSchemaIssue<
  TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>,
>(schema: TSchema, values: InferInput<TSchema>[]): void {
  for (const value of values) {
    expect(schema["~run"]({ value }, {})).toStrictEqual({
      typed: true,
      value,
    });
  }
}
```

各テストファイルではこのヘルパーを呼ぶだけで済み、assertion の粒度やフォーマットが自動的に統一される。

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: スキーマごとに異なるバリデーションロジックを統一的なインターフェースで扱う
  - 適用条件: `BaseSchema` インターフェースの `'~run'` メソッドで、各スキーマが独自のバリデーション戦略を実装
  - コード例: `library/src/types/schema.ts:53-56` (インターフェース定義)、`library/src/schemas/string/string.ts:83-92` (具体戦略)
  - 注意点: GoF の典型的な Strategy と異なり、クラスではなくプレーンオブジェクトのメソッドとして実装されている

## Good Patterns

- **JSDoc オーバーロード選択的要求**: オーバーロード関数の最初の宣言のみ JSDoc を要求する ESLint AST セレクタ。冗長なドキュメントを避けつつ、公開 API のドキュメント漏れを防止する。JSDoc 要求のルールが「ただオンにする」のではなく「どこに書くべきか」まで制御している点が優れている。

```ts
// library/eslint.config.js:66-67 の AST セレクタ
// 最初の TSDeclareFunction のみ要求（連続する2番目以降は除外）
'ExportNamedDeclaration[declaration.type="TSDeclareFunction"]:not(...)';
```

- **テストヘルパーによる assertion 標準化**: テスト対象ドメインに特化した assertion ヘルパーを `vitest/` ディレクトリに集約し、テストの記述を宣言的にしている。全てのスキーマテストが `expectSchemaIssue` / `expectNoSchemaIssue` を使用することで、テストの追加時に assertion の書き方を迷う余地がない。

```ts
// library/src/schemas/string/string.test.ts:49-51
test("for empty strings", () => {
  expectNoSchemaIssue(schema, ["", " ", "\n"]);
});
```

- **パフォーマンスヒントコメント**: spread operator を意図的に避けている箇所に `// Hint: ... deliberately not constructed with the spread operator for performance reasons` というコメントを付与。設計判断の根拠をコード内に残す良い慣行。

```ts
// library/src/utils/_addIssue/_addIssue.ts:83-84
// Hint: The issue is deliberately not constructed with the spread operator
// for performance reasons
const issue: BaseIssue<unknown> = {
  kind: context.kind,
  // ... 個別にプロパティを設定
```

## Anti-Patterns / 注意点

- **`eslint-disable` の濫用リスク**: テストファイルで `@typescript-eslint/no-explicit-any` や `@typescript-eslint/consistent-type-definitions` を `eslint-disable` で無効化している箇所がある。テスト特有の事情（型テストで `type` が自然な場合等）ではあるが、disable コメントが増えすぎると規約の信頼性が低下する。

```ts
// Bad: テストファイルでファイル全体の規約を無効化
/* eslint-disable @typescript-eslint/consistent-type-definitions */

// Better: テスト用の ESLint override を設定ファイルレベルで定義
// eslint.config.js
{
  files: ['**/*.test-d.ts'],
  rules: {
    '@typescript-eslint/consistent-type-definitions': 'off',
  },
}
```

- **security プラグインの形骸化**: `eslint-plugin-security` を導入しているが、`detect-object-injection` と `detect-unsafe-regex` の2つの主要ルールを `off` にしている。false positive が多いという理由は正当だが、プラグインの有効ルールがほぼ残っていない状態では、依存追加のコストに見合わない可能性がある。代替ツール（redos-detector）に明確に委譲するのであれば、その判断をコメントに残すことが重要であり、valibot はこれを実践している（`eslint.config.js:120`）。

## 導出ルール

- `[MUST]` ライブラリとして公開するコードでは、`"sideEffects": false` を `package.json` に設定し、さらに全ファクトリ関数に `// @__NO_SIDE_EFFECTS__` アノテーションを付与する
  - 根拠: valibot は両方を併用することで、バンドラがツリーシェイキングを確実に行えるようにしている（`library/package.json:37`、全スキーマ/アクション/ユーティリティ関数に付与）

- `[MUST]` エクスポートされる関数には JSDoc を要求する ESLint ルールを設定し、オーバーロード関数では最初の宣言のみに要求する
  - 根拠: valibot は AST セレクタで「最初のオーバーロードのみ」に限定し、冗長な JSDoc を防止しつつドキュメント漏れを防いでいる（`library/eslint.config.js:66-77`）

- `[SHOULD]` ESLint の厳格さをパッケージのリスクレベルに応じて段階的に変える（ライブラリコア > サブパッケージ > 内部ツール/ウェブサイト）
  - 根拠: valibot はコアライブラリに7プラグイン、ウェブサイトに2プラグインという段階的構成で、開発速度と品質保証のバランスを取っている

- `[SHOULD]` 正規表現を多用するコードベースでは、ReDoS 検出専用の ESLint プラグイン（redos-detector 等）を導入し、汎用セキュリティプラグインの regex ルールは無効化して責務を委譲する
  - 根拠: valibot は `eslint-plugin-security` の `detect-unsafe-regex` を off にし、false positive の少ない `redos-detector` に一本化している（`library/eslint.config.js:98,120`）

- `[SHOULD]` テスト対象ドメインに特化した assertion ヘルパーを作成し、テスト全体で assertion パターンを標準化する
  - 根拠: valibot は `expectSchemaIssue` / `expectNoSchemaIssue` 等のヘルパーにより、全スキーマテストの assertion フォーマットを統一している（`library/src/vitest/`）

- `[SHOULD]` `interface` と `type` の使い分けを ESLint ルール `consistent-type-definitions` で強制し、オブジェクト型の定義には `interface` を使う
  - 根拠: TypeScript コンパイラが `interface` をより効率的に処理するため。valibot では ESLint error レベルで強制している（`library/eslint.config.js:45`）

- `[SHOULD]` パフォーマンス上の理由で一般的な書き方を避けた箇所には、その理由を `// Hint:` コメントで明記する
  - 根拠: valibot は spread operator 回避箇所に `deliberately not constructed with the spread operator for performance reasons` と記述し、将来の開発者が「なぜ spread を使わないのか」を即座に理解できるようにしている（`library/src/utils/_addIssue/_addIssue.ts:83`）

- `[AVOID]` ESLint `eslint-disable` コメントをテストファイル内で多用すること。テスト固有の緩和は ESLint 設定ファイルの `files` オーバーライドで対応する
  - 根拠: valibot のテストファイルに `eslint-disable` が散在しており、設定ファイルレベルで `*.test-d.ts` 用のオーバーライドを定義する方がメンテナンス性が高い

## 適用チェックリスト

- [ ] `package.json` に `"sideEffects": false` が設定されているか確認する
- [ ] エクスポートされるファクトリ関数に `// @__NO_SIDE_EFFECTS__` アノテーションが付与されているか確認する
- [ ] ESLint 設定で `@typescript-eslint/consistent-type-definitions: 'error'` が有効になっているか確認する
- [ ] ESLint 設定で `@typescript-eslint/consistent-type-imports: 'warn'` が有効になっているか確認する
- [ ] ESLint の `import/extensions` ルールでファイル拡張子の強制が設定されているか確認する
- [ ] 正規表現を使用するコードに ReDoS 検出プラグインが導入されているか確認する
- [ ] JSDoc の `require-jsdoc` ルールが適切な AST セレクタで設定されているか（オーバーロード対応）確認する
- [ ] テスト用の assertion ヘルパーが作成・共有されているか確認する
- [ ] モノレポの場合、パッケージごとに ESLint 設定の厳しさが適切に段階化されているか確認する
- [ ] パフォーマンス上の意図的な設計判断にコメント（`Hint:` 等）が付与されているか確認する
- [ ] CI で Prettier / ESLint / テストが並列 job として実行されているか確認する
