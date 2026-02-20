# dev-conventions

> リポジトリ: colinhacks/zod
> 分析日: 2026-02-19

## 概要

Zod のコーディング規約・リンター設定・Git フック戦略を分析する。Zod は「パフォーマンスのために意図的にルールを緩める」と「品質ゲートとして厳格に締める」を明確に切り分けている点で注目に値する。Biome の recommended ルールセットを採用しつつ 10 以上のルールを意図的に off にし、各 off にコメントで根拠を残す運用は、リンター設定をドキュメントとして機能させる好例である。pre-commit で未追跡ファイル検出 + セマンティックバージョニング整合性チェック + lint-staged を、pre-push でテスト全実行を行う2段構えのフックは、開発速度と品質保証を両立させる実践的な設計になっている。

## 背景にある原則

- **パフォーマンスが型安全性に優先する局面を認める**: `noExplicitAny: off`（コメント: `any is amazing`）、`noParameterAssign: off`（コメント: `required for performant coercion in _parse`）のように、ホットパスでは型安全性よりもランタイム性能を意図的に優先する。バリデーションライブラリとして毎回のパース呼び出しがボトルネックになりうるため、`payload.value = String(payload.value)` のようなパラメータ直接書き換えによる GC 負荷削減を選択している。
- **リンター設定自体をアーキテクチャ判断のドキュメントとする**: `biome.jsonc` の各 off ルールにインラインコメントで理由を付与する（`// required for performant coercion in _parse`, `// why is this even a best practice?`）。設定ファイルは単なる設定ではなく、チームの設計判断を記録する媒体として機能する。
- **コミット品質ゲートを段階的に強化する**: pre-commit は「高速に検知できるもの」（未追跡ファイル、バージョン不整合、フォーマット/リント）に絞り、pre-push で「時間がかかるもの」（テスト全実行）を実行する。開発者のコミット頻度を阻害しない設計。
- **console 出力をテスト品質のカナリアとする**: `fail-on-console.ts` で `console.log`/`warn`/`error`/`info`/`debug` すべてを例外送出に置き換える。console 出力はデバッグの残骸であり、プロダクションコードにもテストにも存在すべきでないという思想を vitest のセットアップファイルで機械的に強制する。

## 実例と分析

### Biome 設定の意図的 off 戦略

`biome.jsonc` は recommended をベースに、パフォーマンス・設計上の理由から特定ルールを off にしている。特筆すべきはルート `biome.jsonc` と `packages/docs/biome.jsonc` で同一設定を複製していること。モノレポ内でパッケージごとに設定を分離できる構造を取りつつ、実態は統一されている。

```jsonc
// biome.jsonc:23-29 — suspicious カテゴリの off 設定
"suspicious": {
  "noExplicitAny": "off", // `any` is amazing
  "noUnsafeDeclarationMerging": "off",
  "noMisleadingInstantiator": "off",
  "noEmptyInterface": "off",
  "noConfusingVoidType": "off",
  "noThenProperty": "off"
}
```

`noExplicitAny: off` の理由は、Zod が型推論の限界で `any` を戦略的に使うため。プロダクションコード中の `payload.value` の型は `unknown` から始まるが、パース後の内部処理では `any` が不可避になる場面がある。

```jsonc
// biome.jsonc:39-46 — 未使用検出は error/warn だが自動修正は無効
"correctness": {
  "noUnusedImports": {
    "level": "error",
    "fix": "none"
  },
  "noUnusedVariables": {
    "level": "warn",
    "fix": "none"
  }
}
```

`"fix": "none"` が重要。未使用 import/変数の自動削除を許すと、lint-staged 経由のコミット時に意図しないコード変更が発生するリスクがある。検出はするが修正は手動 -- これにより開発者が意図を確認する余地を残す。

### Git フック 2段構え

```bash
# .husky/pre-commit:1-7
if [ -n "$(git ls-files --others --exclude-standard)" ]; then
  echo "ERROR: untracked files present";
  git status;
  exit 1
fi
pnpm check:semver
lint-staged --verbose
```

pre-commit の最初のチェックは未追跡ファイルの検出。これはコミット忘れ防止ではなく、「ビルド成果物やスクラッチファイルがリポジトリに残っていないこと」を保証する。`play.ts` は tracked だが `playground.ts` と `scratch/` は `.gitignore` されており、実験コードがコミットに混入することを防ぐ。

`pnpm check:semver` は `scripts/check-versions.ts` を実行し、3 箇所のバージョン（`package.json`, `jsr.json`, `versions.ts`）が一致することを検証する。

```typescript
// scripts/check-versions.ts:44-47
const isPackageJsonValid = tag === "latest"
  ? packageJsonVersion === versionsVersion
  : packageJsonVersion.startsWith(versionsVersion);
const isJsrJsonValid = tag === "latest"
  ? jsrJsonVersion === versionsVersion
  : jsrJsonVersion.startsWith(versionsVersion);
```

これは「バージョンの情報源が複数ある場合に整合性を自動検証すべき」という原則の具現化。`versions.ts` にソースコード内バージョンを持つのは、ランタイムでバージョン情報を参照するため。

```bash
# .husky/pre-push:1-7
if [ -n "$(git ls-files --others --exclude-standard)" ]; then
  echo "ERROR: untracked files present";
  git status;
  exit 1
fi
pnpm check:semver
pnpm test
```

pre-push ではテスト全実行。コミットごとのテスト実行は開発速度を大幅に下げるが、push 前のテスト実行は CI の失敗をローカルで先に検知できるため費用対効果が高い。

### console 出力の機械的禁止

```typescript
// scripts/fail-on-console.ts:1-20
import { afterAll, beforeAll } from "vitest";

const original = { ...console } as Record<string, any>;

function thrower(method: string) {
  return (...args: any[]) => {
    throw new Error(`Unexpected console.${method} call: ${args.join(" ")}`);
  };
}

beforeAll(() => {
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    // @ts-ignore
    console[method] = thrower(method);
  }
});
```

vitest の `setupFiles` で全テストに適用される。テスト内で `console.error` を使っている箇所（`to-json-schema.test.ts:23`）は、意図的に fail-on-console を発火させて OpenAPI スキーマのバリデーション失敗を検知する仕組み。コメントにも `console.error should make vitest throw an unhandled error` と明記されている。

### Tree-shaking アノテーションの徹底

コードベース全体で `/*@__PURE__*/` と `// @__NO_SIDE_EFFECTS__` が計 511 箇所（`@__PURE__` 284 件 + `@__NO_SIDE_EFFECTS__` 227 件）使用されている。

```typescript
// packages/zod/src/v4/core/schemas.ts:352
export const $ZodString: core.$constructor<$ZodString> = /*@__PURE__*/ core.$constructor("$ZodString", (inst, def) => {
```

```typescript
// packages/zod/src/v4/core/api.ts:62-63
// @__NO_SIDE_EFFECTS__
export function _string<T extends schemas.$ZodString>(
```

`@__PURE__` は式レベル、`@__NO_SIDE_EFFECTS__` は関数宣言レベルで bundler にヒントを与える。`postbuild` スクリプト（`"postbuild": "biome format --write ."`）でビルド後にフォーマットを再実行するのは、これらのアノテーションがビルドツールの出力フォーマットを崩す可能性への対策。

### 循環依存の CI 検出

```json
// package.json:88
"check:circular": "madge --circular --extensions ts --exclude '(v4/core|v3|iso\\.ts)' packages/zod/src"
```

`madge` で循環依存を CI ジョブとして検出。`v4/core` を除外しているのは、core モジュール内の相互参照は設計上許容されているため。`util.defineLazy()` を使った遅延初期化で循環参照時のデッドロックを回避する仕組みが組み込まれている。

```typescript
// packages/zod/src/v4/core/util.ts:266-289
export function defineLazy<T, K extends keyof T>(object: T, key: K, getter: () => T[K]): void {
  let value: T[K] | typeof EVALUATING | undefined = undefined;
  Object.defineProperty(object, key, {
    get() {
      if (value === EVALUATING) {
        // Circular reference detected, return undefined to break the cycle
        return undefined as T[K];
      }
      // ...
```

`EVALUATING` シンボルによる循環参照検出は、遅延プロパティの再帰呼び出しを安全にフォールバックさせる。

## パターンカタログ

- **Lazy Initialization** (分類: 生成)
  - 解決する問題: 循環依存のある巨大モジュール群でモジュール初期化時のデッドロックを回避する
  - 適用条件: モジュール間の相互参照が不可避で、プロパティアクセス時に初期化を遅延できる場合
  - コード例: `packages/zod/src/v4/core/util.ts:266` の `defineLazy`、`packages/zod/src/v4/core/util.ts:223` の `cached`
  - 注意点: `EVALUATING` シンボルによる再帰検出で `undefined` を返すため、呼び出し側が `undefined` を許容できる設計が前提

## Good Patterns

- **リンター off にインライン理由コメントを義務化**: `biome.jsonc` の各 off 設定にコメントで理由を付与。将来のメンテナが「なぜ off なのか」を即座に理解でき、不用意な re-enable を防ぐ。
  ```jsonc
  // biome.jsonc:33
  "noParameterAssign": "off", // required for performant coercion in _parse
  ```

- **未使用コードの検出と自動修正を分離**: `noUnusedImports` を error にしつつ `"fix": "none"` で自動削除を防ぐ。lint-staged でのコミット時に意図しないコード削除が起きない。
  ```jsonc
  // biome.jsonc:39-42
  "noUnusedImports": {
    "level": "error",
    "fix": "none"
  }
  ```

- **セマンティックバージョン整合性の自動検証**: `package.json`、`jsr.json`、ソースコード内 `versions.ts` の3箇所が常に一致することを pre-commit フックで自動検証。マルチレジストリ配信時のバージョンずれを防止。
  ```typescript
  // scripts/check-versions.ts:40-41
  const versionsVersion = `${version.major}.${version.minor}.${version.patch}`;
  ```

- **テストでの console 出力を例外として活用**: `fail-on-console.ts` が全 console メソッドを例外送出に書き換えるため、テスト内の意図的な `console.error` 呼び出しがテスト失敗のトリガーとして機能する。
  ```typescript
  // packages/zod/src/v4/classic/tests/to-json-schema.test.ts:21-23
  // `console.error` should make `vitest` trow an unhandled error
  console.error(
    `OpenAPI schema is not valid against ${openAPI30Validator.version}`,
  ```

## Anti-Patterns / 注意点

- **biome-ignore の理由空欄**: コードベース中に `// biome-ignore lint:` と理由が空の抑制コメントが散見される（`v3/helpers/errorUtil.ts:5`, `v4/core/errors.ts:211`）。一部は `// biome-ignore lint: sadf` のようなダミーテキスト。リンター抑制には常に具体的な理由が必要。
  ```typescript
  // Bad: packages/zod/src/v4/classic/tests/recursive-types.test.ts:511
  // biome-ignore lint: sadf

  // Better:
  // biome-ignore lint/complexity/noUselessEmptyExport: needed for granular visibility control of TS namespace
  ```

- **v3 ベンチマークに残存する console.log**: `packages/zod/src/v4/core` 以降のプロダクションコードでは console が排除されているが、`v3/benchmarks/` 配下には `console.log` が 17 箇所残存している。ベンチマークはテストスイートの対象外のため fail-on-console の網にかからない。レガシーコードのメンテナンスポリシーが曖昧になるリスクがある。

## 導出ルール

- `[MUST]` リンターの recommended ルールを off にする場合、設定ファイルにインラインコメントで理由を付与する
  - 根拠: Zod の `biome.jsonc` では各 off ルールにコメントで根拠を明記し、設定ファイルがアーキテクチャ判断のドキュメントとして機能している
- `[MUST]` テストセットアップで console メソッド（log/warn/error/info/debug）を例外送出に置き換え、デバッグ出力の残存を機械的に検出する
  - 根拠: `fail-on-console.ts` で全テストに適用し、AGENTS.md でも「No log statements in tests or production code」と明文化している
- `[SHOULD]` 未使用コードの lint 検出と自動修正を分離する（検出は error、自動修正は none）
  - 根拠: Zod は `noUnusedImports` を error にしつつ `"fix": "none"` とし、lint-staged でのコミット時に意図しないコード削除が起きない設計にしている
- `[SHOULD]` pre-commit は高速チェック（フォーマット、リント、バージョン整合性）に絞り、テスト実行は pre-push に分離する
  - 根拠: Zod の pre-commit は未追跡ファイル検出 + semver チェック + lint-staged の3段階、pre-push でテスト全実行という分離により開発速度と品質を両立している
- `[SHOULD]` バージョン情報の情報源が複数ある場合（package.json、ソースコード、レジストリ設定等）、Git フックで整合性を自動検証する
  - 根拠: `check-versions.ts` が `package.json`/`jsr.json`/`versions.ts` の3箇所を比較し、pre-commit/pre-push 両方で実行されている
- `[SHOULD]` tree-shaking 対象のライブラリでは、ファクトリ関数やモジュールレベル式に `/*@__PURE__*/` / `// @__NO_SIDE_EFFECTS__` アノテーションを付与する
  - 根拠: Zod は v4 コードベース全体で 511 箇所にこれらのアノテーションを付与し、バンドルサイズの最適化を bundler 任せにしていない
- `[AVOID]` リンター抑制コメント（`biome-ignore`, `eslint-disable` 等）を理由なし、またはダミーテキストで記述する
  - 根拠: Zod のコードベース中に `// biome-ignore lint: sadf` のような意味のない理由が残存しており、将来のメンテナビリティを損なう

## 適用チェックリスト

- [ ] リンター設定ファイルの各 off ルールにインラインコメントで理由が付与されているか
- [ ] テストセットアップで console メソッドを例外送出に置き換える仕組みが導入されているか
- [ ] 未使用コードの lint ルールで自動修正が無効化されているか（`"fix": "none"` 相当）
- [ ] pre-commit フックがフォーマット・リントに絞られ、テスト実行は pre-push に分離されているか
- [ ] バージョン情報が複数箇所に存在する場合、整合性を自動検証するスクリプトがあるか
- [ ] tree-shaking 対象のエクスポートに `@__PURE__` / `@__NO_SIDE_EFFECTS__` アノテーションが付与されているか
- [ ] リンター抑制コメントに具体的な理由が記載されているか（grep で `biome-ignore|eslint-disable` を検索して確認）
